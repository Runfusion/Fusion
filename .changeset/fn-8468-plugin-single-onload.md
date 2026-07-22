---
"@runfusion/fusion": patch
---

summary: Load each enabled plugin once per process startup (no duplicate onLoad).
category: fix
dev: Host CLI and InProcessRuntime share a single-load authority with concurrency-safe single-flight so path-registered plugins no longer double-fire onLoad on fn dashboard/serve/daemon startup.
