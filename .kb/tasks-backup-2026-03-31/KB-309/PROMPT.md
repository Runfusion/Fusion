# Task: KB-309 - Fix Notification Settings Persistence

**Created:** 2026-03-31
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** The notification settings bug involves form state initialization and saving logic. The fix requires careful changes to SettingsModal.tsx to ensure `ntfyEnabled` and `ntfyTopic` are properly persisted to global settings. Pattern is familiar — similar to other checkbox settings in the modal.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Fix a bug where enabling ntfy.sh notifications in the dashboard Settings modal doesn't persist the `ntfyEnabled` setting. When users check the "Enable ntfy.sh notifications" checkbox and save, the setting should be written to `~/.pi/kb/settings.json` and persist across dashboard reloads.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/SettingsModal.tsx` — The settings UI component where the bug exists
- `packages/dashboard/app/api.ts` — API functions including `updateGlobalSettings` and `fetchSettings`
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Existing tests for notification settings
- `packages/core/src/types.ts` — `GlobalSettings` type definition showing `ntfyEnabled` and `ntfyTopic` are global settings
- `packages/core/src/global-settings.ts` — Global settings persistence layer

## File Scope

- `packages/dashboard/app/components/SettingsModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified)

## Steps

### Step 1: Diagnose Root Cause

- [ ] Verify the form state initialization for `ntfyEnabled` and `ntfyTopic` in SettingsModal.tsx
- [ ] Check that the save handler in the Notifications section correctly calls `updateGlobalSettings` with the notification fields
- [ ] Confirm the `GLOBAL_SETTINGS_KEYS` constant in `@kb/core` includes `ntfyEnabled` and `ntfyTopic`

**Artifacts:**
- Root cause identified (missing fields in form state or incorrect save path)

### Step 2: Fix Form State Initialization

- [ ] Ensure the `useState` form initialization properly sets `ntfyEnabled` and `ntfyTopic` from fetched settings
- [ ] Verify the `useEffect` that loads settings via `fetchSettings()` populates these fields in the form state
- [ ] Add default values for `ntfyEnabled: false` and `ntfyTopic: undefined` to the initial form state if missing

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified — form state handling)

### Step 3: Fix Save Handler

- [ ] Verify the `handleSave` function correctly routes `ntfyEnabled` and `ntfyTopic` to `updateGlobalSettings` when saving from the Notifications section
- [ ] The active section scope for Notifications is "global" — confirm these fields are in `GLOBAL_SETTINGS_KEYS`
- [ ] Test that the save payload includes both `ntfyEnabled` and `ntfyTopic` when changed

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified — save logic confirmed working)

### Step 4: Write Tests

- [ ] Add test verifying that `ntfyEnabled` persists when saving from Notifications section
- [ ] Add test verifying that `ntfyTopic` persists when saving with ntfy enabled
- [ ] Test that re-opening the modal shows the previously saved notification settings
- [ ] Test edge case: disabling ntfy also persists correctly

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (new tests added)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — must complete without errors
- [ ] Manually verify: Open Settings → Notifications → Enable ntfy → Save → Reload dashboard → Setting should still be enabled

### Step 6: Documentation & Delivery

- [ ] Update relevant documentation if settings behavior changed
- [ ] Create follow-up task if related issues found (e.g., KB-308 — test notification button issue)

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — No changes needed for this bug fix

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Notification setting persists after dashboard reload
- [ ] No regressions in other settings sections

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-309): complete Step N — description`
- **Bug fixes:** `fix(KB-309): description`
- **Tests:** `test(KB-309): description`

## Do NOT

- Expand scope to unrelated settings issues
- Skip writing tests for this specific fix
- Modify files outside File Scope without good reason
- Change the notification API endpoints (this is a UI persistence bug)
