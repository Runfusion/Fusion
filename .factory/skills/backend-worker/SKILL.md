---
name: backend-worker
description: Backend worker for data model, store, engine, and API implementation
---

# Backend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features involving:
- Database schema migrations
- TypeScript type definitions
- MissionStore method implementation
- Engine component wiring (MissionExecutionLoop, Scheduler integration)
- REST API endpoint implementation
- Unit and integration tests for backend code

## Required Skills

None.

## Work Procedure

1. **Read shared state first.** Read `AGENTS.md`, `.factory/library/architecture.md`, and `.factory/library/environment.md` for context and constraints.

2. **Understand the feature.** Read the feature description and its `fulfills` assertion IDs from the validation contract. Understand exactly what behavioral assertions must be satisfied.

3. **Write tests FIRST (TDD).**
   - For data model work: Write migration tests, type compilation tests, store method tests
   - For engine work: Write integration tests for wiring, lifecycle, and error handling
   - For API work: Write route handler tests following patterns in `mission-routes.ts` tests
   - Tests MUST fail before implementation begins (red → green)

4. **Implement to make tests pass.**
   - Follow existing patterns exactly (see AGENTS.md for references)
   - For schema changes: Edit `packages/core/src/db.ts`, bump version, add migration
   - For types: Edit `packages/core/src/mission-types.ts`, export from `index.ts`
   - For store methods: Edit `packages/core/src/mission-store.ts`, follow EventEmitter pattern
   - For engine wiring: Follow MissionAutopilot pattern exactly
   - For API routes: Edit `packages/dashboard/src/mission-routes.ts`, follow existing patterns

5. **Run all tests.** Execute:
   ```
   pnpm --filter @fusion/core test
   pnpm --filter @fusion/engine test
   pnpm --filter @fusion/dashboard test
   ```
   All must pass. Fix any failures.

6. **Run type check.** Execute `pnpm build` and ensure no TypeScript errors.

7. **Manual verification.** If the feature adds API endpoints, verify with curl against a running dashboard. If the feature changes engine wiring, verify startup/shutdown behavior.

8. **Commit.** One commit per logical step with appropriate message prefix (`feat(FN-XXX):`, `test(FN-XXX):`, etc.).

## Example Handoff

```json
{
  "salientSummary": "Implemented mission_validator_runs table schema migration and MissionStore.startValidatorRun/completeValidatorRun methods with full lifecycle tracking, event emission, and cascade deletion support.",
  "whatWasImplemented": "Schema v31 migration adding mission_validator_runs, mission_validator_failures, and mission_fix_feature_lineage tables plus 7 new columns on mission_features. Added startValidatorRun(), completeValidatorRun(), recordValidatorFailures(), createGeneratedFixFeature(), and getFeatureLoopSnapshot() to MissionStore with events and bumpLastModified.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "pnpm --filter @fusion/core test", "exitCode": 0, "observation": "All 45 tests passed including 12 new validator run tests"},
      {"command": "pnpm --filter @fusion/engine test", "exitCode": 0, "observation": "1889 tests passed, no regressions"},
      {"command": "pnpm build", "exitCode": 0, "observation": "Clean build, no type errors"}
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {"file": "packages/core/src/mission-store.test.ts", "cases": [
        {"name": "startValidatorRun creates run with status running", "verifies": "VAL-DM-015"},
        {"name": "completeValidatorRun transitions to passed", "verifies": "VAL-DM-016"}
      ]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Feature depends on a type, method, or table that doesn't exist yet and is in another feature's scope
- Requirements are ambiguous or contradictory with existing code
- Existing bugs in the codebase block this feature
- Cannot complete within mission boundaries (ports, services, off-limits areas)
