---
"@runfusion/fusion": patch
---

summary: Fix embedded PostgreSQL failing to start on Windows after the mmap shared-memory default.
category: fix
dev: "shared_memory_type=mmap (default added 2026-07-16 for SysV shm exhaustion) is rejected on Windows, where the only valid value is windows — every Windows embedded start died with FATAL invalid value for parameter before the port opened, failing the v0.70.0/v0.70.1 Windows release smoke. Default flags are now platform-aware via defaultEmbeddedPostgresFlagsFor: empty on win32 (Windows needs no override; SysV exhaustion cannot occur there), mmap elsewhere."
