---
"@runfusion/fusion": patch
---

summary: Test mode tasks complete again — the mock executor marked the wrong steps since the 0-based step change.
category: fix
dev: mock-provider.ts sent 1-based step numbers to fn_task_update (0-based since FN-6607), so scripted full-task runs never marked Step 0 and failed with "Step N out of range" at steps#0:step-execute.
