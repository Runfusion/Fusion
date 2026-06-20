# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Settings & Localization

### Surface
One of Fusion's user-facing frontends — the browser dashboard and the terminal TUI. Surfaces have independent runtimes and rendering stacks but are expected to share user-level state: a setting changed on one surface (theme, language) carries to the other.

### Global Settings
User-level settings persisted server-side that apply across all Surfaces and all projects, as opposed to per-project settings. Values are validated at the write boundary — an invalid value is dropped rather than persisted — so every reader can trust what it loads.

### Workflow Setting
A typed setting declared by a workflow in its IR (id, type, default, options), mirroring the custom-task-field shape. Declarations describe the schema; *values* persist per workflow + project through a single validating store authority, so built-in workflows can carry values without their IR being editable. The engine consumes **effective settings** — stored value falling back to declaration default, with values that no longer validate against the current declaration dropped (never fed to execution).

### Effective Settings
The per-task, flat `Partial<Settings>`-shaped value map the engine reads at executor entry, composed from the task's resolved workflow: for each declared Workflow Setting, the stored `(workflowId, projectId)` value falls back to the declaration default, with stored values that no longer validate against the current declaration dropped. Resolution never throws — a missing or corrupt workflow degrades to the built-in coding declarations — so every read site receives a usable value. Because built-in declaration defaults are byte-equal to the legacy project-settings defaults, an untuned project resolves to identical behavior across the settings hard-move.

### Moved Settings Keys
The tombstone allowlist (`MOVED_SETTINGS_KEYS`) of the step-execution, review/approval, and per-phase model-lane keys that the one-time hard-move migration relocated from project/global settings into Workflow Settings. It is the single record of the old names and shields every surface that can encounter a legacy payload — cross-node sync diffs, v1 settings imports, and stale writers — from resurrecting a moved key. A consistency test enforces that a key lives in exactly one regime (project settings *or* the tombstone list, never both).

### Three-Tier Setting
The named persistence pattern for a user preference on the dashboard: a device-local cache for instant reads, a write-through to Global Settings so other Surfaces see it, and a hydrate-on-mount from the server when no local value exists. A local or in-flight user choice always wins over server hydration, and changes propagate to other open tabs.

### Translation Placeholder
An empty-string value for a catalog key in a non-English locale, marking "not yet translated." Placeholders are intentionally backfilled when keys are added; at runtime they are treated as missing (never rendered), falling back through the locale chain to English. A non-empty value — even an English one left in a non-en catalog — is rendered as-is.

### Supported Locale
A language tag in the closed set Fusion ships translations for. Any external tag (browser, environment, flag) is normalized into this set or rejected — never passed through raw. Chinese tags route by script and region so Traditional-script users are never silently served Simplified, and the two Chinese variants never collapse into a generic base tag.

## Missions

### Relationships

A Mission owns an ordered list of Milestones; a Milestone owns an ordered list of Slices; a Slice owns a set of Features. Status rolls **up**, not down: a Slice's status is derived from its Features, a Milestone's from its Slices, and a Mission's from its Milestones. Autopilot acts at the Slice boundary — it advances a Mission by activating the next Slice once the current one is complete.

### Mission
A unit of autonomous, multi-step work the system plans and then drives to completion on its own, decomposed into Milestones. A Mission may run under Autopilot or be advanced manually.

### Milestone
An ordered phase of a Mission, containing Slices and optionally depending on earlier Milestones. A Milestone is complete only when all of its Slices are complete.

### Slice
A vertically-scoped, independently-completable chunk of a Milestone, containing Features. A Slice's status is derived from its Features and reaches *complete* only when every Feature counts as done — which, for a Feature carrying Contract Assertions, requires a passing Validator Run.

### Feature
The smallest unit of mission work: a single deliverable evaluated against its Contract Assertions. A Feature carries both a board status (its workflow column, e.g. done) and a loop state (its execution phase); the two are distinct and can legitimately disagree mid-flight, but a done Feature that never reached a terminal loop state is an invariant violation that will stall its Slice.

### Fix Feature
A Feature auto-generated from a failed Validator Run to carry the remediation work for the assertions that failed, linked back to the Feature it descends from.

## Projects

### Project
A registered workspace that Fusion can operate on: it has a canonical local path, project-scoped settings and data, and must be backed by a usable Git work tree before task execution can create worktrees from it.

### Project Identity
The durable identity a registered Project carries locally so it can be reattached to the central registry after central state is lost or rebuilt, preserving rows keyed by the same project id instead of minting a replacement.

### Project Registration
The process that creates or reattaches a Project in Fusion's central registry for a local path. Registration is a readiness boundary: it should complete only when the path satisfies the invariants later execution depends on, such as being a Git work tree.

## Mission execution

### Autopilot
The named process that watches an active Mission and advances it — activating the next pending Slice once the current Slice completes — while tracking its own watching/activating lifecycle and handling retries. When Autopilot is not watching a Mission, slice advancement falls back to a compatibility path.

### Contract Assertion
A checkable acceptance criterion linked to a Feature that an AI validator judges to decide whether the Feature is genuinely done. Every Feature is validator-evaluated — a Feature missing an assertion has one lazily linked before validation — and counts toward Slice completion only after a passing Validator Run.

### Validator Run
A single execution of the AI judge that evaluates a Feature's Contract Assertions and yields a pass, fail, blocked, or error outcome. The validator is read-only — it inspects the implementation and records a verdict, creating no board task and editing no code. A run left running after its owner disappears is reaped to a terminal error state.

### loop state
A Feature's position in the execution loop (being implemented, awaiting or undergoing validation, awaiting a fix, passed, or blocked), distinct from its board status. Logic that gates on loop state must treat it as possibly stale and possibly contradictory with status — a Feature can be marked done while its loop state was never advanced past implementing.

## Merge lifecycle

### Task
The core board entity: a unit of work that moves through columns (triage, todo, in-progress, in-review, done, archived) and is executed by agents. A Task carries its own per-task settings that can override project-level defaults.

### Workflow Runtime
The authoritative task lifecycle runtime. It resolves a Task to workflow IR, walks the graph, routes node outcomes, and invokes runtime primitives for side effects. The engine substrate still owns scheduling, routing claims, persistence, concurrency, process supervision, storage, and audit plumbing; lifecycle policy lives in workflow nodes and built-in workflow IR.

### ACP Ask Path
A one-turn read-only model ask routed through the ACP runtime rather than a CLI print mode. The runner accumulates streamed prose, may recover a trailing JSON object for structured seams, and treats abnormal ACP stop reasons as incomplete answers for validator use.

### Claude Bridge
The pinned `claude-code-cli-acp` subprocess bundled with the ACP runtime plugin. It speaks ACP over stdio to Fusion while driving the real interactive `claude` through a PTY, and is resolved from the plugin-owned `node_modules` tree rather than PATH.

### Runtime Primitive
A named, injected operation a workflow node can call to perform side effects without depending on `executor.ts` lifecycle branches. Examples include planning session, coding session, step execution/reset, review, verification, workflow step, transition, merge request, abort, and audit. Primitives are the boundary between workflow policy and engine substrate.

### Built-in Lifecycle Node
A node in a built-in workflow that expresses default Fusion behavior, such as planning, execute, review, merge, parse-steps, step-review, or PR lifecycle actions. Built-in lifecycle nodes are the compatibility layer for existing behavior: changing default execution means changing the built-in workflow and its primitive wiring, not adding hidden imperative branches.

### Recovery Event
A workflow-observable condition that requires recovery policy, such as implementation incomplete, review unavailable, merge timeout, manual merge required, integration conflict, or hard cancel. Recovery may use engine primitives for aborting processes, writing audit entries, resetting steps, or parking tasks, but the routing decision belongs to workflow logic.

### Auto-merge
The named process that automatically lands a completed Task's branch onto its merge target once the Task reaches In-review and passes its merge blockers. Gated twice: a project-level setting enables it globally, and each Task may carry an explicit per-task override.

The per-task override takes precedence in both directions: an explicit per-task enable proceeds even when the global setting is off, and an explicit per-task disable routes the merge to Manual-required even when the global setting is on. Trigger-layer gates (enqueue, Self-healing sweeps) must evaluate additively — global on lets everything through for downstream routing; global off admits only explicit per-task enables — rather than collapsing the override to a single effective value, which would starve Manual-required routing.

### In-review
The Task status column between execution and completion: work is done and the branch awaits merging. An In-review Task either auto-merges, waits for a human merge (PR-based/manual flow), or surfaces a stall diagnostic when it sits unprocessed longer than expected. Tasks not eligible for Auto-merge processing intentionally remain In-review until a human acts — recovery sweeps must not move them.

### Merge queue
The ordered line of In-review Tasks awaiting Auto-merge, with a single merge active at a time. Tasks enter only through trigger gates (engine startup sweep, periodic retry, unpause, and the moved-to-review fast path); a Task filtered out at a gate is invisible to the merger regardless of its own settings.

### Manual-required
The merge-request state for a Task whose merge needs an explicit human go-ahead — typically a Task with auto-merge explicitly disabled under a globally-enabled project. Reaching this state requires the Task to flow through the Merge queue trigger gates; upstream filtering that excludes such Tasks strands them In-review instead of parking them here.

### Self-healing sweep
A recurring background scan that detects and repairs stuck Task states — stalled In-review Tasks, confirmed merges never finalized, ghost or limbo states, exhausted retries. Sweeps respect the same Auto-merge eligibility as the Merge queue: they may inspect any Task but mutate only those eligible for auto-merge processing.

Sweeps must honor the same merge-target rules as the normal path — a Shared branch group member is always evaluated against its group branch, never the project default — and attribution of already-merged work must be anchored to commit ownership markers, not free-text matches.

### Shared branch group
A cohort of Tasks integrating into a common shared branch instead of each merging straight to the project's default branch. The group — not its member Tasks — owns the shared branch name, the managed PR identity, and the group lifecycle (open, finalized, abandoned); members reference their group by the group's stored id, never by a derivable string. Member integration (task branch → shared branch) is a soft pre-integration step exempt from the global auto-merge gate; Group promotion (shared branch → default branch) is gated separately.

The group's shared branch is only ever a merge *target*; it is never any member Task's working branch. Each member works on its own per-task branch and lands onto the group branch.

### Branch assignment mode
The strategy by which a Task acquires its working branch and merge target. Shared mode gives the Task a per-task working branch derived from the group's shared branch and sets the shared branch as merge target; per-task-derived mode gives a derived working branch with no shared target; the remaining modes (project default, existing, custom new) bind the Task directly to a named branch. Only shared mode creates Shared branch group membership.

### Landed
The status of a Shared branch group member whose work is merge-confirmed onto *its own group's* shared branch via the branch-group integration path. A member merged onto any other branch — a sibling task branch, the project default — is not Landed, regardless of its column. A group is complete when it has at least one member and every member is Landed; completeness gates Group promotion.

### Group promotion
The completion-gated, idempotent act of carrying a complete Shared branch group forward: merging the group branch toward the project's integration branch and, in pull-request mode, creating-or-reusing the group's single managed PR. Re-running a promotion never creates a second PR. Under disabled auto-merge, promotion is an explicit user action; member-to-group landing may still proceed without triggering it.

### PR entity
The single first-class record of a pull request fusion manages, regardless of how the work landed — a lone Task or a Shared branch group each produce one PR entity with one lifecycle (open, responding, approved, merged/closed). It is how the group's "managed PR identity" is actually realized. Every state the entity shows must be corroborated by GitHub; fusion never persists speculative PR state, and a continuous reconciliation absorbs out-of-band changes made directly on GitHub.

### Review-response loop
The named process by which fusion acts on review feedback arriving on a PR entity: new comments and review threads from humans or bots dispatch an agent that either fixes the issue, pushes to the PR branch, and replies to the thread, or disagrees — posting its reasoning as a PR comment and leaving the thread open. Runs without a human gate between feedback and push; the human checkpoint is merge (unless Auto-merge is enabled).

## Branching & diff attribution

### Integration branch
The local branch (by default the project's default branch) where the merger lands Task branches and from whose tip new Task worktrees fork. Because the merger lands commits locally before pushing, the Integration branch can be ahead of its origin counterpart by merged-but-unpushed commits — any fork-point or merge-base computation must measure against the local branch first, with the origin ref only as a fallback.

### Fork point
The commit on the Integration branch from which a Task's branch was created — the exclusive lower bound of the Task's owned changes. Every "files changed" computation diffs fork point to branch tip, so a recorded base older than the true Fork point permanently attributes predecessors' files to the Task.

### Rebase-and-push
The post-merge step that rebases locally-landed merge commits onto the upstream branch before pushing, rewriting their SHAs. The original commits become orphaned — no longer reachable from the Integration branch — while still present in the history of any Task branch forked before the push, which is why a too-old recorded Fork point cannot be recovered after this step.

### Contamination
Foreign commits — work attributed to other Tasks — appearing on a Task's branch beyond its recorded Fork point. Contamination checks must compute their reference base fresh from the Integration branch rather than reuse the Task's stored base, since a stale stored base makes every legitimately merged commit look foreign.

## Chat

### Generation
A single in-flight assistant turn for a chat session, owned server-side and identified by a generation id. At most one Generation runs per session: starting a new one aborts whatever Generation is still active for that session, so an "extra" send from a client is never harmless. A Generation periodically persists an in-flight snapshot so a reconnecting client can recover the streaming UI.

### Queued message
A follow-up the user sends while a Generation is active. It is held client-side (and persisted per session so navigation cannot lose it) and flushed — actually sent — only when the session's Generation settles. Flushing decisions must be made against the server's authoritative generation state, not a locally cached copy.

### Enrichment field
A session field computed at the API route from live server state (whether a Generation is running, last-message preview) rather than stored on the session row. Enrichment fields exist only in responses from enriching endpoints: store-event payloads and SSE broadcasts lack them, so a client that overwrites its session state from those sources silently degrades enrichment fields to absent — any side-effecting decision gated on one must re-fetch from an enriching endpoint.

## Compound Engineering sessions

### CE Stage
A registered step of the compound-engineering pipeline (e.g. brainstorm, plan, work, compound), each mapped to a bundled skill and a conventional artifact location. Adding a stage is a registry data entry, not new code surface.

### CE Session
A single interactive run of a CE Stage: an agent drives a question/answer flow with the user and produces the stage's artifact on completion. Sessions are independent pipeline runs — many can exist concurrently, each with its own lifecycle (launching, active, awaiting-input, completed, error, interrupted) and conversation history. A completed work-stage CE Session lands derived Tasks on the board, linked back to the session for provenance.

### Detached turn
The execution posture for CE Session agent turns: the request that triggers a turn returns as soon as the session reflects it, and the turn runs in the background while clients converge through push events and polling. A detached turn never rejects — every failure persists into session state and emits an observable event, so progress is never silently lost.

### Live activity
The transient working output of an in-flight agent turn — accumulated thinking, streamed text, and tool execution markers. It is observable while the turn runs but is not session state; when the turn settles or is interrupted, a condensed trace is folded into the conversation history so the transcript keeps the story.

### Steering
The user's mid-stage feedback channel: free-text guidance attached to an answer, or sent on its own without answering the pending question. Agents treat steering as first-class input — incorporate it, adjust course, and either re-ask or proceed.

### Rehydration
Re-establishing a live agent handle for a paused CE Session by replaying its recorded conversation against the model. Replay is side-effect-suppressed: it reconstructs the agent's context without re-emitting events, re-streaming Live activity, or re-writing artifacts.

## Plugins

### Bundled Plugin
A plugin that ships inside the Fusion distribution itself rather than being installed from a user-supplied path — it appears under Settings → Built-in Plugins and can be auto-installed at startup.
*Avoid:* built-in plugin (as a distinct concept; the Settings label uses "Built-in" for the same thing)

A Bundled Plugin must be registered in several independently maintained surfaces — the Settings catalog, the dashboard server's bundled-id fallback set, the CLI's startup auto-install list, and the build step that stages a loadable copy into the distribution. The surfaces do not cross-check each other: a plugin registered in some but not all appears installable yet fails to install or load, so adding one means mirroring an existing bundled plugin across every surface.

### Plugin Entry
The single loadable file persisted as a plugin's path and dynamically imported by the loader. The contract is strict: a package directory is never a valid entry (ESM cannot import directories), so every install surface must resolve a concrete file before persisting, preferring the shipped bundle, then a prebuilt output, then raw workspace source. Legacy registrations that stored a directory are healed in place — re-pointed at a resolved entry — the next time the plugin is enabled or auto-installed.

### Plugin Registry Entry
A dashboard discovery record served from `GET /api/plugins/registry` and shown in Settings → Plugins → Browse Registry. It is metadata-first (`id`, `name`, `description`, `category`, optional version/author/homepage) and may include a concrete Plugin Entry `path`.

### Registry Installability
The server-derived `canInstall` flag for a Plugin Registry Entry. `canInstall: true` means the manifest entry has a concrete `path` and the dashboard can call the normal plugin install flow; `canInstall: false` means the entry is discovery-only and should be presented as Coming Soon instead of attempting installation.

### Workflow Extension
A plugin-contributed workflow capability registered through the engine rather than hardcoded into core workflow logic: column metadata, movement policies, column work engines, workflow node handlers, task verdict providers, or merge-routing facts. A Workflow Extension is opt-in by workflow metadata and must degrade or park by an explicit fallback policy when its plugin is disabled or missing, preserving the Default workflow baseline when no extension is active.

## Workflow columns & traits

*Controlled by the default-on `experimentalFeatures.workflowColumns` flag. With an explicit flag-off override, the legacy fixed pipeline (the closed column enum + `VALID_TRANSITIONS`) is authoritative and unchanged.*

### Column (workflow-defined)
A first-class, workflow-defined unit of task state: an id, a display name, and a set of Trait configurations. A Task's board position is its current column, persisted in `tasks."column"`. Column validity is workflow-scoped — the legacy closed enum widens to a string validated against the Task's resolved workflow. The Default workflow's column ids are byte-identical to the legacy enum values, so no task row is ever rewritten.

### Trait
Composable column configuration: declarative flags (e.g. `complete`, `archived`, `countsTowardWip`) plus optional lifecycle hooks (`guard`, `gate`, `onEnter`, `onExit`, `releaseCondition`). Built-in and plugin-contributed traits register through one registry. Sync `guard` hooks and the `complete`/`archived` flags are built-in-only; plugin traits get async hook points only. A column's effective flags are the merged flags of its traits; conflicting compositions are rejected at save (server-side and in the editor).

### Column agent
A permanent agent binding on a workflow-defined column — a registry agent plus a mode — staffing all session-running work attributable to that column (custom nodes, the execute seam's coding session, per-step sessions; foreach template nodes inherit the enclosing foreach's column unless they declare their own). `defer` makes the column agent the default, applying only when the work carries no own agent identity and no complete model pair; `override` supersedes node- and task-level agent/model settings wholesale.

Requires both the workflow-columns and graph-executor flags; with either off, bindings are inert at execution time. A missing or deleted agent degrades to normal resolution without aborting a live session. Binding an agent whose permission policy is broader than the project default requires explicit confirmation at save time on every write surface.

### Effective agent (execution principal)
The agent identity that actually runs a piece of work after column-agent precedence resolves — and the principal every identity-keyed subsystem must consult: permission gating, heartbeat serialization in both directions, resume re-dispatch, and mid-flight change detection. It may differ from the task's assigned agent under an override binding, and one task may have multiple effective agents across concurrent branch sessions.

### Lane
A horizontal row on the multi-lane board, one per workflow in use by visible cards. Each lane renders its own workflow's columns. Tasks with no workflow selection appear in the Default workflow's lane; every card appears in exactly one lane. Zero-card lanes are hidden; lanes are collapsible with persisted state.

### Hold node
A workflow node kind expressing passive dwell — a card rests in its column until a release condition fires: manual promote, timer, downstream capacity available, dependency satisfied, or external event. Hold release is evaluated by a substrate sweep (the generalized scheduler), which reserves worktree + semaphore slots before issuing the release move.

### Split / Join
Parallel-branch node kinds. A `split` launches its outgoing edges concurrently; a `join` synchronizes them with `mode: all | any | quorum(n)` and `onBranchFailure: fail-fast | collect`. During the parallel window the card stays in the split's column (its board position never forks); on join resolution it advances to the join's column. `execute`/`merge` seam nodes are forbidden inside branches (one worktree/session per task; merge is exclusive). Per-branch run state persists in SQLite so a crashed branch resumes where it died.

### Default workflow
The built-in workflow (`builtin:coding`) that reproduces the legacy pipeline verbatim: six columns whose ids equal the legacy enum values, with traits matching legacy semantics (`triage`=intake, `todo`=hold+reset-on-entry, `in-progress`=wip+abort-on-exit+timing, `in-review`=merge-blocker+stall-detection+merge, `done`=complete, `archived`=archived). A null workflow selection resolves to it at read time. Non-editable, non-deletable.

### transitionPending
A persisted crash-safe marker (`tasks.transitionPending`) written in the same transaction as a column change, recording the post-commit hooks (`hooksRemaining`) that still owe idempotent execution. Cleared once they complete. Recovery reads it exclusively from SQLite (the authoritative store); a crash mid-transition re-runs the idempotent hooks. A throwing or missing hook degrades (audit) and clears its entry — it never strands the card or wedges the task lock.

## Step inversion

*Controlled by the default-on `experimentalFeatures.workflowGraphExecutor` flag (orthogonal to `workflowColumns`). With an explicit flag-off override, and for the Default workflow always, step policy is the legacy engine-owned path (PROMPT.md parsing, in-session review verdicts, RETHINK reset) — unchanged.*

### Step instance
One runtime expansion of a `foreach` template subgraph, bound to a single planned step (`Task.steps[i]`). Identity is deterministic — `<foreachNodeId>#<stepIndex>:<templateNodeId>` — so resume reconstructs the full instance set from the pinned step count without persisting the expansion itself. Each instance carries its own run-state (current node, rework count, baseline/checkpoint, and in worktree mode its branch and integration status) in its own persisted run-state table. The step count is pinned at expansion; a later disagreement with the live step list is a `pin-mismatch` failure, never a silent re-expansion. An instance's lifecycle writes flow through `store.updateStep` so `Task.steps[]` stays the physical projection sink for every existing consumer.

### parse-steps
A workflow graph node that reads a declared Artifact and runs a registry parser to write the canonical step list (`Task.steps[]`) — the only graph-side writer of steps. Built-in parsers are `step-headings` (the `### Step N:` convention, extracted byte-identically from the legacy regex, including the `(depends: N,M)` annotation) and `json-steps`; plugins contribute parsers under `plugin:<pluginId>:<parserId>`. Parsing failures fail closed to a routable `outcome:parse-error` rather than crashing. A parse-steps node must dominate (precede on all paths) any `foreach(source:"task-steps")`, and running one after a foreach has already expanded trips pin protection (an audited failure) so re-plan loops cannot desynchronize an expanded region.

### Custom task field
A workflow-declared, typed task field (`string | text | number | boolean | enum | multi-enum | date | url`, with enum options and render hints) whose values live in `tasks.customFields`, keyed by field id. The task model is thereby recast as core fields (title, description) + standard metadata + these workflow-defined fields. Writes pass through a single store authority (`updateTaskCustomFields`) that validates each value against the resolving workflow's schema and returns typed rejections (offending `fieldId` + `code`); agents write them via `fn_task_update`'s `custom_fields` patch. Editing a workflow's fields or switching a task's workflow orphans (never destroys) values for removed or type-incompatible ids — orphans are retained and surfaced under a detail disclosure, excluded from cards. Same id means the same field within a project; there is no cross-workflow shared field namespace.

## Persistence & migrations

### Schema-Version Sweep
The named process performed atomically with any bump of the core schema-version counter: a repo-wide hunt for hard-coded assertions of the old version number, updated in the same commit as the bump. The sweep's scope is every workspace that can embed the core database — packages *and* plugins — because any package instantiating the core store observes the current version; scoping the hunt to one workspace silently strands assertions in the others. Downstream consumers should prefer asserting against the exported version constant instead of a literal, which removes them from the sweep entirely.
## CLI executor

### CLI Executor
The executor type `cli-agent`: a Fusion agent session (task execute step, planning, validator, CE plugin session, or chat) driven by an interactive CLI coding agent running in a Fusion-owned PTY. Distinct from the pre-existing non-interactive `cli` executor kind (the named-script/raw-command runner). Selected on the workflow node for task surfaces (per-task override) and per session for chat/CE. The board lifecycle is unchanged — the terminal is the execution surface, not a separate workflow.
*Avoid:* `cli` as the executor identifier — that name is taken by the script-runner kind.

### CLI Adapter
The per-CLI integration that launches and understands one CLI agent. Native-telemetry adapters (Claude Code, Codex, Droid, Pi) tap the CLI's own hooks/session logs for precise agent state, structured transcript, and native session identity; the generic adapter runs any CLI command with heuristic idle detection and a raw-terminal-only view. Adapters carry their own launch configuration (command, args, permission mode) with shipped defaults.

### CLI Session
A server-owned PTY bound to a task or chat entity. It survives client disconnects, supports concurrent attach from any surface, and carries an agent state (starting, ready, busy, waiting-on-input, done, dead). Its CLI-native session ID is persisted so a dead PTY or engine restart resumes via the CLI's own resume mechanism — needs-attention is the fallback when resume fails, never the first response.

### Waiting-on-input
The CLI Session state where the agent is blocked on the human (permission prompt, clarifying question), as distinct from idle-because-done. Entering it fires the notification configured on the workflow node; the task neither advances nor fails while in it.
## Testing

### Merge Gate
The minimal set of merge-blocking PR checks: lint, typecheck, build, a Boot Smoke, and a small curated engine test suite. The gate is the only test signal that can block a PR; all other tests run non-blocking after merge.

Gate membership is an explicit allow-list, never a glob: a test earns its slot with evidence of value and never graduates in by default. A flake inside the gate is *evicted* — its allow-list entry is removed — which deliberately requires no green run from the flaky test itself, so the gate can always be repaired while red.

### Affected-package test selection
How `pnpm test` chooses what to run against the working diff. In *changed mode* it runs the Merge Gate suite plus the workspace packages the diff touched and their dependents; in *gate mode* it runs only the Merge Gate suite. A change to shared test infrastructure routes to gate mode, which *replaces* changed-package coverage rather than adding to it — so a diff that trips the shared-infra signal but only edits data files gets no coverage of its own packages until that file is allow-listed as test-irrelevant.

### Boot Smoke
The gate's "app starts and serves" proof: the CLI answers its help command and a real server boots on a throwaway port, answers its health endpoint, and shuts down cleanly on signal. A pass requires both that the shutdown signal was actually delivered and that the exit was clean — a crash after serving is a failed boot path, not a pass.

### Deletion Ratchet
The standing policy for flaky tests: a test observed failing without a corresponding real bug is quarantined on sight — a dated ledger entry plus exclusion from all runs, not retried, not patched — then deleted 2 weeks later unless rescued with evidence it catches real regressions plus a root-cause fix. Appeasement (widened timeouts, added retries, loosened assertions) is prohibited, for agents especially.

A second quarantine in the same subsystem is a product-race smell: the flake may be a real bug, so the product code gets a look before the deletion clock runs out. Gate flakes exit by Merge Gate eviction rather than quarantine, unless they should also leave the non-blocking tier.

## Flagged ambiguities

- "Merging" a shared-branch-group Task had been used for both member integration and group promotion — these are distinct steps with independent gating and must not be conflated.
