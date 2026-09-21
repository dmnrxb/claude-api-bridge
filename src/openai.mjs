import { randomUUID } from 'node:crypto';

// Model names the bridge answers for. The left side is what a caller may send,
// the right side is what goes into `claude --model`. Claude Code resolves the
// short aliases itself; the full ids are here so an OpenAI client that pins a
// version still works.
export const MODELS = {
  'claude-opus-5': 'claude-opus-5',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-haiku-4-5': 'claude-haiku-4-5',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};

export function modelList(created = 1735689600) {
  return {
    object: 'list',
    data: Object.keys(MODELS).map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: 'anthropic',
    })),
  };
}

export class BadRequest extends Error {
  constructor(message, { code = 'invalid_request_error', param = null, status = 400 } = {}) {
    super(message);
    this.code = code;
    this.param = param;
    this.status = status;
  }
}

export function errorBody(message, { type = 'invalid_request_error', code = null, param = null } = {}) {
  return { error: { message, type, param, code } };
}

// OpenAI allows content to be a string or an array of parts. Anything that is
// not text cannot survive the trip through a command line prompt, so it is
// rejected rather than dropped.
function textOf(content, where) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else throw new BadRequest(`${where}: only text content is supported, got "${part?.type ?? typeof part}"`, { param: 'messages' });
    }
    return parts.join('\n');
  }
  throw new BadRequest(`${where}: content must be a string or an array of text parts`, { param: 'messages' });
}

export function parseChatRequest(body, { defaultModel, unknownModel = 'map' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('request body must be a JSON object');
  }

  // Features Claude Code cannot express. Better a clear 400 than a response
  // that quietly ignores half the request.
  if (body.tools || body.functions || body.tool_choice || body.function_call) {
    throw new BadRequest(
      'tool and function calling is not supported, the bridge runs Claude Code which has its own tools',
      { param: body.tools ? 'tools' : 'functions' },
    );
  }
  if (body.response_format && body.response_format.type !== 'text') {
    throw new BadRequest('response_format is not supported, ask for the format in the prompt instead', { param: 'response_format' });
  }
  if (body.n !== undefined && body.n !== 1) {
    throw new BadRequest('n must be 1, the bridge returns a single choice', { param: 'n' });
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequest('messages must be a non-empty array', { param: 'messages' });
  }

  const systemParts = [];
  const turns = [];

  for (const [i, message] of messages.entries()) {
    if (!message || typeof message !== 'object') {
      throw new BadRequest(`messages[${i}] must be an object`, { param: 'messages' });
    }
    const role = message.role;
    const text = textOf(message.content, `messages[${i}]`);
    if (role === 'system' || role === 'developer') {
      if (text.trim()) systemParts.push(text.trim());
    } else if (role === 'user' || role === 'assistant') {
      turns.push({ role, text });
    } else if (role === 'tool' || role === 'function') {
      throw new BadRequest(`messages[${i}]: tool results are not supported`, { param: 'messages' });
    } else {
      throw new BadRequest(`messages[${i}]: unknown role "${role}"`, { param: 'messages' });
    }
  }

  if (turns.length === 0) {
    throw new BadRequest('messages must contain at least one user or assistant message', { param: 'messages' });
  }

  const requested = typeof body.model === 'string' && body.model ? body.model : defaultModel;
  let model = MODELS[requested];
  if (!model) {
    if (unknownModel === 'error') {
      throw new BadRequest(
        `unknown model "${requested}", known names: ${Object.keys(MODELS).join(', ')}`,
        { param: 'model', code: 'model_not_found' },
      );
    }
    model = MODELS[defaultModel] ?? defaultModel;
  }

  return {
    model,
    requestedModel: requested,
    system: systemParts.join('\n\n'),
    prompt: flattenPrompt(turns),
    stream: body.stream === true,
    // Read and carried into the stats so usage stays comparable, but the CLI
    // has no flag for it.
    maxTokens: Number.isInteger(body.max_tokens) ? body.max_tokens : null,
  };
}

// One request, one prompt, one Claude Code run. Nothing is kept between calls,
// so the whole history has to travel in the prompt.
export function flattenPrompt(turns) {
  if (turns.length === 1 && turns[0].role === 'user') return turns[0].text;
  const lines = turns.map((t) => `${t.role === 'user' ? 'Human' : 'Assistant'}: ${t.text}`);
  lines.push('Assistant:');
  return lines.join('\n\n');
}

export function completionId() {
  return `chatcmpl-${randomUUID().replaceAll('-', '')}`;
}

export function chatCompletion({ id, model, text, usage, finishReason = 'stop' }) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      logprobs: null,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: usage?.inputTokens ?? 0,
      completion_tokens: usage?.outputTokens ?? 0,
      total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    },
  };
}

export function chunk({ id, model, delta, finishReason = null, usage = null }) {
  const out = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
  if (usage) {
    out.usage = {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    };
  }
  return out;
}

export function sse(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}
