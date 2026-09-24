-- ============================================================
-- sub2api Worker 版 D1 Schema (SQLite)
-- 移植自上游 Ent models: backend/ent/schema/*.go
-- 取舍说明:
--   1. 上游 NUMERIC(20,8) 在 SQLite 无定点类型 -> 统一用 INTEGER 微美元 (1 USD = 1e8)
--      避免浮点误差导致余额对账差 1e-8
--   2. 上游软删除 (deleted_at) 需要"部分唯一索引" WHERE deleted_at IS NULL
--   3. JSONB -> TEXT (存 JSON 字符串)
--   4. 只保留网关运行必需的表, 管理后台/支付/公告等表 MVP 阶段不建
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- 用户 (上游 users) ----------
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT    NOT NULL,
  password_hash     TEXT    NOT NULL DEFAULT '',
  role              TEXT    NOT NULL DEFAULT 'user',      -- admin | user
  balance           INTEGER NOT NULL DEFAULT 0,           -- 微美元
  frozen_balance    INTEGER NOT NULL DEFAULT 0,           -- 微美元(批量生图 hold)
  concurrency       INTEGER NOT NULL DEFAULT 5,
  rpm_limit         INTEGER NOT NULL DEFAULT 0,           -- 0=不限
  status            TEXT    NOT NULL DEFAULT 'active',    -- active | disabled | error
  username          TEXT    NOT NULL DEFAULT '',
  notes             TEXT    NOT NULL DEFAULT '',
  -- 允许访问的上游平台, 逗号分隔; 空 = 不限制
  -- (鉴权视图 v_api_key_auth 会把它选成 user_platform_access, 所以这张表**必须**有这一列)
  platform_access   TEXT    NOT NULL DEFAULT '',
  last_login_at     TEXT,
  last_active_at    TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_live
  ON users(email) WHERE deleted_at IS NULL;

-- ---------- 分组 (上游 groups) ----------
CREATE TABLE IF NOT EXISTS groups (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  description        TEXT    NOT NULL DEFAULT '',
  platform           TEXT    NOT NULL DEFAULT '',         -- 空=混合
  rate_multiplier    INTEGER NOT NULL DEFAULT 100000000,  -- 微倍率, 1.0 = 1e8
  is_exclusive       INTEGER NOT NULL DEFAULT 0,
  status             TEXT    NOT NULL DEFAULT 'active',
  rpm_limit          INTEGER NOT NULL DEFAULT 0,
  model_pricing      TEXT,                                -- JSON: 逐模型定价(优先级最高)
  model_allowlist    TEXT,                                -- JSON array
  model_routing      TEXT,                                -- JSON
  model_routing_enabled INTEGER NOT NULL DEFAULT 0,
  default_mapped_model TEXT,
  daily_limit_usd    INTEGER NOT NULL DEFAULT 0,          -- 0=不限
  weekly_limit_usd   INTEGER NOT NULL DEFAULT 0,
  monthly_limit_usd  INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name_live
  ON groups(name) WHERE deleted_at IS NULL;

-- ---------- API Key (上游 api_keys) ----------
-- 注意: 上游是明文存储 (api_key_service.go GenerateKey -> hex(32B), 前缀 sk-)
CREATE TABLE IF NOT EXISTS api_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             TEXT    NOT NULL,                       -- 明文 <prefix><32hex>, 如 sk-3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c
  name            TEXT    NOT NULL DEFAULT '',
  group_id        INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  status          TEXT    NOT NULL DEFAULT 'active',      -- active|disabled|quota_exhausted|expired
  quota           INTEGER NOT NULL DEFAULT 0,             -- 微美元, 0=无限
  quota_used      INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,
  ip_whitelist    TEXT,                                   -- JSON array
  ip_blacklist    TEXT,
  -- 5h/1d/7d 金额窗口限额 (上游 rate_limit_5h/_1d/_7d + usage_* + window_*_start)
  rate_limit_5h   INTEGER NOT NULL DEFAULT 0,
  rate_limit_1d   INTEGER NOT NULL DEFAULT 0,
  rate_limit_7d   INTEGER NOT NULL DEFAULT 0,
  usage_5h        INTEGER NOT NULL DEFAULT 0,
  usage_1d        INTEGER NOT NULL DEFAULT 0,
  usage_7d        INTEGER NOT NULL DEFAULT 0,
  window_5h_start TEXT,
  window_1d_start TEXT,
  window_7d_start TEXT,
  last_used_at    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_live
  ON api_keys(key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_user   ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_group  ON api_keys(group_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);

-- ---------- 上游账号 (上游 accounts) ----------
CREATE TABLE IF NOT EXISTS accounts (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT    NOT NULL,
  notes                   TEXT    NOT NULL DEFAULT '',
  platform                TEXT    NOT NULL,   -- 内置官方平台名, 或任意自定义平台名(第三方中转/自建网关)
  protocol                TEXT    NOT NULL DEFAULT '', -- openai|anthropic|gemini; 空=按 platform 推导(兼容老数据)
  type                    TEXT    NOT NULL DEFAULT 'apikey', -- apikey|oauth|setup-token|upstream|bedrock|service_account
  credentials             TEXT    NOT NULL DEFAULT '{}',     -- JSON
  extra                   TEXT    NOT NULL DEFAULT '{}',     -- JSON
  model_index             TEXT,                              -- JSON array: 该账号已知能提供的模型名(对外名), 用于"新模型自动归到中转"
  concurrency             INTEGER NOT NULL DEFAULT 3,
  load_factor             INTEGER,                           -- NULL = 用 concurrency
  priority                INTEGER NOT NULL DEFAULT 50,       -- 越小越优先
  rate_multiplier         INTEGER NOT NULL DEFAULT 100000000,
  status                  TEXT    NOT NULL DEFAULT 'active',
  schedulable             INTEGER NOT NULL DEFAULT 1,
  error_message           TEXT    NOT NULL DEFAULT '',
  base_url                TEXT,                              -- 覆盖默认上游域名
  rate_limited_at         TEXT,                              -- 429 冷却
  rate_limit_reset_at     TEXT,
  overload_until          TEXT,                              -- 529 过载
  temp_unschedulable_until TEXT,
  temp_unschedulable_reason TEXT,
  last_used_at            TEXT,
  expires_at              TEXT,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);
CREATE INDEX IF NOT EXISTS idx_accounts_status   ON accounts(status);

-- ---------- 账号 <-> 分组 (上游 account_groups) ----------
CREATE TABLE IF NOT EXISTS account_groups (
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id    INTEGER NOT NULL REFERENCES groups(id)   ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 50,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_account_groups_group ON account_groups(group_id);

-- ---------- 用量日志 (上游 usage_logs, 只追加) ----------
CREATE TABLE IF NOT EXISTS usage_logs (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id             TEXT    NOT NULL,
  user_id                INTEGER NOT NULL,
  api_key_id             INTEGER NOT NULL,
  account_id             INTEGER,
  group_id               INTEGER,
  model                  TEXT    NOT NULL DEFAULT '',
  requested_model        TEXT    NOT NULL DEFAULT '',
  upstream_model         TEXT    NOT NULL DEFAULT '',
  billing_mode           TEXT    NOT NULL DEFAULT 'token',
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  input_cost             INTEGER NOT NULL DEFAULT 0,   -- 微美元
  output_cost            INTEGER NOT NULL DEFAULT 0,
  cache_read_cost        INTEGER NOT NULL DEFAULT 0,
  cache_creation_cost    INTEGER NOT NULL DEFAULT 0,
  total_cost             INTEGER NOT NULL DEFAULT 0,
  actual_cost            INTEGER NOT NULL DEFAULT 0,   -- 含倍率
  rate_multiplier        INTEGER NOT NULL DEFAULT 100000000,
  account_rate_multiplier INTEGER NOT NULL DEFAULT 100000000,
  stream                 INTEGER NOT NULL DEFAULT 0,
  duration_ms            INTEGER NOT NULL DEFAULT 0,
  first_token_ms         INTEGER,
  user_agent             TEXT    NOT NULL DEFAULT '',
  ip_address             TEXT    NOT NULL DEFAULT '',
  created_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_time ON usage_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_key_time  ON usage_logs(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_req       ON usage_logs(request_id);

-- ---------- 计费幂等 (上游 usage_billing_dedup) ----------
CREATE TABLE IF NOT EXISTS usage_billing_dedup (
  request_id          TEXT    NOT NULL,
  api_key_id          INTEGER NOT NULL,
  request_fingerprint TEXT    NOT NULL DEFAULT '',
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (request_id, api_key_id)
);

-- ---------- 模型定价 (替代上游 model_pricing.json + billing fallback) ----------
-- price 单位: 微美元 / token (即 USD per token * 1e8)
-- account_id: 0 = 全局兜底价; >0 = 该账号专属价
-- 复合主键 (account_id, model): 同一模型可在不同账号下配不同价格
CREATE TABLE IF NOT EXISTS model_pricing (
  account_id            INTEGER NOT NULL DEFAULT 0,  -- 0=全局兜底; >0=账号专属
  model                 TEXT    NOT NULL,
  input_price           INTEGER NOT NULL DEFAULT 0,
  output_price          INTEGER NOT NULL DEFAULT 0,
  cache_read_price      INTEGER NOT NULL DEFAULT 0,
  cache_creation_price  INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, model)
);
CREATE INDEX IF NOT EXISTS idx_model_pricing_account ON model_pricing(account_id);
CREATE INDEX IF NOT EXISTS idx_model_pricing_model    ON model_pricing(model);

-- ---------- 设置 (上游 settings) ----------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 每日签到 (「个人资料」页) ----------
-- 主键 (user_id, day) 承担**判重**职责: 靠 INSERT ... ON CONFLICT DO NOTHING
-- 的 changes 判断是否首次, 而不是"先查后写"(并发下会双双通过)。
-- day 存**北京时区**的 YYYY-MM-DD, 由应用层算好(见 admin-api.ts::bjDayString)。
CREATE TABLE IF NOT EXISTS user_checkins (
  user_id    INTEGER NOT NULL,
  day        TEXT    NOT NULL,
  amount     INTEGER NOT NULL DEFAULT 0,               -- 微美元, 与 users.balance 同单位
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_user_checkins_user ON user_checkins(user_id, day DESC);

-- ============================================================
-- 视图: API Key 鉴权所需的聚合信息 (对照上游 GetByKey + User 预加载)
-- ============================================================
DROP VIEW IF EXISTS v_api_key_auth;
CREATE VIEW v_api_key_auth AS
SELECT
  k.id                AS key_id,
  k.key               AS key,
  k.status            AS key_status,
  k.quota             AS key_quota,
  k.quota_used        AS key_quota_used,
  k.expires_at        AS key_expires_at,
  k.group_id          AS group_id,
  k.ip_whitelist      AS ip_whitelist,
  k.ip_blacklist      AS ip_blacklist,
  k.rate_limit_5h     AS rate_limit_5h,
  k.rate_limit_1d     AS rate_limit_1d,
  k.rate_limit_7d     AS rate_limit_7d,
  k.usage_5h          AS usage_5h,
  k.usage_1d          AS usage_1d,
  k.usage_7d          AS usage_7d,
  k.window_5h_start   AS window_5h_start,
  k.window_1d_start   AS window_1d_start,
  k.window_7d_start   AS window_7d_start,
  u.id                AS user_id,
  u.email             AS user_email,
  u.role              AS user_role,
  u.balance           AS user_balance,
  u.status            AS user_status,
  u.concurrency       AS user_concurrency,
  u.platform_access   AS user_platform_access,
  g.id                AS group_effective_id,
  g.name              AS group_name,
  g.platform          AS group_platform,
  g.rate_multiplier   AS group_rate_multiplier,
  g.rpm_limit         AS group_rpm_limit,
  g.model_allowlist   AS group_model_allowlist,
  g.model_pricing     AS group_model_pricing,
  g.model_routing     AS group_model_routing,
  g.model_routing_enabled AS group_model_routing_enabled,
  g.default_mapped_model  AS group_default_mapped_model,
  g.model_platform_routing AS group_model_platform_routing
FROM api_keys k
JOIN users u ON u.id = k.user_id
LEFT JOIN groups g ON g.id = k.group_id AND g.deleted_at IS NULL
WHERE k.deleted_at IS NULL;
