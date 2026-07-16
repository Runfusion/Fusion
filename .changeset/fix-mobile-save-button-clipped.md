---
"@runfusion/fusion": patch
---

summary: The task composer's Save button no longer has its label cut off on mobile.
category: fix
dev: At narrow widths `.quick-entry-primary-group` needed ~275px in a 260px column. Its five icon controls are floored by `min-width: 36px`, while Save's automatic minimum size was zeroed by the `overflow: hidden` that FN-7680/FN-7683 added for height equalization (per spec, automatic minimum size applies only when overflow is `visible`), making Save the sole shrinkable item — it absorbed the whole deficit and clipped its own label. Save is now pinned with `flex: 0 0 auto; min-width: max-content`, and the group may `flex-wrap: wrap` with `justify-content: flex-end` so a deficit reflows instead of clipping. Not breakpoint-scoped (FN-5751); inert where the row already fits. Verified in-browser at 412px and 1400px.
