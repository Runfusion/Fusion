# OpenClaw Runtime Plugin

Provides an executable OpenClaw runtime plugin for Fusion. This package enables runtime registration, discovery, and session execution so agents configured with `runtimeConfig.runtimeHint: "openclaw"` can run through the standard runtime adapter contract.

## Overview

This plugin follows the runtime adapter pattern used by other executable plugin runtimes:

- Registers OpenClaw runtime metadata for resolver discovery
- Creates executable runtime sessions via `createFnAgent`
- Delegates prompt execution through `promptWithFallback`
- Exposes model descriptions through `describeModel`
- Supports best-effort session disposal via `dispose()`

## Installation

### Option 1: Copy to plugins directory

```bash
cp -r fusion-plugin-openclaw-runtime ~/.fusion/plugins/
```

### Option 2: Install via CLI

```bash
fn plugin add ./plugins/fusion-plugin-openclaw-runtime
```

## Runtime Metadata

- **Plugin ID:** `fusion-plugin-openclaw-runtime`
- **Package name:** `@fusion-plugin-examples/openclaw-runtime`
- **Runtime ID:** `openclaw`
- **Runtime name:** `OpenClaw Runtime`
- **Version:** `0.1.0`
- **Description:** OpenClaw-backed AI session using the user's configured pi provider and model

## Agent Configuration

Configure an agent to target OpenClaw via `runtimeConfig.runtimeHint`:

```json
{
  "name": "OpenClaw Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "openclaw"
  }
}
```

## Local Development

```bash
# Run plugin tests
pnpm --filter @fusion-plugin-examples/openclaw-runtime test

# Build plugin output to dist/
pnpm --filter @fusion-plugin-examples/openclaw-runtime build
```
