'use strict';

/**
 * 内容策略（Content Policy）—— REST 与 MCP 两条写路径共用的校验原语
 *
 * 为什么独立成模块：
 *   后台表单（REST）和 AI 工具（MCP）写的是同一张 news 表、同一批字段，
 *   规则若各写一份必然漂移。本模块是唯一事实来源。
 *
 * 契约：
 *   1. 纯函数、无 IO、不依赖 express / db，可脱离服务器单测。
 *   2. 失败一律抛 ContentPolicyError（带 code + 中文 message），
 *      由调用方决定呈现方式（REST → 400 JSON；MCP → tool error）。
 *   3. strict=false 的分支必须与 REST 现有行为**逐字一致**，
 *      否则 REST 一旦接入本模块就会产生行为漂移。
 *   4. strict=true（MCP 侧）额外施加更严的策略：
 *      cover_image 白名单 + 正文粗粒度闸门 + 更紧的长度上限。
 *
 * 关于 strict=true 下 content_html 的闸门（重要，勿误读）：
 *   那是一道**输入契约闸门**，不是 HTML 净化器。它按黑名单拦截明显越界的内容，
 *   命中即拒绝（fail-closed），不做静默改写；它无法覆盖实体编码、畸形标签等
 *   所有变形形态。渲染端 public/news.html 的 DOMPurify 才是最终防线。
 *   若将来要在此层做真正的净化，需要引入与浏览器同源的 HTML5 解析器
 *   （parse5 之类），避免解析器差异导致的 mXSS。
 */

class ContentPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContentPolicyError';
    this.code = code;
  }
}

// ===== 列长度上限（对齐 prisma/schema.js 的 news 表定义）=====
const TITLE_MAX_LENGTH = 255;        // news.title        varchar(255)
const SLUG_MAX_LENGTH = 255;         // news.slug         varchar(255)
const EXCERPT_MAX_LENGTH = 65535;    // news.excerpt      text
const CATEGORY_MAX_LENGTH = 50;      // news.category     varchar(50)
const COVER_IMAGE_MAX_LENGTH = 500;  // news.cover_image  varchar(500)

// ===== MCP 侧（strict=true）收紧后的上限 =====
const MCP_CONTENT_HTML_MAX_LENGTH = 100000; // 单篇动态正文 ≤ 10 万字符
const MCP_EXCERPT_MAX_LENGTH = 2000;        // 摘要 ≤ 2000 字符

// slug 规则：与 REST 现有内联规则完全一致
const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * cover_image 的字符白名单。
 *
 * 用白名单而非黑名单：只要落在白名单之外就一律拒绝。
 * 关键在于白名单**不含** ( ) , ; " ' \ 与任何空白/控制字符 ——
 * 这几个字符正是把 cover_image 拼进未加引号的 CSS url() 时能被利用的形状：
 *   x), url(https://evil.tld/beacon.png)   → 叠加第二层背景
 *   x); background-image: url(...)          → 闭合后追加新声明
 *   \29                                     → CSS 转义出来的右括号
 * 白名单里保留的 & ? # = 等字符足以覆盖 /uploads/xxx.png 与
 * https://cdn.example.com/cover.jpg?v=2 这类真实地址。
 */
const COVER_IMAGE_ALLOWED_CHARS = /^[A-Za-z0-9._~:/?#@!$&*+=%-]+$/;

/**
 * 正文粗粒度闸门命中的构造。
 * hint 会直接回给 AI 工具，让它能据此改写内容，而不是只得到一个「不合法」。
 */
const UNSAFE_HTML_CONSTRUCTS = [
  { pattern: /<\s*script\b/i, hint: '<script> 标签' },
  { pattern: /<\s*iframe\b/i, hint: '<iframe> 标签' },
  { pattern: /<\s*(?:object|embed|applet)\b/i, hint: '<object>/<embed>/<applet> 标签' },
  { pattern: /<\s*(?:style|link|base|meta|form|svg|math)\b/i, hint: '<style>/<link>/<base>/<meta>/<form>/<svg>/<math> 标签' },
  { pattern: /\bsrcdoc\s*=/i, hint: 'srcdoc 属性' },
  { pattern: /\b(?:javascript|vbscript)\s*:/i, hint: 'javascript:/vbscript: 协议' },
  { pattern: /\bdata\s*:\s*text\/html/i, hint: 'data:text/html 内联页面' },
  // 事件属性：on 开头且总长 ≥ 4（onclick/onerror/onload…）。
  // 要求 ≥ 4 是为了不误伤英文单词 "on"（如 ?on=1、turn on=true）。
  { pattern: /\son[a-z]{3,}\s*=/i, hint: 'on* 事件属性' }
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeSortOrder(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 标题 + slug 的联合校验。
 *
 * 逐字复刻 REST 现有两条检查，保证接入后行为零漂移：
 *   - 缺 title 或 slug → '标题和 slug 必填'
 *   - slug 不匹配 /^[a-z0-9-]+$/ → 'slug 仅允许小写字母、数字、连字符'
 *
 * 注意：这里对 slug **不做 trim**。REST 现有规则下 ' abc ' 因含空格而非法；
 * 若在这里先 trim 再判定，等于悄悄放宽了 REST 的规则。
 * 需要 trim 的调用方（MCP）请自行先归一化再传入。
 *
 * 新增：slug 长度上限（对齐 varchar(255)）。原先超长 slug 会打到数据库变成 500，
 * 现在提前返回 400 —— 这是修正，不是收紧。
 */
function validateNewsIdentity(input) {
  const source = isPlainObject(input) ? input : {};
  const rawTitle = source.title;
  const rawSlug = source.slug;

  if (!rawTitle || !rawSlug) {
    throw new ContentPolicyError('TITLE_SLUG_REQUIRED', '标题和 slug 必填');
  }
  // 显式转字符串再做正则判定：REST 原实现是 /regex/.test(slug)，
  // 会隐式把数字等类型转成字符串；这里保持同样的判定口径。
  const slugText = typeof rawSlug === 'string' ? rawSlug : String(rawSlug);
  if (!SLUG_PATTERN.test(slugText)) {
    throw new ContentPolicyError('SLUG_FORMAT', 'slug 仅允许小写字母、数字、连字符');
  }
  if (slugText.length > SLUG_MAX_LENGTH) {
    throw new ContentPolicyError('SLUG_TOO_LONG', `slug 长度不能超过 ${SLUG_MAX_LENGTH} 个字符`);
  }
  return { title: String(rawTitle), slug: slugText };
}

function validateTitle(title) {
  const value = normalizeText(title);
  if (!value) {
    throw new ContentPolicyError('TITLE_REQUIRED', '标题不能为空');
  }
  if (value.length > TITLE_MAX_LENGTH) {
    throw new ContentPolicyError('TITLE_TOO_LONG', `标题长度不能超过 ${TITLE_MAX_LENGTH} 个字符`);
  }
  return value;
}

function validateSlug(slug) {
  const value = normalizeText(slug);
  if (!value) {
    throw new ContentPolicyError('SLUG_REQUIRED', 'slug 不能为空');
  }
  if (!SLUG_PATTERN.test(value)) {
    throw new ContentPolicyError('SLUG_FORMAT', 'slug 仅允许小写字母、数字、连字符');
  }
  if (value.length > SLUG_MAX_LENGTH) {
    throw new ContentPolicyError('SLUG_TOO_LONG', `slug 长度不能超过 ${SLUG_MAX_LENGTH} 个字符`);
  }
  return value;
}

/**
 * 封面图地址的字符白名单检查。命中即抛，不做任何静默改写。
 */
function assertCoverImageChars(value) {
  if (!COVER_IMAGE_ALLOWED_CHARS.test(value)) {
    throw new ContentPolicyError(
      'COVER_IMAGE_CHARS',
      '封面图地址含有非法字符。只允许字母、数字与 - _ . ~ / : ? # @ ! $ & * + = %（不能含空格、逗号、分号、括号、引号、反斜杠）'
    );
  }
}

/**
 * 封面图地址校验。
 *
 * strict=false（REST 现状）：只做长度上限检查，原样放行。
 *   —— REST 的 cover_image 策略属于 B-5 待决项，本模块刻意不去改变它。
 *
 * strict=true（MCP）：白名单字符 + 协议白名单 + 路径穿越检查。
 *   - 空串 = 不设封面，合法
 *   - 站内相对路径：必须以 / 开头且不能以 // 开头（协议相对地址）
 *   - 绝对地址：只允许 https://（http:// 在 https 站点会被浏览器拦掉，没必要放行）
 *
 * **判定顺序刻意按「形态」分层**，目的是让报错直指病因：
 *   协议错了要报协议，不能让字符白名单先命中 —— 否则 AI 拿到
 *   「含有非法字符」这种答非所问的提示，会去改字符而不是改协议。
 *   同理，相对路径里的空格才报字符错；既不是路径也没有协议的
 *   字符串先看字符是否合法（不合法就是字符问题），合法才报形态问题。
 */
function validateCoverImage(url, options = {}) {
  const strict = options.strict === true;
  const value = normalizeText(url);

  if (!value) return '';
  if (value.length > COVER_IMAGE_MAX_LENGTH) {
    throw new ContentPolicyError('COVER_IMAGE_TOO_LONG', `封面图地址长度不能超过 ${COVER_IMAGE_MAX_LENGTH} 个字符`);
  }
  if (!strict) return value;

  // 1) 协议相对地址 //evil.tld/x.png —— 浏览器按当前页面协议解析，域名可逃逸
  if (value.startsWith('//')) {
    throw new ContentPolicyError('COVER_IMAGE_PROTOCOL_RELATIVE', '封面图地址不能以 // 开头（协议相对地址）');
  }

  // 2) 站内相对路径
  if (value.startsWith('/')) {
    if (value.includes('..')) {
      throw new ContentPolicyError('COVER_IMAGE_TRAVERSAL', '封面图地址不能包含 .. 路径片段');
    }
    assertCoverImageChars(value);
    return value;
  }

  // 3) 带协议的绝对地址：先判协议，再判字符，最后判主机名
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'https') {
      throw new ContentPolicyError(
        'COVER_IMAGE_SCHEME',
        `封面图地址只允许 https:// 协议，当前是 ${scheme}://。站内图片请用相对路径（以 / 开头，例如 /uploads/doc-images/cover.png）`
      );
    }
    assertCoverImageChars(value);
    const authority = value.slice('https://'.length).split('/')[0].split('?')[0].split('#')[0];
    if (!authority.includes('.')) {
      throw new ContentPolicyError('COVER_IMAGE_HOST', '封面图地址缺少合法的主机名');
    }
    return value;
  }

  // 4) 既不是站内路径、也没有协议 —— 先判字符（更贴近真正的病因），再判形态
  assertCoverImageChars(value);
  throw new ContentPolicyError(
    'COVER_IMAGE_SCHEME',
    '封面图地址必须是站内相对路径（以 / 开头，例如 /uploads/doc-images/cover.png）或 https:// 绝对地址'
  );
}

/**
 * 正文 HTML 校验。
 *
 * strict=false：原样返回（REST 现状）。
 * strict=true：长度上限 + 非空 + 粗粒度闸门（命中即拒绝，不静默改写）。
 */
function validateContentHtml(html, options = {}) {
  const strict = options.strict === true;
  if (html === undefined || html === null) {
    if (strict) {
      throw new ContentPolicyError('CONTENT_REQUIRED', '正文 content_html 必填');
    }
    return '';
  }
  if (typeof html !== 'string') {
    if (strict) {
      throw new ContentPolicyError('CONTENT_TYPE', '正文 content_html 必须是字符串');
    }
    return '';
  }
  if (!strict) return html;

  if (html.length > MCP_CONTENT_HTML_MAX_LENGTH) {
    throw new ContentPolicyError('CONTENT_TOO_LONG', `正文长度不能超过 ${MCP_CONTENT_HTML_MAX_LENGTH} 个字符`);
  }
  if (!html.trim()) {
    throw new ContentPolicyError('CONTENT_EMPTY', '正文 content_html 不能为空');
  }
  for (const construct of UNSAFE_HTML_CONSTRUCTS) {
    if (construct.pattern.test(html)) {
      throw new ContentPolicyError(
        'CONTENT_UNSAFE',
        `正文含有被禁止的内容：${construct.hint}。请只提交纯正文 HTML（段落、标题、列表、链接、图片、表格等），不要带脚本、样式块、内嵌框架或事件属性。`
      );
    }
  }
  return html;
}

function validateExcerpt(excerpt, options = {}) {
  const strict = options.strict === true;
  const value = normalizeText(excerpt);
  const limit = strict ? MCP_EXCERPT_MAX_LENGTH : EXCERPT_MAX_LENGTH;
  if (value.length > limit) {
    throw new ContentPolicyError('EXCERPT_TOO_LONG', `摘要长度不能超过 ${limit} 个字符`);
  }
  return value;
}

function validateCategory(category, options = {}) {
  const value = normalizeText(category);
  if (value.length > CATEGORY_MAX_LENGTH) {
    throw new ContentPolicyError('CATEGORY_TOO_LONG', `分类长度不能超过 ${CATEGORY_MAX_LENGTH} 个字符`);
  }
  return value;
}

/**
 * 整篇动态的完整校验（新建场景）。
 * 返回值可直接喂给 db.createNews / db.updateNews。
 */
function validateNewsPayload(input, options = {}) {
  const source = isPlainObject(input) ? input : {};
  return {
    title: validateTitle(source.title),
    slug: validateSlug(source.slug),
    excerpt: validateExcerpt(source.excerpt, options),
    contentHtml: validateContentHtml(source.content_html, options),
    coverImage: validateCoverImage(source.cover_image, options),
    category: validateCategory(source.category, options),
    isPinned: source.is_pinned === true || source.is_pinned === 1,
    sortOrder: normalizeSortOrder(source.sort_order)
  };
}

/**
 * 局部更新校验：只校验调用方**显式提供**的字段。
 *
 * 为什么不做「合并后再整体校验」：
 *   历史数据的 cover_image 可能不符合 MCP 的严格白名单（那正是 B-5 待决的存量）。
 *   如果整体校验，AI 只想改个标题也会被历史封面挡住 —— 存量问题不该阻塞无关修改。
 *   所以：AI 写进来的字段必须合规；没碰的字段原样保留。
 *
 * 判定「显式提供」用 !== undefined（而非 in），因为 zod 解析后的可选字段
 * 缺席时值为 undefined，而显式传空串 '' 表示「清空该字段」，两者要区分开。
 */
function validateNewsPatch(patch, options = {}) {
  const source = isPlainObject(patch) ? patch : {};
  const result = {};
  if (source.title !== undefined) result.title = validateTitle(source.title);
  if (source.slug !== undefined) result.slug = validateSlug(source.slug);
  if (source.excerpt !== undefined) result.excerpt = validateExcerpt(source.excerpt, options);
  if (source.content_html !== undefined) result.contentHtml = validateContentHtml(source.content_html, options);
  if (source.cover_image !== undefined) result.coverImage = validateCoverImage(source.cover_image, options);
  if (source.category !== undefined) result.category = validateCategory(source.category, options);
  if (source.is_pinned !== undefined) result.isPinned = source.is_pinned === true || source.is_pinned === 1;
  if (source.sort_order !== undefined) result.sortOrder = normalizeSortOrder(source.sort_order);
  return result;
}

module.exports = {
  ContentPolicyError,
  // 列上限 / 规则常量
  TITLE_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  EXCERPT_MAX_LENGTH,
  CATEGORY_MAX_LENGTH,
  COVER_IMAGE_MAX_LENGTH,
  MCP_CONTENT_HTML_MAX_LENGTH,
  MCP_EXCERPT_MAX_LENGTH,
  SLUG_PATTERN,
  COVER_IMAGE_ALLOWED_CHARS,
  // 校验原语
  validateNewsIdentity,
  validateTitle,
  validateSlug,
  validateCoverImage,
  validateContentHtml,
  validateExcerpt,
  validateCategory,
  validateNewsPayload,
  validateNewsPatch,
  // 工具
  isPlainObject,
  normalizeText,
  normalizeSortOrder
};
