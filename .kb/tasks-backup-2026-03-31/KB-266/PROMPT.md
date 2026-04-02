# Task: KB-266 - The git manager UI needs a complete overhaul

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** The git manager is a critical UI surface for repository operations. Changes affect multiple sections (status, commits, branches, worktrees, remotes) with significant user-facing impact. A full review ensures the new design is cohesive and handles edge cases properly.

**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 1, Reversibility: 2

## Mission

Transform the existing GitManagerModal from a basic read-only status viewer into a comprehensive, interactive git workbench. The current implementation only displays information and supports limited branch operations. The overhauled version must support the full git workflow: viewing and staging unstaged changes, committing, stashing, interactive branch management with merge conflict indicators, and a visual commit graph. The goal is to make the git manager a tool users actually want to use instead of dropping to the terminal.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/GitManagerModal.tsx` — Current implementation to understand existing sections and API usage
- `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` — Current test coverage
- `packages/dashboard/app/api.ts` — Git-related API functions and types (search for "Git Management API" section)
- `packages/dashboard/src/routes.ts` — Server-side git routes (search for "Git Status Routes" and "Git Action Routes")
- `packages/dashboard/app/styles.css` — Existing CSS classes used by modals (search for `.modal-*` patterns)
- `packages/dashboard/app/components/GitHubImportModal.tsx` — Reference for complex modal with multiple sections and good styling patterns

## File Scope

- `packages/dashboard/app/components/GitManagerModal.tsx` (complete rewrite)
- `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` (comprehensive new tests)
- `packages/dashboard/app/styles.css` (new CSS classes for git manager — add to end of file)
- `packages/dashboard/app/api.ts` (new API functions: `fetchGitStashList`, `createStash`, `applyStash`, `dropStash`, `fetchUnstagedDiff`, `stageFiles`, `unstageFiles`, `createCommit`)

## Steps

### Step 1: Design New Component Architecture

- [ ] Analyze current component structure and identify improvement areas
- [ ] Design new sub-component structure: `GitStatusPanel`, `GitCommitsPanel`, `GitBranchesPanel`, `GitWorktreesPanel`, `GitRemotesPanel`, `GitStashPanel`, `DiffViewer`, `FileChangeList`
- [ ] Define shared types and utilities within the component file
- [ ] Document the new user interaction flow for each section

**Artifacts:**
- `packages/dashboard/app/components/GitManagerModal.tsx` (structure defined, sub-components outlined)

### Step 2: Implement Core UI Structure and Navigation

- [ ] Rewrite main `GitManagerModal` component with improved layout
- [ ] Implement responsive sidebar navigation with icons (Status, Changes, Commits, Branches, Worktrees, Stashes, Remotes)
- [ ] Add collapsible sections for better space utilization
- [ ] Implement keyboard navigation (arrow keys, Enter, Escape)
- [ ] Add loading states and error boundaries for each section

**Artifacts:**
- `packages/dashboard/app/components/GitManagerModal.tsx` (core structure)

### Step 3: Implement Status & Changes Panel (File Operations)

- [ ] Create `FileChangeList` component showing unstaged/staged files with status indicators (added, modified, deleted, renamed)
- [ ] Add file selection with checkboxes for batch operations
- [ ] Implement "Stage All", "Unstage All", and individual file stage/unstage buttons
- [ ] Add diff preview for selected unstaged file (using existing `fetchCommitDiff` pattern)
- [ ] Implement commit form with message input and "Commit" button
- [ ] Show current branch, ahead/behind counts, and dirty state prominently
- [ ] Add quick actions: "Stage all and commit", "Discard changes" (with confirmation)

**Artifacts:**
- `packages/dashboard/app/components/GitManagerModal.tsx` (Status & Changes sections)

### Step 4: Implement Enhanced Commits Panel

- [ ] Replace simple list with commit graph visualization (ASCII art or simple SVG)
- [ ] Add branch/tag labels inline with commits
- [ ] Implement commit search/filter by message or author
- [ ] Improve diff viewer with syntax highlighting support (reuse existing diff display pattern)
- [ ] Add "Copy commit hash" and "Checkout this commit" actions
- [ ] Implement "Revert commit" action with confirmation

**Artifacts:**
- `packages/dashboard/app/components/GitManagerModal.tsx` (Commits section)

### Step 5: Implement Stash Management Panel

- [ ] Create new "Stashes" section in navigation
- [ ] Display list of stashes with message, date, and stash@{n} reference
- [ ] Implement "Stash changes" button with optional message input
- [ ] Add "Apply stash" (with keep/drop option) and "Drop stash" actions
- [ ] Show stash contents preview (files affected)

**Artifacts:**
- `packages/dashboard/app/components/GitManagerModal.tsx` (Stash section)

### Step 6: Enhance Branches Panel

- [ ] Add visual branch graph showing merge relationships
- [ ] Implement branch search/filter
- [ ] Show branch ahead/behind counts relative to upstream
- [ ] Add "Merge branch into current" action with conflict warning
- [ ] Add "Rebase current onto branch" action
- [ ] Implement branch rename functionality
- [ ] Improve branch creation UI with better base branch selection (dropdown of existing branches)

**Artifacts:**
- `packages/dashboard/app/components/GitManagerModal.tsx` (Branches section)

### Step 7: Enhance Worktrees and Remotes Panels

- [ ] Improve worktree display with visual folder tree
- [ ] Add "Prune" action for worktrees with deleted task branches
- [ ] Show last activity timestamp for each worktree
- [ ] Add "Open in terminal" action for worktrees (integrates with existing terminal modal)
- [ ] Enhance remotes panel with fetch/push/pull buttons per remote
- [ ] Add remote URL display with "Copy" button
- [ ] Show recent remote operation results with timestamps

**Artifacts:**
- `packages/dashboard/app/components/GitManagerModal.tsx` (Worktrees and Remotes sections)

### Step 8: Add CSS Styles

- [ ] Add comprehensive CSS classes for all new git manager components
- [ ] Follow existing dashboard design patterns (card-based layouts, hover states, focus rings)
- [ ] Ensure responsive design for mobile (stacked layout, touch-friendly buttons)
- [ ] Support both light and dark themes using CSS variables
- [ ] Add smooth transitions for panel switching and expanding/collapsing

**Artifacts:**
- `packages/dashboard/app/styles.css` (new git manager CSS classes appended)

### Step 9: Update API Layer

- [ ] Add types: `GitStash`, `GitFileChange`, `CreateCommitInput`
- [ ] Implement `fetchGitStashList()`: GET `/git/stashes`
- [ ] Implement `createStash(message?: string)`: POST `/git/stashes`
- [ ] Implement `applyStash(index: number, drop?: boolean)`: POST `/git/stashes/${index}/apply`
- [ ] Implement `dropStash(index: number)`: DELETE `/git/stashes/${index}`
- [ ] Implement `fetchUnstagedDiff()`: GET `/git/diff`
- [ ] Implement `stageFiles(files: string[])`: POST `/git/stage`
- [ ] Implement `unstageFiles(files: string[])`: POST `/git/unstage`
- [ ] Implement `createCommit(message: string)`: POST `/git/commit`
- [ ] Add server routes for each new endpoint (update `packages/dashboard/src/routes.ts`)

**Artifacts:**
- `packages/dashboard/app/api.ts` (new git API functions)
- `packages/dashboard/src/routes.ts` (new server routes)

### Step 10: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Write comprehensive tests for new `GitManagerModal` component
- [ ] Test each panel: Status (staging, committing), Commits, Branches, Worktrees, Stashes, Remotes
- [ ] Test keyboard navigation and accessibility
- [ ] Test error states and loading states
- [ ] Test mobile responsive behavior
- [ ] Add tests for new API functions
- [ ] Add server route tests for new git endpoints
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` (complete test suite)
- `packages/dashboard/src/routes.test.ts` (additional route tests if needed)

### Step 11: Documentation & Delivery

- [ ] Add JSDoc comments for all new component functions and types
- [ ] Update any dashboard documentation mentioning git manager
- [ ] Create changeset for the feature (minor bump — new functionality)
- [ ] Verify all new features work end-to-end manually
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any features couldn't be completed)

**Artifacts:**
- `.changeset/git-manager-overhaul.md`

## Documentation Requirements

**Must Update:**
- None (this is a UI-only change with no external documentation)

**Check If Affected:**
- `AGENTS.md` — Check if git manager is mentioned in any agent instructions

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Build passes
- [ ] Git manager opens and all 6+ sections are accessible
- [ ] File staging/unstaging works correctly
- [ ] Commits can be created from the UI
- [ ] Stash operations work (create, apply, drop)
- [ ] Branch operations work (create, checkout, delete, merge indicators)
- [ ] Responsive layout works on mobile widths
- [ ] Both light and dark themes render correctly

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-266): complete Step N — description`
- **Bug fixes:** `fix(KB-266): description`
- **Tests:** `test(KB-266): description`

Example commits:
- `feat(KB-266): complete Step 1 — design new component architecture`
- `feat(KB-266): complete Step 2 — implement core UI structure and navigation`
- `feat(KB-266): complete Step 3 — implement status and changes panel`

## Do NOT

- Change the existing git CLI backend implementation (keep using `execSync` pattern in routes.ts)
- Remove any existing functionality — only add to or improve it
- Use external git libraries — continue using child_process execution
- Modify how worktrees are created/used by the engine
- Change the modal opening/closing behavior from App.tsx
- Skip writing tests for new API endpoints
- Break mobile responsiveness — the dashboard is used on various screen sizes
