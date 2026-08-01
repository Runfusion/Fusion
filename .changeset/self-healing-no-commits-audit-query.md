---
"@runfusion/fusion": patch
---

summary: The zero-commit audit sees quietly-parked review cards again on renamed boards.
category: fix
dev: `auditNoCommitsExpectedCandidates` read the literal `in-review`, so on a renamed board only the `no_commits` error path fed the audit and a card sitting in a renamed review lane with zero commits and no error was never flagged. Read resolves via `resolveProjectColumnsForRoles`, the lane verdict resolves per card.
