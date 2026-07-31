---
"@runfusion/fusion": patch
---

summary: Glasses completion notifications now recognise a board whose finished lane is not called Done.
category: fix
dev: `diffSnapshots` declared a per-task `completeColumnsByTaskId` that no caller ever built, so its completion test fell through to the literal `"done"`. `notifier.ts` now builds it (per task, with a shared IR cache, and only when `alsoNotifyOnDone` is on). The `unwired-lane-parameter` guard now scans `plugins/`, walks inline options-object types, and scopes its "is it wired" search to files that name the declaring symbol — which surfaced 17 further unwired declarations, now recorded as a ratcheted baseline.
