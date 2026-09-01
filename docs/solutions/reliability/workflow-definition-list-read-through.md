---
title: "Workflow definition listings must read through across TaskStore instances"
date: 2026-09-01
problem_type: reliability
module: "@fusion/core"
component: workflow-definitions
tags:
  - workflows
  - task-store
  - postgres
  - cache-coherence
  - multi-instance
symptoms:
  - "workflow listings and single-workflow lookups return different stored fields"
  - "workflow edits remain invisible in listings until the daemon restarts"
root_cause: "A process-lifetime workflowDefinitionsCache belonged to one TaskStore instance, while writes and single-workflow reads used other instances or live database rows."
resolution_type: code_fix
---

## Problem

`listWorkflowDefinitions` previously returned a process-lifetime snapshot after its first custom-workflow read. `getWorkflowDefinition` read custom workflow rows through the data layer on every call. A plugin startup sync, dashboard edit, or background writer using another `TaskStore` could therefore commit a new name, description, icon, layout, or IR while an already-populated listing still returned the prior object indefinitely.

This made `fn_workflow_list` and `fn_workflow_get` disagree in one daemon session. The impact was broader than version text in a description because listings contain complete workflow definitions, including their graph IR.

## Resolution

`readAllWorkflowDefinitionsImpl` now reads `project.workflows` on every invocation and merges freshly mapped custom rows with `BUILTIN_WORKFLOWS`. The per-instance `TaskStore.workflowDefinitionsCache` field and all of its local write and plugin-event invalidation paths were removed.

The listing and single-workflow paths now observe the same committed row state. PostgreSQL regression coverage uses two `TaskStore` instances over one data layer and verifies list/get agreement after an update, create, and delete performed by the second instance.

## Rule

A store-owned process-lifetime cache cannot represent mutable workflow definitions when more than one `TaskStore` instance may write. Do not reintroduce a TTL, generation, single-flight, or invalidation-based cache at this seam: any stale window can make list and get disagree again.

When profiling identifies a hot repeated lookup within one bounded operation, use a caller-owned per-pass cache that is discarded before the next pass. See [Workflow selection read-once-per-tick in the scheduler](../workflow-selection-per-tick-cache.md) for the sanctioned pattern.
