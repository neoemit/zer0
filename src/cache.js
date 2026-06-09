export class HotCache {
  constructor({ maxEntries = 100_000, ttlMs = 300_000 } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.items.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value) {
    if (this.items.size >= this.maxEntries) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    this.items.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key) {
    this.items.delete(key);
  }

  clear() {
    this.items.clear();
  }
}
