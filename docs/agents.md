# Agents

[← Docs index](./README.md)

Fusion uses multiple agent roles for planning, execution, review, and merge workflows.

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
| `permissionPolicy` | ✓ | ✓ | ✗ | Runtime action-gating policy for permanent agents (default/fallback: `unrestricted`) |
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

## Permission Policy Presets (Permanent Agents)

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
- `none` (classifier-only read-only result; never stored as a policy rule key)

`permissionPolicy` uses only the five sensitive categories above (everything except `none`) and the FN-3545 disposition contract:

- `allow`
- `block`
- `require-approval`

### Runtime gate v1 mapping (per tool invocation, permanent agents only)

The engine classifies tool calls by behavior (not namespace alone):

- `file_write_delete`: built-in `write` / `edit`, plus persistent write helpers like `fn_task_document_write`, `fn_memory_append`, `fn_task_attach`
- `command_execution`: built-in `bash` when not classified as mutating git
- `git_write`: mutating git shell commands run via `bash`
- `network_api`: external/network-facing tools (for example `fn_research_run`, `fn_research_cancel`, `fn_research_retry`)
- `task_agent_mutation`: task/agent mutation tools (for example `fn_update_agent_config`, `fn_task_pause`, `fn_spawn_agent`; action-gate task-import/create tools like `fn_task_create`, `fn_delegate_task`, `fn_task_import_github`, and `fn_task_import_github_issue` use this category in action-gate evaluation)
- `none`: positively recognized read-only tools (`read`, `grep`, `find`, `ls`, list/show/get-style `fn_*` tools, plus permanent-agent coordination/task-creation helpers like `fn_task_create`, `fn_delegate_task`, `fn_task_import_github`, and `fn_task_import_github_issue`)

`bash` git-write heuristic in v1:

- Mutating git operations include: `git add`, `commit`, `merge`, `rebase`, `cherry-pick`, `am`, `apply`, `stash`, `tag`, `push`, `reset`, `rm`, `mv`, `clean`, `worktree add/remove`, `checkout -b`, `switch -c`, `pull --rebase`, `restore --staged`, and branch/remote mutation forms.
- Read-only git operations include: `git status`, `diff`, `log`, `show`, `rev-parse`, `branch --show-current`, `branch` listing, and `remote -v`.

Unknown/unclassified tool fallback:

- In permanent-agent sessions, unknown tools default to `require-approval` (fail-safe).
- Category `none` only yields `allow` when the tool is positively recognized as read-only.
- Internal Fusion runtime coordination tools (heartbeat completion, task/agent coordination, messaging, evaluations, identity reflection, memory bookkeeping) are exempt by design and always allowed so permanent-agent heartbeats can complete.
- Operators can reload the in-memory exempt-tool registry at runtime via `POST /api/action-gate/reload` (optional body `{ "tools": string[] }`) to apply exemption-list updates without restarting the engine process.
- Canonical tool classification/exemption sets live in `packages/engine/src/gating-classifications.ts` and are shared by both action-gate paths.

Approval pause/resume lifecycle (FN-3548):

- Permanent-agent gating short-circuits `block` and `require-approval` actions before tool execution and returns structured non-success tool results.
- For `require-approval`, the engine creates/reuses a durable approval request and pauses execution with canonical `pauseReason: "awaiting-approval"`.
- If task-backed, the owning task is paused (`Task.paused=true`, `pausedByAgentId=<requester>`); the requesting agent is paused (`state="paused"`, `pauseReason="awaiting-approval"`).
- Dedupe semantics by `approvalDedupeKey`: `pending` reuses the same request, `approved` allows exactly one execution and then marks request `completed`, `denied` stays blocked, `completed` requires a fresh request.
- HTTP decision endpoint resumes best-effort: `POST /api/approvals/:id/decision` with `{ decision: "approve" | "deny", comment? }` unpauses matching task/agent when they are paused for `awaiting-approval`.
- Approval API surface: `GET /api/approvals` (supports status/limit/offset and returns `{ requests, total, pendingCount }`), `GET /api/approvals/:id` (includes request context + audit/history), `POST /api/approvals/:id/decision`.
- Dashboard mailbox is the primary v1 resolution surface: approvals appear in the mailbox **Approvals** tab with pending/history views and inline approve/deny controls for pending requests.
- Dashboard mailbox entry points (Header/Mobile nav) display pending-approval indicators so waiting approvals are visible before opening Mailbox.
- Agents list/board cards and Agent Detail summary display per-agent `pendingApprovalCount` badges to show which agents are blocked by waiting approvals.

Agent provisioning approvals (`agent_provisioning` category):

- `fn_agent_create` / `fn_agent_delete` can return `pending_approval` under `projectSettings.agentProvisioning` policy (`approvalMode`, trusted roles/IDs, `alwaysApproveDelete`).
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
- Legacy permanent-agent rows missing `permissionPolicy` resolve to the same effective `unrestricted` policy at read time (no eager migration required).
- Ephemeral/runtime task-worker agents are intentionally left unchanged and are not backfilled with a default `permissionPolicy`.

Separation of concerns:

- `permissions` capability flags (plus role defaults) determine what an agent is conceptually authorized to do (for example, `tasks:assign`, `agents:create`).
- `permissionPolicy` determines how sensitive runtime actions are gated (`allow`, `block`, `require-approval`) once the capability path is in play.
- Dashboard persona presets (`packages/dashboard/app/components/agent-presets/`) are UI templates for identity/behavior and are **not** the source of truth for permission-policy enforcement.

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

### Assigned-agent runtime model precedence for task execution

When a task is executed by an assigned durable agent, executor session model selection now prefers that agent's explicit runtime model when it is fully specified.

Executor precedence for task runs:
1. Assigned agent `runtimeConfig` model pair (combined `runtimeConfig.model = "provider/modelId"` or separate `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) when both provider and model ID are present
2. Task `modelProvider` + `modelId`
3. Project/global execution lane fallbacks (same resolution as unassigned runs)

If the assigned agent runtime model is missing or incomplete, Fusion falls back to the normal task/settings execution hierarchy.

### Durable-agent heartbeat model precedence and unavailable-provider behavior

Heartbeat sessions for durable agents resolve models with heartbeat-specific fallback semantics:

1. Agent runtime model (`runtimeConfig.model` or `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) when present
2. Execution-lane settings fallback (`executionProvider`/`executionModelId` → `executionGlobalProvider`/`executionGlobalModelId` → project/global defaults)

When the runtime model is present and differs from execution-lane settings, heartbeat passes the execution-lane model as a fallback pair for session creation.

If a heartbeat cannot create/run a session due to unavailable provider credentials or missing provider registration, Fusion records `resultJson.reason = "heartbeat_model_unavailable"` with actionable diagnostics in `resultJson.detail`/`stderrExcerpt`.

### Durable-agent transient error auto-recovery

Self-healing may auto-recover **durable (non-ephemeral)** agents stuck in `state="error"` when all eligibility checks pass:

- agent is non-ephemeral (`isEphemeralAgent(...) === false`)
- heartbeat runtime is enabled (`runtimeConfig.enabled !== false`)
- no active heartbeat execution is already running for the agent
- `lastError` classifies as transient network/infrastructure failure
- `lastError` is **not** operator-actionable (credentials/model/billing-style failures)

When eligible, self-healing uses bounded retries with persisted metadata at `agent.metadata.durableErrorRecovery`:

- exponential cooldown (`30s` base, capped at `15m`)
- retry budget cap (`5` attempts)
- persisted `attempts`, `lastAttemptAt`, `nextRetryAt`, `exhausted`, and `lastReason`

On restart attempts, the runtime triggers the normal heartbeat pipeline with `source: "automation"` and a structured `contextSnapshot.selfHealing` payload so operators can audit recovery runs in heartbeat history.

Self-healing intentionally leaves agents in `error` (no auto-restart) when blockers are operator-actionable or non-transient, when cooldown has not elapsed, when active execution is present, or when retry budget is exhausted.

- **Timer trigger:** run completes and the durable agent returns to `state="active"` (recoverable soft-fail).
- **Assignment / on-demand trigger:** run completes with `resultJson.actionRequired = true`, then the durable agent is paused with `pauseReason="heartbeat-model-unavailable"` and `lastError` set to actionable credential guidance (including the missing provider name when detectable).

After credentials are fixed, operators should resume the paused durable agent; subsequent heartbeats proceed normally.

### Assigned-agent identity + planning model precedence for task triage

When a triage/specification run targets a task with `assignedAgentId` and that agent is durable, planning now inherits the assigned agent context instead of only generic triage-role defaults.

Triage inheritance behavior:
1. The triage system prompt includes assigned-agent identity context and resolves instructions/soul/memory from that agent (including existing rating-aware instruction composition)
2. Triage memory tools are created with assigned-agent memory context (`createMemoryTools(..., { agentMemory })`), so `fn_memory_search` / `fn_memory_get` can access `.fusion/agent-memory/{agentId}/...` during planning
3. Planning model resolution prefers a complete assigned-agent runtime model pair first, then task planning overrides, then normal planning/project/global fallbacks

As with execution, incomplete assigned-agent model configuration falls through cleanly to the existing planning hierarchy.

### Task Detail Agent Log model provenance

The Task Detail → Agent Log model header prefers runtime provenance markers written during execution/review:

- `Executor using model: <provider>/<modelId>`
- `Reviewer using model: <provider>/<modelId>`
- `Triage using model: <provider>/<modelId>`

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
- A compact **Controls** popup for secondary actions (state filter, Show system agents toggle, Import, and global Heartbeat Speed)
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

Triage and executor runtime sessions include a bounded research tool surface only when `experimentalFeatures.researchView` is enabled for the project:

- `fn_research_run` — create/start a bounded research run for a focused query
- `fn_research_list` — list recent runs and statuses
- `fn_research_get` — fetch one run's structured findings payload
- `fn_research_cancel` — cancel an active run

These tools return structured metadata (`runId`, `status`, `summary`, `findings`, `citations`, `error`, `setup`) in addition to concise text so downstream model steps can consume results deterministically.

Expected behavior and boundaries:

- Agents should use research only when repository/local context is insufficient
- Queries should stay narrow and task-scoped; avoid open-ended exploration
- When `experimentalFeatures.researchView` is disabled, sessions do not register `fn_research_*` tools and prompts do not advertise research capabilities
- If the research surface is enabled but an explicitly selected external provider is misconfigured (or web search is explicitly disabled), tools return actionable `setup` responses instead of crashing
- Durable conclusions should be persisted with `fn_task_document_write` (for example, `key="research"`)
- Research runs require the project engine to be running for processing; `fn_research_run` creates the run but does not block for completion unless `wait_for_completion` is set

For the full research workflow, builtin-default behavior, optional external provider setup, CLI commands, and API reference, see the [Research guide](./research.md).

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
| `heartbeatTimeoutMs` | `number` | — | Time without heartbeat before agent is considered unresponsive (ms) |
| `maxConcurrentRuns` | `number` | `1` | Max concurrent heartbeat runs for this agent |
| `runMissedHeartbeatOnStartup` | `boolean` | `false` | When enabled, if the server was down across this agent's scheduled heartbeat tick, fire one catch-up heartbeat at startup (only when `lastHeartbeatAt` is older than the resolved interval) |
| `allowParallelExecution` | `boolean` | `true` (when unset) | Permanent agents only. When `false`, heartbeat and executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run |
| `messageResponseMode` | `"immediate" \| "on-heartbeat"` | `"immediate"` | Whether agent wakes immediately on message (immediate) or processes during heartbeat (on-heartbeat). See [Heartbeat Run Mailbox Checking](#heartbeat-run-mailbox-checking) |
| `selfImproveEnabled` | `boolean` | `true` | Enable periodic self-improvement reflection prompts during heartbeat runs |
| `selfImproveIntervalMs` | `number` | `14400000` (4h) | Minimum delay between self-improvement cycles (minimum enforced: 3600000 ms) |
| `lastSelfImproveAt` | `string` (ISO timestamp) | — | Last recorded self-improvement checkpoint timestamp |
| `modelProvider` | `string` | — | AI provider override for heartbeat session |
| `modelId` | `string` | — | AI model ID override for heartbeat session |
| `budgetConfig` | `AgentBudgetConfig` | — | Token budget governance settings |

Heartbeat values are validated and minimum-clamped to 5 minutes (300,000 ms).
Project setting `heartbeatMultiplier` (default `1`) scales resolved heartbeat intervals globally; per-agent `heartbeatIntervalMs` remains the base interval before multiplier scaling. This setting is configured from the **Agents** screen's **Controls** popup under "Heartbeat Speed".

`runMissedHeartbeatOnStartup` defaults to `false` and is configured in **Agent Detail → Settings → Heartbeat Settings → Run Missed Heartbeat On Startup**.

`allowParallelExecution` defaults to `true` when unset; setting it to `false` is serialized explicitly so operators can enforce non-parallel heartbeat/executor behavior for that permanent agent. Configure it in **Agent Detail → Settings → Heartbeat Settings → Allow Parallel Execution**.

### No-task auto-claim behavior

When an identity-bearing, non-ephemeral agent wakes with no assigned task and `runtimeConfig.autoClaimRelevantTasks !== false`, the heartbeat monitor scans open todo tasks and may claim one before constructing the prompt run.

Guardrails:
- Only unpaused, unassigned, unchecked-out todo tasks with satisfied dependencies are considered
- Claims are rejected for terminal/paused/owned/conflicting tasks
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

```bash
fn message inbox
fn message outbox
fn message send AGENT-001 "Please prioritize FN-420"
fn message read MSG-123
fn message delete MSG-123
fn agent mailbox AGENT-001
```

## Heartbeat Prompt Composition and Autonomous Run Behavior

Heartbeat runs are composed from multiple prompt layers so each wake has full identity and operating context:

1. **System prompt**
   - Task-scoped runs use the task heartbeat system prompt.
   - No-task runs use the ambient/no-task heartbeat system prompt (tool-aligned: no task-scoped tools).
2. **Workspace tool mode**
   - Heartbeat sessions are created with coding-capable workspace tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) inside worktree boundary guards.
   - Heartbeat behavior still stays lightweight: one concrete action per run, then `fn_heartbeat_done`.
   - Engine-owned heartbeat tools are still layered on top (task creation/log/docs for task-scoped runs; ambient/delegation/memory tools for no-task runs).
2. **Agent identity and instructions bundle**
   - Inline instructions (`instructionsText`)
   - File-backed instructions (`instructionsPath`)
   - Soul/personality (`soul`)
   - Agent memory resolved from inline `agent.memory` first, then `.fusion/agent-memory/{agentId}/MEMORY.md` as fallback/supplement
   - Optional project memory guidance (when memory is enabled)
3. **Execution prompt framing**
   - `Identity Snapshot` block (agent ID/role + loaded soul/instructions/memory preview; `memory: loaded` when either inline memory or workspace `MEMORY.md` is present)
   - `Wake Delta` block (source, trigger detail, wake reason, assignment/comments/messages)
   - Heartbeat procedure block (task-scoped or no-task variant, plus optional per-agent procedure override file)

This structure ensures every run re-anchors on identity, wake reason, and current context before taking action.

### Default Procedure: Bound-Task Scope Discipline

The shipped default `HEARTBEAT_PROCEDURE` (in `packages/engine/src/agent-heartbeat.ts`) now requires bound-task classification on each tick: `executor-class`, `blocked`, or `coordination-class`.

- `executor-class` = implementation work (code/tests/docs prose/build-lint-typecheck)
- `blocked` = blockedBy/dependency/peer/external wait state
- `coordination-class` = planning/triage/routing/decision/review work

When the bound task is `executor-class` or `blocked`, the default procedure directs the run to pivot toward coordination levers (in-progress risk scan, stale in-review queue, idle direct reports, strategic memory themes) rather than trying to advance implementation from heartbeat. When the task is `coordination-class`, the heartbeat can engage directly with the bound task.

The manager-facing reports health block in that prompt is populated from `AgentStore.getAgentsByReportsTo(agent.id)`. Engine code must call that store method with its `AgentStore` instance binding intact because some implementations resolve direct reports through `this.listAgents()`. If the section disappears unexpectedly, look for logs like `Failed to load reports ... Cannot read properties of undefined (reading 'listAgents')`, which indicate an unbound method call regressed.

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
- `fn_send_message` supports `reply_to_message_id`; when provided, the sent message is stored with `metadata.replyTo.messageId`.
- Heartbeat prompts explicitly instruct agents to include `reply_to_message_id` when replying.

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
- **Cleanup**: periodic sweep interval is cleared in `stop()`

Repair eligibility:
- Durable (non-ephemeral/task-worker) agent
- `runtimeConfig.enabled !== false`
- Agent state is tickable: `active`, `running`, or `idle`
- Agent is missing from the scheduler's in-memory `timers` map

Repair outcomes:
- **Missing timer, not stale**: timer is re-armed and INFO diagnostics are logged (`agentId`, resolved interval, elapsed time since `lastHeartbeatAt`)
- **Missing timer, stale**: timer is re-armed, WARN diagnostics are logged, and `agent.metadata.heartbeatTimerRepair` is updated (`repairedAt`, `staleAtRepair`, `elapsedMs`, `staleThresholdMs`)

Stale threshold:
- Repair staleness defaults to **`2 × heartbeatIntervalMs`**
- This is intentionally separate from dashboard display staleness (`4×` grace multiplier)

Dashboard surfacing path:
- The stale-repair metadata write uses the existing `AgentStore.updateAgent(...)` path
- That emits `agent:updated`, which already flows through SSE (`packages/dashboard/src/sse.ts`)
- `useAgents` already refreshes on `agent:updated`/`agent:stateChanged` (`packages/dashboard/app/hooks/useAgents.ts`)
- No new SSE event is introduced; stale durable agents become dashboard-visible as `Unresponsive` through the existing refresh path

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

When a tracked agent misses heartbeat for `2 × heartbeatTimeoutMs`, the monitor now performs recovery (not termination):

1. Dispose the stuck session and untrack the stale run
2. `pauseAgent(agentId, { pauseReason: "heartbeat-unresponsive", stopActiveRun: false })`
3. `resumeAgent(agentId, { triggerDetail: "unresponsive-recovery", triggerSource: "heartbeat-unresponsive", clearPauseReason: true })`

Effects:
- Agent state transitions `running/active → paused → active`
- `pauseReason` is set to `heartbeat-unresponsive` during recovery and cleared on resume
- Assigned tasks are auto-paused with `pausedByAgentId` during pause, then only those same tasks are auto-unpaused on resume
- Resume triggers one on-demand heartbeat restart only when `runtimeConfig.enabled !== false`
- `onTerminated` is a run-level callback for terminated heartbeat runs and is not used by unresponsive recovery

### Timer Reconciliation Self-Healing (FN-3958)

`HeartbeatTriggerScheduler` owns a periodic registration audit that reconciles durable-agent truth in `AgentStore` against the in-memory timer map.

- Audit cadence: once immediately on scheduler start, then every 60 seconds while running
- Repair target: durable, heartbeat-enabled agents in tickable states (`active`, `running`, `idle`) that are missing a timer entry
- Safety guards: skip ephemeral/task-worker agents, skip disabled agents, skip non-tickable states, and skip agents with an active heartbeat run
- Existing timer entries are left untouched (no interval reset/jitter churn)
- Repair metadata: each audit re-arm writes `metadata.heartbeatTimerRepair` with `repairedAt` and a stale-at-repair indicator when the agent had already missed its expected cadence
- Stale-at-repair threshold: defaults to `2 × heartbeatIntervalMs`; override with project setting `heartbeatRepairStaleMultiplier` (> 0) when you need a different sensitivity
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
- **`HeartbeatMonitor.reconcileOrphanedRunningAgents()`** still handles monitor-owned stale `running` agents and other tracked-session cleanup
- **`HeartbeatTriggerScheduler.onTimerTick()`** now reaps a stale active run, logs `reason=tick-proceeded-after-reap`, and proceeds with the scheduled callback in the same tick
- **`HeartbeatTriggerScheduler.auditTimerRegistrations()`** now reaps the stale active run first, then re-arms the missing timer in the same audit pass and logs `reason=timer-audit-rearmed`
- Healthy active runs within threshold still keep the old `(active run)` skip behavior
- Ephemeral/task-worker agents are never reaped by this path

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
2. Multiply that interval by the dashboard grace multiplier (`4×`)
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
