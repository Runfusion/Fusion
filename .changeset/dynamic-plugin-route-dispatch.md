---
"@runfusion/fusion": patch
---

summary: Plugin API routes now work for plugins enabled after startup or enabled only in a non-launch project.
category: fix
dev: Plugin-defined HTTP routes are dispatched per request through the shared project-scoped PluginLoader resolution (routes/context.ts getProjectPluginLoader) instead of a boot-time snapshot of the launch project's loader. Fixes Compound Engineering "Failed to load sessions/artifacts: Not found" persisting on v0.73.0-beta.3.
