# Task: KB-058 - Interactive Terminal for Dashboard

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This task involves significant infrastructure changes including adding node-pty dependency, implementing WebSocket terminal protocol, replacing the log viewer with xterm.js, and ensuring secure shell execution. High security risk and complexity warrant full review.

**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Transform the dashboard's TerminalModal from a read-only agent log viewer into a fully interactive terminal where users can execute shell commands against the project workspace. Research and follow Automaker's proven architecture using node-pty on the backend and @xterm/xterm on the frontend with WebSocket bidirectional communication. The terminal should spawn a real shell (bash/zsh/powershell based on platform) in the project root directory and allow users to run any command as if they opened a terminal locally.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/clawd/repos/automaker/apps/server/src/services/terminal-service.ts` — Reference implementation for node-pty session management
- `/Users/eclipxe/clawd/repos/automaker/apps/ui/src/components/views/terminal-view/terminal-panel.tsx` — Reference implementation for xterm.js frontend
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TerminalModal.tsx` — Current terminal modal (to be replaced)
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/__tests__/TerminalModal.test.tsx` — Existing tests
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Existing API client patterns
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Existing API route patterns
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/server.ts` — Server setup
- `/Users/eclipxe/Projects/kb/packages/dashboard/package.json` — Dependencies

## File Scope

- `packages/dashboard/package.json` — Add node-pty and @xterm/xterm dependencies
- `packages/dashboard/src/terminal-service.ts` — New: node-pty terminal session manager
- `packages/dashboard/src/routes.ts` — Add WebSocket terminal routes and REST session endpoints
- `packages/dashboard/src/server.ts` — Mount terminal WebSocket handler
- `packages/dashboard/app/components/TerminalModal.tsx` — Replace with xterm-based interactive terminal
- `packages/dashboard/app/components/Terminal.css` — New: xterm styling and terminal UI
- `packages/dashboard/app/api.ts` — Add terminal session API functions
- `packages/dashboard/app/hooks/useTerminal.ts` — New: React hook for terminal WebSocket management
- `packages/dashboard/app/hooks/useTerminal.test.ts` — New: Tests for terminal hook

## Steps

### Step 1: Add Dependencies

- [ ] Add `node-pty` to dashboard package.json dependencies
- [ ] Add `@xterm/xterm` to dashboard package.json dependencies
- [ ] Add `@xterm/addon-fit` for terminal auto-resizing
- [ ] Run `pnpm install` to update lockfile
- [ ] Run `pnpm build` to verify no compilation issues

**Artifacts:**
- `packages/dashboard/package.json` (modified)

### Step 2: Backend Terminal Service

Create a TerminalService class modeled after Automaker's implementation that:

- [ ] Create `packages/dashboard/src/terminal-service.ts` with TerminalService class
- [ ] Implement shell detection (bash, zsh, powershell, cmd) based on platform
- [ ] Implement `createSession(cwd?, shell?, cols?, rows?)` method returning session ID
- [ ] Implement `write(sessionId, data)` to send input to PTY
- [ ] Implement `resize(sessionId, cols, rows)` for terminal resizing
- [ ] Implement `killSession(sessionId)` with SIGTERM then SIGKILL fallback
- [ ] Implement scrollback buffer (50KB limit) for reconnection support
- [ ] Implement session limit (default 10 concurrent terminals per user)
- [ ] Add event emitters for 'data', 'exit' events
- [ ] Export singleton `getTerminalService()` function
- [ ] Add comprehensive error handling for invalid sessions

**Security requirements:**
- Validate all session IDs are alphanumeric with dashes only
- Reject commands with null bytes
- Ensure working directory is within project root (path traversal protection)
- Sanitize environment variables (strip PORT, DATA_DIR, internal vars)
- Set TERM=xterm-256color for consistent behavior

**Artifacts:**
- `packages/dashboard/src/terminal-service.ts` (new)

### Step 3: Backend API Routes

Extend the dashboard API with terminal endpoints:

- [ ] Add `POST /api/terminal/sessions` — Create new terminal session
  - Body: `{ cwd?: string, cols?: number, rows?: number }`
  - Returns: `{ sessionId: string, shell: string, cwd: string }`
  - Creates PTY session and returns session ID

- [ ] Add `DELETE /api/terminal/sessions/:id` — Kill terminal session
  - Sends SIGTERM, then SIGKILL after 1 second if needed
  - Returns: `{ killed: true }`

- [ ] Add `GET /api/terminal/sessions` — List active sessions
  - Returns: `[{ id, cwd, shell, createdAt }]`

- [ ] Add WebSocket endpoint at `/api/terminal/ws` using ws library
  - Query params: `?sessionId=xxx`
  - Messages from client: `{ type: 'input', data: string }`, `{ type: 'resize', cols, rows }`, `{ type: 'ping' }`
  - Messages to client: `{ type: 'data', data: string }`, `{ type: 'connected', shell, cwd }`, `{ type: 'exit', exitCode }`, `{ type: 'scrollback', data: string }`, `{ type: 'pong' }`
  - On connect: send scrollback buffer then 'connected' event
  - Heartbeat: ping every 30 seconds
  - Clean up on disconnect (but keep session running for reconnect)

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/server.ts` (modified)

### Step 4: Frontend Terminal Hook

Create a React hook for managing terminal WebSocket connection:

- [ ] Create `packages/dashboard/app/hooks/useTerminal.ts`
- [ ] Implement `useTerminal(sessionId: string | null)` hook
- [ ] Handle WebSocket connection lifecycle (connect, reconnect, disconnect)
- [ ] Implement exponential backoff reconnect (max 5 attempts, 1s→16s delays)
- [ ] Expose `sendInput(data: string)` function
- [ ] Expose `resize(cols: number, rows: number)` function
- [ ] Expose `connectionStatus: 'connecting' | 'connected' | 'disconnected'`
- [ ] Expose `onData` callback registration for xterm integration
- [ ] Handle heartbeat ping/pong
- [ ] Clear session on 4004 "session not found" error

**Artifacts:**
- `packages/dashboard/app/hooks/useTerminal.ts` (new)

### Step 5: Frontend Terminal Modal

Replace the existing TerminalModal with an interactive xterm-based terminal:

- [ ] Install xterm CSS: `import '@xterm/xterm/css/xterm.css'`
- [ ] Create terminal container ref and xterm instance ref
- [ ] Dynamically import xterm modules (Terminal, FitAddon, WebglAddon, WebLinksAddon)
- [ ] Initialize terminal with theme matching dashboard dark/light mode
- [ ] Use FitAddon for auto-resizing to container
- [ ] Load WebglAddon for better rendering performance (with canvas fallback)
- [ ] Load WebLinksAddon for clickable URLs
- [ ] Implement copy/paste via keyboard shortcuts:
  - Ctrl/Cmd+C: Copy if selection, otherwise SIGINT
  - Ctrl/Cmd+V: Paste from clipboard
  - Ctrl/Cmd+Shift+C: Always copy
- [ ] Implement zoom: Ctrl/Cmd++ (increase), Ctrl/Cmd+- (decrease), Ctrl/Cmd+0 (reset)
- [ ] Show connection status indicator (connected/disconnecting/reconnecting)
- [ ] Show "New Terminal" button to spawn additional sessions
- [ ] Show session tabs if multiple terminals active
- [ ] Handle terminal exit (show exit code, offer to restart)

**Styling requirements:**
- Terminal fills modal content area
- Dark background matching dashboard theme
- Scrollbar styling consistent with dashboard
- Font: monospace, 14px default

**Artifacts:**
- `packages/dashboard/app/components/TerminalModal.tsx` (modified)
- `packages/dashboard/app/components/Terminal.css` (new)

### Step 6: Frontend API Client

Add terminal API functions to the API client:

- [ ] Add `createTerminalSession(cwd?, cols?, rows?)` → Promise<{ sessionId, shell, cwd }>
- [ ] Add `killTerminalSession(sessionId)` → Promise<void>
- [ ] Add `listTerminalSessions()` → Promise<Array<{ id, cwd, shell, createdAt }>>

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `packages/dashboard/app/hooks/useTerminal.test.ts` with tests:
  - WebSocket connection established on valid sessionId
  - Reconnects after disconnect
  - Sends input data correctly
  - Calls onData callback when data received
  - Handles connection status changes
  - Cleanup on unmount closes WebSocket

- [ ] Create `packages/dashboard/src/terminal-service.test.ts` with tests:
  - Creates session with detected shell
  - Write sends data to PTY
  - Resize updates PTY dimensions
  - Kill session terminates process
  - Session limit enforced
  - Scrollback buffer maintained
  - Invalid session ID returns null

- [ ] Update `packages/dashboard/app/components/__tests__/TerminalModal.test.tsx`:
  - Terminal renders xterm instance
  - WebSocket connects on mount
  - Shows connection status
  - Handles user input
  - Cleanup disposes xterm on unmount

- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/hooks/useTerminal.test.ts` (new)
- `packages/dashboard/src/terminal-service.test.ts` (new)
- `packages/dashboard/app/components/__tests__/TerminalModal.test.tsx` (modified)

### Step 8: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` with terminal feature documentation
  - How to use the interactive terminal
  - Keyboard shortcuts
  - Session management
  - Security considerations

- [ ] Create changeset for the new feature:
  ```bash
  cat > .changeset/add-interactive-terminal.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add interactive terminal to dashboard
  
  The dashboard now includes a fully interactive terminal where users can execute
  shell commands directly from the web interface. Supports multiple concurrent
  sessions, copy/paste, zoom, and automatic reconnection.
  EOF
  ```

- [ ] Verify all files committed with proper task ID prefix

**Artifacts:**
- `packages/dashboard/README.md` (modified)
- `.changeset/add-interactive-terminal.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — Add section "Interactive Terminal" documenting usage, keyboard shortcuts, and session management

**Check If Affected:**
- `AGENTS.md` — Update if new CLI commands or settings added
- `README.md` — Update main project README with feature highlight

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test` in dashboard package)
- [ ] Build passes (`pnpm build` in dashboard package)
- [ ] Terminal spawns real shell (bash/zsh/powershell based on platform)
- [ ] User can type commands and see output in real-time
- [ ] Multiple terminal sessions can be created
- [ ] Copy/paste works via keyboard shortcuts
- [ ] Zoom (Ctrl++/Ctrl+-/Ctrl+0) works
-- [ ] WebSocket reconnects automatically on disconnect
- [ ] Sessions are killed when modal closed or session deleted
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-058): complete Step N — description`
- **Bug fixes:** `fix(KB-058): description`
- **Tests:** `test(KB-058): description`

## Do NOT

- Use `eval()` or execute arbitrary code from client input
- Allow session IDs with special characters (only alphanumeric and dashes)
- Permit working directories outside the project root (path traversal protection required)
- Spawn shells as root/administrator (use current user privileges)
- Store terminal output in logs (may contain sensitive data)
- Send terminal data over SSE (use WebSocket only)
- Create terminal sessions without a session limit
- Skip security validation on shell paths (validate against allowed shells)
- Leave zombie PTY processes (always kill with SIGKILL fallback)
- Modify files outside the File Scope without good reason
