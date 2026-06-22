# 课程型产品实施 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans

**Goal:** 给产品数据模型加 `is_course` 模式 + `product_links` 一对多表，让 admin 能创建/编辑课程型产品（无价格，多个第三方平台链接）

**Architecture:** 数据层 (migration + db.js) → API 层 (server.js) → 前端 partial (form HTML/CSS/JS) → 前台展示 (admin-product 列表 + product 详情) → 手测

**Tech Stack:** MySQL + Node.js + Express + 原生 JS（沿用 partial 模式）

## Global Constraints

- 沿用 `feedback_prisma_snake_case_consistency.md`：DB 列 snake_case（`is_course` / `sort_order`），API 字段 camelCase（`isCourse` / `sortOrder`）
- 沿用 `feedback_migration_completeness.md`：删/重命名 DOM ID 后必须 grep 所有页面 JS 修孤儿引用
- 沿用 `feedback_html_hidden_css_display_override.md`：modal 必用 `:not([hidden])` 限定，form 字段 hidden 整块消失用 `[hidden]` 属性（但已被显式 CSS 防御）
- 沿用 `feedback_admin_css_cache_bust.md`：改 admin-product-form.css 后必须给所有引用加 `?v=20260622-XXXX` 时间戳
- 项目非 git 仓库（per memory `project_server_management.md`）
- 沿用 partial API 模式 `window.ProductForm.init(rootEl, opts)`（Task 1-3 已建）
- 中文回复 + 代码标识符英文（memory `feedback_chinese_communication.md`）

---

## File Structure

**新建 1**：
- `migrate-2026-06-22-course-products.js`

**修改 8**：
- `prisma/schema.js`（加 model）
- `db.js`（加 3 函数 + 改 4 函数）
- `server.js`（改 POST/PUT 路由）
- `public/admin-product-form.html`（加 isCourse 复选框 + courseLinksSection）
- `public/css/admin-product-form.css`（加 .course-link-row 样式）
- `public/js/admin-product-form.js`（加 toggleCourse + 链接 CRUD + buildPayload 改）
- `public/admin-product.html`（列表价格列显示课程型）
- `public/product.html`（详情页课程型分支）

---

### Task 1: 数据层（migration + prisma schema + db.js 改造）

**Files:**
- Create: `migrate-2026-06-22-course-products.js`
- Modify: `prisma/schema.js`（加 `isCourse` 字段 + `ProductLink` model）
- Modify: `db.js`（加 3 函数 + 改 4 函数）

**Interfaces:**
- Consumes: 现有 products 表
- Produces: `is_course` 列 + `product_links` 表 + 3 个新函数

- [ ] **Step 1: 写 migration 脚本**

新建 `migrate-2026-06-22-course-products.js`：

```js
const db = require('../db');

(async () => {
  try {
    const conn = await db.getConnection();
    console.log('Migration 2026-06-22-course-products starting...');

    // 1. 加 is_course 列（幂等）
    const [cols] = await conn.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'is_course'
    `);
    if (cols.length === 0) {
      await conn.query(`ALTER TABLE products ADD COLUMN is_course INT DEFAULT 0`);
      console.log('✓ Added products.is_course column');
    } else {
      console.log('⊘ products.is_course already exists, skipping');
    }

    // 2. 新建 product_links 表（幂等）
    await conn.query(`
      CREATE TABLE IF NOT EXISTS product_links (
        id INT PRIMARY KEY AUTO_INCREMENT,
        product_id INT NOT NULL,
        platform VARCHAR(50) NOT NULL,
        url VARCHAR(500) NOT NULL,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product (product_id)
      )
    `);
    console.log('✓ product_links table created/verified');

    // 3. 现有产品全部 is_course=0（默认，无需 UPDATE）
    console.log('✓ All existing products default to is_course=0');

    conn.release();
    console.log('Migration 2026-06-22-course-products done.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
})();
```

- [ ] **Step 2: 改 prisma schema**

Read `prisma/schema.js`（约 50-150 行），找到 products model 字段定义 + 末尾的 "其他表" 区域。

加 `is_course Int? @default(0)` 到 Product model（实际映射 `is_course` 列）。

加新 ProductLink model（参考现有 model 格式）：
```js
model ProductLink {
  id         Int      @id @default(autoincrement())
  productId  Int      @map("product_id")
  platform   String   @db.VarChar(50)
  url        String   @db.VarChar(500)
  sortOrder  Int      @default(0) @map("sort_order")
  createdAt  DateTime @default(now()) @map("created_at")
  product    Product  @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@map("product_links")
  @@index([productId])
}
```

Product model 加反向关系：`links ProductLink[]`

- [ ] **Step 3: db.js 加 3 个新函数**

在 db.js 找到合适位置（参考现有 `pricing_tiers` 相关函数），加：

```js
async function getProductLinks(productId) {
  const [rows] = await pool.query(
    'SELECT id, platform, url, sort_order FROM product_links WHERE product_id = ? ORDER BY sort_order ASC, id ASC',
    [productId]
  );
  return rows.map(r => ({
    id: r.id,
    platform: r.platform,
    url: r.url,
    sortOrder: r.sort_order
  }));
}

async function setProductLinks(productId, links) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM product_links WHERE product_id = ?', [productId]);
    if (links && links.length > 0) {
      const values = links.map((link, i) => [productId, link.platform, link.url, i]);
      await conn.query(
        'INSERT INTO product_links (product_id, platform, url, sort_order) VALUES ?',
        [values]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getProductWithLinks(productId) {
  const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [productId]);
  if (rows.length === 0) return null;
  const product = rows[0];
  const links = await getProductLinks(productId);
  return {
    ...product,
    isCourse: product.is_course === 1 || product.is_course === true,
    pricingTiers: product.pricing_tiers ? JSON.parse(product.pricing_tiers) : null,
    courseLinks: links
  };
}
```

- [ ] **Step 4: db.js 改 4 个函数**

`createProduct`、`updateProduct`、`getProductById`、`getAllProducts`：

- 在 SELECT 返回字段加 `is_course AS isCourse`
- `createProduct`/`updateProduct` INSERT/UPDATE 字段加 `is_course`（从 `product.isCourse` 转 1/0）
- `createProduct` 接受 `courseLinks` 参数，事务里调 setProductLinks
- `updateProduct` 接受 `courseLinks` 参数，事务里调 setProductLinks
- `getProductById` / `getAllProducts` 返回 `isCourse` 字段

参考 spec §3 数据流。实现细节由 implementer 根据 db.js 现有代码风格决定。

- [ ] **Step 5: 验证**

```bash
cd "H:/MywebServer/wwwsite (2)"
node migrate-2026-06-22-course-products.js
# 预期输出: "Migration 2026-06-22-course-products done."

# 验证表存在
node -e "const db = require('./db'); db.getProductLinks(1).then(r => console.log('links for id=1:', r)).then(() => process.exit(0));"
# 预期: links for id=1: [] (空数组，现有产品无课程链接)
```

- [ ] **Step 6: 暂不 commit（项目无 git）**

---

### Task 2: server.js 改造

**Files:**
- Modify: `server.js`（改 POST/PUT /api/products 路由）

**Interfaces:**
- Consumes: Task 1 的 db.js 函数
- Produces: API 接受 `isCourse` + `courseLinks`

- [ ] **Step 1: 改 POST /api/products**

找到 `app.post('/api/products', requireAuth, async (req, res) => {`（约 line 2207）。

修改：从 `req.body` 提取 `isCourse` + `courseLinks`，传给 `db.createProduct(...)`。

```js
app.post('/api/products', requireAuth, async (req, res) => {
  try {
    const { isCourse, courseLinks, ...rest } = req.body;
    const product = await db.createProduct({
      ...rest,
      isCourse: isCourse === true || isCourse === 1,
      courseLinks: Array.isArray(courseLinks) ? courseLinks : []
    });
    res.json(product);
  } catch (err) {
    console.error('POST /api/products error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});
```

- [ ] **Step 2: 改 PUT /api/products/:id**

找到 `app.put('/api/products/:id', ...)`（约 line 2240），同样修改。

- [ ] **Step 3: 验证 API**

```bash
# 启动服务器（如果还没启动）
cd "H:/MywebServer/wwwsite (2)" && npm start &
sleep 4

# 测试创建课程型产品
curl -X POST http://localhost:15000/api/products \
  -H "Content-Type: application/json" \
  -b "session=test" \
  -d '{
    "name": "测试课程",
    "shortName": "test-course-1",
    "category": "效率工具",
    "isCourse": true,
    "courseLinks": [
      {"platform": "bilibili", "url": "https://www.bilibili.com/video/BV1xx"},
      {"platform": "github", "url": "https://github.com/test/repo"}
    ]
  }'
# 预期: 200/201，返回产品对象含 isCourse=true + courseLinks 数组
```

注：需要 admin 登录 session，可能需要先登录获取 cookie。用真实 admin 账号测试最稳。

- [ ] **Step 4: 暂不 commit**

---

### Task 3: form HTML + CSS 改造

**Files:**
- Modify: `public/admin-product-form.html`（加 `#isCourse` + `#courseLinksSection`）
- Modify: `public/css/admin-product-form.css`（加 `.course-link-row` 样式）

**Interfaces:**
- Consumes: 现有 partial markup + CSS
- Produces: 新 UI 元素（isCourse 复选框 + 链接列表容器）

- [ ] **Step 1: HTML — 加 isCourse 复选框**

Read `public/admin-product-form.html` 找 `usePricingTiers` 复选框（约 line 47-49）。

**改前**：
```html
    <div class="checkbox-field">
      <input type="checkbox" id="usePricingTiers" name="usePricingTiers">
      <label for="usePricingTiers">启用订阅方案（月付 / 年付）</label>
    </div>
```

**改后**（在 usePricingTiers 复选框**上面**插一个新复选框）：
```html
    <div class="checkbox-field course-field">
      <input type="checkbox" id="isCourse" name="isCourse">
      <label for="isCourse">课程型产品（无价格，仅链接 + 介绍）</label>
    </div>

    <div class="checkbox-field">
      <input type="checkbox" id="usePricingTiers" name="usePricingTiers">
      <label for="usePricingTiers">启用订阅方案（月付 / 年付）</label>
    </div>
```

- [ ] **Step 2: HTML — 加 courseLinksSection 容器**

找到 `subscriptionSection` 容器（约 line 51-60）。

**改前**：
```html
    <div class="subscription-section" id="subscriptionSection" hidden>
      ...
    </div>
```

**改后**（在 subscriptionSection **之前**插入 courseLinksSection）：
```html
    <div class="course-links-section" id="courseLinksSection" hidden>
      <h4 class="section-subtitle">课程链接</h4>
      <div id="course-links-list">
        <!-- 动态渲染行 -->
      </div>
      <button type="button" class="btn btn-outline" id="add-course-link-btn">
        + 添加链接
      </button>
    </div>

    <div class="subscription-section" id="subscriptionSection" hidden>
      ...
    </div>
```

- [ ] **Step 3: CSS — 加 .course-link-row 样式**

Edit `public/css/admin-product-form.css` 末尾追加：

```css
/* 课程链接区 */
.product-form .course-links-section {
  margin-top: 24px;
  padding: 24px;
  background: linear-gradient(135deg, rgba(139,92,246,0.04) 0%, rgba(59,130,246,0.04) 100%);
  border: 1px solid rgba(139,92,246,0.15);
  border-radius: 14px;
}
.product-form .course-links-section[hidden] { display: none; }
.product-form .course-links-section .section-subtitle {
  margin-bottom: 16px;
  color: #7c3aed;
  font-size: 16px;
  font-weight: 600;
}
.product-form .course-link-row {
  display: grid;
  grid-template-columns: 180px 200px 1fr 40px;
  gap: 12px;
  margin-bottom: 12px;
  align-items: center;
}
.product-form .course-link-row select,
.product-form .course-link-row input {
  padding: 10px 12px;
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 8px;
  font-size: 14px;
  background: var(--white);
}
.product-form .course-link-row input[type="url"] { width: 100%; }
.product-form .course-link-row .course-link-platform-custom { display: none; }
.product-form .course-link-row .course-link-platform-custom:not([hidden]) { display: block; }
.product-form .course-link-row .btn-remove-course-link {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: white;
  border: none;
  border-radius: 8px;
  width: 36px;
  height: 36px;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
  box-shadow: 0 2px 6px rgba(239,68,68,0.3);
  transition: all 0.2s ease;
}
.product-form .course-link-row .btn-remove-course-link:hover {
  transform: scale(1.05);
  box-shadow: 0 4px 12px rgba(239,68,68,0.4);
}
```

- [ ] **Step 4: 验证**

```bash
cd "H:/MywebServer/wwwsite (2)"
grep -c "id=\"isCourse\"" public/admin-product-form.html   # 期望 1
grep -c "id=\"courseLinksSection\"" public/admin-product-form.html  # 期望 1
grep -c "id=\"add-course-link-btn\"" public/admin-product-form.html  # 期望 1
grep -c "\.course-link-row" public/css/admin-product-form.css  # 期望 ≥5
```

- [ ] **Step 5: 暂不 commit**

---

### Task 4: form JS 改造

**Files:**
- Modify: `public/js/admin-product-form.js`（加 toggleCourse + 链接 CRUD + state.courseLinks + buildPayload 改）

**Interfaces:**
- Consumes: Task 3 的 HTML 元素
- Produces: 课程模式切换 + 链接列表管理 + buildPayload 接受 courseLinks

- [ ] **Step 1: 加 COURSE_PLATFORMS 常量**

在文件顶部 IIFE 内加：

```js
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
```

- [ ] **Step 2: createState 加 courseLinks 字段**

```js
function createState() {
  return {
    currentProduct: null,
    productFeatures: [],
    currentSoftwareFile: null,
    currentProductImage: null,
    monthlyPrice: 0,
    yearlyPrice: 0,
    courseLinks: [],  // 新增
    listeners: []
  };
}
```

- [ ] **Step 3: 加 toggleCourse 函数**

```js
function toggleCourse(root) {
  const isCourse = $('#isCourse', root).checked;
  const courseSection = $('#courseLinksSection', root);

  courseSection.hidden = !isCourse;

  if (isCourse) {
    // 隐藏其他 4 个区 + 清空值
    $('#priceField', root).hidden = true;
    $('#subscriptionSection', root).hidden = true;
    $('#externalLinkSection', root).hidden = true;
    $('#softwareUploadSection', root).hidden = true;
    $('#price', root).value = '';
    $('#tier-monthly-price', root).value = '';
    $('#tier-yearly-price', root).value = '';
    $('#usePricingTiers', root).checked = false;
    $('#useExternalLink', root).checked = false;
    $('#externalLink', root).value = '';
    state.courseLinks = [];  // 清空（用闭包 state，详见 init 注释）
    renderCourseLinks(root, state);
  } else {
    // 恢复显示（但 usePricingTiers/useExternalLink 自身逻辑由各自 toggle 决定）
    $('#priceField', root).hidden = false;
    // 订阅和外部链接的 visible 状态由它们自己的 usePricingTiers / useExternalLink 决定
  }
}
```

注：state 由 init 闭包传入；为了保持一致性，把 state 作为参数显式传递更稳：

```js
function toggleCourse(root, state) {
  const isCourse = $('#isCourse', root).checked;
  const courseSection = $('#courseLinksSection', root);

  courseSection.hidden = !isCourse;

  if (isCourse) {
    $('#priceField', root).hidden = true;
    $('#subscriptionSection', root).hidden = true;
    $('#externalLinkSection', root).hidden = true;
    $('#softwareUploadSection', root).hidden = true;
    $('#price', root).value = '';
    $('#tier-monthly-price', root).value = '';
    $('#tier-yearly-price', root).value = '';
    $('#usePricingTiers', root).checked = false;
    $('#useExternalLink', root).checked = false;
    $('#externalLink', root).value = '';
    state.courseLinks = [];
    renderCourseLinks(root, state);
  } else {
    $('#priceField', root).hidden = false;
  }
}
```

- [ ] **Step 4: 加 renderCourseLinks / addCourseLink / removeCourseLink / updateCourseLink 函数**

```js
function renderCourseLinks(root, state) {
  const list = $('#course-links-list', root);
  if (state.courseLinks.length === 0) {
    list.innerHTML = '<p style="color:var(--text-light);font-size:13px;padding:12px 0;">点击下方"+ 添加链接"按钮添加课程链接</p>';
    return;
  }
  list.innerHTML = state.courseLinks.map((link, i) =>
    '<div class="course-link-row" data-index="' + i + '">' +
      '<select class="course-link-platform" data-action="platform">' +
        buildPlatformOptions(link.platform) +
      '</select>' +
      '<input type="text" class="course-link-platform-custom" data-action="custom" placeholder="自定义标签"' +
        (link.platform === 'other' || link.platform.startsWith('custom:') ? '' : ' hidden') +
        ' value="' + escHtml(link.platform.startsWith('custom:') ? link.platform.slice(7) : '') + '">' +
      '<input type="url" class="course-link-url" data-action="url" placeholder="https://..." value="' + escHtml(link.url) + '">' +
      '<button type="button" class="btn-remove-course-link" data-action="remove">×</button>' +
    '</div>'
  ).join('');
}

function addCourseLink(root, state) {
  state.courseLinks.push({ platform: 'bilibili', url: '' });
  renderCourseLinks(root, state);
}

function removeCourseLink(root, state, index) {
  state.courseLinks.splice(index, 1);
  renderCourseLinks(root, state);
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
    link.platform = link.platform.startsWith('custom:') ? link.platform : link.platform;
  }
}
```

- [ ] **Step 5: buildPayload 加 isCourse + courseLinks**

```js
function buildPayload(root, state) {
  const useTiers = $('#usePricingTiers', root).checked;
  const useExternal = $('#useExternalLink', root).checked;
  const isCourse = $('#isCourse', root).checked;

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
    imageDarkBg: $('#imageDarkBg', root).checked,
    isCourse: isCourse
  };

  if (isCourse) {
    // 课程型：忽略价格/下载字段，提交链接列表
    data.price = 0;
    data.pricingTiers = null;
    data.downloadUrl = '';
    data.externalLink = false;
    data.courseLinks = state.courseLinks
      .filter(l => l.platform && l.url)  // 过滤空行
      .map(l => ({ platform: l.platform, url: l.url }));
  } else {
    if (useExternal) {
      data.downloadUrl = $('#externalLink', root).value;
      data.externalLink = true;
    } else {
      data.downloadUrl = $('#downloadUrl', root).value;
      data.externalLink = false;
    }
    if (useTiers) {
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
```

- [ ] **Step 6: init 函数加事件绑定 + 加载课程链接**

在 init 函数内加：

```js
// 课程型切换
state.listeners.push(bind(root, '#isCourse', 'change', function() {
  toggleCourse(root, state);
}));

// 互斥防御：勾 usePricingTiers 或 useExternalLink 时自动 uncheck isCourse
state.listeners.push(bind(root, '#usePricingTiers', 'change', function() {
  if (this.checked && $('#isCourse', root).checked) {
    $('#isCourse', root).checked = false;
    toggleCourse(root, state);
  }
  toggleSubscription(root);
}));
state.listeners.push(bind(root, '#useExternalLink', 'change', function() {
  if (this.checked && $('#isCourse', root).checked) {
    $('#isCourse', root).checked = false;
    toggleCourse(root, state);
  }
  toggleExternalLink(root);
}));

// 课程链接增删改
state.listeners.push(bind(root, '#add-course-link-btn', 'click', function() {
  addCourseLink(root, state);
}));
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
state.listeners.push(bind(root, '#course-links-list', 'change', function(e) {
  const row = e.target.closest('.course-link-row');
  if (!row) return;
  const i = parseInt(row.dataset.index, 10);
  if (e.target.dataset.action === 'platform') {
    updateCourseLinkField(root, state, i, 'platform', e.target.value);
    // 切换显示/隐藏 custom input
    const customInput = row.querySelector('.course-link-platform-custom');
    if (e.target.value === 'other') {
      customInput.hidden = false;
      syncCustomPlatform(root, state, i);
    } else {
      customInput.hidden = true;
    }
  }
}));
state.listeners.push(bind(root, '#course-links-list', 'click', function(e) {
  const row = e.target.closest('.course-link-row');
  if (!row) return;
  if (e.target.dataset.action === 'remove') {
    const i = parseInt(row.dataset.index, 10);
    removeCourseLink(root, state, i);
  }
}));
```

- [ ] **Step 7: loadProduct 加载课程链接**

在 `loadProduct` 函数内加：

```js
// 课程型加载
if (product.isCourse === true || product.isCourse === 1) {
  state.courseLinks = product.courseLinks || [];
  $('#isCourse', root).checked = true;
  toggleCourse(root, state);
  renderCourseLinks(root, state);
}
```

- [ ] **Step 8: 验证**

```bash
cd "H:/MywebServer/wwwsite (2)"
grep -c "toggleCourse" public/js/admin-product-form.js       # 期望 ≥3
grep -c "renderCourseLinks" public/js/admin-product-form.js   # 期望 ≥3
grep -c "courseLinks" public/js/admin-product-form.js         # 期望 ≥8
grep -c "COURSE_PLATFORMS" public/js/admin-product-form.js    # 期望 ≥2
```

- [ ] **Step 9: 暂不 commit**

---

### Task 5: admin-product.html 列表显示课程型

**Files:**
- Modify: `public/admin-product.html`（改 renderTable 价格列）

- [ ] **Step 1: 改 renderTable 价格列**

找到 `renderTable` 函数（admin-product.html line 121-151），改价格列显示：

**改前**（line 130-134）：
```js
let priceDisplay = '¥' + product.price;
if (hasTiers) {
  const tierPrices = savedTiers.map(t => t.label + ':¥' + t.price).join(' / ');
  priceDisplay = `<span class="badge badge-info">多方案</span><br><small style="color:#64748b;">${tierPrices}</small>`;
}
```

**改后**：
```js
let priceDisplay;
if (product.isCourse === true || product.isCourse === 1) {
  const linkCount = (product.courseLinks || []).length;
  priceDisplay = `<span class="badge badge-purple">课程型</span><br><small style="color:#64748b;">${linkCount} 个链接</small>`;
} else if (hasTiers) {
  const tierPrices = savedTiers.map(t => t.label + ':¥' + t.price).join(' / ');
  priceDisplay = `<span class="badge badge-info">多方案</span><br><small style="color:#64748b;">${tierPrices}</small>`;
} else {
  priceDisplay = '¥' + product.price;
}
```

- [ ] **Step 2: 加 .badge-purple 样式（如果项目没有）**

检查 `public/css/admin-theme.css` 或 `public/css/pages/admin.css` 有没有 `.badge-purple`：

```bash
grep -n "badge-purple" public/css/*.css public/css/pages/*.css 2>/dev/null
```

如果没有，在 `public/css/pages/admin.css`（或 admin-theme.css）追加：

```css
.badge-purple {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
  color: white;
}
```

- [ ] **Step 3: 验证**

```bash
cd "H:/MywebServer/wwwsite (2)"
grep -c "课程型" public/admin-product.html    # 期望 1
grep -c "badge-purple" public/admin-product.html  # 期望 1
```

- [ ] **Step 4: 暂不 commit**

---

### Task 6: product.html 详情页课程型分支

**Files:**
- Modify: `public/product.html`（详情页课程型分支）

- [ ] **Step 1: 找到价格/购买区域**

Read `public/product.html`，找到价格/购买按钮的 HTML 区域。

- [ ] **Step 2: 加课程型分支渲染**

在产品详情加载函数内（应在 `loadProduct()` 或类似函数内），加：

```js
// 课程型：替换价格/购买区为链接列表
if (product.isCourse === true || product.isCourse === 1) {
  const priceSection = document.querySelector('.price-section, .product-price, #price-section');
  if (priceSection) priceSection.hidden = true;

  const buyButton = document.querySelector('.buy-button, #buy-btn, [data-action="buy"]');
  if (buyButton) buyButton.hidden = true;

  const linksContainer = document.getElementById('course-links-container');
  if (linksContainer && Array.isArray(product.courseLinks)) {
    linksContainer.innerHTML = product.courseLinks.map(link => {
      const platformLabel = getPlatformLabel(link.platform);
      return '<a href="' + escHtml(link.url) + '" target="_blank" rel="noopener" class="course-link-card">' +
        '<span class="platform-name">' + escHtml(platformLabel) + '</span>' +
        '<span class="visit-icon">访问 →</span>' +
      '</a>';
    }).join('');
    linksContainer.hidden = false;
  }
}

function getPlatformLabel(platform) {
  if (platform && platform.startsWith('custom:')) return platform.slice(7);
  const found = COURSE_PLATFORMS.find(p => p.value === platform);
  return found ? found.label : platform;
}
```

注：实际 DOM 选择器和样式 class 由 implementer 根据 product.html 现有结构决定。**先 Read product.html 看结构再改**。

- [ ] **Step 3: 加 .course-link-card 样式（如果需要）**

在 product.html inline `<style>` 或外部 CSS 文件加：

```css
.course-link-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  background: linear-gradient(135deg, rgba(139,92,246,0.05) 0%, rgba(59,130,246,0.05) 100%);
  border: 1px solid rgba(139,92,246,0.2);
  border-radius: 10px;
  text-decoration: none;
  color: var(--text);
  margin-bottom: 12px;
  transition: all 0.2s ease;
}
.course-link-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(139,92,246,0.15);
  border-color: rgba(139,92,246,0.4);
}
.course-link-card .platform-name { font-weight: 500; }
.course-link-card .visit-icon { color: #7c3aed; font-weight: 500; }
```

- [ ] **Step 4: 加 #course-links-container 元素到 product.html 模板**

在适当位置（价格/购买区旁边或下方）加：

```html
<div id="course-links-container" hidden>
  <!-- 动态渲染课程链接卡片 -->
</div>
```

- [ ] **Step 5: 验证**

```bash
cd "H:/MywebServer/wwwsite (2)"
grep -c "isCourse" public/product.html  # 期望 ≥2
grep -c "course-links-container" public/product.html  # 期望 1
grep -c "course-link-card" public/product.html  # 期望 2 (HTML + CSS)
```

- [ ] **Step 6: 暂不 commit**

---

### Task 7: 浏览器手测验证

**Files:** 无

**Interfaces:** 验证全链路

- [ ] **Step 1: 启动服务器**

```bash
cd "H:/MywebServer/wwwsite (2)" && npm start
```

- [ ] **Step 2: 课程型产品创建流程**

打开 `http://localhost:15000/admin-product`：

- [ ] 点"+ 添加产品" → modal 弹出
- [ ] 勾选"课程型产品"复选框
- [ ] **基础价格、订阅方案、外部链接、软件上传 4 个区全部消失**
- [ ] 课程链接区显示
- [ ] 点"+ 添加链接" → 出现 1 行（平台 select + URL input + × 按钮）
- [ ] 选平台 = "B 站"，输入 URL = "https://www.bilibili.com/video/BV1xx"
- [ ] 点"+ 添加链接" → 出现第 2 行
- [ ] 选平台 = "其他"，custom input 显示，输入 "掘金"，URL = "https://juejin.cn/xxx"
- [ ] 点保存 → modal 关闭，列表出现新产品行，价格列显示"课程型 · 2 个链接"紫色 badge

- [ ] **Step 3: 课程型产品编辑**

- [ ] 点刚才创建的产品的"编辑" → modal 弹出
- [ ] **isCourse 复选框自动勾选**（预填）
- [ ] 课程链接列表显示 2 行（含自定义"掘金"）
- [ ] 修改某链接 URL + 保存 → 列表显示新值

- [ ] **Step 4: 互斥规则**

- [ ] 创建新产品，**不勾** isCourse
- [ ] 勾选 usePricingTiers（订阅） → 弹出订阅区
- [ ] **isCourse 不应自动 uncheck**（互斥只在 isCourse 已勾时反向）
- [ ] 取消订阅 + 勾 isCourse → usePricingTiers 自动 uncheck，订阅区消失

- [ ] **Step 5: 前台展示**

- [ ] 打开产品详情页 `http://localhost:15000/products/<slug>`（或对应课程型产品 URL）
- [ ] **价格区消失**
- [ ] **购买按钮消失**
- [ ] 显示链接卡片网格（B 站 + 掘金）
- [ ] 点链接 → 新标签打开 URL

- [ ] **Step 6: console 检查**

- [ ] F12 console 无 JS 错误、无 404
- [ ] Network：POST /api/products 状态 200/201
- [ ] PUT /api/products/:id 状态 200

- [ ] **Step 7: 数据持久化**

- [ ] 刷新 admin-product 列表，新产品仍在
- [ ] 刷新产品详情页，链接仍显示
- [ ] 重启服务器，链接仍在（持久化到 product_links 表）

**如果任何步骤失败，停下检查对应 Task。**

- [ ] **Step 8: 暂不 commit（项目无 git）**

---

## Summary

7 个 task 总计：
- 1 migration
- 1 schema 改
- 1 db.js 大改（+3 -3 / 改 4）
- 1 server.js 改
- 1 form HTML 改
- 1 form CSS 改
- 1 form JS 大改（+5 函数 / 改 2 函数 / +5 事件绑定）
- 1 admin-product 列表改
- 1 product.html 详情改
- 1 浏览器手测

约 9-10 个 subagent 任务（部分可合并）。
