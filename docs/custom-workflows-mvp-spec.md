# Custom Non-Coding Workflows MVP Spec (FN-5729)

[← Docs index](./README.md)

## Purpose

Define a one-week MVP that lets non-coding users declare and run custom workflows in Fusion, while reusing current workflow-step and lifecycle primitives where possible.

## 1) User-Needs Validation (v1 target users)

### User story 1 — Research ops lead
- **Who:** Product/research lead running weekly competitive scans.
- **What they do:** Trigger a multi-step flow (collect sources → summarize findings → produce decision memo).
- **Current pain:** Handoff between docs/spreadsheets/manual prompts is brittle and not repeatable.
- **Why Fusion helps:** Existing agents, task docs, and workflow gates can turn this into a reusable declared flow with observable state.

### User story 2 — Content operations manager
- **Who:** Content lead publishing launch briefs.
- **What they do:** Intake brief → draft copy → style/brand check → publish checklist.
- **Current pain:** Steps are tracked in chat threads; no durable execution record.
- **Why Fusion helps:** Task lifecycle + workflow-step verdict contracts already provide checkpointing and auditable outcomes.

### User story 3 — Support triage coordinator
- **Who:** Support manager routing high-priority tickets.
- **What they do:** Classify ticket → enrichment research → assign owner → produce response draft.
- **Current pain:** Routing quality varies by operator; escalation logic is implicit.
- **Why Fusion helps:** Declared states/transitions make routing policy explicit and measurable.

### User story 4 — Internal ops runbook owner
- **Who:** Ops generalist managing recurring incident-prep checks.
- **What they do:** Run a fixed checklist and collect artifacts for leadership review.
- **Current pain:** Runbooks live in docs but execution evidence is scattered.
- **Why Fusion helps:** Workflow-run artifacts can be persisted as task documents and reviewed through one lifecycle.

### Not solving in v1 (explicit cut list)
- Drag-and-drop visual workflow builder.
- Arbitrary external system actions (e.g., direct Jira/CRM writes) beyond existing Fusion tools.
- Multi-workflow orchestration/dependencies between workflows.
- Custom per-step RBAC model beyond existing toolMode/sandbox controls.
- Template marketplace/versioning.

## 2) Workflow-Definition Contract (minimum declarative schema)

### Proposed minimal contract
```yaml
id: "research-brief-v1"
name: "Research Brief Workflow"
entry:
  taskTemplate: "Research brief: {{topic}}"
states:
  - id: intake
  - id: research
  - id: synthesis
  - id: review
  - id: done
transitions:
  - from: intake
    to: research
  - from: research
    to: synthesis
  - from: synthesis
    to: review
  - from: review
    to: done
steps:
  - state: research
    mode: prompt
    role: researcher
    toolMode: readonly
    gateMode: advisory
    successVerdict: APPROVE|APPROVE_WITH_NOTES
  - state: review
    mode: prompt
    role: reviewer
    toolMode: readonly
    gateMode: gate
    successVerdict: APPROVE
artifacts:
  required:
    - key: findings
      type: task_document
    - key: summary
      type: task_document
successCriteria:
  - "All gate steps APPROVE"
  - "Required artifacts exist"
```

### Mapping to existing primitives
| Contract element | v1 handling | Source alignment |
|---|---|---|
| `steps[].mode` prompt/script | **Extend existing** | `docs/workflow-steps.md` execution modes |
| `steps[].toolMode` readonly/coding | **Extend existing** | `docs/workflow-steps.md` tool-mode allowlist |
| `steps[].gateMode` gate/advisory | **Extend existing** | `docs/workflow-steps.md` gate semantics |
| `successVerdict` envelope | **Extend existing** | Structured verdict contract in `docs/workflow-steps.md` |
| States/transitions graph | **New (changed)** | Current system is lifecycle-fixed (`planning→...→done`) per `docs/architecture.md` |
| Role assignment (`role`) | **New (changed)** | Reuses agent role concepts but not currently workflow-declared |
| Artifact requirements | **New (changed)** | Leverages task documents but adds declarative requirements |
| `successCriteria` list | **New (changed)** | Complements existing completion semantics |

### Relationship to missions
- **Missions (`docs/missions.md`) remain decomposition/planning** (what to deliver: mission→milestone→slice→feature→task).
- **Custom workflows define execution behavior** (how a task runs through declared states/steps).
- v1 keeps them distinct: mission features may reference a workflow definition ID, but missions do not become workflow engines.

### v1 authoring surface decision
- **Chosen for v1: file-based YAML in repo (`.fusion/workflows/`)**.
- **Rationale:** fastest shippable path, reviewable in git, no immediate dashboard form complexity, aligns with one-week MVP.
- **Deferred to v2:** dashboard authoring/edit UI with validation and templates.
- **Explicitly not in v1:** dual-surface authoring (file + dashboard) to avoid sync/conflict complexity in the one-week slice.

### Persistence location (no implementation)
- v1 definition registry can be referenced from project settings (analogous to `settings.scripts` in `docs/settings-reference.md`), e.g., project setting storing file paths/active workflow IDs.
- Full dedicated workflow store is deferred to v2.

## 3) MVP Slice + Success Metrics

### Smallest end-to-end vertical (one week)
A non-coding operator can:
1. Add one YAML workflow definition.
2. Attach that definition to a new task.
3. Run the task through declared prompt/script steps using existing workflow-step engine behavior.
4. Observe run state + produced artifacts in task documents and workflow results.

Constraint: this vertical must ship without introducing a new workflow runtime separate from existing workflow-step execution.

### DONE criteria (Given/When/Then)
1. **Given** a valid workflow YAML with 3+ states and at least one gate step, **when** a task is started with that workflow ID, **then** Fusion executes declared steps in order and records per-step verdict output.
2. **Given** a step marked `toolMode: readonly`, **when** the assigned agent runs, **then** tool access is restricted to the existing readonly allowlist and violations fail closed.
3. **Given** required artifacts in the workflow definition, **when** run reaches terminal success, **then** all required task-document keys exist or the run is marked incomplete.
4. **Given** a gate step returns `REVISE`, **when** evaluation completes, **then** task follows existing revision-loop behavior rather than silently marking success.

### Out-of-scope guardrails (v2 deferrals)
- Workflow graph editor in dashboard.
- Cross-workflow triggers/event bus.
- External action connectors (Slack/Jira/Zendesk write-back).
- Advanced policy engine (per-step secret scopes, org-level approvals).
- Runtime migration/versioning of workflow definitions.

### Success metrics and instrumentation
1. **Time-to-first-run** (median time from workflow definition commit/registration to first completed run).
   - **Telemetry status:** partially available via task/run timestamps; add explicit `workflow_definition_registered` and `workflow_run_started` events.
2. **Workflow completion rate** (% runs reaching success criteria without manual intervention).
   - **Telemetry status:** needs new run-level status keyed by workflow definition ID.
3. **30-day adoption** (# distinct projects with ≥1 custom workflow run).
   - **Telemetry status:** needs definition-ID tagging on task/workflow-step events.

## 4) Risks, Constraints, and Open Questions

### Conflicts with coding-tuned lifecycle invariants
- **Fixed lifecycle vs declared states:** `docs/architecture.md` assumes canonical task columns; v1 should map custom states onto internal step progression without altering board columns.
- **File-scope guards / `FileScopeViolationError`:** many non-coding workflows may be read-only and doc-artifact heavy; v1 should default to readonly/tool-limited steps and avoid introducing write steps that trigger code-oriented scope friction.
- **Squash-merge contract:** non-coding workflows may not produce code commits; success path should allow completion with zero code diffs when workflow is explicitly non-coding.
- **Self-healing expectations:** retry/recovery assumes coding task execution loops; v1 should constrain auto-retry semantics to step-level reruns without forcing branch mutation.
- **`autoMerge:false` semantics (AGENTS.md):** for projects with manual merge policy, `in-review` is terminal-until-human-merge, so custom non-coding runs must not be moved backward by self-healing routines after entering review/terminal states.

### Permissions and sandboxing
- Non-coding workflows should default to `toolMode: readonly` (`docs/workflow-steps.md`) with explicit opt-in to coding mode.
- For research-style flows, allow readonly file/docs inspection plus `fn_web_fetch` and insight/task-list tools; deny mutation tools by default.
- Sandbox posture should align with `docs/sandbox.md`: maintain port-4040 guard, deny unnecessary writes, and keep worktree/document boundaries explicit.

### CEO/CTO decision checklist (open questions)
1. Should v1 permit **any** `toolMode: coding` steps, or enforce readonly-only for launch safety?
2. Should custom workflow state names be user-visible only, while internal lifecycle columns remain unchanged?
3. Is file-based authoring acceptable for first launch, or is minimal dashboard create/select required for market validation?
4. What is the minimum telemetry event set required before launch (must-have vs nice-to-have)?
5. Should mission features be allowed to require a workflow ID at triage time in v1, or deferred?

## 5) Summary Recommendation

Ship a constrained v1 that reuses workflow-step primitives (prompt/script, gateMode, toolMode, verdict contract), adds a minimal declarative workflow definition contract, and limits launch to one file-authored workflow path with clear telemetry and safety guardrails. This delivers the CEO/CTO inversion-of-control goal in a week without destabilizing core coding lifecycle contracts.
