# Paperclip Runtime Plugin

A Fusion plugin that provides the **Paperclip runtime** for AI agents, using the existing pi backend for session management.

## Overview

This plugin provides a runtime adapter that wraps the existing `createFnAgent` and `promptWithFallback` functions from `@fusion/engine`, making the pi-based agent session available through Fusion's plugin runtime system.

## Runtime ID

| Property | Value |
|----------|-------|
| **Runtime ID** | `paperclip` |
| **Name** | `Paperclip Runtime` |
| **Version** | `1.0.0` |

## Installation

### Prerequisites

1. Install pi globally:

```bash
npm i -g @mariozechner/pi-coding-agent
```

2. Authenticate pi with your AI provider:

```bash
pi
# Follow the login flow for your provider
```

### Install the Plugin

Install the plugin as a local plugin:

```bash
fn plugin add ./plugins/fusion-plugin-paperclip-runtime
```

Verify installation:

```bash
fn plugin list
# Should show fusion-plugin-paperclip-runtime
```

## Configuration

### Plugin Discovery

After installation, the Paperclip runtime is automatically discovered by Fusion's plugin system when the plugin is loaded. No additional configuration is required to make the runtime available.

### Selecting the Paperclip Runtime

Once the plugin is installed, you can select the Paperclip runtime for agents by setting `runtimeHint` in the agent's `runtimeConfig`.

#### Via Agent Configuration

Set the runtime hint in an agent's `runtimeConfig`:

```json
{
  "name": "Paperclip Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "paperclip"
  }
}
```

When an agent with `runtimeHint: "paperclip"` is assigned to a task, the task's executor session will use the Paperclip Runtime Adapter.

#### How Runtime Selection Works

1. When an agent session is created, Fusion checks the agent's `runtimeConfig.runtimeHint`
2. If `runtimeHint` is set to `"paperclip"`, Fusion resolves the Paperclip Runtime from the plugin
3. If the plugin is not installed or unavailable, Fusion falls back to the default `pi` runtime
4. If `runtimeHint` is not set, Fusion uses the default `pi` runtime

### Fallback Behavior

If the Paperclip runtime is unavailable (plugin not installed, not enabled, or factory error), Fusion automatically falls back to the default `pi` runtime with a warning log:

```
[runtime-resolver] Runtime "paperclip" unavailable (not_found), falling back to default pi runtime
```

The fallback behavior ensures tasks continue executing even if the plugin is misconfigured.

## Runtime Resolution Order

When resolving a runtime, Fusion follows this order:

1. **No runtime hint** → Use default `pi` runtime
2. **Hint is `"pi"` or `"default"`** → Use default `pi` runtime
3. **Hint is a plugin runtime ID** (e.g., `"paperclip"`) → Look up and instantiate the plugin runtime
4. **Plugin runtime unavailable** → Fall back to default `pi` runtime

## Supported Session Purposes

The Paperclip runtime supports all Fusion agent session purposes:

- `executor` — Task implementation
- `triage` — Task specification
- `reviewer` — Code/plan review
- `merger` — Merge operations
- `heartbeat` — Health monitoring
- `validation` — Workflow step validation

## Interface Implementation

The Paperclip Runtime Adapter implements the `AgentRuntime` interface:

| Method | Description |
|--------|-------------|
| `id` | Returns `"paperclip"` |
| `name` | Returns `"Paperclip Runtime"` |
| `createSession(options)` | Creates a session using `createFnAgent` from `@fusion/engine` |
| `promptWithFallback(session, prompt, options?)` | Delegates to pi's `promptWithFallback` with automatic retry and compaction |
| `describeModel(session)` | Returns `"<provider>/<modelId>"` or `"unknown model"` |
| `dispose(session)` | Calls `session.dispose()` if available |

## Credentials

The Paperclip runtime uses the user's existing pi configuration:

- **No additional credentials required** — Reuses pi's authenticated provider
- **Provider/model** — Sourced from pi's configured default
- **Fallback provider/model** — Uses pi's configured fallback if set

If pi is not authenticated, session creation will fail and fall back to the default `pi` runtime.

## Constraints

### Prerequisites

- `pi` must be installed globally (`npm i -g @mariozechner/pi-coding-agent`)
- `pi` must be authenticated with at least one AI provider
- The plugin must be installed and enabled in Fusion
- The agent must have `runtimeConfig.runtimeHint` set to `"paperclip"` to use this runtime

### Limitations

- **No task-level runtime selection**: Runtime selection is configured at the agent level via `runtimeConfig.runtimeHint`, not at the task level. Tasks inherit the runtime from their assigned agent.
- **Session persistence**: The Paperclip runtime uses pi's session management. Sessions are persisted to disk according to pi's configuration.
- **Tool selection**: Tool availability is controlled by the `skills` parameter passed to `createSession`, not by the runtime itself.
- **Model selection**: Model selection is determined by pi's configuration, not by the runtime adapter.

### Compatibility

The Paperclip runtime is compatible with all Fusion session purposes. It wraps the same underlying implementation used by the default `pi` runtime, ensuring feature parity.

## Verification

### Check Plugin Status

```bash
fn plugin list
```

### Verify Agent Configuration

Check that the agent has the correct `runtimeConfig`:

```bash
fn agent list
# Look for agents with runtimeHint: "paperclip" in their runtimeConfig
```

### Verify Runtime Resolution

Enable debug logging and look for runtime resolution messages:

```
[runtime-resolver] [executor] Using configured plugin runtime "paperclip" from "fusion-plugin-paperclip-runtime"
```

Or fallback warnings (when plugin is unavailable):

```
[runtime-resolver] [executor] Runtime "paperclip" unavailable (not_found), falling back to default pi runtime
```

## Development

### Build

```bash
cd plugins/fusion-plugin-paperclip-runtime
pnpm build
```

### Test

```bash
cd plugins/fusion-plugin-paperclip-runtime
pnpm test
```

### Project Structure

```
fusion-plugin-paperclip-runtime/
├── manifest.json           # Plugin metadata with runtime declaration
├── src/
│   ├── index.ts           # Plugin entry point with runtime registration
│   ├── runtime-adapter.ts # PaperclipRuntimeAdapter implementation
│   └── types.ts           # Type re-exports
├── README.md
└── package.json
```

## Architecture

This plugin follows the Fusion plugin runtime contract defined in [FN-2256](https://github.com/gsxdsm/fusion/issues/FN-2256).

### Runtime Registration

Runtimes are registered via the plugin's `runtime` field:

```typescript
const plugin = definePlugin({
  manifest: { /* ... */ },
  runtime: {
    metadata: {
      runtimeId: "paperclip",
      name: "Paperclip Runtime",
      description: "Paperclip-backed AI session using the user's configured pi provider and model",
      version: "1.0.0",
    },
    factory: paperclipRuntimeFactory,
  },
});
```

### Runtime Factory

The factory function creates a new `PaperclipRuntimeAdapter` instance when the runtime is resolved:

```typescript
async function paperclipRuntimeFactory(): Promise<PaperclipRuntimeAdapter> {
  return new PaperclipRuntimeAdapter();
}
```

## Related

- [FN-2256](https://github.com/gsxdsm/fusion/issues/FN-2256) — Runtime contract definition
- [FN-2260](https://github.com/gsxdsm/fusion/issues/FN-2260) — Plugin scaffold
- [Runtime Resolution](../packages/engine/src/runtime-resolution.ts) — Engine runtime resolution implementation
