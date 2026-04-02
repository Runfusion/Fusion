# Task: KB-280 - Add a save button to the quick add test entry

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple UI addition adding a Save button next to the existing Refine button. Reuses existing localStorage persistence pattern. Minimal blast radius, well-understood pattern.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add an explicit Save button to the QuickEntryBox component, positioned next to the Refine button. While the component already auto-saves to localStorage on every keystroke, the Save button provides visual confirmation and allows users to explicitly trigger a save with feedback. This improves user confidence that their draft task description is persisted.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` — The main component to modify
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing tests to extend
- `packages/dashboard/app/styles.css` — Review `.quick-entry-controls-left`, `.refine-trigger-wrap`, and button styling patterns
- `packages/dashboard/app/api.ts` — Check if `addToast` pattern is imported/used correctly

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` — Add Save button component code
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Add tests for Save button
- `packages/dashboard/app/styles.css` — Add/verify Save button styling (if needed, may reuse existing patterns)

## Steps

### Step 1: Add Save Button to QuickEntryBox

- [ ] Import `Save` icon from `lucide-react` alongside existing icons
- [ ] Add `handleSaveClick` callback that:
  - Explicitly saves current description to localStorage under `STORAGE_KEY`
  - Calls `addToast("Draft saved", "success")` for visual feedback
  - Button should be disabled when `description.trim()` is empty
- [ ] Add Save button in the `quick-entry-controls-left` div, positioned immediately before the Refine button (between Subtask button and Refine button)
- [ ] Button should use the same styling pattern as other action buttons: `className="btn btn-sm"`
- [ ] Include `data-testid="save-button"` for test targeting
- [ ] Button should have `title="Save draft to browser storage"` for accessibility
- [ ] Button should show `disabled={!description.trim() || isSubmitting}` state

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Add Styling (if needed)

- [ ] Check if Save button renders correctly with existing `.btn.btn-sm` styles
- [ ] If button needs specific styling, add minimal CSS in `styles.css` following the pattern of `.refine-button` or other action buttons
- [ ] Ensure button fits within `quick-entry-controls-left` flex container without breaking layout

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — only if necessary)

### Step 3: Add Tests for Save Button

- [ ] Add test: "shows save button when text is entered" — verify button appears on focus with content
- [ ] Add test: "save button is disabled when textarea is empty" — verify disabled state when no content
- [ ] Add test: "save button is disabled during submission" — verify disabled when `isSubmitting` is true
- [ ] Add test: "clicking save button persists to localStorage" — verify `localStorage.setItem` called with correct key and value
- [ ] Add test: "clicking save button shows success toast" — verify `addToast` called with "Draft saved" and "success" type
- [ ] Add test: "save button has correct test id" — verify `data-testid="save-button"` exists

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to execute all tests
- [ ] Verify all new tests pass
- [ ] Verify no existing QuickEntryBox tests are broken
- [ ] Run `pnpm build` to ensure TypeScript compiles without errors
- [ ] Manually verify in browser:
  - Type text in QuickEntryBox
  - Verify Save button appears next to Refine button
  - Click Save button, verify toast appears
  - Verify button is disabled when input is empty
  - Verify layout doesn't break on different screen sizes

### Step 5: Documentation & Delivery

- [ ] No documentation updates required (UI change is self-explanatory)
- [ ] Create changeset for the dashboard package (patch bump):
  ```bash
  cat > .changeset/add-save-button-quick-entry.md << 'EOF'
  ---
  "@kb/dashboard": patch
  ---

  Add explicit Save button to QuickEntryBox for draft persistence feedback
  EOF
  ```
- [ ] Verify changeset file is created and staged

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (new and existing)
- [ ] Save button appears next to Refine button in QuickEntryBox
- [ ] Clicking Save triggers localStorage save and shows success toast
- [ ] Button disabled state works correctly (empty input, during submission)
- [ ] Build passes without errors
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-280): complete Step N — description`
- **Bug fixes:** `fix(KB-280): description`
- **Tests:** `test(KB-280): description`

Example commits:
```
feat(KB-280): complete Step 1 — add Save button to QuickEntryBox
test(KB-280): add tests for Save button functionality
feat(KB-280): complete Step 4 — verify all tests passing
```

## Do NOT

- Expand task scope beyond the Save button (don't add other features)
- Skip tests
- Modify files outside the File Scope
- Change the Refine button behavior or position
- Remove or alter the existing auto-save functionality
- Add complex new CSS when existing button styles suffice
