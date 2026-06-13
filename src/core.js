import { customAlphabet } from 'nanoid';

export const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DEFAULT_CODE_LENGTH = 7;
export const SLUG_PATTERN = /^[A-Za-z0-9_-]{3,48}$/;
export const RESERVED_SLUGS = new Set(['api', 'admin', 'assets', 'healthz', 'metrics', 'new']);

const createId = customAlphabet(ALPHABET, DEFAULT_CODE_LENGTH);

export function normalizeTargetUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('URL is required');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('URL is invalid');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed');
  }

  if (!parsed.hostname || isBlockedHostname(parsed.hostname)) {
    throw new Error('That host is not allowed');
  }

  return parsed.toString();
}

export function validateCustomSlug(slug) {
  const value = String(slug ?? '').trim();
  if (!SLUG_PATTERN.test(value)) {
    throw new Error('Slug must be 3-48 characters of letters, numbers, underscores, or dashes');
  }
  if (RESERVED_SLUGS.has(value.toLowerCase())) {
    throw new Error('That slug is reserved');
  }
  return value;
}

export function sanitizeCustomSlug(slug) {
  return String(slug ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
}

export function makeCode(length = DEFAULT_CODE_LENGTH) {
  if (!Number.isInteger(length) || length < 3 || length > 48) {
    throw new Error('Invalid code length');
  }
  return length === DEFAULT_CODE_LENGTH ? createId() : customAlphabet(ALPHABET, length)();
}

export function captchaCanBeSkipped(captcha) {
  return !captcha || captcha.provider === 'none';
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  if (host.endsWith('.localhost')) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(host) || /^fd[0-9a-f]{2}:/i.test(host)) return true;
  return false;
}
