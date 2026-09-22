-- ============================================================
-- 重建鉴权视图: 补上 user_platform_access 列
-- 用法: npx wrangler d1 execute sub2api --file=./schema/schema-view-auth.sql --remote -y
-- 说明: 该视图是网关鉴权的唯一数据源, 增删列后必须重建
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

-- 存量账号补绑 default 分组, 修复"后台建的账号选不中"的问题
INSERT OR IGNORE INTO account_groups (account_id, group_id, priority)
SELECT a.id, (SELECT id FROM groups WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1), 50
FROM accounts a
WHERE a.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM account_groups ag WHERE ag.account_id = a.id);
