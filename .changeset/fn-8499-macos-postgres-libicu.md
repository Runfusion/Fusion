---
"@runfusion/fusion": patch
---

summary: Fix macOS embedded PostgreSQL startup when bundled ICU compatibility links are missing.
category: fix
dev: Repair the libicuuc loader-name symlink before initdb starts.
