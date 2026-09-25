# 模型路由机制

代码入口：[worker/src/gateway.ts](file:///d:/ai-code/my-demo/sub2api/worker/src/gateway.ts) 的 `inferPlatform()`（约 L349）。每个网关请求按下表**从上到下**判定目标平台，命中即停。

## 决策链（2026-09-24 现行）

| 优先级 | 规则 | 配置位置 | 说明 |
|---|---|---|---|
| 0 | 入口路径 | URL `/<entry>/` 前缀 | URL 直接指定上游账号时，**跳过以下全部**模型名判定 |
| 1 | 模型 → 平台 重定向 | 分组编辑 →「模型 → 平台 重定向」（`groups.model_platform_routing`，JSON） | **优先级最高**。精确匹配优先，其次大小写不敏感；支持 `{"platform":"x","model":"y"}` 顺带改写模型名 |
| 2 | 模型关联锁平台 | 分组「模型关联」（`groups.model_allowlist`） | 条目格式 `平台::模型`（2026-09-24 起复合格式）；命中即把请求锁到该平台 |
| 3 | 分组 platform | 分组编辑 →「平台」（`groups.platform`） | 逗号分隔多平台时按路径挑（`/v1beta/`→gemini、含 `/messages`→anthropic 系） |
| 4 | 用户平台白名单 | 用户编辑 →「平台访问限制」（`users.platform_access`） | 恰好一个时直接锁定；同时也是**硬边界**——规则 1/2/5 的结果若越界，回退白名单首个平台 |
| 5 | 自动发现 | 账号「模型获取」索引（`accounts.model_index`）∪ 账号别名键（`extra.model_aliases`） | 模型名出现在哪个**本分组绑定的 active 账号**的索引/别名里，就走那个平台并优先选那个账号 |
| 6 | 路径兜底 | — | `/v1beta/`→gemini；含 `/messages`→anthropic；否则 openai |

**已废弃**：按模型名前缀猜平台（glm→zhipu、deepseek→deepseek 等，`inferPlatformFromModel`）。2026-09 起不再参与路由——第三方中转上的模型名与官方平台无对应关系，猜出来的平台常没账号，报 503。

## 关键行为细节

- **白名单不再 403 拦请求**：`GROUP_ALLOWLIST_ENABLED=false`（gateway.ts L1167，2026-09-21 起）。模型关联只影响**平台锁定**和 `/v1/models` 列表展示，不拦截请求。
- **重定向表可做大小写分流**：`lookupModelRoute`（L257）精确命中优先，查不到才退化大小写不敏感。因此 `"Deepseek-v4-flash"` 与 `"deepseek-v4-flash"` 是两条独立规则——本项目正是靠这个把大写送 chatapiweixin、小写送 sensenova。
- **简写形式会改写模型名**：`"model-x": "platform"` 命中后，转发名统一改成**表里的 key**（key 即"对端认识的名字"），避免大小写不符被上游 404。
- **同名模型多平台关联不锁定**：如 `openai::glm-5.2` + `deepseek::glm-5.2` 同时存在时无法消歧，交由后续链路（分组 platform / 自动发现）决定。
- **别名兼作路由依据**：账号级别名（后台「别名设置」）的"对外别名"参与自动发现——客户端发别名会优先选中声明它的账号（连带它的 Base URL）。同平台多条中转靠它区分。
- **模型名改写优先级**：重定向 `{model}` > 重定向表 key > 账号别名 > 原样透传。

## 大小写坑（本项目最常见的坑）

不同上游对模型名大小写的要求可能**相反**：

- sensenova（日日新）只认全小写：`deepseek-v4-pro`
- chatapi（微信）只认首字母大写：`Deepseek-v4-flash`

解法：在分组重定向表里用 `{platform, model}` 写法把每个大小写变体显式声明，让网关统一改写，不要指望客户端统一。
