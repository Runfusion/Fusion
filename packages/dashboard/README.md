# @kb/dashboard

Web-based dashboard for managing kb tasks. Provides a visual kanban board, list view, and git repository management tools.

## Features

### Task Management
- **Kanban Board**: Drag-and-drop task management across columns (Triage, Todo, In Progress, In Review, Done)
- **Inline Editing**: Quick-edit task title and description directly on the board for Triage and Todo columns. Double-click a card or use the pencil icon that appears on hover.
- **List View**: Alternative tabular view for tasks with sorting and filtering
- **Task Details**: View full task specifications, agent logs, and attachments
- **GitHub Import**: Import issues directly from GitHub repositories
- **PR Management**: Create and track pull requests for in-review tasks

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

### Configuration
- **Settings Modal**: Configure scheduling, worktrees, build commands, merge preferences, notifications, and appearance
- **Notifications**: ntfy.sh integration for push notifications when tasks complete or fail
- **Authentication**: OAuth provider management for AI model access
- **Pause Controls**: Soft pause (stop new work) and hard stop (kill all agents)
- **Theming**: Light/dark/system mode toggle and 8 color themes (see Theming section below)

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
