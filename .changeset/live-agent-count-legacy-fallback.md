---
"@runfusion/fusion": patch
---

summary: The processing/queued footer counts now share one rule for columns with no trait flags.
category: internal
dev: `live-agent-count.ts`'s two duplicate no-flags fallbacks collapse into `isLegacyPreImplementationColumn`; deliberately still the legacy pair, with the reason recorded at the helper. `replan-target.ts` comment prose restated by role.
