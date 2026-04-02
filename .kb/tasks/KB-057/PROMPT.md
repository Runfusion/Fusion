# Task: KB-057 - Make Dashboard Terminal an Actual Interactive Shell

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is a significant UI/UX change that replaces the passive agent log viewer with an interactive shell terminal. It requires new API endpoints, security considerations for command execution, WebSocket/SSE for real-time output, and proper input handling. The blast radius spans frontend components, backend routes, and security boundaries.

**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Transform the dashboard's TerminalModal from a passive agent log viewer into an actual interactive shell terminal where users can execute commands in the project's working directory. The terminal will maintain session state, support command history, and stream output in real-time via SSE. This replaces the current "agent run" view with a functional CLI interface.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TerminalModal.tsx` — Current terminal modal implementation (shows agent logs)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/AgentLogViewer.tsx` — Current log viewer component
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/hooks/useMultiAgentLogs.ts` — Current log streaming hook
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Frontend API client
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Server routes (see existing execSync patterns for git commands)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Terminal modal styling (search for `.terminal-*` classes)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/Header.tsx` — Terminal toggle button
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/App.tsx` — How TerminalModal is used

## File Scope

### Modify
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TerminalModal.tsx` — Replace agent logs with interactive terminal
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Add shell execution API endpoints
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Add terminal API client methods
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/App.tsx` — Update TerminalModal props (remove task dependency)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/Header.tsx` — Enable terminal button always (not just for in-progress tasks)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Add terminal input/output styling

### Create
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/hooks/useTerminal.ts` — New hook for terminal session management
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TerminalModal.test.tsx` — Update existing tests for new behavior

### Optionally Remove/Deprecate
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/hooks/useMultiAgentLogs.ts` — No longer needed for terminal (may be used elsewhere)

## Steps

### Step 1: Backend API - Shell Execution Endpoints

- [ ] Add `POST /api/terminal/exec` endpoint in `routes.ts` that executes shell commands
  - Accepts `{ command: string, sessionId?: string }` in request body
  - Validates command against allowlist/blocklist (prevent rm -rf /, etc.)
  - Executes command in the project root directory (use `store.getRootDir()`)
  - Returns `{ sessionId: string, output: string, exitCode: number }`
  - Commands run with 30-second timeout by default
- [ ] Add `GET /api/terminal/sessions/:id/stream` SSE endpoint for real-time output
  - Streams stdout/stderr as command executes
  - Events: `terminal:output`, `terminal:exit`
- [ ] Add `POST /api/terminal/sessions/:id/kill` to terminate running processes
- [ ] Add command validation helper (block dangerous commands)
  - Block: `rm -rf /`, `rm -rf /*`, `> /dev/sda`, `:(){ :|:& };:`, etc.
  - Allow: git commands, npm/pnpm/yarn, ls, cat, echo, etc.
- [ ] Run targeted tests for new routes

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` (modified)

### Step 2: Frontend API Client

- [ ] Add `execTerminalCommand(command: string, sessionId?: string)` to `api.ts`
- [ ] Add `createTerminalSession()` to initialize new session
- [ ] Add `killTerminalSession(sessionId: string)` for cleanup
- [ ] Add TypeScript types for terminal responses

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` (modified)

### Step 3: Terminal Hook

- [ ] Create `useTerminal()` hook in new file
  - Manages terminal session ID
  - Maintains command history (array of { command, output, exitCode })
  - Opens SSE connection to stream output
  - Provides `executeCommand(command: string)` function
  - Provides `clearHistory()` function
  - Cleanup on unmount: kill active process, close SSE
- [ ] Add tests for the hook

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/hooks/useTerminal.ts` (new)

### Step 4: TerminalModal Component Refactor

- [ ] Replace agent log viewer with interactive terminal UI
  - Command input field at bottom (like real terminal)
  - Output history display above input (scrollable)
  - Prompt showing current directory or `$`
- [ ] Add keyboard handling
  - Enter to execute command
  - Up/Down arrow for command history navigation
  - Ctrl+C to kill running process (call kill endpoint)
  - Ctrl+L to clear screen
- [ ] Update props interface: remove `tasks` dependency, add optional `initialCommand`
- [ ] Add terminal state: input value, history, isRunning, currentSessionId
- [ ] Style the terminal to look like a real terminal
  - Monospace font, dark background
  - Green prompt, white output, red stderr
  - Blinking cursor in input field
- [ ] Handle empty state: show welcome message with available commands

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/kb/packages/dashboard/app/components/TerminalModal.tsx` (modified)

### Step 5: Update App Integration

- [ ] Update `App.tsx` to not pass `inProgressTasks` to TerminalModal
- [ ] Remove `inProgressCount` dependency for terminal button in Header
- [ ] Enable terminal button always (remove `disabled={!hasInProgressTasks}`)
- [ ] TerminalModal should be always accessible, independent of task state

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/kb/packages/dashboard/app/App.tsx` (modified)
- `/Users/eclipxe/Projects/kb/packages/kb/packages/dashboard/app/components/Header.tsx` (modified)

### Step 6: Styling Updates

- [ ] Add CSS classes for terminal input field
- [ ] Add CSS for command output (stdout vs stderr distinction)
- [ ] Add CSS for prompt styling
- [ ] Add CSS for command history entries
- [ ] Ensure mobile responsiveness

**Artifacts:**
- `/Users/eclipxe/Projects/kb/packages/kb/packages/dashboard/app/styles.css` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update `TerminalModal.test.tsx` to test new interactive behavior
  - Test command input and submission
  - Test history display
  - Test keyboard shortcuts
  - Test clear screen functionality
- [ ] Add tests for new API endpoints (shell execution)
  - Test command validation (dangerous commands blocked)
  - Test successful command execution
  - Test SSE streaming
- [ ] Add tests for `useTerminal` hook
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 8: Documentation & Delivery

- [ ] Update dashboard README with terminal feature description
- [ ] Add JSDoc comments to new functions
- [ ] Create changeset file: `.changeset/interactive-terminal.md`
- [ ] Out-of-scope findings created as new tasks via `task_create` tool
  - Shell autocomplete feature
  - Persistent command history across sessions
  - Multi-tab terminal sessions

## Documentation Requirements

**Must Update:**
- `/Users/eclipxe/Projects/kb/packages/dashboard/README.md` — Add section on interactive terminal feature

**Check If Affected:**
- `/Users/eclipxe/Projects/kb/AGENTS.md` — Update if dashboard terminal behavior is referenced
- `/Users/eclipxe/Projects/kb/README.md` — Update main README if features listed

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Terminal can execute shell commands and display output
- [ ] Command validation blocks dangerous operations
- [ ] SSE streaming works for long-running commands
- [ ] Keyboard shortcuts work (Enter, Up/Down arrows, Ctrl+C, Ctrl+L)
- [ ] Terminal is accessible regardless of task state
- [ ] Changeset file included in commit

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-057): complete Step N — description`
- **Bug fixes:** `fix(KB-057): description`
- **Tests:** `test(KB-057): description`
- **Changeset:** Include `.changeset/interactive-terminal.md` in Step 8 commit

## Do NOT

- Remove or break existing agent log functionality if used elsewhere (check before deleting)
- Allow arbitrary command execution without validation (security risk)
- Execute commands outside the project root directory
- Store sensitive output (passwords, tokens) in command history
- Break mobile responsiveness
- Skip test coverage for security-critical validation logic
- Use `eval()` or similar dangerous JS patterns
- Allow command injection via unescaped input
