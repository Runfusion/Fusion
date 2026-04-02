# Task: KB-628b - Mission REST API and Interview System

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task builds on KB-628a's foundation to expose mission functionality via REST API and implements the AI-driven interview system. It extends existing PlanningModeModal patterns to missions and milestones.

**Score:** 5/8 — Blast radius: 2 (new API routes, minimal existing changes), Pattern novelty: 1 (extends existing planning patterns), Security: 1 (standard API patterns), Reversibility: 1 (new endpoints, safe to disable)

## Mission

Expose the MissionStore functionality through REST API endpoints and implement the AI-driven interview system for mission and milestone planning. This enables the dashboard to interact with missions and provides the interactive Q&A flow that transforms high-level goals into structured milestone/slice/feature hierarchies.

## Dependencies

- **Task:** KB-628a — Database Schema, Types, and MissionStore must be complete
  - MissionStore class with all CRUD operations
  - Mission types (Mission, Milestone, Slice, MissionFeature)
  - Database schema with mission tables

## Context to Read First

1. `packages/dashboard/app/api.ts` — Study existing API client functions, error handling patterns, and TypeScript types
2. `packages/dashboard/src/planning.ts` — Study PlanningSession class, interview state management, and AI agent integration
3. `packages/dashboard/app/components/PlanningModeModal.tsx` — Review the UI patterns for interview modals, question rendering, and streaming display
4. `packages/dashboard/api.ts` (server-side) — Study Hono API route patterns, especially planning endpoints (`/api/planning/*`)
5. `packages/core/src/mission-store.ts` (from KB-628a) — Understand MissionStore methods to expose via API
6. `packages/core/src/mission-types.ts` (from KB-628a) — Reference mission type definitions

## File Scope

**New Files:**
- `packages/dashboard/src/mission-planning.ts` — Mission interview session management
- `packages/dashboard/app/components/MissionInterviewModal.tsx` — Interview UI component

**Modified Files:**
- `packages/dashboard/api.ts` (server-side) — Add mission REST endpoints
- `packages/dashboard/app/api.ts` (client-side) — Add mission API client functions

## Steps

### Step 1: Mission REST API — Server Routes

- [ ] Add mission routes in `packages/dashboard/api.ts` using Hono pattern:
  - `GET /api/missions` — List all missions with aggregate progress counts
  - `POST /api/missions` — Create new mission from input
  - `GET /api/missions/:id` — Get mission with full hierarchy (milestones → slices → features)
  - `PATCH /api/missions/:id` — Update mission fields
  - `DELETE /api/missions/:id` — Delete mission
- [ ] Add milestone routes:
  - `POST /api/missions/:id/milestones` — Add milestone to mission
  - `PATCH /api/missions/:id/milestones/:milestoneId` — Update milestone
  - `DELETE /api/missions/:id/milestones/:milestoneId` — Delete milestone
  - `POST /api/missions/:id/milestones/reorder` — Reorder milestones (body: { orderedIds: string[] })
- [ ] Add slice routes:
  - `POST /api/missions/:id/milestones/:milestoneId/slices` — Add slice to milestone
  - `PATCH /api/missions/:id/milestones/:milestoneId/slices/:sliceId` — Update slice
  - `DELETE /api/missions/:id/milestones/:milestoneId/slices/:sliceId` — Delete slice
  - `POST /api/missions/:id/milestones/:milestoneId/slices/reorder` — Reorder slices
  - `POST /api/missions/:id/milestones/:milestoneId/slices/:sliceId/activate` — Activate slice
- [ ] Add feature routes:
  - `POST /api/missions/:id/milestones/:milestoneId/slices/:sliceId/features` — Add feature
  - `PATCH /api/missions/:id/milestones/:milestoneId/slices/:sliceId/features/:featureId` — Update feature
  - `DELETE /api/missions/:id/milestones/:milestoneId/slices/:sliceId/features/:featureId` — Delete feature
  - `POST /api/missions/:id/milestones/:milestoneId/slices/:sliceId/features/:featureId/link` — Link feature to task
- [ ] All routes use MissionStore methods and return proper JSON responses
- [ ] Add error handling with 404 when mission/milestone/slice/feature not found

**Artifacts:**
- `packages/dashboard/api.ts` (modified — server-side)

### Step 2: Mission API Client — Dashboard

- [ ] Add mission API client functions to `packages/dashboard/app/api.ts`:
  - `listMissions(): Promise<Mission[]>` — GET /api/missions
  - `getMission(id: string): Promise<MissionWithHierarchy>` — GET /api/missions/:id
  - `createMission(input: MissionCreateInput): Promise<Mission>` — POST /api/missions
  - `updateMission(id: string, updates: Partial<Mission>): Promise<Mission>` — PATCH /api/missions/:id
  - `deleteMission(id: string): Promise<void>` — DELETE /api/missions/:id
- [ ] Add milestone client functions:
  - `addMilestone(missionId: string, input: MilestoneCreateInput): Promise<Milestone>`
  - `updateMilestone(missionId: string, milestoneId: string, updates: Partial<Milestone>): Promise<Milestone>`
  - `deleteMilestone(missionId: string, milestoneId: string): Promise<void>`
  - `reorderMilestones(missionId: string, orderedIds: string[]): Promise<void>`
- [ ] Add slice client functions:
  - `addSlice(missionId: string, milestoneId: string, input: SliceCreateInput): Promise<Slice>`
  - `updateSlice(missionId: string, milestoneId: string, sliceId: string, updates: Partial<Slice>): Promise<Slice>`
  - `deleteSlice(missionId: string, milestoneId: string, sliceId: string): Promise<void>`
  - `reorderSlices(missionId: string, milestoneId: string, orderedIds: string[]): Promise<void>`
  - `activateSlice(missionId: string, milestoneId: string, sliceId: string): Promise<Slice>`
- [ ] Add feature client functions:
  - `addFeature(missionId: string, milestoneId: string, sliceId: string, input: FeatureCreateInput): Promise<MissionFeature>`
  - `updateFeature(missionId: string, milestoneId: string, sliceId: string, featureId: string, updates: Partial<MissionFeature>): Promise<MissionFeature>`
  - `deleteFeature(missionId: string, milestoneId: string, sliceId: string, featureId: string): Promise<void>`
  - `linkFeatureToTask(missionId: string, milestoneId: string, sliceId: string, featureId: string, taskId: string): Promise<MissionFeature>`
- [ ] All functions follow existing error handling patterns (throw on non-OK)

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified — client-side)

### Step 3: Mission Interview Session Types

- [ ] Create `packages/dashboard/src/mission-planning.ts`:
  - Define `MissionInterviewSession` type extending base planning patterns
  - Define `MilestoneInterviewSession` type for per-milestone interviews
  - Define `MissionPlanningQuestion` type (mission-specific questions)
  - Define `MissionPlanningSummary` type containing generated milestone outlines
  - Define `MilestonePlanningSummary` type containing generated slice/feature definitions
- [ ] Define question types specific to mission planning:
  - Mission scope and goals
  - Timeline and constraints
  - Team size and resources
  - Risk factors and dependencies
  - Success criteria
- [ ] Define question types specific to milestone planning:
  - Milestone deliverables
  - Slice breakdown strategy
  - Feature definitions
  - Dependencies between slices

**Artifacts:**
- `packages/dashboard/src/mission-planning.ts` (new — types and constants)

### Step 4: Mission Interview System Prompts

- [ ] Create `MISSION_PLANNING_SYSTEM_PROMPT` constant:
  - Guides AI to conduct deep discovery on mission scope
  - Asks 5-8 questions covering: goals, timeline, constraints, stakeholders, success metrics
  - Generates structured milestone outlines with title, description, estimated duration
  - Returns JSON in PlanningResponse format
- [ ] Create `MILESTONE_PLANNING_SYSTEM_PROMPT` constant:
  - Guides AI to break milestone into 2-5 slices
  - Each slice should be independently shippable
  - Defines features within each slice with acceptance criteria
  - Returns JSON with slice and feature definitions
- [ ] Both prompts include examples of desired output format
- [ ] Follow existing `PLANNING_SYSTEM_PROMPT` pattern from `planning.ts`

**Artifacts:**
- `packages/dashboard/src/mission-planning.ts` (expanded)

### Step 5: Mission Interview Session Manager

- [ ] Implement `MissionInterviewSession` class:
  - `id: string` (UUID)
  - `missionId?: string` — set if interviewing existing mission, undefined for new
  - `type: "mission" | "milestone"` — interview type
  - `targetId?: string` — milestone ID if type is "milestone"
  - `history: Array<{ question: MissionPlanningQuestion; response: unknown }>`
  - `agent?: AgentResult` — AI agent session
  - `streamCallback?: PlanningStreamCallback`
  - `createdAt`, `updatedAt` timestamps
- [ ] Implement session management functions:
  - `createMissionInterview(ip: string, initialGoal: string, rootDir: string): Promise<string>` — Create new mission interview
  - `createMilestoneInterview(ip: string, missionId: string, milestoneId: string, rootDir: string): Promise<string>` — Interview existing milestone
  - `submitMissionResponse(sessionId: string, response: Record<string, unknown>): Promise<PlanningResponse>`
  - `cancelMissionInterview(sessionId: string): Promise<void>`
  - `getMissionInterview(sessionId: string): MissionInterviewSession | undefined`
- [ ] Implement agent integration following `initializeAgent` pattern from `planning.ts`:
  - Use `createKbAgent` with appropriate system prompt
  - Stream thinking output via `planningStreamManager`
  - Parse JSON responses for questions and summaries
- [ ] Add rate limiting using existing `checkRateLimit` pattern

**Artifacts:**
- `packages/dashboard/src/mission-planning.ts` (expanded)

### Step 6: Mission Interview API Endpoints

- [ ] Add interview routes to server-side `api.ts`:
  - `POST /api/missions/interview` — Start new mission interview
    - Body: `{ initialGoal: string }`
    - Returns: `{ sessionId: string }`
  - `POST /api/missions/:id/interview` — Start re-interview of existing mission
    - Body: `{ context?: string }` — optional context for re-interview
    - Returns: `{ sessionId: string }`
  - `POST /api/missions/:id/milestones/:milestoneId/interview` — Interview milestone
    - Body: `{ context?: string }`
    - Returns: `{ sessionId: string }`
  - `POST /api/missions/interview/:sessionId/respond` — Submit response
    - Body: `{ response: Record<string, unknown> }`
    - Returns: `PlanningResponse`
  - `POST /api/missions/interview/:sessionId/cancel` — Cancel interview
  - `GET /api/missions/interview/:sessionId/stream` — SSE stream for interview
- [ ] Connect to `planningStreamManager` for SSE broadcasting
- [ ] All endpoints use rate limiting
- [ ] Handle session not found errors with 404

**Artifacts:**
- `packages/dashboard/api.ts` (modified)

### Step 7: Mission Interview Modal Component

- [ ] Create `MissionInterviewModal.tsx`:
  - Props interface: `isOpen`, `onClose`, `onComplete`, `missionId?`, `milestoneId?`, `initialGoal?`
  - Follow `PlanningModeModal.tsx` patterns for state management
  - View states: "initial", "loading", "question", "summary"
- [ ] Implement interview flow:
  - If `missionId` provided: re-interview mode (fetch existing mission context)
  - If `milestoneId` provided: milestone interview mode
  - If `initialGoal` provided: auto-start new mission interview
  - Otherwise: show initial input form for goal
- [ ] Implement question rendering:
  - Text questions: textarea input
  - Single select: radio buttons or dropdown
  - Multi select: checkbox group
  - Confirm: yes/no buttons
- [ ] Implement streaming thinking display:
  - Use `connectPlanningStream` for SSE
  - Show thinking output while AI is processing
  - Collapsible thinking panel (like PlanningModeModal)
- [ ] Implement summary display:
  - Show generated milestones (mission interview) or slices/features (milestone interview)
  - Editable fields for titles and descriptions
  - "Create" button to save to database
  - "Regenerate" button to restart interview
- [ ] Handle errors gracefully with retry option

**Artifacts:**
- `packages/dashboard/app/components/MissionInterviewModal.tsx` (new)

### Step 8: Mission Interview API Client

- [ ] Add interview API client functions to dashboard `api.ts`:
  - `startMissionInterview(initialGoal: string): Promise<{ sessionId: string }>`
  - `startMissionReinterview(missionId: string, context?: string): Promise<{ sessionId: string }>`
  - `startMilestoneInterview(missionId: string, milestoneId: string, context?: string): Promise<{ sessionId: string }>`
  - `respondToMissionInterview(sessionId: string, response: Record<string, unknown>): Promise<PlanningResponse>`
  - `cancelMissionInterview(sessionId: string): Promise<void>`
  - `connectMissionInterviewStream(sessionId: string, callbacks: StreamCallbacks): { close: () => void }`
- [ ] Follow existing planning API function patterns
- [ ] Type `StreamCallbacks` with `onThinking`, `onQuestion`, `onSummary`, `onError`, `onComplete`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 9: Interview Integration with Mission Creation

- [ ] Extend `MissionInterviewModal` to create missions from interview:
  - When mission interview completes, show "Create Mission" button
  - On click: call `createMission` API with generated title/description
  - Then call `addMilestone` for each generated milestone
  - Optionally start milestone interviews immediately after
- [ ] Extend modal to create slices/features from milestone interview:
  - When milestone interview completes, show "Save Plan" button
  - On click: call `addSlice` for each generated slice
  - Call `addFeature` for each feature within slice
- [ ] Emit appropriate events on completion for dashboard refresh

**Artifacts:**
- `packages/dashboard/app/components/MissionInterviewModal.tsx` (complete)

### Step 10: Testing & Verification

> ZERO test failures allowed.

- [ ] Test mission API endpoints:
  - Create mission via API
  - Add milestones, slices, features
  - Reorder milestones and slices
  - Activate slice
  - Delete mission (verify cascade)
- [ ] Test interview system:
  - Start mission interview
  - Complete interview flow
  - Verify mission created with milestones
  - Start milestone interview
  - Verify slices/features created
- [ ] Run `pnpm test` in dashboard package
- [ ] Run `pnpm typecheck` — zero errors
- [ ] Run `pnpm build` — successful

### Step 11: Documentation & Delivery

- [ ] Create changeset file:
  ```bash
  cat > .changeset/missions-api-and-interview.md << 'EOF'
  ---
  "@fusion/dashboard": minor
  ---
  
  Add Mission REST API endpoints and AI-driven interview system for mission and milestone planning.
  EOF
  ```
- [ ] Add JSDoc comments to all public API functions
- [ ] Commit: `feat(KB-628b): complete Mission API and Interview System`

## Documentation Requirements

**Must Update:**
- Changeset file as shown above

**Check If Affected:**
- No README changes needed yet

## Completion Criteria

- [ ] All 11 steps complete
- [ ] REST API for all mission CRUD operations
- [ ] Mission and milestone interview system working
- [ ] MissionInterviewModal component functional
- [ ] All tests passing
- [ ] Typecheck passing
- [ ] Changeset created

## Git Commit Convention

- **Step completion:** `feat(KB-628b): complete Step N — description`
- **Bug fixes:** `fix(KB-628b): description`
- **Tests:** `test(KB-628b): description`

## Do NOT

- Skip API error handling
- Skip rate limiting on interview endpoints
- Modify existing planning system behavior
- Skip the SSE streaming for interviews
- Skip validation of interview responses
- Forget to handle session expiration cleanup
