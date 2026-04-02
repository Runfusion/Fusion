# Task: KB-651 - Changed Files Diff Viewer

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task involves UI modifications and new API endpoints with moderate blast radius affecting the dashboard file browsing experience. The diff viewer pattern already exists in GitManagerModal but needs adaptation for task worktrees.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Modify the dashboard so that when a user clicks "files changed" on a task card, instead of opening the generic file browser, it opens a dedicated changed files viewer that:
1. Shows only the files modified in the task's worktree (compared to base branch)
2. Displays a diff view showing the actual changes for each file
3. Allows navigating between changed files with an easy file list sidebar

This gives users immediate visibility into what the AI agent changed during task execution without needing to browse the entire worktree.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/TaskCard.tsx` — See how `onOpenFilesForTask` is called when clicking the "files changed" button
2. `packages/dashboard/app/App.tsx` — See how `handleOpenFilesForTask` opens the file browser modal
3. `packages/dashboard/app/hooks/useSessionFiles.ts` — Pattern for fetching task-related file data
4. `packages/dashboard/app/components/GitManagerModal.tsx` — See the existing diff viewer implementation (lines 300-400) for styling patterns
5. `packages/dashboard/src/routes.ts` (lines 1795-1835) — See `/tasks/:id/session-files` endpoint implementation
6. `packages/dashboard/app/styles.css` (lines 10188-10240) — Existing `.gm-diff-*` CSS classes available for reuse

## File Scope

### New Files
- `packages/dashboard/app/components/ChangedFilesModal.tsx` — Modal for viewing changed files with diff
- `packages/dashboard/app/hooks/useChangedFiles.ts` — Hook for fetching changed files with diff content

### Modified Files
- `packages/dashboard/app/App.tsx` — Add new modal state and handler
- `packages/dashboard/app/components/TaskCard.tsx` — Change `onOpenFilesForTask` call to open new modal
- `packages/dashboard/src/routes.ts` — Add new API endpoint for task file diffs
- `packages/dashboard/app/api.ts` — Add new API function for fetching task file diffs

### Test Files
- `packages/dashboard/app/hooks/__tests__/useChangedFiles.test.ts` — Tests for the new hook
- `packages/dashboard/app/components/__tests__/ChangedFilesModal.test.tsx` — Tests for the modal component

## Steps

### Step 1: Backend API Endpoint for Task File Diffs

- [ ] Add `GET /api/tasks/:id/file-diffs` endpoint in `packages/dashboard/src/routes.ts`
- [ ] Endpoint should return array of `{ path: string; status: "added" | "modified" | "deleted" | "renamed"; diff: string; oldPath?: string }`
- [ ] Use `git diff --name-status ${baseBranch}...HEAD` to get file statuses
- [ ] Use `git diff ${baseBranch}...HEAD -- "${file}"` for each file to get individual diffs
- [ ] Cache results for 10 seconds (similar to session-files caching pattern)
- [ ] Handle worktree that doesn't exist or has no changes → return empty array
- [ ] Write tests for the new endpoint

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Frontend API Function and Types

- [ ] Add `fetchTaskFileDiffs(taskId: string)` function in `packages/dashboard/app/api.ts`
- [ ] Define `TaskFileDiff` interface with `path`, `status`, `diff`, `oldPath?` fields
- [ ] Return type: `Promise<TaskFileDiff[]>`
- [ ] Use existing `api<T>()` helper for the fetch

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 3: useChangedFiles Hook

- [ ] Create `packages/dashboard/app/hooks/useChangedFiles.ts`
- [ ] Hook takes `taskId: string, worktree: string | undefined, column: string`
- [ ] Returns `{ files: TaskFileDiff[], loading: boolean, error: string | null, selectedFile: TaskFileDiff | null, setSelectedFile: (f: TaskFileDiff) => void }`
- [ ] Only fetch when column is "in-progress" or "in-review" (same logic as useSessionFiles)
- [ ] Auto-select first file when data loads
- [ ] Handle errors gracefully → set error state, not throw
- [ ] Write unit tests for the hook

**Artifacts:**
- `packages/dashboard/app/hooks/useChangedFiles.ts` (new)
- `packages/dashboard/app/hooks/__tests__/useChangedFiles.test.ts` (new)

### Step 4: ChangedFilesModal Component

- [ ] Create `packages/dashboard/app/components/ChangedFilesModal.tsx`
- [ ] Props interface: `{ taskId: string; worktree: string | undefined; column: string; isOpen: boolean; onClose: () => void }`
- [ ] Layout: Two-pane design similar to FileBrowserModal
  - Left sidebar (30%): Scrollable list of changed files with status badges (A/M/D/R)
  - Right pane (70%): Diff viewer for selected file
- [ ] Use existing CSS classes: `.gm-diff-viewer`, `.gm-diff-stat`, `.gm-diff-patch`
- [ ] Show file status icons (FilePlus for added, FileEdit for modified, FileMinus for deleted)
- [ ] Click file in sidebar to view its diff
- [ ] Show "No files changed" placeholder if empty
- [ ] Show "Select a file to view changes" placeholder if none selected
- [ ] Keyboard shortcut: Escape to close modal
- [ ] Loading state while fetching
- [ ] Write unit tests for the component

**Artifacts:**
- `packages/dashboard/app/components/ChangedFilesModal.tsx` (new)
- `packages/dashboard/app/components/__tests__/ChangedFilesModal.test.tsx` (new)

### Step 5: Integrate into App.tsx

- [ ] Add `changedFilesOpen` state and `changedFilesTaskId` state in AppInner
- [ ] Add `handleOpenChangedFiles` callback that sets the taskId and opens modal
- [ ] Add `handleCloseChangedFiles` callback
- [ ] Replace `handleOpenFilesForTask` to call `handleOpenChangedFiles` instead of opening file browser
- [ ] Render `<ChangedFilesModal>` when `changedFilesOpen` is true
- [ ] Pass the task's `id`, `worktree`, and `column` to the modal
- [ ] Remove `fileBrowserWorkspace` state logic that's now unused for task file viewing (keep for header Files button)

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 6: Update TaskCard Props (if needed)

- [ ] Verify `onOpenFilesForTask` prop signature still works with new implementation
- [ ] No changes needed if signature is `(taskId: string) => void`

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (verify only)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure all tests pass
- [ ] Verify new hook tests pass
- [ ] Verify new component tests pass
- [ ] Verify no regressions in FileBrowserModal (still works from header Files button)
- [ ] Manual verification: Create a test task, have it modify some files, click "files changed" and verify:
  - Only changed files appear in sidebar
  - Diff viewer shows actual git diff
  - File status badges (A/M/D) are correct
  - Navigation between files works
  - Empty state works for tasks with no changes
- [ ] Build passes: `pnpm build`

### Step 8: Documentation & Delivery

- [ ] Update dashboard README if there's a user-facing features section (mention the new changed files viewer)
- [ ] Create changeset file for the feature:
  ```bash
  cat > .changeset/changed-files-diff-viewer.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---
  
  Add changed files diff viewer to dashboard. Clicking "files changed" on a task card now shows a dedicated view with file diffs instead of the generic file browser.
  EOF
  ```

## Documentation Requirements

**Must Update:**
- None (UI is self-explanatory, follows existing patterns)

**Check If Affected:**
- `packages/dashboard/README.md` — Add note about changed files viewer if there's a feature list

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Changeset file created
- [ ] Manual verification completed

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-651): complete Step N — description`
- **Bug fixes:** `fix(KB-651): description`
- **Tests:** `test(KB-651): description`

Example commits:
- `feat(KB-651): complete Step 1 — add backend API endpoint for task file diffs`
- `feat(KB-651): complete Step 4 — create ChangedFilesModal component`
- `test(KB-651): add unit tests for useChangedFiles hook`

## Do NOT

- Modify the generic FileBrowserModal behavior when opened from the header Files button
- Change the existing session-files API endpoint (keep for backward compatibility)
- Add file editing capabilities to the changed files viewer (read-only diff view only)
- Use external diff libraries — use the existing CSS patterns and git command output
- Skip tests for any new code
- Break the existing "Files" button in the header — it should still open the full file browser
