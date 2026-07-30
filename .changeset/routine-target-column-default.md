---
"@runfusion/fusion": patch
---

summary: Routines no longer create tasks into a column the board does not have.
category: fix
dev: The routine editor's "Target Column" defaulted to `triage`, which U11 removes from the default workflow. An explicit column bypasses the intake fallback added for column-less creates, so routines saved with the untouched default seeded tasks into an undeclared column. Defaults to `todo` (the merged pre-implementation column). The option labels remain inverted against the board and are left as a follow-up.
