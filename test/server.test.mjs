import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The modules read their settings from the environment at import time, so the
// environment has to be in place before they load.
process.env.BRIDGE_SECRET_KEY = 'server-test-secret-key-long-enough-0123456';
process.env.BRIDGE_MAX_CONCURRENT = '2';

const { createApp } = await import('../src/server.mjs');
const { Gate } = await import('../src/queue.mjs');
const { Store } = await import('../src/store.mjs');
const { ClaudeError } = await import('../src/claude.mjs');

describe('http routes', () => {
  let dir;
  let store;
  let server;
  let base;
  let key;
  let behaviour;

  const fakeRun = async ({ stream, onDelta, prompt, system, model }) => {
    const outcome = behaviour({ prompt, system, model });
    if (outcome instanceof Error) throw outcome;
    if (stream) for (const piece of outcome.pieces) onDelta(piece);
    return {
      text: outcome.pieces.join(''),
      usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.002 },
      model,
    };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-http-'));
    store = new Store(join(dir, 'bridge.db'));
    key = store.createKey({ name: 'tool' }).key;
    store.addAccount({ name: 'primary', token: 'token-a' }, process.env.BRIDGE_SECRET_KEY);
    behaviour = () => ({ pieces: ['Hello', ' world'] });

    server = createServer(createApp({ store, gate: new Gate({ limit: 2, timeoutMs: 500 }), run: fakeRun }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body, headers = {}) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });

  it('answers the health check without a key', async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.accounts.ready, 1);
  });

  it('wants a key for the model list', async () => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);

    const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': key } });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).data.some((m) => m.id === 'claude-opus-5'));
  });

  it('answers a chat request in the OpenAI shape', async () => {
    const res = await post({
      model: 'claude-opus-5',
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }],
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.choices[0].message.content, 'Hello world');
    assert.equal(body.model, 'claude-opus-5');
    assert.equal(body.usage.total_tokens, 10);
  });

  it('writes one statistics row per request', async () => {
    const before_ = store.summary({ sinceMs: 60_000 }).totals.requests;
    await post({ messages: [{ role: 'user', content: 'hi' }] });
    const after_ = store.summary({ sinceMs: 60_000 });

    assert.equal(after_.totals.requests, before_ + 1);
    assert.ok(after_.byAccount.some((a) => a.name === 'primary'));
  });

  it('streams server sent events', async () => {
    behaviour = () => ({ pieces: ['Pa', 'ris'] });
    const res = await post({ messages: [{ role: 'user', content: 'hi' }], stream: true });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const text = await res.text();
    const frames = text.split('\n\n').filter(Boolean).map((f) => f.replace(/^data: /, ''));

    assert.equal(frames.at(-1), '[DONE]');
    const content = frames
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f))
      .map((f) => f.choices?.[0]?.delta?.content ?? '')
      .join('');
    assert.equal(content, 'Paris');

    const last = JSON.parse(frames.at(-2));
    assert.equal(last.choices[0].finish_reason, 'stop');
    assert.equal(last.usage.completion_tokens, 3);

    behaviour = () => ({ pieces: ['Hello', ' world'] });
  });

  it('refuses tool calling with a clear 400', async () => {
    const res = await post({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /tool and function calling/);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: 'not json',
    });
    assert.equal(res.status, 400);
  });

  it('reports 429 with a retry hint once a key is over its limit', async () => {
    store.setKeyLimits('tool', { rpm: 1, rpd: null });
    const res = await post({ messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.equal((await res.json()).error.type, 'rate_limit_error');

    store.setKeyLimits('tool', { rpm: null, rpd: null });
  });

  it('reports 503 when no account is left', async () => {
    store.setAccountEnabled('primary', false);
    const res = await post({ messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /disabled or cooling down/);

    store.setAccountEnabled('primary', true);
  });

  it('passes a failure from the run through as 502', async () => {
    behaviour = () => new ClaudeError('prompt is too long');
    const res = await post({ messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /prompt is too long/);

    behaviour = () => ({ pieces: ['Hello', ' world'] });
  });

  it('has nothing at an unknown path', async () => {
    const res = await fetch(`${base}/v1/embeddings`, { method: 'POST', headers: { 'x-api-key': key } });
    assert.equal(res.status, 404);
  });
});
