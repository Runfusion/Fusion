---
"@runfusion/fusion": patch
---

summary: Fix broken beta binary builds — bun executables and the Windows desktop EXE package again.
category: fix
dev: bun compile marks `chromium-bidi` external (optional playwright-core BiDi require); release.yml quotes `-c.publish.channel=beta` so PowerShell stops splitting it into a config-file path.
