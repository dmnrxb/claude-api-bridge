import { readFileSync } from 'node:fs';

// One place for the version.
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
