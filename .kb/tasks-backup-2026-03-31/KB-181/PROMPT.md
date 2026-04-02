# Task: KB-181 - Add planning mode to the CLI

**Created:** 2026-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This adds a new CLI command integrating with the existing dashboard planning system. It uses established functional APIs from `@kb/dashboard` and follows existing CLI patterns. Integration complexity is moderate but patterns are well-established.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add an interactive planning mode command to the CLI (`kb task plan`) that guides users through an AI-driven conversation to transform vague ideas into well-specified tasks. The planning session asks clarifying questions, gathers requirements, and generates a structured task summary that can be created directly from the terminal. This brings the dashboard's planning mode feature to CLI users for faster task creation without leaving the terminal.

## Dependencies

- **None** — Uses existing @kb/dashboard planning infrastructure

## Context to Read First

- `packages/cli/src/bin.ts` — CLI entry point and command routing
- `packages/cli/src/commands/task.ts` — Existing task commands implementation
- `packages/dashboard/src/planning.ts` — Planning session management and AI integration (use functional API: `createSession`, `submitResponse`)
- `packages/dashboard/app/api.ts` — API client showing planning endpoints for reference
- `packages/core/src/types.ts` — PlanningQuestion, PlanningSummary, PlanningResponse types
- `packages/cli/src/extension.ts` — pi extension tools for reference on interactive patterns

## File Scope

- `packages/cli/src/commands/task.ts` — Add `runTaskPlan()` function and export it
- `packages/cli/src/bin.ts` — Add `task plan` command routing
- `packages/cli/src/__tests__/task-plan.test.ts` — Add tests for planning command (new file)
- `packages/cli/src/extension.ts` — Add `kb_task_plan` tool

## Steps

### Step 1: Planning Command Implementation

Implement the core planning flow in `packages/cli/src/commands/task.ts`:

- [ ] Import functional planning API from `@kb/dashboard/src/planning.ts`:
  - `createSession(ip, initialPlan, store?, rootDir?)` — starts planning session
  - `submitResponse(sessionId, responses)` — submits answer, returns next question or summary
  - Error types: `RateLimitError`, `SessionNotFoundError`, `InvalidSessionStateError`
- [ ] Add `runTaskPlan(initialPlan?: string)` function that:
  - If no initial plan provided, prompts user interactively for their high-level idea using `createInterface`
  - Calls `createSession()` with IP "127.0.0.1" (CLI context), initial plan, and store
  - Displays the first question returned from `createSession`
  - Implements the interactive Q&A loop:
    - For `text` questions: Accept multi-line input until user enters "DONE" on its own line
    - For `single_select`: Display numbered options (1-N), accept number input with validation
    - For `multi_select`: Display numbered options with selection state, accept comma-separated numbers
    - For `confirm`: Display Y/n prompt, default to Yes if user presses Enter
  - Calls `submitResponse()` with the user's answer after each question
  - Continues loop until `submitResponse` returns `{ type: "complete", data: PlanningSummary }`
- [ ] Display thinking/progress indicator: "AI is thinking..." while waiting for responses
- [ ] When complete, display the PlanningSummary in formatted output:
  - Title, Description, Suggested Size, Suggested Dependencies, Key Deliverables
- [ ] Prompt user for confirmation: "Create this task? [Y/n]"
- [ ] If confirmed (or `--yes` flag set), create task using `store.createTask()` with summary data
- [ ] Support `--yes` flag to skip confirmation and create task immediately
- [ ] Handle errors gracefully:
  - `RateLimitError`: Display "Rate limit exceeded. Maximum 5 planning sessions per hour."
  - `SessionNotFoundError`: Display "Session expired. Please start again."
  - Generic errors: Display error message and exit
- [ ] Export `runTaskPlan` from the module

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified) — Add `runTaskPlan()` function

### Step 2: CLI Integration

Wire up the planning command in the CLI entry point:

- [ ] Add `task plan` subcommand routing in `packages/cli/src/bin.ts`
- [ ] Parse optional initial plan from remaining command args: `kb task plan "build auth system"`
- [ ] Parse `--yes` flag for non-interactive task creation
- [ ] Call `runTaskPlan()` with parsed arguments
- [ ] Update HELP text to include new command:
  ```
  kb task plan [description] [opts]    Create task via AI-guided planning
  ```
- [ ] Add import for `runTaskPlan` from commands/task.js

**Artifacts:**
- `packages/cli/src/bin.ts` (modified) — Add command routing and help text

### Step 3: Terminal UI Helpers

Implement terminal interaction utilities within `packages/cli/src/commands/task.ts`:

- [ ] Add helper `promptText(question): Promise<string>` — multi-line input with "DONE" sentinel
- [ ] Add helper `promptSingleSelect(question): Promise<string>` — returns selected option id
- [ ] Add helper `promptMultiSelect(question): Promise<string[]>` — returns array of selected option ids  
- [ ] Add helper `promptConfirm(question): Promise<boolean>` — Y/n prompt
- [ ] Add helper `displaySummary(summary): void` — formatted box output with all fields
- [ ] Use chalk/std-out colors if available, otherwise plain text with ASCII formatting
- [ ] Handle Ctrl+C (SIGINT) gracefully: display "Planning session cancelled." and exit code 0

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified) — Terminal interaction helpers

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `packages/cli/src/__tests__/task-plan.test.ts`:
  - Mock `createSession` and `submitResponse` from `@kb/dashboard/src/planning.js`
  - Mock `TaskStore` methods
  - Test `runTaskPlan` with mock planning session:
    - Test text question flow (multi-line input)
    - Test single_select question flow
    - Test multi_select question flow
    - Test confirm question flow
  - Test summary display and task creation
  - Test `--yes` flag bypasses confirmation prompt
  - Test `RateLimitError` handling with proper message
  - Test session cancellation (Ctrl+C simulation)
  - Test no initial plan provided (interactive prompt mode)
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/cli/src/__tests__/task-plan.test.ts` (new) — Planning command tests

### Step 5: Extension Tool & Documentation

- [ ] Add `kb_task_plan` tool to `packages/cli/src/extension.ts`:
  - Register with name `kb_task_plan`
  - Parameters: `description` (optional string) — initial plan description
  - Description: "Create a task via AI-guided planning mode — interactive conversation to refine your idea into a well-specified task"
  - `promptGuidelines`: ["Use for breaking down vague ideas into actionable tasks", "The AI will ask clarifying questions before creating the task"]
  - Execute: call `runTaskPlan(description)`
- [ ] Create changeset for the new feature:
  ```bash
  cat > .changeset/add-planning-mode-cli.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add `kb task plan` command for interactive AI-guided task planning
  EOF
  ```

**Artifacts:**
- `packages/cli/src/extension.ts` (modified) — Add `kb_task_plan` tool
- `.changeset/add-planning-mode-cli.md` (new)

## Completion Criteria

- [ ] `kb task plan` command works end-to-end in terminal
- [ ] All question types (text, single_select, multi_select, confirm) render correctly
- [ ] Planning session creates a properly specified task with title/description/size
- [ ] All tests passing in `packages/cli/src/__tests__/task-plan.test.ts`
- [ ] Full test suite passes: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Extension tool `kb_task_plan` registered and functional
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-181): complete Step N — description`
- **Bug fixes:** `fix(KB-181): description`
- **Tests:** `test(KB-181): description`

## Do NOT

- Reimplement the planning AI logic — use the existing functional API from `@kb/dashboard/src/planning.ts`
- Import the `PlanningSession` class directly — use `createSession()` and `submitResponse()` functions
- Make HTTP requests to dashboard endpoints — import directly from dashboard package
- Skip confirmation prompt without the `--yes` flag
- Break existing CLI commands
- Modify the dashboard planning implementation
