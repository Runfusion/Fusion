---
"@runfusion/fusion": patch
---

summary: Fix task runtime chips that over-counted active time after review/replan round-trips.
category: fix
dev: Clear executionStartedAt when banking cumulativeActiveMs on WIP exit; clamp active-time readers to wall-clock age.
