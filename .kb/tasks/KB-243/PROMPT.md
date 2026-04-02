# Task: KB-243 - Fix planning mode loading state after first step

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Simple UI fix in a single React component. Changes loading text and preserves streaming output display during subsequent planning steps.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix the planning mode UX bug where after submitting a response to the first (or any) question, the loading state shows "Connecting..." instead of an appropriate thinking message like "Generating questions..." or "Thinking". The fix should preserve the streaming output preview (showing agent thinking content) during all loading states, similar to the initial planning step experience.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/PlanningModeModal.tsx` — The main planning modal component with the loading state logic
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` — Existing tests to understand expected behavior
- `packages/dashboard/app/styles.css` — Styles for planning UI (`.planning-loading`, `.planning-thinking-container`, `.planning-thinking-output`)

## File Scope

- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (modified — add/update tests)

## Steps

### Step 1: Fix Loading State Text and Streaming Output Display

- [ ] Change the loading state message from "Connecting..." to "Generating next question..." (or similar appropriate text)
- [ ] Ensure the streaming output preview (`planning-thinking-container`) is shown even when `streamingOutput` is initially empty during subsequent planning steps
- [ ] The thinking output preview should appear consistently across all loading states (initial start AND after question submission)
- [ ] Keep the "AI is thinking..." text when streaming output content arrives

**Current behavior to fix:**
```tsx
// Line ~325 in PlanningModeModal.tsx
{view.type === "loading" && (
  <div className="planning-loading">
    <Loader2 size={40} className="spin" style={{ color: "var(--todo)" }} />
    <p>{streamingOutput ? "AI is thinking..." : "Connecting..."}</p>
    {streamingOutput && (  // ← This condition hides the preview when empty!
      <div className="planning-thinking-container">...
    )}
  </div>
)}
```

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add/update tests in `PlanningModeModal.test.tsx` to verify:
  - Loading state shows appropriate text ("Generating next question..." or similar) after submitting a response
  - The thinking output container is visible even when streaming output is initially empty
  - The preview shows once streaming content arrives
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (modified)

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (UI behavior fix)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if discovered

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Planning mode loading state shows appropriate message after submitting any question response
- [ ] Streaming output preview is consistently visible during all loading states

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-243): complete Step N — description`
- **Bug fixes:** `fix(KB-243): description`
- **Tests:** `test(KB-243): description`

## Do NOT

- Expand task scope beyond the loading state fix
- Skip tests
- Modify files outside the File Scope
- Change the planning API or server-side behavior
- Alter the overall planning flow or question logic
