# Task: KB-022 - GitHub Badges on Task Cards

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves UI changes to TaskCard, API additions for fetching issue state, and styling updates. It touches both frontend and backend with moderate complexity but follows established patterns.
**Score:** 5/8 — Blast radius: 1 (localized to TaskCard), Pattern novelty: 1 (follows PR badge pattern), Security: 1 (GitHub API calls), Reversibility: 2 (easy to revert UI changes)

## Mission

Display clickable GitHub badges on task cards for both PR-linked tasks and GitHub-imported issues. The badges show in the card header, use state-appropriate colors (green for open, red for closed, purple for merged/completed), and open the GitHub link in a new tab when clicked.

This improves visibility of GitHub connections at a glance and provides quick access to the original GitHub resource.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Task type definition (prInfo field pattern)
- `packages/core/src/store.ts` — TaskStore with `updatePrInfo` method pattern
- `packages/dashboard/app/components/TaskCard.tsx` — Current card implementation with PR badge (in-review only)
- `packages/dashboard/app/components/PrSection.tsx` — PR status colors and patterns
- `packages/dashboard/app/styles.css` — Card and badge styling
- `packages/dashboard/app/api.ts` — API client patterns
- `packages/dashboard/src/routes.ts` — GitHub API routes and rate limiting
- `packages/dashboard/src/github.ts` — GitHubClient class
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing test patterns

## File Scope

- `packages/core/src/types.ts` — Add IssueInfo type and update Task type
- `packages/core/src/store.ts` — Add updateIssueInfo method
- `packages/dashboard/app/components/TaskCard.tsx` — Add GitHub badges to card header
- `packages/dashboard/app/components/GitHubBadge.tsx` — New unified component for issue/PR badges
- `packages/dashboard/app/api.ts` — Add issue status fetching API
- `packages/dashboard/src/routes.ts` — Add `/tasks/:id/issue/status` and `/tasks/:id/issue/refresh` endpoints
- `packages/dashboard/src/github.ts` — Add `getIssueStatus` method to GitHubClient
- `packages/dashboard/app/styles.css` — Add `.card-issue-badge` and `.card-github-badge` styles
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Add tests for badge logic
- `packages/dashboard/app/components/__tests__/GitHubBadge.test.tsx` — New tests for GitHubBadge component

## Steps

### Step 1: Extend Core Types for Issue Tracking

- [ ] Add `IssueInfo` interface to `packages/core/src/types.ts` (mirrors PrInfo pattern):
  - `url: string` — Full GitHub issue URL
  - `number: number` — Issue number
  - `state: "open" | "closed"` — Issue state
  - `title: string` — Issue title
  - `stateReason?: "completed" | "not_planned" | "reopened"` — Why closed (for coloring)
  - `lastCheckedAt?: string` — ISO timestamp for cache freshness
- [ ] Add optional `issueInfo?: IssueInfo` field to Task type
- [ ] Run `pnpm build` in `packages/core` to verify no type errors

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Add TaskStore Method for Issue Info

- [ ] Add `updateIssueInfo(id: string, issueInfo: IssueInfo | null): Promise<Task>` method to TaskStore in `packages/core/src/store.ts`:
  - Follow the exact pattern from `updatePrInfo` (lines ~1034-1070)
  - Use `withTaskLock` for atomic updates
  - Emit `task:updated` event when issue info changes
  - Log entry when issue linked/unlinked
- [ ] Add `issueInfo` field handling to the Task type in store operations

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 3: Add Server-Side Issue Status Endpoint

- [ ] Add `getIssueStatus(owner, repo, number)` method to `GitHubClient` in `packages/dashboard/src/github.ts`:
  - Fetch from `/repos/{owner}/{repo}/issues/{number}`
  - Return IssueInfo with state, state_reason, title, url
  - Handle 404 errors gracefully
- [ ] Add GET `/tasks/:id/issue/status` route in `packages/dashboard/src/routes.ts`:
  - Parse owner/repo from current git remote (reuse existing `getCurrentGitHubRepo`)
  - Check rate limiter before making request (reuse `GitHubRateLimiter`)
  - Return cached issue info or fetch fresh
  - Return 404 if task has no issue info and no issue URL in description
- [ ] Add POST `/tasks/:id/issue/refresh` route for manual refresh (mirrors PR refresh pattern)

**Artifacts:**
- `packages/dashboard/src/github.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)

### Step 4: Add API Client Functions

- [ ] Add `fetchIssueStatus(taskId: string): Promise<{ issueInfo: IssueInfo; stale: boolean }>` function in `packages/dashboard/app/api.ts`
- [ ] Add `refreshIssueStatus(taskId: string): Promise<IssueInfo>` function for manual refresh
- [ ] Re-export `IssueInfo` type from `@kb/core` in api.ts

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 5: Create GitHubBadge Component

- [ ] Create `packages/dashboard/app/components/GitHubBadge.tsx` (unified component):
  - Props interface:
    - `prInfo?: PrInfo` — PR information (if task has linked PR)
    - `issueInfo?: IssueInfo` — Issue information (if task imported from GitHub)
    - `onIssueRefresh?: () => void` — Callback when issue refresh requested
  - Render logic:
    - If `prInfo` exists: show PR badge with `GitPullRequest` icon
    - If `issueInfo` exists: show Issue badge with `CircleDot` icon (from lucide-react)
    - Both can appear simultaneously if task has both
  - Color scheme:
    - PR open: green (#3fb950)
    - PR closed: red (#da3633)
    - PR merged: purple (#bc8cff)
    - Issue open: green (#3fb950)
    - Issue closed (completed): purple (#bc8cff)
    - Issue closed (not_planned): red (#f85149)
    - Issue closed (no reason/reopened): gray (#8b949e)
  - Click handler: `window.open(url, "_blank", "noopener,noreferrer")`
  - Tooltip showing "PR #N: Title" or "Issue #N: Title" on hover using `title` attribute

**Artifacts:**
- `packages/dashboard/app/components/GitHubBadge.tsx` (new)

### Step 6: Update TaskCard to Show Badges

- [ ] Modify `TaskCard.tsx` card-header section:
  - Import `GitHubBadge` component
  - Remove existing inline PR badge code (lines ~95-115, the in-review-only PR badge)
  - Add `<GitHubBadge prInfo={task.prInfo} />` to card-header
  - Add logic to parse GitHub issue URL from task description:
    - Regex: `/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/`
    - Extract owner, repo, issue number
  - Add `useEffect` to fetch issue status when component mounts:
    - Only if description contains issue URL and no cached `issueInfo`
    - Use `fetchIssueStatus` API
    - Debounce to avoid rapid re-fetches
- [ ] Ensure badges display in ALL columns (not just in-review)

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 7: Add CSS Styles

- [ ] Add `.card-github-badge` base styles to `packages/dashboard/app/styles.css`:
  - Font size: 11px
  - Padding: 2px 6px
  - Border radius: 10px
  - Display: inline-flex with align-items: center
  - Gap: 4px
  - Cursor: pointer
  - Transition for hover effect
- [ ] Add `.card-github-badge:hover` with slight background lighten
- [ ] Add modifier classes for colors:
  - `.card-github-badge--open` — green background/text
  - `.card-github-badge--closed` — red background/text
  - `.card-github-badge--merged` — purple background/text
  - `.card-github-badge--completed` — purple background/text

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `packages/dashboard/app/components/__tests__/GitHubBadge.test.tsx`:
  - Test PR badge renders with correct number and icon
  - Test Issue badge renders with correct number and icon
  - Test color classes applied correctly for each state
  - Test click calls `window.open` with correct URL and target
  - Test both badges can appear simultaneously
- [ ] Add tests to `TaskCard.test.tsx`:
  - Test `extractIssueUrl` helper function (parsing GitHub URLs from description)
  - Test card-header shows GitHubBadge when prInfo present
  - Test badge colors based on PR/issue state
- [ ] Run `pnpm test` — fix all failures
- [ ] Run `pnpm build` — ensure build passes

**Artifacts:**
- `packages/dashboard/app/components/__tests__/GitHubBadge.test.tsx` (new)
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)

### Step 9: Documentation & Delivery

- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/github-badges-on-cards.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add GitHub issue and PR badges to task cards in the dashboard. Badges display in the card header with colors indicating state (open=green, closed=red, merged/completed=purple). Clicking a badge opens the GitHub link in a new tab.
  EOF
  ```
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Real-time badge updates via WebSocket (currently polling-based)
  - Batch issue status fetching for performance with many cards

## Documentation Requirements

**Must Update:**
- None (this is a UI feature that is self-documenting via the interface)

**Check If Affected:**
- `AGENTS.md` — No changes needed (dashboard UI feature)

## Completion Criteria

- [ ] GitHub issue badges appear on cards when task description contains GitHub issue URL
- [ ] PR badges appear on cards in ALL columns (not just in-review)
- [ ] Badges are colored correctly based on PR/issue state
- [ ] Clicking a badge opens the GitHub link in a new tab
- [ ] Both PR and Issue badges can appear on the same card
- [ ] All tests passing
- [ ] Build passes
- [ ] No console errors or warnings

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-022): complete Step N — description`
- **Bug fixes:** `fix(KB-022): description`
- **Tests:** `test(KB-022): description`

## Do NOT

- Remove the existing PR badge functionality entirely — migrate it to the new component
- Change how PR creation works — only the display is changing
- Modify the GitHub import flow — issue URL stays in description
- Add drag-and-drop support to badges — they are clickable links only
- Use external icon libraries — stick with lucide-react icons
- Fetch issue status on every render — cache and debounce appropriately
- Create separate components for PR vs Issue badges — use the unified GitHubBadge component
