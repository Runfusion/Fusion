# Task: KB-628d - CLI Commands, Pi Extension, and Engine Integration

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This integrates the Missions system into the CLI, pi extension, and engine scheduler. CLI commands must follow existing patterns, pi tools must be discoverable, and engine integration requires careful scheduler modification.

**Score:** 5/8 — Blast radius: 2 (touches scheduler, CLI, extension), Pattern novelty: 1 (follows existing patterns), Security: 1 (standard patterns), Reversibility: 1 (can disable)

## Mission

Integrate the Missions system into the CLI with mission management commands, extend the pi extension with mission tools for chat-based interaction, and modify the engine scheduler to handle slice activation and auto-advance. This makes missions accessible across all kb interfaces and enables the automation layer.

## Dependencies

- **Task:** KB-628a — Database Schema, Types, and MissionStore
  - MissionStore with all operations
  - Mission types and status enums
- **Task:** KB-628b — Mission REST API and Interview System
  - API patterns for reference

## Context to Read First

1. `packages/cli/src/bin.ts` — Study CLI command structure, argument parsing, and help text
2. `packages/cli/src/commands/task.ts` — Review command handler patterns (runTaskCreate, runTaskList, etc.)
3. `packages/cli/src/extension.ts` — Study pi extension tool definitions and registration
4. `packages/engine/src/scheduler.ts` — Understand scheduler polling, task selection, and lifecycle management
5. `packages/engine/src/scheduler.test.ts` — Review scheduler tests
6. `packages/core/src/mission-store.ts` (from KB-628a) — Reference MissionStore methods

## File Scope

**New Files:**
- `packages/cli/src/commands/mission.ts` — CLI command handlers for missions

**Modified Files:**
- `packages/cli/src/bin.ts` — Register mission CLI commands
- `packages/cli/src/extension.ts` — Add mission tools for pi extension
- `packages/engine/src/scheduler.ts` — Add slice activation and auto-advance logic
- `packages/engine/src/scheduler.test.ts` — Add tests for mission integration

## Steps

### Step 1: CLI Mission Command Structure

- [ ] Create `packages/cli/src/commands/mission.ts`:
  - Import MissionStore from `@fusion/core`
  - Import necessary types
  - Set up command handler functions
- [ ] Define command handlers:
  - `runMissionCreate(args: string[]): Promise<void>`
  - `runMissionList(): Promise<void>`
  - `runMissionShow(args: string[]): Promise<void>`
  - `runMissionActivate(args: string[]): Promise<void>`
  - `runMissionDelete(args: string[]): Promise<void>`
  - `runMissionAddMilestone(args: string[]): Promise<void>`
  - `runMissionAddSlice(args: string[]): Promise<void>`
  - `runMissionAddFeature(args: string[]): Promise<void>`
- [ ] Follow patterns from `commands/task.ts`:
  - Table formatting for lists
  - Pretty printing for details
  - Error handling with process.exit(1)
  - Confirm prompts for destructive actions

**Artifacts:**
- `packages/cli/src/commands/mission.ts` (new — skeleton)

### Step 2: CLI Mission Create Command

- [ ] Implement `runMissionCreate(args: string[])`:
  - Parse args: `[title]` optional
  - If title provided: create mission directly
  - If no title: prompt interactively
  - Use MissionStore.createMission()
  - Output: "Created mission KB-M-001: [title]"
  - Return mission ID for chaining
- [ ] Interactive prompts:
  - "Mission title:" (required)
  - "Description:" (optional, multiline)
  - Confirm creation
- [ ] Error handling:
  - Validate title not empty
  - Handle database errors gracefully

**Artifacts:**
- `packages/cli/src/commands/mission.ts` (expanded)

### Step 3: CLI Mission List Command

- [ ] Implement `runMissionList()`:
  - Fetch all missions from MissionStore
  - Format as table:
    - ID | Title | Status | Milestones | Progress
  - Progress format: "2/5 complete" or percentage
  - Color-code status (green=active, gray=planning, purple=complete)
  - Handle empty list: "No missions found. Create one with 'fn mission create'"
- [ ] Sorting:
  - Default: by createdAt desc (newest first)
  - Active missions first, then by status

**Artifacts:**
- `packages/cli/src/commands/mission.ts` (expanded)

### Step 4: CLI Mission Show Command

- [ ] Implement `runMissionShow(args: string[])`:
  - Parse args: `<mission-id>` required
  - Fetch mission with hierarchy from MissionStore
  - Pretty print mission details:
    - Header: ID, Title, Status, Created
    - Description (if present)
    - Milestones section with tree view
    - Each milestone shows slices
    - Each slice shows features and linked tasks
  - Use indentation for hierarchy
  - Color coding for status
  - Progress bars in terminal (unicode blocks)
- [ ] Error handling:
  - Show error if mission not found
  - Suggest similar mission IDs

**Artifacts:**
- `packages/cli/src/commands/mission.ts` (expanded)

### Step 5: CLI Mission Activate Command

- [ ] Implement `runMissionActivate(args: string[])`:
  - Parse args: `<slice-id>` required
  - Find slice by ID in MissionStore
  - Confirm activation with user:
    - "This will activate slice 'X' and create Y tasks in triage. Continue?"
  - Call MissionStore.activateSlice()
  - Output:
    - "Activated slice KB-S-003"
    - "Created tasks: KB-101, KB-102, KB-103"
    - Tasks link to their features
- [ ] Related command `runMissionAddMilestone(args: string[])`:
  - Parse: `<mission-id> <title>`
  - Add milestone to mission
  - Output: "Added milestone KB-ML-004 to mission KB-M-001"
- [ ] Related command `runMissionAddSlice(args: string[])`:
  - Parse: `<milestone-id> <title>`
  - Add slice to milestone
- [ ] Related command `runMissionAddFeature(args: string[])`:
  - Parse: `<slice-id> <description>`
  - Add feature to slice

**Artifacts:**
- `packages/cli/src/commands/mission.ts` (expanded)

### Step 6: CLI Mission Delete Command

- [ ] Implement `runMissionDelete(args: string[])`:
  - Parse args: `<mission-id>` required, `[--force]` optional
  - Show warning: "This will delete the mission and all milestones, slices, and features."
  - If `--force` flag: skip confirmation
  - Otherwise: prompt "Type the mission ID to confirm:"
  - Call MissionStore.deleteMission()
  - Output: "Deleted mission KB-M-001 and all associated data"
- [ ] Error handling:
  - Handle mission not found
  - Handle active slices (warn that linked tasks remain)

**Artifacts:**
- `packages/cli/src/commands/mission.ts` (complete)

### Step 7: Register CLI Commands in bin.ts

- [ ] Modify `packages/cli/src/bin.ts`:
  - Import all mission command handlers
  - Add mission section to HELP text:
    ```
    fn mission create [title]          Create a new mission
    fn mission list                     List all missions
    fn mission show <id>                Show mission details with hierarchy
    fn mission activate <slice-id>      Activate slice (creates tasks)
    fn mission add-milestone <mission> <title>   Add milestone to mission
    fn mission add-slice <milestone> <title>     Add slice to milestone
    fn mission add-feature <slice> <desc>        Add feature to slice
    fn mission delete <id> [--force]    Delete mission and all data
    ```
- [ ] Add command routing in main switch statement:
  - `case "mission":` → route to mission subcommand handler
  - Handle "create", "list", "show", "activate", "delete" subcommands
  - Handle "add-milestone", "add-slice", "add-feature" subcommands
- [ ] Error handling for unknown subcommands

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 8: Pi Extension Mission Tools

- [ ] Modify `packages/cli/src/extension.ts`:
  - Import MissionStore and mission types
  - Add mission tool definitions to `tools` array
- [ ] Define `mission_create` tool:
  - Description: "Create a new mission for large-scale project planning"
  - Parameters: `title` (required), `description` (optional)
  - Returns: Created mission details
- [ ] Define `mission_list` tool:
  - Description: "List all missions with their current status and progress"
  - Parameters: none (or optional filter)
  - Returns: Array of mission summaries
- [ ] Define `mission_show` tool:
  - Description: "Show detailed information about a mission including milestones, slices, and features"
  - Parameters: `missionId` (required)
  - Returns: Full mission hierarchy
- [ ] Define `mission_add_milestone` tool:
  - Description: "Add a milestone to an existing mission"
  - Parameters: `missionId`, `title`, `description`
- [ ] Define `mission_add_slice` tool:
  - Description: "Add a slice to a milestone"
  - Parameters: `milestoneId`, `title`, `description`
- [ ] Define `mission_activate_slice` tool:
  - Description: "Activate a slice to create tasks in triage"
  - Parameters: `sliceId` (required)
  - Returns: List of created task IDs
- [ ] All tools follow existing tool definition pattern with:
  - `name`, `description`, `parameters` (JSON Schema)
  - `execute` function
  - Error handling

**Artifacts:**
- `packages/cli/src/extension.ts` (modified)

### Step 9: Update Pi Extension Prompt Snippet

- [ ] Modify `promptSnippet` in `extension.ts`:
  - Add mission system description to the context
  - Include line: "You can help users plan large-scale work using Missions, which break down into Milestones → Slices → Features → Tasks."
  - List mission tools available
  - Describe when to use missions vs. regular tasks
  - Example: "Use missions for multi-week initiatives. Use regular tasks for single work items."
- [ ] Update `promptGuidelines`:
  - Add guideline: "When the user describes a large initiative spanning multiple weeks, suggest creating a mission."
  - Add guideline: "Help users break down missions by interviewing them about scope and constraints."

**Artifacts:**
- `packages/cli/src/extension.ts` (modified)

### Step 10: Engine Scheduler — Slice Activation Hook

- [ ] Modify `packages/engine/src/scheduler.ts`:
  - Import MissionStore from `@fusion/core`
  - Add `missionStore` private property
  - Initialize MissionStore in constructor or init method
- [ ] Add slice activation check:
  - `checkSliceActivation(): void` method
  - Called during scheduler polling cycle
  - Finds slices with status "pending" where predecessor is complete
  - Activates eligible slices
- [ ] Integration with task creation:
  - When tasks are created from features, set `task.missionId` and `task.sliceId`
  - Link feature to task via `linkFeatureToTask`
- [ ] Add event listener:
  - Listen for "slice:activated" events from MissionStore
  - Log to activity log

**Artifacts:**
- `packages/engine/src/scheduler.ts` (modified)

### Step 11: Engine Scheduler — Auto-Advance Logic

- [ ] Implement slice completion detection:
  - `checkSliceCompletion(sliceId: string): boolean` method
  - Fetches all tasks linked to slice via `sliceId` column
  - Returns true if all tasks have `column === "done"`
  - Returns false if any task is not done (including archived)
- [ ] Implement auto-advance:
  - `autoAdvanceSlice(completedSliceId: string): void` method
  - Finds next slice in milestone (by orderIndex)
  - Calls `activateSlice()` on next slice
  - Logs: "Auto-advanced from slice X to slice Y"
  - Emits event for notifications
- [ ] Hook into task lifecycle:
  - When task moves to "done", check if it's part of a slice
  - If slice tasks all complete, trigger auto-advance
  - Rate limit checks (don't check every poll, throttle)
- [ ] Milestone completion:
  - When all slices in milestone complete, update milestone status
  - Trigger mission status rollup

**Artifacts:**
- `packages/engine/src/scheduler.ts` (modified)

### Step 12: Engine Scheduler — Mission Status Rollup

- [ ] Add status rollup triggers:
  - `updateSliceStatusFromTasks(sliceId: string): void`
  - Called when tasks linked to slice change status
  - Updates slice status based on linked tasks
- [ ] Add milestone status update:
  - `updateMilestoneStatus(milestoneId: string): void`
  - Calls MissionStore.computeMilestoneStatus()
  - Updates milestone status if changed
- [ ] Add mission status update:
  - `updateMissionStatus(missionId: string): void`
  - Calls MissionStore.computeMissionStatus()
  - Updates mission status if changed
- [ ] Cascading updates:
  - Task done → check slice → update slice status → check milestone → update mission
  - All updates logged to activity log

**Artifacts:**
- `packages/engine/src/scheduler.ts` (modified)

### Step 13: Engine Scheduler Tests

- [ ] Modify `packages/engine/src/scheduler.test.ts`:
  - Add tests for slice activation hook
  - Add tests for auto-advance logic
  - Add tests for status rollup
- [ ] Test scenarios:
  - Task completion triggers slice status check
  - All tasks done triggers auto-advance
  - Next slice activates with tasks created
  - Status propagates up hierarchy
  - No auto-advance if next slice already active
- [ ] Mock MissionStore for tests
- [ ] Ensure all existing scheduler tests still pass

**Artifacts:**
- `packages/engine/src/scheduler.test.ts` (modified)

### Step 14: CLI Command Tests

- [ ] Create `packages/cli/src/commands/mission.test.ts`:
  - Test mission create command
  - Test mission list command (table output)
  - Test mission show command (hierarchy display)
  - Test mission activate command
  - Test mission delete command (with --force and interactive)
- [ ] Mock MissionStore for tests
- [ ] Mock console output for verification
- [ ] Test error cases:
  - Mission not found
  - Invalid arguments
  - Database errors

**Artifacts:**
- `packages/cli/src/commands/mission.test.ts` (new)

### Step 15: Testing & Verification

> ZERO test failures allowed.

- [ ] Test CLI commands manually:
  - `fn mission create "Test Mission"`
  - `fn mission list`
  - `fn mission show KB-M-001`
  - `fn mission add-milestone KB-M-001 "Milestone 1"`
  - `fn mission add-slice KB-ML-001 "Slice 1"`
  - `fn mission add-feature KB-S-001 "Feature description"`
  - `fn mission activate KB-S-001`
  - `fn mission delete KB-M-001 --force`
- [ ] Test pi extension tools manually (if possible)
- [ ] Test scheduler integration:
  - Create mission with slice and features
  - Activate slice → tasks created
  - Complete all tasks → verify auto-advance
- [ ] Run `pnpm test` in all affected packages
- [ ] Run `pnpm typecheck` — zero errors
- [ ] Run `pnpm build` — successful

### Step 16: Documentation & Delivery

- [ ] Update CLI help text if needed
- [ ] Create changeset file:
  ```bash
  cat > .changeset/missions-cli-and-engine.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  "@fusion/engine": minor
  ---
  
  Add Mission CLI commands (`fn mission`), pi extension tools, and engine scheduler integration with auto-advance.
  EOF
  ```
- [ ] Add JSDoc comments to all CLI handlers
- [ ] Commit: `feat(KB-628d): complete Mission CLI, Pi Extension, and Engine Integration`

## Documentation Requirements

**Must Update:**
- Changeset file as shown above

**Check If Affected:**
- `AGENTS.md` — Consider adding mission system to agent documentation

## Completion Criteria

- [ ] All 16 steps complete
- [ ] CLI mission commands working (create, list, show, activate, delete)
- [ ] Pi extension mission tools defined
- [ ] Scheduler slice activation and auto-advance working
- [ ] Status rollup propagating through hierarchy
- [ ] All tests passing (existing + new)
- [ ] Typecheck passing
- [ ] Changeset created

## Git Commit Convention

- **Step completion:** `feat(KB-628d): complete Step N — description`
- **Bug fixes:** `fix(KB-628d): description`
- **Tests:** `test(KB-628d): description`

## Do NOT

- Skip CLI confirmation prompts for destructive actions
- Skip error handling in CLI commands
- Modify existing scheduler task selection logic beyond adding mission hooks
- Skip pi extension tool definitions
- Skip scheduler tests
- Modify existing CLI command behavior
- Forget to update help text in bin.ts
