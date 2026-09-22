-- ============================================================
-- 新增: 模型名 → 平台 的重定向 (model_platform_routing)
--
-- 背景: groupModelRouting 只重写**模型名**, 平台仍由重写后的模型名推断。
-- 当同一个模型名需要在多个平台之间精确派发时 (例: deepseek-v4-pro 该去
-- sensenova, deepseek-v4-flash 该去 chatapi), 光靠改名解决不了 ——
-- 需要一个"这个模型去哪个平台选号"的映射。
--
-- 格式: JSON 对象 {"<请求里的模型名>": "<目标平台名>"}
-- 例:   {"deepseek-v4-pro":"sensenova"}
--
-- 用法: npx wrangler d1 execute sub2api --file=./schema/schema-platform-routing.sql --remote -y
-- ============================================================

ALTER TABLE groups ADD COLUMN model_platform_routing TEXT;
