# Naming Decision Record: Research vs Experiment Session (2026-05)

Date: 2026-05-13  
Task: FN-4223

## Context

Fusion currently ships a **research** subsystem that runs a provider-driven search → fetch → synthesize pipeline and stores cited findings. The FN-4136 audit confirms this is not the same product shape as upstream `pi-autoresearch`, which is an autonomous try-measure-keep-revert experiment loop.

The audit identified false-friend naming risks that can cause users to over-assume parity: `research run` (vs upstream experiment), `confidence` (Fusion synthesis-emitted score vs upstream MAD-style statistical confidence), and iteration-like wording (`maxSources`/`maxSynthesisRounds` vs upstream `maxIterations`).

## Options considered

### (a) Split products entirely by renaming current research subsystem

Rename current `research_*` naming to something like `cited-research`/`web-research`, reserving `research` for upstream-style experiments. This would reduce ambiguity but creates broad breaking churn across tools, docs, APIs, and storage naming.

### (b) Keep current names and force upstream-parity work to avoid “research”

Preserve existing `research_*` names exactly and force the new domain to use strictly experiment-only vocabulary without any overlap. This avoids breaking existing users but risks making the parity domain feel secondary or awkwardly detached from the broader product narrative.

### (c) Hybrid: keep current research names, add parallel experiment-session domain, disambiguate copy

Retain `research_*` for cited-search/synthesis runs, land a first-class `experiment_session_*` domain for upstream parity, and explicitly disambiguate names in docs/UI/JSDoc. This avoids breakage while giving both products explicit, durable vocabulary.

## Decision

We choose **Option (c) hybrid**.

Rationale:

1. FN-4218 already defines the parallel domain as `experiment_session` / `ExperimentSession`, which aligns with a two-domain model.
2. Renaming existing `fn_research_*` tools or `research_runs` storage would be a breaking change for the published `@runfusion/fusion` interface and the SQLite migration ladder.
3. The two domains solve different problems and both should remain first-class: cited information synthesis vs autonomous benchmarked experimentation.

## Contracts

| Term | Meaning / scope |
|---|---|
| **Research run** | A cited-search/synthesis run. Backed by `research_runs`, `ResearchRun`, `fn_research_*` tools, `/api/research/*`, `ResearchView`, and `fn research`. |
| **Experiment session** | An upstream-pi-autoresearch-style try-measure-keep-revert session. Backed by `experiment_sessions` / `ExperimentSession` (FN-4218) and future experiment tools/routes/UI. |
| **Confidence (research)** | Synthesis-emitted 0–1 score from the LLM synthesis provider. **Not** a statistical MAD confidence score. If experiment sessions add metric confidence, use a distinct field name (for example `madConfidence` or `metricConfidence`). |
| **Iterations** | Research run bounds are `maxSources` and `maxSynthesisRounds` (fan-out within one run). Upstream-style `maxIterations` belongs to experiment sessions and is a separate concept. |

## Non-goals

This task does **not** rename or deprecate any of the following:

- `ResearchRun`
- `research_runs`
- `fn_research_*`
- `/api/research/*`
- `ResearchView`
- `confidence` field

No behavior changes are included.

## Follow-ups

- FN-4218/FN-4219/FN-4221/FN-4222 remain the execution track for experiment-session capabilities.
- Experiment-session confidence semantics must use a distinct metric-confidence field name (for example `madConfidence`/`metricConfidence`) instead of overloading research `confidence`.

## References

- `docs/research/pi-autoresearch-audit-2026-05.md` (FN-4136)
- `docs/research/pi-autoresearch-analysis.md` (FN-2990 historical spike)
- FN-4218, FN-4219, FN-4221, FN-4222
