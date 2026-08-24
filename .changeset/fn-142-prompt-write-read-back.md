---
"@runfusion/fusion": patch
---

summary: Restore reliable plan-save confirmations so planning no longer loops.
category: fix
dev: createTaskPromptWriteTool now verifies PROMPT.md through a post-write getTask read-back.
