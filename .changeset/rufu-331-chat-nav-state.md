---
"@runfusion/fusion": patch
---

summary: Desktop Chat nav entry marks itself active and clears its unread dot while Chat is on screen.
category: fix
dev: The navigation registry now derives the Chat entry from the surface it opens — two new host options `chatOpensPanel` (the anchored popover is the destination) and `chatSurfaceActive` (Chat page, dock, or window group is visible) — instead of the popover's mounted state alone. `aria-current="page"` is claimed by any active entry that does not declare a dialog; the popup default keeps its `aria-haspopup="dialog"` / `aria-expanded` / `aria-controls` triplet unchanged.
