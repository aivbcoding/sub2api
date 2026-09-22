-- ============================================================
-- sub2api Worker 版种子数据
-- 用法: npm run db:seed:local
-- 修改 ADMIN_KEY / 账号凭证后再跑
-- ============================================================

-- 管理员用户, 余额 $100
INSERT OR IGNORE INTO users (id, email, password_hash, role, balance, concurrency, status)
VALUES (1, 'admin@local', '', 'admin', 10000000000, 10, 'active');

-- 默认分组, 倍率 1.0
INSERT OR IGNORE INTO groups (id, name, description, rate_multiplier, status)
VALUES (1, 'default', '默认分组', 100000000, 'active');

-- 测试 API Key (明文, 与上游一致), 额度 $50
INSERT OR IGNORE INTO api_keys (id, user_id, key, name, group_id, status, quota)
VALUES (1, 1, 'sk-0000000000000000000000000000000000000000000000000000000000000001',
        'local-test-key', 1, 'active', 5000000000);

-- ---- 上游账号示例: 请把 credentials 里的 api_key 换成真实值 ----
-- Anthropic (x-api-key 认证)
INSERT OR IGNORE INTO accounts (id, name, platform, type, credentials, priority, concurrency, base_url)
VALUES (1, 'anthropic-1', 'anthropic', 'apikey',
        '{"api_key":"sk-ant-REPLACE_ME"}', 10, 5, NULL);

-- OpenAI (Authorization: Bearer 认证)
INSERT OR IGNORE INTO accounts (id, name, platform, type, credentials, priority, concurrency, base_url)
VALUES (2, 'openai-1', 'openai', 'apikey',
        '{"api_key":"sk-REPLACE_ME"}', 10, 5, NULL);

-- Gemini (x-goog-api-key 认证)
INSERT OR IGNORE INTO accounts (id, name, platform, type, credentials, priority, concurrency, base_url)
VALUES (3, 'gemini-1', 'gemini', 'apikey',
        '{"api_key":"REPLACE_ME"}', 10, 5, NULL);

-- 把账号都挂到 default 分组
INSERT OR IGNORE INTO account_groups (account_id, group_id, priority) VALUES (1, 1, 10);
INSERT OR IGNORE INTO account_groups (account_id, group_id, priority) VALUES (2, 1, 10);
INSERT OR IGNORE INTO account_groups (account_id, group_id, priority) VALUES (3, 1, 10);

-- ---- 模型定价 (微美元 / token) ----
-- 换算: $3 / 1M input tokens = 3e6 微美元 / 1e6 tokens = 3 微美元/token
INSERT OR IGNORE INTO model_pricing (model, input_price, output_price, cache_read_price, cache_creation_price) VALUES
  ('claude-sonnet-4-20250514',  3,  15, 0, 4),
  ('claude-opus-4-20250514',   15,  75, 2, 19),
  ('claude-3-5-haiku-20241022', 1,   5, 0, 1),
  ('gpt-4o',                    3,  10, 2, 0),
  ('gpt-4o-mini',             0.15, 0.6, 0, 0),
  ('o3',                       10,  40, 3, 0),
  ('gemini-2.5-pro',          1.25, 10, 0, 0),
  ('gemini-2.5-flash',        0.3, 2.5, 0, 0),
  ('grok-4',                    3,  15, 0, 0),
  ('deepseek-chat',           0.27, 1.1, 0, 0);
