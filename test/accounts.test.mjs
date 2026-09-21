import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { NoAccountError, withAccount } from '../src/accounts.mjs';
import { ClaudeError } from '../src/claude.mjs';
import { Store } from '../src/store.mjs';

const SECRET = 'another-test-secret-key-long-enough-0123';
const c = { cooldownMs: 60_000, secretKey: SECRET };

describe('withAccount', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-pool-'));
    store = new Store(join(dir, 'bridge.db'));
    return () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
  });

  it('says so when there is no account at all', async () => {
    await assert.rejects(withAccount(store, async () => ({}), { c }),
      (err) => err instanceof NoAccountError && /no Claude account is configured/.test(err.message));
  });

  it('says so when every account is parked', async () => {
    store.addAccount({ name: 'a', token: 'x' }, SECRET);
    store.parkAccount(store.getAccountByName('a').id, 'usage limit reached', Date.now() + 60_000);

    await assert.rejects(withAccount(store, async () => ({}), { c }), /disabled or cooling down/);
  });

  it('uses the first account and remembers that it worked', async () => {
    store.addAccount({ name: 'a', token: 'token-a' }, SECRET);

    const result = await withAccount(store, async (token, account) => {
      assert.equal(account.name, 'a');
      return { text: `used ${token}` };
    }, { c });

    assert.equal(result.text, 'used token-a');
    assert.equal(result.account.name, 'a');
    assert.ok(store.getAccountByName('a').last_used_at);
  });

  it('moves to the next account when the first one is out of quota', async () => {
    store.addAccount({ name: 'a', token: 'token-a', priority: 1 }, SECRET);
    store.addAccount({ name: 'b', token: 'token-b', priority: 2 }, SECRET);

    const tried = [];
    const result = await withAccount(store, async (token, account) => {
      tried.push(account.name);
      if (account.name === 'a') throw new ClaudeError('usage limit', { accountFailure: 'usage limit reached' });
      return { text: 'ok' };
    }, { c });

    assert.deepEqual(tried, ['a', 'b']);
    assert.equal(result.account.name, 'b');
    assert.ok(store.getAccountByName('a').cooldown_until > Date.now());
    assert.equal(store.getAccountByName('a').last_error, 'usage limit reached');
  });

  it('does not burn a second account on a bad request', async () => {
    store.addAccount({ name: 'a', token: 'token-a', priority: 1 }, SECRET);
    store.addAccount({ name: 'b', token: 'token-b', priority: 2 }, SECRET);

    let calls = 0;
    await assert.rejects(withAccount(store, async () => {
      calls += 1;
      throw new ClaudeError('prompt is too long');
    }, { c }), /prompt is too long/);

    assert.equal(calls, 1);
    assert.equal(store.getAccountByName('a').cooldown_until, 0);
  });

  it('parks an account whose token cannot be read', async () => {
    store.addAccount({ name: 'a', token: 'token-a' }, 'a-secret-nobody-here-will-use-later');

    await assert.rejects(withAccount(store, async () => ({}), { c }));
    assert.match(store.getAccountByName('a').last_error, /could not be decrypted/);
  });
});
