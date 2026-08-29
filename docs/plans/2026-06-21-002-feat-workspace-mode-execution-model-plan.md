---
title: "feat: Workspace mode execution model — make multi-repo tasks run end-to-end"
status: active
date: 2026-06-21
deepened: 2026-06-21
decided: 2026-06-21
type: feat
origin: none (solo planning from PR #1710)
pr: https://github.com/Runfusion/Fusion/pull/1710
branch: pr-1710 (feat/workspace-multi-repo)
depth: deep
---

# feat: Workspace mode execution model — make multi-repo tasks run end-to-end

## Summary

PR #1710 lays a clean, additive foundation for **workspace mode**: a Project whose `rootDir` is a non-git parent directory containing multiple git sub-repos. The foundation adds a separate `task.workspaceWorktrees` field, an `fn_acquire_repo_worktree` agent tool, `acquireWorkspaceRepoWorktree()`, workspace config detection, and a validation bypass — without mutating any existing single-worktree invariant.

This plan covers the **deeper execution-model work** the PR deferred: making one task that spans multiple sub-repos run end-to-end through acquisition → capture → review → merge → self-healing. Architecture (user-confirmed): **one task spans repos** — a single task/session holds N per-repo worktrees in `task.workspaceWorktrees`, the merger merges each sub-repo's branch into that repo's own integration branch, and completion is a branch-anchored **conjunction** across all worktrees.

**Decisions settled this session** (see Decisions Made; previously the open forks):
- **Merger unification (U0, lands first):** `aiMergeTask` is soft-deprecated; `runAiMerge` (the FN-5633 clean-room path, already the default) becomes the **sole** merge path. Workspace mode is built on `runAiMerge` only — no dual-path branching.
- **Merge atomicity = land-as-you-go (local integration ref)** + an unconditional operator revert/force-complete escape hatch. Each repo's clean-room **advances that repo's local integration branch ref via `update-ref` CAS** as it passes — `runAiMerge` does **not** push to any remote (verified: `merger-ai.ts:817/847`; the only `git push` is the separate PR-mode path). Remote push is a separate existing mechanism (PR flow / pull-integration-worktree), **out of scope** here — workspace mode matches `runAiMerge`'s local-ref behavior. Consequence: a partial land is a transient **local** integration-state window, operator-resettable with a clean local reset (not a compensate-forward remote revert). Two-phase was rejected (see KTD8).
- **Scope = full N>1 end-to-end** in one plan.

**The dominant engineering theme that survived review:** the single-worktree assumption is `cwd: rootDir`-bound git execution threaded through the most invariant-dense code in the repo — now concentrated, post-unification, in `runAiMerge`'s clean-room model (`merger-ai.ts`), the self-healing reconcilers, and `store.mergeTask`. A missed site silently strands or loses work — a documented incident class (`docs/solutions/integration-issues/branch-group-single-pr-synthetic-id-dead-wiring.md`). The hardest piece is reworking `runAiMerge`'s single-terminal clean-room pipeline into a per-repo loop (U6).

**Scope out:** the brand `kb→fn` rename; a full dashboard workspace-registration UI (a minimal "doesn't look broken" floor is in — U10); `branchContext`/shared-branch-group reuse (a distinct axis from branch groups).

---

## Problem Frame

Today every task carries exactly one `(rootDir, branch, worktree)` triple, the lifecycle runs git in `rootDir`, and merge dispatches between two functions:

- **Executor** acquires one worktree at `executor.ts:~7430` (`acquireTaskWorktree({ rootDir })`), binds the agent session cwd to it, then captures base-commit SHA, modified files, contamination base, identity-guard hooks, review, and `verifyWorktreeInvariants` against that single path. The foundation's workspace guard at `executor.ts:7414-7418` only suppresses the `isGitRepository` *error message* — the acquisition itself is **not yet gated** on `pr-1710`, so the first workspace task crashes there today.
- **Merger** dispatches at `project-engine.ts:2280-2282` (`mergerMode === "ai" ? runAiMerge(...) : aiMergeTask(...)`). `"ai"` is the **FN-5633 default**; the code labels `aiMergeTask` the **"legacy pipeline."** `runAiMerge` (`merger-ai.ts`) does a **clean-room temp worktree** (prefix `fusion-ai-merge-<taskId>-`), AI merge + AI review, then a single terminal `finalizeMerged → finalizeTask → store.moveTask(taskId,'done')` (`merger-ai.ts:1174/1194/1285/1384`). It already has an `{ empty: true }` finalize path (`:1174`) for empty squashes.
- **`store.mergeTask` is a *third merge path*, not just cleanup** (corrected, round 3): `store.mergeTask` (`store.ts:11150`, called from `executor.ts:1742` `finalizeAlreadyInReviewTask` + `self-healing.ts:5830` the no-`enqueueMerge`-queue UI-only fallback) does a full `git checkout <target>` / `git merge --squash` / `git commit` (`store.ts:11256-11266`) **and then** `git worktree remove` / `git branch -d` — all via `runGitCommand` pinned to rootDir, keyed on singular `task.worktree`/`task.branch`. For a workspace task it would `git checkout` against the non-git root and fail. It is **not** unified by U0's dispatch change, so it must be made workspace-aware or gated (U6).
- **Self-healing** reconcilers read scalar `task.worktree`/`task.branch` and run `git for-each-ref`/`git show-ref` against `rootDir`; the in-review rebind *deliberately skips* ambiguous multi-branch candidates and dedups by resolved SHA within one rootDir.
- **Scheduler** file-scope leases key on `taskId` alone; the worktree pool is a recycle cache (`recycleWorktrees`-gated), **not** a cross-task lock.

In workspace mode `rootDir` is a **non-git** parent, so none of this works as-is. This plan (a) unifies merge onto `runAiMerge` (U0), then (b) re-targets the lifecycle from "one worktree, git in rootDir" to "N per-repo worktrees, git in each `repoAbsPath`," preserving every existing single-repo task's behavior.

---

## Key Technical Decisions

### KTD0 — `runAiMerge` is the sole merge path (U0, lands before all workspace work)
Soft-deprecate `aiMergeTask`: collapse the `project-engine.ts:2280-2282` dispatch to always-`runAiMerge`, mark `aiMergeTask` + its now-dead helpers `@deprecated` (body retained, deleted in a later pass), and retire/alias the `settings.merger.mode` setting. Low blast radius — `"ai"` is already the default, so default-config projects are unaffected; only projects explicitly on the (effectively unused) `"deterministic"` mode change behavior. Workspace mode then targets one canonical merge function — no dual-path forks, no "keep the legacy path working" regression burden.

### KTD1 — Session cwd = browse-only workspace root; skip root acquisition (resolved; not yet implemented on pr-1710)
In workspace mode the main `acquireTaskWorktree({ rootDir })` (`executor.ts:~7430`) is **skipped** (cannot run against a non-git dir). Session cwd becomes the workspace root for browsing; **all edits happen inside per-repo worktrees** via `fn_acquire_repo_worktree`. On `pr-1710` the acquisition and the preflights between the workspace guard (`:7414`) and session create (`~:8443`) are **not yet gated** — U1 must gate the acquisition *and* every intervening preflight (identity guard, `resolveContaminationBaseRef` `:7536`, base-commit capture `:7525`, `verifyWorktreeInvariants`). Direction resolved; the gating is real work.

### KTD2 — One task spans repos; merge-boundary coherence is session-time only (accepted)
A single task/session holds N per-repo worktrees. Merge runs **per repo** — each sub-repo's `fusion/<id>` branch lands into *that repo's own* local integration branch ref — and completion is the **conjunction**. Coherence is **session-time only**: repos land independently (land-as-you-go), so a task can briefly have repo A landed on its local integration ref while repo B is still in-flight. **This is accepted** (KTD8/D3 decision): a transient incoherent window in **local** integration state, resettable via the operator escape hatch, is acceptable for this tool. Because the merge advances a local ref (not a remote push — KTD8), the window is local-only: no shared remote is mutated until the separate, out-of-scope push step runs, so other developers don't pull a half-applied change from the merge itself. The rejected alternative (parent + per-repo child tasks) is in Alternatives Considered.

### KTD3 — Per-repo `baseCommitSha`, captured at each acquisition against that repo's resolved integration branch
Per `docs/solutions/logic-errors/files-changed-inflated-by-origin-first-base-commit.md`, base/fork-point must be measured against the **local** integration branch first (`merge-base HEAD <localIntegration> || origin/<integration>`). `resolveCapturedBaseCommitSha` (`base-commit-capture.ts:26-55`) **hardcodes `main`** and takes no branch param — U2 must extend it to accept the per-repo integration branch from `resolveIntegrationBranch(repoAbsPath, settings)`, or any sub-repo whose integration branch is not `main` re-introduces the diff-inflation bug R3 guards against. Stored as `workspaceWorktrees[repo].baseCommitSha`; the singular `task.baseCommitSha` is unused in workspace mode.

### KTD4 — Shared `@fusion/engine` "landed" predicate + `merged`-flag integrity
A branch-anchored conjunction predicate (`isWorkspaceTaskLanded(task)`) in a shared `@fusion/engine` helper (`packages/engine/src/workspace-completion.ts`), imported by route logic, merger, and self-healing — **not** in published `@fusion/core` (no non-engine caller today). Per `docs/solutions/integration-issues/branch-group-single-pr-synthetic-id-dead-wiring.md`, a column-only / any-one-branch check is the data-loss hazard; the predicate verifies *each* repo's merge landed on *that repo's* integration branch and reads stored row data only — never a re-derived string. **`merged`-flag integrity:** the operator `revert-landed-repo`/`force-complete` must clear `merged=false` + `mergeTargetBranch` **in the same atomic op** as the revert (or the flag drifts and the task reports landed forever); U6's crash re-entry skip relies **only** on the persisted per-repo flag (no live "landing evidence" re-derivation — that would contradict the row-only rule). The flag is honest at write time (set on land, cleared on revert), not by re-checking the tip at read time.

### KTD5 — File scope declared with repo-prefixed paths; per-repo filtering strips the prefix; leases skip cross-repo at compare time
Workspace tasks declare `## File Scope` with workspace-relative prefixed paths (`wolf-server/src/**`). The repo prefix is derived from the first path segment matching a configured repo, **after canonicalizing** (strip leading/trailing slashes, resolve `.`); a non-matching first segment routes to an explicit `unscoped` fallback (logged, never silently no-leased). Consequences:
- **Squash overlap (U6):** `assertSquashOverlapsFileScope` reads staged paths via `git diff --cached --name-only` with cwd = the sub-repo, so they are **repo-relative** (`src/foo.ts`). Per-repo filtering must both *select* the repo's scope entries **and strip the repo prefix** (`wolf-server/src/**` → `src/**`) or every per-repo merge throws `FileScopeViolationError` (verified against `merger.ts:4935-5099`).
- **Leases (U7):** keep `activeScopes` as `Map<taskId, scope[]>` (no map-shape refactor); skip comparison at *overlap-check time* when two entries derive to different repo prefixes. Lease lifecycle (set/clear) untouched for existing tasks.

### KTD6 — Per-repo identity-guard hooks, init/setup at acquisition; same-sub-repo exclusivity is the lease's job (not the pool)
`installTaskWorktreeIdentityGuard` and configured init/setup install/run **in each sub-repo worktree** at acquisition. The foundation already passes `runInitCommand: true`; U2 adds identity-guard install + per-repo base-commit capture. **Same-sub-repo concurrency:** the first draft's "per-repo pool lease" misread `WorktreePool` — it's a *recycle cache* gated on `settings.recycleWorktrees` (`acquire(taskId)` returns an arbitrary idle path; `assertNotDoubleLeased` only fires on same-*path* reuse; never consulted with recycling off — `worktree-acquisition.ts:279`), with **no** repo-keyed cross-task exclusivity. So same-sub-repo serialization comes from the **file-scope lease** (overlapping in-repo scopes) and, for the disjoint-scope case, a dedicated **repo-path exclusivity registry** on `activeSessionRegistry` path-keying (which `runAiMerge` already uses) — implemented in **U2 (Phase A)**, at acquisition, so the guard never lags acquisition by a phase.

### KTD7 — Aggregated, repo-tagged `modifiedFiles`, review, and a per-repo `MergeResult` breakdown
`captureModifiedFiles`, contamination, `verifyWorktreeInvariants`, and `reviewStep` iterate `task.workspaceWorktrees` and run inner git with cwd = each sub-repo (not rootDir). Modified-file lists carry repo prefixes. Review runs per-repo and aggregates verdicts. The aggregated `MergeResult` (today single-repo-shaped) must carry a **per-repo results array** so retry counters, audit, and the dashboard attribute failure to the right sub-repo; no consumer reads a scalar `merged` for completion — only `isWorkspaceTaskLanded`.

### KTD8 — Cross-repo merge atomicity = **land-as-you-go (local integration ref) + unconditional escape hatch** (DECIDED)
**The merge advances a LOCAL ref, not a remote push (verified — feasibility + adversarial, round 3).** `runAiMerge`/`landSquash` advance the repo's local integration branch ref via `update-ref` CAS (`merger-ai.ts:817/847`); there is **no `git push` in the merge path** (the only engine `git push` is the separate PR-mode `pr-response-run-ops.ts`). Workspace mode matches this: each sub-repo's clean-room **lands on that repo's local integration ref** as it passes. Remote push is a separate, existing per-repo mechanism (PR flow / pull-integration-worktree), **out of scope** for U6.

Each repo lands independently; the task reaches done only when `isWorkspaceTaskLanded` is true. A forever-unmergeable repo (or a bad half-landed change) is handled by an operator **revert-landed-repo / force-complete** affordance with an audit event, which clears the per-repo `merged` flag atomically (KTD4); because landing is a local ref advance, this is a **clean local reset**, not a compensate-forward remote revert. **The escape hatch is unconditional.** Two-phase (dry-run-all-then-land) was rejected: it adds real cost (holding N clean-rooms through a barrier; `runAiMerge` has no dry-run-without-landing primitive) for a coherence guarantee that the local-ref model already makes cheap to reset. Land-as-you-go is the natural fit for the clean-room model.

> **Merge order:** with local-ref-only landing, order is **low-stakes** — a partial state is local and operator-resettable, and nothing reaches a shared remote from the merge. The loop may iterate `workspaceWorktrees` in arbitrary (key) order for v1. Dependency-aware ordering (callee/API repos before callers) is an *optional* future refinement, relevant only if/when a remote-push step is added; recorded as a non-blocking note, not v1 work.

---

## High-Level Technical Design

### Workspace task lifecycle (one task, two sub-repos; push-as-you-go on the sole `runAiMerge` path)

```mermaid
sequenceDiagram
    participant Ex as TaskExecutor
    participant WS as workspace root (non-git, browse-only)
    participant A as wolf-server worktree
    participant B as wolf-frontend worktree
    participant Mg as runAiMerge (sole path, per-repo clean-room)
    participant Core as @fusion/engine landed predicate

    Ex->>Ex: loadWorkspaceConfig(rootDir) → present
    Ex->>WS: session cwd = workspace root (SKIP root acquire + all rootDir preflights)
    Note over Ex: agent browses, decides it needs repo A
    Ex->>A: fn_acquire_repo_worktree("wolf-server")
    A-->>A: acquireTaskWorktree(repoAbs) + identity guard + baseSha_A(localIntegration) + repo-path exclusivity
    Ex->>B: fn_acquire_repo_worktree("wolf-frontend")
    B-->>B: acquireTaskWorktree(repoAbs) + identity guard + baseSha_B(localIntegration) + repo-path exclusivity
    Note over Ex: agent commits in A and B; fn_task_done
    Ex->>A: captureModifiedFiles(baseSha_A, cwd=A) + review(A)
    Ex->>B: captureModifiedFiles(baseSha_B, cwd=B) + review(B)
    loop each entry in workspaceWorktrees (land-as-you-go, local ref)
        Mg->>A: landOneRepo(wolf-server): clean-room(repoAbs) + file-scope(strip prefix) + squash → advance wolf-server LOCAL integration ref (CAS)
        Note over Mg: persist workspaceWorktrees[A].merged=true (atomic), DON'T finalize task
        Mg->>B: landOneRepo(wolf-frontend): clean-room(repoAbs) + squash → advance wolf-frontend LOCAL integration ref (CAS)
        Note over Mg: persist workspaceWorktrees[B].merged=true (atomic)
    end
    Mg->>Core: isWorkspaceTaskLanded(task)?
    Core-->>Mg: true only if ALL entries merged on their target → finalize task → done
    Note over Mg: stuck repo → operator revert/force-complete (clean LOCAL reset; clears merged atomically)
    Note over Mg: remote push = separate existing per-repo step, OUT OF SCOPE
```

### Single-worktree → multi-repo invariant inventory

The surface-enumeration spine (FN-5893). Every row is a single-worktree / `cwd:rootDir` assumption that must become per-repo; the U-ID column maps each to the unit that fixes it.

| Surface | Location | Today (singular) | Workspace behavior | Unit |
|---|---|---|---|---|
| Merge dispatch | `project-engine.ts:2280-2282` | `mergerMode==="ai" ? runAiMerge : aiMergeTask` | always `runAiMerge` (aiMergeTask `@deprecated`) | U0 |
| Extra `aiMergeTask` callers | `cli/.../dashboard.ts:~1330` (`--no-engine` `onMergeImpl`), `cli/.../task.ts:~854` (`fn task merge`) | call `aiMergeTask` directly, bypassing dispatch | route to `runAiMerge` or workspace-guard | U0 |
| Main acquisition | `executor.ts:~7430` | `acquireTaskWorktree({rootDir})` always | Skip when workspaceConfig | U1 |
| Intervening preflights | `executor.ts:7414→8443` | identity guard, contamination `:7536`, base capture `:7525`, verify | all gated off in workspace mode | U1 |
| Session cwd | `executor.ts:8443-8494` | `cwd: worktreePath` | `cwd: rootDir` (browse-only) | U1 |
| `activeWorktrees` map (+~15 consumers) | `executor.ts:7667`, `:1585`,`:14491`,`:14518`, FN-6736 reclaim `:2055` | `taskId → one path`; `===` liveness | `taskId → set`; membership semantics at each consumer | U1 |
| Identity-guard hooks | `executor.ts:14034` | installed in root worktree | installed per sub-repo at acquire | U2 |
| Init/setup + same-repo exclusivity | `worktree-acquisition.ts:~633` | once at root; no exclusivity | per sub-repo at acquire; repo-path exclusivity registry (KTD6) | U2 |
| Base-commit capture | `base-commit-capture.ts:26` (hardcodes `main`) | one `baseCommitSha` vs `main` | per-repo `baseSha` vs resolved integration branch (KTD3) | U2 |
| Same-sub-repo exclusivity | `activeSessionRegistry` path-keying (NOT `worktree-pool.ts` — recycle cache, not a lock) | none for sub-repos | repo-path exclusivity registry at acquisition (KTD6) | U2 |
| Contamination base | `executor.ts:7536` `assertCleanBranchAtBase(rootDir,…)` | one base, cwd rootDir | per-repo, cwd sub-repo | U3 |
| Modified-files capture | `executor.ts:7853`, `:12198` | one diff | iterate worktrees, repo-tagged, cwd sub-repo | U3 |
| `verifyWorktreeInvariants` (called by `fn_task_done`) | `executor.ts:10830` (one call site), `:12498` | one worktree | per acquired worktree | U3/U4 |
| Review | `executor.ts:11169`, `reviewer.ts` | one worktree diff | per-repo passes, aggregated | U4 |
| Landed predicate | route + merger + self-healing | column / one branch | `@fusion/engine` conjunction (KTD4) | U5 |
| **Merge entry (sole path)** | `merger-ai.ts` `runAiMerge`: clean-room `:172` prefix, `finalizeMerged`/`finalizeTask` `:1194/1285/1384`, `{empty:true}` `:1174` | single-repo clean-room, terminal finalize | per-repo clean-room via `landOneRepo` seam; loop+finalize gated on predicate | U6 |
| Clean-room parent dir | `merger-ai.ts` `finalizeMerged`/`landSquash` take `projectRootDir` | clean-room + local-sync at rootDir | pass `repoAbsPath` per repo; temp-prefix made repo-aware | U6 |
| File-scope squash overlap | `merger.ts:4935-5099` | one staged set vs unified scope | per-repo filtered scope, **prefix stripped** (KTD5) | U6 |
| `store.mergeTask` (3rd merge path + cleanup) | `store.ts:11150` checkout+squash+commit+remove at rootDir `:11256`; called `executor.ts:1742`/`self-healing.ts:5830` | full merge in rootDir, remove one worktree/branch | gate/convert per-repo, cwd sub-repo (or block workspace tasks from both callers) | U6 |
| File-scope leases | `scheduler.ts:1373-1450` | `Map<taskId, scope[]>` | compare-time repo-prefix skip (KTD5) | U7 |
| `reconcileTaskWorktreeMetadata` | `self-healing.ts:3974` | rebind one worktree | reconcile each entry, per-repo cwd | U8 |
| `reclaimStaleActiveBranches` | `self-healing.ts:3291` | one `fusion/<id>` branch | per sub-repo, keyed `(repo, fusion/<id>)` | U8 |
| `reconcileInReviewBranchRebind` | `self-healing.ts:3786` | skips ambiguous; SHA-dedup in one rootDir | per-repo rebind; scope dedup to correct sub-repo | U8 |
| `reclaimSelfOwnedBranchConflicts` | `self-healing.ts:2739` | one worktree usability | per sub-repo | U8 |
| `reclaimPrConflicts` | `self-healing.ts:2515` | one worktree | per sub-repo | U8 |
| `reconcileCompletedTask` | `self-healing.ts:3555` | one worktree on complete | conjunction-aware | U8 |

---

## Output / Field Additions

Additive only — no migration to existing single-repo tasks:

```ts
Task.workspaceWorktrees: Record<repoRelPath, {
  worktreePath: string;
  branch: string;
  baseCommitSha?: string;     // NEW (KTD3) — per-repo, vs resolved integration branch
  merged?: boolean;            // NEW (KTD4) — set on land, cleared atomically on revert
  mergeTargetBranch?: string;  // NEW (KTD4) — the repo's integration branch the squash landed on
}>
```

`@fusion/engine` new export: `isWorkspaceTaskLanded(task): boolean` (and the shared repo-prefix-derivation helper). `MergeResult` gains an optional `perRepo: Array<{ repo, merged, branch, error? }>` breakdown (KTD7).

---

## Implementation Units

> **Standing requirements for every unit:** add `FNXC:Workspace <yyyy-MM-dd-hh:mm>` comments (jsdoc-preferred) at each non-obvious decision point. Add a `.changeset/*.md` (`@runfusion/fusion: minor`). Per-repo work must emit **persisted** audit events on every acquisition/reconcile/merge failure path. Update the AGENTS.md **Run Audit** section with every new `task:*-workspace-*` event (enumerate exact names — the FN-6230 auto-close gate matches on these strings). All git execution that today targets `cwd: rootDir` must be re-targeted to the per-repo `repoAbsPath` — a per-repo loop wrapper is insufficient if inner git calls still target rootDir.

### U0. Merger unification — make `runAiMerge` the sole path, soft-deprecate `aiMergeTask`

**Goal:** Collapse merge onto `runAiMerge` so all downstream workspace work targets one canonical path.

**Requirements:** KTD0.

**Dependencies:** none (lands first, Phase 0).

> **Standalone-decision framing (review):** U0 is a system-wide merge change — it routes **every** task in **every** project through `runAiMerge` (clean-room + AI merge + AI reviewer), not just workspace tasks. It is worth doing on its own merits (single canonical merge path) even if workspace mode were cancelled, and it ships as its own Phase 0 PR with its own review and rollback story. Reviewers should evaluate "all merges become clean-room" as its own decision, not as workspace-mode plumbing.

**Files:**
- `packages/engine/src/project-engine.ts` (`:2275-2282` — drop the `mergerMode` ternary; always `runAiMerge`)
- `packages/cli/src/commands/dashboard.ts` (`~:1330` `onMergeImpl`, the `--no-engine` UI-only merge — currently calls `aiMergeTask` directly, `const`, despite the stale `:1299` comment; route to `runAiMerge` or workspace-guard)
- `packages/cli/src/commands/task.ts` (`~:854` `runTaskMerge`, the `fn task merge` CLI command — calls `aiMergeTask` directly; route to `runAiMerge` or workspace-guard)
- `packages/engine/src/merger.ts` (`aiMergeTask` + now-dead helpers → `@deprecated`; body retained for a later deletion pass)
- `packages/core/src/types.ts` (`:505` `settings.merger.mode` — retire/alias; this is published `@runfusion/fusion` surface, needs a changeset)
- `packages/engine/src/__tests__/` (update/retire `aiMergeTask`-specific tests; assert all entry points route to `runAiMerge`)

**Approach:** Replace the dispatch with an unconditional `runAiMerge` call, **and** route the two direct CLI/dashboard callers (`onMergeImpl`, `runTaskMerge`) the same way — collapsing only the engine dispatch leaves two live production `aiMergeTask` callers. Mark `aiMergeTask` `@deprecated` with a pointer to `runAiMerge`; do **not** delete the body yet (soft delete). For `merger.mode`: keep accepting it, ignore `"deterministic"`, log a one-time deprecation warning.

**Deterministic-mode blast-radius audit (do this, don't assert):** before claiming low blast radius, grep test fixtures, CI configs, and seeded project settings for `merger.mode === "deterministic"` (and `testMode`/mock interactions that may depend on `aiMergeTask`'s non-AI deterministic output) and enumerate which suites assert that behavior. Cite the result. Expectation is "effectively unused" (the user confirmed this for their projects), but the audit must confirm it rather than the plan asserting it.

**R7 merge-boundary guard lands here (moved from U1, review):** because U0 is Phase 0 and collapses the dispatch *before* U1, add the merge-boundary guard in U0 — reject any workspace task (populated `workspaceWorktrees`) from entering any merge path (`runAiMerge`, `store.mergeTask`, the CLI callers) with a clear error naming U6 as required. Otherwise a workspace task reaching `in-review` in the U0→U1 window crashes at `git rev-parse refs/heads/<integration>` against the non-git root. **U6 removes the guard** when the per-repo loop lands.

**Test scenarios:**
- Every entry point (engine dispatch, `onMergeImpl`, `runTaskMerge`), any `mergerMode` value → routes to `runAiMerge`. (behavior unification across all callers)
- A project previously on `"deterministic"` → routed to `runAiMerge` with a deprecation warning, not an error. (migration)
- A workspace task reaching merge before U6 → held with a clear error naming U6 (R7 guard, all entry points). (safety floor in the U0→U1 window)
- Existing `runAiMerge` single-repo behavior unchanged. (regression)

**Verification:** All merge entry points route to `runAiMerge`; `aiMergeTask` is unreachable in production and marked deprecated; the deterministic-mode audit is cited; the R7 guard blocks workspace tasks from every merge path until U6.

---

### U1. Workspace-mode session scoping — skip root acquisition + all rootDir preflights, browse-only root cwd

**Goal:** In workspace mode, skip the main `acquireTaskWorktree` *and every preflight between the workspace guard and session create*, run the session with cwd = workspace root, and tolerate no singular `task.worktree`.

**Requirements:** KTD1, KTD2.

**Dependencies:** U0 (the R7 merge-boundary guard lands in U0; U1 builds on the unified single merge path).

**Files:**
- `packages/engine/src/executor.ts` (acquisition `~:7430`, preflights `:7525`/`:7536`/identity guard, session create `~:8443-8494`, `activeWorktrees` `:7667` + consumers `:1585`/`:14491`/`:14518`/`:2055`, retry session `~:8935`)
- `packages/engine/src/__tests__/executor-workspace.test.ts` (**rewrite** — currently `vi.mock`s the functions under test; build the real two-repo fixture harness here so Phase A and all later units use it)
- `packages/engine/src/__tests__/executor-workspace-session.test.ts` (new)

**Approach:** Gate the `~:7430` acquisition behind `!this.workspaceConfig`, and gate each intervening preflight (identity guard install, `resolveContaminationBaseRef`, `captureBaseCommitSha`, `verifyWorktreeInvariants`) so none runs against the non-git root. Set session cwd = `this.rootDir`; do not set `task.worktree`. Convert `activeWorktrees` to `taskId → Set<path>` and update each enumerated consumer (`findActiveWorktreeOwner`, `hasActiveWorktreeBinding`, `getActiveWorktreeHolders`, FN-6736 phantom-binding reclaim) to membership semantics. Make `scopePromptToWorktree` a no-op in workspace mode. Leave the singular path byte-for-byte unchanged when `workspaceConfig` is absent.

> **R7 guard:** the merge-boundary guard now lands in **U0** (Phase 0, before this unit) so the U0→U1 window is covered; U1 must not reintroduce a path around it.

**Patterns to follow:** the existing `this.workspaceConfig === undefined` lazy-load guard at `executor.ts:7413-7418`.

**Execution note:** Build the real-fixture harness (two temp git repos) here — do not extend the foundation's self-mocking pattern.

**Test scenarios:**
- Workspace config present → main `acquireTaskWorktree` NOT called; no preflight runs git against rootDir; session `cwd === rootDir`. (happy path)
- Non-workspace task → acquisition + all preflights called exactly as before; `cwd === worktreePath`. (regression)
- Each enumerated `activeWorktrees` consumer returns correct results when a task holds two sub-repo paths. (integration)
- Retry session in workspace mode uses `cwd === rootDir`. (edge)
- Workspace task acquiring zero sub-repos reaches `fn_task_done` without throwing on missing `task.worktree`; completion boundary defined (see U5). (edge/empty)
- (R7 merge-boundary guard is tested in U0, where it now lives.)

**Verification:** A workspace task starts a session rooted at the workspace dir with no root worktree and no rootDir git preflight; a single-repo task is unchanged.

---

### U2. Per-repo acquisition hardening — identity guard, init/setup, same-repo exclusivity, base-commit capture

**Goal:** Make `acquireWorkspaceRepoWorktree` install identity-guard hooks, register same-sub-repo exclusivity, and capture a per-repo `baseCommitSha` against the repo's **resolved** integration branch.

**Requirements:** KTD3, KTD6.

**Dependencies:** U1.

**Files:**
- `packages/engine/src/worktree-acquisition.ts` (`acquireWorkspaceRepoWorktree` `~:598-650`)
- `packages/engine/src/base-commit-capture.ts` (**extend `resolveCapturedBaseCommitSha` to accept the integration branch** — it currently hardcodes `main`)
- `packages/engine/src/worktree-hooks.ts` (`installTaskWorktreeIdentityGuard`)
- `activeSessionRegistry` path-keying (repo-path exclusivity registry — KTD6; NOT `worktree-pool.ts`)
- `packages/core/src/types.ts` (extend `workspaceWorktrees` entry with `baseCommitSha`)
- `packages/engine/src/__tests__/worktree-acquisition-workspace.test.ts` (new — real git fixture)

**Approach:** After `acquireTaskWorktree` returns for a sub-repo: (1) install the identity guard; (2) resolve the repo's integration branch via `resolveIntegrationBranch(repoAbsPath, settings)` and capture `baseCommitSha` via the **extended** `resolveCapturedBaseCommitSha(worktreePath, integrationBranch)`; (3) persist `baseCommitSha`; (4) register same-sub-repo exclusivity in the repo-path registry (KTD6) at Phase A, where the contention is created. Idempotent across `(taskId, repo)` and any global branch-name/worktree-path uniqueness.

> **Integration-branch caveat:** `resolveIntegrationBranch(rootDir, settings)` resolves `settings.integrationBranch` first, then the dir's `origin/HEAD`. Per-repo resolution must let each sub-repo fall through to its own `origin/HEAD` rather than inheriting a shared `settings.integrationBranch` override, unless the workspace genuinely shares one integration branch name.

**Execution note:** Real two-repo git fixture; commit-without-pushing to exercise local-ahead-of-origin.

**Test scenarios:**
- Acquiring repo A captures `baseSha_A` = local integration tip even when `origin/<integration>` is behind. (happy path + R3 regression)
- A sub-repo whose integration branch is **not** `main` captures against that branch and does not inherit a shared `settings.integrationBranch`. (KTD3 + caveat)
- Identity-guard hook present; a commit on a non-`fusion/<id>` branch is rejected. (integration)
- Two concurrent workspace tasks acquiring the same sub-repo (even with disjoint in-repo scopes) are serialized by the repo-path exclusivity registry. (concurrency — KTD6)
- Re-acquiring repo A returns the existing entry without re-capture/re-install. (idempotency)
- Acquisition failure persists an audit event and surfaces an error. (error path)

**Verification:** Each sub-repo worktree has identity hooks, a correct per-repo base SHA (local-first, right branch), and same-sub-repo concurrency protection registered at acquisition.

---

### U3. Per-repo modified-files capture, contamination, worktree-invariant verification

**Goal:** Iterate `workspaceWorktrees` for modified-files capture, contamination, and `verifyWorktreeInvariants`, running inner git with cwd = each sub-repo.

**Requirements:** KTD7.

**Dependencies:** U2.

**Files:**
- `packages/engine/src/executor.ts` (`captureModifiedFiles` `~:7853`/`:12198`, contamination `assertCleanBranchAtBase` `:7539` — **rewire cwd to sub-repo**, `verifyWorktreeInvariants` `:10830`/`:12498`)
- `packages/core/src/types.ts` (`modifiedFiles` carries repo-prefixed paths)
- `packages/engine/src/__tests__/executor-workspace-capture.test.ts` (new — real git fixture)

**Approach:** Loop over `workspaceWorktrees`; for each repo run `git diff <baseSha>..HEAD` with cwd = that worktree, collect repo-prefixed files, aggregate into `task.modifiedFiles`. Run contamination + `verifyWorktreeInvariants` per worktree (cwd sub-repo). Skip the singular path in workspace mode.

**Test scenarios:**
- Edits in repo A and B → `modifiedFiles` carries repo-prefixed paths from both. (happy path)
- A worktree HEAD drifted off `fusion/<id>` → verify reports the offending repo. (error path)
- Contamination check runs against the sub-repo, not rootDir. (the cwd correction)
- Repo acquired, no edits → zero files, no error. (empty)
- Single-repo task → identical to today. (regression)

**Verification:** Capture/verify cover all acquired worktrees with repo context and correct cwd.

---

### U4. Per-repo review and `fn_task_done` completion verification

**Goal:** Review per sub-repo and verify completion invariants across all acquired worktrees before `fn_task_done` succeeds.

**Requirements:** KTD7.

**Dependencies:** U3.

**Files:**
- `packages/engine/src/executor.ts` (`reviewStep` `:11169`, `createReviewStepTool` `:8296`, `createTaskDoneTool` `:8279`/`:10830`)
- `packages/engine/src/reviewer.ts` (per-repo worktree/diff context, aggregate verdicts)
- `packages/engine/src/__tests__/reviewer-workspace.test.ts` (new)

**Approach:** In workspace mode `reviewStep` iterates `workspaceWorktrees`, one reviewer pass per repo with that repo's diff and prefix-stripped File Scope subset; aggregate repo-tagged verdicts. `fn_task_done` calls `verifyWorktreeInvariants` for every acquired worktree and blocks on any dirty/misbound repo or uncommitted in-scope change.

**Test scenarios:**
- Two-repo task → two reviewer passes; reviewed only when both pass. (conjunction)
- One repo has an uncommitted in-scope change at `fn_task_done` → blocked, naming the repo. (error path)
- Reviewer finding in repo B is repo-tagged. (integration)
- Single-repo task → one pass, unchanged. (regression)

**Verification:** Reviewed/complete only when every sub-repo passes review and invariant checks.

---

### U5. Shared `@fusion/engine` "landed" conjunction predicate + repo-prefix helper

**Goal:** Define the multi-repo completion predicate and the shared repo-prefix helper once in `@fusion/engine`.

**Requirements:** KTD4, KTD5.

**Dependencies:** U2.

**Files:**
- `packages/engine/src/workspace-completion.ts` (new — `isWorkspaceTaskLanded` + the repo-prefix-derivation helper, so U6 and U7 both import from one home) + export from the engine index
- `packages/core/src/types.ts` (extend entry with `merged`/`mergeTargetBranch`)
- `packages/engine/src/__tests__/workspace-completion.test.ts` (new)

**Approach:** `isWorkspaceTaskLanded(task)` returns true only when **every** entry has `merged === true` and `mergeTargetBranch === <that repo's resolved integration branch>`. Reads stored row data only.

**Empty / no-op resolution (two cases, one rule):** (a) *zero acquisitions* → no-op done, consistent with U1's zero-acquire edge. (b) *acquired-but-unedited entry* (acquire repo A, edit nothing) → the entry exists with `merged=undefined`, so a naive conjunction returns `false` forever, stranding a fresh worktree+branch+registration; the rule: an acquired entry whose merge produces no net change resolves to `merged=true` (no-op) and its worktree/branch/registration is reclaimed.

> **Empty authority = tip-relative, not `baseSha..HEAD` (review).** `runAiMerge` computes "empty" as `!squashSha` — no net change vs the **current local integration tip** (`merger-ai.ts:1054/1126`), and `mergeAndReview` rebuilds the clean-room on the *new* tip if another task advanced it (`:1188`). U3/KTD3's `baseSha..HEAD` per-repo diff can disagree (e.g. HEAD==baseSha but the tip moved). **The tip-relative `!squashSha` result is the authority**; U5's orphan resolution must defer to U6's tip-relative outcome, not to the stale `baseSha..HEAD` diff — so the short-circuit holds even when another task advanced the integration tip (it rebuilds on the new tip and re-lands nothing). U6 owns the actual short-circuit; U5's predicate reads the resulting `merged` flag. (Note: U6 cannot reuse `finalizeMerged({empty:true})` directly — it finalizes the whole task; see U6.)

**Test scenarios:**
- All entries `merged` on the right target → `true`. (happy path)
- One `merged`, one not → `false`. The lost-work case. (critical)
- `merged` but wrong `mergeTargetBranch` → `false`. (anchor correctness)
- Zero `workspaceWorktrees` → no-op-done, consistent with U1. (empty state)
- Acquired-but-unedited entry (empty diff) → resolves `merged=true` (no-op), not stranded `false`. (orphan-prevention — joint with U6)
- Non-workspace task → delegating caller uses the scalar check, unchanged. (regression)

**Verification:** One source of truth for completion; both empty cases resolve consistently across U1/U5/U6 with no orphans.

---

### U6. Workspace-aware `runAiMerge` — per-repo clean-room loop, `landOneRepo` seam, push-as-you-go, escape hatch

**Goal:** Rework the sole merge path (`runAiMerge`) so each sub-repo's clean-room lands on that repo's **local** integration ref independently (no remote push — KTD8), the task finalizes only on the conjunction, with crash-safe re-entry and an operator escape hatch. Also gate the third merge path (`store.mergeTask`) for workspace tasks.

**Requirements:** KTD2, KTD4, KTD5, KTD7, KTD8.

**Dependencies:** U0, U5.

**Files:**
- `packages/engine/src/merger-ai.ts` (`runAiMerge`, clean-room prefix `:172`, `finalizeMerged`/`finalizeTask` `:1194/1285/1384`, `{empty:true}` `:1174`)
- `packages/engine/src/merger.ts` (file-scope check `:4935-5099`)
- `packages/engine/src/project-engine.ts:2281` (dispatch — confirm workspace tasks route correctly post-U0)
- `packages/core/src/store.ts` (`mergeTask` `~:11150` — the 3rd merge path: `checkout`/`squash`/`commit` `:11256` + worktree removal, `runGitCommand` pins `cwd:rootDir` `~:10989`)
- `packages/engine/src/executor.ts:1742` (`finalizeAlreadyInReviewTask` — gate workspace tasks away from `store.mergeTask`)
- `packages/engine/src/self-healing.ts:5830` (no-`enqueueMerge`-queue fallback — same gate)
- `packages/engine/src/workspace-completion.ts` (import the predicate)
- `packages/engine/src/__tests__/merger-workspace.test.ts` (new — real two-repo fixture)

**Approach — the `landOneRepo` seam (the core blocker).** `runAiMerge` is a single terminal pipeline: a successful merge falls into `finalizeMerged` (`:1194/1285`) → `finalizeTask` → `store.moveTask(taskId,'done')` (`:1364/1384`). Extract a `landOneRepo(repoAbsPath, entry)` step (clean-room + mergeAndReview + landSquash + `store.updateTask({workspaceWorktrees})` setting `merged=true`/`mergeTargetBranch` **atomically**) that **lands the local integration ref but does NOT finalize the task**; drive the per-repo loop + final `moveToDone` from a workspace-aware caller gated on `isWorkspaceTaskLanded`. Specifics the seam must handle:
- `finalizeMerged` inseparably removes the **singular `task.worktree`** (`:1345`) and deletes the task branch before `moveTask`. Split it so `landOneRepo` removes the **per-entry `workspaceWorktrees[repo]`** worktree/branch itself — do **not** leave per-repo worktree cleanup to `store.mergeTask` (a naive extraction would leave every sub-repo worktree un-removed, since `runAiMerge` removes worktrees inside `finalizeMerged`, not via `store.mergeTask`).
- `finalizeMerged`/`landSquash` take `projectRootDir` as clean-room parent + local-sync checkout — pass `repoAbsPath` per repo.
- The clean-room temp prefix `fusion-ai-merge-<taskId>-` (`:172`) is task-keyed — make naming + `pruneExistingAiMergeWorktrees` **repo-scoped** or the N clean-rooms collide.
- `runAiMerge`'s no-branch lost-work guard (reads singular `task.baseCommitSha`/`task.mergeDetails`, unused in workspace mode) re-targets to `workspaceWorktrees[repo]`.

**`store.mergeTask` (the 3rd merge path):** in workspace mode, gate the two callers (`executor.ts:1742` `finalizeAlreadyInReviewTask`, `self-healing.ts:5830` no-queue fallback) so a workspace task does not reach `store.mergeTask`'s `git checkout`/`merge --squash` at the non-git root; route workspace finalization through the `landOneRepo` loop instead. If `store.mergeTask` must run for per-repo worktree cleanup, iterate `workspaceWorktrees` with cwd = each sub-repo.

**Sequencing (KTD8 — land-as-you-go, LOCAL ref):** each repo's `landOneRepo` advances that repo's **local integration ref via CAS** (no remote push — KTD8); persist `merged` atomically before the next; re-entry skips entries already `merged===true` (the persisted flag is the signal — no live re-derivation, KTD4). Loop order is arbitrary/key-order for v1 (local-ref window is operator-resettable — KTD8). Per-repo file-scope check uses the **prefix-stripped** filtered scope (KTD5). **Empty per-repo case:** a repo whose merge yields `!squashSha` (no net change vs the rebuilt tip — the authority, see U5) sets `merged=true` and reclaims its worktree **via the same land/finalize split — NOT by calling `finalizeMerged({empty:true})` directly**, which would `moveTask('done')` the whole task. Aggregate a `MergeResult.perRepo` breakdown. **Operator escape hatch (unconditional):** `revert-landed-repo`/`force-complete` does a clean **local** reset and clears `merged`/`mergeTargetBranch` atomically (KTD4) with an audit event. **Remove the R7 guard** (now in U0) here once the loop is the gate; add a test confirming a workspace task reaches the merger after U6.

**Execution note:** Start with a failing two-repo merge contract test (both land on their own mains; task done only after both; crash between repos resumes correctly). Characterize existing `runAiMerge` single-repo behavior first.

**Test scenarios:**
- Two-repo task, both clean → each clean-room advances its own **local integration ref** (no remote push); done via `isWorkspaceTaskLanded`; `perRepo` has both. (happy path)
- Repo A lands (local ref), repo B conflicts → A `merged`, B not, task NOT done, `perRepo` names B; operator escape path exercised. (the data-safety case)
- Crash after repo A persists `merged`, before repo B → re-entry skips A (persisted flag), resumes B, never re-lands A. (crash re-entry)
- Operator revert-landed-repo on A → clean **local** reset; `merged`/`mergeTargetBranch` cleared atomically; `isWorkspaceTaskLanded` false; self-healing doesn't treat complete. (escape hatch / no drift)
- Repo A acquired, no edits → `!squashSha` (tip-relative) short-circuits to `merged=true` via the land/finalize split (NOT `finalizeMerged({empty:true})`, which would finalize the whole task), worktree reclaimed, not stranded. (orphan-prevention — joint with U5)
- Repo A acquired, no edits, **another task advanced A's integration tip** between acquire and merge → clean-room rebuilds on the new tip, still `!squashSha`/`merged=true`, does not re-land the other task's work. (tip-relative empty authority)
- `landOneRepo` for repo A removes the **per-entry** `workspaceWorktrees[A]` worktree (not the singular `task.worktree`) and does not finalize the task. (finalize/cleanup split)
- Workspace task routed to `store.mergeTask` (via `finalizeAlreadyInReviewTask` / self-healing no-queue fallback) is gated — does not `git checkout` the non-git root. (3rd-merge-path gating)
- File-scope violation in repo B (path outside `wolf-frontend/**`) → `FileScopeViolationError` for B only, state reset. (invariant)
- A path under `wolf-server/**` is NOT out-of-scope when merging `wolf-frontend` (per-repo filter + prefix strip). (false-positive fix)
- N sub-repos' clean-rooms do not collide (repo-scoped temp prefix). (collision fix)
- Workspace task reaches the merger after U6 (R7 guard removed). (dead-wiring prevention)
- Single-repo task → `runAiMerge` unchanged. (regression)

**Verification:** `runAiMerge` lands each repo independently on its local integration ref via per-repo clean-rooms (no remote push), persists atomically, resumes after a crash, supports a clean local operator revert, gates `store.mergeTask` for workspace tasks, and finalizes only when all repos land; single-repo merges unaffected.

---

### U7. Per-repo file-scope leases (compare-time)

**Goal:** Skip cross-repo lease comparison at overlap-check time, without restructuring the lease map. (Same-sub-repo exclusivity for the disjoint-scope case is handled in U2 via the repo-path registry — KTD6.)

**Requirements:** KTD5.

**Dependencies:** U5 (imports the shared repo-prefix helper).

**Files:**
- `packages/engine/src/scheduler.ts` (overlap checks `~:1546`/`:1612` — derive repo prefix and skip cross-repo; leave `activeScopes` shape unchanged `:1373-1450`)
- `packages/core/src/store.ts` (`parseFileScopeFromPrompt` — add a repo-prefix-aware accessor; keep the flat list working for non-workspace via `unscoped`)
- `packages/engine/src/__tests__/scheduler-workspace-leases.test.ts` (new)

**Approach:** At overlap-check time, canonicalize each scope entry, derive its repo prefix via the U5 helper, and skip comparison when two entries belong to different repos. Non-workspace tasks use the `unscoped` sentinel and behave exactly as today.

**Test scenarios:**
- Active task holds `wolf-frontend/**`; queued wants `wolf-server/**` → NOT blocked. (over-blocking fix)
- Active holds `wolf-server/src/**`; queued wants `wolf-server/src/**` → blocked. (true overlap preserved)
- A File Scope path whose first segment matches no configured repo → routes to `unscoped`, logged, not silently no-leased. (fallback)
- Non-workspace tasks → lease behavior identical to today. (regression)

**Verification:** No false cross-repo blocking; same-repo overlap protection intact. (Disjoint-scope same-sub-repo serialization is verified in U2.)

---

### U8. Workspace-aware self-healing reconcilers

**Goal:** Make the worktree/branch reconcilers iterate `workspaceWorktrees`, run per-repo git (not rootDir), key candidates by `(repo, fusion/<id>)`, and stop mis-reclaiming multi-repo tasks.

**Requirements:** KTD2, KTD4.

**Dependencies:** U5, U6.

**Files:**
- `packages/engine/src/self-healing.ts` — `reconcileTaskWorktreeMetadata` `:3974`, `reclaimStaleActiveBranches` `:3291`, `reconcileInReviewBranchRebind` `:3786` (runs `for-each-ref`/`show-ref` against `rootDir`), `reclaimSelfOwnedBranchConflicts` `:2739`, `reclaimPrConflicts` `:2515`, `reconcileCompletedTask` `:3555`
- `packages/engine/src/__tests__/self-healing-workspace.test.ts` (new)
- `AGENTS.md` (Run Audit section — **enumerate the exact new `task:*-workspace-*` event names**; the FN-6230 auto-close gate matches on these strings)

**Approach:** Branch each reconciler on `task.workspaceWorktrees`: verify/rebind/reclaim **each** entry, running git with cwd = the sub-repo and scoping candidate-matching + SHA-dedup to the correct sub-repo (so two repos that both have a `fusion/<id>` branch and divergent `main` are never matched across repos). Use `isWorkspaceTaskLanded` for completion. The in-review rebind no longer treats a multi-repo task as ambiguous. Preserve the `autoMerge:false` / live-session backward-move guards per repo. Emit a persisted audit event per workspace reconcile/reclaim.

**Execution note:** Characterize existing single-worktree reconciler behavior first; keep the scalar path for non-workspace tasks.

**Test scenarios:**
- `reconcileTaskWorktreeMetadata` on a two-repo task with one stale entry → rebinds only the stale repo. (per-repo)
- Two sub-repos each with a `fusion/<id>` branch + divergent `main` → candidate-matching never crosses repos. (the collision case)
- `reconcileInReviewBranchRebind` no longer skips a workspace task as ambiguous. (deliberate-skip fix)
- All-landed workspace task treated complete by `reconcileCompletedTask` (conjunction). (completion)
- One-repo-unlanded workspace task under `autoMerge:false`/live session → not moved backward. (guard preserved)
- Each reconcile/reclaim emits its persisted audit event. (observability)
- Non-workspace tasks → every reconciler unchanged. (regression)

**Verification:** Reconcilers maintain multi-repo tasks per repo, never cross-match branches, and leave single-repo reconciliation unchanged.

---

### U9. End-to-end workspace harness (narrow)

**Goal:** One narrow end-to-end smoke test of a workspace task, on the real-fixture harness U1 introduced.

**Requirements:** all (verification backbone).

**Dependencies:** U1–U8.

**Files:**
- `packages/engine/src/__tests__/workspace-e2e.test.ts` (new — real two-repo fixture, mock AI provider)

**Approach:** Register a workspace, run a scripted-mock task that acquires both repos, edits + commits in each, calls `fn_task_done`, and asserts both branches merge to their own mains and the task lands via `isWorkspaceTaskLanded`. **FN-5048 discipline:** decompose most coverage into per-seam tests (U2/U3/U4/U6 each own theirs); this e2e is a *narrow smoke* — fixture → acquire×2 → merge → landed — with **fake timers, no real polling loops**, gated like `smoke:boot`.

**Test scenarios:**
- Full e2e: two-repo workspace task runs, edits both, merges both, lands — no real polling. (happy path smoke)
- One-sub-repo workspace task completes (common case). (edge)

**Verification:** A workspace task runs end-to-end without real polling; per-seam invariants are covered by their own units.

---

### U10. Dashboard "doesn't look broken" floor for workspace tasks

**Goal:** Ensure the existing task views render workspace tasks (no `task.worktree`, populated `workspaceWorktrees`) without breakage. **Not** a full registration UI (deferred).

**Requirements:** KTD2.

**Dependencies:** U1.

**Files:**
- Each component that reads `task.worktree`/`task.branch` for display (grep under `packages/dashboard/app/` and name them during implementation — task detail view and any task-row/summary).
- `packages/dashboard/app/__tests__/` (new test asserting graceful render)
- `CONCEPTS.md` or `docs/dashboard-guide.md` (one-line non-atomic-merge-semantics note)

**Approach:** Add a nil-guard so each affected component renders a static placeholder (e.g. "N repos acquired") or hides the worktree/branch field when `task.worktree` is absent and `workspaceWorktrees` is populated. **Scope ceiling:** "doesn't look broken" only — a placeholder or flat per-repo path list, NOT a new rich per-repo-status component (that is the deferred registration UI).

**Non-atomic-semantics note (review):** add a one-line note to `CONCEPTS.md` (or `docs/dashboard-guide.md`) stating that workspace-task merges are **non-atomic**: each sub-repo lands on its own local integration ref independently, a partial-land window is possible mid-task, and it is local + operator-resettable (nothing reaches a shared remote from the merge). Sets the expectation at the point of use without expanding U10 into the deferred registration UI.

**Test scenarios:**
- Task with `task.worktree` undefined + two `workspaceWorktrees` entries → renders a per-repo list, no crash. (happy path)
- Single-repo task → unchanged. (regression)

**Verification:** Workspace tasks are observable (not broken) in the dashboard at every execution stage.

---

## Scope Boundaries

**In scope:** merger unification onto `runAiMerge` (U0); the full execution lifecycle for one-task-spanning-repos — session scoping, per-repo acquisition hardening, capture/review, the per-repo clean-room merge loop, the shared landed predicate, per-repo leases + same-repo exclusivity, self-healing reconcilers, a narrow e2e, and a dashboard breakage floor.

### Deferred to Follow-Up Work
- Hard deletion of `aiMergeTask` (U0 is a soft deprecation; remove the body in a later pass once no references remain).
- Full dashboard UI for registering/visualizing workspace projects and rich per-repo task status (U10 is only the breakage floor).
- `fn init` ergonomics beyond auto-detect (interactive repo selection, exclusions).
- Concurrency limits / fairness across many sub-repos in one task.
- A `/ce-compound` "single-worktree invariant inventory → multi-repo equivalents" learnings doc once this lands (the invariant table is its seed).

### Outside this product's identity
- Reusing the **branch-group** shared-branch machinery — workspace mode (N repos × 1 branch each) is a distinct axis from branch groups (N tasks × 1 shared branch); conflating them reintroduces the documented branch-group hazards.
- The `kb→fn` brand rename (tracked separately).

---

## Decisions Made

All four design questions from the planning session are resolved:

- **D1 (merger unification, → U0).** `runAiMerge` becomes the sole merge path; `aiMergeTask` is soft-deprecated. Workspace mode targets one canonical path. *Rationale:* `aiMergeTask` is already the "legacy pipeline" and `"ai"` is the default, so the change is cheap and removes dual-path forks.
- **D2 (atomicity, → KTD8/U6).** Land-as-you-go on each repo's **local integration ref** (no remote push — `runAiMerge` doesn't push), with an **unconditional** operator revert/force-complete escape hatch (a clean local reset). *Rationale:* the merge advances a local ref, so a partial state is local and cheap to reset; two-phase would cost N held clean-rooms for a guarantee the local-ref model already makes cheap. **Workspace mode is local-ref-only** — remote push stays the separate existing per-repo mechanism, out of scope (D5).
- **D3 (coherence expectation, → KTD2).** Session-time coherence is accepted; a transient half-applied **local** integration state is operator-resolved. *Rationale:* because nothing is pushed to a shared remote by the merge, the window is local-only and the operator escape hatch fully restores it.
- **D5 (merge mechanism, → KTD8, round 3).** Workspace mode matches `runAiMerge`'s **local integration ref advance**; it does **not** add per-repo remote push. *Rationale:* parity with the existing canonical merge path; remote push is handled by the separate PR/pull mechanisms per repo.
- **D4 (scope, → whole plan).** Full N>1 end-to-end in one plan (thin-N=1-slice alternative considered and declined).

Residual sub-design items are now specified work, not open questions: the per-repo clean-room rework + `landOneRepo` seam (U6), the repo-scoped temp-worktree naming (U6), and the AGENTS.md Run-Audit event enumeration (U8).

---

## Risks & Dependencies

- **R1 — Missed `cwd:rootDir` / per-repo site strands work (critical).** Post-unification the merge surface is one path (`runAiMerge`), but the `cwd:rootDir` sites in `store.mergeTask`, self-healing, and the clean-room parent dir remain. Mitigation: the invariant inventory is the enumeration checklist; `isWorkspaceTaskLanded` (U5) is the single completion chokepoint; every reconciler keeps an explicit non-workspace path; grep every scalar `task.worktree`/`task.branch`/`task.baseCommitSha` read **and every `cwd: rootDir`** before declaring done.
- **R2 — Partial merge = silent data loss.** Mitigation: U5/U6 make "done" strictly conjunctive; U6 persists `merged` atomically per repo and supports crash re-entry; the operator escape hatch + atomic flag-clear (KTD4/KTD8) handle the stranded case. Partial-failure + crash-re-entry tests are mandatory.
- **R3 — Base-commit inflation per repo.** Mitigation: KTD3 + U2 capture local-first against the **resolved** integration branch (the existing helper hardcodes `main` — must be extended); regression test commits without pushing and uses a non-`main` integration branch.
- **R4 — Merger unification touches all tasks (U0).** Routing every task through `runAiMerge` is a behavior change for any project still on `"deterministic"`. Mitigation: low blast radius (`"ai"` is already the default); soft deprecation keeps `aiMergeTask` callable; U0 tests the `"deterministic"`→`runAiMerge` migration path with a warning, not an error.
- **R5 — Stranded half-merge.** Mitigation: the operator revert/force-complete escape hatch is in U6 **unconditionally**; because landing is a local integration-ref advance (D5), revert is a **clean local reset** (not a compensate-forward remote revert) and clears the `merged` flag atomically (KTD4); test the forever-unmergeable-B scenario.
- **R6 — Refactor-vs-main churn / stale line anchors.** This rewrites `runAiMerge`/executor/self-healing while main keeps changing them; cited line numbers will drift. Mitigation: phase the work, keep the non-workspace path untouched, prefer symbol/function anchors over line numbers, follow `docs/solutions/best-practices/merge-conflict-extraction-vs-semantics-and-parallel-bootstrap.md`.
- **R7 — Pre-U6 workspace task strands.** Mitigation: **U0** (Phase 0, before U1 — moved earlier in review to cover the U0→U1 window) adds a merge-boundary guard across all merge entry points (`runAiMerge`, `store.mergeTask`, the CLI callers) holding workspace tasks until U6; **U6 removes it** (with a test) when the per-repo loop becomes the gate.
- **R8 — Same-sub-repo concurrency window.** Two concurrent workspace tasks can acquire the same sub-repo with disjoint in-repo scopes (file-scope leases don't catch them; the pool is a recycle cache, not a lock). Mitigation: the repo-path exclusivity registry is implemented in U2 (Phase A), at acquisition.
- **R9 — Auto-merge confirmation gate on partially-landed workspace tasks.** The fast-path auto-merge gate (`project-engine.ts:1934-1992`) and `getTaskHardMergeBlocker` read singular `mergeDetails`/`mergeConfirmed`; their behavior for a workspace task with some entries `merged` and some not is untraced. Mitigation: U6/U8 must route these gates through `isWorkspaceTaskLanded` (the conjunction chokepoint), not the scalar fields; trace before Phase C.
- **Dependency:** wire any new engine capability at all engine-construction sites (`daemon.ts`/`serve.ts`/`dashboard.ts`) per the branch-group dead-wiring learning.

---

## Phased Delivery

Single plan, five phases (each a reviewable PR-sized slice; the non-workspace path stays green throughout). The real-fixture test harness is built in Phase A (U1). All four design questions are decided, so nothing blocks Phase A.

- **Phase 0 — Merger unification:** U0 (`runAiMerge` becomes the sole path). Lands first so all workspace work targets one merge function.
- **Phase A — Run + safety floor:** U1 (incl. harness rewrite + R7 merge guard), U2, U10.
- **Phase B — Capture & review:** U3, U4.
- **Phase C — Merge (per-repo clean-room):** U5, U6, U7. The hardest phase — the `runAiMerge` `landOneRepo` rework.
- **Phase D — Heal & e2e:** U8, U9.

> Note: Phases A–B deliver no standalone *user-shippable* value — a workspace task that runs but cannot merge is not usable — so realized value is concentrated in Phase C/D. The R7 merge guard (now in **Phase 0 / U0**) keeps the interim safe (held, not stranded) from the moment the dispatch is unified. Per the D4 decision, the thin-N=1-slice alternative (which would front-load value) was declined in favor of the full build. Also: U1 (Phase A) gates root preflights off, but per-repo contamination/`verifyWorktreeInvariants` returns in U3 (Phase B) — do not run a workspace task for real until Phase B lands (or pull per-repo contamination forward into U2).

---

## Alternatives Considered

- **Parent task + per-repo child tasks (rejected, user-confirmed).** One coordinator fans out a child per sub-repo, each on the untouched single-worktree path. Lower blast radius and fewer dual-path forks, but loses single-agent cross-repo coherence and adds cross-task dependency orchestration, and reworks the PR's existing foundation. Rejected because cross-repo coherence during execution is the motivating use case.
- **Two-phase / dry-run-all-then-land merge (rejected, → KTD8).** Would narrow the incoherent window, but costs N held clean-rooms + a new validated-but-unlanded lifecycle state, since `runAiMerge` has no dry-run-without-landing primitive — and the local-ref-only model (D5) already makes a partial state cheap to reset, so the extra cost buys little. Land-as-you-go + escape hatch chosen instead.
- **Per-repo remote push during merge (rejected, → D5).** Would publish each repo to its shared remote as it lands, making the partial-land window visible to other developers and the escape hatch a compensate-forward revert (can't unwind what others pulled). Rejected: `runAiMerge` is local-ref-only today; workspace mode keeps parity and leaves remote push to the existing separate per-repo mechanisms.
- **Thin N=1 vertical slice first (considered, declined → D4).** Would front-load usable value and isolate the hard clean-room-per-repo redesign to a later increment, but the user chose full N>1 end-to-end.
- **Reuse branch-group shared-branch machinery (rejected).** Branch groups model N tasks sharing 1 branch; workspace mode is 1 task across N repos each with its own branch. Data shapes don't align; the branch-group hazards are documented and severe.

---

## Sources & Research

- PR #1710 (`feat/workspace-multi-repo`) foundation diff; codebase verification on `pr-1710` (incl. `project-engine.ts:2280-2282` dispatch, `merger-ai.ts` `runAiMerge`/`finalizeMerged`/`{empty:true}`, `store.mergeTask` call sites).
- `docs/solutions/logic-errors/files-changed-inflated-by-origin-first-base-commit.md` → KTD3.
- `docs/solutions/integration-issues/branch-group-single-pr-synthetic-id-dead-wiring.md` → KTD4 (conjunction predicate; dead-wiring at all engine sites).
- `docs/solutions/logic-errors/per-task-auto-merge-override-ignored-by-trigger-gates.md` → R1 (merge-gate fan-out).
- `docs/solutions/logic-errors/branch-group-name-collision-strands-mission-triage.md` → KTD5/U2/U8 (idempotency across uniqueness dimensions; persisted audit on failure).
- `docs/architecture.md` reconciler inventory (FN-4962, FN-5083/FN-6695, FN-4954, FN-4948, FN-5279) → U8.
- `CONCEPTS.md` workspace definition; `AGENTS.md` File-Scope invariant, Surface Enumeration (FN-5893), slow-test (FN-5048), Run Audit (FN-6230 auto-close gate).
- Codebase maps + three ce-doc-review rounds (this session): surfaced the default-merge-path concern (resolved by U0), the `cwd:rootDir` surface, the `runAiMerge` terminal-finalize seam, the pool-isn't-a-lock correction, the `merged`-flag drift, the per-repo base-commit / file-scope-prefix corrections, and — round 3 — the **local-ref-not-push** correction (KTD8/D5), `store.mergeTask` being a **third merge path**, U0's two extra `aiMergeTask` callers, the empty-diff tip-relative authority, and the U0→U1 guard window.
- Planning-session decisions (D1–D5): merger unification onto `runAiMerge` (D1), land-as-you-go local-ref atomicity (D2), session-time local-state coherence (D3), full N>1 scope (D4), local-ref-only mechanism / no per-repo remote push (D5).
