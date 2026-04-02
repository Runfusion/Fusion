# Task: KB-628a - Missions Foundation: Database Schema, Types, and Core Store

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This lays the foundation for the entire Missions system. Database schema changes require careful foreign key design and migration planning. The MissionStore patterns must align with existing TaskStore conventions.

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

## File Scope

**New Files:**
- `packages/core/src/mission-types.ts` — Mission, Milestone, Slice, Feature type definitions
- `packages/core/src/mission-store.ts` — MissionStore class with CRUD operations
- `packages/core/src/mission-store.test.ts` — Comprehensive tests for MissionStore

**Modified Files:**
- `packages/core/src/db.ts` — Add mission tables to schema, bump SCHEMA_VERSION to 3
- `packages/core/src/types.ts` — Export mission types
- `packages/core/src/index.ts` — Export mission types and MissionStore

## Steps

### Step 1: Database Schema Migration

- [ ] Bump `SCHEMA_VERSION` from 2 to 3 in `db.ts`
- [ ] Add `missionId` and `sliceId` columns to existing `tasks` table (nullable TEXT) via migration block
- [ ] Add new tables to `SCHEMA_SQL`:
  - `missions` — id (PK), title, description, status, interviewState, createdAt, updatedAt
  - `milestones` — id (PK), missionId (FK), title, description, status, orderIndex, interviewState, createdAt, updatedAt
  - `slices` — id (PK), milestoneId (FK), title, description, status, orderIndex, activatedAt, createdAt, updatedAt
  - `mission_features` — id (PK), sliceId (FK), taskId (nullable FK), title, description, acceptanceCriteria, createdAt, updatedAt
- [ ] Add foreign key constraints: `FOREIGN KEY (missionId) REFERENCES missions(id) ON DELETE CASCADE`
- [ ] Add JSON columns for metadata arrays using `TEXT DEFAULT '[]'` pattern
- [ ] Add migration block in `migrate()` method for version 3

**Artifacts:**
- `packages/core/src/db.ts` (modified)

### Step 2: Mission Types Definition

- [ ] Create `mission-types.ts` with all type definitions following existing patterns:
  - `MissionStatus` = "planning" | "active" | "blocked" | "complete" | "archived"
  - `MilestoneStatus` = "planning" | "active" | "blocked" | "complete"
  - `SliceStatus` = "pending" | "active" | "complete"
  - `FeatureStatus` = "defined" | "triaged" | "in-progress" | "done"
  - `InterviewState` = "not_started" | "in_progress" | "completed" | "needs_update"
  - `Mission` interface with id, title, description, status, interviewState, metadata, timestamps
  - `Milestone` interface with id, missionId, title, description, status, orderIndex, interviewState, dependencies, timestamps
  - `Slice` interface with id, milestoneId, title, description, status, orderIndex, activatedAt, timestamps
  - `MissionFeature` interface with id, sliceId, taskId (nullable), title, description, acceptanceCriteria, timestamps
  - `MissionCreateInput`, `MilestoneCreateInput`, `SliceCreateInput`, `FeatureCreateInput` for creation
  - `MissionWithHierarchy` type for full tree: Mission + milestones + slices + features
- [ ] Add JSDoc comments for all types explaining their role in the hierarchy

**Artifacts:**
- `packages/core/src/mission-types.ts` (new)

### Step 3: MissionStore Class Foundation

- [ ] Create `MissionStore` class extending `EventEmitter` (follow TaskStore pattern)
- [ ] Constructor accepting `kbDir: string` and initializing database reference
- [ ] Private `db` getter that returns the shared Database instance
- [ ] Private row-to-object conversion methods: `rowToMission()`, `rowToMilestone()`, `rowToSlice()`, `rowToFeature()`

**Artifacts:**
- `packages/core/src/mission-store.ts` (new — skeleton)

### Step 4: Mission CRUD Operations

- [ ] `createMission(input: MissionCreateInput): Mission` — Insert mission, emit "mission:created"
- [ ] `getMission(id: string): Mission | undefined` — Get mission by ID
- [ ] `getMissionWithHierarchy(id: string): MissionWithHierarchy | undefined` — Get mission with all children
- [ ] `listMissions(): Mission[]` — List all missions ordered by createdAt desc
- [ ] `updateMission(id: string, updates: Partial<Mission>): Mission` — Update mission, emit "mission:updated"
- [ ] `deleteMission(id: string): void` — Delete mission (cascades via FK), emit "mission:deleted"
- [ ] All methods use `db.transaction()` for atomic operations
- [ ] All methods call `db.bumpLastModified()` after writes

**Artifacts:**
- `packages/core/src/mission-store.ts` (expanded)

### Step 5: Milestone Operations

- [ ] `addMilestone(missionId: string, input: MilestoneCreateInput): Milestone` — Add with auto orderIndex
- [ ] `getMilestone(id: string): Milestone | undefined` — Get single milestone
- [ ] `listMilestones(missionId: string): Milestone[]` — List by mission, ordered by orderIndex
- [ ] `updateMilestone(id: string, updates: Partial<Milestone>): Milestone` — Update milestone
- [ ] `deleteMilestone(id: string): void` — Delete milestone (cascades to slices)
- [ ] `reorderMilestones(missionId: string, orderedIds: string[]): void` — Update orderIndex values
- [ ] Auto-compute milestone status on update operations

**Artifacts:**
- `packages/core/src/mission-store.ts` (expanded)

### Step 6: Slice Operations

- [ ] `addSlice(milestoneId: string, input: SliceCreateInput): Slice` — Add with auto orderIndex
- [ ] `getSlice(id: string): Slice | undefined` — Get single slice
- [ ] `listSlices(milestoneId: string): Slice[]` — List by milestone, ordered by orderIndex
- [ ] `updateSlice(id: string, updates: Partial<Slice>): Slice` — Update slice
- [ ] `deleteSlice(id: string): void` — Delete slice (cascades to features)
- [ ] `reorderSlices(milestoneId: string, orderedIds: string[]): void` — Update orderIndex values
- [ ] `activateSlice(id: string): Slice` — Set status to "active", set activatedAt, emit "slice:activated"

**Artifacts:**
- `packages/core/src/mission-store.ts` (expanded)

### Step 7: Feature Operations

- [ ] `addFeature(sliceId: string, input: FeatureCreateInput): MissionFeature` — Add feature
- [ ] `getFeature(id: string): MissionFeature | undefined` — Get single feature
- [ ] `listFeatures(sliceId: string): MissionFeature[]` — List by slice
- [ ] `updateFeature(id: string, updates: Partial<MissionFeature>): MissionFeature` — Update feature
- [ ] `deleteFeature(id: string): void` — Delete feature
- [ ] `linkFeatureToTask(featureId: string, taskId: string): MissionFeature` — Link to actual task

**Artifacts:**
- `packages/core/src/mission-store.ts` (expanded)

### Step 8: Status Rollup Logic

- [ ] `computeSliceStatus(sliceId: string): SliceStatus` — Based on linked task status
  - If no tasks linked: "pending"
  - If all linked tasks done: "complete"
  - Otherwise: "active"
- [ ] `computeMilestoneStatus(milestoneId: string): MilestoneStatus` — Based on slice statuses
  - If any slice blocked: "blocked"
  - If all slices complete: "complete"
  - If any slice active: "active"
  - Otherwise: "planning"
- [ ] `computeMissionStatus(missionId: string): MissionStatus` — Based on milestone statuses
  - If any milestone blocked: "blocked"
  - If all milestones complete: "complete"
  - If any milestone active: "active"
  - Otherwise: "planning"
- [ ] Status auto-updates called after slice/milestone changes

**Artifacts:**
- `packages/core/src/mission-store.ts` (complete)

### Step 9: MissionStore Tests

- [ ] Test mission CRUD: create, get, list, update, delete
- [ ] Test milestone operations: add, reorder, update, delete
- [ ] Test slice operations: add, reorder, activate
- [ ] Test feature operations: add, link to task
- [ ] Test cascade deletes: delete mission → milestones gone → slices gone → features gone
- [ ] Test status rollup: verify proper status computation
- [ ] Test event emissions: verify "mission:created", "slice:activated" events fire
- [ ] Use temporary database for tests (follow store.test.ts patterns)

**Artifacts:**
- `packages/core/src/mission-store.test.ts` (new)

### Step 10: Integration & Exports

- [ ] Add exports to `packages/core/src/index.ts`:
  - All mission types from `mission-types.ts`
  - `MissionStore` class from `mission-store.ts`
- [ ] Add export to `packages/core/src/types.ts` if needed for cross-module type references
- [ ] Run `pnpm typecheck` in core package
- [ ] Fix any type errors

**Artifacts:**
- `packages/core/src/index.ts` (modified)

### Step 11: Testing & Verification

> ZERO test failures allowed.

- [ ] Run `pnpm test` in packages/core — all existing tests must pass
- [ ] Run new MissionStore tests — all must pass
- [ ] Run `pnpm typecheck` — zero errors
- [ ] Run `pnpm build` — successful
- [ ] Verify schema migration works: delete fusion.db, run init, verify tables exist

### Step 12: Documentation & Delivery

- [ ] Add JSDoc comments to all public MissionStore methods
- [ ] Create changeset file for the schema changes:
  ```bash
  cat > .changeset/missions-database-schema.md << 'EOF'
  ---
  "@fusion/core": minor
  ---
  
  Add Missions database schema and MissionStore for hierarchical project planning.
  New tables: missions, milestones, slices, mission_features.
  EOF
  ```
- [ ] Commit: `feat(KB-628a): complete Missions database schema and MissionStore`

## Documentation Requirements

**Must Update:**
- Changeset file as shown above

**Check If Affected:**
- No README changes needed yet (feature not user-facing until UI tasks complete)

## Completion Criteria

- [ ] All 12 steps complete
- [ ] Schema version 3 with mission tables
- [ ] MissionStore with full CRUD for all 4 hierarchy levels
- [ ] Status rollup logic working
- [ ] All tests passing (existing + new)
- [ ] Typecheck passing
- [ ] Changeset created

## Git Commit Convention

- **Step completion:** `feat(KB-628a): complete Step N — description`
- **Bug fixes:** `fix(KB-628a): description`
- **Tests:** `test(KB-628a): description`

## Do NOT

- Skip database migrations — always use proper schema version bumps
- Skip tests for MissionStore operations
- Modify existing task table behavior beyond adding missionId/sliceId columns
- Skip foreign key constraints
- Skip the EventEmitter pattern — events are required for dashboard reactivity
- Forget to bump `db.bumpLastModified()` after writes
- Skip JSDoc comments on public APIs
