-- ============================================================
-- 增量: 上游账号支持自定义平台
-- 用法: npx wrangler d1 execute sub2api --file=./schema/schema-custom-platform.sql --remote -y
--
-- 背景: 原 platform 是写死的枚举(只能选官方平台)。
--       现在放开为任意字符串, 支持第三方中转站 / 自建网关 / 私有部署。
--       由于平台名不再能唯一决定通信方式, 新增 protocol 列显式声明协议。
-- ============================================================

-- protocol: openai | anthropic | gemini
--   留空 = 按 platform 推导默认协议, 保证老数据行为不变
ALTER TABLE accounts ADD COLUMN protocol TEXT NOT NULL DEFAULT '';

-- 用户级平台白名单(逗号分隔)需要能塞下自定义平台名, 扩到 512 已足够
-- (SQLite 的 TEXT 无长度限制, 这里仅作声明性注释, 无需 ALTER)

-- 回填内置平台的协议, 便于后台直接展示(留空也兼容, 这里只是让数据更明确)
UPDATE accounts SET protocol = 'anthropic'
  WHERE protocol = '' AND platform IN ('anthropic','kimi','zhipu','minimax');
UPDATE accounts SET protocol = 'gemini'
  WHERE protocol = '' AND platform IN ('gemini','antigravity');
UPDATE accounts SET protocol = 'openai'
  WHERE protocol = '' AND platform IN ('openai','grok','deepseek','opencode_go');
