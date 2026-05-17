---
"@runfusion/fusion": minor
---

Add board-health self-healing levers in the engine: paused-scope decay rebound for blocked paused holders, meta-task chain auto-close for resolved/stalled recursion, and a board-stall sweep with verification-gated ntfy escalation. This adds new project settings (`pausedScopeDecayMs`, `metaTaskStallAutoCloseMs`, `boardStallSweepWindowMs`, `boardStallBlockedGrowthThreshold`) plus run-audit events for rebound/archive/stall outcomes.
