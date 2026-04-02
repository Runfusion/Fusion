# Task: KB-101 - Add ntfy notification test button in settings

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a small UI/UX enhancement adding a test button to verify ntfy configuration works before saving. Pattern is straightforward (add API endpoint + UI button). No security concerns with sending test notifications to user's own configured topic.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a "Test notification" button to the Notifications section of the Settings modal. This allows users to verify their ntfy configuration (topic name and connectivity) before saving settings. The button should only be enabled when ntfy is enabled and a valid topic is entered. Clicking it sends a test notification via a new API endpoint.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/SettingsModal.tsx` — The settings modal component where the Notifications section is rendered (see `case "notifications"` in `renderSectionFields()`)
- `packages/dashboard/app/api.ts` — API client functions including `fetchSettings`, `updateSettings`, and patterns for creating new API functions
- `packages/dashboard/src/routes.ts` — Express routes including settings routes (`/settings`, `/settings`) and patterns for adding new API endpoints
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Test patterns for the settings modal
- `packages/engine/src/notifier.ts` — The `NtfyNotifier` class that handles ntfy notifications, for reference on how notifications are sent

## File Scope

- `packages/dashboard/src/routes.ts` — Add new POST `/settings/test-ntfy` endpoint
- `packages/dashboard/app/api.ts` — Add `testNtfyNotification()` API function
- `packages/dashboard/app/components/SettingsModal.tsx` — Add test button to notifications section
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` — Add tests for the new functionality

## Steps

### Step 1: Backend API Endpoint

- [ ] Add POST `/settings/test-ntfy` endpoint in `packages/dashboard/src/routes.ts`
- [ ] Endpoint reads current settings to get `ntfyTopic` and `ntfyEnabled`
- [ ] Returns 400 if ntfy is not enabled or topic is invalid/empty
- [ ] Sends test notification via ntfy.sh using the configured topic
- [ ] Returns `{ success: true }` on success, `{ error: string }` on failure
- [ ] Uses the same notification pattern as `NtfyNotifier.sendNotification()` (fetch to `https://ntfy.sh/{topic}`)
- [ ] Test notification message: "kb test notification — your notifications are working!"

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Frontend API Function

- [ ] Add `testNtfyNotification()` function in `packages/dashboard/app/api.ts`
- [ ] Returns `Promise<{ success: boolean }>`
- [ ] Follows same pattern as other API functions (uses `api()` helper)

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 3: SettingsModal UI

- [ ] In the notifications section (`case "notifications"`), add a "Test notification" button
- [ ] Button is only enabled when `ntfyEnabled` is true AND `ntfyTopic` is valid (matches regex `^[a-zA-Z0-9_-]{1,64}$`)
- [ ] Button shows loading state while sending
- [ ] On success, shows toast: "Test notification sent — check your ntfy app!"
- [ ] On error, shows toast with error message
- [ ] Button is placed below the topic input field, styled as a secondary button (`.btn.btn-sm`)

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "Test notification button is disabled when ntfy is disabled"
- [ ] Add test: "Test notification button is disabled when topic is invalid"
- [ ] Add test: "Test notification button is enabled when ntfy is enabled with valid topic"
- [ ] Add test: "Clicking test button calls testNtfyNotification API"
- [ ] Add test: "Success toast is shown when test notification succeeds"
- [ ] Add test: "Error toast is shown when test notification fails"
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` (modified)

### Step 5: Documentation & Delivery

- [ ] No documentation updates required (self-explanatory UI feature)
- [ ] Create changeset file for the dashboard package improvement:
  ```bash
  cat > .changeset/add-ntfy-test-button.md << 'EOF'
  ---
  "@kb/dashboard": patch
  ---

  Add "Test notification" button in Settings to verify ntfy configuration before saving.
  EOF
  ```
- [ ] Out-of-scope findings: None expected for this small feature

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] New test cases added for the test notification feature
- [ ] Build passes
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-101): complete Step N — description`
- **Bug fixes:** `fix(KB-101): description`
- **Tests:** `test(KB-101): description`

## Do NOT

- Expand task scope beyond the test notification button
- Skip tests for the new functionality
- Modify notification behavior outside of the test feature
- Change existing ntfy configuration logic
- Add unrelated UI improvements to the settings modal
