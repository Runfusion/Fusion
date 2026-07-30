---
"@runfusion/fusion": patch
---

summary: The List view now recovers a just-created card's workflow instead of waiting for an unrelated refresh.
category: fix
dev: Extracts Board's FN-7591 unmapped/suspect-workflow refetch into `useUnmappedWorkflowRefetch` and wires ListView to it. Without it, a task whose `taskWorkflowIds` entry is absent or resolves to a workflow that does not declare its column kept approximated move metadata until some other refresh occurred.
