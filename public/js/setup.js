/**
 * 安装 / 初始化向导的前端逻辑。
 *
 * 设计要点：
 *   1. 安装令牌只存在 sessionStorage，并放在 X-Setup-Token 请求头里 ——
 *      不写 Cookie，也不混进会被日志记录的请求体。
 *   2. 所有请求都走 apiRequest()，统一带令牌、统一解析错误文案。
 *   3. 任何一步失败都停在当前步，并把服务端返回的中文原因直接显示出来，
 *      不做「静默失败」。
 *   4. 三页结构：数据库 → 管理员 → 创建并完成。
 *      最后一步只发一次请求（/api/setup/complete-install），
 *      由服务端原子地做完「建库 → 写 .env → 建表 → 建管理员 → 销毁令牌」。
 *      客户端不再拆成多次调用 —— 那样会留下「配置写了但没装完」的中间态，
 *      而安装状态的判定只看管理员是否存在，中间态等于把闸门重新打开。
 */
(function () {
  'use strict';

  const TOKEN_STORAGE_KEY = 'booming_setup_token';
  const TOTAL_STEPS = 4;

  /** 库名合法字符集 —— 必须与服务端一致，否则最后一步才报错就太晚了 */
  const DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  const MAX_DATABASE_NAME_LENGTH = 64;
  /** 服务端 lib/setup-policy.js 的同一套规则 */
  const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

  // ------------------------------------------------------------------ 表单取值
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

  function collectAdminInput() {
    return {
      username: byId('admin-username').value.trim(),
      password: byId('admin-password').value,
      email: byId('admin-email').value.trim()
    };
  }

  /**
   * 数据库表单的前端校验。
   * 服务端还会再校验一遍 —— 这里是**为了早失败**：库名规则要在填完就提示，
   * 不能等到最后一步建库时才报「数据库名不合法」。
   * @returns {string|null} 出错原因；null 表示通过
   */
  function validateDbForm() {
    const config = collectDbConfig().mysql;
    if (!config.host) return '请填写数据库主机地址';
    if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) return '端口必须是 1~65535 之间的整数';
    if (!config.user) return '请填写数据库用户名';
    if (!config.database) return '请填写数据库名';
    if (config.database.length > MAX_DATABASE_NAME_LENGTH) {
      return '数据库名不能超过 ' + MAX_DATABASE_NAME_LENGTH + ' 个字符';
    }
    if (!DATABASE_NAME_PATTERN.test(config.database)) {
      return '数据库名只能包含字母、数字、下划线与连字符，且必须以字母或下划线开头';
    }
    return null;
  }

  /**
   * 管理员表单的前端校验（与服务端 lib/setup-policy.js 同一套规则）。
   * @returns {string|null} 出错原因；null 表示通过
   */
  function validateAdminForm() {
    const admin = collectAdminInput();
    if (!ADMIN_USERNAME_PATTERN.test(admin.username)) {
      return '用户名需为 3~32 位，可用字母、数字、下划线、点、连字符';
    }
    if (admin.password.length < 8) return '密码至少 8 位';
    if (Buffer.byteLength(admin.password, 'utf8') > 72) return '密码过长（最多 72 字节）';
    if (!/[A-Za-z]/.test(admin.password)) return '密码必须同时包含字母和数字';
    if (!/\d/.test(admin.password)) return '密码必须同时包含字母和数字';
    if (admin.password !== byId('admin-password-confirm').value) return '两次输入的密码不一致';
    if (admin.email && !EMAIL_PATTERN.test(admin.email)) return '邮箱格式不正确';
    return null;
  }

  // ------------------------------------------------------------------ 令牌页
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

  // ------------------------------------------------------------------ 第 1 页：数据库
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

    const note = byId('config-source-note');
    const notes = [];

    // 数据库当前不可用（连不上，或连上了但账号认证不过）——
    // 服务是以降级模式跑的，这时候「改连接配置」正是要干的事
    if (state.dbUnreachable === true) {
      notes.push('数据库当前不可用（连不上，或账号/密码不对），服务正以降级模式运行，'
        + '依赖数据库的功能都返回 503。请在这里填好连接信息并先点「测试连接」。');
    }

    if (state.configSource === 'env') {
      // .env 就是向导的产物 —— 这里填的值最后一步会直接改写它
      notes.push('数据库连接参数已保存在 .env 里（由本向导生成）。'
        + '最后一步会按这里的值重写 .env 中的 DB_* 并当场切换连接池；'
        + '旧的 .env 会备份成 .env.bak。会话密钥与 session 存储池在启动时绑定，完成后需要重启一次服务。');
    } else {
      notes.push('本站尚未配置过数据库连接参数。请填写下面的信息，'
        + '最后一步会把它们写进 .env —— 数据库连接参数从此只有这一个存放处。');
    }

    if (notes.length) {
      note.hidden = false;
      note.className = 'setup-alert warning';
      note.textContent = notes.join(' ');
    } else {
      note.hidden = true;
    }
  }

  /**
   * 测一次服务器连通性。
   * @returns {Promise<object|null>} 成功返回服务端数据；失败返回 null（错误已显示）
   */
  async function runConnectionTest() {
    const invalid = validateDbForm();
    if (invalid) {
      showAlert(invalid, 'error');
      return null;
    }
    try {
      return await apiRequest('/api/setup/test-db', {
        method: 'POST',
        body: collectDbConfig()
      });
    } catch (error) {
      showAlert(error.message, 'error');
      return null;
    }
  }

  async function handleTestDb() {
    const button = byId('btn-test-db');
    setBusy(button, true, '测试中...');
    try {
      const data = await runConnectionTest();
      if (!data) return;
      const version = data.version ? ' ' + data.version : '';
      const exists = data.databaseExists
        ? '（数据库 ' + (data.database || '-') + ' 已存在，将直接使用）'
        : '（数据库 ' + (data.database || '-') + ' 不存在，最后一步会创建它）';
      showAlert('连接成功' + version + exists, 'success');
    } finally {
      setBusy(button, false);
    }
  }

  async function handleNextDb() {
    const button = byId('btn-next-db');
    setBusy(button, true, '测试中...');
    try {
      // 「下一步」会先测一次 —— 不必让用户自己记得点「测试连接」
      const data = await runConnectionTest();
      if (!data) return;
      goToStep(3);
    } finally {
      setBusy(button, false);
    }
  }

  // ------------------------------------------------------------------ 第 2 页：管理员
  function handleNextAdmin() {
    const invalid = validateAdminForm();
    if (invalid) {
      showAlert(invalid, 'error');
      return;
    }
    renderInstallSummary();
    goToStep(4);
  }

  /** 第 3 页的汇总 —— 显示即将落地的内容，避免「点了才知道填错了」 */
  function renderInstallSummary() {
    const container = byId('install-summary');
    if (!container) return;
    const dbConfig = collectDbConfig().mysql;
    const admin = collectAdminInput();

    const rows = [
      ['数据库主机', dbConfig.host + ':' + dbConfig.port],
      ['数据库名', dbConfig.database],
      ['数据库用户', dbConfig.user],
      ['管理员账号', admin.username],
      ['管理员邮箱', admin.email || '（未填写）']
    ];

    const body = rows.map(function (row) {
      return '<tr><td>' + escapeHtml(row[0]) + '</td><td>' + escapeHtml(row[1]) + '</td></tr>';
    }).join('');

    container.innerHTML = '<div class="setup-table-wrap"><table class="setup-table"><thead><tr>'
      + '<th>项目</th><th>值</th></tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  // ------------------------------------------------------------------ 第 3 页：完成安装
  async function handleCompleteInstall() {
    const dbInvalid = validateDbForm();
    if (dbInvalid) {
      showAlert(dbInvalid, 'error');
      goToStep(2);
      return;
    }
    const adminInvalid = validateAdminForm();
    if (adminInvalid) {
      showAlert(adminInvalid, 'error');
      goToStep(3);
      return;
    }

    const button = byId('btn-complete-install');
    setBusy(button, true, '初始化中...');
    try {
      const data = await apiRequest('/api/setup/complete-install', {
        method: 'POST',
        body: {
          db: collectDbConfig(),
          admin: collectAdminInput()
        }
      });
      // 令牌已被服务端销毁，本地也要清掉
      clearToken();
      byId('admin-password').value = '';
      byId('admin-password-confirm').value = '';
      byId('setup-token').value = '';

      byId('install-form-part').hidden = true;
      byId('install-done').hidden = false;
      goToStep(4);
      showAlert(
        (data.message || '初始化完成')
        + (data.databaseCreated ? '（数据库 ' + data.database + ' 已创建）' : ''),
        'success'
      );
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
    byId('btn-next-db').addEventListener('click', handleNextDb);
    byId('btn-back-db').addEventListener('click', function () {
      goToStep(2);
    });
    byId('btn-next-admin').addEventListener('click', handleNextAdmin);
    byId('btn-back-admin').addEventListener('click', function () {
      goToStep(3);
    });
    byId('btn-complete-install').addEventListener('click', handleCompleteInstall);

    byId('setup-token').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') handleVerifyToken();
    });
    byId('admin-password-confirm').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') handleNextAdmin();
    });
  }

  /**
   * 页面加载：若 sessionStorage 里还留着令牌（刷新页面），
   * 自动重校验并恢复到第 1 页，避免用户重新粘贴令牌。
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
