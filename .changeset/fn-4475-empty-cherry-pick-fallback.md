---
"@runfusion/fusion": patch
---

Fix merger history-preserving cherry-pick fallback handling so empty `-X ours` / `-X theirs` picks are treated as already-on-main no-ops instead of merge conflicts that park tasks.
