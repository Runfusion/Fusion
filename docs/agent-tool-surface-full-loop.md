# Full-loop agent tool-surface audit and delivery plan

[← Docs index](./README.md)

<!--
FNXC:AgentToolSurface 2026-07-29-00:00:
FR-08 requires chat and agent sessions to reach the complete build loop through native operations, not prompt-only descriptions or a weaker parallel path. This audit records the shipped surface, its gaps, and the guardrails required before widening it.
-->

## Decision summary

Fusion already has useful task, workflow, goal, research, execution, and verification tools. It does **not** yet give an engine agent or dashboard chat session a complete native route from an idea or research result into the execution-oriented mission hierarchy. In particular, `packages/engine/src/agent-tools.ts` has no `fn_mission_*`, `fn_milestone_*`, `fn_slice_*`, or `fn_feature_*` factory, and no ideation diverge/converge tool. Research can be run by qualifying sessions, but its current handoff ends at a task document/task action rather than an attributable roadmap feature.

The mission hierarchy is **Mission → Milestone → Slice → Feature → Task** ([Missions](./missions.md)); it is not the separate lightweight `Roadmap → RoadmapMilestone → RoadmapFeature` model. This document uses “roadmap” to mean the execution-oriented mission hierarchy unless it explicitly says otherwise.

## Method and scope

This is a source-grounded audit of the runtime factories in `packages/engine/src/agent-tools.ts`, their wiring in executor/heartbeat/chat sessions, and the corresponding dashboard operations. “Agent-facing” means model-visible in an engine session or dashboard chat, not merely callable by an operator-facing pi extension. A tool listed as a gap may already exist in the extension or UI; that is evidence of a dual-access/wiring gap rather than a reason to invent a second business operation.

### Session boundaries that matter

- **Executor:** `packages/engine/src/executor.ts` assembles task-bound tools. It is the only audited lane that adds `fn_run_verification` from `packages/engine/src/run-verification-tool.ts`, because that tool needs the task worktree.
- **Permanent/custom heartbeat:** `packages/engine/src/agent-heartbeat.ts` adds task discovery, workflow authoring, research, goals, task creation/delegation, and coordination tools. No-task heartbeats deliberately have no task worktree.
- **Dashboard chat:** `packages/dashboard/src/chat.ts` wires task creation/discovery, task assignment/delegation, goals, research, workflow authoring, documents, artifacts, and web fetch. It does not wire mission-hierarchy tools or executor-only verification.
- **Pi extension / operator tools:** the mission tools documented in [Missions](./missions.md#mission-planning-tools-pi-extension) and `packages/cli/skill/fusion/references/extension-tools.md` prove that mission operations already have a canonical store-backed implementation. They are not registered in `agent-tools.ts` or dashboard chat today.

## Stage inventory

| Loop stage | Current engine-agent / chat route | Status and concrete gap | Human operation / dual-access parity |
| --- | --- | --- | --- |
| Ideation: diverge and converge | No `fn_ideation_*` factory or registration exists in `packages/engine/src/agent-tools.ts`. Agents can use generic documents, memory, `fn_ask_question`, and chat prose, but none is a persisted ideation operation. | **GAP:** add native, persisted `fn_ideation_diverge` and `fn_ideation_converge` (names provisional until the canonical ideation domain API is designed). The existing `docs/ideation/2026-06-02-open-ideation.md` is an artifact, not a callable pipeline. | No audited Command Center ideation operation was found. Define the domain operation and expose the same operation to its UI and agent callers; do not create a chat-only document shortcut. |
| Research | `fn_research_run`, `fn_research_list`, `fn_research_get`, `fn_research_cancel`, and `fn_research_retry` come from `createResearchTools()` in `agent-tools.ts`. Executor only registers them when the research surface is enabled; heartbeat/chat wiring uses the same factories. | **Partial:** tools are gated by `isResearchToolSurfaceEnabled()` / `experimentalFeatures.researchView` in `tool-availability.ts`; disabled or unconfigured calls return setup guidance. Research results do not natively create/update mission hierarchy records. | Research view creates/runs/cancels/retries and exports runs ([Research](./research.md)); the same persisted `ResearchStore` run model is used. The dashboard can create/enrich a task from a finding, but has no research-to-feature/milestone handoff. |
| Roadmap read: goals and mission hierarchy | `fn_goal_list` and `fn_goal_show` are created by `createGoalRetrievalTools()`. Task discovery (`fn_task_list`, `fn_task_search`, `fn_task_show`) can show linked task context. No mission-hierarchy reader is in `agent-tools.ts`. | **GAP:** add `fn_mission_list` / `fn_mission_show` (and hierarchy-focused reads as needed) to the shared engine/chat tool surface. | Goals View and Mission Manager expose their canonical read views. Pi extension `fn_mission_list` / `fn_mission_show` already use mission-store operations; reuse those operations and response shapes. |
| Roadmap write: Mission → Milestone → Slice → Feature | No `fn_mission_*`, `fn_milestone_*`, `fn_slice_*`, or `fn_feature_*` is created or registered by `agent-tools.ts`. | **Confirmed GAP:** expose canonical mission writes, including create/update/delete, slice activation, feature creation/update/delete, and `fn_feature_link_task`; do not duplicate store semantics in chat. | Mission Manager owns mission/hierarchy editing, slice activation, and feature-to-task linkage. The pi extension already exposes the corresponding `fn_mission_*`, `fn_milestone_*`, `fn_slice_*`, and `fn_feature_*` operations. This is currently dual-access for UI ↔ extension, but not for engine/chat. |
| Task creation, planning, and assignment | `fn_task_create`, `fn_task_list`, `fn_task_search`, `fn_task_show`, `fn_delegate_task`, and `fn_task_assign` are factory-backed in `agent-tools.ts`; dashboard chat wires the discovery/create/delegate/assign tools. Workflow tools cover selected workflow inspection/authoring; task planner and triage convert a task into executable scope. | **Present, with boundary:** chat has no ambient task, so task documents/logs require explicit IDs. Planning-board tools intentionally provide board read parity. Mission-feature-to-task linkage remains unavailable to engine/chat because roadmap writes are missing. | New Task / Planning Board, task-detail assignment, workflow UI, and Mission Manager feature triage are the human paths. Existing task operations use the same `TaskStore`; task create/assignment is not a weaker chat-only path. |
| Execution | The executor owns worktree acquisition, task lifecycle, workflow-step execution, and task-bound file tools. Heartbeats can create/delegate/assign but are not a substitute for an execution worktree. | **Present, guarded:** execution begins through scheduler/workflow dispatch rather than a generic chat “run arbitrary task now” shortcut. No new bypass should skip task state, leases, workflow holds, or action gates. | Board/workflow release and task lifecycle controls invoke the same scheduler/store transitions. Command Center is an observability/control surface, not a separate executor. |
| E2E / verification | Task-bound executor sessions expose `fn_run_verification` from `packages/engine/src/run-verification-tool.ts`; it runs bounded test/lint/build/typecheck commands with worktree containment and concurrency controls. | **Partial:** dashboard chat and no-task heartbeat cannot safely call it because they lack an execution worktree. The missing chat control is a safe “request/observe verification on a selected task” operation, not exposing a raw command runner outside executor ownership. | Dashboard task/workflow result surfaces and Command Center funnel show execution state; the same verification result must be surfaced there. A future chat entry point must dispatch the existing task-owned verification operation and return its persisted result, not fork subprocess handling. |

### Confirmed gaps

1. `packages/engine/src/agent-tools.ts` contains goal, task, workflow, research, memory, and coordination factories, but no mission/milestone/slice/feature factory or registration.
2. No native persisted ideation diverge/converge operation is exposed from that registry.
3. Research availability is intentionally feature-gated by `isResearchToolSurfaceEnabled()` in `packages/engine/src/tool-availability.ts`; this must remain an explicit capability/setup state, not an implicit fallback.
4. Research currently lands in task context (finding-to-task/enrich-task UI), not in the execution roadmap hierarchy.
5. Executor-only `fn_run_verification` is correct for task worktree safety, but chat lacks a first-class request/status route for task-owned E2E verification.

## Dual-access parity contract

FR-07/FR-08 require one canonical operation beneath UI and tool callers. The parity target is not “every session gets every tool”: a tool requiring a task worktree remains executor-owned, and UI/chat must request the task-owned operation rather than recreate it.

| Operation family | Canonical backing operation today | Human surface | Agent/chat parity result |
| --- | --- | --- | --- |
| Research run lifecycle | `ResearchStore` + engine dispatcher / `ResearchOrchestrator` | Research view | **Parity for run lifecycle**, gated by the same research feature/settings. Task conversion is present; roadmap conversion is missing. |
| Mission hierarchy | `MissionStore` and mission routes | Mission Manager | **Extension/UI parity exists; engine/chat gap.** Reuse MissionStore operations and existing extension semantics. |
| Goals | Goal store/retrieval tools | Goals View and Mission Manager goal linkage | **Read parity only** in `agent-tools.ts`; hierarchy linkage writes need the roadmap phase. |
| Tasks, delegation, assignment | `TaskStore` / `AgentStore` | Board, Planning Board, task detail | **Parity**, subject to existing permission policy and explicit `task_id` in chat. |
| Workflow authoring | Workflow store/IR validation | Workflows UI | **Parity** in heartbeat/chat, with action gates and approval-bypass stripping for prompt-injectable lanes. |
| Verification | task-owned bounded runner + persisted task execution state | Task/workflow state and Command Center observability | **Executor parity only.** Add a safe request/status UI/chat bridge; do not expose a second raw runner. |
| Ideation | No canonical persisted domain operation identified | No audited dedicated Command Center operation identified | **Gap on both sides.** Design the shared operation before exposing either surface. |

## Parallelism: current behavior and real gap

Fusion does not have a single-workflow-only scheduler by design. The scheduler can dispatch independent runnable tasks, but admission is bounded and serialized at specific safety gates:

- `packages/engine/src/scheduler.ts` computes dispatch capacity from **`maxConcurrent`**, **`maxWorktrees`**, and the shared **`semaphore`** in `computeConcurrencyGateDiagnostic()`. The settings default to `maxConcurrent` 2 and `maxWorktrees` 4 when unspecified (scheduler dispatch path).
- `AgentSemaphore` in `packages/engine/src/concurrency.ts` gates all top-level triage, execution, and merge agents. Its priority queue serves merge before execute before specification (`PRIORITY_MERGE`, `PRIORITY_EXECUTE`, `PRIORITY_SPECIFY`). A full semaphore can therefore make work appear serialized even with multiple runnable cards.
- The workflow hold/release sweep in `scheduler.ts` reserves worktree and semaphore capacity with `tryAcquire()` **before** moving a task to `in-progress`, then transfers that pre-held slot to the executor. This prevents a race but means the available minimum of all gates is authoritative.
- `maxWorktrees` counts only `in-progress` tasks; in-review worktrees do not consume that execution-worktree limit. `maxConcurrent` counts execution slots, while the global semaphore also accounts for planning and active review top-level holders.
- Runnable candidates are additionally filtered for paused state, unmet dependencies, recovery backoff, workflow hold/release state, and file-scope overlap via `isRunnableQueuedOverlapCandidate()` / `pathsOverlap()` in `scheduler.ts`. This is coarse path-scope serialization, not FR-48 symbol locking.
- `packages/engine/src/workflow-work-scheduler.ts` claims one due workflow work item per call with a lease. The surrounding scheduler’s repeated dispatch and capacity gates determine aggregate concurrency; this helper alone does not fan out a batch.
- `packages/engine/src/verification-concurrency.ts` separately defaults expensive verification subprocesses to one concurrent project-wide slot. Task execution can be parallel while heavy E2E verification intentionally queues.

Therefore, “serializes silently” means either (a) one of the named capacity gates has no slack, (b) a candidate is dependency/hold/recovery/overlap blocked, (c) workflow work is only claimed one item per dispatch turn, or (d) verification is at its distinct verification cap. It does **not** mean missions or sprints themselves are scheduling pools with independent concurrency. Mission membership supplies delivery structure; it does not reserve capacity or create a parallel execution lane.

## Guardrail contract

Widening the surface is safe only if these delivery invariants ship with it:

| Guardrail | Required contract | Current audit evidence and dependency |
| --- | --- | --- |
| FR-02: mission admission | Before autonomous execution/claim, deterministically prove that the task traces to an approved mission/feature lineage. Unknown/unlinked work must wait, ask, or be explicitly admitted; it must not become idle-agent patrol work. | Current no-task heartbeat prompts in `agent-heartbeat-prompts.ts` encourage one useful action and permit `fn_task_create` after duplicate checks. `renderHeartbeatNoTaskSystemPrompt({ plannerHeartbeatPatrolEnabled: false })` can suppress patrol, but that is not a kernel mission-lineage admission gate. This phase must be independently tracked before the widened autonomous route is enabled. |
| FR-37: completion → roadmap reconciliation | Completed, blocked, and changed task state must reconcile the linked feature/slice/milestone/mission status and expose the same result to UI/chat. | `scheduler.ts` imports `reconcileMissionFeatureState`, showing existing feature-state reconciliation infrastructure, but this audit found no tool-level research/roadmap handoff contract. The roadmap-tool phase must preserve and extend canonical reconciliation rather than write parallel status. |
| FR-48: symbol-level locking | Concurrent work must use a durable symbol-level lock/claim protocol where file-scope overlap is too coarse; lock acquisition/release and conflict reporting must be visible to scheduler and tools. | Current scheduler has file-scope overlap filtering (`pathsOverlap`) and worktree/semaphore reservations, not symbol-level locks. Parallel admission must remain bounded by existing gates until a symbol-locking implementation lands. |
| Existing action/permission gates | Every new mutating tool must be classified and action-gated; prompt-injectable lanes must not bypass approvals. | Heartbeat wraps broad tools in action gates and strips workflow approval-bypass flags. Mission/ideation tools need the same classification and tests. |
| Research feature gate | Research calls preserve explicit disabled/unconfigured outcomes. | `tool-availability.ts` and [Research](./research.md) define the experimental gate and setup behavior. Do not make roadmap writes silently invoke research. |

## Phased implementation plan

The following phases are intentionally independently shippable. Follow-up task IDs are added after duplicate reconciliation and task creation.

### Phase A — Mission hierarchy tool surface and parity

- **Scope anchors:** `packages/engine/src/agent-tools.ts`, `packages/engine/src/index.ts`, `packages/dashboard/src/chat.ts`, `packages/cli/src/extension.ts` or the existing mission extension factory, mission routes/store tests, Mission Manager API adapters, `docs/missions.md`.
- **Acceptance:** engine/chat can list/show/create/update Mission → Milestone → Slice → Feature and link a feature to a task through the same MissionStore-backed operations used by Mission Manager/extension; action-gate policy, explicit chat context, and UI ↔ tool contract tests cover each mutation.
- **Dependency:** none for read/write parity; it must not claim autonomous execution admission.
- **Tracking:** FN-8294 — Phase A implementation task.

### Phase B — Persisted ideation diverge/converge

- **Scope anchors:** a new core ideation domain/store, `packages/engine/src/agent-tools.ts`, `packages/dashboard/src/chat.ts`, dedicated dashboard ideation UI/Command Center entry, `docs/ideation/`.
- **Acceptance:** agents and humans can create a bounded ideation session, record divergent candidates with provenance, converge an explicitly selected candidate, and hand it to Phase A’s mission-hierarchy operation without copying prose between parallel stores.
- **Dependency:** Phase A, because convergence must create/attach canonical roadmap records rather than an orphan document.
- **Tracking:** FN-8295 — Phase B implementation task; depends on FN-8294.

### Phase C — Research-to-roadmap bridge and reconciliation

- **Scope anchors:** `packages/engine/src/research-orchestrator.ts`, research routes/UI, `packages/engine/src/agent-tools.ts`, mission store/reconciliation, dashboard chat, `docs/research.md`, `docs/missions.md`.
- **Acceptance:** a cited research run/finding can create or enrich a canonical mission feature with persisted source/run provenance; feature/task completion reconciles back to the hierarchy without manual board repair; disabled research still returns setup guidance.
- **Dependency:** Phase A; may consume Phase B convergence output but should remain usable directly from research.
- **Tracking:** FN-8297 — Phase C implementation task; depends on FN-8294.

### Phase D — Mission admission and safe parallel delivery

- **Scope anchors:** scheduler admission/hold-release paths, `packages/engine/src/agent-heartbeat.ts`, `packages/engine/src/agent-heartbeat-prompts.ts`, mission lineage queries, action-gate classifications, `packages/engine/src/concurrency.ts`, `packages/engine/src/verification-concurrency.ts`, and new symbol-locking components/tests.
- **Acceptance:** autonomous claims execute only tasks with approved mission lineage; no-task idle patrol cannot invent off-mission implementation; independent approved tasks use available `maxConcurrent`, `maxWorktrees`, semaphore, and verification capacity while conflicting symbols serialize through durable locks; diagnostics identify the binding gate/lock; completion reconciles roadmap state.
- **Dependency:** Phase A for lineage data, and the tracked FR-02/FR-37/FR-48 work if those tasks already cover portions of this phase.
- **Tracking:** FN-8298 — Phase D implementation task; depends on FN-8294 and FN-8297.

### Phase E — Chat-owned verification request/status — delivered (FN-8296)

- **Shipped tools:** `fn_task_request_verification` queues only the server-resolved `verify:fast` or configured `test-command` profile; `fn_task_verification_status` returns the latest bounded persisted result. Neither accepts raw command text.
- **Execution contract:** the request is project-scoped and CAS-claimed by the in-progress task executor, which reuses its live worktree and `runVerificationCommand`/`withVerificationSlot` bounds. `fn_task_request_verification` is classified as `command_execution`; status is read-only.
- **Parity:** chat can request/observe the same executor-owned verification outcome. Duplicate in-flight requests retain their original request ID rather than replacing work in progress.
- **Dependency:** remains independently shippable from A–D; Phase D diagnostics can be added to records later without changing the ownership contract.

## Follow-up reconciliation record

Step 0 attempted the available task-board discovery tools to search the cited FR themes. The hosted TaskStore timed out during `fn_task_show` and repeated `fn_task_list` calls, and this task environment does not expose the specified `fn_task_search` tool. Repository-local tracked documentation/spec search found no existing task IDs for FR-02, FR-07, FR-08, FR-14, FR-15, FR-37, or FR-48. After that reconciliation, Step 3 created the non-duplicate implementation tasks: FN-8294 (Phase A), FN-8295 (Phase B, depends on FN-8294), FN-8297 (Phase C, depends on FN-8294), FN-8298 (Phase D, depends on FN-8294 and FN-8297), and FN-8296 (Phase E, independent).

## Source references

- `packages/engine/src/agent-tools.ts` — shared engine tool factories and absent mission/ideation factories.
- `packages/engine/src/tool-availability.ts` — research experimental gate and guidance.
- `packages/engine/src/executor.ts` and `packages/engine/src/run-verification-tool.ts` — task-bound execution and verification tool registration.
- `packages/engine/src/agent-heartbeat.ts` and `packages/engine/src/agent-heartbeat-prompts.ts` — ambient tool exposure and no-task patrol behavior.
- `packages/dashboard/src/chat.ts` and `packages/dashboard/src/planning-board-tools.ts` — dashboard model-loop and planning-board wiring.
- `packages/engine/src/scheduler.ts`, `packages/engine/src/concurrency.ts`, `packages/engine/src/workflow-work-scheduler.ts`, and `packages/engine/src/verification-concurrency.ts` — actual concurrency gates and work-item lease behavior.
- [Research](./research.md), [Missions](./missions.md), and [`docs/ideation/`](./ideation/) — human-facing workflow and current ideation artifact.
