---
"@runfusion/fusion": patch
---

summary: Internal gate fix; no user-visible change.
category: internal
dev: The lane-wiring census now sees lane arguments passed via a ternary or a conditional spread, adds `columnFlagsByTaskId` to its vocabulary, and merges same-named declarations instead of letting the last one clobber the rest.
