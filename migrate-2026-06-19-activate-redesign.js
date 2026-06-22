// migrate-2026-06-19-activate-redesign.js
// 一次性迁移脚本：orders.items (JSON) → order_items 表
// 任务 6 - 第一阶段：order_items 迁移
// 后续任务 7、8 会在此文件中添加更多阶段（migrateCodes、migrateUserSoftwareStatus 等）

const mysql = require('mysql2/promise');

/**
 * 将 duration 字符串解析为天数
 * 支持格式："60天"、"3个月"、"1年"、"永久"、"终身"、"2周"
 * @param {string} duration - 原始 duration 字符串
 * @returns {number} 天数
 */
function parseDurationToDays(duration) {
  if (!duration) return 365;
  const s = duration.toString().toLowerCase().trim();
  if (s.includes('永久') || s.includes('终身')) return 36500;
  const dayMatch = s.match(/(\d+)\s*天/);
  if (dayMatch) return parseInt(dayMatch[1]);
  const monthMatch = s.match(/(\d+)\s*个?月/);
  if (monthMatch) return parseInt(monthMatch[1]) * 31;
  const yearMatch = s.match(/(\d+)\s*年/);
  if (yearMatch) return parseInt(yearMatch[1]) * 365;
  const weekMatch = s.match(/(\d+)\s*周/);
  if (weekMatch) return parseInt(weekMatch[1]) * 7;
  return 365;
}

/**
 * 第一阶段：将 orders.items JSON 解析后插入 order_items 表
 * @param {object} conn - mysql2/promise 连接
 * @returns {Promise<{count: number, errors: number}>}
 */
async function migrateOrderItems(conn) {
  console.log('开始迁移 order_items...');
  const [orders] = await conn.query("SELECT id, items FROM orders WHERE items IS NOT NULL");
  let count = 0, errors = 0;

  for (const order of orders) {
    let items;
    try {
      items = JSON.parse(order.items);
    } catch (e) {
      console.error(`订单 #${order.id} items JSON 解析失败:`, e.message);
      errors++;
      continue;
    }

    if (!Array.isArray(items)) continue;

    for (const item of items) {
      // 优先从 item 取 short_name，缺失则回查 products 表
      let productShortName = item.shortName || item.short_name || '';
      if ((item.productId || item.id) && !productShortName) {
        try {
          const [rows] = await conn.query(
            "SELECT short_name FROM products WHERE id = ?",
            [item.productId || item.id]
          );
          if (rows.length > 0) productShortName = rows[0].short_name;
        } catch (e) {
          // 静默失败 - short_name 留空
        }
      }

      const durationDays = parseDurationToDays(item.duration);

      try {
        await conn.query(
          `INSERT INTO order_items (order_id, product_id, product_name, product_short_name, price, quantity, duration_days)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            order.id,
            item.productId || item.id || 0,
            item.name || '',
            productShortName,
            item.price || 0,
            item.quantity || 1,
            durationDays
          ]
        );
        count++;
      } catch (e) {
        console.error(`订单 #${order.id} 商品写入失败:`, e.message);
        errors++;
      }
    }
  }

  console.log(`order_items 迁移完成: ${count} 条成功, ${errors} 条失败`);
  return { count, errors };
}

/**
 * 第二阶段：将 orders.activation_codes (JSON 数组) 解析后插入 order_item_codes 表
 * 如果码存在于 used_activation_codes 表中，标记 is_activated=1
 * @param {object} conn - mysql2/promise 连接
 * @returns {Promise<{count: number, errors: number}>}
 */
async function migrateCodes(conn) {
  console.log('开始迁移 order_item_codes...');
  const [orders] = await conn.query(
    "SELECT id, activation_codes FROM orders WHERE activation_codes IS NOT NULL"
  );
  let count = 0, errors = 0;

  // Build a Set of already-used codes (lookup is one query, not per-iteration)
  const [usedRows] = await conn.query("SELECT activation_code FROM used_activation_codes");
  const usedSet = new Set(usedRows.map(r => r.activation_code));

  for (const order of orders) {
    let codes;
    try {
      codes = JSON.parse(order.activation_codes);
    } catch (e) {
      console.error(`订单 #${order.id} activation_codes JSON 解析失败:`, e.message);
      errors++;
      continue;
    }

    if (!Array.isArray(codes)) continue;

    // Find this order's order_items (the migration in Task 6 already populated them)
    const [orderItems] = await conn.query(
      "SELECT id FROM order_items WHERE order_id = ? ORDER BY id",
      [order.id]
    );
    if (orderItems.length === 0) continue;

    // Map codes to order_items: if fewer items than codes, cycle through items.
    // If more items than codes, codes are spread across items.
    for (let i = 0; i < codes.length; i++) {
      const orderItem = orderItems[i % orderItems.length];
      const code = codes[i];
      const isActivated = usedSet.has(code) ? 1 : 0;

      try {
        await conn.query(
          "INSERT INTO order_item_codes (order_item_id, code, is_activated) VALUES (?, ?, ?)",
          [orderItem.id, code, isActivated]
        );
        count++;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          console.warn(`重复码 ${code}，跳过`);
        } else {
          console.error(`订单 #${order.id} 码 ${code} 写入失败:`, e.message);
          errors++;
        }
      }
    }
  }

  console.log(`order_item_codes 迁移完成: ${count} 条成功, ${errors} 条失败`);
  return { count, errors };
}

/**
 * 第三阶段：聚合 activations + installations → user_software_status
 * - 按 (user_name, software_short_name) 去重
 * - 取最早 install_date 作为 first_run
 * - 取最新 expire_date（来自 activations）
 * - 根据 expire_date 是否过期计算 `lock`
 * @param {object} conn - mysql2/promise 连接
 * @returns {Promise<{count: number, errors: number}>}
 */
async function migrateUserSoftwareStatus(conn) {
  console.log('开始迁移 user_software_status...');
  let count = 0, errors = 0;

  // 1. Aggregate from activations table
  // Join products to get short_name; LEFT JOIN because activations may reference
  // software names that no longer exist in products (allow null short_name → skip)
  const [activations] = await conn.query(`
    SELECT a.user_name, a.software_name, a.install_date, a.expire_date,
           p.short_name AS software_short_name
    FROM activations a
    LEFT JOIN products p ON p.name = a.software_name
    WHERE a.software_name IS NOT NULL
  `);

  // Group by (user_name, software_short_name)
  const groups = new Map();
  for (const a of activations) {
    if (!a.software_short_name) continue;
    const key = `${a.user_name}::${a.software_short_name}`;
    if (!groups.has(key)) {
      groups.set(key, {
        user_name: a.user_name,
        software_short_name: a.software_short_name,
        first_run: null,
        last_activated_at: null,
        duration: 0,
        expire_date: null
      });
    }
    const g = groups.get(key);
    // earliest install_date
    if (a.install_date && (!g.first_run || new Date(a.install_date) < new Date(g.first_run))) {
      g.first_run = a.install_date;
    }
    // latest expire_date
    if (a.expire_date) {
      const exp = new Date(a.expire_date);
      if (!g.expire_date || exp > new Date(g.expire_date)) {
        g.expire_date = a.expire_date;
        g.last_activated_at = a.activate_date || a.install_date || new Date();
      }
    }
  }

  // 2. Supplement first_run from installations table
  const [installations] = await conn.query(`
    SELECT user_name, software_short_name, install_date
    FROM installations
    WHERE software_short_name IS NOT NULL
  `);
  for (const inst of installations) {
    const key = `${inst.user_name}::${inst.software_short_name}`;
    if (groups.has(key)) {
      const g = groups.get(key);
      if (inst.install_date && (!g.first_run || new Date(inst.install_date) < new Date(g.first_run))) {
        g.first_run = inst.install_date;
      }
    } else {
      // installation but no activation → insert with no expire_date
      const newGroup = {
        user_name: inst.user_name,
        software_short_name: inst.software_short_name,
        first_run: inst.install_date,
        last_activated_at: null,
        duration: 0,
        expire_date: null
      };
      // ensure duration is 0 for install-only path
      newGroup.duration = 0;
      groups.set(key, newGroup);
    }
  }

  // 3. Insert groups into user_software_status
  for (const g of groups.values()) {
    const lock = g.expire_date && new Date(g.expire_date) < new Date() ? 1 : 0;
    try {
      await conn.query(
        `INSERT INTO user_software_status
         (user_name, software_short_name, first_run, last_activated_at, duration, expire_date, \`lock\`)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          g.user_name,
          g.software_short_name,
          g.first_run,
          g.last_activated_at,
          g.duration || 0,
          g.expire_date,
          lock
        ]
      );
      count++;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        console.warn(`重复 (${g.user_name}, ${g.software_short_name})，跳过`);
      } else {
        console.error(`user_software_status 写入失败 (${g.user_name}, ${g.software_short_name}):`, e.message);
        errors++;
      }
    }
  }

  console.log(`user_software_status 迁移完成: ${count} 条成功, ${errors} 条失败`);
  return { count, errors };
}

/**
 * 第四阶段：将所有现有用户标记为 email_verified=1
 * 原因：这些用户注册早于 Task 1 的邮箱验证功能，Task 15 会拒绝未验证用户
 * @param {object} conn - mysql2/promise 连接
 * @returns {Promise<{success: boolean}>}
 */
async function markOldUsersVerified(conn) {
  await conn.query("UPDATE users SET email_verified = 1 WHERE email_verified = 0");
  console.log('旧用户已全部置为 email_verified=1');
  return { success: true };
}

/**
 * 主入口：连接数据库并执行三阶段迁移
 * 任务 8: 添加第三、四阶段 (migrateUserSoftwareStatus + markOldUsersVerified)
 */
async function migrate() {
  const conn = await mysql.createConnection({
    host: '139.5.108.245',
    port: 3306,
    user: 'homedb',
    password: 'Admin909217',
    database: 'homedb'
  });

  try {
    const phase1 = await migrateOrderItems(conn);
    const phase2 = await migrateCodes(conn);
    const phase3 = await migrateUserSoftwareStatus(conn);
    await markOldUsersVerified(conn);
    console.log('全部完成:', { orderItems: phase1, orderItemCodes: phase2, userSoftwareStatus: phase3 });
    return { orderItems: phase1, orderItemCodes: phase2, userSoftwareStatus: phase3 };
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrate().catch(e => {
    console.error('迁移失败:', e);
    process.exit(1);
  });
}

module.exports = { migrateOrderItems, migrateCodes, migrateUserSoftwareStatus, markOldUsersVerified, parseDurationToDays };
