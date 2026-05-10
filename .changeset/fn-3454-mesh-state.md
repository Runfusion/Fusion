---
"@runfusion/fusion": patch
---

Expose `/api/mesh/state` as a real cluster snapshot API that aggregates peer-local mesh state and powers Nodes topology from actual `knownPeers` relationships instead of fabricated node-list links.
