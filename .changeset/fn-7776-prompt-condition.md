---
"@runfusion/fusion": minor
---

summary: Plugin prompt contributions can now gate content on per-project plugin settings.
category: feature
dev: PluginPromptContribution.condition is evaluated against effective plugin settings via a minimal `settings["key"] === "value"` / `!==` grammar (no eval); see docs/PLUGIN_AUTHORING.md.
