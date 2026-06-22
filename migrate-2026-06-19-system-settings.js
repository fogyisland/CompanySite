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
    console.log('[1/3] Creating system_settings table if not exists...');
    await conn.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id INT PRIMARY KEY AUTO_INCREMENT,
        setting_key VARCHAR(100) NOT NULL UNIQUE,
        setting_value TEXT,
        description VARCHAR(500),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by VARCHAR(100),
        INDEX idx_setting_key (setting_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('[2/3] Inserting default admin_theme and admin_dark_mode rows...');
    await conn.query(`
      INSERT INTO system_settings (setting_key, setting_value, description) VALUES
        ('admin_theme', 'b', 'Admin UI theme: b (GitHub) | c (Stripe) | d (Ant Design Pro)'),
        ('admin_dark_mode', '0', 'Admin UI dark mode: 0 (light) | 1 (dark)')
      ON DUPLICATE KEY UPDATE setting_key = setting_key
    `);

    const [rows] = await conn.query('SELECT setting_key, setting_value FROM system_settings ORDER BY setting_key');
    console.log('[3/3] Current system_settings:');
    console.table(rows);
    console.log('Migration complete.');
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();