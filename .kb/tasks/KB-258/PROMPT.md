# Task: KB-258 - Can't scroll file editor

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple CSS fix to add overflow scrolling to a textarea component. Single file change with no complex logic or dependencies.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Fix the file editor textarea so that it can scroll when content exceeds the visible area. Currently, the `.file-editor-textarea` CSS class in `styles.css` lacks an `overflow` property, preventing users from scrolling through large files.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/FileEditor.tsx` — The file editor component (textarea-based)
- `packages/dashboard/app/styles.css` — Contains the `.file-editor-textarea` CSS class that needs fixing
- `packages/dashboard/app/components/FileEditor.test.tsx` — Existing tests for the component

## File Scope

- `packages/dashboard/app/styles.css` — Add `overflow: auto` to `.file-editor-textarea`

## Steps

### Step 1: Fix CSS Overflow

- [ ] Add `overflow: auto` to `.file-editor-textarea` in `packages/dashboard/app/styles.css`
- [ ] Verify the change doesn't break horizontal scrolling (content uses `white-space: pre`)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure no regressions
- [ ] Run `pnpm build` to ensure build passes

### Step 3: Documentation & Delivery

- [ ] Create changeset for the fix (patch level — UI bug fix)

## Documentation Requirements

**Must Update:**
- None — CSS fix is self-documenting

**Changeset:**
- `.changeset/fix-file-editor-scroll.md` — Document the scrolling fix

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] File editor textarea scrolls properly when content exceeds container height

## Git Commit Convention

- **Step completion:** `feat(KB-258): complete Step 1 — add overflow scrolling to file editor textarea`
- **Bug fixes:** `fix(KB-258): add overflow: auto to file-editor-textarea for scroll support`
- **Changeset:** Include in same commit as fix

## Do NOT

- Change the textarea to a different component (CodeMirror, etc.) — keep textarea-based editor
- Modify the FileEditor.tsx component logic
- Alter the markdown preview scrolling (`.file-editor-preview` already has `overflow-y: auto`)
- Add unrelated CSS changes
