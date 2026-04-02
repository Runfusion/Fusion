# Task: KB-624 - Add Settings Backup and Import/Export

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a medium-sized feature touching CLI, API, and dashboard UI with clear scope boundaries. The pattern is well-established in the codebase (following backup.ts and settings.ts patterns). Reversibility is high — imports can be undone by re-importing previous settings.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Add comprehensive settings import/export functionality to kb, allowing users to:
1. **Export** their current settings (global and/or project) to a JSON file for backup, migration, or sharing
2. **Import** settings from a JSON file to restore or apply a configuration

The existing database backup (`kb backup`) handles the SQLite database. This feature handles the human-readable configuration files: global settings (`~/.pi/kb/settings.json`) and project settings (`.fusion/config.json`).

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/global-settings.ts` — GlobalSettingsStore implementation
2. `packages/core/src/store.ts` — TaskStore settings methods (getSettings, updateSettings, updateGlobalSettings, getSettingsByScope)
3. `packages/core/src/backup.ts` — BackupManager pattern for reference on file operations
4. `packages/cli/src/commands/settings.ts` — Existing CLI settings commands
5. `packages/cli/src/commands/backup.ts` — CLI backup command pattern
6. `packages/dashboard/src/routes.ts` — API routes for settings (GET/PUT /settings, /settings/global, /settings/scopes)
7. `packages/dashboard/app/components/SettingsModal.tsx` — Settings UI for adding export/import buttons
8. `packages/dashboard/app/api.ts` — Frontend API functions for adding new endpoints

## File Scope

### Core Package
- `packages/core/src/settings-export.ts` (new)
- `packages/core/src/settings-export.test.ts` (new)
- `packages/core/src/index.ts` (modified — add exports)

### CLI Package
- `packages/cli/src/commands/settings-export.ts` (new)
- `packages/cli/src/commands/settings-import.ts` (new)
- `packages/cli/src/bin.ts` (modified — add commands)

### Dashboard Server
- `packages/dashboard/src/routes.ts` (modified — add API endpoints)

### Dashboard UI
- `packages/dashboard/app/api.ts` (modified — add API functions)
- `packages/dashboard/app/components/SettingsModal.tsx` (modified — add export/import UI)
- `packages/dashboard/app/components/SettingsModal.css` (modified — add styles if needed)

## Steps

### Step 1: Core Settings Export/Import Module

Create the core logic for settings export/import that both CLI and API will use.

- [ ] Create `packages/core/src/settings-export.ts` with:
  - `SettingsExportData` interface — structure for exported settings JSON
  - `exportSettings()` function — reads both global and project settings, returns exportable structure
  - `validateImportData()` function — validates imported JSON structure
  - `importSettings()` function — merges or replaces settings with validation
  - `generateExportFilename()` function — timestamped filename like `kb-settings-2026-03-31-120000.json`
  - Proper error handling for file operations and JSON parsing
- [ ] Create `packages/core/src/settings-export.test.ts` with tests for:
  - Exporting settings (both global and project)
  - Validating import data (valid, invalid, partial)
  - Importing settings (merge mode, replace mode)
  - Filename generation
  - Error cases (malformed JSON, file not found)
- [ ] Export new types and functions from `packages/core/src/index.ts`
- [ ] Run tests: `pnpm test --filter @fusion/core`

**Artifacts:**
- `packages/core/src/settings-export.ts` (new)
- `packages/core/src/settings-export.test.ts` (new)

### Step 2: CLI Commands

Add `kb settings export` and `kb settings import` commands.

- [ ] Create `packages/cli/src/commands/settings-export.ts`:
  - `runSettingsExport()` function
  - Support `--output` / `-o` flag for custom file path (optional, auto-generates if not provided)
  - Support `--scope` flag: `global`, `project`, or `both` (default: `both`)
  - Pretty-printed JSON output with 2-space indentation
  - Success confirmation with file path
- [ ] Create `packages/cli/src/commands/settings-import.ts`:
  - `runSettingsImport()` function
  - Require `file` argument (path to JSON file)
  - Support `--scope` flag: `global`, `project`, or `both` (default: `both`)
  - Support `--merge` flag (boolean, default: true) — merge vs replace
  - Validate imported data before applying
  - Show summary of what will be imported and ask for confirmation (unless `--yes` flag)
  - Success/error feedback
- [ ] Register commands in `packages/cli/src/bin.ts`:
  - Add `kb settings export` subcommand
  - Add `kb settings import` subcommand
  - Follow existing command patterns from `backup.ts`
- [ ] Run CLI tests: `pnpm test --filter @gsxdsm/fusion`

**Artifacts:**
- `packages/cli/src/commands/settings-export.ts` (new)
- `packages/cli/src/commands/settings-import.ts` (new)
- `packages/cli/src/bin.ts` (modified)

### Step 3: Dashboard API Endpoints

Add REST endpoints for settings export/import.

- [ ] Add to `packages/dashboard/src/routes.ts`:
  - `GET /api/settings/export` — returns settings as JSON (same format as CLI export)
    - Support `?scope=global|project|both` query param
    - Returns full export data structure
  - `POST /api/settings/import` — imports settings from request body
    - Support `scope` field in body: `global`, `project`, or `both`
    - Support `merge` field in body: boolean (default: true)
    - Validate incoming data before applying
    - Return success confirmation or validation errors
- [ ] Use existing `TaskStore` methods for reading/writing settings
- [ ] Reuse validation logic from `settings-export.ts`
- [ ] Return appropriate HTTP status codes (200, 400 for validation errors, 500 for server errors)
- [ ] Test endpoints manually or via integration tests

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 4: Dashboard UI

Add export/import buttons to the Settings modal.

- [ ] Add API functions to `packages/dashboard/app/api.ts`:
  - `exportSettings(scope?: 'global' | 'project' | 'both'): Promise<SettingsExportData>`
  - `importSettings(data: SettingsExportData, options?: { scope?: string; merge?: boolean }): Promise<{ success: boolean; imported: { global: number; project: number } }>`
- [ ] Add to `packages/dashboard/app/components/SettingsModal.tsx`:
  - "Export Settings" button in the modal footer (next to Save)
  - "Import Settings" button that opens a file picker
  - Export generates JSON and triggers browser download (`URL.createObjectURL` + anchor click)
  - Import reads selected file, shows preview/summary, confirms with user, then calls API
  - Show toast notifications for success/error
  - Handle file validation errors gracefully
- [ ] Ensure UI respects scope — when in global section, default to global export; when in project section, default to project
- [ ] Add appropriate CSS classes if needed (follow existing settings modal patterns)
- [ ] Run dashboard tests: `pnpm test --filter @fusion/dashboard`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all tests pass in:
  - `@fusion/core`
  - `@fusion/dashboard`
  - `@gsxdsm/fusion`
- [ ] Manual verification:
  - Export settings via CLI: `kb settings export` (both, global, project scopes)
  - Import settings via CLI: `kb settings import <file>` (with --merge and --replace)
  - Export via dashboard (download JSON)
  - Import via dashboard (upload JSON)
  - Verify settings are correctly applied after import
  - Verify validation rejects malformed JSON
- [ ] Build passes: `pnpm build`

### Step 6: Documentation & Delivery

- [ ] Create changeset for `@gsxdsm/fusion`:
  ```bash
  cat > .changeset/settings-import-export.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---

  Add settings import and export functionality. New CLI commands: `kb settings export` and `kb settings import`. Dashboard now has export/import buttons in the Settings modal.
  EOF
  ```
- [ ] Update relevant documentation (if there's a settings docs file)
- [ ] Verify all files in File Scope are modified as expected
- [ ] Ensure no stray console.log statements in production code

## Documentation Requirements

**Must Update:**
- Changeset as shown above

**Check If Affected:**
- Any settings documentation in docs/ folder (if it exists)
- CLI help text (auto-generated from command definitions)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] CLI commands work: `kb settings export`, `kb settings import`
- [ ] Dashboard export/import buttons work
- [ ] Changeset created
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-624): complete Step N — description`
- Example: `feat(KB-624): complete Step 1 — add core settings export/import module`
- **Bug fixes:** `fix(KB-624): description`
- **Tests:** `test(KB-624): description`

## Do NOT

- Expand task scope to include database backup changes (that's a separate system)
- Skip tests for the core module
- Modify the settings storage format (keep existing JSON structure)
- Support importing partial/malformed data without validation
- Allow importing from untrusted sources without user confirmation
- Change existing settings API endpoints (only add new ones)
