---
"@runfusion/fusion": patch
---

summary: Executors now block on pending approvals instead of probing for ungated workarounds.
category: fix
dev: wait-for-approval now suspends the in-flight executor session via awaitAbortInFlightTaskWork and dedupes identical pending approvals; executor prompts carve out awaiting-approval as a legitimate turn end.
