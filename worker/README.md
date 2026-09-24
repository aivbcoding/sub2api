# sub2api × Cloudflare Workers

把 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)（Go + Gin + Ent + PostgreSQL + Redis 的 AI API 网关）
移植到 Cloudflare Workers 的 **MVP 骨架**。这是「方案 C」的落地成果。

> 上游许可证 **LGPL-3.0**。本目录为独立重写实现，上游源码仅作参考，可自行克隆在 `../upstream/`。

---

## 项目说明
面向稳定使用而设计的 API 中转站入口，适合日常接入、账号登录和邀请码开通。 用户进入后可以快速完成登录、开通和后续使用，不需要再经过额外跳转说明。

## 部署状态

本项目已验证可在 Cloudflare Workers 上生产部署。示例域名：<https://sub2api.aixm.ccwu.cc>
（可替换为你自己的域名，详见下文「绑定自定义域名」）。管理后台即域名根目录 `/`（未登录自动跳 `/login`）。

所需 Cloudflare 资源绑定（`wrangler.toml` 中声明，脚本会自动创建并回填）：

| 资源 | 绑定名 | 说明 |
|---|---|---|
| D1 数据库 | `DB` | 网关核心表（`schema/schema.sql`）+ 鉴权视图 |
| KV 命名空间 | `KV` | 认证缓存、调度快照等可容忍最终一致性的场景 |
| Durable Object | `AccountCoordinator` | 粘性会话、并发槽位、RPM 计数 |
| Secret | `ADMIN_JWT_SECRET` | 后台登录 JWT 签名密钥（**必填**） |

---

## 结论先说：可行，但有代价

| 维度 | 结论 |
|---|---|
| **技术上能不能跑** | ✅ 能。核心链路（鉴权 → 选号 → 转发 → 流式透传 → 计费）已在 Workers 上跑通 |
| **是否"直接部署"** | ❌ 不能。上游没有任何 Cloudflare 适配，等于重写后端 |
| **官方支持** | ❌ 上游只支持 脚本安装 / Docker Compose / Apple container / 源码构建 四种，全需常驻服务器 |
| **本 MVP 覆盖** | 网关核心链路 + 多协议转发 + **Web 管理后台**；**不含**支付、兑换码、公告、渠道监控等运营模块 |

### 实测结论

核心链路（鉴权 → 选号 → 转发 → 流式透传 → 计费）已在 Workers 上跑通：

- 已用真实上游验证 `Authorization: Bearer` 与 `x-api-key` + `anthropic-version` 两套认证头构造正确；
- 上游用「占位凭证无效」拒绝时，返回的是官方原生错误体 —— 证明整条链路（鉴权 → D1 → 调度 → 并发槽位 → 上游 API）是通的。

完整端到端测试见 `test/e2e.mjs`（覆盖多协议转发与协议转换）。

---

## 架构映射

上游是重状态服务，Workers 是无状态边缘运行时，逐项对应关系如下：

| 上游（Go） | 本实现（Workers） | 说明 |
|---|---|---|
| Gin 路由树 | `src/index.ts` | 只保留网关路由，砍掉 400+ 条管理后台路由 |
| `middleware/api_key_auth.go` | `src/auth.ts` | 含 query 传 key 一律 400 的上游行为 |
| PostgreSQL 15+ / Ent ORM | **D1** (`schema/schema.sql`) | 6 张核心表 + 鉴权视图 |
| Redis — 缓存 / 最终一致 | **KV** | 认证缓存、调度快照等可容忍延迟的场景 |
| Redis — ZSET / 原子计数 | **Durable Object** | 粘性会话、并发槽位、RPM 计数 |
| `gateway_scheduling.go` | `src/scheduler.ts` | 粘性会话 → 加权打分 → 抢槽位 |
| `gateway_upstream_*.go` | `src/gateway.ts` + `src/protocol.ts` | 多协议转发与认证注入 |
| `gateway_upstream_response.go:1158` | `src/stream.ts` | SSE 逐行解析 + 原样透传 |
| `billing_service.go` + `usage_billing_repo.go` | `src/billing.ts` + `src/billing-repo.ts` | 计费公式 + D1 batch 原子扣费 |

### 三个关键移植决策

**1. 金额改用整数微美元。** 上游 `NUMERIC(20,8)` 在 SQLite 无定点类型，用浮点会出现
`1e-8` 级别的余额对账误差。本实现统一 `INTEGER` 存微美元（`1 USD = 1e8`）。

**2. 原子计数必须用 Durable Object，不能用 KV。** KV 是最终一致且不支持原子 `INCR`/`ZSET`，
并发槽位和 RPM 计数会算错。DO 天然串行且 `<1s` 的 `await` 不会被中断，能安全实现「检查-占用」。

**3. 扣费改用 D1 `batch()`。** 上游是请求结束后开 `sql.Tx` 顺序执行；
D1 无长连接事务，`batch()` 在一个隐式事务中执行，全成功或全失败，语义等价。
幂等靠 `usage_billing_dedup` 主键 `(request_id, api_key_id)`。

---

## 目录结构

```
worker/
├── 01-login.bat             # 第 1 步：浏览器登录 Cloudflare
├── 01b-login-token.bat      # 第 1 步备选：API Token 登录
├── 02-deploy.bat            # 第 2 步：建资源 + 建表 + 部署
├── wrangler.toml            # D1 / KV / DO 绑定（脚本会自动填 ID）
├── package.json
├── tsconfig.json
├── schema/
│   ├── schema.sql           # D1 建表 + v_api_key_auth 视图
│   ├── schema-admin.sql     # 管理后台：管理员账号 + 审计日志
│   ├── schema-custom-platform.sql # 账号 protocol 列 + 内置平台协议回填
│   ├── schema-view-auth.sql # 重建鉴权视图（加列后必须执行）
│   └── seed.sql             # 测试数据（含占位凭证，需替换）
├── src/
│   ├── index.ts             # 入口：路由 + CORS + 鉴权编排 + 后台入口
│   ├── auth.ts              # API Key 鉴权 + IP 白黑名单（含 CIDR）
│   ├── protocol.ts          # 平台常量 / URL 推导 / 认证头注入
│   ├── scheduler.ts         # 账号调度（粘性 → 打分 → 抢槽位）
│   ├── durable-object.ts    # AccountCoordinator：槽位/粘性/RPM
│   ├── stream.ts            # SSE 解析 + usage 提取
│   ├── billing.ts           # 计费公式 + 窗口翻转
│   ├── billing-repo.ts      # D1 batch 原子扣费
│   ├── gateway.ts           # 转发核心
│   ├── translate.ts         # 协议转换：anthropic/openai/gemini/ SSE 互转
│   ├── time.ts              # D1/SQLite 时间戳解析（强制 UTC，避免时区偏移）
│   ├── models.ts            # GET /v1/models：多上游模型聚合 + 白名单过滤
│   ├── admin-auth.ts        # 后台鉴权：PBKDF2 密码 + HMAC JWT + 审计
│   ├── admin-api.ts         # 后台 REST API（用户/Key/账号/分组…）
│   ├── admin-ui.ts          # 后台单文件前端（无构建、无 CDN）
│   └── types.ts
├── tools/
│   ├── gen-admin-secret.mjs # 生成 JWT 密钥 + 管理员密码哈希
│   ├── check-admin-ui.mjs   # 校验 admin-ui 内联 <script> 是合法 JS
│   └── mock-upstream.mjs    # 本地 mock 上游（校验请求形状, 验证协议转换）
├── test/
│   ├── e2e.mjs              # 23 项端到端测试（真实上游）
│   └── translate-e2e.mjs    # 29 项协议转换测试（配合 mock 上游）
```

---

## 管理后台 🎛️

访问 **域名根目录 `/`**（如 <https://sub2api.aixm.ccwu.cc/>）—— 根目录就是控制台首页，
**未登录会自动跳到 `/login`**。用网页直接管理 API Key、上游账号、分组、定价等 ——
**改配置不需要改代码、不需要重新部署**。

> 登录是**统一的**：只有一个登录页，账号取自 `users` 表。用户名或邮箱都能登
> （如 `admin` 或 `admin@local`）。登录后能看见哪些菜单由 **角色**（`roles` 表）决定，
> 详见下文「角色与菜单权限」。

### 首次启用（仅一次）

```bash
cd worker

# 1. 建后台数据表
npx wrangler d1 execute sub2api --file=./schema/schema-admin.sql --remote -y

# 2. 建角色表（admin / user 两个内置角色）
npx wrangler d1 execute sub2api --file=./schema/schema-roles.sql --remote -y

# 3. 生成密钥与密码哈希（脚本会打印可直接复制的命令）
node tools/gen-admin-secret.mjs "你的密码"

# 4. 按脚本输出，先写入 JWT 密钥
npx wrangler secret put ADMIN_JWT_SECRET

# 5. 再按脚本输出的 SQL 创建管理员账号
#    （写入 users 表：role='admin'、status='active'、password_hash=第 3 步的哈希）

# 6. 部署
npx wrangler deploy
```

> 密码用 **PBKDF2-SHA256**（10 万轮）存储，会话用 **HMAC-SHA256 JWT**（12 小时）、
> **HttpOnly + Secure + SameSite=Strict** Cookie。所有写操作进 `admin_audit_logs`。

> 📌 老部署（曾用 `admin_accounts` 登录）升级时跑一次
> `node tools/migrate-admin-accounts.mjs --apply`，它会把管理员并进 `users`
> 并**保留原密码**。忘记密码用 `node tools/backfill-user-passwords.mjs --user <账号> "新密码"` 救砖。

### 邮箱验证码注册（可选，推荐开启）

注册流程可选启用「Turnstile 人机验证 + 邮箱验证码」：

```bash
# 1) 建验证码表
npx wrangler d1 execute sub2api --file=./schema/schema-email-verify.sql --remote -y

# 2) 部署独立邮件网关 Worker(见 sub2api/mail-worker/README.md), 拿到 URL

# 3) 配置主站 Secret
npx wrangler secret put TURNSTILE_SECRET_KEY   # Cloudflare Turnstile Siteverify 密钥
npx wrangler secret put TURNSTILE_HOSTNAMES    # 例如 aixm.ccwu.cc,sub2api.aixm.ccwu.cc
npx wrangler secret put MAIL_WORKER_URL        # https://<mail-worker>/send
npx wrangler secret put MAIL_WORKER_SECRET     # 与邮件 Worker 的 SUB2API_WORKER_SECRET 一致
npx wrangler secret put VERIFY_CODE_PEPPER     # 验证码 HMAC 用 Pepper(随机长字符串)
```

`TURNSTILE_SITE_KEY`（公开值）已写入 `wrangler.toml` 的 `[vars]`。

**降级规则**：未配置 `TURNSTILE_SECRET_KEY` 时注册页不显示验证码区、注册走旧流程（不破坏现有用户）；
未配置 `MAIL_WORKER_URL` 且 `DEBUG_MAIL=1` 时进入调试模式（不真发信，验证码回显到表单上方横幅），
方便本地/无发信环境联调完整注册链路。生产**禁止**开 `DEBUG_MAIL`。

### 角色与菜单权限

- `roles` 表：`code` / `name` / `menus`(JSON 数组) / `builtin`。
  内置 `admin` = `["*"]`（全部）、`user` = `["mykeys"]`（只能看「我的 API Key」）。
- **菜单权限就是接口权限**：后端把每个 `/api/admin/<资源>` 映射到一个菜单键，
  角色没有就返回 **403**（不是"前端藏起来"）。未登记的资源是 **404**（fail-closed）。
- 角色可以在「角色权限」页新建/编辑；**权限每次请求现查库**，改完立即生效，不用重新登录。
- 业务用户登录后只有「我的 API Key」页（`/api/admin/my/*`）：只能看/发/删**自己的** Key
  和用量，越权删别人的会拿到 404。自助发的 Key 会落到「设置」里的「自助 Key 默认分组」。
- 用户管理页有「创建时间」列；**只有超管能改别人的 `role`**。

### ⚠️ 改 `admin-ui.ts` 前必读：反斜杠要写两遍

`src/admin-ui.ts` 里整个前端是一段 **TS 模板字面量**（`const ADMIN_HTML = \`...\``），
里面嵌着浏览器要执行的 `<script>`。模板字面量会把 `\/` 求值成 `/`，
所以 **源码里写一个反斜杠，线上就少一个**：

| 源码（错误） | 求值后（浏览器收到） | 结果 |
|---|---|---|
| `/^https?:\/\//i` | `/^https?:///i` | `//` 变行注释 → 整段脚本 `SyntaxError` |
| `/^https?:\\/\\//i` | `/^https?:\/\//i` | ✅ 正确 |

**规则：嵌在 `ADMIN_HTML` 里的 JS 字符串中，需要保留的 `\` 一律写成 `\\`。**

这个错误 `tsc` 查不出来（TS 源码本身合法），只有把渲染结果交给 JS 解析器才暴露。
因此部署前务必跑一次检查：

```bash
npm run check        # = tsc --noEmit + 内联脚本语法检查
npm run check:ui     # 只查内联 <script> 是否合法 JS
```

`npm run deploy` 已挂 `predeploy`，会自动先跑 `npm run check`。

> 忘记密码时，重跑第 2、4 步即可重置。

### 能管什么

| 模块 | 能力 |
|---|---|
| 总览 | 用户/Key/账号/分组计数、今日请求与花费、模型 TOP、7 日趋势 |
| API Key | 增删改查、生成 `sk-` + 64 hex、额度与 5h/1d/7d 限速、配额重置、**列表/新建后一键复制完整 Key** |
| 上游账号 | 增删改查、连通性测试、优先级/并发/权重、**切换 key 立即生效**、**支持自定义第三方平台** |
| 分组 | 平台绑定、倍率、模型白名单、模型映射、RPM |
| 用户 | 余额、并发、状态、**平台访问限制** |
| 模型定价 | 输入/输出/缓存读写单价 |
| 用量 / 审计 | 请求日志、操作留痕 |
| 设置 | 改管理员密码、查看运行时变量 |

> ### 🔴 先读这条：平台名必须能被"模型名"推断出来，否则账号永远选不中
>
> 调度器按**模型名**判平台（`inferPlatformFromModel()`），再去挑 `platform` 等于该值的账号。
> 推断表只认这几个名字：
>
> `anthropic`（claude*）、`gemini`（gemini*）、`grok`（grok*）、`deepseek`（deepseek*）、
> `kimi`（kimi*/moonshot*）、`zhipu`（glm*/zhipu*）、`minimax`（minimax*/abab*）、
> `openai`（gpt-*/o1~o9/chatgpt/davinci/text-*/dall-e/whisper/tts-*）
>
> **所以自造平台名（`my-relay`、`oneapi`、`my-platform`…）在走模型名推断时永远选不中**，
> 表现为 `503 no_upstream_account: platform "xxx"`。
>
> 接第三方中转的**推荐做法**：不要自造名字，直接把 platform 填成**协议对应的内置名** ——
> - OpenAI 兼容中转接 `Deepseek-*` 模型 → platform 填 **`deepseek`**，protocol `openai`
> - 通用 OpenAI 兼容中转 → platform 填 **`openai`**，protocol `openai`
>
> ⚠️ **改平台时注意**：编辑弹窗的平台下拉现在会**同时列出内置平台和该账号的当前平台**，
> 所以能正常切换。但如果你**选了「＋ 自定义平台」再手打一个名字**，那就又回到"选不中"的状态了。
>
> 想用自造平台名也能跑通，只有一个办法：给**分组**或**用户**设平台限制
> （`groups.platform` / `users.platform_access`）—— 但副作用是该 key 的**所有**模型都会被送去这个账号，
> 同 key 的其他平台会一起坏掉。**除非确定只有一个上游，否则别用。**

### 🌐 接入自定义第三方平台

上游不只是官方 10 个平台，还可以接**任意第三方中转站 / 自建网关 / 私有部署**
（one-api、new-api、各类 Claude/GPT 镜像站等）。

在「上游账号 → 添加上游账号」里：

1. **平台** 下拉选 `＋ 自定义平台`
2. 填 **自定义平台标识**，如 `my-relay`、`oneapi`、`newapi`
   （小写字母/数字/下划线/连字符，1–64 字符）
   —— ⚠️ 先读上面的红框，自造名字会导致选不中，**多数情况直接选内置平台更省事**
3. 选 **通信协议** —— 这是关键，决定请求怎么发：
   | 协议 | 转发路径 | 认证头 | 适用 |
   |---|---|---|---|
   | `openai` | `/v1/chat/completions` | `Authorization: Bearer` | 绝大多数中转站、one-api/new-api |
   | `anthropic` | `/v1/messages` | `X-Api-Key` + `Anthropic-Version: 2023-06-01` | Claude 镜像站 |
   | `gemini` | `/v1beta/models/{model}:generateContent` | `X-Goog-Api-Key` | Gemini 代理 |
   > `openai` 协议**只在入站本身就是 `/responses` 路径时**才转发到 `/v1/responses`；
   > 普通 chat/completions 一律走 `/v1/chat/completions`。
   > 因为第三方「OpenAI 兼容」中转普遍**没有** `/v1/responses` 这个端点。
4. 填 **Base URL**（自定义平台**必填**，因为官方域名无从得知）
5. 保存后建议点一下 **测试** 验证连通性

选好平台后协议会自动带出默认值，你仍可手动改。

> **为什么不是只填平台名就够了？** 平台名只是个标签（用于分组和选号），
> 光看名字无法判断对端说 OpenAI 还是 Anthropic 协议 —— 所以协议要显式选。
> 内置平台则通过内置映射自动推导，行为与之前完全一致。

各协议转发路径与认证头示例：

```
协议=openai     → https://<base_url>/v1/chat/completions
                  Authorization: Bearer <api_key>
协议=anthropic  → https://<base_url>/v1/messages
                  X-Api-Key: <api_key> | Anthropic-Version: 2023-06-01
协议=gemini     → https://<base_url>/v1beta/models/{model}:generateContent
                  X-Goog-Api-Key: <api_key>
```

分组也可以绑自定义平台：分组的「平台」字段是自由文本，支持逗号分隔多个。

> **「测试」按钮报 `Reachable (HTTP 400)` 是什么意思？**
> 探针打的是 `GET <base>/v1/models`。有些上游（如部分第三方中转站）**没实现**这个端点，
> 无论带不带 Key 都返回同一个 400 —— 所以**不能用它判断凭证是否有效**。
> 后台会显示橙色 **「待验证」**（而不是绿色的"通"）来避免给你虚假的安心感。
> 真正的验证方式是**发一次对话**。
> 这类上游的模型会被**自动补进**中转的 `/v1/models` 列表：网关会检查该平台的账号能否列出模型，
> 列不出来就按「模型名 → 平台」的推断规则从本地定价表里补齐，这样客户端不会因为
> 看不到模型名而误报 "model may not exist"。

### 🚨 两个账号平台名相同 = 会互相污染

调度器是**按 `platform` 字段选号**的：`SELECT ... WHERE platform = ?`。
所以**同一平台下挂多个上游，它们的模型集必须一致**，否则会出诡异故障。

典型症状：给同一个模型名配了两个上游账号（一个正确、一个不提供服务），
请求会在两者之间轮询 —— **一半成功、一半报 `model is not found`**，看起来像"时好时坏"。

- ❌ 错误做法：把「上游 A（某第三方中转）」和「上游 B（某自建网关）」都设成同一个 `platform`
- ✅ 正确做法：让每个上游在自己的平台名下，只把**真正提供同一批模型**的账号归到同一平台

判断依据：如果两个上游的模型列表不一样，就不该共用平台名。
第三方中转 / 自建网关请用**自定义平台名**（后台平台下拉框选「＋ 自定义平台」），
避免和内置平台（`deepseek` / `openai` / `kimi` …）撞车。

> 💡 用 `wrangler d1 execute ... "SELECT id,name,platform,base_url FROM accounts WHERE deleted_at IS NULL"`
> 一条命令就能看出有没有平台名重复。

### 🎯 模型 → 平台 重定向：让一个模型精确走某个上游

解决完平台撞名后还会剩一个形态的问题：**同一个"模型家族"分散在不同上游**。

例如有两类上游：
- 上游 A（某第三方中转）只提供 `model-x`
- 上游 B（某自建网关，自定义平台名 `my-platform-b`）只提供 `model-y`

两个名字都含某共同前缀，靠模型名推断**都会判成同一个内置平台**，无法区分；
而 `my-platform-b` 是**自定义平台名**，永远命不中推断表，结果 `model-y` 被送错上游，
报 `invalid model: model name not found`。

**解法**：分组里配「模型 → 平台」重定向（后台 **分组 → 编辑 → 模型 → 平台 重定向**，填 JSON）。

```json
{
  "model-y": "my-platform-b",
  "another-model": "my-platform-b"
}
```

还支持**顺带改写模型名**——用于不同上游对大小写要求相反的场合：

```json
{
  "model-y": { "platform": "my-platform-b", "model": "Model-Y" },
  "Model-Y": { "platform": "my-platform-b", "model": "Model-Y" }
}
```

> ⚠️ **模型名大小写敏感**是本项目最容易踩的坑之一：
> 不同上游对大小写的要求可能正好相反（有的全小写才认、有的首字母大写才认），
> 别指望客户端统一。用上面的 `{platform, model}` 写法把多个大小写变体都映射到对端的正确写法，
> 用户就不用记这些细节了。

生效优先级：**模型→平台重定向 > 分组 platform > 用户平台白名单 > 模型名推断 > 路径特征**。
（用户白名单是硬边界：重定向目标若不在白名单内，会退回白名单首个平台。）

排查辅助：
```powershell
node tools\verify-routing.mjs      # 批量打各模型 + 大小写变体, 看谁通谁不通
node tools\upstream-probe.mjs      # 直连上游对比, 确认"这个模型到底在哪个上游"
```

### ⚠️ 粘性会话：改完账号配置要清一下

调度器有 **粘性会话（默认缓存 1 小时）**：同一个会话的请求会被钉在同一个上游账号上，
这是上游的原始设计，用来提高缓存命中率。

副作用是 —— **你在后台把账号 A 的 key 换成新的，旧会话在 1 小时内仍会走 A 的旧配置**，
看起来像"改了不生效"。

处置方式：进入 **上游账号** 页，点右上角 **「清空粘性会话」**；改完账号后页面也会主动弹窗询问。
重新选号后请求立刻走新配置。

### 后台 API 一览

```
GET    /api/info                   站点机读信息（公开）
GET    /                       控制台首页（未登录 302 到 /login）
GET    /login                  登录页（公开，自身不重定向）
POST   /api/admin/login            登录（公开，用户名或邮箱）
POST   /api/admin/logout           登出（公开）
GET    /api/admin/me               当前身份：role / role_name / menus / is_admin（公开，未登录 401）
GET    /api/admin/dashboard        总览
CRUD   /api/admin/users            用户（新增列「创建时间」；role 仅超管可改）
CRUD   /api/admin/roles            角色与菜单权限（内置 admin/user 不可改不可删）
CRUD   /api/admin/my/keys          「我的 API Key」：只碰自己（业务用户可用）
GET    /api/admin/my/usage         自己的用量
CRUD   /api/admin/groups           分组
CRUD   /api/admin/api-keys         API Key
CRUD   /api/admin/accounts         上游账号
POST   /api/admin/accounts/:id/test 账号连通性测试
GET    /api/admin/sticky           粘性会话状态
POST   /api/admin/sticky/clear[/:id] 清空粘性会话
GET    /api/admin/usage            用量日志（非超管自动只看自己）
GET    /api/admin/audit            审计日志（非超管自动只看自己）
GET/PUT /api/admin/settings        设置 / 改密（自助 Key 默认分组）
GET/POST/DELETE /api/admin/models  模型定价
```

除前 4 个外全部需要登录会话，支持 Cookie 或 `Authorization: Bearer <token>`。
每个资源都按角色的 `menus` 判权：没有对应菜单键 **403**，未登记资源 **404**。

---

## 部署步骤

已备好三个批处理脚本（Windows），按顺序运行即可。

### 第 1 步：登录 Cloudflare（必须你亲自操作）

浏览器登录（推荐）：

```
双击运行  01-login.bat
```

会自动拉起浏览器，点 **Allow** 授权即可。

> 如果浏览器登录不方便，改用 `01b-login-token.bat`，
> 用 API Token 认证（Token 需含 D1 Edit / Workers KV Edit / Workers Scripts Edit 权限）。

> **注意**：这一步无法由 AI 代劳 —— `wrangler login` 是交互式的，必须在你自己的终端里跑。

### 第 2 步：创建资源并部署

```
双击运行  02-deploy.bat
```

脚本会自动完成：

1. 校验登录状态
2. `wrangler d1 create sub2api --binding DB --update-config` — 建库并**自动把 ID 写进 `wrangler.toml`**
3. `wrangler kv namespace create KV --binding KV --update-config` — 建 KV 并自动写配置
4. `wrangler d1 execute --remote` — 远程建表
5. `wrangler deploy` — 部署

脚本会在第 3 步暂停，让你确认 `wrangler.toml` 里的占位符已被替换成真实 ID。

### 第 3 步：灌数据并替换真实凭证

```bash
# 先灌入测试数据
npx wrangler d1 execute sub2api --file=./schema/seed.sql --remote -y
```

然后编辑 `schema/seed.sql`，把这三个占位符换成你真实的上游 key：

| 占位符 | 位置 |
|---|---|
| `sk-ant-REPLACE_ME` | Anthropic 账号凭证 |
| `sk-REPLACE_ME` | OpenAI 账号凭证 |
| `REPLACE_ME` | Gemini 账号凭证 |

改完重新执行上面那条 `d1 execute` 命令。

### 第 4 步：验证

```bash
curl https://<你的域名>.workers.dev/health
```

返回 `{"status":"ok",...}` 即部署成功。

完整功能验证（17 项测试）：

```bash
BASE_URL=https://<你的域名>.workers.dev node test/e2e.mjs
```

### （可选）绑定自定义域名

默认部署后 Worker 有一个 `*.workers.dev` 地址。要绑自己的域名（如 `sub2api.aixm.ccwu.cc` 或 `aixm.ccwu.cc`）：

- **图形化（推荐）**：Cloudflare 控制台 → **Workers & Pages** → `sub2api-worker` → **Settings → Domains** → 添加 `sub2api.aixm.ccwu.cc`。前提：该域名 DNS 由 Cloudflare 托管。
- **wrangler.toml**：在末尾加
  ```toml
  [routes]
  "sub2api.aixm.ccwu.cc/*" = "sub2api-worker"
  ```
  再 `npm run deploy` 生效。

> 无论用哪个域名访问，后台「操作说明」里的示例 URL 都会自动取当前访问域名（`location.origin`），无需改代码。

---

## 手动部署（不用脚本）

```bash
npm install
npx wrangler login
npx wrangler d1 create sub2api --binding DB --update-config
npx wrangler kv namespace create KV --binding KV --update-config
npx wrangler d1 execute sub2api --file=./schema/schema.sql --remote -y
npx wrangler d1 execute sub2api --file=./schema/seed.sql --remote -y
npx wrangler deploy
```

本地验证：

```bash
# 首次需初始化本地 D1，否则鉴权会报 no such table: v_api_key_auth
npx wrangler d1 execute sub2api --file=./schema/schema.sql --local -y
npx wrangler d1 execute sub2api --file=./schema/seed.sql --local -y
npx wrangler d1 execute sub2api --local -y --command "ALTER TABLE users ADD COLUMN platform_access TEXT"
npx wrangler d1 execute sub2api --file=./schema/schema-view-auth.sql --local -y

npx wrangler dev --port 8787 --local
node test/e2e.mjs
```

> 本地访问 8787 若报 `upstream connect failed`，是 HTTP 代理拦截了 localhost：
> 加 `NO_PROXY=127.0.0.1,localhost` 或 curl 加 `--noproxy '*'`。

---

## 遇到的坑（供参考）

| 问题 | 原因 | 解决 |
|---|---|---|
| `.bat` 双击闪退 / "不是内部或外部命令" | 文件是 **LF 行尾**，Windows 批处理必须用 **CRLF** | 转成 CRLF + 加 UTF-8 BOM（见 `fix-bat-encoding.ps1`） |
| `wrangler whoami` 报 400 | wrangler 3.x 与 CF 当前 API 不兼容 | 升级到 wrangler 4 |
| `ERESOLVE` 依赖冲突 | wrangler 4 需要 `@cloudflare/workers-types@^5` | 一并升级 |
| 后台登录页 `SyntaxError: Unexpected identifier 'toast'` | 模板字面量吞掉 `\/`，`/^https?:\/\//i` 线上变成 `//` 行注释 | 源码写 `\\/`；用 `npm run check:ui` 拦截 |
| 本地 E2E 报 `no such table: v_api_key_auth` / `no such column: u.platform_access` | 本地 D1 没初始化 | 按上文「本地验证」跑 schema + seed + 视图重建 |
| 新建 Key 时「所属用户」下拉是空的 | `GET /api-keys` 只返回 key 列表，没返回 `users` | 已在 `handleApiKeys` 的 GET 里一并返回用户列表（`{ api_keys, users }`） |
| 本地 `wrangler dev` 登录报 `ADMIN_JWT_SECRET is not set` | 该值线上是 secret，本地没有 | 本地启动加 `--var ADMIN_JWT_SECRET:<任意值>`，并本地 `users` 表插一条 `role='admin'` 的账号（用 `node tools/gen-admin-secret.mjs` 生成的哈希） |
| `--update-config` 没写进配置文件 | wrangler 4 只**打印**提示片段，不会真的改 `wrangler.toml` | 脚本自己提取 ID 并用 PowerShell 回写 |
| `findstr /C:"logged in"` 误判 | `Not logged in` 也含 `logged in` 子串 | 先匹配否定串，再匹配 `You are logged in` |
| Bash 里 `ls`/`cat`/`mkdir` 全部 not found | 环境注入了损坏的 `BASH_ENV` 脚本 | 把 `BASH_ENV` 指向空文件 |
| PowerShell 访问 localhost 连接失败 | 系统代理劫持了请求 | 用 Node 的 `net` 模块探测 TCP，或清空代理变量 |
| 带工具的请求打 Gemini 报 `Unknown name "$schema"` | Gemini 的 `Schema` proto 只认部分 JSON Schema 关键字，而 OpenAI/agent 客户端的工具定义常带 `$schema`/`additionalProperties` | `toGeminiSchema()` 白名单递归清洗 + `$ref` 展开 |
| 带工具的请求打 Gemini 报 `...items.items: missing field.` | 客户端 schema 结构不完整（数组缺 `items`、节点缺 `type`），Gemini 对每个节点都有硬性要求 | `toGeminiSchema()` 收尾：补 `type`、给 array 补非空 `items`、结构优先于声明 |
| 账号 429 后冷却"不生效"、限流形同虚设 | SQLite `datetime('now')` 是 **UTC 无时区后缀**，`Date.parse` 按本地时区解释，非 UTC 环境整体偏移 | 统一走 `parseDbTime()`，补 `T`/`Z` 强制 UTC |
| `/v1beta/models/{model}:generateContent` 报 `models/unknown` | 模型名在 URL 上不在 body 里，`extractModel` 只读 `body.model` | 加 `extractModelFromPath()` 回退 |
| 上游限流时只报 `no_available_account` | 冷却/没配账号/被停用三种情况共用同一个 503 | 分别返回 429(`Retry-After`) / `no_upstream_account` / `no_available_account` |
| 失败日志只有 80 字符、无 UA/IP | `logFailure` 的 `message.slice(0, 80)` 与写死的空 UA | 放宽到 500 字符，并记录路径/模型/流式/UA/IP |

---

## 后续维护

重新部署（改完代码后）：

```bash
npx wrangler deploy
```

查看线上日志：

```bash
npx wrangler tail
```

改数据库结构后同步到远程：

```bash
npx wrangler d1 execute sub2api --file=./schema/schema.sql --remote -y
```

下线 Worker：

```bash
npx wrangler delete sub2api-worker
```

---

## 调用方式

与上游一致，三种认证头都支持：

```bash
# OpenAI 兼容
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Anthropic 兼容
curl https://<your-worker>.workers.dev/v1/messages \
  -H "x-api-key: sk-你的key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'

# 查询额度
curl https://<your-worker>.workers.dev/v1/sub2api/billing \
  -H "Authorization: Bearer sk-你的key"

# 获取可用模型列表（OpenAI 兼容）
curl https://<your-worker>.workers.dev/v1/models \
  -H "Authorization: Bearer sk-你的key"
```

---

## 📋 `GET /v1/models` 模型列表

拿着这个 Key，任何 OpenAI 兼容客户端（Cherry Studio / NextChat / LobeChat / Cursor…）
都能自动拉出可用模型，不用手动一个个填。

响应是标准 OpenAI 形状：

```json
{
  "object": "list",
  "data": [
    { "id": "gpt-4o", "object": "model", "created": 1700000000, "owned_by": "sub2api" }
  ]
}
```

### 三种模式（`MODELS_LIST_MODE`）

| 模式 | 行为 | 适用 |
|---|---|---|
| `auto`（默认） | 聚合各上游账号的真实模型，统一成 OpenAI 格式；上游全挂时回退到分组白名单 | 绝大多数情况 |
| `local` | **完全离线**，只返回分组白名单 / 定价表里的模型，不打上游 | 不想暴露上游、或上游不支持 `models` 端点 |
| `upstream` | 透传第一个可用上游的原生响应，不做聚合与格式统一 | 需要 Gemini 原生 `models` 数组形状 |

改 `wrangler.toml` 的 `MODELS_LIST_MODE` 或 `wrangler secret put` 同名变量即可切换。

### 聚合是怎么做的

1. **确定平台范围**：用户级白名单 > 分组 `platform`（支持逗号分隔多平台）> `openai,anthropic,gemini`
2. **逐平台取数**：每个平台挑一个可调度账号，按协议走**原生端点**：
   | 协议 | 上游路径 | 认证方式 |
   |---|---|---|
   | openai | `GET /v1/models` | `Authorization: Bearer` |
   | anthropic | `GET /v1/models` | `x-api-key` |
   | gemini | `GET /v1beta/models` | `?key=` 查询参数 |
3. **归一化**：兼容三种上游形状 —— `{data:[{id}]}` / `{models:[{name:"models/xxx"}]}` / 裸数组；
   Gemini 的 `models/` 前缀会被剥掉，只留模型名
4. **过滤**：分组 `model_allowlist` 是**硬约束**，白名单非空时只返回白名单内的模型
5. **兜底**：聚合结果为空时，回退到「分组白名单 + 分组定价表」的本地集合，而不是直接报错

> ⚠️ 注意：`/v1/models` **不会**被改写成 `/v1/responses`。
> 普通转发路径会把 `chat/completions` 收敛成 `responses`（上游策略），
> 但模型列表必须走原生端点，所以这里用了独立的 `deriveModelsEndpoint()`。

---

## 🔀 协议转换（客户端协议 ≠ 上游协议）

中转站的核心能力：**客户端说什么协议，上游就得能听懂**。

### 不转换会怎样

网关早期是「原样透传」，隐含假设 `入站格式 == 上游协议`。一旦不匹配就炸：

```
# Anthropic 客户端 (/v1/messages) 却选了 Gemini 模型
API Error: 400 Invalid JSON payload received.
  Unknown name "messages": Cannot find field.
  Unknown name "system": Cannot find field.
  Unknown name "input_schema" at 'tools[0]': Cannot find field.
```

因为 `{messages, system, tools[].input_schema}` 是 Anthropic 的形状，
而 Gemini 的 `generateContent` 只认 `{contents, systemInstruction, tools[].functionDeclarations}`。

### 支持矩阵（全部已实现并测试）

`src/translate.ts` 用**中枢式**设计：任意格式 `→toCanonical→ OpenAI Chat 规范形 →fromCanonical→ 目标格式`，
所以 N 种格式只需 2N 个适配器，而不是 N² 个直连转换。

| | → anthropic | → openai | → gemini |
|---|---|---|---|
| **anthropic 入站** | 直通 | ✅ | ✅ |
| **openai-chat 入站** | ✅ | 直通（保持 `/v1/responses` 策略） | ✅ |
| **openai-responses 入站** | ✅ | 直通 | ✅ |
| **gemini 入站** | ✅ | ✅ | 直通 |

请求侧会转换：`system` / `messages` / 多模态块 / `max_tokens` / `stop` /
`tools`（`input_schema` ⇄ `function.parameters` ⇄ `functionDeclarations`）/ `tool_choice`。

响应侧两个方向都会转（非流式 JSON + 流式 SSE），
流式会把事件序列也改成目标协议的规范（例如转 Anthropic 时会按
`message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop` 发）。

### 路由：模型名决定平台

为了让「Anthropic 客户端 + `gpt-4o`」能正确落到 OpenAI 账号，
`inferPlatformFromModel()` 现在也识别 OpenAI 家族模型名
（`gpt-*` / `o1`~`o9` / `chatgpt` / `davinci` / `text-*` / `dall-e` / `whisper` / `tts-*`）。

### ⚠️ 常见坑：上游账号还是占位凭证

种子数据里的账号凭证是 `sk-REPLACE_ME`。以前会把这个上游 401 原样透传：

```
{"message":"Incorrect API key provided: sk-REPLA*E_ME. ...","status":401}
```

现在网关会**提前拦下**并说清楚是哪个账号没配 key：

```json
{
  "error": {
    "message": "Upstream account \"openai-1\" still uses a placeholder credential. Please set a real API key for it in the admin panel (/admin → 上游账号).",
    "code": "placeholder_credential"
  }
}
```

> 👉 看到这个错误，去 `/admin → 上游账号 → 编辑`，把凭证换成真实 key 即可。

### ⚠️ 常见坑：带工具的请求打 Gemini 报 `Unknown name "$schema"`

Gemini 的 `Schema` proto **只认一部分 JSON Schema 关键字**。而 OpenAI / Anthropic
生态里工具定义的 `parameters`/`input_schema` 常常带 `$schema`、`additionalProperties`
（OpenAI SDK、Vercel AI SDK、Cline / Cursor 这类 agent 客户端几乎必带），
原样转发会被 Google 以 400 拒收：

```
Invalid JSON payload received. Unknown name "$schema" at 'tools[0].function_declarations[0].parameters': Cannot find field.
Invalid JSON payload received. Unknown name "additionalProperties" at ... : Cannot find field.
```

现在 `translate.ts` 里的 `toGeminiSchema()` 会用**白名单递归清洗**掉这些关键字
（`$schema` / `additionalProperties` / `$ref` / `oneOf` / `const` / `examples` /
`patternProperties` / `multipleOf` …），同时做这些归一化：

- `type: ["string","null"]` → `type: "string"` + `nullable: true`
- 本地 `$ref`（配合 `$defs`/`definitions`）**就地展开**，避免丢结构
- `items` 写成元组数组（`items: [A, B]`）→ 取第一个分支
- 数字/布尔 `enum` → 丢弃（Gemini 的 enum 只收字符串）

原则是**宁可有损也绝不 400** —— 丢掉 `additionalProperties: false` 只是约束变松，
但报 400 会让整个请求直接不可用。

#### 第二类报错：`...items.items: missing field.`

清洗之后还有一类坑：**结构不完整**。Gemini 对每个 schema 节点有硬性要求，
而清洗会丢键，丢掉之后节点可能就"空"了：

```
400 * GenerateContentRequest.tools[0].function_declarations[1].parameters
      .properties[query].properties[where].items.items: missing field.
```

这条的意思是：`where` 是数组 → 它的 `items` 也是数组 → **最内层那个数组没有 `items`**。
常见于客户端里 `where` 写成 `{type:"array", items:{type:"array"}}`（内层忘了写 `items`）。

`toGeminiSchema()` 的三条收尾规则保证结构永远合法：

| 规则 | 说明 |
|---|---|
| **每个节点都必须有 `type`** | 客户端常省略。按结构反推：有 `properties`→`object`，有 `items`→`array`，有 `enum`/`pattern`→`string`；只写了 `description` 这类则兜底 `string` |
| **`type:"array"` 必须有非空 `items`** | 缺了就补 `{type:"string"}`。这正是上面那条报错的解 |
| **结构优先于声明的 type** | 声明 `type:"string"` 却带 `properties` 时，以 `properties` 为准（结构信息更可信） |

函数参数的**顶层**强制定为 `{type:"object", properties:{}}`（空或缺失时也兜底），
因为 Gemini 要求函数参数必须是 object。

> `tools/mock-upstream.mjs` 已内置这两类校验（关键字 + 结构），报错路径格式与 Google 原文一致，
> 所以这类回归在本地测试阶段就会被拦下，不用等线上炸。

### ⚠️ 常见坑：账号限流冷却不生效（时区）

SQLite 的 `datetime('now')` 产出 `2026-09-20 05:38:33` —— **是 UTC 但没有时区后缀**，
而 JS 的 `Date.parse()` 对**空格分隔**的格式按**本地时区**解释。
运行环境一旦不是 UTC（本地 `wrangler dev` 在 UTC+8 就是），冷却时间会整体偏移 8 小时，
结果就是**账本记了 429 冷却、但调度器认为"早就过期了"**，限流形同虚设。

现在统一走 `src/time.ts` 的 `parseDbTime()`：识别到该格式就补上 `T`/`Z` 强制按 UTC 解析。
所有 `Date.parse` 调用点（调度冷却、用量窗口、Key 过期）都已收口到这里。

### ⚠️ 上游限流时不再含糊报 503

以前账号全部冷却时会回：

```json
{"error":{"message":"No available upstream account for platform \"gemini\".","code":"no_available_account"}}
```

使用者无法区分「配额用完要等一会儿」和「压根没配账号」。现在分三种情况：

| 情况 | 状态码 | code | 附带 |
|---|---|---|---|
| 账号都在冷却 | **429** | `upstream_rate_limited` | `Retry-After` 头 + 「约 N 秒后重试」 |
| 平台下没有账号 | 503 | `no_upstream_account` | 提示去后台加账号 |
| 有账号但被停用/不可调度 | 503 | `no_available_account` | —— |

### 失败日志

`usage_logs` 里的失败记录以前只存 80 字符、且不记 UA/IP/模型，排查上游 400 时看不到现场。
现在放宽到 500 字符，并带上 **入站路径、请求模型、是否流式、UA、客户端 IP**：

```
model = error:gemini:400:[/v1/chat/completions] {"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \"$schema\" ...}}
```

### 本地验证协议转换

```bash
# 1. 起 mock 上游（会校验请求形状，形状不对就回 400，模仿真实上游）
npm run mock

# 2. 把本地账号指向 mock，并确保凭证不是占位值
npx wrangler d1 execute sub2api --local -y \
  --command "UPDATE accounts SET base_url='http://127.0.0.1:9099' WHERE deleted_at IS NULL"

# 3. 起网关
npx wrangler dev --port 8787 --local --var ADMIN_JWT_SECRET:t

# 4. 跑协议转换测试（34 项）
npm run test:translate
```

跑标准回归前记得把 `base_url` 改回 `NULL`（让它打真实 vendor 域名）：

```bash
npx wrangler d1 execute sub2api --local -y \
  --command "UPDATE accounts SET base_url=NULL WHERE deleted_at IS NULL"
npm run test:e2e
```

---

## 已知限制（重要）

| 限制 | 说明 |
|---|---|
| **WebSocket** | 上游的 OpenAI Responses WS / Grok realtime 未实现（Workers WS 需 Durable Object 承载） |
| **支付 / 回调** | 支付链路（含支付回调）完全未移植 |
| **管理后台** | 已提供 `/admin` 网页后台，覆盖用户/Key/账号/分组/定价/用量/审计；上游约 416 处路由中的**运营类**模块（支付、兑换码、公告、代理、渠道监控、合规风控、插件、备份、订阅）未移植 |
| **跨协议转换** | ✅ 已实现（`src/translate.ts`）：anthropic / openai-chat / openai-responses / gemini 四格式互转，含请求体、非流式响应、流式 SSE 与工具定义。见上文「协议转换」 |
| **图片/视频生成** | 未实现（上游 `/images/`、`/videos/` 路由未移植） |
| **多模态图片输入** | 转换层目前只处理文本与工具调用；Anthropic 的 `image` 块会被降级为文本占位 `[image]`，未做真正的 base64/URL 透传 |
| **自定义平台** | 支持任意第三方上游，但必须选内置三种协议之一（openai/anthropic/gemini）。若对端是**完全私有**的协议，需自行扩展 `UPSTREAM_PROTOCOLS` |
| **平台名选不中** | 自造平台名（非 `anthropic/gemini/grok/deepseek/kimi/zhipu/minimax/openai`）在走模型名推断时**永远选不中**，报 `503 no_upstream_account`。接第三方中转请把 platform 直接填成对应内置名（OpenAI 兼容 → `openai` 或 `deepseek`），详见「接入自定义第三方平台」红框 |
| **`Reachable (HTTP 400)`** | 上游没实现 `GET /v1/models`，探针无法判定凭证有效性 → 橙色「待验证」。请用**对话接口**验证，不要据此判定账号坏 |
| **模型不在 `/v1/models` 里** | 已改善：上游列不出模型时会按「模型名 → 平台」推断规则从本地定价表补齐。但**未在定价表登记的新模型仍不会出现** —— 此时客户端手填模型名即可，转发链路本身正常 |
| **同平台多账号模型集不一致** | 会轮询到不提供该模型的账号，报 `model is not found`（时好时坏）。详见上文「两个账号平台名相同 = 会互相污染」红框。用 `/v1/models` 列表比对一下两个账号的模型集是否一致 |
| **模型名大小写** | 上游普遍**大小写敏感**，且不同上游要求可能相反。报 `invalid model: model name not found` 或 `not_found_error` 时先怀疑大小写。用分组「模型 → 平台 重定向」的 `{platform, model}` 写法统一改写 |
| **模型跑到了错误的上游** | 同家族模型分散在不同上游时，用「模型 → 平台 重定向」显式指定平台，避免被模型名推断送错 |
| **上游 `/v1/models` 列了但调用 404** | 上游自身模型清单与可调用模型可能不一致（直连也 404）。中转无能为力，换模型即可 |
| **KV 最终一致性** | 认证缓存等场景存在秒级延迟窗口 |
| **模型定价** | 目前是静态表，上游的 `model_pricing.json` 动态加载未移植 |
| **后台任务** | 上游的 token 刷新、outbox 调度等常驻任务在 Workers 无对应物，需改用 Cron Triggers |

### 未验证的风险点

- **计费扣减的并发正确性**：D1 `batch()` 理论上原子，但高频并发下的实际表现未做压测。
- **长流式响应**：Workers 有 CPU 时间限制，超长 SSE 流（如大模型长输出）是否会被中断未验证。
- **DO 粘性会话的冷启动延迟**：首次请求需唤醒 DO，可能增加首 token 延迟。
- **后台鉴权边界**：管理员账号与业务 `users` 表完全隔离，后台不做细粒度角色（只有一个管理员层级）；
  多人协作需自行扩展角色表。

---

## 该不该走这条路？

**建议**：除非你有强理由必须用 Workers（比如要利用其全球边缘网络、或完全不想运维服务器），
否则**用方案 A（VPS + Docker Compose）**成本低得多：

```bash
mkdir -p sub2api-deploy && cd sub2api-deploy
curl -sSL https://raw.githubusercontent.com/Wei-Shaw/sub2api/main/deploy/docker-deploy.sh | bash
docker compose up -d
```

上游自带完整的脚本/Docker 部署，5 分钟能跑起来，功能 100% 完整。
本移植版的合理定位是：**学习参考**，或作为「只想要网关转发 + 计费」的精简替代。
