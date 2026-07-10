---
"@runfusion/fusion": patch
---

summary: Fix the search icon overlapping typed/placeholder text in the Files — Project search input.
category: fix
dev: `.file-browser-search-input` `padding-left` was `calc(var(--space-lg) + var(--space-md))`, which collided exactly with the leading `.file-browser-search-icon`'s occupied width (`var(--space-sm)` offset + 16px icon) under the compact spacing theme. Padding is now anchored to the same `--space-sm` offset the icon uses, plus the icon's box width, plus a real gap, so clearance holds across all spacing scales for both the FileBrowser view and modal.
