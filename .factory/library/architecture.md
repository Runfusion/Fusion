# Architecture

How the mission execution loop validation system works.

## What belongs here

High-level system architecture: components, relationships, data flows, invariants.
NOT implementation details — those go in AGENTS.md or code comments.

---

## Overview

The mission validation system extends Fusion's existing mission hierarchy with a Factory-style implementation → validation → fix cycle. After a task completes, an AI agent validates the implementation against contract assertions. If validation fails, a fix feature is generated and the cycle repeats.

## Data Hierarchy (Existing + New)

```
Mission
  └── Milestone
        ├── ContractAssertion[] (what "done" means — many per milestone)
        └── Slice
              └── MissionFeature
                    ├── loopState (idle → implementing → validating → passed/needs_fix/blocked)
                    ├── implementationAttemptCount
                    ├── validatorAttemptCount
                    ├── ValidatorRun[] (each validation attempt)
                    │     └── ValidatorFailure[] (what went wrong)
                    ├── FixFeatureLineage (if generated as fix)
                    └── Task (linked for execution)

ContractAssertion ←→ MissionFeature (many-to-many via link table)
```

## Component Architecture

```
┌─────────────────────────────────────────────┐
│                  CLI Layer                    │
│  dashboard.ts / serve.ts                     │
│  (instantiates MissionExecutionLoop)         │
└───────────────┬─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│              Engine Layer                     │
│  MissionExecutionLoop ←── Scheduler          │
│       │                         │            │
│       │ (processTaskOutcome)    │ (task:moved│
│       ▼                         ▼   → done) │
│  createKbAgent (validation)    MissionAutopilot│
│  promptWithFallback                        │
└───────────────┬─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│               Core Layer                     │
│  MissionStore (new methods):                │
│    startValidatorRun                        │
│    completeValidatorRun                     │
│    recordValidatorFailures                  │
│    createGeneratedFixFeature                │
│    getFeatureLoopSnapshot                   │
│  SQLite (new tables):                       │
│    mission_validator_runs                   │
│    mission_validator_failures               │
│    mission_fix_feature_lineage              │
│  + new columns on mission_features          │
└─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│            Dashboard Layer                   │
│  mission-routes.ts (new endpoints):         │
│    /assertions CRUD                         │
│    /features/:id/validate                   │
│    /features/:id/validation-loop            │
│    /validation-runs                         │
│  MissionManager.tsx (new UI):               │
│    Assertions panel                         │
│    Loop state indicators                    │
│    Validation trigger                       │
│    Run history                              │
└─────────────────────────────────────────────┘
```

## Validation Flow

1. Feature triaged → task created → task executes → task reaches "done"
2. Scheduler detects mission-linked task completion → calls `processTaskOutcome(taskId)`
3. MissionExecutionLoop transitions feature: implementing → validating
4. Fresh AI agent session created with validation system prompt
5. Agent evaluates feature against linked contract assertions
6. Agent returns structured JSON: `{ status: pass|fail|blocked, assertions: [...] }`
7. Based on result:
   - **pass**: Feature marked 'passed', autopilot can advance slice
   - **fail**: Fix feature generated with failure context, retry budget decremented, loop back to implementing
   - **blocked**: Feature marked 'blocked' (external blocker), no fix generated
   - **error**: Transient error, feature stays in 'validating' for retry
8. If retry budget exhausted: feature permanently 'blocked'

## Key Invariants

- Loop state transitions follow a strict state machine (idle → implementing → validating → terminal)
- Each validation pass uses a FRESH agent session (no context accumulation)
- Retry budget is bounded (default 3 attempts)
- All write operations bump `lastModified` for change detection
- Cascade deletion flows through the entire chain
- Autopilot does NOT advance past features in validating/needs_fix states
- Fix features are linked via lineage table for traceability

## SSE Events (New)

| Event | Payload | When |
|-------|---------|------|
| `validator-run:started` | MissionValidatorRun | New run created |
| `validator-run:completed` | MissionValidatorRun | Run finished |
| `validator-run:failures-recorded` | { runId, failures } | Failures logged |
| `fix-feature:created` | { originalFeatureId, fixFeatureId, runId } | Fix generated |
| `assertion:created` | MissionContractAssertion | New assertion |
| `assertion:updated` | MissionContractAssertion | Assertion modified |
| `assertion:deleted` | string | Assertion removed |
| `assertion:linked` | { featureId, assertionId } | Feature linked |
| `assertion:unlinked` | { featureId, assertionId } | Feature unlinked |
| `milestone:validation:updated` | { milestoneId, state, rollup } | Validation state changed |
