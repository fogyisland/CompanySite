# 课程分类特性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在产品表单下拉框、首页轮播/卡片、admin 列表 3 处显示彩色分类 badge（企业产品/外站课程/企业内训/GitHub 仓库），根据 `isCourse` 状态动态切换可用分类。

**Architecture:** 复用现有 `products.category` VARCHAR 字段（无 DB 变更）。Form 下拉框根据 `isCourse` 切换 7 个软件分类 vs 2 个课程分类。3 处展示位置共用 helper 函数 `getCategoryBadgeClass(category)` 把分类名映射到 4 个新的 badge CSS class。

**Tech Stack:** Vanilla JS + 现有 CSS 体系（复用 `.badge-purple` 风格）+ 复用 products.category 字段（无 DB 变更）。

## Global Constraints

- **数据模型**：复用现有 `products.category` VARCHAR 字段（无 schema 变更）
- **数据值映射**：
  - 软件型（isCourse=0）：开发工具 / 设计软件 / 安全软件 / 效率工具 / 实用工具 / **企业产品** / **GitHub 仓库**（共 7 项）
  - 课程型（isCourse=1）：**外站课程** / **企业内训**（共 2 项）
- **Badge 颜色**（精确值）：
  - `.badge-enterprise-product` — 蓝渐变 `linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)`
  - `.badge-external-course` — 绿渐变 `linear-gradient(135deg, #10b981 0%, #059669 100%)`
  - `.badge-enterprise-internal` — 橙渐变 `linear-gradient(135deg, #f97316 0%, #ea580c 100%)`
  - `.badge-github-repo` — 黑渐变 `linear-gradient(135deg, #24292e 0%, #0d1117 100%)`
- **helper 函数名**：`getCategoryBadgeClass(category)` — 返回 CSS class 字符串
- **企业产品仅软件型可见**：form 下拉框 + admin 列表显示互斥
- **外站课程/企业内训仅课程型可见**：同上
- **GitHub 仓库仅软件型可见**：同上
- **中文 label 硬编码**：不做 i18n
- **CSS 兼容性**：复用现有 `.badge-purple` 基类风格（`display: inline-block; padding: 3px 10px; border-radius: 10px; font-size: 12px; font-weight: 500; color: white`）
- **DB 无迁移**：DB 已验证只有"实用工具"无冲突值
- **cache-bust**：所有 25 个 admin HTML 必须给 admin.css 加新 `?v=20260622-XXXX` 时间戳绕 7d immutable 缓存（per memory `feedback_admin_css_cache_bust.md`）
- **课程型产品同时显示 2 个 badge**：左对齐紫色"课程型" + 绿色"外站课程"/橙色"企业内训"（T5 既有紫色 badge 不变）
- **DB 列 snake_case / API 字段 camelCase**（per memory `feedback_prisma_snake_case_consistency.md`）

---

## File Structure

**修改 6 个文件**（无新建）：

1. `public/css/pages/admin.css` — 加 4 个 `.badge-*` 分类 badge 类
2. `public/css/pages/product-card.css` — 加 `.product-card-category-badge`（首页卡片用）
3. `public/index.html` — hero-carousel slide + product card 渲染分支 + 内联 helper
4. `public/admin-product-form.html` — 清空 `#category` `<select>` 的静态 `<option>`（改由 JS 动态渲染）
5. `public/js/admin-product-form.js` — 加 `updateCategoryOptions(root, isCourse)` + `getCategoryBadgeClass(category)` helper + 事件绑定
6. `public/admin-product.html` — renderTable 用动态 badge class + cache-bust 时间戳

**cache-bust 25 个 admin HTML**：所有 `admin-*.html`（不含 `admin-product-form.html` partial + `admin-list.html` 不加载 admin.css）都需 bump `?v=` 时间戳。

---

## Task 1: 添加 4 个分类 badge CSS 类（admin.css）

**Files:**
- Modify: `public/css/pages/admin.css:553` — 在 `.badge-purple` 之后追加 4 个新 badge 类

**Interfaces:**
- Consumes: 现有 `.badge-purple` 风格（已存在 line 545-553）
- Produces: `.badge-enterprise-product` / `.badge-external-course` / `.badge-enterprise-internal` / `.badge-github-repo` 4 个新 class

- [ ] **Step 1: 在 admin.css 末尾追加 4 个 badge 类**

打开 `public/css/pages/admin.css`，定位到 line 553（`.badge-purple` 块的 `}` 结束），在它之后插入以下 4 个块：

```css
/* 企业产品 - 蓝色 */
.badge-enterprise-product {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
  color: white;
}

/* 外站课程 - 绿色 */
.badge-external-course {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  color: white;
}

/* 企业内训 - 橙色 */
.badge-enterprise-internal {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
  color: white;
}

/* GitHub 仓库 - 黑色渐变（贴近 GitHub 品牌色 #24292e → #0d1117） */
.badge-github-repo {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  background: linear-gradient(135deg, #24292e 0%, #0d1117 100%);
  color: white;
}
```

- [ ] **Step 2: 验证 CSS 语法**

用 `Bash` 工具运行（Windows + Git Bash 环境）：
```bash
cd /h/MywebServer/"wwwsite (2)" && node -e "
const fs = require('fs');
const css = fs.readFileSync('public/css/pages/admin.css', 'utf8');
const classes = ['badge-enterprise-product','badge-external-course','badge-enterprise-internal','badge-github-repo'];
classes.forEach(c => {
  const re = new RegExp('\\.' + c + '\\\\s*{', 'g');
  const matches = css.match(re);
  if (!matches || matches.length !== 1) {
    console.error('FAIL: ' + c + ' count=' + (matches ? matches.length : 0));
    process.exit(1);
  }
  console.log('OK: ' + c);
});
"
```

预期输出：
```
OK: badge-enterprise-product
OK: badge-external-course
OK: badge-enterprise-internal
OK: badge-github-repo
```

- [ ] **Step 3: 提交**

```bash
cd /h/MywebServer/"wwwsite (2)" && git add public/css/pages/admin.css && git commit -m "feat(admin): add 4 category badge CSS classes (enterprise/external-course/enterprise-internal/github-repo)"
```

预期：`[main XXXXXX] feat(admin): add 4 category badge CSS classes...`

---

## Task 2: 添加 product-card 分类 badge 样式

**Files:**
- Modify: `public/css/pages/product-card.css` — 在文件末尾追加 `.product-card-category-badge` 类

**Interfaces:**
- Consumes: 现有 `.product-card-category` 文字 class（index.html line 491 用）
- Produces: `.product-card-category-badge`（首页产品卡片显示 badge 文字）

- [ ] **Step 1: 在 product-card.css 末尾追加 badge 样式**

打开 `public/css/pages/product-card.css`，定位到文件末尾（line 281 `@media (max-width: 480px)` 块结束后），在它之后插入以下块：

```css
/* Category Badge (覆盖 .product-card-category 文字) */
.product-card-category-badge {
  display: inline-block !important;
  padding: 3px 10px !important;
  border-radius: 10px !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  color: white !important;
  margin-bottom: 8px !important;
  background: #e5e5e5 !important;
  color: #333 !important;
}
```

注：基础样式用 `!important` 覆盖 `style.css` 已有 `.product-card-category` 的样式。默认背景 `#e5e5e5` + 文字 `#333`（中性灰），4 个具体分类的彩色渐变由 `.badge-enterprise-product` 等覆盖（在 HTML 中 class 同时包含 2 个）。

- [ ] **Step 2: 验证 CSS 语法**

```bash
cd /h/MywebServer/"wwwsite (2)" && node -e "
const fs = require('fs');
const css = fs.readFileSync('public/css/pages/product-card.css', 'utf8');
if (!/\\.product-card-category-badge\\s*{/.test(css)) {
  console.error('FAIL: .product-card-category-badge missing');
  process.exit(1);
}
console.log('OK: .product-card-category-badge present');
"
```

预期输出：`OK: .product-card-category-badge present`

- [ ] **Step 3: 提交**

```bash
cd /h/MywebServer/"wwwsite (2)" && git add public/css/pages/product-card.css && git commit -m "feat(product-card): add .product-card-category-badge style for category display"
```

---

## Task 3: index.html 首页 hero 轮播 + 产品卡片 badge 渲染

**Files:**
- Modify: `public/index.html:228` — hero-carousel slide 把"限时优惠"替换为 category badge
- Modify: `public/index.html:491` — product card 把 `.product-card-category` 文字 div 替换为 badge span
- Modify: `public/index.html:175-178` — 在 `<script>` 内联 JS 顶部加 `getCategoryBadgeClass` helper（在 `let currentSlide` 之前）

**Interfaces:**
- Consumes: `product.category` 字符串（API 返回值，可能为：开发工具/设计软件/安全软件/效率工具/实用工具/企业产品/外站课程/企业内训/GitHub 仓库）
- Produces: badge CSS class 字符串映射到 4 个新 badge 类

- [ ] **Step 1: 在 index.html `<script>` 标签顶部加 helper 函数**

打开 `public/index.html`，定位到 line 175 `<script>` 标签后的 `let currentSlide = 0;`（line 178），在它之前插入：

```js
    // 分类名 → badge CSS class 映射
    function getCategoryBadgeClass(category) {
      const map = {
        '企业产品': 'badge-enterprise-product',
        '外站课程': 'badge-external-course',
        '企业内训': 'badge-enterprise-internal',
        'GitHub 仓库': 'badge-github-repo'
      };
      return map[category] || 'product-card-category-badge';
    }
```

注：默认 class 是 `product-card-category-badge`（中性灰），4 个具体分类的彩色 class 由 admin.css 提供的 4 个 `.badge-*` 覆盖。

- [ ] **Step 2: 修改 hero-carousel slide 模板替换"限时优惠"**

打开 `public/index.html`，定位到 line 228（`<span class="hero-card-badge">限时优惠</span>`），替换为：

```html
                    <span class="hero-card-badge ${getCategoryBadgeClass(product.category)}">${product.category || '软件'}</span>
```

注：
- 保留 `hero-card-badge` 基类（已有样式：左上角定位 + 阴影）
- 加 `${getCategoryBadgeClass(...)}` 动态 class（4 个具体分类带彩色渐变）
- 文字用 `product.category` 替代硬编码"限时优惠"，fallback 为"软件"
- 此处**不需要** `escapeHtml` 因为 hero 数据是 admin 后台录入，trusted source；如果担心 XSS，可加：`${escapeHtml(product.category || '软件')}`（index.html 未定义 escapeHtml，但 cart.js 等处有）

- [ ] **Step 3: 修改 product card 模板替换分类文字**

打开 `public/index.html`，定位到 line 491（`<div class="product-card-category">${product.category || '软件'}</div>`），替换为：

```html
                <span class="product-card-category-badge ${getCategoryBadgeClass(product.category)}">${product.category || '软件'}</span>
```

注：
- 把 `<div>` 改成 `<span>`（badge 是 inline）
- 加 `${getCategoryBadgeClass(...)}` 动态 class
- `product-card-category-badge` 是 Task 2 新建的类，提供中性灰默认背景；4 个具体分类的彩色渐变由 4 个 `.badge-*` 覆盖

- [ ] **Step 4: 验证模板语法**

```bash
cd /h/MywebServer/"wwwsite (2)" && node -e "
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const checks = [
  ['getCategoryBadgeClass 定义', /function getCategoryBadgeClass\\(category\\)/],
  ['hero badge 替换', /hero-card-badge \\\$\\{getCategoryBadgeClass\\(product\\.category\\)\\}/],
  ['product card badge 替换', /product-card-category-badge \\\$\\{getCategoryBadgeClass\\(product\\.category\\)\\}/]
];
let pass = true;
checks.forEach(([name, re]) => {
  if (!re.test(html)) {
    console.error('FAIL: ' + name);
    pass = false;
  } else {
    console.log('OK: ' + name);
  }
});
process.exit(pass ? 0 : 1);
"
```

预期输出 3 行 `OK: ...`

- [ ] **Step 5: 提交**

```bash
cd /h/MywebServer/"wwwsite (2)" && git add public/index.html && git commit -m "feat(index): show category badge on hero carousel + product card"
```

---

## Task 4: admin-product-form 动态分类下拉框

**Files:**
- Modify: `public/admin-product-form.html:30-36` — 清空 `#category` `<select>` 的 5 个静态 `<option>`（保留空壳由 JS 动态渲染）
- Modify: `public/js/admin-product-form.js` — 加 `getCategoryBadgeClass()` + `updateCategoryOptions(root, isCourse)` + 3 处调用点（init / isCourse change / 互斥切换）

**Interfaces:**
- Consumes: `state.currentProduct?.isCourse`（来自 `loadProduct`）+ `$('#isCourse').checked` 状态变化
- Produces: `#category` `<select>` 内部的 `<option>` 列表（7 个软件 vs 2 个课程）

- [ ] **Step 1: 在 admin-product-form.html 清空 category select 的静态 options**

打开 `public/admin-product-form.html`，定位到 line 30-36：

```html
        <select id="category" name="category" required>
          <option value="开发工具">开发工具</option>
          <option value="设计软件">设计软件</option>
          <option value="安全软件">安全软件</option>
          <option value="效率工具">效率工具</option>
          <option value="实用工具">实用工具</option>
        </select>
```

替换为：

```html
        <select id="category" name="category" required>
          <!-- 由 admin-product-form.js updateCategoryOptions() 动态渲染 -->
        </select>
```

注：保留 `id="category"` + `name="category"` + `required`，仅清空 `<option>` 子节点。

- [ ] **Step 2: 在 admin-product-form.js 添加 helper + updateCategoryOptions 函数**

打开 `public/js/admin-product-form.js`，定位到 `buildPlatformOptions` 函数（line 19-23）之后、`$` helper（line 26）之前的位置，插入以下代码：

```js
  // 课程型产品分类下拉框渲染（软件 vs 课程）
  const SOFTWARE_CATEGORIES = ['开发工具', '设计软件', '安全软件', '效率工具', '实用工具', '企业产品', 'GitHub 仓库'];
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
      'GitHub 仓库': 'badge-github-repo'
    };
    return map[category] || 'badge-neutral';
  }
```

- [ ] **Step 3: 在 init 函数中初始化下拉框选项**

打开 `public/js/admin-product-form.js`，定位到 init 函数（line 551）开头的 `state = createState();`（line 557）之后、`root._productFormState = state;`（line 558）之后、事件绑定（line 562）之前，插入：

```js
    // 3. 根据当前 isCourse 状态初始化 category 下拉框
    updateCategoryOptions(root, !!state.currentProduct?.isCourse);
```

注：
- 新建模式：`state.currentProduct` 为 null → `!!null?.isCourse === false` → 渲染 7 个软件分类
- 编辑模式：先 `loadProduct()` 设置 `state.currentProduct.isCourse`（line 297-356），然后 `updateCategoryOptions` 根据值渲染对应列表
- 注意 `init` 内的 `loadSettings()` + `loadProduct()` 在第 716-719 行——需确认调用顺序

**重新查看 init 函数确认调用顺序**：当前 init 函数是 `loadSettings()` → `loadProduct()`（line 716-719）—— `loadProduct` 是 async 的，但 `init` 不 await 它。`updateCategoryOptions` 必须放在 `loadProduct` 完成**之后**。

**修正**：把 `updateCategoryOptions(root, !!state.currentProduct?.isCourse)` 调用移到 `loadProduct` 的 callback 中（修改 `loadProduct` 函数）。如果新建模式没有 callback 入口，则改 init 函数逻辑。

**实际方案**：把初始化逻辑改为：
```js
    // 2. 加载数据
    loadSettings();
    if (opts.mode === 'edit' && opts.productId) {
      loadProduct(root, state, opts).then(() => {
        updateCategoryOptions(root, !!state.currentProduct?.isCourse);
      });
    } else {
      // 新建模式：默认软件型分类
      updateCategoryOptions(root, false);
    }
```

**Step 3 修正版**：

打开 `public/js/admin-product-form.js`，定位到 line 715-719：

```js
    // 2. 加载数据
    loadSettings();
    if (opts.mode === 'edit' && opts.productId) {
      loadProduct(root, state, opts);
    }
```

替换为：

```js
    // 2. 加载数据
    loadSettings();
    if (opts.mode === 'edit' && opts.productId) {
      loadProduct(root, state, opts).then(function() {
        updateCategoryOptions(root, !!state.currentProduct?.isCourse);
      });
    } else {
      // 新建模式：默认软件型分类
      updateCategoryOptions(root, false);
    }
```

**注意**：`loadProduct` 函数当前没有 return（line 290-356）——需要给 `loadProduct` 末尾 `catch` 块前加 `return Promise.resolve()`（async 函数自动返回 Promise）。

打开 `loadProduct` 函数（line 290），定位到 `}` 之前的 `catch (err) {...}` 块（line 352-355），把它替换为：

```js
      }
    } catch (err) {
      console.error('Load product error:', err);
      alert('加载产品失败');
    }
  }
```

实际查看当前代码，loadProduct 已经是 async 函数（line 290 `async function loadProduct`），会自动返回 Promise。所以 Step 3 的 `.then()` 调用合法。

- [ ] **Step 4: 在 isCourse change 事件触发 updateCategoryOptions**

打开 `public/js/admin-product-form.js`，定位到 line 562-564：

```js
    state.listeners.push(bind(root, '#isCourse', 'change', function() {
      toggleCourse(root, state);
    }));
```

替换为：

```js
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
    }));
```

注：
- 切换前先读当前选中值
- 切换选项后，如果当前值在新的有效列表中，保留选中（避免误重置）
- 如果不在（例如从课程切到软件时 category=外站课程），自动选中第一个（HTML 默认行为）

- [ ] **Step 5: 在 2 处互斥切换位置同步 updateCategoryOptions**

打开 `public/js/admin-product-form.js`，定位到 line 567-573（`usePricingTiers` change 处理）和 line 576-582（`useExternalLink` change 处理），需要在这两处 `toggleCourse` 调用之前同步 category 状态。

**修改 line 567-573**：

```js
    // 互斥防御：勾 usePricingTiers 时自动 uncheck isCourse
    state.listeners.push(bind(root, '#usePricingTiers', 'change', function() {
      if (this.checked && $('#isCourse', root).checked) {
        $('#isCourse', root).checked = false;
        updateCategoryOptions(root, false);
        toggleCourse(root, state);
      }
      toggleSubscription(root);
    }));
```

**修改 line 576-582**：

```js
    // 互斥防御：勾 useExternalLink 时自动 uncheck isCourse
    state.listeners.push(bind(root, '#useExternalLink', 'change', function() {
      if (this.checked && $('#isCourse', root).checked) {
        $('#isCourse', root).checked = false;
        updateCategoryOptions(root, false);
        toggleCourse(root, state);
      }
      toggleExternalLink(root);
    }));
```

- [ ] **Step 6: 验证 JS 语法**

```bash
cd /h/MywebServer/"wwwsite (2)" && node -c public/js/admin-product-form.js && echo "OK: JS syntax valid"
```

预期输出：`OK: JS syntax valid`

- [ ] **Step 7: 验证 HTML 语法**

```bash
cd /h/MywebServer/"wwwsite (2)" && node -e "
const fs = require('fs');
const html = fs.readFileSync('public/admin-product-form.html', 'utf8');
// 必须保留 id='category' 和 required，去掉所有 <option>
if (!/id=\"category\"[^>]*required/.test(html)) {
  console.error('FAIL: id=category / required missing');
  process.exit(1);
}
const optionMatch = html.match(/<option[^>]*>[^<]*<\/option>/g);
if (optionMatch && optionMatch.length > 0) {
  console.error('FAIL: ' + optionMatch.length + ' <option> still present');
  process.exit(1);
}
console.log('OK: select empty, id/required preserved');
"
```

预期输出：`OK: select empty, id/required preserved`

- [ ] **Step 8: 提交**

```bash
cd /h/MywebServer/"wwwsite (2)" && git add public/admin-product-form.html public/js/admin-product-form.js && git commit -m "feat(admin-form): dynamic category select based on isCourse (7 software vs 2 course)"
```

---

## Task 5: admin-product.html 列表显示分类 badge

**Files:**
- Modify: `public/admin-product.html:156` — 把 `<span class="badge badge-neutral">${escapeHtml(product.category)}</span>` 替换为动态 badge class
- Modify: `public/admin-product.html:10` — bump `admin.css?v=20260622-1430` → `admin.css?v=20260622-XXXX`（新时间戳）

**Interfaces:**
- Consumes: `getCategoryBadgeClass(category)` helper（在 admin-product.html 内联 JS 中定义，与 form JS 的同名 helper 同源）
- Produces: 分类列动态 badge（4 个具体分类带彩色渐变，其他用中性灰）

- [ ] **Step 1: 在 admin-product.html 内联 JS 顶部加 helper 函数**

打开 `public/admin-product.html`，定位到 line 78-83：

```js
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
```

在它之后插入：

```js
    function getCategoryBadgeClass(category) {
      const map = {
        '企业产品': 'badge-enterprise-product',
        '外站课程': 'badge-external-course',
        '企业内训': 'badge-enterprise-internal',
        'GitHub 仓库': 'badge-github-repo'
      };
      return map[category] || 'badge-neutral';
    }
```

- [ ] **Step 2: 修改 renderTable 把分类列改为动态 badge**

打开 `public/admin-product.html`，定位到 line 156：

```js
            <td><span class="badge badge-neutral">${escapeHtml(product.category)}</span></td>
```

替换为：

```js
            <td><span class="badge ${getCategoryBadgeClass(product.category)}">${escapeHtml(product.category)}</span></td>
```

注：
- 保留 `badge` 基类
- 加 `${getCategoryBadgeClass(...)}` 动态 class（4 个具体分类带彩色渐变）
- 其他分类用 `badge-neutral`（中性灰）兜底
- 文字仍 escapeHtml 防 XSS

- [ ] **Step 3: 验证 JS 语法**

```bash
cd /h/MywebServer/"wwwsite (2)" && node -e "
const fs = require('fs');
const html = fs.readFileSync('public/admin-product.html', 'utf8');
const checks = [
  ['getCategoryBadgeClass 定义', /function getCategoryBadgeClass\\(category\\)/],
  ['renderTable badge 替换', /badge \\\$\\{getCategoryBadgeClass\\(product\\.category\\)\\}/]
];
let pass = true;
checks.forEach(([name, re]) => {
  if (!re.test(html)) {
    console.error('FAIL: ' + name);
    pass = false;
  } else {
    console.log('OK: ' + name);
  }
});
process.exit(pass ? 0 : 1);
"
```

预期输出 2 行 `OK: ...`

- [ ] **Step 4: bump admin-product.html cache-bust 时间戳**

打开 `public/admin-product.html`，定位到 line 10：

```html
  <link rel="stylesheet" href="/css/pages/admin.css?v=20260622-1430">
```

把 `?v=20260622-1430` 替换为新时间戳（用当前时间 `YYYYMMDD-HHMM`，例如 `?v=20260622-1600`）。**记录你使用的时间戳**——Task 6 的 25 个 admin HTML 都用同一个时间戳。

```html
  <link rel="stylesheet" href="/css/pages/admin.css?v=20260622-1600">
```

- [ ] **Step 5: 提交**

```bash
cd /h/MywebServer/"wwwsite (2)" && git add public/admin-product.html && git commit -m "feat(admin-product): show category badge in list + cache-bust admin.css"
```

---

## Task 6: cache-bust 24 个其他 admin HTML

**Files:**
- Modify: 24 个 admin HTML 文件，把 `admin.css?v=YYYYMMDD-HHMM` 替换为 Task 5 步骤 4 使用的新时间戳

**Interfaces:**
- Consumes: Task 5 步骤 4 记录的 `?v=YYYYMMDD-HHMM` 时间戳
- Produces: 所有 admin HTML 的 `admin.css` 引用都使用新时间戳

- [ ] **Step 1: 列出所有需要更新的 admin HTML**

运行：

```bash
cd /h/MywebServer/"wwwsite (2)" && grep -l "css/pages/admin.css?v=" public/admin-*.html | grep -v "admin-product-form.html" | grep -v "admin-product.html"
```

预期输出 23 个文件路径（admin-list.html 不引用 admin.css，已排除；admin-product-form.html 是 partial 也不引用，已排除；admin-product.html 已在 Task 5 更新，排除）。

**等等**——前面 `Bash` 工具显示 `admin-list.html` 也是 `NO:`（不引用 admin.css），所以 grep 输出会跳过它。确认 23 个文件需更新：

```
public/admin-activations.html
public/admin-ai.html
public/admin-api.html
public/admin-banners.html
public/admin-carddav.html
public/admin-dbsettings.html
public/admin-email.html
public/admin-faq.html
public/admin-installations.html
public/admin-log-activation.html
public/admin-log-login.html
public/admin-log-operation.html
public/admin-log-registration.html
public/admin-newsletter.html
public/admin-orders.html
public/admin-overview.html
public/admin-product-docs.html
public/admin-security.html
public/admin-settings.html
public/admin-ssl.html
public/admin-support.html
public/admin-telemetry.html
public/admin-user-software-status.html
```

实际是 23 个文件（admin-list.html 不引用 admin.css）。

- [ ] **Step 2: 批量替换所有时间戳**

把 Task 5 步骤 4 用的时间戳记为 `NEW_TIMESTAMP`（例如 `20260622-1600`）。

```bash
cd /h/MywebServer/"wwwsite (2)" && \
for f in public/admin-activations.html public/admin-ai.html public/admin-api.html public/admin-banners.html public/admin-carddav.html public/admin-dbsettings.html public/admin-email.html public/admin-faq.html public/admin-installations.html public/admin-log-activation.html public/admin-log-login.html public/admin-log-operation.html public/admin-log-registration.html public/admin-newsletter.html public/admin-orders.html public/admin-overview.html public/admin-product-docs.html public/admin-security.html public/admin-settings.html public/admin-ssl.html public/admin-support.html public/admin-telemetry.html public/admin-user-software-status.html; do
  sed -i 's|admin\.css?v=[0-9-]*|admin.css?v=NEW_TIMESTAMP|g' "$f"
done && echo "OK: 23 files updated"
```

**注意**：把命令里的 `NEW_TIMESTAMP` 替换为 Task 5 步骤 4 的实际时间戳（例如 `20260622-1600`）。

- [ ] **Step 3: 验证所有时间戳已同步**

```bash
cd /h/MywebServer/"wwwsite (2)" && grep -h "css/pages/admin.css?v=" public/admin-*.html | sort -u
```

预期输出：所有行都使用同一个新时间戳 `?v=NEW_TIMESTAMP`，加上 admin-product.html 也是。

```
  <link rel="stylesheet" href="/css/pages/admin.css?v=20260622-1600">
```

- [ ] **Step 4: 提交**

```bash
cd /h/MywebServer/"wwwsite (2)" && git add public/admin-*.html && git commit -m "chore(admin): cache-bust admin.css in 23 admin HTMLs to bypass 7d immutable cache"
```

---

## Task 7: 浏览器手测验证

**Files:** 无（仅手测）

- [ ] **Step 1: 启动 server**

```bash
cd /h/MywebServer/"wwwsite (2)" && npm start
```

预期：服务器启动在 `http://localhost:15000`，无报错。如果端口被占用，先用 PowerShell 杀掉 zombie node 进程（per memory `feedback_zombie_node_processes.md`）。

- [ ] **Step 2: 浏览器硬刷新 admin-product 页**

打开 `http://localhost:15000/admin-product`，按 `Ctrl+Shift+R` 硬刷新（绕 7d immutable 缓存）。

**验证清单**：
- [ ] 分类列显示彩色 badge（4 个具体分类：企业产品=蓝、外站课程=绿、企业内训=橙、GitHub 仓库=黑）
- [ ] 其他分类（开发工具/设计软件/安全软件/效率工具/实用工具）显示中性灰 badge
- [ ] 课程型产品的"分类"列显示"外站课程"/"企业内训"，"价格方案"列显示紫色"课程型"+ 链接数

- [ ] **Step 3: 浏览器硬刷新首页**

打开 `http://localhost:15000`，按 `Ctrl+Shift+R`。

**验证清单**：
- [ ] Hero 轮播图左上角 badge 显示分类名（不是"限时优惠"）
- [ ] 产品卡片左上角显示分类 badge（彩色渐变）
- [ ] 至少有一个产品显示"GitHub 仓库"黑色 badge（如已录入）

- [ ] **Step 4: 测试 admin form 切换**

进入 admin-product → 点"+ 添加产品"，验证：
- [ ] 默认下拉框显示 7 个软件分类（含"企业产品"+"GitHub 仓库"）
- [ ] 勾选"课程型产品" → 下拉框立即切换为 2 个课程分类（外站课程/企业内训）
- [ ] 取消勾选 → 下拉框恢复 7 个软件分类
- [ ] 编辑现有课程型产品 → 加载时下拉框自动显示 2 个课程分类（且当前 category 保留选中）
- [ ] 编辑现有软件型产品 → 加载时下拉框显示 7 个软件分类（且当前 category 保留选中）

- [ ] **Step 5: 错误检查**

打开浏览器 DevTools Console，验证：
- [ ] 无 JS 报错
- [ ] 无 CSS 加载失败（Network 标签）
- [ ] admin CSS 加载新时间戳（`admin.css?v=NEW_TIMESTAMP`）

- [ ] **Step 6: 提交（如果手测发现 bug）**

如手测发现 bug，先修复再单独提交（不与本任务混）。

- [ ] **Step 7: 标记完成**

```bash
echo "✅ 课程分类特性手测通过"
```

---

## Self-Review

**1. Spec coverage**：
- ✅ 数据模型（复用 category 字段）— 无 DB 变更（Task 1-6 无 db.js 修改）
- ✅ 软件分类 7 个 / 课程分类 2 个 — Task 4 Step 2 `SOFTWARE_CATEGORIES` + `COURSE_CATEGORIES`
- ✅ Badge 颜色（蓝/绿/橙/黑）— Task 1 Step 1 CSS class
- ✅ Form 下拉框动态切换 — Task 4 Step 2-5
- ✅ 首页 hero 轮播 badge — Task 3 Step 2
- ✅ 首页产品卡片 badge — Task 3 Step 3
- ✅ Admin 列表 badge — Task 5 Step 2
- ✅ helper 函数 `getCategoryBadgeClass` — Task 3 Step 1 / Task 4 Step 2 / Task 5 Step 1（3 处独立定义，与 spec 一致）
- ✅ cache-bust 25 个 admin HTML — Task 5 Step 4 + Task 6

**2. Placeholder scan**：
- 无 "TBD" / "TODO" / "类似 Task N" / "适当处理" 等占位符
- 每个步骤都有完整代码或精确命令

**3. Type consistency**：
- `getCategoryBadgeClass(category)` — 3 处定义签名一致（Task 3 / Task 4 / Task 5）
- `updateCategoryOptions(root, isCourse)` — Task 4 Step 2 定义 + Step 3-5 调用
- `badge-enterprise-product` / `badge-external-course` / `badge-enterprise-internal` / `badge-github-repo` — 4 个 CSS class 名在 Task 1 定义 + Task 3-5 引用

**4. Out of Scope 验证**：
- ❌ 课程分类筛选/搜索 — 未做
- ❌ 课程分类图标 — 未做（用文字 + 颜色）
- ❌ 自定义颜色 — 未做（4 个分类颜色固定）
- ❌ 课程分类排序 — 未做（保留 API 顺序）
- ❌ 课程分类国际化 — 未做（中文硬编码）
- ❌ 数据库层 CHECK 约束 — 未做（form 下拉框控制）
- ❌ 旧产品迁移脚本 — 未做（DB 仅存"实用工具"无冲突）

---

## Plan 完成

**Total: 7 tasks, ~30 minutes to implement**
- Task 1: CSS badges (5 min)
- Task 2: product-card.css badge class (3 min)
- Task 3: index.html hero + product card (5 min)
- Task 4: admin form dynamic category (8 min)
- Task 5: admin list badge + cache-bust (5 min)
- Task 6: cache-bust 23 other admin HTMLs (3 min)
- Task 7: browser smoke test (5 min)