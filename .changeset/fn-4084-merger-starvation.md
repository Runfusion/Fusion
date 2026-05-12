---
"@runfusion/fusion": patch
---

Fix merger starvation where eligible in-review tasks looped in auto-recovery
without ever merging. Leaked in-memory merge-queue entries are now reconciled
automatically, and tasks whose re-enqueue is repeatedly dropped escalate to a
clear `status=failed` with an `Auto-merge starvation:` error instead of
looping indefinitely.
