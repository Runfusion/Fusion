---
"@runfusion/fusion": patch
---

summary: Merges that failed on a transient fault recover again on boards with renamed columns.
category: fix
dev: `recoverTransientMergeFailures` read the literal `in-review` and kept two lane guards on column ids, so a card that burned its retry budget on a network blip or provider fault stayed failed permanently on a renamed board. Read resolves via `resolveProjectColumnsForRoles`; both the slim-snapshot filter and the full-row re-check resolve per card.
