'use strict';

/**
 * SQLite 数据层：连接初始化、WAL 参数、建表与首次启动种子数据。
 * 数据库为单文件（data/lucky.db），随目录拷贝即完成迁移备份。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  start_time  TEXT    NOT NULL,
  end_time    TEXT    NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 1,
  total_limit INTEGER NOT NULL DEFAULT 3,
  status      TEXT    NOT NULL DEFAULT 'draft',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS prize (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES activity(id),
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL DEFAULT 'virtual',
  weight      INTEGER NOT NULL DEFAULT 10,
  stock       INTEGER NOT NULL DEFAULT -1,
  remaining   INTEGER NOT NULL DEFAULT -1,
  image       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_prize_activity ON prize(activity_id);

CREATE TABLE IF NOT EXISTS player (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT    NOT NULL UNIQUE,
  email          TEXT    NOT NULL UNIQUE,
  ip_first       TEXT,
  ip_last        TEXT,
  user_agent     TEXT,
  device_type    TEXT,
  draw_total     INTEGER NOT NULL DEFAULT 0,
  win_total      INTEGER NOT NULL DEFAULT 0,
  blacklisted    INTEGER NOT NULL DEFAULT 0,
  remark         TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  last_active_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_player_ip   ON player(ip_last);
CREATE INDEX IF NOT EXISTS idx_player_time ON player(created_at);

CREATE TABLE IF NOT EXISTS draw_record (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id        INTEGER NOT NULL REFERENCES activity(id),
  player_id          INTEGER NOT NULL REFERENCES player(id),
  prize_id           INTEGER NOT NULL REFERENCES prize(id),
  is_win             INTEGER NOT NULL,
  prize_code         TEXT UNIQUE,
  email              TEXT    NOT NULL,
  ip                 TEXT,
  request_id         TEXT    NOT NULL,
  mail_status        TEXT,
  mail_last_attempt  TEXT,
  mail_fail_reason   TEXT,
  mail_sent_at       TEXT,
  drawn_at           TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_record_idem      ON draw_record(player_id, request_id);
CREATE INDEX IF NOT EXISTS idx_record_player          ON draw_record(player_id);
CREATE INDEX IF NOT EXISTS idx_record_prize           ON draw_record(prize_id);
CREATE INDEX IF NOT EXISTS idx_record_time            ON draw_record(drawn_at);
CREATE INDEX IF NOT EXISTS idx_record_mail_status     ON draw_record(mail_status);

-- 邮箱验证码：注册前的可收信性校验。每邮箱一行，重复发码覆盖旧码并重置次数与时效；
-- send_date/send_count 记录当日已发码次数，用于单邮箱每日上限
CREATE TABLE IF NOT EXISTS email_code (
  email        TEXT    NOT NULL PRIMARY KEY,
  code         TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  ip           TEXT,
  last_sent_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  send_date    TEXT,
  send_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_email_code_ip ON email_code(ip, last_sent_at);
`;

/**
 * 轻量迁移：email_code 表若创建于引入「每日发码上限」之前，补齐 send_date/send_count 两列。
 * CREATE TABLE IF NOT EXISTS 不会为已存在的表补列，须用 PRAGMA 探测后 ALTER；
 * 老数据 send_date 为 NULL，首次发码按新一天起算，不会被误判超限。
 *
 * @param {import('better-sqlite3').Database} db
 */
function migrateEmailCode(db) {
  const cols = db.prepare('PRAGMA table_info(email_code)').all().map((c) => c.name);
  if (cols.length > 0 && !cols.includes('send_date')) {
    db.exec(`ALTER TABLE email_code ADD COLUMN send_date TEXT`);
    db.exec(`ALTER TABLE email_code ADD COLUMN send_count INTEGER NOT NULL DEFAULT 0`);
    console.log('[迁移] email_code 表已补齐 send_date/send_count 列（单邮箱每日发码上限）');
  }
}

/**
 * 初始化数据库连接并完成建表与种子数据。
 *
 * @param {string} dbPath SQLite 数据文件路径
 * @returns {import('better-sqlite3').Database} 数据库连接实例
 */
function initDb(dbPath) {
  // 数据目录随启动创建，避免首次部署因目录缺失而失败
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL 模式：读写不互斥；抽奖写事务毫秒级完成，足以承载活动峰值
  db.pragma('journal_mode = WAL');
  // 抽奖涉及多表关联写入，启用外键强制约束防止脏数据
  db.pragma('foreign_keys = ON');
  // 写锁等待 5 秒：覆盖偶发 WAL 检查点写入，避免活动峰值时直接抛 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrateEmailCode(db);
  seed(db);
  return db;
}

/**
 * 首次启动种子数据：管理员账号与示例活动/奖品。
 * 仅在对应表为空时写入，重复启动不覆盖已有数据。
 *
 * @param {import('better-sqlite3').Database} db
 */
function seed(db) {
  // 管理员账号：密码优先取环境变量；未配置时生成随机密码并只打印一次——
  // 公网部署不允许出现 admin/admin 之类的默认弱口令
  const hasAdmin = db.prepare('SELECT COUNT(*) AS c FROM admin_user').get().c > 0;
  if (!hasAdmin) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const envPwd = process.env.ADMIN_PASSWORD;
    const useEnv = typeof envPwd === 'string' && envPwd.length >= 8;
    const password = useEnv ? envPwd : crypto.randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO admin_user (username, password_hash) VALUES (?, ?)').run(
      username,
      bcrypt.hashSync(password, 10)
    );
    if (useEnv) {
      console.log(`[初始化] 管理员账号 ${username} 已创建，密码来自环境变量 ADMIN_PASSWORD`);
    } else {
      console.log(
        `[初始化] 管理员账号 ${username} 已创建，随机密码：${password}（仅此一次打印，请立即保存）`
      );
    }
  }

  // 示例活动与奖品：目的是首次启动即可完整体验闭环，正式使用前在后台修改
  const hasActivity = db.prepare('SELECT COUNT(*) AS c FROM activity').get().c > 0;
  if (!hasActivity) {
    const info = db.prepare(
      `INSERT INTO activity (name, start_time, end_time, daily_limit, total_limit, status)
       VALUES (?, ?, ?, ?, ?, 'published')`
    ).run('2026 国庆大转盘', '2026-09-29 00:00', '2026-10-08 23:59', 1, 3);
    // 权重决定中奖概率（概率=权重/总权重）；「谢谢参与」weight 最大，保证示例概率体感合理
    const prizes = [
      ['一等奖 · 国庆礼盒', 'virtual', 2, 5, 0],
      ['二等奖 · 50元红包', 'virtual', 8, 20, 1],
      ['三等奖 · 10元红包', 'virtual', 15, 50, 2],
      ['幸运奖 · 国庆贴纸', 'virtual', 25, 200, 3],
      ['谢谢参与', 'none', 50, -1, 4],
    ];
    const ins = db.prepare(
      'INSERT INTO prize (activity_id, name, type, weight, stock, remaining, sort) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    db.transaction(() => {
      for (const [name, type, weight, stock, sort] of prizes) {
        ins.run(info.lastInsertRowid, name, type, weight, stock, stock, sort);
      }
    })();
    console.log('[初始化] 已写入示例活动与 5 个示例奖品，可在管理后台修改');
  }
}

module.exports = { initDb };
