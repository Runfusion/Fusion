# Plugin Authoring Guide

A comprehensive guide to creating Fusion plugins that extend the task board with custom tools, routes, and lifecycle hooks.

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Plugin Manifest Reference](#2-plugin-manifest-reference)
3. [Plugin Settings Schema](#3-plugin-settings-schema)
4. [Available Hooks and Signatures](#4-available-hooks-and-signatures)
5. [Registering Tools](#5-registering-tools)
6. [Registering Routes](#6-registering-routes)
7. [Registering UI Slots](#7-registering-ui-slots)
8. [Registering Top-Level Dashboard Views](#8-registering-top-level-dashboard-views)
9. [Registering Agent Runtimes](#9-registering-agent-runtimes)
10. [Plugin Context API Reference](#10-plugin-context-api-reference)
11. [Plugin Lifecycle States](#11-plugin-lifecycle-states)
12. [Testing Plugins](#12-testing-plugins)
13. [Publishing Plugins](#13-publishing-plugins)
14. [Example Plugins](#14-example-plugins)
15. [Registering Skills](#15-registering-skills)
16. [Registering Workflow Steps](#16-registering-workflow-steps)
17. [Contributing Prompt Modifications](#17-contributing-prompt-modifications)
18. [Plugin Binary Setup Hooks](#18-plugin-binary-setup-hooks)

---

See also: [External Plugin Authoring guide](./plugins/external-authoring.md)

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

External authors should use the standalone scaffold and dev loop (see the [External Plugin Authoring guide](./plugins/external-authoring.md)):

```bash
fn plugin new my-first-plugin
cd my-first-plugin
pnpm install
fn plugin dev .
pnpm test
```

The legacy `fn plugin create` scaffold remains available for workspace-bound examples.

### Optional AI Security Scan (Opt-in)

Plugin installs now support an opt-in `aiScanOnLoad` flag. When enabled, Fusion runs an AI security review before loading plugin code.

- **Opt-in:** disabled by default (`aiScanOnLoad: false`)
- **When it runs:** on plugin load/reload and explicit rescan
- **Scan inputs (deterministic order):** `manifest.json`, optional `package.json`, optional `README.md`, entry module, then prioritized source files
- **Boundaries:** excludes `node_modules`, `dist`, lockfiles, binary assets, files over 20 KB each, and enforces a 120 KB total raw-content cap

### Scan Verdicts

- `clean` — no concerning patterns found
- `warning` — suspicious patterns found; plugin may still load
- `blocked` — dangerous patterns found; plugin is blocked before import
- `error` — scan failed to produce a valid decision
- `unavailable` — AI scan service unavailable

When a plugin is blocked (`blocked`/`error`/`unavailable`), Fusion does **not** execute plugin code for that load attempt and stores the scan result on plugin metadata (`lastSecurityScan`) for operator visibility.

### Author Guidance for Blocked Plugins

If your plugin is blocked:
- remove dynamic execution patterns (`eval`, shell-outs, hidden network exfiltration behavior)
- keep behavior explicit in source and manifest
- document external calls and sensitive operations in README
- ask operators to run `fn plugin rescan <id>` after publishing fixes

### Signature Verification and Publisher Trust

Fusion supports deterministic detached-signature verification for plugin provenance before plugin code is loaded.

Expected plugin files at the plugin root:
- `manifest.json`
- `plugin-publisher.json` (publisher identity + public key metadata)
- `plugin-signature.json` (detached signature over canonical payload)

Canonical payload inputs (sorted, deterministic):
- normalized `manifest.json`
- publisher metadata from `plugin-publisher.json`
- declared file digest map (sorted by relative path)

Verification statuses:
- `trusted-local` — bundled/in-repo plugin path trusted by local policy exception
- `verified-trusted` — signature verifies and publisher key is trusted
- `verified-untrusted` — signature verifies but publisher/key is not trusted yet
- `unsigned` — no signature bundle present
- `invalid` — signature or digest validation failed (tampered/corrupt)

Trust decisions are explicit and keyed by publisher ID + key fingerprint. Manifest author/homepage strings are informational only and are never used as trust proof.

### Plugin Author Checklist for Signed Releases

1. Produce deterministic file digests for distributed plugin files
2. Publish `plugin-publisher.json` with stable publisher ID and key fingerprint
3. Sign the canonical payload and ship `plugin-signature.json`
4. Keep digest/signature files in source control and release artifacts
5. In release notes, include publisher ID + key fingerprint so operators can verify trust prompts

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
  settingsSchema: { /* ... */ },     // Optional: configuration schema
  runtime: {                         // Optional: agent runtime metadata
    runtimeId: "code-interpreter",
    name: "Code Interpreter",
    description: "Executes code in a sandbox",
  },
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
| `runtime` | PluginRuntimeManifestMetadata | No | Agent runtime metadata for discovery |

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

Common optional fields on all setting types:

- `group?: string` — Optional heading used by the dashboard to render settings in grouped sections (for example: `"General"`, `"Browser"`, `"Prompt Contributions"`, `"Skills"`). Ungrouped settings still render first in their existing flat order, then grouped sections render under stable headings.
- `description?: string` — Helper text shown below the setting label.
- `required?: boolean` — Marks the field as required.
- `defaultValue?: unknown` — Default value used when no user value is provided.

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
    group: "General",
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
    group: "Skills",
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
| `onUnload` | `(ctx: PluginContext) => Promise<void> \| void` | Plugin stopped/shutdown |
| `onTaskCreated` | `(task: Task, ctx: PluginContext) => Promise<void> \| void` | New task created |
| `onTaskMoved` | `(task: Task, fromColumn: string, toColumn: string, ctx: PluginContext) => Promise<void> \| void` | Task moved between columns |
| `onTaskCompleted` | `(task: Task, ctx: PluginContext) => Promise<void> \| void` | Task reached "done" |
| `onError` | `(error: Error, ctx: PluginContext) => Promise<void> \| void` | Error occurred in plugin execution |
| `onSchemaInit` | `(db: Database) => Promise<void> \| void` | After enabled plugins are loaded at startup (engine/daemon/dashboard/serve) |
| `executorRuntimeEnv` | `(taskCtx: ExecutorRuntimeTaskContext, ctx: PluginContext) => Promise<ExecutorRuntimeEnvContribution> \| ExecutorRuntimeEnvContribution` | Before executor-spawned task commands run, to contribute task-scoped env and PATH prepends |

### Hook Behavior

- **Context parity**: `onUnload` receives the same `PluginContext` shape as `onLoad`.
- **Timeout**: 5 seconds per invocation (logged and skipped if exceeded)
- **Error Isolation**: Hook failures never block other hooks or abort startup
- **Optional**: Only define the hooks you need
- **Schema hook execution**: `onSchemaInit` hooks run sequentially in plugin dependency order (from `resolveLoadOrder`) after `loadAllPlugins()`.
- **Schema hook database API**: The hook receives the runtime `Database` instance, including `db.exec()` and `db.prepare()` for SQL DDL.
- **Schema hook constraints**: `onSchemaInit` is intended for idempotent DDL only (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Avoid data backfills or long-running logic.
- **Bundled plugin pattern**: Keep DDL in a plugin-local schema module (for example `src/<plugin>-schema.ts`) and call it from `hooks.onSchemaInit` so schema ownership stays with the plugin package instead of `@fusion/core` bootstrap SQL.

### Example: Schema initialization hook

```typescript
hooks: {
  onSchemaInit: async (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_roadmaps (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_roadmaps_created_at
      ON plugin_roadmaps(created_at);
    `);
  },
},
```

### `executorRuntimeEnv`: task-scoped executor subprocess environment

Use `executorRuntimeEnv` when your plugin needs to provide runtime environment values for **executor-spawned user commands** tied to a specific task.

This hook runs when Fusion prepares subprocess environments for executor command surfaces such as configured commands, verification commands, and step-session subprocesses.

It does **not** apply to internal git plumbing subprocesses used by worktree/branch management.

```typescript
import type {
  ExecutorRuntimeEnvContribution,
  ExecutorRuntimeTaskContext,
  PluginContext,
} from "@fusion/plugin-sdk";

function executorRuntimeEnv(
  taskCtx: ExecutorRuntimeTaskContext,
  ctx: PluginContext,
): ExecutorRuntimeEnvContribution {
  ctx.logger.info(`Preparing env for task ${taskCtx.taskId}`);
  return {
    pathPrepend: ["/absolute/path/to/tools"],
    env: {
      MY_PLUGIN_TASK_ID: taskCtx.taskId,
    },
  };
}
```

`ExecutorRuntimeTaskContext` fields:

- `taskId`: Fusion task ID
- `worktreePath`: absolute path to the task worktree
- `rootDir`: project root directory
- `branch?`: task branch name when available

`ExecutorRuntimeEnvContribution` fields:

- `pathPrepend?`: array of **absolute** path strings prepended to `PATH` for executor-spawned commands
- `env?`: key/value string map merged into the subprocess environment
- `description?`: optional human-readable note for debugging/telemetry

Validation and merge behavior (from engine runtime collection):

- `pathPrepend` must be an array of absolute path strings; non-absolute entries are rejected.
- `env` values must be strings.
- `env` must not include `PATH`; use `pathPrepend` instead.
- When multiple plugins set the same `env` key, later plugins override earlier values and the engine logs a warning.
- `pathPrepend` entries from later plugins are placed earlier in the final prepend list.

### Example: prepend a generated tool directory for executor commands

```typescript
import { definePlugin } from "@fusion/plugin-sdk";
import path from "node:path";

export default definePlugin({
  manifest: {
    id: "fusion-plugin-tooling-example",
    name: "Tooling Example",
    version: "1.0.0",
  },
  state: "installed",
  hooks: {},
  executorRuntimeEnv: (taskCtx) => {
    const toolDir = path.resolve(taskCtx.rootDir, ".fusion/tools/my-plugin/bin");

    return {
      pathPrepend: [toolDir],
      env: {
        MY_PLUGIN_TOOL_HOME: toolDir,
      },
    };
  },
});
```

With this hook enabled, executor-spawned commands (for example verification commands or `bash` tool subprocesses in the task session) can resolve binaries from `toolDir` without mutating global process environment.

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

Route handlers may return either plain JSON values or a `PluginRouteResponse` envelope. `PluginRouteResponse` now supports optional `headers` and `contentType` fields so plugins can serve non-JSON payloads like downloadable HTML. Example: return `{ status: 200, body: html, contentType: "text/html; charset=utf-8", headers: { "Content-Disposition": "attachment; filename=\"report.html\"" } }` to send an attachment response directly from a plugin route.

### Route Mounting

Routes are mounted at `/api/plugins/{pluginId}/{path}`.
Route handlers receive the same loader-built `PluginContext` used by hooks/tools, including real `taskStore`, plugin `settings`, `logger`, `emitEvent`, and engine-injected `createAiSession` (when available):

- Example roadmap plugin route: `path: "/roadmaps"` in plugin `fusion-plugin-roadmap` resolves to `/api/plugins/fusion-plugin-roadmap/roadmaps`
- Roadmap suggestion endpoints follow the same namespace (for example `/api/plugins/fusion-plugin-roadmap/roadmaps/:roadmapId/suggestions/milestones`)
- Do not document or depend on legacy host-owned `/api/roadmaps` routes unless your current source still ships them

- Plugin ID: `fusion-plugin-notification`
- Route path: `/status`
- Full URL: `/api/plugins/fusion-plugin-notification/status`

### Supported Methods

- `GET`
- `POST`
- `PUT`
- `DELETE`

---

## 7. Registering UI Slots

UI slots are mount points in the Fusion dashboard where plugins can inject custom UI components. Each slot is identified by a unique `slotId` that corresponds to a specific location in the dashboard UI.

### How UI Slots Work

Plugins declare `uiSlots` in their `FusionPlugin` definition. The dashboard discovers all registered UI slots via `GET /api/plugins/ui-slots` and renders matching components at each mount point.

### Available Slot IDs

| Slot ID | Location | Description | Status |
|---------|----------|-------------|--------|
| `task-detail-tab` | Task detail modal | Tab added to the task detail view | Available |
| `header-action` | Dashboard header | Action button in the header toolbar | Available |
| `settings-section` | Settings modal | Section added to the settings panel | Available |
| `settings-provider-card` | Settings → Authentication | Provider card contribution in Authentication section | Available |
| `onboarding-provider-card` | Onboarding modal → AI setup | Provider card content rendered before host fallback cards | Available |
| `onboarding-setup-help` | Onboarding modal → AI setup | Additional setup-help content rendered below provider sections | Available |
| `post-onboarding-recommendation` | Dashboard post-onboarding card | Recommendation item rendered in host-owned next-steps container | Available |
| `settings-integration-card` | Legacy structured name | Compatibility alias now normalized to `settings-config-section` in structured API | Compatibility only |
| `onboarding-recommendation-card` | Legacy structured name | Compatibility alias now normalized to `onboarding-provider-recommendation` in structured API | Compatibility only |
| `task-card-badge` | Task card on the board | Small badge displayed on task cards (e.g., CI status indicator) | Planned |
| `board-column-footer` | Board column | Footer area below the last card in a column | Planned |

### Defining UI Slots

Add `uiSlots` to your `FusionPlugin` definition:

```typescript
import type { FusionPlugin, PluginUiSlotDefinition } from "@fusion/plugin-sdk";

const uiSlots: PluginUiSlotDefinition[] = [
  {
    slotId: "task-detail-tab",
    label: "CI History",
    icon: "history",
    componentPath: "./components/ci-tab.js",
  },
  {
    slotId: "task-card-badge",
    label: "CI Status",
    icon: "circle-check",
    componentPath: "./components/ci-badge.js",
  },
];

const plugin: FusionPlugin = {
  manifest: { /* ... */ },
  state: "installed",
  uiSlots,
  hooks: { /* ... */ },
};
```

### PluginUiSlotDefinition Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slotId` | `string` | Yes | One of the known slot IDs (e.g., "task-detail-tab", "header-action") |
| `label` | `string` | Yes | Human-readable label for the slot |
| `icon` | `string` | No | Lucide icon name for visual identification |
| `componentPath` | `string` | Yes | Path to the JS module exporting the component, relative to the plugin root |

### Component Module Format and Host Resolution

`componentPath` is part of the plugin contract, but dashboard rendering is intentionally host-resolved through a **static slot registry** (`pluginId + slotId + componentPath`).

Important implications:

- The dashboard does **not** load arbitrary plugin modules at runtime from `componentPath`.
- To render in dashboard flows, your slot entry must match a host-registered mapping.
- Unknown/unmapped entries degrade safely to a visible “missing component” shell (or render nothing when the host sets `renderPlaceholder={false}`).
- Host flows still own modal structure, navigation, callbacks, and fallback content when no slot entry exists.

For this reason, plugin authors should still provide stable `componentPath` values in manifests, but coordinate with dashboard host maintainers when adding new UI surfaces or module paths that need mapping.

### Structured UI Contributions (data-only, parallel to `uiSlots`)

For Settings/onboarding/post-onboarding flows, use structured `uiContributions` instead of legacy placeholder slots.

- Discovery API: `GET /api/plugins/ui-contributions`
- Type surface: `PluginUiContributionDefinition` (`@fusion/plugin-sdk`)
- Structured surfaces:
  - `settings-provider-card`
  - `settings-config-section`
  - `onboarding-provider-card`
  - `onboarding-setup-help`
  - `onboarding-provider-recommendation`
  - `post-onboarding-recommendation`

Rules:
- Structured contributions are **data-only JSON payloads**.
- Do **not** include `componentPath`.
- Do **not** send live callbacks/functions through REST.
- Use `actions: PluginUiActionDescriptor[]` so host-owned renderers bind behavior.

Compatibility normalization:
- `settings-integration-card` → `settings-config-section`
- `onboarding-recommendation-card` → `onboarding-provider-recommendation`

The API only returns normalized surface names.

---

## 8. Registering Top-Level Dashboard Views

Top-level views are a **sibling contribution type** to `uiSlots`.

- `uiSlots` are embedded surfaces (task detail tab, header action, etc.)
- `dashboardViews` is the shipped top-level plugin field for full-screen dashboard destinations
- Earlier planning language may say `views`; the implemented API in `FusionPlugin` is `dashboardViews`

Register `dashboardViews` on the plugin definition:

```ts
import type { PluginDashboardViewDefinition } from "@fusion/plugin-sdk";

const dashboardViews: PluginDashboardViewDefinition[] = [
  {
    viewId: "graph",
    label: "Graph",
    componentPath: "./src/DependencyGraphView.tsx",
    icon: "Network",
    order: 40,
    placement: "overflow",
    description: "Explore task dependency links",
  },
];
```

### PluginDashboardViewDefinition fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `viewId` | `string` | Yes | Unique slug-like ID within your plugin namespace |
| `label` | `string` | Yes | Human-readable nav label |
| `componentPath` | `string` | Yes | Module path for the view component, relative to plugin root |
| `icon` | `string` | No | Lucide icon name |
| `order` | `number` | No | Lower values appear earlier in nav |
| `placement` | `"primary" \| "overflow" \| "more"` | No | Navigation placement hint (default is host-defined overflow behavior) |
| `description` | `string` | No | Short summary for nav/help surfaces |

Current host constraints:
- Discovery API: `GET /api/plugins/dashboard-views`
- The dashboard **does not eval or filesystem-load plugin code in-browser**
- `componentPath` is stored for authoring symmetry/future expansion, but render resolution is currently done through a host-side static registry (`pluginId + viewId`)
- Use stable IDs; runtime view key format is `plugin:${pluginId}:${viewId}`

### Static host registry model

Dashboard view components are resolved from a host-side registry and must be explicitly registered:

```ts
import { lazy } from "react";
import { registerPluginView } from "../app/plugins/pluginViewRegistry";

registerPluginView(
  "fusion-plugin-dependency-graph",
  "graph",
  lazy(() => import("@fusion-plugin-examples/dependency-graph/dashboard-view")),
);
```

The host then renders plugin views via `PluginDashboardViewHost` using the composite ID.

Bundled workspace plugin pattern:
- Keep plugin package under `plugins/` (for example `plugins/fusion-plugin-roadmap`)
- Export backend/plugin entry from `src/index.ts` and keep dashboard view exports in the plugin package (for example `./dashboard-view`)
- Register the lazy dashboard component in host code (currently `packages/dashboard/app/plugins/registerBundledPluginViews.ts`)
- CLI bundling inlines backend plugin code from workspace packages; dashboard view modules are imported by the dashboard build via the host registry

Runtime host context contract:
- Registered views receive a `context` object from the dashboard host (`PluginDashboardViewContext`).
- Context includes the active `projectId`, current visible `tasks`, optional `workflowSteps`, and `openTaskDetail` for launching the native task detail flow.
- Keep view-specific UI behavior in the plugin; treat host context as service/data injection only.

Placement guidance:
- `primary`: top-level nav tab (host may limit count on mobile)
- `overflow`: desktop header overflow menu
- `more`: mobile More sheet / secondary nav surfaces

Project-scoped UI state guidance:
- Persist plugin view layout/state in browser storage using a plugin-owned base key and the shared project-scoped pattern (`kb:${projectId}:${baseKey}`).
- For dependency graph layout, the canonical base key is `fusion-plugin-dependency-graph:positions`.
- Do not persist plugin UI state in task metadata or server-side task records.

---

## 9. Registering Agent Runtimes

Plugins can provide custom agent runtime implementations that extend the Fusion engine's ability to execute agent sessions. Runtimes are discovered through the plugin discovery pipeline and can be used by the engine to route agent session creation.

### How Runtimes Work

A plugin runtime consists of two parts:
1. **Runtime Metadata** (in manifest): Declares the runtime's identity for discovery
2. **Runtime Factory** (in plugin instance): Creates the runtime instance when needed

### Runtime Manifest Metadata

Declare runtime metadata in your plugin's manifest:

```typescript
import type { PluginManifest } from "@fusion/plugin-sdk";

const manifest: PluginManifest = {
  id: "my-runtime-plugin",
  name: "My Runtime Plugin",
  version: "1.0.0",
  runtime: {
    runtimeId: "code-interpreter",
    name: "Code Interpreter",
    description: "Executes code in a sandboxed environment",
    version: "1.0.0",
  },
};
```

### PluginRuntimeManifestMetadata Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runtimeId` | `string` | Yes | Unique runtime identifier within the plugin (kebab-case slug) |
| `name` | `string` | Yes | Human-readable name for the runtime |
| `description` | `string` | No | Short description of what the runtime provides |
| `version` | `string` | No | Semantic version of the runtime implementation |

### Runtime Factory

The runtime factory is a function that creates the runtime instance:

```typescript
import type { FusionPlugin, PluginContext } from "@fusion/plugin-sdk";

const plugin: FusionPlugin = {
  manifest: { /* ... */ },
  state: "installed",
  hooks: {},
  runtime: {
    metadata: {
      runtimeId: "code-interpreter",
      name: "Code Interpreter",
      description: "Executes code in a sandboxed environment",
    },
    factory: async (ctx: PluginContext) => {
      // Initialize the runtime with plugin context
      const apiKey = ctx.settings.apiKey as string;
      
      return {
        name: "code-interpreter",
        version: "1.0.0",
        async execute(code: string) {
          // Execute code in sandbox
          const result = await runSandbox(code, { apiKey });
          return result;
        },
      };
    },
  },
};
```

### PluginRuntimeFactory Signature

```typescript
type PluginRuntimeFactory = (ctx: PluginContext) => Promise<unknown> | unknown;
```

The factory receives `PluginContext` (same as hooks) and should return the runtime instance. The returned instance's structure depends on the runtime's purpose.

### PluginRuntimeRegistration Structure

```typescript
interface PluginRuntimeRegistration {
  metadata: PluginRuntimeManifestMetadata;
  factory: PluginRuntimeFactory;
}
```

### Discovery Pipeline

Runtimes are discovered through the plugin discovery pipeline:

1. **PluginLoader** aggregates runtime registrations from all loaded plugins via `getPluginRuntimes()`
2. **PluginRunner** caches runtime registrations and exposes them via `getPluginRuntimes()`

Both components follow the same pattern as tools, routes, and UI slots.

### Backwards Compatibility

Runtime registration is entirely optional. Plugins that don't declare a `runtime` field:
- Continue to work unchanged
- Pass manifest validation
- Don't affect the runtime discovery pipeline

### Example: Complete Runtime Plugin

```typescript
import { definePlugin } from "@fusion/plugin-sdk";

export default definePlugin({
  manifest: {
    id: "fusion-plugin-code-interpreter",
    name: "Code Interpreter Plugin",
    version: "1.0.0",
    description: "Provides a sandboxed code execution runtime",
    runtime: {
      runtimeId: "code-interpreter",
      name: "Code Interpreter",
      description: "Executes code in a sandboxed environment",
      version: "1.0.0",
    },
  },
  state: "installed",
  hooks: {
    onLoad: async (ctx) => {
      ctx.logger.info("Code interpreter runtime plugin loaded");
    },
  },
  runtime: {
    metadata: {
      runtimeId: "code-interpreter",
      name: "Code Interpreter",
      description: "Executes code in a sandboxed environment",
      version: "1.0.0",
    },
    factory: async (ctx) => {
      // Runtime initialization
      return {
        name: "code-interpreter",
        version: "1.0.0",
        async execute(code: string, language: string) {
          // Sandbox execution logic
          return { output: `Executed ${language} code`, result: "success" };
        },
      };
    },
  },
} satisfies FusionPlugin);
```

---

## 10. Plugin Context API Reference

The context object is passed to hooks, tools, and route handlers:

```typescript
interface PluginContext {
  pluginId: string;
  taskStore: TaskStore;
  settings: Record<string, unknown>;
  logger: PluginLogger;
  emitEvent: (event: string, data: unknown) => void;
  createAiSession?: CreateAiSessionFactory;
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
| `createAiSession` | `CreateAiSessionFactory \| undefined` | Engine-injected AI session factory (undefined when engine isn't loaded) |

### Logger Methods

```typescript
interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}
```

### `createAiSession` API

```typescript
interface CreateAiSessionOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  defaultProvider?: string;
  defaultModelId?: string;
}

interface AiSessionResult {
  session: {
    prompt(text: string): Promise<void>;
    state: { messages: Array<{ role: string; content?: unknown }> };
  };
  sessionFile?: string;
}

type CreateAiSessionFactory = (
  options: CreateAiSessionOptions,
) => Promise<AiSessionResult>;
```

The factory is dependency-injected by the engine at runtime. In test-only or core-only environments where the engine module is not loaded, `ctx.createAiSession` is `undefined`, so guard before calling it.

### Example: Using `ctx.createAiSession()`

Use this context factory for plugin AI features (for example roadmap milestone/feature suggestion generation). Avoid direct `@fusion/engine` imports from plugin code; engine wiring is injected by the host through `PluginContext`.

```typescript
hooks: {
  onLoad: async (ctx) => {
    if (!ctx.createAiSession) {
      ctx.logger.warn("AI session factory unavailable; engine not loaded");
      return;
    }

    const { session } = await ctx.createAiSession({
      cwd: process.cwd(),
      systemPrompt: "You are a release assistant for this plugin.",
      tools: "readonly",
    });

    await session.prompt("Summarize what this plugin contributes.");
    const latest = session.state.messages.at(-1);
    ctx.logger.info("AI summary generated", latest);
  },
},
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

## 11. Plugin Lifecycle States

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

## 12. Testing Plugins

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

### Fusion Host Regression Coverage (Plugin Discovery / Load / Registration)

When a plugin changes host integration contracts, add or update host-side regression tests in this repository:

- **Core loader pipeline** (`packages/core/src/__tests__/plugin-loader.test.ts`): verify `PluginStore.registerPlugin()` → `PluginLoader.loadAllPlugins()` / `loadPlugin()` and assert `started` state transitions, manifest validation failures, disabled-plugin skip behavior, missing entrypoint failures, and `onLoad` error handling.
- **Dashboard API aggregation** (`packages/dashboard/src/__tests__/plugin-routes.test.ts`, `packages/dashboard/src/__tests__/plugin-routes.routes.test.ts`): verify plugin visibility via `GET /api/plugins`, `GET /api/plugins/ui-slots`, and `GET /api/plugins/runtimes` using standard loader/store aggregation (no plugin-specific route branches).
- **Dashboard slot consumers** (`packages/dashboard/app/components/__tests__/PluginSlot.test.tsx`, `packages/dashboard/app/hooks/__tests__/usePluginUiSlots.test.ts`): cover slot filtering, ordering, and rendering behavior for host slot IDs used by your plugin.

Keep this layer focused on **discovery/load/registration plumbing**. Deeper feature-flow regressions (Settings UX, onboarding UX, runtime execution/provider behavior) belong in dedicated follow-up suites, not in these plumbing tests.

### Runtime/Provider Migration Regression Placement

For runtime-provider migrations (like Droid), use layered regression suites instead of duplicating the same matrix everywhere:

- **Engine runtime execution + fallback**: `packages/engine/src/__tests__/droid-runtime-e2e.test.ts` (patterned after Hermes/OpenClaw/Paperclip E2E suites) verifies plugin runtime resolution + default `pi` fallback when missing.
- **Runtime hint matrix guardrail**: `packages/engine/src/__tests__/runtime-selection-regression.test.ts` keeps a lightweight hint-to-runtime routing assertion.
- **Dashboard provider/auth routes**: `packages/dashboard/src/__tests__/routes-auth.test.ts` covers `POST /api/auth/droid-cli`, `GET /api/providers/droid-cli/status`, and `/api/auth/status` readiness/authenticated surfacing.
- **Dashboard model filtering + settings hook**: `packages/dashboard/src/__tests__/register-model-routes-droid-cli.test.ts` and `packages/dashboard/src/__tests__/register-settings-droid-cli.test.ts` guard `useDroidCli` routing/filter behavior.
- **Compatibility shim boundaries**: if `packages/droid-cli` remains, keep tests there focused on delegation to plugin-owned implementations (not a second behavior matrix).

This keeps regressions durable while preserving clear ownership boundaries across engine, dashboard, plugin, and shim layers.

---

## 13. Publishing Plugins

For end-to-end standalone packaging, `pnpm pack`, and installing on another machine, follow the [External Plugin Authoring guide](./plugins/external-authoring.md).

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

### Signed plugin recommendation

For production distribution, publish signed artifacts (`plugin-publisher.json` + `plugin-signature.json`) alongside your compiled plugin output so operators can verify provenance under warn/enforce trust policy modes.

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

## 14. Example Plugins

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

- Demonstrates: Custom routes, periodic background work, route handlers, UI slot registration
- Features: `onLoad`/`onUnload` lifecycle, `setInterval` polling, REST API, UI slots for task cards and task detail tabs

### [Roadmap Planner Plugin](../../plugins/fusion-plugin-roadmap/)

Standalone roadmap planning plugin extracted from dashboard host code.

- Demonstrates: `hooks.onSchemaInit` for plugin-owned schema DDL (`ensureRoadmapSchema`)
- Demonstrates: plugin-scoped route namespace under `/api/plugins/fusion-plugin-roadmap/*`
- Demonstrates: top-level navigation registration through `dashboardViews` (`viewId: "roadmaps"`) and host static view registration
- Demonstrates: AI suggestion flows that consume `ctx.createAiSession` through plugin route handlers

### [Droid Runtime Plugin](../../plugins/fusion-plugin-droid-runtime/)

Reference runtime plugin that migrates a CLI-backed provider into the plugin system.

- Demonstrates: runtime adapter pattern (`runtime-adapter.ts`) and plugin-owned streaming/provider orchestration (`provider.ts`, `process-manager.ts`)
- Demonstrates structured contribution registration for `settings-provider-card`, `settings-config-section`, `onboarding-provider-card`, `onboarding-setup-help`, `onboarding-provider-recommendation`, and `post-onboarding-recommendation`
- Demonstrates dashboard probe delegation through plugin-owned `probeDroidBinary`
- Preserves provider id `droid-cli` via `@fusion/droid-cli` compatibility shim

### [Settings Demo Plugin](../../plugins/examples/fusion-plugin-settings-demo/)

Example plugin demonstrating settings schema and runtime configuration with all four setting types.

- Demonstrates: Settings schema (string, number, boolean, enum), hooks that read settings, tools with settings-driven output
- Features: Configurable greeting message, tag limit, logging toggle, log level selector
- **Install from Settings**: Designed to be installed via the dashboard Settings → Plugins UI

### [Even Realities Glasses Plugin](../../plugins/fusion-plugin-even-realities-glasses/)

Task-focused card bridge plugin for Even Realities glasses companion flows.

- Features: quick capture text into new tasks via the plugin route
- Features: polling-based task transition notifications on configured columns (default `in-review`)
- Features: board/task card endpoints (`GET /board/cards`, `GET /board`, `GET /tasks/:id/cards`)
- Features: agent actions for start work (`in-progress`) and request review (`in-review`), gated by `enableAgentActions`
- Features: webhook transport bridge with companion action ingestion (`POST /transport/actions`) and reconnect/status endpoints
- Demonstrates: settings schema for `fusionApiBaseUrl`, `fusionApiToken`, `apiKey`, `glassesDeviceId`, `companionWebhookUrl`, `pollingIntervalSeconds`, `notifyOnColumns`, `quickCaptureDefaultColumn`, and `enableAgentActions`
- Demonstrates FN-3737-aligned display limits: `EVEN_CARD_MAX_CHARS_PER_LINE = 28`, `EVEN_CARD_MAX_LINES_PER_CARD = 8`, `EVEN_CARD_MAX_DECK_SIZE = 12`

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
import type { FusionPlugin, PluginContext, PluginUiSlotDefinition } from "@fusion/plugin-sdk";

// UI slots for custom dashboard components
const uiSlots: PluginUiSlotDefinition[] = [
  {
    slotId: "task-card-badge",
    label: "CI Status",
    icon: "circle-check",
    componentPath: "./components/ci-badge.js",
  },
  {
    slotId: "task-detail-tab",
    label: "CI History",
    icon: "history",
    componentPath: "./components/ci-history-tab.js",
  },
];

export default definePlugin({
  manifest: {
    id: "my-full-plugin",
    name: "My Full Plugin",
    version: "1.0.0",
    description: "A complete example with hooks, tools, routes, UI slots, and runtimes",
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
  uiSlots,
  hooks: {
    onLoad: (ctx) => ctx.logger.info("Loaded!"),
    onTaskCreated: (task, ctx) => {
      ctx.logger.info(`Task created: ${task.id}`);
    },
    onUnload: (ctx) => {
      // Cleanup with the same context shape passed to onLoad
      ctx.logger.info("Shutting down plugin");
    },
  },
} satisfies FusionPlugin);
```

---

For more information, see the [Plugin SDK Reference](../packages/plugin-sdk/src/index.ts).

---

## 15. Registering Skills

Plugins can contribute reusable skills that are surfaced in agent sessions through Fusion's skill-selection flow.

```typescript
import type { PluginSkillContribution } from "@fusion/plugin-sdk";

const skills: PluginSkillContribution[] = [
  {
    skillId: "web-research",
    name: "Web Research",
    description: "Finds and summarizes web sources for a task",
    skillFiles: ["skills/web-research/SKILL.md"],
    enabled: true,
    triggerPatterns: ["research", "search the web", "find sources"],
  },
];
```

`skillFiles` are relative to the plugin root. `skillId` must be kebab-case.

## 16. Registering Workflow Steps

Plugins can ship workflow step templates that users can enable like built-in quality gates.

```typescript
import type { PluginWorkflowStepContribution } from "@fusion/plugin-sdk";

const workflowSteps: PluginWorkflowStepContribution[] = [
  {
    stepId: "strict-review",
    name: "Strict Review",
    description: "Run an AI review with strict failure criteria",
    mode: "prompt",
    phase: "pre-merge",
    prompt: "Review this task for correctness, regressions, and missing tests.",
    toolMode: "readonly",
    defaultOn: true,
  },
  {
    stepId: "smoke-build",
    name: "Smoke Build",
    description: "Build package before merge",
    mode: "script",
    scriptName: "build",
    toolMode: "coding",
  },
];
```

Use `mode: "prompt" | "script"` and `toolMode: "readonly" | "coding"`.

Plugin-contributed workflow steps are materialized through core `resolvePluginWorkflowStep(...)`; `mode`, `phase`, `scriptName`, `toolMode`, `defaultOn`, `modelProvider`, and `modelId` are preserved from your contribution (with defaults when omitted).

## 17. Contributing Prompt Modifications

Prompt contributions let a plugin inject additional instructions into specific prompt surfaces.

Supported surfaces:
- `executor-system`
- `executor-task`
- `triage`
- `reviewer`
- `heartbeat`

Each contribution uses the `PluginPromptContribution` shape:
- `surface`: one of the five supported surfaces
- `content`: prompt text to inject
- `position?`: `"append"` (default) or `"prepend"`
- `condition?`: optional human-readable condition note

```typescript
import type { PluginPromptContributions } from "@fusion/plugin-sdk";

const promptContributions: PluginPromptContributions = {
  enabledByDefault: false,
  contributions: [
    {
      surface: "executor-system",
      position: "append",
      content: "Always summarize browser-derived evidence with source URLs.",
      condition: "When browser tooling is available",
    },
  ],
};
```

Use `enabledByDefault: false` when contributions should require explicit opt-in.

## 18. Plugin Binary Setup Hooks

Plugins can expose setup metadata and lifecycle hooks for optional binaries or runtimes.

```typescript
import type { PluginSetupCheckResult, PluginSetupHooks, PluginSetupManifest } from "@fusion/plugin-sdk";

const setupManifest: PluginSetupManifest = {
  binaryName: "agent-browser",
  description: "Headless browser runtime for web-enabled agents",
  channel: "stable",
  defaultTimeoutMs: 120_000,
};

const setupHooks: PluginSetupHooks = {
  async checkSetup(ctx): Promise<PluginSetupCheckResult> {
    return { status: "not-installed" };
  },
  async install(ctx) {
    // Use async process execution with timeout; never use execSync.
  },
  async uninstall(ctx) {
    // Remove managed binary/runtime artifacts.
  },
};
```

`checkSetup` is required. `install` and `uninstall` are optional.
