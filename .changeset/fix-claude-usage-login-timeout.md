---
"@runfusion/fusion": patch
---

summary: Report when the server Claude CLI needs login instead of waiting a minute and showing a false usage timeout.
category: fix
dev: Detects Claude Code 2.1.x unauthenticated and API-billing session-stat screens during the PTY quota fallback and exits immediately.
