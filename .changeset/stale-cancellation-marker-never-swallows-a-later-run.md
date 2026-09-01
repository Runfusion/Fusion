---
"@runfusion/fusion": patch
---

summary: Fix review cards frozen after a Retry, where a code review's revision produced no fix steps.
category: fix
dev: The FN-249 operator-cancellation exit in `handle-graph-failure.ts` honored a task-scoped in-memory `userCanceledTaskIds` marker whose only clear sites were the implementation loop and the move-into-WIP listener. A card canceled in the review lane reached neither, so the marker outlived its run and every later run exited before the FN-267 remediation claim — and the card could not reach WIP, the very move that clears the marker. The exit now requires abort evidence (pause-abort marker, abort provenance, paused row, or an interrupted node) and drops a stale marker otherwise.
