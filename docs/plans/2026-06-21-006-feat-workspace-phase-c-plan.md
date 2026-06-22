---
title: "feat: Workspace mode Phase C — per-repo merge loop (land-as-you-go on local integration refs)"
status: active
date: 2026-06-21
type: feat
origin: docs/plans/2026-06-21-002-feat-workspace-mode-execution-model-plan.md (master plan, Phase C / U5·U6·U7)
depth: deep
---

# feat: Workspace mode Phase C — per-repo merge loop (land-as-you-go on local integration refs)

> **ID namespace:** local `U0·U1·U2·U3` decompose master-plan **U5, U6, U7** (+ a Phase-B-deferred extraction).
> **Anchors are feasibility-pending** — a pre-check runs before implementation (as in Phases A/B). Treat `~:` numbers as approximate until verified.

## Summary

Phase C replaces U0's **R7 guard** — which currently makes every workspace-task merge *throw* `WorkspaceTaskMergeError` — with the real **per-repo merge loop**: for each acquired sub-repo, land that repo's `fusion/<id>` branch onto **that repo's LOCAL integration ref** via a repo-scoped clean-room (the `runAiMerge` mechanism, applied per repo), with no remote push. This is **land-as-you-go** (settled **D2/D5**): repos land independently; a partial land (A lands, B fails) leaves A landed locally and is operator-resettable; an unconditional operator escape hatch always exists.

After Phase C a workspace task can fully run → capture → review → **merge**. **Scope out:** self-healing reconcilers + e2e harness (master U8/U9 = Phase D).

**Stacking:** off Phase B (#1714); PR diff includes the stack; must not merge until it lands.

---

## Problem Frame

`runAiMerge` (merger-ai.ts) lands **one** `task.worktree`'s `fusion/<id>` branch into a single clean-room temp worktree and advances **one** local integration ref via `update-ref` CAS (no push). U0 added the **R7 chokepoint guard** `assertNotWorkspaceTaskMerge(task)` so a `workspaceWorktrees`-bearing task fails fast rather than silently mis-merging the single root. Phase C turns that fail-fast into a real loop: iterate the acquired sub-repos, run the clean-room land per repo against that repo's own local integration ref, track which repos have landed (idempotent retry), hold a per-repo file-scope lease during each land, and aggregate a per-repo `MergeResult`. The single-repo `runAiMerge` path is untouched.

---

## Key Technical Decisions

> **OPEN FORKS — to be confirmed by the feasibility pre-check + user before implementation.** Marked `‹FORK›`. The settled semantics (D2/D5) bound them, but the code shape is to verify.

### KTD0 — Extract `workspace-executor.ts` FIRST (Phase-B-deferred maintainability P1)
Before adding the merge loop, move the workspace branches Phase A/B inlined into `executor.ts` (`captureWorkspaceModifiedFiles`, `reviewWorkspacePerRepo`, the per-repo `verifyWorktreeInvariants` block) into `packages/engine/src/workspace-executor.ts` as module-level functions receiving executor state as args; the `if (this.workspaceConfig)` call sites delegate. Pure move + delegate, no behavior change — its own commit, gate-green, before any Phase-C behavior. This keeps the 16k-line file from absorbing the merge loop too.

### KTD1 — Extract `landOneRepo` from `runAiMerge`, then loop it (master U6; D2/D5) — FORK-A RESOLVED
**Verified:** `runAiMerge`'s land sequence (mkdtemp clean room → `git worktree add --detach` → `installWorktreeDependencies` → `mergeAndReview` → `landSquash` → the concurrent-advance CAS retry loop → `activeSessionRegistry` register/unregister) is an **un-factored inline closure** at `merger-ai.ts:1064-1216`, bound to one `projectRootDir`/`integrationBranch`/`branch`; `mergeAndReview`/`finalizeMerged` are module-private. The CAS seam `advanceIntegrationBranchRef` already takes `rootDir`/`integrationBranch` explicitly. **No remote push anywhere** — D2/D5 "no push" confirmed.

So U1 **extracts** an exported `landOneRepo(store, repoRootDir, branch, integrationBranch, options)` from that closure (returns a per-repo `LandResult`), leaving `runAiMerge` as the byte-for-byte single-repo caller. `landWorkspaceTask(task)` loops the acquired sub-repos calling `landOneRepo` per repo, aggregating a repo-tagged result. **`landOneRepo` stays in `merger-ai.ts`** (the private helpers live there); only the thin `landWorkspaceTask` orchestrator may sit in a new `workspace-merger.ts`.

**Per-repo integration branch (P1 the plan missed):** `workspaceWorktrees[repo]` does NOT store the integration branch (acquisition computes it then discards). `landOneRepo` must **re-resolve per repo** with the same override-stripping acquisition uses — `resolveIntegrationBranch(repoRoot, { ...settings, integrationBranch: undefined, baseBranch: undefined })` — so each sub-repo lands on its own `origin/HEAD`, not a shared branch.

**Per-sub-repo prune rooting (correctness):** `pruneExistingAiMergeWorktrees`/`cleanupStaleTempMergeWorktrees` sweep by the `fusion-ai-merge-<taskId>-` prefix; N per-repo clean rooms share the taskId. Root each sweep at the **sub-repo** (`resolveAiMergeRoot(subRepoRoot)`) so one repo's prune cannot race another repo's live clean room for the same task.

### KTD2 — Door table: route the engine + CLI/dashboard doors, keep the rest throwing (master U6) — RESOLVED
Six guard sites. Per-door (FN-5893):
1. **`project-engine.ts:~2300` engine dispatch** → route `workspaceWorktrees`-bearing tasks to `landWorkspaceTask`.
2. **`runAiMerge:~979` chokepoint guard** → STAYS as defense-in-depth for direct single-repo callers (workspace tasks enter via `landWorkspaceTask`, not here).
3. **`store.mergeTask:~11159`** (core, cannot import `@fusion/engine`) → STAYS throwing.
4. **CLI `dashboard.ts:~1312` + `task.ts:~861`** → **route workspace tasks through the engine merge (`landWorkspaceTask`)** instead of `store.mergeTask`, so user-triggered `fn task merge` / the dashboard merge button work on workspace tasks **(user decision: manual merge works in Phase C)**.
5. **`aiMergeTask` (merger.ts:~7666, deprecated)** → STAYS throwing.

### KTD3 — `landedSha`-only per repo; `landWorkspaceTask` finalizes once; auto-retry then park (master U5) — FORK-B RESOLVED
**Verified:** `finalizeMerged`/`finalizeTask` are **task-global** — they write one task-level `mergeDetails` and move the WHOLE task to `done` (`merger-ai.ts:1298-1401`). So `landOneRepo` must advance the ref + record `workspaceWorktrees[repo].landedSha` **only** (no task move). `landWorkspaceTask` calls `finalizeTask`/move-done **exactly once** after every acquired repo's landed predicate is true.

**Landed predicate:** a repo is landed iff `entry.branch` tip is an ancestor of (or equals) its local integration ref tip (or the recorded `landedSha` is present); `landWorkspaceTask` **skips landed repos** (idempotent).

**Partial-land (user decision: auto-retry then park):** repo B fails after A landed → task goes to a non-done state with A's `landedSha` persisted; the failure **consumes a `mergeRetry`** and the engine **auto-retries `landWorkspaceTask`** (skipping landed A, re-attempting B) up to the existing `MAX`, then **operator-parks** (D5 escape hatch as terminal). No new partial-landed status type — `landedSha` on the entry is the only state added (`types.ts:~2256`).

### KTD4 — Per-repo land lease via `activeSessionRegistry` new kind (master U7) — FORK-C RESOLVED
**Verified:** there is NO separate engine file-scope lease — `activeSessionRegistry` (path-keyed, `kind` enum) is the only mechanism (`runAiMerge` already registers the clean room under `kind:"ai-merge"`). Add a new `ActiveSessionKind` `"workspace-repo-land"` keyed on the **sub-repo absolute path**; register before `landOneRepo`, unregister in `finally`. **The lease is for serialization / clean-room-collision avoidance, not ref correctness** — `advanceIntegrationBranchRef`'s CAS already makes interleaved `update-ref` safe (concurrent-advance → rebuild). Set test expectations accordingly.

---

## Implementation Units

> **Standing requirements:** `FNXC:Workspace <yyyy-MM-dd-hh:mm>` comments; a `.changeset/*.md` (`@runfusion/fusion: minor`); FN-5048 (real two-repo git fixture via `_workspace-fixture.ts`; assert local-ref advancement with NO push; fake timers; no mock-the-world); FN-5893 surface enumeration; the merge gate. Branch off Phase B (`gsxdsm/workspace-phase-c`).

### U0. Extract `workspace-executor.ts` (no behavior change)
**Goal:** Move Phase A/B workspace helpers out of `executor.ts` into `workspace-executor.ts`; call sites delegate. Pure refactor.
**Requirements:** KTD0.
**Dependencies:** none.
**Files:** `packages/engine/src/executor.ts`, `packages/engine/src/workspace-executor.ts` (new), existing workspace tests (imports may shift).
**Approach:** Move `captureWorkspaceModifiedFiles`, `reviewWorkspacePerRepo`, the per-repo `verifyWorktreeInvariants` body; pass `store`/`captureModifiedFiles`/etc. as args. No logic change.
**Test scenarios:** the existing Phase A/B workspace suites pass unchanged (the move is correct iff they stay green). `Test expectation: behavior-preserving — existing suites are the oracle.`
**Verification:** All Phase A/B workspace tests + `test:gate` green; `executor.ts` shrinks; no behavior diff.

### U1. Extract `landOneRepo`, loop it in `landWorkspaceTask`, route the doors (master U6)
**Goal:** Land each acquired sub-repo's branch onto its own local integration ref (land-as-you-go, no push), via an extracted `landOneRepo`; route the engine + CLI/dashboard doors.
**Requirements:** KTD1, KTD2.
**Dependencies:** U0.
**Files:** `packages/engine/src/merger-ai.ts` (extract `landOneRepo` from the `:1064-1216` closure; add `landWorkspaceTask`), `packages/engine/src/project-engine.ts` (`~:2300` dispatch → `landWorkspaceTask`), `packages/cli/src/commands/dashboard.ts` (`~:1312`) + `packages/cli/src/commands/task.ts` (`~:861`) (route workspace tasks to the engine merge), optional `packages/engine/src/workspace-merger.ts` (thin orchestrator), `packages/engine/src/__tests__/workspace-merger.test.ts` (new).
**Approach:** Per KTD1/KTD2. **(a)** Extract `landOneRepo(store, repoRootDir, branch, integrationBranch, options)` from the inline closure — `runAiMerge` becomes its single-repo caller, byte-for-byte. **(b)** `landWorkspaceTask` loops the acquired sub-repos: re-resolve each repo's integration branch (override-stripped), root the prune at the sub-repo, call `landOneRepo`, aggregate repo-tagged results. **(c)** Route the engine dispatch + both CLI doors to `landWorkspaceTask` for `workspaceWorktrees`-bearing tasks; `store.mergeTask`/`aiMergeTask`/the `runAiMerge` chokepoint keep throwing (defense-in-depth).
**Execution note:** Real two-repo fixture; commit on each `fusion/<id>`; assert each repo's **local** integration ref advanced and **no remote ref/push** occurred; assert per-sub-repo prune rooting.
**Test scenarios:**
- Two acquired repos, both clean → both local integration refs advance against each repo's own resolved branch; no push/remote ref; result tags both. (happy)
- Repos with different integration branches → each lands on its own (override-stripping works; not a shared branch). (per-repo resolution)
- A conflict in repo B → repo A lands (its `landedSha` recorded); B's result reports the conflict; the task is NOT moved done. (partial — D2/D5)
- The single-repo (non-workspace) `runAiMerge` path → byte-for-byte unchanged (it calls the extracted `landOneRepo`). (regression)
- `store.mergeTask`/`aiMergeTask` with a workspace task → still throws `WorkspaceTaskMergeError`. (defense-in-depth)
- A workspace task via the CLI/dashboard merge door → routes to `landWorkspaceTask` (does not throw). (user-facing door)
**Verification:** Workspace merges land per repo on local refs (no push) via `landOneRepo`; single-repo unchanged; user doors route; non-routed doors stay guarded.

### U2. Per-repo landed predicate + idempotent retry (master U5)
**Goal:** Track landed repos; retry skips them.
**Requirements:** KTD3.
**Dependencies:** U1.
**Files:** `packages/core/src/types.ts` (`workspaceWorktrees[repo].landedSha?`), the loop in U1, `packages/engine/src/__tests__/workspace-merger-idempotency.test.ts` (new).
**Approach:** Per KTD3. `landOneRepo` records `workspaceWorktrees[repo].landedSha` only (no task move); `landWorkspaceTask` calls `finalizeTask`/move-done exactly once after every acquired repo's landed predicate holds. Landed predicate = ancestor check (or `landedSha` present); skip landed repos. Partial-land → non-done state with `landedSha` persisted; the failure **consumes a `mergeRetry`** and is **auto-retried up to `MAX`, then operator-parked** (user decision).
**Test scenarios:**
- Re-running `landWorkspaceTask` after repo A landed + repo B failed → A is skipped (not re-landed), B is retried; A's ref does not move twice. (idempotency — partial land)
- Landed predicate true when branch tip is an ancestor of the integration tip. (predicate)
- `finalizeTask` runs exactly once, only after ALL repos landed (not per-repo). (completion — no premature done)
- Partial-land failure consumes one `mergeRetry`; after `MAX` retries the task is operator-parked, not silently failed. (retry/park)
**Verification:** Partial lands are idempotent on retry; the task moves done exactly once; auto-retry then park works; no double-land.

### U3. Per-repo file-scope lease during land (master U7)
**Goal:** Serialize concurrent same-sub-repo lands.
**Requirements:** KTD4.
**Dependencies:** U1.
**Files:** the lease seam (FORK-C), the loop in U1, `packages/engine/src/__tests__/workspace-merger-lease.test.ts` (new).
**Approach:** Per KTD4. Acquire a per-repo integration-ref lease before each `landOneRepo`, release in `finally`.
**Test scenarios:**
- Two workspace tasks landing the same sub-repo concurrently → serialized (one waits/fails-fast, no interleaved `update-ref`). (concurrency)
- Disjoint sub-repos → land in parallel without contention. (no false serialization)
- Lease released on land failure (no stuck lock). (cleanup)
**Verification:** Same-sub-repo lands serialize; the lease never leaks.

---

## Scope Boundaries

**In scope:** the extraction (U0), the per-repo merge loop + R7-throw replacement (U1), landed predicate + idempotent retry (U2), per-repo lease (U3).

### Deferred to Follow-Up Work (Phase D / master U8·U9)
- Self-healing reconcilers for partial-landed / stuck workspace merges.
- The e2e workspace harness.
- Per-repo worktree teardown (carried residual).
- Remote push of integration refs (explicitly out — D2/D5 are local-ref only).
- Store-level atomic per-repo `workspaceWorktrees` merge (carried residual).

---

## Risks & Dependencies

- **R1 — R7 throw replacement must not weaken the single-repo guard.** Mitigation: KTD2 dispatches only when `workspaceWorktrees` non-empty; untaught doors keep the throw; regression + defense-in-depth tests.
- **R2 — Partial-land leaves inconsistent local state.** Accepted (D2/D5: local + operator-resettable). Mitigation: KTD3 idempotent retry + persisted `landedSha`; the local-ref-only design means no remote pollution.
- **R3 — Clean-room helper reuse across the loop.** `runAiMerge`'s temp-worktree/CAS seams must be callable per repo without cross-repo state bleed. Mitigation: feasibility pre-check verifies the seams; U1 asserts no cross-repo bleed.
- **R4 — Lease vs acquisition-exclusivity confusion.** The Phase-A/U2 acquisition lock and the Phase-C land lease are different scopes. Mitigation: KTD4 distinct kind; test both.
- **R5 — `executor.ts` extraction regression (U0).** Mitigation: behavior-preserving; existing suites are the oracle; gate-green before U1.
- **Stacking dependency:** off Phase B (#1714); diff includes the stack.

---

## Sources & Research

- Master plan (U5/U6/U7, KTD2/KTD4/KTD7, D2/D5, R7).
- This session: `runAiMerge` advances the LOCAL integration ref via `update-ref` CAS (~merger-ai.ts:817/847), no push; the R7 chokepoint guard `assertNotWorkspaceTaskMerge` (~:979) + the door guards; `store.mergeTask` (third path); `SelfHealingManager.cleanupStaleTempMergeWorktrees` prefix sweep.
- Phase A/B (#1713/#1714): per-repo `baseCommitSha`, `activeWorktrees` Set, `workspace-paths.ts`, `_workspace-fixture.ts`, the workspace helpers U0 extracts.
