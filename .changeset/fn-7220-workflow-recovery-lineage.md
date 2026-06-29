---
"@runfusion/fusion": patch
---

summary: Harden workflow graph recovery against stale plan replays and foreign landed tips.
category: fix
dev: Classifies stale in-review plan pause/resume replays and verifies task ownership before already-merged recovery finalization.
