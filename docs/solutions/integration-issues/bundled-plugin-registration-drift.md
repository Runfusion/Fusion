---
title: Bundled plugins must be registered in 4 independent places — they drift
date: 2026-06-04
category: integration-issues
module: plugins
problem_type: integration_issue
component: tooling
symptoms:
  - "Installing a built-in plugin from Settings → Built-in Plugins fails with \"Plugin manifest not found. Looked for manifest.json in: ...\""
  - "Plugin shows in the Settings UI but the install POST returns 404"
  - "Packaged (npm/binary) installs report missing-bundle for a plugin that works in dev"
root_cause: incomplete_setup
resolution_type: code_fix
severity: medium
tags: [plugins, bundled-plugins, settings, install, tsup, registration-drift]
---

# Bundled plugins must be registered in 4 independent places — they drift

## Problem

Adding a bundled (built-in) plugin to Fusion requires registration in **four independently maintained lists** with no cross-check. `fusion-plugin-compound-engineering` was added to only 2 of 4, so installing it from Settings → Built-in Plugins failed with "Plugin manifest not found" (fixed in PR #1423).

The four registration points:

1. **Dashboard UI** — `BUILTIN_PLUGINS` in `packages/dashboard/app/components/PluginManager.tsx` (makes the card appear in Settings)
2. **Dashboard server** — `BUNDLED_PLUGIN_IDS` in `packages/dashboard/src/routes.ts` (lets the install route fall back to the bundled copy when the relative `./plugins/...` path misses the server cwd)
3. **CLI startup** — `BUNDLED_PLUGIN_IDS` in `packages/cli/src/plugins/bundled-plugin-install.ts` (auto-install/upgrade of bundled plugins)
4. **Build staging** — `packages/cli/tsup.config.ts` (`bundlePluginEntry` or a copy block staging the plugin into `dist/plugins/<id>/` so packaged installs have a copy at all)

A plugin with a dashboard view additionally needs client-side view registration in `packages/dashboard/app/plugins/registerBundledPluginViews.ts`.

## Symptoms

- Settings shows the plugin card, but clicking install errors with `Plugin manifest not found. Looked for manifest.json in: <cwd>/plugins/<id>` — the cwd-relative path missed and the bundled fallback was skipped because the id wasn't in routes.ts's `BUNDLED_PLUGIN_IDS`.
- A sibling plugin added in the same commit (roadmap) installs fine — it was in all four lists.
- In packaged installs, `ensureBundledPluginInstalled` logs/returns `missing-bundle` because tsup never staged the plugin into `dist/plugins/`.

## What Didn't Work

- Assuming the UI list + CLI list were sufficient — the dashboard server keeps its **own** copy of the bundled-id set, and the install route's fallback silently returns null for unknown ids.
- The existing bundled-fallback route tests appeared to cover this, but their mocks let cwd resolution succeed (mock matched any path containing the plugin id), so the fallback branch was never actually exercised.

## Solution

Register the plugin in all four places. For the missing two:

```ts
// packages/dashboard/src/routes.ts
const BUNDLED_PLUGIN_IDS = new Set([
  // ...
  "fusion-plugin-cli-printing-press",
  "fusion-plugin-compound-engineering",
]);
```

```ts
// packages/cli/tsup.config.ts (onSuccess)
await bundlePluginEntry({
  pluginId: "fusion-plugin-compound-engineering",
  srcDir: compoundEngineeringPluginSrc,
  destDir: compoundEngineeringPluginDest,
});
```

## Why This Works

The Settings card sends a relative `./plugins/<id>` path. The server resolves it against `process.cwd()` — normally the user's project dir, not the Fusion repo — so it 404s and falls back to `extractBundledPluginId()`, which only recognizes ids in routes.ts's `BUNDLED_PLUGIN_IDS`. Adding the id makes the fallback resolve the staged bundled copy; the tsup staging block guarantees that copy exists in packaged installs.

## Prevention

- **When adding a bundled plugin, grep for an existing one** (e.g. `rg -l "fusion-plugin-roadmap" packages/` ) and mirror every hit — that surfaces all four lists plus view registration.
- Route tests must force the fallback: mock fs so the cwd-relative path **misses** and only `dist/plugins/<id>` exists (see "installs bundled compound engineering plugin when relative path misses cwd" in `packages/dashboard/src/__tests__/plugin-routes.test.ts`). A mock that matches any path containing the plugin id tests nothing.
- Consider a future consistency test asserting every `BUILTIN_PLUGINS` UI entry with a `path` is present in both server-side `BUNDLED_PLUGIN_IDS` sets.

## Related Issues

- PR #1423 — the fix
- Commit `ff0750cd1` — added CE/Roadmap to the UI list (2 of 4 registrations)
