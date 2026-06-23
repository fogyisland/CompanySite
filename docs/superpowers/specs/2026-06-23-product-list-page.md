# 产品列表页特性 Spec

**Date:** 2026-06-23
**Status:** 已批准设计, 待实施
**Author:** Claude (brainstorm with user)

---

## 1. 背景与目标

### 1.1 问题
当前 wwwsite 公开产品展示仅在首页 (`/`) 体现 — 包含 hero 轮播 + 4-6 张产品卡片。产品增长后首页承载有限, 用户需要专门页面浏览全部产品 (按类型/搜索), 并希望侧栏有购买帮助信息。

### 1.2 目标
- 新建公开产品列表页 `/product/`, 列出全部产品
- 支持按"软件型/课程型"切换 + 产品名搜索
- 提供购买帮助信息侧栏 (购买指南 + FAQ)
- 与现有 `/product.html?id=X` 详情页并存 (不破坏现有 URL)

### 1.3 非目标
- ❌ 不重写现有 `/product.html?id=X` 详情页
- ❌ 不做用户登录/购物车功能 (沿用现有)
- ❌ 不做产品对比/收藏/分享
- ❌ 不做评论/评分

---

## 2. 架构

### 2.1 URL 设计
- **列表页**: `GET /product/` → serve `public/product-list.html`
- **详情页**: 保留 `GET /product.html?id=X` 不变
- **API**: 扩展 `GET /api/products?isCourse=&search=&page=&pageSize=`

### 2.2 路由
```javascript
// server.js 新增
app.get('/product/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'product-list.html'));
});

// 改造现有
app.get('/api/products', async (req, res) => {
  const { isCourse, search, page = 1, pageSize = 20 } = req.query;
  const result = await db.getProductsPaginated({
    isCourse: isCourse === 'true' ? true : isCourse === 'false' ? false : null,
    search: search || '',
    page: parseInt(page) || 1,
    pageSize: Math.min(parseInt(pageSize) || 20, 50)
  });
  res.json(result);
});
```

### 2.3 文件清单
**新建** (2 个):
- `public/product-list.html` (~200 行)
- `public/css/pages/product-list.css` (~150 行)

**修改** (3 类):
- `server.js` (1 处路由 + 1 处 API 改造)
- `db.js` (新增 `getProductsPaginated` 函数)
- 公开 nav HTML (≥15 个, 加"产品中心"链接)
- `public/index.html` (产品区底部加"查看更多 →"按钮)

**Cache-bust**:
- 新 `product-list.html` `?v=20260623-XXXX`
- 15 公开 nav HTML 同步新戳 (与 admin 戳策略一致)
- admin HTML 不需动 (产品列表页是公开的, admin 不引用)

---

## 3. 数据模型与 API

### 3.1 API 设计

**端点**: `GET /api/products`

**Query Params** (3 个, 全部可选):
| Param | Type | Default | 说明 |
|-------|------|---------|------|
| `isCourse` | `true` \| `false` | 不传=全部 | 课程型/软件型过滤 |
| `search` | string | `""` | 模糊匹配 `name` + `shortName` (LIKE) |
| `page` | int ≥ 1 | `1` | 页码 |
| `pageSize` | int 1-50 | `20` | 每页数 |

**返回结构**:
```json
{
  "products": [...],
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "totalPages": 3
}
```

### 3.2 SQL 查询
```sql
SELECT * FROM products
WHERE (? IS NULL OR is_course = ?)
  AND (? = '' OR name LIKE ? OR short_name LIKE ?)
ORDER BY created_at DESC
LIMIT ? OFFSET ?
```

**性能**: 已有 `idx_products_is_course` 索引, LIKE 模糊匹配 50 个产品内无需额外索引

### 3.3 db.js 函数签名
```javascript
async function getProductsPaginated({ isCourse, search, page, pageSize }) {
  // 返回 { products, total, page, pageSize, totalPages }
}
```

---

## 4. 前端布局

### 4.1 整体结构 (CSS Grid, 响应式)

**桌面 (≥768px)**:
```
┌─────────────────────────────────────┬──────────────┐
│ 主区域 (~70%)                        │ 侧栏 (~30%)  │
│ ┌─ 工具栏 ──────────────────────┐   │ ┌─ 购买指南 ┐│
│ │ Toggle: 全部|软件型|课程型     │   │ │ ...       ││
│ │ 搜索: [输入产品名]              │   │ └──────────┘│
│ └────────────────────────────────┘   │ ┌─ 常见问题 ┐│
│ ┌─ 产品行 (1 per row) ─────────┐    │ │ Q: ...    ││
│ │ [图] 产品名  ¥月付  ¥年付      │    │ │ A: ...    ││
│ │     [分类 badge]                │    │ └──────────┘│
│ │     描述 1-2 行                  │    │             │
│ │                  [查看详情 →]    │    │             │
│ └────────────────────────────────┘    │             │
│ ┌─ 产品行 2 ──────────────────┐      │             │
│ ...                                    │             │
│ 分页: < 1 2 3 ... >                    │             │
└─────────────────────────────────────┴──────────────┘
```

**移动 (<768px)**:
- 侧栏挪主区域下方
- 主区域单列

### 4.2 产品行元素
| 元素 | 软件型 | 课程型 |
|------|--------|--------|
| 缩略图 (左, ~120px) | ✅ | ✅ |
| 产品名 (粗体) | ✅ | ✅ |
| 分类 badge (彩色) | ✅ | ✅ (课程型显示紫色"课程型") |
| 价格区 | `¥月付  /  ¥年付` | ❌ (隐藏, 显示"X 个平台") |
| 描述 (1-2 行 truncate) | ✅ | ✅ |
| 按钮 | "查看详情 →" | "查看课程 →" |

### 4.3 工具栏
- **Toggle 按钮组**: 3 个按钮 "全部" / "软件型" / "课程型" (单选, 选中状态彩色)
- **搜索框**: `<input>` + 防抖 (300ms) + 清除按钮 (匹配 `name` + `shortName`)
- **结果统计**: "共 X 个产品" (右上角)
- **默认排序**: `created_at DESC` (新→旧), 不暴露 sort 参数 (YAGNI)

### 4.4 分页
- 数字按钮 1 2 3 ... + 上下页
- 当前页加粗
- 总页数 ≤ 7 时全显, > 7 时折叠
- 同步 URL `?page=X` (刷新可恢复)

### 4.5 侧栏内容
**购买指南 (静态 HTML, ~10 行)**:
- 4-5 条购买相关 Q&A
- 例如: "如何选购?" / "授权方式" / "退款政策"

**常见问题 (动态)**:
- 调 `GET /api/faqs` 拉前 5 条
- 复用现有 FAQ UI (折叠展开)
- 链接到 `/faq.html` 查看全部

### 4.6 颜色复用
- `.product-card-category-badge` (现有, 4 个 modifier class)
- `.badge-purple` (现有, 课程型用)
- 工具栏按钮: `.btn-toggle` (新)
- 产品行: `.product-list-row` (新)

---

## 5. 错误处理

| 场景 | 行为 |
|------|------|
| API 失败 | `<empty-state>` "加载失败, 请稍后重试" + 重试按钮 |
| 空结果 | "暂无产品" 提示 |
| 搜索无匹配 | "未找到匹配产品" + "清除搜索" 按钮 |
| 分页越界 (page > totalPages) | 自动重定向到 page=1 |
| `pageSize > 50` | 服务端 cap 到 50 |
| 非整数 `page` / `pageSize` | 默认 1 / 20 |

**安全**:
- 所有用户可见字符串用 `escapeHtml` 转义
- `search` 参数用 prepared statement 防 SQL 注入
- `page` / `pageSize` 整数化 + 范围校验

---

## 6. 测试计划

### 6.1 API Smoke (无需登录)
```bash
# 1. 不带参数
curl http://localhost:15000/api/products

# 2. 仅软件型
curl 'http://localhost:15000/api/products?isCourse=false'

# 3. 仅课程型
curl 'http://localhost:15000/api/products?isCourse=true'

# 4. 搜索
curl 'http://localhost:15000/api/products?search=邮件'

# 5. 分页
curl 'http://localhost:15000/api/products?page=1&pageSize=1'

# 6. 组合
curl 'http://localhost:15000/api/products?isCourse=false&search=邮件&page=1'
```

预期: 全部 200, JSON 包含 `{products, total, page, pageSize, totalPages}`

### 6.2 浏览器手测 (用户 7 步)
1. `/product/` 加载 → 看到主区域 + 侧栏 + 列表行
2. Toggle "全部/软件型/课程型" → 列表实时更新
3. 搜索 "邮件" → 实时过滤 (300ms debounce)
4. 分页 1-2-3 → 列表变化, URL 同步 `?page=X`
5. 课程型产品行: 不显示价格, 显示平台数 + 紫色 badge
6. 侧栏 FAQ: 展开/收起 (复用现有 FAQ UI)
7. Mobile (375px): 侧栏挪底部, 单列布局

### 6.3 静态资源
- `/product/` → 200, 包含 4 个 modifier class 名
- `/css/pages/product-list.css?v=XXXX` → 200
- 15 公开 nav HTML 的 cache-bust 戳一致

---

## 7. 实施计划 (~7 tasks)

| T | 范围 | 文件 | 估时 |
|---|------|------|------|
| T1 | db.js `getProductsPaginated` + smoke test | db.js | 5 min |
| T2 | server.js 改造 `/api/products` + `/product/` 路由 | server.js | 5 min |
| T3 | `public/product-list.html` HTML 结构 | new | 10 min |
| T4 | `public/css/pages/product-list.css` | new | 8 min |
| T5 | `public/js/product-list.js` (或内联) | new/inline | 8 min |
| T6 | nav 加"产品中心"×15 HTML + 首页"查看更多" + cache-bust | 16 files | 10 min |
| T7 | 整支 review + API smoke + 用户手测 | - | 5 min |

**Total: ~50 min**

---

## 8. 复用清单

| 复用项 | 位置 | 用途 |
|--------|------|------|
| `getCategoryBadgeClass()` | form JS / index.html / admin-product.html (3 处) | 第 4 处副本加 product-list.js |
| `escapeHtml()` | 每页内联 | 转义所有用户可见字符串 |
| `getCategoryBadgeClass` CSS class | admin.css:556+ / product-card.css:283+ | 列表行 badge |
| `.badge-purple` | admin.css:545 / 复用 | 课程型 badge |
| FAQ API | `/api/faqs` | 侧栏常见问题 |
| DOMPurify | `public/vendor/dompurify/3.0.6/` | 描述字段 sanitize (如启用) |
| nav 模板 | `news.html:15-25` | 复制"动态"链接模式 |

---

## 9. 已知约束与风险

- **helper 函数重复 (3 → 4 处)**: 加第 4 处 `getCategoryBadgeClass` (per spec "3 处独立定义" 显式接受, 加 1 处仍 YAGNI, 集中化重构留待下次)
- **搜索性能**: LIKE 模糊匹配 `name` + `shortName`, 50 个产品内 < 50ms, 50+ 后考虑 FULLTEXT 索引
- **首页产品区重叠**: 用户在 `/` 看到 4-6 个产品卡片 + 在 `/product/` 看到完整列表, 可能有"重复感", 但用户已选保留首页产品区 + "查看更多"按钮过渡
- **课程型产品行按钮文案**: "查看课程" vs "查看详情" (course-product T6 已用 "查看课程" 模式, 沿用)
- **侧栏 FAQ API 是否有限流**: 现有 FAQ 是公开端点, 应有 `checkPublicEndpointRateLimit` 保护, 不需额外限制

---

## 10. YAGNI 显式排除

- ❌ 产品对比/收藏/分享
- ❌ 评论/评分
- ❌ 用户登录态差异 (登录用户看不同价格)
- ❌ 产品排序自定义 (拖拽排序)
- ❌ 产品标签 (除现有分类 badge 外)
- ❌ 国际化 (i18n)
- ❌ 产品状态 (草稿/已下架)
- ❌ 多语言 (en/zh-CN 切换)

---

## 11. 验收标准

- [ ] `/product/` 公开访问, 无需登录
- [ ] 列表显示所有产品 (含课程型/软件型)
- [ ] Toggle + 搜索 + 分页 功能正常
- [ ] 课程型产品不显示价格, 显示平台数
- [ ] 侧栏"购买指南" + "FAQ" 显示
- [ ] Mobile 响应式 (375px)
- [ ] 15 公开 nav HTML 同步 cache-bust
- [ ] 首页产品区保留 + "查看更多"按钮
- [ ] API smoke 全过 (6 个 curl)
- [ ] 用户 7 步手测通过
- [ ] 0 Critical/Important issue (整支 review)

---

**Spec 状态**: ✅ 已批准, 进入 writing-plans 阶段
