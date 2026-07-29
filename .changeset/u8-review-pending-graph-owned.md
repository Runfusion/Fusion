---
"@runfusion/fusion": patch
---

summary: The graph now parks a card in review when a step is blocked on a pending review, instead of the executor doing it.
category: internal
dev: The live implementation primitive returns `review-pending` and the step handler stops flattening it, so built-in workflows route to their `review-pending-handoff` node. The inline `handoffTaskToReview` in `runImplementation` is gone; user-authored graphs without the edge fall back to a named classifier in `handleGraphFailure`.
