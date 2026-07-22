# Agents

[← Docs index](./README.md)

Fusion uses multiple agent roles for planning, execution, review, and merge workflows.

<!--
FNXC:WorkflowRouting 2026-06-22-12:00:
Agent-facing docs must preserve the workflow movement boundary: agents can assign workflows when the user explicitly asked or when creating a task, while executors cannot reroute the task under execution on their own initiative.

FNXC:WorkflowRouting 2026-06-30-09:20:
Permanent agents and the published extension now have governed workflow authoring, settings, trait-inspection, and selection tools; docs must describe the broad tool surface while preserving the narrow routing permission boundary.

FNXC:WorkflowAuthoringTools 2026-07-12-00:00:
Workflow validation is a read-only authoring support tool: agents can run the create/update validator and inspect typed failures, but the tool must not persist workflow rows or count as a mutation gate.
-->

## CLI session actions

The dashboard's CLI session banner uses authenticated `POST /api/cli-sessions/:id/*` routes for task-bound CLI sessions. `POST /api/cli-sessions/:id/relaunch` is project-scoped, rejects sessions that do not have a `taskId`, records a relaunch intent, and lets the engine listener clear resume linkage before moving the owning task back to `todo` for a fresh executor launch. This route backs the `resume-exhausted` banner's **Relaunch fresh** action; when a session summary has no `cliSessionId`, the client does not call the route.

## Interactive CLI Chat

Use `fn chat` to message an agent from your terminal.

### Synopsis

```bash
fn chat <agent-id> [message…] [--once] [--non-interactive] [--poll-ms <n>] [--reply-timeout-ms <n>] [--conversation-id <id>]
```

### Behavior

- `fn chat <agent-id>` opens an interactive mailbox-conversation REPL.
- Each message is stored as a `user-to-agent` MessageStore message from `cli` with `metadata.wakeRecipient=true`, `metadata.kind="cli-chat"`, and a durable `metadata.conversationId`.
- CLI chat is MessageStore mail plus polling, not a token-streaming SSE session. Replies are printed only when they carry the active conversation ID or reply to a known thread message.
- On a direct-message reply, agents must pass `reply_to_message_id` and either set `to_id` to the exact `[from: type:id]` value reported by `fn_read_messages` (including `cli`) or omit it to use the safe parent-sender default. Parent-derived routing is allowed only when the parent was addressed to the replying agent; an explicit `to_id` remains available for intentional forwarding.
- The default conversation ID is `cli-chat:cli:<agent-id>`; use `--conversation-id <id>` to name or share a different mailbox thread.
- One-shot replies have a deadline independent of `--poll-ms`; polling sleeps are capped at the remaining deadline. The interactive REPL maintains one pending deadline per outbound message, reports and clears an unanswered request, then continues to receive later replies.
- Dashboard-created agent chat sessions request the target agent's declared `metadata.skills` plus enabled plugin-contributed skills, forwarding both requested skill names and resolved plugin body directories so skills such as `ce-debug` are available in chat when the contributing plugin is enabled for the requesting project. Model-only QuickChat sessions request enabled plugin skills, and room responder sessions request the responder agent's skills.
- Agent-acting session lanes share the same skill-injection contract as executor sessions: executor, merger, triage, reviewer, heartbeat, step-session, dashboard chat/room responders, CLI agent execution, planning, mission interview, milestone/slice interview, agent-onboarding interview, workflow design, memory dreams/insight extraction, and scheduled cron automation all request agent/fallback skills plus enabled plugin-contributed skills when a plugin runner is available. Utility-only lanes that only summarize/extract/generate JSON (title/PR summaries, memory compaction, subtask breakdown, text refinement, agent generation, PR metadata generation, evaluator/research synthesis, and similar one-shot helpers) intentionally stay exempt to avoid loading skills where no agent-style tool loop can use them.
- In dashboard model-loop chat (main chat, QuickChat, and room responders), typing `/skill:{name}` requests that skill for the current AI session and strips the slash token from the prompt sent to the model. Slash and catalog-style names such as `/skill:review/pr`, `/skill:review/pr/SKILL.md`, and `source::skills/review/pr/SKILL.md` resolve to the matching discovered bare skill token across chat and agent session lanes. The requested skill is still subject to the normal enabled/disabled execution-skill filters; CLI-agent-backed PTY chat keeps raw terminal input semantics and does not interpret this command.
- Dashboard chat and planning sessions with a scoped task store expose `fn_task_document_write`, `fn_task_document_read`, and `fn_task_logs_read`; because neither lane has an ambient task, each tool requires an explicit `task_id`. `fn_task_logs_read` pages the persisted full agent log for failure analysis.
- Dashboard chat and room responders share a safe coordination/productivity toolset across pi and Grok CLI runtimes: board reads, task creation, delegation, agent listing/configuration, web fetch, and goal/memory/research retrieval. Destructive agent-lifecycle tools and memory append remain excluded because chat has no action-gate context.
- Agent workflow-routing tools follow an intent boundary: agents may select or change a task workflow only when the user explicitly requested that workflow or when the agent created the task. Executors must not call `fn_workflow_select` to reroute the task they are executing unless the task instructions or a user steering comment explicitly asks for the workflow change. Lanes without an ambient task, including dashboard chat/planning and published/pi extension calls outside a task, must pass an explicit `task_id`; task-bound executor paths may default to the current task.
- Executor, heartbeat, and dashboard chat sessions expose artifact registry tools so agents can publish and inspect multi-type deliverables without relying on the dashboard gallery. Planning sessions intentionally exclude artifact tools until they can thread the existing `MessageStore` dependency.
- Permanent/custom heartbeat agents and the published/pi extension receive the broad coordination and work-discovery tool surface instead of a narrowly curated subset: read-only task discovery (`fn_task_list`, `fn_task_show`, `fn_task_search`) for work discovery and duplicate avoidance, workflow discovery and authoring (`fn_workflow_list`, `fn_workflow_get`, `fn_workflow_validate`, `fn_workflow_create`, `fn_workflow_update`, `fn_workflow_delete`, `fn_workflow_settings`, `fn_trait_list`), governed research (`fn_research_run`, `fn_research_list`, `fn_research_get`, `fn_research_cancel`), structured clarification (`fn_ask_question`), artifact, memory, messaging, goal, evaluation, identity, and delegation tools. Task-scoped heartbeat sessions also expose current-task workflow selection and promotion (`fn_workflow_select`, `fn_task_promote`); no-task heartbeats omit those because they have no ambient task, while no-task extension/chat/planning lanes expose `fn_workflow_select` but require explicit `task_id`. Workflow creation, updates, settings writes, deletion, and selection remain permission-gated task/agent mutations even when the tools are exposed in the lane. Prompt-injectable lanes strip workflow approval-bypass flags during `fn_workflow_create`/`fn_workflow_update`; executor-owner paths are the only authoring path that may preserve those flags. Executor-only worktree/workspace tools such as `fn_run_verification` and `fn_acquire_repo_worktree` remain out of the ambient heartbeat lane until that lane owns the required worktree/workspace context. The task read tools are store-backed, text-only, and action-gate-recognized as read-only; dangerous actions are controlled at invocation time by each agent's `AgentPermissionPolicy` through the action gate (allow / require approval / block), not by withholding governed tools from the session.
- `agent.taskId` is an active-execution linkage, not durable ownership. It may legitimately point at a `todo`/`triage` task only while the agent has live run or executor-active proof; task-move sync and self-healing clear stale parked, terminal, or unresolved links otherwise. `fn_list_agents` and `fn_agent_show` therefore include column context in the human-readable `Current Task` line, such as `(triage)`, `(in-progress)`, `(not active — done)`, or `(unresolved)`, so coordinators can distinguish transient planning ownership from drift.
- `fn_agent_show` prints `Last Error`, `Pause Reason`, and compact `Error Recovery` counter details when present. `fn_list_agents` prints the same diagnostics only for agents currently in `error` or `paused`, keeping healthy rows compact while making durable-agent recovery state inspectable without direct DB/log access.

### Artifact registry tools

Artifact tools operate on the shared artifact registry, so artifacts are visible across agents and tasks when the caller has the artifact ID or can discover it through filters.

- `fn_artifact_register` registers a `document`, `image`, `video`, `audio`, or `other` artifact with `title`, optional `description`, optional `mimeType`, and exactly one payload source: inline text `content`, a local file `path` (preferred for media the agent saved to disk — screenshots, wireframes, mockups, screen recordings, PDF exports; the file is copied into managed artifact storage with MIME inference and image/video/PDF signature validation), base64 `dataBase64` image bytes, or a `uri` reference for media stored elsewhere. HTML mockups register as `type="document"` + `mimeType="text/html"` (inline `content` or `path`) and render as live sandboxed previews in the Artifacts view; PDFs (`mimeType="application/pdf"`, `path`) open in an embedded viewer; videos stream with range-request seeking. Executor sessions resolve relative `path` values against the task worktree and default `taskId` to the executing task; task-scoped heartbeat sessions resolve relative `path` values against the acquired heartbeat worktree and default `taskId` to the assigned task; dashboard chat uses the `dashboard-chat` author and requires `task_id` because chat has no ambient task. `path` values are containment-checked before any file read: the realpath-canonicalized file must stay inside the session's workspace directory (`baseDir`) or the OS temp directory (where browser/screenshot tooling writes captures); relative paths are rejected outright in lanes without a workspace directory (dashboard chat, no-task heartbeats), which are bounded to tmpdir-only absolute paths.
- `fn_artifact_list` lists artifacts across agents and tasks with optional `type`, `authorId`, `taskId`, `search`, `limit`, and `offset` filters. Dashboard chat's scoped variant requires `task_id` and otherwise supports `type`, `authorId`, `search`, `limit`, and `offset` for that task.
- `fn_artifact_view` fetches one artifact by `id`, returning registry metadata plus inline `content` when present or the stored `uri`/path reference for media artifacts.
- Successful registration emits a best-effort `system` → `user` inbox notification to `DASHBOARD_USER_ID` with `artifactId`, `artifactType`, `title`, `authorId`, and optional `taskId` metadata. Notification delivery failures are logged and must never fail or roll back the artifact registration.
- On first startup under Fusion `0.59.x`, the engine also sends one best-effort `system` → `user` inbox notice per project about the upcoming embedded-Postgres storage migration, keyed by `metadata.kind = "postgres-migration-notice"` so restarts do not duplicate it.

For the user-facing gallery and notification UX, see [Artifacts View](./dashboard-guide.md#artifacts-view) and [Mailbox View](./dashboard-guide.md#mailbox-view). For storage layout and hydration semantics, see [Artifact registry](./storage.md#artifact-registry-fn-6777).

### Flags

- `--once` send one message and exit after first reply (or timeout)
- `--non-interactive` read full stdin to EOF as message body
- `--poll-ms <n>` override poll interval in milliseconds (default `1000`, or `FUSION_CHAT_POLL_MS`); sleeps never extend past the nearest reply deadline
- `--reply-timeout-ms <n>` set the per-reply deadline in milliseconds (default `60000`, or `FUSION_CHAT_REPLY_TIMEOUT_MS`)
- `--conversation-id <id>` override the default named mailbox conversation ID

### Examples

```bash
# Interactive chat session
fn chat agent-abc123

# One-shot message (positional content implies --once)
fn chat agent-abc123 "status update?"

# Scripted one-shot from stdin
printf "deploy report" | fn chat agent-abc123 --once --non-interactive
```

> Replies require a running engine for the same project (for example `fn` dashboard or `fn serve`).

## Agent configuration updates from agents

The `fn_agent_update` extension tool lets chat/extension callers update existing non-ephemeral agents in place instead of deleting and recreating them. It accepts `agent_id` plus any editable subset of:

- Identity fields: `name`, `role` (`triage`, `executor`, `reviewer`, `merger`, `engineer`, `custom`), `title`, `icon`, and `soul`.
- Instruction fields: `instructions_text`, `instructions_path`, and `heartbeat_procedure_path`.
- Hierarchy field: `reportsTo` as a manager agent ID/name; privileged CLI/user calls may pass `reportsTo: ""` to clear the manager.
- Heartbeat/runtime fields: `heartbeat_interval_ms`, `heartbeat_timeout_ms`, `max_concurrent_runs`, and `message_response_mode` (`immediate` or `on-heartbeat`). Runtime updates merge into the existing `runtimeConfig` and preserve unrelated keys.

At least one update field must be provided. The tool rejects missing targets, ephemeral/runtime agents, self-targeting, string/number limit violations (`soul` 10,000 chars, `instructions_text` 50,000 chars, path fields 500 chars, heartbeat interval ≥1000ms, heartbeat timeout ≥5000ms, max concurrent runs ≥1), missing managers, self-manager assignments, and hierarchy cycles before mutating storage. Successful calls persist through one `AgentStore.updateAgent` call, so normal config revision history records the full edit.

Authorization is scoped to the org hierarchy. When the caller is an agent (`ctx.agentId` is present), the target must already be one of that caller's direct or indirect reports; self-targeting, peer/unrelated targets, and ancestors are rejected. Reparenting must stay inside the caller's subtree: the new manager may be the caller or one of the caller's direct/indirect reports, but not an unrelated agent or ancestor. Direct CLI/user calls that do not carry `ctx.agentId` are treated as privileged operator actions and may update any non-ephemeral agent, including clearing `reportsTo`.

The legacy `fn_agent_set_instructions` extension tool remains available for backward compatibility and narrower instruction-only edits. It accepts:

- `agent_id` — target agent ID or resolvable agent name.
- `instructions_text` — optional inline instructions; pass an explicit empty string to clear `instructionsText`.
- `instructions_path` — optional markdown file path; pass an explicit empty string to clear `instructionsPath`.

At least one instruction field must be provided. The legacy tool uses the same direct/indirect-report authorization model for agent callers and persists changes through `AgentStore.updateAgent`, so instruction edits are captured as normal agent config revisions.

## Agent Field Parity Matrix

Every first-class editable agent field has a defined create/edit/import/template behavior. This ensures consistent round-tripping across all surfaces.

### Agent Model Fields

| Field | Create | Edit | Import | Notes |
|-------|--------|------|--------|-------|
| `name` | ✓ | ✓ | ✓ (from manifest) | Unique identifier |
| `role` | ✓ | ✓ | ✓ (mapped from manifest) | Agent capability |
| `metadata` | ✓ | ✓ | ✓ | Arbitrary key-value data |
| `title` | ✓ | ✓ | ✓ (from manifest) | Job title/description |
| `icon` | ✓ | ✓ | ✓ (from manifest) | Emoji or icon identifier |
| `imageUrl` | ✗ (set by avatar upload endpoint) | ✓ | ✗ | Uploaded avatar image URL (`/api/agents/:id/avatar`) |
| `reportsTo` | ✓ | ✓ | ✓ (from manifest) | Parent agent ID |
| `runtimeConfig` | ✓ | ✓ | ✗ | Heartbeat/budget config |
| `permissions` | ✓ | ✓ | ✗ | Capability flags |
| `permissionPolicy` | ✓ | ✓ | ✗ | Runtime action-gating policy for permanent and ephemeral agents (project default/fallback: `unrestricted`) |
| `instructionsPath` | ✓ | ✓ | ✗ | File-backed instructions path |
| `instructionsText` | ✓ | ✓ | ✓ (from manifest `instructionBody`) | Inline instructions |
| `soul` | ✓ | ✓ | ✗ | Personality/identity description |
| `memory` | ✓ | ✓ | ✓ (from manifest) | Per-agent accumulated knowledge |
| `bundleConfig` | ✓ | ✓ | ✗ | Structured instruction bundle |

### Agent Companies Manifest Fields

| Manifest Field | First-Class Agent Field | Fallback |
|---------------|------------------------|----------|
| `name` | `name` | — (required) |
| `title` | `title` | — |
| `icon` | `icon` | — |
| `role` | `role` (mapped to AgentCapability) | `custom` |
| `reportsTo` | `reportsTo` | — |
| `instructionBody` | `instructionsText` | — |
| `memory` | `memory` | — |
| `skills` | `metadata.skills` | — |

## Permission Policy Presets (Permanent and Ephemeral Agents)

`permissionPolicy` is a first-class persisted policy contract for **runtime action gating**, separate from role/capability authorization and separate from dashboard persona presets.

Built-in preset catalog:

- `unrestricted` (default) — all v1 runtime action categories are `allow`
- `approval-required` — all v1 runtime action categories are `require-approval`
- `locked-down` — all v1 runtime action categories are `block`

V1 runtime action categories:

- `git_write`
- `file_write_delete`
- `command_execution`
- `network_api`
- `task_agent_mutation`
- `review_gate_bypass` (FN-7728; governs the `fn_task_bypass_review` merge-gate override — the `unrestricted`/grant-all preset overrides it to `require-approval` instead of `allow`, stricter than the uniform preset disposition)
- `file_scope` (FN-7737; governs the `fn_task_file_scope_add` File Scope additional-approval action — stays on the UNIFORM per-preset disposition, so `unrestricted`/grant-all resolves it to `allow` like every other plain category)
- `none` (classifier-only read-only result; never stored as a policy rule key)

`permissionPolicy` uses the sensitive categories above (everything except `none`) plus optional exact `toolRules`, with the FN-3545 disposition contract:

- `allow`
- `block`
- `require-approval`

Exact tool overrides are stored as `toolRules: { [toolName]: disposition }` on either a per-agent `permissionPolicy` or the project `defaultAgentPermissionPolicy`. They apply before category rules, so a policy can block one governed tool such as `fn_task_create` while leaving the broader `task_agent_mutation` category set to `allow` for `fn_task_update` or workflow tools.

### Runtime gate v1 mapping (per tool invocation, all agent lifetimes)

The engine classifies tool calls by behavior (not namespace alone):

- `file_write_delete`: built-in `write` / `edit`, plus direct filesystem attach helpers like `fn_task_attach`; low-risk coordination/registration writes such as `fn_task_document_write` and `fn_artifact_register` are handled by the coordination-exempt/read-only allow-lists below rather than this category
- `command_execution`: built-in `bash` when not classified as mutating git, plus fn tools that run bounded subprocess/worktree acquisition flows such as `fn_run_verification` and `fn_acquire_repo_worktree`
- `git_write`: mutating git shell commands run via `bash`
- `network_api`: external/network-facing tools (for example `fn_research_run`, `fn_research_cancel`, `fn_web_fetch`, `worktrunk_install`; `fn_research_retry` is permanent-agent network-classified and remains action-gate read-only/exception behavior)
- `task_agent_mutation`: task/agent/workflow mutation tools (for example `fn_update_agent_config`, `fn_task_pause`, `fn_spawn_agent`, `fn_task_create`, `fn_task_update`, `fn_task_promote`, `fn_task_refine`, and workflow mutators such as `fn_workflow_create`, `fn_workflow_update`, `fn_workflow_delete`, `fn_workflow_settings`, `fn_workflow_select`; action-gate-only task coordination tools like `fn_delegate_task`, `fn_task_import_github`, and `fn_task_import_github_issue` use this category in action-gate evaluation)
- `review_gate_bypass` (FN-7728): the operator-only `fn_task_bypass_review` merge-gate override, classified via the shared `REVIEW_GATE_BYPASS_FN_TOOLS` set in `gating-classifications.ts` so both gate paths agree; never falls back to `task_agent_mutation` or the unrecognized-tool exempt fallback.
- `file_scope` (FN-7737): `fn_task_file_scope_add`, the tool an executing agent uses to extend its task's declared `## File Scope` beyond the initial spec at runtime, classified via the shared `FILE_SCOPE_FN_TOOLS` set in `gating-classifications.ts` so both gate paths agree; distinct from `task_agent_mutation`/`file_write_delete` and never falls back to the unrecognized-tool exempt fallback.
- Dashboard permission editors now show per-category example tools sourced from `AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES` in `@fusion/core`, exact-tool override controls, plus a read-only exempt-tools panel for coordination/messaging bypass tools.
- `none`: positively recognized read-only tools (`read`, `grep`, `find`, `ls`, list/show/get-style `fn_*` tools, plus permanent-agent coordination helpers like `fn_delegate_task`, `fn_task_import_github`, and `fn_task_import_github_issue`). Artifact tools mirror `fn_task_document_write` in the shipped allow-lists: `fn_artifact_register`, `fn_artifact_list`, and `fn_artifact_view` are present in `READONLY_FN_TOOLS` and `COORDINATION_EXEMPT_TOOLS`, so registration is treated as coordination/registry publication instead of a broad mutation approval.

`bash` git-write heuristic in v1:

- Mutating git operations include: `git add`, `commit`, `merge`, `rebase`, `cherry-pick`, `am`, `apply`, `stash`, `tag`, `push`, `reset`, `rm`, `mv`, `clean`, `worktree add/remove`, `checkout -b`, `switch -c`, `pull --rebase`, `restore --staged`, and branch/remote mutation forms.
- Read-only git operations include: `git status`, `diff`, `log`, `show`, `rev-parse`, `branch --show-current`, `branch` listing, and `remote -v`.

Unknown/unclassified tool fallback:

- In permanent-agent sessions, unknown tools default to `require-approval` (fail-safe).
- Category `none` only yields `allow` when the tool is positively recognized as read-only.
- Internal Fusion runtime coordination tools (heartbeat completion, logs, documents, messaging, structured user questions via `fn_ask_question`, evaluations, identity reflection, memory bookkeeping, and read-only discovery) are exempt by design and always allowed so permanent-agent heartbeats can complete. Exact `toolRules` do not make these heartbeat-critical tools configurable. `fn_task_create` is governed as `task_agent_mutation` in both action-gate and permanent-agent evaluation because it creates task rows; delegation/import tools remain governed in action-gate evaluation while the permanent-agent classifier still treats them as positively recognized `none` coordination primitives. Task field/status mutation via `fn_task_update` is also governed as `task_agent_mutation`.
- Operators can reload the in-memory exempt-tool registry at runtime via `POST /api/action-gate/reload` (optional body `{ "tools": string[] }`) to apply exemption-list updates without restarting the engine process.
- Canonical tool classification/exemption sets live in `packages/engine/src/gating-classifications.ts` and are shared by both action-gate paths.

Approval pause/resume lifecycle (FN-3548):

- Permanent-agent gating short-circuits `block` and `require-approval` actions before tool execution and returns structured non-success tool results.
- For `require-approval`, the engine creates/reuses a durable approval request and pauses execution with canonical `pauseReason: "awaiting-approval"`.
- If task-backed, the owning task is paused (`Task.paused=true`, `pausedByAgentId=<requester>`); the requesting agent is paused (`state="paused"`, `pauseReason="awaiting-approval"`). The task-detail **Paused by agent** indicator is context only: operators may still manually pause or unpause an agent-assigned task, and unpause clears the task pause latch.
- FN-7608: for `TaskExecutor`-backed sessions, a `wait-for-approval` gate outcome does more than mark the task/agent paused in the store — it actually suspends the in-flight executor session. `TaskExecutor.buildActionGateContext()`'s `pauseForApproval` fires `awaitAbortInFlightTaskWork(taskId, "awaiting-approval:...")` (fire-and-forget, not awaited inline, to avoid a self-deadlock against the tool call that triggered it) so the running LLM turn is aborted rather than continuing to probe for ungated workarounds. `wrapToolsWithActionGate()` invokes `pauseForApproval` on both the newly-created-request path and the reused-pending path (a repeated identical gated call reuses the pending request via `approvalDedupeKey` and still triggers the pause/suspend). Both canonical executor prompts (engine `EXECUTOR_SYSTEM_PROMPT`, core `EXECUTOR_PROMPT_TEXT`) carry a byte-identical carve-out stating that waiting on a pending approval is a legitimate turn end and that re-issuing the gated call, probing read-only equivalents, or routing around the block via other tools is forbidden. Heartbeat-driven sessions have no persistent in-flight session object to abort (each tick is a short bounded cycle), so pausing the task/agent there is already sufficient.
- Dedupe semantics by `approvalDedupeKey`: `pending` reuses the same request, `approved` allows exactly one execution and then marks request `completed`, `denied` stays blocked, `completed` requires a fresh request.
- HTTP decision endpoint resumes best-effort: `POST /api/approvals/:id/decision` with `{ decision: "approve" | "deny", comment? }` unpauses matching task/agent when they are paused for `awaiting-approval`.
- Approval API surface: `GET /api/approvals` (supports status/limit/offset and returns `{ requests, total, pendingCount }`), `GET /api/approvals/:id` (includes request context + audit/history), `POST /api/approvals/:id/decision`.
- Dashboard mailbox is the primary v1 resolution surface: approvals appear in the mailbox **Approvals** tab with pending/history views and inline approve/deny controls for pending requests.
- Dashboard mailbox entry points (Header/Mobile nav) display pending-approval indicators so waiting approvals are visible before opening Mailbox.
- Agents list/board cards and Agent Detail summary display per-agent `pendingApprovalCount` badges to show which agents are blocked by waiting approvals.

Agent provisioning approvals (`agent_provisioning` category):

- `fn_agent_create` / `fn_agent_delete` can return `pending_approval` under `projectSettings.agentProvisioning` policy (`approvalMode`, trusted roles/IDs, `alwaysApproveDelete`). `fn_agent_update` is an in-place configuration edit for existing agents, so it uses org-hierarchy authorization and `AgentStore.updateAgent` revision auditing rather than the create/delete provisioning approval policy.
- Dashboard surface: Project Settings → Agent Permissions → **Agent Provisioning Approvals** editor (project-scoped only).
- Approval request is persisted with provisioning context (`tool` + `params`) and visible in mailbox/API approval queues.
- Dashboard/API decision route `POST /api/approvals/:id/decision` executes deferred provisioning on `approve` via engine dispatcher (`executeApprovedAgentProvisioning`) and never executes on `deny`.
- Decision handling emits run-audit mutations: `agent:create:{requested,approved,denied}` and `agent:delete:{requested,approved,denied}` using original request task/run/requester linkage.
- Malformed provisioning context or failed execution returns 500 from the decision route (no silent approval).

Resolver decision table (`resolveAgentProvisioningPolicy`):

| matchedRule | decision | Notes |
| --- | --- | --- |
| `missing-caller` | `deny` | Caller context missing. |
| `privileged-caller` | `allow` | Bypasses trust checks and `alwaysApproveDelete`. |
| `approval-mode-never` | `allow` | Global short-circuit, including deletes. |
| `delete-always-approve` | `require-approval` | Default delete behavior when not short-circuited. |
| `trusted-agent-id` | `allow` | Exact caller ID allowlist match. |
| `trusted-role` | `allow` | Case-insensitive role allowlist match. |
| `approval-mode-trusted-only` | `require-approval` | Untrusted fallback in default mode. |
| `approval-mode-always` | `require-approval` | Approval always required unless privileged/never mode. |

FN-3973 follow-through: `spawn_agent` evaluation is complete; governance remains in action-gate `task_agent_mutation` (ephemeral runtime lifecycle), not durable `agentProvisioning`.

Default and legacy fallback behavior:

- New **non-ephemeral/permanent** agents persist a normalized `permissionPolicy` using preset `unrestricted` when not explicitly provided.
- New and existing ephemeral/runtime task-worker agents may store an explicit `permissionPolicy` and canonical `permissions` grants.
- Legacy permanent-agent rows missing `permissionPolicy` resolve to the same effective `unrestricted` policy at read time (no eager migration required).
- Legacy ephemeral/runtime task-worker rows missing `permissionPolicy` are not backfilled on disk; runtime sessions inherit the project `defaultAgentPermissionPolicy` (or `unrestricted` when no project default is configured).
- Fallback `executor-FN-*` task workers without a stored agent row use a stable synthetic actor and the same project-default policy, so exact `toolRules` such as `fn_task_create: block` apply consistently.

Separation of concerns:

- `permissions` capability flags (plus role defaults) determine what an agent is conceptually authorized to do (for example, `tasks:assign`, `agents:create`).
- `permissionPolicy` determines how sensitive runtime actions are gated (`allow`, `block`, `require-approval`) once the capability path is in play. `require-approval` creates an approval request with the permanent or ephemeral actor identity, pauses the associated task safely, and resumes through the existing approval lifecycle.
- Dashboard persona presets (`packages/dashboard/app/components/agent-presets/`) are UI templates for identity/behavior and are **not** the source of truth for permission-policy enforcement.

### CLI agent permission prompts and notifications

CLI-agent adapters keep their own autonomy posture and tool-permission handling separate from permanent-agent `permissionPolicy`. When an adapter reports a permission/input prompt (`PermissionRequest`, `Notification`, or a conservative approval-prompt heuristic), the CLI session moves to `waitingOnInput`; the dashboard shows the session banner, and Fusion dispatches the `cli-agent-awaiting-input` notification event through enabled ntfy/webhook providers. Repeated waiting events for the same CLI session are de-duplicated before provider delivery, while the in-app banner continues to reflect the live session state.

### System-Managed Fields (Not User-Editable)

These fields are managed by the engine and cannot be directly edited:

- `id` — Auto-generated unique identifier
- `state` — Agent lifecycle state (managed by engine). Non-ephemeral agents default to `active` on creation; ephemeral/task-worker agents default to `idle`.
- `taskId` — Current working task (managed by scheduler)
- `totalInputTokens` / `totalOutputTokens` — Token usage totals (managed by engine)
- `createdAt` / `updatedAt` / `lastHeartbeatAt` — Timestamps (managed by system)
- `lastError` — Last error message (managed by engine; cleared after successful recovery runs)
- `pauseReason` — Reason for paused state (managed by engine)

### Stale Task Link Sanitization

The `taskId` field is suppressed in API responses when the linked task is in a terminal state (`done` or `archived`). This prevents stale "working on" UI indicators in the Agents dashboard for agents whose task has already completed.

**Terminal task statuses:**
- `done` — Task completed successfully
- `archived` — Task archived

**Affected API endpoints:**
- `GET /api/agents` — `taskId` is omitted from agents with terminal linked tasks
- `GET /api/agents/:id` — `taskId` is omitted when the linked task is terminal
- `GET /api/agents/stats` — `assignedTaskCount` excludes agents with terminal linked tasks

**Non-terminal task statuses (taskId is preserved):**
- `planning`
- `todo`
- `in-progress`
- `in-review`

**Graceful degradation:**
- If task lookup fails (e.g., task deleted), `taskId` is preserved in the response to avoid false negatives
- The underlying `taskId` is NOT modified in storage — only the API response is sanitized

**Performance notes:**
- Task-link sanitization now uses `TaskStore.getTaskColumns(ids)` for one batched status lookup instead of per-task `getTask()` hydration.
- `GET /api/agents/stats` now uses `AgentStore.getRunStatusCounts()` to aggregate completed/failed run totals in one grouped query (no per-agent `getRecentRuns()` loop).

### Update-Only Fields

These fields can only be set during update (not on create):

- `pauseReason` — Why the agent is paused
- `lastError` — Last error message (cleared when the agent successfully recovers)
- `totalInputTokens` — Accumulated input token count
- `totalOutputTokens` — Accumulated output token count

## Execution Ownership for Assigned Agents

When a task sets `assignedAgentId` to a **durable (non-ephemeral)** agent, that same agent is used as the active execution owner during runtime execution.

Behavior:
- Fusion links the durable agent's `taskId` to the running task for execution visibility
- No synthetic `executor-FN-*` task-worker agent is created for that run
- On completion/error, the durable agent's execution task link is cleared (the durable record is preserved)

Fallback behavior remains unchanged:
- Unassigned tasks still use runtime-managed `executor-FN-*` task-worker agents
- Missing assigned agents, or assigned agents that are ephemeral/runtime-managed, fall back to task-worker execution ownership

Execution-ownership sync intentionally avoids assignment-trigger side effects (`agent:assigned` wakeups) that are intended for control-plane delegation.

### Running-state invariant for assigned durable agents (FN-4249)

Invariant: a durable agent must not remain `state="running"` while its linked task is outside `in-progress` (especially `todo` + `status="queued"`).

Layered enforcement:
- **Scheduler rollback (`packages/engine/src/scheduler.ts`)**: when overlap gating requeues a todo task to `status="queued"`, scheduler immediately rolls back any running agent linked through `executionTaskId` to `state="active"` and clears the execution-task link.
- **Heartbeat reconciliation (`packages/engine/src/agent-heartbeat.ts`)**: `reconcileOrphanedRunningAgents()` repairs persisted `state="running"` drift when no active run exists, or when a persisted active run is untracked and older than `heartbeatTimeoutMs × 3` (work-budget grace; see inline FN-4278/FN-4255 comment near that check).
- **Heartbeat scheduler stale-run reap (`packages/engine/src/agent-heartbeat.ts`)**: `HeartbeatTriggerScheduler.maybeReapStaleActiveRun()` repairs stale persisted `status="active"` heartbeat runs using `heartbeatTimeoutMs × heartbeatRepairStaleMultiplier` (default multiplier `2`).
- **Self-healing reconciler (`packages/engine/src/self-healing.ts`)**: `recoverAgentsRunningOnInactiveTasks()` and `recoverStaleHeartbeatRuns()` use task-column mismatch checks plus PID/young-run/age guards (including the 6h stale active-run max age) rather than a simple timeout multiplier.
- **Cross-process CLI stop/start notification (FN-7723, follow-up from FN-7718):** `fn agent stop`/`start` mutate the agent row from a separate short-lived CLI process. The long-lived engine `AgentStore` now opts into a bounded `fs.watch`+poll change-detection fast-path (`startWatching()`/`checkForChanges()`, modeled on `TaskStore`'s own watcher — see `docs/architecture.md`'s FN-7723 note) that re-emits the existing `agent:updated`/`agent:stateChanged` events, so `HeartbeatTriggerScheduler` typically observes a CLI-driven stop/start within one poll interval (~2s) instead of waiting on the 60s `auditTimerRegistrations` sweep, which remains the durable backstop.

Manual recovery for pre-fix stuck rows:
1. Open the agent in Dashboard → Agent Detail.
2. Set state back to `active`.
3. Clear execution task link (set task link to none).

Programmatic equivalent:
- `AgentStore.updateAgentState(agentId, "active")`
- `AgentStore.syncExecutionTaskLink(agentId, undefined)`

### Assigned-agent runtime model precedence for task execution

When a task is executed by an assigned durable agent, executor session model selection prefers fresh task and settings values before the agent's stored runtime model.

Executor precedence for task runs:
1. Task `modelProvider` + `modelId`
2. Project/global execution lane fallbacks (same resolution as unassigned runs)
3. Assigned agent `runtimeConfig` model pair (combined `runtimeConfig.model = "provider/modelId"` or separate `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) only when both provider and model ID are present and no task/settings pair is configured

If the assigned agent runtime model is missing or incomplete, Fusion continues to automatic provider/model resolution without mixing partial runtime fields into the selected pair.

### Durable-agent heartbeat model precedence and unavailable-provider behavior

Heartbeat sessions for durable agents resolve models with the same fresh-settings-first rule:

1. Execution-lane settings fallback (`executionProvider`/`executionModelId` → `executionGlobalProvider`/`executionGlobalModelId` → project/global defaults)
2. Agent runtime model (`runtimeConfig.model` or `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) only when both provider and model ID are present and no execution/default pair is configured

Heartbeat no longer passes a stale runtime model ahead of a saved execution lane or project default override.

Task-scoped heartbeat runs for durable agents execute inside the task's git worktree (same as ephemeral task execution), while no-task heartbeat runs continue to execute from the project root.
Heartbeat and executor system prompts share the same active-goal context injector (`buildGoalContextSection`), so both lanes receive identical goal preambles when active goals exist.

If a heartbeat cannot create/run a session due to unavailable provider credentials or missing provider registration, Fusion records `resultJson.reason = "heartbeat_model_unavailable"` with actionable diagnostics in `resultJson.detail`/`stderrExcerpt`.

### Durable-agent transient error auto-recovery

Durable-agent error recovery is coordinated between the heartbeat timer path and the self-healing sweep. Either entry path may auto-recover **durable (non-ephemeral)** agents stuck in `state="error"` only when all eligibility checks pass:

- agent is non-ephemeral (`isEphemeralAgent(...) === false`)
- heartbeat runtime is enabled (`runtimeConfig.enabled !== false`)
- no active heartbeat execution is already running for the agent
- `lastError` classifies as transient network/infrastructure failure
- `lastError` is **not** operator-actionable (credentials/model/billing-style failures)
- stale worktree/module-resolution failures remain suppressed instead of auto-restarted

Both paths use the same persisted retry budget, `agent.metadata.heartbeatErrorRecovery.consecutiveAttempts`, with the default cap of `5` attempts (settings-overridable through `heartbeatErrorRecoveryAttempts`). The timer path provides fast recovery on the agent's own interval; the self-healing sweep is the backstop for stale `error` agents whose timer was lost, delayed, or did not re-tick. Engine startup adds a clean-slate reset before the steady-state sweep: eligible `state="error"` agents and durable agents parked with `pauseReason="error-retry-exhausted"` have `heartbeatErrorRecovery` and legacy `durableErrorRecovery` reset, `lastError`/exhaustion pause state cleared, and their heartbeat re-armed immediately. That restart-triggered reset intentionally bypasses the sweep's staleness, cooldown, and exhausted-budget gates because restarting the engine is treated like an operator Retry click. Self-healing still persists `agent.metadata.durableErrorRecovery` for sweep-specific cooldown and stale-path details:

- exponential cooldown (`30s` base, capped at `15m`)
- persisted `attempts`, `lastAttemptAt`, `nextRetryAt`, `exhausted`, `lastReason`, and stale missing-module path counters

On restart attempts, the runtime triggers the normal heartbeat pipeline with `source: "automation"` and a structured `contextSnapshot.selfHealing` payload so operators can audit recovery runs in heartbeat history. The sweep flips `error → active` before calling `executeHeartbeat`, so the heartbeat run does not re-enter run-entry error recovery or double-count the same recovery.

Self-healing intentionally refuses to auto-restart agents when blockers are operator-actionable or non-transient. Runtime-enabled durable agents in that terminal bucket are parked `paused` with `pauseReason="error-unrecoverable"` so operators see that credential/model/configuration repair is required; transient retry-budget exhaustion still parks with `pauseReason="error-retry-exhausted"`. Stale worktree/module-resolution suppression, active execution, runtime-disabled agents, ephemeral agents, user-paused agents, and `error-unrecoverable` parks remain excluded from both the steady-state retry path and the startup clean-slate reset; cooldown windows and exhausted-budget gates are bypassed only by the startup reset for otherwise recoverable agents.

**Manager presence does not gate this sweep (FN-7672/FN-7844):** eligibility for durable `state="error"` recovery does *not* depend on whether the agent's `reportsTo` manager is present/active. The timer path is now the fast path for heartbeat-managed error agents, while this recovery sweep remains the maintenance backstop for durable agents that are still stale in `error`; a present manager does not make the agent any less stuck. (A separate, unrelated `managerMissing` check still gates recovery of orphaned `state="running"` agents — a different failure mode where a live process's manager row was deleted.) FN-7672 root-caused a correlated 4-agent error cluster reporting to one active manager (a transient upstream auth/session blip) that could never have self-healed under the old manager-missing-only gate, even once the underlying cause resolved.

- **Timer trigger:** run completes and the durable agent returns to `state="active"` (recoverable soft-fail).
- **Assignment / on-demand trigger:** run completes with `resultJson.actionRequired = true`, then the durable agent is paused with `pauseReason="heartbeat-model-unavailable"` and `lastError` set to actionable credential guidance (including the missing provider name when detectable).

False-positive `heartbeat-model-unavailable` parks (session/registry/credential-probe blips that a manual Retry would clear without config changes) are admitted to the same bounded `heartbeatErrorRecovery` budget as error-state recovery. The heartbeat timer re-arms while budget remains, the run-entry path clears the park and retries, and the self-healing sweep plus engine-startup reset are backstops. Genuine missing credentials re-park after each failed attempt and stay parked once the budget is exhausted (keeping `pauseReason="heartbeat-model-unavailable"` for operator guidance). Manual resume still works at any time.

### Assigned-agent identity + planning model precedence for task triage

When a triage/specification run targets a task with `assignedAgentId` and that agent is durable, planning now inherits the assigned agent context instead of only generic triage-role defaults.

Triage inheritance behavior:
1. The triage system prompt includes assigned-agent identity context and resolves instructions/soul/memory from that agent (including existing rating-aware instruction composition)
2. Triage memory tools are created with assigned-agent memory context (`createMemoryTools(..., { agentMemory })`), so `fn_memory_search` / `fn_memory_get` can access `.fusion/agent-memory/{agentId}/...` during planning
3. Planning model resolution prefers a complete assigned-agent runtime model pair first, then task planning overrides, then normal planning/project/global fallbacks

As with execution, incomplete assigned-agent model configuration falls through cleanly to the existing planning hierarchy.

### Task Detail Raw Logs model provenance

The Task Detail Activity → Raw Logs model header prefers runtime provenance markers written during execution/review:

- `Executor using model: <provider>/<modelId>`
- `Reviewer using model: <provider>/<modelId>`
- `Planning using model: <provider>/<modelId>` (legacy `Triage using model: <provider>/<modelId>` rows remain parseable)

When the lane resolves a thinking level, the same row appends ` (thinking effort: <level>)`, for example `Executor using model: openai/gpt-4o (thinking effort: high)`. Dashboard parsers ignore parenthesized diagnostics for provider icons/effective-model headers while Raw Logs and Activity rows keep the full text visible.

This makes the header reflect the model that actually ran. For active runs with no runtime marker yet, the UI can use the currently assigned agent runtime model as a temporary fallback before falling back to task/settings resolution.

### Ephemeral agent terminal cleanup

Runtime-created ephemeral agents are removed immediately after terminal cleanup paths run:

- Task-worker agents created by `InProcessRuntime` are deleted as soon as they reach paused cleanup paths after completion, error, or `agent:stateChanged` fallback cleanup.
- Spawned child agents created by `TaskExecutor` are deleted immediately inside `terminateChildAgent()` after terminal cleanup state update.
- User-managed non-ephemeral agents are never auto-deleted by these pathways.

Because deletion is immediate, runtime helper agents should not remain visible in the dashboard or `AgentStore` after cleanup completes once paused-state cleanup (or run-level termination) finishes.

## Agents View (Dashboard)

The agents surface provides:

- Agent-first list and board collections use the desktop split-pane layout (primary collection + detail pane)
- Org Chart is a full-view mode that takes over the full Agents content area; selecting a node opens detail in that same full-width region with back navigation to the chart
- Org chart nodes intentionally stay compact (role/state/health hierarchy signal only) and do not enumerate per-agent skill badges; detailed skills remain in list/board/detail surfaces
- A cross-pane **Overview** strip above the split layout with summary metrics and a disclosure to expand active/running live cards
- A compact **Controls** popup for secondary actions (state filter, Show system agents toggle, project-scoped bulk pause/resume, Import, and global Heartbeat Speed)
- Agent import can also be launched from the selected **Agent Detail** header; this entry opens the import modal directly in the companies.sh browse flow so operators can discover and import packages without leaving the detail context
- Detail/config panels
- Agent Detail includes a **Mail** tab for inspecting that agent’s inbox/outbox; selecting a message opens full details, and selecting an unread inbox message marks it read
- Agent Detail header utility actions now include a project-scoped **Bulk agent actions** menu for pause/resume lifecycle transitions; see [Agent Detail bulk lifecycle actions](#agent-detail-bulk-lifecycle-actions)
- Split-view synchronization: successful saves plus single-agent and bulk lifecycle actions from the right-side Agent Detail pane immediately refresh the left-side list/selection state (no wait for background polling)
- A per-agent **Token Usage** panel that summarizes cumulative token consumption for the currently displayed agents
- Run history
- Task assignment context

### Running Control Opens Live Run Details

When an agent card shows the **Running** control, that control is actionable:

- Clicking **Running** opens Agent Detail directly on the **Runs** tab
- If the agent has an active run ID, that run is automatically expanded
- The run detail payload and log stream are loaded immediately so operators can inspect live execution without manually switching tabs

Other entry points (for example, **View Details** or clicking the agent identity area) continue to open the default Agent Detail Dashboard tab.

### Token Usage Panel

The **Token Usage** panel in Agents view is derived from each agent's persisted cumulative counters:

- `totalInputTokens`
- `totalOutputTokens`

### Cache-hit observability

Fusion exposes cache-hit metrics across logs, API, and CLI:

- **Structured logs:** `token-cache-metrics` channel emits per-persist records with `taskId`, `agentId`, `role`, `inputTokens`, `cachedTokens`, `cacheWriteTokens`, and computed `hitRatio`.
- **Agent API:** `GET /api/agents/:id/token-usage` returns `last24h`, `last7d`, and `allTime` window summaries for permanent agents.
- **CLI rollup:** run `pnpm fn:cache-stats` (or `pnpm fn:cache-stats --json`) for project-wide role totals plus per-permanent-agent cache-hit summaries.

For the current filtered/visible agent set, the panel shows:

- Aggregate input token total
- Aggregate output token total
- Aggregate combined total (`input + output`)
- Per-agent rows sorted by descending combined token usage

If either token field is missing for an agent, the dashboard treats it as `0` so the panel stays stable and never crashes on partial/migrating data.

### Agent Detail bulk lifecycle actions

The **Agent Detail** header includes a kebab-menu button in the utility actions cluster (`Bulk agent actions`), beside refresh/close controls. This menu runs **project-scoped** lifecycle changes from the detail view: it fetches agents for the current project and then calls the same per-agent lifecycle API (`POST /api/agents/:id/state`) used by the single-agent header buttons.

Current bulk transitions are intentionally limited to the two shipped actions:

- **Pause All Agents** — targets only **non-ephemeral** agents currently in `active` or `running` state
- **Resume All Agents** — targets only **non-ephemeral** agents currently in `paused` state

Eligibility and UI behavior:

- Ephemeral/system agents are excluded entirely from bulk lifecycle actions
- Agents already outside the target lifecycle state are skipped rather than force-transitioned
- Each menu item shows a live eligibility hint after opening the menu, such as `Pause 2 active/running agents` or `Resume 1 paused agent`
- If no agents are currently eligible, the corresponding menu item is disabled and its hint changes to `No active agents eligible` or `No paused agents eligible`
- While eligibility is loading, the hint reads `Loading eligible agents...`

Operator flow and outcomes:

1. Open **Bulk agent actions** from any Agent Detail header
2. Review the eligibility hint for the desired action
3. Confirm the project-wide action in the confirmation dialog (`Pause/Resume N agents in this project?`)
4. Expect toast feedback after execution plus an Agent Detail refresh/split-view sync

Toast/reporting behavior mirrors the shipped implementation:

- Full success reports a success toast such as `Paused 2 agents; skipped 1`
- Partial failure reports an error toast summarizing successes, skipped agents, and failed agents (including up to three per-agent failure details)
- If no agents are eligible at execution time, the dashboard reports `No agents eligible to pause` or `No agents eligible to resume`

### Agent Deletion Controls

Agent deletion is available from both the detail header lifecycle controls and the **Settings** tab's danger zone.

- The Settings-tab delete button reuses the same delete flow as the header action.
- Deletion still requires confirmation before calling `DELETE /api/agents/:id`.
- On successful deletion, the dashboard shows a success toast and closes the detail view.
- Deletion availability is intentionally restricted to agents in `idle` or `paused` state.

![Agents view](./screenshots/agents-view.png)

## Agent Memory Layers in Runtime Tools

When engine sessions include per-agent memory context, the memory tools operate over the full agent-memory workspace under `.fusion/agent-memory/{agentId}/`, not only the inline `agent.memory` field.

Runtime behavior:

- `fn_memory_append` supports dual scope writes:
  - `scope="agent"` for private per-agent operating context (personal playbooks/checklists, self-management notes)
  - `scope="project"` for shared repo-wide durable knowledge (architecture constraints, conventions, pitfalls)
- `fn_memory_search` can surface snippets from:
  - `.fusion/agent-memory/{agentId}/MEMORY.md` (long-term)
  - `.fusion/agent-memory/{agentId}/DREAMS.md` (synthesized patterns)
  - `.fusion/agent-memory/{agentId}/YYYY-MM-DD.md` (daily notes)
- `fn_memory_get` is intentionally bounded to those same files only.
- Agent memory resolution order is:
  1. Inline `agent.memory` (highest priority)
  2. `.fusion/agent-memory/{agentId}/MEMORY.md` (fallback when inline is empty, and supplemental long-term section when inline is present)
  3. Additional `.fusion/agent-memory/{agentId}/DREAMS.md` and daily files surfaced via `fn_memory_search`/`fn_memory_get`
- Empty inline `agent.memory` does **not** disable search/read of existing workspace files once the agent-memory workspace exists.

This layered behavior is shared by heartbeat agents and task-scoped sessions that inherit agent identity.

## Research Tools in Planning/Execution Sessions

Triage and executor runtime sessions include a bounded research tool surface only when `experimentalFeatures.researchView` is enabled for the project. Permanent/custom heartbeat sessions always register the governed research discovery/run/cancel tools (`fn_research_run`, `fn_research_list`, `fn_research_get`, `fn_research_cancel`) so permission policy and runtime setup responses govern use; `fn_research_run` and `fn_research_cancel` remain `network_api`-gated by `AgentPermissionPolicy`, and disabled or misconfigured research returns an actionable setup result instead of removing the tool.

- `fn_research_run` — create/start a bounded research run for a focused query
- `fn_research_list` — list recent runs and statuses
- `fn_research_get` — fetch one run's structured findings payload
- `fn_research_cancel` — cancel an active run

These tools return structured metadata (`runId`, `status`, `summary`, `findings`, `citations`, `error`, `setup`) in addition to concise text so downstream model steps can consume results deterministically.

Expected behavior and boundaries:

- Agents should use research only when repository/local context is insufficient
- Queries should stay narrow and task-scoped; avoid open-ended exploration
- When `experimentalFeatures.researchView` is disabled, triage/executor sessions do not register `fn_research_*` tools and prompts do not advertise research capabilities; heartbeat sessions keep the safe research tools registered but return setup guidance at execution time
- If the research surface is enabled but an explicitly selected external provider is misconfigured (or web search is explicitly disabled), tools return actionable `setup` responses instead of crashing
- Durable conclusions should be persisted with `fn_task_document_write` (for example, `key="research"`)
- Research runs require the project engine to be running for processing; `fn_research_run` creates the run but does not block for completion unless `wait_for_completion` is set

For the full research workflow, builtin-default behavior, optional external provider setup, CLI commands, and API reference, see the [Research guide](./research.md). For the agent/chat capability audit and phased route from research through roadmap, execution, and verification, see [Full-loop agent tool-surface audit](./agent-tool-surface-full-loop.md).

## Runtime Self-Awareness Preamble

**FN-7675:** every standard-toolset conversational base prompt — chat/CEO persona, both heartbeat personas (task-bound and no-task), and the executor — is prefixed with a single canonical, cacheable preamble: `FUSION_RUNTIME_SELF_AWARENESS`, exported from `packages/core/src/agent-prompts.ts` (re-exported from `@fusion/core`). The preamble encodes:

- The agent executes as a **hosted process inside** the running Fusion daemon; its own execution ends the moment that process ends. There is no "wait for Fusion to close, then keep going" capability.
- **Shutdown-crossing workflows** (updates, installs, patches, migrations, in-place binary swaps) must be handed off as a **standalone artifact the user runs themselves** — never orchestrated live across the shutdown boundary. This closes a real failure mode: an agent planned a live "close Fusion → back up → swap build → verify → relaunch" sequence, which is impossible because step 1 kills the process running steps 2–5.
- A short, current description of the platform (task board + engine + desktop/CLI/web surfaces).
- A pointer to the maintained docs (`docs/` and `CONCEPTS.md`) so the agent answers "how do I do X in Fusion" from real documentation instead of improvising.

The preamble is prepended to the **stable** (cacheable) prompt layer — `basePrompt` in `buildPromptLayers()` — at each surface, so it is byte-identical across sessions and does not break prompt-cache discounts:

- Chat: `CHAT_SYSTEM_PROMPT` in `packages/dashboard/src/chat.ts`.
- Heartbeat: `HEARTBEAT_SYSTEM_PROMPT` and `HEARTBEAT_NO_TASK_SYSTEM_PROMPT` in `packages/engine/src/agent-heartbeat.ts`.
- Executor: `EXECUTOR_SYSTEM_PROMPT` in `packages/engine/src/executor.ts` (mirrored via `EXECUTOR_PROMPT_TEXT` in `packages/core/src/agent-prompts.ts`).

It is intentionally **not** wired into merger, reviewer, triage, cron-runner, PR-response, mission-validation, or reflection prompts — those are internal single-purpose lanes, not standard-toolset agents reasoning about the shutdown boundary.

## Built-In Agent Prompt Templates

Fusion includes built-in templates for role prompts:

- `default-executor`
- `default-planning`
- `default-reviewer`
- `default-merger`
- `senior-engineer`
- `strict-reviewer`
- `concise-planning`

These can be assigned per role using `agentPrompts.roleAssignments`.

## Per-Agent Configuration

Agents can be configured with:

- Custom instructions
- Heartbeat interval/timeout limits
- Max concurrent heartbeat runs
- Budget governance settings
- Model overrides for heartbeat sessions

In Agent Detail → **Settings**, configuration fields auto-save after edits (debounced) when validation passes. The inline status indicator shows saving/saved/error state, and no separate **Save Settings** click is required for settings persistence.

### Runtime Configuration Fields

The `runtimeConfig` field on agents supports the following options:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Whether heartbeat triggers are enabled for this agent |
| `heartbeatIntervalMs` | `number` | — | How often the agent should wake up for heartbeat checks (ms) |
| `autoClaimRelevantTasks` | `boolean` | `true` | During no-task heartbeats, opportunistically claim unowned relevant todo tasks that align with the agent's role/soul |
| `engineerBacklogAutoClaim` | `boolean` | inherits project (`false`) | Opt this engineer-role agent into no-task backlog auto-claim for implementation tasks. Executor-role agents remain eligible by default; explicit routing/delegation is unchanged. |
| `assignmentPolicy` | `"auto" \| "explicit-only" \| "none"` | `"auto"` | Per-agent task-routing eligibility (issue #2015). `auto` keeps default behavior. `explicit-only` removes the agent from the scheduler auto-assign pool and backlog auto-claim but still accepts direct assignment/delegation. `none` guarantees the agent can never be bound to an implementation task by ANY path — scheduler, auto-claim, delegation, checkout, or `override=true` — use it for liaison/observer agents whose mandate excludes product work. Enforced at every binding primitive (`claimTaskForAgent`, `checkoutTask`, `assignTask`, inbox selection, `fn_delegate_task`, dashboard assign/checkout routes). |
| `autoClaimCandidatesInPrompt` | `number` | `5` | Per-agent override for no-task candidate lines rendered in prompts. Integer `0-10`; `0` suppresses candidate injection. |
| `heartbeatTimeoutMs` | `number` | — | Time without heartbeat before agent is considered unresponsive (ms) |
| `maxConcurrentRuns` | `number` | `1` | Max concurrent heartbeat runs for this agent |
| `runMissedHeartbeatOnStartup` | `boolean` | `false` | When enabled, if the server was down across this agent's scheduled heartbeat tick, fire one catch-up heartbeat at startup (only when `lastHeartbeatAt` is older than the resolved interval) |
| `allowParallelExecution` | `boolean` | `true` (when unset) | Permanent agents only. When `false`, heartbeat and executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run |
| `skipHeartbeatWhenIdle` | `boolean` | `false` | When `true`, scheduled timer heartbeats are skipped while the agent has no assigned task. Assignment-triggered and on-demand runs still fire |
| `messageResponseMode` | `"immediate" \| "on-heartbeat"` | `"immediate"` | Whether agent wakes immediately on message (immediate) or processes during heartbeat (on-heartbeat). See [Heartbeat Run Mailbox Checking](#heartbeat-run-mailbox-checking) |
| `heartbeatScopeDiscipline` | `"strict" \| "lite" \| "off"` | inherits project (`"strict"`) | Per-agent heartbeat procedure template mode. Unset inherits project setting; `strict` is coordination-focused, `lite` is pre-2026-05-11 behavior, `off` is minimal. |
| `heartbeatPromptTemplate` | `"default" \| "compact"` | role default (`executor`→`default`, others→`compact`) | Per-agent heartbeat execution-prompt template override. Unset inherits project `heartbeatPromptTemplate` (`default`). |
| `selfImproveEnabled` | `boolean` | `true` | Enable periodic self-improvement reflection prompts during heartbeat runs |
| `selfImproveIntervalMs` | `number` | `14400000` (4h) | Minimum delay between self-improvement cycles (minimum enforced: 3600000 ms) |
| `lastSelfImproveAt` | `string` (ISO timestamp) | — | Last recorded self-improvement checkpoint timestamp |
| `modelProvider` | `string` | — | AI provider override for heartbeat session |
| `modelId` | `string` | — | AI model ID override for heartbeat session |
| `budgetConfig` | `AgentBudgetConfig` | — | Token budget governance settings |

Assignment-triggered heartbeats are completion-resilient: if an `agent:assigned` wake is skipped only because the durable agent already has an active heartbeat run, Fusion records the latest assigned task as a pending assignment and re-fires that assignment wake once the active run completes. This prevents assigned work from being stranded by long heartbeat intervals or `skipHeartbeatWhenIdle`; disabled agents (`enabled === false`) and budget-exhausted agents still do not defer assignment wakes.

Self-healing also covers abnormal run/session loss for assigned `in-progress` work. If the task remains assigned but the durable agent has no active heartbeat run and no active executor session after the orphan grace window, `reattach-orphaned-assigned-executions` re-dispatches the task forward via `executor.resumeTaskForAgent(agentId)` without pausing, failing, or moving the task backward.

Agent runtime sessions receive the project/global effective MCP server set when the selected runtime supports MCP (pi/Claude/ACP-compatible runtimes). Mock and unsupported runtimes skip MCP forwarding with content-free structured logs. MCP secret references are materialized only at session creation and are never stored on the agent or written to logs.

Heartbeat values are validated and minimum-clamped to 5 minutes (300,000 ms).
Project setting `heartbeatMultiplier` (default `1`) scales resolved heartbeat timing globally: both the heartbeat interval (`pollIntervalMs`) and unresponsive timeout base (`heartbeatTimeoutMs`) are multiplied. Per-agent `heartbeatIntervalMs`/`heartbeatTimeoutMs` remain base values before multiplier scaling. This setting is configured from the **Agents** screen's **Controls** popup under "Heartbeat Speed".

Project setting `heartbeatScopeDiscipline` defaults to `strict`; set per-agent `runtimeConfig.heartbeatScopeDiscipline` to `strict`, `lite`, or `off` in **Agent Detail → Settings → Heartbeat Settings** to override.
Project setting `heartbeatPromptTemplate` defaults to `default`; per-agent `runtimeConfig.heartbeatPromptTemplate` overrides it. Role defaults are `executor` → `default`, and coordination roles (`triage`, `reviewer`, `merger`) → `compact`.

`runMissedHeartbeatOnStartup` defaults to `false` and is configured in **Agent Detail → Settings → Heartbeat Settings → Run Missed Heartbeat On Startup**.

`allowParallelExecution` defaults to `true` when unset; setting it to `false` is serialized explicitly so operators can enforce non-parallel heartbeat/executor behavior for that permanent agent. Configure it in **Agent Detail → Settings → Heartbeat Settings → Allow Parallel Execution**.

### Auto-claim candidate snapshot (FN-4401)

No-task heartbeats now consume a project-wide in-memory `AutoClaimSnapshotManager` cache (TTL 30s) instead of each agent scanning the board independently. Rebuilds occur on TTL expiry and scheduler invalidations (`task:created`, `task:moved` when todo edge touched, and `task:updated`).

Prompt candidate rendering uses:
- project setting `autoClaimCandidatesInPrompt` (default `5`, range `0-10`)
- optional per-agent runtime override `runtimeConfig.autoClaimCandidatesInPrompt`

`0` suppresses candidate injection in no-task prompts (wake summary shows `disabled (prompt-suppressed)`). The Agent Detail heartbeat section also includes a **Coordination-only agent** preset that disables auto-claim and sets candidate injection to `0` for routing/CEO-style agents.

`skipHeartbeatWhenIdle` defaults to `false`; when enabled, only scheduled timer ticks are skipped while the agent has no assigned task. Assignment-triggered wakeups and manual/on-demand runs still execute. Configure it in **Agent Detail → Settings → Heartbeat Settings → Skip heartbeat when idle**.

### No-task auto-claim behavior

When an identity-bearing, non-ephemeral agent wakes with no assigned task and `runtimeConfig.autoClaimRelevantTasks !== false`, the heartbeat monitor scans open todo tasks and may claim one before constructing the prompt run.

Guardrails:
- Only unpaused, unassigned, unchecked-out todo tasks with satisfied dependencies are considered
- Claims are rejected for terminal/paused/owned/conflicting tasks
- Implementation-task backlog pickup is executor-only by default. Engineer-role agents may opt in through **Settings → Scheduling & Capacity → "Let engineer agents auto-claim backlog tasks"** (`settings.engineerBacklogAutoClaim`) or **Agents → Agent Detail → Settings → Heartbeat Settings → "Engineer Backlog Auto-Claim"** (`runtimeConfig.engineerBacklogAutoClaim`); the per-agent value overrides the project default in both directions. If a no-task engineer wake shows compatible backlog while this is disabled, delegate the work or create a coordination follow-up instead of treating the board as empty.
- Explicit task routing/delegation is not affected by the backlog auto-claim opt-in gate.
- Checkout safety is preserved (`checkout_conflict` paths are non-fatal skips)
- On successful claim, the same heartbeat run switches into task-scoped execution (no nested run re-entry)

Operators can disable this per agent in **Agent Detail → Settings → Heartbeat Settings → Auto-Claim Relevant Tasks**.

### Self-improvement cycle

When `selfImproveEnabled !== false`, heartbeat runs periodically enter a self-improvement phase once `selfImproveIntervalMs` has elapsed since `lastSelfImproveAt` (or first run with available ratings). During that phase the agent is prompted to:

1. Call `fn_read_evaluations` to inspect ratings/reflections
2. Identify recurring quality issues and trends
3. Call `fn_update_identity` to adjust its own `soul`, `instructionsText`, or `memory`
4. Record concise improvement decisions

After a successful run, the monitor records `lastSelfImproveAt` in `runtimeConfig`.

## Agent Instructions (Dashboard)

The Agent Detail view includes a dedicated **Instructions** tab for editing agent custom instructions. This replaces the previous embedded instructions editor in the Settings tab, providing a more discoverable and user-friendly experience.

### Inline vs File-Backed Instructions

There are two ways to provide custom instructions:

1. **Inline Instructions**: Direct text entry in the dashboard textarea. Good for simple, short instructions.

2. **File-Backed Instructions**: A path to a `.md` file in the project that contains the instructions. Good for:
   - Longer, more complex instructions
   - Version control of instruction changes
   - Sharing instruction files across teams

### Using the Instructions Tab

1. Open an agent from the Agents view
2. Click the **Instructions** tab
3. Enter inline instructions in the **Inline Instructions** textarea
4. Or set a path in **Instructions File Path** (e.g., `.fusion/agents/my-agent.md`)
5. When a path is set, a **File Content** editor appears for direct file editing
6. Save instructions using the **Save Instructions** button
7. Save file content separately using the **Save File** button

### File Editor Behavior

- File content loads automatically when an instructions path is set
- Missing files (ENOENT) are treated as new files with empty content
- Non-ENOENT errors (e.g., permission denied) show an error toast
- The editor has an **Unsaved changes** indicator when file content is modified
- File saves are independent from instruction metadata saves

## Heartbeat Procedure File Access (Agent Detail Modal)

The **Settings** tab in the Agent Detail modal includes a **Heartbeat Procedure** section with an in-modal markdown file viewer/editor.

### How it works

1. The section shows the current `heartbeatProcedurePath`.
2. When a path exists, use **View Heartbeat Markdown** to load and inspect that file without leaving the modal.
3. The editor supports both **Edit** and **Preview** modes, with an unsaved-changes indicator and dedicated save action.
4. Reads/writes are scoped through the workspace file APIs with `projectId` awareness in multi-project mode.

### Relation to upgrade flow

- Canonical per-agent asset directories now use **display name + immutable id suffix** (example: `ceo-agent2736`).
  - Canonical heartbeat path example: `.fusion/agents/ceo-agent2736/HEARTBEAT.md`
  - Canonical managed bundle directory example: `.fusion/agents/ceo-agent2736-instructions/`
- Legacy id-only paths (for example `.fusion/agents/{agent.id}/HEARTBEAT.md`) and previously created display-name-based paths remain supported.
- Upgrade/create flows preserve existing compatible files and directories in place; Fusion does **not** auto-rename or delete old paths.
- If the selected default file does not exist yet, the backend seeds it from the built-in template.
- After upgrade completes and the agent refreshes, operators can immediately open the seeded per-agent `HEARTBEAT.md` from the same modal section.

## New Agent Presets (Dashboard UI)

The New Agent dialog keeps the existing 3-step flow, and step 0 is split into two tabs:

- **Preset personas** (default) — quick-start persona cards that prefill the same fields and immediately advance to step 1 when selected
- **Custom agent** — manual setup for identity, configuration, and the Generate with AI entry point

### Onboarding fields (step 0 custom tab)

The custom tab exposes separate fields for:

- **Title** (`title`) — optional role title/description
- **Soul** (`soul`) — optional personality and communication style guidance
- **Heartbeat Procedure Path** (`heartbeatProcedurePath`) — optional path to the agent heartbeat markdown file, typically `.fusion/agents/<display-name>-<agent-id>/HEARTBEAT.md` (legacy id-only paths remain valid)
- **Instructions Path** (`instructionsPath`) — optional file-backed instructions path
- **Inline Instructions** (`instructionsText`) — optional inline behavior instructions

For long-form prompt authoring, **Soul**, **Agent Memory**, and **Inline Instructions** now use the same rich editing affordances as other prompt editors in the dashboard:

- Larger default editing surfaces for easier drafting
- Plain/edit mode and Markdown preview mode
- Fullscreen expand/collapse editing for long content (safe-area-aware on mobile)

In Agent Detail → **Agent Memory** → **Memory Files**, selected file content now also supports the same **Edit/Preview** markdown toggle. Preview renders the current in-memory draft (including unsaved edits), while save/edit controls remain gated by agent read-only state.

These controls are also available on the editable review step, so prompt content can be reviewed and refined with the same markdown and fullscreen behavior before submit.

### Final review edits (step 2)

Before clicking **Create**, the final review step remains editable for identity/instruction fields so operators can make last-minute corrections without navigating backward. The review step includes edit-in-place controls for:

- Title
- Soul
- Heartbeat Procedure Path
- Instructions Path
- Inline Instructions

The final `createAgent(...)` call always uses the latest values from these step-2 controls.

### First-run setup first agent

After first-project registration, first-run setup asks whether to create a first persistent agent before entering the dashboard. The CEO preset is selected by default because this first agent is framed as an optional coordinator that can help create tasks and keep direction across sessions.

Users can choose a preset, create the project agent, or skip it and create agents later from the Agents view. Agents are optional for task work: Fusion still starts temporary agents to plan, code, review, and merge tasks.

When `experimentalFeatures.agentOnboarding` is enabled, first-run setup also offers the same draft-first **AI Interview** path used by the New Agent dialog. Applying the interview draft updates the setup preview, but persistence remains explicit through **Create Agent**.

### Experimental planning-style onboarding

The **New Agent** dialog is the canonical launch point for agent creation.

When **Settings → Experimental Features → Planning-style Agent Onboarding** (`experimentalFeatures.agentOnboarding`) is enabled:

- Step 0 of the **New Agent** dialog includes an **AI Interview** entry point for create mode.
- **Agent detail → Settings** includes an **AI Interview** action for edit mode on existing agents.
- The interview flow asks clarifying questions using repo-aware context (existing agents + preset/template options for create mode, plus current agent configuration for edit mode).
- It generates a **draft** configuration summary for review, including identity fields, `soul`, starter `instructionsText`, starter `memory`, heartbeat guidance (`heartbeatProcedurePath`, `heartbeatIntervalMs`, `heartbeatEnabled`), and draft-only runtime/model suggestions (`runtimeHint`, `modelHint`).
- In create mode, confirming the summary (**Apply draft to agent form**) applies the generated draft into `NewAgentDialog`'s existing editable form fields (step 1 / custom flow) for manual review and edits before save.
- In edit mode, **Apply draft to settings form** updates local editable fields in the settings UI.
- The interview flow does **not** auto-create or auto-save agents directly; final persistence still happens only through the standard manual Create/Save action.

When `experimentalFeatures.agentOnboarding` is disabled, the New Agent dialog still opens normally but the **AI Interview** entry point is hidden.

The dashboard provides quick-start presets for common agent roles. Each preset includes:

- **Name, icon, and avatar** - Display identification (`imageUrl` takes priority over `icon` in UI rendering)
- **Professional title** - Descriptive role title
- **Soul** - Personality and operating principles defining how the agent thinks and communicates
- **Instructions** - Actionable behavioral guidelines

### Preset Library Location

Preset definitions live in `packages/dashboard/app/components/agent-presets/`:

```
agent-presets/
├── index.ts              # Exports AGENT_PRESETS and helper functions
├── ceo/soul.md          # Chief Executive Officer soul
├── cto/soul.md          # Chief Technology Officer soul
├── cmo/soul.md          # Chief Marketing Officer soul
├── cfo/soul.md          # Chief Financial Officer soul
├── engineer/soul.md     # Software Engineer soul
├── backend-engineer/soul.md
├── frontend-engineer/soul.md
├── fullstack-engineer/soul.md
├── qa-engineer/soul.md
├── devops-engineer/soul.md
├── ci-engineer/soul.md
├── security-engineer/soul.md
├── data-engineer/soul.md
├── ml-engineer/soul.md
├── product-manager/soul.md
├── designer/soul.md
├── marketing-manager/soul.md
├── technical-writer/soul.md
├── planning/soul.md
└── reviewer/soul.md
```

### Soul File Format

Each `soul.md` file is a Markdown document containing:

```markdown
# Soul: [Role Name]

[First-person identity statement]

## Operating Principles

[Bullet points describing key behaviors]

## Communication Style

[How the agent communicates]
```

Soul content should be:

- **First-person** - Written from the agent's perspective ("I am...")
- **Role-specific** - Defines the unique character of this role
- **Actionable** - Describes concrete behaviors, not abstract qualities
- **Paperclip-inspired** - Clear ownership, decision discipline, communication standards

### Adding or Modifying Presets

1. Create or edit the `soul.md` file in the appropriate directory
2. Update `index.ts` if adding a new preset (export the imported soul and add to `AGENT_PRESETS` array)
3. Run tests to verify: `pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/agent-presets.test.ts`

### Preset vs Engine Templates

**Dashboard presets** are a UI-only concept that populates the New Agent dialog fields (name, icon, role, soul, instructionsText). They don't map to engine types.

**Engine role prompts** (in `agentPrompts` settings) define the actual agent behavior when executing tasks. These are separate from dashboard presets and live in project settings.

This separation means:
- Presets provide starting point personality and instructions for new agents
- Engine templates control actual task execution behavior
- An agent created from a preset can have its engine role prompt customized independently

## Configurable Agent Prompts (`agentPrompts`)

`agentPrompts` project setting supports:

- `templates[]`: custom prompt templates by role
- `roleAssignments`: map role → template ID

When no assignment is configured, Fusion falls back to built-in defaults.

## Fine-Grained Prompt Overrides (`promptOverrides`)

The **Prompts** section in the Settings modal provides a user-friendly interface for customizing specific segments of agent prompts. Unlike `agentPrompts` which replaces entire role templates, `promptOverrides` allows surgical customization of individual prompt sections.

### Supported Override Keys

| Key | Agent Role | Description |
|-----|-----------|-------------|
| `executor-welcome` | executor | Introductory section for the executor agent |
| `executor-guardrails` | executor | Behavioral guardrails and constraints |
| `executor-spawning` | executor | Instructions for spawning child agents |
| `executor-completion` | executor | Completion criteria and signaling |
| `triage-welcome` | planning | Introductory section for the planning agent |
| `triage-context` | planning | Context-gathering instructions |
| `reviewer-verdict` | reviewer | Verdict criteria and format |
| `merger-conflicts` | merger | Merge conflict resolution instructions |
| `agent-generation-system` | — | System prompt for AI-assisted agent plan generation |
| `workflow-step-refine` | — | System prompt for refining workflow step descriptions |

### How It Works

1. Navigate to **Settings → Prompts** in the dashboard
2. Each prompt shows its name, key, description, and current value
3. Edit the textarea to create a custom override
4. Click **Reset** to restore the built-in default

### Clearing Overrides

To clear a specific override, click the **Reset** button in the UI. This sends `null` for that prompt key, deleting the override from settings and reverting to the built-in default.

### Relationship with `agentPrompts`

- `agentPrompts` replaces entire role templates
- `promptOverrides` customizes individual segments within any template
- Both can be used together — `promptOverrides` applies to the segment even within a custom role template

## Inter-Agent Messaging

Messaging is available in dashboard mailbox UI and CLI. In dashboard Mailbox → Agents, operators can choose **All agents** to browse a single combined agent-to-agent stream, or choose a specific agent to keep using per-agent inbox/outbox views.

Agent-backed dashboard chat sessions (including plugin-runtime agents such as Hermes/OpenClaw/Paperclip) also expose mailbox tools (`fn_send_message`, `fn_read_messages`) when a `MessageStore` is wired for that project. Model-only chats without an attached agent do not expose these tools.

### Dashboard Chat workspace tools

Dashboard Chat, Chat Room responders, and task-detail Planner Chat run at the interactive project checkout with coding workspace tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. Use them for user-directed file changes and shell investigation. When a durable agent is bound, its permanent-agent permission policy still governs file writes/deletes and command execution; unbound model Chat has no durable-principal policy gate. Chat must keep the checkout branch sticky: inspect Git freely, but do not use `git checkout` or `git switch` unless the operator explicitly requests it.

Task-detail Planner Chat is included because it is a `task-planner:<taskId>` ChatManager session. This does not change the readonly planning/mission interview lanes or WhatsApp plugin chat. Chat verification remains limited to its existing allowlisted profiles rather than accepting arbitrary shell commands.

### Worktree session file boundary

Pi sessions started in an isolated task worktree reject filesystem paths outside that worktree. The established project-memory and task-attachment exceptions remain unchanged. Separately, when Fusion advertises skill bodies through `AgentOptions.additionalSkillPaths` (including enabled plugin skill roots), it allows only `read`, `glob`, and `grep` to access those exact normalized roots. `write`, `edit`, and Bash working directories remain worktree-bound for skill roots; this is not a general `~/.fusion/plugins` exception.

```bash
fn message inbox
fn message outbox
fn message send AGENT-001 "Please prioritize FN-420"
fn message read MSG-123
fn message delete MSG-123
fn agent mailbox AGENT-001
```

## Permanent agent playbooks

Worked manager/IC/message/blocked/no-task scenarios live in [Permanent Agent Heartbeat Playbooks](./agents-playbooks.md). Prefer those examples over re-deriving tick behavior from engine source.

## Heartbeat Prompt Composition and Autonomous Run Behavior

Heartbeat runs are composed from multiple prompt layers so each wake has full identity and operating context:

1. **System prompt**
   - Task-scoped runs use the task heartbeat system prompt.
   - No-task runs use the ambient/no-task heartbeat system prompt (tool-aligned: no task-scoped tools).
2. **Workspace tool mode**
   - Heartbeat sessions are created with coding-capable workspace tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) inside worktree boundary guards.
   - Heartbeat behavior still stays lightweight: one concrete action per run, then `fn_heartbeat_done`.
   - Engine-owned heartbeat tools are layered on top for both task-scoped and no-task runs. Permanent/custom agents get the safe coordination/work-discovery surface (task creation/delegation, agent config/provisioning, artifacts, memory, messaging, goals/evaluations/identity/reflection, workflow discovery, bounded research, and `fn_ask_question`), while task-only tools such as `fn_task_log`, `fn_task_logs_read`, and task documents stay limited to task-scoped runs.
2. **Agent identity and instructions bundle**
   - Inline instructions (`instructionsText`)
   - File-backed instructions (`instructionsPath`)
   - Soul/personality (`soul`)
   - Agent memory resolved from inline `agent.memory` first, then `.fusion/agent-memory/{agentId}/MEMORY.md` as fallback/supplement
   - Optional project memory guidance (when memory is enabled)
3. **Execution prompt framing**
   - `Identity Snapshot` block (agent ID/role + loaded soul/instructions/memory preview; `memory: loaded` when either inline memory or workspace `MEMORY.md` is present)
   - `Wake Delta` block (source, trigger detail, wake reason, assignment/comments/messages)
   - Optional multi-assign inventory under Wake Delta (`your assigned tasks (coordination inventory…)`) ranked from `assignedAgentId` rows (cap 8); not an implement-from-heartbeat queue
   - Heartbeat procedure block (task-scoped or no-task variant, plus optional per-agent procedure override file)
   - System prompts always include **Critical Rules** (one action, no implement-from-heartbeat, checkout no-retry, blocked dedup) so custom `HEARTBEAT.md` cannot erase them

This structure ensures every run re-anchors on identity, wake reason, and current context before taking action.

**Heartbeat skill policy:** heartbeat sessions load the waking agent’s `metadata.skills` plus enabled plugin skills. There is **no** role fallback to the published `fusion` operator skill on the heartbeat lane.

**Default HEARTBEAT.md seed:** `ensureDefaultHeartbeatProcedureFile` is create-if-missing only. Operator edits to an existing per-agent procedure file are preserved; upgrade without force does not overwrite content.

#### Wake reason values (message wakes)

Heartbeat prompts derive wake reason from trigger context plus current inbox snapshot:

- `message_received` — non-forced wake-on-message trigger with unread inbox content still present.
- `message_received_urgent` — forced/user-urgent wake-on-message trigger with unread inbox content still present.
- `message_received_already_consumed` — wake-on-message trigger fired, but unread inbox/room/comment snapshot is empty at prompt assembly time (already consumed by an earlier serialized run or in-run mailbox read).
- `message_received_urgent_already_consumed` — forced wake equivalent of the already-consumed condition.

The Wake Delta block now includes an inbox snapshot line (`- inbox snapshot: <N> message(s)` or `- inbox snapshot: empty (already consumed)`) so agents can distinguish a true message payload from a stale wake trigger.

For `wake-on-message` / `wake-on-message-forced` runs, Wake Delta also adds:

- `- wake trigger source: message <messageId> from <fromType>:<fromId> (forced when applicable), <still unread|already consumed at snapshot>`

And engine logs emit a structured correlation line keyed by `[wake-trigger-diagnostics]` with the triggering message metadata plus snapshot counters (`inboxUnreadCount`, `wakeMessageStillUnread`, `pendingRoomMessages`).

**Debugging empty-inbox wake noise**

1. `grep "\[wake-trigger-diagnostics\]" <engine-log>`
2. Find lines where `triggerDetail=wake-on-message` (or forced variant) and `inboxUnreadCount=0 wakeMessageStillUnread=false`.
3. Correlate `messageId`, `from=`, and `run=` with the run's Wake Delta block; this indicates a false-positive wake where the trigger message had already been consumed by snapshot time.

### Default Procedure: Bound-Task Scope Discipline

The shipped default `HEARTBEAT_PROCEDURE` (in `packages/engine/src/agent-heartbeat.ts`) now requires bound-task classification on each tick: `executor-class`, `blocked`, or `coordination-class`.

- `executor-class` = implementation work (code/tests/docs prose/build-lint-typecheck)
- `blocked` = blockedBy/dependency/peer/external wait state
- `coordination-class` = planning/triage/routing/decision/review work

When the bound task is `executor-class` or `blocked`, the default procedure directs the run to pivot toward coordination levers (in-progress risk scan, stale in-review queue, idle direct reports, strategic memory themes) rather than trying to advance implementation from heartbeat. When the task is `coordination-class`, the heartbeat can engage directly with the bound task.

The manager-facing reports health block in that prompt is populated from `AgentStore.getAgentsByReportsTo(agent.id)`. Engine code must call that store method with its `AgentStore` instance binding intact because some implementations resolve direct reports through `this.listAgents()`. If the section disappears unexpectedly, look for logs like `Failed to load reports ... Cannot read properties of undefined (reading 'listAgents')`, which indicate an unbound method call regressed.

Direct-report staleness in this reports-health block uses each report's effective heartbeat interval (after `heartbeatMultiplier` is applied once), with threshold `max(effectiveHeartbeatIntervalMs × 1.5, 10 minutes)`. This matches the CEO manual health-check rule and avoids false positives for long-cadence reports. A `running` report is separately marked **stuck** after `2 × heartbeatTimeoutMs`; that is a heartbeat-run work-budget signal, not proof that its assigned task is dead.

When Reports Health says **stuck**, preserve useful work first: check task-log and step freshness, the active heartbeat run, and worktree/session liveness. Do not stop or reassign an agent with live progress; ask for status if needed. Reassign only after confirming both no live session and no forward progress. The monitor, scheduler, and self-healing reattach/reconciliation paths continue to repair genuine orphaned runs.

This behavior is inherited by new non-ephemeral agents because agent creation seeds a per-agent `HEARTBEAT.md` file from the built-in default. If an agent sets `heartbeatProcedurePath`, that markdown file fully replaces the built-in default at runtime for task-scoped heartbeats. No-task heartbeats always fall back to the ambient built-in procedure so the prompt never references task-only tools.

For pre-existing agents, use `POST /api/agents/:id/upgrade-heartbeat-procedure` (also exposed as **Upgrade to Default Heartbeat Procedure** in the agent detail Config tab) to re-seed from the current built-in constant. When the built-in default changes, running this upgrade propagates the new default to existing agents; direct operator edits to an agent’s existing procedure file are preserved unless this upgrade is run (the upgrade overwrites the per-agent file).

### Manual / On-Demand Runs Are Autonomous Heartbeats

`POST /api/agents/:id/runs` with `source: "on_demand"` executes the same autonomous heartbeat flow as timer/assignment triggers. It is **not** a mailbox-only poll.

Expected behavior for both manual and automatic triggers:
- Re-check identity/instructions context for this tick
- Process wake delta first (including message/comment wakes)
- Re-evaluate assignment state
- Take exactly one concrete next action
- Finish with `fn_heartbeat_done`

Messages remain an important input signal, but they do not replace the heartbeat procedure.

### Heartbeat/Executor Separation (Current Behavior)

For permanent agents, heartbeat runs now continue as an ambient coordination loop even when the currently bound task is blocked from normal task progress.

- **Heartbeat path**: coordination, wake processing, mailbox/delegation/memory/task-creation actions, and lightweight ambient follow-through.
- **Executor path**: task-body implementation work from task steps/prompts.

When `allowParallelExecution` is set to `false` on a permanent agent, the two paths serialize symmetrically:
- Heartbeat does not start while the bound task has an active executor session.
- Executor does not start while the agent has an active heartbeat run.

When `allowParallelExecution` is `true` (default), both paths may run concurrently.

## Heartbeat Run Mailbox Checking

When messaging tools are enabled for an agent, heartbeat runs check for unread mailbox messages during execution regardless of the trigger type. This ensures agents can see and respond to incoming messages without needing an explicit wake-on-message trigger.

### Reply Linking Contract

Mailbox replies use `message.metadata.replyTo.messageId` as the stable reply link.

- `fn_read_messages` includes each message ID in its human-readable output so agents can target a specific message.
- When a message has `metadata.replyTo.messageId`, `fn_read_messages` now includes one-level reply-parent context inline (and in structured tool details) so heartbeat/mailbox runs can understand what the message is replying to without expanding full threads.
- `fn_send_message` supports `reply_to_message_id`; when provided, the sent message is stored with `metadata.replyTo.messageId`. If that parent was addressed to the sending agent, the tool safely defaults its recipient to the parent's sender; foreign, missing, or misaddressed parents cannot supply a recipient.
- Heartbeat prompts explicitly instruct agents to include `reply_to_message_id` and the exact sender ID when replying.

The dashboard mailbox UI also uses the same metadata contract when users click **Reply**, so user and agent replies share one threading model.

### Dashboard user recipient convention

For dashboard user messaging, agents should target the canonical user recipient ID `dashboard`.

When an agent is sending to the dashboard user through `fn_send_message`, the message must be stored as `agent-to-user` (agent → dashboard user), not as a user/CLI → agent mailbox message.

Runtime safeguards defensively normalize the legacy alias forms below to the same logical dashboard user:
- `dashboard` (canonical)
- `user:dashboard`
- `User: user:dashboard`

If the message type is omitted but the recipient normalizes to the dashboard user alias, routing defaults to the `agent-to-user` direction to preserve correct inbox semantics.

This normalization applies on send and mailbox reads, so replies from agents still land in the dashboard inbox even when older alias-like recipient strings appear.

### How It Works

Heartbeat runs now surface both direct-message inbox traffic and recent room activity for rooms the agent belongs to. Room traffic is lookback-based (bounded to the prior completed heartbeat / `lastHeartbeatAt`, capped at 24 hours) and is only shown when there are unread/recent messages worth surfacing.

1. **Message Prefetch**: When `messageStore` is available, heartbeat runs fetch up to 10 unread inbox messages for the agent.
2. **Room Prefetch**: When `chatStore` is available, heartbeat runs fetch up to 10 recent room messages per active room (30 total max, self-authored room messages excluded).
3. **Prompt Injection**: Pending messages are injected into the execution prompt with message ID, sender, and timestamp information, followed by a **Pending Room Messages** section grouped by room.
4. **Reply Guidance**: System instructions remind agents to reply with `reply_to_message_id` for direct messages and use `fn_post_room_message` only when room content is relevant to the agent’s role/identity.
5. **Mark as Read**: After successful heartbeat completion, direct inbox messages are marked as read.
6. **Failed Runs**: If the heartbeat execution fails, inbox messages remain unread for retry on the next run.

### Room Coordination Notices (FN-5425)

Heartbeat prompts may include a **Room Coordination Notices** section after **Room Ambiguity Notices** when both conditions are true:

1. A pending room message contains explicit task-filing intent (for example, "file a task" / "create a task").
2. The room currently has at least two active agent members.

This notice is advisory prompt-layer routing (not server-side serialization), with two branches:

- **claim**: the agent should post a one-line claim via `fn_post_room_message` first, then call `fn_task_create`, then post the resulting `FN-NNNN` task ID back to the room.
- **defer-suggested**: a peer claim or task announcement was already seen in recent room history; the agent should **not** call `fn_task_create`, and should instead acknowledge the prior claim/announcement via `fn_post_room_message`.

Deterministic duplicate prevention remains authoritative: FN-4918, FN-4829, FN-5152, and FN-5220 are still the hard intake backstop. The coordination notice reduces upstream duplicate pressure but does not replace those guards.

Each coordination decision emits a run-audit `mutationType` of `room:coordination:branch` with metadata:

- `roomId`
- `agentId`
- `branch` (`"claim" | "defer-suggested"`)
- `memberCount`
- `intentCue`
- `priorClaimMessageId`
- `priorTaskId`

Layering order is intentional: ambiguity guidance renders first, coordination guidance renders second.

### Message Response Modes

The `messageResponseMode` runtime configuration controls when agents are triggered by incoming messages:

| Mode | Behavior |
|------|----------|
| `immediate` | Agent wakes immediately when a message arrives (via hook callback) |
| `on-heartbeat` | Agent processes messages during normal heartbeat runs only |

In the dashboard **Agent Settings** UI, this is surfaced as **Message Response Mode** with matching help text.

**Important**: Both modes include messages in the execution prompt. The `immediate` mode additionally triggers an immediate heartbeat run when a message arrives, while `on-heartbeat` relies on the agent's next scheduled heartbeat.

### One-off send-time immediate wake override

When sending a message to an agent from the dashboard mailbox composer, users can optionally enable **Wake agent immediately** for that send.

- The checkbox is shown only for agent recipients.
- If the target agent already uses `messageResponseMode: "immediate"`, the checkbox is shown as checked/locked to reflect that wake behavior is already always-on.
- The send-time `wakeImmediately` flag is transport-level only; it does **not** change the agent's saved `runtimeConfig.messageResponseMode`.
- On successful send with `wakeImmediately: true`, the API best-effort invokes an on-demand heartbeat (`triggerDetail: "wake-on-message"`) in the correct project scope.

### Message Visibility

- **Timer-triggered runs**: Check mailbox and include pending messages
- **Assignment-triggered runs**: Check mailbox and include pending messages
- **On-demand runs**: Check mailbox and include pending messages
- **Wake-on-message triggers**: Check mailbox and include pending messages (same as other triggers, but triggered immediately)

This ensures inter-agent and user-to-agent communication is visible to agents on each run, avoiding stale coordination, missed instructions, and delayed responses.

## Agent Spawning

Executor sessions can spawn child agents through `spawn_agent`.

Behavior:

- Child agents run in separate worktrees
- Parent/child relationship is tracked
- Limits enforced:
  - `maxSpawnedAgentsPerParent` (default 5)
  - `maxSpawnedAgentsGlobal` (default 20)
- Child sessions terminate when parent task ends

### Approval-governance relationship (FN-3973)

`spawn_agent` is intentionally treated as an **ephemeral runtime mutation**, not durable provisioning:

- `fn_spawn_agent` stays in action-gate `task_agent_mutation` classification.
- Spawned children are created with ephemeral metadata (`metadata.type = "spawned"`) and task-scoped ownership (`reportsTo = parentTaskId`).
- Parent teardown terminates/deletes spawned children; they are not durable hires.
- Therefore `projectSettings.agentProvisioning` (FN-3791 policy for durable `fn_agent_create` / `fn_agent_delete`) does **not** govern `spawn_agent`.

If a deployment config requires approval for `task_agent_mutation`, `spawn_agent` uses the standard action-gate approval pause/resume path (`awaiting-approval` + `/api/approvals/:id/decision`).

## Agent Delegation

Executor and heartbeat agents can coordinate through six built-in tools: `list_agents`, `delegate_task`, `agent_create`, `agent_delete`, `get_agent_config`, and `update_agent_config`.

Delegation is designed for cross-agent handoff (e.g., an executor handing off to a QA agent). For parallel worktree-based parallelization, use `spawn_agent` instead.

### `list_agents`

List all available agents in the system. Shows each agent's name, role, state, personality (`soul`), and current assignment.

| Parameter | Type | Description |
|-----------|------|-------------|
| `role` | `string` (optional) | Filter by agent role/capability (e.g., `"executor"`, `"reviewer"`) |
| `state` | `string` (optional) | Filter by agent state (e.g., `"idle"`, `"active"`, `"running"`) |
| `includeEphemeral` | `boolean` (optional) | Include ephemeral/runtime agents (default: `false`) |

### `delegate_task`

Create a new task and assign it to a specific agent for execution. The task goes to `todo` and will be picked up by the target agent on their next heartbeat cycle.

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_id` | `string` (required) | The agent ID to delegate work to |
| `description` | `string` (required) | What needs to be done |
| `dependencies` | `string[]` (optional) | Task IDs this new task depends on |
| `override` | `boolean` (optional) | Set true to bypass executor-role assignment policy |

**Error cases:**
- `"ERROR: Agent {agent_id} not found"`
- `"ERROR: Cannot delegate to ephemeral/runtime agent {agent_id}"`
- `"ERROR: Agent {agent_id} has role \"...\"; implementation task <new> requires an \"executor\"-role agent by default, with durable \"engineer\" supported only for explicit routing. Pass override=true to bypass."`
- `"ERROR: Task ID already exists: {id}"` (allocator collision; request fails without mutating the existing task)

### `agent_create`

Create a new non-ephemeral direct-report agent. By default, the created agent reports to the caller; privileged (CEO-level) callers can set `reportsTo` to another manager.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` (required) | Name for the new agent |
| `role` | `"triage" \| "executor" \| "reviewer" \| "merger" \| "engineer" \| "custom"` (required) | Agent role/capability |
| `soul` | `string` (optional) | Agent personality/identity text |
| `instructions_text` | `string` (optional) | Inline custom instructions |
| `instructions_path` | `string` (optional) | Path to instructions markdown file |
| `reportsTo` | `string` (optional) | Manager agent ID. Defaults to the calling agent |
| `heartbeat_interval_ms` | `number` (optional, min `1000`) | Heartbeat polling interval in milliseconds |
| `heartbeat_timeout_ms` | `number` (optional, min `5000`) | Heartbeat timeout in milliseconds |
| `max_concurrent_runs` | `number` (optional, min `1`) | Maximum concurrent heartbeat runs |
| `message_response_mode` | `"immediate" \| "on-heartbeat"` (optional) | How the agent responds to messages |

**Authorization rule:** Non-privileged callers may only create agents that report to themselves; privileged callers may set any `reportsTo` target.

**Error case:**
- `"ERROR: You can only create agents that report to you"`

### `agent_delete`

Delete a non-ephemeral direct-report agent. Deletion is blocked when the target holds a checkout lease unless `force: true` is provided, and assigned tasks can be reassigned during deletion via `reassign_to`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_id` | `string` (required) | Agent ID to delete |
| `force` | `boolean` (optional) | Force delete even if the agent currently holds a checkout lease |
| `reassign_to` | `string` (optional) | Replacement agent ID for tasks currently assigned to the deleted agent |

**Authorization rule:** Callers can delete agents where `target.reportsTo === caller.id`; privileged callers may delete any non-ephemeral agent.

**Error cases:**
- `"ERROR: Agent {agent_id} not found"`
- `"ERROR: You can only delete agents that report to you"`
- `"ERROR: Cannot delete ephemeral/runtime agent {agent_id}"`
- Underlying store errors (for example, an active checkout lease) are returned as `"ERROR: {message}"`; provide `force: true` to bypass lease-related blocking.

### Engine-session task reassignment

Engine-managed agent sessions (executor, heartbeat, triage, workflow-step, and dashboard chat) expose `fn_task_assign(task_id, agent_id, override?)` to retarget an existing task by ID. It uses the same durable-agent and role/assignment-policy checks as `fn_delegate_task`; ephemeral agents and `assignmentPolicy: "none"` cannot be selected, and `override` only bypasses the role check.

`fn_task_update` in engine sessions remains lifecycle-only. In the CLI/pi extension, use the existing `fn_task_update(id, agentId)` reassignment field instead; there is no redundant CLI `fn_task_assign` alias. If engine `fn_delegate_task` finds a deterministic duplicate, it updates the canonical task's requested owner and column before returning and reports the actual owner rather than promising an incorrect heartbeat pickup.

### Role-based assignment policy

Implementation-task routing distinguishes explicit specialist assignment from generic backlog pickup:

- **Explicit assignment/delegation** (`PATCH /api/tasks/:id/assign`, `fn_delegate_task`, `fn_task_create`/`fn_task_update` with `agentId`): `role: "executor"` is always supported, and durable `role: "engineer"` is also supported without override.
- **Backlog pickup/auto-claim** (unassigned implementation work): remains executor-only by default; durable engineer agents do not auto-claim generic unassigned implementation backlog.
- Other non-executor roles (for example `reviewer`, `merger`, `custom`) still require an explicit override path on that surface (`override: true`) when intentional.
- Override delegations are persisted with task source metadata (`executorRoleOverride`) so inbox selection and heartbeat execution can intentionally run that assigned implementation task on the targeted durable non-executor agent.

## Heartbeat Monitoring and Trigger Scheduling

Heartbeat/executor ownership now actively renews persisted task lease metadata while work is running (`checkoutLeaseRenewedAt` plus owner node/run context). Abandonment recovery is fenced by `checkoutLeaseEpoch` and executed only through `MeshLeaseManager.recoverAbandonedLease(...)`, so stale owners cannot reclaim tasks after recovery.

Fusion's `HeartbeatTriggerScheduler` supports five trigger types:

- `timer` — periodic wake based on heartbeat interval
- `assignment` — wake when task is assigned to agent
- `on_demand` — manual run trigger (`POST /api/agents/:id/runs`)
- `automation` — triggered by scheduled automation jobs
- `routine` — triggered by routine execution

All triggers respect per-agent `maxConcurrentRuns` and produce structured wake context metadata.

Pause governance for heartbeat execution:
- `globalPause` is a hard stop: timer, assignment, and on-demand heartbeats are skipped with observable run reasons.
- `enginePaused` is a soft stop for heartbeat timers: timer triggers are skipped, while assignment/on-demand triggers remain allowed for critical responsiveness paths.

### Control-Plane Lane (No Task Concurrency Gating)

Heartbeat runs from the Agents panel run on a **separate control-plane lane** that is independent of task execution concurrency limits. This ensures agent responsiveness is preserved even when task pipelines are saturated.

**Key behaviors:**

- Heartbeat runs (via `POST /api/agents/:id/runs`) execute without gating on `maxConcurrent` or in-progress task count
- The `HeartbeatTriggerScheduler` and `HeartbeatMonitor` components do not receive the task-lane semaphore
- Trigger scheduling remains responsive regardless of how busy the task pipeline is
- Active-run 409 conflict semantics still apply — a new heartbeat run is rejected if the agent already has an active run
- `POST /api/agents/:id/state` applies pause/resume immediately when monitor-bound:
  - Transitioning to `paused` first stops any active run via `HeartbeatMonitor.stopRun(agentId)`
  - Transitioning to `active` immediately calls `HeartbeatMonitor.executeHeartbeat(...)` (source: `on_demand`)

**Architectural boundary:**

| Component | Path | Concurrency |
|-----------|------|------------|
| PlanningProcessor | Task lane | Semaphore-gated |
| TaskExecutor | Task lane | Semaphore-gated |
| Scheduler | Task lane | Semaphore-gated |
| onMerge | Task lane | Semaphore-gated |
| HeartbeatMonitor | Utility/control plane | **NOT** semaphore-gated |
| HeartbeatTriggerScheduler | Utility/control plane | **NOT** semaphore-gated |
| CronRunner | Utility/control plane | **NOT** semaphore-gated |

### Timer Repair Sweep for Missing Registrations (FN-3959)

`HeartbeatTriggerScheduler` now owns a timer-registration repair sweep so durable agents cannot stay unscheduled when in-memory timer entries are lost without a follow-up lifecycle event.

Cadence:
- **Immediate startup audit**: runs once in `start()` after lifecycle watchers are attached
- **Periodic audit**: runs every 60s while the scheduler is active
- **FN-7939 audit watchdog**: an independent watchdog supervises the 60s audit driver and re-arms/runs it when the audit liveness timestamp is stale for a bounded multiple of the cadence
- **Cleanup**: periodic sweep and watchdog intervals are cleared in `stop()`

Repair eligibility:
- Durable (non-ephemeral/task-worker) agent
- `runtimeConfig.enabled !== false`
- Agent state is tickable: `active`, `running`, or `idle`
- Agent is missing from the scheduler's in-memory `timers` map, or has a present timer entry but `lastHeartbeatAt` is stale beyond the repair threshold (zombie timer)

Repair outcomes:
- **Missing timer, not stale**: timer is re-armed and INFO diagnostics are logged (`agentId`, resolved interval, elapsed time since `lastHeartbeatAt`)
- **Missing/present timer, stale**: timer is re-armed, WARN diagnostics are logged, and `agent.metadata.heartbeatTimerRepair` is updated (`repairedAt`, `staleAtRepair`, `staleRepairReason`)
- **Repeated non-advancing zombie repair**: after the bounded scheduler threshold, metadata includes the consecutive count/escalation flag and logs `reason=heartbeat-rearm-nonadvancing-escalated` instead of silently churning forever

Stale threshold:
- Repair staleness defaults to **`2 × effectiveHeartbeatIntervalMs`** (after `heartbeatMultiplier` is applied once)
- This is intentionally separate from dashboard display staleness (`1.5× effectiveHeartbeatIntervalMs` with a 10-minute floor)

Dashboard surfacing path:
- The stale-repair metadata write uses the existing `AgentStore.updateAgent(...)` path
- That emits `agent:updated`, which already flows through SSE (`packages/dashboard/src/sse.ts`)
- `useAgents` already refreshes on `agent:updated`/`agent:stateChanged` (`packages/dashboard/app/hooks/useAgents.ts`)
- No new SSE event is introduced; stale durable agents become dashboard-visible as `Unresponsive` through the existing refresh path

**Orphaned-timer invalidation on stop (FN-7718):** CLI-driven `fn agent stop`/`start` mutate the agent row from a separate process, so the in-process `agent:updated` listener never fires for those transitions — the 60s audit is the only cross-process reconciliation path. The audit now unregisters a lingering timer entry for any agent that fails eligibility (non-tickable state, `runtimeConfig.enabled === false`, or ephemeral/non-heartbeat-managed) instead of skipping past it, so a stopped agent never keeps an orphaned/"zombie" registration. `syncTimerForAgent`'s in-process start seam mirrors this: an eligible agent with a present-but-stale timer entry is force-cleared and re-armed rather than left as a no-op. This means a `stop`/`start` cycle is a durable fix — it no longer relies on the FN-7645 stale-repair path eventually catching the drift minutes later.

### Timer State Lifecycle (FN-2289)

Heartbeat timers are armed for agents in valid working states and remain armed across state transitions:

**States where timers remain armed:**
- `active` — Agent is actively working on a task
- `running` — Agent has an active heartbeat run in progress
- `idle` — Agent is between tasks, waiting for work

**States where timers are cleared:**
- `error` — Agent encountered an unrecoverable error
- `paused` — Agent is paused (e.g., by budget exhaustion, manual stop, or manual pause)

Lifecycle notes:
- Agent lifecycle is `idle | active | running | paused | error` (there is no `terminated` `AgentState`).
- Stop/termination flows land the agent in `paused`; `terminated` is reserved for heartbeat run status only.

**Key behaviors:**
- Timers remain armed when agents transition between `active`, `running`, and `idle` states
- This ensures heartbeat cadence is maintained even when agents complete tasks and await new assignments
- Ephemeral/task-worker agents are never armed with timers (managed directly by TaskExecutor)
- The `runtimeConfig.enabled` flag is respected for disabling heartbeat monitoring entirely

### Unresponsive Recovery (FN-3475)

When a tracked agent misses heartbeat for `2 × heartbeatTimeoutMs`, the monitor now performs recovery (not termination). The base `heartbeatTimeoutMs` is already multiplier-scaled (`heartbeatMultiplier`) before applying this `× 2` window:

1. Dispose the stuck session and untrack the stale run
2. `pauseAgent(agentId, { pauseReason: "heartbeat-unresponsive", stopActiveRun: false })`
3. `resumeAgent(agentId, { triggerDetail: "unresponsive-recovery", triggerSource: "heartbeat-unresponsive", clearPauseReason: true })`

Effects:
- Agent state transitions `running/active → paused → active`
- Orphan reconcile uses `3 × heartbeatTimeoutMs` where the timeout is likewise multiplier-scaled first
- `pauseReason` is set to `heartbeat-unresponsive` during recovery and cleared on resume
- Assigned tasks are not paused or unpaused by agent sleep/heartbeat recovery; unpaused work stays eligible for scheduler re-dispatch, while tasks already paused by a user retain their existing pause state
- Resume triggers one on-demand heartbeat restart only when `runtimeConfig.enabled !== false`
- `onTerminated` is a run-level callback for terminated heartbeat runs and is not used by unresponsive recovery

### Timer Reconciliation Self-Healing (FN-3958)

`HeartbeatTriggerScheduler` owns a periodic registration audit that reconciles durable-agent truth in `AgentStore` against the in-memory timer map.

- Audit cadence: once immediately on scheduler start, then every 60 seconds while running
- Repair target: durable, heartbeat-enabled agents in tickable states (`active`, `running`, `idle`) that are missing a timer entry
- Safety guards: skip ephemeral/task-worker agents, skip disabled agents, skip non-tickable states, and skip agents with an active heartbeat run
- Existing timer entries are left untouched (no interval reset/jitter churn)
- Repair metadata: each audit re-arm writes `metadata.heartbeatTimerRepair` with `repairedAt` and a stale-at-repair indicator when the agent had already missed its expected cadence
- Stale-at-repair threshold: defaults to `2 × effectiveHeartbeatIntervalMs` after one `heartbeatMultiplier` application; override with project setting `heartbeatRepairStaleMultiplier` (> 0) when you need a different sensitivity
- Stale repairs emit a WARN log entry and still flow through the existing `agent:updated` refresh path for dashboard surfacing

This covers the untracked timer-loss failure mode where no `agent:updated` event fires after a timer entry disappears. Manual stop/start is no longer required to re-arm the timer in that case.

### Stale Active-Run Reaper (FN-4119)

`HeartbeatTriggerScheduler` also reaps **stale persisted `status="active"` heartbeat runs** before they can block future timer progress forever.

When it fires:
- `onTimerTick()` finds an active run row for a durable, tickable agent
- or `auditTimerRegistrations()` finds a missing timer plus an active run row for that same durable agent
- the persisted run has no fresh heartbeat for longer than **`heartbeatTimeoutMs × heartbeatRepairStaleMultiplier`**
- the engine is not globally paused and not timer-paused via `enginePaused`

Threshold semantics:
- The reaper reuses the same `heartbeatRepairStaleMultiplier` setting that timer-audit repair already uses; no extra stale-run knob exists
- The base signal is the agent's `lastHeartbeatAt` / `recordHeartbeat(...)` freshness, not the scheduled timer interval
- Default threshold is therefore **`2 × heartbeatTimeoutMs`** (default timeout `60s` → default reap threshold `120s`)

Layering with the existing recovery paths:
- **`HeartbeatMonitor.reconcileOrphanedRunningAgents()`** handles orphaned persisted `state="running"` rows and uses `heartbeatTimeoutMs × 3` as a run-budget grace threshold when the active run exists but is untracked.
- **`HeartbeatTriggerScheduler.onTimerTick()`** reaps stale persisted `status="active"` runs at `heartbeatTimeoutMs × heartbeatRepairStaleMultiplier`, logs `reason=tick-proceeded-after-reap`, and proceeds with the scheduled callback in the same tick.
- **`HeartbeatTriggerScheduler.auditTimerRegistrations()`** applies the same stale-run threshold, then reaps stale active runs before re-arming missing timers and logs `reason=timer-audit-rearmed`.
- **`SelfHealingManager.recoverAgentsRunningOnInactiveTasks()` / `recoverStaleHeartbeatRuns()`** are the final backstop using task-state mismatch and PID/max-age guards (not the timeout multiplier formulas above).
- Healthy active runs within threshold still keep the old `(active run)` skip behavior.
- Ephemeral/task-worker agents are never reaped by this path.

Separation of responsibilities:
- **HeartbeatMonitor recovery** handles **tracked stale sessions** (stuck in-memory run/session cleanup + pause/resume restart)
- **HeartbeatTriggerScheduler audit** handles **untracked missing-timer registration drift** (re-arm scheduling)
- **HeartbeatTriggerScheduler stale-run reaper** handles **orphaned persisted active runs** that would otherwise cause both tick and audit to skip forever on `(active run)`

## Dashboard Health Status

The dashboard displays agent health status in AgentsView, AgentListModal, and AgentDetailView using a centralized health evaluation utility (`packages/dashboard/app/utils/agentHealth.ts`).

### Health Labels (Priority Order)

| Label | Condition |
|-------|-----------|
| **Error** | Agent state is "error" (uses lastError if available) |
| **Paused** | Agent state is "paused" (uses pauseReason if available) |
| **Running** | Agent state is "running" (task workers with `active` state also display "Running") |
| **Heartbeat Disabled** | `runtimeConfig.enabled === false` |
| **Starting...** | State is "active" with no lastHeartbeatAt |
| **Idle** | Non-active state with no lastHeartbeatAt |
| **Healthy** | Heartbeat is fresh within the resolved interval-based staleness threshold |
| **Unresponsive** | Heartbeat exceeded the resolved interval-based staleness threshold, or timer-repair metadata indicates scheduler-detected stale drift before the next successful heartbeat |

### Timeout Configuration

Health status uses interval-based staleness evaluation:

1. Resolve the effective heartbeat interval from `runtimeConfig.heartbeatIntervalMs` (or the default 1 hour interval)
2. Multiply that interval by the dashboard grace multiplier (`1.5×`)
3. Apply a minimum staleness floor of 5 minutes

### Key Behaviors

- **Monitoring disabled**: Agents with `runtimeConfig.enabled === false` display "Disabled" — they are NOT falsely labeled as "Unresponsive"
- **Interval-sized gaps are normal**: With the default `heartbeatIntervalMs = 3600000` (1 hour), an agent can legitimately go tens of minutes without a new heartbeat. Ages like 16–50 minutes are expected and should not be treated as unhealthy on interval age alone.
- **Consistent across views**: All dashboard surfaces use the same centralized utility, ensuring consistent health labels everywhere
- **Auto-refresh**: Health status is refreshed every 30 seconds while views are open to keep status current
- **State-first evaluation**: Explicit non-idle states (error, paused, running) take priority over timeout-based evaluation
- **Repair-aware surfacing**: If scheduler audit repairs a missing timer and marks the agent stale, dashboard surfaces `Unresponsive` immediately until a newer heartbeat arrives

## Heartbeat Run Lifecycle

Agent runs have a defined lifecycle managed by `AgentStore`:

### Run States

A heartbeat run can be in one of these states:

- `active` — Run is currently executing
- `completed` — Run finished successfully (via `endHeartbeatRun(runId, "completed")`)
- `terminated` — Run was stopped (via `endHeartbeatRun(runId, "terminated")`)
- `failed` — Run encountered an error

### Run Lifecycle API

- `startHeartbeatRun(agentId)` — Creates a new run and persists it to structured storage
- `endHeartbeatRun(runId, status)` — Ends a run with terminal status, updates persisted state
- `getActiveHeartbeatRun(agentId)` — Returns the current active run (or null)
- `getCompletedHeartbeatRuns(agentId)` — Returns all terminal runs (newest first)
- `saveRun(run)` — Persists run to structured storage
- `getRunDetail(agentId, runId)` — Gets a specific run by ID

### Active-Run Conflict Semantics

When an agent already has an active run, attempts to start a new run return **409 Conflict**:

```
POST /api/agents/:id/runs → 409 { error: "Agent already has an active run", details: { runId } }
```

After a run is completed (or terminated at the run level), a new run can be started successfully:

```
POST /api/agents/:id/runs → 201 { id: "run-xxx", status: "active", ... }
```

### Storage Architecture

Run records are stored in structured JSON files at `.fusion/agents/{agentId}-runs/{runId}.json`.

Heartbeat events are also appended to `.fusion/agents/{agentId}-heartbeats.jsonl` for legacy compatibility. The structured storage is the source of truth; heartbeat events provide a fallback for older run data.

### Thinking/Reasoning Log Persistence

`persistAgentThinkingLog` is a `boolean` setting with a default of `false` (legacy alias for the granular persistence keys). It controls whether `thinking`/reasoning agent-log rows are persisted across agent roles (executor, reviewer, merger, triage, and step-session). When disabled (the default), only `thinking` rows are suppressed; normal assistant text output and tool rows are unchanged. See the [settings reference](./settings-reference.md) for full configuration details.

### Stopping Runs

Use `POST /api/agents/:id/runs/stop` to terminate an active run:

```
POST /api/agents/:id/runs/stop → 200 { ok: true, runId: "run-xxx" }
```

If there's no active run, returns `{ ok: true, message: "No active run" }`.

## Budget Governance

Per-agent token budget tracking controls costs and prevents runaway AI spending. Budget configuration is stored in `runtimeConfig.budgetConfig`.

### Budget Configuration Fields

| Field | Type | Description |
|-------|------|-------------|
| `tokenBudget` | `number` | Maximum tokens allowed per budget period |
| `usageThreshold` | `number` (0-1) | Percentage threshold (0.8 = 80%) to trigger warning/warning state |
| `budgetPeriod` | `"daily" \| "weekly" \| "monthly" \| "total"` | Reset interval for budget tracking |
| `resetDay` | `number` (0-6) | Day of week for weekly reset (0=Sunday) |

### Budget Status Fields

| Field | Type | Description |
|-------|------|-------------|
| `isOverBudget` | `boolean` | Budget limit exceeded |
| `isOverThreshold` | `boolean` | Usage exceeded warning threshold |
| `periodStart` | `string` | ISO timestamp when current period started |
| `inputTokens` | `number` | Tokens used in current period |
| `outputTokens` | `number` | Tokens generated in current period |
| `totalTokens` | `number` | Combined input + output tokens |

### Enforcement Behavior

Budget enforcement is centralized in `HeartbeatMonitor.executeHeartbeat()`:

- **Timer triggers**: Budget is enforced in `executeHeartbeat()` which creates explicit run records with `budget_exhausted` or `budget_threshold_exceeded` reasons. This makes timer budget skips observable rather than silent drops — users see explicit "skipped" run records in the dashboard instead of timer ticks that appear to "not run".
- **Assignment and on-demand triggers**: Budget is enforced in `executeHeartbeat()` with the same outcome recording. These triggers are allowed when over threshold (but not over budget) to maintain responsiveness.

When the engine is not paused, the `HeartbeatTriggerScheduler` dispatches timer callbacks regardless of budget status, delegating budget enforcement to the execution layer. This ensures every eligible timer tick produces a heartbeat run record that is visible in the agent's run history.

Agents can be paused by budget exhaustion. Timer-triggered heartbeats skip when over threshold to avoid runaway costs, but assignment-triggered and on-demand runs may still execute for responsiveness.

### Budget API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/:id/budget` | Get current budget status |
| `POST` | `/api/agents/:id/budget/reset` | Reset budget counters for current period |

## Agent Performance Ratings

Agent performance ratings allow users and agents to provide feedback that influences future behavior through system prompt injection.

### Rating API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/:id/ratings` | List all ratings for an agent |
| `POST` | `/api/agents/:id/ratings` | Submit a new rating |
| `GET` | `/api/agents/:id/ratings/summary` | Get aggregated rating summary |
| `DELETE` | `/api/agents/:id/ratings/:ratingId` | Delete a specific rating |

### Rating Structure

Ratings use a 1-5 scale:

| Value | Meaning |
|-------|---------|
| 1 | Poor — consistently fails or produces low-quality output |
| 2 | Below average — often needs correction |
| 3 | Average — meets expectations with occasional issues |
| 4 | Good — reliable with minor improvements possible |
| 5 | Excellent — exceeds expectations consistently |

### Rating Summary

The summary endpoint returns aggregated statistics:

```json
{
  "agentId": "AGENT-001",
  "averageRating": 4.2,
  "totalRatings": 15,
  "ratingDistribution": { "1": 0, "2": 1, "3": 2, "4": 8, "5": 4 },
  "trend": "improving"
}
```

The `trend` field indicates rating trajectory: `"improving"`, `"declining"`, or `"stable"`.

### Input Format

To submit a rating:

```
POST /api/agents/:id/ratings
{
  "rating": 4,
  "comment": "Agent completed the task efficiently with minimal corrections needed",
  "taskId": "FN-123"
}
```

## Related Docs

- [Workflow Steps](./workflow-steps.md)
- [Settings Reference](./settings-reference.md)
- [Architecture](./architecture.md)

## Permission Policies

Permanent-agent sensitive actions are gated across these categories:
- `git_write`
- `file_write_delete`
- `command_execution`
- `network_api`
- `task_agent_mutation`
- `review_gate_bypass` (FN-7728; overridden to `require-approval` under `unrestricted`/grant-all)
- `file_scope` (FN-7737; uniform disposition, so `unrestricted`/grant-all resolves it to `allow`)

Each category can be set to one disposition:
- `allow`
- `require-approval`
- `block`

Precedence:
1. Per-agent exact `toolRules` override (Agent Detail → Settings → Permissions)
2. Per-agent category rule
3. Project default exact `toolRules` override (`defaultAgentPermissionPolicy` in Project Settings → Agent Permissions)
4. Project default category rule
5. Built-in fallback preset (`unrestricted` / allow-all)

For example, `toolRules: { "fn_task_create": "block" }` with `rules.task_agent_mutation: "allow"` blocks new task creation while allowing other governed task-agent mutation tools. Per-agent category rows can inherit project defaults category-by-category; per-agent exact-tool rows override project exact-tool rows when present.

## Pi extension scope (`packages/cli/src/extension.ts`)

The pi extension ships as part of `@runfusion/fusion` and provides tools + a `/fn` command for chat agents.

**Update when:**
- CLI commands change (behavior, flags, output)
- Task store / Agent store API changes
- New user-facing features chat agents should be able to use

**Don't add tools for engine-internal operations** (move, step updates, logging, merge) — those are owned by the engine's own agents.

The extension has no skills — tool descriptions give the LLM everything it needs.

Published SDK surface: `@runfusion/fusion/plugin-sdk` now ships as a public subpath export from the CLI package, exposing `definePlugin`, `validatePluginManifest`, and the plugin type surface for external plugin authors without depending on private `@fusion/*` workspace packages.

### `fn_web_fetch`

Lightweight URL read from agent/chat sessions. HTTP GET, follows redirects, extracts readable text (HTML→text and JSON pretty-print), bounded.

Universal baseline: available by default across executor, step-session, reviewer, merger, triage, and heartbeat (including engineer/custom direct-report paths). Gated under the `network_api` action-gate category (FN-4603).

- Defaults: `timeoutMs=30000`, `maxBytes=512000` (500 KB)
- Blocks private/loopback/link-local hosts (including DNS-resolved) unless explicitly overridden in internal/test contexts
- Read-only (no JS rendering, no auth flows, no POST/cookie workflows)
- Use the `agent-browser` skill when JS rendering or interactive navigation is required

## Goal-citation audit trail (Slice 2 success signal)

Agents now emit a durable goal-citation signal whenever reasoning text includes a goal ID.

- Scanned surfaces: `agent_log` and `task_document`.
- Regex contract: `GOAL_ID_PATTERN = /\bG-[0-9A-Z]+(?:-[0-9A-Z]+)*\b/g` (uppercase `G-...` only).
- Snippets are bounded windows (`GOAL_CITATION_SNIPPET_MAX = 200`) around the first match per goal ID, with whitespace collapsed.
- Query via CLI:
  - `fn goals citations --since <iso> --until <iso>`
  - `fn goals citations --goal G-XXXX --since <iso>`
- Example row:
  - `2026-05-29T08:10:00.000Z  G-1ABC-2-XYZ9  agent-ops  agent_log  agentLog:4821`
  - `    ...anchoring this plan to G-1ABC-2-XYZ9 before execution...`
- Programmatic consumers can query the same signal through `TaskStore.listGoalCitations(...)`.

## Agent coordination tools summary

Seven coordination tools support spawning, provisioning, discovery, delegation, and direct-report config.

- `spawn_agent` — Parent-task-scoped ephemeral child in its own worktree. Limits via `maxSpawnedAgentsPerParent` (default 5) and `maxSpawnedAgentsGlobal` (default 20). Auto-terminated with parent. Gated under generic `task_agent_mutation` (FN-3973 explicitly excludes it from durable `agentProvisioning` policy).
- `agent_create` / `agent_delete` — Non-ephemeral provisioning of direct reports. Policy-gated via `projectSettings.agentProvisioning` (`approvalMode`, `trustedRoles`, `trustedAgentIds`, `alwaysApproveDelete`). Tool responses use `details.outcome`: `created` / `deleted` / `pending_approval` / `denied`. Pending requests resolve via `POST /api/approvals/:id/decision`. Audit events: `agent:{create,delete}:{requested,approved,denied}`.
- `list_agents` — Discovery with `role`/`state`/`includeEphemeral` filters.
- `delegate_task` — Create + assign task to a specific agent. Implementation tasks require executor-role target unless `override: true`. Cannot target ephemeral agents (use `spawn_agent`).
- `get_agent_config` / `update_agent_config` — Read/write soul, instructions, heartbeat interval/timeout, max concurrent runs, message response mode. **Authorization**: caller can only act on agents where `target.reportsTo === caller.id`. Cannot operate on ephemeral agents.

## Checkout leasing

- 409 Conflict = ownership contention. Response: `{ error, currentHolder, taskId }`. **Never auto-retry 409.**
- `HeartbeatMonitor.executeHeartbeat()` validates checkout before work begins; mismatched `checkedOutBy` exits with `reason: "checkout_conflict"`. Heartbeat does not auto-checkout — callers obtain the lease.
- With `CentralClaimStore` wired, the authoritative owner is the central `taskClaims` row; per-project lease fields mirror it. `MeshLeaseManager.recoverAbandonedLease()` releases central first then local. `reconcileLeaseRow(taskId)` converges divergent state on the next tick (emits `task:auto-recover-lease-*`). Without a claim store, behavior remains single-node per-project.

## Agent runtime config

Per-agent overrides via `runtimeConfig`:
- **Heartbeat**: `heartbeatIntervalMs`, `heartbeatTimeoutMs`, `maxConcurrentRuns`. Triggered by timer, task assignment, or on-demand (`POST /api/agents/:id/runs`).
- **Budgets**: per-agent token budget tracking; `HeartbeatMonitor.executeHeartbeat()` skips when `isOverBudget` or `isOverThreshold` (timer triggers). Hard caps pause the agent.
- **Performance ratings**: 1–5 scale with trend analysis, injected into system prompts.
