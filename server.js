require('dotenv').config();

// Process-level safety net: 防止任何未捕获异常导致 Node 进程崩溃
// 主要场景: mysql2 promise pool 在连接重置时抛 ECONNRESET，
// 若上层 await 未 try/catch 会变成 unhandledRejection，Node 默认行为是崩溃。
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});

const express = require('express');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const compression = require('compression');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { spawn } = require('child_process');
const db = require('./db');
const appPackage = require('./package.json');
const { createMcpRouter } = require('./lib/mcp/server');
const { ContentPolicyError, validateNewsIdentity } = require('./lib/content-policy');
const { resolveProductType } = require('./lib/product-policy');
const { resolveAndValidateOrderItem } = require('./lib/order-policy');
const setupPolicy = require('./lib/setup-policy');
const setupService = require('./lib/setup');
const envFile = require('./lib/env-file');
const envConfigService = require('./lib/env-config-service');
const {
  generateMcpToken,
  hashMcpToken,
  getMcpTokenPreview,
  normalizeMcpScopes,
  formatMcpScopes,
  MCP_SCOPES,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_PRODUCT_READ,
  SCOPE_PRODUCT_WRITE
} = require('./lib/mcp/tokens');

// 数据库备份常量
const BACKUP_DIR = path.join(__dirname, 'backups');
const MYSQL_BIN_DIR = 'E:\\mysql\\bin\\';
const BACKUP_FILENAME_RE = /^(backup|before-restore|_uploaded)-\d{8}-\d{6}\.sql$/;
let isBackupInProgress = false;
let isRestoreInProgress = false;

// 数据库备份助手函数
const BACKUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 min hard limit prevents hung-process mutex stuck

function runMysqldump(outFile) {
  return new Promise((resolve, reject) => {
    // 修复 S16：使用 --defaults-file 而非 -p 参数，避免密码出现在 tasklist/ps 输出
    // 文件模式 0600（Windows 上等价：仅当前用户可读）并使用后立即删除
    const os = require('os');
    const defaultsFile = path.join(os.tmpdir(), `my-${process.pid}-${Date.now()}.cnf`);
    const defaultsContent = `[mysqldump]\nuser=${process.env.DB_USER}\npassword="${process.env.DB_PASSWORD.replace(/"/g, '\\"')}"\nhost=${process.env.DB_HOST}\n`;
    require('fs').writeFileSync(defaultsFile, defaultsContent, { mode: 0o600 });
    const args = [
      `--defaults-file=${defaultsFile}`,
      '--databases', process.env.DB_NAME,
      '--single-transaction',
      '--routines', '--triggers',
      '--compress',
      '--quick',
      '-r', outFile
    ];
    const proc = spawn(path.join(MYSQL_BIN_DIR, 'mysqldump.exe'), args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', err => { try { require('fs').unlinkSync(defaultsFile); } catch {} reject(err); });
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      try { require('fs').unlinkSync(defaultsFile); } catch {}
      reject(new Error(`mysqldump timed out after ${BACKUP_TIMEOUT_MS / 1000}s`));
    }, BACKUP_TIMEOUT_MS);
    proc.on('close', code => {
      clearTimeout(killTimer);
      try { require('fs').unlinkSync(defaultsFile); } catch {}
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(0, 500) || `mysqldump exit ${code}`));
    });
  });
}

function runMysqlImport(sqlFile) {
  return new Promise((resolve, reject) => {
    // 修复 S16 同源问题：mysql.exe 的密码也用 --defaults-file 而非 -p 参数
    const os = require('os');
    const defaultsFile = path.join(os.tmpdir(), `my-${process.pid}-${Date.now()}.cnf`);
    const defaultsContent = `[mysql]\nuser=${process.env.DB_USER}\npassword="${process.env.DB_PASSWORD.replace(/"/g, '\\"')}"\nhost=${process.env.DB_HOST}\n`;
    require('fs').writeFileSync(defaultsFile, defaultsContent, { mode: 0o600 });
    const args = [
      `--defaults-file=${defaultsFile}`,
      '--compress',
      process.env.DB_NAME
    ];
    const proc = spawn(path.join(MYSQL_BIN_DIR, 'mysql.exe'), args, { windowsHide: true });
    const cleanup = () => { try { require('fs').unlinkSync(defaultsFile); } catch {} };
    proc.on('error', err => { cleanup(); reject(err); });
    const stdin = fs.createReadStream(sqlFile);
    stdin.pipe(proc.stdin);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      cleanup();
      reject(new Error(`mysql import timed out after ${BACKUP_TIMEOUT_MS / 1000}s`));
    }, BACKUP_TIMEOUT_MS);
    proc.on('close', code => {
      clearTimeout(killTimer);
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(0, 500) || `mysql exit ${code}`));
    });
  });
}

async function getBackupList() {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  // Clean up old _uploaded- files (>1h)
  const files = await fs.promises.readdir(BACKUP_DIR);
  const now = Date.now();
  for (const f of files) {
    if (!f.startsWith('_uploaded-')) continue;
    const fp = path.join(BACKUP_DIR, f);
    const stat = await fs.promises.stat(fp);
    if (now - stat.mtimeMs > 3600 * 1000) {
      await fs.promises.unlink(fp).catch(() => {});
    }
  }
  // List backup-* and before-restore-*
  const out = [];
  for (const f of (await fs.promises.readdir(BACKUP_DIR)).sort().reverse()) {
    if (!BACKUP_FILENAME_RE.test(f)) continue;
    if (f.startsWith('_uploaded-')) continue;
    const fp = path.join(BACKUP_DIR, f);
    const stat = await fs.promises.stat(fp);
    out.push({
      filename: f,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      kind: f.startsWith('before-restore-') ? 'before-restore' : 'manual'
    });
  }
  return out;
}

async function pruneToLast3() {
  const backups = (await fs.promises.readdir(BACKUP_DIR))
    .filter(f => f.startsWith('backup-') && BACKUP_FILENAME_RE.test(f))
    .map(f => ({ f, mtime: fs.promises.stat(path.join(BACKUP_DIR, f)).then(s => s.mtimeMs) }));
  const resolved = await Promise.all(backups.map(async b => ({ f: b.f, mtime: await b.mtime })));
  resolved.sort((a, b) => b.mtime - a.mtime);
  for (const b of resolved.slice(3)) {
    await fs.promises.unlink(path.join(BACKUP_DIR, b.f)).catch(() => {});
  }
}

const app = express();

// Session 版本控制 - 只在首次启动时创建版本号，后续启动复用旧版本
// 这样服务器重启（崩溃恢复、部署）不会让所有 session 失效
const SESSION_VERSION_FILE = path.join(__dirname, 'data', 'session.version');
let currentSessionVersion;
try {
  currentSessionVersion = fs.readFileSync(SESSION_VERSION_FILE, 'utf8').trim();
  if (!currentSessionVersion) throw new Error('empty version');
} catch {
  currentSessionVersion = Date.now().toString(36);
  fs.writeFileSync(SESSION_VERSION_FILE, currentSessionVersion);
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

// 修复 M1: 内存 Map 大小上限 + 定期清理过期项,防长时间运行内存泄漏
// LRU 简化:超限时按 insertion order 删最旧的(避免引入完整 LRU 库)
const RATE_MAP_MAX = 50000;       // 5 万条上限(足够覆盖正常流量峰值)
const RATE_MAP_CLEAN_INTERVAL = 10 * 60 * 1000; // 10 分钟扫一次过期项
function pruneRateMap(map, isExpired) {
  if (map.size > RATE_MAP_MAX) {
    // 删到 80%(留 20% buffer)
    const target = Math.floor(RATE_MAP_MAX * 0.8);
    const toRemove = map.size - target;
    let removed = 0;
    for (const key of map.keys()) {
      if (removed >= toRemove) break;
      map.delete(key);
      removed++;
    }
  }
  // 顺便清过期项
  for (const [key, val] of map.entries()) {
    if (isExpired(val)) map.delete(key);
  }
}
setInterval(() => {
  pruneRateMap(loginAttempts, v => v.lockedUntil && v.lockedUntil < Date.now() - securityConfig.suspiciousDuration);
  pruneRateMap(blockedIPs, v => v.until && v.until < Date.now());
  pruneRateMap(apiRateLimitMap, v => v.resetTime && v.resetTime < Date.now() - 60000);
  pruneRateMap(apiBlockedIPs, v => v.until && v.until < Date.now());
  pruneRateMap(publicEndpointRateLimit, v => v.resetTime && v.resetTime < Date.now() - 60000);
  pruneRateMap(registerAttempts, v => v.windowStart && v.windowStart < Date.now() - REGISTER_RATE_WINDOW);
}, RATE_MAP_CLEAN_INTERVAL).unref(); // .unref() 让定时器不阻止进程退出

// 修复 I12: 每日清理 7+ 天的 data/emails/email-*.json(邮件内容存档)
//         邮件发送详情已持久化到 logs/email-*.log,这里只清内容快照避免磁盘膨胀
const EMAIL_CONTENT_DIR = path.join(__dirname, 'data', 'emails');
const EMAIL_CONTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const EMAIL_CLEAN_INTERVAL = 24 * 60 * 60 * 1000; // 24 小时
async function cleanupOldEmailContents() {
  if (!fs.existsSync(EMAIL_CONTENT_DIR)) return;
  const now = Date.now();
  let removed = 0;
  try {
    const files = await fs.promises.readdir(EMAIL_CONTENT_DIR);
    for (const f of files) {
      if (!f.startsWith('email-') || !f.endsWith('.json')) continue;
      const fp = path.join(EMAIL_CONTENT_DIR, f);
      const stat = await fs.promises.stat(fp);
      if (now - stat.mtimeMs > EMAIL_CONTENT_TTL_MS) {
        await fs.promises.unlink(fp).catch(() => {});
        removed++;
      }
    }
    if (removed > 0) console.log(`[cleanup] removed ${removed} stale email content files`);
  } catch (e) {
    console.error('[cleanup] email content cleanup failed:', e.message);
  }
}
// 启动 1 小时后首次跑(让 MySQL 池先稳),之后每 24 小时
setTimeout(cleanupOldEmailContents, 60 * 60 * 1000).unref();
setInterval(cleanupOldEmailContents, EMAIL_CLEAN_INTERVAL).unref();

// 获取客户端IP
// 配合 app.set('trust proxy', 'loopback') — 仅信任 127.0.0.1 传来的 X-Forwarded-For
// nginx 反代场景下 req.ip 拿真实客户端 IP;非 loopback 直连则 req.ip = socket.remoteAddress
// 这样攻击者无法通过伪造 XFF 头绕过 IP 黑名单/限流
function getClientIp(req) {
  return req.ip ||
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

// 公共端点限流器（修复 S12/S13：/api/install 和 /api/telemetry 是无认证公开端点，
// 全局 apiRateLimit 默认 100/sec 太宽松，攻击者可灌满 installations / telemetry 表）
// 改成每个 IP 最多 30 次/分钟，超过直接 429
const publicEndpointRateLimit = new Map(); // ip -> { count, resetTime }
const PUBLIC_ENDPOINT_LIMIT = 30;
const PUBLIC_ENDPOINT_WINDOW = 60 * 1000;
function checkPublicEndpointRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = publicEndpointRateLimit.get(ip);
  if (!record || now > record.resetTime) {
    publicEndpointRateLimit.set(ip, { count: 1, resetTime: now + PUBLIC_ENDPOINT_WINDOW });
    return next();
  }
  record.count++;
  if (record.count > PUBLIC_ENDPOINT_LIMIT) {
    return res.status(429).json({
      error: '该端点请求过于频繁，请稍后再试',
      retryAfter: Math.ceil((record.resetTime - now) / 1000)
    });
  }
  next();
}

// 注册限流（I4：/api/user/register 原本只受全局 apiRateLimit 约束 ——
// 100 次/秒，对「建号 + 写 registration_logs + 发验证邮件」这种写操作等于不设防）。
//
// 单独计数，不和登录共用一张表：登录失败触发的封禁是针对登录的，
// 复用同一张表会出现「你登录失败得多 → 你连注册都不让做」的连坐。
//
// 只限「成功建号」：失败的请求不建号、不发邮件，不该占额度 ——
// 否则恶意请求能把同 IP 的正常用户额度耗光（限流本身反而变成 DoS 手段）。
// 但占位在校验入口就做，避免并发的多个请求同时通过检查各建一个号。
//
// 阈值 5 个/小时：办公网 NAT 后可能有几十个同事注册，5 个/小时够用；
// 而邮件轰炸（用 +别名 变体绕过邮箱唯一性，反复给同一个收件人发验证信）
// 需要的是比 30 次/分钟紧得多的阈值。
const registerAttempts = new Map(); // ip -> { count, windowStart }
const REGISTER_RATE_LIMIT = Number(process.env.REGISTER_RATE_LIMIT || 5);
const REGISTER_RATE_WINDOW = 60 * 60 * 1000; // 1 小时

/**
 * 注册限流检查 —— 通过时**先占一个额度**。
 *
 * @returns {{allowed: boolean, retryAfter?: number}} allowed=false 时 retryAfter 是秒
 */
function checkRegisterRateLimit(ip) {
  const now = Date.now();
  let record = registerAttempts.get(ip);
  if (!record || now - record.windowStart >= REGISTER_RATE_WINDOW) {
    record = { count: 0, windowStart: now };
    registerAttempts.set(ip, record);
  }
  if (record.count >= REGISTER_RATE_LIMIT) {
    const retryAfter = Math.ceil((record.windowStart + REGISTER_RATE_WINDOW - now) / 1000);
    return { allowed: false, retryAfter };
  }
  record.count += 1; // 占位：失败时要还回去（见 releaseRegisterRateLimit）
  return { allowed: true };
}

/** 注册没走到「建号成功」那一步时，把占用的额度还回去。 */
function releaseRegisterRateLimit(ip) {
  const record = registerAttempts.get(ip);
  if (record && record.count > 0) record.count -= 1;
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

// 生成激活码（格式：xxxxx-xxxxx-xxxxx-xxxxx-xxxxx，每段5位，使用 crypto 安全随机）
function generateActivationCodes(count = 5) {
  const codes = [];
  const usedCodes = new Set();

  while (codes.length < count) {
    // 13 bytes = 26 hex chars, 切5段每段5字符
    const bytes = crypto.randomBytes(13).toString('hex').toUpperCase();
    const code = `${bytes.slice(0,5)}-${bytes.slice(5,10)}-${bytes.slice(10,15)}-${bytes.slice(15,20)}-${bytes.slice(20,25)}`;

    // 检查是否重复
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      codes.push(code);
    }
  }

  return codes;
}

// ============ PayPal Webhook 签名验证 ============
// 修复 S2：原代码 TODO 未做签名校验，攻击者可伪造 CHECKOUT.ORDER.COMPLETED
// 把任意订单标 paid + 生成激活码 + 发邮件。修复策略：
//   1. fetch cert from PAYPAL-CERT-URL (cached 1h, 仅允许 PayPal CDN 域名)
//   2. CRC32(raw body) → expected = `${transmissionId}|${transmissionTime}|${webhookId}|${crc}`
//   3. RSA verify 签名（authAlgo 由 PayPal header 指定）

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const paypalCertCache = new Map();
const PAYPAL_CERT_CACHE_TTL = 60 * 60 * 1000;

function fetchPayPalCert(certUrl) {
  const cached = paypalCertCache.get(certUrl);
  if (cached && Date.now() - cached.fetchedAt < PAYPAL_CERT_CACHE_TTL) {
    return Promise.resolve(cached.cert);
  }
  return new Promise((resolve, reject) => {
    const req = https.get(certUrl, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`PayPal cert fetch HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        paypalCertCache.set(certUrl, { cert: data, fetchedAt: Date.now() });
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('PayPal cert fetch timeout')));
  });
}

async function verifyPayPalWebhook(headers, rawBody) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    return { valid: false, error: 'PAYPAL_WEBHOOK_ID not configured' };
  }
  const transmissionId = headers['paypal-transmission-id'];
  const transmissionTime = headers['paypal-transmission-time'];
  const transmissionSig = headers['paypal-transmission-sig'];
  const certUrl = headers['paypal-cert-url'];
  const authAlgo = headers['paypal-auth-algo'];
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    return { valid: false, error: 'Missing required PayPal verification headers' };
  }
  // 仅信任 PayPal 官方 CDN 域名，避免 certUrl SSRF
  if (!/^https:\/\/(api\.(?:sandbox\.)?paypal\.com\/cgi-bin\/certs\.cgi|paypal\.com\/cgi-bin\/certs\.cgi)/.test(certUrl)) {
    return { valid: false, error: 'Cert URL not from trusted PayPal domain' };
  }
  let cert;
  try {
    cert = await fetchPayPalCert(certUrl);
  } catch (e) {
    return { valid: false, error: `Cert fetch failed: ${e.message}` };
  }
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const crc = crc32(bodyBuf);
  const expected = `${transmissionId}|${transmissionTime}|${webhookId}|${crc}`;
  try {
    const verifier = crypto.createVerify(authAlgo);
    verifier.update(expected);
    const sigBuf = Buffer.from(transmissionSig, 'base64');
    const isValid = verifier.verify(cert, sigBuf);
    return { valid: isValid, error: isValid ? null : 'Signature mismatch' };
  } catch (e) {
    return { valid: false, error: `Verify error: ${e.message}` };
  }
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

// 滑动窗口过期日期计算
// 核心原则：未过期则累加，已过期则从今天开始计算
function calculateSlidingWindowExpiry(currentExpireDate, purchasedDays, today = new Date()) {
  const todayEnd = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59));
  let currentExpireEnd = null;

  if (currentExpireDate) {
    const d = new Date(currentExpireDate);
    currentExpireEnd = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59));
  }

  let expireDate;
  let isRenewal = false;

  if (currentExpireEnd && currentExpireEnd.getTime() >= todayEnd.getTime()) {
    // 有效期未过：从当前到期日累加购买时长
    expireDate = new Date(currentExpireEnd.getTime() + purchasedDays * 24 * 60 * 60 * 1000);
    isRenewal = true;
  } else {
    // 有效期已过或无记录：从今天 23:59:59 计算
    expireDate = new Date(todayEnd.getTime() + purchasedDays * 24 * 60 * 60 * 1000);
  }

  return { expireDate, isRenewal };
}

// 验证MAC地址格式（48位，格式：XX:XX:XX:XX:XX:XX 或 XXXXXXXXXXXX）
function isValidMacAddress(mac) {
  if (!mac || typeof mac !== 'string') return false;
  // 支持两种格式：冒号分隔或无分隔
  const pattern = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$|^([0-9A-Fa-f]{12})$/;
  return pattern.test(mac);
}

// 验证邮箱格式
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return pattern.test(email);
}

// 验证授权码格式（只允许字母和数字）
function isValidActivationCode(code) {
  if (!code || typeof code !== 'string') return false;
  // 允许字母、数字、连字符、下划线，最小6位
  const pattern = /^[a-zA-Z0-9_-]{6,32}$/;
  return pattern.test(code);
}

// 激活状态常量
const ACTIVATION_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  BLOCKED: 'blocked'
};

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
const sessionDbConfig = db.getDbConfig().mysql;
const MySQLStore = MySQLStoreFactory(session);
// express-mysql-session@3.0.3 的 prepareOptionsForMySQL2 有白名单,不传递
// enableKeepAlive / keepAliveInitialDelay。手动建 pool（带 keepAlive）再传
// 进去作为第二个 connection 参数，避开白名单。修复后无 ECONNRESET。
const sessionPool = mysql.createPool({
  host: sessionDbConfig.host,
  port: sessionDbConfig.port,
  user: sessionDbConfig.user,
  password: sessionDbConfig.password,
  database: sessionDbConfig.database,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});
const sessionStore = new MySQLStore({
  createDatabaseTable: true,
  schema: {
    tableName: 'sessions',
    columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' }
  },
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: 30 * 24 * 60 * 60 * 1000
}, sessionPool);

// 安全启动检查：强制生产使用非占位密钥
const PLACEHOLDER_SECRETS = new Set([
  'booming-tech-secret-key-change-in-production',
  'default-secret-change-in-production',
  'change-me-in-production-2026'
]);

// .env 现在是**安装向导的产物**（仓库里只留 .env.example）。
// 于是「密钥没配好」有两种截然不同的含义，必须分开处理：
//
//   A. 缺失 —— 全新部署还没跑过向导，或部署坏了但还没修。
//      缺失 ≠ 危险：临时密钥每次重启都变，猜不到。
//      **绝不能 exit(1)**：进程一退出，向导也跟着没了，初始化界面就失去了意义
//      （和「数据库连不上就退出」是同一类错误）。用进程内临时随机密钥顶住，
//      等向导把正式密钥写进 .env。
//
//   B. 命中已知占位值（如 change-me-in-production）——
//      占位值是公开的，任何人都能伪造会话 Cookie。必须 fail-closed 拒绝启动。
//
// 分界是「有没有值」而不是「.env 在不在」：docker 部署常常用环境变量注入密钥、
// 不落 .env，那属于「配好了」，不该被拦。
const envFilePresent = envFile.envFileExists();
const rawSessionSecret = process.env.SESSION_SECRET || '';
const rawCronToken = process.env.CRON_TOKEN || '';

if (PLACEHOLDER_SECRETS.has(rawSessionSecret)) {
  console.error('FATAL: SESSION_SECRET is a known placeholder value. Refusing to start.');
  process.exit(1);
}
if (PLACEHOLDER_SECRETS.has(rawCronToken)) {
  console.error('FATAL: CRON_TOKEN is a known placeholder value. Refusing to start.');
  process.exit(1);
}

if (!rawSessionSecret) {
  // 临时密钥只在内存里，不落盘 —— 正式密钥由安装向导生成后写进 .env
  process.env.SESSION_SECRET = envFile.generateSecret();
  console.warn('  ⚠ 未配置 SESSION_SECRET —— 使用本次启动的临时密钥（重启后失效）。');
  console.warn('    请在 /setup 或后台「系统设置 → 数据库」保存配置，正式密钥会写进 .env。');
}
if (!rawCronToken) {
  process.env.CRON_TOKEN = envFile.generateHexToken();
  console.warn('  ⚠ 未配置 CRON_TOKEN —— 使用本次启动的临时令牌（重启后失效）。');
}
if (!envFilePresent) {
  console.warn('  ⚠ 未找到 .env —— 站点尚未完成初始化，请访问 /setup 完成安装。');
}
// MCP_TOKEN 不再是「启动前置条件」—— 主令牌改由后台「系统设置 → MCP」生成/轮换。
//
// 为什么从 fail-closed(进程) 改成 fail-closed(端点)：
//   旧模型下 MCP_TOKEN 缺失 = 进程拒绝启动。若沿用，管理员在后台申请令牌之前
//   就必须先手工编辑 .env —— 那等于「令牌申请」这个功能永远用不上。
//   现在：进程照常启动；端点若拿不到任何可用凭据（既无主令牌，也没有后台签发的
//   有效令牌），/mcp 一律返回 503 —— 被保护的是「端点不被无凭据访问」，而不是「进程」。
//
// 环境变量 MCP_TOKEN 仍然作为兼容回退保留（存量部署），但优先级低于后台生成的主令牌。
if (!process.env.MCP_TOKEN) {
  console.warn('[WARN] 未配置 MCP_TOKEN —— /mcp 主令牌请在后台「系统设置 → MCP」生成；');
  console.warn('       若后台也没有签发任何有效令牌，端点会返回 503（fail-closed）。');
} else if (PLACEHOLDER_SECRETS.has(process.env.MCP_TOKEN)) {
  console.warn('[WARN] MCP_TOKEN 是已知占位值，已按「未配置」处理。');
  process.env.MCP_TOKEN = '';
}

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'strict',
    // 生产环境（HTTPS）下 secure=true，cookie 只通过 HTTPS 传输
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Session 版本检查 - 服务器重启后使旧 session 失效
app.use((req, res, next) => {
  // 仅当session存在且有sessionVersion时检查版本
  // 新创建的session没有sessionVersion，不需要清除
  if (req.session && req.session.sessionVersion !== undefined && req.session.sessionVersion !== currentSessionVersion) {
    req.session.destroy();
  }
  next();
});

// Security headers (defense in depth — 即使 XSS 注入,浏览器也阻止执行)
app.use((req, res, next) => {
  // frame-ancestors 'none' — 防 clickjacking (X-Frame-Options 已被现代浏览器弃用)
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "img-src 'self' data: https:; " +
    "script-src 'self' 'unsafe-inline'; " +  // 'unsafe-inline' 暂留(admin 页 + 部分公开页还有 inline script),后续重构
    "style-src 'self' 'unsafe-inline'; " +   // admin 主题需要 inline style
    "connect-src 'self'; " +
    "font-src 'self' data:; " +
    "object-src 'none'; " +                  // 禁 Flash / 旧插件
    "base-uri 'self'; " +                    // 防止 <base> 标签劫持相对 URL
    "frame-ancestors 'none'; " +             // 防 clickjacking
    "form-action 'self'; " +                 // 防止 form 提交到外站
    "upgrade-insecure-requests"              // 自动升级 http:// → https://
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// CSRF 防御 - 检查 state-changing 请求的 Origin 头
const STATE_CHANGING_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];
app.use((req, res, next) => {
  if (!STATE_CHANGING_METHODS.includes(req.method)) return next();
  const origin = req.headers.origin;
  const host = req.headers.host;
  // 允许同源（无 Origin 或匹配 host）
  if (!origin) return next();
  if (origin === `http://${host}` || origin === `https://${host}`) return next();
  // 允许 Origin: null（某些旧客户端 / 文件下载场景）
  if (origin === 'null') return next();
  console.warn(`[CSRF] Blocked ${req.method} ${req.path} from origin ${origin} (expected host ${host})`);
  return res.status(403).json({ error: '跨源请求被拒绝' });
});

// 中间件
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(compression());
// ===== MCP (Model Context Protocol) =====
// AI 工具通过 Streamable HTTP 走 /mcp 发布「动态」(news 表) 与「产品 / 产品文档」
// (products / product_docs 表)。
//
// 重要：产品的**上架**不开放给 MCP —— AI 建出来的产品一律是草稿（products.status=0），
// 上架必须人工在后台点。原因与做法详见 docs/mcp-endpoint.md §3.4。
//
// 挂载点必须在全局 express.json() 之前：MCP 单次请求会带整篇文章正文，
// 全局 100kb 上限装不下；MCP 路由自带 2mb 的 body parser（body-parser 会给
// 已解析的请求打 req._body 标记，全局解析器随后自动跳过，两者不冲突）。
const MCP_ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS || '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

/**
 * 解析当前生效的 MCP 配置。
 *
 * 后台保存过就以后台为准（enabled / allowedHosts / masterToken 都能在后台改，
 * 改完立即生效）；从未保存过则回退到环境变量默认值 —— 这样从旧版本升级上来时行为完全不变。
 *
 * 主令牌存在数据库里（后台点击生成/轮换），因此每次请求都会重新读 ——
 * 后台轮换主令牌后立即生效，不需要重启进程。
 *
 * 注意：这个函数每次 MCP 请求都会调一次（一次 settings 主键查询）。
 * MCP 请求量很低（AI 工具调用），不值得为它引入缓存与失效逻辑；
 * 换来的是「后台改设置立刻生效」，没有陈旧窗口。
 */
async function resolveMcpConfig() {
  const stored = await db.getStoredMcpConfig();
  if (!stored) {
    return { enabled: true, allowedHosts: MCP_ALLOWED_HOSTS, masterToken: '' };
  }
  return {
    enabled: stored.enabled !== false,
    allowedHosts: Array.isArray(stored.allowedHosts) ? stored.allowedHosts : [],
    masterToken: typeof stored.masterToken === 'string' ? stored.masterToken : ''
  };
}

// /mcp 挂载在全局安装闸门之前（闸门在静态资源之后），所以这里单独加一道：
// 站点没装好时 MCP 端点不参与服务。
app.use('/mcp', async (req, res, next) => {
  try {
    const state = await setupService.getSetupState(db);
    if (!state.installed && !state.undetermined) {
      return res.status(503).json({ error: '系统尚未完成初始化' });
    }
  } catch (error) {
    // 状态查不到就放行，交给 MCP 路由自己的错误处理
    console.error('[setup] MCP 安装状态检查失败:', error.message);
  }
  next();
}, createMcpRouter({
  db,
  writeOperationLog,
  logger: console,
  mcpToken: process.env.MCP_TOKEN || '',
  allowedHosts: MCP_ALLOWED_HOSTS,
  getMcpConfig: resolveMcpConfig,
  serverVersion: appPackage.version || '1.0.0'
}));
// Global JSON limit: 100KB (safe for normal API calls; file uploads use multer directly)
app.use(express.json({
  limit: '100kb',
  // 捕获原始 body 给需要验签的端点用（如 PayPal webhook）
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
// 静态资源：dev / 直连时按扩展名分发缓存头
// HTML → no-cache（每次 revalidate，确保改了能拿到）
// JS/CSS/图片/字体 → 7d immutable（生产 Nginx 接管后这一层只兜底 dev）
// 生产环境建议让 Nginx 直接 alias 直出，避开 Node，省一次进程切换
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  immutable: false,
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.html?$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      // 带版本戳 ?v=YYYYMMDD 的资源可永久缓存
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  }
}));

// res.sendFile 路径 hook：让所有通过路由 sendFile 返回的 HTML 也带 no-cache 头
// （app.get('/xxx', (req, res) => res.sendFile(...)) 这类）
app.use((req, res, next) => {
  const origSendFile = res.sendFile.bind(res);
  res.sendFile = function(p, opts, cb) {
    if (typeof p === 'string' && /\.html?$/i.test(p)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    return origSendFile(p, opts, cb);
  };
  next();
});

// API 限流中间件
app.use('/api/', checkApiRateLimit);

// ============================================================================
// 安装 / 初始化向导
//
// 「站点装没装好」的唯一权威判据是 users 表里有没有 is_admin=1 的账号。
// 建表、灌默认数据都是幂等的，不能拿来当闸门 —— 否则「表建好了但管理员还没
// 创建」的窗口期内闸门会重新打开，被人抢先建管理员接管站点。
//
// 三道闸：
//   1. 安装令牌 —— SETUP_TOKEN 环境变量，或服务器自动生成并写进
//      data/setup-token.txt（只打在服务器控制台，不经任何 HTTP 响应回显）。
//   2. 「确实未安装」判定 —— DB 异常时 fail-closed，拒绝写操作。
//   3. 管理员创建成功后销毁令牌文件，所有安装接口永久关闭。
// ============================================================================

const SETUP_ERROR_MESSAGES = {
  [setupPolicy.SETUP_ERROR_CODES.TOKEN_REQUIRED]: '安装令牌不可用，请检查服务器是否已生成 data/setup-token.txt',
  [setupPolicy.SETUP_ERROR_CODES.TOKEN_INVALID]: '安装令牌不正确',
  [setupPolicy.SETUP_ERROR_CODES.ALREADY_INSTALLED]: '站点已完成安装，安装接口已关闭',
  [setupPolicy.SETUP_ERROR_CODES.DB_UNREACHABLE]: '数据库当前不可用（连接失败或账号认证失败），请先在第 2 步完成数据库连接配置',
  [setupPolicy.SETUP_ERROR_CODES.DB_CONFIG_INVALID]: '数据库连接配置不完整，请填写主机、用户名和数据库名',
  [setupPolicy.SETUP_ERROR_CODES.ADMIN_USERNAME_INVALID]: '用户名需为 3~32 位字母、数字、下划线、点或连字符',
  [setupPolicy.SETUP_ERROR_CODES.ADMIN_PASSWORD_WEAK]: '密码至少 8 位，且必须同时包含字母和数字',
  [setupPolicy.SETUP_ERROR_CODES.ADMIN_EMAIL_INVALID]: '邮箱格式无效',
  [setupPolicy.SETUP_ERROR_CODES.ADMIN_USERNAME_TAKEN]: '用户名或邮箱已被占用'
};

function setupErrorMessage(code) {
  return SETUP_ERROR_MESSAGES[code] || '安装流程出错';
}

/**
 * 闸门拒绝时的文案 —— 把数据库的原始错误附在后面。
 *
 * 「数据库当前不可用」这句提示太笼统：实际操作者要分清的是
 * 「连不上 / 账号认证不过」还是「连上了但判定 SQL 跑不通」，只有原始错误能说明白。
 */
function setupGateMessage(gate) {
  const state = (gate && gate.state) || {};
  let base = setupErrorMessage(gate && gate.code);

  // 状态是「无法判定」且数据库并不是「不可用」→ 数据库其实是通的，
  // 失败的是那条判定 SQL（例如列缺失、SQL 写错）。
  // 这时让操作者去「第 2 步改连接配置」是带偏的 —— 改配置解决不了 SQL 报错。
  if (gate && gate.code === setupPolicy.SETUP_ERROR_CODES.DB_UNREACHABLE
    && state.undetermined === true && state.dbUnreachable === false) {
    base = '数据库已连接，但判定安装状态失败，已暂停安装写操作';
  }

  const detail = state.error ? state.error : '';
  return detail ? base + '（' + detail + '）' : base;
}

/** 提取请求里的安装令牌（优先 header，避免令牌出现在会被记录的 body 里） */
function readSetupTokenFromRequest(req) {
  const fromHeader = req.get('X-Setup-Token');
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();
  if (req.body && typeof req.body.setupToken === 'string') return req.body.setupToken.trim();
  return '';
}

/**
 * 安装写操作的公共前置。
 * 顺序：先判「确实未安装」，再校验令牌 —— 已安装的站点不该再消耗令牌校验。
 */
async function requireSetupAccess(req, res, next) {
  try {
    const gate = await setupService.checkSetupWritable(db);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.code, message: setupGateMessage(gate) });
    }
    const tokenResult = setupService.verifySetupToken(readSetupTokenFromRequest(req));
    if (!tokenResult.ok) {
      return res.status(403).json({ error: tokenResult.code, message: setupErrorMessage(tokenResult.code) });
    }
    next();
  } catch (error) {
    console.error('[setup] 安装闸门异常:', error.message);
    res.status(500).json({ error: 'SETUP_GATE_ERROR', message: '安装闸门异常: ' + error.message });
  }
}

/**
 * 「改数据库配置」类操作的前置。
 *
 * 与 requireSetupAccess 的区别：数据库连不上时也放行 —— 数据库坏了恰恰是
 * 操作者需要用向导改配置来修的时刻，一刀切 fail-closed 会让向导在唯一该
 * 生效的场景里彻底没用。
 */
async function requireSetupConfig(req, res, next) {
  try {
    const gate = await setupService.checkSetupConfigWritable(db);
    if (!gate.ok) {
      return res.status(403).json({ error: gate.code, message: setupGateMessage(gate) });
    }
    const tokenResult = setupService.verifySetupToken(readSetupTokenFromRequest(req));
    if (!tokenResult.ok) {
      return res.status(403).json({ error: tokenResult.code, message: setupErrorMessage(tokenResult.code) });
    }
    next();
  } catch (error) {
    console.error('[setup] 配置闸门异常:', error.message);
    res.status(500).json({ error: 'SETUP_GATE_ERROR', message: '安装闸门异常: ' + error.message });
  }
}

/** 只校验令牌（用于只读的状态查询） */
function requireSetupToken(req, res, next) {
  const tokenResult = setupService.verifySetupToken(readSetupTokenFromRequest(req));
  if (!tokenResult.ok) {
    return res.status(403).json({ error: tokenResult.code, message: setupErrorMessage(tokenResult.code) });
  }
  next();
}

/** 对外的数据库配置视图 —— 不回显密码，只告诉界面「有没有配」 */
function sanitizeDbConfig(config) {
  const mysql = config && config.mysql ? config.mysql : {};
  return {
    type: 'mysql',
    mysql: {
      host: mysql.host || '',
      port: mysql.port || 3306,
      user: mysql.user || '',
      database: mysql.database || '',
      hasPassword: Boolean(mysql.password)
    }
  };
}

/** 组装给界面的安装状态 */
async function buildSetupPayload(state) {
  const schema = await setupService.describeSchema(db);
  const envState = envFile.readEnvFile();
  return {
    installed: state.installed,
    dbReachable: state.dbReachable,
    undetermined: state.undetermined,
    dbUnreachable: state.dbUnreachable === true,
    adminCount: state.adminCount,
    tablesReady: schema.tablesReady,
    missingTables: schema.missingTables,
    requiredTables: schema.requiredTables,
    configSource: db.getDbConfigSource(),
    dbConfig: sanitizeDbConfig(db.getDbConfig()),
    // .env 现状 —— 界面据此说明「哪些参数已经定下来了、哪些还要填」
    envFile: {
      exists: envState.exists,
      path: envFile.ENV_FILE,
      // 只列键名，不列值 —— 键名不敏感，值是密钥
      configuredKeys: Object.keys(envState.values).filter((key) => envState.values[key] !== ''),
      error: envState.error
    }
  };
}

// 安装向导页面
app.get('/setup', async (req, res) => {
  try {
    const state = await setupService.getSetupState(db, { force: true });
    if (state.installed) {
      return res.redirect(req.session && req.session.isAdmin ? '/admin-overview' : '/login');
    }
  } catch (error) {
    // 状态查不出来时仍然展示向导 —— 由页面的「测试连接」环节兜底
    console.error('[setup] 读取安装状态失败:', error.message);
  }
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// 校验安装令牌 —— 令牌正确才返回安装状态
app.post('/api/setup/verify-token', async (req, res) => {
  try {
    const tokenResult = setupService.verifySetupToken(readSetupTokenFromRequest(req));
    if (!tokenResult.ok) {
      return res.status(403).json({ error: tokenResult.code, message: setupErrorMessage(tokenResult.code) });
    }
    const state = await setupService.getSetupState(db, { force: true });
    if (state.installed) {
      return res.status(403).json({
        error: setupPolicy.SETUP_ERROR_CODES.ALREADY_INSTALLED,
        message: setupErrorMessage(setupPolicy.SETUP_ERROR_CODES.ALREADY_INSTALLED)
      });
    }
    res.json({ success: true, state: await buildSetupPayload(state) });
  } catch (error) {
    console.error('[setup] 校验令牌失败:', error.message);
    res.status(500).json({ error: 'SETUP_VERIFY_FAILED', message: error.message });
  }
});

// 安装状态（需要令牌）
app.get('/api/setup/status', requireSetupToken, async (req, res) => {
  try {
    const state = await setupService.getSetupState(db, { force: true });
    res.json({ success: true, state: await buildSetupPayload(state) });
  } catch (error) {
    console.error('[setup] 读取状态失败:', error.message);
    res.status(500).json({ error: 'SETUP_STATUS_FAILED', message: error.message });
  }
});

// 测试数据库连接
app.post('/api/setup/test-db', requireSetupConfig, async (req, res) => {
  const validated = setupPolicy.validateDbConfig(req.body);
  if (validated.error) {
    return res.status(400).json({ error: validated.error, message: setupErrorMessage(validated.error) });
  }
  const mysqlConfig = validated.config.mysql;
  if (!mysqlConfig.password) {
    // 界面不回显密码 —— 留空表示沿用已保存的密码
    const stored = db.getDbConfig();
    if (stored && stored.mysql && stored.mysql.password) {
      mysqlConfig.password = stored.mysql.password;
    }
  }
  try {
    const result = await db.testMySQLConnection(mysqlConfig);
    res.json({
      success: true,
      message: '连接成功',
      version: result.version,
      database: result.database
    });
  } catch (error) {
    res.status(400).json({
      error: setupPolicy.SETUP_ERROR_CODES.DB_UNREACHABLE,
      message: '连接失败: ' + error.message
    });
  }
});

// 保存数据库连接配置 —— 写进 .env（.env 是安装向导的产物）
//
// 这里**没有**「env 已接管就不让改」的锁：向导的目标本来就是 .env。
// 旧逻辑的 DB_CONFIG_ENV_LOCKED 是为了防止「界面改了不生效」，
// 现在界面改的就是 .env 本体，锁反而会让向导在修复场景下无路可走。
app.post('/api/setup/save-db-config', requireSetupConfig, async (req, res) => {
  const validated = setupPolicy.validateDbConfig(req.body);
  if (validated.error) {
    return res.status(400).json({ error: validated.error, message: setupErrorMessage(validated.error) });
  }

  const mysqlConfig = validated.config.mysql;
  if (!mysqlConfig.password) {
    // 界面不回显密码 —— 留空表示沿用已保存的密码
    const stored = db.getDbConfig();
    if (stored && stored.mysql && stored.mysql.password) {
      mysqlConfig.password = stored.mysql.password;
    }
  }

  const saved = envConfigService.saveDbConfigToEnv({ mysql: mysqlConfig });
  if (!saved.ok) {
    console.error('[setup] 写入 .env 失败:', saved.error);
    return res.status(500).json({ error: 'ENV_WRITE_FAILED', message: saved.error });
  }

  try {
    // 保存后立刻切换连接池 —— 否则下一步「初始化表结构」跑的仍然是旧库
    await db.reconnectWithConfig(mysqlConfig);
  } catch (error) {
    // 新配置连不上 → 回滚 .env 与进程 env，保留旧连接池，不能把站点带挂
    const rolled = envConfigService.rollbackDbConfigToEnv(saved);
    console.error('[setup] 保存数据库配置失败:', error.message);
    return res.status(400).json({
      error: setupPolicy.SETUP_ERROR_CODES.DB_UNREACHABLE,
      message: '保存失败，新配置无法连接数据库（已保留原配置）: ' + error.message
        + (rolled.ok ? '' : '；并且 .env 回滚也失败了，请手工检查 ' + envFile.ENV_FILE)
    });
  }

  setupService.invalidateState();
  res.json({
    success: true,
    message: '数据库配置已写入 .env 并生效',
    configSource: 'env',
    envPath: saved.envPath,
    // 会话密钥与 sessionPool 在启动时绑定 —— 连接参数当场生效，
    // 但要彻底对齐（含已登录会话）仍需重启。
    restartRequired: true,
    state: await buildSetupPayload(await setupService.getSetupState(db, { force: true }))
  });
});

// 初始化数据库 —— 建表 + 灌默认数据（全部幂等，可重复执行）
app.post('/api/setup/init-db', requireSetupAccess, async (req, res) => {
  try {
    await db.createTablesIfNotExist();
    await db.initDefaultData();
    setupService.invalidateState();
    const state = await setupService.getSetupState(db, { force: true });
    const integrity = await db.verifyDataIntegrity();
    res.json({
      success: true,
      message: '数据库初始化完成',
      state: await buildSetupPayload(state),
      tables: integrity.results
    });
  } catch (error) {
    console.error('[setup] 初始化数据库失败:', error.message);
    res.status(500).json({ error: 'SETUP_INIT_FAILED', message: '初始化失败: ' + error.message });
  }
});

// 创建首个管理员 —— 成功后销毁令牌，安装接口永久关闭
app.post('/api/setup/create-admin', requireSetupAccess, async (req, res) => {
  const validated = setupPolicy.validateAdminInput(req.body);
  if (validated.error) {
    return res.status(400).json({ error: validated.error, message: setupErrorMessage(validated.error) });
  }
  const { username, password, email } = validated.admin;

  try {
    if (await db.getUserByUsername(username)) {
      return res.status(409).json({
        error: setupPolicy.SETUP_ERROR_CODES.ADMIN_USERNAME_TAKEN,
        message: '用户名已被占用'
      });
    }
    if (email && await db.getUserByEmail(email)) {
      return res.status(409).json({
        error: setupPolicy.SETUP_ERROR_CODES.ADMIN_USERNAME_TAKEN,
        message: '邮箱已被注册'
      });
    }

    const userId = await db.addUser({
      username,
      password,
      email,
      phone: '',
      realName: '系统管理员',
      company: '',
      isAdmin: true,
      // 管理员是本机安装者本人创建的，不走邮箱验证流程
      emailVerified: 1
    });

    // 令牌销毁 + 状态缓存失效 —— 之后所有安装接口都返回 403
    setupService.consumeSetupToken();
    res.json({ success: true, message: '管理员创建成功', userId });
  } catch (error) {
    console.error('[setup] 创建管理员失败:', error.message);
    res.status(500).json({ error: 'SETUP_ADMIN_FAILED', message: '创建失败: ' + error.message });
  }
});

/**
 * 未安装闸门 —— 站点还没装好时，除安装相关路径外一律引导去 /setup。
 *
 * fail-open 还是 fail-closed：
 *   - 确定未安装 → 拦截（这正是要拦的情况）
 *   - 已安装     → 放行
 *   - 无法判定（DB 异常）→ 放行。DB 挂了站点本来也用不了，如果这里
 *     fail-closed，DB 抖一下整个站点跟着挂，可运维性太差。
 *     安装**写操作**另有 requireSetupAccess 闸门，那里的 fail-closed 才是关键。
 *
 * 「数据库连不上」单独处理：这时站点所有依赖数据库的功能都不可用，
 * 与其让每个接口各自抛 500，不如统一返回 503 并指向 /setup ——
 * 向导就是为「把数据库连回去」准备的。
 */
app.use(async (req, res, next) => {
  try {
    const state = await setupService.getSetupState(db);
    if (state.dbUnreachable) {
      if (req.path.startsWith('/api/')) {
        return res.status(503).json({ error: '数据库当前不可用', setupUrl: '/setup' });
      }
      return res.redirect('/setup');
    }
    if (state.installed || state.undetermined) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ error: '系统尚未完成初始化', setupUrl: '/setup' });
    }
    return res.redirect('/setup');
  } catch (error) {
    console.error('[setup] 安装状态检查失败:', error.message);
    return next();
  }
});

// 关于我们页面路由
app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

// ============================================================================
// 上传安全原语（B-4）
//
// 上传的落盘目录都在 public/ 之下，由 express.static 直出同源。
// 因此「谁能写进 public/」等价于「谁能往本站点注入脚本」——
// 传一个 logo.html 或 image.svg 就等于拿到同源 XSS。
//
// 三条铁律：
//   1. 扩展名用「锚定白名单」判定，不用子串正则（.jpg.exe / a.jpG 都要挡住）
//   2. 白名单里永远不要有 svg / html / js / php —— SVG 能内嵌 <script>
//   3. 落盘文件名只允许服务端生成的基名 + 白名单后缀，绝不复用 originalname
// ============================================================================

/** 扩展名归一：取最后一段、小写、只保留 a-z0-9。返回 '' 表示不可用。 */
function normalizeUploadExt(originalname) {
  const raw = path.extname(String(originalname || '')).toLowerCase();
  return /^\.[a-z0-9]+$/.test(raw) ? raw : '';
}

/**
 * 判断文件是否同时满足「扩展名在白名单」且「mimetype 属于该扩展名对应的类型」。
 * 只看其一都不够：扩展名可伪造，mimetype 也由客户端声明，
 * 但两者交叉校验能把「.svg 配 image/png」这类明显不一致挡掉。
 */
function isUploadAllowed(originalname, mimetype, rules) {
  const ext = normalizeUploadExt(originalname);
  if (!ext || !Object.prototype.hasOwnProperty.call(rules, ext)) return false;
  const mime = String(mimetype || '').toLowerCase();
  return rules[ext].includes(mime);
}

/** 图片类上传的白名单规则（不含 SVG —— SVG 是 XSS 载体）。 */
const IMAGE_UPLOAD_RULES = Object.freeze({
  '.jpg': ['image/jpeg', 'image/pjpeg'],
  '.jpeg': ['image/jpeg', 'image/pjpeg'],
  '.png': ['image/png', 'image/x-png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp']
});

/** 软件安装包白名单规则。 */
const SOFTWARE_UPLOAD_RULES = Object.freeze({
  '.exe': ['application/x-msdownload', 'application/octet-stream', 'application/vnd.microsoft.portable-executable', 'application/x-msdos-program'],
  '.msi': ['application/x-msi', 'application/x-msdownload', 'application/octet-stream', 'application/vnd.ms-package'],
  '.zip': ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
  '.rar': ['application/vnd.rar', 'application/x-rar-compressed', 'application/octet-stream'],
  '.7z': ['application/x-7z-compressed', 'application/octet-stream'],
  '.tar': ['application/x-tar', 'application/octet-stream'],
  '.gz': ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
  '.dmg': ['application/x-apple-diskimage', 'application/octet-stream'],
  '.pkg': ['application/x-newton-compatible-pkg', 'application/octet-stream'],
  '.deb': ['application/vnd.debian.binary-package', 'application/x-debian-package', 'application/octet-stream'],
  '.rpm': ['application/x-rpm', 'application/octet-stream'],
  '.appimage': ['application/x-executable', 'application/octet-stream'],
  '.apk': ['application/vnd.android.package-archive', 'application/octet-stream'],
  '.jar': ['application/java-archive', 'application/octet-stream'],
  '.war': ['application/java-archive', 'application/octet-stream'],
  '.pdf': ['application/pdf', 'application/octet-stream'],
  '.txt': ['text/plain', 'application/octet-stream'],
  '.doc': ['application/msword', 'application/octet-stream'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream'],
  '.xls': ['application/vnd.ms-excel', 'application/octet-stream'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/octet-stream']
});

/**
 * 允许删除的软件包扩展名 —— 直接由上传白名单推导。
 *
 * 上传白名单是权威：能传上去的文件必须删得掉。
 * 之前这里手写了一份更短的列表（只有 9 种），于是 .rar / .7z / .rpm /
 * .appimage / .jar / .war / .pdf / .txt / .doc / .docx / .xls / .xlsx
 * 这些类型传得上却删不掉 —— 传错的文件只能留在磁盘上，运营只能 SSH 上去手删。
 */
const SOFTWARE_DELETABLE_EXTENSIONS = Object.freeze(Object.keys(SOFTWARE_UPLOAD_RULES));

/** 允许删除的图片扩展名 —— 同样由上传白名单推导，避免两份列表各改各的。 */
const IMAGE_DELETABLE_EXTENSIONS = Object.freeze(Object.keys(IMAGE_UPLOAD_RULES));

/** 生成一个 fileFilter，失败时返回可读的 400 文案。 */
function buildUploadFilter(rules, rejectMessage) {
  return (req, file, cb) => {
    if (isUploadAllowed(file.originalname, file.mimetype, rules)) {
      return cb(null, true);
    }
    const err = new Error(rejectMessage);
    err.isUploadRejection = true;
    cb(err);
  };
}

/**
 * 统一的 multer 错误映射：把 fileFilter 拒绝 / 超限 / 字段缺失
 * 翻译成 400 / 413，而不是让 Express 兜底成 500。
 */
function multerErrorResponder(limitLabel) {
  return (err, req, res, next) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `文件过大，上限 ${limitLabel}` });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: '非预期的上传字段' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err && err.isUploadRejection) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[upload] 未预期的错误:', err);
    return res.status(500).json({ error: '上传失败' });
  };
}

// 文件上传配置 - Logo专用
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  filename: (req, file, cb) => {
    // 后缀只从白名单取，绝不复用 originalname 的扩展名
    const ext = normalizeUploadExt(file.originalname);
    const safeExt = Object.prototype.hasOwnProperty.call(IMAGE_UPLOAD_RULES, ext) ? ext : '.png';
    cb(null, 'logo' + safeExt);
  }
});

// Banner上传配置
const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  filename: (req, file, cb) => {
    const ext = normalizeUploadExt(file.originalname);
    const safeExt = Object.prototype.hasOwnProperty.call(IMAGE_UPLOAD_RULES, ext) ? ext : '.png';
    cb(null, 'banner-' + Date.now() + safeExt);
  }
});

// 产品描述图片上传配置
const productImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads', 'products'));
  },
  filename: (req, file, cb) => {
    const ext = normalizeUploadExt(file.originalname);
    const safeExt = Object.prototype.hasOwnProperty.call(IMAGE_UPLOAD_RULES, ext) ? ext : '.png';
    cb(null, 'product-img-' + Date.now() + safeExt);
  }
});

// 确保产品图片目录存在
const productImageDir = path.join(__dirname, 'public', 'uploads', 'products');
if (!fs.existsSync(productImageDir)) {
  fs.mkdirSync(productImageDir, { recursive: true });
}

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }, // 修复 B-4：logo 原先无任何上限
  fileFilter: buildUploadFilter(IMAGE_UPLOAD_RULES, '只允许上传图片文件 (jpg, jpeg, png, gif, webp)')
});

const uploadBanner = multer({
  storage: bannerStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 修复 B-4：banner 原先无任何上限
  fileFilter: buildUploadFilter(IMAGE_UPLOAD_RULES, '只允许上传图片文件 (jpg, jpeg, png, gif, webp)')
});

const uploadProductImage = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: buildUploadFilter(IMAGE_UPLOAD_RULES, '只允许上传图片文件 (jpg, jpeg, png, gif, webp)')
});

// Doc 图片上传配置 - public/uploads/doc-images/<yyyy>/<mm>/
const docImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dir = path.join(__dirname, 'public', 'uploads', 'doc-images', String(yyyy), mm);
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename: (req, file, cb) => {
    // 修复 B-4：移除 .svg —— SVG 可内嵌 <script>，直出即同源 XSS。
    // 白名单外的扩展名一律降级为 .bin，绝不原样落盘。
    const ext = normalizeUploadExt(file.originalname);
    const safeExt = Object.prototype.hasOwnProperty.call(IMAGE_UPLOAD_RULES, ext) ? ext : '.bin';
    const uuid = crypto.randomBytes(8).toString('hex');
    cb(null, `${uuid}${safeExt}`);
  }
});

const docImageUpload = multer({
  storage: docImageStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: buildUploadFilter(IMAGE_UPLOAD_RULES, '不支持的图片类型（不允许 SVG）')
});

// 数据库备份上传配置
const backupUpload = multer({
  dest: BACKUP_DIR,
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (normalizeUploadExt(file.originalname) !== '.sql') {
      return cb(new Error('Only .sql files allowed'));
    }
    cb(null, true);
  }
});

// 软件文件上传配置
const softwareStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads', 'software'));
  },
  filename: (req, file, cb) => {
    // 修复 B-4：不再复用原始扩展名，只认白名单
    const ext = normalizeUploadExt(file.originalname);
    const safeExt = Object.prototype.hasOwnProperty.call(SOFTWARE_UPLOAD_RULES, ext) ? ext : '.bin';
    cb(null, 'software-' + Date.now() + safeExt);
  }
});

// 确保软件目录存在
const softwareDir = path.join(__dirname, 'public', 'uploads', 'software');
if (!fs.existsSync(softwareDir)) {
  fs.mkdirSync(softwareDir, { recursive: true });
}

const uploadSoftware = multer({
  storage: softwareStorage,
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  fileFilter: buildUploadFilter(SOFTWARE_UPLOAD_RULES, '不支持的文件格式')
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
    res.redirect('/login');
  }
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

// 统一登录入口（管理员 + 普通用户）
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

  const { username, password } = req.body;

  if (!username || !password) {
    writeLoginLog('warn', clientIp, username || 'N/A', 'REJECTED', 'Missing credentials');
    db.addLoginLog(username || 'N/A', clientIp, req.headers['user-agent'] || '', 'REJECTED');
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  try {
  // 合并登录：users 表（含 is_admin 字段），支持用户名或邮箱
  const user = await db.verifyLogin(username, password);
  if (user) {
    // 邮箱验证校验（仅限非管理员且有邮箱的用户）
    const isAdmin = user.is_admin === 1;
    const hasEmail = user.email && user.email.trim() !== '';
    if (!isAdmin && hasEmail && user.email_verified !== 1) {
      writeLoginLog('warn', clientIp, username, 'REJECTED', 'Email not verified');
      db.addLoginLog(username, clientIp, req.headers['user-agent'] || '', 'REJECTED:邮箱未验证');
      return res.status(403).json({ error: '请先完成邮箱验证后再登录' });
    }

    clearLoginAttempts(clientIp);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = isAdmin;
    req.session.sessionVersion = currentSessionVersion;
    writeLoginLog('info', clientIp, username, 'SUCCESS',
      isAdmin ? 'Admin login successful' : 'User login successful');
    db.addLoginLog(username, clientIp, req.headers['user-agent'] || '', 'SUCCESS');
    res.json({ success: true, isAdmin: isAdmin });
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
  } catch (err) {
    console.error('[LOGIN] DB error during verifyLogin:', err.message);
    writeLoginLog('alert', clientIp, username, 'ERROR', `DB error: ${err.code || err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: '登录服务暂时不可用，请稍后重试' });
    }
  }
});

// 登出（GET 重定向到登录页）
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// 统一身份查询（合并登录后）— 扩展 email 用于侧栏头像
app.get('/api/auth/me', async (req, res) => {
  if (!req.session?.userId) {
    return res.json({
      loggedIn: false,
      isUser: false,
      isAdmin: false,
      userId: null,
      username: null,
      email: null
    });
  }
  try {
    const user = await db.getUserById(req.session.userId);
    if (!user) {
      return res.json({
        loggedIn: false,
        isUser: false,
        isAdmin: false,
        userId: null,
        username: null,
        email: null
      });
    }
    res.json({
      loggedIn: true,
      isUser: !!req.session.userId,
      isAdmin: !!req.session.isAdmin,
      userId: user.id,
      username: user.username,
      email: user.email || null
    });
  } catch (err) {
    console.error('[AUTH/ME] error:', err.message);
    res.status(500).json({ loggedIn: false, error: 'Internal error' });
  }
});

// ============ API路由 - 用户 ============

// 用户注册
app.post('/api/user/register', async (req, res) => {
  const { username, password, email, realName, company, phone } = req.body;
  const clientIp = getClientIp(req);

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: '密码至少 8 位' });
  }

  if (!realName && !company) {
    return res.status(400).json({ error: '姓名或公司名称至少填写一项' });
  }

  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: '邮箱格式无效' });
  }

  // 注册限流：全局 apiRateLimit 是 100 次/秒，对建号这种写操作形同虚设。
  // 检查放在任何 DB 访问之前 —— 被限流的请求不碰库，也不写 registration_logs
  // （否则限流器自己就能被拿来放大写库）。
  const registerRate = checkRegisterRateLimit(clientIp);
  if (!registerRate.allowed) {
    return res.status(429).json({
      error: '注册过于频繁，请稍后再试',
      retryAfter: registerRate.retryAfter
    });
  }

  // 检查用户名是否已存在
  if (await db.getUserByUsername(username)) {
    releaseRegisterRateLimit(clientIp);
    await db.addRegistrationLog(username, clientIp, req.headers['user-agent'] || '', 'FAILED:用户名已存在');
    return res.status(400).json({ error: '用户名已存在' });
  }

  // 检查邮箱是否已存在
  if (email && await db.getUserByEmail(email)) {
    releaseRegisterRateLimit(clientIp);
    await db.addRegistrationLog(username, clientIp, req.headers['user-agent'] || '', 'FAILED:邮箱已被注册');
    return res.status(400).json({ error: '邮箱已被注册' });
  }

  // 生成邮箱验证 token
  const verifyToken = crypto.randomUUID();
  const verifyExpiresAt = new Date(Date.now() + 24 * 3600 * 1000);

  const newUser = await db.addUser({
    username, password,
    email: email || '',
    realName: realName || '',
    company: company || '',
    phone: phone || '',
    emailVerified: 0,
    emailVerifyToken: verifyToken,
    emailVerifyExpiresAt: verifyExpiresAt
  });

  await db.addRegistrationLog(username, clientIp, req.headers['user-agent'] || '', 'SUCCESS');

  // 发送验证邮件（不阻塞响应，SMTP 未配置时静默失败）
  if (email) {
    const verifyUrl = `${req.protocol}://${req.get('host')}/verify-email?token=${verifyToken}`;
    sendEmail({
      to: email,
      subject: '请验证您的邮箱',
      text: `请点击链接完成验证（24 小时内有效）：\n${verifyUrl}`
    }).catch(err => {
      console.error('Verify email send error:', err);
    });
  }

  res.status(201).json({
    success: true,
    userId: newUser,
    message: email ? '请在 24 小时内查收邮件完成验证' : '注册成功（无邮箱，无需验证）'
  });
});

// 邮箱验证
app.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('链接无效');

    const user = await db.getUserByEmailVerifyToken(token);
    if (!user) return res.status(400).send('链接无效或已使用');

    if (user.emailVerifyExpiresAt && new Date(user.emailVerifyExpiresAt) < new Date()) {
      return res.status(400).send('链接已过期，请重新注册');
    }

    await db.markUserEmailVerified(user.id);

    res.redirect('/login?verified=1');
  } catch (e) {
    console.error('Verify email error:', e);
    res.status(500).send('验证失败');
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

  // 生成12位临时密码（修复 S5：用 crypto.randomBytes 替代 Math.random，避免 PRNG 预测）
  const tempPassword = crypto.randomBytes(9).toString('base64url').slice(0, 12);

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

// 获取当前用户的安全日志（仅本人）
app.get('/api/user/security-logs', requireUserAuth, async (req, res) => {
  try {
    const logs = await db.getLoginLogsByUsername(req.session.username, 20);
    res.json({ logs });
  } catch (error) {
    console.error('Error fetching user security logs:', error);
    res.status(500).json({ error: '获取安全日志失败' });
  }
});

// 获取当前用户的软件状态记录（我的软件）
app.get('/api/user/software-status', requireUserAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const userRows = await db.query("SELECT username FROM users WHERE id = ?", [userId]);
    if (userRows.length === 0) return res.status(404).json({ error: '用户不存在' });

    const items = await db.getUserSoftwareStatusByUser(userRows[0].username);
    res.json(items);
  } catch (e) {
    console.error('User software status error:', e);
    res.status(500).json({ error: '获取失败' });
  }
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
app.post('/api/telemetry', checkPublicEndpointRateLimit, async (req, res) => {
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

/**
 * 下单项的校验 + 价格重算（B-1 修复）已经抽到 lib/order-policy.js。
 *
 * 抽出去的原因：验证脚本要测同一份实现，不能再各写一份内联副本
 * （B-2 那轮踩过「内联副本和被测代码静默漂移」的坑）。
 *
 * 错误码（每条都映射一个稳定字符串，方便后续日志聚合与前台文案映射）：
 *   INVALID_ITEM / INVALID_PRODUCT_ID / INVALID_QUANTITY /
 *   INVALID_TIER_INDEX / PRODUCT_NOT_FOUND / PRODUCT_NOT_AVAILABLE /
 *   TIER_NOT_AVAILABLE / TIER_OUT_OF_RANGE / PRICE_NOT_AVAILABLE
 */

// 创建订单
app.post('/api/orders', requireUserAuth, async (req, res) => {
  const { items, paymentMethod } = req.body;

  // 基本结构校验
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '订单商品不能为空' });
  }
  if (items.length > 50) {
    return res.status(400).json({ error: '单次订单商品过多' });
  }

  // 校验 + 重算每条（任一条失败整批拒绝，避免半截订单）
  const normalizedItems = [];
  let serverTotal = 0;
  for (const rawItem of items) {
    let result;
    try {
      result = await resolveAndValidateOrderItem(rawItem, (id) => db.getProduct(id));
    } catch (err) {
      console.error('[POST /api/orders] validate error:', err);
      return res.status(500).json({ error: '订单校验失败' });
    }
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    normalizedItems.push(result.normalized);
    // 服务端累计金额（先乘 100 转分再加，避免浮点尾差）
    const lineTotal = Math.round(result.normalized.price * result.normalized.quantity * 100) / 100;
    serverTotal = Math.round((serverTotal + lineTotal) * 100) / 100;
  }

  // 生成订单编号: BL + 年月日时分秒 + 7位十六进制随机
  const now = new Date();
  const dateStr = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const orderNumber = 'BL' + dateStr + crypto.randomBytes(4).toString('hex').toUpperCase();

  // 写库只用服务端正本；完全不收客户端的 price / totalAmount / productName
  const order = await db.createOrder({
    userId: req.session.userId,
    items: normalizedItems,
    totalAmount: serverTotal,
    paymentMethod: paymentMethod,
    orderNumber: orderNumber
  });

  // 获取用户信息并发送订单确认邮件
  const user = await db.getUserById(req.session.userId);
  if (user && user.email) {
    // 异步发送邮件，不阻塞响应
    // createOrder 返回 { id, orderNumber }，补全 sendOrderConfirmationEmail 需要的字段
    const orderForEmail = {
      id: order.id,
      orderNumber: order.orderNumber,
      totalAmount: serverTotal,
      createdAt: now
    };
    sendOrderConfirmationEmail(orderForEmail, user, normalizedItems).catch(err => {
      console.error('Order email error:', err);
    });
  }

  writeOrderLog(order.id, 'ORDER_CREATED', user?.username || 'unknown', `New order created, amount: ¥${serverTotal}, payment: ${paymentMethod || 'bank_transfer'}`);

  // 响应里把服务端正本回给前端（前端用以更新 UI/历史）
  res.status(201).json({
    id: order.id,
    orderNumber: order.orderNumber,
    items: normalizedItems,
    totalAmount: serverTotal
  });
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

    // 更新订单状态并保存激活码（条件 UPDATE 防并发）
    let updatedOrder;
    try {
      updatedOrder = await db.updateOrderStatus(order.id, 'paid', verificationCode, activationCodes);
    } catch (e) {
      if (e.message === 'ORDER_ALREADY_PROCESSED') {
        return res.status(400).json({ error: '订单已支付或状态不允许' });
      }
      throw e;
    }

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

// 管理员确认收款（为订单生成激活码、标记为已支付、发邮件）
app.post('/api/admin/orders/:id/approve-payment', requireAuth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);

    // 查订单
    const orderRows = await db.query("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (orderRows.length === 0) return res.status(404).json({ error: '订单不存在' });
    const order = orderRows[0];

    if (order.status === 'paid' || order.status === 'completed') {
      return res.status(400).json({ error: '订单已支付' });
    }

    // 修复 I14: 用事务包裹"更新订单状态 + 写入激活码"两步,防中途失败导致部分激活
    const items = await db.getOrderItems(orderId);
    const generatedCodes = await db.withTransaction(async (conn) => {
      const [updateResult] = await conn.query(
        "UPDATE orders SET status='paid', paid_at=NOW() WHERE id = ? AND status NOT IN ('paid','completed')",
        [orderId]
      );
      if (!updateResult.affectedRows) {
        throw new Error('ORDER_ALREADY_PROCESSED');
      }
      const codes = [];
      for (const item of items) {
        const code = generateActivationCodes(1)[0];
        await conn.query(
          "INSERT INTO order_item_codes (order_item_id, code, is_activated) VALUES (?, ?, 0)",
          [item.id, code]
        );
        codes.push({ productShortName: item.productShortName, code });
      }
      return codes;
    }).catch(err => {
      if (err.message === 'ORDER_ALREADY_PROCESSED') {
        // 上层会处理这个状态
        throw err;
      }
      throw err;
    });

    // 发邮件给用户
    // 注: order.* 来自 db.getOrder() 直接 row map,DB 列名保持 snake_case(user_id / created_at 等)
    //     getOrder() 已在 db.js 内做一次映射,对外暴露 camelCase;此处是内部 helper 链,无需二次转换
    const userRows = await db.query("SELECT email FROM users WHERE id = ?", [order.user_id]);
    if (userRows.length > 0 && userRows[0].email) {
      const codeList = generatedCodes.map(c => `  ${c.productShortName}: ${c.code}`).join('\n');
      await sendEmail({
        to: userRows[0].email,
        subject: `订单 #${order.order_number} 已确认收款`,
        text: `您的订单已确认收款，激活码如下：\n${codeList}\n\n请在软件中输入激活码完成激活。`
      });
    }

    writeOperationLog('APPROVE_PAYMENT', req.session.username, `Order #${orderId}`);

    res.json({ success: true, codes: generatedCodes });
  } catch (e) {
    if (e.message === 'ORDER_ALREADY_PROCESSED') {
      return res.status(400).json({ error: '订单已支付或状态不允许' });
    }
    console.error('Approve payment error:', e);
    res.status(500).json({ error: '确认收款失败' });
  }
});

// 管理员：列出所有用户软件状态
app.get('/api/admin/user-software-status', requireAuth, async (req, res) => {
  try {
    const items = await db.getAllUserSoftwareStatus();
    res.json(items);
  } catch (e) {
    console.error('Admin list user software status error:', e);
    res.status(500).json({ error: '获取失败' });
  }
});

// 管理员：锁定 USS（lock=2）
app.post('/api/admin/user-software-status/:id/lock', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 ID' });
    await db.lockUserSoftwareStatus(id, 2);
    writeOperationLog('ADMIN_LOCK', req.session.username, `USS #${id}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Admin lock error:', e);
    res.status(500).json({ error: '锁定失败' });
  }
});

// 管理员：解锁 USS（lock=0）
app.post('/api/admin/user-software-status/:id/unlock', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 ID' });
    // 解锁同时延长到期日 30 天（避免下次 cron 立即重新锁定）
    await db.query(
      "UPDATE user_software_status SET `lock` = 0, expire_date = DATE_ADD(GREATEST(expire_date, NOW()), INTERVAL 30 DAY) WHERE id = ?",
      [id]
    );
    writeOperationLog('ADMIN_UNLOCK', req.session.username, `USS #${id} (extended 30d)`);
    res.json({ success: true });
  } catch (e) {
    console.error('Admin unlock error:', e);
    res.status(500).json({ error: '解锁失败' });
  }
});

/**
 * 从 PayPal webhook resource 中解析「实际收到的金额」与「币种」（B-2）
 *
 * PayPal 两种事件形态的 resource 结构不同：
 *   - CHECKOUT.ORDER.COMPLETED  : resource.amount = { value: "9.99", currency_code: "CNY" }
 *                                  或 resource.purchase_units[0].amount = { ... }
 *   - PAYMENT.CAPTURE.COMPLETED: resource.amount = { value: "9.99", currency_code: "CNY" }
 *                                  （capture 事件字段在顶层）
 *   - 旧版 / 部分场景           : resource.amount = "9.99"（纯字符串） + resource.currency_code
 *
 * 返回 { amount: Number, currency: string } 或 null（解析不出来）。
 * 一律以「分」为单位比较，避免浮点尾差导致 9.99 !== 9.99 的误判。
 */
function extractPayPalAmount(resource) {
  if (!resource || typeof resource !== 'object') return null;

  // 候选金额来源，按优先级
  const amountSources = [
    resource.amount,                                   // v2: { value, currency_code }
    resource.purchase_units?.[0]?.amount              // v2: 挂在 purchase_units 上
  ];

  for (const src of amountSources) {
    if (!src) continue;

    // 形态 1: { value: "9.99", currency_code: "CNY" }
    if (typeof src === 'object' && typeof src.value === 'string') {
      const parsed = Number(src.value);
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      const currency = src.currency_code
        || resource.currency_code
        || resource.purchase_units?.[0]?.amount?.currency_code
        || null;
      if (!currency) return null;
      return { amount: parsed, currency };
    }

    // 形态 2: 纯字符串 "9.99"（此时币种在 resource.currency_code）
    if (typeof src === 'string') {
      const parsed = Number(src);
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      const currency = resource.currency_code || null;
      if (!currency) return null;
      return { amount: parsed, currency };
    }
  }

  return null;
}

// PayPal webhook（修复 S2：强制签名校验，fail-closed if PAYPAL_WEBHOOK_ID 未配置）
// B-2 修复：验签之后、置 paid 之前，必须比对实付金额与订单金额
app.post('/api/paypal/webhook', async (req, res) => {
  try {
    // 修复 S2：必须先验证签名，再处理业务逻辑
    // req.rawBody 由全局 express.json 的 verify 回调注入（Buffer）
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const verification = await verifyPayPalWebhook(req.headers, rawBody);

    const { event_type, resource } = req.body || {};

    // 审计日志：记录所有尝试（无论验证是否通过）
    writeOperationLog(
      'PAYPAL_WEBHOOK_ATTEMPT',
      'paypal',
      `Event: ${event_type || 'unknown'}, Verified: ${verification.valid}, Reason: ${verification.error || 'ok'}`
    );

    if (!verification.valid) {
      return res.status(401).json({ error: 'Invalid signature', reason: verification.error });
    }

    // 只处理支付完成事件
    if (event_type !== 'CHECKOUT.ORDER.COMPLETED' && event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
      return res.json({ received: true, processed: false });
    }

    // 提取 custom_id（即 orderId）
    const customId = resource?.custom_id || resource?.purchase_units?.[0]?.custom_id;
    if (!customId) {
      return res.status(400).json({ error: 'No custom_id' });
    }

    // custom_id 必须是纯数字串，避免 "57abc" 被 parseInt 截断成 57 而命中他人订单
    if (!/^\d+$/.test(String(customId))) {
      return res.status(400).json({ error: 'Malformed custom_id' });
    }

    const orderId = parseInt(customId, 10);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'Malformed custom_id' });
    }

    const orderRows = await db.query("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (orderRows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderRows[0];

    // ===== B-2 修复：金额与币种强校验 =====
    // 签名有效只证明「这确实是 PayPal 发的」，不证明「金额正确」。
    // 若不比对，任何人可用 ¥0.01 的 PayPal 订单触发任意高额订单发货。
    const paid = extractPayPalAmount(resource);
    if (!paid) {
      writeOperationLog(
        'PAYPAL_AMOUNT_MISSING',
        'paypal',
        `Order #${orderId}: cannot parse amount from resource`
      );
      return res.status(400).json({
        error: 'Amount missing in webhook payload',
        orderId
      });
    }

    const expectedAmount = Number(order.total_amount);
    if (!Number.isFinite(expectedAmount) || expectedAmount < 0) {
      // 订单自身金额异常（脏数据），同样 fail-closed
      writeOperationLog(
        'PAYPAL_AMOUNT_MISMATCH',
        'paypal',
        `Order #${orderId}: order.total_amount is invalid (${order.total_amount})`
      );
      return res.status(400).json({ error: 'Order amount is invalid', orderId });
    }

    if (paid.currency !== 'CNY') {
      writeOperationLog(
        'PAYPAL_CURRENCY_MISMATCH',
        'paypal',
        `Order #${orderId}: expected CNY, got ${paid.currency} ${paid.amount}`
      );
      return res.status(400).json({
        error: 'Currency mismatch',
        expected: 'CNY',
        received: paid.currency,
        orderId
      });
    }

    // 以「分」为最小单位做整数比较，杜绝浮点尾差
    const receivedCents = Math.round(paid.amount * 100);
    const expectedCents = Math.round(expectedAmount * 100);
    if (receivedCents !== expectedCents) {
      writeOperationLog(
        'PAYPAL_AMOUNT_MISMATCH',
        'paypal',
        `Order #${orderId}: expected ${expectedAmount} CNY (${expectedCents} cents), got ${paid.amount} CNY (${receivedCents} cents)`
      );
      return res.status(400).json({
        error: 'Amount mismatch',
        expected: expectedAmount,
        received: paid.amount,
        currency: paid.currency,
        orderId
      });
    }
    // ===== B-2 修复结束 =====

    // 幂等性：已处理过
    if (order.status === 'paid' || order.status === 'completed') {
      return res.json({ received: true, alreadyProcessed: true });
    }

    // 条件更新订单状态为 paid（防并发）
    const updateResult = await db.query(
      "UPDATE orders SET status='paid', paid_at=NOW(), payment_method='paypal', paypal_order_id=? WHERE id = ? AND status NOT IN ('paid','completed')",
      [resource.id || null, orderId]
    );
    if (!updateResult.affectedRows) {
      return res.json({ received: true, alreadyProcessed: true });
    }

    // 为每个 order_item 生成激活码
    const items = await db.getOrderItems(orderId);
    const generatedCodes = [];
    for (const item of items) {
      const code = generateActivationCodes(1)[0];
      await db.createOrderItemCode({ orderItemId: item.id, code });
      generatedCodes.push({ productShortName: item.productShortName, code });
    }

    // 发邮件
    // 注: order.* 来自 db.getOrder() 直接 row map,DB 列名保持 snake_case
    const userRows = await db.query("SELECT email FROM users WHERE id = ?", [order.user_id]);
    if (userRows.length > 0 && userRows[0].email) {
      const codeList = generatedCodes.map(c => `  ${c.productShortName}: ${c.code}`).join('\n');
      await sendEmail({
        to: userRows[0].email,
        subject: `订单 #${order.order_number} 支付成功`,
        text: `您的订单已支付成功，激活码如下：\n${codeList}\n\n请在软件中输入激活码完成激活。`
      });
    }

    writeOperationLog('PAYPAL_WEBHOOK', 'paypal', `Order #${orderId}`);

    res.json({ received: true, processed: true });
  } catch (e) {
    console.error('PayPal webhook error:', e);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Cron: 自动锁定过期记录（每日运行）
app.post('/api/cron/expire-check', async (req, res) => {
  try {
    const token = req.headers['x-cron-token'] || req.query.token;
    const expectedToken = process.env.CRON_TOKEN;
    if (!expectedToken) {
      console.error('CRON_TOKEN env var is not configured');
      return res.status(500).json({ error: 'Server misconfigured' });
    }
    if (token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await db.query(
      "UPDATE user_software_status SET `lock` = 1 WHERE expire_date < NOW() AND `lock` = 0"
    );
    const count = result.affectedRows || 0;

    writeOperationLog('CRON_EXPIRE_CHECK', 'system', `Locked ${count} records`);

    res.json({ success: true, lockedCount: count });
  } catch (e) {
    console.error('Cron expire check error:', e);
    res.status(500).json({ error: 'Cron failed' });
  }
});

// Cron: 到期前 15 天邮件提醒（每日运行）
app.post('/api/cron/expiry-reminder', async (req, res) => {
  try {
    const token = req.headers['x-cron-token'] || req.query.token;
    const expectedToken = process.env.CRON_TOKEN;
    if (!expectedToken) {
      console.error('CRON_TOKEN env var is not configured');
      return res.status(500).json({ error: 'Server misconfigured' });
    }
    if (token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const expiring = await db.findExpiringSoon(15);
    let sentCount = 0;

    for (const item of expiring) {
      if (!item.email) continue;

      const expireDateStr = item.expireDate ? new Date(item.expireDate).toISOString().split('T')[0] : '未知';
      await sendEmail({
        to: item.email,
        subject: `${item.softwareShortName} 即将到期提醒`,
        text: `您的 ${item.softwareShortName} 软件将在 15 天后（${expireDateStr}）到期。\n请及时续费以免影响使用。`
      });

      await db.markReminderSent(item.id);
      sentCount++;
    }

    writeOperationLog('CRON_EXPIRY_REMINDER', 'system', `Sent ${sentCount} reminders`);

    res.json({ success: true, sentCount });
  } catch (e) {
    console.error('Cron expiry reminder error:', e);
    res.status(500).json({ error: 'Cron failed' });
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

  // 生成5位数验证码（修复 S5：用 crypto.randomInt 替代 Math.random）
  const code = String(crypto.randomInt(0, 100000)).padStart(5, '0');

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
    res.status(500).json({ error: '服务器错误' });
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
    const { activationCode, macAddress, userName, userEmail } = req.body;
    const clientIp = getClientIp(req);

    // 1. 校验
    if (!activationCode) return res.status(400).json({ error: '请输入激活码' });
    if (!isValidActivationCode(activationCode)) {
      writeOperationLog('ACTIVATE_FAILED', 'unknown', 'Invalid format');
      return res.status(400).json({ error: '激活码格式无效' });
    }
    if (macAddress && !isValidMacAddress(macAddress)) {
      return res.status(400).json({ error: 'MAC 地址格式无效' });
    }
    if (userEmail && !isValidEmail(userEmail)) {
      return res.status(400).json({ error: '邮箱格式无效' });
    }

    writeOperationLog('ACTIVATE_ATTEMPT', `IP: ${clientIp}`, `Email: ${userEmail || 'N/A'}`);

    // 2. 查激活码
    const codeRecord = await db.findOrderItemCodeByCode(activationCode);
    if (!codeRecord) {
      return res.status(404).json({ error: '激活码无效' });
    }

    // 3. 检查是否已使用
    if (codeRecord.isActivated) {
      return res.status(400).json({ error: '该激活码已使用，每个激活码仅可使用一次' });
    }

    // 4. 检查订单状态
    if (codeRecord.orderStatus !== 'paid' && codeRecord.orderStatus !== 'completed') {
      return res.status(400).json({ error: '订单未支付' });
    }

    // 5. 查订单用户
    const orderUserRows = await db.query("SELECT username, email FROM users WHERE id = ?", [codeRecord.orderUserId]);
    if (orderUserRows.length === 0) return res.status(400).json({ error: '订单用户不存在' });
    const orderUser = orderUserRows[0];

    // 6. 校验邮箱一致性（强制：userEmail 与 orderUser.email 必须同时提供且匹配）
    //    修复 S1：原来 `if (userEmail && orderUser.email && ...)` 在任一为空时静默跳过
    //    → 攻击者拿到有效激活码后不传 userEmail 即可绕过反钓鱼保护
    if (!userEmail || !orderUser.email || userEmail.toLowerCase() !== orderUser.email.toLowerCase()) {
      writeOperationLog('ACTIVATE_FAILED', `IP: ${clientIp}`, `Email mismatch: provided=${userEmail ? 'yes' : 'no'}, orderEmail=${orderUser.email ? 'yes' : 'no'}`);
      return res.status(403).json({ error: '邮箱与购买账户不一致' });
    }

    // 7. 查 user_software_status（必须先安装）
    const effectiveUserName = orderUser.username;
    const status = await db.getUserSoftwareStatus(effectiveUserName, codeRecord.productShortName);
    if (!status) {
      return res.status(400).json({ error: '请先安装软件后再激活' });
    }

    // 8. 原子标记 code 已用：只在 is_activated=0 时才更新，返回受影响行数
    const markResult = await db.query(
      "UPDATE order_item_codes SET is_activated = 1, activated_at = NOW(), activated_by_user = ?, activated_by_mac = ? WHERE id = ? AND is_activated = 0",
      [effectiveUserName, macAddress || '', codeRecord.id]
    );
    if (!markResult.affectedRows) {
      return res.status(400).json({ error: '激活码已被使用' });
    }

    // 9. 调用 db.addUserSoftwareActivation 写 USS (sliding add)
    const activationResult = await db.addUserSoftwareActivation(
      effectiveUserName,
      codeRecord.productShortName,
      codeRecord.durationDays
    );

    // 10. 写 activations 历史
    await db.query(
      `INSERT INTO activations (user_name, organization, email, software_name, mac_address, install_date, activate_date, expire_date, activation_key, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        effectiveUserName,
        '',
        userEmail || orderUser.email,
        codeRecord.productShortName,
        macAddress || '',
        new Date().toISOString().split('T')[0],
        new Date().toISOString().split('T')[0],
        new Date(activationResult.expireDate).toISOString().split('T')[0],
        activationCode
      ]
    );

    // 11. 写 activation_logs
    await db.query(
      "INSERT INTO activation_logs (mac_address, software_name, activation_key, status, ip) VALUES (?, ?, ?, ?, ?)",
      [
        macAddress || '',
        codeRecord.productShortName,
        activationCode,
        activationResult.isRenewal ? 'RENEWAL' : 'SUCCESS',
        clientIp
      ]
    );

    // 12. 返回
    res.json({
      success: true,
      message: activationResult.isRenewal ? '续期成功' : '激活成功',
      softwareName: codeRecord.productShortName,
      duration: codeRecord.durationDays,
      totalDays: codeRecord.durationDays,
      activateDate: new Date().toISOString(),
      expireDate: new Date(activationResult.expireDate).toISOString(),
      isRenewal: activationResult.isRenewal
    });

    writeOperationLog('ACTIVATE', userEmail || 'N/A', `Code: ${activationCode.substring(0,4)}***, Software: ${codeRecord.productShortName}`);
  } catch (e) {
    console.error('Activate error:', e);
    res.status(500).json({ error: '激活失败，请稍后重试' });
  }
});

// 获取所有激活记录（管理员）
// 修复 I17: 旧实现全表 getAllActivations + 每条 N+1 findOrderByActivationCode。
// 加 limit/offset 防 1000+ 记录时单请求 3000+ query。
app.get('/api/activations', requireAuth, async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const activations = await db.getAllActivations({ limit, offset });

  // 丰富每条激活记录，关联订单信息计算过期日期
  const enrichedActivations = await Promise.all(activations.map(async (activation) => {
    const result = { ...activation };

    // 如果有激活码，查找对应订单并使用滑动窗口模型计算过期日期
    if (activation.activationKey) {
      const order = await db.findOrderByActivationCode(activation.activationKey);
      if (order && order.items && order.items.length > 0) {
        const firstItem = order.items[0];
        const duration = firstItem.duration || '永久授权';
        const purchasedDays = parseDurationToDays(duration);

        // 获取当前 installations 表中的有效期（用于滑动窗口计算）
        const today = new Date();
        let existingInstallation = null;

        // 尝试获取安装记录
        if (activation.macAddress) {
          existingInstallation = await db.getInstallationByMacAndSoftware(activation.macAddress, activation.softwareName);
        }
        if (!existingInstallation && order.userId) {
          const user = await db.getUserById(order.userId);
          if (user && user.email) {
            existingInstallation = await db.getExistingInstallation(activation.softwareName, user.email);
          }
        }

        // 使用滑动窗口模型计算过期日期
        const { expireDate: calculatedExpireDate, isRenewal } = calculateSlidingWindowExpiry(
          existingInstallation ? existingInstallation.expireDate : null,
          purchasedDays,
          today
        );

        const isExpired = calculatedExpireDate < today;

        result.orderInfo = {
          softwareName: firstItem.name,
          duration: duration,
          totalDays: purchasedDays,
          paidDate: order.paidAt ? new Date(order.paidAt).toISOString() : null,
          paidAt: order.paidAt,
          calculatedExpireDate: calculatedExpireDate.toISOString(),
          isExpired: isExpired,
          isRenewal: isRenewal,
          remainingDays: Math.max(0, Math.ceil((calculatedExpireDate - today) / (24 * 60 * 60 * 1000)))
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

  if (!Object.values(ACTIVATION_STATUS).includes(status)) {
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
app.post('/api/install', checkPublicEndpointRateLimit, async (req, res) => {
  try {
    const { userName, userEmail, softwareName, organization, macAddress } = req.body;
    const clientIp = getClientIp(req);

    if (!userName || !userEmail || !softwareName) {
      return res.status(400).json({ error: '用户名、邮箱、软件名必填' });
    }

    // 查产品 short_name
    const product = await db.getProductByShortName(softwareName);
    if (!product) {
      return res.status(400).json({ error: '软件不存在' });
    }

    writeOperationLog('INSTALL_ATTEMPT', `IP: ${clientIp}`, `Software: ${softwareName}, User: ${userEmail}`);

    // 写 user_software_status (幂等 UPSERT)
    const status = await db.addUserSoftwareInstall(userName, product.shortName);

    res.json({
      success: true,
      firstRun: status.firstRun,
      status: 'installed',
      softwareName: product.shortName
    });

    writeOperationLog('INSTALL', userEmail, `Software: ${product.shortName}`);
  } catch (e) {
    console.error('Install error:', e);
    res.status(500).json({ error: '安装记录失败' });
  }
});

// 软件心跳（公开）— 客户端轮询查询 device_software_expire 状态，用于核对
app.post('/api/heartbeat', checkPublicEndpointRateLimit, async (req, res) => {
  try {
    const { softwareShortName, macAddress } = req.body;
    if (!softwareShortName || !macAddress) {
      return res.status(400).json({ error: 'softwareShortName 和 macAddress 必填' });
    }
    const records = await db.heartbeatDevice(softwareShortName, macAddress);
    res.json({
      found: records.length > 0,
      count: records.length,
      softwareShortName,
      macAddress,
      records
    });
  } catch (e) {
    console.error('Heartbeat error:', e);
    res.status(500).json({ error: '心跳查询失败' });
  }
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

// ============ API路由 - 产品 ============

// 公开：产品列表页
app.get('/product/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'product-list.html'));
});

// 获取产品列表（公开，支持分页 + 过滤）
app.get('/api/products', checkPublicEndpointRateLimit, async (req, res) => {
  try {
    const { isCourse, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
    const isCourseFilter = isCourse === 'true' ? true : isCourse === 'false' ? false : null;
    const result = await db.getProductsPaginated({
      isCourse: isCourseFilter,
      search: search || '',
      page,
      pageSize,
      // 前台只显示已上架的产品；草稿 / 已下架的由后台接口提供
      status: 1
    });
    res.json(result);
  } catch (e) {
    console.error('GET /api/products error:', e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取单个产品
app.get('/api/products/:id', async (req, res) => {
  // parseInt + 范围校验,避免字符串 ID 走 SQL 隐式转换(性能 + 类型安全)
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '无效的产品 ID' });
  }
  const product = await db.getProduct(id);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  // 草稿 / 已下架的产品对前台不可见（与 /api/news/:slug 的处理一致，防泄露）
  if (product.status !== 'published') {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json(product);
});

// 公开：列出产品的已发布文档
app.get('/api/products/:slug/docs', async (req, res) => {
  try {
    const product = await db.getProductByShortName(req.params.slug);
    if (!product) return res.status(404).json({ error: '产品不存在' });
    // 草稿 / 已下架的产品连同它的文档一起对前台隐藏
    if (product.status !== 'published') return res.status(404).json({ error: '产品不存在' });
    const docs = await db.listPublishedProductDocs(product.id);
    res.json(docs);
  } catch (e) {
    console.error('GET /api/products/:slug/docs error:', e);
    res.status(500).json({ error: '获取文档列表失败' });
  }
});

// 公开：单篇已发布文档详情
app.get('/api/docs/:productSlug/:docSlug', async (req, res) => {
  try {
    const doc = await db.getPublishedProductDoc(req.params.productSlug, req.params.docSlug);
    if (!doc) return res.status(404).json({ error: '文档不存在或未发布' });
    res.json(doc);
  } catch (e) {
    console.error('GET /api/docs/:productSlug/:docSlug error:', e);
    res.status(500).json({ error: '获取文档失败' });
  }
});

// ============ 动态（News）公开 API ============

// 公开：列出已发布动态（支持 category + 分页）
app.get('/api/news', async (req, res) => {
  try {
    const { category, page, pageSize } = req.query;
    const news = await db.getPublishedNews({
      category: category || null,
      page: parseInt(page, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 12
    });
    res.json(news);
  } catch (err) {
    console.error('[public news list]', err);
    res.status(500).json({ error: '加载失败' });
  }
});

// 公开：动态详情（按 slug）。仅返回已发布；草稿/已撤稿一律 404（防止泄露）
app.get('/api/news/:slug', async (req, res) => {
  try {
    const news = await db.getNewsBySlug(req.params.slug);
    if (!news || news.status !== 'published') return res.status(404).json({ error: '动态不存在' });
    res.json(news);
  } catch (err) {
    console.error('[public news detail]', err);
    res.status(500).json({ error: '加载失败' });
  }
});

// 公开：阅读量原子自增（每 IP 30/min，公共端点限流 S12/S13 模式）
app.post('/api/news/:id/view', checkPublicEndpointRateLimit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    await db.incrementNewsView(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[public news view]', err);
    res.status(500).json({ error: '更新阅读量失败' });
  }
});

// 添加产品（需登录）
app.post('/api/products', requireAuth, async (req, res) => {
  const { name, shortName, category, price, pricingTiers, description, version, platform, features, icon, featured, downloadUrl, externalLink, detailPage, image, imageDarkBg, isCourse, isSharedCode, courseLinks, repoUrls } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  // 类型矩阵（课程型 / 共享代码 / 开源产品 → 免费、仓库校验、两者互斥）
  // 改走 lib/product-policy.js 的共享实现 —— MCP 的 create_product 用的是同一份，
  // 规则只有一处，不会漂移。抛出的 ContentPolicyError.message 与原内联实现逐字一致，
  // 所以前端看到的报错文案不变。
  let productType;
  try {
    productType = resolveProductType({
      category,
      isCourse,
      isSharedCode,
      repoUrls,
      price,
      pricingTiers,
      downloadUrl,
      externalLink
    });
  } catch (err) {
    if (err instanceof ContentPolicyError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const newProduct = await db.addProduct({
    name,
    shortName: shortName || '',
    category: productType.category,
    price: productType.price,
    pricingTiers: productType.pricingTiers,
    description: description || '',
    version: version || '1.0.0',
    platform: platform || 'Windows',
    features: features || [],
    icon: icon || 'software',
    featured: featured || false,
    downloadUrl: productType.downloadUrl,
    externalLink: productType.externalLink,
    detailPage: detailPage || '',
    image: image || '',
    imageDarkBg: imageDarkBg || false,
    isCourse: productType.isCourse,
    isSharedCode: productType.isSharedCode,
    courseLinks: Array.isArray(courseLinks) ? courseLinks : [],
    repoUrls: productType.repoUrls
  });

  res.status(201).json(newProduct);
  // 记录操作日志
  const username = req.session.userName || req.session.username || 'admin';
  db.addOperationLog(username, 'PRODUCT_CREATE', newProduct.id, `Created product: ${name}, Price: ${price}`);
});

// 更新产品（需登录）
app.put('/api/products/:id', requireAuth, async (req, res) => {
  const { name, shortName, category, price, pricingTiers, description, version, platform, features, icon, featured, downloadUrl, externalLink, detailPage, image, imageDarkBg, isCourse, isSharedCode, courseLinks, repoUrls } = req.body;

  const updates = {};
  if (name) updates.name = name;
  if (shortName !== undefined) updates.shortName = shortName;
  if (category !== undefined) updates.category = category;
  if (price !== undefined) updates.price = parseFloat(price);
  if (pricingTiers !== undefined) updates.pricingTiers = pricingTiers;
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
  if (isCourse !== undefined) updates.isCourse = isCourse === true || isCourse === 1;
  if (isSharedCode !== undefined) updates.isSharedCode = isSharedCode === true || isSharedCode === 1;
  if (courseLinks !== undefined) updates.courseLinks = Array.isArray(courseLinks) ? courseLinks : [];
  if (repoUrls !== undefined) {
    if (!Array.isArray(repoUrls)) {
      return res.status(400).json({ error: 'repoUrls 必须是数组' });
    }
    updates.repoUrls = repoUrls.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u.trim()));
  }
  // 互斥防御：isCourse 与 isSharedCode 不能同时为 true
  if (updates.isCourse === true && updates.isSharedCode === true) {
    return res.status(400).json({ error: '课程型与共享代码不能同时启用' });
  }
  // 开源/共享代码校验：必须至少 1 个仓库地址
  const targetCategory = updates.category;
  const needRepo = targetCategory === '开源产品' || updates.isSharedCode === true;
  if (needRepo && (!updates.repoUrls || updates.repoUrls.length === 0)) {
    const existing = await db.getProduct(req.params.id);
    if (!existing || !Array.isArray(existing.repoUrls) || existing.repoUrls.length === 0) {
      return res.status(400).json({ error: '开源/共享代码产品至少需要一个仓库地址' });
    }
    updates.repoUrls = existing.repoUrls;
  }
  // 共享代码 / 开源产品清零价格字段
  if (updates.isSharedCode === true || targetCategory === '开源产品') {
    updates.price = 0;
    updates.pricingTiers = null;
    updates.downloadUrl = '';
    updates.externalLink = false;
  }
  // 兜底：products.price 列 NOT NULL。若前端没传 price 但传了 pricingTiers（或
  // 漏传任一字段），必须设个合法值，否则 mysql2 把 undefined → NULL → 报错。
  if (updates.price === undefined || updates.price === null || Number.isNaN(updates.price)) {
    if (Array.isArray(updates.pricingTiers) && updates.pricingTiers.length > 0) {
      updates.price = 0;
    } else {
      return res.status(400).json({ error: '请填写产品基础价格' });
    }
  }

  try {
    const updated = await db.updateProduct(req.params.id, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Product not found' });
    }
    // 记录操作日志
    const username = req.session.userName || req.session.username || 'admin';
    db.addOperationLog(username, 'PRODUCT_UPDATE', req.params.id, `Updated product: ${name || updated.name}, Price: ${price || updated.price}`);
    res.json(updated);
  } catch (err) {
    console.error('[PUT /api/products/:id] DB error:', err.code, err.sqlMessage || err.message);
    return res.status(500).json({ error: '保存失败：' + (err.sqlMessage || err.message) });
  }
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

    // 删除详情页文件(路径白名单:必须在 public/products/ 下,防 path traversal)
    if (product.detailPage) {
      const detailFilePath = path.resolve(__dirname, 'public', product.detailPage);
      const productsDir = path.resolve(__dirname, 'public', 'products') + path.sep;
      if (detailFilePath.startsWith(productsDir) && fs.existsSync(detailFilePath)) {
        fs.unlinkSync(detailFilePath);
      } else {
        console.warn(`Refusing to unlink detail page outside public/products/: ${product.detailPage}`);
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
app.post('/api/upload-product-image', requireAuth, uploadProductImage.single('image'), multerErrorResponder('5MB'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const imagePath = '/uploads/products/' + req.file.filename;
  res.json({ path: imagePath, filename: req.file.filename });
});

// ============================================================================
// Admin API: 产品管理（草稿 / 上架）
//
// 前台的 /api/products 只返回已上架的产品；草稿与已下架的产品只能在后台看到。
// 上架动作**只能由人点**（MCP 没有上架工具），AI 建出来的产品一律是草稿。
// ============================================================================

// Admin: 列出全部产品（含草稿 / 已下架）
app.get('/api/admin/products', requireAuth, async (req, res) => {
  try {
    const { search, category, status } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));

    // status：'published' | 'draft' | 不传（全部）
    let statusFilter;
    if (status === 'published') statusFilter = 1;
    else if (status === 'draft') statusFilter = 0;

    const result = await db.getProductsPaginated({
      search: typeof search === 'string' ? search : '',
      category: typeof category === 'string' ? category : '',
      page,
      pageSize,
      status: statusFilter
    });
    res.json(result);
  } catch (e) {
    console.error('GET /api/admin/products error:', e);
    res.status(500).json({ error: '获取产品列表失败' });
  }
});

// Admin: 单个产品详情（草稿也返回）
app.get('/api/admin/products/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '无效的产品 ID' });
  }
  try {
    const product = await db.getProduct(id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (e) {
    console.error('GET /api/admin/products/:id error:', e);
    res.status(500).json({ error: '获取产品失败' });
  }
});

// Admin: 上架产品（草稿 → 前台可见）
app.post('/api/admin/products/:id/publish', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '无效的产品 ID' });
  }
  try {
    const product = await db.getProduct(id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    if (product.status === 'published') {
      return res.status(400).json({ error: '该产品已经是上架状态' });
    }
    await db.setProductStatus(id, true);
    writeOperationLog('PRODUCT_PUBLISH', req.session.userName || req.session.username || 'admin', `Product #${id}: ${product.name}`);
    res.json({ success: true, status: 'published' });
  } catch (e) {
    console.error('POST /api/admin/products/:id/publish error:', e);
    res.status(500).json({ error: '上架失败' });
  }
});

// Admin: 下架产品（前台立即不可见）
app.post('/api/admin/products/:id/unpublish', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '无效的产品 ID' });
  }
  try {
    const product = await db.getProduct(id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    if (product.status !== 'published') {
      return res.status(400).json({ error: '该产品已经是下架状态' });
    }
    await db.setProductStatus(id, false);
    writeOperationLog('PRODUCT_UNPUBLISH', req.session.userName || req.session.username || 'admin', `Product #${id}: ${product.name}`);
    res.json({ success: true, status: 'draft' });
  } catch (e) {
    console.error('POST /api/admin/products/:id/unpublish error:', e);
    res.status(500).json({ error: '下架失败' });
  }
});

// ============================================================================
// Admin API: product docs CRUD (Task 13)
// ============================================================================

// Admin: list all docs for a product (including drafts)
app.get('/api/admin/products/:productId/docs', requireAuth, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ error: '无效的 productId' });
    }
    const docs = await db.listProductDocsByProduct(productId);
    res.json(docs);
  } catch (e) {
    console.error('Admin list docs error:', e);
    res.status(500).json({ error: '获取失败' });
  }
});

// Admin: create a doc
app.post('/api/admin/products/:productId/docs', requireAuth, async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ error: '无效的 productId' });
    }
    const { title, slug, content_html, excerpt, sort_order } = req.body;
    if (!title || !slug || !content_html) {
      return res.status(400).json({ error: 'title, slug, content_html 必填' });
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'slug 只能包含小写字母、数字、连字符' });
    }
    const username = req.session.userName || req.session.username || 'admin';
    const result = await db.createProductDoc({
      product_id: productId,
      title, slug, content_html, excerpt, sort_order,
      author_username: username
    });
    writeOperationLog('PRODUCT_DOC_CREATE', username, `Doc #${result.insertId} (product ${productId})`);
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: '同产品下 slug 已存在' });
    }
    console.error('Admin create doc error:', e);
    res.status(500).json({ error: '创建失败' });
  }
});

// Admin: get one doc
app.get('/api/admin/docs/:docId', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.docId, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 docId' });
    const doc = await db.getProductDocById(id);
    if (!doc) return res.status(404).json({ error: '文档不存在' });
    res.json(doc);
  } catch (e) {
    console.error('Admin get doc error:', e);
    res.status(500).json({ error: '获取失败' });
  }
});

// Admin: update doc content (NOT status)
app.put('/api/admin/docs/:docId', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.docId, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 docId' });
    const { title, slug, content_html, excerpt, sort_order } = req.body;
    if (!title || !slug || !content_html) {
      return res.status(400).json({ error: 'title, slug, content_html 必填' });
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'slug 只能包含小写字母、数字、连字符' });
    }
    await db.updateProductDoc(id, { title, slug, content_html, excerpt, sort_order });
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('PRODUCT_DOC_UPDATE', username, `Doc #${id}`);
    res.json({ success: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: '同产品下 slug 已存在' });
    }
    console.error('Admin update doc error:', e);
    res.status(500).json({ error: '更新失败' });
  }
});

// Admin: delete doc
app.delete('/api/admin/docs/:docId', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.docId, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 docId' });

    // 清理 content_html 中的孤立图片
    const doc = await db.getProductDocById(id);
    let cleanedCount = 0;
    if (doc && doc.content_html) {
      const imgRegex = /<img[^>]+src=["']([^"']+\/uploads\/doc-images\/[^"']+)["']/gi;
      let match;
      while ((match = imgRegex.exec(doc.content_html)) !== null) {
        const imgUrl = match[1];
        // imgUrl 可能是 "http://host/uploads/..." 或 "/uploads/..." 形式
        let relPath;
        try {
          const url = new URL(imgUrl);
          relPath = url.pathname.replace(/^\//, '');
        } catch {
          // 不是完整 URL，按相对路径处理
          relPath = imgUrl.replace(/^\//, '');
        }
        const imgPath = path.join(__dirname, 'public', relPath);
        try {
          await fs.promises.unlink(imgPath);
          cleanedCount++;
        } catch (e) {
          if (e.code !== 'ENOENT') console.warn('Failed to delete orphan image:', imgPath, e.message);
        }
      }
    }

    await db.deleteProductDoc(id);
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('PRODUCT_DOC_DELETE', username, `Doc #${id} (cleaned ${cleanedCount} images)`);
    res.json({ success: true, cleanedImages: cleanedCount });
  } catch (e) {
    console.error('Admin delete doc error:', e);
    res.status(500).json({ error: '删除失败' });
  }
});

// Admin: publish doc
app.post('/api/admin/docs/:docId/publish', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.docId, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 docId' });
    await db.publishProductDoc(id);
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('PRODUCT_DOC_PUBLISH', username, `Doc #${id}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Admin publish doc error:', e);
    res.status(500).json({ error: '发布失败' });
  }
});

// Admin: unpublish doc
app.post('/api/admin/docs/:docId/unpublish', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.docId, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 docId' });
    await db.unpublishProductDoc(id);
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('PRODUCT_DOC_UNPUBLISH', username, `Doc #${id}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Admin unpublish doc error:', e);
    res.status(500).json({ error: '撤稿失败' });
  }
});

// ============ 动态（News）Admin API ============

// Admin: 列出全部动态（含草稿）
app.get('/api/admin/news', requireAuth, async (req, res) => {
  try {
    const news = await db.getAllNews();
    res.json(news);
  } catch (err) {
    console.error('[admin news list]', err);
    res.status(500).json({ error: '加载失败' });
  }
});

// Admin: 单条动态详情
app.get('/api/admin/news/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    const news = await db.getNews(id);
    if (!news) return res.status(404).json({ error: '动态不存在' });
    res.json(news);
  } catch (err) {
    console.error('[admin news get]', err);
    res.status(500).json({ error: '加载失败' });
  }
});

// Admin: 新建动态
app.post('/api/admin/news', requireAuth, async (req, res) => {
  try {
    const { title, slug, excerpt, content_html, cover_image, category, is_pinned, sort_order } = req.body;
    // 标题/slug 规则走共享模块（lib/content-policy.js），与 MCP 端同一套规则、同一份文案
    let identity;
    try {
      identity = validateNewsIdentity({ title, slug });
    } catch (err) {
      if (err instanceof ContentPolicyError) return res.status(400).json({ error: err.message });
      throw err;
    }
    const result = await db.createNews({
      title: identity.title, slug: identity.slug, excerpt,
      contentHtml: content_html,
      coverImage: cover_image,
      category,
      isPinned: is_pinned === true || is_pinned === 1,
      sortOrder: parseInt(sort_order, 10) || 0
    });
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('NEWS_CREATE', username, `News #${result.id} (${identity.slug})`);
    res.json(result);
  } catch (err) {
    console.error('[admin news create]', err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'slug 已存在' });
    res.status(500).json({ error: '创建失败' });
  }
});

// Admin: 更新动态
app.put('/api/admin/news/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    const { title, slug, excerpt, content_html, cover_image, category, is_pinned, sort_order } = req.body;
    // 与创建端点共用同一份标题/slug 校验规则
    let identity;
    try {
      identity = validateNewsIdentity({ title, slug });
    } catch (err) {
      if (err instanceof ContentPolicyError) return res.status(400).json({ error: err.message });
      throw err;
    }
    const existing = await db.getNews(id);
    if (!existing) return res.status(404).json({ error: '动态不存在' });
    await db.updateNews(id, {
      title: identity.title, slug: identity.slug, excerpt,
      contentHtml: content_html,
      coverImage: cover_image,
      category,
      isPinned: is_pinned === true || is_pinned === 1,
      sortOrder: parseInt(sort_order, 10) || 0
    });
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('NEWS_UPDATE', username, `News #${id} (${identity.slug || ''})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin news update]', err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'slug 已存在' });
    res.status(500).json({ error: '更新失败' });
  }
});

// Admin: 删除动态
app.delete('/api/admin/news/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    const existing = await db.getNews(id);
    if (!existing) return res.status(404).json({ error: '动态不存在' });
    await db.deleteNews(id);
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('NEWS_DELETE', username, `News #${id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin news delete]', err);
    res.status(500).json({ error: '删除失败' });
  }
});

// Admin: 发布动态
app.post('/api/admin/news/:id/publish', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    const existing = await db.getNews(id);
    if (!existing) return res.status(404).json({ error: '动态不存在' });
    await db.publishNews(id);
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('NEWS_PUBLISH', username, `News #${id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin news publish]', err);
    res.status(500).json({ error: '发布失败' });
  }
});

// Admin: 撤稿动态
app.post('/api/admin/news/:id/unpublish', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    const existing = await db.getNews(id);
    if (!existing) return res.status(404).json({ error: '动态不存在' });
    await db.unpublishNews(id);
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('NEWS_UNPUBLISH', username, `News #${id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin news unpublish]', err);
    res.status(500).json({ error: '撤稿失败' });
  }
});

// TinyMCE image upload handler
app.post('/api/upload-doc-image', requireAuth, docImageUpload.single('file'), multerErrorResponder('5MB'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未上传文件' });
    // 修复 I9: 用 path.relative(publicDir, file.path) 构造相对路径,避免 split('uploads/doc-images') 字符串扫描脆弱性
    //         (旧实现可能在 windows 路径或多层 uploads 目录时匹配错位)
    const publicDir = path.join(__dirname, 'public');
    const relPath = '/' + path.relative(publicDir, req.file.path).split(path.sep).join('/');
    const username = req.session.userName || req.session.username || 'admin';
    writeOperationLog('DOC_IMAGE_UPLOAD', username, `${req.file.filename} (${req.file.size} bytes)`);
    res.json({ location: relPath });
  } catch (e) {
    console.error('Upload doc image error:', e);
    res.status(500).json({ error: '上传失败' });
  }
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
    if (e.code === 'ER_DUP_ENTRY' || e.message.includes('UNIQUE constraint failed')) {
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
  const { subject, content, confirm } = req.body;

  if (!subject || !content) {
    return res.status(400).json({ error: '请填写邮件主题和内容' });
  }
  // 修复 S7：长度限制 + 二次确认防误发/防滥用
  if (typeof subject !== 'string' || subject.length > 200) {
    return res.status(400).json({ error: '主题长度必须在 1-200 字符之间' });
  }
  if (typeof content !== 'string' || content.length > 50000) {
    return res.status(400).json({ error: '内容长度必须在 1-50000 字符之间（~50KB）' });
  }
  if (confirm !== 'SEND') {
    return res.status(400).json({ error: '请确认发送：需传 confirm="SEND"', requireConfirm: true });
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

// 安全删除：把客户端传来的 filename 限制在 dir 之内，且校验扩展名。
// path.join 会规范化 `..`，因此 filename 必须先经过 path.basename 剥离目录部分，
// 再用 path.resolve 校验最终路径确实仍位于 dir 之内（防目录穿越）。
function safeUnlinkInDir(dir, filename, allowedExts) {
  if (typeof filename !== 'string' || filename.length === 0) {
    return { error: 'INVALID_NAME' };
  }

  // 剥离任何目录分隔符成分，只保留纯文件名
  const baseName = path.basename(filename);
  if (baseName.length === 0 || baseName === '.' || baseName === '..') {
    return { error: 'INVALID_NAME' };
  }

  const ext = path.extname(baseName).toLowerCase();
  if (!allowedExts.includes(ext)) {
    return { error: 'INVALID_EXT' };
  }

  // 双重防护：resolve 后必须仍以 dir + 分隔符 开头
  const resolvedDir = path.resolve(dir);
  const target = path.resolve(resolvedDir, baseName);
  if (target !== resolvedDir && !target.startsWith(resolvedDir + path.sep)) {
    return { error: 'INVALID_NAME' };
  }

  if (!fs.existsSync(target)) {
    return { error: 'NOT_FOUND' };
  }

  try {
    fs.unlinkSync(target);
    return { success: true };
  } catch (err) {
    console.error('[safeUnlink] 删除失败:', { target, error: err.message });
    return { error: 'DELETE_FAILED' };
  }
}

// 删除产品描述图片
app.delete('/api/upload-product-image', requireAuth, (req, res) => {
  const { filename } = req.body;
  if (!filename) {
    return res.status(400).json({ error: '缺少文件名' });
  }

  const result = safeUnlinkInDir(
    path.join(__dirname, 'public', 'uploads', 'products'),
    filename,
    IMAGE_DELETABLE_EXTENSIONS
  );

  if (result.error === 'INVALID_NAME') {
    return res.status(400).json({ error: '文件名不合法' });
  }
  if (result.error === 'INVALID_EXT') {
    return res.status(400).json({ error: '仅允许删除图片文件' });
  }
  if (result.error === 'NOT_FOUND') {
    return res.status(404).json({ error: '文件不存在' });
  }
  if (result.error === 'DELETE_FAILED') {
    return res.status(500).json({ error: '删除失败' });
  }

  res.json({ success: true });
});

// 上传软件文件
app.post('/api/upload-software', requireAuth, uploadSoftware.single('software'), multerErrorResponder('500MB'), (req, res) => {
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

  const result = safeUnlinkInDir(
    path.join(__dirname, 'public', 'uploads', 'software'),
    filename,
    SOFTWARE_DELETABLE_EXTENSIONS
  );

  if (result.error === 'INVALID_NAME') {
    return res.status(400).json({ error: '文件名不合法' });
  }
  if (result.error === 'INVALID_EXT') {
    return res.status(400).json({ error: '不允许的文件类型' });
  }
  if (result.error === 'NOT_FOUND') {
    return res.status(404).json({ error: '文件不存在' });
  }
  if (result.error === 'DELETE_FAILED') {
    return res.status(500).json({ error: '删除失败' });
  }

  res.json({ success: true });
});

// ============ API路由 - 设置 ============

// 获取网站设置
app.get('/api/settings', async (req, res) => {
  const settings = await db.getSettings();
  // 公开端点：移除敏感字段（smtp 密码、AI API Key）
  if (settings?.smtp) settings.smtp = { ...settings.smtp, password: undefined };
  if (settings?.aiConfig) settings.aiConfig = { ...settings.aiConfig, apiKey: undefined };
  res.json(settings);
});

// 更新网站设置
app.put('/api/settings', requireAuth, async (req, res) => {
  const { companyName, description, ssl, banners, adminEmail, wechatId, email, ai, carddav, siteTheme } = req.body;
  const updates = {};
  if (companyName !== undefined) updates.companyName = companyName;
  if (description !== undefined) updates.description = description;
  if (ssl !== undefined) updates.ssl = ssl;
  if (banners !== undefined) updates.banners = banners;
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

// ============ API路由 - MCP 设置与令牌申请 ============
//
// 后台菜单：系统设置 → MCP（public/admin-mcp.html）
//
// 两类凭据：
//   - 主令牌：.env 的 MCP_TOKEN，全权限，运维逃生口。后台只显示掩码，不展示全文。
//   - 后台签发的令牌：mcp_tokens 表，带作用域、可吊销、可设有效期。
//     明文只在签发那一刻返回一次，之后任何接口都拿不回（库里只有 sha256）。

/** Host 白名单最多 20 条 —— 防滥用 */
const MCP_ALLOWED_HOSTS_MAX = 20;

/** 令牌有效期上限（天）。0 表示永不过期 */
const MCP_TOKEN_MAX_DAYS = 3650;

/** 令牌默认有效期（天）。给默认过期时间比「永久有效」安全 */
const MCP_TOKEN_DEFAULT_DAYS = 90;

/**
 * Host 白名单条目校验：只接受纯主机名（不带端口、不带协议）。
 * 带端口或带 scheme 的写法会让 SDK 的 hostname 比对永远失败，
 * 所以在入口就拒掉，并告诉用户正确写法。
 */
function isValidMcpHostname(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 255) return false;
  // IPv6 字面量：[::1]
  if (text.startsWith('[')) return /^\[[0-9a-fA-F:.]+\]$/.test(text);
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return text.split('.').every((part) => Number(part) <= 255);
  }
  // 域名：每段以字母数字开头结尾，中间可含连字符
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(text);
}

/** 掩码：只露出头尾，用于界面识别，不用于复制 */
function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 12) return text.slice(0, 2) + '****';
  return text.slice(0, 8) + '****' + text.slice(-4);
}

/** 取当前管理员标识（写审计日志用） */
function getAdminUsername(req) {
  return req.session.userName || req.session.username || 'admin';
}

/**
 * 取当前生效的 MCP 主令牌。
 *
 * 优先级：后台生成并存进数据库的（settings.mcp_config）> 环境变量 MCP_TOKEN。
 * 环境变量只是存量兼容 —— 后台点了「生成 / 轮换」之后，库里的那份才是权威，
 * 否则后台的轮换按钮会看起来没生效。
 *
 * 主令牌在库里是**明文**：运维需要随时把它复制出来交给 MCP 客户端。
 * 这与 .env 里的 DB_PASSWORD / SESSION_SECRET 是同一风险等级。
 */
function resolveAdminMasterToken(stored) {
  const fromDb = stored && typeof stored.masterToken === 'string' ? stored.masterToken : '';
  if (fromDb) return { token: fromDb, source: 'database' };
  const fromEnv = typeof process.env.MCP_TOKEN === 'string' ? process.env.MCP_TOKEN : '';
  if (fromEnv) return { token: fromEnv, source: 'env' };
  return { token: '', source: 'none' };
}

/** 令牌状态：revoked（已吊销）/ expired（已过期）/ active（有效） */
function getMcpTokenStatus(row) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

/** DB 行 → 后台展示用的令牌对象（不含 token_hash） */
function toMcpTokenView(row) {
  return {
    id: Number(row.id),
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: String(row.scopes || '').split(',').filter(Boolean),
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    status: getMcpTokenStatus(row)
  };
}

// ---- 读取 MCP 设置 ----
app.get('/api/admin/mcp/config', requireAuth, async (req, res) => {
  try {
    const stored = await db.getStoredMcpConfig();
    const tokens = await db.listMcpTokens();
    const views = tokens.map(toMcpTokenView);

    const stats = {
      total: views.length,
      active: views.filter((t) => t.status === 'active').length,
      revoked: views.filter((t) => t.status === 'revoked').length,
      expired: views.filter((t) => t.status === 'expired').length
    };

    const master = resolveAdminMasterToken(stored);

    res.json({
      // 是否已在后台保存过配置（false 表示仍在用环境变量兜底）
      configured: stored !== null,
      enabled: stored ? stored.enabled !== false : true,
      allowedHosts: stored
        ? (Array.isArray(stored.allowedHosts) ? stored.allowedHosts : [])
        : MCP_ALLOWED_HOSTS,
      endpointPath: '/mcp',
      masterToken: {
        configured: Boolean(master.token),
        masked: maskSecret(master.token),
        // database = 后台生成；env = 环境变量兜底；none = 还没生成
        source: master.source,
        rotatedAt: stored && typeof stored.masterTokenRotatedAt === 'string'
          ? stored.masterTokenRotatedAt
          : null
      },
      scopes: [
        { value: SCOPE_READ, label: '读取动态（list_news / get_news）' },
        { value: SCOPE_WRITE, label: '写入动态（新建 / 修改 / 发布 / 撤稿）' },
        { value: SCOPE_PRODUCT_READ, label: '读取产品（列产品 / 读详情 / 读产品文档）' },
        { value: SCOPE_PRODUCT_WRITE, label: '写入产品与产品文档（新建 / 修改；产品上架仍需人工）' }
      ],
      stats
    });
  } catch (e) {
    console.error('GET /api/admin/mcp/config error:', e);
    res.status(500).json({ error: '读取 MCP 设置失败' });
  }
});

// ---- 主令牌：查看（复制） ----
//
// 与子令牌的关键差别：子令牌明文只在签发那一刻返回一次，库里只存 sha256；
// 主令牌必须**随时能复制**（运维要把它交给 AI 工具，可能在任意时刻取用），
// 所以库里存明文、这里直接回明文。这是有意的取舍 —— 主令牌的存在意义
// 就是「随时能取用」，而存它的库里本来就躺着同级的明文秘密。
//
// 因此这个端点必须是 requireAuth —— 它等价于交出 MCP 全权限。
app.get('/api/admin/mcp/master-token', requireAuth, async (req, res) => {
  try {
    const stored = await db.getStoredMcpConfig();
    const master = resolveAdminMasterToken(stored);
    res.json({
      configured: Boolean(master.token),
      masked: maskSecret(master.token),
      // 明文直出，供「复制」按钮使用
      token: master.token,
      source: master.source,
      rotatedAt: stored && typeof stored.masterTokenRotatedAt === 'string'
        ? stored.masterTokenRotatedAt
        : null
    });
  } catch (e) {
    console.error('GET /api/admin/mcp/master-token error:', e);
    res.status(500).json({ error: '读取主令牌失败' });
  }
});

// ---- 主令牌：生成 / 轮换 ----
//
// 轮换会**立即作废**旧令牌（鉴权每次请求都现读配置，不缓存），
// 所以已经配到 AI 客户端里的旧令牌会当场失效，需要重新分发。
// 因此：已存在令牌时必须显式 confirm，避免误点把唯一的副本弄丢。
app.post('/api/admin/mcp/master-token', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const stored = await db.getStoredMcpConfig();
    const existing = resolveAdminMasterToken(stored);

    if (existing.token && body.confirm !== true) {
      return res.status(409).json({
        error: '主令牌已存在。轮换会立即作废旧令牌，请确认后重试。',
        code: 'MCP_MASTER_TOKEN_CONFIRM_REQUIRED',
        masked: maskSecret(existing.token)
      });
    }

    const token = generateMcpToken();
    const nextConfig = Object.assign({}, stored && typeof stored === 'object' ? stored : {}, {
      masterToken: token,
      masterTokenRotatedAt: new Date().toISOString()
    });

    const saved = await db.saveMcpConfig(nextConfig);
    if (!saved || saved.masterToken !== token) {
      console.error('POST /api/admin/mcp/master-token: 写入后回读不一致');
      return res.status(500).json({ error: '主令牌已写入但回读失败，请到数据库核对后重试' });
    }

    writeOperationLog(
      existing.token ? 'MCP_MASTER_TOKEN_ROTATE' : 'MCP_MASTER_TOKEN_CREATE',
      getAdminUsername(req),
      existing.token
        ? '[MCP] 主令牌轮换：旧令牌立即作废'
        : '[MCP] 主令牌生成'
    );

    res.json({
      success: true,
      token,
      masked: maskSecret(token),
      rotated: Boolean(existing.token),
      rotatedAt: nextConfig.masterTokenRotatedAt,
      message: existing.token
        ? '主令牌已轮换，旧令牌立即失效，请重新分发'
        : '主令牌已生成'
    });
  } catch (e) {
    console.error('POST /api/admin/mcp/master-token error:', e);
    res.status(500).json({ error: '生成主令牌失败' });
  }
});

// ---- 保存 MCP 设置 ----
app.put('/api/admin/mcp/config', requireAuth, async (req, res) => {
  try {
    const { enabled, allowedHosts } = req.body || {};

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 必须是布尔值' });
    }

    let hosts = [];
    if (allowedHosts !== undefined) {
      if (!Array.isArray(allowedHosts)) {
        return res.status(400).json({ error: 'allowedHosts 必须是数组' });
      }
      if (allowedHosts.length > MCP_ALLOWED_HOSTS_MAX) {
        return res.status(400).json({ error: `Host 白名单最多 ${MCP_ALLOWED_HOSTS_MAX} 条` });
      }
      const seen = [];
      for (const raw of allowedHosts) {
        if (typeof raw !== 'string') {
          return res.status(400).json({ error: 'Host 白名单只能包含字符串' });
        }
        const host = raw.trim();
        if (!host) continue;
        if (!isValidMcpHostname(host)) {
          return res.status(400).json({
            error: `Host 白名单包含非法条目「${host}」。只写主机名，不要带端口或协议（例如 www.booming.one）`
          });
        }
        if (!seen.includes(host)) seen.push(host);
      }
      hosts = seen;
    }

    const stored = await db.getStoredMcpConfig();
    const nextConfig = {
      enabled: enabled !== undefined ? enabled : stored ? stored.enabled !== false : true,
      allowedHosts: hosts
    };

    // 主令牌不能被这次保存顺手抹掉 —— saveMcpConfig 是覆盖写整份 JSON。
    // 主令牌由「生成 / 轮换」按钮单独管理，与启用开关、Host 白名单互不相干。
    const master = resolveAdminMasterToken(stored);
    if (master.source === 'database') {
      nextConfig.masterToken = master.token;
      if (stored && typeof stored.masterTokenRotatedAt === 'string') {
        nextConfig.masterTokenRotatedAt = stored.masterTokenRotatedAt;
      }
    }

    await db.saveMcpConfig(nextConfig);
    writeOperationLog('MCP_CONFIG_UPDATE', getAdminUsername(req),
      `[MCP] 配置更新：enabled=${nextConfig.enabled}, allowedHosts=${nextConfig.allowedHosts.join(',') || '(空)'}`);

    res.json({
      success: true,
      configured: true,
      enabled: nextConfig.enabled,
      allowedHosts: nextConfig.allowedHosts
    });
  } catch (e) {
    console.error('PUT /api/admin/mcp/config error:', e);
    res.status(500).json({ error: '保存 MCP 设置失败' });
  }
});

// ---- 令牌列表 ----
app.get('/api/admin/mcp/tokens', requireAuth, async (req, res) => {
  try {
    const rows = await db.listMcpTokens();
    res.json({ tokens: rows.map(toMcpTokenView) });
  } catch (e) {
    console.error('GET /api/admin/mcp/tokens error:', e);
    res.status(500).json({ error: '读取令牌列表失败' });
  }
});

// ---- 申请（签发）新令牌 ----
app.post('/api/admin/mcp/tokens', requireAuth, async (req, res) => {
  try {
    const { name, scopes, expiresInDays } = req.body || {};

    const tokenName = typeof name === 'string' ? name.trim() : '';
    if (!tokenName) {
      return res.status(400).json({ error: '请填写令牌用途（名称）' });
    }
    if (tokenName.length > 100) {
      return res.status(400).json({ error: '令牌名称不能超过 100 个字符' });
    }

    const scopeResult = normalizeMcpScopes(scopes);
    if (!scopeResult.ok) {
      return res.status(400).json({ error: scopeResult.error });
    }

    let days = MCP_TOKEN_DEFAULT_DAYS;
    if (expiresInDays !== undefined && expiresInDays !== null && expiresInDays !== '') {
      const parsed = Number(expiresInDays);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MCP_TOKEN_MAX_DAYS) {
        return res.status(400).json({ error: `有效期必须是 0（永不过期）或 1-${MCP_TOKEN_MAX_DAYS} 之间的整数天` });
      }
      days = parsed;
    }

    const plaintext = generateMcpToken();
    const expiresAt = days > 0
      ? new Date(Date.now() + days * 24 * 60 * 60 * 1000)
      : null;

    const record = await db.createMcpToken({
      name: tokenName,
      tokenHash: hashMcpToken(plaintext),
      tokenPrefix: getMcpTokenPreview(plaintext),
      scopes: formatMcpScopes(scopeResult.scopes),
      createdBy: getAdminUsername(req),
      expiresAt
    });

    if (!record) {
      console.error('POST /api/admin/mcp/tokens: 写入后回读失败, name=', tokenName);
      return res.status(500).json({ error: '令牌已写入但回读失败，请到数据库核对后重试' });
    }

    writeOperationLog('MCP_TOKEN_CREATE', getAdminUsername(req),
      `[MCP] 签发令牌「${tokenName}」(${record.token_prefix}) scopes=${record.scopes} expires=${expiresAt ? expiresAt.toISOString() : 'never'}`);

    res.status(201).json({
      success: true,
      // 明文只在这里出现一次 —— 前端展示后请立刻复制走，刷新即不可再见
      token: plaintext,
      record: toMcpTokenView(record)
    });
  } catch (e) {
    console.error('POST /api/admin/mcp/tokens error:', e);
    res.status(500).json({ error: '签发令牌失败' });
  }
});

// ---- 吊销令牌 ----
app.post('/api/admin/mcp/tokens/:id/revoke', requireAuth, async (req, res) => {
  try {
    const tokenId = Number(req.params.id);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: '令牌 id 不合法' });
    }

    // 二次确认：与 /api/security/config 的 MODIFY_WHITELIST 同一套做法，
    // 防止被劫持的 admin 会话「一键吊销全部令牌」
    if (!req.body || req.body.confirm !== 'REVOKE_TOKEN') {
      return res.status(400).json({ error: '吊销令牌需要 confirm 字段值为 "REVOKE_TOKEN"' });
    }

    const rows = await db.listMcpTokens();
    const target = rows.find((row) => Number(row.id) === tokenId);
    if (!target) {
      return res.status(404).json({ error: '令牌不存在' });
    }
    if (target.revoked_at) {
      return res.status(400).json({ error: '该令牌已被吊销' });
    }

    const result = await db.revokeMcpToken(tokenId);
    if (!result.affectedRows) {
      return res.status(409).json({ error: '吊销失败：令牌状态已变化，请刷新后重试' });
    }

    writeOperationLog('MCP_TOKEN_REVOKE', getAdminUsername(req),
      `[MCP] 吊销令牌「${target.name}」(${target.token_prefix})`);

    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/admin/mcp/tokens/:id/revoke error:', e);
    res.status(500).json({ error: '吊销令牌失败' });
  }
});

// ============ Admin Theme System — system_settings ============

// Admin Theme System — system_settings
app.get('/api/admin/settings', requireAuth, async (req, res) => {
  try {
    const settings = await db.getAllSystemSettings();
    res.json(settings);
  } catch (e) {
    console.error('GET /api/admin/settings error:', e);
    res.status(500).json({ error: '获取设置失败' });
  }
});

const ADMIN_SETTINGS_WHITELIST = {
  admin_theme: (v) => ['b', 'c', 'd'].includes(v) ? v : null,
  admin_dark_mode: (v) => ['0', '1'].includes(String(v)) ? String(v) : null
};

app.put('/api/admin/settings', requireAuth, async (req, res) => {
  try {
    const updates = {};
    const changedKeys = [];
    for (const [key, validator] of Object.entries(ADMIN_SETTINGS_WHITELIST)) {
      if (req.body[key] !== undefined) {
        const validated = validator(req.body[key]);
        if (validated === null) {
          return res.status(400).json({ error: `无效的 ${key} 值` });
        }
        updates[key] = validated;
        changedKeys.push(key);
      }
    }
    if (changedKeys.length === 0) {
      return res.status(400).json({ error: '没有可更新的字段' });
    }
    const username = req.session.userName || req.session.username || 'admin';
    for (const [key, value] of Object.entries(updates)) {
      await db.setSystemSetting(key, value, username);
    }
    writeOperationLog('ADMIN_SETTING_UPDATE', username, `Updated: ${changedKeys.join(', ')}`);
    const settings = await db.getAllSystemSettings();
    res.json({ success: true, settings });
  } catch (e) {
    console.error('PUT /api/admin/settings error:', e);
    res.status(500).json({ error: '更新失败' });
  }
});

// 数据库备份 - 助手函数 + 路由
function makeTimestamp() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth()+1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

app.post('/api/admin/backup/create', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  if (isBackupInProgress || isRestoreInProgress) {
    return res.status(409).json({ error: 'Backup or restore already in progress' });
  }
  isBackupInProgress = true;
  try {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    const filename = `backup-${makeTimestamp()}.sql`;
    const outFile = path.join(BACKUP_DIR, filename);
    await runMysqldump(outFile);
    await pruneToLast3();
    const stat = await fs.promises.stat(outFile);
    res.json({
      filename,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      downloadUrl: `/api/admin/backup/download/${filename}`
    });
    writeOperationLog('BACKUP_CREATE', req.session.username, `Created ${filename} (${stat.size} bytes)`);
  } catch (e) {
    writeOperationLog('BACKUP_CREATE_FAILED', req.session.username, e.message);
    res.status(500).json({ error: e.message });
  } finally {
    isBackupInProgress = false;
  }
});

app.get('/api/admin/backup/list', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  try {
    const backups = await getBackupList();
    res.json({ backups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/backup/download/:filename', requireAuth, (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const filename = req.params.filename;
  if (!BACKUP_FILENAME_RE.test(filename) || filename.startsWith('_uploaded-')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const fp = path.join(BACKUP_DIR, filename);
  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const stream = fs.createReadStream(fp);
  stream.on('error', err => {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  });
  stream.pipe(res);
});

app.delete('/api/admin/backup/:filename', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const filename = req.params.filename;
  if (!BACKUP_FILENAME_RE.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  if (filename.startsWith('before-restore-')) {
    return res.status(400).json({ error: 'Cannot delete before-restore backups via API (manual cleanup only)' });
  }
  if (filename.startsWith('_uploaded-')) {
    return res.status(400).json({ error: 'Cannot delete uploaded files via API' });
  }
  const fp = path.join(BACKUP_DIR, filename);
  try {
    await fs.promises.unlink(fp);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    throw err;
  }
  writeOperationLog('BACKUP_DELETE', req.session.username, `Deleted ${filename}`);
  res.json({ deleted: filename });
});

// Multer error-handling wrapper: maps multer's fileFilter / LIMIT_FILE_SIZE errors
// to spec-required 400 / 413 instead of Express's default 500.
const backupUploadHandler = (req, res, next) => {
  backupUpload.single('sqlFile')(req, res, (err) => {
    if (!err) return next();
    multerErrorResponder('100MB')(err, req, res, next);
  });
};

app.post('/api/admin/backup/upload', requireAuth, backupUploadHandler, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Rename to _uploaded-YYYYMMDD-HHMMSS.sql
  const filename = `_uploaded-${makeTimestamp()}.sql`;
  const target = path.join(BACKUP_DIR, filename);
  try {
    await fs.promises.rename(req.file.path, target);
    const stat = await fs.promises.stat(target);
    writeOperationLog('BACKUP_UPLOAD', req.session.username, `Uploaded ${filename} (${stat.size} bytes)`);
    res.json({ filename, size: stat.size });
  } catch (e) {
    // Clean up multer's temp file if rename failed (disk full / permission / etc.)
    await fs.promises.unlink(req.file.path).catch(() => {});
    writeOperationLog('BACKUP_UPLOAD_FAILED', req.session.username, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/backup/restore', requireAuth, async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' });
  if (isBackupInProgress || isRestoreInProgress) {
    return res.status(409).json({ error: 'Backup or restore already in progress' });
  }
  const filename = String(req.body?.filename || '');
  if (!BACKUP_FILENAME_RE.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const sourceFile = path.join(BACKUP_DIR, filename);
  try {
    await fs.promises.access(sourceFile, fs.constants.R_OK);
  } catch {
    return res.status(404).json({ error: 'File not found' });
  }
  isRestoreInProgress = true;
  try {
    // Always create a before-restore backup first
    const beforeFile = `before-restore-${makeTimestamp()}.sql`;
    const beforePath = path.join(BACKUP_DIR, beforeFile);
    await runMysqldump(beforePath);
    // Then perform the restore
    await runMysqlImport(sourceFile);
    // Cleanup uploaded temp file
    if (filename.startsWith('_uploaded-')) {
      await fs.promises.unlink(sourceFile).catch(() => {});
    }
    res.json({
      restoredFrom: filename,
      beforeRestoreBackup: beforeFile,
      restoredAt: new Date().toISOString()
    });
    writeOperationLog('BACKUP_RESTORE', req.session.username, `Restored from ${filename} (before-restore: ${beforeFile})`);
  } catch (e) {
    writeOperationLog('BACKUP_RESTORE_FAILED', req.session.username, `Source: ${filename}, Error: ${e.message}`);
    res.status(500).json({
      error: e.message,
      note: 'Restore failed. before-restore backup retained for manual rollback.'
    });
  } finally {
    isRestoreInProgress = false;
  }
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
app.post('/api/upload-logo', requireAuth, uploadLogo.single('logo'), multerErrorResponder('2MB'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const logoPath = '/uploads/' + req.file.filename;
  const settings = await db.updateSettings({ logo: logoPath });
  res.json(settings);
});

// 上传Banner图片
app.post('/api/upload-banner', requireAuth, uploadBanner.single('banner'), multerErrorResponder('5MB'), (req, res) => {
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

  // 修复 S9：所有配置项设 floor 防止 admin/被劫持 admin 把限流调到 0 或负数
  //        弱化安全设置必须显式 force=true（仍受 floor 约束）
  const FLOOR = {
    maxAttempts: 5,           // 最少 5 次尝试才封禁
    criticalAttempts: 50,     // 最少 50 次触发严重警告
    attemptWindow: 60000,     // 最小 1 分钟窗口
    lockoutDuration: 60000,   // 最小 1 分钟封禁
    rateLimitMaxRequests: 10, // 每窗口最少 10 请求
    rateLimitWindowMs: 100    // 最小窗口 100ms
  };

  if (maxAttempts) securityConfig.maxAttempts = Math.max(parseInt(maxAttempts), FLOOR.maxAttempts);
  if (criticalAttempts) securityConfig.criticalAttempts = Math.max(parseInt(criticalAttempts), FLOOR.criticalAttempts);
  if (attemptWindow) securityConfig.attemptWindow = Math.max(parseInt(attemptWindow), FLOOR.attemptWindow);
  if (lockoutDuration) securityConfig.lockoutDuration = Math.max(parseInt(lockoutDuration), FLOOR.lockoutDuration);

  // 更新 API 限流配置
  if (apiRateLimit) {
    // 限流不能被整体关闭 —— 至少保留 enabled=true
    if (apiRateLimit.enabled === false) {
      return res.status(400).json({ error: 'API 限流不允许整体关闭（防爆破降级）' });
    }
    if (apiRateLimit.enabled !== undefined) securityConfig.apiRateLimit.enabled = apiRateLimit.enabled;
    if (apiRateLimit.windowMs) securityConfig.apiRateLimit.windowMs = Math.max(parseInt(apiRateLimit.windowMs), FLOOR.rateLimitWindowMs);
    if (apiRateLimit.maxRequests) securityConfig.apiRateLimit.maxRequests = Math.max(parseInt(apiRateLimit.maxRequests), FLOOR.rateLimitMaxRequests);
    if (apiRateLimit.blockDuration) securityConfig.apiRateLimit.blockDuration = Math.max(parseInt(apiRateLimit.blockDuration), 1000);
    if (Array.isArray(apiRateLimit.whitelist)) {
      // 修复 S18：白名单修改需要 confirm 二次确认（防被劫持 admin 一键放行攻击者 IP）
      if (apiRateLimit.whitelist.length > 0 && req.body.confirm !== 'MODIFY_WHITELIST') {
        return res.status(400).json({ error: '修改白名单需要 confirm 字段值为 "MODIFY_WHITELIST"' });
      }
      // 白名单上限 20 个 IP，防滥用
      if (apiRateLimit.whitelist.length > 20) {
        return res.status(400).json({ error: '白名单最多 20 个 IP' });
      }
      // 白名单 IP 必须合法
      for (const ip of apiRateLimit.whitelist) {
        if (typeof ip !== 'string' || !/^[\d.:a-fA-F]+$/.test(ip)) {
          return res.status(400).json({ error: `白名单包含非法 IP: ${ip}` });
        }
      }
      securityConfig.apiRateLimit.whitelist = apiRateLimit.whitelist;
    }
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
const ALLOWED_LOG_TYPES = new Set(['login', 'operation', 'email', 'order', 'alert']);
app.get('/api/security/logs/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  const { type } = req.query;
  // 严格白名单防止路径穿越（date 限定 YYYY-MM-DD，type 限定已知日志类型）
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '日期格式必须为 YYYY-MM-DD' });
  }
  if (type !== undefined && !ALLOWED_LOG_TYPES.has(type)) {
    return res.status(400).json({ error: '日志类型不合法' });
  }
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
  // 修复 I18: 校验 IP 格式,避免把任意字符串当 IP 删
  if (typeof ip !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/.test(ip)) {
    return res.status(400).json({ error: '无效的 IP 格式' });
  }
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
    // baseUrl fallback 链:settings.ssl.domain > process.env.PORT
    // HTTP 端口从 .env 读,不走 DB settings(列已删)
    const baseUrl = settings.ssl?.domain
      ? 'https://' + settings.ssl.domain
      : ('http://localhost:' + (process.env.PORT || 15000));

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

  // 修复 S6：限制 to 只能为登录管理员自己的邮箱或 settings.adminEmail
  //        防止利用生产 SMTP 作为 relay 发钓鱼邮件
  const allowedRecipients = new Set([
    req.session.username,
    settings.adminEmail,
    email.user,
    email.from
  ].filter(Boolean).map(s => s.toLowerCase()));

  if (!to) {
    return res.status(400).json({ error: '请输入收件人地址' });
  }
  if (!allowedRecipients.has(to.toLowerCase())) {
    writeOperationLog('EMAIL_TEST_BLOCKED', req.session.username, `Blocked recipient: ${to}`);
    return res.status(403).json({ error: '收件人必须为当前管理员邮箱、adminEmail 或 SMTP 用户' });
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
// 按 (type, category) 选 prompt 维度：产品按 5 分类，News 按 3 分类；其他走通用模板
const PRODUCT_CATEGORY_GUIDANCE = {
  '企业产品': '从企业采购决策者视角优化：突出 ROI、合规性、稳定性、长期服务支持、技术支持 SLA、可定制能力。强调可量化收益（效率提升、成本降低、风险管控）。',
  '外站课程': '从学习者视角优化：突出课程结构清晰、目标人群明确、学习路径循序渐进、动手实践配套、讲师背景。强调「学完后能做什么」。',
  '企业内训': '从培训负责人视角优化：突出定制化、现场交付、行业案例、互动演练、效果评估、后续跟踪。强调可衡量的培训产出。',
  'GitHub 仓库': '从开发者视角优化：突出技术栈与版本要求、核心特性与架构亮点、贡献指南、Issue / PR 流程、License 类型、徽章（star / fork / release）。',
  '开源产品': '从技术决策者视角优化：突出技术亮点、扩展性、二次开发友好、社区活跃度、文档完整度、Roadmap 透明度。'
};
const NEWS_CATEGORY_GUIDANCE = {
  '产品更新': '侧重：版本号清晰、改动条目化（新功能 / 优化 / 修复）、破坏性变更与迁移指引、性能与稳定性数据、致谢用户与贡献者。',
  '公司新闻': '侧重：业务进展、活动 / 会议、客户与合作伙伴、招聘与团队、里程碑。',
  '安全公告': '侧重：漏洞等级（CVSS 或自评）、影响范围、受影响版本、修复版本、缓解措施、致谢白帽子、披露时间线。'
};

function buildAiPrompt({ text, type, category, title, customPrompt }) {
  if (customPrompt) return customPrompt;

  if (type === 'website_description') {
    return `请根据以下网站信息，为博铭科技生成一段专业的企业网站描述。要求：\n1. 简洁有力，突出企业核心价值\n2. 50-100 字左右\n3. 专业大气，适合软件行业\n4. 不使用 markdown 格式\n\n现有描述参考：${text || '无'}`;
  }

  if (type === 'product_description') {
    const cat = category || '（未选分类）';
    const guidance = PRODUCT_CATEGORY_GUIDANCE[category] || '从该产品的典型用户视角优化：突出核心价值、差异化优势、目标场景、关键能力。';
    return `你是非常专业的产品经理与文案编辑。任务：基于用户提供的【HTML 富文本产品描述】进行优化与扩展。

严格要求：
1. 必须【保留并复用】原 HTML 结构与标签：<h3>、<p>、<ul>、<li>、<strong>、<em>、<img>、<a>、<br>
2. 不得引入 markdown 语法（不要用 # 标题、- 列表、** 粗体、\`\`\` 代码块）
3. 输出必须是合法 HTML 片段，可直接作为 contenteditable 的 innerHTML
4. 在原结构基础上【扩展与润色】：补全要点、补充细节、提升表达专业度
5. 中文输出

【分类】${cat}
【分类维度指引】
${guidance}

原描述：
${text || '（空）'}`;
  }

  if (type === 'news_content') {
    const cat = category || '（未选分类）';
    const guidance = NEWS_CATEGORY_GUIDANCE[category] || '从该分类的典型读者视角润色：信息密度高、事实清晰、面向潜在读者群。';
    return `你是非常资深的科技公司内容编辑。任务：基于用户提供的【HTML 富文本动态内容】进行润色与扩展。

严格要求：
1. 必须【保留并复用】原 HTML 结构与标签：<h2>、<h3>、<p>、<ul>、<li>、<ol>、<strong>、<em>、<a>、<img>、<br>
2. 不得引入 markdown 语法
3. 输出必须是合法 HTML 片段
4. 在原结构基础上【润色文字、补充细节、调整逻辑顺序】，提升可读性与信息量
5. 中文输出
6. 不要捏造事实（版本号、日期、数字、URL、人名等），可润色但不要编造新事实

【文章信息】
标题：${title || '（无）'}
分类：${cat}

【分类维度指引】
${guidance}

原内容：
${text || '（空）'}`;
  }

  return `请优化以下文本，使其更加专业：\n${text}`;
}

app.post('/api/ai/generate', requireAuth, async (req, res) => {
  const { text, type, category, title, customPrompt } = req.body;

  if (!text && !customPrompt) {
    return res.status(400).json({ success: false, error: '缺少文本内容' });
  }

  const settings = await db.getSettings();
  const ai = settings?.aiConfig || settings?.ai || {};

  if (!ai.enabled || !ai.apiKey) {
    return res.status(400).json({ success: false, error: 'AI功能未启用或未配置API Key' });
  }

  try {
    const prompt = buildAiPrompt({ text, type, category, title, customPrompt });
    const model = ai.model || 'gpt-3.5-turbo';

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
          max_tokens: 4000
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
          max_tokens: 4000,
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
  // configSource 告诉界面「这份配置到底从哪来」—— .env 是唯一事实来源，
  // 不告诉前端就会让人以为保存到别处去了。
  const envState = envFile.readEnvFile();
  res.json({
    ...config,
    configSource: db.getDbConfigSource(),
    envFile: {
      exists: envState.exists,
      path: envFile.ENV_FILE,
      backupPath: envFile.BACKUP_FILE
    }
  });
});

// 更新数据库配置 —— 写进 .env
//
// .env 是数据库连接参数的唯一事实来源（安装向导生成的，0600 权限）。
// 旧逻辑在 source==='env' 时直接 409 拒绝，那是因为当时界面写的是
// data/db-config.json、会被 env 静默吃掉；现在界面写的就是 .env 本体，
// 锁只会让管理员改不动。
app.post('/api/db-config', requireAuth, async (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object' || !newConfig.mysql || typeof newConfig.mysql !== 'object') {
      return res.status(400).json({ error: '数据库配置不完整，请填写主机、用户名和数据库名' });
    }
    const host = typeof newConfig.mysql.host === 'string' ? newConfig.mysql.host.trim() : '';
    const user = typeof newConfig.mysql.user === 'string' ? newConfig.mysql.user.trim() : '';
    const database = typeof newConfig.mysql.database === 'string' ? newConfig.mysql.database.trim() : '';
    if (!host || !user || !database) {
      return res.status(400).json({ error: '数据库配置不完整，请填写主机、用户名和数据库名' });
    }
    const port = Number(newConfig.mysql.port || 3306);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return res.status(400).json({ error: '端口不合法' });
    }
    newConfig.mysql.host = host;
    newConfig.mysql.user = user;
    newConfig.mysql.database = database;
    newConfig.mysql.port = port;
    newConfig.type = 'mysql';

    // 如果密码是 ******，不更新密码
    if (newConfig.mysql.password === '******') {
      const oldConfig = db.getDbConfig();
      newConfig.mysql.password = (oldConfig && oldConfig.mysql && oldConfig.mysql.password) || '';
    }

    const saved = envConfigService.saveDbConfigToEnv({ mysql: newConfig.mysql });
    if (!saved.ok) {
      console.error('数据库配置保存失败:', saved.error);
      return res.status(500).json({ error: 'ENV_WRITE_FAILED', message: saved.error });
    }

    // 旧部署遗留的 data/db-config.json 同步一份，免得两份配置各说各话。
    // 只在它已经存在时更新 —— 不主动新建一份明文密码文件（.env 已是 0600）。
    const previousStoredConfig = db.readStoredDbConfig();
    if (previousStoredConfig !== null) {
      db.updateDbConfig(newConfig);
    }

    try {
      // 保存后立刻切换连接池 —— 否则新配置要等重启才生效
      await db.reconnectWithConfig(newConfig.mysql);
    } catch (error) {
      // 新配置连不上 → 回滚 .env、进程 env 与旧配置文件，旧连接池原样保留，
      // 不能把站点带挂
      const rolled = envConfigService.rollbackDbConfigToEnv(saved);
      if (previousStoredConfig !== null) {
        db.restoreDbConfig(previousStoredConfig);
      }
      console.error('数据库配置保存失败:', error);
      return res.status(400).json({
        error: 'DB_UNREACHABLE',
        message: '新配置无法连接数据库（已保留原配置）: ' + error.message
          + (rolled.ok ? '' : '；并且 .env 回滚也失败了，请手工检查 ' + envFile.ENV_FILE)
      });
    }

    res.json({
      ...db.getDbConfig(),
      configSource: db.getDbConfigSource(),
      envPath: saved.envPath,
      // 连接参数当场生效，但会话密钥与 sessionPool 在启动时绑定 —— 需重启才彻底对齐
      restartRequired: true
    });
  } catch (error) {
    console.error('数据库配置保存失败:', error);
    res.status(500).json({ error: '配置保存失败: ' + error.message });
  }
});

// 获取数据库Schema
app.get('/api/db-schema', requireAuth, async (req, res) => {
  try {
    const schema = await db.getMySQLSchema();
    res.json({ schema });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 测试数据库连接
app.post('/api/db-test', requireAuth, async (req, res) => {
  try {
    const config = req.body;
    if (!config || !config.mysql || typeof config.mysql !== 'object') {
      return res.status(400).json({ success: false, error: '数据库配置不完整' });
    }
    const host = String(config.mysql.host || '').trim();
    const user = String(config.mysql.user || '').trim();
    const database = String(config.mysql.database || '').trim();
    if (!host || !user || !database) {
      return res.status(400).json({ success: false, error: '请填写完整的主机、用户名和数据库名' });
    }
    const port = Number(config.mysql.port || 3306);
    let password = typeof config.mysql.password === 'string' ? config.mysql.password : '';
    // 密码不回显 —— 留空或保持 ****** 表示沿用已保存的密码
    if (!password || password === '******') {
      const stored = db.getDbConfig();
      if (stored && stored.mysql && stored.mysql.password) password = stored.mysql.password;
    }

    const mysql = require('mysql2/promise');
    let connection = null;
    try {
      connection = await mysql.createConnection({
        host,
        port,
        user,
        password,
        database,
        connectTimeout: 8000
      });
      await connection.ping();
      const [rows] = await connection.query('SELECT VERSION() AS version, DATABASE() AS db');
      res.json({
        success: true,
        message: '连接成功',
        version: rows && rows[0] ? rows[0].version : null,
        database: rows && rows[0] ? rows[0].db : database
      });
    } finally {
      if (connection) {
        try { await connection.end(); } catch (_) { /* 关闭失败不影响测试结论 */ }
      }
    }
  } catch (error) {
    res.status(400).json({ success: false, error: '连接失败: ' + error.message });
  }
});

// 获取目标数据库表信息（预览）
app.post('/api/db-target-info', requireAuth, async (req, res) => {
  const config = req.body;
  try {
    // 修复 I6: 单一连接,循环复用,避免每个表都做 TCP 握手 + auth
    const mysql = require('mysql2/promise');
    let connection = null;
    let tables = [];
    if (config.type === 'mysql') {
      connection = await mysql.createConnection({
        host: config.mysql.host,
        port: config.mysql.port,
        user: config.mysql.user,
        password: config.mysql.password,
        database: config.mysql.database
      });
      const [rows] = await connection.query('SHOW TABLES');
      tables = rows.map(row => Object.values(row)[0]);
    } else {
      tables = db.getAllTables();
    }

    const tableInfo = [];
    for (const tableName of tables) {
      let count = 0;
      try {
        if (connection) {
          const [countResult] = await connection.query(`SELECT COUNT(*) as c FROM \`${tableName}\``);
          count = countResult[0].c;
        } else {
          count = await db.getTableCount(tableName);
        }
      } catch (e) {
        count = 0;
      }
      tableInfo.push({ name: tableName, count });
    }
    if (connection) await connection.end();

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
    const tables = config.type === 'mysql' ? ['admin', 'products', 'settings', 'users', 'orders', 'faqs', 'support_tickets', 'activations', 'installations'] : db.getAllTables();

    // 修复 I6: 单一连接,循环复用
    const mysql = require('mysql2/promise');
    let connection = null;
    if (config.type === 'mysql') {
      connection = await mysql.createConnection({
        host: config.mysql.host,
        port: config.mysql.port,
        user: config.mysql.user,
        password: config.mysql.password,
        database: config.mysql.database
      });
    }

    for (const table of tables) {
      try {
        let count = 0;
        if (connection) {
          const [countResult] = await connection.query("SELECT COUNT(*) as c FROM ??", [table]);
          count = countResult[0].c;
        } else {
          count = await db.getTableCount(table);
        }
        results.push({ table, count, status: 'ok' });
      } catch (e) {
        results.push({ table, count: 0, status: 'error', error: e.message });
      }
    }
    if (connection) await connection.end();

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

    // 修复 S4：限制目标 host —— 仅允许复制到当前 DB 主机或 DB_COPY_ALLOWED_HOSTS 环境变量白名单
    const sourceHost = (db.getDbConfig().mysql && db.getDbConfig().mysql.host) || '';
    const allowList = (process.env.DB_COPY_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
    const allowed = allowList.includes(config.mysql.host) || config.mysql.host === sourceHost;
    if (!allowed) {
      writeOperationLog('DB_COPY_BLOCKED', req.session.username, `Blocked host: ${config.mysql.host}`);
      return res.status(403).json({ success: false, error: '目标主机未在白名单（设置 DB_COPY_ALLOWED_HOSTS 或与源 DB 同主机）' });
    }
    if (!Number.isInteger(config.mysql.port) || config.mysql.port < 1 || config.mysql.port > 65535) {
      return res.status(400).json({ success: false, error: '端口必须在 1-65535 之间' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(config.mysql.user || '')) {
      return res.status(400).json({ success: false, error: '用户名格式无效' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(config.mysql.database || '')) {
      return res.status(400).json({ success: false, error: '数据库名格式无效' });
    }

    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      connectTimeout: 5000  // 5s 连接超时，避免 SSRF 长时间 hang
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
      // 修复 I19: 切换后需要关闭旧 session store 的 pool(否则它仍指向旧 host)
      // 旧连接会随时间被新连接覆盖,但显式关闭更清晰
      if (sessionStore && typeof sessionStore.close === 'function') {
        try { await sessionStore.close(); } catch (_) { /* 旧 store 已断 */ }
      }
      db.updateDbConfig({ type: 'mysql' });
      // 警告:db-switch 切换后,session store 用的是旧 pool,所有现有 session 会失效
      // 这通常是 admin 主动行为,可以接受
      res.json({ success: true, message: '已切换到 MySQL' });
    } else {
      res.status(400).json({ error: '无效的数据库类型或MySQL未配置' });
    }
  } catch (error) {
    res.status(500).json({ error: '切换失败: ' + error.message });
  }
});

// 初始化 / 修复数据库表结构
//
// 全程幂等，可以随时重复执行：
//   - 建表用 CREATE TABLE IF NOT EXISTS
//   - 补列用 ALTER TABLE ... ADD COLUMN，Duplicate column 被吞掉
//   - 默认数据只在目标表为空时灌入
//
// 注意：这里用的是应用自己的连接池（db.createTablesIfNotExist），
// 而不是请求体里传来的配置 —— 建表必须在「站点真正在用的那个库」上做。
app.post('/api/db-init', requireAuth, async (req, res) => {
  try {
    await db.createTablesIfNotExist();
    await db.initDefaultData();
    const integrity = await db.verifyDataIntegrity();
    res.json({
      success: true,
      message: '数据库初始化完成',
      configSource: db.getDbConfigSource(),
      tables: integrity.results
    });
  } catch (error) {
    console.error('DB init error:', error);
    res.status(500).json({ success: false, error: '初始化失败: ' + error.message });
  }
});

// 导出数据（JSON格式）
app.get('/api/db-export', requireAuth, async (req, res) => {
  const data = {
    products: await db.getAllProducts(),
    settings: await db.getSettings(),
    exportedAt: new Date().toISOString()
  };
  res.json(data);
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

// 迁移到MySQL — 此端点为遗留 stub,迁移已通过 prisma/diff.js 替代
app.post('/api/db-migrate', requireAuth, async (req, res) => {
  res.status(501).json({ error: '此端点已弃用,请使用 prisma/diff.js --apply' });
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

app.get('/admin-product-docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-product-docs.html'));
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

app.get('/admin-mcp', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-mcp.html'));
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

app.get('/license', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'license.html'));
});

app.get('/help', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

// 产品文档详情页 - 公开
app.get('/doc/:productSlug/:docSlug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'doc.html'));
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

app.get('/admin-user-software-status', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-user-software-status.html'));
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
        <p style="margin-top: 20px;"><a href="http://${settings.ssl?.domain || 'localhost:' + (process.env.PORT || 15000)}/admin-support" style="background: #133c8a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">查看工单</a></p>
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
  if (typeof content !== 'string' || content.length > 10000) {
    return res.status(400).json({ error: '回复内容长度必须在 1-10000 字符之间' });
  }
  // 修复 S8：转义 content 防邮件客户端 XSS（admin 被劫持后可注入钓鱼链接）
  const safeContent = escapeHtml(content);

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
          ${safeContent}
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

// Express 错误处理中间件 - 兜底所有同步错误和 next(err) 调用
// 注意：必须放在所有路由之后，且有 4 个参数（Express 靠参数数量识别 error handler）
app.use((err, req, res, next) => {
  console.error('[Express Error]', req.method, req.url, '-', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 启动服务器
async function startServer() {
  try {
    // 初始化数据库。
    //
    // 关键：**不能**因为数据库连不上就退出进程。
    // 「数据库连不上」恰恰是最需要安装向导的场景 —— 向导要是跟着进程一起没了，
    // 操作者就只能去服务器上手改 .env 再重启，界面化初始化就失去了意义。
    // 这里降级启动：/setup 与 /api/setup/* 照常可用，
    // 其余依赖数据库的接口由安装闸门统一返回 503 并指向 /setup。
    let databaseReady = true;
    try {
      await db.initDatabase();
      console.log('Database initialized');
    } catch (error) {
      databaseReady = false;
      console.error('');
      console.error('  ✖ 数据库初始化失败:', error.message);
      console.error('    服务以降级模式启动：/setup 安装向导可用，其余依赖数据库的接口返回 503。');
      console.error('    请打开 /setup 按提示修正数据库连接配置。');
      console.error('');
    }

    // 安装闸门：站点还没装好（没有管理员账号）时，生成安装令牌并打进控制台
    try {
      const setupState = await setupService.getSetupState(db, { force: true });
      if (!setupState.installed && (!setupState.undetermined || setupState.dbUnreachable)) {
        // 两种情况都要令牌：
        //   - 确定未安装（全新部署）
        //   - 数据库连不上（站点是坏的，需要向导改配置来救）
        // 后者此时无法判断站点是否已安装，但令牌只打进控制台、
        // 数据库恢复后若站点已安装，闸门会立刻把安装接口关掉。
        setupService.ensureSetupToken(
          setupState.dbUnreachable ? { reason: 'db-unreachable' } : undefined
        );
      } else if (setupState.installed && process.env.SETUP_TOKEN) {
        // 站点已装好，但 .env 里还留着安装令牌 —— 进程环境变量删不掉，
        // 这个令牌会一直有效，安装接口也就一直开着。必须提醒运维处理。
        console.warn('');
        console.warn('  ⚠ 站点已完成安装，但 .env 里仍设置了 SETUP_TOKEN。');
        console.warn('    安装接口将持续可用。请从 .env 中删除 SETUP_TOKEN 并重启服务。');
        console.warn('');
      }
    } catch (setupError) {
      console.error('[setup] 安装状态检查失败:', setupError.message);
    }

    // trust proxy: loopback — 仅信任来自 127.0.0.1 的 X-Forwarded-For（nginx 反代场景）
    // 配置 nginx 时务必用 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    // 这样 req.ip / getClientIp() 拿到的是真实客户端 IP,限流/审计日志正确
    // 注: 'loopback' = 仅信任 127.0.0.1/::1,公网直连伪造 XFF 头无效
    app.set('trust proxy', 'loopback');

    // 端口从 .env 读,不走 DB settings(http_port/https_port 列已删除,nginx 终止 SSL 后只需 1 个 HTTP 端口)
    const HTTP_PORT = parseInt(process.env.PORT, 10) || 15000;
    // 读 settings 仅用于启动期可能需要的其他配置；数据库不可用时读不到是正常的，不能因此中断启动
    let settings = null;
    try {
      settings = await db.getSettings();
    } catch (settingsError) {
      console.warn('[startup] 读取站点设置失败:', settingsError.message);
    }

    // 启动 HTTP 服务器 — 绑定 127.0.0.1(loopback)而非 0.0.0.0
    // 配套 nginx 反代: 客户端 → nginx(80/443) → 127.0.0.1:15000
    // 绑 loopback 防止公网绕过 nginx 直连,所有流量必经反代(SSL 终止 / gzip / 限流 / HSTS)
    const server = app.listen(HTTP_PORT, '127.0.0.1', () => {
      console.log(`HTTP Server running at http://127.0.0.1:${HTTP_PORT} (behind nginx)`);
      if (!databaseReady) {
        console.log('  注意：数据库当前不可用，请打开 /setup 修正连接配置。');
      }
    });
    // 显式处理 listen 错误(EADDRINUSE 等不会进入 try/catch,会触发 'error' 事件)
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`FATAL: port ${HTTP_PORT} is already in use. Refusing to start.`);
      } else {
        console.error('FATAL: server listen error:', err);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
