# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Settings & Localization

### Surface
One of Fusion's user-facing frontends — the browser dashboard and the terminal TUI. Surfaces have independent runtimes and rendering stacks but are expected to share user-level state: a setting changed on one surface (theme, language) carries to the other.

### Global Settings
User-level settings persisted server-side that apply across all Surfaces and all projects, as opposed to per-project settings. Values are validated at the write boundary — an invalid value is dropped rather than persisted — so every reader can trust what it loads.

### Three-Tier Setting
The named persistence pattern for a user preference on the dashboard: a device-local cache for instant reads, a write-through to Global Settings so other Surfaces see it, and a hydrate-on-mount from the server when no local value exists. A local or in-flight user choice always wins over server hydration, and changes propagate to other open tabs.

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

### Shared branch group
A set of Tasks integrating into a common shared branch instead of each merging straight to the project's default branch. Member integration (task branch → shared branch) is a soft pre-integration step exempt from the global auto-merge gate; promotion (shared branch → default branch) is gated separately.

## Flagged ambiguities

- "Merging" a shared-branch-group Task had been used for both member integration and group promotion — these are distinct steps with independent gating and must not be conflated.
