---
"@runfusion/fusion": patch
---

summary: Prevent verdict-less reviewer output from approving review gates.
category: fix
dev: Removes prose approval from workflow-step and reviewer parsers, requires trailing JSON in reviewer prompts, and adds optional WorkflowStepResult.verdictRequired.
