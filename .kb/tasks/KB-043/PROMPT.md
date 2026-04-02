# Task: KB-043 - Ensure tests pass and type check passes

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward fix task to resolve dependency installation issues and type errors. The changes are limited to package installation and type alignment with no architectural impact.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix all failing type checks and test failures in the kb workspace. The @kb/engine package has TypeScript errors due to missing type properties, and @kb/dashboard has a missing test dependency that prevents tests from running. This task ensures the codebase passes all quality gates before further development.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Settings and MergeResult type definitions (reference for what properties should exist)
- `packages/engine/src/merger.ts` — Lines 559, 618, 728, 838 where type errors occur
- `packages/engine/src/triage.ts` — Line 570 where type error occurs
- `packages/dashboard/package.json` — devDependencies list showing @testing-library/user-event
- `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` — Test file that imports user-event

## File Scope

- `packages/core/src/types.ts` (verify types are correct)
- `packages/dashboard/package.json` (may need dependency reinstallation trigger)
- `packages/dashboard/node_modules/@testing-library/user-event` (ensure installed)
- `packages/engine/node_modules/@kb/core` (ensure types are fresh)

## Steps

### Step 1: Install Missing Dependencies

The @testing-library/user-event package is listed in devDependencies but not present in node_modules.

- [ ] Run `pnpm install` from workspace root to install all missing dependencies
- [ ] Verify `@testing-library/user-event` exists in `packages/dashboard/node_modules/@testing-library/`
- [ ] Run dashboard tests to confirm import error is resolved: `pnpm --filter @kb/dashboard test`

**Artifacts:**
- `pnpm-lock.yaml` (modified if new packages installed)
- `packages/dashboard/node_modules/@testing-library/user-event` (new)

### Step 2: Fix Type Errors in Engine Package

The engine package has TypeScript errors because it's using properties that exist in the core types but aren't being recognized. The types ARE correct in core/src/types.ts (smartConflictResolution, requirePlanApproval, resolutionMethod, autoResolvedCount all exist). The issue is likely stale compiled types or a build order problem.

- [ ] Verify the Settings interface in `packages/core/src/types.ts` includes:
  - `smartConflictResolution?: boolean` (line ~130)
  - `requirePlanApproval?: boolean` (line ~140)
- [ ] Verify the MergeResult interface in `packages/core/src/types.ts` includes:
  - `resolutionMethod?: "ai" | "auto" | "mixed" | "theirs"` (line ~190)
  - `autoResolvedCount?: number` (line ~196)
- [ ] Run `pnpm --filter @kb/core build` to ensure types are compiled fresh
- [ ] Run `pnpm --filter @kb/engine typecheck` to verify errors are resolved
- [ ] If errors persist, check that engine's tsconfig.json properly references core types

**Artifacts:**
- `packages/core/dist/types.d.ts` (ensured fresh)
- `packages/engine/dist/` (ensured fresh build references)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full type check: `pnpm typecheck` — must pass with zero errors
- [ ] Run full test suite: `pnpm test` — all packages must pass
- [ ] Run build: `pnpm build` — must complete successfully
- [ ] Verify no regressions: Re-run typecheck and test to confirm stability

**Expected results:**
- Type check: 0 errors across all 4 workspace packages
- Tests: packages/core (115 tests), packages/engine (460 tests), packages/dashboard (653+ tests), packages/cli — all passing

### Step 4: Documentation & Delivery

- [ ] If any code changes were made, ensure they are committed
- [ ] Verify CI-style quality gates pass locally
- [ ] Out-of-scope findings (if any) created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — this is a fix task with no documentation changes required

**Check If Affected:**
- `AGENTS.md` — check if any build/test instructions need updating (unlikely)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (115 + 460 + 653+ = 1228+ tests)
- [ ] All type checks passing (0 errors)
- [ ] Build passes successfully
- [ ] No manual workarounds or skips applied

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-043): complete Step N — description`
- **Bug fixes:** `fix(KB-043): description`
- **Tests:** `test(KB-043): description`

Example commits:
- `fix(KB-043): install missing @testing-library/user-event dependency`
- `fix(KB-043): rebuild core types to resolve engine type errors`
- `test(KB-043): verify all tests and type checks pass`

## Do NOT

- Modify the type definitions in core/src/types.ts — they are already correct
- Modify merger.ts or triage.ts source code — the types already match
- Skip running the full test suite
- Apply workarounds like `// @ts-ignore` comments
- Commit without the KB-043 prefix
- Create a changeset — this is internal tooling fix, not user-facing
