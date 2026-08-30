---
"@runfusion/fusion": patch
---

summary: Workspace tasks no longer stall on uncommitted edits sitting in a shared repo checkout.
category: fix
dev: The main-checkout completion guard blocks only task-attributed commits; uncommitted status entries emit `worktree:workspace-main-checkout-edit` with `outcome:"warned"`, `reason:"uncommitted-only"`, and their evidence enum. Delivery stays proven by the acquired-worktree `no_commits` invariant, and the land path already stashes/restores a dirty sub-repo checkout via `merger.allowDirtyLocalCheckoutSync`.
