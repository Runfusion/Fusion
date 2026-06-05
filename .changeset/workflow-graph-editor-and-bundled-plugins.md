---
"@runfusion/fusion": patch
---

Fix the workflow graph editor opening invisibly and bundle the Compound Engineering and Roadmaps plugins.

- The "Graph editor" button now actually shows the editor: its overlay was rendered without the `open` class, leaving it `display: none`, so opening it looked like the workflow steps view was just dismissed.
- `fusion-plugin-compound-engineering` and `fusion-plugin-roadmap` are now listed in the dashboard's built-in plugins, so they appear under Settings → Built-in Plugins (they were implemented and registered but missing from the list).
- Installing Compound Engineering (and CLI Printing Press) from Settings → Built-in Plugins no longer fails with "Plugin manifest not found": both ids are now in the dashboard's bundled-plugin fallback set, and the Compound Engineering plugin is staged into `dist/plugins/` so packaged installs can resolve it.
- Plugins installed from Settings now load instead of erroring with "Plugin entry must be a file, got directory": the dashboard install routes register the plugin's loadable entry file (`bundled.js`/`dist/index.js`/`src/index.ts`) rather than the package directory, and enabling a plugin heals legacy directory-path registrations in place.
