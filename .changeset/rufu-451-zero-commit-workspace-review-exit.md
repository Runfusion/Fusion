---
"@runfusion/fusion": patch
---

summary: Source-free workspace cards can now leave review, from the board or from `fn task reconcile`.
category: fix
dev: A card declared `noCommitsExpected` is finalized as commit-free delivery by both the workspace land step and the `fn task reconcile` fence, on per-repository proof — its branch proven at zero commits ahead of its own recorded base, or a ref read showing the repository holds no artifact of it — plus the shared zero-commit door; the zero-commit contract is also derived when File Scope names only board-owned ignored paths. Both doors now read one obligation-set rule (`workspaceObligationRepositories`): a card whose confirmed scope names no repository but that still holds member checkouts owes per-member proof at the merge door too, so an unproven, missing, or modified checkout keeps the card in review instead of being closed. `fn task reconcile` gained refusal sentences for the new `workspace-obligation-free-unproven` code. No schema change.
