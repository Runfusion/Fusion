---
"@runfusion/fusion": patch
---

summary: Fix Grok CLI model picker showing prompt text instead of real model names.
category: fix
dev: Rewrote parseModelLines in fusion-plugin-grok-runtime/process-manager.ts to strip the login/"Default model:"/"Available models:" preamble and `*`/`-` bullet markers plus the `(default)` annotation from verified `grok models` output; legacy `id - Label`, columnar, and JSON paths preserved.
