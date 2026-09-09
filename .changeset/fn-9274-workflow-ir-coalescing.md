---
"@runfusion/fusion": patch
---

summary: Improve dashboard and scheduler responsiveness for projects with long task histories.
category: performance
dev: Coalesces workflow IR reads, adds observed WorkflowDefinitionReadTally accounting, prefetchWorkflowIrs, and optional list IR cache/tally options.
