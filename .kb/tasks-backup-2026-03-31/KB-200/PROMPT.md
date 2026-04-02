# Task: KB-200 - Add CLI Command `kb task pr-create` for GitHub PR Creation

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This adds a new CLI command that integrates with GitHub PR creation via the GitHubClient from dashboard. Moderate blast radius - touches CLI command parsing, GitHub API integration, and task store updates. Pattern follows existing CLI command patterns. Reversible by removing the command implementation.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Add a CLI command `kb task pr-create <id>` that creates a GitHub pull request for tasks in the "in-review" column. This enables headless GitHub workflows for users who prefer the CLI over the dashboard web UI. The command validates the task is in the correct column, determines the repository from git remote or environment, creates the PR via GitHub CLI or REST API, and stores the PR info in the task.

## Dependencies

- **Task:** KB-182 (Dashboard vs CLI gap analysis - parent task)

## Context to Read First

Read these files to understand the existing patterns:

1. **`packages/cli/src/bin.ts`** — CLI entry point showing command routing and help text structure
2. **`packages/cli/src/commands/task.ts`** — Existing task command implementations (`runTaskMerge`, `runTaskShow`, etc.)
3. **`packages/dashboard/src/routes.ts`** (lines 1558-1620) — Dashboard PR creation endpoint showing the exact logic to replicate
4. **`packages/dashboard/src/github.ts`** — `GitHubClient` class with `createPr()` method
5. **`packages/core/src/store.ts`** (lines 1387-1430) — `updatePrInfo()` method for storing PR info
6. **`packages/core/src/types.ts`** (lines 31-41) — `PrInfo` interface definition
7. **`packages/cli/src/commands/task.test.ts`** — Test patterns for mocking TaskStore

## File Scope

### Files to Modify

- `packages/cli/src/bin.ts` — Add command routing for `pr-create` subcommand
- `packages/cli/src/commands/task.ts` — Implement `runTaskPrCreate()` function
- `packages/cli/src/commands/task.test.ts` — Add tests for new command

### Dependencies (read-only reference)

- `packages/dashboard/src/github.ts` — GitHubClient class (import from @kb/dashboard)
- `packages/dashboard/src/routes.ts` — Dashboard PR creation reference implementation
- `packages/core/src/store.ts` — TaskStore with updatePrInfo method
- `packages/core/src/gh-cli.ts` — isGhAvailable, isGhAuthenticated helpers

## Steps

### Step 1: Implement `runTaskPrCreate` in task.ts

- [ ] Import `GitHubClient` from `@kb/dashboard/github.js`
- [ ] Import `isGhAvailable`, `isGhAuthenticated` from `@kb/core`
- [ ] Import `getCurrentGitHubRepo` from `@kb/dashboard/github.js` (or use local git remote parsing)
- [ ] Create `runTaskPrCreate(id: string, options: PrCreateOptions)` function
- [ ] Validate task exists and is in 'in-review' column
- [ ] Check if task already has PR info (error if exists)
- [ ] Determine owner/repo from GITHUB_REPOSITORY env or git remote
- [ ] Validate GitHub auth (gh CLI or GITHUB_TOKEN)
- [ ] Build branch name: `kb/{task.id.toLowerCase()}`
- [ ] Build PR title (use provided, task title, or auto-generate from description)
- [ ] Create PR via GitHubClient.createPr()
- [ ] Store PR info via `store.updatePrInfo()`
- [ ] Log PR creation via `store.logEntry()`
- [ ] Output success message with PR URL
- [ ] Run targeted tests for changed files

**Error Cases to Handle:**
- Task not found (ENOENT) → "Task {id} not found"
- Task not in 'in-review' → "Task must be in 'in-review' column to create a PR"
- Task already has PR → "Task already has PR #{number}: {url}"
- No GitHub auth → "Not authenticated with GitHub. Run 'gh auth login' or set GITHUB_TOKEN."
- No repo detected → "Could not determine GitHub repository. Set GITHUB_REPOSITORY or configure git remote."
- PR already exists for branch → "A pull request already exists for {owner}/{repo}:{branch}"
- Branch has no commits → "No commits between {base} and {head}. Push changes before creating PR."

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified)

### Step 2: Add Command Routing in bin.ts

- [ ] Add `runTaskPrCreate` to the dynamic import from `./commands/task.js`
- [ ] Add `case "pr-create":` handler in the task subcommand switch
- [ ] Parse optional flags: `--title`, `--base`, `--body`
- [ ] Validate id argument is provided
- [ ] Call `runTaskPrCreate(id, { title, base, body })`
- [ ] Update HELP text to include the new command
- [ ] Run targeted tests for changed files

**HELP text addition:**
```
kb task pr-create <id> [--title <title>] [--base <branch>] [--body <body>]
                         Create a GitHub PR for an in-review task
```

**Artifacts:**
- `packages/cli/src/bin.ts` (modified)

### Step 3: Write Tests

- [ ] Create test file section for `runTaskPrCreate`
- [ ] Mock `GitHubClient` from @kb/dashboard
- [ ] Mock git remote detection
- [ ] Test successful PR creation with all options
- [ ] Test successful PR creation with minimal options (auto-generated title)
- [ ] Test error: task not in 'in-review' column
- [ ] Test error: task already has PR
- [ ] Test error: no GitHub authentication
- [ ] Test error: no repository detected
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/cli/src/commands/task.test.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manually test the command in a real repo (if possible)

### Step 5: Documentation & Delivery

- [ ] Create changeset file: `.changeset/add-pr-create-cli.md`
- [ ] Update CLI README if it documents commands (check if exists)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

**Changeset content:**
```md
---
"@dustinbyrne/kb": minor
---

Add `kb task pr-create` command for creating GitHub PRs from in-review tasks
```

## Documentation Requirements

**Must Update:**
- `.changeset/add-pr-create-cli.md` — Document the new feature for release notes

**Check If Affected:**
- `packages/cli/README.md` — Add command documentation if README exists and documents commands

## Completion Criteria

- [ ] `kb task pr-create <id>` command works end-to-end
- [ ] All optional flags (`--title`, `--base`, `--body`) function correctly
- [ ] Task must be in 'in-review' validation works
- [ ] PR info is stored and displayed correctly
- [ ] All error cases handled with clear messages
- [ ] Help text updated
- [ ] All tests passing
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-200): implement runTaskPrCreate command`
- **Step 2:** `feat(KB-200): add pr-create command routing and help text`
- **Step 3:** `test(KB-200): add tests for pr-create command`
- **Step 4:** `fix(KB-200): address test failures` (if needed)
- **Step 5:** `docs(KB-200): add changeset for pr-create command`

## Do NOT

- Modify the GitHubClient class (use it as-is from @kb/dashboard)
- Add interactive prompts (keep it scriptable/headless)
- Skip test coverage for error cases
- Change the existing branch naming convention (`kb/{task-id}`)
- Use a different PR creation flow than the dashboard (maintain consistency)
- Skip validating the task column before creating PR
- Allow PR creation for tasks that already have PRs without explicit error

## Implementation Notes

**Branch Name Format:**
- Use `kb/{task.id.toLowerCase()}` (e.g., `kb/kb-200`)

**Title Generation (when not provided):**
- Use `task.title` if available
- Otherwise generate from description (first 50 chars, sentence case)

**Repository Detection (copy from dashboard/routes.ts):**
```typescript
const envRepo = process.env.GITHUB_REPOSITORY;
if (envRepo) {
  const [owner, repo] = envRepo.split("/");
  return { owner, repo };
}
// Fall back to git remote parsing via getCurrentGitHubRepo()
```

**GitHubClient Usage:**
```typescript
import { GitHubClient } from "@kb/dashboard/github.js";
const client = new GitHubClient(process.env.GITHUB_TOKEN);
const prInfo = await client.createPr({
  owner,
  repo,
  title,
  body,
  head: branchName,
  base, // optional, defaults to repo default
});
```

**Store Operations:**
```typescript
await store.updatePrInfo(task.id, prInfo);
await store.logEntry(task.id, "Created PR", `PR #${prInfo.number}: ${prInfo.url}`);
```
