-- ============================================================
-- 管理后台增量: 管理员账号 + 审计日志
-- 用法: npx wrangler d1 execute sub2api --file=./schema/schema-admin.sql --remote -y
-- ============================================================

-- 管理后台登录用的账号(与业务 users 表分开, 避免混淆权限)
-- 密码用 PBKDF2-SHA256 存储, 格式: pbkdf2$<iterations>$<saltHex>$<hashHex>
CREATE TABLE IF NOT EXISTS admin_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  display_name  TEXT    NOT NULL DEFAULT '',
  last_login_at TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_accounts_username
  ON admin_accounts(username);

-- 管理操作审计日志
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    INTEGER,
  admin_name  TEXT    NOT NULL DEFAULT '',
  action      TEXT    NOT NULL,          -- create/update/delete/login
  resource    TEXT    NOT NULL,          -- api_key/account/group/user/...
  resource_id TEXT    NOT NULL DEFAULT '',
  detail      TEXT    NOT NULL DEFAULT '',
  ip          TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_logs(created_at);

-- 给 accounts 补一个"最近连通性测试"结果字段, 供后台展示
ALTER TABLE accounts ADD COLUMN last_test_status TEXT;
ALTER TABLE accounts ADD COLUMN last_test_at TEXT;
ALTER TABLE accounts ADD COLUMN last_test_message TEXT;
