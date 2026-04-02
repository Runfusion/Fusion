# Task: KB-217 - Fix Planning Mode Hanging and AI Output Display

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Two UI/UX issues in planning mode: 1) After submitting the first question answer, the modal hangs on a spinner indefinitely due to race condition between SSE streaming and response submission, and 2) AI thinking output is not displayed in a proper scrollable box. Both issues affect the planning mode user experience significantly.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Fix two critical issues in the planning mode modal:

1. **Hanging Issue**: After a user answers the first question, the planning modal shows a loading spinner and hangs indefinitely instead of showing the next question. This is caused by a race condition where the SSE stream connection is closed before submitting the response, and the new connection misses events broadcast by the AI agent before the frontend reconnects.

2. **AI Output Display Issue**: The AI thinking output (shown during the loading state) should display in a scrollable box with vertical scrolling, not as horizontal overflow. Currently there are no CSS styles for the thinking output container.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/PlanningModeModal.tsx` — Main planning modal component with state management and streaming logic
- `packages/dashboard/app/api.ts` — API functions including `respondToPlanning` and `connectPlanningStream`
- `packages/dashboard/app/styles.css` — CSS styles for planning components (search for `.planning-*` classes)
- `packages/dashboard/src/planning.ts` — Server-side planning session management and AI agent integration
- `packages/dashboard/src/routes.ts` — Planning API routes around lines 2900-3060

## File Scope

- `packages/dashboard/app/components/PlanningModeModal.tsx` — Fix race condition in `handleSubmitResponse`, keep SSE connection alive during submission
- `packages/dashboard/app/styles.css` — Add CSS styles for `.planning-thinking-container`, `.planning-thinking-toggle`, and `.planning-thinking-output`

## Steps

### Step 1: Fix Planning Mode Hanging Race Condition

The current flow has a race condition:
1. User submits response → Frontend closes SSE connection
2. Frontend calls `respondToPlanning` → Server calls AI agent
3. AI agent streams thinking and broadcasts events via SSE
4. Frontend sets up NEW SSE connection → Misses events already broadcast

**Fix:** Keep the SSE connection alive during the response submission, or ensure the stream is reconnected before the response is processed.

- [ ] Modify `handleSubmitResponse` in `PlanningModeModal.tsx` to NOT close the existing stream connection before calling `respondToPlanning`
- [ ] Instead, keep the connection open and let it continue receiving events while the response is being processed
- [ ] Remove the logic that creates a new connection after `respondToPlanning` returns - the existing connection should receive the next question/summary events
- [ ] Ensure the loading state is shown while waiting for the AI response via the existing stream
- [ ] Test that after answering a question, the next question appears without hanging

**Key code changes in `handleSubmitResponse`:**
- Remove `streamConnectionRef.current?.close();` before `respondToPlanning`
- Remove the fallback `connectPlanningStream` call after `respondToPlanning` - the existing connection should handle it
- Ensure `streamingOutput` is cleared when setting `loading` state but the connection stays open
- If `updatedSession` returns immediate data (non-streaming fallback), use it; otherwise wait for SSE events

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified - fixed race condition)

### Step 2: Add CSS for AI Thinking Output Display

The AI thinking output needs proper styling to be scrollable vertically in a contained box.

- [ ] Add `.planning-thinking-container` styles: flex column layout, max-height, proper margins
- [ ] Add `.planning-thinking-toggle` styles: button styling matching the dashboard design system
- [ ] Add `.planning-thinking-output` styles: scrollable container with `overflow-y: auto`, `max-height`, `white-space: pre-wrap`, background, border, padding
- [ ] Ensure the thinking output box uses vertical scrolling (`overflow-y: auto`) not horizontal scrolling
- [ ] Add `word-wrap: break-word` or `overflow-wrap: break-word` to prevent horizontal overflow

**CSS to add (around line 6900 after `.planning-loading`):**
```css
/* AI Thinking Output Display */
.planning-thinking-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 600px;
}

.planning-thinking-toggle {
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s ease;
}

.planning-thinking-toggle:hover {
  background: var(--card-hover);
  color: var(--text);
}

.planning-thinking-output {
  width: 100%;
  max-height: 300px;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 16px;
  text-align: left;
}

.planning-thinking-output pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}
```

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified - added thinking output styles)

### Step 3: Update Loading State Layout

- [ ] Modify the loading state in `PlanningModeModal.tsx` to have a better layout when showing thinking output
- [ ] Ensure the spinner, text, and thinking container are properly spaced
- [ ] The thinking container should not push the layout too tall - keep it constrained

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified - improved loading layout)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run existing tests: `pnpm test` (including `PlanningModeModal.test.tsx`)
- [ ] Build passes: `pnpm build`
- [ ] Test planning mode manually:
  1. Open dashboard → Click lightbulb icon → Enter a plan → Start Planning
  2. Answer the first question → Verify next question appears (no hanging)
  3. Answer second question → Verify it continues to work
  4. Complete planning → Verify summary appears
- [ ] Verify AI thinking output is displayed in a scrollable box:
  1. Start planning
  2. Look for "AI is thinking..." text
  3. Click "Show thinking" button
  4. Verify the output is in a box with vertical scrolling
  5. Verify long lines wrap (no horizontal scroll)

**Test scenarios to verify:**
- [ ] Planning mode doesn't hang after first question
- [ ] Planning mode works for multiple question rounds
- [ ] AI thinking output displays in scrollable box
- [ ] Long AI output lines wrap (no horizontal scrollbar)
- [ ] Box is vertically scrollable when content exceeds max-height

### Step 5: Documentation & Delivery

- [ ] Update any relevant documentation if planning behavior changed
- [ ] Verify the fix doesn't break the existing test mocks

## Documentation Requirements

**Must Update:**
- None (bug fix)

**Check If Affected:**
- `AGENTS.md` — If any planning mode behavior patterns should be documented

## Completion Criteria

- [ ] Planning mode progresses smoothly through all questions without hanging
- [ ] AI thinking output displays in a properly styled scrollable box
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Manual testing confirms both issues are resolved

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-217): complete Step N — description`
- **Bug fixes:** `fix(KB-217): description`
- **Tests:** `test(KB-217): description`
- **Styles:** `style(KB-217): description`

## Do NOT

- Change the planning API contract (keep same request/response format)
- Remove or disable the thinking output feature
- Add unnecessary complexity to the streaming logic
- Break existing tests
- Modify files outside the File Scope without good reason
- Skip manual testing of the planning flow

## Notes for Implementer

**Understanding the race condition:**

The current broken flow:
```
User submits answer
  → handleSubmitResponse closes SSE connection
  → calls respondToPlanning API
  → Server processes with AI agent
  → AI agent broadcasts "thinking" + "question" events via SSE
  → API returns response
  → Frontend creates NEW SSE connection
  → MISSED events: already broadcast before reconnection!
  → Hangs forever waiting for events that already happened
```

The fixed flow:
```
User submits answer
  → handleSubmitResponse keeps SSE connection OPEN
  → calls respondToPlanning API
  → Server processes with AI agent
  → AI agent broadcasts events via SSE
  → Existing connection receives events in real-time
  → View transitions to next question
```

**Alternative approach if keeping connection open is problematic:**
- Ensure the API response includes the next question/summary when available
- Use the API response to transition views instead of waiting for SSE
- Keep SSE only for thinking output display during loading

**Key implementation notes:**
1. The SSE connection should stay open during the entire planning session
2. The `/api/planning/respond` endpoint returns immediately but the AI processing continues asynchronously
3. The AI streams thinking output via SSE, then broadcasts the question/summary event
4. The frontend should receive these events through the persistent connection

**Testing the fix:**
- Use browser DevTools Network tab to watch SSE stream
- Verify events flow continuously without disconnection
- Check that `question` or `summary` events arrive after submitting a response
