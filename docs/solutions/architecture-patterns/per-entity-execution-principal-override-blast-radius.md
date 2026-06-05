---
category: architecture-patterns
module: engine
date: 2026-06-05
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Adding a per-entity override that substitutes WHO/WHAT executes work (agent identity, model, principal)"
  - "Wiring a new binding that supersedes task- or node-level settings (e.g. column agents, defer/override precedence)"
  - "Reviewing a feature whose rollback story is 'disable the experimental flag'"
tags:
  - column-agent
  - execution-principal
  - override-precedence
  - kill-switch
  - heartbeat
  - workflow-columns
related:
  - docs/solutions/logic-errors/per-task-auto-merge-override-ignored-by-trigger-gates.md
  - docs/plans/2026-06-04-002-feat-column-agent-assignment-plan.md
---

# Per-entity execution-principal override: the full blast-radius checklist

## Context

The column-agent feature (PR #1432) lets a workflow column bind a registry agent that supersedes task/node agent settings (`defer`/`override`). The auto-merge-override lesson already taught "consult the override at every trigger gate, not just the action site." This feature showed the *execution-principal* variant has an even wider blast radius: plan review, code review, and two rounds of PR bots each found another subsystem still keyed on the old identity (`task.assignedAgentId`) — found one at a time, at increasing cost.

## Guidance

When work can run as an identity different from the one stored on the entity, enumerate and re-key ALL of these up front (Fusion's catalog; analogous sets exist elsewhere):

1. **Session identity** — model resolution (`resolveExecutorSessionModel` runtimeConfig arg), persona, memory tools, attribution id.
2. **Permission gating** — `buildActionGateContext`/`buildPermanentAgentGatingContext` must receive the agent *actually running* (security boundary, not UX).
3. **Serialization, BOTH directions** — the deferral gate (`shouldDeferForHeartbeat`) AND the reverse guards keyed on `agent.taskId` in `agent-heartbeat.ts` (an agent may be effectively executing work it isn't assigned to → `isAgentEffectivelyExecuting` callback, wired at every scheduler construction site).
4. **Wake-up/resume queries** — `resumeTaskForAgent`'s task-SELECTION filter, not just its gate input; a second pass matching the *effective* identity. Watch for nodes that live only in nested structures (foreach templates are not in `ir.nodes` — walk subgraphs).
5. **Change detection / hot-swap** — the restart watcher diffs *task fields*; an override sourced from a workflow definition or agent config needs its own invalidation path, including the **release** branch (binding removed, or defer re-resolving to own settings) which must also clear the tracked principal and reverse-guard map.
6. **Kill-switch parity** — if the rollback story is "disable flag X," every execution-path entry point must actually read flag X. Gate the single choke point (resolver installation) AND any path that resolves independently (resume pass 2 resolved the IR directly and needed its own guard).
7. **Write-surface parity for safety gates** — a confirmation gate (policy escalation) added to the HTTP route is bypassed by agent tools writing through the store; share one validator (`validateColumnAgentBindings` in core) across ALL write surfaces.

Precedence itself: one shared core resolver with explicit named branches (no `??` collapse), discriminated result for audit, and all-or-nothing own-settings semantics matched to the existing model resolver's both-present rule.

## Why This Matters

Each missed subsystem is a distinct production failure: gates computed for the wrong principal (privilege error), tasks stranded in-progress after heartbeats (resume miss), serialization contract violated (reverse guard), stale sessions after edits (watcher), and a rollback flag that doesn't actually roll back. None are caught by the feature's own happy-path tests; all were found by adversarial review or bots after implementation. The checklist converts five rounds of discovery into one design pass.

## When to Apply

Any feature where resolution of "who runs this" gains a new input: column/lane staffing, per-project agent defaults, delegation, impersonation, or model-override layers. Also when reviewing: grep every reader of the old identity field (`assignedAgentId`-style) and demand each is either re-keyed or argued irrelevant.

## Examples

- Single-flight interaction: when one memoized implementation pass serves many callers (foreach instances), a per-call mutable slot races — the pass-*initiating* caller must own the slot for the pass's lifetime (`runGraphTaskStep` stamps `graphSeamGoverningNodeId` only when it creates the memo, clears on settle).
- Surface-matrix tests (FN-5893): mode (defer/override) × surface (custom node, execute seam, step-execute, heartbeat, missing-agent fallback) × own-settings, plus characterization tests pinning the no-binding path byte-identical (parity oracle) and a kill-switch inertness test.
- Ambiguous composite ids: `<foreachId>#<i>:<templateNodeId>` is unparseable under any single split when ids contain the delimiters — iterate candidates and validate against the graph (`parseInstanceNodeIdCandidates`), including that the *template node* exists, not just the container.
