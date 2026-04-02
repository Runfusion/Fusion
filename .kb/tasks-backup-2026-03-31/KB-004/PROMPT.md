# Task: KB-004 - CLI Multi-Project Commands

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This adds new CLI surface area and a global flag that affects how all commands resolve their TaskStore context. The blast radius is limited to the CLI package, but the pattern novelty of project context switching and the need for consistent --project flag handling across all commands requires review. This task depends on KB-002 delivering the ProjectStore infrastructure.

**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Extend the kb CLI (command name: `fn`) with multi-project support, enabling users to:
1. Manage registered projects via `fn project` subcommands
2. Target specific projects using a global `--project` flag on any command
3. Set a default project for the current working directory context

This CLI feature builds on the project infrastructure delivered by KB-001 (central database with `projects` table) and the runtime abstractions from KB-002 (ProjectStore, ProjectRuntime). The CLI becomes the primary interface for switching between projects and managing the multi-project workflow.

## Dependencies

- **Task:** KB-002 (must deliver the following to @fusion/core exports):
  - `Project` interface: `{ id, name, path, enabled, createdAt, updatedAt }`
  - `ProjectStore` class with methods: `listProjects()`, `createProject(input)`, `getProject(id)`, `deleteProject(id)`
  - `ProjectRuntime` interface for resolving project paths
  - Project-aware TaskStore methods that accept optional `projectId` parameter
  - Central database access via `~/.fusion/fusion.db` with `projects` table
  
  **Note:** Until KB-002 is complete, this task cannot be implemented. The specification assumes KB-002 delivers the above infrastructure.

## Context to Read First

1. `/packages/cli/src/bin.ts` — Main CLI entry point (command name: `fn`), command routing, help text
2. `/packages/cli/src/commands/task.ts` — All task subcommands, imports from `@fusion/core`
3. `/packages/cli/src/commands/settings.ts` — Settings command pattern, TaskStore initialization
4. `/packages/cli/src/commands/git.ts` — Git command pattern
5. `/packages/core/src/types.ts` — Verify Project type exists (from KB-002)
6. `/packages/core/src/store.ts` — Verify ProjectStore exists (from KB-002)
7. `/packages/core/src/index.ts` — Exports from @fusion/core

## File Scope

### New Files
- `packages/cli/src/commands/project.ts` — Project management commands (list, add, remove, set-default, current)
- `packages/cli/src/commands/project.test.ts` — Tests for project commands
- `packages/cli/src/context.ts` — Project context resolution helper
- `packages/cli/src/context.test.ts` — Tests for context resolution

### Modified Files
- `packages/cli/src/bin.ts` — Add `project` command routing, global --project flag parsing
- `packages/cli/src/commands/task.ts` — Accept project context in all task commands
- `packages/cli/src/commands/settings.ts` — Accept project context, show project-scoped settings
- `packages/cli/src/commands/git.ts` — Accept project context for git operations

## Steps

### Step 0: Preflight

- [ ] KB-002 is complete and merged: ProjectStore, Project type, and project-aware methods are exported from `@fusion/core`
- [ ] Verify exports from `/packages/core/src/index.ts`: `Project`, `ProjectStore`, `ProjectRuntime`
- [ ] Verify project store methods exist: `listProjects()`, `createProject()`, `deleteProject()`, `getProject(id)`
- [ ] Existing tests pass: `pnpm test` in packages/cli
- [ ] Understand current TaskStore initialization: uses `new TaskStore(process.cwd())` in commands/task.ts

### Step 1: Project Context Helper

Create a shared helper for resolving project context based on CLI flags and defaults.

- [ ] Create `packages/cli/src/context.ts` with:
  ```typescript
  import { ProjectStore } from "@fusion/core";
  
  export interface ProjectContext {
    projectId?: string;  // undefined = use cwd-based detection (legacy/single-project mode)
    rootDir: string;     // resolved project path
    store: ProjectStore; // initialized store for the resolved project
  }
  
  export async function resolveProjectContext(
    explicitProjectId: string | undefined,
    cwd: string
  ): Promise<ProjectContext>
  ```
  - If `explicitProjectId` provided: look up in central ProjectStore, return that project's path and store
  - If no explicit ID: detect from cwd (existing behavior - find nearest `.fusion/` or use cwd directly)
  - If cwd has a `.fusion/.project-default` file: read the default project ID and resolve that project
  - Returns `{ projectId, rootDir, store }` where store is initialized for the correct project context
  
- [ ] Create `packages/cli/src/context.test.ts` with tests for:
  - Explicit project ID resolution via ProjectStore
  - Cwd-based detection (nearest `.fusion/` directory up the tree)
  - Default project file (`.fusion/.project-default`) resolution
  - Error handling for unknown project IDs
  - Error handling when cwd is not in any registered project
  - Fallback to single-project mode when no projects registered

**Artifacts:**
- `packages/cli/src/context.ts` (new)
- `packages/cli/src/context.test.ts` (new)

### Step 2: Project Management Commands

Implement the `fn project` subcommand group for managing registered projects.

- [ ] Create `packages/cli/src/commands/project.ts` with:
  - `runProjectList(centralStore: ProjectStore)` — List all registered projects
    - Display: ID, Name, Path
    - Mark current project (if cwd is within a registered project)
    - Mark default project (if `.fusion/.project-default` exists)
    - Show enabled/disabled status
    
  - `runProjectAdd(centralStore: ProjectStore, path: string, name?: string, options?: { force?: boolean })` — Add a project
    - Validate path exists and is a directory
    - Validate path contains a git repository (or warn)
    - Auto-detect name from `package.json` name or directory basename if not provided
    - Check for duplicates (by path) unless `--force`
    - Create project via `centralStore.createProject()`
    - Output: `✓ Added project proj-001: My Project at /path/to/project`
    
  - `runProjectRemove(centralStore: ProjectStore, id: string, options?: { force?: boolean })` — Remove a project
    - Look up project by ID
    - Confirm with user unless `--force` flag: `Remove project proj-001: My Project? [y/N]`
    - Call `centralStore.deleteProject(id)` — removes from registry only, does NOT delete files
    - Output: `✓ Removed project proj-001 from registry (files preserved at /path/to/project)`
    
  - `runProjectSetDefault(centralStore: ProjectStore, projectId: string, cwd: string)` — Set default project
    - Validate project exists
    - Write project ID to `.fusion/.project-default` in the current working directory (or create `.fusion/` if needed)
    - This allows different directories to have different default projects
    - Output: `✓ Set proj-001 as default project for /current/working/dir`
    
  - `runProjectCurrent(centralStore: ProjectStore, cwd: string)` — Show current context
    - Resolve project context from cwd
    - Display: current project ID, name, path, and how it was resolved (explicit flag, default file, or cwd detection)
    - If no project context: show "No project context (single-project mode)"

- [ ] Create `packages/cli/src/commands/project.test.ts` with tests for:
  - List with empty registry
  - List with multiple projects
  - Add project with auto-detected name
  - Add project with explicit name
  - Add duplicate path (should fail without --force)
  - Remove project with confirmation
  - Remove project with --force
  - Set default creates `.fusion/.project-default` file
  - Current shows resolved context

**Artifacts:**
- `packages/cli/src/commands/project.ts` (new)
- `packages/cli/src/commands/project.test.ts` (new)

### Step 3: Global --project Flag Parsing

Add global `--project` flag support to the CLI argument parser.

- [ ] Modify `packages/cli/src/bin.ts`:
  - Parse `--project <id>` (or `-p <id>`) from args BEFORE command routing
  - Store `explicitProjectId: string | undefined` for use by all commands
  - Pass `explicitProjectId` to all command functions via context helper
  - Support short form `-p` as alias for `--project`
  
- [ ] Update argument parsing in each command block to pass project context:
  ```typescript
  // Example pattern for task commands:
  const projectContext = await resolveProjectContext(explicitProjectId, process.cwd());
  await runTaskCreate(description, attachFiles, depends, projectContext);
  ```
  
- [ ] Update `HELP` constant to document the global `--project` flag:
  ```
  Global Options:
    --project, -p <id>         Target a specific project by ID
  
  Project Commands:
    fn project list              List all registered projects
    fn project add <path> [name] Add a project to the registry
    fn project remove <id>       Remove a project from registry
    fn project set-default <id>  Set default project for current directory
    fn project current           Show current project context
  ```

**Artifacts:**
- `packages/cli/src/bin.ts` (modified — flag parsing and command routing)

### Step 4: Update Task Commands for Project Context

Modify all task commands to accept and use project context from the context helper.

- [ ] Modify `packages/cli/src/commands/task.ts`:
  - Remove the local `getStore()` helper that uses `process.cwd()` directly
  - Update all exported functions to accept `projectContext: ProjectContext` parameter as final argument:
    - `runTaskCreate(descriptionArg?, attachFiles?, depends?, projectContext)`
    - `runTaskList(projectContext)`
    - `runTaskShow(id, projectContext)`
    - `runTaskMove(id, column, projectContext)`
    - `runTaskUpdate(id, step, status, projectContext)`
    - `runTaskLog(id, message, outcome?, projectContext)`
    - `runTaskLogs(id, options, projectContext)`
    - `runTaskMerge(id, projectContext)`
    - `runTaskDuplicate(id, projectContext)`
    - `runTaskRefine(id, feedback?, projectContext)`
    - `runTaskArchive(id, projectContext)`
    - `runTaskUnarchive(id, projectContext)`
    - `runTaskDelete(id, force?, projectContext)`
    - `runTaskAttach(id, filePath, projectContext)`
    - `runTaskPause(id, projectContext)`
    - `runTaskUnpause(id, projectContext)`
    - `runTaskSteer(id, message?, projectContext)`
    - `runTaskRetry(id, projectContext)`
    - `runTaskPrCreate(id, options, projectContext)`
    - `runTaskPlan(initialPlan?, yesFlag?, projectContext)`
    - `runTaskImportFromGitHub(ownerRepo, options, projectContext)`
    - `runTaskImportGitHubInteractive(ownerRepo, options, projectContext)`
  
  - Use `projectContext.store` instead of creating a new TaskStore
  - When `projectContext.projectId` is set: show project indicator in output:
    ```
    ✓ Created KB-123: Fix login bug (Project: proj-001)
    ```
  
- [ ] Run existing task tests to ensure no regressions

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified — use project context)

### Step 5: Update Settings Commands for Project Context

Modify settings commands to support project-scoped settings.

- [ ] Modify `packages/cli/src/commands/settings.ts`:
  - Update `runSettingsShow()` to accept `projectContext: ProjectContext` parameter
  - Display project indicator when `projectContext.projectId` is set:
    ```
    kb Configuration Settings (Project: proj-001)
    ```
  - When project context exists: use `projectContext.store.getSettings()` (returns merged global+project settings)
  - When no project context: show error or fall back to cwd-based store
  
  - Update `runSettingsSet()` to accept `projectContext: ProjectContext` parameter:
    - Update setting via `projectContext.store.updateSettings()`
    - Show confirmation: `✓ Updated maxConcurrent to 4 (Project: proj-001)`
  
- [ ] Run existing settings tests to ensure no regressions

**Artifacts:**
- `packages/cli/src/commands/settings.ts` (modified — project context support)

### Step 6: Update Git Commands for Project Context

Modify git commands to operate in the context of a specific project.

- [ ] Modify `packages/cli/src/commands/git.ts`:
  - Update all functions to accept `projectContext: ProjectContext` parameter:
    - `runGitStatus(projectContext)`
    - `runGitFetch(remote?, projectContext)`
    - `runGitPull(options, projectContext)`
    - `runGitPush(options, projectContext)`
  - Execute git commands in `projectContext.rootDir` (the resolved project path)
  - When no project context: fall back to `process.cwd()` (existing behavior)
  
- [ ] Run existing git tests to ensure no regressions

**Artifacts:**
- `packages/cli/src/commands/git.ts` (modified — project context support)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all CLI tests: `pnpm --filter @dustinbyrne/kb test` — all pass
- [ ] Create integration test script (`packages/cli/src/__tests__/multi-project.test.ts`):
  - Test project list when no projects exist (empty state)
  - Test adding a project to registry
  - Test removing a project
  - Test setting and reading default project
  - Test --project flag on task create
  - Test --project flag on task list
  - Test project-scoped settings
  - Test error handling for unknown project IDs
  - Test backward compatibility (commands without --project flag work as before)
  
- [ ] Build passes: `pnpm build` — no TypeScript errors
- [ ] Manual verification checklist:
  1. `fn project add /path/to/project` — project appears in list
  2. `fn project list` — shows added project with ID, name, path
  3. `fn --project proj-001 task create "Test task"` — task created in specific project
  4. `fn --project proj-001 task list` — shows tasks from that project
  5. `fn project set-default proj-001` — creates `.fusion/.project-default` file
  6. `fn project current` — shows resolved context
  7. Without --project flag, uses cwd context (backward compatible)

**Artifacts:**
- `packages/cli/src/__tests__/multi-project.test.ts` (new)
- All existing tests passing

### Step 8: Documentation & Delivery

- [ ] Update CLI help text (`HELP` constant in `bin.ts`) to document:
  - New `fn project` command group with all subcommands
  - Global `--project` / `-p` flag with description
  - Examples of multi-project usage
  
- [ ] Update `packages/cli/README.md`:
  - Add "Multi-Project Support" section
  - Document `fn project` commands with examples:
    ```bash
    # Register a project
    fn project add ~/projects/my-app "My Application"
    
    # List registered projects
    fn project list
    
    # Set default project for current directory
    fn project set-default proj-001
    
    # Create task in specific project
    fn --project proj-001 task create "Fix login bug"
    
    # List tasks in specific project
    fn --project proj-001 task list
    ```
  - Document `--project` flag usage and project resolution order
  
- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/cli-multi-project.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add multi-project CLI support with `fn project` commands and `--project` flag
  
  - New `fn project` subcommands: list, add, remove, set-default, current
  - Global `--project` / `-p` flag for targeting specific projects
  - Project context resolution: explicit flag > default file > cwd detection
  - Backward compatible: single-project workflows continue to work without changes
  EOF
  ```
  
- [ ] Create `.DONE` file in task directory

**Artifacts:**
- `packages/cli/README.md` (updated)
- `.changeset/cli-multi-project.md` (new)
- `.DONE` marker file

## Documentation Requirements

**Must Update:**
- `packages/cli/README.md` — Add complete multi-project CLI documentation with examples
- `packages/cli/src/bin.ts` — Update `HELP` text with project commands and --project flag

**Check If Affected:**
- `AGENTS.md` — Update if agents need to know about project context
- `packages/core/README.md` — Verify ProjectStore documentation is accurate (from KB-002)

## Completion Criteria

- [ ] All steps complete (0-8)
- [ ] All tests passing (existing + new multi-project tests)
- [ ] Build passes with no TypeScript errors
- [ ] CLI help text documents new features
- [ ] Manual verification confirms:
  - `fn project list` works and shows all registered projects
  - `fn project add <path>` works and auto-detects name
  - `fn project remove <id>` works with confirmation
  - `fn project set-default <id>` creates `.fusion/.project-default` file
  - `fn project current` shows resolved context
  - `fn --project <id> task create` works
  - `fn --project <id> task list` works
  - `fn --project <id> settings` shows project-scoped settings
  - Without --project flag, commands work as before (backward compatible)
- [ ] Changeset created
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-004): complete Step N — description`
- **Bug fixes:** `fix(KB-004): description`
- **Tests:** `test(KB-004): description`
- **Docs:** `docs(KB-004): description`

Example commits:
```
feat(KB-004): complete Step 1 — add project context resolution helper
feat(KB-004): complete Step 2 — implement fn project subcommands
feat(KB-004): complete Step 3 — add global --project flag parsing
test(KB-004): add multi-project integration tests
docs(KB-004): add multi-project CLI documentation
```

## Do NOT

- **Do NOT** break backward compatibility — commands without --project must work exactly as before (single-project mode)
- **Do NOT** require project registration for single-project workflows (legacy mode must work without projects table)
- **Do NOT** change the default behavior when --project is not specified (use cwd detection, existing behavior)
- **Do NOT** allow --project flag to create new projects implicitly (use explicit `fn project add`)
- **Do NOT** skip tests for error handling (unknown project IDs, invalid paths, missing KB-002 infrastructure)
- **Do NOT** modify the CLI output format when not using --project (preserve existing UX for single-project users)
- **Do NOT** commit without running the full test suite

## Fallback Behavior (when KB-002 not yet complete)

If this task is started before KB-002 delivers the Project infrastructure:
1. The `--project` flag should show a helpful error: `Multi-project support requires project infrastructure. Please ensure KB-002 is complete.`
2. The `fn project` commands should show: `Project management requires KB-002. This feature is not yet available.`
3. All existing commands continue to work in single-project mode without changes
