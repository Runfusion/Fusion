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

**API Endpoints**:
- `POST /api/planning/start` - Begin planning session (`{ initialPlan }`)
- `POST /api/planning/respond` - Submit response (`{ sessionId, responses }`)
- `POST /api/planning/cancel` - Cancel session (`{ sessionId }`)
- `POST /api/planning/create-task` - Create task from summary (`{ sessionId }`)

### Task Management
- **Kanban Board**: Drag-and-drop task management across columns (Triage, Todo, In Progress, In Review, Done)
- **Inline Editing**: Quick-edit task title and description directly on the board for Triage and Todo columns. Double-click a card or use the pencil icon that appears on hover.
- **List View**: Alternative tabular view for tasks with sorting and filtering. The "Hide Done" toggle hides both Done and Archived tasks for an active-work-only view.
- **Task Details**: View full task specifications, agent logs, and attachments
- **GitHub Import**: Import issues directly from GitHub repositories
- **PR Management**: Create, monitor, and merge pull requests for in-review tasks

### Interactive Terminal
Access a fully functional shell terminal directly from the dashboard. Click the terminal icon in the header to open the interactive terminal modal.

**Features**:
- Execute shell commands in the project's working directory
- Real-time output streaming via Server-Sent Events (SSE)
- Command history with Up/Down arrow navigation
- Keyboard shortcuts:
  - `↑` / `↓` - Navigate command history
  - `Ctrl+C` - Kill running process
  - `Ctrl+L` - Clear terminal screen
  - `Escape` - Close terminal modal

**Supported Commands**:
The terminal includes a curated allowlist of safe commands including: git, npm/pnpm/yarn, node, python, ls, cat, curl, make, ps, and many more. Dangerous commands (rm -rf /, disk writes, fork bombs, etc.) are automatically blocked for security.

**Session Management**:
- Each command creates a new session with 30-second timeout
- Output streams in real-time as the command executes
- Sessions automatically clean up after exit
- Terminal state persists while modal is open (clears on close)

### Git Manager
The Git Manager provides comprehensive repository visualization and management directly from the web UI. Access it via the Git Branch icon in the header.

### Interactive Terminal
The dashboard includes a fully interactive shell terminal for executing commands directly in the project's working directory. Access it via the Terminal icon in the header (always enabled, independent of task state).

**Features**:
- **Real-time Execution**: Commands execute with live output streaming via Server-Sent Events
- **Command History**: Navigate previous commands with Up/Down arrows
- **Local Commands**: Special handling for `cd`, `clear`, and `cls` commands
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
- **Code Editor**: Edit files with syntax highlighting powered by CodeMirror 6
  - Supports TypeScript, JavaScript, JSON, CSS, Markdown, and more
  - One-dark theme matching the dashboard
  - Auto-detects language from file extension
- **Safety Features**:
  - Path traversal prevention (blocks `..` patterns)
  - Binary file detection (prevents editing images, executables, etc.)
  - 1MB file size limit
  - Unsaved change indicators
- **Keyboard Shortcuts**:
  - `Ctrl/Cmd+S` to save
  - `Escape` to close

### Configuration
- **Settings Modal**: Configure scheduling, worktrees, build commands, merge preferences, notifications, and appearance
- **Notifications**: ntfy.sh integration for push notifications when tasks complete or fail
- **Authentication**: OAuth provider management for AI model access
- **Pause Controls**: Soft pause (stop new work) and hard stop (kill all agents)
- **Theming**: Light/dark/system mode toggle and 8 color themes (see Theming section below)

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
Choose from 8 distinct color palettes in the Appearance settings:

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

### Interactive Terminal
- `POST /api/terminal/exec` - Execute command (`{ command }`) → `{ sessionId }`
- `GET /api/terminal/sessions/:id` - Get session status and output
- `POST /api/terminal/sessions/:id/kill` - Kill running process (`{ signal? }`)
- `GET /api/terminal/sessions/:id/stream` - SSE stream for real-time output

### GitHub Integration
- `GET /api/git/remotes` - List GitHub remotes
- `POST /api/github/issues/fetch` - Fetch issues (`{ owner, repo, limit?, labels? }`)
- `POST /api/github/issues/import` - Import issue (`{ owner, repo, issueNumber }`)
- `POST /api/tasks/:id/pr/create` - Create PR
- `GET /api/tasks/:id/pr/status` - Get PR status
- `POST /api/tasks/:id/pr/refresh` - Refresh PR status

### Terminal
- `POST /api/terminal/exec` - Execute command (`{ command }`) - returns `{ sessionId }`
- `GET /api/terminal/sessions/:id` - Get session status and output
- `POST /api/terminal/sessions/:id/kill` - Kill running session
- `GET /api/terminal/sessions/:id/stream` - SSE stream for real-time output

### Configuration
- `GET /api/config` - Server configuration
- `GET /api/settings` - User settings
- `PUT /api/settings` - Update settings
- `GET /api/models` - Available AI models
- `GET /api/auth/status` - OAuth provider status
- `POST /api/auth/login` - Initiate OAuth login
- `POST /api/auth/logout` - Logout from provider

## Architecture

- **Frontend**: React + Vite, TypeScript, CSS custom properties for theming
- **Backend**: Express server with REST API and Server-Sent Events (SSE) for live updates
- **State Management**: Custom hooks with EventSource for real-time task updates
- **Git Integration**: Server-side git command execution with validation
