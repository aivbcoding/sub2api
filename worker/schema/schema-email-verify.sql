-- ============================================================
-- 邮箱验证码 + 发送日志 (注册 / 密码重置 / 邮箱绑定)
-- 用法: npx wrangler d1 execute sub2api --file=./schema/schema-email-verify.sql --remote -y
--       npx wrangler d1 execute sub2api --file=./schema/schema-email-verify.sql --local  -y
--
-- 背景:
--   自助注册加"邮箱验证码"后, 需要一个表保存验证码的**状态机**
--   (PENDING -> ACTIVE -> USED / FAILED / EXPIRED / INVALIDATED),
--   以及一张发送日志表做**精确限流**(同邮箱 60s 一次 / 10min 5 次 / 同 IP 10min 20 次)。
--
-- 设计要点:
--   1. 验证码**不存明文**, 只存 code_hash (HMAC-SHA256 pepper+email+purpose+code+id,
--      见 src/verify-code.ts)。数据库泄露也不可逆推验证码。
--   2. code_hash 不带 UNIQUE —— 明文 6 位数字只有 100 万种组合, 哈希碰撞在
--      同 email+purpose 里几乎不存在; 且同邮箱可多次发送(不同 id -> 不同 hash)。
--   3. request_id 在全链路(Sub2API -> mail Worker -> Resend)里贯穿, 用于幂等,
--      所以建 UNIQUE 索引防止重复。
--   4. 同一 email+purpose 同一时刻只允许一个 ACTIVE 验证码: 靠"激活前把旧的
--      ACTIVE 全部置 INVALIDATED"这条写入顺序保证(见 src/verify-code.ts 状态机)。
--   5. 过期数据不常清理: 惰性 —— 查询时 `expires_at > now` 过滤, 发送新码时
--      顺手把旧 ACTIVE 置为 INVALIDATED。真正垃圾回收留给运维按需跑 DELETE。
-- ============================================================

-- ---------- 验证码主表 ----------
CREATE TABLE IF NOT EXISTS email_verify_codes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id       TEXT    NOT NULL,                 -- 全链路 Request ID (UUID)
  email            TEXT    NOT NULL,                 -- 原始邮箱(脱敏展示用)
  email_normalized TEXT    NOT NULL,                 -- 规范化邮箱(小写+trim), 限流/查重用
  purpose          TEXT    NOT NULL,                 -- REGISTER | PASSWORD_RESET | EMAIL_BIND
  code_hash        TEXT    NOT NULL,                 -- HMAC-SHA256(pepper, purpose:email:code:id)
  status           TEXT    NOT NULL DEFAULT 'PENDING',
                                                    -- PENDING(已生成未发成功) | ACTIVE(可验证)
                                                    -- USED | FAILED | EXPIRED | INVALIDATED
  attempts         INTEGER NOT NULL DEFAULT 0,       -- 错误尝试次数, >=5 自动置为 FAILED
  expires_at       TEXT    NOT NULL,                 -- ISO8601 UTC; 过期后验证按 EXPIRED 处理
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  activated_at     TEXT,                             -- PENDING -> ACTIVE 时间
  used_at          TEXT                              -- ACTIVE -> USED 时间
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verify_request_id ON email_verify_codes(request_id);
CREATE INDEX IF NOT EXISTS idx_email_verify_lookup
  ON email_verify_codes(email_normalized, purpose, status);

-- ---------- 发送日志(限流统计) ----------
CREATE TABLE IF NOT EXISTS email_verify_send_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      TEXT    NOT NULL,                 -- 与主表同一条 request_id
  purpose         TEXT    NOT NULL,
  email_hash      TEXT    NOT NULL,                 -- HMAC 哈希(日志不许存明文邮箱)
  client_ip_hash  TEXT    NOT NULL,                 -- HMAC 哈希(日志不许存明文 IP)
  status          TEXT    NOT NULL DEFAULT 'SENT',  -- SENT | FAILED
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_verify_send_logs_email
  ON email_verify_send_logs(email_hash, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_verify_send_logs_ip
  ON email_verify_send_logs(client_ip_hash, created_at);