// 公开页 header 登录态统一处理
// 依赖：/api/auth/me + /api/user/logout
// 登录按钮在同一元素上切换：未登录显示「登录」(/login)，已登录显示「个人中心」(/user-center)
(function () {
  const elLogin = document.getElementById('header-login');
  const elLogout = document.getElementById('header-logout');
  const elAdmin = document.getElementById('header-admin');

  function showLogin() {
    if (elLogin) {
      elLogin.style.display = 'inline-block';
      elLogin.textContent = '登录';
      elLogin.setAttribute('href', '/login');
    }
    if (elLogout) elLogout.style.display = 'none';
    if (elAdmin) elAdmin.style.display = 'none';
  }

  function showUser(data) {
    if (elLogin) {
      elLogin.style.display = 'inline-block';
      elLogin.textContent = '个人中心';
      elLogin.setAttribute('href', '/user-center');
    }
    if (elLogout) elLogout.style.display = 'inline-block';
    if (elAdmin && data && data.isAdmin) elAdmin.style.display = 'inline-block';
  }

  async function check() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (!res.ok) { showLogin(); return; }
      const data = await res.json();
      if (data.loggedIn) showUser(data); else showLogin();
    } catch (e) {
      console.warn('[header-auth] fetch failed, default to login:', e);
      showLogin();
    }
  }

  function logout() {
    fetch('/api/user/logout', { method: 'POST', credentials: 'include' })
      .then(() => { window.location.href = '/'; })
      .catch(e => console.error('[header-auth] logout failed:', e));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      check();
      setTimeout(check, 30000);
    });
  } else {
    check();
    setTimeout(check, 30000);
  }

  window.headerLogout = logout;
})();