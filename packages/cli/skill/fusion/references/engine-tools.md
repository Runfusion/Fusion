# Engine Session-Scoped Tools

These tools are **not** part of the pi extension's user-invokable `extension.ts` surface. They are injected by the engine at runtime for specific agent session types.

- Source files: `packages/engine/src/agent-tools.ts`, `triage.ts`, `executor.ts`, `merger.ts`, `agent-heartbeat.ts`
- Availability: only when the engine creates a session for the matching agent role
- Important: do not tell users to call these directly from the generic pi extension tool list

## Shared runtime tools (`agent-tools.ts`)

| Tool | Agent Types | Purpose | Parameters |
|---|---|---|---|
| `fn_task_create` | triage, executor, heartbeat | Create a follow-up task from within an agent run | `description` (string), `dependencies?` (string[]) |
| `fn_task_log` | executor, heartbeat | Write significant task log entries | `message` (string), `outcome?` (string) |
| `fn_task_document_write` | triage, executor, heartbeat | Save/update a named task document revision | `key` (string), `content` (string), `author?` (string) |
| `fn_task_document_read` | triage, executor, heartbeat | Read one task document or list all | `key?` (string) |
| `fn_memory_search` | triage, executor, heartbeat | Search project/agent memory snippets | `query` (string), `limit?` (number) |
| `fn_memory_get` | triage, executor, heartbeat | Read a bounded memory file window | `path` (string), `startLine?` (number), `lineCount?` (number) |
| `fn_memory_append` | executor, heartbeat (when writable backend enabled) | Append long-term/daily memory notes | `scope?` (`project` \| `agent`), `layer` (`long-term` \| `daily`), `content` (string) |
| `fn_reflect_on_performance` | executor | Generate reflection insights from prior runs | `focus_area?` (string) |
| `fn_list_agents` | triage, executor, heartbeat | List agents (optionally filtered) | `role?` (string), `state?` (string), `includeEphemeral?` (boolean) |
| `fn_delegate_task` | triage, executor, heartbeat | Create and assign a new task to a specific agent | `agent_id` (string), `description` (string), `dependencies?` (string[]) |
| `fn_send_message` | executor, heartbeat | Send inbox messages to agents/users | `to_id` (string), `content` (string), `type?` (`agent-to-agent` \| `agent-to-user`), `reply_to_message_id?` (string) |
| `fn_read_messages` | executor, heartbeat | Read inbox messages | `unread_only?` (boolean), `limit?` (number) |

## Triage-only runtime tools (`triage.ts`)

| Tool | Purpose | Parameters |
|---|---|---|
| `fn_task_list` | List active tasks during specification (duplicate check, discovery) | none |
| `fn_task_get` | Fetch full task detail including PROMPT.md | `id` (string) |
| `fn_review_spec` | Spawn spec reviewer and return `APPROVE`/`REVISE`/`RETHINK`/`UNAVAILABLE` | none |

## Executor-only runtime tools (`executor.ts`)

| Tool | Purpose | Parameters |
|---|---|---|
| `fn_task_update` | Update a spec step status (`pending`/`in-progress`/`done`/`skipped`) | `step` (number), `status` (enum) |
| `fn_task_add_dep` | Add a dependency to current task (confirmation-gated) | `task_id` (string), `confirm?` (boolean) |
| `fn_task_done` | Mark task complete and optionally store summary | `summary?` (string) |
| `fn_review_step` | Spawn step plan/code reviewer | `step` (number), `type` (`plan` \| `code`), `step_name` (string), `baseline?` (string) |
| `fn_spawn_agent` | Spawn child agent in separate worktree | `name` (string), `role` (enum), `task` (string) |

## Merger-only runtime tools (`merger.ts`)

| Tool | Purpose | Parameters |
|---|---|---|
| `fn_report_build_failure` | Explicitly signal merge-time build verification failure | `message` (string) |

## Heartbeat-only runtime tools (`agent-heartbeat.ts`)

| Tool | Purpose | Parameters |
|---|---|---|
| `fn_heartbeat_done` | Signal end of heartbeat run with optional summary | `summary?` (string) |
