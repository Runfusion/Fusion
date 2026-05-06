---
"@runfusion/fusion": patch
---

Auto-install bundled runtime plugins (Hermes / OpenClaw / Paperclip) on first Save in Settings, and ship them inside the published CLI so npx-installed Fusion can load them. Previously the runtime cards rendered but `Save` / `Save and Test` failed with `Plugin "fusion-plugin-…-runtime" not found`, and the plugins were unavailable when the CLI was installed via npm/npx because their workspace `@fusion/plugin-sdk` dependency wasn't bundled. Each runtime plugin is now bundled at CLI build time into a self-contained `dist/plugins/<id>/bundled.js`, and `PUT /api/plugins/:id/settings` lazily registers a bundled runtime via the new `ServerOptions.ensureBundledPluginInstalled` hook the first time the user saves.
