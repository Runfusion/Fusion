# Agents

[← Docs index](./README.md)

Fusion uses multiple agent roles for triage, execution, review, and merge workflows.

## Agents View (Dashboard)

The agents surface provides:

- Agent list and status
- Detail/config panels
- Runtime metrics
- Run history
- Task assignment context

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

Heartbeat values are validated and minimum-clamped.

## Configurable Agent Prompts (`agentPrompts`)

`agentPrompts` project setting supports:

- `templates[]`: custom prompt templates by role
- `roleAssignments`: map role → template ID

When no assignment is configured, Fusion falls back to built-in defaults.

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

## Agent Spawning

Executor sessions can spawn child agents through `spawn_agent`.

Behavior:

- Child agents run in separate worktrees
- Parent/child relationship is tracked
- Limits enforced:
  - `maxSpawnedAgentsPerParent` (default 5)
  - `maxSpawnedAgentsGlobal` (default 20)
- Child sessions terminate when parent task ends

## Heartbeat Monitoring and Trigger Scheduling

Fusion’s `HeartbeatTriggerScheduler` supports three trigger types:

- `timer` — periodic wake based on heartbeat interval
- `assignment` — wake when task is assigned to agent
- `on_demand` — manual run trigger (`POST /api/agents/:id/runs`)

All triggers respect per-agent `maxConcurrentRuns` and produce structured wake context metadata.

## Related Docs

- [Workflow Steps](./workflow-steps.md)
- [Settings Reference](./settings-reference.md)
- [Architecture](./architecture.md)
