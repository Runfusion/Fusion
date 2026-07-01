---
"@runfusion/fusion": patch
---

summary: Preserve workflow setting values and prompt overrides during workflow export/import.
category: fix
dev: Workflow export envelopes now include settingValues and promptOverrides; imports restore them onto the new workflow id with store validation.
