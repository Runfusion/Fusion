# Task: KB-009 - Move Activity Feed to Its Own Tab in Task Detail Modal

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI refactoring task with minimal blast radius. The activity feed currently exists in the definition tab and needs to be moved to a new third tab. Pattern is consistent with existing tab implementation.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Move the activity feed section from the "Definition" tab to its own dedicated "Activity" tab in the task detail modal. This will clean up the definition tab and provide a clearer separation of concerns between the task specification, execution logs, and activity history.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskDetailModal.tsx` — Current implementation with existing tab system and activity feed location
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Existing test patterns for tab switching
- `packages/dashboard/app/styles.css` — CSS for `.detail-tabs`, `.detail-tab`, `.detail-tab-active`, and `.detail-activity` classes

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx`
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx`
- `packages/dashboard/app/styles.css` (verify existing styles are sufficient, no changes expected)

## Steps

### Step 1: Refactor Tab State and Add Activity Tab

- [ ] Change `activeTab` state type from `"definition" | "agent-log"` to `"definition" | "activity" | "agent-log"`
- [ ] Add third "Activity" tab button in the tab bar between "Definition" and "Agent Log"
- [ ] Ensure tab button styling matches existing tabs using `detail-tab` and `detail-tab-active` classes
- [ ] Run targeted tests for changed files: `pnpm test -- packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 2: Move Activity Feed to New Tab Content

- [ ] Extract activity feed JSX from definition tab content (the `.detail-activity` section)
- [ ] Create new conditional branch for `activeTab === "activity"` rendering the activity feed
- [ ] Ensure activity feed uses existing `detail-activity`, `detail-activity-list`, `detail-log-entry` CSS classes
- [ ] Remove activity section from definition tab content
- [ ] Definition tab should now only show: prompt, attachments, dependencies
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 3: Add Tests for Activity Tab

- [ ] Add test: "defaults to the Definition tab" (verify activity feed is NOT visible initially)
- [ ] Add test: "switches to Activity tab and shows activity feed" — click Activity tab, verify `.detail-activity-list` or `.detail-log-empty` is visible
- [ ] Add test: "activity tab renders log entries correctly" — test with task containing log entries
- [ ] Add test: "activity tab shows empty state when no logs" — test with empty log array
- [ ] Add test: "can switch between all three tabs" — Definition → Activity → Agent Log → Definition
- [ ] Run targeted tests, all must pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Open dashboard, click a task, verify three tabs exist and activity feed displays correctly

### Step 5: Documentation & Delivery

- [ ] No documentation updates required (UI change is self-evident)
- [ ] Out-of-scope findings: If tab styling needs mobile adjustments, create follow-up task

## Documentation Requirements

**Must Update:**
- None

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Three tabs visible in task detail modal: "Definition", "Activity", "Agent Log"
- [ ] Activity feed displays correctly when Activity tab is selected
- [ ] Definition tab no longer contains activity section

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-009): complete Step N — description`
- **Bug fixes:** `fix(KB-009): description`
- **Tests:** `test(KB-009): description`

## Do NOT

- Change the CSS styling of existing tabs or activity feed (use existing classes)
- Modify the activity feed data structure or log entry format
- Add new features to the activity feed (keep existing functionality)
- Change the order of Definition and Agent Log tabs (only insert Activity between them)
- Modify the Agent Log viewer component
- Skip tests or rely on manual verification alone
