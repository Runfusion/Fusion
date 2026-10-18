---
"@runfusion/fusion": patch
---

summary: Fix the packaged CLI failing on a clean install because its schema package was not installed.
category: fix
dev: Moves `typebox` from the CLI devDependencies to runtime dependencies, drops the stale optional-peer entry, and refreshes only the matching pnpm-lock importer metadata.
