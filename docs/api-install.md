# 安装注册 API 文档

## 基础信息

- **基础URL**: `http://your-domain.com` (HTTP端口) 或 `https://your-domain.com` (HTTPS，由Nginx提供)
- **字符编码**: UTF-8
- **Content-Type**: `application/json`

---

## 1. 提交安装注册

软件客户端首次运行时调用此接口完成注册。

### 请求

```
POST /api/install
Content-Type: application/json
```

### 参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| softwareName | string | 是 | 软件名称 |
| softwareVersion | string | 否 | 软件版本号 |
| userName | string | 是 | 用户姓名 |
| userEmail | string | 是 | 用户邮箱 |
| organization | string | 否 | 个人/公司名称 |

### 请求示例

```json
{
  "softwareName": "博铭邮件管理百宝箱",
  "softwareVersion": "2.1.0",
  "userName": "张三",
  "userEmail": "zhangsan@example.com",
  "organization": "某某科技有限公司"
}
```

### 响应

**成功 (200)**
```json
{
  "success": true,
  "installation": {
    "id": 1,
    "softwareName": "博铭邮件管理百宝箱",
    "softwareVersion": "2.1.0",
    "userName": "张三",
    "userEmail": "zhangsan@example.com",
    "organization": "某某科技有限公司",
    "installDate": "2026-03-30",
    "expireDate": "2026-04-29",
    "remainingDays": 30
  }
}
```

**失败 (400)**
```json
{
  "success": false,
  "error": "请填写必填字段"
}
```

---

## 2. 查询注册状态

软件运行时调用此接口验证注册是否有效。

### 请求

```
POST /api/install/check
Content-Type: application/json
```

### 参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| softwareName | string | 是 | 软件名称 |
| userEmail | string | 是 | 注册时填写的邮箱 |

### 请求示例

```json
{
  "softwareName": "博铭邮件管理百宝箱",
  "userEmail": "zhangsan@example.com"
}
```

### 响应

**已注册且有效**
```json
{
  "registered": true,
  "expired": false,
  "remainingDays": 25,
  "installation": {
    "id": 1,
    "softwareName": "博铭邮件管理百宝箱",
    "installDate": "2026-03-05",
    "expireDate": "2026-04-04"
  }
}
```

**已注册但过期**
```json
{
  "registered": true,
  "expired": true,
  "remainingDays": 0,
  "installation": {
    "id": 1,
    "softwareName": "博铭邮件管理百宝箱",
    "installDate": "2026-02-01",
    "expireDate": "2026-03-02"
  }
}
```

**未找到注册记录**
```json
{
  "registered": false,
  "expired": false,
  "remainingDays": 0,
  "installation": null
}
```

---

## 3. 获取安装记录列表（管理后台）

获取所有安装记录，仅管理员可访问。

### 请求

```
GET /api/installs
Cookie: connect.sid=xxx
```

### 响应

**成功 (200)**
```json
[
  {
    "id": 1,
    "software_name": "博铭邮件管理百宝箱",
    "software_version": "2.1.0",
    "user_name": "张三",
    "user_email": "zhangsan@example.com",
    "organization": "某某科技有限公司",
    "install_date": "2026-03-30",
    "expire_date": "2026-04-29",
    "remainingDays": 30,
    "created_at": "2026-03-30T10:00:00.000Z"
  }
]
```

**未授权 (401)**
```json
{
  "error": "请先登录"
}
```

---

## 软件客户端集成示例

### JavaScript

```javascript
async function registerSoftware() {
  const response = await fetch('/api/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      softwareName: '博铭邮件管理百宝箱',
      softwareVersion: '2.1.0',
      userName: '张三',
      userEmail: 'zhangsan@example.com',
      organization: '某某科技有限公司'
    })
  });
  const data = await response.json();
  if (data.success) {
    console.log('注册成功，剩余天数:', data.installation.remainingDays);
  }
}

async function checkRegistration() {
  const response = await fetch('/api/install/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      softwareName: '博铭邮件管理百宝箱',
      userEmail: 'zhangsan@example.com'
    })
  });
  const data = await response.json();
  if (data.registered && !data.expired) {
    console.log('注册有效，剩余天数:', data.remainingDays);
  } else {
    console.log('注册无效或已过期');
  }
}
```

### Python

```python
import requests
import json

def register_software():
    response = requests.post(
        'http://your-domain.com/api/install',
        headers={'Content-Type': 'application/json'},
        json={
            'softwareName': '博铭邮件管理百宝箱',
            'softwareVersion': '2.1.0',
            'userName': '张三',
            'userEmail': 'zhangsan@example.com',
            'organization': '某某科技有限公司'
        }
    )
    data = response.json()
    if data.get('success'):
        print(f"注册成功，剩余天数: {data['installation']['remainingDays']}")

def check_registration():
    response = requests.post(
        'http://your-domain.com/api/install/check',
        headers={'Content-Type': 'application/json'},
        json={
            'softwareName': '博铭邮件管理百宝箱',
            'userEmail': 'zhangsan@example.com'
        }
    )
    data = response.json()
    if data['registered'] and not data['expired']:
        print(f"注册有效，剩余天数: {data['remainingDays']}")
    else:
        print("注册无效或已过期")
```

---

## 错误码

| HTTP状态码 | 说明 |
|------------|------|
| 200 | 请求成功 |
| 400 | 请求参数错误 |
| 401 | 未授权（仅管理接口） |
| 500 | 服务器内部错误 |
