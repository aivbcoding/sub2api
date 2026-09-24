# sub2api-mail-worker

Sub2API 的**安全邮件网关** —— 独立部署的 Cloudflare Worker，只负责发验证码邮件。

## 职责边界

| 谁 | 干什么 |
|---|---|
| Sub2API 主站 | 用户注册、验证码生成/校验、限流、Turnstile |
| **本 Worker** | 鉴权 + 参数白名单 + 固定模板 + 调 Resend 发信 |
| Resend | 邮件投递 |

本 Worker **不做**：注册、验证码生成/校验、用户数据库、任意发信（不接受 subject/html/from 参数）。

## 安全设计

- `Authorization: Bearer <SUB2API_WORKER_SECRET>` 鉴权，失败 401
- 参数白名单：`request_id`(≤64) / `to`(邮箱正则) / `code`(`^\d{6}$`) / `purpose`(REGISTER|PASSWORD_RESET|EMAIL_BIND) / `expire_minutes`(1~10)
- 固定三套模板，**不支持**任意 subject / html / from / 附件
- `request_id` 作为 Resend `Idempotency-Key`，重复请求不产生重复邮件
- 日志脱敏：邮箱只留 `a***@domain`，验证码/密钥绝不入日志

## 部署

```bash
cd sub2api/mail-worker
npm install
wrangler secret put SUB2API_WORKER_SECRET   # 与主站 MAIL_WORKER_SECRET 保持一致
wrangler secret put RESEND_API_KEY          # Resend 服务端密钥
wrangler deploy
```

部署后得到 `https://sub2api-mail-worker.<你的子域>.workers.dev`（生产建议绑定自定义域名 `mail-api.example.com`）。

## 调用

```http
POST https://<mail-worker>/send
Authorization: Bearer <SUB2API_WORKER_SECRET>
Content-Type: application/json

{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "to": "user@example.com",
  "code": "583921",
  "purpose": "REGISTER",
  "expire_minutes": 5
}
```

## 主站对接配置

Sub2API 主站需设置（`wrangler secret put`）：

```bash
MAIL_WORKER_URL=https://<mail-worker>/send
MAIL_WORKER_SECRET=<同一个 SUB2API_WORKER_SECRET>
VERIFY_CODE_PEPPER=<随机长字符串, 用于验证码 HMAC 哈希>
```

以及 Turnstile（Cloudflare 控制台创建 Widget）：

```bash
TURNSTILE_SITE_KEY=0x4AAAA...   # 公开, 前端注册页用
TURNSTILE_SECRET_KEY=0x4AAAA... # 绝不放前端
```

当 `MAIL_WORKER_URL + MAIL_WORKER_SECRET` 未配置且 `DEBUG_MAIL=1` 时，
主站进入**调试模式**：验证码不回显、邮件不真发，仅记录 —— 用于无发信环境联调注册链路。