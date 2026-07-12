---
"@runfusion/fusion": patch
---

summary: Stop logging a false "operator action required" pause-abort failure on tasks that already merged and completed.
category: fix
dev: handleGraphFailure's operator-action sink now classifies pause-aborts on done/archived tasks as benign (marker cleared, worktree slot released, no PAUSE_ABORT_PARK log) — the merge boundary's in-progress→in-review hard-cancel fired it on every successful auto-merge.
