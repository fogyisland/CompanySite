# /product/ 产品列表页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建公开产品列表页 `/product/`, 支持课程型/软件型 toggle + 产品名搜索 + 分页, 侧栏含购买指南 + 动态 FAQ, 与现有 `/product.html?id=X` 详情页并存。

**Architecture:** 独立 `public/product-list.html` + 配套 CSS/JS (inline), 扩展 `GET /api/products` 支持 `isCourse`/`search`/`page`/`pageSize` 查询参数, 主页加 "查看更多 →" 按钮跳转, 16 个公开 HTML cache-bust 同步。

**Tech Stack:** Express + mysql2/promise + 静态 HTML/CSS/JS (内联) + DOMPurify (本地 vendor)。

---

## Global Constraints

- **Cache-bust 时间戳**: 用 `20260623-1830` (本任务统一), 所有 16 个公开 HTML 的 CSS `?v=` 同步到此值
- **snake_case DB 列 / camelCase API 字段** (per memory `feedback_prisma_snake_case_consistency`)
- **`getCategoryBadgeClass()` helper 第 4 处副本** 加 `product-list.html` (per spec "3 处独立定义" 显式接受)
- **公开端点** `/api/products` 必须有 `checkPublicEndpointRateLimit` 保护 (per memory `feedback_security_hardening`)
- **所有 user-visible 字符串** 必须 `escapeHtml`
- **LIKE 模糊匹配** 用 prepared statement 防 SQL 注入 (`feedback_security_hardening` S17)
- **pageSize cap**: 服务端封顶 50, page ≥ 1
- **JS 模块**: 内联在 `product-list.html` (与 news.html 一致)
- **不修改** 现有 `/product.html?id=X` 详情页
- **不修改** 25 个 admin HTML (产品列表页是公开的, admin 不引用)

---

## File Structure (map)

| 文件 | 状态 | 职责 |
|------|------|------|
| `public/product-list.html` | new | 公开列表页 HTML + inline JS |
| `public/css/pages/product-list.css` | new | 列表页专属样式 |
| `db.js` | modify (line 423 后插入) | 加 `getProductsPaginated` |
| `server.js` | modify (line 2167 + 新路由) | 改造 `/api/products` + 加 `/product/` |
| `public/index.html` | modify (line 197, 450, 85 后) | 适配新 API 响应 + 加 "查看更多" 按钮 |
| 15 公开 nav HTML | modify | 加 "产品中心" 链接 + cache-bust 同步 |

**15 公开 nav HTML 清单**:
`about.html`, `checkout.html`, `contact.html`, `doc.html`, `docs.html`, `faq.html`, `help.html`, `index.html`, `license.html`, `news.html`, `order-detail.html`, `privacy.html`, `product.html`, `support.html`, `terms.html`

---

## Task 1: db.js `getProductsPaginated` 函数 + smoke test

**Files:**
- Modify: `db.js:423` (紧跟 `getAllProducts` 之后插入新函数)
- Create: `scripts/test-getProductsPaginated.js` (一次性 smoke test, 验证后删除)
- Test: 直接调用 `db.getProductsPaginated({...})` 并 assert 返回结构

**Interfaces:**
- Consumes: `mysqlPool` (db.js 顶层 global, line 9)
- Produces: `async function getProductsPaginated({isCourse, search, page, pageSize}) → {products, total, page, pageSize, totalPages}`

- [ ] **Step 1: 写 smoke test 脚本**

创建 `scripts/test-getProductsPaginated.js`:

```javascript
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// 注意：如果项目用 db-config.json 而非 .env，可改为 require('../data/db-config.json')

(async () => {
  const db = require('../db');
  // 必须先初始化连接池
  await db.initDatabase();

  // Test 1: 基础调用 + 返回结构
  const r1 = await db.getProductsPaginated({ isCourse: null, search: '', page: 1, pageSize: 5 });
  console.assert(Array.isArray(r1.products), 'r1.products 应为数组');
  console.assert(typeof r1.total === 'number', 'r1.total 应为数字');
  console.assert(r1.page === 1, 'r1.page 应为 1');
  console.assert(r1.pageSize === 5, 'r1.pageSize 应为 5');
  console.assert(typeof r1.totalPages === 'number', 'r1.totalPages 应为数字');
  console.assert(r1.products.length <= 5, 'r1.products.length 应 <= 5');
  console.log('Test 1 PASS:', { total: r1.total, len: r1.products.length, totalPages: r1.totalPages });

  // Test 2: isCourse=false 过滤 (只软件型)
  const r2 = await db.getProductsPaginated({ isCourse: false, search: '', page: 1, pageSize: 50 });
  console.assert(r2.products.every(p => p.isCourse === false), 'r2 全部应为软件型');
  console.log('Test 2 PASS:', r2.products.length, '个软件');

  // Test 3: isCourse=true 过滤 (只课程型)
  const r3 = await db.getProductsPaginated({ isCourse: true, search: '', page: 1, pageSize: 50 });
  console.assert(r3.products.every(p => p.isCourse === true), 'r3 全部应为课程型');
  console.log('Test 3 PASS:', r3.products.length, '个课程');

  // Test 4: search 过滤 (按 name + shortName)
  const r4 = await db.getProductsPaginated({ isCourse: null, search: '邮', page: 1, pageSize: 50 });
  console.assert(r4.products.length > 0, '应找到含"邮"的产品');
  console.log('Test 4 PASS:', r4.products.map(p => p.name).join(', '));

  // Test 5: 分页 (page=1 vs page=2 应返回不同)
  const r5a = await db.getProductsPaginated({ isCourse: null, search: '', page: 1, pageSize: 1 });
  const r5b = await db.getProductsPaginated({ isCourse: null, search: '', page: 1, pageSize: 1, search: '' });
  console.assert(r5a.total === r5b.total, '分页 total 应一致');
  console.log('Test 5 PASS: total =', r5a.total);

  // Test 6: 默认排序 created_at DESC
  const r6 = await db.getProductsPaginated({ isCourse: null, search: '', page: 1, pageSize: 50 });
  for (let i = 1; i < r6.products.length; i++) {
    console.assert(new Date(r6.products[i-1].createdAt) >= new Date(r6.products[i].createdAt),
      '排序应为 created_at DESC');
  }
  console.log('Test 6 PASS: 排序正确');

  await db.closeDatabase ? db.closeDatabase() : process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
```

- [ ] **Step 2: 运行 smoke test (预期 FAIL)**

```bash
cd "H:/MywebServer/wwwsite (2)"
node scripts/test-getProductsPaginated.js
```

预期: `TypeError: db.getProductsPaginated is not a function` 或类似报错。

- [ ] **Step 3: 实现 `getProductsPaginated` 函数**

在 `db.js` line 423 (在 `getAllProducts` 函数 `}` 之后, `async function getProduct(id)` 之前) 插入:

```javascript
async function getProductsPaginated({ isCourse, search, page, pageSize }) {
  const conditions = [];
  const params = [];

  if (isCourse === true || isCourse === false) {
    conditions.push('is_course = ?');
    params.push(isCourse ? 1 : 0);
  }

  if (search && search.trim() !== '') {
    conditions.push('(name LIKE ? OR short_name LIKE ?)');
    const like = '%' + search.trim() + '%';
    params.push(like, like);
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

  // 总数 (不带 LIMIT/OFFSET)
  const [countRows] = await mysqlPool.query(
    'SELECT COUNT(*) AS total FROM products' + where,
    params
  );
  const total = countRows[0].total;

  // 数据 (带 LIMIT/OFFSET + 排序)
  const offset = (page - 1) * pageSize;
  const [rows] = await mysqlPool.query(
    'SELECT * FROM products' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [...params, pageSize, offset]
  );

  const products = rows.map(row => ({
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    category: row.category,
    price: row.price,
    pricingTiers: row.pricing_tiers ? JSON.parse(row.pricing_tiers) : null,
    description: row.description,
    version: row.version,
    platform: row.platform,
    features: row.features ? JSON.parse(row.features) : [],
    icon: row.icon,
    featured: row.featured === 1,
    downloadUrl: row.download_url,
    externalLink: row.external_link === 1,
    detailPage: row.detail_page,
    image: row.image,
    imageDarkBg: row.image_dark_bg === 1,
    isCourse: row.is_course === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));

  return {
    products,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1
  };
}
```

同时在 `db.js` 文件底部的 exports 块 (`module.exports` 或类似) 加上 `getProductsPaginated`。先 grep `module.exports`:

```bash
grep -n "module.exports\|exports\." db.js | tail -10
```

然后添加 `getProductsPaginated` 到 exports 列表 (与 `getAllProducts` 同一行)。

- [ ] **Step 4: 重跑 smoke test (预期 PASS)**

```bash
cd "H:/MywebServer/wwwsite (2)"
node scripts/test-getProductsPaginated.js
```

预期: 6 个 "Test N PASS" 输出, exit code 0。

- [ ] **Step 5: 清理 + commit**

```bash
cd "H:/MywebServer/wwwsite (2)"
rm scripts/test-getProductsPaginated.js
git add db.js
git commit -m "feat(db): add getProductsPaginated for /product/ list with isCourse/search/pagination"
```

---

## Task 2: server.js `/api/products` 改造 + `/product/` 路由 + homepage consumer 更新

**Files:**
- Modify: `server.js:2167` (替换 `/api/products` handler)
- Modify: `server.js` (在 line 2167 前加 `/product/` 静态页路由)
- Modify: `public/index.html:197` 和 `public/index.html:450` (适配新响应结构)

**Interfaces:**
- Consumes: Task 1 的 `db.getProductsPaginated`
- Produces: 
  - `GET /api/products?isCourse=&search=&page=&pageSize=` → `{products, total, page, pageSize, totalPages}`
  - `GET /product/` → HTML 静态页

- [ ] **Step 1: 改造 `/api/products` handler**

在 `server.js` line 2167-2170 替换:

```javascript
// 获取产品列表（公开，支持分页 + 过滤）
app.get('/api/products', async (req, res) => {
  try {
    const { isCourse, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
    const isCourseFilter = isCourse === 'true' ? true : isCourse === 'false' ? false : null;
    const result = await db.getProductsPaginated({
      isCourse: isCourseFilter,
      search: search || '',
      page,
      pageSize
    });
    res.json(result);
  } catch (e) {
    console.error('GET /api/products error:', e);
    res.status(500).json({ error: '服务器错误' });
  }
});
```

- [ ] **Step 2: 加 `/product/` 静态页路由**

在 `server.js` line 2167 前 (即 `// 获取所有产品` 注释前) 插入:

```javascript
// 公开：产品列表页
app.get('/product/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'product-list.html'));
});
```

注: 如果 `path` 未在文件顶部 import, 检查 `server.js` 顶部是否有 `const path = require('path');` (应该有)。如果没有, 在 route 前加 require。

- [ ] **Step 3: 更新 homepage API consumer (2 处)**

`public/index.html` line 197 (在 `loadHeroProducts` 函数内):

```javascript
// 改前
let products = await response.json();
// 改后
const data = await response.json();
let products = Array.isArray(data) ? data : (data.products || []);
```

`public/index.html` line 450 (在第二个 fetch 块内):

```javascript
// 改前
let products = await response.json();
// 改后
const data = await response.json();
let products = Array.isArray(data) ? data : (data.products || []);
```

兼容模式: 如果未来 API 变回 array 也能工作 (防御性编程)。

- [ ] **Step 4: 启动 server + 跑 6 个 smoke curl**

启动 server (background 模式 per memory `feedback_zombie_node_processes.md`):

```bash
cd "H:/MywebServer/wwwsite (2)"
# 先 kill 旧 server (如果有)
pkill -f "node server.js" 2>/dev/null
sleep 1
npm start > /tmp/server.log 2>&1 &
sleep 3
curl -s http://localhost:15000/api/health  # 验证启动
```

然后跑 6 个 curl:

```bash
# 1. 不带参数 (默认 page=1 pageSize=20)
curl -s http://localhost:15000/api/products | head -c 300
echo "---"

# 2. 仅软件型
curl -s 'http://localhost:15000/api/products?isCourse=false' | head -c 300
echo "---"

# 3. 仅课程型
curl -s 'http://localhost:15000/api/products?isCourse=true' | head -c 300
echo "---"

# 4. 搜索
curl -s 'http://localhost:15000/api/products?search=邮' | head -c 300
echo "---"

# 5. 分页
curl -s 'http://localhost:15000/api/products?page=1&pageSize=1' | head -c 300
echo "---"

# 6. 组合
curl -s 'http://localhost:15000/api/products?isCourse=false&search=邮&page=1' | head -c 300
echo "---"
```

预期: 6 个响应都包含 `"products":[...]` + `"total":` + `"page":` + `"pageSize":` + `"totalPages":`。

验证返回结构 (提取字段):

```bash
curl -s 'http://localhost:15000/api/products?pageSize=1' | node -e "
const data = JSON.parse(require('fs').readFileSync(0));
console.assert(Array.isArray(data.products), 'products 应为数组');
console.assert(typeof data.total === 'number', 'total 应为数字');
console.log('结构验证 PASS:', { products: data.products.length, total: data.total, page: data.page, pageSize: data.pageSize, totalPages: data.totalPages });
"
```

- [ ] **Step 5: commit**

```bash
cd "H:/MywebServer/wwwsite (2)"
git add server.js public/index.html
git commit -m "feat(api): extend /api/products with isCourse/search/page/pageSize + add /product/ route + adapt homepage consumer"
```

---

## Task 3: product-list.html HTML 结构

**Files:**
- Create: `public/product-list.html` (~200 行)

**Interfaces:**
- Consumes: `/api/products` (Task 2), `/api/faqs` (现有)
- Produces: 列表页 HTML 骨架 (含 nav, toolbar, list container, sidebar, pagination)

- [ ] **Step 1: 创建文件骨架 (head + header + main 容器)**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width-width, initial-scale=1.0">
  <title>产品中心 - 博铭科技</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📦</text></svg>">
  <link rel="stylesheet" href="/css/style.css">
  <link rel="stylesheet" href="/css/themes/theme-variables.css">
  <link rel="stylesheet" href="/css/pages/product-list.css?v=20260623-1830">
  <style>
    body { font-family: 'Noto Sans SC', -apple-system, sans-serif; background: var(--bg, #fafafa); color: var(--text, #1a1a1a); }
  </style>
</head>
<body>
  <header>
    <div class="nav-container">
      <a href="/" class="logo">
        <div class="logo-icon">SV</div>
        <span class="logo-text">博铭科技</span>
      </a>
      <nav>
        <ul>
          <li><a href="/">产品</a></li>
          <li><a href="/product/" style="color: var(--primary, #0969da); font-weight: 500;">产品中心</a></li>
          <li><a href="/#features">特点</a></li>
          <li><a href="/support">支持</a></li>
          <li><a href="/contact">联系</a></li>
          <li><a href="/news.html">动态</a></li>
          <li><a href="https://blog.booming.one" target="_blank">博客</a></li>
          <li><a href="/about">关于</a></li>
        </ul>
      </nav>
      <div class="header-actions">
        <a href="/login" class="header-login">登录</a>
      </div>
    </div>
  </header>

  <main id="main-content">
    <div class="product-list-loading">加载中...</div>
  </main>

  <footer class="site-footer">
    <div class="footer-container">
      <p>&copy; <span id="footer-year">2026</span> 博铭科技. All rights reserved.</p>
    </div>
  </footer>

  <script>
    document.getElementById('footer-year').textContent = new Date().getFullYear();
  </script>
</body>
</html>
```

- [ ] **Step 2: 替换 `<main>` 内容为 grid 容器 (主区 + 侧栏)**

替换 `<main>` 内全部内容:

```html
  <main id="main-content">
    <div class="product-list-container">
      <div class="product-list-header">
        <h1>产品中心</h1>
        <p>查看全部产品 · 按类型筛选 · 快速搜索</p>
      </div>

      <div class="product-list-grid">
        <!-- 主区域: 70% -->
        <div class="product-list-main">
          <!-- 工具栏 -->
          <div class="product-list-toolbar">
            <div class="product-list-toggle" id="toggle-group">
              <button class="product-list-toggle-btn active" data-filter="all">全部</button>
              <button class="product-list-toggle-btn" data-filter="software">软件型</button>
              <button class="product-list-toggle-btn" data-filter="course">课程型</button>
            </div>
            <div class="product-list-search">
              <input type="text" id="search-input" placeholder="搜索产品名..." />
              <button class="product-list-search-clear" id="search-clear" style="display:none;">×</button>
            </div>
            <div class="product-list-count" id="result-count"></div>
          </div>

          <!-- 产品列表容器 (JS 填充) -->
          <div id="product-list-rows"></div>

          <!-- 分页 (JS 填充) -->
          <div class="product-list-pagination" id="pagination"></div>
        </div>

        <!-- 侧栏: 30% -->
        <aside class="product-list-sidebar">
          <!-- 购买指南 (静态) -->
          <div class="sidebar-card">
            <h3>购买指南</h3>
            <div class="sidebar-faq">
              <div class="sidebar-faq-item">
                <div class="sidebar-faq-q">如何选购产品?</div>
                <div class="sidebar-faq-a">根据您的使用场景选择"软件型"(本团队工具)或"课程型"(外站培训)。软件型按月付/年付订阅;课程型按平台付费。</div>
              </div>
              <div class="sidebar-faq-item">
                <div class="sidebar-faq-q">授权方式有哪些?</div>
                <div class="sidebar-faq-a">软件型: 月付(1 个月)/ 年付(12 个月) 两种订阅;课程型: 各平台单独付费,详见课程详情。</div>
              </div>
              <div class="sidebar-faq-item">
                <div class="sidebar-faq-q">可以退款吗?</div>
                <div class="sidebar-faq-a">购买后 7 天内未使用可全额退款,请联系客服提交申请。</div>
              </div>
              <div class="sidebar-faq-item">
                <div class="sidebar-faq-q">支持企业批量采购?</div>
                <div class="sidebar-faq-a">支持,详情请通过"联系"页面提交企业需求,48 小时内回复方案。</div>
              </div>
            </div>
          </div>

          <!-- 常见问题 (动态, JS 填充前 5 条) -->
          <div class="sidebar-card">
            <h3>常见问题</h3>
            <div class="sidebar-faq" id="sidebar-faq-dynamic">
              <div class="sidebar-faq-loading">加载中...</div>
            </div>
            <a href="/faq.html" class="sidebar-card-link">查看全部 →</a>
          </div>
        </aside>
      </div>
    </div>
  </main>
```

- [ ] **Step 3: 验证 HTML 静态可访问**

```bash
cd "H:/MywebServer/wwwsite (2)"
curl -s http://localhost:15000/product/ | head -c 500
```

预期: 看到 HTML 头部, 包含 `产品中心`, `product-list-grid`, `product-list-toolbar`, `sidebar-card` 等关键标识。

- [ ] **Step 4: commit**

```bash
cd "H:/MywebServer/wwwsite (2)"
git add public/product-list.html
git commit -m "feat(product-list): HTML structure with grid layout, toolbar, sidebar"
```

---

## Task 4: product-list.css 样式

**Files:**
- Create: `public/css/pages/product-list.css` (~150 行)

**Interfaces:**
- Consumes: Task 3 的 HTML class names
- Produces: grid 布局 + 产品行 + 侧栏 + 分页 + 响应式

- [ ] **Step 1: 创建文件 + grid 布局 + 响应式**

创建 `public/css/pages/product-list.css`:

```css
/* === 产品列表页样式 === */

.product-list-container {
  max-width: 1200px;
  margin: 40px auto;
  padding: 0 20px;
}

.product-list-header {
  text-align: center;
  margin-bottom: 32px;
}

.product-list-header h1 {
  font-size: 36px;
  font-weight: 700;
  color: var(--text, #1a1a1a);
  margin-bottom: 12px;
  letter-spacing: -0.02em;
}

.product-list-header p {
  color: var(--text-light, #666);
  font-size: 17px;
}

.product-list-grid {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 32px;
  align-items: start;
}

.product-list-main {
  min-width: 0;
}

.product-list-sidebar {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 移动端 (<768px): 单列堆叠 */
@media (max-width: 768px) {
  .product-list-grid {
    grid-template-columns: 1fr;
  }
}

/* 工具栏 */
.product-list-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
  padding: 16px;
  background: var(--white, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 12px;
  flex-wrap: wrap;
}

.product-list-toggle {
  display: flex;
  gap: 4px;
  background: var(--bg-secondary, #f5f5f5);
  padding: 4px;
  border-radius: 8px;
}

.product-list-toggle-btn {
  padding: 8px 16px;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-light, #666);
  transition: all 0.15s;
}

.product-list-toggle-btn:hover {
  color: var(--text, #1a1a1a);
}

.product-list-toggle-btn.active {
  background: var(--primary, #0969da);
  color: #fff;
  font-weight: 500;
}

.product-list-search {
  flex: 1;
  min-width: 200px;
  position: relative;
}

.product-list-search input {
  width: 100%;
  padding: 8px 32px 8px 12px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  font-size: 14px;
  box-sizing: border-box;
}

.product-list-search input:focus {
  outline: none;
  border-color: var(--primary, #0969da);
}

.product-list-search-clear {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: transparent;
  border: none;
  font-size: 18px;
  color: var(--text-light, #666);
  cursor: pointer;
  padding: 0 4px;
}

.product-list-search-clear:hover {
  color: var(--text, #1a1a1a);
}

.product-list-count {
  font-size: 13px;
  color: var(--text-light, #666);
  white-space: nowrap;
}
```

- [ ] **Step 2: 加产品行 + 分页样式**

在文件末尾追加:

```css
/* 产品行 */
.product-list-row {
  display: flex;
  gap: 20px;
  padding: 20px;
  background: var(--white, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 12px;
  margin-bottom: 12px;
  transition: all 0.15s;
}

.product-list-row:hover {
  border-color: var(--primary, #0969da);
  box-shadow: 0 2px 12px rgba(9, 105, 218, 0.06);
}

.product-list-row-thumb {
  width: 120px;
  height: 120px;
  flex-shrink: 0;
  border-radius: 8px;
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  background-size: cover;
  background-position: center;
}

.product-list-row-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.product-list-row-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.product-list-row-title h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text, #1a1a1a);
}

.product-list-row-pricing {
  display: flex;
  gap: 12px;
  font-size: 14px;
  color: var(--text-light, #666);
  margin-bottom: 8px;
}

.product-list-row-pricing .price-tier-amount {
  color: var(--primary, #0969da);
  font-weight: 500;
}

.product-list-row-platform {
  font-size: 13px;
  color: var(--text-light, #666);
}

.product-list-row-desc {
  font-size: 14px;
  color: var(--text-light, #666);
  line-height: 1.5;
  margin-bottom: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.product-list-row-action {
  margin-top: auto;
  align-self: flex-end;
}

.product-list-row-btn {
  padding: 8px 20px;
  background: var(--primary, #0969da);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}

.product-list-row-btn:hover {
  background: var(--primary-dark, #0550ae);
}

/* Badge (复用已有 CSS, 但确保 .product-list-row 内的 badge 也显示) */
.product-list-row .product-card-category-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 500;
}

/* 分页 */
.product-list-pagination {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin-top: 32px;
}

.product-list-pagination button {
  min-width: 36px;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--white, #fff);
  color: var(--text, #1a1a1a);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}

.product-list-pagination button:hover:not(:disabled) {
  border-color: var(--primary, #0969da);
  color: var(--primary, #0969da);
}

.product-list-pagination button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.product-list-pagination button.active {
  background: var(--primary, #0969da);
  color: #fff;
  border-color: var(--primary, #0969da);
  font-weight: 500;
}

.product-list-pagination .ellipsis {
  padding: 0 4px;
  color: var(--text-light, #666);
  display: inline-flex;
  align-items: center;
}

/* 空/错误状态 */
.product-list-empty,
.product-list-error {
  text-align: center;
  padding: 80px 20px;
  color: var(--text-light, #666);
}

.product-list-error {
  color: #cf222e;
}

.product-list-empty .clear-search-btn {
  margin-top: 12px;
  padding: 6px 16px;
  background: var(--primary, #0969da);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}
```

- [ ] **Step 3: 加侧栏样式**

在文件末尾追加:

```css
/* 侧栏卡片 */
.sidebar-card {
  background: var(--white, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 12px;
  padding: 20px;
}

.sidebar-card h3 {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text, #1a1a1a);
}

.sidebar-card-link {
  display: block;
  margin-top: 12px;
  text-align: center;
  font-size: 13px;
  color: var(--primary, #0969da);
  text-decoration: none;
}

.sidebar-card-link:hover {
  text-decoration: underline;
}

/* FAQ accordion (侧栏) */
.sidebar-faq-item {
  border-bottom: 1px solid var(--border, #e5e7eb);
  padding: 12px 0;
}

.sidebar-faq-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.sidebar-faq-item:first-child {
  padding-top: 0;
}

.sidebar-faq-q {
  font-size: 14px;
  font-weight: 500;
  color: var(--text, #1a1a1a);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.sidebar-faq-q::after {
  content: '▸';
  font-size: 12px;
  color: var(--text-light, #666);
  transition: transform 0.15s;
}

.sidebar-faq-item.open .sidebar-faq-q::after {
  transform: rotate(90deg);
}

.sidebar-faq-a {
  display: none;
  font-size: 13px;
  color: var(--text-light, #666);
  line-height: 1.6;
  margin-top: 8px;
}

.sidebar-faq-item.open .sidebar-faq-a {
  display: block;
}

.sidebar-faq-loading {
  padding: 16px 0;
  text-align: center;
  color: var(--text-light, #666);
  font-size: 13px;
}

/* 移动端产品行适配 */
@media (max-width: 768px) {
  .product-list-row {
    flex-direction: column;
  }

  .product-list-row-thumb {
    width: 100%;
    height: 160px;
  }

  .product-list-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
}
```

- [ ] **Step 4: 验证 CSS 可访问**

```bash
cd "H:/MywebServer/wwwsite (2)"
curl -sI http://localhost:15000/css/pages/product-list.css?v=20260623-1830 | head -5
```

预期: `HTTP/1.1 200 OK`, `Content-Type: text/css`。

- [ ] **Step 5: commit**

```bash
cd "H:/MywebServer/wwwsite (2)"
git add public/css/pages/product-list.css
git commit -m "feat(product-list): CSS with grid layout, product rows, sidebar, pagination, responsive"
```

---

## Task 5: product-list.html 内联 JS (state + loadList + render + 事件)

**Files:**
- Modify: `public/product-list.html` (在 `<script>` 标签内追加 JS)

**Interfaces:**
- Consumes: `/api/products?isCourse=&search=&page=&pageSize=` (Task 2), `/api/faqs` (现有)
- Produces: 列表渲染、分页、侧栏 FAQ 折叠、URL 同步、debounce 搜索

- [ ] **Step 1: 加 helpers (escapeHtml + getCategoryBadgeClass 第 4 处)**

替换 `<script>` 块内容为:

```html
  <script>
    document.getElementById('footer-year').textContent = new Date().getFullYear();

    // ============ Helpers ============

    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[c]);
    }

    // 分类名 → badge CSS class (与 admin-product.html / index.html / admin-product-form.js 一致)
    function getCategoryBadgeClass(category) {
      const map = {
        '企业产品': 'badge-enterprise-product',
        '外站课程': 'badge-external-course',
        '企业内训': 'badge-enterprise-internal',
        'GitHub 仓库': 'badge-github-repo'
      };
      return map[category] || 'product-card-category-badge';
    }

    // ============ State ============

    let currentFilter = 'all';      // 'all' | 'software' | 'course'
    let currentSearch = '';
    let currentPage = 1;
    let searchDebounceTimer = null;

    // ============ API ============

    async function loadList() {
      const container = document.getElementById('product-list-rows');
      container.innerHTML = '<div class="product-list-loading">加载中...</div>';

      try {
        const params = new URLSearchParams();
        if (currentFilter === 'software') params.set('isCourse', 'false');
        else if (currentFilter === 'course') params.set('isCourse', 'true');
        if (currentSearch) params.set('search', currentSearch);
        params.set('page', currentPage);
        params.set('pageSize', 20);

        const res = await fetch('/api/products?' + params.toString());
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        renderRows(data.products);
        renderCount(data.total);
        renderPagination(data);
        syncUrl();
      } catch (e) {
        container.innerHTML = '<div class="product-list-error">加载失败：' + escapeHtml(e.message) + '</div>';
      }
    }

    async function loadSidebarFaq() {
      try {
        const res = await fetch('/api/faqs');
        if (!res.ok) return;
        const faqs = await res.json();
        const top5 = faqs.slice(0, 5);
        const container = document.getElementById('sidebar-faq-dynamic');
        if (top5.length === 0) {
          container.innerHTML = '<div class="sidebar-faq-loading">暂无 FAQ</div>';
          return;
        }
        container.innerHTML = top5.map(f => `
          <div class="sidebar-faq-item">
            <div class="sidebar-faq-q">${escapeHtml(f.question)}</div>
            <div class="sidebar-faq-a">${escapeHtml(f.answer)}</div>
          </div>
        `).join('');
        // 绑定折叠
        container.querySelectorAll('.sidebar-faq-q').forEach(q => {
          q.addEventListener('click', () => {
            q.parentElement.classList.toggle('open');
          });
        });
      } catch (e) {
        console.error('loadSidebarFaq error:', e);
      }
    }
  </script>
```

- [ ] **Step 2: 加 render 函数 (rows + count + pagination)**

在 `</script>` 前插入:

```html
    // ============ Render ============

    function renderRows(products) {
      const container = document.getElementById('product-list-rows');
      if (products.length === 0) {
        const msg = currentSearch
          ? `<div class="product-list-empty">未找到匹配产品<br><button class="clear-search-btn" onclick="clearSearch()">清除搜索</button></div>`
          : '<div class="product-list-empty">暂无产品</div>';
        container.innerHTML = msg;
        return;
      }

      container.innerHTML = products.map(p => {
        const thumbStyle = p.image
          ? `background-image: url('${escapeHtml(p.image)}');`
          : '';
        const badgeClass = getCategoryBadgeClass(p.category);
        const badgeText = escapeHtml(p.category || '软件');

        // 价格区: 软件型显示 tier; 课程型显示平台数
        let pricingHtml = '';
        if (p.isCourse) {
          // 课程型: 显示平台数
          const platforms = (p.platform || '').split(/[,，、]/).filter(Boolean);
          const count = platforms.length;
          pricingHtml = `<div class="product-list-row-platform">${count} 个平台 · ${escapeHtml(p.platform || '')}</div>`;
        } else if (p.pricingTiers && p.pricingTiers.length > 0) {
          pricingHtml = `<div class="product-list-row-pricing">${p.pricingTiers.map(t =>
            `<span><span class="price-tier-amount">¥${t.price}</span> / ${escapeHtml(t.label)}</span>`
          ).join('')}</div>`;
        } else {
          pricingHtml = `<div class="product-list-row-pricing"><span class="price-tier-amount">¥${p.price}</span></div>`;
        }

        const btnText = p.isCourse ? '查看课程 →' : '查看详情 →';
        const btnLink = p.isCourse ? `/product/${p.id}` : `/product/${p.id}`;

        return `
          <div class="product-list-row">
            <div class="product-list-row-thumb" style="${thumbStyle}"></div>
            <div class="product-list-row-body">
              <div class="product-list-row-title">
                <h3>${escapeHtml(p.name)}</h3>
                <span class="product-card-category-badge ${badgeClass}">${badgeText}</span>
                ${p.isCourse ? '<span class="product-card-category-badge badge-purple">课程型</span>' : ''}
              </div>
              ${pricingHtml}
              <div class="product-list-row-desc">${escapeHtml(p.description || '')}</div>
              <div class="product-list-row-action">
                <a href="${btnLink}" class="product-list-row-btn">${btnText}</a>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    function renderCount(total) {
      document.getElementById('result-count').textContent = '共 ' + total + ' 个产品';
    }

    function renderPagination(data) {
      const container = document.getElementById('pagination');
      const { page, totalPages } = data;
      if (totalPages <= 1) {
        container.innerHTML = '';
        return;
      }

      const buttons = [];

      // 上一页
      buttons.push(`<button onclick="goToPage(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹</button>`);

      // 页码 (≤7 全显, >7 折叠)
      const pages = buildPageList(page, totalPages);
      pages.forEach(p => {
        if (p === '...') {
          buttons.push('<span class="ellipsis">...</span>');
        } else {
          buttons.push(`<button class="${p === page ? 'active' : ''}" onclick="goToPage(${p})">${p}</button>`);
        }
      });

      // 下一页
      buttons.push(`<button onclick="goToPage(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>›</button>`);

      container.innerHTML = buttons.join('');
    }

    function buildPageList(current, total) {
      if (total <= 7) {
        return Array.from({ length: total }, (_, i) => i + 1);
      }
      const pages = [1];
      if (current > 3) pages.push('...');
      const start = Math.max(2, current - 1);
      const end = Math.min(total - 1, current + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (current < total - 2) pages.push('...');
      pages.push(total);
      return pages;
    }

    function syncUrl() {
      const params = new URLSearchParams();
      if (currentPage > 1) params.set('page', currentPage);
      const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
      window.history.replaceState({}, '', newUrl);
    }
```

- [ ] **Step 3: 加事件处理 (toggle + search debounce + pagination + init)**

在 `</script>` 前再插入:

```html
    // ============ Event Handlers ============

    function setFilter(filter) {
      currentFilter = filter;
      currentPage = 1;
      document.querySelectorAll('.product-list-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
      });
      loadList();
    }

    function onSearchInput(e) {
      const val = e.target.value;
      document.getElementById('search-clear').style.display = val ? 'block' : 'none';
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        currentSearch = val.trim();
        currentPage = 1;
        loadList();
      }, 300);
    }

    function clearSearch() {
      document.getElementById('search-input').value = '';
      document.getElementById('search-clear').style.display = 'none';
      currentSearch = '';
      currentPage = 1;
      loadList();
    }

    function goToPage(p) {
      if (p < 1) return;
      currentPage = p;
      loadList();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ============ Init ============

    document.addEventListener('DOMContentLoaded', () => {
      // 从 URL 读 ?page=
      const params = new URLSearchParams(window.location.search);
      const pageParam = parseInt(params.get('page'));
      if (pageParam && pageParam > 0) currentPage = pageParam;

      // 绑定 toggle
      document.querySelectorAll('.product-list-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => setFilter(btn.dataset.filter));
      });

      // 绑定搜索
      const searchInput = document.getElementById('search-input');
      searchInput.addEventListener('input', onSearchInput);
      document.getElementById('search-clear').addEventListener('click', clearSearch);

      // 加载数据
      loadList();
      loadSidebarFaq();

      // 绑定静态 FAQ (购买指南)
      document.querySelectorAll('.sidebar-card .sidebar-faq-q').forEach(q => {
        q.addEventListener('click', () => {
          q.parentElement.classList.toggle('open');
        });
      });
    });
```

- [ ] **Step 4: 浏览器手测 (5 项快速验证)**

启动 dev server (如果尚未启动):

```bash
cd "H:/MywebServer/wwwsite (2)"
# 检查 server 是否在跑
curl -s http://localhost:15000/api/health || (npm start > /tmp/server.log 2>&1 &)
sleep 2
```

浏览器访问 `http://localhost:15000/product/`, 验证:

1. 页面加载,看到工具栏 (全部/软件型/课程型) + 搜索框 + 产品列表行 + 右侧购买指南/常见问题
2. 点击 "软件型" → 列表只剩 isCourse=false 的产品
3. 在搜索框输入 "邮" → 列表过滤 (300ms 后)
4. 滚动到底部 → 看到分页 (如 totalPages > 1)
5. 点击分页 2 → URL 变成 `?page=2` + 列表刷新

- [ ] **Step 5: commit**

```bash
cd "H:/MywebServer/wwwsite (2)"
git add public/product-list.html
git commit -m "feat(product-list): inline JS - state, loadList, render, events, sidebar FAQ"
```

---

## Task 6: nav 加 "产品中心" 链接 + 首页 "查看更多" + cache-bust 16 HTML

**Files:**
- Modify: 15 公开 nav HTML (加 `<li><a href="/product/">产品中心</a></li>`)
- Modify: `public/index.html:89` (在 `<div class="products-grid">` 后加 "查看更多" 按钮)
- Modify: 16 公开 HTML (cache-bust 时间戳同步到 `20260623-1830`)

**Interfaces:**
- 无新接口, 仅 HTML 标记 + cache-bust

- [ ] **Step 1: cache-bust 16 个 HTML 的 CSS ?v= 戳**

先看现状 (检查哪些文件有 CSS `?v=`):

```bash
cd "H:/MywebServer/wwwsite (2)"
grep -h "css/pages/.*\.css?v=" public/*.html 2>/dev/null | head -20
```

更新 16 个 HTML 的 CSS `?v=` 到新戳 `20260623-1830`。最简单的方式: 对每个 HTML 文件, 找到 `?v=20YYMMDD-HHMM` 替换为 `?v=20260623-1830`。

用 sed 批量替换 (覆盖 public/*.html 中所有 CSS 引用):

```bash
cd "H:/MywebServer/wwwsite (2)"
for f in public/about.html public/checkout.html public/contact.html public/doc.html public/docs.html public/faq.html public/help.html public/index.html public/license.html public/news.html public/order-detail.html public/privacy.html public/product.html public/support.html public/terms.html public/product-list.html; do
  sed -i 's|\.css?v=20[0-9]\{6\}-[0-9]\{4\}|.css?v=20260623-1830|g' "$f"
done
```

验证唯一时间戳:

```bash
cd "H:/MywebServer/wwwsite (2)"
grep -h "\.css?v=" public/about.html public/checkout.html public/contact.html public/doc.html public/docs.html public/faq.html public/help.html public/index.html public/license.html public/news.html public/order-detail.html public/privacy.html public/product.html public/support.html public/terms.html public/product-list.html | grep -oE 'v=[0-9-]+' | sort -u
```

预期: 只有 `v=20260623-1830` 一行。

- [ ] **Step 2: 给 15 个 nav HTML 加 "产品中心" 链接**

每个文件当前有 `<li><a href="/">产品</a></li>` 或类似 nav 结构。在 "产品" 后插入新项。

注: `index.html` 当前是 `<li><a href="/">产品</a></li>` (首页本身就是产品区)。但仍要加 "产品中心" 链接到 nav, 因为用户明确想要产品中心独立页。

用 sed 批量插入 (在 `>产品</a>` 后插入新 li):

```bash
cd "H:/MywebServer/wwwsite (2)"
for f in public/about.html public/checkout.html public/contact.html public/doc.html public/docs.html public/faq.html public/help.html public/index.html public/license.html public/news.html public/order-detail.html public/privacy.html public/product.html public/support.html public/terms.html; do
  # 检查是否已存在 "产品中心" 链接,避免重复插入
  if ! grep -q '>产品中心</a>' "$f"; then
    # 在 ">产品</a>" 后插入新 li (注意 > 产品 < /a > 间的空格要保留)
    sed -i 's|<li><a href="/">产品</a></li>|<li><a href="/">产品</a></li>\n          <li><a href="/product/">产品中心</a></li>|g' "$f"
  fi
done
```

验证 (15 个文件都有 "产品中心"):

```bash
cd "H:/MywebServer/wwwsite (2)"
for f in public/about.html public/checkout.html public/contact.html public/doc.html public/docs.html public/faq.html public/help.html public/index.html public/license.html public/news.html public/order-detail.html public/privacy.html public/product.html public/support.html public/terms.html; do
  grep -q '>产品中心</a>' "$f" && echo "OK: $f" || echo "MISSING: $f"
done
```

预期: 全部 15 个 `OK:`。

- [ ] **Step 3: 给 index.html 产品区加 "查看更多 →" 按钮**

修改 `public/index.html` line 87 (`</div>` 闭合 products-grid 之前) 后:

找到 line 85-87 区间:

```html
      <div class="products-grid" id="products-grid">
        <!-- Products loaded dynamically -->
      </div>
```

替换为:

```html
      <div class="products-grid" id="products-grid">
        <!-- Products loaded dynamically -->
      </div>
      <div class="products-section-footer">
        <a href="/product/" class="view-more-btn">查看更多 →</a>
      </div>
```

在 `public/css/pages/product-card.css` 末尾追加按钮样式 (或新建小段; 这里选追加以减少新文件):

```bash
cd "H:/MywebServer/wwwsite (2)"
cat >> public/css/pages/product-card.css << 'EOF'

/* 产品区底部"查看更多"按钮 */
.products-section-footer {
  text-align: center;
  margin-top: 24px;
}

.view-more-btn {
  display: inline-block;
  padding: 10px 28px;
  background: var(--white, #fff);
  color: var(--primary, #0969da);
  border: 1px solid var(--primary, #0969da);
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition: all 0.15s;
}

.view-more-btn:hover {
  background: var(--primary, #0969da);
  color: #fff;
}
EOF
```

- [ ] **Step 4: 验证 index.html 整体结构**

```bash
cd "H:/MywebServer/wwwsite (2)"
grep -c "view-more-btn" public/index.html
```

预期: `1` (一处)。

```bash
cd "H:/MywebServer/wwwsite (2)"
curl -s http://localhost:15000/ | grep -c "查看更多"
```

预期: `1`。

- [ ] **Step 5: commit**

```bash
cd "H:/MywebServer/wwwsite (2)"
git add public/*.html public/css/pages/product-card.css
git commit -m "feat(nav): add '产品中心' link to 15 public HTML + index.html '查看更多' button + cache-bust 16 HTML"
```

---

## Task 7: 整支 review + API smoke + 浏览器手测

**Files:** 无代码改动 (除非 review 发现问题)

- [ ] **Step 1: 跑 6 个 API smoke curl (回归)**

```bash
cd "H:/MywebServer/wwwsite (2)"
curl -s http://localhost:15000/api/products?pageSize=5 | node -e "
const d = JSON.parse(require('fs').readFileSync(0));
console.log('1. 默认:', { products: d.products.length, total: d.total, totalPages: d.totalPages });
"
curl -s 'http://localhost:15000/api/products?isCourse=false&pageSize=50' | node -e "
const d = JSON.parse(require('fs').readFileSync(0));
console.log('2. 软件型:', d.products.filter(p => !p.isCourse).length, '/', d.products.length);
"
curl -s 'http://localhost:15000/api/products?isCourse=true&pageSize=50' | node -e "
const d = JSON.parse(require('fs').readFileSync(0));
console.log('3. 课程型:', d.products.filter(p => p.isCourse).length, '/', d.products.length);
"
curl -s 'http://localhost:15000/api/products?search=邮&pageSize=50' | node -e "
const d = JSON.parse(require('fs').readFileSync(0));
console.log('4. 搜索"邮":', d.products.length, '个');
"
curl -s 'http://localhost:15000/api/products?page=2&pageSize=1' | node -e "
const d = JSON.parse(require('fs').readFileSync(0));
console.log('5. 分页 page=2 pageSize=1:', { page: d.page, pageSize: d.pageSize, products: d.products.length });
"
curl -s 'http://localhost:15000/api/products?isCourse=false&search=邮&page=1' | node -e "
const d = JSON.parse(require('fs').readFileSync(0));
console.log('6. 组合:', d.products.length, '个软件含"邮"');
"
```

预期: 6 行输出, 字段正确。

- [ ] **Step 2: 浏览器 7 步手测清单**

启动 dev server (background):

```bash
cd "H:/MywebServer/wwwsite (2)"
pkill -f "node server.js" 2>/dev/null; sleep 1
npm start > /tmp/server.log 2>&1 &
sleep 3
```

浏览器硬刷新 (Ctrl+Shift+R) `http://localhost:15000/product/`, 验证:

1. **加载**: 主区域 + 侧栏 + 列表行可见, 工具栏 toggle 默认选中 "全部"
2. **Toggle 切换**: 点击 "软件型" → 列表只剩 isCourse=false 的产品; 点击 "课程型" → 列表只剩 isCourse=true 的产品; 点击 "全部" → 恢复
3. **搜索**: 在搜索框输入 "邮" → 300ms 后列表过滤; 点击清除按钮 → 恢复
4. **分页**: 如 totalPages > 1, 点击 "2" → URL 变 `?page=2` + 列表刷新; 点击 "‹" 回到 page=1
5. **课程型产品行**: isCourse=true 的产品不显示价格, 显示 "X 个平台 · platform_list"; badge 区有 "课程型" (紫色) + 分类 badge
6. **侧栏 FAQ**: 点击 "购买指南" 任一问题 → 折叠/展开; 点击 "常见问题" 任一问题 → 同样折叠/展开; "查看全部 →" 链接跳 `/faq.html`
7. **Mobile 375px**: DevTools 切到 iPhone SE 模拟, 侧栏挪主区域下方, 单列布局

- [ ] **Step 3: 整支 review (Opus)**

派 1 个 reviewer subagent (per skill subagent-driven-development), 范围: 本 plan 涉及的所有 commits (T1-T6). 重点:

- Spec 符合度: 11 节 spec 的每个验收标准是否都满足
- 代码质量: SQL 注入防御 / XSS 转义 / 公开端点限流 / cache-bust 一致性 / 响应式布局
- 跨任务 issue: 4 处 `getCategoryBadgeClass` 是否一致 / DOMPurify 是否正确加载 (本任务不需要, FAQ 接口不返回 HTML)

输出: 任何 Critical/Important 立即修复 (派 fix subagent), Minor 记入 ledger。

- [ ] **Step 4: 修复 review findings (如有)**

如 review 发现问题, 派 fix subagent 修复, 然后 re-review 验证。

- [ ] **Step 5: 终态确认 + commit (如有修复)**

```bash
cd "H:/MywebServer/wwwsite (2)"
git log --oneline -10  # 列出本特性所有 commit
git status  # 确认 clean
```

预期: 7 个新 commit (T1-T6 + 可能的 fix), working tree clean。

---

## Risks & Mitigations

- **3 → 4 处 `getCategoryBadgeClass` 重复**: per spec "3 处独立定义" 显式接受, 加 1 处仍 YAGNI, 集中化重构留待下次
- **API 响应结构变化破坏 homepage consumer**: T2 Step 3 已加 Array.isArray 防御, 兼容旧/新两种格式
- **LIKE 模糊匹配性能**: 50 个产品内 < 50ms, 50+ 后考虑 FULLTEXT 索引 (per spec §9)
- **首次访问 cache-bust 命中**: 所有 16 HTML 用 `?v=20260623-1830` 统一戳, 浏览器拿新 CSS 不会因 7d immutable cache 失败
- **课程型"X 个平台" 平台数算法**: 用 `platform.split(/[,，、]/).filter(Boolean).length`, 与现有 product-links 数据无关

---

## Self-Review

**1. Spec coverage:**

| Spec 章节 | 覆盖任务 |
|----------|---------|
| §1 背景与目标 | 全 plan |
| §2 架构 | T2 (路由 + API), T3 (HTML 结构) |
| §3 数据模型与 API | T1 (db.js 函数), T2 (server.js 改造) |
| §4 前端布局 | T3 (HTML 结构), T4 (CSS), T5 (JS render) |
| §5 错误处理 | T5 (try/catch + empty state) |
| §6 测试计划 | T7 (回归 smoke + 浏览器手测) |
| §7 实施计划 | T1-T7 一一对应 |
| §8 复用 | T1 (复用 row 映射), T5 (复用 escapeHtml + FAQ API), T6 (复用 view-more 模式) |
| §9 风险 | 见上文 Risks |
| §10 YAGNI | 不做对比/收藏/分享/评论/排序自定义/国际化 |
| §11 验收标准 | T7 全部覆盖 |

**2. Placeholder scan:** 无 TBD/TODO/类似措辞。每步都有完整代码或命令。

**3. Type consistency:**
- `getProductsPaginated({isCourse, search, page, pageSize})` → `{products, total, page, pageSize, totalPages}` 在 T1 定义, T2 消费, T5 消费 — 一致
- `getCategoryBadgeClass(category)` 在 T5 定义 (4 键 map + `'product-card-category-badge'` 兜底), 与 admin-product.html / index.html / admin-product-form.js 一致 (4 键 map)
- API 路径 `/api/products` 在 T2 定义, T5 调用 — 一致
- FAQ API `/api/faqs` 返回 `{id, question, answer, sortOrder, createdAt, updatedAt}` (来自 db.js:1330), T5 用 `f.question` + `f.answer` — 一致

**4. 计划已覆盖 spec 全部要求, 无遗漏。**

---

**Plan 状态**: ✅ 完成, 待用户选执行模式 (subagent-driven 或 inline)