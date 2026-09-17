---
"@runfusion/fusion": patch
---

summary: Fix modals failing to open with a React error, and add copyable error details.
category: fix
dev: FloatingWindow and MobileDrawer compose their managed root ref in a `useCallback` keyed on `windowSurface.rootRef`; the inline callback introduced by FN-512 churned its identity, so `upsertSurface` saw element→null→element and looped the window manager into React #185. ErrorBoundary now snapshots a bounded, sanitized diagnostic in `componentDidCatch` via `app/utils/errorBoundaryDiagnostics.ts`.
