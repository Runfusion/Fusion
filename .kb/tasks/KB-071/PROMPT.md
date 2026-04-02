# Task: KB-071 - Rename Dashboard to "Fusion" and Update Logo

**Created:** 2025-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Straightforward branding change affecting only display elements (logo SVG, header text, page title). No logic changes, no security implications, fully reversible by reverting the modified files.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Rename the dashboard from "kb board" to "Fusion" and replace the existing multi-bar logo with a clean, geometric four-dot design. This is a pure branding/UI change with no functional impact.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — contains the header branding text
- `packages/dashboard/app/public/logo.svg` — the current logo SVG to replace
- `packages/dashboard/app/index.html` — contains the page title
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — tests referencing the logo alt text

## File Scope

- `packages/dashboard/app/components/Header.tsx`
- `packages/dashboard/app/public/logo.svg`
- `packages/dashboard/app/index.html`
- `packages/dashboard/app/components/__tests__/Header.test.tsx`

## Steps

### Step 1: Update Header Component Branding

- [ ] Change `<h1 className="logo">kb</h1>` to `<h1 className="logo">Fusion</h1>`
- [ ] Change `<span className="logo-sub">board</span>` to `<span className="logo-sub">tasks</span>`
- [ ] Update the logo `<img>` alt text from `"kb logo"` to `"Fusion logo"`
- [ ] Verify the Header component still compiles and renders correctly

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 2: Create New Four-Dot Logo

- [ ] Replace `packages/dashboard/app/public/logo.svg` with a clean, geometric four-dot design
- [ ] Use a 2×2 grid of four circles, centered in a 128×128 viewBox
- [ ] Use a single accent color (`#58a6ff` — the blue todo color from the theme) for a cohesive look
- [ ] Keep it simple: four identical circles, evenly spaced, ~20px radius each
- [ ] Ensure the SVG has proper `xmlns` attribute and `viewBox="0 0 128 128"`

**Design specification:**
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <circle cx="44" cy="44" r="20" fill="#58a6ff"/>
  <circle cx="84" cy="44" r="20" fill="#58a6ff"/>
  <circle cx="44" cy="84" r="20" fill="#58a6ff"/>
  <circle cx="84" cy="84" r="20" fill="#58a6ff"/>
</svg>
```

**Artifacts:**
- `packages/dashboard/app/public/logo.svg` (modified)

### Step 3: Update Page Title

- [ ] Change `<title>kb | board</title>` to `<title>Fusion</title>` in `packages/dashboard/app/index.html`
- [ ] Note: The path is `packages/dashboard/app/index.html` (NOT inside `public/`)

**Artifacts:**
- `packages/dashboard/app/index.html` (modified)

### Step 4: Fix Header Tests

- [ ] Update the logo alt text assertion: change `"kb logo"` to `"Fusion logo"` in `Header.test.tsx`
- [ ] Remove broken tests that reference non-existent props:
  - Remove all tests referencing `onToggleTheme` and `themeMode` (lines ~122-179)
  - Remove all tests referencing `inProgressCount` (lines ~182-end)
  - Keep only tests that reference actual HeaderProps interface properties
- [ ] Run Header-specific tests to verify they pass

**Context:** The Header component does NOT have `onToggleTheme`, `themeMode`, or `inProgressCount` props. These tests are pre-existing broken tests that need cleanup.

**Artifacts:**
- `packages/dashboard/app/components/__tests__/Header.test.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Visually verify the new logo renders correctly at 24×24px in the header
- [ ] Verify the "Fusion" text displays properly in the header layout

### Step 6: Documentation & Delivery

- [ ] No documentation updates required (internal branding change)
- [ ] Create a changeset since this is a user-facing change to the published dashboard:
  ```bash
  cat > .changeset/rename-dashboard-to-fusion.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Rename dashboard to "Fusion" and update logo to geometric four-dot design
  EOF
  ```
- [ ] Include the changeset in the final commit

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset created and committed

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-071): rename dashboard header to Fusion`
- **Step 2:** `feat(KB-071): replace logo with geometric four-dot design`
- **Step 3:** `feat(KB-071): update page title to Fusion`
- **Step 4:** `test(KB-071): update Header tests for new branding and remove broken tests`
- **Step 5-6:** `feat(KB-071): add changeset for dashboard rename`

## Do NOT

- Expand scope to rename CLI commands or package names
- Modify the core engine, task store, or API
- Change any functionality beyond pure branding/display
- Skip updating the tests — they will fail if ignored
- Leave broken tests that reference non-existent props
