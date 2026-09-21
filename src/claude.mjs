import { spawn as nodeSpawn } from 'node:child_process';

import { config } from './config.mjs';
import { log } from './log.mjs';
import { redact } from './secrets.mjs';

// Build the argument list for one Claude Code run.
//
// Two tool lists, and both are needed. The deny list is what must never run,
// even if someone widens the allow list later. The allow list is what may run
// without asking: without it Claude Code asks for permission in headless mode,
// gets no answer, and then tells the caller it was not allowed to search.
export function buildArgs({ model, system, stream }, c = config) {
  const args = ['-p', '--model', model];

  args.push('--output-format', stream ? 'stream-json' : 'json');
  if (stream) {
    // Without these two, stream-json emits the whole answer as one event.
    args.push('--verbose', '--include-partial-messages');
  }
  if (c.allowedTools.length) args.push('--allowed-tools', ...c.allowedTools);
  if (c.disallowedTools.length) args.push('--disallowed-tools', ...c.disallowedTools);

  // Replaces Claude Code's own system prompt rather than adding to it, which
  // takes the coding harness out of a plain chat.
  if (system) args.push('--system-prompt', system);

  return args;
}

const ACCOUNT_FAILURES = [
  { re: /usage limit reached/i, reason: 'usage limit reached' },
  { re: /rate limit/i, reason: 'rate limited' },
  { re: /not logged in|invalid api key|authentication_error|oauth token.*(expired|invalid)|401/i, reason: 'authentication failed' },
  { re: /credit balance|insufficient/i, reason: 'no credit' },
  { re: /overloaded|529/i, reason: 'upstream overloaded' },
];

// Did this run fail because of the account, or because of the request? Only
// the first kind is worth retrying on another account.
export function classifyFailure(text) {
  if (!text) return null;
  for (const { re, reason } of ACCOUNT_FAILURES) {
    if (re.test(text)) return reason;
  }
  return null;
}

function usageOf(raw) {
  const u = raw?.usage ?? {};
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    costUsd: raw?.total_cost_usd ?? 0,
  };
}

export class ClaudeError extends Error {
  constructor(message, { accountFailure = null, status = 502 } = {}) {
    super(message);
    this.accountFailure = accountFailure;
    this.status = status;
  }
}

/**
 * Run Claude Code once.
 *
 * `onDelta` is called with each piece of text as it arrives. It is only used
 * when `stream` is set; otherwise the whole answer comes back at the end.
 * Resolves with { text, usage, model }.
 */
export async function runClaude({
  model, system, prompt, stream = false, token, signal, onDelta,
}, { c = config, spawn = nodeSpawn } = {}) {
  const args = buildArgs({ model, system, stream }, c);

  const child = spawn(c.claudeBin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODE_OAUTH_TOKEN: token,
      // Keep the CLI from phoning home about anything we did not ask for.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // The container gives the node user a writable home; the CLI needs it.
      HOME: process.env.HOME ?? '/home/node',
    },
  });

  let settled = false;
  let text = '';
  let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let resultSeen = false;
  let failure = null;
  let stderr = '';

  const timer = setTimeout(() => {
    failure ??= new ClaudeError(`claude did not answer within ${c.requestTimeoutMs} ms`, { status: 504 });
    child.kill('SIGKILL');
  }, c.requestTimeoutMs);

  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });

  const handleEvent = (event) => {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'stream_event') {
      const inner = event.event;
      if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        const piece = inner.delta.text ?? '';
        if (piece) {
          text += piece;
          onDelta?.(piece);
        }
      }
      return;
    }

    // Non-streaming runs report the answer once, on the assistant message.
    if (event.type === 'assistant' && !stream) {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text) text += block.text;
      }
      return;
    }

    if (event.type === 'result') {
      resultSeen = true;
      usage = usageOf(event);
      if (event.is_error || event.subtype === 'error_during_execution') {
        const message = String(event.result ?? event.subtype ?? 'claude reported an error');
        failure ??= new ClaudeError(redact(message), { accountFailure: classifyFailure(message) });
        return;
      }
      // The json format puts the finished answer here.
      if (!text && typeof event.result === 'string') text = event.result;
    }
  };

  const stdoutDone = readLines(child.stdout, (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      log.debug('claude wrote a line that is not json', { line: redact(line).slice(0, 200) });
      return;
    }
    handleEvent(event);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (piece) => {
    if (stderr.length < 8000) stderr += piece;
  });

  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const code = await new Promise((resolve, reject) => {
    child.once('error', (err) => {
      settled = true;
      reject(new ClaudeError(`could not start ${c.claudeBin}: ${err.message}`, { status: 500 }));
    });
    child.once('close', (exitCode) => {
      if (!settled) resolve(exitCode);
    });
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  });

  await stdoutDone;

  if (failure) throw failure;

  if (signal?.aborted) throw new ClaudeError('client went away', { status: 499 });

  if (code !== 0 || !resultSeen) {
    const detail = redact(stderr.trim()) || `claude exited with code ${code}`;
    throw new ClaudeError(detail.slice(0, 500), { accountFailure: classifyFailure(detail) });
  }

  return { text, usage, model };
}

// stdout arrives in arbitrary chunks; the stream-json format is one JSON
// object per line, so the tail has to be carried over.
function readLines(stream, onLine) {
  return new Promise((resolve) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (piece) => {
      buffer += piece;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
        index = buffer.indexOf('\n');
      }
    });
    stream.on('end', () => {
      const rest = buffer.trim();
      if (rest) onLine(rest);
      resolve();
    });
    stream.on('error', () => resolve());
  });
}
