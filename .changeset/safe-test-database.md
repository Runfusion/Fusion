---
"@runfusion/fusion": patch
---

summary: Isolate automated tests and global test-mode runs from the normal Fusion database.
category: fix
dev: Adds dedicated FUSION_TEST_DATABASE_URL routing with a separate embedded test cluster fallback.
