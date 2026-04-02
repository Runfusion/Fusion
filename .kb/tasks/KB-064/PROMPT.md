# Task: KB-064 - Batch Issue Status Fetching for Performance

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves API changes (new batch endpoint), server-side batching logic, and frontend modifications to use batch fetching on initial load. It builds on the existing GitHub polling infrastructure but requires coordination between frontend and backend.
**Score:** 5/8 — Blast radius: 1 (localized to badge fetching), Pattern novelty: 1 (extends existing batching patterns), Security: 1 (GitHub API calls), Reversibility: 2 (easy to revert to individual fetches)

## Mission

Implement batch fetching for GitHub issue and PR badge statuses to reduce API calls when the dashboard loads with many issue-linked tasks. Currently each TaskCard triggers individual `/tasks/:id/issue/status` and `/tasks/:id/pr/status` requests when data is stale, causing N+1 API calls. This task adds a batch endpoint that fetches all badge statuses for visible tasks in a single GraphQL request.

## Dependencies

- **Task:** KB-022 (GitHub Badges on Task Cards) — Must be complete. This task provides the `prInfo`/`issueInfo` fields, individual status endpoints, and TaskCard badge display logic that this task will optimize.

## Context to Read First

- `packages/dashboard/src/routes.ts` — Existing individual `/tasks/:id/pr/status` and `/tasks/:id/issue/status` endpoints (lines ~1197-1300)
- `packages/dashboard/src/github.ts` — `getBadgeStatusesBatch()` method for GraphQL batching (lines ~700-800)
- `packages/dashboard/src/github-poll.ts` — `GitHubPollingService` with existing batching logic per repository
- `packages/dashboard/app/api.ts` — API client functions `fetchIssueStatus`, `fetchPrStatus`
- `packages/dashboard/app/components/TaskCard.tsx` — How cards trigger badge fetches via WebSocket subscription and stale checking
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts` — Badge WebSocket hook that manages per-task subscriptions

## File Scope

- `packages/dashboard/src/routes.ts` — Add new POST `/tasks/badges/batch` endpoint
- `packages/dashboard/src/github.ts` — No changes needed (existing `getBadgeStatusesBatch` works)
- `packages/dashboard/src/github-poll.ts` — Add helper to batch-fetch by task IDs
- `packages/dashboard/app/api.ts` — Add `fetchBatchBadgeStatuses` function
- `packages/dashboard/app/components/Board.tsx` — Add batch fetching on initial load and viewport changes
- `packages/dashboard/app/components/TaskCard.tsx` — Skip individual fetch when batch data is fresh
- `packages/dashboard/app/hooks/useBatchBadgeFetch.ts` — New hook for batch fetching

## Steps

### Step 1: Add Server-Side Batch Badge Endpoint

- [ ] Add POST `/api/tasks/badges/batch` route in `packages/dashboard/src/routes.ts`:
  - Request body: `{ taskIds: string[] }`
  - Response: `{ results: Record<string, { prInfo?: PrInfo; issueInfo?: IssueInfo; stale: boolean }> }`
  - For each task ID:
    - Look up task from store
    - Extract owner/repo from git remote or `GITHUB_REPOSITORY` env (reuse existing logic)
    - Group requests by repository
  - Use `GitHubClient.getBadgeStatusesBatch()` for each repository group
  - Apply rate limiting per repository via `githubRateLimiter`
  - Return combined results with freshness info
- [ ] Add input validation: max 50 task IDs per batch request
- [ ] Return 400 error for invalid task IDs or missing permissions

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Add GitHub Polling Service Helper for Task Batching

- [ ] Add `pollTasksByIds(taskIds: string[]): Promise<void>` method to `GitHubPollingService` in `packages/dashboard/src/github-poll.ts`:
  - Group watched tasks by repository (owner/repo)
  - Build batch requests for all PRs and issues in those tasks
  - Call existing `pollRepo()` for each repository
  - Skip tasks not in the watch list (not subscribed via WebSocket)
- [ ] Ensure method reuses existing rate limiting and change detection

**Artifacts:**
- `packages/dashboard/src/github-poll.ts` (modified)

### Step 3: Add Frontend Batch API Function

- [ ] Add `fetchBatchBadgeStatuses(taskIds: string[]): Promise<BatchBadgeResponse>` in `packages/dashboard/app/api.ts`:
  - Type definition for response:
    ```typescript
    interface BatchBadgeResponse {
      results: Record<string, {
        prInfo?: PrInfo;
        issueInfo?: IssueInfo;
        stale: boolean;
        error?: string;
      }>;
    }
    ```
  - POST to `/api/tasks/badges/batch`
  - Handle 429 rate limit errors with retry logic (exponential backoff, max 3 retries)
  - Handle partial failures (some tasks may error while others succeed)

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 4: Create Batch Fetch Hook

- [ ] Create `packages/dashboard/app/hooks/useBatchBadgeFetch.ts`:
  - Exports `useBatchBadgeFetch()` hook that returns:
    - `fetchBatch(taskIds: string[]): Promise<void>` — manual batch fetch
    - `isLoading: boolean` — loading state
    - `lastFetchTime: number | null` — timestamp of last successful fetch
  - Internally manages:
    - Request deduplication (don't refetch same IDs within 5 seconds)
    - Error state per task ID
    - Integration with `useBadgeWebSocket` store to update badge data
  - When batch response received:
    - Update `badgeWebSocketStore` with fresh data for each task
    - Preserve timestamps for freshness comparison

**Artifacts:**
- `packages/dashboard/app/hooks/useBatchBadgeFetch.ts` (new)

### Step 5: Add Batch Fetching to Board Component

- [ ] Modify `packages/dashboard/app/components/Board.tsx`:
  - Import `useBatchBadgeFetch` hook
  - On initial mount and when tasks change:
    - Collect all visible task IDs that have `prInfo` or `issueInfo`
    - Call `fetchBatch()` with collected IDs
    - Debounce the batch call (500ms) to handle rapid task list changes
  - On viewport changes (scroll, column expand/collapse):
    - Identify newly visible task cards with badge data
    - Batch fetch only the newly visible ones
- [ ] Ensure batch fetch doesn't block initial render (async, non-blocking)

**Artifacts:**
- `packages/dashboard/app/components/Board.tsx` (modified)

### Step 6: Update TaskCard to Skip Fetch When Batch Data is Fresh

- [ ] Modify `packages/dashboard/app/components/TaskCard.tsx`:
  - In the effect that subscribes to badges, check if `liveBadgeData` already has fresh data from batch
  - Only trigger individual status fetch if:
    - No WebSocket data AND no batch data exists
    - Data is explicitly marked stale AND older than 5 minutes
  - Ensure batch data timestamp is respected in `pickPreferredBadge()` (already implemented)

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `packages/dashboard/app/hooks/__tests__/useBatchBadgeFetch.test.tsx`:
  - Test batch fetch calls API with correct task IDs
  - Test request deduplication (same IDs within 5s = one call)
  - Test error handling for partial failures
  - Test 429 retry logic with exponential backoff
  - Test integration with badge WebSocket store
- [ ] Add server-side test for `/tasks/badges/batch` endpoint:
  - Test batch response format
  - Test max 50 task limit validation
  - Test rate limiting integration
  - Test grouping by repository
- [ ] Run `pnpm test` — fix all failures
- [ ] Run `pnpm build` — ensure build passes
- [ ] Manual verification:
    - Open dashboard with 20+ issue-linked tasks
    - Verify network tab shows single `/tasks/badges/batch` call instead of 20+ individual calls
    - Verify badges display correctly after batch fetch
    - Verify individual refresh buttons still work

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useBatchBadgeFetch.test.tsx` (new)
- Test files for batch endpoint (new or modified)

### Step 8: Documentation & Delivery

- [ ] Create changeset for the performance improvement:
  ```bash
  cat > .changeset/batch-badge-fetching.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Batch GitHub badge status fetching for improved dashboard performance with many issue-linked tasks. Reduces API calls from N individual requests to a single batch request on initial load.
  EOF
  ```
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Preemptive background batch fetching before cards become visible
  - Caching batch results across browser sessions
  - Adaptive batch sizing based on rate limit remaining

## Documentation Requirements

**Must Update:**
- None (performance improvement, no user-facing API changes)

**Check If Affected:**
- `AGENTS.md` — No changes needed (internal optimization)

## Completion Criteria

- [ ] Batch endpoint `/api/tasks/badges/batch` returns badge statuses for multiple tasks in single request
- [ ] Dashboard loads with single batch request instead of N individual requests
- [ ] WebSocket real-time updates continue to work alongside batch fetching
- [ ] Manual refresh buttons on individual badges still function
- [ ] Rate limiting properly applied to batch requests
- [ ] All tests passing
- [ ] Build passes
- [ ] Manual verification confirms reduced API calls in network tab

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-064): complete Step N — description`
- **Bug fixes:** `fix(KB-064): description`
- **Tests:** `test(KB-064): description`

## Do NOT

- Remove the existing individual status endpoints — batch is additive only
- Break WebSocket badge update functionality — batch and WebSocket coexist
- Fetch badge data for tasks without `prInfo` or `issueInfo`
- Exceed GitHub GraphQL query complexity limits (batch size limits protect this)
- Block initial render waiting for batch fetch — keep it async
- Skip rate limiting for batch requests — apply same limits per repository
