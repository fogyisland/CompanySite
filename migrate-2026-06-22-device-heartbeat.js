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
    console.log('[1/3] Rename expire → device_software_expire...');
    const [oldT] = await conn.query("SHOW TABLES LIKE 'expire'");
    const [newT] = await conn.query("SHOW TABLES LIKE 'device_software_expire'");
    if (oldT.length === 1 && newT.length === 0) {
      await conn.query('RENAME TABLE expire TO device_software_expire');
      console.log('  → renamed');
    } else if (newT.length === 1) {
      console.log('  → device_software_expire already exists, skip');
    } else {
      console.log('  → neither table exists, nothing to rename');
    }

    console.log('[2/3] Add last_heartbeat_at column...');
    const [cols] = await conn.query("SHOW COLUMNS FROM device_software_expire LIKE 'last_heartbeat_at'");
    if (cols.length === 0) {
      await conn.query('ALTER TABLE device_software_expire ADD COLUMN last_heartbeat_at TIMESTAMP NULL AFTER updated_at');
      console.log('  → added');
    } else {
      console.log('  → last_heartbeat_at already exists, skip');
    }

    console.log('[3/3] Final schema:');
    const [rows] = await conn.query('DESCRIBE device_software_expire');
    console.table(rows);
    console.log('Migration complete.');
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();
