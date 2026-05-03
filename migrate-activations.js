/**
 * 数据库迁移脚本 - activations 表结构更新
 * 新增字段: mac_address, expire_date
 *
 * 使用方法: node migrate-activations.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.sqlite');

async function migrate() {
  console.log('=== activations 表结构迁移 ===\n');

  // 读取数据库配置
  const configFile = path.join(DATA_DIR, 'db-config.json');
  let dbType = 'sqlite';
  let mysqlConfig = null;

  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      dbType = config.type || 'sqlite';
      mysqlConfig = config.mysql;
    } catch (e) {
      console.log('读取配置文件失败，使用 SQLite');
    }
  }

  console.log(`当前数据库类型: ${dbType.toUpperCase()}\n`);

  if (dbType === 'mysql') {
    await migrateMySQL(mysqlConfig);
  } else {
    migrateSQLite();
  }

  console.log('\n=== 迁移完成 ===');
}

async function migrateMySQL(config) {
  if (!config) {
    console.error('MySQL 配置不存在');
    return;
  }

  const mysql = require('mysql2/promise');

  let connection;
  try {
    connection = await mysql.createConnection({
      host: config.host,
      port: config.port || 3306,
      user: config.user,
      password: config.password,
      database: config.database
    });

    console.log('连接到 MySQL 数据库...\n');

    // 检查当前表结构
    const [columns] = await connection.query('SHOW COLUMNS FROM activations');
    const columnNames = columns.map(c => c.Field);

    console.log('当前 activations 表结构:');
    columns.forEach(c => {
      console.log(`  - ${c.Field}: ${c.Type}`);
    });
    console.log();

    // 检查并添加 mac_address 字段
    if (!columnNames.includes('mac_address')) {
      console.log('添加 mac_address 字段...');
      await connection.query(
        'ALTER TABLE activations ADD COLUMN mac_address VARCHAR(100) AFTER software_name'
      );
      console.log('  ✓ mac_address 字段已添加\n');
    } else {
      console.log('  ✓ mac_address 字段已存在\n');
    }

    // 检查并添加 expire_date 字段
    if (!columnNames.includes('expire_date')) {
      console.log('添加 expire_date 字段...');
      await connection.query(
        'ALTER TABLE activations ADD COLUMN expire_date DATETIME AFTER activate_date'
      );
      console.log('  ✓ expire_date 字段已添加\n');
    } else {
      console.log('  ✓ expire_date 字段已存在\n');
    }

    // 更新现有记录的 expire_date（如果为NULL）
    const [nullRecords] = await connection.query(
      'SELECT COUNT(*) as count FROM activations WHERE expire_date IS NULL'
    );

    if (nullRecords[0].count > 0) {
      console.log(`发现 ${nullRecords[0].count} 条记录的 expire_date 为空，正在更新...`);
      // 默认设置为激活日期 + 1年
      await connection.query(`
        UPDATE activations
        SET expire_date = DATE_ADD(activate_date, INTERVAL 1 YEAR)
        WHERE expire_date IS NULL
      `);
      console.log('  ✓ 已将空 expire_date 设置为激活日期 + 1年\n');
    }

    // 显示更新后的表结构
    console.log('更新后的 activations 表结构:');
    const [newColumns] = await connection.query('SHOW COLUMNS FROM activations');
    newColumns.forEach(c => {
      console.log(`  - ${c.Field}: ${c.Type}`);
    });

  } catch (error) {
    console.error('MySQL 迁移失败:', error.message);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

function migrateSQLite() {
  const initSqlJs = require('sql.js');

  let SQL;

  async function run() {
    // 初始化 sql.js
    SQL = await initSqlJs();

    // 读取现有数据库
    let db;
    if (fs.existsSync(DB_FILE)) {
      const fileBuffer = fs.readFileSync(DB_FILE);
      db = new SQL.Database(fileBuffer);
    } else {
      console.error('数据库文件不存在:', DB_FILE);
      return;
    }

    console.log('加载 SQLite 数据库...\n');

    // 检查当前表结构
    const result = db.exec("PRAGMA table_info(activations)");
    const columns = result.length > 0 ? result[0].values.map(v => v[1]) : [];

    console.log('当前 activations 表结构:');
    if (result.length > 0) {
      result[0].values.forEach(row => {
        console.log(`  - ${row[1]}: ${row[2]}`);
      });
    }
    console.log();

    // 检查并添加 mac_address 字段
    if (!columns.includes('mac_address')) {
      console.log('添加 mac_address 字段...');
      db.run('ALTER TABLE activations ADD COLUMN mac_address TEXT');
      console.log('  ✓ mac_address 字段已添加\n');
    } else {
      console.log('  ✓ mac_address 字段已存在\n');
    }

    // 检查并添加 expire_date 字段
    if (!columns.includes('expire_date')) {
      console.log('添加 expire_date 字段...');
      db.run('ALTER TABLE activations ADD COLUMN expire_date TEXT');
      console.log('  ✓ expire_date 字段已添加\n');
    } else {
      console.log('  ✓ expire_date 字段已存在\n');
    }

    // 更新现有记录的 expire_date（如果为NULL或空）
    const nullResult = db.exec("SELECT COUNT(*) FROM activations WHERE expire_date IS NULL OR expire_date = ''");
    const nullCount = nullResult.length > 0 ? nullResult[0].values[0][0] : 0;

    if (nullCount > 0) {
      console.log(`发现 ${nullCount} 条记录的 expire_date 为空，正在更新...`);
      db.run(`
        UPDATE activations
        SET expire_date = datetime(activate_date, '+1 year')
        WHERE expire_date IS NULL OR expire_date = ''
      `);
      console.log('  ✓ 已将空 expire_date 设置为激活日期 + 1年\n');
    }

    // 保存数据库
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
    console.log('数据库已保存\n');

    // 显示更新后的表结构
    console.log('更新后的 activations 表结构:');
    const newResult = db.exec("PRAGMA table_info(activations)");
    if (newResult.length > 0) {
      newResult[0].values.forEach(row => {
        console.log(`  - ${row[1]}: ${row[2]}`);
      });
    }

    db.close();
  }

  run().catch(err => {
    console.error('SQLite 迁移失败:', err.message);
    process.exit(1);
  });
}

// 运行迁移
migrate().catch(err => {
  console.error('迁移失败:', err);
  process.exit(1);
});
