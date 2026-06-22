---
title: "refactor: Merger unification (U0) — make runAiMerge the sole merge path"
status: active
date: 2026-06-21
type: refactor
origin: docs/plans/2026-06-21-002-feat-workspace-mode-execution-model-plan.md (master plan, U0 / Phase 0)
depth: standard
---

# refactor: Merger unification (U0) — make `runAiMerge` the sole merge path

## Summary

Phase 0 / U0 of the workspace-mode master plan. Make `runAiMerge` (the FN-5633 clean-room AI merge path, **already the default**) the **sole** merge path and soft-deprecate `aiMergeTask` (the "legacy `deterministic` pipeline") — deprecate the `merger.mode` setting by making its value inert (keep the type and field; see KTD2). This is a **standalone merge-consolidation refactor** with its own review/rollback story — it routes *every* task in *every* project through `runAiMerge`, not just workspace tasks, and is worth doing even if workspace mode were cancelled. It lands first so all downstream workspace work targets one canonical merge function with no dual-path forks.

It also installs the **R7 workspace merge-boundary guard** at every merge entry point, so that once workspace tasks can be created (later phases) one reaching merge before the per-repo loop (U6 in the master plan) is held with a clear error rather than crashing against the non-git workspace root.

**Scope:** dispatch collapse + the two direct CLI/dashboard callers + `@deprecated` markers + `merger.mode` setting retirement + the blast-radius audit + the R7 guard. **Out of scope:** hard deletion of `aiMergeTask` (soft-deprecate only — body retained), and any per-repo / multi-repo merge logic (master-plan U6).

---

## Problem Frame

Merge is dispatched at `packages/engine/src/project-engine.ts:2275-2282`:

```
const mergerMode = normalizeMergerMode(settings.merger?.mode);   // defaults to "ai"
return mergerMode === "ai"
  ? runAiMerge(store, cwd, taskId, mergeOptionsWithSettings)
  : aiMergeTask(store, cwd, taskId, mergerOptions);
```

`"ai"` is the default (`normalizeMergerMode` returns `"ai"` for anything not exactly `"deterministic"`), so `runAiMerge` is already what most tasks hit. But `aiMergeTask` (`packages/engine/src/merger.ts`, the "legacy pipeline") is still reachable two ways the engine dispatch doesn't cover:
- `packages/cli/src/commands/dashboard.ts:1302` `onMergeImpl` (the `--no-engine` UI-only merge) calls `aiMergeTask` directly at `:1330`.
- `packages/cli/src/commands/task.ts:847` `runTaskMerge` (the `fn task merge` CLI command) calls `aiMergeTask` directly at `:854`.

So collapsing only the engine dispatch leaves two live `aiMergeTask` callers. U0 unifies all three onto `runAiMerge`, soft-deprecates `aiMergeTask`, and retires the now-meaningless `merger.mode` setting.

Separately, the master plan's later phases add workspace tasks (`task.workspaceWorktrees` populated) whose merge must go through a per-repo loop (master U6). Until that exists, a workspace task reaching any merge path would run `runAiMerge`/`store.mergeTask`/the CLI callers against the **non-git workspace root** and crash. U0 installs a guard at every merge entry point that rejects populated-`workspaceWorktrees` tasks with a clear error naming U6 — covering the window from U0 through master-plan U6.

---

## Key Technical Decisions

> **ID namespace note:** the `KTD1–KTD4` and `U1–U4` identifiers below are **local to this U0 implementation plan**. They decompose master-plan **U0** (Phase 0) and are a **separate namespace** from the master plan's `KTD0–KTD8` / `U0–U10`. When the master plan says "U6 removes the R7 guard," that's master-plan U6 — unrelated to this plan's U-IDs.

### KTD1 — Soft deprecation, not deletion
Mark `aiMergeTask` and any helpers that become unreferenced `@deprecated` with a pointer to `runAiMerge`; **retain the bodies** for a later deletion pass. Rationale: keeps the diff reviewable and reversible; deletion is a separate follow-up once no references remain.

### KTD2 — Keep the `merger.mode` setting and type; ignore the `"deterministic"` value
`MergerMode` / `MergerSettings.mode` (`packages/core/src/types.ts:508-519`) is **published `@runfusion/fusion` surface**. **Keep the type and the field** (removing them would be a breaking change) — only make the *value* inert: the dispatch ignores it and always calls `runAiMerge`, and logs a **one-time** deprecation warning when a resolved `merger.mode === "deterministic"` is observed. A changeset is required (minor — behavior change + deprecation). Rationale: avoids a breaking type removal while making the setting inert. "Deprecate/retire" in this plan means *inert*, never *removed*.

### KTD3 — R7 guard at every merge entry point, keyed on `task.workspaceWorktrees`
The guard is a single shared predicate (e.g. `assertNotWorkspaceTaskMerge(task)`) called at the top of each merge entry point — the engine dispatch, `store.mergeTask`, `onMergeImpl`, and `runTaskMerge` — that throws a clear, named error (`Workspace task <id> cannot merge until per-repo merge support (master-plan U6) lands`) when `task.workspaceWorktrees` is non-empty. Rationale: one predicate, all doors; prevents the non-git-root crash in the U0→U6 window. **Master-plan U6 removes this guard** when the per-repo loop becomes the gate.

### KTD4 — Audit, don't assert, the deterministic blast radius
Before claiming low blast radius, grep test fixtures, CI configs, and seeded/default project settings for `merger.mode` / `"deterministic"` and `testMode`/mock interactions, and cite the result in the PR. Expectation (user-confirmed for their projects): effectively unused. The audit confirms it rather than the plan asserting it.

---

## Implementation Units

> **Units `U1–U4` below are local to this plan** (they decompose master-plan U0); they are **not** the master plan's `U1–U10`. U4 (audit) may run in parallel with U1–U3.

> **Standing requirements:** `FNXC:Workspace <yyyy-MM-dd-hh:mm>` dated comments at each non-obvious decision point (dispatch collapse, the R7 guard, the deprecation warning). A `.changeset/*.md` (`@runfusion/fusion: minor`). Respect the merge gate (`pnpm lint`, typecheck, `pnpm build`, `pnpm test:gate`) and FN-5048 (narrow seams, fake timers, no real polling / mock-the-world). **Base branch (decided):** branch off the **foundation** (`pr-1710` / `feat/workspace-multi-repo` head) — the R7 guard (U3) reads `task.workspaceWorktrees`, which the foundation adds and `main` lacks. Do **not** commit onto `pr-1710` directly; use a new branch and open a **stacked PR targeting `feat/workspace-multi-repo`** so the diff is only U0's changes.

### U1. Collapse the engine dispatch and route the two direct callers to `runAiMerge`

**Goal:** Every merge entry point calls `runAiMerge`; no production code path calls `aiMergeTask`.

**Requirements:** KTD2.

**Dependencies:** none.

**Files:**
- `packages/engine/src/project-engine.ts` (`:2275-2282` — drop the `mergerMode` ternary; always `runAiMerge`; keep computing `mergeOptionsWithSettings`)
- `packages/cli/src/commands/dashboard.ts` (`:1302` `onMergeImpl`, the `aiMergeTask` call at `:1330` → `runAiMerge`; update the `:1294-1298` comment; import at `:44`)
- `packages/cli/src/commands/task.ts` (`:847` `runTaskMerge`, the `aiMergeTask` call at `:854` → `runAiMerge`; import at `:2`)
- `packages/engine/src/__tests__/` (dispatch test — assert all entry points route to `runAiMerge`)

**Approach:** Replace the engine dispatch ternary with an unconditional `runAiMerge(store, cwd, taskId, mergeOptionsWithSettings)`. Update `onMergeImpl` and `runTaskMerge` to call `runAiMerge` with the equivalent option shape they pass today — feasibility confirmed parity: `aiMergeTask` and `runAiMerge` share the `MergerOptions` interface (`merger.ts:5998`), both CLI callers pass only `agentStore`/`onAgentText` (both in `MergerOptions`, both consumed by `runAiMerge`), and `runAiMerge`'s 5th `deps` param defaults to `{}`, so the 4-arg calls are safe. **U2 implements the `"deterministic"` deprecation warning** (at the dispatch point); U1 just stops branching on the mode. Do not change `runAiMerge`'s own behavior.

**Patterns to follow:** the existing `runAiMerge(store, cwd, taskId, mergeOptionsWithSettings)` call already in the `"ai"` branch.

**Test scenarios:**
- Engine dispatch with `settings.merger.mode` unset / `"ai"` / `"deterministic"` → all three call `runAiMerge` (spy/mock the two merge fns, assert only `runAiMerge` is invoked). (behavior unification across modes)
- `runTaskMerge` (the `fn task merge` command) invokes `runAiMerge`, not `aiMergeTask`. (CLI caller)
- `onMergeImpl` (UI-only `--no-engine`) invokes `runAiMerge`, not `aiMergeTask`. (dashboard caller)
- Existing single-repo `runAiMerge` behavior is unchanged (no regression in the `runAiMerge` unit tests). (regression)

**Verification:** A grep for `aiMergeTask(` in non-test production code returns zero call sites; all merge entry points route to `runAiMerge`.

---

### U2. Soft-deprecate `aiMergeTask` and retire the `merger.mode` setting

**Goal:** Mark `aiMergeTask` `@deprecated` (body retained) and make `merger.mode` inert with a one-time deprecation warning, plus a changeset.

**Requirements:** KTD1, KTD2.

**Dependencies:** U1.

**Files:**
- `packages/engine/src/merger.ts` (`aiMergeTask` + any helpers that U1 leaves unreferenced → `@deprecated` jsdoc pointing to `runAiMerge`; bodies retained)
- `packages/core/src/types.ts` (`:505-519` — `MergerMode`/`MergerSettings.mode` jsdoc marks `"deterministic"` deprecated; do not remove the type)
- `packages/engine/src/project-engine.ts` (one-time deprecation warning when a resolved `merger.mode === "deterministic"` is seen)
- `.changeset/<name>.md` (`@runfusion/fusion: minor`)
- `packages/engine/src/__tests__/` (warning-emission test)

**Approach:** Add `@deprecated` jsdoc to `aiMergeTask` and the helpers U1 orphaned (do not delete). **Confirm the live-helper set first:** `runAiMerge` (`merger-ai.ts:66`) imports `captureSingleCommitLandedMetadata` (defined in `merger.ts:6059`) from `merger.js` — that helper is **shared and must NOT be `@deprecated`**. Grep `merger-ai.ts`'s imports from `merger.js` to enumerate every helper `runAiMerge` still depends on, and exclude those from deprecation; only tag what is genuinely orphaned after U1. In `types.ts`, annotate `"deterministic"` as deprecated in the `MergerMode` jsdoc without changing the enum (avoids a breaking type change). Emit a single deprecation warning (guarded so it logs once per process, e.g. a module-level flag) when the dispatch resolves `"deterministic"`. Write the changeset describing the merge-path consolidation and the `merger.mode` deprecation.

**Test scenarios:**
- A project resolving `merger.mode === "deterministic"` → routed to `runAiMerge` **and** a deprecation warning is logged exactly once per process (not an error, not repeated). This warning assertion lives in U2's test, not U1's dispatch test. (migration / warn-not-error)
- `merger.mode` unset → no warning. (no false positives)
- `aiMergeTask` retains its body and exports (callable, just unreferenced in production). (soft-delete invariant)

**Verification:** `aiMergeTask` is `@deprecated` but present; `"deterministic"` logs one warning and routes to `runAiMerge`; a changeset exists.

---

### U3. R7 workspace merge-boundary guard at every merge entry point

**Goal:** A populated-`workspaceWorktrees` task is rejected from every merge path with a clear error naming master-plan U6, covering the window until per-repo merge support lands.

**Requirements:** KTD3.

**Dependencies:** U1.

**Files:**
- `packages/engine/src/` (new shared predicate, e.g. `assertNotWorkspaceTaskMerge(task)` — throws a named error when `task.workspaceWorktrees` is non-empty)
- `packages/engine/src/project-engine.ts` (call it at the top of the merge dispatch)
- `packages/core/src/store.ts` (call it at the top of `mergeTask` `:11150` — the third merge path)
- `packages/cli/src/commands/dashboard.ts` (`onMergeImpl`), `packages/cli/src/commands/task.ts` (`runTaskMerge`)
- `packages/engine/src/__tests__/` (guard test across entry points)

**Approach:** One shared predicate reused at all four entry points (dispatch, `store.mergeTask`, `onMergeImpl`, `runTaskMerge`). It throws `Workspace task <id> cannot merge until per-repo merge support (master-plan U6) lands` when `task.workspaceWorktrees` has any entry. For non-workspace tasks it is a no-op, so single-repo behavior is unchanged. Add an `FNXC:Workspace` comment explaining the U0→U6 window the guard covers and that U6 removes it.

**Test scenarios:**
- A task with two `workspaceWorktrees` entries → each of the four entry points throws the named error mentioning U6; no `git checkout` runs against the root. (guard at every door)
- A normal single-repo task (no `workspaceWorktrees`) → guard is a no-op; merge proceeds via `runAiMerge`. (no regression)
- The thrown error names U6 / "per-repo merge support" so it's actionable. (clear messaging)

**Verification:** No workspace task can reach any merge path's git operations before master-plan U6; single-repo merges are unaffected.

---

### U4. Deterministic-mode blast-radius audit

**Goal:** Cite, not assert, that the `"deterministic"` path is effectively unused.

**Requirements:** KTD4.

**Dependencies:** none (can run in parallel with U1–U3).

**Files:**
- (audit only — no source change) PR description / commit body records the result.

**Approach:** Grep test fixtures, CI configs (`.github/workflows/`), and seeded/default project settings for `merger.mode`, `"deterministic"`, and `testMode`/mock-provider interactions that might assert `aiMergeTask`'s deterministic (non-AI) output. Enumerate any suite that depends on the deterministic path; if found, note whether U1 reroutes it cleanly (warn + `runAiMerge`) or needs a fixture update. Cite the result in the PR.

**Test scenarios:** `Test expectation: none -- audit/investigation unit; output is the cited result in the PR, not a code change.`

**Verification:** The PR states which (if any) fixtures/CI/projects referenced `"deterministic"`, confirming the low-blast-radius claim with evidence.

---

## Scope Boundaries

**In scope:** dispatch collapse, the two CLI/dashboard callers, `@deprecated` markers, `merger.mode` retirement + changeset, the R7 guard at all merge entry points, and the blast-radius audit.

### Deferred to Follow-Up Work
- **Hard deletion of `aiMergeTask`** and its orphaned helpers (separate pass once no references remain).
- All per-repo / multi-repo merge logic — the `runAiMerge` `landOneRepo` clean-room rework, `store.mergeTask` per-repo gating beyond the R7 guard, etc. (master-plan U6).
- Removing the `MergerMode` type / `merger.mode` setting entirely (breaking change; revisit after the deprecation has shipped).

---

## Risks & Dependencies

- **R1 — A missed `aiMergeTask` caller leaves a live legacy path.** Mitigation: U1's verification greps for zero non-test `aiMergeTask(` call sites; the dispatch test asserts all entry points route to `runAiMerge`.
- **R2 — Deterministic-mode consumers silently switch to AI merge.** Mitigation: U4 audits before claiming low blast radius; U2 warns (not errors) on `"deterministic"`.
- **R3 — Option-shape mismatch between `aiMergeTask` and `runAiMerge` at the CLI callers.** Mitigation: U1 confirms `runAiMerge`'s signature/options match what `onMergeImpl`/`runTaskMerge` pass today before rerouting; covered by the CLI caller tests.
- **R4 — Published-surface change.** `merger.mode` is `@runfusion/fusion` surface. Mitigation: keep the type (KTD2), changeset required (U2).
- **Dependency:** none external; lands before master-plan Phase A.

---

## Sources & Research

- Master plan `docs/plans/2026-06-21-002-feat-workspace-mode-execution-model-plan.md` (U0 / Phase 0, KTD0, R4, R7).
- Codebase verification (this session): dispatch `project-engine.ts:2275-2282`; direct callers `dashboard.ts:1302/1330`, `task.ts:847/854`; `MergerMode`/`normalizeMergerMode`/`MergerSettings` `types.ts:508-519`; `store.mergeTask` `store.ts:11150`.
- `AGENTS.md`: changeset policy (published `@runfusion/fusion`), merge-gate commands, FN-5048 slow-test rules, FN-5633 (AI merge default).
