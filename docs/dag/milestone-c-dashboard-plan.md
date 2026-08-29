# Milestone C: DAG dashboard surfacing plan

Related tasks: **FN-4487**, **FN-4471**, **FN-4490**, **FN-4491**, **FN-4492**.

## Constraints & Governance

> "Do not file, plan, or implement tasks that adjust button mobile-responsiveness, touch-target sizing, or mobile reflow of header/action button rows anywhere in the dashboard (TaskCard, SettingsModal, ChatView, MissionManager, AgentsView, FAB, etc.). **Keep buttons as they are.**"

> "Reliability mechanism changes are currently under freeze pending FN-4359 governance hardening; treat new reliability-layer behavior changes as blocked unless explicitly approved in task scope."

This document is planning-only. No runtime behavior, scheduler/executor/merger code, dashboard routes, API endpoints, or schema changes are made here.

## UX Progression (debug → operator)

### Stage 1 — Debug surface

**Audience:** Fusion developers debugging prototype orchestration.

**Ship:** Read-only structured-log view for `[dag-coordinator]` events, filterable by `runId`, mirroring `AgentLogViewer` / `ActivityFeed` interaction patterns.

**Operator questions answered:**
- Did this DAG run start and finish/abort?
- Which node was enqueued/completed/failed most recently?
- What failure reason code was emitted for the failing node/run?

**Events consumed from FN-4490 contract:**
- `dag:run:start`
- `dag:node:enqueue`
- `dag:node:complete`
- `dag:node:fail`
- `dag:run:complete`
- `dag:run:abort`

### Stage 2 — Run inspector

**Audience:** Power users monitoring multi-task DAG runs.

**Ship:** Per-run detail inspector with node table, dependency/blocked context, and task deep-links into `TaskDetailModal`; read-only.

**Operator questions answered:**
- Which DAG node failed and why?
- Which nodes are complete vs still pending/in-progress?
- Which Fusion task corresponds to each node and where do I inspect logs/details?

**Events consumed from FN-4490 contract:**
- `dag:run:start`
- `dag:node:enqueue`
- `dag:node:complete`
- `dag:node:fail`
- `dag:run:complete`
- `dag:run:abort`

### Stage 3 — Operator surface

**Audience:** End-users orchestrating DAG runs.

**Ship:** Top-level run list, per-run graph visualization (nodes + edges), run-state summary, and pause/resume/cancel controls.

**Operator questions answered:**
- Is this run still making progress or stalled?
- Which branch/path of the graph failed and what is downstream impact?
- Can I safely pause/resume/cancel without violating task ownership or merge safety?

**Events consumed from FN-4490 contract:**
- `dag:run:start`
- `dag:node:enqueue`
- `dag:node:complete`
- `dag:node:fail`
- `dag:run:complete`
- `dag:run:abort`

#### Events to add in FN-4490 follow-up

Stage 3 controls need explicit pause/resume observability. FN-4490 currently defines only `dag:run:abort` (not pause/resume), so add:
- `dag:run:pause`
- `dag:run:resume`

These are follow-up requirements and are not introduced as implemented behavior in this task.

## Views & Controls

| Surface name | Stage | Mount point | Data source (proposed) | Reused components/classes | New tokens required | Lazy-load decision | Mobile reflow plan |
|---|---:|---|---|---|---|---|---|
| `DagRunDebugFeed` | 1 | `DagRunDetailModal` in `packages/dashboard/app/components/AppModals.tsx` | `GET /api/dag/runs/:id/events` backed by `DagCoordinator` run-event stream | `AgentLogViewer`, `ActivityFeed`, `.card`, `.input` | none | Modal code-split with existing `AppModals.tsx` lazy modal pattern; no eager heavy bundle | Only non-button layout wrapping at `@media (max-width: 768px)`; control buttons unchanged per Buttons Frozen |
| `DagRunDetailModal` | 2 | New modal wired in `AppModals.tsx` | `GET /api/dag/runs/:id` + `GET /api/dag/runs/:id/nodes` from `DagCoordinator` read model | `.modal`, `.modal-lg`, `.card`, `.card-status-badge--{status}`, `.input`, `TaskDetailModal` deep-link behavior | none | Lazy modal import via `React.lazy()` + `<Suspense fallback={null}>` | Non-button table/graph stacking only; no `.btn` size/reflow edits |
| `DagNodeDetailPanel` | 2 | Child panel inside `DagRunDetailModal` | `GET /api/dag/runs/:id/nodes/:nodeId` from `DagCoordinator` | `.card`, `.card-meta`, `.card-status-badge--{status}`, `linkifyFilePaths`, `FileBrowserContext` | none | Bundled with `DagRunDetailModal` chunk (no separate eager load) | Non-button typography/spacing adjustments only in component CSS mobile block |
| `DagRunsView` | 3 | New top-level view in `packages/dashboard/app/App.tsx` nav/view registry | `GET /api/dag/runs` from `DagCoordinator` run list read model | `.card`, `.card-header`, `.card-id`, `.card-status-badge--{status}`, `.input`, `.btn`, `.btn-sm`, `.btn-warning`, `.btn-danger` | none | Required heavy-view lazy load: `React.lazy()` + `prefetchLazyViews()` warm-up registration | Card/grid/list non-button layout reflow only; action-button row unchanged per Buttons Frozen |
| `DagRunGraphPanel` | 3 | Section within `DagRunDetailModal` (opened from `DagRunsView`) | `GET /api/dag/runs/:id/graph` from `DagCoordinator` graph projection | `.card`, status tokens (`--triage`, `--todo`, `--in-progress`, `--in-review`, `--done`), `ConfirmDialog` for destructive control confirmation handoff | `--dag-graph-edge` (semantic), `--dag-graph-node-shadow` (semantic), `--dag-graph-active-ring` (semantic) | Included in Stage 3 lazy chunks (`DagRunsView`/`DagRunDetailModal`) and prefetched with other heavy views | Graph canvas/layout may reflow on mobile; button classes remain existing `.btn` chain with no touch-target inflation |

Notes:
- Stage mapping is complete across all Stage 1–3 surfaces.
- All status visuals reuse existing semantic status tokens and `--status-*-bg` conventions.
- No row introduces hardcoded px/hex/rgba contracts; implementation must remain token-driven.
- No row proposes button restyling, `.btn` min-height overrides, or mobile button-row reflow.

## Run Control Contract

### Pause

Pause means: stop enqueuing new DAG nodes for the run while allowing currently in-flight Fusion tasks to finish through their existing executor lease + merge path. Pause does **not** cancel running tasks mid-flight and does not mutate checkout ownership.

This preserves `AGENTS.md` checkout-leasing conflict semantics (409 ownership contention) and avoids violating merger file-scope protections (file-scope invariant remains authoritative).

### Resume

Resume means: re-enable node enqueueing for a paused run. Any node whose dependencies are now satisfied becomes eligible through the existing scheduler path defined by the FN-4490 ADR (`DagCoordinator` as upstream readiness producer into normal queueing/dispatch), with no direct scheduler-internal bypass.

### Cancel

Cancel means: stop future enqueueing, mark run aborted, and finalize run state with `dag:run:abort`. In-flight tasks may finish/fail naturally, but their outcomes do not trigger downstream nodes after cancellation.

Cancel explicitly does **not**:
- issue task moves (including `moveTask(in-progress → todo)`),
- cancel executor sessions mid-flight,
- bypass merger/workflow gates,
- alter user-initiated cancel contracts in `AGENTS.md` Engine Process Rules.

### UI affordance contract

- Controls are single buttons using existing classes only: `.btn`, `.btn-sm`, `.btn-warning`, `.btn-danger`.
- Cancel is destructive and must be confirmation-gated via `ConfirmDialog`.
- No new button styling, no button mobile reflow, and no touch-target inflation for these controls (Buttons Frozen directive applies).

### Proposed API surface (planning only)

- `POST /api/dag/runs/:id/pause`
- `POST /api/dag/runs/:id/resume`
- `POST /api/dag/runs/:id/cancel`

Success response shape (proposed): `{ ok: true, runId, state }`.
Illegal state transition: `409` (mirrors existing 409 conflict semantics).

Schema details, persistence model, and endpoint implementation are out-of-scope for FN-4492 and should be handled in FN-4491 / downstream Milestone C implementation.

### Observability + run-audit tie-in

- Control actions must emit DAG lifecycle events and run-audit mutations.
- `dag:run:abort` already exists in FN-4490 contract.
- `dag:run:pause` and `dag:run:resume` are required follow-up additions to FN-4490 vocabulary before implementation.
- Run-audit should record state transitions in database-domain audit entries per existing run-audit model.

### Explicit out-of-scope control behaviors

- No force-kill of running tasks
- No rollback of already-merged commits
- No automatic retry/replay of cancelled runs
- No cross-mesh fan-out cancellation

## Compliance Contract (binding for Milestone C implementation)

1. **Design tokens only**
   - Follow `AGENTS.md` Adding New CSS rules: no hardcoded px (except `0`), no raw hex, no raw `rgba(...)`.
   - Use dashboard tokens (`--space-*`, `--radius-*`, `--color-*`, status tokens) and `color-mix(in srgb, var(--color) X%, transparent)` for translucency.

2. **Per-component CSS files only**
   - New styles must live in `packages/dashboard/app/components/<Component>.css`.
   - Import at top of `<Component>.tsx`.
   - Do not add component-specific styles to `packages/dashboard/app/styles.css`; only global token definitions belong there.

3. **CSS tests must use fixture helpers**
   - Future CSS regression tests must use `packages/dashboard/app/test/cssFixture.ts` (`loadAllAppCss`, `loadAllAppCssBaseOnly`).
   - Direct `readFileSync('../styles.css')` assertions are disallowed by lint policy.

4. **Lazy-load contract for heavy DAG surfaces**
   - Stage 2/3 surfaces are heavy and must use `React.lazy()` + `<Suspense fallback={null}>` patterns in `App.tsx` and/or `AppModals.tsx`.
   - Add Stage 3 top-level DAG view imports to `prefetchLazyViews()` warm-up list.

5. **Theme contract**
   - Reuse existing status tokens: `--triage`, `--todo`, `--in-progress`, `--in-review`, `--done`, plus `--status-*-bg` variants.
   - Proposed new tokens in this plan are all **semantic tokens** (`--dag-graph-edge`, `--dag-graph-node-shadow`, `--dag-graph-active-ring`) and therefore require dark/light definitions only.
   - If implementation later needs **base tokens**, those must be added to dark/light plus all 54 theme blocks.

6. **Buttons Frozen (verbatim directive + protected files)**
   - "Do not file, plan, or implement tasks that adjust button mobile-responsiveness, touch-target sizing, or mobile reflow of header/action button rows anywhere in the dashboard (TaskCard, SettingsModal, ChatView, MissionManager, AgentsView, FAB, etc.). **Keep buttons as they are.**"
   - Implementers must not open `SettingsModal.css`, `TaskCard.css`, `ChatView.css`, or similar mobile media blocks to alter `.btn`, `.modal-close`, `.settings-header-actions`, `.card-*` button rules.
   - Pause/resume/cancel controls must use existing `.btn` chains with no size/touch-target changes.

7. **Mobile responsive scope**
   - Non-button reflow only, using `@media (max-width: 768px)` blocks placed at bottom of the component CSS file.
   - Touch-target convention for non-button interactive surfaces applies (e.g., graph-node tap surfaces may be primary controls; secondary chip controls remain compact).

8. **No reliability-layer behavior changes**
   - Milestone C implementation must not modify scheduler, executor, self-healing, restart-recovery, or merger behavior while FN-4359 freeze remains active.

## Cross-links and follow-up execution

- FN-4487 mission proposal: task **FN-4487** (proposal lineage for Milestones A/B/C).
- FN-4471 scoping recommendation: task **FN-4471** (upstream framing and constraints).
- FN-4490 architecture inputs consumed by this plan:
  - `docs/dag/requirements-matrix.md`
  - `docs/dag/adr-0001-dag-orchestration.md`
  - `docs/dag/failure-observability-contract.md`
- FN-4491 scaffold dependency for downstream implementation: task **FN-4491**.

Follow-up tasks created from this planning pass:
- **FN-4503** (depends on FN-4491, FN-4492): Milestone C implementation task for DAG dashboard surfacing.
- **FN-4504** (depends on FN-4490, FN-4492): add `dag:run:pause` + `dag:run:resume` event vocabulary and run-audit mapping guidance.
