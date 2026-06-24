# 全量代码审计报告 — 2026-06-24

**审计范围**: 8a9e607..11ba0d3(launch 清理 + ECONNRESET 修复)
**审计目标**: HEAD 11ba0d3 完整代码库(不止 diff)
**审计员**: Opus (general-purpose subagent)
**审计时间**: 2026-06-24 16:xx

---

## 结论

**Ready for production?** **NO,必须先修 C1(`.env` 生产密钥磁盘泄露)**

整体工程化水平较高(密钥 fail-closed、签名校验、限流分层、MySQL keepAlive、SQL 参数化、CSRF Origin、BCrypt cost 12、multer 清理、备份密钥脱敏都已规范化),但 **(1) `.env` 含明文生产密钥/DB 密码暴露在磁盘**、**(2) main.js + cart.js 的 innerHTML 模板拼接 admin 可控字段 = XSS** 是 production-blocking。其余 SQL 注入 / 限流 / 备份都已规范。

---

## Strengths(亮点)

1. **密钥 fail-closed**(`server.js:688-705`)— `SESSION_SECRET` / `CRON_TOKEN` 启动时校验非占位值
2. **SQL 注入整体良好** — `db.js` 几乎所有 SQL 都用 `?` 占位符,仅 1 处拼接走白名单
3. **公开端点限流**(`/api/install` `/api/telemetry` `/api/news/:id/view` `/api/products`)— 30/分钟/IP
4. **PayPal Webhook 签名验证**(`server.js:429-464`)— 信任 PayPal 域名 + RSA 验签 + 条件 UPDATE 幂等
5. **MySQL 池 keepAlive** — 主 `mysqlPool` + session 池都已启用
6. **BCrypt cost 12**(`db.js:7`)
7. **CSRF Origin 全局校验**(`server.js:732-745`)
8. **mysqldump 密钥脱敏**(`server.js:43-70`)— `--defaults-file` + mode 0600 + 立即 unlink
9. **激活码邮箱一致性强制校验**(`server.js:1921`)— 三者任一缺失即拒
10. **Cron 端点 token 校验**(`server.js:1724-1732`)— `X-CRON_TOKEN` 头,无配置 fail-closed
11. **新闻草稿/发布隔离**(`server.js:2250-2253`)— 公开详情强制 `status === 'published'`
12. **multer 上传清理**(`server.js:3082-3083`)— restore 后清理 uploaded temp
13. **多密码 hash 函数兼容**(`password_md5` 旧用户升级路径)

---

## Critical(必须修)

### C1. `.env` 包含真实生产密钥,泄露在磁盘上

**位置**: `H:\MywebServer\wwwsite (2)\.env`

文件存在且包含:
- `SESSION_SECRET=<生产 HMAC 密钥>`(已 redact,本报告不存储明文)
- `CRON_TOKEN=<Cron 端点密钥>`(已 redact)
- `DB_HOST=<生产 MySQL IP>`、`DB_USER=<生产 user>`、`DB_PASSWORD=<生产密码>`、`DB_NAME=<生产 db>`(已 redact)

**问题**: `.gitignore` 第 12-13 行声明忽略,`git ls-files | grep ^.env` 确认未追踪 — 但**文件物理存在于工作树**。任何能访问该机器的进程/用户/备份都能直接读到生产密钥和数据库密码。一旦备份/磁盘快照/IDE 临时文件外泄,密钥即失守。

> 注:发现 .env 含明文生产密钥后,本报告**主动 redact**所有密钥值,避免本 markdown 文件本身成为泄露源。完整密钥值仅在原始审计对话中可见,不会持久化。

**修复**:
1. 立即在生产服务器上轮换 `SESSION_SECRET`、`CRON_TOKEN`、`DB_PASSWORD`
2. 强制从 `.env` 中删除明文密钥(`server.js` 已 fail-closed 校验,缺则拒启动,真正的修复是清理磁盘痕迹)
3. 确认 `BACKUP_DIR`/快照/`/tmp` 没有副本

### C2. `public/js/main.js` 多处 `innerHTML` 模板直接拼接未转义 admin 可控数据

**位置**: `H:\MywebServer\wwwsite (2)\public/js/main.js`

- **第 64-75 行 `renderBanners`**:`banner.title`、`banner.description`、`banner.image` 直接拼入 `innerHTML`。`banner.image` 来自 admin(`admin-banners.html`)上传 URL,劫持 admin 可注入 `javascript:alert(1)` 或 `<svg onload=...>`。
- **第 92-155 行 `renderProducts`**:`product.name`、`product.description`、`product.version`、`product.platform` 全部直接拼入,这些字段在 admin-product form 中可被任意 admin 编辑。
- **第 99 行**:`onclick="showPrice(this, '${tier.label}', ${tier.price}, ${index})"` — `tier.label` 完全未转义注入 onclick 字符串,触发**属性级 XSS**(可逃逸单引号注入 `');alert(1)//`)。
- **第 100 行**:`<span class="duration-price">¥${tier.price}</span>` — `tier.price` 来自 JSON.parse 的 `pricing_tiers` 字段,未校验类型。

**问题**: 任何被劫持的 admin 账户可在首页/产品列表页对所有访客执行 XSS,窃取 cookie(包括 `isAdmin` session)、植入 CSRF 链。

**修复**:
1. 改用 DOM API 构造(createElement + textContent + setAttribute)
2. `tier.label` 必须用 `escapeAttr`;最稳妥是用 addEventListener 而非 inline onclick
3. 短期止血:用现有 `escapeHtml` 工具函数包每个 `product.*` 字段
4. 长期:加 CSP 头限制 inline script

### C3. `public/js/cart.js` `innerHTML` 拼接购物车数据

**位置**: `H:\MywebServer\wwwsite (2)\public/js/cart.js`

- **第 144-160 行**:`cart.map(item => ... ${item.name} ... ${item.icon} ... ${item.duration} ... ${item.price} ...)` 全部直接拼入
- **第 154-158 行**:inline onclick `updateQuantity(${item.productId}, ${item.tierIndex}, -1)` — `item.productId` 来自 localStorage,用户可任意篡改;若改成 `1);alert(1)//` 即 XSS

**问题**: 客户端 cart 完全在攻击者控制下,可在 modal 中执行 JS。

**修复**:
1. `item.name`、`item.duration` 用 `textContent`,价格用 `Number()` 强转
2. inline onclick 改为事件委托 + `data-*` 属性

---

## Important(应该修)

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| I1 | `server.js:4180` | 拼接表名进入 SQL(白名单,实际安全) | 用 `mysql2` 的 `??` identifier escape |
| I2 | `server.js:1579, 1702` | `order.user_id` snake_case vs `getOrder()` 返回的 camelCase 混用 | 加注释或抽 `mapOrderRow()` |
| I3 | `db.js:384-395` | `verifyLogin` destructure password 模式脆弱 | 改白名单显式 return |
| I4 | `server.js:2200` | `/api/products/:id` 缺 `parseInt` 校验 | 统一加 `Number.isInteger` 校验 |
| I5 | `server.js:3564` | `sendOrderPaidEmail` baseUrl 硬编码 `localhost:3000` | 用 `${req.protocol}://${req.get('host')}` |
| I6 | `server.js:4052-4093, 4110-4128` | `db-target-info/verify` 每表 createConnection | 一次连接,循环复用 |
| I7 | `db.js:1830` | `getOrderById` 返回 null 不报错 | 抽 `requireOrder()` helper |
| I8 | `server.js:2398-2403` | 删除 detailPage 文件无路径校验(可越 `public/`) | 加 `path.resolve` 白名单 |
| I9 | `server.js:2721-2722` | `docImageUpload` 路径解析脆弱 | 用 `path.posix` 显式构造 |
| I10 | `db.js:1198` | `createActivation` 用 `Math.random()` 生成激活码(应 `crypto.randomBytes`) | 改 crypto |
| I11 | `db.js:1056-1078` | `duration` 字段累加语义模糊 | 加 schema 注释或改 server 端独占 |
| I12 | `server.js:2785-2799` | `data/emails/` 无清理机制 | 加 cron 清理 7+ 天 |
| I13 | `server.js:1541-1591` | `approve-payment` 顺序非原子(可能部分激活) | 包到事务 |
| I14 | `server.js:4758` | `startServer()` 缺 `EADDRINUSE` 错误处理 | 加 `server.on('error', exit)` |
| I15 | `db.js:1937-1963` | `findOrderByActivationCode` N+1 + 全表扫描 | 改用 `order_item_codes.code` 唯一索引 |
| I16 | `server.js:2123-2141` | `/api/heartbeat` NAT 场景全局 429 | 文档化或按 deviceId 限流 |
| I17 | `server.js:2002-2054` | `getAllActivations` 触发 3000+ query | 一次性 JOIN,Node 端 group |
| I18 | `server.js:3310-3323` | `/api/security/api-unblock` IP 格式未校验 | 加 IP regex |
| I19 | `server.js:4255-4258` | `db-switch` 切换后 session 池未重连 | 切后重置 sessionPool |
| I20 | `db.js:1522` | `addSupportTicketReply` JSON 数组累加 | 拆 `support_ticket_replies` 表 |
| I21 | `db.js:1429-1453` | 多个函数未导出保留(dead code 嫌疑) | grep 调用点确认 |
| I22 | `server.js:4334-4342` | `/api/db-migrate` 是 stub 返回成功 | 删端点或返回 501 |
| I23 | `server.js:1410-1411` | `randomPart` 定义后未用(死代码) | 删 |
| I24 | `server.js:1842-1845` | 错误响应泄露 `error.message`(可能泄露 MySQL 细节) | 改 `'服务器错误'` + 仅 log |
| I25 | `server.js:4255-4258` | (已列 I19) | |

---

## Minor(锦上添花)

- **M1**: `loginAttempts` / `blockedIPs` / `apiRateLimitMap` Map 无大小上限(内存泄漏风险)
- **M2**: `getAllSubscribers` / `updateSubscriber` 等 dead code 嫌疑
- **M3**: `/api/db-migrate` stub(见 I22)
- **M4**: `randomPart` 死代码(见 I23)
- **M5**: `newUser` 命名误导(实际是 `insertId` 数字)
- **M6**: 错误响应泄露内部错误(见 I24)
- **M7**: `createOrderItemCode` insertId 模式,跨订单无去重保护
- **M8**: 银行转账老路径 `orders.activation_codes` 与 `order_item_codes` 表无关联
- **M9**: `/admin-user-software-status` 页面路由无权限校验(依赖 API 端)
- **M10**: 工单回复 JSON 数组(见 I20)
- **M11**: `verificationCode` 5 位数字(实际安全,无收益)
- **M12**: `getProductsPaginated` search 长度未限
- **M13**: `db-switch` 后 session pool 状态(见 I19)
- **M14**: `package.json` 缺版本锁定(假定 vendor 已处理)
- **M15**: admin HTML 内联 JS + CSRF token 缺失(未深入审,留待下一轮)

---

## Recommendations(跨切面)

1. **添加 CSP 头** — `Content-Security-Policy: default-src 'self'; img-src 'self' data: https://booming.one; script-src 'self'; style-src 'self' 'unsafe-inline'`(admin 主题需 unsafe-inline)。**能消解 C2/C3 的 XSS 影响**,即使注入也无法执行
2. **统一日志框架** — 4 套日志混用(login_logs / operation_logs / file / email_logs),审计困难。建议 winston/pino + request-id
3. **加 OpenTelemetry / prom-client** — 当前 `unhandledRejection` 仅 console.error,生产监控盲区
4. **拆分 monolith** — `server.js` 4758 行。建议按业务域拆 `routes/auth.js`、`routes/products.js`、`routes/orders.js`、`routes/admin.js`
5. **DB 迁移流程** — `prisma/diff.js` 已存在,但 `createTablesIfNotExist` 仍同步 CREATE TABLE,关系需澄清
6. **Secrets rotation runbook** — 用 secret manager(AWS SSM / Vault)或至少 chmod 600(Windows: icacls)
7. **integration tests** — 当前无任何 test,关键路径只能手测。建议 supertest + jest
8. **WebSocket / SSE for admin live updates** — admin 后台轮询 stats / telemetry 是性能瓶颈

---

## 行动建议

**最低限度 production-ready 修复**:
1. **C1 密钥轮换** + 文档化(密钥不进磁盘)
2. **C2/C3 XSS 修复** — 短期用 `escapeHtml` 包字段;长期上 CSP 头
3. **I14 事务化** approve-payment(防止部分激活)
4. **I18 startServer EADDRINUSE**(防止端口冲突 hang)

**已在本会话修复**:
- 11ba0d3: ECONNRESET 修复(express-mysql-session keepAlive)

---

**未深入审计**:
- `prisma/diff.js` / `scripts/update-vendor.js` / 25 个 admin HTML / `news.html` / `product-list.html` / `admin-product-form.html`
- 建议下一轮专门审 admin HTML 的内联 JS / CSRF token 缺失 / XSS 残留
