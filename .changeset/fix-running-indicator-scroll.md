---
"@gsxdsm/fusion": patch
---

Fix running indicator rendering issue during dashboard scroll by adding GPU compositing hint (`transform: translateZ(0)`) to prevent the animated dot from appearing "stuck" or detached from the footer when scrolling.
