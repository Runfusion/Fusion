---
"@runfusion/fusion": patch
---

summary: Show project-scoped Automations and Routines instead of an empty list.
category: fix
dev: GET /routines and GET /automations now let scope=project bypass legacy global-store guards and resolve the project store.
