# Agents

[← Docs index](./README.md)

Fusion uses multiple agent roles for triage, execution, review, and merge workflows.

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
| `reportsTo` | ✓ | ✓ | ✓ (from manifest) | Parent agent ID |
| `runtimeConfig` | ✓ | ✓ | ✗ | Heartbeat/budget config |
| `permissions` | ✓ | ✓ | ✗ | Capability flags |
| `instructionsPath` | ✓ | ✓ | ✗ | File-backed instructions path |
| `instructionsText` | ✓ | ✓ | ✓ (from manifest `instructionBody`) | Inline instructions |
| `soul` | ✓ | ✓ | ✗ | Personality/identity description |
| `memory` | ✓ | ✓ | ✗ | Per-agent accumulated knowledge |
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
| `skills` | `metadata.skills` | — |

### System-Managed Fields (Not User-Editable)

These fields are managed by the engine and cannot be directly edited:

- `id` — Auto-generated unique identifier
- `state` — Agent lifecycle state (managed by engine)
- `taskId` — Current working task (managed by scheduler)
- `totalInputTokens` / `totalOutputTokens` — Token usage totals (managed by engine)
- `createdAt` / `updatedAt` / `lastHeartbeatAt` — Timestamps (managed by system)
- `lastError` — Last error message (managed by engine)
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
- `triage`
- `todo`
- `in-progress`
- `in-review`

**Graceful degradation:**
- If task lookup fails (e.g., task deleted), `taskId` is preserved in the response to avoid false negatives
- The underlying `taskId` is NOT modified in storage — only the API response is sanitized

### Update-Only Fields

These fields can only be set during update (not on create):

- `pauseReason` — Why the agent is paused
- `lastError` — Last error message
- `totalInputTokens` — Accumulated input token count
- `totalOutputTokens` — Accumulated output token count

## Agents View (Dashboard)

The agents surface provides:

- Agent list and status
- Detail/config panels
- Runtime metrics
- Run history
- Task assignment context

### Agent Deletion Controls

Agent deletion is available from both the detail header lifecycle controls and the **Settings** tab's danger zone.

- The Settings-tab delete button reuses the same delete flow as the header action.
- Deletion still requires confirmation before calling `DELETE /api/agents/:id`.
- On successful deletion, the dashboard shows a success toast and closes the detail view.
- Deletion availability is intentionally restricted to agents in `idle` or `terminated` state.

![Agents view](./screenshots/agents-view.png)

## Built-In Agent Prompt Templates

Fusion includes built-in templates for role prompts:

- `default-executor`
- `default-triage`
- `default-reviewer`
- `default-merger`
- `senior-engineer`
- `strict-reviewer`
- `concise-triage`

These can be assigned per role using `agentPrompts.roleAssignments`.

## Per-Agent Configuration

Agents can be configured with:

- Custom instructions
- Heartbeat interval/timeout limits
- Max concurrent heartbeat runs
- Budget governance settings
- Model overrides for heartbeat sessions

### Runtime Configuration Fields

The `runtimeConfig` field on agents supports the following options:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Whether heartbeat triggers are enabled for this agent |
| `heartbeatIntervalMs` | `number` | — | How often the agent should wake up for heartbeat checks (ms) |
| `heartbeatTimeoutMs` | `number` | — | Time without heartbeat before agent is considered unresponsive (ms) |
| `maxConcurrentRuns` | `number` | `1` | Max concurrent heartbeat runs for this agent |
| `messageResponseMode` | `"immediate" \| "on-heartbeat"` | `"immediate"` | Whether agent wakes immediately on message (immediate) or processes during heartbeat (on-heartbeat). See [Heartbeat Run Mailbox Checking](#heartbeat-run-mailbox-checking) |
| `modelProvider` | `string` | — | AI provider override for heartbeat session |
| `modelId` | `string` | — | AI model ID override for heartbeat session |
| `budgetConfig` | `AgentBudgetConfig` | — | Token budget governance settings |

Heartbeat values are validated and minimum-clamped to 5 minutes (300,000 ms).
Project setting `heartbeatMultiplier` (default `1`) scales resolved heartbeat intervals globally; per-agent `heartbeatIntervalMs` remains the base interval before multiplier scaling. This setting is configured from the **Agents** screen's "Heartbeat Speed" control.

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

## New Agent Presets (Dashboard UI)

The New Agent dialog in the dashboard provides quick-start presets for common agent roles. Each preset includes:

- **Name and icon** - Display identification
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
├── triage/soul.md
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
| `triage-welcome` | triage | Introductory section for the triage/specification agent |
| `triage-context` | triage | Context-gathering instructions |
| `reviewer-verdict` | reviewer | Verdict criteria and format |
| `merger-conflicts` | merger | Merge conflict resolution instructions |
| `agent-generation-system` | — | System prompt for AI-assisted agent specification generation |
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

Messaging is available in dashboard mailbox UI and CLI.

```bash
fn message inbox
fn message outbox
fn message send AGENT-001 "Please prioritize FN-420"
fn message read MSG-123
fn message delete MSG-123
fn agent mailbox AGENT-001
```

## Heartbeat Run Mailbox Checking

When messaging tools are enabled for an agent, heartbeat runs check for unread mailbox messages during execution regardless of the trigger type. This ensures agents can see and respond to incoming messages without needing an explicit wake-on-message trigger.

### Reply Linking Contract

Mailbox replies use `message.metadata.replyTo.messageId` as the stable reply link.

- `read_messages` includes each message ID in its human-readable output so agents can target a specific message.
- `send_message` supports `reply_to_message_id`; when provided, the sent message is stored with `metadata.replyTo.messageId`.
- Heartbeat prompts explicitly instruct agents to include `reply_to_message_id` when replying.

The dashboard mailbox UI also uses the same metadata contract when users click **Reply**, so user and agent replies share one threading model.

### How It Works

1. **Message Prefetch**: When `messageStore` is available, heartbeat runs fetch up to 10 unread inbox messages for the agent.
2. **Prompt Injection**: Pending messages are injected into the execution prompt with message ID, sender, and timestamp information.
3. **Reply Guidance**: System instructions remind agents to reply with `reply_to_message_id` for linked threads.
4. **Mark as Read**: After successful heartbeat completion, messages are marked as read.
5. **Failed Runs**: If the heartbeat execution fails, messages remain unread for retry on the next run.

### Message Response Modes

The `messageResponseMode` runtime configuration controls when agents are triggered by incoming messages:

| Mode | Behavior |
|------|----------|
| `immediate` | Agent wakes immediately when a message arrives (via hook callback) |
| `on-heartbeat` | Agent processes messages during normal heartbeat runs only |

**Important**: Both modes include messages in the execution prompt. The `immediate` mode additionally triggers an immediate heartbeat run when a message arrives, while `on-heartbeat` relies on the agent's next scheduled heartbeat.

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

## Agent Delegation

Executor and heartbeat agents can discover and delegate work to other agents using two built-in tools:

- **`list_agents`** — List available agents with optional filters (role, state, includeEphemeral)
- **`delegate_task`** — Create a task and assign it to a specific agent; the task enters `todo` and the agent picks it up on their next heartbeat

Delegation is designed for cross-agent handoff (e.g., an executor handing off to a QA agent). For parallel worktree-based parallelization, use `spawn_agent` instead.

## Heartbeat Monitoring and Trigger Scheduling

Fusion's `HeartbeatTriggerScheduler` supports five trigger types:

- `timer` — periodic wake based on heartbeat interval
- `assignment` — wake when task is assigned to agent
- `on_demand` — manual run trigger (`POST /api/agents/:id/runs`)
- `automation` — triggered by scheduled automation jobs
- `routine` — triggered by routine execution

All triggers respect per-agent `maxConcurrentRuns` and produce structured wake context metadata.

### Control-Plane Lane (No Task Concurrency Gating)

Heartbeat runs from the Agents panel run on a **separate control-plane lane** that is independent of task execution concurrency limits. This ensures agent responsiveness is preserved even when task pipelines are saturated.

**Key behaviors:**

- Heartbeat runs (via `POST /api/agents/:id/runs`) execute without gating on `maxConcurrent` or in-progress task count
- The `HeartbeatTriggerScheduler` and `HeartbeatMonitor` components do not receive the task-lane semaphore
- Trigger scheduling remains responsive regardless of how busy the task pipeline is
- Active-run 409 conflict semantics still apply — a new heartbeat run is rejected if the agent already has an active run

**Architectural boundary:**

| Component | Path | Concurrency |
|-----------|------|------------|
| TriageProcessor | Task lane | Semaphore-gated |
| TaskExecutor | Task lane | Semaphore-gated |
| Scheduler | Task lane | Semaphore-gated |
| onMerge | Task lane | Semaphore-gated |
| HeartbeatMonitor | Utility/control plane | **NOT** semaphore-gated |
| HeartbeatTriggerScheduler | Utility/control plane | **NOT** semaphore-gated |
| CronRunner | Utility/control plane | **NOT** semaphore-gated |

### Timer State Lifecycle (FN-2289)

Heartbeat timers are armed for agents in valid working states and remain armed across state transitions:

**States where timers remain armed:**
- `active` — Agent is actively working on a task
- `running` — Agent has an active heartbeat run in progress
- `idle` — Agent is between tasks, waiting for work

**States where timers are cleared:**
- `terminated` — Agent has completed or been stopped
- `error` — Agent encountered an unrecoverable error
- `paused` — Agent is paused (e.g., by budget exhaustion or manual action)

**Key behaviors:**
- Timers remain armed when agents transition between `active`, `running`, and `idle` states
- This ensures heartbeat cadence is maintained even when agents complete tasks and await new assignments
- Ephemeral/task-worker agents are never armed with timers (managed directly by TaskExecutor)
- The `runtimeConfig.enabled` flag is respected for disabling heartbeat monitoring entirely

## Dashboard Health Status

The dashboard displays agent health status in AgentsView, AgentListModal, and AgentDetailView using a centralized health evaluation utility (`packages/dashboard/app/utils/agentHealth.ts`).

### Health Labels (Priority Order)

| Label | Condition |
|-------|-----------|
| **Terminated** | Agent state is "terminated" |
| **Error** | Agent state is "error" (uses lastError if available) |
| **Paused** | Agent state is "paused" (uses pauseReason if available) |
| **Running** | Agent state is "running" (task workers with `active` state also display "Running") |
| **Disabled** | `runtimeConfig.enabled === false` |
| **Starting...** | State is "active" with no lastHeartbeatAt |
| **Idle** | Non-active state with no lastHeartbeatAt |
| **Healthy** | Heartbeat is fresh within configured timeout |
| **Unresponsive** | Heartbeat exceeded configured timeout |

### Timeout Configuration

Health status uses a timeout-based evaluation:

1. If `runtimeConfig.heartbeatTimeoutMs` is set on the agent, use that value
2. Otherwise, use the default 60-second (60000ms) timeout

### Key Behaviors

- **Monitoring disabled**: Agents with `runtimeConfig.enabled === false` display "Disabled" — they are NOT falsely labeled as "Unresponsive"
- **Consistent across views**: All dashboard surfaces use the same centralized utility, ensuring consistent health labels everywhere
- **Auto-refresh**: Health status is refreshed every 30 seconds while views are open to keep status current
- **State-first evaluation**: Terminal states (terminated, error, paused, running) take priority over timeout-based evaluation

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

After a run is completed (or terminated), a new run can be started successfully:

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

The `HeartbeatTriggerScheduler` always dispatches timer callbacks regardless of budget status, delegating budget enforcement to the execution layer. This ensures every timer tick produces a heartbeat run record that is visible in the agent's run history.

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
