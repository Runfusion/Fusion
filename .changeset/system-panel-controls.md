---
"@runfusion/fusion": minor
---

summary: Add Command Center System controls (rebuild & restart, engine/agent restarts, backups, live logs) and a Plugins tab.
category: feature
dev: New `/api/system/*` routes gated by `ServerOptions.systemControl`/`systemLogs`; `fn dashboard` is now supervised by default (attached foreground child, `--no-supervise` opts out) and restart uses `FUSION_RESTART_EXIT_CODE` (86) honored by the supervisor, `scripts/dev-with-memory.mjs`, and Electron `app.relaunch()` on desktop; rebuild controls only render from a source checkout; new Command Center "Plugins" tab reuses PluginManager.
