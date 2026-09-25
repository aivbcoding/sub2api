# sub2api 代码优化与修复记录

> 整理自工作日志（2026-09-20 ~ 2026-09-24），覆盖 Cloudflare Worker 移植版 `worker/`
> 的代码优化、Bug 修复与上线记录。与主题化的运维文档互补：
> [routing.md](routing.md)（路由机制）· [troubleshooting.md](troubleshooting.md)（排障）·
> [inventory.md](inventory.md)（资源现状）· [ops-environment.md](ops-environment.md)（环境）。

## 一、部署批次总览

| 日期 | 部署版本 | 内容 |
|---|---|---|
| 09-20 | — | Cloudflare Workers 移植 MVP 骨架（方案 C 重写，非直接部署） |
| 09-21 | `b0cc421d` | **入口路径定上游**（URL 决定平台）+ 关闭分组白名单 + 后台 SPA 路由改造 |
| 09-22 | `4aa212d9` | 启动引导视图 `#boot-view`（刷新不再闪登录页） |
| 09-22 | `c80bcd01` | API Key 格式改「`sk-` + 32 位 UUID」 |
| 09-22 | `94320c4c` | 模型定价改版 + 超管批量删除 + 计费价格精简 / toast 居中 |
| 09-22 | `b488c624` | 使用日志详情对业务用户脱敏（上游 / UA） |
| 09-22 | `bfa7ef6b` | 操作说明文档域名改动态（`__ORIGIN__` 占位符） |
| 09-22 | `668664ed` / `cbafdbc1` | 操作说明双列独立滚动 + 公告「先弹窗再请求」 |
| 09-22 | `d894feb6` | 内容区改白 + 面板阴影（v1.30.0） |
| 09-22 | `6dd4513a` | **流式翻译补 tool_use**（Claude Code 工具调用修复，v1.33.0） |
| 09-23 | `fe8b16ae` | 登录页 + 注册页 UI 改版（玻璃拟态 / 眼睛切换 / 错误横幅） |
| 09-23 | `5e8b25f5` | 修复注册页「注 册」按钮无反应（漏绑定 click） |
| 09-23 | — | 邮箱验证码注册（Turnstile + 邮件 Worker）→ 随后按用户要求停用 |
| 09-24 | `dda02f0d` | 超管级联删除用户（物理删除 5 张关联表） |
| 09-24 | `5e270ae0` | 用户表「操作」列 sticky 钉右侧 |
| 09-24 | `1aee4667` | 全站表格横向滚动 + 表头吸顶修复 |
| 09-24 | `9a44f517` | 启动引导卡片美化（「正在加载…请稍候」） |
| 09-24 | `15194de4` | 定价跟账号走 + 删账号级联清理定价/绑定 |
| 09-24 | `a21a69c1` | 菜单合并：「模型别名」并入「模型定价」 |
| 09-24 | `acfb5002` | 菜单改名「模型管理」 |
| 09-24 | `18ad46dc` | 模型管理页拆 4 个 tab（别名列表/别名设置/模型定价/默认单价） |
| 09-24 | `440f4d4c` | 分组「模型关联」功能 + 吸顶 tab 标题重叠修复 |
| 09-24 | `b8d3c58f` | 🚨 内联脚本 SyntaxError 事故修复（as 注解漏进裸 JS） |
| 09-24 | `841806df` | 别名可改名 + 别名列表批量删除 |
| 09-24 | `55ee6872` | 模型关联改成 `平台::模型` 复合格式（区分大小写） |
| 09-24 | `36e50403` | 分组模型关联 → 钉死路由平台（防自动发现抢走同名模型） |

---

## 二、网关 / 路由

### 入口路径定入口（`b0cc421d`，09-21）

**需求**：由 API 请求 URL 判断走哪个平台（而不是按模型名猜），别名也走 URL。

- `accounts` 新增 `entry_path` 列 + 部分唯一索引（真实列而非 extra，路由查找键需要索引）。
- `gateway.ts`：`splitEntryPrefix()` / `findAccountByEntryPath()`；命中前缀时
  `platform = entry.platform`、`lockedAccountId = entry.accountId`，**跳过重定向表**。
- `index.ts` 用保留段挡掉 `v1 / models / admin` → 普通请求**一次 D1 查询都不打**。
- 分组白名单 `GROUP_ALLOWLIST_ENABLED=false` 停用（配了上游就能用）。

### 小写模型名被「大小写兜底」劫持（09-21，纯数据修复）

**现象**：`usage_logs.account_id` 实证小写 `deepseek-v4-flash` 落到了微信（应为 sensenova）。

- 根因：`lookupModelRoute()` 精确匹配失败后**退化到大小写不敏感**，把 `deepseek-v4-flash`
  捞到大写键 `Deepseek-v4-flash` 那条规则。
- 修法：重定向表补**显式小写键**（精确匹配优先于兜底），实现同一模型两个大小写分走两平台。
- 🧨 白名单同样有大小写兜底，**无法靠白名单区分大小写**；区分只能走重定向表精确键。

### 分组模型关联 → 钉死路由平台（`36e50403`，09-24）

**需求**：关联的模型是哪个平台，请求就必须走那个平台的 API，不能被自动发现改道。

- 新增 `groupLockedPlatform(ctx, model)`：遍历 `model_allowlist` 的 `平台::模型` 复合条目，
  精确匹配（区分大小写）优先 → 大小写不敏感兜底 → 跨平台同名冲突返回 null 不锁定。
- 插入 `inferPlatform` 优先级链：重定向表之后、`groupPlatform` 之前；`explicitlyRouted`
  同步补上（锁定后不再自动发现改写平台）。
- 白名单 403 拦截本就停用，模型关联只影响**平台锁定**和 `/v1/models` 展示。

---

## 三、协议翻译（SSE / 流式）

### 🚨 流式翻译补 tool_use（`6dd4513a`，09-22，v1.33.0）

**现象**：Claude Code（Anthropic 协议客户端）经中转访问 OpenAI 兼容上游，读文件/搜目录报
`The model's tool call could not be parsed`；简单问答正常。

- 初版误判（记住教训）：用 OpenAI 协议客户端测出的「中转零改写」不适用于 Anthropic 客户端 ——
  先看 `usage_logs.user_agent` 分清客户端协议：`anthropic → openai` 时 `needTranslate=true` 走翻译。
- 真正根因：`createSseTranslator` 的 anthropic 写出器**只实现了 text + finish，没有 tool_use 块**。
- 修复三处（`src/translate.ts`）：
  1. `CanonDelta.toolCall`（单数）→ `toolCalls`（数组），openai-chat 分支**遍历全部**分片；
  2. **四个写出器全补 tool_calls**：anthropic 开 `content_block_start(tool_use)` +
     `input_json_delta` 分片 + `content_block_stop`；gemini/openai-responses 收尾一次性吐
     `functionCall`；openai-chat 发增量（**删掉 `if(!delta.text)return''` 吞包陷阱**）；
  3. `canonicalToOpenaiChat` 加 `normalizeToolChoiceForOpenai`（Anthropic 形状 → OpenAI 合法值）。
- 线上复测：`content_block_start` 含 tool_use，arguments 拼接合法 JSON，stop_reason=tool_use。
- 🧨 排查必须模拟客户端**按 index 累积分片再 JSON.parse**；单 chunk 有 `tool_calls` 不代表拼接合法。

---

## 四、计费 / 数据

### 模型定价改版（`94320c4c`，09-22）

- 价格来源只留两级：`model_pricing` 表 → `settings.model_pricing_default` 默认单价。
  (`BUILTIN_PRICING` / `FALLBACK_PRICE` 已删，勿加回)；分组只乘倍率 `combineRateMultiplier`。
- `handleModelPricing` 统一批量 upsert / 删除；`parseDefaultPrice` 坏 JSON **逐字段回退**。

### 定价跟账号走 + 删账号级联（`15194de4`，09-24）

- `model_pricing` 主键改 `(account_id, model)`：`account_id=0` = 全局兜底价；`>0` = 账号专属价。
  （⚠️ 不用 NULL 表示全局：SQLite 复合主键里 NULL 互不相同，唯一性无法保证。）
- `resolveModelPrice(model, accountId, dbPricing, defaultPrice)` 四参：账号价 → 全局价 → 兜底。
- 删账号：`DB.batch` 级联删 `model_pricing` + `account_groups`（别名/索引随软删自然消失）。

### 计费/删除接口踩坑（多处）

- 🚨 **`handleAdminApi` 只给 `POST|PUT|PATCH` 读请求体 ⇒ 批量删永远报 "ids is required"**，
  而 GET 正常、未登录 401，极难发现。已改为 `POST|PUT|PATCH|DELETE` 都解析。
- 批量删除硬卡 `is_admin`（有菜单 ≠ 能删）；删日志/删审计动作自身各写一条审计（链式留痕）。

---

## 五、安全 / 权限 / 脱敏

- **日志脱敏**（`b488c624`，09-22）：业务用户详情/列表不显示上游模型/账号/UA；后端
  `getSelfLogs()`（不是 `getLogs`）不再 SELECT 泄漏列、去掉 `LEFT JOIN accounts`；
  管理员侧 `getUsage()` 一行不动（排查靠它）。
- **超管级联删除用户**（`dda02f0d`，09-24）：`DELETE /api/admin/users/:id` 从软删改物理删除，
  `DB.batch` 级联删 api_keys / usage_logs / usage_billing_dedup / user_checkins /
  邮箱验证码两张表；审计日志**保留不删**；删自己不区域 400、不存在 404、前端传 id 必校验。
- **邮箱验证码注册**（09-23，后按用户要求停用）：Turnstile 双 Token + 验证码 + Resend 邮件
  Worker；停用时删 `TURNSTILE_SECRET_KEY` 并 **必须重新 deploy 才会生效**（Cloudflare 行为）。
- 线上凭证安全红线：不读生产库凭证到本地拼接请求，一律走后台/Worker 自己的管理接口。

---

## 六、后台 UI / 交互

### 布局与交互修复

| 日期 | 版本 | 内容 |
|---|---|---|
| 09-21 | — | 新后台布局：固定 `.topbar` + 侧栏/内容各自滚动 + `/admin/<page>` 路由（SPA pushState） |
| 09-22 | `d894feb6` | 内容区纯白 `--content:#fff`；需配套三档阴影 `--shadow-1/2/3` + 大圆角（白卡压灰底需要阴影） |
| 09-22 | `4aa212d9` | `#boot-view` 启动引导：login/register 默认 `display:none`，验证后回当前 URL |
| 09-22 | `cbafdbc1` | 文档双列独立滚动：用 flex 高度链（`flex:1 1 auto; min-height:0`），**不能用 `height:100%`**（父只有 max-height 时百分比退化） |
| 09-22 | ~ | 公告改「先弹窗 → 展示等待 → 数据回原地刷新」，失败要求显示错误态 + 不记已读 |
| 09-23 | `fe8e8ae` | 登录/注册三方视图玻璃拟态（深蓝渐变 + blur + 好转动画）、输入框 48px + 眼睛切换 + 顶部错误横幅 |
| 09-24 | `5e270ae0` | 宽表「操作列」`.ops-sticky: sticky right:0`（列多时按钮被挤出视口，存在但看不见） |
| 09-24 | `1aee4667` | 全站表格用 `.table-wrap` 包裹，**必须同时给 `max-height`**，否则容器变 th sticky 新参照物、表头吸顶静默失效 |

### 🚨 线上事故：内联脚本 SyntaxError（09-24，`b8d3c58f`）

- 线上 `/login` 报 `Unexpected identifier 'as'` —— 后台前端是**嵌在 TS 模板字面量里的裸 JS 字符串**，
  不经编译；`groupModelsForm` 里写了 `e.target as HTMLInputElement` 等 TS 注解被原样发到浏览器，
  整个 script 块解析失败，后台全挂。
- 🚨 **铁律**：`admin-ui.ts` 模板字面量内禁止 `as` 断言 / 箭头参数标类型 / 泛型；改完后台前端必须
  本地 dev 提取 script 块 `node --check` / `new Function()` 验证再交部署。同理**模板字面量里不能出现反引号**（TS 拆串 + 正则提前闭合）。

### 模型管理页（09-24 三连改）

- `a21a69c1` 模型别名并入「模型定价」页（别名标签 = 2 面板）；
- `acfb5002` 菜单改名「模型管理」，tab「自行新增别名 + 从上游获取并批量新增」吸顶；
- `18ad46dc` 拆 4 tab：别名列表 / 别名设置 / 模型定价 / 默认单价（`MODELS_TAB` 记住选页）；
- 吸顶重叠修复：`.page-head.no-stick` 让标题随内容滚走，只留 tab 吸顶。

### 分组「模型关联」（`440f4d4c` + `55ee6872`）

- 分组操作列新增「模型关联」：弹窗按上游平台分 tab，多选+档内全选；保存写 `groups.model_allowlist`；
  用户 `/v1/models` 按它过滤（非空时）。
- 接着升级**平台::模型 复合格式**使同名模型跨平台区分、模型名大小写敏感（唯一 id = 平台|模型），
  候选按原名精确去重，已选但候选消失的进「其他」档防静默丢失。

### 别名增强（`841806df`，09-24）

- 改名：编辑态去 readonly，保存 = 删旧键+写新键（**整表替换语义**），撞名（大小写不敏感）拒绝；
- 批量删除：扁平表加勾选列 + 表头全选 + 确认弹窗，删除按账号分组逐账号 PUT。

---

## 七、API Key / 令牌相关

- **09-22 `c80bcd01`**：`generateApiKey()` 由 64 位 hex（总 67 字符）改为
  `randomUUID().replace(/-/g,'')` ⇒ `sk-` + 32 hex（35 字符）。只发客户端 Key，往后只做不透明
  字符串整串查、无长度校验 → **线上老 key（67 字符）照旧能用**。
- 统一登录/注册会话走 `users` + `roles.menus` + 自助发 Key 挂最小 id 分组（`resolveSelfGroupId`）。

---

## 八、工程化 / 文档

- 清理历史遗留文件（根目录 `_fix*.txt` 草稿、tools/ 一次性调试脚本 repro/stress/probe）——
  🧨 **本机 `git rm` 单文件会误删整个目录**，请用 `Remove-Item` + `git add -u`；
- `worker/README.md` 作为唯一部署文档，清除调试过程数据（真实 ID / 报错原文 / 平台名示例 → 通用占位符）；
- `.gitignore` 补 `.devlog/`、`*.bat`、`*.sqlite` 等临时产物；
- docs/ 运维知识库（本目录）多轮沉淀，见 README。

---

## 九、经常踩的坑（**务必以「整改后的样子」为准**）

1. **模板字面量 = 裸 JS**：无 / `as` 类型注解、无箭头参数类型、无泛型、无反引号（含 CSS/JSS 注释）→ 改完必须浏览器级验证。
2. **百分比高度链**：父只有 `max-height` 时 `height:100%` 退化，布局要写不依赖百分之百的 flex 链。
3. **表格滚动容器**：`overflow-x:auto` 会静默干掉表头 `sticky;top:0`，必须同加 `max-height`。
4. **`handleAdminApi` 不解析 DELETE body**：批量删除永远"ids is required"，先查这行。
5. **部署必须用户明示**；删 tools 脚本先跑 `check:refs`（predeploy 会拦住缺失引用）。
6. **D1 迁移后必须重验表结构**（首次 `--remote` 迁移可能静默失败，重跑一遍才稳）。
7. `wrangler deploy --no-bundle` 会跳过 esbuild 把 `import type` 原样上发 → 不要加这个 flag。
8. 排查「模型走错平台」**只认 `usage_logs.account_id`**，不认响应 200。