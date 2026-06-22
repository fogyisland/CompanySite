require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
    queueLimit: 0
  });

  let migrated = 0;
  let updated = 0;

  try {
    // 1. 添加 is_admin 列（幂等：列已存在则忽略）
    try {
      await pool.query('ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0');
      console.log('[migrate] 已添加 is_admin 列');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('[migrate] is_admin 列已存在，跳过');
      } else {
        throw e;
      }
    }

    // 2. 读出 admin 表所有记录
    const [admins] = await pool.query('SELECT id, username, password, created_at FROM admin');

    // 3. 逐条迁移
    for (const a of admins) {
      const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [a.username]);

      if (existing.length > 0) {
        // 用户为准：保留 users 记录，只升级为管理员
        await pool.query('UPDATE users SET is_admin = 1 WHERE id = ?', [existing[0].id]);
        updated++;
        console.log(`[migrate] 已升级为管理员: ${a.username} (用户已存在)`);
      } else {
        await pool.query(
          'INSERT INTO users (username, password, is_admin, created_at) VALUES (?, ?, 1, ?)',
          [a.username, a.password, a.created_at || new Date()]
        );
        migrated++;
        console.log(`[migrate] 已迁移新管理员: ${a.username}`);
      }
    }

    console.log(`\n[migrate] 完成。新增 ${migrated} 个管理员用户；升级 ${updated} 个已存在用户。`);
    console.log(`[migrate] admin 表已保留，未删除（用于回退）。`);

    // 4. 验证
    const [adminCount] = await pool.query('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1');
    console.log(`[migrate] users 表中当前 is_admin=1 的记录数: ${adminCount[0].c}`);
  } catch (e) {
    console.error('[migrate] 失败:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();