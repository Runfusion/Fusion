---
title: "feat: Workspace mode Phase A — session scoping, per-repo acquisition, dashboard floor"
status: active
date: 2026-06-21
type: feat
origin: docs/plans/2026-06-21-002-feat-workspace-mode-execution-model-plan.md (master plan, Phase A / U1·U2·U10)
depth: deep
---

# feat: Workspace mode Phase A — session scoping, per-repo acquisition, dashboard floor

> **ID namespace:** the `U1·U2·U3` below are **local to this Phase-A plan**. They decompose master-plan **U1, U2, U10** (a separate namespace). "Master-plan U6/U8" references point at the master plan, not these IDs.

## Summary

Phase A of the workspace-mode master plan: make a workspace task **run** (acquire → browse → edit per sub-repo), short of capture/review/merge (Phases B–D). Three units: (U1) executor session scoping so the session roots at the non-git workspace root and edits happen only in per-repo worktrees; (U2) per-repo acquisition hardening (identity guard, per-repo base SHA against the resolved integration branch, same-sub-repo exclusivity); (U3 = master U10) a dashboard "doesn't look broken" floor.

Builds on the **foundation** (PR #1710 — `task.workspaceWorktrees`, `fn_acquire_repo_worktree`, `acquireWorkspaceRepoWorktree`) + **U0** (PR #1711 — `runAiMerge` sole merge path, R7 guard). Settled design: **D2/D3/D5 — land-as-you-go on each repo's LOCAL integration ref** (no remote push), session-time coherence accepted. The R7 merge-boundary guard already exists at the merge chokepoint (U0); U1 must not route around it.

**Scope out:** capture/contamination/review (master U3/U4 = Phase B), the per-repo merge loop (master U6 = Phase C), self-healing reconcilers (master U8 = Phase D).

**Stacking:** this branch is off the U0 branch, so the PR diff includes foundation + U0 + Phase A and **must not merge until #1710/#1711 land**.

---

## Problem Frame

In workspace mode `rootDir` is a **non-git** parent. On the current base the executor still, for every task: acquires one root worktree at `executor.ts:~7430` (`acquireTaskWorktree({rootDir})`), runs preflights (`resolveContaminationBaseRef`, `captureBaseCommitSha`, identity-guard install, `verifyWorktreeInvariants`) against that path, binds the agent session cwd to it, and tracks `activeWorktrees: Map<taskId, onePath>`. Against a non-git root, the root acquisition and every git preflight fail. The foundation gave the agent `fn_acquire_repo_worktree` (per-repo worktrees on demand) but nothing in the executor lifecycle skips the root path or hardens per-repo acquisition. Phase A closes that gap for the **run** stage.

---

## Key Technical Decisions

### KTD1 — Skip root acquisition + all rootDir preflights; session cwd = workspace root (master KTD1)
When `this.workspaceConfig` is present: skip `acquireTaskWorktree({rootDir})` and gate each intervening preflight so none runs git against the non-git root; set session cwd = `this.rootDir` (browse-only); do not set `task.worktree`; `scopePromptToWorktree` is a no-op. The non-workspace path stays byte-for-byte unchanged (branch on `workspaceConfig`).

### KTD2 — `activeWorktrees` becomes `taskId → Set<path>` (master KTD1) — VERIFIED consumer list
A workspace task holds N sub-repo worktrees; liveness/owner checks must see all of them. Convert the map and update **every** consumer to membership semantics. The complete, code-verified consumer set (feasibility-checked — the earlier draft mislabeled these):
- **Membership / owner checks:** `findActiveWorktreeOwner` (`:14491`), `hasActiveWorktreeBinding` (`:14518`), the FN-6736 phantom-binding reclaim (`~:2055`).
- **`listWorktreeHolders` (`:14480`)** — emits one `{taskId, worktreePath}` per entry; consumed by the **FN-6782 leaked-slot reaper** (`self-healing.ts:~8310`) and `in-process-runtime.ts:~791`. A workspace task must **flat-map its Set into N holder rows**, or `maxWorktrees`-slot accounting under-counts and leaks/mis-reaps. Verify the reaper math against multi-row holders.
- **Single-path getters — define the Set-collapse contract (KTD-decision):** `getWorktreePath(taskId): string|undefined` (`:15424`), the `verifyWorktreeInvariants` resolution `?? this.activeWorktrees.get(task.id)` (`:10461`), and the conflict-set iteration (`~:14444`, `worktreePath === conflictPath`). **Contract:** for a workspace task these single-path consumers operate per-sub-repo (the caller already has the repo/path in context) — `getWorktreePath` returns `undefined` for a multi-worktree workspace task (callers must use the per-repo `workspaceWorktrees` entry), and `verifyWorktreeInvariants` is iterated per worktree in Phase B (master U3), so its singular resolution is gated off in workspace mode here.
- **Unregister resolvers (`:1586`/`:1603`/`:1618`)** — `deleteActiveSession`/`StepExecutor`/`WorkflowStepSession` each read one path for `activeSessionRegistry.unregisterPath`; with a Set they must unregister **every** path (loop), not one. Plus cleanup at `~:14922`.

Non-workspace tasks hold a one-element set — behavior unchanged. **Grep all `activeWorktrees.` sites before declaring done** (FN-5893); the list above is the verification spine, not a license to skip the grep.

### KTD3 — Per-repo base SHA against the *resolved* integration branch, local-first (master KTD3)
`resolveCapturedBaseCommitSha` (`base-commit-capture.ts:26-55`) **hardcodes `main`** and takes `(worktreePath, logger?)`. Extend it to accept the integration branch as an **optional trailing param defaulting to the current `main` literal**, so the existing single-repo caller (`executor.ts:~12075`) and the 4 `base-commit-capture.real-git.test.ts` cases stay green without change. At each sub-repo acquisition capture `baseCommitSha` measured **local-first** (`merge-base HEAD <localIntegration> || origin/<integration>`), per `docs/solutions/logic-errors/files-changed-inflated-by-origin-first-base-commit.md`.

> **Integration-branch resolution gotcha (feasibility-verified):** `resolveIntegrationBranch(rootDir, settings)` (`integration-branch.ts:74`) checks `resolveFromSettings(settings)` **FIRST** and returns a populated `settings.integrationBranch` before ever consulting the repo's `origin/HEAD`. So `resolveIntegrationBranch(repoAbsPath, settings)` would return the **shared** override for every sub-repo — the exact thing KTD3 forbids. **Call it with the shared override stripped:** `resolveIntegrationBranch(repoAbsPath, { ...settings, integrationBranch: undefined })`, so each sub-repo falls through to its own `origin/HEAD`. Store as `workspaceWorktrees[repo].baseCommitSha`.

### KTD4 — Same-sub-repo exclusivity via `activeSessionRegistry` path-keying, not the pool (master KTD6)
`WorktreePool` is a recycle cache (gated on `recycleWorktrees`), **not** a cross-task lock. Serialize two concurrent workspace tasks contending for the same sub-repo via a repo-path exclusivity registry built on `activeSessionRegistry` path-keying (which `runAiMerge` already uses), registered **at acquisition** (U2). Disjoint-scope contention on the same sub-repo is otherwise unprotected (file-scope leases don't catch it).

### KTD5 — Dashboard floor only (master U10)
Nil-guard components that render `task.worktree`/`task.branch` so a workspace task (no `task.worktree`, populated `workspaceWorktrees`) shows a placeholder or flat per-repo list, never a crash/empty. Ceiling: "doesn't look broken" — no rich per-repo-status component (deferred registration UI). Plus a one-line non-atomic-merge-semantics note in `CONCEPTS.md`/`docs/dashboard-guide.md`.

---

## Implementation Units

> **Standing requirements (every unit):** `FNXC:Workspace <yyyy-MM-dd-hh:mm>` comments at non-obvious decision points; a `.changeset/*.md` (`@runfusion/fusion: minor`); FN-5048 (narrow seams, real git only where an invariant requires it, fake timers over polling, no mock-the-world); FN-5893 surface enumeration (update every enumerated consumer, don't half-convert); merge gate (`pnpm lint`, typecheck, `pnpm build`, `pnpm test:gate`). Branch off the U0 branch — do not commit to `main` or the U0 branch.

### U1. Executor session scoping — skip root acquisition + preflights, browse-only root, activeWorktrees Set

**Goal:** In workspace mode the executor skips root acquisition and every rootDir git preflight, runs the session rooted at the workspace dir, and tracks per-task worktree *sets*.

**Requirements:** KTD1, KTD2.

**Dependencies:** none (foundation + U0 present on the base).

**Files:**
- `packages/engine/src/executor.ts` (acquisition `~:7430`; preflights `:7525` base capture, `:7536` contamination, identity-guard install, `verifyWorktreeInvariants`; session create `~:8443-8494`; retry session `~:8935`; `activeWorktrees` `:7667` + consumers `findActiveWorktreeOwner`/`hasActiveWorktreeBinding`/`getActiveWorktreeHolders`/FN-6736 reclaim `~:2055`/getters `~:1585`/`:14491`/`:14518`; `scopePromptToWorktree`)
- `packages/engine/src/__tests__/executor-workspace.test.ts` (**rewrite** — replace the `vi.mock`-the-subject tests with a **real two-repo git fixture harness** reusable by U2 and later phases)

**Approach:** Gate the root acquisition + each preflight behind `!this.workspaceConfig`. In workspace mode set session cwd = `this.rootDir`, leave `task.worktree` unset, no-op `scopePromptToWorktree`. Convert `activeWorktrees` to `taskId → Set<path>`; update each enumerated consumer to membership semantics (a non-workspace task = a one-element set). Mirror the existing `this.workspaceConfig === undefined` lazy-load guard at `executor.ts:7413-7418`.

**Execution note:** Build the real two-repo fixture harness first (create temp git repos, branch, commit); the foundation's self-mocking test proves nothing. The harness is shared infrastructure for the rest of the phases.

**Test scenarios:**
- Workspace config present → root `acquireTaskWorktree` NOT called; no preflight runs git against rootDir; session `cwd === rootDir`. (happy path)
- Non-workspace task → acquisition + every preflight called exactly as before; `cwd === worktreePath`. (regression — the singular path is untouched)
- Each enumerated `activeWorktrees` consumer returns correct results when a task holds two sub-repo paths (membership, not equality). (integration)
- Retry session in workspace mode uses `cwd === rootDir`. (edge)
- Workspace task that acquires zero sub-repos reaches `fn_task_done` without throwing on missing `task.worktree`. (edge/empty)

**Verification:** A workspace task starts a session at the workspace root with no root worktree and no rootDir git preflight; `activeWorktrees` reflects all acquired sub-repo paths; a single-repo task is unchanged.

---

### U2. Per-repo acquisition hardening — identity guard, per-repo base SHA, same-repo exclusivity

**Goal:** Each sub-repo worktree gets identity hooks, a correct per-repo base SHA (local-first, resolved integration branch), and same-sub-repo concurrency protection — all at acquisition.

**Requirements:** KTD3, KTD4.

**Dependencies:** U1 (shares the fixture harness).

**Files:**
- `packages/engine/src/worktree-acquisition.ts` (`acquireWorkspaceRepoWorktree` `~:598-650`)
- `packages/engine/src/base-commit-capture.ts` (**extend `resolveCapturedBaseCommitSha` to accept the integration branch** — it hardcodes `main`)
- `packages/engine/src/worktree-hooks.ts` (`installTaskWorktreeIdentityGuard`)
- `activeSessionRegistry` path-keying (repo-path exclusivity registry — KTD4; NOT `worktree-pool.ts`)
- `packages/core/src/types.ts` (extend the `Task.workspaceWorktrees` entry with `baseCommitSha?`)
- `packages/engine/src/__tests__/worktree-acquisition-workspace.test.ts` (new — real two-repo git fixture)

**Approach:** After `acquireTaskWorktree` returns for a sub-repo: (1) install the identity guard via `installTaskWorktreeIdentityGuard`, passing the **same settings args the executor passes** at `executor.ts:14035-14040` (`commitMsgHookEnabled`, `taskPrefix`, `taskAttributionTrailerName`) for single-repo parity — note `acquireWorkspaceRepoWorktree` calls `acquireTaskWorktree` *without* a `createWorktree` override, so the default backend installs **no** guard today (this work is genuinely missing); (2) resolve the integration branch via `resolveIntegrationBranch(repoAbsPath, { ...settings, integrationBranch: undefined })` (strip the shared override — KTD3 gotcha) and capture `baseCommitSha` via the extended `resolveCapturedBaseCommitSha(worktreePath, logger?, integrationBranch?)`; (3) persist `baseCommitSha` into `workspaceWorktrees[repo]`; (4) register same-sub-repo exclusivity in the `activeSessionRegistry` path-keyed registry — choose a **distinct registry kind/ownerKey** for the acquisition-time exclusivity entry so it does not collide with the executor's later session registration on the same sub-repo path (the registry exposes `registerPath`/`lookupByPath`/`isPathActive`/`pathsForTask`). Idempotent across `(taskId, repo)` (re-acquire returns the existing entry, no re-install/re-capture).

**Execution note:** Real two-repo fixture; commit-without-pushing to exercise the local-ahead-of-origin invariant.

**Test scenarios:**
- Acquiring repo A captures `baseSha_A` = the local integration tip even when `origin/<integration>` is behind. Covers the inflation invariant. (happy path + regression)
- A sub-repo whose integration branch is **not** `main` captures against that branch and does not inherit a shared `settings.integrationBranch`. (KTD3 correction)
- Identity-guard hook present; a commit on a non-`fusion/<id>` branch is rejected. (integration)
- Two concurrent workspace tasks acquiring the same sub-repo (even with disjoint in-repo scopes) are serialized by the exclusivity registry. (concurrency — KTD4)
- Re-acquiring repo A returns the existing entry without re-capture/re-install. (idempotency)
- Acquisition failure persists an audit event and surfaces an error (no swallowed stall). (error path)

**Verification:** Each sub-repo worktree has identity hooks, a correct per-repo base SHA (local-first, right branch), and same-sub-repo concurrency protection registered at acquisition.

---

### U3. Dashboard "doesn't look broken" floor (master U10)

**Goal:** Existing task views render a workspace task (no `task.worktree`, populated `workspaceWorktrees`) without breakage.

**Requirements:** KTD5.

**Dependencies:** none (independent of U1/U2; reads the data shape the foundation already added).

**Files:**
- Each `packages/dashboard/app/` component that reads `task.worktree`/`task.branch` for display (grep and enumerate during implementation — task detail view + any task-row/summary)
- `CONCEPTS.md` or `docs/dashboard-guide.md` (one-line non-atomic-merge-semantics note)
- `packages/dashboard/app/__tests__/` (new — graceful render test)

**Approach:** Add a nil-guard so each affected component renders a static placeholder (e.g. "N repos acquired") or a flat per-repo path list when `task.worktree` is absent and `workspaceWorktrees` is populated. **Ceiling:** placeholder/flat list only — a new rich per-repo-status component crosses into the deferred registration UI. Add the one-line semantics note (workspace-task merges are non-atomic: repos land independently on local integration refs; partial-land is local + operator-resettable).

**Test scenarios:**
- Task with `task.worktree` undefined + two `workspaceWorktrees` entries → renders a per-repo list/placeholder, no crash/empty. (happy path)
- Single-repo task → unchanged. (regression)

**Verification:** Workspace tasks are observable (not broken) in the dashboard.

---

## Scope Boundaries

**In scope:** the **run** stage — session scoping (U1), per-repo acquisition hardening (U2), dashboard breakage floor (U3).

### Deferred to Follow-Up Work (later master-plan phases)
- Per-repo modified-files capture, contamination, `verifyWorktreeInvariants` iteration (master U3 = Phase B).
- Per-repo review + `fn_task_done` completion verification (master U4 = Phase B).
- The shared landed predicate, per-repo `runAiMerge` clean-room loop, leases (master U5/U6/U7 = Phase C).
- Self-healing reconcilers, e2e harness (master U8/U9 = Phase D).
- Rich dashboard per-repo status / workspace registration UI.

> **Contamination-window caveat (carried from the master plan):** U1 gates the root preflights off, but per-repo contamination/`verifyWorktreeInvariants` does not return until master U3 (Phase B). Do not run a workspace task for real until Phase B lands — Phase A delivers acquisition + browse, not a verified end-to-end run.

---

## Risks & Dependencies

- **R1 — Half-converted `activeWorktrees` consumers (FN-5893).** Missing one consumer silently breaks liveness/owner checks for multi-repo tasks. Mitigation: KTD2 enumerates every consumer; grep all `activeWorktrees.get(`/`.has(`/`===`-on-path sites before declaring done.
- **R2 — A preflight left un-gated runs git against the non-git root → crash.** Mitigation: U1 explicitly enumerates and gates each preflight between the workspace guard and session create; test asserts no rootDir git in workspace mode.
- **R3 — Base-commit inflation per repo.** Mitigation: KTD3 extends the hardcoded-`main` helper and captures local-first against the resolved branch; regression test commits-without-pushing + uses a non-`main` integration branch.
- **R4 — Same-sub-repo concurrency unprotected.** Mitigation: KTD4 registers exclusivity at acquisition (U2), not via the recycle pool.
- **R5 — Non-workspace regression.** The whole point of branching on `workspaceConfig` is parity for single-repo tasks. Mitigation: every unit carries a non-workspace "unchanged" regression test; the gate's existing engine-core suite must stay green.
- **Stacking dependency:** builds on foundation #1710 + U0 #1711; the PR diff includes both and must not merge until they land.

---

## Sources & Research

- Master plan `docs/plans/2026-06-21-002-feat-workspace-mode-execution-model-plan.md` (U1/U2/U10, KTD1/KTD3/KTD6 — KTD7 is Phase B, invariant inventory, D2/D3/D5).
- Codebase anchors (verified this session): `executor.ts` acquisition/preflight/session/`activeWorktrees`; `worktree-acquisition.ts` `acquireWorkspaceRepoWorktree`; `base-commit-capture.ts` hardcoded-`main`; `resolveIntegrationBranch`; `activeSessionRegistry` path-keying; foundation `task.workspaceWorktrees`.
- `docs/solutions/logic-errors/files-changed-inflated-by-origin-first-base-commit.md` → KTD3 (local-first base capture).
- `AGENTS.md`: FN-5048 slow-test rules, FN-5893 surface enumeration, changeset policy, merge gate.
