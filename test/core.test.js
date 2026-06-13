import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALPHABET,
  captchaCanBeSkipped,
  makeCode,
  normalizeTargetUrl,
  sanitizeCustomSlug,
  validateCustomSlug,
} from '../src/core.js';
import { loadConfig } from '../src/config.js';

test('normalizes http and https target URLs', () => {
  assert.equal(normalizeTargetUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(normalizeTargetUrl('  http://example.com  '), 'http://example.com/');
});

test('preserves URL fragments because some target apps encode required state there', () => {
  const openWebRxUrl = 'https://openwebrx.gadgeteerza.co.za/#freq=145700000,mod=nfm,sql=-150';

  assert.equal(normalizeTargetUrl(openWebRxUrl), openWebRxUrl);
});

test('rejects URLs that are dangerous or invalid for redirectors', () => {
  for (const input of [
    '',
    'not a url',
    'ftp://example.com/file',
    'javascript:alert(1)',
    'https://',
    'http://localhost/admin',
    'http://127.0.0.1/admin',
    'http://[::1]/admin',
  ]) {
    assert.throws(() => normalizeTargetUrl(input), undefined, `${input} should be rejected`);
  }
});

test('validates custom slugs for safe routing', () => {
  for (const slug of ['abc', 'A-Z_09', 'hello-world', 'x_y']) {
    assert.equal(validateCustomSlug(slug), slug);
  }

  for (const slug of ['', 'ab', 'a/b', '..', 'admin', 'api', 'hello world', 'x.y', 'this-slug-is-way-too-long-for-the-router-and-cache']) {
    assert.throws(() => validateCustomSlug(slug), undefined, `${slug} should be rejected`);
  }
});

test('sanitizes imported slugs by keeping only routable characters', () => {
  assert.equal(sanitizeCustomSlug('/snippets/'), 'snippets');
  assert.equal(sanitizeCustomSlug(' /Cape Town_2026! '), 'CapeTown_2026');
});

test('generated codes have expected length and URL-safe alphabet', () => {
  const code = makeCode(10);
  assert.equal(code.length, 10);
  assert.ok([...code].every((ch) => ALPHABET.includes(ch)));
});

test('captcha secret controls creation policy', () => {
  assert.equal(captchaCanBeSkipped({ provider: 'none' }), true);
  assert.equal(captchaCanBeSkipped({ provider: 'turnstile', secretKey: 'secret' }), false);
  assert.equal(captchaCanBeSkipped({ provider: 'turnstile' }), false);
});

test('retention config is unlimited by default or when set to 0', () => {
  assert.equal(loadConfig({}).retentionDays, 0);
  assert.equal(loadConfig({ RETENTION_DAYS: '0' }).retentionDays, 0);
  assert.equal(loadConfig({ RETENTION_DAYS: '90' }).retentionDays, 90);
});

test('admin-only mode is enabled only by an explicit true boolean env value', () => {
  assert.equal(loadConfig({}).adminOnlyMode, false);
  assert.equal(loadConfig({ ADMIN_ONLY_MODE: 'false' }).adminOnlyMode, false);
  assert.equal(loadConfig({ ADMIN_ONLY_MODE: 'true' }).adminOnlyMode, true);
});
