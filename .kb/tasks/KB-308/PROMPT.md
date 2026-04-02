# Task: KB-308 - Fix test notification failing after enabling ntfy without saving

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple bug fix in a single route handler. Low blast radius, no new patterns, no security implications, easily reversible.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Fix the test notification feature so it works immediately after enabling ntfy in the UI, without requiring the user to save settings first. Currently, when a user checks "Enable ntfy.sh notifications" and enters a topic, then clicks "Test notification" before hitting "Save", the API returns "ntfy notifications are not enabled" because the backend reads from stored settings instead of the values provided in the request body.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Lines 1155-1200 contain the `POST /api/settings/test-ntfy` route handler
- `packages/dashboard/app/api.ts` — The `testNtfyNotification()` function shows the frontend sends `{ ntfyEnabled, ntfyTopic }` in the request body
- `packages/dashboard/app/components/SettingsModal.tsx` — Lines ~130-170 show `handleTestNotification` passes current form values to the API

## File Scope

- `packages/dashboard/src/routes.ts` — Modify the `/settings/test-ntfy` route handler (lines ~1163-1198)

## Steps

### Step 1: Fix the test-ntfy route handler

- [ ] Read `ntfyEnabled` and `ntfyTopic` from `req.body` first
- [ ] Fall back to stored settings only if not provided in request body
- [ ] Validate using the merged values (request body takes precedence)
- [ ] Use the merged values when sending the test notification
- [ ] Write a test for the route handler covering:
  - Test succeeds when `ntfyEnabled: true` and valid topic are provided in request body (even if stored settings have `ntfyEnabled: false`)
  - Falls back to stored settings when request body values are not provided

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] Create changeset file for the bug fix (patch level)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if discovered

## Documentation Requirements

**Must Update:**
- None required for this bug fix

**Check If Affected:**
- `AGENTS.md` — Check if notification behavior documentation needs updating

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Test notification works immediately after enabling ntfy in UI (before saving)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-308): complete Step N — description`
- **Bug fixes:** `fix(KB-308): description`
- **Tests:** `test(KB-308): description`

## Do NOT

- Expand task scope beyond fixing the test notification endpoint
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
