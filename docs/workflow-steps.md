# Workflow Steps

[← Docs index](./README.md)

Workflow steps are reusable quality gates that run around task completion.

## Workflow overview

<!--
FNXC:Docs 2026-06-16-23:25:
Public docs need one concise workflow overview that names the shipped built-ins, explains per-task selection, and points authors to the visual editor while leaving low-level runtime details in this canonical workflow document.
-->

Fusion workflows define the task lifecycle policy that moves work from an idea to delivery. The default coding path is **Plan/Triage → Execute → Workflow steps → Review → Merge**, but that path is now represented as a workflow selection rather than only as fixed engine behavior. A task with no explicit workflow resolves to `builtin:coding`; an explicit missing/corrupt custom workflow fails closed instead of silently falling back.

### Selecting workflows

Operators can select workflows in the dashboard wherever the task or board workflow selector is shown. Agents and automation can discover and assign them with the workflow tools:

- `fn_workflow_list` — list built-in and custom workflow definitions.
- `fn_workflow_select` — assign a workflow to the current or named task.
- `workflow_id` on `fn_task_create` / delegation tools — create a task with a workflow already selected.

Decision-only or investigation tasks can also declare `noCommitsExpected` / `**No commits expected:** true`; the built-in triage policy prefers the Quick fix workflow for that no-commit lane.

### Built-in workflow catalog

| Workflow | ID | Notes |
|---|---|---|
| Coding | `builtin:coding` | Default coding lifecycle and fallback for tasks without an explicit selection. |
| Quick fix | `builtin:quick-fix` | Short path for trivial or no-commit/decision work; omits the standard review stage. |
| Review-heavy | `builtin:review-heavy` | Standard execute/review/merge path with an additional gated security review. |
| Compound engineering | `builtin:compound-engineering` | Plugin-gated workflow that invokes Compound Engineering skills for planning, work, review, PR/feedback, and learnings capture. |
| Stepwise coding | `builtin:stepwise-coding` | Graph-executor workflow that models per-step parse/execute/review/rework explicitly. |
| PR lifecycle | `builtin:pr-workflow` | Reusable PR lifecycle graph fragment (create PR → await review → respond → gate → merge); it is a fragment, not directly selectable as a task workflow. |

### Custom workflow authoring

Use the dashboard [Workflow Editor](./workflow-editor.md) to inspect read-only built-ins, duplicate them, or author custom workflows. Custom workflows can declare graph nodes and edges, columns/traits, task fields, typed workflow settings, model lanes, optional workflow-step templates, and author-time validation. Use this page for runtime semantics; use the editor guide for the visual authoring surface.

## Workflow IR (v1)

Fusion also defines a separate **Workflow Intermediate Representation (IR)** contract in `@fusion/core` for editor↔interpreter graph exchange. This IR is distinct from the post-implementation quality gates documented on this page (`WorkflowStep` templates and execution policies). For the user-facing visual authoring surface, see the [Workflow Editor guide](./workflow-editor.md).

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

The workflow runtime is the authoritative execution path for task lifecycle work. `WorkflowGraphExecutor` owns graph traversal and routing; node handlers call runtime primitives supplied by `TaskExecutor` for side-effecting operations such as planning, coding sessions, review, step execution/reset, merge requests, transitions, and audit.

The engine remains the substrate for scheduler dispatch, routing claims, persistence, concurrency limits, process supervision, storage, and audit plumbing. Lifecycle policy belongs in built-in or custom workflows.

The default built-in catalog entry `builtin:coding` is backed by the canonical `BUILTIN_CODING_WORKFLOW_IR`, which is also the resolver/runtime fallback for tasks with no workflow selection or an explicit default selection. Missing/corrupt explicit custom selections fail closed as workflow-resolution failures instead of silently running the default. The built-in IR encodes the legacy lifecycle path as graph stages, with merge represented by workflow-native policy primitives rather than a single linear merge seam:

- `triage/planning` → `execute` → `workflow-step` → `review` → `merge-gate` / branch-group integration / `merge-attempt` / retry or manual hold → `end`

`builtin:stepwise-coding` is a separate graph variant backed by `BUILTIN_STEPWISE_CODING_WORKFLOW_IR`; it keeps the same lifecycle columns/traits while modeling per-step parse/execute/review/rework as authored graph structure.

During triage/planning sessions, agents can call `fn_workflow_list` to discover available built-in and custom workflows and read their descriptions before routing work. They can call `fn_workflow_select` to select a workflow for the task being specified, or pass `workflow_id` when creating child tasks with `fn_task_create`; decision-only or investigation tasks can also set `noCommitsExpected` / `**No commits expected:** true` when no code changes are expected. The built-in triage thresholds, decision-only verb list, and default routing IDs are workflow-native typed settings resolved from the selected workflow.

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

The `workflowColumns` track introduces **IR v2** (`version: "v2"`), where a workflow additionally defines its own **columns** (`{ id, name, traits: [{ trait, config }] }`), places nodes in columns (`node.column`), and gains `hold`, `split`, and `join` node kinds. Columns become first-class, workflow-defined task state carrying composable **traits** (declarative flags + lifecycle hooks); this generalizes the fixed pipeline + the `gateMode` semantics documented below into per-column trait configuration. v1 graphs still parse and upgrade by synthesizing default-workflow columns. The column/trait model — the trait vocabulary, the substrate/policy line, the transition authority, and the graduation gate — is documented in **`docs/architecture.md` § 9 "Workflow-defined columns & traits"** and the **Concepts** glossary (column, trait, lane, hold node, split/join, default workflow, `transitionPending`). The whole v2 model is gated behind `experimentalFeatures.workflowColumns`; with the flag off, the v1 IR and the quality-gate `WorkflowStep` model below are unchanged.

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

The **step-inversion** track makes task *steps* themselves workflow-modelable. Today the engine owns step policy end-to-end (PROMPT.md parsing, per-step review verdicts, RETHINK/REVISE control flow, merge blocking). Step inversion extracts exactly one new substrate capability — *run one step inside a task's session, and reset one step to its baseline* — and exposes everything else as authored graph structure. It is additive to IR v2 and gated by `experimentalFeatures.workflowGraphExecutor`. The default coding workflow is untouched and byte-identical (it keeps its monolithic `execute` seam and is the parity oracle); inversion is opt-in via custom workflows and a new built-in **stepwise coding workflow**.

#### `parse-steps` node — step list as graph structure

`parse-steps` reads a declared **artifact** and runs a named **parser** to write the canonical step list (`Task.steps[]`). Config: `{ artifact: <key>, parser: "step-headings" | "json-steps" | "plugin:<id>:<parser>" }`.

- Built-in parsers: `step-headings` (the `### Step N:` convention, extracted byte-identically from the legacy regex) and `json-steps` (a `[{ name, depends? }]` JSON document). Plugins register additional parsers under `plugin:<pluginId>:<parserId>`.
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

Parallelism is opt-in *per step by the planner*, not asserted by the workflow author. A step depends on the previous step unless its PROMPT.md heading carries a `(depends: N,M)` annotation listing the 1-indexed steps it actually depends on — e.g. `### Step 3 (depends: 1): Title`. An unannotated plan is fully sequential regardless of `mode`. Annotate **conservatively**: only mark a step independent when it genuinely does not read or modify the prior step's output, or heavily-overlapping "independent" steps will loop integrate→conflict→rework until the budget exhausts.

#### `step-review` node & rework edges

`step-review` (`{ type: "plan" | "code", model? }`, legal only inside a foreach template) runs the reviewer against the current instance's step and maps the verdict to outcome edges: `outcome:approve` (marks the step done), `outcome:revise` (typically a rework edge — revise in place, no reset), `outcome:rethink` (a rework edge whose traversal first triggers reset-to-baseline: git reset + session rewind + step→pending), `outcome:unavailable` (bounded retry then route). The validator requires `approve` and `revise` routed; `rethink` defaults to the revise target with reset semantics. Verdict authority is single-writer — review nodes inside `split` branches are advisory-only.

`rework` edges (`edge.kind: "rework"`) are the **only legal cycles**: a loop-back within one foreach instance, bounded by `maxReworkCycles`. Exhaustion emits `outcome:rework-exhausted` (validator requires it routed — escalation, hold, or failure; defaults to failure). Non-rework cycles still throw.

#### `code` node — sandboxed TypeScript

`code` (`{ source, timeoutMs? }`, default 30s, cap 300s) runs inline TypeScript (compiled with esbuild, executed in a timeout-bounded child process with cwd = the task worktree) for logic no built-in node covers. The script default-exports `async (ctx) => result` where `ctx = { task, steps, customFields, context, artifacts: { read(key) }, instance? }` (`instance` present inside a foreach template). The returned `{ outcome?, value?, contextPatch?, customFields? }` routes `outcome:<value>` edges, merges `contextPatch` into walk context, and writes `customFields` through the validated field authority. It gets **no store handle**, cannot write the step list, and a throw/timeout/non-zero exit becomes an audited `failure`. Source compile errors are rejected at save time (a dashboard 400 listing the failing node ids). It runs at the same trust tier as existing project-local script steps.

#### `notify` node — workflow-authored notifications

`notify` (`{ event, title?, message? }`) dispatches a notification through Fusion's active notification service and then always continues on the normal success path. `event` may be one of the standard notification events (for example `in-review`, `merged`, or `failed`), the built-in workflow-authored event `workflow-notify`, or a provider-specific custom event string. `title` and `message` are optional templates; the engine interpolates `{{taskTitle}}`, `{{taskId}}`, `{{workflowName}}`, and `{{context:key}}` from the workflow walk context.

Notification delivery is intentionally best-effort: a missing/unconfigured notification service, an empty `event`, or a provider delivery failure is logged/audited but does not fail the workflow node. Providers receive the rendered title/message in notification metadata so ntfy and webhook notifications can show workflow-specific copy. `workflow-notify` is **not** part of the default ntfy event allowlist; add it to `ntfyEvents` or the provider `events` filter when you want workflow-authored notifications delivered.

#### Workflow-defined custom task fields

Workflows declare typed task fields via IR `fields: [{ id, name, type, required?, default?, options?, render? }]` (`type ∈ string | text | number | boolean | enum | multi-enum | date | url`; `options` for enum kinds; `render.placement ∈ card | detail | detail-section`, `render.widget`, `render.badge`). Values live in `tasks.customFields` and are validated through a single store authority (`updateTaskCustomFields`) with typed rejections (offending `fieldId` + `code`). Editing or switching a workflow **orphans** (never destroys) values for removed/incompatible fields — orphans are retained and shown under a detail disclosure. The task UI renders the schema dynamically (detail-form widgets by type, up to 3 card badges by placement). Agents read/write fields via `fn_task_update`'s `custom_fields` patch; authors set them via `fn_workflow_create/update`. Field values are surfaced in task/session context.

#### Workflow-declared optional steps

Workflows can advertise optional workflow-step templates with `optionalSteps: [{ templateId, defaultOn? }]`. This IR facet is execution-inert: the graph executor does not run or route on `optionalSteps` directly. Instead, the create and task-detail workflow UIs resolve each `templateId` against built-in and plugin-contributed `WorkflowStepTemplate` metadata, show toggleable rows, and persist the selected template ids through the existing per-task `enabledWorkflowSteps` contract.

`defaultOn` is optional and seeds the UI toggle when a task is created or edited before the task has made its own selection. Unknown or removed template ids are skipped during resolution so stale declarations do not render blank controls or break workflow loading.

The built-in coding workflow (`builtin:coding`) declares `browser-verification` as an optional step. It remains opt-in by default, so browser verification only runs for tasks whose `enabledWorkflowSteps` includes `browser-verification`.

## What They Are

A workflow step is a reusable check (AI prompt or script) that can be enabled on tasks.

Common use cases:

- Documentation review
- QA/test verification
- Security scanning
- Performance checks
- Accessibility checks
- Browser-level verification

## Execution Phases

Workflow steps run in one of two phases:

- **Pre-merge** (default): runs before merge/finalization; failure blocks completion
- **Post-merge**: runs after successful merge; failure is logged but non-blocking

> **Note on Fast Mode:** When a task has `executionMode: "fast"`, pre-merge workflow steps are bypassed entirely during executor completion on both the legacy path and the workflow graph executor path. Custom graph pre-merge prompt/script/gate validation nodes are skipped as the graph equivalent of pre-merge workflow steps. Post-merge workflow steps remain active and run normally (post-merge is merger-owned and unaffected by execution mode).

## Execution Modes

- **Prompt mode**: starts an AI agent for the step
- **Script mode**: runs a named script from project settings (`settings.scripts`)

Prompt mode can run with readonly or coding-capable tool access depending on step/template configuration.

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

Workflow steps also have a `gateMode`:

- **`gate`**: failures block merge/completion and follow normal remediation/retry flows.
- **`advisory`**: failures are recorded as `advisory_failure` and shown as polish feedback, but never block merge.

Defaults:
- all steps → `advisory` (advisory-by-default per FN-4368; opt in to `gate` per step in **Settings → Workflow Steps**).

## Built-In Templates (7)

Fusion ships seven templates:

1. Documentation Review
2. QA Check
3. Security Audit
4. Performance Review
5. Accessibility Check
6. Browser Verification
7. Frontend UX Design

All seven built-in templates emit the structured `{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}` envelope introduced in FN-4367 (final line JSON only). The legacy `REQUEST REVISION` prose path remains as a backward-compatible fallback. See [Prompt-mode Structured Verdict Contract](#prompt-mode-structured-verdict-contract).

The **Browser Verification** template uses browser automation style checks and is designed for UI validation flows.

The **Frontend UX Design** template verifies visual polish and consistency with existing UI patterns and design tokens, including visual hierarchy, spacing/typography consistency, color/token consistency, component reuse, responsive behavior, and fit with existing design language.

> **FN-3906 + FN-4343 auto-skip behavior:** The pre-merge orchestrator auto-skips the built-in `frontend-ux-design` step before pause/defer checks when workflow relevance signals show no frontend/UI scope. It now evaluates both (1) the task diff scope and (2) declared `## File Scope` from `PROMPT.md`. Scope relevance includes extensions (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.html`, `.css`, `.scss`, `.sass`, `.less`, `.styl`), common UI path segments (`/components/`, `/app/components/`, `/dashboard/`, `/frontend/`, `/ui/`, `/styles/`, `/themes/`, `/design-system/`, `/design-tokens/`), and token/theme filenames (`tokens.(ts|js|json|css)`, `theme.(ts|js|json|css)`). If both signals are empty (or capture fails), Fusion preserves legacy behavior and runs the step.

## Plugin-Contributed Steps

Installed plugins can also provide **workflow step templates** that you enable from **Settings → Workflow Steps**, just like Fusion’s built-in quality gates.

Plugin-contributed templates appear in the same workflow-step chooser/UI as built-ins. In that chooser, plugin entries are labeled/grouped as plugin-contributed (including plugin attribution in the template metadata) so you can distinguish them from Fusion-provided templates.

Once added, plugin-contributed workflow steps behave like other steps: they support the same `prompt` or `script` execution modes, `pre-merge` or `post-merge` phases, and `defaultOn` behavior for new tasks.

For plugin installation and authoring details, see the [Plugin Authoring Guide](./PLUGIN_AUTHORING.md) (Section 16: Registering Workflow Steps).

## Creating Workflow Steps in the Dashboard

From **Settings → Workflow Steps**, clicking **Add Workflow Step** now opens a chooser first:

- **Built-in templates** are shown immediately so you can add review/QA steps with one click
- **Custom workflow step** opens the manual form for fully custom prompt/script steps

The custom path is always available, even while templates are still loading or if template loading fails.

## Model Overrides for Prompt Steps

A prompt-mode workflow step can set its own model with:

- `modelProvider`
- `modelId`

If both are set, step execution uses that model; otherwise it falls back to default model selection.

## Default-On Behavior for New Tasks

Workflow step definitions support `defaultOn`.

When `defaultOn: true`, the step is preselected automatically for newly created tasks (users can still deselect it).

## Workflow Step Revision Loop

Workflow steps can request implementation revisions instead of just blocking completion.

### How It Works

Prompt-mode workflow step output is parsed in this order:

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

After each successful **prompt-mode pre-merge** workflow step, Fusion runs a scope invariant check on files newly touched by that step (committed delta plus uncommitted working-tree edits):

- If declared `## File Scope` is empty, the invariant is skipped.
- If task `scopeOverride === true`, the invariant is bypassed (same semantics as merge-time scope enforcement).
- If touched files have zero overlap with declared scope, Fusion emits a scope-leak log and applies `workflowStepScopeEnforcement`:
  - `"block"` (default): mark the workflow step `failed`, request revision, and route through the normal executor revision loop.
  - `"warn"`: log the violation but allow the step to pass.
  - `"off"`: disable this pre-merge workflow-step invariant entirely.

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

For pre-merge workflow hard failures, executor behavior is (gate-mode steps):

1. Retry the failing check up to `MAX_WORKFLOW_STEP_RETRIES` within the same execution lifecycle
2. On retry exhaustion, add a steering comment with failure details and inject a `Workflow Step Failure` section into `PROMPT.md`
3. Reopen only the last implementation step (`pending`) so prior completed work remains preserved
4. Schedule `todo → in-progress` after guard unwind, triggering a fresh executor remediation run

Tasks are not parked in `in-review` for this remediable path unless additional terminal failures occur.

## Workflow Interpreter Dual-Observe (parity instrumentation)

Fusion now enables the workflow interpreter parity seam by default as part of the workflow rollout.

- **Flag:** `experimentalFeatures.workflowInterpreterDualObserve` (default ON)
- **Mode:** observe-only shadow run; legacy executor/reviewer/merger/scheduler path remains authoritative unless the authoritative cutover guard passes
- **Behavior when OFF:** strict no-op (no shadow run, no parity audit records)
- **Behavior when ON (default):** compare legacy and interpreter observations plus comparable run-audit slices

Run-audit events emitted in `database` domain:

- `workflow:parity-observed` — always emitted for an enabled parity check with `metadata.agree`
- `workflow:parity-drift` — emitted when parity differs (or shadow execution fails), carrying `metadata.diffs`

The parity contract is exported from `@fusion/core` (`compareWorkflowRunObservations`, `compareWorkflowRunAudits`) and produces deterministic drift reports shaped as `{ agree, diffs[] }`, where each diff includes field name, legacy/interpreter values, category, and severity.

Dual-observe remains the rollout evidence path for the later authoritative cutover: the interpreter may only become authoritative when the separate `experimentalFeatures.workflowInterpreterAuthoritative` flag is ON **and** the cutover-readiness guard reports zero unresolved parity drift.

#### Self-healing recovery for parked review tasks

If a task is found in `in-review` with failed pre-merge workflow results and no active executor, self-healing can auto-revive it (bounded by `maxPostReviewFixes`) by replaying the same remediation send-back flow.

Advisory failures are intentionally excluded from merge blocking and auto-revive.

## Viewing Results

Workflow status is visible in multiple places:

- **Task cards**: workflow checks are shown after normal implementation steps in the step list; each workflow row uses the compact `workflow` badge label (while still retaining pre/post-merge styling semantics) and progress counts include both implementation and workflow checks
- **List view (desktop + mobile)**: progress labels/bars use the same unified step model as task cards
- **Task detail modal**: includes a **Workflow** tab when workflow data exists

In the Workflow tab, you can inspect:

- pass/fail/skipped/running status
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
- `prompt` / `script` nodes with `config.seam` dispatch through workflow runtime primitives (`planning`, `execute`, `workflow-step`, `review`, `merge`, `schedule`, `step-execute`)
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

The legacy seam adapter remains as a compatibility layer for older tests and callers, but authoritative node execution uses `WorkflowRuntimePrimitives`. The built-in coding workflow now includes explicit planning and pre-merge workflow-step gates before review/merge.

Reliability invariants preserved under authoritative mode:
- file-scope enforcement including `FileScopeViolationError`
- squash/file-scope overlap enforcement via `assertSquashOverlapsFileScope`
- `autoMerge: false` terminal-until-merged behavior in `in-review`
- `moveTask(in-progress → todo)` hard-cancel semantics without stray `userPaused` rebounds
- existing self-healing routing and fail-soft fallback behavior

The interaction backstop lives in `packages/engine/src/__tests__/reliability-interactions/workflow-interpreter-cutover.test.ts`.

## Workflow Step APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/workflow-steps` | List workflow steps |
| `POST /api/workflow-steps` | Create workflow step |
| `PATCH /api/workflow-steps/:id` | Update step |
| `DELETE /api/workflow-steps/:id` | Delete step |
| `POST /api/workflow-steps/:id/refine` | AI-refine prompt |
| `GET /api/workflow-step-templates` | List built-in templates |
| `POST /api/workflow-step-templates/:id/create` | Materialize template as workflow step |

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

The **step-execution**, **review/approval**, and **per-phase model-lane** knobs that
used to be project settings are now workflow settings declared by `builtin:coding`
with their former defaults. See
[Settings Reference → Workflow Settings](./settings-reference.md#workflow-settings)
for the full moved-key catalog, the editor walkthrough, and the export/sync posture.

Authoring surfaces:

- **Workflow editor → Settings panel** — Definitions (declarations/defaults) and
  Values (per-project) tabs.
- **Agent tools** — `fn_workflow_create`/`fn_workflow_update` accept `settings`
  declarations; `fn_workflow_settings` reads/writes values.

## Screenshot

![Workflow step manager](./screenshots/workflow-steps.png)

See also: [Task Management](./task-management.md) and [Settings Reference](./settings-reference.md).
