---
"@runfusion/fusion": patch
---

summary: Keep OMP ACP process cleanup armed once per process, without listener growth.
category: fix
dev: Mirror grok-runtime — Symbol.for process.exit reaper on process-manager; lifecycle stress test reimports that module under full-suite load.
