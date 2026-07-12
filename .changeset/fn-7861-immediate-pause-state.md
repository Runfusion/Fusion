---
"@runfusion/fusion": patch
---

summary: Unpausing (and pausing) a task now updates the board immediately.
category: fix
dev: useTasks pauseTask/unpauseTask patch shared task state + SWR cache on API success (FN-7861), mirroring retryTask/bypassReview; no longer waits for SSE/poll.
