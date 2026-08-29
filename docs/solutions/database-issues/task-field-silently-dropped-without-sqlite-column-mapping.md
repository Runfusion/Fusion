---
title: A Task field is silently dropped on persist unless it has a SQLite column + rowToTask mapping
date: 2026-06-24
category: database-issues
module: core-task-store
problem_type: database_issue
component: database
symptoms:
  - "fn_task_done on a workspace task fails: workspace task declares File Scope but acquired no sub-repo worktrees — cannot verify scope"
  - "A field set via store.updateTask(...) is present on the returned task but undefined on the next store.getTask(...)"
  - "task.json on disk never contains the field even though the update succeeded"
root_cause: incomplete_setup
resolution_type: code_fix
severity: high
tags: [task-store, sqlite, persistence, rowtotask, workspaceworktrees, silent-data-loss, workspace, multiworkspace]
related_components: [engine-executor, active-session-registry]
---

# A Task field is silently dropped on persist unless it has a SQLite column + rowToTask mapping

## Problem
Adding a field to the `Task` TypeScript type and mutating it in `TaskStore.updateTask` is **not** enough to persist it. If the field has no matching SQLite column, no `defineTaskColumn` descriptor, and no `rowToTask` deserialization, the value is silently dropped on the very next read — with no error. This broke all multiworkspace task completion: `task.workspaceWorktrees` (the per-sub-repo worktree map written by `fn_acquire_repo_worktree`) was such a phantom field.

## Symptoms
- `fn_task_done` on a workspace task always blocked with: *"workspace task declares File Scope but acquired no sub-repo worktrees — cannot verify scope"* (`executor.ts` scope verifier reading `task.workspaceWorktrees ?? {}` → `{}`).
- A peer workspace task separately failed with *"active-session path … is held by task … may not overwrite it"* (a second, independent bug fixed alongside — see Related).
- Ground truth: the live failing tasks' `task.json` files contained **zero** occurrences of `workspaceWorktrees`, even though the agent logs showed the sub-repo worktree was acquired and the acquire tool returned its path.

## What Didn't Work
- Treating it as a race / stale-read between the acquire write and the `fn_task_done` read. The field was not racing — it was never persisted at all, so no retry or ordering change would help.
- Inspecting only the executor/scope-verifier side. The verifier read the field correctly; the value was already gone before it ran. The bug was one layer down in the store.

## Solution
Persist the field by mirroring an existing JSON-object column (`mergeDetails` is the canonical example). All of these are required — adding only some leaves the field still broken:

1. **SCHEMA_SQL** — add the column to `CREATE TABLE tasks` in `db.ts` (this feeds `getSchemaCompatibilityTableSchemas()`, so existing DBs get backfilled by `ensureSchemaCompatibility()` at boot).
2. **Versioned migration** — `addColumnIfMissing("tasks", "<col>", "TEXT")` in a new `if (version < N)` block, and bump `SCHEMA_VERSION` to `N`.
3. **db-migrate.ts** — add the column to the legacy `task.json → SQLite` rebuild INSERT (column list, one `?`, and the `toJsonNullable(task.<field>)` value). Keep column/placeholder/arg counts equal.
4. **store.ts descriptor** — `defineTaskColumn("<field>", (task) => toJsonNullable(task.<field>))`. This is what `getChangedTaskColumns` uses to detect the field changed and emit it in the UPDATE.
5. **store.ts TaskRow** — add `<field>: string | null;` to the `TaskRow` interface.
6. **store.ts rowToTask** — deserialize: `<field>: fromJson<...>(row.<field>)`.

```ts
// store.ts — descriptor (drives both the write AND change-detection)
defineTaskColumn("workspaceWorktrees", (task) => toJsonNullable(task.workspaceWorktrees)),

// store.ts — rowToTask (the read side that was missing → undefined on every getTask)
workspaceWorktrees: (() => {
  const w = fromJson<Task["workspaceWorktrees"]>(row.workspaceWorktrees);
  return w && Object.keys(w).length > 0 ? w : undefined;
})(),
```

## Why This Works
The trap is in the persist path. `TaskStore.updateTask` mutates the in-memory task, but `applyTaskPatch` writes **`result.current`** to `task.json` — and `result.current` comes from `readTaskFromDb()` → `rowToTask()`, i.e. a fresh round-trip *through SQLite*. A field with no column never makes it into the row, so `rowToTask` reconstructs the task **without** it, and that stripped object is what gets written back to `task.json`. The in-memory mutation is overwritten by the DB's view on the same call. Every later `getTask` reads from SQLite and returns `undefined`. SQLite — not `task.json` — is the source of truth; `task.json` is a debug mirror that is itself rebuilt from the DB round-trip.

## Prevention
- When adding a persisted `Task` field, treat the six edit sites above as one atomic change. The `Task` type compiling is **not** evidence the field persists — TypeScript never sees the SQLite layer.
- Always write a round-trip regression test that asserts the field survives `getTask`, `listTasks`, **and** a full store reopen (`reopenDiskBackedStore` in `store-test-helpers.ts`). An in-memory-only assertion would pass even with the bug, because the bug lives in the SQLite round-trip:

```ts
const updated = await store.updateTask(id, { workspaceWorktrees: map });
expect(updated.workspaceWorktrees).toEqual(map);          // passes even when broken
const detail = await store.getTask(id);
expect(detail.workspaceWorktrees).toEqual(map);            // FAILS when broken — the real check
```

- The `architecture-schema-compat` test enforces that fresh-from-SCHEMA_SQL and migrated DBs converge, so the SCHEMA_SQL column and the migration must both be added (see Related).

## Related Issues
- `docs/solutions/database-issues/schema-version-constant-must-equal-highest-migration.md` — the companion rule for the `SCHEMA_VERSION` bump that accompanies any new migration.
- Same fix (PR #1747) also resolved a second multiworkspace bug: concurrent workspace tasks collided on the shared browse-only workspace root in the path-keyed `activeSessionRegistry` (every task registered `this.rootDir` as its executor session, so the foreign-task guard rejected the second). Fixed by giving each workspace task a task-scoped synthetic session key (`sessionRegistryPath` in `executor.ts`), applied symmetrically at all register/unregister sites.
