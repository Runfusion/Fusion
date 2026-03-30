---
"@dustinbyrne/kb": patch
---

Fix size badge positioning on task cards in todo and done columns. The size indicator (S/M/L) now consistently appears on the right side of the card header, immediately before action buttons (edit, archive, unarchive) when present. This resolves layout conflicts caused by multiple elements using `margin-left: auto` in the same flex container.
