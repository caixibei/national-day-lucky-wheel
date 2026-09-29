'use strict';

/**
 * 服务入口：装配 Express、会话、静态资源、用户端与管理端路由。
 * 同时承担安全响应头、请求日志、健康检查与优雅停机等进程级职责。
 * 配置全部来自环境变量（.env），启动时集中校验并快速失败/明确提示。
 */
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const { initDb } = require('./src/db');
const { initMailer } = require('./src/mailer');
const { ApiError } = require('./src/errors');
const apiRouter = require('./src/routes/api');
const adminRouter = require('./src/routes/admin');

// 默认端口 3030（与 .env.example 一致）；可通过 .env 的 PORT 覆盖
const PORT = Number(process.env.PORT || 3030);
const HTTPS_ONLY = process.env.HTTPS_ONLY === 'true';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

const db = initDb(process.env.DB_PATH || path.join('data', 'lucky.db'));
initMailer(process.env);

// 会话密钥：公网部署必须显式配置；未配置时用随机密钥兜底（重启后管理端会话失效）并提示
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[安全提醒] SESSION_SECRET 未配置，已使用随机临时密钥（重启后管理端登录态失效）；公网部署请在 .env 中配置。');
}

const app = express();
app.disable('x-powered-by');
// 反向代理终止 TLS 时开启：从 X-Forwarded-For 取真实客户端 IP 用于频控与追溯
app.set('trust proxy', TRUST_PROXY);

// 安全响应头：基础加固；CSP 允许本站资源与 https 奖品外链图片，禁止第三方脚本注入
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'",
  });
  next();
});

// 请求日志：JSON 行 + 请求 ID，只记录方法、路径、状态与耗时，不记录邮箱等隐私明细
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        requestId: req.requestId,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        costMs: Date.now() - start,
      })
    );
  });
  next();
});

app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // 公网 TLS 部署（HTTPS_ONLY=true）时追加 Secure，会话 Cookie 不走明文
      secure: HTTPS_ONLY,
      maxAge: 12 * 60 * 60 * 1000,
    },
  })
);

// 健康检查：供反代/运维探活，同时确认数据库可读
app.get('/health', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api', apiRouter(db, { trustProxy: TRUST_PROXY, httpsOnly: HTTPS_ONLY }));
app.use('/api/admin', adminRouter(db, { trustProxy: TRUST_PROXY }));
// API 404 兜底：避免未知接口路径落到静态资源逻辑
app.use('/api', (req, res) => res.status(404).json({ message: '接口不存在' }));
// 前端静态资源与 API 同源托管，浏览器端无需处理 CORS
app.use(express.static(path.join(__dirname, 'public')));

// 全局错误处理：业务异常透出中文提示；JSON 解析错误按 400 处理；其余统一 500，不向客户端泄漏堆栈
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: '请求格式错误' });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ message: err.message });
  }
  console.error(`[未捕获异常] requestId=${req.requestId}`, err);
  res.status(500).json({ message: '服务繁忙，请稍后再试' });
});

const server = app.listen(PORT, () => {
  console.log(`[启动] 国庆大转盘服务已运行`);
  console.log(`  参与者页：http://localhost:${PORT}/`);
  console.log(`  管理后台：http://localhost:${PORT}/admin/`);
});

// 优雅停机：先停止接收新请求，等待在途请求完成后关闭数据库，避免 WAL 残留
function shutdown() {
  console.log('[停机] 正在关闭服务…');
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // 兜底：5 秒内未正常退出则强制结束，不阻塞运维操作
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
