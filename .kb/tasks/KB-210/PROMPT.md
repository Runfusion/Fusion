# Task: KB-210 - Fix dashboard Header component mobile viewport tests

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple test file corrections to align test expectations with actual component behavior. No component logic changes.
**Score:** 1/8 — Blast radius: 0 (tests only), Pattern novelty: 0 (simple test fixes), Security: 0, Reversibility: 2

## Mission

Fix 2 failing mobile viewport tests in the dashboard Header component. The tests have incorrect expectations that don't match the actual component behavior:

1. **Terminal button visibility test** expects terminal to be inline on mobile, but the component renders it in the overflow menu on mobile.

2. **Usage button overflow menu test** expects "View usage" text in the overflow menu, but the component renders the usage button inline on all screens (not inside the overflow menu).

These are test specification errors, not component bugs. The tests need to be updated to match the intended component behavior.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/__tests__/Header.test.tsx` — The failing tests at lines 430-443
- `packages/dashboard/app/components/Header.tsx` — The component implementation showing mobile behavior

## File Scope

- `packages/dashboard/app/components/__tests__/Header.test.tsx` (modify)

## Steps

### Step 1: Analyze Component Behavior

- [ ] Read Header.tsx to confirm mobile rendering behavior:
  - Terminal button: rendered with `{!isMobile && (...)}` — only inline on desktop, moved to overflow menu on mobile
  - Usage button: rendered with `{onOpenUsage && (...)}` — inline on ALL screen sizes (no `isMobile` condition)
  - Pause/Stop buttons: always inline (no `isMobile` condition)

### Step 2: Fix Terminal Button Test

- [ ] Locate the failing test: "shows terminal and pause controls inline on mobile" (around line 430)
- [ ] Update the test to match actual behavior:
  - Remove expectation for inline terminal button on mobile (`screen.getByTitle("Open Terminal")` will fail)
  - Keep expectations for pause/stop buttons being inline
  - Add expectation that terminal is accessible via overflow menu on mobile (open overflow menu, check for "Open Terminal" text)
- [ ] Run the specific test to verify it passes

**Test change required:**
```typescript
// OLD (incorrect expectation):
it("shows terminal and pause controls inline on mobile", () => {
  render(...);
  expect(screen.getByTitle("Open Terminal")).toBeDefined(); // FAILS - not inline on mobile
  expect(screen.getByTitle("Pause scheduling")).toBeDefined();
  expect(screen.getByTitle("Stop AI engine")).toBeDefined();
});

// NEW (correct expectation):
it("shows terminal in overflow menu and pause controls inline on mobile", () => {
  render(...);
  // Terminal is in overflow menu on mobile, not inline
  fireEvent.click(screen.getByTitle("More header actions"));
  expect(screen.getByText("Open Terminal")).toBeDefined();
  // Pause/stop are always inline
  expect(screen.getByTitle("Pause scheduling")).toBeDefined();
  expect(screen.getByTitle("Stop AI engine")).toBeDefined();
});
```

### Step 3: Fix Usage Button Test

- [ ] Locate the failing test: "overflow menu includes usage button when onOpenUsage provided" (around line 440)
- [ ] Update the test to match actual behavior:
  - The usage button is rendered inline on all screens with `title="View usage"`
  - It is NOT in the overflow menu
  - Change assertion from `screen.getByText("View usage")` (looking in overflow menu) to `screen.getByTitle("View usage")` (looking inline)
- [ ] Run the specific test to verify it passes

**Test change required:**
```typescript
// OLD (incorrect expectation):
it("overflow menu includes usage button when onOpenUsage provided", () => {
  render(<Header onOpenSettings={vi.fn()} onOpenUsage={vi.fn()} />);
  fireEvent.click(screen.getByTitle("More header actions"));
  expect(screen.getByText("View usage")).toBeDefined(); // FAILS - not in overflow menu
});

// NEW (correct expectation):
it("shows usage button inline when onOpenUsage provided", () => {
  render(<Header onOpenSettings={vi.fn()} onOpenUsage={vi.fn()} />);
  // Usage button is inline on all screens, not in overflow menu
  expect(screen.getByTitle("View usage")).toBeDefined();
});
```

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the Header test file to confirm both previously failing tests now pass:
  ```bash
  cd packages/dashboard && pnpm vitest run app/components/__tests__/Header.test.tsx
  ```
- [ ] Verify no new test failures introduced
- [ ] Confirm all 46 Header tests pass

### Step 5: Documentation & Delivery

- [ ] No documentation updates required (test-only change)
- [ ] Create changeset if this affects published package behavior (not applicable - test only)

## Completion Criteria

- [ ] All steps complete
- [ ] All 46 Header tests passing
- [ ] No changes to component source code (Header.tsx remains unchanged)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `test(KB-210): fix mobile viewport test expectations`

## Do NOT

- Modify Header.tsx component logic
- Change the mobile overflow menu structure
- Add or remove test cases (only fix existing ones)
- Skip running tests
- Commit without the task ID prefix
