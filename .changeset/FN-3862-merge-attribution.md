---
"@runfusion/fusion": patch
---

Stop overwriting canonical merge commit SHAs on already-done tasks during self-healing reconciliation. Confirmed `mergeDetails.commitSha` is now preserved as authoritative; rediscovery for unconfirmed done tasks prefers the earliest owned commit so the original merge commit wins over later follow-up commits sharing the same `Fusion-Task-Id` trailer.
