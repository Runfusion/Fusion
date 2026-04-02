# Task: KB-307 - Add Remote Commit Sync View to Git Manager

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves extending both backend API and frontend UI for the Git Manager. The blast radius is limited to the git routes and GitManagerModal component. Pattern novelty is low (follows existing git status/commit patterns). No security concerns beyond existing git command validation.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add a "Remote Sync" view to the Git Manager that shows the actual commits that would be pushed or pulled. Currently, the Git Manager only displays ahead/behind counts in the Status panel. Users need to see the commit details (hash, message, author, date) for commits that exist on the remote but not locally (to pull) and commits that exist locally but not on the remote (to push). This enables users to understand exactly what changes are pending sync before performing push/pull operations.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/routes.ts` — Existing git API routes (getGitStatus, getGitCommits, getCommitDiff)
- `packages/dashboard/app/components/GitManagerModal.tsx` — Git Manager UI component with existing sections (Status, Changes, Commits, Branches, etc.)
- `packages/dashboard/app/api.ts` — API client functions for git operations
- `packages/dashboard/app/styles.css` — CSS classes for Git Manager (gm-* prefix)

Key patterns to follow:
- Git command execution via `execSync` with timeouts
- Branch name validation via `isValidBranchName()`
- Hash validation with regex `/^[a-f0-9]{7,40}$/i`
- API response types (GitCommit, GitStatus)
- Modal section structure with `SECTIONS` array and sidebar navigation

## File Scope

- `packages/dashboard/src/routes.ts` — Add new API endpoint(s) for remote sync commits
- `packages/dashboard/app/api.ts` — Add API client function(s)
- `packages/dashboard/app/components/GitManagerModal.tsx` — Add Remote Sync UI panel
- `packages/dashboard/app/styles.css` — Add CSS classes for remote sync display

## Steps

### Step 1: Backend API for Remote Sync Commits

- [ ] Add `getRemoteSyncCommits()` helper function in `routes.ts` following existing git helper patterns
  - Execute `git rev-list --left-right --cherry-pick HEAD...@{u}` to get commit hashes
  - Parse left side (local ahead) and right side (remote ahead/our behind)
  - For each commit hash, get details via `git log -1 --format="%H|%h|%s|%an|%aI" <hash>`
  - Return structured data with two arrays: `toPush` (local commits) and `toPull` (remote commits)
- [ ] Add `GET /api/git/remote-sync` endpoint in the router
  - Validate git repository with `isGitRepo()`
  - Call helper and return `{ toPush: GitCommit[], toPull: GitCommit[] }`
  - Handle errors: no upstream configured (400), not a git repo (400), git command failures (500)
  - Add proper TypeScript types

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: API Client Function

- [ ] Add `fetchRemoteSyncCommits()` function in `api.ts`
  - Return type: `Promise<{ toPush: GitCommit[], toPull: GitCommit[] }>`
  - Use existing `api<T>()` helper
  - Reuse `GitCommit` type from existing definitions

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 3: UI Section Addition

- [ ] Add "remote-sync" to the `SECTIONS` array in GitManagerModal
  - Use `GitPullRequest` or `ArrowLeftRight` icon from lucide-react
  - Label: "Remote Sync"
- [ ] Add state management for remote sync panel:
  - `remoteSyncData: { toPush: GitCommit[], toPull: GitCommit[] } | null`
  - `selectedRemoteCommit: string | null` (for viewing diffs)
  - `remoteCommitDiff: { stat: string, patch: string } | null`
- [ ] Add data fetching in `fetchSectionData` for "remote-sync" section
- [ ] Create `RemoteSyncPanel` component within GitManagerModal.tsx (following other panel patterns)
  - Show two sections: "To Push" (local ahead) and "To Pull" (remote ahead)
  - Display commit list with hash, message, author, relative date
  - Click to view commit diff (reuse existing diff viewer pattern)
  - Show count badges for each section
  - Handle empty states with helpful messages
  - Show warning when no upstream is configured

**Artifacts:**
- `packages/dashboard/app/components/GitManagerModal.tsx` (modified)

### Step 4: Styling

- [ ] Add CSS classes to `styles.css` for remote sync panel:
  - `.gm-remote-sync-panel` — panel container
  - `.gm-remote-sync-section` — individual to-push/to-pull sections
  - `.gm-remote-sync-header` — section headers with count badges
  - `.gm-remote-sync-empty` — empty state styling
  - Follow existing `.gm-*` naming convention and styling patterns
  - Use existing color variables: `--color-success` for push, `--color-info` or `--todo` for pull

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Manual verification:
  - Open Git Manager on a branch with upstream configured
  - Navigate to "Remote Sync" section
  - Verify commits to push/pull are displayed correctly
  - Click a commit to view its diff
  - Verify empty states when up-to-date
  - Verify error message when no upstream configured

### Step 6: Documentation & Delivery

- [ ] No documentation updates required (feature is self-discoverable in UI)
- [ ] Out-of-scope findings: None expected

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `GET /api/git/remote-sync` endpoint returns correct commit lists
- [ ] Remote Sync panel displays in Git Manager with proper styling
- [ ] Can view diffs for pending commits
- [ ] Proper empty states and error handling

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-307): complete Step N — description`
- **Bug fixes:** `fix(KB-307): description`
- **Tests:** `test(KB-307): description`

## Do NOT

- Expand scope to include automatic push/pull buttons (view-only feature)
- Modify existing git commands or break existing Git Manager functionality
- Skip the branch name/hash validation patterns used elsewhere
- Create a separate component file (follow existing inline panel pattern)
- Add complex merge conflict preview (out of scope)
