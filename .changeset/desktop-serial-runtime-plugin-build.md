---
"@runfusion/fusion": patch
---

summary: Reduce peak memory use when building the desktop runtime on smaller machines.
category: performance
dev: Build dashboard runtime plugins one at a time after the SDK and stop admission on the first compiler failure.
