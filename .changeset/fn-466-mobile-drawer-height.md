---
"@runfusion/fusion": patch
---

summary: Every mobile drawer now opens at the same height, near the top of the screen, like the Terminal.
category: fix
dev: Adds a single `--mobile-drawer-top-reveal` token feeding both the three drawer overlays' `padding-block-start` and `--mobile-drawer-block-size`; the terminal drawer rule now carries `!important` on `min-height`, `height` and `max-height` so the fullscreen mobile rules (including their `min-height: 100dvh` floor) can no longer re-pin the panel.
