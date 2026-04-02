# Task: KB-224 - Combine the definition and spec tabs on a card

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** UI consolidation task with limited blast radius. Changes are localized to TaskDetailModal component, removing one tab and integrating SpecEditor functionality into the Definition tab. No security or data model changes.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Combine the "Definition" and "Spec" tabs in the task card detail modal into a single unified experience. Currently these tabs show similar content (the task specification/PROMPT.md), but the Spec tab adds edit capability and AI revision features. The goal is to remove the redundant "Spec" tab and add an "Edit" button to the Definition tab that activates the full SpecEditor experience including the "refine with AI" functionality.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx` — Main component with tab structure and definition content rendering
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/SpecEditor.tsx` — Component providing view/edit toggle and AI revision UI
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Existing tests for the modal
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/SpecEditor.test.tsx` — Tests for spec editor functionality
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Styles for tabs and spec editor (search for `.detail-tabs`, `.spec-editor*`)

## File Scope

- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx`
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx`

## Steps

### Step 1: Remove Spec Tab and Update Tab State

- [ ] Remove the "Spec" tab button from the `detail-tabs` section in TaskDetailModal
- [ ] Update the `activeTab` state type to remove `"spec"` as an option (keep: definition, activity, agent-log, steering, model)
- [ ] Remove the conditional rendering block for `activeTab === "spec"`
- [ ] Update any remaining references to the spec tab in the component

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 2: Integrate Edit Mode into Definition Tab

- [ ] Add local state `isEditingSpec` to track edit mode in the Definition tab
- [ ] Add an "Edit" button in the Definition tab view (near the markdown content, styled appropriately)
- [ ] When Edit is clicked, show the SpecEditor content view (textarea for editing)
- [ ] Preserve the existing `handleSaveSpec` and `handleRequestSpecRevision` handlers already in TaskDetailModal
- [ ] Show the "Ask AI to Revise" section when in edit mode (reuse the feedback textarea and request button)
- [ ] Add Cancel button to exit edit mode without saving
- [ ] In view mode, continue to render the markdown preview (existing behavior with `ReactMarkdown`)
- [ ] Ensure keyboard shortcuts work: Ctrl+Enter to save, Escape to cancel

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 3: Update Styles

- [ ] Ensure the edit mode styling matches the existing SpecEditor appearance
- [ ] Add any needed CSS classes to styles.css if the integrated view needs layout adjustments
- [ ] Verify the "Ask AI to Revise" section displays properly in the combined view

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified if needed)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update existing TaskDetailModal tests that reference the Spec tab to use the new Edit button flow instead
- [ ] Add new tests for the integrated edit mode:
  - Clicking Edit shows the textarea with current prompt content
  - Clicking Cancel returns to view mode without saving
  - Saving updates the task and returns to view mode
  - AI revision feedback section appears in edit mode
  - Requesting AI revision works and closes modal
- [ ] Run `pnpm test` and fix all failures
- [ ] Run `pnpm build` and verify it passes

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 5: Documentation & Delivery

- [ ] Update any inline comments in TaskDetailModal that reference the old tab structure
- [ ] Create changeset file for this UI improvement (patch level - internal dashboard change)
- [ ] Out-of-scope findings: If there are other redundant tabs or UI improvements needed, create follow-up tasks via `task_create` tool

**Artifacts:**
- `.changeset/combine-definition-spec-tabs.md` (new)

## Documentation Requirements

**Must Update:**
- None (this is a pure UI consolidation with no user-facing documentation changes)

**Check If Affected:**
- AGENTS.md — Check if it mentions the tab structure (unlikely, but verify)

## Completion Criteria

- [ ] Definition and Spec tabs are combined into one "Definition" tab
- [ ] Edit button appears in Definition tab when not in edit mode
- [ ] Clicking Edit shows the full editing interface including:
  - Textarea with current prompt content
  - Save/Cancel buttons
  - "Ask AI to Revise" section with feedback input and request button
- [ ] All existing SpecEditor functionality preserved (save, cancel, AI revision)
- [ ] All tests pass
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-224): complete Step N — description`
- **Bug fixes:** `fix(KB-224): description`
- **Tests:** `test(KB-224): description`

## Do NOT

- Delete or modify the SpecEditor component itself (it may be used elsewhere)
- Change the API or data models
- Remove any functionality from SpecEditor — just integrate it differently
- Skip updating tests
- Add unrelated UI improvements (keep scope focused on tab consolidation)
