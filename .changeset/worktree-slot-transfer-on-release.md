---
"@runfusion/fusion": patch
---

summary: Planned tasks release at full concurrency again — a card's retained planning worktree no longer blocks its own release.
category: fix
dev: Follow-up to the widened maxWorktrees ledger: a Ready card reuses its planning worktree on release, so its held slot transfers instead of double-counting. Observed live as only 2 of 4 slots releasing after unpause.
