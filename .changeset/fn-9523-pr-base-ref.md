---
"@runfusion/fusion": patch
---

summary: Protect pull request conflict resolution from unpublished local base commits.
category: fix
dev: PR base selection now refreshes and prefers the verified remote-tracking branch, with local/remote divergence diagnostics.
