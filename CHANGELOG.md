# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-09-23

### Fixed

- `claude-bridge update` never pulled new code when `install.sh` ran from a
  checkout, because the copy left out `.git`. It now keeps it, and `update`
  says so clearly instead of quietly rebuilding the old version.
- Running `install.sh` again no longer overwrites `.env` with one from the
  checkout.
- `update` also refreshes the `claude-bridge` command itself.

## [0.1.1] - 2026-09-22

### Added

- The image carries the `claude-bridge` command, so it can be run and managed
  without cloning the repository.

## [0.1.0] - 2026-09-22

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
- Docker image on Node 24, built with the newest Claude Code, running as a non
  root user.
- Published image at `ghcr.io/dmnrxb/claude-api-bridge`, rebuilt nightly so it
  does not fall behind the CLI.

[unreleased]: https://github.com/dmnrxb/claude-api-bridge/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/dmnrxb/claude-api-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/dmnrxb/claude-api-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dmnrxb/claude-api-bridge/releases/tag/v0.1.0
