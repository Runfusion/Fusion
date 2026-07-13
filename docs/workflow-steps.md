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

Fusion workflows define the task lifecycle policy that moves work from an idea to delivery. The default coding path is **Plan/Triage → Execute → graph-native optional gates → Review → Merge**, but that path is now represented as a workflow selection rather than only as fixed engine behavior. A task with no explicit workflow resolves to `builtin:coding`; an explicit missing/corrupt custom workflow fails closed instead of silently falling back.

### Selecting workflows

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
| Create/planning forwarding | Quick-create task creation, Planning Mode, Subtask Breakdown, and the New Task dialog forward the active real workflow id when creating tasks; **All workflows** quick-create chooses a real workflow intake/default column instead of saving a synthetic aggregate id. | [Dashboard Guide → Planning Mode](./dashboard-guide.md#planning-mode). |
| Manual-intake column parking | Dashboard create surfaces never send an explicit `column`; the store resolves the landing column from the (selected or project-default) workflow's intake column. A workflow whose intake column sets `autoTriage: false` (e.g. built-in Coding (Ideas)'s `ideas` column) parks new cards there instead of auto-planning them, until an operator promotes the card. The full lifecycle — create → parked → operator "Start" promotion → poll-time todo-discovery of the still-unplanned (bootstrap-stub) card — is regression-tested at the engine (triage poll ordering/discovery), UI (`TaskCard` Start affordance), and store (create → `moveTask` promotion) layers (FN-7596). | [Dashboard Guide → Create/Planning Forwarding](./dashboard-guide.md#planning-mode). |

### Skill-backed workflow steps

<!--
FNXC:WorkflowSteps 2026-06-27-17:05:
FN-7145 locks the execution invariant for skill-backed workflow nodes: naming a skill must load the skill into the step session, not only mention it in prompt text. The engine passes both namespaced and bare request forms plus the injected Compound Engineering discovery path so bundled `SKILL.md` files are discoverable, and logs a loud warning when that path is missing.
-->

Skill-backed prompt/gate nodes run through the same workflow-step session builder as other prompt nodes, but their `skillName` is also treated as a resource-loading request. At execution time Fusion merges both the namespaced form (for example `compound-engineering:ce-work`) and the bare form (`ce-work`) into `requestedSkillNames`, then threads the injected `FUSION_CE_SKILLS_DIR` value as `additionalSkillPaths` so the bundled `SKILL.md` can be discovered. If a step names a skill but `FUSION_CE_SKILLS_DIR` is absent, the executor logs a `[skill-load]` warning instead of silently presenting only prompt text while falling back to role skills.

### Custom workflow authoring

Use the dashboard [Workflow Editor](./workflow-editor.md) to inspect built-ins, tune built-in prompts, duplicate workflows, or author custom workflows. Custom workflows can declare graph nodes and edges, columns/traits, task fields, typed workflow settings, model lanes, optional workflow-step templates, and author-time validation. Use this page for runtime semantics; use the editor guide for the visual authoring surface.

<!--
FNXC:Workflows 2026-06-28-09:50:
Pure-v1 custom graphs remain rollback-compatible by upgrading to trait-less default columns. Capacity dispatch after the workflow-columns cutover is therefore an explicit v2 authoring requirement, not an implicit v1 upgrade side effect.
-->

#### Capacity dispatch for custom workflows

After the workflow-columns cutover, the only automatic queued-work dispatcher is the engine's hold/release sweep. It releases a task from `todo` only when that column resolves as a `hold` column and its hold config uses `release: "capacity"`; it then moves the card to the nearest downstream `wip` column with available capacity.

**Unplanned/intake cards never release into a processing column (FN-7648).** The sweep (and the explicit `promoteHeldTask`/`releaseHeldTaskByEvent` releases) refuses to move a card into a `countsTowardWip` column while it is still unplanned: `status === "planning"`, its PROMPT.md is still the bootstrap stub, or it currently rests in a column carrying the `intake` trait. This is trait-based, not keyed on the literal `"todo"` id, so a custom workflow whose intake column is renamed (`ideas`, `Inbox`, ...) is covered the same way as the default workflow's `triage`/"Planning" column. See `docs/architecture.md` § "Workflow-defined columns & traits" → "Execution-entry invariant" for the implementation detail.

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

If the Plan Review reviewer is unavailable before producing a verdict, the task stays in triage as `status: "plan-review-unavailable"` with a short backoff. That retry state is not a replan: Fusion rereads the existing non-empty `PROMPT.md`, preserves it unchanged, and reruns only Plan Review/finalization while holding a global agent concurrency slot for the reviewer lane. A reviewer revision verdict moves the task to `needs-replan`; missing/empty/invalid prompt content fails clearly instead of restarting the planner.

Workflow Plan Review is separate from manual plan approval. Project `planApprovalMode: "auto-approve-all"` bypasses only the final manual `awaiting-approval` plan gate after the plan is specified and any enabled Plan Review passes; it does not disable Plan Review or other explicit safety gates.

**FN-7559 (superseded by FN-7732) — telling the holds apart:** Plan Review parks a task with its own distinct statuses (`needs-replan` for a revision verdict, `plan-review-unavailable` for a reviewer-outage retry), so it never renders identically to a plan-approval hold. A separate triage release-authorization gate used to also use `status: "awaiting-approval"` with a distinct `awaitingApprovalReason: "release-authorization"` discriminator and its own dashboard label; that gate was removed (it over-fired on AI-authored specs that merely mentioned release tooling — see `b5b0458`, FN-7732). Releases are kept out of Fusion by agent instruction instead (AGENTS.md → "Releasing"), not by an engine/UI gate. The `Task.awaitingApprovalReason` field and its `"release-authorization"` value are kept only so legacy rows deserialize; any task that still carries the legacy value now renders as an ordinary manual plan-approval hold.

**FN-7569 — manual plan approval is idempotent against unchanged plans:** approving a plan under the manual gate records a fingerprint of the exact approved `PROMPT.md`. If the same task is later re-specified — a `needs-replan` replan, a Plan Review reviewer-outage retry, or a self-healing rebound back to `triage` — and produces byte-identical `PROMPT.md` content, the manual gate detects the match and proceeds straight to `todo` instead of re-parking at `status: "awaiting-approval"`. A genuinely revised plan still produces a different fingerprint and re-asks as before, and using Reject Plan clears the fingerprint so the regenerated plan is always treated as new. This idempotency check runs only inside the manual gate, strictly after Plan Review has already made its independent decision, and never applies under `planApprovalMode: "auto-approve-all"` (which bypasses the manual gate entirely).

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

Parallelism is opt-in *per step by the planner*, not asserted by the workflow author. A step depends on the previous step unless its PROMPT.md heading carries a `(depends: N,M)` annotation listing the 1-indexed steps it actually depends on — e.g. `### Step 3 (depends: 1): Title`. An explicit empty list (`### Step 3 (depends:): Title` or `json-steps` `"depends": []`) means the step has no dependencies and can be scheduled as an independent root. An absent annotation/key is different: it remains the legacy previous-step dependency, so an unannotated plan is fully sequential regardless of `mode`. Annotate **conservatively**: only mark a step independent when it genuinely does not read or modify the prior step's output, or heavily-overlapping "independent" steps will loop integrate→conflict→rework until the budget exhausts.

#### `step-review` node & rework edges

`step-review` (`{ type: "plan" | "code", model? }`, legal only inside a foreach template) runs the reviewer against the current instance's step and maps the verdict to outcome edges: `outcome:approve` (marks the step done), `outcome:revise` (typically a rework edge — revise in place, no reset), `outcome:rethink` (a rework edge whose traversal first triggers reset-to-baseline: git reset + session rewind + step→pending), `outcome:unavailable` (bounded retry then route). The validator requires `approve` and `revise` routed; `rethink` defaults to the revise target with reset semantics. Verdict authority is single-writer — review nodes inside `split` branches are advisory-only.

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

Each turn, the user is asked to refine; once they reply "looks good" (or whatever the condition matches), the exit-gate routes the task out of the brainstorm loop. This composition is also available as a discoverable built-in: `builtin:brainstorming` (FN-7584) registers exactly this shape — `ask-user` → a refine prompt step → `exit-gate`-on-approval — ahead of the unmodified default Coding plan/execute/review/merge spine, selectable directly from the workflow picker. Copy the shape into a custom workflow's IR via `fn_workflow_create`/`fn_workflow_update` when you need a different downstream pipeline than the standard coding one.

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

Optional quality gates are authored directly in the workflow graph as `optional-group` **nodes**. An `optional-group` node is a container (mirroring `foreach`/`loop`) whose `template` subgraph the executor runs **once** when the group is enabled for the task, and passes through (skips) when disabled. There is no iteration and no rework budget — a single pass — and rework edges inside the template are rejected by `validateOptionalGroup`.

Node config (`WorkflowOptionalGroupConfig`): `{ name?, defaultOn?, maxRevisions?: number | "unbounded", phase?: "pre-merge" | "post-merge", template: { nodes, edges } }`.

- `defaultOn` contributes to the runtime/display effective enable set only when the task has no persisted `enabledWorkflowSteps` array; operators can still toggle persisted selections when creating or editing tasks.
- `maxRevisions` optionally overrides the workflow/project `maxPostReviewFixes` budget for this one optional group's pre-merge fix → re-review loop. Use a non-negative integer for a bounded number of automatic fix passes, `0` to disable automatic fixes for that step, or `"unbounded"` to keep cycling until the step returns `APPROVE` / `APPROVE_WITH_NOTES`. When omitted, generic optional gates keep the global `maxPostReviewFixes` behavior; built-in `plan-review` and `code-review` instead default to unbounded remediation unless a workflow setting value caps them.
- `phase` defaults to `"pre-merge"` (the prior, only behavior). `"post-merge"` marks a group the executor runs after a successful merge (see [Execution Phases](#execution-phases)).
- Persisted enable state lives on the per-task `enabledWorkflowSteps` array, keyed by the **group node id** (for example `browser-verification`, `code-review`). For execution, Fusion treats a group as enabled when `enabledWorkflowSteps` is present and includes the group id; if the field is omitted, Fusion falls back to the workflow node's `defaultOn: true`. An explicit empty array disables every optional group and prevents default-on gates from reappearing.

Built-in optional gates ship as inlined IR builders, not as a template catalog:

- `builtin:coding` carries the `browser-verification` optional-group node (`builtin-browser-verification-group.ts`), default-off, so browser verification runs only for tasks whose `enabledWorkflowSteps` includes `browser-verification`.
- `builtin:coding` and `builtin:stepwise-coding` carry the `plan-review` optional-group node (`builtin-plan-review-group.ts`), default-on, before `parse-steps` so the plan can be reviewed before execution begins even when a task has not persisted explicit optional-step ids.
- The `code-review` optional-group node (`builtin-code-review-group.ts`) is the inlined default-on code-review gate. On default `builtin:coding`, this is the only final review surface before merge; it is effective by default even when no explicit optional-step ids are stored. On `builtin:stepwise-coding`, it remains a post-foreach optional final review gate before the workflow's final review seam.
- Plan Review/spec revision and Code Review remediation loops are unbounded by default for built-in workflows, including Compound Engineering's CE Code Review path. Operators can cap them per workflow from the Workflow Editor **Settings → Values** tab with `planReviewMaxRevisions` and `codeReviewMaxRevisions`; leaving the value empty means unbounded, a non-negative integer caps automatic revisions, and `0` disables automatic revision for that review path. These values are editable for read-only built-ins without duplicating the workflow.
- A workflow (for example compound-engineering) can add a **post-merge** optional-group node via the generic `postMergeOptionalGroupNode(...)` builder (`builtin-post-merge-group.ts`) — e.g. a `document` step that runs after merge.

Create-time optional-step controls appear in the quick-add action row and the **New Task** dialog inline quick buttons for the active workflow. They resolve the workflow's optional-group nodes (plus plugin-contributed palette templates, see [Plugin-Contributed Steps](#plugin-contributed-steps)) into toggleable rows. Selecting **Fast** clears currently enabled optional steps and submits `enabledWorkflowSteps: []` even if optional-step metadata is still loading, but the dropdown stays available once loaded; any manual reselection before create is submitted as explicit ids and executes even on the Fast task. Workflows with no optional groups render no trigger and omit `enabledWorkflowSteps` unless the operator selects Fast, where the explicit empty array preserves the speed-first opt-out. Unknown or removed ids are skipped during resolution so stale selections never render blank controls or break workflow loading.

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

> **Note on Fast Mode:** When a task has `executionMode: "fast"`, omitted/default optional groups are bypassed for speed and top-level custom pre-merge prompt/script/gate validation nodes are skipped. Explicitly selected optional groups still run their template prompt/script/gate nodes, so a Fast task with `enabledWorkflowSteps: ["browser-verification"]` runs Browser Verification. Post-merge steps remain active and run normally (post-merge is unaffected by execution mode).

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
FNXC:WorkflowModelBinding 2026-07-10-00:00:
FN-7771 lets workflow authors bind reasoning effort per session-running node, independently from provider/model. FN-7772 adds workflow-declared primary lane thinking companions, but node-level thinking remains strongest so a custom workflow can pin a high-effort review or low-effort execution seam without changing task-wide or lane defaults.
-->

A prompt-mode gate node can set its own model with:

- `modelProvider`
- `modelId`
- `thinkingLevel` (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`)

If both model fields are set, node execution uses that provider/model pair; otherwise it falls back to default model selection. `thinkingLevel` is stored as `config.thinkingLevel` and can be set or cleared independently from the model pair. Runtime reasoning-effort precedence is **node/step `thinkingLevel` → task `thinkingLevel` → workflow lane thinking override (`executionThinkingLevel`, `planningThinkingLevel`, or `validatorThinkingLevel`) → global lane thinking override → project default thinking override → global `defaultThinkingLevel`**. The lane settings accept `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`; unset means inherit. This applies to prompt/gate custom nodes, the `execute` and `step-execute` seams, triage/planning, and `step-review` reviewer sessions. Dashboard node summaries show unpinned provider/model state as **Default model**; the inspector's inline thinking selector shows the resolved project default (e.g. "Default (off)") when no node-level thinking value is pinned.

## Default-On Behavior for New Tasks

`optional-group` nodes support `defaultOn`.

When `defaultOn: true`, the gate is effectively enabled for execution and in-progress display even if the task's persisted `enabledWorkflowSteps` array is empty. Creation and edit controls still use the persisted selection as their source of truth, so operators can distinguish an explicit stored toggle from a workflow-authored default.

## Workflow Step Revision Loop

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
- `notes` is optional and defaults to `""` when missing or non-string.
- The parser checks fenced and inline JSON candidates, and the **last valid candidate wins**.

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

Legacy prose is still supported when structured JSON is missing:

- Output beginning with `REQUEST REVISION` (case-insensitive) maps to `REVISE`.
  - Remaining prose becomes `notes`.
  - If nothing follows, notes default to `"Revision requested"`.
- Output containing one of these phrases maps to `APPROVE` with empty notes: `approve`, `approved`, `looks good`, `no issues`, `out of scope`.

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
{"verdict":"APPROVE","notes":""}
{"verdict":"APPROVE_WITH_NOTES","notes":"Optional non-blocking feedback"}
```

Legacy fallback (still supported via prose inference):

```
REQUEST REVISION

[Clear, actionable description of what needs to be fixed]
```

The revision block replaces any prior revision instructions (no accumulation).

By default this split-and-fork behavior is enabled through the project setting `workflowRevisionForkOnScopeMismatch`. Set it to `false` to restore the legacy behavior that appends all workflow revision feedback to the original task even when it references files outside the declared File Scope.

### End-of-step file-scope invariant for prompt pre-merge steps (FN-4343)

<!--
FNXC:WorkflowScopeLeak 2026-06-26-15:00:
KNOWN FOLLOW-UP: the FN-4343 per-step end-of-step scope-leak invariant (and its `workflowStepScopeEnforcement` setting) has NOT yet been replicated on the graph-native optional-group execution path. The setting is still declared and round-trips, but the graph executor does not run the per-step invariant. Merge-time File Scope enforcement (`FileScopeViolationError`, squash overlap) is a separate gate and is unaffected.
-->

> **Known follow-up (not yet on the graph path):** The original FN-4343 per-step invariant ran after each successful prompt-mode pre-merge workflow step under the legacy `runWorkflowSteps` loop. That loop was deleted in the graph-native cutover, and this per-step invariant has **not yet been replicated** on the optional-group graph path. The `workflowStepScopeEnforcement` setting (`"block"` / `"warn"` / `"off"`, default `"block"`) is still declared and round-trips, but the graph executor does not currently enforce it per step. Merge-time File Scope enforcement (`FileScopeViolationError` and squash/file-scope overlap) is a separate gate and is **unaffected** — off-scope writes are still caught at merge.

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

- **Revision requested**: Implementation needs changes → routes back to executor in-place while keeping the task in `in-progress`
- **Hard failure**: Treated as remediable until retries are exhausted; the executor injects feedback and sends the task through `todo → in-progress` for a fresh remediation pass

#### Pre-merge hard failure remediation flow

For pre-merge gate hard failures, the graph executor drives remediation through the executor primitives (gate-mode nodes):

1. Retry the failing check up to `MAX_WORKFLOW_STEP_RETRIES` within the same execution lifecycle
2. On retry exhaustion, add a steering comment with failure details and inject a `Workflow Step Failure` section into `PROMPT.md`
3. Reopen the terminal verification/delivery suffix plus the nearest preceding implementation step (`pending`) so the resumed pass can address feedback without discarding unrelated completed work
4. Schedule `todo → in-progress` after guard unwind, triggering a fresh executor remediation run that must complete every reopened step before the workflow step re-evaluates

Tasks are not parked in `in-review` for this remediable path unless additional terminal failures occur.

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

If a task is found in `in-review` with failed pre-merge workflow results and no active executor, self-healing can auto-revive it by replaying the same remediation send-back flow. Generic optional gates use the resolved workflow/project budget; built-in Plan Review and Code Review are unbounded unless the workflow settings or node config explicitly set a numeric cap.

<!--
FNXC:WorkflowOptionalStepFix 2026-06-26-17:05:
Enabled PRE-merge optional-group REVISE findings should be acted on before review/merge when the executor is still in the graph run. The inline path consumes the same `postReviewFixCount` / `maxPostReviewFixes` budget before scheduling `sendTaskBackForFix`; exhausted budgets preserve the older advisory/gate behavior so optional advisory gates remain ultimately non-blocking.

FNXC:WorkflowOptionalStepRevisionBudget 2026-06-27-12:55:
Workflow authors can override the global optional-step remediation budget per optional-group via `maxRevisions`, including `"unbounded"` for loops that should continue until the step approves. Document both inline executor and self-healing semantics because they must resolve the same budget for parked review recovery.

FNXC:WorkflowOptionalStepFix 2026-06-27-22:51:
A post-verdict bounce from Code Review or Browser Verification must not reopen only a trivial trailing documentation step. The next executor pass reopens the actionable implementation step plus terminal verification/delivery steps, completes them to `done`, and only then lets the optional group re-evaluate across both in-progress and in-review bounce sources.

FNXC:WorkflowRemediation 2026-07-03-20:10:
Retryable graph failures at explicit remediation nodes (for example `code-review-remediation` returning `remediation-not-scheduled` after restart-local context is gone) should not strand tasks in `in-review` with `status:"failed"`. Live executor handling and self-healing both classify the durable failed pre-merge step result and send the task through the existing remediation bounce, while numeric caps, pauses, missing worktrees, and auto-merge-disabled rows remain operator-actionable.
-->

During a live graph run, an enabled **pre-merge** optional step that returns `REVISE` (including the built-in **Code Review** / `code-review` and **Browser Verification** / `browser-verification` groups) sends the task back to the executor for a fix pass before the graph continues to review or merge. The workflow graph restarts on the next executor pass, re-launches task execution, and reopens the terminal verification/delivery suffix plus the nearest preceding implementation step so the verdict-demanded fix can be made rather than merely replaying a trivial trailing step. The optional step re-runs only after the executor drives those reopened steps back to `done`; the cycle repeats until the step returns `APPROVE` / `APPROVE_WITH_NOTES` or the resolved revision budget is exhausted. Generic optional gates use the workflow/project `maxPostReviewFixes` value (built-in default: 3 fix passes). Built-in Plan Review and Code Review default to `"unbounded"` so they continue until approval unless `planReviewMaxRevisions`, `codeReviewMaxRevisions`, or the node's `config.maxRevisions` sets a numeric cap. The aggregate `postReviewFixCount` remains for dashboard visibility, but budget checks count attempts per workflow-step key so Plan Review, Code Review, and Browser Verification do not consume each other's caps.

The same resolved per-step budget is used by self-healing when it revives an `in-review` task that is parked with a failed pre-merge workflow result. If the failed step's IR cannot be resolved, self-healing falls back to `maxPostReviewFixes` so existing behavior is preserved. `"unbounded"` relies on the optional step eventually approving; a step that always returns `REVISE` will continue cycling until a human intervenes or another guard (pause, worktree/lease, auto-merge policy, dependency blocker) stops recovery. When the budget is exhausted or disabled, behavior falls through to the prior semantics: advisory results remain non-blocking and gate failures remain failed/parked.

Post-merge optional groups never trigger this send-back path because merge has already happened; their failures are recorded/logged as non-blocking post-merge results.

Advisory failures are intentionally excluded from merge blocking and self-healing auto-revive after a task is already in review; their live-run fix pass is only the bounded pre-review remediation described above.

#### Review-lane bypass (operator escape hatch, FN-7720)

Self-healing recovery re-runs the *same* dispatch that produced a failed pre-merge review step. When that step failed for infrastructure reasons rather than a genuine `REVISE` verdict — the leading real-world cause being the `(no feedback captured)` no-verdict dispatch defect (Runfusion/Fusion#1946) — recovery keeps re-running the defective dispatch instead of unblocking the card. For that situation, Fusion exposes a supported, audit-logged **review-lane bypass** primitive so a privileged operator can advance the card without waiting on the underlying engine fix:

- **Store primitive:** `TaskStore.bypassFailedPreMergeReviewStep(id, { reason, actor })` in `@fusion/core`.
- **Dashboard:** `POST /tasks/:id/bypass-review` (requires a body `{ reason }`), and a **Bypass failed review** action in the Task Detail actions menu — shown only when the task is `in-review` and carries a failed pre-merge review step. The operator must type a reason before it fires.
- **CLI / pi extension:** `fn_task_bypass_review` (params: `id`, required `reason`). This tool is registered **only** on the CLI/pi-extension operator surface — it is never exposed to executor, reviewer, or triage agent tool lists, so autonomous task execution cannot self-bypass a review it failed.

**A reason is always mandatory** and every bypass is audit-logged (actor, timestamp, reason, and the prior step status it superseded) via a `task:bypass-review` run-audit event plus a task log entry.

The bypass targets the **most-recently-completed failed pre-merge** `WorkflowStepResult` (any lane — Code Review, Code Review Remediation, Plan Review, Browser Verification) and rewrites it in place: `status` becomes `"skipped"` (a terminal, non-blocking value `getTaskMergeBlocker` does not match), and the result is stamped with `bypassedBy`, `bypassedAt`, `bypassReason`, and `bypassedFromStatus` (the prior `"failed"` status) plus `bypassedFromVerdict` when one was present. **The bypass never fabricates a reviewer `verdict`** (no synthetic `APPROVE`) — it is an honest record that the gate was overridden, not that the change was reviewed and approved.

The bypass clears **only** the `"task has failed pre-merge workflow steps"` merge-blocker reason. It does **not** touch any other `getTaskMergeBlocker` condition: a paused task, incomplete steps, a blocking task status, or a still-`pending` pre-merge step all continue to block exactly as before. It also does not itself move the task to `done` or force a merge — an `autoMerge:false` task remains terminal-until-human-merge after the bypass, same as before (FN-5147). Because the bypassed step's `status` is no longer `"failed"`, self-healing's recovery sweep (`recoverReviewTasksWithFailedPreMergeSteps`) no longer selects it for re-dispatch.

## Viewing Results

<!--
FNXC:WorkflowStepResults 2026-06-26-15:00:
Results now live on `task.workflowStepResults` (written by the graph executor, keyed by optional-group node id). The persisted `status` union is pending/passed/failed/advisory_failure/skipped; the UI derives a `running` display state from a `pending` entry with `startedAt` and no `completedAt`.
-->

Gate results are recorded on the task's **`workflowStepResults`** field (`WorkflowStepResult[]`), written by the graph executor and keyed by the optional-group node id. Each entry carries `status`, optional `verdict`, `notes`, `output`, and `phase`. The unified progress bar and the Workflow tab read this field directly.

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

- `verdict` and `notes` are persisted on `WorkflowStepResult` when present.
- Script-mode steps do not populate these fields.
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
declared by `builtin:coding`. Triage policy includes
`triageProactiveSubtaskSplittingEnabled` (default `true`), which controls
automatic large-task splitting guidance for oversized M/L work. Set it to `false`
in a workflow's Values tab when triage should keep large tasks whole unless the
task explicitly has `breakIntoSubtasks: true`; explicit subtask requests still
follow the mandatory split flow. Planner oversight uses `plannerOversightLevel`
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
