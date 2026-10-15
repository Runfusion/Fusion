---
"@runfusion/fusion": patch
---

summary: Capacity waits stop re-dispatching every scheduler pass; a crashed dispatch is still reclaimed.
category: fix
dev: The planning-continuation dispatch claim now stamps `leaseExpiresAt` using the existing `PLANNING_CONTINUATION_LEASE_MS` instead of `null`, so `evaluateStrandedContinuationReclaim` answers `lease-active` while the lease holds and `dead-lease` after it lapses.
