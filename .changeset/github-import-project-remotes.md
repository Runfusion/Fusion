---
"@runfusion/fusion": patch
---

Fix Import from GitHub remote detection in multi-project dashboards by passing the active `projectId` to the `/api/git/remotes` lookup. The dialog now lists configured GitHub remotes instead of showing "No GitHub remotes detected" when the backend requires project scope.
