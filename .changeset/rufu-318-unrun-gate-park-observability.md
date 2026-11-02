---
"@runfusion/fusion": patch
---

summary: A withheld never-ran-gate repair now says so: a History line, an audit row, and a mailbox notice.
category: fix
dev: New `task:merge-unrun-gate-park-no-action` run-audit event naming the refusing guard (`refusalReason`) and the park's age; `task:merge-unrun-gate-park-repaired` now records only `outcome: "repaired"`. Refusals repeat per 6 h window instead of once per engine lifetime.
