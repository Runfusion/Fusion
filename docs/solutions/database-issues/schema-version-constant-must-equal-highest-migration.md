---
title: "SCHEMA_VERSION must equal the highest applyMigration target or the newest migration silently never runs"
date: 2026-06-05
problem_type: database_issue
module: "@fusion/core"
component: db
tags:
  - sqlite
  - migrations
  - schema-version
  - silent-corruption
symptoms:
  - "no such column on a column added by the newest migration, but only on already-upgraded DBs"
  - "fresh databases work, upgraded databases fail"
root_cause: "SCHEMA_VERSION constant was left one behind the highest applyMigration(N) block, so the migrate loop early-returns before running it"
resolution_type: code_fix
---

## Problem

A new SQLite migration block (`applyMigration(110, ...)` adding `chat_sessions.cliExecutorAdapterId`) was added to `packages/core/src/db.ts`, but the `SCHEMA_VERSION` constant was only bumped to `109`. Any database already at version 109 never ran migration 110, so the new column was missing on every upgraded DB — while brand-new databases worked fine.

## Symptoms

- Runtime `no such column: cliExecutorAdapterId` on databases that had been initialized before the change.
- Fresh databases (created after the change) had the column and worked — masking the bug in most local/dev setups and in any test that builds a DB from scratch.
- Every migration test hard-coded `getSchemaVersion()` to `109`, which actively *masked* the defect rather than catching it.

## What Didn't Work

- Schema-from-scratch tests passed: a fresh DB starts at version 0 and falls through *all* migration blocks (ending at 110), so it incidentally gets the column. The bug only reproduces on the upgrade path (a DB sitting at exactly the stale constant value).
- Per-package targeted test runs during implementation stayed green because no test seeded a DB at version 109 to exercise migration 110.

## Solution

Set the version constant to the highest migration target, and add an invariant test so the two can never drift again.

```ts
// packages/core/src/db.ts
// BEFORE
const SCHEMA_VERSION = 109;        // but an applyMigration(110, ...) block exists below
// AFTER
const SCHEMA_VERSION = 110;
```

The migrate loop gates on this constant:

```ts
// Any DB whose stored version is >= SCHEMA_VERSION returns BEFORE later blocks run.
if (version >= SCHEMA_VERSION) return;
```

So a DB at 109 satisfies `109 >= 109` and returns *before* the `if (version < 110)` block — the migration is permanently skipped.

Two secondary fixes that travel with this class of change:

1. **Update the compat/fingerprint surface.** `MIGRATION_ONLY_TABLE_SCHEMAS.chat_sessions` (which feeds `SCHEMA_COMPAT_FINGERPRINT`) also has to list the new column, or the declared schema drifts from the migrated schema.
2. **Seed-at-stale-version migration test.** Add a test that seeds a DB at the *previous* version with the old table shape, runs `init()`, and asserts both the new column exists and `getSchemaVersion()` equals the new constant:

```ts
// seed __meta schemaVersion = '109' + a chat_sessions table, then:
db.init();
const cols = db.raw.prepare("PRAGMA table_info(chat_sessions)").all();
expect(cols.some((c) => c.name === "cliExecutorAdapterId")).toBe(true);
expect(getSchemaVersion()).toBe(110);
```

## Why This Works

The version constant is the *only* gate on whether later migration blocks execute. A migration block whose target exceeds the constant is dead code on the upgrade path. Bumping the constant to match the highest block re-arms the gate; the seed-at-stale-version test reproduces the exact upgrade path that fresh-DB tests skip.

## Prevention

- **Invariant test: the constant equals the highest migration target.** The most durable guard is a test that scans the migration blocks for the maximum `applyMigration(N)` / `if (version < N)` target and asserts `SCHEMA_VERSION === maxTarget`. This catches the drift mechanically regardless of which migration was added.
- **Always add a seed-at-previous-version migration test** alongside any new migration — fresh-DB tests structurally cannot catch a skipped-on-upgrade migration.
- **Treat hard-coded version assertions as a smell.** Many tests asserting `toBe(<oldVersion>)` will need updating on a bump; if updating them feels like whack-a-mole, that is the signal an invariant test should own the number instead.
- **When adding a column, update every declared-schema mirror** (compat fingerprint maps, schema snapshots) in the same change — a migration that adds a column the canonical schema map omits is a second, quieter drift.
