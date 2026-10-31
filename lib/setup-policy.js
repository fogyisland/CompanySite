'use strict';

/**
 * 安装（初始化）流程的策略原语 —— 唯一事实来源（single source of truth）。
 *
 * 与 lib/content-policy.js / lib/product-policy.js / lib/order-policy.js 同构：
 * 「什么算装好了」「什么输入是合法的」写在这里，
 * server.js 的路由层只负责取参、调用、拼响应，不重复实现判定规则。
 *
 * 安全要点：
 *   1. installed 的唯一权威依据是「users 表里有没有 is_admin=1 的账号」。
 *      建表、灌默认数据都是幂等的，不能拿来当闸门 —— 否则「表建好了但管理员
 *      还没创建」的窗口期内，install 闸门会重新打开。
 *   2. DB 不可达 / 查询出错时状态是 undetermined（无法判定），
 *      闸门必须 fail-closed（拒绝写操作），绝不能 fail-open。
 *      —— 但「改数据库配置」这类操作是例外：它恰恰是「数据库不可用时唯一的
 *      救命手段」，一刀切 fail-closed 会让向导在唯一该生效的场景里彻底没用。
 *      例外范围的判定见 isDbUnavailableError()。
 *   3. 管理员密码过 bcrypt 的 72 字节上限会被静默截断，
 *      所以长度上限按「字节」而不是「字符」算。
 */

const SETUP_ERROR_CODES = Object.freeze({
  TOKEN_REQUIRED: 'TOKEN_REQUIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  ALREADY_INSTALLED: 'ALREADY_INSTALLED',
  DB_UNREACHABLE: 'DB_UNREACHABLE',
  DB_CONFIG_INVALID: 'DB_CONFIG_INVALID',
  ADMIN_USERNAME_INVALID: 'ADMIN_USERNAME_INVALID',
  ADMIN_PASSWORD_WEAK: 'ADMIN_PASSWORD_WEAK',
  ADMIN_EMAIL_INVALID: 'ADMIN_EMAIL_INVALID',
  ADMIN_USERNAME_TAKEN: 'ADMIN_USERNAME_TAKEN'
});

/** 安装完成的判定依据 —— 缺任意一张说明 schema 还没建好 */
const REQUIRED_TABLES = Object.freeze(['users', 'settings', 'products', 'orders']);

/** 用户名：3~32 位，字母/数字/下划线/点/连字符 —— 挡掉空白与控制字符 */
const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;

/** 邮箱：宽松但要求有 TLD；空串视为「不填」 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MIN_ADMIN_PASSWORD_LENGTH = 8;
/** bcrypt 只取前 72 字节，超出部分被静默丢弃 —— 必须在入参侧就拒绝 */
const BCRYPT_MAX_PASSWORD_BYTES = 72;
const MAX_EMAIL_LENGTH = 254;

function isAdminUsernameValid(username) {
  if (typeof username !== 'string') return false;
  return ADMIN_USERNAME_PATTERN.test(username);
}

/**
 * 管理员密码强度：至少 8 位，且必须同时含字母与数字。
 * 纯字母 / 纯数字 / 纯符号全部挡掉。
 */
function isAdminPasswordStrong(password) {
  if (typeof password !== 'string') return false;
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) return false;
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_PASSWORD_BYTES) return false;
  if (!/[A-Za-z]/.test(password)) return false;
  if (!/\d/.test(password)) return false;
  return true;
}

/** 邮箱可选；填了就必须是合法邮箱 */
function isEmailValid(email) {
  if (email === undefined || email === null) return true;
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed === '') return true;
  if (trimmed.length > MAX_EMAIL_LENGTH) return false;
  return EMAIL_PATTERN.test(trimmed);
}

/**
 * 校验数据库连接配置并归一化。
 * @returns {{ config: object } | { error: string }}
 */
function validateDbConfig(config) {
  if (!config || typeof config !== 'object') {
    return { error: SETUP_ERROR_CODES.DB_CONFIG_INVALID };
  }
  const mysql = config.mysql;
  if (!mysql || typeof mysql !== 'object') {
    return { error: SETUP_ERROR_CODES.DB_CONFIG_INVALID };
  }

  const host = typeof mysql.host === 'string' ? mysql.host.trim() : '';
  const user = typeof mysql.user === 'string' ? mysql.user.trim() : '';
  const database = typeof mysql.database === 'string' ? mysql.database.trim() : '';

  if (!host || !user || !database) {
    return { error: SETUP_ERROR_CODES.DB_CONFIG_INVALID };
  }

  const port = Number(mysql.port || 3306);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { error: SETUP_ERROR_CODES.DB_CONFIG_INVALID };
  }

  return {
    config: {
      type: 'mysql',
      mysql: {
        host,
        port,
        user,
        password: typeof mysql.password === 'string' ? mysql.password : '',
        database
      }
    }
  };
}

/**
 * 判定安装状态。
 *
 * @param {object} input
 * @param {boolean} input.dbReachable 能否查到 users 表
 * @param {number}  input.adminCount  is_admin=1 的账号数
 * @param {boolean} input.tablesReady  REQUIRED_TABLES 是否齐全
 * @param {boolean} input.undetermined 是否无法判定（DB 异常）
 * @param {boolean} input.dbUnreachable 无法判定的原因是不是「数据库当前不可用」
 *        （连不上，或连上了但账号认证不过）
 */
function evaluateSetupState(input) {
  const source = input && typeof input === 'object' ? input : {};
  const dbReachable = source.dbReachable === true;
  const undetermined = source.undetermined === true;
  const adminCount = dbReachable && !undetermined ? Number(source.adminCount) || 0 : 0;

  return {
    installed: !undetermined && dbReachable && adminCount > 0,
    dbReachable,
    tablesReady: source.tablesReady === true,
    adminCount,
    undetermined,
    dbUnreachable: undetermined && source.dbUnreachable === true
  };
}

/**
 * 管理员账号入参校验，返回规范化字段或错误码。
 * @returns {{ admin: object } | { error: string }}
 */
function validateAdminInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const username = typeof source.username === 'string' ? source.username.trim() : '';
  const password = typeof source.password === 'string' ? source.password : '';
  const email = typeof source.email === 'string' ? source.email.trim() : '';

  if (!isAdminUsernameValid(username)) {
    return { error: SETUP_ERROR_CODES.ADMIN_USERNAME_INVALID };
  }
  if (!isAdminPasswordStrong(password)) {
    return { error: SETUP_ERROR_CODES.ADMIN_PASSWORD_WEAK };
  }
  if (!isEmailValid(email)) {
    return { error: SETUP_ERROR_CODES.ADMIN_EMAIL_INVALID };
  }

  return { admin: { username, password, email } };
}

/** 判断 MySQL 错误是不是「表不存在」 */
function isMissingTableError(error) {
  if (!error) return false;
  if (error.code === 'ER_NO_SUCH_TABLE') return true;
  return error.errno === 1146;
}

/**
 * 「数据库当前不可用」的判定 —— 分三类，第三类必须 fail-closed。
 *
 * 这三种情况在 countAdmins() 里长得一模一样（都抛异常），但结论完全相反：
 *
 *   A. 连不上（拒绝连接 / 超时 / 主机不存在 / 连接池没建起来）
 *      → 站点本来就是坏的，操作者需要通过向导改数据库配置来救它。
 *        如果这里 fail-closed，向导会在「数据库坏了」这个唯一场景下彻底没用。
 *
 *   B. 连上了但**认证不过**（账号密码错 / 账号对该库没权限）
 *      → 性质同上：错的正是「这份数据库配置」，改配置就是标准解法。
 *        这一类最典型的就是全新部署 —— 仓库里不带 .env，进程按默认值连
 *        root@localhost 且不带密码，MySQL 直接回 ER_ACCESS_DENIED_ERROR。
 *        如果把它当成「连上了但查询失败」，全新部署时向导连 .env 都写不出来，
 *        安装流程在第一步就卡死 —— 这正是安装向导要解决的场景。
 *
 *   C. 连上了、认证也过了，只是**判定安装状态的那条 SQL 失败**
 *      （列缺失 / SQL 写错 / 表级权限不足）
 *      → 站点多半是装好的，只是这次判断不了。此时必须 fail-closed，
 *        否则一个「已装好但数据库账号权限异常」的站点会被重新指向别的库。
 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  // 连接池压根没建起来（初始化就失败了）—— 同样属于「连不上」
  'POOL_NOT_READY'
]);

/**
 * 认证失败类错误码。
 *
 *   - ER_ACCESS_DENIED_ERROR (1045)：账号密码错 —— 最常见的一种
 *   - ER_DBACCESS_DENIED_ERROR (1044)：账号本身没问题，但没有目标库的权限
 *     （常见于 DB_NAME 填错、或漏了 GRANT）
 *
 * 刻意**不**包含 ER_TABLEACCESS_DENIED_ERROR (1142)：
 * 那是「账号对某个表没有 SELECT 权限」，属于上面的 C 类 —— 连得上也认证得过，
 * 只是那条判定 SQL 跑不通，必须 fail-closed。
 */
const AUTH_ERROR_CODES = new Set([
  'ER_ACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR'
]);

/** 对应的 MySQL errno —— 某些驱动/代理只给 errno，不给 code */
const AUTH_ERROR_ERRNOS = new Set([
  1045,
  1044
]);

function isConnectionError(error) {
  if (!error) return false;
  if (typeof error.code === 'string' && CONNECTION_ERROR_CODES.has(error.code)) return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|Connection lost|Lost connection|connect ETIMEDOUT/i.test(message);
}

/**
 * 判断是不是「认证失败」（连上了但账号不认）。
 *
 * 单独拎出来是因为它和「连不上」一样都属于「当前这份配置不管用」，
 * 但两者在日志和提示文案上要分开说 —— 一个是「找不到数据库」，
 * 一个是「数据库找到了但不让你进」。
 *
 * @param {Error} error
 * @returns {boolean}
 */
function isAuthError(error) {
  if (!error) return false;
  if (typeof error.code === 'string' && AUTH_ERROR_CODES.has(error.code)) return true;
  if (typeof error.errno === 'number' && AUTH_ERROR_ERRNOS.has(error.errno)) return true;
  const message = typeof error.message === 'string' ? error.message : '';
  // 文案兜底：驱动被换掉或错误被包装过一层时，code/errno 可能已经丢了
  return /Access denied for user/i.test(message);
}

/**
 * 「数据库当前不可用」—— 连不上（A）或认证不过（B）。
 *
 * 放行「改数据库配置」类操作（test-db / save-db-config）时，
 * 判据就是它；而「建表 / 创建管理员」这类写操作不看它 —— 那两件事
 * 没有可用的数据库本来就做不了，一律 fail-closed。
 *
 * @param {Error} error
 * @returns {boolean}
 */
function isDbUnavailableError(error) {
  return isConnectionError(error) || isAuthError(error);
}

/**
 * 安装时生成的 .env 键清单。
 *
 * 分三类：
 *   1. 用户填写 —— 机器猜不出来的：数据库连接参数。
 *   2. 机器生成 —— 随机密钥，运维不需要也不该自己编：SESSION_SECRET / CRON_TOKEN。
 *   3. 默认值 —— 有合理默认的：PORT。
 *
 * 刻意**不写**的两个键：
 *   - SETUP_TOKEN：写进去就永久有效（进程环境变量删不掉），安装完成后
 *     安装接口会一直开着。令牌只在 data/setup-token.txt 里存在一次。
 *   - MCP_TOKEN：主令牌改由后台「系统设置 → MCP」点击生成/轮换，
 *     存在数据库里，不进 .env。
 */
const INSTALL_ENV_KEYS = Object.freeze({
  PORT: 'PORT',
  SESSION_SECRET: 'SESSION_SECRET',
  CRON_TOKEN: 'CRON_TOKEN',
  DB_HOST: 'DB_HOST',
  DB_PORT: 'DB_PORT',
  DB_USER: 'DB_USER',
  DB_PASSWORD: 'DB_PASSWORD',
  DB_NAME: 'DB_NAME'
});

/**
 * 构造安装时写入 .env 的条目列表。
 *
 * @param {object} options
 * @param {object} options.mysql            已通过 validateDbConfig 的数据库参数
 * @param {number} [options.port=15000]     HTTP 端口
 * @param {string} options.sessionSecret    生成的会话密钥
 * @param {string} options.cronToken        生成的定时任务令牌
 * @returns {Array<{key: string, value: string, group?: string, comment?: string}>}
 */
function buildInstallEnvEntries(options) {
  const source = options && typeof options === 'object' ? options : {};
  const mysql = source.mysql && typeof source.mysql === 'object' ? source.mysql : {};
  const port = Number(source.port) > 0 ? Number(source.port) : 15000;

  return [
    {
      key: INSTALL_ENV_KEYS.PORT,
      value: String(port),
      group: 'Server'
    },
    {
      key: INSTALL_ENV_KEYS.SESSION_SECRET,
      value: String(source.sessionSecret || ''),
      group: 'Session signing',
      comment: '会话签名密钥，由安装向导随机生成。修改后所有会话失效。'
    },
    {
      key: INSTALL_ENV_KEYS.CRON_TOKEN,
      value: String(source.cronToken || ''),
      group: 'Cron endpoint auth',
      comment: '定时任务端点鉴权令牌（请求头 X-Cron-Token），由安装向导随机生成。'
    },
    {
      key: INSTALL_ENV_KEYS.DB_HOST,
      value: String(mysql.host || ''),
      group: 'MySQL'
    },
    {
      key: INSTALL_ENV_KEYS.DB_PORT,
      value: String(mysql.port || 3306),
      group: 'MySQL'
    },
    {
      key: INSTALL_ENV_KEYS.DB_USER,
      value: String(mysql.user || ''),
      group: 'MySQL'
    },
    {
      key: INSTALL_ENV_KEYS.DB_PASSWORD,
      value: String(mysql.password || ''),
      group: 'MySQL'
    },
    {
      key: INSTALL_ENV_KEYS.DB_NAME,
      value: String(mysql.database || ''),
      group: 'MySQL'
    }
  ];
}

module.exports = {
  SETUP_ERROR_CODES,
  REQUIRED_TABLES,
  MIN_ADMIN_PASSWORD_LENGTH,
  BCRYPT_MAX_PASSWORD_BYTES,
  CONNECTION_ERROR_CODES,
  AUTH_ERROR_CODES,
  AUTH_ERROR_ERRNOS,
  INSTALL_ENV_KEYS,
  isAdminUsernameValid,
  isAdminPasswordStrong,
  isEmailValid,
  validateDbConfig,
  validateAdminInput,
  evaluateSetupState,
  isMissingTableError,
  isConnectionError,
  isAuthError,
  isDbUnavailableError,
  buildInstallEnvEntries
};
