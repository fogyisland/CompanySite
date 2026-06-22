# 博铭科技 网站部署指南

## 环境要求

- **操作系统**: Ubuntu 20.04+ / Debian 10+
- **Node.js**: 18.x 或 20.x
- **Nginx**: 1.18+
- **SSL证书**: 可选（Let's Encrypt 免费证书）

---

## 第一步：服务器准备

### 1.1 更新系统
```bash
sudo apt update && sudo apt upgrade -y
```

### 1.2 安装Node.js
```bash
# 安装Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证安装
node -v  # 应显示 v20.x.x
npm -v
```

### 1.3 安装Nginx
```bash
sudo apt install -y nginx
```

### 1.4 安装SSL工具（可选）
```bash
sudo apt install -y certbot python3-certbot-nginx
```

---

## 第二步：创建目录并上传代码

### 2.1 创建项目目录
```bash
sudo mkdir -p /var/www/booming
cd /var/www/booming
```

### 2.2 上传项目文件
通过以下方式之一上传代码：
- **Git**: `git clone <your-repo> /var/www/booming`
- **SCP**: `scp -r ./booming user@server:/var/www/`
- **SFTP**: 使用FileZilla等工具上传

### 2.3 设置目录权限
```bash
sudo chown -R www-data:www-data /var/www/booming
sudo chmod -R 755 /var/www/booming
```

---

## 第三步：安装依赖

```bash
cd /var/www/booming
npm install --production
```

---

## 第四步：配置Nginx

### 4.1 创建Nginx配置文件
```bash
sudo nano /etc/nginx/sites-available/booming
```

### 4.2 写入配置（HTTP + HTTPS）
```nginx
# HTTP 重定向到 HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

# HTTPS 配置
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL证书路径（请修改为实际路径）
    ssl_certificate /etc/nginx/ssl/certificate.crt;
    ssl_certificate_key /etc/nginx/ssl/private.key;

    # SSL配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    # 网站根目录
    root /var/www/booming/public;
    index index.html;

    # 访问日志
    access_log /var/log/nginx/booming_access.log;
    error_log /var/log/nginx/booming_error.log;

    # 静态资源缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # API代理
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 上传文件代理
    location /uploads/ {
        alias /var/www/booming/public/uploads/;
        expires 7d;
    }

    # Node.js应用代理
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 4.3 启用站点
```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/booming /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载Nginx
sudo systemctl reload nginx
```

---

## 第五步：配置SSL证书（Let's Encrypt）

```bash
# 申请证书（需要域名已解析）
sudo certbot --nginx -d your-domain.com

# 自动续期测试
sudo certbot renew --dry-run
```

---

## 第六步：使用PM2运行Node.js

### 6.1 安装PM2
```bash
sudo npm install -g pm2
```

### 6.2 启动应用
```bash
cd /var/www/booming
pm2 start server.js --name booming
```

### 6.3 配置开机自启
```bash
pm2 save
pm2 startup
```

### 6.4 PM2常用命令
```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs booming

# 重启应用
pm2 restart booming

# 停止应用
pm2 stop booming

# 监控资源
pm2 monit
```

---

## 第七步：配置防火墙

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp     # HTTP
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable
sudo ufw status
```

---

## 第八步：配置日志目录

```bash
# 创建日志目录
sudo mkdir -p /var/www/booming/logs
sudo chown -R www-data:www-data /var/www/booming/logs
```

---

## 目录结构

```
/var/www/booming/
├── server.js           # Node.js 主程序
├── package.json        # 依赖配置
├── db.js              # 数据库模块
├── public/            # 前端文件
│   ├── index.html
│   ├── about.html
│   ├── admin.html
│   ├── uploads/      # 上传文件
│   └── ...
├── data/             # SQLite数据库
└── logs/            # 日志文件
```

---

## 故障排除

### 网站无法访问
```bash
# 检查Nginx状态
sudo systemctl status nginx

# 检查Nginx错误日志
sudo tail -f /var/log/nginx/booming_error.log

# 检查PM2状态
pm2 status
pm2 logs booming
```

### SSL证书问题
```bash
# 检查证书是否过期
sudo certbot certificates

# 手动续期
sudo certbot renew
```

### 数据库权限问题
```bash
sudo chown -R www-data:www-data /var/www/booming/data
```

---

## 更新部署

```bash
cd /var/www/booming

# 停止应用
pm2 stop booming

# 拉取新代码
git pull

# 安装新依赖
npm install

# 重启应用
pm2 restart booming
```

---

## 备份

### 数据库备份
```bash
# SQLite数据库位置
cp /var/www/booming/data/database.sqlite /backup/database-$(date +%Y%m%d).sqlite
```

### 完整备份
```bash
tar -czf booming-backup-$(date +%Y%m%d).tar.gz /var/www/booming
```
