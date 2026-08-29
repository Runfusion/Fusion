---
title: "feat: Workspace mode Phase D — self-healing reconcilers + e2e harness"
status: active
date: 2026-06-22
type: feat
origin: docs/plans/2026-06-21-002-feat-workspace-mode-execution-model-plan.md (master plan, Phase D / U8·U9)
depth: deep
---

# feat: Workspace mode Phase D — self-healing reconcilers + e2e harness

> **ID namespace:** local `U1·U2` decompose master-plan **U8, U9**.
> **Anchors feasibility-VERIFIED.** The pre-check found a P0 (an existing reconciler wrongly finalizes a partial-landed workspace task) and resolved all three forks — folded in below.

## Summary

Phase D closes the workspace-mode lifecycle. **The headline is not new reconcilers — it's making the EXISTING self-healing layer workspace-aware**, because Phase C's `status:"merging"` and the singular `task.worktree===null` shape make the current reconcilers either wrongly finalize or silently skip workspace tasks. Plus new reconcilers for partial-land recovery, phantom land-lease reclaim, and per-repo worktree cleanup, and an e2e harness proving the full lifecycle with no remote push. Final phase.

Builds on Phase C (#1717): `landWorkspaceTask`, `isRepoLanded` (exported), `workspaceWorktrees[repo].landedSha`, the `workspace-repo-land` lease, `WorkspacePartialLandError`, the canonical `isWorkspaceTask`.

**Stacking:** off Phase C; PR diff includes the whole stack; must not merge until it lands.

---

## Problem Frame

Phase C made workspace merges land-as-you-go, but the engine's self-healing reconcilers reason about a singular `task.worktree` + a single landed commit. Two are actively wrong/blind for workspace tasks, and three new states have no recovery:

- **(P0) `recoverInterruptedMergingTasks` (self-healing.ts:6670) + `recoverStaleMergingStatus` (:2446)** act on any `ACTIVE_MERGE_STATUSES` task; `landWorkspaceTask` sets `"merging"` (merger-ai.ts:1525). If the holder dies after repo A lands, these call the **singular** `findLandedTaskCommit` (:1620, git over the non-git workspace `rootDir`) and on a one-repo hit **finalize the whole task to done + emit `task:merged`** — marking a partial-landed workspace task fully merged.
- **(P1) `recoverMergeableReviewTasks` (:5758)** filters on `Boolean(t.worktree)` (:5778) → a mergeable workspace task whose merge enqueue was dropped is **silently skipped forever**.
- New states with no recovery: a **partial-landed** stuck task, a **phantom `workspace-repo-land` lease** held by a dead task, and **orphaned per-repo worktrees**.
- **Triple-proof** (`evaluateBackwardMoveTripleProof` :820) classifies liveness via `task.worktree`/`canonicalFusionBranchName` — not workspace-aware (liveness lives across N sub-repo worktrees).

---

## Key Technical Decisions

### KTD1 — Make the EXISTING merging-status + mergeable-review reconcilers workspace-aware (P0/P1; master U8; FN-5893)
For an `isWorkspaceTask(task)` candidate:
- `recoverInterruptedMergingTasks` / `recoverStaleMergingStatus` must **NOT** use `findLandedTaskCommit`/single-commit finalize. Instead clear the transient `"merging"` status and decide via the **per-repo** `isRepoLanded` predicate: all repos landed → finalize once (the `finalizeWorkspaceTask` path); partial/none → re-enqueue (KTD3). Never finalize a workspace task on one repo's commit.
- `recoverMergeableReviewTasks` must admit `isWorkspaceTask` candidates (relax the `Boolean(t.worktree)` gate to `Boolean(t.worktree) || isWorkspaceTask(t)`), so a zero-landed mergeable workspace task is re-enqueued, not skipped.

### KTD2 — New partial-land reconciler + workspace-aware liveness; re-enqueue via `enqueueMerge` (master U8; FORK-A resolved)
A new reconciler finds workspace tasks in a non-done state with a stale binding and re-enqueues the merge via **`this.options.enqueueMerge?.(task.id)`** (`SelfHealingOptions.enqueueMerge` :308, wired in-process-runtime.ts:795 → `internalEnqueueMerge` → routes workspace tasks to `landWorkspaceTask`) — **NOT a direct `landWorkspaceTask` call**. `landWorkspaceTask` is idempotent (`isRepoLanded` skips landed repos). Reuse `allowsAutoMergeProcessing` (task-merge.ts:62 — the canonical FN-5147 `autoMerge:false` guard) + user-pause + a **workspace-aware liveness predicate** (any sub-repo worktree active via `activeSessionRegistry.pathsForTask(task.id)` + `isPathActive`, since triple-proof isn't workspace-aware). Emits `task:reconcile-workspace-partial-land` (+ `-no-action`).
**FORK-A (unrecoverable):** a repo is unrecoverable iff its `fusion/<id>` branch is gone **AND** `landedSha` is unset (nothing landed, nothing to land) → park `status:"failed"`. Branch gone but `landedSha` set → already landed (`isRepoLanded` ancestor check) → skip. Otherwise retryable.

### KTD3 — Phantom `workspace-repo-land` lease reclaim via a new registry enumeration seam (master U8)
`ActiveSessionRegistry` exposes only `lookupByPath`/`isPathActive`/`pathsForTask` — no enumeration by kind, and a dead task is gone from the in-progress lists (so FN-6736's iterate-tasks approach can't surface a leaked lease). **Add an enumeration seam** `entriesByKind(kind)` → `{path, taskId, kind, registeredAt}[]` (`registeredAt` already tracked, active-session-registry.ts:31). The reconciler enumerates `workspace-repo-land` entries, and for each whose owner is terminal/dead AND `registeredAt` older than a floor (reuse the FN-6736 `graceMs * PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER` analog, :966), clears it + emits `task:reclaim-phantom-workspace-land-lease`.

### KTD4 — Per-repo worktree cleanup from the STORED paths, no directory walk (master U8; FORK-B resolved)
**FORK-B premise was wrong** — per-repo worktrees are not anonymous: `workspaceWorktrees[repo].worktreePath` is persisted (types.ts:2276). For a done/dead workspace task, read each recorded `worktreePath` and `git worktree remove --force` it, guarded by `activeSessionRegistry.isPathActive(path)` (mirroring self-healing.ts:9955). **No temp-root readdir/walk** (AGENTS.md) — bounded by construction. Emits `task:reconcile-orphaned-workspace-worktree`.

### KTD5 — e2e harness placement: engine-default (`describeIfGit`), not the gate (master U9; FORK-C resolved)
The merge gate (`engine-core`) is an explicit allow-list excluding real-git tests — a real two-repo fixture e2e cannot run there. Model the **merge + recovery** e2e on `workspace-merger.test.ts` (unmarked, `describeIfGit`, engine-default lane): drive `landWorkspaceTask` directly + invoke the U1/KTD2 reconciler method directly with fake timers; assert local-ref advancement, **no push**, and partial-land recovery. Reuse the existing `executor-workspace-capture.test.ts` / `reviewer-workspace.test.ts` direct-call tests for the capture/review legs. Reserve a single `.slow.test.ts` (engine-slow lane) only if a full ProjectEngine acquire→capture→review→merge loop must be proven.

---

## Implementation Units

> **Standing requirements:** `FNXC:Workspace <yyyy-MM-dd-hh:mm>`; a `.changeset/*.md` (`@runfusion/fusion: minor`); FN-5048 (real two-repo fixture; fake timers; no mock-the-world; **no unbounded temp walk**); FN-5893 (the EXISTING reconcilers are in scope, not just new ones); the merge gate. Branch off Phase C (`gsxdsm/workspace-phase-d`).

### U1. Workspace-aware self-healing (master U8)

**Goal:** Make the existing reconcilers workspace-safe (P0/P1) and add partial-land recovery, phantom-lease reclaim, and per-repo worktree cleanup — none moving a human-gated/live task backward.

**Requirements:** KTD1, KTD2, KTD3, KTD4.

**Dependencies:** Phase C.

**Files:**
- `packages/engine/src/self-healing.ts` — workspace-aware branches in `recoverInterruptedMergingTasks` (:6670), `recoverStaleMergingStatus` (:2446), `recoverMergeableReviewTasks` (:5758); the new partial-land reconciler (re-enqueue via `enqueueMerge`); the phantom-lease reclaim (via the new registry seam); the per-repo worktree cleanup; the workspace-aware liveness predicate.
- `packages/engine/src/active-session-registry.ts` — new `entriesByKind(kind)` enumeration seam.
- `packages/engine/src/run-audit.ts` — add the four literals to the `DatabaseMutationType` union (`task:reconcile-workspace-partial-land`, `-no-action`, `task:reclaim-phantom-workspace-land-lease`, `task:reconcile-orphaned-workspace-worktree`).
- `AGENTS.md` — add the new run-audit events to the Run Audit list.
- `packages/engine/src/__tests__/self-healing-workspace.test.ts` (new — real two-repo fixture).

**Approach:** Per KTD1-KTD4. Reuse `allowsAutoMergeProcessing` + the workspace-aware liveness predicate as the "safe to move backward" gate; re-enqueue via `enqueueMerge`; mirror FN-6736 for the lease floor; cleanup from stored paths.

**Test scenarios:**
- A partial-landed (repo A `landedSha`, repo B not) task stuck `"merging"` with no live holder → `recoverInterruptedMergingTasks` does **NOT** finalize it done; the partial-land reconciler re-enqueues; a later land completes it (skipping A). (P0 regression + recovery)
- A zero-landed mergeable workspace task whose merge was dropped → `recoverMergeableReviewTasks` re-enqueues it (not skipped by the `worktree` gate). (P1)
- `autoMerge:false` / user-paused / a live sub-repo worktree (via `pathsForTask`+`isPathActive`) → `-no-action` (not moved backward). (FN-5147 guards)
- A `workspace-repo-land` lease owned by a terminal/dead task, older than the floor → reclaimed; owned by a live merging task → untouched. (phantom reclaim)
- A done workspace task's recorded per-repo worktrees → removed (guarded by `isPathActive`); a live task's → untouched; **no temp-root walk**. (cleanup)
- A repo with branch gone + `landedSha` unset → parked failed; branch gone + `landedSha` set → skipped as landed. (FORK-A)
- Single-repo (non-workspace) tasks → all reconcilers behave identically. (regression)

**Verification:** No reconciler wrongly finalizes/skips/moves-backward a workspace task; partial/phantom/orphan states recover; single-repo unchanged; no unbounded walk.

### U2. End-to-end merge + recovery harness (master U9)

**Goal:** Prove a real two-repo workspace task lands both repos on local refs with no push, and that partial-land recovers via U1.

**Requirements:** KTD5.

**Dependencies:** U1.

**Files:** `packages/engine/src/__tests__/workspace-e2e.test.ts` (new — engine-default lane, `describeIfGit`, real two-repo fixture, fake timers).

**Approach:** Per KTD5. Drive `landWorkspaceTask` on a real two-repo fixture; assert both local integration refs advanced, **no `refs/remotes` change / no push**, `landedSha` per repo, finalize-once. Partial-land: force repo B conflict → assert A landed + task not done, then invoke the U1 partial-land reconciler (fake timers) → assert recovery. Reference the existing `executor-workspace-capture` / `reviewer-workspace` tests for the capture/review legs (don't re-drive the full engine loop unless a `.slow` test is added).

**Test scenarios:**
- Two repos land → both local refs advanced, **no push**, both `landedSha`, task done once. (e2e happy + no-push invariant)
- Partial-land → A landed, task not done → U1 reconciler → recovery completes. (e2e recovery)

**Verification:** Real workspace task lands end-to-end with no remote push; partial-land self-heals.

---

## Scope Boundaries

**In scope:** workspace-aware existing reconcilers + the three new reconcilers (U1), the merge+recovery e2e (U2).

### Deferred to Follow-Up Work
- Extracting `workspace-merger.ts`; per-sub-repo cwd reachability verification; store-level atomic per-repo merge (Phase-C residuals).
- A full ProjectEngine acquire→capture→review→merge `.slow` loop test (only if needed).
- Rich dashboard per-repo merge-status UI. Remote push of integration refs (out — D2/D5).

---

## Risks & Dependencies

- **R1 (P0-class) — wrongly finalizing/skipping/moving-backward a workspace task.** The whole point of U1. Mitigation: KTD1 fixes the two wrong/blind reconcilers; every reconciler reuses `allowsAutoMergeProcessing` + the workspace-aware liveness predicate + triple-proof analog; tests assert the `-no-action` + no-wrong-finalize paths.
- **R2 — unbounded temp walk.** Mitigation: KTD4 uses stored paths only; test asserts no walk.
- **R3 — e2e lane.** Mitigation: KTD5 places it in engine-default (`describeIfGit`), not the gate.
- **R4 — reconciler idempotency / double-act.** Mitigation: `isRepoLanded` + `enqueueMerge` idempotency.
- **Stacking:** off Phase C (#1717).

---

## Sources & Research

- Master plan (U8/U9, FN-5147/FN-6736).
- Phase-D feasibility pre-check (verified anchors: the P0 `recoverInterruptedMergingTasks`/`findLandedTaskCommit` finalize, `recoverMergeableReviewTasks` `Boolean(t.worktree)` gate :5778, `enqueueMerge` :308, no registry `entriesByKind`, stored `worktreePath`, engine-core gate allow-list, `allowsAutoMergeProcessing` :62, triple-proof :820, FN-6736 floor :966).
- Phase C (#1717): `isRepoLanded`, `landedSha`, the lease, `landWorkspaceTask`, `isWorkspaceTask`.
- `self-healing.ts`, `active-session-registry.ts`, `run-audit.ts`, `_workspace-fixture.ts`, `workspace-merger.test.ts` (the lane model).
