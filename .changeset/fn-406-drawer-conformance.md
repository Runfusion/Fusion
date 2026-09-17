---
"@runfusion/fusion": patch
---

summary: Mobile drawers now show one drag handle and no close button, including the file browser.
category: fix
dev: Shared useDrawerPresentation context in ViewDrawer.tsx; ViewHeader suppresses the canonical close in drawer presentation; the bespoke .file-browser-modal-header::before handle is removed.
