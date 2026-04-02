# Task: KB-218 - Add Global Workflow Steps for Post-Implementation Review

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This is a multi-component feature touching data models, API routes, dashboard UI, and engine execution. It involves new domain concepts (workflow steps), AI-powered prompt refinement, and integration into the task lifecycle. The complexity warrants careful planning but follows existing patterns in the codebase.

**Score:** 5/8 — Blast radius: 2 (multi-package), Pattern novelty: 1 (follows existing patterns), Security: 1 (AI prompt generation), Reversibility: 1 (additive, can disable workflow steps)

## Mission

Add a way to define "workflow steps" that can be defined once globally and optionally enabled for tasks. These are steps like "Documentation" or "QA Review" that run a new agent with a custom prompt after the task implementation is done, but before it is moved to in-review.

**Key capabilities:**
1. **Global workflow step definitions** — Define reusable workflow steps with name, description, and detailed prompt
2. **AI-assisted prompt refinement** — Users enter a rough description, AI refines it into a detailed agent prompt
3. **Task-level selection** — Checkbox on new task dialog to select which workflow steps to run
4. **Post-implementation execution** — After the main task executor finishes, workflow step agents run sequentially
5. **Review gate** — Task only moves to in-review after all enabled workflow steps complete successfully

## Dependencies

- **None**

## Context to Read First

### Data and Store Patterns
- `packages/core/src/types.ts` — Task types, Settings interface, task creation flow
- `packages/core/src/store.ts` — TaskStore class, settings storage pattern (config.json), CRUD methods
- `packages/core/src/index.ts` — Package exports

### API Route Patterns
- `packages/dashboard/src/routes.ts` — Express route patterns, error handling, existing endpoints for tasks and settings
- `packages/dashboard/src/routes.test.ts` — Test patterns for API endpoints

### UI Component Patterns
- `packages/dashboard/app/components/NewTaskModal.tsx` — Modal structure, form patterns, checkbox handling
- `packages/dashboard/app/components/SettingsModal.tsx` — Settings management UI pattern
- `packages/dashboard/app/api.ts` — Frontend API client patterns

### Engine Execution Patterns
- `packages/engine/src/executor.ts` — TaskExecutor class, agent session lifecycle, onComplete callbacks
- `packages/engine/src/reviewer.ts` — Review agent pattern (spawn separate agent with custom prompt)
- `packages/engine/src/scheduler.ts` — Task lifecycle management (if exists)

### AI Integration Patterns
- `packages/dashboard/src/planning.ts` — AI streaming patterns for interactive prompts
- `packages/engine/src/pi.ts` — Agent creation patterns

## File Scope

### New Types and Interfaces
- `packages/core/src/types.ts` (modified) — Add WorkflowStep, WorkflowStepInput types

### Store Layer
- `packages/core/src/store.ts` (modified) — Add workflow step CRUD methods
- `packages/core/src/index.ts` (modified) — Export new types
- `packages/core/src/store.test.ts` (modified) — Add tests for workflow step methods

### API Layer
- `packages/dashboard/src/routes.ts` (modified) — Add workflow step endpoints
- `packages/dashboard/src/routes.test.ts` (modified) — Add tests for workflow step endpoints

### UI Components
- `packages/dashboard/app/components/WorkflowStepManager.tsx` (new) — Global workflow step management UI
- `packages/dashboard/app/components/WorkflowStepManager.test.tsx` (new) — Tests for manager
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified) — Add workflow step selection checkboxes
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified) — Update tests
- `packages/dashboard/app/api.ts` (modified) — Add workflow step API functions

### Engine Layer
- `packages/engine/src/executor.ts` (modified) — Run workflow step agents after main execution
- `packages/engine/src/index.ts` (modified) — Export workflow step types if needed

### Documentation
- `AGENTS.md` (modified) — Document workflow step feature for AI agents

## Steps

### Step 1: Core Data Model and Store Methods

Add foundational types and TaskStore methods for workflow steps.

- [ ] Add `WorkflowStep` interface to `packages/core/src/types.ts`:
  ```typescript
  export interface WorkflowStep {
    id: string;                    // Unique identifier (e.g., "ws-001")
    name: string;                  // Display name (e.g., "Documentation Review")
    description: string;             // Short description for UI
    prompt: string;                // Full agent prompt to execute
    enabled: boolean;              // Whether this step is available for selection
    createdAt: string;
    updatedAt: string;
  }
  ```
- [ ] Add `WorkflowStepInput` interface for creation:
  ```typescript
  export interface WorkflowStepInput {
    name: string;
    description: string;
    prompt?: string;               // Optional - can be AI-generated
    enabled?: boolean;
  }
  ```
- [ ] Add `workflowSteps` array to `Settings` type (or store separately in config.json)
- [ ] Add `enabledWorkflowSteps?: string[]` field to `Task` type (stores IDs of selected steps)
- [ ] Add to `TaskCreateInput`: `enabledWorkflowSteps?: string[]`

- [ ] Add TaskStore methods to `packages/core/src/store.ts`:
  - `createWorkflowStep(input: WorkflowStepInput): Promise<WorkflowStep>` — Generate ID, set timestamps, save to config
  - `listWorkflowSteps(): Promise<WorkflowStep[]>` — Return all workflow steps from config
  - `getWorkflowStep(id: string): Promise<WorkflowStep | undefined>` — Find by ID
  - `updateWorkflowStep(id: string, updates: Partial<WorkflowStepInput>): Promise<WorkflowStep>` — Update and save
  - `deleteWorkflowStep(id: string): Promise<void>` — Remove from config, also remove from any tasks that reference it
  
- [ ] Implement workflow step ID generation (similar to task ID pattern: "WS-001")
- [ ] Store workflow steps in `config.json` alongside settings (or separate file if cleaner)

- [ ] Write tests in `packages/core/src/store.test.ts`:
  - Create workflow step with all fields
  - Create with minimal fields (AI will generate prompt)
  - List workflow steps
  - Get single workflow step
  - Update workflow step
  - Delete workflow step
  - Delete removes references from tasks

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/store.ts` (modified)
- `packages/core/src/index.ts` (modified)
- `packages/core/src/store.test.ts` (modified)

### Step 2: API Routes for Workflow Step Management and AI Refinement

Add REST endpoints for workflow step CRUD and AI prompt refinement.

- [ ] Add GET `/api/workflow-steps` endpoint in `packages/dashboard/src/routes.ts`:
  - Returns array of all workflow steps
  - No authentication required (read-only)

- [ ] Add POST `/api/workflow-steps` endpoint:
  - Body: `{ name: string, description: string, prompt?: string, enabled?: boolean }`
  - If prompt not provided, set to empty string (will be generated later)
  - Calls `store.createWorkflowStep`
  - Returns created workflow step
  - Error handling: 400 invalid input, 409 if name conflicts

- [ ] Add POST `/api/workflow-steps/:id/refine` endpoint (AI prompt refinement):
  - Takes workflow step ID
  - Uses existing AI agent pattern from `packages/dashboard/src/planning.ts`
  - Sends description to AI with system prompt: "Convert this rough workflow step description into a detailed agent prompt. The prompt should instruct an AI agent what to do when reviewing a completed task."
  - Streams response back (SSE) or returns complete prompt
  - Updates the workflow step with the refined prompt
  - Returns: `{ prompt: string, workflowStep: WorkflowStep }`

- [ ] Add PATCH `/api/workflow-steps/:id` endpoint:
  - Body: Partial updates (name, description, prompt, enabled)
  - Calls `store.updateWorkflowStep`
  - Returns updated workflow step

- [ ] Add DELETE `/api/workflow-steps/:id` endpoint:
  - Calls `store.deleteWorkflowStep`
  - Returns 204 on success
  - Error: 404 if not found

- [ ] Write tests in `packages/dashboard/src/routes.test.ts`:
  - GET /workflow-steps returns empty array initially
  - POST creates workflow step
  - POST with missing name returns 400
  - POST /:id/refine generates prompt with AI
  - PATCH updates workflow step
  - DELETE removes workflow step
  - DELETE returns 404 for non-existent ID

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 3: Dashboard UI for Managing Workflow Steps

Create global workflow step management interface.

- [ ] Add API functions to `packages/dashboard/app/api.ts`:
  - `fetchWorkflowSteps(): Promise<WorkflowStep[]>`
  - `createWorkflowStep(input: WorkflowStepInput): Promise<WorkflowStep>`
  - `updateWorkflowStep(id: string, updates: Partial<WorkflowStepInput>): Promise<WorkflowStep>`
  - `deleteWorkflowStep(id: string): Promise<void>`
  - `refineWorkflowStepPrompt(id: string): Promise<{ prompt: string }>`

- [ ] Create `WorkflowStepManager.tsx` component:
  - Modal dialog (similar structure to SettingsModal)
  - Header: "Workflow Steps" with close button
  - List view of existing workflow steps with:
    - Name (bold)
    - Description (gray, truncated)
    - Enabled badge (green if enabled, gray if disabled)
    - Edit button, Delete button
  - "Add Workflow Step" button at bottom
  - Empty state: "No workflow steps defined. Create one to get started."

- [ ] Create workflow step form within the manager (inline or separate section):
  - Name input (required)
  - Description textarea (required, placeholder: "Brief description of what this step does")
  - Prompt textarea (optional, placeholder: "Leave empty to use AI refinement")
  - Enabled checkbox
  - "Refine with AI" button (disabled if description empty, generates detailed prompt)
  - Save and Cancel buttons

- [ ] Add AI refinement UI:
  - When "Refine with AI" clicked, show loading state
  - Call `refineWorkflowStepPrompt` endpoint
  - Populate prompt textarea with AI-generated content
  - Allow user to edit before saving

- [ ] Add delete confirmation dialog:
  - "Delete workflow step? This will also remove it from any tasks that use it."
  - Cancel / Delete buttons

- [ ] Add entry point in Header.tsx:
  - Add "Workflow Steps" button in header (gear icon or similar)
  - Or add to settings modal as a tab

- [ ] Write tests in `WorkflowStepManager.test.tsx`:
  - Renders list of workflow steps
  - Opens create form when "Add" clicked
  - Submits new workflow step
  - Edits existing workflow step
  - Deletes workflow step with confirmation
  - AI refinement button calls API and updates prompt
  - Handles API errors gracefully

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/components/WorkflowStepManager.tsx` (new)
- `packages/dashboard/app/components/WorkflowStepManager.test.tsx` (new)
- `packages/dashboard/app/components/Header.tsx` (modified — add entry point)

### Step 4: New Task Dialog Integration

Add workflow step selection to the task creation flow.

- [ ] Modify `packages/dashboard/app/components/NewTaskModal.tsx`:
  - Add state: `enabledWorkflowSteps: string[]`
  - Fetch available workflow steps when modal opens (use existing pattern from model loading)
  - Add new section "Workflow Steps" in modal body (after Model Configuration, before Attachments)
  - Display checkboxes for each enabled workflow step:
    - Label: workflow step name
    - Description shown below as small gray text
    - Checkbox is checked/unchecked based on enabledWorkflowSteps state
  - If no workflow steps defined, show "No workflow steps available. Define them in Workflow Step Manager."

- [ ] Update form submission:
  - Include `enabledWorkflowSteps` in `createTask` call
  - Pass to `onCreateTask` callback

- [ ] Update `packages/dashboard/app/api.ts` `createTask` function:
  - Accept `enabledWorkflowSteps` parameter
  - Include in POST body

- [ ] Write/update tests:
  - Update `NewTaskModal.test.tsx`:
    - Test workflow step section renders when steps available
    - Test checkboxes toggle selection
    - Test selected steps are passed on create
    - Test empty state shown when no steps defined
    - Test workflow steps cleared on modal close

**Artifacts:**
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified)
- `packages/dashboard/app/api.ts` (modified)

### Step 5: Engine Integration - Running Workflow Step Agents

Execute workflow step agents after main task implementation completes.

- [ ] Modify `packages/engine/src/executor.ts`:
  - After task execution completes successfully (task moves to in-review), check if task has `enabledWorkflowSteps`
  - If yes, run each workflow step sequentially before marking task complete

- [ ] Create workflow step execution method:
  ```typescript
  private async executeWorkflowStep(
    task: Task,
    workflowStep: WorkflowStep,
    worktreePath: string
  ): Promise<{ success: boolean; output?: string; error?: string }>
  ```
  - Load the workflow step's prompt
  - Create agent session with the prompt as system prompt
  - Provide task context: task ID, description, PROMPT.md content, files changed
  - Run agent in the same worktree
  - Agent should review/validate the work and either approve or request changes
  - Return success/failure status

- [ ] Define workflow step agent system prompt template:
  ```
  You are a workflow step agent executing: {workflowStepName}
  
  Task Context:
  - Task ID: {taskId}
  - Task Description: {taskDescription}
  - Worktree: {worktreePath}
  
  Your Instructions:
  {workflowStepPrompt}
  
  You have access to the file system to review changes.
  When complete, call task_done() to signal success.
  If issues are found that need fixing, use task_log() to document them.
  ```

- [ ] Integrate into task completion flow:
  - After main executor finishes and calls `task_done()`, check for workflow steps
  - If workflow steps exist, spawn workflow step agents sequentially
  - Log each workflow step execution to task log
  - Only move task to in-review after all workflow steps pass
  - If any workflow step fails, mark task as failed with error message

- [ ] Handle workflow step failures:
  - If workflow step fails, task stays in in-progress
  - Log failure to task log with workflow step name
  - Allow retry by user (existing retry mechanism)

- [ ] Add progress tracking:
  - Log to task: "Starting workflow step: {name}"
  - Log completion: "Workflow step completed: {name}"
  - Log failures: "Workflow step failed: {name} — {error}"

- [ ] Write tests:
  - Test workflow step executes after main task
  - Test multiple workflow steps run sequentially
  - Test task only moves to in-review after all steps pass
  - Test workflow step failure prevents task completion
  - Test workflow step logs are captured

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)
- `packages/engine/src/executor.test.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Build all packages: `pnpm build`
- [ ] All tests must pass
- [ ] Manual verification:
  - Create a workflow step in the manager
  - Use AI refinement to generate prompt
  - Create a task with the workflow step enabled
  - Execute task and verify workflow step runs after implementation
  - Verify task only moves to in-review after workflow step passes

**Artifacts:**
- All test files with passing tests
- No TypeScript errors
- Successful build

### Step 7: Documentation & Delivery

- [ ] Update `AGENTS.md`:
  - Document workflow step concept for AI agents
  - Explain how workflow step agents are spawned
  - Document expected behavior (review completed work, validate against criteria)
  
- [ ] Update README.md:
  - Add "Workflow Steps" feature section
  - Explain how to define and use workflow steps
  - Document AI refinement feature

- [ ] Create changeset file:
  ```bash
  cat > .changeset/add-workflow-steps.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add workflow steps feature for post-implementation review. Define reusable workflow steps globally with AI-assisted prompt refinement, enable them per-task, and execute them as separate agents after task implementation completes. Examples: Documentation Review, QA Check, Security Audit.
  EOF
  ```

- [ ] Create follow-up tasks via `task_create` if needed:
  - Workflow step templates (pre-defined common steps)
  - Parallel workflow step execution (currently sequential)
  - Workflow step results viewer in dashboard
  - Skip workflow step option for urgent tasks

**Artifacts:**
- `AGENTS.md` (modified)
- `README.md` (modified)
- `.changeset/add-workflow-steps.md` (new)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Document workflow step concept for AI agents
- `README.md` — User-facing documentation for workflow steps feature

**Check If Affected:**
- `packages/core/README.md` — Update if exists
- `packages/dashboard/README.md` — Update if exists
- `packages/engine/README.md` — Update if exists

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Typecheck clean (`pnpm typecheck`)
- [ ] Build successful (`pnpm build`)
- [ ] Workflow steps can be created, edited, deleted via dashboard
- [ ] AI refinement generates detailed prompts from descriptions
- [ ] New task dialog shows workflow step checkboxes
- [ ] Selected workflow steps run after task implementation
- [ ] Task only moves to in-review after workflow steps complete
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-218): complete Step N — description`
- **Bug fixes:** `fix(KB-218): description`
- **Tests:** `test(KB-218): description`

## Do NOT

- Skip tests for any new functionality
- Modify files outside the File Scope without explicit justification
- Break existing task execution flow (workflow steps are additive)
- Store workflow step results separately from task log (use task_log)
- Allow workflow steps to run in parallel (start with sequential for simplicity)
- Skip documentation updates
- Create changeset for internal-only changes

## AI Refinement System Prompt Template

When implementing the AI refinement endpoint, use this system prompt:

```
You are an expert at creating detailed agent prompts for workflow steps.

A workflow step is a quality gate that runs after a task is implemented but before it's marked complete.

Given a rough description, create a detailed prompt that an AI agent can follow to execute this workflow step.

The prompt should:
1. Define the purpose clearly
2. Specify what files/context to examine
3. List specific criteria to check
4. Describe what "success" looks like
5. Include guidance on handling common edge cases

Output ONLY the prompt text (no markdown, no explanations).
```

## Example Workflow Steps

These examples should work after implementation:

**Documentation Review:**
- Description: "Verify all public APIs have documentation"
- AI Refined Prompt: "Review the task changes and verify that all new public functions, classes, and modules have JSDoc comments or README documentation. Check that complex logic has inline comments. If documentation is missing, list the specific files and functions that need it."

**QA Check:**
- Description: "Run tests and verify they pass"
- AI Refined Prompt: "Execute the test suite in the task worktree. Verify all tests pass. If tests fail, identify whether the failures are related to the task changes or pre-existing issues. Report test results and any failures found."

**Security Audit:**
- Description: "Check for common security issues"
- AI Refined Prompt: "Review the task changes for common security issues: SQL injection, XSS vulnerabilities, hardcoded secrets, unsafe eval usage, path traversal risks. If issues are found, describe them with specific file paths and line numbers."
