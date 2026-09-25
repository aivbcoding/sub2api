# 生产资源快照（2026-09-24）

> 数据源：D1 远程库 `sub2api`。配置有改动时请同步更新本文件。

## 上游账号（accounts，均 active 且 schedulable）

| ID | 名称 | 平台 | Base URL | 模型索引 | 备注 |
|---|---|---|---|---|---|
| 8 | Gemini | gemini | （空 → 官方默认域名） | 50 个 | gemini-2.5 系、antigravity 系等 |
| 9 | 微信 | chatapiweixin | `https://chatapi.weixin.qq.com/openai` | **0**（上游不支持列模型） | 别名：`Deepseek-v4-flash` → `Deepseek-v4-flash` |
| 10 | 日日新 | sensenova | `https://token.sensenova.cn` | 9 个 | deepseek-flash / deepseek-v4-flash / deepseek-v4-pro / deepseek-v4.1-flash / glm-5.2 / kimi-k3 / sensenova-6.8-flash-lite / sensenova-u1-fast 等 |
| 12 | Gitcode | gitcode | `https://api-ai.gitcode.com` | 11 个 | MoonshotAI/Kimi-K2.6、Qwen 系等 |
| 13 | justwork | anthropic | `https://api.justwoker.icu` | 1 个 | claude-opus-4-8 |
| 15 | 硅基 | siliconflow | `https://api.siliconflow.cn` | 98 个 | zai-org/GLM-5.2 / GLM-5.3、BAAI 系等 |

全局平台集合：`gemini, chatapiweixin, sensenova, gitcode, anthropic, siliconflow`

## 分组

### #1 default（绑定全部 6 个账号）

- **模型 → 平台 重定向**（10 条）：
  - `deepseek-v4-pro` → `{platform: sensenova, model: deepseek-v4-pro}`
  - `Deepseek-v4-flash` → `{platform: chatapiweixin, model: Deepseek-v4-flash}`（2026-09-24 修复，原误指 `deepseek`）
  - `deepseek-v4-flash`（小写）→ `sensenova`
  - `glm-5.2` / `kimi-k3` / `sensenova-6.7-flash-lite` / `sensenova-6.8-flash-lite` / `sensenova-u1-fast` / `sensenova-u1.5-fast` / `sensenova-u1.5-lite` → `sensenova`
- **模型关联白名单**（7 条）：`anthropic::claude-opus-4-8`、`gitcode::deepseek-ai/DeepSeek-V4-Flash`、`sensenova::deepseek-v4-pro`、`chatapiweixin::wx-deepseek-v4-flash`、`chatapiweixin::Deepseek-v4-flash`、`siliconflow::zai-org/GLM-5.2`、`siliconflow::zai-org/GLM-5.3`
- 2026-09-24 全量体检：所有条目的平台名均有效且已绑定，无其他残留旧配置。

### #5 supper

- 重定向 / 白名单 / 分组平台全为空，**未绑定任何上游账号**。
- ⚠️ 挂 Key 之前必须先绑账号，否则所有请求 503 `no_upstream_account`。（绑定由使用者在后台自行分配）

## API Key

| ID | 名称 | 分组 | 状态 |
|---|---|---|---|
| 1 | local-test-key | default | active |
| 13 | test01 | default | active |
| 12 | admin_key1 | 未分组（null） | active |

## 上游已知特性

- **微信（chatapi.weixin.qq.com）**：不实现 `GET /v1/models`——无论凭证对错都返回 400 `missing required parameter: model`。因此「模型获取」拉不到列表、连通性测试只能报橙色"待验证"。该账号的模型路由只能靠**重定向表 / 账号别名**显式声明，模型索引会一直是空的，属正常现象。
- **sensenova vs chatapi 大小写相反**：sensenova 只认全小写（`deepseek-v4-pro`），chatapi 只认首字母大写（`Deepseek-v4-flash`）——已在 default 分组重定向表里用两条独立 key 做大小写分流，详见 [routing.md](routing.md)。
