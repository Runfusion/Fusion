---
"@runfusion/fusion": patch
---

summary: Fix concurrency sliders being undraggable on mobile touch devices.
category: fix
dev: The footer Engine Control menu and Command Center Concurrency card range inputs now use touch-action:none so the mobile pan-y ancestor lock no longer hijacks a horizontal thumb drag into page pan.
