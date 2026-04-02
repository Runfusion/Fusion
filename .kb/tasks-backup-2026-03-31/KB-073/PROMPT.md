# Task: KB-073 - Add Interactive Port Selection to Dashboard Startup

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UX enhancement adding interactive prompts to the dashboard command. Well-scoped change with clear boundaries — adds a flag to trigger interactive port selection. Low blast radius, follows existing patterns in the codebase.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add an `--interactive` flag to the `kb dashboard` command that prompts the user to specify a port number interactively, with the ability to press Enter to accept the default port (4040). This improves the developer experience when starting the dashboard by allowing runtime port configuration without command-line arguments.

## Dependencies

- **None**

## Context to Read First

- `packages/cli/src/bin.ts` — CLI entry point and argument parsing for dashboard command
- `packages/cli/src/commands/dashboard.ts` — Dashboard startup implementation

## File Scope

- `packages/cli/src/bin.ts` (modified) — add `--interactive` flag parsing
- `packages/cli/src/commands/dashboard.ts` (modified) — add interactive port prompt logic
- `packages/cli/src/commands/dashboard.test.ts` (modified) — add tests for interactive mode

## Steps

### Step 1: Add Interactive Flag to CLI Parser

- [ ] Add `--interactive` flag recognition in `bin.ts` dashboard command block
- [ ] Pass interactive flag to `runDashboard()` call
- [ ] Default port behavior unchanged when `--interactive` is not used

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 2: Implement Interactive Port Prompt

- [ ] Add `readline` import for interactive input in `dashboard.ts`
- [ ] Create `promptForPort()` helper function that:
  - Shows prompt: "Port [4040]: "
  - Accepts user input or empty line (Enter)
  - Validates input is a valid port number (1-65535)
  - Returns user input or default 4040
- [ ] Modify `runDashboard()` signature to accept `interactive?: boolean` option
- [ ] When `interactive` is true, await `promptForPort()` before starting server
- [ ] Gracefully handle SIGINT (Ctrl+C) during prompt

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add unit tests for `promptForPort()` covering:
  - Empty input returns default port 4040
  - Valid port number is accepted
  - Invalid port (0, 70000, "abc") shows error and re-prompts
  - Port 1 and 65535 are valid boundaries
- [ ] Verify existing dashboard tests still pass
- [ ] Run full test suite
- [ ] Manual test: `kb dashboard --interactive` and verify prompt appears

**Artifacts:**
- `packages/cli/src/commands/dashboard.test.ts` (modified)

### Step 4: Documentation & Delivery

- [ ] Update CLI help text in `bin.ts` to include `--interactive` flag
- [ ] Update `README.md` quick start section with new `--interactive` option example
- [ ] Create changeset file for the minor feature addition
- [ ] Out-of-scope findings: none expected

**Artifacts:**
- `packages/cli/src/bin.ts` (modified — help text)
- `README.md` (modified)
- `.changeset/add-interactive-port-prompt.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — add `--interactive` to HELP text in dashboard section
- `README.md` — add example: `kb dashboard --interactive` in the Quick Start section

**Check If Affected:**
- `packages/cli/README.md` — update if has separate command documentation

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Manual verification: running `kb dashboard --interactive` shows "Port [4040]: " prompt
- [ ] Documentation updated with new flag
- [ ] Changeset created for the feature

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-073): complete Step N — description`
- **Bug fixes:** `fix(KB-073): description`
- **Tests:** `test(KB-073): description`

Example commits:
- `feat(KB-073): add --interactive flag to CLI parser`
- `feat(KB-073): implement interactive port prompt with validation`
- `test(KB-073): add tests for promptForPort helper`
- `feat(KB-073): update help text and README for interactive mode`

## Do NOT

- Change default port behavior when `--interactive` is not used
- Remove or rename existing `--port` flag
- Add external dependencies (use Node.js built-in `readline` module)
- Modify the server startup logic beyond port selection
- Skip test coverage for input validation edge cases
