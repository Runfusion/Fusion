# Task: KB-191 - Change Request Refinement Button to "Refine"

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple UI text change with test updates. Low blast radius, no security implications, fully reversible.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Change the "Request Refinement" button text in the task detail modal to simply say "Refine" for a more concise UI. Update the corresponding modal title for consistency. This is a minor UI polish change that affects only the dashboard TaskDetailModal component.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskDetailModal.tsx` — Contains the button on line 943 and modal title on line 1014
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Contains tests that reference the button text (lines around 2033-2314)

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx` — Modify button text and modal title
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Update all test assertions referencing the old text

## Steps

### Step 1: Update Button and Modal Title Text

- [ ] Change button text from "Request Refinement" to "Refine" on line 943
- [ ] Change modal title from "Request Refinement" to "Refine" on line 1014
- [ ] Verify no other UI strings reference "Request Refinement" in this file

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 2: Update Test Assertions

- [ ] Update all test assertions looking for "Request Refinement" button text to look for "Refine"
- [ ] Update test descriptions if they reference "Request Refinement" as a label
- [ ] Keep the h3 selector check for the modal title but expect "Refine" instead
- [ ] Run tests to confirm they pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to verify all tests pass
- [ ] Run `pnpm build` to ensure no TypeScript errors
- [ ] Verify the changes render correctly in the UI (button shows "Refine", modal title shows "Refine")

### Step 4: Documentation & Delivery

- [ ] Confirm no documentation updates needed (this is a UI text change only)
- [ ] Create changeset since this affects the published `@dustinbyrne/kb` package CLI/dashboard UI

**Changeset:**
```bash
cat > .changeset/change-refine-button-text.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Changed "Request Refinement" button text to "Refine" for a more concise UI
EOF
```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Button text changed from "Request Refinement" to "Refine"
- [ ] Modal title changed from "Request Refinement" to "Refine"

## Git Commit Convention

- **Step completion:** `feat(KB-191): change request refinement button to "Refine"`
- **Test fixes:** `test(KB-191): update test assertions for refine button`
- **Changeset:** Include changeset file in the main commit

## Do NOT

- Expand task scope (this is strictly a text change)
- Skip test updates
- Modify files outside the File Scope
- Change any functionality beyond the button text and modal title
