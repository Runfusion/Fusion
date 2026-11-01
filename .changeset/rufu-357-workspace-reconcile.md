---
"@runfusion/fusion": minor
---

summary: `fn task reconcile` can now close zero-commit workspace cards, naming every repository's evidence.
category: feature
dev: `reconcileLandedReviewTask` gained a per-repository discharge arm (zero-ahead on each repo's own base, or proven landing); refusals and CLI/HTTP output list per-repo basis and unique-commit counts instead of the bare word `workspace`; one bounded `task:reconcile-workspace-landed-review` audit row per discharge. Automatic sweeps still skip workspace cards — manual reconcile only.
