import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BadRequest, MODELS, chatCompletion, flattenPrompt, modelList, parseChatRequest,
} from '../src/openai.mjs';

const opts = { defaultModel: 'claude-opus-5', unknownModel: 'map' };

describe('parseChatRequest', () => {
  it('pulls the system message out of the history', () => {
    const parsed = parseChatRequest({
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'Answer in one word.' },
        { role: 'user', content: 'Capital of France?' },
      ],
    }, opts);

    assert.equal(parsed.system, 'Answer in one word.');
    assert.equal(parsed.model, 'claude-sonnet-5');
    assert.equal(parsed.prompt, 'Capital of France?');
    assert.equal(parsed.stream, false);
  });

  it('joins several system messages', () => {
    const parsed = parseChatRequest({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'developer', content: 'Use German.' },
        { role: 'user', content: 'hi' },
      ],
    }, opts);
    assert.equal(parsed.system, 'Be brief.\n\nUse German.');
  });

  it('flattens a multi turn history', () => {
    const parsed = parseChatRequest({
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ],
    }, opts);
    assert.equal(parsed.prompt, 'Human: one\n\nAssistant: two\n\nHuman: three\n\nAssistant:');
  });

  it('accepts text content parts', () => {
    const parsed = parseChatRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    }, opts);
    assert.equal(parsed.prompt, 'a\nb');
  });

  it('rejects image parts instead of dropping them', () => {
    assert.throws(() => parseChatRequest({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
    }, opts), BadRequest);
  });

  it('rejects tools, functions and structured output', () => {
    const base = { messages: [{ role: 'user', content: 'hi' }] };
    assert.throws(() => parseChatRequest({ ...base, tools: [] }, opts), /tool and function calling/);
    assert.throws(() => parseChatRequest({ ...base, functions: [] }, opts), /tool and function calling/);
    assert.throws(() => parseChatRequest({ ...base, response_format: { type: 'json_object' } }, opts), /response_format/);
  });

  it('allows response_format text, which asks for nothing special', () => {
    const parsed = parseChatRequest({
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'text' },
    }, opts);
    assert.equal(parsed.prompt, 'hi');
  });

  it('rejects n greater than one', () => {
    assert.throws(() => parseChatRequest({ messages: [{ role: 'user', content: 'hi' }], n: 2 }, opts), /n must be 1/);
  });

  it('rejects an empty history', () => {
    assert.throws(() => parseChatRequest({ messages: [] }, opts), /non-empty array/);
    assert.throws(() => parseChatRequest({ messages: [{ role: 'system', content: 'x' }] }, opts), /at least one user/);
  });

  it('maps an unknown model onto the default', () => {
    const parsed = parseChatRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, opts);
    assert.equal(parsed.model, 'claude-opus-5');
    assert.equal(parsed.requestedModel, 'gpt-4o');
  });

  it('refuses an unknown model when told to', () => {
    assert.throws(
      () => parseChatRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        { ...opts, unknownModel: 'error' }),
      /unknown model/,
    );
  });

  it('resolves the short aliases', () => {
    assert.equal(parseChatRequest({ model: 'haiku', messages: [{ role: 'user', content: 'x' }] }, opts).model, 'claude-haiku-4-5');
  });

  it('reads max_tokens but does not act on it', () => {
    const parsed = parseChatRequest({ messages: [{ role: 'user', content: 'x' }], max_tokens: 100 }, opts);
    assert.equal(parsed.maxTokens, 100);
  });
});

describe('response shapes', () => {
  it('builds a chat completion an OpenAI client can read', () => {
    const body = chatCompletion({
      id: 'chatcmpl-1',
      model: 'claude-opus-5',
      text: 'Paris',
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'Paris');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.usage.total_tokens, 12);
  });

  it('lists every name it accepts', () => {
    const list = modelList();
    assert.equal(list.object, 'list');
    assert.deepEqual(list.data.map((m) => m.id).sort(), Object.keys(MODELS).sort());
  });
});

describe('flattenPrompt', () => {
  it('leaves a single question alone', () => {
    assert.equal(flattenPrompt([{ role: 'user', text: 'hello' }]), 'hello');
  });
});
