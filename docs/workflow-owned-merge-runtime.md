# Workflow-Owned Merge Runtime

Fusion now has a workflow-owned merge/retry/recovery substrate that can run in
parallel with the legacy queue while slices are reviewed.

## Implemented Runtime Surfaces

- `workflow_work_items` persists workflow work item states: `runnable`,
  `running`, `held`, `retrying`, `manual-required`, `succeeded`, `failed`,
  `cancelled`, and `exhausted`.
- Workflow work item kinds are `task`, `merge`, `retry`, `manual-hold`, and
  `recovery`.
- `TaskStore.projectMergeRequestToWorkflowWorkItem` projects legacy merge request
  rows onto workflow work items.
- Completion handoff creates workflow merge work at `merge-gate`; `autoMerge:false`
  creates `manual-required` work at `merge-manual-hold`.
- `claimDueWorkflowWorkItem` leases due work without reading task lifecycle
  columns.
- `WorkflowTaskRuntime.runWorkItem` executes a leased node and persists the work
  item terminal state.
- `runWorkflowMergeAttemptNode` calls the existing guarded merge primitive and
  maps outcomes to workflow values such as `merged`, `already-landed`,
  `transient-failure`, and `manual-required`.
- `publishWorkflowRecoveryEvent` records self-healing facts as runnable
  `recovery-router` work.
- `projectWorkflowWorkStatus` gives dashboard/API/CLI surfaces a workflow-first
  projection with legacy fields as fallback only.

## Cutover Guards

The migration carries deletion guards under `packages/engine/src/__tests__/`:

- `workflow-scheduler-policy-deletion.test.ts`
- `workflow-merge-policy-deletion.test.ts`
- `workflow-self-healing-policy-deletion.test.ts`
- `workflow-cutover-matrix.test.ts`

These tests fail if the new workflow-owned paths start depending on task-column
merge/retry policy, hidden merge queue APIs, or direct self-healing lifecycle
mutation.
