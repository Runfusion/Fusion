---
"@runfusion/fusion": patch
---

summary: Queued cards stop waiting behind a permanently starved tail; slow capacity sweeps get cheaper.
category: performance
dev: Two changes to the hold-release sweep. (1) Budget truncation now rotates: the cards a truncated pass never evaluated are evaluated first on the next pass, reported as `rotated-deferred=N` (bounded tail, self-clearing once a pass fits its budget). Previously the deterministic queue order re-skipped the same tail every pass (`budget-truncated unevaluated=444` with `released=0`). (2) Pass-invariant capacity facts are derived once per pass — the final-claim snapshot is memoised per scheduler pass and both capacity dimensions share one workflow-IR/selection cache (measured: second candidate at the admission gate went from 250 extra selection reads on a 250-card board to 1). Same-pass admissions are unioned into the claim set, so this cannot over-admit. Step 1's `slot-calls=N` and `slot-detail=(…)` attribution fields and the RUFU-209 reconciling bucket list are unchanged; no release decision, capacity limit, lease lifetime, held clock, or budget constant changed.
