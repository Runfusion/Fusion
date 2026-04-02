# Task: KB-148 - Show model used in the execution log in dashboard

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI enhancement with limited blast radius — only affects AgentLogViewer component and its parent. Well-understood pattern following existing model display conventions in ModelSelectorTab.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Display the AI model configuration (executor and validator models) in the agent log viewer on the dashboard. When viewing a task's agent log, users should see which models were used during execution — either the specific models configured for that task or an indication that default models were used.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/AgentLogViewer.tsx` — The component that renders agent log entries
- `packages/dashboard/app/components/AgentLogViewer.css` — Styles for the log viewer (if it exists, otherwise styles are inline)
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Parent component that renders AgentLogViewer
- `packages/dashboard/app/components/ModelSelectorTab.tsx` — Reference for how model display is handled elsewhere
- `packages/core/src/types.ts` — TypeScript types for Task (modelProvider, modelId, validatorModelProvider, validatorModelId)

## File Scope

- `packages/dashboard/app/components/AgentLogViewer.tsx` — Add model display props and UI
- `packages/dashboard/app/components/__tests__/AgentLogViewer.test.tsx` — Add tests for model display
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Pass model props to AgentLogViewer

## Steps

### Step 1: Add Model Display to AgentLogViewer

- [ ] Add optional `executorModel` and `validatorModel` props to AgentLogViewerProps interface
  - Type: `{ provider?: string; modelId?: string } | null` for each
- [ ] Create a model info header component inside AgentLogViewer that displays:
  - Executor model: show "{provider}/{modelId}" if set, otherwise "Using default"
  - Validator model: show "{provider}/{modelId}" if set, otherwise "Using default"
- [ ] Style the header to be subtle but visible (use CSS variables for theming)
  - Background: subtle secondary color
  - Text: muted color
  - Position at top of log viewer, above the scrollable entries area
- [ ] Import and use `ProviderIcon` component (same pattern as ModelSelectorTab) to show provider icons

**Artifacts:**
- `packages/dashboard/app/components/AgentLogViewer.tsx` (modified)

### Step 2: Update TaskDetailModal to Pass Model Props

- [ ] Locate the AgentLogViewer usage in TaskDetailModal (inside the "agent-log" tab)
- [ ] Pass the task's model configuration as props:
  - `executorModel`: derived from `task.modelProvider` and `task.modelId`
  - `validatorModel`: derived from `task.validatorModelProvider` and `task.validatorModelId`
- [ ] Use the same normalization pattern as ModelSelectorTab (handle null/undefined as unset)

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 3: Add Tests for Model Display

- [ ] Add test case: renders model info header when executor model is set
- [ ] Add test case: renders "Using default" when no executor model override is set
- [ ] Add test case: renders model info header when validator model is set
- [ ] Add test case: renders "Using default" when no validator model override is set
- [ ] Add test case: renders both models when both are configured
- [ ] Add test case: renders no model header when both models are null/undefined (edge case — still show header indicating defaults)
- [ ] Verify all existing tests still pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/AgentLogViewer.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in the dashboard package — all tests must pass
- [ ] Run `pnpm typecheck` in the dashboard package — no type errors
- [ ] Run `pnpm build` — build succeeds without errors
- [ ] Manual verification: Open a task in the dashboard, click "Agent Log" tab, verify model info is displayed correctly
  - Test with task that has model overrides set
  - Test with task that uses default models

### Step 5: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` if there's a section about the agent log viewer
- [ ] Create changeset file if this affects the published `@dustinbyrne/kb` package (it doesn't — dashboard is private)
- [ ] Out-of-scope findings: None expected

## Documentation Requirements

**Must Update:**
- None required for this internal dashboard feature

**Check If Affected:**
- `packages/dashboard/README.md` — Check if there's an agent log section to update

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Type checking passes
- [ ] Build passes
- [ ] Model information displays correctly in agent log viewer

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-148): complete Step N — description`
- **Bug fixes:** `fix(KB-148): description`
- **Tests:** `test(KB-148): description`

## Do NOT

- Expand task scope beyond showing model info in the agent log viewer
- Skip tests for the new functionality
- Modify the agent logging backend or add model info to individual log entries
- Change how models are selected or configured
- Add animation or complex UI effects — keep it simple and consistent with existing patterns
- Modify the `AgentLogEntry` type in core package
