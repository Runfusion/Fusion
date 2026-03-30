# @kb/dashboard

Web-based dashboard for managing kb tasks. Provides a visual kanban board, list view, and git repository management tools.

## Features

### Task Management
- **Kanban Board**: Drag-and-drop task management across columns (Triage, Todo, In Progress, In Review, Done)
- **Inline Editing**: Quick-edit task title and description directly on the board for Triage and Todo columns. Double-click a card or use the pencil icon that appears on hover.
- **List View**: Alternative tabular view for tasks with sorting, filtering, and collapsible column sections. Click section headers to expand/collapse each column group. Section expansion state is persisted to localStorage.
- **Task Details**: View full task specifications, agent logs, and attachments
- **GitHub Import**: Import issues directly from GitHub repositories
- **PR Management**: Create and track pull requests for in-review tasks

### Git Manager
The Git Manager provides comprehensive repository visualization and management directly from the web UI. Access it via the Git Branch icon in the header.

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
- **Settings Modal**: Configure scheduling, worktrees, build commands, merge preferences
- **Authentication**: OAuth provider management for AI model access
- **Pause Controls**: Soft pause (stop new work) and hard stop (kill all agents)

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
