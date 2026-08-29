# `spawn_agent` approval-governance evaluation (FN-3973)

## Decision

Keep `fn_spawn_agent` under the existing generic runtime action-gate category (`task_agent_mutation`) and **do not** move it under `projectSettings.agentProvisioning`.

## Current behavior (verified)

- `fn_spawn_agent` is implemented in `TaskExecutor.createSpawnAgentTool()` (`packages/engine/src/executor.ts`).
- Spawned children are created via `AgentStore.createAgent()` with `metadata.type = "spawned"` and `reportsTo = <parentTaskId>`.
- Child worktrees are derived from the parent task worktree, child sessions are started immediately, and children are tracked in executor in-memory maps.
- Parent end/cleanup paths call `terminateChildAgents(...)`; spawned ephemeral agents are terminated/deleted with parent lifecycle teardown.
- Tool-level runtime classification includes `fn_spawn_agent` in `ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS`, so policy disposition comes from permanent-agent action gate (`task_agent_mutation`) rather than provisioning policy.

## Why not `agentProvisioning`

`agentProvisioning` (from FN-3791) is purpose-built for **durable** `fn_agent_create`/`fn_agent_delete` with mailbox approval workflows and deferred execution on `/api/approvals/:id/decision`. `spawn_agent` differs materially:

- **Persistence:** spawned agents are ephemeral runtime workers.
- **Ownership:** children are task-scoped to a parent run, not independent hires.
- **Reversibility:** teardown is automatic with parent completion/termination.
- **Blast radius:** bounded to parent-task worktree lineage and configured spawn limits.

Forcing `spawn_agent` into durable provisioning policy would conflate two different risk models and create approval UX friction for intentionally short-lived parallelization.

## Rejected alternatives

1. **Reuse `agentProvisioning` for spawn** — rejected; wrong policy surface for ephemeral lifecycle and would overfit mailbox deferred-provisioning UX.
2. **New spawn-specific policy today** — rejected for now; no demonstrated gap requiring an additional setting surface.
3. **Bypass approval entirely** — rejected; current action-gate path already provides configurable allow/block/approval behavior for permanent callers.

## Approval UX, pause/resume, and audit implications

- `fn_spawn_agent` remains governed by runtime action-gate decisions (`task_agent_mutation`) for permanent agents.
- If configured as `require-approval`, existing action-gate approval flow applies (request creation, task/agent pause with `awaiting-approval`, resume on approval decision route).
- This path uses existing approval APIs and mailbox approvals; no new approval endpoint or queue is required.
- No runtime behavior change is required by this decision.

## Migration/follow-up impact

- **No code migration required.**
- Documentation was aligned so future implementers do not route spawn into durable provisioning by default.

## Non-goals

- Reworking `spawn_agent` runtime lifecycle.
- Introducing a new `spawnAgentProvisioning` settings block.
- Changing current approval infrastructure endpoints or mailbox behavior.
