---
"@runfusion/fusion": patch
---

summary: Prevent cross-project plugin discovery from unloading enabled plugin skills.
category: fix
dev: Discovery loaders use isolated lifecycles; shared non-owner stops now detach only.
