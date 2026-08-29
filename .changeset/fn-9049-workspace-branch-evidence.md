---
"@runfusion/fusion": patch
---

summary: Prevent transient Git evidence failures from failing workspace tasks.
category: fix
dev: Replaces repoBranchExists with tri-state probeRepoBranch and an execBranchProbe seam, switches to show-ref, adds evidence-unavailable audit handling, and bounds deferred evidence retries.
