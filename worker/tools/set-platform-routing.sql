-- sensenova 账号上的模型 → 定向到 sensenova 平台
--
-- 为什么需要显式配置: 这些模型名的"名字推断"结果都不是 sensenova
--   deepseek-v4-pro  -> deepseek (但 chatapi 没有这个模型!)
--   glm-5.2          -> zhipu
--   kimi-k3          -> kimi
--   sensenova-*      -> 推断不出, 落到默认 openai
-- 而 sensenova 是**自定义平台名**, 永远命不中推断表, 所以必须显式指定。
--
-- ⚠️ 故意**不**把 deepseek-v4-flash 放进来: 它在 chatapi 上更稳(全小写在 sensenova
--    会撞 429 tpm/rpm limit), 保持走 chatapi。
UPDATE groups
SET model_platform_routing =
  '{"deepseek-v4-pro":{"platform":"sensenova","model":"deepseek-v4-pro"},' ||
  '"Deepseek-v4-pro":{"platform":"sensenova","model":"deepseek-v4-pro"},' ||
  '"DeepSeek-v4-pro":{"platform":"sensenova","model":"deepseek-v4-pro"},' ||
  '"DEEPSEEK-V4-PRO":{"platform":"sensenova","model":"deepseek-v4-pro"},' ||
  '"glm-5.2":"sensenova",' ||
  '"kimi-k3":"sensenova",' ||
  '"sensenova-6.7-flash-lite":"sensenova",' ||
  '"sensenova-6.8-flash-lite":"sensenova",' ||
  '"sensenova-u1-fast":"sensenova",' ||
  '"sensenova-u1.5-fast":"sensenova",' ||
  '"sensenova-u1.5-lite":"sensenova"}'
WHERE id = 1;
