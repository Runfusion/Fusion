---
title: "feat: Workspace mode Phase B — per-repo capture, contamination, review, completion verify"
status: active
date: 2026-06-21
type: feat
origin: docs/plans/2026-06-21-002-feat-workspace-mode-execution-model-plan.md (master plan, Phase B / U3·U4)
depth: deep
---

# feat: Workspace mode Phase B — per-repo capture, contamination, review, completion verify

> **ID namespace:** local `U1·U2` decompose master-plan **U3, U4**.
> **Anchors below are feasibility-verified against the Phase-B base** (not the master plan's approximate numbers).

## Summary

Phase B makes the executor's capture / contamination / verify / review / completion paths iterate `task.workspaceWorktrees` per sub-repo, using each repo's own `baseCommitSha` (Phase A, U2). It does **not** simply "un-gate stubs" — the feasibility pass found capture/contamination/scope-leak are not gated at all today; they **silently degrade to empty** against the non-git root (git failures swallowed). Phase B adds the missing workspace branches and reuses the existing `captureModifiedFiles` machinery (whose `resolveDiffBaseRef` merge-base fallback + `filterFilesToOwnTaskCommits` contamination audit are exactly what's needed) per repo.

Builds on Phase A (PR #1713). **Scope out:** the merge loop (master U6 = Phase C), self-healing (master U8 = Phase D).

**Stacking:** off the Phase-A branch; PR diff includes the stack; must not merge until it lands.

---

## Problem Frame

Phase A rooted workspace sessions at the non-git workspace root and acquired per-repo worktrees, but the executor's change-capture, contamination, worktree-invariant, review, and completion-verify paths still operate on a single `task.worktree`. Against the non-git root they either are explicitly stubbed (one site) or silently produce empty results (the rest). Phase B routes each of these through every acquired sub-repo worktree, `cwd` = the sub-repo, diffing against that repo's `workspaceWorktrees[repo].baseCommitSha`, with repo-prefixed file lists so review/dashboard/later-merge keep repo context.

---

## Key Technical Decisions

### KTD1 — Per-repo change capture by **reusing `captureModifiedFiles`**, not a raw diff (master KTD7)
**Verified reality:** capture is **not** workspace-gated. The post-session call `captureModifiedFiles(worktreePath, …, "post-session")` (executor.ts **:7898**) runs ungated with `worktreePath` = the browse-only non-git root and returns `[]` only because `resolveDiffBaseRef`/`resolveContaminationBaseRef` swallow the git failure. So U1 **adds** a workspace branch at :7898 (and the sibling branch-attribution audit at **:7914**), it does not replace one.

Per repo, call the **existing** `captureModifiedFiles(repo.worktreePath, repo.baseCommitSha, task.id, audit, source)` — NOT a hand-built `git diff <base>..HEAD`. Reasons (all verified): (a) `repo.baseCommitSha` may be **undefined** (Phase A made base capture non-fatal); `resolveDiffBaseRef` (:~12184) handles that via a merge-base fallback. (b) the real **contamination** signal is the `filterFilesToOwnTaskCommits` raw-vs-attributed divergence audit **inside** `captureModifiedFiles` (:~12225-12246) — reusing it restores contamination for free. Prefix each repo's returned files with the repo path and aggregate into `task.modifiedFiles`.

> **`assertCleanBranchAtBase` is a no-op** (branch-conflicts.ts: `void`s all params — "informational only"). Do **not** add a per-repo iteration of it; it would restore zero protection. Contamination comes from per-repo `captureModifiedFiles`.

### KTD2 — `verifyWorktreeInvariants` iterates per acquired worktree, preserving its result union (master KTD7)
The **one** workspace stub in this region is `verifyWorktreeInvariants` returning `{ok:true}` at executor.ts **:10508** (def **:10500**). Un-stub it: iterate every `workspaceWorktrees` entry, asserting each HEAD is on `fusion/<id>` and toplevel matches the recorded `worktreePath`. **Preserve the exact discriminated union** `{ok:true} | {ok:false; reason:'wrong_toplevel'|'wrong_branch'|'no_commits'; observed; expected}` (consumed at **:10889**; the `reason` enum drives the requeue/handoff branches at :10894-10936) — add a `repo` field to the failure shape; return the **first** failing repo.

### KTD3 — Per-repo review by looping the **existing single-cwd `reviewStep`** N times (master KTD7)
**Decision (user-confirmed): accept the N× reviewer cost.** The reviewer is an **agent** spawned with `cwd` = worktree and told (in prompt text, reviewer.ts:~760) to run `git diff` itself — it does not read a diff passed in code. So per-repo review = spawning **one reviewer agent per sub-repo**. Architecture: the **callers loop** and call the existing single-cwd `reviewStep` (reviewer.ts **:122**) once per acquired worktree (cwd = repo, scope = prefix-derived subset); aggregate repo-tagged verdicts into the task's single review record as a **conjunction** (reviewed only if every repo passes). `reviewStep` itself stays single-cwd.

**Both review call sites iterate (user-confirmed FN-5893 coverage):**
- `createReviewStepTool` → `reviewStep` (executor.ts **:11148**, the in-session `fn_review_step` path).
- the **step-inversion seam** `reviewStep(worktreePath=active.worktreePath || detail.worktree || this.rootDir, …)` at executor.ts **:5668** (foreach/step-inversion path).

### KTD4 — `fn_task_done` completion verification iterates per repo, including the scope-leak guard (master KTD7)
`fn_task_done` (`createTaskDoneTool` executor.ts **:10832**) must, in workspace mode: (a) call the per-repo `verifyWorktreeInvariants` (KTD2) for every acquired worktree; (b) iterate the **scope-leak guard** `evaluateTaskDoneScopeLeak` (executor.ts **:10711**, invoked at **:11009**) per repo — it currently runs `captureUncommittedModifiedFiles(worktreePath)` + `captureModifiedFiles(worktreePath, task.baseCommitSha, …)` against the singular root and silently passes; per-repo iteration (cwd = sub-repo, `repo.baseCommitSha`) restores the uncommitted-in-scope block. Block completion on any dirty/misbound repo or uncommitted in-scope change, naming the repo.

> **Repo-prefix derivation helper** (shared, master U5 will reuse): canonicalize → match first path segment to a configured repo → `unscoped` fallback. New `packages/engine/src/workspace-paths.ts`. Keep it minimal — no lease logic (Phase C / master U7).

---

## Implementation Units

> **Standing requirements:** `FNXC:Workspace <yyyy-MM-dd-hh:mm>` comments; a `.changeset/*.md` (`@runfusion/fusion: minor`); FN-5048 (reuse the Phase-A `_workspace-fixture.ts` harness; real git only where the invariant requires it; fake timers; no mock-the-world); FN-5893 surface enumeration; the merge gate. Branch off Phase A (already checked out: `gsxdsm/workspace-phase-b`).

### U1. Per-repo capture, contamination, and worktree-invariant verification (master U3)

**Goal:** Change-capture, contamination, and `verifyWorktreeInvariants` cover every acquired sub-repo worktree with repo context and correct cwd.

**Requirements:** KTD1, KTD2.

**Dependencies:** none beyond Phase A.

**Files:**
- `packages/engine/src/executor.ts` — **add** a workspace branch at the post-session capture **:7898** (+ attribution audit **:7914**) that loops `workspaceWorktrees` calling `captureModifiedFiles(repo.worktreePath, repo.baseCommitSha, …)` per repo, repo-prefixing results; **un-stub** `verifyWorktreeInvariants` **:10508** to iterate per worktree preserving the `{ok|reason|observed|expected}` union (+ `repo`).
- `packages/engine/src/__tests__/executor-workspace-capture.test.ts` (new — real two-repo fixture via `_workspace-fixture.ts`)

**Approach:** Per KTD1/KTD2. Reuse `captureModifiedFiles` (do not hand-build `git diff`); do not iterate the no-op `assertCleanBranchAtBase`. Singular non-workspace path unchanged.

**Execution note:** Reuse `_workspace-fixture.ts`; commit edits onto each sub-repo's `fusion/<id>` branch to exercise real diffs + the divergence audit.

**Test scenarios:**
- Edits in repo A and B → `task.modifiedFiles` carries repo-prefixed paths from both, each diffed against its own `baseCommitSha`. (happy path)
- A repo with `baseCommitSha` undefined → capture still works via the merge-base fallback (no `git diff undefined..HEAD`). (edge — Phase A non-fatal base)
- A foreign commit in a sub-repo's range → the `filterFilesToOwnTaskCommits` divergence/contamination audit fires for that repo. (contamination)
- A worktree HEAD drifted off `fusion/<id>` → `verifyWorktreeInvariants` returns `{ok:false, reason:'wrong_branch', repo, observed, expected}` (not `{ok:true}`); the `reason` enum is preserved for the :10889 consumer. (error path)
- Single-repo (non-workspace) task → capture/verify byte-for-byte identical. (regression)

**Verification:** Capture + contamination audit + invariant verify run per acquired worktree with repo context; the result union is intact; single-repo unchanged.

---

### U2. Per-repo review (both call sites) + `fn_task_done` completion + scope-leak verification (master U4)

**Goal:** Review every acquired sub-repo (both review entry points) and block completion until every sub-repo passes review, invariant, and scope-leak checks.

**Requirements:** KTD3, KTD4, KTD2.

**Dependencies:** U1 (per-repo verify + capture).

**Files:**
- `packages/engine/src/executor.ts` — `createReviewStepTool` **:11148** and the step-inversion seam **:5668** loop `reviewStep` per acquired worktree; `createTaskDoneTool` **:10832** calls per-repo verify (U1) + iterates `evaluateTaskDoneScopeLeak` **:10711** per repo.
- `packages/engine/src/reviewer.ts` — `reviewStep` (**:122**) stays single-cwd; callers loop. Aggregate repo-tagged verdicts (conjunction) into the task review record; reviewer findings carry the repo tag.
- `packages/engine/src/workspace-paths.ts` (new — the repo-prefix-derivation helper; master U5 reuses)
- `packages/engine/src/__tests__/reviewer-workspace.test.ts`, `packages/engine/src/__tests__/executor-workspace-taskdone.test.ts` (new)

**Approach:** Per KTD3/KTD4. Both review sites loop the existing single-cwd `reviewStep` once per sub-repo (N reviewer agents — accepted cost) and aggregate as a conjunction. `fn_task_done` per-repo verify + per-repo scope-leak.

**Test scenarios:**
- Two-repo task → two reviewer passes (one per repo cwd); review record reflects both; reviewed only when both pass. (conjunction)
- A reviewer finding in repo B is repo-tagged. (integration)
- Step-inversion review seam (:5668) for a workspace task reviews each sub-repo, not the non-git root. (FN-5893 second surface)
- `fn_task_done` with an uncommitted in-scope change in repo A → completion blocked, naming repo A (the scope-leak guard fires per-repo). (error path)
- `fn_task_done` with a worktree off `fusion/<id>` → blocked via per-repo verify. (error path)
- The prefix helper: `wolf-server/src/**` → repo `wolf-server`; non-matching first segment → `unscoped`. (helper)
- Single-repo task → one review pass + singular scope-leak/verify, unchanged. (regression)

**Verification:** A workspace task is reviewed/complete only when every sub-repo passes review + invariant + scope-leak; both review entry points iterate; single-repo unchanged.

---

## Scope Boundaries

**In scope:** per-repo capture/contamination/verify (U1); per-repo review at both call sites + `fn_task_done` verify + scope-leak (U2); the repo-prefix helper.

### Deferred to Follow-Up Work (later phases)
- The per-repo merge loop, the landed predicate, the file-scope leases (master U5/U6/U7 = Phase C).
- Self-healing reconcilers, e2e (master U8/U9 = Phase D).
- Per-repo worktree teardown (carried Phase-A residual).
- Store-level **atomic** per-repo `workspaceWorktrees` merge — Phase A added a re-read mitigation; the fully-atomic merge is still open and **becomes reachable in Phase B** (multi-repo acquisition first exercised here). Track for Phase C.

---

## Risks & Dependencies

- **R1 — "Add a branch" vs "replace a stub" confusion.** Capture/contamination/scope-leak silently degrade (not gated); an implementer expecting a stub to replace won't find one. Mitigation: KTD1/KTD4 + U1/U2 cite the exact add sites (:7898/:7914, :10711) and the one real stub (:10508).
- **R2 — Hand-built `git diff` breaks on undefined base.** Mitigation: KTD1 mandates reusing `captureModifiedFiles`; test covers the undefined-base repo.
- **R3 — `verifyWorktreeInvariants` union shape.** The `reason` enum is load-bearing at :10889. Mitigation: KTD2 preserves the union; test asserts the `reason`.
- **R4 — No-op contamination function.** Mitigation: KTD1 explicitly forbids iterating `assertCleanBranchAtBase`; contamination rides on per-repo `captureModifiedFiles`.
- **R5 — N× reviewer cost.** Accepted (user decision). Mitigation: note in the PR; cost scales with repo count (typically 2-3).
- **Stacking dependency:** off Phase A (#1713); diff includes the stack.

---

## Sources & Research

- Master plan (U3/U4, KTD7, contamination-window caveat).
- Phase B feasibility pre-check (verified anchors: capture not gated/:7898 add-site, `assertCleanBranchAtBase` no-op, undefined-base via `resolveDiffBaseRef`, verify union :10508/:10889, review agent N× cost + the :5668 second surface, scope-leak :10711, anchor corrections).
- Phase A (#1713): per-repo `baseCommitSha`, `activeWorktrees` Set, `_workspace-fixture.ts`.
- `docs/solutions/logic-errors/files-changed-inflated-by-origin-first-base-commit.md`.
