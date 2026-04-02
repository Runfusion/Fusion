# Task: KB-204 - Add CLI command `kb task steer <id> <message>` to add steering comments to tasks

**Created:** 2026-03-30
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** Adding a straightforward CLI command that uses existing TaskStore API. Similar patterns exist for other task commands. Requires careful validation and stdin handling but no novel patterns or security concerns.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 2

## Mission

Add a CLI command to allow users to add steering comments to tasks from the command line. Steering comments are user-provided guidance that gets injected into the AI execution context, enabling human-in-the-loop workflows. The dashboard already supports this via POST /api/tasks/:id/steer, and CLI users need equivalent functionality for headless/automated workflows.

## Dependencies

- **Task:** KB-182 — Dashboard vs CLI gap analysis (identifies steering comments as a missing CLI feature)
- **TaskStore.addSteeringComment()** — Already implemented in @kb/core (see packages/core/src/store.ts line ~1370)

## Context to Read First

1. **`packages/cli/src/bin.ts`** — CLI command routing and help text (follow existing patterns like `kb task log`)
2. **`packages/cli/src/commands/task.ts`** — Current task command implementations (see `runTaskLog` as reference for message handling)
3. **`packages/core/src/store.ts`** — `addSteeringComment(id, text, author)` method (line ~1370)
4. **`packages/core/src/types.ts`** — `SteeringComment` interface definition
5. **`packages/dashboard/src/routes.ts`** — POST /tasks/:id/steer endpoint for validation rules reference (lines ~930-950)
6. **`packages/cli/src/__tests__/task-plan.test.ts`** — Existing test patterns for CLI commands

## File Scope

- `packages/cli/src/bin.ts` — Add command routing and help text
- `packages/cli/src/commands/task.ts` — Add `runTaskSteer()` function
- `packages/cli/src/__tests__/task-steer.test.ts` — New test file for the command

## Steps

### Step 1: Implement runTaskSteer() Command

- [ ] Add `runTaskSteer(id: string, message?: string)` function to `packages/cli/src/commands/task.ts`
- [ ] Import and use `createInterface` from `node:readline/promises` for stdin handling
- [ ] If message not provided as argument, read from stdin using readline
- [ ] Validate message length: 1-2000 characters (same as dashboard API)
- [ ] Validate message is not empty/whitespace-only
- [ ] Call `store.addSteeringComment(id, text.trim(), 'user')`
- [ ] Handle errors gracefully: task not found (ENOENT → "Task not found"), validation errors
- [ ] Display success confirmation with comment preview (first 60 chars + "…" if longer)
- [ ] Add log entry confirmation output (follow pattern in `runTaskLog`)

**Artifacts:**
- `packages/cli/src/commands/task.ts` (modified) — new `runTaskSteer()` function

### Step 2: Add CLI Routing and Help Text

- [ ] Add import for `runTaskSteer` in `packages/cli/src/bin.ts` dynamic import block
- [ ] Add `case "steer":` handler in the task subcommand switch statement (after "unpause")
- [ ] Parse command: `kb task steer <id> [message]`
- [ ] If message not provided as argument, pass undefined to trigger stdin mode
- [ ] Add help text entry: `kb task steer <id> [message]    Add steering comment (prompts if message omitted)`
- [ ] Include the command in the main help text under task subcommands section

**Artifacts:**
- `packages/cli/src/bin.ts` (modified) — command routing and help text

### Step 3: Write Unit Tests

- [ ] Create new test file `packages/cli/src/__tests__/task-steer.test.ts`
- [ ] Mock `@kb/core` TaskStore with `addSteeringComment` method
- [ ] Test successful steering comment addition with message argument
- [ ] Test reading message from stdin when not provided as argument
- [ ] Test message length validation (reject >2000 chars)
- [ ] Test empty message validation (reject empty/whitespace)
- [ ] Test task not found error handling (ENOENT)
- [ ] Test success output format (includes preview and confirmation)
- [ ] Mock `createInterface` for stdin testing (follow pattern in task-plan.test.ts)

**Test Patterns to Follow:**
```typescript
// Mock pattern from task-plan.test.ts
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
}));

// Store mock pattern
vi.mock("@kb/core", () => ({
  TaskStore: vi.fn(),
  COLUMNS: [...],
  COLUMN_LABELS: {...},
}));
```

**Artifacts:**
- `packages/cli/src/__tests__/task-steer.test.ts` (new file)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all test failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: `kb task steer KB-001 "This is a test steering comment"`
- [ ] Verify stdin mode: `echo "Test comment" | kb task steer KB-001`

### Step 5: Documentation & Delivery

- [ ] Update CLI help text is complete and accurate
- [ ] Verify changeset not needed (this is a new CLI feature for internal packages, not published @dustinbyrne/kb behavior change)
- [ ] Create follow-up task if edge cases discovered during testing

## Implementation Details

### Command Syntax

```
kb task steer <id> [message]
```

- `<id>` — Required task ID (e.g., KB-001)
- `[message]` — Optional steering comment text. If omitted, prompts via stdin.

### Validation Rules

Per dashboard API (`packages/dashboard/src/routes.ts` lines 938-941):
- Text must be between 1 and 2000 characters
- Empty strings rejected
- Whitespace-only strings should be trimmed and validated

### Success Output Format

Follow existing patterns (see `runTaskLog`):
```
  ✓ Steering comment added to KB-001
    "This is the comment preview..."
```

### Error Output Format

```
Error: Task not found: KB-999
```
or
```
Error: Message must be between 1 and 2000 characters
```
or
```
Error: Message is required
```

### Example Usage

```bash
# Add steering comment as argument
kb task steer KB-001 "Focus on error handling in the validation logic"

# Add steering comment via stdin (for multi-line or piped input)
echo "Please prioritize the edge cases" | kb task steer KB-001

# Interactive mode (prompts for message)
kb task steer KB-001
# → Message: (user types and presses Enter)
```

## Completion Criteria

- [ ] `kb task steer <id> [message]` command implemented and working
- [ ] Message validation (1-2000 chars) enforced
- [ ] Stdin input supported when message not provided as argument
- [ ] All error cases handled with clear messages
- [ ] Help text updated with new command
- [ ] Unit tests written and passing
- [ ] Full test suite passes (`pnpm test`)
- [ ] Build passes (`pnpm build`)

## Git Commit Convention

- **Step 1 completion:** `feat(KB-204): implement runTaskSteer command`
- **Step 2 completion:** `feat(KB-204): add kb task steer CLI routing and help`
- **Step 3 completion:** `test(KB-204): add unit tests for task steer command`
- **Bug fixes:** `fix(KB-204): description`

## Do NOT

- Modify the dashboard API or TaskStore.addSteeringComment() implementation (already exists)
- Add steering comment support to the Pi extension (out of scope — only CLI command needed)
- Allow messages longer than 2000 characters (match dashboard validation)
- Skip validation for empty/whitespace-only messages
- Use different validation rules than the dashboard API
- Create changeset (this is an internal CLI feature, not affecting published @dustinbyrne/kb package behavior)
