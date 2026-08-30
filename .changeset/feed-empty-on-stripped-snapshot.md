---
"@runfusion/fusion": patch
---

summary: Fixes a task's Feed showing "(no activity)" when it was opened directly on the activity view.
category: fix
dev: Two mechanisms combined, each harmless alone. `stripTaskListHeavyFields` empties `log` and keeps every other field including `prompt`, so an SSE `task:updated` payload for a task with a spec carries `prompt` with `log: []`. The detail mount effect treats `"prompt" in task` as proof the prop is a complete `TaskDetail` and returns without requesting the detail — a false proxy, because `prompt` and `log` are stripped by different paths. The card then adopts a log-less snapshot as complete, and the only rescue, `refreshEmptyActivityFeed`, was bound to a segment CHANGE, so a card opening straight onto Feed (`initialTab: "logs"`, how deep links and the board activity affordance land) never triggered it and displayed "(no activity)" for the whole visit. The rescue now runs whenever an empty Feed is visible; its existing emptiness guard keeps a populated feed request-free, and a genuinely empty task asks once because the callback identity is stable while it stays empty. Covered by three regression tests: the stripped-snapshot open, an honestly empty journal that must not spin, and a prop-carried journal that must not re-request.
