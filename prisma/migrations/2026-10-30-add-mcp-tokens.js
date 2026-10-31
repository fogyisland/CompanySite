/**
 * One-shot migration: add MCP runtime config + MCP token table
 *
 * 2026-10-30: 后台新增「MCP 设置及 Token 申请」菜单
 *   - settings.mcp_config：TEXT，存 { enabled, allowedHosts }（JSON）
 *   - mcp_tokens：后台签发的 MCP 令牌（明文只出现一次，库里存 sha256）
 *
 * 幂等：重复运行无副作用
 *   - 列：INFORMATION_SCHEMA 查了才 ALTER
 *   - 表：CREATE TABLE IF NOT EXISTS
 *
 * 正常情况下服务器启动时 db.js:createTablesIfNotExist() 会自动建好；
 * 本脚本用于「不想重启 / 想在受控窗口里显式执行」的场景。
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

const CREATE_MCP_TOKENS_TABLE = `CREATE TABLE IF NOT EXISTS mcp_tokens (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  token_prefix VARCHAR(20) NOT NULL,
  scopes VARCHAR(255) NOT NULL DEFAULT 'news:read',
  created_by VARCHAR(100) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL,
  last_used_at TIMESTAMP NULL,
  revoked_at TIMESTAMP NULL,
  INDEX idx_mcp_tokens_active (revoked_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    // 1) settings.mcp_config 列
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'settings' AND COLUMN_NAME = 'mcp_config'`,
      [process.env.DB_NAME]
    );

    if (cols.length === 0) {
      console.log('[alter] settings ADD COLUMN mcp_config');
      await conn.query('ALTER TABLE settings ADD COLUMN mcp_config TEXT');
    } else {
      console.log('[skip] settings.mcp_config 已存在');
    }

    // 2) mcp_tokens 表
    console.log('[create] mcp_tokens');
    await conn.query(CREATE_MCP_TOKENS_TABLE);

    console.log('[done] MCP 配置列与令牌表已就绪');
  } catch (err) {
    console.error('[fail]', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();
