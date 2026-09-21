# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

First release.

### Added

- `POST /v1/chat/completions` with and without streaming, `GET /v1/models`,
  `GET /health`.
- Several API keys, each with optional per minute and per day limits.
- Several Claude accounts with priority order and automatic fallback when one
  hits a limit or stops authenticating.
- Usage statistics per key, model, account and day, read with
  `claude-bridge stats`.
- `install.sh`, which asks whether a reverse proxy is already there, sets up
  Caddy if not, and installs the `claude-bridge` command.
- Docker image on Node 24 with a pinned Claude Code CLI, running as a non root
  user.
