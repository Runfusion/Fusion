# PostgreSQL Runtime Cutover Review

**Date:** 2026-07-14
**Scope:** End-to-end runtime, migration, plugin, operator-documentation, and deployment audit
**Current authority:** PostgreSQL is mandatory for Fusion runtime metadata

> This review supersedes the readiness verdict in the [2026-06-26 migration review](./postgres-migration-review-2026-06-26.md). That earlier document remains an historical record of the incomplete migration branch and its original findings.

## Verdict

Fusion no longer supports SQLite as a live runtime backend. Startup selects either Fusion-managed embedded PostgreSQL or an external PostgreSQL target supplied through `DATABASE_URL`; failure to establish PostgreSQL is fatal. The former `FUSION_NO_EMBEDDED_PG` escape hatch is rejected rather than selecting SQLite.

Legacy `fusion.db`, `archive.db`, and `fusion-central.db` files remain readable only at controlled identity-discovery and one-time migration/import seams. They are never a supported write target or runtime fallback. `.fusion/project.json` is the local project identity marker after cutover.

### Embedded PostgreSQL resource floor

The zero-config embedded PostgreSQL lifecycle uses mmap-backed primary shared memory so hosts with constrained SysV shared-memory IDs can boot without operator tuning. The supported, tested constrained-host floor is **64MB `/dev/shm`**; `fn serve` and the built boot smoke inherit this default. Operators can still provide a later PostgreSQL `-c shared_memory_type=…` flag when a deployment needs an explicit override.

## PostgreSQL-authoritative inventory

| Surface | PostgreSQL authority |
|---|---|
| Project registry, nodes, task claims, global settings, global secrets, plugin installs and activation | `central` schema |
| Active and soft-deleted tasks, workflow state, comments, attachments, documents, artifacts, approvals, agent/chat/session state, messages, automations, routines, insights, research, Todo, missions, knowledge metadata, operational logs | `project` schema, scoped by canonical `project_id` |
| Archived task snapshots and archive search | `archive.archived_tasks`, scoped by canonical `project_id` |
| Reports, CLI Printing Press, Compound Engineering, Roadmap, Even Realities, and other bundled plugin state | Plugin-owned PostgreSQL tables with project ownership and isolation |
| WhatsApp authentication/session persistence | PostgreSQL-backed plugin persistence |
| Filesystem identity and large/task-local payloads | `.fusion/project.json`, task files, attachments, artifacts, and `agent-log.jsonl`; these are compatibility/blob surfaces, not SQLite authority |

The runtime construction boundary supplies an async PostgreSQL data layer to `TaskStore`, dashboard project stores, CLI commands, desktop runtime, engine runtime, and bundled plugins. Store creation without that layer fails closed instead of silently constructing SQLite authority.

## Cutover fixes completed

- Made PostgreSQL startup mandatory and removed the environment-controlled SQLite fallback.
- Centralized project identity on `.fusion/project.json` plus `central.projects`; legacy SQLite identity is imported only when the marker/registry needs initial recovery.
- Completed active-task, cold-archive, workflow, mission, research, Todo, knowledge, CLI-session, maintenance, and phantom-reservation PostgreSQL paths.
- Scoped active, archive, and plugin rows by canonical project identity and applied project isolation constraints/policies.
- Made archive list/search/restore behavior PostgreSQL-native, project-isolated, and bounded where the board/API contract is paginated.
- Ported bundled plugin persistence, including Reports, CLI Printing Press, Compound Engineering, Roadmap, Even Realities, and WhatsApp, away from runtime SQLite access.
- Removed the dashboard's obsolete “PostgreSQL is coming next version” banner.
- Made CLI, dashboard, desktop, and in-process runtime teardown retain and close the PostgreSQL owner exactly once, including startup-failure paths.
- Ported maintenance and repair scripts that operate on live Fusion data to the PostgreSQL backend helper.
- Updated current operator/developer documentation so SQLite descriptions are limited to explicitly historical or migration-only material.

## Intentional remaining SQLite readers

The following readers are authorized after cutover. Their scope is deliberately narrow and read-only:

| Reader | Authorized purpose |
|---|---|
| `packages/core/src/postgres/sqlite-migrator.ts` | Inventory, validate, copy, and verify legacy project/archive/central SQLite sources during one-time import. |
| `packages/core/src/project-identity.ts` | Recover a legacy project ID when `.fusion/project.json` has not yet been written. |
| `packages/core/src/sqlite-validation.ts` | Validate a retained legacy SQLite source before migration/recovery. |
| `packages/core/src/postgres/startup-factory.ts` | Import a legacy central registry during the controlled first PostgreSQL startup. |
| `packages/cli/src/commands/db.ts` | Explicit migration/dry-run and legacy-source inspection, including read-only central-source discovery. |
| `scripts/lib/start-local-project.mjs` | Read legacy local project metadata while the development launcher resolves a project; it never supplies runtime database authority. |

Legacy SQLite adapter/store modules and exports may remain for migration compatibility and historical tests, but mandatory runtime constructors do not select them. Any new production call that opens one for ordinary task, dashboard, engine, CLI, desktop, or plugin traffic is a cutover regression.

The following file roles are not SQLite database authority and should not be confused with a fallback:

- `.fusion/project.json`: canonical local identity marker.
- `.fusion/tasks/{ID}/task.json`: compatibility/debug material used by guarded reconciliation.
- `.fusion/tasks/{ID}/agent-log.jsonl`: intentional file-backed agent log.
- Retained `fusion.db`, `archive.db`, and `fusion-central.db`: immutable migration/recovery evidence after successful import.

## Removed runtime fallback contract

- Normal startup must not continue without a healthy PostgreSQL connection.
- `FUSION_NO_EMBEDDED_PG` is obsolete and rejected.
- `fusion.db` presence is only a migration signal; it is not sufficient project identity after `.fusion/project.json` has been established.
- Dashboard, engine, CLI, desktop, and plugin stores must not construct an operational SQLite store when their PostgreSQL owner is unavailable.
- A migration failure is visible and blocking. Fusion must not hide it by starting against an empty alternate backend.

## Deployment, backup, restore, and rollback

Treat the first production cutover as a maintenance-window migration:

1. Quiesce every engine, dashboard, daemon, desktop runtime, scheduler, automation, and plugin writer. Only one migration owner may run.
2. Record canonical project-path-to-`project_id` mappings and baseline row counts/status distributions.
3. While legacy writers are stopped, copy each legacy SQLite file together with any `-wal`/`-shm` companion and record SHA-256 plus `PRAGMA quick_check` output. Store that evidence off-host.
4. Create a full PostgreSQL backup that includes `central`, `project`, `archive`, plugin tables, and public migration bookkeeping. The built-in paired project/central dumps are not a single cluster-wide snapshot, so a quiesced full-cluster backup remains the deployment safety boundary.
5. Restore the backup into an isolated scratch database and run row-count, schema-version, ownership, and project-isolation checks there. Listing a dump is not a restore test.
6. Use PostgreSQL 15-compatible `pg_dump`, `pg_restore`, and `psql` clients. For external transaction poolers, provide a direct `DATABASE_MIGRATION_URL` for schema work.
7. Run the migration preview, then the migration once from one approved owner. `fn db migrate` is the recommended explicit external-database path; first startup retains a fail-safe verified auto-import for either backend so Fusion never boots an empty PostgreSQL authority over valid legacy data.
8. Before resuming writers, require complete migration markers, no failed/running marker, no unexplained `__legacy_unscoped__` or stale `local-*` partition, matching baselines, and a project-A-cannot-read-project-B isolation proof.

Rollback is restore-only. Stop writers, preserve failure evidence, and restore the tested PostgreSQL backup/snapshot. Do not try to roll back by enabling SQLite or by writing new runtime data into the retained legacy files. If a legacy import must be retried, restore/copy its immutable source into a controlled migration workspace and re-run the supported migration workflow.

## Verification record

| Verification | Result |
|---|---|
| Focused PostgreSQL migration, identity, archive, workflow, mission, plugin, maintenance, and lifecycle tests | PASS — all targeted suites green, including concurrency, ownership, failure, and real-runtime composition cases |
| `pnpm --filter @fusion/core typecheck` | PASS |
| `pnpm --filter @fusion/engine typecheck` | PASS |
| `pnpm --filter @fusion/dashboard typecheck` | PASS |
| `pnpm --filter @runfusion/fusion typecheck` | PASS |
| `pnpm --filter @fusion/desktop typecheck` | PASS |
| `pnpm check:changesets` | PASS |
| `pnpm lint` | PASS |
| `pnpm build` | PASS (only existing Vite chunk/dynamic-import warnings) |
| `pnpm test:gate` | PASS — 40 files and 478 tests |
| `pnpm smoke:boot` | PASS — CLI help, health 200 on an ephemeral port, clean shutdown |
| `pnpm verify:fast` | PASS — artifact bootstrap, CLI build, and boot smoke |
| `git diff --check` and final production SQLite-reader grep | PASS — exactly the six documented read-only legacy boundaries remain |

The explicit full workspace suite remains opt-in and is not a substitute for the thin merge gate or the file-scoped PostgreSQL regression tests.

## Ongoing guardrail

For every new persistence surface, require a PostgreSQL round-trip test, canonical `project_id` ownership where applicable, a previous-state migration test for schema changes, lifecycle cleanup coverage, and a repository-wide search proving no new runtime `DatabaseSync`/`node:sqlite` path was introduced. Update this review if the authorized legacy-reader inventory changes.
