---
"@runfusion/fusion": patch
---

summary: Dashboard windows now open 20% larger while keeping the same landscape shape.
category: feature
dev: Adds the shared `FLOATING_WINDOW_OPENING_SIZE_SCALE = 1.2` target scale to the `aspect-ratio` branch of `resolveStandardSize`, carried through the FN-418 proportional cap so the effective opening height cap moves from 62% to 74.4% of the live work area (`bounds.height` stays a hard bound). The `full-view` policy, `minSize`, and every non-opening trajectory are unchanged.
