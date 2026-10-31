'use strict';

/**
 * MCP 令牌原语 —— 生成、哈希、作用域
 *
 * 本模块是纯函数集合，不碰数据库、不碰 express，可脱离服务器单测。
 *
 * 核心约定：
 *   1. **明文只出现一次**。签发时生成明文交给调用方展示，库里只存 sha256。
 *      之后任何接口（包括后台列表）都拿不回明文 —— 这是刻意的，
 *      避免「后台页面/日志/数据库备份泄露 = 全量令牌泄露」。
 *   2. **哈希用 sha256 而不是 bcrypt/scrypt**：令牌本身是 32 字节全随机，
 *      没有字典可撞，sha256 的抗暴力强度已经足够；用慢哈希只会拖慢每次
 *      MCP 请求的鉴权（每个 AI 工具调用都要鉴权一次）。
 *   3. **作用域最小化**。一个只用来「列文章」的 AI 工具不需要能删改发布，
 *      所以令牌带作用域；主令牌（环境变量）保留全权限作为运维逃生口。
 */

/** 令牌前缀：让令牌在日志/截图里一眼可辨 */
const crypto = require('node:crypto');

const MCP_TOKEN_PREFIX = 'mcp_';

/** 熵：32 字节 = 256 位 */
const MCP_TOKEN_BYTES = 32;

/** 只读权限：列动态、读详情 */
const SCOPE_READ = 'news:read';

/** 写权限：新建 / 更新 / 发布 / 撤稿 */
const SCOPE_WRITE = 'news:write';

/** 只读权限：列产品、读产品详情、读产品文档 */
const SCOPE_PRODUCT_READ = 'product:read';

/** 写权限：新建 / 更新产品，新建 / 发布 / 撤稿产品文档 */
const SCOPE_PRODUCT_WRITE = 'product:write';

/** 全部合法作用域（白名单，不在表内的作用域一律拒绝） */
const MCP_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_PRODUCT_READ, SCOPE_PRODUCT_WRITE];

/**
 * 作用域隐含关系：key 是「被授予的作用域」，value 是它自动蕴含的作用域。
 *
 * news:write 蕴含 news:read、product:write 蕴含 product:read —— 能写的人自然能读
 * 自己刚写的东西，否则 AI 写完却读不回来，客户端会拿到莫名其妙的错误。
 *
 * 注意：两族作用域之间**不互相蕴含**。news:write 不含 product:read ——
 * 「能改文章」不等于「能看产品目录」。
 */
const IMPLIED_SCOPES = {
  [SCOPE_WRITE]: [SCOPE_READ],
  [SCOPE_PRODUCT_WRITE]: [SCOPE_PRODUCT_READ]
};

/**
 * 生成一枚新令牌（明文）。
 * 只在「签发」这一刻调用一次，返回值直接交给用户复制。
 */
function generateMcpToken() {
  return MCP_TOKEN_PREFIX + crypto.randomBytes(MCP_TOKEN_BYTES).toString('hex');
}

/**
 * 计算令牌的 sha256 十六进制摘要 —— 这是库里真正存的东西。
 */
function hashMcpToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * 用于界面展示的短前缀（只暴露前 12 位，够区分令牌，不足以还原）。
 */
function getMcpTokenPreview(token) {
  const text = String(token || '');
  if (text.length <= 12) return text;
  return text.slice(0, 12);
}

/**
 * 把数据库里逗号分隔的作用域字符串解析成数组。
 * 同时兼容直接传数组（单测 / 内部调用）。
 */
function parseMcpScopes(raw) {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value).trim()).filter(Boolean);
  }
  return String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * 校验并归一化调用方提交的作用域列表。
 * 返回 { ok, scopes, error } —— 由调用方决定怎么呈现错误。
 */
function normalizeMcpScopes(input) {
  const list = Array.isArray(input) ? input : parseMcpScopes(input);
  const scopes = [];
  for (const raw of list) {
    const scope = String(raw || '').trim();
    if (!scope) continue;
    if (!MCP_SCOPES.includes(scope)) {
      return {
        ok: false,
        scopes: [],
        error: `未知的权限范围「${scope}」，可用值：${MCP_SCOPES.join(' / ')}`
      };
    }
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  if (scopes.length === 0) {
    return { ok: false, scopes: [], error: '至少需要选择一项权限范围' };
  }
  return { ok: true, scopes, error: null };
}

/**
 * 判断「已授予的作用域集合」是否覆盖「目标作用域」。
 *
 * 判定顺序：先看是否直接命中，再看「被授予作用域」是否蕴含目标作用域
 * （见 IMPLIED_SCOPES）。
 */
function mcpScopeAllows(grantedScopes, requiredScope) {
  const granted = parseMcpScopes(grantedScopes);
  if (granted.includes(requiredScope)) return true;
  for (const scope of granted) {
    const implied = IMPLIED_SCOPES[scope];
    if (implied && implied.includes(requiredScope)) return true;
  }
  return false;
}

/**
 * 序列化回数据库存储格式（逗号分隔）。
 */
function formatMcpScopes(scopes) {
  return parseMcpScopes(scopes).join(',');
}

module.exports = {
  MCP_TOKEN_PREFIX,
  MCP_TOKEN_BYTES,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_PRODUCT_READ,
  SCOPE_PRODUCT_WRITE,
  MCP_SCOPES,
  IMPLIED_SCOPES,
  generateMcpToken,
  hashMcpToken,
  getMcpTokenPreview,
  parseMcpScopes,
  normalizeMcpScopes,
  mcpScopeAllows,
  formatMcpScopes
};
