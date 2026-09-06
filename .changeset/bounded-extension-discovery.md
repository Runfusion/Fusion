---
"@runfusion/fusion": patch
---

summary: Stop a slow extension load from hanging dashboard startup indefinitely.
category: fix
dev: `discoverAndLoadExtensions` now runs under `boundedPhaseTime` with a 120s budget (override via `FUSION_EXTENSION_DISCOVERY_TIMEOUT_MS`); on timeout the existing catch path builds an empty extension runtime and boot continues without extension-provided providers. Separately, the CLI presence/auth probes in pi-claude-cli, the droid runtime plugin, and `detectFnBinary` defer their SIGKILL to the `spawn` event when the timeout fires before the fork has a pid — `ChildProcess.kill()` is a silent no-op with no pid, so a probe child could outlive its own timeout.
