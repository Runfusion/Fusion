---
"@runfusion/fusion": patch
---

summary: ENOSPC failures now say whether the disk or its inode table ran out, and Fusion sweeps its own temp litter.
category: fix
dev: New `@fusion/core` helpers (`classifyTempFs`, `annotateEnospcFailure`, `annotateEnospcError`, `tempFsClassSuffix`, `isEnospcFailureText`, exported from both core barrels) append a `temp-fs class: inode-exhausted|bytes-full` marker to merge clean-room, `fn_run_verification`, and engine-boot ENOSPC records. A creation failure's own path does not exist yet, so the probe reads that path and then its nearest existing ancestors (bounded, stopping at the filesystem root) and names the path it actually measured. Engine boot now throws `EngineStartupEnvironmentError` instead of `EngineAlreadyRunningError` for a provable errno-28 guard-creation failure. The stale-tmpdir sweep reaps Fusion-created scratch prefixes under `TEMP_SCRATCH_REAP_AGE_MS` (24 h); `TEMP_SCRATCH_SWEEP_PREFIXES` is the admission gate and records the exclusions.
