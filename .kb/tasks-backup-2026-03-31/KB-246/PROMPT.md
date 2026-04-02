# Task: KB-246 - Mobile File Editor View

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a UI/UX improvement to the existing FileBrowserModal component following an established pattern in the codebase. The change is localized to one component with CSS modifications. No security concerns or complex architectural decisions.

**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Implement a mobile-optimized file browsing experience in the dashboard's FileBrowserModal. On mobile viewports (≤768px), the modal should initially show only the file list. When a user selects a file, the view transitions to show the full file editor with a back button to return to the list. This follows the same two-state mobile pattern already established in GitHubImportModal.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/FileBrowserModal.tsx` — Current implementation showing sidebar+content side-by-side
2. `packages/dashboard/app/components/GitHubImportModal.tsx` — Reference implementation of the two-state mobile pattern (lines 34, 174-198, 347-452)
3. `packages/dashboard/app/components/Header.tsx` — `useIsMobile()` hook implementation (lines 24-38)
4. `packages/dashboard/app/styles.css` — Existing mobile styles for file browser (search `.file-browser-modal` and `@media (max-width: 768px)`)
5. `packages/dashboard/app/components/FileBrowser.tsx` — File list component (already supports `onSelectFile` callback)
6. `packages/dashboard/app/components/FileEditor.tsx` — File editor component (no changes needed)

## File Scope

- `packages/dashboard/app/components/FileBrowserModal.tsx` (modify)
- `packages/dashboard/app/styles.css` (modify — add mobile two-state view styles)
- `packages/dashboard/app/components/FileBrowserModal.test.tsx` (create — new test file)

## Steps

### Step 1: Implement Mobile View State Logic

Add mobile detection and two-state view management to FileBrowserModal, following the GitHubImportModal pattern.

- [ ] Add `useIsMobile()` hook import or inline implementation (match Header.tsx pattern)
- [ ] Add `mobileView` state: `'list' | 'editor'` with default `'list'`
- [ ] Add `isMobile` state using matchMedia listener (768px breakpoint)
- [ ] When `isMobile` is true and a file is selected, switch to `'editor'` view
- [ ] Add back button handler to return to `'list'` view
- [ ] Reset `mobileView` to `'list'` when modal opens (selectedFile becomes null)
- [ ] Ensure selected file still loads via `useFileEditor`/`useProjectFileEditor` hooks
- [ ] Run targeted tests: `pnpm test packages/dashboard/app/components/FileEditor.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modified)

### Step 2: Add Back Button and Conditional Layout

Implement the UI changes to support the two-state mobile view.

- [ ] Add back button (ArrowLeft icon from lucide-react) in the modal header when in mobile editor view
- [ ] Back button should only appear on mobile AND when a file is selected AND in editor view
- [ ] Conditionally render sidebar: hide when `isMobile && mobileView === 'editor'`
- [ ] Conditionally render content area: show full width when in mobile editor view
- [ ] Show placeholder "Select a file" when `mobileView === 'list'` and no file selected (existing behavior, ensure it remains)
- [ ] Run targeted tests: `pnpm test packages/dashboard/app/components/FileEditor.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/FileBrowserModal.tsx` (modified)

### Step 3: Add Mobile CSS for Two-State Layout

Add styles to support the mobile list/editor state transitions.

- [ ] Add `.file-browser-mobile-list` class: `display: flex` when active, `display: none` when not
- [ ] Add `.file-browser-mobile-editor` class: `display: none` when list active, `display: flex` when editor active
- [ ] Ensure smooth transitions (optional but preferred)
- [ ] Ensure the file list takes full height on mobile when in list view
- [ ] Ensure the editor takes full height on mobile when in editor view
- [ ] Test manually by resizing browser or using dev tools mobile viewport

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `FileBrowserModal.test.tsx` with the following tests:
  - Renders file browser sidebar and empty state on desktop
  - Selecting a file shows editor on desktop (both views visible)
  - On mobile: initially shows only file list (sidebar visible, content hidden)
  - On mobile: selecting a file switches to editor view (sidebar hidden, content full width)
  - On mobile: back button returns to list view
  - Back button only renders on mobile when file is selected
  - Modal resets to list view when reopened
- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open file browser on mobile viewport, confirm list-only view, select file, confirm editor with back button, click back, confirm returns to list

### Step 5: Documentation & Delivery

- [ ] No documentation updates required (UI behavior change, no user-facing docs)
- [ ] Create changeset for patch release (UI improvement):
  ```bash
  cat > .changeset/mobile-file-editor-view.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---
  
  Mobile file editor now shows file list first, then transitions to editor view with back button.
  EOF
  ```
- [ ] Out-of-scope findings: None expected

## Documentation Requirements

**Must Update:**
- None (no user-facing documentation for this UI change)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Mobile file browser shows list-only initially
- [ ] Selecting file on mobile shows full editor with back button
- [ ] Back button returns to file list
- [ ] Desktop behavior unchanged (sidebar + content side-by-side)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-246): complete Step N — description`
- **Bug fixes:** `fix(KB-246): description`
- **Tests:** `test(KB-246): description`

Example:
```
feat(KB-246): complete Step 1 — add mobile view state and detection
feat(KB-246): complete Step 2 — add back button and conditional layout
feat(KB-246): complete Step 3 — add mobile CSS for two-state layout
test(KB-246): add FileBrowserModal mobile view tests
feat(KB-246): complete Step 5 — add changeset and finalize
```

## Do NOT

- Change FileBrowser.tsx or FileEditor.tsx components — they work as-is
- Modify the desktop layout behavior — only add mobile-specific handling
- Remove existing keyboard shortcuts (Escape to close, Ctrl+S to save)
- Change the file browser hooks (useFileBrowser, useFileEditor, etc.)
- Add animations that delay user interaction
- Use a different mobile breakpoint than 768px (must match existing codebase)
