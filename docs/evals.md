# Task Evaluations Scoring Contract

[← Docs index](./README.md)

## Overview

> **Feature flag:** Evals surfaces are gated by `experimentalFeatures.evalsView`. When disabled, the dashboard Evals view, Settings → Scheduled Evals section, and scheduled-eval cron execution are all dormant.

Fusion task evaluations use one canonical 0–100 integer scoring system for three categories: `agentPerformance`, `taskOutcomeQuality`, and `processCompliance`.

Authoritative score math lives in `packages/core/src/eval-scoring.ts`. AI output is advisory input only.

## Category Definitions

- **agentPerformance**: execution effectiveness, recovery from issues, and quality of agent decision-making.
- **taskOutcomeQuality**: correctness, completeness, verification quality, and shipped-result quality.
- **processCompliance**: adherence to required workflow steps (tests, docs, review/merge expectations, commit/task conventions).

## Score Bands

- `0..39` → `failing`
- `40..59` → `weak`
- `60..74` → `acceptable`
- `75..89` → `strong`
- `90..100` → `excellent`

## Overall Formula

Category weights:

- `agentPerformance`: `0.30`
- `taskOutcomeQuality`: `0.45`
- `processCompliance`: `0.25`

Overall score formula:

`overallScore = round(sum(category.finalScore * category.weight))`

All scores are clamped/validated to integer `0..100`.

## Deterministic vs AI Blend

Per-category final score:

`finalScore = round(clamp((deterministicScore * 0.7) + (aiScore * 0.3), 0, 100))`

Authority flow:

1. deterministic signal collection produces per-category deterministic inputs.
2. AI evaluator emits `aiScore`, rationale, and evidence for each category.
3. Core scoring helpers compute authoritative `finalScore` and `overallScore`.
4. Eval store persists both the structured breakdown and computed overall.

## Persisted Score Payload

Each `eval_task_results.categoryScores[]` item stores:

- `category`
- `deterministicScore`
- `aiScore`
- `finalScore` (authoritative)
- `weight`
- `band`
- `rationale`
- `evidence[]`

`overallScore` is authoritative only when derived from these category finals using `computeOverallScore`.

## Evidence Bundle Contract

Hybrid evaluation now consumes a deterministic `TaskEvaluationEvidenceBundle` before AI scoring.

Source groups are fixed and ordered:

1. `taskMetadata`
2. `commits`
3. `workflow`
4. `reviews`
5. `documents`
6. `taskActivity`
7. `agentLogs`
8. `runAudit`

Per-source caps are enforced before persistence:

- `commits`: 20
- `agentLogs`: 25
- `runAudit`: 25
- `taskActivity`: 25
- other groups: 25 max entries

Persisted excerpts are bounded to 500 characters with an explicit truncation marker (`… [truncated]`). Commit subjects are additionally capped at 160 chars.

### Persisted vs Linked Evidence

Eval rows store normalized evidence references and bounded excerpts only. Full raw blobs (full agent logs/tool output, full git output, full run-audit payloads) are not copied into eval rows.

Stored references include task/run identifiers and source-specific drill-down fields (e.g. commit SHA, workflow step ID/name/status, document key/revision, run-audit event ID/domain/mutation, PR/merge metadata, execution timing, retry/recovery counters).

### Prompt Integration

`packages/engine/src/evaluator.ts` injects the normalized bundle under a dedicated `## Evidence` prompt section. The evaluator is instructed to cite evidence IDs/labels from this section instead of inventing unsupported claims.

## Follow-up Suggestion Policy

Evaluator follow-ups are normalized into structured `followUps[]` records on each eval result (no freeform-only suggestions).

Each suggestion includes:
- stable `suggestionId` + `dedupeKey`
- `title`, `description`, `priority`, `severity`
- `rationale` and `evidenceRefs[]`
- policy recommendation (`shouldCreate`, `policyQualified`, `reason`)
- lifecycle state: `suggested` | `suppressed` | `created`
- suppression/debug fields when applicable: `suppressedReason`, `matchedTaskId`, `matchedSuggestionId`
- creation linkage when applicable: `createdTaskId`

### Policy modes

Backend policy modes used by evaluator orchestration:
- `persist_only`: persist normalized suggestions for manual review only
- `auto_create_qualified`: auto-create only policy-qualified suggestions
- `create_all_non_duplicates`: auto-create all non-suppressed, non-duplicate suggestions

Current project settings mapping:
- `taskEvaluationFollowUpPolicy = "off" | "suggest"` → `persist_only`
- `taskEvaluationFollowUpPolicy = "create"` → `auto_create_qualified`

### Dedupe + suppression guardrails

Suggestions are suppressed when they are:
- empty/generic (`empty_or_generic`)
- missing strong signal (`insufficient_signal`)
- duplicates of an already-open board task (`duplicate_open_task`)
- duplicates of a prior eval suggestion for the same parent task (`duplicate_prior_suggestion`)

Suppression reasons and matched IDs are persisted on the suggestion for auditability.

### Task creation provenance

When policy permits creation, evaluator code uses `TaskStore.createTask()` (no ad hoc file writes). Created tasks:
- are created in `triage`
- set `sourceParentTaskId` to the evaluated task
- set `sourceMetadata` with eval provenance (`type=eval_follow_up`, `runId`, `suggestionId`, `policyMode`, `dedupeKey`)
- include actionable context (problem summary, expected outcome, score/severity, rationale, evidence refs)

## Non-Goals

This contract does not define:

- eval settings UX
- eval dashboard/list rendering
