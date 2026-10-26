---
"@runfusion/fusion": patch
---

summary: Workflow steps now honor the step timeout saved for their selected workflow.
category: fix
dev: The moved `workflowStepTimeoutMs` key was still read from raw project settings, so a value saved in the Workflow Editor was ignored and every prompt/review step fell back to the 900000 ms default. The timeout now resolves the effective task-selected workflow settings; the 60000 ms floor, the 900000 ms default, and every other settings consumer are unchanged.
