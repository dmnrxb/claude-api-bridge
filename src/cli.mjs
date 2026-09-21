#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { config } from './config.mjs';
import { openStore } from './store.mjs';
import { VERSION } from './version.mjs';

const USAGE = `claude-bridge - manage the Claude API Bridge

  status                          what the bridge is running with right now
  stats [options]                 usage over a period
  recent [-n 20]                  the last requests, newest first

  keys list
  keys add <name> [--rpm N] [--rpd N]
  keys limit <name> [--rpm N] [--rpd N] [--none]
  keys enable <name>
  keys disable <name>
  keys rm <name>

  accounts list
  accounts add <name> [--priority N]     token is read from stdin
  accounts token <name>                  replace the token, read from stdin
  accounts priority <name> <number>      lower number is tried first
  accounts enable <name>
  accounts disable <name>
  accounts reset                         clear every cooldown
  accounts rm <name>

stats options
  --days N        how far back to look, default 7
  --key NAME      only this API key
  --model NAME    only this model
  --json          machine readable output

Server settings live in .env next to docker-compose.yml. Change them there and
run "claude-bridge restart".
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      const next = argv[i + 1];
      if (inline !== undefined) flags[name] = inline;
      else if (next !== undefined && !next.startsWith('-')) { flags[name] = next; i += 1; } else flags[name] = true;
    } else if (/^-[a-z]$/i.test(arg)) {
      flags[arg.slice(1)] = argv[i + 1] ?? true;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

function num(value, label) {
  if (value === undefined || value === true) return null;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) fail(`${label} must be a positive number`);
  return n;
}

function ago(ms) {
  if (!ms) return 'never';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function money(value) {
  if (!value) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function count(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

// Plain columns. Reads the same in a terminal and in a copied log.
function table(headers, rows) {
  if (rows.length === 0) return '  (nothing yet)\n';
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => `  ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')}`.trimEnd();
  const body = rows.map(line);
  if (headers.every((h) => h === '')) return `${body.join('\n')}\n`;
  return [line(headers), `  ${widths.map((w) => '-'.repeat(w)).join('  ')}`, ...body].join('\n') + '\n';
}

// Piping into head or less closes stdout early. That is not an error.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

function out(text) {
  process.stdout.write(text);
}

// -- commands --------------------------------------------------------------

function claudeVersion() {
  try {
    return execFileSync(config.claudeBin, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return 'not found';
  }
}

function cmdStatus(store) {
  const accounts = store.listAccounts();
  const ready = store.availableAccounts();
  const keys = store.listKeys();
  const today = store.summary({ sinceMs: 86_400_000 });

  out('\nClaude API Bridge\n\n');
  out(table(['setting', 'value'], [
    ['port', config.port],
    ['claude code', claudeVersion()],
    ['default model', config.defaultModel],
    ['unknown model', config.unknownModel === 'map' ? 'mapped to the default' : 'rejected with 400'],
    ['max concurrent', config.maxConcurrent],
    ['request timeout', `${Math.round(config.requestTimeoutMs / 1000)}s`],
    ['account cooldown', `${Math.round(config.cooldownMs / 60_000)}m`],
    ['keep stats for', config.retentionDays ? `${config.retentionDays} days` : 'forever'],
    ['allowed tools', config.allowedTools.join(', ') || '(none)'],
    ['blocked tools', config.disallowedTools.join(', ') || '(none)'],
  ]));
  out('\n');
  out(table(['', 'count'], [
    ['api keys', `${keys.filter((k) => !k.disabled).length} active of ${keys.length}`],
    ['accounts', `${ready.length} ready of ${accounts.length}`],
    ['requests today', count(today.totals.requests)],
    ['failed today', count(today.totals.failed)],
    ['cost today', money(today.totals.cost_usd)],
  ]));
  out('\n');

  if (accounts.length === 0) out('  No account yet. Add one with: claude-bridge accounts add <name>\n\n');
  if (keys.length === 0) out('  No API key yet. Add one with: claude-bridge keys add <name>\n\n');
}

function cmdKeys(store, positional, flags) {
  const [action, name] = positional;

  if (!action || action === 'list') {
    const rows = store.listKeys().map((k) => [
      k.name,
      k.key_prefix,
      k.disabled ? 'disabled' : 'active',
      k.rpm ? `${k.rpm}/min` : '-',
      k.rpd ? `${k.rpd}/day` : '-',
      ago(k.last_used_at),
    ]);
    out('\n' + table(['name', 'key', 'state', 'rpm', 'rpd', 'last used'], rows) + '\n');
    return;
  }

  if (action === 'add') {
    if (!name) fail('usage: claude-bridge keys add <name> [--rpm N] [--rpd N]');
    if (store.getKeyByName(name)) fail(`a key named "${name}" already exists`);
    const { key } = store.createKey({ name, rpm: num(flags.rpm, '--rpm'), rpd: num(flags.rpd, '--rpd') });
    out(`\nKey "${name}" created. It is shown once and cannot be recovered.\n\n  ${key}\n\n`);
    out('Use it as:\n\n  Authorization: Bearer <key>\n\nor:\n\n  x-api-key: <key>\n\n');
    return;
  }

  if (!name) fail(`usage: claude-bridge keys ${action} <name>`);
  if (!store.getKeyByName(name)) fail(`no key named "${name}"`);

  if (action === 'limit') {
    if (flags.none) {
      store.setKeyLimits(name, { rpm: null, rpd: null });
      out(`Limits removed from "${name}".\n`);
      return;
    }
    const current = store.getKeyByName(name);
    const rpm = flags.rpm === undefined ? current.rpm : num(flags.rpm, '--rpm');
    const rpd = flags.rpd === undefined ? current.rpd : num(flags.rpd, '--rpd');
    store.setKeyLimits(name, { rpm, rpd });
    out(`Limits for "${name}": ${rpm ? `${rpm}/min` : 'no rpm'}, ${rpd ? `${rpd}/day` : 'no rpd'}.\n`);
    return;
  }

  if (action === 'enable' || action === 'disable') {
    store.setKeyEnabled(name, action === 'enable');
    out(`Key "${name}" is now ${action === 'enable' ? 'active' : 'disabled'}.\n`);
    return;
  }

  if (action === 'rm' || action === 'remove' || action === 'delete') {
    store.deleteKey(name);
    out(`Key "${name}" removed. Requests already logged under it are kept.\n`);
    return;
  }

  fail(`unknown keys command "${action}"`);
}

function cmdAccounts(store, positional, flags) {
  const [action, name, value] = positional;

  if (!action || action === 'list') {
    const now = Date.now();
    const rows = store.listAccounts().map((a) => [
      a.name,
      a.priority,
      a.disabled ? 'disabled' : a.cooldown_until > now ? 'cooling down' : 'ready',
      a.cooldown_until > now ? `${Math.ceil((a.cooldown_until - now) / 60_000)}m left` : '-',
      ago(a.last_used_at),
      a.last_error ?? '-',
    ]);
    out('\n' + table(['name', 'prio', 'state', 'cooldown', 'last used', 'last error'], rows) + '\n');
    return;
  }

  if (action === 'add' || action === 'token') {
    if (!name) fail(`usage: claude-bridge accounts ${action} <name>`);
    const token = readStdin() || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    if (!token) fail('no token on stdin. Create one on a machine where you are logged in: claude setup-token');

    if (action === 'add') {
      if (store.getAccountByName(name)) fail(`an account named "${name}" already exists, use "accounts token ${name}" to replace it`);
      store.addAccount({ name, token, priority: num(flags.priority, '--priority') ?? 100 });
      out(`Account "${name}" added.\n`);
    } else {
      if (!store.getAccountByName(name)) fail(`no account named "${name}"`);
      store.setAccountToken(name, token);
      out(`Token for "${name}" replaced, cooldown cleared.\n`);
    }
    return;
  }

  if (action === 'reset') {
    const changed = store.clearCooldowns();
    out(`Cooldowns cleared on ${changed} account${changed === 1 ? '' : 's'}.\n`);
    return;
  }

  if (!name) fail(`usage: claude-bridge accounts ${action} <name>`);
  if (!store.getAccountByName(name)) fail(`no account named "${name}"`);

  if (action === 'priority') {
    const priority = num(value, 'priority');
    if (priority === null) fail('usage: claude-bridge accounts priority <name> <number>');
    store.setAccountPriority(name, priority);
    out(`Account "${name}" now has priority ${priority}. Lower is tried first.\n`);
    return;
  }

  if (action === 'enable' || action === 'disable') {
    store.setAccountEnabled(name, action === 'enable');
    out(`Account "${name}" is now ${action === 'enable' ? 'ready' : 'disabled'}.\n`);
    return;
  }

  if (action === 'rm' || action === 'remove' || action === 'delete') {
    store.deleteAccount(name);
    out(`Account "${name}" removed.\n`);
    return;
  }

  fail(`unknown accounts command "${action}"`);
}

function cmdStats(store, flags) {
  const days = num(flags.days, '--days') ?? 7;
  const data = store.summary({
    sinceMs: Math.max(days, 1) * 86_400_000,
    keyName: typeof flags.key === 'string' ? flags.key : null,
    model: typeof flags.model === 'string' ? flags.model : null,
  });

  if (flags.json) {
    out(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  const t = data.totals;
  out(`\nLast ${days} day${days === 1 ? '' : 's'}\n\n`);
  out(table(['', ''], [
    ['requests', count(t.requests)],
    ['served', count(t.ok)],
    ['failed', count(t.failed)],
    ['input tokens', count(t.input_tokens)],
    ['output tokens', count(t.output_tokens)],
    ['reported cost', money(t.cost_usd)],
    ['average time', `${Math.round(t.avg_ms)} ms`],
  ]));

  out('\nBy key\n');
  out(table(['name', 'requests', 'in', 'out', 'cost'],
    data.byKey.map((r) => [r.name, count(r.requests), count(r.input_tokens), count(r.output_tokens), money(r.cost_usd)])));

  out('\nBy model\n');
  out(table(['model', 'requests', 'in', 'out', 'cost'],
    data.byModel.map((r) => [r.model, count(r.requests), count(r.input_tokens), count(r.output_tokens), money(r.cost_usd)])));

  out('\nBy account\n');
  out(table(['name', 'requests', 'cost'],
    data.byAccount.map((r) => [r.name, count(r.requests), money(r.cost_usd)])));

  out('\nBy day\n');
  out(table(['day', 'requests', 'cost'],
    data.byDay.map((r) => [r.day, count(r.requests), money(r.cost_usd)])));

  if (data.errors.length) {
    out('\nMost common errors\n');
    out(table(['error', 'count'], data.errors.map((r) => [String(r.error).slice(0, 70), count(r.n)])));
  }

  out('\nCost is what Claude Code reported for the run. On a subscription it is\n');
  out('an indication of size, not a bill.\n\n');
}

function cmdRecent(store, flags) {
  const limit = num(flags.n, '-n') ?? 20;
  const rows = store.recentRequests(limit).map((r) => [
    new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19),
    r.key_name ?? '-',
    r.account_name ?? '-',
    r.model ?? '-',
    r.stream ? 'stream' : 'json',
    r.status,
    `${r.duration_ms} ms`,
    r.error ? String(r.error).slice(0, 48) : '',
  ]);
  out('\n' + table(['time (utc)', 'key', 'account', 'model', 'mode', 'code', 'took', 'error'], rows) + '\n');
}

// -- entry point -----------------------------------------------------------

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;

  if (!command || flags.help || flags.h || command === 'help') {
    out(USAGE);
    return;
  }

  const store = openStore();
  try {
    switch (command) {
      case 'status': cmdStatus(store); break;
      case 'keys': cmdKeys(store, rest, flags); break;
      case 'accounts': cmdAccounts(store, rest, flags); break;
      case 'stats': cmdStats(store, flags); break;
      case 'recent': cmdRecent(store, flags); break;
      case 'version': out(`${VERSION}\n`); break;
      default: fail(`unknown command "${command}". Run "claude-bridge help" for the list.`);
    }
  } finally {
    store.close();
  }
}

main(process.argv.slice(2));
