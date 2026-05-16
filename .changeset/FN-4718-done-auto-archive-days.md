---
"@runfusion/fusion": patch
---

Add a new project setting `doneAutoArchiveDays` (default `0`) to control done-task auto-archive retention in days. When set to a value greater than `0`, it takes precedence over `autoArchiveDoneAfterMs` for periodic self-healing auto-archive sweeps.
