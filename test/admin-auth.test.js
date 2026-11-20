import test from 'node:test';
import assert from 'node:assert/strict';

import { createAdminAuthLimiter, tokensMatch } from '../src/admin-auth.js';

test('tokensMatch accepts only the exact configured token', () => {
  assert.equal(tokensMatch('secret', 'secret'), true);
  assert.equal(tokensMatch('secreT', 'secret'), false);
  assert.equal(tokensMatch('secret-but-longer', 'secret'), false);
  assert.equal(tokensMatch('', 'secret'), false);
  assert.equal(tokensMatch(undefined, 'secret'), false);
  assert.equal(tokensMatch(123, '123'), false);
  assert.equal(tokensMatch({ toString: () => 'secret' }, 'secret'), false);
  assert.equal(tokensMatch('', ''), false);
});

test('limiter locks a key out after max failures until its window ends', () => {
  let time = 1_000_000;
  const limiter = createAdminAuthLimiter({ max: 3, windowMs: 60_000, now: () => time });

  for (let attempt = 0; attempt < 2; attempt += 1) limiter.recordFailure('1.1.1.1');
  assert.equal(limiter.retryAfterSeconds('1.1.1.1'), 0);

  limiter.recordFailure('1.1.1.1');
  assert.equal(limiter.retryAfterSeconds('1.1.1.1'), 60);
  assert.equal(limiter.retryAfterSeconds('2.2.2.2'), 0);

  time += 59_500;
  assert.equal(limiter.retryAfterSeconds('1.1.1.1'), 1);

  time += 500;
  assert.equal(limiter.retryAfterSeconds('1.1.1.1'), 0);
  assert.equal(limiter.size, 0);
});

test('limiter starts a fresh window after the previous one expires', () => {
  let time = 0;
  const limiter = createAdminAuthLimiter({ max: 2, windowMs: 1_000, now: () => time });

  limiter.recordFailure('ip');
  time = 1_000;
  limiter.recordFailure('ip');
  assert.equal(limiter.retryAfterSeconds('ip'), 0, 'a failure from an expired window must not count');

  limiter.recordFailure('ip');
  assert.equal(limiter.retryAfterSeconds('ip'), 1);
});

test('limiter prunes expired keys as new ones arrive', () => {
  let time = 0;
  const limiter = createAdminAuthLimiter({ max: 5, windowMs: 1_000, now: () => time });

  for (let index = 0; index < 50; index += 1) limiter.recordFailure(`old-${index}`);
  assert.equal(limiter.size, 50);

  time = 2_000;
  limiter.recordFailure('new');
  assert.equal(limiter.size, 1);
});

test('limiter with max 0 is disabled and invalid settings fall back to defaults', () => {
  const disabled = createAdminAuthLimiter({ max: 0 });
  for (let attempt = 0; attempt < 100; attempt += 1) disabled.recordFailure('ip');
  assert.equal(disabled.retryAfterSeconds('ip'), 0);
  assert.equal(disabled.size, 0);

  let time = 0;
  const fallback = createAdminAuthLimiter({ max: 'nope', windowMs: '-5', now: () => time });
  for (let attempt = 0; attempt < 9; attempt += 1) fallback.recordFailure('ip');
  assert.equal(fallback.retryAfterSeconds('ip'), 0);
  fallback.recordFailure('ip');
  assert.equal(fallback.retryAfterSeconds('ip'), 15 * 60);
});
