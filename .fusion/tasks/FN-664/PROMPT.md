# Task: FN-664 - Complete --project flag integration for remaining commands

**Created:** 2026-04-01
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This completes the multi-project CLI work started in KB-503. The pattern is established (import `getStore` from `project-context.js`), but needs to be applied consistently to ~20 task commands plus settings, git, and backup commands. Moderate blast radius but straightforward repetitive changes.
**Score:** 4/8 — Blast radius: 2, Pattern novelty: 0 (follows KB-503), Security: 1, Reversibility: 1

## Mission

Complete the `--project` flag integration across all remaining CLI commands. KB-503 established the infrastructure (`project-context.ts` with `getStore(projectName)` and `resolveProject()`), but only applied it to a subset of commands. This task applies the pattern to all remaining task commands (move, update, log, merge, archive, etc.) as well as settings, git, and backup commands.

The pattern is simple and consistent:
1. Import `getStore` from `../project-context.js` instead of creating a local `getStore()`
2. Add `projectName?: string` parameter to each exported command function
3. Pass `projectName` to all `getStore(projectName)` calls
4. Update `bin.ts` to extract `--project/-P` flag and pass it to command handlers

## Dependencies

- **Task:** KB-503 (CLI Multi-Project Commands: project subcommands and --project flag)
  - Must provide: `packages/cli/src/project-context.ts` with `getStore(projectName?: string)`
  - Must provide: `packages/cli/src/commands/project.ts` as reference implementation

## Context to Read First

- `packages/cli/src/project-context.ts` — The `getStore()` function to import (line ~170-180)
- `packages/cli/src/commands/task.ts` — Current state of task commands (local `getStore()` at lines 11-15)
- `packages/cli/src/commands/settings.ts` — Settings commands (local `getStore()` at lines 37-41)
- `packages/cli/src/commands/git.ts` — Git commands (no project support yet)
- `packages/cli/src/commands/backup.ts` — Backup commands (no project support yet)
- `packages/cli/src/bin.ts` — Command routing (lines 1-100 for imports, ~400-550 for task command routing)

## File Scope

### Modified Files
- `packages/cli/src/commands/task.ts` — Add projectName to ~20 commands, replace local getStore
- `packages/cli/src/commands/settings.ts` — Add projectName to runSettingsShow and runSettingsSet
- `packages/cli/src/commands/git.ts` — Add projectName to all git commands, update execSync cwd
- `packages/cli/src/commands/backup.ts` — Add projectName to all backup commands
- `packages/cli/src/bin.ts` — Add --project/-P flag extraction, pass to all command handlers

### New Test Files
- `packages/cli/src/__tests__/task-project.test.ts` — Tests for cross-project task operations
- `packages/cli/src/__tests__/settings-project.test.ts` — Tests for project-specific settings
- `packages/cli/src/__tests__/git-project.test.ts` — Tests for git commands with project context
- `packages/cli/src/__tests__/backup-project.test.ts` — Tests for backup with project context

## Steps

### Step 0: Preflight

- [ ] Verify `packages/cli/src/project-context.ts` exists with `getStore(projectName?: string)`
- [ ] Run existing CLI tests: `pnpm test packages/cli` — must pass before changes
- [ ] Verify KB-503 project commands work: `kb project list`

### Step 1: Update Task Commands

- [ ] Replace local `getStore()` in `task.ts` with import from `project-context.js`:
  ```typescript
  import { getStore } from "../project-context.js";
  // Remove: async function getStore() { ... }
  ```
- [ ] Add `projectName?: string` parameter to all exported functions:
  - `runTaskCreate(description, attachFiles, depends, projectName?)`
  - `runTaskList(projectName?)`
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
  - `runTaskComment(id, message, author?, projectName?)`
  - `runTaskSteer(id, message, projectName?)`
  - `runTaskAttach(id, filePath, projectName?)`
  - `runTaskPrCreate(id, options, projectName?)`
  - `runTaskImportFromGitHub(ownerRepo, options, projectName?)`
  - `runTaskRefine(id, feedback?, projectName?)`
  - `runTaskPlan(initialPlan?, yesFlag?, projectName?)`
  - `runTaskImportGitHubInteractive(ownerRepo, options, projectName?)`
  - `runTaskComments(id, projectName?)`
- [ ] Pass `projectName` to all `getStore(projectName)` calls
- [ ] Run task command tests: `pnpm test packages/cli/src/commands/task.test.ts`
- [ ] Fix any TypeScript errors: `pnpm build`

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)

### Step 2: Update Settings Commands

- [ ] Import `getStore` from `../project-context.js` in `settings.ts`
- [ ] Remove local `getStore()` function
- [ ] Add `projectName?: string` to `runSettingsShow(projectName?)`
- [ ] Add `projectName?: string` to `runSettingsSet(key, value, projectName?)`
- [ ] Pass `projectName` to `getStore(projectName)` calls
- [ ] Run settings tests: `pnpm test packages/cli/src/commands/settings.test.ts`

**Artifacts:**
- `packages/cli/src/commands/settings.ts` (modified)

### Step 3: Update Git Commands

- [ ] Import `resolveProject` from `../project-context.js` in `git.ts`
- [ ] Add `projectName?: string` to `runGitStatus(projectName?)`
- [ ] Add `projectName?: string` to `runGitFetch(remote?, projectName?)`
- [ ] Add `projectName?: string` to `runGitPull(options, projectName?)`
- [ ] Add `projectName?: string` to `runGitPush(options, projectName?)`
- [ ] When `projectName` is provided, resolve project and use `projectPath` as `cwd` for `execSync`:
  ```typescript
  let cwd = process.cwd();
  if (projectName) {
    const context = await resolveProject(projectName);
    cwd = context.projectPath;
  }
  // Pass cwd to execSync: execSync("git ...", { cwd })
  ```
- [ ] Update all `execSync` calls in git functions to use the resolved `cwd`
- [ ] Run git tests: `pnpm test packages/cli/src/commands/git.test.ts` (or create new tests)

**Artifacts:**
- `packages/cli/src/commands/git.ts` (modified)

### Step 4: Update Backup Commands

- [ ] Import `resolveProject` from `../project-context.js` in `backup.ts`
- [ ] Remove local `getBackupManager()` that creates `new TaskStore(process.cwd())`
- [ ] Add `projectName?: string` to `runBackupCreate(projectName?)`
- [ ] Add `projectName?: string` to `runBackupList(projectName?)`
- [ ] Add `projectName?: string` to `runBackupRestore(filename, projectName?)`
- [ ] Add `projectName?: string` to `runBackupCleanup(projectName?)`
- [ ] When `projectName` provided, resolve to get `projectPath`, create `TaskStore(projectPath)`
- [ ] Run backup tests: `pnpm test packages/cli/src/commands/backup.test.ts` (or create new tests)

**Artifacts:**
- `packages/cli/src/commands/backup.ts` (modified)

### Step 5: CLI Argument Parsing (bin.ts)

- [ ] Add `--project/-P` flag extraction at start of `main()`:
  ```typescript
  function extractProjectFlag(args: string[]): { projectName?: string; remainingArgs: string[] } {
    const projectIdx = args.findIndex((arg, i) => 
      (arg === "--project" || arg === "-P") && i + 1 < args.length
    );
    if (projectIdx !== -1) {
      const projectName = args[projectIdx + 1];
      const remainingArgs = [...args.slice(0, projectIdx), ...args.slice(projectIdx + 2)];
      return { projectName, remainingArgs };
    }
    return { projectName: undefined, remainingArgs: args };
  }
  ```
- [ ] Call `extractProjectFlag(process.argv.slice(2))` at start of `main()`
- [ ] Pass `projectName` to all command handlers:
  - Update all `runTask*` calls to include `projectName` as last parameter
  - Update `runSettingsShow(projectName)` and `runSettingsSet(key, value, projectName)`
  - Update `runGitStatus(projectName)`, `runGitFetch(remote, projectName)`, etc.
  - Update `runBackupCreate(projectName)`, `runBackupList(projectName)`, etc.
- [ ] Update help text to include global `--project, -P <name>` flag:
  ```
  Global Options:
    --project, -P <name>     Target a specific project (bypasses CWD detection)
  ```
- [ ] Run bin.ts-level tests: `pnpm test packages/cli/src/__tests__/*.test.ts`

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full CLI test suite: `pnpm test packages/cli`
- [ ] Run full test suite: `pnpm test`
- [ ] Verify no TypeScript errors: `pnpm build`
- [ ] Manual verification scenarios:
  ```bash
  # Create a test project
  mkdir -p /tmp/test-kb-project
  cd /tmp/test-kb-project
  kb project add test-project /tmp/test-kb-project
  
  # Test from another directory
  cd /tmp
  kb task create "Test task in project" --project test-project
  kb task list --project test-project
  kb task show KB-XXX --project test-project
  kb settings show --project test-project
  ```

### Step 7: Documentation & Delivery

- [ ] Add JSDoc comments to modified functions in task.ts, settings.ts, git.ts, backup.ts:
  ```typescript
  /**
   * Show task details.
   * @param id - Task ID
   * @param projectName - Optional project name to operate on (uses CWD detection if not specified)
   */
  export async function runTaskShow(id: string, projectName?: string): Promise<void>
  ```
- [ ] Update `AGENTS.md` — Add section "Multi-Project CLI Usage" (after existing CLI section):
  ```markdown
  ### Multi-Project CLI Usage

  When working with multiple kb projects, use the `--project` flag to target a specific project:

  ```bash
  # Create a task in a specific project
  kb task create "Fix bug" --project my-app

  # List tasks from a project
  kb task list --project my-app

  # Show task details from any project
  kb task show KB-001 --project my-app

  # Work with settings for a specific project
  kb settings show --project my-app
  kb settings set maxConcurrent 4 --project my-app

  # Git operations in project context
  kb git status --project my-app
  kb git pull --project my-app

  # Backup a specific project
  kb backup --create --project my-app
  ```

  Project resolution order: `--project` flag → default project (set via `kb project set-default`) → auto-detect from CWD.
  ```
- [ ] Create changeset:
  ```bash
  cat > .changeset/cli-project-flag-completion.md << 'EOF'
  ---
  "@gsxdsm/fusion": patch
  ---

  Complete --project flag integration for all CLI commands

  - All task commands now support --project/-P flag
  - Settings, git, and backup commands support --project flag
  - Cross-project operations without changing directories
  - Project resolution: flag → default → CWD detection
  EOF
  ```
- [ ] Include changeset in commit

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` — Add `--project, -P <name>` to global options in help text
- `AGENTS.md` — Add "Multi-Project CLI Usage" section with examples

**Check If Affected:**
- `packages/cli/README.md` — Update if it has CLI reference section

## Completion Criteria

- [ ] All task commands accept `projectName?: string` parameter
- [ ] Settings commands accept `projectName?: string` parameter
- [ ] Git commands accept `projectName?: string` parameter and use project path as cwd
- [ ] Backup commands accept `projectName?: string` parameter
- [ ] `bin.ts` extracts `--project/-P` flag and passes to all commands
- [ ] Help text includes global `--project, -P <name>` option
- [ ] All existing tests pass
- [ ] Build passes with no TypeScript errors
- [ ] AGENTS.md updated with multi-project CLI examples
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-664): complete Step N — description`
  - Example: `feat(FN-664): complete Step 1 — task commands --project support`
- **Bug fixes:** `fix(FN-664): description`
- **Tests:** `test(FN-664): description`
- **Docs:** `docs(FN-664): description`

## Do NOT

- Break existing single-project CLI behavior (all changes are backward compatible)
- Require --project flag (it should be optional, falling back to CWD detection)
- Skip updating any command that calls `getStore()`
- Skip tests for new functionality
- Modify CentralCore or ProjectRegistry (use existing KB-503 APIs)
- Change the project-context.ts API (consume it as-is)

## Implementation Pattern Reference

### For Task/Settings/Backup Commands (TaskStore pattern):
```typescript
import { getStore } from "../project-context.js";

export async function runCommand(arg: string, projectName?: string) {
  const store = await getStore(projectName);
  // ... rest of function
}
```

### For Git Commands (cwd pattern):
```typescript
import { resolveProject } from "../project-context.js";

export async function runGitCommand(projectName?: string) {
  let cwd = process.cwd();
  if (projectName) {
    const context = await resolveProject(projectName);
    cwd = context.projectPath;
  }
  // Use cwd in execSync: execSync("git status", { cwd })
}
```
