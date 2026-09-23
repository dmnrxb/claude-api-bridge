import { createServer } from 'node:http';

import { NoAccountError, withAccount } from './accounts.mjs';
import { AuthError, RateLimitError, authenticate, enforceLimits } from './auth.mjs';
import { ClaudeError, runClaude } from './claude.mjs';
import { checkConfig, config } from './config.mjs';
import { log, setLogLevel } from './log.mjs';
import {
  BadRequest, chatCompletion, chunk, completionId, errorBody, modelList, parseChatRequest, sse,
} from './openai.mjs';
import { Gate } from './queue.mjs';
import { redact } from './secrets.mjs';
import { openStore } from './store.mjs';
import { VERSION } from './version.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  const headers = {};
  if (extra.retryAfter) headers['retry-after'] = String(extra.retryAfter);
  send(res, status, errorBody(message, extra), headers);
}

function statusOf(err) {
  return Number.isInteger(err?.status) ? err.status : 500;
}

function typeOf(status) {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 400) return 'invalid_request_error';
  return 'api_error';
}

async function readBody(req) {
  const parts = [];
  let size = 0;
  for await (const piece of req) {
    size += piece.length;
    if (size > MAX_BODY_BYTES) {
      const err = new BadRequest('request body is larger than 8 MB');
      err.status = 413;
      throw err;
    }
    parts.push(piece);
  }
  const raw = Buffer.concat(parts).toString('utf8');
  if (!raw.trim()) throw new BadRequest('request body is empty');
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequest('request body is not valid JSON');
  }
}

// `run` is injected so the tests need no Claude Code on the machine.
export function createApp({ store, gate, run = runClaude }) {
  async function handleChat(req, res) {
    const started = Date.now();
    const body = await readBody(req);
    const key = authenticate(store, req.headers);
    enforceLimits(store, key);

    const parsed = parseChatRequest(body, {
      defaultModel: config.defaultModel,
      unknownModel: config.unknownModel,
    });

    store.touchKey(key.id);

    const id = completionId();
    const abort = new AbortController();
    req.on('close', () => { if (!res.writableEnded) abort.abort(); });

    let headersSent = false;
    let emitted = false;

    const startStream = () => {
      headersSent = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(sse(chunk({ id, model: parsed.requestedModel, delta: { role: 'assistant', content: '' } })));
    };

    const record = (status, accountId, usage, error) => {
      store.recordRequest({
        ts: started,
        keyId: key.id,
        accountId,
        model: parsed.requestedModel,
        stream: parsed.stream,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: usage?.costUsd ?? 0,
        durationMs: Date.now() - started,
        status,
        error,
      });
    };

    try {
      const result = await gate.run(() => withAccount(store, async (token, account) => {
        try {
          return await run({
            model: parsed.model,
            system: parsed.system,
            prompt: parsed.prompt,
            stream: parsed.stream,
            token,
            signal: abort.signal,
            onDelta: parsed.stream
              ? (piece) => {
                if (!headersSent) startStream();
                emitted = true;
                res.write(sse(chunk({ id, model: parsed.requestedModel, delta: { content: piece } })));
              }
              : undefined,
          });
        } catch (err) {
          // Bytes are already out, so another account would repeat text.
          if (emitted) err.accountFailure = null;
          err.accountId = account.id;
          throw err;
        }
      }));

      log.info('request served', {
        key: key.name,
        account: result.account.name,
        model: parsed.requestedModel,
        stream: parsed.stream,
        ms: Date.now() - started,
        in: result.usage.inputTokens,
        out: result.usage.outputTokens,
      });

      record(200, result.account.id, result.usage, null);

      if (parsed.stream) {
        if (!headersSent) startStream();
        res.write(sse(chunk({
          id, model: parsed.requestedModel, delta: {}, finishReason: 'stop', usage: result.usage,
        })));
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        send(res, 200, chatCompletion({
          id, model: parsed.requestedModel, text: result.text, usage: result.usage,
        }));
      }
    } catch (err) {
      const status = statusOf(err);
      record(status, err.accountId ?? null, null, redact(err.message));

      if (status >= 500) log.error('request failed', { key: key.name, status, error: redact(err.message) });
      else log.warn('request rejected', { key: key.name, status, error: redact(err.message) });

      if (headersSent) {
        // The stream already started, so the error goes inside it.
        res.write(sse(errorBody(redact(err.message), { type: typeOf(status) })));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      throw err;
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

    try {
      if (route === 'GET /health' || route === 'GET /healthz') {
        const accounts = store.listAccounts();
        send(res, 200, {
          status: 'ok',
          version: VERSION,
          accounts: { total: accounts.length, ready: store.availableAccounts().length },
          queue: { active: gate.active, waiting: gate.queued, limit: gate.limit },
        });
        return;
      }

      if (route === 'GET /v1/models') {
        authenticate(store, req.headers);
        send(res, 200, modelList());
        return;
      }

      if (route === 'POST /v1/chat/completions') {
        await handleChat(req, res);
        return;
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, { allow: 'GET, POST, OPTIONS' });
        res.end();
        return;
      }

      sendError(res, 404, `no route for ${route}`, { type: 'invalid_request_error', code: 'not_found' });
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = statusOf(err);
      if (status >= 500) log.error('unhandled failure', { route, error: redact(err.message), stack: err.stack });
      sendError(res, status, redact(err.message), {
        type: typeOf(status),
        code: err.code ?? null,
        param: err.param ?? null,
        retryAfter: err.retryAfter,
      });
    }
  };
}

export function start() {
  setLogLevel(config.logLevel);

  const problems = checkConfig();
  if (problems.length) {
    for (const problem of problems) log.error('configuration problem', { problem });
    log.error('refusing to start, fix .env and try again');
    process.exit(1);
  }

  let store;
  try {
    store = openStore();
  } catch (err) {
    log.error('cannot open the database', {
      dir: config.dataDir,
      error: err.message,
      hint: `the directory must be writable by uid ${process.getuid?.() ?? '?'}`,
    });
    process.exit(1);
  }
  const gate = new Gate();
  const server = createServer(createApp({ store, gate }));

  // A run can take minutes, so the sockets have to outlive the default.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 75_000;

  server.listen(config.port, config.host, () => {
    log.info('claude-api-bridge listening', {
      version: VERSION,
      address: `${config.host}:${config.port}`,
      accounts: store.listAccounts().length,
      keys: store.listKeys().length,
      maxConcurrent: config.maxConcurrent,
    });
  });

  if (config.retentionDays > 0) {
    const prune = () => {
      const removed = store.prune(config.retentionDays);
      if (removed) log.info('old request rows removed', { removed, keepDays: config.retentionDays });
    };
    prune();
    setInterval(prune, 86_400_000).unref();
  }

  const shutdown = (signal) => {
    log.info('shutting down', { signal });
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
