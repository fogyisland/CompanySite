const mysql = require('mysql2/promise');
require('dotenv').config();

const config = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: true
};

(async () => {
  const conn = await mysql.createConnection(config);
  try {
    console.log('[1/2] Creating product_docs table if not exists...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS product_docs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        product_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        content_html MEDIUMTEXT NOT NULL,
        excerpt VARCHAR(500),
        sort_order INT DEFAULT 0,
        status ENUM('draft','published') DEFAULT 'draft',
        author_username VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        published_at TIMESTAMP NULL,
        UNIQUE KEY uk_product_slug (product_id, slug),
        INDEX idx_product_status (product_id, status),
        INDEX idx_sort_order (product_id, sort_order),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [rows] = await conn.query('DESCRIBE product_docs');
    console.log('[2/2] product_docs columns:');
    console.table(rows);
    console.log('Migration complete.');
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();