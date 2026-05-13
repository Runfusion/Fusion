---
"@runfusion/fusion": minor
---

Stop the post-merge audit from parking tasks as `failed` when deterministic merge verification already proved the resulting tree. Adds `postMergeAuditMode` project setting (`"block"` | `"warn"` | `"off"`, default `"block"`):

- A `rebase`-strategy audit that flags only touched-file overlap risks now passes through when the merged tree has a verification cache hit — silent drops are impossible by construction in that case.
- `warn` mode logs audit findings on the agent log but auto-completes the merge.
- `off` skips the audit entirely.

Duplicate-subject findings still block in `block` mode and squash-strategy audits still block (no equivalent deterministic guarantee). The FN-3936 silent-drop guard is preserved.
