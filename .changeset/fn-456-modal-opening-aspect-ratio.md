---
"@runfusion/fusion": minor
---

summary: Every dashboard window now opens at one shared landscape shape; full views are unchanged.
category: feature
dev: Adds `FLOATING_WINDOW_OPENING_ASPECT_RATIO` (1.43) to `floatingWindowGeometry.ts` and normalizes `resolveStandardSize` before the existing `clampFloatingWindowSize` (max-then-min order preserved). A new `openingSizePolicy` prop is threaded from `FloatingWindowProps` into both `resolveOpeningRect` calls; `openingSizePolicy="full-view"` exempts `GitManagerModal` and `PlanningModeModal`, whose opening geometry stays bit-for-bit pre-FN-456. Manual resize, drag, snap/dock, restore-after-dock, and mobile sheets are untouched.
