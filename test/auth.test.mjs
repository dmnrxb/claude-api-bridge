import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AuthError, RateLimitError, authenticate, enforceLimits, readKey } from '../src/auth.mjs';
import { Store } from '../src/store.mjs';

describe('readKey', () => {
  it('takes the OpenAI style header', () => {
    assert.equal(readKey({ authorization: 'Bearer cb-abc' }), 'cb-abc');
    assert.equal(readKey({ authorization: 'bearer  cb-abc ' }), 'cb-abc');
  });

  it('takes the Anthropic style header', () => {
    assert.equal(readKey({ 'x-api-key': 'cb-abc' }), 'cb-abc');
  });

  it('returns nothing when neither is there', () => {
    assert.equal(readKey({}), null);
    assert.equal(readKey({ authorization: 'Basic abc' }), null);
  });
});

describe('authenticate and limits', () => {
  let dir;
  let store;
  let key;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-auth-'));
    store = new Store(join(dir, 'bridge.db'));
    key = store.createKey({ name: 'tool', rpm: 2, rpd: 3 }).key;
  });

  after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a known key', () => {
    assert.equal(authenticate(store, { authorization: `Bearer ${key}` }).name, 'tool');
  });

  it('turns away a missing or unknown key', () => {
    assert.throws(() => authenticate(store, {}), AuthError);
    assert.throws(() => authenticate(store, { 'x-api-key': 'cb-nope' }), /unknown API key/);
  });

  it('turns away a disabled key with 403', () => {
    store.setKeyEnabled('tool', false);
    assert.throws(() => authenticate(store, { 'x-api-key': key }), (err) => err.status === 403);
    store.setKeyEnabled('tool', true);
  });

  it('lets a key through while it is under its limit', () => {
    const row = store.getKeyByName('tool');
    store.recordRequest({ keyId: row.id, status: 200 });
    assert.doesNotThrow(() => enforceLimits(store, store.getKeyByName('tool')));
  });

  it('stops a key once the minute limit is used up', () => {
    const row = store.getKeyByName('tool');
    store.recordRequest({ keyId: row.id, status: 200 });
    assert.throws(() => enforceLimits(store, store.getKeyByName('tool')), RateLimitError);
  });

  it('counts the daily window separately', () => {
    const row = store.getKeyByName('tool');
    // Move the two rows out of the minute window but keep them inside the day.
    store.db.prepare('UPDATE requests SET ts = ? WHERE key_id = ?').run(Date.now() - 120_000, row.id);
    assert.doesNotThrow(() => enforceLimits(store, store.getKeyByName('tool')));

    store.recordRequest({ keyId: row.id, status: 200, ts: Date.now() - 120_000 });
    assert.throws(() => enforceLimits(store, store.getKeyByName('tool')), /daily limit/);
  });

  it('ignores limits that are not set', () => {
    store.setKeyLimits('tool', { rpm: null, rpd: null });
    assert.doesNotThrow(() => enforceLimits(store, store.getKeyByName('tool')));
  });
});
