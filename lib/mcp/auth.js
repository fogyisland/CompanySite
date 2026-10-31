'use strict';

/**
 * MCP 鉴权 —— 两类凭据
 *
 * 1. **主令牌**（全权限，运维的「万能钥匙」）
 *    现在由后台「系统设置 → MCP」点击生成/轮换，存在数据库里（settings.mcp_config），
 *    因此是**运行时解析**的 —— 后台轮换后立即生效，不需要重启。
 *    兼容回退：环境变量 MCP_TOKEN 仍然有效（存量部署），且优先级低于数据库里的主令牌 ——
 *    否则后台的「轮换」按钮会看起来没生效。
 *
 * 2. **后台签发的令牌**（mcp_tokens 表）
 *    每个令牌有名字、作用域、有效期，可以单独吊销而不影响其它客户端。
 *    明文只在签发那一刻返回一次，库里只存 sha256。
 *
 * 失败分两类，别混：
 *   - **401** 令牌不对 —— 客户端的问题（没带、带错、被吊销、过期）
 *     前提是端点本身是启用的（有主令牌或已签发过有效令牌）。
 *   - **503** 端点没启用 —— 服务端配置的问题（fail-closed）
 *     端点完全没启用时，**任何**请求都回 503，带不带令牌都一样。
 *
 * 为什么 401 和 503 要分开：
 * AI 客户端拿到 401 会去检查自己的配置；拿到 503 会直接报错停下。
 * 把「端点被关掉」伪装成 401，会让客户端反复重试一个永远不会成功的请求。
 */

const crypto = require('node:crypto');
const { hashMcpToken, parseMcpScopes, MCP_SCOPES } = require('./tokens');

/** 定长安全比较：长度不同时也走一次比较，避免用响应时间推断长度 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 对外可见的失败文案（集中一处，避免各处措辞漂移） */
const AUTH_ERRORS = {
  MISSING_TOKEN: '缺少 Bearer 令牌。MCP 端点需要请求头 Authorization: Bearer <令牌>',
  INVALID_TOKEN: 'Bearer 令牌无效',
  REVOKED_TOKEN: 'Bearer 令牌已被吊销',
  EXPIRED_TOKEN: 'Bearer 令牌已过期',
  NO_CREDENTIAL: 'MCP 端点未启用：尚未生成主令牌，且后台未签发任何令牌',
  AUTH_UNAVAILABLE: 'MCP 鉴权服务暂时不可用，请稍后重试'
};

/**
 * 「端点是否完全没启用」的判定缓存时长（毫秒）。
 *
 * 为什么要有缓存：主令牌缺失时，判定「后台有没有签发过有效令牌」必须查库。
 * 而 /mcp 不在 API 限流中间件之后（它挂在更早的位置），
 * 每个未鉴权请求都查一次库，等于给攻击者一个「用请求放大数据库负载」的入口。
 * 1 秒的缓存把查询频率压到「每秒最多一次」，同时把「刚签发的令牌要用起来」的
 * 延迟窗口限制在 1 秒内 —— 对客户端来说等同于没有延迟。
 */
const NO_CREDENTIAL_CACHE_MS = 1000;

/** 进程内缓存：{ at: 判定时刻, value: 是否没启用 } */
let noCredentialCache = { at: 0, value: false };

/**
 * 取当前生效的主令牌。
 *
 * 优先级：后台生成并存进数据库的 > 环境变量 MCP_TOKEN（存量兼容）。
 * 返回 { token, source }；token 为空串表示没有主令牌。
 */
function resolveMasterToken(deps, req) {
  const fromConfig = req && req.mcpConfig ? req.mcpConfig.masterToken : '';
  if (typeof fromConfig === 'string' && fromConfig) {
    return { token: fromConfig, source: 'master' };
  }
  const fromEnv = deps && typeof deps.mcpToken === 'string' ? deps.mcpToken : '';
  if (fromEnv) {
    return { token: fromEnv, source: 'env' };
  }
  return { token: '', source: '' };
}

/**
 * 判断「端点是不是完全没启用」。
 *
 * 没启用 = 既没有主令牌（后台生成的或环境变量兜底的），后台也没有签发过
 * 任何有效令牌。这种情况下端点根本没有可用的凭据，任何请求都不该被放行 ——
 * 而且应该回 503（服务端配置问题）而不是 401（客户端问题）：
 * 客户端拿到 401 会去检查自己的配置并反复重试，拿到 503 才会停下来。
 *
 * @returns {Promise<true|false|null>} true = 没启用；false = 已启用；
 *   null = 判定不了（查库失败）—— 调用方必须 fail-closed。
 */
async function isEndpointUnconfigured(deps, master) {
  // 主令牌在 → 端点一定是启用的，连库都不用碰
  if (master.token) return false;

  const now = Date.now();
  if (now - noCredentialCache.at < NO_CREDENTIAL_CACHE_MS) {
    return noCredentialCache.value;
  }

  let activeCount = 0;
  try {
    activeCount = await deps.db.countActiveMcpTokens();
  } catch (err) {
    deps.logger.error('[mcp] 统计有效 MCP 令牌失败', err);
    return null;
  }

  const value = activeCount === 0;
  noCredentialCache = { at: now, value };
  return value;
}

/**
 * 校验一次 MCP 请求的 Bearer 令牌。
 *
 * @param {object} deps
 * @param {object} deps.db            db 模块（需要 findMcpTokenByHash / countActiveMcpTokens / touchMcpTokenLastUsed）
 * @param {string} [deps.mcpToken]    环境变量主令牌（后台未生成主令牌时的兼容回退）
 * @param {object} deps.logger        日志器
 * @param {import('express').Request} req
 * @returns {Promise<{ok: boolean, status?: number, error?: string, scopes?: string[], source?: string, tokenId?: number|null}>}
 */
async function authenticateMcpRequest(deps, req) {
  const header = String(req.headers.authorization || '').trim();
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header);

  const master = resolveMasterToken(deps, req);

  // 端点压根没启用 → 一律 503（无论请求带没带令牌）。
  // 这个判定必须在「有没有带令牌」之前：没启用时根本不存在「正确的令牌」，
  // 回 401 会让客户端以为是自己漏带了令牌，然后拿着一个根本不存在的令牌反复重试。
  const unconfigured = await isEndpointUnconfigured(deps, master);
  if (unconfigured === null) {
    return { ok: false, status: 503, error: AUTH_ERRORS.AUTH_UNAVAILABLE };
  }
  if (unconfigured === true) {
    return { ok: false, status: 503, error: AUTH_ERRORS.NO_CREDENTIAL };
  }

  if (!match) {
    return { ok: false, status: 401, error: AUTH_ERRORS.MISSING_TOKEN };
  }
  const presented = match[1];

  // 1) 主令牌：一次定长比较，成本最低
  if (master.token && timingSafeEqual(presented, master.token)) {
    // 主令牌是运维逃生口，持有全部作用域（含动态与产品两族）
    return { ok: true, scopes: MCP_SCOPES.slice(), source: master.source, tokenId: null };
  }

  // 2) 后台签发的令牌：按 sha256 走唯一索引查
  let row = null;
  try {
    row = await deps.db.findMcpTokenByHash(hashMcpToken(presented));
  } catch (err) {
    deps.logger.error('[mcp] 查询 MCP 令牌失败', err);
    return { ok: false, status: 503, error: AUTH_ERRORS.AUTH_UNAVAILABLE };
  }

  if (row) {
    if (row.revoked_at) {
      return { ok: false, status: 401, error: AUTH_ERRORS.REVOKED_TOKEN };
    }
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return { ok: false, status: 401, error: AUTH_ERRORS.EXPIRED_TOKEN };
    }
    try {
      await deps.db.touchMcpTokenLastUsed(row.id);
    } catch (err) {
      // 记录「最后使用时间」失败不影响鉴权结论，但绝不能静默吞掉 —— 留下痕迹
      deps.logger.error(`[mcp] 更新令牌 #${row.id} 的最后使用时间失败`, err);
    }
    return { ok: true, scopes: parseMcpScopes(row.scopes), source: 'db', tokenId: row.id };
  }

  // 3) 令牌对不上 —— 端点是启用的（前面已判定），所以是客户端的令牌不对
  return { ok: false, status: 401, error: AUTH_ERRORS.INVALID_TOKEN };
}

module.exports = {
  authenticateMcpRequest,
  resolveMasterToken,
  isEndpointUnconfigured,
  timingSafeEqual,
  AUTH_ERRORS,
  NO_CREDENTIAL_CACHE_MS
};
