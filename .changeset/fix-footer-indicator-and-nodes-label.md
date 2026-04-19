---
"@gsxdsm/fusion": patch
---

Fix running indicator scroll sync and add nodesView label

- Remove GPU compositing hint (`transform: translateZ(0)`) from executor status bar indicator that was causing it to appear stuck during page scrolling
- Add missing "nodesView" → "Nodes View" label mapping in experimental features settings
