---
"@gsxdsm/fusion": patch
---

Make ntfy notification deep links project-aware for multi-project dashboards.
Notifications now include both `?project=...&task=...` parameters when the
dashboard is running for a registered project, so clicking a notification
opens the correct task in the correct project.
