---
"@runfusion/fusion": patch
---

summary: Planning admission now respects the worktree cap — no more 8 planners on a 4-worktree board.
category: fix
dev: Triage admission gated only on the agent count; every planner acquires a real worktree, and the merge-drain freeze (00769fad7c) had been accidentally masking the gap. Admission now budgets min(agent room, worktree room) with the transfer rule (a replan candidate holding its worktree spends no fresh slot); the FN-8600 throttle event names "worktree cap" when it binds. Approximation note: per-candidate budget pairing assumes admitOldest's age order matches the eligible list; small transient skews self-correct on the next 15s poll.
