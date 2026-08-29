# Goals Refinement Gate

[← Docs index](./README.md)

This document defines the evidence gate for activating **Slice 4: Schema/Focus-Set Refinement (Conditional)** in the Goals mission (`M-MP32KU9Y-0001-2ADN`). It is a governance artifact, not an implementation plan.

## Purpose

Slice 4 stays pending and intentionally under-specified until Slices 1–3 produce **observed pain from real use**. Fusion must not build a structured `successMetric` schema, a focus-set concept, or richer goal-progress/reporting surfaces because they seem plausible in advance. Refinement starts only when operators can point to real usage evidence showing the v1 shape is insufficient.

## Locked guardrails carried forward from the mission

The gate inherits the mission guardrails already locked by CEO + CTO + PM:

1. **Hard cap of 5 active goals** remains the v1 operating limit.
2. **Success metrics live in slice/feature text for v1** rather than a structured `successMetric` schema.
3. **Only Slice 1 was activated up front**; later slices were not meant to auto-start just because earlier work shipped.
4. Slice 4 is conditional follow-up work, not an automatic continuation of the v1 Goals rollout.

Until this gate is satisfied, Slice 4 remains pending in practice: no schema-expansion, focus-set, or reporting implementation work should begin.

## Acceptable trigger evidence

A written activation rationale may recommend Slice 4 only when it cites real usage evidence in one or more of these categories.

### 1. Operator friction

Observed operator pain using the v1 goals workflow may justify refinement when teams repeatedly struggle to create, maintain, interpret, or operationalize goals with the existing surfaces.

**Corresponding Slice 4 direction:** general post-v1 refinement work, but only where the pain is demonstrated rather than speculative.

### 2. Prompt-budget or context-window pressure from goal injection

If active-goal injection creates measurable prompt-budget pressure, context-window crowding, or citation noise during actual agent use, that is valid trigger evidence.

**Corresponding Slice 4 direction:** candidate focus-set or narrowing mechanisms so only the most relevant goals are injected or emphasized.

### 3. Unclear prioritization or unclear mission ↔ goal ownership

If real usage shows agents or operators cannot tell which goals should drive a mission, or cannot reliably distinguish active strategic priorities from background goals, that is valid trigger evidence.

**Corresponding Slice 4 direction:** candidate focus-set concepts, richer linkage semantics, or prioritization aids.

### 4. Free-text success-metric limitations that fail agent reasoning

If goals expressed only through free-text slice/feature descriptions cause repeated ambiguity, weak planning, poor validation, or unreliable agent reasoning, that is valid trigger evidence.

**Corresponding Slice 4 direction:** candidate structured `successMetric` schema, but only to solve the observed reasoning failure.

### 5. The hard 5-active-goal cap proving too tight

If real operating practice shows the fixed five-goal cap blocks necessary work, forces unhealthy churn, or hides the difference between globally active goals and a smaller currently emphasized subset, that is valid trigger evidence.

**Corresponding Slice 4 direction:** candidate focus-set concept or related prioritization model.

### 6. Reporting or visibility gaps

If operators cannot answer basic progress, coverage, linkage, or adoption questions with the v1 read surfaces, and the gap is observed in real workflows, that is valid trigger evidence.

**Corresponding Slice 4 direction:** candidate goal-progress or reporting views.

## Activation rule

Slice 4 may be activated only after a **written rationale** is recorded that:

- references **real usage evidence**, not anticipated future needs;
- identifies which trigger-evidence category or categories were observed;
- explains why the observed pain is significant enough to justify refinement now; and
- cites the structured evidence collected in the **FN-5963 conditional refinement trigger evidence pack/template**.

That written rationale must exist **before** anyone calls `fn_slice_activate` for `SL-MP32LAJW-0009-RHJQ`.

## Hard constraint: no automatic refinement

The existence of Slice 4 in the mission does **not** authorize automatic follow-on work.

- No structured `successMetric` schema work starts automatically.
- No focus-set concept starts automatically.
- No reporting or visibility expansion starts automatically.
- No schema or expansion task should be treated as pre-approved merely because Slices 1–3 shipped.

Without the written rationale and evidence trigger above, Slice 4 remains pending and unspecified.

## Separation of concerns

This gate intentionally stays narrow:

- **FN-5961 (this artifact):** defines *when* refinement may start.
- **FN-5962:** maintains the conditional refinement **options backlog** describing candidate directions.
- **FN-5963:** defines the **evidence pack/template** used to gather and cite the real-usage evidence behind an activation request.

This document should reference those sibling deliverables rather than duplicate them.

## Decision rule summary

Use this checklist before any Slice 4 activation:

- Is there observed pain from real use of Slices 1–3?
- Does the evidence fit one or more accepted trigger categories above?
- Has the evidence been captured in the FN-5963 evidence pack/template?
- Has a written rationale been recorded citing that evidence and naming the proposed refinement direction?
- Has all of that happened **before** `fn_slice_activate` is called for Slice 4?

If any answer is no, do not activate Slice 4.
