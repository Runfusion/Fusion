---
"@gsxdsm/fusion": patch
---

Fix Git Manager dialog rendering off-screen on smaller viewports

- Add `display: flex; flex-direction: column; overflow: hidden;` to `.gm-modal` to properly contain content and enable flex layout
- Add `flex-shrink: 0` to `.gm-modal .modal-header` to prevent header compression
- Change `.gm-content` `min-height` from `400px` to `0` to allow flexible content sizing
- Fix mobile responsive styles: change `max-height: 100vh` to `height: auto` with `max-height: 90vh` to account for overlay padding
- Reduce mobile `.gm-content` `min-height` from `300px` to `200px` to prevent overflow
