---
"@runfusion/fusion": patch
---

SelfHealingManager now includes a `clearStaleBlockedBy()` recovery sweep that clears `blockedBy` (and transient `status`) on todo tasks when their blocker is missing, done, archived, paused in-review, or failed in-review with merge retries exhausted. This lets the scheduler re-evaluate those tasks cleanly on subsequent ticks instead of leaving them permanently queued behind stale blockers.
