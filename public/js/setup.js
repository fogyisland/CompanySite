/**
 * 安装 / 初始化向导的前端逻辑。
 *
 * 设计要点：
 *   1. 安装令牌只存在 sessionStorage，并放在 X-Setup-Token 请求头里 ——
 *      不写 Cookie，也不混进会被日志记录的请求体。
 *   2. 所有请求都走 apiRequest()，统一带令牌、统一解析错误文案。
 *   3. 任何一步失败都停在当前步，并把服务端返回的中文原因直接显示出来，
 *      不做「静默失败」。
 */
(function () {
  'use strict';

  const TOKEN_STORAGE_KEY = 'booming_setup_token';
  const TOTAL_STEPS = 5;

  let currentStep = 1;
  let setupState = null;

  // ------------------------------------------------------------------ 工具
  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function showAlert(message, kind) {
    const element = byId('setup-alert');
    element.textContent = message;
    element.className = 'setup-alert ' + (kind || 'info');
    element.hidden = false;
  }

  function hideAlert() {
    const element = byId('setup-alert');
    element.hidden = true;
    element.textContent = '';
  }

  /** 按钮进入/退出忙碌态 */
  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
      button.textContent = busyText || '处理中...';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.idleText || button.textContent;
      button.disabled = false;
    }
  }

  function goToStep(step) {
    currentStep = step;
    for (let index = 1; index <= TOTAL_STEPS; index += 1) {
      const panel = byId('panel-' + index);
      if (panel) panel.hidden = (index !== step);
      const item = document.querySelector('#setup-steps li[data-step="' + index + '"]');
      if (!item) continue;
      item.classList.toggle('active', index === step);
      item.classList.toggle('done', index < step);
    }
    hideAlert();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ------------------------------------------------------------------ 令牌
  function getToken() {
    try {
      return sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
    } catch (error) {
      return '';
    }
  }

  function setToken(value) {
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    } catch (error) {
      // 隐私模式下 sessionStorage 可能不可写 —— 令牌退化为只存在于内存
    }
  }

  function clearToken() {
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (error) {
      /* 忽略 */
    }
  }

  // ------------------------------------------------------------------ 请求
  async function apiRequest(path, options) {
    const settings = Object.assign({ credentials: 'include' }, options || {});
    const headers = Object.assign({}, settings.headers || {});
    headers['X-Setup-Token'] = getToken();
    if (settings.body !== undefined && typeof settings.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      settings.body = JSON.stringify(settings.body);
    }
    settings.headers = headers;

    const response = await fetch(path, settings);
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const message = (data && (data.message || data.error)) || ('请求失败（HTTP ' + response.status + '）');
      const failure = new Error(message);
      failure.code = data && data.error;
      failure.status = response.status;
      throw failure;
    }
    return data || {};
  }

  // ------------------------------------------------------------------ 步骤 1
  async function handleVerifyToken() {
    const input = byId('setup-token');
    const value = input.value.trim();
    if (!value) {
      showAlert('请输入安装令牌', 'error');
      return;
    }

    const button = byId('btn-verify-token');
    setBusy(button, true, '校验中...');
    // 先写入 sessionStorage：后续所有请求都通过 X-Setup-Token 头携带令牌，
    // 令牌不会出现在会被服务器记录的请求体里。
    setToken(value);
    try {
      const data = await apiRequest('/api/setup/verify-token', {
        method: 'POST',
        body: {}
      });
      input.value = '';
      setupState = data.state || null;
      applyDbConfig(setupState);
      renderSchemaSummary(setupState);
      goToStep(2);
    } catch (error) {
      clearToken();
      if (error.code === 'ALREADY_INSTALLED') {
        showAlert('站点已完成安装，正在跳转到登录页…', 'info');
        window.setTimeout(function () {
          window.location.href = '/login';
        }, 1200);
        return;
      }
      showAlert(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  // ------------------------------------------------------------------ 步骤 2
  function applyDbConfig(state) {
    if (!state || !state.dbConfig || !state.dbConfig.mysql) return;
    const mysql = state.dbConfig.mysql;

    byId('db-host').value = mysql.host || '';
    byId('db-port').value = mysql.port || 3306;
    byId('db-user').value = mysql.user || '';
    byId('db-database').value = mysql.database || '';
    // 密码永远不回显；用户已经填了的新密码也不该被状态刷新冲掉
    if (!byId('db-password').value) {
      byId('db-password').placeholder = mysql.hasPassword ? '已配置（留空则保持不变）' : '尚未配置';
    }

    const source = state.configSource || 'default';
    const labels = {
      env: '来自 .env（唯一事实来源）',
      file: '来自遗留的 data/db-config.json',
      default: '使用内置默认值'
    };
    const badge = byId('config-source-badge');
    badge.className = 'source-badge ' + source;
    badge.textContent = labels[source] || source;

    const note = byId('config-source-note');
    const notes = [];

    // 数据库当前不可用（连不上，或连上了但账号认证不过）——
    // 服务是以降级模式跑的，这时候「改连接配置」正是要干的事
    if (state.dbUnreachable === true) {
      notes.push('数据库当前不可用（连不上，或账号/密码不对），服务以降级模式运行，'
        + '依赖数据库的功能都返回 503。'
        + '请在这里填好连接信息并先点「测试连接」，通了之后再点「写入 .env 并继续」。');
    }

    if (source === 'env') {
      // .env 就是向导的产物 —— 这里保存会直接改写它，不再有「改了不生效」的锁
      notes.push('数据库连接参数保存在 .env 里（由本向导生成）。在这里点「写入 .env 并继续」'
        + '会改写 .env 中的 DB_* 并当场切换连接池；旧的 .env 会备份成 .env.bak。'
        + '会话密钥与 session 存储池在启动时绑定，完成后需要重启一次服务。');
    } else if (source === 'file') {
      notes.push('当前连接参数来自遗留的 data/db-config.json。点「写入 .env 并继续」后会以 .env 为准'
        + '（唯一事实来源），旧的 json 文件会同步一份，不再两份各说各话。');
    }

    if (notes.length) {
      note.hidden = false;
      note.className = 'setup-alert warning';
      note.textContent = notes.join(' ');
    } else {
      note.hidden = true;
    }
  }

  function collectDbConfig() {
    return {
      type: 'mysql',
      mysql: {
        host: byId('db-host').value.trim(),
        port: Number(byId('db-port').value.trim()) || 3306,
        user: byId('db-user').value.trim(),
        password: byId('db-password').value,
        database: byId('db-database').value.trim()
      }
    };
  }

  /**
   * 重新拉一次服务端状态并刷新界面。
   * 服务端状态是唯一权威 —— 保存数据库配置后连接池会切换，
   * 客户端缓存的表清单立刻就过期了。
   */
  async function refreshState() {
    try {
      const data = await apiRequest('/api/setup/status', { method: 'GET' });
      setupState = data.state || setupState;
      applyDbConfig(setupState);
      renderSchemaSummary(setupState);
      return setupState;
    } catch (error) {
      return setupState;
    }
  }

  async function handleTestDb() {
    const button = byId('btn-test-db');
    setBusy(button, true, '测试中...');
    try {
      const data = await apiRequest('/api/setup/test-db', {
        method: 'POST',
        body: collectDbConfig()
      });
      const version = data.version ? ' ' + data.version : '';
      showAlert('连接成功' + version + '（数据库 ' + (data.database || '-') + '）', 'success');
    } catch (error) {
      showAlert(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  async function handleSaveDb() {
    const button = byId('btn-save-db');
    setBusy(button, true, '写入 .env 中...');
    try {
      const data = await apiRequest('/api/setup/save-db-config', {
        method: 'POST',
        body: collectDbConfig()
      });
      goToStep(3);
      await refreshState();
      showAlert((data.message || '配置已写入 .env')
        + '。连接池已当场切换，最后一步会提示你重启服务。', 'success');
    } catch (error) {
      showAlert(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  // ------------------------------------------------------------------ 步骤 3
  function renderSchemaSummary(state) {
    const container = byId('schema-summary');
    if (!container) return;
    const required = (state && state.requiredTables) || [];
    if (!required.length) {
      container.innerHTML = '';
      return;
    }
    const missing = (state && state.missingTables) || [];
    const rows = required.map(function (name) {
      const ready = missing.indexOf(name) === -1;
      return '<tr><td>' + escapeHtml(name) + '</td><td><span class="tag ' + (ready ? 'ok' : 'missing') + '">'
        + (ready ? '已就绪' : '待创建') + '</span></td></tr>';
    }).join('');
    container.innerHTML = '<div class="setup-table-wrap"><table class="setup-table"><thead><tr>'
      + '<th>数据表</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderInitResult(tables) {
    const container = byId('init-result');
    if (!container) return;
    if (!tables || !tables.length) {
      container.innerHTML = '';
      return;
    }
    // status 可能是 ok / missing / error —— 如实显示，不能一律报「已就绪」
    const labels = { ok: ['ok', '已就绪'], missing: ['missing', '待创建'], error: ['missing', '检查失败'] };
    const rows = tables.map(function (row) {
      const entry = labels[row.status] || labels.ok;
      return '<tr><td>' + escapeHtml(row.table) + '</td><td class="num">' + Number(row.count || 0)
        + '</td><td><span class="tag ' + entry[0] + '">' + entry[1] + '</span></td></tr>';
    }).join('');
    container.innerHTML = '<div class="setup-table-wrap"><table class="setup-table"><thead><tr>'
      + '<th>数据表</th><th>行数</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  async function handleInitDb() {
    const button = byId('btn-init-db');
    setBusy(button, true, '初始化中...');
    try {
      const data = await apiRequest('/api/setup/init-db', { method: 'POST', body: {} });
      setupState = data.state || setupState;
      renderSchemaSummary(setupState);
      renderInitResult(data.tables || []);
      byId('btn-next-admin').hidden = false;
      byId('btn-init-db').textContent = '重新初始化';
      showAlert(data.message || '数据库初始化完成', 'success');
    } catch (error) {
      showAlert(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  /**
   * 进入「创建管理员」之前，向服务端确认表结构确实齐了 ——
   * 服务端状态是唯一权威，客户端不自己判断。
   */
  async function handleNextAdmin() {
    const button = byId('btn-next-admin');
    setBusy(button, true, '检查中...');
    try {
      const data = await apiRequest('/api/setup/status', { method: 'GET' });
      const state = data.state || {};
      setupState = state;
      renderSchemaSummary(state);
      const missing = state.missingTables || [];
      if (missing.length) {
        showAlert('表结构还不完整，缺少：' + missing.join('、') + '。请先完成初始化。', 'error');
        return;
      }
      goToStep(4);
    } catch (error) {
      showAlert(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  // ------------------------------------------------------------------ 步骤 4
  async function handleCreateAdmin() {
    const username = byId('admin-username').value.trim();
    const password = byId('admin-password').value;
    const passwordConfirm = byId('admin-password-confirm').value;
    const email = byId('admin-email').value.trim();

    if (!username) {
      showAlert('请填写管理员用户名', 'error');
      return;
    }
    if (password !== passwordConfirm) {
      showAlert('两次输入的密码不一致', 'error');
      return;
    }

    const button = byId('btn-create-admin');
    setBusy(button, true, '创建中...');
    try {
      const data = await apiRequest('/api/setup/create-admin', {
        method: 'POST',
        body: { username, password, email }
      });
      // 令牌已被服务端销毁，本地也要清掉
      clearToken();
      byId('admin-password').value = '';
      byId('admin-password-confirm').value = '';
      byId('setup-token').value = '';
      showAlert(data.message || '管理员创建成功', 'success');
      goToStep(5);
    } catch (error) {
      if (error.code === 'ALREADY_INSTALLED') {
        showAlert('站点已完成安装，正在跳转到登录页…', 'info');
        window.setTimeout(function () {
          window.location.href = '/login';
        }, 1200);
        return;
      }
      showAlert(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  // ------------------------------------------------------------------ 事件绑定
  function bindEvents() {
    byId('btn-verify-token').addEventListener('click', handleVerifyToken);
    byId('btn-test-db').addEventListener('click', handleTestDb);
    byId('btn-save-db').addEventListener('click', handleSaveDb);
    byId('btn-next-db').addEventListener('click', function () {
      goToStep(3);
      refreshState();
    });
    byId('btn-back-db').addEventListener('click', function () {
      goToStep(2);
    });
    byId('btn-init-db').addEventListener('click', handleInitDb);
    byId('btn-next-admin').addEventListener('click', handleNextAdmin);
    byId('btn-back-init').addEventListener('click', function () {
      goToStep(3);
    });
    byId('btn-create-admin').addEventListener('click', handleCreateAdmin);

    byId('setup-token').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') handleVerifyToken();
    });
    byId('admin-password-confirm').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') handleCreateAdmin();
    });
  }

  /**
   * 页面加载：若 sessionStorage 里还留着令牌（刷新页面），
   * 自动重校验并恢复到第 2 步，避免用户重新粘贴令牌。
   */
  async function resumeIfTokenPresent() {
    const token = getToken();
    if (!token) return;
    try {
      const data = await apiRequest('/api/setup/verify-token', {
        method: 'POST',
        body: {}
      });
      setupState = data.state || null;
      applyDbConfig(setupState);
      renderSchemaSummary(setupState);
      goToStep(2);
    } catch (error) {
      clearToken();
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    resumeIfTokenPresent();
  });
})();
