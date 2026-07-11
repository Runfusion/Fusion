---
"@runfusion/fusion": patch
---

summary: Repair macOS embedded PostgreSQL dylib compatibility links before startup.
category: fix
dev: Adds an idempotent embedded-postgres macOS preflight that creates missing ABI-name symlinks such as `libpq.5.dylib` and `libzstd.1.dylib` from bundled versioned dylibs before `initdb`/`postgres` spawn, fixing zero-config startup when package symlink hydration is absent or incomplete.
