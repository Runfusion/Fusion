---
"@runfusion/fusion": patch
---

summary: A window docked at the bottom now compresses the app so the board columns stay visible above it.
category: fix
dev: `DashboardWindowManagerProvider` owns a per-token bottom-dock reservation aggregated by maximum (`resolveBottomDockReservation`), published by `FloatingWindow` while `snapMode === "bottom"` and the window is neither a sheet nor hidden; `AppInner` reserves it on `.dashboard-project-stack--bottom-dock` via `--bottom-dock-reservation` and stops reserving the fixed bottom bar twice. The reservation is deliberately excluded from `resolveDashboardWindowBounds` to avoid a feedback loop.
