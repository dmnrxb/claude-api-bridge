import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { ClaudeError, buildArgs, classifyFailure, runClaude } from '../src/claude.mjs';

const c = {
  claudeBin: 'claude',
  allowedTools: ['WebSearch', 'WebFetch'],
  disallowedTools: ['Bash', 'Read'],
  requestTimeoutMs: 2000,
};

// A stand in for a spawned process: the test pushes lines onto stdout and
// closes it, exactly as the CLI would.
function fakeSpawn(script) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => script(child));
    return child;
  };
}

function finish(child, lines, { code = 0, stderr = '' } = {}) {
  for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
  if (stderr) child.stderr.write(stderr);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code);
}

describe('buildArgs', () => {
  it('asks for json and locks the tools down', () => {
    const args = buildArgs({ model: 'claude-opus-5', system: 'be brief', stream: false }, c);
    assert.deepEqual(args, [
      '-p', '--model', 'claude-opus-5',
      '--output-format', 'json',
      '--allowed-tools', 'WebSearch', 'WebFetch',
      '--disallowed-tools', 'Bash', 'Read',
      '--system-prompt', 'be brief',
    ]);
  });

  it('adds the streaming flags, without which the answer arrives in one piece', () => {
    const args = buildArgs({ model: 'claude-opus-5', system: '', stream: true }, c);
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--include-partial-messages'));
    assert.ok(!args.includes('--system-prompt'));
  });
});

describe('classifyFailure', () => {
  it('spots the failures that are the account\'s fault', () => {
    assert.equal(classifyFailure('Claude AI usage limit reached'), 'usage limit reached');
    assert.equal(classifyFailure('Error: Not logged in'), 'authentication failed');
    assert.equal(classifyFailure('429 rate limit exceeded'), 'rate limited');
  });

  it('leaves everything else alone so it is not retried on another account', () => {
    assert.equal(classifyFailure('prompt is too long'), null);
    assert.equal(classifyFailure(''), null);
  });
});

describe('runClaude', () => {
  it('reads the answer out of a json run', async () => {
    const spawn = fakeSpawn((child) => finish(child, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Paris' }] } },
      { type: 'result', subtype: 'success', result: 'Paris', usage: { input_tokens: 12, output_tokens: 3 }, total_cost_usd: 0.004 },
    ]));

    const result = await runClaude({ model: 'claude-opus-5', prompt: 'x', token: 't' }, { c, spawn });
    assert.equal(result.text, 'Paris');
    assert.equal(result.usage.inputTokens, 12);
    assert.equal(result.usage.outputTokens, 3);
    assert.equal(result.usage.costUsd, 0.004);
  });

  it('counts cached input tokens as input', async () => {
    const spawn = fakeSpawn((child) => finish(child, [
      { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 1 } },
    ]));
    const result = await runClaude({ model: 'm', prompt: 'x', token: 't' }, { c, spawn });
    assert.equal(result.usage.inputTokens, 105);
  });

  it('hands over the deltas as they arrive', async () => {
    const spawn = fakeSpawn((child) => finish(child, [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Pa' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ris' } } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 2 } },
    ]));

    const pieces = [];
    const result = await runClaude(
      { model: 'm', prompt: 'x', token: 't', stream: true, onDelta: (p) => pieces.push(p) },
      { c, spawn },
    );
    assert.deepEqual(pieces, ['Pa', 'ris']);
    assert.equal(result.text, 'Paris');
  });

  it('survives a json object split across chunks', async () => {
    const spawn = fakeSpawn((child) => {
      const line = `${JSON.stringify({ type: 'result', subtype: 'success', result: 'split' })}\n`;
      child.stdout.write(line.slice(0, 15));
      child.stdout.write(line.slice(15));
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    const result = await runClaude({ model: 'm', prompt: 'x', token: 't' }, { c, spawn });
    assert.equal(result.text, 'split');
  });

  it('turns a reported error into an account failure', async () => {
    const spawn = fakeSpawn((child) => finish(child, [
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached' },
    ]));

    await assert.rejects(
      runClaude({ model: 'm', prompt: 'x', token: 't' }, { c, spawn }),
      (err) => err instanceof ClaudeError && err.accountFailure === 'usage limit reached',
    );
  });

  it('reports a non zero exit with whatever stderr said', async () => {
    const spawn = fakeSpawn((child) => finish(child, [], { code: 1, stderr: 'prompt too long' }));
    await assert.rejects(
      runClaude({ model: 'm', prompt: 'x', token: 't' }, { c, spawn }),
      (err) => err.accountFailure === null && /prompt too long/.test(err.message),
    );
  });

  it('keeps a token out of the error text', async () => {
    const spawn = fakeSpawn((child) => finish(child, [], { code: 1, stderr: 'bad token sk-ant-oat01-AAAABBBBCCCC' }));
    await assert.rejects(
      runClaude({ model: 'm', prompt: 'x', token: 't' }, { c, spawn }),
      (err) => err.message.includes('sk-ant-***') && !err.message.includes('AAAABBBB'),
    );
  });

  it('gives up when nothing comes back in time', async () => {
    const spawn = fakeSpawn((child) => {
      setTimeout(() => { child.stdout.end(); child.stderr.end(); child.emit('close', null); }, 80);
    });
    await assert.rejects(
      runClaude({ model: 'm', prompt: 'x', token: 't' }, { c: { ...c, requestTimeoutMs: 20 }, spawn }),
      /did not answer within/,
    );
  });

  it('passes the account token to the process and nothing else', async () => {
    let seen = null;
    const spawn = (bin, args, options) => {
      seen = options.env;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => finish(child, [{ type: 'result', subtype: 'success', result: 'ok' }]));
      return child;
    };
    await runClaude({ model: 'm', prompt: 'x', token: 'secret-token' }, { c, spawn });
    assert.equal(seen.CLAUDE_CODE_OAUTH_TOKEN, 'secret-token');
  });
});
