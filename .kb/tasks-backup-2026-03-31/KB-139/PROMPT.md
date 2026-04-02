# Task: KB-139 - Re-enable dashboard regression coverage and clear non-KB-096 typecheck failures

**Created:** 2026-03-30
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This work is confined to the dashboard package, but it spans skipped test suites, TypeScript configuration, and multiple component/test files that currently fail `pnpm typecheck`. Review should verify the fix restores real verification instead of masking stale tests or weakening type safety.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Bring dashboard verification back to an honest, fully-running state once KB-096 has landed. Right now `cd packages/dashboard && pnpm test` looks green partly because the legacy `app/hooks/__tests__/useTerminal.test.tsx` suite and `src/__tests__/typecheck.test.ts` are skipped, while `cd packages/dashboard && pnpm typecheck` still fails on a mix of dashboard-local typing problems and workspace type-resolution drift. This task should restore active regression coverage for the refine-route/terminal/typecheck areas described in the task, fix the remaining non-KB-096 dashboard type errors, and leave the package with active tests plus a passing local typecheck gate after the KB-096 `Header`/`App` prop mismatch is no longer present.

## Dependencies

- **Task:** KB-096 (hard prerequisite: its `Header.tsx` / `App.tsx` `onOpenUsage` wiring must be complete before this task can pass `cd packages/dashboard && pnpm typecheck` and the final verification gates; KB-139 must not absorb that usage-indicator scope)

## Context to Read First

- `packages/dashboard/package.json` — dashboard-local `test`, `build`, and `typecheck` commands; note that `typecheck` runs both `tsc --noEmit` and `tsc --noEmit -p tsconfig.app.json`
- `packages/dashboard/src/routes.test.ts` — current active `POST /tasks/:id/refine` coverage; confirm it is already implemented and green before changing route code
- `packages/dashboard/src/routes.ts` — existing `/tasks/:id/refine` handler; do not recreate stale missing-route work
- `packages/dashboard/app/hooks/useTerminal.ts` — current WebSocket-based `useTerminal(sessionId)` contract
- `packages/dashboard/app/hooks/useTerminal.test.ts` — active terminal hook tests for the current API
- `packages/dashboard/app/hooks/__tests__/useTerminal.test.tsx` — skipped legacy command-runner hook suite that no longer matches `useTerminal.ts`
- `packages/dashboard/src/__tests__/typecheck.test.ts` — skipped typecheck regression guard that currently only shells out to `tsc`
- `packages/dashboard/tsconfig.json` — `src` TypeScript config
- `packages/dashboard/tsconfig.app.json` — `app` TypeScript config
- `packages/core/src/types.ts` and `packages/core/dist/types.d.ts` — compare current source types versus stale generated declarations (notably `ColorTheme` including `"factory"`)
- `packages/dashboard/app/components/ListView.tsx` — `onCreateTask` prop type currently too narrow for `TaskCreateInput`
- `packages/dashboard/app/components/ThemeSelector.tsx` and `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` — current `ColorTheme` usage and failing `"factory"` test typing
- `packages/dashboard/app/components/PlanningModeModal.tsx` and `packages/dashboard/app/components/PlanningModeModal.test.tsx` — current narrowed-state and `MergeResult` typing issues
- `packages/dashboard/app/components/TerminalModal.tsx` — `FitAddon` typing issue in keyboard-zoom handlers
- `packages/dashboard/app/hooks/useFileEditor.ts` — nullable `filePath` narrowing issue
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` and `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — DOM query typings currently failing app typecheck

## File Scope

- `packages/dashboard/app/hooks/useTerminal.test.ts`
- `packages/dashboard/app/hooks/__tests__/useTerminal.test.tsx`
- `packages/dashboard/src/__tests__/typecheck.test.ts`
- `packages/dashboard/tsconfig.json`
- `packages/dashboard/tsconfig.app.json`
- `packages/dashboard/app/components/ListView.tsx`
- `packages/dashboard/app/components/ThemeSelector.tsx`
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx`
- `packages/dashboard/app/components/PlanningModeModal.tsx`
- `packages/dashboard/app/components/PlanningModeModal.test.tsx`
- `packages/dashboard/app/components/TerminalModal.tsx`
- `packages/dashboard/app/hooks/useFileEditor.ts`
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx`
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx`
- `packages/dashboard/app/components/__tests__/TerminalModal.test.tsx`
- `packages/dashboard/src/routes.test.ts` (only if a targeted rerun proves the refine-route coverage itself is stale)
- `packages/dashboard/src/routes.ts` (only if a targeted rerun proves the existing `/tasks/:id/refine` handler is actually wrong)
- `packages/dashboard/README.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Restore active terminal/refine/typecheck regression coverage

- [ ] `packages/dashboard/app/hooks/__tests__/useTerminal.test.tsx` is no longer a skipped relic of the removed command-history terminal API; either rewrite it against the current `useTerminal(sessionId)` WebSocket contract or remove it after moving any still-relevant assertions into `packages/dashboard/app/hooks/useTerminal.test.ts`
- [ ] `packages/dashboard/app/hooks/useTerminal.test.ts` actively covers the current hook behavior that should remain protected: connection state changes, `sendInput`, `resize`, callback registration/unsubscription, and close/reconnect handling as applicable
- [ ] `packages/dashboard/src/__tests__/typecheck.test.ts` is updated to reflect the real dashboard typecheck gate (`cd packages/dashboard && pnpm typecheck`, or the exact pair of `tsc` invocations behind it) rather than the stale `src`-only smoke check, but its required passing run is deferred to Step 2 after the known dashboard type errors are fixed
- [ ] `packages/dashboard/src/routes.test.ts` refine-route block is explicitly rerun and remains green; do not change `packages/dashboard/src/routes.ts` unless that targeted rerun proves a real regression in the existing `/tasks/:id/refine` handler
- [ ] Run targeted tests for changed files. If `packages/dashboard/app/hooks/__tests__/useTerminal.test.tsx` is retained, include it in `cd packages/dashboard && pnpm test -- --run src/routes.test.ts app/hooks/useTerminal.test.ts app/hooks/__tests__/useTerminal.test.tsx`; if its useful coverage is migrated and the file is removed, run the same command without that path

**Artifacts:**
- `packages/dashboard/app/hooks/useTerminal.test.ts` (modified)
- `packages/dashboard/app/hooks/__tests__/useTerminal.test.tsx` (modified or removed)
- `packages/dashboard/src/__tests__/typecheck.test.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified only if investigation proves the refine-route test itself is stale)
- `packages/dashboard/src/routes.ts` (modified only if investigation proves the current refine route is actually wrong)

### Step 2: Fix the remaining non-KB-096 dashboard typecheck failures

- [ ] Dashboard type resolution no longer depends on hand-edited generated declarations in `packages/core/dist/*`; if `@kb/core` source-vs-dist drift is part of the failure, fix it durably through dashboard TypeScript configuration or another source-controlled approach that keeps local verification reliable
- [ ] Resolve the current app/typecheck errors in the dashboard-owned files surfaced by `cd packages/dashboard && pnpm typecheck`, including the `TaskCreateInput` mismatch in `ListView.tsx`, `ColorTheme`/`"factory"` typing in `ThemeSelector.tsx` and its test, narrowed-state issues in `PlanningModeModal.tsx`, missing `FitAddon` typing in `TerminalModal.tsx`, nullable `filePath` handling in `useFileEditor.ts`, and DOM query typing in `ModelSelectorTab.test.tsx` and `QuickEntryBox.test.tsx`
- [ ] `packages/dashboard/src/__tests__/typecheck.test.ts` is fully reactivated in this step and passes against the real dashboard typecheck command after the Step 2 fixes land
- [ ] `packages/dashboard/app/components/PlanningModeModal.test.tsx` uses a complete `MergeResult` shape consistent with `@kb/core`, rather than partial objects that only passed because the app typecheck gate was not enforced
- [ ] Keep KB-096-owned usage-indicator header work out of scope; after KB-096 is present, no remaining non-usage-indicator type errors should block `cd packages/dashboard && pnpm typecheck`
- [ ] Run targeted verification for the changed files, including `cd packages/dashboard && pnpm typecheck` and `cd packages/dashboard && pnpm test -- --run src/__tests__/typecheck.test.ts app/components/__tests__/ModelSelectorTab.test.tsx app/components/__tests__/QuickEntryBox.test.tsx app/components/__tests__/ThemeSelector.test.tsx app/components/PlanningModeModal.test.tsx app/components/__tests__/TerminalModal.test.tsx`

**Artifacts:**
- `packages/dashboard/tsconfig.json` (modified if needed)
- `packages/dashboard/tsconfig.app.json` (modified if needed)
- `packages/dashboard/app/components/ListView.tsx` (modified)
- `packages/dashboard/app/components/ThemeSelector.tsx` (modified)
- `packages/dashboard/app/components/__tests__/ThemeSelector.test.tsx` (modified)
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (modified)
- `packages/dashboard/app/components/TerminalModal.tsx` (modified)
- `packages/dashboard/app/hooks/useFileEditor.ts` (modified)
- `packages/dashboard/app/components/__tests__/ModelSelectorTab.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/TerminalModal.test.tsx` (modified only if needed to match a legitimate `TerminalModal.tsx` typing/runtime fix)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Confirm Step 0 is satisfied before final verification; do not start this section until KB-096 has landed
- [ ] Run `cd packages/dashboard && pnpm test`
- [ ] Run `cd packages/dashboard && pnpm typecheck`
- [ ] Run `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] Add a short contributor-facing verification note to `packages/dashboard/README.md` stating that dashboard changes must keep both `cd packages/dashboard && pnpm test` and `cd packages/dashboard && pnpm typecheck` green, that the terminal/typecheck regression suites are intentionally active, and correct any stale theme-count wording if the README still claims fewer palettes than the current `ThemeSelector` exposes
- [ ] Do **not** add a changeset unless the final implementation unexpectedly touches the published `@dustinbyrne/kb` package
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — add or refresh the dashboard contributor verification section so it explicitly calls out the local `pnpm test` and `pnpm typecheck` gates restored by this task, and fix the stale color-theme count if the document still says there are only 8 palettes

**Check If Affected:**
- `README.md` — update only if workspace-level contributor instructions should mention the restored dashboard verification expectations

## Completion Criteria

- [ ] All steps complete
- [ ] `packages/dashboard/app/hooks/__tests__/useTerminal.test.tsx` is either active against the current hook contract or removed after its useful coverage is absorbed into active tests
- [ ] `packages/dashboard/src/__tests__/typecheck.test.ts` runs and passes instead of being skipped
- [ ] `packages/dashboard/src/routes.test.ts` refine-route coverage remains active and green without recreating already-implemented route work
- [ ] `cd packages/dashboard && pnpm test` passes with no skipped legacy terminal/typecheck regression suite left behind by this task
- [ ] `cd packages/dashboard && pnpm typecheck` passes once the Step 0 KB-096 prerequisite is satisfied
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-139): complete Step N — description`
- **Bug fixes:** `fix(KB-139): description`
- **Tests:** `test(KB-139): description`

## Do NOT

- Expand task scope
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Recreate a brand-new `/tasks/:id/refine` route from stale assumptions if the current `packages/dashboard/src/routes.ts` handler already satisfies the active tests
- Reintroduce the old command-style terminal hook API (`executeCommand`, `setInput`, `navigateHistory`, `currentDirectory`, etc.) just to satisfy stale skipped tests
- Hand-edit `packages/core/dist/*` as the lasting fix for dashboard type resolution
- Absorb KB-096 usage-indicator button work into this task
- Weaken verification by leaving `describe.skip(...)` in the terminal/typecheck regression suites or by excluding failing dashboard files from TypeScript without replacing the lost coverage
