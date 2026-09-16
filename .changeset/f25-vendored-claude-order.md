---
"@runfusion/fusion": patch
---

summary: Keep Fusion's vendored Claude CLI adapter first when reconciling extension paths.
category: fix
dev: Remove any existing vendored occurrence before prepending the canonical adapter path while filtering external aliases.
