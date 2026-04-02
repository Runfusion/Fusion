# Task: KB-273 - Update the readme with all of the new features we added

**Created:** 2026-03-31
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a documentation-only task updating README.md with known features. Low risk, but must be comprehensive.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Update the main README.md to comprehensively document all new features added since the last documentation pass. The README is the primary entry point for users and must accurately reflect the full feature set including model presets, planning mode, workflow steps, GitHub enhancements, interactive terminal, git commands, and all settings options.

## Dependencies

- **None**

## Context to Read First

1. `README.md` — Current README to understand existing structure and identify gaps
2. `AGENTS.md` — Internal documentation with detailed feature descriptions that should be summarized for users
3. `.changeset/*.md` — Review recent changesets to identify features not yet in README

Key feature areas to document:
- Model system (presets, per-task overrides, global/project settings hierarchy)
- Planning mode and subtask breakdown
- Workflow steps and templates
- GitHub integration (PR import, badges, webhooks)
- Interactive terminal and Git Manager
- CLI enhancements (git commands, pr-create, task plan)
- Settings (stuck task detection, smart conflict resolution, ntfy, themes)
- Archive functionality
- Activity log
- Multi-step scheduled tasks

## File Scope

- `README.md` (modified — comprehensive update)

## Steps

### Step 0: Preflight

- [ ] Read current README.md to understand existing sections
- [ ] Read AGENTS.md sections on model presets, workflow steps, planning mode
- [ ] Review recent changesets in `.changeset/` for feature completeness
- [ ] Identify all features missing or under-documented in README

### Step 1: Add Model System Section

- [ ] Add new "Model System" section after "Workflow" or within "Configuration"
- [ ] Document model presets (Budget/Normal/Complex with auto-selection by task size)
- [ ] Document per-task model overrides (executor and validator models)
- [ ] Document global vs project settings hierarchy
- [ ] Document planning and validator model settings

### Step 2: Expand GitHub Integration Section

- [ ] Add PR import to existing GitHub import documentation
- [ ] Document GitHub badges on cards with real-time updates
- [ ] Document `pr-create` CLI command
- [ ] Document PR-first auto-completion mode
- [ ] Document PR comment monitoring with steering comments

### Step 3: Add Task Planning & Creation Section

- [ ] Add "Task Planning & Creation" section
- [ ] Document Planning Mode (`kb task plan`, dashboard Plan button)
- [ ] Document subtask breakdown dialog with drag-and-drop
- [ ] Document AI text refinement in task creation
- [ ] Document manual plan approval setting (`requirePlanApproval`)

### Step 4: Add Workflow Steps Section

- [ ] Add "Workflow Steps" section documenting quality gates
- [ ] Document how to define and enable workflow steps
- [ ] Document built-in templates (Documentation Review, QA Check, Security Audit, Performance Review, Accessibility Check)
- [ ] Document workflow results viewer in task detail modal

### Step 5: Expand Dashboard Features Section

- [ ] Document interactive terminal (PTY-based, xterm.js, WebSocket)
- [ ] Document Git Manager (commit view, diffs, branch management)
- [ ] Document Activity Log (task lifecycle events, settings changes)
- [ ] Document search in board view
- [ ] Document column visibility toggle and grouping in list view
- [ ] Document archive functionality
- [ ] Document inline editing and duplicate task button
- [ ] Document theme system (light/dark modes, 8+ color themes)

### Step 6: Expand CLI Commands Section

- [ ] Add `kb git` subcommands (status, push, pull, fetch)
- [ ] Add `kb task plan` command
- [ ] Add `kb task pr-create` command
- [ ] Add `kb task archive` and `kb task unarchive` commands
- [ ] Add `kb task duplicate` command
- [ ] Add `kb task retry` command
- [ ] Add `kb task steer` command
- [ ] Add `kb task logs` command with filter options
- [ ] Document dashboard flags: `--dev`, `--paused`, `--interactive`

### Step 7: Add Configuration Reference Section

- [ ] Add comprehensive settings reference table
- [ ] Document `autoResolveConflicts` / `smartConflictResolution`
- [ ] Document `taskStuckTimeoutMs` (stuck task detection)
- [ ] Document `ntfyEnabled` and `ntfyTopic` (push notifications)
- [ ] Document `worktreeNaming` (random, task-id, task-title)
- [ ] Document `requirePlanApproval`
- [ ] Document `recycleWorktrees`
- [ ] Document `groupOverlappingFiles`
- [ ] Document theme and color theme settings

### Step 8: Add Multi-Step Scheduled Tasks Section

- [ ] Document scheduled tasks with multiple steps
- [ ] Document command steps and AI prompt steps
- [ ] Document per-step timeout overrides and continue-on-failure

### Step 9: Testing & Verification

> ZERO broken links or formatting errors allowed.

- [ ] Verify all markdown renders correctly (no broken tables, lists, or code blocks)
- [ ] Verify all CLI commands documented match actual commands in `packages/cli/src/bin.ts`
- [ ] Verify all settings documented exist in the codebase
- [ ] Run `pnpm typecheck` to ensure no broken references
- [ ] Verify README mermaid diagram still renders correctly

### Step 10: Documentation & Delivery

- [ ] Create changeset file for README update (patch level — documentation improvement)
- [ ] Out-of-scope: Update CHANGELOG.md (handled by changesets release process)
- [ ] Final review of README for completeness

## Documentation Requirements

**Must Update:**
- `README.md` — Add all sections identified in Steps 1-8, ensuring comprehensive feature coverage

**Check If Affected:**
- None (focused README update)

## Completion Criteria

- [ ] All steps complete
- [ ] All new major features documented in README
- [ ] No broken markdown or formatting errors
- [ ] Changeset file created
- [ ] Typecheck passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-273): complete Step N — description`
- **Bug fixes:** `fix(KB-273): description`

## Do NOT

- Remove existing content unless it's factually incorrect
- Add internal implementation details or code architecture not relevant to users
- Document features that are still experimental or not yet released
- Change the overall README structure dramatically — enhance within existing flow
- Skip documenting any feature listed in the changesets since last README update
