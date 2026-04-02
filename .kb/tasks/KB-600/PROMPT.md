# Task: KB-600 - Fix TypeScript Errors in executor.test.ts Mock Declarations

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a straightforward fix for variable shadowing in test mocks. No plan review needed — just remove duplicate declarations.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Fix TypeScript errors in `packages/engine/src/executor.test.ts` caused by duplicate `mockedGenerateWorktreeName` declarations. The variable is declared at the top level (line 44) and then re-declared inside a describe block (line 384), causing variable shadowing that TypeScript flags as an error.

## Dependencies

- **None**

## Context to Read First

1. `packages/engine/src/executor.test.ts` — Lines 40-50 for the top-level mock declarations
2. `packages/engine/src/executor.test.ts` — Lines 380-390 for the inner describe block duplicate declaration

## File Scope

- `packages/engine/src/executor.test.ts` — Remove duplicate mock declaration (line 384)

## Steps

### Step 1: Analyze the Issue

- [ ] Read lines 40-50 of executor.test.ts to see the top-level `mockedGenerateWorktreeName` declaration
- [ ] Read lines 380-390 of executor.test.ts to see the inner duplicate declaration inside the "TaskExecutor worktree naming" describe block
- [ ] Verify `mockedFindWorktreeUser` is only declared once (line 45) and used correctly

### Step 2: Fix the Shadowing Issue

- [ ] Remove the inner declaration: `const mockedGenerateWorktreeName = vi.mocked(generateWorktreeName);` at line 384
- [ ] Keep the `beforeEach` block that configures the mock (lines 387-396)
- [ ] Ensure all references to `mockedGenerateWorktreeName` in the describe block still work

**Artifacts:**
- `packages/engine/src/executor.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run engine package tests: `cd packages/engine && pnpm test`
- [ ] Run typecheck: `cd packages/engine && pnpm typecheck`
- [ ] Verify no TypeScript errors related to mock declarations
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (internal test fix)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any other issues discovered

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] TypeScript errors resolved
- [ ] No duplicate `mockedGenerateWorktreeName` declarations in executor.test.ts

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `fix(KB-600): remove duplicate mockedGenerateWorktreeName declaration`
- **Bug fixes:** `fix(KB-600): description`
- **Tests:** `test(KB-600): description`

## Do NOT

- Change any test logic or assertions
- Modify the mock behavior or return values
- Skip tests or rely on manual verification
- Remove the top-level declaration — only remove the inner duplicate
