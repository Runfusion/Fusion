---
"@runfusion/fusion": minor
---

summary: The Create PR dialog is now movable and resizable like other Fusion pop-outs.
category: feature
dev: PrCreateModal now renders inside the shared FloatingWindow (windowKey "pr-create", persistGeometryKey "floating-window:pr-create") instead of a fixed .modal-overlay; geometry persists, mobile stays full-screen via CSS, and overlay click-to-dismiss was dropped (close via X / Cancel / Escape).
