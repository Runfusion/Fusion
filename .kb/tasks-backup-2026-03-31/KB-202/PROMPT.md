# Task: KB-202 - Add CLI command `kb task logs <id> [--follow]` to view task agent execution logs

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan and Code)

**Assessment:** This is a self-contained CLI feature addition that follows established patterns in the codebase. It introduces new user-facing functionality but doesn't modify existing behavior or touch complex subsystems.
**Score:** 3/8 — Blast radius: 0, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add a `kb task logs <id>` CLI command that allows users to view agent execution logs for any task. This is essential for debugging failed tasks and understanding what the AI agent did during execution. The command should support viewing historical logs, streaming new entries in follow mode (like `tail -f`), filtering by entry type, and limiting output to the most recent entries.

## Dependencies

- **Task:** KB-182 (completed) — Gap analysis identified this feature as critical

## Context to Read First

Read these files to understand existing CLI patterns and how agent logs are stored:

1. **`packages/cli/src/bin.ts`** — CLI command routing and help text structure
2. **`packages/cli/src/commands/task.ts`** — Existing task command implementations (e.g., `runTaskShow`, `runTaskLog`)
3. **`packages/cli/src/commands/task.test.ts`** — Test patterns for task commands
4. **`packages/core/src/store.ts`** — `TaskStore.getAgentLogs(taskId)` method (around line 1450)
5. **`packages/core/src/types.ts`** — `AgentLogEntry` type definition and `AgentLogType` union (line 71: `export type AgentLogType = "text" | "tool" | "thinking" | "tool_result" | "tool_error"`)

## File Scope

- `packages/cli/src/bin.ts` — Add command routing and help text
- `packages/cli/src/commands/task.ts` — Implement `runTaskLogs()` function
- `packages/cli/src/commands/task.test.ts` — Add tests for the new command
- `.changeset/add-task-logs-cli.md` — Changeset file (minor bump for new CLI feature)

## Steps

### Step 1: Implement `runTaskLogs()` in task.ts

- [ ] Add `runTaskLogs(id: string, options: LogsOptions)` function to `packages/cli/src/commands/task.ts`
- [ ] Use `store.getAgentLogs(id)` to fetch historical entries
- [ ] Format output with timestamps (locale time string, like `runTaskShow`)
- [ ] Format different entry types distinctly:
  - `text`: Display with neutral color/format (just the text content)
  - `thinking`: Display in dim/gray (thinking blocks are internal reasoning)
  - `tool`: Display as `[TOOL] toolName` with detail (args summary)
  - `tool_result`: Display as `[RESULT] toolName` with detail (result summary)
  - `tool_error`: Display as `[ERROR] toolName` with detail in red/error styling
- [ ] Optionally display `agent` role (triage/executor/reviewer/merger) if present on entry
- [ ] Support `--limit <n>`: Show only last N entries (default: 100, max: 1000)
- [ ] Support `--type <type>`: Filter entries by type (text | thinking | tool | tool_result | tool_error)
- [ ] Support `--follow` flag: Watch the log file and stream new entries as they arrive
- [ ] Handle errors gracefully:
  - Task not found: Print error message and exit code 1
  - No logs available: Print "No agent logs found for {id}" (not an error, just info)
- [ ] When following, handle Ctrl+C gracefully (clean exit message after unwatching file)

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified — new `runTaskLogs` function)

**Follow Mode Implementation Notes:**
- The agent.log file is at `.fusion/tasks/{id}/agent.log` (JSONL format)
- Use `fs.watchFile()` with a callback that reads new file content
- Store the watcher reference returned by `fs.watchFile()`
- Keep track of the last read file position to only parse new lines
- Register a SIGINT handler that calls `fs.unwatchFile()` on the watcher before exiting
- In follow mode, print new entries as they arrive with the same formatting
- Stop watching and exit cleanly when process receives SIGINT (Ctrl+C)

### Step 2: Add CLI Command Routing and Help Text

- [ ] In `packages/cli/src/bin.ts`, add import for `runTaskLogs` from the dynamic import at the top
- [ ] Add case for "logs" subcommand in the task switch statement (after the "log" case)
- [ ] Parse `--follow`, `--limit`, and `--type` flags from args
- [ ] Call `runTaskLogs(id, { follow, limit, type })` with parsed options
- [ ] Add `kb task logs <id>` to the HELP text in the appropriate location (group with other task commands)
- [ ] Include flag documentation in HELP:
  ```
  kb task logs <id> [--follow] [--limit <n>] [--type <type>]
  ```

**Artifacts:**
- `packages/cli/src/bin.ts` (modified — new command routing and help text)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add comprehensive tests in `packages/cli/src/commands/task.test.ts`
- [ ] Test basic log display with various entry types
- [ ] Test `--limit` flag behavior
- [ ] Test `--type` filter behavior
- [ ] Test task not found error handling
- [ ] Test "no logs available" case
- [ ] Mock `fs.watchFile` and `fs.unwatchFile` for follow mode testing:
  - Verify `fs.watchFile` is called when `--follow` is set
  - Verify `process.on('SIGINT', ...)` handler is registered
  - Verify `fs.unwatchFile` is called in the SIGINT handler
- [ ] Run full CLI test suite: `cd packages/cli && pnpm test`
- [ ] Fix all failures
- [ ] Run typecheck: `cd packages/cli && pnpm typecheck`

**Test Patterns to Follow:**
See existing tests in `task.test.ts`:
- Mock `TaskStore` using `vi.mock("@kb/core", ...)`
- Mock `console.log` and `console.error` to capture output
- Use `vi.spyOn(process, "exit")` for error cases
- Mock `fs` module for file watching tests

**Artifacts:**
- `packages/cli/src/commands/task.test.ts` (modified — new test suite for `runTaskLogs`)

### Step 4: Documentation & Delivery

- [ ] Create changeset file: `.changeset/add-task-logs-cli.md`
- [ ] Update relevant documentation (CLI help text is the primary docs)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

**Changeset Content:**
```markdown
---
"@dustinbyrne/kb": minor
---

Add `kb task logs <id> [--follow] [--limit <n>] [--type <type>]` command to view task agent execution logs. Supports streaming new entries with --follow flag.
```

## Entry Type Formatting Reference

Based on `AgentLogEntry` type from `packages/core/src/types.ts` (line 71):

| Type | Display Format | Example |
|------|---------------|---------|
| `text` | `HH:MM:SS text...` | `14:32:10 Analyzing the codebase...` |
| `thinking` | Dimmed `HH:MM:SS [THINK] text...` | `14:32:11 [THINK] Let me consider...` |
| `tool` | `HH:MM:SS [TOOL] toolName` (with detail) | `14:32:15 [TOOL] read path/to/file.ts` |
| `tool_result` | `HH:MM:SS [RESULT] toolName` | `14:32:16 [RESULT] read` |
| `tool_error` | `HH:MM:SS [ERROR] toolName` (red) | `14:32:17 [ERROR] read File not found` |

**Valid AgentLogType values:** `"text" | "tool" | "thinking" | "tool_result" | "tool_error"`

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Typecheck passes
- [ ] `kb task logs --help` shows appropriate usage (via main HELP text)
- [ ] Changeset file created
- [ ] Manual verification: Create a task, let it run (or add manual log entries), verify `kb task logs KB-XXX` displays formatted logs

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-202): complete Step N — description`
- **Bug fixes:** `fix(KB-202): description`
- **Tests:** `test(KB-202): description`

## Do NOT

- Modify the `AgentLogEntry` type or `TaskStore.getAgentLogs()` method — use existing APIs
- Add dependencies on external packages for CLI formatting (chalk, etc.) — use built-in ANSI codes if needed
- Implement follow mode using busy-waiting (polling) — use `fs.watchFile`/`fs.unwatchFile`
- Skip testing the follow mode cleanup (file watcher leaks are problematic)
- Change existing CLI command behavior
- Modify the dashboard API routes — this is CLI-only
