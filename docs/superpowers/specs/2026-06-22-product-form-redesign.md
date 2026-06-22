# 产品管理表单重设计

> 日期：2026-06-22
> 范围：产品添加/编辑表单（`/ProductManagement` + 列表页 modal）
> 目标：
> 1) 16:9 宽屏观感（不再像手机）
> 2) "订阅方案" 替代 "多价格方案"
> 3) 仅月付/年付 2 档，duration 固定 1/12 个月
> 4) 启用订阅时**完全隐藏**基础价格（连 label 一起不显示）
> 5) 列表页弹 modal 共享同一份表单 partial

## 1. 架构：抽取 form 为可复用 partial

### 1.1 文件拆分

| 文件 | 角色 |
|---|---|
| `public/admin-product-form.html` | **新** · 表单 markup（无 layout chrome） |
| `public/css/admin-product-form.css` | **新** · 抽取的表单 CSS |
| `public/js/admin-product-form.js` | **新** · `window.ProductForm.init(rootEl, opts)` 入口 |
| `public/ProductManagement.html` | **改** · 瘦壳，引入 partial |
| `public/admin-product.html` | **改** · 列表页加 modal + 动态加载 partial |

### 1.2 init 协议

```js
window.ProductForm.init(rootElement, {
  mode: 'create' | 'edit',
  productId: number | null,    // edit 模式必传
  onSaved: (product) => {},    // 保存成功回调（modal 用，关弹窗 + 刷新列表）
  onCancel: () => {}            // 取消回调（modal 用）
});
```

`/ProductManagement` 传 `mode='create'` 或 `mode='edit'`，`onSaved` 跳列表。
`/admin-product` modal 传 `onSaved` 关闭弹窗 + `loadProducts()`。

### 1.3 数据契约

- API: `POST /api/products` / `PUT /api/products/:id`
- `pricingTiers` 仍为 JSON 数组，**强制 2 元素**（schema 不变，运行时校验）
- 每档固定字段 `{ label, duration, price }`，`duration` 由前端硬编码 1/12，不让 admin 填
- `externalLink` boolean 仍为复选框
- 提交时只在 `usePricingTiers=true` 时才把 `pricingTiers` 一起提交；`usePricingTiers=false` 时只发 `price`

## 2. UI 改动

### 2.1 16:9 宽屏布局

```css
.product-form-shell { max-width: 1600px; margin: 0 auto; padding: 32px 40px; }
.product-form-shell .form-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 28px; }
@media (max-width: 1200px) { .product-form-shell .form-row { grid-template-columns: 1fr; } }
```

- 全页和 modal 都用同一 shell class
- 桌面端（>= 1200px）双列，移动端单列
- 视觉上是"widescreen 工作台"而非手机感

### 2.2 "订阅方案" 替代 "多价格方案"

| 改动点 | 旧 | 新 |
|---|---|---|
| 复选框 label | 启用多价格方案（支持不同授权时长） | 启用订阅方案（月付 / 年付） |
| Section 标题 | 价格方案 | 订阅方案 |
| Helper text | 如启用多价格方案，此价格为默认显示价格 | 启用后基础价格不参与购买；客户只能选月付或年付 |

### 2.3 仅 2 档：月付 + 年付（duration 固定）

```html
<div class="pricing-tiers-section" id="pricingTiersSection">
  <h4>订阅方案</h4>
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
  <!-- 无 +添加 / -删除 按钮，无 duration 输入 -->
</div>
```

- 固定 2 行，无 add/remove。直接字段化，不再用动态数组
- **duration 固定**：月付 = 1 个月，年付 = 12 个月（不可改、不让 admin 填）
- 月付/年的 label 上直接显示 `(1 个月)` / `(12 个月)` 作为提示，duration 在保存时硬编码到 JSON 里
- 2 个 input 字段：仅月付价格、年付价格

### 2.4 启用订阅 → 完全隐藏基础价格

```js
usePricingTiers.addEventListener('change', () => {
  const enabled = usePricingTiers.checked;
  // 完全隐藏（不只 disabled）
  const priceField = document.getElementById('priceField');  // 整个 .form-field 容器
  priceField.hidden = enabled;
  // 同时清理值，避免意外提交
  if (enabled) document.getElementById('price').value = '';
});
```

CSS:
```css
/* 不用 :disabled 灰化，直接 hidden 整块消失 */
.form-field[hidden] { display: none; }
```

- 不是"灰化禁用"，是**完全消失**（连 label 一起不显示）
- 取消勾选时再显示出来
- 保存时只在 `usePricingTiers=false` 时把 `price` 提交到 API

## 3. 数据迁移策略

### 3.1 现有产品 (3 档: 1年/2年/3年) 怎么办

- form load 时检测 `savedTiers.length > 2`
- 若 > 2 → 取**最接近月付的**作为月付档（如 1 月/3 月 → 取 1 月），**最接近年付的**作为年付档
- 顶部显示一个一次性 notice：「已将原 N 档数据迁移为 2 档订阅方案，请确认后保存」
- 一次保存即固化

### 3.2 月付/年付的"时长"（固定）

**duration 固定**：月付 = 1 个月，年付 = 12 个月，**不可改**。

UI 上 label 后面显示 `(1 个月)` / `(12 个月)` 作为静态提示，admin 只能填价格。

存储到 `pricingTiers`:
```json
[
  { "label": "月付", "duration": 1,  "price": 29 },
  { "label": "年付", "duration": 12, "price": 299 }
]
```

前端在保存时直接硬编码 `duration`，从 form 里只读价格两个字段。

### 3.3 现有 0 档（普通 product）

保留 `price` 字段，`usePricingTiers` 复选框默认不勾。`pricingTiers` 存 `null`。

## 4. modal 集成

### 4.1 admin-product.html 改动

```html
<button onclick="openProductModal('create')">+ 添加产品</button>
<button onclick="openProductModal('edit', id)">编辑</button>  <!-- 改原"编辑"链接 -->

<div id="productModal" class="modal" hidden>
  <div class="modal-content product-form-shell">
    <span class="modal-close" onclick="closeProductModal()">&times;</span>
    <div id="productFormMount"></div>
  </div>
</div>
```

### 4.2 加载逻辑

```js
async function openProductModal(mode, productId = null) {
  document.getElementById('productModal').hidden = false;
  const mount = document.getElementById('productFormMount');
  if (!mount.dataset.loaded) {
    const html = await fetch('/admin-product-form.html').then(r => r.text());
    mount.innerHTML = html;
    // 加载配套 CSS
    if (!document.querySelector('link[href*="admin-product-form.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/css/admin-product-form.css';
      document.head.appendChild(link);
    }
    // 加载配套 JS
    await loadScript('/js/admin-product-form.js');
    mount.dataset.loaded = '1';
  }
  window.ProductForm.init(mount.querySelector('form'), {
    mode, productId,
    onSaved: () => { closeProductModal(); loadProducts(); },
    onCancel: closeProductModal
  });
}
```

### 4.3 列表页"编辑"链接

原来 `<a href="/ProductManagement?id=X">编辑</a>` 改为 `<button onclick="openProductModal('edit', X)">编辑</button>`，但保留 `/ProductManagement?id=X` 仍可深链接（直接 URL 进入全页编辑）。

## 5. 范围外（YAGNI）

- 不改 product.html（公开端产品页）
- 不改 pricingTiers 在公开页的展示（沿用现有 "多方案" 徽章逻辑或后续）
- 不动 AI 优化描述按钮
- 不动富文本编辑器
- 不动图片上传

## 6. 验证

- 桌面端（>=1200px）表单宽度应明显 > 当前 1000px
- 勾选"启用订阅方案"后基础价**整个 form-field 消失**（不是变灰）
- 月付/年付只能填 2 个固定价格字段，无 +添加按钮，无 duration 输入
- 取消勾选时基础价重新出现
- modal 打开/关闭正常
- 列表页"编辑"在 modal 中打开，"+添加产品"也走 modal
- 旧产品 3 档数据加载时显示迁移 notice
- 保存时 `duration` 自动为 1/12，admin 改不了

## 7. 风险

- **JS 重构**：inline JS 抽到 module 需保证所有事件监听重新挂载。Mitigation: 写完后手动测试每个按钮
- **CSS 抽离**：原 inline `<style>` 块含很多页面专属样式，抽取时需保留所有视觉。Mitigation: 视觉对比截图
- **fetch + innerHTML**：注入 HTML 时 inline `<script>` 不会执行。Mitigation: 用动态 `loadScript()`
- **modal 多次打开/关闭**：form 状态可能残留。Mitigation: 每次 init 前 reset form
