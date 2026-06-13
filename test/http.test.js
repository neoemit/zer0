import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

import { buildApp } from '../src/app.js';

const SECONDS_PER_DAY = 24 * 60 * 60;

class MemoryStore {
  constructor() {
    this.map = new Map();
    this.ttls = new Map();
    this.stats = new Map();
    this.metadata = new Map();
  }
  async get(code) {
    return this.map.get(code) ?? null;
  }
  async set(code, url, options = 0) {
    if (this.map.has(code)) return false;
    const { ttlSeconds, validityDays, expiresAt } = normalizeStoreOptions(options);
    this.map.set(code, url);
    this.ttls.set(code, ttlSeconds);
    this.metadata.set(code, { validityDays, expiresAt });
    return true;
  }
  async recordAccess(code, { country }) {
    const existing = this.stats.get(code) ?? { code, totalClicks: 0, countries: {} };
    existing.totalClicks += 1;
    existing.countries[country] = (existing.countries[country] ?? 0) + 1;
    this.stats.set(code, existing);
  }
  async getStats(code) {
    return this.stats.get(code) ?? { code, totalClicks: 0, countries: {} };
  }
  async listLinks() {
    return [...this.map.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, targetUrl]) => this.linkFor(code, targetUrl));
  }
  async exportLinks() {
    return this.listLinks();
  }
  async importLinks(records) {
    const rows = [];
    for (const record of records) {
      const row = Number(record.row) || rows.length + 1;
      if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
        rows.push({ row, code: record.code, status: 'expired', reason: 'Link expiry is in the past' });
        continue;
      }
      if (this.map.has(record.code)) {
        rows.push({ row, code: record.code, status: 'skipped', reason: 'Slug already exists' });
        continue;
      }
      const ttlSeconds = record.expiresAt
        ? Math.max(0, Math.floor((Date.parse(record.expiresAt) - Date.now()) / 1000))
        : normalizeDays(record.validityDays) * SECONDS_PER_DAY;
      const expiresAt = ttlSeconds > 0 ? (record.expiresAt || new Date(Date.now() + ttlSeconds * 1000).toISOString()) : null;
      this.map.set(record.code, record.targetUrl);
      this.ttls.set(record.code, ttlSeconds);
      this.metadata.set(record.code, {
        createdAt: record.createdAt,
        validityDays: normalizeDays(record.validityDays || (ttlSeconds > 0 ? Math.ceil(ttlSeconds / SECONDS_PER_DAY) : 0)),
        expiresAt,
      });
      this.stats.set(record.code, {
        code: record.code,
        totalClicks: Math.max(0, Math.floor(Number(record.stats?.totalClicks) || 0)),
        countries: record.stats?.countries || {},
      });
      rows.push({ row, code: record.code, status: 'imported' });
    }
    return {
      imported: rows.filter((row) => row.status === 'imported').length,
      skipped: rows.filter((row) => row.status === 'skipped').length,
      expired: rows.filter((row) => row.status === 'expired').length,
      failed: rows.filter((row) => row.status === 'error').length,
      rows,
    };
  }
  async updateValidity(code, validityDays) {
    return this.updateLink(code, { validityDays });
  }
  async updateLink(code, updates = {}) {
    const targetUrl = this.map.get(code);
    if (!targetUrl) return null;

    const nextCode = String(updates.code || code);
    if (nextCode !== code && this.map.has(nextCode)) return { conflict: true };

    const existingMetadata = this.metadata.get(code) ?? {};
    const nextTargetUrl = Object.hasOwn(updates, 'targetUrl') ? String(updates.targetUrl) : targetUrl;
    const validityWasUpdated = Object.hasOwn(updates, 'validityDays');
    const ttlSeconds = validityWasUpdated
      ? normalizeDays(updates.validityDays) * SECONDS_PER_DAY
      : this.ttls.get(code) ?? 0;
    const normalizedDays = validityWasUpdated
      ? normalizeDays(updates.validityDays)
      : normalizeDays(existingMetadata.validityDays ?? (ttlSeconds > 0 ? Math.ceil(ttlSeconds / SECONDS_PER_DAY) : 0));
    const expiresAt = ttlSeconds > 0
      ? (validityWasUpdated ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : existingMetadata.expiresAt || new Date(Date.now() + ttlSeconds * 1000).toISOString())
      : null;
    const metadata = {
      ...existingMetadata,
      code: nextCode,
      targetUrl: nextTargetUrl,
      validityDays: normalizedDays,
      expiresAt,
    };

    if (nextCode !== code) {
      this.map.delete(code);
      this.ttls.delete(code);
      this.metadata.delete(code);
      const stats = this.stats.get(code);
      this.stats.delete(code);
      if (stats) this.stats.set(nextCode, { ...stats, code: nextCode });
    }

    this.map.set(nextCode, nextTargetUrl);
    this.ttls.set(nextCode, ttlSeconds);
    this.metadata.set(nextCode, metadata);
    return this.linkFor(nextCode, nextTargetUrl);
  }
  async delete(code) {
    const existed = this.map.delete(code);
    this.stats.delete(code);
    this.ttls.delete(code);
    this.metadata.delete(code);
    return existed;
  }
  async deleteAll() {
    const deleted = this.map.size;
    this.map.clear();
    this.stats.clear();
    this.ttls.clear();
    this.metadata.clear();
    return deleted;
  }
  ttl(code) {
    return this.ttls.get(code);
  }
  linkFor(code, targetUrl) {
    const ttlSeconds = this.ttls.get(code) ?? 0;
    const metadata = this.metadata.get(code) ?? {};
    return {
      code,
      targetUrl,
      ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {}),
      validityDays: normalizeDays(metadata.validityDays ?? (ttlSeconds > 0 ? Math.ceil(ttlSeconds / SECONDS_PER_DAY) : 0)),
      expiresAt: ttlSeconds > 0 ? metadata.expiresAt : null,
      expiresInDays: ttlSeconds > 0 ? Math.ceil(ttlSeconds / SECONDS_PER_DAY) : null,
      stats: this.stats.get(code) ?? { code, totalClicks: 0, countries: {} },
    };
  }
  async close() {}
}

function normalizeStoreOptions(options) {
  if (options && typeof options === 'object') {
    const ttlSeconds = normalizeTtlSeconds(options.ttlSeconds);
    return {
      ttlSeconds,
      validityDays: normalizeDays(options.validityDays ?? (ttlSeconds > 0 ? Math.ceil(ttlSeconds / SECONDS_PER_DAY) : 0)),
      expiresAt: ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null,
    };
  }

  const ttlSeconds = normalizeTtlSeconds(options);
  return {
    ttlSeconds,
    validityDays: ttlSeconds > 0 ? Math.ceil(ttlSeconds / SECONDS_PER_DAY) : 0,
    expiresAt: ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null,
  };
}

function normalizeTtlSeconds(value) {
  const parsed = Math.floor(Number(value) || 0);
  return parsed > 0 ? parsed : 0;
}

function normalizeDays(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

test('shorten API creates an entry when CAPTCHA is disabled for local tests', async () => {
  const store = new MemoryStore();
  const app = await buildApp({
    store,
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
    trustProxy: false,
    retentionDays: 30,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com/path', slug: 'abc123' },
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(JSON.parse(response.body), {
    code: 'abc123',
    shortUrl: 'http://sho.rt/abc123',
    targetUrl: 'https://example.com/path',
    expiresInDays: 30,
  });
  assert.equal(await store.get('abc123'), 'https://example.com/path');
  await app.close();
});

test('shorten API stores and redirects to target URLs with fragments', async () => {
  const store = new MemoryStore();
  const app = await buildApp({
    store,
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
  });
  const targetUrl = 'https://openwebrx.gadgeteerza.co.za/#freq=145700000,mod=nfm,sql=-150';

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: targetUrl, slug: 'openrx' },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).targetUrl, targetUrl);
  assert.equal(await store.get('openrx'), targetUrl);

  const redirect = await app.inject({ method: 'GET', url: '/openrx' });
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, targetUrl);
  await app.close();
});

test('shorten API generates a usable slug when none is provided', async () => {
  const store = new MemoryStore();
  const app = await buildApp({
    store,
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
    codeLength: 8,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com/generated' },
  });

  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.match(body.code, /^[A-Za-z0-9]{8}$/);
  assert.equal(body.shortUrl, `http://sho.rt/${body.code}`);
  assert.equal(body.targetUrl, 'https://example.com/generated');
  assert.equal(await store.get(body.code), 'https://example.com/generated');

  const redirect = await app.inject({ method: 'GET', url: `/${body.code}` });
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, 'https://example.com/generated');
  await app.close();
});

test('created links expire after the configured retention window', async () => {
  const store = new MemoryStore();
  const app = await buildApp({
    store,
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
    retentionDays: 45,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com/ttl', slug: 'ttltest' },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(store.ttl('ttltest'), 45 * 24 * 60 * 60);
  assert.equal(JSON.parse(response.body).expiresInDays, 45);
  await app.close();
});

test('created links use user-defined validity days when provided', async () => {
  const store = new MemoryStore();
  const app = await buildApp({
    store,
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
    retentionDays: 30,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com/custom-ttl', slug: 'customttl', validityDays: 7 },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(store.ttl('customttl'), 7 * 24 * 60 * 60);
  assert.equal(JSON.parse(response.body).expiresInDays, 7);
  await app.close();
});

test('created links can override the configured default with indefinite validity', async () => {
  const store = new MemoryStore();
  const app = await buildApp({
    store,
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
    retentionDays: 30,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com/no-expiry', slug: 'noexpiry', validityDays: 0 },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(store.ttl('noexpiry'), 0);
  assert.equal(JSON.parse(response.body).expiresInDays, null);
  await app.close();
});

test('created links are unlimited when retentionDays is 0', async () => {
  const store = new MemoryStore();
  const app = await buildApp({
    store,
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
    retentionDays: 0,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com/unlimited', slug: 'forever' },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(store.ttl('forever'), 0);
  assert.equal(JSON.parse(response.body).expiresInDays, null);
  await app.close();
});

test('redirects increment link stats with country geolocation', async () => {
  const store = new MemoryStore();
  await store.set('stats1', 'https://example.com/stats');
  const app = await buildApp({
    store,
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
    adminToken: 'secret',
    geolocateIp: () => 'IT',
  });

  await app.inject({ method: 'GET', url: '/stats1', remoteAddress: '93.44.12.1' });
  await app.inject({ method: 'GET', url: '/stats1', remoteAddress: '93.44.12.1' });

  const response = await app.inject({ method: 'GET', url: '/api/stats/stats1', headers: { authorization: 'Bearer secret' } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { code: 'stats1', totalClicks: 2, countries: { IT: 2 } });
  await app.close();
});

test('admin can list all links with target URLs, short URLs, and stats', async () => {
  const store = new MemoryStore();
  await store.set('listtwo', 'https://example.com/two');
  await store.set('listone', 'https://example.com/one');
  await store.recordAccess('listone', { country: 'IT' });
  await store.recordAccess('listone', { country: 'US' });
  await store.recordAccess('listone', { country: 'IT' });
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/api/admin/links', headers: { 'x-admin-token': 'secret' } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    links: [
      {
        code: 'listone',
        shortUrl: 'http://sho.rt/listone',
        targetUrl: 'https://example.com/one',
        validityDays: 0,
        expiresAt: null,
        expiresInDays: null,
        totalClicks: 3,
        countries: { IT: 2, US: 1 },
      },
      {
        code: 'listtwo',
        shortUrl: 'http://sho.rt/listtwo',
        targetUrl: 'https://example.com/two',
        validityDays: 0,
        expiresAt: null,
        expiresInDays: null,
        totalClicks: 0,
        countries: {},
      },
    ],
  });
  await app.close();
});

test('admin can edit link validity from save time', async () => {
  const store = new MemoryStore();
  await store.set('extend1', 'https://example.com/extend', { ttlSeconds: 3 * SECONDS_PER_DAY, validityDays: 3 });
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const unauthorized = await app.inject({
    method: 'PATCH',
    url: '/api/admin/links/extend1',
    payload: { validityDays: 60 },
  });
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/admin/links/extend1',
    headers: { 'x-admin-token': 'secret' },
    payload: { validityDays: 60 },
  });

  const body = JSON.parse(response.body);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(response.statusCode, 200);
  assert.equal(store.ttl('extend1'), 60 * SECONDS_PER_DAY);
  assert.equal(body.code, 'extend1');
  assert.equal(body.shortUrl, 'http://sho.rt/extend1');
  assert.equal(body.targetUrl, 'https://example.com/extend');
  assert.equal(body.validityDays, 60);
  assert.equal(body.expiresInDays, 60);
  assert.ok(Date.parse(body.expiresAt) > Date.now());
  await app.close();
});

test('admin can export all links with metadata and stats', async () => {
  const store = new MemoryStore();
  await store.set('export1', 'https://example.com/export', { ttlSeconds: 5 * SECONDS_PER_DAY, validityDays: 5 });
  await store.recordAccess('export1', { country: 'US' });
  await store.recordAccess('export1', { country: 'IT' });
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const unauthorized = await app.inject({ method: 'GET', url: '/api/admin/export' });
  const response = await app.inject({ method: 'GET', url: '/api/admin/export', headers: { 'x-admin-token': 'secret' } });
  const body = JSON.parse(response.body);

  assert.equal(unauthorized.statusCode, 401);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-disposition'], /zer0-export-/);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.app, 'zer0');
  assert.equal(body.links.length, 1);
  assert.equal(body.links[0].code, 'export1');
  assert.equal(body.links[0].targetUrl, 'https://example.com/export');
  assert.equal(body.links[0].validityDays, 5);
  assert.equal(body.links[0].expiresInDays, 5);
  assert.deepEqual(body.links[0].stats, { totalClicks: 2, countries: { US: 1, IT: 1 } });
  await app.close();
});

test('admin can import a zer0 export with metadata and stats', async () => {
  const store = new MemoryStore();
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });
  const expiresAt = new Date(Date.now() + 12 * SECONDS_PER_DAY * 1000).toISOString();

  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/import',
    headers: { 'x-admin-token': 'secret' },
    payload: {
      mode: 'zer0',
      export: {
        schemaVersion: 1,
        app: 'zer0',
        links: [{
          code: 'import1',
          targetUrl: 'https://example.com/import',
          createdAt: '2026-06-01T12:00:00.000Z',
          validityDays: 12,
          expiresAt,
          stats: { totalClicks: 9, countries: { ZA: 4, US: 5 } },
        }],
      },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).imported, 1);
  assert.equal(await store.get('import1'), 'https://example.com/import');
  assert.equal(store.ttl('import1') > 0, true);
  assert.deepEqual(await store.getStats('import1'), { code: 'import1', totalClicks: 9, countries: { ZA: 4, US: 5 } });
  const listed = await store.listLinks();
  assert.equal(listed[0].createdAt, '2026-06-01T12:00:00.000Z');
  assert.equal(listed[0].validityDays, 12);
  await app.close();
});

test('custom import applies defaults, skips conflicts, and reports row errors', async () => {
  const store = new MemoryStore();
  await store.set('taken', 'https://example.com/existing');
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret', codeLength: 7 });

  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/import',
    headers: { authorization: 'Bearer secret' },
    payload: {
      mode: 'custom',
      records: [
        { code: 'taken', targetUrl: 'https://example.com/conflict' },
        { targetUrl: 'https://example.com/generated', totalClicks: '2', countriesJson: '{"US":2}' },
        { code: 'badurl', targetUrl: 'not a url' },
      ],
    },
  });

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.imported, 1);
  assert.equal(body.skipped, 1);
  assert.equal(body.failed, 1);
  assert.equal(await store.get('taken'), 'https://example.com/existing');
  assert.equal((await store.listLinks()).length, 2);
  assert.deepEqual(body.rows.map((row) => row.status), ['skipped', 'imported', 'error']);
  await app.close();
});

test('custom import sanitizes source slugs and assigns hits to unknown country', async () => {
  const store = new MemoryStore();
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/import',
    headers: { 'x-admin-token': 'secret' },
    payload: {
      mode: 'custom',
      records: [
        { row: 2, source: '/snippets/', target: 'https://github.com/Danie10/yaml-snippets', hits: '9', validityDays: '0' },
        { row: 3, source: '/riverlandsmall/', target: 'https://photoshare.gadgeteerza.co.za/share/qlqyAn4QTTo3SHOuv_14TWj5uXzVxQVY_OPK3DoDG-cgmYIMYJRmzOI6g5UBXqJ6v2w', hits: '7', validityDays: '0' },
        { row: 4, source: '/ctpublic/', target: 'https://gadgeteer.co.za/myotherinterests/gadgeteerza-public-photos/places-photo-albums/', hits: '11', validityDays: '0' },
      ],
    },
  });

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.imported, 3);
  assert.equal(body.failed, 0);
  assert.deepEqual(body.rows.map((row) => [row.row, row.code, row.status]), [
    [2, 'snippets', 'imported'],
    [3, 'riverlandsmall', 'imported'],
    [4, 'ctpublic', 'imported'],
  ]);
  assert.equal(await store.get('snippets'), 'https://github.com/Danie10/yaml-snippets');
  assert.equal(store.ttl('snippets'), 0);
  assert.deepEqual(await store.getStats('snippets'), { code: 'snippets', totalClicks: 9, countries: { ZZ: 9 } });
  assert.deepEqual(await store.getStats('ctpublic'), { code: 'ctpublic', totalClicks: 11, countries: { ZZ: 11 } });
  await app.close();
});

test('import reports expired zer0 records without creating them', async () => {
  const store = new MemoryStore();
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/import',
    headers: { 'x-admin-token': 'secret' },
    payload: {
      mode: 'zer0',
      export: {
        app: 'zer0',
        links: [{
          code: 'oldone',
          targetUrl: 'https://example.com/old',
          expiresAt: '2020-01-01T00:00:00.000Z',
        }],
      },
    },
  });

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.imported, 0);
  assert.equal(body.expired, 1);
  assert.equal(await store.get('oldone'), null);
  await app.close();
});

test('admin can make an existing link valid indefinitely', async () => {
  const store = new MemoryStore();
  await store.set('forever2', 'https://example.com/forever', { ttlSeconds: 9 * SECONDS_PER_DAY, validityDays: 9 });
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/admin/links/forever2',
    headers: { authorization: 'Bearer secret' },
    payload: { validityDays: 0 },
  });

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(store.ttl('forever2'), 0);
  assert.equal(body.validityDays, 0);
  assert.equal(body.expiresAt, null);
  assert.equal(body.expiresInDays, null);
  await app.close();
});

test('admin can edit slug destination and validity together', async () => {
  const store = new MemoryStore();
  await store.set('editold', 'https://example.com/old', { ttlSeconds: 5 * SECONDS_PER_DAY, validityDays: 5 });
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret', geolocateIp: () => 'US' });

  assert.equal((await app.inject({ method: 'GET', url: '/editold' })).statusCode, 302);
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/admin/links/editold',
    headers: { 'x-admin-token': 'secret' },
    payload: { code: 'editnew', targetUrl: 'https://example.com/new', validityDays: 0 },
  });
  const oldRedirect = await app.inject({ method: 'GET', url: '/editold' });
  const newRedirect = await app.inject({ method: 'GET', url: '/editnew' });

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.code, 'editnew');
  assert.equal(body.shortUrl, 'http://sho.rt/editnew');
  assert.equal(body.targetUrl, 'https://example.com/new');
  assert.equal(body.validityDays, 0);
  assert.equal(body.expiresAt, null);
  assert.equal(body.expiresInDays, null);
  assert.equal(await store.get('editold'), null);
  assert.equal(await store.get('editnew'), 'https://example.com/new');
  assert.equal(store.ttl('editnew'), 0);
  assert.deepEqual(await store.getStats('editnew'), { code: 'editnew', totalClicks: 2, countries: { US: 2 } });
  assert.equal(oldRedirect.statusCode, 404);
  assert.equal(newRedirect.statusCode, 302);
  assert.equal(newRedirect.headers.location, 'https://example.com/new');
  await app.close();
});

test('admin slug edits reject conflicts without mutating either link', async () => {
  const store = new MemoryStore();
  await store.set('source1', 'https://example.com/source');
  await store.set('taken1', 'https://example.com/taken');
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/admin/links/source1',
    headers: { authorization: 'Bearer secret' },
    payload: { code: 'taken1', targetUrl: 'https://example.com/changed', validityDays: 10 },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), { error: 'Slug already exists' });
  assert.equal(await store.get('source1'), 'https://example.com/source');
  assert.equal(await store.get('taken1'), 'https://example.com/taken');
  await app.close();
});

test('admin page asks for an admin token and fetches all links', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/admin' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /Admin token/);
  assert.match(response.body, /id="admin-token"/);
  assert.match(response.body, /\/api\/admin\/links/);
  assert.match(response.body, /X-Admin-Token/);
  assert.match(response.body, /Total clicks/);
  await app.close();
});

test('admin page inline script is valid JavaScript', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/admin' });
  const script = response.body.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';

  assert.equal(response.statusCode, 200);
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  await app.close();
});

test('admin page redirects token query strings away from the URL', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/admin?token=secret' });

  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, '/admin');
  await app.close();
});

test('admin page formats countries with flags and full names', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/admin' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /formatCountry/);
  assert.match(response.body, /countryName/);
  assert.match(response.body, /South Africa/);
  assert.match(response.body, /Unknown/);
  assert.match(response.body, /🏴‍☠️/);
  await app.close();
});

test('admin page stores the token locally, supports auto-load, pagination, and logout', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/admin' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /localStorage\.setItem\('zer0:adminToken'/);
  assert.match(response.body, /localStorage\.getItem\('zer0:adminToken'/);
  assert.match(response.body, /localStorage\.removeItem\('zer0:adminToken'/);
  assert.match(response.body, /id="logout"/);
  assert.match(response.body, /Previous/);
  assert.match(response.body, /Next/);
  assert.match(response.body, /pageSize/);
  assert.match(response.body, /renderPage/);
  await app.close();
});

test('admin page hides zero country counters and manages authenticated state clearly', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/admin' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /filter\(\(\[_country, count\]\) => Number\(count\) > 0\)/);
  assert.doesNotMatch(response.body, /formatCountry\('ZZ'\) \+ ': 0/);
  assert.match(response.body, /setAuthenticated\(true\)/);
  assert.match(response.body, /setAuthenticated\(false\)/);
  assert.match(response.body, /id="auth-panel"/);
  assert.match(response.body, /hidden/);
  assert.match(response.body, /aria-describedby="admin-token-help"/);
  assert.match(response.body, /aria-busy/);
  assert.match(response.body, /aria-current/);
  await app.close();
});

test('admin page supports confirmed per-link deletion and hides dashboard until authenticated', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/admin' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /id="dashboard-panel"[^>]*hidden/);
  assert.match(response.body, /setAuthenticated\(true\)/);
  assert.match(response.body, /dashboardPanel\.hidden = !isAuthenticated/);
  assert.doesNotMatch(response.body, /Only non-zero country counters are shown\./);
  assert.match(response.body, /class="delete-link danger-button"/);
  assert.match(response.body, /data-code="' \+ escapeAttr\(link\.code\) \+ '"/);
  assert.match(response.body, /confirm\('Delete \/' \+ code \+ '\\?/);
  assert.match(response.body, /fetch\('\/api\/admin\/links\/' \+ encodeURIComponent\(code\)/);
  assert.match(response.body, /method: 'DELETE'/);
  assert.match(response.body, /deleteLink\(code\)/);
  await app.close();
});

test('admin page supports searching and editing per-link fields', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/admin' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /id="link-search"/);
  assert.match(response.body, /matchingLinks/);
  assert.match(response.body, /class="link-edit-form"/);
  assert.match(response.body, /name="code"/);
  assert.match(response.body, /name="targetUrl"/);
  assert.match(response.body, /saveLink/);
  assert.match(response.body, /method: 'PATCH'/);
  assert.match(response.body, /validitySummary/);
  assert.match(response.body, /0 keeps this link valid indefinitely/);
  await app.close();
});

test('admin page exposes import and export controls', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'GET', url: '/admin' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /id="export-data"/);
  assert.match(response.body, /id="toggle-import"/);
  assert.match(response.body, /id="import-mode"/);
  assert.match(response.body, /zer0 export/);
  assert.match(response.body, /Custom CSV/);
  assert.match(response.body, /parseCsv/);
  assert.match(response.body, /\/api\/admin\/export/);
  assert.match(response.body, /\/api\/admin\/import/);
  assert.match(response.body, /Existing slugs will be skipped/);
  assert.match(response.body, /source/);
  assert.match(response.body, /target/);
  assert.match(response.body, /hits/);
  assert.match(response.body, /data-import-manual/);
  assert.match(response.body, /Rows needing attention/);
  await app.close();
});

test('admin can delete one link and clear hot cache', async () => {
  const store = new MemoryStore();
  await store.set('delete1', 'https://example.com/delete');
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  assert.equal((await app.inject({ method: 'GET', url: '/delete1' })).statusCode, 302);
  const deleted = await app.inject({ method: 'DELETE', url: '/api/admin/links/delete1', headers: { 'x-admin-token': 'secret' } });
  const after = await app.inject({ method: 'GET', url: '/delete1' });

  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(JSON.parse(deleted.body), { deleted: 1 });
  assert.equal(after.statusCode, 404);
  await app.close();
});

test('deleted slugs can be reused with fresh stats', async () => {
  const store = new MemoryStore();
  await store.set('reuse1', 'https://example.com/old');
  await store.recordAccess('reuse1', { country: 'US' });
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const deleted = await app.inject({ method: 'DELETE', url: '/api/admin/links/reuse1', headers: { 'x-admin-token': 'secret' } });
  const recreated = await app.inject({ method: 'POST', url: '/api/shorten', payload: { url: 'https://example.com/new', slug: 'reuse1' } });
  const stats = await app.inject({ method: 'GET', url: '/api/stats/reuse1', headers: { 'x-admin-token': 'secret' } });

  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(JSON.parse(deleted.body), { deleted: 1 });
  assert.equal(recreated.statusCode, 201);
  assert.equal(JSON.parse(recreated.body).targetUrl, 'https://example.com/new');
  assert.deepEqual(JSON.parse(stats.body), { code: 'reuse1', totalClicks: 0, countries: {} });
  await app.close();
});

test('admin can delete all links and stats', async () => {
  const store = new MemoryStore();
  await store.set('allone', 'https://example.com/one');
  await store.set('alltwo', 'https://example.com/two');
  await store.recordAccess('allone', { country: 'US' });
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminToken: 'secret' });

  const response = await app.inject({ method: 'DELETE', url: '/api/admin/links', headers: { authorization: 'Bearer secret' } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { deleted: 2 });
  assert.equal(await store.get('allone'), null);
  assert.deepEqual(await store.getStats('allone'), { code: 'allone', totalClicks: 0, countries: {} });
  await app.close();
});

test('admin endpoints require a configured token', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' } });

  const response = await app.inject({ method: 'DELETE', url: '/api/admin/links/abc123' });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { error: 'Admin API is disabled until ADMIN_TOKEN is configured' });
  await app.close();
});

test('admin-only mode requires admin authentication before creating short URLs', async () => {
  const store = new MemoryStore();
  const app = await buildApp({
    store,
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
    adminOnlyMode: true,
    adminToken: 'secret',
  });

  const missingToken = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com/private', slug: 'private1' },
  });
  const wrongToken = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    headers: { 'x-admin-token': 'wrong' },
    payload: { url: 'https://example.com/private', slug: 'private1' },
  });
  const created = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    headers: { 'x-admin-token': 'secret' },
    payload: { url: 'https://example.com/private', slug: 'private1' },
  });
  const redirect = await app.inject({ method: 'GET', url: '/private1' });

  assert.equal(missingToken.statusCode, 401);
  assert.deepEqual(JSON.parse(missingToken.body), { error: 'Unauthorized' });
  assert.equal(wrongToken.statusCode, 401);
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.parse(created.body).shortUrl, 'http://sho.rt/private1');
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, 'https://example.com/private');
  await app.close();
});

test('admin-only mode cannot create links when ADMIN_TOKEN is not configured', async () => {
  const store = new MemoryStore();
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, adminOnlyMode: true });

  const response = await app.inject({ method: 'POST', url: '/api/shorten', payload: { url: 'https://example.com/private', slug: 'private2' } });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { error: 'Admin-only mode requires ADMIN_TOKEN to be configured' });
  assert.equal(await store.get('private2'), null);
  await app.close();
});

test('admin-only homepage gates the creation form behind the admin token', async () => {
  const app = await buildApp({
    store: new MemoryStore(),
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'none' },
    adminOnlyMode: true,
    adminToken: 'secret',
  });

  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Admin-only mode/);
  assert.match(response.body, /id="creation-auth"/);
  assert.match(response.body, /id="admin-token"/);
  assert.match(response.body, /id="creator-panel"[^>]*hidden/);
  assert.match(response.body, /zer0:createAdminToken/);
  assert.match(response.body, /X-Admin-Token/);
  await app.close();
});

test('homepage explains retention, has improved copy button UI, includes a custom slug generator, links the favicon, and has a self-hosting footer', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' }, retentionDays: 30 });

  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Fast, self-hosted URL shortener/);
  assert.match(response.body, /Default link validity is 30 days/);
  assert.match(response.body, /id="validity-days"/);
  assert.match(response.body, /Use 0 to keep this link valid indefinitely/);
  assert.match(response.body, /id="generate-slug"/);
  assert.match(response.body, /copy-short-url/);
  assert.match(response.body, /result-card/);
  assert.match(response.body, /captcha-wrap/);
  assert.match(response.body, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
  assert.match(response.body, /<footer class="site-footer"/);
  assert.match(response.body, /Made with <span class="heart" aria-label="love">❤️<\/span> in Cape Town/);
  assert.match(response.body, /Self-host your own zer0/);
  assert.match(response.body, /href="https:\/\/github\.com\/neoemit\/zer0"/);
  assert.match(response.body, /rel="noopener noreferrer"/);
  await app.close();
});

test('favicon is a stylised zero SVG served by the app', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' } });

  const response = await app.inject({ method: 'GET', url: '/favicon.svg' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /image\/svg\+xml/);
  assert.match(response.body, /<title>zer0 favicon<\/title>/);
  assert.match(response.body, /aria-label="stylised zero favicon"/);
  assert.match(response.body, /linearGradient/);
  assert.match(response.body, />0<\/text>/);
  await app.close();
});

test('missing short URLs render a branded invalid-link page instead of plain not found text', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' } });

  const response = await app.inject({ method: 'GET', url: '/expired-link' });

  assert.equal(response.statusCode, 404);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /<title>Link no longer valid · zer0<\/title>/);
  assert.match(response.body, /This zer0 link is no longer valid/);
  assert.match(response.body, /Ask the person who shared it to create a new zer0 link/);
  assert.match(response.body, /class="zero-mark"/);
  assert.match(response.body, /href="\/favicon\.svg"/);
  assert.doesNotMatch(response.body, /^Not found$/);
  await app.close();
});

test('README documents homepage polish, invalid-link handling, and self-hosting source link', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(readme, /custom slug generator/i);
  assert.match(readme, /branded invalid-link page/i);
  assert.match(readme, /stylised zero favicon/i);
  assert.match(readme, /Made with ❤️ in Cape Town/i);
  assert.match(readme, /Self-host your own zer0/i);
  assert.match(readme, /https:\/\/github\.com\/neoemit\/zer0/);
});

test('docs and examples document ADMIN_ONLY_MODE creation gating', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');

  assert.match(readme, /ADMIN_ONLY_MODE/);
  assert.match(readme, /Only visitors with the admin token can create short URLs/i);
  assert.match(readme, /Redirects stay public/i);
  assert.match(envExample, /ADMIN_ONLY_MODE=false/);
  assert.match(compose, /ADMIN_ONLY_MODE: \$\{ADMIN_ONLY_MODE:-false\}/);
});

test('docs and GitHub files define automated PR release notes', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const template = await readFile(new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/pr-release-notes.yml', import.meta.url), 'utf8');
  const releaseConfig = await readFile(new URL('../.github/release.yml', import.meta.url), 'utf8');

  assert.match(readme, /release notes/i);
  assert.match(template, /## Release notes/);
  assert.match(workflow, /PR release notes/);
  assert.match(workflow, /GITHUB_EVENT_PATH/);
  assert.match(releaseConfig, /Breaking Changes/);
  assert.match(releaseConfig, /Features/);
  assert.match(releaseConfig, /Other Changes/);
});

test('README documents admin import and export', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(readme, /\/api\/admin\/export/);
  assert.match(readme, /\/api\/admin\/import/);
  assert.match(readme, /Custom CSV/i);
  assert.match(readme, /Existing slugs are skipped/i);
  assert.match(readme, /zer0 export/i);
});

test('custom slug creation rejects slugs that already exist', async () => {
  const store = new MemoryStore();
  await store.set('taken', 'https://example.com/original');
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' } });

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com/new', slug: 'taken' },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), { error: 'Slug already exists' });
  assert.equal(await store.get('taken'), 'https://example.com/original');
  await app.close();
});

test('custom slug creation rejects slugs that are too long', async () => {
  const app = await buildApp({ store: new MemoryStore(), publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' } });

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com/new', slug: 'x'.repeat(49) },
  });

  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /3-48 characters/);
  await app.close();
});

test('redirect path is a direct cache/store lookup and returns Location without body work', async () => {
  const store = new MemoryStore();
  await store.set('gogo', 'https://example.com/fast');
  const app = await buildApp({ store, publicBaseUrl: 'http://sho.rt', captcha: { provider: 'none' } });

  const response = await app.inject({ method: 'GET', url: '/gogo' });

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, 'https://example.com/fast');
  await app.close();
});

test('creation requires captcha token when Turnstile is configured', async () => {
  const app = await buildApp({
    store: new MemoryStore(),
    publicBaseUrl: 'http://sho.rt',
    captcha: { provider: 'turnstile', secretKey: 'secret' },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/shorten',
    payload: { url: 'https://example.com' },
  });

  assert.equal(response.statusCode, 403);
  await app.close();
});
