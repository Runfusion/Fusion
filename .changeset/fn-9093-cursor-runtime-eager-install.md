---
"@runfusion/fusion": patch
---

summary: Fix Cursor CLI models failing with "install and enable the Cursor runtime plugin" after enabling the provider.
category: fix
dev: serve/dashboard/daemon now eagerly run `ensureBundledCursorRuntimePluginInstalled` at boot, mirroring the FN-7761 Grok bootstrap, so `getRuntimeById("cursor")` resolves for cursor-cli selections.
