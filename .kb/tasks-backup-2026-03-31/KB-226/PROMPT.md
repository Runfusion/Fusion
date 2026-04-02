# Task: KB-226 - File Editor Scrolling and Markdown Preview

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI enhancement to the existing file editor. The task adds a markdown preview toggle for markdown files and ensures proper scrolling behavior. Limited blast radius, straightforward patterns from existing SpecEditor component.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Enhance the dashboard file editor to support two key usability features: (1) ensure the file browser sidebar allows smooth scrolling through long file lists, and (2) add a markdown preview mode when viewing markdown files (`.md`, `.markdown`, `.mdx`). When a markdown file is selected, users should be able to toggle between edit mode (textarea) and preview mode (rendered markdown), similar to the existing SpecEditor component's view/edit toggle pattern.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/FileEditor.tsx` — current simple textarea editor
- `packages/dashboard/app/components/FileBrowserModal.tsx` — modal container with file browser and editor
- `packages/dashboard/app/components/SpecEditor.tsx` — reference implementation for view/edit toggle with markdown preview
- `packages/dashboard/app/components/FileBrowser.tsx` — file list sidebar component
- `packages/dashboard/app/styles.css` — existing styles for file browser and editor (search for `.file-editor-` and `.file-browser-` classes)
- `packages/dashboard/app/components/__tests__/FileEditor.test.tsx` — existing tests

## File Scope

- `packages/dashboard/app/components/FileEditor.tsx` — add markdown preview toggle
- `packages/dashboard/app/components/FileEditor.test.tsx` — update tests for new functionality
- `packages/dashboard/app/components/FileBrowser.tsx` — verify/improve scrolling
- `packages/dashboard/app/styles.css` — add styles for preview mode and scroll fixes

## Steps

### Step 1: Fix File Browser Scrolling

- [ ] Verify the file browser sidebar scrolls correctly with long file lists
- [ ] Check that `file-browser-list` CSS class has proper `overflow-y: auto` and height constraints
- [ ] Fix any scroll container issues in the file browser sidebar layout
- [ ] Add tests for scroll behavior if needed

**Artifacts:**
- `packages/dashboard/app/components/FileBrowser.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Add Markdown Preview to FileEditor

- [ ] Add `showPreview` state to FileEditor component
- [ ] Add isMarkdown check based on filePath extension (`.md`, `.markdown`, `.mdx`)
- [ ] Add toggle buttons for Edit/Preview (only show for markdown files)
- [ ] Import and use ReactMarkdown with remarkGfm for preview rendering
- [ ] Apply existing `.markdown-body` CSS class for consistent styling
- [ ] Handle readOnly mode: hide Edit button, show only Preview for markdown files

**Artifacts:**
- `packages/dashboard/app/components/FileEditor.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in packages/dashboard — all tests must pass
- [ ] Update FileEditor.test.tsx to cover:
  - Markdown preview toggle functionality
  - Edit button hidden for non-markdown files
  - Preview button shows rendered markdown for .md files
  - readOnly mode behavior
- [ ] Manual verification: open file browser, select markdown file, toggle preview
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Update relevant documentation if any file editor docs exist
- [ ] Create changeset: `.changeset/file-editor-markdown-preview.md` (patch — new feature)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None (component self-documenting via code)

**Check If Affected:**
- `packages/dashboard/README.md` — add note about markdown preview if it documents file editor features

## Completion Criteria

- [ ] File browser sidebar scrolls smoothly with long file lists
- [ ] Markdown files show Edit/Preview toggle buttons
- [ ] Preview mode renders markdown using ReactMarkdown with remarkGfm
- [ ] Non-markdown files show only edit mode (no toggle)
- [ ] All tests passing
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-226): complete Step N — description`
- **Bug fixes:** `fix(KB-226): description`
- **Tests:** `test(KB-226): description`

## Do NOT

- Add CodeMirror or other heavy editor dependencies — keep the textarea-based editor
- Change the file browser API or data structures
- Modify FileBrowserModal layout significantly
- Add preview for non-markdown file types
- Skip tests for the new preview functionality
