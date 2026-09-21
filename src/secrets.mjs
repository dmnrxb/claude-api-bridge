import {
  createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';

// Account tokens are encrypted so the database file alone does not give them
// away. Whoever can read BRIDGE_SECRET_KEY can still decrypt them.

const KEY_CACHE = new Map();

function derive(secret) {
  let key = KEY_CACHE.get(secret);
  if (!key) {
    key = scryptSync(secret, 'claude-api-bridge/account-token', 32);
    KEY_CACHE.set(secret, key);
  }
  return key;
}

export function encryptToken(plain, secret) {
  if (!secret) throw new Error('no secret key configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function decryptToken(blob, secret) {
  if (!secret) throw new Error('no secret key configured');
  const [version, iv, tag, body] = String(blob).split(':');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('stored token is not readable');
  const decipher = createDecipheriv('aes-256-gcm', derive(secret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

// API keys are stored as a hash and shown once.

export function newApiKey() {
  return `cb-${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function keyPrefix(key) {
  return `${key.slice(0, 11)}...`;
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// Keep tokens out of logs and error messages.
export function redact(text) {
  if (!text) return text;
  return String(text)
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
    .replace(/cb-[A-Za-z0-9_-]{8,}/g, 'cb-***');
}
