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
last_updated: 2026-06-05
tags: [plugins, bundled-plugins, settings, install, tsup, registration-drift, entry-file, fs-mock]
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

## Follow-up failure: directory registered as plugin path

Fixing the fallback surfaced a second, independent bug (fixed in PR #1428): both dashboard install routes registered the **manifest directory** as the plugin path, but since FN-4128 the loader requires a loadable entry **file** (Node ESM cannot import directories) — enable then failed with `Plugin entry must be a file, got directory: <dir>`. Only the CLI startup path had been migrated to `resolvePluginEntryPath` (`bundled.js` → `dist/index.js` → `src/index.ts`), which is why CLI-auto-installed plugins worked and Settings-installed ones never did. Fix: both install routes now resolve and register the entry file (helper added to `@fusion/core`; 400 with "no loadable entry file" when none exists), and **both** enable routes heal legacy directory-path rows in place before `loadPlugin` — mirroring the CLI's startup heal — so pre-fix broken registrations self-repair on first enable without a migration.

### Trap: vitest fs mocks don't reach externalized workspace deps

Moving `resolvePluginEntryPath` to `@fusion/core` and re-exporting from the CLI broke the CLI's tests: `vi.mock("node:fs")` in the CLI package does **not** intercept fs calls made inside the externalized `@fusion/core` import (vitest only inlines/mocks modules in the test package's transform graph — the dashboard package inlines core, the CLI doesn't). Resolution: the CLI keeps an intentionally duplicated local copy (its fs mocks work against it), both copies carry keep-in-sync comments, and a **real-fs drift-guard test** (`packages/cli/src/plugins/__tests__/resolve-plugin-entry-path-sync.test.ts`) imports both copies and asserts identical resolution across real temp-dir layouts — each candidate alone, precedence pairs, all three, and the no-entry → `null` case. Real directories are the only seam that exercises both implementations equally; a candidate-list change applied to one copy but not the other now fails CI.

## Why This Works

The Settings card sends a relative `./plugins/<id>` path. The server resolves it against `process.cwd()` — normally the user's project dir, not the Fusion repo — so it 404s and falls back to `extractBundledPluginId()`, which only recognizes ids in routes.ts's `BUNDLED_PLUGIN_IDS`. Adding the id makes the fallback resolve the staged bundled copy; the tsup staging block guarantees that copy exists in packaged installs.

## Prevention

- **When adding a bundled plugin, grep for an existing one** (e.g. `rg -l "fusion-plugin-roadmap" packages/` ) and mirror every hit — that surfaces all four lists plus view registration.
- Route tests must force the fallback: mock fs so the cwd-relative path **misses** and only `dist/plugins/<id>` exists (see "installs bundled compound engineering plugin when relative path misses cwd" in `packages/dashboard/src/__tests__/plugin-routes.test.ts`). A mock that matches any path containing the plugin id tests nothing.
- **Pin assertions to the exact contract, not substring containment.** `stringContaining(pluginId)` passed for both the correct entry-file path and the buggy directory path — when a mock or matcher can satisfy both the correct and the buggy value, the test proves nothing. Route tests now assert the registered path ends in an entry-file suffix, cover the `dist/index.js` and `src/index.ts` fallbacks, and the 400 no-entry branch.
- When duplicating a helper is forced by test infrastructure (fs mocks vs externalized deps), add a real-fs drift-guard test that runs every copy against the same on-disk fixtures and asserts identical output.
- Consider a future consistency test asserting every `BUILTIN_PLUGINS` UI entry with a `path` is present in both server-side `BUNDLED_PLUGIN_IDS` sets.

## Related Issues

- PR #1423 — the registration-drift fix
- PR #1428 — the entry-file/heal follow-up fix
- Issue #1096 — same Settings-install bundled-plugin failure family (missing-bundle symptom for the Paperclip runtime in global npm installs); different root cause
- Commit `ff0750cd1` — added CE/Roadmap to the UI list (2 of 4 registrations)
