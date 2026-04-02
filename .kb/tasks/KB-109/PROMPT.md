# Task: KB-109 - Fix File Editor Layout and Theme Support

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused CSS fix for the FileEditor component. The component exists and works functionally, but has layout constraints (narrow text) and theme integration issues. Low blast radius, familiar CSS patterns, no security concerns, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the FileEditor component's layout and styling issues in the dashboard file browser modal. The textarea-based file editor currently has three problems:

1. **Text is too narrow** - The editor content is constrained and doesn't use the available width
2. **Unreadable text** - Text colors may not have proper contrast or may be inheriting incorrect styles
3. **Broken theme support** - The editor doesn't properly respond to theme changes (dark/light mode and color themes)

The fix involves auditing and correcting CSS styles for `.file-editor-textarea` and `.file-editor-container` to ensure the editor is full-width, readable, and properly theme-aware across all theme combinations.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/FileEditor.tsx` — The textarea-based file editor component
- `packages/dashboard/app/components/FileBrowserModal.tsx` — Parent modal showing how FileEditor is used within `.file-editor-wrapper`
- `packages/dashboard/app/styles.css` — Contains existing file editor styles (search for `.file-editor-container`, `.file-editor-textarea`, `.file-editor-wrapper`, `.file-browser-content`)
- Theme variable definitions in styles.css:
  - `:root` — Default dark theme variables (`--bg`, `--surface`, `--text`, `--text-muted`, `--border`, `--todo`)
  - `[data-theme="light"]` — Light theme variable overrides
  - Color themes: `[data-color-theme="ocean"]`, `[data-color-theme="forest"]`, etc.

## File Scope

- `packages/dashboard/app/styles.css` — Audit, consolidate, and fix file editor CSS classes
- `packages/dashboard/app/components/FileEditor.tsx` — Verify className usage (minor changes if needed)
- `packages/dashboard/app/components/FileEditor.test.tsx` — Create new test file for FileEditor component

## Steps

### Step 1: Audit Current CSS State

- [ ] Read all existing `.file-editor-*` CSS rules in styles.css (note there may be duplicates at different line numbers)
- [ ] Identify conflicting or duplicate style definitions
- [ ] Identify missing theme-aware properties (background, color, selection)
- [ ] Verify CSS variable availability (`--bg`, `--surface`, `--text`, `--text-muted`, `--border`, `--todo`)

**Artifacts:**
- Document current CSS issues found

### Step 2: Consolidate and Fix CSS

- [ ] Consolidate duplicate `.file-editor-container` definitions into a single, clean rule
- [ ] Consolidate duplicate `.file-editor-textarea` definitions into a single, clean rule
- [ ] Ensure `.file-editor-textarea` has:
  - `width: 100%` and `min-width: 100%` to fix narrow text
  - `box-sizing: border-box` to include padding in width calculation
  - `background: var(--bg)` for theme-aware background
  - `color: var(--text)` for theme-aware text color
  - `font-family: "SF Mono", Monaco, Consolas, "Liberation Mono", Menlo, monospace` for code readability
  - `font-size: 14px` and `line-height: 1.5` for readability
  - `padding: 16px` for comfortable editing
  - `border: none` and `outline: none` to remove default styling
  - `resize: none` to prevent manual resizing
- [ ] Add/verify `.file-editor-textarea::selection` for visible text selection using `--todo` or `--in-progress` color
- [ ] Add/verify `.file-editor-textarea:focus` with subtle outline using `--border` or `--todo`
- [ ] Ensure `.file-editor-wrapper` (parent) has proper flex layout:
  - `flex: 1`
  - `overflow: hidden`
  - `min-width: 0` (critical for flex children to shrink properly)
- [ ] Verify `.file-browser-content` (grandparent) has:
  - `flex: 1`
  - `min-width: 0` (prevents flex child from overflowing)
- [ ] Add light theme overrides for file editor if needed:
  - `[data-theme="light"] .file-editor-textarea` with proper contrast colors

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — consolidated and fixed styles)

### Step 3: Verify Component Integration

- [ ] Verify `FileEditor.tsx` uses correct className: `"file-editor-container file-editor-textarea"`
- [ ] Ensure textarea has `spellCheck={false}` (already present)
- [ ] Ensure textarea has proper `aria-label` for accessibility (already present)
- [ ] Verify no inline styles that could conflict with CSS

**Artifacts:**
- `packages/dashboard/app/components/FileEditor.tsx` (verify no changes needed, or minor fixes)

### Step 4: Create Component Tests

- [ ] Create `packages/dashboard/app/components/FileEditor.test.tsx` with tests:
  - Renders textarea with correct class names
  - Renders with content prop value
  - Calls onChange when text is modified
  - Respects readOnly prop
  - Has correct aria-label based on filePath prop
  - Has spellCheck disabled
- [ ] Run new tests and verify they pass

**Artifacts:**
- `packages/dashboard/app/components/FileEditor.test.tsx` (new)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test`
- [ ] Fix any test failures (note: pre-existing failures in other tests should not be introduced by this change)
- [ ] Build passes: `cd packages/dashboard && pnpm build`
- [ ] Verify no TypeScript errors: `cd packages/dashboard && pnpm typecheck`

**Artifacts:**
- Test results showing all FileEditor tests passing
- Build output showing success

### Step 6: Documentation & Delivery

- [ ] Add changeset file for the dashboard package (patch bump — bug fix)
- [ ] If any out-of-scope findings exist (e.g., need to add CodeMirror support), create new task via `task_create`

**Artifacts:**
- `.changeset/fix-file-editor-layout.md` (new)

## Documentation Requirements

**Must Update:**
- None (CSS-only fix with component tests)

**Check If Affected:**
- `packages/dashboard/README.md` — Only if file editor usage is documented

## Completion Criteria

- [ ] File editor text is full-width (no longer narrow/constrained)
- [ ] Text is readable with proper contrast in both dark and light themes
- [ ] Theme switching applies correctly to the file editor (dark/light modes and color themes)
- [ ] Text selection is visible with theme-appropriate highlight color
- [ ] All dashboard tests passing (or pre-existing failures documented, no new failures)
- [ ] Build passes
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-109): complete Step N — description`
- **Bug fixes:** `fix(KB-109): description`
- **Tests:** `test(KB-109): description`
- **Changeset:** `chore(KB-109): add changeset for file editor fix`

## Do NOT

- Change FileEditor to use CodeMirror (out of scope — this is a CSS/layout fix only)
- Modify FileBrowserModal layout structure (focus on CSS fixes, not component restructuring)
- Add new dependencies
- Change the FileEditor API/props (backward compatible changes only)
- Skip creating tests for the FileEditor component
- Ignore pre-existing test failures (document them but don't introduce new ones)
