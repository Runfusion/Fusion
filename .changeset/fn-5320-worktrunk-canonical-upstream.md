---
"@runfusion/fusion": patch
---

Fix the Worktrunk integration to probe the canonical `wt` binary, point release metadata at the real `max-sixty/worktrunk` upstream, and fail closed when install metadata is still unverified. This preserves default-off behavior when `worktrunk.enabled=false` and hardens enabled setups that rely on an explicit `worktrunk.binaryPath`.
