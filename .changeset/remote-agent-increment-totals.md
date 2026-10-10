---
"@runfusion/fusion": minor
---

summary: Session cost is now the sum of each revision's work at the rates in effect then.
category: fix
dev: Completes F1=3. Cards and detail both price from per-revision increments via one shared summary; sessions predating migration 0091 fall back to the cumulative figure rather than reading an empty increment list as zero.
