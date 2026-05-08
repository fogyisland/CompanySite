require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const svgCaptcha = require('svg-captcha');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Session 版本控制 - 服务器重启后使所有 session 失效
const SESSION_VERSION_FILE = path.join(__dirname, 'data', 'session.version');
let currentSessionVersion = Date.now().toString(36);

// 写入新的 session 版本
fs.writeFileSync(SESSION_VERSION_FILE, currentSessionVersion);

// Session 版本检查中间件
function sessionVersionCheck(req, res, next) {
  if (req.session && req.session.sessionVersion !== currentSessionVersion) {
    // Session 版本不匹配，清除 session
    req.session.destroy();
  }
  next();
}

// 日志目录
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 安全配置 - 默认值（可在后台设置）
let securityConfig = {
  maxAttempts: 100,           // 触发封禁的尝试次数
  criticalAttempts: 1000,     // 触发严重警告的尝试次数
  attemptWindow: 60 * 60 * 1000,    // 1小时窗口
  lockoutDuration: 60 * 60 * 1000,  // 封禁时长 1小时
  suspiciousDuration: 24 * 60 * 60 * 1000,  // 可疑记录保留 24小时
  // API 限流配置
  apiRateLimit: {
    enabled: true,            // 是否启用
    windowMs: 1000,           // 时间窗口（毫秒）
    maxRequests: 100,         // 窗口内最大请求数
    blockDuration: 60000,     // 超过阈值后封禁时长（毫秒）
    whitelist: []             // IP白名单
  }
};

// 防暴力破解 - 登录限制
const loginAttempts = new Map(); // { ip: { count, lastAttempt, lockedUntil, records[] } }
const blockedIPs = new Map();    // { ip: { until, reason } }

// API 限流
const apiRateLimitMap = new Map(); // { ip: { count, resetTime } }
const apiBlockedIPs = new Map();    // { ip: { until, reason } }

// 获取客户端IP
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         'unknown';
}

// API 限流检查
function checkApiRateLimit(req, res, next) {
  const config = securityConfig.apiRateLimit;
  if (!config.enabled) return next();

  const ip = getClientIp(req);

  // 检查白名单
  if (config.whitelist.includes(ip)) return next();

  // 检查是否已被限流封禁
  const blocked = apiBlockedIPs.get(ip);
  if (blocked) {
    if (blocked.until > Date.now()) {
      const remaining = Math.ceil((blocked.until - Date.now()) / 1000);
      return res.status(429).json({
        error: '请求过于频繁，请稍后再试',
        retryAfter: remaining
      });
    } else {
      apiBlockedIPs.delete(ip);
    }
  }

  const now = Date.now();
  const record = apiRateLimitMap.get(ip);

  if (!record || now > record.resetTime) {
    // 新记录或已过期，重置
    apiRateLimitMap.set(ip, {
      count: 1,
      resetTime: now + config.windowMs
    });
    return next();
  }

  record.count++;
  apiRateLimitMap.set(ip, record);

  if (record.count > config.maxRequests) {
    // 超过阈值，封禁
    apiBlockedIPs.set(ip, {
      until: Date.now() + config.blockDuration,
      reason: `API请求超过阈值(${config.maxRequests}/${config.windowMs}ms)`
    });
    return res.status(429).json({
      error: '请求过于频繁，请稍后再试',
      retryAfter: Math.ceil(config.blockDuration / 1000)
    });
  }

  next();
}

// 发送邮件函数
async function sendEmail(mailOptions) {
  const settings = await db.getSettings();
  const email = settings.smtp;

  if (!email?.host || !email?.user) {
    console.log('邮件未配置，跳过发送');
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: email.host,
      port: email.port,
      secure: email.secure,
      auth: {
        user: email.user,
        pass: email.password
      }
    });

    await transporter.sendMail(mailOptions);
    writeEmailLog('SENT', mailOptions.to, mailOptions.subject);
    return true;
  } catch (error) {
    console.error('邮件发送失败:', error);
    writeEmailLog('FAILED', mailOptions.to, mailOptions.subject, error.message);
    return false;
  }
}

// 写入登录日志
function writeLoginLog(level, ip, username, status, details = '') {
  const now = new Date();
  const timestamp = now.toLocaleString('zh-CN', { hour12: false });
  const logLine = `[${timestamp}] [${level.toUpperCase()}] IP: ${ip} | User: ${username || 'N/A'} | Status: ${status} | ${details}\n`;

  // 根据级别写入不同日志文件
  const dateStr = now.toLocaleString('zh-CN').split(' ')[0].replace(/\//g, '-');
  const logFile = path.join(LOG_DIR, `login-${dateStr}.log`);
  const alertFile = path.join(LOG_DIR, `alert-${dateStr}.log`);

  fs.appendFileSync(logFile, logLine);

  if (level === 'alert' || level === 'critical') {
    fs.appendFileSync(alertFile, logLine);
  }
}

// 写入操作日志
function writeOperationLog(action, username, details = '') {
  const now = new Date();
  const timestamp = now.toLocaleString('zh-CN', { hour12: false });
  const logLine = `[${timestamp}] User: ${username || 'N/A'} | Action: ${action} | ${details}\n`;

  const dateStr = now.toLocaleString('zh-CN').split(' ')[0].replace(/\//g, '-');
  const logFile = path.join(LOG_DIR, `operation-${dateStr}.log`);

  fs.appendFileSync(logFile, logLine);
}

// 写入邮件发送日志
function writeEmailLog(action, username, details = '', success = true) {
  const now = new Date();
  const timestamp = now.toLocaleString('zh-CN', { hour12: false });
  const status = success ? 'SUCCESS' : 'FAILED';
  const logLine = `[${timestamp}] [${status}] User: ${username || 'N/A'} | Action: ${action} | ${details}\n`;

  const dateStr = now.toLocaleString('zh-CN').split(' ')[0].replace(/\//g, '-');
  const logFile = path.join(LOG_DIR, `email-${dateStr}.log`);

  fs.appendFileSync(logFile, logLine);
}

// 写入订单跟踪日志
function writeOrderLog(orderId, action, username, details = '') {
  const now = new Date();
  const timestamp = now.toLocaleString('zh-CN', { hour12: false });
  const logLine = `[${timestamp}] Order: #${orderId} | User: ${username || 'N/A'} | Action: ${action} | ${details}\n`;

  const dateStr = now.toLocaleString('zh-CN').split(' ')[0].replace(/\//g, '-');
  const logFile = path.join(LOG_DIR, `order-${dateStr}.log`);

  fs.appendFileSync(logFile, logLine);
}

// 生成激活码（格式：xxxxx-xxxxx-xxxxx-xxxxx-xxxxx，每段5位，支持数字和字母）
function generateActivationCodes(count = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 避免易混淆字符
  const codes = [];
  const usedCodes = new Set();

  while (codes.length < count) {
    let code = '';
    for (let i = 0; i < 25; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // 添加连字符
    code = code.slice(0,5) + '-' + code.slice(5,10) + '-' + code.slice(10,15) + '-' + code.slice(15,20) + '-' + code.slice(20);

    // 检查是否重复
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      codes.push(code);
    }
  }

  return codes;
}

// 解析授权期限，返回天数
function parseDurationToDays(duration) {
  if (!duration) return 365; // 默认1年

  const durationStr = duration.toLowerCase().trim();

  if (durationStr.includes('永久') || durationStr.includes('终身')) {
    return 365 * 100; // 永久授权设为100年
  }

  // 匹配 "X天"
  const dayMatch = durationStr.match(/(\d+)\s*天/);
  if (dayMatch) return parseInt(dayMatch[1]);

  // 匹配 "X个月"
  const monthMatch = durationStr.match(/(\d+)\s*个月?/);
  if (monthMatch) return parseInt(monthMatch[1]) * 31;

  // 匹配 "X年"
  const yearMatch = durationStr.match(/(\d+)\s*年/);
  if (yearMatch) return parseInt(yearMatch[1]) * 365;

  // 匹配 "X周"
  const weekMatch = durationStr.match(/(\d+)\s*周/);
  if (weekMatch) return parseInt(weekMatch[1]) * 7;

  return 365; // 默认1年
}

// 检查IP是否被封禁
function isIPBlocked(ip) {
  const blocked = blockedIPs.get(ip);
  if (blocked && blocked.until > Date.now()) {
    return { blocked: true, remainingSeconds: Math.ceil((blocked.until - Date.now()) / 1000), reason: blocked.reason };
  }
  // 清理过期记录
  if (blocked && blocked.until <= Date.now()) {
    blockedIPs.delete(ip);
  }
  return { blocked: false };
}

// 封禁IP
function blockIP(ip, duration, reason) {
  blockedIPs.set(ip, {
    until: Date.now() + duration,
    reason: reason,
    blockedAt: new Date().toISOString()
  });
  loginAttempts.delete(ip); // 清除该IP的尝试记录
}

// 检查登录速率限制
function checkLoginRateLimit(ip) {
  // 首先检查是否已被封禁
  const blockStatus = isIPBlocked(ip);
  if (blockStatus.blocked) {
    return { allowed: false, blocked: true, remainingSeconds: blockStatus.remainingSeconds, reason: blockStatus.reason };
  }

  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now, records: [{ time: now, result: 'attempt' }] });
    return { allowed: true, remaining: securityConfig.maxAttempts - 1 };
  }

  // 如果超过窗口时间，重置计数
  if (now - record.lastAttempt > securityConfig.attemptWindow) {
    loginAttempts.set(ip, { count: 1, lastAttempt: now, records: [{ time: now, result: 'attempt' }] });
    return { allowed: true, remaining: securityConfig.maxAttempts - 1 };
  }

  // 在窗口时间内，增加计数
  record.count++;
  record.lastAttempt = now;
  record.records.push({ time: now, result: 'attempt' });

  // 检查是否达到严重警告级别
  if (record.count > securityConfig.criticalAttempts) {
    writeLoginLog('critical', ip, null, 'CRITICAL_THRESHOLD', `Attempts: ${record.count}`);
    return { allowed: false, critical: true, reason: '检测到异常登录行为，您的IP已被记录并提交安全审计' };
  }

  // 检查是否超过封禁阈值
  if (record.count > securityConfig.maxAttempts) {
    blockIP(ip, securityConfig.lockoutDuration, '登录尝试次数过多');
    writeLoginLog('alert', ip, null, 'IP_BLOCKED', `Attempts: ${record.count}, Duration: ${securityConfig.lockoutDuration / 1000}s`);
    return { allowed: false, blocked: true, remainingSeconds: securityConfig.lockoutDuration / 1000, reason: '登录尝试次数过多，已被临时封禁' };
  }

  loginAttempts.set(ip, record);
  return { allowed: true, remaining: securityConfig.maxAttempts - record.count };
}

// 清除登录尝试记录
function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// 获取登录日志
function getLoginLogs(date) {
  const logFile = path.join(LOG_DIR, `login-${date}.log`);
  if (fs.existsSync(logFile)) {
    return fs.readFileSync(logFile, 'utf8');
  }
  return '';
}

// 根据类型获取日志
function getLogsByType(type, date) {
  const logFile = path.join(LOG_DIR, `${type}-${date}.log`);
  if (fs.existsSync(logFile)) {
    return fs.readFileSync(logFile, 'utf8');
  }
  return '';
}

// 获取所有日志文件列表
function getLogFiles() {
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('.log'))
    .sort()
    .reverse();
  return files;
}

// 获取指定类型的所有日志文件
function getLogFilesByType(type) {
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.startsWith(type + '-') && f.endsWith('.log'))
    .sort()
    .reverse();
  return files;
}

// Session配置
app.use(session({
  secret: process.env.SESSION_SECRET || (() => {
  const crypto = require('crypto');
  const secret = crypto.randomBytes(32).toString('hex');
  console.warn('[WARNING] SESSION_SECRET not set, using auto-generated secret. Set SESSION_SECRET env var for production.');
  return secret;
})(),
  resave: true,
  saveUninitialized: true,
  rolling: true,  // 每次请求重置session过期时间
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30天
    httpOnly: true,
    sameSite: 'lax'
  },
  name: 'booming.sid'
}));

// Session 版本检查 - 服务器重启后使旧 session 失效
app.use((req, res, next) => {
  // 如果 session 存在但版本不匹配，清除它
  if (req.session && req.session.sessionVersion && req.session.sessionVersion !== currentSessionVersion) {
    req.session.destroy();
  }
  next();
});

// 中间件
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API 限流中间件
app.use('/api/', checkApiRateLimit);

// 关于我们页面路由
app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

// 文件上传配置 - Logo专用
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'logo' + ext);
  }
});

// Banner上传配置
const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'banner-' + Date.now() + ext);
  }
});

// 产品描述图片上传配置
const productImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads', 'products'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'product-img-' + Date.now() + ext);
  }
});

// 确保产品图片目录存在
const productImageDir = path.join(__dirname, 'public', 'uploads', 'products');
if (!fs.existsSync(productImageDir)) {
  fs.mkdirSync(productImageDir, { recursive: true });
}

const uploadLogo = multer({ storage: logoStorage });
const uploadBanner = multer({ storage: bannerStorage });
const uploadProductImage = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 限制5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传图片文件 (jpeg, jpg, png, gif, webp)'));
    }
  }
});

// 软件文件上传配置
const softwareStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads', 'software'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'software-' + Date.now() + ext);
  }
});

// 确保软件目录存在
const softwareDir = path.join(__dirname, 'public', 'uploads', 'software');
if (!fs.existsSync(softwareDir)) {
  fs.mkdirSync(softwareDir, { recursive: true });
}

const uploadSoftware = multer({
  storage: softwareStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 限制500MB
  fileFilter: (req, file, cb) => {
    // 允许常见的软件文件格式
    const allowedExtensions = /\.(exe|zip|rar|7z|tar|gz|msi|dmg|pkg|deb|rpm|appimage|jar|war|pdf|txt|doc|docx|xls|xlsx)$/i;
    if (allowedExtensions.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式'));
    }
  }
});

// 登录状态检查中间件
function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: '请先登录' });
  } else {
    res.redirect('/login');
  }
}

// 用户登录状态检查中间件
function requireUserAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: '请先登录' });
  } else {
    res.redirect('/user-login');
  }
}

// ============ API路由 - 验证码 ============

// 刷新验证码（生成新的）
app.get('/api/captcha/refresh', (req, res) => {
  const captcha = svgCaptcha.create({
    size: 4,
    ignoreChars: '0o1iIl',
    noise: 2,
    color: true,
    background: '#ffffff',
    width: 120,
    height: 40,
    fontSize: 36
  });
  req.session.captcha = captcha.text.toLowerCase();
  req.session.captchaTime = Date.now();
  res.type('svg');
  res.send(captcha.data);
});

// 生成图形验证码（初始加载）
app.get('/api/captcha', (req, res) => {
  const captcha = svgCaptcha.create({
    size: 4,
    ignoreChars: '0o1iIl',
    noise: 2,
    color: true,
    background: '#ffffff',
    width: 120,
    height: 40,
    fontSize: 36
  });
  req.session.captcha = captcha.text.toLowerCase();
  req.session.captchaTime = Date.now();
  res.type('svg');
  res.send(captcha.data);
});

// 验证验证码
function verifyCaptcha(req, captcha) {
  if (!req.session.captcha) return false;
  if (Date.now() - req.session.captchaTime > 5 * 60 * 1000) return false; // 5分钟过期
  return req.session.captcha === captcha.toLowerCase();
}

// HTML转义函数，防止XSS
function escapeHtml(text) {
  if (text == null) return '';
  const str = String(text);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============ API路由 - 认证 ============

// 管理员登录
app.post('/api/login', async (req, res) => {
  const clientIp = getClientIp(req);

  // 检查是否被锁定或严重警告
  const rateLimit = checkLoginRateLimit(clientIp);

  if (rateLimit.critical) {
    writeLoginLog('critical', clientIp, req.body.username, 'REJECTED', 'Critical threshold exceeded');
    return res.status(429).json({
      error: rateLimit.reason
    });
  }

  if (rateLimit.blocked) {
    writeLoginLog('alert', clientIp, req.body.username, 'BLOCKED', 'IP is temporarily blocked');
    return res.status(429).json({
      error: rateLimit.reason + '，请 ' + Math.ceil(rateLimit.remainingSeconds / 60) + ' 分钟后再试'
    });
  }

  const { username, password, captcha } = req.body;

  // 验证图形验证码
  if (!captcha || !verifyCaptcha(req, captcha)) {
    writeLoginLog('warn', clientIp, username || 'N/A', 'REJECTED', 'Invalid captcha');
    return res.status(400).json({ error: '验证码错误或已过期' });
  }

  if (!username || !password) {
    writeLoginLog('warn', clientIp, username || 'N/A', 'REJECTED', 'Missing credentials');
    db.addLoginLog(username || 'N/A', clientIp, req.headers['user-agent'] || '', 'REJECTED');
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const isValid = await db.verifyAdmin(username, password);
  if (isValid) {
    // 登录成功，清除失败记录
    clearLoginAttempts(clientIp);
    req.session.isAdmin = true;
    req.session.sessionVersion = currentSessionVersion;
    writeLoginLog('info', clientIp, username, 'SUCCESS', 'Admin login successful');
    db.addLoginLog(username, clientIp, req.headers['user-agent'] || '', 'SUCCESS');
    res.json({ success: true });
  } else {
    // 登录失败
    const record = loginAttempts.get(clientIp);
    writeLoginLog('warn', clientIp, username, 'FAILED', `Attempts: ${record ? record.count : 1}`);
    db.addLoginLog(username, clientIp, req.headers['user-agent'] || '', 'FAILED');
    res.status(401).json({
      error: '用户名或密码错误',
      remainingAttempts: rateLimit.remaining > 0 ? rateLimit.remaining : 0
    });
  }
});

// 管理员登出
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 登出（GET 重定向到登录页）
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// 检查登录状态
app.get('/api/check-auth', (req, res) => {
  res.json({
    isAdmin: req.session && req.session.isAdmin === true,
    isUser: req.session && !!req.session.userId
  });
});

// ============ API路由 - 用户 ============

// 用户注册
app.post('/api/user/register', async (req, res) => {
  const { username, password, email, realName, company, phone, captcha } = req.body;
  const clientIp = getClientIp(req);

  // 验证图形验证码
  if (!captcha || !verifyCaptcha(req, captcha)) {
    return res.status(400).json({ error: '验证码错误或已过期' });
  }

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  if (!realName && !company) {
    return res.status(400).json({ error: '姓名或公司名称至少填写一项' });
  }

  // 检查用户名是否已存在
  if (await db.getUserByUsername(username)) {
    await db.addRegistrationLog(username, clientIp, req.headers['user-agent'] || '', 'FAILED:用户名已存在');
    return res.status(400).json({ error: '用户名已存在' });
  }

  // 检查邮箱是否已存在
  if (email && await db.getUserByEmail(email)) {
    await db.addRegistrationLog(username, clientIp, req.headers['user-agent'] || '', 'FAILED:邮箱已被注册');
    return res.status(400).json({ error: '邮箱已被注册' });
  }

  const newUser = await db.addUser({ username, password, email: email || '', realName: realName || '', company: company || '', phone: phone || '' });
  await db.addRegistrationLog(username, clientIp, req.headers['user-agent'] || '', 'SUCCESS');
  res.status(201).json({ success: true, userId: newUser.id });
});

// 用户登录
app.post('/api/user/login', async (req, res) => {
  const clientIp = getClientIp(req);

  // 检查是否被锁定或严重警告
  const rateLimit = checkLoginRateLimit(clientIp);

  if (rateLimit.critical) {
    writeLoginLog('critical', clientIp, req.body.username, 'REJECTED', 'Critical threshold exceeded');
    return res.status(429).json({
      error: rateLimit.reason
    });
  }

  if (rateLimit.blocked) {
    writeLoginLog('alert', clientIp, req.body.username, 'BLOCKED', 'IP is temporarily blocked');
    return res.status(429).json({
      error: rateLimit.reason + '，请 ' + Math.ceil(rateLimit.remainingSeconds / 60) + ' 分钟后再试'
    });
  }

  const { username, password, captcha } = req.body;

  // 验证图形验证码
  if (!captcha || !verifyCaptcha(req, captcha)) {
    return res.status(400).json({ error: '验证码错误或已过期' });
  }

  // 支持用户名或邮箱登录
  let user = await db.verifyUser(username, password);
  if (!user && username.includes('@')) {
    // 如果输入包含@，尝试用邮箱查找用户
    const userByEmail = await db.getUserByEmail(username);
    if (userByEmail) {
      user = await db.verifyUser(userByEmail.username, password);
    }
  }

  if (user) {
    clearLoginAttempts(clientIp);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.sessionVersion = currentSessionVersion;
    writeLoginLog('info', clientIp, username, 'SUCCESS', 'User login successful');
    res.json({ success: true, user });
  } else {
    const record = loginAttempts.get(clientIp);
    writeLoginLog('warn', clientIp, username, 'FAILED', `Attempts: ${record ? record.count : 1}`);
    res.status(401).json({
      error: '用户名或密码错误',
      remainingAttempts: rateLimit.remaining > 0 ? rateLimit.remaining : 0
    });
  }
});

// 用户登出
app.post('/api/user/logout', (req, res) => {
  req.session.userId = null;
  req.session.username = null;
  res.json({ success: true });
});

// 忘记密码 - 发送临时密码
app.post('/api/user/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: '请输入邮箱地址' });
  }

  const user = await db.getUserByEmail(email);
  if (!user) {
    // 为防止邮箱枚举攻击，返回成功
    return res.json({ success: true, message: '如果邮箱存在，临时密码已发送' });
  }

  // 生成8位临时密码
  const tempPassword = Math.random().toString(36).substring(2, 10).toUpperCase() + Math.floor(Math.random() * 10);

  // 更新用户密码
  await db.updateUser(user.id, { password: tempPassword });

  // 发送邮件
  const settings = await db.getSettings();
  const sent = await sendEmail({
    from: settings.smtp?.user || '"博铭科技" <noreply@booming.com>',
    to: email,
    subject: '密码重置 - 博铭科技',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #133c8a;">密码重置</h2>
        <p>您好，${escapeHtml(user.username)}：</p>
        <p>您申请了密码重置，以下是您的新临时密码：</p>
        <div style="background: #f5f5f5; padding: 15px; border-radius: 6px; font-size: 18px; font-weight: bold; text-align: center; margin: 20px 0;">
          ${escapeHtml(tempPassword)}
        </div>
        <p>请使用此临时密码登录后，尽快修改为您的个人密码。</p>
        <p style="color: #d32f2f;">提示：临时密码有效期为24小时。</p>
        <p>如果不是您本人操作，请忽略此邮件。</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">博铭科技</p>
      </div>
    `
  });

  if (sent) {
    writeEmailLog('PASSWORD_RESET', email, '密码重置');
  }

  res.json({ success: true, message: '如果邮箱存在，临时密码已发送' });
});

// 检查用户登录状态
app.get('/api/user/check-auth', (req, res) => {
  res.json({
    isUser: req.session && !!req.session.userId,
    userId: req.session ? req.session.userId : null,
    username: req.session ? req.session.username : null
  });
});

// 获取用户信息
app.get('/api/user/profile', requireUserAuth, async (req, res) => {
  const user = await db.getUserById(req.session.userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  // 不返回密码
  const { password, ...userInfo } = user;
  res.json(userInfo);
});

// 更新用户信息
app.put('/api/user/profile', requireUserAuth, async (req, res) => {
  const { email, phone, password } = req.body;

  const updates = {};
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (password) updates.password = password;

  const updated = await db.updateUser(req.session.userId, updates);
  if (!updated) {
    return res.status(404).json({ error: '用户不存在' });
  }
  // 不返回密码
  const { password: p, ...userInfo } = updated;
  res.json(userInfo);
});

// ============ API路由 - 日志 ============

// 获取登录日志（需登录）
app.get('/api/logs/login', requireAuth, async (req, res) => {
  try {
    const logs = await db.getLoginLogs(200);
    res.json(logs);
  } catch (error) {
    console.error('Error fetching login logs:', error);
    res.status(500).json({ error: '获取登录日志失败' });
  }
});

// 获取操作日志（需登录）
app.get('/api/logs/operation', requireAuth, async (req, res) => {
  try {
    const logs = await db.getOperationLogs(200);
    res.json(logs);
  } catch (error) {
    console.error('Error fetching operation logs:', error);
    res.status(500).json({ error: '获取操作日志失败' });
  }
});

// 获取注册日志（需登录）
app.get('/api/logs/registration', requireAuth, async (req, res) => {
  try {
    const logs = await db.getRegistrationLogs(200);
    res.json(logs);
  } catch (error) {
    console.error('Error fetching registration logs:', error);
    res.status(500).json({ error: '获取注册日志失败' });
  }
});

// 获取激活日志（需登录）
app.get('/api/logs/activation', requireAuth, async (req, res) => {
  try {
    const logs = await db.getActivationLogs(200);
    res.json(logs);
  } catch (error) {
    console.error('Error fetching activation logs:', error);
    res.status(500).json({ error: '获取激活日志失败' });
  }
});

// 获取系统统计（需登录）
app.get('/api/logs/stats', requireAuth, async (req, res) => {
  try {
    const stats = await db.getSystemStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching system stats:', error);
    res.status(500).json({ error: '获取系统统计失败' });
  }
});

// ============ API路由 - 遥测 ============

// 提交遥测数据（公开接口）
app.post('/api/telemetry', async (req, res) => {
  try {
    const { deviceId, appName, appVersion, firstSeen, events, platform, osVersion } = req.body;
    const clientIp = getClientIp(req);

    if (!deviceId || !appName) {
      return res.status(400).json({ error: 'deviceId and appName are required' });
    }

    await db.addTelemetry({
      deviceId,
      appName,
      appVersion,
      firstSeen,
      events: events || [],
      platform,
      osVersion,
      clientIp,
      userAgent: req.headers['user-agent'] || ''
    });

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Telemetry error:', error);
    res.status(500).json({ error: 'Failed to submit telemetry' });
  }
});

// 获取遥测数据列表（需管理员）
app.get('/api/telemetry', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const telemetry = await db.getAllTelemetry(limit, offset);
    const total = await db.getTelemetryCount();
    res.json({ data: telemetry, total, limit, offset });
  } catch (error) {
    console.error('Error fetching telemetry:', error);
    res.status(500).json({ error: '获取遥测数据失败' });
  }
});

// 获取遥测统计（需管理员）
app.get('/api/telemetry/stats', requireAuth, async (req, res) => {
  try {
    const stats = await db.getTelemetryStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching telemetry stats:', error);
    res.status(500).json({ error: '获取遥测统计失败' });
  }
});

// 删除遥测记录（需管理员）
app.delete('/api/telemetry/:id', requireAuth, async (req, res) => {
  try {
    await db.deleteTelemetry(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting telemetry:', error);
    res.status(500).json({ error: '删除遥测记录失败' });
  }
});

// 清空遥测数据（需管理员）
app.delete('/api/telemetry', requireAuth, async (req, res) => {
  try {
    await db.clearTelemetry();
    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing telemetry:', error);
    res.status(500).json({ error: '清空遥测数据失败' });
  }
});

// ============ API路由 - 订单 ============

// 创建订单
app.post('/api/orders', requireUserAuth, async (req, res) => {
  const { items, totalAmount } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: '订单商品不能为空' });
  }

  // 生成订单编号: BL + 年月日时分秒 + 7位随机数
  const now = new Date();
  const dateStr = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const randomPart = Math.random().toString(36).substring(2, 9).toUpperCase();
  const orderNumber = 'BL' + dateStr + randomPart;

  const order = await db.createOrder({
    userId: req.session.userId,
    items: items,
    totalAmount: totalAmount,
    orderNumber: orderNumber
  });

  // 获取用户信息并发送订单确认邮件
  const user = db.getUserById(req.session.userId);
  if (user && user.email) {
    // 异步发送邮件，不阻塞响应
    sendOrderConfirmationEmail(order, user, items).catch(err => {
      console.error('Order email error:', err);
    });
  }

  writeOrderLog(order.id, 'ORDER_CREATED', user?.username || 'unknown', `New order created, amount: ¥${order.totalAmount}`);

  res.status(201).json(order);
});

// 获取用户订单列表
app.get('/api/orders', requireUserAuth, async (req, res) => {
  const orders = await db.getOrdersByUserId(req.session.userId);
  res.json(orders);
});

// 获取所有订单（管理员）
app.get('/api/orders/all', requireAuth, async (req, res) => {
  // 自动归档24小时前未支付的订单
  await db.archiveExpiredOrders();

  const { filter } = req.query;
  let orders;

  if (filter === 'archived') {
    orders = await db.getArchivedOrders();
  } else {
    orders = await db.getValidOrders();
  }

  // 补充用户信息
  const enrichedOrders = await Promise.all(orders.map(async order => {
    const user = order.userId ? await db.getUserById(order.userId) : null;
    return {
      ...order,
      userName: user ? (user.realName || user.username) : null,
      userEmail: user ? user.email : null
    };
  }));
  res.json(enrichedOrders);
});

// 获取订单详情
app.get('/api/orders/:id', requireUserAuth, async (req, res) => {
  const order = await db.getOrderById(req.params.id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }
  // 确保只能查看自己的订单
  if (order.userId !== req.session.userId) {
    return res.status(403).json({ error: '无权访问此订单' });
  }
  res.json(order);
});

// 验证支付验证码
app.post('/api/orders/:id/verify', requireUserAuth, async (req, res) => {
  const { verificationCode } = req.body;
  const order = await db.getOrderById(req.params.id);

  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.userId !== req.session.userId) {
    return res.status(403).json({ error: '无权访问此订单' });
  }

  if (order.status === 'paid') {
    return res.status(400).json({ error: '订单已支付' });
  }

  // 验证验证码 - 直接比对订单中的验证码
  if (order.verificationCode && order.verificationCode === verificationCode) {
    // 生成5组激活码
    const activationCodes = generateActivationCodes(1);

    // 更新订单状态并保存激活码
    const updatedOrder = await db.updateOrderStatus(order.id, 'paid', verificationCode, activationCodes);

    // 获取用户信息和订单商品
    const user = await db.getUserById(req.session.userId);
    const itemsWithDetails = await Promise.all(order.items.map(async item => {
      const product = await db.getProduct(item.productId);
      return { ...item, product };
    }));

    // 发送支付成功邮件（含下载链接和激活码）
    if (user && user.email) {
      sendOrderPaidEmail(updatedOrder, user, itemsWithDetails, activationCodes).catch(err => {
        console.error('Order paid email error:', err);
      });
    }

    writeOrderLog(order.id, 'ORDER_PAID', user?.username || 'unknown', `Order paid and verified, amount: ¥${order.totalAmount}`);

    res.json({
      success: true,
      message: '支付验证成功',
      activationCodes: activationCodes
    });
  } else {
    res.status(400).json({ error: '验证码错误' });
  }
});

// 为订单生成验证码（管理员）
app.post('/api/orders/:id/generate-code', requireAuth, async (req, res) => {
  const order = await db.getOrderById(req.params.id);

  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status === 'paid') {
    return res.status(400).json({ error: '订单已支付' });
  }

  // 生成5位数验证码
  const code = Math.random().toString().slice(2, 7).padStart(5, '0');

  // 保存验证码到订单
  await db.updateOrderVerificationCode(order.id, code);

  // 记录操作日志
  const adminUsername = req.session.userName || req.session.username || 'admin';
  db.addOperationLog(adminUsername, 'ORDER_GENERATE_CODE', String(order.id), `Generated verification code for order #${order.id}`);

  res.json({ success: true, code: code });
});

// 为已支付的订单生成/重新生成授权码（管理员）
app.post('/api/orders/:id/generate-activation-codes', requireAuth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    console.log('Generating activation codes for order:', orderId);

    const order = await db.getOrderById(orderId);
    console.log('Order found:', order ? 'yes' : 'no', 'status:', order?.status);

    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }

    if (order.status !== 'paid') {
      return res.status(400).json({ error: '只有已支付的订单可以生成授权码，当前状态：' + order.status });
    }

    // 生成5组激活码
    const activationCodes = generateActivationCodes(1);
    console.log('Generated codes:', activationCodes);

    // 保存激活码到订单
    const result = await db.updateOrderActivationCodes(order.id, activationCodes);
    console.log('Update result:', result);

    // 记录操作日志
    const adminUsername = req.session.userName || req.session.username || 'admin';
    db.addOperationLog(adminUsername, 'ORDER_GENERATE_CODES', String(order.id), `Generated activation codes for order #${order.id}`);

    res.json({ success: true, activationCodes: activationCodes });
  } catch (error) {
    console.error('generate-activation-codes error:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  }
});

// 获取订单的完整商品信息
app.get('/api/orders/:id/details', requireUserAuth, async (req, res) => {
  const order = await db.getOrderById(req.params.id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.userId !== req.session.userId) {
    return res.status(403).json({ error: '无权访问此订单' });
  }

  // 获取商品详情
  const itemsWithDetails = await Promise.all(order.items.map(async item => {
    const product = await db.getProduct(item.productId);
    return {
      ...item,
      product: product
    };
  }));

  res.json({
    order: order,
    items: itemsWithDetails
  });
});

// ============ API路由 - 软件激活 ============

// 提交软件激活申请（公开接口）
app.post('/api/activate', async (req, res) => {
  try {
    const { userName, organization, email, softwareName, installDate, macAddress, durationDays } = req.body;
    const clientIp = getClientIp(req);

    writeOperationLog('ACTIVATE_REQUEST', `IP: ${clientIp}`, `User: ${userName}, Email: ${email}, Software: ${softwareName}`);

    // 验证必填字段
    if (!userName || !email || !softwareName) {
      return res.status(400).json({ error: '请填写必填字段：姓名、邮箱、软件名称' });
    }

    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }

    // 如果提供了MAC地址，检查是否已激活该软件（一个MAC可以激活多个不同软件）
    if (macAddress) {
      const existing = await db.checkActivation(softwareName, null, macAddress);
      if (existing) {
        return res.status(400).json({
          error: '该MAC地址已激活此软件，如需续期请联系管理员',
          existingActivation: {
            activationKey: existing.activationKey,
            expireDate: existing.expireDate,
            activateDate: existing.activateDate
          }
        });
      }
    }

    const activation = await db.createActivation({
      userName,
      organization,
      email,
      softwareName,
      installDate,
      macAddress,
      durationDays: durationDays || 365 // 默认1年
    });

    // 同时创建/更新安装记录
    const today = new Date();
    const expireDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000); // installation 固定30天试用期
    const existingInstallation = email ? await db.getExistingInstallation(softwareName, email) : null;

    if (existingInstallation && existingInstallation.id) {
      // 更新现有安装记录
      await db.query(
        'UPDATE installations SET mac_address = ?, install_date = ? WHERE id = ?',
        [macAddress || '', today.toISOString().split('T')[0], existingInstallation.id]
      );
    } else {
      // 创建新安装记录
      const newInstallation = await db.createInstallation({
        softwareName,
        softwareVersion: '',
        userName,
        userEmail: email,
        organization: organization || '',
        macAddress: macAddress || ''
      });
      // 安装记录默认30天试用期已由 createInstallation 设置
    }

    // 发送邮件通知管理员
    const settings = await db.getSettings();
    if (settings.adminEmail && settings.smtp?.host) {
      const mailOptions = {
        from: settings.smtp.from || settings.smtp.user,
        to: settings.adminEmail,
        subject: `【软件激活通知】${escapeHtml(softwareName)} - ${escapeHtml(userName)}`,
        html: `
          <h2>新软件激活申请</h2>
          <table style="border-collapse: collapse; width: 100%;">
            <tr style="border-bottom: 1px solid #ddd;">
              <td style="padding: 8px; font-weight: bold;">申请人</td>
              <td style="padding: 8px;">${escapeHtml(userName)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
              <td style="padding: 8px; font-weight: bold;">组织/公司</td>
              <td style="padding: 8px;">${escapeHtml(organization) || '-'}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
              <td style="padding: 8px; font-weight: bold;">邮箱</td>
              <td style="padding: 8px;">${escapeHtml(email)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
              <td style="padding: 8px; font-weight: bold;">软件名称</td>
              <td style="padding: 8px;">${escapeHtml(softwareName)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
              <td style="padding: 8px; font-weight: bold;">MAC地址</td>
              <td style="padding: 8px;">${escapeHtml(macAddress) || '-'}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
              <td style="padding: 8px; font-weight: bold;">安装日期</td>
              <td style="padding: 8px;">${escapeHtml(installDate) || '-'}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
              <td style="padding: 8px; font-weight: bold;">激活日期</td>
              <td style="padding: 8px;">${new Date().toLocaleString('zh-CN')}</td>
            </tr>
            <tr style="border-bottom: 1px solid #ddd;">
              <td style="padding: 8px; font-weight: bold;">到期日期</td>
              <td style="padding: 8px;">${new Date(activation.expireDate).toLocaleDateString('zh-CN')}</td>
            </tr>
            <tr>
              <td style="padding: 8px; font-weight: bold;">激活码</td>
              <td style="padding: 8px; font-family: monospace;">${escapeHtml(activation.activationKey)}</td>
            </tr>
          </table>
        `
      };
      sendEmail(mailOptions);
    }

    // 记录激活日志
    await db.addActivationLog(macAddress, softwareName, activation.activationKey, 'SUCCESS', clientIp);

    res.json({
      success: true,
      message: '激活成功',
      activation: {
        activationKey: activation.activationKey,
        softwareName: activation.softwareName,
        activateDate: activation.activateDate,
        expireDate: activation.expireDate
      }
    });
  } catch (error) {
    console.error('Activation error:', error);
    res.status(500).json({ error: '激活失败，请稍后重试' });
  }
});

// 使用授权码激活（公开接口）
app.post('/api/activate-by-code', async (req, res) => {
  try {
    const { activationCode, serial, macAddress, userName, userEmail, installDate, activateDate } = req.body;
    const code = activationCode || serial; // 支持 activationCode 或 serial 字段
    const clientIp = getClientIp(req);

    writeOperationLog('ACTIVATE_ATTEMPT', code ? `IP: ${clientIp}, Code: ${code.substring(0,4)}***` : 'no code', `Email: ${userEmail || 'N/A'}, Body: ${JSON.stringify(req.body).substring(0, 200)}`);

    if (!code) {
      return res.status(400).json({ error: '请输入授权码' });
    }

    // 查找持有该授权码的已支付订单
    const allOrders = await db.getAllOrders();
    let targetOrder = null;

    writeOperationLog('ACTIVATE_DEBUG', code.substring(0,8), `Total orders: ${allOrders.length}`);

    for (const order of allOrders) {
      let codes = [];
      try {
        codes = order.activationCodes ? JSON.parse(order.activationCodes) : [];
      } catch (e) {
        codes = [];
      }

      writeOperationLog('ACTIVATE_DEBUG', code.substring(0,8), `Order ${order.id}, status: ${order.status}, codes: ${JSON.stringify(codes)}`);

      if (order.status !== 'paid') continue;

      if (codes.includes(code)) {
        targetOrder = order;
        break;
      }
    }

    if (!targetOrder) {
      writeOperationLog('ACTIVATE_FAILED', code.substring(0,8), 'Order not found or code not in order');
      return res.status(404).json({ error: '授权码无效或订单未支付' });
    }

    // 检查授权码是否已被使用
    if (await db.isActivationCodeUsed(code)) {
      return res.status(400).json({ error: '该授权码已被使用' });
    }

    // 获取订单首商品信息
    const items = targetOrder.items || [];
    if (items.length === 0) {
      return res.status(400).json({ error: '订单商品信息错误' });
    }
    const firstItem = items[0];

    // 检查MAC地址是否已被激活该软件（一个MAC可以激活多个不同软件）
    if (macAddress) {
      const existingMac = await db.checkMacAddressRegistration(macAddress, firstItem.name);
      if (existingMac) {
        writeOperationLog('ACTIVATE_FAILED', code.substring(0,8), `MAC ${macAddress} already activated for ${firstItem.name}`);
        return res.status(400).json({
          error: '该MAC地址已激活此软件，如需续期请联系管理员',
          existingActivation: existingMac
        });
      }
    }

    const duration = firstItem.duration || '永久授权';
    const purchasedDays = parseDurationToDays(duration);

    // 获取用户信息
    const user = await db.getUserById(targetOrder.userId);
    const effectiveUserEmail = userEmail || (user ? user.email : '');
    const effectiveUserName = userName || (user ? (user.realName || user.username) : '未知用户');

    // 检查是否有现有安装记录
    const existingInstallation = effectiveUserEmail ? await db.getExistingInstallation(firstItem.name, effectiveUserEmail) : null;
    const today = new Date();
    let expireDate;
    let isRenewal = false;

    // 使用订单中的购买时长计算过期日期
    if (existingInstallation && existingInstallation.expireDate) {
      const currentExpireDate = new Date(existingInstallation.expireDate);
      if (currentExpireDate > today) {
        // 试用期未过：从当前到期日 + 购买时长
        expireDate = new Date(currentExpireDate.getTime() + purchasedDays * 24 * 60 * 60 * 1000);
        isRenewal = true;
      } else {
        // 试用期已过：从今天 + 购买时长
        expireDate = new Date(today.getTime() + purchasedDays * 24 * 60 * 60 * 1000);
      }
    } else {
      // 无现有记录：从今天 + 购买时长
      expireDate = new Date(today.getTime() + purchasedDays * 24 * 60 * 60 * 1000);
    }

    let installation;
    if (existingInstallation && existingInstallation.id) {
      // 更新现有安装记录
      await db.query(
        'UPDATE installations SET expire_date = ?, mac_address = ?, install_date = ? WHERE id = ?',
        [expireDate.toISOString().split('T')[0], macAddress || '', today.toISOString().split('T')[0], existingInstallation.id]
      );
      installation = await db.getInstallationById(existingInstallation.id);
    } else {
      // 创建新安装记录
      installation = await db.createInstallation({
        softwareName: firstItem.name,
        softwareVersion: '',
        userName: effectiveUserName,
        userEmail: effectiveUserEmail,
        organization: user ? (user.company || '') : '',
        macAddress: macAddress || ''
      });

      // 更新安装记录的到期日
      if (installation && installation.id) {
        await db.query(
          'UPDATE installations SET expire_date = ? WHERE id = ?',
          [expireDate.toISOString().split('T')[0], installation.id]
        );
      }
    }

    // 标记订单和授权码为已使用
    await db.activateOrder(targetOrder.id, code);

    // 创建激活记录（供 admin-activations 显示）
    await db.createActivation({
      userName: effectiveUserName,
      organization: user ? (user.company || '') : '',
      email: effectiveUserEmail,
      softwareName: firstItem.name,
      installDate: activateDate || today.toISOString().split('T')[0],
      macAddress: macAddress || '',
      activationKey: code,
      durationDays: purchasedDays
    });

    // 记录激活日志
    await db.addActivationLog(macAddress || '', firstItem.name, code, isRenewal ? 'RENEWAL' : 'SUCCESS', clientIp);

    res.json({
      success: true,
      message: isRenewal ? '续期成功' : '激活成功',
      softwareName: firstItem.name,
      duration: duration,
      totalDays: purchasedDays,
      registrationDate: today.toISOString(),
      activateDate: today.toISOString(),
      expireDate: expireDate.toISOString(),
      isRenewal: isRenewal
    });

    // 写入操作日志
    writeOperationLog('ACTIVATE_BY_CODE', effectiveUserEmail, `Code: ${code}, Software: ${firstItem.name}, Result: ${isRenewal ? '续期' : '激活成功'}`);
  } catch (error) {
    console.error('Activate by code error:', error);
    writeOperationLog('ACTIVATE_BY_CODE_FAILED', 'unknown', error.message);
    res.status(500).json({ error: '激活失败，请稍后重试' });
  }
});

// 获取所有激活记录（管理员）
app.get('/api/activations', requireAuth, async (req, res) => {
  const activations = await db.getAllActivations();

  // 丰富每条激活记录，关联订单信息计算过期日期
  const enrichedActivations = await Promise.all(activations.map(async (activation) => {
    const result = {
      ...activation
    };

    // 如果有激活码，查找对应订单
    if (activation.activationKey) {
      const order = await db.findOrderByActivationCode(activation.activationKey);
      if (order && order.items && order.items.length > 0) {
        const firstItem = order.items[0];
        const duration = firstItem.duration || '永久授权';
        const purchasedDays = parseDurationToDays(duration);
        const paidAt = new Date(order.paidAt || order.createdAt || Date.now());
        const expireDate = new Date(paidAt.getTime() + purchasedDays * 24 * 60 * 60 * 1000);

        result.orderInfo = {
          softwareName: firstItem.name,
          duration: duration,
          totalDays: purchasedDays,
          paidDate: !isNaN(paidAt.getTime()) ? paidAt.toISOString() : null,
          paidAt: order.paidAt,
          expireDate: !isNaN(expireDate.getTime()) ? expireDate.toISOString() : null,
          isExpired: expireDate < new Date(),
          remainingDays: Math.max(0, Math.ceil((expireDate - new Date()) / (24 * 60 * 60 * 1000)))
        };
      }
    }

    return result;
  }));

  res.json(enrichedActivations);
});

// 更新激活状态（管理员）
app.put('/api/activations/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['active', 'inactive', 'blocked'].includes(status)) {
    return res.status(400).json({ error: '无效的状态' });
  }

  const activation = await db.updateActivationStatus(id, status);
  if (!activation) {
    return res.status(404).json({ error: '激活记录不存在' });
  }

  res.json(activation);
});

// 删除激活记录（需登录）
app.delete('/api/activations/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const activation = await db.getActivation(id);
  if (!activation) {
    return res.status(404).json({ error: '激活记录不存在' });
  }
  await db.deleteActivation(id);
  res.json({ success: true });
});

// ============ API路由 - 安装记录 ============

// 提交安装注册（公开）
app.post('/api/install', async (req, res) => {
  const { softwareName, softwareVersion, userName, userEmail, organization, macAddress } = req.body;
  const clientIp = getClientIp(req);

  writeOperationLog('INSTALL_ATTEMPT', `IP: ${clientIp}`, `Software: ${softwareName}, User: ${userEmail}`);

  if (!softwareName || !userName || !userEmail) {
    return res.status(400).json({ error: '请填写必填字段' });
  }

  // 支持简写名称，查询实际产品信息
  let productInfo = null;
  if (softwareName) {
    productInfo = await db.getProductByShortName(softwareName);
    if (!productInfo) {
      // 如果找不到，尝试按名称查找
      productInfo = await db.getProduct(softwareName);
    }
  }
  const actualSoftwareName = productInfo ? productInfo.name : softwareName;
  const softwareShortName = productInfo ? productInfo.shortName : softwareName;

  // 检查MAC地址是否已被注册该软件（一个MAC可以激活多个不同软件）
  if (macAddress) {
    // 检查 activations 表
    const existingMacAct = await db.checkMacAddressRegistration(macAddress, actualSoftwareName);
    if (existingMacAct) {
      return res.status(400).json({
        error: '该MAC地址已激活此软件，如需续期请联系管理员',
        installation: existingMacAct
      });
    }
    // 检查 installations 表（试用注册）
    const macRows = await db.query(
      "SELECT * FROM installations WHERE mac_address = ? AND software_name = ?",
      [macAddress, actualSoftwareName]
    );
    const rows = Array.isArray(macRows) ? macRows : [];
    if (rows.length > 0) {
      const existing = rows[0];
      const expireDate = new Date(existing.expire_date);
      const remainingDays = Math.ceil((expireDate - new Date()) / (24 * 60 * 60 * 1000));
      return res.status(400).json({
        error: '该MAC地址已注册此软件，如需续期请联系管理员',
        installation: {
          id: existing.id,
          softwareName: existing.software_name,
          softwareShortName: softwareShortName,
          macAddress: existing.mac_address,
          installDate: existing.install_date,
          expireDate: existing.expire_date,
          remainingDays: remainingDays
        }
      });
    }
  }

  // 检查是否已存在有效注册（同一软件+邮箱）
  const existing = await db.checkInstallation(actualSoftwareName, userEmail);
  if (existing && existing.remainingDays > 0) {
    return res.status(400).json({
      error: '该软件已注册',
      installation: existing,
      remainingDays: existing.remainingDays
    });
  }

  const installation = await db.createInstallation({
    softwareName: actualSoftwareName,
    softwareShortName: softwareShortName,
    softwareVersion,
    userName,
    userEmail,
    organization,
    macAddress
  });

  // 发送邮件通知管理员
  const settings = await db.getSettings();
  if (settings.adminEmail && settings.smtp?.host) {
    sendEmail({
      from: settings.smtp.from || settings.smtp.user,
      to: settings.adminEmail,
      subject: `【软件安装注册】${escapeHtml(softwareName)} - ${escapeHtml(userName)}`,
      html: `
        <h2>新的软件安装注册</h2>
        <table style="border-collapse: collapse; width: 100%;">
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">软件名称</td>
            <td style="padding: 8px;">${escapeHtml(softwareName)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">版本</td>
            <td style="padding: 8px;">${escapeHtml(softwareVersion) || '-'}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">用户名称</td>
            <td style="padding: 8px;">${escapeHtml(userName)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">邮箱</td>
            <td style="padding: 8px;">${escapeHtml(userEmail)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">组织/公司</td>
            <td style="padding: 8px;">${escapeHtml(organization) || '-'}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">安装日期</td>
            <td style="padding: 8px;">${new Date().toLocaleString('zh-CN')}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold;">到期日期</td>
            <td style="padding: 8px;">${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('zh-CN')}</td>
          </tr>
        </table>
      `
    });
  }

  res.status(201).json({
    success: true,
    installation: {
      id: installation.id,
      softwareName: installation.softwareName,
      installDate: installation.installDate,
      expireDate: installation.expireDate,
      remainingDays: 30
    }
  });
});

// 验证安装注册（公开）
app.post('/api/install/check', async (req, res) => {
  const { softwareName, userEmail, macAddress, activationKey } = req.body;

  // 1. 如果提供了激活码，根据授权码查询订单计算过期日期
  if (activationKey) {
    const order = await db.findOrderByActivationCode(activationKey);
    if (!order) {
      return res.json({
        registered: false,
        activated: false,
        message: '授权码无效或订单未支付'
      });
    }

    // 检查授权码是否已被使用
    const isUsed = await db.isActivationCodeUsed(activationKey);

    // 从订单计算过期日期
    const items = order.items || [];
    const firstItem = items[0] || {};
    const duration = firstItem.duration || '永久授权';
    const purchasedDays = parseDurationToDays(duration);
    const paidAt = new Date(order.paidAt || order.createdAt || Date.now());
    const expireDate = new Date(paidAt.getTime() + purchasedDays * 24 * 60 * 60 * 1000);
    const isExpired = expireDate < new Date();

    return res.json({
      registered: true,
      expired: isExpired,
      activated: isUsed,
      activatedExpired: isUsed ? isExpired : null,
      message: isUsed ? (isExpired ? '已激活但已过期' : '已激活') : '授权码有效，可激活',
      order: {
        softwareName: firstItem.name,
        duration: duration,
        totalDays: purchasedDays,
        paidDate: !isNaN(paidAt.getTime()) ? paidAt.toISOString() : null,
        expireDate: !isNaN(expireDate.getTime()) ? expireDate.toISOString() : null,
        remainingDays: isExpired ? 0 : Math.ceil((expireDate - new Date()) / (24 * 60 * 60 * 1000))
      }
    });
  }

  // 2. 如果提供了MAC地址，检查注册和激活状态
  if (macAddress) {
    // 2.1 检查 activations 表（已授权激活）
    const activationRows = await db.query(
      "SELECT * FROM activations WHERE mac_address = ? AND software_name = ?",
      [macAddress, softwareName]
    );
    const activationArr = Array.isArray(activationRows) ? activationRows : [];
    const hasActivation = activationArr.length > 0;

    // 2.2 检查 installations 表（试用注册）
    const installRows = await db.query(
      "SELECT * FROM installations WHERE mac_address = ? AND software_name = ?",
      [macAddress, softwareName]
    );
    const installArr = Array.isArray(installRows) ? installRows : [];
    const hasInstallation = installArr.length > 0;

    // 情况1：已激活（activations表有记录）
    if (hasActivation) {
      const act = activationArr[0];
      const actExpireDate = new Date(act.expire_date);
      const actRemaining = Math.ceil((actExpireDate - new Date()) / (24 * 60 * 60 * 1000));
      const actExpired = actRemaining <= 0;

      return res.json({
        registered: true,        // 已注册/安装
        activated: true,        // 已激活（授权）
        expired: actExpired,    // 激活是否过期
        activationExpired: actExpired,
        message: actExpired ? '已激活但已过期' : '已激活（永久授权）',
        installation: {
          softwareName: act.software_name,
          userEmail: act.email,
          installDate: act.install_date,
          expireDate: act.expire_date,
          remainingDays: actRemaining
        },
        activation: {
          activationKey: act.activation_key,
          activateDate: act.activate_date,
          expireDate: act.expire_date,
          status: act.status
        }
      });
    }

    // 情况2：已注册但未激活（installations表有记录，activations表无记录）
    if (hasInstallation) {
      const inst = installArr[0];
      const instExpireDate = new Date(inst.expire_date);
      const instRemaining = Math.ceil((instExpireDate - new Date()) / (24 * 60 * 60 * 1000));
      const instExpired = instRemaining <= 0;

      return res.json({
        registered: true,        // 已注册/安装
        activated: false,        // 未激活（只有试用期）
        expired: instExpired,    // 试用期是否过期
        activationExpired: null,
        message: instExpired ? '试用期已过期，请激活' : '试用期（剩余' + instRemaining + '天）',
        installation: {
          softwareName: inst.software_name,
          userEmail: inst.user_email,
          macAddress: inst.mac_address,
          installDate: inst.install_date,
          expireDate: inst.expire_date,
          remainingDays: instRemaining
        },
        activation: null
      });
    }

    // 情况3：未注册
    return res.json({
      registered: false,
      activated: false,
      expired: false,
      activationExpired: null,
      message: 'MAC地址未注册',
      installation: null,
      activation: null
    });
  }

  // 3. 如果提供了邮箱，检查邮箱注册记录（原逻辑）
  if (userEmail) {
    const existing = await db.checkInstallation(softwareName, userEmail);
    if (existing) {
      const isExpired = existing.remainingDays <= 0;
      return res.json({
        registered: true,
        activated: false,
        expired: isExpired,
        activationExpired: null,
        message: isExpired ? '试用期已过期' : '试用期（剩余' + existing.remainingDays + '天）',
        installation: existing,
        activation: null
      });
    }
  }

  // 4. 默认返回未注册
  return res.json({
    registered: false,
    activated: false,
    expired: false,
    activationExpired: null,
    message: '未找到注册记录',
    installation: null,
    activation: null
  });
});

// 获取所有安装记录（管理员）
app.get('/api/installs', requireAuth, async (req, res) => {
  const installations = await db.getAllInstallations();
  res.json(installations);
});

// 获取单个安装记录（管理员）
app.get('/api/installs/:id', requireAuth, async (req, res) => {
  const installation = await db.getInstallationById(req.params.id);
  if (!installation) {
    return res.status(404).json({ error: '安装记录不存在' });
  }
  res.json(installation);
});

// 删除安装记录（管理员）
app.delete('/api/installs/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const result = await db.deleteInstallation(id);
  if (!result) {
    return res.status(404).json({ error: '安装记录不存在' });
  }
  res.json({ success: true, message: '删除成功' });
});

// ============ API路由 - 支付验证码 ============

// 请求支付验证码（管理员生成）
app.post('/api/verification/generate', requireAuth, (req, res) => {
  const code = db.generateVerificationCode();
  res.json({ code: code });
});

// 管理员验证验证码
app.post('/api/verification/verify', requireAuth, (req, res) => {
  const { code } = req.body;
  const success = db.verifyCode(code);
  res.json({ success: success });
});

// ============ API路由 - 产品 ============

// 获取所有产品
app.get('/api/products', async (req, res) => {
  const products = await db.getAllProducts();
  res.json(products);
});

// 获取单个产品
app.get('/api/products/:id', async (req, res) => {
  const product = await db.getProduct(req.params.id);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json(product);
});

// 添加产品（需登录）
app.post('/api/products', requireAuth, async (req, res) => {
  const { name, shortName, category, price, pricingTiers, description, version, platform, features, icon, featured, downloadUrl, externalLink, detailPage, image, imageDarkBg } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: 'Name and price are required' });
  }

  const newProduct = await db.addProduct({
    name,
    shortName: shortName || '',
    category: category || 'General',
    price: parseFloat(price),
    pricingTiers: pricingTiers || null,
    description: description || '',
    version: version || '1.0.0',
    platform: platform || 'Windows',
    features: features || [],
    icon: icon || 'software',
    featured: featured || false,
    downloadUrl: downloadUrl || '',
    externalLink: externalLink || false,
    detailPage: detailPage || '',
    image: image || '',
    imageDarkBg: imageDarkBg || false
  });

  res.status(201).json(newProduct);
  // 记录操作日志
  const username = req.session.userName || req.session.username || 'admin';
  db.addOperationLog(username, 'PRODUCT_CREATE', newProduct.id, `Created product: ${name}, Price: ${price}`);
});

// 更新产品（需登录）
app.put('/api/products/:id', requireAuth, async (req, res) => {
  const { name, shortName, category, price, pricingTiers, description, version, platform, features, icon, featured, downloadUrl, externalLink, detailPage, image, imageDarkBg } = req.body;

  const updates = {};
  if (name) updates.name = name;
  if (shortName !== undefined) updates.shortName = shortName;
  if (category) updates.category = category;
  if (price) updates.price = parseFloat(price);
  if (pricingTiers) updates.pricingTiers = pricingTiers;
  if (description !== undefined) updates.description = description;
  if (version) updates.version = version;
  if (platform) updates.platform = platform;
  if (features) updates.features = features;
  if (icon) updates.icon = icon;
  if (featured !== undefined) updates.featured = featured;
  if (downloadUrl !== undefined) updates.downloadUrl = downloadUrl;
  if (externalLink !== undefined) updates.externalLink = externalLink;
  if (detailPage !== undefined) updates.detailPage = detailPage;
  if (image !== undefined) updates.image = image;
  if (imageDarkBg !== undefined) updates.imageDarkBg = imageDarkBg;

  const updated = await db.updateProduct(req.params.id, updates);
  if (!updated) {
    return res.status(404).json({ error: 'Product not found' });
  }
  // 记录操作日志
  const username = req.session.userName || req.session.username || 'admin';
  db.addOperationLog(username, 'PRODUCT_UPDATE', req.params.id, `Updated product: ${name || updated.name}, Price: ${price || updated.price}`);
  res.json(updated);
});

// 保存产品详情内容（富文本HTML）
app.put('/api/products/:id/detail', requireAuth, async (req, res) => {
  const { detailContent } = req.body;
  const productId = req.params.id;

  const product = await db.getProduct(productId);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  // 保存详情内容为HTML文件
  const detailDir = path.join(__dirname, 'public', 'products');
  if (!fs.existsSync(detailDir)) {
    fs.mkdirSync(detailDir, { recursive: true });
  }

  const detailFileName = `product-${productId}.html`;
  const detailFilePath = path.join(detailDir, detailFileName);

  // 生成简单的HTML文件
  const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${product.name}</title>
</head>
<body>
${detailContent}
</body>
</html>`;

  fs.writeFileSync(detailFilePath, htmlContent, 'utf8');

  // 更新数据库中的详情页路径
  const detailPage = '/products/' + detailFileName;
  db.updateProduct(productId, { detailPage });

  res.json({ success: true, detailPage });
});

// 删除产品（需登录）
app.delete('/api/products/:id', requireAuth, async (req, res) => {
  try {
    // 先获取产品信息（包含详情页路径）
    const product = await db.getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // 删除产品
    await db.deleteProduct(req.params.id);

    // 删除详情页文件
    if (product.detailPage) {
      const detailFilePath = path.join(__dirname, 'public', product.detailPage);
      if (fs.existsSync(detailFilePath)) {
        fs.unlinkSync(detailFilePath);
      }
    }

    res.json({ success: true });
    // 记录操作日志
    const username = req.session.userName || req.session.username || 'admin';
    db.addOperationLog(username, 'PRODUCT_DELETE', req.params.id, `Deleted product: ${product.name}`);
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: '删除产品失败' });
  }
});

// 上传产品描述图片
app.post('/api/upload-product-image', requireAuth, uploadProductImage.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const imagePath = '/uploads/products/' + req.file.filename;
  res.json({ path: imagePath, filename: req.file.filename });
});

// 订阅邮箱
app.post('/api/subscribe', async (req, res) => {
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: '请输入有效的邮箱地址' });
  }

  try {
    await db.runQuery("INSERT INTO subscribers (email) VALUES (?)", [email]);
    res.json({ success: true, message: '订阅成功！' });
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      res.status(400).json({ error: '该邮箱已订阅' });
    } else {
      res.status(500).json({ error: '订阅失败' });
    }
  }
});

// 获取订阅者列表（需登录）
app.get('/api/subscribers', requireAuth, async (req, res) => {
  const result = await db.dbQuery("SELECT * FROM subscribers WHERE subscribed = 1 ORDER BY created_at DESC");
  const subscribers = result.values.map(row => {
    const obj = {};
    result.columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  });
  res.json(subscribers);
});

// 发送邮件给订阅者（需登录）
app.post('/api/send-email', requireAuth, async (req, res) => {
  const { subject, content } = req.body;

  if (!subject || !content) {
    return res.status(400).json({ error: '请填写邮件主题和内容' });
  }

  const result = await db.dbQuery("SELECT email FROM subscribers WHERE subscribed = 1");
  const emails = result.values.map(row => row[0]);

  // 保存邮件到文件供发送
  const emailDir = path.join(__dirname, 'data', 'emails');
  if (!fs.existsSync(emailDir)) {
    fs.mkdirSync(emailDir, { recursive: true });
  }

  const emailData = {
    id: Date.now(),
    subject,
    content,
    recipients: emails,
    createdAt: new Date().toISOString()
  };

  const emailFile = path.join(emailDir, `email-${emailData.id}.json`);
  fs.writeFileSync(emailFile, JSON.stringify(emailData, null, 2));

  res.json({ success: true, message: `邮件已保存，准备发送给 ${emails.length} 位订阅者` });
});

// 删除产品描述图片
app.delete('/api/upload-product-image', requireAuth, (req, res) => {
  const { filename } = req.body;
  if (!filename) {
    return res.status(400).json({ error: '缺少文件名' });
  }

  const filePath = path.join(__dirname, 'public', 'uploads', 'products', filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '文件不存在' });
  }
});

// 上传软件文件
app.post('/api/upload-software', requireAuth, uploadSoftware.single('software'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const fileInfo = {
    path: '/uploads/software/' + req.file.filename,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size
  };
  res.json(fileInfo);
});

// 删除软件文件
app.delete('/api/upload-software', requireAuth, (req, res) => {
  const { filename } = req.body;
  if (!filename) {
    return res.status(400).json({ error: '缺少文件名' });
  }

  const filePath = path.join(__dirname, 'public', 'uploads', 'software', filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '文件不存在' });
  }
});

// ============ API路由 - 设置 ============

// 获取网站设置
app.get('/api/settings', async (req, res) => {
  const settings = await db.getSettings();
  res.json(settings);
});

// 更新网站设置
app.put('/api/settings', requireAuth, async (req, res) => {
  const { companyName, description, ssl, banners, httpPort, httpsPort, adminEmail, wechatId, email, ai, carddav, siteTheme } = req.body;
  const updates = {};
  if (companyName !== undefined) updates.companyName = companyName;
  if (description !== undefined) updates.description = description;
  if (ssl !== undefined) updates.ssl = ssl;
  if (banners !== undefined) updates.banners = banners;
  if (httpPort !== undefined) updates.httpPort = httpPort;
  if (httpsPort !== undefined) updates.httpsPort = httpsPort;
  if (adminEmail !== undefined) updates.adminEmail = adminEmail;
  if (wechatId !== undefined) updates.wechatId = wechatId;
  if (email !== undefined) updates.email = email;
  if (ai !== undefined) updates.ai = ai;
  if (carddav !== undefined) updates.carddav = carddav;
  if (siteTheme !== undefined) updates.siteTheme = siteTheme;

  const settings = await db.updateSettings(updates);
  // 记录操作日志
  const username = req.session.userName || req.session.username || 'admin';
  const changedFields = Object.keys(updates).join(', ');
  db.addOperationLog(username, 'SETTINGS_UPDATE', 'website', `Updated settings: ${changedFields}`);
  res.json(settings);
});

// 获取 CardDAV 配置（公开）
app.get('/api/carddav', async (req, res) => {
  const settings = await db.getSettings();
  res.json(settings.carddav || { enabled: false, servers: [] });
});

// 查询 CardDAV 服务器列表（供本地应用使用，不包含敏感信息）
app.get('/api/QueryCardDavServerList', async (req, res) => {
  const settings = await db.getSettings();
  const carddav = settings.carddav || { enabled: false, servers: [] };

  if (!carddav.enabled) {
    return res.json({ success: false, servers: [], message: 'CardDAV未启用' });
  }

  // 返回服务器列表（仅名称和地址，不包含用户和密码）
  const servers = (carddav.servers || []).map(s => ({
    name: s.name,
    url: s.url
  }));

  res.json({ success: true, servers });
});

// 更新 CardDAV 配置
app.put('/api/carddav', requireAuth, async (req, res) => {
  const { enabled, servers } = req.body;
  const current = await db.getSettings();
  const carddav = {
    enabled: enabled !== undefined ? enabled : (current.carddav?.enabled || false),
    servers: servers || (current.carddav?.servers || [])
  };
  await db.updateSettings({ carddav });
  res.json(carddav);
});

// 上传Logo
app.post('/api/upload-logo', requireAuth, uploadLogo.single('logo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const logoPath = '/uploads/' + req.file.filename;
  const settings = await db.updateSettings({ logo: logoPath });
  res.json(settings);
});

// 上传Banner图片
app.post('/api/upload-banner', requireAuth, uploadBanner.single('banner'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const bannerPath = '/uploads/' + req.file.filename;
  res.json({ path: bannerPath });
});

// 添加/更新Banner
app.post('/api/banners', requireAuth, async (req, res) => {
  const { banners } = req.body;

  if (!Array.isArray(banners)) {
    return res.status(400).json({ error: 'Invalid banners data' });
  }

  const settings = await db.updateSettings({ banners });
  res.json(settings);
});

// ============ API路由 - 安全设置与日志 ============

// 获取安全配置
app.get('/api/security/config', requireAuth, (req, res) => {
  res.json({
    maxAttempts: securityConfig.maxAttempts,
    criticalAttempts: securityConfig.criticalAttempts,
    attemptWindow: securityConfig.attemptWindow,
    lockoutDuration: securityConfig.lockoutDuration,
    apiRateLimit: securityConfig.apiRateLimit
  });
});

// 更新安全配置
app.post('/api/security/config', requireAuth, (req, res) => {
  const { maxAttempts, criticalAttempts, attemptWindow, lockoutDuration, apiRateLimit } = req.body;

  if (maxAttempts) securityConfig.maxAttempts = parseInt(maxAttempts);
  if (criticalAttempts) securityConfig.criticalAttempts = parseInt(criticalAttempts);
  if (attemptWindow) securityConfig.attemptWindow = parseInt(attemptWindow);
  if (lockoutDuration) securityConfig.lockoutDuration = parseInt(lockoutDuration);

  // 更新 API 限流配置
  if (apiRateLimit) {
    if (apiRateLimit.enabled !== undefined) securityConfig.apiRateLimit.enabled = apiRateLimit.enabled;
    if (apiRateLimit.windowMs) securityConfig.apiRateLimit.windowMs = parseInt(apiRateLimit.windowMs);
    if (apiRateLimit.maxRequests) securityConfig.apiRateLimit.maxRequests = parseInt(apiRateLimit.maxRequests);
    if (apiRateLimit.blockDuration) securityConfig.apiRateLimit.blockDuration = parseInt(apiRateLimit.blockDuration);
    if (Array.isArray(apiRateLimit.whitelist)) securityConfig.apiRateLimit.whitelist = apiRateLimit.whitelist;
  }

  writeLoginLog('info', getClientIp(req), 'admin', 'CONFIG_UPDATE', `Security config updated`);
  writeOperationLog('SECURITY_CONFIG_UPDATE', 'admin', `Updated security settings`);

  res.json({ success: true, config: securityConfig });
});

// 获取日志文件列表（支持type参数）
app.get('/api/security/logs', requireAuth, (req, res) => {
  const { type } = req.query;
  let files;
  if (type) {
    files = getLogFilesByType(type);
  } else {
    files = getLogFiles();
  }
  res.json({ files });
});

// 获取指定日期和类型的日志
app.get('/api/security/logs/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  const { type } = req.query;
  let content;
  if (type) {
    content = getLogsByType(type, date);
  } else {
    content = getLoginLogs(date);
  }
  res.json({ content });
});

// 获取当前被封禁的IP列表
app.get('/api/security/blocked', requireAuth, (req, res) => {
  const blocked = [];
  blockedIPs.forEach((info, ip) => {
    if (info.until > Date.now()) {
      blocked.push({
        ip,
        until: new Date(info.until).toISOString(),
        reason: info.reason,
        blockedAt: info.blockedAt
      });
    }
  });
  res.json({ blocked });
});

// 解封指定IP
app.post('/api/security/unblock', requireAuth, (req, res) => {
  const { ip } = req.body;
  if (blockedIPs.has(ip)) {
    blockedIPs.delete(ip);
    writeLoginLog('info', getClientIp(req), 'admin', 'IP_UNBLOCKED', `IP: ${ip}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'IP未被封禁' });
  }
});

// 获取 API 限流封禁的IP列表
app.get('/api/security/api-blocked', requireAuth, (req, res) => {
  const blocked = [];
  apiBlockedIPs.forEach((info, ip) => {
    if (info.until > Date.now()) {
      blocked.push({
        ip,
        until: new Date(info.until).toISOString(),
        reason: info.reason
      });
    }
  });
  res.json({ blocked });
});

// 解封 API 限流IP
app.post('/api/security/api-unblock', requireAuth, (req, res) => {
  const { ip } = req.body;
  if (apiBlockedIPs.has(ip)) {
    apiBlockedIPs.delete(ip);
    writeLoginLog('info', getClientIp(req), 'admin', 'API_IP_UNBLOCKED', `IP: ${ip}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'IP未被封禁' });
  }
});

// ============ API路由 - 邮件设置 ============

// 获取邮件设置
app.get('/api/email/config', requireAuth, async (req, res) => {
  const config = await db.getSmtpConfig();
  res.json(config);
});

// 更新邮件设置
app.post('/api/email/config', requireAuth, async (req, res) => {
  const { host, port, user, password, from, secure } = req.body;

  const settings = await db.getSettings();
  const existingSmtp = settings.smtp || {};
  settings.smtp = {
    host: host || existingSmtp.host || '',
    port: parseInt(port) || existingSmtp.port || 587,
    user: user || existingSmtp.user || '',
    password: password || existingSmtp.password || '',
    from: from || existingSmtp.from || '',
    secure: secure !== undefined ? secure : (existingSmtp.secure || false)
  };

  await db.updateSettings(settings);
  writeLoginLog('info', getClientIp(req), 'admin', 'CONFIG_UPDATE', 'Email settings updated');
  writeOperationLog('EMAIL_CONFIG_UPDATE', 'admin', 'Updated email settings');
  writeEmailLog('CONFIG_UPDATE', 'admin', 'Email configuration updated', true);

  res.json({ success: true });
});

// ============ 订单确认邮件函数 ============
async function sendOrderConfirmationEmail(order, user, items) {
  const settings = await db.getSettings();
  const email = settings?.smtp;

  if (!email?.host || !email?.user || !email?.from) {
    console.log('Email not configured, skipping order confirmation email');
    return false;
  }

  if (!user.email) {
    console.log('User has no email, skipping order confirmation email');
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: email.host,
      port: email.port,
      secure: email.secure,
      auth: {
        user: email.user,
        pass: email.password
      }
    });

    const companyName = settings.companyName || '博铭科技';
    const wechatId = settings.wechatId || 'xpcustomer';

    // 构建商品列表
    let productListHtml = '';
    let productListText = '';
    for (let i = 0; i < items.length; i++) {
      const product = await db.getProduct(items[i].productId);
      const name = product ? product.name : items[i].name;
      productListHtml += `<li>${name} - ¥${items[i].price} x ${items[i].quantity || 1}</li>`;
      productListText += `${i + 1}. ${name} - ¥${items[i].price} x ${items[i].quantity || 1}\n`;
    }

    const orderDate = new Date(order.createdAt).toLocaleString('zh-CN');
    const subject = companyName + ' - 订单 #' + order.id + ' 已确认';

    const html = `
      <h2>${companyName} - 订单确认</h2>
      <p>您好 ${user.username}，</p>
      <p>您的订单已成功提交！以下是订单详情：</p>

      <h3>订单信息</h3>
      <ul>
        <li><strong>订单编号：</strong>#${order.id}</li>
        <li><strong>订单时间：</strong>${orderDate}</li>
        <li><strong>订单金额：</strong>¥${order.totalAmount}</li>
        <li><strong>订单状态：</strong>待支付</li>
      </ul>

      <h3>商品清单</h3>
      <ul>
        ${productListHtml}
      </ul>

      <h3>支付说明</h3>
      <p>请通过微信转账完成支付，然后联系客服获取激活码。</p>
      <p><strong>微信号：</strong>${wechatId}</p>
      <p>联系客服时，请提供您的订单编号 <strong>#${order.id}</strong>。</p>

      <p>支付完成后，在订单详情页面输入激活码即可完成验证并下载软件。</p>

      <p>如有任何问题，请联系客服。</p>

      <p>感谢您的购买！</p>
      <p>${companyName} 团队</p>
    `;

    const text = `
${companyName} - 订单确认

您好 ${user.username}，

您的订单已成功提交！以下是订单详情：

订单信息
- 订单编号：#${order.id}
- 订单时间：${orderDate}
- 订单金额：¥${order.totalAmount}
- 订单状态：待支付

商品清单
${productListText}

支付说明
请通过微信转账完成支付，然后联系客服获取激活码。
微信号：${wechatId}
联系客服时，请提供您的订单编号 #${order.id}。

支付完成后，在订单详情页面输入激活码即可完成验证并下载软件。

如有任何问题，请联系客服。

感谢您的购买！
${companyName} 团队
    `;

    // 发送邮件给用户
    await transporter.sendMail({
      from: email.from,
      to: user.email,
      subject: subject,
      text: text,
      html: html
    });

    console.log('Order confirmation email sent to ' + user.email);
    writeEmailLog('ORDER_CONFIRMATION', user.email, `Order #${order.id} confirmation sent`);

    // 同时发送邮件给管理员
    if (settings.adminEmail) {
      const adminSubject = companyName + ' - 新订单 #' + order.id + ' - ¥' + order.totalAmount;
      const adminHtml = `
        <h2>${companyName} - 新订单通知</h2>
        <p>您有一笔新订单！订单详情如下：</p>

        <h3>订单信息</h3>
        <ul>
          <li><strong>订单编号：</strong>#${order.id}</li>
          <li><strong>客户用户名：</strong>${user.username}</li>
          <li><strong>客户邮箱：</strong>${user.email}</li>
          <li><strong>客户电话：</strong>${user.phone || '未填写'}</li>
          <li><strong>订单时间：</strong>${orderDate}</li>
          <li><strong>订单金额：</strong>¥${order.totalAmount}</li>
          <li><strong>订单状态：</strong>待支付</li>
        </ul>

        <h3>商品清单</h3>
        <ul>
          ${productListHtml}
        </ul>

        <p>请等待客户完成支付。</p>
      `;

      const adminText = `
${companyName} - 新订单通知

您有一笔新订单！订单详情如下：

订单信息
- 订单编号：#${order.id}
- 客户用户名：${user.username}
- 客户邮箱：${user.email}
- 客户电话：${user.phone || '未填写'}
- 订单时间：${orderDate}
- 订单金额：¥${order.totalAmount}
- 订单状态：待支付

商品清单
${productListText}

请等待客户完成支付。
      `;

      await transporter.sendMail({
        from: email.from,
        to: settings.adminEmail,
        subject: adminSubject,
        text: adminText,
        html: adminHtml
      });

      console.log('Order notification email sent to admin ' + settings.adminEmail);
      writeEmailLog('ORDER_NOTIFICATION', settings.adminEmail, `New order #${order.id} notification sent`);
    }

    return true;
  } catch (error) {
    console.error('Failed to send order confirmation email:', error.message);
    writeEmailLog('FAILED', user.email, `Order #${order.id} confirmation failed: ${error.message}`);
    return false;
  }
}

// ============ 支付成功邮件函数（含下载链接）============
async function sendOrderPaidEmail(order, user, items, activationCodes) {
  const settings = await db.getSettings();
  const email = settings?.smtp;

  if (!email?.host || !email?.user || !email?.from) {
    console.log('Email not configured, skipping order paid email');
    return false;
  }

  if (!user.email) {
    console.log('User has no email, skipping order paid email');
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: email.host,
      port: email.port,
      secure: email.secure,
      auth: {
        user: email.user,
        pass: email.password
      }
    });

    const companyName = settings.companyName || '博铭科技';
    const baseUrl = settings.ssl?.domain ? 'https://' + settings.ssl.domain : 'http://localhost:3000';

    // 构建商品列表和下载链接
    let productListHtml = '';
    let productListText = '';
    for (const item of items) {
      const product = await db.getProduct(item.productId);
      const name = product ? product.name : item.name;
      let downloadUrl = '';
      if (product && product.downloadUrl) {
        downloadUrl = product.externalLink ? product.downloadUrl : baseUrl + product.downloadUrl;
      }
      const hasDownload = downloadUrl && downloadUrl.trim() !== '';

      productListHtml += `<li>${name} - ¥${item.price} x ${item.quantity || 1}`;
      if (hasDownload) {
        productListHtml += `<br><a href="${downloadUrl}" style="color: #10b981; text-decoration: none;">点击下载</a>`;
      }
      productListHtml += `</li>`;

      productListText += `${name} - ¥${item.price} x ${item.quantity || 1}`;
      if (hasDownload) {
        productListText += ` 下载地址: ${downloadUrl}`;
      }
      productListText += `\n`;
    }

    // 构建激活码列表
    let activationCodesHtml = '';
    let activationCodesText = '';
    if (activationCodes && activationCodes.length > 0) {
      activationCodesHtml = `
        <h3>授权码</h3>
        <div style="background: #f5f5f5; padding: 15px; border-radius: 6px; font-family: monospace; font-size: 14px;">
          ${activationCodes.map(code => `<div style="margin: 5px 0;">${code}</div>`).join('')}
        </div>
        <p style="color: #666; font-size: 12px; margin-top: 10px;">请妥善保管您的授权码，每组授权码可供一台设备使用。</p>
      `;
      activationCodesText = '\n授权码：\n' + activationCodes.join('\n') + '\n请妥善保管您的授权码，每组授权码可供一台设备使用。\n';
    }

    const orderDate = new Date(order.createdAt).toLocaleString('zh-CN');
    const paidDate = new Date(order.paidAt || order.createdAt).toLocaleString('zh-CN');
    const subject = companyName + ' - 订单 #' + order.id + ' 支付成功';

    const html = `
      <h2>${companyName} - 支付成功</h2>
      <p>您好 ${user.username}，</p>
      <p>恭喜！您的订单已支付成功！以下是订单详情：</p>

      <h3>订单信息</h3>
      <ul>
        <li><strong>订单编号：</strong>#${order.id}</li>
        <li><strong>下单时间：</strong>${orderDate}</li>
        <li><strong>支付时间：</strong>${paidDate}</li>
        <li><strong>订单金额：</strong>¥${order.totalAmount}</li>
        <li><strong>订单状态：</strong>已支付 ✓</li>
      </ul>

      <h3>商品清单及下载链接</h3>
      <ul>
        ${productListHtml}
      </ul>

      ${activationCodesHtml}

      <p>您可以点击上述下载链接获取软件安装包。</p>

      <p>如有任何问题，请联系客服。</p>

      <p>感谢您的购买！</p>
      <p>${companyName} 团队</p>
    `;

    const text = `
${companyName} - 支付成功

您好 ${user.username}，

恭喜！您的订单已支付成功！以下是订单详情：

订单信息
- 订单编号：#${order.id}
- 下单时间：${orderDate}
- 支付时间：${paidDate}
- 订单金额：¥${order.totalAmount}
- 订单状态：已支付 ✓

商品清单及下载链接
${productListText}

${activationCodesText}
您可以点击上述下载链接获取软件安装包。

如有任何问题，请联系客服。

感谢您的购买！
${companyName} 团队
    `;

    await transporter.sendMail({
      from: email.from,
      to: user.email,
      subject: subject,
      text: text,
      html: html
    });

    console.log('Order paid email sent to ' + user.email);
    writeEmailLog('ORDER_PAID', user.email, `Order #${order.id} paid confirmation sent`);

    // 同时发送邮件给管理员
    if (settings.adminEmail) {
      const adminSubject = companyName + ' - 订单 #' + order.id + ' 已支付 - ¥' + order.totalAmount;
      const adminHtml = `
        <h2>${companyName} - 订单支付通知</h2>
        <p>有一笔订单已完成支付！订单详情如下：</p>

        <h3>订单信息</h3>
        <ul>
          <li><strong>订单编号：</strong>#${order.id}</li>
          <li><strong>客户用户名：</strong>${user.username}</li>
          <li><strong>客户邮箱：</strong>${user.email}</li>
          <li><strong>客户电话：</strong>${user.phone || '未填写'}</li>
          <li><strong>下单时间：</strong>${orderDate}</li>
          <li><strong>支付时间：</strong>${paidDate}</li>
          <li><strong>订单金额：</strong>¥${order.totalAmount}</li>
          <li><strong>订单状态：</strong>已支付 ✓</li>
        </ul>

        <h3>商品清单</h3>
        <ul>
          ${productListHtml}
        </ul>
      `;

      const adminText = `
${companyName} - 订单支付通知

有一笔订单已完成支付！订单详情如下：

订单信息
- 订单编号：#${order.id}
- 客户用户名：${user.username}
- 客户邮箱：${user.email}
- 客户电话：${user.phone || '未填写'}
- 下单时间：${orderDate}
- 支付时间：${paidDate}
- 订单金额：¥${order.totalAmount}
- 订单状态：已支付 ✓

商品清单
${productListText}
      `;

      await transporter.sendMail({
        from: email.from,
        to: settings.adminEmail,
        subject: adminSubject,
        text: adminText,
        html: adminHtml
      });

      console.log('Order paid notification email sent to admin ' + settings.adminEmail);
      writeEmailLog('ORDER_PAID_NOTIFICATION', settings.adminEmail, `Order #${order.id} paid notification sent`);
    }

    return true;
  } catch (error) {
    console.error('Failed to send order paid email:', error.message);
    writeEmailLog('FAILED', user.email, `Order #${order.id} paid email failed: ${error.message}`);
    return false;
  }
}

// 测试发送邮件
app.post('/api/email/test', requireAuth, async (req, res) => {
  const { to } = req.body;
  const settings = await db.getSettings();
  const email = settings?.smtp;

  if (!email.host || !email.user || !email.from) {
    return res.status(400).json({ error: '请先配置邮件设置' });
  }

  if (!to) {
    return res.status(400).json({ error: '请输入收件人地址' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: email.host,
      port: email.port,
      secure: email.secure,
      auth: {
        user: email.user,
        pass: email.password
      }
    });

    const companyName = settings.companyName || '博铭科技';
    await transporter.sendMail({
      from: email.from,
      to: to,
      subject: companyName + ' 邮件测试',
      text: '这是一封来自 ' + companyName + ' 系统的测试邮件。如果您收到此邮件，说明邮件配置正确。',
      html: '<h2>' + companyName + ' 邮件测试</h2><p>这是一封来自 ' + companyName + ' 系统的测试邮件。</p><p>如果您收到此邮件，说明邮件配置正确。</p>'
    });

    writeLoginLog('info', getClientIp(req), 'admin', 'EMAIL_TEST', `Test email sent to ${to}`);
    writeEmailLog('TEST_SENT', 'admin', `Test email to ${to}`, true);
    res.json({ success: true, message: '测试邮件发送成功' });
  } catch (error) {
    writeLoginLog('alert', getClientIp(req), 'admin', 'EMAIL_TEST_FAILED', error.message);
    writeEmailLog('TEST_FAILED', 'admin', `Test email failed: ${error.message}`, false);
    res.status(500).json({ error: '邮件发送失败: ' + error.message });
  }
});

// ============ API路由 - AI ============

// AI连接测试
app.post('/api/ai/test', requireAuth, async (req, res) => {
  const { provider, apiKey, endpoint, model } = req.body;

  if (!apiKey) {
    return res.status(400).json({ success: false, error: '请输入API Key' });
  }

  if (!model) {
    return res.status(400).json({ success: false, error: '请输入模型名称' });
  }

  try {
    let testPrompt = 'Hello, please respond with "OK" if you receive this message.';

    if (provider === 'openai' || provider === 'custom') {
      const openAiEndpoint = endpoint || 'https://api.openai.com/v1';
      // custom provider 使用完整URL，openai 使用 base URL + /chat/completions
      const apiPath = provider === 'custom' ? '' : '/chat/completions';
      const response = await fetch(`${openAiEndpoint}${apiPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: testPrompt }],
          max_tokens: 10
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = 'API请求失败';
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.error?.message || errJson.error?.code || errMsg;
        } catch (e) {
          errMsg = errText.substring(0, 200);
        }
        return res.status(400).json({ success: false, error: errMsg });
      }

      const data = await response.json();
      if (data.choices && data.choices[0]) {
        res.json({ success: true, message: '连接成功' });
      } else {
        res.status(400).json({ success: false, error: '响应格式异常' });
      }
    } else if (provider === 'claude') {
      const claudeEndpoint = endpoint || 'https://api.anthropic.com/v1';
      const response = await fetch(`${claudeEndpoint}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model || 'claude-3-sonnet-20240229',
          max_tokens: 10,
          messages: [{ role: 'user', content: testPrompt }]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = 'API请求失败';
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.error?.message || errJson.error?.type || errMsg;
        } catch (e) {
          errMsg = errText.substring(0, 200);
        }
        return res.status(400).json({ success: false, error: errMsg });
      }

      const data = await response.json();
      if (data.content) {
        res.json({ success: true, message: '连接成功' });
      } else {
        res.status(400).json({ success: false, error: '响应格式异常' });
      }
    } else {
      res.status(400).json({ success: false, error: '不支持的AI服务商' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI文本生成
app.post('/api/ai/generate', requireAuth, async (req, res) => {
  const { text, type, customPrompt } = req.body;

  if (!text && !customPrompt) {
    return res.status(400).json({ success: false, error: '缺少文本内容' });
  }

  const settings = await db.getSettings();
  const ai = settings?.aiConfig || settings?.ai || {};

  if (!ai.enabled || !ai.apiKey) {
    return res.status(400).json({ success: false, error: 'AI功能未启用或未配置API Key' });
  }

  try {
    let prompt = customPrompt || '';
    let model = ai.model || 'gpt-3.5-turbo';

    if (!customPrompt) {
      if (type === 'website_description') {
        prompt = `请根据以下网站信息，为博铭科技生成一段专业的企业网站描述。要求：\n1. 简洁有力，突出企业核心价值\n2. 50-100字左右\n3. 专业大气，适合软件行业\n4. 不使用markdown格式\n\n现有描述参考：${text || '无'}`;
      } else if (type === 'product_description') {
        prompt = `你是非常专业的产品经理，基于产品的维度优化和扩展描述内容。要求：\n1. 突出产品特点和优势\n2. 扩展丰富内容\n3. 专业但易于理解\n4. 不使用markdown格式\n\n产品信息：${text || '无'}`;
      } else {
        prompt = `请优化以下文本，使其更加专业：\n${text}`;
      }
    }

    if (ai.provider === 'openai' || ai.provider === 'custom') {
      const openAiEndpoint = ai.endpoint || 'https://api.openai.com/v1';
      const apiPath = ai.provider === 'custom' ? '' : '/chat/completions';
      const response = await fetch(`${openAiEndpoint}${apiPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ai.apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 500
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = 'API请求失败';
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.error?.message || errJson.error?.code || errMsg;
        } catch (e) {
          errMsg = errText.substring(0, 200);
        }
        return res.status(400).json({ success: false, error: errMsg });
      }

      const data = await response.json();
      const generatedText = data.choices[0]?.message?.content?.trim() || '';
      res.json({ success: true, text: generatedText });
    } else if (ai.provider === 'claude') {
      const claudeEndpoint = ai.endpoint || 'https://api.anthropic.com/v1';
      const response = await fetch(`${claudeEndpoint}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ai.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = 'API请求失败';
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.error?.message || errJson.error?.type || errMsg;
        } catch (e) {
          errMsg = errText.substring(0, 200);
        }
        return res.status(400).json({ success: false, error: errMsg });
      }

      const data = await response.json();
      const generatedText = data.content[0]?.text?.trim() || '';
      res.json({ success: true, text: generatedText });
    } else {
      res.status(400).json({ success: false, error: '不支持的AI服务商' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ API路由 - 数据库管理 ============

// 获取数据库配置
app.get('/api/db-config', requireAuth, (req, res) => {
  const config = db.getDbConfig();
  // 返回完整配置（包括密码，供已登录管理员查看）
  res.json(config);
});

// 更新数据库配置
app.post('/api/db-config', requireAuth, (req, res) => {
  try {
    const newConfig = req.body;
    // 如果密码是 ******，不更新密码
    if (newConfig.mysql && newConfig.mysql.password === '******') {
      const oldConfig = db.getDbConfig();
      newConfig.mysql.password = oldConfig.mysql.password;
    }
    const config = db.updateDbConfig(newConfig);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: '配置保存失败' });
  }
});

// 获取数据库Schema
app.get('/api/db-schema', requireAuth, async (req, res) => {
  const type = req.query.type || 'mysql';
  try {
    const schema = type === 'sqlite' ? await db.getSQLiteSchema() : await db.getMySQLSchema();
    res.json({ schema });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 测试数据库连接
app.post('/api/db-test', requireAuth, async (req, res) => {
  const config = req.body;
  try {
    if (config.type === 'mysql') {
      const mysql = require('mysql2/promise');
      const connection = await mysql.createConnection({
        host: config.mysql.host,
        port: config.mysql.port,
        user: config.mysql.user,
        password: config.mysql.password,
        database: config.mysql.database
      });
      await connection.ping();
      await connection.end();
    }
    res.json({ success: true, message: '连接成功' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 获取目标数据库表信息（预览）
app.post('/api/db-target-info', requireAuth, async (req, res) => {
  const config = req.body;
  try {
    let tables = [];
    if (config.type === 'mysql') {
      const mysql = require('mysql2/promise');
      const connection = await mysql.createConnection({
        host: config.mysql.host,
        port: config.mysql.port,
        user: config.mysql.user,
        password: config.mysql.password,
        database: config.mysql.database
      });
      const [rows] = await connection.query('SHOW TABLES');
      tables = rows.map(row => Object.values(row)[0]);
      await connection.end();
    } else {
      tables = db.getAllTables();
    }

    // 使用 for...of 替代 map 以支持 await
    const tableInfo = [];
    for (const tableName of tables) {
      let count = 0;
      try {
        if (config.type === 'mysql') {
          const mysql = require('mysql2/promise');
          const connection = await mysql.createConnection({
            host: config.mysql.host,
            port: config.mysql.port,
            user: config.mysql.user,
            password: config.mysql.password,
            database: config.mysql.database
          });
          const [countResult] = await connection.query(`SELECT COUNT(*) as c FROM \`${tableName}\``);
          count = countResult[0].c;
          await connection.end();
        } else {
          count = await db.getTableCount(tableName);
        }
      } catch (e) {
        count = 0;
      }
      tableInfo.push({ name: tableName, count });
    }

    res.json({ success: true, type: config.type, tables: tableInfo });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 验证目标数据库数据完整性
app.post('/api/db-target-verify', requireAuth, async (req, res) => {
  const config = req.body;
  try {
    const results = [];
    const tables = config.type === 'mysql' ? ['admin', 'products', 'settings', 'users', 'orders', 'verification_codes', 'faqs', 'support_tickets', 'activations', 'installations', 'used_activation_codes'] : db.getAllTables();

    for (const table of tables) {
      try {
        let count = 0;
        if (config.type === 'mysql') {
          const mysql = require('mysql2/promise');
          const connection = await mysql.createConnection({
            host: config.mysql.host,
            port: config.mysql.port,
            user: config.mysql.user,
            password: config.mysql.password,
            database: config.mysql.database
          });
          const [countResult] = await connection.query(`SELECT COUNT(*) as c FROM \`${table}\``);
          count = countResult[0].c;
          await connection.end();
        } else {
          count = await db.getTableCount(table);
        }
        results.push({ table, count, status: 'ok' });
      } catch (e) {
        results.push({ table, count: 0, status: 'error', error: e.message });
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 复制数据到目标数据库
app.post('/api/db-copy', requireAuth, async (req, res) => {
  const config = req.body;
  try {
    if (config.type !== 'mysql') {
      return res.status(400).json({ success: false, error: '目前只支持复制到MySQL' });
    }

    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database
    });

    // 获取当前数据库的所有数据
    const allowedTables = db.getAllTables();
    let totalCopied = 0;
    const details = [];

    for (const table of allowedTables) {
      try {
        // 获取源表数据
        const sourceData = await db.query(`SELECT * FROM \`${table}\``);
        if (!sourceData || sourceData.length === 0) {
          details.push({ table: table, count: 0, status: 'ok' });
          continue;
        }

        const columns = Object.keys(sourceData[0]);
        const rowCount = sourceData.length;

        // 清空目标表
        await connection.query(`DELETE FROM \`${table}\``);

        // 插入数据
        for (const row of sourceData) {
          const values = columns.map(c => row[c]);
          const placeholders = columns.map(() => '?').join(', ');
          const escapedCols = columns.map(c => `\`${c}\``).join(', ');
          await connection.query(
            `INSERT INTO \`${table}\` (${escapedCols}) VALUES (${placeholders})`,
            values
          );
          totalCopied++;
        }
        details.push({ table: table, count: rowCount, status: 'ok' });
      } catch (e) {
        console.error(`Error copying table ${table}:`, e.message);
        details.push({ table: table, count: 0, status: 'error', error: e.message });
      }
    }

    await connection.end();
    res.json({ success: true, message: `数据复制成功，共复制 ${totalCopied} 条记录`, details: details });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 获取数据库表信息
app.get('/api/db-info', requireAuth, async (req, res) => {
  try {
    const dbConfig = db.getDbConfig();
    const tables = db.getAllTables();
    const tableInfo = [];
    for (const table of tables) {
      const count = await db.getTableCount(table);
      tableInfo.push({ name: table, count: count });
    }
    res.json({
      type: dbConfig.type,
      tables: tableInfo
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 验证数据完整性
app.get('/api/db-verify', requireAuth, async (req, res) => {
  try {
    const results = await db.verifyDataIntegrity();
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 切换数据库连接
app.post('/api/db-switch', requireAuth, async (req, res) => {
  try {
    const { type } = req.body;
    const dbConfig = db.getDbConfig();

    if (type === 'mysql' && dbConfig.mysql) {
      // 重新初始化MySQL连接
      await db.initMySQL(dbConfig.mysql);
      db.updateDbConfig({ type: 'mysql' });
      res.json({ success: true, message: '已切换到 MySQL' });
    } else if (type === 'sqlite') {
      db.updateDbConfig({ type: 'sqlite' });
      res.json({ success: true, message: '已切换到 SQLite' });
    } else {
      res.status(400).json({ error: '无效的数据库类型或MySQL未配置' });
    }
  } catch (error) {
    res.status(500).json({ error: '切换失败: ' + error.message });
  }
});

// 初始化数据库
app.post('/api/db-init', requireAuth, async (req, res) => {
  try {
    // 优先使用请求体中的配置，否则使用存储的配置
    const bodyConfig = req.body;
    const storedConfig = db.getDbConfig();
    const config = {
      type: bodyConfig.type || storedConfig.type,
      mysql: bodyConfig.mysql || storedConfig.mysql
    };

    console.log('db-init request:', { type: config.type, mysql: config.mysql ? { host: config.mysql.host, user: config.mysql.user, database: config.mysql.database } : null });

    if (config.type === 'mysql') {
      if (!config.mysql || !config.mysql.host || !config.mysql.user || !config.mysql.database) {
        return res.status(400).json({ success: false, error: 'MySQL配置不完整，请填写完整的主机、用户名和数据库名' });
      }

      // MySQL 初始化
      const mysql = require('mysql2/promise');
      const connection = await mysql.createConnection({
        host: config.mysql.host,
        port: config.mysql.port || 3306,
        user: config.mysql.user,
        password: config.mysql.password || '',
        database: config.mysql.database,
        multipleStatements: true
      });

      const schema = db.getMySQLSchema();
      await connection.query(schema);
      await connection.end();
      res.json({ success: true, message: 'MySQL数据库初始化成功' });
    } else {
      // SQLite 初始化 - 确保所有表存在
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const DB_FILE = path.join(__dirname, 'data', 'database.sqlite');

      let tempDb;
      if (fs.existsSync(DB_FILE)) {
        const fileBuffer = fs.readFileSync(DB_FILE);
        tempDb = new SQL.Database(fileBuffer);
      } else {
        tempDb = new SQL.Database();
      }

      // 执行建表SQL
      const schema = db.getSQLiteSchema();
      tempDb.run(schema);

      // 保存
      const data = tempDb.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_FILE, buffer);

      res.json({ success: true, message: 'SQLite数据库初始化成功' });
    }
  } catch (error) {
    console.error('DB init error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 导出数据（JSON格式）
app.get('/api/db-export', requireAuth, async (req, res) => {
  const data = {
    products: await db.getAllProducts(),
    settings: await db.getSettings(),
    admin: await db.getAdmin(),
    exportedAt: new Date().toISOString()
  };
  res.json(data);
});

// 导出SQLite数据库文件
app.get('/api/db-export-sqlite', requireAuth, (req, res) => {
  const dbPath = path.join(__dirname, 'data', 'database.sqlite');
  res.download(dbPath, 'booming-database-' + new Date().toISOString().split('T')[0] + '.sqlite');
});

// 导入SQLite数据库文件
app.post('/api/db-import-sqlite', requireAuth, (req, res) => {
  // 需要前端上传文件
  res.json({ success: false, message: '请使用SQLite文件导入功能' });
});

// 导入数据
app.post('/api/db-import', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    if (data.products) {
      for (const p of data.products) {
        const existing = await db.getProduct(p.id);
        if (!existing) {
          await db.addProduct(p);
        }
      }
    }
    if (data.settings) {
      await db.updateSettings(data.settings);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: '导入失败' });
  }
});

// 迁移到MySQL
app.post('/api/db-migrate', requireAuth, async (req, res) => {
  try {
    // TODO: 实现实际的MySQL迁移
    // 目前只是返回成功消息
    res.json({ success: true, message: '迁移成功' });
  } catch (error) {
    res.status(500).json({ error: '迁移失败: ' + error.message });
  }
});

// ============ API路由 - FAQ ============

// 获取所有FAQ（公开）
app.get('/api/faqs', async (req, res) => {
  const faqs = await db.getAllFaqs();
  res.json(faqs);
});

// 获取单个FAQ
app.get('/api/faqs/:id', async (req, res) => {
  const faq = await db.getFaqById(req.params.id);
  if (!faq) {
    return res.status(404).json({ error: 'FAQ not found' });
  }
  res.json(faq);
});

// 添加FAQ（需登录）
app.post('/api/faqs', requireAuth, async (req, res) => {
  const { question, answer, sortOrder } = req.body;

  if (!question || !answer) {
    return res.status(400).json({ error: '问题和答案不能为空' });
  }

  const newFaq = await db.addFaq({ question, answer, sortOrder });
  res.status(201).json(newFaq);
});

// 更新FAQ（需登录）
app.put('/api/faqs/:id', requireAuth, async (req, res) => {
  const { question, answer, sortOrder } = req.body;

  const updates = {};
  if (question) updates.question = question;
  if (answer) updates.answer = answer;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;

  const updated = await db.updateFaq(req.params.id, updates);
  if (!updated) {
    return res.status(404).json({ error: 'FAQ not found' });
  }
  res.json(updated);
});

// 删除FAQ（需登录）
app.delete('/api/faqs/:id', requireAuth, async (req, res) => {
  const deleted = await db.deleteFaq(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'FAQ not found' });
  }
  res.json({ success: true });
});

// ============ 页面路由 ============

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/product/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'product.html'));
});

app.get('/contact', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/admin-product', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-product.html'));
});

app.get('/admin-list', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-list.html'));
});

app.get('/ProductManagement', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ProductManagement.html'));
});

app.get('/admin-settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-settings.html'));
});

app.get('/admin-ssl', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-ssl.html'));
});

app.get('/admin-api', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-api.html'));
});

app.get('/admin-dbsettings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-dbsettings.html'));
});

app.get('/admin-security', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-security.html'));
});

app.get('/admin-email', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-email.html'));
});

app.get('/admin-newsletter', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-newsletter.html'));
});

app.get('/admin-ai', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-ai.html'));
});

app.get('/admin-carddav', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-carddav.html'));
});

app.get('/admin-overview', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-overview.html'));
});

app.get('/admin-log-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-log-login.html'));
});

app.get('/admin-log-operation', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-log-operation.html'));
});

app.get('/admin-log-registration', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-log-registration.html'));
});

app.get('/admin-log-activation', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-log-activation.html'));
});

// 用户页面路由
app.get('/user-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user-login.html'));
});

app.get('/user-register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user-register.html'));
});

app.get('/user-forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user-forgot-password.html'));
});

app.get('/user-center', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user-center.html'));
});

app.get('/order-detail', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'order-detail.html'));
});

app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

// 新增页面路由
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/help', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

app.get('/faq', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'faq.html'));
});

app.get('/admin-faq', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-faq.html'));
});

app.get('/admin-orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-orders.html'));
});

app.get('/admin-activations', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-activations.html'));
});

app.get('/admin-support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-support.html'));
});

app.get('/admin-installations', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-installations.html'));
});

app.get('/admin-telemetry', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-telemetry.html'));
});

app.get('/admin-banners', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-banners.html'));
});

// ============ API路由 - 技术支持工单 ============

// 提交技术支持工单（公开）
app.post('/api/support', async (req, res) => {
  const { subject, description, userName, userEmail, userPhone, priority } = req.body;

  if (!subject || !description || !userName || !userEmail) {
    return res.status(400).json({ error: '请填写必填字段' });
  }

  const ticket = await db.createSupportTicket({
    subject,
    description,
    userName,
    userEmail,
    userPhone,
    priority
  });

  // 通知管理员
  const settings = await db.getSettings();
  if (settings.adminEmail && settings.smtp?.host) {
    sendEmail({
      from: settings.smtp.from || settings.smtp.user,
      to: settings.adminEmail,
      subject: `【技术支持工单】#${ticket.id} - ${escapeHtml(subject)}`,
      html: `
        <h2>新的技术支持工单</h2>
        <table style="border-collapse: collapse; width: 100%;">
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">工单编号</td>
            <td style="padding: 8px;">#${ticket.id}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">主题</td>
            <td style="padding: 8px;">${escapeHtml(subject)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">提交人</td>
            <td style="padding: 8px;">${escapeHtml(userName)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">邮箱</td>
            <td style="padding: 8px;">${escapeHtml(userEmail)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">电话</td>
            <td style="padding: 8px;">${escapeHtml(userPhone) || '-'}</td>
          </tr>
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 8px; font-weight: bold;">优先级</td>
            <td style="padding: 8px;">${priority === 'high' ? '高' : priority === 'low' ? '低' : '普通'}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold;">问题描述</td>
            <td style="padding: 8px;">${escapeHtml(description)}</td>
          </tr>
        </table>
        <p style="margin-top: 20px;"><a href="http://${settings.ssl?.domain || 'localhost:' + (settings.httpPort || 10000)}/admin-support" style="background: #133c8a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">查看工单</a></p>
      `
    });
  }

  res.status(201).json({ success: true, ticket });
});

// 获取所有工单（需管理员）
app.get('/api/support', requireAuth, async (req, res) => {
  const tickets = await db.getAllSupportTickets();
  res.json(tickets);
});

// 获取单个工单（需管理员）
app.get('/api/support/:id', requireAuth, async (req, res) => {
  const ticket = await db.getSupportTicketById(req.params.id);
  if (!ticket) {
    return res.status(404).json({ error: '工单不存在' });
  }
  res.json(ticket);
});

// 回复工单（需管理员）
app.post('/api/support/:id/reply', requireAuth, async (req, res) => {
  const { content, isResolved } = req.body;

  if (!content) {
    return res.status(400).json({ error: '回复内容不能为空' });
  }

  const ticket = await db.getSupportTicketById(req.params.id);
  if (!ticket) {
    return res.status(404).json({ error: '工单不存在' });
  }

  const reply = {
    content,
    adminName: '技术支持团队',
    isResolved: isResolved || false
  };

  const updatedTicket = await db.addSupportTicketReply(req.params.id, reply);

  // 更新状态
  if (isResolved) {
    await db.updateSupportTicketStatus(req.params.id, 'resolved');
  }

  // 发送邮件通知用户
  const settings = await db.getSettings();
  if (ticket.userEmail && settings.smtp?.host) {
    sendEmail({
      from: settings.smtp.from || settings.smtp.user,
      to: ticket.userEmail,
      subject: `【博铭科技】您的技术支持工单 #${ticket.id} 已有新回复`,
      html: `
        <h2>尊敬的用户您好，</h2>
        <p>您提交的技术支持工单 <strong>#${ticket.id} - ${ticket.subject}</strong> 已有新的回复：</p>
        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          ${content}
        </div>
        <p>如有任何问题，请随时联系我们。</p>
        <p style="margin-top: 30px;">博铭科技 技术支持团队</p>
      `
    });
  }

  res.json({ success: true, ticket: updatedTicket });
});

// 更新工单状态（需管理员）
app.put('/api/support/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;

  if (!['open', 'replied', 'resolved', 'closed'].includes(status)) {
    return res.status(400).json({ error: '无效的状态' });
  }

  const ticket = await db.updateSupportTicketStatus(req.params.id, status);
  if (!ticket) {
    return res.status(404).json({ error: '工单不存在' });
  }

  res.json(ticket);
});

// 启动服务器
async function startServer() {
  try {
    // 初始化数据库
    await db.initDatabase();
    console.log('Database initialized');

    // 获取端口配置
    const settings = await db.getSettings();
    const HTTP_PORT = settings?.httpPort || 15000;

    // 启动 HTTP 服务器
    app.listen(HTTP_PORT, '0.0.0.0', () => {
      console.log(`HTTP Server running at http://0.0.0.0:${HTTP_PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
