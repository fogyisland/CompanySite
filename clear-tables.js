/**
 * 清空订单表和激活表
 * 使用方法: node clear-tables.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.sqlite');

async function clearTables() {
  console.log('=== 清空订单表和激活表 ===\n');

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

  if (!confirm('确定要清空 orders 和 activations 表吗？此操作不可恢复！')) {
    console.log('已取消');
    return;
  }

  if (dbType === 'mysql') {
    await clearMySQL(mysqlConfig);
  } else {
    await clearSQLite();
  }

  console.log('\n=== 完成 ===');
}

async function clearMySQL(config) {
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

    // 清空 activations 表
    const [actResult] = await connection.query('SELECT COUNT(*) as count FROM activations');
    console.log(`activations 表当前有 ${actResult[0].count} 条记录`);
    await connection.query('DELETE FROM activations');
    console.log('  ✓ activations 表已清空');

    // 清空 orders 表
    const [ordResult] = await connection.query('SELECT COUNT(*) as count FROM orders');
    console.log(`orders 表当前有 ${ordResult[0].count} 条记录`);
    await connection.query('DELETE FROM orders');
    console.log('  ✓ orders 表已清空');

    // 重置自增ID
    await connection.query('ALTER TABLE activations AUTO_INCREMENT = 1');
    await connection.query('ALTER TABLE orders AUTO_INCREMENT = 1');
    console.log('  ✓ 自增ID已重置');

  } catch (error) {
    console.error('MySQL 操作失败:', error.message);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

async function clearSQLite() {
  const initSqlJs = require('sql.js');

  SQL = await initSqlJs();

  let db;
  if (fs.existsSync(DB_FILE)) {
    const fileBuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(fileBuffer);
  } else {
    console.error('数据库文件不存在:', DB_FILE);
    return;
  }

  console.log('加载 SQLite 数据库...\n');

  // 清空 activations 表
  let result = db.exec('SELECT COUNT(*) as count FROM activations');
  const actCount = result.length > 0 ? result[0].values[0][0] : 0;
  console.log(`activations 表当前有 ${actCount} 条记录`);
  db.run('DELETE FROM activations');
  console.log('  ✓ activations 表已清空');

  // 清空 orders 表
  result = db.exec('SELECT COUNT(*) as count FROM orders');
  const ordCount = result.length > 0 ? result[0].values[0][0] : 0;
  console.log(`orders 表当前有 ${ordCount} 条记录`);
  db.run('DELETE FROM orders');
  console.log('  ✓ orders 表已清空');

  // SQLite 需要删除表再重建才能重置自增ID，这里使用 VACUUM
  db.run('DELETE FROM sqlite_sequence WHERE name IN ("activations", "orders")');
  console.log('  ✓ 自增ID已重置');

  // 保存
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
  console.log('\n数据库已保存');

  db.close();
}

function confirm(message) {
  console.log(`\n${message} (y/N): `);
  return process.stdin.readline().trim().toLowerCase() === 'y';
}

// 运行
clearTables().catch(err => {
  console.error('操作失败:', err);
  process.exit(1);
});
