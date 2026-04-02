# Task: KB-244 - Change import from GitHub icon to use GitHub logo

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple UI icon swap - change the Download icon to a GitHub logo icon in the Header component. No logic changes, minimal blast radius.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Replace the generic `Download` icon from lucide-react with the actual GitHub logo icon for the "Import from GitHub" button in the Header component. This includes both the desktop button and the mobile overflow menu item. The GitHub logo is not available in lucide-react, so a custom SVG component needs to be created or an inline SVG used.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — Main header component where the icon change is needed (lines ~174 and ~271 for desktop and mobile overflow menu)
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — Existing tests for the Header component to ensure they still pass

## File Scope

- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/components/__tests__/Header.test.tsx` (verify tests pass)

## Steps

### Step 1: Create GitHub Logo Icon Component

- [ ] Create or add inline SVG for the GitHub "Octocat" mark logo
- [ ] Size should match other header icons (16x16px default, 16 for desktop, 16 for mobile)
- [ ] Use the official GitHub mark SVG path (silhouette cat-like logo in a circle)
- [ ] Ensure the icon inherits color via `currentColor` for theme compatibility

**Artifact approach options (choose one):**
- **Option A:** Create a new `GitHubLogo` component file and import it
- **Option B:** Define an inline SVG component directly in Header.tsx (simpler for single-use)

GitHub mark SVG path (official):
```
M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z
```

### Step 2: Update Header Component

- [ ] In `Header.tsx`, import or define the GitHub logo icon component
- [ ] Replace `<Download size={16} />` with `<GitHubLogo />` (or inline SVG) on line ~174
- [ ] Replace `<Download size={16} />` with `<GitHubLogo />` (or inline SVG) on line ~271 (mobile overflow menu)
- [ ] Ensure the icon renders at 16x16px like other header icons

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to execute the full test suite
- [ ] Verify all Header tests pass (especially the "renders the import button" and mobile overflow menu tests)
- [ ] Build the dashboard with `pnpm build` to ensure no type errors
- [ ] Manually verify the GitHub logo icon renders correctly in both desktop and mobile views

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed for this UI change
- [ ] Create changeset if this is user-facing (visual improvement)

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] GitHub logo icon is displayed instead of Download icon for the "Import from GitHub" button
- [ ] GitHub logo icon is displayed in the mobile overflow menu for "Import from GitHub"
- [ ] All tests passing
- [ ] Build passes without errors
- [ ] Icon renders correctly at 16x16px and uses currentColor for theme compatibility

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-244): complete Step N — description`
- **Bug fixes:** `fix(KB-244): description`
- **Tests:** `test(KB-244): description`

## Do NOT

- Add external icon libraries just for this one icon (use inline SVG)
- Change any functionality beyond the icon swap
- Skip running the test suite
- Modify unrelated components or styles
