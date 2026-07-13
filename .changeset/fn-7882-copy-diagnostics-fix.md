---
"@runfusion/fusion": patch
---

summary: Fix "Copy diagnostics" crash on non-secure origins (mobile/HTTP).
category: fix
dev: Command Center System tab now routes diagnostics copy through copyTextToClipboard (secure-context guard + execCommand fallback) instead of navigator.clipboard.writeText, which was undefined outside secure contexts.
