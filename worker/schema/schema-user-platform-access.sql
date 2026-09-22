-- ============================================================
-- users.platform_access —— 补一列「允许访问的上游平台」(逗号分隔, 空 = 不限制)
--
-- 背景: 鉴权视图 v_api_key_auth 一直在 SELECT `u.platform_access AS user_platform_access`
-- (见 schema-view-auth.sql), 但**没有任何 schema 文件建过这一列** ——
-- 本地和线上都是历史上手工加的, 于是全新环境跑 `npm run db:init` 到建视图那一步必然报错。
-- 本文件把这个缺口补上(schema.sql 里也已同步加了该列, 新装环境直接就对)。
--
-- ⚠️ SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS, 而本地/线上**已经**有这一列,
--    所以这个文件是**记录用途, 不要再执行**; 全新环境请直接用 schema.sql。
-- ============================================================

ALTER TABLE users ADD COLUMN platform_access TEXT NOT NULL DEFAULT '';
