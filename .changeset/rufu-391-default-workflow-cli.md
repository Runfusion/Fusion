---
"@runfusion/fusion": minor
---

summary: Set the project default workflow from the CLI with `fn settings set defaultWorkflowId`.
category: feature
dev: The key joins the project-only string settings; `none`, `null`, or an empty string clears it. Every write surface (CLI, `PUT` project default, generic `PUT` settings save, settings import) now validates the id through one shared store-seam predicate, so unknown, deprecated, project-disabled, plugin-gated, and fragment ids are refused with a clear message instead of being persisted. Read-side resolution and previously stored values are unchanged.
