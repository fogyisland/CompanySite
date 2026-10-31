'use strict';

/**
 * 产品（products）与产品文档（product_docs）的写入策略
 *
 * 与 lib/content-policy.js 是同一套设计（纯函数、无 IO、失败抛 ContentPolicyError），
 * 但产品的字段多、类型矩阵复杂，单独成文件 —— content-policy 已经 360 行，
 * 再塞进去会超出单文件 500 行的规范。
 *
 * 契约（与 content-policy 一致）：
 *   1. 纯函数、无 IO、不依赖 express / db，可脱离服务器单测。
 *   2. 失败一律抛 ContentPolicyError（带 code + 中文 message），
 *      由调用方决定呈现方式（REST → 400 JSON；MCP → tool error）。
 *   3. strict=true（MCP 侧）额外施加更严的策略（字符白名单、长度上限、数量上限）。
 *
 * 与 REST 的关系（重要，别误读）：
 *   - `resolveProductType()` 是**真共用**：REST 的 `POST /api/products` 与
 *     MCP 的 `create_product` 都调它，类型矩阵只有一份实现，不会漂移。
 *   - 字段级校验目前只有 MCP 端在用；REST 的 POST 仍保留自己的内联规则，
 *     规则内容与本模块逐条对应（各函数的「REST 对应」注释标明了出处）。
 *   - REST 的 `PUT /api/products/:id` 是**局部更新**语义，矩阵与 POST 不同
 *     （例如课程型在 PUT 里不清零 downloadUrl），因此**没有**接入本模块。
 */

const {
  ContentPolicyError,
  isPlainObject,
  normalizeText,
  normalizeSortOrder,
  validateTitle,
  validateSlug,
  validateContentHtml
} = require('./content-policy');

// ===== 列长度上限（对齐 prisma/schema.js 与线上表结构）=====
const PRODUCT_NAME_MAX_LENGTH = 255;          // products.name         varchar(255) NOT NULL
const PRODUCT_SHORT_NAME_MAX_LENGTH = 100;    // products.short_name   varchar(100) NOT NULL UNIQUE
const PRODUCT_CATEGORY_MAX_LENGTH = 255;      // products.category     varchar(255)
const PRODUCT_VERSION_MAX_LENGTH = 100;       // products.version      varchar(100)
const PRODUCT_PLATFORM_MAX_LENGTH = 100;      // products.platform     varchar(100)
const PRODUCT_ICON_MAX_LENGTH = 500;          // products.icon         varchar(500)
const PRODUCT_DOWNLOAD_URL_MAX_LENGTH = 500;  // products.download_url varchar(500)
const PRODUCT_REPO_URL_MAX_LENGTH = 500;      // 单个仓库地址的长度上限（repo_urls 为 JSON 列）
const PRODUCT_MAX_REPO_URLS = 10;             // 仓库地址数量上限
const PRODUCT_MAX_FEATURES = 50;              // 功能特点条数上限
const PRODUCT_FEATURE_MAX_LENGTH = 200;       // 单条功能特点长度上限
const PRODUCT_MAX_PRICING_TIERS = 12;         // 价格方案档数上限
const PRODUCT_TIER_LABEL_MAX_LENGTH = 50;     // 价格方案名称长度上限
const PRODUCT_TIER_MAX_DURATION = 120;        // 价格方案最长周期（月）
const PRODUCT_DOC_EXCERPT_MAX_LENGTH = 500;   // product_docs.excerpt  varchar(500)
const PRODUCT_DOC_CONTENT_MAX_LENGTH = 100000; // product_docs.content_html mediumtext（MCP 侧收紧）

/** 「开源产品」是写死的分类名，与 REST / 后台表单一致 */
const OPEN_SOURCE_CATEGORY = '开源产品';

/**
 * short_name 的字符白名单。
 *
 * 线上现存值是**混合大小写**（如 MingMailProfessionalToolkit），它就是产品的
 * URL 标识（/api/products/:slug/docs），所以这里不强制小写 —— 只挡掉会造成
 * URL 歧义或注入的字符（空格、斜杠、引号、反斜杠等）。
 */
const SHORT_NAME_ALLOWED_CHARS = /^[A-Za-z0-9._-]+$/;

/** 仓库地址只允许 http(s) —— 与 REST 的 /^https?:\/\//i 逐字一致 */
const REPO_URL_PATTERN = /^https?:\/\//i;

/** 把 true / 1 归一为布尔（与 REST 的 `x === true || x === 1` 口径一致） */
function toBoolean(value) {
  return value === true || value === 1;
}

/**
 * 结算产品的「类型矩阵」。
 *
 * 输入字段名与 REST 的 req.body 对齐：
 *   { category, isCourse, isSharedCode, repoUrls, price, pricingTiers, downloadUrl, externalLink }
 *
 * 返回：
 *   {
 *     isCourse, isSharedCode, isOpenSource, isFree,
 *     category,          // 原样保留（REST 存的就是原串，不做 trim）
 *     repoUrls,          // 已过滤为 http(s) 地址（REST 现状：不 trim，保留原串）
 *     price,             // 免费产品恒为 0
 *     pricingTiers,      // 免费产品恒为 null
 *     downloadUrl,       // 免费产品恒为 ''
 *     externalLink       // 免费产品恒为 false
 *   }
 *
 * 规则（与 REST `POST /api/products` 逐条对应）：
 *   1. 课程型与共享代码互斥。
 *   2. 开源产品 / 共享代码至少要有一个仓库地址。
 *   3. 免费产品（课程型 / 共享代码 / 开源产品）：价格、方案、下载链接、外链一律清空。
 *
 * 失败时抛 ContentPolicyError，message 与 REST 现在的文案**逐字一致**，
 * 这样 REST 换成调用本函数后，前端看到的报错不会变。
 */
function resolveProductType(input, options = {}) {
  const strict = options.strict === true;
  const source = isPlainObject(input) ? input : {};

  const isCourse = toBoolean(source.isCourse);
  const isSharedCode = toBoolean(source.isSharedCode);
  // 分类不做 trim —— REST 判定「开源产品」时用的就是原串，这里保持一致，
  // 否则 ' 开源产品 ' 会在 REST 与 MCP 两侧得出不同结论。
  const category = source.category || 'General';
  const isOpenSource = category === OPEN_SOURCE_CATEGORY;

  if (isCourse && isSharedCode) {
    throw new ContentPolicyError('PRODUCT_TYPE_CONFLICT', '课程型与共享代码不能同时启用');
  }

  // 仓库地址：只保留字符串型 http(s) 地址。
  // 注意保留的是**原串**（只用 trim 后的串做判定）—— 与 REST 现状一致。
  const rawRepoUrls = Array.isArray(source.repoUrls) ? source.repoUrls : [];
  const repoUrls = rawRepoUrls.filter(
    (url) => typeof url === 'string' && REPO_URL_PATTERN.test(url.trim())
  );

  if (strict) {
    if (repoUrls.length > PRODUCT_MAX_REPO_URLS) {
      throw new ContentPolicyError(
        'PRODUCT_REPO_TOO_MANY',
        `仓库地址最多 ${PRODUCT_MAX_REPO_URLS} 个`
      );
    }
    for (const url of repoUrls) {
      if (url.trim().length > PRODUCT_REPO_URL_MAX_LENGTH) {
        throw new ContentPolicyError(
          'PRODUCT_REPO_URL_TOO_LONG',
          `仓库地址长度不能超过 ${PRODUCT_REPO_URL_MAX_LENGTH} 个字符`
        );
      }
    }
  }

  if ((isOpenSource || isSharedCode) && repoUrls.length === 0) {
    throw new ContentPolicyError('PRODUCT_REPO_REQUIRED', '开源/共享代码产品至少需要一个仓库地址');
  }

  const isFree = isCourse || isSharedCode || isOpenSource;

  return {
    isCourse,
    isSharedCode,
    isOpenSource,
    isFree,
    category,
    repoUrls,
    price: isFree ? 0 : parseFloat(source.price || 0),
    pricingTiers: isFree ? null : (source.pricingTiers || null),
    downloadUrl: isFree ? '' : (source.downloadUrl || ''),
    externalLink: isFree ? false : (source.externalLink || false)
  };
}

/** 产品名称 */
function validateProductName(value) {
  const name = normalizeText(value);
  if (!name) {
    throw new ContentPolicyError('PRODUCT_NAME_REQUIRED', '产品名称不能为空');
  }
  if (name.length > PRODUCT_NAME_MAX_LENGTH) {
    throw new ContentPolicyError(
      'PRODUCT_NAME_TOO_LONG',
      `产品名称长度不能超过 ${PRODUCT_NAME_MAX_LENGTH} 个字符`
    );
  }
  return name;
}

/**
 * 产品短名（short_name）。
 *
 * 它同时是「URL 标识」和「唯一键」，因此 MCP 侧强制必填 + 字符白名单。
 * 严格程度：非 strict 时只做长度检查（保持与 REST 一致的宽松度）。
 */
function validateProductShortName(value, options = {}) {
  const strict = options.strict === true;
  const shortName = normalizeText(value);
  if (!shortName) {
    if (strict) {
      throw new ContentPolicyError(
        'PRODUCT_SHORT_NAME_REQUIRED',
        '产品短名（short_name）必填：它是产品的 URL 标识与唯一键，例如 ming-mail-pro'
      );
    }
    return '';
  }
  if (strict && !SHORT_NAME_ALLOWED_CHARS.test(shortName)) {
    throw new ContentPolicyError(
      'PRODUCT_SHORT_NAME_FORMAT',
      '产品短名只能包含字母、数字、点、下划线和连字符'
    );
  }
  if (shortName.length > PRODUCT_SHORT_NAME_MAX_LENGTH) {
    throw new ContentPolicyError(
      'PRODUCT_SHORT_NAME_TOO_LONG',
      `产品短名长度不能超过 ${PRODUCT_SHORT_NAME_MAX_LENGTH} 个字符`
    );
  }
  return shortName;
}

/** 产品分类 */
function validateProductCategory(value, options = {}) {
  const strict = options.strict === true;
  const category = strict ? normalizeText(value) : (value || '');
  if (category.length > PRODUCT_CATEGORY_MAX_LENGTH) {
    throw new ContentPolicyError(
      'PRODUCT_CATEGORY_TOO_LONG',
      `产品分类长度不能超过 ${PRODUCT_CATEGORY_MAX_LENGTH} 个字符`
    );
  }
  return category;
}

/**
 * 通用短文本字段（版本号 / 平台 / 图标 / 下载地址）。
 * 值为空时返回 ''，长度超限抛错。
 */
function validateShortText(value, maxLength, code, label) {
  const text = normalizeText(value);
  if (text.length > maxLength) {
    throw new ContentPolicyError(code, `${label}长度不能超过 ${maxLength} 个字符`);
  }
  return text;
}

/** 产品价格：必须是有限的非负数字 */
function validateProductPrice(value) {
  if (value === undefined || value === null || value === '') return 0;
  const price = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(price)) {
    throw new ContentPolicyError('PRODUCT_PRICE_INVALID', '产品价格必须是数字');
  }
  if (price < 0) {
    throw new ContentPolicyError('PRODUCT_PRICE_NEGATIVE', '产品价格不能为负数');
  }
  return price;
}

/**
 * 价格方案：[{ label, duration, price }]
 * 形状与后台表单一致（月付 duration=1、年付 duration=12）。
 */
function validatePricingTiers(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new ContentPolicyError('PRODUCT_TIERS_TYPE', '价格方案必须是数组');
  }
  if (value.length > PRODUCT_MAX_PRICING_TIERS) {
    throw new ContentPolicyError(
      'PRODUCT_TIERS_TOO_MANY',
      `价格方案最多 ${PRODUCT_MAX_PRICING_TIERS} 档`
    );
  }
  return value.map((tier, index) => {
    if (!isPlainObject(tier)) {
      throw new ContentPolicyError('PRODUCT_TIER_TYPE', `第 ${index + 1} 档价格方案必须是对象`);
    }
    const label = normalizeText(tier.label);
    if (!label) {
      throw new ContentPolicyError('PRODUCT_TIER_LABEL_REQUIRED', `第 ${index + 1} 档价格方案缺少名称`);
    }
    if (label.length > PRODUCT_TIER_LABEL_MAX_LENGTH) {
      throw new ContentPolicyError(
        'PRODUCT_TIER_LABEL_TOO_LONG',
        `第 ${index + 1} 档价格方案名称长度不能超过 ${PRODUCT_TIER_LABEL_MAX_LENGTH} 个字符`
      );
    }
    const duration = parseInt(tier.duration, 10);
    if (!Number.isFinite(duration) || duration < 1 || duration > PRODUCT_TIER_MAX_DURATION) {
      throw new ContentPolicyError(
        'PRODUCT_TIER_DURATION_INVALID',
        `第 ${index + 1} 档价格方案的周期必须是 1~${PRODUCT_TIER_MAX_DURATION} 之间的整数（月）`
      );
    }
    const price = validateProductPrice(tier.price);
    return { label, duration, price };
  });
}

/** 功能特点：字符串数组 */
function validateProductFeatures(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ContentPolicyError('PRODUCT_FEATURES_TYPE', '功能特点必须是数组');
  }
  if (value.length > PRODUCT_MAX_FEATURES) {
    throw new ContentPolicyError(
      'PRODUCT_FEATURES_TOO_MANY',
      `功能特点最多 ${PRODUCT_MAX_FEATURES} 条`
    );
  }
  return value.map((item) => {
    const text = normalizeText(item);
    if (text.length > PRODUCT_FEATURE_MAX_LENGTH) {
      throw new ContentPolicyError(
        'PRODUCT_FEATURE_TOO_LONG',
        `单条功能特点长度不能超过 ${PRODUCT_FEATURE_MAX_LENGTH} 个字符`
      );
    }
    return text;
  });
}

/**
 * 产品创建（新建场景）的完整校验。
 * 返回值可直接喂给 db.createProduct / db.addProduct。
 *
 * strict=true 时额外施加：短名必填 + 字符白名单、价格非负且为数字、
 * 方案 / 特点 / 仓库地址的数量与长度上限。
 */
function validateProductPayload(input, options = {}) {
  const strict = options.strict === true;
  const source = isPlainObject(input) ? input : {};

  const name = validateProductName(source.name);
  const shortName = validateProductShortName(source.short_name, { strict });
  const category = validateProductCategory(source.category, { strict });
  const version = validateShortText(
    source.version, PRODUCT_VERSION_MAX_LENGTH, 'PRODUCT_VERSION_TOO_LONG', '版本号'
  );
  const platform = validateShortText(
    source.platform, PRODUCT_PLATFORM_MAX_LENGTH, 'PRODUCT_PLATFORM_TOO_LONG', '适用平台'
  );
  const icon = validateShortText(
    source.icon, PRODUCT_ICON_MAX_LENGTH, 'PRODUCT_ICON_TOO_LONG', '图标'
  );
  const description = typeof source.description === 'string' ? source.description : '';
  const features = validateProductFeatures(source.features);

  // 类型矩阵：价格 / 方案 / 下载地址 / 外链在这里定型
  const type = resolveProductType(
    {
      category,
      isCourse: source.is_course,
      isSharedCode: source.is_shared_code,
      repoUrls: source.repo_urls,
      price: source.price,
      pricingTiers: source.pricing_tiers,
      downloadUrl: source.download_url,
      externalLink: source.external_link
    },
    { strict }
  );

  // 免费产品价格恒为 0，不必再校验；收费产品要校验价格是合法数字
  const price = type.isFree ? 0 : validateProductPrice(type.price);
  const pricingTiers = type.isFree ? null : validatePricingTiers(type.pricingTiers);
  const downloadUrl = validateShortText(
    type.downloadUrl, PRODUCT_DOWNLOAD_URL_MAX_LENGTH, 'PRODUCT_DOWNLOAD_URL_TOO_LONG', '下载地址'
  );

  return {
    name,
    shortName,
    category,
    price,
    pricingTiers,
    description,
    version: version || '1.0.0',
    platform: platform || 'Windows',
    features,
    icon: icon || 'software',
    featured: toBoolean(source.featured),
    downloadUrl,
    externalLink: type.externalLink,
    isCourse: type.isCourse,
    isSharedCode: type.isSharedCode,
    repoUrls: type.repoUrls
  };
}

/**
 * 局部更新：只校验调用方**显式提供**的字段。
 *
 * 与 news 的 validateNewsPatch 同理 —— 存量脏数据不该阻塞无关修改：
 * AI 只想改个描述，不该被历史遗留的短名或地址挡住。
 *
 * 判定「显式提供」用 !== undefined（而非 in）：显式传空串 '' 表示「清空该字段」。
 */
function validateProductPatch(patch, options = {}) {
  const source = isPlainObject(patch) ? patch : {};
  const result = {};
  if (source.name !== undefined) result.name = validateProductName(source.name);
  if (source.short_name !== undefined) {
    result.shortName = validateProductShortName(source.short_name, { strict: true });
  }
  if (source.category !== undefined) {
    result.category = validateProductCategory(source.category, { strict: true });
  }
  if (source.version !== undefined) {
    result.version = validateShortText(
      source.version, PRODUCT_VERSION_MAX_LENGTH, 'PRODUCT_VERSION_TOO_LONG', '版本号'
    );
  }
  if (source.platform !== undefined) {
    result.platform = validateShortText(
      source.platform, PRODUCT_PLATFORM_MAX_LENGTH, 'PRODUCT_PLATFORM_TOO_LONG', '适用平台'
    );
  }
  if (source.icon !== undefined) {
    result.icon = validateShortText(
      source.icon, PRODUCT_ICON_MAX_LENGTH, 'PRODUCT_ICON_TOO_LONG', '图标'
    );
  }
  if (source.description !== undefined) {
    if (typeof source.description !== 'string') {
      throw new ContentPolicyError('PRODUCT_DESCRIPTION_TYPE', '产品描述必须是字符串');
    }
    result.description = source.description;
  }
  if (source.features !== undefined) result.features = validateProductFeatures(source.features);
  if (source.featured !== undefined) result.featured = toBoolean(source.featured);
  if (source.price !== undefined) result.price = validateProductPrice(source.price);
  if (source.pricing_tiers !== undefined) {
    result.pricingTiers = source.pricing_tiers === null
      ? null
      : validatePricingTiers(source.pricing_tiers);
  }
  if (source.download_url !== undefined) {
    result.downloadUrl = validateShortText(
      source.download_url, PRODUCT_DOWNLOAD_URL_MAX_LENGTH, 'PRODUCT_DOWNLOAD_URL_TOO_LONG', '下载地址'
    );
  }
  if (source.external_link !== undefined) result.externalLink = toBoolean(source.external_link);
  if (source.is_course !== undefined) result.isCourse = toBoolean(source.is_course);
  if (source.is_shared_code !== undefined) result.isSharedCode = toBoolean(source.is_shared_code);
  if (source.repo_urls !== undefined) {
    if (!Array.isArray(source.repo_urls)) {
      throw new ContentPolicyError('PRODUCT_REPO_TYPE', '仓库地址必须是数组');
    }
    result.repoUrls = source.repo_urls;
  }
  return result;
}

/**
 * 产品文档（product_docs）的写入校验。
 *
 * 规则与后台 REST 的 `/api/admin/products/:productId/docs` 一致：
 *   title / slug / content_html 必填，slug 只允许小写字母、数字、连字符。
 * 差异仅在于 MCP 侧额外限制了摘要长度（500，与列宽一致）与正文长度。
 */
function validateProductDocPayload(input, options = {}) {
  const strict = options.strict === true;
  const source = isPlainObject(input) ? input : {};

  const title = validateTitle(source.title);
  const slug = validateSlug(source.slug);
  const contentHtml = validateContentHtml(source.content_html, { strict });

  const excerpt = normalizeText(source.excerpt);
  if (excerpt.length > PRODUCT_DOC_EXCERPT_MAX_LENGTH) {
    throw new ContentPolicyError(
      'PRODUCT_DOC_EXCERPT_TOO_LONG',
      `文档摘要长度不能超过 ${PRODUCT_DOC_EXCERPT_MAX_LENGTH} 个字符`
    );
  }

  return {
    title,
    slug,
    contentHtml,
    excerpt,
    sortOrder: normalizeSortOrder(source.sort_order)
  };
}

/** 产品文档的局部更新：只校验显式提供的字段 */
function validateProductDocPatch(patch, options = {}) {
  const strict = options.strict === true;
  const source = isPlainObject(patch) ? patch : {};
  const result = {};
  if (source.title !== undefined) result.title = validateTitle(source.title);
  if (source.slug !== undefined) result.slug = validateSlug(source.slug);
  if (source.content_html !== undefined) {
    result.contentHtml = validateContentHtml(source.content_html, { strict });
  }
  if (source.excerpt !== undefined) {
    const excerpt = normalizeText(source.excerpt);
    if (excerpt.length > PRODUCT_DOC_EXCERPT_MAX_LENGTH) {
      throw new ContentPolicyError(
        'PRODUCT_DOC_EXCERPT_TOO_LONG',
        `文档摘要长度不能超过 ${PRODUCT_DOC_EXCERPT_MAX_LENGTH} 个字符`
      );
    }
    result.excerpt = excerpt;
  }
  if (source.sort_order !== undefined) result.sortOrder = normalizeSortOrder(source.sort_order);
  return result;
}

/** 排序权重归一直接复用 content-policy 的实现，避免两处各写一份规则 */

module.exports = {
  // 列上限 / 规则常量
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_SHORT_NAME_MAX_LENGTH,
  PRODUCT_CATEGORY_MAX_LENGTH,
  PRODUCT_VERSION_MAX_LENGTH,
  PRODUCT_PLATFORM_MAX_LENGTH,
  PRODUCT_ICON_MAX_LENGTH,
  PRODUCT_DOWNLOAD_URL_MAX_LENGTH,
  PRODUCT_REPO_URL_MAX_LENGTH,
  PRODUCT_MAX_REPO_URLS,
  PRODUCT_MAX_FEATURES,
  PRODUCT_FEATURE_MAX_LENGTH,
  PRODUCT_MAX_PRICING_TIERS,
  PRODUCT_TIER_LABEL_MAX_LENGTH,
  PRODUCT_TIER_MAX_DURATION,
  PRODUCT_DOC_EXCERPT_MAX_LENGTH,
  PRODUCT_DOC_CONTENT_MAX_LENGTH,
  OPEN_SOURCE_CATEGORY,
  SHORT_NAME_ALLOWED_CHARS,
  REPO_URL_PATTERN,
  // 校验原语
  resolveProductType,
  validateProductName,
  validateProductShortName,
  validateProductCategory,
  validateProductPrice,
  validatePricingTiers,
  validateProductFeatures,
  validateProductPayload,
  validateProductPatch,
  validateProductDocPayload,
  validateProductDocPatch,
  // 工具
  toBoolean
};
