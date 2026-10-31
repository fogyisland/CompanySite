'use strict';

/**
 * 安装（初始化）流程的服务层。
 *
 * 职责：
 *   1. 管理安装令牌（SETUP_TOKEN 环境变量 > data/setup-token.txt > 自动生成）
 *   2. 读取安装状态（并做短缓存，避免每个请求都打 DB）
 *   3. 提供闸门：只有「确定未安装」才放行安装写操作
 *
 * 明确不做的事：
 *   - 不缓存「已安装」的判定超过 STATE_CACHE_MS，避免管理员刚建好还装得上
 *   - 不在任何 HTTP 响应里回显令牌明文（令牌只出现在服务器控制台和 data/ 目录）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const policy = require('./setup-policy');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'setup-token.txt');
const TOKEN_BYTES = 24;
/** 令牌最小长度 —— 低于这个长度的环境变量值视为未配置 */
const MIN_TOKEN_LENGTH = 16;
/** 安装状态缓存时长（毫秒） */
const STATE_CACHE_MS = 5000;

let stateCache = null;

/**
 * 读取当前安装令牌。
 * @returns {string} 令牌；没有则返回空串
 */
function readSetupToken() {
  const fromEnv = process.env.SETUP_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.trim().length >= MIN_TOKEN_LENGTH) {
    return fromEnv.trim();
  }
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const content = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (content.length >= MIN_TOKEN_LENGTH) return content;
    }
  } catch (error) {
    console.error('[setup] 读取安装令牌失败:', error.message);
  }
  return '';
}

/**
 * 确保存在一个可用的安装令牌；没有就生成一个并落盘 + 打日志。
 *
 * 只在「确定未安装」或「数据库连不上」时调用 —— 已安装的站点不该再生成令牌。
 *
 * @param {object} [options]
 * @param {string} [options.reason] 'db-unreachable' 表示「数据库连不上，
 *        需要用向导改连接配置」；不传则表示「站点还没装完」
 */
function ensureSetupToken(options) {
  const existing = readSetupToken();
  if (existing) return existing;

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.error('[setup] 安装令牌落盘失败:', error.message);
  }

  const dbUnreachable = Boolean(options && options.reason === 'db-unreachable');
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  if (dbUnreachable) {
    console.log('  ║  数据库当前不可用，请打开 /setup 修正连接配置         ║');
  } else {
    console.log('  ║  站点尚未完成安装，请打开 /setup 完成初始化            ║');
  }
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log(`  安装令牌: ${token}`);
  console.log(`  令牌文件: ${TOKEN_FILE}`);
  if (dbUnreachable) {
    console.log('  该令牌用于修正数据库连接配置；数据库恢复后若站点已安装，令牌会自动失效。');
  } else {
    console.log('  安装完成后该令牌与文件会被自动销毁。');
  }
  console.log('');
  return token;
}

/**
 * 定长比较 —— 先各自 sha256 再 timingSafeEqual，
 * 避免令牌长度或内容被时序侧信道推断。
 */
function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** 安装完成后销毁令牌 —— 之后即便有人拿到旧令牌也无法再调安装接口 */
function consumeSetupToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (error) {
    console.error('[setup] 删除安装令牌失败:', error.message);
  }
  invalidateState();
}

/** 让状态缓存失效 —— 管理员创建成功 / 配置变更后必须调用 */
function invalidateState() {
  stateCache = null;
}

/**
 * 读取安装状态。
 *
 * 关键：DB 不可达或查询出错时返回 undetermined=true，
 * 此时 installed=false 但闸门同样拒绝写操作（fail-closed）。
 *
 * 只查「users 表里有没有管理员」这一件事 —— 缺失表清单留给界面按需再查，
 * 避免每次状态判定都跑 5 条 SQL。
 */
async function readSetupState(db) {
  const result = {
    dbReachable: false,
    tablesReady: false,
    adminCount: 0,
    installed: false,
    undetermined: false,
    dbUnreachable: false,
    error: null
  };

  let adminCount = 0;
  try {
    adminCount = await db.countAdmins();
    result.dbReachable = true;
  } catch (error) {
    if (policy.isMissingTableError(error)) {
      // users 表都还没有 —— 肯定没装
      result.dbReachable = true;
      return policy.evaluateSetupState({ ...result, adminCount: 0 });
    }
    // 其它异常 —— 无法判定。区分「数据库当前不可用」和「连上了但判定 SQL 失败」：
    // 前者（连不上 / 认证不过）是站点本来就没配置对，需要向导来救；
    // 后者必须 fail-closed。
    result.undetermined = true;
    result.dbUnreachable = policy.isDbUnavailableError(error);
    result.error = error.message;
    return result;
  }

  return policy.evaluateSetupState({ ...result, adminCount });
}

/**
 * 补充界面需要的表清单信息（缺哪些核心表）。
 * 单独提供是因为它要跑多条查询，不该进状态判定的热路径。
 */
async function describeSchema(db) {
  const missingTables = await listMissingTables(db);
  return {
    missingTables,
    tablesReady: missingTables.length === 0,
    requiredTables: policy.REQUIRED_TABLES
  };
}

/** 列出缺失的核心表 —— 仅用于展示，失败不致命 */
async function listMissingTables(db) {
  const missing = [];
  for (const tableName of policy.REQUIRED_TABLES) {
    try {
      const exists = await db.tableExists(tableName);
      if (!exists) missing.push(tableName);
    } catch (error) {
      missing.push(tableName);
    }
  }
  return missing;
}

/** 带短缓存的状态读取 */
async function getSetupState(db, options) {
  const force = Boolean(options && options.force);
  const now = Date.now();
  if (!force && stateCache && now - stateCache.at < STATE_CACHE_MS) {
    return stateCache.value;
  }
  const value = await readSetupState(db);
  stateCache = { at: now, value };
  return value;
}

/**
 * 安装写操作的闸门。
 *
 * 只有「确定未安装」（dbReachable && !undetermined && adminCount === 0）才放行。
 * 其余一律拒绝：
 *   - undetermined → DB_UNREACHABLE（fail-closed）
 *   - adminCount > 0 → ALREADY_INSTALLED
 *
 * 注意：这里对「数据库连不上」也是 fail-closed —— 建表、创建管理员都离不开
 * 数据库，DB 不通时本来就做不了。改数据库**配置**是另一回事，见
 * checkSetupConfigWritable()。
 */
async function checkSetupWritable(db, options) {
  const state = await getSetupState(db, options);
  if (state.undetermined) {
    return { ok: false, code: policy.SETUP_ERROR_CODES.DB_UNREACHABLE, state };
  }
  if (state.installed) {
    return { ok: false, code: policy.SETUP_ERROR_CODES.ALREADY_INSTALLED, state };
  }
  return { ok: true, state };
}

/**
 * 「改数据库配置」这类操作的闸门 —— 与 checkSetupWritable 的区别在于
 * 允许数据库连不上的场景。
 *
 * 理由：数据库连不上恰恰是操作者需要用向导改配置来修复的时刻，
 * 如果这里也 fail-closed，向导在唯一该生效的场景里就废了。
 *
 * 放行条件：
 *   - 确定未安装                       → 放行
 *   - 数据库当前不可用（dbUnreachable） → 放行（站点本来就是坏的：连不上或账号认证不过）
 *   - 已安装                           → 拒绝 ALREADY_INSTALLED
 *   - 连得上、认证也过了，只是判断不了 → 拒绝 DB_UNREACHABLE（fail-closed）
 */
async function checkSetupConfigWritable(db, options) {
  const state = await getSetupState(db, options);
  if (state.installed) {
    return { ok: false, code: policy.SETUP_ERROR_CODES.ALREADY_INSTALLED, state };
  }
  if (state.undetermined && !state.dbUnreachable) {
    return { ok: false, code: policy.SETUP_ERROR_CODES.DB_UNREACHABLE, state };
  }
  return { ok: true, state };
}

/**
 * 校验安装令牌。
 * @returns {{ ok: boolean, code?: string }}
 */
function verifySetupToken(candidate) {
  const expected = readSetupToken();
  if (!expected) {
    return { ok: false, code: policy.SETUP_ERROR_CODES.TOKEN_REQUIRED };
  }
  if (!tokenMatches(candidate, expected)) {
    return { ok: false, code: policy.SETUP_ERROR_CODES.TOKEN_INVALID };
  }
  return { ok: true };
}

module.exports = {
  DATA_DIR,
  TOKEN_FILE,
  STATE_CACHE_MS,
  readSetupToken,
  ensureSetupToken,
  tokenMatches,
  consumeSetupToken,
  invalidateState,
  readSetupState,
  describeSchema,
  getSetupState,
  checkSetupWritable,
  checkSetupConfigWritable,
  verifySetupToken
};
