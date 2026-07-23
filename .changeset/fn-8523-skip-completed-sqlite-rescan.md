---
"@runfusion/fusion": patch
---

summary: Stop completed PostgreSQL migrations from re-scanning retained SQLite backups at startup.
category: fix
dev: Core, central, and plugin sources now honor their independent completion markers before SQLite access.
