---
"@runfusion/fusion": patch
---

summary: A custom Merging column now receives the card at merge instead of being sent to In-review.
category: fix
dev: The workflow graph collapses the merge region into one seam recorded as node `merge`, but that synthetic node hardcoded `column: "in-review"`, so a user-authored workflow placing its merge nodes in a different column (e.g. `Merging`) had the card moved to `in-review` — a column such a workflow need not even declare. The column now derives from the merge-region node actually being entered, falling back to `in-review` so `builtin:coding` stays byte-identical. Caught by the new 6-column benchmark acceptance test.
