'use strict';

/**
 * 站点设置 / 图片地址的校验 —— 唯一事实来源（single source of truth）。
 *
 * 为什么单独抽一个模块：
 *   - settings.logo 被 40 多个页面直接拼进 `<img src="...">`（public/ 下到处是
 *     `'<img src="' + settings.logo + ...`）。前端只要漏一处转义就是存储型 XSS，
 *     逐个页面改 40 多处既容易漏、也难维护。
 *   - 换个角度看同一个问题：logo 的**写入路径只有两条** ——
 *       ① POST /api/upload-logo：路径由服务端生成（/uploads/xxx），天然安全；
 *       ② POST /api/db-import：管理员导入的 JSON 里带 settings.logo，原样入库。
 *     只要在写入口把值卡成「/uploads/... 或 http(s)://...」，
 *     40 多个渲染点一次性全部安全 —— 这正是本模块存在的意义。
 *   - banners 每项的 image、产品的 image 同理：它们都会被拼进 CSS url() 或
 *     HTML 属性，必须在入库前就挡住引号、括号这类能突破上下文的字符。
 *
 * 为什么分「严格（写）」和「宽松（读）」两套判定：
 *   - 严格判定用在写路径：只放行白名单内的地址，命中即抛 SettingsPolicyError，
 *     由 REST 层转成 400 + 明确文案。新写入的数据本就不该有问题。
 *   - 宽松判定用在读路径：面对的是历史存量数据。若因为老数据格式不理想就把站点的
 *     Logo 弄没了，那是可见的生产事故；所以读路径只拦「真能突破 HTML 属性 /
 *     CSS url() 上下文」的字符与协议，其余原样保留。被拦下的值会写进 warnings，
 *     由调用方落日志 —— 不静默丢弃。
 *
 * 字符白名单复用 lib/content-policy.js 的 COVER_IMAGE_ALLOWED_CHARS，
 * 不在这里另抄一份：新闻封面图和站点图片必须遵循同一套「什么字符算危险」的判断，
 * 两份正则一旦漂移，防守就会出现缺口。
 *
 * 错误码（稳定字符串，便于日志聚合与前端文案映射）：
 *   INVALID_IMAGE_URL / INVALID_LOGO_URL / INVALID_BANNERS / INVALID_BANNER_IMAGE
 */

const { COVER_IMAGE_ALLOWED_CHARS } = require('./content-policy');

/** 图片类 URL 的最大长度（对齐 settings.logo / products.image 的 varchar(500)）。 */
const IMAGE_URL_MAX_LENGTH = 500;

/** 横条数量上限 —— 防止有人把 settings.banners 撑成几 MB。 */
const MAX_BANNERS = 20;

/** 单条横条标题 / 描述的长度上限。 */
const MAX_BANNER_TITLE_LENGTH = 120;
const MAX_BANNER_DESCRIPTION_LENGTH = 500;

/** 工单优先级白名单。 */
const SUPPORT_PRIORITIES = Object.freeze(['high', 'normal', 'low']);

/** 优先级缺省值：不在白名单里的一律按普通处理。 */
const DEFAULT_SUPPORT_PRIORITY = 'normal';

/** 写路径放行的绝对协议。 */
const ALLOWED_IMAGE_URL_SCHEMES = Object.freeze(['http:', 'https:']);

/**
 * 读路径要拦的字符：能提前闭合 HTML 属性值、或引入新标签的形状。
 * 注意这里**不含**空白与括号 —— 站内相对路径 "img/我的 logo.png" 在
 * `<img src="...">` 里是合法的，不该因为一个空格就把老 Logo 弄没。
 */
const URL_ATTRIBUTE_DANGEROUS_CHARS = /["'<>`]/;

/** 读路径要拦的协议（javascript: / vbscript: / data:text/html 之类）。 */
const URL_DANGEROUS_SCHEME_PATTERN = /^(?:javascript|vbscript|data):/i;

class SettingsPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettingsPolicyError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * 严格判定一个地址能否作为「站点自持图片地址」写入。
 *
 * 放行的形态只有两种：
 *   - 站内绝对路径：/uploads/xxx.png（上传接口生成的形态）
 *   - http(s):// 绝对地址
 * 其余一律拒绝：协议相对地址（//evil.tld）、data:、javascript:、
 * 路径穿越（..），以及任何含引号/括号/逗号/分号/空白的地址。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isStrictlySafeImageUrl(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (text.length > IMAGE_URL_MAX_LENGTH) return false;

  // 字符白名单：不含 " ' ( ) , ; < > 空格 反斜杠 与任何非 ASCII 字符。
  // 这几个字符正是把地址拼进 CSS url() 或 HTML 属性时能被利用的形状。
  if (!COVER_IMAGE_ALLOWED_CHARS.test(text)) return false;

  // 协议相对地址：浏览器按当前页面协议解析，域名可逃逸。
  if (text.startsWith('//')) return false;

  // 路径穿越
  if (text.includes('..')) return false;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(text);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase() + ':';
    return ALLOWED_IMAGE_URL_SCHEMES.indexOf(scheme) !== -1;
  }

  // 无协议：必须是站内绝对路径（/uploads/xxx 之类）。
  return text.startsWith('/');
}

/**
 * 宽松判定：读路径用。历史数据只要「突破不了上下文」就放行。
 *
 * 与严格判定的差别是刻意留的余量：老数据里可能有相对路径、带空格的路径、
 * 甚至 data:image/... 的内联图，这些在 `<img src="...">` 里都是安全的，
 * 不该因为格式不理想就把站点图片弄没。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isLooselySafeImageUrl(value) {
  const text = normalizeText(value);
  if (!text) return true; // 空 = 未设置
  if (text.includes('..')) return false;
  if (URL_ATTRIBUTE_DANGEROUS_CHARS.test(text)) return false;
  // data: 只放行图片类型；data:text/html 之类一律拒绝。
  if (/^data:/i.test(text)) return /^data:image\//i.test(text);
  if (URL_DANGEROUS_SCHEME_PATTERN.test(text)) return false;
  return true;
}

/**
 * 校验并归一化一个图片地址（写路径通用入口）。
 *
 * @param {unknown} value 待校验的地址
 * @param {{field?: string, allowEmpty?: boolean, code?: string}} [options]
 *        field —— 出错文案里用的字段名（logo / 横条图片 / 产品配图）
 *        code  —— 抛出的错误码，默认 INVALID_IMAGE_URL
 * @returns {string} 归一化后的地址（空串表示不设置）
 * @throws {SettingsPolicyError}
 */
function assertSafeImageUrl(value, options = {}) {
  const field = options.field || '图片地址';
  const code = options.code || 'INVALID_IMAGE_URL';
  const allowEmpty = options.allowEmpty !== false;
  const text = normalizeText(value);

  if (!text) {
    if (allowEmpty) return '';
    throw new SettingsPolicyError(code, `${field}不能为空`);
  }
  if (text.length > IMAGE_URL_MAX_LENGTH) {
    throw new SettingsPolicyError(code, `${field}长度不能超过 ${IMAGE_URL_MAX_LENGTH} 个字符`);
  }
  if (!isStrictlySafeImageUrl(text)) {
    throw new SettingsPolicyError(
      code,
      `${field}不合法：只允许以 / 开头的本站路径或 http(s):// 绝对地址，且不能包含引号、空格、括号、逗号等字符`
    );
  }
  return text;
}

/**
 * 校验 settings.logo（写路径）。
 *
 * @param {unknown} value
 * @returns {string} 归一化后的地址；空串表示「不设置 Logo」
 * @throws {SettingsPolicyError}
 */
function assertSafeLogoUrl(value) {
  return assertSafeImageUrl(value, {
    field: 'Logo 地址',
    allowEmpty: true,
    code: 'INVALID_LOGO_URL'
  });
}

/**
 * 校验 settings.banners（写路径）。
 *
 * 只收紧三件事：条目必须是对象、图片地址必须过白名单、标题/描述有长度上限。
 * 其余字段原样保留 —— 横条对象以后可能加新字段，不在这里替开发者做决定。
 *
 * @param {unknown} value
 * @returns {Array<object>} 归一化后的横条数组
 * @throws {SettingsPolicyError}
 */
function assertSafeBanners(value) {
  if (!Array.isArray(value)) {
    throw new SettingsPolicyError('INVALID_BANNERS', '横条数据必须是数组');
  }
  if (value.length > MAX_BANNERS) {
    throw new SettingsPolicyError('INVALID_BANNERS', `横条数量不能超过 ${MAX_BANNERS} 条`);
  }

  return value.map((banner, index) => {
    const position = index + 1;
    if (!isPlainObject(banner)) {
      throw new SettingsPolicyError('INVALID_BANNERS', `第 ${position} 条横条的数据格式不正确`);
    }

    const image = normalizeText(banner.image);
    if (image && !isStrictlySafeImageUrl(image)) {
      throw new SettingsPolicyError(
        'INVALID_BANNER_IMAGE',
        `第 ${position} 条横条的图片地址不合法：只允许以 / 开头的本站路径或 http(s):// 绝对地址`
      );
    }

    const title = banner.title === undefined || banner.title === null ? '' : String(banner.title);
    if (title.length > MAX_BANNER_TITLE_LENGTH) {
      throw new SettingsPolicyError(
        'INVALID_BANNERS',
        `第 ${position} 条横条的标题长度不能超过 ${MAX_BANNER_TITLE_LENGTH} 个字符`
      );
    }

    const description = banner.description === undefined || banner.description === null
      ? ''
      : String(banner.description);
    if (description.length > MAX_BANNER_DESCRIPTION_LENGTH) {
      throw new SettingsPolicyError(
        'INVALID_BANNERS',
        `第 ${position} 条横条的描述长度不能超过 ${MAX_BANNER_DESCRIPTION_LENGTH} 个字符`
      );
    }

    return Object.assign({}, banner, { title: title.trim(), description: description.trim(), image });
  });
}

/**
 * 归一化工单优先级。
 *
 * 优先级过去是原样入库的，而它会被拼进后台页面的 class 属性 ——
 * 匿名访客可以提交任意字符串，等于给了后台一个存储型 XSS 的入口。
 * 这里把取值收敛到白名单，未知值一律按「普通」处理。
 *
 * @param {unknown} value
 * @returns {'high'|'normal'|'low'}
 */
function normalizeSupportPriority(value) {
  const text = normalizeText(value).toLowerCase();
  return SUPPORT_PRIORITIES.indexOf(text) !== -1 ? text : DEFAULT_SUPPORT_PRIORITY;
}

/**
 * 读路径净化：把历史存量数据里「突破得了上下文」的值挑掉。
 *
 * @param {{logo?: unknown, banners?: unknown}} settings
 * @returns {{logo: string, banners: Array<object>, warnings: string[]}}
 */
function sanitizeSettingsForRead(settings) {
  const warnings = [];
  const source = isPlainObject(settings) ? settings : {};

  let logo = '';
  const rawLogo = normalizeText(source.logo);
  if (rawLogo) {
    if (isLooselySafeImageUrl(rawLogo)) {
      logo = rawLogo;
    } else {
      warnings.push('settings.logo 含有不安全的地址或字符，读取时已忽略');
    }
  }

  let banners = [];
  if (Array.isArray(source.banners)) {
    banners = source.banners
      .filter((banner) => isPlainObject(banner))
      .map((banner) => {
        const image = normalizeText(banner.image);
        if (!image || isLooselySafeImageUrl(image)) return banner;
        warnings.push('settings.banners 中存在不安全的图片地址，读取时已忽略');
        return Object.assign({}, banner, { image: '' });
      });
  }

  return { logo, banners, warnings };
}

module.exports = {
  SettingsPolicyError,
  // 常量
  IMAGE_URL_MAX_LENGTH,
  MAX_BANNERS,
  MAX_BANNER_TITLE_LENGTH,
  MAX_BANNER_DESCRIPTION_LENGTH,
  SUPPORT_PRIORITIES,
  DEFAULT_SUPPORT_PRIORITY,
  // 写路径
  assertSafeImageUrl,
  assertSafeLogoUrl,
  assertSafeBanners,
  normalizeSupportPriority,
  // 读路径
  isStrictlySafeImageUrl,
  isLooselySafeImageUrl,
  sanitizeSettingsForRead
};
