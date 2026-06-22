# 博铭科技软件销售平台

企业级软件销售网站，支持产品展示、在线购买、订单管理、软件激活等功能。

## 技术栈

- **后端**: Node.js + Express
- **数据库**: MySQL / SQLite
- **前端**: HTML5 + CSS3 + JavaScript

## 功能概览

### 1. 用户端功能

#### 1.1 用户认证
| 功能 | 说明 |
|------|------|
| 用户注册 | 支持邮箱注册，含验证码验证 |
| 用户登录 | 邮箱+密码登录，支持记住登录状态 |
| 密码找回 | 发送重置链接到邮箱 |
| 用户中心 | 查看个人信息、订单历史、激活设备 |

#### 1.2 产品展示
| 功能 | 说明 |
|------|------|
| 产品列表 | 分类展示所有产品，含价格、描述 |
| 产品详情 | 查看产品详细信息、版本、平台 |
| 搜索功能 | 支持关键词搜索产品 |

#### 1.3 购物与订单
| 功能 | 说明 |
|------|------|
| 购物车 | 添加/删除产品，修改数量 |
| 下单 | 创建订单，选择支付方式 |
| 支付验证 | 输入验证码完成支付 |
| 订单管理 | 查看订单状态、支付状态 |
| 订单详情 | 查看订单商品、激活码、下载链接 |

#### 1.4 软件激活
| 功能 | 说明 |
|------|------|
| 试用注册 | MAC地址注册，30天试用期 |
| 授权码激活 | 使用购买获得的授权码激活 |
| 状态查询 | 检查安装/激活状态和剩余天数 |

#### 1.5 其他
| 功能 | 说明 |
|------|------|
| 邮件订阅 | 订阅产品更新和优惠信息 |
| FAQ | 常见问题解答 |
| 技术支持 | 提交工单获取帮助 |
| 数据遥测 | 客户端上报使用数据（可选） |

---

### 2. 管理后台功能

#### 2.1 系统概览
- 数据统计仪表盘
- 今日/本周/本月数据概览
- 快速操作入口

#### 2.2 产品管理
- 产品列表与编辑
- 添加/删除产品
- 设置价格方案
- 上传产品图片
- 管理下载链接

#### 2.3 订单管理
- 查看所有订单
- 订单状态管理
- 生成/补发激活码
- 订单统计报表

#### 2.4 激活管理
- 激活记录列表
- 续期管理
- 批量操作

#### 2.5 安装管理
- 安装记录列表
- 试用期监控
- 设备MAC管理

#### 2.6 用户管理
- 用户列表
- 用户详情查看
- 禁用/启用用户

#### 2.7 系统日志
| 日志类型 | 说明 |
|------|------|
| 登录日志 | 用户登录记录 |
| 操作日志 | 后台操作记录 |
| 注册日志 | 软件注册记录 |
| 激活日志 | 软件激活记录 |

#### 2.8 系统设置
| 设置项 | 说明 |
|------|------|
| 网站设置 | 公司名称、Logo、SEO |
| 数据库设置 | 数据库连接配置 |
| 安全设置 | IP限流、防爬配置 |
| 邮件设置 | SMTP服务器配置 |
| AI设置 | AI功能配置 |
| SSL设置 | HTTPS证书管理 |
| Banner管理 | 首页轮播图管理 |

#### 2.9 其他功能
- 邮件订阅管理
- 邮件群发
- CardDAV配置
- 技术支持工单管理
- FAQ管理

---

### 3. API 接口

#### 3.1 认证相关
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/user/register` | 用户注册 |
| POST | `/api/user/login` | 用户登录 |
| POST | `/api/user/logout` | 用户登出 |
| POST | `/api/user/forgot-password` | 忘记密码 |
| GET | `/api/user/profile` | 获取用户资料 |
| PUT | `/api/user/profile` | 更新用户资料 |

#### 3.2 产品相关
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/products` | 获取产品列表 |
| GET | `/api/products/:id` | 获取产品详情 |
| POST | `/api/products` | 添加产品（管理员） |
| PUT | `/api/products/:id` | 更新产品（管理员） |
| DELETE | `/api/products/:id` | 删除产品（管理员） |

#### 3.3 订单相关
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/orders` | 创建订单 |
| GET | `/api/orders` | 获取用户订单 |
| GET | `/api/orders/:id` | 获取订单详情 |
| POST | `/api/orders/:id/verify` | 验证支付 |
| POST | `/api/orders/:id/generate-activation-codes` | 生成激活码 |

#### 3.4 激活相关
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/install` | 试用注册 |
| POST | `/api/install/check` | 检查安装状态 |
| POST | `/api/activate` | 软件激活 |
| POST | `/api/activate-by-code` | 授权码激活 |
| GET | `/api/activations` | 获取激活记录（管理员） |

#### 3.5 设置相关
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/settings` | 获取设置 |
| PUT | `/api/settings` | 更新设置（管理员） |
| GET | `/api/carddav` | 获取CardDAV配置 |
| PUT | `/api/carddav` | 更新CardDAV配置 |

#### 3.6 日志相关
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/logs/login` | 登录日志 |
| GET | `/api/logs/operation` | 操作日志 |
| GET | `/api/logs/registration` | 注册日志 |
| GET | `/api/logs/activation` | 激活日志 |

#### 3.7 其他
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/captcha` | 获取验证码 |
| POST | `/api/subscribe` | 邮件订阅 |
| POST | `/api/telemetry` | 提交遥测数据 |
| GET | `/api/telemetry/stats` | 遥测统计（管理员） |

---

### 4. 客户端激活逻辑

#### 4.1 试用注册流程
```
客户端首次运行 → POST /api/install
├── macAddress: MAC地址
├── softwareName: 软件名称
├── userEmail: 用户邮箱（可选）
└── installDate: 安装日期

服务端:
1. 检查MAC是否已注册该软件
2. 创建installations记录（30天试用期）
3. 返回: registrationDate, expireDate, remainingDays
```

#### 4.2 授权码激活流程
```
客户端激活 → POST /api/activate-by-code
├── serial/activationCode: 授权码
├── macAddress: MAC地址
├── userEmail: 用户邮箱
└── activateDate: 激活日期

服务端:
1. 查找持有该授权码的已支付订单
2. 检查授权码是否已被使用
3. 检查MAC是否已激活同款软件
4. 计算过期日期（购买时长）
5. 创建installations/activations记录
6. 标记授权码为已使用
7. 返回: success, expireDate, isRenewal
```

---

### 5. 数据库表结构

#### 用户相关
- `users` - 用户表
- `login_logs` - 登录日志

#### 产品相关
- `products` - 产品表

#### 订单相关
- `orders` - 订单表
- `verification_codes` - 验证码表
- `used_activation_codes` - 已用激活码表

#### 激活相关
- `activations` - 激活记录表
- `installations` - 安装记录表

#### 系统相关
- `settings` - 系统设置
- `operation_logs` - 操作日志
- `registration_logs` - 注册日志
- `activation_logs` - 激活日志
- `subscribers` - 邮件订阅
- `telemetry` - 遥测数据
- `faqs` - FAQ
- `support_tickets` - 技术支持工单

---

### 6. 配置文件

数据库配置文件: `data/db-config.json`

```json
{
  "type": "mysql",
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "user": "root",
    "password": "",
    "database": "booming"
  }
}
```

---

### 7. 主题系统

支持9套主题：minimal, soft, glass, bento, dark, warm, cyber, editorial, liquid

切换方式：管理后台 → 系统设置 → 主题选择

---

## 快速开始

```bash
# 安装依赖
npm install

# 配置数据库
# 编辑 data/db-config.json

# 启动服务器
node server.js

# 访问网站
http://localhost:3000
```

## 目录结构

```
MywebServer/
├── server.js           # Express 服务器
├── db.js               # 数据库操作
├── package.json        # 依赖配置
├── data/               # 数据目录
│   └── db-config.json  # 数据库配置
├── public/             # 前端文件
│   ├── index.html      # 首页
│   ├── admin/          # 管理后台
│   ├── css/            # 样式文件
│   └── js/             # 脚本文件
└── docs/               # 文档目录
```

## License

MIT