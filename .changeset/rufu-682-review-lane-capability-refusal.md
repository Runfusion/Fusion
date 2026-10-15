---
"@runfusion/fusion": patch
---

summary: A review card is no longer re-dispatched forever to a reviewer lane that refuses it; the refusal is named on the card.
category: fix
dev: New review-lane ledger witness `lane-capability-declined:<policySignature>` written by `declineReviewerRunForLane`, read back by `ReviewDispatchSweep` as the `capability-declined` bucket. Editing the lane's roles, binding, or `assignmentPolicy` changes the signature and re-arms dispatch. Card state is never parked by the refusal.
