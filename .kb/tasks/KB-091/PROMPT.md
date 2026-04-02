# Task: KB-091 - Reverse Agent Log Order on Dashboard Card Details

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 — None

**Assessment:** Implementation already exists; this is verification to ensure the feature works correctly with streaming logs. Low blast radius as changes are isolated to a single component.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Verify and ensure the Agent Log tab in the Task Detail Modal displays streaming agent logs with the newest entries at the top (reverse chronological order). This improves UX by showing the most recent agent activity immediately without requiring users to scroll down. Additionally, ensure the log viewer auto-scrolls to keep the latest entries visible as new logs stream in.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/AgentLogViewer.tsx` — The component that renders agent log entries
- `packages/dashboard/app/components/__tests__/AgentLogViewer.test.tsx` — Existing tests for the log viewer
- `packages/dashboard/app/hooks/useAgentLogs.ts` — Hook that manages log fetching and SSE streaming
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Where AgentLogViewer is used (see the "agent-log" tab section)

## File Scope

- `packages/dashboard/app/components/AgentLogViewer.tsx`
- `packages/dashboard/app/components/__tests__/AgentLogViewer.test.tsx`

## Steps

### Step 1: Verify Reverse Chronological Order

- [ ] Confirm `AgentLogViewer` reverses entries with `[...entries].reverse()` on line ~36
- [ ] Verify the JSDoc comment accurately describes the behavior
- [ ] Run existing tests to confirm they pass: `pnpm vitest run app/components/__tests__/AgentLogViewer.test.tsx`
- [ ] Review test cases to ensure they verify reverse order display

**Artifacts:**
- `packages/dashboard/app/components/AgentLogViewer.tsx` (verified, no changes expected)
- `packages/dashboard/app/components/__tests__/AgentLogViewer.test.tsx` (verified, no changes expected)

### Step 2: Add Auto-Scroll to Latest Entries

- [ ] Add auto-scroll behavior to keep the newest entries visible as logs stream in
- [ ] Use `useRef` to get a reference to the scrollable container
- [ ] Use `useEffect` to scroll to top when new entries arrive (since newest are first)
- [ ] Ensure scroll only happens when already near the top (to avoid interrupting user scrollback)
- [ ] Add a test to verify auto-scroll behavior works correctly

**Artifacts:**
- `packages/dashboard/app/components/AgentLogViewer.tsx` (modified)
- `packages/dashboard/app/components/__tests__/AgentLogViewer.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run AgentLogViewer-specific tests: `pnpm vitest run app/components/__tests__/AgentLogViewer.test.tsx`
- [ ] Run all dashboard tests: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Update component JSDoc if behavior changed
- [ ] Create changeset file for the dashboard package (patch bump)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/app/components/AgentLogViewer.tsx` — Update JSDoc if auto-scroll behavior was added

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Agent log displays newest entries first (verified)
- [ ] Auto-scroll keeps latest entries visible during streaming

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-091): complete Step N — description`
- **Bug fixes:** `fix(KB-091): description`
- **Tests:** `test(KB-091): description`

## Do NOT

- Expand task scope to other log display components
- Skip tests
- Modify files outside the File Scope without good reason
- Remove the existing reverse order functionality
- Add complex scroll position management (keep it simple)
- Commit without the task ID prefix
