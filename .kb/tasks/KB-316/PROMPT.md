# Task: KB-316 - Add dashboard server module tests

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This task adds comprehensive test coverage for 5 dashboard server modules. Changes are additive (only new test files) and reversible. Pattern novelty is low - following existing vitest patterns from the project.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Add comprehensive unit test coverage for the remaining dashboard server-side modules that currently lack tests. This includes the file service, GitHub polling service, rate limiting, terminal service, and usage tracking modules. The goal is to achieve high test coverage for server-side business logic while mocking external dependencies (filesystem, network, PTY).

## Dependencies

- **Task:** KB-301 (Improve test coverage) — Must be in-progress or complete. This task provides the testing infrastructure and patterns to follow.

## Context to Read First

### Existing Test Patterns (follow these)
- `packages/dashboard/src/__tests__/badge-pubsub.test.ts` — EventEmitter-based class testing, async/await patterns, env var mocking
- `packages/dashboard/src/__tests__/github-poll.test.ts` — Rate limiter testing with fake timers
- `packages/dashboard/src/__tests__/github-webhooks.test.ts` — Pure function testing, fetch mocking, crypto testing

### Source Files to Test
- `packages/dashboard/src/file-service.ts` — File browser operations, path validation, workspace-aware file functions
- `packages/dashboard/src/github-poll.ts` — GitHubPollingService class, watching/unwatching, polling logic
- `packages/dashboard/src/rate-limit.ts` — Express middleware, sliding window rate limiting
- `packages/dashboard/src/terminal-service.ts` — PTY session management, shell detection, security validation
- `packages/dashboard/src/usage.ts` — Provider usage fetching, caching, pace calculation

### Test Infrastructure
- `packages/dashboard/vitest.config.ts` — Test configuration
- `packages/dashboard/vitest.setup.ts` — Global mocks (localStorage, matchMedia, EventSource)

## File Scope

### New Test Files to Create
- `packages/dashboard/src/__tests__/file-service.test.ts`
- `packages/dashboard/src/__tests__/rate-limit.test.ts`
- `packages/dashboard/src/__tests__/terminal-service.test.ts`
- `packages/dashboard/src/__tests__/usage.test.ts`

### Existing Test Files to Extend
- `packages/dashboard/src/__tests__/github-poll.test.ts` — Add GitHubPollingService tests

## Steps

### Step 1: Preflight

- [ ] Verify KB-301 testing infrastructure is in place (vitest.config.ts, vitest.setup.ts)
- [ ] Run existing tests to ensure baseline passes: `cd packages/dashboard && pnpm test`
- [ ] Verify all source files compile without errors: `pnpm typecheck`

### Step 2: Add File Service Tests

Create comprehensive tests for `file-service.ts` covering:

- [ ] `FileServiceError` class - constructor sets code and name correctly
- [ ] `validatePath()` - path traversal protection (../, absolute paths, null bytes)
- [ ] `validatePath()` - valid relative paths resolve correctly
- [ ] `validatePath()` - URL-encoded characters handled safely
- [ ] `listFilesForBasePath()` - lists directory entries correctly (mock fs)
- [ ] `listFilesForBasePath()` - sorts directories first, then files alphabetically
- [ ] `listFilesForBasePath()` - hidden files filtered out
- [ ] `listFilesForBasePath()` - ENOENT throws FileServiceError
- [ ] `listFilesForBasePath()` - ENOTDIR throws FileServiceError
- [ ] `readFileForBasePath()` - reads file content with stats (mock fs)
- [ ] `readFileForBasePath()` - max file size limit enforced (1MB)
- [ ] `readFileForBasePath()` - ENOENT throws FileServiceError
- [ ] `writeFileForBasePath()` - writes content to file (mock fs)
- [ ] `writeFileForBasePath()` - prevents writing to directories
- [ ] `writeFileForBasePath()` - validates parent directory exists
- [ ] `getTaskBasePath()` - returns worktree path if exists
- [ ] `getTaskBasePath()` - falls back to task directory
- [ ] `getTaskBasePath()` - throws ENOTASK for missing task
- [ ] `getWorkspaceBasePath()` - "project" resolves to project root
- [ ] `getWorkspaceBasePath()` - task ID resolves to task path
- [ ] `listWorkspaceFiles()` / `readWorkspaceFile()` / `writeWorkspaceFile()` - workspace-aware operations

**Testing approach:** Mock `node:fs/promises` and `@kb/core` TaskStore. Use `vi.mock()` for module-level mocks.

**Artifacts:**
- `packages/dashboard/src/__tests__/file-service.test.ts` (new)

### Step 3: Add Rate Limit Tests

Create tests for `rate-limit.ts` covering:

- [ ] `rateLimit()` middleware - allows requests under the limit
- [ ] `rateLimit()` middleware - denies requests over the limit (429 status)
- [ ] `rateLimit()` middleware - sets RateLimit-* headers correctly
- [ ] `rateLimit()` middleware - sets Retry-After header on 429
- [ ] `rateLimit()` middleware - sliding window resets after windowMs
- [ ] `rateLimit()` middleware - tracks different IPs independently
- [ ] `rateLimit()` middleware - default options (100 req/min, 60s window)
- [ ] `rateLimit()` middleware - custom options respected
- [ ] `RATE_LIMITS` constants - has correct values for api, mutation, sse
- [ ] Cleanup interval - removes expired entries (mock timers)

**Testing approach:** Mock Express Request/Response objects using minimal type-compatible objects. Use `vi.useFakeTimers()` for window testing.

**Artifacts:**
- `packages/dashboard/src/__tests__/rate-limit.test.ts` (new)

### Step 4: Add Terminal Service Tests

Create tests for `terminal-service.ts` covering:

- [ ] `TerminalService` constructor - sets project root and max sessions
- [ ] `detectShell()` - returns allowed shell for current platform
- [ ] `detectShell()` - respects user's SHELL env var if allowed
- [ ] `detectShell()` - falls through to next allowed shell if not exists
- [ ] `detectShell()` - returns platform-specific fallback
- [ ] `isAllowedShell()` - validates shell paths against allowlist
- [ ] `resolveWorkingDirectory()` - uses project root when no cwd specified
- [ ] `resolveWorkingDirectory()` - resolves relative paths within project root
- [ ] `resolveWorkingDirectory()` - blocks path traversal attacks
- [ ] `resolveWorkingDirectory()` - falls back to project root for non-existent paths
- [ ] `resolveWorkingDirectory()` - rejects null byte paths
- [ ] `isValidSessionId()` - validates alphanumeric and dash pattern
- [ ] `createSession()` - returns null when PTY module unavailable (mock loadPtyModule failure)
- [ ] `createSession()` - respects max session limit
- [ ] `createSession()` - auto-evicts stale sessions at 80% threshold
- [ ] `createSession()` - validates shell is allowed
- [ ] `createSession()` - strips sensitive env vars
- [ ] `write()` - validates session ID format
- [ ] `write()` - rejects null byte input
- [ ] `resize()` - validates session ID format
- [ ] `killSession()` - validates session ID format
- [ ] `getSession()` - validates session ID format
- [ ] `getScrollback()` - returns buffer content
- [ ] `getAllSessions()` - returns session metadata (no PTY object)
- [ ] `updateActivity()` - updates lastActivityAt timestamp
- [ ] `getStaleSessions()` - returns sessions beyond threshold
- [ ] `evictStaleSessions()` - kills oldest stale sessions to reach target count
- [ ] `cleanup()` - kills all sessions and clears map

**Testing approach:** Mock `node-pty` module (dynamic import), mock `os.platform()`, mock `node:fs` for shell existence checks. Skip tests that require actual PTY when module unavailable.

**Artifacts:**
- `packages/dashboard/src/__tests__/terminal-service.test.ts` (new)

### Step 5: Add Usage Module Tests

Create tests for `usage.ts` covering:

- [ ] `calculatePace()` - returns undefined when timing data missing
- [ ] `calculatePace()` - returns "ahead" when usage > elapsed + threshold
- [ ] `calculatePace()` - returns "behind" when usage < elapsed - threshold
- [ ] `calculatePace()` - returns "on-track" within threshold
- [ ] `calculatePace()` - handles window reset (resetMs <= 0)
- [ ] `formatDuration()` - formats seconds, minutes, hours, days correctly
- [ ] `decodeJwtPayload()` - decodes valid JWT payload
- [ ] `decodeJwtPayload()` - returns null for invalid JWT
- [ ] `fetchAllProviderUsage()` - returns cached data within TTL
- [ ] `fetchAllProviderUsage()` - fetches fresh data after cache expires
- [ ] `clearUsageCache()` - clears the cache
- [ ] `fetchClaudeUsage()` - returns no-auth when credentials missing
- [ ] `fetchClaudeUsage()` - returns error on 401/403/429
- [ ] `fetchClaudeUsage()` - parses windows correctly on success (mock fs, https)
- [ ] `fetchCodexUsage()` - returns no-auth when auth.json missing
- [ ] `fetchCodexUsage()` - extracts plan/email from id_token
- [ ] `fetchCodexUsage()` - parses rate_limit windows (mock fs, https)
- [ ] `fetchGeminiUsage()` - returns no-auth when oauth_creds missing
- [ ] `fetchGeminiUsage()` - returns error for unsupported auth type
- [ ] `fetchGeminiUsage()` - groups buckets by model family (mock fs, https)
- [ ] `fetchMinimaxUsage()` - returns no-auth when credentials missing
- [ ] `fetchMinimaxUsage()` - parses quota data (mock fs, https)
- [ ] `fetchZaiUsage()` - returns no-auth when auth missing
- [ ] `fetchZaiUsage()` - parses daily/monthly windows (mock fs, https)

**Testing approach:** Mock `node:fs` for credential files, mock `node:https` for API calls, mock `Date.now()` for cache testing.

**Artifacts:**
- `packages/dashboard/src/__tests__/usage.test.ts` (new)

### Step 6: Extend GitHub Poll Tests

Add tests to existing `github-poll.test.ts` for `GitHubPollingService`:

- [ ] `configure()` - updates store, token, polling interval
- [ ] `configure()` - restarts timer when interval changes while running
- [ ] `start()` - begins polling when watches exist
- [ ] `start()` - does nothing when no watches
- [ ] `stop()` - clears timer
- [ ] `watchTask()` - adds watch for task
- [ ] `watchTask()` - replaces existing watch of same type
- [ ] `replaceTaskWatches()` - handles multiple watch types
- [ ] `replaceTaskWatches()` - unwatch when empty array
- [ ] `unwatchTask()` - removes all watches for task
- [ ] `unwatchTask()` - stops polling when no watches remain
- [ ] `unwatchTaskType()` - removes specific type only
- [ ] `reset()` - clears all watches and stops
- [ ] `getWatchedTaskIds()` - returns all watched task IDs
- [ ] `getWatch()` - returns watch set for task
- [ ] `getLastCheckedAt()` - returns timestamp for type
- [ ] `pollOnce()` - batches requests by repo
- [ ] `pollOnce()` - applies rate limiting per repo
- [ ] `pollOnce()` - handles missing tasks (ENOENT unwatches)
- [ ] `pollOnce()` - updates store when badge fields changed
- [ ] `pollOnce()` - skips update when badge unchanged
- [ ] `pollOnce()` - handles PR status normalization (open/closed/merged)
- [ ] `hasPrBadgeChanged()` / `hasIssueBadgeChanged()` - field comparison logic

**Testing approach:** Mock `TaskStore`, mock `GitHubClient`, use fake timers for polling intervals.

**Artifacts:**
- `packages/dashboard/src/__tests__/github-poll.test.ts` (modified - add describe blocks)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all dashboard tests: `cd packages/dashboard && pnpm test`
- [ ] Verify no test failures
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Verify coverage report generates: `pnpm test:coverage` (if supported)
- [ ] Ensure new tests follow existing patterns (describe/it blocks, vi mocking)

### Step 8: Documentation & Delivery

- [ ] Verify test files include clear describe/it descriptions
- [ ] Ensure edge cases are documented in test names
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any issues found in source files)

## Documentation Requirements

**Must Update:**
- None expected (test-only task)

**Check If Affected:**
- `packages/dashboard/README.md` — Add testing section if missing coverage documentation

## Completion Criteria

- [ ] 5 new test files created (or 4 new + 1 extended)
- [ ] All dashboard tests pass: `pnpm test` exits with code 0
- [ ] TypeScript compiles without errors: `pnpm typecheck`
- [ ] Test coverage improved for server-side modules
- [ ] Mock-based testing (no external dependencies in tests)
- [ ] Follows existing test patterns from project

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-316): complete Step N — description`
- **New tests:** `test(KB-316): add tests for module — description`
- **Bug fixes:** `fix(KB-316): description` (if source file bugs discovered)

## Do NOT

- Skip tests for complex logic (path traversal, rate limiting, etc.)
- Use actual filesystem, network, or PTY in tests (always mock)
- Modify source file behavior without creating a separate bug task
- Add trivial always-pass tests with no assertions
- Skip error handling paths in tests
- Commit without the task ID prefix
