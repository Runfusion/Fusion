---
"@runfusion/fusion": patch
---

summary: Return CLI chat replies to the terminal and expose dashboard inbox reads.
category: fix
dev: Reply routing now validates parent ownership, polls with deadline-aware sleeps, tracks interactive pending replies, and supports `fn message inbox --user dashboard`.
