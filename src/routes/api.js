'use strict';

/**
 * 用户端 API：参与者注册/找回（邮箱即身份）、会话恢复、抽奖、中奖邮件重发、我的记录。
 * 前端与 API 同源部署，参与者身份通过 HttpOnly Cookie（lw_token）保持，不经 localStorage。
 */
const express = require('express');
const crypto = require('crypto');
const { ApiError } = require('../errors');
const { drawPrize } = require('../lottery');
const { sendPrizeEmail } = require('../mailer');
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

  // 进程内频控计数器：单进程部署下精确可用；重启清零只影响频控精度，不影响落库的限次规则。
  // 定期清理过期窗口，防止长时间运行内存增长（unref 保证不阻塞进程退出）
  const lastDrawAt = new Map();
  const ipWindows = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of ipWindows) if (now - w.start >= 3600 * 1000) ipWindows.delete(ip);
  }, 10 * 60 * 1000).unref();

  function deviceType(ua) {
    const s = String(ua || '').toLowerCase();
    if (/ipad|tablet/.test(s)) return 'tablet';
    if (/mobile|android|iphone/.test(s)) return 'mobile';
    return 'pc';
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

  // 注册/找回：邮箱即身份。已存在则轮换令牌绑定同一账号——换设备凭邮箱可找回记录，旧设备会话随之失效
  router.post('/player', (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      throw new ApiError(400, '请填写正确的邮箱地址，奖品将通过邮件发送至该邮箱');
    }
    const ip = clientIp(req, cfg.trustProxy);
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const existing = db.prepare('SELECT * FROM player WHERE email = ?').get(email);
    if (existing && existing.blacklisted) {
      throw new ApiError(403, '该邮箱已被限制参与，如有疑问请联系组织者');
    }

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
