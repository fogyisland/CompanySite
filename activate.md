# 软件注册与激活流程文档

> 适用产品：booming-tech 商城软件体系 · 端口 15000 · MySQL `139.5.108.245`
> 适用版本：v1.0+（2026-06-21 activation-redesign 完成版）
> 文档目的：给运营 / 开发 / 客服 / 软件客户端工程师作为单一参考来源

---

## 1. 体系结构概览

```
┌────────────────────────────────────────────────────────────────────┐
│                          客户端（用户电脑）                          │
│   ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐   │
│   │ 1. 安装软件       │    │ 2. 输入激活码    │    │ 3. 每隔几分钟心跳 │
│   │   POST /install  │    │   POST /activate │    │ POST /heartbeat│   │
│   └────────┬────────┘    └────────┬────────┘    └──────┬───────┘   │
└────────────┼─────────────────────┼─────────────────────┼───────────┘
             │                     │                     │
             ▼                     ▼                     ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Server（Node + Express）                       │
│                                                                    │
│   公开端点:                管理员端点:              Cron 端点:      │
│   POST /api/install        GET /api/activations    /cron/expire    │
│   POST /api/heartbeat      GET /api/admin/uss      /cron/reminder  │
│   POST /api/activate       POST /api/admin/uss/...                 │
│   POST /api/user/register  PUT  /api/activations/:id               │
│   GET  /api/verify-email   DELETE /api/activations/:id             │
│                                                                    │
│   核心表:                                                            │
│   users · orders · order_items · order_item_codes                  │
│   products · user_software_status · activations                    │
│   installations · activation_logs · product_docs                    │
│   device_software_expire （per-MAC 心跳状态，每隔几分钟客户端调用）    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. 关键数据表（与 DB 一致 · 2026-06-21 审计后）

### 2.1 `users`（用户主表 + 管理员标志）

```
id              INT PK AI
username        VARCHAR(255) NOT NULL UNIQUE
password        VARCHAR(255) NOT NULL     -- bcrypt hash, cost=10
email           VARCHAR(255) NULL
phone           VARCHAR(50)  NULL
real_name       VARCHAR(255) NULL         -- 真实姓名
company_name    VARCHAR(255) NULL         -- 公司/组织
is_admin        TINYINT(1)   NOT NULL DEFAULT 0
email_verified  INT          NULL DEFAULT 0
email_verify_token            VARCHAR(128) NULL
email_verify_expires_at       TIMESTAMP    NULL
created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
```

**关键事实**：
- 管理员不存单独表，靠 `is_admin=1` 区分（迁移自旧 `admin` 表）
- 用户名全局唯一，邮箱允许重复（无 UNIQUE 约束）
- 密码一律 bcrypt hash（`$2a$/$2b$/$2y$` 前缀识别是否已 hash）
- 邮箱未验证时 `email_verified=0`，激活流程允许但部分功能受限

### 2.2 `products`（产品定义）

```
id              INT PK AI
name            VARCHAR(255) NOT NULL      -- 展示名（中文）
short_name      VARCHAR(100) NOT NULL UNIQUE  -- 客户端调用标识符
category        VARCHAR(255) NULL
price           REAL          NOT NULL
pricing_tiers   TEXT          NULL          -- JSON: 分级定价
description     TEXT          NULL
version         VARCHAR(100)  NULL
platform        VARCHAR(100)  NULL          -- "windows"/"mac"/"linux"/"all"
features        TEXT          NULL          -- JSON
icon            VARCHAR(500)  NULL
featured        INT DEFAULT 0
download_url    VARCHAR(500)  NULL
external_link   INT DEFAULT 0
detail_page     VARCHAR(500)  NULL
image           VARCHAR(500)  NULL
image_dark_bg   INT DEFAULT 0
created_at / updated_at
```

**关键事实**：
- 客户端通过 `short_name`（如 `xiaomingMailToolkit`）调用所有接口
- `short_name` 是 **唯一约束**（2026-06-21 加），客户端只需这个标识
- `name` 字段可重复（仅展示用）

### 2.3 `orders` + `order_items` + `order_item_codes`（订单与激活码池）

```
orders:
  id, user_id, items (JSON TEXT), total_amount, status,
  payment_method, paypal_order_id, order_number, verification_code,
  activation_codes (JSON TEXT), is_activated, is_archived,
  created_at, paid_at

order_items:                -- 每个订单的每个产品项
  id, order_id (FK CASCADE), product_id, product_name,
  product_short_name, price, quantity, duration_days

order_item_codes:           -- 激活码池（一项一码）
  id, order_item_id (FK CASCADE), code (UNIQUE),
  is_activated, activated_at, activated_by_user, activated_by_mac
```

**生命周期**：
1. 用户下单 → `orders.status='pending'`、`order_items` 写入
2. 支付完成 → PayPal webhook 或 admin 手动改 `status='paid'`，**触发激活码生成**
3. 激活码生成 → `order_item_codes` 写入 `code`（25 字符 hex，5×5 分组）
4. 用户激活 → `order_item_codes.is_activated=1`，记录 `activated_at/_user/_mac`

### 2.4 `user_software_status`（USS · 激活状态主表 · 单一事实源）

```
id                   INT PK AI
user_name            VARCHAR(255) NOT NULL
software_short_name  VARCHAR(255) NOT NULL
first_run            TIMESTAMP NULL          -- 首次安装时间
last_activated_at    TIMESTAMP NULL          -- 最近一次激活
duration             INT NULL                -- 累计授权天数
expire_date          TIMESTAMP NULL          -- 到期日
`lock`               TINYINT NOT NULL DEFAULT 0   -- 0=正常 1=过期 2=管理员锁定 3=保留
last_reminder_at     TIMESTAMP NULL          -- 上次邮件提醒
reminder_count       INT DEFAULT 0
created_at / updated_at
UNIQUE (user_name, software_short_name)
```

**关键事实**：
- `lock` 是核心状态字段，由 heartbeat/activate/cron/admin 共同维护
- `expire_date` 是**滑动计算**结果（见 §5.4 滑动窗口逻辑）
- 同一用户同一软件只有一行（UNIQUE 约束）
- USS 是 `/api/heartbeat` 的单一查询来源

### 2.5 `activations` + `installations`（历史记录表）

```
activations:           -- 每次激活的历史快照
  id, user_name, organization, email, software_name, mac_address,
  install_date (VARCHAR), activate_date (VARCHAR),
  expire_date (VARCHAR), activation_key, status ('active'|'inactive'|'blocked'),
  created_at

installations:         -- 每次安装的历史快照（30天试用）
  id, software_name, software_short_name, software_version,
  user_name, user_email, organization, mac_address,
  install_date (TIMESTAMP), expire_date (VARCHAR), status,
  created_at
```

**关键事实**：
- `activations` 与 USS 是**双写**关系：每次成功激活既更新 USS 又插一行 `activations`
- `installations` 与 USS 也是双写：每次 install 既 UPSERT USS 又插一行 `installations`
- 这两个表是**审计/历史**，USS 是**当前状态**
- `expire_date` 在这两个表里是 `VARCHAR(100)`（历史原因），不要直接 `new Date()`，必须用 `db.js:computeRemainingDays()` helper

### 2.6 `activation_logs` + `operation_logs`（审计日志）

```
activation_logs:
  id, mac_address, software_name, activation_key, status ('SUCCESS'|'RENEWAL'), ip, created_at

operation_logs:
  id, username, action, target, details, ip, created_at
```

`activation_logs` 只记录激活相关（按月轮转）；`operation_logs` 记录所有管理操作（含 ACTIVATE/INSTALL/ADMIN_LOCK/CRON_*）。

---

## 3. 用户注册流程（`/api/user/register`）

### 3.1 公开端点

```
POST /api/user/register
Content-Type: application/json
{
  "username":  "alphanumeric, 3-32 chars",
  "password":  "8+ chars, will be bcrypt hashed",
  "email":     "RFC 5322 simplified",
  "realName":  "required if !company",
  "company":   "required if !realName",
  "phone":     "optional"
}
```

### 3.2 服务端 6 步流程（server.js:902-968）

```
1. 参数校验
   ├─ username / password / email 非空
   ├─ password >= 8 chars
   ├─ email 正则: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
   └─ realName 与 company 至少一个

2. 查重
   ├─ users.username UNIQUE
   └─ （email 不唯一）

3. bcrypt 加密 password（cost=10）

4. INSERT INTO users (..., email_verified=0, email_verify_token=crypto.randomUUID(), expires=now+24h)

5. 发邮件 sendEmail({ to: email, subject: '验证邮箱', text: '...点击 /verify-email?token=...' })

6. 返回 { success: true, userId, message: '请在 24 小时内查收邮件完成验证' }
```

### 3.3 邮箱验证（`GET /verify-email?token=...`）

```
1. 查 users WHERE email_verify_token = ?
2. 校验 expires_at > NOW()
3. UPDATE users SET email_verified=1, email_verify_token=NULL, expires_at=NULL
4. 跳转登录页 + flash message
```

**注意**：**email_verified=0 不阻塞激活流程**（业务妥协 —— 客户体验优先），但 admin UI 可以看到未验证用户。

---

## 4. 软件安装流程

### 4.1 提交安装（`POST /api/install` · 公开）

```json
{
  "userName":     "与 users.username 一致",
  "userEmail":    "可选",
  "softwareName": "products.short_name",
  "organization": "可选",
  "macAddress":   "XX:XX:XX:XX:XX:XX 或 XXXXXXXXXXXX"
}
```

**服务端**（server.js:1925-1957）：
```
1. 校验 userName/userEmail/softwareName 非空
2. 查 products.short_name 是否存在
3. db.addUserSoftwareInstall(userName, short_name)
   ├─ INSERT ... ON DUPLICATE KEY UPDATE first_run = LEAST(first_run, VALUES(first_run))
   └─ （幂等：重复 install 不覆盖原首次时间）
4. 写 operation_logs: INSTALL
5. 返回 { success, firstRun, status: 'installed' }
```

### 4.2 设备心跳（`POST /api/heartbeat` · 公开 · 客户端每几分钟调用）

```json
{ "softwareShortName": "xiaomingMailToolkit", "macAddress": "AA:BB:CC:DD:EE:FF" }
```

**返回**：
```json
{
  "found":             true | false,
  "count":             数字,
  "softwareShortName": "xiaomingMailToolkit",
  "macAddress":        "AA:BB:CC:DD:EE:FF",
  "records": [
    {
      "id":                  80,
      "softwareName":        "小铭邮件百宝箱（个人版）",
      "softwareShortName":   "小铭邮件百宝箱（个人版）",
      "macAddress":          "00-D8-61-80-74-22",
      "isInstalled":         true,
      "isActivated":         true,
      "installDate":         "2026-06-15T...",
      "registerDate":        "2026-06-15T...",
      "activateDate":        "2026-06-15T...",
      "lastActivateDate":    "2026-06-22T...",
      "activationDuration":  365,
      "expireDate":          "2026-06-28",
      "activationKey":       "ABCDE-...",
      "userEmail":           "alice@example.com",
      "userName":            "alice",
      "organization":        "...",
      "status":              "active",
      "createdAt":           "2026-06-15T...",
      "updatedAt":           "2026-06-22T00:40:12.000Z",
      "lastHeartbeatAt":     "2026-06-22T00:40:12.000Z",
      "isExpired":           false,
      "remainingDays":       6
    }
  ]
}
```

**行为**（server.js:2117 + db.js:heartbeatDevice）：
1. `UPDATE device_software_expire SET last_heartbeat_at = NOW(), updated_at = NOW() WHERE software_short_name = ? AND mac_address = ?`
2. `SELECT * FROM device_software_expire WHERE software_short_name = ? AND mac_address = ?` 重新读出（包含刚刚写入的 `last_heartbeat_at`）
3. 服务端加两个计算字段：`isExpired`（expire_date < now）、`remainingDays`（向上取整）
4. **不存在则不创建**（`found:false`、空 `records`）—— 客户端必须先 `POST /api/install` 注册
5. **只对已注册设备更新时间戳** —— 防任意客户端写脏数据

**限流**：`checkPublicEndpointRateLimit` 30 次/分钟/IP（公开端点标准）

**注意**：
- 客户端**必须**每隔几分钟（推荐 5-10 分钟）调用此接口 —— 用于服务端追踪设备存活 + 客户端核对授权状态
- 字段 `isExpired` 和 `remainingDays` 是服务端计算字段，方便客户端 UI 直接判断
- 旧版 `/api/install/check` 已废弃（2026-06-22 删除）

---

## 5. 软件激活流程（`POST /api/activate` · 公开 · 核心）

### 5.1 入参

```json
{
  "activationCode": "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",  // 25 hex chars (5×5)
  "macAddress":     "XX:XX:XX:XX:XX:XX 或 XXXXXXXXXXXX",
  "userName":       "（可选，调试用）",
  "userEmail":      "（可选）"
}
```

> 注：`installDate`/`activateDate` **不接受客户端传入**，服务端始终用 `new Date()`（2026-06-21 修补）

### 5.2 12 步流程（server.js:1717-1832）

```
步骤  1.  校验 activationCode 格式（非空 + isValidActivationCode 正则）
步骤  2.  查 order_item_codes JOIN order_items JOIN orders WHERE code=?
步骤  3.  校验 codeRecord.isActivated === false（未使用）
步骤  4.  校验 order.status IN ('paid', 'completed')
步骤  5.  查 users WHERE id = order.user_id（订单购买人）
步骤  6.  校验 userEmail（如果提供）必须等于 orderUser.email（大小写不敏感）
步骤  7.  查 user_software_status 必须存在（**必须先 install**）
步骤  8.  ★ 原子标记：UPDATE order_item_codes SET is_activated=1 WHERE id=? AND is_activated=0
                ↳ affectedRows=0 → 失败（已被并发占用）
步骤  9.  db.addUserSoftwareActivation 写 USS（**滑动窗口**算法，见 §5.4）
步骤 10.  INSERT INTO activations（历史快照，status='active'）
步骤 11.  INSERT INTO activation_logs（status='SUCCESS' 或 'RENEWAL'）
步骤 12.  返回 { success, message, softwareName, totalDays, activateDate, expireDate, isRenewal }
```

**关键防御**：
- **步骤 8 是并发安全核心**：`WHERE is_activated=0` 配合 `affectedRows` 检查保证同码只能激活一次
- **步骤 6 是反钓鱼核心**：用户必须证明拥有下单邮箱，否则不能激活别人的码
- **步骤 7 防白嫖**：必须先 install 才能激活，防止未购用户盗码

### 5.3 激活码生成与校验

**生成**（server.js:329-346）：
```js
function generateActivationCodes(count = 5) {
  // 13 random bytes = 26 hex chars
  // 切成 5 段，每段 5 字符，用 '-' 连接
  const bytes = crypto.randomBytes(13).toString('hex').toUpperCase();
  const code = `${bytes.slice(0,5)}-${bytes.slice(5,10)}-${bytes.slice(10,15)}-${bytes.slice(15,20)}-${bytes.slice(20,25)}`;
}
```

**校验**（server.js:418-424）：
```js
function isValidActivationCode(code) {
  return /^[a-zA-Z0-9_-]{6,32}$/.test(code);
}
```

**注意**：
- 生成用 `crypto.randomBytes`（密码学安全）—— 不是 `Math.random()`
- 校验正则故意放宽（接受更多字符）—— 因为历史生成格式可能变
- 26 hex = 13 bytes = **104 位熵** —— 暴力枚举不可行

### 5.4 滑动窗口算法（核心业务逻辑）

**目的**：用户已激活未到期时续费 → **累加**到当前到期日；过期后激活 → **从今天**重新开始。

**实现**（db.js:897-919）：
```js
async function addUserSoftwareActivation(userName, softwareShortName, durationDays) {
  const existing = await getUserSoftwareStatus(userName, softwareShortName);
  if (!existing) throw new Error('user_software_status not found; call addUserSoftwareInstall first');

  const now = new Date();
  const currentExpire = existing.expireDate ? new Date(existing.expireDate) : null;
  let newExpire, isRenewal = false;

  if (currentExpire && currentExpire.getTime() >= now.getTime()) {
    // 未过期 → 累加
    newExpire = new Date(currentExpire.getTime() + durationDays * 86400000);
    isRenewal = true;
  } else {
    // 已过期 → 从今天开始
    newExpire = new Date(now.getTime() + durationDays * 86400000);
  }

  await mysqlPool.query(
    `UPDATE user_software_status
     SET last_activated_at = NOW(), duration = COALESCE(duration, 0) + ?,
         expire_date = ?, \`lock\` = 0
     WHERE user_name = ? AND software_short_name = ?`,
    [durationDays, newExpire, userName, softwareShortName]
  );

  return { ...(await getUserSoftwareStatus(userName, softwareShortName)), isRenewal };
}
```

**关键点**：
- `duration` 字段是**累计授权天数**（如买 1 年+1 年 = 730），`expire_date` 是最终到期日
- **始终 `lock=0`** —— 激活成功后强制解锁
- 重置 lock=0 覆盖 cron 自动锁定的 1（防管理员误操作残留）

### 5.5 授权期限解析（admin 输入侧）

```js
function parseDurationToDays(duration) {
  if (!duration) return 365;
  if (/永久|终身/i.test(duration)) return 365 * 100;  // 永久 = 100 年
  if (/(\d+)\s*天/.test(d))  return parseInt(d[1]);
  if (/(\d+)\s*个月?/.test(d)) return parseInt(d[1]) * 31;
  if (/(\d+)\s*年/.test(d))  return parseInt(d[1]) * 365;
  if (/(\d+)\s*周/.test(d))  return parseInt(d[1]) * 7;
  return 365;
}
```

**注意**：1 个月 = **31 天**（保守，按上限算），与日历月略有差异。

---

## 6. 锁定状态机（`user_software_status.lock`）

```
   ┌─────────┐
   │ 0 正常   │ ←─────────────┐
   └─────────┘               │
        │                     │ (admin unlock / 成功激活)
        │ expire              │
        ▼                     │
   ┌─────────┐                │
   │ 1 过期   │ ──────────────┘
   └─────────┘
        ▲ (cron 每日检测)
        │

   ┌─────────┐
   │ 2 管理员 │ ←──── (admin lock)
   │   锁定   │ ─────→ (admin unlock + 30 天延期)
   └─────────┘

   ┌─────────┐
   │ 3 保留   │ （未来扩展，当前未使用）
   └─────────┘
```

**Cron**（`POST /api/cron/expire-check`）：
```sql
UPDATE user_software_status SET `lock` = 1 WHERE expire_date < NOW() AND `lock` = 0
```

**注意**：cron token 通过 `x-cron-token` header 或 `?token=` query 传入，必须等于 `process.env.CRON_TOKEN`。

---

## 7. 邮件提醒流程（`POST /api/cron/expiry-reminder`）

**逻辑**（db.js:957-958）：
```sql
-- 15 天内到期，且上次提醒距今 > 14 天（节流）
SELECT ... FROM user_software_status s
WHERE s.expire_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 15 DAY)
  AND (s.last_reminder_at IS NULL OR DATEDIFF(NOW(), s.last_reminder_at) > 14)
```

**每次提醒**：发邮件 + 写 `last_reminder_at` + 计数（`reminder_count`）。

---

## 8. Admin 管理端点

| 端点 | 功能 |
|---|---|
| `GET /api/admin/user-software-status` | 列所有 USS 行 |
| `POST /api/admin/user-software-status/:id/lock` | 锁定（`lock=2`） |
| `POST /api/admin/user-software-status/:id/unlock` | 解锁 + 延期 30 天 |
| `GET /api/activations` | 列所有激活历史（含滑动窗口计算） |
| `PUT /api/activations/:id` | 改状态（`active`/`inactive`/`blocked`） |
| `DELETE /api/activations/:id` | 删除激活记录 |

**Admin 锁定/解锁策略**（server.js:1462-1490）：
- Lock: `lock=2`（不会被 cron 自动覆盖）
- Unlock: `lock=0` + `expire_date = DATE_ADD(GREATEST(expire_date, NOW()), INTERVAL 30 DAY)` —— 避免解锁后立刻又被 cron 锁

---

## 9. 支付 → 激活码生成（PayPal Webhook）

`POST /api/paypal/webhook`（server.js:1494-1559）：

```
1. （⚠️ 生产必须加 PayPal 签名校验，当前 TODO 未实现）
2. event_type ∈ { CHECKOUT.ORDER.COMPLETED, PAYMENT.CAPTURE.COMPLETED }
3. UPDATE orders SET status='paid', paid_at=NOW(), payment_method='paypal', paypal_order_id=?
   WHERE id=? AND status NOT IN ('paid','completed')
   ↳ affectedRows=0 → 已处理（幂等返回 200）
4. 为每个 order_item 生成 1 个激活码（crypto.randomBytes）
5. INSERT INTO order_item_codes
6. 发邮件给用户（含激活码列表）
7. 写 operation_logs: PAYPAL_WEBHOOK
```

**⚠️ 安全风险**：webhook 当前**未校验 PayPal 签名**。攻击者可以伪造请求触发激活码生成 + 邮件。**生产上线前必须修复**（见 `docs/superpowers/specs/...` 待补）。

---

## 10. API 端点速查表

### 公开（无需登录）
| Method | Path | 用途 |
|---|---|---|
| POST | `/api/user/register` | 用户注册（触发邮箱验证） |
| GET | `/verify-email?token=` | 邮箱验证回调 |
| POST | `/api/install` | 提交安装 |
| POST | `/api/heartbeat` | 设备心跳（每几分钟，返回全表 + 更新 last_heartbeat_at） |
| POST | `/api/activate` | 用激活码激活 |
| POST | `/api/subscribe` | 邮件订阅 newsletter |
| POST | `/api/paypal/webhook` | PayPal 回调（签名待校验） |

### 管理员（requireAuth + isAdmin）
| Method | Path | 用途 |
|---|---|---|
| GET | `/api/activations` | 列激活历史 |
| PUT | `/api/activations/:id` | 改激活状态 |
| DELETE | `/api/activations/:id` | 删激活 |
| GET | `/api/installs` | 列安装历史 |
| GET | `/api/admin/user-software-status` | 列 USS |
| POST | `/api/admin/user-software-status/:id/lock` | 锁定 |
| POST | `/api/admin/user-software-status/:id/unlock` | 解锁 |
| GET | `/api/admin/backup/*` | 备份管理（6 端点） |

### Cron（CRON_TOKEN header）
| Method | Path | 用途 |
|---|---|---|
| POST | `/api/cron/expire-check` | 每日锁定过期记录 |
| POST | `/api/cron/expiry-reminder` | 到期前 15 天邮件提醒 |

---

## 11. 客户端集成示例（参考）

```js
const BASE = 'https://your-server.com';

// 1. 安装（首次启动 + 首次在该 MAC 运行时）
await fetch(BASE + '/api/install', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userName: 'alice',
    userEmail: 'alice@example.com',
    softwareName: 'xiaomingMailToolkit',  // products.short_name
    macAddress: 'AA:BB:CC:DD:EE:FF'
  })
});

// 2. 每隔几分钟心跳（追踪设备存活 + 核对授权状态）
setInterval(async () => {
  const res = await fetch(BASE + '/api/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      softwareShortName: 'xiaomingMailToolkit',
      macAddress: 'AA:BB:CC:DD:EE:FF'
    })
  }).then(r => r.json());

  if (!res.found) {
    showInstallGuide();
    return;
  }
  const rec = res.records[0];
  if (rec.isExpired) showActivateDialog();           // 过期 → 让用户输激活码
  else if (rec.status === 'blocked') showLockedScreen();
  else showApp();                                    // 正常
}, 5 * 60 * 1000);  // 5 分钟一次

// 3. 激活
await fetch(BASE + '/api/activate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    activationCode: 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY',
    macAddress: 'AA:BB:CC:DD:EE:FF',
    userEmail: 'alice@example.com'
  })
});
```

---

## 12. 已知边界与设计决策

| 场景 | 决策 | 原因 |
|---|---|---|
| 邮箱未验证能否激活？ | ✅ 允许 | UX 优先（客户体验 > 安全摩擦） |
| 同一码能否多设备激活？ | ❌ 不允许 | `is_activated` 单次标记 + 邮箱一致校验 |
| 续费未到期时如何？ | ➕ 累加到当前到期日 | 客户付费不能"丢失" |
| admin 锁能否被 cron 覆盖？ | ❌ 不覆盖 | `lock=2` 不在 cron UPDATE 条件内 |
| 解锁后延期多久？ | 30 天 | 避免解锁后立即被 cron 重新锁 |
| 安装重复怎么办？ | UPSERT first_run = LEAST(...) | 保留原始首次时间 |
| 激活码格式？ | 5×5 hex（26 字符） | 104 位熵，难暴力枚举 |
| email 重复允许？ | ✅ 允许 | DB 无 UNIQUE 约束 |

---

## 13. 客户端故障排查清单

| 症状 | 排查路径 |
|---|---|
| 激活返 400 "激活码格式无效" | 检查 `activationCode` 是否符合 `[a-zA-Z0-9_-]{6,32}` |
| 激活返 400 "请先安装软件后再激活" | 客户端未调用 `/api/install` 或 userName 与购买账户不一致 |
| 激活返 403 "邮箱与购买账户不一致" | userEmail 必须等于 `orders.user_id → users.email` |
| 激活返 400 "激活码已使用" | 同码已被并发占用或 admin 已激活 |
| heartbeat 返 `found:false` | userName 在 device_software_expire 不存在 — 需要先 install |
| expire_date 显示 -25569 天 | legacy 数据（无 expire_date）—— 已修 computeRemainingDays() |
| PayPal 支付后没收到激活码邮件 | webhook 是否被 PayPal 拒绝 / 检查 admin 操作日志 |

---

## 14. 变更历史

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-06-19 | 激活流程重设计（26 任务），引入 USS + 滑动窗口 + cron | Sonnet |
| 2026-06-21 | 修复 4 Critical（订阅错误/expire_date null guard/createUser is_admin/列名一致性）+ 6 Important | Sonnet |
| 2026-06-21 | 备份恢复功能上线（8 任务），含审计日志 | Sonnet |
| 2026-06-22 | `/api/install/check` 删除，改用 `/api/heartbeat`（per-MAC 设备心跳 + last_heartbeat_at 字段） | Sonnet |
| 2026-06-22 | `expire` 表重命名为 `device_software_expire`，新增 `last_heartbeat_at` 列 | Sonnet |
| 2026-06-22 | 新增 `prisma/` Prisma-style schema 管理工具（diff.js + schema.js） | Sonnet |

---

## 15. 设备心跳与 `device_software_expire` 表

### 15.1 表结构

```
id                   INT PK AI
software_name        VARCHAR(255) NOT NULL       -- 完整产品名（中文）
software_short_name  VARCHAR(100) NULL           -- 客户端标识符（heartbeat 入参）
mac_address          VARCHAR(255) NOT NULL       -- 设备 MAC
is_installed         TINYINT(1) DEFAULT 0
is_activated         TINYINT(1) DEFAULT 0
install_date         TIMESTAMP NULL
register_date        TIMESTAMP NULL
activate_date        TIMESTAMP NULL
last_activate_date   TIMESTAMP NULL
activation_duration  INT DEFAULT 0
expire_date          VARCHAR(100) NOT NULL        -- 到期日（用 computeRemainingDays 解析）
activation_key       VARCHAR(255) NULL
user_email           VARCHAR(255) NULL
user_name            VARCHAR(255) NULL
organization         VARCHAR(255) NULL
status               VARCHAR(50) DEFAULT 'active'
created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
updated_at           TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
last_heartbeat_at    TIMESTAMP NULL              -- ★ 每次 heartbeat 更新
UNIQUE (software_name, mac_address)              -- 一个 (software_name, mac) 唯一
INDEX (mac_address)
INDEX (expire_date)
```

**注意**：
- `uniq_software_mac` 唯一约束是组合键 `(software_name, mac_address)`，不是单列
- `software_short_name` 可空（早期数据缺失，新数据必填）
- `expire_date` 仍是 VARCHAR(100) 历史格式，客户端请用 `db.js:computeRemainingDays()` 解析

### 15.2 写入路径

当前**只有 `/api/heartbeat` 一个写入入口**（UPDATE 模式，不创建新行）。其他表（`activations` / `installations`）才是真正的"安装/激活"事实表。

```
client → POST /api/heartbeat → UPDATE device_software_expire
                              SET last_heartbeat_at = NOW()
                              WHERE short_name=? AND mac=?
                              → SELECT * → 响应
```

### 15.3 与 `activations` / `installations` 的关系

```
activations     → 每次激活的"事实快照"（多行历史）
installations   → 每次安装的"事实快照"（多行历史）
device_software_expire → 设备当前状态（per-MAC 一行，heartbeat 更新）
```

`/api/heartbeat` 的 `records` 数组含 `activation_key` / `user_email` / `user_name`，**足够客户端核对授权状态**。如果需要历史轨迹，调 `/api/activations`（admin only）。

---

## 16. 第三方软件集成 checklist

如果你要为 booming-tech 商城开发配套客户端软件，按以下步骤接入：

```
1.  列出 products.short_name 列表
    GET /api/products  → 取 short_name 字段

2.  客户端首次启动 + 首次在该 MAC 运行时
    POST /api/install  { userName, userEmail, softwareName, macAddress }

3.  每隔 5-10 分钟心跳
    POST /api/heartbeat  { softwareShortName, macAddress }
    读 records[0].isExpired / remainingDays 决定 UI

4.  用户输激活码时
    POST /api/activate  { activationCode, macAddress, userEmail }
    成功 → 立即再发一次 heartbeat 刷新 expireDate

5.  服务端返回任意 4xx → 引导用户重新 install / 检查邮箱 / 联系客服
   服务端返回 5xx → 客户端重试（指数退避 1s/2s/4s，最多 3 次）

错误码速查：
  400 + "请先安装软件后再激活" → 客户端未 install
  400 + "激活码格式无效"       → 检查 5×5 格式
  400 + "激活码已使用"         → 换码或联系客服
  403 + "邮箱与购买账户不一致" → 检查 userEmail 是否等于购买邮箱
  404 + "激活码无效"           → 输错码
  429                        → 限流 30/min/IP，停止 1 分钟后重试
```

**强制约束**：
- 客户端**禁止**自己生成 `expireDate` / `installDate` / `activateDate` — 全部由服务端计算
- 客户端**禁止**直接调 `/api/admin/*` — 没有 cookie
- 客户端**禁止**调 `/api/heartbeat` 频率高于 30/min/IP（被限流）

---

**维护原则**：
- 任何 schema 变更必须 ALTER TABLE 生产 + 同步 `prisma/schema.js` + `db.js` CREATE TABLE
- 任何新端点必须 requireAuth + isAdmin（如果管理端）+ writeOperationLog
- 任何客户端可控制字段必须 server-side 计算（不接受 user-supplied 日期/数字）
- 任何密码学相关代码必须用 `crypto.randomBytes`，禁止 `Math.random()`
- 任何 schema 变更后跑 `node prisma/diff.js` 验证 0 差异