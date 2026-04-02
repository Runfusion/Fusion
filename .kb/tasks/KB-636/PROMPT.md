# Task: KB-636 - Final Integration: Testing, Documentation, and Polish

**Created:** 2026-04-01
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is the final quality gate for the entire Missions system spanning 4 previous tasks (KB-632 through KB-635). It requires comprehensive end-to-end testing across database, API, UI, CLI, and engine integration. Documentation must be accurate and complete for users to understand this major new feature.

**Score:** 7/8 — Blast radius: 2 (cross-cutting integration), Pattern novelty: 1 (follows existing patterns), Security: 2 (new CLI commands need validation), Reversibility: 2 (new feature, can be disabled)

## Mission

Complete the Missions system by performing comprehensive end-to-end testing, updating all documentation, adding the final integration touches, and ensuring the entire feature is production-ready. This task serves as the final quality gate before the Missions system can be considered fully implemented and ready for user adoption.

The Missions system enables large-scale project planning through a hierarchical structure:
- **Mission** — High-level goal or project (e.g., "Build Authentication System")
- **Milestone** — Major phases within a mission (e.g., "Database Schema", "API Endpoints", "UI Integration")
- **Slice** — Parallel work areas within a milestone (e.g., "Backend Implementation", "Frontend Components")
- **Feature** — Individual deliverables linked to kb tasks (e.g., "Login Form", "JWT Middleware")

## Dependencies

- **Task:** KB-632 — Missions Foundation: Database Schema, Types, and Core Store
  - Must deliver: `MissionStore` class, mission types (`Mission`, `Milestone`, `Slice`, `MissionFeature`), database schema v3
- **Task:** KB-633 — Mission REST API and Interview System
  - Must deliver: `/api/missions/*` endpoints, interview session management, SSE streaming
- **Task:** KB-634 — Dashboard UI: Mission List, Detail View, and Timeline
  - Must deliver: `MissionListModal`, `MissionDetailModal`, `MissionTimeline`, `useMissions` hook
- **Task:** KB-635 — CLI Commands, Pi Extension, and Engine Integration
  - Must deliver: `fn mission *` commands, pi extension mission tools, scheduler auto-advance

## Context to Read First

1. `.fusion/tasks/KB-632/PROMPT.md` — MissionStore API and types expected
2. `.fusion/tasks/KB-633/PROMPT.md` — REST API endpoints and interview system
3. `.fusion/tasks/KB-634/PROMPT.md` — Dashboard UI components and hooks
4. `.fusion/tasks/KB-635/PROMPT.md` — CLI commands and engine integration
5. `packages/core/src/index.ts` — Verify mission exports exist
6. `README.md` — Current documentation structure and feature list
7. `AGENTS.md` — Project guidelines for changesets and commit conventions
8. `packages/cli/src/bin.ts` — CLI help text structure to extend

## File Scope

**Modified Files:**
- `README.md` — Add Missions section to documentation
- `packages/cli/src/bin.ts` — Update HELP text with mission commands
- `packages/core/src/index.ts` — Verify all mission exports present (may need additions)
- `.changeset/missions-launch.md` — Changeset for the Missions feature launch

**New Test Files:**
- `packages/core/src/mission-integration.test.ts` — Integration tests for MissionStore with TaskStore
- `packages/dashboard/src/mission-e2e.test.ts` — End-to-end API tests for mission workflows
- `packages/engine/src/mission-scheduler.test.ts` — Scheduler integration with missions

**Reference Files (read-only, for testing context):**
- `packages/core/src/mission-store.ts` — From KB-632
- `packages/core/src/mission-types.ts` — From KB-632
- `packages/dashboard/src/mission-routes.ts` — From KB-633
- `packages/dashboard/src/mission-interview.ts` — From KB-633
- `packages/dashboard/app/components/MissionListModal.tsx` — From KB-634
- `packages/dashboard/app/components/MissionDetailModal.tsx` — From KB-634
- `packages/dashboard/app/hooks/useMissions.ts` — From KB-634
- `packages/cli/src/commands/mission.ts` — From KB-635
- `packages/cli/src/extension.ts` — Mission tools from KB-635
- `packages/engine/src/scheduler.ts` — Mission integration from KB-635

## Steps

### Step 0: Preflight

- [ ] All 4 dependencies (KB-632, KB-633, KB-634, KB-635) are complete and merged
- [ ] Run `pnpm install` to ensure all dependencies are up to date
- [ ] Run `pnpm typecheck` in all packages — must pass before starting
- [ ] Run `pnpm test` in all packages — existing tests must pass
- [ ] Verify mission exports in `packages/core/src/index.ts`:
  ```typescript
  export type { Mission, Milestone, Slice, MissionFeature, MissionWithHierarchy, MissionStatus, MilestoneStatus, SliceStatus, FeatureStatus, InterviewState, MissionCreateInput, MilestoneCreateInput, SliceCreateInput, FeatureCreateInput } from "./mission-types.js";
  export { MissionStore } from "./mission-store.js";
  export type { MissionStoreEvents } from "./mission-store.js";
  ```

### Step 1: MissionStore Integration Tests

Create comprehensive integration tests for MissionStore working with the existing task system:

- [ ] Create `packages/core/src/mission-integration.test.ts`:
  - Test mission creation cascades correctly
  - Test task linking to features updates slice status
  - Test task `sliceId` and `missionId` columns work correctly
  - Test cascade delete: mission → milestones → slices → features
  - Test status rollup from features → slices → milestones → mission
  - Test MissionStore events emit correctly (`mission:created`, `slice:activated`, `feature:linked`)
  - Test MissionStore works with shared Database instance from TaskStore
  - Test concurrent modifications don't corrupt hierarchy state

- [ ] Test data integrity scenarios:
  - Create mission with 3 milestones, each with 2 slices, each with 3 features
  - Link some features to tasks, verify status rollup
  - Delete middle milestone, verify orderIndex recomputation
  - Reorder milestones and verify slice/feature integrity maintained

**Artifacts:**
- `packages/core/src/mission-integration.test.ts` (new)

### Step 2: REST API End-to-End Tests

Test the complete mission API workflow through HTTP endpoints:

- [ ] Create `packages/dashboard/src/mission-e2e.test.ts`:
  - Test full mission lifecycle: create → add milestones → add slices → add features → link tasks
  - Test interview session flow: start → respond → summary → create mission
  - Test SSE streaming for interview events (`thinking`, `question`, `summary`)
  - Test error handling: 404 for missing IDs, 400 for invalid input, 429 for rate limiting
  - Test cascade operations: delete mission removes all children
  - Test reordering endpoints for milestones and slices
  - Test slice activation endpoint updates status correctly

- [ ] Test API response formats:
  - GET /api/missions returns array with correct structure
  - GET /api/missions/:id returns `MissionWithHierarchy` with nested data
  - POST /api/missions returns 201 with created mission
  - Interview endpoints return proper session management

- [ ] Use supertest with temporary database following `routes.test.ts` patterns

**Artifacts:**
- `packages/dashboard/src/mission-e2e.test.ts` (new)

### Step 3: Scheduler Mission Integration Tests

Test engine scheduler behavior with missions:

- [ ] Create `packages/engine/src/mission-scheduler.test.ts`:
  - Test `activateNextPendingSlice()` finds and activates correct slice
  - Test auto-advance: when linked task completes, slice status updates
  - Test when all slice features complete, slice becomes "complete"
  - Test mission status rollup triggers when milestone status changes
  - Test no auto-advance when mission status is "blocked"
  - Test scheduler logs mission progress events correctly

- [ ] Mock MissionStore for isolated scheduler testing:
  - Verify event listeners are properly registered on scheduler init
  - Verify cleanup happens on scheduler stop
  - Test mission-aware scheduling doesn't break existing task scheduling

**Artifacts:**
- `packages/engine/src/mission-scheduler.test.ts` (new)

### Step 4: End-to-End User Flow Testing

Perform complete manual workflow verification:

- [ ] **CLI Workflow Test:**
  ```bash
  # Create mission
  fn mission create "Test Auth System" "Build complete auth with login, signup, password reset"
  
  # List missions
  fn mission list
  
  # Show mission (should show empty hierarchy)
  fn mission show M-001
  
  # Delete mission
  fn mission delete M-001 --force
  ```
  Verify each command produces expected output

- [ ] **Dashboard Workflow Test:**
  - Open dashboard, press Cmd/Ctrl+Shift+M → MissionListModal opens
  - Create mission via "New Mission" button
  - Open mission detail, add 2 milestones
  - Add 2 slices to first milestone
  - Add 2 features to first slice
  - Activate slice, verify status changes to "active"
  - Create task from feature, verify link created
  - Complete task, verify feature status updates to "done"
  - Verify slice status becomes "complete" when all features done

- [ ] **Interview Flow Test:**
  - Start mission interview from dashboard
  - Complete all interview questions
  - Verify summary generates correct milestone suggestions
  - Create mission from interview
  - Verify milestones created with correct structure

- [ ] **Pi Extension Test:**
  - Verify mission tools appear in pi tool list
  - Test `kb_mission_create` creates mission correctly
  - Test `kb_mission_list` returns formatted results
  - Test `kb_slice_activate` updates slice status

**Artifacts:**
- Manual testing notes (mental or documented in task log)

### Step 5: Documentation Updates — README.md

Add comprehensive Missions documentation to the main README:

- [ ] Add new "Missions" section after "Workflow" section:
  - Explain mission hierarchy (Mission → Milestone → Slice → Feature → Task)
  - Describe use case: large-scale project planning
  - Visual diagram using mermaid (follow existing diagram style)

- [ ] Add CLI commands to the "CLI Commands" section:
  ```markdown
  **Mission Management:**
  ```bash
  fn mission create "Title" "Description"    # Create new mission
  fn mission list                             # List all missions
  fn mission show <id>                        # Show mission with hierarchy
  fn mission delete <id> [--force]            # Delete mission
  fn mission activate-slice <id>              # Manually activate a slice
  ```

- [ ] Add Dashboard features section:
  - Cmd/Ctrl+Shift+M to open missions
  - Mission list with progress tracking
  - Hierarchical detail view
  - Timeline visualization
  - Interview mode for AI-assisted planning

- [ ] Verify all documentation is accurate and matches implementation

**Artifacts:**
- `README.md` (modified)

### Step 6: Documentation Updates — CLI Help Text

Update CLI help to include mission commands:

- [ ] Modify `packages/cli/src/bin.ts` HELP constant:
  - Add "Mission Management:" section before "Task Management"
  - Include all 5 mission commands with descriptions
  - Follow existing formatting and style

- [ ] Help text to add:
  ```
  fn mission create [title] [description]    Create a new mission
  fn mission list                            List all missions
  fn mission show <id>                       Show mission details with hierarchy
  fn mission delete <id> [--force]           Delete mission
  fn mission activate-slice <id>             Activate a pending slice
  ```

- [ ] Ensure `fn --help` displays mission commands correctly

**Artifacts:**
- `packages/cli/src/bin.ts` (modified — HELP text only)

### Step 7: Core Package Export Verification

Ensure all mission types are properly exported:

- [ ] Verify `packages/core/src/index.ts` exports:
  - All mission types from `mission-types.ts`
  - `MissionStore` class from `mission-store.ts`
  - `MissionStoreEvents` type

- [ ] Add any missing exports:
  ```typescript
  // From mission-types.ts
  export type { 
    Mission, 
    Milestone, 
    Slice, 
    MissionFeature,
    MissionWithHierarchy,
    MissionStatus,
    MilestoneStatus, 
    SliceStatus,
    FeatureStatus,
    InterviewState,
    MissionCreateInput,
    MilestoneCreateInput,
    SliceCreateInput,
    FeatureCreateInput
  } from "./mission-types.js";
  
  // From mission-store.ts
  export { MissionStore } from "./mission-store.js";
  export type { MissionStoreEvents } from "./mission-store.js";
  ```

- [ ] Run `pnpm typecheck` in packages/core — must pass

**Artifacts:**
- `packages/core/src/index.ts` (possibly modified)

### Step 8: Changeset Creation

Create changeset for the Missions feature launch:

- [ ] Create `.changeset/missions-launch.md`:
  ```bash
  cat > .changeset/missions-launch.md << 'EOF'
  ---
  "@fusion/core": minor
  "@fusion/dashboard": minor
  "@fusion/engine": minor
  "@gsxdsm/fusion": minor
  ---

  Add Missions system for large-scale project planning.

  The Missions system provides a hierarchical planning structure:
  - **Mission** — High-level goals and projects
  - **Milestone** — Major phases within missions  
  - **Slice** — Parallel work areas within milestones
  - **Feature** — Individual deliverables linked to tasks

  **New Features:**
  - SQLite database schema for mission hierarchy with automatic status rollup
  - MissionStore with full CRUD operations and event emissions
  - REST API with AI-driven interview system for interactive planning
  - Dashboard UI: mission list, hierarchical detail view, timeline visualization
  - CLI commands: `fn mission create`, `list`, `show`, `delete`, `activate-slice`
  - Pi extension tools for chat-based mission management
  - Engine integration: automatic slice activation when linked tasks complete

  **Usage:**
  - Press Cmd/Ctrl+Shift+M in dashboard to open missions
  - Use interview mode for AI-assisted mission planning
  - Link features to tasks for automatic progress tracking
  EOF
  ```

**Artifacts:**
- `.changeset/missions-launch.md` (new)

### Step 9: Edge Case Testing

Test and fix edge cases across the system:

- [ ] **Database Edge Cases:**
  - Empty mission (no milestones) — verify status stays "planning"
  - Milestone with no slices — verify status computation doesn't error
  - Slice with no features — verify "pending" status
  - Feature with empty title — validate and reject
  - Very long titles/descriptions — test truncation in UI

- [ ] **API Edge Cases:**
  - Concurrent interview sessions from same IP — verify rate limiting
  - SSE stream disconnect during interview — verify cleanup
  - Delete mission while interview in progress — verify error handling
  - Reorder to empty array — verify validation
  - Link feature to non-existent task — verify 404

- [ ] **UI Edge Cases:**
  - Mission with 50+ milestones — verify scrolling performance
  - Rapid inline edits — verify no race conditions
  - Close modal during drag operation — verify cleanup
  - Network error during save — verify retry UI

- [ ] **Engine Edge Cases:**
  - Task completes but feature already unlinked — verify no crash
  - Multiple slices become ready simultaneously — verify sequential activation
  - Scheduler restart during active mission — verify state recovery

**Artifacts:**
- Bug fixes as needed with `fix(KB-636):` commits

### Step 10: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in packages/core:
  - All existing tests pass
  - New `mission-integration.test.ts` passes
  - New `mission-store.test.ts` from KB-632 passes

- [ ] Run `pnpm test` in packages/dashboard:
  - All existing tests pass
  - New `mission-routes.test.ts` from KB-633 passes
  - New `mission-interview.test.ts` from KB-633 passes
  - New `mission-e2e.test.ts` passes
  - Component tests from KB-634 pass

- [ ] Run `pnpm test` in packages/engine:
  - All existing tests pass
  - New `mission-scheduler.test.ts` passes
  - Scheduler tests from KB-635 pass

- [ ] Run `pnpm test` in packages/cli:
  - All existing tests pass
  - New `mission.test.ts` from KB-635 passes

- [ ] Run `pnpm typecheck` in all packages — zero errors

- [ ] Run `pnpm build` — successful compilation across all packages

- [ ] Manual verification checklist:
  - [ ] CLI help text shows mission commands
  - [ ] README documents missions feature
  - [ ] All mission exports available from @fusion/core
  - [ ] Changeset created and valid

### Step 11: Documentation & Delivery

- [ ] Add JSDoc comments to integration test files explaining test scenarios
- [ ] Review all mission-related files for consistent terminology
- [ ] Verify no TODO comments or placeholder text remains in mission code
- [ ] Create any out-of-scope findings as new tasks via `task_create` tool:
  - Performance issues discovered
  - UI/UX improvements suggested during testing
  - Future feature enhancements

- [ ] Final commit: `feat(KB-636): complete Missions system final integration`

## Documentation Requirements

**Must Update:**
- `README.md` — Add Missions section with hierarchy explanation and usage
- `packages/cli/src/bin.ts` HELP text — Add mission commands documentation
- `.changeset/missions-launch.md` — Feature launch changeset

**Check If Affected:**
- `packages/core/src/index.ts` — Verify mission exports present
- `AGENTS.md` — Update if mission tool patterns differ significantly from task tools

## Completion Criteria

- [ ] All 11 steps complete
- [ ] MissionStore integration tests passing
- [ ] REST API end-to-end tests passing
- [ ] Scheduler mission integration tests passing
- [ ] Full CLI workflow manually verified
- [ ] Dashboard workflow manually verified
- [ ] Interview flow manually verified
- [ ] Pi extension tools verified
- [ ] README.md updated with missions documentation
- [ ] CLI help text includes mission commands
- [ ] Changeset created for minor version bump
- [ ] All package tests passing (existing + new)
- [ ] Typecheck passing in all packages
- [ ] Build successful
- [ ] No TODOs or placeholder code remaining

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-636): complete Step N — description`
- **Test files:** `test(KB-636): add mission integration/e2e tests`
- **Documentation:** `docs(KB-636): add missions documentation to README`
- **Bug fixes:** `fix(KB-636): description`
- **Changeset:** `chore(KB-636): add changeset for missions launch`

## Do NOT

- Skip any test files — all 3 new test files are required
- Skip manual testing of CLI, dashboard, and interview flows
- Modify mission implementation code (only tests, docs, and edge case fixes)
- Skip verifying all mission exports from @fusion/core
- Skip edge case testing — finding and fixing edge cases is part of this task
- Create changeset for private packages only (core, dashboard, engine are private; only @gsxdsm/fusion needs changeset)
- Skip updating CLI help text
- Leave TODO comments or placeholder code in production
- Skip verifying type exports work for external consumers

## Appendix: Mission System Overview

For reference during testing and documentation, the complete mission hierarchy:

```
Mission ("Build Auth System")
├── status: "active"
├── Milestone 1: "Database Schema" (complete)
│   ├── Slice 1: "User Tables" (complete)
│   │   ├── Feature 1: "User model" → Task KB-101 (done)
│   │   └── Feature 2: "Session table" → Task KB-102 (done)
│   └── Slice 2: "Token Storage" (complete)
│       └── Feature 3: "Refresh tokens" → Task KB-103 (done)
├── Milestone 2: "API Endpoints" (active)
│   └── Slice 3: "Login/Logout" (active)
│       ├── Feature 4: "Login endpoint" → Task KB-104 (in-progress)
│       └── Feature 5: "Logout endpoint" → Task KB-105 (triaged)
└── Milestone 3: "UI Integration" (planning)
    └── Slice 4: "React Components" (pending)
        └── Feature 6: "Login form" (defined)
```

**Status Flow:**
- Features: defined → triaged (linked to task) → in-progress → done
- Slices: pending → active (when first feature in-progress) → complete (all features done)
- Milestones: planning → active (when any slice active) → complete (all slices complete)
- Missions: planning → active → complete (all milestones complete) | blocked | archived
