---
"@runfusion/fusion": minor
---

summary: Make revision findings the only authority that moves tasks backward.
category: breaking
dev: Removes blocked-exit auto-replan; execution-resume, stale-spec-replan, blocked-exit-replan, missing-required-artifact-recovery, and workflow-retry-rehome reasons; ghost-review, stale-incomplete-review, terminal-failure, in-progress-limbo, and zero-progress no-task-done sweeps; executor stuck-kill terminalization and use of maxStuckKills (retained for triage); and their terminal-failure, no-progress, and in-progress-limbo audit events.
