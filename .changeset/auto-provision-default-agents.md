---
"@runfusion/fusion": patch
---

Fix agent heartbeat execution in multi-project setups. On-demand heartbeat triggers from the dashboard API now correctly route to the engine of the project the agent belongs to, instead of silently creating a zombie run record that never executes. Also auto-provisions default agents (triage, executor, reviewer, merger) when the engine starts with an empty agents table.
