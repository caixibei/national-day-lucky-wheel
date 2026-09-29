<div align="center">

# 🏮 national-day-lucky-wheel

**2026 国庆大转盘抽奖系统** · 邮箱参与 · 奖品邮件自动发放 · SQLite3 单文件存储

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-brightgreen?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-black?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite3-单文件存储-003B57?logo=sqlite&logoColor=white)
![Nodemailer](https://img.shields.io/badge/Nodemailer-SMTP发信-EA4335?logo=gmail&logoColor=white)
![前端](https://img.shields.io/badge/前端-原生Canvas零构建-F7DF1E?logo=javascript&logoColor=black)
![平台](https://img.shields.io/badge/平台-Windows%20%2F%20Linux-blue?logo=windows&logoColor=white)
![部署](https://img.shields.io/badge/部署-nginx子路径%20%2F%20直连-009639?logo=nginx&logoColor=white)
![奖品](https://img.shields.io/badge/中奖-邮件自动发放-D42A2A)

*转一转 · 赢好运 🎁*

</div>

---

## 🎡 功能一览

| 角色 | 功能 |
| --- | --- |
| 🙋 参与者 | 📧 邮箱即可参与 · 🎡 Canvas 红金转盘动画 · 🎫 兑奖码复制 · 📮 中奖邮件自动发送 · 🔁 失败一键重发 |
| 🛠️ 管理员 | ⚙️ 活动配置 · 🎁 奖品 CRUD（权重/库存/图片/排序）· 👥 参与者查询（邮箱/IP/时间/黑名单）· 📊 抽奖记录筛选 · 📥 CSV 导出 · ✉️ 邮件重发 |

核心保证：

- 🔒 **结果权威在服务端**：权重/库存永不下发，前端只播动画，杜绝改包作弊
- ⚛️ **事务一致性**：限次校验 → 权重抽取 → 扣库存 → 写记录在单个 SQLite 事务内完成
- 🔁 **幂等防重**：`request_id` 唯一索引，网络重试返回同一结果不重复扣次
- 🛡️ **公网防刷**：单人最小间隔 + 单 IP 每小时上限 + 登录失败锁定，参数可调

## 🏗️ 系统架构

```text
参与者浏览器 📱
      │  https://bplims.kdns.fr/lucky-wheel/
      ▼
┌─────────────── nginx（静态直出 + API 反代）───────────────┐
│  /lucky-wheel/      →  html/lucky-wheel/（静态资源）       │
│  /lucky-wheel/api/  →  127.0.0.1:3030（Node/Express）      │
└──────────────────────────────┬────────────────────────────┘
                               ▼
                 Node.js（BASE_PATH 子路径挂载）
                   ├─ 🗄️ SQLite3（data/lucky.db，WAL）
                   └─ ✉️ SMTP（QQ 邮箱，中奖邮件）
```

## 🚀 快速开始（启动命令）

```bash
# 1️⃣ 安装依赖（要求 Node.js ≥ 18）
npm install

# 2️⃣ 创建配置
cp .env.example .env        # Windows CMD 用 copy

# 3️⃣ 启动
npm start                   # 等价于 node server.js，默认端口 3030
```

> [!TIP]
> 国内网络安装 better-sqlite3 卡住？项目内置 `.npmrc` 已指向 npmmirror 镜像，自动下载预编译二进制，无需 Visual Studio。

启动后的入口：

| 入口 | 本机直连 | 子路径部署（BASE_PATH=/lucky-wheel） |
| --- | --- | --- |
| 🎡 参与者页 | `http://localhost:3030/` | `https://你的域名/lucky-wheel/` |
| 🛠️ 管理后台 | `http://localhost:3030/admin/` | `https://你的域名/lucky-wheel/admin/` |
| ❤️‍🩹 健康检查 | `http://localhost:3030/health` | `https://你的域名/lucky-wheel/health` |

> [!IMPORTANT]
> 首次启动若未设置 `ADMIN_PASSWORD`，控制台会打印一次随机管理员密码（账号 `admin`），**请立即保存**。

长期运行建议用 pm2 守护：

```bash
npm i -g pm2
pm2 start server.js --name lucky-wheel
pm2 save && pm2 startup
```

## ⚙️ 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3030 | 监听端口 |
| `BASE_PATH` | 空 | 🧩 子路径部署：nginx 按 `/lucky-wheel/` 访问时设为 `/lucky-wheel`，API 与静态资源随此前缀挂载 |
| `TRUST_PROXY` | false | 走 nginx 反代必须设 `true`，从 `X-Forwarded-For` 取访客真实 IP |
| `HTTPS_ONLY` | false | 纯 HTTPS 链路时设 `true`，会话 Cookie 追加 `Secure` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | admin / 随机 | 管理员账号密码（密码仅首次建号生效，≥8 位） |
| `SESSION_SECRET` | 随机 | 会话签名密钥，公网部署必须改为随机长字符串 |
| `DB_PATH` | data/lucky.db | SQLite 数据文件路径 |
| `MIN_DRAW_INTERVAL_MS` | 3000 | 单人两次抽奖最小间隔（防连点） |
| `MAX_DRAWS_PER_IP_PER_HOUR` | 60 | 同一 IP 每小时抽奖上限（防脚本） |
| `MAIL_DRY_RUN` | true | `true` = 演练模式，邮件只打日志状态记 simulated；正式运行为 false |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | - / 465 / true | SMTP 服务器（QQ：`smtp.qq.com:465` SSL） |
| `SMTP_USER` / `SMTP_PASS` | - | 发信邮箱与**授权码**（QQ 邮箱在「设置-账户」开启 SMTP 后生成） |
| `MAIL_FROM` | SMTP_USER | 发件人展示地址 |

> [!WARNING]
> `.env` 包含 SMTP 授权码等敏感信息，已在 `.gitignore` 中排除，**严禁提交到仓库或打包外发**；疑似泄露请立即在邮箱服务商处重置授权码。

## 📦 打包与发布（打包命令）

项目**零构建**——前端原生 HTML/CSS/JS、后端源码直跑，打包即「源码目录压缩」，排除平台相关与敏感内容：

```bash
# 在项目根目录执行（Git Bash / Linux 通用）
cd F:/national-day-lucky-wheel

tar --exclude=./node_modules --exclude=./data --exclude=./.env \
    --exclude=./.git --exclude=./lucky-wheel-release-*.tar.gz \
    -czvf /f/lucky-wheel-release-$(date +%Y%m%d).tar.gz .
```

| 排除项 | 原因 |
| --- | --- |
| 🚫 `node_modules` | better-sqlite3 二进制**与平台绑定**，Windows 的产物在 Linux 不可用，服务器必须重新 `npm install` |
| 🚫 `data/` | 业务数据库（含参与者隐私），如需迁移数据请单独停服后拷贝 |
| 🚫 `.env` | 含 SMTP 授权码与会话密钥，服务器上手工创建 |

服务器侧：

```bash
# 1️⃣ 解压
mkdir -p /opt/lucky-wheel
tar -xzf lucky-wheel-release-YYYYMMDD.tar.gz -C /opt/lucky-wheel

# 2️⃣ 安装依赖（.npmrc 已内置国内镜像，自动下载 Linux 版预编译二进制）
cd /opt/lucky-wheel && npm install --omit=dev

# 3️⃣ 配置并启动
cp .env.example .env && vim .env     # 必改：SESSION_SECRET / ADMIN_PASSWORD / SMTP / TRUST_PROXY
npm start                            # 或 pm2 start server.js --name lucky-wheel
```

> [!NOTE]
> 已有配置要迁移？先停两端服务，把 `data/lucky.db` 单独拷到服务器同位置再启动，活动/奖品/管理员账号原样带走。

## 🌐 nginx 部署（与现有服务共用站点 · 子路径方案）

多服务共存时的推荐布局（**不改动已有服务的任何访问路径**）：

```text
nginx/html/
├── bplims/          # 已有服务的前端（location / 的 root 指向此处，URL 不变）
├── lucky-wheel/     # 大转盘静态（location /lucky-wheel/ alias 直出）
└── 50x.html         # 各站点共用错误页
```

nginx 关键配置（80/443 站点各一份）：

```nginx
# 大转盘补斜杠跳转
location = /lucky-wheel       { return 301 /lucky-wheel/; }
location = /lucky-wheel/admin { return 301 /lucky-wheel/admin/; }

# API 反代：不带 URI，原样透传 /lucky-wheel/api/ 前缀（应用 BASE_PATH=/lucky-wheel 匹配）
location /lucky-wheel/api/ {
    proxy_pass http://127.0.0.1:3030;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
}

# 静态直出
location /lucky-wheel/ {
    alias D:/protable/nginx-1.31.4/html/lucky-wheel/;
    index index.html;
}
```

- 🔄 **改前端后同步静态**：双击项目根目录的 `deploy-lucky-wheel.bat`（robocopy 镜像 `public/` → `html/lucky-wheel/`），浏览器 Ctrl+F5 即可，无需重启 Node；
- 🕵️ **真实 IP 验证**：手机流量抽一次，后台「参与者」IP 应显示运营商公网 IP 而非 127.0.0.1；
- 🧱 应用侧 `.env` 记得 `TRUST_PROXY=true`，否则所有 IP 都是 127.0.0.1。

> [!CAUTION]
> 数据迁移（拷贝 `data/`）前后都必须**先停止 Node 服务**，避免 WAL 文件不一致。

## 📧 邮件配置（QQ 邮箱示例）

1. 邮箱「设置 → 账户」开启 SMTP 服务，生成**授权码**填入 `.env` 的 `SMTP_PASS`；
2. `.env`：`SMTP_HOST=smtp.qq.com`、`SMTP_PORT=465`、`SMTP_SECURE=true`、`MAIL_DRY_RUN=false`，重启生效；
3. 服务商侧配置 **SPF/DKIM** 降低进垃圾箱概率；
4. 发送状态在后台「抽奖记录」按邮件状态筛选，失败可一键重发（60 秒限频）；参与者端「我的奖品」同样可重发。

## 🗂️ 目录结构

```text
national-day-lucky-wheel/
├── 🚀 server.js              # 入口：装配/安全头/请求日志/健康检查/优雅停机
├── 📂 src/
│   ├── 🗄️ db.js              # SQLite 初始化、建表、种子数据
│   ├── 🎲 lottery.js         # 抽奖事务（幂等→限次→抽取→扣库存→记录）
│   ├── ✉️ mailer.js          # 邮件模块（演练模式/状态跟踪/重发限频）
│   ├── 🧰 util.js / errors.js
│   └── 🛣️ routes/            # api.js（用户端）· admin.js（管理端+CSV 导出）
├── 📂 public/                # 前端（零构建）
│   ├── 🎡 index.html · css/ · js/
│   └── 🛠️ admin/
├── 📦 deploy-lucky-wheel.bat # 静态同步到 nginx（子路径部署用）
├── ⚙️ .env.example / .npmrc
└── 🗄️ data/lucky.db          # SQLite 数据文件（运行时生成）
```

## ❓ 常见问题

<details>
<summary><b>🔌 端口被占用怎么办？</b></summary>

改 `.env` 的 `PORT` 重启；或 `netstat -ano | findstr :3030` 找到占用进程处理。
</details>

<details>
<summary><b>🕵️ 后台 IP 显示 ::1 是什么意思？</b></summary>

`::1` 是本机回环地址（本机浏览器访问本机服务），后台会标注「本机」；公网部署且 `TRUST_PROXY=true` 后显示访客真实 IP。
</details>

<details>
<summary><b>✉️ 邮件发送失败怎么排查？</b></summary>

后台「抽奖记录」筛「发送失败」看括号内原因：535 = 授权码错误；连接超时 = 服务器出网 465 被禁。修复后点「重发」。
</details>

<details>
<summary><b>💾 如何备份/重置数据？</b></summary>

备份：停服后拷贝 `data/` 目录。重置：停服删除 `data/` 再启动（自动重建管理员与示例活动）。
</details>

<details>
<summary><b>🧱 改了前端但页面没变化？</b></summary>

子路径部署时静态由 nginx 直出：先运行 `deploy-lucky-wheel.bat` 同步，再 Ctrl+F5 强刷。
</details>

## 🛡️ 上线安全清单

- [ ] `SESSION_SECRET` 已改为随机长字符串
- [ ] `ADMIN_PASSWORD` 已设置强密码（或已保存首启随机密码）
- [ ] `MAIL_DRY_RUN=false` 且已用真实邮箱完成一次中奖收信验证
- [ ] `TRUST_PROXY=true`（nginx 场景）、`HTTPS_ONLY=true`（纯 HTTPS 链路）
- [ ] 3030 端口未对公网开放（仅 nginx 转发）
- [ ] `.env` 未进入任何版本库/压缩包

## 🗺️ Roadmap

- [ ] 📺 大屏模式（全屏转盘 + 中奖名单滚动）
- [ ] 📊 数据看板（参与/中奖分布）
- [ ] 🚫 独立 IP 黑名单表、单 IP 每日新邮箱数上限

---

<div align="center">

🧾 完整产品设计见《[产品设计文档.md](./产品设计文档.md)》 · 用 Redis 般的简单，做一个靠谱的抽奖 🎉

</div>
