# Security

## Reporting

Open a private security advisory on GitHub, or mail info@dominikdev.de. Please
do not open a public issue for something exploitable.

Include what you did, what happened and what you think it lets someone do. A
reply comes within a week.

## What this service protects

It holds a token for a Claude subscription, and a prompt reaching it does not
always come from a trusted source. The defences in place:

- `Bash`, `Read`, `Write`, `Edit`, `Glob` and `Grep` are on the Claude Code
  deny list. That list wins over the allow list, so widening the allow list
  cannot bring them back.
- Only `WebSearch` and `WebFetch` are allowed, and both only read.
- The container runs as `node`, not root, on a port above 1024.
- The published port binds to `127.0.0.1` unless you choose otherwise.
- The service refuses to start without `BRIDGE_SECRET_KEY`.
- Account tokens are encrypted with AES-256-GCM before they reach the database.
- API keys are stored as a SHA-256 hash and shown once.
- Tokens are stripped from log lines and error messages.

## What it does not protect against

- Anyone who can read `.env` on the host can decrypt the account tokens. The
  encryption protects the database file, not the machine.
- A prompt can still make Claude Code fetch a URL. If that matters to you,
  narrow `BRIDGE_ALLOWED_TOOLS` in `.env`.
- There is no per user isolation. Everyone with a valid API key reaches the
  same accounts. Give each tool its own key so you can disable one without
  touching the rest.

## Keeping it current

The image is built with the newest Claude Code, but it does not update itself
afterwards. Run this now and then:

```bash
claude-bridge rebuild
```
