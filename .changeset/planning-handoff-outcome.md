---
"@runfusion/fusion": patch
---

summary: A task whose planning handoff was refused is retried instead of being silently reported as recovered.
category: fix
dev: U7. `finalizeApprovedTask` now reports a three-state `PlanningHandoffOutcome` (released / parked / withheld) through a mutable report threaded into its ~25 exits; the default is `parked`, so the plumbing is inert except at the two sites explicitly classified as `withheld` (store lacks `moveTaskIf`; the planning-stage guard refuses the release move, FN-8361) and the one that sets `released`. `recoverApprovedTask` returns `outcome !== "withheld"` instead of an unconditional `true`, so `handleStuckAbortRequeue` stops treating a failed handoff as a completed recovery and skipping the stuck-retry budget. `parked` deliberately still returns true — an awaiting-approval park is a successful recovery and must not be overwritten with `needs-replan`.
