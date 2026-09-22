-- 复位: 跑完 translate-e2e 后必须把 base_url 清回 NULL
-- 否则标准 e2e 的"上游 401"用例会变成打到 mock 而失败
UPDATE accounts SET base_url = NULL WHERE deleted_at IS NULL;

-- 复位计费漂移
UPDATE users SET balance = 10000000000, frozen_balance = 0 WHERE id = 1;
UPDATE api_keys SET quota_used = 0, usage_5h = 0, usage_1d = 0, usage_7d = 0,
  window_5h_start = NULL, window_1d_start = NULL, window_7d_start = NULL;
