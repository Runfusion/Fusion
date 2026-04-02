# Task: KB-503 - CLI Multi-Project Commands: project subcommands and --project flag

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This adds new CLI surface area and modifies existing command patterns. Moderate blast radius on CLI argument parsing. Security considerations around path validation when registering projects. Pattern is straightforward extension of existing CLI architecture.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Extend the kb CLI to support multi-project operations. Add a new `kb project` subcommand for managing the project registry (list, add, remove, show, set-default, detect) and add a `--project <name>` flag to all existing task commands so users can operate on tasks in specific projects without changing their working directory.

This CLI layer sits on top of the CentralCore (KB-500) and the runtime abstraction (KB-501), providing users with convenient command-line access to multi-project functionality.

## Blocked By

- [ ] **KB-500** (Core Infrastructure: Central database, project registry, unified activity feed)
  - Requires: `CentralCore` class, `ProjectRegistry` class, `RegisteredProject` type
  - Requires: `packages/core/src/central-core.ts` with `registry` property
- [ ] **KB-501** (Per-Project Runtime Abstraction and Hybrid Executor Lifecycle)
  - Requires: Integration with CentralCore APIs

**DO NOT START THIS TASK until the above dependencies are merged.** The spec cannot be implemented without the CentralCore and ProjectRegistry APIs.

## Dependencies

- **Task:** KB-501 (Per-Project Runtime Abstraction and Hybrid Executor Lifecycle)
  - Must provide: Project registry API via CentralCore, `RegisteredProject` type
  - Must expose: `ProjectRegistry.detectProjectFromCwd()`, `ProjectRegistry.listProjects()`, etc.

## Context to Read First

- `packages/cli/src/bin.ts` — CLI argument parsing and command routing (lines 1-400 for structure)
- `packages/cli/src/commands/task.ts` — Task command implementations (lines 1-100 for patterns)
- `packages/cli/src/commands/settings.ts` — Settings command patterns
- KB-500's `packages/core/src/central-core.ts` (when complete) — CentralCore API for project registry
- KB-500's `packages/core/src/project-registry.ts` — ProjectRegistry class methods
- `packages/core/src/types.ts` — `RegisteredProject`, `ProjectStatus`, `IsolationMode` types

## File Scope

### New Files
- `packages/cli/src/commands/project.ts` — Project command implementations
- `packages/cli/src/commands/project.test.ts` — Tests for project commands
- `packages/cli/src/project-context.ts` — Shared project resolution logic
- `packages/cli/src/__tests__/project-context.test.ts` — Tests for context resolution

### Modified Files
- `packages/cli/src/bin.ts` — Add project subcommand routing and --project flag parsing
- `packages/cli/src/commands/task.ts` — Add --project support to all task commands
- `packages/cli/src/commands/settings.ts` — Add --project support
- `packages/cli/src/commands/git.ts` — Add --project support
- `packages/cli/src/commands/backup.ts` — Add --project support

## Steps

### Step 0: Preflight (Dependency Validation)

> **CRITICAL:** Verify dependencies are available before proceeding.

- [ ] Check that `packages/core/src/central-core.ts` exists
- [ ] Verify `CentralCore` class is exported from `@fusion/core`
- [ ] Verify `ProjectRegistry` class is available via `centralCore.registry`
- [ ] Verify `RegisteredProject`, `ProjectStatus`, `IsolationMode` types exist in `types.ts`
- [ ] Verify `CentralCore` has methods: `listProjects()`, `registerProject()`, `unregisterProject()`, `getProject()`, `detectProjectFromCwd()`

If any dependencies are missing, **STOP** and mark this task as blocked. Do not proceed with implementation.

### Step 1: Project Context Resolution Utilities

- [ ] Create `packages/cli/src/project-context.ts`:
  ```typescript
  export interface ProjectContext {
    projectId: string;
    projectPath: string;
    projectName: string;
    store: TaskStore;
  }
  
  // Resolve project from --project flag or default or CWD
  export async function resolveProject(
    projectNameFlag?: string,
    cwd: string = process.cwd()
  ): Promise<ProjectContext>;
  
  // Get the default project from global settings
  export async function getDefaultProject(): Promise<RegisteredProject | undefined>;
  
  // Set the default project in global settings
  export async function setDefaultProject(projectId: string): Promise<void>;
  
  // Format project for display
  export function formatProjectLine(project: RegisteredProject, isDefault: boolean): string;
  ```
- [ ] Implement `resolveProject()` logic:
  - If `--project <name>` provided: look up by name in registry
  - Else if default project set: use that project
  - Else: auto-detect from CWD using `ProjectRegistry.detectProjectFromCwd()`
  - Throw clear error if project not found
- [ ] Implement `getStoreForProject(projectId: string): Promise<TaskStore>`:
  - Get project from registry, create TaskStore for its path
  - Cache stores to avoid re-initialization
- [ ] Write tests for context resolution:
  - Resolve by name flag
  - Resolve by default
  - Resolve by CWD detection
  - Error on unknown project
- [ ] Run targeted tests: `pnpm test packages/cli/src/__tests__/project-context.test.ts`

**Artifacts:**
- `packages/cli/src/project-context.ts` (new)
- `packages/cli/src/__tests__/project-context.test.ts` (new)

### Step 2: Project Subcommand Implementation

- [ ] Create `packages/cli/src/commands/project.ts`:
  - Import `CentralCore` from `@fusion/core` (provided by KB-500)
  - Import project context utilities
- [ ] Implement `runProjectList()`:
  - Fetch all projects from `centralCore.registry.listProjects()`
  - Show table with: name, path, status, isolation mode, active tasks
  - Highlight default project with asterisk (*)
  - Show summary: "N projects registered, M active"
- [ ] Implement `runProjectAdd(name: string, path: string, options?)`:
  - Resolve path (absolute or relative to CWD)
  - Validate path exists and contains `.fusion/fusion.db`
  - Call `centralCore.registry.registerProject({ name, path })`
  - Output: "✓ Registered project 'name' at /path/to/project"
  - Options: `--isolation <mode>` (in-process | child-process)
- [ ] Implement `runProjectRemove(name: string, force?: boolean)`:
  - Find project by name
  - If not `--force`, prompt for confirmation
  - Call `centralCore.registry.unregisterProject(id)`
  - Output: "✓ Unregistered project 'name' (data preserved at /path)"
- [ ] Implement `runProjectShow(name: string)`:
  - Show detailed project info:
    - ID, name, path, status
    - Isolation mode, concurrency settings
    - Health: task counts, active tasks, last activity
    - Creation date, last updated
- [ ] Implement `runProjectSetDefault(name: string)`:
  - Find project by name
  - Save to global settings as default project
  - Output: "✓ Set 'name' as default project"
- [ ] Implement `runProjectDetect()`:
  - Call `centralCore.registry.detectProjectFromCwd(process.cwd())`
  - If found: show project name and path
  - If not found: "No kb project detected from current directory"
- [ ] Write comprehensive tests for all commands
- [ ] Run targeted tests: `pnpm test packages/cli/src/commands/project.test.ts`

**Artifacts:**
- `packages/cli/src/commands/project.ts` (new)
- `packages/cli/src/commands/project.test.ts` (new)

### Step 3: CLI Argument Parsing Updates

- [ ] Update `packages/cli/src/bin.ts`:
  - Add global `--project <name>` flag parsing before command routing
  - Pass resolved project context to all command handlers
  - Add `project` subcommand routing
- [ ] Update the switch statement to handle `project` command:
  ```typescript
  case "project": {
    const subcommand = args[1];
    switch (subcommand) {
      case "list":
      case "ls":
        await runProjectList();
        break;
      case "add":
        // Parse --isolation flag
        await runProjectAdd(args[2], args[3], { isolation: isolationFlag });
        break;
      // ... etc
    }
  }
  ```
- [ ] Add `--project` flag extraction utility:
  - Scan args for `--project <name>` or `-P <name>`
  - Remove from args before passing to subcommand handlers
  - Store in global context for command use
- [ ] Update help text to include project commands:
  ```
  fn project list                     List all registered projects
  fn project add <name> <path>        Register a new project
  fn project remove <name> [--force]  Unregister a project
  fn project show <name>                Show project details
  fn project set-default <name>         Set default project
  fn project detect                     Show project detected from CWD
  ```
- [ ] Add global flag to help:
  ```
  --project, -P <name>       Target a specific project (bypasses CWD detection)
  ```
- [ ] Run CLI tests to ensure no regressions: `pnpm test packages/cli/src/commands/*.test.ts`

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 4: Add --project Flag to Task Commands

- [ ] Update `packages/cli/src/commands/task.ts`:
  - Import `resolveProject` from `../project-context.js`
  - Add `projectName?: string` parameter to all exported functions
  - Replace all `getStore()` calls with `getStore(projectName)` pattern
- [ ] Update each task command to accept project context:
  - `runTaskCreate(description, attachFiles, depends, projectName?)`
  - `runTaskList(projectName?)` — list tasks from specific project
  - `runTaskShow(id, projectName?)`
  - `runTaskMove(id, column, projectName?)`
  - `runTaskUpdate(id, step, status, projectName?)`
  - `runTaskLog(id, message, outcome?, projectName?)`
  - `runTaskLogs(id, options, projectName?)`
  - `runTaskMerge(id, projectName?)`
  - `runTaskDuplicate(id, projectName?)`
  - `runTaskArchive(id, projectName?)`
  - `runTaskUnarchive(id, projectName?)`
  - `runTaskDelete(id, force, projectName?)`
  - `runTaskPause(id, projectName?)`
  - `runTaskUnpause(id, projectName?)`
  - `runTaskRetry(id, projectName?)`
  - `runTaskComment(id, message, projectName?)`
  - `runTaskSteer(id, message, projectName?)`
  - `runTaskAttach(id, filePath, projectName?)`
  - `runTaskPrCreate(id, options, projectName?)`
  - `runTaskImportFromGitHub(repo, options, projectName?)`
  - `runTaskRefine(id, options, projectName?)`
  - `runTaskPlan(initialPlan, yesFlag, projectName?)`
- [ ] Update `getStore()` to accept optional project name:
  ```typescript
  async function getStore(projectName?: string): Promise<TaskStore> {
    if (projectName) {
      const context = await resolveProject(projectName);
      return context.store;
    }
    // Original behavior: current directory
    const store = new TaskStore(process.cwd());
    await store.init();
    return store;
  }
  ```
- [ ] Add project name to output headers where appropriate:
  - "Tasks for project 'name':" when using --project flag
  - Keep current behavior (no prefix) when using CWD
- [ ] Run task command tests: `pnpm test packages/cli/src/commands/task.test.ts`

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)

### Step 5: Add --project Flag to Other Commands

- [ ] Update `packages/cli/src/commands/settings.ts`:
  - Add `projectName?: string` parameter to `runSettingsShow()` and `runSettingsSet()`
  - When project specified, show project-specific settings
  - When no project, show global settings
  - Update help text with examples
- [ ] Update `packages/cli/src/commands/git.ts`:
  - Add `projectName?: string` to all git commands
  - Execute git commands in the context of the specified project's path
- [ ] Update `packages/cli/src/commands/backup.ts`:
  - Add `projectName?: string` to backup commands
  - When specified, backup that project's database
  - Default: backup current project's database
- [ ] Write tests for updated commands
- [ ] Run tests: `pnpm test packages/cli/src/commands/settings.test.ts packages/cli/src/commands/git.test.ts packages/cli/src/commands/backup.test.ts`

**Artifacts:**
- `packages/cli/src/commands/settings.ts` (modified)
- `packages/cli/src/commands/git.ts` (modified)
- `packages/cli/src/commands/backup.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full CLI test suite: `pnpm test packages/cli`
- [ ] Run full core test suite: `pnpm test packages/core`
- [ ] Verify no TypeScript errors: `pnpm build`
- [ ] Manual verification scenarios:
  ```bash
  # Register a project
  kb project add my-app /path/to/app
  
  # List projects
  kb project list
  
  # Create task in specific project
  kb task create "Fix login bug" --project my-app
  
  # List tasks from specific project
  kb task list --project my-app
  
  # Show task details from project
  kb task show KB-001 --project my-app
  
  # Set default project
  kb project set-default my-app
  
  # Now commands use default without --project
  kb task list  # Uses my-app
  
  # Detect project from CWD
  cd /path/to/app
  kb project detect
  ```
- [ ] Check test coverage for new files (aim for >80%)

### Step 7: Documentation & Delivery

- [ ] Add JSDoc comments to all new functions in `project-context.ts` and `project.ts`
- [ ] Update `AGENTS.md` — Document the multi-project CLI:
  - New `kb project` subcommands with examples
  - `--project` flag usage
  - Project resolution order: --project flag → default project → CWD detection
  - Migration from single-project workflow
- [ ] Update CLI help text (in bin.ts) with project examples
- [ ] Create changeset for the feature:
    ```bash
    cat > .changeset/cli-multi-project.md << 'EOF'
    ---
    "@dustinbyrne/kb": minor
    ---
    
    Add multi-project CLI commands and --project flag
    
    - New `kb project` subcommand: list, add, remove, show, set-default, detect
    - Global `--project <name>` flag for all task operations
    - Project context resolution: flag → default → auto-detect
    - Cross-project task management without changing directories
    EOF
    ```
- [ ] Include changeset in commit
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Dashboard project switching UI (belongs in KB-502)
  - Per-project model overrides (if not already implemented)

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — Help text with project commands and --project flag
- `AGENTS.md` — Add section "Multi-Project CLI Usage":
  - `kb project` subcommand reference
  - `--project` flag examples
  - Project resolution precedence
  - Common workflows (cross-project operations)

**Check If Affected:**
- `packages/cli/README.md` — Update CLI reference if exists
- `packages/cli/package.json` — No changes expected

## Completion Criteria

- [ ] `kb project list` — Shows all registered projects with status
- [ ] `kb project add <name> <path>` — Registers new project with validation
- [ ] `kb project remove <name>` — Unregisters project with confirmation
- [ ] `kb project show <name>` — Displays detailed project info
- [ ] `kb project set-default <name>` — Sets default project for CLI
- [ ] `kb project detect` — Shows project detected from current directory
- [ ] `--project <name>` flag works on all task commands
- [ ] `--project` flag works on settings, git, and backup commands
- [ ] Project resolution order implemented: flag → default → CWD detection
- [ ] All existing tests pass without modification
- [ ] New tests for project commands pass (>80% coverage)
- [ ] Build passes with no TypeScript errors
- [ ] Manual verification scenarios pass
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-503): complete Step N — description`
  - Example: `feat(KB-503): complete Step 1 — project context resolution utilities`
- **Bug fixes:** `fix(KB-503): description`
- **Tests:** `test(KB-503): description`
- **Docs:** `docs(KB-503): description`

## Do NOT

- Break existing single-project CLI behavior (all changes are backward compatible)
- Require --project flag (it should be optional, with sensible defaults)
- Allow registering duplicate project names
- Allow path traversal in project paths (validate resolved paths)
- Skip confirmation on project removal without --force
- Cache TaskStore instances indefinitely (implement reasonable cleanup)
- Expose full absolute paths in output (use relative paths where possible)
- Skip tests for project name validation
- Modify the CentralCore or ProjectRegistry (that's KB-500)
- Implement dashboard UI (that's KB-502)

## Security Considerations

- Validate project paths on registration (must exist, must contain `.fusion/fusion.db`)
- Prevent path traversal attacks (resolve to absolute paths, check for `../`)
- Reject circular project registrations (one project inside another)
- Sanitize project names (alphanumeric, hyphens, underscores only, case-insensitive unique)
- Don't expose sensitive directory structure in CLI output
- Validate project name in --project flag to prevent injection

## Error Handling

- Unknown project name: "Project 'name' not found. Run 'kb project list' to see registered projects."
- No project detected from CWD: "No kb project found in current directory. Use --project or run from a project directory."
- Project path doesn't exist: "Path /path does not exist or is not a kb project (no .fusion/fusion.db found)."
- Duplicate project name: "Project 'name' already registered. Choose a different name."
