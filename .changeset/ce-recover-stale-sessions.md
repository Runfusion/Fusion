---
"@runfusion/fusion": patch
---

Recover stale Compound Engineering sessions on plugin load and session reads so persisted active rows without live agent handles no longer leave the dashboard stuck waiting for work that is not running.
