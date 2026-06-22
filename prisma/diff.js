const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

const SCHEMA_FILE = path.join(__dirname, 'schema.js');
const DB_NAME = process.env.DB_NAME;
const connConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: DB_NAME
};

function loadSchema() {
  if (!fs.existsSync(SCHEMA_FILE)) return null;
  delete require.cache[require.resolve(SCHEMA_FILE)];
  return require(SCHEMA_FILE);
}

function fmtDefault(v) {
  if (v === null || v === undefined) return null;
  if (v === 'CURRENT_TIMESTAMP') return 'CURRENT_TIMESTAMP';
  if (/^-?\d+(\.\d+)?$/.test(String(v))) return v;
  return `'${String(v).replace(/'/g, "\\'")}'`;
}

async function introspectMySQL(conn) {
  const [tables] = await conn.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    [DB_NAME]
  );
  const schema = {};
  for (const { TABLE_NAME: t } of tables) {
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [DB_NAME, t]
    );
    schema[t] = {};
    for (const c of cols) {
      let ddl = c.COLUMN_TYPE;
      if (c.IS_NULLABLE === 'NO') ddl += ' NOT NULL';
      const def = fmtDefault(c.COLUMN_DEFAULT);
      if (def !== null) ddl += ` DEFAULT ${def}`;
      if (String(c.EXTRA).toLowerCase().includes('auto_increment')) ddl += ' AUTO_INCREMENT';
      if (c.COLUMN_KEY === 'PRI') ddl += ' PRIMARY KEY';
      if (c.COLUMN_KEY === 'UNI') ddl += ' UNIQUE';
      schema[t][c.COLUMN_NAME] = ddl;
    }
  }
  return schema;
}

async function getMySQLTables(conn) {
  const [tables] = await conn.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    [DB_NAME]
  );
  return tables.map(t => t.TABLE_NAME);
}

async function getMySQLColumnNames(conn, tableName) {
  const [cols] = await conn.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    [DB_NAME, tableName]
  );
  return cols.map(c => c.COLUMN_NAME);
}

function buildCreateTableSQL(tableName, columns) {
  const colDefs = Object.entries(columns)
    .map(([name, ddl]) => `  \`${name}\` ${ddl}`)
    .join(',\n');
  return `CREATE TABLE \`${tableName}\` (\n${colDefs}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}

function buildAddColumnSQL(tableName, columnName, ddl) {
  return `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${ddl}`;
}

function compare(schema, mysqlTables, mysqlColumnsByTable) {
  const createTable = [];
  const addColumn = [];
  const outOfScope = mysqlTables.filter(t => !Object.keys(schema).includes(t));
  for (const [tableName, columns] of Object.entries(schema)) {
    if (!mysqlTables.includes(tableName)) {
      createTable.push({ tableName, columns });
      continue;
    }
    const existing = mysqlColumnsByTable[tableName] || [];
    for (const [colName, ddl] of Object.entries(columns)) {
      if (!existing.includes(colName)) {
        addColumn.push({ tableName, columnName: colName, ddl });
      }
    }
  }
  return { createTable, addColumn, outOfScope };
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, ans => { rl.close(); resolve(ans.toLowerCase().trim()); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--bootstrap') ? 'bootstrap'
             : args.includes('--apply')    ? 'apply'
             : 'diff';
  const skipConfirm = args.includes('--yes');

  const conn = await mysql.createConnection(connConfig);
  try {
    if (mode === 'bootstrap') {
      const schema = await introspectMySQL(conn);
      const content = `// Auto-generated from MySQL "${DB_NAME}" on ${new Date().toISOString()}\n` +
        `// 删除/编辑本文件中不需要管理的表（如 sessions 由 express-mysql-session 自动管）。\n` +
        `// 添加新表/列后运行 node prisma/diff.js --apply 同步到 MySQL。\n\n` +
        `module.exports = ${JSON.stringify(schema, null, 2)};\n`;
      fs.writeFileSync(SCHEMA_FILE, content);
      const total = Object.values(schema).reduce((s, t) => s + Object.keys(t).length, 0);
      console.log(`✓ Bootstrapped: ${Object.keys(schema).length} tables, ${total} columns → ${SCHEMA_FILE}`);
      console.log('  Next: edit schema.js to remove tables you don\'t manage, then run `node prisma/diff.js` to verify.');
      return;
    }

    const schema = loadSchema();
    if (!schema) {
      console.error(`✗ Schema file not found: ${SCHEMA_FILE}`);
      console.error('  Run: node prisma/diff.js --bootstrap');
      process.exit(1);
    }

    const mysqlTables = await getMySQLTables(conn);
    const mysqlColumnsByTable = {};
    for (const t of mysqlTables) {
      mysqlColumnsByTable[t] = await getMySQLColumnNames(conn, t);
    }

    const { createTable, addColumn, outOfScope } = compare(schema, mysqlTables, mysqlColumnsByTable);

    console.log(`\n=== Schema Diff ===`);
    console.log(`MySQL:  ${mysqlTables.length} tables`);
    console.log(`Schema: ${Object.keys(schema).length} tables`);

    if (outOfScope.length) {
      console.log(`\nOut of scope (in MySQL, not in schema — ignored):`);
      for (const t of outOfScope) console.log(`  - ${t}`);
    }

    if (createTable.length === 0 && addColumn.length === 0) {
      console.log(`\n✓ In sync. No differences.`);
      return;
    }

    if (createTable.length) {
      console.log(`\n[CREATE TABLE — ${createTable.length}]`);
      for (const { tableName, columns } of createTable) {
        console.log(`  + ${tableName}  (${Object.keys(columns).length} columns)`);
      }
    }
    if (addColumn.length) {
      console.log(`\n[ADD COLUMN — ${addColumn.length}]`);
      for (const { tableName, columnName, ddl } of addColumn) {
        console.log(`  + ${tableName}.${columnName}  ${ddl}`);
      }
    }

    if (mode !== 'apply') {
      console.log(`\nDry-run. Use --apply to execute.`);
      return;
    }

    if (!skipConfirm) {
      const ans = await prompt(`\nApply ${createTable.length + addColumn.length} changes? [y/N] `);
      if (ans !== 'y' && ans !== 'yes') { console.log('Aborted.'); return; }
    }

    for (const { tableName, columns } of createTable) {
      console.log(`\n→ CREATE TABLE ${tableName}`);
      await conn.query(buildCreateTableSQL(tableName, columns));
      console.log(`  ✓ created`);
    }
    for (const { tableName, columnName, ddl } of addColumn) {
      console.log(`→ ALTER TABLE ${tableName} ADD COLUMN ${columnName}`);
      await conn.query(buildAddColumnSQL(tableName, columnName, ddl));
      console.log(`  ✓ added`);
    }
    console.log(`\n✓ Applied ${createTable.length + addColumn.length} changes.`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

main();
