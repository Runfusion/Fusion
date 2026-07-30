---
"@runfusion/fusion": patch
---

summary: Fix CLI commands that stopped working on boards with renamed columns.
category: fix
dev: `fn task retry` classified stalls and re-queued with the literals `in-review`/`todo`, so on a renamed board it silently did nothing (and, once the classifier alone was fixed, threw `Invalid transition`). Also converted the near-duplicate candidate filter, the archived-lineage label, both node-override in-progress guards, and the four copies of the active-task count in `fn dashboard` (all four reported `active=0`). Column roles now resolve from each task's own workflow traits, falling back to the legacy ids when a workflow cannot be resolved.
