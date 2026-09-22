-- 把 `Deepseek-v4-flash`(首字母大写, 在 #9 微信chatapi) 钉到 deepseek 平台。
--
-- 为什么必须显式配而不用自动发现:
--   #9 的上游不实现 `GET /v1/models`(恒 400), 所以「模型获取」拿不到它的模型列表,
--   `model_index` 对它永远是空的 —— 自动发现无从得知它支持什么。
--   这类"上游不吐模型列表"的账号, 只能靠在重定向表里显式声明归口。
--
-- 注意大小写: chatapi 只认 `Deepseek-v4-flash`(首字母大写), 与 sensenova 的
-- `deepseek-v4-flash`(全小写) 是两个不同上游的同名模型 —— 这正是 `{platform,model}`
-- 写法存在的意义: 既定平台, 又声明对端认的写法。
--
-- 用法: npx wrangler d1 execute sub2api --file=./tools/pin-deepseek-flash.sql --remote -y
-- ============================================================

UPDATE groups SET model_platform_routing =
  '{"deepseek-v4-pro":{"platform":"sensenova","model":"deepseek-v4-pro"},
    "Deepseek-v4-flash":{"platform":"deepseek","model":"Deepseek-v4-flash"},
    "glm-5.2":"sensenova","kimi-k3":"sensenova",
    "sensenova-6.7-flash-lite":"sensenova","sensenova-6.8-flash-lite":"sensenova",
    "sensenova-u1-fast":"sensenova","sensenova-u1.5-fast":"sensenova","sensenova-u1.5-lite":"sensenova"}'
WHERE id = 1;
