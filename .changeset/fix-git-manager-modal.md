---
"@gsxdsm/fusion": patch
---

Fix the Git Manager modal so it stays within the viewport.

- Let `.gm-content` shrink by changing its `min-height` from `400px` to `0`
- Keep the modal content constrained on desktop and mobile viewports to avoid off-screen rendering
