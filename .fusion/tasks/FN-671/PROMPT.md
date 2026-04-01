# Task: FN-671 - Fix Mobile Header Layout: Move Excess Buttons to Overflow Menu

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused responsive layout fix. The Header.tsx currently shows too many buttons inline on mobile (up to 8), causing them to overflow or be inaccessible. The fix moves non-essential buttons into the mobile overflow menu. Low blast radius, follows existing patterns.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the mobile header layout where too many buttons are displayed inline, causing some to be inaccessible on small screens. Move the Usage and Activity Log buttons from inline display to the mobile overflow menu, keeping only essential controls (search, view toggle, pause/stop) always visible.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/Header.tsx` - See the mobile icon layout issue:
   - Lines ~215-225: Usage button shown inline on mobile
   - Lines ~226-232: Activity Log button shown inline on mobile
   - Lines ~295+: Mobile overflow menu contains other buttons
2. `packages/dashboard/app/styles.css` - Existing header styles and mobile breakpoint
3. `packages/dashboard/app/__tests__/mobile-header-controls.test.ts` - Mobile CSS tests
4. `packages/dashboard/app/components/Header.test.tsx` - Component tests for mobile overflow menu

## File Scope

- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/__tests__/mobile-header-controls.test.ts` (modified - optional)

## Steps

### Step 1: Move Usage Button to Mobile Overflow Menu

In Header.tsx, modify the Usage button section (~lines 215-225):

- [ ] Wrap the Usage button with `!isMobile` condition (move from inline to desktop-only)
- [ ] Add Usage button to the mobile overflow menu section (~line 295+)
- [ ] Follow existing overflow menu item pattern with `role="menuitem"` and data-testid

**Current code to modify:**
```tsx
{/* Usage button - inline on all screens when onOpenUsage provided */}
{onOpenUsage && (
  <button className="btn-icon" onClick={onOpenUsage} title="View usage">
    <Activity size={16} />
  </button>
)}
```

**Change to:**
```tsx
{/* Usage button - desktop only (moved to overflow on mobile) */}
{!isMobile && onOpenUsage && (
  <button className="btn-icon" onClick={onOpenUsage} title="View usage">
    <Activity size={16} />
  </button>
)}
```

**Add to mobile overflow menu (alphabetically near Activity Log):**
```tsx
{onOpenUsage && (
  <button
    className="mobile-overflow-item"
    onClick={() => handleOverflowAction(onOpenUsage)}
    role="menuitem"
    data-testid="overflow-usage-btn"
  >
    <Activity size={16} />
    <span>View Usage</span>
  </button>
)}
```

### Step 2: Move Activity Log Button to Mobile Overflow Menu

In Header.tsx, modify the Activity Log button section (~lines 226-232):

- [ ] Wrap the Activity Log button with `!isMobile` condition
- [ ] Verify Activity Log button is already in mobile overflow menu, or add it if missing
- [ ] Ensure proper ordering in overflow menu (alphabetical by label)

**Current code to modify:**
```tsx
{/* Activity Log button */}
{onOpenActivityLog && (
  <button className="btn-icon" onClick={onOpenActivityLog} title="View Activity Log">
    <History size={16} />
  </button>
)}
```

**Change to:**
```tsx
{/* Activity Log button - desktop only (moved to overflow on mobile) */}
{!isMobile && onOpenActivityLog && (
  <button className="btn-icon" onClick={onOpenActivityLog} title="View Activity Log">
    <History size={16} />
  </button>
)}
```

### Step 3: Verify Mobile Overflow Menu Organization

- [ ] Check the mobile overflow menu (~line 295+) has consistent ordering
- [ ] Ensure all moved buttons are present in overflow menu with:
  - Correct icon import
  - Proper `role="menuitem"`
  - `data-testid` attribute following pattern `overflow-{action}-btn`
  - `handleOverflowAction` wrapper
- [ ] Overflow menu items should be alphabetically ordered by their label text for consistency:
  1. Browse Files
  2. Create a task with AI planning
  3. Git Manager
  4. Import from GitHub
  5. Manage Agents (if applicable)
  6. Open Terminal
  7. Scheduled Tasks
  8. Scripts (if applicable)
  9. Settings
  10. View Activity Log
  11. View Usage
  12. Workflow Steps (if applicable)

### Step 4: Update Tests

- [ ] Update `Header.test.tsx` to verify Usage button is NOT rendered inline on mobile
- [ ] Update `Header.test.tsx` to verify Activity Log button is NOT rendered inline on mobile
- [ ] Add tests verifying these buttons ARE accessible via overflow menu on mobile
- [ ] Run Header tests:
  ```bash
  pnpm test -- packages/dashboard/app/components/Header.test.tsx
  ```

**Test updates needed:**
- Look for tests that check "View usage" button visibility on mobile - update to check it's NOT in inline actions but IS in overflow menu
- Look for tests that check "View Activity Log" button - same treatment

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite:
  ```bash
  pnpm test
  ```
- [ ] Fix all failures
- [ ] Build passes:
  ```bash
  pnpm build
  ```
- [ ] Manual verification: At 375px viewport width (iPhone SE), verify:
  - Only search, view-toggle, pause/stop buttons, and overflow menu are inline
  - Usage and Activity Log are accessible via overflow menu
  - Overflow menu opens and functions correctly
  - No horizontal scroll or clipped buttons in header

### Step 6: Documentation & Delivery

- [ ] No documentation updates required (behavioral fix)
- [ ] Create changeset:
  ```bash
  cat > .changeset/fix-mobile-header-overflow.md << 'EOF'
  ---
  "@gsxdsm/fusion": patch
  ---

  Fix mobile header layout by moving Usage and Activity Log buttons to overflow menu
  EOF
  ```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Header displays maximum 6 inline buttons on mobile (search, view-toggle×2, pause, stop, overflow)
- [ ] Usage and Activity Log buttons accessible via overflow menu on mobile
- [ ] Desktop layout unchanged (all buttons still inline)
- [ ] No horizontal scroll at 375px viewport width
- [ ] Changeset included in commit

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-671): complete Step N — description`
- **Bug fixes:** `fix(FN-671): description`
- **Tests:** `test(FN-671): description`

## Do NOT

- Expand task scope beyond moving Usage and Activity Log buttons
- Modify CSS files (this is a component logic change only)
- Remove buttons entirely - they must remain accessible via overflow menu
- Skip tests or manual verification
- Modify files outside the File Scope without good reason
