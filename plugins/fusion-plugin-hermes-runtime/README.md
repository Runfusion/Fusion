# Hermes Runtime Plugin

Hermes is a **raw-model runtime** plugin for Fusion. It creates and manages LLM sessions directly through [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai), without using Fusion's internal Pi coding-agent pipeline.

## What it does

- Resolves provider/model settings from plugin settings, environment variables, and defaults
- Creates in-memory streaming sessions with `streamSimple(...)`
- Maintains conversation history (`messages`) inside the plugin session
- Streams text/thinking/tool-call deltas through runtime callbacks
- Exposes model description as `<provider>/<modelId>`

## How it differs from the default Pi runtime

| Runtime | Behavior |
| --- | --- |
| Default Pi runtime (`pi`) | Full coding-agent flow (`createFnAgent`, tool execution, skill/session manager integration) |
| Hermes runtime (`hermes`) | Direct pi-ai model streaming (no coding-agent tool execution pipeline) |

Hermes is intentionally lightweight: it does not execute tools or perform filesystem workflows like the coding agent.

## Configuration

Hermes resolves settings in this order:

1. Plugin settings (`ctx.settings`)
2. Environment variables
3. Built-in defaults

### Plugin settings

```json
{
  "provider": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "apiKey": "...optional...",
  "thinkingLevel": "medium"
}
```

### Environment variable fallbacks

- `HERMES_PROVIDER`
- `HERMES_MODEL_ID`
- `HERMES_API_KEY`
- `HERMES_THINKING_LEVEL`

### Defaults

- `provider`: `anthropic`
- `modelId`: `claude-sonnet-4-5`
- `apiKey`: `undefined`
- `thinkingLevel`: `undefined`

## Runtime contract notes

Hermes accepts the standard `AgentRuntimeOptions` shape for compatibility, but these Pi-specific fields are **silently ignored**:

- `cwd`
- `tools`
- `skills`
- `customTools`
- `sessionManager`
- `skillSelection`

The runtime returns `sessionFile: undefined` because Hermes sessions are in-memory.

## Metadata

- **Plugin ID:** `fusion-plugin-hermes-runtime`
- **Runtime ID:** `hermes`
- **Runtime name:** `Hermes Runtime`
- **Package:** `@fusion-plugin-examples/hermes-runtime`

## Development

```bash
pnpm --filter @fusion-plugin-examples/hermes-runtime test
pnpm --filter @fusion-plugin-examples/hermes-runtime build
```
