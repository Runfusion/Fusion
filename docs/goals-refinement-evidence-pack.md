# Goals Refinement Evidence Pack

[← Docs index](./README.md)

This document defines the structured evidence pack contributors must fill out before recommending activation of **Slice 4: Schema/Focus-Set Refinement (Conditional)** in the Goals mission (`M-MP32KU9Y-0001-2ADN`). It standardizes how real-use pain is recorded; it is not an implementation plan and does not authorize Slice 4 work by itself.

## Purpose

The Goals mission guardrails intentionally keep v1 simple until real usage proves otherwise. This evidence pack exists so that when pain does appear, contributors capture it consistently and make any activation recommendation from observed evidence rather than speculation.

## Locked guardrails carried forward from the mission

Every observation collected here must be interpreted within the mission guardrails already locked by CEO + CTO + PM:

1. **Hard cap of 5 active goals** remains the v1 operating limit unless real use proves that cap is too restrictive.
2. **Success metrics live in slice/feature text for v1** rather than a structured `successMetric` schema unless real use shows that free text is insufficient.
3. **Only Slice 1 was activated up front**; later slices were intentionally not pre-approved.
4. Slice 4 is conditional follow-up work, not an automatic continuation of the Goals rollout.

These guardrails mean the evidence pack cannot be used to justify speculative implementation.

## Required evidence fields for each observation

Record each real-use observation as its own copy of the template below.

```md
### Observation <n>: <short title>
- **Observed pain:** <What broke down in real use? Name the pain clearly and state which conditional Slice 4 direction it points toward: structured success metrics, 5-cap/focus-set refinement, or reporting/visibility improvements.>
- **Frequency:** <How often did this occur? Include number of sessions, repeated incidents, or time-window evidence.>
- **Impacted workflow:** <Which workflow was affected: heartbeat, executor session, planning, reporting, mission review, operator triage, or another concrete workflow?>
- **Reproduction artifacts:** <Link the evidence: task IDs, run IDs, session IDs, prompt-budget figures, transcripts, screenshots, or other artifacts that prove the pain happened.>
- **Why this is independent:** <Explain why this observation is distinct from prior observations rather than another note about the same incident.>
```

### Field interpretation notes

- **Observed pain** must describe a real breakdown, not a hypothetical improvement idea.
- **Frequency** should be concrete enough to distinguish one-off friction from recurring pain.
- **Impacted workflow** should identify where the current v1 design is failing in practice.
- **Reproduction artifacts** should give reviewers enough evidence to inspect the incident directly.
- **Why this is independent** is required because the activation threshold depends on distinct observations.

## Activation threshold

An activation recommendation for Slice 4 requires **at least two independent real-use observations**.

**Independent** means the observations come from distinct sessions, workflows, or incidents. Two notes describing the same underlying event do **not** satisfy the threshold.

The observations may point to the same refinement direction, but they must still represent separate evidence from real use.

## Unmet-threshold rule

If the evidence pack does **not** contain at least two independent real-use observations, **Slice 4 remains pending and no implementation tasks are created**.

This evidence pack feeds the activation rule defined in [Goals Refinement Gate](./goals-refinement-gate.md). That gate is the artifact that decides whether Slice 4 may start. Candidate directions that an observation may point toward are maintained separately in the FN-5962 conditional refinement options backlog; this evidence pack should cite those options rather than duplicate or pre-approve them.

## How to use this template

1. Add one observation block per real-use incident.
2. Confirm each block includes all required fields.
3. Check whether at least two observations are truly independent.
4. If the threshold is met, prepare a written rationale under the [Goals Refinement Gate](./goals-refinement-gate.md) naming the observed pain and the candidate refinement direction.
5. If the threshold is not met, stop: Slice 4 stays pending and no schema, focus-set, or reporting implementation work should begin.

## Decision rule summary

Before recommending Slice 4 activation, confirm all of the following:

- Each observation includes **observed pain**, **frequency**, **impacted workflow**, and **reproduction artifacts**.
- The pack contains **at least two independent real-use observations**.
- The observations are grounded in the locked v1 guardrails rather than speculative product expansion.
- The final recommendation cites the [Goals Refinement Gate](./goals-refinement-gate.md) and points only to candidate directions tracked in FN-5962.

If any condition is missing, do not recommend activation.
