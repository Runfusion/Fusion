# Mission Completion Gate Contract

## Status

- **Decision date:** 2026-05-30
- **Task:** FN-5718
- **Depends on enforcement behavior from:** FN-5715 (reference implementation of the trigger/recovery path)
- **Scope:** Product contract and implementation requirements only (no code changes in this task)

## Problem

Mission validation has had a recurring ambiguity: users can see feature acceptance text and milestone "completion criteria" text, but autopilot enforcement is actually driven by assertion linkage + validator outcomes. This document defines the canonical enforced gate so mission completion cannot silently stall or be misread.

## Canonical Completion Gate (Enforced)

### Decision

A feature is autopilot-complete only when **its linked contract assertions are satisfied**.

Canonical authored source and enforcement path:

1. `MissionFeature.acceptanceCriteria` is the canonical authored criteria text (authoring surface).
2. MissionStore must maintain a **store-managed per-feature `MissionContractAssertion`** derived from feature content, with text priority:
   - `feature.acceptanceCriteria`
   - `feature.description`
   - `Verify implementation of: {feature.title}`
3. The mission validator enforces completion using the feature's **linked assertions** (including its store-managed assertion and any additional linked milestone assertions).
4. Feature/slice/mission advance is gated by the validator outcome (or explicit no-assertions auto-pass behavior defined below).

### Precedence and interpretation rules

- `MissionFeature.acceptanceCriteria` is the canonical authoring field for feature-level intent.
- The **linked assertion set** is the canonical enforcement set.
- Milestone `MissionContractAssertion` rows are additive contract rows. They are enforced **only when linked to a feature**.
- `milestone.acceptanceCriteria` is descriptive/informational milestone text and is not directly executed by the validator.

### Worked examples

1. **Feature has acceptance criteria; store-managed assertion linked; validator passes**
   - Result: feature may move to done/passed and contribute to slice completion.
2. **Feature has acceptance criteria; additive milestone assertion also linked; one linked assertion fails**
   - Result: feature is not complete; no slice advance.
3. **Feature has acceptance criteria visible, but no linked assertions (legacy FN-5696 shape)**
   - Result: data inconsistency; must not be interpreted by operators as a separate enforced gate. Repair links (FN-5696 backfill) so enforcement matches displayed intent.

## Enforced vs. Informational Surfaces

| Surface | Category | Contract meaning |
|---|---|---|
| `MissionFeature.acceptanceCriteria` | Informational authoring source | Canonical authored feature criteria text; enforcement happens through derived/linked assertions |
| Store-managed per-feature `MissionContractAssertion` | Enforced | Primary validator gate for the feature |
| Additive milestone `MissionContractAssertion` (linked to feature) | Enforced | Additional validator gate for that linked feature |
| Additive milestone `MissionContractAssertion` (unlinked) | Informational until linked | Contract candidate, not yet a feature gate |
| `milestone.acceptanceCriteria` | Informational | Milestone summary/pass-bar text for humans; not directly validator-executed |
| MissionManager `milestone-feature-acceptance-rollup` UI (`data-testid="milestone-feature-acceptance-rollup"`) | Informational display | Display-only rendering of feature acceptance text, not a separate enforcement mechanism |

## Zero-Assertion Behavior and FN-5696 Failure Shape

### Zero-assertions runtime behavior (must align with FN-5715)

When a feature reaches completion trigger points and has **zero linked assertions**, mission execution must take an explicit auto-pass path (not a silent stall):

- mark feature as passed/done through the no-assertions path,
- emit explicit observability/audit evidence for the auto-pass reason,
- continue normal slice/mission advancement checks.

### FN-5696 legacy shape clarification

A feature can show acceptance text while links are missing (legacy pre-repair data). This must be treated as a **linkage/data integrity problem**, not as proof that milestone text alone is enforced. The contract prevents ambiguity by separating:

- authored/informational text surfaces, from
- linked assertion enforcement surfaces.

Operators should use the FN-5696 repair workflow to restore the expected store-managed linkage.

## Slice Status and Mission Autopilot Advance Derivation

Autopilot may advance only when each active-slice feature is resolved under this contract:

- Feature with linked assertions: all linked assertions must pass.
- Feature with zero linked assertions: explicit auto-pass path completes it.
- Feature with failed/blocked validation: slice remains incomplete.

Then:

1. All features resolved complete → slice flips to `complete`.
2. Completed active slice with pending next slice → next slice activates.
3. All milestone slices complete → milestone complete.
4. All mission milestones complete → mission complete.

This keeps completion logic deterministic and consistent with FN-5715 trigger/recovery behavior.

## UI Reconciliation Requirements (for follow-on engineering task)

Target surface: `packages/dashboard/app/components/MissionManager.tsx`

1. **Disambiguate labels**
   - Use distinct wording for:
     - feature-authored acceptance text, and
     - milestone contract assertions.
   - Do not reuse "Completion criteria" to refer to both categories.
   - Required wording baseline (or semantically equivalent copy):
     - Feature rollup heading: `Feature acceptance criteria (informational source)`
     - Assertion list heading: `Contract assertions (validator-enforced when linked)`

2. **Per-row enforcement indicator**
   - Every displayed row in the assertions/criteria area must show whether it is:
     - `Enforced gate` (validator-blocking when linked), or
     - `Informational` (display-only).

3. **Empty-state contract-correct copy**
   - Replace the current implication that completion criteria are absent when assertion rows are empty.
   - Empty-state text must acknowledge when feature acceptance text exists but no assertion rows are defined/linked.
   - Required behavior:
     - If feature acceptance text exists but no assertion rows are present, show copy equivalent to: `No contract assertions are linked yet. Feature acceptance criteria are present below and remain informational until assertions are linked.`
     - If neither feature acceptance text nor assertions exist, show copy equivalent to: `No feature acceptance criteria or contract assertions defined yet.`

4. **No button/mobile scope expansion**
   - No button touch-target/mobile-reflow requirements (standing directive).

## Engineering Acceptance Criteria (follow-on implementation)

1. **Data/model contract**
   - Preserve the canonical relationship: feature-authored criteria -> store-managed assertion -> linked assertion enforcement.
   - If any model/UI metadata is added for enforced-vs-informational badges, it must be backward compatible with existing mission rows.

2. **Validator/loop behavior**
   - Maintain FN-5715 invariants:
     - done mission-linked tasks with linked assertions trigger validation,
     - completion-trigger starts loop if needed,
     - startup recovery replays done-implementing features with unpassed assertions,
     - zero-linked-assertions path remains explicit auto-pass.

3. **UI behavior**
   - Implement the Step-2 label reconciliation and per-row indicator requirements.
   - Ensure no shared ambiguous terminology remains between feature acceptance text and assertion rows.

4. **Regression coverage**
   - Add at least one regression test pinning the Goals-mission shape:
     - feature has `acceptanceCriteria`,
     - parent milestone has zero `MissionContractAssertion` rows / no links,
     - autopilot behavior is deterministic and observable (explicit auto-pass path, no silent stall).

5. **Operational observability**
   - Ensure mission/audit surfaces make no-assertions auto-pass and subsequent advance decisions queryable in logs/events.

## Success Metric

For 30 days after the follow-on implementation ships:

- **Primary metric:** zero autopilot stalls of the FN-5715 class (done mission task + unresolved validation trigger gap) in production mission runs.
- **Evidence source:** mission audit/event stream (`feature_completed`, `slice_completed`, `mission_completed`) plus `mission_validator_runs` records showing:
  - explicit no-assertions auto-pass evidence (summary/reason path such as `No assertions linked` when no validator run is started), and
  - downstream advancement evidence without stalled active slices.

## Follow-on Task Requirement

Implementation must land in a separate engineering task that references this document and FN-5715 as the enforcement baseline.