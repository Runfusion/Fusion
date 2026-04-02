# Task: KB-201 - Add CLI commands for kb settings management

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves adding new CLI commands with proper validation, type conversion, and formatted output. It touches core settings management and requires careful handling of boolean/numeric type conversion. Medium blast radius (new feature, doesn't break existing code).
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add CLI commands for viewing and updating kb configuration settings. The dashboard provides GET /api/settings and PUT /api/settings endpoints for managing kb configuration, but CLI users have no equivalent access. This blocks headless configuration management in CI/CD and scripting scenarios.

Implement `kb settings` (view current settings) and `kb settings set <key> <value>` (update a setting) commands that use TaskStore's `getSettings()` and `updateSettings()` methods, following the same pattern as existing task commands.

## Dependencies

- **Task:** KB-182 (Dashboard vs CLI gap analysis - provides context on what's needed)

## Context to Read First

Read these files to understand the patterns and APIs:

1. **`packages/core/src/types.ts`** (lines 194-320) — Settings interface and DEFAULT_SETTINGS
2. **`packages/core/src/store.ts`** (lines 1-100) — TaskStore.getSettings() and updateSettings() methods
3. **`packages/cli/src/bin.ts`** — Command routing and help text structure
4. **`packages/cli/src/commands/task.ts`** — Command implementation pattern (getStore helper, console output formatting)
5. **`packages/cli/src/commands/task.test.ts`** — Test patterns using vitest with mocks

## File Scope

- **Create:** `packages/cli/src/commands/settings.ts` — New command implementations
- **Create:** `packages/cli/src/commands/settings.test.ts` — Unit tests
- **Modify:** `packages/cli/src/bin.ts` — Add "settings" command routing and help text

## Steps

### Step 1: Create settings command module

- [ ] Create `packages/cli/src/commands/settings.ts` with:
  - `getStore()` helper (same pattern as task.ts)
  - `runSettingsShow()` — displays all settings in formatted table
  - `runSettingsSet(key: string, value: string)` — validates and updates a setting
  - `VALID_SETTINGS` array listing all CLI-updatable setting keys
  - `parseValue(key: string, value: string)` helper for type conversion
- [ ] Format settings display as two-column table (key: value pairs)
- [ ] Include `githubTokenConfigured` as read-only indicator (shows as "(configured)" or "(not configured)")
- [ ] Handle type conversions:
  - **Boolean** (`autoResolveConflicts`, `smartConflictResolution`, `requirePlanApproval`, `ntfyEnabled`): accept "true"/"false" or "yes"/"no" (case-insensitive)
  - **Number** (`maxConcurrent`, `maxWorktrees`): parse as integers with validation (min 1, max 10 for concurrent, min 1 max 20 for worktrees)
  - **Enum** (`worktreeNaming`): validate against ["random", "task-id", "task-title"]
  - **String** (`taskPrefix`, `ntfyTopic`, `defaultModel`): pass through (trim whitespace)
- [ ] For `defaultModel`: split on "/" to set both `defaultProvider` and `defaultModelId` (e.g., "anthropic/claude-sonnet-4-5")
- [ ] Validate setting keys against allowed list, reject unknown keys with helpful error
- [ ] Provide clear error messages for invalid values with expected format

**Artifacts:**
- `packages/cli/src/commands/settings.ts` (new)

### Step 2: Add settings command routing to CLI

- [ ] Modify `packages/cli/src/bin.ts`:
  - Import `runSettingsShow` and `runSettingsSet` from `./commands/settings.js`
  - Add "settings" case to main switch statement
  - Handle subcommands: "set" with `kb settings set <key> <value>` signature
  - Add settings commands to HELP text with descriptions
  - Handle edge cases: missing key, missing value, unknown key
- [ ] Ensure command follows same error handling pattern (console.error + process.exit(1))

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 3: Implement unit tests

- [ ] Create `packages/cli/src/commands/settings.test.ts`:
  - Mock `@kb/core` TaskStore (same pattern as task.test.ts)
  - Mock console.log and console.error for output verification
  - Test `runSettingsShow()` displays settings in formatted output
  - Test `runSettingsSet()` with each setting type:
    - Boolean: "true", "false", "yes", "no"
    - Number: valid values, out of range, non-numeric
    - Enum: valid and invalid worktreeNaming values
    - String: taskPrefix, ntfyTopic
    - defaultModel: parsing provider/modelId split
  - Test validation errors for:
    - Unknown setting keys
    - Invalid boolean values
    - Out-of-range numbers
    - Missing required arguments
  - Test that `githubTokenConfigured` displays correctly when true/false

**Artifacts:**
- `packages/cli/src/commands/settings.test.ts` (new)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — must complete without errors
- [ ] Manual verification:
  - `kb settings` — shows current settings in table format
  - `kb settings set maxConcurrent 4` — updates setting
  - `kb settings set autoResolveConflicts true` — boolean conversion
  - `kb settings set worktreeNaming task-id` — enum validation
  - `kb settings set defaultModel anthropic/claude-sonnet-4-5` — provider/model split
  - `kb settings set unknownSetting value` — proper error

### Step 5: Documentation & Delivery

- [ ] Verify HELP text is accurate and complete
- [ ] Create changeset for the new feature:
  ```bash
  cat > .changeset/add-settings-cli-commands.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add CLI commands for settings management: `kb settings` and `kb settings set <key> <value>`.
  EOF
  ```
- [ ] Commit with: `feat(KB-201): complete settings CLI commands`

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — Add settings commands to HELP text:
  ```
  kb settings                          Show current kb configuration
  kb settings set <key> <value>        Update a configuration setting
  ```

**Check If Affected:**
- None (new feature, no existing docs to update)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Manual CLI verification successful
- [ ] Changeset created
- [ ] Documentation (HELP text) updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-201): complete Step N — description`
- **Bug fixes:** `fix(KB-201): description`
- **Tests:** `test(KB-201): description`

## Do NOT

- Modify files outside the File Scope without good reason
- Skip the test file creation — CLI commands require test coverage
- Expand scope to include new settings not listed in the acceptance criteria
- Change the dashboard API or TaskStore methods (use existing APIs only)
- Implement interactive prompts for settings (accept values as arguments only)
- Skip validation — all user input must be validated before calling updateSettings()
