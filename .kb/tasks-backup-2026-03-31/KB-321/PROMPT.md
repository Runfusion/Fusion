# Task: KB-321 - Simplify Logo and Remove Tasks Subtext

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 — None

**Assessment:** Simple visual branding change — modify SVG logo file and remove a text element from header. No logic changes or complex dependencies.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Simplify the kb dashboard branding by removing the four-circle kanban grid from the logo and dropping the "tasks" subtext from the header. The result should be a cleaner, more minimal logo that represents the "Fusion" brand without task-specific visual elements.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — Header component with logo image and brand text
- `packages/dashboard/app/components/Header.test.tsx` — Tests for header branding
- `packages/dashboard/app/public/logo.svg` — Current 4-circle logo SVG
- `packages/cli/dist/client/logo.svg` — CLI client copy of logo (auto-copied from public)

## File Scope

- `packages/dashboard/app/public/logo.svg` (modified — simplified logo)
- `packages/dashboard/app/components/Header.tsx` (modified — remove "tasks" subtext)
- `packages/dashboard/app/components/Header.test.tsx` (modified — update test expectations)
- `packages/dashboard/dist/client/logo.svg` (auto-generated — will be rebuilt)
- `packages/cli/dist/client/logo.svg` (auto-generated — will be rebuilt)

## Steps

### Step 1: Design and Implement Simplified Logo

- [ ] Replace the 4-circle grid in `logo.svg` with a simpler design
- [ ] Keep the same viewBox (0 0 128 128) and overall dimensions
- [ ] Use the same brand color (#58a6ff) or a simplified variation
- [ ] Design ideas: single geometric shape, stylized "F" lettermark, or minimal abstract mark
- [ ] Ensure the logo remains recognizable at 24x24px (header size) and larger sizes
- [ ] Run targeted tests for Header component

**Artifacts:**
- `packages/dashboard/app/public/logo.svg` (modified)

### Step 2: Remove "tasks" Subtext from Header

- [ ] Remove the `<span className="logo-sub">tasks</span>` element from Header.tsx
- [ ] Keep the "Fusion" h1 logo text and the logo image
- [ ] Verify the header layout still looks correct (no broken styling)
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 3: Update Tests

- [ ] Update `Header.test.tsx` to remove the expectation for "tasks" text
- [ ] The test `"renders the logo and brand"` should only check for "Fusion"
- [ ] Ensure all Header tests pass
- [ ] Run full test suite

**Artifacts:**
- `packages/dashboard/app/components/Header.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite (`pnpm test`)
- [ ] Fix all failures
- [ ] Build passes (`pnpm build`)
- [ ] Visually verify the logo renders correctly in the dashboard header

### Step 5: Documentation & Delivery

- [ ] No documentation updates needed (visual change only)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- `README.md` — Check if logo is referenced; update if needed
- `AGENTS.md` — Check if logo is referenced; update if needed

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Logo SVG simplified (no 4 circles)
- [ ] "tasks" subtext removed from header
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-321): complete Step N — description`
- **Bug fixes:** `fix(KB-321): description`
- **Tests:** `test(KB-321): description`

## Do NOT

- Change the brand name "Fusion" — only remove the "tasks" subtext
- Modify any other header functionality (buttons, search, toggles)
- Add complex animations or interactions to the logo
- Change the logo file path or reference in Header.tsx
- Modify CSS classes for the header layout (unless fixing breakage)
