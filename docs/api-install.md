# 软件安装与激活 API

## 目录

1. [试用注册接口](#1-试用注册接口-post-apiinstall)
2. [安装状态检查接口](#2-安装状态检查接口-post-apiinstallcheck)
3. [授权码激活接口](#3-授权码激活接口-post-apiactivate-by-code)

---

## 1. 试用注册接口 (POST /api/install)

客户端首次运行软件时调用此接口进行注册。

### 请求头

```
Content-Type: application/json
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| softwareName | string | 是 | 软件名称 |
| softwareVersion | string | 否 | 软件版本 |
| userName | string | 是 | 用户名称 |
| userEmail | string | 是 | 用户邮箱 |
| organization | string | 否 | 组织/公司名称 |
| macAddress | string | 否 | MAC地址 |

### 请求示例

```json
{
  "softwareName": "小铭邮件百宝箱",
  "softwareVersion": "1.0.0",
  "userName": "张三",
  "userEmail": "zhangsan@example.com",
  "organization": "博铭科技",
  "macAddress": "00-9B-08-43-A2-C9"
}
```

### 成功响应 (201 Created)

```json
{
  "success": true,
  "installation": {
    "id": 123,
    "softwareName": "小铭邮件百宝箱",
    "installDate": "2026-05-03",
    "expireDate": "2026-06-02",
    "remainingDays": 30
  }
}
```

### 错误响应

**已注册该软件 (400 Bad Request)**
```json
{
  "error": "该软件已注册",
  "installation": {
    "id": 123,
    "softwareName": "小铭邮件百宝箱",
    "installDate": "2026-05-03",
    "expireDate": "2026-06-02",
    "remainingDays": 15
  },
  "remainingDays": 15
}
```

**MAC地址已激活 (400 Bad Request)**
```json
{
  "error": "该MAC地址已激活此软件，如需续期请联系管理员",
  "installation": {
    "id": 122,
    "softwareName": "小铭邮件百宝箱",
    "macAddress": "00-9B-08-43-A2-C9",
    "installDate": "2026-04-01",
    "expireDate": "2026-05-01",
    "remainingDays": 0
  }
}
```

**缺少必填字段 (400 Bad Request)**
```json
{
  "error": "请填写必填字段"
}
```

---

## 2. 安装状态检查接口 (POST /api/install/check)

客户端定期调用此接口检查安装状态和激活状态。

### 请求头

```
Content-Type: application/json
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| softwareName | string | 是 | 软件名称 |
| userEmail | string | 否 | 用户邮箱（与MAC二选一） |
| macAddress | string | 否 | MAC地址（与邮箱二选一） |
| activationKey | string | 否 | 激活码（如果有） |

### 请求示例

```json
{
  "softwareName": "小铭邮件百宝箱",
  "userEmail": "zhangsan@example.com",
  "macAddress": "00-9B-08-43-A2-C9",
  "activationKey": "XCZ2N-DVGJX-48XSZ-4PVAY-F5WGL"
}
```

### 成功响应 (200 OK)

**情况1：已激活（授权激活）**
```json
{
  "registered": true,
  "activated": true,
  "expired": false,
  "activationExpired": false,
  "message": "已激活（永久授权）",
  "installation": {
    "softwareName": "xiaozhi-crm",
    "userEmail": "raymond.xu@booming.one",
    "macAddress": "BB:40:58:16:46:22",
    "installDate": "2026-05-03",
    "expireDate": "2027-05-03",
    "remainingDays": 365
  },
  "activation": {
    "activationKey": "XCZ2N-DVGJX-48XSZ-4PVAY-F5WGL",
    "activateDate": "2026-05-03",
    "expireDate": "2027-05-03",
    "status": "active"
  }
}
```

**情况2：已注册但未激活（试用期）**
```json
{
  "registered": true,
  "activated": false,
  "expired": false,
  "activationExpired": null,
  "message": "试用期（剩余28天）",
  "installation": {
    "softwareName": "xiaozhi-crm",
    "userEmail": "raymond.xu@booming.one",
    "macAddress": "BB:40:58:16:46:22",
    "installDate": "2026-04-01",
    "expireDate": "2026-05-01",
    "remainingDays": 28
  },
  "activation": null
}
```

**情况3：试用期已过期**
```json
{
  "registered": true,
  "activated": false,
  "expired": true,
  "activationExpired": null,
  "message": "试用期已过期，请激活",
  "installation": {
    "softwareName": "xiaozhi-crm",
    "userEmail": "raymond.xu@booming.one",
    "macAddress": "BB:40:58:16:46:22",
    "installDate": "2026-03-01",
    "expireDate": "2026-03-31",
    "remainingDays": 0
  },
  "activation": null
}
```

**情况4：已激活但已过期**
```json
{
  "registered": true,
  "activated": true,
  "expired": true,
  "activationExpired": true,
  "message": "已激活但已过期",
  "installation": {
    "softwareName": "xiaozhi-crm",
    "userEmail": "raymond.xu@booming.one",
    "macAddress": "BB:40:58:16:46:22",
    "installDate": "2025-05-03",
    "expireDate": "2026-05-03",
    "remainingDays": 0
  },
  "activation": {
    "activationKey": "XCZ2N-DVGJX-48XSZ-4PVAY-F5WGL",
    "activateDate": "2025-05-03",
    "expireDate": "2026-05-03",
    "status": "active"
  }
}
```

**情况5：未注册**
```json
{
  "registered": false,
  "activated": false,
  "expired": false,
  "activationExpired": null,
  "message": "MAC地址未注册",
  "installation": null,
  "activation": null
}
```

**带激活码查询（授权码有效可激活）**
```json
{
  "registered": false,
  "activated": false,
  "expired": false,
  "activationExpired": null,
  "message": "授权码有效，可激活",
  "order": {
    "softwareName": "xiaozhi-crm",
    "duration": "一年授权",
    "totalDays": 365,
    "paidDate": "2026-05-03T10:00:00.000Z",
    "expireDate": "2027-05-03T10:00:00.000Z",
    "remainingDays": 365
  }
}
```

### 错误响应

**找不到安装记录 (404 Not Found)**
```json
{
  "error": "找不到安装记录"
}
```

**授权码已使用 (400 Bad Request)**
```json
{
  "registered": true,
  "expired": false,
  "activated": true,
  "activatedExpired": false,
  "message": "已激活"
}
```

---

## 3. 授权码激活接口 (POST /api/activate-by-code)

客户端使用购买获得的授权码进行激活。

### 请求头

```
Content-Type: application/json
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| serial | string | 否 | 授权码（与activationCode二选一） |
| activationCode | string | 否 | 授权码（与serial二选一） |
| macAddress | string | 是 | MAC地址 |
| userName | string | 否 | 用户名称 |
| userEmail | string | 否 | 用户邮箱 |
| activateDate | string | 否 | 激活日期（客户端首次运行日期） |

### 请求示例

```json
{
  "serial": "XCZ2N-DVGJX-48XSZ-4PVAY-F5WGL",
  "macAddress": "00-9B-08-43-A2-C9",
  "userEmail": "zhangsan@example.com",
  "userName": "张三",
  "activateDate": "2026-05-03"
}
```

### 成功响应 (200 OK)

**首次激活成功**
```json
{
  "success": true,
  "message": "激活成功",
  "softwareName": "小铭邮件百宝箱",
  "duration": "一年授权",
  "totalDays": 365,
  "registrationDate": "2026-05-03T10:30:00.000Z",
  "activateDate": "2026-05-03T10:30:00.000Z",
  "expireDate": "2027-05-03T10:30:00.000Z",
  "isRenewal": false
}
```

**续期成功**
```json
{
  "success": true,
  "message": "续期成功",
  "softwareName": "小铭邮件百宝箱",
  "duration": "一年授权",
  "totalDays": 365,
  "registrationDate": "2026-05-03T10:30:00.000Z",
  "activateDate": "2026-05-03T10:30:00.000Z",
  "expireDate": "2028-05-03T10:30:00.000Z",
  "isRenewal": true
}
```

### 错误响应

**缺少授权码 (400 Bad Request)**
```json
{
  "error": "请输入授权码"
}
```

**授权码无效或订单未支付 (404 Not Found)**
```json
{
  "error": "授权码无效或订单未支付"
}
```

**授权码已被使用 (400 Bad Request)**
```json
{
  "error": "该授权码已被使用"
}
```

**MAC地址已激活此软件 (400 Bad Request)**
```json
{
  "error": "该MAC地址已激活此软件，如需续期请联系管理员",
  "existingActivation": {
    "id": 123,
    "softwareName": "小铭邮件百宝箱",
    "macAddress": "00-9B-08-43-A2-C9",
    "activateDate": "2026-04-01",
    "expireDate": "2026-05-01"
  }
}
```

---

## 客户端集成指南

### 首次运行流程

```
1. 软件启动
2. 读取注册表中的安装日期 (installDate)
3. 调用 POST /api/install 进行试用注册
4. 如果返回成功，保存 installation 信息
5. 定期调用 POST /api/install/check 检查状态
```

### 激活流程

```
1. 用户输入授权码
2. 软件调用 POST /api/activate-by-code
3. 传入: serial, macAddress, userEmail, activateDate
4. 成功则保存激活信息到注册表
5. 显示激活成功和到期日期
```

### 定期检查流程

```
1. 软件启动时调用 POST /api/install/check
2. 传入: softwareName, macAddress, activationKey（如有）
3. 根据返回的 registered/activated/expired 状态
   - 未注册: 提示用户注册
   - 已过期: 提示用户续期
   - 已激活: 正常启动
```

---

## 激活期限计算规则

| 授权类型 | 期限 |
|------|------|
| 试用注册 | 固定30天 |
| 一个月授权 | 30天 |
| 三个月授权 | 90天 |
| 半年授权 | 180天 |
| 一年授权 | 365天 |
| 两年授权 | 730天 |
| 永久授权 | 36500天（100年） |

### 续期规则

如果用户已有激活记录，续期时：
- 从当前到期日开始计算新的到期日
- 如果当前已过期，从今天开始计算

---

## 错误码

| HTTP状态码 | 说明 |
|------------|------|
| 200 | 请求成功 |
| 201 | 创建成功（试用注册） |
| 400 | 请求参数错误 |
| 404 | 找不到资源 |
| 500 | 服务器内部错误 |