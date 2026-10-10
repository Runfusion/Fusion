---
"@runfusion/fusion": minor
---

summary: Let an operator correct recorded remote agent rates after a catalog fix, with an audit of who and why.
category: feature
dev: Operator decision F2=C. Frozen stamps stay frozen by default; ExternalSessionTurnRestamp rewrites only the pricing stamp and records actor, reason, and the replaced asOf/source. Unstamped turns are skipped rather than stamped for the first time.
