// 公开端主题：拉取 /api/settings.siteTheme，设到 <html data-theme>，每 30s 轮询
// 依赖：/api/settings 公开端点
(function () {
  'use strict';

  function applyTheme(theme) {
    if (!theme) return;
    if (document.documentElement.getAttribute('data-theme') !== theme) {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  async function pull() {
    try {
      const res = await fetch('/api/settings', { credentials: 'omit', cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      applyTheme(data.siteTheme);
    } catch (e) {
      // 静默失败：公开端主题非关键
    }
  }

  pull();
  setInterval(pull, 30000);
})();
