---
"@runfusion/fusion": patch
---

summary: A working agent no longer loses its task link when the card waits in a renamed planning column.
category: fix
dev: `recoverDriftedAgentTaskLinks` now passes resolved `parkedColumns` into `evaluateParkedAgentTaskLink`; the sibling sweep already did.
