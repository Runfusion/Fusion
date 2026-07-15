---
"@runfusion/fusion": patch
---

summary: Fix protected image artifacts so previews and links load in authenticated dashboards.
category: fix
dev: Artifact media URLs now use the existing same-origin query-token fallback required by browser image and link navigation.
