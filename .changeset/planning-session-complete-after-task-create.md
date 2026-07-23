---
"@runfusion/fusion": patch
---

summary: Planning sessions now show Complete instead of Needs input after their task is created.
category: fix
dev: POST /api/planning/create-task terminalizes the session via validateSession on every created/alreadyCreated path.
