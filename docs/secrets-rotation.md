# 密钥轮换 Runbook

**适用版本**: Booming Tech 2026-06-24 之后
**触发场景**: 怀疑密钥泄露 / 定期轮换（推荐 90 天） / 员工离职 / 审计要求

---

## 概述

> ⚠️ **`.env` 现在是安装向导的产物**，仓库里只留 `.env.example`（模板）。
> 首次部署时由 `/setup` 向导生成 `.env`（权限 0600），里面的 `SESSION_SECRET` /
> `CRON_TOKEN` 是**机器随机生成**的；`DB_*` 是你在向导里填的。
> 后续也可以在后台「系统设置 → 数据库」里改 —— 那条路径写的是同一个 `.env`。
> 详见 [README · 安装向导](README.md#安装向导首次部署用)。

服务器依赖以下密钥（详见 `.env.example`）：

| 变量 | 用途 | 启动校验 |
|------|------|---------|
| `SESSION_SECRET` | express-session HMAC 签名（cookie 防篡改） | **占位值 → `process.exit(1)`**；**缺失 → 不退出**，用本次启动的临时随机密钥（重启后失效）并打印警告 |
| `CRON_TOKEN` | `/api/cron/*` 端点鉴权（`X-CRON_TOKEN` 头） | 同 SESSION_SECRET |
| `MCP_TOKEN` | `/mcp` 主令牌的**存量兼容回退**（`Authorization: Bearer` 头） | **可选**：缺失只打印警告，服务器照常启动；优先级低于后台生成的主令牌 |
| `MCP_ALLOWED_HOSTS` | `/mcp` 的 Host 白名单（DNS 重绑定防护），逗号分隔 | 可选，留空则不启用该校验（后台保存后以后台为准） |
| `PAYPAL_WEBHOOK_ID` | PayPal webhook 签名验证 | 缺失时支付回调被拒 |
| `DB_PASSWORD` | MySQL 连接密码 | 缺失时连库失败 |

`server.js:769-773` 维护一份已知占位密钥黑名单，命中即拒启动。这意味着只要密钥轮换后写入 `.env`，旧值就再也不会被使用。

### 为什么「缺失」不再拒启动

`.env` 缺失有两种完全不同的含义，必须分开处理：

- **占位值**（如 `change-me-in-production`）—— 公开可猜，任何人都能伪造会话 Cookie，**必须** fail-closed 拒启动；
- **完全没有值** —— 全新部署还没跑过向导，或部署坏了还没修。此时 `process.exit(1)` 会让 `/setup` 一起消失，初始化界面就失去了意义（和「数据库连不上就退出」是同一类错误）。所以改用**进程内临时随机密钥**顶住，等向导把正式密钥写进 `.env`。

分界是「有没有值」而不是「`.env` 在不在」：docker 部署常用环境变量注入密钥、不落 `.env`，那属于「配好了」，不该被拦。

### 走后台保存时密钥不会被顺手作废

向导第 2 步 / 后台「系统设置 → 数据库」保存连接参数时，`.env` 里的 `SESSION_SECRET` 与 `CRON_TOKEN` **沿用旧值**，没有才现生成。

原因：修一个「配置坏了」的部署，不该顺手作废所有已登录的会话，也不该让外部 cron 调用方集体 401。

**推论**：轮换这两个密钥必须**手工改 `.env`**（或用专门接口），后台保存连接参数**不是**轮换手段。

---

## 1. 日常保护（不轮换，只是降低风险）

1. **限制文件系统权限**（Windows）：
   ```powershell
   icacls ".env" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
   # 仅当前用户可读写，管理员和其他账户无访问
   ```
2. **不在 Git 仓库** — `.gitignore` 第 12 行已忽略 `.env` 和 `.env.*`，验证：
   ```bash
   git ls-files .env
   # 应输出为空
   ```
3. **不在编辑器/IDE 临时文件中** — 关闭 IDE 的"自动保存 .env 到项目根"功能
4. **不在备份中明文** — 见第 4 节
5. **`.env.bak` 同样含明文密钥** —— 向导 / 后台每次改数据库配置都会把旧 `.env` 备份成 `.env.bak`。
   它是**上一版**密钥的副本，权限同样要收紧；确认新配置跑通之后可以删掉：
   ```bash
   rm .env.bak
   ```
   注意：`.env.bak` 里可能是**旧**的 `SESSION_SECRET`，但会话池已经用新值了 ——
   留着的唯一价值是「改错了能退回去」，跑通后它就是纯风险。

   **「保存连接参数」不等于「轮换密钥」**：向导与后台的保存动作只重写受管的 8 个键，
   `SESSION_SECRET` / `CRON_TOKEN` 沿用旧值；其余原有键整行原样保留到 `Preserved` 段。
   想轮换密钥，手工改 `.env`（见 2.1 / 2.2）。

6. **别把密钥写进会话日志 / 错误信息** —— 主令牌的明文只出现在两个地方：
   后台「主令牌」卡片（管理员可见）与 `POST /api/admin/mcp/master-token` 的响应体。
   这两个接口都带 `requireAuth`，操作同时写进操作日志。

---

## 2. 紧急轮换（怀疑已泄露）

### 2.1 SESSION_SECRET

**影响范围**：所有现有 session 立即失效（用户需重新登录），生产环境约 100-500 用户同时掉线。
**预计停机**：无（滚动重启即可）。

```bash
# 1. 生成新密钥
NEW_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
echo "新 SESSION_SECRET: $NEW_SECRET"

# 2. 在服务器上编辑 .env
#    注意：后台「系统设置 → 数据库」的保存按钮**不会**改这个键 ——
#    它沿用 .env 里的旧值，免得顺手作废所有会话。轮换必须手工改。
ssh user@booming.one
vi .env  # 替换 SESSION_SECRET=<NEW_SECRET>

# 3. 滚动重启（PM2 / systemd / 手动）
pm2 reload booming  # 或 systemctl reload booming

# 4. 验证启动日志无 "FATAL: SESSION_SECRET"
pm2 logs booming --lines 50

# 5. 浏览器开无痕窗口登录 https://www.booming.one/login，确认 session 写入正常
```

**清理旧 session**（可选，但推荐）：
```sql
DELETE FROM sessions WHERE expires < NOW();
-- 或全清（强制所有用户重登）：
DELETE FROM sessions;
```

### 2.2 CRON_TOKEN

**影响范围**：所有 `/api/cron/*` 调用方需要更新 token（通常是外部 cron 服务或运维脚本）。
**预计停机**：cron 任务失败但用户无感知。

```bash
# 1. 生成新 token
NEW_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 2. 更新 .env（后台保存连接参数不会碰这个键，轮换必须手工改）
vi .env  # 替换 CRON_TOKEN=<NEW_TOKEN>

# 3. 同步更新所有 cron 调用方
#    - 外部 cron 服务（如 crontab.io / GitHub Actions secrets）→ 更新 X-CRON_TOKEN 值
#    - 运维脚本里的 curl 调用 → 同步替换
#    - 监控告警系统（如果用 X-CRON_TOKEN 探活）→ 同步替换

# 4. 重启服务器
pm2 reload booming

# 5. 触发一次 cron 任务验证（参考 docs/launch-2026-06-24.md 中 cron 端点列表）
curl -X POST https://www.booming.one/api/cron/expire-activations \
  -H "X-CRON_TOKEN: $NEW_TOKEN" -i
# 期望: 200 OK
```

### 2.3 DB_PASSWORD

**影响范围**：最广 — 所有 MySQL 连接都需更新。
**预计停机**：约 1-5 分钟（MySQL 端轮换 + 服务器滚动重启）。

```bash
# ===== MySQL 端 =====
# 1. 在 MySQL 中创建新用户/密码（不直接改现有用户，避免其他连接断）
ssh mysql-admin@db-host
mysql -u root -p
> CREATE USER 'booming'@'%' IDENTIFIED BY '<NEW_STRONG_PASSWORD>';
> GRANT ALL ON booming.* TO 'booming'@'%';
> FLUSH PRIVILEGES;

# 2. 测试新凭据
mysql -h <DB_HOST> -u booming -p<NEW_STRONG_PASSWORD> booming
> SHOW TABLES;  # 应输出表列表

# 3. (可选) 撤销旧密码 — 等所有服务器切到新密码后再执行
> ALTER USER 'booming'@'%' IDENTIFIED BY '<NEW_STRONG_PASSWORD>';

# ===== 服务器端 =====
# 4. 更新 .env
vi .env  # 替换 DB_PASSWORD=<NEW_STRONG_PASSWORD>

# 5. 滚动重启
pm2 reload booming

# 6. 验证启动日志
pm2 logs booming --lines 50
# 应看到 "MySQL pool initialized" 且无 "ECONNREFUSED"
```

**方式二（推荐）：后台「系统设置 → 数据库」保存**

后台保存走的是**同一个 `.env`**（`lib/env-config-service.js` 是唯一落盘入口），
并且**当场切换连接池** —— 不用 SSH 改文件，也不用等重启就能验证新密码通不通。
`SESSION_SECRET` / `CRON_TOKEN` 沿用旧值（不顺手作废会话），其余原有键整行原样保留。

**密码改错了怎么办**：服务器**不会退出进程**，而是降级启动：

- 启动日志出现 `✖ 数据库初始化失败: Access denied for user 'xxx'@'yyy' (using password: YES)`；
- 业务接口统一返回 **503** `{ error: '数据库当前不可用', setupUrl: '/setup' }`；
- `/setup` 照常可用，安装令牌会重新打进控制台（并写回 `data/setup-token.txt`）；
- 在向导第 2 步填回正确凭据 → 保存 → 连接池当场切换 → 站点立即恢复。

> 「数据库不可用」= **连不上** 或 **认证不过**（账号密码错 / 账号对该库没权限）。
> 认证失败必须算在内 —— 否则全新部署（仓库不带 `.env`，进程按默认值连
> `root@localhost` 且不带密码）会卡在向导第 2 步，连 `.env` 都写不出来。
> 判定实现见 `lib/setup-policy.js` 的 `isDbUnavailableError()`。

### 2.4 MCP 凭据

MCP 有**两类**凭据，泄露时的处置方式完全不同，先分清是哪一类：

| 类型 | 特征 | 处置 |
|------|------|------|
| **后台令牌** | `mcp_` 开头，后台「令牌列表」里能看到名字/前缀 | **不需要动服务器**，后台点「吊销」立即生效（见 2.4.2） |
| **主令牌** | 后台「MCP设置 → 主令牌」区域，全权限 | 后台点「轮换主令牌」，**立即生效**，不需要重启（见 2.4.1） |

#### 2.4.1 轮换主令牌

**影响范围**：所有**仍在用主令牌**的 AI 工具（Claude Code / Claude Desktop / 自研 Agent）需要更新 token。
**预计停机**：无；轮换后旧 token **立刻**失效，新客户端会收到 401。

> 日常给 AI 工具用的应该是**后台令牌**（带作用域、可单独吊销），主令牌只当逃生口。
> 如果列表里所有客户端用的都是后台令牌，主令牌轮换的影响面就是零。

**方式一（推荐）：后台页面**

登录后台 → 系统设置 → MCP → 「主令牌」卡片 → 点「轮换主令牌」→ 确认 → 复制新令牌。

**方式二：API**（带 admin 会话）

```bash
# 轮换（必须带 confirm:true，否则 409 MCP_MASTER_TOKEN_CONFIRM_REQUIRED）
curl -X POST https://www.booming.one/api/admin/mcp/master-token \
  -H "Content-Type: application/json" \
  -b "<admin session cookie>" \
  -d '{"confirm":true}'
# 期望: {"success":true,"configured":true,"token":"<新令牌明文>","rotatedAt":"..."}
```

> 首次生成（还没有主令牌）时**不带** `confirm` 即可。
> 轮换带 `confirm:true` 是二次确认护栏：防止被劫持的 admin 会话「一键作废主令牌」，
> 而主令牌作废之后如果后台令牌也已全部吊销，站点就再也调不动 MCP 了。

**方式三：直接改库**（后台不可用时的兜底）

```sql
UPDATE settings
SET mcp_config = JSON_SET(
      COALESCE(mcp_config, '{}'),
      '$.masterToken', '<新令牌明文>',
      '$.masterTokenRotatedAt', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ')
    )
WHERE id = 1;
```

> `settings` 是**单行宽表**（一列一个配置项，主键 `id = 1`），**不是** key-value 表 ——
> 没有 `key` / `value` 两列。写成 `WHERE \`key\` = 'mcp_config'` 会直接报
> `ER_BAD_FIELD_ERROR`（1054），令牌一个字也没改上去。
>
> `COALESCE(mcp_config, '{}')` 不能省：`mcp_config` 原本是 NULL 时，
> `JSON_SET(NULL, ...)` 的结果是 NULL —— UPDATE 会「成功」但把整列写成 NULL，
> 看起来像改好了，实际令牌根本没落库。
>
> `DATE_FORMAT(UTC_TIMESTAMP(), ...)` 产出的是 ISO 8601 字符串，和后台轮换接口
> 写进去的格式一致（后台用 `new Date().toISOString()`）；直接写 `NOW()` 得到的是
> 数据库本地时区时间，两者格式不同但不冲突，只是显示风格不一致。
>
> ⚠️ **`enabled` / `allowedHosts` 会被这次手改"固化"**：一旦 `mcp_config` 这一列
> 变成非 NULL，运行时就不再回退到 `.env` 的 `MCP_ALLOWED_HOSTS`（见
> `server.js` 的 `resolveMcpConfig()`）—— 它只认库里这份的 `allowedHosts`。
> 如果 `.env` 里配过 Host 白名单，手改前先确认库里那份也带上同样的值：
>
> ```sql
> SELECT JSON_EXTRACT(mcp_config, '$.allowedHosts') FROM settings WHERE id = 1;
> ```
>
> 读出来是 `NULL` 或 `[]` 的话，Host 白名单就等于被清空了（`allowedHosts` 为空数组
> 时不校验 Host，等于放开所有来源）。

**同步更新所有 MCP 客户端配置**（各客户端的 mcp server 配置里 `headers.Authorization`）：

- Claude Code：`claude mcp add` 或项目级 `.mcp.json` 里的 headers
- Claude Desktop：`claude_desktop_config.json` 里的 headers
- 自研 Agent：调用方的 Bearer 令牌

**验证**：初始化握手应返回 200

```bash
curl -X POST https://www.booming.one/mcp \
  -H "Authorization: Bearer $NEW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}' \
  -i
# 期望: 200 OK
```

**为什么不需要重启**：MCP 鉴权每次请求都现读 `settings.mcp_config`，没有缓存窗口 ——
轮换完成的瞬间旧令牌就失效了。

**别忘了**：轮换动作会写进操作日志（`MCP_MASTER_TOKEN_ROTATE`），可在后台「系统日志 → 操作日志」核对。

> ⚠️ **主令牌是明文存库的**（后台要能随时复制出来交给工具）。
> 这与 `.env` 里其它明文密钥风险等级一致：库被拿到 = 主令牌被拿到。
> 轮换的价值在于**缩小暴露窗口**，不是「换了就没人知道」。

> 💡 主令牌**不在 `.env` 里**，所以轮换主令牌**不需要改文件、不需要重启**。

#### 2.4.2 吊销后台令牌（无需重启，秒级生效）

令牌泄露时**先做这一件事**，比改 `.env` 快得多，也不影响其它客户端。

**方式一（推荐）：后台页面**

登录后台 → 系统设置 → MCP → 令牌列表 → 找到对应令牌 → 点「吊销」。

**方式二：API**（带 admin 会话）

```bash
curl -X POST https://www.booming.one/api/admin/mcp/tokens/<令牌ID>/revoke \
  -H "Content-Type: application/json" \
  -b "<admin session cookie>" \
  -d '{"confirm":"REVOKE_TOKEN"}'
# 期望: {"success":true}
```

> `confirm: "REVOKE_TOKEN"` 是二次确认护栏，防止被劫持的 admin 会话「一键吊销全部令牌」。

**方式三：直接改库**（后台不可用时的兜底）

```sql
UPDATE mcp_tokens SET revoked_at = NOW() WHERE token_prefix = 'mcp_xxxxxxxx' AND revoked_at IS NULL;
```

**验证已失效**：

```bash
curl -X POST https://www.booming.one/mcp \
  -H "Authorization: Bearer <泄露的令牌明文>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' -i
# 期望: 401 Unauthorized + {"error":"Bearer 令牌已被吊销"}
```

**吊销后**：如果该令牌是唯一还能用的凭据，且后台也没有主令牌，端点会变成 503（fail-closed）—— 这是预期行为，不是故障。此时要么立刻签发新令牌，要么在后台生成一枚主令牌。

**别忘了**：吊销动作会写进操作日志（`MCP_TOKEN_REVOKE`），可在后台「系统日志 → 操作日志」核对。

### 2.5 PAYPAL_WEBHOOK_ID

PayPal Webhook ID 在 PayPal 后台管理，轮换需要：
1. 在 PayPal Dashboard → Webhooks → 创建新 webhook
2. 更新 `.env` 的 `PAYPAL_WEBHOOK_ID`
3. 重启服务器
4. 旧 webhook 在 PayPal 端删除（保留 24-48h 避免漏单）

---

## 3. 定期轮换（90 天节奏）

设置日历提醒，90 天走一遍 2.1-2.5 子集（通常只轮换 `SESSION_SECRET` 和 `CRON_TOKEN`）。DB_PASSWORD 视风险评估决定（半年或一年一次）。

---

## 4. 备份中密钥清理

**问题场景**：mysqldump 备份文件可能包含敏感数据（虽然已通过 `--defaults-file` 隔离 DB 凭据到 mode 0600 文件，但表数据中的 email / phone / password_hash 仍是敏感 PII）。

### 4.1 验证当前备份不含明文密钥

```bash
# 备份文件应不含 SESSION_SECRET / CRON_TOKEN
grep -E "SESSION_SECRET=|CRON_TOKEN=" backups/backup-*.sql
# 期望：无输出

# 验证 mysqldump 用的是 --defaults-file（不在命令行暴露 DB 密码）
grep -c "mysqldump.*-p" server.js
# 期望：0（任何 -p 参数都是 bug）
```

### 4.2 加密备份（推荐）

未来增强：用 `gpg` 加密备份 + 异地存储：

```bash
# 加密
gpg --symmetric --cipher-algo AES256 backups/backup-20260624-120000.sql
# 输出 backup-20260624-120000.sql.gpg，删除明文 .sql
```

（**当前未实施**，列入 backlog。）

### 4.3 检查磁盘快照 / IDE 临时文件

```bash
# Windows: 搜索最近 7 天修改过的所有文件，看是否有 .env 副本
# 排除 node_modules / .git / backups
Get-ChildItem -Path . -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) -and
                 $_.Name -like "*.env*" -or $_.FullName -like "*env*backup*" } |
  Select-Object FullName, LastWriteTime
```

---

## 5. 故障排查

| 症状 | 原因 | 修复 |
|------|------|------|
| 启动报 `FATAL: SESSION_SECRET is a known placeholder value` | 用了 `booming-tech-secret-key-change-in-production` 等占位值 | 替换为真随机密钥（或直接跑 `/setup` 让向导生成） |
| 启动报 `FATAL: CRON_TOKEN is a known placeholder value` | 同上，`CRON_TOKEN` 用了占位值 | 同上 |
| 启动只**警告**「未配置 SESSION_SECRET —— 使用本次启动的临时密钥」 | `.env` 缺失（还没跑过向导）或变量名拼错 | 访问 `/setup` 完成安装，或手工补齐 `.env` |
| 每次重启都要重新登录 | `.env` 里没有 `SESSION_SECRET`，每次启动都生成临时密钥 | 把正式密钥写进 `.env`（向导会自动做） |
| 登录后立即掉线 | SESSION_SECRET 刚轮换，旧 session 全部失效 | 正常现象，用户重登即可 |
| Cron 任务 401 | CRON_TOKEN 刚轮换，外部调用方未更新 | 同步更新所有调用方的 `X-CRON_TOKEN` |
| MCP 客户端 401 | 主令牌刚轮换 / 令牌被吊销 / 令牌过期，客户端未更新 | 同步更新客户端的 `Authorization: Bearer`；或后台吊销对应令牌 |
| MCP 客户端 403 | 请求带了跨源 `Origin` 头，被 CSRF 中间件拦下 | AI 工具通常不发 Origin 头；浏览器端 MCP 客户端需同源访问 |
| MCP 客户端 403（`Invalid Host`） | 后台 Host 白名单里的主机名与实际请求的 Host 不一致 | 后台「系统设置 → MCP」检查白名单；只写主机名，不带端口/协议 |
| MCP 客户端 404 | nginx 未加 `location ^~ /mcp` 段，落到静态资源规则 | 按 `docs/nginx-www.booming.one.conf` 更新 nginx 配置并 reload |
| MCP 客户端 503 | ① 后台把 MCP 关了；② 没有主令牌且后台没有有效令牌 | 后台「系统设置 → MCP」打开开关 / 生成主令牌 / 签发一枚令牌 |
| MCP 客户端 401，但后台显示主令牌已配置 | 后台改过别的设置，把主令牌冲掉了 | `PUT /api/admin/mcp/config` 现在会保留主令牌；重新生成一枚并分发 |
| DB 连接 `ECONNREFUSED` | DB_PASSWORD 轮换时新密码未生效 | 检查 MySQL `FLUSH PRIVILEGES` 是否执行 |
| 启动日志 `✖ 数据库初始化失败: Access denied for user 'xxx'@'yyy'` | 凭据不对（`.env` 缺失时会连 `root@localhost` 且不带密码） | 站点已降级启动、业务接口 503；打开 `/setup` 用控制台打印的新令牌填正确凭据保存 |
| 启动日志 `✖ 数据库初始化失败`，但用的是 `Access denied` 之外的错误 | 账号对该库没权限（`ER_DBACCESS_DENIED_ERROR`） | 补 `GRANT ALL ON <库名>.* TO '<账号>'@'%'`；同样可在 `/setup` 里改配置 |
| 状态显示「数据库已连接，但判定安装状态失败（Unknown column 'is_admin'）」 | 老库的 `users` 表建表时没有 `is_admin` 列 | 启动时的幂等补列会自动加上；确认 `db.js` 的 `userAlterStatements` 里保留了 `ADD COLUMN is_admin` |
| 全新安装卡在「建不出第一个管理员」 | 同上：`is_admin` 缺失 → 状态判定退化成「无法判定」→ 安装写操作一律 403 | 同上；补列后重跑 `/setup` 第 3、4 步 |
| 保存数据库配置后提示要重启 | `.env` 写好了，连接池已当场切换，但 session 存储池在启动时绑定 | 重启一次服务（向导最后一步也会提示） |
| 保存数据库配置失败，`.env` 变回原样 | 新配置连不上库，代码自动回滚了 `.env` 与进程环境变量 | 核对连接参数（库名 / 权限 / 白名单）后重试 |

---

## 6. 关联文件

- `.env.example` — 模板（已 git 追踪）；`.env` 由向导生成，**不在版本库**
- `lib/env-file.js` — `.env` 的唯一读写入口（原子写 + 转义 + 备份 + 回滚）
- `lib/env-config-service.js` — 「数据库配置 → `.env`」落盘服务（向导与后台共用同一条路径）
- `lib/setup-policy.js` — 安装时写哪些键、每条键配什么注释；以及「数据库不可用」的判定（连不上 / 认证不过 / 判定 SQL 跑不通三分）
- `server.js:769-814` — 占位密钥黑名单 + 启动校验（占位 → 拒启动；缺失 → 临时密钥 + 警告）
- `server.js:815-829` — `MCP_TOKEN` 启动检查（缺失只警告）
- `server.js:4086-4099` — `resolveAdminMasterToken()`（数据库优先于环境变量）
- `server.js:4172-4246` — 主令牌 API（生成 / 轮换 / 取回明文）
- `server.js:4314-4420` — 后台令牌 API（列表 / 签发 / 吊销）
- `lib/mcp/auth.js` — MCP 两类凭据的鉴权
- `lib/mcp/tokens.js` — 令牌生成 / 哈希 / 作用域
- `public/admin-mcp.html` — 后台「MCP 设置及 Tokens 申请」页面（含主令牌生成 / 轮换 / 复制）
- `public/admin-dbsettings.html` — 后台「系统设置 → 数据库」页面（写 `.env`）
- `public/setup.html` — 安装向导（生成 `.env`）
- `docs/mcp-endpoint.md` — MCP 端点使用说明（令牌申请、工具清单、客户端接入、错误码）
- `docs/README.md` — 安装向导说明（`.env` 的生成与生效方式）
- `docs/launch-2026-06-24.md` — 上线清单（含密钥轮换项）
- `docs/review-2026-06-24-full-audit.md` — 审计报告 C1 项
