---
"@runfusion/fusion": patch
---

summary: Fix dashboard build failure caused by missing html2canvas dependency.
category: fix
dev: Add html2canvas@^1.4.1 to @fusion/dashboard deps (bundled types) so app/utils/capture-screenshot.ts resolves.
