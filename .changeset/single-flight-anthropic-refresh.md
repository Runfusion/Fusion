---
"@runfusion/fusion": patch
---

summary: Prevent concurrent tasks from falling back when an Anthropic OAuth token rotates.
category: fix
dev: Serializes Anthropic refresh-token rotation across auth storage instances and Fusion processes.
