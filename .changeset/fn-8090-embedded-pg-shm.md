---
"@runfusion/fusion": patch
---

summary: Embedded PostgreSQL now boots on hosts with a 64MB /dev/shm.
category: fix
dev: Defaults the embedded lifecycle to mmap-backed primary shared memory while preserving later caller flag overrides.
