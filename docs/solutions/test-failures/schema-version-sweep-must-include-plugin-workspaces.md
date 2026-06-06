---
title: "Schema-version literal sweep must include plugin workspaces"
date: "2026-06-05"
category: test-failures
module: "packages/core schema-version sweep"
problem_type: test_failure
component: testing_framework
symptoms:
  - "CI Test shard 4/4 fails with AssertionError: expected 109 to be 108 in plugins/fusion-plugin-roadmap roadmap-store.test.ts"
  - "Failure invisible locally because pre-push verification runs packages/-scoped suites only"
  - "grep -rn 'toBe(108)' packages/ returns zero hits post-sweep, so the sweep looks complete"
root_cause: missing_workflow_step
resolution_type: test_fix
severity: medium
related_components:
  - database
  - development_workflow
tags:
  - schema-version
  - pnpm-workspace
  - plugin
  - grep-scope
  - ci-failure
  - literal-sweep
---

# Schema-version literal sweep must include plugin workspaces

## Problem

When `packages/core`'s `SCHEMA_VERSION` was bumped 108 → 109 (adding the `workflow_settings` table), the established "broad literal sweep" — `grep -rn 'toBe(108)' packages/` — was executed correctly and updated ~40 assertion sites. CI still failed: `plugins/fusion-plugin-roadmap` has a store test asserting `getSchemaVersion()` against a hard-coded literal, and `plugins/` lives outside the sweep's grep scope.

## Symptoms

```
FAIL plugins/fusion-plugin-roadmap/src/store/__tests__/roadmap-store.test.ts
  RoadmapStore > schema version > schema version is 108 after init
    AssertionError: expected 109 to be 108
```

- CI shard 4/4 red on the first run after the bump landed; all `packages/` suites green.
- Invisible locally: the plan's execution note and pre-push verification both scoped to `packages/`, and the roadmap plugin's suite is not part of a `packages/`-only vitest run.

## What Didn't Work

- **Following the documented sweep convention diligently.** After the bump, `grep -rn 'toBe(108)' packages/` returned zero hits — the sweep *looked* complete. The gap was scope, not carefulness: at least two plan cycles (step-inversion v108, workflow-settings v109) codified the sweep as `packages/`-scoped, an assumption that silently became false when `fusion-plugin-roadmap` grew a store layer on `@fusion/core`'s `Database` and added a schema-version pinning test.

## Solution

One-line fix in `plugins/fusion-plugin-roadmap/src/store/__tests__/roadmap-store.test.ts`:

```ts
// Before (failing)
it("schema version is 108 after init", () => {
  expect(db.getSchemaVersion()).toBe(108);
});

// After
it("schema version is 109 after init", () => {
  expect(db.getSchemaVersion()).toBe(109);
});
```

The durable fix is the corrected sweep command — run at the **repo root**, not `packages/`, whenever `SCHEMA_VERSION` changes (substitute the old version):

```sh
grep -rn --exclude-dir=node_modules 'toBe(108)' .
```

## Why This Works

`SCHEMA_VERSION` in `packages/core/src/db.ts` is the authoritative migration counter. Any workspace that instantiates `@fusion/core`'s `Database` runs all migrations on `init()` and therefore observes the current version — including plugin workspaces. `pnpm-workspace.yaml` globs both `packages/*` and `plugins/*` (plus named plugin dirs); schema-version assertions can live in any of them. The sweep convention predated plugin store layers, so its `packages/` scope was stale, not wrong-by-construction.

## Prevention

- **Sweep the whole repo, not `packages/`.** Canonical command for a bump old → new: `grep -rn --exclude-dir=node_modules 'toBe(<OLD>)' .` — the workspace globs in `pnpm-workspace.yaml` are the authoritative list of places assertions can hide.
- **Prefer the import over the literal.** `SCHEMA_VERSION` is a named export of `@fusion/core`; plugin store tests should pin against it instead of a number, which survives every future bump with no sweep at all:

  ```ts
  import { SCHEMA_VERSION } from "@fusion/core";

  it("schema version matches core after init", () => {
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
  });
  ```

  (Core's own migration tests legitimately keep literals — they pin specific forward-path versions. The import pattern is for *downstream* consumers that just track core.)
- **As of 2026-06-05**, `fusion-plugin-roadmap` is the only plugin with a live `getSchemaVersion()` assertion, but any plugin adding a store layer backed by core's `Database` becomes a candidate. CI shards do run `plugins/` suites, so CI is the backstop — the sweep exists to catch it pre-push.

## Related Issues

- [[bundled-plugin-registration-drift]] (`docs/solutions/integration-issues/bundled-plugin-registration-drift.md`) — companion failure class: an operation scoped to `packages/` silently missing the `plugins/` workspace peer. Its `packages/`-scoped grep example is correct *for its own domain* (registration points live in `packages/`); do not read it as endorsing `packages/`-only scope for schema sweeps.
- `docs/solutions/architecture-patterns/i18n-foundation-vite-ink-monorepo-code-split-catalogs.md` — shared principle: eliminate the hardcoded second source of truth in favor of the derived/imported value.
