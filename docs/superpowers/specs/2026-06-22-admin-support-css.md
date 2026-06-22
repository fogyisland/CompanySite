# admin-support 页面 CSS 优化

> 日期：2026-06-22
> 范围：`public/admin-support.html`（技术支持工单管理）
> 目标：补齐 9 个缺失 CSS class 的样式（工单表格/徽章/按钮/回复气泡/详情行）+ 模态框微调 markup（统一 admin 端风格），保持现代渐变 + 卡片化 + QQ 风格左右气泡的视觉语言，与产品 form 重设计后的 admin 主题一致

## 1. 现状与根因

### 1.1 admin-support.html 用了但 CSS 未定义的 class

| class | 用途 | 当前状态 |
|---|---|---|
| `.tickets-table` | 工单表格 | ❌ 无 CSS，浏览器默认 table 样式 |
| `.priority-badge` + 修饰类（high/normal/low） | 优先级徽章 | ❌ 无 CSS |
| `.status-badge` + 修饰类（open/replied/resolved/closed） | 状态徽章 | ❌ 无 CSS |
| `.btn-view` | 表格行"查看"按钮 | ❌ 无 CSS |
| `.btn-resolve` | 详情 modal "发送回复"按钮 | ❌ 无 CSS |
| `.replies-section` | 详情 modal 回复区容器 | ❌ 无 CSS |
| `.reply-item` + 修饰类（user/admin） | 回复气泡 | ❌ 无 CSS |
| `.reply-header` / `.reply-content` | 气泡头/正文 | ❌ 无 CSS |
| `.reply-form` / `.reply-form-actions` | 详情 modal 回复表单 | ❌ 无 CSS |
| `.ticket-detail-item` | 详情字段行 | ❌ 无 CSS |

### 1.2 重复定义风险

- `.modal / .modal-content / .modal-close`：在 `style.css` 有定义（公开端用）
- admin-support 用了同名 class，但走的是 style.css 公开端样式——视觉与 admin 端主题不一致

### 1.3 决策（已与用户确认）

- **范围**：补 CSS + 模态框微调 markup（小改 3 处 HTML）
- **整体风格**：现代渐变（card 阴影 + 渐变背景 + pill 圆角）
- **回复气泡**：QQ 微信式左右对齐（用户左灰底、管理员右蓝渐变底）
- **modal 风格**：切到 admin-theme.css 模式（与产品 form 一致），加 `admin-support-modal` 前缀避免与公开端冲突
- **CSS 类作用域**：全部限定 `.admin-main .xxx`（admin 端用，不影响公开端）

## 2. 架构

### 2.1 文件改动

| 文件 | 角色 |
|---|---|
| `public/css/pages/admin-support.css` | **新** · admin-support 专属样式（限定 .admin-main） |
| `public/css/admin-support-modal.css` | **新** · modal 样式（限定 .admin-main，参照 admin-product-modal.css 模式） |
| `public/admin-support.html` | **改** · 引入两个新 CSS，detail-modal 容器加 `admin-support-modal` 前缀 class |

### 2.2 加载顺序

admin-support.html 现有引用：
```html
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/themes/theme-variables.css">
<link rel="stylesheet" href="/css/pages/admin.css?v=20260621-1300">
<link rel="stylesheet" href="/css/admin-theme.css?v=20260621-1736">
<link rel="stylesheet" href="/css/admin-sidebar.css?v=20260621-1625">
```

新增两个（用 `?v=20260622-XXXX` 时间戳绕 7d immutable 缓存）：
```html
<link rel="stylesheet" href="/css/pages/admin-support.css?v=20260622-1100">
<link rel="stylesheet" href="/css/admin-support-modal.css?v=20260622-1100">
```

## 3. 视觉规范

### 3.1 表格（.tickets-table）

- 卡片化：外层 `background: var(--white)` + `border-radius: 12px` + `box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03)`
- 表头：`background: linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(139,92,246,0.04) 100%)`，加粗 + 大字号
- 行：斑马纹（偶数行 `rgba(0,0,0,0.02)`）+ hover 高亮（`rgba(59,130,246,0.04)`）
- 单元格 padding 14px 16px（与 ProductManagement 表单一致）
- 空状态：`.empty-state` 居中 + text-light 灰色 + padding 60px

### 3.2 徽章（pill 圆角 + 渐变）

**优先级徽章**：
- `.priority-badge.high` — 红色渐变 `linear-gradient(135deg, #ef4444 0%, #dc2626 100%)` + 白字
- `.priority-badge.normal` — 蓝色渐变 `linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)` + 白字
- `.priority-badge.low` — 灰色渐变 `linear-gradient(135deg, #94a3b8 0%, #64748b 100%)` + 白字
- 通用：`padding: 4px 12px`、`border-radius: 12px`（pill）、`font-size: 12px`、`font-weight: 500`、`box-shadow: 0 1px 2px rgba(0,0,0,0.08)`

**状态徽章**：
- `.status-badge.open` — 橙色渐变 `linear-gradient(135deg, #f59e0b 0%, #d97706 100%)` + 白字
- `.status-badge.replied` — 蓝色渐变（同 high/normal 蓝） + 白字
- `.status-badge.resolved` — 绿色渐变 `linear-gradient(135deg, #10b981 0%, #059669 100%)` + 白字
- `.status-badge.closed` — 灰色渐变（同 low 灰） + 白字

### 3.3 按钮

- `.btn-view` — 蓝色渐变小按钮（padding 6px 14px、border-radius 8px、白字、阴影）+ hover 上移 1px
- `.btn-resolve` — 绿色渐变中按钮（padding 10px 20px、border-radius 10px、白字、阴影）+ hover 上移 2px

### 3.4 详情 modal 内

**字段行（`.ticket-detail-item`）**：
- 网格布局：左 label（`min-width: 100px`、text-light 灰、font-weight 500），右 value
- 上下间距 12px、底部边框 1px 浅灰

**回复气泡（`.reply-item`）**：
- 用户（`.reply-item.user`）：
  - `flex-direction: row`、`align-items: flex-start`
  - 气泡：`background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)`、`border-radius: 14px 14px 14px 4px`（左下角小圆角）、`padding: 12px 16px`、`max-width: 70%`
- 管理员（`.reply-item.admin`）：
  - `flex-direction: row-reverse`、`align-items: flex-start`
  - 气泡：`background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)`、白字、`border-radius: 14px 14px 4px 14px`（右下角小圆角）
  - 头/时间标签也变白半透明
- 头：昵称 + 时间，font-size 12px、color 半透明白
- 内容：font-size 14px、line-height 1.6、`white-space: pre-wrap`

**回复表单（`.reply-form`）**：
- textarea 100% 宽、min-height 100px、border-radius 10px、focus 蓝边 + 阴影
- `.reply-form-actions` — flex 布局、justify-content: space-between、左复选框右按钮

**空回复**：
- `<p>暂无回复</p>` 居中 + text-light

### 3.5 模态框

切到 admin-theme.css 模式（与产品 form modal 一致）：
- `.admin-support-modal-backdrop` — `position: fixed; inset: 0; background: rgba(0,0,0,0.5); align-items: flex-start; justify-content: center; z-index: 2000; padding: 24px; overflow-y: auto`
- `.admin-support-modal-backdrop:not([hidden]) { display: flex }`（强制显示）
- `.admin-support-modal` — `background: white; border-radius: 16px; width: 90%; max-width: 800px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-height: calc(100vh - 48px); overflow-y: auto; padding: 32px; position: relative`
- `.admin-support-modal-close` — 右上角 28px 字号、40x40 圆角灰色按钮、hover 加深

## 4. Markup 微调（仅 3 处）

### 4.1 detail-modal 容器

**改前**（line 78-84）：
```html
<div class="modal" id="detail-modal">
  <div class="modal-content">
    <button class="modal-close" onclick="closeModal()">&times;</button>
    <h3>工单详情 - #<span id="modal-ticket-id"></span></h3>
    <div id="modal-content"></div>
  </div>
</div>
```

**改后**：
```html
<div class="admin-support-modal-backdrop" id="detail-modal" hidden>
  <div class="admin-support-modal" onclick="event.stopPropagation()">
    <button class="admin-support-modal-close" onclick="closeModal()">&times;</button>
    <h3>工单详情 - #<span id="modal-ticket-id"></span></h3>
    <div id="modal-content"></div>
  </div>
</div>
```

3 处变化：
1. 外层 class 从 `modal` 改为 `admin-support-modal-backdrop`，加 `hidden` 属性
2. 内层 class 从 `modal-content` 改为 `admin-support-modal`，加 `onclick="event.stopPropagation()"`（防止点击 modal 内部触发 backdrop 关闭）
3. 关闭按钮 class 从 `modal-close` 改为 `admin-support-modal-close`

### 4.2 showDetail / closeModal JS 改动（2 处）

**showDetail**（line 283）：
```js
// 改前
document.getElementById('detail-modal').classList.add('active');
// 改后
document.getElementById('detail-modal').hidden = false;
```

**closeModal**（line 286-288）：
```js
// 改前
function closeModal() {
  document.getElementById('detail-modal').classList.remove('active');
}
// 改后
function closeModal() {
  document.getElementById('detail-modal').hidden = true;
}
```

### 4.3 backdrop 点击关闭（已正确）

line 332-334 已有 backdrop 点击关闭逻辑（`if (e.target === this) closeModal()`），但配合新 markup 后 backdrop 元素是 `#detail-modal` 本身，modal 内容是它的 child。`event.stopPropagation()` 在 modal 内容上阻止冒泡到 backdrop，所以：
- 点击 backdrop → e.target === this → close
- 点击 modal 内容 → event.stopPropagation → 不冒泡 → e.target !== this → 不关

**此逻辑已正确，无需改 JS**。

### 4.4 不改的部分

- 不动表格行渲染逻辑（renderTableData / showDetail）
- 不动 API 调用
- 不动 sidebar / 主题 / settings 加载
- 不动按钮文字（"查看" / "发送回复" / "同时标记为已解决"）

## 5. 详细 CSS 内容

### 5.0 颜色与变量

使用 admin-theme.css 已定义的变量（不引入新变量）：
- `--admin-primary` (#0969da) / `--admin-primary-hover` (#0860c7) — 主蓝
- `--admin-bg-card` (#ffffff) — 卡片背景（白）
- `--admin-bg-page` (#f6f9fc) — 页面背景（浅灰）
- `--admin-bg-hover` (#f1f5f9) — hover 高亮
- `--admin-text-primary` (#24292f) — 主文字
- `--admin-text-secondary` (#57606a) — 副文字
- `--admin-text-muted` (#8c959f) — 弱化文字
- `--admin-border` (#d0d7de) / `--admin-border-light` (#eaeef2) — 边框

**徽章/气泡的渐变色直接用 hex**（admin 主题没有 badge 渐变变量，单独写）：
- 蓝渐变：`linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)`
- 绿渐变：`linear-gradient(135deg, #10b981 0%, #059669 100%)`
- 橙渐变：`linear-gradient(135deg, #f59e0b 0%, #d97706 100%)`
- 红渐变：`linear-gradient(135deg, #ef4444 0%, #dc2626 100%)`
- 灰渐变：`linear-gradient(135deg, #94a3b8 0%, #64748b 100%)`
- 用户气泡：`linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)`

### 5.1 admin-support.css 结构

```css
/* 限定作用域 */
.admin-main { /* ... existing 父级 ... */ }

/* 表格 */
.admin-main .tickets-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  background: var(--admin-bg-card);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03);
}
.admin-main .tickets-table thead { background: linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(139,92,246,0.04) 100%); }
.admin-main .tickets-table th { padding: 14px 16px; text-align: left; font-weight: 600; font-size: 13px; color: var(--admin-text-primary); }
.admin-main .tickets-table td { padding: 14px 16px; border-top: 1px solid var(--admin-border-light); font-size: 14px; color: var(--admin-text-primary); }
.admin-main .tickets-table tbody tr { transition: background 0.15s ease; }
.admin-main .tickets-table tbody tr:hover { background: var(--admin-bg-hover); }
.admin-main .tickets-table tbody tr:nth-child(even) { background: rgba(0,0,0,0.015); }
.admin-main .tickets-table tbody tr:nth-child(even):hover { background: var(--admin-bg-hover); }

/* 徽章 */
.admin-main .priority-badge,
.admin-main .status-badge {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  color: white;
  box-shadow: 0 1px 2px rgba(0,0,0,0.08);
}
.admin-main .priority-badge.high { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
.admin-main .priority-badge.normal { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); }
.admin-main .priority-badge.low { background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%); }
.admin-main .status-badge.open { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }
.admin-main .status-badge.replied { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); }
.admin-main .status-badge.resolved { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
.admin-main .status-badge.closed { background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%); }

/* 按钮 */
.admin-main .btn-view {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white; border: none; border-radius: 8px;
  padding: 6px 14px; font-size: 13px; font-weight: 500; cursor: pointer;
  box-shadow: 0 2px 6px rgba(59,130,246,0.3);
  transition: all 0.2s ease;
}
.admin-main .btn-view:hover { transform: translateY(-1px); box-shadow: 0 4px 10px rgba(59,130,246,0.4); }
.admin-main .btn-resolve {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  color: white; border: none; border-radius: 10px;
  padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer;
  box-shadow: 0 2px 8px rgba(16,185,129,0.3);
  transition: all 0.2s ease;
}
.admin-main .btn-resolve:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(16,185,129,0.4); }

/* 详情字段 */
.admin-main .ticket-detail-item {
  display: flex;
  align-items: flex-start;
  padding: 10px 0;
  border-bottom: 1px solid var(--admin-border-light);
  font-size: 14px;
}
.admin-main .ticket-detail-item:last-child { border-bottom: none; }
.admin-main .ticket-detail-item .label {
  min-width: 100px;
  color: var(--admin-text-muted);
  font-weight: 500;
}

/* 回复区 */
.admin-main .replies-section { margin-top: 24px; }
.admin-main .replies-section h4 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: var(--admin-text-primary); }
.admin-main .reply-item { display: flex; margin-bottom: 12px; }
.admin-main .reply-item.user { justify-content: flex-start; }
.admin-main .reply-item.admin { justify-content: flex-end; }
.admin-main .reply-item .reply-content {
  padding: 12px 16px;
  max-width: 70%;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.admin-main .reply-item.user .reply-content {
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  color: var(--admin-text-primary);
  border-radius: 14px 14px 14px 4px;
}
.admin-main .reply-item.admin .reply-content {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
  border-radius: 14px 14px 4px 14px;
}
.admin-main .reply-item .reply-header {
  font-size: 12px;
  margin-bottom: 4px;
  opacity: 0.75;
}

/* 回复表单 */
.admin-main .reply-form { margin-top: 24px; }
.admin-main .reply-form h4 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: var(--admin-text-primary); }
.admin-main .reply-form textarea {
  width: 100%; min-height: 100px; padding: 12px 14px;
  border: 1px solid var(--admin-border); border-radius: 10px;
  font-size: 14px; font-family: inherit; resize: vertical;
  transition: all 0.2s ease;
}
.admin-main .reply-form textarea:focus {
  outline: none; border-color: var(--admin-primary);
  box-shadow: 0 0 0 3px rgba(9,105,218,0.12);
}
.admin-main .reply-form-actions {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 12px;
}
```

### 5.2 admin-support-modal.css 结构

```css
.admin-support-modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.5);
  align-items: flex-start; justify-content: center;
  z-index: 2000; padding: 24px; overflow-y: auto;
}
.admin-support-modal-backdrop:not([hidden]) { display: flex; }
.admin-support-modal {
  background: var(--admin-bg-card);
  border-radius: 16px;
  width: 90%; max-width: 800px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  position: relative;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding: 32px;
}
.admin-support-modal h3 { margin: 0 0 20px; font-size: 17px; font-weight: 600; color: var(--admin-text-primary); }
.admin-support-modal-close {
  position: absolute; top: 16px; right: 16px;
  background: rgba(0,0,0,0.05);
  border: none; font-size: 28px; width: 40px; height: 40px;
  border-radius: 8px; cursor: pointer;
  color: var(--admin-text-muted);
  transition: all 0.2s ease;
  line-height: 1; padding: 0;
}
.admin-support-modal-close:hover { background: rgba(0,0,0,0.1); color: var(--admin-text-primary); }
```

## 6. 验证清单

### 6.1 视觉
- [ ] 工单表格：圆角卡片、斑马纹、hover 高亮
- [ ] 徽章：pill 圆角 + 渐变 + 白字 + 阴影
- [ ] 状态徽章颜色：open 橙、replied 蓝、resolved 绿、closed 灰
- [ ] 优先级徽章颜色：high 红、normal 蓝、low 灰
- [ ] 按钮：view 蓝渐变、resolve 绿渐变，hover 上移

### 6.2 布局
- [ ] 详情 modal：max-width 800px，居中，圆角
- [ ] 字段行：左 label 右 value，间距合理
- [ ] 回复气泡：用户左对齐灰底、管理员右对齐蓝渐变底
- [ ] 回复表单：textarea + 复选框 + 按钮布局合理

### 6.3 交互
- [ ] 点击 backdrop 关闭 modal
- [ ] 点击 modal 内部不关闭
- [ ] 点 × 按钮关闭
- [ ] 切换工单时 modal 内容正确刷新

### 6.4 兼容
- [ ] 公开端页面（`/support.html`）不受影响（CSS 全部限定 `.admin-main`）
- [ ] 其他 admin 页面（admin-product 等）不受影响
- [ ] 主题切换（siteTheme）正常

## 7. 范围外（YAGNI）

- 不做响应式（admin 端桌面用足够）
- 不动工单 API
- 不动工单创建流程（如果有，在其他页面）
- 不改 admin 主题变量
- 不做深色模式特别优化（沿用 theme-variables）
- 不动 sidebar / 统计卡片 / 搜索框（这些已有 CSS）

## 8. 风险

- **CSS 限定不严**：如果忘记 `.admin-main` 前缀，可能与公开端或未来组件冲突。Mitigation: 所有规则都加 `.admin-main` 限定
- **markup 微调风险**：改 3 处 HTML + 2 处 JS，量小，回归测试在 modal 关闭/打开流程
- **theme-variables 缺失**：现有 admin 主题用 `--admin-*` 变量；如果 admin-support.css 用了 `var(--white)` 之类通用变量，在 admin 框架内应该可用；但需要验证

## 9. 实施步骤概要

1. 创建 `public/css/pages/admin-support.css`（完整内容）
2. 创建 `public/css/admin-support-modal.css`（完整内容）
3. 修改 `public/admin-support.html`：
   - 在 `<head>` 加 2 个新 `<link>` 引用
   - detail-modal 容器 class 改名 + 加 hidden
   - 关闭按钮 class 改名
   - showDetail / closeModal JS 改用 `.hidden` 替代 `.active`

预估 1-2 个 subagent 任务（CSS 一个 + HTML 改一个）即可完成。
