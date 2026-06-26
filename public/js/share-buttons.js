/* ========================================
   SHARE BUTTONS - 详情页分享按钮逻辑
   暴露 window.ShareButtons.mount({url, title, container})
   ======================================== */

(function () {
  'use strict';

  // 平台图标 (inline SVG, currentColor 来自父按钮)
  const ICONS = {
    twitter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12S0 5.446 0 12.073c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
    linkedin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
    weibo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.31 8.17c-3.39.34-6.06 2.2-6.06 4.45 0 2.51 3.27 4.49 7.32 4.49 4.04 0 7.32-1.98 7.32-4.49 0-2.21-2.55-4.04-5.83-4.43-.05-.01-.1.01-.15.03-.21.07-.4.16-.55.28-.15.12-.25.27-.27.45-.02.18.04.36.18.5.14.14.33.23.55.25.04 0 .07.01.11.02 2.38.31 4.18 1.51 4.18 2.9 0 1.66-2.5 3.04-5.54 3.04-3.04 0-5.54-1.38-5.54-3.04 0-1.4 1.81-2.6 4.2-2.9.18-.02.35-.11.47-.25.12-.14.18-.32.16-.5-.02-.18-.12-.34-.27-.46-.15-.12-.34-.19-.55-.22-.05-.01-.1-.02-.16-.02zm.6 5.6c.14.35.04.78-.27 1.1-.43.45-1.13.65-1.78.49-.6-.15-.96-.6-.88-1.12.07-.5.55-.85 1.16-.85h.01c.07 0 .14 0 .21.02.5.08.93.32 1.16.65.13.18.18.39.13.6-.02.04-.04.07-.07.1l.33.01zm9.51-7.5c-.7-.78-1.7-1.18-2.81-1.16-.16 0-.31.07-.42.18-.11.11-.17.26-.17.42 0 .16.07.31.18.42.11.11.26.17.42.17.78-.02 1.43.25 1.89.77.45.51.69 1.22.69 2.01 0 .16.07.31.18.42.11.11.26.17.42.17.16 0 .31-.07.42-.18.11-.11.17-.26.17-.42-.01-1.13-.39-2.03-1.07-2.8zm-1.92 1.65c-.34-.39-.83-.59-1.39-.59-.16 0-.31.07-.42.18-.11.11-.17.26-.17.42 0 .16.07.31.18.42.11.11.26.17.42.17.27 0 .49.08.65.26.16.18.25.43.25.72 0 .16.07.31.18.42.11.11.26.17.42.17.16 0 .31-.07.42-.18.11-.11.17-.26.17-.42 0-.6-.23-1.16-.71-1.57z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
  };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  // 校验 URL 协议
  function safeUrl(url) {
    try {
      const u = new URL(url, window.location.href);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch { return null; }
  }

  function buildShareUrl(platform, url, title) {
    const enc = encodeURIComponent(url);
    const encTitle = encodeURIComponent(title || '');
    switch (platform) {
      case 'twitter': return `https://twitter.com/intent/tweet?url=${enc}&text=${encTitle}`;
      case 'facebook': return `https://www.facebook.com/sharer/sharer.php?u=${enc}`;
      case 'linkedin': return `https://www.linkedin.com/sharing/share-offsite/?url=${enc}`;
      case 'weibo':    return `https://service.weibo.com/share/share.php?url=${enc}&title=${encTitle}`;
      default: return '';
    }
  }

  function openWindow(url) {
    try {
      window.open(url, '_blank', 'noopener,noreferrer,width=600,height=520');
    } catch (e) {
      console.error('Share open failed:', e);
    }
  }

  // 复制到剪贴板，兼容 fallback
  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // fall through to textarea fallback
      }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      console.error('Copy fallback failed:', e);
      return false;
    }
  }

  function mount(opts) {
    if (!opts || !opts.container) {
      console.error('ShareButtons.mount: container is required');
      return;
    }
    const url = safeUrl(opts.url || window.location.href);
    if (!url) {
      console.warn('ShareButtons.mount: invalid URL, skip render');
      return;
    }
    const title = String(opts.title || document.title || '');

    const wrap = el('div', { class: 'share-buttons', role: 'group', 'aria-label': '分享到社交平台' });
    wrap.appendChild(el('span', { class: 'share-buttons-label', text: '分享到：' }));

    const platforms = [
      { id: 'twitter',  cls: 'share-btn-twitter',  title: '分享到 Twitter' },
      { id: 'facebook', cls: 'share-btn-facebook', title: '分享到 Facebook' },
      { id: 'linkedin', cls: 'share-btn-linkedin', title: '分享到 LinkedIn' },
      { id: 'weibo',    cls: 'share-btn-weibo',    title: '分享到微博' }
    ];

    platforms.forEach(p => {
      const a = el('a', {
        class: 'share-btn ' + p.cls,
        href: buildShareUrl(p.id, url, title),
        title: p.title,
        'aria-label': p.title,
        target: '_blank',
        rel: 'noopener noreferrer',
        html: ICONS[p.id]
      });
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openWindow(a.href);
      });
      wrap.appendChild(a);
    });

    // 复制按钮
    const copyBtn = el('button', {
      type: 'button',
      class: 'share-btn share-btn-copy',
      title: '复制链接',
      'aria-label': '复制链接',
      html: ICONS.copy
    });
    let resetTimer = null;
    copyBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(url);
      if (!ok) return;
      copyBtn.classList.add('is-success');
      copyBtn.innerHTML = ICONS.check;
      copyBtn.setAttribute('title', '已复制');
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyBtn.classList.remove('is-success');
        copyBtn.innerHTML = ICONS.copy;
        copyBtn.setAttribute('title', '复制链接');
      }, 2000);
    });
    wrap.appendChild(copyBtn);

    opts.container.innerHTML = '';
    opts.container.appendChild(wrap);
  }

  window.ShareButtons = { mount: mount };
})();