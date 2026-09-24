/**
 * sub2api-mail-worker —— 安全邮件网关。
 *
 * 只做一件事: 收到"验证码邮件请求"后, 校验鉴权 + 参数白名单,
 * 用固定模板调 Resend 发信。request_id 作为幂等键, 杜绝重复邮件。
 *
 * 绝不做的:
 *   - 不接收任意 subject / html / body / 附件(否则退化成任意邮件代理)
 *   - 不在日志打验证码明文 / Resend 密钥
 */

interface Env {
  RESEND_API_KEY: string;
  SUB2API_WORKER_SECRET: string;
  MAIL_FROM_NAME?: string;
  MAIL_FROM_ADDR?: string;
  KV?: KVNamespace;
}

type Purpose = 'REGISTER' | 'PASSWORD_RESET' | 'EMAIL_BIND';

interface SendEmailRequest {
  request_id: string;
  to: string;
  code: string;
  purpose: Purpose;
  expire_minutes?: number;
}

const PURPOSE_WHITELIST: Purpose[] = ['REGISTER', 'PASSWORD_RESET', 'EMAIL_BIND'];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ success: false, message: 'Method Not Allowed' }, 405);
    }

    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${env.SUB2API_WORKER_SECRET}`) {
      return json({ success: false, message: 'Unauthorized' }, 401);
    }

    let body: SendEmailRequest;
    try {
      body = (await request.json()) as SendEmailRequest;
    } catch {
      return json({ success: false, message: 'Invalid JSON' }, 400);
    }

    const { request_id, to, code, purpose, expire_minutes = 5 } = body ?? {};
    if (!request_id || typeof request_id !== 'string' || request_id.length > 64) {
      return json({ success: false, message: 'Invalid request_id' }, 400);
    }
    if (!to || typeof to !== 'string' || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*$/.test(to) || to.length > 190) {
      return json({ success: false, message: 'Invalid to' }, 400);
    }
    if (!code || !/^\d{6}$/.test(code)) {
      return json({ success: false, message: 'Invalid code' }, 400);
    }
    if (!PURPOSE_WHITELIST.includes(purpose)) {
      return json({ success: false, message: 'Invalid purpose' }, 400);
    }
    const expireMin = Number(expire_minutes);
    if (!Number.isFinite(expireMin) || expireMin < 1 || expireMin > 10) {
      return json({ success: false, message: 'Invalid expire_minutes' }, 400);
    }

    const titleMap: Record<Purpose, string> = {
      REGISTER: '注册验证码',
      PASSWORD_RESET: '密码重置验证码',
      EMAIL_BIND: '邮箱绑定验证码',
    };
    const title = titleMap[purpose];
    const fromName = (env.MAIL_FROM_NAME || 'Sub2API').trim();
    const fromAddr = (env.MAIL_FROM_ADDR || 'noreply@example.com').trim();

    // 固定模板, 不允许任意 HTML
    const html = [
      '<div style="max-width:480px;margin:40px auto;padding:40px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;border:1px solid #eee;border-radius:12px;background:#fff">',
      '<h2 style="margin:0 0 8px;color:#0F172A">Sub2API ' + esc(title) + '</h2>',
      '<p style="color:#475569;margin:16px 0">您好，您的验证码是：</p>',
      '<div style="margin:24px 0;padding:18px;text-align:center;font-size:34px;font-weight:700;letter-spacing:8px;background:#F5F7FA;border-radius:10px;color:#0F172A">' + esc(code) + '</div>',
      '<p style="color:#64748B;font-size:14px;line-height:1.7">验证码有效期为 <strong>' + expireMin + ' 分钟</strong>，请勿将验证码告诉任何人。</p>',
      '<p style="color:#94A3B8;font-size:12px">如果这不是您的操作，请忽略此邮件。</p>',
      '</div>',
    ].join('\n');

    // 幂等键 + 动态 import Resend
    try {
      const { Resend } = await import('resend');
      const resend = new Resend(env.RESEND_API_KEY);
      const result = await resend.emails.send({
        from: fromName + ' <' + fromAddr + '>',
        to: [to],
        subject: 'Sub2API ' + title,
        html,
        ...(request_id ? { idempotencyKey: 'sub2api-' + request_id } : {}),
      });
      if (result.error) {
        console.error('send fail', request_id, JSON.stringify(result.error));
        return json({ success: false, request_id, message: 'Email send failed' }, 500);
      }
      console.log('sent', request_id, maskEmail(to));
      return json({ success: true, request_id, id: result.data?.id ?? null }, 200);
    } catch (e) {
      console.error('resend exception', request_id, String(e));
      return json({ success: false, request_id, message: 'Email send failed' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 脱敏邮箱: 只留 @ 前首字符 + 域名 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) return '***';
  return email[0] + '***' + email.slice(at);
}