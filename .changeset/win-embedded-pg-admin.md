---
"@runfusion/fusion": patch
---

summary: Fix the Windows installer build — the embedded-Postgres smoke now runs as a non-admin helper user.
category: fix
dev: The windows-latest runner executes jobs elevated, which PostgreSQL refuses to start under. The launcher (embedded-lifecycle.ts + embedded-windows-admin.ts) now detects an elevated Windows token and fails fast with a clear, actionable message; the desktop-windows.yml smoke runs the embedded-PG test AS a non-admin local user so postgres boots via the normal path.
