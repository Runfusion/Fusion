---
name: frontend-worker
description: Frontend worker for dashboard UI components, API client functions, and CSS
---

# Frontend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features involving:
- Dashboard UI components (React)
- CSS styling for new UI elements
- API client functions in api.ts
- Frontend type definitions in mission-types.ts
- Component tests

## Required Skills

- `agent-browser` — For verifying UI renders correctly and interactions work

## Work Procedure

1. **Read shared state first.** Read `AGENTS.md`, `.factory/library/architecture.md`, and `.factory/library/user-testing.md` for context.

2. **Understand the feature.** Read the feature description and its `fulfills` assertion IDs from the validation contract. Understand exactly what UI behaviors must be verified.

3. **Update frontend types.** If new types are needed in `packages/dashboard/app/components/mission-types.ts`, add them following existing patterns. Import from the API response shapes.

4. **Add API client functions.** In `packages/dashboard/app/api.ts`, add functions for any new API endpoints needed by the UI. Follow existing function patterns (return types, error handling).

5. **Write component tests FIRST (TDD).**
   - Test rendering of new components
   - Test user interactions (click handlers, form submissions)
   - Test empty states and error states
   - Follow patterns in `MissionManager.test.tsx`

6. **Implement UI components.**
   - Add new sections to MissionManager.tsx following existing patterns
   - Use CSS custom properties for status colors (see existing patterns in styles.css)
   - Implement inline forms for CRUD (not separate modals)
   - Add SSE subscription for auto-refresh of loop state and assertions
   - Ensure mobile responsiveness (375px viewport)

7. **Verify with agent-browser.** Use the agent-browser skill to:
   - Navigate to the mission manager
   - Verify assertions panel renders
   - Verify loop state indicators display correctly
   - Verify validation trigger button works
   - Take screenshots of each state

8. **Run all tests.**
   ```
   pnpm --filter @fusion/dashboard test
   pnpm build
   ```

9. **Commit.** One commit per logical step.

## Example Handoff

```json
{
  "salientSummary": "Added assertions panel to milestone detail view with CRUD operations, feature linking, and status badges. Added loop state visual indicators to feature cards with distinct colors per state.",
  "whatWasImplemented": "AssertionsPanel section in MissionManager.tsx with create/edit/delete forms, feature link picker, reorder drag-and-drop. Loop state badges on FeatureRow components with CSS animations. API client functions: createAssertion, updateAssertion, deleteAssertion, linkFeatureToAssertion, unlinkFeatureFromAssertion, getFeatureLoopSnapshot.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "pnpm --filter @fusion/dashboard test", "exitCode": 0, "observation": "All tests passed including 8 new component tests"},
      {"command": "pnpm build", "exitCode": 0, "observation": "Clean build"}
    ],
    "interactiveChecks": [
      {"action": "Navigated to mission manager, opened milestone detail, created assertion", "observed": "Assertion appeared in list with status 'pending' badge"},
      {"action": "Clicked 'Validate' button on implementing feature", "observed": "Button showed loading spinner, then feature card updated to 'validating' state with yellow indicator"}
    ]
  },
  "tests": {
    "added": [
      {"file": "packages/dashboard/app/components/__tests__/AssertionsPanel.test.tsx", "cases": [
        {"name": "renders assertions list", "verifies": "VAL-UI-001"},
        {"name": "create assertion form submits", "verifies": "VAL-UI-002"}
      ]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- API endpoints the UI needs don't exist yet (backend feature not complete)
- Types needed from @fusion/core aren't exported yet
- Existing UI patterns are insufficient for the required behavior
- Cannot complete within mission boundaries
