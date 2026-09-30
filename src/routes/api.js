'use strict';

/**
 * 用户端 API：验证码发送、参与者注册/找回（邮箱即身份，强制验证码校验）、会话恢复、抽奖、中奖邮件重发、我的记录。
 * 前端与 API 同源部署，参与者身份通过 HttpOnly Cookie（lw_token）保持，不经 localStorage。
 */
const express = require('express');
const crypto = require('crypto');
const { ApiError } = require('../errors');
const { drawPrize } = require('../lottery');
const { sendPrizeEmail, sendVerifyCodeEmail } = require('../mailer');
const { clientIp } = require('../util');

// 简化版邮箱格式校验：本地段@域名.顶级域，拦截明显格式错误；
// 完整 RFC 校验成本高，活动场景以「格式校验 + 发送状态跟踪 + 失败重发」兜底
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const COOKIE_NAME = 'lw_token';
// Cookie 有效期 30 天：覆盖整个活动周期及事后查记录需求
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{trustProxy: boolean, httpsOnly: boolean}} cfg
 */
module.exports = function apiRouter(db, cfg) {
  const router = express.Router();
  const MIN_DRAW_INTERVAL_MS = Number(process.env.MIN_DRAW_INTERVAL_MS || 3000);
  const MAX_DRAWS_PER_IP_PER_HOUR = Number(process.env.MAX_DRAWS_PER_IP_PER_HOUR || 60);
  // 邮箱验证码：证明邮箱真实可收信（奖品可达性的最终保障）。TTL 夹取 1~60 整数，防脏配置拼进 SQL 修饰符
  const VERIFY_CODE_TTL_MIN = Math.min(60, Math.max(1, Math.round(Number(process.env.VERIFY_CODE_TTL_MIN) || 10)));
  const VERIFY_CODE_MAX_ATTEMPTS = 5;
  const VERIFY_SEND_INTERVAL_SEC = Math.max(30, Number(process.env.VERIFY_SEND_INTERVAL_SEC) || 60);
  // 单 IP 每小时最多为多少个邮箱发码：NAT 下多人共用出口 IP，取值需高于家庭/小团队规模
  const MAX_CODE_SENDS_PER_IP_PER_HOUR = Number(process.env.MAX_CODE_SENDS_PER_IP_PER_HOUR || 30);
  // 单邮箱每日发码上限：按本地时区自然日计数，跨日自动重置
  const MAX_CODE_SENDS_PER_EMAIL_PER_DAY = Math.max(1, Number(process.env.MAX_CODE_SENDS_PER_EMAIL_PER_DAY) || 10);

  // 进程内频控计数器：单进程部署下精确可用；重启清零只影响频控精度，不影响落库的限次规则。
  // 定期清理过期窗口，防止长时间运行内存增长（unref 保证不阻塞进程退出）
  const lastDrawAt = new Map();
  const ipWindows = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of ipWindows) if (now - w.start >= 3600 * 1000) ipWindows.delete(ip);
    // 顺带清理过期超 24 小时的验证码行：表按 email 主键存储，长期不清会随参与量缓慢增长
    db.prepare(`DELETE FROM email_code WHERE expires_at < datetime('now', 'localtime', '-1 day')`).run();
  }, 10 * 60 * 1000).unref();

  function deviceType(ua) {
    const s = String(ua || '').toLowerCase();
    if (/ipad|tablet/.test(s)) return 'tablet';
    if (/mobile|android|iphone/.test(s)) return 'mobile';
    return 'pc';
  }

  // 邮箱准入预检（格式 + 黑名单）：发码与注册两步共用，保证口径一致；
  // 黑名单邮箱在发码阶段即拦截，不向其发送任何邮件
  function assertEmailAllowed(email) {
    if (!EMAIL_RE.test(email) || email.length > 254) {
      throw new ApiError(400, '请填写正确的邮箱地址，奖品将通过邮件发送至该邮箱');
    }
    // 读 player.blacklisted 判黑名单：只读过滤，无写入
    const row = db.prepare('SELECT blacklisted FROM player WHERE email = ?').get(email);
    if (row && row.blacklisted) throw new ApiError(403, '该邮箱已被限制参与，如有疑问请联系组织者');
  }

  // 当前活动：取库中最新一条（v1 单活动；字段命名保留多活动扩展空间）
  function currentActivity() {
    return db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 1').get();
  }

  // 对外活动载荷：绝不包含 weight/stock/remaining，防止前端据其推算概率与库存
  function activityPayload(act) {
    if (!act) return null;
    const prizes = db
      .prepare('SELECT id, name, image, sort, type FROM prize WHERE activity_id = ? AND enabled = 1 ORDER BY sort, id')
      .all(act.id);
    return {
      id: act.id,
      name: act.name,
      startTime: act.start_time,
      endTime: act.end_time,
      dailyLimit: act.daily_limit,
      totalLimit: act.total_limit,
      status: act.status,
      prizes,
    };
  }

  // 剩余次数：每日按当日记录数、总计按累计抽奖次数分别计算，前端取两者较小值展示
  function remainingFor(playerId, act) {
    const dailyUsed = db
      .prepare(
        `SELECT COUNT(*) AS c FROM draw_record
         WHERE player_id = ? AND date(drawn_at) = date('now', 'localtime')`
      )
      .get(playerId).c;
    const totalUsed = db.prepare('SELECT draw_total FROM player WHERE id = ?').get(playerId).draw_total;
    return {
      daily: Math.max(0, act.daily_limit - dailyUsed),
      total: Math.max(0, act.total_limit - totalUsed),
    };
  }

  function setSession(res, token) {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.httpsOnly,
      maxAge: COOKIE_MAX_AGE,
    });
  }

  function requirePlayer(req) {
    const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
    const player = token ? db.prepare('SELECT * FROM player WHERE token = ?').get(token) : null;
    if (!player) throw new ApiError(401, '请先填写邮箱参与抽奖');
    if (player.blacklisted) throw new ApiError(403, '账号已被限制参与，如有疑问请联系组织者');
    return player;
  }

  // 活动公开信息：供首屏渲染转盘；载荷不含权重/库存/剩余，防止前端推算概率
  router.get('/activity', (req, res) => {
    const act = currentActivity();
    res.json({
      activity: activityPayload(act),
      serverTime: db.prepare(`SELECT datetime('now', 'localtime') AS t`).get().t,
    });
  });

  // 发送邮箱验证码：注册第一步。验证码落 email_code 表（每邮箱一行、覆盖式更新），
  // 黑名单不发、同邮箱 60 秒冷却、单 IP 每小时上限，防验证码接口被滥用轰炸 SMTP
  router.post('/email-code', async (req, res, next) => {
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      assertEmailAllowed(email);
      const ip = clientIp(req, cfg.trustProxy);

      // 读 email_code 行：每日上限与 60 秒冷却共用一次查询
      const sent = db
        .prepare('SELECT last_sent_at, send_date, send_count FROM email_code WHERE email = ?')
        .get(email);
      const today = db.prepare(`SELECT date('now', 'localtime') AS d`).get().d;
      // 单邮箱每日发码上限：send_date 与今天相同才累计，跨日（含历史 NULL）自动重新起算；
      // 先于冷却检查，让达到上限的用户看到更明确的提示而非「发送频繁」
      if (sent && sent.send_date === today && sent.send_count >= MAX_CODE_SENDS_PER_EMAIL_PER_DAY) {
        throw new ApiError(429, '该邮箱今日验证码发送次数已达上限，请明日再试或联系组织者');
      }
      if (sent) {
        const elapsed = db
          .prepare(`SELECT (julianday('now', 'localtime') - julianday(?)) * 86400 AS s`)
          .get(sent.last_sent_at).s;
        if (elapsed < VERIFY_SEND_INTERVAL_SEC) {
          throw new ApiError(429, `发送过于频繁，请 ${Math.ceil(VERIFY_SEND_INTERVAL_SEC - elapsed)} 秒后再试`);
        }
      }
      // 统计该 IP 最近 1 小时覆盖的邮箱数（每邮箱恰好一行，行数即邮箱数），拦同 IP 批量给新邮箱发码
      const ipCount = db
        .prepare(
          `SELECT COUNT(*) AS c FROM email_code
           WHERE ip = ? AND last_sent_at >= datetime('now', 'localtime', '-1 hour')`
        )
        .get(ip).c;
      if (ipCount >= MAX_CODE_SENDS_PER_IP_PER_HOUR) {
        throw new ApiError(429, '当前请求较为频繁，请稍后再试');
      }

      // 生成 6 位码并覆盖式写入（重置校验次数与时效）：生成 → 落库 → 发信 → 响应。
      // send_count 为「受理即计数」：同日 +1、跨日重置为 1；SMTP 失败不回退，防对失败通道重试轰炸
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      db.prepare(
        `INSERT INTO email_code (email, code, expires_at, attempts, ip, last_sent_at, send_date, send_count)
         VALUES (?, ?, datetime('now', 'localtime', '+${VERIFY_CODE_TTL_MIN} minutes'), 0, ?,
                 datetime('now', 'localtime'), date('now', 'localtime'), 1)
         ON CONFLICT(email) DO UPDATE SET
           code = excluded.code,
           expires_at = excluded.expires_at,
           attempts = 0,
           ip = excluded.ip,
           last_sent_at = excluded.last_sent_at,
           send_date = excluded.send_date,
           send_count = CASE WHEN email_code.send_date = excluded.send_date
                             THEN email_code.send_count + 1 ELSE 1 END`
      ).run(email, code, ip);

      const result = await sendVerifyCodeEmail(email, code, VERIFY_CODE_TTL_MIN);
      if (result.status === 'failed') throw new ApiError(502, '验证码发送失败，请稍后重试');
      res.json({
        message: '验证码已发送至您的邮箱，请查收（留意垃圾邮件）',
        cooldownSec: VERIFY_SEND_INTERVAL_SEC,
        // 演练模式（无 SMTP）把验证码透传给前端便于本地联调；生产 SMTP 模式不含该字段
        devCode: result.status === 'simulated' ? code : undefined,
      });
    } catch (e) {
      next(e);
    }
  });

  // 注册/找回：邮箱即身份，验证码校验通过才放行。已存在则轮换令牌绑定同一账号——换设备凭邮箱可找回记录，旧设备会话随之失效
  router.post('/player', (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    assertEmailAllowed(email);
    const ip = clientIp(req, cfg.trustProxy);
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);

    // 验证码强校验：正则只能保证「格式像邮箱」，验证码才能证明「邮箱真收得到信」，是奖品可达性的最终保障
    const code = String((req.body && req.body.code) || '').trim();
    // 读 email_code 行供「未发码 / 次数超限 / 已过期 / 码值比对」四重校验
    const codeRow = db.prepare('SELECT code, expires_at, attempts FROM email_code WHERE email = ?').get(email);
    if (!codeRow) throw new ApiError(400, '请先点击「获取验证码」完成邮箱校验');
    if (codeRow.attempts >= VERIFY_CODE_MAX_ATTEMPTS) {
      throw new ApiError(400, '验证码错误次数过多，请重新获取验证码');
    }
    if (codeRow.expires_at < db.prepare(`SELECT datetime('now', 'localtime') AS t`).get().t) {
      throw new ApiError(400, '验证码已过期，请重新获取验证码');
    }
    // 常量时间比较防时序侧信道；位数不等先短路（timingSafeEqual 要求等长缓冲）
    const codeOk =
      code.length === codeRow.code.length &&
      crypto.timingSafeEqual(Buffer.from(code), Buffer.from(codeRow.code));
    if (!codeOk) {
      // 写 email_code.attempts 累计错误次数，封死 6 位数字的暴力枚举空间
      db.prepare('UPDATE email_code SET attempts = attempts + 1 WHERE email = ?').run(email);
      const left = VERIFY_CODE_MAX_ATTEMPTS - codeRow.attempts - 1;
      throw new ApiError(400, left > 0 ? `验证码错误，还可尝试 ${left} 次` : '验证码错误次数过多，请重新获取验证码');
    }
    // 删除已消费的验证码行：一次性使用防重复绑定；再次发码会重建该行
    db.prepare('DELETE FROM email_code WHERE email = ?').run(email);

    const existing = db.prepare('SELECT * FROM player WHERE email = ?').get(email);
    const token = crypto.randomUUID();
    let playerId;
    if (existing) {
      // 轮换令牌并刷新设备信息；ip_first 保留首次参与记录用于追溯
      db.prepare(
        `UPDATE player SET token = ?, user_agent = ?, device_type = ?,
         last_active_at = datetime('now', 'localtime') WHERE id = ?`
      ).run(token, ua, deviceType(ua), existing.id);
      playerId = existing.id;
    } else {
      const info = db
        .prepare(
          `INSERT INTO player (token, email, ip_first, ip_last, user_agent, device_type, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))`
        )
        .run(token, email, ip, ip, ua, deviceType(ua));
      playerId = Number(info.lastInsertRowid);
    }
    setSession(res, token);
    const act = currentActivity();
    res.json({
      email,
      activity: activityPayload(act),
      remaining: act ? remainingFor(playerId, act) : null,
      serverTime: db.prepare(`SELECT datetime('now', 'localtime') AS t`).get().t,
    });
  });

  // 会话恢复：老用户带有效 Cookie 直接返回邮箱与剩余次数，免重复填写
  router.get('/me', (req, res) => {
    const player = requirePlayer(req);
    const act = currentActivity();
    res.json({
      email: player.email,
      activity: activityPayload(act),
      remaining: act ? remainingFor(player.id, act) : null,
      serverTime: db.prepare(`SELECT datetime('now', 'localtime') AS t`).get().t,
    });
  });

  router.post('/draw', (req, res) => {
    const player = requirePlayer(req);
    const requestId = String((req.body && req.body.requestId) || '').trim();
    if (!requestId || requestId.length > 64) throw new ApiError(400, '请求参数缺失，请刷新页面重试');
    const ip = clientIp(req, cfg.trustProxy);

    // 幂等重放快捷路径：网络重试携带同一 requestId 时直接返回首次结果，不经过频控——
    // 频控只针对新请求防连点，不应拦住重试语义；未成功送达的中奖记录借机补发（mailer 内部限频兜底）
    const replayRow = db
      .prepare(
        `SELECT r.*, p.name AS prize_name, p.image AS prize_image, p.sort AS prize_sort
         FROM draw_record r JOIN prize p ON p.id = r.prize_id
         WHERE r.player_id = ? AND r.request_id = ?`
      )
      .get(player.id, requestId);
    if (replayRow) {
      const actNow = currentActivity();
      if (replayRow.is_win) {
        setImmediate(() => {
          sendPrizeEmail(db, replayRow.id).catch((e) => console.error('[邮件] 异步发送异常', e));
        });
      }
      // 重放同样按「启用奖品展示顺序」换算扇区序号（与正常抽奖一致）；极端场景：中奖奖品事后被
      // 停用导致不在展示列表，回退 0 号扇区，结果弹窗仍展示真实奖品与兑奖码
      const displayIds = actNow
        ? db.prepare('SELECT id FROM prize WHERE activity_id = ? AND enabled = 1 ORDER BY sort, id').all(actNow.id)
        : [];
      const segmentIndex = Math.max(0, displayIds.findIndex((d) => d.id === replayRow.prize_id));
      return res.json({
        isWin: !!replayRow.is_win,
        recordId: replayRow.id,
        prizeName: replayRow.prize_name,
        prizeImage: replayRow.prize_image || null,
        segmentIndex,
        prizeCode: replayRow.prize_code,
        mailStatus: replayRow.mail_status,
        remaining: actNow ? remainingFor(player.id, actNow) : null,
      });
    }

    // 频控一：单人最小间隔（默认 3 秒）——防手抖连点产生无效请求；幂等机制可兜底，提前拦截减少落库压力
    const nowMs = Date.now();
    const last = lastDrawAt.get(player.id) || 0;
    if (nowMs - last < MIN_DRAW_INTERVAL_MS) throw new ApiError(429, '操作过于频繁，请稍候再试');
    // 频控二：单 IP 每小时抽奖上限（默认 60 次）——公网部署防脚本批量刷奖
    const w = ipWindows.get(ip);
    if (!w || nowMs - w.start >= 3600 * 1000) {
      ipWindows.set(ip, { start: nowMs, count: 1 });
    } else {
      w.count += 1;
      if (w.count > MAX_DRAWS_PER_IP_PER_HOUR) throw new ApiError(429, '当前参与人数较多，请稍后再试');
    }

    const act = currentActivity();
    if (!act) throw new ApiError(500, '活动未配置，请联系组织者');
    const result = drawPrize(db, { player, activity: act, requestId, ip });
    if (!result.replay) lastDrawAt.set(player.id, nowMs);

    // 中奖邮件在抽奖事务提交后异步发送：事务内不做外部 IO，避免 SMTP 耗时拉长事务持锁时间。
    // 重放的中奖记录若此前发送失败，也借机补发（mailer 内部有 60 秒限频与状态判断兜底）
    if (result.record.is_win) {
      setImmediate(() => {
        sendPrizeEmail(db, result.record.id).catch((e) => console.error('[邮件] 异步发送异常', e));
      });
    }

    res.json({
      isWin: !!result.record.is_win,
      recordId: result.record.id,
      prizeName: result.prize.name,
      prizeImage: result.prize.image || null,
      segmentIndex: result.segmentIndex,
      prizeCode: result.record.prize_code,
      mailStatus: result.record.mail_status,
      remaining: remainingFor(player.id, act),
    });
  });

  // 重发中奖邮件：仅限本人中奖记录；60 秒限频由 mailer 原子条件更新保证
  router.post('/resend', async (req, res, next) => {
    try {
      const player = requirePlayer(req);
      const recordId = Number(req.body && req.body.recordId);
      const rec =
        Number.isInteger(recordId) && recordId > 0
          ? db.prepare('SELECT * FROM draw_record WHERE id = ? AND player_id = ?').get(recordId, player.id)
          : null;
      if (!rec || !rec.is_win) throw new ApiError(404, '记录不存在或无邮件可发送');
      const result = await sendPrizeEmail(db, rec.id);
      if (result.skipped === 'cooldown') throw new ApiError(429, '操作过于频繁，请 1 分钟后再试');
      const fresh = db.prepare('SELECT mail_status FROM draw_record WHERE id = ?').get(rec.id);
      res.json({
        mailStatus: fresh.mail_status,
        message:
          fresh.mail_status === 'sent'
            ? '邮件已发送，请查收（留意垃圾邮件）'
            : fresh.mail_status === 'failed'
              ? '发送失败，请稍后重试或联系组织者'
              : '已提交处理',
      });
    } catch (e) {
      next(e);
    }
  });

  // 我的记录：一次 JOIN 取奖品名，按时间倒序；单人活动期内记录数远低于 100 条上限
  router.get('/records', (req, res) => {
    const player = requirePlayer(req);
    const list = db
      .prepare(
        `SELECT r.id, r.is_win, r.prize_code, r.mail_status, r.drawn_at, p.name AS prize_name
         FROM draw_record r JOIN prize p ON p.id = r.prize_id
         WHERE r.player_id = ? ORDER BY r.id DESC LIMIT 100`
      )
      .all(player.id);
    res.json({ email: player.email, list });
  });

  return router;
};
