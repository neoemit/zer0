import { createHash, timingSafeEqual } from 'node:crypto';

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_KEYS = 100_000;

/**
 * Compare a provided admin token with the configured one in constant time.
 * Both values are hashed first so the comparison never leaks the expected length.
 */
export function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Tracks failed admin authentication attempts per client key (the request IP).
 * Once a key reaches `max` failures inside `windowMs`, it is locked out until the
 * window that started with its first failure ends. `max: 0` disables the limiter.
 */
export function createAdminAuthLimiter({ max = DEFAULT_MAX_FAILURES, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
  const maxFailures = normalizePositiveInteger(max, DEFAULT_MAX_FAILURES, { allowZero: true });
  const window = normalizePositiveInteger(windowMs, DEFAULT_WINDOW_MS);
  const failures = new Map();

  // Every entry gets the same window and is (re)inserted when it starts, so Map insertion
  // order is also resetAt order: expired entries are always at the front.
  function prune(time) {
    for (const [key, entry] of failures) {
      if (entry.resetAt > time && failures.size < MAX_TRACKED_KEYS) break;
      failures.delete(key);
    }
  }

  return {
    /** Seconds until `key` may try again, or 0 when it is not locked out. */
    retryAfterSeconds(key) {
      if (maxFailures === 0) return 0;
      const entry = failures.get(key);
      if (!entry) return 0;
      const time = now();
      if (entry.resetAt <= time) {
        failures.delete(key);
        return 0;
      }
      return entry.count >= maxFailures ? Math.max(1, Math.ceil((entry.resetAt - time) / 1000)) : 0;
    },

    recordFailure(key) {
      if (maxFailures === 0) return;
      const time = now();
      let entry = failures.get(key);
      if (!entry || entry.resetAt <= time) {
        failures.delete(key);
        prune(time);
        entry = { count: 0, resetAt: time + window };
        failures.set(key, entry);
      }
      entry.count += 1;
    },

    get size() {
      return failures.size;
    },
  };
}

function normalizePositiveInteger(value, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  const floored = Math.floor(parsed);
  if (floored === 0 && !allowZero) return fallback;
  return floored;
}
