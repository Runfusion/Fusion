# Task: KB-619 - CLI Multi-Project Commands

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This adds significant new CLI surface area with 6+ commands and cross-cutting `--project` flag integration across all existing commands. The project resolution logic is complex with fallback chains. Requires plan review and code review for correctness and consistency with existing CLI patterns.
**Score:** 6/8 — Blast radius: 2 (modifies all task/settings commands), Pattern novelty: 1 (follows existing CLI patterns), Security: 1 (project path validation needed), Reversibility: 2 (additive changes, no schema changes)

## Mission

Add comprehensive CLI support for multi-project management, allowing users to register multiple kb projects and work with them from any directory. This includes:

1. **Project subcommands** (`fn project list|add|remove|info`) for managing the project registry
2. **Global `--project` flag** on all task and settings commands to target a specific project
3. **Auto-detection** that walks up from cwd to find `.fusion/` and matches against registered projects
4. **Interactive prompts** for project selection when ambiguous

This work depends on KB-616 (ProjectRuntime/ProjectManager) which provides the engine-side abstractions for managing multiple projects.

## Dependencies

- **Task:** KB-616 (Per-Project Runtime Abstraction must be complete — provides ProjectManager API)
- **Task:** KB-615 (Multi-Project Core Infrastructure — provides CentralCore with project registry)

## Context to Read First

- `packages/cli/src/bin.ts` — CLI entry point with command dispatch patterns
- `packages/cli/src/commands/task.ts` — Task command implementations and `getStore()` pattern
- `packages/cli/src/commands/settings.ts` — Settings commands and validation patterns
- `packages/cli/src/commands/git.ts` — Example of interactive prompts (readline interface)
- `packages/cli/src/commands/settings.test.ts` — Testing patterns with vitest mocks
- `packages/engine/src/project-manager.ts` — ProjectManager API (from KB-616)
- `packages/core/src/central-core.ts` — CentralCore API with project registry (from KB-615)
- `packages/core/src/types.ts` — Project types and interfaces

## File Scope

- `packages/cli/src/commands/project.ts` (new — all project subcommand implementations)
- `packages/cli/src/project-resolver.ts` (new — cwd auto-detection and project resolution)
- `packages/cli/src/bin.ts` (modified — add project subcommand dispatch, --project flag parsing)
- `packages/cli/src/commands/task.ts` (modified — add --project flag support to all task commands)
- `packages/cli/src/commands/settings.ts` (modified — add --project flag support)
- `packages/cli/src/commands/project.test.ts` (new — unit tests for project commands)
- `packages/cli/src/project-resolver.test.ts` (new — unit tests for resolver logic)

## Steps

### Step 1: Project Resolution Module

Create the core project resolution logic that determines which project to use based on cwd, explicit flags, and registry.

- [ ] Create `packages/cli/src/project-resolver.ts`:
  - `getCentralCore()` — Initialize and return CentralCore singleton
  - `findKbDir(startPath: string): string | null` — Walk up from path to find `.fusion/` directory
  - `resolveProject(options: { project?: string; cwd?: string }): Promise<ResolvedProject>`:
    1. If `--project <name>` flag given, look up by name in registry (error if not found)
    2. Walk up from cwd to find `.fusion/` directory
    3. If found, match path against registered projects (use if found)
    4. If not registered but has `.fusion/`, prompt to register or error
    5. If no `.fusion/` found and exactly one project registered, use it as default
    6. If multiple projects and no match, error with list of registered projects
  - `ResolvedProject` interface with `projectId`, `name`, `directory`, `runtime`, `store`
  - `ProjectResolutionError` class for specific error types with actionable messages
  - Interactive prompt helper for project selection when ambiguous (use readline like git.ts)
- [ ] Handle edge cases:
  - Project directory moved (path mismatch) — suggest re-registering
  - Project deleted — error with cleanup suggestion
  - No projects registered — guide user to `fn project add`
- [ ] Run typecheck to verify no errors

**Artifacts:**
- `packages/cli/src/project-resolver.ts` (new)

### Step 2: Project Subcommands

Implement all `fn project *` commands in a single module following the existing CLI patterns.

- [ ] Create `packages/cli/src/commands/project.ts` with these exports:
  - `runProjectList(options: { json?: boolean })`:
    - Fetch all projects from CentralCore registry
    - Get runtime status from ProjectManager for each project
    - Get task counts by column from each project's TaskStore
    - Get last activity timestamp (from runtime metrics or most recent task log)
    - Format as table: name, directory, status (active/paused/errored/stopped), in-flight tasks, last activity
    - Sort by name alphabetically
    - Handle `--json` flag for machine-readable output
    - Empty state message when no projects registered
  - `runProjectAdd(dir?: string, options: { name?: string; isolation?: "in-process" | "child-process" })`:
    - Interactive wizard if no directory: prompt for path, suggest name from directory basename
    - Resolve directory path (absolute, validate exists)
    - Check for `.fusion/` directory: if missing, prompt to run `fn init` first or offer auto-init
    - Auto-detect name from directory if not provided
    - Validate name is unique in registry
    - Call `centralCore.registerProject({ name, directory, isolationMode })`
    - Output success with project summary
  - `runProjectRemove(name: string, options: { force?: boolean })`:
    - Find project by name in registry (error if not found)
    - If active runtime, stop it first via `projectManager.removeProject()`
    - Confirmation prompt unless `--force` flag
    - Call `centralCore.unregisterProject(name)`
    - Clarify in output that data is preserved, only registry entry removed
  - `runProjectInfo(name?: string)`:
    - If no name given, resolve via project resolver (cwd detection)
    - Show: name, directory, isolation mode, status, task counts by column, active agents, last activity
    - Format with clear sections and alignment
- [ ] Add helper functions for table formatting (reuse patterns from task.ts if possible)
- [ ] Add JSON output helper for `--json` flag consistency
- [ ] Run typecheck

**Artifacts:**
- `packages/cli/src/commands/project.ts` (new)

### Step 3: Update CLI Entry Point

Modify `bin.ts` to add the project subcommand and global `--project` flag support.

- [ ] Modify `packages/cli/src/bin.ts`:
  - Add `import { runProjectList, runProjectAdd, runProjectRemove, runProjectInfo } from "./commands/project.js"`
  - Add `import { resolveProject } from "./project-resolver.js"`
  - Update `HELP` text to include project commands section
  - Add `case "project":` dispatch with subcommand handling:
    - `list`: parse `--json` flag, call `runProjectList()`
    - `add`: parse optional directory, `--name`, `--isolation` flags, call `runProjectAdd()`
    - `remove`: parse `<name>`, `--force` flag, call `runProjectRemove()`
    - `info`: parse optional `[name]`, call `runProjectInfo()`
  - Add global `--project` flag parsing early in `main()`:
    - Extract `--project <name>` before command dispatch
    - Store in `process.env.FN_PROJECT` or global context for subcommands to access
- [ ] Ensure error handling for unknown project subcommands
- [ ] Run typecheck

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 4: Add --project Flag to Task Commands

Modify all task commands to accept and use `--project` flag via the project resolver.

- [ ] Modify `packages/cli/src/commands/task.ts`:
  - Replace `getStore()` pattern with `getStore(options?: { project?: string })`
  - New `getStore()` implementation:
    - Call `resolveProject(options)` to get resolved project
    - Return `resolvedProject.store` (TaskStore already initialized)
  - Update all exported functions to accept optional project parameter:
    - `runTaskCreate(desc?, attach?, deps?, options?: { project?: string })`
    - `runTaskList(options?: { project?: string; json?: boolean })` — also add `--json` support
    - `runTaskShow(id, options?: { project?: string })`
    - `runTaskMove(id, column, options?: { project?: string })`
    - `runTaskUpdate(id, step, status, options?: { project?: string })`
    - `runTaskLog(id, message, options?: { project?: string })`
    - `runTaskLogs(id, options?: { project?: string; follow?; limit?; type? })`
    - `runTaskMerge(id, options?: { project?: string })`
    - `runTaskDuplicate(id, options?: { project?: string })`
    - `runTaskRefine(id, feedback?, options?: { project?: string })`
    - `runTaskArchive(id, options?: { project?: string })`
    - `runTaskUnarchive(id, options?: { project?: string })`
    - `runTaskDelete(id, force?, options?: { project?: string })`
    - `runTaskAttach(id, file, options?: { project?: string })`
    - `runTaskPause(id, options?: { project?: string })`
    - `runTaskUnpause(id, options?: { project?: string })`
    - `runTaskRetry(id, options?: { project?: string })`
    - `runTaskComment(id, message?, options?: { project?: string; author?: string })`
    - `runTaskComments(id, options?: { project?: string })`
    - `runTaskSteer(id, message?, options?: { project?: string })`
    - `runTaskPrCreate(id, options?: { project?: string; title?; base?; body? })`
    - `runTaskPlan(initialPlan?, yesFlag?, options?: { project?: string })`
    - `runTaskImportFromGitHub(ownerRepo, options?: { project?: string; limit?; labels? })`
    - `runTaskImportGitHubInteractive(ownerRepo, options?: { project?: string; limit?; labels? })`
  - Maintain backward compatibility: all new parameters optional, defaults to cwd-based resolution
- [ ] Update `bin.ts` task command dispatch to parse `--project` flag and pass to handlers
- [ ] Run typecheck

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)
- `packages/cli/src/bin.ts` (modified — task dispatch updates)

### Step 5: Add --project Flag to Settings Commands

Modify settings commands to support `--project` flag.

- [ ] Modify `packages/cli/src/commands/settings.ts`:
  - Update `getStore()` to accept optional project parameter (same pattern as task.ts)
  - Update `runSettingsShow(options?: { project?: string })`
  - Update `runSettingsSet(key, value, options?: { project?: string })`
  - Settings are project-specific, so this targets the resolved project's settings
- [ ] Update `bin.ts` settings command dispatch to parse `--project` flag
- [ ] Run typecheck

**Artifacts:**
- `packages/cli/src/commands/settings.ts` (modified)
- `packages/cli/src/bin.ts` (modified — settings dispatch updates)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `packages/cli/src/project-resolver.test.ts`:
  - Test `findKbDir()` with various directory structures
  - Test `resolveProject()` with all resolution paths:
    - Explicit `--project` flag
    - Cwd auto-detection with matching registered project
    - Cwd with `.fusion/` but not registered
    - No `.fusion/` with single project (default)
    - No `.fusion/` with multiple projects (error)
  - Test error cases: project not found, directory moved, no projects registered
  - Mock CentralCore and ProjectManager for isolation
- [ ] Create `packages/cli/src/commands/project.test.ts`:
  - Test `runProjectList()`:
    - Table output formatting
    - JSON output with `--json`
    - Empty state
    - Status indicators (active/paused/errored)
  - Test `runProjectAdd()`:
    - With explicit directory and name
    - Interactive mode (mock readline)
    - Missing `.fusion/` handling
    - Duplicate name validation
  - Test `runProjectRemove()`:
    - Confirmation prompt (mock readline)
    - `--force` skip confirmation
    - Stop runtime before unregister
  - Test `runProjectInfo()`:
    - With explicit name
    - With cwd resolution
    - Output formatting
  - Mock all CentralCore and ProjectManager interactions
- [ ] Run full CLI test suite: `pnpm test -- packages/cli/`
  - Ensure existing tests still pass
  - Fix any regressions in task/settings commands
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Build the CLI package: `pnpm build`

**Test Coverage Requirements:**
- Project resolver: all resolution paths and error cases
- Project commands: all subcommands with flags and options
- Integration: verify existing task/settings commands work with and without `--project`

### Step 7: Documentation & Delivery

- [ ] Update HELP text in `bin.ts` with new project commands section
- [ ] Add JSDoc to all public functions in `project.ts` and `project-resolver.ts`
- [ ] Create changeset for the new multi-project CLI feature:
  ```bash
  cat > .changeset/add-cli-multi-project-commands.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---

  Add CLI multi-project commands and --project flag support.

  New commands:
  - `fn project list [--json]` — List all registered projects
  - `fn project add [dir] [--name <name>] [--isolation <mode>]` — Register a project
  - `fn project remove <name> [--force]` — Unregister a project
  - `fn project info [name]` — Show project details

  All task and settings commands now support `--project <name>` flag:
  - `fn task list --project myapp`
  - `fn settings --project myapp`

  Projects are auto-detected from cwd by walking up to find `.fusion/`.
  EOF
  ```
- [ ] Stage changeset with code changes
- [ ] Out-of-scope findings: create follow-up tasks if needed

**Artifacts:**
- `.changeset/add-cli-multi-project-commands.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — HELP text with project commands
- `packages/cli/src/commands/project.ts` — JSDoc for all exported functions
- `packages/cli/src/project-resolver.ts` — JSDoc explaining resolution algorithm

**Check If Affected:**
- `AGENTS.md` — Update if CLI documentation section exists
- `README.md` — May need basic project management documentation

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (zero failures in CLI package)
- [ ] TypeScript typecheck passes
- [ ] Build passes
- [ ] HELP text updated with project commands
- [ ] Changeset created and staged
- [ ] All existing task/settings commands work without `--project` (backward compatible)
- [ ] All existing task/settings commands work with `--project` flag

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-619): complete Step N — description`
  - Example: `feat(KB-619): complete Step 1 — project resolution module`
- **Bug fixes:** `fix(KB-619): description`
- **Tests:** `test(KB-619): add tests for project commands`

## Do NOT

- Implement CentralCore or ProjectManager functionality (that's KB-615/KB-616)
- Modify the dashboard (that's KB-618)
- Implement auto-migration (that's KB-620)
- Skip tests for any component
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Break backward compatibility with existing CLI behavior

## Implementation Notes

**KB-615/KB-616 Dependency Handling:**
If the dependencies are not yet complete when you start, use placeholder interfaces:
- Create stub types for `CentralCore`, `ProjectManager`, `ResolvedProject`
- Add TODO comments referencing the dependencies
- The real implementations will replace your stubs

**CentralCore API (expected from KB-615):**
```typescript
class CentralCore {
  registerProject(config: { name: string; directory: string; isolationMode: string }): Promise<Project>
  unregisterProject(name: string): Promise<void>
  getProject(name: string): Project | undefined
  getProjectByDirectory(directory: string): Project | undefined
  listProjects(): Project[]
}
```

**ProjectManager API (expected from KB-616):**
```typescript
class ProjectManager {
  addProject(config: ProjectRuntimeConfig): Promise<ProjectRuntime>
  removeProject(id: string): Promise<void>
  getRuntime(id: string): ProjectRuntime | undefined
  listRuntimes(): ProjectRuntime[]
}
```

**Project Resolution Algorithm:**
1. Check `options.project` or `process.env.FN_PROJECT` — explicit flag wins
2. Walk up from `options.cwd || process.cwd()` to find `.fusion/` directory
3. If found, check if directory matches any registered project
4. If matched, use that project
5. If not matched but `.fusion/` exists, error with suggestion to register
6. If no `.fusion/` found:
   - If exactly 1 project registered, use it (convenient default)
   - If 0 projects, error with "no projects registered" message
   - If 2+ projects, error with list and suggestion to use `--project`

**Table Formatting Pattern:**
Follow the pattern from `task.ts` for consistent CLI output:
- Use `  ` (2 spaces) for left margin
- Use unicode characters for visual indicators (●, ○, ✓)
- Pad labels with spaces for alignment
- Group related items with blank lines

**JSON Output Pattern:**
When `--json` flag is used, output pretty-printed JSON with 2-space indent:
```typescript
console.log(JSON.stringify(data, null, 2));
```

**Interactive Prompt Pattern:**
Use the readline pattern from `git.ts`:
```typescript
import { createInterface } from "node:readline/promises";
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("Prompt: ");
rl.close();
```
