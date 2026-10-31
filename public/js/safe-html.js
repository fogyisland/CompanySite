/**
 * 前端安全渲染工具 —— 唯一事实来源（single source of truth）。
 *
 * 为什么要有这个文件：
 *   站点的各个页面各自抄了一份 escapeHtml，而抄出来的版本并不一样：
 *   有一类是用 `div.textContent = s; return div.innerHTML` 实现的 —— 那种写法
 *   **只转义 & < >，不转义引号**。它放在文本节点里没问题，一旦被拼进 HTML 属性
 *   （`title="${escapeHtml(x)}"`）就形同虚设：引号照样能提前闭合属性。
 *   另一类用 `replace(/[&<>"']/g, ...)` 实现，文本与属性上下文都安全。
 *   两类并存、逐页复制，正是「同一套规则写出两个版本」的典型漂移。
 *
 *   本文件把这几件事收成一处：
 *     - escapeHtml：文本节点与属性上下文都安全的转义（转义 & < > " '）；
 *     - safeImageUrl / safeCssUrl / safeHref：地址类字段的白名单过滤；
 *     - sanitizeHtml / setSafeHtml：富文本的统一入口（有 DOMPurify 就净化，
 *       没有就退化成纯文本，绝不把未经净化的 HTML 直接塞进页面）。
 *
 * 用法（页面里只需引一次，本文件是普通 <script>，放在 <head> 里即可）：
 *   <script src="/js/safe-html.js?v=1"></script>
 *   ...
 *   SafeHtml.escapeHtml(value)
 *
 * 页面里原有的 escapeHtml 可以保留，但实现改成转发到 SafeHtml，
 * 免得改一大片调用点（调用点本身是对的，错的是实现）。
 */
(function (global) {
  'use strict';

  /** HTML 实体映射。属性上下文里 " 与 ' 同样危险，必须一起转义。 */
  var HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  /**
   * 地址里不能出现的字符。
   * " ' < > ` \ 能提前闭合 HTML 属性值或引入新标签；反斜杠在部分浏览器里
   * 还能被当作转义符用（\/\/evil.com），一并挡掉。
   */
  var URL_FORBIDDEN_CHARS = /["'<>`\\]/;

  /** CSS url() 上下文的额外禁止字符：括号与反斜杠能闭合/转义 url() 调用。 */
  var CSS_URL_FORBIDDEN_CHARS = /[()'"<>`\\]/;

  /** 能执行脚本的协议。 */
  var DANGEROUS_SCHEME = /^(?:javascript|vbscript|data):/i;

  /**
   * 转义 HTML 特殊字符。
   *
   * 与 `textContent` 方案不同，这里**连引号一起转义**，
   * 因此同一个函数可以安全地用在文本节点和属性值两种上下文里。
   *
   * @param {*} value
   * @returns {string}
   */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (char) {
      return HTML_ESCAPE_MAP[char];
    });
  }

  /**
   * 校验一个「图片地址」是否可以安全地放进 src 属性。
   *
   * 放行：站内路径（/uploads/xxx）、普通相对路径、http(s):// 绝对地址、
   *       data:image/... 内联图。
   * 拦截：协议相对地址（//evil.tld）、路径穿越（..）、javascript:/vbscript:、
   *       data:text/html、含引号等危险字符的地址。
   *
   * @param {*} value
   * @returns {string} 合法时返回原地址（已 trim），不合法时返回空串
   */
  function safeImageUrl(value) {
    if (value === null || value === undefined) return '';
    var text = String(value).trim();
    if (!text) return '';
    if (URL_FORBIDDEN_CHARS.test(text)) return '';
    if (text.indexOf('//') === 0) return '';   // 协议相对地址：域名可逃逸
    if (text.indexOf('..') !== -1) return '';   // 路径穿越
    if (/^data:/i.test(text)) {
      return /^data:image\//i.test(text) ? text : '';
    }
    if (DANGEROUS_SCHEME.test(text)) return '';
    if (text.indexOf('/') === 0) return text;   // 站内绝对路径
    if (/^https?:\/\//i.test(text)) return text;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return '';  // 其它带协议的地址
    return text;                                // 普通相对路径
  }

  /**
   * 校验一个地址是否可以安全地放进 CSS 的 url('...')。
   *
   * 在 safeImageUrl 的基础上再挡掉括号、反斜杠与空白：
   *   x), url(https://evil.tld/beacon.png)   → 叠加第二层背景
   *   x); background-image: url(...)          → 闭合后追加新声明
   *   \29                                     → CSS 转义出来的右括号
   *
   * @param {*} value
   * @returns {string} 合法时返回原地址，不合法时返回空串
   */
  function safeCssUrl(value) {
    var text = safeImageUrl(value);
    if (!text) return '';
    if (CSS_URL_FORBIDDEN_CHARS.test(text)) return '';
    if (/\s/.test(text)) return '';
    return text;
  }

  /**
   * 校验一个地址是否可以安全地放进 href。
   *
   * 放行：站内路径、锚点、查询串、http(s)、mailto、tel。
   * 拦截：javascript: 等可执行协议，以及协议相对地址。
   *
   * @param {*} value
   * @returns {string} 合法时返回原地址，不合法时返回空串
   */
  function safeHref(value) {
    if (value === null || value === undefined) return '';
    var text = String(value).trim();
    if (!text) return '';
    if (URL_FORBIDDEN_CHARS.test(text)) return '';
    if (text.indexOf('//') === 0) return '';
    if (DANGEROUS_SCHEME.test(text)) return '';
    if (text.charAt(0) === '/' || text.charAt(0) === '#' || text.charAt(0) === '?') return text;
    if (/^(?:https?|mailto|tel):/i.test(text)) return text;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return '';  // 其它带协议的地址
    return text;
  }

  /**
   * 净化一段富文本 HTML。
   *
   * 有 DOMPurify 时用它净化（项目里 vendor 目录带了 DOMPurify 3.0.6）；
   * 没有 DOMPurify 时**不做任何原样返回** —— 退化成转义后的纯文本。
   * 「没有净化器就原样插入」是最常见的踩坑方式：doc.html 曾经就是这么写的。
   *
   * @param {*} html
   * @returns {string} 可安全赋给 innerHTML 的字符串
   */
  function sanitizeHtml(html) {
    var source = html === null || html === undefined ? '' : String(html);
    if (global.DOMPurify && typeof global.DOMPurify.sanitize === 'function') {
      return global.DOMPurify.sanitize(source);
    }
    return escapeHtml(source);
  }

  /**
   * 把一段富文本安全地写进元素。
   *
   * 有 DOMPurify → innerHTML（净化后的 HTML）；
   * 没有 → textContent（纯文本，绝不解释成标记）。
   *
   * @param {Element|null} element 目标元素
   * @param {*} html 待写入的富文本
   */
  function setSafeHtml(element, html) {
    if (!element) return;
    var source = html === null || html === undefined ? '' : String(html);
    if (global.DOMPurify && typeof global.DOMPurify.sanitize === 'function') {
      element.innerHTML = global.DOMPurify.sanitize(source);
      return;
    }
    element.textContent = source;
  }

  global.SafeHtml = {
    escapeHtml: escapeHtml,
    escapeAttr: escapeHtml,
    safeImageUrl: safeImageUrl,
    safeCssUrl: safeCssUrl,
    safeHref: safeHref,
    sanitizeHtml: sanitizeHtml,
    setSafeHtml: setSafeHtml
  };
})(window);
