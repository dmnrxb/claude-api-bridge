import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { hashApiKey } from '../src/secrets.mjs';
import { Store } from '../src/store.mjs';

const SECRET = 'test-secret-key-that-is-long-enough-abcdef';

describe('Store', () => {
  let dir;
  let store;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
    store = new Store(join(dir, 'bridge.db'));
  });

  after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores an api key only as a hash', () => {
    const { key } = store.createKey({ name: 'n8n', rpm: 20, rpd: 500 });
    assert.match(key, /^cb-/);

    const row = store.getKeyByName('n8n');
    assert.equal(row.key_hash, hashApiKey(key));
    assert.ok(!JSON.stringify(row).includes(key.slice(12)));
    assert.equal(row.rpm, 20);
    assert.equal(store.findKeyByHash(hashApiKey(key)).name, 'n8n');
  });

  it('enables, disables and removes keys', () => {
    store.createKey({ name: 'temp' });
    store.setKeyEnabled('temp', false);
    assert.equal(store.getKeyByName('temp').disabled, 1);
    store.setKeyLimits('temp', { rpm: null, rpd: 10 });
    assert.equal(store.getKeyByName('temp').rpm, null);
    assert.equal(store.deleteKey('temp'), 1);
    assert.equal(store.getKeyByName('temp'), null);
  });

  it('round trips an account token through encryption', () => {
    store.addAccount({ name: 'primary', token: 'sk-ant-oat01-secret' }, SECRET);
    const row = store.getAccountByName('primary');
    assert.ok(!row.token_enc.includes('secret'));
    assert.equal(store.accountToken(row, SECRET), 'sk-ant-oat01-secret');
  });

  it('will not decrypt with the wrong secret', () => {
    const row = store.getAccountByName('primary');
    assert.throws(() => store.accountToken(row, 'a-different-secret-key-entirely-xx'));
  });

  it('orders accounts by priority, then by how long ago they were used', () => {
    store.addAccount({ name: 'backup', token: 'b', priority: 200 }, SECRET);
    store.addAccount({ name: 'spare', token: 's', priority: 100 }, SECRET);

    const names = store.availableAccounts().map((a) => a.name);
    assert.deepEqual(names.slice(0, 2).sort(), ['primary', 'spare']);
    assert.equal(names.at(-1), 'backup');

    store.markAccountUsed(store.getAccountByName('primary').id);
    assert.equal(store.availableAccounts()[0].name, 'spare');
  });

  it('hides a parked account until the cooldown passes', () => {
    const spare = store.getAccountByName('spare');
    store.parkAccount(spare.id, 'usage limit reached', Date.now() + 60_000);
    assert.ok(!store.availableAccounts().some((a) => a.name === 'spare'));
    assert.equal(store.getAccountByName('spare').last_error, 'usage limit reached');

    store.clearCooldowns();
    assert.ok(store.availableAccounts().some((a) => a.name === 'spare'));
  });

  it('hides a disabled account', () => {
    store.setAccountEnabled('backup', false);
    assert.ok(!store.availableAccounts().some((a) => a.name === 'backup'));
    store.setAccountEnabled('backup', true);
  });

  it('counts requests inside a rolling window', () => {
    const key = store.getKeyByName('n8n');
    store.recordRequest({ keyId: key.id, status: 200, model: 'claude-opus-5' });
    store.recordRequest({ keyId: key.id, status: 200, model: 'claude-opus-5' });
    store.recordRequest({ keyId: key.id, status: 200, model: 'claude-opus-5', ts: Date.now() - 120_000 });

    assert.equal(store.countKeyRequests(key.id, 60_000), 2);
    assert.equal(store.countKeyRequests(key.id, 86_400_000), 3);
  });

  it('adds up usage for the stats view', () => {
    const key = store.getKeyByName('n8n');
    store.recordRequest({
      keyId: key.id, status: 200, model: 'claude-sonnet-5',
      inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1200,
    });
    store.recordRequest({ keyId: key.id, status: 429, model: 'claude-sonnet-5', error: 'rate limit reached' });

    const s = store.summary({ sinceMs: 86_400_000 });
    assert.equal(s.totals.requests, 5);
    assert.equal(s.totals.failed, 1);
    assert.equal(s.totals.input_tokens, 100);
    assert.ok(s.byModel.some((m) => m.model === 'claude-sonnet-5' && m.requests === 2));
    assert.equal(s.errors[0].error, 'rate limit reached');
  });

  it('filters the stats by key', () => {
    store.createKey({ name: 'other' });
    const other = store.getKeyByName('other');
    store.recordRequest({ keyId: other.id, status: 200, model: 'claude-opus-5' });

    assert.equal(store.summary({ sinceMs: 86_400_000, keyName: 'other' }).totals.requests, 1);
  });

  it('drops rows past the retention window', () => {
    store.recordRequest({ keyId: null, status: 200, ts: Date.now() - 100 * 86_400_000 });
    assert.equal(store.prune(90), 1);
    assert.equal(store.prune(0), 0);
  });

  it('keeps logged requests when the key is deleted', () => {
    store.deleteKey('other');
    const rows = store.summary({ sinceMs: 86_400_000 }).byKey;
    assert.ok(rows.some((r) => r.name === '(deleted)'));
  });
});
