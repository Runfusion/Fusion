---
"@runfusion/fusion": minor
---

summary: Show what each remote agent turn cost and how much of the model's context it used.
category: feature
dev: The turn parser records measured per-request usage against its turn, keyed by message id. Turn cost is priced through the same priceUsage seam as session cost; a turn with no reported usage is unpriced rather than apportioned a share of the session total.
