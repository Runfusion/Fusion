---
"@runfusion/fusion": patch
---

summary: Run manual feature validation and repair re-runs instead of leaving them stuck in progress.
category: fix
dev: Dispatch admitted runs through their project executor, recover transient setup failures, and fence result writes and remediation admission against stale validators.
