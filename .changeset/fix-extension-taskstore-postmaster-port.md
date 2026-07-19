---
"@runfusion/fusion": patch
---

summary: Prevent fn_task_show timeouts when another Fusion process already owns embedded PostgreSQL.
category: fix
dev: Reads the port from PostgreSQL's actual postmaster.pid line 4 field before joining the running instance.
