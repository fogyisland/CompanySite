# 密钥轮换 Runbook

**适用版本**: Booming Tech 2026-06-24 之后
**触发场景**: 怀疑密钥泄露 / 定期轮换（推荐 90 天） / 员工离职 / 审计要求

---

## 概述

服务器依赖以下密钥（详见 `.env.example`）：

| 变量 | 用途 | 启动校验 |
|------|------|---------|
| `SESSION_SECRET` | express-session HMAC 签名（cookie 防篡改） | **fail-closed**：未设置或占位值时 `process.exit(1)` |
| `CRON_TOKEN` | `/api/cron/*` 端点鉴权（`X-CRON_TOKEN` 头） | **fail-closed**：同 SESSION_SECRET |
| `PAYPAL_WEBHOOK_ID` | PayPal webhook 签名验证 | 缺失时支付回调被拒 |
| `DB_PASSWORD` | MySQL 连接密码 | 缺失时连库失败 |

`server.js:748-762` 维护一份已知占位密钥黑名单，命中即拒启动。这意味着只要密钥轮换后写入 `.env`，旧值就再也不会被使用。

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

# 2. 更新 .env
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

### 2.4 PAYPAL_WEBHOOK_ID

PayPal Webhook ID 在 PayPal 后台管理，轮换需要：
1. 在 PayPal Dashboard → Webhooks → 创建新 webhook
2. 更新 `.env` 的 `PAYPAL_WEBHOOK_ID`
3. 重启服务器
4. 旧 webhook 在 PayPal 端删除（保留 24-48h 避免漏单）

---

## 3. 定期轮换（90 天节奏）

设置日历提醒，90 天走一遍 2.1-2.4 子集（通常只轮换 `SESSION_SECRET` 和 `CRON_TOKEN`）。DB_PASSWORD 视风险评估决定（半年或一年一次）。

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
| 启动报 `FATAL: SESSION_SECRET is not set` | `.env` 缺失或变量名拼错 | 复制 `.env.example` → `.env`，生成密钥 |
| 启动报 `FATAL: SESSION_SECRET is a known placeholder` | 用了 `booming-tech-secret-key-change-in-production` 等占位值 | 替换为真随机密钥 |
| 登录后立即掉线 | SESSION_SECRET 刚轮换，旧 session 全部失效 | 正常现象，用户重登即可 |
| Cron 任务 401 | CRON_TOKEN 刚轮换，外部调用方未更新 | 同步更新所有调用方的 `X-CRON_TOKEN` |
| DB 连接 `ECONNREFUSED` | DB_PASSWORD 轮换时新密码未生效 | 检查 MySQL `FLUSH PRIVILEGES` 是否执行 |

---

## 6. 关联文件

- `.env.example` — 模板（已 git 追踪）
- `server.js:748-762` — fail-closed 占位密钥黑名单 + 启动校验
- `server.js:752-762` — SESSION_SECRET / CRON_TOKEN 启动检查
- `docs/launch-2026-06-24.md` — 上线清单（含密钥轮换项）
- `docs/review-2026-06-24-full-audit.md` — 审计报告 C1 项
