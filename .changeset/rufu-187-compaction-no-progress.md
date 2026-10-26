---
"@runfusion/fusion": patch
---

summary: Context compaction that frees no space is now refused honestly instead of logged as a success.
category: fix
dev: RUFU-187 — `compactSessionContext()` gains a `no-progress` arm for a compaction that returned a summary but left tokens-after >= tokens-before, measured on a `pi-reported` basis when pi supplies an after-count, else on a `pure-estimate` basis recomputed with pi's own per-message estimator (gated on a positive pre-compaction message estimate, so an empty message list is never laundered into a refusal — an unmeasurable pass stays `measurement-unknown` in the guard). The chat pre-overflow guard routes it through the existing `non-reducing-summary` lane rather than inventing a second refusal shape. The executor's compact-and-resume and token-cap lanes refuse it: the attempt ceiling is still burned but without the pending-resume flag so the next detection fast-fails into dispose+requeue, the token-cap callback returns `null` so the detector's threshold math is not fooled, and both replace the old "freed N tokens" / "Context compacted at N tokens" claim with an honest "reduced nothing (before=/after=)" card line plus one bounded `task:compaction-no-progress` run-audit event via `emitBoundedRunAudit` ({ source, tokensBefore, tokensAfter, basis }).
