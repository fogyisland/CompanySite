'use strict';

/**
 * MCP 工具集 —— 让 AI 工具管理「产品」与「产品文档」
 *
 * 与 lib/mcp/tools.js（动态 news）同构，但独立成文件：
 * tools.js 已经 560+ 行，两族工具混在一起会突破单文件 500 行的规范。
 *
 * ===== 最重要的一条规则：产品不能由 AI 上架 =====
 *
 * AI 建出来的产品一律是**草稿**（products.status = 0），前台看不到。
 * 上架（status = 1）只能由人在后台点「上架」按钮完成，MCP **不提供**任何
 * 产品上架 / 下架的工具 —— 不提供比提供了再拒绝更安全：
 *   - 工具列表里不存在 → AI 不会尝试
 *   - 也不存在「调用后被拒绝」的半吊子状态
 *
 * 注意区分：
 *   - **产品**的上架 = 人工（无 MCP 工具）
 *   - **产品文档**的发布 = AI 可以做（publish_product_doc）
 *     文档发布后仍要等产品本身被人工上架，前台才看得到 —— 这条约束在
 *     db.getPublishedProductDoc 里由 `AND p.status = 1` 保证。
 *
 * 校验一律走 lib/product-policy.js，工具层不重复实现规则；
 * 类型矩阵（课程型 / 共享代码 / 开源 → 免费、仓库校验、两者互斥）走
 * lib/product-policy.js 的 resolveProductType，与 REST 的 POST /api/products
 * 是**同一份实现**，规则不会漂移。
 *
 * 失败返回 { isError: true, content: [...] }，让 AI 读到可执行的中文提示后自行修正，
 * 而不是抛 JSON-RPC 异常把整轮对话打断（与 tools.js 一致）。
 */

const { z } = require('zod');
const { ContentPolicyError } = require('../content-policy');
const {
  validateProductPayload,
  validateProductPatch,
  validateProductDocPayload,
  resolveProductType
} = require('../product-policy');
const {
  SCOPE_PRODUCT_READ,
  SCOPE_PRODUCT_WRITE,
  parseMcpScopes,
  mcpScopeAllows
} = require('./tokens');

// ============================================================================
// 输出结构（structuredContent 的 zod schema）
// ============================================================================

/** 价格方案：[{ label, duration, price }]，duration 单位是月 */
const pricingTierShape = z.object({
  label: z.string(),
  duration: z.number(),
  price: z.number()
});

/** 产品摘要（列表用）—— 不含富文本详情 */
const productSummaryShape = {
  id: z.number(),
  name: z.string(),
  short_name: z.string(),
  category: z.string(),
  price: z.number(),
  pricing_tiers: z.array(pricingTierShape).nullable(),
  description: z.string(),
  version: z.string(),
  platform: z.string(),
  features: z.array(z.string()),
  icon: z.string(),
  featured: z.boolean(),
  download_url: z.string(),
  external_link: z.boolean(),
  detail_page: z.string(),
  image: z.string(),
  image_dark_bg: z.boolean(),
  is_course: z.boolean(),
  is_shared_code: z.boolean(),
  repo_urls: z.array(z.string()),
  status: z.string(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable()
};

/** 产品文档摘要 */
const productDocSummaryShape = {
  id: z.number(),
  product_id: z.number(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  sort_order: z.number(),
  status: z.string(),
  author_username: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  published_at: z.string().nullable()
};

/** 产品文档详情（额外含正文 HTML） */
const productDocDetailShape = Object.assign({}, productDocSummaryShape, {
  content_html: z.string()
});

// ============================================================================
// 行 → 结构化对象（字段类型全部由本层掌控，保证 structuredContent 稳定）
// ============================================================================

function toIsoOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return String(value);
}

/**
 * 价格方案归一。
 *
 * 库里存的是 JSON 文本，形状理论上是 [{label, duration, price}]，
 * 但历史数据可能不规整。这里逐项归一而不是直接透传 ——
 * 输出结构要过 zod 校验，脏数据会让整个工具调用报错。
 */
function normalizePricingTiers(value) {
  if (!Array.isArray(value)) return null;
  const tiers = [];
  for (const tier of value) {
    if (!tier || typeof tier !== 'object') continue;
    tiers.push({
      label: String(tier.label || ''),
      duration: Number(tier.duration) || 0,
      price: Number(tier.price) || 0
    });
  }
  return tiers;
}

/**
 * DB 行（db.js 的 camelCase 映射结果）→ 产品摘要。
 * 入参是 db.getProduct / getProductsPaginated / getProductByShortName 的返回。
 */
function toProductSummary(row) {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    short_name: String(row.shortName || ''),
    category: String(row.category || ''),
    price: Number(row.price) || 0,
    pricing_tiers: normalizePricingTiers(row.pricingTiers),
    description: String(row.description || ''),
    version: String(row.version || ''),
    platform: String(row.platform || ''),
    features: Array.isArray(row.features) ? row.features.map((item) => String(item)) : [],
    icon: String(row.icon || ''),
    featured: Boolean(row.featured),
    download_url: String(row.downloadUrl || ''),
    external_link: Boolean(row.externalLink),
    detail_page: String(row.detailPage || ''),
    image: String(row.image || ''),
    image_dark_bg: Boolean(row.imageDarkBg),
    is_course: Boolean(row.isCourse),
    is_shared_code: Boolean(row.isSharedCode),
    repo_urls: Array.isArray(row.repoUrls) ? row.repoUrls.map((url) => String(url)) : [],
    status: String(row.status || 'draft'),
    created_at: toIsoOrNull(row.createdAt),
    updated_at: toIsoOrNull(row.updatedAt)
  };
}

/** DB 行（product_docs 的 snake_case 原始行）→ 文档摘要 */
function toDocSummary(row) {
  return {
    id: Number(row.id),
    product_id: Number(row.product_id),
    title: String(row.title || ''),
    slug: String(row.slug || ''),
    excerpt: row.excerpt === null || row.excerpt === undefined ? null : String(row.excerpt),
    sort_order: Number(row.sort_order) || 0,
    status: String(row.status || 'draft'),
    author_username:
      row.author_username === null || row.author_username === undefined
        ? null
        : String(row.author_username),
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at),
    published_at: toIsoOrNull(row.published_at)
  };
}

/** DB 行 → 文档详情（摘要 + 正文） */
function toDocDetail(row) {
  return Object.assign(toDocSummary(row), { content_html: String(row.content_html || '') });
}

// ============================================================================
// 错误出口
// ============================================================================

/** DB 错误 → 人话提示；返回 null 表示没有可识别的友好文案 */
function friendlyProductDbError(err) {
  if (!err) return null;
  if (err.code === 'ER_DUP_ENTRY') return '短名（short_name）或 slug 已存在，请换一个';
  if (err.code === 'ER_DATA_TOO_LONG') return '字段长度超出数据库列限制';
  if (err.code === 'ER_NO_REFERENCED_ROW_2') return '关联的产品不存在';
  if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST') {
    return '数据库连接失败，请稍后重试';
  }
  return null;
}

/** 统一的工具错误出口（与 tools.js 的 toolError 同构） */
function productToolError(toolName, err, logger) {
  if (err instanceof ContentPolicyError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `参数校验未通过（${err.code}）：${err.message}` }]
    };
  }
  logger.error(`[mcp] 工具 ${toolName} 执行失败`, err);
  const friendly = friendlyProductDbError(err);
  if (friendly) {
    return { isError: true, content: [{ type: 'text', text: `执行失败：${friendly}` }] };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: '执行失败：内部错误，详情见服务端日志（logs/operation-*.log 与控制台）。' }]
  };
}

// ============================================================================
// 定位辅助
// ============================================================================

/**
 * 定位产品：id 与 short_name 二选一。
 * 返回 { product } 或 { error }。
 */
async function resolveTargetProduct(db, args) {
  const hasId = args.id !== undefined && args.id !== null;
  const hasShortName = typeof args.short_name === 'string' && args.short_name.trim() !== '';
  if (!hasId && !hasShortName) {
    return { error: '必须提供 id 或 short_name 其中之一来定位产品' };
  }
  if (hasId) {
    const product = await db.getProduct(Number(args.id));
    if (!product) return { error: `未找到 id=${args.id} 的产品` };
    return { product };
  }
  const product = await db.getProductByShortName(args.short_name.trim());
  if (!product) return { error: `未找到 short_name=${args.short_name} 的产品` };
  return { product };
}

/**
 * 定位产品文档：doc_id，或 (product_short_name + doc_slug) 二选一。
 * 返回 { doc } 或 { error }。
 */
async function resolveTargetDoc(db, args) {
  const hasDocId = args.doc_id !== undefined && args.doc_id !== null;
  const hasSlugPair =
    typeof args.product_short_name === 'string' &&
    args.product_short_name.trim() !== '' &&
    typeof args.doc_slug === 'string' &&
    args.doc_slug.trim() !== '';
  if (hasDocId) {
    const doc = await db.getProductDocById(Number(args.doc_id));
    if (!doc) return { error: `未找到 doc_id=${args.doc_id} 的产品文档` };
    return { doc };
  }
  if (hasSlugPair) {
    const product = await db.getProductByShortName(args.product_short_name.trim());
    if (!product) return { error: `未找到 short_name=${args.product_short_name} 的产品` };
    const docs = await db.listProductDocsByProduct(product.id);
    const doc = docs.find((row) => String(row.slug) === args.doc_slug.trim());
    if (!doc) return { error: `未找到 slug=${args.doc_slug} 的产品文档` };
    return { doc };
  }
  return { error: '必须提供 doc_id，或同时提供 product_short_name 与 doc_slug' };
}

// ============================================================================
// 工具注册
// ============================================================================

/**
 * 注册全部产品相关工具。
 *
 * 作用域（deps.scopes）：
 *   - product:read  → list_products / get_product / list_product_docs / get_product_doc
 *   - product:write → create_product / update_product / create_product_doc /
 *                    publish_product_doc / unpublish_product_doc
 *   - product:write 隐含 product:read
 *
 * **没有**产品上架 / 下架的工具 —— 上架必须人工在后台点。
 *
 * 作用域受限的令牌看不到无权调用的工具（tools/list 里就不出现）。
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} mcpServer
 * @param {{ db: object, writeOperationLog: Function, logger: object, scopes?: string[] }} deps
 */
function registerProductTools(mcpServer, deps) {
  const { db, writeOperationLog, logger } = deps;
  const grantedScopes = parseMcpScopes(deps.scopes);

  /** 按作用域注册工具：没有该作用域就直接不注册 */
  const register = (scope, name, config, handler) => {
    if (!mcpScopeAllows(grantedScopes, scope)) return;
    mcpServer.registerTool(name, config, handler);
  };

  // -------------------------------------------------------------------------
  // list_products —— 列出产品
  // -------------------------------------------------------------------------
  register(
    SCOPE_PRODUCT_READ,
    'list_products',
    {
      title: '列出产品',
      description:
        '列出产品目录，含草稿与已上架。可按名称/短名搜索、按分类与上架状态筛选，按页分页。返回摘要列表。',
      inputSchema: {
        search: z.string().max(255).optional().describe('按产品名或短名模糊搜索'),
        category: z.string().max(255).optional().describe('按分类精确筛选，留空表示全部'),
        status: z
          .enum(['all', 'published', 'draft'])
          .optional()
          .describe("按上架状态筛选，默认 all（草稿 + 已上架）。'draft' 即尚未上架的产品"),
        page: z.number().int().min(1).optional().describe('页码，从 1 开始，默认 1'),
        pageSize: z.number().int().min(1).max(100).optional().describe('每页条数，默认 20，最大 100')
      },
      outputSchema: {
        items: z.array(z.object(productSummaryShape)),
        total: z.number(),
        page: z.number(),
        pageSize: z.number()
      }
    },
    async (args) => {
      try {
        const status = args.status || 'all';
        const page = Number.isInteger(args.page) && args.page > 0 ? args.page : 1;
        const pageSize =
          Number.isInteger(args.pageSize) && args.pageSize > 0 ? Math.min(args.pageSize, 100) : 20;

        // status：'published' → 1，'draft' → 0，'all' → 不传（不过滤）
        let statusFilter;
        if (status === 'published') statusFilter = 1;
        else if (status === 'draft') statusFilter = 0;

        const result = await db.getProductsPaginated({
          search: typeof args.search === 'string' ? args.search : '',
          category: typeof args.category === 'string' ? args.category : '',
          page,
          pageSize,
          status: statusFilter
        });

        const items = result.products.map(toProductSummary);
        const payload = { items, total: Number(result.total) || 0, page, pageSize };
        const text =
          `共 ${payload.total} 个产品，本页返回 ${items.length} 个（第 ${page} 页，每页 ${pageSize} 个）。` +
          `status 为 draft 的产品前台不可见，需要人工在后台点「上架」才会对外展示。`;
        return { content: [{ type: 'text', text }], structuredContent: payload };
      } catch (err) {
        return productToolError('list_products', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // get_product —— 读单个产品
  // -------------------------------------------------------------------------
  register(
    SCOPE_PRODUCT_READ,
    'get_product',
    {
      title: '读取产品详情',
      description: '按 id 或 short_name（短名）读取一个产品的完整信息。short_name 是产品的 URL 标识。',
      inputSchema: {
        id: z.number().int().positive().optional().describe('产品 id，与 short_name 二选一'),
        short_name: z.string().max(100).optional().describe('产品短名，与 id 二选一')
      },
      outputSchema: z.object(productSummaryShape)
    },
    async (args) => {
      try {
        const located = await resolveTargetProduct(db, args);
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const product = toProductSummary(located.product);
        const text =
          `产品 #${product.id}「${product.name}」\n` +
          `短名: ${product.short_name}\n` +
          `状态: ${product.status}（draft = 未上架，前台不可见）\n` +
          `分类: ${product.category || '（无）'}｜价格: ${product.price}`;
        return { content: [{ type: 'text', text }], structuredContent: product };
      } catch (err) {
        return productToolError('get_product', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // list_product_docs —— 列某个产品的文档
  // -------------------------------------------------------------------------
  register(
    SCOPE_PRODUCT_READ,
    'list_product_docs',
    {
      title: '列出产品文档',
      description:
        '列出某个产品下的全部文档，含草稿与已发布。定位用 product_id 或 product_short_name。',
      inputSchema: {
        product_id: z.number().int().positive().optional().describe('产品 id，与 product_short_name 二选一'),
        product_short_name: z
          .string()
          .max(100)
          .optional()
          .describe('产品短名，与 product_id 二选一')
      },
      outputSchema: {
        items: z.array(z.object(productDocSummaryShape)),
        total: z.number()
      }
    },
    async (args) => {
      try {
        const located = await resolveTargetProduct(db, {
          id: args.product_id,
          short_name: args.product_short_name
        });
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const product = located.product;
        const rows = await db.listProductDocsByProduct(product.id);
        const items = rows.map(toDocSummary);
        const payload = { items, total: items.length };
        const text =
          `产品「${product.name}」（id=${product.id}）下共 ${items.length} 篇文档。` +
          `status 为 draft 的文档前台不可见。`;
        return { content: [{ type: 'text', text }], structuredContent: payload };
      } catch (err) {
        return productToolError('list_product_docs', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // get_product_doc —— 读单个产品文档正文
  // -------------------------------------------------------------------------
  register(
    SCOPE_PRODUCT_READ,
    'get_product_doc',
    {
      title: '读取产品文档',
      description:
        '读取一篇产品文档的完整内容（含正文 HTML）。定位用 doc_id，或同时提供 product_short_name 与 doc_slug。',
      inputSchema: {
        doc_id: z.number().int().positive().optional().describe('文档 id，与短名组合二选一'),
        product_short_name: z
          .string()
          .max(100)
          .optional()
          .describe('产品短名，与 doc_slug 一起使用'),
        doc_slug: z.string().max(255).optional().describe('文档 slug，与 product_short_name 一起使用')
      },
      outputSchema: z.object(productDocDetailShape)
    },
    async (args) => {
      try {
        const located = await resolveTargetDoc(db, args);
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const doc = toDocDetail(located.doc);
        const text = `文档 #${doc.id}「${doc.title}」\nslug: ${doc.slug}\n状态: ${doc.status}`;
        return { content: [{ type: 'text', text }], structuredContent: doc };
      } catch (err) {
        return productToolError('get_product_doc', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // create_product —— 新建产品（草稿）
  // -------------------------------------------------------------------------
  register(
    SCOPE_PRODUCT_WRITE,
    'create_product',
    {
      title: '新建产品（草稿）',
      description:
        '新建一个产品。新建后状态为草稿（draft），前台不可见 —— 产品上架必须由人工在后台完成，' +
        '本工具无法上架。价格填 0 表示免费。课程型与共享代码不能同时启用；' +
        '分类为「开源产品」或勾选共享代码时，至少要有一个仓库地址。',
      inputSchema: {
        name: z
          .string({ required_error: '产品名称必填', invalid_type_error: '产品名称必须是字符串' })
          .describe('产品名称，必填，最长 255 个字符'),
        short_name: z
          .string({
            required_error: '产品短名必填',
            invalid_type_error: '产品短名必须是字符串'
          })
          .describe(
            '产品短名，必填，最长 100 个字符。只能是字母、数字、点、下划线和连字符（保留大小写），例如 MingMailProfessionalToolkit。它是产品的 URL 标识与唯一键'
          ),
        category: z
          .string({ invalid_type_error: '分类必须是字符串' })
          .optional()
          .describe('分类，选填，最长 255 个字符。常用值：General、开源产品'),
        price: z.number().optional().describe('价格，选填。0 表示免费；免费类型产品价格会被强制为 0'),
        pricing_tiers: z
          .array(
            z.object({
              label: z.string().describe('方案名称，例如「月付」「年付」'),
              duration: z.number().int().min(1).max(120).describe('周期（月），月付填 1、年付填 12'),
              price: z.number().min(0).describe('该方案价格')
            })
          )
          .optional()
          .describe('价格方案，选填，最多 12 档。免费类型会被清空'),
        description: z.string().optional().describe('产品描述，选填，纯文本'),
        version: z.string().optional().describe('版本号，选填，最长 100 个字符'),
        platform: z.string().optional().describe('适用平台，选填，最长 100 个字符'),
        features: z.array(z.string()).optional().describe('功能特点，选填，最多 50 条，每条最长 200 字符'),
        icon: z.string().optional().describe('图标标识，选填，最长 500 个字符'),
        featured: z.boolean().optional().describe('是否首页推荐，默认 false'),
        download_url: z.string().optional().describe('下载地址，选填，最长 500 个字符。免费类型会被清空'),
        external_link: z.boolean().optional().describe('是否外链下载，默认 false。免费类型会被强制为 false'),
        is_course: z.boolean().optional().describe('是否课程型，默认 false（与 is_shared_code 互斥）'),
        is_shared_code: z.boolean().optional().describe('是否共享代码，默认 false（与 is_course 互斥）'),
        repo_urls: z
          .array(z.string())
          .optional()
          .describe('仓库地址，选填，最多 10 个，只接受 http(s) 地址。开源产品 / 共享代码必填')
      },
      outputSchema: {
        id: z.number(),
        product: z.object(productSummaryShape)
      }
    },
    async (args) => {
      try {
        const payload = validateProductPayload(
          {
            name: args.name,
            short_name: args.short_name,
            category: args.category,
            price: args.price,
            pricing_tiers: args.pricing_tiers,
            description: args.description,
            version: args.version,
            platform: args.platform,
            features: args.features,
            icon: args.icon,
            featured: args.featured,
            download_url: args.download_url,
            external_link: args.external_link,
            is_course: args.is_course,
            is_shared_code: args.is_shared_code,
            repo_urls: args.repo_urls
          },
          { strict: true }
        );

        // status: 'draft' → products.status = 0（草稿，前台不可见）
        const created = await db.createProduct({
          name: payload.name,
          shortName: payload.shortName,
          category: payload.category,
          price: payload.price,
          pricingTiers: payload.pricingTiers,
          description: payload.description,
          version: payload.version,
          platform: payload.platform,
          features: payload.features,
          icon: payload.icon,
          featured: payload.featured,
          downloadUrl: payload.downloadUrl,
          externalLink: payload.externalLink,
          detailPage: '',
          image: '',
          imageDarkBg: false,
          isCourse: payload.isCourse,
          isSharedCode: payload.isSharedCode,
          repoUrls: payload.repoUrls,
          status: 'draft'
        });

        const row = await db.getProduct(created.id);
        if (!row) {
          logger.error('[mcp] create_product 写入成功但回读失败, id=', created.id);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `已创建产品（id=${created.id}），但回读校验失败，请用 get_product 核对后再决定是否提交人工上架。`
              }
            ]
          };
        }

        writeOperationLog('PRODUCT_CREATE', 'mcp', `[MCP] Product #${created.id} (${payload.shortName})`);
        const product = toProductSummary(row);
        const text =
          `已创建产品 #${product.id}「${product.name}」（短名: ${product.short_name}）。` +
          `当前状态：${product.status} —— 前台还看不到，请通知人工在后台确认价格后点「上架」。`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { id: Number(created.id), product }
        };
      } catch (err) {
        return productToolError('create_product', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // update_product —— 更新产品（局部更新）
  // -------------------------------------------------------------------------
  register(
    SCOPE_PRODUCT_WRITE,
    'update_product',
    {
      title: '更新产品',
      description:
        '更新一个已存在的产品。只传需要改的字段，没传的字段保持原样。定位用 id 或 short_name。' +
        '本工具**不能上架产品** —— 上架状态由人工在后台控制，改了也不会生效。',
      inputSchema: {
        id: z.number().int().positive().optional().describe('产品 id，与 short_name 二选一'),
        short_name: z.string().max(100).optional().describe('产品当前短名，与 id 二选一'),
        name: z.string().optional().describe('新名称，最长 255 个字符'),
        category: z.string().optional().describe('新分类，最长 255 个字符'),
        description: z.string().optional().describe('新描述'),
        version: z.string().optional().describe('新版本号，最长 100 个字符'),
        platform: z.string().optional().describe('新适用平台，最长 100 个字符'),
        icon: z.string().optional().describe('新图标标识，最长 500 个字符'),
        features: z.array(z.string()).optional().describe('新的功能特点列表（整体替换），最多 50 条'),
        featured: z.boolean().optional().describe('是否首页推荐'),
        price: z.number().min(0).optional().describe('新价格。0 表示免费；免费类型产品价格会被强制为 0'),
        pricing_tiers: z
          .array(
            z.object({
              label: z.string(),
              duration: z.number().int().min(1).max(120),
              price: z.number().min(0)
            })
          )
          .optional()
          .describe('新的价格方案列表（整体替换），最多 12 档。传空数组表示清空'),
        download_url: z.string().optional().describe('新下载地址，最长 500 个字符'),
        external_link: z.boolean().optional().describe('是否外链下载'),
        is_course: z.boolean().optional().describe('是否课程型（与 is_shared_code 互斥）'),
        is_shared_code: z.boolean().optional().describe('是否共享代码（与 is_course 互斥）'),
        repo_urls: z.array(z.string()).optional().describe('新的仓库地址列表（整体替换），最多 10 个')
      },
      outputSchema: {
        id: z.number(),
        product: z.object(productSummaryShape)
      }
    },
    async (args) => {
      try {
        const located = await resolveTargetProduct(db, args);
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const target = located.product;

        // 只校验显式传入的字段；历史遗留值原样保留
        const patch = validateProductPatch(
          {
            name: args.name,
            category: args.category,
            description: args.description,
            version: args.version,
            platform: args.platform,
            icon: args.icon,
            features: args.features,
            featured: args.featured,
            price: args.price,
            pricing_tiers: args.pricing_tiers,
            download_url: args.download_url,
            external_link: args.external_link,
            is_course: args.is_course,
            is_shared_code: args.is_shared_code,
            repo_urls: args.repo_urls
          },
          { strict: true }
        );

        // 合并成完整对象：db.updateProduct 是全列覆盖写法，缺列会被写成 NULL
        const merged = {
          name: patch.name !== undefined ? patch.name : target.name,
          shortName: target.shortName,
          category: patch.category !== undefined ? patch.category : target.category,
          description: patch.description !== undefined ? patch.description : target.description || '',
          version: patch.version !== undefined ? patch.version : target.version,
          platform: patch.platform !== undefined ? patch.platform : target.platform,
          features: patch.features !== undefined ? patch.features : target.features || [],
          icon: patch.icon !== undefined ? patch.icon : target.icon,
          featured: patch.featured !== undefined ? patch.featured : Boolean(target.featured),
          price: patch.price !== undefined ? patch.price : Number(target.price) || 0,
          pricingTiers:
            patch.pricingTiers !== undefined
              ? patch.pricingTiers
              : target.pricingTiers || null,
          downloadUrl:
            patch.downloadUrl !== undefined ? patch.downloadUrl : target.downloadUrl || '',
          externalLink:
            patch.externalLink !== undefined ? patch.externalLink : Boolean(target.externalLink),
          isCourse: patch.isCourse !== undefined ? patch.isCourse : Boolean(target.isCourse),
          isSharedCode:
            patch.isSharedCode !== undefined ? patch.isSharedCode : Boolean(target.isSharedCode),
          repoUrls: patch.repoUrls !== undefined ? patch.repoUrls : target.repoUrls || [],
          detailPage: target.detailPage || '',
          image: target.image || '',
          imageDarkBg: Boolean(target.imageDarkBg)
        };

        // 类型矩阵复算：合并后的最终形态必须满足
        // 「课程型/共享代码/开源 → 免费」与「仓库地址必填」两条不变量，
        // 与 REST 的 POST /api/products 用的是同一份实现。
        const type = resolveProductType(
          {
            category: merged.category,
            isCourse: merged.isCourse,
            isSharedCode: merged.isSharedCode,
            repoUrls: merged.repoUrls,
            price: merged.price,
            pricingTiers: merged.pricingTiers,
            downloadUrl: merged.downloadUrl,
            externalLink: merged.externalLink
          },
          { strict: true }
        );

        await db.updateProduct(Number(target.id), {
          name: merged.name,
          shortName: merged.shortName,
          category: type.category,
          price: type.price,
          pricingTiers: type.pricingTiers,
          description: merged.description,
          version: merged.version,
          platform: merged.platform,
          features: merged.features,
          icon: merged.icon,
          featured: merged.featured,
          downloadUrl: type.downloadUrl,
          externalLink: type.externalLink,
          detailPage: merged.detailPage,
          image: merged.image,
          imageDarkBg: merged.imageDarkBg,
          isCourse: type.isCourse,
          isSharedCode: type.isSharedCode,
          repoUrls: type.repoUrls
        });

        const row = await db.getProduct(Number(target.id));
        if (!row) {
          logger.error('[mcp] update_product 更新成功但回读失败, id=', target.id);
          return {
            isError: true,
            content: [{ type: 'text', text: `已更新产品（id=${target.id}），但回读校验失败，请用 get_product 核对。` }]
          };
        }

        writeOperationLog('PRODUCT_UPDATE', 'mcp', `[MCP] Product #${target.id} (${merged.shortName})`);
        const product = toProductSummary(row);
        const text =
          `已更新产品 #${product.id}「${product.name}」（短名: ${product.short_name}，状态: ${product.status}）。` +
          `上架状态未被改动 —— 如需上架，请人工在后台操作。`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { id: Number(target.id), product }
        };
      } catch (err) {
        return productToolError('update_product', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // create_product_doc —— 新建产品文档（草稿）
  // -------------------------------------------------------------------------
  register(
    SCOPE_PRODUCT_WRITE,
    'create_product_doc',
    {
      title: '新建产品文档（草稿）',
      description:
        '在某个产品下新建一篇文档。新建后状态为草稿（draft），前台不可见；' +
        '确认无误后再调用 publish_product_doc 发布。' +
        '注意：文档发布后若产品本身尚未人工上架，前台仍然看不到。',
      inputSchema: {
        product_id: z.number().int().positive().optional().describe('产品 id，与 product_short_name 二选一'),
        product_short_name: z
          .string()
          .max(100)
          .optional()
          .describe('产品短名，与 product_id 二选一'),
        title: z
          .string({ required_error: '文档标题必填', invalid_type_error: '文档标题必须是字符串' })
          .describe('文档标题，必填，最长 255 个字符'),
        slug: z
          .string({ required_error: 'slug 必填', invalid_type_error: 'slug 必须是字符串' })
          .describe(
            'URL 别名，必填，最长 255 个字符。只能用小写字母、数字和连字符，例如 install-guide'
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
          .describe('摘要，选填，最长 500 个字符'),
        sort_order: z.number().int().optional().describe('排序权重，选填，默认 0')
      },
      outputSchema: {
        id: z.number(),
        doc: z.object(productDocSummaryShape)
      }
    },
    async (args) => {
      try {
        const located = await resolveTargetProduct(db, {
          id: args.product_id,
          short_name: args.product_short_name
        });
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const product = located.product;

        const payload = validateProductDocPayload(
          {
            title: args.title,
            slug: args.slug,
            content_html: args.content_html,
            excerpt: args.excerpt,
            sort_order: args.sort_order
          },
          { strict: true }
        );

        // db.createProductDoc 固定写入 status='draft'
        const result = await db.createProductDoc({
          product_id: product.id,
          title: payload.title,
          slug: payload.slug,
          content_html: payload.contentHtml,
          excerpt: payload.excerpt,
          sort_order: payload.sortOrder,
          author_username: 'mcp'
        });

        const docId = Number(result.insertId);
        const row = await db.getProductDocById(docId);
        if (!row) {
          logger.error('[mcp] create_product_doc 写入成功但回读失败, id=', docId);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `已创建产品文档（id=${docId}），但回读校验失败，请用 get_product_doc 核对后再决定是否发布。`
              }
            ]
          };
        }

        writeOperationLog(
          'PRODUCT_DOC_CREATE',
          'mcp',
          `[MCP] Product Doc #${docId} (product ${product.id})`
        );
        const doc = toDocSummary(row);
        const text =
          `已创建产品文档 #${doc.id}「${doc.title}」（slug: ${doc.slug}），所属产品「${product.name}」。` +
          `当前状态：${doc.status} —— 前台还看不到，确认内容无误后调用 publish_product_doc 发布。`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { id: docId, doc }
        };
      } catch (err) {
        return productToolError('create_product_doc', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // publish_product_doc —— 发布产品文档
  // -------------------------------------------------------------------------
  register(
    SCOPE_PRODUCT_WRITE,
    'publish_product_doc',
    {
      title: '发布产品文档',
      description:
        '把一篇产品文档从草稿发布为已发布。定位用 doc_id，或同时提供 product_short_name 与 doc_slug。' +
        '注意：这只发布**文档**；产品本身若还是草稿，前台依然看不到，需要人工在后台点「上架」。',
      inputSchema: {
        doc_id: z.number().int().positive().optional().describe('文档 id，与短名组合二选一'),
        product_short_name: z.string().max(100).optional().describe('产品短名，与 doc_slug 一起使用'),
        doc_slug: z.string().max(255).optional().describe('文档 slug，与 product_short_name 一起使用')
      },
      outputSchema: {
        id: z.number(),
        doc: z.object(productDocSummaryShape)
      }
    },
    async (args) => {
      try {
        const located = await resolveTargetDoc(db, args);
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const target = located.doc;

        await db.publishProductDoc(Number(target.id));
        const row = await db.getProductDocById(Number(target.id));
        if (!row) {
          logger.error('[mcp] publish_product_doc 发布成功但回读失败, id=', target.id);
          return {
            isError: true,
            content: [{ type: 'text', text: `已发布文档（id=${target.id}），但回读校验失败，请用 get_product_doc 核对。` }]
          };
        }

        writeOperationLog('PRODUCT_DOC_PUBLISH', 'mcp', `[MCP] Product Doc #${target.id} (${target.slug})`);
        const doc = toDocSummary(row);
        const text =
          `已发布产品文档 #${doc.id}「${doc.title}」。` +
          `若所属产品尚未人工上架，前台仍不可见。`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { id: Number(target.id), doc }
        };
      } catch (err) {
        return productToolError('publish_product_doc', err, logger);
      }
    }
  );

  // -------------------------------------------------------------------------
  // unpublish_product_doc —— 撤稿产品文档
  // -------------------------------------------------------------------------
  register(
    SCOPE_PRODUCT_WRITE,
    'unpublish_product_doc',
    {
      title: '撤稿产品文档（转回草稿）',
      description:
        '把一篇已发布的产品文档撤回到草稿状态，前台立即不再显示。定位用 doc_id，或同时提供 product_short_name 与 doc_slug。',
      inputSchema: {
        doc_id: z.number().int().positive().optional().describe('文档 id，与短名组合二选一'),
        product_short_name: z.string().max(100).optional().describe('产品短名，与 doc_slug 一起使用'),
        doc_slug: z.string().max(255).optional().describe('文档 slug，与 product_short_name 一起使用')
      },
      outputSchema: {
        id: z.number(),
        doc: z.object(productDocSummaryShape)
      }
    },
    async (args) => {
      try {
        const located = await resolveTargetDoc(db, args);
        if (located.error) {
          return { isError: true, content: [{ type: 'text', text: located.error }] };
        }
        const target = located.doc;

        await db.unpublishProductDoc(Number(target.id));
        const row = await db.getProductDocById(Number(target.id));
        if (!row) {
          logger.error('[mcp] unpublish_product_doc 撤稿成功但回读失败, id=', target.id);
          return {
            isError: true,
            content: [{ type: 'text', text: `已撤稿文档（id=${target.id}），但回读校验失败，请用 get_product_doc 核对。` }]
          };
        }

        writeOperationLog('PRODUCT_DOC_UNPUBLISH', 'mcp', `[MCP] Product Doc #${target.id} (${target.slug})`);
        const doc = toDocSummary(row);
        const text = `已撤稿产品文档 #${doc.id}「${doc.title}」，当前状态：${doc.status}，前台不再显示。`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { id: Number(target.id), doc }
        };
      } catch (err) {
        return productToolError('unpublish_product_doc', err, logger);
      }
    }
  );
}

module.exports = {
  registerProductTools,
  productSummaryShape,
  productDocSummaryShape,
  productDocDetailShape,
  toProductSummary,
  toDocSummary,
  toDocDetail,
  normalizePricingTiers,
  friendlyProductDbError
};
