# Engine Session-Scoped Tools

This reference documents tools injected by the engine at runtime for specific agent session types. Some shared workflow tools are also part of the public extension surface; use `references/extension-tools.md` as the canonical user-invokable extension reference and this page for runtime agent-role availability.

- Source files: `packages/engine/src/agent-tools.ts`, `triage.ts`, `executor.ts`, `merger.ts`, `agent-heartbeat.ts`
- Availability: only when the engine creates a session for the matching agent role
- Runtime contract: engine sessions now forward requested skill names (`skillSelection.requestedSkillNames`) into the generic runtime `skills` field so non-pi runtimes can still receive Fusion skill intent.
- Important: do not tell users to call runtime-only tools directly from the generic extension tool list

## Shared runtime tools (`agent-tools.ts`)

| Tool | Agent Types | Purpose | Parameters |
|---|---|---|---|
| `fn_task_create` | triage, executor, heartbeat | Create a follow-up task from within an agent run | `description` (string), `dependencies?` (string[]), `priority?` (`low` \| `normal` \| `high` \| `urgent`), `workflow_id?` (string) |
| `fn_task_log` | executor, heartbeat | Write significant task log entries | `message` (string), `outcome?` (string) |
| `fn_task_document_write` | triage, executor, heartbeat; chat/planning (explicit `task_id`) | Save/update a named task document revision | `key` (string), `content` (string), `author?` (string); chat/planning also require `task_id` (string) |
| `fn_task_document_read` | triage, executor, heartbeat; chat/planning (explicit `task_id`) | Read one task document or list all | `key?` (string); chat/planning also require `task_id` (string) |
| `fn_task_prompt_write` | plan/spec review (Plan Review reviewer) | Replace the task's authoritative PROMPT.md with revised plan/spec content during Plan Review/spec repair; routed through TaskStore so PROMPT.md validation and task.json sync stay the single persistence path. Provide the complete final PROMPT.md content; do not implement product code from plan review | `content` (string) |
| `fn_goal_list` | triage, executor, heartbeat | List goals with concise citation-ready snippets and active-goal warning details | `status?` (`active` \| `archived` \| `all`) |
| `fn_goal_show` | triage, executor, heartbeat | Show one goal's full detail on demand, including the full description body | `id` (string) |
| `fn_workflow_list` | executor | List the project's custom workflows (read-only built-ins plus user definitions) | none |
| `fn_workflow_get` | executor | Fetch one workflow definition by id — name, description, builtin flag, and the full IR (nodes/edges/columns/artifacts/fields/settings) as JSON | `workflow_id` (string) |
| `fn_workflow_select` | executor | Assign a custom workflow to a task (defaults to the current task) | `workflow_id` (string), `task_id?` (string) |
| `fn_workflow_create` | executor | Create a custom workflow definition from a graph IR (validated server-side). v2 IR supports step-inversion constructs: `parse-steps`, `foreach` (mode/isolation/concurrency/maxReworkCycles), `step-execute`, `step-review`, `code` nodes, `rework` edges, plus `artifacts`, custom `fields`, and typed `settings` declarations | `name` (string), `description?` (string), `ir` (object), `layout?` (object) |
| `fn_workflow_update` | executor | Update a custom workflow definition's name/description/ir/layout (built-ins cannot be edited; same step-inversion IR constructs as create; editing `fields` orphans rather than destroys existing task values; editing `settings` declarations drops orphaned setting values on resolution) | `workflow_id` (string), `name?` (string), `description?` (string), `ir?` (object), `layout?` (object), `rehome_to?` (string) |
| `fn_workflow_delete` | executor | Delete a custom workflow definition (built-ins cannot be deleted); selecting tasks are re-homed to the default workflow's entry column | `workflow_id` (string) |
| `fn_workflow_settings` | executor | Read/write a workflow's per-`(workflow, project)` setting **values** (`get` returns `{stored, effective, orphaned}`; `set` writes `values` and returns `{stored, effective, orphaned}`, with `null` clearing an override — including any stored value for an orphaned key). Validated against the named workflow's declared settings; built-in **values** are writable though built-in **declarations** are not; invalid values return a typed rejection list and persist nothing | `action` (`get` \| `set`), `workflow_id` (string), `values?` (object keyed by setting id) |
| `fn_workflow_list` | executor, chat, planning | List the project's custom workflows (read-only built-ins plus user definitions) | none |
| `fn_workflow_get` | executor, chat, planning | Fetch one workflow definition by id — name, description, builtin flag, and the full IR (nodes/edges/columns/artifacts/fields) as JSON | `workflow_id` (string) |
| `fn_workflow_select` | executor, chat, planning | Assign a custom workflow to a task (defaults to the current task) | `workflow_id` (string), `task_id?` (string) |
| `fn_workflow_create` | executor, chat, planning | Create a custom workflow definition from a graph IR (validated server-side). v2 IR supports step-inversion constructs: `parse-steps`, `foreach` (mode/isolation/concurrency/maxReworkCycles), `step-execute`, `step-review`, `code` nodes, `rework` edges, plus `artifacts` and custom `fields` declarations | `name` (string), `description?` (string), `ir` (object), `layout?` (object) |
| `fn_workflow_update` | executor, chat, planning | Update a custom workflow definition's name/description/ir/layout (built-ins cannot be edited; same step-inversion IR constructs as create; editing `fields` orphans rather than destroys existing task values) | `workflow_id` (string), `name?` (string), `description?` (string), `ir?` (object), `layout?` (object), `rehome_to?` (string) |
| `fn_workflow_delete` | executor, chat, planning | Delete a custom workflow definition (built-ins cannot be deleted); selecting tasks are re-homed to the default workflow's entry column | `workflow_id` (string) |
<!-- FNXC:SkillSync 2026-06-17-23:05: Engine session-scoped `fn_*` tools registered in `packages/engine` must be mirrored in this reference because `packages/cli/src/__tests__/skill-sync.test.ts` treats the backticked tool names here as the documentation source of truth and fails the CLI + gate suites on drift. -->
| `fn_ask_question` | chat | Ask the user a structured question that renders as an interactive chat card; after calling it, end the turn and wait for the user's next message | `questions` (array of objects with `question`, optional `header`, optional `description`, optional `type`, optional `options`, optional `multiSelect`) |
| `fn_task_promote` | executor | Promote a held task out of a manual-release hold column (defaults to the current task) | `task_id?` (string) |
| `fn_task_file_scope_add` | executor | Add one or more repo-relative files/globs to this task's declared `## File Scope` when you must edit beyond the initial scope, so edits are not stranded by the scope-aware squash merge (merge-time cross-task overlap blocking remains the backstop) | `files` (string[]) |
| `fn_trait_list` | executor, chat, planning | List the registered column trait catalog (built-in and plugin traits) | none |
| `fn_memory_search` | triage, executor, heartbeat | Search project memory plus per-agent layered memory snippets | `query` (string), `limit?` (number) |
| `fn_memory_get` | triage, executor, heartbeat | Read a bounded memory file window (including bounded per-agent layered paths) | `path` (string), `startLine?` (number), `lineCount?` (number) |
| `fn_memory_append` | executor, heartbeat (when writable backend enabled) | Append memory notes with explicit scope: `scope="agent"` for private operating context, `scope="project"` for workspace-wide durable knowledge | `scope?` (`project` \| `agent`), `layer` (`long-term` \| `daily`), `content` (string) |
| `fn_web_fetch` | executor, step-session, reviewer, merger, triage, heartbeat | Lightweight HTTP fetch with HTML→text extraction, timeout/size caps, and SSRF guard (no JS rendering) | `url` (string), `prompt?` (string), `timeoutMs?` (number), `maxBytes?` (number) |
| `fn_research_run` | triage, executor | Start a bounded research run (optionally wait for completion) and return structured findings metadata | `query` (string), `wait_for_completion?` (boolean), `max_wait_ms?` (number) |
| `fn_research_list` | triage, executor | List recent research runs with status/summary metadata | `status?` (`pending` \| `running` \| `completed` \| `failed` \| `cancelled`), `limit?` (number) |
| `fn_research_get` | triage, executor | Read one research run's structured findings/citations payload | `id` (string) |
| `fn_research_cancel` | triage, executor | Cancel an active research run via orchestrator cancellation path | `id` (string) |
| `fn_read_evaluations` | heartbeat | Read the current agent's rating summaries, recent comments, and reflections | none |
| `fn_update_identity` | heartbeat | Update the current agent's own `soul`, `instructionsText`, or `memory` fields | `soul?` (string), `instructionsText?` (string), `memory?` (string) |
| `fn_reflect_on_performance` | executor, heartbeat (when reflection service enabled) | Generate reflection insights from prior runs | `focus_area?` (string) |
| `fn_list_agents` | triage, executor, heartbeat | List agents (optionally filtered) | `role?` (string), `state?` (string), `includeEphemeral?` (boolean) |
| `fn_delegate_task` | triage, executor, heartbeat | Create and assign a new task to a specific agent | `agent_id` (string), `description` (string), `dependencies?` (string[]), `workflow_id?` (string), `override?` (boolean) |
| `fn_get_agent_config` | executor, heartbeat | Read full config for a direct-report agent | `agent_id` (string) |
| `fn_update_agent_config` | executor, heartbeat | Update config fields for a direct-report, non-ephemeral agent | `agent_id` (string), optional: `soul`, `instructions_text`, `instructions_path`, `heartbeat_procedure_path`, `heartbeat_interval_ms`, `heartbeat_timeout_ms`, `max_concurrent_runs`, `message_response_mode` |
| `fn_agent_create` | executor, heartbeat | Create a non-ephemeral direct-report agent | `name` (string), `role` (string), optional: `soul`, `instructions_text`, `instructions_path`, `reportsTo`, `heartbeat_interval_ms`, `heartbeat_timeout_ms`, `max_concurrent_runs`, `message_response_mode` |
| `fn_agent_delete` | executor, heartbeat | Delete a non-ephemeral direct-report agent | `agent_id` (string), optional: `force` (boolean), `reassign_to` (string) |
| `fn_send_message` | executor, step-session, heartbeat | Send inbox messages to agents/users | `to_id` (string), `content` (string), `type?` (`agent-to-agent` \| `agent-to-user`), `reply_to_message_id?` (string) |
| `fn_read_messages` | executor, step-session, heartbeat | Read inbox messages | `unread_only?` (boolean), `limit?` (number) |
| `fn_post_room_message` | heartbeat | Post a message to a chat room the agent is a member of | `roomId` (string), `content` (string), `replyToMessageId?` (string), `mentions?` (string[]) |
| `fn_artifact_register` | triage, executor, heartbeat; chat/planning (explicit `task_id`) | Register an artifact (document, image, video, audio, or other) so other agents and tasks can discover it; image artifacts may provide `dataBase64` bytes for registry-managed media storage | `type` (string), `title` (string), `description?` (string), `mimeType?` (string), `uri?` (string), `content?` (string), `dataBase64?` (base64 string), `taskId?` (string); chat/planning also require `task_id` (string) |
| `fn_artifact_list` | triage, executor, heartbeat; chat/planning (explicit `task_id`) | List registered artifacts across agents and tasks with filters for type, authorId, taskId, search, limit, and offset | `type?` (string), `authorId?` (string), `taskId?` (string), `search?` (string), `limit?` (number), `offset?` (number); chat/planning also require `task_id` (string) |
| `fn_artifact_view` | triage, executor, heartbeat | View a registered artifact by id, including metadata and inline content or the uri/path reference for media artifacts | `id` (string) |

## Triage-only runtime tools (`triage.ts`)

| Tool | Purpose | Parameters |
|---|---|---|
| `fn_task_list` | List active tasks during specification (duplicate check, discovery) | none |
| `fn_task_search` | Keyword search tasks (including done/archived by default) for duplicate detection | `query` (string), `limit?` (number), `includeDone?` (boolean), `includeArchived?` (boolean) |
| `fn_task_show` | Fetch full task detail including PROMPT.md | `id` (string) |
| `fn_review_spec` | Spawn spec reviewer and return `APPROVE`/`REVISE`/`RETHINK`/`UNAVAILABLE` | none |

## Executor-only runtime tools (`executor.ts`)

Note: step-session execution (`step-session-executor.ts`) reuses executor coordination tools (`fn_send_message`, `fn_read_messages`, `fn_list_agents`, `fn_delegate_task`, task-document tools, and memory tools) so spawned/session-sliced execution keeps parity with main executor runs.

| Tool | Purpose | Parameters |
|---|---|---|
| `fn_task_update` | Update a spec step status (`pending`/`in-progress`/`done`/`skipped`), task dependencies, and/or workflow-defined custom field values | `step?` (number, 0-indexed; matches `### Step N:` in PROMPT.md, Step 0 = Preflight), `status?` (enum), `dependencies?` (string[]), `custom_fields?` (object keyed by field id; validated against the workflow field schema, `null` clears a field) |
| `fn_task_add_dep` | Add a dependency to current task (confirmation-gated) | `task_id` (string), `confirm?` (boolean) |
| `fn_task_done` | Mark task complete and optionally store summary | `summary?` (string) |
| `fn_review_step` | Spawn step plan/code reviewer | `step` (number, 0-indexed; matches `### Step N:` in PROMPT.md), `type` (`plan` \| `code`), `step_name` (string), `baseline?` (string) |
| `fn_spawn_agent` | Spawn child agent in separate worktree | `name` (string), `role` (enum), `task` (string) |
| `fn_acquire_repo_worktree` | Acquire an isolated git worktree for a sub-repo in a workspace task (workspace mode only) | `repo` (string — must be one of the workspace's configured repos) |

## Merger-only runtime tools (`merger.ts`)

| Tool | Purpose | Parameters |
|---|---|---|
| `fn_report_build_failure` | Explicitly signal merge-time build verification failure | `message` (string) |

## Heartbeat-only runtime tools (`agent-heartbeat.ts`)

| Tool | Purpose | Parameters |
|---|---|---|
| `fn_heartbeat_done` | Signal end of heartbeat run with optional summary | `summary?` (string) |

## Workflow settings: declarations vs. values

Workflow settings split into two surfaces (the same split as custom task fields, one level up):

- **Declarations** (the typed schema) live in the workflow IR's `settings` array and are authored with `fn_workflow_create` / `fn_workflow_update`. Built-in workflow declarations cannot be edited (the store's built-in guard rejects the IR edit with a `WorkflowIrError`/built-in error surfaced through the tool result).
- **Values** (the per-`(workflow, project)` data) are read/written with `fn_workflow_settings`. Built-in workflow **values** are writable so each project can tune `builtin:coding` differently.

Declare a setting (custom workflow):

```jsonc
// fn_workflow_create
{
  "name": "QA",
  "ir": {
    "version": "v2",
    "name": "QA",
    "columns": [{ "id": "intake", "name": "Intake", "traits": [] }],
    "nodes": [],
    "edges": [],
    "settings": [
      { "id": "reviewHandoffPolicy", "name": "Review handoff", "type": "enum",
        "default": "disabled",
        "options": [
          { "value": "disabled", "label": "Disabled" },
          { "value": "always", "label": "Always" }
        ] }
    ]
  }
}
```

Write a value (built-in workflow VALUE — accepted even though built-in declarations are read-only):

```jsonc
// fn_workflow_settings
{ "action": "set", "workflow_id": "builtin:coding",
  "values": { "workflowStepTimeoutMs": 600000, "reviewHandoffPolicy": "always" } }
```

An invalid value (e.g. an enum violation) is rejected with a typed list and persists nothing:

```jsonc
// returns isError:true with details.rejections:
// [{ "code": "enum-violation", "settingId": "reviewHandoffPolicy", "message": "..." }]
```

Read values — `effective` is what the engine actually consumes (declaration defaults filled in, orphaned values dropped); `stored` is the raw override map; `orphaned` lists stored entries with no current declaration (or a value that no longer validates). `set` returns the same `{stored, effective, orphaned}` shape:

```jsonc
// fn_workflow_settings
{ "action": "get", "workflow_id": "builtin:coding" }
// → { "workflowId": "builtin:coding",
//     "stored":    { "workflowStepTimeoutMs": 600000 },
//     "effective": { "workflowStepTimeoutMs": 600000, "reviewHandoffPolicy": "disabled", ... },
//     "orphaned":  [] }
```

Patching a key to `null` clears any stored value for it — including a value left behind under an orphaned key — so `set` doubles as the way to drop orphans. To see the full declaration catalog (every setting id, type, and default) call `fn_workflow_get` on `builtin:coding`, whose IR `settings` array is the canonical catalog.
