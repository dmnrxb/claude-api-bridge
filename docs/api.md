# API

Two endpoints, plus a health check. Everything is the OpenAI chat shape, so any
client that can point at a custom base URL works without changes.

Base URL is your host plus `/v1`.

## Authentication

Send the API key in either header:

```
Authorization: Bearer cb-...
x-api-key: cb-...
```

OpenAI clients use the first, Anthropic clients the second. Both are checked.

## POST /v1/chat/completions

```bash
curl https://bridge.example.com/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-5",
    "messages": [
      {"role": "system", "content": "Answer in one sentence."},
      {"role": "user", "content": "Why is the sky blue?"}
    ]
  }'
```

Response:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1769000000,
  "model": "claude-opus-5",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 1234, "completion_tokens": 56, "total_tokens": 1290 }
}
```

With `"stream": true` the answer comes back as server sent events, one
`chat.completion.chunk` per piece, then a final chunk carrying
`finish_reason` and `usage`, then `data: [DONE]`.

### What is read from the body

| Field | |
|---|---|
| `messages` | the history, flattened into a single prompt |
| `model` | see the list below |
| `stream` | `true` switches to server sent events |
| `max_tokens` | recorded, then ignored, the CLI has no flag for it |
| `temperature`, `top_p` | ignored, the CLI has no flag for them |

### What is rejected with 400

| Field | Why |
|---|---|
| `tools`, `functions`, `tool_choice` | Claude Code brings its own tools and its own format |
| `response_format` other than `text` | no structured output through the CLI |
| `n` other than 1 | one answer per request |
| non text content parts | images and audio cannot travel through a prompt |

A clear error is better than an answer that quietly ignored half the request.

## GET /v1/models

```bash
curl https://bridge.example.com/v1/models -H "Authorization: Bearer $KEY"
```

A fixed list. It does not ask Anthropic anything, it states what this service
passes through:

| Name | Runs as |
|---|---|
| `claude-opus-5` | Claude Opus 5 |
| `claude-sonnet-5` | Claude Sonnet 5 |
| `claude-haiku-4-5` | Claude Haiku 4.5 |
| `opus`, `sonnet`, `haiku` | the same three |

A name that is not in the list is mapped to `BRIDGE_DEFAULT_MODEL`, and the
response says which model actually answered. Set `BRIDGE_UNKNOWN_MODEL=error`
to get a 400 instead.

## GET /health

No key needed. Used by the Docker health check and handy for a monitor.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "accounts": { "total": 2, "ready": 1 },
  "queue": { "active": 1, "waiting": 0, "limit": 4 }
}
```

## Status codes

| Code | Meaning |
|---|---|
| 400 | something in the body cannot be served, the message says what |
| 401 | no key, or a key that is not known |
| 403 | the key exists but is disabled |
| 404 | no such route |
| 413 | body over 8 MB |
| 429 | the key is over its per minute or per day limit, see `Retry-After` |
| 502 | Claude Code failed, the message carries what it said |
| 503 | no account is usable, or the queue was full |
| 504 | the run passed `BRIDGE_REQUEST_TIMEOUT_MS` |

Errors use the OpenAI shape:

```json
{ "error": { "message": "...", "type": "invalid_request_error", "param": null, "code": null } }
```

When a stream has already started, the error is written into the stream as one
more `data:` frame before `[DONE]`, because the status code is already sent.

## Usage numbers

`usage` comes from what Claude Code reports for the run. Two things to know:

- Claude Code sends its own system prompt with every call, several thousand
  tokens. The counts are therefore higher than the same prompt sent straight to
  the API.
- Web search does not show up in the numbers. It is Claude Code's own tool, not
  Anthropic's server side one.

On a subscription the reported cost is an indication of size, not a bill.
