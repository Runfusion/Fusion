---
"@gsxdsm/fusion": patch
---

Fix false "Unresponsive" health for runtime-created task worker agents by marking them as non-heartbeat workers and keeping the dashboard health label stable while task execution is active.
