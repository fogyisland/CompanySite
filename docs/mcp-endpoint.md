# MCP 端点（/mcp）使用说明

**用途**：让 AI 工具（Claude Code / Claude Desktop / 自研 Agent）通过 MCP 协议直接创建、修改、发布本站的「动态」（`news` 表）文章与「产品 / 产品文档」（`products` / `product_docs` 表）。

**传输**：MCP Streamable HTTP
**路径**：`POST /mcp`
**鉴权**：`Authorization: Bearer <令牌>`
**内容对象**：
- 动态 / 新闻（`news` 表），对应前台 `/news.html` 的「博铭动态」栏目
- 产品与产品文档（`products` / `product_docs` 表），对应前台 `/product-list.html`、`/product.html`

> ⚠️ **产品的上架只能人工做**。AI 建出来的产品一律是草稿，前台看不到 —— 详见 [§3.4](#34-产品一律是草稿上架必须人工)。

---

## 1. 令牌从哪来

有两类凭据，都能通过 `/mcp`：

| 类型 | 在哪配 | 作用域 | 吊销方式 | 适用场景 |
|------|--------|--------|----------|----------|
| **后台令牌** | 后台「系统设置 → MCP」申请 | 按需（动态族 / 产品族 × 读 / 写，共四个作用域） | 后台点「吊销」，立即生效 | **日常给 AI 工具用** |
| **主令牌** | 后台「MCP设置 → 主令牌」生成/轮换（存在数据库 `settings.mcp_config`） | 全部权限 | 后台点「轮换」，**立即生效** | 运维逃生口 |

**推荐做法**：在后台申请一枚带作用域的令牌给每个 AI 工具用；主令牌只在你自己的机器上留一份，万一后台令牌全被吊光了还能恢复访问。

主令牌与后台令牌的两个关键差别：

- 主令牌**明文存放**（后台要能随时复制出来交给工具），后台令牌只存 sha256 摘要，明文只在签发那一刻出现一次；
- 主令牌在后台点「轮换」后**立刻作废旧令牌**（鉴权每次请求都现读配置，不缓存），需要重新分发到各个客户端。

环境变量 `MCP_TOKEN` 只作为**存量兼容回退**保留：只有当后台还没生成主令牌时才生效，优先级低于后台生成的那份。

后台页面的入口：登录后台 → 左侧「系统设置 → MCP」（`/admin-mcp`）。

---

## 2. 快速接入

### 2.1 先申请一枚令牌

后台「MCP设置 → 申请令牌」：

1. 填「令牌用途（名称）」，例如 `Claude Code（我的电脑）`
2. 勾权限范围：
   - **读取动态** → `news:read` → `list_news` / `get_news`
   - **写入动态** → `news:write` → `create_news` / `update_news` / `publish_news` / `unpublish_news`
   - **读取产品** → `product:read` → `list_products` / `get_product` / `list_product_docs` / `get_product_doc`
   - **写入产品** → `product:write` → `create_product` / `update_product` / `create_product_doc` / `publish_product_doc` / `unpublish_product_doc`
   - 勾「写入」会自动包含**同族**的「读取」；两族之间互不蕴含（`news:write` 不含 `product:read`）
3. 选有效期（默认 90 天；可选 30 / 90 / 180 / 365 天，或「永不过期」）
4. 点「申请令牌」→ **明文只显示这一次**，立刻复制走

> 明文在服务器里只存 sha256 摘要，刷新页面就再也看不到了。丢了只能吊销重发。

### 2.2 Claude Code（命令行）

```bash
claude mcp add --transport http booming-site https://www.booming.one/mcp \
  --header "Authorization: Bearer <你申请的令牌>"
```

### 2.3 Claude Desktop / 任何 MCP 客户端

```json
{
  "mcpServers": {
    "booming-site": {
      "type": "http",
      "url": "https://www.booming.one/mcp",
      "headers": {
        "Authorization": "Bearer <你申请的令牌>"
      }
    }
  }
}
```

### 2.4 curl 验证

```bash
# 令牌来源二选一：
#   a) 后台「系统设置 → MCP」复制一枚带作用域的令牌（推荐）
#   b) 后台「主令牌」区域的「复制」（运维逃生口）
curl -X POST https://www.booming.one/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## 3. 工具清单

| 工具 | 作用域 | 作用 | 关键参数 |
|------|--------|------|---------|
| `list_news` | `news:read` | 列出动态（含草稿与已发布），支持分类/状态筛选、分页 | `category` / `status` / `page` / `pageSize` |
| `get_news` | `news:read` | 读单条动态详情（含正文 HTML） | `id` 或 `slug` |
| `create_news` | `news:write` | 新建动态，状态为**草稿** | `title` `slug` `content_html` 必填 |
| `update_news` | `news:write` | 更新已有动态，只传要改的字段 | 定位：`id` 或 `current_slug` |
| `publish_news` | `news:write` | 发布（草稿 → 已发布），首次发布记录发布时间 | 定位：`id` 或 `current_slug` |
| `unpublish_news` | `news:write` | 撤稿（已发布 → 草稿），前台立即不再显示 | 定位：`id` 或 `current_slug` |

**没有 `delete_news`** —— 删除不可逆，且不在「发布文章」的诉求范围内。需要删除请走后台 `DELETE /api/admin/news/:id`。

**产品族工具（`products` / `product_docs`）**

| 工具 | 作用域 | 作用 | 关键参数 |
|------|--------|------|---------|
| `list_products` | `product:read` | 列出产品目录（含草稿），支持搜索/分类/上架状态筛选、分页 | `search` / `category` / `status` / `page` / `pageSize` |
| `get_product` | `product:read` | 读单个产品详情 | 定位：`id` 或 `short_name` |
| `list_product_docs` | `product:read` | 列出某个产品下的全部文档（含草稿） | 定位：`product_id` 或 `product_short_name` |
| `get_product_doc` | `product:read` | 读单篇产品文档正文（含 HTML） | 定位：`doc_id`，或 `product_short_name` + `doc_slug` |
| `create_product` | `product:write` | 新建产品，状态恒为**草稿** | `name` `short_name` 必填 |
| `update_product` | `product:write` | 更新产品，只传要改的字段（**无 `status` 参数**） | 定位：`id` 或 `short_name` |
| `create_product_doc` | `product:write` | 在某产品下新建文档，状态为**草稿** | `title` `slug` `content_html` 必填 |
| `publish_product_doc` | `product:write` | 发布文档（草稿 → 已发布） | 定位：`doc_id`，或 `product_short_name` + `doc_slug` |
| `unpublish_product_doc` | `product:write` | 撤稿文档（已发布 → 草稿） | 定位：`doc_id`，或 `product_short_name` + `doc_slug` |

**没有 `publish_product` / `unpublish_product`** —— 产品的上架 / 下架**必须人工在后台点**，MCP 侧不提供这两个工具（详见 [§3.4](#34-产品一律是草稿上架必须人工)）。

**没有 `delete_product` / `delete_product_doc`** —— 删除不可逆，请走后台的删除接口。

### 3.1 作用域是「按工具注册」，不是「调用后报错」

只读令牌的 `tools/list` **只会返回该族的读工具**（动态 2 个、产品 4 个），写工具根本不会出现在列表里 —— AI 客户端不会去尝试调用它，也就无从触发越权。

对比：如果是「调用后才拒绝」，客户端仍会看到完整工具清单并反复尝试，徒增噪音与日志量。

隐含规则（**同族内**）：

| 持有 | 隐含获得 |
|------|---------|
| `news:write` | `news:read` |
| `product:write` | `product:read` |

能写的人自然能读自己刚写的东西，否则 AI 写完却读不回来。

**两族之间互不蕴含**：`news:write` **不含** `product:read`，`product:write` **不含** `news:read`。想同时用两族，就得在后台勾上四个作用域。

### 3.2 分类取值

**动态**（`news.category`，varchar(50)）：后台可选值 `产品更新` / `公司新闻` / `安全公告`。

**产品**（`products.category`，varchar(255)）：自由文本。有一个**写死的特殊值** —— `开源产品`：分类恰为该值时，产品被判定为开源类型，**至少要有一个仓库地址**，且价格 / 价格方案 / 下载地址 / 外链一律清零（强制免费）。

`is_course`（课程型）、`is_shared_code`（共享代码）同样是「强制免费」类型，且**两者互斥**，同时开启会被拒绝。

### 3.3 动态的发布流程

```
create_news  →  状态 draft（前台不可见）
      ↓
  （AI 或人工确认内容无误）
      ↓
publish_news  →  状态 published（前台可见，记录 published_at）
      ↓
unpublish_news → 状态 draft（撤稿，published_at 保留）
```

### 3.4 产品一律是草稿，上架必须人工

```
AI 建产品 → status=0（草稿，前台不显示）
                    ↓
        人工在后台改价 + 点上架
                    ↓
             status=1（前台可见）
```

**价格：AI 建草稿时填 0 占位即可。上架权：只有人能点。**

原因：产品的价格、方案档位、下载地址这些字段直接决定对外售卖，MCP 的调用方是外部 AI 工具 —— 把「定价 + 公开」这两步交给 AI，等于让一个第三方账号直接决定商城卖什么、卖多少钱。因此 MCP 侧**刻意不提供** `publish_product` / `unpublish_product` 工具：

- 工具列表里**不存在** → AI 不会尝试，也不存在「调用后被拒绝」的半吊子状态；
- `update_product` 的入参 schema 里**没有 `status` 字段** → 传不进来；
- `db.updateProduct` 的 SET 列表里**不含 `status` 列** → 即使绕过 schema 直接发参数也写不进去。

三道锁，缺一不可。

**产品文档的发布是可以由 AI 做的**（`publish_product_doc` / `unpublish_product_doc`），但文档发布 ≠ 产品可见：

| 层级 | AI 能否操作 | 说明 |
|------|------------|------|
| 产品文档 `product_docs.status` | ✅ `publish_product_doc` / `unpublish_product_doc` | 文档自身的发布状态 |
| 产品 `products.status` | ❌ 无工具 | 必须人工在后台点「上架」 |

前台查文档时带 `AND p.status = 1`（`db.getPublishedProductDoc`），所以**产品没上架，文档即使已发布也看不到**。这条约束在数据层保证，不依赖调用方自觉。

**后台操作入口**：后台 → 「产品管理」（`/admin-product`）列表新增「状态」列，显示 `已上架` / `草稿` 徽标，旁边是「上架」/「下架」按钮。

对应后台接口（都带 `requireAuth`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/admin/products` | 产品列表，**含草稿**。`status` 参数：`published` → 1 / `draft` → 0 / 不传 → 不过滤 |
| `GET` | `/api/admin/products/:id` | 产品详情，**草稿也能取**（用于后台编辑） |
| `POST` | `/api/admin/products/:id/publish` | 上架（`status=1`） |
| `POST` | `/api/admin/products/:id/unpublish` | 下架（`status=0`） |

两个开关接口在状态已经一致时返回 400（`该产品已经是上架状态` / `该产品已经是下架状态`），产品不存在时返回 404。成功时写操作日志 `PRODUCT_PUBLISH` / `PRODUCT_UNPUBLISH`，操作者为当前管理员。

> **数据库**：复用 `products.status` 这一列（`tinyint(1) NOT NULL DEFAULT 1`），**无需新增列、无需迁移**。这一列此前是「死列」—— 所有代码都忽略它，因此改成草稿/上架开关是向后兼容的。
> 已存在的产品默认 `status=1`（默认值），也就是**存量产品全部视为已上架**，前台展示不受影响。

### 3.5 草稿产品的下单闸门

草稿 = 前台不可见，**也 = 不可下单**。`products.status` 不只是一个显示开关，它同时是下单的准入条件。

下单接口 `POST /api/orders` 直接按 `productId` 取产品，不经过前台列表的过滤，所以必须自己判状态：

| 环节 | 位置 | 行为 |
|------|------|------|
| 服务端校验 | `lib/order-policy.js` 的 `isProductOrderable()` | `status !== 'published'` → 返回 `PRODUCT_NOT_AVAILABLE`，整批拒绝（不产生半截订单） |
| 前台加购 | `public/js/main.js` `addProductToCart()` / `public/product.html` | `GET /api/products/:id` 对草稿返回 404，前端先判 `response.ok` 再入购物车 |
| 前台结算 | `public/checkout.html` `loadCheckout()` | 下单失败的项**留在购物车**并显示失败原因，不静默丢弃、不清空整个购物车 |

错误码 `PRODUCT_NOT_AVAILABLE` 在结算页翻成「产品已下架，暂时无法购买」。

> `lib/order-policy.js` 是下单项校验的**唯一事实来源** —— `server.js` 与三个 verify 脚本都从它取实现，不再各写一份内联副本（B-2 那轮踩过「内联副本和被测代码静默漂移」的坑：副本漏掉这道闸，测试全绿而草稿产品仍能下单）。

---

## 4. 字段约束

### 4.0 动态（news）

| 字段 | 类型 | 约束 |
|------|------|------|
| `title` | string | 必填，≤ 255 字符 |
| `slug` | string | 必填，≤ 255 字符，**只允许小写字母、数字、连字符**（`^[a-z0-9-]+$`） |
| `content_html` | string | 必填，≤ 100000 字符，纯正文 HTML |
| `excerpt` | string | 选填，≤ 2000 字符；传空字符串表示清空 |
| `cover_image` | string | 选填，≤ 500 字符；站内相对路径（`/uploads/...`）或 `https://` 绝对地址；传空字符串表示清除封面 |
| `category` | string | 选填，≤ 50 字符；传空字符串表示清空 |
| `is_pinned` | boolean | 选填，默认 `false` |
| `sort_order` | int | 选填，默认 `0` |

### 4.1 `cover_image` 白名单（MCP 侧比后台更严）

后台表单对 `cover_image` 只做长度检查；MCP 侧额外施加白名单，因为该字段最终会被拼进 CSS `url()`，一旦含 `)` `,` `;` 等字符就可能被利用叠加出额外样式或外链请求。

**允许的形态**：

- 站内相对路径：`/uploads/doc-images/2026/cover.png`
- https 绝对地址：`https://cdn.example.com/cover.jpg?v=20260101`

**允许的字符**：`A-Za-z0-9._~:/?#@!$&*+=%-`

**被拒绝的形态与对应错误码**：

| 错误码 | 触发条件 |
|--------|---------|
| `COVER_IMAGE_CHARS` | 含白名单外的字符（空格、逗号、分号、括号、引号、反斜杠等） |
| `COVER_IMAGE_SCHEME` | 协议不是 `https`（如 `http:` / `javascript:` / `data:`） |
| `COVER_IMAGE_PROTOCOL_RELATIVE` | 以 `//` 开头（协议相对地址） |
| `COVER_IMAGE_TRAVERSAL` | 含 `..` 路径片段 |
| `COVER_IMAGE_HOST` | https 地址缺少合法主机名 |
| `COVER_IMAGE_TOO_LONG` | 超过 500 字符 |

### 4.2 `content_html` 输入闸门

MCP 侧对正文做一道**粗粒度输入闸门**（命中即拒绝，不静默改写）：

| 错误码 | 触发条件 |
|--------|---------|
| `CONTENT_REQUIRED` | 未提供 |
| `CONTENT_TYPE` | 不是字符串 |
| `CONTENT_EMPTY` | 空串或纯空白 |
| `CONTENT_TOO_LONG` | 超过 100000 字符 |
| `CONTENT_UNSAFE` | 含 `<script>` / `<iframe>` / `<style>` / `<svg>` / `on*` 事件属性 / `javascript:` 协议 等 |

> ⚠️ **这道闸门不是 HTML 净化器**。它按黑名单拦截明显越界的内容，无法覆盖实体编码、畸形标签等所有变形形态。
> 前台渲染端 `public/news.html` 的 DOMPurify 才是最终防线 —— 不要因为正文通过了闸门就认为它一定安全。
> 若将来要在此层做真正的净化，需要引入与浏览器同源的 HTML5 解析器（parse5 之类），避免解析器差异导致的 mXSS。

### 4.3 局部更新不会误伤存量数据

`update_news` 只校验**本次显式传入**的字段。历史遗留的脏 `cover_image` 不会阻塞「只想改标题」这类操作 —— 但一旦显式写入脏值，仍会被拒绝。

### 4.4 产品字段约束

**创建（`create_product`）**

| 字段 | 必填 | 约束 |
|------|------|------|
| `name` | ✅ | ≤ 255 字符 |
| `short_name` | ✅ | ≤ 100 字符；**只允许**字母、数字、点、下划线、连字符（`^[A-Za-z0-9._-]+$`，保留大小写）；唯一键 |
| `category` | — | ≤ 255 字符；特殊值 `开源产品` 触发免费规则 |
| `price` | — | 有限非负数字；免费类型强制为 0 |
| `pricing_tiers` | — | 最多 12 档；每档 `{ label, duration, price }`，`duration` 为 1~120 的整数（月），`label` ≤ 50 字符；免费类型强制清空 |
| `description` | — | 纯文本 |
| `version` | — | ≤ 100 字符；缺省 `1.0.0` |
| `platform` | — | ≤ 100 字符；缺省 `Windows` |
| `features` | — | 字符串数组，最多 50 条，每条 ≤ 200 字符 |
| `icon` | — | ≤ 500 字符；缺省 `software` |
| `featured` | — | 布尔，缺省 `false` |
| `download_url` | — | ≤ 500 字符；免费类型强制清空 |
| `external_link` | — | 布尔；免费类型强制 `false` |
| `is_course` | — | 布尔；与 `is_shared_code` **互斥** |
| `is_shared_code` | — | 布尔；与 `is_course` **互斥** |
| `repo_urls` | — | 最多 10 个，每个 ≤ 500 字符，只接受 `http(s)://` 地址；`开源产品` / 共享代码**必填** |

**产品文档（`create_product_doc`）**

| 字段 | 必填 | 约束 |
|------|------|------|
| `title` | ✅ | ≤ 255 字符 |
| `slug` | ✅ | ≤ 255 字符；**只允许**小写字母、数字、连字符（`^[a-z0-9-]+$`） |
| `content_html` | ✅ | ≤ 100000 字符；走与动态正文同一套输入闸门（见 §4.2） |
| `excerpt` | — | ≤ 500 字符 |
| `sort_order` | — | 整数，缺省 0 |

**局部更新（`update_product`）**：只校验显式传入的字段，其余原样保留。传入 `features` / `pricing_tiers` / `repo_urls` 是**整体替换**语义（不是追加）；传空数组表示清空。

### 4.5 产品类型矩阵（REST 与 MCP 同源）

REST 的 `POST /api/products` 与 MCP 的 `create_product` / `update_product` 共用 `lib/product-policy.js` 的 `resolveProductType()` —— **一份实现，不会漂移**。规则：

1. `is_course` 与 `is_shared_code` 不能同时启用 → `PRODUCT_TYPE_CONFLICT`
2. `category === '开源产品'` 或 `is_shared_code` 为真时，至少要有一个仓库地址 → `PRODUCT_REPO_REQUIRED`
3. 免费产品（课程型 / 共享代码 / 开源产品）：`price=0`、`pricing_tiers=null`、`download_url=''`、`external_link=false`

> REST 的 `PUT /api/products/:id` 是**局部更新**语义，矩阵与 POST 不同（课程型在 PUT 里不清零 `downloadUrl`），因此**没有**接入本模块 —— 两者是有意保持的行为差异，不是漏接。

错误码一览（产品族）：

| 错误码 | 触发条件 |
|--------|---------|
| `PRODUCT_NAME_REQUIRED` / `PRODUCT_NAME_TOO_LONG` | 名称为空 / 超长 |
| `PRODUCT_SHORT_NAME_REQUIRED` / `PRODUCT_SHORT_NAME_FORMAT` / `PRODUCT_SHORT_NAME_TOO_LONG` | 短名缺失 / 含非法字符 / 超长 |
| `PRODUCT_CATEGORY_TOO_LONG` | 分类超长 |
| `PRODUCT_VERSION_TOO_LONG` / `PRODUCT_PLATFORM_TOO_LONG` / `PRODUCT_ICON_TOO_LONG` / `PRODUCT_DOWNLOAD_URL_TOO_LONG` | 对应字段超长 |
| `PRODUCT_PRICE_INVALID` / `PRODUCT_PRICE_NEGATIVE` | 价格不是数字 / 为负 |
| `PRODUCT_TIERS_TYPE` / `PRODUCT_TIERS_TOO_MANY` / `PRODUCT_TIER_TYPE` / `PRODUCT_TIER_LABEL_REQUIRED` / `PRODUCT_TIER_LABEL_TOO_LONG` / `PRODUCT_TIER_DURATION_INVALID` | 价格方案结构非法 |
| `PRODUCT_FEATURES_TYPE` / `PRODUCT_FEATURES_TOO_MANY` / `PRODUCT_FEATURE_TOO_LONG` | 功能特点结构非法 |
| `PRODUCT_TYPE_CONFLICT` | 课程型与共享代码同时启用 |
| `PRODUCT_REPO_REQUIRED` | 开源 / 共享代码缺仓库地址 |
| `PRODUCT_REPO_TOO_MANY` / `PRODUCT_REPO_URL_TOO_LONG` / `PRODUCT_REPO_TYPE` | 仓库地址数量 / 长度 / 类型非法 |
| `PRODUCT_DESCRIPTION_TYPE` | 描述不是字符串 |
| `PRODUCT_DOC_EXCERPT_TOO_LONG` | 文档摘要超长 |
| （数据库 `ER_DUP_ENTRY`） | 短名或 slug 重复 → 「执行失败：短名（short_name）或 slug 已存在，请换一个」 |

---

## 5. 错误处理

工具失败时返回 MCP 的 `isError: true` 结果（不是 JSON-RPC 异常），正文是可直接执行的中文提示：

```
参数校验未通过（COVER_IMAGE_SCHEME）：封面图地址只允许 https:// 协议，当前是 javascript://。
站内图片请用相对路径（以 / 开头，例如 /uploads/doc-images/cover.png）
```

AI 读到后可直接据此改写参数重试，不必中断整轮对话。

其他错误：

| 场景 | 表现 |
|------|------|
| 令牌缺失 | HTTP 401 + `WWW-Authenticate: Bearer` |
| 令牌无效 | HTTP 401（`Bearer 令牌无效`） |
| 令牌已被吊销 | HTTP 401（`Bearer 令牌已被吊销`） |
| 令牌已过期 | HTTP 401（`Bearer 令牌已过期`） |
| 后台把 MCP 关了 | HTTP 503（`MCP 端点已在后台关闭`） |
| 没配主令牌且后台没签发任何有效令牌 | HTTP 503（`MCP 端点未启用：…`） |
| Host 不在白名单 | HTTP 403（SDK 的 DNS 重绑定防护） |
| slug 重复 | `执行失败：slug 已存在，请换一个 slug` |
| 短名 / slug 重复 | `执行失败：短名（short_name）或 slug 已存在，请换一个` |
| 数据库连不上 | `执行失败：数据库连接失败，请稍后重试` |

**401 与 503 的分工**：401 是客户端的问题（自己配错了），503 是服务端的问题（端点没开）。不要把「端点被关掉」伪装成 401 —— 客户端拿到 401 会去反复检查自己的配置，拿到 503 才会直接停下报错。

**判定顺序：先判「端点启用了没」，再判「令牌对不对」**。
端点完全没启用（既没有主令牌，后台也没有签发过任何有效令牌）时，
**任何请求都回 503，带不带令牌都一样** —— 此时根本不存在「正确的令牌」，
回 401 会让客户端以为自己漏带了令牌，然后拿着一个根本不存在的令牌反复重试。

> 这个判定需要查库（数一下后台有没有签发过有效令牌），而 `/mcp` 挂在 API 限流
> 中间件**之前**，每来一个未鉴权请求就查一次库等于开了个「用请求放大数据库负载」
> 的口子。因此判定结果有 **1 秒的进程内缓存**（`lib/mcp/auth.js` 的
> `NO_CREDENTIAL_CACHE_MS`）—— 客户端感知的延迟上限就是 1 秒，
> 而「刚在后台签发的令牌立刻可用」不受影响。
> 查库本身失败时按 fail-closed 处理：回 503（`MCP 鉴权服务暂时不可用`）。

---

## 6. 后台管理

页面：`/admin-mcp`（后台 → 系统设置 → MCP）。

### 6.1 MCP 设置

| 项 | 说明 |
|----|------|
| 启用 MCP 端点 | 关掉后 `/mcp` 一律返回 503。**立即生效，不用重启** |
| Host 白名单 | 每行一个主机名，最多 20 条。**只写主机名，不要带端口或协议**（写 `www.booming.one`，不是 `https://www.booming.one:443`） |

Host 白名单留空 = 不启用 DNS 重绑定防护（默认）。原因：nginx 转发时 Host 头的具体形态取决于服务器配置，猜错白名单会把正常客户端全部挡在门外。

配置存在数据库 `settings.mcp_config` 字段（JSON），**每个 MCP 请求都会重新读一次** —— 不缓存，就没有「改了设置还得等一会儿才生效」的窗口。

### 6.2 令牌生命周期

```
申请令牌  →  明文返回一次（立刻复制）
     ↓
客户端使用  →  每次调用更新 last_used_at（5 分钟节流）
     ↓
吊销  →  revoked_at 置位，下一次请求立刻 401
```

- **吊销只影响这一枚令牌**，其它客户端不受影响。
- 已过期 / 已吊销的令牌不会被物理删除，列表里仍可见（状态标为「已过期」/「已吊销」），保留审计痕迹。
- 吊销是**不可逆**的。需要重新给权限只能签发新令牌。

### 6.3 后台 API

供后台页面调用，也可脚本化（都带 `requireAuth`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/admin/mcp/config` | 读设置 + 令牌统计 + 主令牌掩码（`masked` / `source` / `rotatedAt`） |
| `PUT` | `/api/admin/mcp/config` | 保存设置（`enabled` 布尔、`allowedHosts` 字符串数组） |
| `GET` | `/api/admin/mcp/master-token` | 读主令牌状态；**带明文**（供后台「复制」按钮用） |
| `POST` | `/api/admin/mcp/master-token` | 生成 / 轮换主令牌；已存在时需带 `{ "confirm": true }` |
| `GET` | `/api/admin/mcp/tokens` | 令牌列表（**永远不含 token_hash**） |
| `POST` | `/api/admin/mcp/tokens` | 签发令牌，201 返回 `{ token, record }` |
| `POST` | `/api/admin/mcp/tokens/:id/revoke` | 吊销，需带 `{ "confirm": "REVOKE_TOKEN" }` |

`confirm: "REVOKE_TOKEN"` 是二次确认护栏，与后台 `/api/security/config` 的 `MODIFY_WHITELIST` 同一套做法：防止被劫持的 admin 会话「一键吊销全部令牌」。

主令牌的轮换用 `confirm: true`（布尔，不是字符串口令）：`POST /api/admin/mcp/master-token` 在主令牌已存在而 `body.confirm !== true` 时返回 **409 `MCP_MASTER_TOKEN_CONFIRM_REQUIRED`**，必须显式确认「旧令牌立刻作废」才肯轮换。首次生成时不带 `confirm` 即可。

轮换是**立即生效**的：鉴权每次请求都现读 `settings.mcp_config`，没有缓存窗口。旧令牌在轮换完成的瞬间就失效，所有客户端必须同步更新。

> 主令牌与后台令牌的存储策略**故意不同**：后台令牌只存 sha256 摘要（明文只在签发那一刻出现一次）；主令牌存明文，因为它是「随时能复制出来」的运维逃生口，需要在后台一键取回。明文落库的取舍是知情决策 —— 库被拿到 = 主令牌被拿到，这本来就是明文主令牌的固有风险。

---

## 7. 审计与安全

- **所有写操作都写操作日志**（`writeOperationLog`），与后台表单同一份审计流：
  - 动态族：`NEWS_CREATE` / `NEWS_UPDATE` / `NEWS_PUBLISH` / `NEWS_UNPUBLISH`，操作者标记为 `mcp`。
  - 产品族：`PRODUCT_CREATE` / `PRODUCT_UPDATE` / `PRODUCT_DOC_CREATE` / `PRODUCT_DOC_PUBLISH` / `PRODUCT_DOC_UNPUBLISH`，操作者标记为 `mcp`。
  - 人工上架：`PRODUCT_PUBLISH` / `PRODUCT_UNPUBLISH`，操作者为当前管理员（后台页面触发）。
- **令牌相关操作也写操作日志**：`MCP_CONFIG_UPDATE` / `MCP_TOKEN_CREATE` / `MCP_TOKEN_REVOKE` / `MCP_MASTER_TOKEN_CREATE` / `MCP_MASTER_TOKEN_ROTATE`，操作者为当前管理员。
- **后台令牌的明文只出现一次**：签发接口返回一次，之后任何接口都拿不回明文（库里只有 sha256）。
- **主令牌的明文可随时取回**（存 `settings.mcp_config`），仅管理员可见（`requireAuth`）。取回动作本身记入操作日志。
- **哈希用 sha256 而非 bcrypt**：令牌本身是 32 字节全随机，没有字典可撞；慢哈希只会拖慢每次 MCP 请求的鉴权。
- **比较用 `crypto.timingSafeEqual`**：避免逐字节短路的时序侧信道。
- **无状态模式**：服务器不分配 `Mcp-Session-Id`，每个请求独立处理，重启即忘，无会话泄漏。
- **CSRF 中间件**：服务器对 `POST`/`PUT`/`DELETE` 检查 `Origin` 头。AI 工具通常不发 `Origin`，不受影响；**浏览器端**的 MCP 客户端若跨源访问会被 403。

---

## 8. 部署要点

### 8.1 环境变量

> ⚠️ **`.env` 现在是 Init 向导的产物**，仓库里只留 `.env.example`。
> 向导生成的 `.env` **不包含** `MCP_TOKEN`（主令牌改由后台生成/轮换，存在数据库里）。
> Init 令牌机制已整体移除，`.env` 里也不再有 `INIT_TOKEN`。
> 详见 [README · Init 向导](README.md#init-向导首次部署用)。

```bash
# .env.example（仅模板，不会被自动读取）
# MCP_TOKEN 不再是主令牌的来源，只作为存量兼容回退：
#   后台还没生成主令牌时，它才生效；后台生成之后，以后台那份为准。

# Host 白名单默认值（可选）；后台保存过设置后，以后台为准
MCP_ALLOWED_HOSTS=www.booming.one
```

若运维确实要用环境变量当主令牌（不推荐 —— 无法在后台复制、无法轮换）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ **`MCP_TOKEN` 是选填的，且是二等公民**。
> 旧版本里它是启动前置条件 —— 缺失时服务器 `process.exit(1)` 拒绝启动。
> 现在改成：**缺失只打印警告，服务器照常启动**；此时 `/mcp` 只接受后台签发的令牌，
> 若后台也一张有效令牌都没有，端点返回 503（fail-closed）。
>
> 为什么不保留 `process.exit(1)`：那样的话管理员在后台申请第一枚令牌之前，
> 就必须先手工编辑 `.env` —— 而这恰恰是本功能要消除的步骤（死锁）。
> 被保护的是**端点**，不是**进程**：「没有有效凭据就访问不了 /mcp」这个不变量完全成立。

### 8.2 数据库

新表 `mcp_tokens` + `settings` 新列 `mcp_config`。正常情况下服务器启动时 `db.js:createTablesIfNotExist()` 会自动建好；若想显式执行：

```bash
node prisma/migrations/2026-10-30-add-mcp-tokens.js
```

脚本是幂等的（列用 `INFORMATION_SCHEMA` 守卫，表用 `CREATE TABLE IF NOT EXISTS`）。

### 8.3 nginx

需要单独的 `location ^~ /mcp` 段（示例见 `docs/nginx-www.booming.one.conf`），要点：

- `proxy_buffering off;` —— GET /mcp 是 SSE 长连接，不关缓冲客户端收不到增量事件
- `add_header Cache-Control "no-store" always;` —— MCP 响应动态生成，禁止缓存
- `proxy_hide_header Cache-Control;` —— 避免兜底段的 `no-cache` 覆盖上游的 `no-store`

改完执行 `nginx -s reload`。

### 8.4 客户端 body 大小

MCP 路由自带 **2mb** body parser（全局 `express.json()` 是 100kb，装不下一篇完整文章）。
nginx 侧 `client_max_body_size 20M` 已足够，无需调整。

---

## 9. 自测（人工清单）

> 原先的 `verify-*.mjs` 自动化验证脚本已按项目清理要求删除（2026-10-30，未纳入 git）。
> 下面的清单保留完整覆盖点，改动相关代码后按此逐条手工回归。

**通用（MCP 协议层）**

- [ ] 鉴权：有效主令牌可调用；无凭据 / 错误凭据被拒；`MCP_TOKEN` 缺失时启动只警告不崩
- [ ] 协议握手：`initialize` 正常返回，`tools/list` 返回已注册工具
- [ ] 工具注册：动态族 6 个 / 产品族 9 个，作用域门控正确（`product:read` 只暴露 4 个读工具，`product:write` 暴露 9 个且隐含 `product:read`）
- [ ] 后台令牌鉴权：有效 / 已吊销 / 已过期 / 未知四种情形分别处理
- [ ] 端点关闭返回 503；无凭据返回 503；Host 白名单生效
- [ ] 端点**完全没启用**时（无主令牌 + 后台没签发过有效令牌）：无凭据与错误凭据**都**返回 503（不是 401）
- [ ] 配置读取失败时回退到默认值
- [ ] 长度上限、大正文、存量数据容错

**主令牌（后台生成 / 轮换 / 复制）**

- [ ] 后台「主令牌」区域首次点「生成主令牌」→ 得到明文，可复制；`GET /api/admin/mcp/config` 的 `masterToken.configured` 变为 `true`
- [ ] 「显示明文」按一次显示、再按一次隐藏；页面刷新后默认掩码
- [ ] 已存在主令牌时轮换**不带** `confirm` → 409 `MCP_MASTER_TOKEN_CONFIRM_REQUIRED`，旧令牌仍有效
- [ ] 带 `confirm: true` 轮换 → 旧令牌立刻 401，新令牌可调用；`rotatedAt` 变化
- [ ] `PUT /api/admin/mcp/config` 改别的设置后，主令牌**不被清空**（掩码还在）
- [ ] 操作日志出现 `MCP_MASTER_TOKEN_CREATE` / `MCP_MASTER_TOKEN_ROTATE`

**动态族**

- [ ] 增删改查发布全流程
- [ ] `cover_image` 严格策略；`content_html` 闸门
- [ ] REST 语义零漂移（错误文案逐字一致）

**产品族**

- [ ] **AI 无法上架**：`tools/list` 里不存在 `publish_product` / `unpublish_product`，直接调用被拒；`update_product` 的入参 schema 里没有 `status` 属性
- [ ] 两族互不蕴含：`news:read` 看不到产品工具，`product:read` 看不到动态工具，跨族调用不写入
- [ ] AI 建产品 → 草稿 → 局部更新保留未传字段；缺 `short_name` 被拒；类型冲突 / 缺仓库地址被拒；开源免费化
- [ ] 产品文档：创建（草稿）→ 发布 → 撤稿；按 `(product_short_name, doc_slug)` 定位
- [ ] 产品类型矩阵：REST `POST /api/products` 的错误文案与免费化行为**逐字零漂移**
- [ ] **草稿闸门**：AI 建的产品下单被拒（`PRODUCT_NOT_AVAILABLE`）→ 人工上架后可下单 → 再下架又拒绝；`isProductOrderable()` 只认 `published`

**前台（草稿 / 上架链路，手工回归）**

涉及文件：`public/js/main.js`（首页）、`public/product.html`（详情页）、`public/checkout.html`（结算页）。

- [ ] 已下架产品点「加入购物车」→ 提示下架，购物车保持为空（首页 / 详情页两条路径，含多方案按钮）
- [ ] 已上架产品正常入购物车，价格与档位取自服务端返回
- [ ] 结算时部分失败 → 失败项**留在购物车**、页面显示失败原因（「产品已下架，暂时无法购买」+「这些商品仍保留在购物车中，可移除后重新结算。」），成功项才被移除
- [ ] 结算时网络异常 → 项留在购物车，提示「网络错误，请稍后重试」
- [ ] 失败项的商品名（来自 localStorage，可被改写）在渲染前被转义
- [ ] 空购物车进入结算页 → 提示「购物车为空」，不下单

---

## 10. 相关文件

| 文件 | 作用 |
|------|------|
| `lib/content-policy.js` | **唯一事实来源**：动态族的校验原语（REST 与 MCP 共用） |
| `lib/product-policy.js` | 产品族策略：类型矩阵 + 字段校验（`resolveProductType()` 是 REST 与 MCP 的**共用实现**） |
| `lib/order-policy.js` | **唯一事实来源**：下单项校验与价格正本（含草稿闸门 `isProductOrderable()`），`server.js` 复用同一实现 |
| `lib/mcp/server.js` | MCP 路由（配置解析、Host 白名单、鉴权、body 上限、无状态传输生命周期） |
| `lib/mcp/auth.js` | 两类凭据的鉴权（主令牌 + 后台令牌） |
| `lib/mcp/tokens.js` | 令牌原语（生成、sha256、作用域归一化与判定，含 `product:read` / `product:write`） |
| `lib/mcp/tools.js` | 动态族六个工具的定义与实现（含按作用域门控注册） |
| `lib/mcp/product-tools.js` | 产品族九个工具的定义与实现（含按作用域门控注册；**无上架工具**） |
| `public/admin-mcp.html` | 后台「MCP 设置及 Tokens 申请」页面（四个作用域勾选项 + **主令牌生成 / 轮换 / 复制**） |
| `public/admin-product.html` | 后台产品管理列表（新增「状态」列与上架 / 下架按钮） |
| `server.js:903-911` | `/mcp` 挂载点与运行时配置解析 |
| `server.js:815-829` | `MCP_TOKEN` 启动检查（缺失只警告，提示去后台生成主令牌） |
| `server.js:2642-2694` | 前台 `GET /api/products` / `GET /api/products/:id` / `GET /api/products/:slug/docs`（**只返回已上架**） |
| `server.js:2978-3066` | 后台产品列表 / 详情 / 上架 / 下架接口 |
| `server.js:1689-1740` | `POST /api/orders`（下单项校验调用 `lib/order-policy.js`） |
| `server.js:4086-4099` | `resolveAdminMasterToken()` —— 主令牌取值（数据库优先于环境变量） |
| `server.js:4118-4310` | 后台 MCP 设置 API（`GET`/`PUT /api/admin/mcp/config`） |
| `server.js:4172-4246` | 主令牌 API（`GET`/`POST /api/admin/mcp/master-token`，含轮换二次确认） |
| `server.js:4314-4420` | 后台令牌 API（列表 / 签发 / 吊销） |
| `prisma/migrations/2026-10-30-add-mcp-tokens.js` | 建表 / 加列脚本（幂等） |
| `docs/nginx-www.booming.one.conf` | nginx 配置（含 `location ^~ /mcp`） |
