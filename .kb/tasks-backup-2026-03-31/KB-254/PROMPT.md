# Task: KB-254 - The file editor is not taking up full height of the modal

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple CSS fix to make textarea fill flex container height. Low blast radius, no pattern changes, no security concerns, fully reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

The file editor textarea in the dashboard's file browser modal is not taking up the full available height. When opening a file, the textarea appears compressed instead of filling the entire editor area below the toolbar and above the footer. This makes editing files with many lines cumbersome as the editable area is too small.

The root cause is that `.file-editor-textarea` uses `height: 100%` which doesn't work correctly inside a flex container (`file-editor-container` uses `display: flex; flex-direction: column`). The markdown preview (`.file-editor-preview`) already uses `flex: 1` and fills the space correctly, but the textarea lacks this property.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/FileEditor.tsx` — the file editor component structure
- `packages/dashboard/app/components/FileBrowserModal.tsx` — how the editor is used in the modal
- `packages/dashboard/app/styles.css` — existing CSS for file editor components
- `packages/dashboard/app/components/FileEditor.test.tsx` — existing tests (should pass after fix)

## File Scope

- `packages/dashboard/app/styles.css` — modify `.file-editor-textarea` CSS rule
- `packages/dashboard/app/components/FileEditor.test.tsx` — add test for height/visibility if appropriate

## Steps

### Step 1: Fix Textarea Height CSS

- [ ] Add `flex: 1` to `.file-editor-textarea` CSS rule in `styles.css`
- [ ] Ensure `min-height: 0` is also set (prevents flexbox overflow issues)
- [ ] Verify the textarea now fills the available height in the flex container
- [ ] Run targeted tests for FileEditor component

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure all tests pass
- [ ] Build passes with `pnpm build`
- [ ] Manually verify in browser: open file browser modal, select a file, confirm textarea fills the full height between toolbar and footer

### Step 3: Documentation & Delivery

- [ ] Changeset file created if this affects published package (dashboard is internal, so no changeset needed)
- [ ] No documentation updates required for CSS bug fix

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] File editor textarea fills full available height in the modal
- [ ] Markdown preview continues to work correctly (no regression)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-254): complete Step N — description`
- **Bug fixes:** `fix(KB-254): description`
- **Tests:** `test(KB-254): description`

## Do NOT

- Change the FileEditor.tsx component structure (pure CSS fix)
- Modify the FileBrowserModal.tsx layout
- Add new dependencies
- Skip manual verification in browser
- Modify styles unrelated to the file editor height issue
