# Task: FN-673 - Fix Claude Usage Indicator Always Showing Rate Limited

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused bug fix in a single file with clear scope - fixing the Claude usage fetcher that's incorrectly showing rate limited status.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix the Claude usage indicator in the dashboard that is always displaying "Rate limited" status even when the user has valid credentials and is not actually rate limited. The issue is in the usage data fetching logic in `packages/dashboard/src/usage.ts`. The code incorrectly interprets API responses as rate limiting when the actual issue is likely related to an outdated beta header or changed API behavior.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/src/usage.ts` — The usage fetching implementation, specifically the `fetchClaudeUsage()` function starting around line 204
2. `packages/dashboard/src/usage.test.ts` — Existing tests for the usage module to understand expected behavior
3. `packages/dashboard/app/components/UsageIndicator.tsx` — Frontend component that displays usage data (for understanding the UI presentation)

## File Scope

- `packages/dashboard/src/usage.ts` (modify)
- `packages/dashboard/src/usage.test.ts` (modify - add/update tests)

## Steps

### Step 1: Diagnose and Fix Claude Usage Fetcher

- [ ] Read the `fetchClaudeUsage()` function in `usage.ts` to understand current implementation
- [ ] Identify the root cause: the `anthropic-beta: oauth-2025-04-20` header may be outdated or causing 429 responses
- [ ] Fix the issue by:
  - Removing the outdated `anthropic-beta` header from the Claude API request
  - OR updating it to a current valid header if required
  - OR improving error handling to better distinguish between actual rate limits (429) and auth/config errors
- [ ] Add retry logic with exponential backoff for transient 429 responses (max 3 retries, starting at 1s delay)
- [ ] Ensure the error message distinguishes between:
  - Actual rate limiting (HTTP 429 with retry-after)
  - Authentication errors (401/403)
  - Configuration/API errors (other status codes)

**Artifacts:**
- `packages/dashboard/src/usage.ts` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run existing usage tests: `pnpm test -- packages/dashboard/src/usage.test.ts`
- [ ] Add/update tests for Claude provider:
  - Test that 429 responses trigger retry logic (max 3 attempts)
  - Test that successful responses after retry are handled correctly
  - Test that 401/403 errors show appropriate auth messages (not rate limited)
  - Test that the beta header is no longer sent (or is updated)
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/src/usage.test.ts` (modified)

### Step 3: Documentation & Delivery

- [ ] Create changeset file for the fix (patch level)
- [ ] Verify no out-of-scope findings

**Artifacts:**
- `.changeset/fix-claude-usage-rate-limit.md` (new)

## Documentation Requirements

**Must Update:**
- None required for this bug fix

**Check If Affected:**
- None

## Completion Criteria

- [ ] Claude usage indicator correctly shows actual usage data when user has valid credentials
- [ ] Rate limiting only shows when actually rate limited (HTTP 429)
- [ ] Authentication errors show "Auth expired" message, not "Rate limited"
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-673): complete Step N — description`
- **Bug fixes:** `fix(FN-673): description`
- **Tests:** `test(FN-673): description`

## Do NOT

- Expand task scope to refactor other providers (Codex, Gemini, etc.) unless the same issue is found
- Change the API endpoint unless confirmed necessary
- Add new dependencies
- Skip tests
- Modify files outside the File Scope without good reason
