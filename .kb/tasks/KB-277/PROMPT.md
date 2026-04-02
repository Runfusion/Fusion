# Task: KB-277 - The git panel should have a way to manage remotes

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This involves both backend API changes (new endpoints) and UI updates to the GitManagerModal. The patterns are well-established in the codebase, but it requires proper input validation and error handling for git operations.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Enhance the Git Manager's "Remotes" panel to provide full remote management capabilities. Currently the panel only supports Fetch/Pull/Push operations. This task adds the ability to view all configured remotes, add new remotes, remove existing ones, rename remotes, and update remote URLs — giving users complete control over their repository's remote configuration from within the dashboard.

## Dependencies

- **None**

## Context to Read First

1. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/GitManagerModal.tsx` — Current GitManagerModal implementation, especially the `RemotesPanel` component (lines 1490-1552)
2. `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Existing git API functions like `fetchGitRemotes`, `fetchRemote`
3. `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Backend route patterns for git operations (see `GET /git/remotes`, `POST /git/fetch` patterns)
4. `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Existing `.gm-remote-*` CSS classes (lines 10511-10547)
5. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` — Test patterns for existing remote panel tests

## File Scope

- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Add new API endpoints for remote management
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Add new frontend API functions
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/GitManagerModal.tsx` — Enhance RemotesPanel with remote management UI
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Add styles for new remote management UI elements
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` — Add tests for new remote management functionality

## Steps

### Step 1: Backend API Endpoints

Add git remote management endpoints following existing patterns in routes.ts.

- [ ] Add `GET /git/remotes/detailed` endpoint that returns all remotes with both fetch and push URLs (extend existing `getGitHubRemotes` to return all remotes, not just GitHub ones)
- [ ] Add `POST /git/remotes` endpoint to add a new remote (body: `{ name: string, url: string }`)
- [ ] Add `DELETE /git/remotes/:name` endpoint to remove a remote
- [ ] Add `PATCH /git/remotes/:name` endpoint to rename a remote (body: `{ newName: string }`)
- [ ] Add `PUT /git/remotes/:name/url` endpoint to update remote URL (body: `{ url: string }`)
- [ ] Add helper functions in routes.ts for git remote operations:
  - `listGitRemotes()` — Returns `Array<{ name: string, fetchUrl: string, pushUrl: string }>`
  - `addGitRemote(name: string, url: string)` — Runs `git remote add <name> <url>`
  - `removeGitRemote(name: string)` — Runs `git remote remove <name>`
  - `renameGitRemote(oldName: string, newName: string)` — Runs `git remote rename <old> <new>`
  - `setGitRemoteUrl(name: string, url: string)` — Runs `git remote set-url <name> <url>`
- [ ] Validate remote names using existing `isValidBranchName` pattern (prevents shell injection)
- [ ] Validate URLs (must be valid git URL format: https://, git@, or file://)
- [ ] Handle git errors and return appropriate HTTP status codes (400 for invalid input, 409 if remote exists, 404 if remote doesn't exist)
- [ ] Run backend tests: `pnpm test packages/dashboard/src/routes.test.ts` if it exists, or verify via dashboard startup

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` (modified)

### Step 2: Frontend API Functions

Add TypeScript API functions in api.ts following existing patterns.

- [ ] Add `fetchGitRemotesDetailed(): Promise<GitRemoteDetailed[]>` function
- [ ] Add `addGitRemote(name: string, url: string): Promise<void>` function
- [ ] Add `removeGitRemote(name: string): Promise<void>` function  
- [ ] Add `renameGitRemote(name: string, newName: string): Promise<void>` function
- [ ] Add `updateGitRemoteUrl(name: string, url: string): Promise<void>` function
- [ ] Export new `GitRemoteDetailed` interface:
  ```typescript
  export interface GitRemoteDetailed {
    name: string;
    fetchUrl: string;
    pushUrl: string;
  }
  ```
- [ ] Add proper error handling that throws user-friendly error messages
- [ ] Write unit tests in `packages/dashboard/app/api.test.ts` for new functions (mock fetch API)

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` (modified)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.test.ts` (modified)

### Step 3: Enhanced RemotesPanel UI

Replace the simple RemotesPanel with full remote management capabilities.

- [ ] Update `RemotesPanel` component to show list of all remotes with their fetch/push URLs
- [ ] Add "Add Remote" form with inputs for name and URL, plus an "Add" button
- [ ] Add action buttons for each remote:
  - Rename button (opens inline edit or modal)
  - Set URL button (opens inline edit or modal)
  - Remove button with confirmation dialog
- [ ] Add state variables: `remotes` array, `newRemoteName`, `newRemoteUrl`, `editingRemote`, `editUrlValue`
- [ ] Implement handlers: `handleAddRemote`, `handleRemoveRemote`, `handleRenameRemote`, `handleUpdateUrl`
- [ ] Show loading states during operations (`remoteActionLoading` state)
- [ ] Display error messages inline when operations fail
- [ ] Use existing UI patterns from BranchesPanel (create form with input + button, list items with actions)
- [ ] Fetch detailed remotes when "remotes" section becomes active
- [ ] Refresh remote list after any modification operation

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/GitManagerModal.tsx` (modified)

### Step 4: Styling

Add CSS styles for the new remote management UI.

- [ ] Add `.gm-remote-list` — Container for remote entries
- [ ] Add `.gm-remote-item` — Individual remote row with name and URLs
- [ ] Add `.gm-remote-name` — Remote name styling
- [ ] Add `.gm-remote-urls` — Container for fetch/push URLs
- [ ] Add `.gm-remote-url` — Individual URL display
- [ ] Add `.gm-remote-form` — Add/edit remote form layout
- [ ] Add `.gm-remote-actions-inline` — Action buttons container per remote
- [ ] Add `.gm-remote-edit` — Inline editing state styles
- [ ] Follow existing naming convention (`.gm-*`) and color variable patterns
- [ ] Ensure responsive behavior for mobile (stack elements vertically)

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` (modified)

### Step 5: Testing & Verification

Add comprehensive tests for the new remote management functionality.

- [ ] Add tests in `GitManagerModal.test.tsx`:
  - "shows list of remotes with URLs"
  - "adds a new remote successfully"
  - "shows error when adding remote with invalid name"
  - "removes a remote with confirmation"
  - "renames a remote"
  - "updates remote URL"
  - "shows loading state during remote operations"
  - "handles API errors gracefully"
- [ ] Mock the new API functions in the test's `vi.mock` block
- [ ] Ensure all tests pass: `pnpm test packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx`
- [ ] Run full test suite: `pnpm test`
- [ ] Verify build passes: `pnpm build`

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` (modified)

### Step 6: Documentation & Delivery

- [ ] Update dashboard documentation if there's a user guide section about Git Manager
- [ ] Create changeset file for the change:
  ```bash
  cat > .changeset/add-remote-management.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add remote management to Git Manager panel. Users can now view, add, remove, rename, and update git remotes from the dashboard.
  EOF
  ```
- [ ] Test manually in browser:
  1. Open Git Manager → Remotes tab
  2. Verify existing remotes are listed
  3. Add a test remote
  4. Rename the test remote
  5. Update the test remote's URL
  6. Remove the test remote
- [ ] Ensure no out-of-scope changes were made

**Artifacts:**
- `.changeset/add-remote-management.md` (new)

## Documentation Requirements

**Must Update:**
- None (feature is self-documenting through UI)

**Check If Affected:**
- Any dashboard user documentation mentioning Git Manager features

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` shows 0 failures)
- [ ] Build passes (`pnpm build` succeeds)
- [ ] Manual testing confirms: list, add, remove, rename, and update URL operations work correctly
- [ ] Input validation prevents invalid remote names and malformed URLs
- [ ] Error handling shows user-friendly messages for git errors
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-277): complete Step N — description`
- **Bug fixes:** `fix(KB-277): description`
- **Tests:** `test(KB-277): description`

## Do NOT

- Modify other git operations (fetch/pull/push) — those stay as-is
- Add authentication/credential management for remotes (out of scope)
- Support multiple URLs per remote (out of scope — use `git remote set-url --add` manually)
- Create a separate modal for remote management — keep it in the existing Remotes panel
- Modify the git CLI tool in `packages/cli/src/commands/git.ts` — dashboard-only feature
- Skip test coverage for new API endpoints and UI components
