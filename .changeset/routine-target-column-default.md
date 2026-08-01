---
"@runfusion/fusion": patch
---

summary: Routines and scheduled tasks no longer create work into a column the board does not have.
category: fix
dev: Create-task steps defaulted their target column to `triage`, which U11 removes from the default workflow. An explicit column bypasses workflow entry-column resolution, so tasks landed in an undeclared column. Now no column is sent by default and each workflow's own intake resolution decides, which is correct for custom boards where `todo` may not exist either. `routine-runner.ts` and `cron-runner.ts` both substituted `"triage"` at execution time and defeated the form-level fix; both now omit it. The `triage` option is removed from the editor and a persisted `triage` is coerced to Automatic on load.
