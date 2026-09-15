---
"@runfusion/fusion": patch
---

summary: Dragging a window's tab row now only scrolls it instead of highlighting tab text.
category: fix
dev: New `FNXC:TabStripTextSelection` primitive in `packages/dashboard/app/styles.css` suppresses selection on `[role="tablist"]` plus the roleless tab-strip inventory, with an editable carve-out; `TaskDetailTabStrip.css` keeps only the `grabbing` cursor.
