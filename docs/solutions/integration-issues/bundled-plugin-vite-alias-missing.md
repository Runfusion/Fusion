---
title: Bundled plugin dashboard views fail to load when Vite alias is missing
date: 2026-06-06
category: integration-issues
module: plugins
problem_type: integration_issue
component: tooling
symptoms:
  - "Plugin fails to enable with: Unknown file extension \".css\" for /path/to/PluginView.css"
  - "Dynamic import of bundled plugin view returns 404 or module not found"
  - "Bundled plugin view unavailable: @fusion-plugin-examples/compound-engineering/dashboard-view#CompoundEngineeringDashboardView"
  - "Plugin works in its own package build but fails when loaded by the dashboard"
root_cause: incomplete_setup
resolution_type: config_change
severity: medium
tags: [plugins, bundled-plugins, vite, alias, dashboard-view, registration-drift, css-loader]
---

# Bundled plugin dashboard views fail to load when Vite alias is missing

## Problem

When a bundled plugin exports a dashboard view, the dashboard lazy-loads it via `registerBundledPluginViews.ts`. For this to work, the dashboard's Vite and Vitest configurations must include `resolve.alias` entries that map the plugin's package name to its source directory, and the loader's `import()` call must use a static string literal so Vite can emit a bundled lazy chunk. Without the alias or static import, Vite cannot resolve or bundle the view module, and the plugin view fails to load.

The error message can be misleading: Vite may report `Unknown file extension ".css"` because module resolution fails and the error bubbles up through an unrelated loader path. In production, a `/* @vite-ignore */` dynamic import can instead surface as the dashboard placeholder: `Bundled plugin view unavailable: <module>#<export>`.

## Symptoms

- The Compound Engineering plugin (or any bundled plugin with a dashboard view) fails to enable
- Console shows: `Failed to enable Compound Engineering: Unknown file extension ".css" for /path/to/PluginView.css`
- The plugin's own package builds successfully — the issue only manifests when the dashboard tries to load it
- Other bundled plugins (e.g., dependency-graph) load correctly — they have aliases and static literal `import()` loaders

## What Didn't Work

- Investigating CSS loader configuration — the `.css` error is a red herring; the real issue is module resolution
- Checking the plugin's `package.json` exports — they were correct (`"./dashboard-view"` → `"./src/dashboard-view.tsx"`)
- Verifying the plugin's CSS file exists and is valid — it was fine

## Solution

Add the missing `resolve.alias` entries to both `packages/dashboard/vite.config.ts` and `packages/dashboard/vitest.config.ts`:

```ts
// packages/dashboard/vite.config.ts
export default defineConfig({
  // ...
  resolve: {
    alias: {
      // ... existing aliases ...
      "@fusion-plugin-examples/compound-engineering/dashboard-view": resolve(
        __dirname,
        "../../plugins/fusion-plugin-compound-engineering/src/dashboard-view.tsx",
      ),
      "@fusion-plugin-examples/compound-engineering": resolve(
        __dirname,
        "../../plugins/fusion-plugin-compound-engineering/src/index.ts",
      ),
      // ... other plugin aliases ...
    },
  },
});
```

Both aliases are needed:
- The `/dashboard-view` alias resolves the view component import
- The package root alias resolves any internal imports the view makes to the plugin's index

## Why This Works

The dashboard should use statically analyzable literal imports for bundled plugin views:

```ts
// packages/dashboard/app/plugins/registerBundledPluginViews.ts
const mod = await import("@fusion-plugin-examples/compound-engineering/dashboard-view");
```

Vite can trace a literal `import()` through `resolve.alias`, include the aliased source file in the build graph, and emit a code-split chunk for the lazy view. A `/* @vite-ignore */` import using a dynamic module ID prevents this analysis; production browsers then try to resolve the bare package specifier at runtime and the dashboard falls back to the "Bundled plugin view unavailable" placeholder. Without the alias, Vite falls through to default resolution, which fails because the plugin package is in a sibling `plugins/` directory outside the dashboard's root. Some failures surface through the CSS loader because Vite's fallback resolution path misattributes the failure.

## Related root cause: CSS import via index re-export

The same `Unknown file extension ".css"` symptom can also happen when a plugin's **server-side entry** (`src/index.ts` / `dist/index.js`) re-exports its dashboard view component:

```ts
export { SomeDashboardView } from "./dashboard-view.js";
```

Server-side plugin loading uses Node.js `import()` against the plugin entry. If that entry re-exports a React dashboard view, Node follows the chain into the view and any imported `.css` files before Vite is involved, then crashes because the Node ESM loader does not handle CSS. The fix is to keep dashboard view components out of the server entry: preserve the `dashboardViews` manifest metadata (`componentPath: "./dashboard-view"`) and load the view client-side through `registerBundledPluginViews.ts` plus the Vite alias.

## Prevention

- **When adding a bundled plugin with a dashboard view, grep for an existing plugin alias** in `packages/dashboard/vite.config.ts` and `packages/dashboard/vitest.config.ts` and mirror the pattern for the new plugin
- **Do not re-export dashboard view components from the plugin's server-side `index.ts`** — the server entry must stay free of React/CSS view imports; `dashboardViews` metadata is enough for registration
- **Use a static string literal `import()` in `registerBundledPluginViews.ts`** for bundled dashboard views that should be code-split by Vite; avoid `/* @vite-ignore */` unless the task explicitly requires runtime-only resolution
- **Verify the alias in dev, production builds, and Vitest** — the alias must resolve correctly for Vite's dev server, production bundler, and test runner
- **Consider a consistency test** that asserts every plugin registered in `registerBundledPluginViews.ts` has a corresponding Vite alias (similar to the existing `lazy-loaded-views-docs.test.ts` that keeps the AGENTS.md view inventory in sync)
- **Watch for the misleading `.css` error** — when Vite reports an unknown file extension for a file that clearly exists, suspect module resolution failure before investigating loaders; when Node reports it while enabling a plugin, suspect a server-entry re-export of the dashboard view

## Related Issues

- `docs/solutions/integration-issues/bundled-plugin-registration-drift.md` — the broader registration-drift problem (4 independent lists for bundled plugins); this doc covers a fifth implicit registration point (Vite aliases)
- PR #1464 — the fix for the Compound Engineering alias
