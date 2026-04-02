# Task: KB-032 - Add Planning Mode Feature to Dashboard

**Created:** 2026-03-30
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This is a significant dashboard feature requiring new UI components, API endpoints, and AI integration. It touches multiple layers (React frontend, Express backend, AI agent integration) but follows established patterns in the codebase.
**Score:** 6/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add an interactive "Planning Mode" to the kb dashboard that enables users to enter a high-level plan (e.g., "Build a user authentication system"), then engage in a guided AI conversation to refine and structure that plan. The AI asks clarifying questions, presents UI-based selections (checkboxes, dropdowns, etc.) for user choices, and ultimately generates a summary card that gets input into the task system as a detailed, well-defined task ready for triage.

This feature bridges the gap between rough ideas and actionable task specifications by providing an interactive planning experience directly in the dashboard.

## Dependencies

- **Package:** `@mariozechner/pi-coding-agent` (provides `createKbAgent` function for AI sessions — already used by `@kb/engine`)

## Context to Read First

1. `packages/dashboard/app/App.tsx` — Main app component, understand modal state management
2. `packages/dashboard/app/api.ts` — API client patterns and existing fetch functions
3. `packages/dashboard/app/components/GitHubImportModal.tsx` — Reference for modal implementation pattern
4. `packages/dashboard/app/components/InlineCreateCard.tsx` — Reference for card-based creation UI
5. `packages/dashboard/src/routes.ts` — Server-side API route patterns, especially AI-related endpoints
6. `packages/engine/src/triage.ts` — AI agent integration patterns (lines 1-300)
7. `packages/core/src/types.ts` — Core type definitions (Task, TaskCreateInput, etc.)

## File Scope

**New Files:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` — Main planning mode modal component
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` — Component tests
- `packages/dashboard/src/planning.ts` — Server-side planning session management and AI integration
- `packages/dashboard/src/planning.test.ts` — Unit tests for planning session logic
- `packages/dashboard/README.md` — Dashboard package documentation (create if doesn't exist)

**Modified Files:**
- `packages/dashboard/app/App.tsx` — Add planning modal state and trigger
- `packages/dashboard/app/api.ts` — Export planning API functions
- `packages/dashboard/app/components/Header.tsx` — Add "Plan" button to header
- `packages/dashboard/app/components/Header.test.tsx` — Add tests for Plan button
- `packages/dashboard/src/routes.ts` — Add `/api/planning/*` routes that delegate to planning.ts
- `packages/dashboard/app/styles.css` — Add planning mode specific styles

## Steps

### Step 1: Backend Planning API Infrastructure

Create the server-side planning mode API that manages AI conversations.

- [ ] Create `/api/planning/start` endpoint (POST) that:
  - Accepts `{ initialPlan: string }` in body
  - Creates a temporary planning session with unique ID
  - Initializes AI agent with planning system prompt
  - Returns `{ sessionId: string, firstQuestion: PlanningQuestion }`

- [ ] Create `/api/planning/respond` endpoint (POST) that:
  - Accepts `{ sessionId: string, responses: Record<string, unknown> }`
  - Sends user responses to AI agent
  - Returns next question or final summary: `{ type: "question" | "complete", data: PlanningQuestion | PlanningSummary }`

- [ ] Create `/api/planning/cancel` endpoint (POST) that:
  - Accepts `{ sessionId: string }`
  - Cleans up session and AI agent resources

- [ ] Create `/api/planning/create-task` endpoint (POST) that:
  - Accepts `{ sessionId: string }` and creates actual task from planning summary
  - Uses `store.createTask()` with the refined plan as description
  - Returns created `Task`
  - Cleans up the planning session

- [ ] Define TypeScript types in routes.ts:
  ```typescript
  interface PlanningQuestion {
    id: string;
    type: "text" | "single_select" | "multi_select" | "confirm";
    question: string;
    description?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
  }
  
  interface PlanningSummary {
    title: string;
    description: string;
    suggestedSize: "S" | "M" | "L";
    suggestedDependencies: string[];
    keyDeliverables: string[];
  }
  ```

- [ ] Implement in-memory session storage (Map) with 30-minute TTL and cleanup
- [ ] Add rate limiting: max 5 planning sessions per IP per hour
- [ ] Write tests for all planning endpoints in `routes.test.ts`

**Design Notes:**
- The `routes.ts` file should define the HTTP routes and delegate business logic to functions imported from `planning.ts`
- This keeps route handlers thin and makes testing easier

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/planning.ts` (new — implementation will be completed in Step 5)

### Step 2: Frontend API Client

Create the API client functions for the planning mode.

- [ ] Add to `packages/dashboard/app/api.ts`:
  ```typescript
  export interface PlanningSession {
    sessionId: string;
    currentQuestion: PlanningQuestion | null;
    summary: PlanningSummary | null;
  }
  
  export function startPlanning(initialPlan: string): Promise<PlanningSession>
  export function respondToPlanning(sessionId: string, responses: Record<string, unknown>): Promise<PlanningSession>
  export function cancelPlanning(sessionId: string): Promise<void>
  export function createTaskFromPlanning(sessionId: string): Promise<Task>
  ```

- [ ] Implement error handling with proper typing
- [ ] Write tests in `api.test.ts` for planning functions

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/api.test.ts` (modified)

### Step 3: Planning Mode Modal Component

Build the main interactive planning UI component.

- [ ] Create `PlanningModeModal.tsx` with props:
  ```typescript
  interface PlanningModeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onTaskCreated: (task: Task) => void;
    tasks: Task[]; // For dependency suggestions
  }
  ```

- [ ] Implement "Initial Input" view:
  - Large textarea for high-level plan description
  - "Start Planning" button
  - Example suggestions (quick-start chips)
  - Character counter (max 500 chars for initial input)

- [ ] Implement "Question" view with dynamic form rendering:
  - `text`: Textarea input
  - `single_select`: Radio button group or dropdown
  - `multi_select`: Checkbox group
  - `confirm`: Yes/No toggle buttons
  - Progress indicator (question X of estimated Y)
  - "Back" button to revisit previous answers (maintain history)
  - Show thinking indicator while AI processes responses

- [ ] Handle browser unload during active session:
  - Add `beforeunload` event listener when session is active
  - Show browser's default "Leave site?" warning to prevent accidental data loss
  - Clean up listener when modal closes or session completes

- [ ] Implement "Summary" view:
  - Display generated title with edit capability
  - Display refined description (collapsible)
  - Display suggested size (editable via dropdown: S/M/L)
  - Display suggested dependencies (toggle chips from existing tasks)
  - Display key deliverables as bullet list
  - "Create Task" and "Refine Further" buttons

- [ ] Implement loading states with spinner
- [ ] Handle errors with toast notifications via `useToast`
- [ ] Support keyboard navigation (Tab through options, Enter to submit)
- [ ] Support Escape key to close (with confirmation if in progress)

- [ ] Write comprehensive tests in `PlanningModeModal.test.tsx` covering:
  - Opening/closing the modal
  - Initial plan submission
  - Question rendering for all question types
  - Response submission flow
  - Summary display and task creation
  - Error handling
  - Cancel/close behavior

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (new)
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (new)

### Step 4: Dashboard Integration

Integrate the planning mode into the main dashboard UI.

- [ ] Modify `Header.tsx`:
  - Add "Plan" button with lightbulb icon (from lucide-react) next to "+" button
  - Use `btn btn-sm` class for styling
  - Show tooltip on hover: "Create a task with AI planning"

- [ ] Modify `App.tsx`:
  - Add `isPlanningOpen` state
  - Add `planningTask` state for created task
  - Add `handlePlanningOpen`, `handlePlanningClose`, `handlePlanningTaskCreated` callbacks
  - Include `<PlanningModeModal />` in the render tree
  - Pass `tasks` prop to modal for dependency suggestions

- [ ] Update `Header.test.tsx`:
  - Add test for "Plan" button rendering
  - Add test for button click opening planning mode

- [ ] Update `App.test.tsx`:
  - Add integration test for planning mode flow
  - Mock planning API calls

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/components/Header.test.tsx` (modified)
- `packages/dashboard/app/App.tsx` (modified)

### Step 5: AI Agent Integration

Implement the server-side AI agent for planning conversations.

- [ ] Create planning system prompt constant:
  ```typescript
  const PLANNING_SYSTEM_PROMPT = `You are a planning assistant for the kb task board system.
  
  Your job: help users transform vague, high-level ideas into well-defined, actionable tasks.
  
  ## Conversation Flow
  1. User provides a high-level plan (e.g., "Build a user auth system")
  2. You ask clarifying questions to understand scope, requirements, and constraints
  3. You present UI-friendly selection options when appropriate
  4. Once you have enough information, generate a structured summary
  
  ## Question Types to Use
  - "text": Open-ended follow-up questions
  - "single_select": When user must choose one option (e.g., tech stack preference)
  - "multi_select": When multiple options can apply (e.g., features to include)
  - "confirm": Yes/No questions for quick decisions
  
  ## Guidelines
  - Ask 3-7 questions depending on complexity
  - Start broad, then narrow down specifics
  - Suggest sensible defaults based on project context
  - Keep questions focused and actionable
  - When asking about file scope, reference actual project structure
  
  ## Summary Generation
  When ready to complete, generate:
  - A concise but descriptive title
  - A detailed description with context gathered
  - Size estimate (S/M/L) based on scope
  - Any suggested dependencies on existing tasks
  - Key deliverables as a checklist`;
  ```

- [ ] Implement session management class:
  ```typescript
  class PlanningSession {
    id: string;
    agent: AgentSession;
    history: Array<{ question: PlanningQuestion; response: unknown }>;
    createdAt: Date;
    
    constructor(initialPlan: string, rootDir: string)
    async getNextQuestion(): Promise<PlanningQuestion | PlanningSummary>
    async submitResponse(response: unknown): Promise<PlanningQuestion | PlanningSummary>
    dispose(): void
  }
  ```

- [ ] Integrate with pi-coding-agent's `createKbAgent` function (same pattern as triage.ts)
- [ ] Implement tool for reading project structure to inform suggestions
- [ ] Implement tool for searching existing tasks to suggest dependencies
- [ ] Add error handling for AI agent failures (graceful fallback with error message to user)

- [ ] Write unit tests for planning session logic including:
  - Session initialization
  - Question generation flow
  - Response handling
  - Summary generation
  - Session cleanup/timeout
  - Rate limiting enforcement
  - Error handling when AI agent fails

**Artifacts:**
- `packages/dashboard/src/planning.ts` (new)
- `packages/dashboard/src/planning.test.ts` (new)

### Step 6: Styling

Add CSS styles for the planning mode UI following existing design system.

- [ ] Add planning modal layout styles:
  ```css
  .planning-modal { /* modal sizing */ }
  .planning-content { /* flex layout */ }
  .planning-initial { /* centered input form */ }
  .planning-question { /* question display */ }
  .planning-options { /* option groups */ }
  .planning-option { /* individual option */ }
  .planning-summary { /* summary view */ }
  .planning-progress { /* progress bar */ }
  ```

- [ ] Ensure dark theme consistency with existing CSS variables
- [ ] Add responsive styles for mobile (stacked layout, full-width on small screens)
- [ ] Add animation styles for question transitions

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures in dashboard package
- [ ] Ensure build passes: `pnpm build`
- [ ] Test manually:
  1. Open dashboard with `pnpm dev:ui`
  2. Click "Plan" button
  3. Enter high-level plan
  4. Go through question flow
  5. Verify summary generation
  6. Create task and verify it appears in triage
  7. Test cancel/close behavior at each step
  8. Test error handling (network errors, etc.)

**Artifacts:**
- All tests passing
- Manual QA completed

### Step 8: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md`:
  - Add section about Planning Mode feature
  - Document user-facing functionality

- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/add-planning-mode.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add Planning Mode to the dashboard for interactive AI-guided task creation
  EOF
  ```

- [ ] Out-of-scope findings (create follow-up tasks if discovered):
  - Performance optimizations for large task lists in dependency selection
  - Export planning conversations for debugging
  - Collaborative planning (multiple users)

**Artifacts:**
- `packages/dashboard/README.md` (modified)
- `.changeset/add-planning-mode.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — Create this file with a Planning Mode section explaining the feature (if it doesn't exist, create as new file)

**Check If Affected:**
- `AGENTS.md` — Update if task creation patterns change
- Root `README.md` — Add mention of Planning Mode feature if user-facing docs exist

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Manual QA completed and verified
- [ ] Documentation updated
- [ ] Changeset created
- [ ] No TypeScript errors (`pnpm typecheck`)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-032): complete Step N — description`
- Example: `feat(KB-032): complete Step 1 — backend planning API infrastructure`
- **Bug fixes:** `fix(KB-032): description`
- **Tests:** `test(KB-032): description`
- **Docs:** `docs(KB-032): description`

## Do NOT

- Expand task scope beyond interactive planning mode
- Skip writing tests for any new code
- Modify files outside the File Scope without explicit reason
- Commit without the task ID prefix
- Use external AI APIs directly — always go through the engine's agent infrastructure
- Store planning session data persistently (keep in-memory only)
- Allow planning sessions to run indefinitely (implement timeouts)
- Skip accessibility considerations (keyboard navigation, ARIA labels)
