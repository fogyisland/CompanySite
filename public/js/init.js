/**
 * Init 向导的前端逻辑。
 *
 * 设计要点：
 *   1. 没有令牌 —— Init 令牌机制已整体移除。准入由服务端的初始化状态判定
 *      （.env 的 INITIALIZED 标志 + users 表的管理员账号）负责，
 *      站点一旦初始化完成，Init 接口就永久关闭。
 *   2. 所有请求都走 apiRequest()，统一解析错误文案；失败时把服务端返回的
 *      中文原因直接显示出来，不做「静默失败」。
 *   3. 四页结构：数据库 → 管理员 → 网站设定 → 执行初始化。
 *      最后一步只发一次请求（/api/init/complete-install），
 *      由服务端原子地做完「建库 → 写 .env → 建表 → 建管理员 → 写网站设定 →
 *      写 INITIALIZED=True」。客户端不再拆成多次调用 —— 那样会留下
 *      「配置写了但没装完」的中间态，而初始化状态的判定是双保险，
 *      中间态会被判成「未初始化」，等于把闸门重新打开。
 *   4. 第 4 页的「初始化过程」清单与服务端返回的 steps 一一对应 ——
 *      跑完哪几步、卡在哪一步，照着服务端说的显示，不用猜。
 */
(function () {
  'use strict';

  const TOTAL_STEPS = 4;

  /** 库名合法字符集 —— 必须与服务端一致，否则最后一步才报错就太晚了 */
  const DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  const MAX_DATABASE_NAME_LENGTH = 64;
  /** 服务端 lib/init-policy.js 的同一套规则 */
  const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const MAX_SITE_NAME_LENGTH = 255;
  /** Logo 上限与服务端 uploadLogo 的 limits.fileSize 一致（2MB） */
  const MAX_LOGO_SIZE = 2 * 1024 * 1024;
  /** 与服务端 lib/init-policy.js 的 DEFAULT_SITE_NAME 保持一致 */
  const DEFAULT_SITE_NAME = '博铭科技';

  /**
   * 初始化过程清单 —— 键与服务端 complete-install 返回的 steps[].key 对应。
   * 服务端只回「跑完了哪几步」，这里的文案负责把没跑的步骤也列出来。
   */
  const INSTALL_STEPS = [
    { key: 'connect', label: '测试数据库服务器连接' },
    { key: 'create-db', label: '创建数据库' },
    { key: 'write-env', label: '写入 .env 数据库连接参数' },
    { key: 'create-tables', label: '建立数据表并灌入默认数据' },
    { key: 'create-admin', label: '创建管理员账号' },
    { key: 'site-settings', label: '写入网站设定（名称与 Logo）' },
    { key: 'write-flag', label: '写入 INITIALIZED 完成标志' }
  ];

  let currentStep = 1;
  let initState = null;
  /** 已上传的 Logo 地址（服务端生成，形如 /uploads/logo.png）；空串表示不设 Logo */
  let uploadedLogo = '';

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
    const element = byId('init-alert');
    element.textContent = message;
    element.className = 'init-alert ' + (kind || 'info');
    element.hidden = false;
  }

  function hideAlert() {
    const element = byId('init-alert');
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
      const item = document.querySelector('#init-steps li[data-step="' + index + '"]');
      if (!item) continue;
      item.classList.toggle('active', index === step);
      item.classList.toggle('done', index < step);
    }
    hideAlert();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ------------------------------------------------------------------ 请求
  async function apiRequest(path, options) {
    const settings = Object.assign({ credentials: 'include' }, options || {});
    const headers = Object.assign({}, settings.headers || {});
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
      // 服务端的 steps / failedStep 一并带出来 —— 第 4 页要靠它渲染过程清单
      failure.data = data || {};
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

  function collectSiteSettings() {
    return {
      companyName: byId('site-name').value.trim(),
      logo: uploadedLogo
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
   * 管理员表单的前端校验（与服务端 lib/init-policy.js 同一套规则）。
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

  /**
   * 网站设定表单的前端校验。
   * @returns {string|null} 出错原因；null 表示通过
   */
  function validateSiteForm() {
    const site = collectSiteSettings();
    if (!site.companyName) return '请填写站点名称';
    if (site.companyName.length > MAX_SITE_NAME_LENGTH) {
      return '站点名称不能超过 ' + MAX_SITE_NAME_LENGTH + ' 个字符';
    }
    return null;
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

    // 判定链的两个条件分开显示 —— 运维看到「未初始化」时需要知道缺的是哪一头
    const hasAdmin = Number(state.adminCount) > 0;
    if (hasAdmin && state.initializedFlag !== true) {
      notes.push('数据库里已经有管理员账号，但 .env 里还没有 INITIALIZED=True —— '
        + '两个条件缺一不可，站点会被判定为「未初始化」。走完最后一步会把标志补上；'
        + '只想补标志的话，也可以直接在 .env 里加一行 INITIALIZED=True 后重启服务。');
    } else if (state.initializedFlag === true) {
      notes.push('.env 里已有 INITIALIZED=True —— 完成最后一步后，'
        + '「标志」与「管理员账号」两个条件同时成立，站点才算初始化完成。');
    }

    if (notes.length) {
      note.hidden = false;
      note.className = 'init-alert warning';
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
      return await apiRequest('/api/init/test-db', {
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
      goToStep(2);
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
    goToStep(3);
  }

  // ------------------------------------------------------------------ 第 3 页：网站设定
  /**
   * Logo 上传 —— 走 Init 专用的上传接口。
   *
   * 不能用后台那个 /api/upload-logo：它要登录态，而初始化时管理员还不存在。
   * 上传成功后服务端只回地址，落库由 complete-install 一次性完成。
   */
  async function handleLogoSelected(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    const status = byId('logo-status');
    if (!file) return;

    if (file.size > MAX_LOGO_SIZE) {
      uploadedLogo = '';
      status.textContent = '文件超过 2MB，请换一张小一点的图片';
      return;
    }

    status.textContent = '上传中...';
    const formData = new FormData();
    formData.append('logo', file);

    try {
      const response = await fetch('/api/init/upload-logo', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
      if (!response.ok) {
        throw new Error((data && (data.message || data.error)) || ('上传失败（HTTP ' + response.status + '）'));
      }
      uploadedLogo = (data && data.logo) || '';
      renderLogoPreview(uploadedLogo);
      status.textContent = '上传成功：' + uploadedLogo;
    } catch (error) {
      uploadedLogo = '';
      hideLogoPreview();
      status.textContent = error.message;
    }
  }

  function renderLogoPreview(logoPath) {
    const preview = byId('logo-preview');
    const image = byId('logo-preview-img');
    if (!preview || !image) return;
    if (!logoPath) {
      hideLogoPreview();
      return;
    }
    image.src = logoPath;
    preview.hidden = false;
  }

  function hideLogoPreview() {
    const preview = byId('logo-preview');
    const image = byId('logo-preview-img');
    if (preview) preview.hidden = true;
    if (image) image.removeAttribute('src');
  }

  function handleNextSite() {
    const invalid = validateSiteForm();
    if (invalid) {
      showAlert(invalid, 'error');
      return;
    }
    renderInstallSummary();
    renderInstallProgress([], null);
    goToStep(4);
  }

  // ------------------------------------------------------------------ 第 4 页：执行初始化
  /** 第 4 页的汇总 —— 显示即将落地的内容，避免「点了才知道填错了」 */
  function renderInstallSummary() {
    const container = byId('install-summary');
    if (!container) return;
    const dbConfig = collectDbConfig().mysql;
    const admin = collectAdminInput();
    const site = collectSiteSettings();

    const rows = [
      ['数据库主机', dbConfig.host + ':' + dbConfig.port],
      ['数据库名', dbConfig.database],
      ['数据库用户', dbConfig.user],
      ['管理员账号', admin.username],
      ['管理员邮箱', admin.email || '（未填写）'],
      ['站点名称', site.companyName],
      ['站点 Logo', site.logo || '（不设置）']
    ];

    const body = rows.map(function (row) {
      return '<tr><td>' + escapeHtml(row[0]) + '</td><td>' + escapeHtml(row[1]) + '</td></tr>';
    }).join('');

    container.innerHTML = '<div class="init-table-wrap"><table class="init-table"><thead><tr>'
      + '<th>项目</th><th>值</th></tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  /**
   * 渲染「初始化过程」清单。
   *
   * @param {Array<{key: string, label: string}>} doneSteps 服务端确认跑完的步骤
   * @param {string|null} failedKey  卡住的那一步的 key
   */
  function renderInstallProgress(doneSteps, failedKey) {
    const container = byId('install-progress');
    if (!container) return;
    const done = {};
    (doneSteps || []).forEach(function (step) {
      if (step && step.key) done[step.key] = step.label || step.key;
    });

    const items = INSTALL_STEPS.map(function (step) {
      let status = 'pending';
      let mark = '·';
      if (done[step.key]) {
        status = 'done';
        mark = '✓';
      } else if (failedKey === step.key) {
        status = 'failed';
        mark = '✗';
      }
      const label = done[step.key] || step.label;
      return '<li class="init-progress-item ' + status + '">'
        + '<span class="progress-mark">' + mark + '</span>'
        + '<span class="progress-label">' + escapeHtml(label) + '</span>'
        + '</li>';
    });

    container.innerHTML = items.join('');
  }

  async function handleCompleteInstall() {
    const dbInvalid = validateDbForm();
    if (dbInvalid) {
      showAlert(dbInvalid, 'error');
      goToStep(1);
      return;
    }
    const adminInvalid = validateAdminForm();
    if (adminInvalid) {
      showAlert(adminInvalid, 'error');
      goToStep(2);
      return;
    }
    const siteInvalid = validateSiteForm();
    if (siteInvalid) {
      showAlert(siteInvalid, 'error');
      goToStep(3);
      return;
    }

    const button = byId('btn-complete-install');
    setBusy(button, true, '初始化中...');
    renderInstallProgress([], null);
    try {
      const data = await apiRequest('/api/init/complete-install', {
        method: 'POST',
        body: {
          db: collectDbConfig(),
          admin: collectAdminInput(),
          site: collectSiteSettings()
        }
      });
      renderInstallProgress(data.steps || [], null);

      byId('admin-password').value = '';
      byId('admin-password-confirm').value = '';

      byId('install-form-part').hidden = true;
      byId('install-done').hidden = false;
      goToStep(4);
      showAlert(
        (data.message || '初始化完成')
        + (data.databaseCreated ? '（数据库 ' + data.database + ' 已创建）' : ''),
        'success'
      );
    } catch (error) {
      const payload = error.data || {};
      renderInstallProgress(payload.steps || [], payload.failedStep || null);
      if (error.code === 'ALREADY_INSTALLED') {
        showAlert('站点已完成初始化，正在跳转到登录页…', 'info');
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
    byId('btn-test-db').addEventListener('click', handleTestDb);
    byId('btn-next-db').addEventListener('click', handleNextDb);
    byId('btn-back-db').addEventListener('click', function () {
      goToStep(1);
    });
    byId('btn-next-admin').addEventListener('click', handleNextAdmin);
    byId('btn-back-admin').addEventListener('click', function () {
      goToStep(2);
    });
    byId('btn-next-site').addEventListener('click', handleNextSite);
    byId('btn-back-site').addEventListener('click', function () {
      goToStep(3);
    });
    byId('btn-complete-install').addEventListener('click', handleCompleteInstall);
    byId('logo-file').addEventListener('change', handleLogoSelected);

    byId('admin-password-confirm').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') handleNextAdmin();
    });
  }

  /**
   * 页面加载：拉一次安装状态，把已知信息填进表单。
   *
   * 已经初始化完的站点，这个接口会返回 403 ALREADY_INSTALLED ——
   * 直接跳登录页即可（服务端本来也不会再放行任何 Init 写操作）。
   */
  async function loadInitialState() {
    try {
      const data = await apiRequest('/api/init/status', { method: 'GET' });
      initState = data.state || null;
      applyDbConfig(initState);
    } catch (error) {
      if (error.code === 'ALREADY_INSTALLED') {
        showAlert('站点已完成初始化，正在跳转到登录页…', 'info');
        window.setTimeout(function () {
          window.location.href = '/login';
        }, 1200);
        return;
      }
      // 状态读不出来不挡路 —— 「测试连接」环节会兜底
      showAlert('读取安装状态失败：' + error.message + '（可以先点「测试连接」确认数据库参数）', 'warning');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    byId('site-name').value = DEFAULT_SITE_NAME;
    goToStep(1);
    loadInitialState();
  });
})();
