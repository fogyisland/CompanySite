const mysql = require('mysql2/promise');
require('dotenv').config();

const config = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};

(async () => {
  const conn = await mysql.createConnection(config);
  try {
    console.log('Migration 2026-06-22-course-products starting...');

    // 1. 加 is_course 列（幂等）
    const [cols] = await conn.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'is_course'
    `);
    if (cols.length === 0) {
      await conn.query(`ALTER TABLE products ADD COLUMN is_course INT DEFAULT 0`);
      console.log('✓ Added products.is_course column');
    } else {
      console.log('⊘ products.is_course already exists, skipping');
    }

    // 2. 新建 product_links 表（幂等）
    await conn.query(`
      CREATE TABLE IF NOT EXISTS product_links (
        id INT PRIMARY KEY AUTO_INCREMENT,
        product_id INT NOT NULL,
        platform VARCHAR(50) NOT NULL,
        url VARCHAR(500) NOT NULL,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product (product_id)
      )
    `);
    console.log('✓ product_links table created/verified');

    // 3. 现有产品全部 is_course=0（默认，无需 UPDATE）
    console.log('✓ All existing products default to is_course=0');

    console.log('Migration 2026-06-22-course-products done.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();
