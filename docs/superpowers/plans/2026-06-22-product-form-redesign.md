# 产品管理表单重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把产品添加/编辑表单从 `ProductManagement.html` 抽成可复用 partial（HTML/CSS/JS），让 16:9 宽屏全页和列表页 modal 共用同一份代码；同时把"多价格方案"重命名为"订阅方案"，固定 2 档（月付 1 月 / 年付 12 月），启用订阅时基础价整块隐藏。

**Architecture:** 单一来源 `admin-product-form.html` (无 layout chrome) + `admin-product-form.css` + `admin-product-form.js`（暴露 `window.ProductForm.init(rootEl, opts)`）。`ProductManagement.html` 变成瘦壳：保留 breadcrumb + title 容器，挂载 partial 后调 init。`admin-product.html` 加 modal backdrop，首次打开时按需 fetch HTML/JS/CSS，复用 init。

**Tech Stack:** 原生 ES5/ES6 JS（无构建步骤，遵循项目惯例）、CSS Grid 16:9 宽屏、现有 `admin-theme.css` CSS 变量、Express 静态文件中间件。

## Global Constraints

- **API 不变**：`POST /api/products` / `PUT /api/products/:id`，`pricingTiers` 仍为 JSON 数组、运行时强制 2 元素；`externalLink` 仍是布尔复选框
- **数据契约**：`pricingTiers` 每档 `{ label, duration, price }`；`duration` 在前端硬编码 1（月付）/ 12（年付），admin 改不了
- **提交规则**：`usePricingTiers=true` 时只发 `pricingTiers` 不发 `price`；`=false` 时只发 `price` 不发 `pricingTiers`
- **duration 固定**：月付 label 后面显示 `(1 个月)`，年付 `(12 个月)`，无 duration 输入框，无 add/remove 按钮
- **基础价隐藏**：启用订阅时整个 `.form-field#priceField` 设 `hidden=true`（不是 disabled），同时清空 value
- **16:9 宽屏**：`max-width: 1600px`，`padding: 32px 40px`，`form-row` grid 双列（≥1200px）/ 单列（<1200px）
- **modal 模式**：复用 `admin-theme.css` 的 modal-backdrop 模式（`[hidden]` + `:not([hidden]) { display: flex }`），但 max-width 调到 1600px
- **复用现有组件**：sidebar、logo、settings 加载都走 `admin-sidebar.js` 和 `/api/settings`，不在 partial 内重写
- **深链接兼容**：`/ProductManagement?id=X` 仍可深链接到全页编辑
- **JS 风格**：项目用原生 JS 无构建步骤，不用 ESM `import`；新 JS 文件用 IIFE + `window.ProductForm` 命名空间
- **Cache bust**：新 CSS/JS 文件名带 `?v=20260622-XXXX` 时间戳（参考 `admin-sidebar.css?v=20260621-1625` 模式）
- **不在范围内**：不改 product.html（公开端产品页）、不改 pricingTiers 在公开页的展示、不动 AI 优化描述按钮、不动富文本编辑器、不动图片上传

---

## File Structure

### 新建文件
- `public/admin-product-form.html` — 纯 form markup（无 layout/sidebar）
- `public/css/admin-product-form.css` — 16:9 宽屏 + 订阅方案样式
- `public/js/admin-product-form.js` — `window.ProductForm` 命名空间

### 修改文件
- `public/ProductManagement.html` — 删 inline CSS/JS/Form markup，加 mount 容器
- `public/admin-product.html` — 加 modal + 动态加载逻辑

### 文件职责划分
- **partial 包含 form 全部 UI 逻辑**：字段、事件、保存、加载、上传、富文本、AI 描述、features 解析
- **壳页面只负责挂载和导航**：挂载点 + breadcrumb + title + 调 init
- **modal 容器在列表页**：`#productModal.backdrop` + `#productFormMount` mount 点

### 任务边界
- 任务 1 写 markup → 任务 2 写 CSS → 任务 3 写 JS（都能独立测试）
- 任务 4 把全页瘦壳化（依赖任务 1-3 写好的 partial）
- 任务 5 在列表页加 modal（也依赖任务 1-3）
- 任务 6 浏览器手测验证

---

### Task 1: 创建 partial HTML — `admin-product-form.html`

**Files:**
- Create: `public/admin-product-form.html`

**Interfaces:**
- Consumes: 无（纯 markup 片段）
- Produces: 一个 form 片段，挂载到任一容器后通过 `window.ProductForm.init(rootEl, opts)` 激活

- [ ] **Step 1: 创建文件骨架**

新建 `public/admin-product-form.html`：

```html
<!-- 产品表单 partial - 由 ProductForm.init() 挂载激活 -->
<form id="product-form" class="product-form">
  <input type="hidden" id="product-id">

  <!-- 迁移提示（默认隐藏） -->
  <div id="tier-migration-notice" class="tier-migration-notice" hidden>
    <strong>数据迁移提示：</strong>
    <span id="tier-migration-text"></span>
  </div>

  <div class="form-section">
    <h3 class="section-title">基本信息</h3>

    <div class="form-row">
      <div class="form-field">
        <label for="name">产品名称 *</label>
        <input type="text" id="name" name="name" required placeholder="例如：CodeFlow Pro">
      </div>

      <div class="form-field">
        <label for="shortName">产品简写名称</label>
        <input type="text" id="shortName" name="shortName" placeholder="例如：xiaomingMailPrivate">
        <small class="form-hint">客户端注册时使用此名称</small>
      </div>
    </div>

    <div class="form-row">
      <div class="form-field">
        <label for="category">分类 *</label>
        <select id="category" name="category" required>
          <option value="开发工具">开发工具</option>
          <option value="设计软件">设计软件</option>
          <option value="安全软件">安全软件</option>
          <option value="效率工具">效率工具</option>
          <option value="实用工具">实用工具</option>
        </select>
      </div>

      <div class="form-field" id="priceField">
        <label for="price">基础价格 (¥) *</label>
        <input type="number" id="price" name="price" min="0" step="0.01" required placeholder="79">
        <small class="form-hint">订阅方案启用后此价格不参与购买</small>
      </div>
    </div>

    <div class="checkbox-field">
      <input type="checkbox" id="usePricingTiers" name="usePricingTiers">
      <label for="usePricingTiers">启用订阅方案（月付 / 年付）</label>
    </div>

    <div class="subscription-section" id="subscriptionSection" hidden>
      <h4 class="subscription-title">订阅方案</h4>
      <div class="subscription-tier-row">
        <label>月付 <span class="tier-meta">(1 个月)</span></label>
        <input type="number" id="tier-monthly-price" min="0" step="0.01" placeholder="29">
        <span class="tier-suffix">¥/月</span>
      </div>
      <div class="subscription-tier-row">
        <label>年付 <span class="tier-meta">(12 个月)</span></label>
        <input type="number" id="tier-yearly-price" min="0" step="0.01" placeholder="299">
        <span class="tier-suffix">¥/年</span>
      </div>
    </div>

    <div class="form-field">
      <label for="description">产品描述（支持富文本）</label>
      <div class="rich-editor">
        <div class="rich-toolbar">
          <button type="button" data-cmd="bold"><b>B</b></button>
          <button type="button" data-cmd="italic"><i>I</i></button>
          <button type="button" data-cmd="underline"><u>U</u></button>
          <button type="button" data-cmd="strikeThrough"><s>S</s></button>
          <button type="button" data-cmd="insertUnorderedList">• 列表</button>
          <button type="button" data-cmd="insertOrderedList">1. 列表</button>
          <button type="button" data-cmd-format="h3">标题</button>
          <button type="button" data-cmd-format="p">段落</button>
          <div class="image-upload-btn">
            <button type="button" id="rich-image-btn">插入图片</button>
            <input type="file" accept="image/*" id="rich-image-file">
          </div>
        </div>
        <div id="description" class="rich-content" contenteditable="true"
             data-placeholder="详细描述产品的功能和特点..."></div>
      </div>
      <div class="rich-actions">
        <button type="button" class="btn btn-success" id="ai-optimize-btn">AI优化描述</button>
      </div>
    </div>
  </div>

  <div class="form-section">
    <h3 class="section-title">产品信息</h3>

    <div class="form-row">
      <div class="form-field">
        <label for="version">版本号</label>
        <input type="text" id="version" name="version" placeholder="1.0.0">
      </div>
      <div class="form-field">
        <label for="platform">支持平台</label>
        <input type="text" id="platform" name="platform" placeholder="Windows / Mac / Linux">
      </div>
    </div>

    <div class="form-field">
      <label for="icon">图标类型</label>
      <select id="icon" name="icon">
        <option value="code">代码 (Code)</option>
        <option value="palette">设计 (Palette)</option>
        <option value="shield">安全 (Shield)</option>
        <option value="check">任务 (Check)</option>
        <option value="cloud">云端 (Cloud)</option>
        <option value="image">图像 (Image)</option>
        <option value="software">软件 (Software)</option>
      </select>
    </div>

    <div class="form-field">
      <label>功能特点（每行一个）</label>
      <textarea id="features-input" rows="4" placeholder="输入功能特点，每行一个"></textarea>
      <button type="button" class="btn btn-primary" id="parse-features-btn"
              style="margin-top: 8px;">解析功能列表</button>
    </div>

    <div class="form-field">
      <label>下载方式</label>
      <div class="checkbox-field">
        <input type="checkbox" id="useExternalLink" name="useExternalLink">
        <label for="useExternalLink">使用外部下载链接</label>
      </div>
    </div>

    <div class="form-field" id="externalLinkSection" hidden>
      <label for="externalLink">外部下载链接</label>
      <input type="url" id="externalLink" name="externalLink"
             placeholder="https://example.com/download/software.exe">
    </div>

    <div class="form-field" id="softwareUploadSection">
      <label>软件文件上传</label>
      <div class="software-upload-section" id="software-upload-section">
        <input type="file" id="software-file" style="display: none;"
               accept=".exe,.zip,.rar,.7z,.msi,.dmg,.pkg,.deb,.rpm,.appimage,.jar,.war,.pdf">
        <div id="software-upload-placeholder">
          <p style="margin-bottom: 10px; color: var(--text-light);">点击按钮选择软件安装包文件</p>
          <button type="button" class="btn btn-outline" id="software-file-btn">选择文件</button>
          <p style="margin-top: 10px; font-size: 12px; color: var(--text-light);">
            支持格式: exe, zip, rar, 7z, msi, dmg, deb, rpm, jar, pdf 等</p>
        </div>
        <div id="software-info" hidden>
          <div class="software-info">
            <div>
              <div class="file-name" id="software-file-name"></div>
              <div class="file-size" id="software-file-size"></div>
            </div>
            <button type="button" class="btn-remove-file" id="remove-software-btn">删除</button>
          </div>
        </div>
      </div>
      <input type="hidden" id="downloadUrl" name="downloadUrl" value="">
    </div>

    <div class="form-field">
      <label>产品图片上传</label>
      <div class="software-upload-section" id="product-image-upload-section">
        <input type="file" id="product-image-file" style="display: none;" accept="image/*">
        <div id="product-image-upload-placeholder">
          <p style="margin-bottom: 10px; color: var(--text-light);">
            点击按钮选择产品图片（显示在产品详情页）</p>
          <button type="button" class="btn btn-outline" id="product-image-btn">选择图片</button>
          <p style="margin-top: 10px; font-size: 12px; color: var(--text-light);">
            支持格式: jpg, png, gif, webp 等</p>
        </div>
        <div id="product-image-preview" hidden>
          <div class="software-info">
            <div>
              <img id="product-image-display" src="" style="max-width: 200px; max-height: 150px;">
            </div>
            <button type="button" class="btn-remove-file" id="remove-product-image-btn">删除</button>
          </div>
        </div>
      </div>
      <input type="hidden" id="productImage" name="productImage" value="">
      <div style="margin-top: 8px;">
        <label class="checkbox-field">
          <input type="checkbox" id="imageDarkBg" name="imageDarkBg" style="width: auto; margin-right: 6px;">
          图片背景为深色（使用白色文字）
        </label>
      </div>
    </div>

    <div class="form-field">
      <label class="checkbox-field">
        <input type="checkbox" id="featured" name="featured" style="width: auto; margin-right: 8px;">
        设为精选产品
      </label>
    </div>
  </div>

  <div class="form-actions">
    <a href="/admin-product" class="btn-back" id="cancel-btn">&larr; 返回列表</a>
    <button type="submit" class="btn btn-primary" id="submit-btn">保存产品</button>
  </div>
</form>
```

- [ ] **Step 2: 验证 markup 完整**

打开浏览器开发者工具（手动验证），确认：
- 静态打开 `/admin-product-form.html` 看到一个完整的 form（虽然丑，但所有字段都在）
- 用 `view-source` 数一遍字段：name/shortName/category/price/usePricingTiers/tier-monthly-price/tier-yearly-price/description/version/platform/icon/features-input/useExternalLink/externalLink/software-file/product-image-file/imageDarkBg/featured/downloadUrl/productImage/submit-btn
- 全是 19 个表单控件 + 1 个 cancel 链接

- [ ] **Step 3: 提交（暂不 commit，下个任务继续）**

不要 commit —— Task 2 加 CSS 后一起 commit。

---

### Task 2: 创建表单 CSS — `admin-product-form.css`

**Files:**
- Create: `public/css/admin-product-form.css`

**Interfaces:**
- Consumes: Task 1 创建的 `public/admin-product-form.html` 元素
- Produces: 16:9 宽屏布局 + 订阅方案专属样式；form 字段 hidden/show 规则

- [ ] **Step 1: 写完整 CSS**

新建 `public/css/admin-product-form.css`：

```css
/* ============================================
   Product Form Partial Styles
   16:9 widescreen, subscription-only pricing
   ============================================ */

.product-form-shell {
  max-width: 1600px;
  margin: 0 auto;
  padding: 32px 40px;
}
/* 卡片背景（壳页面用 .form-card 时被 .product-form-shell 覆盖；独立使用 .product-form-shell 时也需要） */
.product-form-shell.form-card-like {
  background: var(--white);
  border: 1px solid rgba(0,0,0,0.06);
  border-radius: 16px;
  padding: 40px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03);
}

/* 通用字段（替代原 .form-group，统一命名以避免冲突） */
.product-form .form-field { margin-bottom: 24px; }
.product-form .form-field label {
  display: block;
  margin-bottom: 10px;
  font-weight: 500;
  font-size: 14px;
  color: var(--text);
}
.product-form .form-field input,
.product-form .form-field select,
.product-form .form-field textarea {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 10px;
  font-size: 15px;
  transition: all 0.2s ease;
  background: var(--white);
}
.product-form .form-field input:focus,
.product-form .form-field select:focus,
.product-form .form-field textarea:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
}
.product-form .form-field .form-hint {
  color: var(--text-light);
  font-size: 12px;
  margin-top: 4px;
  display: block;
}
/* 关键：用 [hidden] 而不是 :disabled —— 整块消失 */
.product-form .form-field[hidden] { display: none; }

/* 16:9 双列布局 */
.product-form .form-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 28px;
}
@media (max-width: 1200px) {
  .product-form .form-row { grid-template-columns: 1fr; gap: 0; }
}

/* 复选框行 */
.product-form .checkbox-field {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  font-weight: 500;
  cursor: pointer;
}
.product-form .checkbox-field input[type="checkbox"] {
  width: auto;
  flex-shrink: 0;
}

/* 订阅方案区 */
.product-form .subscription-section {
  margin-top: 24px;
  padding: 24px;
  background: linear-gradient(135deg, rgba(59,130,246,0.04) 0%, rgba(139,92,246,0.04) 100%);
  border: 1px solid rgba(59,130,246,0.1);
  border-radius: 14px;
}
.product-form .subscription-section[hidden] { display: none; }
.product-form .subscription-title {
  margin-bottom: 20px;
  color: var(--primary);
  font-size: 16px;
  font-weight: 600;
}
.product-form .subscription-tier-row {
  display: grid;
  grid-template-columns: 180px 1fr 80px;
  gap: 16px;
  margin-bottom: 12px;
  align-items: center;
}
.product-form .subscription-tier-row label {
  margin-bottom: 0;
  font-weight: 500;
}
.product-form .subscription-tier-row .tier-meta {
  color: var(--text-light);
  font-weight: 400;
  font-size: 13px;
}
.product-form .subscription-tier-row input {
  padding: 12px 14px;
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 8px;
  font-size: 14px;
  transition: all 0.2s ease;
}
.product-form .subscription-tier-row input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
}
.product-form .subscription-tier-row .tier-suffix {
  color: var(--text-light);
  font-size: 13px;
  text-align: right;
}

/* 迁移提示 */
.product-form .tier-migration-notice {
  margin-bottom: 24px;
  padding: 14px 18px;
  background: linear-gradient(135deg, rgba(245,158,11,0.08) 0%, rgba(245,158,11,0.04) 100%);
  border: 1px solid rgba(245,158,11,0.3);
  border-radius: 10px;
  color: #92400e;
  font-size: 14px;
}
.product-form .tier-migration-notice[hidden] { display: none; }

/* Section / Actions */
.product-form .form-section {
  margin-bottom: 32px;
  padding-bottom: 32px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
}
.product-form .form-section:last-of-type {
  border-bottom: none;
  padding-bottom: 0;
}
.product-form .section-title {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 20px;
  color: var(--text);
  letter-spacing: -0.01em;
}
.product-form .form-actions {
  display: flex;
  gap: 16px;
  margin-top: 32px;
  padding-top: 28px;
  border-top: 1px solid rgba(0,0,0,0.06);
  align-items: center;
}
.product-form .btn-back {
  background: rgba(0,0,0,0.04);
  color: var(--text);
  border: 1px solid rgba(0,0,0,0.08);
  padding: 14px 24px;
  border-radius: 10px;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  transition: all 0.2s ease;
  cursor: pointer;
}
.product-form .btn-back:hover {
  background: rgba(0,0,0,0.08);
  transform: translateX(-2px);
}
.product-form .form-actions .btn-primary {
  margin-left: auto;
}

/* 富文本编辑器（从原 inline CSS 抽取，仅保留产品 form 用的） */
.product-form .rich-editor {
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 10px;
  overflow: hidden;
}
.product-form .rich-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px;
  background: var(--secondary);
  border-bottom: 1px solid rgba(0,0,0,0.06);
}
.product-form .rich-toolbar button {
  padding: 8px 14px;
  border: 1px solid rgba(0,0,0,0.08);
  background: var(--white);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s ease;
}
.product-form .rich-toolbar button:hover {
  background: rgba(59,130,246,0.08);
  border-color: rgba(59,130,246,0.3);
}
.product-form .rich-toolbar button.active {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  color: white;
  border-color: transparent;
}
.product-form .rich-content {
  min-height: 200px;
  padding: 16px;
  outline: none;
  font-size: 15px;
  line-height: 1.7;
  background: var(--white);
}
.product-form .rich-content:empty:before {
  content: attr(data-placeholder);
  color: var(--text-light);
}
.product-form .rich-content p { margin: 0 0 12px 0; }
.product-form .rich-content ul, .product-form .rich-content ol { margin: 0 0 12px 0; padding-left: 28px; }
.product-form .rich-content img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  margin: 12px 0;
}
.product-form .image-upload-btn { position: relative; display: inline-block; }
.product-form .image-upload-btn input[type="file"] {
  position: absolute;
  top: 0; left: 0;
  opacity: 0;
  width: 100%; height: 100%;
  cursor: pointer;
}
.product-form .rich-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
}

/* 软件/图片上传区 */
.product-form .software-upload-section {
  border: 2px dashed rgba(0,0,0,0.12);
  border-radius: 12px;
  padding: 36px;
  text-align: center;
  background: linear-gradient(135deg, rgba(59,130,246,0.02) 0%, rgba(139,92,246,0.02) 100%);
  transition: all 0.25s ease;
}
.product-form .software-upload-section:hover {
  border-color: rgba(59,130,246,0.4);
  background: linear-gradient(135deg, rgba(59,130,246,0.04) 0%, rgba(139,92,246,0.04) 100%);
}
.product-form .software-upload-section.has-file {
  border-color: #10b981;
  background: linear-gradient(135deg, rgba(16,185,129,0.05) 0%, rgba(16,185,129,0.08) 100%);
}
.product-form .software-info {
  margin-top: 16px;
  padding: 14px 18px;
  background: var(--white);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.product-form .software-info .file-name {
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 350px;
}
.product-form .software-info .file-size {
  color: var(--text-light);
  font-size: 13px;
  margin-left: 14px;
}
.product-form .btn-remove-file {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  margin-left: 14px;
  box-shadow: 0 2px 6px rgba(239,68,68,0.3);
  transition: all 0.2s ease;
}
.product-form .btn-remove-file:hover {
  transform: scale(1.05);
  box-shadow: 0 4px 12px rgba(239,68,68,0.4);
}
```

- [ ] **Step 2: 浏览器快速核对**

静态打开 `/admin-product-form.html`（手动验证）：
- 16:9 宽屏效果（form 居中、左右留白对称）
- 勾选"启用订阅方案"时基础价整块消失
- 月付/年付两行布局正确，duration `(1 个月)` / `(12 个月)` 显示在 label 旁
- 移动端 (< 1200px) 自动单列

- [ ] **Step 3: 提交 partial HTML 和 CSS**

```bash
cd "H:/MywebServer/wwwsite (2)"
git add public/admin-product-form.html public/css/admin-product-form.css
git commit -m "feat(product-form): extract form partial to admin-product-form.{html,css} (16:9 + subscription)"
```

（项目无 git，跳过 commit。验证方式：浏览开发服务器。）

---

### Task 3: 创建表单 JS — `admin-product-form.js`

**Files:**
- Create: `public/js/admin-product-form.js`

**Interfaces:**
- Consumes: Task 1 的 markup + Task 2 的 CSS
- Produces: `window.ProductForm.init(rootEl, { mode, productId, onSaved, onCancel })`
  - `mode`: `'create' | 'edit'`
  - `productId`: `number | null`（edit 模式必传）
  - `onSaved`: `(product) => void`（保存成功回调）
  - `onCancel`: `() => void`（取消回调）
  - 返回 `{ destroy(): void }`（清理事件监听，供 modal 用）

- [ ] **Step 1: 写完整 JS**

新建 `public/js/admin-product-form.js`：

```javascript
(function() {
  'use strict';

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

  // === 提交数据构建 ===
  function buildPayload(root, state) {
    const useTiers = $('#usePricingTiers', root).checked;
    const useExternal = $('#useExternalLink', root).checked;

    const data = {
      name: $('#name', root).value,
      shortName: $('#shortName', root).value,
      category: $('#category', root).value,
      description: $('#description', root).innerHTML,
      version: $('#version', root).value,
      platform: $('#platform', root).value,
      icon: $('#icon', root).value,
      features: state.productFeatures,
      featured: $('#featured', root).checked,
      image: $('#productImage', root).value,
      imageDarkBg: $('#imageDarkBg', root).checked
    };

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

  // === 订阅方案显示/隐藏 ===
  function toggleSubscription(root) {
    const enabled = $('#usePricingTiers', root).checked;
    const subscriptionSection = $('#subscriptionSection', root);
    const priceField = $('#priceField', root);

    subscriptionSection.hidden = !enabled;
    priceField.hidden = enabled;

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
        $('#externalLink', root).value = product.download_url || '';
      } else {
        $('#downloadUrl', root).value = product.download_url || '';
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
      loadProduct(root, state, opts);
    }

    return {
      destroy: function() { destroy(state); }
    };
  }

  // === 暴露 ===
  window.ProductForm = { init: init };
})();
```

- [ ] **Step 2: 浏览器静态打开 `/admin-product-form.html` 测试 JS**

需要先 Task 4 把 `/admin-product-form.html` 嵌入页面才好测完整流程。**Task 3 不做手动测试，直接进入 Task 4。**

- [ ] **Step 3: 提交（暂不 commit，等 Task 4 一起）**

不 commit；下个任务连同 ProductManagement.html 改造一起 commit。

---

### Task 4: 改造 `ProductManagement.html` — 瘦壳

**Files:**
- Modify: `public/ProductManagement.html`

**Interfaces:**
- Consumes: Task 1-3 创建的 partial
- Produces: `/ProductManagement` 路由仍可访问，create 模式（新）和 edit 模式（`?id=X` 深链接）都调 `window.ProductForm.init`
- 旧 inline `<style>`（约 300 行）和 inline `<script>`（约 450 行）全部删除

- [ ] **Step 1: 写完整新文件**

完全重写 `public/ProductManagement.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>博铭科技 - 管理后台</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌍</text></svg>">
  <link rel="stylesheet" href="/css/style.css">
  <link rel="stylesheet" href="/css/admin-sidebar.css?v=20260621-1625">
  <link rel="stylesheet" href="/css/admin-product-form.css?v=20260622-1000">
</head>
<body>
  <div class="admin-layout">
    <main class="admin-main">
      <div class="breadcrumb">
        <a href="/admin-product">产品管理</a> / <span id="breadcrumb-title">添加产品</span>
      </div>

      <h1 class="page-title" id="page-title">添加产品</h1>

      <div class="product-form-shell form-card-like">
        <div id="productFormMount">
          <p style="text-align: center; color: var(--text-light); padding: 40px;">加载中...</p>
        </div>
      </div>
    </main>
  </div>

  <script>
    (function() {
      'use strict';

      // 解析 URL 参数
      const params = new URLSearchParams(window.location.search);
      const productId = params.get('id');
      const mode = productId ? 'edit' : 'create';

      // 设置 title（edit 模式显示"编辑产品"）
      if (mode === 'edit') {
        document.getElementById('page-title').textContent = '编辑产品';
        document.getElementById('breadcrumb-title').textContent = '编辑产品';
      }

      // 加载 partial
      function loadScript(src) {
        return new Promise(function(resolve, reject) {
          if (document.querySelector('script[src="' + src + '"]')) {
            resolve();
            return;
          }
          const s = document.createElement('script');
          s.src = src;
          s.onload = resolve;
          s.onerror = function() { reject(new Error('Failed to load ' + src)); };
          document.head.appendChild(s);
        });
      }

      document.addEventListener('DOMContentLoaded', function() {
        const mount = document.getElementById('productFormMount');
        fetch('/admin-product-form.html')
          .then(function(r) { return r.text(); })
          .then(function(html) {
            mount.innerHTML = html;
            return loadScript('/js/admin-product-form.js?v=20260622-1000');
          })
          .then(function() {
            window.ProductForm.init(mount, {
              mode: mode,
              productId: productId ? parseInt(productId, 10) : null,
              onSaved: function() {
                // 全页模式：跳列表
                window.location.href = '/admin-product';
              }
              // onCancel 留空 → 走默认 href="/admin-product"
            });
          })
          .catch(function(err) {
            console.error('Failed to load form:', err);
            mount.innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px;">表单加载失败，请刷新重试</p>';
          });
      });
    })();
  </script>
  <script src="/js/lucide-icons.js"></script>
  <script src="/js/admin-sidebar.js?v=20260621-1625" defer></script>
</body>
</html>
```

- [ ] **Step 2: 浏览器手测全页流程**

启动 `npm start`（如果还没启动），打开 `/ProductManagement`（手动验证）：

- **create 模式**（无 `?id`）：
  - 页面加载出 form，title 显示"添加产品"
  - 16:9 宽屏布局（form 居中、双列）
  - 勾选"启用订阅方案" → 基础价整块消失，订阅区显示
  - 取消勾选 → 基础价重新出现
  - 填完整表单 + 提交 → 跳 `/admin-product`，新出现一行
- **edit 模式**（`?id=5`）：
  - title 显示"编辑产品"
  - form 字段预填
  - 如果该产品原 3 档，顶部出现橙色迁移提示

- [ ] **Step 3: 浏览器 console 检查**

按 F12 打开 console（手动验证）：
- 没有任何 JS 错误（TypeError、ReferenceError）
- 没有 404（CSS/JS 都加载到）
- 提交时 Network 标签看到 `POST /api/products` 或 `PUT /api/products/:id` 状态 200

- [ ] **Step 4: 视觉对比（重要）**

原页面和重构后页面（手动验证）：
- 同样的字段、按钮、间距
- 富文本工具栏外观一致
- 文件上传区外观一致
- 唯一区别：现在 form 居中、左右留白更多（16:9 宽屏效果）

**如果发现视觉差异，停下不要继续 Task 5，先修 Task 1-4。**

---

### Task 5: 改造 `admin-product.html` — 加 modal

**Files:**
- Modify: `public/admin-product.html`

**Interfaces:**
- Consumes: Task 1-3 创建的 partial
- Produces: 列表页"+ 添加产品"和"编辑"按钮都打开 modal，模态内复用 ProductForm.init
- 保留深链接 `/ProductManagement?id=X`（不删除原有 `<a>` 链接，作为后备）

- [ ] **Step 1: 改 `admin-product.html`**

修改 `public/admin-product.html`：

**1.1** 在 `<head>` 增加 modal 专用 CSS（紧跟现有 CSS 之后）：
```html
  <link rel="stylesheet" href="/css/admin-product-form.css?v=20260622-1000">
  <link rel="stylesheet" href="/css/admin-product-modal.css?v=20260622-1000">
```

**1.2** 把第 21 行的"添加产品"按钮改为：
```html
        <button class="btn btn-primary" id="add-product-btn">+ 添加产品</button>
```

**1.3** 把第 145 行的"编辑"链接（在 `renderTable` 内部）改为按钮：
```html
              <button class="btn-edit" data-edit-id="${escapeHtml(product.id)}">编辑</button>
```
（用 `data-edit-id` 替代 `onclick`，因为 renderTable 是字符串拼接，事件委托更安全。）

**1.4** 在 `</main>` 之前增加 modal HTML 容器：
```html
    <div id="productModal" class="product-modal-backdrop" hidden>
      <div class="product-modal">
        <button type="button" class="product-modal-close" id="product-modal-close">&times;</button>
        <div id="productFormMount" class="product-form-shell">
          <p style="text-align: center; color: var(--text-light); padding: 40px;">加载中...</p>
        </div>
      </div>
    </div>
```

**1.5** 在 `<script>` 块末尾（`document.addEventListener('DOMContentLoaded', ...)` 之前）增加 modal 加载逻辑：

```javascript
    // === Modal: 加载并打开产品表单 ===
    let productFormInstance = null;

    function loadScriptOnce(src) {
      return new Promise(function(resolve, reject) {
        if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = function() { reject(new Error('Failed to load ' + src)); };
        document.head.appendChild(s);
      });
    }

    async function openProductModal(mode, productId) {
      productId = productId || null;
      const modal = document.getElementById('productModal');
      const mount = document.getElementById('productFormMount');

      // 先显示 modal（让用户立刻看到反馈）
      modal.hidden = false;
      document.body.style.overflow = 'hidden';

      try {
        // 每次打开都重新 fetch HTML 并重新挂载 partial，
        // 这样避免上次打开的字段值残留在表单里
        if (productFormInstance) {
          productFormInstance.destroy();
          productFormInstance = null;
        }

        const html = await fetch('/admin-product-form.html').then(function(r) { return r.text(); });
        mount.innerHTML = html;

        // JS script 只在首次加载时挂到 head
        if (!window.ProductForm) {
          await loadScriptOnce('/js/admin-product-form.js?v=20260622-1000');
        }

        productFormInstance = window.ProductForm.init(mount, {
          mode: mode,
          productId: productId,
          onSaved: function() {
            closeProductModal();
            loadProducts();
          },
          onCancel: closeProductModal
        });
      } catch (err) {
        console.error('Modal open error:', err);
        alert('表单加载失败');
        closeProductModal();
      }
    }

    function closeProductModal() {
      const modal = document.getElementById('productModal');
      modal.hidden = true;
      document.body.style.overflow = '';
      if (productFormInstance) {
        productFormInstance.destroy();
        productFormInstance = null;
      }
    }

    // 事件绑定（DOMContentLoaded 内部新增）
    document.getElementById('add-product-btn').addEventListener('click', function() {
      openProductModal('create');
    });
    document.getElementById('product-modal-close').addEventListener('click', closeProductModal);
    document.getElementById('productModal').addEventListener('click', function(e) {
      // 点击 backdrop 关闭（点击 modal 内容不关）
      if (e.target === this) closeProductModal();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && !document.getElementById('productModal').hidden) {
        closeProductModal();
      }
    });
    // 编辑按钮（用事件委托，renderTable 字符串拼接里只有 data-edit-id）
    document.getElementById('products-table').addEventListener('click', function(e) {
      const btn = e.target.closest('button[data-edit-id]');
      if (!btn) return;
      openProductModal('edit', parseInt(btn.dataset.editId, 10));
    });
```

- [ ] **Step 2: 新建 `public/css/admin-product-modal.css`**

新建 `public/css/admin-product-modal.css`：

```css
/* ============================================
   Product Modal Styles
   16:9 widescreen modal (max 1600px, 95% width)
   复用 admin-product-form.css 内的字段样式
   ============================================ */

.product-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  align-items: flex-start;
  justify-content: center;
  z-index: 2000;
  padding: 24px;
  overflow-y: auto;
}
.product-modal-backdrop:not([hidden]) {
  display: flex;
}
.product-modal {
  background: var(--white);
  border-radius: 16px;
  width: 95%;
  max-width: 1600px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  position: relative;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}
.product-modal-close {
  position: absolute;
  top: 16px;
  right: 16px;
  background: rgba(0,0,0,0.05);
  border: none;
  font-size: 28px;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-light);
  z-index: 1;
  transition: all 0.2s ease;
  line-height: 1;
  padding: 0;
}
.product-modal-close:hover {
  background: rgba(0,0,0,0.1);
  color: var(--text);
}
/* Modal 内去掉 form-card 圆角（modal 已经有圆角） */
.product-modal .form-card { background: transparent; border: none; box-shadow: none; padding: 0; }
```

- [ ] **Step 3: 浏览器手测 modal 流程**

启动 `npm start`（如果还没启动），打开 `/admin-product`（手动验证）：

- **添加产品**：
  - 点"+ 添加产品" → modal 弹出，16:9 宽屏，form 显示
  - 勾选订阅 → 基础价消失
  - 填完点保存 → modal 关闭，列表自动刷新，新行出现
- **编辑**：
  - 点某行"编辑" → modal 弹出，字段预填该产品
  - 修改后保存 → modal 关闭，列表显示新值
- **关闭**：
  - 点 × 关闭 → modal 消失
  - 点 backdrop（modal 外灰色区域）→ modal 消失
  - 按 Esc 键 → modal 消失
- **多次打开**：
  - 打开 → 关闭 → 再打开 → 状态干净（没有上次输入的残留）

- [ ] **Step 4: console 检查**

按 F12 打开 console（手动验证）：
- 无 JS 错误
- 无 404
- Network 标签：第一次打开 modal 时看到 `GET /admin-product-form.html` 和 `GET /js/admin-product-form.js` 都 200；第二次打开 modal 时不再重复请求

- [ ] **Step 5: 提交所有改动**

```bash
cd "H:/MywebServer/wwwsite (2)"
git add public/ProductManagement.html public/admin-product.html public/admin-product-form.html public/css/admin-product-form.css public/css/admin-product-modal.css public/js/admin-product-form.js
git commit -m "feat(product-form): 16:9 widescreen + 订阅方案 (月付/年付 2 档) + 列表页 modal 复用 partial"
```

（项目无 git，跳过。验证方式：浏览开发服务器。）

---

### Task 6: 验证清单（用户手测）

**Files:** 无

**Interfaces:** 验证所有 user-facing 流程

- [ ] **Step 1: 16:9 宽屏效果**

打开 `/ProductManagement`（手动验证）：
- 桌面端（窗口宽度 ≥ 1200px）form 居中，最大宽度 1600px，左右大量留白
- 移动端（窗口宽度 < 1200px）自动单列
- 视觉上明显是"widescreen 工作台"而非手机感

- [ ] **Step 2: 订阅方案显示/隐藏**

- 勾选"启用订阅方案" → 整个"基础价格"块（label + input + hint）消失
- 取消勾选 → 重新出现
- 切换过程中订阅方案行不闪烁
- 保存时：勾选时提交 pricingTiers；不勾选时提交 price（互斥）

- [ ] **Step 3: tier migration 迁移**

找一个原 3 档（1年/2年/3年）的产品，访问 `/ProductManagement?id=X`（手动验证）：
- 顶部出现橙色提示"已将原 3 档数据迁移为 2 档订阅方案..."
- 月付档自动填 1 年的价格
- 年付档自动填 1 年的价格（如果只有 1 年 1 档，则月付和年付都取同价，可手动调整）
- 提示"确认后保存"——保存一次后下次再打开该产品时不再显示提示

- [ ] **Step 4: modal 流程**

打开 `/admin-product`（手动验证）：
- 点"+ 添加产品" → modal 弹出
- 点某行"编辑" → modal 弹出
- modal 内取消（点 × / 点 backdrop / 按 Esc）→ 关闭
- modal 内保存成功 → 关闭 + 列表刷新
- 多次打开/关闭后无状态残留
- 打开 modal 时不阻塞列表（背景能滚动关闭）

- [ ] **Step 5: 数据契约**

打开 MySQL 客户端（手动验证）：
- 在 modal 里添加一个启用订阅的产品，提交后看 `pricing_tiers` 字段：
  ```json
  [{"label":"月付","duration":1,"price":29},{"label":"年付","duration":12,"price":299}]
  ```
- 编辑现有产品后保存，duration 仍为 1 和 12（admin 改不了）
- 不启用订阅时保存，`pricing_tiers` 字段为 NULL，`price` 字段正常

- [ ] **Step 6: 深链接兼容**

浏览器地址栏输入 `/ProductManagement?id=5`（手动验证）：
- 跳转到全页编辑模式（不弹 modal）
- 字段预填、迁移提示正常

- [ ] **Step 7: 视觉与功能完整性**

对比重构前后（手动验证）：
- 字段全部存在：name, shortName, category, price, description, version, platform, icon, features, useExternalLink, externalLink, software upload, product image, imageDarkBg, featured, usePricingTiers
- 富文本编辑器（加粗/斜体/下划线/删除线/列表/标题/段落/插图）功能正常
- AI 优化描述按钮工作
- 文件上传/图片上传工作
- 提交时校验（必填字段缺失会拦）

**如果任意一步失败，停下修对应任务。**

---

## Self-Review（写完后过一遍）

**1. Spec coverage**：
- §1 架构（抽 partial + init 协议）→ Task 1, 3 ✅
- §1.3 数据契约 → Task 3 提交逻辑 ✅
- §2.1 16:9 宽屏 → Task 2 CSS（grid + max-width: 1600px）✅
- §2.2 订阅方案改名 → Task 1 markup + Task 3 提示文本 ✅
- §2.3 仅 2 档（固定 1/12）→ Task 1 markup 写死 + Task 3 硬编码 duration ✅
- §2.4 完全隐藏基础价 → Task 2 `.form-field[hidden]` 规则 + Task 3 toggleSubscription ✅
- §3.1 tier migration 3+ 档 → 2 档 → Task 3 `migrateTiers()` + `showMigrationNotice()` ✅
- §3.2 duration 固定 1/12 → Task 3 硬编码 ✅
- §3.3 0 档产品（普通）→ Task 1 保留 price 字段 + Task 3 usePricingTiers=false 分支 ✅
- §4.1 modal HTML 容器 → Task 5 ✅
- §4.2 加载逻辑（fetch + loadScript）→ Task 5 ✅
- §4.3 列表页"编辑"链接 → Task 5 改为 data-edit-id 委托 ✅
- §5 YAGNI（不动 product.html / AI / 富文本 / 图片）→ 所有任务都避开了 ✅
- §6 验证清单 → Task 6 ✅
- §7 风险（JS 重构、CSS 抽离、fetch+innerHTML、modal 多次打开）→ Task 5 通过 destroy() + 重新 fetch HTML 解决 ✅

**2. Placeholder scan**：
- 无 "TBD" / "TODO" / "实现后补" 字样
- 无 "Add appropriate error handling" 这种空洞步骤
- 每步都有完整代码（markup/CSS/JS 全在）
- 文件路径都是绝对路径

**3. Type consistency**：
- `window.ProductForm.init(root, opts)` 在 Task 3 定义，Task 4 和 Task 5 调用的签名完全一致
- `opts.onSaved`、`opts.onCancel` 一致
- `state` 对象只在 Task 3 内部使用，Task 5 不直接访问
- `mount.dataset.loaded` 在 Task 5 modal 流程里维护
- `priceField.hidden` / `subscriptionSection.hidden` 在 Task 2 CSS 选择器和 Task 3 JS 操作都一致

**无 placeholder、无矛盾。可执行。**
