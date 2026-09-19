---
"@runfusion/fusion": patch
---

summary: An operator review retry now starts the gate's revision budget fresh instead of inheriting it.
category: fix
dev: The log-derived attempt ledger honours an append-only reset marker (`optionalStepRevisionResetOutcome`) that the dashboard restart-stage route stamps per discarded gate, so a restarted review is no longer refused for a budget the previous episode spent.
