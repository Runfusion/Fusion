---
"@runfusion/fusion": patch
---

summary: Plugin skills now show for the project that enabled them, even when the daemon starts elsewhere.
category: fix
dev: getPluginSkills is now project-aware — resolved per requesting rootDir against project_plugin_states instead of the daemon-root PluginLoader scope; plugins skipped as disabled are now logged at load time. Wired in dashboard.ts/serve.ts/daemon.ts. Strategy: B per-project resolution.
