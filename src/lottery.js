'use strict';

/**
 * 抽奖判定服务：结果判定、扣库存、写记录在同一个同步事务内完成。
 * better-sqlite3 为同步 API，事务执行期间不存在其他请求交错，
 * 配合 SQLite 单写者模型，限次校验与扣库存天然无并发竞态，无需额外加锁。
 */
const crypto = require('crypto');
const { ApiError } = require('./errors');

// 兑奖码字符集剔除 I/L/O/0/1 等易混淆字符，降低人工抄写与客服核对出错率
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * 生成 8 位兑奖码（GQ-XXXX-XXXX 展示格式在邮件/前端拼接）。
 * 生成后查重再返回，UNIQUE 碰撞概率极低，重试兜底。
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string} 全局唯一兑奖码
 */
function genPrizeCode(db) {
  for (let i = 0; i < 5; i++) {
    let code = '';
    for (let j = 0; j < 8; j++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    const exists = db.prepare('SELECT 1 FROM draw_record WHERE prize_code = ?').get(code);
    if (!exists) return code;
  }
  throw new ApiError(500, '兑奖码生成失败，请重试');
}

/**
 * 执行一次抽奖判定。
 *
 * <p>业务时间线：幂等检查 → 活动状态/时间窗/黑名单校验 → 每日与总计限次校验 →
 * 有效奖品池权重抽取 → 中奖扣库存并生成兑奖码 → 写抽奖记录 → 维护参与者冗余计数。
 * 任意一步失败整体回滚，保证「扣库存」与「写记录」原子一致。</p>
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} p
 * @param {object} p.player 参与者行（requirePlayer 已校验存在）
 * @param {object} p.activity 当前活动行
 * @param {string} p.requestId 客户端幂等键（UUID）
 * @param {string} p.ip 客户端 IP（写入记录与参与者最近 IP）
 * @returns {{replay: boolean, record: object, prize: object}} replay=true 表示幂等重放
 * @throws {ApiError} 活动未开始/次数用尽/黑名单/奖品抽完等业务拒绝
 */
function drawPrize(db, { player, activity, requestId, ip }) {
  const run = db.transaction(() => {
    // 幂等重放：同一参与者携带同一 requestId 的重复请求（网络超时重试）返回首次结果，不重复扣次
    const existed = db
      .prepare('SELECT * FROM draw_record WHERE player_id = ? AND request_id = ?')
      .get(player.id, requestId);
    if (existed) {
      const prize = db.prepare('SELECT * FROM prize WHERE id = ?').get(existed.prize_id);
      return { replay: true, record: existed, prize };
    }

    // 活动状态与时间窗校验：时间以服务器本地时间为准，与后台配置格式同口径（字符串比较即可靠）
    if (activity.status !== 'published') throw new ApiError(400, '活动未开始或已结束');
    const nowStr = db.prepare(`SELECT substr(datetime('now', 'localtime'), 1, 16) AS n`).get().n;
    if (nowStr < activity.start_time || nowStr > activity.end_time) {
      throw new ApiError(400, '当前不在活动时间内');
    }
    if (player.blacklisted) throw new ApiError(403, '账号已被限制参与，如有疑问请联系组织者');

    // 限次校验：每日按当日记录数、活动总计按参与者冗余计数（事务内同步维护，与记录数始终一致）
    const dailyUsed = db
      .prepare(
        `SELECT COUNT(*) AS c FROM draw_record
         WHERE player_id = ? AND date(drawn_at) = date('now', 'localtime')`
      )
      .get(player.id).c;
    if (dailyUsed >= activity.daily_limit) throw new ApiError(400, '今日抽奖次数已用完，明天再来吧');
    if (player.draw_total >= activity.total_limit) throw new ApiError(400, '活动抽奖次数已用完');

    // 有效奖品池：启用中、有权重、库存未抽完（stock=-1 表示不限量）；
    // 已抽完的限量奖品退出概率归一化，剩余概率由其余奖品按权重重新分配
    const prizes = db
      .prepare(
        `SELECT * FROM prize
         WHERE activity_id = ? AND enabled = 1 AND weight > 0 AND (stock = -1 OR remaining > 0)
         ORDER BY sort, id`
      )
      .all(activity.id);
    if (prizes.length === 0) throw new ApiError(500, '奖品已抽完，请联系组织者');

    // 权重抽取：crypto 随机整数落在 [0, 总权重)，与「概率=权重/总权重」配置口径一致
    const totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
    let r = crypto.randomInt(totalWeight);
    let picked = prizes[prizes.length - 1];
    for (const p of prizes) {
      r -= p.weight;
      if (r < 0) {
        picked = p;
        break;
      }
    }

    const isWin = picked.type !== 'none';

    // 展示扇区序号：按「启用奖品」的展示顺序（sort,id）取下标，与 /api/activity 下发的转盘扇区
    // 顺序同源。不能用原始 sort 值——sort 存在重复/缺口时（如 7 个扇区出现 sort=7），前端按序号
    // 取模会错位停到别的扇区（本次「中六等奖动画停在一等奖」即此因）
    const displayPrizes = db
      .prepare('SELECT id FROM prize WHERE activity_id = ? AND enabled = 1 ORDER BY sort, id')
      .all(activity.id);
    const segmentIndex = Math.max(0, displayPrizes.findIndex((d) => d.id === picked.id));
    let prizeCode = null;
    if (isWin) {
      prizeCode = genPrizeCode(db);
      // 限量中奖先扣剩余库存再落记录；WHERE 带库存条件兜底并发，扣减失败则整体回滚
      if (picked.stock !== -1) {
        const upd = db
          .prepare('UPDATE prize SET remaining = remaining - 1 WHERE id = ? AND (stock = -1 OR remaining > 0)')
          .run(picked.id);
        if (upd.changes === 0) throw new ApiError(500, '奖品库存发生变化，请重试');
      }
    }

    // 写抽奖记录：email/ip 为发放与防作弊快照，与参与者当前值解耦，保证历史可追溯
    const info = db
      .prepare(
        `INSERT INTO draw_record (activity_id, player_id, prize_id, is_win, prize_code, email, ip, request_id, mail_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(activity.id, player.id, picked.id, isWin ? 1 : 0, prizeCode, player.email, ip, requestId, isWin ? 'pending' : null);

    // 同步维护参与者冗余计数与最近 IP：后台列表直接筛选排序，避免逐人聚合查询
    db.prepare(
      `UPDATE player SET draw_total = draw_total + 1, win_total = win_total + ?,
       ip_last = ?, last_active_at = datetime('now', 'localtime') WHERE id = ?`
    ).run(isWin ? 1 : 0, ip, player.id);

    const record = db.prepare('SELECT * FROM draw_record WHERE id = ?').get(info.lastInsertRowid);
    return { replay: false, record, prize: picked, segmentIndex };
  });
  return run();
}

module.exports = { drawPrize };
