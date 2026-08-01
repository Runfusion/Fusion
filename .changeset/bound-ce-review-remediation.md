---
"@runfusion/fusion": patch
---

summary: Compound Engineering Code Review now parks after two unsuccessful remediation attempts instead of retrying forever.
category: fix
dev: The built-in CE `code-review` optional group now declares `maxRevisions: 2`; custom workflow authors can still choose a different numeric cap or explicit unbounded behavior.
