---
"@runfusion/fusion": patch
---

Introduce AutoRecoveryDispatcher and `ProjectSettings.autoRecovery` (mode/perClass/maxRetries) for classifier-driven recovery of reliability-layer failures. Adds new run-audit event types `auto-recovery:classify-decision`, `auto-recovery:retry-issued`, `auto-recovery:ai-session-spawned`, and `auto-recovery:pause-because-destructive-ambiguity`. Default mode preserves prior behavior; `mode: "off"` is byte-identical to legacy parking.
