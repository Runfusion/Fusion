---
"@runfusion/fusion": patch
---

summary: Fix execution retry, escalation and loop protection silently doing nothing on renamed-column workflows.
category: fix
dev: `handleGraphFailure`'s execution-policy ladder (FN-7863/FN-7926 dispatch-loop gate, FN-7996 tool-failure retry, FN-7998 escalation) resolved hold/wip through U1's `resolveTaskLifecycleColumns` instead of the literals `"todo"`/`"in-progress"` at 9 sites. The wip literal made the whole ladder unreachable: a card in a renamed implementation column was classified "already advanced" and its graph failure was swallowed. A workflow that declares no hold/wip column resolves through KTD-10 rebound ordering or fails closed to a visible terminal park — never to an invented column; only an unreadable workflow keeps the legacy literals.
