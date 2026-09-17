---
"@runfusion/fusion": patch
---

summary: Refine and Reset now open a small centred dialog only, with no task modal and no dimmed backdrop.
category: fix
dev: Extracts the inline Task Detail refine composer into a shared standalone `TaskRefineDialog` hosted directly by TaskCard, ListView, and TaskDetailModal. Removes the detail-open refine route (`DetailTaskInitialAction`, the `initialAction` option on `openDetailTask`, `detailTaskInitialAction`, `previousDetailAction`) and the bubbling `onOpenRefine` prop across Board/Column/WorktreeGroup/MainViewKeepAlive, replacing it with `onRefinementCreated`. Both dialog overlays now cancel `--overlay-padding-top`, centre exactly, and paint nothing, including at the 768px breakpoint.
