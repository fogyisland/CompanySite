'use strict';

/**
 * 「数据库配置 → .env」落盘服务。
 *
 * 与相邻模块的分工（别混）：
 *   - lib/env-file.js      .env 怎么序列化、怎么原子写、怎么回滚（文件层）
 *   - lib/setup-policy.js  安装时写哪些键、每条键配什么注释（策略层）
 *   - 本模块              把「用户填的连接参数」变成「.env 内容 + 进程内生效 + 可回滚」
 *
 * 为什么不让 /api/setup/save-db-config 与 /api/db-config 各写一份：
 * 两条路径的失败后果完全一样 —— .env 写坏 + 连接池指到坏库，
 * 而且回滚要同时退文件、退进程 env、退连接池，三件事必须成对出现。
 * 拷贝一份迟早漂移，所以统一走这里。
 *
 * 生效方式是「当场生效 + 末尾提示重启」：
 *   - 连接参数：立刻换连接池，当场可用
 *   - SESSION_SECRET：process.env 立刻换，但 express-session 在启动时就
 *     绑定了签名密钥，换掉之后**已登录会话会陆续失效**，重启才彻底对齐
 *   - sessionPool：模块加载时绑定（server.js 顶层），换库后需要重启才跟上
 * 所以 UI 必须提示重启，不能说「已完全生效」。
 */

const envFile = require('./env-file');
const setupPolicy = require('./setup-policy');

/** .env 顶部的说明文字 */
const ENV_HEADER = [
  '本文件由站点初始化向导 (/setup) 生成 —— 数据库连接参数请在向导或后台「系统设置 → 数据库」里改，不要手工编辑。',
  '向导写入的值都被引号包着：改的时候请保留引号，否则含 # 或空格的密码会被截断。',
  '每次保存都会重写本文件：向导管理的 8 个键按新值写入；值没变的键与其它原有的键整行原样保留（末尾的 Preserved 段）。',
  '改动数据库连接参数后需要重启服务；改错了可以从同目录的 .env.bak 退回去。',
  '注意：.env 含明文密码，权限应为 0600，且绝对不要提交进版本库。'
];

/** 由向导管理的全部键 —— 快照与回滚按这个清单走 */
const MANAGED_ENV_KEYS = Object.freeze([
  'PORT',
  'SESSION_SECRET',
  'CRON_TOKEN',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME'
]);

/**
 * 收集「不属于向导管理范围、但必须原样保留」的键。
 *
 * 为什么必须保留：保存数据库配置时我们只重写 8 个受管键，
 * 但 .env 里还可能有 PAYPAL_WEBHOOK_ID、MCP_TOKEN、DB_COPY_ALLOWED_HOSTS
 * 这些**运维手工配的键**。如果只写受管键，它们会被静默清空 ——
 * 改个数据库端口顺手把 PayPal 回调弄失效，这种事故极难排查。
 *
 * 保留方式是**逐字搬原始行**，不做「解析 → 重新序列化」：
 * 那是一次有损往返（dotenv 只还原双引号里的 \n 与 \r，
 * 同时含单引号和双引号的值会多出一个反斜杠）。
 * 搬运原始行则保证这些键**一个字节都不变**。
 *
 * 被注释掉的键本来就不在原文的赋值行里，也就不会被保留 ——
 * 这正好符合直觉：注释掉的键是「没配」。
 *
 * @param {string} previousContent 旧 .env 原文
 * @param {string[]} managedKeys 受管键清单（这些不保留，按新值写）
 * @returns {Array<{key: string, rawLine: string, group: string, comment: string}>}
 */
function collectPreservedEntries(previousContent, managedKeys) {
  const managed = Array.isArray(managedKeys) ? managedKeys : [];
  if (typeof previousContent !== 'string' || previousContent === '') return [];

  return envFile
    .extractRawAssignments(previousContent, null)
    .filter((item) => managed.indexOf(item.key) === -1)
    .map((item) => ({
      key: item.key,
      rawLine: item.line,
      group: 'Preserved from the previous .env',
      comment: '向导不管理这个键 —— 整行原样保留，未被本次保存修改。'
    }));
}

/**
 * 受管键里「值没变」的那些，改用旧 .env 的**原始行**输出。
 *
 * 场景：SESSION_SECRET / CRON_TOKEN 是从旧文件里沿用来的，
 * DB_PASSWORD 也可能是用户没重填、直接沿用旧值。
 * 这些值**来源就是旧文件**，再「解析 → 重新序列化」写回去就是一次有损往返 ——
 * dotenv v17 在双引号里只还原 \n 与 \r，一个同时含单引号和双引号的密码
 * 往返一次会多出一个反斜杠（等于悄悄改了密码）。
 *
 * 所以：只要新值与旧文件里的值相同，就直接搬那一行，一个字节都不动。
 *
 * @param {Array<object>} entries 受管键条目（会被就地修改）
 * @param {string} previousContent 旧 .env 原文
 * @param {object} previousValues 旧 .env 的解析结果
 * @returns {Array<object>} 同一个 entries 数组
 */
function reuseRawLinesForUnchanged(entries, previousContent, previousValues) {
  if (!Array.isArray(entries)) return entries;
  if (typeof previousContent !== 'string' || previousContent === '') return entries;
  if (!previousValues || typeof previousValues !== 'object') return entries;

  const rawByKey = new Map();
  for (const item of envFile.extractRawAssignments(previousContent, null)) {
    rawByKey.set(item.key, item.line);
  }

  for (const entry of entries) {
    if (!entry || !entry.key || entry.rawLine) continue;
    if (!Object.prototype.hasOwnProperty.call(previousValues, entry.key)) continue;

    const previousValue = previousValues[entry.key];
    const nextValue = entry.value === undefined || entry.value === null
      ? ''
      : String(entry.value);
    if (String(previousValue) !== nextValue) continue;

    const rawLine = rawByKey.get(entry.key);
    if (rawLine) {
      entry.rawLine = rawLine;
      delete entry.value;
    }
  }
  return entries;
}

/** 取第一个非空值 */
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }
  return '';
}

/**
 * 把数据库连接参数写进 .env，并同步到当前进程。
 *
 * @param {object} options
 * @param {object} options.mysql  已通过 validateDbConfig 的连接参数
 * @param {number} [options.port] HTTP 端口；默认沿用当前进程的 PORT
 * @param {string} [options.envPath] .env 路径；默认仓库根目录的 .env。
 *   仅供单元测试指向临时目录 —— 生产永远用默认值。
 * @returns {{ok: boolean, error?: string, values?: object, envPath?: string,
 *            backupPath?: string|null, previousContent?: string|null, envSnapshot?: object}}
 *   失败时 ok=false；成功时带 rollback 所需的信息（previousContent / envSnapshot）
 */
function saveDbConfigToEnv(options) {
  const source = options && typeof options === 'object' ? options : {};
  const mysql = source.mysql && typeof source.mysql === 'object' ? source.mysql : {};
  const envPath = typeof source.envPath === 'string' && source.envPath
    ? source.envPath
    : envFile.ENV_FILE;

  const currentPort = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 15000;
  const port = Number(source.port) > 0 ? Number(source.port) : currentPort;

  const existing = envFile.readEnvFile(envPath);
  if (existing.error) {
    // .env 存在但读不出来 —— 不覆盖它。宁可报错让人先修文件，
    // 也不要用一个新文件把旧配置（含密码）静默冲掉。
    return { ok: false, error: '读取现有 .env 失败: ' + existing.error };
  }

  const previousValues = existing.exists ? existing.values : {};

  // 密钥沿用旧值 —— 修一个「配置坏了」的部署不该顺手作废所有已登录会话。
  // 旧值没有才现生成。
  const sessionSecret = firstNonEmpty(
    previousValues.SESSION_SECRET,
    process.env.SESSION_SECRET
  ) || envFile.generateSecret();
  const cronToken = firstNonEmpty(
    previousValues.CRON_TOKEN,
    process.env.CRON_TOKEN
  ) || envFile.generateHexToken();

  const managedEntries = reuseRawLinesForUnchanged(
    setupPolicy.buildInstallEnvEntries({
      mysql: mysql,
      port: port,
      sessionSecret: sessionSecret,
      cronToken: cronToken
    }),
    existing.content,
    previousValues
  );

  const entries = managedEntries.concat(
    collectPreservedEntries(existing.content, MANAGED_ENV_KEYS)
  );

  const content = envFile.buildEnvContent(entries, { header: ENV_HEADER });
  const written = envFile.writeEnvFile(content, { filePath: envPath });
  if (!written.ok) {
    return { ok: false, error: '写入 .env 失败: ' + written.error };
  }

  const values = {
    PORT: String(port),
    SESSION_SECRET: sessionSecret,
    CRON_TOKEN: cronToken,
    DB_HOST: String(mysql.host || ''),
    DB_PORT: String(mysql.port || 3306),
    DB_USER: String(mysql.user || ''),
    DB_PASSWORD: String(mysql.password || ''),
    DB_NAME: String(mysql.database || '')
  };

  // 快照必须在 apply 之前拍 —— 拍完再改，才谈得上「退回去」
  const envSnapshot = envFile.snapshotProcessEnv(MANAGED_ENV_KEYS);
  envFile.applyEnvToProcess(values);

  return {
    ok: true,
    error: null,
    values: values,
    envPath: written.path,
    backupPath: written.backupPath,
    previousContent: existing.exists ? existing.content : null,
    envSnapshot: envSnapshot
  };
}

/**
 * 回滚一次 saveDbConfigToEnv —— 恢复 .env 原文与进程 env。
 *
 * @param {object} handle saveDbConfigToEnv 成功时的返回值
 * @returns {{ok: boolean, error: string|null}}
 */
function rollbackDbConfigToEnv(handle) {
  if (!handle || typeof handle !== 'object') {
    return { ok: true, error: null };
  }
  envFile.restoreProcessEnv(handle.envSnapshot);
  const restored = envFile.restoreEnvFile(
    Object.prototype.hasOwnProperty.call(handle, 'previousContent')
      ? handle.previousContent
      : null,
    handle.envPath
  );
  return restored;
}

module.exports = {
  ENV_HEADER,
  MANAGED_ENV_KEYS,
  collectPreservedEntries,
  reuseRawLinesForUnchanged,
  saveDbConfigToEnv,
  rollbackDbConfigToEnv
};
