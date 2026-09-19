---
"@runfusion/fusion": patch
---

summary: Restore review gates archived by another gate's remediation so blocked cards stay recoverable.
category: fix
dev: Adds `resolveCollateralArchivedReviewGate` in `@fusion/core` and the `reconcile-collateral-archived-review-gates` self-healing sweep (startup + maintenance), emitting `task:reconcile-collateral-archived-review-gate`. The sweep restores the pre-archive terminal status so the FN-7720 audited bypass can select the gate again; it never fabricates a verdict, and skips operator waivers, the remediation-owning gate, workspace cards, user-paused cards, and live sessions.
