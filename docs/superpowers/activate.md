# 软件注册与激活流程

> 状态：当前实现（2026-06-19）
> 目的：记录当前注册 + 激活流程，作为后续改造的基线参考

## 1. 系统角色

| 角色 | 标识 | 主要场景 |
|---|---|---|
| 访客 | 无 session | 浏览产品、查看详情、注册、登录 ，购买过程中登录并且保留当前放在购物车的产品
| 普通用户 | `req.session.userId` 有值、`isAdmin=false` | 下单、付款、激活软件、查看自己的订单/激活记录 |
| 管理员 | `req.session.userId` 有值、`isAdmin=true` | 管理产品/订单/用户/激活码，所有后台操作 |

## 2. 关键数据表   
在这里需要注意的，我们这里所有的Json格式为标准的数据字段，不再是Json格式，效率会相对比较高

| 表 | 用途 | 关键列 |
|---|---|---|
| `users` | 用户（含管理员，is_admin 区分） | `id, username, password, email, phone, realName, company, is_admin` |
| `products` | 软件产品 | `id, name, short_name, price, pricing_tiers, version, platform, features, icon, download_url` |
| `orders` | 订单 | `id, user_id, items(JSON), total_amount, status, verification_code, activation_codes(JSON), order_number, is_activated, is_archived, paid_at, created_at` | 注意：这里的Item 和activation_code 修改为字段模式，非Json模式
| `activations` | 激活记录 | `id, user_name, organization, email, software_name, install_date, mac_address, activation_key, expire_date, created_at` |
| `installations` | 安装记录 | `id, software_name, user_name, user_email, organization, mac_address, install_date, expire_date` |
| `used_activation_codes` | 已使用激活码（事务保护） | `id, activation_code, order_id, used_at` |  这个表不需要，我们在订单中写入激活码和是否激活字段即可
| `activation_logs` | 激活日志 | `id, mac_address, software_name, activation_key, status, ip, created_at` |
| `login_logs` | 登录日志 | `id, username, ip, user_agent, status, created_at` |
| `operation_logs` | 操作日志（管理员动作） | `id, username, action, target, details, ip, created_at` |

增加一个表：
功能是列出当前所有所有的用户购买的产品的激活总状态，并且支持云端锁定功能，不再使用，这个在注册时候填写前半部分，在激活的时候写入后半部分，在进行激活的时候需要注意，我们激活过程成功后，在这个Expiredate +激活的周期，例如购买了60天的，就加60天
| `UserSoftwareStatus` | 软件产品激活状态 | `id, userName, softwareShortName, firstRun, LastActivatedDate, duration, expire_date,lock` |


## 3. 完整流程

### 3.1 用户注册

```
访客访问 /user-register
  └─ 提交 { username, password, email, realName, company, phone }
POST /api/user/register
  ├─ 校验 username/password/realName 不为空
  ├─ 校验 username 未被占用（db.getUserByUsername）
  ├─ 校验 email 未被占用（db.getUserByEmail，可选）
  └─ db.addUser → bcrypt 哈希密码 → INSERT users
       └─ 写 registration_logs (SUCCESS / FAILED)
  → 201 { success: true, userId }
  └─ 客户端跳 /user-login (历史遗留) → 实际跳 /login
```

注：2026-06-19 已移除图形验证码。注册端点 `verifyCaptcha(req, captcha)` 旧实现是坏的（参数顺序错误），移除时顺带修好。

### 3.2 用户/管理员登录

```
访问 /login
  └─ 提交 { username, password }
POST /api/login
  ├─ 速率限制（IP 维度 5 分钟内失败次数 → 临时封禁）
  ├─ db.verifyLogin(username, password)
  │   ├─ 含 '@' → SELECT WHERE email = ?
  │   └─ 不含 '@' → SELECT WHERE username = ?
  ├─ bcrypt.compare 校验
  └─ 丢弃 password 字段，返回 { id, username, is_admin }
  ├─ 设置 session: userId, username, isAdmin, sessionVersion
  └─ 写 login_logs (SUCCESS / FAILED / REJECTED)
  → 200 { success: true, isAdmin }
  └─ 客户端跳 /user-center（管理员在中心看到后台入口）
```

注：登录端点同样已移除图形验证码。

### 3.3 下单

```
用户 POST /api/orders
  提交 { items: [{ productId, name, price, quantity, duration }], totalAmount }
  ├─ 生成 orderNumber: 'BL' + YYYYMMDDHHmmss + 7位随机
  ├─ db.createOrder → INSERT orders (status='pending', verification_code=null, activation_codes=null)
  ├─ 异步发邮件：订单确认（含订单号、明细、金额）
  └─ 写 order_logs ORDER_CREATED
  → 返回 { id, orderNumber, ... }
```

### 3.4 支付与生成激活码（验证码路径）

```
POST /api/orders/:id/generate-code  (requireAuth, 管理员)
  └─ 随机生成 5 位数字 → db.updateOrderVerificationCode
```
在这里我们生成订单后，如果对接的paypal订单完成就生成激活码
如果是转账，管理员同意就生成激活码


### 3.5 管理员重新生成激活码

```
POST /api/orders/:id/generate-activation-codes  (requireAuth, 管理员)
  ├─ 校验
  └─ generateActivationCodes(5) → 重新生成 5 组激活码
  → 返回新激活码
```

### 3.6 软件注册

```
软件客户端 POST /api/install
  提交 { userName, organization, email, softwareName, installDate, durationDays, macAddress }
  ├─ 校验必填字段、邮箱格式
  ├─ 若 macAddress 已存在该软件的 installations 记录 → 报错"已安装"
  └─ db.createInstallation → INSERT installations (expire_date 后续激活时设置)
  → 200

注册的时候将userName, softwareShortName, firstRun 写入UserSoftwareStatus
```

### 3.7 软件激活

```
软件客户端 POST /api/activate-by-code
  提交 { activationCode, macAddress, userName, userEmail, installDate, activateDate }
  ├─ 校验激活码格式（isValidActivationCode：XX-XXXX-XXXX-XXXX 形式）
  ├─ 校验 MAC 格式、邮箱格式
  ├─ 扫描所有 status='paid' 订单，查找持有此激活码的订单（JSON 反序列化匹配）
  ├─ 校验激活码未被使用（used_activation_codes 表）
  ├─ 从订单 items 中匹配软件（多商品时按 email+softwareName 匹配 installations）
  ├─ 计算到期日（滑动窗口）
  │   ├─ 若 MAC+software 已有 activations 记录 → 取最大 expireDate 为基准
  │   └─ 否则若 email+software 已有 installations → 取 expireDate 为基准
  │   └─ 累加 purchasedDays（从 order item 的 duration 解析）
  ├─ 已有 installations → 更新 expire_date, mac_address, install_date
  │  否则 → 创建新 installations 记录
  ├─ db.activateOrder(orderId, code) 事务：
  │   ├─ 检查 used_activation_codes（防并发）
  │   ├─ UPDATE orders SET is_activated=1, status='completed'
  │   └─ INSERT used_activation_codes
  ├─ db.createActivation → INSERT activations（管理员查看用）
  └─ db.addActivationLog → INSERT activation_logs (SUCCESS / RENEWAL / FAILED)
  → 200 { success, message, softwareName, duration, totalDays, expireDate }
```



### 3.8 续期（同一激活码再次使用）

同 3.7 流程，但 `calculateSlidingWindowExpiry` 会从已有到期日继续累加，不会重置。返回 `isRenewal: true`。   这个似乎不对，同一软件同一激活码再次使用则会拒绝

### 3.9 查看激活记录

```
GET /api/activations           (requireAuth, 管理员)
GET /api/installations         (requireAuth, 管理员)
```

用户在 `user-center.html` 看到自己的订单和激活码（从 `/api/orders` 取，订单上含 activationCodes）。

## 4. 当前流程的问题与可改造点

> 列出可能想调整的方向，供下一步讨论。

### 4.1 验证码 / 支付链路

- **问题**：支付完全靠管理员手工生成 5 位 `verification_code` 并人工发给用户，效率低、易出错、易被猜测
- **可选方向**：
  - 接入真实支付网关（Stripe / 微信 / 支付宝），自动确认支付
  - 验证码改为一次性 token（带订单号签名），用户付款后自动邮件
  - 取消验证码，用户付款后管理员后台确认

### 4.2 激活码管理

- **问题**：
  - 激活码存为 `orders.activation_codes` 的 JSON 字段，查询需要全表扫描 + JSON 反序列化（性能差，见 3.7 `for (const order of allOrders)`）  修改成字段，不需要Json
  - 订单完成后激活码依然存在，没有"用过即焚"机制（虽然 `used_activation_codes` 表能查，但扫描逻辑复杂）   激活码存在用于审核
  - 同一订单 5 组激活码在已激活后剩余的怎么办？当前没有回收机制  用过了就在字段中显示Is_activated
- **可选方向**：
  - 拆出独立的 `activation_codes` 表（id, order_id, code, status: available/used/expired, used_at, used_by_installation_id） 不需要
  - 创建订单时直接 INSERT N 条 available 记录，激活时 UPDATE
  - 改用"一次性 token + 用户 ID"绑定，避免 JSON 字符串匹配

### 4.3 滑动窗口到期

- **问题**：`calculateSlidingWindowExpiry` 逻辑复杂，规则藏在代码里没文档
- **可选方向**： 可以添加，到期之后需要重复启动，软件变成锁定状态，需要购买序列号才能激活
  - 显式定义续费规则（永远累加 vs 截止日期 vs 固定窗口）
  - 暴露给管理员 / 用户的"到期日"显示
  - 添加"提前 N 天提醒"功能，15天发邮件给用户

### 4.4 多用户 / 多设备

- **问题**：当前绑定是"激活码 + 邮箱 + MAC"，多设备用户操作繁琐 ，这个功能可以实现，但是可选是否提供开启
- **可选方向**：
  - 设备数量配额（每激活码允许 3 台设备）
  - 用户中心自助解绑 / 迁移设备
  
### 4.5 验证码已删除，但 `/api/user/login` 仍返回 410 删除验证码路由

- 合并登录后 `/api/user/login` 已被替换为 410，可以考虑彻底删除路由

### 4.6 注册流程

- **问题**：注册不验证邮箱真实性（虽然有 email 字段），必须通过右键点击激活
- **可选方向**：
  - 邮箱验证（注册后发验证邮件，点链接激活账号）
 

### 4.7 验证码逻辑（已修复）

- 旧 `/api/user/register` 调 `verifyCaptcha(req, captcha)` 参数顺序错，2026-06-19 移除 captcha 时顺带修好

## 5. 相关 API 端点速查  检查是否有更好的逻辑激活效果

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/user/register` | 公开 | 注册（已移除 captcha） |
| `POST /api/login` | 公开 | 统一登录（已移除 captcha） |
| `GET /api/user/profile` | 用户 | 个人资料 |
| `PUT /api/user/profile` | 用户 | 修改资料/密码 |
| `GET /api/user/security-logs` | 用户 | 最近 20 条登录记录 |
| `GET /api/orders` | 用户 | 当前用户订单 |
| `POST /api/orders` | 用户 | 创建订单 |
| `POST /api/orders/:id/verify` | 用户 | 提交 verification_code 完成支付 |
| `POST /api/orders/:id/generate-code` | 管理员 | 生成/重置 verification_code |
| `POST /api/orders/:id/generate-activation-codes` | 管理员 | 重新生成 5 组激活码 |
| `POST /api/install` | 公开 | 客户端报告安装 |
| `POST /api/install/check` | 公开 | 客户端检查授权状态 |
| `POST /api/activate` | 公开 | 表单式激活（需 userName/email/softwareName） |
| `POST /api/activate-by-code` | 公开 | 授权码激活（最常用） |
| `GET /api/activations` | 管理员 | 所有激活记录 |
| `GET /api/installs` | 管理员 | 所有安装记录 |

## 6. 上下文与文件位置

- `db.js` — 数据库访问层（users / orders / activations / installations / login_logs / operation_logs / activation_logs）
- `server.js` — 所有路由
- `public/user-register.html` — 注册页
- `public/login.html` — 登录页（合并管理员 + 普通用户）
- `public/user-center.html` — 用户中心（订单、激活码、资料、安全日志）
- `public/checkout.html` / `public/order-detail.html` — 下单/订单详情
- `public/admin-orders.html` / `public/admin-activations.html` / `public/admin-installations.html` — 后台对应管理页
- `docs/superpowers/2026-06-18-merged-login-design.md` — 合并登录的设计文档
- `docs/superpowers/2026-06-18-merged-login-ledger.md` — 合并登录的实施账本
