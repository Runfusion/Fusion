# Task: KB-633 - Mission REST API and Interview System

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This exposes MissionStore through REST endpoints and implements an AI-driven interview system for mission planning. It follows established patterns from planning.ts and routes.ts. The interview system is complex but mirrors existing planning mode architecture.

**Score:** 5/8 — Blast radius: 1 (new endpoints, minimal existing changes), Pattern novelty: 1 (follows existing planning.ts patterns), Security: 1 (standard input validation), Reversibility: 2 (new code only, safe to remove)

## Mission

Expose the MissionStore functionality through REST API endpoints and implement the AI-driven interview system for mission and milestone planning. This enables the dashboard to interact with missions and provides the interactive Q&A flow that transforms high-level goals into structured milestone/slice/feature hierarchies. The interview system guides users through defining mission scope, breaking it into milestones, and eventually generating the full hierarchy.

## Dependencies

- **Task:** KB-632 — Missions Foundation must be complete, providing:
  - `MissionStore` class in `packages/core/src/mission-store.ts`
  - Mission types (`Mission`, `Milestone`, `Slice`, `MissionFeature`, etc.) in `packages/core/src/mission-types.ts`
  - All CRUD operations and status rollup logic working

## Context to Read First

**Note:** The mission files below (`mission-store.ts`, `mission-types.ts`) are created by KB-632 which this task depends on. They will not exist until KB-632 is complete.

1. `packages/core/src/mission-store.ts` — Understand MissionStore API surface (createMission, addMilestone, addSlice, addFeature, etc.)
2. `packages/core/src/mission-types.ts` — Review all mission-related types and status enums
3. `packages/dashboard/src/planning.ts` — Study the AI-driven planning session system (Session, stream manager, rate limiting, SSE events)
4. `packages/dashboard/src/routes.ts` — Review existing API route patterns (error handling, validation, async handlers)
5. `packages/dashboard/app/api.ts` — See frontend API client patterns for reference when designing endpoint responses
6. **Appendix below** — Review expected MissionStore API interface

## File Scope

**New Files:**
- `packages/dashboard/src/mission-interview.ts` — Mission interview session management and AI integration
- `packages/dashboard/src/mission-routes.ts` — Express router for mission REST API endpoints
- `packages/dashboard/src/mission-interview.test.ts` — Tests for interview system
- `packages/dashboard/src/mission-routes.test.ts` — Tests for mission API endpoints

**Modified Files:**
- `packages/dashboard/src/routes.ts` — Mount mission routes under `/api/missions`
- `packages/dashboard/src/server.ts` — Initialize MissionStore and pass to routes (if needed)
- `packages/dashboard/app/api.ts` — Add mission API client functions (for reference, actual UI in KB-634)
- `packages/core/src/index.ts` — Ensure mission types are exported (if not already)

## Steps

### Step 0: Preflight

- [ ] KB-632 is complete: MissionStore exists with full CRUD operations
- [ ] All context files read and understood
- [ ] `pnpm typecheck` passes in packages/core
- [ ] `pnpm test` passes in packages/core (existing tests)

### Step 1: Mission REST API Routes and Mounting

Create `packages/dashboard/src/mission-routes.ts` with Express router and mount it in routes.ts:

- [ ] **Create router in `mission-routes.ts`:**
  - Define `createMissionRouter(store: TaskStore): Router` function
  - Import required types from `@fusion/core`
  - Add error handling wrapper following routes.ts patterns

- [ ] **Mission endpoints:**
  - `GET /` — List all missions (ordered by createdAt desc)
  - `POST /` — Create new mission with `title`, `description` (optional)
  - `GET /:id` — Get mission by ID with full hierarchy (milestones, slices, features)
  - `PATCH /:id` — Update mission fields (title, description, status)
  - `DELETE /:id` — Delete mission (cascades via FK)
  - `GET /:id/status` — Get computed status rollup

- [ ] **Milestone endpoints (nested under missions):**
  - `GET /:missionId/milestones` — List milestones for mission
  - `POST /:missionId/milestones` — Add milestone with `title`, `description`, `dependencies` (optional)
  - `GET /milestones/:id` — Get milestone by ID
  - `PATCH /milestones/:id` — Update milestone fields
  - `DELETE /milestones/:id` — Delete milestone
  - `POST /milestones/:id/reorder` — Reorder milestone with body `{ orderedIds: string[] }`

- [ ] **Slice endpoints (nested under milestones):**
  - `GET /milestones/:milestoneId/slices` — List slices for milestone
  - `POST /milestones/:milestoneId/slices` — Add slice with `title`, `description`
  - `GET /slices/:id` — Get slice by ID
  - `PATCH /slices/:id` — Update slice fields
  - `DELETE /slices/:id` — Delete slice
  - `POST /slices/:id/activate` — Activate slice (status → "active", set activatedAt)
  - `POST /slices/:id/reorder` — Reorder slices with body `{ orderedIds: string[] }`

- [ ] **Feature endpoints (nested under slices):**
  - `GET /slices/:sliceId/features` — List features for slice
  - `POST /slices/:sliceId/features` — Add feature with `title`, `description`, `acceptanceCriteria` (optional)
  - `GET /features/:id` — Get feature by ID
  - `PATCH /features/:id` — Update feature fields
  - `DELETE /features/:id` — Delete feature
  - `POST /features/:id/link-task` — Link feature to task with body `{ taskId: string }`
  - `POST /features/:id/unlink-task` — Unlink feature from task

- [ ] **Interview state endpoints:**
  - `GET /:id/interview-state` — Get current interview state
  - `POST /:id/interview-state` — Update interview state with body `{ state: InterviewState }`
  - `GET /milestones/:id/interview-state` — Get milestone interview state
  - `POST /milestones/:id/interview-state` — Update milestone interview state

- [ ] **Mount in `routes.ts`:**
  - Import `createMissionRouter` from `mission-routes.ts`
  - Mount at `/api/missions` using `router.use("/missions", createMissionRouter(store))`
  - MissionStore is accessible via `store.getMissionStore()` or similar pattern

- [ ] **Error handling:** Follow patterns from routes.ts:
  - Use try/catch in all async handlers
  - Return 400 for validation errors with `{ error: string }`
  - Return 404 when resource not found
  - Return 500 for unexpected errors
  - Log errors to console with `[missions]` prefix

- [ ] **Input validation:**
  - Validate `title` is non-empty string (max 200 chars)
  - Validate `description` is string (max 5000 chars) if provided
  - Validate status values against enum
  - Validate UUID format for IDs

**Artifacts:**
- `packages/dashboard/src/mission-routes.ts` (new)
- `packages/dashboard/src/routes.ts` (modified — route mounting)

### Step 2: Mission Interview System Foundation

Create `packages/dashboard/src/mission-interview.ts` following planning.ts patterns:

- [ ] **Interview question types for missions:**
  - Mission scope questions: "What is the high-level goal?", "What problem does this solve?"
  - Milestone definition: "What are the major phases?", "What milestones mark progress?"
  - Dependency questions: "Which milestones depend on others?"
  - Size estimation: "How complex is each milestone?"

- [ ] **Type definitions:**
  - `MissionInterviewQuestion` — extends PlanningQuestion with mission-specific context
  - `MissionInterviewSummary` — mission title, description, suggested milestones array
  - `MilestoneDraft` — { title, description, orderIndex, dependencies, suggestedSize }
  - `MissionInterviewSession` — session management similar to PlanningSession

- [ ] **System prompt for mission interview:**
  Create `MISSION_INTERVIEW_SYSTEM_PROMPT` following PLANNING_SYSTEM_PROMPT pattern:
  - Guide user from high-level goal to structured mission
  - Ask about problem being solved, target outcome, major phases
  - Suggest milestone breakdown (3-7 milestones typical)
  - Capture dependencies between milestones
  - Generate structured mission summary at completion

- [ ] **Session management:**
  - `MissionInterviewSession` class with id, ip, missionId (optional), history, currentQuestion
  - In-memory session storage with TTL (30 min, same as planning)
  - Rate limiting: 5 sessions per IP per hour (same as planning)
  - Cleanup interval for expired sessions

**Artifacts:**
- `packages/dashboard/src/mission-interview.ts` (skeleton with types and session management)

### Step 3: Mission Interview AI Integration

- [ ] **AI agent integration:**
  - Dynamic import of `createKbAgent` from `@fusion/engine` (same pattern as planning.ts)
  - `MissionInterviewSession.getNextQuestion()` — calls AI agent with conversation history
  - `MissionInterviewSession.submitResponse(response)` — adds to history, gets next question or summary

- [ ] **Interview flow logic:**
  - Question 1: Mission scope — "Describe the high-level goal or problem you're trying to solve"
  - Question 2: Success criteria — "How will you know this mission is complete? What are the key outcomes?"
  - Question 3: Major phases — "What are the major phases or stages? (These will become milestones)"
  - Question 4 (conditional): Dependencies — If multiple milestones, ask about dependencies
  - Question 5: Timeline/urgency — "Any time constraints or priority considerations?"
  - Summary generation: Create `MissionInterviewSummary` with:
    - `title`: Generated mission title (max 80 chars)
    - `description`: Full description with gathered context
    - `suggestedMilestones`: Array of `MilestoneDraft` objects
    - `suggestedStatus`: "planning" (default)

- [ ] **Milestone generation from AI response:**
  - Parse AI response for milestone suggestions
  - Each milestone needs: title, description, orderIndex (auto-assigned)
  - Dependencies captured as milestone IDs (resolved after creation)

**Artifacts:**
- `packages/dashboard/src/mission-interview.ts` (complete with AI integration)

### Step 4: Mission Interview API Endpoints

Add interview endpoints to `mission-routes.ts`:

- [ ] **Interview endpoints:**
  - `POST /missions/interview/start` — Start mission interview session
    - Body: `{ initialGoal?: string }` (optional seed description)
    - Returns: `{ sessionId: string, currentQuestion: MissionInterviewQuestion }`
    - Rate limited (use checkRateLimit from mission-interview.ts)
  
  - `POST /missions/interview/respond` — Submit response to current question
    - Body: `{ sessionId: string, responses: Record<string, unknown> }`
    - Returns: `{ currentQuestion?: MissionInterviewQuestion, summary?: MissionInterviewSummary }`
    - If summary present, interview is complete
  
  - `POST /missions/interview/cancel` — Cancel interview session
    - Body: `{ sessionId: string }`
    - Returns: 204 No Content
  
  - `GET /missions/interview/:sessionId/stream` — SSE stream for real-time updates
    - Events: `thinking`, `question`, `summary`, `error`, `complete`
    - Follows exact same SSE pattern as planning.ts

- [ ] **Create mission from interview:**
  - `POST /missions/interview/create-mission` — Create mission from completed interview
    - Body: `{ sessionId: string, milestoneIdsToInclude?: string[] }` (optional filter)
    - Creates mission with interview-generated title/description
    - Creates all suggested milestones (if not filtered)
    - Sets mission.interviewState to "completed"
    - Returns: `{ mission: Mission, milestones: Milestone[] }`

**Artifacts:**
- `packages/dashboard/src/mission-routes.ts` (expanded with interview endpoints)

### Step 5: Streaming Support for Mission Interview

- [ ] **MissionInterviewStreamManager class:**
  - Mirror PlanningStreamManager from planning.ts
  - Subscribe/unsubscribe callbacks for session
  - Broadcast events to all subscribers
  - Cleanup on session end

- [ ] **AI streaming integration:**
  - Support `startMissionInterviewStreaming(initialGoal)` function
  - Connect AI agent text deltas to `thinking` events
  - Parse questions from AI and emit as `question` events
  - Emit `summary` when interview completes
  - Handle errors with `error` events

- [ ] **SSE endpoint implementation:**
  - Set headers: `text/event-stream`, `no-cache`, `keep-alive`
  - Subscribe to stream manager for session
  - Send events in format: `event: {type}\ndata: {json}\n\n`
  - Heartbeat every 30 seconds (`: heartbeat\n\n`)
  - Cleanup on client disconnect

**Artifacts:**
- `packages/dashboard/src/mission-interview.ts` (streaming support complete)

### Step 6: Milestone Interview System

- [ ] **Milestone interview (lighter weight):**
  - `MilestoneInterviewSession` class for planning individual milestone details
  - System prompt focuses on breaking milestone into slices
  - Questions: "What are the major work areas?", "What can be done in parallel?"

- [ ] **Milestone interview endpoints:**
  - `POST /milestones/:id/interview/start` — Start milestone planning interview
  - `POST /milestones/interview/respond` — Submit response
  - `POST /milestones/interview/cancel` — Cancel session
  - `POST /milestones/interview/create-slices` — Create slices from interview

**Artifacts:**
- `packages/dashboard/src/mission-interview.ts` (milestone interview added)

### Step 7: Mission Routes Tests

Create `packages/dashboard/src/mission-routes.test.ts`:

- [ ] Test mission CRUD endpoints:
  - POST /missions — create, verify 201 response, verify returned structure
  - GET /missions — list returns array
  - GET /missions/:id — get with hierarchy, verify all levels present
  - PATCH /missions/:id — update title/description
  - DELETE /missions/:id — delete, verify cascade

- [ ] Test milestone endpoints:
  - POST /missions/:id/milestones — add milestone
  - POST /milestones/:id/reorder — verify orderIndex changes
  - GET /milestones/:id — get single milestone

- [ ] Test slice endpoints:
  - POST /milestones/:id/slices — add slice
  - POST /slices/:id/activate — verify status change to "active"

- [ ] Test feature endpoints:
  - POST /slices/:id/features — add feature
  - POST /features/:id/link-task — verify task link, verify slice status recomputed

- [ ] Test interview endpoints:
  - POST /missions/interview/start — returns sessionId and question
  - POST /missions/interview/respond — progresses through questions
  - POST /missions/interview/create-mission — creates mission with milestones

- [ ] Test error cases:
  - 404 for non-existent IDs
  - 400 for invalid input (empty title, invalid status)
  - 429 for rate limiting on interview endpoints

- [ ] Use supertest pattern from routes.test.ts
- [ ] Create temporary database for each test (follow store.test.ts pattern)

**Artifacts:**
- `packages/dashboard/src/mission-routes.test.ts` (new)

### Step 8: Mission Interview Tests

Create `packages/dashboard/src/mission-interview.test.ts`:

- [ ] Test session management:
  - Create session, verify ID and initial question
  - Submit response, verify next question
  - Session expiration after TTL

- [ ] Test rate limiting:
  - First 5 sessions allowed
  - 6th session rejected with 429
  - Rate limit reset after window

- [ ] Test summary generation:
  - Complete interview flow (mock AI responses)
  - Verify summary structure
  - Verify suggested milestones array

- [ ] Test streaming:
  - Subscribe to stream, verify events received
  - Broadcast reaches multiple subscribers
  - Cleanup on unsubscribe

- [ ] Mock AI agent for tests (same pattern as planning.test.ts)

**Artifacts:**
- `packages/dashboard/src/mission-interview.test.ts` (new)

### Step 9: Frontend API Client (Reference)

Add mission API functions to `packages/dashboard/app/api.ts`:

- [ ] **Mission API functions:**
  - `fetchMissions()` — GET /missions
  - `fetchMission(id)` — GET /missions/:id
  - `createMission(input)` — POST /missions
  - `updateMission(id, updates)` — PATCH /missions/:id
  - `deleteMission(id)` — DELETE /missions/:id

- [ ] **Milestone API functions:**
  - `fetchMilestones(missionId)` — GET /missions/:missionId/milestones
  - `createMilestone(missionId, input)` — POST /missions/:missionId/milestones
  - `updateMilestone(id, updates)` — PATCH /milestones/:id
  - `deleteMilestone(id)` — DELETE /milestones/:id
  - `reorderMilestones(missionId, orderedIds)` — POST /milestones/:id/reorder

- [ ] **Slice API functions:**
  - `fetchSlices(milestoneId)` — GET /milestones/:milestoneId/slices
  - `createSlice(milestoneId, input)` — POST /milestones/:milestoneId/slices
  - `activateSlice(id)` — POST /slices/:id/activate

- [ ] **Feature API functions:**
  - `fetchFeatures(sliceId)` — GET /slices/:sliceId/features
  - `createFeature(sliceId, input)` — POST /slices/:sliceId/features
  - `linkFeatureToTask(featureId, taskId)` — POST /features/:id/link-task
  - `unlinkFeatureFromTask(featureId)` — POST /features/:id/unlink-task

- [ ] **Interview API functions:**
  - `startMissionInterview(initialGoal?)` — POST /missions/interview/start
  - `respondToMissionInterview(sessionId, responses)` — POST /missions/interview/respond
  - `cancelMissionInterview(sessionId)` — POST /missions/interview/cancel
  - `createMissionFromInterview(sessionId)` — POST /missions/interview/create-mission
  - `connectMissionInterviewStream(sessionId, handlers)` — SSE connection (follow connectPlanningStream pattern)

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified — new API functions added)

### Step 10: Integration & Type Check

- [ ] Ensure all mission types are exported from `@fusion/core`:
  - Check `packages/core/src/index.ts` exports mission types
  - Add exports if missing: `Mission`, `Milestone`, `Slice`, `MissionFeature`, `InterviewState`, etc.

- [ ] Run type checking:
  - `pnpm typecheck` in packages/core — must pass
  - `pnpm typecheck` in packages/dashboard — must pass

- [ ] Fix any type errors:
  - Ensure MissionStore is properly typed
  - Ensure interview types align with core types

**Artifacts:**
- `packages/core/src/index.ts` (possibly modified)

### Step 11: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in packages/core — all existing tests must pass
- [ ] Run `pnpm test` in packages/dashboard — all existing + new tests must pass
- [ ] Run `pnpm typecheck` in both packages — zero errors
- [ ] Run `pnpm build` — successful
- [ ] Manual verification (optional, quick checks):
  - Start dashboard server
  - Test `GET /api/missions` returns empty array initially
  - Test `POST /api/missions` creates mission
  - Test `GET /api/missions/:id` returns mission with hierarchy

### Step 12: Documentation & Delivery

- [ ] Add JSDoc comments to all public functions in mission-interview.ts and mission-routes.ts
- [ ] Create changeset file:
  ```bash
  cat > .changeset/missions-rest-api.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---

  Add Mission REST API and Interview System.
  New endpoints for mission/milestone/slice/feature CRUD.
  AI-driven interview system for interactive mission planning with SSE streaming.
  EOF
  ```
- [ ] Commit: `feat(KB-633): complete Mission REST API and Interview System`

## Documentation Requirements

**Must Update:**
- Changeset file as shown above
- JSDoc for all public APIs

**Check If Affected:**
- No README updates needed (UI in KB-634 will add user-facing docs)

## Completion Criteria

- [ ] All 12 steps complete
- [ ] Mission REST API endpoints working (missions, milestones, slices, features)
- [ ] Interview system with AI integration functional
- [ ] SSE streaming for real-time interview updates working
- [ ] All tests passing (existing + new mission tests)
- [ ] Typecheck passing in both core and dashboard packages
- [ ] Build successful
- [ ] Changeset created
- [ ] Code follows patterns from planning.ts and routes.ts

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-633): complete Step N — description`
- **Bug fixes:** `fix(KB-633): description`
- **Tests:** `test(KB-633): description`
- **Changeset:** `chore(KB-633): add changeset for missions API`

## Do NOT

- Skip input validation on API endpoints
- Skip rate limiting on interview endpoints (expensive AI calls)
- Modify existing task-related routes (keep missions separate)
- Skip status rollup on feature link/unlink (MissionStore handles this)
- Skip SSE heartbeat (prevents connection timeouts)
- Skip transaction handling for multi-row operations (reorder, create from interview)
- Skip proper error handling (always return JSON errors, not crashes)
- Skip tests for interview flow (most complex logic needs coverage)
- Access MissionStore methods that don't exist in KB-632 (stick to defined API)

## Appendix: Expected MissionStore API (from KB-632)

The following MissionStore interface is expected to be available from KB-632. All methods listed here must exist before KB-633 can be implemented:

```typescript
// MissionStore class from @fusion/core
class MissionStore extends EventEmitter {
  // Mission CRUD
  createMission(input: MissionCreateInput): Mission;
  getMission(id: string): Mission | undefined;
  getMissionWithHierarchy(id: string): MissionWithHierarchy | undefined;
  listMissions(): Mission[];
  updateMission(id: string, updates: Partial<Mission>): Mission;
  deleteMission(id: string): void;
  updateMissionInterviewState(id: string, state: InterviewState): Mission;

  // Milestone operations
  addMilestone(missionId: string, input: MilestoneCreateInput): Milestone;
  getMilestone(id: string): Milestone | undefined;
  listMilestones(missionId: string): Milestone[];
  updateMilestone(id: string, updates: Partial<Milestone>): Milestone;
  deleteMilestone(id: string): void;
  reorderMilestones(missionId: string, orderedIds: string[]): void;
  updateMilestoneInterviewState(id: string, state: InterviewState): Milestone;

  // Slice operations
  addSlice(milestoneId: string, input: SliceCreateInput): Slice;
  getSlice(id: string): Slice | undefined;
  listSlices(milestoneId: string): Slice[];
  updateSlice(id: string, updates: Partial<Slice>): Slice;
  deleteSlice(id: string): void;
  reorderSlices(milestoneId: string, orderedIds: string[]): void;
  activateSlice(id: string): Slice;

  // Feature operations
  addFeature(sliceId: string, input: FeatureCreateInput): MissionFeature;
  getFeature(id: string): MissionFeature | undefined;
  listFeatures(sliceId: string): MissionFeature[];
  updateFeature(id: string, updates: Partial<MissionFeature>): MissionFeature;
  deleteFeature(id: string): void;
  linkFeatureToTask(featureId: string, taskId: string): MissionFeature;
  unlinkFeatureFromTask(featureId: string): MissionFeature;
  getFeatureByTaskId(taskId: string): MissionFeature | undefined;

  // Status rollup
  computeSliceStatus(sliceId: string): SliceStatus;
  computeMilestoneStatus(milestoneId: string): MilestoneStatus;
  computeMissionStatus(missionId: string): MissionStatus;
}

// Expected types from @fusion/core
interface Mission {
  id: string;
  title: string;
  description: string;
  status: MissionStatus;
  interviewState: InterviewState;
  createdAt: string;
  updatedAt: string;
}

type MissionStatus = "planning" | "active" | "blocked" | "complete" | "archived";
type InterviewState = "not_started" | "in_progress" | "completed" | "needs_update";

interface Milestone {
  id: string;
  missionId: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  orderIndex: number;
  interviewState: InterviewState;
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
}

type MilestoneStatus = "planning" | "active" | "blocked" | "complete";

interface Slice {
  id: string;
  milestoneId: string;
  title: string;
  description: string;
  status: SliceStatus;
  orderIndex: number;
  activatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

type SliceStatus = "pending" | "active" | "complete";

interface MissionFeature {
  id: string;
  sliceId: string;
  taskId?: string;
  title: string;
  description: string;
  acceptanceCriteria?: string;
  status: FeatureStatus;
  createdAt: string;
  updatedAt: string;
}

type FeatureStatus = "defined" | "triaged" | "in-progress" | "done";

interface MissionWithHierarchy extends Mission {
  milestones: Array<Milestone & {
    slices: Array<Slice & {
      features: MissionFeature[];
    }>;
  }>;
}
```

If any of these methods or types are missing from KB-632, coordinate with that task or adjust the implementation accordingly.
