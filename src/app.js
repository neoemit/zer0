import Fastify from 'fastify';
import formBody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';

import { HotCache } from './cache.js';
import { captchaCanBeSkipped, makeCode, normalizeTargetUrl, sanitizeCustomSlug, validateCustomSlug } from './core.js';
import { verifyCaptcha } from './captcha.js';
import { geolocateIp as defaultGeolocateIp } from './geoip.js';
import { getUiAsset } from './ui/assets.js';
import {
  renderAdminPage,
  renderHomePage,
  renderInvalidLinkPage as renderInvalidPage,
} from './ui/pages.js';

const SECONDS_PER_DAY = 24 * 60 * 60;
const IMPORT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const EXPORT_SCHEMA_VERSION = 1;

export async function buildApp(opts) {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 16 * 1024,
    ignoreTrailingSlash: true,
  });

  const cache = opts.cache ?? new HotCache(opts.hotCache);
  const publicBaseUrl = String(opts.publicBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  const codeLength = opts.codeLength || 7;
  const retentionDays = normalizeValidityDays(opts.retentionDays);
  const redirectCacheControl = opts.redirectCacheControl || 'public, max-age=300';
  const captcha = opts.captcha || { provider: 'none' };
  const adminToken = opts.adminToken || '';
  const adminOnlyMode = opts.adminOnlyMode === true;
  const fetchImpl = opts.fetchImpl || fetch;
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

  app.get('/assets/:name', async (request, reply) => {
    const asset = getUiAsset(request.params.name);
    if (!asset) return reply.code(404).send({ error: 'Not found' });
    return reply
      .type(asset.type)
      .header('cache-control', 'public, max-age=300')
      .send(asset.content);
  });

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderHomePage({ siteKey: captcha.siteKey || '', captchaEnabled: !captchaCanBeSkipped(captcha), retentionDays, adminOnlyMode });
  });

  app.get('/admin', async (request, reply) => {
    if (request.query && Object.hasOwn(request.query, 'token')) {
      return reply.redirect('/admin', 303);
    }
    reply.type('text/html; charset=utf-8');
    return renderAdminPage({ siteKey: captcha.siteKey || '', captchaEnabled: !captchaCanBeSkipped(captcha) });
  });

  app.post('/api/admin/auth', async (request, reply) => {
    const body = request.body || {};
    if (!authorizeAdmin(request, reply, adminToken, { token: body.adminToken || body.token })) return reply;

    const captchaToken = body.captchaToken || body['cf-turnstile-response'];
    const captchaResult = await verifyCaptcha({ captcha, token: captchaToken, ip: request.ip, fetchImpl });
    if (!captchaResult.ok) {
      return reply.code(403).send({ error: captchaResult.reason || 'CAPTCHA verification failed' });
    }
    return { ok: true };
  });

  app.post('/api/creation-auth', async (request, reply) => {
    if (!adminOnlyMode) return reply.code(404).send({ error: 'Not found' });
    if (!authorizeAdmin(request, reply, adminToken, {
      token: request.body?.adminToken,
      disabledMessage: 'Admin-only mode requires ADMIN_TOKEN to be configured',
    })) return reply;

    const body = request.body || {};
    const captchaToken = body.captchaToken || body['cf-turnstile-response'];
    const captchaResult = await verifyCaptcha({ captcha, token: captchaToken, ip: request.ip, fetchImpl });
    if (!captchaResult.ok) {
      return reply.code(403).send({ error: captchaResult.reason || 'CAPTCHA verification failed' });
    }
    return { ok: true };
  });

  app.post('/api/shorten', { config: { rateLimit: opts.rateLimit ?? { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (adminOnlyMode && !authorizeAdmin(request, reply, adminToken, { disabledMessage: 'Admin-only mode requires ADMIN_TOKEN to be configured' })) return reply;

    const body = request.body || {};
    if (!adminOnlyMode) {
      const captchaToken = body.captchaToken || body['cf-turnstile-response'];
      const captchaResult = await verifyCaptcha({ captcha, token: captchaToken, ip: request.ip, fetchImpl });
      if (!captchaResult.ok) {
        return reply.code(403).send({ error: captchaResult.reason || 'CAPTCHA verification failed' });
      }
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

    let updates;
    try {
      updates = normalizeAdminLinkUpdates(request.body || {});
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }

    const updated = typeof store.updateLink === 'function'
      ? await store.updateLink(code, updates)
      : await store.updateValidity(code, updates.validityDays);
    if (updated?.conflict) return reply.code(409).send({ error: 'Slug already exists' });
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    cache.delete(code);
    if (updated.code && updated.code !== code) cache.delete(updated.code);
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
  return reply.code(404).type('text/html; charset=utf-8').send(renderInvalidPage());
}

function authorizeAdmin(request, reply, adminToken, options = {}) {
  const disabledMessage = options.disabledMessage || 'Admin API is disabled until ADMIN_TOKEN is configured';
  if (!adminToken) {
    reply.code(503).send({ error: disabledMessage });
    return false;
  }

  const authorization = request.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  const token = options.token ?? request.headers['x-admin-token'] ?? bearer;
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

function normalizeAdminLinkUpdates(body) {
  const updates = {};
  if (Object.hasOwn(body, 'code')) {
    updates.code = validateCustomSlug(body.code);
  } else if (Object.hasOwn(body, 'slug')) {
    updates.code = validateCustomSlug(body.slug);
  }
  if (Object.hasOwn(body, 'targetUrl')) {
    updates.targetUrl = normalizeTargetUrl(body.targetUrl);
  } else if (Object.hasOwn(body, 'url')) {
    updates.targetUrl = normalizeTargetUrl(body.url);
  }
  if (Object.hasOwn(body, 'validityDays')) {
    updates.validityDays = normalizeValidityDays(body.validityDays);
  }
  return updates;
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
    const row = Number(rawRecord?.row) || index + 1;
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
  const targetUrl = normalizeTargetUrl(record.targetUrl ?? record.url ?? record.longUrl ?? record.destinationUrl ?? record.destination ?? record.target);
  const explicitCode = record.code ?? record.slug ?? record.source;
  const hasExplicitCode = explicitCode !== undefined && explicitCode !== null && String(explicitCode).trim() !== '';
  const code = hasExplicitCode
    ? normalizeImportedSlug(explicitCode)
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

function normalizeImportedSlug(value) {
  const sanitized = sanitizeCustomSlug(value);
  if (!sanitized) {
    throw new Error('Slug has no valid characters after sanitizing');
  }
  return validateCustomSlug(sanitized);
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
  const explicitTotal = record.totalClicks ?? record.hits ?? stats.totalClicks ?? stats.total;
  const inferredTotal = Object.values(countries).reduce((sum, count) => sum + count, 0);
  const totalClicks = explicitTotal === undefined || explicitTotal === null || explicitTotal === ''
    ? inferredTotal
    : Math.max(0, Math.floor(Number(explicitTotal) || 0));
  if (totalClicks > 0 && Object.keys(countries).length === 0) countries.ZZ = totalClicks;
  return {
    totalClicks,
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
