---
"@runfusion/fusion": patch
---

summary: Stop AI Engine now actually stops the workflow graph, and the worktree cap counts planning/review holders.
category: fix
dev: Two capacity-control regressions. (1) The graph interpreter never re-read settings, so globalPause did not stop node traversal — new Plan Review sessions started under pause; every node entry now polls an isPaused probe and suspends via the durable-continuation mechanism (reason "pause"), and the continuation drain refuses to dispatch while paused. (2) The scheduler's maxWorktrees ledger counted only WIP cards; under plan-in-place, planning/review lanes hold real worktrees, and the deleted global semaphore had been the accidental protection — the ledger now counts every non-terminal task holding a worktree.
