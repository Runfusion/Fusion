# Task: KB-154 - Add a test ntfy notification button in settings

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI enhancement adding a single test button with an API endpoint. The pattern is consistent with existing authentication actions in SettingsModal. Low blast radius, no security concerns, easily reversible.
**Score:** 3/8 — Blast radius: 0, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add a "Send Test Notification" button to the Notifications section of the Settings modal. This allows users to verify their ntfy.sh configuration is working before relying on it for actual task notifications. The button should only be active when ntfy is enabled and a topic is configured, and should provide clear feedback on success or failure.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/SettingsModal.tsx` — The settings modal UI with existing Notifications section
- `packages/dashboard/app/api.ts` — Frontend API client patterns (see auth/login/logout patterns)
- `packages/dashboard/src/routes.ts` — Backend route patterns (see auth routes for POST endpoint structure)
- `packages/engine/src/notifier.ts` — NtfyNotifier class for the notification sending logic

## File Scope

- `packages/dashboard/app/api.ts` — Add `sendTestNtfyNotification` API function
- `packages/dashboard/app/components/SettingsModal.tsx` — Add test button UI and handler
- `packages/dashboard/src/routes.ts` — Add POST /api/notifications/test endpoint

## Steps

### Step 1: Backend API Endpoint

- [ ] Add POST `/api/notifications/test` route in `packages/dashboard/src/routes.ts`
- [ ] Route reads current settings to get `ntfyEnabled` and `ntfyTopic`
- [ ] Returns 400 error if ntfy is not enabled or topic is not set
- [ ] Uses the `NtfyNotifier` send pattern to POST to `https://ntfy.sh/{topic}` with a test message
- [ ] Returns `{ success: true }` on successful HTTP response from ntfy.sh
- [ ] Returns 502 error if ntfy.sh returns non-2xx status
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Frontend API Client

- [ ] Add `sendTestNtfyNotification(): Promise<{ success: boolean }>` function to `packages/dashboard/app/api.ts`
- [ ] Follow existing pattern from `loginProvider` / `logoutProvider` functions
- [ ] POST to `/api/notifications/test`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 3: Settings Modal UI

- [ ] In `SettingsModal.tsx`, add a "Send Test Notification" button in the Notifications section
- [ ] Button is only visible when `form.ntfyEnabled` is true AND `form.ntfyTopic` is non-empty
- [ ] Button is disabled when topic validation fails (invalid format)
- [ ] Button shows "Sending…" state while request is in flight
- [ ] On success: `addToast("Test notification sent", "success")`
- [ ] On error: `addToast(err.message, "error")`
- [ ] Button styling matches existing "Login" / "Logout" buttons in Authentication section
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/components/SettingsModal.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite (`pnpm test`)
- [ ] Fix all failures
- [ ] Build passes (`pnpm build`)

### Step 5: Documentation & Delivery

- [ ] No documentation updates required — the feature is self-documenting via the UI
- [ ] Create changeset for the dashboard package (patch bump)

## Documentation Requirements

**Must Update:**
- None — feature is self-documenting

**Check If Affected:**
- None

## Completion Criteria

- [ ] POST `/api/notifications/test` endpoint implemented and working
- [ ] Frontend API client function added
- [ ] Test button visible in Notifications section when ntfy is configured
- [ ] Button sends test notification successfully
- [ ] Success/error feedback shown via toast
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-154): complete Step N — description`
- **Bug fixes:** `fix(KB-154): description`
- **Tests:** `test(KB-154): description`

## Do NOT

- Modify the `NtfyNotifier` class directly — replicate its sending pattern in the route
- Add complex retry logic — ntfy notifications are best-effort
- Store test notification state persistently
- Send actual task-like notifications (use a clear "Test from kb dashboard" message)
