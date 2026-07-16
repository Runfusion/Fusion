---
"@runfusion/fusion": minor
---

summary: Show when Plan Review budget exhaustion needs approval and make the replan cap configurable.
category: feature
dev: Adds a number-typed workflow setting (unset → falls back to PLAN_REVIEW_GATE_REPLAN_CAP) read in triage blockAfterPlanReviewRevise; adds a distinct TaskCard/ListView badge + TaskDetailModal callout gated on awaitingApprovalReason === "plan-review-replan-cap".
