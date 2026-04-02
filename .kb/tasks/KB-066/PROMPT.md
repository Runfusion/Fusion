# Task: KB-066 - Batch GitHub Issue Import with Throttling

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This touches API routes and adds new throttling logic that affects external API interactions. Changes are moderate in scope but require careful handling of rate limits and retries.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Implement batched GitHub issue importing with intelligent throttling to prevent 429 "Too Many Requests" errors. Currently, importing multiple issues fires parallel requests that quickly exhaust the GitHub API rate limit (60/hour unauthenticated, 5000/hour authenticated). The solution adds a new batch import endpoint that processes issues sequentially with configurable delays and automatic retry logic for rate-limited requests.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Contains existing GitHub import endpoints (lines 1340-1450) and the `GitHubRateLimiter` class (lines 518-540)
- `packages/dashboard/src/github.ts` — `GitHubClient` class for GitHub API calls
- `packages/dashboard/app/api.ts` — Frontend API client with `apiImportGitHubIssue` function
- `packages/dashboard/src/routes.test.ts` — Existing tests for GitHub import endpoints (lines 1486+)
- `packages/dashboard/src/rate-limit.ts` — Reference for rate limiting patterns

## File Scope

- `packages/dashboard/src/routes.ts` — Add batch import endpoint and throttling logic
- `packages/dashboard/src/github.ts` — Add throttled request helper with retry logic
- `packages/dashboard/app/api.ts` — Add batch import API client function
- `packages/dashboard/src/routes.test.ts` — Add comprehensive tests for batch import

## Steps

### Step 1: Add Throttled Request Utility to GitHubClient

- [ ] Add `fetchThrottled()` method to `GitHubClient` that implements:
  - Configurable delay between requests (default 1000ms)
  - Exponential backoff on 429 responses (max 3 retries)
  - Respect `Retry-After` header if present
  - Return `{ success: boolean, data?: T, error?: string, retryAfter?: number }`
- [ ] Add `delay()` helper function in `github.ts`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/github.ts` (modified)

### Step 2: Implement Batch Import Endpoint

- [ ] Add `POST /api/github/issues/batch-import` endpoint in `routes.ts`:
  - Accept `{ owner: string, repo: string, issueNumbers: number[], delayMs?: number }`
  - Validate `issueNumbers` is array with 1-50 items
  - Process issues sequentially using throttled requests
  - Skip already-imported issues (check `description` for existing source URLs)
  - Return `{ results: Array<{ issueNumber: number, success: boolean, taskId?: string, error?: string, skipped?: boolean }> }`
- [ ] Add batch import rate limiting: max 1 batch request per 10 seconds per IP
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Add Frontend API Client Function

- [ ] Add `apiBatchImportGitHubIssues()` function in `api.ts`:
  - Accept `(owner: string, repo: string, issueNumbers: number[], delayMs?: number)`
  - Return `Promise<{ results: BatchImportResult[] }>`
  - Define `BatchImportResult` type
- [ ] Export the new type from `api.ts`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add comprehensive tests in `routes.test.ts`:
  - Batch import success case (multiple issues)
  - Rate limit handling (429 triggers retry with backoff)
  - Already-imported issues are skipped
  - Invalid input validation (empty array, >50 items)
  - Partial failure handling (some succeed, some fail)
  - Sequential processing verification (not parallel)
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 5: Documentation & Delivery

- [ ] Create changeset file: `.changeset/batch-github-import.md` (minor bump - new feature)
- [ ] Update any relevant code comments for the new endpoint
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if needed

**Artifacts:**
- `.changeset/batch-github-import.md` (new)

## Documentation Requirements

**Must Update:**
- None (inline code documentation sufficient)

**Check If Affected:**
- `AGENTS.md` — Check if API documentation needs updating

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `POST /api/github/issues/batch-import` endpoint working with throttling
- [ ] 429 errors are handled gracefully with retry logic
- [ ] Frontend API client supports batch import
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-066): complete Step N — description`
- **Bug fixes:** `fix(KB-066): description`
- **Tests:** `test(KB-066): description`

## Do NOT

- Remove or modify the existing single-issue import endpoint (keep backward compatibility)
- Use parallel processing for batch imports (must be sequential)
- Skip tests for the retry logic or error handling paths
- Hard-code GitHub API credentials or tokens
- Ignore the `Retry-After` header when GitHub sends it
