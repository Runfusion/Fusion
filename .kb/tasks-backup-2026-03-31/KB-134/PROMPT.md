# Task: KB-134 - Stabilize dashboard verification regressions

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task is bounded to dashboard tests and strict type-resolution, but it touches both the UI test harness and package/dependency-level TypeScript behavior. Review should confirm the fix keeps the verification gates strict without reopening broader terminal or dashboard refactors.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Stabilize the remaining dashboard verification regressions called out in KB-134 so workspace verification can run cleanly again. The current failures are concrete and already visible in the repo: `packages/dashboard/app/components/Header.test.tsx` still expects the old `kb` / `board` brand even though `Header.tsx` renders `Fusion` / `tasks`; `packages/dashboard/app/hooks/useTerminal.test.ts` is failing because its WebSocket mocking/setup no longer drives the current hook contract in Vitest/jsdom; and `packages/dashboard/src/__tests__/typecheck.test.ts` currently fails its strict `--skipLibCheck false` compiler run because dashboard source pulls in engine types from `src/planning.ts`, which in turn hit the unresolved optional MCP SDK import exposed by `@google/genai`. Fix these regressions without broadening into unrelated terminal runtime work, route work, or general dashboard cleanup.

## Dependencies

- **None**

## Context to Read First

- `package.json` — root workspace verification commands (`pnpm test`, `pnpm build`)
- `packages/dashboard/package.json` — dashboard-local `pnpm test` / `pnpm build` commands
- `packages/dashboard/app/components/Header.tsx` — current brand strings (`Fusion`, `tasks`)
- `packages/dashboard/app/components/Header.test.tsx` — stale legacy assertions that currently fail
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — already-updated reference coverage for the current Header behavior
- `packages/dashboard/app/hooks/useTerminal.ts` — current hook API and WebSocket lifecycle
- `packages/dashboard/app/hooks/useTerminal.test.ts` — failing hook tests and current mock strategy
- `packages/dashboard/vitest.setup.ts` — shared Vitest/jsdom environment setup
- `packages/dashboard/src/__tests__/typecheck.test.ts` — strict compiler regression guard
- `packages/dashboard/tsconfig.json` — `src`-only TypeScript scope used by the typecheck test
- `packages/dashboard/src/planning.ts` — dashboard source file that imports `createKbAgent` from `@kb/engine`
- `packages/engine/package.json` — ownership of upstream AI dependencies that may need the MCP SDK peer satisfied

## File Scope

- `packages/dashboard/app/components/Header.test.tsx`
- `packages/dashboard/app/hooks/useTerminal.test.ts`
- `packages/dashboard/app/hooks/useTerminal.ts`
- `packages/dashboard/vitest.setup.ts`
- `packages/dashboard/src/__tests__/typecheck.test.ts`
- `packages/dashboard/src/types/*`
- `packages/engine/package.json`
- `pnpm-lock.yaml`
- `packages/dashboard/README.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Refresh stale dashboard regression tests

- [ ] `packages/dashboard/app/components/Header.test.tsx` matches the current `Header.tsx` brand output (`Fusion` / `tasks`) instead of the obsolete `kb` / `board` expectation
- [ ] `packages/dashboard/app/hooks/useTerminal.test.ts` uses a deterministic WebSocket mock/stub strategy that actually intercepts the constructor used by `useTerminal()` in Vitest/jsdom and validates the current hook contract (`connectionStatus`, `sendInput`, `onData`, `onConnect`, `onExit`, `onScrollback`, `reconnect`)
- [ ] Only make a minimal `packages/dashboard/app/hooks/useTerminal.ts` implementation change if the failing test proves the runtime hook is actually wrong; do not fold in server/PTy/bootstrap work already tracked elsewhere
- [ ] Run targeted tests for the changed files: `cd packages/dashboard && pnpm test -- --run app/components/Header.test.tsx app/hooks/useTerminal.test.ts`

**Artifacts:**
- `packages/dashboard/app/components/Header.test.tsx` (modified)
- `packages/dashboard/app/hooks/useTerminal.test.ts` (modified)
- `packages/dashboard/app/hooks/useTerminal.ts` (modified, only if required)
- `packages/dashboard/vitest.setup.ts` (modified, only if shared WebSocket setup is the cleanest fix)

### Step 2: Repair the strict dashboard typecheck gate

- [ ] `packages/dashboard/src/__tests__/typecheck.test.ts` still enforces a real strict compiler run with `--skipLibCheck false`, but its invocation is workspace-consistent and deterministic for this repo
- [ ] The strict typecheck no longer fails on `Cannot find module '@modelcontextprotocol/sdk/client/index.js'` coming from the `@google/genai` types reachable through `@kb/engine` and `packages/dashboard/src/planning.ts`
- [ ] Use the smallest fix that preserves the strict gate: satisfy the missing peer where it belongs or add a local declaration shim under dashboard `src` that resolves the module cleanly; do **not** weaken the test by turning `skipLibCheck` back on or by deleting the assertion
- [ ] Run targeted tests for the changed files: `cd packages/dashboard && pnpm test -- --run src/__tests__/typecheck.test.ts`

**Artifacts:**
- `packages/dashboard/src/__tests__/typecheck.test.ts` (modified)
- `packages/dashboard/src/types/*` (new, if a local declaration shim is used)
- `packages/engine/package.json` (modified, if the peer dependency is fixed at the owning package)
- `pnpm-lock.yaml` (modified, if dependencies change)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] Record any contributor-facing verification or dependency note in `packages/dashboard/README.md` if the strict typecheck fix adds a new required dependency or local type shim
- [ ] Do **not** add a changeset unless the final implementation unexpectedly touches the published `@dustinbyrne/kb` package
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — add a short development note only if the chosen typecheck fix introduces a new dependency, shim, or contributor verification expectation

**Check If Affected:**
- `README.md` — update only if the workspace-level contributor verification instructions need to mention the stricter dashboard typecheck guard

## Completion Criteria

- [ ] `packages/dashboard/app/components/Header.test.tsx` passes against the current `Fusion` / `tasks` branding
- [ ] `packages/dashboard/app/hooks/useTerminal.test.ts` passes with a working WebSocket test harness and continues to cover connect/data/exit/scrollback behavior for the current hook API
- [ ] `packages/dashboard/src/__tests__/typecheck.test.ts` passes without weakening `--skipLibCheck false`
- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-134): complete Step N — description`
- **Bug fixes:** `fix(KB-134): description`
- **Tests:** `test(KB-134): description`

## Do NOT

- Expand task scope
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Reintroduce the old `kb` / `board` branding just to satisfy the legacy test
- Fold in `/api/terminal`, `TerminalModal`, server, or PTY bootstrap changes unless a minimal `useTerminal.ts` fix is strictly required by the failing hook tests
- Weaken the strict typecheck guard by restoring `skipLibCheck: true`, deleting the test, or converting it into a smoke test with no assertion
- Add a changeset for dashboard-only/internal verification work
- Use `pnpm --filter @kb/dashboard typecheck` as the success gate for this task; the required project quality gates are `pnpm test` and `pnpm build`
