# Task: KB-159 - Fix Planning Mode Infinite Spinner and Add Streaming Output

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** The task requires debugging and fixing a hang issue in the planning dialog, plus implementing SSE streaming for AI thinking output. Moderate blast radius (planning module + API + frontend), but uses established patterns (SSE already exists for terminal).
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Fix the planning mode dialog that spins indefinitely showing "Thinking..." when users enable planning mode on new tasks. Additionally, implement real-time streaming of the AI's thinking process so users can see the AI is actively working rather than staring at a static spinner.

The planning mode currently uses stubbed AI logic that should return immediately, but something is causing the loading state to hang. The fix requires:
1. Debugging and fixing the root cause of the infinite spinner
2. Integrating the real AI agent (`createKbAgent` from `@kb/engine`) to replace stubbed logic
3. Implementing SSE streaming for planning sessions to show thinking progress
4. Updating the frontend to display streaming thinking output

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/dashboard/src/planning.ts` — Current planning session implementation (stubbed AI)
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — API routes for planning endpoints (lines ~2139-2274)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/PlanningModeModal.tsx` — Frontend planning modal
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Frontend API functions for planning
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/sse.ts` — Existing SSE utilities
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/terminal.ts` — Terminal SSE implementation (reference pattern)
- `/Users/eclipxe/Projects/kb/packages/engine/src/pi.ts` — `createKbAgent` factory with `onThinking` callback

## File Scope

- `/Users/eclipxe/Projects/kb/packages/dashboard/src/planning.ts` — Refactor to use real AI agent with streaming
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Add SSE streaming endpoint for planning
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Add SSE streaming function
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/PlanningModeModal.tsx` — Update to show streaming output

## Steps

### Step 1: Diagnose and Fix Infinite Spinner Root Cause

- [ ] Review the `handleStartPlanningWithPlan` flow in `PlanningModeModal.tsx` to understand state transitions
- [ ] Add detailed logging to backend `createSession` in `planning.ts` to trace execution
- [ ] Identify why the loading state persists (check error handling, missing state transitions, race conditions)
- [ ] Fix the root cause ensuring the loading spinner transitions to either question view or error state
- [ ] Test manually by enabling planning mode on a new task

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/planning.ts` (modified — logging and/or bug fix)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/PlanningModeModal.tsx` (modified — state fix if needed)

### Step 2: Implement Planning Session SSE Infrastructure

- [ ] Create new type `PlanningStreamEvent` in planning.ts with variants: `thinking`, `question`, `summary`, `error`, `complete`
- [ ] Add `PlanningStreamManager` class to manage active SSE connections per session (similar pattern to terminal session manager)
- [ ] Store streaming callbacks in session state to enable pushing updates from AI agent
- [ ] Add route `GET /api/planning/:sessionId/stream` in routes.ts following SSE pattern from terminal.ts

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/planning.ts` (modified — streaming infrastructure)
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` (modified — new SSE endpoint)

### Step 3: Integrate Real AI Agent with Streaming

- [ ] Modify `createSession` to use `createKbAgent` with system prompt `PLANNING_SYSTEM_PROMPT`
- [ ] Wire up `onThinking` callback to emit `thinking` events via SSE
- [ ] Wire up `onText` callback to capture AI response text
- [ ] Parse AI JSON responses into `PlanningQuestion` or `PlanningSummary` structures
- [ ] Update `submitResponse` to continue the AI conversation with user responses
- [ ] Ensure session cleanup disposes of AI agent resources

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/planning.ts` (modified — AI agent integration)

### Step 4: Update Frontend for Streaming Display

- [ ] Add new API function `streamPlanningSession(sessionId: string, onEvent: (event) => void)` in `api.ts`
- [ ] Modify `PlanningModeModal` to connect to SSE stream when entering loading state
- [ ] Add `streamingOutput` state to accumulate thinking text
- [ ] Update loading view to show scrolling thinking output (collapsible, max height with overflow)
- [ ] Handle all stream event types: `thinking` (append text), `question` (transition to question view), `summary` (transition to summary), `error` (show error and reset), `complete` (cleanup stream)
- [ ] Ensure proper cleanup of SSE connection on unmount/cancel/error

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` (modified — SSE client function)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/PlanningModeModal.tsx` (modified — streaming UI)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in dashboard package — all existing tests must pass
- [ ] Verify planning mode creates a task successfully with streaming visible
- [ ] Test error handling (simulate network failure, invalid session)
- [ ] Test session cancellation during streaming
- [ ] Test rate limiting still works correctly
- [ ] Verify no memory leaks (SSE connections closed properly)
- [ ] Run full test suite: `pnpm test` from root
- [ ] Build passes: `pnpm build`

### Step 6: Documentation & Delivery

- [ ] Update any relevant comments in planning.ts explaining the AI integration
- [ ] Create changeset file for the dashboard package (new feature + bug fix)
- [ ] Out-of-scope findings: If `createKbAgent` requires model configuration that doesn't exist, document that as a known limitation

**Artifacts:**
- `.changeset/fix-planning-mode-streaming.md`

## Documentation Requirements

**Must Update:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/planning.ts` — Add JSDoc comments for new streaming classes and AI integration

**Check If Affected:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Add comment documenting the new SSE endpoint
- `/Users/eclipxe/Projects/kb/AGENTS.md` — Update if new API patterns are introduced

## Completion Criteria

- [ ] Planning mode no longer spins indefinitely; it either shows the first question or an error
- [ ] Users can see the AI's thinking process in real-time via streaming output
- [ ] All existing planning tests pass (may need updates for new async behavior)
- [ ] Full test suite passes (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Manual test: Create task with planning mode enabled → see streaming thinking → answer questions → task created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-159): complete Step N — description`
- **Bug fixes:** `fix(KB-159): description`
- **Tests:** `test(KB-159): description`

## Do NOT

- Expand scope to refactor unrelated parts of the planning UI
- Skip the root cause fix and only add streaming
- Remove the stubbed fallback entirely — keep it as a test-mode option if AI is unavailable
- Break existing planning tests without updating them
- Modify the planning question/summary data structures (keep types compatible)
- Skip error handling for SSE connection failures
