---
"@runfusion/fusion": patch
---

summary: Stop an await-stalled extension load from hanging dashboard startup indefinitely.
category: fix
dev: `discoverAndLoadExtensions` now runs under `boundedPhaseTime` with a 120s budget (override via `FUSION_EXTENSION_DISCOVERY_TIMEOUT_MS`); on timeout the existing catch path builds an empty extension runtime and boot continues without extension-provided providers. pi loads extensions with a serial `await factory(api)` loop, so one slow factory stalls every extension behind it. The bound is a timer and therefore only covers an await-stalled phase — it cannot preempt one blocking the event loop synchronously.
