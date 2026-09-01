# Workflow Steps

[← Docs index](./README.md)

Workflow steps are reusable quality gates that run around task completion.

## Workflow overview

<!--
FNXC:Docs 2026-06-16-23:25:
Public docs need one concise workflow overview that names the shipped built-ins, explains per-task selection, and points authors to the visual editor while leaving low-level runtime details in this canonical workflow document.

FNXC:Docs 2026-06-20-08:47:
The built-in catalog now includes a business lead-generation workflow with custom columns, custom lead fields, and inline per-stage prompts, so the public inventory must show it beside coding workflows instead of implying all selectable built-ins are engineering-only.

FNXC:WorkflowRouting 2026-06-21-04:25:
Triage and planning agents must preserve the project default workflow unless the user explicitly requests a different workflow. No-commit markers describe expected artifact behavior only; they no longer imply automatic Quick fix workflow selection.

FNXC:WorkflowRouting 2026-06-22-12:00:
Agents may select or change a workflow only when the user explicitly requested that workflow or the agent created that specific task. Executor agents must not reroute the task they are executing unless the user asked, but they may set workflows on follow-up tasks they create.

FNXC:Docs 2026-06-21-12:00:
FN-6906 makes non-coding built-in prompts artifact-oriented: marketing drafts, lead enrichment/outreach, and design previews are persisted with fn_task_document_write, while fn_artifact_register remains conditional until the artifact tool is available.

FNXC:WorkflowRuntime 2026-06-28-08:10:
Selectable built-in workflows must share the canonical dispatch traits: their held work enters through a capacity-released `todo`/backlog column and moves to the first WIP execution column via the hold/release sweep, so non-default built-ins do not need a separate dispatcher.
-->

Fusion workflows define the task lifecycle policy that moves work from an idea to delivery. The default coding path is **Plan/Triage → Execute → graph-native optional gates → Review → Merge**, but that path is now represented as a workflow selection rather than only as fixed engine behavior. `builtin:coding` remains the catalog default; when project enablement excludes it, unselected/new work and dashboard defaults use the first enabled normal built-in in catalog order. An explicitly selected existing built-in remains resolvable even when it is disabled for new selection, while an explicit missing/corrupt custom workflow fails closed instead of silently falling back.

### Selecting workflows

<!--
FNXC:DisabledBuiltinWorkflows 2026-08-19-00:18:
Project Settings treats an unset `enabledBuiltinWorkflowIds` as all normal built-ins enabled and requires every explicit list to retain at least one valid, available built-in. Disabled built-ins stay in management/direct-resolution paths only; they are omitted from new-task and board/header/list/Planning/Missions/Graph pickers.
-->
Operators can select workflows in the dashboard wherever the task or board workflow selector is shown. Agents and automation can discover, author, tune, and assign them with the workflow tools:

- `fn_workflow_list` / `fn_workflow_get` — list built-in and custom workflow definitions and inspect a definition's IR before editing.
- `fn_workflow_validate` — dry-run validate a workflow IR by existing workflow id or inline graph object without creating, updating, deleting, emitting workflow events, or mutating any workflow. It runs the same `parseWorkflowIr`, column trait, code-node compile, and column-agent binding checks used by create/update and returns typed validation errors for malformed graphs.
- `fn_trait_list` — list the column trait vocabulary needed when authoring workflow IR columns.
- `fn_workflow_create` / `fn_workflow_update` / `fn_workflow_delete` — create, edit, or delete custom workflow definitions. Built-in workflow definitions are protected, malformed IRs are rejected by the central validator, and prompt-injectable lanes strip approval-bypass flags before saving.
- `fn_workflow_settings` — read or write typed per-project values for a workflow's declared settings; invalid values reject atomically without partial persistence.
- `fn_workflow_select` — assign a workflow to the current or named task.
- `workflow_id` on `fn_task_create` / delegation tools — create a task with a workflow already selected.

Agent-initiated workflow assignment is intentionally narrow: an agent may select or change a task's workflow only when the user explicitly requested that workflow, or when the agent created that task itself (for example by passing `workflow_id` to `fn_task_create` / delegation tools). Executors should not call `fn_workflow_select` to reroute the task they are currently executing unless that task's instructions or a user steering comment explicitly asks for the workflow change. Lanes without an ambient task, such as dashboard chat, planning, and published/pi extension calls made outside a task, must pass an explicit `task_id` to `fn_workflow_select`; task-bound executor lanes may default to the current task.

Decision-only or investigation tasks can also declare `noCommitsExpected` / `**No commits expected:** true`; that marker does not change workflow selection by itself. Tasks without an explicit workflow request or creator-owned workflow selection stay on the project default (`builtin:coding`).

### Built-in workflow catalog

| Workflow | ID | Notes |
|---|---|---|
| Coding | `builtin:coding` | Default Stepwise-based coding lifecycle: plan steps, execute them one at a time, then run the optional final Code Review gate and merge. |
| Legacy coding | `builtin:legacy-coding` | Original monolithic coding lifecycle for tasks that should not use graph-owned step execution. |
| Quick fix | `builtin:quick-fix` | Short explicitly selected path for trivial or decision work; omits the standard review stage. No-commit markers do not route tasks here automatically. |
| Review-heavy | `builtin:review-heavy` | Standard execute/review/merge path with an additional gated security review. |
| Marketing | `builtin:marketing` | Content pipeline with custom Ideation, Backlog, Drafting, Editorial review, Published, and Archived columns plus structured marketing brief/draft/editorial prompts; drafts are persisted as task documents for review while the workflow reuses standard lifecycle traits and merge primitives. |
| Compound engineering | `builtin:compound-engineering` | Plugin-gated CE workflow that invokes `/ce-plan`, optional advisory `ce-doc-review` (markdown autofix; HTML DOM-safe mutation with report-only fallback), `/ce-work`, merge-blocking `/ce-code-review`, CE PR/feedback skills, Fusion merge, and learnings capture. |
| Coding (per-step review) | `builtin:stepwise-coding` | Graph-executor workflow with default-on Plan Review before execution, per-step parse/execute/review/rework, and an optional final Code Review gate. |
| Design | `builtin:design` | UI-heavy work path that implements, persists a user-facing design preview task document, runs a gated design/UX review, then performs the standard review and merge. |
| PR lifecycle | `builtin:pr-workflow` | Reusable PR lifecycle graph fragment (create PR → await review → respond → gate → merge); it is a fragment, not directly selectable as a task workflow. |
| Lead generation | `builtin:lead-generation` | Selectable business workflow for sourcing, qualifying, enriching, and contacting leads with custom lead fields, stage columns, and reviewable enrichment/outreach task documents; requires the workflow graph executor for custom board columns. |

Every selectable built-in workflow uses a capacity-released hold column (`todo` or a workflow-specific backlog) for queued work and a WIP execution column for active work, so the hold/release sweep performs the normal `todo`/backlog → in-progress dispatch across the catalog.

### Current workflow behavior inventory

<!--
FNXC:WorkflowDocs 2026-06-30-09:00:
Workflow documentation needs a compact current-behavior inventory so future edits keep the canonical homes aligned instead of duplicating or reviving deleted workflow-step CRUD concepts.
-->

Use this inventory as the documentation map for current workflow behavior:

| Topic | Current behavior | Canonical home |
|---|---|---|
| Built-in catalog and ids | The selectable built-ins are `builtin:coding`, `builtin:legacy-coding`, `builtin:quick-fix`, `builtin:review-heavy`, `builtin:marketing`, `builtin:compound-engineering`, `builtin:stepwise-coding`, `builtin:design`, and `builtin:lead-generation`; `builtin:pr-workflow` is a reusable fragment, not a task-selectable workflow. | This page, [Built-in workflow catalog](#built-in-workflow-catalog); authoring summary in [Workflow Editor](./workflow-editor.md#built-in-vs-custom-workflows). |
| Runtime and fail-closed behavior | The graph runtime owns lifecycle routing. Unselected/default tasks resolve to `builtin:coding`; missing explicit custom selections fail closed as workflow-resolution failures, and corrupt or invalid resolved IR fails closed as `invalid-ir` instead of returning a legacy fallback. | This page, [Workflow graph integrity validation](#workflow-graph-integrity-validation) and [Workflow Graph Executor](#workflow-graph-executor). |
| Workflow IR validation | Save/import/AI design/tool writes and runtime materialization all use the central IR validator for node/edge integrity, column/field/setting uniqueness, optional-group references, and plugin extension keys. | This page, [Workflow graph integrity validation](#workflow-graph-integrity-validation); visual authoring in [Workflow Editor](./workflow-editor.md). |
| Optional groups and default-on gates | Quality gates are graph `optional-group` nodes keyed by node id in `enabledWorkflowSteps`; the runtime/display effective set is persisted ids plus `defaultOn` groups, so default-on gates still run and appear for in-progress tasks when a persisted selection array is empty. Edit-mode controls continue to show the persisted selection so operators can see exactly what the task stored. There is no workflow-step table, Settings manager, or CRUD form. | This page, [Workflow-declared optional steps](#workflow-declared-optional-steps-optional-group-nodes), [Default-On Behavior for New Tasks](#default-on-behavior-for-new-tasks), and [Authoring a Custom Quality Gate](#authoring-a-custom-quality-gate). |
| Explicit empty step dependencies | A heading annotation `(depends:)` or JSON step `"depends": []` means the step has no prerequisites; an absent dependency annotation/key still inherits the legacy previous-step dependency. | This page, [Parallel mode & the `(depends:)` annotation](#parallel-mode--the-depends-annotation). |
| Workflow settings values | Setting declarations live in workflow IR; values persist per `(workflowId, projectId)` and resolve as `stored value ?? declaration default`, with invalid/orphaned values dropped from effective settings. | [Settings Reference → Workflow Settings](./settings-reference.md#workflow-settings); editor UX in [Workflow Editor](./workflow-editor.md#settings-panel-definitions-and-values). |
| Built-in prompt overrides | Built-in topology stays read-only, but prompt/gate node text can be overridden per `(workflowId, nodeId, projectId)` and reset to shipped defaults. | This page, [Overriding built-in workflow prompts](#overriding-built-in-workflow-prompts); dashboard UX in [Dashboard Guide](./dashboard-guide.md#workflow-selection-and-editor). |
| Agent workflow tools | Agents can list/get/validate/create/update/delete workflows, inspect traits, read/write workflow settings, select workflows for explicit task contexts, and pass `workflow_id` when creating/delegating tasks. `fn_workflow_validate` is read-only and uses the same validator as create/update without persistence. Prompt-injectable lanes strip approval-bypass flags on workflow writes. | [Agents](./agents.md#interactive-cli-chat) and [CLI Reference](./cli-reference.md#published-agent-extension-workflow-tools). |
| Routing boundary | Agents may select/change a workflow only for explicit user requests or tasks they created; no-commit markers do not imply Quick fix or any other workflow. | This page, [Selecting workflows](#selecting-workflows); [Agents](./agents.md#interactive-cli-chat). |
| Dashboard board/list/graph selection | Board/List/Header/Graph share durable per-project workflow selection; stale saved ids fall back to a valid workflow. Board adds a dashboard-only **All workflows** aggregate and task workflow-name badges; Graph uses **All workflows** for the full active graph. | [Dashboard Guide → Board View](./dashboard-guide.md#board-view), [Graph View](./dashboard-guide.md#graph-view), and [Workflow Selection and Editor](./dashboard-guide.md#workflow-selection-and-editor). |
| Create/planning forwarding | Quick-create task creation, Planning Mode, and the New Task dialog forward the active real workflow id when creating tasks; **All workflows** quick-create chooses a real workflow intake/default column instead of saving a synthetic aggregate id. | [Dashboard Guide → Planning Mode](./dashboard-guide.md#planning-mode). |
| Manual-intake column parking | Dashboard create surfaces never send an explicit `column`; the store resolves the landing column from the (selected or project-default) workflow's intake column. A workflow whose intake column sets `autoTriage: false` parks new cards there instead of auto-planning them, until an operator promotes the card. Built-in Coding (Ideas)'s `ideas` composition is deprecated and hidden from new selection; copy that composition into a custom workflow when needed. Existing Coding (Ideas) selections remain resolvable. The full lifecycle — create → parked → operator "Start" promotion → poll-time todo-discovery of the still-unplanned (bootstrap-stub) card — is regression-tested at the engine (triage poll ordering/discovery), UI (`TaskCard` Start affordance), and store (create → `moveTask` promotion) layers (FN-7596). | [Dashboard Guide → Create/Planning Forwarding](./dashboard-guide.md#planning-mode). |

### Skill-backed workflow steps

<!--
FNXC:WorkflowSteps 2026-08-08-00:00:
FN-7145 locks the execution invariant for skill-backed workflow nodes: naming a skill must load the skill into the step session, not only mention it in prompt text. FN-8461 / GitHub #2388 makes discovery multi-source: enabled-plugin body directories and the optional Compound Engineering root both participate. The executor warns only when the named skill has no viable source after that merge; missing CE configuration alone must not mislead operators when a plugin body resolves the named skill.
-->

Skill-backed prompt/gate nodes run through the same workflow-step session builder as other prompt nodes, but their `config.skillName` is also treated as a resource-loading request when `config.executor` is `"skill"`. These are fields on the node's `config` bag; author-facing shorthand such as `executor: "skill"` refers to `config.executor`, not a root node property. At execution time Fusion merges both the namespaced form (for example `compound-engineering:ce-work`) and the bare form (`ce-work`) into `requestedSkillNames`. Discovery paths are merged from enabled-plugin skill body directories and, when configured, the injected `FUSION_CE_SKILLS_DIR` Compound Engineering install root.

The same contract applies to a `config.seam: "step-execute"` node inside a `foreach` template. Its per-instance implementation session receives the named skill request, while the shared implementation pass keeps the template's skill pin for its lifetime. Missing skills degrade exactly like top-level skill nodes: Fusion logs `[skill-load]` after multi-source discovery and continues with role-fallback skills rather than failing solely because a body is unavailable.

The executor logs `[skill-load]` only when the **named** skill has no viable discovery source after that multi-source merge. Therefore an unset optional CE directory does not warn when the requested plugin skill body is discoverable, and paths for an unrelated skill do not suppress a missing-name warning. CE-root-dependent skills still require `FUSION_CE_SKILLS_DIR` when no plugin or other source delivers their body; absence of every viable source remains a loud warning rather than a silent role-skill fallback.

### Custom workflow authoring

Use the dashboard [Workflow Editor](./workflow-editor.md) to inspect built-ins, tune built-in prompts, duplicate workflows, or author custom workflows. Custom workflows can declare graph nodes and edges, columns/traits, task fields, typed workflow settings, model lanes, optional workflow-step templates, and author-time validation. Use this page for runtime semantics; use the editor guide for the visual authoring surface.

Customized planning prompts may add their own `##` sections to generated task specifications. Fusion preserves those sections when it refreshes the verbatim **Original Description** block after planning, so custom prompt structure can appear alongside the built-in specification sections.

<!--
FNXC:Workflows 2026-06-28-09:50:
Pure-v1 custom graphs remain rollback-compatible by upgrading to trait-less default columns. Capacity dispatch after the workflow-columns cutover is therefore an explicit v2 authoring requirement, not an implicit v1 upgrade side effect.
-->

#### Capacity dispatch for custom workflows

After the workflow-columns cutover, the only automatic queued-work dispatcher is the engine's hold/release sweep. It releases a task from `todo` only when that column resolves as a `hold` column and its hold config uses `release: "capacity"`; it then moves the card to the nearest downstream `wip` column with available capacity.

**Unplanned/intake cards never release into a processing column (FN-7648).** The sweep and both explicit release surfaces (`promoteHeldTask` and `releaseHeldTaskByEvent`) refuse to move a card into a `countsTowardWip` column while it is still unplanned: `status === "planning"`, a pending pre-release Plan Review, a durable replan signal, its PROMPT.md is still the bootstrap stub, or it currently rests in a column carrying the `intake` trait. An approval-held card is refused as well. FN-245 removes any operator override from `promoteHeldTask`, so an explicit promote refusal is terminal until planning or plan review genuinely completes. This is trait-based, not keyed on the literal `"todo"` id, so a custom workflow whose intake column is renamed (`ideas`, `Inbox`, ...) is covered the same way as the default workflow's `triage`/"Planning" column. See `docs/architecture.md` § "Workflow-defined columns & traits" → "Execution-entry invariant" for the implementation detail.

Pure-v1 custom workflow definitions (`start` / `prompt` / `script` / `gate` / `end` nodes with default columns) still parse and upgrade by synthesizing the legacy column ids with empty trait sets. That shape is intentional for FN-5769 / issue #1405 rollback compatibility: it can be downgraded back to v1 for older binaries. The tradeoff is that a pure-v1 custom workflow's `todo` column is not a hold column, so tasks can sit in `todo` instead of dispatching to `in-progress`.

For capacity-dispatched custom workflows, author or migrate the workflow as IR v2 and give `todo` and `in-progress` the canonical dispatch traits (the same minimum used by the built-in coding workflow):

```json
{
  "version": "v2",
  "columns": [
    {
      "id": "todo",
      "name": "todo",
      "traits": [
        { "trait": "hold", "config": { "release": "capacity" } },
        { "trait": "reset-on-entry" }
      ]
    },
    {
      "id": "in-progress",
      "name": "in-progress",
      "traits": [
        { "trait": "wip", "config": { "limit": "settings.maxConcurrent" } },
        { "trait": "abort-on-exit" },
        { "trait": "timing" }
      ]
    }
  ]
}
```

If you need the full lifecycle behavior, duplicate `builtin:coding` (or another selectable built-in) and edit the copy so `in-review`, `done`, and `archived` keep their merge/review/completion traits. FN-7190 keeps selectable built-ins on canonical traits; FN-7192 documents and tests the custom-v1 migration boundary.

### Workflow graph integrity validation

<!--
FNXC:WorkflowValidation 2026-06-27-00:00:
FN-7113 makes graph integrity a save-and-run invariant. The central `parseWorkflowIr`/`validateV2` gate rejects malformed author/plugin graphs before persistence, and `WorkflowGraphTaskRunner` re-validates the resolved IR before side-effecting seams so stale or plugin-supplied invalid graphs fail closed instead of partially running or falling back into the wrong legacy workflow.
-->

Workflow definitions are validated through the same central IR gate before they can be saved, imported, AI-designed, selected/materialized for a task, or launched by the graph interpreter. Dashboard routes and workflow tools surface `WorkflowIrError` / `WorkflowCompileError` messages as author-facing validation failures instead of persisting partial definitions.

The enforced integrity classes include:

- exactly one `start` node and exactly one `end` node;
- unique top-level node ids and unique column/field/setting ids;
- every top-level edge endpoint references a declared top-level node;
- no illegal non-rework cycles in DAG-required regions;
- required reachability/dominance rules: every required top-level node must be reachable from `start`, and `parse-steps` must dominate `foreach(source:"task-steps")`; interpreter-owned recovery entry primitives remain valid even when they are re-entered from persisted runtime state instead of the author-facing start path;
- valid node-specific references, including `parse-steps` artifacts, `loop.exitWhen.nodeId`, foreach/loop/optional-group template entry/exit references, and registered plugin workflow-extension keys.

At run time, `WorkflowGraphTaskRunner` resolves the selected built-in or custom workflow, re-runs this integrity validation before any seam, primitive, or custom-node side effect, and fails closed with an `invalid-ir: <message>` reason when the resolved IR is malformed. Once a node side effect has run, runtime failures keep the existing failed-run behavior rather than re-running the legacy pipeline.

### Overriding built-in workflow prompts

<!--
FNXC:Docs 2026-06-21-21:22:
Built-in workflows stay structurally read-only while prompt/gate node text is project-tunable, so operators need a resettable prompt-override model without implying graph topology edits are allowed.
-->

Built-in workflow graph structure is still shipped and read-only: nodes, edges, columns, traits, executor configuration, and workflow setting declarations cannot be edited in place. Prompt-bearing nodes are the exception. In the workflow editor, select any `prompt` or `gate` node in a built-in workflow and edit its **Prompt** field to create a project-scoped override.

Prompt overrides are stored per `(workflowId, nodeId, projectId)`. At runtime Fusion resolves the effective prompt as:

1. the stored override for that workflow/node/project, when present and non-empty; otherwise
2. the shipped prompt text from the built-in workflow IR.

This same overlay is used by the dashboard preview, seam prompt resolution during live task runs, synchronous workflow IR resolution used by lifecycle movement, and optional-group gate materialization for non-seam prompt/gate nodes. Empty or whitespace-only prompt edits are treated as reset/delete operations, never as blank prompts.

Use **Reset to default** on an overridden prompt to delete the stored override and return to the shipped built-in prompt. Duplicating a built-in remains the path when you need to change topology, columns, traits, settings declarations, or non-prompt configuration.

## Workflow IR (v1)

Fusion also defines a separate **Workflow Intermediate Representation (IR)** contract in `@fusion/core` for editor↔interpreter graph exchange. The post-implementation quality gates documented on this page are themselves IR constructs now — `optional-group` graph nodes — rather than a separate execution subsystem. For the user-facing visual authoring surface, see the [Workflow Editor guide](./workflow-editor.md).

Workflow IR v1 is a JSON-safe graph document:

- `schemaVersion`: must be exactly `"1.0.0"` for v1 (`WORKFLOW_IR_SCHEMA_VERSION`)
- `metadata`: workflow-level JSON metadata (`name` required)
- `nodes`: node array with built-in kinds (`start`, `prompt`, `script`, `gate`, `end`)
- `edges`: directed links referencing node ids

Contract behavior:

- Parsing is strict: unsupported/missing versions, invalid node kinds, invalid shapes, and dangling edges are rejected at parse time.
- Serialization is stable JSON via `serializeWorkflowIr`; round-tripping `parseWorkflowIr(serializeWorkflowIr(ir))` preserves data.
- `BUILTIN_WORKFLOW_IR_FIXTURE` provides a complete built-in reference flow for parity testing.

Out of scope for v1:

- Plugin-contributed node kinds
- Layout/position metadata for editors
- Execution history/runtime traces
- Migration tooling for future schema versions (future versions should use explicit `schemaVersion` migrations)

### Workflow Runtime

The workflow runtime is the authoritative execution path for task lifecycle work. `WorkflowGraphExecutor` owns graph traversal and routing; workflow node runners own node-kind behavior; runtime primitives and runtime services perform side-effecting operations such as planning, coding sessions, custom-node execution, review, step execution/reset, merge requests, transitions, and audit.

The engine remains the substrate for scheduler dispatch, routing claims, persistence, concurrency limits, process supervision, storage, and audit plumbing. Lifecycle policy belongs in built-in or custom workflows, not in hidden executor/reviewer/triage branches.

The default built-in catalog entry `builtin:coding` is backed by a Stepwise-derived graph with two default-on, toggleable review gates: `plan-review` before execution and `code-review` at the end of implementation. It is the resolver/runtime fallback for tasks with no workflow selection or an explicit default selection. Missing explicit custom selections fail closed as workflow-resolution failures, and corrupt or invalid resolved IR fails with `invalid-ir` instead of silently running the default or a legacy workflow. The built-in IR parses planned steps, executes them sequentially without per-step review, then routes optional quality gates into the merge region:

- `triage` → `plan` → `plan-review` (default-on optional plan review) → `parse-steps` → `foreach(step-execute)` → `browser-verification` (optional) → `code-review` (default-on optional final review) → `merge-gate` / branch-group integration / `merge-attempt` / retry or manual hold → `end`

If the Plan Review reviewer is unavailable before producing a verdict, the task stays in triage as `status: "plan-review-unavailable"` with a short backoff. That retry state is not a replan: Fusion rereads the existing non-empty `PROMPT.md`, preserves it unchanged, and reruns only Plan Review/finalization while holding a global agent concurrency slot for the reviewer lane. The graph applies the same invariant after execution has started: a transient/provider/model/abort Plan Review failure without a `REVISE` verdict remains visible in its current task state and never moves the task backward to `needs-replan`. A reviewer revision verdict moves the task to `needs-replan`; missing/empty/invalid prompt content fails clearly instead of restarting the planner.

Workflow Plan Review is separate from manual plan approval. Project `planApprovalMode: "auto-approve-all"` bypasses only the final manual `awaiting-approval` plan gate after the plan is specified and any enabled Plan Review passes. Workflow mode follows the workflow `requirePlanApproval` setting, while project `require-all` requires manual approval for every plan. None of these choices disables Plan Review or other explicit safety gates.

### Closing stale or duplicate work from Plan Review

The built-in **Plan Review** optional group alone accepts a fourth structured verdict:

```json
{"verdict":"CLOSE_NO_OP","notes":"DUPLICATE: FN-1234 already covered"}
```

Use it only when implementation should not begin because the premise is stale, the work is already satisfied or redundant, or another task already covers it. `notes` must begin with one of the existing no-op sentinels: `PREMISE STALE:`, `NO-OP:`, `NOOP:`, `REDUNDANT:`, or `DUPLICATE:`. For known duplicates, write `DUPLICATE: FN-NNNN ...`; Fusion preserves that canonical task ID in the Plan Review result.

A valid close follows the graph's explicit terminal no-op route before parsing or implementation: it records a passed `CLOSE_NO_OP` Plan Review result, marks the task as no-commits-expected, records the reason, and completes it without replan or an implementation agent session. This is distinct from `REVISE`, which requests a corrected plan and follows the bounded replan route.

`CLOSE_NO_OP` is not a generic review verdict. Code Review, Browser Verification, post-merge review, and custom non-Plan groups treat it as malformed/unknown output under their existing gate or advisory policy. A Plan Review close with empty/non-sentinel notes, or a custom workflow that has no explicit `outcome:close-no-op` terminal route, stays held at Plan Review with failed close evidence; it does not execute, replan, or fabricate a task error.

**FN-7559 (superseded by FN-7732) — telling the holds apart:** Plan Review parks a task with its own distinct statuses (`needs-replan` for a revision verdict, `plan-review-unavailable` for a reviewer-outage retry), so it never renders identically to a plan-approval hold. A separate triage release-authorization gate used to also use `status: "awaiting-approval"` with a distinct `awaitingApprovalReason: "release-authorization"` discriminator and its own dashboard label; that gate was removed (it over-fired on AI-authored specs that merely mentioned release tooling — see `b5b0458`, FN-7732). Releases are kept out of Fusion by agent instruction instead (AGENTS.md → "Releasing"), not by an engine/UI gate. The `Task.awaitingApprovalReason` field and its `"release-authorization"` value are kept only so legacy rows deserialize; any task that still carries the legacy value now renders as an ordinary manual plan-approval hold.

**FN-7569 / FN-8008 — manual plan approval is idempotent against unchanged plans:** approving a plan under the manual gate records a fingerprint of the approved `PROMPT.md`, normalized to ignore deterministic `## Original Description` and Frontend UX hygiene sections. If the same task is later re-specified — a `needs-replan` replan, a Plan Review reviewer-outage retry, or a self-healing rebound back to `triage` — the manual gate detects the unchanged operator-authored plan and proceeds straight to `todo` instead of re-parking at `status: "awaiting-approval"`, regardless of whether those generated sections were injected before either fingerprint was calculated. A genuinely revised Mission, Steps, or File Scope still produces a different fingerprint and re-asks as before. Reject Plan clears the fingerprint and deletes the plan for regeneration. The retained spec-revision API instead clears the fingerprint and supersedes current Plan Review evidence while retaining the old plan strictly as revision source, so unchanged text cannot skip the required replan and re-approval episode; this capability is no longer exposed as a task-menu button. The idempotency check runs only inside the manual gate, strictly after Plan Review has made its independent decision; project `auto-approve-all` bypasses that gate.

`builtin:legacy-coding` is backed by the original monolithic `BUILTIN_CODING_WORKFLOW_IR`: `planning` → `execute` → optional quality gates → `review` → merge region.

`builtin:stepwise-coding` displays as Coding (per-step review). It is backed by `BUILTIN_STEPWISE_CODING_WORKFLOW_IR`; it keeps the same lifecycle columns/traits while adding the default-on optional Plan Review before `parse-steps`, modeling per-step parse/execute/review/rework as authored graph structure, and retaining the post-foreach optional Code Review gate before its final review/merge region.

`builtin:marketing` is a non-coding content workflow with marketing-specific columns (`ideation`, `backlog`, `drafting`, `editorial-review`, `published`, `archived`) and prompt seams for content brief, draft, and editorial review. Its draft stage saves the primary content deliverable as a task document for human review, while the workflow uses the same lifecycle traits (`intake`, `hold`, `wip`, `merge-blocker`, `human-review`, `complete`, `archived`) and the same merge-gate/branch-group/merge-attempt primitive region as coding workflows, so scheduler, capacity, review blocking, and merge orchestration behavior remain standard.


<!--
FNXC:CompoundEngineering 2026-06-27-23:05:
FN-7149 changes the CE workflow note from HTML report-only-only to DOM-safe-or-report-only. Operators need to know markdown behavior is unchanged, while HTML writes are atomic, idempotent, DOM-validated, and refused back to report-only on any safety failure.

FNXC:CompoundEngineering 2026-06-28-09:03:
FN-7159 adds a canonical HTML checklist representation, allowing ce-doc-review to repair malformed HTML checklists through the same DOM-safe helper. Keep the operator-facing note explicit that checklist repair is canonical-shape-only and still refuses to report-only on any safety failure.
-->

`builtin:compound-engineering` is plugin-gated by `fusion-plugin-compound-engineering`. Its graph runs `/ce-plan` first and expects the CE plan document artifact under `docs/plans/`; an optional default-off `ce-doc-review` advisory step can then review plans without blocking merge. Markdown plans retain safe autofix and Append-to-Open-Questions behavior, while HTML plans support DOM-safe in-place mutation only after parse/anchor/visible-text/protected-region validation with atomic, idempotent writes. HTML checklist hygiene additionally supports canonical checklist repair when the helper proves the stable CE HTML checklist representation deterministically; any safety failure falls back to report-only with no write. Implementation runs `/ce-work`, merge-blocking code review runs `/ce-code-review`, and the PR lane runs `/ce-commit-push-pr` then `/ce-resolve-pr-feedback` before Fusion's native merge seam. When project `autoMerge` is off, that merge seam no-ops into manual review instead of forcing an unattended board merge, so the CE-created pull request remains the human merge path.

During triage/planning sessions, agents can call `fn_workflow_list` to discover available built-in and custom workflows and read their descriptions before routing work. They can call `fn_workflow_select` only when the user explicitly requested a workflow or when selecting a workflow for a task they created, and they can pass `workflow_id` when creating child tasks with `fn_task_create`; decision-only or investigation tasks can also set `noCommitsExpected` / `**No commits expected:** true` when no code changes are expected. The built-in triage thresholds, decision-only verb list, and default routing IDs are workflow-native typed settings resolved from the selected workflow.

#### Runtime invariant criterion

Workflow-driven coding runs must preserve observable task transitions and reliability invariants: file-scope guards including `FileScopeViolationError`, squash/merge contract, recovery expectations, `autoMerge:false` terminal-until-merged, and `moveTask(in-progress→todo)` hard-cancel semantics.

For grouped branch flows (`branch_groups`), auto-merge precedence is split: per-task `autoMerge` controls member→group-integration landing, while group `autoMerge` controls group→default-branch promotion eligibility.

#### IR-gap reconciliation (v1)

The workflow redesign brief references `agent-call` nodes and typed edges (`success|failure|conditional|fan-out-join`), but shipped v1 IR only supports node kinds `start|prompt|script|gate|end` plus optional string edge `condition`.

Current reconciliation in v1:

- `agent-call` semantics are represented using existing `prompt` nodes with `config` fields (for example stage/role metadata).
- Typed-edge semantics are represented using `condition` token conventions.

FN-5769 evaluated whether those conventions required a `1.1.0` schema bump and recorded the answer as **no**: the current `prompt` + `config` and canonical `edge.condition` token conventions are sufficient for the parity-critical interpreter rollout, so they remain the canonical v1 contract until a future consumer needs stronger schema-level validation or discoverability.

### Workflow IR v2 — columns, traits, hold & split/join nodes

The `workflowColumns` track introduces **IR v2** (`version: "v2"`), where a workflow additionally defines its own **columns** (`{ id, name, traits: [{ trait, config }] }`), places nodes in columns (`node.column`), and gains `hold`, `split`, and `join` node kinds. Columns become first-class, workflow-defined task state carrying composable **traits** (declarative flags + lifecycle hooks); this generalizes the fixed pipeline + the `gateMode` semantics documented below into per-column trait configuration. v1 graphs still parse and upgrade by synthesizing default-workflow columns. The column/trait model — the trait vocabulary, the substrate/policy line, the transition authority, and the graduation gate — is documented in **`docs/architecture.md` § 9 "Workflow-defined columns & traits"** and the **Concepts** glossary (column, trait, lane, hold node, split/join, default workflow, `transitionPending`). The whole v2 model is gated behind `experimentalFeatures.workflowColumns`; with the flag off, the v1 IR and the graph-native quality-gate model below are unchanged.

### Workflow IR v2 — per-column agent assignment

A v2 column can optionally name a **permanent agent** from the agent registry, staffing every card that flows through it once instead of node-by-node or task-by-task. The binding is a first-class optional field on the column (not a trait — traits are board-transition policy; this is execution identity):

```ts
{ id: "review", name: "Review", traits: [],
  agent: { agentId: "agent-001", mode: "defer" | "override" } }
```

**Binding shape.** `agent.agentId` is a non-empty registry agent id; `agent.mode` is `defer` or `override`. The field is omitted entirely when unset — a column with no `agent` key yields no binding, and the built-in default workflow carries none (it stays byte-identical, the parity oracle). Adding a binding forces the workflow to v2.

**Which column governs.** The binding keys off the node's **declared** IR column (`node.column`), never the task's current board lane. A node with no declared column resolves normally (no column agent), even when other columns carry override bindings.

**`defer` vs `override`.**

- **`defer`** — the column agent is the default *only* when the work carries no agent/model settings of its own. "Own settings" is all-or-nothing: an own agent identity **or** a complete `modelProvider`+`modelId` pair suppresses the column agent entirely. An incomplete model pair (provider with no model id) does **not** count as own settings, so the column agent still wins (matching the executor's both-present model rule). The column agent is never blended with own settings — filling only the missing half would create hybrid identities that are impossible to audit.
- **`override`** — the column agent supersedes node-level and task-level agent/model settings: identity, model, **and** persona.

**Where it applies.** The effective agent governs all session-running work attributable to the column's nodes: custom prompt/gate/script nodes, the execute seam's coding session, and step-execute sessions. Raw CLI script nodes run no session, so the binding is a no-op there (the skip is audited). Every adoption is logged (`running as column agent '<id>' (<mode>)`) so the audit trail explains who ran and why.

**Foreach template inheritance.** A node inside a `foreach` template subgraph inherits the **enclosing foreach node's** column, unless the template node declares its own `column` (which then wins). Each per-step instance session is attributed to the resolved column agent.

**Principal semantics.** The effective column agent becomes the **principal**, not merely a model source. Action gating is computed for the agent actually running (a security boundary — never `task.assignedAgentId` when an override governs). Heartbeat serialization follows it in both directions: a column agent with `allowParallelExecution=false` is serialized like an assigned agent, the engine re-dispatches tasks whose *effective* column agent matches (not only `assignedAgentId` matches), and the heartbeat scheduler never lets a column agent heartbeat concurrently with its own override session. A workflow-definition edit or agent `runtimeConfig` change that re-keys the effective agent/model hot-swaps a running session, the same way a `task.modelProvider` change does today.

**Missing-agent fallback.** A missing or deleted agent at resolution time logs and falls back to normal resolution — a live session is never aborted because its column agent was deleted mid-flight.

### Durable intake executor owner

New tasks receive a stable `assignedAgentId` before insertion. Creation resolves an explicit eligible executor first, then the first reachable execute-node column binding, then the eligible durable executor pool ordered by active session, creation time, and ID. Planning and review principals remain separately fenced by workflow work items; a planner or reviewer binding never becomes the durable implementation owner. `workflowId: null` disables graph steps but still resolves an owner from the executor pool. The only successful null-owner case is a project with no eligible durable executor, which emits `task:intake-owner-unresolved`; public request and tool payloads cannot opt out of ownership resolution.

**Flag requirements.** Column agents act only when **both** `experimentalFeatures.workflowColumns` and `experimentalFeatures.workflowGraphExecutor` are on; with either off the binding is inert (config is still stored and round-trips — only execution is gated), and the editor surfaces that the picker is disabled with a tooltip naming both flags.

**Write-time validation.** Saving a workflow validates agent references: an unknown `agentId` is rejected with a typed 4xx naming the column. Binding an agent whose permission policy is broader than the project default requires an explicit policy-escalation confirmation (`confirmPolicyEscalation`) at save time, so override cannot silently re-key action gates to a more-privileged agent.

### Workflow IR v2 — step inversion (foreach, loop, step-review, parse-steps, code, notify)

The **step-inversion** track makes task *steps* themselves workflow-modelable. The default Coding workflow now uses that graph-owned execution model: planning produces `PROMPT.md`, default-on Plan Review can approve the plan before execution, `parse-steps` writes the canonical step list, and `foreach` runs each step sequentially before the optional final Code Review gate. `builtin:legacy-coding` preserves the original monolithic `execute` seam for tasks that should not use graph-owned step execution, while `builtin:stepwise-coding` keeps the heavier per-step review/rework loop for work that needs review after every planned step. Step inversion remains additive to IR v2 for custom workflows that want to model their own step policy.

#### `parse-steps` node — step list as graph structure

`parse-steps` reads a declared **artifact** and runs a named **parser** to write the canonical step list (`Task.steps[]`). Config: `{ artifact: <key>, parser: "step-headings" | "json-steps" | "plugin:<id>:<parser>" }`.

- Built-in parsers: `step-headings` (the `### Step N:` convention, extracted byte-identically from the legacy regex) and `json-steps` (a `[{ name, depends? }]` JSON document). Both preserve the difference between an absent dependency annotation/key and an explicit empty dependency list. Plugins register additional parsers under `plugin:<pluginId>:<parserId>`.
- Outcomes: `success`, `outcome:no-steps` (parsed cleanly, zero steps — routable, defaults to success), `outcome:parse-error` (malformed artifact or a throwing/unavailable plugin parser — fail-closed, routable, defaults to failure). A plugin parser never crashes the run.
- It is the **only** graph-side writer of the step list, and **must dominate** (precede on all paths) any `foreach(source:"task-steps")` — a validator rule that prevents merging a task that reached the foreach before steps were parsed.

#### `foreach` node — a per-step template region

`foreach` instantiates an inline template subgraph once per planned step. Config:

```
{ source: "task-steps", template: { nodes, edges },
  mode?: "sequential" | "parallel",      // default sequential
  isolation?: "shared" | "worktree",     // default: shared (sequential), worktree (parallel)
  concurrency?: number,                   // parallel only, 1..8, default 2
  maxReworkCycles?: number }              // default 3, cap 10
```

- The template has exactly one entry and one exit. A `step-execute` seam node is legal **only** inside a foreach template; `step-execute` may not appear in `split` branches.
- Expansion happens when the walk reaches the node; the step count is **pinned** at expansion and persisted (PROMPT.md edits afterward do not re-expand — a `pin-mismatch` failure surfaces if the live step list later disagrees on resume).
- Zero steps → the foreach traverses its `success` edge immediately (no merge blocker, matching today).

#### `loop` node — a bounded repeated template region

`loop` repeats an inline template subgraph until a configured output condition matches or a budget is exhausted. Config:

```ts
{ template: { nodes, edges },
  exitWhen: {
    type: "output-contains", value: string, nodeId?: string
  } | {
    type: "output-matches", pattern: string, flags?: string, nodeId?: string
  },
  maxIterations?: number,                  // default 3, cap 50
  timeoutMs?: number }                     // default 300000, cap 3600000
```

- The template has exactly one entry and one exit. If `exitWhen.nodeId` is omitted, the loop tests the template exit node's output.
- Loop templates may contain ordinary workflow nodes, but not nested `loop`/`foreach` regions, foreach-only `step-execute` seam nodes, rework edges, or normal cycles. The repeated execution is represented by the loop node itself.
- Success emits the normal `success` outcome and writes `node:<loopId>:loop` context with `iterations`, `exitReason: "matched"`, `finalValue`, and per-iteration history.
- Exhausting `maxIterations` emits `failure` with value `loop-iteration-exhausted`; exceeding `timeoutMs` emits `failure` with value `loop-timeout`. Authors can route those via `outcome:loop-iteration-exhausted` or `outcome:loop-timeout` edges.

#### Parallel mode & the `(depends:)` annotation

`mode` and `isolation` are independent axes. `parallel + shared` is rejected (concurrent writers in one worktree are unguardable). Under `worktree` isolation each instance runs in its own worktree/branch off a common base, with an **ordered integration stage** that lands step branches in step order (done iff integrated); a rebase conflict routes `outcome:integration-conflict` (default: rework on the updated base, budget-counted).

Per-instance `worktree` isolation, including the implicit default for `mode: "parallel"`, is not supported for workspace (multi-repo) projects. It fails fast with `worktree-isolation-unsupported-workspace`; use `mode: "sequential"` with `isolation: "shared"` for workspace projects.

### Workspace workflow admission

At task start, a workspace task acquires task-ID-named worktrees for every repository configured in `.fusion/workspace.json`; workflow nodes do not select repositories or add checkouts on demand. The configured set is immediately persisted as the confirmed repository scope used by Code Review, verification, and landing; planning no longer proposes a `## Repository Scope` heading.

Before a prompt Plan Review is dispatched, Fusion checks every task worktree's dependency readiness. It retries deterministic matrix rows once, but cannot infer a command for `unrecognized` package-manager evidence. Any remaining `unresolved` or `unrecognized` worktree produces the ordinary Plan Review `REVISE` with output beginning `Dependencies are not installed.` and one high-severity finding per repository. The planner repairs it through `fn_install_worktree_dependencies`, which records only engine-observed command exits or a reasoned `none` resolution. The existing Plan Review revision budget and `planReviewReplanCap` bound this loop; exhaustion parks `awaiting-approval` with reason `plan-review-replan-cap`, never an approval. A missing or unreadable dependency probe is `not-determined`, logged, and dispatches the review unchanged.

Parallelism is opt-in *per step by the planner*, not asserted by the workflow author. A step depends on the previous step unless its PROMPT.md heading carries a `(depends: N,M)` annotation listing the 1-indexed steps it actually depends on — e.g. `### Step 3 (depends: 1): Title`. An explicit empty list (`### Step 3 (depends:): Title` or `json-steps` `"depends": []`) means the step has no dependencies and can be scheduled as an independent root. An absent annotation/key is different: it remains the legacy previous-step dependency, so an unannotated plan is fully sequential regardless of `mode`. Annotate **conservatively**: only mark a step independent when it genuinely does not read or modify the prior step's output, or heavily-overlapping "independent" steps will loop integrate→conflict→rework until the budget exhausts.

#### `step-review` node & rework edges

`step-review` (`{ type: "plan" | "code", model? }`, legal only inside a foreach template) runs the reviewer against the current instance's step and maps the verdict to outcome edges: `outcome:approve` (marks the step done), `outcome:revise` (typically a rework edge — revise in place, no reset), `outcome:rethink` (a rework edge whose traversal first triggers reset-to-baseline: git reset + session rewind + step→pending), `outcome:unavailable` (transient unavailability retries within its bounded budget before routing; deterministic unavailability routes immediately). The validator requires `approve` and `revise` routed; `rethink` defaults to the revise target with reset semantics. Verdict authority is single-writer — review nodes inside `split` branches are advisory-only.

`rework` edges (`edge.kind: "rework"`) are the **only legal cycles**: a loop-back within one foreach instance, bounded by `maxReworkCycles`. Exhaustion emits `outcome:rework-exhausted` (validator requires it routed — escalation, hold, or failure; defaults to failure). Non-rework cycles still throw.

#### `code` node — sandboxed TypeScript

`code` (`{ source, timeoutMs? }`, default 30s, cap 300s) runs inline TypeScript (compiled with esbuild, executed in a timeout-bounded child process with cwd = the task worktree) for logic no built-in node covers. The script default-exports `async (ctx) => result` where `ctx = { task, steps, customFields, context, artifacts: { read(key) }, instance? }` (`instance` present inside a foreach template). The returned `{ outcome?, value?, contextPatch?, customFields? }` routes `outcome:<value>` edges, merges `contextPatch` into walk context, and writes `customFields` through the validated field authority. It gets **no store handle**, cannot write the step list, and a throw/timeout/non-zero exit becomes an audited `failure`. Source compile errors are rejected at save time (a dashboard 400 listing the failing node ids). It runs at the same trust tier as existing project-local script steps.

#### `notify` node — workflow-authored notifications

`notify` (`{ event, title?, message? }`) dispatches a notification through Fusion's active notification service and then always continues on the normal success path. `event` may be one of the standard notification events (for example `in-review`, `merged`, or `failed`), the built-in workflow-authored event `workflow-notify`, or a provider-specific custom event string. `title` and `message` are optional templates; the engine interpolates `{{taskTitle}}`, `{{taskId}}`, `{{workflowName}}`, and `{{context:key}}` from the workflow walk context.

Notification delivery is intentionally best-effort: a missing/unconfigured notification service, an empty `event`, or a provider delivery failure is logged/audited but does not fail the workflow node. Providers receive the rendered title/message in notification metadata so ntfy and webhook notifications can show workflow-specific copy. `workflow-notify` is **not** part of the default ntfy event allowlist; add it to `ntfyEvents` or the provider `events` filter when you want workflow-authored notifications delivered.

#### `ask-user` node — chat reach-out (FN-7579)

`ask-user` (`{ question? }`) reaches out to the user from inside a running task: it parks the task with `status: "awaiting-user-input"`, `paused: true`, and `pausedReason` carrying a `workflow-input:<nodeId>@<pauseEpochMs>: <question>` marker; the question surfaces in the task chat/detail (and via the `planning-awaiting-input` notification). Once the user replies (a steering comment at/after the pause watermark) and unpauses the task, the node resumes, clears its marker, and publishes the answer downstream at context key `input:<nodeId>` (readable by, for example, a downstream `exit-gate`'s condition). `question` falls back to `config.prompt`, then the shared default string ("This workflow is waiting for your input.") when both are omitted.

`ask-user` is a first-class, discoverable promotion of plumbing that already existed: a `prompt` node with `config.awaitInput: true` pauses/resumes identically (`runAwaitInputNode`). That shape remains a **fully supported back-compat alias** — existing workflows using it are unaffected — `ask-user` is simply the dedicated palette entry and IR node kind for new authoring.

#### `exit-gate` node — early workflow termination (FN-7579)

`exit-gate` (`{ condition? }`) lets a workflow route directly to the terminal `end` node instead of always walking the full graph. It is validated to always have a (transitive, non-rework) path to `end` so it can never strand the graph, but it is **not** itself an `end` node — only a router onto one.

With no `condition`, an exit-gate always exits (`outcome:exit`). With a `condition` (the same shape as a `loop` node's `exitWhen`: `{ type: "output-contains", nodeId?, value }` or `{ type: "output-matches", nodeId?, pattern, flags? }`), the gate reads `context["input:<nodeId>"]` — the same key an `ask-user` node's answer is published under — and exits (`outcome:exit`) when it matches, or falls through (`outcome:continue`) otherwise. Route `outcome:exit` to `end` and `outcome:continue` back into the loop (or onward) as needed. A malformed condition (bad regex, missing referenced value) degrades to "no match" rather than throwing.

#### Brainstorming / chat reach-out composition

Compose `ask-user` + `exit-gate` for a brainstorming phase that loops until the user approves, then proceeds:

```
start → ask (ask-user: "Anything to refine?")
     → exit (exit-gate: condition { type: "output-contains", nodeId: "ask", value: "looks good" })
         ── outcome:exit ──→ end   (or onward into the normal plan/execute path)
         ── outcome:continue ──→ ask   (rework edge back to the ask-user node; mark the ask-user
                                       node `config.reworkRegion: true` and the edge `kind: "rework"`,
                                       mirroring the top-level rework-region convention U6 uses for
                                       the PR review loop)
```

Each turn, the user is asked to refine; once they reply "looks good" (or whatever the condition matches), the exit-gate routes the task out of the brainstorm loop. The former `builtin:brainstorming` composition (FN-7584) is deprecated and hidden from new workflow selection, but remains resolvable for tasks that already use it. Its `ask-user` → refine prompt → `exit-gate`-on-approval shape can be copied into a custom workflow's IR via `fn_workflow_create`/`fn_workflow_update` when you need this behavior or a different downstream pipeline than the standard coding one.

#### Workflow-defined custom task fields

Workflows declare typed task fields via IR `fields: [{ id, name, type, required?, default?, options?, render? }]` (`type ∈ string | text | number | boolean | enum | multi-enum | date | url`; `options` for enum kinds; `render.placement ∈ card | detail | detail-section`, `render.widget`, `render.badge`). Values live in `tasks.customFields` and are validated through a single store authority (`updateTaskCustomFields`) with typed rejections (offending `fieldId` + `code`). Editing or switching a workflow **orphans** (never destroys) values for removed/incompatible fields — orphans are retained and shown under a detail disclosure. The task UI renders the schema dynamically (detail-form widgets by type, up to 3 card badges by placement). Agents read/write fields via `fn_task_update`'s `custom_fields` patch; authors set them via `fn_workflow_create/update`. Field values are surfaced in task/session context.

#### Workflow-declared optional steps (`optional-group` nodes)

<!--
FNXC:WorkflowOptionalGroup 2026-06-26-15:00:
FN-7039 retired the declaration-based optional-steps model (`WorkflowOptionalStep` / the `optionalSteps` IR field). Optional quality gates are now first-class graph `optional-group` NODES; per-task persisted selections reuse `enabledWorkflowSteps` keyed by the group NODE ID (not a template id). Docs must describe the node model, not the deleted declaration facet.

FNXC:FastOptionalSteps 2026-06-30-09:18:
Default-on optional groups apply only when `enabledWorkflowSteps` is omitted. An explicit persisted empty array means the operator disabled all optional groups (for example by selecting Fast during task creation), while explicit ids on a Fast task still run because manual selection is stronger than the fast default.

FNXC:FastOptionalSteps 2026-06-30-10:48:
Fast creation surfaces submit explicit `enabledWorkflowSteps: []` even before optional-step metadata loads, so asynchronous dropdown loading cannot accidentally turn default-on gates back on.
-->

Optional quality gates are authored directly in the workflow graph as `optional-group` **nodes**. An `optional-group` node is a container (mirroring `foreach`/`loop`) whose `template` subgraph the executor runs **once per enabled graph attempt**, and passes through (skips) when disabled. The template contains no internal iteration or rework edges (`validateOptionalGroup` rejects them), but the outer graph may re-enter the group for pre-merge fix/re-review remediation governed by `maxRevisions`.

Node config (`WorkflowOptionalGroupConfig`): `{ name?, defaultOn?, maxRevisions?: number | "unbounded", phase?: "pre-merge" | "post-merge", template: { nodes, edges } }`.

- `defaultOn` contributes to the runtime/display effective enable set only when the task has no persisted `enabledWorkflowSteps` array; operators can still toggle persisted selections when creating or editing tasks.
- `maxRevisions` optionally overrides the workflow/project `maxPostReviewFixes` budget for this one optional group's pre-merge fix → re-review loop. Use a non-negative integer for a bounded number of automatic fix passes, `0` to disable automatic fixes for that step, or `"unbounded"` to keep cycling until the step returns `APPROVE` / `APPROVE_WITH_NOTES`. When omitted, generic optional gates keep the global `maxPostReviewFixes` behavior; built-in `plan-review` and most `code-review` groups default to unbounded remediation unless a workflow setting caps them. Compound Engineering authors a two-pass Code Review cap.
- `phase` defaults to `"pre-merge"` (the prior, only behavior). `"post-merge"` marks a group the executor runs after a successful merge (see [Execution Phases](#execution-phases)). An enabled pre-merge group with no result blocks the merge door as well as pending or failed results. The built-in Plan Review, Code Review, and Browser Verification groups declare no phase, so they count as pre-merge.
- Persisted enable state lives on the per-task `enabledWorkflowSteps` array, keyed by the **group node id** (for example `browser-verification`, `code-review`). For execution, Fusion treats a group as enabled when `enabledWorkflowSteps` is present and includes the group id; if the field is omitted, Fusion falls back to the workflow node's `defaultOn: true`. An explicit empty array disables every optional group and prevents default-on gates from reappearing.
- **Current pre-merge approval:** an enabled Code Review gate permits merge only with a `passed` result carrying an explicit `APPROVE` or `APPROVE_WITH_NOTES` verdict, or a `skipped` result with the audited FN-7720 bypass metadata. A not-executed result satisfies a required pre-merge gate only when the gate is neither code-domain nor plan-domain; it can never satisfy Code Review or Plan Review. A `REVISE` blocks only when it carries at least one open actionable finding; finding-less and all-resolved revisions are recorded as `APPROVE_WITH_NOTES`. Remediation-archived results are not approvals. A disabled optional group is not a required gate. Diff-domain reviews must match the content being merged: singular tasks use the current diff fingerprint, while workspace tasks require confirmed per-repository `repositoryScope.reviewEvidence` for each modified in-scope repository. A matching plan-review fingerprint proves the plan text, not source diff content, and is never cross-compared with a diff fingerprint. A current workspace `reviewRemediation` record is blocking only when it identifies open findings. Missing approval clears by rerunning the gate, a failed review can be released through the audited bypass, stale content clears through a fresh review, and unavailable content proof blocks until the gate records new evidence.
- **Gate-resolution provenance:** merge doors assert default-on pre-merge groups only when their store can read task workflow selection. A store with no selection reader keeps legacy result-only semantics; a reader that reports no selection resolves the default workflow for that task; and a selection-read failure refuses the merge rather than guessing.

### Not-executed checks

A check that never starts is stored as terminal `status: "skipped"` with a fixed `notRunReason`: `not-configured` when no test or build command exists, `tooling-unavailable` when a required tool such as `agent-browser` is unavailable, `execution-mode-skip` when fast mode deliberately omits the check, or `repository-context-unresolved` when a workspace gate cannot resolve its task-owned repository context. Dashboard progress, Workflow results, and agent activity present this state as **Not executed** with its reason, and count it as completed without painting it as passed.

The graph still follows the success edge, so no operator action is required. Recorders deliberately do not write this discriminator for the `plan-review` group: Plan Review satisfaction is fail-closed on skipped rows, and writing one would create a blocking hold rather than an automatic continuation. This exclusion does not allow an unexecuted Plan Review to satisfy merge approval; both plan-domain and code-domain gates still require their existing positive evidence.

Built-in optional gates ship as inlined IR builders, not as a template catalog:

- `builtin:coding` carries the `browser-verification` optional-group node (`builtin-browser-verification-group.ts`), default-off, so browser verification runs only for tasks whose `enabledWorkflowSteps` includes `browser-verification`.
- `builtin:coding` and `builtin:stepwise-coding` carry the `plan-review` optional-group node (`builtin-plan-review-group.ts`), default-on, before `parse-steps` so the plan can be reviewed before execution begins even when a task has not persisted explicit optional-step ids.
- The `code-review` optional-group node (`builtin-code-review-group.ts`) is the inlined default-on code-review gate. On default `builtin:coding`, this is the only final review surface before merge; it is effective by default even when no explicit optional-step ids are stored. On `builtin:stepwise-coding`, it remains a post-foreach optional final review gate before the workflow's final review seam.
- Plan Review revisions retain their authored replan policy and operator approval cap. Code Review never parks for automatic convergence exhaustion: open findings become named remediation work, and finding-less feedback yields the deterministic fallback Fix step described below rather than a non-blocking release, so a `REVISE` never blocks a card merely because usable fix steps were absent. Exhausted feedback with no producible remediation is still recorded and released as non-blocking. `planReviewReplanCap` still backstops the unbounded Plan Review default and can park at `awaiting-approval` (reason `plan-review-replan-cap`) for an explicit human decision. These values remain editable for read-only built-ins without duplicating the workflow.
- A workflow (for example compound-engineering) can add a **post-merge** optional-group node via the generic `postMergeOptionalGroupNode(...)` builder (`builtin-post-merge-group.ts`) — e.g. a `document` step that runs after merge.

Create-time optional-step controls appear in the quick-add action row and the **New Task** dialog inline quick buttons for the active workflow. They resolve the workflow's optional-group nodes (plus plugin-contributed palette templates, see [Plugin-Contributed Steps](#plugin-contributed-steps)) into toggleable rows. Selecting **Fast** clears currently enabled optional steps and submits `enabledWorkflowSteps: []` even if optional-step metadata is still loading; leaving Fast restores the pre-Fast selection plus any steps enabled while Fast was active, with the current workflow's `defaultOn` seed used when that baseline is no longer trustworthy. The dropdown stays available once loaded; any manual reselection before create is submitted as explicit ids and executes even on the Fast task. Workflows with no optional groups render no trigger and omit `enabledWorkflowSteps` unless the operator selects Fast, where the explicit empty array preserves the speed-first opt-out. Unknown or removed ids are skipped during resolution so stale selections never render blank controls or break workflow loading.

## What They Are

A workflow step is a reusable quality gate (AI prompt or script) that can be enabled on tasks. Each gate is an `optional-group` node in the workflow graph; the graph executor runs it and records the outcome onto the task. There is no separate workflow-step execution engine, no `workflow_steps` table, and no step CRUD surface — everything is graph-native.

Common use cases:

- Documentation review
- QA/test verification
- Security scanning
- Performance checks
- Accessibility checks
- Browser-level verification

## Execution Phases

<!--
FNXC:WorkflowPostMerge 2026-06-26-15:00:
FN-7039 (U7b/U7c) made post-merge graph-native and deleted the legacy merger post-merge path (`runPostMergeWorkflowSteps`). `graphNativePostMerge` is DEFAULT-ON; the graph is the SOLE owner of post-merge execution. Docs must not describe a "merger-owned" post-merge path.
-->

An `optional-group` node's `phase` config selects one of two phases:

- **Pre-merge** (default): runs before merge/finalization; a gate failure blocks completion.
- **Post-merge**: runs after a successful merge; failure is logged/recorded but non-blocking.

Post-merge runs **graph-native**: after a successful merge the executor continues traversal to any post-merge optional-group node reachable from the merge region (and to plain post-merge nodes that follow a `seam:"merge"` node), running it via the same optional-group execution + recording path with `phase: "post-merge"` and non-blocking failures. This is gated by `experimentalFeatures.graphNativePostMerge`, which is **default-ON** and is now the single owner of post-merge execution — the legacy merger-owned post-merge path was deleted, so there is no fallback and post-merge work runs exactly once via the graph.

> **Note on Fast Mode:** When a task has `executionMode: "fast"`, every **pre-merge** optional group is bypassed, including groups explicitly named in `enabledWorkflowSteps`. The graph records terminal `skipped` evidence for each bypassed pre-merge group so merge admission remains auditable. `parse-steps` is retargeted to one synthetic implementation occurrence, per-step `step-review` is routed past without a verdict, and post-merge groups remain active and run normally.

## Execution Modes

- **Prompt mode**: starts an AI agent for the step
- **Script mode**: runs a named script from project settings (`settings.scripts`)

Prompt mode can run with readonly or coding-capable tool access depending on step/template configuration.

<!--
FNXC:AgentSteering 2026-06-30-14:18:
Workflow-step prompt agents are reviewer-style gates even when they do not call the shared reviewStep helper. They receive the same canonical user-authored task comments and legacy steering context as Plan Review and Code Review so Browser Verification and custom gates evaluate explicit operator requirements.
-->

Prompt-mode workflow-step agents receive user-authored task comments plus legacy steering entries in their system prompt. Agent-authored comments are excluded, duplicate ids are de-duped, and this context is omitted when no user-authored entries exist.

## Tool Modes

`toolMode: "readonly"` is enforced as a hard session-level allowlist. Readonly workflow-step agents can only access:

- `read`
- `grep`
- `find`
- `ls`
- `fn_web_fetch`
- `fn_task_show`
- `fn_task_list`
- `fn_insight_list`
- `fn_insight_show`
- `fn_list_agents`
- `fn_get_agent_config`

Readonly steps cannot hold `edit`, `write`, `bash`, or task/agent mutation tools. Attempts to use denied tools fail closed with `READONLY_VIOLATION` and are surfaced as a `[readonly-violation]` workflow-step failure outcome.

Use `toolMode: "coding"` for any prompt step that must modify files, run shell commands, or perform mutation actions.

## Gate Modes

A gate node also has a `gateMode`:

- **`gate`**: failures block merge/completion and follow normal remediation/retry flows.
- **`advisory`**: failures are recorded as `advisory_failure` and shown as polish feedback, but never block merge.

Defaults:
- gates are `advisory` by default (advisory-by-default per FN-4368); opt in to `gate` by setting the node's `gateMode` in the [Workflow Editor](./workflow-editor.md).

A task paused awaiting a prompt/script gate's cli-approval or ask-input response (`pausedReason` prefixed `workflow-cli-approval:` or `workflow-input:`) is one of the five stages the records-only planner-overseer monitor watches (`workflow-gate`, `packages/engine/src/planner-overseer.ts`, FN-7511) — see **`docs/architecture.md` § "Planner overseer monitoring (records-only)"**.

## Built-In Quality Gates

<!--
FNXC:WorkflowStepTemplate 2026-06-26-15:00:
FN-7039 (U6) DELETED the `WORKFLOW_STEP_TEMPLATES` built-in catalog array (the former 7-template value export). Built-in gates are now inlined IR optional-group node builders. Docs keep the conceptual list of gate kinds but must not reference the deleted array/catalog.
-->

The built-in quality gates ship as inlined `optional-group` node builders in `@fusion/core`, not as a template catalog (the former `WORKFLOW_STEP_TEMPLATES` array was removed):

- **Browser Verification** (`browser-verification`, `builtin-browser-verification-group.ts`) — browser-automation-style checks for UI validation flows; an optional-group node on `builtin:coding`, `builtin:legacy-coding`, and `builtin:stepwise-coding`.
- **Plan Review** (`plan-review`, `builtin-plan-review-group.ts`) — default-on plan readiness review before `builtin:coding` or `builtin:stepwise-coding` moves from planning to step parsing/execution.
- **Code Review** (`code-review`, `builtin-code-review-group.ts`) — the inlined code-review gate.

The Browser Verification inner prompt node carries `requiresBrowser: true` while keeping `toolMode: "coding"`. When that step runs, the executor best-effort adds the `agent-browser-navigation` skill (when the agent-browser plugin is installed), runs a bounded non-fatal `agent-browser --version` preflight, and writes start, availability, and finish entries into both the task log and the task's agent log. A missing or timed-out `agent-browser` binary is logged as an actionable warning rather than failing the step solely because of the preflight; the prompt can still fast-bail or report a normal verification failure. Because Bash tool events are already streamed to the agent log, `agent-browser open ...`, `agent-browser snapshot ...`, and related commands appear as the browser-verification activity the step performed.

Plugin-contributed gate kinds (documentation review, QA, security audit, performance, accessibility, frontend UX design, etc.) can still be supplied as palette templates; see [Plugin-Contributed Steps](#plugin-contributed-steps).

Built-in gate prompts emit the structured `{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}` envelope (final line JSON only). The legacy `REQUEST REVISION` prose path remains as a backward-compatible fallback. See [Prompt-mode Structured Verdict Contract](#prompt-mode-structured-verdict-contract).

## Plugin-Contributed Steps

Installed plugins can provide **workflow step templates** that act as the workflow editor's optional-group **palette**. `GET /api/workflow-step-templates` now serves **plugin-contributed templates only** (the built-in catalog was removed) and the editor projects each palette template into an `optional-group` node you drop into a workflow graph.

Plugin entries are labeled/grouped as plugin-contributed (including plugin attribution in the template metadata) so you can distinguish them from Fusion's inlined built-in gates.

A palette template still carries the same `prompt` or `script` mode, `pre-merge` or `post-merge` phase, and `defaultOn` behavior; once projected into a workflow it executes exactly like any other optional-group gate.

For plugin installation and authoring details, see the [Plugin Authoring Guide](./PLUGIN_AUTHORING.md) (Section 16: Registering Workflow Steps).

## Authoring a Custom Quality Gate

<!--
FNXC:WorkflowStepCRUD 2026-06-26-15:00:
FN-7039 (U5/U6) deleted the Settings → Workflow Steps manager and its CRUD routes. Custom gates are now authored as optional-group graph nodes in the Workflow Editor. Docs must point at the editor, not a Settings form.
-->

There is no longer a Settings → Workflow Steps manager or step CRUD form. To add a custom quality gate, open the [Workflow Editor](./workflow-editor.md), duplicate a built-in (or edit a custom workflow), and add an `optional-group` node:

- Set the node's `name`, `defaultOn`, and `phase` (`pre-merge` / `post-merge`).
- Author the gate inside the node's `template` subgraph as `prompt`/`script`/`gate` nodes (single pass, no rework edges).
- Tasks persist operator-selected gate ids via `enabledWorkflowSteps`; runtime/display also includes gates whose nodes declare `defaultOn: true`, while edit controls show only the persisted selection.

Plugin palette templates (above) can be dropped in as a starting point instead of authoring a node from scratch.

## Model Overrides for Workflow Nodes

<!--
FNXC:WorkflowModelBinding 2026-08-18-23:38:
FN-7771 lets workflow authors bind reasoning effort per session-running node, independently from provider/model. The canonical vocabulary now includes both opt-in `xhigh` and `max`; node-level thinking remains strongest so a custom workflow can pin a high-effort review or low-effort execution seam without changing task-wide or lane defaults. Model-bound dashboard controls narrow only when `/api/models` carries pi capability metadata; unknown metadata keeps the canonical fallback.
-->

A prompt-mode gate node can set its own model with:

- `modelProvider`
- `modelId`
- `thinkingLevel` (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`)

If a node also sets `config.credentialInstanceId`, execution resolves that configured instance for the node's provider/model pair; clearing it uses the provider default credential. If both model fields are set, node execution uses that provider/model pair; otherwise it falls back to default model selection. `thinkingLevel` is stored as `config.thinkingLevel` and can be set or cleared independently from the model pair. Runtime reasoning-effort precedence is **node/step `thinkingLevel` → task `thinkingLevel` → workflow lane thinking override (`executionThinkingLevel`, `planningThinkingLevel`, or `validatorThinkingLevel`) → global lane thinking override → project default thinking override → global `defaultThinkingLevel`**. The lane settings accept `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; unset means inherit. Model-bound controls offer only the selected model's documented levels (`null` excludes a level and `xhigh`/`max` require a mapped string); without metadata they offer the canonical list. This applies to prompt/gate custom nodes, the `execute` and `step-execute` seams, triage/planning, and `step-review` reviewer sessions. Dashboard node summaries show unpinned provider/model state as **Default model**; the inspector's inline thinking selector shows the resolved project default (e.g. "Default (off)") when no node-level thinking value is pinned.

## Default-On Behavior for New Tasks

`optional-group` nodes support `defaultOn`.

When `defaultOn: true`, the gate is effectively enabled for execution and in-progress display even if the task's persisted `enabledWorkflowSteps` array is empty. Creation and edit controls still use the persisted selection as their source of truth, so operators can distinguish an explicit stored toggle from a workflow-authored default.

## Workflow Step Revision Loop

A review revision produces its remediation before any review-to-WIP move is requested. Named-remediation workflows append visible `Fix:` steps after the untouched task history and then a pending `Testing & Verification` step; trailing-reopen workflows instead use their reopened pending occurrence. Every post-completion appender records the shared step-ledger reopen marker atomically with that new work, and starting a still-`pending` occurrence also records re-entry, so the resumed foreach skips completed history, executes the pending remediation, and can take its success edge back into review. Previously completed verification occurrences remain completed, while the fresh trailing occurrence makes another verification pass mandatory before the revised card can return to review. The parse node preserves live remediation steps across the post-bounce run; dedupe and scope checks still apply, while remediation waves are unbounded. A workflow's authored optional-group `maxRevisions` is the only numeric bound.

A Code Review `REVISE` must contain structured, file-specific Fix-step records. If a reviewer nevertheless omits usable records or only reports out-of-scope files, Fusion appends one deterministic pending Fix step that directs the executor to turn that feedback into concrete implementation work and returns the card to WIP; it never leaves Code Review blocked for that omission. Verification and unrelated gates retain their evidence-based non-blocking release behavior when no actionable remediation exists. Automatic failed-review revival claims the exact keyable review-input signature before it consumes budget or narrates an attempt. The claim has an owner and every refresh or release is fenced by step id, signature, and owner, so a concurrent runner cannot duplicate the attempt and an overtaken runner cannot clear a newer round's claim.

A gate can request implementation revisions instead of just blocking completion. The revision/remediation flow runs through the **graph executor**, which calls the same executor revision primitives described below (the legacy `runWorkflowSteps` loop that previously owned this flow was deleted).

### How It Works

Prompt-mode gate output is parsed in this order:

1. Structured JSON verdict (`parseWorkflowStepVerdict`)
2. Legacy prose fallback (`inferWorkflowStepVerdictFromProse`)
3. `malformed` when neither format can be interpreted

#### Structured Verdict Output

Use a JSON object with this schema:

```json
{ "verdict": "APPROVE|APPROVE_WITH_NOTES|REVISE", "notes": "..." }
```

- Valid `verdict` values are exactly: `APPROVE`, `APPROVE_WITH_NOTES`, `REVISE`.
- `notes` is required and must contain a short rationale naming what was checked and why the verdict was reached. When a structured verdict leaves it blank, Fusion first recovers the reviewer's surrounding prose, then a bounded list of its finding titles; if neither exists, the live session receives one bounded, verdict-preserving request for notes. If that request also produces nothing, Fusion substitutes deterministic engine narration that states the verdict and why reviewer-authored rationale is unavailable; it never fabricates rationale or changes the verdict. Each repair attempt records the fixed outcome through the bounded `task:review-notes-repaired` run-audit event.
- The parser checks fenced and inline JSON candidates, and the **last valid candidate wins**. Inline scanning keeps every balanced object (including nested objects) and is string-aware. If that scan detects desynchronization from arbitrary prose (an unpaired brace, quote, or stray close), it also recovers recent full JSON lines and `JSON.parse`-arbitrated brace slices across a generous trailing window. Fairly allocated close/open-anchor budgets preserve payloads with braces or escaped quotes in strings, many findings, and brace-bearing prose after the payload; recovery is based on scanner desync, not whether the payload happens to be near the end.

Accepted shapes:

- Fenced JSON block (supports both ``` and ```json fences):

```json
{"verdict":"REVISE","notes":"Fix auth lock handling in src/auth.ts."}
```

- Inline JSON object scanned from prose:

`Review complete. {"verdict":"APPROVE_WITH_NOTES","notes":"Looks good; consider tightening error copy."}`

Additional example:

`{"verdict":"APPROVE"}`

#### Prose Fallback

Legacy prose is still supported when structured JSON is missing. A visible but unreadable quoted JSON `"verdict":` key is never converted into a prose approval: prompt-gate parsing reports `malformed`, while reviewer and plan-review lanes return retryable `UNAVAILABLE`. Plain prose with no structured verdict key remains lenient:

- Output beginning with `REQUEST REVISION` (case-insensitive) maps to `REVISE`.
  - Remaining prose becomes `notes`.
  - If nothing follows, notes default to `"Revision requested"`.
- Output containing one of these phrases maps to `APPROVE`, and the full reviewer-authored prose becomes the note: `approve`, `approved`, `looks good`, `no issues`, `out of scope`.

For new workflow step prompts, prefer the structured JSON contract.

#### Malformed Output

If output matches neither structured JSON nor known prose fallback patterns, Fusion records the step output as `malformed`. Operationally, this means no workflow verdict could be inferred from that response. A malformed `gateMode: "gate"` prompt step is a blocking failure rather than an approval; a malformed `gateMode: "advisory"` step is recorded as `advisory_failure` and does not block completion.

### Behavior

When a revision is requested:

1. Fusion scope-checks any explicit file paths named in the feedback against the task's declared `## File Scope`
2. In-scope feedback is appended to a **Workflow Revision Instructions** section in the task's `PROMPT.md`
3. Explicitly out-of-scope feedback is forked into a dependent follow-up triage task instead of mutating the original task branch
4. If both kinds are present, Fusion splits the feedback: the original task reruns only with the retained in-scope block while the follow-up captures the unrelated work
5. If no in-scope feedback remains after splitting, the original task is left untouched and continues its normal completion path while only the follow-up task is created
6. When the original task retains in-scope feedback, only the last implementation step is reopened and a fresh executor session is scheduled

### Feedback Format

Recommended (structured JSON, prompt-mode):

```json
{"verdict":"REVISE","notes":"[Clear, actionable description of what needs to be fixed]"}
```

Also valid for approvals:

```json
{"verdict":"APPROVE","notes":"Reviewed the scoped implementation and targeted verification; both satisfy the acceptance criteria."}
{"verdict":"APPROVE_WITH_NOTES","notes":"The implementation is correct; the non-blocking follow-up is described below."}
```

Legacy fallback (still supported via prose inference):

```
REQUEST REVISION

[Clear, actionable description of what needs to be fixed]
```

The revision block replaces any prior revision instructions (no accumulation). Persisted workflow-step results mirror the final human-readable rationale into both `output` and `notes`; workspace review aggregates preserve each repository's rationale in their combined narrative.

By default this split-and-fork behavior is enabled through the project setting `workflowRevisionForkOnScopeMismatch`. Set it to `false` to restore the legacy behavior that appends all workflow revision feedback to the original task even when it references files outside the declared File Scope.

### End-of-step file-scope invariant for prompt pre-merge steps (FN-4343)

<!--
FNXC:WorkflowScopeLeak 2026-06-26-15:00:
KNOWN FOLLOW-UP: the FN-4343 per-step end-of-step scope-leak invariant (and its `workflowStepScopeEnforcement` setting) has NOT yet been replicated on the graph-native optional-group execution path. The setting is still declared and round-trips, but the graph executor does not run the per-step invariant. Merge-time File Scope enforcement is a separate gate in the unified AI-merge `landOneRepo` seam; it evaluates the approved clean-room squash before the integration ref advances.
-->

> **Known follow-up (not yet on the graph path):** The original FN-4343 per-step invariant ran after each successful prompt-mode pre-merge workflow step under the legacy `runWorkflowSteps` loop. That loop was deleted in the graph-native cutover, and this per-step invariant has **not yet been replicated** on the optional-group graph path. The `workflowStepScopeEnforcement` setting (`"block"` / `"warn"` / `"off"`, default `"block"`) is still declared and round-trips, but the graph executor does not currently enforce it per step. Merge-time File Scope enforcement (`FileScopeViolationError` and squash/file-scope overlap) runs at unified AI-merge `landOneRepo` before landing, so off-scope writes are still caught at merge.

The original (legacy) invariant evaluated files newly touched by a prompt-mode pre-merge step (committed delta plus uncommitted working-tree edits):

- If declared `## File Scope` was empty, the invariant was skipped.
- If task `scopeOverride === true`, it was bypassed (same semantics as merge-time scope enforcement).
- If touched files had zero overlap with declared scope, it emitted a scope-leak log and applied `workflowStepScopeEnforcement` (`"block"` → mark `failed` + request revision; `"warn"` → log and pass; `"off"` → disable).

### Executor `fn_task_done` scope-leak guard for Plan-Only tasks (FN-4482)

Fusion also enforces a completion-time scope-leak check in the executor `fn_task_done` path:

- Applies to tasks with declared `## File Scope`.
- Uses touched files from branch committed delta plus uncommitted working-tree edits at completion time.
- Emits `[scope-leak]` activity-log entries when touched files are off-scope.
  - Off-scope touched-file and declared-scope lists are truncated to the first 10 entries with `… (+N more)` when longer.
  - Log entries include `total off-scope=` and `total scope=` counters so full list sizes remain explicit.
  - In `"block"` mode, the `fn_task_done` refusal message uses the same truncated off-scope preview.
- Honors `task.scopeOverride === true` as an explicit bypass.

`planOnlyScopeLeakEnforcement` controls Review Level 1 behavior:

- `"warn"` (default): log and allow completion.
- `"block"`: refuse `fn_task_done` and ask the agent to revert off-scope paths.
- `"off"`: disable this completion-time guard.

Review Level `0` and `>=2` run in warn-only telemetry mode (never block).

### Hard Failures vs Revisions

Not all workflow failures are revision requests:

- **Revision requested**: Implementation needs changes → routes back to the executor for a fresh remediation pass. For the pre-merge gates (Code Review, Browser Verification) the card is sitting in `in-review` while the gate runs, so the paired remediation node (`code-review-remediation` / `browser-verification-remediation`) moves it back to `in-progress` on entry.
- **Hard failure**: Treated as remediable until retries are exhausted; the executor injects feedback and sends the task through `todo → in-progress` for a fresh remediation pass

#### Pre-merge hard failure remediation flow

For pre-merge gate hard failures, the graph executor drives remediation through the executor primitives (gate-mode nodes):

1. Retry the failing check up to `MAX_WORKFLOW_STEP_RETRIES` within the same execution lifecycle
2. On retry exhaustion, add a steering comment with failure details and inject a `Workflow Step Failure` section into `PROMPT.md`
3. Reopen the terminal verification/delivery suffix plus the nearest preceding implementation step (`pending`) so the resumed pass can address feedback without discarding unrelated completed work
4. Schedule `todo → in-progress` after guard unwind, triggering a fresh executor remediation run that must complete every reopened step before the workflow step re-evaluates

Tasks are not *parked* in `in-review` for this remediable path unless additional terminal failures occur — they pass through it. The pre-merge review gates run with the card in `in-review` (which is what surfaces the running step as a card badge on the board), and remediation moves it back to `in-progress`; the card only stays in `in-review` when a terminal failure blocks the merge gate.

Because `in-review` carries no WIP trait, a card releases its concurrency/worktree slot while a review gate runs, even though its agent and checkout are still live. The pool can therefore be full when the remediation node crosses back into `in-progress`, and capacity is enforced in-transaction and is never bypassable — so that move can be rejected. The workflow column boundary treats a capacity rejection as a **park, not a failure**: the run unwinds cleanly, the card keeps its failed pre-merge gate result and its worktree, and the next graph run retries the crossing once a slot frees. Non-capacity rejections (invariant violations) still surface as real errors.

## Workflow Interpreter Dual-Observe (retired parity instrumentation)

The workflow interpreter dual-observe seam is retired. `experimentalFeatures.workflowInterpreterDualObserve` is now inert: runtime feature helpers force it OFF even when stale persisted settings contain `true`, and Fusion must not invisibly re-enable shadow interpreter observation.

- **Flag:** `experimentalFeatures.workflowInterpreterDualObserve` (retired; forced OFF)
- **Mode:** strict no-op (no shadow run, no parity audit records)
- **Historical behavior:** earlier rollout builds compared legacy and interpreter observations plus comparable run-audit slices and emitted the parity audit records below

Historical run-audit events in the `database` domain:

- `workflow:parity-observed` — emitted for an enabled parity check with `metadata.agree`
- `workflow:parity-drift` — emitted when parity differed (or shadow execution failed), carrying `metadata.diffs`

The parity contract is exported from `@fusion/core` (`compareWorkflowRunObservations`, `compareWorkflowRunAudits`) and produces deterministic drift reports shaped as `{ agree, diffs[] }`, where each diff includes field name, legacy/interpreter values, category, and severity.

Authoritative cutover now depends on existing/current parity summary evidence, not on re-enabling dual-observe. The interpreter may become authoritative only when the separate `experimentalFeatures.workflowInterpreterAuthoritative` flag is ON and the cutover-readiness guard sees a populated parity summary with enough observed runs, zero summary drift, and zero unresolved parity reports.

#### Self-healing recovery for parked review tasks

If a task is found in `in-review` with failed pre-merge workflow results and no active executor, self-healing can auto-revive it by replaying the same remediation send-back flow. A singular task uses its task worktree; a workspace task uses the acquired sub-repository worktree selected by the failed repository review outcome. Recovery is checkout-unavailable only when neither a singular worktree nor a usable acquired sub-repository worktree can be resolved. Generic optional gates use the resolved workflow/project budget; built-in Plan Review and most Code Review groups are unbounded unless workflow settings or node config set a numeric cap. Compound Engineering's Code Review node supplies a two-pass cap.

Project-level `autoMerge: false` gates **merge admission**, not pre-merge remediation: Plan Review replans, Code Review/optional-gate fixes, required-artifact recovery, and failed-step revival remain available for shared-branch members and standalone tasks. Only an operator-authored task-level auto-merge Off fences those remediation seams. Every such hold or revision-budget refusal is recorded on the task; when a fire-and-forget remediation node cannot schedule after implementation is complete, the card stays visibly parked in its resolved review lane with its merge blocker rather than bouncing back to planning.

<!--
FNXC:WorkflowOptionalStepFix 2026-06-26-17:05:
Enabled PRE-merge optional-group REVISE findings should be acted on before review/merge when the executor is still in the graph run. The inline path consumes the same `postReviewFixCount` / `maxPostReviewFixes` budget before scheduling `sendTaskBackForFix`; exhausted budgets preserve the older advisory/gate behavior so optional advisory gates remain ultimately non-blocking.

FNXC:WorkflowOptionalStepRevisionBudget 2026-06-27-12:55:
Workflow authors can override the global optional-step remediation budget per optional-group via `maxRevisions`, including `"unbounded"` for loops that should continue until the step approves. Document both inline executor and self-healing semantics because they must resolve the same budget for parked review recovery.

FNXC:WorkflowOptionalStepFix 2026-06-27-22:51:
A post-verdict bounce from Code Review or Browser Verification must not reopen only a trivial trailing documentation step. The next executor pass reopens the actionable implementation step plus terminal verification/delivery steps, completes them to `done`, and only then lets the optional group re-evaluate across both in-progress and in-review bounce sources.

FNXC:WorkflowRemediation 2026-07-03-20:10:
Retryable graph failures at explicit remediation nodes (for example `code-review-remediation` returning `remediation-not-scheduled` after restart-local context is gone) should not strand tasks in `in-review` with `status:"failed"`. Live executor handling and self-healing both classify the durable failed pre-merge step result and send the task through the existing remediation bounce. A workspace task's acquired sub-repository checkout satisfies this requirement; "missing worktree" means that neither a singular worktree nor any resolvable acquired sub-repository checkout exists. Numeric caps, pauses, unavailable checkouts, and auto-merge-disabled rows remain operator-actionable.
-->

During a live graph run, an enabled **pre-merge** optional step that returns `REVISE` (including the built-in **Code Review** / `code-review` and **Browser Verification** / `browser-verification` groups) sends the task back to the executor for a fix pass before the graph continues to review or merge. The workflow graph restarts on the next executor pass, re-launches task execution, and reopens the terminal verification/delivery suffix plus the nearest preceding implementation step so the verdict-demanded fix can be made rather than merely replaying a trivial trailing step. The optional step re-runs only after the executor drives those reopened steps back to `done`; the cycle repeats until the step returns `APPROVE` / `APPROVE_WITH_NOTES` or the resolved revision budget is exhausted. Generic optional gates use the workflow/project `maxPostReviewFixes` value (built-in default: 10 fix passes). Built-in Plan Review and most Code Review groups default to `"unbounded"` so they continue until approval unless `planReviewMaxRevisions`, `codeReviewMaxRevisions`, or the node's `config.maxRevisions` sets a numeric cap. Compound Engineering's Code Review node authors a two-pass cap. The aggregate `postReviewFixCount` remains for dashboard visibility, but budget checks count attempts per workflow-step key so Plan Review, Code Review, and Browser Verification do not consume each other's caps.

### Severity-gated review verdicts

Revision budgets bound a remediation loop; they do not make it converge. The **blocking severity** gate shapes it at the source: a review-kind gate's `REVISE` only blocks when it carries at least one finding at or above the review kind's threshold (`planReviewBlockingSeverity`, default `high`/P0+P1; `codeReviewBlockingSeverity`, default `critical`/P0). A `REVISE` whose findings are all below the threshold is recorded as `APPROVE_WITH_NOTES`, the task proceeds, and the findings are written into PROMPT.md as a non-blocking `## Review Advisory Notes` section so the implementer still sees them.

The gate **fails closed** and only ever relaxes a verdict:

- a `REVISE` with no structured `findings` at all (prose-only, custom, or older reviewers) still blocks;
- a `REVISE` carrying any finding that omits `severity` still blocks;
- an `APPROVE`/`APPROVE_WITH_NOTES` is never promoted to a block, whatever its findings say.

Set either setting to `any` to restore the previous behavior where every `REVISE` blocks. The built-in Plan Review and Code Review prompts request the structured findings schema, define severity as P0/P1/P2 by consequence, instruct reviewers to omit nits entirely rather than file them as low-severity findings, and use an incremental re-review contract that forbids introducing new non-blocking findings as grounds for another round. Remediation instructions render findings grouped by priority — P0 must fix, P1 fix or explicitly decline with a rationale, P2 optional. Findings marked `resolved-in-review` or `superseded` are audit receipts: they never block, become advisory notes, or enter remediation priority lists; remediation shows them only in an explicit do-not-redo block, and the Review tab plus revision route do not allow them to be selected.

Remediation now also **preserves the implementation session**: a review bounce keeps `task.sessionFile`, so the next round continues the same conversation instead of re-reading the repository and re-deriving the change it just wrote. The resume prompt directs the agent to re-read PROMPT.md, which is where the new findings were written. Paths that genuinely need a fresh session (context overflow, stale continuation, worktree reacquisition, task-done refusal) still clear the session explicitly at their own site, and the resume guard re-validates the persisted worktree before reopening.

The same resolved per-step budget is used by self-healing when it revives an `in-review` task that is parked with a failed pre-merge workflow result. If the failed step's IR cannot be resolved, self-healing falls back to `maxPostReviewFixes` so existing behavior is preserved. `"unbounded"` relies on the optional step eventually approving; a step that always returns `REVISE` will continue cycling until a human intervenes or another guard (pause, worktree/lease, auto-merge policy, dependency blocker) stops recovery. The remediation instructions show `attempt/unbounded` and unlimited remaining retries for this policy rather than a misleading legacy `3/3` label. When the budget is exhausted or disabled, behavior falls through to the prior semantics: advisory results remain non-blocking and gate failures remain failed/parked.

Post-merge optional groups never trigger this send-back path because merge has already happened; their failures are recorded/logged as non-blocking post-merge results.

Advisory failures are intentionally excluded from merge blocking and self-healing auto-revive after a task is already in review; their live-run fix pass is only the bounded pre-review remediation described above.

#### Review-lane bypass (operator escape hatch, FN-7720)

Self-healing recovery re-runs the *same* dispatch that produced a failed pre-merge review step. When that step failed for infrastructure reasons rather than a genuine `REVISE` verdict — the leading real-world cause being the `(no feedback captured)` no-verdict dispatch defect (Runfusion/Fusion#1946) — recovery keeps re-running the defective dispatch instead of unblocking the card. For that situation, Fusion exposes a supported, audit-logged **review-lane bypass** primitive so a privileged operator can advance the card without waiting on the underlying engine fix:

- **Store primitive:** `TaskStore.bypassFailedPreMergeReviewStep(id, { reason, actor })` in `@fusion/core`.
- **Dashboard:** `POST /tasks/:id/bypass-review` (requires a body `{ reason }`), and a **Bypass failed review** action in the Task Detail actions menu — shown only when the task is `in-review` and carries a failed pre-merge review step. The operator must type a reason before it fires.
- **CLI / pi extension:** `fn_task_bypass_review` (params: `id`, required `reason`). This tool is registered **only** on the CLI/pi-extension operator surface — it is never exposed to executor, reviewer, or triage agent tool lists, so autonomous task execution cannot self-bypass a review it failed.

**A reason is always mandatory** and every bypass is audit-logged (actor, timestamp, reason, and the prior step status it superseded) via a `task:bypass-review` run-audit event plus a task log entry.

The bypass targets the **most-recently-completed failed pre-merge** `WorkflowStepResult` (any lane — Code Review, Code Review Remediation, Plan Review, Browser Verification) and rewrites it in place: `status` becomes `"skipped"` (a terminal, non-blocking value `getTaskMergeBlocker` does not match), and the result is stamped with `bypassedBy`, `bypassedAt`, `bypassReason`, and `bypassedFromStatus` (the prior `"failed"` status) plus `bypassedFromVerdict` when one was present. If an enabled required pre-merge group has no result at all, the same operator bypass records a new skipped result with `bypassedFromStatus: "absent"`. **The bypass never fabricates a reviewer `verdict`** (no synthetic `APPROVE`) — it is an honest record that the gate was overridden, not that the change was reviewed and approved. `fn_workflow_step_resume` remains the escape for an existing pending result.

The bypass clears **only** the relevant pre-merge merge-blocker reason. It does **not** touch any other `getTaskMergeBlocker` condition: a paused task, incomplete steps, a blocking task status, or a still-`pending` pre-merge step all continue to block exactly as before. It also does not itself move the task to `done` or force a merge — an `autoMerge:false` task remains terminal-until-human-merge after the bypass, same as before (FN-5147). Because the bypassed step's `status` is no longer `"failed"`, self-healing's recovery sweep (`recoverReviewTasksWithFailedPreMergeSteps`) no longer selects it for re-dispatch. A forced promotion that explicitly waives Plan Review records its own skipped planning-gate result; legacy adoption likewise does not backfill resultless pre-merge groups after review. Recovery scanners keep their legacy blocker query so they can still find resultless-blocked cards and route them back to the graph gate.

## Viewing Results

<!--
FNXC:WorkflowStepResults 2026-06-26-15:00:
Results now live on `task.workflowStepResults` (written by the graph executor, keyed by optional-group node id). The persisted `status` union is pending/passed/failed/advisory_failure/skipped; the UI derives a `running` display state from a `pending` entry with `startedAt` and no `completedAt`.
-->

Gate results are recorded on the task's **`workflowStepResults`** field (`WorkflowStepResult[]`), written by the graph executor and keyed by the optional-group node id. Each entry carries `status`, optional `verdict`, `notes`, `output`, and `phase`. Verdict-carrying prompt reviews persist a non-empty rationale mirrored in `notes` and `output` whenever the reviewer supplies or repairs one; legacy rows may still lack both. The unified progress bar and the Workflow tab read this field directly.

<!--
FNXC:WorkflowStepResults 2026-07-09-01:10:
FN-7727: a self-healing recovery re-run of a failed pre-merge review node
(code-review, plan-review, browser-verification) re-executes the SAME
`workflowStepId` in place. Every recorder now upserts through the shared
`upsertWorkflowStepResult` core helper (`packages/core/src/workflow-step-results.ts`),
which snapshots a replaced `failed`/`advisory_failure` entry into the new
entry's `priorAttempts` (bounded, single-level, oldest-dropped) instead of
silently overwriting it. `priorAttempts` is READ-ONLY history: self-healing
recovery selection, `getTaskMergeBlocker`, and progress/timing all read only
the current (latest) entry and never inspect `priorAttempts`.
-->

A step re-executed after a prior failed attempt (most commonly via self-healing's `recoverReviewTasksWithFailedPreMergeSteps` recovery sweep) preserves that prior attempt's `output`/`notes`/`verdict`/timestamps in a bounded `priorAttempts` array on the surviving entry, rather than losing them. This history is read-only — it never affects merge-blocking, recovery selection, or progress computation — and is surfaced in the task-detail Summary tab as a collapsed "previous failed attempts" disclosure when present.

The persisted `status` values are `pending`, `passed`, `failed`, `advisory_failure`, and `skipped`. The verdict→status mapping is: `APPROVE` / `APPROVE_WITH_NOTES` → `passed`; an advisory `REVISE` (success outcome) → `advisory_failure` (non-blocking); a gate `REVISE` or hard failure → `failed`. The UI derives an additional **`running`** display state from a `pending` entry that has a `startedAt` and no `completedAt`. Advisory failures (`advisory_failure`) are shown as polish feedback and never block merge; only `failed` blocks.

Workflow status is visible in multiple places:

- **Task cards**: gate checks are shown after normal implementation steps in the step list; each workflow row uses the compact `workflow` badge label (while still retaining pre/post-merge styling semantics) and progress counts include both implementation and workflow checks
- **List view (desktop + mobile)**: progress labels/bars use the same unified step model as task cards
- **Task detail modal**: includes a **Workflow** tab when workflow data exists

In the Workflow tab, you can inspect:

- pending/running/passed/advisory_failure/failed/skipped status
- outputs/findings
- timing metadata

### Output Rendering

Workflow step outputs support both markdown rendering and plain text modes:

- **Markdown mode** (default): Renders output with proper markdown formatting including tables, code blocks, lists, and GFM extensions (task lists, strikethrough, etc.)
- **Plain mode**: Shows raw text without markdown interpretation

Toggle between modes using the "Markdown"/"Plain" button that appears when an output is expanded.

### Expanded Output Viewer

For long outputs, click the expand icon (maximize) to open a larger viewer modal. The expanded view:

- Displays the full output in a modal overlay
- Supports the same markdown/plain toggle as the inline view
- Closes via the X button, backdrop click, or Escape key
- Syncs with the current render mode of the step

This makes it easier to read structured markdown output and long logs.

### Prompt-mode Structured Verdict Contract

Prompt-mode workflow agents should emit a trailing JSON object:

`{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`

- `verdict` and non-empty human-readable text are persisted on `WorkflowStepResult`; surrounding reviewer prose or finding titles are recovered before one bounded same-session note request is attempted. If the request remains empty, fails, or times out, deterministic engine narration states the verdict and the fixed failure reason without fabricating reviewer rationale. Repair attempts emit bounded `task:review-notes-repaired` telemetry.
- Script-mode steps have no live session for note repair; workspace script reviews use deterministic engine narration when they produce no text.
- Backward compatibility remains for legacy prose-only responses via heuristic fallback (`REQUEST REVISION` and approval keywords).
- If neither structured JSON nor fallback prose can be interpreted, output is recorded as `malformed` (no inferable verdict). Malformed blocking gates fail closed; advisory gates record `advisory_failure` without blocking.

## Workflow Graph Executor

Workflow graph execution is the task lifecycle runtime. `TaskExecutor` pins `workflowGraphExecutor` for the run and unselected tasks resolve to `builtin:coding`.

Default node dispatch:
- `prompt` / `script` nodes with `config.seam` dispatch through workflow runtime primitives (`planning`, `execute`, `review`, `merge`, `schedule`, `step-execute`). The legacy `workflow-step` seam/primitive was removed in FN-7039 — quality gates are graph nodes now, and an IR node still declaring `config.seam: "workflow-step"` fails loudly rather than silently skipping.
- `optional-group` nodes run their template subgraph once when enabled for the task (per `enabledWorkflowSteps` plus workflow-authored `defaultOn`) and pass through when disabled; the executor records the outcome onto `task.workflowStepResults`
- `step-review`, `parse-steps`, `code`, `notify`, and PR nodes use their dedicated primitive/dependency adapters
- `gate` nodes evaluate context-key expectations or run configured executable checks

Traversal semantics:
- edge with no condition or `success` routes on success
- `failure` routes on failure
- `outcome:<value>` routes when the node result value matches exactly
- unsupported conditions throw `WorkflowIrError`
- per-node retries are bounded and deterministic
- terminal success requires every workflow-declared task-document artifact key (`ir.artifacts[].key`) to exist. No-artifact workflows keep the implicit `PROMPT.md` parse-step default and do not require a task document.

Coverage includes lifecycle ordering, primitive invocation, merge/file-scope failure routing, and downstream halt behavior for hard-cancel/recovery style failures.

### Workflow-native Cutover

`TaskExecutor.execute()` gives graph routing first claim. The graph runtime resolves a workflow selection, using `builtin:coding` for unselected/default tasks, failing closed for missing explicit custom workflows, and parking interpreter failures as workflow failures instead of re-running the old imperative lifecycle.

Authoritative node execution uses `WorkflowRuntimePrimitives`. The built-in coding workflow includes explicit planning and pre-merge gate nodes (as `optional-group` nodes such as `browser-verification`) before review/merge.

Reliability invariants preserved under authoritative mode:
- file-scope enforcement including `FileScopeViolationError`
- squash/file-scope overlap enforcement via `assertSquashOverlapsFileScope`
- `autoMerge: false` terminal-until-merged behavior in `in-review`
- `moveTask(in-progress → todo)` hard-cancel semantics without stray `userPaused` rebounds
- existing self-healing routing and fail-soft fallback behavior

The interaction backstop lives in `packages/engine/src/__tests__/reliability-interactions/workflow-interpreter-cutover.test.ts`.

## Workflow Step APIs

<!--
FNXC:WorkflowStepCRUD 2026-06-26-15:00:
FN-7039 (U5/U6) DELETED the workflow-step CRUD REST surface: `GET/POST/PATCH/DELETE /api/workflow-steps`, `/api/workflow-steps/:id/refine`, `/api/workflow-step-templates/:id/create`, and the `migrateLegacyWorkflowSteps` route are gone (the `workflow_steps` table was dropped in migration 131). Only the plugin-template palette endpoints remain. Do not re-document the removed routes as live.
-->

The legacy workflow-step CRUD routes were removed — quality gates are graph nodes authored in the [Workflow Editor](./workflow-editor.md), not REST-managed records. Only the plugin-contributed palette endpoints remain:

| Endpoint | Purpose |
|---|---|
| `GET /api/workflow-step-templates` | List plugin-contributed step templates (the editor's optional-group palette); the built-in catalog was removed, so this serves plugin templates only |
| `GET /api/plugin-workflow-step-templates` | Same plugin templates with full palette metadata (plugin attribution) |

Per-task gate enablement is not a REST CRUD surface: it is the `enabledWorkflowSteps` array on the task (optional-group node ids), set at create time and via task update.

## Workflow Settings

Workflows can declare **typed settings** in their IR — the same authoring pattern as
custom task fields, one level up. A setting declaration carries `{ id, name, type,
default?, options?, description? }` with the type whitelist `string | text | number |
boolean | enum | multi-enum`. Declarations are validated at save (unique ids, type
whitelist, options only for enum kinds, default validates against its own type).

Setting **values** persist per `(workflowId, projectId)` in a dedicated value table,
separate from the declarations: built-in workflows declare settings but their
declarations are non-editable, while their *values* are writable per project. The
engine resolves *effective settings* per task as `stored value ?? declaration
default`, dropping any stored value that no longer validates against the current
declaration (drop-on-orphan) and falling back to the default.

The **step-execution**, **review/approval**, **per-phase model-lane**,
**triage/spec policy**, and **planner oversight** knobs are workflow settings
declared by `builtin:coding`. Large tasks remain one task with a complete plan;
triage does not fan them out. Planner oversight uses `plannerOversightLevel`
(default `autonomous`) with `off`, `observe`, `steer`, and `autonomous` values —
full steering/control is ON for every workflow unless explicitly changed. Tasks
may set a nullable `Task.plannerOversightLevel` override that wins over the
workflow value when present; `resolveEffectivePlannerOversightLevel` in
`@fusion/core` resolves the effective level as task override → workflow
effective value → `autonomous`. The overseer runtime/monitoring behavior that
acts on this level is still follow-up work (FN-7511+). See
[Settings Reference → Workflow Settings](./settings-reference.md#workflow-settings)
for the full moved-key catalog, the editor walkthrough, and the export/sync posture.

Authoring surfaces:

- **Workflow editor → Settings panel** — Definitions (declarations/defaults) and
  Values (per-project) tabs.
- **Agent tools** — `fn_workflow_create`/`fn_workflow_update` accept `settings`
  declarations; `fn_workflow_settings` reads/writes values.

## Screenshot

![Workflow quality-gate results](./screenshots/workflow-steps.png)

See also: [Task Management](./task-management.md) and [Settings Reference](./settings-reference.md).

## Best-effort Feature-Video Review Artifacts

When the project or task-level [`reviewArtifacts`](./settings-reference.md) policy permits a completed task, the executor attempts a short feature-video immediately before its clean handoff to review. It is an optional deliverable: browser discovery, navigation, recording, and artifact-registration failures are logged and never block completion or review handoff.

The MVP requires a persisted `review-artifact-scenario` task document containing JSON such as `{ "baseUrl": "http://127.0.0.1:5173", "targetRoute": "/settings" }`. The URL must be `http` or `https` on `127.0.0.1`, `localhost`, or `::1`; missing, malformed, remote, or unreachable scenarios are skipped. Fusion does not start or manage this server. An optional `flowScript` identifier is accepted for future registered flows; unknown identifiers use the default navigate-and-settle recording.

Capture uses local Chromium through `playwright-core` and records WebM. Recording is capped at 15 seconds (normally three seconds); output over the size cap is rejected without artifact registration rather than trimmed or re-encoded. A successful recording is registered through the normal artifact registry as `type="video"`, `mimeType="video/webm"`, and linked to its task, so existing review-artifact galleries display it. When review artifacts are enabled, executor-generated verification videos also appear in the top-level Quality hub.

## Direct-review kind for custom nodes

A top-level `prompt`, `gate`, `script`, or `optional-group` node may set `config.reviewKind` to exactly `"plan"` or `"code"`. This is an explicit metadata declaration for the direct Review tab; it does not change routing, gate mode, retries, merge blocking, or execution behavior. For example:

```json
{ "id": "architecture-review", "kind": "prompt", "config": { "name": "Architecture review", "reviewKind": "code", "prompt": "Review the proposed architecture." } }
```

When a marked supported node runs, its pending and terminal workflow-step result snapshots the declared value. Review-kind prompt and declared `reviewKind` script output may end with one JSON object containing `verdict`, `notes`, `findings`, and optional `supersededFindingIds`. Each finding has a stable `id`, actionable `title` and `body`, optional `filePath`, positive `line`, severity, and optional resolution: `resolved-in-review` is a self-fixed receipt and `superseded` is a re-verified stale finding. Absent resolution means open; explicit `open` and invalid resolutions are dropped while the finding remains. Fusion trims and bounds strings, drops malformed entries, and suffixes duplicate IDs; it never splits Markdown prose into findings.

Review prompts list earlier open finding IDs. A later reviewer may claim only those IDs in `supersededFindingIds`; the audit-only list is carried on `WorkflowStepResult` and applied to earlier persisted findings at the engine result sink. This works for prompt and declared review scripts, while unmarked scripts cannot emit review metadata. Supersession is always an explicit reviewer claim: Fusion never infers it from commit timestamps.

Findings persist through both ordinary-node and optional-group result writers in the existing JSONB result. A retry moves the replaced result (including its findings) into bounded single-level `priorAttempts`; only current findings are actionable. Findings do not alter verdict parsing, merge blocking, recovery, or retry routing. Open findings continue through the severity gate and advisory/remediation paths; resolved receipts are excluded from those actionable paths without rewriting an explicit `REVISE` verdict. A row without findings keeps its one prose/notes fallback item. Omission means the node is **not** a direct review, regardless of its ID, label, verdict, output prose, phase, or gate mode. Markers are rejected on foreach and loop templates and optional-group source/template nodes: those executions do not yet have an instance-safe current-result or Review-tab address contract.

## Durable workflow principals

Only session-launching nodes acquire a workflow principal: planning prompts use `triage`; implementation, remediation, script/CLI-agent and completion prompts use `executor`; `step-review` and review prompts use `reviewer`; merge prompts use `merger`. Control and lifecycle nodes, including start/end, hold, split/join, containers, parse-steps, notifications, asks, gates, and `review-handoff`, have no principal.

A review node may persist `reviewerAgentId` in its IR. It is exact-node scoped and may name any permanent agent. Resolution is reviewer override (review only), column binding, then a matching role pool. Execute nodes additionally prefer the durable task owner when it remains an eligible executor. Claimed `workflow_work_items` persist principal, role, authority kind, and node-instance fence. Named unavailable principals hold closed; pool exhaustion is reported separately.

## Intake executor ownership

Task creation resolves ownership once at the shared pre-insert boundary used by ordinary and reserved-ID creates. A durable owner must be a non-ephemeral, runtime-enabled executor not paused or errored and permitted by implementation assignment policy. A valid explicit owner wins; otherwise the first reachable execute-node column binding is used, then the deterministic executor pool. Planning and review principals remain work-item-scoped and never rewrite this owner.

`workflowId: null` disables workflow-step materialization only: it still resolves from the executor pool. The only internal exemption is an options-bag reason for terminal, historical, or fixture creation; no HTTP/tool/CLI payload can set it. Resolution outcomes are distinct: `selected` persists an owner; internal `exempt` deliberately persists null; `rejected` fails before insertion; and `unowned` succeeds only when no eligible executor exists, emitting `task:intake-owner-unresolved` for ordinary later assignment.

### Board visibility of pre-release Plan Review

Board hold-lane payloads can expose a transient `releaseGate` verdict. It makes the resolved pre-release Plan Review node, its column/default-on state, and a capacity-boundary continuation observable to Promote controls without duplicating workflow-gate rules in the browser.

## Foreach merge admission

A workflow whose `foreach` template contains `step-execute` may use terminal live task-step coverage as merge implementation proof when it expects at least one instance. Every expected instance must map to a `done` or `skipped` live step. This supports Review Level 0, which intentionally disables optional node-result groups. Zero expected instances still require a relevant `source:"node"` pre-merge result, and pending or failed node results remain blocking.

When the merge boundary cannot be proven, Fusion emits the terminal graph value `merge-boundary-unproven` and parks the task as failed with an actionable error. It does not silently retain the task in the review lane or repeat the same boundary check through bounded auto-merge retry.

### Workspace Code Review remediation

Workspace Code Review carries repository-specific outcomes. Structured findings are repository-qualified (including their identifiers and file paths), retained on the aggregate review result, and persisted on the workflow step result so named-remediation workflows can turn a REVISE into explicit fix work. Remediation gate identity is structural: `reviewKind: "code"` identifies Code Review even when a custom workflow uses a different node id, and `workflowAction: "deterministic-verification"` identifies Verification. A blocking finding inside a confirmed `repositoryScope.repositories` entry is remediable even when its file is not yet in PROMPT.md File Scope; accepting the finding appends a named fix step and widens File Scope atomically. A failed review is remediated from the failing repository's acquired worktree without persisting a singular workspace-root worktree. The convergence ladder's stage-two arbiter reads that same failing repository checkout and uses it for an upheld-review bounce. Repeated unchanged or exhausted automatic review input is recorded and released as non-blocking rather than creating an engine-authored human hold; landing still requires current approval evidence for every modified scoped repository. Scope changes clear both approval evidence and the remediation target atomically, while a current-scope APPROVE clears its matching target before graph completion. Every refusal to schedule remediation is recorded on the card with the failed step, concrete cause, and available retry or privileged-bypass remedy.

### Workspace Code Review seal

For workspace tasks, Code Review is the final write-sensitive stage before landing. Completion and other write-capable finalization stages run before it. A missing or stale workspace approval returns the task to Code Review (`workspace-review-required`) so a new current-scope approval is produced before merge.

## Review convergence

Automatic remediation retains a failed review as a non-blocking `skipped` carrier. The carrier stores the failed verdict, findings, and bounded prior-attempt ledger, but never bypass metadata, so it cannot satisfy a review gate by itself. This applies to remediation bounces, graph-failure resumes, and remediation-owned replans; explicit operator retry remains a clean slate.

Each review result records the commit that the reviewer inspected. On the next same-gate Code Review, Fusion compares that anchor with the current commit and presents an explicit changed-since summary with the commit count, bounded changed-file list, and diff stat. If no commits landed, the prompt states that the tree is frozen and directs the reviewer to maintain prior findings by ID or approve. Legacy results without an anchor, unavailable Git evidence, and workspace multi-repository reviews omit this singular-worktree summary rather than inventing progress.

The next reviewer also receives the same-gate attempt history and open findings. An implementer may call `fn_review_dispute(findingId, rationale)`: this records a contested-but-open annotation, so the finding remains blocking and visible. The reviewer must supersede it or rebut it with `rebutsDisputedFindingId`; only a terminal same-gate verdict that does neither marks it `dispute-upheld`.

Repeated unchanged review input routes through the shared convergence ladder. Its model notch checks the dedicated review-convergence target first and the configured execution fallback lane second, taking the first complete model pair that differs from the task's effective execution model. A configured but identical dedicated target is discarded instead of blocking a distinct fallback. If neither candidate is distinct, Fusion advances directly to arbitration without dispatching another identical remediation round. Budget exhaustion and the Plan Review cap retain their existing stage-one lifecycle actions because they do not prove a frozen tree. Arbitration may release only its exact fenced failed gate; it cannot release sibling gates, and a split with binding findings remains blocking.

A provably empty singular Code Review diff is a definite review input. When `noCommitsExpected: true` is already durable, Fusion records a `passed` Code Review result without dispatching a model; the downstream no-op finalizer requires that passed gate and still applies all of its evidence guards. Otherwise an empty-diff `REVISE` is offered to the remediation producer FIRST: a Code Review or Verification gate that can name fix work returns the card to WIP with that work, because a card must never be parked merely for missing fix steps. Only when no producer serves the gate, or when the producer genuinely declines, does the empty-diff close run — and for those gates it keeps its original position ahead of every revision-budget refusal, including zero and invalid budgets. The close still compare-and-sets the exact failed attempt, so a concurrent approval, operator bypass, supersession, remediation archive, pause, delete, or hold wins the race.

## Review-gated coding

`builtin:review-gated-coding` is an opt-in coding workflow. Its task steps contain implementation work only. Verification, Code Review, and Documentation & Delivery run in that order as review-column gates. A failed Verification appends `Fix: Fix failing <label>` remediation steps, while a failed Code Review appends `Fix: <finding title>` remediation steps to the end of the task list. Their durable `remediation` provenance records the gate, finding, affected file, and wave; for Code Review, `remediation.detail` retains the finding body. Step names are never used to classify remediation.

Review-to-fix remediation waves are unbounded while actionable evidence changes. Missing actionable findings, out-of-scope findings, duplicate-only open remediation, unchanged Code Review input, and unchanged normalized Verification measurements are recorded on the card and released as non-blocking rather than returning the task to implementation without work or creating an engine-authored human hold. A workflow's authored optional-group `maxRevisions` is the only numeric bound. `parse-steps` uses `preserveRemediationSteps` to stop before replacement writes when live remediation exists, while `implementationOnlySteps` only audits gate-like plan steps and never deletes them.
