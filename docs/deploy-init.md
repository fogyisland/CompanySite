# 生产环境「未初始化状态」部署清单

> 目标：把 `www.booming.one` 部署成**全新未安装**状态，通过 `/setup` 向导重新生成配置、建表、创建首个管理员。
> 适用代码版本：`origin/main` @ `8089588` 及之后。
>
> **这份清单由你在服务器上执行。** 我没有 `booming.one` 的 SSH 凭据，也不持有生产 MySQL 的账号密码。

---

## 0. 先读这一段：两种口径，技术上不等价

你最初的要求是「生产换空库 + 移除 `.env`，走 `/setup` 向导」。落地时有两个口径，**代价不同**，必须先选一个：

| | **口径 A（推荐）**：保留 `.env`，只改 `DB_NAME` | **口径 B**：彻底移除 `.env` |
|---|---|---|
| 非受管键（`PAYPAL_WEBHOOK_ID` / `MCP_TOKEN` / `DB_COPY_ALLOWED_HOSTS` …） | ✅ **逐字保留** | ❌ **全部丢失** |
| `SESSION_SECRET` | ✅ 沿用旧值 → 不用全员重新登录 | ❌ 重新生成 → 所有人被登出 |
| `CRON_TOKEN` | ✅ 沿用旧值 → 外部 cron 调用不受影响 | ❌ 重新生成 → 外部 cron 令牌需同步更新 |
| 旧部署遗留的 `data/db-config.json` | ✅ 被 `.env` 优先级盖住，无影响 | ⚠️ **必须一并移走**（见下） |
| 向导能否走完 | ✅ 确定能 | ⚠️ **取决于服务器 MySQL 的状态**（见下） |
| 需要手工动作 | 改 `.env` 里**一行** | 移走 `.env` + `data/db-config.json` + **手工补回非受管键** |

### 为什么非受管键在口径 B 下会丢

`lib/env-config-service.js` 的 `collectPreservedEntries()` 只从**现存的 `.env` 原文**里搬运那些「向导不管理」的键。
`.env` 一旦不存在，`saveDbConfigToEnv()` 就没有任何来源可搬 —— 生成的新 `.env` 里只有 8 个受管键，
`PAYPAL_WEBHOOK_ID` 这类运维手工配的键会**静默消失**。支付回调会因此失效，而且不会有任何报错。

### 为什么口径 B 有「可能卡死」的风险

口径 B 下进程没有 `.env`，会依次退回 `data/db-config.json` → `db.js` 的默认值
（`localhost:3306` / `root` / 库名 `softvault`）。**先把 `data/db-config.json` 移走**（第 3.3 节），
否则它会接管连接参数、指向旧库，站点判定为「已安装」，`/setup` 直接 302 到 `/login` —— 向导根本不出现。

移走之后进程才会真的落到默认值，此时 `countAdmins()` 抛错，分支完全由错误码决定
（`lib/setup.js:143-155` + `lib/setup-policy.js`）：

| 服务器上的实际情况 | 错误码 | `dbUnreachable` | 结果 |
|---|---|---|---|
| 本机没跑 MySQL | `ECONNREFUSED` | `true` | ✅ 向导可用（第 2 步的闸门对「数据库不可用」是**放行**的） |
| root 用 `auth_socket`（MySQL 默认，TCP 登录失败） | `ER_ACCESS_DENIED_ERROR` | `true` | ✅ 向导可用 |
| root 允许无密码 TCP，但**恰好没有** `softvault` 库 | `ER_BAD_DB_ERROR` | **`false`** | ❌ **卡死** |

最后一行是坑：`ER_BAD_DB_ERROR`(1049) **不在** `isDbUnavailableError()` 的名单里，
于是 `undetermined=true, dbUnreachable=false`，`checkSetupConfigWritable()` 判
`undetermined && !dbUnreachable` → **连第 2 步「写入 .env 并继续」都会被 403 拒绝**，向导彻底走不下去。

> 顺带一提：这就是为什么口径 A 值得优先 —— 它的成功与否只取决于「空库已建好」这一件确定的事，
> 不依赖服务器 MySQL 的认证方式、也不依赖某个库是否恰好存在。

### 口径 A 为什么没有这个风险

口径 A 下 `.env` 明确指向刚建好的空库 → 连接成功 → `countAdmins()` 抛 `ER_NO_SUCH_TABLE`(1146)
→ `isMissingTableError()` 命中 → 判定为「**确定未安装**」→ 所有写操作闸门全部放行。

**结论：走口径 A。** 它同样得到「全新未安装」的站点状态，但不会丢配置、不会让全员登出、不依赖服务器 MySQL 的认证方式。

> 如果你确认要走口径 B，第 3.3 节照做，但**必须**把非受管键补回 `.env`，否则支付回调会失效。

---

## 1. 前置条件

- [ ] 服务器 SSH 可用（`ssh user@booming.one`）
- [ ] 有 MySQL 管理员权限（能 `CREATE DATABASE`）—— 我没有生产库凭据，这一步只能你来
- [ ] 知道站点目录（下面用 `/var/www/booming`，按你的实际路径改；`docs/launch-2026-06-24.md:71` 里也写了可能是 `/home/user/site`、`/opt/app`）
- [ ] 旧库不会被删，只是**保留**（本流程全程不碰旧库的数据）

先取旧库的连接信息（**不回显密码**）：

```bash
cd /var/www/booming
grep -E '^(DB_HOST|DB_PORT|DB_USER|DB_NAME)=' .env
```

同时列出 `.env` 的全部键名，确认有没有需要保留的非受管键：

```bash
sed -E 's/=.*//' .env | grep -E '^[A-Z_][A-Z0-9_]*$'
```

---

## 2. 备份（先做，不可跳过）

```bash
cd /var/www/booming
STAMP=$(date +%Y%m%d-%H%M%S)
cp -a .env ".env.bak-${STAMP}"
echo "备份文件: .env.bak-${STAMP}"
```

旧库也留一份逻辑备份（防止后面手滑）：

```bash
mysqldump -h <DB_HOST> -P <DB_PORT> -u <DB_USER> -p <DB_NAME> \
  > "~/booming-old-${STAMP}.sql"
```

---

## 3. 建空库并改配置

### 3.1 建空库

```bash
mysql -h <DB_HOST> -P <DB_PORT> -u <管理员账号> -p
```

（密码交互式输入，不要写进命令行 —— 命令行里会进 shell history。）

```sql
-- 新库名自定，下面用 booming_init
CREATE DATABASE booming_init CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 必须授给 .env 里那个 DB_USER（向导第 2 步用的就是它）
GRANT ALL PRIVILEGES ON booming_init.* TO '<DB_USER>'@'<DB_USER的主机>';
FLUSH PRIVILEGES;

-- 确认授权生效
SHOW GRANTS FOR '<DB_USER>'@'<DB_USER的主机>';
EXIT;
```

> `GRANT` 里的主机部分要和 `.env` 里 `DB_USER` 实际连过来的主机一致（常见是 `%` 或具体 IP）。
> 授权漏了会导致向导第 2 步「测试连接」报 `ER_DBACCESS_DENIED_ERROR`。

### 3.2 改 `.env`（口径 A）

```bash
cd /var/www/booming
sed -i 's|^DB_NAME=.*|DB_NAME="booming_init"|' .env

# 核对（确认 DB_NAME 改了，其余没动）
grep -E '^(DB_HOST|DB_PORT|DB_USER|DB_NAME)=' .env
```

> 一定要带引号，和向导生成的格式保持一致；密码这类含 `#` 或空格的值的引号不能丢。

### 3.3 若坚持口径 B（彻底移除 `.env`）

⚠️ 这一节有两件事必须做，**少一件都达不到「未初始化状态」**。

```bash
cd /var/www/booming

# ① 把「非受管键」的原始行搬出来（8 个受管键之外的全部保留）
grep -vE '^(PORT|SESSION_SECRET|CRON_TOKEN|DB_HOST|DB_PORT|DB_USER|DB_PASSWORD|DB_NAME)=' \
  ".env.bak-${STAMP}" > /tmp/preserved-env-keys.txt
cat /tmp/preserved-env-keys.txt      # 逐行确认，这就是之后要补回 .env 的内容

# ② 移走 .env
mv .env ".env.removed-${STAMP}"

# ③ 移走旧部署遗留的 data/db-config.json —— 它是「.env 之外的第二份配置副本」，
#    .env 一旦不存在，它就会接管连接参数（db.getDbConfig(): 没有 process.env.DB_HOST 就读它）。
#    不移走的话：站点会连上旧库 → 判定「已安装」→ /setup 直接 302 到 /login，向导根本不出现。
mv data/db-config.json "data/db-config.json.bak-${STAMP}" 2>/dev/null || echo "（没有这个文件，跳过）"
```

建完库、装完依赖、跑完向导后，把这些键**补回**新 `.env`（向导第 2 步写出的 `.env` 里只有 8 个受管键）：

```bash
cat /tmp/preserved-env-keys.txt >> /var/www/booming/.env
cd /var/www/booming && pm2 restart booming
```

> 口径 B 下 `SESSION_SECRET` / `CRON_TOKEN` 也会变成新值：
> `SESSION_SECRET` 变 → 所有已登录会话失效（可接受）；
> `CRON_TOKEN` 变 → **任何外部定时任务调 `/api/cron/*` 的地方都要同步更新令牌**，否则静默失败。
>
> 口径 B 下第 2 步的表单**不会预填真实配置**（没有 `.env`、`db-config.json` 也移走了），
> 五个字段都要手填；数据库名填 `booming_init`。密码这次**必须填**（没有已保存的密码可沿用）。

---

## 4. 拉代码、装依赖、重启

```bash
cd /var/www/booming
git pull origin main
npm install --production
pm2 restart booming
```

启动日志里应能看到（口径 A）：

```
MySQL连接成功
Database initialized (MySQL)
Database initialized
```

以及安装令牌提示（**这一段说明站点已被判定为「未安装」，口径正确**）：

```
  ╔══════════════════════════════════════════════════════╗
  ║  站点尚未完成安装，请打开 /setup 完成初始化            ║
  ╚══════════════════════════════════════════════════════╝
  安装令牌: <48位十六进制>
  令牌文件: /var/www/booming/data/setup-token.txt
```

> 令牌**不会**出现在任何 HTTP 响应里，只在服务器控制台和 `data/setup-token.txt`。
> 取令牌：`cat /var/www/booming/data/setup-token.txt`
>
> 口径 A 下 `initDatabase()` 会顺手把表建好、灌好默认数据 —— 向导第 3 步是幂等复核，重复执行无副作用。

---

## 5. 走 /setup 向导（五步）

浏览器打开 **https://www.booming.one/setup**，输入上面第 4 节日志里取到的令牌。
界面步骤条：安装令牌 → 数据库连接 → 初始化表结构 → 管理员账号 → 完成。

### 第 1 步 · 校验安装令牌
粘贴令牌 → 「校验并继续」。应显示「数据库可连接」+ 当前库名。

### 第 2 步 · 数据库连接 ⚠️ **先核对预填值**

表单的预填值来自**当前进程生效的配置**（`server.js:1191` → `db.getDbConfig()`）。
口径 A 下你在服务器上已经把 `.env` 的 `DB_NAME` 改成 `booming_init` 并重启过，
所以这里**预填的库名应该已经是 `booming_init`**。

| 字段 | 口径 A 应显示 | 说明 |
|---|---|---|
| 主机 | `<DB_HOST>` | 与旧 .env 相同 |
| 端口 | `<DB_PORT>` | 通常 3306 |
| 用户 | `<DB_USER>` | 必须是对新库有权限的那个 |
| 密码 | 留空 | 下方提示「留空表示沿用已保存的密码」—— 界面不回显密码 |
| **数据库名** | **`booming_init`** | ⚠️ **如果显示的是旧库名，说明第 3.2 节的 sed 没生效** |

**如果预填的库名不是 `booming_init`：立刻停止，不要点下面的任何按钮。**
此时站点仍连着旧库（旧库有管理员 → 站点判定为「已安装」），你继续操作会把连接池切回旧库。
正确做法是关掉浏览器，回服务器确认 `.env` 里的 `DB_NAME` 并重新 `pm2 restart booming`。

**确认无误后的两个按钮都能走：**

- 「**不修改，直接继续**」（`btn-next-db`）—— 只跳到第 3 步，**完全不碰 `.env`、不切连接池**。
  口径 A 下 `.env` 已经是正确的，这个按钮最保守，**推荐点它**。
- 「**写入 .env 并继续**」—— 会用当前表单值重写 `.env`（未变的键逐字保留，末尾是 Preserved 段），
  然后 `reconnectWithConfig()` **当场切换连接池**（`server.js:1307`）。
  口径 A 下这会把 `.env` 按新格式重排一遍 —— 内容等价，但**只有在库名确实是 `booming_init` 时才可点**。
  库名填错 = 连接池切回旧库，第 3 步就会在**旧生产库**上建表（幂等，等于白忙，还可能灌进默认数据）。

若用「写入 .env 并继续」，建议先点旁边的「**测试连接**」，确认返回的库名是 `booming_init` 再提交。

### 第 3 步 · 初始化表结构
点「开始初始化」（`/api/setup/init-db` → `createTablesIfNotExist()` + `initDefaultData()`），全幂等。

> 口径 A 下这些表**在启动时就已经建好了**（`db.initDatabase()` 会自动建表 + 灌默认数据），
> 所以这一步实际是复核，重复执行无副作用。

应列出所有表为「就绪」。

### 第 4 步 · 创建首个管理员
填用户名（3~32 位）/ 密码（≥8 位且含字母和数字）/ 邮箱（可选）→ 「创建管理员并完成安装」。

成功后**安装令牌会被销毁**（`data/setup-token.txt` 删除），所有 `/api/setup/*` 接口永久返回 403。
这就是「站点已装好」的安全边界，不用再手工清理。

### 第 5 步 · 完成
按提示用刚创建的管理员账号登录。

---

## 6. 验证清单

**安装前**（重启之后、走向导之前）—— 站点应处于「未初始化」状态：

```bash
# ① 首页 302 跳 /setup（未安装闸门）
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.booming.one/
#    期望：302 https://www.booming.one/setup

# ② /setup 可达
curl -s -o /dev/null -w '%{http_code}\n' https://www.booming.one/setup
#    期望：200
```

> 若 ① 返回 200 而不是 302，说明站点**仍被判为「已安装」** → 第 3.2 节的 `DB_NAME` 没改成功，
> 或新库里已经有管理员行。回服务器核对后重来。

**安装后**：

```bash
# ③ 首页恢复 200（不再是 302）
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.booming.one/
#    期望：200

# ④ 安装接口已关闭
curl -s https://www.booming.one/api/setup/status -H 'X-Setup-Token: <无效令牌>' -w '\n%{http_code}\n'
#    期望：403（安装完成时令牌文件已被销毁，安装接口永久关闭）

# ⑤ 日志无报错
pm2 logs booming --lines 50
```

浏览器侧再确认：用新管理员登录 `https://www.booming.one/login` → `/admin-overview` 能打开；
首页正常渲染、Logo/主题/设置项都正常；**产品列表为空**（新库没有业务数据）；
后台「系统设置 → 数据库」显示的库名是 `booming_init`。

---

## 7. 回滚

**旧库的数据全程没被碰过**，所以回滚只是把 `.env` 指回去：

```bash
cd /var/www/booming
cp -a ".env.bak-<STAMP>" .env
pm2 restart booming
```

回滚后站点指向旧库，`SESSION_SECRET` / `CRON_TOKEN` 也一并还原（口径 A 下本来就是同一份），
不需要额外操作。新建的 `booming_init` 空库留着不删即可。

### 如果在旧库上误建了管理员

只有一种情况会污染旧库：在向导第 2 步把库名填错成旧库名，然后点了「写入 .env 并继续」
→ 连接池切回旧库 → 第 3、4 步都作用在旧库上。后果分两种：

- **第 3 步**：`createTablesIfNotExist()` 走 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN`
  （重复列被吞掉）→ 旧库**不会丢数据**，但如果旧库缺某张表、或缺某个列，会被补上。
  `initDefaultData()` 只在目标表为空时灌数据 —— 旧库非空，所以不动。
- **第 4 步**：用**相同**用户名会被拒（409「用户名已被占用」）；
  换了新用户名则**会在旧库里真的多出一个管理员** —— 需要事后去旧库删掉那一行用户记录。

旧库的业务数据没有丢失风险。要核对的话用第 2 节那份 `mysqldump` 备份对照。

---

## 8. 后续要单独处理的两件事

1. **新库是空的**：产品、新闻、公告、定价档位等业务数据都不在。旧库导数据到新库要走
   后台「系统设置 → 数据库」的导出/导入功能（`/api/db-export` / `/api/db-import`），
   注意 `db.updateProduct` 是全列覆盖，导入后要抽查。
2. **支付回调**（口径 B 才需要）：`PAYPAL_WEBHOOK_ID` 等键必须已按 3.3 节补回 `.env` 并重启，
   否则 PayPal 回调会静默失效 —— 订单状态永远停在待支付。
