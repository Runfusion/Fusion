# @kb/dashboard

Web-based dashboard for managing kb tasks. Provides a visual kanban board, list view, and git repository management tools.

## Features

### Planning Mode
AI-guided interactive planning for creating well-specified tasks from high-level ideas. Click the lightbulb icon in the header to start planning.

**How it works**:
1. Enter a high-level description of what you want to build (e.g., "Build a user authentication system")
2. The AI asks clarifying questions (scope, requirements, technology choices)
3. Answer questions through an interactive UI with multiple question types:
   - **Text**: Open-ended responses for detailed requirements
   - **Single Select**: Choose one option from a list (e.g., scope: small/medium/large)
   - **Multi Select**: Select multiple applicable options (e.g., features to include)
   - **Confirm**: Yes/No questions for quick decisions
4. Review the AI-generated summary with:
   - Refinable title and description
   - Size estimate (S/M/L)
   - Suggested dependencies from existing tasks
   - Key deliverables checklist
5. Create the task directly from the summary

**Features**:
- **Rate Limiting**: Maximum 5 planning sessions per hour per IP
- **Session Persistence**: 30-minute TTL with automatic cleanup
- **Progress Tracking**: Visual progress indicator showing question number
- **Back Navigation**: Revisit previous answers during the session
- **Example Suggestions**: Quick-start chips with common task templates
- **Dependency Selection**: Toggle existing tasks as dependencies
- **Keyboard Navigation**: Tab through options, Enter to submit, Escape to close
- **Mobile-Safe Inputs**: Text inputs (initial plan, question responses, summary description) use 16px font size on mobile viewports to prevent browser zoom-on-focus

**API Endpoints**:
- `POST /api/planning/start` - Begin planning session (`{ initialPlan }`)
- `POST /api/planning/respond` - Submit response (`{ sessionId, responses }`)
- `POST /api/planning/cancel` - Cancel session (`{ sessionId }`)
- `POST /api/planning/create-task` - Create task from summary (`{ sessionId }`)

### Task Management
- **Kanban Board**: Drag-and-drop task management across columns (Triage, Todo, In Progress, In Review, Done)
- **Inline Editing**: Quick-edit task title and description directly on the board for Triage and Todo columns. Double-click a card or use the pencil icon — visible on hover for desktop, always visible on mobile for touch accessibility.
- **Task Detail Editing**: Edit task title and description directly in the task detail modal. Click the pencil icon in the modal header (available for Triage and Todo tasks) to enter edit mode.
- **List View**: Alternative tabular view for tasks with sorting and filtering. The "Hide Done" toggle hides both Done and Archived tasks for an active-work-only view.
- **Model Selection at Creation**: Choose executor and validator AI models while creating tasks from the board or list view, or leave them unset to use the global defaults.
- **Task Details**: View full task specifications, agent logs, and attachments
- **GitHub Import**: Import issues directly from GitHub repositories
- **PR Management**: Create, monitor, and merge pull requests for in-review tasks

### Responsive Header
The dashboard header adapts to small screens to remain usable without wrapping or dropping controls:

- **Mobile Overflow Menu**: On screens narrower than 768px, lower-priority actions (GitHub Import, Planning, Settings, and optionally Usage) move into an accessible overflow menu triggered by a "More actions" button. The menu closes on outside click, Escape key, or after selecting an action.
- **Collapsible Board Search**: On mobile board view, the search input collapses to an icon button. Tapping the icon expands a focused search field. If a search query is already active, the search stays expanded until cleared or explicitly closed so active filters remain visible.
- **Always-Visible Controls**: View toggle (Board/List), Terminal, Pause, and Stop buttons remain inline on mobile for immediate access.
- **Keyboard Accessible**: All mobile controls expose proper ARIA attributes (aria-expanded, aria-haspopup, aria-label) and support keyboard navigation.

### Mobile Task Entry
Task entry inputs (the quick entry box in the Triage column and the New Task modal's description field) are sized to prevent browser zoom-on-focus on iOS Safari. On mobile viewports (≤768px), these inputs use a minimum 16px font size, which keeps the viewport stable when users focus the fields.

### Interactive Terminal
Access a fully functional PTY (pseudo-terminal) shell directly from the dashboard. Click the terminal icon in the header to open the interactive terminal modal.

**Features**:
- **Real PTY Terminal**: Spawns a real shell (bash/zsh/powershell) using node-pty for authentic terminal behavior
- **Bidirectional Communication**: WebSocket connection for instant input/output
- **xterm.js Integration**: Full terminal emulation with proper ANSI support, colors, and cursor handling
- **Auto-resizing**: Terminal automatically fits to container size
- **Scrollback Buffer**: 50KB of scrollback history with replay on reconnect
- **Reconnection Support**: Automatic reconnect with exponential backoff if connection drops

**Keyboard Shortcuts**:
- `Ctrl+C` - Send SIGINT to process (copy if text selected)
- `Ctrl+V` - Paste from clipboard
- `Ctrl+L` - Clear terminal screen
- `Ctrl++` / `Ctrl+-` - Zoom in/out
- `Ctrl+0` - Reset zoom
- `Escape` - Close terminal modal

**Security**:
- Working directory restricted to project root (path traversal protection)
- Environment variable sanitization (PORT, DATA_DIR, GITHUB_TOKEN, etc. stripped)
- Session ID validation (alphanumeric only)
- Input sanitization (null bytes rejected)
- Shell allowlist validation

**Session Management**:
- Sessions persist while modal is open
- Maximum 10 concurrent sessions per user (configurable)
- Sessions can be restarted when shell exits
- Graceful shutdown with SIGTERM, then SIGKILL fallback

### Git Manager
The Git Manager provides comprehensive repository visualization and management directly from the web UI. Access it via the Git Branch icon in the header.
- **Safety Validation**: Dangerous commands (rm -rf /, etc.) are automatically blocked
- **Keyboard Shortcuts**:
  - `Enter` - Execute command
  - `Up/Down` - Navigate command history
  - `Ctrl+C` - Kill running process
  - `Ctrl+L` - Clear screen
  - `Esc` - Close terminal

**Supported Commands**: git, npm/pnpm/yarn, ls, cat, echo, pwd, cd, mkdir, touch, cp, mv, rm, head, tail, find, grep, curl, wget, node, npx, python, make, and more.

**Status Badge**: When tasks are "in-progress", the terminal button shows a badge with the count.

**Status Tab**: View current repository state including:
- Current branch name and commit hash
- Working directory status (clean/dirty)
- Ahead/behind counts relative to remote

**Commits Tab**: Browse recent commits with:
- Commit list with message, author, and date
- Expandable diff view for each commit
- Pagination support (load more commits)

**Branches Tab**: Manage local branches:
- List all branches with current indicator
- Create new branches with optional base
- Checkout existing branches
- Delete branches (with confirmation)

**Worktrees Tab**: Visualize worktree layout:
- List all worktrees with paths
- See which tasks own which worktrees
- Identify main vs linked worktrees
- Track free/used worktree count

**Remotes Tab**: Perform remote operations:
- Fetch from origin
- Pull latest changes
- Push current branch
- View operation results and error states

### File Browser
Browse and edit task worktree files directly from the task detail modal:

- **Files Tab**: Available when a task has a worktree assigned
- **File Tree**: Navigate directories with breadcrumb-style path display
- **Text Editor**: Edit files with a clean textarea-based editor
  - Supports all text files with automatic syntax detection
  - **Markdown Preview**: Toggle between edit and preview modes for `.md`, `.markdown`, and `.mdx` files
  - One-dark theme matching the dashboard
- **Safety Features**:
  - Path traversal prevention (blocks `..` patterns)
  - Binary file detection (prevents editing images, executables, etc.)
  - 1MB file size limit
  - Unsaved change indicators
- **Keyboard Shortcuts**:
  - `Ctrl/Cmd+S` to save
  - `Escape` to close

### Activity Log
View a centralized timeline of all task lifecycle events. Click the history icon in the header to open the Activity Log modal.

**Features**:
- **Event Types**: Track task:created, task:moved, task:merged, task:failed, task:deleted, and settings:updated events
- **Task Links**: Click any task ID in the log to open its detail modal
- **Filter by Type**: Use the dropdown to show only specific event types (e.g., only failures, only merges)
- **Auto-refresh**: Log updates automatically every 30 seconds when the modal is open
- **Pagination**: "Load More" button fetches older entries (100 entries per request, max 1000)
- **Clear Log**: Maintenance function to clear all activity history (with confirmation)

**Event Metadata**:
- Task moves show from/to column transitions
- Merges show success/failure status
- Failures include error messages when available

**Keyboard Shortcuts**:
- `Escape` - Close modal (or cancel confirmation dialog)

**API Endpoints**:
- `GET /api/activity` - Get activity log entries with optional limit, since, and type filters
- `DELETE /api/activity` - Clear all activity log entries

### Configuration
- **Settings Modal**: Configure scheduling, worktrees, build commands, merge preferences, notifications, and appearance
- **Error Recovery**: If settings fail to load, the modal displays an inline error message with a retry button instead of getting stuck on "Loading…"
- **Settings API Contract**: Server-owned fields like `githubTokenConfigured` are injected on GET /settings but stripped on PUT /settings to prevent persistence to config.json
- **Notifications**: ntfy.sh integration for push notifications when tasks complete or fail
- **Authentication**: OAuth provider management for AI model access
- **Pause Controls**: Soft pause (stop new work) and hard stop (kill all agents)
- **Theming**: Light/dark/system mode toggle and 12 color themes (see Theming section below)

### Merge strategies

The dashboard exposes two automated completion strategies in Settings:

- **Direct merge** *(default)* — preserves existing behavior. When `autoMerge` is enabled, kb merges in-review tasks locally.
- **Pull request** — when `autoMerge` is enabled, kb creates or links a PR for the task branch, keeps the task in **In Review** while waiting on GitHub policy, and merges the PR when it is ready.

`autoMerge` is still the master switch for automation. Turning it off disables both direct merge and PR-first auto-completion.

### PR-first workflow notes

When the merge strategy is **Pull request**:

- The task's PR section shows whether kb is waiting on checks/reviews or has merged successfully
- Required checks must pass before kb merges the PR; optional checks do not block auto-merge
- A blocking review state (for example, active changes requested) prevents auto-merge until cleared
- Closed PRs do not auto-merge
- GitHub access must be available via `gh auth login` or `GITHUB_TOKEN`
- kb expects the task branch to already be pushed using the standard branch name `kb/<task-id-lower>`

**Non-goal:** the dashboard does not implicitly push branches before PR creation. Use your normal git workflow or automation to publish task branches first.

## Theming

The dashboard supports a comprehensive theming system with both light/dark mode and color theme options.

### Theme Modes
- **Dark** (default): Classic dark theme, GitHub-inspired
- **Light**: Light backgrounds with dark text
- **System**: Automatically follows your operating system preference

Toggle between modes using the theme button in the header (cycles Dark → Light → System) or select from the Appearance section in Settings.

### Color Themes
Choose from 12 distinct color palettes in the Appearance settings:

| Theme | Description |
|-------|-------------|
| **Default** | Classic blue accent colors (GitHub-inspired) |
| **Ocean** | Deep blues with cyan accents |
| **Forest** | Deep greens with emerald accents |
| **Sunset** | Warm oranges and reds |
| **Berry** | Purple/pink tones |
| **Monochrome** | Pure grayscale |
| **High Contrast** | Extreme contrast for accessibility |
| **Solarized** | Classic solarized palette |

### Theme Persistence
Theme preferences are automatically saved to localStorage and persist across sessions. The effective theme is applied immediately to prevent flash of unstyled content.

### Adding New Themes
To add a new color theme:

1. Add the theme to `COLOR_THEMES` in `packages/core/src/types.ts`
2. Add CSS variables in `packages/dashboard/app/styles.css` under `[data-color-theme="your-theme"]`
3. Add the swatch class for the theme picker in the CSS
4. Update `ThemeSelector.tsx` with the new theme option

## Performance Characteristics

The dashboard includes several runtime safeguards to stay responsive during long sessions and on larger boards:

- **Agent log cap**: The UI keeps only the most recent **500 agent log entries per task** in memory. Historical log fetches and live SSE appends are both truncated to this window.
- **Memoized task rendering**: `TaskCard`, `Column`, and worktree grouping are memoized so unrelated SSE updates do not force the whole board to repaint. The board also preserves stable per-column task arrays for unchanged columns.
- **Large-column pagination**: Columns with more than **100 tasks** use incremental client-side pagination, rendering **50 tasks initially** and loading **25 more** at a time. This is applied to active non-archived, non-`in-progress` columns to avoid breaking worktree grouping and archived browsing behavior.
- **Badge update isolation**: Live GitHub PR/issue badge websocket updates are rendered through a dedicated child component so badge freshness is preserved even when task cards are memoized.
- **SSE cleanup and reconnects**: Task and log streaming hooks explicitly clean up EventSource listeners/connections and avoid duplicate stream setup during rerenders.

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build for production
pnpm build

# Start development server
pnpm dev
```

### Strict TypeScript Verification

The dashboard enforces strict type-checking via `src/__tests__/typecheck.test.ts`, which runs `pnpm typecheck` to verify the workspace type-checks cleanly from a clean checkout. The test temporarily moves any existing `dist/` directories to ensure type resolution happens against source files, not stale build artifacts. This ensures type safety across the workspace and catches missing or incompatible types in dependencies without requiring a full build first.

**Contributor Verification Requirements**

Dashboard changes must keep both test suites green:

```bash
cd packages/dashboard && pnpm test      # Run all dashboard tests
cd packages/dashboard && pnpm typecheck # Run dashboard typecheck
```

The terminal hook tests (`app/hooks/useTerminal.test.ts`) and typecheck regression suite (`src/__tests__/typecheck.test.ts`) are intentionally active — do not skip these tests. Any changes that break type safety or test coverage will fail the CI gate.

### Workspace Type Checking

From the repository root, validate all packages without building:

```bash
pnpm typecheck                  # Type-check all packages from clean checkout
```

This works by configuring packages to resolve their workspace dependencies via TypeScript's module resolution against source files. The dashboard's own `typecheck` script runs both server (`src/`) and client (`app/`) type checks.

## API Endpoints

The dashboard server exposes a REST API at `/api`:

### Tasks
- `GET /api/tasks` - List all tasks
- `GET /api/tasks/:id` - Get task details
- `POST /api/tasks` - Create new task
- `PATCH /api/tasks/:id` - Update task
- `POST /api/tasks/:id/move` - Move task to column
- `POST /api/tasks/:id/pause` - Pause task
- `POST /api/tasks/:id/unpause` - Unpause task
- `DELETE /api/tasks/:id` - Delete task

### Git Operations
- `GET /api/git/status` - Current branch and status
- `GET /api/git/commits` - Recent commits (with optional `?limit=`)  
- `GET /api/git/commits/:hash/diff` - Commit diff
- `GET /api/git/branches` - List branches
- `GET /api/git/worktrees` - List worktrees with task associations
- `POST /api/git/branches` - Create branch (`{ name, base? }`)
- `POST /api/git/branches/:name/checkout` - Checkout branch
- `DELETE /api/git/branches/:name` - Delete branch (`?force=true`)
- `POST /api/git/fetch` - Fetch from remote (`{ remote? }`)
- `POST /api/git/pull` - Pull current branch
- `POST /api/git/push` - Push current branch

### Interactive Terminal (PTY/WebSocket)
- `POST /api/terminal/sessions` - Create PTY session (`{ cwd?, cols?, rows? }`) → `{ sessionId, shell, cwd }`
- `GET /api/terminal/sessions` - List active sessions → `[{ id, cwd, shell, createdAt }]`
- `DELETE /api/terminal/sessions/:id` - Kill session → `{ killed }`
- `WS /api/terminal/ws?sessionId=xxx` - WebSocket for bidirectional I/O

### Interactive Terminal (Legacy SSE - Deprecated)
- `POST /api/terminal/exec` - Execute command (`{ command }`) → `{ sessionId }` (legacy)
- `GET /api/terminal/sessions/:id/stream` - SSE stream (legacy)

### GitHub Integration
- `GET /api/git/remotes` - List GitHub remotes
- `POST /api/github/issues/fetch` - Fetch issues (`{ owner, repo, limit?, labels? }`)
- `POST /api/github/issues/import` - Import issue (`{ owner, repo, issueNumber }`)
- `POST /api/github/webhooks` - GitHub App webhook endpoint for badge updates (see GitHub App Setup below)
- `POST /api/tasks/:id/pr/create` - Create PR
- `GET /api/tasks/:id/pr/status` - Get PR status (5-min staleness, auto background refresh)
- `POST /api/tasks/:id/pr/refresh` - Force refresh PR status
- `GET /api/tasks/:id/issue/status` - Get cached issue status (5-min staleness, auto background refresh)
- `POST /api/tasks/:id/issue/refresh` - Force refresh issue status
- `WS /api/ws` - Real-time PR/issue badge updates for subscribed task cards

### GitHub App Setup for Badge Webhooks

For real-time PR/issue badge updates, configure a GitHub App instead of relying on polling:

**Environment Variables:**
- `KB_GITHUB_APP_ID` - Your GitHub App ID
- `KB_GITHUB_APP_PRIVATE_KEY` - PEM private key content (or use `KB_GITHUB_APP_PRIVATE_KEY_PATH`)
- `KB_GITHUB_APP_PRIVATE_KEY_PATH` - Path to PEM private key file (alternative to direct key)
- `KB_GITHUB_WEBHOOK_SECRET` - Webhook secret for signature verification

**GitHub App Configuration:**
- **Permissions Required:**
  - Metadata: Read
  - Pull requests: Read
  - Issues: Read
- **Webhook Events:** Subscribe to `pull_request`, `issues`, and `issue_comment` events
- **Webhook URL:** `https://your-dashboard-url/api/github/webhooks`

**How it Works:**
1. GitHub sends signed webhook events when PR/issue state changes
2. Server verifies `X-Hub-Signature-256` using `KB_GITHUB_WEBHOOK_SECRET`
3. Server fetches canonical badge data using GitHub App installation token
4. Matching tasks (by parsed badge URL) are updated via `store.updatePrInfo()` / `store.updateIssueInfo()`
5. `task:updated` event triggers `/api/ws` broadcast to subscribed clients
6. No duplicate broadcasts when only `lastCheckedAt` timestamp changes

**Fallback Behavior:**
When webhook delivery is unavailable, the 5-minute refresh endpoints (`/api/tasks/:id/pr/status`, `/api/tasks/:id/issue/status`) continue to work as the fallback path. Staleness is computed from persisted `lastCheckedAt` timestamps only (no in-memory poller state).

### Multi-Instance Deployments

When running the dashboard on multiple instances behind a load balancer, badge updates can be shared across instances using Redis pub/sub. This ensures that a PR/issue badge change detected on instance A is delivered to subscribed WebSocket clients on instance B.

**Configuration:**
- `KB_BADGE_PUBSUB_REDIS_URL` - Redis connection URL (e.g., `redis://localhost:6379`)
- `KB_BADGE_PUBSUB_CHANNEL` - Pub/sub channel name (default: `kb:badge-updates`)

When `KB_BADGE_PUBSUB_REDIS_URL` is not set, the dashboard uses an in-memory adapter for single-instance deployments.

**Design Notes:**
- Webhook deliveries to any instance are broadcast to all instances via pub/sub
- WebSocket message format unchanged: `{ type: "badge:updated", taskId, prInfo?, issueInfo?, timestamp }`
- Echo prevention: origin instances ignore their own pub/sub messages via source ID deduplication
- Late subscribers receive the current cached snapshot from their connected instance

### PTY Terminal (WebSocket-based)
- `POST /api/terminal/sessions` - Create session
- `GET /api/terminal/sessions` - List sessions
- `DELETE /api/terminal/sessions/:id` - Kill session
- `WS /api/terminal/ws` - WebSocket connection

### Configuration
- `GET /api/config` - Server configuration
- `GET /api/settings` - User settings
- `PUT /api/settings` - Update settings
- `GET /api/models` - Available AI models
- `GET /api/auth/status` - OAuth provider status
- `POST /api/auth/login` - Initiate OAuth login
- `POST /api/auth/logout` - Logout from provider

## Architecture

- **Frontend**: React + Vite, TypeScript, xterm.js for terminal emulation, CSS custom properties for theming
- **Backend**: Express server with REST API, badge WebSocket at `/api/ws`, terminal WebSocket at `/api/terminal/ws`, and Server-Sent Events (SSE) for task/log updates
- **Terminal**: node-pty for PTY spawning, WebSocket for bidirectional I/O
- **Badge Updates**: `useBadgeWebSocket()` shares a single browser socket and subscribes per visible GitHub-linked task card
- **State Management**: Custom hooks with EventSource for real-time task updates plus a dedicated WebSocket store for badge snapshots
- **Git Integration**: Server-side git command execution with validation
