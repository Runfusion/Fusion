---
"@runfusion/fusion": patch
---

summary: Reloading a path-registered plugin now refreshes its version and settings schema.
category: fix
dev: PluginLoader.loadPlugin/reloadPlugin reconcile persisted version/settingsSchema from the freshly-imported manifest (generalizing the bundled-plugin refresh); PluginUpdateInput/updatePlugin now accept settingsSchema. Preserves per-project enablement and setting values. FN-7855.
