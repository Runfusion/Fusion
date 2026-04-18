---
"@gsxdsm/fusion": patch
---

Fix quick chat panel dismiss when clicking inside the model search dropdown. The dropdown is rendered via `createPortal` to `document.body`, so clicks inside the portaled content were triggering the click-outside handler, incorrectly closing the panel.
