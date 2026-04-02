# Task: KB-242 - File editor: scrollable content area + worktree selector dropdown

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a UI enhancement task with moderate blast radius (modifying shared file browser components) but straightforward patterns. CSS scrolling fix is low-risk, but worktree selector affects core file browsing behavior including unsaved-changes handling.

**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Fix the file editor scrolling overflow issue and add a worktree selector dropdown to the FileBrowserModal header, enabling users to switch between git worktrees when browsing files in both task and project modes.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/FileBrowserModal.tsx` — Main modal component, understand props (TaskModeProps vs ProjectModeProps), state management, and how hooks are used
- `packages/dashboard/app/components/FileEditor.tsx` — Editor component (no changes needed but understand how it fits in)
- `packages/dashboard/app/styles.css` — Search for `.file-editor-wrapper`, `.file-editor-textarea`, `.file-editor-preview`, `.file-browser-modal` styles
- `packages/dashboard/app/api.ts` — Review `fetchGitWorktrees()`, `GitWorktree` type, and file browser API functions
- `packages/dashboard/app/hooks/useFileBrowser.ts` — Understand task file browser hook pattern
- `packages/dashboard/app/hooks/useProjectFileBrowser.ts` — Understand project file browser hook pattern
- `packages/dashboard/app/components/FileEditor.test.tsx` — Existing test patterns
- `packages/dashboard/app/components/CustomModelDropdown.tsx` — Reference for dropdown implementation patterns (optional but helpful)

## File Scope

- `packages/dashboard/app/styles.css` — Modify `.file-editor-wrapper` and related styles, add worktree dropdown styles
- `packages/dashboard/app/components/FileBrowserModal.tsx` — Add worktree selector dropdown, fetch worktrees, handle switching logic with confirmation
- `packages/dashboard/app/components/FileBrowserModal.test.tsx` — New test file for worktree switching behavior
- `packages/dashboard/app/components/FileEditor.test.tsx` — Add tests for scrollable behavior (verify overflow styles)

## Steps

### Step 1: Fix File Editor Scrolling

- [ ] Update `.file-editor-wrapper` in styles.css to allow scrolling (`overflow: auto` or `overflow-y: auto`)
- [ ] Ensure `.file-editor-textarea` has proper overflow handling within the flex layout
- [ ] Verify `.file-editor-preview` has `overflow-y: auto` and proper `min-height: 0` on flex parents
- [ ] Confirm the flex chain properly constrains height: `.file-browser-content` → `.file-editor-wrapper` → `.file-editor-container` → textarea/preview
- [ ] Run tests to ensure no regressions

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified) — CSS overflow fixes

### Step 2: Add Worktree Selector Dropdown to FileBrowserModal

- [ ] Add `worktrees` state and `selectedWorktree` state to FileBrowserModal component
- [ ] Fetch worktrees via `fetchGitWorktrees()` on modal open (useEffect)
- [ ] Add worktree selector dropdown in modal header (next to title)
- [ ] Dropdown always visible in both task mode and project mode
- [ ] In task mode: pre-select worktree matching `taskId` (check worktree.branch for `kb/{taskId}` pattern)
- [ ] In project mode: pre-select main worktree (worktree where `isMain: true`)
- [ ] Dropdown displays format: branch name + optional task ID, e.g., `main`, `kb/KB-042 (KB-042)`
- [ ] Store selected worktree path and pass to hooks for file operations

**Artifacts:**
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modified) — Worktree selector UI and state

### Step 3: Implement Worktree Switching Logic

- [ ] Create `handleWorktreeChange` function that:
  - Checks `hasChanges` from editor hook
  - If unsaved changes: show confirmation dialog asking "Discard changes or save first?"
  - On confirm/discard: reset path to root (`.`), clear selected file, switch worktree
  - On cancel: keep current worktree selected
- [ ] When worktree switches:
  - Reset `currentPath` to `.` using `setPath(".")`
  - Clear `selectedFile` using `setSelectedFile(null)`
  - Update worktree path used by file browser/editor hooks
- [ ] Ensure file browser refreshes with new worktree contents

**Artifacts:**
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modified) — Worktree switching logic with confirmation

### Step 4: Styling for Worktree Dropdown

- [ ] Add CSS class for worktree selector dropdown (`.file-browser-worktree-select` or similar)
- [ ] Style to match existing dropdown patterns (like `.dep-dropdown` or inline create model dropdown)
- [ ] Position in modal header alongside title
- [ ] Ensure responsive behavior on mobile

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified) — Worktree dropdown styles

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add tests in `FileEditor.test.tsx` to verify scrollable behavior:
  - Verify `.file-editor-textarea` has proper overflow styles
  - Verify `.file-editor-preview` scrolls when content overflows
- [ ] Create `FileBrowserModal.test.tsx` with tests for:
  - Worktree dropdown renders with correct worktrees from API
  - Pre-selection works correctly in task mode (matches task's worktree)
  - Pre-selection works correctly in project mode (selects main worktree)
  - Worktree switching resets path and clears selected file
  - Confirmation dialog appears when switching with unsaved changes
  - Cancelling confirmation keeps current worktree
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/FileBrowserModal.test.tsx` (new) — Worktree selector tests
- `packages/dashboard/app/components/FileEditor.test.tsx` (modified) — Scrolling behavior tests

### Step 6: Documentation & Delivery

- [ ] No documentation updates required (UI behavior is self-explanatory via dropdown labels)
- [ ] Out-of-scope findings: Create new tasks via `task_create` if:
  - API changes needed for worktree-specific file operations
  - Additional worktree management features identified

**Artifacts:**
- None (no docs to update)

## Completion Criteria

- [ ] File editor textarea and preview scroll independently when content overflows
- [ ] Worktree selector dropdown visible in FileBrowserModal header
- [ ] Dropdown pre-selects correct worktree in both task and project modes
- [ ] Worktree switching resets path to root and clears selected file
- [ ] Confirmation dialog shown when switching with unsaved changes
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-242): complete Step N — description`
- **Bug fixes:** `fix(KB-242): description`
- **Tests:** `test(KB-242): description`

Example commits:
- `feat(KB-242): complete Step 1 — fix file editor scrolling overflow`
- `feat(KB-242): complete Step 2 — add worktree selector dropdown UI`
- `feat(KB-242): complete Step 3 — implement worktree switching with confirmation`
- `test(KB-242): add tests for worktree selector and scrolling`

## Do NOT

- Expand task scope to include full worktree management features
- Skip tests for the confirmation dialog behavior
- Modify the file browser API endpoints (use existing `fetchGitWorktrees()`)
- Change the existing file editor component logic (focus on CSS and wrapper behavior)
- Commit without the KB-242 prefix
