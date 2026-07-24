---
"@runfusion/fusion": patch
---

summary: Terminal now auto-starts a session from Windows browsers when the dashboard host is not Windows.
category: fix
dev: Windows-UA clients probe `GET /api/system/info` (memoized, 5s timeout) and only keep the manual "Start terminal" gate when the server platform is `win32` or the probe fails.
