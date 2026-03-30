# Project Guidelines

## Finalizing changes

When making changes that affect published packages, create a changeset file:

```bash
cat > .changeset/<short-description>.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Short description of the change.
EOF
```

Bump types:

- **patch**: bug fixes, internal changes
- **minor**: new features, new CLI commands, new tools
- **major**: breaking changes

Include the changeset file in the same commit as the code change. The filename should be a short kebab-case description (e.g. `fix-merge-conflict.md`, `add-retry-button.md`).

Only create changesets for changes that affect the published `@dustinbyrne/kb` package — user-facing features, bug fixes, CLI changes, tool changes. Do NOT create changesets for internal docs (AGENTS.md, README), CI config, or refactors that don't change behavior.

## Package Structure

- `@kb/core` — domain model, task store (private, not published)
- `@kb/dashboard` — web UI + API server (private, not published)
- `@kb/engine` — AI agents: triage, executor, reviewer, merger, scheduler (private, not published)
- `@dustinbyrne/kb` — CLI + pi extension (published to npm)

Only `@dustinbyrne/kb` is published. The others are internal workspace packages.

## Testing

```bash
pnpm test          # run all tests
pnpm build         # build all packages
```

Tests are required. Typechecks and manual verification are not substitutes for real tests with assertions.

## Pi Extension (`packages/cli/src/extension.ts`)

The pi extension provides tools and a `/kb` command for interacting with kb from within a pi session. It ships as part of `@dustinbyrne/kb` — one `pi install` gives you both the CLI and the extension.

Update it when:

- **CLI commands change** — if `kb task create`, `kb task list`, `kb task show`, `kb task attach`, `kb task pause`, or `kb task unpause` change their behavior, flags, or output, update the corresponding tool in `packages/cli/src/extension.ts`.
- **Task store API changes** — the extension calls `TaskStore` directly (`createTask`, `listTasks`, `getTask`, `addAttachment`, `pauseTask`). If these methods change signature or behavior, update the extension.
- **New user-facing features** — if a new CLI command is added that the chat agent should be able to use (task creation, status checking, automation control), add a tool for it.

**Don't** add tools for engine-internal operations (move, step updates, logging, merge) — those are handled by the engine's own agents.

The extension has no skills — tool descriptions, `promptSnippet`, and `promptGuidelines` give the LLM everything it needs.

## Dashboard badge WebSockets

GitHub PR and issue badges in the dashboard now have a dedicated real-time WebSocket channel at `/api/ws`.

### Frontend hook: `packages/dashboard/app/hooks/useBadgeWebSocket.ts`

Use `useBadgeWebSocket()` when a UI surface needs live badge snapshots for specific tasks.

- The hook uses a **shared singleton socket** so multiple `TaskCard` instances do not open duplicate WebSocket connections.
- Subscribe with `subscribeToBadge(taskId)` only when the card is visible and already has `prInfo` and/or `issueInfo`.
- Always pair subscriptions with `unsubscribeFromBadge(taskId)` on unmount or when the card leaves the viewport.
- Treat websocket payloads as **timestamped badge snapshots**. Merge them with task data using freshness comparisons so stale cached websocket data does not override newer SSE/task state.
- Preserve omitted fields on partial updates; only treat explicit `null` payloads as badge clears.

### Server-side expectations

- `/api/ws` is badge-specific; do **not** reuse it for general task updates.
- Badge broadcasts should contain only `prInfo` / `issueInfo` snapshot data, never full task objects.
- Badge updates are now **push-based via GitHub App webhooks** at `POST /api/github/webhooks`.
- The server verifies webhook signatures using `KB_GITHUB_WEBHOOK_SECRET`, fetches canonical badge state with GitHub App installation tokens, and broadcasts updates via the existing `task:updated` → `/api/ws` bridge.
- Keep the existing 5-minute refresh endpoints (`/api/tasks/:id/pr/status`, `/api/tasks/:id/issue/status`) as a fallback path when webhook delivery is unavailable.

## Git

- Commit messages: `feat(KB-XXX):`, `fix(KB-XXX):`, `test(KB-XXX):`
- One commit per step (not per file change)
- Always include the task ID prefix

## Settings

The following settings are available in the kb configuration (stored in `.kb/config.json`):

### `autoResolveConflicts` (default: `true`)

When enabled, the auto-merge system will intelligently resolve common merge conflict patterns without requiring manual intervention:

- **Lock files** (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Gemfile.lock`, etc.) — automatically resolved using the current branch's version ("ours")
- **Generated files** (`*.gen.ts`, `dist/*`, `coverage/*`, etc.) — automatically resolved using the branch's fresh generation ("theirs")
- **Trivial conflicts** (whitespace-only differences) — automatically resolved

When a merge encounters conflicts and the AI agent fails to resolve them on the first attempt, the system implements a 3-attempt retry logic with escalating strategies:

1. **Attempt 1**: Standard merge with AI agent using full context
2. **Attempt 2**: Auto-resolve lock/generated files, then retry AI with simplified context
3. **Attempt 3**: Use `git merge -X theirs` strategy for remaining conflicts

If all 3 attempts fail, the task remains in "in-review" for manual resolution. The per-task retry counter (`mergeRetries`) tracks how many attempts have been made.

To disable automatic conflict resolution and require manual intervention for all conflicts:

```json
{
  "settings": {
    "autoResolveConflicts": false
  }
}
```

### `smartConflictResolution` (default: `true`)

Alias for `autoResolveConflicts`. When enabled, enables automatic resolution of:
- Lock files using "ours" strategy (keep current branch's version)
- Generated files using "theirs" strategy (keep branch's fresh generation)  
- Trivial whitespace conflicts via `git diff-tree -w`

This setting is preferred for new configurations. If both settings are present, `smartConflictResolution` takes precedence.

### `requirePlanApproval` (default: `false`)

When enabled, AI-generated task specifications require manual approval before the task can move from "triage" to "todo". 

**How it works:**
- After the AI reviewer approves a specification, instead of automatically moving to "todo", the task remains in "triage" with status `"awaiting-approval"`
- Users can review the PROMPT.md in the task detail modal
- Users can click "Approve Plan" to move the task to "todo" and begin execution
- Users can click "Reject Plan" to discard the specification and trigger regeneration

To enable manual plan approval:

```json
{
  "settings": {
    "requirePlanApproval": true
  }
}
```

### `ntfyEnabled` (default: `false`)

When true, enables ntfy.sh push notifications for task completion and failures.

**Notification events:**
- Task moves to "in-review" — "Task completed — ready for review"
- Task moves to "done" — "Task merged to main"
- Task status becomes "failed" — "Task failed" (high priority)

**Configuration:**
1. Go to https://ntfy.sh and pick a unique topic name (or self-host ntfy)
2. Open dashboard Settings → Notifications
3. Enable notifications and enter your topic name
4. Install the ntfy app on your phone/desktop and subscribe to your topic

```json
{
  "settings": {
    "ntfyEnabled": true,
    "ntfyTopic": "my-kb-notifications"
  }
}
```

**Notes:**
- No authentication required for public topics (keep it simple)
- Topic must be 1–64 alphanumeric/hyphen/underscore characters
- Notifications are best-effort: failures are logged but don't block task execution

### `worktreeNaming` (default: `"random"`)

Controls how worktree directory names are generated when `recycleWorktrees` is NOT enabled. This setting only affects fresh worktrees (not pooled/recycled ones).

**Valid values:**
- `"random"` — Human-friendly random names like `swift-falcon`, `calm-river` (default)
- `"task-id"` — Use the task ID as the directory name, e.g., `kb-042`
- `"task-title"` — Use a slugified version of the task title, e.g., `fix-login-bug`

**Example:**
```json
{
  "settings": {
    "worktreeNaming": "task-id"
  }
}
```

**Notes:**
- This setting has no effect when `recycleWorktrees` is enabled (pooled worktrees retain their existing names)
- Task branches are always named `kb/{task-id}` regardless of this setting
- When using `"task-title"` mode, special characters are replaced with hyphens and the result is lowercased

## Per-Task Model Overrides

The kb dashboard allows overriding the global AI model selection on a per-task basis. This enables using different models for different types of work without changing global settings.

### How It Works

Each task can optionally specify:
- **Executor Model**: The AI model used to implement the task (executor agent)
- **Validator Model**: The AI model used to review code and plans (reviewer agent)

When not specified, tasks use the global default settings (`defaultProvider`/`defaultModelId`).

### Setting Per-Task Models

In the dashboard, open any task's detail modal and click the **Model** tab. Select models from the dropdown:
- **Use default**: Uses the global default model (shown when no override is set)
- **Specific model**: Override with a chosen provider/model combination

Both provider and model ID must be selected together — selecting only one is treated as "not set" and falls back to defaults.

### Storage

Per-task model overrides are stored in the task's `task.json`:
```json
{
  "modelProvider": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "validatorModelProvider": "openai",
  "validatorModelId": "gpt-4o"
}
```

To clear overrides, select "Use default" for both fields and save.

### Engine Behavior

- **Executor**: When both `modelProvider` and `modelId` are set on a task, the executor uses those instead of global settings when creating the agent session.
- **Reviewer**: When both `validatorModelProvider` and `validatorModelId` are set, the reviewer uses those instead of global settings. The validator model is passed via `ReviewOptions` to `reviewStep()`.

### Limitations

- Triage (task specification) always uses global defaults — per-task overrides apply only to execution and review
- Both provider and modelId must be set together; partial configuration falls back to defaults

## Archive Cleanup

Archived tasks can be cleaned up from the filesystem to reduce storage overhead while preserving the ability to restore them later.

### Storage Pattern

When a task is archived and cleaned up:
1. A compact entry is written to `.kb/archive.jsonl` (JSON Lines format)
2. The task directory (`task.json`, `PROMPT.md`, `agent.log`, attachments) is removed
3. The archive entry contains all metadata needed to restore the task

The archive log is append-only and survives TaskStore reinitialization.

### Archive Entry Format

Each line in `archive.jsonl` is a JSON object containing:
- `id`, `title`, `description`, `column` (always "archived")
- `dependencies`, `steps`, `currentStep`
- `size`, `reviewLevel`, `prInfo`, `issueInfo`
- `attachments` (metadata only, no file content)
- `log` (task log entries)
- `createdAt`, `updatedAt`, `columnMovedAt`, `archivedAt`
- Model overrides: `modelProvider`, `modelId`, `validatorModelProvider`, `validatorModelId`

**Explicitly excluded:** `agent.log` content (can be large, not needed for restoration)

### API

- `archiveTask(id, cleanup)` — Archive with optional immediate cleanup
- `archiveTaskAndCleanup(id)` — Convenience method for archive + cleanup
- `cleanupArchivedTasks()` — Bulk cleanup of all archived tasks with directories
- `readArchiveLog()` — Parse all archive entries
- `findInArchive(id)` — Find specific task in archive
- `unarchiveTask(id)` — Restore from archive if directory is missing

### Restoration Behavior

When `unarchiveTask()` is called:
1. If task directory exists: normal unarchive (column "archived" → "done")
2. If directory missing: restore from archive entry first, then unarchive
3. Restored tasks have:
   - All metadata preserved
   - `column` set to "done" (was "archived" in the log)
   - `PROMPT.md` regenerated with preserved steps
   - Empty `attachments/` directory (files intentionally lost)
   - No `agent.log` (intentionally lost during archive)
   - Log entry: "Task restored from archive"

### Cleanup Behavior

- `cleanupArchivedTasks()` iterates all "archived" column tasks
- Skips tasks already cleaned up (directory gone)
- Writes archive entry atomically before directory removal
- Can be called idempotently
