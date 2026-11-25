-- ============================================================
-- 额度变动流水 (balance_logs)
--
-- 为什么单独一张表, 不写进 usage_logs:
--   老板要「管理员调整额度时在『使用日志』里留一条记录」。但 usage_logs 是**模型调用**
--   流水, 概览/请求日志/按天按模型按 Key 的所有 COUNT 与 SUM 都直接读它 ——
--   往里插非调用行会让统计全部带脏(签到记录当初就是因此没落 usage_logs,
--   而是从 user_checkins 现场合成, 见 admin-api::getSelfLogs 的注释)。
--   所以额度变动单独存, 展示时用 UNION ALL 合成"同形状"的行。
--
-- 单位: delta / balance_after 都是**微美元**(1 USD = 1e8), 与 users.balance 一致。
-- 幂等: 建表用 IF NOT EXISTS, 可以反复执行。
-- ============================================================

CREATE TABLE IF NOT EXISTS balance_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  delta         INTEGER NOT NULL,                        -- 变动量(微美元), 正=增加
  balance_after INTEGER NOT NULL,                        -- 变动后的余额(微美元)
  source        TEXT    NOT NULL DEFAULT 'admin',        -- admin = 后台管理员调整
  operator      TEXT    NOT NULL DEFAULT '',             -- 操作人(管理员用户名), 便于排查
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_balance_logs_user ON balance_logs(user_id, created_at DESC);
