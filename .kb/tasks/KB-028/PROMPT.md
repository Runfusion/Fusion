# Task: KB-028 - Pop-Out Terminal View with Tabs for Web Dashboard

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task creates a new UI component that integrates with existing log streaming infrastructure. The risk is moderate due to mobile responsiveness requirements and state management for multiple concurrent log streams.
**Score:** 5/8 — Blast radius: 2 (new component, minimal existing changes), Pattern novelty: 1 (follows existing modal/log patterns), Security: 1 (no new API endpoints), Reversibility: 1 (easy to remove)

## Mission

Create a pop-out terminal view component for the web dashboard that displays real-time agent logs from multiple tasks simultaneously using a tabbed interface. Users can open this terminal from a new header button and switch between active task logs. The component must be fully mobile-responsive, supporting touch gestures and adapting layout for small screens.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/AgentLogViewer.tsx` — Existing log rendering component to reuse
2. `packages/dashboard/app/hooks/useAgentLogs.ts` — Hook for fetching and streaming agent logs via SSE
3. `packages/dashboard/app/components/TaskDetailModal.tsx` — Reference for modal implementation patterns
4. `packages/dashboard/app/components/Header.tsx` — Where the terminal toggle button will be added
5. `packages/dashboard/app/App.tsx` — Top-level component where terminal modal state will be managed
6. `packages/dashboard/app/styles.css` — CSS variables and patterns to follow (especially modal and mobile responsive sections at the end)
7. `packages/dashboard/app/api.ts` — `fetchAgentLogs` function and `AgentLogEntry` type usage
8. `packages/core/src/types.ts` — `Task` and `AgentLogEntry` type definitions (import from `@kb/core`)

## File Scope

### New Files
- `packages/dashboard/app/components/TerminalModal.tsx` — Main pop-out terminal component with tabs
- `packages/dashboard/app/components/TerminalModal.test.tsx` — Test suite for terminal functionality
- `packages/dashboard/app/hooks/useMultiAgentLogs.ts` — Hook for managing multiple concurrent log streams
- `packages/dashboard/app/hooks/useMultiAgentLogs.test.ts` — Test suite for multi-log hook

### Modified Files
- `packages/dashboard/app/components/Header.tsx` — Add terminal toggle button
- `packages/dashboard/app/App.tsx` — Add terminal modal state and integration
- `packages/dashboard/app/styles.css` — Add terminal-specific styles and mobile responsive rules

## Steps

### Step 1: Create useMultiAgentLogs Hook

- [ ] Create `packages/dashboard/app/hooks/useMultiAgentLogs.ts`
- [ ] Hook manages multiple concurrent SSE connections for different task IDs
- [ ] Accepts array of task IDs and returns map of taskId → { entries, loading, clear }
- [ ] Properly opens/closes EventSource connections when task list changes
- [ ] Handle connection cleanup on unmount (critical for memory leak prevention)
- [ ] Import types: `import type { AgentLogEntry } from "@kb/core";`
- [ ] Write tests in `packages/dashboard/app/hooks/useMultiAgentLogs.test.ts`

**Test Requirements:**
- Hook initializes with empty entries for all provided task IDs
- Hook fetches historical logs for each task on mount
- Hook opens SSE connections for each task
- Hook merges live SSE events with historical entries
- Hook closes all SSE connections on unmount (memory leak prevention)
- Hook closes connection when task ID is removed from list
- Hook opens new connection when task ID is added to list
- Hook provides per-task clear function that resets entries

**Artifacts:**
- `packages/dashboard/app/hooks/useMultiAgentLogs.ts` (new)
- `packages/dashboard/app/hooks/useMultiAgentLogs.test.ts` (new)

### Step 2: Create TerminalModal Component

- [ ] Create `packages/dashboard/app/components/TerminalModal.tsx`
- [ ] Props interface: `{ isOpen: boolean; onClose: () => void; tasks: Task[] }`
- [ ] Import types: `import type { Task, AgentLogEntry } from "@kb/core";`
- [ ] Tab bar showing all in-progress tasks (use `--in-progress` color for active tab indicator)
- [ ] MVP scope: ONE tab per in-progress task only (no "All" interleaved view for MVP)
- [ ] Reuse `AgentLogViewer` component for log display area
- [ ] Use existing modal overlay pattern from `TaskDetailModal` (`.modal-overlay`, `.modal` classes)
- [ ] Full-height modal (90vh desktop, 100vh mobile) optimized for terminal viewing
- [ ] Add clear button per tab to clear that task's log buffer
- [ ] Auto-scroll to bottom handled by reused AgentLogViewer component
- [ ] Close button in header (× icon)
- [ ] Escape key handler to close modal
- [ ] Click outside modal content to close (overlay click handler)

**Artifacts:**
- `packages/dashboard/app/components/TerminalModal.tsx` (new)

### Step 3: Add Terminal Styles

- [ ] Add `.terminal-modal` class extending `.modal` with full-height styles (min-height: 90vh on desktop)
- [ ] Add `.terminal-tabs` class for horizontal scrollable tab bar (flex row, overflow-x-auto)
- [ ] Add `.terminal-tab` classes: default, active (with `--in-progress` color indicator), with close/clear button
- [ ] Add `.terminal-content` class for log viewer container (flex:1, display:flex, flex-direction:column)
- [ ] Mobile styles under `@media (max-width: 768px)`:
  - Full-screen modal (width:100%, height:100vh, border-radius:0)
  - Touch-friendly tabs (min-height: 44px for tap targets)
  - Safe area insets for mobile browsers (env(safe-area-inset-*))
- [ ] Follow existing CSS variable usage (`--bg`, `--surface`, `--border`, `--in-progress`, `--text`, `--text-muted`)
- [ ] Dark terminal aesthetic matching existing code blocks (`var(--card)` background, monospace font)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — add terminal section)

### Step 4: Integrate Terminal into App.tsx

- [ ] Add `terminalOpen` state variable (boolean, default false)
- [ ] Add `setTerminalOpen` handler
- [ ] Filter tasks to only "in-progress" column for terminal: `tasks.filter(t => t.column === "in-progress")`
- [ ] Render `TerminalModal` when `terminalOpen` is true
- [ ] Do NOT add keyboard shortcut for MVP (avoid conflict with browser dev tools `Ctrl+``)
- [ ] Ensure modal state resets when closed (active tab index resets)

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 5: Add Terminal Button to Header

- [ ] Add terminal icon button in `Header.tsx` actions area (next to settings gear icon)
- [ ] Import: `import { Terminal } from "lucide-react";`
- [ ] Show badge with count of active in-progress tasks when count > 0 (small circle badge)
- [ ] Button toggles terminal open/closed state via callback prop `onToggleTerminal`
- [ ] Add `onToggleTerminal: () => void` to Header props interface
- [ ] Button disabled state when no in-progress tasks (grayed out, `disabled` attribute)
- [ ] Tooltip/title: "Open Terminal View" for accessibility

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard`
- [ ] All new tests pass (TerminalModal, useMultiAgentLogs)
- [ ] All existing tests pass
- [ ] Build passes: `pnpm build` in `packages/dashboard`
- [ ] Typecheck passes: `pnpm typecheck` in `packages/dashboard`

**Test Requirements for TerminalModal.test.tsx:**
- Renders without crashing when open with empty task list
- Renders without crashing when open with multiple in-progress tasks
- Shows "No active tasks" or appropriate empty state when no in-progress tasks
- Tab switching changes which task's logs are displayed
- Active tab has correct styling (visual regression test)
- Clicking clear button clears that tab's log entries
- Modal closes on Escape key press
- Modal closes on overlay click
- Modal does not close when clicking inside modal content
- Header button is disabled when no in-progress tasks

**Test Requirements for useMultiAgentLogs.test.tsx:**
- Initializes with loading state for each task
- Fetches historical logs via `fetchAgentLogs` for each task on mount
- Opens SSE EventSource for each task ID
- Appends new entries when SSE events received
- Closes all EventSource connections on unmount (CRITICAL: verify with mock)
- Closes specific connection when task ID removed from array
- Opens new connection when task ID added to array
- `clear()` function resets entries for specific task only

**Artifacts:**
- `packages/dashboard/app/components/TerminalModal.test.tsx` (new)
- `packages/dashboard/app/hooks/useMultiAgentLogs.test.tsx` (new)

### Step 7: Documentation & Delivery

- [ ] Create changeset for the feature: `.changeset/add-terminal-view.md`
- [ ] Changeset should describe user-facing feature (not implementation details)

**Changeset content:**
```md
---
"@dustinbyrne/kb": minor
---

Add pop-out terminal view to dashboard for monitoring multiple active task logs simultaneously. Accessible via new terminal button in header when tasks are in progress.
```

- [ ] Verify no out-of-scope changes were made
- [ ] Verify all new files have proper imports and types

## Documentation Requirements

**Must Update:**
- `.changeset/add-terminal-view.md` — Create changeset file (required for published package)

**Check If Affected:**
- `packages/dashboard/README.md` — Update if file exists with new feature description (dashboard is private package, docs optional)
- `AGENTS.md` — No changes needed (this is internal dashboard feature, not agent-facing)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` in packages/dashboard)
- [ ] Build passing (`pnpm build` in packages/dashboard)
- [ ] Typecheck passing (`pnpm typecheck` in packages/dashboard)
- [ ] Terminal button appears in header with icon
- [ ] Button shows badge count when in-progress tasks exist
- [ ] Button disabled when no in-progress tasks
- [ ] Clicking button opens pop-out terminal with tabs for each in-progress task
- [ ] Each tab shows real-time streaming logs for that task
- [ ] Tab switching works correctly
- [ ] Clear button per tab resets that tab's log buffer
- [ ] Mobile: Terminal modal is full-screen with usable touch targets (44px min)
- [ ] Desktop: Terminal modal is large (90vh height) with clear tab navigation
- [ ] Modal closes via Escape key, overlay click, or close button
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-028): complete Step N — description`
- **Bug fixes:** `fix(KB-028): description`
- **Tests:** `test(KB-028): description`

Example commits:
- `feat(KB-028): complete Step 1 — create useMultiAgentLogs hook with tests`
- `feat(KB-028): complete Step 2 — create TerminalModal component`
- `feat(KB-028): complete Step 3 — add terminal styles and mobile responsive rules`
- `feat(KB-028): complete Step 4 — integrate terminal into App.tsx`
- `feat(KB-028): complete Step 5 — add terminal button to Header`
- `test(KB-028): add TerminalModal and useMultiAgentLogs test suites`
- `feat(KB-028): complete Step 7 — add changeset and finalize`

## Do NOT

- Modify the existing `AgentLogViewer` component behavior (reuse it as-is)
- Create new API endpoints (use existing `/api/tasks/:id/logs` and `/api/tasks/:id/logs/stream`)
- Add task management features to the terminal (it's view-only for logs)
- Change the existing task detail modal's agent log tab
- Add "All" interleaved tab view for MVP (out of scope)
- Add log search or filtering in MVP
- Add keyboard shortcuts that conflict with browser defaults (e.g., avoid `Ctrl+``)
- Modify the core package types or store
- Skip mobile responsive design
- Skip writing tests for the new hook and component
- Skip SSE connection cleanup (memory leak prevention is required)
