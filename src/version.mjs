import { readFileSync } from 'node:fs';

// One place for the version, so the server, the CLI and the package file
// cannot drift apart.
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
