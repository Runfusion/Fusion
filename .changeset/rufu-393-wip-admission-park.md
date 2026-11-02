---
"@runfusion/fusion": minor
---

summary: A card refused a work-in-progress slot now says so on its face, with how long it has been waiting.
category: feature
dev: New read-side stall code `wip-admission-throttled`, derived from a durable `sourceMetadata.wipAdmissionStall` episode that also defers re-dispatch of an already-parked card — but only for the withheld crossing itself: the deferral requires the refusing gate's remedy to lie outside the card's column AND that the card has no active work item at a node authored in that column, so a parked card's own planning and review work still runs. `task:workflow-run-suspended` gains `stallCode`, `stallCount`, `stallFirstAt`, `stallPoolId`, and one unchanged wait re-records at most once per 15 minutes. No setting, cap tier, or approval gate changed; the hold/release sweep remains the only mover across the hold-to-WIP boundary.
