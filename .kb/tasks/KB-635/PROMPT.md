# Task: KB-635 - CLI Commands, Pi Extension, and Engine Integration

**Created:** 2026-04-01
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This task bridges the Missions data layer (KB-632) with user-facing interfaces. CLI commands follow established patterns, but scheduler integration requires careful event handling to auto-advance slices when features complete. Multiple integration points require coordination.

**Score:** 6/8 — Blast radius: 2 (new commands, scheduler hooks), Pattern novelty: 1 (follows CLI patterns), Security: 1 (standard operations), Reversibility: 2 (new features, no breaking changes)

## Mission

Integrate the Missions system into all user-facing interfaces: CLI commands for mission management, pi extension tools for chat-based interaction, and engine scheduler hooks for automatic slice activation and milestone advancement. This brings the Missions hierarchy system to life, enabling users to plan, track, and execute multi-phase projects with automatic workflow progression.

## Dependencies

- **Task:** KB-632 (Missions Foundation) — Must provide MissionStore, mission types, and database schema before this task starts

## Context to Read First

1. `packages/cli/src/bin.ts` — Study CLI command registration patterns (task subcommands)
2. `packages/cli/src/commands/task.ts` — Study command implementation patterns (runTaskCreate, runTaskList, etc.)
3. `packages/cli/src/extension.ts` — Study pi extension tool registration patterns
4. `packages/engine/src/scheduler.ts` — Study how scheduler moves tasks and listens to events
5. `packages/engine/src/executor.ts` — Study task completion flow and where to hook mission updates
6. `packages/core/src/mission-store.ts` — From KB-632: MissionStore API and events
7. `packages/core/src/mission-types.ts` — From KB-632: Mission, Milestone, Slice, Feature types

## File Scope

**New Files:**
- `packages/cli/src/commands/mission.ts` — CLI command implementations for missions
- `packages/cli/src/commands/mission.test.ts` — Tests for mission commands

**Modified Files:**
- `packages/cli/src/bin.ts` — Add mission subcommands to CLI parser
- `packages/cli/src/extension.ts` — Add mission tools to pi extension
- `packages/engine/src/scheduler.ts` — Add slice activation and auto-advance logic
- `packages/engine/src/executor.ts` — Add mission progress updates on task completion
- `packages/engine/src/index.ts` — Export mission-aware scheduler options
- `packages/core/src/index.ts` — Ensure mission types and MissionStore are exported

## Steps

### Step 0: Preflight

- [ ] KB-632 complete: MissionStore, mission types, and database schema available
- [ ] All context files read and patterns understood
- [ ] MissionStore exports verified in `packages/core/src/index.ts`

### Step 1: Mission CLI Commands Foundation

- [ ] Create `packages/cli/src/commands/mission.ts` with command implementations:
  - `runMissionCreate(title?: string, description?: string)` — Create new mission
  - `runMissionList()` — List all missions with status summary
  - `runMissionShow(id: string)` — Display mission with hierarchy (milestones → slices → features)
  - `runMissionDelete(id: string, force?: boolean)` — Delete mission with confirmation
  - `runMissionActivateSlice(id: string)` — Manually activate a pending slice
- [ ] Import `MissionStore` from `@fusion/core`
- [ ] Follow patterns from `task.ts`: getStore() helper, console output formatting
- [ ] Handle interactive prompts when arguments omitted (use createInterface pattern)

**Artifacts:**
- `packages/cli/src/commands/mission.ts` (new)

### Step 2: Mission CLI Integration

- [ ] Import mission command handlers in `bin.ts`
- [ ] Add `mission` subcommands to CLI parser:
  - `fn mission create [title] [description]` — Create mission (prompts if args omitted)
  - `fn mission list` — List all missions
  - `fn mission show <id>` — Show mission details with hierarchy
  - `fn mission delete <id> [--force]` — Delete mission
  - `fn mission activate-slice <id>` — Activate a pending slice
- [ ] Update HELP text with mission commands section
- [ ] Follow argument parsing patterns from task subcommands

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 3: Mission Pi Extension Tools

- [ ] Add mission tools to `packages/cli/src/extension.ts`:
  - `kb_mission_create` — Create mission (params: title, description)
  - `kb_mission_list` — List missions (no params)
  - `kb_mission_show` — Show mission details (params: id)
  - `kb_mission_delete` — Delete mission (params: id)
  - `kb_milestone_add` — Add milestone to mission (params: missionId, title, description)
  - `kb_slice_add` — Add slice to milestone (params: milestoneId, title, description)
  - `kb_feature_add` — Add feature to slice (params: sliceId, title, description, acceptanceCriteria)
  - `kb_slice_activate` — Activate slice (params: id)
  - `kb_feature_link_task` — Link feature to task (params: featureId, taskId)
- [ ] Follow tool registration patterns from existing tools (kb_task_create, etc.)
- [ ] Use Type.Object() for parameters with proper descriptions
- [ ] Include promptGuidelines for each tool describing when to use it
- [ ] Format output consistently with existing tools

**Artifacts:**
- `packages/cli/src/extension.ts` (modified)

### Step 4: Scheduler Mission Awareness

- [ ] Modify `packages/engine/src/scheduler.ts` to accept optional MissionStore:
  - Add `missionStore?: MissionStore` to SchedulerOptions
  - Store reference in scheduler instance
- [ ] Add method `activateNextPendingSlice(missionId: string): Promise<Slice | null>`
  - Find the first milestone with pending slices
  - Activate the first pending slice in that milestone
  - Emit log via schedulerLog
  - Return activated slice or null if none pending
- [ ] Add auto-advance logic:
  - Listen to `store.on("task:moved")` for tasks moving to "done"
  - When a done task has `sliceId`, call MissionStore to update linked feature status
  - If all features in slice are done, mark slice complete
  - If slice completes and autoAdvance is enabled, activate next pending slice

**Artifacts:**
- `packages/engine/src/scheduler.ts` (modified)

### Step 5: Executor Mission Progress Updates

- [ ] Modify `packages/engine/src/executor.ts` to integrate with MissionStore:
  - Accept optional `missionStore?: MissionStore` in TaskExecutorOptions
  - On task completion (when task moves to "in-review"), check if task has `sliceId`
  - If linked to slice, call `missionStore.computeSliceStatus(sliceId)` to update status
  - If slice becomes complete, log milestone progress via executorLog
- [ ] Add `onSliceComplete?: (slice: Slice) => void` callback to TaskExecutorOptions
  - Called when a slice's status transitions to "complete"
  - Allows scheduler to handle auto-advance

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 6: Engine Integration Wiring

- [ ] Update `packages/engine/src/index.ts`:
  - Export Mission-aware scheduler options type
  - Ensure all necessary types are exported for CLI usage
- [ ] Verify MissionStore is properly exported from `@fusion/core`
- [ ] Add changeset for engine changes:
  ```bash
  cat > .changeset/missions-engine-integration.md << 'EOF'
  ---
  "@fusion/engine": minor
  ---

  Add MissionStore integration to scheduler and executor. Supports automatic slice activation and milestone advancement when linked tasks complete.
  EOF
  ```

**Artifacts:**
- `packages/engine/src/index.ts` (modified)
- `.changeset/missions-engine-integration.md` (new)

### Step 7: Mission CLI Tests

- [ ] Create `packages/cli/src/commands/mission.test.ts` with tests:
  - Test `runMissionCreate` creates mission with correct data
  - Test `runMissionList` displays missions in formatted output
  - Test `runMissionShow` displays hierarchy correctly
  - Test `runMissionDelete` requires confirmation without --force
  - Test `runMissionActivateSlice` calls MissionStore.activateSlice()
- [ ] Use temporary database for tests (follow patterns from task.test.ts)
- [ ] Mock console.log to capture output assertions
- [ ] Import { describe, it, expect, beforeEach, afterEach } from vitest

**Artifacts:**
- `packages/cli/src/commands/mission.test.ts` (new)

### Step 8: Pi Extension Mission Tools Tests

- [ ] Add tests to `packages/cli/src/__tests__/extension.test.ts`:
  - Test kb_mission_create tool executes and returns mission data
  - Test kb_mission_list returns formatted list
  - Test kb_slice_activate updates slice status
  - Test kb_feature_link_task links feature to task
- [ ] Mock MissionStore methods for unit testing
- [ ] Verify tool parameter validation works correctly

**Artifacts:**
- `packages/cli/src/__tests__/extension.test.ts` (modified)

### Step 9: Scheduler Mission Integration Tests

- [ ] Add tests to `packages/engine/src/scheduler.test.ts`:
  - Test auto-advance when linked task completes
  - Test slice status update triggers on task:moved to done
  - Test activateNextPendingSlice finds and activates correct slice
  - Test no auto-advance when mission not in active state
- [ ] Mock MissionStore for scheduler tests
- [ ] Verify event handlers are properly registered and cleaned up

**Artifacts:**
- `packages/engine/src/scheduler.test.ts` (modified)

### Step 10: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in packages/cli — all tests pass
- [ ] Run `pnpm test` in packages/engine — all tests pass
- [ ] Run `pnpm typecheck` in all packages — zero errors
- [ ] Run `pnpm build` — successful compilation
- [ ] Test CLI commands manually:
  ```bash
  fn mission create "Test Mission" "Test description"
  fn mission list
  fn mission show M-001
  ```

### Step 11: Documentation & Delivery

- [ ] Update CLI HELP text in `bin.ts` with mission command documentation
- [ ] Add changeset for CLI changes:
  ```bash
  cat > .changeset/missions-cli-commands.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---

  Add mission management commands: `fn mission create`, `list`, `show`, `delete`, `activate-slice`. Extend pi extension with mission tools for chat-based mission creation and slice activation.
  EOF
  ```
- [ ] Verify pi extension tools appear in tool list and have proper descriptions
- [ ] Create any out-of-scope findings as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` HELP text — Add mission commands section
- Changeset files for minor version bumps

**Check If Affected:**
- `AGENTS.md` — Document mission-related tools for AI agents if patterns differ significantly

## Completion Criteria

- [ ] All 11 steps complete
- [ ] CLI commands working: `fn mission create`, `list`, `show`, `delete`, `activate-slice`
- [ ] Pi extension tools registered: kb_mission_create, kb_mission_list, kb_mission_show, kb_milestone_add, kb_slice_add, kb_feature_add, kb_slice_activate, kb_feature_link_task
- [ ] Scheduler integrates with MissionStore for auto-advance
- [ ] Executor updates slice status on task completion
- [ ] All tests passing (new + existing)
- [ ] Typecheck passing
- [ ] Changesets created for affected packages
- [ ] Help text updated with mission commands

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-635): complete Step N — description`
- **Bug fixes:** `fix(KB-635): description`
- **Tests:** `test(KB-635): description`
- **Changesets:** `chore(KB-635): add changeset for mission integration`

## Do NOT

- Skip tests for CLI commands or scheduler integration
- Modify existing task management behavior (preserve backward compatibility)
- Skip error handling in interactive prompts
- Forget to update HELP text when adding commands
- Skip MissionStore initialization checks (verify KB-632 is complete first)
- Modify dashboard code (handled in separate task KB-634)
- Break existing task scheduling logic when adding mission awareness
- Skip the MissionStore export verification in core package
