# Custom Workflow Reliability Acceptance Map

[← Docs index](./README.md)

<!--
FNXC:CustomWorkflowReliability 2026-06-17-05:41:
Goal G-MPW67VQR-0001-97S3 needs an end-to-end reliability acceptance map for the custom workflow system so authoring, selection, execution, recovery, and restart behavior can be verified by measurable criteria instead of ad hoc spot checks.
This artifact distinguishes MVP/blocking requirements from nice-to-have enhancements and keeps implementation out of scope: confirmed gaps become focused follow-up tasks rather than product-code changes in this documentation task.
-->

## Purpose

This map defines the minimum reliability bar for landing the custom workflow system reliably for goal **G-MPW67VQR-0001-97S3**. It translates the MVP framing in [Custom Non-Coding Workflows MVP Spec](./custom-workflows-mvp-spec.md), runtime contracts in [Workflow Steps](./workflow-steps.md), visual authoring behavior in [Workflow Editor](./workflow-editor.md), policy boundaries in [Workflow Policy Ownership Map](./workflow-policy-ownership-map.md), and lifecycle/recovery invariants in [Architecture](./architecture.md) into end-to-end acceptance criteria.

Use this document to write engineering tasks, QA plans, and release checks. It is not a product implementation plan; when a criterion is not met, file or link a focused follow-up task and keep code changes out of this artifact.

## Priority split

| Priority | Acceptance area | Why it blocks or waits |
|---|---|---|
| MVP/blocking | Valid custom workflow creation/import/update, read-only built-in protection, and persisted workflow IDs discoverable through `fn_workflow_list` | Operators cannot run or select a workflow until authoring is durable and validation fails closed. |
| MVP/blocking | Task workflow assignment through dashboard selectors, `fn_workflow_select`, and `workflow_id` on `fn_task_create` / delegation tools | Runtime reliability depends on explicit selections resolving predictably and unselected tasks falling back only to `builtin:coding`. |
| MVP/blocking | Workflow graph execution through `WorkflowGraphExecutor` / workflow runtime primitives with lifecycle invariants preserved | The graph runtime is the authoritative lifecycle path; it must preserve file-scope guards, hard-cancel, merge, and recovery semantics. |
| MVP/blocking | `toolMode: readonly`, `gateMode`, structured verdict, `REVISE`, and required-artifact completion gating | These are the MVP safety and completion contracts from the custom-workflows MVP spec. |
| MVP/blocking | Recovery/restart behavior emits observable facts and never silently moves workflow work backward | Reliability requires durable state, bounded recovery, and auditability across scheduler/engine restarts. |
| Nice-to-have/enhancement | Workflow settings cross-node sync | Settings export includes workflow values, but settings sync explicitly does not sync workflow values yet. |
| Nice-to-have/enhancement | Dedicated workflow run telemetry events and adoption dashboards | The MVP spec identifies telemetry gaps (`workflow_definition_registered`, `workflow_run_started`, run-level status, definition-ID tagging) as instrumentation improvements; existing acceptance can use task state, task documents, workflow results, and run-audit until those land. |
| Nice-to-have/enhancement | Rich marketplace/templates, cross-workflow orchestration, external write connectors, migration/versioning | Explicitly deferred by the MVP cut list and not needed for first reliable custom workflow runs. |

## Critical journey catalog

### 1. Author, import, duplicate, and save a custom workflow

- **Actor / need:** A workflow author needs to create or copy a workflow that can be reviewed, saved, and selected without corrupting built-in definitions.
- **Trigger:** Open the [Workflow Editor](./workflow-editor.md) from the dashboard, duplicate a built-in with **Duplicate to customize**, start from Blank, import a JSON envelope, or use workflow tools such as `fn_workflow_create` / `fn_workflow_update`.
- **Expected happy path + lifecycle transitions + feedback:** The editor serializes graph nodes/edges, columns, fields, and setting declarations into Workflow IR, saves the custom definition, and keeps built-ins read-only. The saved workflow appears in the editor picker and `fn_workflow_list`; no task lifecycle transition occurs until a task selects the workflow. The editor reports whether the workflow can run on the linear engine or must run on the graph interpreter.
- **Failure / recovery expectation:** Invalid JSON, dangling edges, illegal cycles, unplaced nodes, blocking column-trait violations, invalid setting/field declarations, and attempts to mutate built-ins are rejected before partial persistence. Import errors and server validation errors render in a persistent inline error region; built-ins show read-only hints and disable mutation controls.
- **Measurable success signal:** A stable workflow ID is returned/listed by `fn_workflow_list`; `fn_workflow_get` or the editor reload shows the saved IR; invalid saves return a typed validation failure without changing the prior persisted definition.
- **Priority:** MVP/blocking for save/validation/discovery; enhancement for AI-assisted design quality and richer telemetry around definition registration.

### 2. Edit graph routing, columns, custom fields, and workflow settings safely

- **Actor / need:** A workflow author needs to evolve a workflow's routing policy, board columns, task fields, and per-project values without losing existing task data.
- **Trigger:** Edit nodes/edges in the graph inspector, modify Columns/Fields/Settings panels, save setting **Definitions**, save per-project **Values**, or call `fn_workflow_settings`.
- **Expected happy path + lifecycle transitions + feedback:** Graph edits persist as Workflow IR; column changes update workflow-defined lanes/traits; field declarations validate and render dynamic task fields; setting values resolve per `(workflow, project)` as `stored value ?? declaration default`. No active task should change lifecycle state merely because an author opens or saves settings; tasks consume effective settings on execution/resume.
- **Failure / recovery expectation:** Invalid field values, incompatible enum defaults, unknown settings, orphaned setting values, and invalid workflow setting writes are rejected or dropped from effective settings without corrupting stored declarations. Editing or switching a workflow must orphan removed/incompatible task field values rather than destroy them.
- **Measurable success signal:** The editor reloads the saved graph/schema; `fn_workflow_settings(action="get")` returns stored and effective values; invalid `fn_workflow_settings(action="set")` writes reject atomically; orphaned task custom fields remain visible under the task detail disclosure.
- **Priority:** MVP/blocking for validation and non-destructive persistence; nice-to-have for cross-node workflow setting sync.

### 3. Select a workflow for a task, board, or mission-derived feature task

- **Actor / need:** An operator or triage agent needs to route work through the intended workflow at task creation or before execution, including tasks that originate from mission features.
- **Trigger:** Use the dashboard task/board workflow selector, task detail **Workflow** tab, `fn_workflow_select`, `workflow_id` on `fn_task_create` / delegation tools, or mission feature triage/linking surfaces such as `fn_feature_link_task` where the created/linked task carries a workflow selection.
- **Expected happy path + lifecycle transitions + feedback:** Unselected tasks resolve to `builtin:coding`; explicitly selected workflows persist on the task before scheduler pickup; newly created tasks enter the normal planning/todo path for their selected workflow; mission goal provenance remains derived through the mission/feature hierarchy rather than copied onto the task row. The UI shows the selected workflow and offers **Edit workflow** in the task workflow context.
- **Failure / recovery expectation:** A missing or corrupt explicit custom workflow fails closed as a workflow-resolution failure instead of silently falling back to `builtin:coding`. Invalid workflow IDs supplied through tools reject with a clear validation error. Mission links must preserve their own linked-task guards; deleting mission hierarchy cannot silently drop live linked tasks.
- **Measurable success signal:** The task record/tool output shows the selected workflow ID; task detail shows the workflow context; runtime starts with the selected workflow; workflow-resolution failures park the task with an explicit error rather than executing the wrong workflow.
- **Priority:** MVP/blocking for per-task selection and fail-closed resolution; nice-to-have for first-class mission-feature workflow defaults if not already supported by a triage entry point.

### 4. Execute the selected workflow through the graph runtime

- **Actor / need:** The scheduler/executor needs to run the selected workflow deterministically while preserving Fusion's observable task lifecycle.
- **Trigger:** A schedulable task with a selected or default workflow is picked up for execution.
- **Expected happy path + lifecycle transitions + feedback:** `TaskExecutor.execute()` resolves the workflow, pins graph execution for the run, and `WorkflowGraphExecutor` traverses nodes through workflow runtime primitives such as planning, execute, workflow-step, review, merge, schedule, and step-execute. Standard coding work continues to show `todo → in-progress → in-review → done` (or equivalent workflow-defined columns/holds where enabled), workflow checks appear on task cards/list/detail, and task documents/artifacts are persisted as produced.
- **Failure / recovery expectation:** Unsupported edge conditions throw `WorkflowIrError`; explicit custom workflow resolution failures fail closed; interpreter failures park as workflow failures rather than re-running a legacy imperative path. File-scope guards (`FileScopeViolationError`), squash overlap enforcement, `autoMerge:false` terminal-until-human behavior, and `moveTask(in-progress → todo)` hard-cancel semantics remain non-bypassable.
- **Measurable success signal:** Workflow results are visible in task card/list/detail surfaces; node outcomes route according to `success`, `failure`, or `outcome:<value>` edges; relevant run-audit records exist for lifecycle/git/database mutations; parity instrumentation emits `workflow:parity-observed` or `workflow:parity-drift` when dual-observe is enabled.
- **Priority:** MVP/blocking.

### 5. Enforce gate, revision, readonly, and required-artifact contracts

- **Actor / need:** A reviewer, workflow-step agent, or non-coding operator needs gates to prevent false success while advisory checks remain non-blocking.
- **Trigger:** A prompt/script/gate/step-review node runs; a workflow step emits `APPROVE`, `APPROVE_WITH_NOTES`, `REVISE`, malformed output, or a readonly tool attempt; terminal success is evaluated against declared artifacts.
- **Expected happy path + lifecycle transitions + feedback:** `gateMode: gate` blocks merge/completion on failure; `gateMode: advisory` records `advisory_failure` without blocking. Structured verdicts persist; `REVISE` follows the existing revision-loop behavior by appending in-scope feedback to Workflow Revision Instructions and reopening the appropriate implementation step/session. Required artifact keys must exist before terminal success; otherwise the run is incomplete rather than falsely done.
- **Failure / recovery expectation:** `toolMode: readonly` is enforced as a hard allowlist; denied mutation tools fail closed with `READONLY_VIOLATION` / `[readonly-violation]`. Out-of-scope revision feedback becomes a dependent follow-up task rather than mutating unrelated files. Malformed verdict output is recorded as `malformed` with no inferable verdict. Bounded rework edges prevent infinite loops and route `outcome:rework-exhausted`.
- **Measurable success signal:** `WorkflowStepResult` stores verdict/notes/output; task logs or prompt revisions show retained in-scope feedback; created follow-up task IDs capture out-of-scope feedback; required task-document keys exist at terminal success; missing artifacts leave an incomplete/failure state visible in workflow results.
- **Priority:** MVP/blocking.

### 6. Recover failed, blocked, or parked workflow runs without silent backward moves

- **Actor / need:** The scheduler/self-healing system needs to recover eligible workflow work without erasing operator intent or hiding unrecovered failures.
- **Trigger:** A task is failed/blocked/parked after a workflow node failure, retry exhaustion, stale worktree metadata, dependency-blocking lease, failed pre-merge workflow result, or manual `moveTask(in-progress → todo)` cancel.
- **Expected happy path + lifecycle transitions + feedback:** Eligible recoveries are bounded and explicit: failed pre-merge workflow results can auto-revive only within configured budgets, stale metadata is reconciled with audit evidence, dependency/lease circular waits are unwound only when proof gates pass, and terminal/actionable `in-review` failures remain visible. Human-paused or `autoMerge:false` in-review work stays terminal-until-human merge unless a documented scoped exception applies.
- **Failure / recovery expectation:** Self-healing must publish typed recovery facts and reconcile metadata; it must not silently requeue, pause, fail, unpause, or move merge/retry tasks outside guarded workflow primitives. When proof is insufficient, it emits annotation-only `task:*-no-action` run-audit events rather than mutating lifecycle state.
- **Measurable success signal:** Run-audit includes recovery mutation events such as `task:reconcile-dependency-blocking-lease`, no-action events from the backward-move family, or workflow recovery events; task logs explain auto-recovery; task state remains stable when recovery is not proven.
- **Priority:** MVP/blocking.

### 7. Preserve workflow run state across scheduler/engine restarts

- **Actor / need:** Operators need in-flight custom workflow runs to survive process restarts without duplicating work, losing progress, or running the wrong workflow.
- **Trigger:** The engine or scheduler restarts while a task is planning, executing graph nodes, waiting in review/hold, blocked, or recovering.
- **Expected happy path + lifecycle transitions + feedback:** Persisted task state, workflow selection, workflow setting values, task steps, documents, workflow results, custom fields, and run-audit history are enough for startup recovery to reattach or resume forward when safe. Orphaned assigned executions can re-dispatch in place after grace windows; stranded `in-progress` rows without runnable context can move back to `todo` only through audited recovery paths.
- **Failure / recovery expectation:** Restart recovery must not reset selected workflows to `builtin:coding` when an explicit custom workflow was chosen, must not duplicate terminal actions, and must preserve `autoMerge:false` in-review terminal semantics. Missing/corrupt explicit workflow definitions continue to fail closed after restart.
- **Measurable success signal:** After restart, task detail/tool state still shows the workflow ID and node/step progress; run-audit has startup/self-healing records for any repair; no duplicate workflow results or duplicated task documents are produced; failed explicit workflow resolution remains visible as an error.
- **Priority:** MVP/blocking.

## MVP gap → follow-up ledger

This task is a documentation-only map and did not perform a source-code audit. The ledger therefore records only gaps confirmed by the source documents, not speculative product defects.

| Gap / criterion | Status | Follow-up task |
|---|---|---|
| Dedicated workflow run telemetry for `workflow_definition_registered`, `workflow_run_started`, run-level status keyed by workflow definition ID, and definition-ID adoption metrics | Nice-to-have/enhancement per MVP spec instrumentation notes; not blocking this acceptance map because existing success signals can be task state, workflow results, task documents, and run-audit | Not filed here as an MVP/blocking gap |
| Cross-node workflow setting value sync | Nice-to-have/enhancement; Settings Reference explicitly says workflow settings are not synced across nodes yet | Not filed here as an MVP/blocking gap |
| First-class mission-feature workflow defaults at triage time | Deferred/conditional; MVP spec lists this as an open decision, while current supported surfaces include task creation/selection and feature-to-task linkage | Not filed here without a confirmed current-behavior defect |
| Confirmed unmet MVP/blocking implementation criterion | None confirmed during this docs-only analysis | None |

## Non-goals / deferred journeys

The following journeys are intentionally out of scope for the MVP reliability bar and should not block the first reliable custom workflow launch:

- Drag-and-drop marketplace-grade workflow builder beyond the shipped visual editor mechanics.
- Cross-workflow triggers, event buses, or orchestration/dependencies between separate workflows.
- Arbitrary external write connectors such as Slack/Jira/Zendesk/CRM actions beyond existing Fusion tools.
- Custom per-step RBAC or secret-scope models beyond existing `toolMode`, sandbox, and action-gate controls.
- Template marketplace, workflow version marketplace, and runtime migration/versioning of workflow definitions.
- Organization-level approval policy engines beyond existing review/approval settings and workflow gates.

## Release-check checklist

<!--
FNXC:CustomWorkflowReliability 2026-06-19-00:00:
FN-6694 made this release checklist executable. QA/release signoff should now cite the harness output and manifest-backed seam mapping rather than relying on prose-only spot checks.
-->

Before claiming the custom workflow system is reliable for goal **G-MPW67VQR-0001-97S3**, QA or engineering should run the executable release-check harness:

```bash
pnpm test:workflow-release-check          # run the targeted manifest-listed seams and emit text PASS/FAIL evidence
pnpm test:workflow-release-check --json   # emit the same item/seam evidence as machine-readable JSON
pnpm test:workflow-release-check --dry-run # validate the manifest and print planned commands without running Vitest
```

The source of truth for the checklist-to-seam mapping is [`scripts/lib/workflow-reliability-release-check.json`](../scripts/lib/workflow-reliability-release-check.json). The runner validates that every referenced file exists, groups the seams into targeted package-scoped Vitest commands, and exits non-zero if the manifest is invalid or any required item fails. It is intentionally an on-demand QA/release lane, not a merge-gate expansion.

| Release-check item | Manifest ID | Automated evidence seams |
|---|---|---|
| A custom workflow can be authored/imported, rejected on invalid IR, saved, discovered, selected, and reloaded. | `author-import-save-discover-reload` | `packages/core/src/__tests__/workflow-definition-store.test.ts`; `packages/dashboard/src/routes/__tests__/workflow-import-export.test.ts`; `packages/dashboard/src/routes/__tests__/workflow-design-route.test.ts`; `packages/core/src/__tests__/workflow-selection-store.test.ts` |
| A task can execute the selected workflow through runtime primitives, and explicit missing custom workflow IDs fail closed. | `selected-workflow-execution-fail-closed` | `packages/core/src/__tests__/workflow-selection-store.test.ts`; `packages/engine/src/__tests__/workflow-task-runtime.test.ts` |
| Gate/advisory/readonly/`REVISE`/required-artifact behavior is observable in task state, workflow results, task documents, and logs. | `gate-advisory-readonly-revise-required-artifact` | `packages/engine/src/__tests__/workflow-malformed-verdict-gate.test.ts`; `packages/engine/src/__tests__/workflow-required-artifact-gate.test.ts`; `packages/engine/src/__tests__/workflow-step-readonly-allowlist.test.ts`; `packages/engine/src/__tests__/executor-workflow-revision-scope.test.ts` |
| `autoMerge:false`, hard-cancel, file-scope, and recovery invariants are preserved under custom workflow execution. | `automerge-hard-cancel-file-scope-recovery` | `packages/engine/src/__tests__/reliability-interactions/workflow-and-file-scope.test.ts`; `packages/engine/src/__tests__/reliability-interactions/workflow-interpreter-cutover.test.ts`; `packages/engine/src/__tests__/self-healing-custom-workflow-recovery.test.ts` |
| Engine/scheduler restart preserves workflow selection and progress, and any recovery emits typed run-audit evidence instead of silent lifecycle mutation. | `restart-selection-progress-run-audit` | `packages/core/src/__tests__/workflow-restart-durability.test.ts`; `packages/engine/src/__tests__/self-healing-custom-workflow-recovery.test.ts` |

Manual-only checks: **none currently deferred**. If a future release-check item cannot be automated, add it to the manifest's `manual` array with a non-empty `automationDeferredReason`, label it here, and file/link a focused follow-up after confirming there is no duplicate task.
