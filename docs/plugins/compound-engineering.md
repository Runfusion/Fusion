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

## Dashboard view

The Compound Engineering view is registered as a primary plugin destination
(`viewId: "compound-engineering"`).

It provides:
- An **artifact hub** that discovers CE artifacts from conventional locations
  (`STRATEGY.md`, `docs/ideation/`, `docs/brainstorms/`, plan docs, `docs/work/`,
  `CONCEPTS.md`, `docs/solutions/`) grouped by stage, with explicit
  empty / partial / error states.
- Self-contained artifact previews read through plugin routes under
  `/api/plugins/fusion-plugin-compound-engineering/`.
- A **stage launcher** listing the registered, operator-enabled stages.

## Sessions

Each stage maps to a bundled skill via the stage registry
(`{ stageId, skillId, artifactLocation, icon, label }`). Launching a stage starts
an interactive agent session on the host's `createInteractiveAiSession` seam.

The orchestrator streams `thinking`/`text` turns, surfaces a structured
`question` (pausing in `awaiting_input`), accepts a structured answer, and on
`complete` writes the artifact to the stage's conventional location. Lifecycle:
`launching → active → awaiting_input → completed`, plus `error` and
`interrupted`. Interrupt/error auto-saves progress and emits an observable event;
sessions resume/retry back to their current question.

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
- `GET /sessions/:id` → current persisted session state (push + poll fallback)
- `GET /sessions` → list sessions (filter by status/stage)
- `GET /sessions/:id/links` → the work→board pipeline-link records for a session

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
reconciler creates the next-stage board task and links it.

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
- `enabledStages` (string[], default = full registry) — only these stage IDs may
  be launched; the orchestrator rejects others.

**Sync**
- `reconcileOnHooks` (boolean, default `true`) — auto-fire the reconcile sweep
  after task move/complete hooks. When off, the hook still enqueues so an
  on-demand sweep converges later.
- `reconcileIntervalMinutes` (number, default `15`) — cadence hint for an
  on-demand refresh surface; not a continuous poll loop.
