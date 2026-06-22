# 课程分类 spec

**Date**: 2026-06-22
**Status**: approved（用户 2026-06-22 下午批准设计）
**Author**: Claude（基于 brainstorming + 2 个 visual mockup）

## Why

当前 products.category 字段只支持 5 个软件分类（开发工具/设计软件/安全软件/效率工具/实用工具），**没有课程型产品的细分维度**，也缺少 GitHub 仓库这种典型的开源软件分类。用户希望区分：
- 企业产品（软件型新增分类）
- 外站课程（课程型新增分类）
- 企业内训（课程型新增分类）
- **GitHub 仓库**（软件型新增分类）

并在产品卡片、轮播图、admin 列表的左上角显示彩色 badge 作为视觉提示。

## What

### 1. 数据模型

**不变**：复用现有 `products.category` 字段（VARCHAR），无 schema 变更。

**数据值扩展**（仅在 form 下拉框中扩展，DB 已能容纳任意字符串）：

| isCourse=0（软件型）| isCourse=1（课程型）|
|--------------------|---------------------|
| 开发工具 / 设计软件 / 安全软件 / 效率工具 / 实用工具 / **企业产品**（新）/ **GitHub 仓库**（新）| **外站课程**（新）/ **企业内训**（新）|

**关键约束**：
- "企业产品" 仅对软件型可见（form + admin 显示）
- "外站课程" / "企业内训" 仅对课程型可见
- DB 不做字段约束（VARCHAR 可存任意值），由 form 下拉框 + JS 切换控制可见性
- **数据迁移：不需要**（已验证 DB 仅存"实用工具"，无冲突值）

### 2. UI 互斥规则

**新增 form 切换逻辑**（`public/admin-product-form.html` + `public/js/admin-product-form.js`）：

```js
function updateCategoryOptions(root, isCourse) {
  const select = $('#category', root);
  select.innerHTML = ''; // 清空

  const softwareCategories = ['开发工具', '设计软件', '安全软件', '效率工具', '实用工具', '企业产品', 'GitHub 仓库'];
  const courseCategories = ['外站课程', '企业内训'];

  const options = isCourse ? courseCategories : softwareCategories;
  options.forEach(cat => {
    const option = document.createElement('option');
    option.value = cat;
    option.textContent = cat;
    select.appendChild(option);
  });
}
```

**触发时机**：
- init 时根据 `state.currentProduct?.isCourse` 初始化
- `isCourse` 复选框 change 事件时切换
- `toggleCourse` 函数内调用（与现有 4 字段互斥逻辑一致）

**边界**：
- 编辑模式：先用当前 product.category 初始化，再根据 isCourse 重置选项（保留当前选中值）
- 新建模式：默认选中第一个选项

### 3. Badge 样式（CSS）

**新增 3 个 badge 颜色**（`public/css/pages/admin.css` + `public/css/pages/product-card.css`）：

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

**与现有"课程型"badge 关系**：课程型产品同时显示 2 个 badge（左对齐）：
- 课程型（紫色 `badge-purple`，现有 T5 实现）
- 外站课程 / 企业内训（绿色 / 橙色，本次新增）

### 4. 显示位置（3 处）

#### 4.1 首页轮播图（`public/index.html` line 224-243）

**hero-card-badge 替换为 category badge**：
- 当前：`<span class="hero-card-badge">限时优惠</span>`
- 改后：`<span class="hero-card-badge badge-enterprise-product">企业产品</span>`
- 逻辑：software → 6 个分类；course → 2 个分类
- JS 渲染分支：根据 `product.category` 值匹配 CSS class

#### 4.2 首页产品卡片（`public/index.html` line 504）

**product-card-category 文字 → badge 替换**：
- 当前：`<div class="product-card-category">${product.category || '软件'}</div>`
- 改后：`<span class="product-card-category-badge ${getCategoryBadgeClass(product.category)}">${escapeHtml(product.category || '软件')}</span>`
- 保留现有 `.product-card-category` 文字 class 作为非分类时的 fallback

#### 4.3 Admin 后台产品列表（`public/admin-product.html`）

**新增"分类"列**（在"类型"列之前）：
- 表头：`分类`
- 数据：彩色 badge
- 复用现有 `.badge-*` 体系
- 位置：renderTable line 132-156 调整列顺序：ID / 名称 / **分类** / 类型 / 价格 / 版本 / 平台 / 操作

### 5. helper 函数

**新增**（`public/js/admin-product-form.js` + `public/index.html` 内联 JS）：

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

**位置**：
- form JS：内部 helper，无需全局
- index.html：内联在 `<script>` 标签内

### 6. cache-bust（per memory `feedback_admin_css_cache_bust.md`）

修改 admin CSS 后必须给所有 admin HTML 加 `?v=` 时间戳绕 7d immutable 缓存：

- `public/admin-product.html`：`/css/pages/admin.css?v=20260622-XXXX`
- 其他 25 个 admin HTML：同步 bump 时间戳

## Architecture

**修改 6 个文件**（无新建）：

1. `public/admin-product-form.html` — category `<select>` 加 `id`（已有），下拉选项改为动态渲染
2. `public/js/admin-product-form.js` — 加 `updateCategoryOptions(root, isCourse)` + `getCategoryBadgeClass(category)` helper + 事件绑定
3. `public/admin-product.html` — renderTable 加"分类"列 + badge CSS class
4. `public/index.html` — hero-carousel slide + product card 渲染分支加 badge
5. `public/css/pages/admin.css` — 加 `.badge-enterprise-product` / `.badge-external-course` / `.badge-enterprise-internal` / `.badge-github-repo`
6. `public/css/pages/product-card.css` — 加 `.product-card-category-badge`（卡片内位置样式）

## Tech Stack

- 现有 vanilla JS 模式（无新依赖）
- 现有 CSS 体系（复用 `.badge-purple` 风格）
- 复用 products.category 字段（无 DB 变更）
- 不引入 i18n（中文 label 直接硬编码）

## Out of Scope（YAGNI）

- ❌ 课程分类筛选/搜索（spec 未要求）
- ❌ 课程分类图标（用文字 + 颜色，不做平台特定图标）
- ❌ 自定义颜色（3 个分类颜色固定，不做主题切换）
- ❌ 课程分类排序（保留 API 返回顺序）
- ❌ 课程分类国际化（中文 label 硬编码）
- ❌ 数据库层 CHECK 约束（form 下拉框控制即可）
- ❌ 旧产品迁移脚本（DB 仅存"实用工具"，无冲突值）
- ❌ 课程分类独立管理页面（沿用现有 form）
- ❌ API 层校验（依赖 form 下拉框控制，无需服务端校验）

## Risks

1. **历史产品 category 值异常**：DB 已验证只有"实用工具"，无风险
2. **edit 模式分类丢失**：form 编辑现有产品时如果 product.category 不在新选项列表里（如"实用工具"+课程型切换），会强制重置为第一个 → 需在 init 时先保留当前 category 再切换选项
3. **CSS 优先级冲突**：新 badge class 与现有 `.badge` / `.badge-info` 等基类共存 → 复用 base + modifier 模式（与 T5 badge-purple 一致）
4. **mobile 响应式**：badge 在窄屏下可能挤压 → 沿用现有响应式规则，文字保持简短
5. **cache-bust 漏改**：26 个 admin HTML 都需 bump 时间戳 → 实施时按 feedback 强制要求做

## Open Questions

无（4 个关键设计决策用户已批准）：
- 数据模型：复用 category 字段 ✅
- 数据值映射：企业产品=软件 / 外站课程+企业内训=课程 ✅
- badge 颜色：蓝/绿/橙 ✅
- 显示位置：首页（轮播+卡片）+ admin 列表 ✅

## Visual Reference

`.superpowers/brainstorm/3591-1782119498/content/badge-colors.html` 和 `form-dropdown.html` 两个 mockup 屏已展示最终效果（用户已批准）。
