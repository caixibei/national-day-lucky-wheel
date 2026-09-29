'use strict';

/**
 * 管理端 API：登录鉴权、活动配置、奖品 CRUD、参与者管理与导出、抽奖记录查询与导出、邮件重发。
 * 除登录外全部要求 session 鉴权；列表与导出共用同一筛选构造，保证「所见即所得」的导出口径。
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { ApiError } = require('../errors');
const { sendPrizeEmail } = require('../mailer');
const { clientIp, maskEmail, toCsv } = require('../util');

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 单次导出行数上限：活动量级（数千条）远低于该值，仅作内存保护
const EXPORT_LIMIT = 50000;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{trustProxy: boolean}} cfg
 */
module.exports = function adminRouter(db, cfg) {
  const router = express.Router();

  // 登录失败限频：同 IP 10 分钟内 5 次失败后锁定——公网部署防暴力破解
  const loginFails = new Map();
  const MAX_LOGIN_FAILS = 5;
  const LOGIN_WINDOW_MS = 10 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of loginFails) if (now - f.start >= LOGIN_WINDOW_MS) loginFails.delete(ip);
  }, 10 * 60 * 1000).unref();

  function requireAuth(req, res, next) {
    if (!req.session || !req.session.admin) return res.status(401).json({ message: '请先登录' });
    next();
  }

  router.post('/login', (req, res) => {
    const ip = clientIp(req, cfg.trustProxy);
    // 限频先于凭据校验：锁定窗口内即使密码正确也拒绝，防止绕过
    const f = loginFails.get(ip);
    if (f && Date.now() - f.start < LOGIN_WINDOW_MS && f.count >= MAX_LOGIN_FAILS) {
      throw new ApiError(429, '失败次数过多，请 10 分钟后再试');
    }
    const { username, password } = req.body || {};
    const user =
      typeof username === 'string' && username.trim()
        ? db.prepare('SELECT * FROM admin_user WHERE username = ?').get(username.trim())
        : null;
    // 统一报错文案：不区分「用户不存在/密码错误」，避免账号枚举
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
      const cur = f && Date.now() - f.start < LOGIN_WINDOW_MS ? f : { start: Date.now(), count: 0 };
      cur.count += 1;
      loginFails.set(ip, cur);
      throw new ApiError(401, '用户名或密码错误');
    }
    loginFails.delete(ip);
    req.session.admin = { id: user.id, username: user.username };
    res.json({ username: user.username });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // 会话有效性探测：前端刷新后据此恢复登录态
  router.get('/me', requireAuth, (req, res) => {
    res.json({ username: req.session.admin.username });
  });

  // —— 活动配置 ——
  router.get('/activity', requireAuth, (req, res) => {
    const act = db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 1').get();
    res.json({ activity: act || null });
  });

  router.put('/activity', requireAuth, (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const start = String(b.start_time || '').trim();
    const end = String(b.end_time || '').trim();
    const daily = Number(b.daily_limit);
    const total = Number(b.total_limit);
    const status = String(b.status || '');
    if (!name || name.length > 50) throw new ApiError(400, '活动名称需为 1~50 个字符');
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new ApiError(400, '时间格式需为 YYYY-MM-DD HH:MM');
    if (start >= end) throw new ApiError(400, '结束时间必须晚于开始时间');
    if (!Number.isInteger(daily) || daily < 1 || daily > 50) throw new ApiError(400, '每人每日次数需为 1~50');
    if (!Number.isInteger(total) || total < 1 || total > 200) throw new ApiError(400, '活动总次数需为 1~200');
    if (!['draft', 'published', 'closed'].includes(status)) throw new ApiError(400, '活动状态不合法');
    const act = db.prepare('SELECT id FROM activity ORDER BY id DESC LIMIT 1').get();
    if (!act) throw new ApiError(500, '活动不存在，请重启服务完成初始化');
    db.prepare(
      'UPDATE activity SET name = ?, start_time = ?, end_time = ?, daily_limit = ?, total_limit = ?, status = ? WHERE id = ?'
    ).run(name, start, end, daily, total, status, act.id);
    res.json({ ok: true });
  });

  // —— 奖品 CRUD ——
  router.get('/prizes', requireAuth, (req, res) => {
    const act = db.prepare('SELECT id FROM activity ORDER BY id DESC LIMIT 1').get();
    if (!act) return res.json({ list: [] });
    // 后台列表包含已停用项（管理需要）；参与者端只展示启用项
    const list = db.prepare('SELECT * FROM prize WHERE activity_id = ? ORDER BY sort, id').all(act.id);
    res.json({ list });
  });

  /**
   * 校验并归一化奖品表单。
   * 「谢谢参与」（type=none）不占库存，库存强制为 -1（不限量）。
   */
  function validatePrize(b, activityId, selfId) {
    const name = String(b.name || '').trim();
    const type = String(b.type || '');
    const weight = Number(b.weight);
    const sort = Number(b.sort);
    const enabled = b.enabled === undefined ? 1 : (b.enabled ? 1 : 0);
    const image = String(b.image || '').trim();
    const stockRaw = b.stock === undefined || b.stock === null || b.stock === '' ? -1 : Number(b.stock);
    if (!name || name.length > 20) throw new ApiError(400, '奖品名称需为 1~20 个字符');
    if (!['virtual', 'none'].includes(type)) throw new ApiError(400, '奖品类型不合法');
    if (!Number.isInteger(weight) || weight < 0 || weight > 10000) throw new ApiError(400, '权重需为 0~10000 的整数');
    if (!Number.isInteger(sort) || sort < 0 || sort > 99) throw new ApiError(400, '扇区顺序需为 0~99 的整数');
    if (image && !/^(https?:\/\/|\/)/.test(image)) throw new ApiError(400, '图片需为 http(s) 链接或站内路径');
    const stock = type === 'none' ? -1 : stockRaw;
    if (stock !== -1 && !(Number.isInteger(stock) && stock >= 0 && stock <= 1000000)) {
      throw new ApiError(400, '库存需为 -1（不限量）或 0~1000000 的整数');
    }
    // 转盘扇区上限 12：扇区过多会导致文字与点击区过小，影响可读性
    const enabledCount = db
      .prepare('SELECT COUNT(*) AS c FROM prize WHERE activity_id = ? AND enabled = 1 AND id != ?')
      .get(activityId, selfId ?? -1).c;
    if (enabled && enabledCount >= 12) throw new ApiError(400, '启用中的奖品最多 12 个（转盘扇区上限）');
    return { name, type, weight, stock, sort, enabled, image: image.slice(0, 300) };
  }

  router.post('/prizes', requireAuth, (req, res) => {
    const act = db.prepare('SELECT id FROM activity ORDER BY id DESC LIMIT 1').get();
    if (!act) throw new ApiError(500, '活动不存在，请重启服务完成初始化');
    const v = validatePrize(req.body || {}, act.id, null);
    // 新建奖品剩余库存与总库存一致（不限量为 -1）
    const info = db
      .prepare(
        'INSERT INTO prize (activity_id, name, type, weight, stock, remaining, image, sort, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(act.id, v.name, v.type, v.weight, v.stock, v.stock, v.image || null, v.sort, v.enabled);
    res.json({ id: Number(info.lastInsertRowid) });
  });

  // :id 路由统一加数字约束：避免 /players/export 之类的静态路径被 :id 捕获（id="export" 会查无此人）
  router.put('/prizes/:id(\\d+)', requireAuth, (req, res) => {
    const prize = db.prepare('SELECT * FROM prize WHERE id = ?').get(Number(req.params.id));
    if (!prize) throw new ApiError(404, '奖品不存在');
    const act = db.prepare('SELECT id FROM activity ORDER BY id DESC LIMIT 1').get();
    const v = validatePrize(req.body || {}, act.id, prize.id);
    // 库存调整按差额同步剩余量：补货（库存增加）按差额恢复可抽数量，已抽出的部分不凭空恢复
    let remaining;
    if (v.stock === -1) {
      remaining = -1;
    } else if (prize.stock === -1) {
      remaining = v.stock;
    } else {
      remaining = Math.max(0, prize.remaining + (v.stock - prize.stock));
    }
    db.prepare('UPDATE prize SET name = ?, type = ?, weight = ?, stock = ?, remaining = ?, image = ?, sort = ?, enabled = ? WHERE id = ?')
      .run(v.name, v.type, v.weight, v.stock, remaining, v.image || null, v.sort, v.enabled, prize.id);
    res.json({ ok: true });
  });

  router.delete('/prizes/:id(\\d+)', requireAuth, (req, res) => {
    const prize = db.prepare('SELECT * FROM prize WHERE id = ?').get(Number(req.params.id));
    if (!prize) throw new ApiError(404, '奖品不存在');
    // 已产生抽奖记录的奖品只停用不删除：保留记录外键与历史统计完整性
    const used = db.prepare('SELECT COUNT(*) AS c FROM draw_record WHERE prize_id = ?').get(prize.id).c;
    if (used > 0) {
      db.prepare('UPDATE prize SET enabled = 0 WHERE id = ?').run(prize.id);
      return res.json({ disabled: true, message: '该奖品已有抽奖记录，已改为停用' });
    }
    db.prepare('DELETE FROM prize WHERE id = ?').run(prize.id);
    res.json({ deleted: true });
  });

  // —— 参与者管理 ——
  function buildPlayerWhere(q) {
    const cond = [];
    const params = [];
    if (q.keyword) {
      cond.push('email LIKE ?');
      params.push(`%${String(q.keyword).trim()}%`);
    }
    if (q.ip) {
      cond.push('(ip_last LIKE ? OR ip_first LIKE ?)');
      params.push(`%${String(q.ip).trim()}%`, `%${String(q.ip).trim()}%`);
    }
    if (q.blacklisted === '1') cond.push('blacklisted = 1');
    if (DATE_RE.test(String(q.startDate || ''))) {
      cond.push('date(created_at) >= ?');
      params.push(q.startDate);
    }
    if (DATE_RE.test(String(q.endDate || ''))) {
      cond.push('date(created_at) <= ?');
      params.push(q.endDate);
    }
    return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', params };
  }

  router.get('/players', requireAuth, (req, res) => {
    const { where, params } = buildPlayerWhere(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 20;
    // COUNT 与明细使用同一 WHERE：保证分页总数与筛选口径一致
    const total = db.prepare(`SELECT COUNT(*) AS c FROM player ${where}`).get(...params).c;
    const list = db
      .prepare(`SELECT * FROM player ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);
    // 列表邮箱脱敏展示；token 为会话凭据不外发，按最小暴露原则剔除
    res.json({
      total, page, pageSize,
      list: list.map((p) => {
        const { token, ...rest } = p;
        return { ...rest, email: maskEmail(rest.email) };
      }),
    });
  });

  router.get('/players/:id(\\d+)', requireAuth, (req, res) => {
    const player = db.prepare('SELECT * FROM player WHERE id = ?').get(Number(req.params.id));
    if (!player) throw new ApiError(404, '参与者不存在');
    // 详情页展示完整邮箱与全部抽奖记录：组织者核对奖品发放与排查争议的依据；token 不外发
    const { token, ...playerSafe } = player;
    const records = db
      .prepare(
        `SELECT r.id, r.is_win, r.prize_code, r.ip, r.mail_status, r.mail_fail_reason, r.drawn_at, p.name AS prize_name
         FROM draw_record r JOIN prize p ON p.id = r.prize_id
         WHERE r.player_id = ? ORDER BY r.id DESC LIMIT 200`
      )
      .all(player.id);
    res.json({ player: playerSafe, records });
  });

  router.put('/players/:id(\\d+)/blacklist', requireAuth, (req, res) => {
    const player = db.prepare('SELECT * FROM player WHERE id = ?').get(Number(req.params.id));
    if (!player) throw new ApiError(404, '参与者不存在');
    const b = req.body || {};
    const blacklisted = b.blacklisted === undefined ? player.blacklisted : (b.blacklisted ? 1 : 0);
    const remark = b.remark === undefined ? player.remark : String(b.remark || '').slice(0, 200);
    // 拉黑后参与者侧所有抽奖/重发请求被 requirePlayer 拦截，即时生效
    db.prepare('UPDATE player SET blacklisted = ?, remark = ? WHERE id = ?').run(blacklisted, remark, player.id);
    res.json({ ok: true, blacklisted });
  });

  // —— 抽奖记录 ——
  const RECORD_SELECT = `
    SELECT r.id, r.is_win, r.prize_code, r.email, r.ip, r.mail_status, r.mail_fail_reason, r.drawn_at,
           p.name AS prize_name, pl.blacklisted
    FROM draw_record r
    JOIN prize p ON p.id = r.prize_id
    JOIN player pl ON pl.id = r.player_id`;

  function buildRecordWhere(q) {
    const cond = [];
    const params = [];
    if (q.email) {
      cond.push('r.email LIKE ?');
      params.push(`%${String(q.email).trim()}%`);
    }
    if (q.prizeId && Number(q.prizeId) > 0) {
      cond.push('r.prize_id = ?');
      params.push(Number(q.prizeId));
    }
    if (q.isWin === '0' || q.isWin === '1') {
      cond.push('r.is_win = ?');
      params.push(Number(q.isWin));
    }
    if (['pending', 'sent', 'failed', 'simulated'].includes(String(q.mailStatus || ''))) {
      cond.push('r.mail_status = ?');
      params.push(q.mailStatus);
    }
    if (DATE_RE.test(String(q.startDate || ''))) {
      cond.push('date(r.drawn_at) >= ?');
      params.push(q.startDate);
    }
    if (DATE_RE.test(String(q.endDate || ''))) {
      cond.push('date(r.drawn_at) <= ?');
      params.push(q.endDate);
    }
    return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', params };
  }

  router.get('/records', requireAuth, (req, res) => {
    const { where, params } = buildRecordWhere(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 20;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM draw_record r JOIN player pl ON pl.id = r.player_id ${where}`).get(...params).c;
    const list = db
      .prepare(`${RECORD_SELECT} ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);
    res.json({ total, page, pageSize, list });
  });

  // 列表与导出共用 buildRecordWhere：保证导出数据与页面所见筛选口径一致
  router.get('/records/export', requireAuth, (req, res) => {
    const { where, params } = buildRecordWhere(req.query);
    const rows = db.prepare(`${RECORD_SELECT} ${where} ORDER BY r.id DESC LIMIT ${EXPORT_LIMIT}`).all(...params);
    const csv = toCsv(
      ['记录ID', '邮箱', '奖品', '结果', '兑奖码', 'IP', '邮件状态', '失败原因', '抽奖时间'],
      rows.map((r) => [
        r.id, r.email, r.prize_name, r.is_win ? '中奖' : '未中奖', r.prize_code || '',
        r.ip || '', r.mail_status || '', r.mail_fail_reason || '', r.drawn_at,
      ])
    );
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="draw-records.csv"` });
    res.send(csv);
  });

  router.get('/players/export', requireAuth, (req, res) => {
    const { where, params } = buildPlayerWhere(req.query);
    const rows = db.prepare(`SELECT * FROM player ${where} ORDER BY id DESC LIMIT ${EXPORT_LIMIT}`).all(...params);
    const csv = toCsv(
      ['ID', '邮箱', '首次IP', '最近IP', '设备类型', '累计抽奖', '累计中奖', '黑名单', '备注', '首次参与时间', '最近活跃时间'],
      rows.map((p) => [
        p.id, p.email, p.ip_first || '', p.ip_last || '', p.device_type || '',
        p.draw_total, p.win_total, p.blacklisted ? '是' : '否', p.remark || '', p.created_at, p.last_active_at || '',
      ])
    );
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="players.csv"` });
    res.send(csv);
  });

  // 后台手动重发中奖邮件：与用户端共用 mailer（60 秒限频同样生效，防误点轰炸 SMTP）
  router.post('/records/:id(\\d+)/resend', requireAuth, async (req, res, next) => {
    try {
      const rec = db.prepare('SELECT * FROM draw_record WHERE id = ?').get(Number(req.params.id));
      if (!rec || !rec.is_win) throw new ApiError(404, '记录不存在或无邮件可发送');
      const result = await sendPrizeEmail(db, rec.id);
      if (result.skipped === 'cooldown') throw new ApiError(429, '距上次发送不足 60 秒，请稍后再试');
      const fresh = db.prepare('SELECT mail_status FROM draw_record WHERE id = ?').get(rec.id);
      res.json({ mailStatus: fresh.mail_status });
    } catch (e) {
      next(e);
    }
  });

  return router;
};
