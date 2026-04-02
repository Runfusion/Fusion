# Task: KB-231 - The agent log and steering should respect light mode/dark mode

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Straightforward CSS variable fix - adding missing theme-aware background variables and removing hardcoded dark fallbacks from components.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the agent log viewer and steering comments UI to properly respect light/dark mode settings. Currently, these components use `--bg-secondary` and `--bg-tertiary` CSS variables with hardcoded dark color fallbacks (`#1a1a2e`, `#252536`), causing them to display dark backgrounds even when the dashboard is in light mode.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/AgentLogViewer.tsx` — Component with hardcoded dark background fallbacks
- `packages/dashboard/app/components/SteeringTab.tsx` — Component with hardcoded dark background fallbacks  
- `packages/dashboard/app/styles.css` — Theme CSS variables (lines 4845-4945 for light theme)

## File Scope

- `packages/dashboard/app/styles.css` — Add `--bg-secondary` and `--bg-tertiary` variables to default and light themes
- `packages/dashboard/app/components/AgentLogViewer.tsx` — Remove hardcoded dark fallbacks from inline styles
- `packages/dashboard/app/components/SteeringTab.tsx` — Remove hardcoded dark fallbacks from inline styles

## Steps

### Step 1: Add Missing CSS Variables

Add `--bg-secondary` and `--bg-tertiary` CSS variables to both the default (dark) theme and the light theme in `styles.css`.

- [ ] Add to default theme (around line 30, with other background variables):
  - `--bg-secondary: #1a1a2e;` (dark secondary background)
  - `--bg-tertiary: #252536;` (dark tertiary background)

- [ ] Add to light theme (within `[data-theme="light"]` block around line 4847):
  - `--bg-secondary: #f6f8fa;` (light secondary - matches existing `--surface`)
  - `--bg-tertiary: #eaeef2;` (light tertiary - slightly darker than surface)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Update AgentLogViewer Component

Remove hardcoded dark fallback values from inline styles in `AgentLogViewer.tsx`. The CSS variables will now provide appropriate values for both themes.

- [ ] Line ~56: Change `background: "var(--bg-secondary, #1a1a2e)"` to `background: "var(--bg-secondary)"`
- [ ] Line ~70: Change `background: "var(--bg-tertiary, #252536)"` to `background: "var(--bg-tertiary)"`

**Artifacts:**
- `packages/dashboard/app/components/AgentLogViewer.tsx` (modified)

### Step 3: Update SteeringTab Component

Remove hardcoded dark fallback value from the steering comment textarea.

- [ ] In the textarea style block (~line 138): Change `background: "var(--bg-secondary, #1a1a2e)"` to `background: "var(--bg-secondary)"`

**Artifacts:**
- `packages/dashboard/app/components/SteeringTab.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure all tests pass
- [ ] Run `pnpm build` to ensure build passes
- [ ] Manually verify (if possible): In the dashboard, switch to light mode and confirm:
  - Agent log viewer background is light instead of dark purple
  - Agent log model header background is appropriate for light theme
  - Steering comment text area and comment bubbles have light backgrounds

### Step 5: Documentation & Delivery

- [ ] Create changeset file for the dashboard UI fix:
  ```bash
  cat > .changeset/fix-agent-log-light-mode.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Fix agent log and steering UI to respect light/dark mode theme settings
  EOF
  ```
- [ ] Commit all changes with appropriate task ID prefix

## Documentation Requirements

**Must Update:**
- None — this is a visual bug fix with no user-facing documentation changes needed

**Check If Affected:**
- `AGENTS.md` — No changes needed (this is a UI fix, not an agent-facing change)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-231): complete Step N — description`
- **Bug fixes:** `fix(KB-231): description`
- **Tests:** `test(KB-231): description`

## Do NOT

- Expand task scope to other components with similar issues (create follow-up tasks if found)
- Skip the changeset creation (this is a user-facing bug fix)
- Modify test files unless tests are actually failing (the existing tests don't check background colors)
- Add new dependencies
