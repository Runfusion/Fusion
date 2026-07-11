---
"@runfusion/fusion": patch
---

summary: Fix the Artifacts preview "Add comment" button doing nothing when clicked, and label the preview as read-only.
category: fix
dev: The global `.btn:active { transform: scale(0.97) }` press feedback replaced the selection-comment trigger's positioning translate while the mouse was held, moving the button out from under the cursor so `click` never fired. `.selection-comment-trigger:active` now restates the translate (desktop and mobile), covering DocumentsView and FileEditor surfaces. The Artifacts project-file preview header also gains a `documents.readOnly` badge.
