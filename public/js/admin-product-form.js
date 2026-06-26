(function() {
  'use strict';

  // 课程型产品：11 个预设平台 + "其他"
  const COURSE_PLATFORMS = [
    { value: 'bilibili',      label: 'B站' },
    { value: 'youtube',       label: 'YouTube' },
    { value: 'github',        label: 'GitHub' },
    { value: 'imooc',         label: '慕课网' },
    { value: 'tencent-class', label: '腾讯课堂' },
    { value: 'netease-class', label: '网易云课堂' },
    { value: 'zhihu',         label: '知乎' },
    { value: 'juejin',        label: '掘金' },
    { value: 'csdn',          label: 'CSDN' },
    { value: 'wechat-mp',     label: '微信公众号' },
    { value: 'other',         label: '其他（自定义）' }
  ];

  function buildPlatformOptions(selected) {
    return COURSE_PLATFORMS.map(p =>
      '<option value="' + p.value + '"' + (p.value === selected ? ' selected' : '') + '>' + p.label + '</option>'
    ).join('');
  }

  // 课程型产品分类下拉框渲染（软件 vs 课程）
  const SOFTWARE_CATEGORIES = ['开发工具', '设计软件', '安全软件', '效率工具', '实用工具', '企业产品', 'GitHub 仓库', '开源产品'];
  const COURSE_CATEGORIES = ['外站课程', '企业内训'];

  function updateCategoryOptions(root, isCourse) {
    const select = $('#category', root);
    if (!select) return;
    const list = isCourse ? COURSE_CATEGORIES : SOFTWARE_CATEGORIES;
    select.innerHTML = list.map(cat =>
      '<option value="' + escHtml(cat) + '">' + escHtml(cat) + '</option>'
    ).join('');
  }

  // 分类名 → badge CSS class（admin list 用）
  function getCategoryBadgeClass(category) {
    const map = {
      '企业产品': 'badge-enterprise-product',
      '外站课程': 'badge-external-course',
      '企业内训': 'badge-enterprise-internal',
      'GitHub 仓库': 'badge-github-repo',
      '开源产品': 'badge-open-source'
    };
    return map[category] || 'badge-neutral';
  }

  // === 工具 ===
  function $(sel, scope) { return (scope || document).querySelector(sel); }
  function $$(sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); }
  function escHtml(text) {
    if (!text && text !== 0) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  // === 状态（每次 init 重建） ===
  function createState() {
    return {
      currentProduct: null,
      productFeatures: [],
      currentSoftwareFile: null,
      currentProductImage: null,
      // 价格方案最终值（提交时构建）
      monthlyPrice: 0,
      yearlyPrice: 0,
      courseLinks: [],
      repoUrls: [],
      // 事件监听器（destroy 时解绑）
      listeners: []
    };
  }

  // === 绑定助手：记录 + 解绑 ===
  // 注：$(sel, scope) 签名 — sel 在前，scope 在后（与 $ 调用一致）
  function bind(scope, sel, evt, fn) {
    const el = $(sel, scope);
    if (!el) return;
    el.addEventListener(evt, fn);
    return { el, evt, fn };
  }
  function destroy(state) {
    state.listeners.forEach(({ el, evt, fn }) => {
      el.removeEventListener(evt, fn);
    });
    state.listeners = [];
  }

  // === price 字段 required 同步 ===
  // price 在课程型/共享代码/开源/订阅启用时会被 hidden，
  // 但 HTML 上有 required 属性，浏览器表单校验无法聚焦被 hidden 的字段，会抛
  // "An invalid form control ... is not focusable"。每次隐藏 priceField 时
  // 同步去掉 required，恢复时再加回。
  function setPriceRequired(root, on) {
    const priceEl = $('#price', root);
    if (!priceEl) return;
    if (on) priceEl.setAttribute('required', '');
    else priceEl.removeAttribute('required');
  }

  // === 提交数据构建 ===
  function buildPayload(root, state) {
    const useTiers = $('#usePricingTiers', root).checked;
    const useExternal = $('#useExternalLink', root).checked;
    const isCourse = $('#isCourse', root).checked;
    const category = $('#category', root).value;
    const isOpenSource = category === '开源产品';

    const data = {
      name: $('#name', root).value,
      shortName: $('#shortName', root).value,
      category: category,
      description: $('#description', root).innerHTML,
      version: $('#version', root).value,
      platform: $('#platform', root).value,
      icon: $('#icon', root).value,
      features: state.productFeatures,
      featured: $('#featured', root).checked,
      image: $('#productImage', root).value,
      imageDarkBg: $('#imageDarkBg', root).checked,
      isCourse: isCourse,
      isSharedCode: $('#isSharedCode', root).checked
    };

    if (isCourse) {
      // 课程型：跳过价格/下载字段，提交链接列表
      data.price = 0;
      data.pricingTiers = null;
      data.downloadUrl = '';
      data.externalLink = false;
      data.courseLinks = state.courseLinks
        .filter(l => l.platform && l.url)
        .map(l => ({ platform: l.platform, url: l.url }));
    } else if (data.isSharedCode || isOpenSource) {
      // 开源产品：无价格，提交仓库地址数组
      data.price = 0;
      data.pricingTiers = null;
      data.downloadUrl = '';
      data.externalLink = false;
      data.repoUrls = (state.repoUrls || []).map(u => String(u || '').trim()).filter(Boolean);
    } else {
      if (useExternal) {
        data.downloadUrl = $('#externalLink', root).value;
        data.externalLink = true;
      } else {
        data.downloadUrl = $('#downloadUrl', root).value;
        data.externalLink = false;
      }

      if (useTiers) {
        // duration 硬编码 1 / 12，admin 改不了
        data.pricingTiers = [
          { label: '月付', duration: 1, price: state.monthlyPrice },
          { label: '年付', duration: 12, price: state.yearlyPrice }
        ];
      } else {
        data.price = parseFloat($('#price', root).value);
      }
    }

    return data;
  }

  // === 提交 ===
  async function submitForm(root, state, opts) {
    const payload = buildPayload(root, state);
    const url = state.currentProduct
      ? '/api/products/' + state.currentProduct.id
      : '/api/products';
    const method = state.currentProduct ? 'PUT' : 'POST';

    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include'
      });

      if (response.ok) {
        const saved = await response.json();
        alert(state.currentProduct ? '产品更新成功' : '产品添加成功');
        if (opts.onSaved) opts.onSaved(saved);
      } else {
        alert('保存失败');
      }
    } catch (err) {
      console.error('Save error:', err);
      alert('保存失败');
    }
  }

  // === 课程型模式切换 ===
  function toggleCourse(root, state, opts) {
    opts = opts || {};
    const isCourse = $('#isCourse', root).checked;
    const courseSection = $('#courseLinksSection', root);

    courseSection.hidden = !isCourse;

    if (isCourse) {
      // 隐藏其他 4 个区 + 清空值
      $('#priceField', root).hidden = true;
      setPriceRequired(root, false);
      $('#subscriptionSection', root).hidden = true;
      $('#externalLinkSection', root).hidden = true;
      $('#softwareUploadSection', root).hidden = true;
      $('#price', root).value = '';
      $('#tier-monthly-price', root).value = '';
      $('#tier-yearly-price', root).value = '';
      $('#usePricingTiers', root).checked = false;
      $('#useExternalLink', root).checked = false;
      $('#externalLink', root).value = '';
      if (!opts.preserveLinks) {
        state.courseLinks = [];
      }
      renderCourseLinks(root, state);
    } else {
      $('#priceField', root).hidden = false;
      // 仅当不启用订阅时才需要 required；启用订阅时由 toggleSubscription 处理
      if (!$('#usePricingTiers', root).checked) setPriceRequired(root, true);
      // 订阅和外部链接的 visible 状态由它们自己的 usePricingTiers / useExternalLink 决定
    }
  }

  // === 课程链接列表渲染 ===
  function renderCourseLinks(root, state) {
    const list = $('#course-links-list', root);
    if (!list) return;
    if (state.courseLinks.length === 0) {
      list.innerHTML = '<p style="color:var(--text-light);font-size:13px;padding:12px 0;">点击下方"+ 添加链接"按钮添加课程链接</p>';
      return;
    }
    list.innerHTML = state.courseLinks.map((link, i) => {
      const isCustom = link.platform === 'other' || (link.platform && link.platform.startsWith('custom:'));
      const customValue = isCustom && link.platform.startsWith('custom:') ? link.platform.slice(7) : '';
      return '<div class="course-link-row" data-index="' + i + '">' +
        '<select class="course-link-platform" data-action="platform">' +
          buildPlatformOptions(link.platform === 'other' ? 'other' : (link.platform && link.platform.startsWith('custom:') ? 'other' : link.platform)) +
        '</select>' +
        '<input type="text" class="course-link-platform-custom" data-action="custom" placeholder="自定义标签"' +
          (isCustom ? '' : ' hidden') + ' value="' + escHtml(customValue) + '">' +
        '<input type="url" class="course-link-url" data-action="url" placeholder="https://..." value="' + escHtml(link.url) + '">' +
        '<button type="button" class="btn-remove-course-link" data-action="remove">×</button>' +
      '</div>';
    }).join('');
  }

  function addCourseLink(root, state) {
    state.courseLinks.push({ platform: 'bilibili', url: '' });
    renderCourseLinks(root, state);
  }

  function removeCourseLink(root, state, index) {
    state.courseLinks.splice(index, 1);
    renderCourseLinks(root, state);
  }

  // === 开源产品：仓库地址列表 ===
  function renderRepoUrls(root, state) {
    const list = $('#repo-urls-list', root);
    if (!list) return;
    if (!state.repoUrls || state.repoUrls.length === 0) {
      list.innerHTML = '<p style="color:var(--text-light);font-size:13px;padding:12px 0;">点击下方"+ 添加仓库"按钮添加仓库地址（支持 GitHub / Gitee / 自建 GitLab 等）</p>';
      return;
    }
    list.innerHTML = state.repoUrls.map((url, i) =>
      '<div class="repo-url-row" data-index="' + i + '">' +
        '<input type="url" class="repo-url-input" data-action="url" placeholder="https://github.com/owner/repo" value="' + escHtml(url) + '">' +
        '<button type="button" class="btn-remove-course-link" data-action="remove" title="删除">×</button>' +
      '</div>'
    ).join('');
  }

  function addRepoUrl(root, state) {
    if (!state.repoUrls) state.repoUrls = [];
    state.repoUrls.push('');
    renderRepoUrls(root, state);
  }

  function removeRepoUrl(root, state, index) {
    state.repoUrls.splice(index, 1);
    renderRepoUrls(root, state);
  }

  function updateRepoUrlField(root, state, index, value) {
    if (state.repoUrls[index] !== undefined) {
      state.repoUrls[index] = value;
    }
  }

  // 类目切换：开源产品时显示仓库地址区 + 隐藏价格/订阅/下载
  function toggleOpenSource(root, state) {
    const isOpenSource = $('#category', root).value === '开源产品';
    const isSharedCodeChecked = $('#isSharedCode', root) && $('#isSharedCode', root).checked;
    const repoSection = $('#repoUrlsSection', root);
    // 仓库区显示条件：分类=开源产品 OR 用户勾选共享代码
    if (repoSection) repoSection.hidden = !(isOpenSource || isSharedCodeChecked);
    if (isOpenSource) {
      $('#priceField', root).hidden = true;
      setPriceRequired(root, false);
      $('#subscriptionSection', root).hidden = true;
      $('#externalLinkSection', root).hidden = true;
      $('#softwareUploadSection', root).hidden = true;
      $('#price', root).value = '';
      $('#tier-monthly-price', root).value = '';
      $('#tier-yearly-price', root).value = '';
      $('#usePricingTiers', root).checked = false;
      $('#useExternalLink', root).checked = false;
      $('#externalLink', root).value = '';
      // 分类切到开源产品时，自动同步勾上共享代码（避免用户再点一次）
      if ($('#isSharedCode', root) && !$('#isSharedCode', root).checked) {
        $('#isSharedCode', root).checked = true;
      }
    } else {
      // 恢复价格/订阅/下载区（不强制显示订阅/外部链接，由它们自己的 checkbox 决定）
      $('#priceField', root).hidden = false;
      if (!$('#usePricingTiers', root).checked) setPriceRequired(root, true);
    }
  }

  // === 共享代码模式切换 ===
  // 勾选后：显示仓库区、隐藏价格/订阅/外部链接/软件上传、清空对应值。
  // 互斥：勾选时自动取消 #isCourse；反之 #isCourse change 也取消 #isSharedCode。
  function toggleSharedCode(root, state) {
    const checkbox = $('#isSharedCode', root);
    const isSharedCode = checkbox && checkbox.checked;
    const repoSection = $('#repoUrlsSection', root);
    if (repoSection) repoSection.hidden = !isSharedCode;
    if (isSharedCode) {
      // 互斥：取消课程型
      const courseBox = $('#isCourse', root);
      if (courseBox && courseBox.checked) {
        courseBox.checked = false;
        updateCategoryOptions(root, false);
        toggleCourse(root, state);
      }
      // 隐藏价格/订阅/外部链接/软件上传
      $('#priceField', root).hidden = true;
      setPriceRequired(root, false);
      $('#subscriptionSection', root).hidden = true;
      $('#externalLinkSection', root).hidden = true;
      $('#softwareUploadSection', root).hidden = true;
      $('#price', root).value = '';
      $('#tier-monthly-price', root).value = '';
      $('#tier-yearly-price', root).value = '';
      $('#usePricingTiers', root).checked = false;
      $('#useExternalLink', root).checked = false;
      $('#externalLink', root).value = '';
      if (!state.repoUrls) state.repoUrls = [];
    } else {
      // 取消勾选：仓库区显隐交给 toggleOpenSource（看分类是否为开源产品）
      const isOpenSource = $('#category', root).value === '开源产品';
      if (repoSection) repoSection.hidden = !isOpenSource;
      $('#priceField', root).hidden = false;
      if (!$('#usePricingTiers', root).checked) setPriceRequired(root, true);
    }
  }

  function updateCourseLinkField(root, state, index, field, value) {
    if (state.courseLinks[index]) {
      state.courseLinks[index][field] = value;
    }
  }

  function syncCustomPlatform(root, state, index) {
    const link = state.courseLinks[index];
    if (!link) return;
    if (link.platform === 'other') {
      const customInput = $('#course-links-list .course-link-row[data-index="' + index + '"] .course-link-platform-custom', root);
      if (customInput && customInput.value.trim()) {
        link.platform = 'custom:' + customInput.value.trim();
      } else {
        link.platform = '';
      }
    } else {
      // 防御性：保留 custom: 状态
      link.platform = link.platform.startsWith('custom:') ? link.platform : link.platform;
    }
  }

  // === 订阅方案显示/隐藏 ===
  function toggleSubscription(root) {
    const enabled = $('#usePricingTiers', root).checked;
    const subscriptionSection = $('#subscriptionSection', root);
    const priceField = $('#priceField', root);

    subscriptionSection.hidden = !enabled;
    priceField.hidden = enabled;
    // 启用订阅时 price 被隐藏，去掉 required；取消时恢复
    setPriceRequired(root, !enabled);

    // 启用订阅时清空基础价（避免意外提交）
    if (enabled) $('#price', root).value = '';
  }

  // === tier migration (3+ 档 → 2 档) ===
  function migrateTiers(savedTiers) {
    if (!savedTiers || savedTiers.length === 0) {
      return { monthly: 0, yearly: 0, migrated: false };
    }
    if (savedTiers.length === 2) {
      return {
        monthly: savedTiers[0].price,
        yearly: savedTiers[1].price,
        migrated: false
      };
    }
    // > 2 档：选最接近 1 月的当月付、最接近 12 月的当年付
    const sorted = [...savedTiers].sort((a, b) => a.duration - b.duration);
    const monthly = sorted.reduce((best, t) =>
      Math.abs(t.duration - 1) < Math.abs(best.duration - 1) ? t : best
    );
    const yearly = sorted.reduce((best, t) =>
      Math.abs(t.duration - 12) < Math.abs(best.duration - 12) ? t : best
    );
    return {
      monthly: monthly.price,
      yearly: yearly.price,
      migrated: true,
      originalCount: savedTiers.length
    };
  }

  function showMigrationNotice(root, info) {
    if (!info.migrated) return;
    const notice = $('#tier-migration-notice', root);
    const text = $('#tier-migration-text', root);
    text.textContent = '已将原 ' + info.originalCount + ' 档数据迁移为 2 档订阅方案（月付 ¥' +
      info.monthly + '、年付 ¥' + info.yearly + '），请确认后保存。';
    notice.hidden = false;
  }

  // === 加载产品（edit 模式） ===
  async function loadProduct(root, state, opts) {
    if (!opts.productId) {
      return;
    }
    try {
      const response = await fetch('/api/products/' + opts.productId, { credentials: 'include' });
      const product = await response.json();
      state.currentProduct = product;

      $('#product-id', root).value = product.id;
      $('#name', root).value = product.name;
      $('#shortName', root).value = product.shortName || '';
      $('#category', root).value = product.category;
      $('#price', root).value = product.price || '';
      $('#description', root).innerHTML = product.description || '';
      $('#version', root).value = product.version || '';
      $('#platform', root).value = product.platform || '';
      $('#icon', root).value = product.icon || 'software';
      $('#featured', root).checked = product.featured;

      state.productFeatures = product.features || [];
      $('#features-input', root).value = state.productFeatures.join('\n');

      const isExternal = product.externalLink === true || product.externalLink === 1;
      $('#useExternalLink', root).checked = isExternal;
      toggleExternalLink(root);
      if (isExternal) {
        $('#externalLink', root).value = product.downloadUrl || '';
      } else {
        $('#downloadUrl', root).value = product.downloadUrl || '';
      }

      const productImage = product.image || '';
      if (productImage) {
        state.currentProductImage = { filename: productImage.split('/').pop(), path: productImage };
        $('#productImage', root).value = productImage;
        $('#product-image-display', root).src = productImage;
        $('#product-image-upload-placeholder', root).hidden = true;
        $('#product-image-preview', root).hidden = false;
        $('#imageDarkBg', root).checked = product.imageDarkBg === true;
      }

      // 价格方案 → 2 档映射
      const savedTiers = product.pricingTiers || product.pricing_tiers;
      if (savedTiers && savedTiers.length > 0) {
        const info = migrateTiers(savedTiers);
        state.monthlyPrice = info.monthly;
        state.yearlyPrice = info.yearly;
        $('#usePricingTiers', root).checked = true;
        $('#tier-monthly-price', root).value = info.monthly || '';
        $('#tier-yearly-price', root).value = info.yearly || '';
        showMigrationNotice(root, info);
        toggleSubscription(root);
      }

      // 课程型加载
      if (product.isCourse === true || product.isCourse === 1) {
        state.courseLinks = Array.isArray(product.courseLinks) ? product.courseLinks : [];
        $('#isCourse', root).checked = true;
        toggleCourse(root, state, { preserveLinks: true });
        renderCourseLinks(root, state);
      }

      // 开源产品加载
      if (Array.isArray(product.repoUrls)) {
        state.repoUrls = product.repoUrls.slice();
        renderRepoUrls(root, state);
      }
      // 共享代码加载
      if (product.isSharedCode === true || product.isSharedCode === 1) {
        $('#isSharedCode', root).checked = true;
      }
      toggleOpenSource(root, state);
      toggleSharedCode(root, state);
    } catch (err) {
      console.error('Load product error:', err);
      alert('加载产品失败');
    }
  }

  // === 外部链接切换 ===
  function toggleExternalLink(root) {
    const useExternal = $('#useExternalLink', root).checked;
    $('#externalLinkSection', root).hidden = !useExternal;
    $('#softwareUploadSection', root).hidden = useExternal;
    if (useExternal) {
      removeSoftwareFile(root);
    } else {
      $('#externalLink', root).value = '';
    }
  }

  // === 软件文件上传/删除 ===
  async function uploadSoftwareFile(root, state, file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('software', file);
    try {
      const response = await fetch('/api/upload-software', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        state.currentSoftwareFile = data;
        $('#downloadUrl', root).value = data.path;
        $('#software-file-name', root).textContent = data.originalName;
        $('#software-file-size', root).textContent = formatFileSize(data.size);
        $('#software-upload-placeholder', root).hidden = true;
        $('#software-info', root).hidden = false;
        $('#software-upload-section', root).classList.add('has-file');
      } else {
        alert('文件上传失败');
      }
    } catch (err) {
      console.error('Software upload error:', err);
      alert('文件上传失败');
    }
  }

  function removeSoftwareFile(root) {
    // 注：state 由 init 时绑定到闭包
    const state = root._productFormState;
    if (state && state.currentSoftwareFile) {
      fetch('/api/upload-software', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: state.currentSoftwareFile.filename }),
        credentials: 'include'
      });
    }
    if (state) state.currentSoftwareFile = null;
    $('#downloadUrl', root).value = '';
    $('#software-upload-placeholder', root).hidden = false;
    $('#software-info', root).hidden = true;
    $('#software-upload-section', root).classList.remove('has-file');
  }

  // === 产品图片上传/删除 ===
  async function uploadProductImageFile(root, state, file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      const response = await fetch('/api/upload-product-image', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        state.currentProductImage = { filename: data.filename, path: data.path };
        $('#productImage', root).value = data.path;
        $('#product-image-display', root).src = data.path;
        $('#product-image-upload-placeholder', root).hidden = true;
        $('#product-image-preview', root).hidden = false;
      } else {
        alert('图片上传失败');
      }
    } catch (err) {
      console.error('Image upload error:', err);
      alert('图片上传失败');
    }
  }

  function removeProductImage(root) {
    const state = root._productFormState;
    if (state && state.currentProductImage) {
      fetch('/api/upload-product-image', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: state.currentProductImage.filename }),
        credentials: 'include'
      });
    }
    if (state) state.currentProductImage = null;
    $('#productImage', root).value = '';
    $('#product-image-upload-placeholder', root).hidden = false;
    $('#product-image-preview', root).hidden = true;
    $('#product-image-file', root).value = '';
  }

  // === 富文本编辑器 ===
  function execCmd(root, command, value) {
    document.execCommand(command, false, value || null);
    $('#description', root).focus();
  }

  async function uploadRichImage(root, file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      const response = await fetch('/api/upload-product-image', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        const img = document.createElement('img');
        img.src = data.path;
        img.style.maxWidth = '100%';
        $('#description', root).appendChild(img);
        $('#description', root).focus();
      } else {
        alert('图片上传失败');
      }
    } catch (err) {
      console.error('Rich image upload error:', err);
      alert('图片上传失败');
    }
  }

  // === AI 描述优化 ===
  async function regenerateDescription(root) {
    const descEl = $('#description', root);
    const currentText = descEl.innerText || descEl.innerHTML;
    if (!currentText.trim()) {
      alert('请先输入产品基本信息');
      return;
    }
    try {
      const response = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text: currentText, type: 'product_description' })
      });
      const data = await response.json();
      if (data.success) {
        descEl.innerHTML = data.text.replace(/\n/g, '<br>');
        alert('AI优化成功');
      } else {
        alert(data.error || 'AI生成失败');
      }
    } catch (err) {
      console.error('AI error:', err);
      alert('AI生成失败');
    }
  }

  // === 解析 features ===
  function parseFeatures(root, state) {
    const input = $('#features-input', root).value;
    state.productFeatures = input.split('\n').map(function(f) { return f.trim(); }).filter(function(f) { return f.length > 0; });
    alert('已解析 ' + state.productFeatures.length + ' 个功能特点');
  }

  // === 加载站点 settings (logo / 主题) ===
  async function loadSettings() {
    try {
      const response = await fetch('/api/settings', { credentials: 'include' });
      const settings = await response.json();
      if (settings.siteTheme) {
        document.documentElement.setAttribute('data-theme', settings.siteTheme);
      }
      const logoEl = document.getElementById('header-logo-icon');
      if (logoEl && settings.logo) {
        logoEl.outerHTML = '<img src="' + settings.logo + '?t=' + Date.now() +
          '" alt="Logo" id="header-logo-icon" style="height:40px;width:auto;">';
      }
      const logoText = document.getElementById('header-logo-text');
      if (logoText && settings.companyName) {
        logoText.textContent = ' ' + settings.companyName + ' 管理后台';
      }
    } catch (err) {
      console.error('Settings load error:', err);
    }
  }

  // === 主入口 ===
  function init(root, opts) {
    if (!root) {
      console.error('ProductForm.init: root element is required');
      return null;
    }
    opts = opts || {};
    const state = createState();
    root._productFormState = state;

    // 1. 绑定事件
    // 课程型切换
    state.listeners.push(bind(root, '#isCourse', 'change', function() {
      const isCourse = $('#isCourse', root).checked;
      // 切换下拉框选项前保留当前 category（如果在新选项列表里则保留）
      const currentCategory = $('#category', root).value;
      updateCategoryOptions(root, isCourse);
      const validList = isCourse ? COURSE_CATEGORIES : SOFTWARE_CATEGORIES;
      if (validList.indexOf(currentCategory) !== -1) {
        $('#category', root).value = currentCategory;
      }
      toggleCourse(root, state);
      // 互斥：勾课程型时自动取消共享代码
      if (isCourse && $('#isSharedCode', root).checked) {
        $('#isSharedCode', root).checked = false;
        toggleSharedCode(root, state);
      }
    }));

    // 共享代码切换
    state.listeners.push(bind(root, '#isSharedCode', 'change', function() {
      toggleSharedCode(root, state);
    }));

    // 互斥防御：勾 usePricingTiers 时自动 uncheck isCourse / isSharedCode
    state.listeners.push(bind(root, '#usePricingTiers', 'change', function() {
      if (this.checked) {
        if ($('#isCourse', root).checked) {
          $('#isCourse', root).checked = false;
          updateCategoryOptions(root, false);
          toggleCourse(root, state);
        }
        if ($('#isSharedCode', root).checked) {
          $('#isSharedCode', root).checked = false;
          toggleSharedCode(root, state);
        }
      }
      toggleSubscription(root);
    }));

    // 互斥防御：勾 useExternalLink 时自动 uncheck isCourse / isSharedCode
    state.listeners.push(bind(root, '#useExternalLink', 'change', function() {
      if (this.checked) {
        if ($('#isCourse', root).checked) {
          $('#isCourse', root).checked = false;
          updateCategoryOptions(root, false);
          toggleCourse(root, state);
        }
        if ($('#isSharedCode', root).checked) {
          $('#isSharedCode', root).checked = false;
          toggleSharedCode(root, state);
        }
      }
      toggleExternalLink(root);
    }));

    // 课程链接增/删
    state.listeners.push(bind(root, '#add-course-link-btn', 'click', function() {
      addCourseLink(root, state);
    }));

    // 类目切换：开源产品显示仓库地址区
    state.listeners.push(bind(root, '#category', 'change', function() {
      toggleOpenSource(root, state);
    }));

    // 仓库地址增/删
    state.listeners.push(bind(root, '#add-repo-url-btn', 'click', function() {
      addRepoUrl(root, state);
    }));

    // 课程链接 input 委托（URL + custom label）
    state.listeners.push(bind(root, '#course-links-list', 'input', function(e) {
      const row = e.target.closest('.course-link-row');
      if (!row) return;
      const i = parseInt(row.dataset.index, 10);
      const action = e.target.dataset.action;
      if (action === 'url') {
        updateCourseLinkField(root, state, i, 'url', e.target.value);
      } else if (action === 'custom') {
        const link = state.courseLinks[i];
        if (link && link.platform === 'other') {
          link.platform = 'custom:' + e.target.value.trim();
        }
      }
    }));

    // 课程链接 change 委托（platform select）
    state.listeners.push(bind(root, '#course-links-list', 'change', function(e) {
      const row = e.target.closest('.course-link-row');
      if (!row) return;
      const i = parseInt(row.dataset.index, 10);
      if (e.target.dataset.action === 'platform') {
        updateCourseLinkField(root, state, i, 'platform', e.target.value);
        const customInput = row.querySelector('.course-link-platform-custom');
        if (e.target.value === 'other') {
          customInput.hidden = false;
          syncCustomPlatform(root, state, i);
        } else {
          customInput.hidden = true;
        }
      }
    }));

    // 课程链接 click 委托（remove button）
    state.listeners.push(bind(root, '#course-links-list', 'click', function(e) {
      const row = e.target.closest('.course-link-row');
      if (!row) return;
      if (e.target.dataset.action === 'remove') {
        const i = parseInt(row.dataset.index, 10);
        removeCourseLink(root, state, i);
      }
    }));

    // 仓库地址 input 委托
    state.listeners.push(bind(root, '#repo-urls-list', 'input', function(e) {
      const row = e.target.closest('.repo-url-row');
      if (!row) return;
      const i = parseInt(row.dataset.index, 10);
      if (e.target.dataset.action === 'url') {
        updateRepoUrlField(root, state, i, e.target.value);
      }
    }));

    // 仓库地址 click 委托（remove button）
    state.listeners.push(bind(root, '#repo-urls-list', 'click', function(e) {
      const row = e.target.closest('.repo-url-row');
      if (!row) return;
      if (e.target.dataset.action === 'remove') {
        const i = parseInt(row.dataset.index, 10);
        removeRepoUrl(root, state, i);
      }
    }));

    state.listeners.push(bind(root, '#usePricingTiers', 'change', function() {
      toggleSubscription(root);
    }));
    state.listeners.push(bind(root, '#tier-monthly-price', 'input', function(e) {
      state.monthlyPrice = parseFloat(e.target.value) || 0;
    }));
    state.listeners.push(bind(root, '#tier-yearly-price', 'input', function(e) {
      state.yearlyPrice = parseFloat(e.target.value) || 0;
    }));
    state.listeners.push(bind(root, '#useExternalLink', 'change', function() {
      toggleExternalLink(root);
    }));

    // 软件上传
    state.listeners.push(bind(root, '#software-file-btn', 'click', function() {
      $('#software-file', root).click();
    }));
    state.listeners.push(bind(root, '#software-file', 'change', function(e) {
      const file = e.target.files[0];
      uploadSoftwareFile(root, state, file);
      e.target.value = '';
    }));
    state.listeners.push(bind(root, '#remove-software-btn', 'click', function() {
      removeSoftwareFile(root);
    }));

    // 产品图片上传
    state.listeners.push(bind(root, '#product-image-btn', 'click', function() {
      $('#product-image-file', root).click();
    }));
    state.listeners.push(bind(root, '#product-image-file', 'change', function(e) {
      const file = e.target.files[0];
      uploadProductImageFile(root, state, file);
    }));
    state.listeners.push(bind(root, '#remove-product-image-btn', 'click', function() {
      removeProductImage(root);
    }));

    // features 解析
    state.listeners.push(bind(root, '#parse-features-btn', 'click', function() {
      parseFeatures(root, state);
    }));

    // 富文本工具栏（用 data-cmd 委托）
    state.listeners.push(bind(root, '.rich-toolbar', 'click', function(e) {
      const btn = e.target.closest('button[data-cmd], button[data-cmd-format]');
      if (!btn) return;
      e.preventDefault();
      if (btn.dataset.cmd) {
        execCmd(root, btn.dataset.cmd);
      } else if (btn.dataset.cmdFormat) {
        execCmd(root, 'formatBlock', btn.dataset.cmdFormat);
      }
    }));
    state.listeners.push(bind(root, '#rich-image-file', 'change', function(e) {
      const file = e.target.files[0];
      uploadRichImage(root, file);
      e.target.value = '';
    }));

    // AI 优化
    state.listeners.push(bind(root, '#ai-optimize-btn', 'click', function() {
      regenerateDescription(root);
    }));

    // 提交
    state.listeners.push(bind(root, '#product-form', 'submit', function(e) {
      e.preventDefault();
      submitForm(root, state, opts);
    }));

    // 取消（modal 模式下点取消调 onCancel，全页模式跳 /admin-product）
    const cancelBtn = $('#cancel-btn', root);
    if (cancelBtn) {
      state.listeners.push(bind(root, '#cancel-btn', 'click', function(e) {
        if (opts.onCancel) {
          e.preventDefault();
          opts.onCancel();
        }
        // 否则走默认 href
      }));
    }

    // 2. 加载数据
    loadSettings();
    if (opts.mode === 'edit' && opts.productId) {
      loadProduct(root, state, opts).then(function() {
        updateCategoryOptions(root, !!state.currentProduct?.isCourse);
      });
    } else {
      // 新建模式：默认软件型分类
      updateCategoryOptions(root, false);
      toggleOpenSource(root, state);
    }

    return {
      destroy: function() { destroy(state); }
    };
  }

  // === 暴露 ===
  window.ProductForm = { init: init };
})();
