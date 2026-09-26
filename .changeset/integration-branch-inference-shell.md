---
"@runfusion/fusion": patch
---

summary: Restore branch inference when origin/HEAD is absent and keep ref lookups out of the shell.
category: fix
dev: Use argv-based `for-each-ref` calls so the shell cannot reinterpret Git's format syntax or ref prefix.
