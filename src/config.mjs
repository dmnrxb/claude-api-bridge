// All runtime settings come from the environment. The installer writes them
// into .env, docker compose passes that file to the container.

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function list(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.split(/[\s,]+/).filter(Boolean);
}

export const config = {
  port: int('BRIDGE_PORT', 8787),
  host: str('BRIDGE_HOST', '0.0.0.0'),
  dataDir: str('BRIDGE_DATA_DIR', '/data'),

  // Encrypts account tokens at rest. The installer generates one.
  secretKey: str('BRIDGE_SECRET_KEY', ''),

  // How many Claude Code processes may run at the same time, and how long a
  // request may sit in the queue before the bridge gives up.
  maxConcurrent: int('BRIDGE_MAX_CONCURRENT', 4),
  queueTimeoutMs: int('BRIDGE_QUEUE_TIMEOUT_MS', 30_000),

  // Hard limit on one Claude Code run.
  requestTimeoutMs: int('BRIDGE_REQUEST_TIMEOUT_MS', 600_000),

  // Where the Claude Code binary lives and what it is allowed to touch.
  claudeBin: str('BRIDGE_CLAUDE_BIN', 'claude'),
  allowedTools: list('BRIDGE_ALLOWED_TOOLS', ['WebSearch', 'WebFetch']),
  disallowedTools: list('BRIDGE_DISALLOWED_TOOLS', [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'NotebookEdit',
  ]),

  defaultModel: str('BRIDGE_DEFAULT_MODEL', 'claude-opus-5'),

  // What to do with a model name the bridge does not know.
  //   map   fall back to the default model, report it back in the response
  //   error answer with 400 and list the known names
  unknownModel: str('BRIDGE_UNKNOWN_MODEL', 'map'),

  // How long an account stays parked after it failed.
  cooldownMs: int('BRIDGE_ACCOUNT_COOLDOWN_MS', 900_000),

  // Keep request rows for this many days. 0 keeps them forever.
  retentionDays: int('BRIDGE_RETENTION_DAYS', 90),

  logLevel: str('BRIDGE_LOG_LEVEL', 'info'),
};

export function checkConfig(c = config) {
  const problems = [];
  if (!c.secretKey) problems.push('BRIDGE_SECRET_KEY is not set');
  else if (c.secretKey.length < 32) problems.push('BRIDGE_SECRET_KEY is shorter than 32 characters');
  if (c.maxConcurrent < 1) problems.push('BRIDGE_MAX_CONCURRENT must be at least 1');
  if (!['map', 'error'].includes(c.unknownModel)) {
    problems.push('BRIDGE_UNKNOWN_MODEL must be "map" or "error"');
  }
  return problems;
}
