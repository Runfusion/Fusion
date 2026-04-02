# Task: KB-262 - Add PR Tab to GitHub Import Modal

**Created:** 2025-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task adds new API endpoints and UI for importing PRs as review tasks. It mirrors existing issue import patterns but requires careful handling of PR-specific data and "review task" semantics.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Add a "Pull Requests" tab to the existing GitHub Import Modal (`GitHubImportModal.tsx`) alongside the existing "Issues" tab. Users can browse open PRs from a remote repository, select one, and create a kb task to "address issues in PR". The imported task should have a title prefixed with "Review PR:" and a description that includes the PR URL and context for review work.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/GitHubImportModal.tsx` — Existing issue import modal with two-pane layout
2. `packages/dashboard/app/api.ts` — Frontend API functions (see `apiFetchGitHubIssues`, `apiImportGitHubIssue`)
3. `packages/dashboard/src/routes.ts` — Backend routes (see `/github/issues/fetch` and `/github/issues/import` endpoints around line 1405-1600)
4. `packages/dashboard/src/github.ts` — `GitHubClient` class with existing `listIssues` implementation (around line 1270)
5. `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` — Test patterns for the modal

## File Scope

- `packages/dashboard/src/github.ts` — Add `listPullRequests` method to GitHubClient
- `packages/dashboard/src/routes.ts` — Add `/github/pulls/fetch` and `/github/pulls/import` endpoints
- `packages/dashboard/app/api.ts` — Add `apiFetchGitHubPulls` and `apiImportGitHubPull` functions
- `packages/dashboard/app/components/GitHubImportModal.tsx` — Add tab UI and PR list view
- `packages/dashboard/app/components/GitHubImportModal.css` — Add tab styles (or inline styles if CSS file doesn't exist)
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` — Add tests for PR tab functionality

## Steps

### Step 1: Backend - Add PR List Method to GitHubClient

- [ ] Add `listPullRequests` method to `GitHubClient` class in `packages/dashboard/src/github.ts`
- [ ] Use gh CLI `gh pr list` with `--state open` flag, fallback to REST API `/repos/{owner}/{repo}/pulls?state=open`
- [ ] Return array of objects: `{ number, title, body, html_url, headBranch, baseBranch }`
- [ ] Add `listPullRequestsWithGh` and `listPullRequestsWithApi` private helper methods
- [ ] Run dashboard tests to verify no regressions

**Artifacts:**
- `packages/dashboard/src/github.ts` (modified)

### Step 2: Backend - Add PR API Endpoints

- [ ] Add `POST /github/pulls/fetch` route in `packages/dashboard/src/routes.ts` (after the issues routes)
- [ ] Accept body: `{ owner: string, repo: string, limit?: number }`
- [ ] Return array of PR objects (same shape as GitHubClient output)
- [ ] Add `POST /github/pulls/import` route
- [ ] Accept body: `{ owner: string, repo: string, prNumber: number }`
- [ ] Fetch PR details using existing `GitHubClient.getPrStatus` or `findPrForBranch`
- [ ] Check for existing task with same PR URL (409 if duplicate)
- [ ] Create task with:
  - Title: `Review PR #${number}: ${pr.title.slice(0, 180)}`
  - Description: `Review and address any issues in this pull request.\n\nPR: ${pr.url}\nBranch: ${pr.headBranch} → ${pr.baseBranch}`
  - Column: "triage"
- [ ] Run full test suite

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Frontend - Add API Functions

- [ ] Add `GitHubPull` interface to `packages/dashboard/app/api.ts`:
  ```typescript
  export interface GitHubPull {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    headBranch: string;
    baseBranch: string;
  }
  ```
- [ ] Add `apiFetchGitHubPulls(owner, repo, limit?)` function
- [ ] Add `apiImportGitHubPull(owner, repo, prNumber)` function
- [ ] Both functions follow same pattern as issue equivalents

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 4: Frontend - Add Tab UI to GitHubImportModal

- [ ] Add `activeTab` state: `'issues' | 'pulls'` (default: 'issues')
- [ ] Add `pulls` and `selectedPullNumber` state (mirror issue state pattern)
- [ ] Add tab buttons in modal header area (above toolbar or in toolbar zone)
- [ ] Show "Issues" and "Pull Requests" tabs
- [ ] Active tab has distinct visual state
- [ ] Add `handleLoadPulls` callback (mirror `handleLoad` for issues)
- [ ] When tab switches to 'pulls', auto-load pulls if owner/repo set (same auto-load logic as issues)
- [ ] Add PR list pane (mirror issue list pane):
  - Show PR number, title, head→base branch info
  - "Imported" badge for already-imported PRs (check task descriptions for PR URL)
  - Selection radio buttons
- [ ] Add PR preview pane showing:
  - PR number
  - Title
  - Body preview (first 200 chars)
  - Branch info: `headBranch → baseBranch`
- [ ] Update Import button handler to call `apiImportGitHubPull` when on pulls tab
- [ ] Escape key handler closes modal (already exists, ensure it works)
- [ ] Mobile view support (back button, active pane switching)

**Artifacts:**
- `packages/dashboard/app/components/GitHubImportModal.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` — all existing tests must pass
- [ ] Add tests in `GitHubImportModal.test.tsx`:
  - Tab switching renders correct content
  - PR list loads and displays PRs with branch info
  - Selecting PR shows preview with branch info
  - Importing PR calls `apiImportGitHubPull` with correct args
  - Already-imported PRs show "Imported" badge (disabled)
- [ ] Test both tabs work with single and multiple remotes
- [ ] Test mobile responsive behavior with tabs
- [ ] Verify no console errors or warnings
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` (modified)

### Step 6: Documentation & Delivery

- [ ] No documentation updates required (feature is self-discoverable in UI)
- [ ] Create changeset for patch release of `@dustinbyrne/kb` (CLI includes dashboard features)
- [ ] Verify task can be marked complete

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] GitHubImportModal shows Issues and Pull Requests tabs
- [ ] Clicking Pull Requests tab shows open PRs from selected remote
- [ ] PRs display number, title, and branch info (head → base)
- [ ] Selecting a PR shows preview with branch info
- [ ] Importing a PR creates a task titled "Review PR #N: ..." in triage column
- [ ] Already-imported PRs show "Imported" badge and cannot be re-imported
- [ ] All existing tests pass
- [ ] New tests cover PR tab functionality
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-262): complete Step N — description`
- **Bug fixes:** `fix(KB-262): description`
- **Tests:** `test(KB-262): description`

## Do NOT

- Remove or break existing Issue import functionality
- Change the PR import to use different column than triage
- Add unnecessary complexity (follow the existing pattern exactly)
- Skip error handling for API failures (follow patterns in issue routes)
- Modify files outside the File Scope without explicit justification
