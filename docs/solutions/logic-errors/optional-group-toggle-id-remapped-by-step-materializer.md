---
title: "Optional-group enable toggle silently bypassed — node id collided with a legacy step-template namespace and was remapped"
date: 2026-06-21
category: docs/solutions/logic-errors
module: engine (workflow store + graph executor)
problem_type: logic_error
component: service_object
symptoms:
  - "Enabling a built-in optional-group (browser-verification) on a coding/stepwise task did nothing — the group's steps never ran."
  - "The default-on seed path and direct graph-executor unit tests passed, masking the bug; only user-driven enable (create-with-enable or update/toggle) failed."
  - "No error surfaced — the enabled group was silently bypassed."
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - workflow-store
  - graph-executor
  - optional-group
tags:
  - optional-group
  - enabledworkflowsteps
  - per-task-override
  - id-collision
  - workflow-store
  - silent-bypass
---

# Optional-group enable toggle silently bypassed — node id collided with a legacy step-template namespace and was remapped

## Problem

A graph-native `optional-group` workflow node is enabled per task via the `enabledWorkflowSteps` array, keyed by the group's **node id**. The graph executor runs the group only when `task.enabledWorkflowSteps.includes(node.id)`. But the store's `resolveEnabledWorkflowSteps` ran every id through the **legacy step-template materializer** (`getBuiltInWorkflowTemplate` → `ensureWorkflowStepForTemplate`). The built-in `browser-verification` group deliberately reused the template id `"browser-verification"` as its node id (for back-compat), so that id matched a `WORKFLOW_STEP_TEMPLATES` entry and was **remapped to a materialized `WorkflowStep` row id** (≠ the node id). The executor's membership check then never matched, and the enabled group was silently bypassed — the headline use case (turn the optional step on) did nothing, with no error.

## Symptoms

- Enabling `browser-verification` on a coding/stepwise task ran nothing pre-merge.
- Direct graph-executor tests (which pass a raw `enabledWorkflowSteps: ["browser-verification"]`) and the default-on **seed** path passed — masking the defect.
- Only the **user-driven** enable paths failed: create-with-explicit-enable and `updateTask({ enabledWorkflowSteps })` (the per-task toggle in the UI).

## What Didn't Work

- **Trusting the existing tests.** The unit tests used group ids like `og-on`/`og-off` that do **not** collide with any `WORKFLOW_STEP_TEMPLATES` id, so `getBuiltInWorkflowTemplate` returned undefined and the id passed through untouched — the tests were green precisely because they avoided the colliding id. The bug only fires when the group id equals a built-in template id.
- **Assuming the executor test covered it.** The two-task divergence test enabled the group by writing `enabledWorkflowSteps` straight onto the task, bypassing the store's resolver — so it never exercised the remap. The defect lived entirely in the create/update **resolution** path, one layer above the executor.

## Solution

Pass a workflow's optional-group node ids through `resolveEnabledWorkflowSteps` **untouched** — they are executor toggle keys, not legacy step-template ids to be materialized.

```ts
// NEW: enumerate every optional-group node id (regardless of defaultOn).
export function resolveAllOptionalGroupIds(ir: WorkflowIr): string[] {
  return resolveWorkflowOptionalSteps(ir).map((step) => step.templateId); // templateId === group node id
}

// store.ts — the resolver gains an optional pass-through set:
private async resolveEnabledWorkflowSteps(
  stepIds?: string[],
  optionalGroupIds?: Set<string>,
): Promise<string[] | undefined> {
  // ...
  // Optional-group toggle ids pass through raw — never materialized as legacy step rows.
  const template = optionalGroupIds?.has(stepId)
    ? undefined
    : this.getBuiltInWorkflowTemplate(stepId);
  const resolvedId = template ? (await this.ensureWorkflowStepForTemplate(stepId)).id : stepId;
  // ...
}

// helper resolving the task's workflow IR → its optional-group id set:
private async optionalGroupIdSet(workflowId?: string | null): Promise<Set<string>> {
  const wfId = workflowId ?? (await this.getDefaultWorkflowId());
  if (!wfId) return new Set();
  const def = await this.getWorkflowDefinition(wfId);
  if (!def || def.kind === "fragment") return new Set();
  return new Set(resolveAllOptionalGroupIds(def.ir));
}
```

Both user-enable call sites supply the set: create (`optionalGroupIdSet(input.workflowId)`) and update (`optionalGroupIdSet(getTaskWorkflowSelection(task.id)?.workflowId)`).

**Regression test** — must use a **colliding** id (`browser-verification`), since non-colliding ids never reproduce it: create-with-enable and update/toggle both assert the raw group node id survives in `enabledWorkflowSteps`.

## Why This Works

The bug is a **per-task override that is read correctly at the action site but rewritten en route**. The override (`enabledWorkflowSteps`) was consulted exactly where the action runs (the graph executor), but the value was mutated in the **resolution path** before it got there, because two id namespaces overlap: graph-native optional-group **node ids** and legacy **`WorkflowStep` template ids**. The materializer is meaningful only for the retired declaration/`workflow-step`-seam execution model; for a graph-native group it is pure harm. Marking group ids as pass-through keeps the key **identity-stable** from definition through every consumer, so the executor's `includes(node.id)` check matches.

(Verified the related slim-projection trap does **not** apply: the executor reads `enabledWorkflowSteps` off the `TaskDetail` snapshot it is handed, not a column-narrowed SELECT, so the array is fully hydrated.)

## Prevention

- **When introducing a new identity/key that shares a namespace with an existing one, grep every reader AND every *transformer* of that key.** A silent remap in a resolver is as fatal as a missing read — the override "survives" but as the wrong value. Demand each consumer is either re-keyed or argued identity-stable.
- **Regression tests for namespace collisions must use a *colliding* value.** A test with a deliberately distinct id proves nothing about the collision; pick the id that actually overlaps the legacy namespace (here, a built-in template id reused as a node id).
- **Test the path the user actually takes, not just the layer under test.** The executor-level test bypassed the store resolver where the bug lived; a create/update round-trip through the store would have caught it. Prefer at least one end-to-end seam test per per-task facet.
- **A facet that "works on seed/default but not on toggle" is the tell.** Asymmetry between the seed path (writes raw ids) and the user-enable path (runs the resolver) localizes the defect to the resolver.

## Related Issues

This is the **id-namespace-collision variant** of the per-task/per-entity override blast-radius class. Same disease (override invisible to the user, no error), different organ (key rewritten in resolution vs. not consulted at a trigger gate):

- [Per-task auto-merge override ignored by trigger-layer gates](../logic-errors/per-task-auto-merge-override-ignored-by-trigger-gates.md) — sibling: override dead from the user's perspective; theirs is a missed trigger gate, ours is a resolution-path key remap. Its "consult the override everywhere between definition and action" rule covers this case too.
- [Per-entity execution-principal override: the full blast-radius checklist](../architecture-patterns/per-entity-execution-principal-override-blast-radius.md) — the generalizing checklist; closest prior art is its "validate composite node ids against the graph, never round-trip them" example. This bug is a new bullet for that checklist.
- [Workflow-native execution through runtime primitives](../architecture-patterns/workflow-native-runtime-primitives.md) — context: the legacy-`WorkflowStep`-row vs. graph-node two-control-planes tension this collision exploits.
