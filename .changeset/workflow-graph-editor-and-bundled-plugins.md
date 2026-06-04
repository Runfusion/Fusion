---
"@runfusion/fusion": patch
---

Fix the workflow graph editor opening invisibly and bundle the Compound Engineering and Roadmaps plugins.

- The "Graph editor" button now actually shows the editor: its overlay was rendered without the `open` class, leaving it `display: none`, so opening it looked like the workflow steps view was just dismissed.
- `fusion-plugin-compound-engineering` and `fusion-plugin-roadmap` are now listed in the dashboard's built-in plugins, so they appear under Settings → Built-in Plugins (they were implemented and registered but missing from the list).
