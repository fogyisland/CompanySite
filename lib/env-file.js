'use strict';

/**
 * .env 文件的读写 —— 唯一事实来源（single source of truth）。
 *
 * 与 lib/content-policy.js / lib/init-policy.js 同构：
 * 「.env 长什么样、怎么安全地写」写在这里，
 * server.js 与 Init 向导只负责调用，不各自实现一份序列化逻辑。
 *
 * 设计要点：
 *   1. **.env 是 Init 向导的产物**，不是部署前要手工准备的文件。
 *      仓库里只留 .env.example（占位模板），.env 由 /init 生成。
 *   2. 所有值一律用双引号包裹并转义 —— 密码里出现 `#`、`=`、空格、
 *      引号、换行都不会破坏文件结构。
 *   3. 原子写：先写同目录临时文件，再 rename 覆盖。
 *      中途崩溃不会留下半截 .env（半截文件 = 站点启动即挂）。
 *   4. 写之前先把旧文件备份成 .env.bak —— 装错了能退回去。
 *   5. 文件权限 0600（同 init 令牌文件）。
 *
 * 所有函数都接受可选的 filePath —— 默认是仓库根目录的 .env。
 * 这个参数不是给生产用的：它是让单元测试能在临时目录里验证
 * 「写入 → 读回 → 回滚」这条链路，而不必碰真实的 .env
 * （真实的 .env 里躺着生产数据库密码，测试碰它就是事故）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const ROOT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const BACKUP_FILE = ENV_FILE + '.bak';
const TEMP_PREFIX = '.env.tmp-';

/** 生成 SESSION_SECRET 用的字节数（base64 后约 64 字符） */
const SESSION_SECRET_BYTES = 48;
/** 生成 CRON_TOKEN 用的字节数（hex 后 64 字符） */
const CRON_TOKEN_BYTES = 32;

/**
 * 把一个值序列化成 .env 里的字面量形式。
 *
 * 必须严格按 **dotenv v17 的解析规则**来写，否则读回来的值会变样：
 *   - 单引号值：dotenv 原样保留，**不做任何转义处理**。
 *     里面的 `#`、`=`、空格、反斜杠、双引号全都安全。
 *     唯一的限制：值里不能有单引号本身。
 *   - 双引号值：dotenv 只还原 `\n` 与 `\r` 两个转义序列，
 *     其余一律原样保留。所以**不能**把反斜杠转义成 `\\` ——
 *     dotenv 不会还原，多写一个反斜杠就是密码里多一个字符。
 *
 * 因此默认走单引号分支（对绝大多数密码是无损的）；
 * 只有值里含单引号、或含真实的换行/回车时才退到双引号分支。
 *
 * 已知限制（dotenv 的表达能力）：值里**同时**有单引号和双引号时，
 * 双引号分支会把双引号写成 `\"`，而 dotenv 不会去掉那个反斜杠 ——
 * 读回来会多一个反斜号。两种引号同时出现的密码极其罕见，
 * 但这一点必须写进注释里，别让人以为是「加密」。
 */
function quoteValue(value) {
  const text = value === undefined || value === null ? '' : String(value);
  const hasLineBreak = /[\r\n]/.test(text);
  const hasSingleQuote = text.indexOf("'") !== -1;

  if (!hasLineBreak && !hasSingleQuote) {
    return "'" + text + "'";
  }

  const escaped = text
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
  return '"' + escaped + '"';
}

/**
 * 把一组键值序列化成 .env 文本。
 *
 * 每个条目有两种形态：
 *   - `{key, value}`      —— 由本模块序列化（引号 + 转义）；
 *   - `{key, rawLine}`    —— 原样写入该行，不做任何转义。
 *     用于「保留运维手工配的键」：那些行必须一个字节都不变。
 *
 * @param {Array<{key: string, value?: string, rawLine?: string, group?: string, comment?: string}>} entries
 * @param {object} [options]
 * @param {string|string[]} [options.header] 文件顶部的说明文字（数组每项一行）
 * @returns {string}
 */
function buildEnvContent(entries, options) {
  const lines = [];
  const rawHeader = options && options.header ? options.header : [];
  // header 既可以是字符串（按换行切），也可以是字符串数组（每项一行）。
  // 必须是数组也支持 —— 传数组时被 String() 处理会变成「用逗号连起来的一行」，
  // 说明文字全糊成一行，完全没法读。
  const header = Array.isArray(rawHeader)
    ? rawHeader.map((line) => String(line).trim()).filter((line) => line !== '')
    : String(rawHeader).trim().split(/\r?\n/);

  for (const line of header) {
    lines.push('# ' + line);
  }
  if (header.length) {
    lines.push('');
  }

  let lastGroup = null;
  for (const entry of entries) {
    if (!entry || !entry.key) continue;
    const group = entry.group || '';
    if (group && group !== lastGroup) {
      // 上一行已经是空行就别再插一个（避免出现连续两个空行）
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push('# ===== ' + group + ' =====');
      lastGroup = group;
    }
    if (entry.comment) {
      const comments = String(entry.comment).trim().split(/\r?\n/);
      for (const comment of comments) {
        lines.push('# ' + comment);
      }
    }
    if (typeof entry.rawLine === 'string' && entry.rawLine !== '') {
      lines.push(entry.rawLine);
      continue;
    }
    lines.push(entry.key + '=' + quoteValue(entry.value));
  }

  return lines.join('\n') + '\n';
}

/**
 * 读取 .env。
 *
 * @param {string} [filePath] 默认为仓库根目录的 .env
 * @returns {{ exists: boolean, values: object, content: string, error: string|null }}
 *   content 是原文 —— 回滚时要按原文写回，不能拿解析后的值重新序列化
 *   （重新序列化会丢掉注释和原有排版）。
 */
function readEnvFile(filePath) {
  const target = filePath || ENV_FILE;
  if (!fs.existsSync(target)) {
    return { exists: false, values: {}, content: '', error: null };
  }
  try {
    const content = fs.readFileSync(target, 'utf8');
    const values = dotenv.parse(content);
    return { exists: true, values, content, error: null };
  } catch (error) {
    return { exists: true, values: {}, content: '', error: error.message };
  }
}

/**
 * 从 .env 原文里挑出若干键的**原始行**。
 *
 * 为什么要「原始行」而不是「解析后的值」：解析 → 重新序列化是一次有损往返。
 * dotenv v17 只还原双引号里的 \n 与 \r，一个同时含单引号和双引号的密码
 * 经过序列化再读回来会多出一个反斜杠 —— 也就是「保存一次数据库配置，
 * 顺手把 PayPal webhook id 改坏了」。所以非受管键必须逐字搬过去。
 *
 * 注释掉的键不会出现在结果里 —— 注释即「没配」，保留它反而是「复活」。
 *
 * @param {string} content .env 原文
 * @param {string[]|null} [keys] 要挑出来的键名；传 null / 省略表示「全部」
 * @returns {Array<{key: string, line: string}>}
 */
function extractRawAssignments(content, keys) {
  const all = !Array.isArray(keys);
  const wanted = all ? [] : keys;
  const found = [];
  if (typeof content !== 'string' || content === '') return found;

  const seen = new Set();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // 与 dotenv 的键名规则保持一致：export 前缀、允许 . 与 -
    const match = /^(?:export\s+)?([\w.-]+)\s*=/.exec(trimmed);
    if (!match) continue;

    const key = match[1];
    if (!all && wanted.indexOf(key) === -1) continue;
    if (seen.has(key)) continue; // 同名键取第一行（与 dotenv 的行为一致）

    seen.add(key);
    found.push({ key: key, line: trimmed });
  }
  return found;
}

/**
 * .env 是否存在 —— 启动期据此区分「未初始化」与「已部署但配置坏了」。
 * @param {string} [filePath]
 */
function envFileExists(filePath) {
  const target = filePath || ENV_FILE;
  try {
    return fs.existsSync(target);
  } catch (error) {
    return false;
  }
}

/**
 * 原子写入 .env。
 *
 * @param {string} content 完整的文件内容
 * @param {object} [options]
 * @param {boolean} [options.backup=true] 覆盖前是否备份旧文件
 * @param {string} [options.filePath] 目标文件（默认仓库根目录的 .env）
 * @returns {{ ok: boolean, path: string, backupPath: string|null, error: string|null }}
 */
function writeEnvFile(content, options) {
  const settings = options && typeof options === 'object' ? options : {};
  const target = settings.filePath || ENV_FILE;
  const backup = settings.backup !== false;
  const backupPath = target + '.bak';
  const tempFile = path.join(
    path.dirname(target),
    TEMP_PREFIX + process.pid + '-' + Date.now()
  );

  try {
    // 备份旧文件 —— 装错了要能退回去
    let writtenBackup = null;
    if (backup && fs.existsSync(target)) {
      fs.copyFileSync(target, backupPath);
      writtenBackup = backupPath;
    }

    fs.writeFileSync(tempFile, content, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(tempFile, 0o600);
    } catch (chmodError) {
      // Windows 上 chmod 语义有限，失败不影响功能
    }
    fs.renameSync(tempFile, target);
    return { ok: true, path: target, backupPath: writtenBackup, error: null };
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (cleanupError) {
      console.error('[env-file] 临时文件清理失败:', cleanupError.message);
    }
    return { ok: false, path: target, backupPath: null, error: error.message };
  }
}

/**
 * 把一组键值写进当前进程的 process.env —— 让新配置**当场生效**，
 * 不必等重启。
 *
 * 注意：这里是有意覆盖。dotenv 启动时不覆盖已存在的 process.env，
 * 那是「外部环境优先」的语义；这里是「向导刚写完的值必须立刻生效」。
 *
 * @param {object} values
 */
function applyEnvToProcess(values) {
  if (!values || typeof values !== 'object') return;
  for (const key of Object.keys(values)) {
    process.env[key] = String(values[key]);
  }
}

/**
 * 拍一份进程 env 的快照，用于回滚。
 *
 * 区分「键不存在」和「键存在但值为空」—— 前者回滚时要删键，
 * 后者要写回空串。用 Object.prototype.hasOwnProperty 判断，
 * 因为直接 `snapshot[key] || ''` 会把「不存在」和「空串」混为一谈。
 *
 * @param {string[]} keys
 * @returns {object} 键 → 字符串 | undefined
 */
function snapshotProcessEnv(keys) {
  const snapshot = {};
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    snapshot[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
  }
  return snapshot;
}

/**
 * 把进程 env 恢复到快照状态。
 * @param {object} snapshot snapshotProcessEnv 的返回值
 */
function restoreProcessEnv(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  for (const key of Object.keys(snapshot)) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

/**
 * 回滚 .env —— 把文件恢复成原样。
 *
 * @param {string|null} previousContent 原文件内容；null 表示「之前没有 .env」
 * @param {string} [filePath] 目标文件（默认仓库根目录的 .env）
 * @returns {{ ok: boolean, error: string|null }}
 */
function restoreEnvFile(previousContent, filePath) {
  const target = filePath || ENV_FILE;
  if (previousContent === null || previousContent === undefined) {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  // 回滚不再备份：此刻 .env 里装的是「坏配置」，备份它会把好配置覆盖掉
  return writeEnvFile(previousContent, { backup: false, filePath: target });
}

/** 生成 base64 密钥（用于 SESSION_SECRET） */
function generateSecret(byteLength) {
  const bytes = Number(byteLength) || SESSION_SECRET_BYTES;
  return crypto.randomBytes(bytes).toString('base64');
}

/** 生成 hex 令牌（用于 CRON_TOKEN） */
function generateHexToken(byteLength) {
  const bytes = Number(byteLength) || CRON_TOKEN_BYTES;
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = {
  ROOT_DIR,
  ENV_FILE,
  BACKUP_FILE,
  SESSION_SECRET_BYTES,
  CRON_TOKEN_BYTES,
  quoteValue,
  buildEnvContent,
  readEnvFile,
  extractRawAssignments,
  envFileExists,
  writeEnvFile,
  restoreEnvFile,
  applyEnvToProcess,
  snapshotProcessEnv,
  restoreProcessEnv,
  generateSecret,
  generateHexToken
};
