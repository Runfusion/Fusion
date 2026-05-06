# Task Evaluations Scoring Contract

[← Docs index](./README.md)

## Overview

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

## Non-Goals

This contract does not define:

- follow-up task creation policy
- eval settings UX
- eval dashboard/list rendering
- exhaustive cross-source evidence harvesting
