import Redis from 'ioredis';

const DEFAULT_RETENTION_SECONDS = 0;
const CODE_INDEX_KEY = 'idx:codes';

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

  async set(code, url, ttlSeconds = DEFAULT_RETENTION_SECONDS) {
    const ttl = normalizeTtlSeconds(ttlSeconds);
    const result = ttl > 0
      ? await this.redis.set(urlKey(code), url, 'EX', ttl, 'NX')
      : await this.redis.set(urlKey(code), url, 'NX');
    if (result !== 'OK') return false;

    const createdAt = new Date().toISOString();
    const pipeline = this.redis.pipeline()
      .sadd(CODE_INDEX_KEY, code)
      .hset(metaKey(code), { code, targetUrl: url, createdAt });
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
      const [targetUrl, metadata, stats] = await Promise.all([
        this.redis.get(urlKey(code)),
        this.redis.hgetall(metaKey(code)),
        this.getStats(code),
      ]);
      if (!targetUrl) {
        await this.redis.srem(CODE_INDEX_KEY, code);
        continue;
      }
      links.push({
        code,
        targetUrl: metadata.targetUrl || targetUrl,
        ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {}),
        stats,
      });
    }

    return links;
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
}

function normalizeTtlSeconds(ttlSeconds) {
  const ttl = Math.floor(Number(ttlSeconds) || DEFAULT_RETENTION_SECONDS);
  return ttl > 0 ? ttl : 0;
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
