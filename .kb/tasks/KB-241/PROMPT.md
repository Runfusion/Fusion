# Task: KB-241 - Fix test notification failing when ntfy not yet saved

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UX bug fix where the test notification button reads unsaved settings state instead of the current form values. The fix requires passing the current ntfy configuration in the request body rather than relying on stored settings. Low blast radius, simple pattern change.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the test notification feature so it uses the current form values (ntfyEnabled, ntfyTopic) rather than the saved settings. Currently, if a user enables ntfy in the settings form and clicks "Test notification" before saving, they get a 400 error because the backend reads from stored settings where ntfy is still disabled.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Lines ~311-350, the `/settings/test-ntfy` route handler
- `packages/dashboard/app/api.ts` — Lines ~219-223, the `testNtfyNotification()` function
- `packages/dashboard/app/components/SettingsModal.tsx` — Lines ~130-147, the `handleTestNotification` callback

## File Scope

- `packages/dashboard/src/routes.ts` — Modify route to accept ntfy config in request body
- `packages/dashboard/app/api.ts` — Modify function to accept and pass config parameter
- `packages/dashboard/app/components/SettingsModal.tsx` — Pass current form values to API call

## Steps

### Step 1: Backend Route Update

- [ ] Modify `POST /settings/test-ntfy` route in `routes.ts` to accept optional `ntfyEnabled` and `ntfyTopic` in request body
- [ ] When provided in body, use those values; when not provided, fall back to `store.getSettings()` (backward compatibility)
- [ ] Validation logic stays the same — check enabled status and topic format, return 400 if invalid
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Frontend API Client Update

- [ ] Update `testNtfyNotification()` in `api.ts` to accept an optional config object: `{ ntfyEnabled?: boolean; ntfyTopic?: string }`
- [ ] Pass the config in the POST request body
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 3: Settings Modal Update

- [ ] Update `handleTestNotification` in `SettingsModal.tsx` to pass `form.ntfyEnabled` and `form.ntfyTopic` to `testNtfyNotification()`
- [ ] Keep the existing client-side validation before making the call
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite (`pnpm test`)
- [ ] Fix all failures
- [ ] Build passes (`pnpm build`)
- [ ] Manual verification: Open settings, enable ntfy, enter topic, click "Test notification" WITHOUT saving first — should succeed

### Step 5: Documentation & Delivery

- [ ] No documentation updates required — this is a bug fix that makes the feature work as users expect
- [ ] Create changeset for the dashboard package (patch bump)

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] Test notification works when ntfy is enabled in form but not yet saved
- [ ] Test notification still works after settings are saved (backward compatibility)
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-241): complete Step N — description`
- **Bug fixes:** `fix(KB-241): description`
- **Tests:** `test(KB-241): description`

## Do NOT

- Remove the fallback to `store.getSettings()` — keep backward compatibility
- Add complex validation beyond what exists
- Modify the NtfyNotifier class or notification sending logic
- Change the error message format (keep user-friendly error messages)
