# Task: KB-182 - Examine Dashboard Features Missing from CLI and Create Subtasks

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is an analysis and planning task that creates subtasks but doesn't directly modify production code. Low blast radius, mostly about identifying gaps and creating follow-up work items.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Audit the kb dashboard API routes to identify features that exist in the dashboard but lack CLI equivalents. Create focused subtasks for the most critical missing features that would improve the CLI user experience and enable headless/automated workflows.

The dashboard has many features exposed via REST API that are only accessible through the web UI. This task identifies which of those features should be prioritized for CLI implementation based on workflow criticality and user value.

## Dependencies

- **None**

## Context to Read First

Read these files to understand the feature landscape:

1. **`packages/dashboard/src/routes.ts`** — All dashboard API routes (this is the source of truth for dashboard features)
2. **`packages/cli/src/commands/task.ts`** — Current CLI task commands
3. **`packages/cli/src/bin.ts`** — CLI command routing and help text
4. **`packages/cli/src/extension.ts`** — Pi extension tools (shows what chat agent can do)
5. **`packages/core/src/store.ts`** — TaskStore methods available (shows underlying capabilities)

## File Scope

- Read-only analysis files (no modifications to source code)
- Creates subtasks via `task_create` tool
- No test files to modify (analysis task)

## Steps

### Step 1: Analyze Dashboard Routes

- [ ] Read `packages/dashboard/src/routes.ts` completely
- [ ] Catalog all API endpoints by category (Task Management, Git, GitHub, Terminal, Files, Planning, Settings, Auth)
- [ ] For each endpoint, note: HTTP method, path, purpose, and whether CLI equivalent exists

### Step 2: Analyze CLI Coverage

- [ ] Read `packages/cli/src/commands/task.ts` and `packages/cli/src/bin.ts`
- [ ] Read `packages/cli/src/extension.ts` for pi extension tools
- [ ] List all current CLI commands and extension tools
- [ ] Map CLI commands to dashboard API endpoints

### Step 3: Identify Critical Gaps

- [ ] Create a gap analysis matrix (Dashboard Feature | CLI Status | Criticality)
- [ ] Prioritize gaps by:
  - Workflow importance (can users complete common workflows without this?)
  - Headless/automation value (needed for CI/CD or scripting?)
  - Frequency of use (how often would users need this?)
- [ ] Identify top 5-7 most critical missing features

### Step 4: Create Subtasks

Create focused child tasks using the `task_create` tool for each critical missing feature. For each subtask:

- Write clear title and description
- Set appropriate size (S/M/L)
- Reference this parent task as dependency if appropriate
- Include specific acceptance criteria

**Priority Order for Subtasks:**

1. **Task Deletion** — `kb task delete <id>` — Critical for cleanup and testing
2. **Task Retry** — `kb task retry <id>` — Essential for failed task recovery
3. **GitHub PR Creation** — `kb task pr-create <id> [--title <t>] [--base <b>]` — Core GitHub workflow
4. **Settings Management** — `kb settings` and `kb settings set <key> <value>` — View/update kb config
5. **Agent Logs** — `kb task logs <id>` — View task execution history
6. **Git Operations** — `kb git status`, `kb git push`, `kb git pull`, `kb git fetch` — Common git workflows
7. **Steering Comments** — `kb task steer <id> <message>` — Add user guidance to tasks

### Step 5: Documentation & Delivery

- [ ] Summarize findings in a brief markdown file at `.fusion/tasks/KB-182/gap-analysis.md`
- [ ] List the created subtasks with their IDs
- [ ] Include a priority recommendation for implementation order

## Documentation Requirements

**Must Create:**
- `.fusion/tasks/KB-182/gap-analysis.md` — Summary of dashboard vs CLI feature gaps and created subtasks

**Check If Affected:**
- None (analysis task)

## Completion Criteria

- [ ] All dashboard routes analyzed and cataloged
- [ ] CLI coverage mapped
- [ ] Critical gaps identified with justification
- [ ] 5-7 subtasks created using `task_create` tool
- [ ] Gap analysis document written

## Git Commit Convention

Since this is primarily an analysis task creating subtasks via tools:
- **Step completion:** `feat(KB-182): complete Step N — description`
- **Subtask creation:** Reference subtask IDs in commit messages when all subtasks created

## Do NOT

- Modify existing CLI code (this is an analysis/planning task)
- Create the actual CLI implementations (defer to subtasks)
- Skip the analysis and guess at gaps — actually read the routes file
- Create subtasks for features that already have CLI equivalents
- Create more than 7 subtasks (focus on most critical)

## Gap Analysis Template

Use this structure in your analysis document:

```markdown
# Dashboard vs CLI Feature Gap Analysis

## Summary
- Total Dashboard API Endpoints: ~N
- CLI Equivalents: ~M
- Critical Gaps: ~K

## Feature Categories

### Task Management
| Feature | Dashboard | CLI | Pi Ext | Critical |
|---------|-----------|-----|--------|----------|
| Create task | POST /tasks | ✓ | ✓ | - |
| Delete task | DELETE /tasks/:id | ✗ | ✗ | HIGH |
| ... | ... | ... | ... | ... |

### Git Operations
| Feature | Dashboard | CLI | Pi Ext | Critical |
|---------|-----------|-----|--------|----------|
| Git status | GET /git/status | ✗ | ✗ | HIGH |
| ... | ... | ... | ... | ... |

## Created Subtasks
1. KB-XXX: Task deletion CLI command
2. KB-XXX: Task retry CLI command
...

## Implementation Priority
1. Task deletion (cleanup essential)
2. Task retry (failed task recovery)
3. ...
```
