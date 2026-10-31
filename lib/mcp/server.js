'use strict';

/**
 * MCP（Model Context Protocol）服务端 —— Streamable HTTP 传输
 *
 * 挂在现有 Express 4 应用上（server.js），路径 /mcp，复用同一条 nginx 反代。
 *
 * 关键设计（都是实测确认过的，不是照抄文档）：
 *
 * 1. **无状态模式必须每请求新建 transport**
 *    SDK 的 WebStandardStreamableHTTPServerTransport 在 sessionIdGenerator 为
 *    undefined（无状态）时，第二个请求会直接抛：
 *      "Stateless transport cannot be reused across requests.
 *       Create a new transport per request."
 *    所以这里每个请求都新建一套 McpServer + Transport，请求结束即销毁。
 *    好处：不需要会话亲和性（nginx 后可随便负载）、重启即忘、没有会话泄漏。
 *
 * 2. **enableJsonResponse: true**
 *    POST 直接返回 application/json，而不是 SSE。规范允许两种，但 JSON 模式
 *    让 nginx 不需要为 /mcp 单独开 proxy_buffering off，部署面小很多。
 *    GET 仍是 SSE（服务端主动推送通道），但本服务不产生主动通知。
 *
 * 3. **parsedBody 复用 express.json() 的解析结果**
 *    SDK 的 handleRequest(req, res, parsedBody) 第三参数存在时直接用它，
 *    不再读 req 流。express.json() 已经把 body 消费掉了，不传第三个参数会
 *    拿到空 body。
 *
 * 4. **鉴权用 Bearer Token**
 *    MCP 客户端是机器对机器，没有浏览器会话，用 Authorization: Bearer <令牌>。
 *    两类凭据（见 lib/mcp/auth.js）：
 *      - 环境变量主令牌 MCP_TOKEN：运维逃生口，全权限
 *      - 后台签发的令牌（mcp_tokens 表）：可吊销、带作用域
 *    比较走 crypto.timingSafeEqual，避免逐字节短路的时序侧信道。
 *
 * 5. **配置在运行时可改**
 *    启用开关与 Host 白名单存在数据库里（后台「系统设置 → MCP」可改），
 *    因此每次请求都重新解析一次配置，而不是在进程启动时固化。
 *    没有这一步，后台改了设置还得重启才生效。
 */

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { hostHeaderValidation } = require('@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js');
const { registerNewsTools } = require('./tools');
const { registerProductTools } = require('./product-tools');
const { authenticateMcpRequest } = require('./auth');

const MCP_BODY_LIMIT = '2mb';
const MCP_SERVER_NAME = 'booming-www-news';

/**
 * 解析当前生效的 MCP 配置。
 *
 * 优先级：后台保存的配置 > 环境变量默认值。
 * 后台从未保存过时（configured 为 false），用 .env 的 MCP_ALLOWED_HOSTS 兜底，
 * 这样升级到新版本后行为与升级前完全一致。
 *
 * 主令牌（masterToken）也在这一步解析 —— 后台生成/轮换后立即生效，
 * 不需要重启进程。数据库里没有主令牌时回退到环境变量 MCP_TOKEN（存量兼容）。
 */
async function resolveMcpConfig(deps) {
  const envMasterToken = typeof deps.mcpToken === 'string' ? deps.mcpToken : '';
  const fallback = {
    enabled: true,
    allowedHosts: Array.isArray(deps.allowedHosts) ? deps.allowedHosts : [],
    masterToken: envMasterToken
  };
  if (typeof deps.getMcpConfig !== 'function') return fallback;

  const config = await deps.getMcpConfig();
  if (!config || typeof config !== 'object') return fallback;

  const storedMaster = typeof config.masterToken === 'string' ? config.masterToken : '';
  return {
    enabled: config.enabled !== false,
    allowedHosts: Array.isArray(config.allowedHosts) ? config.allowedHosts : [],
    masterToken: storedMaster || envMasterToken
  };
}

/**
 * 新建一套「服务端 + 传输」。无状态模式下每个请求一套，用完即弃。
 * 注意：connect() 是异步的，必须 await 完成后才能 handleRequest，
 * 否则 transport 还没接上 onmessage，请求会被静默丢弃。
 *
 * scopes 决定这个令牌能看到哪些工具 —— 作用域受限的令牌不会拿到
 * 自己无权调用的工具定义（而不是调用后才报错）。
 */
async function createScopedServer(deps, serverVersion, scopes) {
  const mcpServer = new McpServer({ name: MCP_SERVER_NAME, version: serverVersion });
  registerNewsTools(mcpServer, Object.assign({}, deps, { scopes }));
  // 产品族工具：作用域 product:read / product:write，与动态族互不蕴含。
  // 产品没有「上架」工具 —— 上架只能人工在后台点。
  registerProductTools(mcpServer, Object.assign({}, deps, { scopes }));

  const transport = new StreamableHTTPServerTransport({
    // undefined = 无状态：服务器不分配 Mcp-Session-Id，也不校验会话
    sessionIdGenerator: undefined,
    // POST 直接回 application/json，不走 SSE
    enableJsonResponse: true
  });

  await mcpServer.connect(transport);
  return { mcpServer, transport };
}

/** 请求结束（或连接断开）后释放服务端与传输；重复调用安全 */
function createCleanup(scoped, logger) {
  let isCleaned = false;
  return async function cleanup() {
    if (isCleaned) return;
    isCleaned = true;
    try {
      await scoped.transport.close();
    } catch (err) {
      logger.error('[mcp] 关闭 transport 失败', err);
    }
    try {
      await scoped.mcpServer.close();
    } catch (err) {
      logger.error('[mcp] 关闭 MCP server 失败', err);
    }
  };
}

/**
 * 处理一次 Streamable HTTP 请求（POST / GET / DELETE 共用一套生命周期）。
 */
async function handleStreamableRequest(req, res, deps, serverVersion) {
  let scoped;
  try {
    const scopes = req.mcpAuth ? req.mcpAuth.scopes : [];
    scoped = await createScopedServer(deps, serverVersion, scopes);
  } catch (err) {
    deps.logger.error('[mcp] 创建 MCP 会话失败', err);
    return res.status(500).json({ error: 'MCP 会话创建失败' });
  }

  const cleanup = createCleanup(scoped, deps.logger);
  // 连接断开时也要释放；正常完成时 close 事件同样会触发，双重调用由 isCleaned 兜住
  res.on('close', cleanup);

  try {
    // 第三参数传 express.json() 已解析好的 body：SDK 在 parsedBody 存在时不会再读 req 流
    await scoped.transport.handleRequest(req, res, req.body);
  } catch (err) {
    deps.logger.error('[mcp] 处理 MCP 请求失败', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP 请求处理失败' });
    }
    await cleanup();
  }
}

/**
 * 创建挂载到 Express 的路由。
 *
 * @param {object} deps
 * @param {object} deps.db                  db 模块（注入，便于测试）
 * @param {Function} deps.writeOperationLog 操作日志写入函数（注入，与后台同一份审计流）
 * @param {object} deps.logger              日志器（默认 console）
 * @param {string} [deps.mcpToken]          环境变量主令牌（兼容回退；后台生成的主令牌优先）
 * @param {string[]} [deps.allowedHosts]    Host 白名单默认值（不含端口）；后台未配置时生效
 * @param {Function} [deps.getMcpConfig]    读取当前生效配置的异步函数（需返回 enabled / allowedHosts / masterToken）
 * @param {string} [deps.serverVersion]     服务端版本号
 */
function createMcpRouter(deps) {
  const logger = deps.logger || console;
  const router = express.Router();
  const serverVersion = deps.serverVersion || '1.0.0';

  // 独立 body parser：全局 express.json() 上限 100kb，装不下一篇完整文章。
  // body-parser 会给已解析的请求打 req._body 标记，后续的全局解析器会自动跳过，
  // 因此两者不会互相打架。
  router.use(express.json({ limit: MCP_BODY_LIMIT }));

  // MCP 响应不应被缓存
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ---- 配置解析 + DNS 重绑定防护 ----
  // 每次请求都重新读一次配置：后台改了启用开关/白名单，不用重启就生效。
  router.use(async (req, res, next) => {
    let config;
    try {
      config = await resolveMcpConfig(deps);
    } catch (err) {
      logger.error('[mcp] 读取 MCP 配置失败', err);
      return res.status(503).json({ error: 'MCP 配置读取失败，端点暂时不可用' });
    }

    // 端点被后台关掉 = fail-closed，所有请求一律 503
    if (config.enabled === false) {
      return res.status(503).json({ error: 'MCP 端点已在后台关闭' });
    }

    // Host 白名单仅在显式配置时才启用。
    // 默认不启用 —— nginx 转发时 Host 头的具体形态取决于服务器配置，
    // 猜错白名单会把正常客户端全部挡在门外。
    const allowedHosts = Array.isArray(config.allowedHosts) ? config.allowedHosts : [];
    // 把解析好的配置挂到 req 上：鉴权中间件据此读主令牌，
    // 避免为了拿主令牌再查一次库。
    req.mcpConfig = config;
    if (allowedHosts.length > 0) {
      return hostHeaderValidation(allowedHosts)(req, res, next);
    }
    return next();
  });

  // ---- 鉴权（主令牌 + 后台签发的令牌） ----
  router.use(async (req, res, next) => {
    let result;
    try {
      result = await authenticateMcpRequest(deps, req);
    } catch (err) {
      logger.error('[mcp] 鉴权过程异常', err);
      return res.status(503).json({ error: 'MCP 鉴权服务暂时不可用，请稍后重试' });
    }

    if (!result.ok) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
      return res.status(result.status).json({ error: result.error });
    }

    req.mcpAuth = {
      scopes: result.scopes,
      source: result.source,
      tokenId: result.tokenId
    };
    return next();
  });

  router.post('/', (req, res) => handleStreamableRequest(req, res, deps, serverVersion));
  router.get('/', (req, res) => handleStreamableRequest(req, res, deps, serverVersion));
  router.delete('/', (req, res) => handleStreamableRequest(req, res, deps, serverVersion));

  return router;
}

module.exports = {
  createMcpRouter,
  MCP_BODY_LIMIT,
  MCP_SERVER_NAME
};
