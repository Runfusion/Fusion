---
"@gsxdsm/fusion": patch
---

Fix blank list view in dashboard when a project is selected. The `/api/tasks` endpoint now handles the `projectId` query parameter by delegating to the appropriate project's TaskStore via CentralCore.
