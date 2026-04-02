# Task: KB-292 - Add Ability to Run Quick Scripts

**Created:** 2026-03-31
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a well-scoped feature addition with minimal blast radius. It adds a new CLI subcommand and settings field following established patterns in the codebase. No existing functionality is modified.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 1, Reversibility: 0

## Mission

Add a "quick scripts" feature that allows users to define named shell commands in their kb project settings and execute them via a simple CLI command. This enables quick access to common project commands (like `npm build`, `pnpm test`) without leaving the kb workflow.

Example usage:
```bash
fn script add build "pnpm build"
fn script add test "pnpm test"
fn script list
fn run build
```

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Settings type definitions (see `ProjectSettings`, `DEFAULT_PROJECT_SETTINGS`)
- `packages/cli/src/commands/settings.ts` — CLI settings command implementation pattern
- `packages/cli/src/commands/git.ts` — Example of a CLI command module with exec patterns
- `packages/cli/src/bin.ts` — CLI routing and help text
- `packages/cli/src/extension.ts` — Extension tools (for reference on tool patterns, though this task doesn't modify it)

## File Scope

- `packages/core/src/types.ts` — Add `scripts` field to `ProjectSettings` interface
- `packages/cli/src/commands/script.ts` — New file: script management and execution commands
- `packages/cli/src/bin.ts` — Add `fn script` and `fn run` command routing
- `packages/cli/src/__tests__/script.test.ts` — New file: tests for script commands

## Steps

### Step 1: Add Scripts Type to ProjectSettings

- [ ] Add `scripts?: Record<string, string>` field to `ProjectSettings` interface in `packages/core/src/types.ts`
- [ ] Update `DEFAULT_PROJECT_SETTINGS` to include empty scripts object `{}`
- [ ] Verify type compilation passes (`pnpm typecheck`)

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Create Script Command Module

- [ ] Create `packages/cli/src/commands/script.ts` with the following exports:
  - `runScriptList()` — List all defined scripts with names and commands
  - `runScriptAdd(name: string, command: string)` — Add a new script
  - `runScriptRemove(name: string)` — Remove a script by name
  - `runScriptRun(name: string, extraArgs?: string[])` — Execute a script, optionally with extra arguments appended
- [ ] Scripts are stored in project settings (`.fusion/config.json`) via `TaskStore.updateSettings()`
- [ ] Script execution uses `execSync` with `stdio: 'inherit'` to stream output to the terminal
- [ ] Handle edge cases: script not found, empty scripts, invalid script names
- [ ] Script names must be valid: alphanumeric plus hyphen/underscore only, no spaces

**Artifacts:**
- `packages/cli/src/commands/script.ts` (new)

### Step 3: Add CLI Routing

- [ ] Import script commands in `packages/cli/src/bin.ts`
- [ ] Add `fn script` subcommand with actions:
  - `fn script list` — Show all scripts
  - `fn script add <name> <command...>` — Add script (command can contain spaces, collect all remaining args)
  - `fn script remove <name>` — Remove script
- [ ] Add `fn run <name> [args...]` as shorthand for `fn script run` (follows npm run convention)
- [ ] Update `HELP` text to include new commands
- [ ] Handle unknown script names with helpful error showing available scripts

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `packages/cli/src/__tests__/script.test.ts` with tests for:
  - `runScriptAdd` — adds script to settings, validates name format, rejects duplicates
  - `runScriptRemove` — removes script, handles non-existent gracefully
  - `runScriptList` — shows scripts in formatted list, shows empty state message
  - `runScriptRun` — executes command, passes extra args, handles missing script
  - Script name validation — rejects invalid characters, reserved names
- [ ] Mock `execSync` to avoid actual command execution in tests
- [ ] Mock `TaskStore` to avoid filesystem side effects
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Create changeset file for the new feature (minor bump):
  ```bash
  cat > .changeset/add-quick-scripts.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add quick scripts feature for defining and running project commands via `fn script` and `fn run`
  EOF
  ```
- [ ] Verify changeset file is included in the task directory for review

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `fn script add|remove|list` commands work correctly
- [ ] `fn run <script>` executes the defined command in the terminal
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-292): complete Step N — description`
- **Bug fixes:** `fix(KB-292): description`
- **Tests:** `test(KB-292): description`

## Do NOT

- Modify the pi extension (`extension.ts`) — this is a CLI-only feature
- Add global-level scripts (project-only scope is sufficient)
- Create a script editor UI for the dashboard (CLI-only for now)
- Support async/long-running background scripts (synchronous only)
- Add script composition (scripts calling other scripts) — keep it simple
