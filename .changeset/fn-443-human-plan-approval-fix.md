---
"@runfusion/fusion": patch
---

summary: Honor and display the plan-approval choice whatever order it is toggled at creation.
category: fix
dev: QuickEntryBox's submitCreateTask useCallback omitted requiresHumanPlanApproval (plus the merger override and the per-lane thinking levels) from its dependency array, freezing the create payload on a stale value. TaskCard's hasCardMetaBadges guard now also derives from resolveHumanPlanApprovalBadgeState, so the badge renders on a card with no other meta badge while .card-meta-badges is still never rendered empty.
