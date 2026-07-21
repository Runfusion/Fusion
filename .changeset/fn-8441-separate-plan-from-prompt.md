---
"@runfusion/fusion": minor
---

summary: Planning Mode plan.md is now distinct from triage PROMPT.md on task create.
category: feature
dev: Validate+create-task serializes PlanningSummary as plan.md into task.description and task document key=plan; stores session initialPlan as task document key=original-description; triage expands plan.md into PROMPT.md while Original Description stays the operator request. Running plan stays lean (title/description/size/deps/deliverables); priority remains a task field only.
