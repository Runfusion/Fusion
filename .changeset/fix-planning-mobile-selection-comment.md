---
"@runfusion/fusion": patch
---

summary: Keep Planning plan-review Add-comment controls on-screen on mobile after text selection.
category: fix
dev: Selectioncapture uses document-level selectionchange; mobile trigger and composer are position:fixed above the nav with width auto so they stay in the visual viewport and dismiss when the selection collapses.
