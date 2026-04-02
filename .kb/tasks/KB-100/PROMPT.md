# Task: KB-100 - Update Header Test for Fusion Branding

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Trivial text assertion update in a single test file. No logic changes, no blast radius beyond the test itself.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Update the legacy dashboard Header test at `packages/dashboard/app/components/Header.test.tsx` to match the current "Fusion tasks" branding. The test currently expects "kb" and "board" text assertions, but the Header component was rebranded to show "Fusion" and "tasks".

## Dependencies

- **Task:** KB-099 (Fix pre-existing dashboard test suite failures — must be complete so the test suite is in a working state before this change)

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — The source component showing current branding: `<h1 className="logo">Fusion</h1>` and `<span className="logo-sub">tasks</span>`
- `packages/dashboard/app/components/Header.test.tsx` — The outdated test file with "kb" and "board" assertions
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — Reference: already-updated test showing correct "Fusion logo" assertions

## File Scope

- `packages/dashboard/app/components/Header.test.tsx` (modify)

## Steps

### Step 1: Update Branding Assertions

- [ ] Change `expect(screen.getByText("kb")).toBeDefined()` to `expect(screen.getByText("Fusion")).toBeDefined()`
- [ ] Change `expect(screen.getByText("board")).toBeDefined()` to `expect(screen.getByText("tasks")).toBeDefined()`
- [ ] Run the Header test specifically to verify it passes: `cd packages/dashboard && pnpm test Header.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/Header.test.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the full dashboard test suite: `cd packages/dashboard && pnpm test`
- [ ] Verify all tests pass
- [ ] Run build to ensure no type errors: `cd packages/dashboard && pnpm build`

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (test file change only)
- [ ] Create changeset since this affects the published package (even though it's a test, it's part of the workspace):
  ```bash
  cat > .changeset/kb-100-header-test-branding.md << 'EOF'
  ---
  "@kb/dashboard": patch
  ---

  Update Header test assertions to match Fusion branding (KB-100).
  EOF
  ```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset included

## Git Commit Convention

- **Step completion:** `test(KB-100): update Header test assertions for Fusion branding`
- **Changeset:** `chore(KB-100): add changeset for Header test update`

## Do NOT

- Expand scope to other branding updates — focus only on the Header.test.tsx text assertions
- Modify the Header component itself — only update the test to match existing component behavior
- Delete or merge the two Header test files — this is out of scope
- Skip the changeset — dashboard changes require tracking even for test fixes
