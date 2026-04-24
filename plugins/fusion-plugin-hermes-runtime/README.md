# Hermes Runtime Plugin

> **Status:** Experimental placeholder runtime (current behavior)

Provides a Hermes runtime plugin for Fusion. The plugin is active today for runtime registration/discovery and runtime selection via `runtimeConfig.runtimeHint: "hermes"`.

## What it does today

- Registers Hermes runtime metadata with the plugin system
- Exposes a runtime factory that returns a placeholder runtime object
- Emits `hermes-runtime:loaded` on plugin load
- Supports runtime routing with `runtimeHint: "hermes"`

## Current behavior and limitations

This plugin currently provides **registration + placeholder execution semantics**.

- Runtime factory returns an object with:
  - `runtimeId: "hermes"`
  - `version: "0.1.0"`
  - `status: "deferred"`
  - `message` describing placeholder/deferred status
  - `execute()` function
- Calling `execute()` always throws a not-implemented error.
- Runtime creation itself does **not** throw.

Expected execution failure message includes:

```
Hermes runtime is not yet implemented. Full implementation deferred to FN-2264. See https://github.com/gsxdsm/fusion/issues/FN-2264
```

## Installation

### Option 1: Copy to plugins directory

```bash
cp -r fusion-plugin-hermes-runtime ~/.fusion/plugins/
```

### Option 2: Install via CLI

```bash
fn plugin add ./plugins/fusion-plugin-hermes-runtime
```

## Runtime routing (`runtimeHint`)

To route an agent to Hermes, set `runtimeConfig.runtimeHint` to `"hermes"`:

```json
{
  "name": "Hermes Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "hermes"
  }
}
```

> ⚠️ With the current placeholder runtime, agent/session selection can target Hermes successfully, but runtime `execute()` will throw.

## Source-of-truth metadata

### `manifest.json`

```json
{
  "id": "fusion-plugin-hermes-runtime",
  "name": "Hermes Runtime Plugin",
  "version": "0.1.0",
  "description": "Hermes AI runtime plugin for Fusion - provides AI agent execution runtime capabilities",
  "author": "Fusion Team",
  "homepage": "https://github.com/gsxdsm/fusion",
  "runtime": {
    "runtimeId": "hermes",
    "name": "Hermes Runtime",
    "description": "Experimental Hermes runtime integration for Fusion tasks (implementation deferred to FN-2264)",
    "version": "0.1.0"
  }
}
```

### Runtime metadata (from `src/index.ts`)

- **Runtime ID:** `hermes`
- **Name:** `Hermes Runtime`
- **Version:** `0.1.0`
- **Description:** `Experimental Hermes runtime integration for Fusion tasks (implementation deferred to FN-2264)`

## Development

```bash
# Install dependencies
pnpm install

# Run plugin tests
pnpm --filter @fusion-plugin-examples/hermes-runtime test

# Build
pnpm build
```

## Test coverage

The plugin tests validate:

- Manifest identity
- Runtime registration + metadata consistency
- Placeholder runtime return shape (`status: "deferred"`)
- `execute()` failure semantics
- Hook behavior (`onLoad`, `onUnload`, event emission)

## Exports

- `default` — plugin instance
- `hermesRuntimeMetadata` — runtime metadata object
- `hermesRuntimeFactory` — runtime factory
- `HERMES_RUNTIME_ID` — runtime ID constant (`"hermes"`)

## License

MIT
