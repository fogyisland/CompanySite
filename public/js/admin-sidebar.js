// public/js/admin-sidebar.js
// Admin 侧栏企业级组件：DOM 注入 + 搜索 + 折叠 + submenu + 当前页高亮 + 用户 footer
// 依赖：window.LucideIcons (lucide-icons.js), /api/auth/me
// CSS：public/css/admin-sidebar.css（2026-06-21 提取，原本 mount() 注入 <style> 改为静态 <link>，避免"重建"感）
(function () {
  'use strict';

  const { icon } = window.LucideIcons;

  // ---- Nav 配置（11 项顶级 + submenu） ----
  const NAV = [
    {
      group: '运营',
      items: [
        { icon: 'package', label: '产品管理', href: '/admin-product' },
        { icon: 'book-open', label: '产品文档', href: '/admin-product-docs' },
        { icon: 'receipt', label: '订单管理', href: '/admin-orders' },
        { icon: 'download', label: '安装管理', href: '/admin-installations' },
        { icon: 'key', label: '激活管理', href: '/admin-activations' }
      ]
    },
    {
      group: '客户',
      items: [
        { icon: 'mail', label: '邮件订阅', href: '/admin-newsletter' },
        { icon: 'headphones', label: '技术支持', href: '/admin-support' },
        { icon: 'help-circle', label: 'FAQ', href: '/admin-faq' },
        { icon: 'contact', label: 'CardDAV', href: '/admin-carddav' }
      ]
    },
    {
      group: '系统',
      items: [
        {
          icon: 'bar-chart-3',
          label: '系统日志',
          submenu: [
            { label: '登录日志', href: '/admin-log-login' },
            { label: '操作日志', href: '/admin-log-operation' },
            { label: '注册日志', href: '/admin-log-registration' },
            { label: '激活日志', href: '/admin-log-activation' },
            { label: '数据遥测', href: '/admin-telemetry' }
          ]
        },
        {
          icon: 'settings',
          label: '系统设置',
          submenu: [
            { label: '网站设置', href: '/admin-settings' },
            { label: '数据库', href: '/admin-dbsettings' },
            { label: '安全', href: '/admin-security' },
            { label: '邮件', href: '/admin-email' },
            { label: 'AI设置', href: '/admin-ai' },
            { label: 'API', href: '/admin-api' }
          ]
        }
      ]
    }
  ];

  const CURRENT_PATH = window.location.pathname;
  const STORAGE_KEY = 'admin_sidebar_state_v1';

  // ---- 工具 ----
  function hashColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    const palette = ['#0969da', '#1a7f37', '#9a6700', '#cf222e', '#8250df', '#bf3989'];
    return palette[Math.abs(h) % palette.length];
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function initials(email) {
    if (!email) return '?';
    const local = email.split('@')[0];
    if (!local) return '?';
    // 取首字符；若包含 . 或 _ 则取首两段首字符
    const parts = local.split(/[._-]/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return local[0].toUpperCase();
  }

  // ---- 持久化（搜索 + submenu + 滚动） ----
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { search: '', openSubmenu: '', scrollTop: 0 };
      const s = JSON.parse(raw);
      return {
        search: typeof s.search === 'string' ? s.search : '',
        openSubmenu: typeof s.openSubmenu === 'string' ? s.openSubmenu : '',
        scrollTop: Number.isFinite(s.scrollTop) ? s.scrollTop : 0
      };
    } catch { return { search: '', openSubmenu: '', scrollTop: 0 }; }
  }
  function saveState(patch) {
    try {
      const cur = loadState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, ...patch }));
    } catch {}
  }

  // ---- 渲染 ----
  function renderSidebar() {
    return `
      <div class="sb-header">
        <a href="/admin-product" class="sb-logo">
          <span class="sb-logo-icon" id="header-logo-icon">SV</span>
          <span class="sb-logo-text" id="header-logo-text">管理后台</span>
        </a>
        <button type="button" class="sb-collapse-btn" aria-label="折叠侧栏" title="折叠侧栏 (Ctrl+B)">${icon('chevron-left')}</button>
      </div>
      <div class="sb-search">
        <label class="sb-search-wrap">
          ${icon('search')}
          <input type="text" class="sb-search-input" placeholder="搜索菜单..." aria-label="搜索菜单">
          <span class="sb-search-kbd">/</span>
        </label>
      </div>
      <nav class="sb-nav">
        ${NAV.map(group => `
          <div class="sb-group">
            <div class="sb-group-label">${escapeHtml(group.group)}</div>
            <ul class="sb-list">
              ${group.items.map(item => renderItem(item)).join('')}
            </ul>
          </div>
        `).join('')}
      </nav>
      <div class="sb-footer">
        <div class="sb-avatar sb-skeleton" id="sb-avatar">&nbsp;</div>
        <div class="sb-user">
          <div class="sb-user-email sb-skeleton" id="sb-user-email">&nbsp;</div>
          <div class="sb-user-actions">
            <a href="/logout">注销</a>
          </div>
        </div>
        <button type="button" class="sb-logout-btn" aria-label="注销" title="注销">${icon('log-out')}</button>
      </div>
    `;
  }

  function renderItem(item) {
    if (item.submenu) {
      const popoverHtml = `<ul class="sb-popover-list">${item.submenu.map(s => `<li><a href="${escapeHtml(s.href)}">${escapeHtml(s.label)}</a></li>`).join('')}</ul>`;
      // data-popover 用于折叠态 hover popover（CSS ::after）
      return `
        <li>
          <a href="#" class="sb-link sb-parent" data-popover="${escapeHtml(popoverHtml).replace(/"/g, '&quot;')}" data-label="${escapeHtml(item.label)}">
            ${icon(item.icon)}
            <span class="sb-label">${escapeHtml(item.label)}</span>
            <span class="sb-chevron">${icon('chevron-right')}</span>
          </a>
          <ul class="sb-submenu">
            ${item.submenu.map(s => `<li><a href="${escapeHtml(s.href)}" class="sb-link${CURRENT_PATH === s.href ? ' active' : ''}"><span class="sb-label">${escapeHtml(s.label)}</span></a></li>`).join('')}
          </ul>
        </li>
      `;
    }
    const isActive = CURRENT_PATH === item.href;
    return `<li><a href="${escapeHtml(item.href)}" class="sb-link${isActive ? ' active' : ''}">${icon(item.icon)}<span class="sb-label">${escapeHtml(item.label)}</span></a></li>`;
  }

  // ---- 行为绑定 ----
  function bindSubmenuToggles(root) {
    root.querySelectorAll('.sb-parent').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const li = link.closest('li');
        const submenu = li.querySelector('.sb-submenu');
        const isOpen = submenu.classList.contains('open');
        // 关闭所有同级
        li.parentElement.querySelectorAll(':scope > li > .sb-submenu.open').forEach(s => s.classList.remove('open'));
        li.parentElement.querySelectorAll(':scope > li > .sb-link.open').forEach(s => s.classList.remove('open'));
        if (!isOpen) {
          submenu.classList.add('open');
          link.classList.add('open');
          saveState({ openSubmenu: link.dataset.label || '' });
        } else {
          saveState({ openSubmenu: '' });
        }
      });
    });
  }

  function bindSearch(root) {
    const input = root.querySelector('.sb-search-input');
    if (!input) return;
    // 恢复搜索词
    const initial = loadState().search;
    if (initial) {
      input.value = initial;
      // 恢复过滤（下一帧，避免与 bindSearch 重复绑定时的初始空查询竞争）
      requestAnimationFrame(() => filterItems(root, initial.trim().toLowerCase()));
    }
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      saveState({ search: input.value });
      filterItems(root, q);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; saveState({ search: '' }); filterItems(root, ''); input.blur(); }
    });
    // 全局 / 快捷键
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/') return;
      if (document.body.classList.contains('sidebar-collapsed')) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      e.preventDefault();
      input.focus();
      input.select();
    });
  }

  function filterItems(root, q) {
    const groups = root.querySelectorAll('.sb-group');
    if (!q) {
      groups.forEach(g => g.classList.remove('sb-hidden'));
      root.querySelectorAll('.sb-list > li').forEach(li => li.classList.remove('sb-hidden'));
      root.querySelectorAll('.sb-group-label').forEach(l => l.classList.remove('sb-hidden'));
      return;
    }
    groups.forEach(group => {
      const label = group.querySelector('.sb-group-label');
      const items = group.querySelectorAll('.sb-list > li');
      let anyMatch = false;
      items.forEach(li => {
        const links = li.querySelectorAll('.sb-link');
        let match = false;
        links.forEach(l => {
          const text = (l.textContent || '').toLowerCase();
          if (text.includes(q)) match = true;
        });
        li.classList.toggle('sb-hidden', !match);
        if (match) {
          anyMatch = true;
          // 命中 parent 时自动展开 submenu
          const submenu = li.querySelector('.sb-submenu');
          if (submenu && !submenu.classList.contains('open')) {
            submenu.classList.add('open');
            const parent = li.querySelector('.sb-link.sb-parent');
            if (parent) parent.classList.add('open');
          }
        }
      });
      group.classList.toggle('sb-hidden', !anyMatch);
      if (label) label.classList.toggle('sb-hidden', !anyMatch);
    });
  }

  function bindCollapse(root) {
    const btn = root.querySelector('.sb-collapse-btn');
    if (!btn) return;
    // 初始状态
    let collapsed = false;
    try { collapsed = localStorage.getItem('admin_sidebar_collapsed') === '1'; } catch {}
    if (collapsed) document.body.classList.add('sidebar-collapsed');
    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      try { localStorage.setItem('admin_sidebar_collapsed', collapsed ? '1' : '0'); } catch {}
    });
    // 折叠态 hover parent 显示 popover
    const parents = root.querySelectorAll('.sb-link.sb-parent');
    parents.forEach(link => {
      link.addEventListener('mouseenter', () => {
        if (document.body.classList.contains('sidebar-collapsed')) {
          link.classList.add('has-popover-open');
        }
      });
      link.addEventListener('mouseleave', () => {
        link.classList.remove('has-popover-open');
      });
    });
  }

  // 恢复 submenu 展开状态（在 mount 末尾调用）
  function restoreOpenSubmenu(root) {
    const want = loadState().openSubmenu;
    if (!want) return;
    const link = Array.from(root.querySelectorAll('.sb-parent')).find(a => a.dataset.label === want);
    if (!link) return;
    const li = link.closest('li');
    const submenu = li && li.querySelector('.sb-submenu');
    if (submenu) { submenu.classList.add('open'); link.classList.add('open'); }
  }

  // 恢复 nav scrollTop（在 mount 末尾调用，需要 nav 已渲染）
  function restoreScroll(root) {
    const want = loadState().scrollTop;
    if (!want) return;
    const nav = root.querySelector('.sb-nav');
    if (nav) nav.scrollTop = want;
    // 监听 scroll，节流保存（200ms）
    let timer = null;
    nav && nav.addEventListener('scroll', () => {
      clearTimeout(timer);
      timer = setTimeout(() => saveState({ scrollTop: nav.scrollTop }), 200);
    });
  }

  async function loadUser() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (!res.ok) return;
      const user = await res.json();
      if (!user.loggedIn) return;
      const email = user.email || user.username || 'admin';
      const avatar = document.getElementById('sb-avatar');
      const emailEl = document.getElementById('sb-user-email');
      if (avatar) {
        avatar.classList.remove('sb-skeleton');
        avatar.textContent = initials(email);
        avatar.style.background = hashColor(email);
      }
      if (emailEl) {
        emailEl.classList.remove('sb-skeleton');
        emailEl.textContent = email;
      }
    } catch (e) {
      // fetch 失败时移除 skeleton class，避免永远闪烁
      document.getElementById('sb-avatar')?.classList.remove('sb-skeleton');
      document.getElementById('sb-user-email')?.classList.remove('sb-skeleton');
      console.warn('[admin-sidebar] failed to load user:', e);
    }
  }

  // ---- 入口 ----
  function mount() {
    // 找 .admin-layout
    const layout = document.querySelector('.admin-layout');
    if (!layout) {
      console.warn('[admin-sidebar] .admin-layout not found, sidebar not mounted');
      return;
    }

    // 创建 sidebar 并插入第一个子元素位置
    const aside = document.createElement('aside');
    aside.className = 'admin-sidebar';
    aside.setAttribute('aria-label', '主导航');
    aside.innerHTML = renderSidebar();
    layout.insertBefore(aside, layout.firstChild);

    // 绑定交互
    bindSubmenuToggles(aside);
    bindSearch(aside);
    bindCollapse(aside);
    restoreOpenSubmenu(aside);
    restoreScroll(aside);
    loadUser();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();