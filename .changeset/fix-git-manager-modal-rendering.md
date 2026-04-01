---
"@gsxdsm/fusion": patch
---

Fix Git Manager dialog rendering off-screen on smaller viewports

- Add `display: flex; flex-direction: column; overflow: hidden;` to `.gm-modal` to properly contain content and enable flex layout
- Change mobile `max-height: 100vh` to `height: 100vh` for full viewport coverage
- Reduce mobile `.gm-content` `min-height` from `300px` to `200px` to prevent overflow
