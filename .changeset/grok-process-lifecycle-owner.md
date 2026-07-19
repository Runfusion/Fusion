---
"@runfusion/fusion": patch
---

summary: Keep Grok ACP process cleanup armed once per process, without listener growth.
category: fix
dev: Move Symbol.for process.exit reaper onto process-manager; lifecycle tests reimport that module instead of the full plugin graph under full-suite load.
