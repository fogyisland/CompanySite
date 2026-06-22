# 课程型产品 spec

**Date**: 2026-06-22
**Status**: approved（用户 2026-06-22 13:18 批准设计）
**Author**: Claude（基于 brainstorming）

## Why

产品当前只支持"软件"型（1 个价格或 2 档订阅 + 1 个下载方式），无法承载**课程型产品**（无价格，多个第三方平台链接如 B 站 / GitHub / 慕课网等）。需要扩展产品数据模型支持新模式。

## What

### 1. 数据模型

**products 表新增列**：`is_course INT DEFAULT 0`（0 = 普通产品，1 = 课程型）
- 课程型时：`price=0`（保留 NOT NULL 约束）+ `pricing_tiers=NULL` + `download_url=NULL` + `external_link=0`
- 普通产品：维持现状，`is_course=0`

**新建 `product_links` 表**（一对多）：
```sql
CREATE TABLE IF NOT EXISTS product_links (
  id INT PRIMARY KEY AUTO_INCREMENT,
  product_id INT NOT NULL,
  platform VARCHAR(50) NOT NULL,    -- 预设值如 'bilibili'，自定义格式 'custom:掘金'
  url VARCHAR(500) NOT NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_product (product_id)
)
```

### 2. 预设平台（11 + 其他）

```js
const COURSE_PLATFORMS = [
  { value: 'bilibili',       label: 'B站' },
  { value: 'youtube',        label: 'YouTube' },
  { value: 'github',         label: 'GitHub' },
  { value: 'imooc',          label: '慕课网' },
  { value: 'tencent-class',  label: '腾讯课堂' },
  { value: 'netease-class',  label: '网易云课堂' },
  { value: 'zhihu',          label: '知乎' },
  { value: 'juejin',         label: '掘金' },
  { value: 'csdn',           label: 'CSDN' },
  { value: 'wechat-mp',      label: '微信公众号' },
  { value: 'other',          label: '其他（自定义）' }
];
```

### 3. UI 互斥规则

**新增复选框**（放在 `usePricingTiers` 上面）：
```html
<div class="checkbox-field">
  <input type="checkbox" id="isCourse" name="isCourse">
  <label for="isCourse">课程型产品（无价格，仅链接 + 介绍）</label>
</div>
```

**JS 切换** `toggleCourse(root)`：
- 勾 `isCourse`：
  - 隐藏：`#priceField` / `#subscriptionSection` / `#externalLinkSection` / `#softwareUploadSection`
  - 显示：`#courseLinksSection`（新）
  - 清空：上述字段值（避免数据污染）
- 取消勾 `isCourse`：
  - 恢复显示 4 个隐藏区域
  - 清空 `state.courseLinks`

**双向防御**：
- 勾 `usePricingTiers` 或 `useExternalLink` 时自动 `isCourse.checked = false`（避免误操作）
- `usePricingTiers`/`useExternalLink` 自身的可见性逻辑不变

### 4. 链接列表 UI（新 `#courseLinksSection`）

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
```

**每行结构**（`.course-link-row`）：
```html
<div class="course-link-row" data-index="0">
  <select class="course-link-platform">
    <option value="bilibili">B站</option>
    ... 11 个预设 ...
    <option value="other">其他（自定义）</option>
  </select>
  <input type="text" class="course-link-platform-custom" placeholder="自定义标签" hidden>
  <input type="url" class="course-link-url" placeholder="https://...">
  <button type="button" class="btn-remove-course-link">×</button>
</div>
```

**交互**：
- 选 "other" → 显示 `platform-custom` input，否则隐藏
- × 按钮 → 删除该行 + 重新索引 `data-index`
- "+ 添加链接" → 追加新行（platform 默认 `bilibili` + url 空）
- `state.courseLinks: [{platform, url}]` 数组，提交时 buildPayload 用

### 5. 后端 API

**db.js 新增**（参考 `pricing_tiers` 模式）：
- `async getProductLinks(productId): [{id, platform, url, sort_order}]`
- `async setProductLinks(productId, links)` — 事务：DELETE 旧 + INSERT 新
- `async getProductWithLinks(productId)` — product JOIN links（联表返回完整对象）

**db.js 修改**：
- `createProduct` 接受 `isCourse` + `courseLinks`，课程型时 price=0/pricing_tiers=null
- `updateProduct` 接受 `isCourse` + `courseLinks`，事务里更新
- `getProductById` / `getAllProducts` 同时返回 `isCourse` 字段

**server.js 修改**：
- POST /api/products：解析 `req.body.isCourse` + `req.body.courseLinks` → 调 createProduct
- PUT /api/products/:id：同上 + 调 updateProduct
- GET /api/products / GET /api/products/:id：返回 `isCourse` 字段（courseLinks 联表由 db.js 函数返回）

### 6. 前台展示

**admin-product.html 列表**（renderTable 函数 line 127-150）：
- 价格列：课程型时显示蓝色 badge `课程型 · N 个链接`（替代价格）
- 普通产品：维持现状

**product.html 详情**（公开产品页）：
- 课程型：隐藏"立即购买"按钮 + 隐藏价格
- 课程型：显示链接卡片网格（每张卡：平台名 + "访问"按钮，链接为外链 `target="_blank"`）
- 普通产品：维持现状

### 7. 数据迁移

`migrate-2026-06-22-course-products.js`：
1. `ALTER TABLE products ADD COLUMN is_course INT DEFAULT 0`（幂等：先查列是否存在）
2. `CREATE TABLE IF NOT EXISTS product_links (...)`（幂等：IF NOT EXISTS）
3. 现有产品全部 `is_course=0`（默认），零数据迁移

## Architecture

**改造 8 个文件 + 新建 1 个 migration + 新建 1 个 spec/plan doc**：
1. `prisma/schema.js` — 加 `products.isCourse` + `ProductLink` model
2. `migrate-2026-06-22-course-products.js` — 迁移脚本
3. `db.js` — 加 3 个函数 + 改 4 个函数
4. `server.js` — 改 POST/PUT 路由解析新字段
5. `public/admin-product-form.html` — 加 `#isCourse` 复选框 + `#courseLinksSection` 容器
6. `public/css/admin-product-form.css` — 加 `.course-link-row` 样式
7. `public/js/admin-product-form.js` — 加 `toggleCourse` + 链接 CRUD + `state.courseLinks` + `buildPayload` 加 `courseLinks`
8. `public/admin-product.html` — 列表价格列显示课程型
9. `public/product.html` — 详情页课程型分支

## Tech Stack

- MySQL + migration 脚本（项目惯例）
- Express + 现有路由模式
- 前端：partial form + vanilla JS（沿用 Task 1-3 的 window.ProductForm API）

## Out of Scope（YAGNI）

- ❌ 拖拽排序（sort_order = 数组下标即可）
- ❌ 链接点击统计
- ❌ 链接图标库（用 select 文字 + 平台名）
- ❌ 链接二维码生成
- ❌ 链接过期时间
- ❌ 课程型产品单独搜索/筛选
- ❌ 平台图标（Lucide 有 `link` 图标可复用，不做平台特定图标）

## Risks

1. **数据迁移失败**：脚本幂等（IF NOT EXISTS / 检查列），可重跑
2. **FK 约束失败**：现有 product id 全部有效，FK ON DELETE CASCADE 保证删产品时自动删链接
3. **前端状态污染**：buildPayload 必须清空价格字段，避免课程型时意外提交
4. **向后兼容**：现有 API 返回多一个 `isCourse: 0` 字段，客户端忽略即可

## Open Questions

无（4 个关键设计决策用户已批准）
