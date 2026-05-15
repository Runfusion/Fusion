---
"@runfusion/fusion": patch
---

Persist `mergeDetails.rebaseBaseSha` whenever a rebase merge base is captured, and update self-healing landed-commit stats lookup to use rebase range shortstat (`base..sha`) when available so stale tip-only merge stats are automatically repaired.
