---
"@runfusion/fusion": patch
---

summary: Fix code review revisions never producing fix steps — the card stayed blocked in review with no explanation.
category: fix
dev: `reviewInputSignature` and `deriveWorkspaceReviewRemediation` used NUL (U+0000) as a field separator. Both signatures became persisted state when FN-267 introduced the remediation claim (`remediationAttemptSignature`, `reviewRemediation.inputSignature`), and PostgreSQL rejects NUL in text/jsonb with SQLSTATE 22P05 — so every claim write threw and no remediation could ever be scheduled. Separators are now U+001F/U+001E. No migration: the broken write never persisted a signature.
