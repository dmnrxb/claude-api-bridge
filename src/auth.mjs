import { hashApiKey } from './secrets.mjs';

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

export class RateLimitError extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.status = 429;
    this.retryAfter = retryAfterSeconds;
  }
}

// OpenAI clients send `Authorization: Bearer`. Anthropic clients send
// `x-api-key`. Both are accepted so the bridge drops into either kind of tool
// without a wrapper.
export function readKey(headers) {
  const bearer = headers.authorization ?? headers.Authorization;
  if (typeof bearer === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(bearer.trim());
    if (match) return match[1].trim();
  }
  const direct = headers['x-api-key'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return null;
}

export function authenticate(store, headers) {
  const presented = readKey(headers);
  if (!presented) {
    throw new AuthError('missing API key, send it as "Authorization: Bearer <key>" or "x-api-key: <key>"');
  }

  const row = store.findKeyByHash(hashApiKey(presented));
  if (!row) throw new AuthError('unknown API key');
  if (row.disabled) throw new AuthError('this API key is disabled', 403);

  return row;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

// Both windows roll: rpm counts the last 60 seconds, rpd the last 24 hours.
// No midnight reset to be surprised by.
export function enforceLimits(store, key) {
  if (key.rpm) {
    const used = store.countKeyRequests(key.id, MINUTE);
    if (used >= key.rpm) {
      throw new RateLimitError(`rate limit reached for key "${key.name}": ${key.rpm} requests per minute`, 60);
    }
  }
  if (key.rpd) {
    const used = store.countKeyRequests(key.id, DAY);
    if (used >= key.rpd) {
      throw new RateLimitError(`daily limit reached for key "${key.name}": ${key.rpd} requests per 24 hours`, 3600);
    }
  }
}
