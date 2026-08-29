---
category: architecture-patterns
module: fusion-core-settings
date: 2026-07-24
problem_type: architecture_pattern
component: storage
severity: medium
applies_when:
  - "Adding a key to GlobalSettings and deciding where it must live"
  - "Proposing that global settings move into PostgreSQL"
  - "Reading settings from a synchronous, host-agnostic path (credential resolution, bootstrap)"
  - "Making operator configuration consistent across multiple nodes"
tags:
  - settings
  - global-settings
  - postgres
  - bootstrap
  - multi-node
  - credential-resolution
related_components:
  - packages/core/src/global-settings.ts
  - packages/core/src/settings-schema.ts
  - packages/core/src/postgres/startup-factory.ts
  - packages/core/src/task-store/settings-ops.ts
  - packages/engine/src/auth-storage.ts
---

# Where global settings live, and why not all of it can be in Postgres

## The question

Fusion's project settings are in PostgreSQL. Global (user-level) settings are a JSON file.
That asymmetry reads like unfinished migration work, and the recurring proposal is to "finish
the cutover" by moving global settings into the database too.

Answer: **no, not wholesale.** Two constraints make a full move impossible, and one real
motivation makes a *partial* move worth designing deliberately.

## What is true today

Global configuration is already split three ways, and only one of those splits was designed:

| Data | Store |
| --- | --- |
| `GlobalSettings` values | `settings.json` in the resolved global dir (`GlobalSettingsStore.atomicWrite`) |
| Global settings *revision journal* | PostgreSQL, via `AsyncDataLayer` in `global-settings.ts` |
| `globalMaxConcurrent` | PostgreSQL — `central.global_concurrency` |
| `defaultProjectId` | PostgreSQL — `central.central_settings` |
| Project settings | PostgreSQL, merged OVER global at `settings-ops.ts` (`{ ...DEFAULT_SETTINGS, ...updatedGlobal, ...config.settings }`) |

So the live question is never "file or database" — it is **which tier does a given setting
belong to**. Today that answer is accidental.

## Constraint 1 — bootstrap circularity

`packages/core/src/postgres/startup-factory.ts` reads the global settings file to *start*
PostgreSQL:

```ts
: (await new GlobalSettingsStore(options.globalSettingsDir).getSettings()).embeddedPostgresMaxConnections;
```

The database's own startup configuration cannot come from the database. Every setting in this
class — embedded PG tuning, database location, backup destinations — must remain readable
before any connection exists.

## Constraint 2 — the synchronous, host-agnostic credential path

`createFusionAuthStorage()` takes no arguments, has no project scope, and runs in every host:
dashboard, desktop, daemon, and one-shot CLI invocations. Credential resolution
(`resolveAnthropicRuntimeApiKey`) reads global preference material from the same directory it
already reads `auth.json` and `models.json` from, synchronously.

Moving that material into PostgreSQL would put an async database connection in the hottest and
most host-agnostic path in the system, for every CLI invocation — including ones that never
otherwise open a store.

There is also a scoping argument specific to credentials: the credentials themselves are
per-machine files (`~/.fusion/agent/auth.json`). A *shared* preference pointing at a credential
that does not exist on a given node is worse than per-node divergence, because it fails at
request time with a provider auth error rather than at configuration time.

## Constraint 3 — recovery

Database corruption has recurred in this project's history. Settings that govern backup and
recovery policy being readable — and hand-editable — while the database is down is a
deliberate property, not an accident of the old design.

## The one real argument for moving

**Multi-node consistency.** Multi-node means several nodes sharing one central PostgreSQL
database, but each node keeps its own local `settings.json`. Operator policy that is nominally
"global" therefore diverges silently per machine. This is the only motivation that the file
cannot satisfy, and `central.global_concurrency` is already precedent for the fix.

## Recommended shape

Make the tiering explicit rather than migrating wholesale:

- **Machine / bootstrap tier — stays in the file.** Embedded PostgreSQL configuration,
  database and backup paths, and anything credential resolution reads synchronously
  (including `anthropicAuthPreference`).
- **Operator-policy tier — may move to central PostgreSQL** if and when cross-node consistency
  is required: concurrency, model defaults, workflow policy.

When adding a `GlobalSettings` key, ask: *is this read before the database is available, or on
a synchronous path with no store?* If yes, it is machine tier and belongs in the file.

## Gotchas

- **The global dir is not always `~/.fusion`.** `resolveGlobalDirForHome` falls back to the
  pre-rename `~/.pi/fusion` and `~/.pi/kb`. Code reading the settings file directly must honor
  that fallback — `getModelRegistryModelsPath` (models.json) and
  `getFusionGlobalSettingsPath` (settings.json) in `packages/engine/src/auth-storage.ts` both
  do. Hardcoding `~/.fusion` silently ignores an un-migrated operator's configuration.
- **Do not call core's `resolveGlobalDir()` from engine-side readers.** It throws under
  `VITEST` when called without an explicit dir, by design, so tests cannot write to a real home
  directory. Engine readers use a local candidate list instead.
- **Project settings merge OVER global.** A key present in both scopes resolves to the project
  value. Global-only keys stay global-only because the save-split routes on
  `GLOBAL_SETTINGS_KEYS` (derived from `Object.keys(DEFAULT_GLOBAL_SETTINGS)`) and they are
  absent from `DEFAULT_PROJECT_SETTINGS`. That pairing is the invariant — breaking either half
  makes a "global" setting project-overridable.
- **Do not build on `central.settings_sync_state`.** It is mesh-sync residue; mesh sync is
  going away. Multi-node is several nodes against one central database, which is exactly why
  the PostgreSQL tier works if cross-node policy consistency is wanted.
