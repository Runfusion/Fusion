---
"@runfusion/fusion": minor
---

summary: Planning failures now retry with backoff and park after 3 attempts instead of looping forever.
category: fix
dev: Two bounds on the triage planning path plus a log-level fix. (1) The unclassified-failure branch in `specifyTask` restored the card's claimable status and wrote no counter, no `nextRecoveryAt` and no park, so triage rediscovery re-admitted it every poll indefinitely; it now consumes the shared `recoveryRetryCount`/`nextRecoveryAt` budget (`MAX_RECOVERY_RETRIES` = 3, 60s/120s/300s backoff) and parks `status: "failed"` with a `PLANNING_FAILED_EXHAUSTED:` error once spent. (2) New workflow-native setting `planningTimeoutMs` (default `DEFAULT_PLANNING_TIMEOUT_MS` = 5_400_000, declared in `BUILTIN_TRIAGE_POLICY_SETTINGS`) caps a planning turn — previously nothing did, since `workflowStepTimeoutMs` covers pre-merge steps only and the provider SDK's 300s cap is time-to-first-byte and is cleared once headers arrive; a timeout aborts the session and consumes one bounded attempt. Default is generous by design (successful plans measured p99 ≈ 106 min) — it bounds hung turns, not slow ones. (3) `[event:task:moved]` executor tracing dropped from `log` to `debug`; it fired on every move and was the loudest line in engine output.
