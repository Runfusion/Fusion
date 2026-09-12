---
"@runfusion/fusion": patch
---

When `integrationBranch` (or fallback `baseBranch`) names a branch that does not exist
locally or in `refs/remotes/origin/`, the resolver now skips that rung and falls through
to `origin/HEAD` → inferred branch → `main` fallback instead of propagating a ghost ref
to `git worktree add`, which previously aborted with `fatal: invalid reference: <branch>`
and retried indefinitely across worktree acquisition, merge, recovery, and branch-conflict
paths (all route through `resolveIntegrationBranch`).
