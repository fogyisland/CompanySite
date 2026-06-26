/* ========================================
   TOAST - 页面内提示
   替换 alert()，避免被浏览器/扩展拦截
   暴露 window.Toast.success/info/warn/error(msg)
   ======================================== */

(function () {
  'use strict';

  let container = null;
  const queue = [];

  function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = [
      'position:fixed', 'top:20px', 'right:20px', 'z-index:99999',
      'display:flex', 'flex-direction:column', 'gap:10px',
      'pointer-events:none', 'max-width:380px'
    ].join(';');
    document.body.appendChild(container);
    return container;
  }

  function show(msg, type) {
    if (!msg) return;
    msg = String(msg);
    const c = ensureContainer();
    const node = document.createElement('div');
    node.className = 'toast-item toast-' + type;
    const colors = {
      success: { bg: '#10b981', fg: '#fff', icon: '✓' },
      info:    { bg: '#0969da', fg: '#fff', icon: 'ℹ' },
      warn:    { bg: '#f59e0b', fg: '#fff', icon: '!' },
      error:   { bg: '#ef4444', fg: '#fff', icon: '✕' }
    };
    const c2 = colors[type] || colors.info;
    node.style.cssText = [
      'background:' + c2.bg, 'color:' + c2.fg,
      'padding:12px 16px', 'border-radius:8px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.15)',
      'font-size:14px', 'line-height:1.5',
      'display:flex', 'align-items:flex-start', 'gap:10px',
      'pointer-events:auto', 'cursor:pointer',
      'animation:toastSlideIn 0.25s ease-out',
      'word-break:break-word'
    ].join(';');
    const icon = document.createElement('span');
    icon.style.cssText = 'font-weight:700;font-size:16px;flex-shrink:0;line-height:1.4;';
    icon.textContent = c2.icon;
    const text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = msg;
    node.appendChild(icon);
    node.appendChild(text);
    node.addEventListener('click', () => dismiss(node));
    c.appendChild(node);
    setTimeout(() => dismiss(node), 4500);
  }

  function dismiss(node) {
    if (!node || !node.parentNode) return;
    node.style.transition = 'opacity 0.2s, transform 0.2s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(20px)';
    setTimeout(() => node.remove(), 220);
  }

  // 注入 keyframes（一次性）
  function ensureStyle() {
    if (document.getElementById('toast-style')) return;
    const s = document.createElement('style');
    s.id = 'toast-style';
    s.textContent = '@keyframes toastSlideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}';
    document.head.appendChild(s);
  }

  ensureStyle();

  window.Toast = {
    success: (m) => show(m, 'success'),
    info:    (m) => show(m, 'info'),
    warn:    (m) => show(m, 'warn'),
    error:   (m) => show(m, 'error')
  };
})();