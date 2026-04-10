---
"@gsxdsm/fusion": patch
---

Fix plugin settings load failure in dashboard/serve runtime

The Settings → Plugins page in the dashboard was showing "Failed to load plugins" because the plugin REST API routes were not being wired into the server startup. This fix initializes PluginStore and PluginLoader in both `runDashboard` and `runServe`, and passes them to `createServer` so the `/api/plugins` endpoints become available in both full dashboard mode and headless node mode.
