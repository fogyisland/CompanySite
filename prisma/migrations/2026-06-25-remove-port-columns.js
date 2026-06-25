/**
 * One-shot migration: drop legacy http_port / https_port columns from settings table
 *
 * 2026-06-25: HTTP 端口改读 process.env.PORT（写入 .env），不再走 DB settings 表
 *             配合 commit "feat(backend): HTTP port from .env, remove httpsPort"
 *             - server.js:4861 读 process.env.PORT
 *             - db.js getSettings/updateSettings 不再读写这两列
 *             - prisma/schema.js settings 表定义删除这两列
 *             - public/admin-settings.html 端口设置组已移除
 *
 * 幂等: 重复运行无副作用（IF EXISTS）
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    // 幂等: INFORMATION_SCHEMA 查列是否存在再 DROP,避免重复运行报错
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'settings'
       AND COLUMN_NAME IN ('http_port', 'https_port')`,
      [process.env.DB_NAME]
    );

    if (cols.length === 0) {
      console.log('[skip] settings 表无 http_port/https_port 列(可能已删除),无需迁移');
      return;
    }

    for (const { COLUMN_NAME } of cols) {
      console.log(`[drop] settings.${COLUMN_NAME}`);
      await conn.query(`ALTER TABLE settings DROP COLUMN \`${COLUMN_NAME}\``);
    }

    console.log('[done] http_port / https_port 列已删除');
  } catch (err) {
    console.error('[fail]', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();
