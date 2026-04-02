# Task: KB-030 - Add Git Management Component to Dashboard

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This task involves creating a comprehensive git management UI with server-side git operations, branch management, worktree visualization, and remote operations. It touches both backend API routes and frontend React components with significant security implications (executing git commands server-side).

**Score:** 6/8 — Blast radius: 2 (multiple files, new API surface), Pattern novelty: 1 (follows existing modal patterns), Security: 2 (exec git commands, input validation critical), Reversibility: 1 (database migrations not needed, but API changes persist)

## Mission

Build a comprehensive Git Management component for the kb dashboard that gives users full visibility and control over their repository state. The component will be accessible via a new button in the header and open as a modal with tabbed sections for: recent commits (with diff viewing), branch management (list, checkout, create, delete), worktree visualization (showing which tasks own which worktrees), and remote operations (fetch, pull, push). This eliminates the need for users to drop to the command line for routine git operations while working with kb tasks.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/src/routes.ts` — Existing API route patterns, especially `getGitHubRemotes()` function and git-related endpoints
2. `packages/dashboard/app/api.ts` — API client patterns and existing type definitions
3. `packages/dashboard/app/components/SettingsModal.tsx` — Reference for tabbed modal implementation with sidebar navigation
4. `packages/dashboard/app/components/GitHubImportModal.tsx` — Reference for git-related modal with loading states
5. `packages/dashboard/app/components/Header.tsx` — Where to add the Git Manager button
6. `packages/dashboard/app/App.tsx` — How modals are integrated and state managed
7. `packages/engine/src/scheduler.ts` — Understanding of worktree management and how tasks relate to worktrees
8. `packages/dashboard/app/hooks/useTasks.ts` — How task data flows through the UI

## File Scope

**Backend (packages/dashboard/src/):**
- `routes.ts` — Add new git management API endpoints
- `routes.test.ts` — Add tests for new git endpoints

**Frontend (packages/dashboard/app/):**
- `api.ts` — Add git API client functions and types
- `components/GitManagerModal.tsx` — New git management modal component
- `components/__tests__/GitManagerModal.test.tsx` — Tests for the modal
- `components/Header.tsx` — Add button to open Git Manager
- `App.tsx` — Integrate GitManagerModal and manage its state

**Shared types are already defined in:**
- `@kb/core` types for Task, TaskDetail (worktree field)

## Steps

### Step 1: Backend API - Git Information Endpoints

- [ ] Add `GET /api/git/status` endpoint in `routes.ts` — returns current branch, clean/dirty status, ahead/behind counts
- [ ] Add `GET /api/git/commits` endpoint — returns recent commits (default 20, configurable limit) with hash, message, author, date, and parent hashes
- [ ] Add `GET /api/git/commits/:hash/diff` endpoint — returns diff for a specific commit (stat + patch)
- [ ] Add `GET /api/git/branches` endpoint — returns all local branches with current indicator, remote tracking info, and last commit date
- [ ] Add `GET /api/git/worktrees` endpoint — returns all worktrees with path, branch, isMain, and associated task ID (lookup by worktree path matching)
- [ ] All git operations use `execSync` with 10s timeout and proper error handling
- [ ] Add tests in `routes.test.ts` for all new endpoints

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 2: Backend API - Git Action Endpoints

- [ ] Add `POST /api/git/branches` endpoint — create new branch from current HEAD or specified base, validates branch name format (no spaces, valid git ref characters)
- [ ] Add `POST /api/git/branches/:name/checkout` endpoint — checkout existing branch, error if uncommitted changes would be lost
- [ ] Add `DELETE /api/git/branches/:name` endpoint — delete branch, error if it's the current branch or has unmerged commits
- [ ] Add `POST /api/git/fetch` endpoint — fetch from origin (or specified remote), returns summary of fetched refs
- [ ] Add `POST /api/git/pull` endpoint — pull current branch, returns result summary or error on conflict
- [ ] Add `POST /api/git/push` endpoint — push current branch, returns result summary
- [ ] All action endpoints validate we're in a git repo before executing
- [ ] Add tests for action endpoints with mocked git commands
- [ ] Add validation to prevent command injection in branch names (sanitize/validate all user inputs)

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 3: Frontend API Client

- [ ] Add types in `api.ts`: `GitStatus`, `GitCommit`, `GitBranch`, `GitWorktree`, `GitFetchResult`, `GitPullResult`, `GitPushResult`
- [ ] Add `fetchGitStatus(): Promise<GitStatus>` function
- [ ] Add `fetchGitCommits(limit?: number): Promise<GitCommit[]>` function
- [ ] Add `fetchCommitDiff(hash: string): Promise<string>` function
- [ ] Add `fetchGitBranches(): Promise<GitBranch[]>` function
- [ ] Add `fetchGitWorktrees(): Promise<GitWorktree[]>` function
- [ ] Add `createBranch(name: string, base?: string): Promise<void>` function
- [ ] Add `checkoutBranch(name: string): Promise<void>` function
- [ ] Add `deleteBranch(name: string): Promise<void>` function
- [ ] Add `fetchRemote(remote?: string): Promise<GitFetchResult>` function
- [ ] Add `pullBranch(): Promise<GitPullResult>` function
- [ ] Add `pushBranch(): Promise<GitPushResult>` function
- [ ] Add tests in `api.test.ts` for all new functions

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/api.test.ts` (modified)

### Step 4: Git Manager Modal Component

- [ ] Create `GitManagerModal.tsx` with tabbed layout following SettingsModal pattern
- [ ] Define sections: `"status"`, `"commits"`, `"branches"`, `"worktrees"`, `"remotes"`
- [ ] Implement Status tab: show current branch, commit hash, dirty status with indicator color, ahead/behind display
- [ ] Implement Commits tab: list recent commits with hash (short), message summary, author, date; clickable to expand and show diff in panel below; "Load more" button for pagination
- [ ] Implement Branches tab: list all branches with current indicator, create branch input with validation, checkout/delete buttons (with confirmation for delete), switch-to-branch on click
- [ ] Implement Worktrees tab: list all worktrees with path, branch, main indicator, and associated task badge (if worktree path matches task worktree field); show free/used worktree count
- [ ] Implement Remotes tab: show configured remotes, Fetch/Pull/Push buttons with loading states, display last operation result
- [ ] All tabs show loading states and handle errors with toast notifications via `addToast` prop
- [ ] Add keyboard support: Escape to close, Tab navigation within modal
- [ ] Auto-refresh status when modal opens and on tab switch

**Artifacts:**
- `packages/dashboard/app/components/GitManagerModal.tsx` (new)

### Step 5: Integrate Git Manager into App

- [ ] Add `gitManagerOpen` state to `AppInner` component
- [ ] Add `handleOpenGitManager` and `handleCloseGitManager` callbacks
- [ ] Import `GitBranch` icon from lucide-react in Header.tsx
- [ ] Add git manager button to Header between GitHub Import and Pause buttons
- [ ] Add `onOpenGitManager` prop to Header component and wire it up
- [ ] Add `GitManagerModal` to App.tsx with `isOpen`, `onClose`, `tasks`, `addToast` props
- [ ] Pass current `tasks` to GitManagerModal so it can correlate worktrees with tasks
- [ ] Verify modal opens/closes correctly and doesn't interfere with other modals

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` — all existing tests must pass
- [ ] New tests pass: `routes.test.ts` additions (8+ new test cases for git endpoints)
- [ ] New tests pass: `api.test.ts` additions (11+ new test cases for git API functions)
- [ ] New tests pass: `GitManagerModal.test.tsx` with coverage for:
  - Rendering all tabs
  - Tab switching
  - Loading states
  - Error handling
  - Commit selection and diff display
  - Branch creation validation
  - Worktree task correlation display
- [ ] Manual verification: open Git Manager, verify commits load, verify branches list, verify worktrees show (create a task to test worktree display)
- [ ] Run `pnpm build` — dashboard package builds without errors

**Artifacts:**
- `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` (new)

### Step 7: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` with section documenting Git Manager feature
- [ ] Document the new API endpoints in a "Git API" section
- [ ] Verify no out-of-scope features were added
- [ ] Create changeset file for the feature: `.changeset/add-git-manager.md` with minor bump (new dashboard feature)

**Changeset content:**
```md
---
"@dustinbyrne/kb": minor
---

Add Git Manager to dashboard for repository visualization and management. View commits with diffs, manage branches, see worktree/task associations, and perform fetch/pull/push operations directly from the web UI.
```

**Artifacts:**
- `packages/dashboard/README.md` (modified)
- `.changeset/add-git-manager.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — Add "Git Manager" section under Features describing the new component and its capabilities

**Check If Affected:**
- `packages/dashboard/README.md` — Verify API documentation section if it exists and add git endpoints

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` in dashboard package)
- [ ] Build passes (`pnpm build`)
- [ ] Git Manager modal opens from header button
- [ ] Status tab shows current branch and repository state
- [ ] Commits tab lists commits and shows diffs when clicked
- [ ] Branches tab lists branches with create/checkout/delete functionality
- [ ] Worktrees tab shows all worktrees with task associations
- [ ] Remotes tab provides fetch/pull/push buttons
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-030): complete Step N — description`
- **Bug fixes:** `fix(KB-030): description`
- **Tests:** `test(KB-030): description`

Example commits:
- `feat(KB-030): complete Step 1 — add git info API endpoints`
- `feat(KB-030): complete Step 2 — add git action endpoints`
- `feat(KB-030): complete Step 3 — add git API client functions`
- `feat(KB-030): complete Step 4 — create GitManagerModal component`
- `feat(KB-030): complete Step 5 — integrate Git Manager into App and Header`
- `test(KB-030): add GitManagerModal tests`
- `feat(KB-030): complete Step 7 — documentation and changeset`

## Do NOT

- Execute destructive git commands without confirmation (branch delete, force push)
- Allow arbitrary command injection through branch names (validate all inputs)
- Modify the actual git repository during tests (mock all git operations)
- Create new core types when existing Task types suffice
- Add server-sent events for git status updates (poll on open/tab switch only)
- Support merge conflict resolution in the UI (show error, direct to CLI)
- Create worktrees through the UI (worktrees are managed by the scheduler)
- Support multiple remotes beyond origin for MVP (fetch/pull/push use origin)
- Implement staging/commit functionality (out of scope — scheduler handles commits)
- Skip writing tests for any new API endpoint or component
