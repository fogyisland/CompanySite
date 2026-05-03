const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'db-config.json');
const SALT_ROUNDS = 10;

let mysqlPool = null;

function getDbConfig() {
  const configFile = path.join(DATA_DIR, 'db-config.json');
  if (fs.existsSync(configFile)) {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {}
  }
  return {
    type: 'mysql',
    mysql: { host: 'localhost', port: 3306, user: 'root', password: '', database: 'softvault' }
  };
}

function updateDbConfig(newConfig) {
  const configFile = path.join(DATA_DIR, 'db-config.json');
  fs.writeFileSync(configFile, JSON.stringify(newConfig, null, 2), 'utf8');
  return newConfig;
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
    queueLimit: 0
  });
  const connection = await mysqlPool.getConnection();
  connection.release();
  console.log('MySQL连接成功');
  return true;
}

async function createTablesIfNotExist() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS admin (
      id INT PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS products (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
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
      realName VARCHAR(255),
      company VARCHAR(255),
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
    `CREATE TABLE IF NOT EXISTS used_activation_codes (
      id INT PRIMARY KEY AUTO_INCREMENT,
      activation_code VARCHAR(255) NOT NULL UNIQUE,
      order_id INT,
      used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS verification_codes (
      id INT PRIMARY KEY AUTO_INCREMENT,
      code VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      used INT DEFAULT 0
    )`,
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
}

async function initDefaultData() {
  const [adminRows] = await mysqlPool.query('SELECT COUNT(*) as c FROM admin');
  if (adminRows[0].c === 0) {
    const hash = await bcrypt.hash('Fog909217', SALT_ROUNDS);
    await mysqlPool.query("INSERT INTO admin (id, username, password) VALUES (1, 'admin', ?)", [hash]);
  }

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

// ============ 管理员操作 ============

function getAdmin() {
  return mysqlPool.query("SELECT * FROM admin WHERE id = 1")
    .then(([rows]) => {
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        username: row.username,
        password: row.password,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    })
    .catch(() => null);
}

async function updateAdmin(updates) {
  const fields = [];
  const values = [];
  if (updates.username) { fields.push("username = ?"); values.push(updates.username); }
  if (updates.password) {
    // 如果密码是明文（不是hash格式），则加密
    const hash = updates.password.startsWith('$2') ? updates.password : await bcrypt.hash(updates.password, SALT_ROUNDS);
    fields.push("password = ?"); values.push(hash);
  }
  fields.push("updated_at = ?");
  values.push(new Date().toISOString().slice(0,19).replace('T',' '));
  values.push(1);
  await mysqlPool.query("UPDATE admin SET " + fields.join(", ") + " WHERE id = ?", values);
  return getAdmin();
}

async function verifyAdmin(username, password) {
  const [rows] = await mysqlPool.query("SELECT * FROM admin WHERE username = ?", [username]);
  if (rows.length === 0) return false;
  const hash = rows[0].password;
  return bcrypt.compare(password, hash);
}

async function verifyUser(username, password) {
  const [rows] = await mysqlPool.query("SELECT * FROM users WHERE username = ?", [username]);
  if (rows.length === 0) return null;
  const hash = rows[0].password;
  const match = await bcrypt.compare(password, hash);
  if (!match) return null;
  const user = rows[0];
  return { id: user.id, username: user.username, email: user.email, phone: user.phone, realName: user.realName, company: user.company, createdAt: user.created_at };
}

// ============ 产品操作 ============

async function getAllProducts() {
  const [rows] = await mysqlPool.query("SELECT * FROM products ORDER BY id DESC");
  return rows.map(row => ({
    id: row.id,
    name: row.name,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function getProduct(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM products WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createProduct(product) {
  const [result] = await mysqlPool.query(
    `INSERT INTO products (name, category, price, pricing_tiers, description, version, platform, features, icon, featured, download_url, external_link, detail_page, image, image_dark_bg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [product.name, product.category, product.price, JSON.stringify(product.pricingTiers), product.description,
     product.version, product.platform, JSON.stringify(product.features), product.icon, product.featured ? 1 : 0,
     product.downloadUrl, product.externalLink ? 1 : 0, product.detailPage, product.image, product.imageDarkBg ? 1 : 0]
  );
  return result.insertId;
}

async function updateProduct(id, product) {
  await mysqlPool.query(
    `UPDATE products SET name=?, category=?, price=?, pricing_tiers=?, description=?, version=?, platform=?, features=?, icon=?, featured=?, download_url=?, external_link=?, detail_page=?, image=?, image_dark_bg=? WHERE id=?`,
    [product.name, product.category, product.price, JSON.stringify(product.pricingTiers), product.description,
     product.version, product.platform, JSON.stringify(product.features), product.icon, product.featured ? 1 : 0,
     product.downloadUrl, product.externalLink ? 1 : 0, product.detailPage, product.image, product.imageDarkBg ? 1 : 0, id]
  );
  return getProduct(id);
}

async function deleteProduct(id) {
  await mysqlPool.query("DELETE FROM products WHERE id = ?", [id]);
  return { success: true };
}

async function searchProducts(keyword) {
  const [rows] = await mysqlPool.query("SELECT * FROM products WHERE name LIKE ? OR description LIKE ? ORDER BY id DESC", [`%${keyword}%`, `%${keyword}%`]);
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
    id: row.id, username: row.username, password: row.password, email: row.email,
    phone: row.phone, realName: row.realName, company: row.company, createdAt: row.created_at
  }));
}

async function getUser(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM users WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, username: row.username, password: row.password, email: row.email, phone: row.phone, realName: row.realName, company: row.company, createdAt: row.created_at };
}

async function getUserByUsername(username) {
  const [rows] = await mysqlPool.query("SELECT * FROM users WHERE username = ?", [username]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, username: row.username, password: row.password, email: row.email, phone: row.phone, realName: row.realName, company: row.company, createdAt: row.created_at };
}

async function createUser(user) {
  const hash = await bcrypt.hash(user.password, SALT_ROUNDS);
  const [result] = await mysqlPool.query(
    "INSERT INTO users (username, password, email, phone, realName, company) VALUES (?, ?, ?, ?, ?, ?)",
    [user.username, hash, user.email, user.phone, user.realName, user.company]
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
    "UPDATE users SET username=?, password=?, email=?, phone=?, realName=?, company=? WHERE id=?",
    [user.username, hash, user.email, user.phone, user.realName, user.company, id]
  );
  return getUser(id);
}

async function deleteUser(id) {
  await mysqlPool.query("DELETE FROM users WHERE id = ?", [id]);
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
    createdAt: row.created_at, paidAt: row.paid_at
  };
}

async function createOrder(order) {
  const [result] = await mysqlPool.query(
    "INSERT INTO orders (user_id, items, total_amount, status, verification_code, activation_codes, order_number, is_activated, is_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [order.userId, JSON.stringify(order.items), order.totalAmount, order.status || 'pending',
     order.verificationCode, order.activationCodes ? JSON.stringify(order.activationCodes) : null, order.orderNumber, order.isActivated ? 1 : 0, order.isArchived ? 1 : 0]
  );
  // 返回完整订单信息
  return {
    id: result.insertId,
    orderNumber: order.orderNumber,
    items: order.items,
    totalAmount: order.totalAmount,
    status: order.status || 'pending'
  };
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

// ============ 激活码操作 ============

async function getActivationCode(code) {
  const [rows] = await mysqlPool.query("SELECT * FROM used_activation_codes WHERE activation_code = ?", [code]);
  return rows.length > 0 ? rows[0] : null;
}

async function markActivationCodeUsed(code, orderId) {
  await mysqlPool.query("INSERT INTO used_activation_codes (activation_code, order_id) VALUES (?, ?)", [code, orderId]);
  return { success: true };
}

// ============ 激活操作 ============

async function getAllActivations() {
  const [rows] = await mysqlPool.query("SELECT * FROM activations ORDER BY id DESC");
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

async function createActivation(activation) {
  // 生成激活码
  const activationKey = activation.activationKey || 'AK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 6).toUpperCase();

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

async function getAllInstallations() {
  const [rows] = await mysqlPool.query("SELECT * FROM installations ORDER BY id DESC");
  return rows.map(row => {
    const expireDate = new Date(row.expire_date);
    const remainingDays = Math.ceil((expireDate - new Date()) / (24 * 60 * 60 * 1000));
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
  const expireDate = new Date(row.expire_date);
  const remainingDays = Math.ceil((expireDate - new Date()) / (24 * 60 * 60 * 1000));
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
  return {
    id: row.id, softwareName: row.software_name, softwareVersion: row.software_version,
    userName: row.user_name, userEmail: row.user_email, organization: row.organization,
    macAddress: row.mac_address, installDate: row.install_date, expireDate: row.expire_date,
    status: row.status, createdAt: row.created_at
  };
}

async function getInstallationByEmailAndSoftware(email, softwareName) {
  const [rows] = await mysqlPool.query("SELECT * FROM installations WHERE user_email = ? AND software_name = ?", [email, softwareName]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, softwareName: row.software_name, softwareVersion: row.software_version,
    userName: row.user_name, userEmail: row.user_email, organization: row.organization,
    macAddress: row.mac_address, installDate: row.install_date, expireDate: row.expire_date,
    status: row.status, createdAt: row.created_at
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
    "INSERT INTO installations (software_name, software_version, user_name, user_email, organization, mac_address, install_date, expire_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [installation.softwareName, installation.softwareVersion, installation.userName, installation.userEmail,
     installation.organization, installation.macAddress, installDate, expireDate, installation.status || 'active']
  );

  // 返回完整的安装对象
  return {
    id: result.insertId,
    softwareName: installation.softwareName,
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

async function getAllSubscribers() {
  const [rows] = await mysqlPool.query("SELECT * FROM subscribers ORDER BY id DESC");
  return rows.map(row => ({ id: row.id, email: row.email, subscribed: row.subscribed === 1, createdAt: row.created_at }));
}

async function getSubscriber(id) {
  const [rows] = await mysqlPool.query("SELECT * FROM subscribers WHERE id = ?", [id]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, email: row.email, subscribed: row.subscribed === 1, createdAt: row.created_at };
}

async function getSubscriberByEmail(email) {
  const [rows] = await mysqlPool.query("SELECT * FROM subscribers WHERE email = ?", [email]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, email: row.email, subscribed: row.subscribed === 1, createdAt: row.created_at };
}

async function createSubscriber(subscriber) {
  const [result] = await mysqlPool.query("INSERT INTO subscribers (email, subscribed) VALUES (?, ?)", [subscriber.email, subscriber.subscribed !== false ? 1 : 0]);
  return result.insertId;
}

async function updateSubscriber(id, subscriber) {
  await mysqlPool.query("UPDATE subscribers SET email=?, subscribed=? WHERE id=?", [subscriber.email, subscriber.subscribed ? 1 : 0, id]);
  return getSubscriber(id);
}

async function deleteSubscriber(id) {
  await mysqlPool.query("DELETE FROM subscribers WHERE id = ?", [id]);
  return { success: true };
}

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
  const [rows] = await mysqlPool.query("SELECT * FROM telemetry ORDER BY created_at DESC LIMIT ? OFFSET ?", [parseInt(limit), parseInt(offset)]);
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
    createdAt: row.created_at
  }));
}

async function getTelemetryCount() {
  const [rows] = await mysqlPool.query("SELECT COUNT(*) as c FROM telemetry");
  return rows[0].c;
}

async function getTelemetryStats() {
  const [total] = await mysqlPool.query("SELECT COUNT(*) as c FROM telemetry");
  const [byApp] = await mysqlPool.query("SELECT app_name, COUNT(*) as c FROM telemetry GROUP BY app_name ORDER BY c DESC");
  const [byPlatform] = await mysqlPool.query("SELECT platform, COUNT(*) as c FROM telemetry GROUP BY platform ORDER BY c DESC");
  const [recent] = await mysqlPool.query("SELECT COUNT(*) as c FROM telemetry WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)");
  return {
    total: total[0].c,
    last24h: recent[0].c,
    byApp: byApp,
    byPlatform: byPlatform
  };
}

async function deleteTelemetry(id) {
  await mysqlPool.query("DELETE FROM telemetry WHERE id = ?", [id]);
  return { success: true };
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

// ============ 验证码操作 ============

async function createVerificationCode(code) {
  await mysqlPool.query("INSERT INTO verification_codes (code) VALUES (?)", [code]);
  return { success: true };
}

async function getVerificationCode(code) {
  const [rows] = await mysqlPool.query("SELECT * FROM verification_codes WHERE code = ? AND used = 0", [code]);
  return rows.length > 0 ? rows[0] : null;
}

async function useVerificationCode(code) {
  await mysqlPool.query("UPDATE verification_codes SET used = 1 WHERE code = ?", [code]);
  return { success: true };
}

// ============ 数据库管理 ============

function getAllTables() {
  return ['admin', 'products', 'settings', 'users', 'orders', 'verification_codes', 'faqs', 'support_tickets', 'activations', 'installations', 'used_activation_codes', 'subscribers'];
}

async function getTableCount(tableName) {
  try {
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
  const [rows] = await mysqlPool.query("SHOW TABLES");
  let schema = "-- MySQL 数据库结构\n\n";
  for (const row of rows) {
    const tableName = Object.values(row)[0];
    const [columns] = await mysqlPool.query(`SHOW FULL COLUMNS FROM \`${tableName}\``);
    schema += `CREATE TABLE \`${tableName}\` (\n`;
    const colDefs = columns.map(col => `  \`${col.Field}\` ${col.Type}${col.Null === 'NO' ? ' NOT NULL' : ''}${col.Extra ? ' ' + col.Extra : ''}${col.Default ? ' DEFAULT ' + col.Default : ''}`);
    schema += colDefs.join(',\n') + '\n);\n\n';
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
  return { id: row.id, username: row.username, password: row.password, email: row.email, phone: row.phone, realName: row.realName, company: row.company, createdAt: row.created_at };
}

// 订单状态更新
async function updateOrderStatus(id, status, verificationCode, activationCodes) {
  const updates = { status };
  if (verificationCode) updates.verificationCode = verificationCode;
  if (activationCodes) updates.activationCodes = activationCodes;
  await mysqlPool.query("UPDATE orders SET status = ?, verification_code = ?, activation_codes = ? WHERE id = ?", [status, verificationCode || null, activationCodes ? JSON.stringify(activationCodes) : null, id]);
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

// 激活订单
async function activateOrder(orderId, activationCode) {
  await mysqlPool.query("UPDATE orders SET is_activated = 1, status = 'completed' WHERE id = ?", [orderId]);
  await markActivationCodeUsed(activationCode, orderId);
  return { success: true };
}

// 激活码检查
async function isActivationCodeUsed(code) {
  const [rows] = await mysqlPool.query("SELECT * FROM used_activation_codes WHERE activation_code = ?", [code]);
  return rows.length > 0;
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
  const expireDate = new Date(row.expire_date);
  const remainingDays = Math.ceil((expireDate - new Date()) / (24 * 60 * 60 * 1000));
  return {
    id: row.id, softwareName: row.software_name, softwareVersion: row.software_version,
    userName: row.user_name, userEmail: row.user_email, organization: row.organization,
    macAddress: row.mac_address, installDate: row.install_date, expireDate: row.expire_date,
    status: row.status, createdAt: row.created_at, remainingDays: remainingDays
  };
}

// 检查安装
async function checkInstallation(softwareName, userEmail) {
  const [rows] = await mysqlPool.query("SELECT * FROM installations WHERE software_name = ? AND user_email = ?", [softwareName, userEmail]);
  if (rows.length === 0) return null;
  const row = rows[0];
  const expireDate = new Date(row.expire_date);
  const remainingDays = Math.ceil((expireDate - new Date()) / (24 * 60 * 60 * 1000));
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
async function findOrderByActivationCode(activationKey) {
  const [rows] = await mysqlPool.query("SELECT * FROM orders WHERE activation_codes LIKE ?", [`%${activationKey}%`]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, userId: row.user_id, items: row.items ? JSON.parse(row.items) : [],
    totalAmount: row.total_amount, status: row.status, verificationCode: row.verification_code,
    activationCodes: row.activation_codes, orderNumber: row.order_number,
    isActivated: row.is_activated === 1, isArchived: row.is_archived === 1,
    createdAt: row.created_at, paidAt: row.paid_at
  };
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

// 生成验证码
function generateVerificationCode() {
  return 'VC' + Date.now() + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// 验证验证码
async function verifyCode(code) {
  const result = await getVerificationCode(code);
  return result !== null;
}

// 添加产品（别名）
async function addProduct(product) {
  return createProduct(product);
}

module.exports = {
  initDatabase,
  getDbConfig,
  updateDbConfig,
  query,
  dbQuery,
  runQuery,
  getAllTables,
  getTableCount,
  verifyDataIntegrity,
  getAdmin,
  updateAdmin,
  verifyAdmin,
  verifyUser,
  getAllProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
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
  getAllOrders,
  getOrder,
  getOrderById,
  getOrderByNumber,
  createOrder,
  updateOrder,
  updateOrderStatus,
  updateOrderVerificationCode,
  updateOrderActivationCodes,
  activateOrder,
  deleteOrder,
  getOrdersByUser,
  getOrdersByUserId,
  getArchivedOrders,
  getValidOrders,
  getActivationCode,
  markActivationCodeUsed,
  isActivationCodeUsed,
  getAllActivations,
  getActivation,
  getActivationByMac,
  getActivationByEmailAndSoftware,
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
  getInstallationByEmailAndSoftware,
  getExistingInstallation,
  createInstallation,
  updateInstallation,
  checkInstallation,
  deleteInstallation,
  getAllFaqs,
  getFaq,
  getFaqById,
  addFaq,
  createFaq,
  updateFaq,
  deleteFaq,
  getAllSubscribers,
  getSubscriber,
  getSubscriberByEmail,
  createSubscriber,
  updateSubscriber,
  deleteSubscriber,
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
  getOperationLogs,
  getRegistrationLogs,
  getActivationLogs,
  addTelemetry,
  getAllTelemetry,
  getTelemetryCount,
  getTelemetryStats,
  deleteTelemetry,
  clearTelemetry,
  getStats,
  getSystemStats,
  archiveExpiredOrders,
  createVerificationCode,
  getVerificationCode,
  useVerificationCode,
  verifyCode,
  generateVerificationCode,
  checkMacAddressRegistration,
  exportData,
  getSQLiteSchema,
  getMySQLSchema
};
