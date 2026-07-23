---
"@runfusion/fusion": patch
---

summary: Fix the Chat View "Latest" button shifting sideways out from under the cursor when clicked.
category: fix
dev: `.chat-jump-to-latest:active` now composes `translateX(-50%) scale(0.97)` so the global `.btn:active` transform no longer replaces the centering transform.
