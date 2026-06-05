---
"@runfusion/fusion": minor
---

Add the CLI agent resume coordinator and self-healing integration (U8). On
engine start, sessions persisted as live (starting / ready / busy /
waitingOnInput) are classified `engineDeath` and queued for resume respecting
the session-manager concurrency ceiling. Resume verifies the recorded worktree
still exists (missing → needsAttention, never a CLI spawned into a vanished
directory), detects a dirty worktree (logged + flagged on the session record,
resume proceeds), relaunches via the adapter's `buildResume` with the recorded
native session id in the recorded worktree, re-attaches telemetry, and
re-injects no prompt. Only `crashed`/`engineDeath` are resume-eligible
(`killed`/`userExited`/`authFailed`/`completed` never); attempts are capped at 2
with backoff; exhaustion, an unsupported adapter, a missing vendor session
store, or an immediate spawn error route to needsAttention (a permanent-failure
path, not a retry loop).

Self-healing idle-worktree sweeps (`enforceWorktreeCap`, `cleanupOrphans`,
unregistered-orphan reap) now skip a worktree backing a resume-eligible
`cli_sessions` record via a narrow `isWorktreeResumeReserved` seam, and the
stuck-task detector suppresses stuck/inactivity flagging while a task's CLI
session is `waitingOnInput` via a narrow `isCliSessionWaitingOnInput` seam — the
U3 stall backstop remains the only escalation while genuinely waiting.
