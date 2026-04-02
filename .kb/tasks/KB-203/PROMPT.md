# Task: KB-203 - Add CLI Git Operations for Task Workflows

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Adding new CLI commands involves moderate blast radius (new command file, bin.ts changes, tests) but follows established patterns from existing CLI commands. Security considerations around git command execution require review.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 2, Reversibility: 1

## Mission

Add a `kb git` subcommand group to the CLI, providing convenient git workflows when working with kb tasks. This enables headless/automated git operations (status, push, pull, fetch) directly from the command line, matching the dashboard's git API capabilities.

The dashboard already provides these git operations via `/api/git/*` endpoints. This task brings parity to the CLI for users who prefer terminal-based workflows or need to script git operations.

## Dependencies

- **Task:** KB-182 (gap analysis parent task - now done)

## Context to Read First

1. **`packages/dashboard/src/routes.ts`** — Reference implementation for git operations (lines ~45-280 contain `isGitRepo()`, `getGitStatus()`, `fetchGitRemote()`, `pullGitBranch()`, `pushGitBranch()` and related types)
2. **`packages/cli/src/bin.ts`** — CLI command routing and help text structure
3. **`packages/cli/src/commands/task.ts`** — Existing CLI command patterns using `execSync`
4. **`packages/cli/src/commands/task.test.ts`** — Test patterns for CLI commands

## File Scope

- `packages/cli/src/commands/git.ts` — **new file**: Git command implementations
- `packages/cli/src/bin.ts` — **modified**: Add `kb git` subcommand routing and help text
- `packages/cli/src/commands/git.test.ts` — **new file**: Unit tests for git commands
- `.changeset/add-cli-git-commands.md` — **new file**: Changeset for published package

## Steps

### Step 1: Create Git Command Module

Create the new git command module following dashboard implementation patterns.

- [ ] Create `packages/cli/src/commands/git.ts` with:
  - `isGitRepo()` — check if current directory is a git repository
  - `getGitStatus()` — return structured status data (branch, commit, isDirty, ahead, behind)
  - `fetchGitRemote(remote?)` — fetch from origin or specified remote
  - `pullGitBranch()` — pull current branch with conflict detection
  - `pushGitBranch()` — push current branch with rejection handling
  - Export `runGitStatus()`, `runGitFetch()`, `runGitPull()`, `runGitPush()` functions
- [ ] Use `execSync` from `node:child_process` for git commands (consistent with dashboard)
- [ ] Implement branch name validation using same regex as dashboard (`isValidBranchName`)
- [ ] All git operations should use current working directory (no chdir needed)
- [ ] Run targeted tests for changed files: `pnpm test packages/cli/src/commands/git.test.ts`

**Artifacts:**
- `packages/cli/src/commands/git.ts` (new)

### Step 2: Add CLI Routing and Help Text

Integrate the git commands into the CLI command structure.

- [ ] Import git command runners in `packages/cli/src/bin.ts`:
  ```typescript
  const { runGitStatus, runGitFetch, runGitPull, runGitPush } = await import("./commands/git.js");
  ```
- [ ] Add `kb git` subcommand group to the switch statement handling `case "git":`
- [ ] Implement subcommand routing:
  - `kb git status` → `runGitStatus()`
  - `kb git push` → `runGitPush()`
  - `kb git pull` → `runGitPull()`
  - `kb git fetch [remote]` → `runGitFetch(remote)` (remote defaults to "origin")
- [ ] Update HELP constant to include git commands section:
  ```
  Git Operations:
    kb git status              Show current branch, commit, dirty state, ahead/behind
    kb git push                Push current branch
    kb git pull                Pull current branch
    kb git fetch [remote]      Fetch from remote (default: origin)
  ```
- [ ] Run targeted tests: `pnpm test packages/cli/src/bin.ts` (if bin tests exist) or full CLI tests

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 3: Implement Status Command

The status command displays formatted git status output.

- [ ] Implement `runGitStatus()` that:
  - Validates current directory is a git repo (exit with error if not)
  - Calls `getGitStatus()` to fetch data
  - Formats output matching dashboard structure:
    ```
    Branch: main
    Commit: a1b2c3d
    Status: clean|dirty (+3/-1)
    Remote: ↑2 ↓1 (ahead 2, behind 1)
    ```
  - Shows dirty file count if `isDirty` is true
  - Shows ahead/behind counts only if upstream is configured
  - Handles detached HEAD state gracefully
- [ ] Exit code 0 on success, 1 on error (not a git repo, git command failed)

**Artifacts:**
- `packages/cli/src/commands/git.ts` (modified - status functions)

### Step 4: Implement Push/Pull/Fetch Commands

Implement the network-facing git operations with proper error handling.

- [ ] Implement `runGitPush()`:
  - Add `--yes` flag support to skip confirmation prompt
  - Show confirmation prompt: "Push branch <name> to remote? [Y/n]"
  - Execute `git push`
  - Format success output: "✓ Pushed <branch> to origin"
  - Handle errors: not a git repo, no upstream configured, push rejected, auth failure

- [ ] Implement `runGitPull()`:
  - Add `--yes` flag support to skip confirmation when there are uncommitted changes
  - If dirty: show warning and prompt for confirmation
  - Execute `git pull`
  - Format success output: "✓ Pulled latest changes for <branch>"
  - Detect merge conflicts and show: "✗ Merge conflict detected. Resolve manually."
  - Exit code 0 on success, 1 on error/conflict

- [ ] Implement `runGitFetch(remote?)`:
  - Accept optional remote argument (default: "origin")
  - Validate remote name using same rules as branch names
  - Execute `git fetch <remote>`
  - Format output: "✓ Fetched from <remote>" or "No new changes from <remote>"
  - Handle errors: invalid remote, connection failure, auth failure

- [ ] Write tests for all three commands in `packages/cli/src/commands/git.test.ts`

**Artifacts:**
- `packages/cli/src/commands/git.ts` (modified - push/pull/fetch functions)
- `packages/cli/src/commands/git.test.ts` (new)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] All CLI tests pass including new git command tests
- [ ] Build passes: `pnpm build`
- [ ] Manual verification (optional but recommended):
  - `kb git status` in a git repo shows correct info
  - `kb git status` outside git repo shows proper error
  - `kb git fetch` fetches from origin
  - `kb git fetch upstream` fetches from named remote
  - `kb git push --yes` pushes without prompt

### Step 6: Documentation & Delivery

- [ ] Create changeset file for the new feature:
  ```bash
  cat > .changeset/add-cli-git-commands.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add `kb git` subcommand group with status, push, pull, and fetch commands
  for convenient git workflows from the CLI.
  EOF
  ```
- [ ] Out-of-scope findings: None expected (straightforward feature implementation)

## Documentation Requirements

**Must Update:**
- `packages/cli/src/bin.ts` HELP constant — Add "Git Operations:" section with the four commands

**Check If Affected:**
- `packages/cli/README.md` — Add git commands to CLI documentation if it exists
- `AGENTS.md` — Update if there's a CLI commands reference section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Help text updated with git commands
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-203): add git command module with status, push, pull, fetch`
- **Step 2:** `feat(KB-203): integrate git commands into CLI routing and help`
- **Step 3:** `feat(KB-203): implement formatted git status output`
- **Step 4:** `feat(KB-203): implement push, pull, fetch with confirmation prompts`
- **Step 5:** `test(KB-203): add unit tests for git commands`
- **Step 6:** `docs(KB-203): add changeset for CLI git operations`

## Do NOT

- Modify the pi extension (`packages/cli/src/extension.ts`) — git operations are CLI-only, not needed in chat agent
- Change dashboard git implementation — use it as reference only
- Add destructive operations without confirmation prompts (push/pull require --yes flag support)
- Skip error handling for common cases (not a git repo, auth failures, conflicts)
- Use different git command patterns than the dashboard (use `execSync` consistently)
- Skip tests for the new commands

## Reference: Dashboard Git Implementation

From `packages/dashboard/src/routes.ts`, the following functions should be ported (adapted for CLI):

```typescript
// Types
type GitStatus = { branch: string; commit: string; isDirty: boolean; ahead: number; behind: number };
type GitFetchResult = { fetched: boolean; message: string };
type GitPullResult = { success: boolean; message: string; conflict?: boolean };
type GitPushResult = { success: boolean; message: string };

// Core functions to port
function isGitRepo(): boolean
function getGitStatus(): GitStatus | null
function fetchGitRemote(remote?: string): GitFetchResult
function pullGitBranch(): GitPullResult
function pushGitBranch(): GitPushResult
function isValidBranchName(name: string): boolean
```

The CLI versions should:
1. Use the same `execSync` patterns with timeouts
2. Format output for terminal display instead of JSON
3. Add interactive confirmation prompts where appropriate
4. Return exit codes instead of HTTP status codes
