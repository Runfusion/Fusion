# Compound Engineering Plugin

A dedicated dashboard surface for the compound-engineering (CE) workflow — an
artifact hub, interactive `ce-*` skill sessions, a work→board bridge, and
event-driven bidirectional sync. It runs alongside Fusion's native pipeline.

## Install

1. Open **Settings → Plugins → Fusion Plugins**.
2. In **Bundled Plugins**, click **Install** for **Compound Engineering**.
3. Enable the plugin if it is not already started.

When installed and enabled, the plugin registers the **Compound Engineering**
dashboard view destination and installs its bundled `ce-*` skills into a
plugin-local, discoverable directory (never a global `~/.claude/skills` path).

**Built-in workflow gating:** the `builtin:compound-engineering` workflow is
hidden from the workflow picker and task workflow selection until this plugin is
installed and enabled. Once the plugin is active, the workflow appears
automatically alongside other built-in workflows — no additional configuration is
needed. If the plugin is uninstalled, the workflow is hidden again.

## Dashboard view

The Compound Engineering view is registered as a primary plugin destination
(`viewId: "compound-engineering"`).

It follows dashboard UI conventions: the view's panels, controls, responsive
layout, spacing, and radii use the shared `--space-*` / `--radius-*` design
tokens and shared button/card/input classes so the plugin remains visually
consistent across light, dark, desktop, and mobile surfaces.

It provides:
- An **artifact hub** that discovers CE artifacts from conventional locations
  (`STRATEGY.md`, `docs/ideation/`, legacy `docs/brainstorms/`, unified
  `docs/plans/`, `docs/work/`, `CONCEPTS.md`, `docs/solutions/`) grouped by
  stage, with explicit empty / partial / error states and readiness metadata for
  unified plans.
- Self-contained artifact previews read through plugin routes under
  `/api/plugins/fusion-plugin-compound-engineering/`.
- A **stage launcher** listing the registered, operator-enabled stages.

<!-- FNXC:CompoundEngineering 2026-06-27-01:02: CE v3.15 keeps Fusion's brainstorm and plan stage IDs separate for orchestration/back-compat, but both stages operate on the same upstream unified plan artifact in docs/plans. docs/brainstorms remains a legacy input location for historical requirements files. -->

`brainstorm` and `plan` are separate Fusion stages but share the unified
`docs/plans/` artifact contract: brainstorm produces a requirements-only unified
plan (`artifact_readiness: requirements-only`, `product_contract_source:
ce-brainstorm`), and plan enriches that same file to `implementation-ready`.

## Sessions

Each stage maps to a bundled skill via the stage registry
(`{ stageId, skillId, artifactLocation, icon, label }`). Launching a stage starts
an interactive agent session on the host's `createInteractiveAiSession` seam.

The orchestrator streams `thinking`/`text` turns, surfaces a structured
`question` (pausing in `awaiting_input`), accepts a structured answer, and on
`complete` writes the artifact to the stage's conventional location (`docs/plans/`
for both Brainstorm and Plan under the unified-plan alias). Lifecycle:
`launching → active → awaiting_input → completed`, plus `error` and
`interrupted`. Interrupt/error auto-saves progress and emits an observable event;
sessions resume/retry back to their current question.

Turn execution is **detached**: start/answer/resume return as soon as the
session row reflects the request, with the agent turn running in the background
(failures persist into session state — never an unhandled rejection). **Close**
only leaves the flow UI; it does not stop the detached agent. **Cancel** is the
explicit stop action for `launching`/`active`/`awaiting_input` sessions: it
aborts any live in-process handle, flushes live working output into history, and
keeps the session row as terminal `interrupted` with `Cancelled by user` so the
conversation can be inspected or resumed. **Discard** is different: it removes a
settled session row entirely after disposing any live handle.

While a turn runs, the engine streams mid-turn progress (thinking/text deltas + tool
markers) through the seam's `onProgress` option; the orchestrator buffers it
and `GET /sessions/:id` attaches it as transient `liveActivity`. The per-turn
timeout is **inactivity-based** (progress re-arms it), so long actively-working
turns are never killed; on settle/interrupt the working trace is condensed into
the conversation history. Users can also **steer** mid-stage: answers may carry
free-text guidance (`{value, comment}`) or be guidance-only (`{feedback}`).

Updates are **pushed** over the shared `/api/events` SSE stream: the orchestrator
emits via `ctx.emitEvent`, the host forwards them as project-scoped
`plugin:custom` events, and the view subscribes through the host
`subscribePluginEvents` capability (no raw `EventSource`). Polling
`GET /sessions/:id` remains a fallback. The `projectId` from `start` is threaded
through every answer/resume/poll so they resolve the session's owning store.

HTTP endpoints (under `/api/plugins/fusion-plugin-compound-engineering/`):
- `POST /sessions` → start a stage session
- `POST /sessions/:id/answer` → answer the awaiting question (send `projectId`)
- `POST /sessions/:id/resume` → resume an awaiting/interrupted session (send `projectId`)
- `POST /sessions/:id/cancel` → cancel an in-flight session; stops the agent and keeps the row as `interrupted`
- `GET /sessions/:id` → current persisted session state (push + poll fallback)
- `GET /sessions` → list sessions (filter by status/stage)
- `GET /sessions/:id/links` → the work→board pipeline-link records for a session
- `DELETE /sessions/:id` → discard a session; stops any live handle and deletes the row

## Sync model

Two separate state machines are kept in sync, never merged:

- **Board-task ownership** → the task `column`. The **board is authoritative for
  task state**.
- **CE-pipeline ownership** → `ce_pipeline_state.{currentStage, status}`. The
  **CE flow is authoritative for artifact/pipeline content**.

**Inbound:** `onTaskMoved` / `onTaskCompleted` hooks resolve the link and enqueue
a sync signal under the 5s hook budget — no inline advancement.

**Reconcile:** `reconcileCePipelines(ctx)` is a single on-demand sweep (not a
poll loop). It drains the queue and independently re-derives transitions from
live board state, so a dropped or never-enqueued event still converges.

**Outbound:** when a pipeline advances to a stage that produces board work, the
reconciler creates the next-stage board task and links it. Brainstorm → Plan
advancement carries `lastArtifactPath` forward so the plan task continues the
same unified `docs/plans/` artifact instead of forking a second file.

**Conflict policy:** the reconciler only reads already-terminal board columns and
only writes CE-owned fields plus a new board task, so the two writers never
contend over the same cell.

The work bridge tags every CE-originated board task (source `workflow_step` with
CE markers in `sourceMetadata`) and records an authoritative pipeline-link row;
created tasks then run the normal lifecycle untouched.

## Settings

Settings render under **Settings → Plugins → Compound Engineering**.

**Sessions**
- `defaultProvider` (string) — provider for CE interactive sessions; blank uses
  the host default. Consumed by the orchestrator's factory call.
- `defaultModelId` (string) — model within the provider; blank uses the host
  default. Consumed by the orchestrator's factory call.
- `disabledStages` (string[], default `[]`) — explicit opt-out list. Registered
  stages launch by default; the orchestrator rejects only IDs listed here.

**Sync**
- `reconcileOnHooks` (boolean, default `true`) — auto-fire the reconcile sweep
  after task move/complete hooks. When off, the hook still enqueues so an
  on-demand sweep converges later.
- `reconcileIntervalMinutes` (number, default `15`) — cadence hint for an
  on-demand refresh surface; not a continuous poll loop.
