'use strict';

/**
 * Init 流程的服务层。
 *
 * 职责：
 *   1. 读取初始化状态（并做短缓存，避免每个请求都打 DB）
 *   2. 提供闸门：只有「确定未初始化」才放行 Init 写操作
 *
 * 明确不做的事：
 *   - 不缓存「已初始化」的判定超过 STATE_CACHE_MS，避免管理员刚建好还装得上
 *
 * 关于令牌：Init 令牌机制已整体移除。原先的 data/init-token.txt、
 * INIT_TOKEN / SETUP_TOKEN 环境变量、/api/init/verify-token 接口都不再存在。
 * 现在 Init 流程的准入完全由「初始化状态」决定：
 *   - 未初始化 → 放行（任何人访问 /init 都能走完流程）
 *   - 已初始化 → 永久关闭所有 Init 接口
 */

const policy = require('./init-policy');
const envFile = require('./env-file');

/** 安装状态缓存时长（毫秒） */
const STATE_CACHE_MS = 5000;

let stateCache = null;

/** 让状态缓存失效 —— 管理员创建成功 / 配置变更后必须调用 */
function invalidateState() {
  stateCache = null;
}

/**
 * 读 .env 里的「已初始化」标志。
 *
 * 标志是判定链的第一环 —— 它记录的是「初始化这件事做完没有」，
 * 而不是「数据库连不连得上」。因此它读的是**文件**（.env），
 * 不是 process.env：文件才是运维看得见、改得动的那一份。
 *
 * 认两种拼写：大写 INITIALIZED（向导写进去的）与小写 initialized
 * （手工编辑 .env 的人常这么写）。文件里没有时再看进程环境变量 ——
 * 容器部署用环境变量注入 .env 内容时，只有进程里才看得到。
 *
 * @returns {boolean}
 */
function readInitializedFlag() {
  const env = envFile.readEnvFile();
  if (env.error) {
    // .env 读不出来 —— 不能当成「已初始化」（宁可多开一次 Init 接口）
    console.error('[init] 读取 .env 失败，判定为未初始化:', env.error);
    return false;
  }
  const values = env.values || {};
  const raw = values[policy.INITIALIZED_FLAG_KEY] !== undefined
    ? values[policy.INITIALIZED_FLAG_KEY]
    : values.initialized;
  const fromFile = policy.isInitializedFlagTrue(raw);

  if (fromFile) return true;

  // 文件里没有（或不是真值）→ 退回进程环境变量
  const fromEnv = process.env[policy.INITIALIZED_FLAG_KEY] !== undefined
    ? process.env[policy.INITIALIZED_FLAG_KEY]
    : process.env.initialized;
  return policy.isInitializedFlagTrue(fromEnv);
}

/**
 * 读取初始化状态。
 *
 * 判定是双保险（详见 lib/init-policy.js 文件头）：
 *   ① .env 里 INITIALIZED=True
 *   ② users 表里确实有 is_admin=1 的账号
 * 两个条件必须同时成立才算「已初始化」。
 *
 * 关键：DB 不可达或查询出错时返回 undetermined=true，
 * 此时 installed=false 但闸门同样拒绝写操作（fail-closed）。
 *
 * 只查「users 表里有没有管理员」这一件事 —— 缺失表清单留给界面按需再查，
 * 避免每次状态判定都跑 5 条 SQL。
 */
async function readInitState(db) {
  const result = {
    dbReachable: false,
    tablesReady: false,
    adminCount: 0,
    initializedFlag: false,
    installed: false,
    undetermined: false,
    dbUnreachable: false,
    error: null
  };

  // 标志先读 —— 它不依赖数据库，数据库坏了也要能报出「初始化过没有」
  result.initializedFlag = readInitializedFlag();

  let adminCount = 0;
  try {
    adminCount = await db.countAdmins();
    result.dbReachable = true;
  } catch (error) {
    if (policy.isMissingTableError(error)) {
      // users 表都还没有 —— 肯定没装
      result.dbReachable = true;
      return policy.evaluateInitState({ ...result, adminCount: 0 });
    }
    // 其它异常 —— 无法判定。区分「数据库当前不可用」和「连上了但判定 SQL 失败」：
    // 前者（连不上 / 认证不过）是站点本来就没配置对，需要向导来救；
    // 后者必须 fail-closed。
    result.undetermined = true;
    result.dbUnreachable = policy.isDbUnavailableError(error);
    result.error = error.message;
    return result;
  }

  return policy.evaluateInitState({ ...result, adminCount });
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
async function getInitState(db, options) {
  const force = Boolean(options && options.force);
  const now = Date.now();
  if (!force && stateCache && now - stateCache.at < STATE_CACHE_MS) {
    return stateCache.value;
  }
  const value = await readInitState(db);
  stateCache = { at: now, value };
  return value;
}

/**
 * Init 写操作的闸门。
 *
 * 只有「确定未初始化」才放行，即：数据库连得上、判据没出错、
 * 而且「标志 + 管理员」两个条件没有同时成立。
 *
 * 「标志缺失但管理员已存在」（存量站点升级忘了补标志）**也算未初始化** ——
 * 那是恢复路径，向导要能把标志补上。恢复路径下新建管理员会被挡掉
 * （见 server.js 里 complete-install 的第 ⑤ 步），只允许认领已有管理员。
 *
 * 其余一律拒绝：
 *   - undetermined → DB_UNREACHABLE（fail-closed）
 *   - 已初始化（标志 + 管理员齐了）→ ALREADY_INSTALLED
 *
 * 注意：这里对「数据库连不上」也是 fail-closed —— 建表、创建管理员都离不开
 * 数据库，DB 不通时本来就做不了。改数据库**配置**是另一回事，见
 * checkInitConfigWritable()。
 */
async function checkInitWritable(db, options) {
  const state = await getInitState(db, options);
  if (state.undetermined) {
    return { ok: false, code: policy.INIT_ERROR_CODES.DB_UNREACHABLE, state };
  }
  if (state.installed) {
    return { ok: false, code: policy.INIT_ERROR_CODES.ALREADY_INSTALLED, state };
  }
  return { ok: true, state };
}

/**
 * 「改数据库配置」这类操作的闸门 —— 与 checkInitWritable 的区别在于
 * 允许数据库连不上的场景。
 *
 * 理由：数据库连不上恰恰是操作者需要用向导改配置来修复的时刻，
 * 如果这里也 fail-closed，向导在唯一该生效的场景里就废了。
 *
 * 放行条件：
 *   - 确定未初始化                       → 放行
 *   - 数据库当前不可用（dbUnreachable） → 放行（站点本来就是坏的：连不上或账号认证不过）
 *   - 已初始化                           → 拒绝 ALREADY_INSTALLED
 *   - 连得上、认证也过了，只是判断不了 → 拒绝 DB_UNREACHABLE（fail-closed）
 */
async function checkInitConfigWritable(db, options) {
  const state = await getInitState(db, options);
  if (state.installed) {
    return { ok: false, code: policy.INIT_ERROR_CODES.ALREADY_INSTALLED, state };
  }
  if (state.undetermined && !state.dbUnreachable) {
    return { ok: false, code: policy.INIT_ERROR_CODES.DB_UNREACHABLE, state };
  }
  return { ok: true, state };
}

module.exports = {
  STATE_CACHE_MS,
  invalidateState,
  readInitializedFlag,
  readInitState,
  describeSchema,
  getInitState,
  checkInitWritable,
  checkInitConfigWritable
};
