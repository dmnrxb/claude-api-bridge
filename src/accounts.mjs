import { config } from './config.mjs';
import { log } from './log.mjs';

export class NoAccountError extends Error {
  constructor(message) {
    super(message);
    this.status = 503;
  }
}

// Try `attempt` on one account after another, best first. A failure that is
// the account's fault parks it and moves on. Any other failure stops here,
// because a retry would only burn a second account.
export async function withAccount(store, attempt, { c = config } = {}) {
  const candidates = store.availableAccounts();

  if (candidates.length === 0) {
    const total = store.listAccounts().length;
    throw new NoAccountError(
      total === 0
        ? 'no Claude account is configured, add one with: claude-bridge accounts add'
        : 'every Claude account is disabled or cooling down, check: claude-bridge accounts list',
    );
  }

  let lastError = null;

  for (const account of candidates) {
    let token;
    try {
      token = store.accountToken(account, c.secretKey);
    } catch (err) {
      store.parkAccount(account.id, `token could not be decrypted: ${err.message}`, Date.now() + c.cooldownMs);
      lastError = err;
      continue;
    }

    try {
      const result = await attempt(token, account);
      store.markAccountUsed(account.id);
      return { ...result, account };
    } catch (err) {
      lastError = err;
      if (!err.accountFailure) throw err;

      const until = Date.now() + c.cooldownMs;
      store.parkAccount(account.id, err.accountFailure, until);
      log.warn('account parked, trying the next one', {
        account: account.name,
        reason: err.accountFailure,
        until: new Date(until).toISOString(),
      });
    }
  }

  throw lastError ?? new NoAccountError('no account could handle the request');
}
