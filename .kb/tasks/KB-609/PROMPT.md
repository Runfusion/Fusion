# Task: KB-609 - Add Workflow Steps Support to Scheduled Automations

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This involves modifying core data types, database schema, API endpoints, and execution logic to bridge two existing systems (workflow steps and scheduled automations). Changes must maintain backward compatibility and not break existing automations.

**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Enable workflow steps (quality gates like Documentation Review, Security Audit, QA Check) to be used as steps within scheduled automations. Currently, scheduled automations only support `command` and `ai-prompt` step types. Users should be able to add existing workflow step definitions as automation steps, allowing them to schedule recurring quality checks and audits.

This creates a bridge between:
- **Workflow Steps**: Reusable quality gate definitions (WS-001, WS-002, etc.) that run after task implementation
- **Scheduled Automations**: Time-based task execution with sequential step support

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/core/src/types.ts` — WorkflowStep type definition and WORKFLOW_STEP_TEMPLATES
- `/Users/eclipxe/Projects/kb/packages/core/src/automation.ts` — AutomationStep type, ScheduledTask interface, and step execution types
- `/Users/eclipxe/Projects/kb/packages/core/src/automation-store.ts` — AutomationStore with CRUD operations for scheduled tasks
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — API routes for automations (lines 4678-4824) showing step validation and execution
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Frontend API client for automations

## File Scope

- `/Users/eclipxe/Projects/kb/packages/core/src/automation.ts` — Add new step type and related types
- `/Users/eclipxe/Projects/kb/packages/core/src/automation-store.ts` — Update validation and row conversion
- `/Users/eclipxe/Projects/kb/packages/core/src/db.ts` — Schema migration for automations table
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Add step validation, execution logic, and endpoints
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Add API client methods for workflow step integration

## Steps

### Step 1: Extend Core Types

- [ ] Add `workflow-step` to `AutomationStepType` union in `automation.ts`
- [ ] Add `workflowStepId?: string` field to `AutomationStep` interface (for referencing the workflow step)
- [ ] Update `AutomationStepResult` to include optional `workflowStepId` for traceability
- [ ] Add validation helper to check if a workflow step ID exists in the config

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/core/src/automation.ts` (modified)

### Step 2: Database Schema Update

- [ ] Add migration to automations table schema in `db.ts` (no schema changes needed — steps stored as JSON)
- [ ] Verify existing `steps` JSON column can hold the new step type

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/core/src/db.ts` (verify/updated)

### Step 3: Automation Store Updates

- [ ] Update `rowToSchedule` to handle workflow-step type in steps array
- [ ] Add validation in `createSchedule` and `updateSchedule` to verify workflow step IDs exist
- [ ] Import `TaskStore` dependency to validate workflow step IDs against config

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/core/src/automation-store.ts` (modified)

### Step 4: API Routes — Validation and Execution

- [ ] Update `validateAutomationSteps` in `routes.ts` to accept `workflow-step` type
- [ ] Add validation that `workflowStepId` references an existing workflow step (use store.listWorkflowSteps())
- [ ] Add execution logic in `executeScheduleSteps` to handle workflow-step type:
  - Load the workflow step definition from config
  - Execute as an AI prompt step using the workflow step's prompt
  - Include workflow step name and ID in the result output
- [ ] Ensure manual run endpoint (`POST /automations/:id/run`) properly executes workflow steps

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` (modified)

### Step 5: Frontend API Updates

- [ ] Add `fetchWorkflowStep(id)` method to api.ts for loading individual workflow steps
- [ ] Ensure existing automation CRUD methods handle the new step type properly

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Create a test automation with workflow-step type and verify it saves correctly
- [ ] Verify manual execution of workflow step automation runs without errors
- [ ] Ensure existing automations with command/ai-prompt steps continue to work
- [ ] Build passes: `pnpm build`

### Step 7: Documentation & Delivery

- [ ] Update AGENTS.md workflow steps section to mention scheduled automation support
- [ ] Out-of-scope: UI changes for selecting workflow steps in automation editor (create as follow-up task)

**Artifacts:**
- `/Users/eclipxe/Projects/kb/AGENTS.md` (updated)

## Implementation Details

### New Automation Step Type

```typescript
// In automation.ts
export type AutomationStepType = "command" | "ai-prompt" | "workflow-step";

export interface AutomationStep {
  id: string;
  type: AutomationStepType;
  name: string;
  command?: string;
  prompt?: string;
  workflowStepId?: string; // References WorkflowStep.id (e.g., "WS-001")
  modelProvider?: string;
  modelId?: string;
  timeoutMs?: number;
  continueOnFailure?: boolean;
}
```

### Execution Logic

When executing a `workflow-step` type step:
1. Load the workflow step definition from config using `store.getWorkflowStep(step.workflowStepId)`
2. If found, use the workflow step's `prompt` as an AI prompt execution
3. If not found (deleted workflow step), mark step as failed with appropriate error
4. Include workflow step metadata in the output for traceability

### Validation Rules

- `workflow-step` type requires `workflowStepId` field
- `workflowStepId` must reference an existing workflow step
- The workflow step's `prompt` is used as the AI prompt (required for execution)

## Documentation Requirements

**Must Update:**
- `/Users/eclipxe/Projects/kb/AGENTS.md` — Add note in Workflow Steps section about scheduled automation support

**Check If Affected:**
- `/Users/eclipxe/Projects/kb/README.md` — Update if it mentions automation step types

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Can create scheduled automation with workflow-step type via API
- [ ] Manual execution of workflow-step automation produces expected results
- [ ] Existing automations remain functional (backward compatibility)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-609): complete Step N — description`
- **Bug fixes:** `fix(KB-609): description`
- **Tests:** `test(KB-609): description`

## Do NOT

- Expand task scope to include UI changes (create separate task for dashboard UI)
- Skip tests for the new step type execution
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Break existing automation functionality — backward compatibility is required
