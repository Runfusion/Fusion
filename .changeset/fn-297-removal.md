---
"@runfusion/fusion": patch
---

summary: One Coding (Ideas) workflow remains (formerly V2); Coding is now Coding (Auto).
category: internal
dev: Removes `builtin:coding-ideas` from the offered catalog and maps it to `builtin:coding-ideas-v2` across all five catalog-read seams, including `isBuiltinWorkflowEnabled`. Both authoritative selection readers canonicalize persisted legacy rows so the board and scheduler share one Ideas identity and never render homonymous lanes. The four persistence paths (`selectTaskWorkflowImpl`, `selectTaskWorkflowAndReconcileImpl`, `materializeExplicitWorkflowStepsImpl`, and `setDefaultWorkflowIdImpl`) normalize requests before writing, while all three prompt-override/plugin-gating lookups use the successor key. Operator-owned `enabledBuiltinWorkflowIds` values remain unchanged but are understood through the mapping. No migration ships and `SCHEMA_BASELINE_VERSION` remains `0071`, so older Fusion binaries retain database access. Repointed cards adopt the successor's `stepReopenPolicy: "none"` named-remediation behavior; an in-flight card uses the existing one-time IR-drift requeue and resumes on the current graph.
