---
"@runfusion/fusion": patch
---

Floating modals (the reusable FloatingWindow, the right-dock pop-out, the floating terminal, and the floating New Task dialog) now share a single z-index stack, so tapping any of them brings it to the front above all the others regardless of type.
