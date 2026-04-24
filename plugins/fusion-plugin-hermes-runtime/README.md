# Hermes Runtime Plugin

Provides an executable Hermes runtime plugin for Fusion. This package enables runtime registration, discovery, and session execution so agents configured with `runtimeConfig.runtimeHint: "hermes"` can run through the standard runtime adapter contract.

## Overview

This plugin follows the runtime adapter pattern used by other executable plugin runtimes:

- Registers Hermes runtime metadata for resolver discovery
- Creates executable runtime sessions via `createFnAgent`
- Delegates prompt execution through `promptWithFallback`
- Exposes model descriptions through `describeModel`
- Supports best-effort session disposal via `dispose()`

## Installation

### Option 1: Copy to plugins directory

```bash
cp -r fusion-plugin-hermes-runtime ~/.fusion/plugins/
```

### Option 2: Install via CLI

```bash
fn plugin add ./plugins/fusion-plugin-hermes-runtime
```

## Runtime Metadata

- **Plugin ID:** `fusion-plugin-hermes-runtime`
- **Package name:** `@fusion-plugin-examples/hermes-runtime`
- **Runtime ID:** `hermes`
- **Runtime name:** `Hermes Runtime`
- **Version:** `0.1.0`
- **Description:** Hermes-backed AI session using the user's configured pi provider and model

## Agent Configuration

Configure an agent to target Hermes via `runtimeConfig.runtimeHint`:

```json
{
  "name": "Hermes Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "hermes"
  }
}
```

## Local Development

```bash
# Run plugin tests
pnpm --filter @fusion-plugin-examples/hermes-runtime test

# Build plugin output to dist/
pnpm --filter @fusion-plugin-examples/hermes-runtime build
```
