# Task: KB-265 - Fix File Editor Height and Markdown Preview Scrollability

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Straightforward CSS fix for flexbox height issues in the file editor modal. Low blast radius—only affects FileBrowserModal layout. No security concerns, easily reversible by reverting CSS changes.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix two layout issues in the file editor within the FileBrowserModal:
1. **Editor height**: The editor content area doesn't fill the full available height of the modal, leaving wasted space at the bottom
2. **Markdown preview scrollability**: When viewing markdown files in preview mode, the content overflows but isn't scrollable—the preview panel extends beyond the visible area without a scrollbar

These are flexbox layout issues where parent containers aren't properly constraining child heights, causing the content to either not fill available space or to overflow without scroll capability.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/FileEditor.tsx` — Editor component with textarea and markdown preview
- `packages/dashboard/app/components/FileBrowserModal.tsx` — Parent modal using `.file-browser-modal` and `.file-editor-wrapper`
- `packages/dashboard/app/styles.css` — Contains all relevant CSS classes:
  - `.file-browser-modal` (lines ~6027-6032)
  - `.file-browser-body` (lines ~6468-6472)
  - `.file-browser-content` (lines ~6483-6490)
  - `.file-editor-wrapper` (lines ~6646-6651)
  - `.file-editor-container` (lines ~6244-6255)
  - `.file-editor-preview` (lines ~6280-6287)
  - `.file-editor-textarea` (lines ~6289-6319)

## File Scope

- `packages/dashboard/app/styles.css` — Modify flexbox height constraints for file editor layout
- `packages/dashboard/app/components/FileEditor.test.tsx` — Add test for preview scrollability

## Steps

### Step 1: Analyze Current Layout Issues

- [ ] Open browser dev tools or review CSS to understand the layout hierarchy:
  - `.file-browser-modal` → `.file-browser-body` → `.file-browser-content` → `.file-editor-wrapper` → `.file-editor-container`
- [ ] Identify why `.file-editor-container` isn't filling available height (likely missing `min-height: 0` in parent chain)
- [ ] Identify why `.file-editor-preview` isn't scrolling (likely missing constrained height from parent)
- [ ] Document the specific CSS properties causing each issue

### Step 2: Fix Editor Height Layout

- [ ] Update `.file-browser-content` to ensure it properly fills available height:
  - Verify `flex: 1` and `display: flex; flex-direction: column` are present
  - Add `min-height: 0` if missing (critical for flex children to shrink properly)
- [ ] Update `.file-editor-wrapper` to properly constrain and fill space:
  - Verify `flex: 1`, `overflow: hidden`, and `min-width: 0` are present
  - Add `min-height: 0` if missing
  - Ensure `display: flex; flex-direction: column` is present
- [ ] Verify `.file-editor-container` has proper flex setup:
  - `flex: 1`, `display: flex; flex-direction: column`, `overflow: hidden`, `min-height: 0`
- [ ] Verify `.file-editor-textarea` fills container:
  - `flex: 1`, `min-height: 0`, `height: 100%`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — height fixes for editor)

### Step 3: Fix Markdown Preview Scrollability

- [ ] Update `.file-editor-preview` to ensure scrollability works:
  - Verify `flex: 1` is present (allows it to fill available space)
  - Verify `overflow-y: auto` is present (enables vertical scrolling)
  - Add `min-height: 0` if missing (prevents flex item from expanding beyond container)
  - Ensure `height: 100%` is present OR parent properly constrains height
- [ ] If `.file-editor-preview` is missing height constraint, add:
  - `height: 100%` OR ensure parent `.file-editor-container` has `overflow: hidden` and proper flex constraints
- [ ] Test that long markdown content (e.g., 5000+ words) shows a scrollbar in preview mode

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — scrollability fixes for preview)

### Step 4: Add Test for Markdown Preview Scrollability

- [ ] Add a test in `FileEditor.test.tsx` that verifies:
  - The `.file-editor-preview` element has proper CSS for scrolling (`overflow-y: auto`)
  - The element fills available height (`flex: 1` or equivalent)
- [ ] Example test to add:
```tsx
it("preview container has scrollable styles", () => {
  render(<FileEditor content={"# " + "Hello ".repeat(1000)} onChange={vi.fn()} filePath="readme.md" />);
  
  const previewButton = screen.getByRole("button", { name: /preview/i });
  fireEvent.click(previewButton);
  
  const preview = document.querySelector(".file-editor-preview");
  expect(preview).toHaveStyle({
    "overflow-y": "auto",
    flex: "1",
  });
});
```

**Artifacts:**
- `packages/dashboard/app/components/FileEditor.test.tsx` (modified — new scrollability test)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard tests: `cd packages/dashboard && pnpm test`
- [ ] Verify all FileEditor tests pass including new scrollability test
- [ ] Build passes: `pnpm build`
- [ ] Manual verification (if testing in browser):
  - Open file browser modal
  - Select a code file — editor should fill entire available height (no empty space below)
  - Select a markdown file with long content (or paste 5000+ words)
  - Switch to preview mode — content should be scrollable with visible scrollbar
  - Verify textarea still works for editing with proper height

**Artifacts:**
- Test results passing

### Step 6: Documentation & Delivery

- [ ] No documentation updates required (CSS fix only)
- [ ] If additional layout issues found, create new task via `task_create`

## Documentation Requirements

**Must Update:**
- None (CSS-only fix)

**Check If Affected:**
- None

## Completion Criteria

- [ ] Editor fills full available height in the modal (no wasted space at bottom)
- [ ] Markdown preview is scrollable when content exceeds visible area
- [ ] All existing tests pass
- [ ] New scrollability test passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-265): complete Step N — description`
- **Bug fixes:** `fix(KB-265): description`
- **Tests:** `test(KB-265): description`

## Do NOT

- Change the editor component architecture (keep textarea-based editor)
- Modify the FileBrowserModal component structure
- Add new dependencies
- Change the FileEditor API/props
- Affect other modal layouts
