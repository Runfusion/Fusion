# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

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

## Branching & diff attribution

### Integration branch
The local branch (by default the project's default branch) where the merger lands Task branches and from whose tip new Task worktrees fork. Because the merger lands commits locally before pushing, the Integration branch can be ahead of its origin counterpart by merged-but-unpushed commits — any fork-point or merge-base computation must measure against the local branch first, with the origin ref only as a fallback.

### Fork point
The commit on the Integration branch from which a Task's branch was created — the exclusive lower bound of the Task's owned changes. Every "files changed" computation diffs fork point to branch tip, so a recorded base older than the true Fork point permanently attributes predecessors' files to the Task.

### Rebase-and-push
The post-merge step that rebases locally-landed merge commits onto the upstream branch before pushing, rewriting their SHAs. The original commits become orphaned — no longer reachable from the Integration branch — while still present in the history of any Task branch forked before the push, which is why a too-old recorded Fork point cannot be recovered after this step.

### Contamination
Foreign commits — work attributed to other Tasks — appearing on a Task's branch beyond its recorded Fork point. Contamination checks must compute their reference base fresh from the Integration branch rather than reuse the Task's stored base, since a stale stored base makes every legitimately merged commit look foreign.
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

## Flagged ambiguities

- "Merging" a shared-branch-group Task had been used for both member integration and group promotion — these are distinct steps with independent gating and must not be conflated.
