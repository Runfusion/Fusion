---
"@runfusion/fusion": patch
---

summary: Prevent bundled plugin commands from delaying or crashing the Fusion CLI on spawn failures.
category: fix
dev: Absorbs child spawn errors and unrefs SIGKILL escalation timers in the plugin SDK runtime shim.
