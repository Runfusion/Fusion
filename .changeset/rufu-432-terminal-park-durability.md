---
"@runfusion/fusion": patch
---

summary: A branch-conflict recovery that gave up stops re-writing its own card every sweep pass.
category: fix
dev: Terminal parks persist no retry counter, so the reported budget can no longer outrun autoRecovery.maxRetries (measured 26 and 19 against a declared budget of 3) and the card's updated_at stops being re-stamped — the row clock the heartbeat reads as recovery liveness. Re-encountering an applied park writes nothing at all; refusal notes now share one 6-hour windowed History entry per (card, reason, branch tip). Every automatic pass still inspects the branch, so a parked card still gets its stale-metadata and never-delivered releases, and its remedy sentence now names a door instead of claiming automatic passes stay suppressed. Operator Retry (fn task retry, CLI, dashboard) now also lifts the branch-conflict recovery-exhausted pause it always told the operator to press.
