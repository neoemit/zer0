export function loadConfig(env = process.env) {
  const captchaProvider = env.CAPTCHA_PROVIDER || (env.TURNSTILE_SECRET_KEY ? 'turnstile' : 'none');
  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 3000),
    redisUrl: env.REDIS_URL || 'redis://redis:6379/0',
    publicBaseUrl: trimTrailingSlash(env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`),
    trustProxy: env.TRUST_PROXY === 'true',
    codeLength: Number(env.CODE_LENGTH || 7),
    retentionDays: normalizeRetentionDays(env.RETENTION_DAYS),
    adminToken: env.ADMIN_TOKEN || '',
    adminOnlyMode: env.ADMIN_ONLY_MODE === 'true',
    redirectCacheControl: env.REDIRECT_CACHE_CONTROL || 'public, max-age=300',
    hotCache: {
      maxEntries: Number(env.HOT_CACHE_MAX_ENTRIES || 100000),
      ttlMs: Number(env.HOT_CACHE_TTL_MS || 300000),
    },
    rateLimit: {
      max: Number(env.CREATE_RATE_LIMIT_MAX || 20),
      timeWindow: env.CREATE_RATE_LIMIT_WINDOW || '1 minute',
    },
    captcha: {
      provider: captchaProvider,
      siteKey: env.TURNSTILE_SITE_KEY || '',
      secretKey: env.TURNSTILE_SECRET_KEY || '',
    },
  };
}

export function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function normalizeRetentionDays(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}
