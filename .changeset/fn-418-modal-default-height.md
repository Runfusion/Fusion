---
"@runfusion/fusion": patch
---

summary: Dashboard windows now open at about 62% of the work-area height instead of filling it.
category: fix
dev: Adds `FLOATING_WINDOW_STANDARD_HEIGHT_RATIO` (0.62), applied to the requested height inside `resolveStandardSize` before the existing clamp, so `minSize`, snapping, manual resize, and mobile sheets are unchanged. Non-hosted `.modal` dialogs use the new `--modal-default-max-height` token (62dvh) instead of 80vh.
