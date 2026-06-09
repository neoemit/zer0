import { captchaCanBeSkipped } from './core.js';

export async function verifyCaptcha({ captcha, token, ip, fetchImpl = fetch }) {
  if (captchaCanBeSkipped(captcha)) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'CAPTCHA token is required' };

  if (captcha.provider !== 'turnstile') {
    return { ok: false, reason: `Unsupported CAPTCHA provider: ${captcha.provider}` };
  }

  const form = new URLSearchParams();
  form.set('secret', captcha.secretKey);
  form.set('response', token);
  if (ip) form.set('remoteip', ip);

  const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });

  if (!response.ok) return { ok: false, reason: 'CAPTCHA verification failed' };
  const result = await response.json();
  return result.success ? { ok: true } : { ok: false, reason: 'CAPTCHA verification failed' };
}
