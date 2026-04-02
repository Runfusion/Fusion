# Task: KB-264 - File editor doesn't scroll in markdown preview and it should have a button that toggles word wrap (wrap on by default)

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI fix with limited blast radius - adding a word wrap toggle and fixing CSS scroll behavior.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix two issues in the FileEditor component:
1. **Markdown preview doesn't scroll** - The preview area in markdown mode lacks proper scrolling when content exceeds viewport
2. **Add word wrap toggle** - The textarea editor needs a toolbar button to toggle word wrap, with wrapping enabled by default

These improvements make the file editor more usable for editing long markdown files and code files that may have long lines.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/FileEditor.tsx` — The file editor React component
- `packages/dashboard/app/components/FileEditor.test.tsx` — Existing tests for the component
- `packages/dashboard/app/styles.css` — CSS styles for the file editor (search for `file-editor-*` classes)
- `packages/dashboard/app/components/FileBrowserModal.tsx` — Usage context showing how FileEditor is integrated

## File Scope

- `packages/dashboard/app/components/FileEditor.tsx` (modify)
- `packages/dashboard/app/components/FileEditor.test.tsx` (modify)
- `packages/dashboard/app/styles.css` (modify)

## Steps

### Step 1: Fix Markdown Preview Scrolling

- [ ] Add `height: 100%` and `min-height: 0` to `.file-editor-preview` CSS class to ensure it respects flex constraints
- [ ] Verify the preview container can scroll vertically when markdown content exceeds viewport height
- [ ] Run targeted tests for FileEditor component

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Add Word Wrap Toggle Button

- [ ] Add `wordWrap` state to FileEditor component (default to `true` - wrap enabled)
- [ ] Add wrap toggle button to the toolbar using `WrapText` icon from lucide-react
- [ ] Position the wrap toggle button to the right side of the toolbar (separate from edit/preview mode toggles)
- [ ] Apply conditional CSS class to textarea based on wordWrap state:
  - When `wordWrap=true`: `white-space: pre-wrap` (wrap long lines)
  - When `wordWrap=false`: `white-space: pre` (no wrap, horizontal scroll)
- [ ] Toggle button should show active state when word wrap is enabled
- [ ] Add aria-label "Toggle word wrap" to the button

**Artifacts:**
- `packages/dashboard/app/components/FileEditor.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add tests for word wrap toggle functionality:
  - Test that toggle button exists in the toolbar
  - Test that clicking toggle changes the textarea's white-space style
  - Test that word wrap is on by default
- [ ] Add test for markdown preview scrollability (verify CSS classes applied)
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (UI behavior change)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None (UI component behavior changes are self-documenting)

**Check If Affected:**
- None

## Completion Criteria

- [ ] Markdown preview scrolls vertically when content exceeds viewport
- [ ] Word wrap toggle button appears in file editor toolbar for all file types
- [ ] Word wrap is enabled by default (long lines wrap)
- [ ] Toggle button shows active state when word wrap is enabled
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-264): complete Step N — description`
- **Bug fixes:** `fix(KB-264): description`
- **Tests:** `test(KB-264): description`

## Do NOT

- Expand task scope beyond scrolling fix and word wrap toggle
- Modify FileBrowserModal or other parent components
- Change the default edit/preview behavior for markdown files
- Add keyboard shortcuts (out of scope)
- Modify how the editor handles binary files
