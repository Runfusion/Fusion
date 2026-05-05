---
"@runfusion/fusion": patch
---

Deduplicate auto-merge recovery follow-up task creation so repeated verification-cap and conflict-bounce-cap failures reuse an existing active recovery task instead of spawning duplicates.
