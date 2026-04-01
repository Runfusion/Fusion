---
"@gsxdsm/fusion": patch
---

Fix Git Manager dialog rendering off-screen on smaller viewports.

- Add `display: flex`, `flex-direction: column`, and `overflow: hidden` to `.gm-modal` to contain content and allow flexible layout
- Add `flex-shrink: 0` to `.gm-modal .modal-header` to prevent header compression
- Change `.gm-content` `min-height` from `400px` to `0` so the content area can shrink within the viewport
- Update mobile responsive styles to use `height: auto` with `max-height: 90vh` so the modal respects overlay padding
- Reduce mobile `.gm-content` `min-height` from `300px` to `200px` to prevent overflow
