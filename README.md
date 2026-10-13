# sub2api 项目导览（快速熟悉文档）

> 本文档帮助你**快速熟悉整个 sub2api 仓库**：各目录/文件干什么用、请求链路怎么走、改代码前必须知道什么。
> 详细部署与功能说明见 `worker/README.md`；运维经验见 `docs/`。

## 一句话定位

把开源项目 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)（Go + PostgreSQL + Redis 的 AI API 网关）
**移植到 Cloudflare Workers + D1** 的独立重写实现。核心链路：**客户端 → 本网关 → 上游 AI 账号/中转 → 官方 API**。

- 线上地址：<https://sub2api.aixm.ccwu.cc>（根目录即管理后台，未登录跳 `/login`）
- 许可证：LGPL-3.0（对齐上游；`upstream/` 仅为参考源码，不参与部署）

---

## 顶层目录结构

```
sub2api/
├── README.md        # 本文档：项目导览
├── LICENSE          # LGPL-3.0
├── worker/          # ★ 主项目：Cloudflare Workers 网关 + 管理后台（全部核心代码）
├── mail-worker/     # 独立邮件网关 Worker（只负责发验证码邮件，走 Resend）
├── docs/            # 运维知识库（踩坑记录/排查手册/资源快照）
└── upstream/        # 上游原版项目源码（Go+Vue），只读参考，不编译不部署
```

| 目录 | 一句话说明 |
|---|---|
| `worker/` | **你看的 90% 的代码都在这**：网关转发、计费、调度、管理后台前端+API 全在一个 Worker 里 |
| `mail-worker/` | 安全邮件发信网关：Bearer 鉴权 + 参数白名单 + 固定模板 + Resend 幂等发信 |
| `docs/` | 生产运维经验沉淀：路由机制、故障排查、修复记录、资源快照、环境备忘 |
| `upstream/` | 原版 Go 项目（400+ 路由、Ent ORM、Redis），移植时的行为参考，**改本项目不用动它** |

---

## worker/ —— 主项目详解

### 技术形态

- **运行时**：Cloudflare Workers（无服务器、边缘执行），TypeScript，`wrangler` 开发部署
- **无构建**：`src/admin-ui.ts` 内嵌整个后台前端（单文件 HTML + 裸 JS，不经过 webpack/vite 编译）
- **数据**：D1（SQLite，替代 PostgreSQL）+ KV（缓存）+ Durable Object（原子计数）
- **资源绑定**（`wrangler.toml`）：

| 绑定 | 作用 |
|---|---|
| `DB`（D1） | 全部业务表：用户/Key/账号/分组/日志/计费/定价 |
| `KV` | 认证缓存、调度快照等容忍最终一致的场景 |
| `ACCOUNT_COORDINATOR`（DO） | 粘性会话、并发槽位、RPM 计数（替代 Redis 原子操作） |

### src/ 源码逐文件说明

| 文件 | 职责 |
|---|---|
| `index.ts` | **入口**：全部路由分发 + CORS + 鉴权编排。改路由/加接口都在这 |
| `auth.ts` | API Key 鉴权（走 `v_api_key_auth` 视图，过滤软删除）+ IP 黑白名单（含 CIDR） |
| `protocol.ts` | 平台常量、上游 URL 推导、认证头注入（Bearer / x-api-key / gemini 等） |
| `scheduler.ts` | 账号调度：粘性会话 → 加权打分 → 抢并发槽位 |
| `durable-object.ts` | `AccountCoordinator` DO：槽位/粘性/RPM 的串行原子操作 |
| `gateway.ts` | **转发核心**：选号后把请求转给上游、处理重定向/错误 |
| `stream.ts` | SSE 流式逐行解析 + usage 提取（流式透传的关键） |
| `translate.ts` | 协议转换：anthropic / openai / gemini 的 SSE 互转（含 tool_calls 翻译） |
| `billing.ts` | 计费公式 + 计费窗口翻转；价格只来自 `model_pricing` 表和 `settings.model_pricing_default` |
| `billing-repo.ts` | D1 `batch()` 原子扣费（幂等键 `request_id + api_key_id`） |
| `models.ts` | `GET /v1/models`：多上游模型聚合 + 白名单过滤 |
| `verify-code.ts` | 邮箱验证码模块：生成/校验/HMAC 哈希/限流/Turnstile 服务端校验/调 mail-worker（**当前已停用**，见下文） |
| `admin-auth.ts` | 后台鉴权：PBKDF2 密码 + HMAC JWT + 统一登录（users 表 + roles.menus） |
| `admin-api.ts` | 后台 REST API（用户/Key/账号/分组/定价/公告/审计…），约 3600+ 行 |
| `admin-ui.ts` | **整个管理后台前端**（内嵌 HTML+CSS+JS 巨型模板字面量，约 19 万字符） |
| `time.ts` | D1/SQLite 时间戳解析（强制 UTC）；展示统一北京时间 `Asia/Shanghai` |
| `types.ts` | 共享类型定义（Env 绑定、表结构 Row 等） |

### schema/ —— D1 建表与迁移（按顺序执行过）

| 文件 | 内容 |
|---|---|
| `schema.sql` | 核心业务表 + `v_api_key_auth` 鉴权视图（**第一份**，必执行） |
| `seed.sql` | 本地测试数据（占位凭证，勿用于生产） |
| `schema-admin.sql` | 管理后台：管理员/角色/审计日志 |
| `schema-view-auth.sql` | 加列后**重建鉴权视图**（改表后必须重跑） |
| `schema-custom-platform.sql` | 账号 `protocol` 列 + 内置平台协议回填 |
| `schema-platform-routing.sql` | 分组模型路由表（`model_platform_routing`） |
| `schema-model-index.sql` | 账号 `model_index` 自动发现索引 |
| `schema-entry-path.sql` | 账号入口路径（`/<entry>/v1/...` 钉死账号的路由） |
| `schema-roles.sql` | RBAC 角色表（**必须先建再部署**） |
| `schema-user-platform-access.sql` | 用户平台访问控制 |
| `schema-user-checkins.sql` | 签到表（`toMicro`：1 USD = 1e8 微美元） |
| `schema-announcements.sql` | 公告 |
| `schema-email-verify.sql` | 邮箱验证码两张表（codes 状态机 + 发送限流日志） |
| `schema-model-pricing-account.sql` | 账号级定价关联 |
| `rollback-group1-allowlist.sql` | 回滚：分组白名单停用（只影响 /v1/models 展示） |

### tools/ —— 开发/诊断工具（node 脚本）

| 脚本 | 用途 |
|---|---|
| `run-e2e.mjs` | **本地 e2e 标准跑法**：起 dev 服务 + 跑指定测试（`npm run e2e`） |
| `d1-query.mjs` | 查 D1（`npm run db:query`，本地加 `D1LOCAL=1`），结果落 `$TEMP/d1q.txt` |
| `check-admin-ui.mjs` | 校验 admin-ui 内联 JS 是合法 JS（改后台前端后必跑） |
| `test-nav-guard.mjs` / `test-roles-guard.mjs` / `test-models-group-scope.mjs` / `test-billing-pricing.mjs` | 四套守卫断言（菜单一致性 / 权限 / 模型口径 / 计费），对应 `check:nav/roles/models/billing` |
| `check-skill-refs.mjs` | 引用完整性：删文件前查残留引用（`check:refs`） |
| `diag-model-routing.mjs` | 诊断「模型到底路由到哪个账号/平台」 |
| `mock-upstream.mjs` | 本地 mock 上游（验证协议转换、跑 translate 测试用） |
| `gen-admin-secret.mjs` | 生成 JWT 密钥 + 管理员密码哈希 |
| `verify-online.mjs` / `verify-*-online.mjs` / `live-check.mjs` / `live-models.mjs` / `upstream-probe.mjs` | 线上验收工具（注意 `NO_PROXY='*'`） |
| `migrate-admin-accounts.mjs` / `migrate-announcements.mjs` / `backfill-user-passwords.mjs` | 一次性数据迁移 |
| `seed-model-index.mjs` / `reset-local.sql` / `pin-*.sql` / `set-*.sql` | 数据修正/重置辅助 |
| `make-ui-preview.mjs` | 从 admin-ui 提取页面做预览（如 `register-preview.html`） |

### test/ —— 端到端测试

`e2e.mjs`（网关核心链路）、`translate-e2e.mjs`（协议转换 29 项）、`console-e2e.mjs`（后台）及按功能拆分的
`admin-*-e2e.mjs`（usage/groups/alias/audit/announce/pricing…）。本地跑：`node tools/run-e2e.mjs 8787 test/<xxx>-e2e.mjs`，
本地管理员密码 `ADMIN_PASS=localtest123`。

### 常用命令（package.json scripts）

```bash
npm run dev            # 本地开发（wrangler dev）
npm run check          # 全套校验 = typecheck + ui + nav + roles + models + billing + refs（改完必跑）
npm run test:all       # 10 项离线测试全跑
node tools/run-e2e.mjs 8787 test/e2e.mjs   # 本地 e2e
npm run deploy         # 部署（predeploy 自动跑 check）
npm run db:query       # 查 D1
```

### 关键架构不变式（改代码前必读）

1. **路由优先级**：`入口路径(硬锁账号) > groups.model_platform_routing > groups.platform > users.platform_access > model_index ∪ 别名 > 路径特征 > openai 兜底`
2. 填了 `base_url` 就永远走 `base_url`；被问到时给探针证据，别改代码
3. 模型 ID 冲突用**账号级别名** `accounts.extra.model_aliases`（规范 `平台名-模型ID`），不堆全局规则
4. 「到底走了哪条账号」只认 `usage_logs.account_id`，不认 HTTP 200
5. 计费价格只有两处来源：`model_pricing` 表 → `settings.model_pricing_default`（无内置兜底表）
6. `admin-ui.ts` 的前端脚本在 TS 模板字面量里 = **裸 JS 不编译**：禁 as 断言/类型标注；模板内不能出现反引号；正则反斜杠写双反斜杠
7. 后台菜单改动有**六处同步铁律**：`data-page`/`PAGE_TITLES`/`MENU_CATALOG`/`MENUS_BY_RESOURCE`/`CONSOLE_PAGES`/`ENTRY_SEGMENT_BLOCKLIST` + CSS 图标
8. 时间：展示用 `Asia/Shanghai`，SQL 日志表达式带 `+8 hours` —— 改一处必改两处

> 完整踩坑手册见 `docs/` 与用户技能 `sub2api-worker-relay-triage`。

---

## mail-worker/ —— 邮件网关（独立工程）

只干一件事：**被主站调用 → 调 Resend 发验证码邮件**。

```
mail-worker/
├── src/index.ts     # 全部逻辑：Bearer 鉴权 → 参数白名单 → 固定模板 → Resend（request_id 幂等）
├── wrangler.toml    # name/main/compatibility + MAIL_FROM_ADDR（当前 noreply@ijd.ccwu.cc）
├── package.json     # 仅 devDependencies（wrangler/tsc），无运行时依赖
└── README.md        # 部署与调用说明
```

- 鉴权：`Authorization: Bearer SUB2API_WORKER_SECRET`（与主站 `MAIL_WORKER_SECRET` 同值）
- 白名单参数：`request_id / to / code(6位数字) / purpose / expire_minutes`；**不接受**任意 subject/html/from
- 线上：`https://sub2api-mail-worker.1003759845.workers.dev`
- 部署：`cd mail-worker && npx wrangler secret put SUB2API_WORKER_SECRET / RESEND_API_KEY && npx wrangler deploy`

### 邮箱验证码功能当前状态：**已停用（2026-09-23）**

- 原因：Resend 发件域名 `ijd.ccwu.cc` 的 DNS 记录（托管在 HE.net，**不是 Cloudflare**）一直未配置，无法验证
- 停用方式：删除线上 `TURNSTILE_SECRET_KEY` secret + 重新部署 → 后端 `verification_required:false`，注册页自动隐藏验证码区、走旧注册流程
- 恢复方式：`wrangler secret put TURNSTILE_SECRET_KEY` → `wrangler deploy`，代码零改动
- 代码全部保留（`verify-code.ts` + schema + 双 Turnstile 前端），随时可启用

---

## docs/ —— 运维知识库

| 文件 | 内容 |
|---|---|
| `README.md` | 知识库索引 |
| `routing.md` | 模型路由机制：平台判定优先级、重定向表、别名、大小写坑 |
| `troubleshooting.md` | 故障排查手册：三种"没号"错误码、诊断工具、案例实录 |
| `code-fixes.md` | 代码优化与修复记录（按部署批次） |
| `inventory.md` | 生产资源快照：上游账号、分组、Key、路由现状（改动需同步更新） |
| `ops-environment.md` | 运维环境备忘：Node 版本、wrangler 用法、安全红线 |

---

## upstream/ —— 原版参考（不用动）

上游 Wei-Shaw/sub2api 的完整源码（Go 1.27 + Gin + Ent + PostgreSQL 15 + Redis 7 + Vue3 前端）。
本项目**对照它做行为兼容**（如认证头构造、错误体格式、调度打分逻辑），但它本身不编译、不部署、
不进 git 日常改动。Docker/源码构建等部署方式与本项目无关。

---

## 新人上手路线（建议顺序）

1. 读本文档 + `worker/README.md`（架构映射、三个关键移植决策）
2. `cd worker && npm install && npm run dev` 本地起服务
3. 打开 `http://localhost:8787/` 看管理后台（`admin-ui.ts`），对照 `admin-api.ts` 看接口
4. 读 `docs/routing.md` 理解模型路由，跑 `node tools/diag-model-routing.mjs` 体会
5. 改任何代码前：跑一遍 `npm run check` 确认基线全绿；改完必须再跑全绿才可交部署

## 开发红线（项目铁律）

- 🚨 **部署必须用户明示**：改完代码停在本地，绝不顺手 `wrangler deploy`
- 🚨 删 `tools/*.mjs` 前先跑 `check:refs`（残留引用会拦住 predeploy）
- 🚨 改后台前端后：`check:ui` 必跑（裸 JS 语法错误只在浏览器炸整段 script）
- 🚨 schema 迁移注意：`--local` 与写死 `--remote` 的脚本不能混用；roles 表必须先建再部署
- 🚨 线上 D1 查询用 `npm run db:query`，别手敲 wrangler 命令绕过工具

---

*快照时间：2026-10-13。配置/功能有变化时请同步更新本文档与 `docs/inventory.md`。*
