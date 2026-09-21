# Contributing

Thanks for looking. This is a small project and it should stay small.

## Ground rules

- No runtime dependencies. The service runs on what Node ships with. If a
  change needs a package, it probably belongs somewhere else.
- Every change comes with a test. `npm test` runs offline, without Docker and
  without a Claude account.
- Plain language in code comments, docs and CLI output. Say what a thing does
  and why, skip the rest.

## Getting set up

```bash
git clone https://github.com/dominikdev/claude-api-bridge.git
cd claude-api-bridge
npm test
```

Node 24 or newer. There is nothing to install.

To run the service against a scratch database:

```bash
export BRIDGE_SECRET_KEY="$(openssl rand -base64 48)"
export BRIDGE_DATA_DIR=./data
node src/cli.mjs keys add local
node src/cli.mjs accounts add primary   # paste a token from: claude setup-token
node src/server.mjs
```

## Tests

`test/` uses the built in runner. The Claude Code process is never started for
real: `runClaude` takes a `spawn` function and the HTTP tests take a `run`
function, so both can be replaced with something predictable.

```bash
npm test
node --test test/store.test.mjs
```

## Shell and Docker

```bash
shellcheck install.sh bin/claude-bridge
hadolint Dockerfile
docker compose build
```

CI runs all of these.

## The diagram

`docs/architecture.svg` and `docs/architecture-dark.svg` are plain SVG, edited
by hand. Change both when you change one, they are the light and dark version
of the same picture.

## Pull requests

- One topic per pull request.
- Say what changes for someone running the service, not just what moved in the
  code.
- If it changes a default, a flag or an endpoint, update the README in the same
  pull request.

## Reporting a bug

Include the version (`claude-bridge version`), what you ran, what happened, and
the relevant lines from `claude-bridge logs`. Check them for tokens first.
