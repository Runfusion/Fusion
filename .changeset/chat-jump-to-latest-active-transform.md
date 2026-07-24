---
"@runfusion/fusion": patch
---

summary: Stop the Chat/Quick Chat "Latest" button from jumping when the cursor moves near or presses it.
category: fix
dev: Center `.chat-jump-to-latest` with left/right + margin-inline auto instead of transform:translateX(-50%) so global `.btn` transform transitions and :active scale cannot shift the chip sideways.
