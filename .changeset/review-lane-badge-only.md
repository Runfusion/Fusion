---
"@runfusion/fusion": patch
---

summary: In-review cards show the running gate as a badge instead of a step list.
category: feature
dev: Reverts the review-lane progress section in `TaskCard` and `ListView` added earlier in this series. `showProgressSection` and `shouldShowTaskProgress` no longer include the review column, so an in-review card renders its stage through `getRunningOptionalGateBadge` (Code Review → Documentation → Merging) with no bar, counter, or expandable list. This also removes a defect for free: the list is built from `task.enabledWorkflowSteps`, frozen on the card at planning time, so a card planned before a workflow changed rendered a removed milestone as permanently `pending`.
