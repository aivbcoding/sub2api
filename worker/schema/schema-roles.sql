-- ============================================================
-- 角色 ↔ 菜单权限
-- 用法: npx wrangler d1 execute sub2api --file=./schema/schema-roles.sql --remote -y
--       npx wrangler d1 execute sub2api --file=./schema/schema-roles.sql --local  -y
--
-- 背景:
--   原先"管理后台"与"业务用户"是两套孤立体系 —— 后台登录查 `admin_accounts`,
--   业务用户只有 Key 没有登录入口。统一成**一个登录页 + 一张 users 表**之后,
--   就必须回答"登录进来能看到什么", 这就是本表的作用。
--
-- 设计要点:
--   1. `users.role` 存的是 roles.code(不是 id), 于是角色可以随时改名/重建而不动用户表;
--   2. `menus` 是菜单键的 JSON 数组, `["*"]` 表示全部菜单(超管);
--   3. `builtin = 1` 的内置角色不可删除, code 也不可改 —— 它们是代码里写死的兜底
--      (登录后取不到角色时按 `user` 处理, 见 admin-auth.ts::DEFAULT_ROLE_CODE);
--   4. 权限的**真正边界在后端**: 每个 /api/admin/<resource> 都映射到一个菜单键,
--      角色没有这个菜单就直接 403。前端隐藏菜单只是"看不见", 不是安全边界。
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL,                          -- 代码: 小写字母/数字/_- , 登录后写进 users.role
  name        TEXT    NOT NULL,                          -- 显示名
  menus       TEXT    NOT NULL DEFAULT '[]',             -- JSON 数组, ['*'] = 全部
  builtin     INTEGER NOT NULL DEFAULT 0,                -- 1 = 内置(不可删除)
  description TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_code ON roles(code);

-- ---- 内置角色 ----
-- admin: 全部菜单。**不可编辑不可删除** —— 一旦被改坏就会把管理员自己锁在门外,
--        而且网关对 role='admin' 跳过余额检查(index.ts), 这个猫码本身有特权含义。
-- user : 业务用户。2026-09-21 起给到四个"我的"页面 —— 概览 / API秘钥 / 使用日志 / 个人资料,
--        它们的数据都由后端**按会话用户 id 强制过滤**(见 admin-api.ts 的 getOverview /
--        getSelfLogs / getProfile), 所以放开菜单不会泄露别人的数据。
--        刻意**不给 board(数据看板) 与 dashboard(总览)** ——
--        那两页是运营视角的聚合数据, 属于管理侧, 见下面单独那条 UPDATE 的注释。
INSERT INTO roles (code, name, menus, builtin, description) VALUES
  ('admin', '超级管理员', '["*"]', 1, '拥有全部菜单与接口权限, 内置不可删除'),
  ('user',  '业务用户',
   '["overview","mykeys","logs","profile"]', 1,
   '业务用户: 概览 / API秘钥 / 使用日志 / 个人资料 (均只含自己的数据), 其余菜单不可见')
ON CONFLICT(code) DO UPDATE SET
  menus = excluded.menus,
  description = excluded.description
WHERE roles.builtin = 1;

-- ---- 已上线的库: 把 user 角色的菜单补齐 ----
-- ON CONFLICT DO UPDATE ... WHERE builtin=1 已经覆盖了"重新执行本文件"的情况;
-- 这一段是给"角色已存在但菜单还是旧值"的库用的显式修正(幂等)。
UPDATE roles SET menus = '["overview","mykeys","logs","profile"]', updated_at = datetime('now')
 WHERE code = 'user' AND builtin = 1;

