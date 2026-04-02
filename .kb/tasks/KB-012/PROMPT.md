# Task: KB-012 - Add CLI option to start dashboard with execution paused

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward CLI flag addition that wires through to an existing setting. Minimal blast radius, no new patterns, no security concerns, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a `--paused` CLI flag to `kb dashboard` that starts the web dashboard with the AI engine in a paused state. When paused, the scheduler and triage processor do not dispatch new work (no task triage, execution, or auto-merge), allowing the user to review the board before any automation begins. The user can unpause later from the web dashboard settings.

## Dependencies

- **None**

## Context to Read First

- `packages/cli/src/bin.ts` — CLI argument parsing and command routing
- `packages/cli/src/commands/dashboard.ts` — Dashboard command implementation with `runDashboard(port, opts)` function
- `packages/cli/src/commands/dashboard.test.ts` — Existing dashboard tests (for patterns)
- `packages/core/src/types.ts` — Settings interface with `enginePaused` field

## File Scope

- `packages/cli/src/bin.ts` (modified)
- `packages/cli/src/commands/dashboard.ts` (modified)
- `packages/cli/src/commands/dashboard.test.ts` (modified)
- `.changeset/add-dashboard-paused-flag.md` (new)

## Steps

### Step 1: Add paused option to runDashboard function

- [ ] Add `paused?: boolean` to the `runDashboard` function options parameter
- [ ] If `paused` is true, call `await store.updateSettings({ enginePaused: true })` after store initialization but before starting the engine
- [ ] Console log a message when starting in paused mode: `[engine] Starting in paused mode — automation disabled`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 2: Add --paused flag to CLI argument parsing

- [ ] Add `--paused` flag detection in the `dashboard` case of `bin.ts`
- [ ] Pass the `paused` option to `runDashboard()` call
- [ ] Update the HELP text to document the new flag
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test in `dashboard.test.ts` verifying that `store.updateSettings({ enginePaused: true })` is called when `paused: true` is passed
- [ ] Add test verifying that `enginePaused` is NOT set when flag is absent
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/cli/src/commands/dashboard.test.ts` (modified)

### Step 4: Documentation & Delivery

- [ ] Create changeset file: `.changeset/add-dashboard-paused-flag.md` with patch bump
- [ ] Update CLI README or help if there's a separate docs file mentioning dashboard options
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

**Artifacts:**
- `.changeset/add-dashboard-paused-flag.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — Add `--paused` to the dashboard command help text under Options

**Check If Affected:**
- `packages/cli/README.md` — Update if it documents dashboard command options

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-012): complete Step N — description`
- **Bug fixes:** `fix(KB-012): description`
- **Tests:** `test(KB-012): description`

## Do NOT

- Modify the engine behavior (engine already supports enginePaused)
- Add globalPause option (out of scope — enginePaused is sufficient for this use case)
- Change the default behavior (dashboard starts unpaused by default)
- Skip tests
- Modify files outside the File Scope without good reason
