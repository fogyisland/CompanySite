'use strict';

/**
 * MCP 工具集 —— 让 AI 工具直接管理「动态」（news 表）
 *
 * 设计约束：
 *   1. 依赖注入：本模块不 require db / server.js，db、writeOperationLog、logger
 *      全部由调用方传入 —— 既方便单测（注入 mock DB），也避免循环依赖。
 *   2. 工具只暴露「读 + 建 + 改 + 发布 + 撤稿」。
 *      **不暴露删除** —— 删除不可逆，且不在「发布文章」的诉求范围内；
 *      需要删除请走后台 /api/admin/news/:id。
 *   3. 所有写操作都写操作日志（writeOperationLog），与 REST 后台同一份审计流。
 *   4. 校验一律走 lib/content-policy.js，工具层不重复实现规则。
 *   5. 失败返回 { isError: true, content: [...] }，让 AI 能读到可执行的中文提示并自行修正，
 *      而不是抛 JSON-RPC 异常把整轮对话打断。
 *
 * zod schema 与校验策略的分工（重要，改动前请先读）：
 *   - **写路径的内容字段**（title / slug / content_html / excerpt / cover_image / category）：
 *     zod 只管**结构**（字段在不在、类型对不对），一切**取值约束**
 *     （长度上下限、空值、字符集、协议、安全构造）由 content-policy 裁决。
 *     两者若都写同一条规则，就会出现「zod 先命中 → AI 拿到 SDK 的英文报错
 *     "String must contain at least 1 character(s)"，而不是带错误码的中文提示」，
 *     且同一上限写两遍必然漂移。
 *     长度上限仍然写进 .describe()，让 AI 从工具定义里就能看到约束并主动规避
 *     （代价：JSON Schema 里不再有 maxLength 约束，客户端若做本地预校验需读描述文本）。
 *   - **只读工具的过滤/分页参数**（list_news 的 category/page/pageSize、
 *     get_news 的 slug、定位用的 id/current_slug）：不写入内容，不存在双份规则，
 *     保留在 zod 里就近约束。
 */

const { z } = require('zod');
const { ContentPolicyError, validateNewsPayload, validateNewsPatch } = require('../content-policy');
const { SCOPE_READ, SCOPE_WRITE, parseMcpScopes, mcpScopeAllows } = require('./tokens');

/** 动态摘要（列表用）—— 不含正文，避免把整篇文章塞进上下文 */
const newsSummaryShape = {
  id: z.number(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string(),
  category: z.string(),
  cover_image: z.string(),
  is_pinned: z.boolean(),
  status: z.string(),
  sort_order: z.number(),
  view_count: z.number(),
  published_at: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable()
};

/** 动态详情 —— 含正文 */
const newsDetailShape = Object.assign({}, newsSummaryShape, {
  content_html: z.string()
});

function toIsoOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return String(value);
}

/** DB 行 → 摘要对象（字段类型全部由本函数掌控，保证 structuredContent 稳定） */
function toSummary(row) {
  return {
    id: Number(row.id),
    title: String(row.title || ''),
    slug: String(row.slug || ''),
    excerpt: String(row.excerpt || ''),
    category: String(row.category || ''),
    cover_image: String(row.cover_image || ''),
    is_pinned: Number(row.is_pinned) === 1,
    status: String(row.status || 'draft'),
    sort_order: Number(row.sort_order) || 0,
    view_count: Number(row.view_count) || 0,
    published_at: toIsoOrNull(row.published_at),
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at)
  };
}

/** DB 行 → 详情对象 */
function toDetail(row) {
  return Object.assign(toSummary(row), { content_html: String(row.content_html || '') });
}

/** DB 错误 → 人话提示；返回 null 表示没有可识别的友好文案 */
function friendlyDbError(err) {
  if (!err) return null;
  if (err.code === 'ER_DUP_ENTRY') return 'slug 已存在，请换一个 slug';
  if (err.code === 'ER_DATA_TOO_LONG') return '字段长度超出数据库列限制';
  if (err.code === 'ER_NO_REFERENCED_ROW_2') return '关联的记录不存在';
  if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST') return '数据库连接失败，请稍后重试';
  return null;
}

/** 统一的工具错误出口 */
function toolError(toolName, err, logger) {
  if (err instanceof ContentPolicyError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `参数校验未通过（${err.code}）：${err.message}` }]
    };
  }
  logger.error(`[mcp] 工具 ${toolName} 执行失败`, err);
  const friendly = friendlyDbError(err);
  if (friendly) {
    return { isError: true, content: [{ type: 'text', text: `执行失败：${friendly}` }] };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: '执行失败：内部错误，详情见服务端日志（logs/operation-*.log 与控制台）。' }]
  };
}

/**
 * 定位目标动态：id 与 current_slug 二选一。
 * 返回 { row } 或 { error } —— 调用方据此走正常分支或错误分支。
 */
async function resolveTargetRow(db, args) {
  const hasId = args.id !== undefined && args.id !== null;
  const hasSlug = typeof args.current_slug === 'string' && args.current_slug.trim() !== '';
  if (!hasId && !hasSlug) {
    return { error: '必须提供 id 或 current_slug 其中之一来定位要操作的动态' };
  }
  if (hasId) {
    const row = await db.getNews(Number(args.id));
    if (!row) return { error: `未找到 id=${args.id} 的动态` };
    return { row };
  }
  const row = await db.getNewsBySlug(args.current_slug.trim());
  if (!row) return { error: `未找到 slug=${args.current_slug} 的动态` };
  return { row };
}

/**
 * 注册全部动态相关工具。
 *
 * 作用域（deps.scopes）：
 *   - news:read  → list_news / get_news
 *   - news:write → create_news / update_news / publish_news / unpublish_news
 *   - news:write 隐含 news:read
 *
 * 作用域受限的令牌**看不到**无权调用的工具（tools/list 里就不出现），
 * 而不是调用后才报错 —— 前者让 AI 不会去尝试越权操作。
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} mcpServer
 * @param {{ db: object, writeOperationLog: Function, logger: object, scopes?: string[] }} deps
 */
function registerNewsTools(mcpServer, deps) {
  const { db, writeOperationLog, logger } = deps;

  const grantedScopes = parseMcpScopes(deps.scopes);

  /**
   * 按作用域注册工具：没有该作用域就直接不注册。
   * 这样 tools/list 的返回内容天然反映了调用方的权限边界。
   */
  const register = (scope, name, config, handler) => {
    if (!mcpScopeAllows(grantedScopes, scope)) return;
    mcpServer.registerTool(name, config, handler);
  };

  // -------------------------------------------------------------------------
  // list_news —— 列出动态
  // -------------------------------------------------------------------------
  register(
    SCOPE_READ,
    'list_news',
    {
      title: '列出动态',
      description:
        '列出站点「动态」栏目的全部文章，含草稿与已发布。可按分类、状态筛选，按页分页。返回摘要列表，不含正文 HTML。',
      inputSchema: {
        category: z
          .string()
          .max(50)
          .optional()
          .describe('按分类筛选，留空表示全部。常见值：产品更新、公司新闻、安全公告'),
        status: z
          .enum(['all', 'draft', 'published'])
          .optional()
          .describe('按状态筛选，默认 all（草稿+已发布）'),
        page: z.number().int().min(1).optional().describe('页码，从 1 开始，默认 1'),
        pageSize: z.number().int().min(1).max(100).optional().describe('每页条数，默认 20，最大 100')
      },
      outputSchema: {
        items: z.array(z.object(newsSummaryShape)),
        total: z.number(),
        page: z.number(),
        pageSize: z.number()
      }
    },
    async (args) => {
      try {
        const category = args.category ? String(args.category).trim() : '';
        const status = args.status || 'all';
        const page = Number.isInteger(args.page) && args.page > 0 ? args.page : 1;
        const pageSize =
          Number.isInteger(args.pageSize) && args.pageSize > 0 ? Math.min(args.pageSize, 100) : 20;

        const rows = await db.getAllNews();
        const filtered = rows.filter((row) => {
          if (category && String(row.category || '') !== category) return false;
          if (status !== 'all' && String(row.status || '') !== status) return false;
          return true;
        });

        const offset = (page - 1) * pageSize;
        const items = filtered.slice(offset, offset + pageSize).map(toSummary);
        const payload = { items, total: filtered.length, page, pageSize };
        const text =
          `共 ${payload.total} 条动态，本页返回 ${items.length} 条（第 ${page} 页，每页 ${pageSize} 条）。` +
          `id / slug / status 用于后续工具的定位参数。`;
        return { content: [{ type: 'text', text }], structuredContent: payload };
      } catch (err) {
        return toolError('list_news', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // get_news —— 读单条动态详情
  // -------------------------------------------------------------------------
  register(
    SCOPE_READ,
    'get_news',
    {
      title: '读取动态详情',
      description: '按 id 或 slug 读取一条动态的完整内容，含正文 HTML。',
      inputSchema: {
        id: z.number().int().positive().optional().describe('动态 id，与 slug 二选一'),
        slug: z.string().max(255).optional().describe('动态 slug，与 id 二选一')
      },
      outputSchema: z.object(newsDetailShape)
    },
    async (args) => {
      try {
        const hasId = args.id !== undefined && args.id !== null;
        const hasSlug = typeof args.slug === 'string' && args.slug.trim() !== '';
        if (!hasId && !hasSlug) {
          return { isError: true, content: [{ type: 'text', text: '必须提供 id 或 slug 其中之一' }] };
        }
        const row = hasId ? await db.getNews(Number(args.id)) : await db.getNewsBySlug(args.slug.trim());
        if (!row) {
          const what = hasId ? `id=${args.id}` : `slug=${args.slug}`;
          return { isError: true, content: [{ type: 'text', text: `未找到 ${what} 对应的动态` }] };
        }
        const detail = toDetail(row);
        const text = `动态 #${detail.id}「${detail.title}」\nslug: ${detail.slug}\n状态: ${detail.status}\n分类: ${detail.category || '（无）'}`;
        return { content: [{ type: 'text', text }], structuredContent: detail };
      } catch (err) {
        return toolError('get_news', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // create_news —— 新建（草稿）
  // -------------------------------------------------------------------------
  register(
    SCOPE_WRITE,
    'create_news',
    {
      title: '新建动态（草稿）',
      description:
        '在「动态」栏目新建一篇文章。新建后状态为草稿（draft），前台不可见；确认无误后再调用 publish_news 发布。',
      inputSchema: {
        title: z
          .string({ required_error: '文章标题必填', invalid_type_error: '文章标题必须是字符串' })
          .describe('文章标题，必填，最长 255 个字符'),
        slug: z
          .string({
            required_error: 'slug 必填',
            invalid_type_error: 'slug 必须是字符串'
          })
          .describe(
            'URL 别名，必填，最长 255 个字符。只能用小写字母、数字和连字符，例如 product-update-2026-01'
          ),
        content_html: z
          .string({
            required_error: '正文 content_html 必填',
            invalid_type_error: '正文 content_html 必须是字符串'
          })
          .describe(
            '正文 HTML，必填，最长 100000 个字符。只放正文结构，不要带 script/style/iframe/事件属性'
          ),
        excerpt: z
          .string({ invalid_type_error: '摘要必须是字符串' })
          .optional()
          .describe('摘要，选填，最长 2000 个字符，列表页展示'),
        cover_image: z
          .string({ invalid_type_error: '封面图地址必须是字符串' })
          .optional()
          .describe(
            '封面图地址，选填，最长 500 个字符。必须是站内相对路径（以 / 开头，例如 /uploads/doc-images/cover.png）或 https:// 绝对地址'
          ),
        category: z
          .string({ invalid_type_error: '分类必须是字符串' })
          .optional()
          .describe('分类，选填，最长 50 个字符。常见值：产品更新、公司新闻、安全公告'),
        is_pinned: z.boolean().optional().describe('是否置顶，默认 false'),
        sort_order: z.number().int().optional().describe('排序权重，默认 0')
      },
      outputSchema: {
        id: z.number(),
        news: z.object(newsSummaryShape)
      }
    },
    async (args) => {
      try {
        const payload = validateNewsPayload(
          {
            title: args.title,
            slug: args.slug,
            content_html: args.content_html,
            excerpt: args.excerpt,
            cover_image: args.cover_image,
            category: args.category,
            is_pinned: args.is_pinned,
            sort_order: args.sort_order
          },
          { strict: true }
        );

        const created = await db.createNews({
          title: payload.title,
          slug: payload.slug,
          excerpt: payload.excerpt,
          contentHtml: payload.contentHtml,
          coverImage: payload.coverImage,
          category: payload.category,
          isPinned: payload.isPinned,
          sortOrder: payload.sortOrder
        });

        const row = await db.getNews(created.id);
        if (!row) {
          // 写入成功但回读失败：不静默吞掉，明确告诉调用方去核对
          logger.error('[mcp] create_news 写入成功但回读失败, id=', created.id);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `已创建动态（id=${created.id}），但回读校验失败，请用 get_news 核对后再决定是否发布。`
              }
            ]
          };
        }

        writeOperationLog('NEWS_CREATE', 'mcp', `[MCP] News #${created.id} (${payload.slug})`);
        const news = toSummary(row);
        const text =
          `已创建动态 #${news.id}「${news.title}」（slug: ${news.slug}）。` +
          `当前状态：${news.status} —— 前台还看不到，确认内容无误后调用 publish_news 发布。`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { id: Number(created.id), news }
        };
      } catch (err) {
        return toolError('create_news', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // update_news —— 更新
  // -------------------------------------------------------------------------
  register(
    SCOPE_WRITE,
    'update_news',
    {
      title: '更新动态',
      description:
        '更新一条已存在的动态。只传需要改的字段，没传的字段保持原样。定位用 id 或 current_slug（当前 slug）；要改成新 slug，请传 slug 字段。',
      inputSchema: {
        id: z.number().int().positive().optional().describe('动态 id，与 current_slug 二选一'),
        current_slug: z.string().max(255).optional().describe('动态当前的 slug，与 id 二选一'),
        title: z.string().optional().describe('新标题，最长 255 个字符，不能为空字符串'),
        slug: z.string().optional().describe('新 slug，最长 255 个字符，只能用小写字母、数字和连字符'),
        content_html: z.string().optional().describe('新正文 HTML，最长 100000 个字符，不能为空字符串'),
        excerpt: z.string().optional().describe('新摘要，最长 2000 个字符，传空字符串表示清空'),
        cover_image: z
          .string()
          .optional()
          .describe(
            '新封面图地址，最长 500 个字符，传空字符串表示清除封面。必须是站内相对路径或 https:// 绝对地址'
          ),
        category: z.string().optional().describe('新分类，最长 50 个字符，传空字符串表示清空分类'),
        is_pinned: z.boolean().optional().describe('是否置顶'),
        sort_order: z.number().int().optional().describe('排序权重')
      },
      outputSchema: {
        id: z.number(),
        news: z.object(newsSummaryShape)
      }
    },
    async (args) => {
      try {
        const located = await resolveTargetRow(db, args);
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const target = located.row;

        // 只校验显式传入的字段；历史遗留值原样保留
        const patch = validateNewsPatch(
          {
            title: args.title,
            slug: args.slug,
            content_html: args.content_html,
            excerpt: args.excerpt,
            cover_image: args.cover_image,
            category: args.category,
            is_pinned: args.is_pinned,
            sort_order: args.sort_order
          },
          { strict: true }
        );

        const merged = {
          title: patch.title !== undefined ? patch.title : target.title,
          slug: patch.slug !== undefined ? patch.slug : target.slug,
          excerpt: patch.excerpt !== undefined ? patch.excerpt : target.excerpt || '',
          contentHtml: patch.contentHtml !== undefined ? patch.contentHtml : target.content_html || '',
          coverImage: patch.coverImage !== undefined ? patch.coverImage : target.cover_image || '',
          category: patch.category !== undefined ? patch.category : target.category || '',
          isPinned: patch.isPinned !== undefined ? patch.isPinned : Number(target.is_pinned) === 1,
          sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : Number(target.sort_order) || 0
        };

        await db.updateNews(Number(target.id), merged);

        const row = await db.getNews(Number(target.id));
        if (!row) {
          logger.error('[mcp] update_news 更新成功但回读失败, id=', target.id);
          return {
            isError: true,
            content: [{ type: 'text', text: `已更新动态（id=${target.id}），但回读校验失败，请用 get_news 核对。` }]
          };
        }

        writeOperationLog('NEWS_UPDATE', 'mcp', `[MCP] News #${target.id} (${merged.slug})`);
        const news = toSummary(row);
        const text = `已更新动态 #${news.id}「${news.title}」（slug: ${news.slug}，状态：${news.status}）。`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { id: Number(target.id), news }
        };
      } catch (err) {
        return toolError('update_news', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // publish_news —— 发布
  // -------------------------------------------------------------------------
  register(
    SCOPE_WRITE,
    'publish_news',
    {
      title: '发布动态',
      description: '把一条动态从草稿发布为已发布状态。首次发布时会记录发布时间。定位用 id 或 current_slug。',
      inputSchema: {
        id: z.number().int().positive().optional().describe('动态 id，与 current_slug 二选一'),
        current_slug: z.string().max(255).optional().describe('动态当前的 slug，与 id 二选一')
      },
      outputSchema: {
        id: z.number(),
        news: z.object(newsSummaryShape)
      }
    },
    async (args) => {
      try {
        const located = await resolveTargetRow(db, args);
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const target = located.row;

        await db.publishNews(Number(target.id));
        const row = await db.getNews(Number(target.id));
        if (!row) {
          logger.error('[mcp] publish_news 发布成功但回读失败, id=', target.id);
          return {
            isError: true,
            content: [{ type: 'text', text: `已发布动态（id=${target.id}），但回读校验失败，请用 get_news 核对。` }]
          };
        }

        writeOperationLog('NEWS_PUBLISH', 'mcp', `[MCP] News #${target.id} (${target.slug})`);
        const news = toSummary(row);
        const text = `已发布动态 #${news.id}「${news.title}」，前台现在可见。发布时间：${news.published_at || '未记录'}。`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { id: Number(target.id), news }
        };
      } catch (err) {
        return toolError('publish_news', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // unpublish_news —— 撤稿
  // -------------------------------------------------------------------------
  register(
    SCOPE_WRITE,
    'unpublish_news',
    {
      title: '撤稿（转回草稿）',
      description: '把一条已发布的动态撤回到草稿状态，前台立即不再显示。定位用 id 或 current_slug。',
      inputSchema: {
        id: z.number().int().positive().optional().describe('动态 id，与 current_slug 二选一'),
        current_slug: z.string().max(255).optional().describe('动态当前的 slug，与 id 二选一')
      },
      outputSchema: {
        id: z.number(),
        news: z.object(newsSummaryShape)
      }
    },
    async (args) => {
      try {
        const located = await resolveTargetRow(db, args);
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const target = located.row;

        await db.unpublishNews(Number(target.id));
        const row = await db.getNews(Number(target.id));
        if (!row) {
          logger.error('[mcp] unpublish_news 撤稿成功但回读失败, id=', target.id);
          return {
            isError: true,
            content: [{ type: 'text', text: `已撤稿动态（id=${target.id}），但回读校验失败，请用 get_news 核对。` }]
          };
        }

        writeOperationLog('NEWS_UNPUBLISH', 'mcp', `[MCP] News #${target.id} (${target.slug})`);
        const news = toSummary(row);
        const text = `已撤稿动态 #${news.id}「${news.title}」，当前状态：${news.status}，前台不再显示。`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { id: Number(target.id), news }
        };
      } catch (err) {
        return toolError('unpublish_news', err, logger);
      }
    }
  );
}

module.exports = {
  registerNewsTools,
  newsSummaryShape,
  newsDetailShape,
  // 导出给测试 / 复用
  toSummary,
  toDetail,
  friendlyDbError
};
