# Compound Engineering Plugin for Fusion

A dedicated dashboard surface for the compound-engineering (CE) workflow: an
artifact hub, interactive in-dashboard `ce-*` skill sessions, a work→board
bridge, and event-driven bidirectional sync between the Fusion board and a
plugin-local CE-pipeline state model. It runs **alongside** Fusion's native
pipeline — it does not replace or bypass it.

## Install (one-click)

1. Open **Settings → Plugins → Fusion Plugins**.
2. In **Bundled Plugins**, click **Install** on **Compound Engineering**.
3. Enable the plugin if prompted.

Once installed and enabled, Fusion registers the **Compound Engineering**
dashboard destination automatically and installs the bundled `ce-*` skills into a
plugin-local, discoverable directory.

## What it does

Compound engineering normally runs as terminal slash-commands whose artifacts
scatter across `docs/`, with no unified surface and no link between a finished
plan and the board work that follows. This plugin surfaces the whole flow inside
Fusion while **reusing the real skills** so the plugin improves as they do.

## Artifact hub

The primary dashboard view (`viewId: "compound-engineering"`) discovers and
renders CE artifacts from their conventional locations (`STRATEGY.md`,
`docs/ideation/`, `docs/brainstorms/`, plan docs, `docs/work/`, `CONCEPTS.md`,
`docs/solutions/`) and groups them by stage. Artifacts are read through a plugin
route and rendered self-contained (sandboxed preview). The hub renders explicit
empty / partial / error states rather than crashing or silently dropping an
unreadable artifact.

Artifact HTTP endpoints live under
`/api/plugins/fusion-plugin-compound-engineering/` and back the hub list/read.

## Interactive `ce-*` sessions

Each pipeline stage maps to a bundled skill via the **stage registry**
(`src/session/stage-registry.ts`): `{ stageId, skillId, artifactLocation, icon,
label }`. Adding a stage is a data entry — no new route, store, or screen.

The launcher lists the registered (and operator-enabled) stages. Launching a
stage starts an **interactive** agent session driven by the host's
`createInteractiveAiSession` seam (a foundational extension added by this plan,
because the existing `createAiSession` is one-shot and cannot pause on a
mid-agent question). The session orchestrator (`src/session/orchestrator.ts`):

- streams `thinking` / `text` turns,
- surfaces a structured `question` and pauses in `awaiting_input`,
- accepts a structured answer and continues,
- on `complete`, writes the artifact to the stage's conventional location.

Lifecycle states are `launching → active → awaiting_input → completed`, plus
`error` and `interrupted`. On interrupt or error the orchestrator **auto-saves
progress and emits an observable event — never silent loss** — and an
`interrupted`/`error` session can be resumed/retried back to its current
question.

### Multiple sessions

Sessions are independent pipeline runs — the store, routes, and orchestrator
all hold many at once (each with its own live agent handle). The dashboard's
**Sessions panel** lists every session with its stage, status, and last
activity; from there you can:

- **open** any session and keep working on it (an `awaiting_input` session is
  flagged "needs your input"),
- **switch** between sessions — the panel stays visible while a flow is open,
  and a session you switch away from keeps running server-side,
- **resume** an `interrupted`/`error` session from where it stopped,
- **discard** a settled (completed/error/interrupted) session via
  `DELETE /sessions/:id`, which disposes any live handle before deleting the
  row (pipeline-link rows are kept — board-task provenance survives).

The list refreshes on any CE push event and falls back to polling
`GET /sessions` while any session has a turn in flight.

### Live working output, steering, and the Q&A surface

Turn execution is **detached**: `POST /sessions`, `/answer`, and `/resume`
return as soon as the session row reflects the request, with the agent turn
running in the background. While it runs:

- The engine streams **live progress** through the seam's `onProgress` option
  (thinking/text deltas + tool start/end markers — a host capability any
  plugin can use). The orchestrator accumulates it per session and
  `GET /sessions/:id` attaches it as `liveActivity`, so the flow renders a
  live working pane (pulsing indicator, muted thinking, per-tool ✓/✗ lines).
- The per-turn timeout is **inactivity-based**: a long but actively-working
  turn is never killed; only a turn with no progress for `turnIntervalMs` is
  interrupted (its working trace is preserved in the transcript).
- On settle, the working trace is persisted into the conversation history as a
  condensed collapsible "Agent work" block — the transcript keeps the full
  story: opening message, every past question and answer (option ids rendered
  as labels), steering turns, working traces, and completion.

**Steering**: alongside any selectable question the user can type free-text
guidance — attached to their answer as `{value, comment}`, or sent WITHOUT
answering as `{feedback}`. The stage system prompt instructs the agent to
treat both as first-class input (incorporate, adjust course, re-ask or
proceed).

### Transport

Session updates are **pushed** over the shared `/api/events` SSE stream. The
orchestrator emits observable events via `ctx.emitEvent` (turn / question /
completed / error / interrupted, plus throttled mid-turn progress); the host
forwards them to connected clients as project-scoped `plugin:custom` events,
and the view subscribes through the `subscribePluginEvents` context capability
— refetching the session on each event (no raw `EventSource`; no deep
dashboard import). Client **polling of `GET /sessions/:id` remains as a
fallback** while a turn is mid-flight, so a missed event still converges.
Session identity is project-scoped: the `projectId` used at `start` is
threaded through every later answer/resume/poll so they resolve the same store
and live handle.

## Work → board bridge

When a stage reaches its work phase (`ce-work`, stage id `work`), its `complete`
payload may carry a derived task list. The orchestrator creates each as a Fusion
board task via `ctx.taskStore.createTask`, tagged CE-originated (source
`workflow_step` with CE markers in `sourceMetadata`) and recorded as a
**pipeline-link** row. The link row — not task-row JSON — is the authoritative
back-reference from a board task to its originating pipeline/stage/artifact
(per the FN-5719 pattern). Created tasks then run the **normal** lifecycle with
no plugin interference. Zero derived tasks is a clean no-op.

## Bidirectional sync model

Two **separate** state machines are kept in sync, never merged:

- **Board-task ownership** → the task's `column`. **The board is authoritative
  for task state.**
- **CE-pipeline ownership** → `ce_pipeline_state.{currentStage, status}`. **The
  CE flow is authoritative for artifact/pipeline content.**

**Inbound (board → pipeline).** The `onTaskMoved` / `onTaskCompleted` lifecycle
hooks do the minimum under the 5s hook budget: resolve the link and
`enqueueSync(...)`, then return. Heavy advancement is **not** done inline.

**Reconcile (the convergence guarantee).** `reconcileCePipelines(ctx)` is a
single on-demand sweep — **not** a tight interval poll. It (1) drains the queue
and (2) independently re-derives transitions by comparing live board state
against pipeline state. Step (2) is why a dropped or never-enqueued hook event
still converges: the queue is an optimization; the board↔state comparison is the
source of truth.

**Outbound (pipeline → board).** When a pipeline advances to a stage that
produces board work, the reconciler creates the next-stage board task via
`ctx.taskStore.createTask` and links it.

**Conflict policy.** The reconciler only reads the already-terminal board task
columns (board-authoritative) and only writes CE-owned fields plus a brand-new
board task — the two writers never contend over the same cell.

## Bundled-skills isolation model

The `ce-*` skills are **bundled and pinned** inside the plugin
(`src/skills/<skillId>/SKILL.md`), declared via `PluginSkillContribution` with
plugin-root-relative `skillFiles`. On load they are physically installed
(`cpSync`, idempotent skip-if-exists) into a **plugin-local, discoverable**
directory so an agent session can resolve them. The install is guarded to **never
touch a global `~/.claude/skills` path** an operator's own compound-engineering
install owns — registering the bundled copy can never clobber a global install.

## Settings

Operator-facing settings render in **Settings → Plugins → Compound Engineering**,
grouped as follows. Every setting has a real consumption point in the plugin.

### Sessions

| Setting | Type | Default | Effect |
|---|---|---|---|
| **Default Session Provider** (`defaultProvider`) | string | _(host default)_ | Passed to the interactive-session factory as `defaultProvider`. Blank → host picks. |
| **Default Session Model** (`defaultModelId`) | string | _(host default)_ | Passed to the factory as `defaultModelId`. Blank → host picks. |
| **Enabled Stages** (`enabledStages`) | string[] | full registry | Only these stage IDs may be launched; the orchestrator rejects others. |

### Sync

| Setting | Type | Default | Effect |
|---|---|---|---|
| **Reconcile on Board Changes** (`reconcileOnHooks`) | boolean | `true` | When on, the reconcile sweep auto-fires after task move/complete hooks. When off, the hook still enqueues so an on-demand sweep converges later. |
| **Reconcile Cadence (minutes)** (`reconcileIntervalMinutes`) | number | `15` | Cadence hint for an on-demand refresh surface. Not a continuous poll loop. |

Getters live in `src/settings.ts` (`getDefaultProvider`, `getDefaultModelId`,
`getEnabledStages`, `getReconcileOnHooks`, `getReconcileIntervalMinutes`), each
returning its default when the setting is absent.
