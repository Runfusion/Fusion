# Task: KB-141 - Make workspace typecheck pass from a clean checkout

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task touches shared TypeScript and package configuration across multiple internal workspace packages, so mistakes can break contributor workflows broadly. The change is internal-only and reversible if it is backed by a clean-checkout regression test.
**Score:** 4/8 — Blast radius: 2, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Make `pnpm typecheck` a reliable workspace validation command from a clean checkout by removing the current dependency on ignored `packages/*/dist` artifacts and fixing the dashboard typing drift that currently surfaces in `packages/dashboard/src/routes.ts` when model override fields are forwarded to `TaskStore.createTask()`. The end state should let contributors clone the repo, install dependencies, run `pnpm typecheck`, and get a green result without first building internal packages or relying on stale declaration output left behind locally.

## Dependencies

- **None**

## Context to Read First

- `package.json`
- `.gitignore`
- `tsconfig.base.json`
- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/src/index.ts`
- `packages/core/src/types.ts`
- `packages/core/src/store.ts`
- `packages/engine/package.json`
- `packages/engine/tsconfig.json`
- `packages/engine/src/scheduler.ts`
- `packages/dashboard/package.json`
- `packages/dashboard/tsconfig.json`
- `packages/dashboard/tsconfig.app.json`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/planning.ts`
- `packages/dashboard/src/routes.test.ts`
- `packages/dashboard/src/__tests__/typecheck.test.ts`
- `packages/dashboard/app/api.ts`
- `packages/dashboard/app/App.tsx`
- `packages/dashboard/app/components/NewTaskModal.tsx`
- `packages/cli/package.json`
- `packages/cli/tsconfig.json`
- `packages/cli/src/commands/dashboard.ts`
- `README.md`
- `packages/dashboard/README.md`

## File Scope

- `package.json`
- `tsconfig.base.json`
- `tsconfig.json` (new, only if you adopt a root solution/project-reference entrypoint)
- `packages/core/package.json`
- `packages/core/tsconfig*.json`
- `packages/core/src/**/*.ts`
- `packages/engine/package.json`
- `packages/engine/tsconfig*.json`
- `packages/engine/src/**/*.ts`
- `packages/dashboard/package.json`
- `packages/dashboard/tsconfig*.json`
- `packages/dashboard/src/**/*.ts`
- `packages/dashboard/app/**/*.{ts,tsx}`
- `packages/cli/package.json`
- `packages/cli/tsconfig*.json`
- `packages/cli/src/**/*.ts`
- `README.md`
- `packages/dashboard/README.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Remove dist-dependent workspace type resolution

- [ ] Reproduce the failure both with the current local state and with any existing `packages/core/dist`, `packages/engine/dist`, `packages/dashboard/dist`, and `packages/cli/dist` directories temporarily moved out of the way so you are debugging the real clean-checkout problem, not a cached-artifact variant
- [ ] Update the workspace TypeScript/package configuration strategy so internal imports such as `@kb/core`, `@kb/engine`, and `@kb/dashboard` typecheck against current source/project references instead of requiring ignored `dist/*.d.ts` output during `pnpm typecheck`
- [ ] Ensure representative cross-package consumers still typecheck cleanly, including the dashboard server route in `packages/dashboard/src/routes.ts`, the dashboard planning server import of `@kb/engine` in `packages/dashboard/src/planning.ts`, the dashboard app consumers in `packages/dashboard/app/api.ts` and `packages/dashboard/app/components/NewTaskModal.tsx`, the engine import of `@kb/core` in `packages/engine/src/scheduler.ts`, and the CLI import path in `packages/cli/src/commands/dashboard.ts`
- [ ] If the source-based configuration exposes additional package-level issues, fix them in the same pass without weakening strictness or changing unrelated runtime behavior
- [ ] Run targeted tests for changed files

**Artifacts:**
- `package.json` (modified)
- `tsconfig.base.json` (modified)
- `tsconfig.json` (new or modified, if adopted)
- `packages/core/package.json` (modified, if needed)
- `packages/core/tsconfig*.json` (modified or new)
- `packages/core/src/**/*.ts` (modified, if needed)
- `packages/engine/package.json` (modified, if needed)
- `packages/engine/tsconfig*.json` (modified or new)
- `packages/engine/src/**/*.ts` (modified, if needed)
- `packages/dashboard/package.json` (modified, if needed)
- `packages/dashboard/tsconfig*.json` (modified or new)
- `packages/dashboard/src/**/*.ts` (modified, if needed)
- `packages/dashboard/app/**/*.{ts,tsx}` (modified, if needed)
- `packages/cli/package.json` (modified, if needed)
- `packages/cli/tsconfig*.json` (modified or new)
- `packages/cli/src/**/*.ts` (modified, if needed)

### Step 2: Add a clean-checkout typecheck regression test

- [ ] Replace the skipped smoke test in `packages/dashboard/src/__tests__/typecheck.test.ts` with an active regression that asserts the exact workspace command `pnpm typecheck` succeeds
- [ ] Make the regression simulate a clean checkout by ensuring local `packages/*/dist` directories do not satisfy workspace type resolution during the test run, and if your solution introduces build-mode metadata, neutralize any relevant `*.tsbuildinfo` artifacts too
- [ ] Keep the test deterministic and assertion-based: fail on non-zero exit, include stderr/stdout context in the assertion path, restore any moved artifacts in `finally`/teardown even on failure, and use a serialized or isolated mutation strategy so the test does not interfere with concurrent package tests
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/__tests__/typecheck.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] With local `packages/*/dist` outputs absent or moved aside, run `pnpm typecheck`
- [ ] Run `pnpm test`
- [ ] Fix all failures
- [ ] Run `pnpm build`
- [ ] Build passes

### Step 4: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `README.md` — add or update the development validation workflow so `pnpm typecheck` is documented as a supported root command that must pass from a clean checkout without committed `dist/` artifacts

**Check If Affected:**
- `packages/dashboard/README.md` — update if you add dashboard-specific typecheck/test workflow notes or change where contributors should run the regression

## Completion Criteria

- [ ] `pnpm typecheck` passes from a clean-checkout state without relying on pre-existing `packages/*/dist` output
- [ ] The dashboard task-creation route compiles against the current `TaskCreateInput` shape, including executor and validator model override fields
- [ ] Representative cross-package consumers of `@kb/core`, `@kb/engine`, and `@kb/dashboard` still typecheck cleanly after the workspace resolution change, including dashboard `src/` and `app/` entrypoints
- [ ] `packages/dashboard/src/__tests__/typecheck.test.ts` is active (not skipped) and covers the clean-checkout failure mode with real assertions
- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-141): complete Step N — description`
- **Bug fixes:** `fix(KB-141): description`
- **Tests:** `test(KB-141): description`

## Do NOT

- Expand task scope
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Rely on locally generated `packages/*/dist` output or commit generated `dist/` files
- Silence the problem with `any`, `@ts-ignore`, looser compiler flags, or broader `skipLibCheck` settings
- Change task creation/model override runtime behavior unless it is required to align the real source types with the existing tested API contract
- Create a changeset unless the implementation unexpectedly changes published `@dustinbyrne/kb` behavior
