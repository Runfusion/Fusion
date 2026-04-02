# Task: KB-067 - Refactor GitHub Issue Routes to Use gh CLI

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a focused refactoring of two API endpoints with straightforward gh CLI replacements. The pattern is already established in KB-052's GitHubClient. Test updates are required but scope is limited to issue routes only.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Refactor the GitHub issue import/fetch routes in `packages/dashboard/src/routes.ts` to use the `gh` CLI instead of direct REST API calls via `fetch()`. This follows the pattern established in KB-052 and ensures consistent authentication handling across all GitHub operations.

The issue routes currently:
- Use `fetch()` to call `https://api.github.com/repos/{owner}/{repo}/issues`
- Require `GITHUB_TOKEN` environment variable
- Implement manual rate limiting via `GitHubRateLimiter` class
- Return generic auth error messages

These should be replaced with:
- `gh issue list --json` for fetching issues
- `gh issue view --json` for importing single issues
- `gh auth status` for authentication checks
- Native gh CLI error messages for better UX

## Dependencies

- **Task:** KB-052 — "Refactor GitHub Integration to Use gh CLI" (must provide `gh-cli.ts` module and updated `GitHubClient` with `listIssues()` and `getIssue()` methods)

## Context to Read First

- `packages/dashboard/src/routes.ts` — Lines ~1090-1230 contain the `POST /github/issues/fetch` and `POST /github/issues/import` routes using `fetch()`
- `packages/dashboard/src/github.ts` — GitHubClient class (post-KB-052) with gh CLI methods
- `packages/dashboard/src/routes.test.ts` — Lines ~1050-1270 contain tests for GitHub issue routes that mock `fetch()`

## File Scope

- `packages/dashboard/src/routes.ts` — Refactor two routes to use gh CLI
- `packages/dashboard/src/routes.test.ts` — Update tests to mock gh CLI instead of fetch

## Steps

### Step 1: Verify KB-052 Deliverables

Before starting, confirm KB-052 has provided:

- [ ] `packages/dashboard/src/gh-cli.ts` exists with:
  - `runGh(args: string[], cwd?: string): string` — executes gh commands
  - `isGhAvailable(): boolean` — checks gh CLI installation
  - `isGhAuthenticated(): boolean` — checks gh auth status
  - `GhError` class for typed error handling
- [ ] `packages/dashboard/src/github.ts` GitHubClient has:
  - `listIssues(owner, repo, options)` — uses `gh issue list --json`
  - `getIssue(owner, repo, number)` — uses `gh issue view --json`
  - Returns same shape as current REST API responses
- [ ] Tests exist for the new GitHubClient methods in `github.test.ts`

If KB-052 deliverables are missing, pause and report via `task_create` tool.

### Step 2: Refactor POST /github/issues/fetch

Replace the direct `fetch()` implementation with `GitHubClient.listIssues()`:

- [ ] Import required functions from `gh-cli.ts` if needed for auth checks
- [ ] Replace `fetch()` call to GitHub API with `client.listIssues(owner, repo, { limit, labels })`
- [ ] Remove `GITHUB_TOKEN` dependency — use `isGhAuthenticated()` check instead
- [ ] Update error handling:
  - 400: Invalid owner/repo parameters (unchanged)
  - 401/403: `isGhAuthenticated() === false` → return "Not authenticated with GitHub. Run `gh auth login`."
  - 404: Repository not found (from gh CLI error)
  - 429: Remove manual rate limiting — gh CLI handles this
  - 502: Gh CLI execution errors
- [ ] Remove `GitHubRateLimiter` usage for issue routes (gh CLI handles rate limits)
- [ ] Keep PR filtering logic (filter out items with `pull_request` property)
- [ ] Keep response format identical to avoid breaking the dashboard UI

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Refactor POST /github/issues/import

Replace the direct `fetch()` implementation with `GitHubClient.getIssue()`:

- [ ] Replace `fetch()` call with `client.getIssue(owner, repo, issueNumber)`
- [ ] Remove `GITHUB_TOKEN` dependency — use `isGhAuthenticated()` check instead
- [ ] Update error handling:
  - 400: Invalid parameters or importing a PR (unchanged validation)
  - 401/403: `isGhAuthenticated() === false` → return "Not authenticated with GitHub. Run `gh auth login`."
  - 404: Issue not found (from gh CLI error)
  - 409: Already imported (unchanged — check for existing source URL)
  - 502: Gh CLI execution errors
- [ ] Remove `GitHubRateLimiter` usage
- [ ] Keep duplicate detection logic (check existing tasks for source URL)
- [ ] Keep title truncation (200 chars) and description formatting
- [ ] Keep response format identical

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 4: Update GitHub Issue Route Tests

Replace `fetch()` mocks with `gh` CLI mocks in `routes.test.ts`:

- [ ] Remove `fetchSpy` mock and `globalThis.fetch` manipulation
- [ ] Mock `runGh()` or `GitHubClient` methods instead
- [ ] Update test: "fetches issues successfully" — mock `gh issue list --json` output
- [ ] Update test: "returns 404 when repository not found" — mock gh CLI error
- [ ] Update test: "returns 401/403 when authentication fails" — mock `isGhAuthenticated()` returning false
- [ ] Update test: "filters out pull requests" — verify filtering still works with gh CLI output
- [ ] Update test: "imports a single issue successfully" — mock `gh issue view --json` output
- [ ] Update test: "returns 404 when issue not found" — mock gh CLI error
- [ ] Update test: "returns 400 when importing a pull request" — mock gh returning PR data (should be filtered)
- [ ] Update test: "returns 409 when issue already imported" — unchanged logic
- [ ] Update test: "truncates long titles to 200 chars" — unchanged logic
- [ ] Add test: "returns 401 when gh not authenticated" — new test case
- [ ] Add test: "returns 502 when gh CLI fails" — new test case

**Test mocking strategy:**
```typescript
// Instead of:
fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([issue]) });

// Use:
vi.mocked(runGh).mockReturnValueOnce(JSON.stringify([issue]));
// or mock GitHubClient directly:
vi.mocked(GitHubClient.prototype.listIssues).mockResolvedValueOnce([issue]);
```

**Artifacts:**
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Test both endpoints via dashboard or curl

**Test commands:**
```bash
# Run dashboard tests specifically
pnpm test -- packages/dashboard

# Build verification
pnpm build
```

### Step 6: Documentation & Delivery

- [ ] Create changeset (patch level — internal refactor)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — this is an internal refactor with no API changes

**Check If Affected:**
- `AGENTS.md` — Update if it mentions GitHub token requirements for issue import
- `README.md` — Update if it documents GitHub integration setup

## Completion Criteria

- [ ] Both issue routes use `gh` CLI instead of `fetch()`
- [ ] All tests passing with gh CLI mocks
- [ ] No manual rate limiting for issue routes
- [ ] Auth errors reference `gh auth login` instead of `GITHUB_TOKEN`
- [ ] Response formats unchanged (backward compatible)
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-067): complete Step N — description`
- **Bug fixes:** `fix(KB-067): description`
- **Tests:** `test(KB-067): description`

Example commits:
- `feat(KB-067): complete Step 2 — refactor issues/fetch route to use gh CLI`
- `feat(KB-067): complete Step 3 — refactor issues/import route to use gh CLI`
- `test(KB-067): update routes.test.ts to mock gh CLI instead of fetch`

## Do NOT

- Change the JSON response format of the routes (dashboard UI depends on it)
- Remove the `GitHubRateLimiter` class entirely (it's still used for PR routes)
- Skip updating tests — must mock gh CLI, not just skip failing tests
- Add new dependencies (use existing gh CLI infrastructure from KB-052)
- Modify files outside the File Scope without good reason
- Start work before KB-052 deliverables are confirmed available

## Notes for Executor

**KB-052 Integration:**
If KB-052's `GitHubClient` methods have slightly different signatures or return shapes, adapt the routes.ts code accordingly. The key requirement is:
- `listIssues()` must accept `{ owner, repo, limit?, labels? }` and return array of issues
- `getIssue()` must accept `{ owner, repo, number }` and return single issue or null

**Error Message Patterns:**
When gh CLI fails, it outputs to stderr. The `runGh()` utility from KB-052 should throw `GhError` with:
- `message`: stderr content or "gh CLI failed"
- `exitCode`: process exit code
- `command`: the command that failed (for debugging)

Map these to HTTP status codes:
- Exit code 4 (auth required) → 401
- Exit code 1 with "not found" → 404
- Other non-zero → 502

**Backward Compatibility:**
The dashboard UI expects these exact response shapes:
```typescript
// POST /github/issues/fetch returns:
Array<{
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
}>

// POST /github/issues/import returns:
TaskDetail // full task object from store.createTask()
```

Do not change these shapes.
