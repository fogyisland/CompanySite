/* Admin Theme System — fetch settings on load, expose setters */
// Set defaults synchronously FIRST to prevent FOUC
document.documentElement.setAttribute('data-theme', 'b');
document.documentElement.setAttribute('data-mode', 'light');

(async function initAdminTheme() {
  try {
    const res = await fetch('/api/admin/settings', { credentials: 'include' });
    if (!res.ok) return;  // already set defaults above
    const settings = await res.json();
    document.documentElement.setAttribute('data-theme', settings.admin_theme || 'b');
    document.documentElement.setAttribute('data-mode', settings.admin_dark_mode === '1' ? 'dark' : 'light');
  } catch (e) {
    console.error('Admin theme init failed:', e);
  }
})();

async function setAdminTheme(theme) {
  if (!['b', 'c', 'd'].includes(theme)) {
    console.error('Invalid theme:', theme);
    return;
  }
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_theme: theme })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('主题切换失败: ' + (err.error || res.status));
      return;
    }
    document.documentElement.setAttribute('data-theme', theme);
    // Update selected state on theme cards if present
    document.querySelectorAll('.theme-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.theme === theme);
    });
  } catch (e) {
    console.error('setAdminTheme failed:', e);
    alert('主题切换失败');
  }
}

async function setAdminDarkMode(enabled) {
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_dark_mode: enabled ? '1' : '0' })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('明暗切换失败: ' + (err.error || res.status));
      return;
    }
    document.documentElement.setAttribute('data-mode', enabled ? 'dark' : 'light');
  } catch (e) {
    console.error('setAdminDarkMode failed:', e);
    alert('明暗切换失败');
  }
}
