---
"@runfusion/fusion": patch
---

summary: Node, mesh, and project CLI commands once again initialize the PostgreSQL central registry.
category: fix
dev: Restore the existing layer-less `CentralCore.init()` backend bootstrap that PostgreSQL dual-path cleanup accidentally left unreachable. Runtime attachment still adopts the project store layer through `attachBackendLayer()`, while standalone callers own and close their central backend lifecycle.
