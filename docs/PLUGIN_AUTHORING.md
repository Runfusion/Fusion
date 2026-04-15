# Plugin Authoring Guide

A comprehensive guide to creating Fusion plugins that extend the task board with custom tools, routes, and lifecycle hooks.

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Plugin Manifest Reference](#2-plugin-manifest-reference)
3. [Plugin Settings Schema](#3-plugin-settings-schema)
4. [Available Hooks and Signatures](#4-available-hooks-and-signatures)
5. [Registering Tools](#5-registering-tools)
6. [Registering Routes](#6-registering-routes)
7. [Plugin Context API Reference](#7-plugin-context-api-reference)
8. [Plugin Lifecycle States](#8-plugin-lifecycle-states)
9. [Testing Plugins](#9-testing-plugins)
10. [Publishing Plugins](#10-publishing-plugins)
11. [Example Plugins](#11-example-plugins)

---

## 1. Getting Started

### What Are Fusion Plugins?

Fusion plugins extend the task board with custom functionality:

- **Lifecycle Hooks**: React to task creation, movement, completion, and errors
- **AI Agent Tools**: Add custom tools that AI agents can use during task execution
- **Custom API Routes**: Create dashboard API endpoints for frontend integration
- **Settings**: Accept user configuration via typed settings schemas

### Prerequisites

- Node.js 18+
- TypeScript familiarity
- A Fusion project with the plugin system installed

### Quick Start

Create a new plugin using the scaffold command:

```bash
fn plugin create my-first-plugin
cd my-first-plugin
pnpm install
pnpm test
```

### Plugin Project Structure

```
my-plugin/
├── package.json          # Plugin metadata + "fusion-plugin" keyword
├── tsconfig.json         # TypeScript configuration
├── vitest.config.ts      # Test configuration
├── src/
│   ├── index.ts         # Plugin entry point (exports default FusionPlugin)
│   └── __tests__/
│       └── index.test.ts # Plugin tests
└── README.md            # Plugin documentation
```

---

## 2. Plugin Manifest Reference

The manifest defines your plugin's metadata and capabilities:

```typescript
import type { PluginManifest } from "@fusion/plugin-sdk";

const manifest: PluginManifest = {
  id: "my-custom-plugin",           // Unique identifier (kebab-case)
  name: "My Custom Plugin",          // Human-readable name
  version: "1.0.0",                  // Semver version
  description: "Does something useful",
  author: "Your Name",
  homepage: "https://github.com/you/plugin",
  fusionVersion: ">=1.0.0",         // Optional: minimum Fusion version
  dependencies: [],                   // Optional: plugin IDs this depends on
  settingsSchema: { /* ... */ },    // Optional: configuration schema
};
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier (kebab-case, validated) |
| `name` | string | Yes | Human-readable display name |
| `version` | string | Yes | Semver version (e.g., "1.0.0") |
| `description` | string | No | Short description |
| `author` | string | No | Author name or organization |
| `homepage` | string | No | URL to documentation or repository |
| `fusionVersion` | string | No | Minimum Fusion version required |
| `dependencies` | string[] | No | IDs of plugins this depends on |
| `settingsSchema` | Record<string, PluginSettingSchema> | No | Configuration schema |

---

## 3. Plugin Settings Schema

Settings allow users to configure your plugin through the dashboard:

```typescript
import type { PluginSettingSchema } from "@fusion/plugin-sdk";

const settingsSchema: Record<string, PluginSettingSchema> = {
  webhookUrl: {
    type: "string",
    label: "Webhook URL",
    description: "URL to send notifications to",
    required: true,
  },
  maxRetries: {
    type: "number",
    label: "Max Retries",
    description: "Maximum number of retry attempts",
    defaultValue: 3,
  },
  enabled: {
    type: "boolean",
    label: "Enable Feature",
    description: "Toggle the feature on/off",
    defaultValue: true,
  },
  severity: {
    type: "enum",
    label: "Log Severity",
    description: "Minimum severity level to log",
    enumValues: ["debug", "info", "warn", "error"],
    defaultValue: "info",
  },
};
```

### Setting Types

| Type | Description | Extra Fields |
|------|-------------|--------------|
| `"string"` | Text input | `multiline?: boolean` (renders textarea) |
| `"number"` | Numeric input | — |
| `"boolean"` | Toggle switch | — |
| `"enum"` | Dropdown select | `enumValues: string[]` |
| `"password"` | Password input (hidden) | — |
| `"array"` | Dynamic list with add/remove | `itemType: "string" \| "number"` |

### Example: All Setting Types

```typescript
const settingsSchema: Record<string, PluginSettingSchema> = {
  // Simple string input
  username: {
    type: "string",
    label: "Username",
    description: "Your username",
  },
  
  // Multiline text area
  message: {
    type: "string",
    label: "Message",
    description: "Multi-line message",
    multiline: true,
    defaultValue: "Hello!",
  },
  
  // Password input (hidden)
  apiSecret: {
    type: "password",
    label: "API Secret",
    description: "Your secret key",
  },
  
  // Number input
  maxRetries: {
    type: "number",
    label: "Max Retries",
    defaultValue: 3,
  },
  
  // Boolean toggle
  enabled: {
    type: "boolean",
    label: "Enable Feature",
    defaultValue: true,
  },
  
  // Dropdown select
  severity: {
    type: "enum",
    label: "Severity",
    enumValues: ["debug", "info", "warn", "error"],
    defaultValue: "info",
  },
  
  // Array of strings
  tags: {
    type: "array",
    label: "Tags",
    description: "Tags to track",
    itemType: "string",
    defaultValue: ["bug", "feature"],
  },
  
  // Array of numbers
  thresholds: {
    type: "array",
    label: "Thresholds",
    itemType: "number",
    defaultValue: [10, 20, 30],
  },
};
```

### Accessing Settings

Settings are available in hooks via `ctx.settings`:

```typescript
hooks: {
  onLoad: (ctx) => {
    const webhookUrl = ctx.settings.webhookUrl as string;
    if (!webhookUrl) {
      ctx.logger.warn("No webhook URL configured");
    }
  },
},
```

---

## 4. Available Hooks and Signatures

Hooks let your plugin react to events in the Fusion system:

```typescript
import type { FusionPlugin, PluginContext } from "@fusion/plugin-sdk";

const plugin: FusionPlugin = {
  manifest: { /* ... */ },
  state: "installed",
  hooks: {
    onLoad: async (ctx) => {
      ctx.logger.info("Plugin loaded!");
    },
    onTaskCreated: async (task, ctx) => {
      ctx.logger.info(`New task: ${task.title}`);
    },
    // ... other hooks
  },
};
```

### Hook Reference

| Hook | Signature | When It Fires |
|------|-----------|---------------|
| `onLoad` | `(ctx: PluginContext) => Promise<void> \| void` | Plugin first loaded and started |
| `onUnload` | `() => Promise<void> \| void` | Plugin stopped/shutdown |
| `onTaskCreated` | `(task: Task, ctx: PluginContext) => Promise<void> \| void` | New task created |
| `onTaskMoved` | `(task: Task, fromColumn: string, toColumn: string, ctx: PluginContext) => Promise<void> \| void` | Task moved between columns |
| `onTaskCompleted` | `(task: Task, ctx: PluginContext) => Promise<void> \| void` | Task reached "done" |
| `onError` | `(error: Error, ctx: PluginContext) => Promise<void> \| void` | Error occurred in plugin execution |

### Hook Behavior

- **Timeout**: 5 seconds per invocation (logged and skipped if exceeded)
- **Error Isolation**: Hook failures never block the host system
- **Optional**: Only define the hooks you need

### Example: Notification on Task Completion

```typescript
hooks: {
  onTaskCompleted: async (task, ctx) => {
    const webhookUrl = ctx.settings.webhookUrl as string;
    if (!webhookUrl) return;

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `✅ Task completed: ${task.title || task.id}`,
      }),
    });
  },
},
```

---

## 5. Registering Tools

Tools extend AI agents with custom capabilities:

```typescript
import type { FusionPlugin, PluginToolDefinition, PluginToolResult } from "@fusion/plugin-sdk";

const myTool: PluginToolDefinition = {
  name: "my_custom_tool",
  description: "Does something useful with input text",
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The text to process",
      },
    },
    required: ["input"],
  },
  execute: async (params, ctx) => {
    const input = params.input as string;

    // Do something useful...
    const result = input.toUpperCase();

    return {
      content: [{ type: "text", text: result }],
    };
  },
};

const plugin: FusionPlugin = {
  manifest: { /* ... */ },
  state: "installed",
  tools: [myTool],
};
```

### Tool Naming

- Use a unique name prefixed with your plugin ID (e.g., `my-plugin_action`)
- Avoid conflicts with built-in tools

### Tool Result Format

```typescript
interface PluginToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}
```

---

## 6. Registering Routes

Routes create custom API endpoints in the dashboard:

```typescript
import type { FusionPlugin, PluginRouteDefinition } from "@fusion/plugin-sdk";

const routes: PluginRouteDefinition[] = [
  {
    method: "GET",
    path: "/status",
    description: "Get plugin status",
    handler: async (req, ctx) => {
      return { status: "ok", uptime: process.uptime() };
    },
  },
  {
    method: "POST",
    path: "/action",
    description: "Perform an action",
    handler: async (req, ctx) => {
      // Access request body
      const body = req as { action?: string };
      ctx.logger.info(`Action: ${body.action}`);
      return { success: true };
    },
  },
];

const plugin: FusionPlugin = {
  manifest: { /* ... */ },
  state: "installed",
  routes,
};
```

### Route Mounting

Routes are mounted at `/api/plugins/{pluginId}/{path}`:

- Plugin ID: `fusion-plugin-notification`
- Route path: `/status`
- Full URL: `/api/plugins/fusion-plugin-notification/status`

### Supported Methods

- `GET`
- `POST`
- `PUT`
- `DELETE`

---

## 7. Plugin Context API Reference

The context object is passed to hooks, tools, and route handlers:

```typescript
interface PluginContext {
  pluginId: string;
  taskStore: TaskStore;
  settings: Record<string, unknown>;
  logger: PluginLogger;
  emitEvent: (event: string, data: unknown) => void;
}
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `pluginId` | `string` | Your plugin's unique ID |
| `taskStore` | `TaskStore` | Access to task data (read-only) |
| `settings` | `Record<string, unknown>` | User configuration (merged with defaults) |
| `logger` | `PluginLogger` | Structured logging |
| `emitEvent` | `(event, data) => void` | Emit custom events |

### Logger Methods

```typescript
interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}
```

### Example: Using the Context

```typescript
hooks: {
  onLoad: (ctx) => {
    ctx.logger.info("Plugin starting...");

    // Access settings
    const apiKey = ctx.settings.apiKey as string;

    // Emit custom event
    ctx.emitEvent("my-plugin:ready", { timestamp: Date.now() });
  },
},
```

---

## 8. Plugin Lifecycle States

Plugins transition through these states:

```
┌────────────┐
│ installed  │ (registered, not loaded)
└─────┬──────┘
      │ enable
      ▼
┌────────────┐
│  started   │ ←─────┐ (loaded, hooks active)
└─────┬──────┘       │
      │              │ load
      │ stop         │
      ▼              │
┌────────────┐       │
│  stopped   │ ──────┘
└────────────┘

Any state can transition to:
┌────────────┐
│   error    │ (load failure or runtime error)
└────────────┘
```

### State Descriptions

| State | Description |
|-------|-------------|
| `installed` | Plugin registered but not yet loaded |
| `started` | Plugin loaded and hooks active |
| `stopped` | Plugin shut down gracefully |
| `error` | Plugin failed during load or execution |

---

## 9. Testing Plugins

Use Vitest for unit testing your plugins:

### Test Structure

```typescript
// src/__tests__/index.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import plugin from "../index.js";

describe("my plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should export a valid plugin", () => {
    expect(plugin.manifest.id).toBe("my-plugin");
    expect(plugin.manifest.name).toBeDefined();
  });

  it("should call onLoad hook", async () => {
    const mockCtx = {
      pluginId: "my-plugin",
      settings: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      emitEvent: vi.fn(),
      taskStore: {},
    };

    await plugin.hooks.onLoad?.(mockCtx as any);
    expect(mockCtx.logger.info).toHaveBeenCalled();
  });
});
```

### Testing Tools

```typescript
it("should return correct result from tool", async () => {
  const tool = plugin.tools![0];
  const mockCtx = { /* ... */ };

  const result = await tool.execute({ input: "hello" }, mockCtx as any);

  expect(result.content[0].text).toBe("HELLO");
});
```

### Testing Routes

```typescript
it("should return status from GET /status", async () => {
  const route = plugin.routes!.find(r => r.path === "/status");
  const req = { params: {}, method: "GET", url: "/status" };
  const ctx = { /* ... */ };

  const result = await route.handler(req as any, ctx as any);

  expect(result).toHaveProperty("status");
});
```

### Running Tests

```bash
pnpm test
```

---

## 10. Publishing Plugins

### Package Requirements

```json
{
  "name": "fusion-plugin-my-plugin",
  "version": "1.0.0",
  "keywords": ["fusion-plugin"],
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./dist/index.js"
    }
  },
  "peerDependencies": {
    "@fusion/core": "workspace:*"
  }
}
```

### Publishing Steps

1. Update `package.json`:
   - Set `name` to `fusion-plugin-*` or `@scope/fusion-plugin-*`
   - Add `"keywords": ["fusion-plugin"]`
   - Set `"private": false`

2. Build the plugin:
   ```bash
   pnpm build
   ```

3. Publish to npm:
   ```bash
   npm publish --access public
   ```

### Installation

Users can install your plugin via CLI:

```bash
fn plugin install fusion-plugin-my-plugin
# or
fn plugin install @scope/fusion-plugin-my-plugin
```

Or by copying to the plugins directory:

```bash
cp -r fusion-plugin-my-plugin ~/.fusion/plugins/
```

---

## 11. Example Plugins

Explore these reference implementations:

### [Notification Plugin](../../plugins/examples/fusion-plugin-notification/)

Sends webhook notifications on task lifecycle events (Slack, Discord, generic HTTP).

- Demonstrates: `onLoad`, `onTaskCompleted`, `onTaskMoved`, `onError` hooks
- Features: Settings schema, webhook formatting, event filtering

### [Auto-Label Plugin](../../plugins/examples/fusion-plugin-auto-label/)

Automatically labels tasks based on description content using keyword matching.

- Demonstrates: `onTaskCreated` hook, AI agent tools
- Features: Text classification, event emission, tool registration

### [CI Status Plugin](../../plugins/examples/fusion-plugin-ci-status/)

Polls CI status for branches and provides custom API endpoints.

- Demonstrates: Custom routes, periodic background work, route handlers
- Features: `onLoad`/`onUnload` lifecycle, `setInterval` polling, REST API

### [Settings Demo Plugin](../../plugins/examples/fusion-plugin-settings-demo/)

Example plugin demonstrating settings schema and runtime configuration with all four setting types.

- Demonstrates: Settings schema (string, number, boolean, enum), hooks that read settings, tools with settings-driven output
- Features: Configurable greeting message, tag limit, logging toggle, log level selector
- **Install from Settings**: Designed to be installed via the dashboard Settings → Plugins UI

### Installing Example Plugins from Settings

All example plugins can be installed via the dashboard Settings → Plugins UI:

1. Open Fusion dashboard and navigate to **Settings** (gear icon in header)
2. Click **Plugins** in the sidebar
3. Click the **Install** button
4. Enter the absolute path to the plugin directory (e.g., `/path/to/fusion/plugins/examples/fusion-plugin-settings-demo`)
5. Click **Install** to register the plugin
6. Enable the plugin using the toggle switch
7. Configure settings via the settings (gear) icon
8. The plugin will reload automatically with new settings

---

## Quick Reference

### Minimal Plugin

```typescript
import { definePlugin } from "@fusion/plugin-sdk";

export default definePlugin({
  manifest: {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
  },
  state: "installed",
  hooks: {
    onLoad: (ctx) => {
      ctx.logger.info("Hello from my plugin!");
    },
  },
});
```

### Full Plugin Example

```typescript
import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin, PluginContext } from "@fusion/plugin-sdk";

export default definePlugin({
  manifest: {
    id: "my-full-plugin",
    name: "My Full Plugin",
    version: "1.0.0",
    description: "A complete example with hooks, tools, and routes",
    settingsSchema: {
      apiKey: {
        type: "string",
        label: "API Key",
        required: true,
      },
    },
  },
  state: "installed",
  tools: [
    {
      name: "my_tool",
      description: "Does something useful",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
        required: ["input"],
      },
      execute: async (params, ctx) => {
        const result = process(params.input as string);
        return { content: [{ type: "text", text: result }] };
      },
    },
  ],
  routes: [
    {
      method: "GET",
      path: "/status",
      handler: async () => ({ status: "ok" }),
    },
  ],
  hooks: {
    onLoad: (ctx) => ctx.logger.info("Loaded!"),
    onTaskCreated: (task, ctx) => {
      ctx.logger.info(`Task created: ${task.id}`);
    },
    onUnload: () => {
      // Cleanup
    },
  },
} satisfies FusionPlugin);
```

---

For more information, see the [Plugin SDK Reference](../packages/plugin-sdk/src/index.ts).
