-- ============================================================
-- 每日签到
-- 用法: npx wrangler d1 execute sub2api --file=./schema/schema-user-checkins.sql --remote -y
--       npx wrangler d1 execute sub2api --file=./schema/schema-user-checkins.sql --local  -y
--
-- 背景:
--   「个人资料」页新增每日签到, 点击后随机加余额 100~200。
--   需要一张表记录"谁在哪天签过了", 否则刷新页面就能重复领。
--
-- 设计要点:
--   1. 主键是 (user_id, day) —— **判重靠主键冲突, 不靠先查后写**。
--      先 SELECT 再 INSERT 在并发下会双双通过检查(同一人两连点即可复现),
--      这里用 INSERT ... ON CONFLICT DO NOTHING + changes 判定是否首次。
--   2. `day` 存的是**北京时区**的日期串(YYYY-MM-DD), 由应用层算好 ——
--      用 SQLite 的 date('now') 会按 UTC 切天, 北京时间凌晨签到会被算进前一天。
--   3. `amount` 单位与 users.balance 相同(微美元), 记下来是为了补对账/展示。
--      🚨 注意单位换算: 签到奖励对外是**美元**(100~200), 落库前 `× 1e8` 转微美元。
--      2026-09-21 前的老实现直接把 100~200 当微美元写入, 于是 $0.000001 —
--      前端 toFixed(4) 显示成 $0.0000, 用户看到"签到加了 0"。
--      历史脏数据(amount < 1e6 的行)可用下面这条修:
--        UPDATE user_checkins SET amount = amount * 1e8
--         WHERE amount > 0 AND amount < 1000000;
--      (余额本身没被写错, 只是加得太少; 要不要补那点余额由运营决定。)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_checkins (
  user_id    INTEGER NOT NULL,
  day        TEXT    NOT NULL,                         -- 北京时区 YYYY-MM-DD
  amount     INTEGER NOT NULL DEFAULT 0,               -- 微美元
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_user_checkins_user ON user_checkins(user_id, day DESC);
