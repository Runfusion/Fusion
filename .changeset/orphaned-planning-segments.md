---
"@runfusion/fusion": patch
---

summary: Harden orphaned planning recovery audits so failed rows cannot abort the sweep.
category: fix
dev: Keep FN-8909 live-row enumeration; isolate audit emission failures and distinguish all-attempts-failed no-action outcomes (PR #3392).
