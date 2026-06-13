import Fastify from 'fastify';
import formBody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';

import { HotCache } from './cache.js';
import { captchaCanBeSkipped, makeCode, normalizeTargetUrl, validateCustomSlug } from './core.js';
import { verifyCaptcha } from './captcha.js';
import { geolocateIp as defaultGeolocateIp } from './geoip.js';

const SECONDS_PER_DAY = 24 * 60 * 60;
const IMPORT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const EXPORT_SCHEMA_VERSION = 1;

export async function buildApp(opts) {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 16 * 1024,
  });

  const cache = opts.cache ?? new HotCache(opts.hotCache);
  const publicBaseUrl = String(opts.publicBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  const codeLength = opts.codeLength || 7;
  const retentionDays = normalizeValidityDays(opts.retentionDays);
  const redirectCacheControl = opts.redirectCacheControl || 'public, max-age=300';
  const captcha = opts.captcha || { provider: 'none' };
  const adminToken = opts.adminToken || '';
  const adminOnlyMode = opts.adminOnlyMode === true;
  const geolocateIp = opts.geolocateIp || defaultGeolocateIp;
  const store = opts.store;
  if (!store) throw new Error('store is required');

  await app.register(formBody);
  await app.register(rateLimit, {
    global: false,
    max: opts.rateLimit?.max ?? 20,
    timeWindow: opts.rateLimit?.timeWindow ?? '1 minute',
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/favicon.svg', async (_request, reply) => {
    return reply.type('image/svg+xml; charset=utf-8').send(renderFavicon());
  });

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderHome({ siteKey: captcha.siteKey || '', captchaEnabled: !captchaCanBeSkipped(captcha), retentionDays, adminOnlyMode });
  });

  app.get('/admin', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderAdmin();
  });

  app.post('/api/shorten', { config: { rateLimit: opts.rateLimit ?? { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (adminOnlyMode && !authorizeAdmin(request, reply, adminToken, { disabledMessage: 'Admin-only mode requires ADMIN_TOKEN to be configured' })) return reply;

    const body = request.body || {};
    const captchaToken = body.captchaToken || body['cf-turnstile-response'];
    const captchaResult = await verifyCaptcha({ captcha, token: captchaToken, ip: request.ip });
    if (!captchaResult.ok) {
      return reply.code(403).send({ error: captchaResult.reason || 'CAPTCHA verification failed' });
    }

    let targetUrl;
    let requestedSlug;
    let validityDays;
    try {
      targetUrl = normalizeTargetUrl(body.url);
      requestedSlug = body.slug ? validateCustomSlug(body.slug) : '';
      validityDays = normalizeValidityDays(body.validityDays ?? retentionDays);
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }

    const setOptions = { ttlSeconds: validityDaysToSeconds(validityDays), validityDays };
    const code = requestedSlug || (await allocateCode(store, targetUrl, codeLength, setOptions));
    if (requestedSlug) {
      const created = await store.set(code, targetUrl, setOptions);
      if (!created) return reply.code(409).send({ error: 'Slug already exists' });
    }
    cache.set(code, targetUrl);

    return reply.code(201).send({ code, shortUrl: `${publicBaseUrl}/${code}`, targetUrl, expiresInDays: validityDays > 0 ? validityDays : null });
  });

  app.get('/api/stats/:code', async (request, reply) => {
    if (!authorizeAdmin(request, reply, adminToken)) return reply;
    let code;
    try {
      code = validateCustomSlug(request.params.code);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }

    const targetUrl = await store.get(code);
    if (!targetUrl) return reply.code(404).send({ error: 'Not found' });
    return store.getStats(code);
  });

  app.get('/api/admin/links', async (request, reply) => {
    if (!authorizeAdmin(request, reply, adminToken)) return reply;
    const links = await store.listLinks();
    return {
      links: links.map((link) => serializeAdminLink(link, publicBaseUrl)),
    };
  });

  app.get('/api/admin/export', async (request, reply) => {
    if (!authorizeAdmin(request, reply, adminToken)) return reply;
    const links = typeof store.exportLinks === 'function' ? await store.exportLinks() : await store.listLinks();
    return reply
      .header('content-disposition', `attachment; filename="zer0-export-${new Date().toISOString().slice(0, 10)}.json"`)
      .send({
        schemaVersion: EXPORT_SCHEMA_VERSION,
        app: 'zer0',
        exportedAt: new Date().toISOString(),
        links: links.map(serializeExportLink),
      });
  });

  app.post('/api/admin/import', { bodyLimit: opts.importBodyLimit ?? IMPORT_BODY_LIMIT_BYTES }, async (request, reply) => {
    if (!authorizeAdmin(request, reply, adminToken)) return reply;
    const prepared = await prepareImportPayload(request.body || {}, { store, codeLength });
    if (prepared.records.length === 0 && prepared.rows.length === 0) {
      return reply.code(400).send({ error: 'No import records found' });
    }

    const imported = await store.importLinks(prepared.records);
    const result = summarizeImportRows([...prepared.rows, ...imported.rows]);
    if (result.imported > 0) cache.clear();
    return result;
  });

  app.patch('/api/admin/links/:code', async (request, reply) => {
    if (!authorizeAdmin(request, reply, adminToken)) return reply;
    let code;
    try {
      code = validateCustomSlug(request.params.code);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }

    const validityDays = normalizeValidityDays((request.body || {}).validityDays);
    const updated = await store.updateValidity(code, validityDays);
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    cache.delete(code);
    return serializeAdminLink(updated, publicBaseUrl);
  });

  app.delete('/api/admin/links/:code', async (request, reply) => {
    if (!authorizeAdmin(request, reply, adminToken)) return reply;
    let code;
    try {
      code = validateCustomSlug(request.params.code);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }

    const existed = await store.delete(code);
    cache.delete(code);
    return { deleted: existed ? 1 : 0 };
  });

  app.delete('/api/admin/links', async (request, reply) => {
    if (!authorizeAdmin(request, reply, adminToken)) return reply;
    const deleted = await store.deleteAll();
    cache.clear();
    return { deleted };
  });

  app.get('/:code', async (request, reply) => {
    let code;
    try {
      code = validateCustomSlug(request.params.code);
    } catch {
      return sendInvalidLinkPage(reply);
    }

    let targetUrl = cache.get(code);
    if (!targetUrl) {
      targetUrl = await store.get(code);
      if (targetUrl) cache.set(code, targetUrl);
    }

    if (!targetUrl) return sendInvalidLinkPage(reply);
    await store.recordAccess(code, { country: geolocateIp(request.ip), ip: request.ip });
    return reply.header('Cache-Control', redirectCacheControl).redirect(targetUrl, 302);
  });

  return app;
}

function sendInvalidLinkPage(reply) {
  return reply.code(404).type('text/html; charset=utf-8').send(renderInvalidLinkPage());
}

function authorizeAdmin(request, reply, adminToken, options = {}) {
  const disabledMessage = options.disabledMessage || 'Admin API is disabled until ADMIN_TOKEN is configured';
  if (!adminToken) {
    reply.code(503).send({ error: disabledMessage });
    return false;
  }

  const authorization = request.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  const token = request.headers['x-admin-token'] || bearer;
  if (token !== adminToken) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }

  return true;
}

function normalizeValidityDays(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function validityDaysToSeconds(validityDays) {
  return validityDays > 0 ? validityDays * SECONDS_PER_DAY : 0;
}

function serializeAdminLink({ code, targetUrl, createdAt, validityDays, expiresAt, expiresInDays, stats }, publicBaseUrl) {
  return {
    code,
    shortUrl: `${publicBaseUrl}/${code}`,
    targetUrl,
    ...(createdAt ? { createdAt } : {}),
    validityDays: normalizeValidityDays(validityDays),
    expiresAt: expiresAt || null,
    expiresInDays: expiresInDays ?? null,
    totalClicks: stats?.totalClicks ?? 0,
    countries: stats?.countries ?? {},
  };
}

function serializeExportLink({ code, targetUrl, createdAt, validityDays, expiresAt, expiresInDays, stats }) {
  return {
    code,
    targetUrl,
    ...(createdAt ? { createdAt } : {}),
    validityDays: normalizeValidityDays(validityDays),
    expiresAt: expiresAt || null,
    expiresInDays: expiresInDays ?? null,
    stats: {
      totalClicks: stats?.totalClicks ?? 0,
      countries: stats?.countries ?? {},
    },
  };
}

async function allocateCode(store, targetUrl, codeLength, setOptions) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = makeCode(codeLength);
    if (await store.set(code, targetUrl, setOptions)) return code;
  }
  throw new Error('Could not allocate a unique short code');
}

async function prepareImportPayload(body, { store, codeLength }) {
  const rawRecords = extractImportRecords(body);
  const records = [];
  const rows = [];
  const generatedCodes = new Set();

  for (const [index, rawRecord] of rawRecords.entries()) {
    const row = index + 1;
    try {
      records.push(await normalizeImportRecord(rawRecord, { row, store, codeLength, generatedCodes }));
    } catch (error) {
      rows.push({ row, status: 'error', reason: error.message });
    }
  }

  return { records, rows };
}

function extractImportRecords(body) {
  const mode = String(body.mode || body.format || '').trim().toLowerCase();
  if (mode === 'zer0') {
    return arrayOrEmpty((body.export || body.data || body).links);
  }
  if (mode === 'custom') {
    return arrayOrEmpty(body.records);
  }

  if (Array.isArray(body.records)) return body.records;
  if (Array.isArray(body.links)) return body.links;
  if (body.export && Array.isArray(body.export.links)) return body.export.links;
  return [];
}

async function normalizeImportRecord(record, { row, store, codeLength, generatedCodes }) {
  const targetUrl = normalizeTargetUrl(record.targetUrl ?? record.url ?? record.longUrl ?? record.destinationUrl);
  const explicitCode = record.code ?? record.slug;
  const code = explicitCode
    ? validateCustomSlug(explicitCode)
    : await generateImportCode(store, codeLength, generatedCodes);
  const createdAt = normalizeImportDate(record.createdAt, 'createdAt') || new Date().toISOString();
  const expiresAt = normalizeImportDate(record.expiresAt, 'expiresAt') || null;
  return {
    row,
    code,
    targetUrl,
    createdAt,
    validityDays: normalizeValidityDays(record.validityDays),
    expiresAt,
    stats: normalizeImportStats(record),
  };
}

async function generateImportCode(store, codeLength, generatedCodes) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const code = makeCode(codeLength);
    if (generatedCodes.has(code)) continue;
    if (await store.get(code)) continue;
    generatedCodes.add(code);
    return code;
  }
  throw new Error('Could not allocate a unique short code');
}

function normalizeImportDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) throw new Error(`${fieldName} is invalid`);
  return date.toISOString();
}

function normalizeImportStats(record) {
  const stats = record.stats && typeof record.stats === 'object' ? record.stats : {};
  const countries = normalizeCountryStats(record.countriesJson ?? record.countries ?? stats.countries);
  const explicitTotal = record.totalClicks ?? stats.totalClicks ?? stats.total;
  const inferredTotal = Object.values(countries).reduce((sum, count) => sum + count, 0);
  return {
    totalClicks: explicitTotal === undefined || explicitTotal === null || explicitTotal === ''
      ? inferredTotal
      : Math.max(0, Math.floor(Number(explicitTotal) || 0)),
    countries,
  };
}

function normalizeCountryStats(value) {
  if (value === undefined || value === null || value === '') return {};
  let source = value;
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value);
    } catch {
      throw new Error('countriesJson must be valid JSON');
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('countries must be a JSON object');
  }

  const countries = {};
  for (const [country, count] of Object.entries(source)) {
    const code = String(country || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) throw new Error(`Country code ${country} is invalid`);
    const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
    if (normalizedCount > 0) countries[code] = (countries[code] || 0) + normalizedCount;
  }
  return countries;
}

function summarizeImportRows(rows) {
  const sortedRows = [...rows].sort((left, right) => Number(left.row) - Number(right.row));
  return {
    imported: sortedRows.filter((row) => row.status === 'imported').length,
    skipped: sortedRows.filter((row) => row.status === 'skipped').length,
    expired: sortedRows.filter((row) => row.status === 'expired').length,
    failed: sortedRows.filter((row) => row.status === 'error').length,
    rows: sortedRows,
  };
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function renderHome({ siteKey, captchaEnabled, retentionDays, adminOnlyMode }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>zer0 URL shortener</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  ${captchaEnabled ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #1b1b2f 0, #07070a 46%); color: #f5f5f7; }
    .page-shell { width: min(92vw, 720px); min-height: 100vh; margin: 0 auto; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 1.25rem; align-items: center; padding: clamp(1rem, 3vw, 2rem) 0; }
    main { width: min(92vw, 720px); padding: 2rem; border: 1px solid #24242d; border-radius: 28px; background: linear-gradient(180deg, #13131c 0%, #0f0f15 100%); box-shadow: 0 24px 80px #0008; }
    h1 { margin: 0; letter-spacing: -0.06em; font-size: clamp(3rem, 9vw, 5.5rem); line-height: .9; }
    label { display: block; margin: 1rem 0 .4rem; color: #c7c7d8; font-weight: 700; }
    input, button { box-sizing: border-box; border-radius: 14px; border: 1px solid #30303b; padding: 1rem; font: inherit; }
    input { width: 100%; background: #09090d; color: #fff; outline: none; }
    input:focus { border-color: #8bd3ff; box-shadow: 0 0 0 4px #8bd3ff22; }
    button { background: #fff; color: #050507; font-weight: 800; cursor: pointer; transition: transform .14s ease, opacity .14s ease; }
    button:hover { transform: translateY(-1px); }
    button:active { transform: translateY(0); opacity: .86; }
    .muted { color: #aaaabc; }
    .subtitle { margin: .7rem 0 0; font-size: 1.08rem; }
    .retention-note { margin: 1rem 0 1.35rem; padding: .85rem 1rem; border: 1px solid #30303b; border-radius: 16px; background: #09090d; color: #d7d7e4; }
    .admin-gate { margin: 1.25rem 0; padding: 1rem; border: 1px solid #344258; border-radius: 18px; background: linear-gradient(135deg, #101925 0%, #111118 70%); }
    .admin-gate h2 { margin: 0 0 .4rem; font-size: 1.05rem; }
    .admin-gate p { margin: .35rem 0 0; }
    .admin-token-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .65rem; align-items: end; margin-top: .85rem; }
    .creator-panel[hidden], .admin-gate[hidden] { display: none !important; }
    .auth-status { min-height: 1.35rem; margin-top: .7rem; }
    .success { color: #9ee6b8; }
    .field-with-action { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .65rem; align-items: center; }
    .secondary-button { white-space: nowrap; background: #20202b; color: #f4f4ff; border-color: #363648; }
    .captcha-wrap { margin-top: 1.25rem; }
    .submit-button { width: 100%; margin-top: 1rem; }
    .result-card { display: none; margin-top: 1.25rem; padding: 1rem; border: 1px solid #2f3e52; border-radius: 18px; background: linear-gradient(135deg, #101925 0%, #111118 60%); box-shadow: inset 0 1px 0 #ffffff10; }
    .result-card[data-visible="true"] { display: block; }
    .result-label { margin: 0 0 .65rem; color: #9ee6b8; font-size: .9rem; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    .result-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .65rem; align-items: center; }
    .short-url { display: block; overflow-wrap: anywhere; color: #8bd3ff; font-weight: 800; text-decoration: none; }
    .copy-short-url { background: #8bd3ff; color: #061019; border-color: #8bd3ff; padding-inline: 1.1rem; }
    .result-meta { margin: .75rem 0 0; color: #aaaabc; font-size: .92rem; }
    .error { margin-top: 1rem; color: #ffb4b4; }
    a { color: #8bd3ff; }
    .site-footer { align-self: end; width: 100%; padding: 1rem 1.15rem; border: 1px solid #24242d; border-radius: 22px; background: linear-gradient(135deg, #101925cc 0%, #111118cc 70%); box-shadow: 0 18px 60px #0006, inset 0 1px 0 #ffffff0d; backdrop-filter: blur(14px); text-align: center; }
    .site-footer p { margin: 0; color: #d7d7e4; line-height: 1.55; }
    .footer-love { font-weight: 800; color: #f5f5f7; }
    .heart { display: inline-block; filter: drop-shadow(0 0 10px #ff6b8a88); transform-origin: center; animation: heartbeat 1.8s ease-in-out infinite; }
    .source-note { margin-top: .45rem; color: #aaaabc; font-size: .94rem; }
    .source-note a { font-weight: 900; text-decoration-thickness: .12em; text-underline-offset: .18em; }
    @media (prefers-reduced-motion: reduce) { .heart { animation: none; } }
    @keyframes heartbeat { 0%, 45%, 100% { transform: scale(1); } 15% { transform: scale(1.16); } 30% { transform: scale(.96); } }
    @media (max-width: 640px) { .page-shell { width: min(92vw, 720px); } main { padding: 1.35rem; } .field-with-action, .result-row, .admin-token-row { grid-template-columns: 1fr; } .secondary-button, .copy-short-url, .admin-token-row button { width: 100%; } }
  </style>
</head>
<body>
  <div class="page-shell">
    <main>
      <h1>zer0</h1>
      <p class="muted subtitle">Fast, self-hosted URL shortener.</p>
      <p class="retention-note">${retentionDays > 0 ? `Default link validity is ${retentionDays} days. Change it below or enter 0 for an indefinite link.` : 'Default link validity is indefinite. Enter a positive number below to expire a link automatically.'}</p>
      ${adminOnlyMode ? `<section id="creation-auth" class="admin-gate" aria-labelledby="creation-auth-title">
        <h2 id="creation-auth-title">Admin-only mode</h2>
        <p class="muted">Only visitors with the admin token can create short URLs on this zer0 instance. Redirects stay public.</p>
        <form id="admin-token-form">
          <label for="admin-token">Admin token</label>
          <div class="admin-token-row">
            <input id="admin-token" name="adminToken" type="password" autocomplete="current-password" required placeholder="Paste ADMIN_TOKEN" aria-describedby="admin-token-help">
            <button type="submit">Unlock creator</button>
          </div>
          <p id="admin-token-help" class="muted">The token is stored only in this browser's local storage and sent as an X-Admin-Token header when creating links.</p>
        </form>
        <p id="auth-status" class="auth-status muted" aria-live="polite"></p>
      </section>` : ''}
      <section id="creator-panel" class="creator-panel"${adminOnlyMode ? ' hidden' : ''}>
        <form id="form">
          <label for="url">Long URL</label>
          <input id="url" name="url" type="url" required placeholder="https://example.com/really/long/url" autocomplete="url">
          <label for="slug">Custom slug, optional</label>
          <div class="field-with-action">
            <input id="slug" name="slug" pattern="[A-Za-z0-9_-]{3,48}" minlength="3" maxlength="48" placeholder="cosmic-otter-42" autocomplete="off" aria-describedby="slug-help">
            <button type="button" id="generate-slug" class="secondary-button" aria-label="Generate a random custom slug">Generate</button>
          </div>
          <p id="slug-help" class="muted">Use 3–48 letters, numbers, underscores, or dashes. Or generate a friendly random one.</p>
          <label for="validity-days">Validity in days</label>
          <input id="validity-days" name="validityDays" type="number" min="0" step="1" inputmode="numeric" value="${retentionDays}" aria-describedby="validity-help">
          <p id="validity-help" class="muted">Use 0 to keep this link valid indefinitely.</p>
          <div class="captcha-wrap">
            ${captchaEnabled ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}"></div>` : '<p class="muted">CAPTCHA is disabled until TURNSTILE_SECRET_KEY is configured.</p>'}
          </div>
          <button type="submit" class="submit-button">Shorten</button>
        </form>
        <section id="result" class="result-card" aria-live="polite"></section>
      </section>
    </main>
    <footer class="site-footer" aria-label="About zer0">
      <p class="footer-love">Made with <span class="heart" aria-label="love">❤️</span> in Cape Town</p>
      <p class="source-note">Self-host your own zer0: the source code is on <a href="https://github.com/neoemit/zer0" target="_blank" rel="noopener noreferrer">GitHub</a>.</p>
    </footer>
  </div>
  <script>
    const form = document.querySelector('#form');
    const result = document.querySelector('#result');
    const slug = document.querySelector('#slug');
    const generateSlug = document.querySelector('#generate-slug');
    const adminOnlyMode = ${adminOnlyMode ? 'true' : 'false'};
    const createTokenStorageKey = 'zer0:createAdminToken';
    const creationAuth = document.querySelector('#creation-auth');
    const adminTokenForm = document.querySelector('#admin-token-form');
    const adminToken = document.querySelector('#admin-token');
    const authStatus = document.querySelector('#auth-status');
    const creatorPanel = document.querySelector('#creator-panel');
    const adjectives = ['atomic', 'brisk', 'cosmic', 'crisp', 'electric', 'ember', 'frosty', 'golden', 'lunar', 'neon', 'nova', 'pixel', 'quantum', 'rapid', 'solar', 'tidy', 'turbo', 'velvet'];
    const nouns = ['badger', 'beacon', 'comet', 'falcon', 'fox', 'koala', 'otter', 'panda', 'pulse', 'rocket', 'spark', 'tiger', 'wave', 'wizard', 'yak', 'zephyr'];

    function pick(items) {
      const values = new Uint32Array(1);
      crypto.getRandomValues(values);
      return items[values[0] % items.length];
    }

    function randomNumber() {
      const values = new Uint32Array(1);
      crypto.getRandomValues(values);
      return String(values[0] % 1000).padStart(3, '0');
    }

    function friendlySlug() {
      return [pick(adjectives), pick(nouns), randomNumber()].join('-');
    }

    async function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }

    function currentCreateToken() {
      if (!adminOnlyMode) return '';
      return localStorage.getItem(createTokenStorageKey) || '';
    }

    function unlockCreator(tokenValue) {
      if (!adminOnlyMode || !tokenValue) return;
      if (creatorPanel) creatorPanel.hidden = false;
      if (creationAuth) creationAuth.hidden = true;
      if (authStatus) {
        authStatus.textContent = 'Creator unlocked for this browser.';
        authStatus.className = 'auth-status success';
      }
    }

    function lockCreator(message) {
      if (!adminOnlyMode) return;
      localStorage.removeItem(createTokenStorageKey);
      if (creatorPanel) creatorPanel.hidden = true;
      if (creationAuth) creationAuth.hidden = false;
      if (adminToken) adminToken.value = '';
      if (authStatus && message) {
        authStatus.textContent = message;
        authStatus.className = 'auth-status error';
      }
    }

    if (adminOnlyMode) {
      const storedToken = currentCreateToken();
      if (storedToken) {
        if (adminToken) adminToken.value = storedToken;
        unlockCreator(storedToken);
      }
      adminTokenForm?.addEventListener('submit', (event) => {
        event.preventDefault();
        const tokenValue = adminToken.value.trim();
        if (!tokenValue) {
          lockCreator('Enter the admin token to unlock URL creation.');
          return;
        }
        localStorage.setItem(createTokenStorageKey, tokenValue);
        unlockCreator(tokenValue);
      });
    }

    generateSlug.addEventListener('click', () => {
      slug.value = friendlySlug();
      slug.focus();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      result.dataset.visible = 'true';
      result.innerHTML = '<p class="result-label">Creating…</p>';
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      if (!payload.slug) delete payload.slug;
      const headers = { 'content-type': 'application/json' };
      if (adminOnlyMode) headers['X-Admin-Token'] = currentCreateToken();
      const response = await fetch('/api/shorten', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        result.innerHTML = '<p class="error">' + escapeClient(data.error || 'Failed to create short URL') + '</p>';
        if (response.status === 401 && adminOnlyMode) lockCreator('Admin token rejected. Paste the correct token to unlock URL creation.');
        if (window.turnstile) turnstile.reset();
        return;
      }
      const expiresCopy = data.expiresInDays === null ? 'This link is valid indefinitely.' : 'This link expires in ' + data.expiresInDays + ' days.';
      result.innerHTML = '<p class="result-label">Your short URL is ready</p>'
        + '<div class="result-row"><a class="short-url" href="' + data.shortUrl + '">' + data.shortUrl + '</a>'
        + '<button type="button" class="copy-short-url">Copy</button></div>'
        + '<p class="result-meta">' + expiresCopy + '</p>';
      result.querySelector('.copy-short-url').addEventListener('click', async (event) => {
        await copyText(data.shortUrl);
        event.currentTarget.textContent = 'Copied';
        setTimeout(() => { event.currentTarget.textContent = 'Copy'; }, 1600);
      });
      form.reset();
      if (window.turnstile) turnstile.reset();
    });

    function escapeClient(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
  </script>
</body>
</html>`;
}

function renderInvalidLinkPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link no longer valid · zer0</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; --bg: #07070a; --panel: #111119; --border: #2c2c38; --muted: #aaaabc; --text: #f5f5f7; --accent: #8bd3ff; --good: #9ee6b8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top, #1b1b2f 0, var(--bg) 48%); color: var(--text); overflow: hidden; }
    body::before { content: ''; position: fixed; inset: -30vmax; pointer-events: none; background: radial-gradient(circle at 25% 25%, #8bd3ff22 0 10rem, transparent 20rem), radial-gradient(circle at 72% 20%, #9ee6b822 0 7rem, transparent 17rem), radial-gradient(circle at 50% 80%, #ffb4b416 0 8rem, transparent 18rem); filter: blur(8px); }
    main { position: relative; width: min(92vw, 760px); padding: clamp(1.5rem, 5vw, 3rem); border: 1px solid #24242d; border-radius: 32px; background: linear-gradient(180deg, #13131c 0%, #0f0f15 100%); box-shadow: 0 30px 100px #000a, inset 0 1px 0 #ffffff10; text-align: center; }
    .zero-mark { width: clamp(6rem, 28vw, 11rem); height: clamp(6rem, 28vw, 11rem); margin: 0 auto 1.25rem; display: grid; place-items: center; border-radius: 50%; background: radial-gradient(circle at 36% 24%, #ffffff 0 3%, #8bd3ff 4% 20%, #172636 21% 48%, #07070a 49% 100%); box-shadow: 0 0 0 1px #8bd3ff44, 0 0 60px #8bd3ff28, inset 0 0 30px #000a; color: #f5f5f7; font-size: clamp(4.2rem, 18vw, 8rem); font-weight: 950; letter-spacing: -.14em; line-height: 1; text-indent: -.07em; }
    .eyebrow { margin: 0 0 .8rem; color: var(--good); font-size: .85rem; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; letter-spacing: -0.06em; font-size: clamp(2.35rem, 8vw, 4.8rem); line-height: .92; }
    p { margin: 1rem auto 0; max-width: 40rem; color: #d7d7e4; font-size: clamp(1rem, 2.3vw, 1.18rem); line-height: 1.65; }
    .hint { padding: 1rem; border: 1px solid #30303b; border-radius: 18px; background: #09090d; color: var(--muted); }
    a { color: var(--accent); font-weight: 900; text-decoration-thickness: .12em; text-underline-offset: .18em; }
    .actions { display: flex; flex-wrap: wrap; gap: .75rem; justify-content: center; margin-top: 1.5rem; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 3rem; padding: .85rem 1.05rem; border: 1px solid #363648; border-radius: 14px; background: #20202b; color: #f4f4ff; text-decoration: none; }
    .button.primary { background: #fff; color: #050507; border-color: #fff; }
  </style>
</head>
<body>
  <main aria-labelledby="invalid-link-title">
    <div class="zero-mark" aria-hidden="true">0</div>
    <p class="eyebrow">404 · invalid zer0 link</p>
    <h1 id="invalid-link-title">This zer0 link is no longer valid</h1>
    <p class="hint">It may have expired, been removed, or never existed. Ask the person who shared it to create a new zer0 link and send you the fresh URL.</p>
    <div class="actions">
      <a class="button primary" href="/">Create a new link</a>
      <a class="button" href="javascript:history.back()">Go back</a>
    </div>
  </main>
</body>
</html>`;
}

function renderFavicon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="stylised zero favicon">
  <title>zer0 favicon</title>
  <defs>
    <linearGradient id="zero-glow" x1="20" y1="12" x2="108" y2="116" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f5f5f7"/>
      <stop offset="0.28" stop-color="#8bd3ff"/>
      <stop offset="0.68" stop-color="#9ee6b8"/>
      <stop offset="1" stop-color="#172636"/>
    </linearGradient>
    <radialGradient id="space" cx="38" cy="24" r="94" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1b1b2f"/>
      <stop offset="1" stop-color="#07070a"/>
    </radialGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="128" height="128" rx="30" fill="url(#space)"/>
  <circle cx="64" cy="64" r="47" fill="none" stroke="#8bd3ff22" stroke-width="2"/>
  <text x="64" y="89" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="92" font-weight="950" letter-spacing="-10" fill="url(#zero-glow)" filter="url(#glow)">0</text>
  <path d="M36 31 C54 16 86 19 101 42" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity=".82"/>
</svg>`;
}

function renderAdmin() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>zer0 admin</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; --bg: #07070a; --panel: #111119; --panel-2: #0b0b10; --border: #2c2c38; --muted: #aaaabc; --text: #f5f5f7; --accent: #8bd3ff; --good: #9ee6b8; --danger: #ffb4b4; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #1b1b2f 0, var(--bg) 46%); color: var(--text); }
    body, input, button, select { font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    main { width: min(94vw, 1120px); margin: 0 auto; padding: 2rem 0 4rem; }
    h1 { margin: 0; letter-spacing: -0.06em; font-size: clamp(2.6rem, 8vw, 5rem); line-height: .9; }
    h2 { margin: 0 0 .5rem; font-size: 1.1rem; }
    label { display: block; margin: 1rem 0 .4rem; color: #d8d8e6; font-weight: 800; }
    input, button, select { border-radius: 14px; border: 1px solid var(--border); padding: .9rem 1rem; font: inherit; }
    input, select { width: 100%; background: #09090d; color: #fff; outline: none; }
    input:focus, select:focus, button:focus-visible, a:focus-visible { outline: 3px solid #8bd3ff55; outline-offset: 2px; border-color: var(--accent); }
    button { background: #fff; color: #050507; font-weight: 900; cursor: pointer; transition: transform .14s ease, opacity .14s ease; }
    button:hover:not([disabled]) { transform: translateY(-1px); }
    button[disabled] { cursor: not-allowed; opacity: .45; }
    a { color: var(--accent); }
    .muted { color: var(--muted); }
    .hero { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
    .panel { margin-top: 1.25rem; padding: 1.25rem; border: 1px solid #24242d; border-radius: 24px; background: linear-gradient(180deg, var(--panel) 0%, #0f0f15 100%); box-shadow: 0 24px 80px #0008; }
    .auth-panel { border-color: #344258; background: linear-gradient(135deg, #101925 0%, #111118 70%); }
    .token-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: end; }
    .toolbar { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; justify-content: space-between; margin-top: 1rem; }
    .toolbar-actions { display: flex; flex-wrap: wrap; gap: .65rem; align-items: center; }
    .secondary-button { background: #20202b; color: #f4f4ff; border-color: #363648; }
    .danger-button { background: #3a1820; color: #ffd7df; border-color: #6d2a38; }
    .import-panel { margin-top: 1rem; padding: 1rem; border: 1px solid #30303b; border-radius: 18px; background: #09090d; }
    .import-grid { display: grid; grid-template-columns: minmax(9rem, 14rem) minmax(0, 1fr); gap: .75rem; align-items: end; }
    .import-actions { display: flex; flex-wrap: wrap; gap: .65rem; margin-top: .85rem; }
    .mapping-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .65rem; margin-top: .85rem; }
    .preview-table { width: 100%; margin-top: .85rem; border-collapse: collapse; font-size: .9rem; }
    .preview-table th, .preview-table td { padding: .45rem; border-bottom: 1px solid #252532; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    .pager { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; justify-content: center; margin-block: .85rem; }
    .page-size { display: grid; grid-template-columns: auto minmax(5rem, 7rem); gap: .5rem; align-items: center; margin: 0; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin: 1rem 0; }
    .pill { padding: .85rem 1rem; border: 1px solid var(--border); border-radius: 18px; background: var(--panel-2); color: #d7d7e4; }
    .pill strong { display: block; color: #fff; font-size: 1.25rem; }
    .status { margin-top: 1rem; min-height: 1.4rem; }
    .error { color: var(--danger); }
    .empty { margin-top: 1rem; padding: 1rem; border: 1px dashed #383849; border-radius: 18px; color: var(--muted); background: #09090d; }
    .cards { display: grid; gap: .85rem; margin-top: 1rem; }
    .card { padding: 1rem; border: 1px solid var(--border); border-radius: 18px; background: var(--panel-2); box-shadow: inset 0 1px 0 #ffffff0c; }
    .card-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .75rem; }
    .card-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; justify-content: flex-end; }
    .code { font-size: 1.15rem; font-weight: 900; color: var(--good); }
    .clicks { color: #fff; }
    .target { display: block; margin-top: .6rem; overflow-wrap: anywhere; }
    .validity-status { margin: .7rem 0 0; color: #d7d7e4; }
    .validity-form { margin-top: .85rem; }
    .validity-form label { margin-top: 0; }
    .validity-edit { display: grid; grid-template-columns: minmax(7rem, 11rem) auto; gap: .5rem; align-items: center; max-width: 28rem; }
    .validity-help { margin: .45rem 0 0; font-size: .92rem; }
    .stats { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .85rem; }
    .country { padding: .35rem .6rem; border: 1px solid #29364a; border-radius: 999px; background: #101925; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    [hidden] { display: none !important; }
    @media (max-width: 640px) { .token-row, .validity-edit, .import-grid { grid-template-columns: 1fr; } .page-size { grid-template-columns: 1fr; } .validity-edit button, .import-actions button { width: 100%; } }
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <div>
        <h1>zer0 admin</h1>
        <p class="muted">Browse short URLs, destinations, and redirect stats.</p>
      </div>
      <button type="button" id="logout" class="danger-button" hidden>Logout</button>
    </header>
    <section id="auth-panel" class="panel auth-panel" aria-labelledby="auth-title">
      <h2 id="auth-title">Authenticate</h2>
      <p id="admin-token-help" class="muted">Paste your ADMIN_TOKEN. After a successful load, this browser stores it locally so future visits can load automatically.</p>
      <form id="admin-form">
        <label for="admin-token">Admin token</label>
        <div class="token-row">
          <input id="admin-token" name="token" type="password" autocomplete="current-password" placeholder="Paste ADMIN_TOKEN" required aria-describedby="admin-token-help">
          <button type="submit">Load dashboard</button>
        </div>
      </form>
    </section>
    <section id="dashboard-panel" class="panel" aria-labelledby="dashboard-title" hidden>
      <div class="toolbar">
        <div>
          <h2 id="dashboard-title">Links</h2>
        </div>
        <div class="toolbar-actions">
          <button type="button" id="export-data" class="secondary-button" hidden>Export</button>
          <button type="button" id="toggle-import" class="secondary-button" hidden>Import</button>
          <button type="button" id="refresh" class="secondary-button" hidden>Refresh</button>
          <label class="page-size" for="page-size"><span>Items per page</span><select id="page-size"><option>10</option><option selected>25</option><option>50</option><option>100</option></select></label>
        </div>
      </div>
      <p id="status" class="status muted" aria-live="polite"></p>
      <section id="import-panel" class="import-panel" aria-labelledby="import-title" hidden>
        <h2 id="import-title">Import links</h2>
        <div class="import-grid">
          <label for="import-mode"><span>Import type</span><select id="import-mode"><option value="zer0">zer0 export</option><option value="custom">Custom CSV</option></select></label>
          <label for="import-file"><span>File</span><input id="import-file" type="file" accept=".json,.csv,application/json,text/csv"></label>
        </div>
        <div id="mapping-fields" class="mapping-grid"></div>
        <div id="import-preview" class="muted"></div>
        <p id="import-status" class="status muted" aria-live="polite"></p>
        <div class="import-actions">
          <button type="button" id="submit-import" disabled>Import</button>
          <button type="button" id="cancel-import" class="secondary-button">Cancel</button>
        </div>
      </section>
      <section id="results" aria-busy="false" aria-live="polite"></section>
    </section>
  </main>
  <script>
    const tokenStorageKey = 'zer0:adminToken';
    const authPanel = document.querySelector('#auth-panel');
    const dashboardPanel = document.querySelector('#dashboard-panel');
    const form = document.querySelector('#admin-form');
    const token = document.querySelector('#admin-token');
    const status = document.querySelector('#status');
    const results = document.querySelector('#results');
    const logout = document.querySelector('#logout');
    const refresh = document.querySelector('#refresh');
    const exportData = document.querySelector('#export-data');
    const toggleImport = document.querySelector('#toggle-import');
    const importPanel = document.querySelector('#import-panel');
    const importMode = document.querySelector('#import-mode');
    const importFile = document.querySelector('#import-file');
    const mappingFields = document.querySelector('#mapping-fields');
    const importPreview = document.querySelector('#import-preview');
    const importStatus = document.querySelector('#import-status');
    const submitImport = document.querySelector('#submit-import');
    const cancelImport = document.querySelector('#cancel-import');
    const pageSizeSelect = document.querySelector('#page-size');
    let links = [];
    let page = 1;
    let pageSize = Number(pageSizeSelect.value) || 25;
    let currentToken = '';
    let importState = { mode: 'zer0', payload: null, headers: [], rows: [] };
    const millisecondsPerDay = 24 * 60 * 60 * 1000;

    const countryNames = {
      ZA: 'South Africa', US: 'United States', GB: 'United Kingdom', IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', NL: 'Netherlands', AU: 'Australia', CA: 'Canada', BR: 'Brazil', IN: 'India', JP: 'Japan', CN: 'China', RU: 'Russia', ZZ: 'Unknown'
    };
    const importFields = [
      { key: 'targetUrl', label: 'Target URL', required: true, aliases: ['targeturl', 'url', 'longurl', 'destination', 'destinationurl'] },
      { key: 'code', label: 'Slug', aliases: ['code', 'slug', 'shortcode', 'shorturl'] },
      { key: 'createdAt', label: 'Created at', aliases: ['createdat', 'created', 'createdon'] },
      { key: 'validityDays', label: 'Validity days', aliases: ['validitydays', 'retentiondays', 'expiresindays'] },
      { key: 'expiresAt', label: 'Expires at', aliases: ['expiresat', 'expires', 'expiry', 'expiration'] },
      { key: 'totalClicks', label: 'Total clicks', aliases: ['totalclicks', 'clicks', 'visits'] },
      { key: 'countriesJson', label: 'Countries JSON', aliases: ['countriesjson', 'countries', 'countrystats'] },
    ];

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await loadLinks(token.value, { persistToken: true });
    });

    refresh.addEventListener('click', async () => {
      if (currentToken) await loadLinks(currentToken, { persistToken: false });
    });

    exportData.addEventListener('click', async () => {
      await exportLinks();
    });

    toggleImport.addEventListener('click', () => {
      importPanel.hidden = !importPanel.hidden;
      if (!importPanel.hidden) importFile.focus();
    });

    cancelImport.addEventListener('click', () => {
      resetImportPanel();
      importPanel.hidden = true;
    });

    importMode.addEventListener('change', () => {
      resetImportPanel({ keepMode: true });
    });

    importFile.addEventListener('change', async () => {
      await readImportFile();
    });

    submitImport.addEventListener('click', async () => {
      await submitImportPayload();
    });

    logout.addEventListener('click', () => {
      localStorage.removeItem('zer0:adminToken');
      currentToken = '';
      token.value = '';
      links = [];
      page = 1;
      setAuthenticated(false);
      status.className = 'status muted';
      status.textContent = 'Logged out. Paste ADMIN_TOKEN to load admin data.';
      results.innerHTML = '';
      results.setAttribute('aria-busy', 'false');
      resetImportPanel();
      token.focus();
    });

    pageSizeSelect.addEventListener('change', () => {
      pageSize = Number(pageSizeSelect.value) || 25;
      page = 1;
      renderPage();
    });

    results.addEventListener('click', async (event) => {
      const button = event.target.closest('.delete-link');
      if (!button) return;
      await deleteLink(button.dataset.code);
    });

    results.addEventListener('submit', async (event) => {
      const validityForm = event.target.closest('.validity-form');
      if (!validityForm) return;
      event.preventDefault();
      const formData = new FormData(validityForm);
      await saveValidity(validityForm.dataset.code, formData.get('validityDays'));
    });

    const savedToken = localStorage.getItem('zer0:adminToken');
    if (savedToken) {
      token.value = savedToken;
      loadLinks(savedToken, { persistToken: false });
    } else {
      setAuthenticated(false);
    }

    async function loadLinks(adminToken, { persistToken }) {
      currentToken = adminToken;
      status.className = 'status muted';
      status.textContent = 'Loading links…';
      results.setAttribute('aria-busy', 'true');
      results.innerHTML = '';

      const response = await fetch('/api/admin/links', {
        headers: { 'X-Admin-Token': adminToken },
      });
      const data = await response.json().catch(() => ({}));
      results.setAttribute('aria-busy', 'false');
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem('zer0:adminToken');
          setAuthenticated(false);
        }
        status.className = 'status error';
        status.textContent = data.error || 'Failed to load links';
        return;
      }

      if (persistToken) localStorage.setItem('zer0:adminToken', adminToken);
      setAuthenticated(true);
      links = Array.isArray(data.links) ? data.links : [];
      page = 1;
      renderPage();
    }

    function setAuthenticated(isAuthenticated) {
      authPanel.hidden = isAuthenticated;
      dashboardPanel.hidden = !isAuthenticated;
      logout.hidden = !isAuthenticated;
      refresh.hidden = !isAuthenticated;
      exportData.hidden = !isAuthenticated;
      toggleImport.hidden = !isAuthenticated;
      if (!isAuthenticated) importPanel.hidden = true;
      token.required = !isAuthenticated;
    }

    async function exportLinks() {
      if (!currentToken) return;
      status.className = 'status muted';
      status.textContent = 'Preparing export…';
      const response = await fetch('/api/admin/export', {
        headers: { 'X-Admin-Token': currentToken },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        status.className = 'status error';
        status.textContent = data.error || 'Failed to export links';
        return;
      }

      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = exportFilename(response.headers.get('content-disposition'));
      document.body.append(link);
      link.click();
      URL.revokeObjectURL(link.href);
      link.remove();
      status.className = 'status muted';
      status.textContent = 'Export downloaded.';
    }

    function exportFilename(header) {
      const match = String(header || '').match(/filename="([^"]+)"/);
      return match ? match[1] : 'zer0-export.json';
    }

    async function readImportFile() {
      const file = importFile.files && importFile.files[0];
      resetImportPanel({ keepMode: true, keepFile: true });
      if (!file) return;

      try {
        const text = await file.text();
        if (importMode.value === 'zer0') {
          const parsed = JSON.parse(text);
          if (!parsed || parsed.app !== 'zer0' || !Array.isArray(parsed.links)) {
            throw new Error('Choose a valid zer0 export JSON file.');
          }
          importState = { mode: 'zer0', payload: { mode: 'zer0', export: parsed }, headers: [], rows: [] };
          submitImport.disabled = false;
          importPreview.innerHTML = '<p class="muted">Ready to import ' + parsed.links.length + ' zer0 links. Existing slugs will be skipped.</p>';
          importStatus.textContent = '';
          return;
        }

        const csvRows = parseCsv(text);
        if (csvRows.length < 2) throw new Error('CSV must include a header row and at least one data row.');
        const headers = csvRows[0].map((header) => String(header || '').trim());
        const rows = csvRows.slice(1)
          .filter((row) => row.some((value) => String(value || '').trim() !== ''))
          .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
        if (rows.length === 0) throw new Error('CSV has no importable data rows.');
        importState = { mode: 'custom', payload: null, headers, rows };
        renderMappingFields();
        renderCsvPreview();
        submitImport.disabled = false;
        importStatus.textContent = '';
      } catch (error) {
        submitImport.disabled = true;
        importStatus.className = 'status error';
        importStatus.textContent = error.message || 'Failed to read import file';
      }
    }

    function renderMappingFields() {
      mappingFields.innerHTML = importFields.map((field) => {
        const selected = defaultHeaderFor(field);
        const options = ['<option value="">Use default</option>']
          .concat(importState.headers.map((header) => '<option value="' + escapeAttr(header) + '"' + (header === selected ? ' selected' : '') + '>' + escapeClient(header) + '</option>'))
          .join('');
        return '<label for="map-' + escapeAttr(field.key) + '">' + escapeClient(field.label) + (field.required ? ' *' : '') + '<select id="map-' + escapeAttr(field.key) + '" data-import-field="' + escapeAttr(field.key) + '">' + options + '</select></label>';
      }).join('');
    }

    function defaultHeaderFor(field) {
      return importState.headers.find((header) => field.aliases.includes(normalizeHeader(header))) || '';
    }

    function renderCsvPreview() {
      const previewRows = importState.rows.slice(0, 5);
      const headerHtml = importState.headers.slice(0, 6).map((header) => '<th>' + escapeClient(header) + '</th>').join('');
      const bodyHtml = previewRows.map((row) => '<tr>' + importState.headers.slice(0, 6).map((header) => '<td>' + escapeClient(row[header]) + '</td>').join('') + '</tr>').join('');
      importPreview.innerHTML = '<p class="muted">Mapped CSV preview. Existing slugs will be skipped. Missing optional fields use zer0 defaults.</p><table class="preview-table"><thead><tr>' + headerHtml + '</tr></thead><tbody>' + bodyHtml + '</tbody></table>';
    }

    async function submitImportPayload() {
      if (!currentToken || submitImport.disabled) return;
      let payload = importState.payload;
      if (importMode.value === 'custom') {
        const records = buildCustomImportRecords();
        if (!records) return;
        payload = { mode: 'custom', records };
      }
      if (!payload) return;

      submitImport.disabled = true;
      importStatus.className = 'status muted';
      importStatus.textContent = 'Importing…';
      const response = await fetch('/api/admin/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Admin-Token': currentToken },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      submitImport.disabled = false;
      if (!response.ok) {
        importStatus.className = 'status error';
        importStatus.textContent = data.error || 'Import failed';
        return;
      }

      importStatus.className = data.failed > 0 ? 'status error' : 'status muted';
      importStatus.textContent = 'Imported ' + data.imported + ', skipped ' + data.skipped + ', expired ' + data.expired + ', failed ' + data.failed + '.';
      if (data.imported > 0) await loadLinks(currentToken, { persistToken: false });
    }

    function buildCustomImportRecords() {
      const mapping = {};
      for (const field of importFields) {
        const selected = document.querySelector('[data-import-field="' + field.key + '"]')?.value || '';
        if (field.required && !selected) {
          importStatus.className = 'status error';
          importStatus.textContent = field.label + ' must be mapped before importing.';
          return null;
        }
        mapping[field.key] = selected;
      }

      return importState.rows.map((row) => {
        const record = {};
        for (const field of importFields) {
          const header = mapping[field.key];
          if (header && row[header] !== undefined && row[header] !== '') record[field.key] = row[header];
        }
        return record;
      });
    }

    function resetImportPanel({ keepMode = false, keepFile = false } = {}) {
      importState = { mode: keepMode ? importMode.value : 'zer0', payload: null, headers: [], rows: [] };
      if (!keepMode) importMode.value = 'zer0';
      if (!keepFile) importFile.value = '';
      mappingFields.innerHTML = '';
      importPreview.innerHTML = '';
      importStatus.className = 'status muted';
      importStatus.textContent = '';
      submitImport.disabled = true;
    }

    async function deleteLink(code) {
      if (!code) return;
      if (!confirm('Delete /' + code + '? This removes the short URL and makes the slug available again.')) return;
      status.className = 'status muted';
      status.textContent = 'Deleting /' + code + '…';
      results.setAttribute('aria-busy', 'true');
      const response = await fetch('/api/admin/links/' + encodeURIComponent(code), {
        method: 'DELETE',
        headers: { 'X-Admin-Token': currentToken },
      });
      const data = await response.json().catch(() => ({}));
      results.setAttribute('aria-busy', 'false');
      if (!response.ok) {
        status.className = 'status error';
        status.textContent = data.error || 'Failed to delete /' + code;
        return;
      }
      links = links.filter((link) => link.code !== code);
      status.className = 'status muted';
      status.textContent = data.deleted ? 'Deleted /' + code + '. The slug is available again.' : '/' + code + ' was already gone.';
      renderPage({ updateStatus: false });
    }

    async function saveValidity(code, validityDaysValue) {
      if (!code) return;
      const validityDays = normalizeDays(validityDaysValue);
      status.className = 'status muted';
      status.textContent = 'Saving validity for /' + code + '…';
      results.setAttribute('aria-busy', 'true');
      const response = await fetch('/api/admin/links/' + encodeURIComponent(code), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'X-Admin-Token': currentToken },
        body: JSON.stringify({ validityDays }),
      });
      const data = await response.json().catch(() => ({}));
      results.setAttribute('aria-busy', 'false');
      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem('zer0:adminToken');
          setAuthenticated(false);
        }
        status.className = 'status error';
        status.textContent = data.error || 'Failed to save validity for /' + code;
        return;
      }

      const index = links.findIndex((link) => link.code === code);
      if (index >= 0) links[index] = data;
      status.className = 'status muted';
      status.textContent = validityDays === 0 ? '/' + code + ' is now valid indefinitely.' : '/' + code + ' is valid for ' + validityDays + ' days from now.';
      renderPage({ updateStatus: false });
    }

    function renderPage({ updateStatus = true } = {}) {
      const totalClicks = links.reduce((sum, link) => sum + (Number(link.totalClicks) || 0), 0);
      const pageCount = Math.max(1, Math.ceil(links.length / pageSize));
      page = Math.min(Math.max(1, page), pageCount);
      const start = (page - 1) * pageSize;
      const visibleLinks = links.slice(start, start + pageSize);
      if (updateStatus) {
        status.className = 'status muted';
        status.textContent = links.length === 0 ? 'Loaded. No links yet.' : 'Showing links ' + (start + 1) + '–' + Math.min(start + pageSize, links.length) + ' of ' + links.length + '.';
      }
      results.innerHTML = '<div class="summary" aria-label="Dashboard summary"><div class="pill"><span>Links</span><strong>' + links.length + '</strong></div><div class="pill"><span>Total clicks</span><strong>' + totalClicks + '</strong></div><div class="pill"><span>Page</span><strong>' + page + ' / ' + pageCount + '</strong></div></div>';

      if (links.length === 0) {
        results.innerHTML += '<div class="empty">No links found. Create your first short link from the homepage.</div>';
        return;
      }

      results.append(renderPager(pageCount));
      const cards = document.createElement('div');
      cards.className = 'cards';
      for (const link of visibleLinks) {
        const countries = Object.entries(link.countries || {})
          .filter(([_country, count]) => Number(count) > 0)
          .sort((a, b) => b[1] - a[1]);
        const countryHtml = countries.length
          ? countries.map(([country, count]) => '<span class="country">' + escapeClient(formatCountry(country)) + ': ' + Number(count) + '</span>').join('')
          : '<span class="muted">No clicks yet</span>';
        const validityInputId = 'validity-days-' + link.code;
        const validityHelpId = 'validity-help-' + link.code;
        const validityValue = normalizeDays(link.validityDays);
        const card = document.createElement('article');
        card.className = 'card';
        card.innerHTML = '<div class="card-head"><div><span class="code">/' + escapeClient(link.code) + '</span></div><div class="card-actions"><strong class="clicks">Total clicks: ' + Number(link.totalClicks || 0) + '</strong><button type="button" class="delete-link danger-button" data-code="' + escapeAttr(link.code) + '">Delete</button></div></div>'
          + '<a class="target" href="' + escapeAttr(link.shortUrl) + '">' + escapeClient(link.shortUrl) + '</a>'
          + '<a class="target muted" href="' + escapeAttr(link.targetUrl) + '">' + escapeClient(link.targetUrl) + '</a>'
          + (link.createdAt ? '<p class="muted">Created: ' + escapeClient(link.createdAt) + '</p>' : '')
          + '<p class="validity-status">' + escapeClient(validitySummary(link)) + '</p>'
          + '<form class="validity-form" data-code="' + escapeAttr(link.code) + '"><label for="' + escapeAttr(validityInputId) + '">Validity days</label><div class="validity-edit"><input id="' + escapeAttr(validityInputId) + '" name="validityDays" type="number" min="0" step="1" inputmode="numeric" value="' + validityValue + '" aria-describedby="' + escapeAttr(validityHelpId) + '"><button type="submit" class="secondary-button save-validity">Save</button></div><p id="' + escapeAttr(validityHelpId) + '" class="muted validity-help">0 keeps this link valid indefinitely. Positive values start from save time.</p></form>'
          + '<div class="stats" aria-label="Country click counters">' + countryHtml + '</div>';
        cards.append(card);
      }
      results.append(cards);
      results.append(renderPager(pageCount));
    }

    function renderPager(pageCount) {
      const pager = document.createElement('nav');
      pager.className = 'pager';
      pager.setAttribute('aria-label', 'Pagination');
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.textContent = 'Previous';
      previous.disabled = page <= 1;
      previous.addEventListener('click', () => { page -= 1; renderPage(); });
      const next = document.createElement('button');
      next.type = 'button';
      next.textContent = 'Next';
      next.disabled = page >= pageCount;
      next.addEventListener('click', () => { page += 1; renderPage(); });
      const label = document.createElement('span');
      label.className = 'muted';
      label.setAttribute('aria-current', 'page');
      label.textContent = 'Page ' + page + ' of ' + pageCount;
      pager.append(previous, label, next);
      return pager;
    }

    function formatCountry(country) {
      const code = String(country || 'ZZ').trim().toUpperCase();
      if (code === 'ZZ') return '🏴‍☠️ Unknown (ZZ)';
      return flagEmoji(code) + ' ' + countryName(code) + ' (' + code + ')';
    }

    function validitySummary(link) {
      const expiresAt = link.expiresAt ? new Date(link.expiresAt) : null;
      if (!expiresAt || Number.isNaN(expiresAt.valueOf())) return 'Valid indefinitely.';
      const remainingDays = Number.isFinite(Number(link.expiresInDays))
        ? Math.max(0, Math.ceil(Number(link.expiresInDays)))
        : Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / millisecondsPerDay));
      const dayCopy = remainingDays === 1 ? '1 day remaining' : remainingDays + ' days remaining';
      return 'Expires at ' + link.expiresAt + ' (' + dayCopy + ').';
    }

    function normalizeDays(value) {
      if (value === undefined || value === null || value === '') return 0;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) return 0;
      return Math.floor(parsed);
    }

    function parseCsv(text) {
      const rows = [];
      let row = [];
      let value = '';
      let quoted = false;
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (quoted) {
          if (char === '"' && next === '"') {
            value += '"';
            index += 1;
          } else if (char === '"') {
            quoted = false;
          } else {
            value += char;
          }
          continue;
        }
        if (char === '"') {
          quoted = true;
        } else if (char === ',') {
          row.push(value);
          value = '';
        } else if (char === '\n') {
          row.push(value);
          rows.push(row);
          row = [];
          value = '';
        } else if (char !== '\r') {
          value += char;
        }
      }
      if (quoted) throw new Error('CSV has an unterminated quoted value.');
      row.push(value);
      if (row.some((item) => item !== '') || rows.length === 0) rows.push(row);
      return rows;
    }

    function normalizeHeader(value) {
      return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function countryName(code) {
      if (countryNames[code]) return countryNames[code];
      try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
      } catch {
        return code;
      }
    }

    function flagEmoji(code) {
      if (!/^[A-Z]{2}$/.test(code)) return '🏴‍☠️';
      return String.fromCodePoint(...[...code].map((ch) => 127397 + ch.charCodeAt(0)));
    }

    function escapeClient(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function escapeAttr(value) {
      return escapeClient(value).replaceAll(String.fromCharCode(96), '&#96;');
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
