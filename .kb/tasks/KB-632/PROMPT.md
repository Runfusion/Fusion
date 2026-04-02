# Task: KB-632 - Missions Foundation: Database Schema, Types, and Core Store

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is the foundational data layer for the Missions hierarchy system. Database schema changes require careful foreign key design. The MissionStore patterns must align with existing TaskStore conventions.

**Score:** 5/8 — Blast radius: 2 (new tables, minimal existing changes), Pattern novelty: 1 (follows existing patterns), Security: 1 (standard SQLite), Reversibility: 1 (new tables, safe to revert)

## Mission

Create the foundational data layer for the Missions hierarchy system. Implement the SQLite database schema for missions, milestones, slices, and features, define comprehensive TypeScript types, and build the MissionStore class with full CRUD operations and status rollup logic. This is the bedrock upon which all other mission functionality will be built.

## Dependencies

- **None** — This is the foundation task for KB-628

## Context to Read First

1. `packages/core/src/db.ts` — Study SCHEMA_SQL structure, migration approach with `SCHEMA_VERSION`, and JSON column helpers (`toJson`, `fromJson`)
2. `packages/core/src/types.ts` — Review Task type definition, Status enums, and type patterns
3. `packages/core/src/store.ts` — Understand TaskStore class structure, EventEmitter patterns, transaction handling, and rowToTask conversion
4. `packages/core/src/db-migrate.ts` — Study how schema migrations are applied and how to add new columns to existing tables
5. `.fusion/tasks/KB-628a/PROMPT.md` — Full parent specification with additional context

## File Scope

**New Files:**
- `packages/core/src/mission-types.ts` — Mission, Milestone, Slice, Feature type definitions
- `packages/core/src/mission-store.ts` — MissionStore class with CRUD operations
- `packages/core/src/mission-store.test.ts` — Comprehensive tests for MissionStore

**Modified Files:**
- `packages/core/src/db.ts` — Add mission tables to schema, bump SCHEMA_VERSION to 3
- `packages/core/src/index.ts` — Export mission types and MissionStore

## Steps

### Step 0: Preflight

- [ ] All context files read and understood
- [ ] Task is in todo column (move from triage if needed)
- [ ] pnpm install completed in workspace

### Step 1: Database Schema Migration

- [ ] Bump `SCHEMA_VERSION` from 2 to 3 in `db.ts`
- [ ] Add `missionId` and `sliceId` columns to existing `tasks` table (nullable TEXT) via migration block
- [ ] Add new tables to `SCHEMA_SQL`:
  - `missions` — id (PK, TEXT), title (TEXT NOT NULL), description (TEXT), status (TEXT NOT NULL), interviewState (TEXT NOT NULL), createdAt (TEXT NOT NULL), updatedAt (TEXT NOT NULL)
  - `milestones` — id (PK, TEXT), missionId (FK, TEXT NOT NULL), title (TEXT NOT NULL), description (TEXT), status (TEXT NOT NULL), orderIndex (INTEGER NOT NULL), interviewState (TEXT NOT NULL), dependencies (TEXT DEFAULT '[]'), createdAt (TEXT NOT NULL), updatedAt (TEXT NOT NULL)
  - `slices` — id (PK, TEXT), milestoneId (FK, TEXT NOT NULL), title (TEXT NOT NULL), description (TEXT), status (TEXT NOT NULL), orderIndex (INTEGER NOT NULL), activatedAt (TEXT), createdAt (TEXT NOT NULL), updatedAt (TEXT NOT NULL)
  - `mission_features` — id (PK, TEXT), sliceId (FK, TEXT NOT NULL), taskId (TEXT, nullable FK to tasks), title (TEXT NOT NULL), description (TEXT), acceptanceCriteria (TEXT), status (TEXT NOT NULL), createdAt (TEXT NOT NULL), updatedAt (TEXT NOT NULL)
- [ ] Add foreign key constraints with `ON DELETE CASCADE`:
  - milestones.missionId → missions.id
  - slices.milestoneId → milestones.id
  - mission_features.sliceId → slices.id
  - mission_features.taskId → tasks.id (ON DELETE SET NULL)
- [ ] Add migration block in `migrate()` method for version 3 that adds `missionId` and `sliceId` columns to tasks table using `addColumnIfMissing`

**Artifacts:**
- `packages/core/src/db.ts` (modified)

### Step 2: Mission Types Definition

- [ ] Create `mission-types.ts` with all type definitions following existing patterns:
  - `MissionStatus` = "planning" | "active" | "blocked" | "complete" | "archived"
  - `MilestoneStatus` = "planning" | "active" | "blocked" | "complete"
  - `SliceStatus` = "pending" | "active" | "complete"
  - `FeatureStatus` = "defined" | "triaged" | "in-progress" | "done"
  - `InterviewState` = "not_started" | "in_progress" | "completed" | "needs_update"
  - `Mission` interface with id, title, description, status, interviewState, createdAt, updatedAt
  - `Milestone` interface with id, missionId, title, description, status, orderIndex, interviewState, dependencies (string[]), createdAt, updatedAt
  - `Slice` interface with id, milestoneId, title, description, status, orderIndex, activatedAt (optional), createdAt, updatedAt
  - `MissionFeature` interface with id, sliceId, taskId (optional), title, description, acceptanceCriteria (optional), status, createdAt, updatedAt
  - `MissionCreateInput`, `MilestoneCreateInput`, `SliceCreateInput`, `FeatureCreateInput` for creation (all fields except id, timestamps)
  - `MissionWithHierarchy` type for full tree: Mission + milestones[] with slices[] with features[]
- [ ] Add JSDoc comments for all types explaining their role in the hierarchy

**Artifacts:**
- `packages/core/src/mission-types.ts` (new)

### Step 3: MissionStore Class Foundation

- [ ] Create `MissionStore` class extending `EventEmitter` (follow TaskStore pattern)
- [ ] Define event types interface `MissionStoreEvents`:
  - "mission:created" [Mission]
  - "mission:updated" [Mission]
  - "mission:deleted" [missionId: string]
  - "milestone:created" [Milestone]
  - "milestone:updated" [Milestone]
  - "milestone:deleted" [milestoneId: string]
  - "slice:created" [Slice]
  - "slice:updated" [Slice]
  - "slice:deleted" [sliceId: string]
  - "slice:activated" [Slice]
  - "feature:created" [MissionFeature]
  - "feature:updated" [MissionFeature]
  - "feature:deleted" [featureId: string]
  - "feature:linked" [{ feature: MissionFeature; taskId: string }]
- [ ] Constructor accepting `kbDir: string` and `db: Database` (reuse shared Database instance)
- [ ] Private row-to-object conversion methods: `rowToMission()`, `rowToMilestone()`, `rowToSlice()`, `rowToFeature()` using `fromJson` for JSON columns

**Artifacts:**
- `packages/core/src/mission-store.ts` (new — skeleton with EventEmitter setup)

### Step 4: Mission CRUD Operations

- [ ] `createMission(input: MissionCreateInput): Mission` — Insert mission with "planning" status and "not_started" interviewState, emit "mission:created", bump lastModified
- [ ] `getMission(id: string): Mission | undefined` — Get mission by ID using db.prepare().get()
- [ ] `getMissionWithHierarchy(id: string): MissionWithHierarchy | undefined` — Get mission with all milestones, their slices, and their features (3-level join or sequential queries)
- [ ] `listMissions(): Mission[]` — List all missions ordered by createdAt desc
- [ ] `updateMission(id: string, updates: Partial<Mission>): Mission` — Update mission (excluding id, createdAt), set updatedAt, emit "mission:updated", bump lastModified
- [ ] `deleteMission(id: string): void` — Delete mission (cascades via FK), emit "mission:deleted", bump lastModified
- [ ] `updateMissionInterviewState(id: string, state: InterviewState): Mission` — Specialized update for interview flow
- [ ] All methods use `this.db.transaction()` for atomic operations where needed
- [ ] All write methods call `this.db.bumpLastModified()` after writes

**Artifacts:**
- `packages/core/src/mission-store.ts` (expanded with mission CRUD)

### Step 5: Milestone Operations

- [ ] `addMilestone(missionId: string, input: MilestoneCreateInput): Milestone` — Add with auto-computed orderIndex (max + 1), emit "milestone:created"
- [ ] `getMilestone(id: string): Milestone | undefined` — Get single milestone
- [ ] `listMilestones(missionId: string): Milestone[]` — List by mission, ordered by orderIndex asc
- [ ] `updateMilestone(id: string, updates: Partial<Milestone>): Milestone` — Update milestone, emit "milestone:updated"
- [ ] `deleteMilestone(id: string): void` — Delete milestone (cascades to slices), emit "milestone:deleted"
- [ ] `reorderMilestones(missionId: string, orderedIds: string[]): void` — Update orderIndex values in transaction
- [ ] `updateMilestoneInterviewState(id: string, state: InterviewState): Milestone` — Specialized update for interview flow
- [ ] `computeMilestoneStatus(milestoneId: string): MilestoneStatus` — Based on slice statuses (see Step 8)

**Artifacts:**
- `packages/core/src/mission-store.ts` (expanded with milestone operations)

### Step 6: Slice Operations

- [ ] `addSlice(milestoneId: string, input: SliceCreateInput): Slice` — Add with auto-computed orderIndex (max + 1), status "pending", emit "slice:created"
- [ ] `getSlice(id: string): Slice | undefined` — Get single slice
- [ ] `listSlices(milestoneId: string): Slice[]` — List by milestone, ordered by orderIndex asc
- [ ] `updateSlice(id: string, updates: Partial<Slice>): Slice` — Update slice, emit "slice:updated"
- [ ] `deleteSlice(id: string): void` — Delete slice (cascades to features), emit "slice:deleted"
- [ ] `reorderSlices(milestoneId: string, orderedIds: string[]): void` — Update orderIndex values in transaction
- [ ] `activateSlice(id: string): Slice` — Set status to "active", set activatedAt to now, emit "slice:activated"
- [ ] `computeSliceStatus(sliceId: string): SliceStatus` — Based on linked task status (see Step 8)

**Artifacts:**
- `packages/core/src/mission-store.ts` (expanded with slice operations)

### Step 7: Feature Operations

- [ ] `addFeature(sliceId: string, input: FeatureCreateInput): MissionFeature` — Add feature with status "defined", emit "feature:created"
- [ ] `getFeature(id: string): MissionFeature | undefined` — Get single feature
- [ ] `listFeatures(sliceId: string): MissionFeature[]` — List by slice ordered by createdAt
- [ ] `updateFeature(id: string, updates: Partial<MissionFeature>): MissionFeature` — Update feature, emit "feature:updated"
- [ ] `deleteFeature(id: string): void` — Delete feature, emit "feature:deleted"
- [ ] `linkFeatureToTask(featureId: string, taskId: string): MissionFeature` — Set taskId, emit "feature:linked", recompute slice status
- [ ] `unlinkFeatureFromTask(featureId: string): MissionFeature` — Clear taskId, recompute slice status
- [ ] `getFeatureByTaskId(taskId: string): MissionFeature | undefined` — Find feature linked to a task

**Artifacts:**
- `packages/core/src/mission-store.ts` (expanded with feature operations)

### Step 8: Status Rollup Logic

- [ ] `computeSliceStatus(sliceId: string): SliceStatus` — Determine slice status based on features:
  - If no features: "pending"
  - If all features linked to done tasks: "complete"
  - If any feature linked to in-progress task: "active"
  - If any feature linked to triaged (ready) task: "active"
  - Otherwise: "pending"
- [ ] `computeMilestoneStatus(milestoneId: string): MilestoneStatus` — Based on slice statuses:
  - If any slice "active": "active"
  - If all slices "complete": "complete"
  - If any slice "active" or "complete" but not all complete: "active"
  - Otherwise: "planning"
  - Note: "blocked" is manually set, not auto-computed
- [ ] `computeMissionStatus(missionId: string): MissionStatus` — Based on milestone statuses:
  - If any milestone "active": "active"
  - If all milestones "complete": "complete"
  - If any milestone "active" or "complete" but not all complete: "active"
  - Otherwise: "planning"
  - Note: "blocked" and "archived" are manually set
- [ ] Auto-update status after relevant changes:
  - After `linkFeatureToTask` / `unlinkFeatureFromTask`: recompute slice status
  - After slice status changes: recompute milestone status
  - After milestone status changes: recompute mission status

**Artifacts:**
- `packages/core/src/mission-store.ts` (complete with status rollup logic)

### Step 9: MissionStore Tests

- [ ] Test mission CRUD: create, get, list, update, delete with event emissions
- [ ] Test milestone operations: add, get, list, reorder, update, delete
- [ ] Test slice operations: add, get, list, reorder, activate
- [ ] Test feature operations: add, get, list, update, delete, link/unlink to task
- [ ] Test cascade deletes: delete mission → milestones gone → slices gone → features gone
- [ ] Test status rollup: verify slice status computed from task links, milestone from slices, mission from milestones
- [ ] Test event emissions: verify "mission:created", "slice:activated", "feature:linked" events fire with correct data
- [ ] Test `getMissionWithHierarchy` returns full tree structure
- [ ] Test transaction rollback on errors
- [ ] Use temporary database for tests (follow store.test.ts patterns with mkdtempSync)
- [ ] Import test utilities: `describe, it, expect, beforeEach, afterEach` from vitest

**Artifacts:**
- `packages/core/src/mission-store.test.ts` (new)

### Step 10: Integration & Exports

- [ ] Add exports to `packages/core/src/index.ts`:
  - All mission types from `mission-types.ts`
  - `MissionStore` class from `mission-store.ts`
  - `MissionStoreEvents` type
- [ ] Run `pnpm typecheck` in packages/core
- [ ] Fix any type errors

**Artifacts:**
- `packages/core/src/index.ts` (modified)

### Step 11: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in packages/core — all existing tests must pass
- [ ] Run new MissionStore tests — all must pass
- [ ] Run `pnpm typecheck` — zero errors
- [ ] Run `pnpm build` — successful
- [ ] Verify schema migration works: create fresh temp db, init store, verify tables exist with `db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()`

### Step 12: Documentation & Delivery

- [ ] Add JSDoc comments to all public MissionStore methods explaining parameters and return values
- [ ] Create changeset file for the schema changes:
  ```bash
  cat > .changeset/missions-database-schema.md << 'EOF'
  ---
  "@fusion/core": minor
  ---
  
  Add Missions database schema and MissionStore for hierarchical project planning.
  New tables: missions, milestones, slices, mission_features.
  New types and MissionStore class with full CRUD and status rollup logic.
  EOF
  ```
- [ ] Commit: `feat(KB-632): complete Missions database schema and MissionStore`

## Documentation Requirements

**Must Update:**
- Changeset file as shown above

**Check If Affected:**
- No README changes needed yet (feature not user-facing until UI tasks complete)

## Completion Criteria

- [ ] All 12 steps complete
- [ ] Schema version 3 with mission tables and task table columns (missionId, sliceId)
- [ ] MissionStore with full CRUD for all 4 hierarchy levels
- [ ] Status rollup logic working (slice → milestone → mission)
- [ ] All tests passing (existing + new MissionStore tests)
- [ ] Typecheck passing
- [ ] Changeset created
- [ ] Code follows existing patterns from TaskStore

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-632): complete Step N — description`
- **Bug fixes:** `fix(KB-632): description`
- **Tests:** `test(KB-632): description`
- **Changeset:** `chore(KB-632): add changeset for missions schema`

## Do NOT

- Skip database migrations — always use proper schema version bumps
- Skip tests for MissionStore operations
- Modify existing task table behavior beyond adding missionId/sliceId columns
- Skip foreign key constraints or cascade rules
- Skip the EventEmitter pattern — events are required for dashboard reactivity
- Forget to bump `db.bumpLastModified()` after writes
- Skip JSDoc comments on public APIs
- Access DatabaseSync directly — always use the Database wrapper class
- Skip transaction handling for multi-row operations (reorder, cascade status updates)
