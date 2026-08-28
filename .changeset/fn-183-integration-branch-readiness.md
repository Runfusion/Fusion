---
"@runfusion/fusion": patch
---

summary: Ensure project registration creates or adopts a usable local integration branch.
category: fix
dev: Registration now reconciles local and origin remote-tracking branch refs before merge workflows use them.
