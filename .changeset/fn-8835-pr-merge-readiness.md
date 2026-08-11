---
"@runfusion/fusion": patch
---

summary: Prevent auto-merge attempts for branch-protected, behind, conflicting, or unknown PR states.
category: fix
dev: The legacy PR merge gate now requires normalized mergeability to be `clean` while preserving optional approval and check policy.
