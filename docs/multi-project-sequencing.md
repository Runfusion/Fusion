# Multi-Project Sequencing and Dependency Analysis

[← Docs index](./README.md)

## Foundational layer

This note aligns sequencing across FN-3448, FN-3449, FN-3503, and FN-3182 using current contracts in docs and code.

Evidence highlights:
- `docs/shared-mesh-protocol.md` defines `strong` writes, quorum/ack, fencing, and explicitly marks FN-3449 as part of the protocol implementation sequence (Section 14).
- `packages/core/src/central-db.ts` defines `projects(id, path UNIQUE, nodeId, settings)` where `id` is canonical registry identity and `path` is a unique local filesystem location.
- `packages/core/src/central-core.ts` generates `RegisteredProject.id` (`proj_<uuid>`), stores absolute `path`, and treats node assignment via `assignProjectToNode()` / `unassignProjectFromNode()` as separate from registration.
- `docs/multi-project.md` already distinguishes runtime placement (`projects.nodeId`) from task-routing defaults (`defaultNodeId`).
- `packages/core/src/async-plugin-store.ts` persists global plugin installs in PostgreSQL `central.plugin_installs` and project activation state in `central.project_plugin_states`.
- FN-3182's global-install/project-activation split is implemented; project activation remains keyed by normalized project path, so FN-3503's node-specific path mapping remains relevant to future cluster-wide identity alignment.

## Identity model

Current identity boundaries are not interchangeable:
- `RegisteredProject.id` (central logical identity): stable registry key for cross-node/project orchestration.
- `projects.path` (local absolute path): host-local location; unique in one registry DB, but not portable identity across nodes.
- `projects.nodeId` (runtime placement): where a project runtime is hosted; not a task routing default and not a filesystem mapping key.
- Project settings `defaultNodeId` (task dispatch default): separate from runtime placement (`docs/multi-project.md`).
- Plugin scope is global install + project-scoped enablement. The activation model still depends on path-based keys and therefore intersects FN-3503 identity work.

Implication: any multi-node plugin/project-state design that treats `projects.path` as cluster identity will conflict with FN-3503’s per-node path mapping direction.

## Recommended sequencing

Recommended board edges (hard vs alignment):
- **Hard prerequisite:** `FN-3448 -> FN-3449` (already present; keep).
- **No dependency needed:** `FN-3449` does **not** need `FN-3503` or `FN-3182` to land its allocator contract.
- **Can proceed locally now, but needs follow-on alignment:** `FN-3182` can implement global install + per-project enablement for single-node/local multi-project flows now, but should preserve a migration seam for project identity keys once node-specific path mapping lands.
- **Recommended alignment edge:** `FN-3503 -> FN-3182` for full multi-node correctness, because FN-3503 supplies the missing canonical model for node-specific working directories that path-keyed plugin state otherwise bakes in.

Bridge-task recommendation (if board wants stricter decomposition):
- Create a follow-up bridge task after FN-3503 to migrate any path-keyed project-scoped plugin rows to `RegisteredProject.id` (with node-aware resolution where needed), then have that bridge task feed final FN-3182 mesh-safe state semantics.

Comment recommendations to post:
- On **FN-3449**: keep only the existing hard dependency on FN-3448; do not add FN-3503/FN-3182 dependencies.
- On **FN-3503**: call out that this task is the identity substrate for any cross-node feature currently keying by local absolute path.
- On **FN-3182**: recommend adding dependency on FN-3503 for cluster-safe identity, or explicitly scope first landing to local/single-node semantics with planned follow-up migration.

## Risks of out-of-order execution

- If FN-3182 lands full multi-node semantics before FN-3503, path-keyed per-project state can silently split/alias one logical project across nodes.
- If implementers conflate `projects.nodeId` with `defaultNodeId`, runtime placement and task dispatch behavior may diverge in production (`docs/multi-project.md` explicitly separates them).
- If teams treat `projects.path` as a durable cross-node identity instead of location metadata, later migration to per-node mappings becomes a data-rewrite project instead of a bounded compatibility migration.
- If FN-3449 is delayed behind unrelated identity tasks, mesh write-coordination rollout loses its first strongly coordinated write primitive even though its contract is already anchored by FN-3448.

Task references: FN-3448, FN-3449, FN-3503, FN-3182.
