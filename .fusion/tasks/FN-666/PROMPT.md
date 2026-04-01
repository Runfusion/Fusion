# Task: FN-666 - Fix Claude Usage Tracker Rate Limit Error

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a localized fix to add exponential backoff retry logic to the Claude usage API fetcher. Low blast radius - only affects the `fetchClaudeUsage()` function in `packages/dashboard/src/usage.ts`.

**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Implement retry logic with exponential backoff for the Claude usage tracker to gracefully handle rate limit (429) errors from the Anthropic API. When the API returns a 429 response, the system should automatically retry with increasing delays (1s, 2s, 4s) before giving up and displaying a user-friendly error message.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/usage.ts` — The Claude usage fetcher at lines 160-260 (`fetchClaudeUsage()` function)
- `packages/dashboard/src/usage.test.ts` — Existing tests for usage fetchers
- `packages/dashboard/src/rate-limit.ts` — Dashboard rate limiting (not the issue, but related context)

## File Scope

- `packages/dashboard/src/usage.ts` — Modify `fetchClaudeUsage()` to add retry logic
- `packages/dashboard/src/usage.test.ts` — Add tests for retry behavior

## Steps

### Step 1: Implement Retry Logic with Exponential Backoff

- [ ] Add `sleep()` helper function if not already present
- [ ] Wrap the Anthropic API request in a retry loop (max 3 attempts)
- [ ] On 429 response, wait with exponential backoff: 1s, 2s, 4s
- [ ] On other errors (401, 403, 5xx), fail immediately without retry
- [ ] If all retries exhausted, return rate limit error with helpful message
- [ ] Ensure retry delays don't block other provider fetches (parallel execution preserved)

**Artifacts:**
- `packages/dashboard/src/usage.ts` (modified)

### Step 2: Add Unit Tests for Retry Behavior

- [ ] Add test: "retries on 429 with exponential backoff"
- [ ] Add test: "succeeds on retry after initial 429"
- [ ] Add test: "fails after max retries exhausted"
- [ ] Add test: "does not retry on 401/403 auth errors"
- [ ] Add test: "does not retry on 5xx server errors"
- [ ] Verify all existing tests still pass

**Artifacts:**
- `packages/dashboard/src/usage.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` — all tests must pass
- [ ] Run `pnpm build` — must complete without errors
- [ ] Verify retry logic with simulated 429 responses

### Step 4: Documentation & Delivery

- [ ] Update inline comments in `usage.ts` explaining retry behavior
- [ ] Verify error message is user-friendly: "Rate limited by Anthropic API — retrying..." / "Rate limited — please try again in a few moments"

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Claude usage tracker gracefully handles rate limits with automatic retry

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-666): complete Step N — description`
- **Bug fixes:** `fix(FN-666): description`
- **Tests:** `test(FN-666): description`

## Do NOT

- Expand task scope to other providers (Codex, Gemini, etc.) — focus on Claude only
- Modify the rate limiter in `rate-limit.ts` — that's dashboard-side, not the issue
- Change the 30-second cache behavior
- Add retries for non-429 errors (auth errors should fail fast)
