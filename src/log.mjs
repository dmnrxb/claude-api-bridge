const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold = LEVELS.info;

export function setLogLevel(level) {
  if (level in LEVELS) threshold = LEVELS[level];
}

function write(level, msg, fields) {
  if (LEVELS[level] > threshold) return;
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  error: (msg, fields) => write('error', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  debug: (msg, fields) => write('debug', msg, fields),
};
