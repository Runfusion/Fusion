---
"@runfusion/fusion": patch
---

summary: Stop the dashboard TUI Logs tab from showing detailed timestamps on each log line.
category: fix
dev: Compact LogsPanel time to HH:MM:SS; strip leading YYYY-MM-DD HH:MM:SS.mmm TZ prefixes from displayed messages (e.g. embedded Postgres logs).
