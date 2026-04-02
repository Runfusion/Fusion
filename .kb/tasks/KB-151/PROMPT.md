# Task: KB-151 - Fix packaged binary tests failing due to pty.node load error

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task addresses the immediate build-exe test failures by making node-pty loading lazy. The fix is surgical — delaying the native module import until terminal features are actually used — which prevents the crash on `--help` and `task list` while preserving full dashboard terminal functionality.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Fix the failing `build-exe*.test.ts` tests by ensuring the Bun-compiled `kb` binary can run `--help`, `task list`, and start the dashboard without crashing due to eager `node-pty` native module loading. The root cause is that `packages/dashboard/src/terminal-service.ts` statically imports `node-pty` at the top level, which causes the native module loader to run during module initialization even when the dashboard (and thus terminal) code is only imported but not actually used.

The fix: convert the static `node-pty` import to a lazy/dynamic import that only executes when a terminal session is actually being created. This allows CLI commands that don't use the terminal to work without loading the native module.

## Dependencies

- **None**

## Context to Read First

- `packages/cli/src/__tests__/build-exe.test.ts` — tests that are failing
- `packages/cli/src/__tests__/build-exe-cross.test.ts` — cross-compilation tests also failing
- `packages/dashboard/src/terminal-service.ts` — where node-pty is imported
- `packages/dashboard/src/server.ts` — imports getTerminalService which triggers terminal-service load
- `packages/cli/src/bin.ts` — entry point that imports dashboard commands
- `packages/cli/src/commands/dashboard.ts` — imports createServer from dashboard

## File Scope

- `packages/dashboard/src/terminal-service.ts` (modify — convert to lazy import)
- `packages/dashboard/src/server.ts` (modify — ensure graceful terminal service init)
- `packages/cli/src/__tests__/build-exe.test.ts` (modify — verify tests pass)
- `packages/cli/src/__tests__/build-exe-cross.test.ts` (modify — verify tests pass)

## Steps

### Step 0: Preflight

- [ ] Required files exist and are readable
- [ ] Can reproduce the failure: `./packages/cli/dist/kb --help` exits with pty.node error
- [ ] Tests currently fail: `cd packages/cli && pnpm test -- src/__tests__/build-exe.test.ts`

### Step 1: Make node-pty import lazy in terminal-service.ts

- [ ] Replace the static `import * as pty from "node-pty"` with a dynamic import function
- [ ] Create a `getPtyModule()` async function that imports and caches the node-pty module
- [ ] Update `createSession()` to call `getPtyModule()` before using pty APIs
- [ ] Ensure the pty type definitions are preserved (use `typeof import("node-pty")` pattern)
- [ ] Keep all existing terminal functionality intact (resize, write, kill, etc.)
- [ ] Run targeted tests: `cd packages/dashboard && pnpm test -- src/terminal-service.test.ts`

**Artifacts:**
- `packages/dashboard/src/terminal-service.ts` (modified)

### Step 2: Ensure dashboard server handles lazy terminal initialization

- [ ] Review `packages/dashboard/src/server.ts` — the `getTerminalService()` call at startup should not eagerly load node-pty
- [ ] The terminal service instance should be creatable without loading node-pty
- [ ] Only when `createSession()` is called (via WebSocket) should node-pty actually load
- [ ] If needed, adjust server.ts to defer terminal service initialization
- [ ] Dashboard should start without errors even when node-pty native files aren't present

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified if needed)

### Step 3: Verify build-exe tests pass

- [ ] Build the executable: `cd packages/cli && bun run build.ts`
- [ ] Test `--help` works: `./dist/kb --help` should show help text, exit 0
- [ ] Test `task list` works: `./dist/kb task list` should work without crashing
- [ ] Test dashboard starts: `./dist/kb dashboard --no-open -p 0` should show "kb board" banner
- [ ] Run build-exe tests: `cd packages/cli && pnpm test -- src/__tests__/build-exe.test.ts`
- [ ] All 6 tests in build-exe.test.ts should pass
- [ ] Run build-exe-cross tests: `pnpm test -- src/__tests__/build-exe-cross.test.ts`
- [ ] All 12 tests in build-exe-cross.test.ts should pass

**Artifacts:**
- `packages/cli/src/__tests__/build-exe.test.ts` (tests passing)
- `packages/cli/src/__tests__/build-exe-cross.test.ts` (tests passing)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full CLI test suite: `cd packages/cli && pnpm test`
- [ ] Run dashboard test suite: `cd packages/dashboard && pnpm test`
- [ ] Run workspace test suite: `pnpm test`
- [ ] Fix any failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Add a patch changeset for `@dustinbyrne/kb` describing the fix
- [ ] Update `packages/cli/STANDALONE.md` if it mentions terminal/native module limitations
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (e.g., if terminal sessions themselves don't work in the binary, that's a separate issue)

## Documentation Requirements

**Must Update:**
- `.changeset/fix-pty-loading.md` — patch changeset describing the lazy loading fix

**Check If Affected:**
- `packages/cli/STANDALONE.md` — update if it mentions terminal limitations in standalone binaries

## Completion Criteria

- [ ] All steps complete
- [ ] `build-exe.test.ts` and `build-exe-cross.test.ts` tests pass
- [ ] `./dist/kb --help` works without pty.node errors
- [ ] `./dist/kb task list` works without pty.node errors
- [ ] `./dist/kb dashboard --no-open` starts without pty.node errors
- [ ] Dashboard terminal WebSocket endpoint still works when running from source (not compiled)
- [ ] Changeset added

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-151): complete Step N — description`
- **Bug fixes:** `fix(KB-151): description`
- **Tests:** `test(KB-151): description`

## Do NOT

- Remove or disable dashboard terminal support
- Break existing terminal functionality when running from source (non-compiled)
- Hardcode absolute paths to node-pty prebuilds
- Modify the build.ts script's asset staging (that belongs to KB-140/KB-142)
- Skip tests or weaken test assertions
- Commit without the task ID prefix
