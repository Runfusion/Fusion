---
"@runfusion/fusion": patch
---

summary: Prevent multi-node workspace operations from overlapping or double-landing shared repositories.
category: fix
dev: Adds migration 0060 lease and land-intent tables, FUSION_NODE_ID plus process incarnation ownership, resource fence tokens and one-publish-per-tenancy refs under refs/fusion/workspace-lease/* and refs/fusion/merge-dispatch/*. Merge-dispatch tenancy pins publish on every target sub-repository remote before any workspace land begins; merge and land commit points use fence-validated target/fence CAS operations. `isMergePending` consults durable dispatch leases after local state, while startup and periodic sweeps conservatively retire only expired leases. Pending land intents recover project-wide from remote reachability through holder or no-live-lease recovery authority.
