# Task: KB-610 - Fix Settings Save Failure

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Settings save involves multiple layers (UI form state, API routes, SQLite storage). The recent SQLite migration (KB-310) introduced new storage patterns that may have edge cases in config row initialization or concurrent writes.

**Score:** 5/8 — Blast radius: 1 (isolated to settings save flow), Pattern novelty: 1 (standard CRUD but with SQLite specifics), Security: 1 (no auth changes), Reversibility: 2 (settings are backed up in config.json).

## Mission

Fix the bug where users cannot save settings from the dashboard Settings modal. This involves diagnosing and fixing the root cause in either the frontend form state handling, API route processing, or SQLite storage layer. The fix must ensure settings are reliably persisted to both SQLite (primary) and the backup config.json file.

## Dependencies

- **None** — This is a standalone bug fix.

## Context to Read First

1. `packages/dashboard/app/components/SettingsModal.tsx` — The settings UI component with form state and save logic
2. `packages/dashboard/app/api.ts` — API client functions `updateSettings()` and `updateGlobalSettings()`
3. `packages/dashboard/src/routes.ts` — API routes for `PUT /api/settings` and `PUT /api/settings/global`
4. `packages/core/src/store.ts` — TaskStore methods `updateSettings()` and `updateGlobalSettings()`
5. `packages/core/src/db.ts` — SQLite database initialization and `config` table schema
6. `packages/core/src/global-settings.ts` — GlobalSettingsStore for `~/.pi/kb/settings.json`

## File Scope

- `packages/dashboard/app/components/SettingsModal.tsx` (modify — improve form state handling and error reporting)
- `packages/dashboard/app/api.ts` (modify — add error handling/debugging if needed)
- `packages/core/src/store.ts` (modify — ensure settings update reliability)
- `packages/core/src/db.ts` (verify — ensure config row initialization is robust)
- `packages/core/src/global-settings.ts` (verify — ensure atomic writes work correctly)

## Steps

### Step 1: Diagnose Root Cause

- [ ] Run dashboard and attempt to reproduce the save failure
- [ ] Check browser console for JavaScript errors during save
- [ ] Check server logs for API errors (500, 400 responses)
- [ ] Verify SQLite config table has row with id=1
- [ ] Verify config.json backup file is created and updated
- [ ] Identify if failure is in: (a) frontend not sending request, (b) API rejecting request, or (c) storage not persisting

**Artifacts:**
- Diagnostic notes added to this task's agent.log

### Step 2: Implement Fix

Based on diagnosis from Step 1:

- [ ] If frontend issue: Fix form state initialization to ensure all settings fields are present
- [ ] If API issue: Fix route handler to properly process settings payloads
- [ ] If SQLite issue: Ensure `writeConfig` properly updates the config row and handles edge cases
- [ ] Add defensive checks: ensure config row exists before UPDATE, create if missing
- [ ] Add error logging at each layer (frontend toast, API response, store error)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)
- `packages/core/src/store.ts` (modified)
- Any other files as needed based on diagnosis

### Step 3: Add Tests

- [ ] Add test for settings save success case in SettingsModal.test.tsx
- [ ] Add test for settings save failure case (error handling)
- [ ] Add integration test for `store.updateSettings()` with SQLite
- [ ] Add integration test for `store.updateGlobalSettings()` with file system
- [ ] Run existing SettingsModal tests and ensure all pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (new tests added)
- `packages/core/src/store.test.ts` (new tests added)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — must build without errors
- [ ] Manual verification: Open Settings modal, change a setting, save, reload page, verify setting persisted
- [ ] Manual verification: Test both project settings (General section) and global settings (Model section)
- [ ] Verify config.json backup is created in `.fusion/config.json`
- [ ] Verify SQLite config row is updated (check with `sqlite3 .fusion/fusion.db "SELECT settings FROM config WHERE id=1"`)

### Step 5: Documentation & Delivery

- [ ] Add changeset file: `.changeset/fix-settings-save.md` describing the fix
- [ ] Update AGENTS.md if the fix involves any architectural patterns worth documenting
- [ ] Create follow-up task if any technical debt was identified during diagnosis

**Artifacts:**
- `.changeset/fix-settings-save.md` (new)

## Documentation Requirements

**Must Update:**
- None — this is a bug fix, no behavior changes.

**Check If Affected:**
- `AGENTS.md` — If SQLite storage patterns were modified, document the fix for future reference.

## Completion Criteria

- [ ] Settings can be saved reliably from the dashboard
- [ ] All settings sections (General, Model, Scheduling, etc.) save correctly
- [ ] Error handling provides clear feedback to users when saves fail
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-610): complete Step 1 — diagnose settings save failure`
- **Bug fixes:** `fix(KB-610): [specific fix description]`
- **Tests:** `test(KB-610): add settings save tests`

## Do NOT

- Expand scope beyond fixing the settings save issue
- Skip manual verification — this is a critical user-facing feature
- Modify unrelated dashboard components
- Remove the config.json backup mechanism (it's required for backward compatibility)
