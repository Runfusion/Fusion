# Task: KB-245 - Activity log shows error Unexpected response format expected

**Created:** 2026-03-31
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** This is a focused server routing fix. The SPA fallback catches API requests when errors occur, returning HTML instead of JSON. Low blast radius (only affects error response handling), straightforward pattern (Express error middleware), no security implications, fully reversible.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Fix the "Unexpected response format: expected JSON, got text/html" error that appears in the Activity Log modal. This happens when API routes fail to send a response and the SPA fallback route catches the request, returning the React app's index.html instead of a JSON error.

The fix requires adding proper Express error handling middleware to ensure all API errors return JSON responses, preventing them from falling through to the SPA fallback.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/dashboard/src/server.ts` — Express server setup, route mounting order, SPA fallback
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — API route definitions, especially activity log routes around line 3344
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Client API layer that throws the error (see `api()` function around line 18)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/ActivityLogModal.tsx` — Component displaying the error

## File Scope

- `/Users/eclipxe/Projects/kb/packages/dashboard/src/server.ts` — Add error handling middleware
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Add error handling to activity log routes (if needed)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Improve error message for users

## Steps

### Step 1: Add API Error Handling Middleware

- [ ] Add Express error handling middleware in `server.ts` that:
  - Catches all errors from `/api/*` routes
  - Returns JSON error responses (never falls through to SPA fallback)
  - Logs errors server-side for debugging
  - Handles both synchronous errors and async errors (rejected promises)
- [ ] Ensure the middleware is registered AFTER API routes but BEFORE the SPA fallback
- [ ] Test that API 404s return JSON `{ error: "Not found" }` instead of HTML
- [ ] Test that API 500s from route handlers return JSON instead of HTML

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/server.ts` (modified)

### Step 2: Improve User-Facing Error Messages

- [ ] Update the `api()` function in `app/api.ts` to provide clearer error messages:
  - When HTML is received (SPA fallback case): "Server returned an unexpected response. Please refresh and try again."
  - Keep technical details for debugging but make them secondary
- [ ] Ensure the ActivityLogModal displays user-friendly errors

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Run dashboard tests specifically: `pnpm -F @kb/dashboard test`
- [ ] All existing tests must pass
- [ ] Build passes: `pnpm build`

**Manual verification steps:**
- [ ] Start the dashboard: `pnpm -F @kb/dashboard start`
- [ ] Open the Activity Log modal
- [ ] Verify activity log loads correctly
- [ ] Simulate an error condition (e.g., temporarily break the route) and verify a JSON error is returned, not HTML

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (internal fix)
- [ ] Out-of-scope findings: If you discover other routes with similar issues, create new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None (internal bug fix)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Activity Log modal no longer shows "Unexpected response format: expected JSON, got text/html"
- [ ] API errors return JSON, not HTML

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-245): complete Step N — description`
- **Bug fixes:** `fix(KB-245): description`
- **Tests:** `test(KB-245): description`

## Do NOT

- Modify the SPA fallback route behavior for non-API routes
- Change the activity log data format or storage
- Add new API endpoints
- Modify core store functionality
