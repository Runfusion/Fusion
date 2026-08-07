---
"@runfusion/fusion": patch
---

summary: The Todo Lists and Roadmaps plugins now appear in dashboard navigation after being enabled.
category: fix
dev: Both plugin `manifest.json` files were missing the `dashboardViews` block that `PluginLoader.getPluginDashboardViews` treats as authoritative, so the module-level `dashboardViews` in each `src/index.ts` was discarded and the views were absent from every nav surface.
