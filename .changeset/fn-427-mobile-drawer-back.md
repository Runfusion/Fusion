---
"@runfusion/fusion": patch
---

summary: Drop the misleading Back arrow in phone drawers and make the mobile file list scrollable.
category: fix
dev: TaskDetailContent now reads `useDrawerPresentation()` and renders its `ViewBackButton` only when `isPhonePresentation && !drawerPresentation`; close guards stay on the broader phone predicate. FileBrowser.css adds drawer-scoped rules (`html[data-mobile-drawers="true"][data-viewport-mode="mobile"] .floating-window--file-browser.floating-window--mobile-drawer`) bounding `.file-browser-modal` to `100%` of its panel, making the drawer body non-scrolling and `.file-browser-list` the single bounded scroller.
