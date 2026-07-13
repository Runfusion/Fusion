---
"@runfusion/fusion": patch
---

summary: Stop abandoned AI-session prompts when planning and interview generations are aborted.
category: fix
dev: Forwards AbortSignal into guarded prompt calls and disposes in-flight agent sessions on abort.
