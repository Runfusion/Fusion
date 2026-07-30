---
"@runfusion/fusion": patch
---

summary: Node, mesh, and project CLI commands restore registry access without marking the host offline on exit.
category: fix
dev: Restore the existing layer-less `CentralCore.init()` backend bootstrap that PostgreSQL dual-path cleanup accidentally left unreachable. Generic `close()` only releases resources; daemon, engine-manager, and dashboard shutdown owners retain their explicitly ordered `markLocalNodeOffline()` writes.
