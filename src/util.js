'use strict';

/**
 * 共享小工具：客户端 IP 解析、邮箱脱敏、CSV 序列化。
 * 被用户端与管理端路由共同复用，保证 IP 取值与脱敏口径一致。
 */

/**
 * 解析客户端真实 IP。
 *
 * <p>信任代理时取 X-Forwarded-For 第一跳（即最原始客户端地址），用于频控与防作弊追溯；
 * 直连场景取 socket 地址并剥离 IPv6 映射前缀，保证同一设备取值稳定。</p>
 *
 * @param {import('express').Request} req
 * @param {boolean} trustProxy 是否启用了反向代理（TRUST_PROXY=true）
 * @returns {string} 客户端 IP；无法取得时返回 unknown
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '') || 'unknown';
}

/**
 * 邮箱脱敏：保留本地段前 2 位，其余以 *** 代替，域名完整保留。
 * 用于后台列表展示，降低截图/批量浏览场景的完整邮箱暴露面。
 *
 * @param {string} email 完整邮箱
 * @returns {string} 脱敏后的邮箱，如 ab***@qq.com
 */
function maskEmail(email) {
  const raw = String(email || '');
  const at = raw.indexOf('@');
  if (at <= 0) return '***';
  const head = raw.slice(0, Math.min(2, at));
  return `${head}***${raw.slice(at)}`;
}

/**
 * 序列化为 CSV 文本（含 UTF-8 BOM）。
 *
 * <p>BOM 保证 Excel 直接打开中文不乱码；值内包含逗号、引号或换行时按 RFC 4180 加引号转义，
 * 防止备注等自由文本破坏列结构。</p>
 *
 * @param {string[]} headers 表头
 * @param {Array<Array<*>>} rows 数据行
 * @returns {string} 可直接写入响应的 CSV 文本
 */
function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}

module.exports = { clientIp, maskEmail, toCsv };
