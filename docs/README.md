# API 文档

## 目录

- [安装注册 API](api-install.md) - 软件客户端注册与验证
- [MCP 端点](mcp-endpoint.md) - AI 工具通过 MCP 创建/修改「动态」与「产品 / 产品文档」

---

## 安装向导（首次部署用）

站点「装没装好」的**唯一判据**是 `users` 表里有没有 `is_admin = 1` 的账号。
建表与灌默认数据都是幂等的，不能拿来当闸门。

> `is_admin` 这一列是判据的前提。老库若当初建表时没有它，启动时的幂等补列
> （`db.js` 的 `userAlterStatements`）会补上；补不上时状态判定会退化成「无法判定」，
> 安装写操作一律 fail-closed —— 表现就是全新安装卡在「建不出第一个管理员」。

向导页面：`GET /setup`（未安装时可用；已安装会跳转到 `/login` 或 `/admin-overview`）。

三道闸：

1. **安装令牌** —— `SETUP_TOKEN` 环境变量优先，其次 `data/setup-token.txt`（服务器自动生成，
   权限 600，**只打进控制台**，不经任何 HTTP 响应回显）。
2. **「确实未安装」判定** —— DB 异常时 fail-closed，拒绝写操作。
   例外范围见下面「数据库不可用时怎么办」。
3. 首个管理员创建成功后，**令牌文件被删除**，安装接口永久关闭。

令牌通过 `X-Setup-Token` 请求头传递（也兼容 body 里的 `setupToken` 字段）。

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/setup/verify-token` | 令牌 | 校验令牌并返回安装状态 |
| GET | `/api/setup/status` | 令牌 | 查询安装状态（是否已装、缺哪些表、配置来源） |
| POST | `/api/setup/test-db` | 令牌 + 未安装 | 用提交的连接信息测试连通性（不改任何状态） |
| POST | `/api/setup/save-db-config` | 令牌 + 未安装 | 把连接参数**写进 `.env`** 并立即切换连接池 |
| POST | `/api/setup/init-db` | 令牌 + 未安装 | 建表 + 补列 + 灌默认数据（幂等，可重复执行） |
| POST | `/api/setup/create-admin` | 令牌 + 未安装 | 创建首个管理员；成功后销毁令牌 |

> 「未安装」判定在**数据库不可用**时也有讲究：改数据库配置这类操作在数据库不可用时放行
> （站点本来就是坏的，正需要向导来救），而建表、创建管理员仍然 fail-closed。
>
> **「数据库不可用」= 连不上 或 认证不过**：
>
> | 类别 | 典型错误 | 判定 |
> |---|---|---|
> | 连不上 | `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` / 连接池没建起来 | 算「不可用」→ 放行改配置 |
> | 认证不过 | `ER_ACCESS_DENIED_ERROR`(1045，账号密码错) / `ER_DBACCESS_DENIED_ERROR`(1044，账号对该库没权限) | 算「不可用」→ 放行改配置 |
> | 判定 SQL 跑不通 | `ER_BAD_FIELD_ERROR` / `ER_TABLEACCESS_DENIED_ERROR`(1142，表级权限不足) | **不算**「不可用」→ fail-closed |
>
> 认证失败必须算「不可用」：全新部署时仓库不带 `.env`，进程按默认值连 `root@localhost`
> 且不带密码，MySQL 必然回认证失败。若把它当成「连上了但查询失败」，向导连 `.env`
> 都写不出来，安装流程在第 2 步就卡死。
>
> 反过来，「连得上、认证也过了，只是判定安装状态的那条 SQL 跑不通」一律 fail-closed：
> 这时站点多半是装好的，放行改配置等于允许把一个装好的站点重新指向别的库。

### 数据库不可用时怎么办

服务器启动时如果数据库不可用，**不会退出进程**，而是降级启动：

- `/setup` 与 `/api/setup/*` 照常可用（安装令牌会打进控制台，提示语是「修正连接配置」）；
- 其余依赖数据库的接口统一返回 **503** `{ error: '数据库当前不可用', setupUrl: '/setup' }`；
- 修好连接后重启（或在向导里保存配置）即可恢复。

注意：**`.env` 是安装向导的产物**，仓库里只留 `.env.example`（模板与说明）。
向导第 2 步点「写入 .env 并继续」时，会生成 `.env`（权限 0600），里面是：

| 键 | 来源 |
|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | **你填的**（向导负责建表，不负责建库） |
| `SESSION_SECRET` / `CRON_TOKEN` | **机器随机生成**（沿用已有 `.env` 里的旧值，不顺手作废会话） |
| `PORT` | 沿用当前进程端口 |

写入后**当场生效**（连接池立即切换），但会话密钥与 session 存储池在启动时绑定 ——
向导最后一步会提示重启一次。旧的 `.env` 会被备份成 `.env.bak`；新配置连不上时会自动回滚。

`.env` 里**刻意不写**两个键：`SETUP_TOKEN`（写了就永久有效）和 `MCP_TOKEN`
（主令牌改由后台「系统设置 → MCP」生成/轮换，存在数据库里）。

**保存时不会误伤其它键**：受管键之外的原有键（如 `PAYPAL_WEBHOOK_ID`、
`MCP_ALLOWED_HOSTS`、`DB_COPY_ALLOWED_HOSTS`）会被**整行原样**搬到文件末尾的
`Preserved` 段；受管键里**值没变**的那些（如沿用的 `SESSION_SECRET`）也保留原始行。
全程不做「解析 → 重新序列化」的往返，因此一个字节都不会变。
注释掉的键不会被「复活」（注释即未配置）。

---

## 公开接口（无需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/install` | 提交安装注册 |
| POST | `/api/install/check` | 查询注册状态 |
| POST | `/api/activate` | 软件激活验证 |
| GET | `/api/products` | 获取产品列表（**只返回已上架的产品**） |
| GET | `/api/products/:id` | 获取产品详情（草稿返回 404） |
| GET | `/api/faqs` | 获取FAQ列表 |
| POST | `/api/support` | 提交技术支持工单 |
| GET | `/api/settings` | 获取网站设置（部分字段） |

## 管理接口（需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 管理员登录 |
| GET | `/api/orders` | 用户订单列表 |
| GET | `/api/orders/all` | 所有订单（管理员） |
| GET | `/api/activations` | 激活记录列表 |
| GET | `/api/installs` | 安装记录列表 |
| GET | `/api/support` | 工单列表 |
| POST | `/api/products` | 添加产品 |
| PUT | `/api/products/:id` | 更新产品 |
| DELETE | `/api/products/:id` | 删除产品 |
| GET | `/api/admin/products` | 产品列表（**含草稿**，可按上架状态筛选） |
| GET | `/api/admin/products/:id` | 产品详情（草稿也可取，用于后台编辑） |
| POST | `/api/admin/products/:id/publish` | 产品上架（`status=1`） |
| POST | `/api/admin/products/:id/unpublish` | 产品下架（`status=0`） |
| POST | `/api/settings` | 更新网站设置 |
| GET | `/api/security/logs` | 安全日志 |
| GET | `/api/email/config` | 邮件配置 |
| POST | `/api/email/config` | 更新邮件配置 |
| GET | `/api/db-config` | 读取数据库连接配置（含 `configSource`：`env` / `file` / `default`） |
| POST | `/api/db-config` | 把连接参数写进 `.env` 并立即切换连接池（连不上则自动回滚 `.env`） |
| POST | `/api/db-test` | 按提交的连接信息测试连通性（不改任何状态） |
| POST | `/api/db-init` | 初始化 / 修复表结构（建表 + 补列 + 灌默认数据，幂等） |

> 产品「上架 / 下架」只能由人工走上面两个 `publish` / `unpublish` 接口 —— MCP 不提供对应的工具。
> 草稿产品**不可下单**（`POST /api/orders` 返回 `PRODUCT_NOT_AVAILABLE`），前台也看不到。
> 详见 [MCP 端点 §3.4](mcp-endpoint.md#34-产品一律是草稿上架必须人工) 与 [§3.5](mcp-endpoint.md#35-草稿产品的下单闸门)。
