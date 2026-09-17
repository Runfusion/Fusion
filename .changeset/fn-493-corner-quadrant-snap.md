---
"@runfusion/fusion": minor
---

summary: Drop a dashboard window in a corner to dock it to a quarter, so four windows form a 2x2 grid.
category: feature
dev: Adds `top-left`/`top-right`/`bottom-left`/`bottom-right` to the shared `FloatingWindowSnapMode` contract in `floatingWindowGeometry.ts`. `detectSnapZoneForRect` arms a quadrant only when the clamped panel touches exactly one side wall and exactly one horizontal wall; every ambiguous case keeps the historical rule order verbatim, so a full-height panel against a side wall still returns `maximized`. The FN-469 undock artifact is now narrowed to its bottom component through `demoteBottomAnchoredSnapMode` plus `rectRestsOnBottomWall`, so a lateral undock still arms the column. `TerminalModal.handleFloatingDragGestureEnd` is deliberately not widened: a corner stays a floating quarter.
