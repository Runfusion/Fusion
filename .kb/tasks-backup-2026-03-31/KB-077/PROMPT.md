# Task: KB-077 - Fix File Editor Layout and Theme Support

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward CSS fix for a textarea component. The component exists but lacks proper styling - narrow width, unreadable text, and no theme support. Low blast radius, familiar patterns, no security concerns, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the FileEditor component's layout and styling issues. The textarea-based file editor currently has:
1. Text that is too narrow (constrained width)
2. Unreadable text (missing/inconsistent colors)
3. Broken theme support (not using CSS variables)

The fix involves adding proper CSS styles for `.file-editor-textarea` that make the editor full-width, readable, and theme-aware across both dark and light modes.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/FileEditor.tsx` — The component being fixed (currently a simple textarea)
- `packages/dashboard/app/styles.css` — Contains existing `.file-editor-container` styles (lines ~4339-4348, ~4661-4668) designed for CodeMirror that need to be extended for textarea support
- `packages/dashboard/app/components/FileBrowserModal.tsx` — Parent component showing how FileEditor is used within `.file-editor-wrapper`

## File Scope

- `packages/dashboard/app/styles.css` — Add `.file-editor-textarea` styles and fix `.file-editor-container` for textarea compatibility
- `packages/dashboard/app/components/FileEditor.tsx` — Minor updates if needed for className or structure

## Steps

### Step 1: Analyze Current State

- [ ] Review current `.file-editor-container` CSS (designed for CodeMirror `.cm-editor`)
- [ ] Identify missing `.file-editor-textarea` styles
- [ ] Verify CSS theme variables available (`--bg`, `--surface`, `--text`, `--text-muted`, `--border`, etc.)

### Step 2: Implement CSS Fixes

- [ ] Add `.file-editor-textarea` class with:
  - `width: 100%` and `min-width: 100%` to fix narrow text issue
  - `height: 100%` to fill container
  - `background: var(--bg)` for theme-aware background
  - `color: var(--text)` for theme-aware text color
  - `font-family: "SF Mono", Monaco, Consolas, monospace` for code readability
  - `font-size: 14px` and `line-height: 1.5` for readability
  - `padding: 16px` for comfortable editing
  - `border: none` and `outline: none` to remove default styling
  - `resize: none` to prevent manual resizing
  - `white-space: pre` and `overflow-wrap: normal` for proper code display
  - `tab-size: 2` for consistent indentation
- [ ] Update `.file-editor-container` to work with both CodeMirror and textarea:
  - Keep existing styles for backwards compatibility
  - Add `display: flex` and `flex-direction: column`
- [ ] Add `.file-editor-textarea::selection` for visible text selection using `--todo` color
- [ ] Test theme compatibility:
  - Verify styles work in dark theme (default)
  - Verify styles work in light theme (`[data-theme="light"]`)
  - Verify styles work across color themes (ocean, forest, etc.)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Update Component (if needed)

- [ ] Verify `FileEditor.tsx` className props are correct (`file-editor-container file-editor-textarea`)
- [ ] Ensure textarea has proper attributes (`spellCheck={false}` already present, good)
- [ ] Verify aria-label is preserved for accessibility

**Artifacts:**
- `packages/dashboard/app/components/FileEditor.tsx` (verify no changes needed, or minor fixes)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard tests: `cd packages/dashboard && pnpm test`
- [ ] Verify FileEditor tests pass
- [ ] Build passes: `pnpm build`
- [ ] Manually verify in browser (if possible):
  - Open file browser modal
  - Select a file
  - Confirm text is full-width (not narrow)
  - Confirm text is readable with proper colors
  - Test dark theme (default)
  - Test light theme toggle

**Artifacts:**
- Test results passing

### Step 5: Documentation & Delivery

- [ ] No documentation updates required (CSS fix only)
- [ ] If out-of-scope findings exist (e.g., need to restore CodeMirror), create new task via `task_create`

## Documentation Requirements

**Must Update:**
- None (CSS-only fix)

**Check If Affected:**
- None

## Completion Criteria

- [ ] File editor text is full-width (no longer narrow/constrained)
- [ ] Text is readable with proper contrast in both dark and light themes
- [ ] Theme switching applies correctly to the file editor
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-077): complete Step N — description`
- **Bug fixes:** `fix(KB-077): description`
- **Tests:** `test(KB-077): description`

## Do NOT

- Change the component to use CodeMirror (out of scope - this is a CSS fix only)
- Modify test logic (tests should pass as-is)
- Add new dependencies
- Change the FileEditor API/props
- Modify parent components (FileBrowserModal, etc.)
