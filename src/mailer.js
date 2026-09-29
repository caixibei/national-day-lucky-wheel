'use strict';

/**
 * 中奖邮件模块：nodemailer 封装 + 演练模式 + 重发限频。
 * SMTP 凭据只从环境变量读取（不写入代码库）；未配置 SMTP 或 MAIL_DRY_RUN=true 时进入演练模式，
 * 邮件内容打印到服务端日志、状态记为 simulated，保证无 SMTP 环境也能完整验证流程。
 */
const nodemailer = require('nodemailer');

let transporter = null;
let dryRun = true;
let mailFrom = '';

/**
 * 初始化邮件模块。SMTP 三要素（HOST/USER/PASS）任一缺失时强制演练模式并提示。
 *
 * @param {NodeJS.ProcessEnv} env 进程环境变量
 */
function initMailer(env) {
  mailFrom = env.MAIL_FROM || env.SMTP_USER || '';
  dryRun = env.MAIL_DRY_RUN === 'true' || !env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS;
  if (!dryRun) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 465),
      // 465 端口为隐式 TLS；587 等明文端口需显式关闭 secure
      secure: env.SMTP_SECURE !== 'false',
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
    console.log(`[邮件] SMTP 模式：${env.SMTP_HOST}:${env.SMTP_PORT || 465}，发件人 ${mailFrom}`);
  } else {
    transporter = null;
    console.log('[邮件] 演练模式（MAIL_DRY_RUN=true 或 SMTP 配置不完整）：中奖邮件仅打印日志，状态记为 simulated');
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * 构造中奖邮件主题与正文。
 *
 * @param {{activityName: string, prizeName: string, prizeCode: string}} m
 * @returns {{subject: string, html: string}}
 */
function buildPrizeMail({ activityName, prizeName, prizeCode }) {
  // 邮件正文使用内联样式：主流邮箱客户端会剥离 <style> 标签，内联是唯一可靠的样式方案
  const subject = `【国庆大转盘】恭喜您抽中「${prizeName}」`;
  const html = `
<div style="background:#FFF6E5;padding:24px;font-family:'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#D42A2A;border-radius:16px;padding:3px;">
    <div style="background:#FFFDF7;border-radius:13px;padding:28px 24px;text-align:center;">
      <h1 style="margin:0 0 12px;font-size:20px;color:#A31621;">🏮 国庆大转盘中奖通知</h1>
      <p style="margin:0 0 16px;color:#3B2B20;font-size:14px;">您在「${escapeHtml(activityName)}」中抽中了</p>
      <div style="font-size:22px;font-weight:700;color:#D42A2A;margin-bottom:16px;">${escapeHtml(prizeName)}</div>
      <p style="margin:0 0 8px;color:#3B2B20;font-size:14px;">您的兑奖码：</p>
      <div style="font-size:24px;font-weight:700;letter-spacing:4px;color:#A31621;background:#FFF3D6;border:1px dashed #D9A421;border-radius:8px;padding:10px;margin:0 24px 16px;">${escapeHtml(prizeCode)}</div>
      <p style="margin:0 0 6px;color:#3B2B20;font-size:13px;">请凭兑奖码按活动说明领取奖品。</p>
      <p style="margin:0;color:#8a7a6a;font-size:12px;">若未收到请检查垃圾邮件，或在抽奖页点击「重新发送」。本邮件由系统自动发送，请勿回复。</p>
    </div>
  </div>
</div>`;
  return { subject, html };
}

/**
 * 发送指定抽奖记录的中奖邮件并回写发送状态。
 *
 * <p>状态流转：pending（待发）→ sent（成功）/ failed（失败，记录原因）/ simulated（演练模式）。
 * 发送为外部 IO，必须在抽奖事务提交后调用（调用方负责），避免 SMTP 耗时拉长事务持锁时间。</p>
 *
 * <p>限频与跳过规则：</p>
 * <ul>
 *   <li>非中奖记录或已 sent 的记录直接跳过；</li>
 *   <li>60 秒内已有发送尝试则跳过（原子条件更新实现，防连点与接口重试轰炸 SMTP）；</li>
 *   <li>失败不抛出异常，原因落库 mail_fail_reason 供后台筛选与重发。</li>
 * </ul>
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} recordId 抽奖记录 ID
 * @returns {Promise<{status?: string, reason?: string, skipped?: string}>}
 */
async function sendPrizeEmail(db, recordId) {
  // 一次 JOIN 取齐记录、奖品名与活动名；非中奖或已发送的记录直接跳过
  const rec = db
    .prepare(
      `SELECT r.id, r.is_win, r.mail_status, r.email, r.prize_code,
              p.name AS prize_name, a.name AS activity_name
       FROM draw_record r
       JOIN prize p ON p.id = r.prize_id
       JOIN activity a ON a.id = r.activity_id
       WHERE r.id = ?`
    )
    .get(recordId);
  if (!rec || !rec.is_win) return { skipped: 'not-win' };
  if (rec.mail_status === 'sent') return { skipped: 'already-sent' };

  // 重发限频：仅当距上次尝试超过 60 秒才允许占用发送资格（changes=0 即命中限频）
  const claim = db
    .prepare(
      `UPDATE draw_record SET mail_status = 'pending', mail_last_attempt = datetime('now', 'localtime')
       WHERE id = ? AND (mail_last_attempt IS NULL OR mail_last_attempt <= datetime('now', 'localtime', '-60 seconds'))`
    )
    .run(recordId);
  if (claim.changes === 0) return { skipped: 'cooldown' };

  const mail = buildPrizeMail({
    activityName: rec.activity_name,
    prizeName: rec.prize_name,
    prizeCode: rec.prize_code,
  });

  // 演练模式：只写日志并标记 simulated（区别于 sent），保留用户与后台的重发入口
  if (dryRun) {
    console.log(`[邮件演练] 收件人=${rec.email} 主题=${mail.subject} 兑奖码=${rec.prize_code}`);
    db.prepare(`UPDATE draw_record SET mail_status = 'simulated' WHERE id = ?`).run(recordId);
    return { status: 'simulated' };
  }

  try {
    await transporter.sendMail({ from: mailFrom, to: rec.email, subject: mail.subject, html: mail.html });
    db.prepare(
      `UPDATE draw_record SET mail_status = 'sent', mail_sent_at = datetime('now', 'localtime'),
       mail_fail_reason = NULL WHERE id = ?`
    ).run(recordId);
    console.log(`[邮件] 已发送 recordId=${recordId}`);
    return { status: 'sent' };
  } catch (err) {
    // 发送失败不中断业务：原因截断 200 字符落库，状态 failed 供后台筛选与重发
    const reason = String((err && err.message) || err).slice(0, 200);
    db.prepare(`UPDATE draw_record SET mail_status = 'failed', mail_fail_reason = ? WHERE id = ?`).run(reason, recordId);
    console.error(`[邮件] 发送失败 recordId=${recordId}：${reason}`);
    return { status: 'failed', reason };
  }
}

module.exports = { initMailer, sendPrizeEmail, isDryRun: () => dryRun };
