# admin-support 页面 CSS 优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 admin-support.html 补齐 9 个缺失的 CSS class（工单表格/徽章/按钮/回复气泡/详情行/回复表单），同时把 detail-modal 从公开端样式切到 admin-theme.css 模式（与产品 form modal 一致），保持现代渐变 + 卡片化 + QQ 风格左右气泡的视觉语言。

**Architecture:** 拆 2 个新 CSS 文件（`pages/admin-support.css` 装表格/徽章/按钮/气泡/详情/表单样式；`admin-support-modal.css` 装 modal-backdrop 样式），全部用 `.admin-main` 限定作用域避免污染公开端。`admin-support.html` 加 2 个 link 引用、3 处 modal markup 微调、2 处 JS 改用 `hidden` 属性替代 `classList.add/remove('active')`。

**Tech Stack:** 原生 CSS（无 preprocessor）、admin-theme.css 已定义 CSS 变量（`--admin-*`）、HTML `[hidden]` 属性 + `:not([hidden]) { display: flex }` 模式控制 modal 显示（参考 admin-theme.css 现有 backup-modal 模式）。

## Global Constraints

- **CSS 类作用域**：所有规则全部限定 `.admin-main .xxx`（admin 端专用，不影响公开端 `/support.html`）
- **CSS 变量**：用 admin-theme.css 已定义的 `--admin-*` 变量；徽章/气泡的渐变色直接用 hex（admin 主题无 badge 渐变变量）
- **modal 模式**：复用 admin-theme.css 的 `backup-modal-backdrop` 模式（`[hidden]` + `:not([hidden]) { display: flex }`），加 `admin-support-` 前缀避免与产品 form modal 冲突
- **缓存绕行**：新 CSS 用 `?v=20260622-1100` 时间戳（参考 `admin-sidebar.css?v=20260621-1625` 模式，绕 7d immutable 缓存）
- **不动的部分**：admin-support.html 现有 JS 逻辑（API 调用、renderTable、filterTickets 等）；sidebar；统计卡片；搜索框；空状态样式（已定义在 pages/admin.css）
- **不引入新依赖**：无 npm 包、无 CDN、无新 CSS 变量
- **不做的范围**：响应式、工单 API、admin 主题变量、创建工单流程

### 颜色规范（直接 hex，不用变量）

| 用途 | 渐变 |
|---|---|
| 蓝（高优先级 / 已回复 / 按钮 view / 管理员气泡） | `linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)` |
| 绿（已解决 / 按钮 resolve） | `linear-gradient(135deg, #10b981 0%, #059669 100%)` |
| 橙（待处理） | `linear-gradient(135deg, #f59e0b 0%, #d97706 100%)` |
| 红（紧急） | `linear-gradient(135deg, #ef4444 0%, #dc2626 100%)` |
| 灰（低 / 已关闭） | `linear-gradient(135deg, #94a3b8 0%, #64748b 100%)` |
| 用户气泡 | `linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)` |

---

## File Structure

### 新建文件
- `public/css/pages/admin-support.css` — admin-support 专属样式（表格/徽章/按钮/气泡/详情行/表单）
- `public/css/admin-support-modal.css` — modal-backdrop 样式

### 修改文件
- `public/admin-support.html` — 加 2 个 link、3 处 modal markup、2 处 JS

### 任务边界
- Task A1 创建 2 个 CSS 文件（一个 subagent 写完）
- Task A2 修改 HTML 引用 + markup + JS（一个 subagent 改）
- Task A3 浏览器手测验证（一个 subagent 跑）

---

### Task A1: 创建 2 个 CSS 文件

**Files:**
- Create: `public/css/pages/admin-support.css`
- Create: `public/css/admin-support-modal.css`

**Interfaces:**
- Consumes: 无（纯 CSS 样式）
- Produces: 2 个新 CSS 文件，被 `admin-support.html` 引用（Task A2 加 link）

- [ ] **Step 1: 创建 `public/css/pages/admin-support.css`**

新建文件，完整内容：

```css
/* ============================================
   Admin Support Page Styles
   工单表格 + 徽章 + 按钮 + 回复气泡 + 详情行
   全部限定 .admin-main 避免影响公开端
   ============================================ */

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
.admin-main .tickets-table thead {
  background: linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(139,92,246,0.04) 100%);
}
.admin-main .tickets-table th {
  padding: 14px 16px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--admin-text-primary);
}
.admin-main .tickets-table td {
  padding: 14px 16px;
  border-top: 1px solid var(--admin-border-light);
  font-size: 14px;
  color: var(--admin-text-primary);
}
.admin-main .tickets-table tbody tr {
  transition: background 0.15s ease;
}
.admin-main .tickets-table tbody tr:hover {
  background: var(--admin-bg-hover);
}
.admin-main .tickets-table tbody tr:nth-child(even) {
  background: rgba(0,0,0,0.015);
}
.admin-main .tickets-table tbody tr:nth-child(even):hover {
  background: var(--admin-bg-hover);
}

/* 徽章（pill 圆角 + 渐变 + 白字） */
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
.admin-main .priority-badge.high {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
}
.admin-main .priority-badge.normal {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
}
.admin-main .priority-badge.low {
  background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%);
}
.admin-main .status-badge.open {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
}
.admin-main .status-badge.replied {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
}
.admin-main .status-badge.resolved {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
}
.admin-main .status-badge.closed {
  background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%);
}

/* 按钮 */
.admin-main .btn-view {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(59,130,246,0.3);
  transition: all 0.2s ease;
}
.admin-main .btn-view:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(59,130,246,0.4);
}
.admin-main .btn-resolve {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  color: white;
  border: none;
  border-radius: 10px;
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(16,185,129,0.3);
  transition: all 0.2s ease;
}
.admin-main .btn-resolve:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 14px rgba(16,185,129,0.4);
}

/* 详情字段 */
.admin-main .ticket-detail-item {
  display: flex;
  align-items: flex-start;
  padding: 10px 0;
  border-bottom: 1px solid var(--admin-border-light);
  font-size: 14px;
}
.admin-main .ticket-detail-item:last-child {
  border-bottom: none;
}
.admin-main .ticket-detail-item .label {
  min-width: 100px;
  color: var(--admin-text-muted);
  font-weight: 500;
}

/* 回复区 */
.admin-main .replies-section {
  margin-top: 24px;
}
.admin-main .replies-section h4 {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--admin-text-primary);
}
.admin-main .reply-item {
  display: flex;
  margin-bottom: 12px;
}
.admin-main .reply-item.user {
  justify-content: flex-start;
}
.admin-main .reply-item.admin {
  justify-content: flex-end;
}
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
.admin-main .reply-form {
  margin-top: 24px;
}
.admin-main .reply-form h4 {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--admin-text-primary);
}
.admin-main .reply-form textarea {
  width: 100%;
  min-height: 100px;
  padding: 12px 14px;
  border: 1px solid var(--admin-border);
  border-radius: 10px;
  font-size: 14px;
  font-family: inherit;
  resize: vertical;
  transition: all 0.2s ease;
}
.admin-main .reply-form textarea:focus {
  outline: none;
  border-color: var(--admin-primary);
  box-shadow: 0 0 0 3px rgba(9,105,218,0.12);
}
.admin-main .reply-form-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
}
```

- [ ] **Step 2: 创建 `public/css/admin-support-modal.css`**

新建文件，完整内容：

```css
/* ============================================
   Admin Support Modal Styles
   复用 admin-theme.css 的 [hidden] + :not([hidden]) 模式
   加 admin-support- 前缀避免与产品 form modal 冲突
   ============================================ */

.admin-support-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  align-items: flex-start;
  justify-content: center;
  z-index: 2000;
  padding: 24px;
  overflow-y: auto;
}
.admin-support-modal-backdrop:not([hidden]) {
  display: flex;
}
.admin-support-modal {
  background: var(--admin-bg-card);
  border-radius: 16px;
  width: 90%;
  max-width: 800px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  position: relative;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding: 32px;
}
.admin-support-modal h3 {
  margin: 0 0 20px;
  font-size: 17px;
  font-weight: 600;
  color: var(--admin-text-primary);
}
.admin-support-modal-close {
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
  color: var(--admin-text-muted);
  transition: all 0.2s ease;
  line-height: 1;
  padding: 0;
}
.admin-support-modal-close:hover {
  background: rgba(0,0,0,0.1);
  color: var(--admin-text-primary);
}
```

- [ ] **Step 3: 文件存在性验证**

```bash
ls "H:/MywebServer/wwwsite (2)/public/css/pages/admin-support.css" "H:/MywebServer/wwwsite (2)/public/css/admin-support-modal.css"
```

Expected: 2 行路径输出，文件存在。

- [ ] **Step 4: 暂不 commit（项目无 git，下个任务完成后一起验证）**

---

### Task A2: 修改 `admin-support.html`

**Files:**
- Modify: `public/admin-support.html`（加 2 个 link、3 处 modal markup、2 处 JS）

**Interfaces:**
- Consumes: Task A1 创建的 2 个 CSS 文件
- Produces: admin-support 页面引用新 CSS；detail-modal 用新 class；showDetail/closeModal 改用 `hidden` 属性

- [ ] **Step 1: 在 `<head>` 加 2 个 link 引用**

**位置**：在 `public/admin-support.html` 第 12 行（`<link rel="stylesheet" href="/css/admin-sidebar.css?v=20260621-1625">`）之后插入：

```html
  <link rel="stylesheet" href="/css/pages/admin-support.css?v=20260622-1100">
  <link rel="stylesheet" href="/css/admin-support-modal.css?v=20260622-1100">
```

注意：缩进用 2 空格，与现有 link 一致。

- [ ] **Step 2: 改 detail-modal 容器 markup（3 处变化）**

**位置**：第 78-84 行。

**改前**：
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
1. 外层：`class="modal"` → `class="admin-support-modal-backdrop"`，加 `hidden` 属性
2. 内层：`class="modal-content"` → `class="admin-support-modal"`，加 `onclick="event.stopPropagation()"`
3. 关闭按钮：`class="modal-close"` → `class="admin-support-modal-close"`

- [ ] **Step 3: 改 showDetail JS（1 处）**

**位置**：第 283 行附近，在 `showDetail` 函数末尾。

**改前**：
```js
      document.getElementById('detail-modal').classList.add('active');
```

**改后**：
```js
      document.getElementById('detail-modal').hidden = false;
```

- [ ] **Step 4: 改 closeModal JS（1 处）**

**位置**：第 286-288 行。

**改前**：
```js
    function closeModal() {
      document.getElementById('detail-modal').classList.remove('active');
    }
```

**改后**：
```js
    function closeModal() {
      document.getElementById('detail-modal').hidden = true;
    }
```

- [ ] **Step 5: 验证改动**

启动 `npm start`（如果还没启动；用 background 模式避免 zombie 进程，参考项目 memory `feedback_zombie_node_processes.md`）。

打开 `http://localhost:15000/admin-support`（手动验证）：
- 页面正常加载，无 JS 错误
- console 无 404
- 工单表格显示圆角卡片 + 斑马纹 + hover 高亮
- 徽章显示 pill 渐变 + 白字
- "查看"按钮显示蓝渐变

点击"查看"按钮（手动验证）：
- 详情 modal 弹出，居中、圆角、阴影
- 字段行左 label 右 value
- 关闭按钮（×）在右上角

点击关闭（手动验证）：
- 点 × → 关闭
- 点 modal 内部 → 不关闭
- 点 modal 外的灰色 backdrop → 关闭

**如果发现视觉/交互异常，停下检查对应步骤。**

- [ ] **Step 6: 暂不 commit（项目无 git，浏览器手测在 Task A3 统一跑）**

---

### Task A3: 浏览器手测验证

**Files:** 无

**Interfaces:** 验证所有 user-facing 流程

- [ ] **Step 1: 表格样式验证**

打开 `http://localhost:15000/admin-support`（手动验证）：
- 表格外层有圆角阴影（卡片化）
- 表头有渐变背景（淡蓝紫）
- 偶数行有浅灰底（斑马纹）
- hover 行有 hover 高亮
- 单元格 padding 适中、不挤

- [ ] **Step 2: 徽章样式验证**

- 优先级徽章：紧急 = 红渐变 + 白字；普通 = 蓝渐变；低 = 灰渐变
- 状态徽章：待处理 = 橙渐变；已回复 = 蓝渐变；已解决 = 绿渐变；已关闭 = 灰渐变
- 所有徽章：pill 圆角（border-radius 12px）+ 轻微阴影

- [ ] **Step 3: 按钮样式验证**

- 表格行"查看"按钮：蓝渐变 + 白字 + 圆角 + 阴影，hover 上移
- 详情 modal"发送回复"按钮：绿渐变 + 白字 + 更大（padding 10px 20px），hover 上移

- [ ] **Step 4: 详情 modal 验证**

点击任一工单"查看"（手动验证）：
- modal 弹出：居中、圆角（16px）、白底、深阴影
- 宽度约 800px（max-width），居中显示
- 顶部有"工单详情 - #XX"标题
- 字段行：左 label（灰）+ 右 value
- 关闭按钮（×）在右上角，圆形 + 浅灰底，hover 加深

点击关闭（手动验证 3 种方式）：
- 点 × → 关闭
- 点 modal 内容 → 不关闭
- 点 modal 外的灰色 backdrop → 关闭

- [ ] **Step 5: 回复气泡验证**

在 modal 内"添加回复"输入框输入文字，发送（手动验证）：
- 发送后 modal 关闭，列表刷新
- 再次打开同一工单 → 回复区显示气泡
- 用户的回复（`reply.adminName` 为空）：左对齐 + 灰底气泡 + 圆角左下角小（4px）
- 管理员的回复（`reply.adminName` 有值）：右对齐 + 蓝渐变气泡 + 圆角右下角小 + 白字

如果当前没有管理员回复历史，验证：
- 气泡样式本身正确（手动改 `tickets` mock 数据测试或用已有工单）

- [ ] **Step 6: 兼容性验证**

- 打开 `http://localhost:15000/support`（公开端工单页）→ 视觉无变化（CSS 限定 `.admin-main`，不影响公开端）
- 打开 `http://localhost:15000/admin-product`（其他 admin 页）→ 视觉无变化
- 切换主题（在 settings 改 siteTheme）→ admin-support 跟随主题

- [ ] **Step 7: console 检查**

按 F12 打开 console（手动验证）：
- 任何页面（包括 admin-support、support 公开端、其他 admin 页）都无 JS 错误
- Network 标签：admin-support 加载看到 `admin-support.css` 和 `admin-support-modal.css` 都 200

**如果任意一步失败，停下修对应任务（Task A1 或 Task A2）。**

---

## Self-Review（写完后过一遍）

**1. Spec coverage**：
- §1 现状与根因 → Task A1 的 CSS 文件覆盖全部 9 个 class ✓
- §2 架构（2 个新文件）→ Task A1 创建 2 个文件 ✓
- §3 视觉规范（表格/徽章/按钮/详情/bubble/表单/modal）→ Task A1 CSS 完整实现 ✓
- §4 markup 微调（3 处）+ JS 微调（2 处）→ Task A2 ✓
- §5 详细 CSS 内容 → Task A1 直接采用 spec §5.1 和 §5.2 的代码 ✓
- §6 验证清单 → Task A3 7 步验证 ✓
- §7 范围外（YAGNI）→ 全部任务都避开了（无响应式、无 API 改动、无主题修改）✓
- §8 风险（CSS 限定、markup 微调、theme 变量）→ Task A1 用 `.admin-main` 限定 + Task A2 markup 改动量小 + 颜色 hex 不依赖 admin 主题变量（避免变量缺失）✓

**2. Placeholder scan**：
- 无 "TBD" / "TODO" / "实现后补"
- 无 "Add appropriate error handling" 这种空洞步骤
- 每步都有完整代码（CSS 完整、HTML diff 完整、JS diff 完整）
- 文件路径都是绝对路径

**3. Type consistency**：
- CSS 类名：spec §5.1 用的 `.priority-badge` / `.status-badge` / `.btn-view` / `.btn-resolve` / `.ticket-detail-item` / `.replies-section` / `.reply-item` / `.reply-header` / `.reply-content` / `.reply-form` / `.reply-form-actions` / `.tickets-table` ↔ HTML 第 80-282 行使用的 class 一致 ✓
- modal class：spec §5.2 用的 `admin-support-modal-backdrop` / `admin-support-modal` / `admin-support-modal-close` ↔ Task A2 markup 改动一致 ✓
- JS 改动：showDetail 改 `hidden = false` ↔ closeModal 改 `hidden = true` 一致 ✓
- 颜色 hex：spec §5.0 表 ↔ Task A1 CSS 实际值完全一致 ✓

**无 placeholder、无矛盾。可执行。**
