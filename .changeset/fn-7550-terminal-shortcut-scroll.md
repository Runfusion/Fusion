---
"@runfusion/fusion": patch
---

summary: Fix the mobile terminal shortcut bar so it scrolls horizontally to reach every key.
category: fix
dev: Added `min-width: 0` to `.terminal-shortcut-panel` to defeat the flex min-width:auto trap that clipped overflow instead of engaging `overflow-x: auto`.
