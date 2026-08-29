---
"@runfusion/fusion": minor
---

summary: Remove stuck-task tagging from the dashboard — no more Stuck badges, card styling, or footer stuck count.
category: feature
dev: "Deletes utils/taskStuck.ts, the stuck ExecutorStats field, and taskStuckTimeoutMs prop plumbing; the setting remains and engine recovery sweeps still consume it. Also repoints the FN-6756 liveness ratchet at the extracted executor session facades."
