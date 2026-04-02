# Task: KB-021 - Add --dev CLI option for dashboard-only mode

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward CLI flag addition with minimal blast radius. The change is additive and reversible — it only adds a new code path that skips engine initialization.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Add a `--dev` CLI option to `kb dashboard` that launches only the web UI without starting the AI execution engine (TriageProcessor, TaskExecutor, Scheduler) or auto-merge queue. This enables development workflows where the dashboard runs standalone while the engine operates in a separate process.

## Dependencies

- **None**

## Context to Read First

- `packages/cli/src/bin.ts` — CLI entry point and argument parsing
- `packages/cli/src/commands/dashboard.ts` — Dashboard command implementation where engine components are started

## File Scope

- `packages/cli/src/bin.ts` — Add `--dev` argument parsing and pass to runDashboard
- `packages/cli/src/commands/dashboard.ts` — Conditionally skip engine initialization when dev mode is active
- `packages/cli/src/commands/dashboard.test.ts` — Add test coverage for --dev mode

## Steps

### Step 1: Add --dev argument parsing

- [ ] Add `--dev` flag detection in bin.ts dashboard command block
- [ ] Pass `dev: true` option to `runDashboard()` when flag is present
- [ ] Update HELP text to document the new `--dev` option

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 2: Implement dev mode in dashboard command

- [ ] Add `dev?: boolean` to `runDashboard` options parameter
- [ ] When `dev` is true, skip starting TriageProcessor, TaskExecutor, and Scheduler
- [ ] When `dev` is true, skip auto-merge queue setup and periodic retry timer
- [ ] When `dev` is true, skip startup sweeps (resume orphaned, merge sweep)
- [ ] Update console output to indicate "AI engine: ✗ disabled (dev mode)" instead of "AI engine: ✓ active"
- [ ] Keep all other functionality intact: TaskStore, server, auth, model registry, worktree pool, merge handler for UI

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test case in dashboard.test.ts verifying that --dev mode skips engine initialization
- [ ] Add test case verifying that TriageProcessor.start(), TaskExecutor, and Scheduler.start() are NOT called in dev mode
- [ ] Add test case verifying that the server still starts correctly in dev mode
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Create changeset file for the new CLI feature (minor bump for @dustinbyrne/kb)
- [ ] Update CLI README if it exists with the new --dev option

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `kb dashboard --dev` starts web UI without engine components
- [ ] `kb dashboard` (without --dev) continues to work exactly as before

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-021): complete Step N — description`
- **Bug fixes:** `fix(KB-021): description`
- **Tests:** `test(KB-021): description`

## Do NOT

- Remove or modify existing engine functionality
- Change default behavior of `kb dashboard` without --dev flag
- Skip tests or rely on manual verification
- Modify engine or dashboard packages directly (CLI only)
