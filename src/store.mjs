import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { config } from './config.mjs';
import { encryptToken, decryptToken, hashApiKey, keyPrefix, newApiKey } from './secrets.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  key_hash     TEXT    NOT NULL UNIQUE,
  key_prefix   TEXT    NOT NULL,
  rpm          INTEGER,
  rpd          INTEGER,
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  token_enc      TEXT    NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 100,
  disabled       INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  last_used_at   INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY,
  ts            INTEGER NOT NULL,
  key_id        INTEGER,
  account_id    INTEGER,
  model         TEXT,
  stream        INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  status        INTEGER NOT NULL,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS requests_ts_idx  ON requests (ts);
CREATE INDEX IF NOT EXISTS requests_key_idx ON requests (key_id, ts);
`;

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // -- api keys ------------------------------------------------------------

  createKey({ name, rpm = null, rpd = null }) {
    const key = newApiKey();
    this.db.prepare(
      `INSERT INTO api_keys (name, key_hash, key_prefix, rpm, rpd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(name, hashApiKey(key), keyPrefix(key), rpm, rpd, Date.now());
    return { key, name };
  }

  listKeys() {
    return this.db.prepare('SELECT * FROM api_keys ORDER BY name').all();
  }

  getKeyByName(name) {
    return this.db.prepare('SELECT * FROM api_keys WHERE name = ?').get(name) ?? null;
  }

  findKeyByHash(hash) {
    return this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash) ?? null;
  }

  setKeyEnabled(name, enabled) {
    return this.db.prepare('UPDATE api_keys SET disabled = ? WHERE name = ?')
      .run(enabled ? 0 : 1, name).changes;
  }

  setKeyLimits(name, { rpm, rpd }) {
    return this.db.prepare('UPDATE api_keys SET rpm = ?, rpd = ? WHERE name = ?')
      .run(rpm, rpd, name).changes;
  }

  deleteKey(name) {
    return this.db.prepare('DELETE FROM api_keys WHERE name = ?').run(name).changes;
  }

  touchKey(id, at = Date.now()) {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  countKeyRequests(keyId, sinceMs, now = Date.now()) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE key_id = ? AND ts > ?')
      .get(keyId, now - sinceMs);
    return row?.n ?? 0;
  }

  // -- accounts ------------------------------------------------------------

  addAccount({ name, token, priority = 100 }, secret = config.secretKey) {
    this.db.prepare(
      `INSERT INTO accounts (name, token_enc, priority, created_at) VALUES (?, ?, ?, ?)`,
    ).run(name, encryptToken(token, secret), priority, Date.now());
  }

  listAccounts() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY priority, name').all();
  }

  getAccountByName(name) {
    return this.db.prepare('SELECT * FROM accounts WHERE name = ?').get(name) ?? null;
  }

  accountToken(row, secret = config.secretKey) {
    return decryptToken(row.token_enc, secret);
  }

  setAccountToken(name, token, secret = config.secretKey) {
    return this.db.prepare('UPDATE accounts SET token_enc = ?, cooldown_until = 0, last_error = NULL WHERE name = ?')
      .run(encryptToken(token, secret), name).changes;
  }

  setAccountEnabled(name, enabled) {
    return this.db.prepare('UPDATE accounts SET disabled = ?, cooldown_until = 0 WHERE name = ?')
      .run(enabled ? 0 : 1, name).changes;
  }

  setAccountPriority(name, priority) {
    return this.db.prepare('UPDATE accounts SET priority = ? WHERE name = ?').run(priority, name).changes;
  }

  deleteAccount(name) {
    return this.db.prepare('DELETE FROM accounts WHERE name = ?').run(name).changes;
  }

  // Accounts that are enabled and not parked, best first.
  availableAccounts(now = Date.now()) {
    return this.db.prepare(
      `SELECT * FROM accounts
        WHERE disabled = 0 AND cooldown_until <= ?
        ORDER BY priority ASC, COALESCE(last_used_at, 0) ASC, id ASC`,
    ).all(now);
  }

  markAccountUsed(id, at = Date.now()) {
    this.db.prepare('UPDATE accounts SET last_used_at = ?, last_error = NULL WHERE id = ?').run(at, id);
  }

  parkAccount(id, reason, untilMs) {
    this.db.prepare('UPDATE accounts SET cooldown_until = ?, last_error = ? WHERE id = ?')
      .run(untilMs, reason ? String(reason).slice(0, 500) : null, id);
  }

  clearCooldowns() {
    return this.db.prepare('UPDATE accounts SET cooldown_until = 0, last_error = NULL').run().changes;
  }

  // -- requests ------------------------------------------------------------

  recordRequest(row) {
    this.db.prepare(
      `INSERT INTO requests
         (ts, key_id, account_id, model, stream, input_tokens, output_tokens,
          cost_usd, duration_ms, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.ts ?? Date.now(),
      row.keyId ?? null,
      row.accountId ?? null,
      row.model ?? null,
      row.stream ? 1 : 0,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      row.costUsd ?? 0,
      row.durationMs ?? 0,
      row.status,
      row.error ? String(row.error).slice(0, 500) : null,
    );
  }

  summary({ sinceMs, keyName = null, model = null }) {
    const where = ['ts > ?'];
    const args = [Date.now() - sinceMs];
    if (keyName) {
      where.push('key_id = (SELECT id FROM api_keys WHERE name = ?)');
      args.push(keyName);
    }
    if (model) {
      where.push('model = ?');
      args.push(model);
    }
    const clause = where.join(' AND ');

    const totals = this.db.prepare(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_usd), 0)      AS cost_usd,
              COALESCE(AVG(duration_ms), 0)   AS avg_ms
         FROM requests WHERE ${clause}`,
    ).get(...args);

    const byKey = this.db.prepare(
      `SELECT COALESCE(k.name, '(deleted)') AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(r.input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
              COALESCE(SUM(r.cost_usd), 0)      AS cost_usd
         FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
        WHERE ${clause}
        GROUP BY r.key_id ORDER BY requests DESC`,
    ).all(...args);

    const byModel = this.db.prepare(
      `SELECT COALESCE(model, '(none)') AS model,
              COUNT(*) AS requests,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_usd), 0)      AS cost_usd
         FROM requests WHERE ${clause}
        GROUP BY model ORDER BY requests DESC`,
    ).all(...args);

    const byAccount = this.db.prepare(
      `SELECT COALESCE(a.name, '(deleted)') AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(r.cost_usd), 0) AS cost_usd
         FROM requests r LEFT JOIN accounts a ON a.id = r.account_id
        WHERE ${clause}
        GROUP BY r.account_id ORDER BY requests DESC`,
    ).all(...args);

    const byDay = this.db.prepare(
      `SELECT date(ts / 1000, 'unixepoch') AS day,
              COUNT(*) AS requests,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM requests WHERE ${clause}
        GROUP BY day ORDER BY day`,
    ).all(...args);

    const errors = this.db.prepare(
      `SELECT error, COUNT(*) AS n FROM requests
        WHERE ${clause} AND error IS NOT NULL
        GROUP BY error ORDER BY n DESC LIMIT 5`,
    ).all(...args);

    return { totals, byKey, byModel, byAccount, byDay, errors };
  }

  recentRequests(limit = 20) {
    return this.db.prepare(
      `SELECT r.*, k.name AS key_name, a.name AS account_name
         FROM requests r
         LEFT JOIN api_keys k ON k.id = r.key_id
         LEFT JOIN accounts a ON a.id = r.account_id
        ORDER BY r.ts DESC LIMIT ?`,
    ).all(limit);
  }

  prune(days) {
    if (!days) return 0;
    const cutoff = Date.now() - days * 86_400_000;
    return this.db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff).changes;
  }
}

let shared = null;

export function openStore(dataDir = config.dataDir) {
  if (shared) return shared;
  mkdirSync(dataDir, { recursive: true });
  shared = new Store(join(dataDir, 'bridge.db'));
  return shared;
}
