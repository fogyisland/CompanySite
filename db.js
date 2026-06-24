const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'db-config.json');
const SALT_ROUNDS = 12; // 修复 S19：bcrypt cost 12（2026 年 OWASP 推荐 12+，cost 10 离线破解成本过低）

let mysqlPool = null;

function getDbConfig() {
  // 优先从环境变量读取数据库配置
  const envConfig = {
    type: 'mysql',
    mysql: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'softvault'
    }
  };

  // 如果环境变量有配置，优先使用
  if (process.env.DB_HOST) {
    return envConfig;
  }

  // 否则从配置文件读取
  const configFile = path.join(DATA_DIR, 'db-config.json');
  if (fs.existsSync(configFile)) {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {}
  }
  return envConfig;
}

function updateDbConfig(newConfig) {
  const configFile = path.join(DATA_DIR, 'db-config.json');
  fs.writeFileSync(configFile, JSON.stringify(newConfig, null, 2), 'utf8');
  return newConfig;
}

// Transaction helper: runs `fn(conn)` inside a single MySQL connection with
// begin/commit/rollback. The connection is released back to the pool even on
// throw. Use this when a code path does multi-statement writes that must be
// all-or-nothing (e.g., approve-payment: update order status + insert
// activation codes). Without this, a partial failure leaves the order paid
// but with missing codes (I14).
async function withTransaction(fn) {
  if (!mysqlPool) throw new Error('MySQL pool not initialized');
  const conn = await mysqlPool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore rollback errors */ }
    throw err;
  } finally {
    conn.release();
  }
}

async function initDatabase() {
  const config = getDbConfig();
  if (config.type === 'mysql' && config.mysql && config.mysql.host) {
    try {
      await initMySQL(config.mysql);
      await createTablesIfNotExist();
      await initDefaultData();
      console.log('Database initialized (MySQL)');
    } catch (e) {
      console.error('MySQL初始化失败:', e.message);
      throw e;
    }
  } else {
    throw new Error('未配置MySQL数据库');
  }
}

async function initMySQL(mysqlConfig) {
  const mysql = require('mysql2/promise');
  mysqlPool = mysql.createPool({
    host: mysqlConfig.host,
    port: mysqlConfig.port || 3306,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    database: mysqlConfig.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // 修复：cron / 长时间 idle 后第一条查询报 ECONNRESET。
    // 启用 TCP keepalive 让中间路由器/防火墙不会因为 idle 杀掉连接，
    // MySQL server 端 wait_timeout 默认 8h，keepalive 间隔 10s 远小于此
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });
  const connection = await mysqlPool.getConnection();
  connection.release();
  console.log('MySQL连接成功');
  return true;
}

async function createTablesIfNotExist() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS products (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      short_name VARCHAR(100) NOT NULL UNIQUE,
      category VARCHAR(255),
      price REAL NOT NULL,
      pricing_tiers TEXT,
      description TEXT,
      version VARCHAR(100),
      platform VARCHAR(100),
      features TEXT,
      icon VARCHAR(500),
      featured INT DEFAULT 0,
      download_url VARCHAR(500),
      external_link INT DEFAULT 0,
      detail_page VARCHAR(500),
      image VARCHAR(500),
      image_dark_bg INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1,
      company_name VARCHAR(255),
      logo VARCHAR(500),
      description TEXT,
      banners TEXT,
      ssl_domain VARCHAR(255),
      ssl_cert_path VARCHAR(500),
      ssl_key_path VARCHAR(500),
      ssl_ca_path VARCHAR(500),
      http_port INT DEFAULT 10000,
      https_port INT DEFAULT 10001,
      smtp_host VARCHAR(255),
      smtp_port INT DEFAULT 587,
      smtp_user VARCHAR(255),
      smtp_password VARCHAR(255),
      smtp_from VARCHAR(255),
      smtp_secure INT DEFAULT 0,
      wechat_id VARCHAR(255),
      admin_email VARCHAR(255),
      ai_config TEXT,
      carddav_config TEXT,
      site_theme VARCHAR(50) DEFAULT 'minimal',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS login_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(255),
      ip VARCHAR(100),
      user_agent TEXT,
      status VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS operation_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(255),
      action VARCHAR(255),
      target VARCHAR(500),
      details TEXT,
      ip VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS registration_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255),
      ip VARCHAR(100),
      user_agent TEXT,
      status VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS activation_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      mac_address VARCHAR(255),
      software_name VARCHAR(255),
      activation_key VARCHAR(255),
      status VARCHAR(50),
      ip VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS telemetry (
      id INT PRIMARY KEY AUTO_INCREMENT,
      device_id VARCHAR(255) NOT NULL,
      app_name VARCHAR(255) NOT NULL,
      app_version VARCHAR(100),
      first_seen TIMESTAMP NULL,
      events TEXT,
      platform VARCHAR(100),
      os_version VARCHAR(100),
      client_ip VARCHAR(100),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(50),
      real_name VARCHAR(255),
      company_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT,
      items TEXT,
      total_amount REAL,
      status VARCHAR(50) DEFAULT 'pending',
      verification_code VARCHAR(255),
      activation_codes TEXT,
      order_number VARCHAR(100),
      is_activated INT DEFAULT 0,
      is_archived INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      paid_at TIMESTAMP NULL
    )`,
    `CREATE TABLE IF NOT EXISTS order_items (
      id INT PRIMARY KEY AUTO_INCREMENT,
      order_id INT NOT NULL,
      product_id INT NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      product_short_name VARCHAR(100) NOT NULL,
      price REAL NOT NULL,
      quantity INT DEFAULT 1,
      duration_days INT NOT NULL,
      INDEX idx_order_id (order_id),
      INDEX idx_product_short (product_short_name),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS order_item_codes (
      id INT PRIMARY KEY AUTO_INCREMENT,
      order_item_id INT NOT NULL,
      code VARCHAR(64) NOT NULL UNIQUE,
      is_activated INT DEFAULT 0,
      activated_at TIMESTAMP NULL,
      activated_by_user VARCHAR(255),
      activated_by_mac VARCHAR(64),
      INDEX idx_order_item (order_item_id),
      FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE
    )`,
    "CREATE TABLE IF NOT EXISTS user_software_status (\n" +
    "      id INT PRIMARY KEY AUTO_INCREMENT,\n" +
    "      user_name VARCHAR(255) NOT NULL,\n" +
    "      software_short_name VARCHAR(100) NOT NULL,\n" +
    "      first_run TIMESTAMP NULL,\n" +
    "      last_activated_at TIMESTAMP NULL,\n" +
    "      duration INT DEFAULT 0,\n" +
    "      expire_date TIMESTAMP NULL,\n" +
    "      `lock` INT DEFAULT 0,\n" +
    "      last_reminder_at TIMESTAMP NULL,\n" +
    "      reminder_count INT DEFAULT 0,\n" +
    "      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n" +
    "      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n" +
    "      UNIQUE KEY uk_user_software (user_name, software_short_name)\n" +
    "    )",
    `CREATE TABLE IF NOT EXISTS activations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_name VARCHAR(255) NOT NULL,
      organization VARCHAR(255),
      email VARCHAR(255) NOT NULL,
      software_name VARCHAR(255) NOT NULL,
      mac_address VARCHAR(255),
      install_date VARCHAR(100),
      activate_date VARCHAR(100),
      expire_date VARCHAR(100),
      activation_key VARCHAR(255),
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS support_tickets (
      id INT PRIMARY KEY AUTO_INCREMENT,
      subject VARCHAR(500) NOT NULL,
      description TEXT NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      user_email VARCHAR(255) NOT NULL,
      user_phone VARCHAR(50),
      status VARCHAR(50) DEFAULT 'open',
      priority VARCHAR(50) DEFAULT 'normal',
      replies TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS installations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      software_name VARCHAR(255) NOT NULL,
      software_short_name VARCHAR(100),
      software_version VARCHAR(100),
      user_name VARCHAR(255) NOT NULL,
      user_email VARCHAR(255) NOT NULL,
      organization VARCHAR(255),
      mac_address VARCHAR(255),
      install_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expire_date VARCHAR(100),
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS faqs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      question VARCHAR(500) NOT NULL,
      answer TEXT NOT NULL,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS subscribers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL UNIQUE,
      subscribed INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const sql of queries) {
    await mysqlPool.query(sql);
  }

  // ALTER statements for users (Task 1)
  const userAlterStatements = [
    "ALTER TABLE users ADD COLUMN email_verified INT DEFAULT 0",
    "ALTER TABLE users ADD COLUMN email_verify_token VARCHAR(128)",
    "ALTER TABLE users ADD COLUMN email_verify_expires_at TIMESTAMP NULL"
  ];
  for (const sql of userAlterStatements) {
    try {
      await mysqlPool.query(sql);
    } catch (e) {
      if (!e.message.includes('Duplicate column')) throw e;
    }
  }

  // ALTER statements for orders (Task 5)
  const orderAlterStatements = [
    "ALTER TABLE orders ADD COLUMN payment_method VARCHAR(50)",
    "ALTER TABLE orders ADD COLUMN paypal_order_id VARCHAR(255)"
  ];
  for (const sql of orderAlterStatements) {
    try {
      await mysqlPool.query(sql);
    } catch (e) {
      if (!e.message.includes('Duplicate column')) throw e;
    }
  }
}

async function initDefaultData() {
  const [settingsRows] = await mysqlPool.query('SELECT COUNT(*) as c FROM settings');
  if (settingsRows[0].c === 0) {
    await mysqlPool.query("INSERT INTO settings (id, company_name, description) VALUES (1, '博铭科技', '专业软件商城')");
  }

  const [faqRows] = await mysqlPool.query('SELECT COUNT(*) as c FROM faqs');
  if (faqRows[0].c === 0) {
    const defaultFaqs = [
      ['如何购买软件？', '选择您需要的产品，点击"立即购买"按钮。在结算页面完成支付后，您将收到下载链接和授权密钥。'],
      ['购买后如何获取软件？', '支付成功后，系统会自动显示下载链接。同时，我们会将下载链接和授权密钥发送到您的注册邮箱。'],
      ['软件支持哪些操作系统？', '我们的软件支持Windows、Mac和Linux系统。具体支持情况请查看产品详情页的"平台"信息。'],
      ['可以申请退款吗？', '我们提供30天退款保障。如需退款，请在购买后30天内联系我们的客服团队，提供您的订单信息。'],
      ['如何获得软件更新？', '在同一版本周期内，您可以免费获得所有更新。下载新版软件后，使用您的授权密钥即可激活。']
    ];
    for (let i = 0; i < defaultFaqs.length; i++) {
      await mysqlPool.query("INSERT INTO faqs (question, answer, sort_order) VALUES (?, ?, ?)", defaultFaqs[i].concat([i]));
    }
  }
}

// 通用查询
async function query(sql, params = []) {
  try {
    const [rows] = await mysqlPool.query(sql, params);
    return rows;
  } catch (e) {
    console.error('Query error:', e.message);
    throw e;
  }
}

// 返回 { columns, values } 格式
async function dbQuery(sql, params = []) {
  const rows = await query(sql, params);
  if (Array.isArray(rows) && rows.length > 0) {
    const columns = Object.keys(rows[0]);
    const values = rows.map(row => columns.map(col => row[col]));
    return { columns, values };
  }
  return { columns: [], values: [] };
}

// 执行写操作（INSERT/UPDATE/DELETE）
async function runQuery(sql, params = []) {
  await mysqlPool.query(sql, params);
  return { success: true };
}

// ============ 登录验证 ============

async function verifyLogin(username, password) {
  const sql = username.includes('@')
    ? "SELECT id, username, password, is_admin, email, email_verified FROM users WHERE email = ?"
    : "SELECT id, username, password, is_admin, email, email_verified FROM users WHERE username = ?";
  const [rows] = await mysqlPool.query(sql, [username]);
  if (rows.length === 0) return null;
  const match = await bcrypt.compare(password, rows[0].password);
  if (!match) return null;
  // 丢弃 password 字段，只返回安全字段（id, username, is_admin, email, email_verified）
  const { password: _pw, ...safeUser } = rows[0];
  return safeUser;
}

// ============ 产品操作 ============

async function getAllProducts() {
  const [rows] = await mysqlPool.query("SELECT * FROM products ORDER BY id DESC");
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    category: row.category,
    price: row.price,
    pricingTiers: row.pricing_tiers ? JSON.parse(row.pricing_tiers) : null,
    description: row.description,
    version: row.version,
    platform: row.platform,
    features: row.features ? JSON.parse(row.features) : [],
    icon: row.icon,
    featured: row.featured === 1,
    downloadUrl: row.download_url,
    externalLink: row.external_link === 1,
    detailPage: row.detail_page,
    image: row.image,
    imageDarkBg: row.image_dark_bg === 1,
    isCourse: row.is_course === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function getProductsPaginated({ isCourse, search, page, pageSize }) {
  const conditions = [];
  const params = [];

  if (isCourse === true || isCourse === false) {
    conditions.push('is_course = ?');
    params.push(isCourse ? 1 : 0);
  }

  if (search && search.trim() !== '') {
    conditions.push('(name LIKE ? OR short_name LIKE ?)');
    const like = '%' + search.trim() + '%';
    params.push(like, like);
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

  // 总数 (不带 LIMIT/OFFSET)
  const [countRows] = await mysqlPool.query(
    'SELECT COUNT(*) AS total FROM products' + where,
    params
  );
  const total = countRows[0].total;

  // 数据 (带 LIMIT/OFFSET + 排序)
  const offset = (page - 1) * pageSize;
  const [rows] = await mysqlPool.query(
    'SELECT * FROM products' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [...params, pageSize, offset]
  );

  const products = rows.map(row => ({
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    category: row.category,
    price: row.price,
    pricingTiers: row.pricing_tiers ? JSON.parse(row.pricing_tiers) : null,
    description: row.description,
    version: row.version,
    platform: row.platform,
    features: row.features ? JSON.parse(row.features) : [],
    icon: row.icon,
    featured: row.featured === 1,
    downloadUrl: row.download_url,
    externalLink: row.external_link === 1,
    detailPage: row.detail_page,
    image: row.image,
    imageDarkBg: row.image_dark_bg === 1,
    isCourse: row.is_course === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));

  return {
    products,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1
  };
}

async function getProduct(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM products WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    category: row.category,
    price: row.price,
    pricingTiers: row.pricing_tiers ? JSON.parse(row.pricing_tiers) : null,
    description: row.description,
    version: row.version,
    platform: row.platform,
    features: row.features ? JSON.parse(row.features) : [],
    icon: row.icon,
    featured: row.featured === 1,
    downloadUrl: row.download_url,
    externalLink: row.external_link === 1,
    detailPage: row.detail_page,
    image: row.image,
    imageDarkBg: row.image_dark_bg === 1,
    isCourse: row.is_course === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getProductByShortName(shortName) {
  const [rows] = await mysqlPool.query("SELECT * FROM products WHERE short_name = ?", [shortName]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    category: row.category,
    price: row.price,
    pricingTiers: row.pricing_tiers ? JSON.parse(row.pricing_tiers) : null,
    description: row.description,
    version: row.version,
    platform: row.platform,
    features: row.features ? JSON.parse(row.features) : [],
    icon: row.icon,
    featured: row.featured === 1,
    downloadUrl: row.download_url,
    externalLink: row.external_link === 1,
    detailPage: row.detail_page,
    image: row.image,
    imageDarkBg: row.image_dark_bg === 1,
    isCourse: row.is_course === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createProduct(product) {
  const isCourseVal = (product.isCourse === true || product.isCourse === 1) ? 1 : 0;
  const [result] = await mysqlPool.query(
    `INSERT INTO products (name, short_name, category, price, pricing_tiers, description, version, platform, features, icon, featured, download_url, external_link, detail_page, image, image_dark_bg, is_course)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [product.name, product.shortName || '', product.category, product.price, JSON.stringify(product.pricingTiers), product.description,
     product.version, product.platform, JSON.stringify(product.features), product.icon, product.featured ? 1 : 0,
     product.downloadUrl, product.externalLink ? 1 : 0, product.detailPage, product.image, product.imageDarkBg ? 1 : 0, isCourseVal]
  );
  const insertId = result.insertId;
  if (Array.isArray(product.courseLinks) && product.courseLinks.length > 0) {
    await setProductLinks(insertId, product.courseLinks);
  }
  return getProduct(insertId);
}

async function updateProduct(id, product) {
  const isCourseVal = (product.isCourse === true || product.isCourse === 1) ? 1 : 0;
  await mysqlPool.query(
    `UPDATE products SET name=?, short_name=?, category=?, price=?, pricing_tiers=?, description=?, version=?, platform=?, features=?, icon=?, featured=?, download_url=?, external_link=?, detail_page=?, image=?, image_dark_bg=?, is_course=? WHERE id=?`,
    [product.name, product.shortName || '', product.category, product.price, JSON.stringify(product.pricingTiers), product.description,
     product.version, product.platform, JSON.stringify(product.features), product.icon, product.featured ? 1 : 0,
     product.downloadUrl, product.externalLink ? 1 : 0, product.detailPage, product.image, product.imageDarkBg ? 1 : 0, isCourseVal, id]
  );
  if (Array.isArray(product.courseLinks)) {
    await setProductLinks(id, product.courseLinks);
  }
  return getProduct(id);
}

async function deleteProduct(id) {
  await mysqlPool.query("DELETE FROM products WHERE id = ?", [id]);
  return { success: true };
}

// ============ 课程型产品链接（product_links） ============

async function getProductLinks(productId) {
  const [rows] = await mysqlPool.query(
    'SELECT id, platform, url, sort_order FROM product_links WHERE product_id = ? ORDER BY sort_order ASC, id ASC',
    [productId]
  );
  return rows.map(r => ({
    id: r.id,
    platform: r.platform,
    url: r.url,
    sortOrder: r.sort_order
  }));
}

async function setProductLinks(productId, links) {
  const conn = await mysqlPool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM product_links WHERE product_id = ?', [productId]);
    if (links && links.length > 0) {
      const values = links.map((link, i) => [productId, link.platform, link.url, i]);
      await conn.query(
        'INSERT INTO product_links (product_id, platform, url, sort_order) VALUES ?',
        [values]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getProductWithLinks(productId) {
  const [rows] = await mysqlPool.query('SELECT * FROM products WHERE id = ?', [productId]);
  if (rows.length === 0) return null;
  const product = rows[0];
  const links = await getProductLinks(productId);
  return {
    id: product.id,
    name: product.name,
    shortName: product.short_name,
    category: product.category,
    price: product.price,
    pricingTiers: product.pricing_tiers ? JSON.parse(product.pricing_tiers) : null,
    description: product.description,
    version: product.version,
    platform: product.platform,
    features: product.features ? JSON.parse(product.features) : [],
    icon: product.icon,
    featured: product.featured === 1,
    downloadUrl: product.download_url,
    externalLink: product.external_link === 1,
    detailPage: product.detail_page,
    image: product.image,
    imageDarkBg: product.image_dark_bg === 1,
    isCourse: product.is_course === 1,
    courseLinks: links,
    createdAt: product.created_at,
    updatedAt: product.updated_at
  };
}

async function searchProducts(keyword) {
  // Escape LIKE special characters AND declare ESCAPE clause so MySQL honors the backslash
  // 修复 S17：没有 ESCAPE 子句时 MySQL 默认不识别 backslash 转义，前面 escape 形同虚设
  const escapedKeyword = String(keyword).replace(/[%_\\]/g, '\\$&');
  const [rows] = await mysqlPool.query(
    "SELECT * FROM products WHERE name LIKE ? ESCAPE '\\\\' OR description LIKE ? ESCAPE '\\\\' ORDER BY id DESC",
    [`%${escapedKeyword}%`, `%${escapedKeyword}%`]
  );
  return rows.map(row => ({
    id: row.id, name: row.name, category: row.category, price: row.price,
    pricingTiers: row.pricing_tiers ? JSON.parse(row.pricing_tiers) : null,
    description: row.description, version: row.version, platform: row.platform,
    features: row.features ? JSON.parse(row.features) : [], icon: row.icon,
    featured: row.featured === 1, downloadUrl: row.download_url, externalLink: row.external_link === 1,
    detailPage: row.detail_page, image: row.image, imageDarkBg: row.image_dark_bg === 1,
    createdAt: row.created_at, updatedAt: row.updated_at
  }));
}

// ============ 设置操作 ============

async function getSettings() {
  const [rows] = await mysqlPool.query("SELECT * FROM settings WHERE id = 1");
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    companyName: row.company_name,
    logo: row.logo,
    description: row.description,
    banners: row.banners ? JSON.parse(row.banners) : [],
    sslDomain: row.ssl_domain,
    sslCertPath: row.ssl_cert_path,
    sslKeyPath: row.ssl_key_path,
    sslCaPath: row.ssl_ca_path,
    httpPort: row.http_port,
    httpsPort: row.https_port,
    smtp: {
      host: row.smtp_host,
      port: row.smtp_port,
      user: row.smtp_user,
      password: row.smtp_password,
      from: row.smtp_from,
      secure: row.smtp_secure === 1
    },
    wechatId: row.wechat_id,
    adminEmail: row.admin_email,
    aiConfig: row.ai_config ? JSON.parse(row.ai_config) : null,
    carddavConfig: row.carddav_config ? JSON.parse(row.carddav_config) : null,
    siteTheme: row.site_theme || 'minimal',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getSmtpConfig() {
  const [rows] = await mysqlPool.query("SELECT smtp_host, smtp_port, smtp_user, smtp_password, smtp_from, smtp_secure FROM settings WHERE id = 1");
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    host: row.smtp_host,
    port: row.smtp_port,
    user: row.smtp_user,
    password: row.smtp_password,
    from: row.smtp_from,
    secure: row.smtp_secure === 1
  };
}

async function updateSettings(settings) {
  const updates = [];
  const values = [];
  if (settings.companyName !== undefined) { updates.push("company_name = ?"); values.push(settings.companyName); }
  if (settings.logo !== undefined) { updates.push("logo = ?"); values.push(settings.logo); }
  if (settings.description !== undefined) { updates.push("description = ?"); values.push(settings.description); }
  if (settings.banners !== undefined) { updates.push("banners = ?"); values.push(JSON.stringify(settings.banners)); }
  if (settings.sslDomain !== undefined) { updates.push("ssl_domain = ?"); values.push(settings.sslDomain); }
  if (settings.sslCertPath !== undefined) { updates.push("ssl_cert_path = ?"); values.push(settings.sslCertPath); }
  if (settings.sslKeyPath !== undefined) { updates.push("ssl_key_path = ?"); values.push(settings.sslKeyPath); }
  if (settings.sslCaPath !== undefined) { updates.push("ssl_ca_path = ?"); values.push(settings.sslCaPath); }
  if (settings.httpPort !== undefined) { updates.push("http_port = ?"); values.push(settings.httpPort); }
  if (settings.httpsPort !== undefined) { updates.push("https_port = ?"); values.push(settings.httpsPort); }
  if (settings.smtp) {
    if (settings.smtp.host !== undefined) { updates.push("smtp_host = ?"); values.push(settings.smtp.host); }
    if (settings.smtp.port !== undefined) { updates.push("smtp_port = ?"); values.push(settings.smtp.port); }
    if (settings.smtp.user !== undefined) { updates.push("smtp_user = ?"); values.push(settings.smtp.user); }
    if (settings.smtp.password !== undefined) { updates.push("smtp_password = ?"); values.push(settings.smtp.password); }
    if (settings.smtp.from !== undefined) { updates.push("smtp_from = ?"); values.push(settings.smtp.from); }
    if (settings.smtp.secure !== undefined) { updates.push("smtp_secure = ?"); values.push(settings.smtp.secure ? 1 : 0); }
  }
  if (settings.email) {
    if (settings.email.host !== undefined) { updates.push("smtp_host = ?"); values.push(settings.email.host); }
    if (settings.email.port !== undefined) { updates.push("smtp_port = ?"); values.push(settings.email.port); }
    if (settings.email.user !== undefined) { updates.push("smtp_user = ?"); values.push(settings.email.user); }
    if (settings.email.password !== undefined) { updates.push("smtp_password = ?"); values.push(settings.email.password); }
    if (settings.email.from !== undefined) { updates.push("smtp_from = ?"); values.push(settings.email.from); }
    if (settings.email.secure !== undefined) { updates.push("smtp_secure = ?"); values.push(settings.email.secure ? 1 : 0); }
  }
  if (settings.wechatId !== undefined) { updates.push("wechat_id = ?"); values.push(settings.wechatId); }
  if (settings.adminEmail !== undefined) { updates.push("admin_email = ?"); values.push(settings.adminEmail); }
  if (settings.aiConfig !== undefined) { updates.push("ai_config = ?"); values.push(JSON.stringify(settings.aiConfig)); }
  if (settings.ai !== undefined) { updates.push("ai_config = ?"); values.push(JSON.stringify(settings.ai)); }
  if (settings.carddavConfig !== undefined) { updates.push("carddav_config = ?"); values.push(JSON.stringify(settings.carddavConfig)); }
  if (settings.siteTheme !== undefined) { updates.push("site_theme = ?"); values.push(settings.siteTheme); }
  updates.push("updated_at = ?");
  values.push(new Date().toISOString().slice(0,19).replace('T',' '));
  values.push(1);
  await mysqlPool.query("UPDATE settings SET " + updates.join(", ") + " WHERE id = ?", values);
  return getSettings();
}

// ============ 用户操作 ============

async function getAllUsers() {
  const [rows] = await mysqlPool.query("SELECT * FROM users ORDER BY id DESC");
  return rows.map(row => ({
    id: row.id, username: row.username, email: row.email,
    phone: row.phone, realName: row.real_name, company: row.company_name, createdAt: row.created_at
  }));
}

async function getUser(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM users WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, username: row.username, email: row.email, phone: row.phone, realName: row.real_name, company: row.company_name, createdAt: row.created_at };
}

async function getUserByUsername(username) {
  const [rows] = await mysqlPool.query("SELECT * FROM users WHERE username = ?", [username]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, username: row.username, email: row.email, phone: row.phone, realName: row.real_name, company: row.company_name, createdAt: row.created_at };
}

async function createUser(user) {
  const hash = await bcrypt.hash(user.password, SALT_ROUNDS);
  const [result] = await mysqlPool.query(
    `INSERT INTO users (username, password, email, phone, real_name, company_name, is_admin, email_verified, email_verify_token, email_verify_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.username, hash, user.email, user.phone, user.realName, user.company,
      user.isAdmin ? 1 : 0,
      user.emailVerified !== undefined ? user.emailVerified : 0,
      user.emailVerifyToken || null,
      user.emailVerifyExpiresAt || null
    ]
  );
  return result.insertId;
}

async function updateUser(id, user) {
  let hash = user.password;
  // 如果密码是明文（不是hash格式），则加密
  if (user.password && !user.password.startsWith('$2')) {
    hash = await bcrypt.hash(user.password, SALT_ROUNDS);
  }
  await mysqlPool.query(
    "UPDATE users SET username=?, password=?, email=?, phone=?, real_name=?, company_name=? WHERE id=?",
    [user.username, hash, user.email, user.phone, user.realName, user.company, id]
  );
  return getUser(id);
}

async function deleteUser(id) {
  await mysqlPool.query("DELETE FROM users WHERE id = ?", [id]);
  return { success: true };
}

async function setUserAdmin(id, isAdmin) {
  await mysqlPool.query("UPDATE users SET is_admin = ? WHERE id = ?", [isAdmin ? 1 : 0, id]);
  return getUser(id);
}

async function getUserByEmailVerifyToken(token) {
  const [rows] = await mysqlPool.query(
    "SELECT id, email_verify_expires_at FROM users WHERE email_verify_token = ?",
    [token]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, emailVerifyExpiresAt: rows[0].email_verify_expires_at };
}

async function markUserEmailVerified(userId) {
  await mysqlPool.query(
    "UPDATE users SET email_verified = 1, email_verify_token = NULL, email_verify_expires_at = NULL WHERE id = ?",
    [userId]
  );
  return { success: true };
}

// ============ 订单操作 ============

async function getAllOrders() {
  const [rows] = await mysqlPool.query("SELECT * FROM orders ORDER BY id DESC");
  return rows.map(row => ({
    id: row.id, userId: row.user_id, items: row.items ? JSON.parse(row.items) : [],
    totalAmount: row.total_amount, status: row.status, verificationCode: row.verification_code,
    activationCodes: row.activation_codes, orderNumber: row.order_number,
    isActivated: row.is_activated === 1, isArchived: row.is_archived === 1,
    paymentMethod: row.payment_method, paypalOrderId: row.paypal_order_id,
    createdAt: row.created_at, paidAt: row.paid_at
  }));
}

async function getOrder(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM orders WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, userId: row.user_id, items: row.items ? JSON.parse(row.items) : [],
    totalAmount: row.total_amount, status: row.status, verificationCode: row.verification_code,
    activationCodes: row.activation_codes, orderNumber: row.order_number,
    isActivated: row.is_activated === 1, isArchived: row.is_archived === 1,
    paymentMethod: row.payment_method, paypalOrderId: row.paypal_order_id,
    createdAt: row.created_at, paidAt: row.paid_at
  };
}

async function getOrderByNumber(orderNumber) {
  const [rows] = await mysqlPool.query("SELECT * FROM orders WHERE order_number = ?", [orderNumber]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, userId: row.user_id, items: row.items ? JSON.parse(row.items) : [],
    totalAmount: row.total_amount, status: row.status, verificationCode: row.verification_code,
    activationCodes: row.activation_codes, orderNumber: row.order_number,
    isActivated: row.is_activated === 1, isArchived: row.is_archived === 1,
    paymentMethod: row.payment_method, paypalOrderId: row.paypal_order_id,
    createdAt: row.created_at, paidAt: row.paid_at
  };
}

async function createOrder(order) {
  const orderNumber = order.orderNumber || (
    'BL' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) +
    Math.random().toString(36).slice(2, 9).toUpperCase()
  );

  const [result] = await mysqlPool.query(
    `INSERT INTO orders (user_id, total_amount, status, payment_method, order_number, is_archived)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [order.userId, order.totalAmount, order.status || 'pending',
     order.paymentMethod || 'bank_transfer', orderNumber, 0]
  );
  const orderId = result.insertId;

  // 写 order_items
  if (Array.isArray(order.items)) {
    for (const item of order.items) {
      await mysqlPool.query(
        `INSERT INTO order_items (order_id, product_id, product_name, product_short_name, price, quantity, duration_days)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderId, item.productId, item.productName, item.productShortName || '',
         item.price, item.quantity || 1, item.durationDays || 365]
      );
    }
  }

  return { id: orderId, orderNumber };
}

async function updateOrder(id, order) {
  await mysqlPool.query(
    "UPDATE orders SET user_id=?, items=?, total_amount=?, status=?, verification_code=?, activation_codes=?, order_number=?, is_activated=?, is_archived=?, paid_at=? WHERE id=?",
    [order.userId, JSON.stringify(order.items), order.totalAmount, order.status, order.verificationCode,
     order.activationCodes ? JSON.stringify(order.activationCodes) : null, order.orderNumber, order.isActivated ? 1 : 0, order.isArchived ? 1 : 0, order.paidAt, id]
  );
  return getOrder(id);
}

async function deleteOrder(id) {
  await mysqlPool.query("DELETE FROM orders WHERE id = ?", [id]);
  return { success: true };
}

async function getOrdersByUser(userId) {
  const [rows] = await mysqlPool.query("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", [userId]);
  return rows.map(row => ({
    id: row.id, userId: row.user_id, items: row.items ? JSON.parse(row.items) : [],
    totalAmount: row.total_amount, status: row.status, verificationCode: row.verification_code,
    activationCodes: row.activation_codes, orderNumber: row.order_number,
    isActivated: row.is_activated === 1, isArchived: row.is_archived === 1,
    createdAt: row.created_at, paidAt: row.paid_at
  }));
}

// ============ order_items 操作 ============

async function getOrderItems(orderId) {
  const [rows] = await mysqlPool.query(
    "SELECT * FROM order_items WHERE order_id = ? ORDER BY id",
    [orderId]
  );
  return rows.map(r => ({
    id: r.id,
    orderId: r.order_id,
    productId: r.product_id,
    productName: r.product_name,
    productShortName: r.product_short_name,
    price: r.price,
    quantity: r.quantity,
    durationDays: r.duration_days
  }));
}

async function createOrderItem(item) {
  const [result] = await mysqlPool.query(
    `INSERT INTO order_items (order_id, product_id, product_name, product_short_name, price, quantity, duration_days)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [item.orderId, item.productId, item.productName, item.productShortName,
     item.price, item.quantity || 1, item.durationDays]
  );
  return result.insertId;
}

// ============ order_item_codes 操作 ============

async function getOrderItemCodes(orderItemId) {
  const [rows] = await mysqlPool.query(
    "SELECT * FROM order_item_codes WHERE order_item_id = ? ORDER BY id",
    [orderItemId]
  );
  return rows.map(r => ({
    id: r.id,
    orderItemId: r.order_item_id,
    code: r.code,
    isActivated: r.is_activated === 1,
    activatedAt: r.activated_at,
    activatedByUser: r.activated_by_user,
    activatedByMac: r.activated_by_mac
  }));
}

async function findOrderItemCodeByCode(code) {
  const [rows] = await mysqlPool.query(
    `SELECT c.*, i.order_id, i.product_short_name, i.duration_days, o.user_id, o.status
     FROM order_item_codes c
     JOIN order_items i ON i.id = c.order_item_id
     JOIN orders o ON o.id = i.order_id
     WHERE c.code = ?`,
    [code]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    orderItemId: r.order_item_id,
    code: r.code,
    isActivated: r.is_activated === 1,
    activatedAt: r.activated_at,
    activatedByUser: r.activated_by_user,
    activatedByMac: r.activated_by_mac,
    orderId: r.order_id,
    productShortName: r.product_short_name,
    durationDays: r.duration_days,
    orderUserId: r.user_id,
    orderStatus: r.status
  };
}

async function markCodeActivated(codeId, userName, macAddress) {
  await mysqlPool.query(
    `UPDATE order_item_codes
     SET is_activated = 1, activated_at = NOW(), activated_by_user = ?, activated_by_mac = ?
     WHERE id = ?`,
    [userName, macAddress, codeId]
  );
  return { success: true };
}

async function createOrderItemCode({ orderItemId, code }) {
  const [result] = await mysqlPool.query(
    "INSERT INTO order_item_codes (order_item_id, code, is_activated) VALUES (?, ?, 0)",
    [orderItemId, code]
  );
  return result.insertId;
}

// ============ user_software_status 操作 ============

async function getUserSoftwareStatus(userName, softwareShortName) {
  const [rows] = await mysqlPool.query(
    "SELECT * FROM user_software_status WHERE user_name = ? AND software_short_name = ?",
    [userName, softwareShortName]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    userName: r.user_name,
    softwareShortName: r.software_short_name,
    firstRun: r.first_run,
    lastActivatedAt: r.last_activated_at,
    duration: r.duration,
    expireDate: r.expire_date,
    lock: r.lock,
    lastReminderAt: r.last_reminder_at,
    reminderCount: r.reminder_count
  };
}

async function addUserSoftwareInstall(userName, softwareShortName) {
  await mysqlPool.query(
    `INSERT INTO user_software_status (user_name, software_short_name, first_run, \`lock\`)
     VALUES (?, ?, NOW(), 0)
     ON DUPLICATE KEY UPDATE first_run = LEAST(first_run, VALUES(first_run))`,
    [userName, softwareShortName]
  );
  return getUserSoftwareStatus(userName, softwareShortName);
}

async function addUserSoftwareActivation(userName, softwareShortName, durationDays) {
  const existing = await getUserSoftwareStatus(userName, softwareShortName);
  if (!existing) {
    throw new Error('user_software_status not found; call addUserSoftwareInstall first');
  }
  const now = new Date();
  const currentExpire = existing.expireDate ? new Date(existing.expireDate) : null;
  let newExpire;
  let isRenewal = false;
  if (currentExpire && currentExpire.getTime() >= now.getTime()) {
    newExpire = new Date(currentExpire.getTime() + durationDays * 86400000);
    isRenewal = true;
  } else {
    newExpire = new Date(now.getTime() + durationDays * 86400000);
  }
  await mysqlPool.query(
    `UPDATE user_software_status
     SET last_activated_at = NOW(), duration = COALESCE(duration, 0) + ?, expire_date = ?, \`lock\` = 0
     WHERE user_name = ? AND software_short_name = ?`,
    [durationDays, newExpire, userName, softwareShortName]
  );
  return { ...(await getUserSoftwareStatus(userName, softwareShortName)), isRenewal };
}

async function getAllUserSoftwareStatus() {
  const [rows] = await mysqlPool.query("SELECT * FROM user_software_status ORDER BY id DESC");
  return rows.map(r => ({
    id: r.id, userName: r.user_name, softwareShortName: r.software_short_name,
    firstRun: r.first_run, lastActivatedAt: r.last_activated_at,
    duration: r.duration, expireDate: r.expire_date, lock: r.lock,
    lastReminderAt: r.last_reminder_at, reminderCount: r.reminder_count
  }));
}

async function getUserSoftwareStatusByUser(userName) {
  const [rows] = await mysqlPool.query(
    "SELECT * FROM user_software_status WHERE user_name = ? ORDER BY id",
    [userName]
  );
  return rows.map(r => ({
    id: r.id, userName: r.user_name, softwareShortName: r.software_short_name,
    firstRun: r.first_run, lastActivatedAt: r.last_activated_at,
    duration: r.duration, expireDate: r.expire_date, lock: r.lock,
    lastReminderAt: r.last_reminder_at, reminderCount: r.reminder_count
  }));
}

async function lockUserSoftwareStatus(id, lockValue) {
  await mysqlPool.query(
    "UPDATE user_software_status SET `lock` = ? WHERE id = ?",
    [lockValue, id]
  );
  return { success: true };
}

async function findExpiringSoon(daysAhead) {
  const [rows] = await mysqlPool.query(
    `SELECT s.*, u.email
     FROM user_software_status s
     LEFT JOIN users u ON u.username = s.user_name
     WHERE s.expire_date > NOW() AND DATEDIFF(s.expire_date, NOW()) BETWEEN ? - 1 AND ? + 1
       AND (s.last_reminder_at IS NULL OR DATEDIFF(NOW(), s.last_reminder_at) > 14)`,
    [daysAhead, daysAhead]
  );
  return rows.map(r => ({
    id: r.id, userName: r.user_name, softwareShortName: r.software_short_name,
    expireDate: r.expire_date, email: r.email
  }));
}

async function markReminderSent(id) {
  await mysqlPool.query(
    "UPDATE user_software_status SET last_reminder_at = NOW(), reminder_count = reminder_count + 1 WHERE id = ?",
    [id]
  );
  return { success: true };
}

// ============ 激活操作 ============

async function getAllActivations({ limit, offset } = {}) {
  // 修复 I17: 支持分页,避免 1000+ 记录时 N+1 雪崩
  const safeLimit = Math.min(500, Math.max(1, parseInt(limit) || 100));
  const safeOffset = Math.max(0, parseInt(offset) || 0);
  const [rows] = await mysqlPool.query(
    "SELECT * FROM activations ORDER BY id DESC LIMIT ? OFFSET ?",
    [safeLimit, safeOffset]
  );
  return rows.map(row => ({
    id: row.id, userName: row.user_name, organization: row.organization, email: row.email,
    softwareName: row.software_name, macAddress: row.mac_address, installDate: row.install_date,
    activateDate: row.activate_date, expireDate: row.expire_date, activationKey: row.activation_key,
    status: row.status, createdAt: row.created_at
  }));
}

async function getActivation(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM activations WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, userName: row.user_name, organization: row.organization, email: row.email,
    softwareName: row.software_name, macAddress: row.mac_address, installDate: row.install_date,
    activateDate: row.activate_date, expireDate: row.expire_date, activationKey: row.activation_key,
    status: row.status, createdAt: row.created_at
  };
}

async function getActivationByMac(macAddress) {
  const [rows] = await mysqlPool.query("SELECT * FROM activations WHERE mac_address = ?", [macAddress]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, userName: row.user_name, organization: row.organization, email: row.email,
    softwareName: row.software_name, macAddress: row.mac_address, installDate: row.install_date,
    activateDate: row.activate_date, expireDate: row.expire_date, activationKey: row.activation_key,
    status: row.status, createdAt: row.created_at
  };
}

async function getActivationByEmailAndSoftware(email, softwareName) {
  const [rows] = await mysqlPool.query("SELECT * FROM activations WHERE email = ? AND software_name = ?", [email, softwareName]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, userName: row.user_name, organization: row.organization, email: row.email,
    softwareName: row.software_name, macAddress: row.mac_address, installDate: row.install_date,
    activateDate: row.activate_date, expireDate: row.expire_date, activationKey: row.activation_key,
    status: row.status, createdAt: row.created_at
  };
}

// 获取指定MAC和软件名的所有激活记录（可能有多条，取最大值）
async function getActivationsByMacAndSoftware(macAddress, softwareName) {
  const [rows] = await mysqlPool.query(
    "SELECT * FROM activations WHERE mac_address = ? AND software_name = ? ORDER BY id DESC",
    [macAddress, softwareName]
  );
  return rows.map(row => ({
    id: row.id, userName: row.user_name, organization: row.organization, email: row.email,
    softwareName: row.software_name, macAddress: row.mac_address, installDate: row.install_date,
    activateDate: row.activate_date, expireDate: row.expire_date, activationKey: row.activation_key,
    status: row.status, createdAt: row.created_at
  }));
}

async function createActivation(activation) {
  // 生成激活码 — 用 crypto.randomBytes 替代 Math.random(后者 PRNG 可预测,不适合做密钥)
  const activationKey = activation.activationKey
    || 'AK' + crypto.randomBytes(8).toString('hex').toUpperCase();

  // 计算激活日期
  const activateDate = activation.activateDate || new Date().toISOString().split('T')[0];

  // 计算到期日期
  let expireDate = activation.expireDate;
  if (!expireDate && activation.durationDays) {
    const exp = new Date();
    exp.setDate(exp.getDate() + activation.durationDays);
    expireDate = exp.toISOString().split('T')[0];
  }
  expireDate = expireDate || activation.activateDate;

  const [result] = await mysqlPool.query(
    "INSERT INTO activations (user_name, organization, email, software_name, mac_address, install_date, activate_date, expire_date, activation_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [activation.userName, activation.organization, activation.email, activation.softwareName,
     activation.macAddress, activation.installDate, activateDate, expireDate,
     activationKey, activation.status || 'active']
  );

  // 返回完整的激活对象
  return {
    id: result.insertId,
    userName: activation.userName,
    organization: activation.organization,
    email: activation.email,
    softwareName: activation.softwareName,
    macAddress: activation.macAddress,
    installDate: activation.installDate,
    activateDate: activateDate,
    expireDate: expireDate,
    activationKey: activationKey,
    status: activation.status || 'active'
  };
}

async function updateActivation(id, updates) {
  const fields = [];
  const values = [];
  if (updates.userName !== undefined) { fields.push("user_name = ?"); values.push(updates.userName); }
  if (updates.organization !== undefined) { fields.push("organization = ?"); values.push(updates.organization); }
  if (updates.email !== undefined) { fields.push("email = ?"); values.push(updates.email); }
  if (updates.softwareName !== undefined) { fields.push("software_name = ?"); values.push(updates.softwareName); }
  if (updates.macAddress !== undefined) { fields.push("mac_address = ?"); values.push(updates.macAddress); }
  if (updates.installDate !== undefined) { fields.push("install_date = ?"); values.push(updates.installDate); }
  if (updates.activateDate !== undefined) { fields.push("activate_date = ?"); values.push(updates.activateDate); }
  if (updates.expireDate !== undefined) { fields.push("expire_date = ?"); values.push(updates.expireDate); }
  if (updates.activationKey !== undefined) { fields.push("activation_key = ?"); values.push(updates.activationKey); }
  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (fields.length === 0) return;
  values.push(id);
  await mysqlPool.query("UPDATE activations SET " + fields.join(", ") + " WHERE id = ?", values);
  return getActivation(id);
}

async function deleteActivation(id) {
  await mysqlPool.query("DELETE FROM activations WHERE id = ?", [id]);
  return { success: true };
}

// ============ 安装记录操作 ============

function computeRemainingDays(expireDateStr) {
  if (!expireDateStr) return null;
  const d = new Date(expireDateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

async function getAllInstallations() {
  const [rows] = await mysqlPool.query("SELECT * FROM installations ORDER BY id DESC");
  return rows.map(row => {
    const remainingDays = computeRemainingDays(row.expire_date);
    return {
      id: row.id, softwareName: row.software_name, softwareVersion: row.software_version,
      userName: row.user_name, userEmail: row.user_email, organization: row.organization,
      macAddress: row.mac_address, installDate: row.install_date, expireDate: row.expire_date,
      status: row.status, createdAt: row.created_at, remainingDays: remainingDays
    };
  });
}

async function getInstallation(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM installations WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  const remainingDays = computeRemainingDays(row.expire_date);
  return {
    id: row.id, softwareName: row.software_name, softwareVersion: row.software_version,
    userName: row.user_name, userEmail: row.user_email, organization: row.organization,
    macAddress: row.mac_address, installDate: row.install_date, expireDate: row.expire_date,
    status: row.status, createdAt: row.created_at, remainingDays: remainingDays
  };
}

async function getInstallationByMac(macAddress) {
  const [rows] = await mysqlPool.query("SELECT * FROM installations WHERE mac_address = ?", [macAddress]);
  if (rows.length === 0) return null;
  const row = rows[0];
  const remainingDays = computeRemainingDays(row.expire_date);
  return {
    id: row.id, softwareName: row.software_name, softwareVersion: row.software_version,
    userName: row.user_name, userEmail: row.user_email, organization: row.organization,
    macAddress: row.mac_address, installDate: row.install_date, expireDate: row.expire_date,
    status: row.status, createdAt: row.created_at, remainingDays: remainingDays
  };
}

async function getInstallationByEmailAndSoftware(email, softwareName) {
  const [rows] = await mysqlPool.query("SELECT * FROM installations WHERE user_email = ? AND software_name = ?", [email, softwareName]);
  if (rows.length === 0) return null;
  const row = rows[0];
  const remainingDays = computeRemainingDays(row.expire_date);
  return {
    id: row.id, softwareName: row.software_name, softwareVersion: row.software_version,
    userName: row.user_name, userEmail: row.user_email, organization: row.organization,
    macAddress: row.mac_address, installDate: row.install_date, expireDate: row.expire_date,
    status: row.status, createdAt: row.created_at, remainingDays: remainingDays
  };
}

async function getInstallationByMacAndSoftware(macAddress, softwareName) {
  const [rows] = await mysqlPool.query("SELECT * FROM installations WHERE mac_address = ? AND software_name = ?", [macAddress, softwareName]);
  if (rows.length === 0) return null;
  const row = rows[0];
  const remainingDays = computeRemainingDays(row.expire_date);
  return {
    id: row.id, softwareName: row.software_name, softwareVersion: row.software_version,
    userName: row.user_name, userEmail: row.user_email, organization: row.organization,
    macAddress: row.mac_address, installDate: row.install_date, expireDate: row.expire_date,
    status: row.status, createdAt: row.created_at, remainingDays: remainingDays
  };
}

async function createInstallation(installation) {
  // 计算安装日期和到期日期
  const installDate = installation.installDate || new Date().toISOString().split('T')[0];
  let expireDate = installation.expireDate;
  if (!expireDate) {
    // installations 固定30天试用期
    const exp = new Date();
    exp.setDate(exp.getDate() + 30);
    expireDate = exp.toISOString().split('T')[0];
  }

  const [result] = await mysqlPool.query(
    "INSERT INTO installations (software_name, software_short_name, software_version, user_name, user_email, organization, mac_address, install_date, expire_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [installation.softwareName, installation.softwareShortName || '', installation.softwareVersion, installation.userName, installation.userEmail,
     installation.organization, installation.macAddress, installDate, expireDate, installation.status || 'active']
  );

  // 返回完整的安装对象
  return {
    id: result.insertId,
    softwareName: installation.softwareName,
    softwareShortName: installation.softwareShortName || '',
    softwareVersion: installation.softwareVersion,
    userName: installation.userName,
    userEmail: installation.userEmail,
    organization: installation.organization,
    macAddress: installation.macAddress,
    installDate: installDate,
    expireDate: expireDate,
    status: installation.status || 'active'
  };
}

async function updateInstallation(id, updates) {
  const fields = [];
  const values = [];
  if (updates.softwareName !== undefined) { fields.push("software_name = ?"); values.push(updates.softwareName); }
  if (updates.softwareVersion !== undefined) { fields.push("software_version = ?"); values.push(updates.softwareVersion); }
  if (updates.userName !== undefined) { fields.push("user_name = ?"); values.push(updates.userName); }
  if (updates.userEmail !== undefined) { fields.push("user_email = ?"); values.push(updates.userEmail); }
  if (updates.organization !== undefined) { fields.push("organization = ?"); values.push(updates.organization); }
  if (updates.macAddress !== undefined) { fields.push("mac_address = ?"); values.push(updates.macAddress); }
  if (updates.installDate !== undefined) { fields.push("install_date = ?"); values.push(updates.installDate); }
  if (updates.expireDate !== undefined) { fields.push("expire_date = ?"); values.push(updates.expireDate); }
  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (fields.length === 0) return;
  values.push(id);
  await mysqlPool.query("UPDATE installations SET " + fields.join(", ") + " WHERE id = ?", values);
  return getInstallation(id);
}

async function deleteInstallation(id) {
  await mysqlPool.query("DELETE FROM installations WHERE id = ?", [id]);
  return { success: true };
}

// ============ FAQ操作 ============

async function getAllFaqs() {
  const [rows] = await mysqlPool.query("SELECT * FROM faqs ORDER BY sort_order, id");
  return rows.map(row => ({
    id: row.id, question: row.question, answer: row.answer, sortOrder: row.sort_order,
    createdAt: row.created_at, updatedAt: row.updated_at
  }));
}

async function getFaq(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM faqs WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, question: row.question, answer: row.answer, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function createFaq(faq) {
  const [result] = await mysqlPool.query("INSERT INTO faqs (question, answer, sort_order) VALUES (?, ?, ?)", [faq.question, faq.answer, faq.sortOrder || 0]);
  return result.insertId;
}

async function updateFaq(id, faq) {
  await mysqlPool.query("UPDATE faqs SET question=?, answer=?, sort_order=? WHERE id=?", [faq.question, faq.answer, faq.sortOrder || 0, id]);
  return getFaq(id);
}

async function deleteFaq(id) {
  await mysqlPool.query("DELETE FROM faqs WHERE id = ?", [id]);
  return { success: true };
}

// 别名
const getFaqById = getFaq;
const addFaq = createFaq;

// ============ 订阅者操作 ============
// 注: getAllSubscribers/getSubscriber/getSubscriberByEmail/createSubscriber/
//     updateSubscriber/deleteSubscriber 全部为死代码(无 server.js 调用方),
//     server.js /api/subscribers 端点直接用 db.dbQuery + 原生 SQL。
//     全部移除。订阅者表仍由 /api/subscribers + 邮件注册流程使用。

// ============ 工单操作 ============

async function getAllSupportTickets() {
  const [rows] = await mysqlPool.query("SELECT * FROM support_tickets ORDER BY id DESC");
  return rows.map(row => ({
    id: row.id, subject: row.subject, description: row.description, userName: row.user_name,
    userEmail: row.user_email, userPhone: row.user_phone, status: row.status, priority: row.priority,
    replies: row.replies ? JSON.parse(row.replies) : [], createdAt: row.created_at, updatedAt: row.updated_at
  }));
}

async function getSupportTicket(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM support_tickets WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, subject: row.subject, description: row.description, userName: row.user_name,
    userEmail: row.user_email, userPhone: row.user_phone, status: row.status, priority: row.priority,
    replies: row.replies ? JSON.parse(row.replies) : [], createdAt: row.created_at, updatedAt: row.updated_at
  };
}

async function createSupportTicket(ticket) {
  const [result] = await mysqlPool.query(
    "INSERT INTO support_tickets (subject, description, user_name, user_email, user_phone, status, priority, replies) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [ticket.subject, ticket.description, ticket.userName, ticket.userEmail, ticket.userPhone, ticket.status || 'open', ticket.priority || 'normal', JSON.stringify(ticket.replies || [])]
  );
  return result.insertId;
}

async function updateSupportTicket(id, updates) {
  const fields = [];
  const values = [];
  if (updates.subject !== undefined) { fields.push("subject = ?"); values.push(updates.subject); }
  if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
  if (updates.userName !== undefined) { fields.push("user_name = ?"); values.push(updates.userName); }
  if (updates.userEmail !== undefined) { fields.push("user_email = ?"); values.push(updates.userEmail); }
  if (updates.userPhone !== undefined) { fields.push("user_phone = ?"); values.push(updates.userPhone); }
  if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
  if (updates.priority !== undefined) { fields.push("priority = ?"); values.push(updates.priority); }
  if (updates.replies !== undefined) { fields.push("replies = ?"); values.push(JSON.stringify(updates.replies)); }
  if (fields.length === 0) return;
  values.push(id);
  await mysqlPool.query("UPDATE support_tickets SET " + fields.join(", ") + " WHERE id = ?", values);
  return getSupportTicket(id);
}

async function deleteSupportTicket(id) {
  await mysqlPool.query("DELETE FROM support_tickets WHERE id = ?", [id]);
  return { success: true };
}

// 别名
const getSupportTicketById = getSupportTicket;

// 添加工单回复
async function addSupportTicketReply(ticketId, reply) {
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return null;
  const replies = ticket.replies || [];
  replies.push(reply);
  await mysqlPool.query("UPDATE support_tickets SET replies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [JSON.stringify(replies), ticketId]);
  return getSupportTicket(ticketId);
}

// 更新工单状态
async function updateSupportTicketStatus(ticketId, status) {
  await mysqlPool.query("UPDATE support_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, ticketId]);
  return getSupportTicket(ticketId);
}

// ============ 日志操作 ============

async function addLoginLog(username, ip, userAgent, status) {
  await mysqlPool.query("INSERT INTO login_logs (username, ip, user_agent, status) VALUES (?, ?, ?, ?)", [username, ip, userAgent, status]);
  return { success: true };
}

async function addOperationLog(username, action, target, details, ip) {
  await mysqlPool.query("INSERT INTO operation_logs (username, action, target, details, ip) VALUES (?, ?, ?, ?, ?)", [username, action, target, details, ip]);
  return { success: true };
}

async function addRegistrationLog(email, ip, userAgent, status) {
  await mysqlPool.query("INSERT INTO registration_logs (email, ip, user_agent, status) VALUES (?, ?, ?, ?)", [email, ip, userAgent, status]);
  return { success: true };
}

async function addActivationLog(macAddress, softwareName, activationKey, status, ip) {
  await mysqlPool.query("INSERT INTO activation_logs (mac_address, software_name, activation_key, status, ip) VALUES (?, ?, ?, ?, ?)", [macAddress, softwareName, activationKey, status, ip]);
  return { success: true };
}

async function getLoginLogs(limit = 100) {
  const [rows] = await mysqlPool.query("SELECT * FROM login_logs ORDER BY created_at DESC LIMIT ?", [parseInt(limit)]);
  return rows.map(row => ({ id: row.id, username: row.username, ip: row.ip, userAgent: row.user_agent, status: row.status, createdAt: row.created_at }));
}

async function getLoginLogsByUsername(username, limit = 20) {
  const [rows] = await mysqlPool.query(
    "SELECT * FROM login_logs WHERE username = ? ORDER BY created_at DESC LIMIT ?",
    [username, parseInt(limit)]
  );
  return rows.map(row => ({ id: row.id, username: row.username, ip: row.ip, userAgent: row.user_agent, status: row.status, createdAt: row.created_at }));
}

async function getOperationLogs(limit = 100) {
  const [rows] = await mysqlPool.query("SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT ?", [parseInt(limit)]);
  return rows.map(row => ({ id: row.id, username: row.username, action: row.action, target: row.target, details: row.details, ip: row.ip, createdAt: row.created_at }));
}

async function getRegistrationLogs(limit = 100) {
  const [rows] = await mysqlPool.query("SELECT * FROM registration_logs ORDER BY created_at DESC LIMIT ?", [parseInt(limit)]);
  return rows.map(row => ({ id: row.id, email: row.email, ip: row.ip, userAgent: row.user_agent, status: row.status, createdAt: row.created_at }));
}

async function getActivationLogs(limit = 100) {
  const [rows] = await mysqlPool.query("SELECT * FROM activation_logs ORDER BY created_at DESC LIMIT ?", [parseInt(limit)]);
  return rows.map(row => ({ id: row.id, macAddress: row.mac_address, softwareName: row.software_name, activationKey: row.activation_key, status: row.status, ip: row.ip, createdAt: row.created_at }));
}

// ============ 遥测操作 ============

async function addTelemetry(data) {
  const { deviceId, appName, appVersion, firstSeen, events, platform, osVersion, clientIp, userAgent } = data;
  const eventsJson = Array.isArray(events) ? JSON.stringify(events) : events;
  await mysqlPool.query(
    "INSERT INTO telemetry (device_id, app_name, app_version, first_seen, events, platform, os_version, client_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [deviceId, appName, appVersion || '', firstSeen ? new Date(firstSeen) : null, eventsJson || '[]', platform || '', osVersion || '', clientIp || '', userAgent || '']
  );
  return { success: true };
}

async function getAllTelemetry(limit = 100, offset = 0) {
  const [rows] = await mysqlPool.query(
    `SELECT t.*,
            uss.expire_date AS enriched_expire_date,
            CASE
              WHEN uss.expire_date IS NULL THEN NULL
              WHEN uss.expire_date > NOW() THEN 0
              ELSE 1
            END AS enriched_is_expired
     FROM telemetry t
     LEFT JOIN activations a
       ON a.mac_address = t.device_id
       AND a.software_name = t.app_name
     LEFT JOIN products p ON p.short_name = t.app_name
     LEFT JOIN user_software_status uss
       ON uss.user_name = a.user_name
       AND uss.software_short_name = p.short_name
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`,
    [parseInt(limit), parseInt(offset)]
  );
  return rows.map(row => ({
    id: row.id,
    deviceId: row.device_id,
    appName: row.app_name,
    appVersion: row.app_version,
    firstSeen: row.first_seen,
    events: row.events ? JSON.parse(row.events) : [],
    platform: row.platform,
    osVersion: row.os_version,
    clientIp: row.client_ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    enrichedExpireDate: row.enriched_expire_date,
    enrichedIsExpired: row.enriched_is_expired
  }));
}

async function getTelemetryCount() {
  const [rows] = await mysqlPool.query("SELECT COUNT(*) as c FROM telemetry");
  return rows[0].c;
}

async function getTelemetryStats() {
  const [aggRows] = await mysqlPool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 ELSE 0 END) AS last24h,
       COUNT(DISTINCT app_name) AS total_software,
       COUNT(DISTINCT device_id) AS total_clients,
       COUNT(DISTINCT client_ip) AS total_ips,
       SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) AS today_records
     FROM telemetry`
  );
  const [byApp] = await mysqlPool.query(
    `SELECT app_name, COUNT(*) as c FROM telemetry GROUP BY app_name ORDER BY c DESC`
  );
  const [byPlatform] = await mysqlPool.query(
    `SELECT platform, COUNT(*) as c FROM telemetry GROUP BY platform ORDER BY c DESC`
  );
  const r = aggRows[0];
  return {
    total: r.total || 0,
    last24h: Number(r.last24h) || 0,
    totalSoftware: r.total_software || 0,
    totalClients: r.total_clients || 0,
    totalIps: r.total_ips || 0,
    todayRecords: Number(r.today_records) || 0,
    byApp,
    byPlatform
  };
}

async function deleteTelemetry(id) {
  await mysqlPool.query("DELETE FROM telemetry WHERE id = ?", [id]);
  return { success: true };
}

async function heartbeatDevice(softwareShortName, macAddress) {
  await mysqlPool.query(
    "UPDATE device_software_expire SET last_heartbeat_at = NOW(), updated_at = NOW() WHERE software_short_name = ? AND mac_address = ?",
    [softwareShortName, macAddress]
  );
  const [rows] = await mysqlPool.query(
    "SELECT * FROM device_software_expire WHERE software_short_name = ? AND mac_address = ? ORDER BY id",
    [softwareShortName, macAddress]
  );
  const now = new Date();
  return rows.map(r => {
    const exp = r.expire_date ? new Date(r.expire_date) : null;
    const isExpired = exp ? exp < now : null;
    const remainingDays = exp ? Math.ceil((exp - now) / 86400000) : null;
    return {
      id: r.id,
      softwareName: r.software_name,
      softwareShortName: r.software_short_name,
      macAddress: r.mac_address,
      isInstalled: !!r.is_installed,
      isActivated: !!r.is_activated,
      installDate: r.install_date,
      registerDate: r.register_date,
      activateDate: r.activate_date,
      lastActivateDate: r.last_activate_date,
      activationDuration: r.activation_duration,
      expireDate: r.expire_date,
      activationKey: r.activation_key,
      userEmail: r.user_email,
      userName: r.user_name,
      organization: r.organization,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastHeartbeatAt: r.last_heartbeat_at,
      isExpired,
      remainingDays
    };
  });
}

async function clearTelemetry() {
  await mysqlPool.query("TRUNCATE TABLE telemetry");
  return { success: true };
}

// ============ 统计操作 ============

async function getStats() {
  const [totalUsers] = await mysqlPool.query("SELECT COUNT(*) as c FROM users");
  const [dailyUsers] = await mysqlPool.query("SELECT COUNT(*) as c FROM users WHERE DATE(created_at) = CURDATE()");
  const [totalInstallations] = await mysqlPool.query("SELECT COUNT(*) as c FROM installations");
  const [totalActivations] = await mysqlPool.query("SELECT COUNT(*) as c FROM activations");
  const [dailyLogins] = await mysqlPool.query("SELECT COUNT(*) as c FROM login_logs WHERE DATE(created_at) = CURDATE()");
  const [dailyOperations] = await mysqlPool.query("SELECT COUNT(*) as c FROM operation_logs WHERE DATE(created_at) = CURDATE()");
  return {
    totalUsers: totalUsers[0].c,
    dailyUsers: dailyUsers[0].c,
    totalInstallations: totalInstallations[0].c,
    totalActivations: totalActivations[0].c,
    dailyLogins: dailyLogins[0].c,
    dailyOperations: dailyOperations[0].c
  };
}

// ============ 数据库管理 ============

function getAllTables() {
  // 注：admin 是历史遗留（merge 后已废弃），sessions 由 express-mysql-session 管理 — 均不纳入导出/复制
  // device_software_expire 是 per-MAC 设备心跳表（由 /api/heartbeat 写入/读取）
  return ['products', 'settings', 'users', 'orders', 'order_items', 'order_item_codes', 'user_software_status',
          'faqs', 'support_tickets', 'activations', 'installations', 'subscribers',
          'login_logs', 'operation_logs', 'registration_logs', 'activation_logs',
          'telemetry', 'product_docs', 'system_settings', 'device_software_expire'];
}

async function getTableCount(tableName) {
  try {
    const allowedTables = getAllTables();
    if (!allowedTables.includes(tableName)) {
      return 0;
    }
    const [rows] = await mysqlPool.query("SELECT COUNT(*) as c FROM `" + tableName + "`");
    return rows[0].c || 0;
  } catch (e) {
    return 0;
  }
}

async function verifyDataIntegrity() {
  const results = [];
  const tables = getAllTables();
  for (const table of tables) {
    const count = await getTableCount(table);
    results.push({ table, count, status: 'ok' });
  }
  return { success: true, results };
}

async function exportData() {
  const tables = getAllTables();
  const data = {};
  for (const table of tables) {
    const [rows] = await mysqlPool.query("SELECT * FROM " + table);
    data[table] = rows;
  }
  return data;
}

async function getSQLiteSchema() {
  return `-- MySQL数据库结构
-- 请使用MySQL客户端连接数据库查看完整结构`;
}

async function getMySQLSchema() {
  // 修复 S14：只返回表名 + 列名（不含类型/索引/默认值），降低 schema 信息泄露
  const [rows] = await mysqlPool.query("SHOW TABLES");
  let schema = "-- MySQL 数据库结构（精简：仅表名+列名）\n\n";
  for (const row of rows) {
    const tableName = Object.values(row)[0];
    const [columns] = await mysqlPool.query(`SHOW COLUMNS FROM \`${tableName}\``);
    schema += `TABLE \`${tableName}\`: ${columns.map(c => `\`${c.Field}\``).join(', ')}\n`;
  }
  return schema;
}

// ============ 缺失的兼容函数 ============

// 系统统计
async function getSystemStats() {
  const [totalUsers] = await mysqlPool.query("SELECT COUNT(*) as c FROM users");
  const [totalOrders] = await mysqlPool.query("SELECT COUNT(*) as c FROM orders");
  const [totalProducts] = await mysqlPool.query("SELECT COUNT(*) as c FROM products");
  const [totalActivations] = await mysqlPool.query("SELECT COUNT(*) as c FROM activations");
  const [todayUsers] = await mysqlPool.query("SELECT COUNT(*) as c FROM users WHERE DATE(created_at) = CURDATE()");
  const [todayOrders] = await mysqlPool.query("SELECT COUNT(*) as c FROM orders WHERE DATE(created_at) = CURDATE()");
  const [todayLogins] = await mysqlPool.query("SELECT COUNT(*) as c FROM login_logs WHERE DATE(created_at) = CURDATE()");
  return {
    totalUsers: totalUsers[0].c,
    totalOrders: totalOrders[0].c,
    totalProducts: totalProducts[0].c,
    totalActivations: totalActivations[0].c,
    todayUsers: todayUsers[0].c,
    todayOrders: todayOrders[0].c,
    todayLogins: todayLogins[0].c
  };
}

// 订单归档
async function archiveExpiredOrders() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateStr = thirtyDaysAgo.toISOString().slice(0, 19).replace('T', ' ');
  await mysqlPool.query("UPDATE orders SET is_archived = 1 WHERE status = 'completed' AND created_at < ?", [dateStr]);
  return { success: true };
}

// 别名函数
async function getOrderById(id) { return getOrder(id); }
async function getUserById(id) { return getUser(id); }
async function addUser(user) { const id = await createUser(user); return id; }
async function getUserByEmail(email) {
  const [rows] = await mysqlPool.query("SELECT * FROM users WHERE email = ?", [email]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, username: row.username, email: row.email, phone: row.phone, realName: row.real_name, company: row.company_name, createdAt: row.created_at };
}

// 订单状态更新
async function updateOrderStatus(id, status, verificationCode, activationCodes) {
  const updates = { status };
  if (verificationCode) updates.verificationCode = verificationCode;
  if (activationCodes) updates.activationCodes = activationCodes;
  // 条件 UPDATE：只在 status 不是 paid/completed 时才更新（防并发）
  const [result] = await mysqlPool.query(
    "UPDATE orders SET status = ?, verification_code = ?, activation_codes = ? WHERE id = ? AND status NOT IN ('paid','completed')",
    [status, verificationCode || null, activationCodes ? JSON.stringify(activationCodes) : null, id]
  );
  if (!result.affectedRows) {
    throw new Error('ORDER_ALREADY_PROCESSED');
  }
  return getOrder(id);
}

// 更新验证码
async function updateOrderVerificationCode(id, code) {
  await mysqlPool.query("UPDATE orders SET verification_code = ? WHERE id = ?", [code, id]);
  return { success: true };
}

// 更新激活码
async function updateOrderActivationCodes(id, codes) {
  await mysqlPool.query("UPDATE orders SET activation_codes = ? WHERE id = ?", [JSON.stringify(codes), id]);
  return { success: true };
}

// Mac地址检查
async function checkMacAddressRegistration(macAddress, softwareName) {
  let sql = "SELECT * FROM activations WHERE mac_address = ?";
  const params = [macAddress];
  if (softwareName) {
    sql += " AND software_name = ?";
    params.push(softwareName);
  }
  const [rows] = await mysqlPool.query(sql, params);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, userName: row.user_name, organization: row.organization, email: row.email,
    softwareName: row.software_name, macAddress: row.mac_address, installDate: row.install_date,
    activateDate: row.activate_date, expireDate: row.expire_date, activationKey: row.activation_key,
    status: row.status, createdAt: row.created_at
  };
}

// 检查激活
async function checkActivation(softwareName, email, macAddress) {
  if (macAddress) {
    const [rows] = await mysqlPool.query("SELECT * FROM activations WHERE mac_address = ?", [macAddress]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id, userName: row.user_name, organization: row.organization, email: row.email,
      softwareName: row.software_name, macAddress: row.mac_address, installDate: row.install_date,
      activateDate: row.activate_date, expireDate: row.expire_date, activationKey: row.activation_key,
      status: row.status, createdAt: row.created_at
    };
  }
  if (email && softwareName) {
    const [rows] = await mysqlPool.query("SELECT * FROM activations WHERE email = ? AND software_name = ?", [email, softwareName]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id, userName: row.user_name, organization: row.organization, email: row.email,
      softwareName: row.software_name, macAddress: row.mac_address, installDate: row.install_date,
      activateDate: row.activate_date, expireDate: row.expire_date, activationKey: row.activation_key,
      status: row.status, createdAt: row.created_at
    };
  }
  return null;
}

// 获取现有安装
async function getExistingInstallation(softwareName, email) {
  const [rows] = await mysqlPool.query("SELECT * FROM installations WHERE software_name = ? AND user_email = ?", [softwareName, email]);
  if (rows.length === 0) return null;
  const row = rows[0];
  const remainingDays = computeRemainingDays(row.expire_date);
  return {
    id: row.id, softwareName: row.software_name, softwareVersion: row.software_version,
    userName: row.user_name, userEmail: row.user_email, organization: row.organization,
    macAddress: row.mac_address, installDate: row.install_date, expireDate: row.expire_date,
    status: row.status, createdAt: row.created_at, remainingDays: remainingDays
  };
}

// 更新激活状态
async function updateActivationStatus(id, status) {
  await mysqlPool.query("UPDATE activations SET status = ? WHERE id = ?", [status, id]);
  return getActivation(id);
}

// 通过激活码查找订单
// 修复 I15: 旧实现 SELECT all 'paid' orders + JSON 解析每行 + N+1
// 新实现:直接查 order_item_codes.code 唯一索引 + JOIN orders。
// O(1) 查找,无需 JSON parse。
async function findOrderByActivationCode(activationKey) {
  if (!activationKey || typeof activationKey !== 'string') return null;
  try {
    const [rows] = await mysqlPool.query(
      `SELECT o.* FROM order_item_codes c
       JOIN order_items i ON c.order_item_id = i.id
       JOIN orders o ON i.order_id = o.id
       WHERE c.code = ? AND o.status = 'paid'
       LIMIT 1`,
      [activationKey]
    );
    if (rows.length === 0) return null;
    const order = rows[0];
    return {
      id: order.id, userId: order.user_id,
      items: order.items ? JSON.parse(order.items) : [],
      totalAmount: order.total_amount, status: order.status,
      verificationCode: order.verification_code, activationCodes: order.activation_codes,
      orderNumber: order.order_number, isActivated: order.is_activated === 1,
      isArchived: order.is_archived === 1, createdAt: order.created_at,
      paidAt: order.paid_at
    };
  } catch (e) {
    console.error('findOrderByActivationCode error:', e);
    return null;
  }
}

// 获取归档订单
async function getArchivedOrders() {
  const [rows] = await mysqlPool.query("SELECT * FROM orders WHERE is_archived = 1 ORDER BY id DESC");
  return rows.map(row => ({
    id: row.id, userId: row.user_id, items: row.items ? JSON.parse(row.items) : [],
    totalAmount: row.total_amount, status: row.status, verificationCode: row.verification_code,
    activationCodes: row.activation_codes, orderNumber: row.order_number,
    isActivated: row.is_activated === 1, isArchived: row.is_archived === 1,
    createdAt: row.created_at, paidAt: row.paid_at
  }));
}

// 获取有效订单
async function getValidOrders() {
  const [rows] = await mysqlPool.query("SELECT * FROM orders WHERE is_archived = 0 ORDER BY id DESC");
  return rows.map(row => ({
    id: row.id, userId: row.user_id, items: row.items ? JSON.parse(row.items) : [],
    totalAmount: row.total_amount, status: row.status, verificationCode: row.verification_code,
    activationCodes: row.activation_codes, orderNumber: row.order_number,
    isActivated: row.is_activated === 1, isArchived: row.is_archived === 1,
    createdAt: row.created_at, paidAt: row.paid_at
  }));
}

// 获取用户订单
async function getOrdersByUserId(userId) {
  return getOrdersByUser(userId);
}

// 添加产品（别名）
async function addProduct(product) {
  return createProduct(product);
}

// ============ 系统设置（key/value 表） ============

async function getAllSystemSettings() {
  const [rows] = await mysqlPool.query('SELECT setting_key, setting_value FROM system_settings');
  const map = {};
  for (const r of rows) map[r.setting_key] = r.setting_value;
  return map;
}

async function getSystemSetting(key) {
  const [rows] = await mysqlPool.query('SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1', [key]);
  return rows.length ? rows[0].setting_value : null;
}

async function setSystemSetting(key, value, username) {
  const [result] = await mysqlPool.query(
    'UPDATE system_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?',
    [value, username || 'system', key]
  );
  return { affectedRows: result.affectedRows };
}

// ============ 产品文档（product_docs） ============

// Admin: list all docs for a product (including drafts)
async function listProductDocsByProduct(productId) {
  const [rows] = await mysqlPool.query(
    'SELECT id, product_id, title, slug, excerpt, sort_order, status, author_username, created_at, updated_at, published_at FROM product_docs WHERE product_id = ? ORDER BY sort_order ASC, id ASC',
    [productId]
  );
  return rows;
}

// Admin: get a single doc by id (any status)
async function getProductDocById(id) {
  const [rows] = await mysqlPool.query('SELECT * FROM product_docs WHERE id = ? LIMIT 1', [id]);
  return rows.length ? rows[0] : null;
}

// Admin: create a new doc (status starts as 'draft')
async function createProductDoc(data) {
  const [result] = await mysqlPool.query(
    `INSERT INTO product_docs (product_id, title, slug, content_html, excerpt, sort_order, status, author_username)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`,
    [
      data.product_id,
      data.title,
      data.slug,
      data.content_html,
      data.excerpt || null,
      data.sort_order || 0,
      data.author_username || null
    ]
  );
  return { insertId: result.insertId, affectedRows: result.affectedRows };
}

// Admin: update content fields (does not change status/published_at)
async function updateProductDoc(id, data) {
  const [result] = await mysqlPool.query(
    `UPDATE product_docs SET title = ?, slug = ?, content_html = ?, excerpt = ?, sort_order = ? WHERE id = ?`,
    [data.title, data.slug, data.content_html, data.excerpt || null, data.sort_order || 0, id]
  );
  return { affectedRows: result.affectedRows };
}

// Admin: hard delete a doc
async function deleteProductDoc(id) {
  const [result] = await mysqlPool.query('DELETE FROM product_docs WHERE id = ?', [id]);
  return { affectedRows: result.affectedRows };
}

// Admin: publish (draft -> published), stamps published_at = NOW()
async function publishProductDoc(id) {
  const [result] = await mysqlPool.query(
    "UPDATE product_docs SET status = 'published', published_at = NOW() WHERE id = ? AND status = 'draft'",
    [id]
  );
  return { affectedRows: result.affectedRows };
}

// Admin: unpublish (any status -> draft), clears published_at
async function unpublishProductDoc(id) {
  const [result] = await mysqlPool.query(
    "UPDATE product_docs SET status = 'draft', published_at = NULL WHERE id = ?",
    [id]
  );
  return { affectedRows: result.affectedRows };
}

// Public: list only published docs for a product, safe fields only (no status, no author)
async function listPublishedProductDocs(productId) {
  const [rows] = await mysqlPool.query(
    "SELECT id, slug, title, excerpt, published_at FROM product_docs WHERE product_id = ? AND status = 'published' ORDER BY sort_order ASC, published_at DESC",
    [productId]
  );
  return rows;
}

// Public: resolve product by short_name and return the published doc (or null)
async function getPublishedProductDoc(productSlug, docSlug) {
  const [rows] = await mysqlPool.query(
    `SELECT d.id, d.slug, d.title, d.content_html, d.excerpt, d.published_at
     FROM product_docs d
     INNER JOIN products p ON p.id = d.product_id
     WHERE p.short_name = ? AND d.slug = ? AND d.status = 'published'
     LIMIT 1`,
    [productSlug, docSlug]
  );
  return rows.length ? rows[0] : null;
}

// === News 模块（公告/公司动态） ===
async function getAllNews() {
  // 草稿 published_at 为 NULL：MySQL 默认 NULL 在 DESC 时排到最后，
  // 管理员编辑草稿时永远找不到。用 COALESCE(published_at, updated_at)
  // 让草稿按最后编辑时间倒序出现在列表顶部。
  const [rows] = await mysqlPool.query(
    'SELECT * FROM news ORDER BY is_pinned DESC, COALESCE(published_at, updated_at) DESC, sort_order DESC, id DESC'
  );
  return rows;
}

async function getNews(id) {
  const [rows] = await mysqlPool.query('SELECT * FROM news WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getNewsBySlug(slug) {
  const [rows] = await mysqlPool.query('SELECT * FROM news WHERE slug = ?', [slug]);
  return rows[0] || null;
}

async function getPublishedNews({ category, page = 1, pageSize = 12 } = {}) {
  const offset = (page - 1) * pageSize;
  let sql = 'SELECT id, title, slug, excerpt, cover_image, category, is_pinned, status, view_count, published_at, sort_order, created_at FROM news WHERE status = ?';
  const params = ['published'];
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY is_pinned DESC, published_at DESC, sort_order DESC, id DESC LIMIT ? OFFSET ?';
  params.push(pageSize, offset);
  const [rows] = await mysqlPool.query(sql, params);
  return rows;
}

async function createNews(data) {
  const { title, slug, excerpt, contentHtml, coverImage, category, isPinned = false, sortOrder = 0 } = data;
  const [result] = await mysqlPool.query(
    'INSERT INTO news (title, slug, excerpt, content_html, cover_image, category, is_pinned, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [title, slug, excerpt, contentHtml, coverImage, category, isPinned ? 1 : 0, sortOrder]
  );
  return { id: result.insertId };
}

async function updateNews(id, data) {
  const { title, slug, excerpt, contentHtml, coverImage, category, isPinned, sortOrder } = data;
  await mysqlPool.query(
    'UPDATE news SET title = ?, slug = ?, excerpt = ?, content_html = ?, cover_image = ?, category = ?, is_pinned = ?, sort_order = ? WHERE id = ?',
    [title, slug, excerpt, contentHtml, coverImage, category, isPinned ? 1 : 0, sortOrder, id]
  );
  return { ok: true };
}

async function deleteNews(id) {
  await mysqlPool.query('DELETE FROM news WHERE id = ?', [id]);
  return { ok: true };
}

async function publishNews(id) {
  // 首次发布设置 published_at = NOW()；已发布则保持原值
  await mysqlPool.query(
    'UPDATE news SET status = ?, published_at = COALESCE(published_at, NOW()) WHERE id = ?',
    ['published', id]
  );
  return { ok: true };
}

async function unpublishNews(id) {
  // 撤稿：status=draft，**保留** published_at
  await mysqlPool.query('UPDATE news SET status = ? WHERE id = ?', ['draft', id]);
  return { ok: true };
}

async function incrementNewsView(id) {
  // 原子自增
  await mysqlPool.query('UPDATE news SET view_count = view_count + 1 WHERE id = ? AND status = ?', [id, 'published']);
  return { ok: true };
}

module.exports = {
  initDatabase,
  getDbConfig,
  withTransaction,
  updateDbConfig,
  query,
  dbQuery,
  runQuery,
  getAllTables,
  getTableCount,
  verifyDataIntegrity,
  verifyLogin,
  getAllProducts,
  getProductsPaginated,
  getProduct,
  getProductByShortName,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductLinks,
  setProductLinks,
  getProductWithLinks,
  addProduct,
  searchProducts,
  getSettings,
  getSmtpConfig,
  updateSettings,
  getAllUsers,
  getUser,
  getUserById,
  getUserByUsername,
  getUserByEmail,
  createUser,
  addUser,
  updateUser,
  deleteUser,
  setUserAdmin,
  getUserByEmailVerifyToken,
  markUserEmailVerified,
  getAllOrders,
  getOrder,
  getOrderById,
  getOrderByNumber,
  createOrder,
  updateOrder,
  updateOrderStatus,
  updateOrderVerificationCode,
  updateOrderActivationCodes,
  deleteOrder,
  getOrdersByUser,
  getOrdersByUserId,
  getOrderItems,
  createOrderItem,
  getOrderItemCodes,
  findOrderItemCodeByCode,
  markCodeActivated,
  createOrderItemCode,
  getUserSoftwareStatus,
  addUserSoftwareInstall,
  addUserSoftwareActivation,
  getAllUserSoftwareStatus,
  getUserSoftwareStatusByUser,
  lockUserSoftwareStatus,
  findExpiringSoon,
  markReminderSent,
  getArchivedOrders,
  getValidOrders,
  getAllActivations,
  getActivation,
  getActivationByMac,
  getActivationByEmailAndSoftware,
  getActivationsByMacAndSoftware,
  createActivation,
  updateActivation,
  updateActivationStatus,
  deleteActivation,
  checkActivation,
  findOrderByActivationCode,
  getAllInstallations,
  getInstallation,
  getInstallationById: getInstallation,
  getInstallationByMac,
  getInstallationByMacAndSoftware,
  getInstallationByEmailAndSoftware,
  getExistingInstallation,
  createInstallation,
  updateInstallation,
  deleteInstallation,
  getAllFaqs,
  getFaq,
  getFaqById,
  addFaq,
  createFaq,
  updateFaq,
  deleteFaq,
  getAllSupportTickets,
  getSupportTicket,
  getSupportTicketById,
  createSupportTicket,
  updateSupportTicket,
  updateSupportTicketStatus,
  deleteSupportTicket,
  addSupportTicketReply,
  addLoginLog,
  addOperationLog,
  addRegistrationLog,
  addActivationLog,
  getLoginLogs,
  getLoginLogsByUsername,
  getOperationLogs,
  getRegistrationLogs,
  getActivationLogs,
  addTelemetry,
  getAllTelemetry,
  getTelemetryCount,
  getTelemetryStats,
  deleteTelemetry,
  clearTelemetry,
  getDeviceSoftwareExpire: heartbeatDevice,
  heartbeatDevice,
  getStats,
  getSystemStats,
  archiveExpiredOrders,
  checkMacAddressRegistration,
  exportData,
  getSQLiteSchema,
  getMySQLSchema,
  getAllSystemSettings,
  getSystemSetting,
  setSystemSetting,
  listProductDocsByProduct,
  getProductDocById,
  createProductDoc,
  updateProductDoc,
  deleteProductDoc,
  publishProductDoc,
  unpublishProductDoc,
  listPublishedProductDocs,
  getPublishedProductDoc,
  // News（公告/公司动态）
  getAllNews,
  getNews,
  getNewsBySlug,
  getPublishedNews,
  createNews,
  updateNews,
  deleteNews,
  publishNews,
  unpublishNews,
  incrementNewsView
};
