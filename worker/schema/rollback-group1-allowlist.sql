-- 备份: default 组(#1) 原分组白名单 (2026-09-21 17:28 清空前)
--
-- 为什么要清空:
--   用户要求「配了上游就能用」= /v1/models 应返回本分组全部账号声明的**完整并集**,
--   而这份 54 条白名单只在做 Gemini 用, 会把 opencode 的 75 个模型过滤成 9 个。
--   网关侧的闸门早已停用 (gateway.ts::GROUP_ALLOWLIST_ENABLED = false),
--   所以清空**只影响 /v1/models 的展示**, 不改变任何转发行为。
--
-- 回滚: 直接执行下面这条即可恢复原值。
UPDATE groups SET model_allowlist = '["antigravity-preview-05-2026","antigravity-preview-09-2026","aqa","deep-research-max-preview-04-2026","deep-research-preview-04-2026","deep-research-pro-preview-12-2025","Deepseek-v4-flash","deepseek-v4-pro","gemini-2.5-computer-use-preview-10-2025","gemini-2.5-flash","gemini-2.5-flash-image","gemini-2.5-flash-lite","gemini-2.5-flash-native-audio-latest","gemini-2.5-flash-preview-tts","gemini-2.5-pro","gemini-2.5-pro-preview-tts","gemini-3-flash-preview","gemini-3-pro-image","gemini-3-pro-image-preview","gemini-3.1-flash-image","gemini-3.1-flash-image-preview","gemini-3.1-flash-lite","gemini-3.1-flash-lite-image","gemini-3.1-flash-lite-preview","gemini-3.1-flash-tts-preview","gemini-3.1-pro-preview","gemini-3.1-pro-preview-customtools","gemini-3.5-flash","gemini-3.5-flash-lite","gemini-3.5-transcribe","gemini-3.5-transcribe-live","gemini-3.6-flash","gemini-3.7-flash","gemini-3.8-flash","gemini-embedding-001","gemini-embedding-2","gemini-embedding-2-preview","gemini-flash-latest","gemini-flash-lite-latest","gemini-omni-1.1-flash","gemini-omni-flash-preview","gemini-pro-latest","gemini-robotics-er-2-preview","gemma-4-26b-a4b-it","gemma-4-31b-it","glm-5.2","kimi-k3","lyria-3-clip-preview","lyria-3-pro-preview","lyria-3.5","nano-banana-pro-preview","sensenova-6.8-flash-lite","veo-3.1-fast-generate-preview","veo-3.1-generate-preview","veo-3.1-lite-generate-preview"]' WHERE id = 1;

-- 清空(本地已执行; 生产走 d1-query):
-- UPDATE groups SET model_allowlist = NULL WHERE id = 1;
