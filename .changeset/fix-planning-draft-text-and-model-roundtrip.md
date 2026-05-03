---
"@runfusion/fusion": patch
---

Fix planning draft sessions losing the user's typed text and model selection between draft create, sidebar reopen, and Start Planning. The agent now receives the freshest persisted `initialPlan` (not the truncated cache from when the draft was first auto-created), drafts that survive a backend restart can still be started, and the model override the user picked at draft time is restored when reopening from the sidebar and threaded through summarize. The sidebar shows a per-draft preview derived from `inputPayload` so multiple drafts are distinguishable while still hiding raw keystrokes from the persisted title, and titles get re-summarized on textarea blur and modal close so they reflect the final text rather than locking to the first blur snapshot.
