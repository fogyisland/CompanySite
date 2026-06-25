# 博铭科技 网站部署指南（Nginx 反向代理版）

## 架构总览

```
[ 客户端 ] → [ Nginx :80/443 ] → [ Node.js :127.0.0.1:15000 ] → [ MySQL :3306 ]
              SSL 终止            Express + Session                远程/本地
              gzip 压缩           trust proxy = 'loopback'
              静态缓存            bind 127.0.0.1(无公网暴露)
              HSTS / 安全头
```

**关键点**：
- **Node.js 只绑 127.0.0.1**，公网无法绕过 Nginx 直连（安全）
- **`trust proxy = 'loopback'`**，只信任 127.0.0.1 传来的 `X-Forwarded-For`，攻击者伪造 XFF 头无效
- **静态资源 7d immutable**（带文件 hash 或 cache-bust `?v=` 时间戳的 JS/CSS 永久缓存）
- **/uploads/ 7d**（用户上传的文档/图片）
- **/api/ 与 / 走 Node.js**（无 WebSocket，不需要 `Upgrade` 头）

---

## 环境要求

- **操作系统**: Ubuntu 20.04+ / Debian 11+ / CentOS 8+
- **Node.js**: 18.x 或 20.x（推荐 20 LTS）
- **Nginx**: 1.18+
- **MySQL**: 5.7+ / 8.0（远程或本机）
- **SSL 证书**: Let's Encrypt（强烈推荐）
- **进程管理**: PM2

---

## 第一步：服务器准备

### 1.1 更新系统
```bash
# Ubuntu / Debian
sudo apt update && sudo apt upgrade -y

# CentOS
sudo yum update -y
```

### 1.2 安装 Node.js 20.x
```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# CentOS
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# 验证
node -v   # v20.x.x
npm -v
```

### 1.3 安装 Nginx
```bash
# Ubuntu / Debian
sudo apt install -y nginx

# CentOS
sudo yum install -y nginx
```

### 1.4 安装 PM2
```bash
sudo npm install -g pm2
```

### 1.5 安装 Certbot（Let's Encrypt）
```bash
# Ubuntu / Debian
sudo apt install -y certbot python3-certbot-nginx

# CentOS
sudo yum install -y certbot python3-certbot-nginx
```

---

## 第二步：创建系统用户与目录

**重要**：用独立用户 `booming` 运行 Node.js，**不要用 root**（PM2 启动后会自动降权）。

```bash
# 创建用户(无登录 shell,仅运行服务)
sudo useradd -r -s /usr/sbin/nologin -m -d /var/www/booming booming

# 或用 /home/booming(按你的部署偏好)
# sudo useradd -r -s /usr/sbin/nologin -m -d /home/booming booming
```

> 路径说明：本指南以 `/var/www/booming` 为例，统一替换为你实际的部署路径。

---

## 第三步：上传项目代码

### 3.1 克隆 / 上传代码
```bash
sudo -u booming git clone <your-repo-url> /var/www/booming
# 或 scp/sftp 上传
```

### 3.2 设置目录权限
```bash
sudo chown -R booming:booming /var/www/booming
sudo chmod -R 755 /var/www/booming

# data / logs / uploads 目录 Node.js 需要写权限
sudo chmod -R 775 /var/www/booming/data
sudo chmod -R 775 /var/www/booming/logs
sudo chmod -R 775 /var/www/booming/public/uploads
```

---

## 第四步：安装依赖

```bash
cd /var/www/booming
sudo -u booming npm install --production
```

> 切勿用 root 跑 `npm install`（生成的 node_modules 属主为 root，运行时会权限错误）。

---

## 第五步：配置 .env（密钥）

**`server.js` 启动时 fail-closed** — 未设置 `SESSION_SECRET` / `CRON_TOKEN` 或命中已知占位值会 `process.exit(1)`。密钥轮换详见 [`docs/secrets-rotation.md`](docs/secrets-rotation.md)。

### 5.1 复制模板
```bash
cd /var/www/booming
sudo -u booming cp .env.example .env
sudo chmod 600 .env
```

### 5.2 生成密钥并填入
```bash
# 生成 SESSION_SECRET (48 字节 base64)
sudo -u booming nano .env
```

`.env` 关键变量：
```bash
PORT=15000
SESSION_SECRET=<生成>  # node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
CRON_TOKEN=<生成>      # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
PAYPAL_WEBHOOK_ID=<从 PayPal Dashboard 复制>
DB_HOST=<MySQL 主机>
DB_PORT=3306
DB_USER=booming
DB_PASSWORD=<强密码>
DB_NAME=booming
```

### 5.3 限制 .env 权限
```bash
sudo chmod 600 /var/www/booming/.env
sudo chown booming:booming /var/www/booming/.env

# 验证启动校验
sudo -u booming node -e "require('./server.js')" 2>&1 | head -20
# 期望看到: "Database initialized" + "HTTP Server running at http://127.0.0.1:15000 (behind nginx)"
# 若看到 "FATAL: SESSION_SECRET" → 检查 .env 是否填了真随机值
```

---

## 第六步：配置 MySQL

```bash
sudo mysql -u root -p
```

```sql
CREATE DATABASE booming CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'booming'@'localhost' IDENTIFIED BY '<your-strong-password>';
GRANT ALL PRIVILEGES ON booming.* TO 'booming'@'localhost';

-- 若 MySQL 在远程主机
-- CREATE USER 'booming'@'<app-server-ip>' IDENTIFIED BY '<your-strong-password>';
-- GRANT ALL PRIVILEGES ON booming.* TO 'booming'@'<app-server-ip>';

FLUSH PRIVILEGES;
EXIT;
```

测试连接：
```bash
mysql -h 127.0.0.1 -u booming -p<your-strong-password> booming -e "SHOW TABLES;"
```

---

## 第七步：配置 Nginx

### 7.1 创建配置文件
```bash
sudo nano /etc/nginx/sites-available/booming
```

### 7.2 完整配置（HTTP → HTTPS + 完整安全头 + gzip + 7d 缓存）

```nginx
# ===== HTTP → HTTPS 重定向 =====
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.com www.your-domain.com;

    # Let's Encrypt 验证需要(申请证书前保留)
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/booming/public;
        default_type "text/plain";
    }

    # 其他全部 301 到 HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# ===== HTTPS 主站 =====
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.com www.your-domain.com;

    # ----- SSL 证书(Let's Encrypt 路径) -----
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # ----- HSTS(强制 HTTPS 1 年,包含子域名) -----
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # ----- 其他安全头 -----
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # ----- gzip 压缩 -----
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types
        text/plain
        text/css
        text/javascript
        text/xml
        application/javascript
        application/json
        application/xml
        application/xml+rss
        image/svg+xml;

    # ----- 日志 -----
    access_log /var/log/nginx/booming_access.log;
    error_log /var/log/nginx/booming_error.log;

    # ----- 客户端请求体上限(用户上传文档/头像) -----
    client_max_body_size 20M;

    # ===== 静态资源(7d immutable) =====
    # 含文件 hash 或 cache-bust ?v= 的 JS/CSS/图片/字体 → 浏览器永久缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
        access_log off;  # 静态资源不记日志,减小日志体积
    }

    # ===== 用户上传(7d,不可变) =====
    location /uploads/ {
        alias /var/www/booming/public/uploads/;
        expires 7d;
        add_header Cache-Control "public";
        access_log off;

        # 禁止在 uploads 跑 PHP(就算以后被植入也无后门)
        location ~* \.php$ { deny all; }
    }

    # ===== API 代理(无缓存) =====
    location /api/ {
        proxy_pass http://127.0.0.1:15000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        # 超时(防止慢请求占连接)
        proxy_connect_timeout 30s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # 禁用缓冲(API 响应小,实时返回)
        proxy_buffering off;
    }

    # ===== 主站(无 WebSocket,不需要 Upgrade 头) =====
    location / {
        proxy_pass http://127.0.0.1:15000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        proxy_connect_timeout 30s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

### 7.3 启用站点
```bash
sudo ln -s /etc/nginx/sites-available/booming /etc/nginx/sites-enabled/
sudo nginx -t           # 必须 syntax OK / test is successful
sudo systemctl reload nginx
```

---

## 第八步：申请 Let's Encrypt SSL 证书

```bash
# 临时把 HTTP server 的 return 301 注释掉,certbot 才能验证
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
# 按提示输入邮箱、同意条款;选 2 (Redirect) 自动加 HTTPS 重定向

# 自动续期测试
sudo certbot renew --dry-run

# 续期 cron(Let's Encrypt 包自带)
echo "0 0,12 * * * root /usr/bin/certbot renew --quiet" | sudo tee /etc/cron.d/certbot-renew
```

---

## 第九步：启动 Node.js（PM2）

### 9.1 启动应用
```bash
cd /var/www/booming
sudo -u booming pm2 start server.js --name booming
```

> 端口由 `.env` 里的 `PORT` 决定（默认 15000），不需要在 PM2 命令行覆盖。
> server.js 内部已硬绑 `127.0.0.1`，PM2 的 `--node-args` / host env 都不用管。

### 9.2 配置开机自启
```bash
sudo -u booming pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u booming --hp /var/www/booming
# 输出会提示执行一条命令,以 root 跑一次即可
```

### 9.3 验证启动
```bash
sudo -u booming pm2 status
sudo -u booming pm2 logs booming --lines 50
```

期望看到：
```
Database initialized
HTTP Server running at http://127.0.0.1:15000 (behind nginx)
```

### 9.4 PM2 常用命令
```bash
# 查看
pm2 status
pm2 logs booming
pm2 monit

# 重启
pm2 restart booming

# 滚动重载(零停机)
pm2 reload booming

# 停止
pm2 stop booming
```

---

## 第十步：配置防火墙

```bash
# Ubuntu (ufw)
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP
sudo ufw allow 443/tcp     # HTTPS
sudo ufw enable

# CentOS (firewalld)
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

> **不要开放 15000 端口**！Node.js 只绑 127.0.0.1，公网无法访问。开放 15000 等于绕过 Nginx 全部安全层（SSL 终止、gzip、HSTS）。

---

## 第十一步：配置日志轮转

PM2 自带日志管理：
```bash
pm2 install pm2-logrotate
sudo -u booming pm2 set pm2-logrotate:max_size 50M
sudo -u booming pm2 set pm2-logrotate:retain 14
sudo -u booming pm2 set pm2-logrotate:compress true
```

Nginx 日志（logrotate 默认已配 14 天）。

---

## 目录结构（生产部署）

```
/var/www/booming/
├── server.js                # Express 入口(绑 127.0.0.1:15000)
├── db.js                    # 数据库模块
├── prisma/
│   ├── schema.js            # 表结构定义
│   └── migrations/          # 迁移脚本
├── package.json
├── .env                     # 密钥(mode 600,仅 booming 可读)
├── .env.example             # 模板(已入库)
├── data/                    # 运行时数据(mysqldump 备份目录)
├── logs/                    # PM2 日志
├── public/                  # 静态资源
│   ├── index.html
│   ├── about.html
│   ├── product/             # 产品列表页
│   ├── news.html
│   ├── admin/               # 管理后台
│   ├── css/
│   ├── js/
│   ├── vendor/              # 本地化的第三方库
│   └── uploads/             # 用户上传(产品图、文档)
└── docs/                    # 项目文档
    ├── DEPLOY.md            # 本文件
    └── secrets-rotation.md  # 密钥轮换 runbook
```

---

## 故障排除

### 502 Bad Gateway

```bash
# 1. Node.js 是否在跑
sudo -u booming pm2 status

# 2. 端口是否监听 loopback
sudo ss -tlnp | grep 15000
# 应输出: 127.0.0.1:15000(不是 0.0.0.0:15000)

# 3. Nginx 配置语法
sudo nginx -t

# 4. Nginx 错误日志
sudo tail -f /var/log/nginx/booming_error.log
```

### 启动报 FATAL: SESSION_SECRET

`.env` 未设置或用了占位值。详见 `docs/secrets-rotation.md` 第 5 节。

### 限流把整公司 IP 误封

```bash
# 登录管理后台 → 安全设置 → IP 黑名单 → 解封
# 或 SQL:
mysql -u booming -p booming -e "DELETE FROM ip_blacklist WHERE ip = '1.2.3.4';"
```

### 静态资源不更新

JS / CSS 改完后浏览器还在用旧版？
- 确认文件带了 `?v=20260624-xxxx` cache-bust 参数
- 或文件内容里有 hash（webpack-style）
- 强制刷新：`Ctrl+Shift+R`（或 DevTools → Network → Disable cache）

### 备份与恢复

```bash
# 数据库备份(mysqldump 走 .env 凭据,不暴露命令行)
cd /var/www/booming
sudo -u booming bash -c 'source .env && mysqldump --defaults-file=/dev/stdin booming' \
  <<< "[client]
user=$DB_USER
password=$DB_PASSWORD
host=$DB_HOST" > backups/booming-$(date +%Y%m%d-%H%M%S).sql

# 完整代码 + 数据库备份
sudo tar -czf /backup/booming-full-$(date +%Y%m%d).tar.gz \
  --exclude='node_modules' \
  --exclude='logs/*.log' \
  /var/www/booming
```

详见 [`docs/backup-restore.md`](docs/backup-restore.md)（如有）。

---

## 更新部署

```bash
cd /var/www/booming
sudo -u booming git pull
sudo -u booming npm install --production  # 仅当 package.json 变了
sudo -u booming pm2 reload booming        # 零停机重载
```

如果改了 `.env.example`（新变量）：
```bash
sudo -u booming diff .env .env.example   # 看新加的变量
sudo -u booming nano .env                # 手动同步
sudo -u booming pm2 reload booming
```

---

## 安全检查清单

部署后逐项验证：

- [ ] `ss -tlnp | grep 15000` → 仅 `127.0.0.1:15000`，不是 `0.0.0.0:15000`
- [ ] 防火墙未开放 15000
- [ ] `curl http://your-domain.com` → 301 跳到 HTTPS
- [ ] `curl -I https://your-domain.com` → 包含 `Strict-Transport-Security` 头
- [ ] 浏览器 DevTools → Network → 静态资源 → 响应头 `Cache-Control: public, immutable`
- [ ] `.env` 权限 `600`、属主 `booming`
- [ ] `git ls-files .env` → 空
- [ ] Node.js 进程以 `booming` 用户运行（`ps aux | grep node`）
- [ ] PM2 日志无 `FATAL: SESSION_SECRET` 等启动错误
