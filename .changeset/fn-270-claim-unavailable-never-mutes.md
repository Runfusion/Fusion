---
"@runfusion/fusion": patch
---

summary: A blocked review always explains itself, even when the concurrency marker cannot be written.
category: fix
dev: claimRemediationAttempt now reports `unavailable` instead of collapsing every declined admission to `held`; the graph-failure backstop and the self-healing sweep fail open on it, logging why the attempt is unfenced and producing remediation anyway. Silence stays reserved for outcomes with an owner (superseded/held/refused/missing).
