---
"@runfusion/fusion": patch
---

Add a tree-equality fallback to already-merged review-task recovery so retry-exhausted in-review tasks can auto-finalize when task and base branches resolve to identical trees.