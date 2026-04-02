# Task: KB-302 - Fix Save Button on Quick Add Task

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple bug fix - adding missing event handler to prevent focus loss when clicking Save button. Low blast radius, common pattern already used elsewhere in the component.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

The Save button in the QuickEntryBox component (list view task creation) doesn't work reliably because clicking it causes the textarea to lose focus, which triggers a 200ms collapse timer that can interrupt the click handler. The fix is to add `onMouseDown={(e) => e.preventDefault()}` to the Save button - the same pattern already used by all dropdown menus in the component (dependency dropdown, model dropdown, refine menu).

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` - The component with the bug
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` - Existing tests (all pass currently)

Key areas to examine:
1. The `handleBlur` function (lines ~355-370) - sets 200ms timeout to collapse controls
2. The `handleSaveClick` function (lines ~397-407) - the save button handler
3. The Save button JSX (lines ~630-645) - missing onMouseDown handler
4. Other buttons in the same block - Plan button, Subtask button (also missing protection)
5. Dropdown implementations - see how they use `onMouseDown={(e) => e.preventDefault()}`

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` (modify)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (add test for blur protection)

## Steps

### Step 1: Add onMouseDown Protection to Action Buttons

- [ ] Add `onMouseDown={(e) => e.preventDefault()}` to the Save button to prevent textarea blur
- [ ] Add the same protection to the Plan button and Subtask button (they have the same blur issue)
- [ ] Verify the Refine button already has protection (it's inside a div with the handler)

**Code locations to modify:**
- Save button (~line 636): Add `onMouseDown={(e) => e.preventDefault()}` prop
- Plan button (~line 614): Add `onMouseDown={(e) => e.preventDefault()}` prop  
- Subtask button (~line 625): Add `onMouseDown={(e) => e.preventDefault()}` prop

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Add Regression Test

- [ ] Add test case "Save button prevents textarea blur on mousedown" that verifies the onMouseDown handler exists
- [ ] Add similar test for Plan and Subtask buttons
- [ ] Ensure test simulates the blur scenario: focus textarea, trigger mousedown on save button, verify controls stay expanded

**Test approach:**
```tsx
it('Save button prevents textarea blur on mousedown', () => {
  renderQuickEntryBox();
  const textarea = screen.getByTestId('quick-entry-input');
  
  // Focus and expand
  fireEvent.focus(textarea);
  fireEvent.change(textarea, { target: { value: 'Task' } });
  
  // Get save button and trigger mousedown
  const saveButton = screen.getByTestId('save-button');
  fireEvent.mouseDown(saveButton);
  
  // Controls should still be visible (blur was prevented)
  expect(screen.getByTestId('save-button')).toBeTruthy();
});
```

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite for QuickEntryBox component
- [ ] Verify all 55 existing tests still pass
- [ ] Verify new regression tests pass
- [ ] Build passes: `pnpm build`

**Test command:**
```bash
cd packages/dashboard && pnpm test -- QuickEntryBox.test
```

### Step 4: Documentation & Delivery

- [ ] Changeset not needed - bug fix for unreleased UI component
- [ ] Verify fix works manually if possible (check browser behavior)

## Completion Criteria

- [ ] All three buttons (Save, Plan, Subtask) have onMouseDown handler preventing blur
- [ ] New regression tests verify blur protection works
- [ ] All 55+ existing tests pass
- [ ] Build passes

## Git Commit Convention

- **Step completion:** `feat(KB-302): add onMouseDown protection to QuickEntryBox action buttons`
- **Tests:** `test(KB-302): add regression tests for button blur protection`

## Do NOT

- Change the actual save functionality (localStorage + toast)
- Modify the Enter-to-create behavior
- Refactor the blur/collapse timing logic
- Add new features or change UI appearance
- Modify any other components
