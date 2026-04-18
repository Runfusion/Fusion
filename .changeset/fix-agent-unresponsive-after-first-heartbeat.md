---
"@gsxdsm/fusion": patch
---

Fix agents showing as Unresponsive after their first heartbeat. Agents are now dynamically registered with the heartbeat trigger scheduler when created or updated, and a default 30-second heartbeat interval is applied when not explicitly configured.
