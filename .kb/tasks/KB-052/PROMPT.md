# Task: KB-052 - Refactor GitHub Integration to Use gh CLI

**Created:** 2026-03-30
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** The GitHub integration spans multiple packages (dashboard, engine) and requires careful refactoring to maintain backward compatibility while switching from REST API to gh CLI. Test coverage needs to be updated for the new implementation.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Refactor the GitHub integration across the codebase to use the existing `gh` CLI for all operations instead of direct GitHub REST API calls. The `gh` CLI is already used for PR creation in `packages/dashboard/src/github.ts` — extend this pattern to all other GitHub operations (PR status checks, comment listing, issue import/fetch).

Benefits of using `gh` CLI:
- Simpler authentication (uses user's existing `gh auth` session)
- No need for `GITHUB_TOKEN` environment variable in most cases
- Consistent rate limiting handled by GitHub
- Better error messages and debugging

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/github.ts` — Current `GitHubClient` implementation (uses `gh` CLI for PR creation, REST API for other operations)
- `packages/engine/src/pr-monitor.ts` — PR monitoring using REST API `fetch()` for comments
- `packages/dashboard/src/routes.ts` — GitHub issue import/fetch routes using REST API
- `packages/engine/src/github.ts` — Utility functions for parsing GitHub remotes

## File Scope

- `packages/dashboard/src/github.ts` — Refactor `GitHubClient` to use `gh` CLI for all operations
- `packages/engine/src/pr-monitor.ts` — Refactor to use `gh` CLI for PR comment fetching
- `packages/dashboard/src/routes.ts` — Refactor GitHub issue endpoints to use `gh` CLI
- `packages/dashboard/src/github.test.ts` — Create/update tests for GitHubClient
- `packages/engine/src/pr-monitor.test.ts` — Update tests for new gh CLI implementation
- `packages/dashboard/src/routes.test.ts` — Update/add tests for GitHub routes

## Steps

### Step 1: Create gh CLI Utility Module

Create a shared utility module for `gh` CLI operations that can be used by both dashboard and engine packages.

- [ ] Create `packages/dashboard/src/gh-cli.ts` with utility functions:
  - `isGhAvailable(): boolean` — Check if `gh` CLI is installed
  - `isGhAuthenticated(): boolean` — Check if `gh` is authenticated
  - `runGh(args: string[], cwd?: string): string` — Execute gh command with proper error handling
  - `runGhAsync(args: string[], cwd?: string): Promise<string>` — Async version
- [ ] Handle gh CLI not being available (throw specific error or return null)
- [ ] Handle authentication errors (parse `gh auth status` output)
- [ ] Parse JSON output from `gh` commands (use `--json` flag where available)

**Artifacts:**
- `packages/dashboard/src/gh-cli.ts` (new)
- `packages/dashboard/src/gh-cli.test.ts` (new)

### Step 2: Refactor GitHubClient to Use gh CLI

Update `packages/dashboard/src/github.ts` to use `gh` CLI for all operations.

- [ ] Refactor `createPr()` to use the new gh utility (already uses CLI, just update to use shared utility)
- [ ] Refactor `getPrStatus()` to use `gh pr view --json` instead of REST API
- [ ] Refactor `listPrComments()` to use `gh pr view --json comments` instead of REST API
- [ ] Remove `token` parameter from `GitHubClient` constructor (no longer needed for gh CLI)
- [ ] Keep REST API fallback methods as `*WithApi()` private methods for edge cases
- [ ] Update `CreatePrParams` interface — remove dependency on `owner/repo` when in repo context
- [ ] Update error messages to be user-friendly (gh CLI provides good error messages)

**Artifacts:**
- `packages/dashboard/src/github.ts` (modified)

### Step 3: Refactor PR Monitor to Use gh CLI

Update `packages/engine/src/pr-monitor.ts` to use `gh` CLI for polling.

- [ ] Add import for shared gh utility (may need to duplicate or move to core package if sharing is problematic)
- [ ] Refactor `fetchComments()` to use `gh pr view --json comments` instead of REST API
- [ ] Remove `getGitHubToken` from constructor options (no longer needed)
- [ ] Update error handling for gh CLI errors (authentication, not found, etc.)
- [ ] Simplify rate limiting (gh CLI handles this internally)

**Artifacts:**
- `packages/engine/src/pr-monitor.ts` (modified)

### Step 4: Refactor GitHub Routes to Use gh CLI

Update `packages/dashboard/src/routes.ts` to use `gh` CLI for issue operations.

- [ ] Refactor `POST /github/issues/fetch` to use `gh issue list --json`
- [ ] Refactor `POST /github/issues/import` to use `gh issue view --json`
- [ ] Remove `GitHubRateLimiter` class (gh CLI handles rate limiting)
- [ ] Update error responses to use gh CLI error messages
- [ ] Remove token-based auth checks (rely on `gh auth status`)

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 5: Write Tests for gh CLI Utilities

Create comprehensive tests for the new gh CLI utility module.

- [ ] Test `isGhAvailable()` — mock `execFileSync` to return version or throw
- [ ] Test `isGhAuthenticated()` — mock `gh auth status` output
- [ ] Test `runGh()` — verify correct arguments passed, error handling
- [ ] Test JSON parsing of gh output
- [ ] Test error cases: gh not installed, not authenticated, command fails

**Artifacts:**
- `packages/dashboard/src/gh-cli.test.ts` (new)

### Step 6: Update Existing Tests

Update all existing tests to work with the new gh CLI implementation.

- [ ] Update `packages/dashboard/src/github.test.ts` (create if doesn't exist)
  - Mock `gh` CLI commands instead of `fetch`
  - Test PR creation via gh CLI
  - Test PR status via gh CLI
  - Test comment listing via gh CLI
- [ ] Update `packages/engine/src/pr-monitor.test.ts`
  - Mock `gh` CLI instead of `fetch`
  - Update test expectations for gh output format
  - Remove token-related tests
- [ ] Update `packages/dashboard/src/routes.test.ts`
  - Mock `gh` CLI for issue endpoints
  - Remove rate limit tests (no longer needed)
  - Update auth error tests

**Artifacts:**
- `packages/dashboard/src/github.test.ts` (new or modified)
- `packages/engine/src/pr-monitor.test.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 8: Documentation & Delivery

- [ ] Update `AGENTS.md` if it mentions GitHub token requirements
- [ ] Update README if it documents GitHub integration setup
- [ ] Create changeset for the change (patch level — internal refactor)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Update any mentions of `GITHUB_TOKEN` requirement to note that `gh` CLI auth is now preferred

**Check If Affected:**
- `README.md` — Update GitHub integration setup section if present
- `packages/cli/README.md` — Update extension tool descriptions that mention GITHUB_TOKEN

## Completion Criteria

- [ ] All GitHub operations use `gh` CLI instead of REST API
- [ ] All tests passing
- [ ] `GitHubClient` no longer requires `GITHUB_TOKEN`
- [ ] PR monitor no longer requires `GITHUB_TOKEN`
- [ ] GitHub routes no longer require `GITHUB_TOKEN`
- [ ] REST API fallback available for edge cases
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-052): complete Step N — description`
- **Bug fixes:** `fix(KB-052): description`
- **Tests:** `test(KB-052): description`

## Do NOT

- Remove the existing REST API implementation entirely — keep as fallback
- Break existing tests without fixing them
- Require `GITHUB_TOKEN` for basic operations (gh CLI auth is preferred)
- Change the public API of `GitHubClient` unnecessarily (maintain backward compatibility)
- Skip testing edge cases (gh not installed, not authenticated)
- Modify files outside the File Scope without good reason
