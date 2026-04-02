# Task: KB-093 - Add support for creating (and merging) pull requests

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This change alters the completion path for in-review tasks and introduces GitHub-side merge orchestration across core settings, engine runtime, package exports, dashboard UX, and tests. It is high-impact, cross-package behavior that must preserve existing direct-merge behavior while adding a new PR-first mode.
**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 1, Reversibility: 2

## Mission

Add an explicit PR-first completion mode so kb can create a GitHub pull request instead of directly squashing local branches, continuously monitor that PR for review feedback and CI readiness, and merge it automatically once policy conditions are satisfied. This enables teams that require GitHub checks/reviews to keep using kb automation without bypassing repository governance.

## Dependencies

- **None**

## Context to Read First

- `packages/cli/src/commands/dashboard.ts`
- `packages/cli/src/commands/dashboard.test.ts`
- `packages/dashboard/src/index.ts`
- `packages/dashboard/src/github.ts`
- `packages/dashboard/src/github.test.ts`
- `packages/engine/src/index.ts`
- `packages/engine/src/scheduler.ts`
- `packages/engine/src/pr-monitor.ts`
- `packages/engine/src/pr-comment-handler.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/routes.test.ts`
- `packages/dashboard/app/components/SettingsModal.tsx`
- `packages/dashboard/app/components/TaskDetailModal.tsx`
- `packages/dashboard/app/components/PrSection.tsx`
- `packages/dashboard/app/components/__tests__/PrSection.test.tsx`
- `packages/core/src/types.ts`
- `packages/core/src/store.ts`
- `README.md`
- `packages/cli/README.md`
- `packages/dashboard/README.md`

## File Scope

- `packages/core/src/types.ts`
- `packages/core/src/store.test.ts`
- `packages/dashboard/src/index.ts`
- `packages/dashboard/src/github.ts`
- `packages/dashboard/src/github.test.ts`
- `packages/cli/src/commands/dashboard.ts`
- `packages/cli/src/commands/dashboard.test.ts`
- `packages/engine/src/index.ts`
- `packages/engine/src/scheduler.ts`
- `packages/engine/src/pr-monitor.ts`
- `packages/engine/src/pr-monitor.test.ts`
- `packages/engine/src/pr-comment-handler.ts`
- `packages/engine/src/pr-comment-handler.test.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/routes.test.ts`
- `packages/dashboard/app/api.ts`
- `packages/dashboard/app/components/SettingsModal.tsx`
- `packages/dashboard/app/components/TaskDetailModal.tsx`
- `packages/dashboard/app/components/PrSection.tsx`
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx`
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx`
- `packages/dashboard/app/components/__tests__/PrSection.test.tsx`
- `README.md`
- `packages/cli/README.md`
- `packages/dashboard/README.md`
- `.changeset/*`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Add a merge strategy setting for direct vs PR-based completion

- [ ] Extend `Settings`/`DEFAULT_SETTINGS` in `packages/core/src/types.ts` with a backward-compatible merge strategy field (default preserving current direct merge behavior)
- [ ] Surface the new setting through dashboard settings UX (`packages/dashboard/app/components/SettingsModal.tsx`) with clear user-facing copy for both modes
- [ ] Ensure existing `autoMerge` semantics remain intact (toggle still controls whether automated completion runs at all)
- [ ] Add/update tests validating settings defaults, persistence, and UI form behavior
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.test.ts` (modified)
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified)

### Step 2: Implement PR-first auto-completion flow in the runtime merge queue

- [ ] Update `packages/cli/src/commands/dashboard.ts` merge queue logic so in-review tasks use one of two paths: existing `aiMergeTask` (direct mode) or PR lifecycle (PR mode)
- [ ] Expose `GitHubClient` from `packages/dashboard/src/index.ts` so CLI runtime can consume dashboard GitHub primitives via package-root import (no deep import)
- [ ] In PR mode, ensure in-review tasks automatically create/link PRs when missing `task.prInfo` (reusing `GitHubClient.createPr` and existing task branch naming convention `kb/{task-id-lower}`)
- [ ] Implement explicit merge-readiness policy and tests:
  - **Merge allowed only when:** PR status is `open`; all **required** checks are `success` (no `pending`, `failed`, `cancelled`, `timed_out`, `action_required`); review state is non-blocking (no active changes-requested gate)
  - **Merge blocked when:** any required check is pending/failing OR review gate is blocking OR PR is closed
  - **Optional/non-required checks** do not block merge
- [ ] Merge PR via GitHub (`gh`/API) when ready, then finalize local task state/cleanup to `done` with status reset on errors
- [ ] Preserve robust failure behavior: no duplicate PR creation, no merge attempts during pause states, and no silent task loss on transient GitHub failures
- [ ] Add/expand unit tests in `dashboard.test.ts` and `github.test.ts` covering PR creation path, readiness truth table conditions, merge path, and fallback handling
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/index.ts` (modified)
- `packages/cli/src/commands/dashboard.ts` (modified)
- `packages/cli/src/commands/dashboard.test.ts` (modified)
- `packages/dashboard/src/github.ts` (modified)
- `packages/dashboard/src/github.test.ts` (modified)

### Step 3: Wire PR comment monitoring into PR-first automation and task UX

- [ ] Reuse existing scheduler-based PR monitor hooks (`packages/engine/src/scheduler.ts`) rather than duplicating a parallel monitor path, and ensure PR comment events still become task steering comments in PR mode
- [ ] Export any newly required PR monitoring/comment handler symbols via `packages/engine/src/index.ts` so runtime wiring remains package-root-safe
- [ ] Enforce clear PR-mode state transition contract in tests:
  - stays `in-review` while waiting for checks/reviews
  - stays `in-review` on transient GitHub/merge errors (status cleared from temporary merging state)
  - moves to `done` only after successful PR merge + cleanup path
- [ ] Update task detail UX (`PrSection`/`TaskDetailModal`) so actions and messaging reflect PR-first automation state (PR linked + awaiting checks vs merged)
- [ ] Add/update API/UI tests for any changed route payloads and task detail behavior
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/engine/src/index.ts` (modified)
- `packages/engine/src/scheduler.ts` (modified)
- `packages/engine/src/pr-monitor.ts` (modified)
- `packages/engine/src/pr-monitor.test.ts` (modified)
- `packages/engine/src/pr-comment-handler.ts` (modified)
- `packages/engine/src/pr-comment-handler.test.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)
- `packages/dashboard/app/components/PrSection.tsx` (modified)
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/PrSection.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run targeted tests while implementing:
  - `pnpm --filter @kb/core test -- src/store.test.ts`
  - `pnpm --filter @kb/dashboard test -- src/github.test.ts src/routes.test.ts app/components/__tests__/SettingsModal.test.tsx app/components/__tests__/PrSection.test.tsx app/components/__tests__/TaskDetailModal.test.tsx`
  - `pnpm --filter @kb/engine test -- src/pr-monitor.test.ts src/pr-comment-handler.test.ts`
  - `pnpm --filter @dustinbyrne/kb test -- src/commands/dashboard.test.ts`
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update docs for the new PR-first merge mode, including behavior, prerequisites (`gh` auth / token), and operational expectations
- [ ] Document branch push expectation/non-goal for PR-mode automation (do not add implicit push behavior unless explicitly implemented and tested)
- [ ] Add a changeset for `@dustinbyrne/kb` describing the new user-facing PR merge mode
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `README.md` — document PR-first merge mode and end-to-end workflow changes
- `packages/cli/README.md` — update automation/auto-merge behavior description
- `packages/dashboard/README.md` — document new merge setting semantics and PR lifecycle behavior
- `.changeset/*.md` — add release note for published package behavior change

**Check If Affected:**
- `AGENTS.md` — update only if contributor guidance must change for merge strategy implementation

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-093): complete Step N — description`
- **Bug fixes:** `fix(KB-093): description`
- **Tests:** `test(KB-093): description`

## Do NOT

- Expand task scope beyond PR creation/monitoring/merge automation
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Break the existing direct merge path when PR-first mode is disabled
- Auto-merge PRs when required checks are failing/pending or review state is explicitly blocking
