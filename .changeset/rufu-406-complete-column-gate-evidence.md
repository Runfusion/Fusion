---
"@runfusion/fusion": patch
---

summary: A board move into `done` without approving gate evidence is now refused, on CLI and board alike.
category: fix
dev: New rejection code `gate-evidence-missing` (`messageKey: transition.rejected.gateEvidenceMissing`, retryable) from the complete-column gate-evidence invariant in `moveTask`; `MoveTaskOptions` gains `moveCallerSurface` (`operator-cli`/`agent-cli`/`dashboard-http`/`store-direct`) and `moveCallerPrincipal?: { sessionId? }`; each transport declares its own surface and a request body cannot relabel it. Refusals record `task:move-refused-complete-column-gate-evidence` plus a History line naming each silent gate. Engine, handoff, recovery, scheduler and merge-finalization moves are unchanged; the operator waiver stays the audited `bypass-review` surface and `--force` does not skip a gate.
