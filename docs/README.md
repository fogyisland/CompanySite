# API 文档

## 目录

- [安装注册 API](api-install.md) - 软件客户端注册与验证

---

## 公开接口（无需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/install` | 提交安装注册 |
| POST | `/api/install/check` | 查询注册状态 |
| POST | `/api/activate` | 软件激活验证 |
| GET | `/api/products` | 获取产品列表 |
| GET | `/api/products/:id` | 获取产品详情 |
| GET | `/api/faqs` | 获取FAQ列表 |
| POST | `/api/support` | 提交技术支持工单 |
| GET | `/api/settings` | 获取网站设置（部分字段） |

## 管理接口（需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 管理员登录 |
| GET | `/api/check-auth` | 检查登录状态 |
| GET | `/api/orders` | 用户订单列表 |
| GET | `/api/orders/all` | 所有订单（管理员） |
| GET | `/api/activations` | 激活记录列表 |
| GET | `/api/installs` | 安装记录列表 |
| GET | `/api/support` | 工单列表 |
| POST | `/api/products` | 添加产品 |
| PUT | `/api/products/:id` | 更新产品 |
| DELETE | `/api/products/:id` | 删除产品 |
| POST | `/api/settings` | 更新网站设置 |
| GET | `/api/security/logs` | 安全日志 |
| GET | `/api/email/config` | 邮件配置 |
| POST | `/api/email/config` | 更新邮件配置 |
