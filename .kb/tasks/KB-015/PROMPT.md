# Task: KB-015 - GitHub Import Remote Dropdown

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** UI enhancement to pre-populate GitHub owner/repo from git remotes. Well-defined scope with clear file targets, no security risks, and reversible changes.
**Score:** 3/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Enhance the GitHub import modal to automatically detect git remotes from the current repository and present them as a dropdown. When the modal opens, fetch the list of remotes from the backend. If only one GitHub remote exists, pre-populate the owner/repo fields automatically. If multiple exist, show a dropdown allowing the user to select which remote to import from. This eliminates manual typing and reduces errors when importing issues.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/GitHubImportModal.tsx` — Current implementation with owner/repo input fields
- `packages/dashboard/app/api.ts` — API client functions (add new function following existing patterns)
- `packages/dashboard/src/routes.ts` — Backend API routes (add new endpoint following existing GitHub routes pattern)
- `packages/dashboard/app/styles.css` — Form styling (lines 649-680 for select elements, lines 1647-1662 for form-row)
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` — Test patterns for the modal
- `packages/dashboard/src/routes.test.ts` — Backend route test patterns

## File Scope

- `packages/dashboard/src/routes.ts` — Add new `/api/git/remotes` endpoint
- `packages/dashboard/app/api.ts` — Add `fetchGitRemotes()` function and `GitRemote` interface
- `packages/dashboard/app/components/GitHubImportModal.tsx` — Add remote selection dropdown and auto-populate logic
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` — Add tests for remote dropdown functionality
- `packages/dashboard/src/routes.test.ts` — Add tests for new endpoint

## Steps

### Step 1: Backend API - Git Remotes Endpoint

- [ ] Add `GET /api/git/remotes` endpoint in `packages/dashboard/src/routes.ts`
- [ ] Execute `git remote -v` to get all remotes with their URLs
- [ ] Parse output to extract remote name, owner, and repo from GitHub URLs (handle both HTTPS and SSH formats)
- [ ] Return array of `{ name: string, owner: string, repo: string, url: string }`
- [ ] Handle errors gracefully (return empty array if not a git repo or git not available)
- [ ] Run targeted tests for the new endpoint

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified — add tests)

### Step 2: Frontend API Client

- [ ] Add `GitRemote` interface to `packages/dashboard/app/api.ts` with `{ name: string, owner: string, repo: string, url: string }`
- [ ] Add `fetchGitRemotes()` function that calls `GET /api/git/remotes`
- [ ] Follow existing pattern from other API functions in the file
- [ ] Run targeted tests

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/api.test.ts` (modified — add tests if file exists, otherwise verify via component tests)

### Step 3: GitHub Import Modal Enhancement

- [ ] Add state for `remotes`, `selectedRemoteName`, and `loadingRemotes` in GitHubImportModal
- [ ] Fetch remotes when modal opens (in the existing `useEffect` that resets state)
- [ ] Add dropdown UI for remote selection when multiple GitHub remotes exist
- [ ] Auto-select and populate owner/repo when only one remote exists
- [ ] Update owner/repo fields when dropdown selection changes
- [ ] Handle case where no remotes exist (show inputs as before)
- [ ] Handle loading state while fetching remotes
- [ ] Keep existing manual input capability as fallback
- [ ] Run component tests

**Artifacts:**
- `packages/dashboard/app/components/GitHubImportModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all dashboard tests must pass
- [ ] Run `pnpm build` — must complete without errors
- [ ] Manual verification: Open GitHub import modal in dashboard, verify remotes load and populate correctly

### Step 5: Documentation & Delivery

- [ ] No documentation updates required (UI is self-explanatory)
- [ ] Create changeset file for the feature:
  ```bash
  cat > .changeset/github-import-remote-dropdown.md << 'EOF'
  ---
  "@kb/dashboard": minor
  ---

  GitHub import now detects git remotes and pre-populates owner/repo fields.
  EOF
  ```

## Documentation Requirements

**Must Update:**
- None — UI change is self-explanatory

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `/api/git/remotes` endpoint returns correct data
- [ ] Dropdown appears when multiple GitHub remotes exist
- [ ] Fields auto-populate when single remote exists
- [ ] Manual entry still works as fallback

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-015): complete Step N — description`
- **Bug fixes:** `fix(KB-015): description`
- **Tests:** `test(KB-015): description`

## Do NOT

- Remove the manual owner/repo input capability
- Break existing GitHub import functionality
- Add dependencies on external git libraries (use child_process)
- Skip tests for the new endpoint and UI behavior
- Change the API response format for existing GitHub endpoints
