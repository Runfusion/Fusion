---
"@runfusion/fusion": patch
---

summary: Fix clean-CI typechecking for bundled plugins that use PostgreSQL schemas.
category: fix
dev: Bundle the core schema through a runtime-only shim instead of requiring an unbuilt core dist artifact.
