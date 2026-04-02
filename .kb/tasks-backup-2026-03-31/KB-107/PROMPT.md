# Task: KB-107 - Don't open the dashboard in a browser on startup

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple behavioral change with minimal blast radius. Removes auto-browser-opening default behavior.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Remove the automatic browser-opening behavior when starting the kb dashboard. Currently, the dashboard opens a browser window automatically on startup unless `--no-open` is passed. This change makes the default behavior to NOT open the browser, requiring users to manually navigate to the URL shown in the console output.

## Dependencies

- **None**

## Context to Read First

- `packages/cli/src/bin.ts` — CLI entry point where dashboard command arguments are parsed
- `packages/cli/src/commands/dashboard.ts` — Dashboard command implementation with `openBrowser()` function
- `packages/cli/src/extension.ts` — Pi extension that spawns dashboard with `--no-open` flag

## File Scope

- `packages/cli/src/bin.ts` (modify)
- `packages/cli/src/commands/dashboard.ts` (modify)
- `packages/cli/src/extension.ts` (modify)
- `packages/cli/src/commands/__tests__/dashboard.test.ts` (verify/update)
- `packages/cli/src/__tests__/build-exe.test.ts` (verify)

## Steps

### Step 1: Remove auto-open from CLI entry point

- [ ] In `packages/cli/src/bin.ts`, remove the `--no-open` flag parsing logic (line ~105)
- [ ] Change the `open` variable to always be `false` by default
- [ ] Remove `--no-open` from the dashboard command argument parsing
- [ ] Update the HELP text to remove the `--no-open` reference if present

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 2: Simplify dashboard command implementation

- [ ] In `packages/cli/src/commands/dashboard.ts`, remove the `openBrowser()` function (lines 9-14)
- [ ] Remove the `open` parameter from `runDashboard()` function signature options
- [ ] Remove the browser-opening logic at the end of the `listening` event handler (lines 507-508)
- [ ] Clean up any unused imports (e.g., `exec` from `node:child_process` if no longer used elsewhere)

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 3: Update pi extension

- [ ] In `packages/cli/src/extension.ts`, remove the `--no-open` argument from the dashboard spawn command (line ~869)

**Artifacts:**
- `packages/cli/src/extension.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to verify all tests pass
- [ ] Update any tests that explicitly test the `--no-open` flag or browser-opening behavior
- [ ] Verify `packages/cli/src/commands/__tests__/dashboard.test.ts` passes (may need to remove `open: false` from test calls since parameter will be removed)
- [ ] Verify `packages/cli/src/__tests__/build-exe.test.ts` passes (may need to remove `--no-open` from spawn args)
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update CLI help text to reflect the removal of `--no-open` flag
- [ ] Create changeset file for the behavioral change

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — Remove `--no-open` from HELP text if present

**Check If Affected:**
- `AGENTS.md` — Check if browser-opening behavior is documented
- `README.md` — Check if dashboard startup behavior is documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Dashboard no longer opens browser automatically on startup
- [ ] URL is still printed to console for manual navigation
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-107): complete Step N — description`
- **Bug fixes:** `fix(KB-107): description`
- **Tests:** `test(KB-107): description`

## Do NOT

- Expand task scope by adding new features (e.g., don't add an `--open` flag to opt-in)
- Skip tests
- Leave dead code (remove unused `openBrowser` function entirely)
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
