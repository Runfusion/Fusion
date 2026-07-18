---
"@runfusion/fusion": patch
---

summary: Keep Anthropic subscription sessions connected by refreshing OAuth credentials with the correct client identity.
category: fix
dev: Corrects the Claude OAuth client ID used by the engine refresh request and adds request-contract coverage.
