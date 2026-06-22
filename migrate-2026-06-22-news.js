// 幂等 migration：创建 news 表（公告/公司动态）
// 用法：node migrate-2026-06-22-news.js
// 已运行过则跳过（检查 INFORMATION_SCHEMA.TABLES）

const mysql = require('mysql2/promise');
require('dotenv').config();

const TABLE_NAME = 'news';

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS news (
  id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  excerpt TEXT,
  content_html MEDIUMTEXT,
  cover_image VARCHAR(500),
  category VARCHAR(50),
  is_pinned TINYINT(1) DEFAULT 0,
  status ENUM('draft','published') DEFAULT 'draft',
  view_count INT(11) DEFAULT 0,
  published_at TIMESTAMP NULL,
  sort_order INT(11) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status_published (status, published_at),
  INDEX idx_is_pinned (is_pinned)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    // 检查表是否已存在
    const [rows] = await conn.query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ?",
      [TABLE_NAME, process.env.DB_NAME]
    );
    if (rows.length > 0) {
      console.log(`[skip] news 表已存在`);
    } else {
      await conn.query(CREATE_SQL);
      console.log(`[ok] news 表已创建`);
    }
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('[fail]', err.message);
  process.exit(1);
});