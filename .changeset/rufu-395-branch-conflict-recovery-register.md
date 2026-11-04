---
"@runfusion/fusion": patch
---

summary: Branch-conflict recovery parks once and a single Retry now really lifts it.
category: fix
dev: Exhaustion is counted in `sourceMetadata.branchConflictRecoveryEpisode` owned by this recovery family, not in the shared `recoveryRetryCount` that planning/executor/triage also write. A pass that finds the park hold standing writes nothing at all (one deduped `code: "recovery-park-hold"` no-action row is the only trace); `buildManualRetryResetPatch` clears the new key, so `fn task retry` remains the single exit.
