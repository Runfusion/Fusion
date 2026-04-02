# Task: KB-214 - Fix scheduled task dialog JSON parse error toast

**Created:** 2026-03-31
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** This is a focused frontend API error handling fix. Low blast radius (isolated to api.ts), well-known pattern (content-type checking), no security implications, and easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the "Unexpected token '<', "<!doctype "... is not valid JSON" toast error that appears when opening the Scheduled Tasks dialog. This occurs because the `api()` utility function in `packages/dashboard/app/api.ts` attempts to parse all HTTP responses as JSON without first checking the response content-type. When the server returns HTML (such as a 404 page, error page, or the SPA fallback), the JSON parsing fails with a cryptic error message.

The fix must improve error handling in the API layer to:
1. Check the response content-type before attempting JSON parsing
2. Return meaningful error messages when the server returns non-JSON responses
3. Preserve existing functionality for valid JSON responses

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/api.ts` — The API utility module where the bug exists (lines 14-25)
- `packages/dashboard/app/components/ScheduledTasksModal.tsx` — The component that triggers the error via `fetchAutomations()`

## File Scope

- `packages/dashboard/app/api.ts` — Modify the `api()` function to handle non-JSON responses
- `packages/dashboard/app/api.test.ts` — Create tests for the improved error handling (if file doesn't exist, create it)

## Steps

### Step 1: Fix API Error Handling

- [ ] Modify the `api()` function in `packages/dashboard/app/api.ts` to check response content-type before parsing JSON
- [ ] If response is not OK (non-2xx), read the response body as text first, then try to parse as JSON if content-type indicates JSON
- [ ] For non-JSON error responses, throw an error with the status text and a preview of the response body (truncated if too long)
- [ ] For JSON error responses, extract the `error` field as before
- [ ] Ensure successful JSON responses continue to work as before

**Implementation guidance:**
- Check `res.headers.get("content-type")` for `application/json`
- For non-2xx responses: read as text with `res.text()`, then attempt JSON parse only if content-type is JSON
- Error message format for non-JSON errors: `"Request failed: ${res.status} ${res.statusText}"` plus optionally `" (Response: ${textPreview}...)"` if text is available

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `packages/dashboard/app/api.test.ts` with tests for the `api()` function
- [ ] Test that JSON responses are parsed correctly (happy path)
- [ ] Test that non-JSON error responses throw meaningful errors
- [ ] Test that JSON error responses extract the error field correctly
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/api.test.ts` (new)

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation if error handling patterns are documented
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — this is a bug fix with no API changes

**Check If Affected:**
- `AGENTS.md` — Check if API error handling patterns are documented and update if relevant

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] The Scheduled Tasks dialog no longer shows the cryptic JSON parse error when the server returns HTML
- [ ] API errors show meaningful messages instead of raw JSON parse failures

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-214): complete Step N — description`
- **Bug fixes:** `fix(KB-214): description`
- **Tests:** `test(KB-214): description`

## Do NOT

- Expand task scope beyond fixing the API error handling
- Modify the ScheduledTasksModal component (the fix belongs in the API layer)
- Change the server-side automations routes
- Skip tests — this fix requires automated tests for the error handling paths
