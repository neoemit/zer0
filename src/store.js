import Redis from 'ioredis';

const DEFAULT_RETENTION_SECONDS = 0;
const CODE_INDEX_KEY = 'idx:codes';
const SECONDS_PER_DAY = 24 * 60 * 60;

export class RedisStore {
  constructor(redis) {
    this.redis = redis;
  }

  static fromUrl(url) {
    return new RedisStore(new Redis(url, {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    }));
  }

  async get(code) {
    return this.redis.get(urlKey(code));
  }

  async set(code, url, options = DEFAULT_RETENTION_SECONDS) {
    const { ttl, validityDays, expiresAt } = normalizeSetOptions(options);
    const result = ttl > 0
      ? await this.redis.set(urlKey(code), url, 'EX', ttl, 'NX')
      : await this.redis.set(urlKey(code), url, 'NX');
    if (result !== 'OK') return false;

    const createdAt = new Date().toISOString();
    const metadata = { code, targetUrl: url, createdAt, validityDays };
    if (expiresAt) metadata.expiresAt = expiresAt;
    const pipeline = this.redis.pipeline()
      .sadd(CODE_INDEX_KEY, code)
      .hset(metaKey(code), metadata);
    if (ttl > 0) pipeline.expire(metaKey(code), ttl);
    await pipeline.exec();
    return true;
  }

  async recordAccess(code, { country = 'ZZ' } = {}) {
    const normalizedCountry = normalizeCountry(country);
    const key = statsKey(code);
    const pipeline = this.redis.pipeline()
      .hincrby(key, 'total', 1)
      .hincrby(key, `country:${normalizedCountry}`, 1);

    const ttl = await this.redis.ttl(urlKey(code));
    if (ttl > 0) pipeline.expire(key, ttl);
    await pipeline.exec();
  }

  async getStats(code) {
    const stats = await this.redis.hgetall(statsKey(code));
    const countries = {};
    let totalClicks = 0;

    for (const [key, value] of Object.entries(stats)) {
      const count = Number(value) || 0;
      if (key === 'total') {
        totalClicks = count;
      } else if (key.startsWith('country:')) {
        countries[key.slice('country:'.length)] = count;
      }
    }

    return { code, totalClicks, countries };
  }

  async listLinks() {
    const codes = new Set(await this.redis.smembers(CODE_INDEX_KEY));
    for await (const keys of this.redis.scanStream({ match: 'u:*', count: 500 })) {
      for (const key of keys) codes.add(key.slice(2));
    }

    const links = [];
    for (const code of [...codes].sort((left, right) => left.localeCompare(right))) {
      const [targetUrl, metadata, stats, ttl] = await Promise.all([
        this.redis.get(urlKey(code)),
        this.redis.hgetall(metaKey(code)),
        this.getStats(code),
        this.redis.ttl(urlKey(code)),
      ]);
      if (!targetUrl) {
        await this.redis.srem(CODE_INDEX_KEY, code);
        continue;
      }
      links.push(buildLink({
        code,
        targetUrl: metadata.targetUrl || targetUrl,
        metadata,
        stats,
        ttl,
      }));
    }

    return links;
  }

  async exportLinks() {
    return this.listLinks();
  }

  async importLinks(records = []) {
    const rows = [];
    for (const record of records) {
      const row = Number(record.row) || rows.length + 1;
      const code = String(record.code || '');
      const targetUrl = String(record.targetUrl || '');
      const importOptions = normalizeImportOptions(record);
      if (importOptions.expired) {
        rows.push({ row, code, status: 'expired', reason: 'Link expiry is in the past' });
        continue;
      }

      const created = await this.writeImportedLink({ code, targetUrl, ...importOptions });
      if (!created) {
        rows.push({ row, code, status: 'skipped', reason: 'Slug already exists' });
        continue;
      }
      rows.push({ row, code, status: 'imported' });
    }

    return summarizeImportRows(rows);
  }

  async updateValidity(code, validityDays) {
    return this.updateLink(code, { validityDays });
  }

  async updateLink(code, updates = {}) {
    const targetUrl = await this.redis.get(urlKey(code));
    if (!targetUrl) return null;

    const [existingMetadata, statsFields, currentTtl] = await Promise.all([
      this.redis.hgetall(metaKey(code)),
      this.redis.hgetall(statsKey(code)),
      this.redis.ttl(urlKey(code)),
    ]);
    const nextCode = String(updates.code || code);
    const isRenaming = nextCode !== code;
    if (isRenaming && await this.redis.exists(urlKey(nextCode))) {
      return { conflict: true };
    }

    const nextTargetUrl = Object.hasOwn(updates, 'targetUrl') ? String(updates.targetUrl) : targetUrl;
    const validityWasUpdated = Object.hasOwn(updates, 'validityDays');
    const ttl = validityWasUpdated
      ? validityDaysToTtl(updates.validityDays)
      : normalizeTtlSeconds(currentTtl);
    const normalizedDays = validityWasUpdated
      ? normalizeValidityDays(updates.validityDays)
      : normalizeValidityDays(existingMetadata.validityDays ?? (ttl > 0 ? Math.ceil(ttl / SECONDS_PER_DAY) : 0));
    const expiresAt = ttl > 0
      ? (validityWasUpdated ? new Date(Date.now() + ttl * 1000).toISOString() : existingMetadata.expiresAt || new Date(Date.now() + ttl * 1000).toISOString())
      : null;
    const metadata = { code: nextCode, targetUrl: nextTargetUrl, validityDays: normalizedDays };
    if (existingMetadata.createdAt) metadata.createdAt = existingMetadata.createdAt;
    if (expiresAt) metadata.expiresAt = expiresAt;

    if (isRenaming) {
      const created = ttl > 0
        ? await this.redis.set(urlKey(nextCode), nextTargetUrl, 'EX', ttl, 'NX')
        : await this.redis.set(urlKey(nextCode), nextTargetUrl, 'NX');
      if (created !== 'OK') return { conflict: true };

      const pipeline = this.redis.pipeline()
        .srem(CODE_INDEX_KEY, code)
        .sadd(CODE_INDEX_KEY, nextCode)
        .del(urlKey(code), metaKey(code), statsKey(code))
        .hset(metaKey(nextCode), metadata);
      if (Object.keys(statsFields).length > 0) pipeline.hset(statsKey(nextCode), statsFields);
      if (ttl > 0) {
        pipeline
          .expire(metaKey(nextCode), ttl)
          .expire(statsKey(nextCode), ttl);
      }
      await pipeline.exec();
    } else {
      const pipeline = this.redis.pipeline()
        .hset(metaKey(code), metadata);
      if (ttl > 0) {
        pipeline
          .set(urlKey(code), nextTargetUrl, 'EX', ttl)
          .expire(metaKey(code), ttl)
          .expire(statsKey(code), ttl);
      } else {
        pipeline
          .set(urlKey(code), nextTargetUrl)
          .persist(metaKey(code))
          .persist(statsKey(code))
          .hdel(metaKey(code), 'expiresAt');
      }
      await pipeline.exec();
    }

    const [metadataAfter, stats, remainingTtl] = await Promise.all([
      this.redis.hgetall(metaKey(nextCode)),
      this.getStats(nextCode),
      this.redis.ttl(urlKey(nextCode)),
    ]);
    return buildLink({
      code: nextCode,
      targetUrl: nextTargetUrl,
      metadata: metadataAfter,
      stats,
      ttl: remainingTtl,
    });
  }

  async delete(code) {
    const existed = await this.redis.exists(urlKey(code));
    await this.redis.del(urlKey(code), metaKey(code), statsKey(code));
    await this.redis.srem(CODE_INDEX_KEY, code);
    return existed > 0;
  }

  async deleteAll() {
    const codes = new Set(await this.redis.smembers(CODE_INDEX_KEY));
    for await (const key of this.redis.scanStream({ match: 'u:*', count: 500 })) {
      for (const item of key) codes.add(item.slice(2));
    }

    if (codes.size === 0) {
      await this.redis.del(CODE_INDEX_KEY);
      return 0;
    }

    let deletedLinks = 0;
    const pipeline = this.redis.pipeline();
    for (const code of codes) {
      if (await this.redis.exists(urlKey(code))) deletedLinks += 1;
      pipeline.del(urlKey(code), metaKey(code), statsKey(code));
    }
    pipeline.del(CODE_INDEX_KEY);
    await pipeline.exec();
    return deletedLinks;
  }

  async close() {
    this.redis.disconnect();
  }

  async writeImportedLink({ code, targetUrl, createdAt, validityDays, expiresAt, ttl, stats }) {
    const result = ttl > 0
      ? await this.redis.set(urlKey(code), targetUrl, 'EX', ttl, 'NX')
      : await this.redis.set(urlKey(code), targetUrl, 'NX');
    if (result !== 'OK') return false;

    const metadata = { code, targetUrl, createdAt, validityDays };
    if (expiresAt) metadata.expiresAt = expiresAt;
    const pipeline = this.redis.pipeline()
      .sadd(CODE_INDEX_KEY, code)
      .hset(metaKey(code), metadata);

    const statsFields = serializeStatsFields(stats);
    if (Object.keys(statsFields).length > 0) {
      pipeline.hset(statsKey(code), statsFields);
    }

    if (ttl > 0) {
      pipeline
        .expire(metaKey(code), ttl)
        .expire(statsKey(code), ttl);
    }

    await pipeline.exec();
    return true;
  }
}

function buildLink({ code, targetUrl, metadata = {}, stats, ttl }) {
  const expiry = deriveExpiry(metadata, ttl);
  return {
    code,
    targetUrl: metadata.targetUrl || targetUrl,
    ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {}),
    validityDays: expiry.validityDays,
    expiresAt: expiry.expiresAt,
    expiresInDays: expiry.expiresInDays,
    stats,
  };
}

function deriveExpiry(metadata, ttl) {
  const remainingTtl = normalizeTtlSeconds(ttl);
  if (remainingTtl > 0) {
    return {
      validityDays: normalizeValidityDays(metadata.validityDays) || Math.ceil(remainingTtl / SECONDS_PER_DAY),
      expiresAt: metadata.expiresAt || new Date(Date.now() + remainingTtl * 1000).toISOString(),
      expiresInDays: Math.ceil(remainingTtl / SECONDS_PER_DAY),
    };
  }

  return {
    validityDays: normalizeValidityDays(metadata.validityDays),
    expiresAt: null,
    expiresInDays: null,
  };
}

function normalizeSetOptions(options = DEFAULT_RETENTION_SECONDS) {
  if (options && typeof options === 'object') {
    const ttl = normalizeTtlSeconds(options.ttlSeconds);
    return {
      ttl,
      validityDays: normalizeValidityDays(options.validityDays ?? (ttl > 0 ? Math.ceil(ttl / SECONDS_PER_DAY) : 0)),
      expiresAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null,
    };
  }

  const ttl = normalizeTtlSeconds(options);
  return {
    ttl,
    validityDays: ttl > 0 ? Math.ceil(ttl / SECONDS_PER_DAY) : 0,
    expiresAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null,
  };
}

function normalizeImportOptions(record) {
  const createdAt = normalizeIsoDate(record.createdAt) || new Date().toISOString();
  const requestedDays = normalizeValidityDays(record.validityDays);
  const requestedExpiry = normalizeIsoDate(record.expiresAt);
  if (requestedExpiry) {
    const ttl = Math.floor((Date.parse(requestedExpiry) - Date.now()) / 1000);
    if (ttl <= 0) {
      return { expired: true };
    }
    return {
      createdAt,
      validityDays: requestedDays || Math.ceil(ttl / SECONDS_PER_DAY),
      expiresAt: requestedExpiry,
      ttl,
      stats: normalizeStats(record.stats),
    };
  }

  const ttl = requestedDays > 0 ? requestedDays * SECONDS_PER_DAY : 0;
  return {
    createdAt,
    validityDays: requestedDays,
    expiresAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null,
    ttl,
    stats: normalizeStats(record.stats),
  };
}

function normalizeIsoDate(value) {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
}

function normalizeStats(stats = {}) {
  const totalClicks = Math.max(0, Math.floor(Number(stats.totalClicks) || 0));
  const countries = {};
  for (const [country, count] of Object.entries(stats.countries || {})) {
    const normalizedCountry = normalizeCountry(country);
    const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
    if (normalizedCount > 0) countries[normalizedCountry] = (countries[normalizedCountry] || 0) + normalizedCount;
  }
  return { totalClicks, countries };
}

function serializeStatsFields(stats = {}) {
  const fields = {};
  if (Number(stats.totalClicks) > 0) fields.total = Math.floor(Number(stats.totalClicks));
  for (const [country, count] of Object.entries(stats.countries || {})) {
    const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
    if (normalizedCount > 0) fields[`country:${normalizeCountry(country)}`] = normalizedCount;
  }
  return fields;
}

function summarizeImportRows(rows) {
  return {
    imported: rows.filter((row) => row.status === 'imported').length,
    skipped: rows.filter((row) => row.status === 'skipped').length,
    expired: rows.filter((row) => row.status === 'expired').length,
    failed: rows.filter((row) => row.status === 'error').length,
    rows,
  };
}

function normalizeTtlSeconds(ttlSeconds) {
  const ttl = Math.floor(Number(ttlSeconds) || DEFAULT_RETENTION_SECONDS);
  return ttl > 0 ? ttl : 0;
}

function validityDaysToTtl(validityDays) {
  const days = normalizeValidityDays(validityDays);
  return days > 0 ? days * SECONDS_PER_DAY : 0;
}

function normalizeValidityDays(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeCountry(country) {
  const value = String(country || 'ZZ').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : 'ZZ';
}

function urlKey(code) {
  return `u:${code}`;
}

function metaKey(code) {
  return `m:${code}`;
}

function statsKey(code) {
  return `s:${code}`;
}
