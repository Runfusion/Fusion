---
"@runfusion/fusion": patch
---

summary: Hold-release sweep line now names what the capacity-reservation leg costs and how often it ran.
category: performance
dev: Adds `slot-calls=N` and an optional `slot-detail=(slot:dispatch-guard=…, slot:claim-snapshot=…, slot:admission=…, slot:residual=…)` group after the reconciling parenthesis in the `Hold-release sweep:` line; the existing `(release-config=…, slot=…, unattributed=…)` bucket list and its reconciliation to `evaluate` are unchanged, and no release decision, capacity limit, or lease lifetime changed.
