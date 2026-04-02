# Task: KB-220 - Redesign GitHub Import Dialog Layout

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a UI restructuring task affecting a single modal component. Changes involve layout refactoring, responsive design for mobile, and adding interaction states. Low blast radius, mostly CSS and component structure changes with some state management for mobile view switching.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Redesign the GitHub Import dialog to use a compact header layout and a two-pane mailbox-style view. Combine the remote selector, filter input, and load button into a single compact toolbar. Make the issue list and preview more prominent with a side-by-side layout on desktop. On mobile, show only the issue list initially, with the preview appearing when an issue is selected and a back button to return to the list.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/GitHubImportModal.tsx` — The component to redesign
- `packages/dashboard/app/styles.css` — Lines 2670-3100 contain the GitHub import modal styles
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` — Existing tests (update as needed)

## File Scope

- `packages/dashboard/app/components/GitHubImportModal.tsx` (modify)
- `packages/dashboard/app/styles.css` (modify — GitHub import modal section only)
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` (modify — add mobile view tests)

## Steps

### Step 1: Compact Header Toolbar

Combine the "Repository source" and "Filters & sync" sections into a single compact toolbar row.

- [ ] Create a compact header layout with three zones:
  - Left: Remote selector (dropdown if multiple remotes, or pill badge if single remote)
  - Center: Labels filter input (narrower, placeholder text instead of label)
  - Right: Load button (icon + text or just icon with tooltip)
- [ ] Remove the separate "Repository source" and "Filters & sync" section boxes
- [ ] Keep the repository pill/badge showing the selected owner/repo (can be smaller)
- [ ] The header should be a single row at the top of the modal body, not taking vertical space with separate sections
- [ ] Add `data-testid="github-import-toolbar"` to the toolbar container
- [ ] Ensure keyboard navigation still works (Tab order: remote → labels → load button)

**Artifacts:**
- `packages/dashboard/app/components/GitHubImportModal.tsx` (modified — compact header)

### Step 2: Two-Pane Mailbox Layout (Desktop)

Restructure the results and preview into a proper two-pane layout that emphasizes content over chrome.

- [ ] Increase the modal width to `min(900px, calc(100vw - 32px))` for more content space
- [ ] Remove the separate section boxes for Results and Preview (remove borders/backgrounds)
- [ ] Create a two-pane layout:
  - Left pane: Issue list (40% width, min 280px, max 400px)
  - Right pane: Preview (flex: 1, fills remaining space)
- [ ] Add a subtle vertical divider between panes (1px `var(--border)`)
- [ ] Issue list should fill available height with `flex: 1` and proper overflow handling
- [ ] Selected issue in the list should have clear visual highlight (use existing `.selected` styles)
- [ ] Preview pane shows when an issue is selected (existing behavior preserved)
- [ ] When no issue selected, preview pane shows empty state centered
- [ ] Add `data-testid="github-import-list-pane"` and `data-testid="github-import-preview-pane"`

**Artifacts:**
- `packages/dashboard/app/components/GitHubImportModal.tsx` (modified — two-pane structure)
- `packages/dashboard/app/styles.css` (modified — new layout styles)

### Step 3: Mobile Responsive View with Back Button

Implement the mobile experience where users see only the list, then navigate to preview with a back button.

- [ ] Add mobile breakpoint at `max-width: 640px`
- [ ] On mobile: show only the issue list pane by default
- [ ] On mobile: when an issue is selected, hide the list and show only the preview
- [ ] Add a back button in the preview header when on mobile (left arrow icon + "Back to issues")
- [ ] Clicking back returns to the list view (clear selection or just toggle view state)
- [ ] Add state to track mobile view mode: `'list' | 'preview'`
- [ ] On desktop (>640px), always show both panes side-by-side regardless of selection
- [ ] Add `data-testid="github-import-back-button"` for the mobile back button
- [ ] Ensure the modal height works well on mobile (use `max-height: 90vh` or similar)

**Artifacts:**
- `packages/dashboard/app/components/GitHubImportModal.tsx` (modified — mobile state management)
- `packages/dashboard/app/styles.css` (modified — mobile responsive styles)

### Step 4: Testing & Verification

Add and update tests for the new layout and mobile behavior.

- [ ] Update existing tests to work with new layout (selectors may need adjustment)
- [ ] Add test: "shows compact toolbar with remote, filter, and load button"
- [ ] Add test: "displays two-pane layout on desktop after loading issues"
- [ ] Add test: "preview pane shows selected issue details"
- [ ] Add test: "mobile shows only list pane initially"
- [ ] Add test: "mobile shows preview pane when issue selected"
- [ ] Add test: "mobile back button returns to list view"
- [ ] Run full test suite: `pnpm test`
- [ ] Fix any failing tests

**Artifacts:**
- `packages/dashboard/app/components/__tests__/GitHubImportModal.test.tsx` (modified)

### Step 5: Polish & Documentation

Final visual refinements and documentation updates.

- [ ] Verify scrollbar styling matches the app (thin, themed)
- [ ] Ensure focus rings work correctly in the new layout
- [ ] Check that the issue list items have adequate touch targets (min 44px height on mobile)
- [ ] Add hover states for the compact toolbar controls
- [ ] Update AGENTS.md if there are significant UX pattern changes (unlikely for this task)
- [ ] Verify the modal opens/closes smoothly with new layout
- [ ] Test with real data: open the dashboard, click "Import from GitHub", verify the new layout works

**Artifacts:**
- `packages/dashboard/app/styles.css` (polish refinements)

## Documentation Requirements

**Must Update:**
- None — this is a UI refactor without user-facing feature changes

**Check If Affected:**
- `AGENTS.md` — Only if the import flow pattern changes significantly (it doesn't)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Mobile layout tested (resize browser to verify)
- [ ] Desktop two-pane layout verified
- [ ] No visual regressions in the rest of the dashboard

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-220): complete Step N — description`
- **Bug fixes:** `fix(KB-220): description`
- **Tests:** `test(KB-220): description`

## Do NOT

- Change the API functions or data fetching logic
- Modify the import functionality behavior (only the UI layout)
- Add new dependencies
- Change the modal's public props interface
- Remove accessibility features (ARIA labels, keyboard navigation)
- Alter the issue selection logic (just how it's presented)
