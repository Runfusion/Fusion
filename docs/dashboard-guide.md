# Dashboard Guide

[← Docs index](./README.md)

The Fusion dashboard is the main control plane for tasks, agents, missions, settings, logs, and repository operations.

## Board View

Board view is the kanban surface for day-to-day operation.

Features:

- Drag-and-drop between lifecycle columns
- Search/filter tasks
- Column visibility controls
- Inline quick entry creation
- PR/issue badges with live updates

![Board view](./screenshots/dashboard-overview.png)

## List View

List view is optimized for dense task management.

Features:

- Grouping modes (for example by column/size)
- Inline title editing
- Duplicate task actions
- Quick scanning of metadata without card expansion

## Interactive Terminal

Fusion embeds a terminal using xterm.js.

Features:

- Multiple terminal tabs
- PTY-backed shell sessions
- Mobile-aware virtual keyboard handling and auto-refit behavior

![Interactive terminal](./screenshots/terminal.png)

## Git Manager

Git manager centralizes repo operations in the dashboard.

Features:

- Branch/worktree visibility
- Commit and diff browsing
- Push/pull/fetch actions
- Remote editing controls

![Git manager](./screenshots/git-manager.png)

## File Browser and Editor

Built-in file tools allow quick inspection and edits.

Features:

- Browse project root and task worktrees
- Open files in an editor with syntax highlighting
- Navigate artifacts generated during task execution

## Activity Log

The activity log tracks task/system events over time.

Features:

- Event type filtering
- Auto-refresh updates
- Operational traceability for task moves, merges, settings updates, and errors

## Theme System

Visual customization includes:

- Theme mode: dark/light/system
- **30 color themes** (including Ocean, Forest, Nord, Dracula, Gruvbox, Tokyo Night, and more)

Theme preferences are stored in global settings.

## Usage Dialog

Usage view shows provider consumption and limits.

Features:

- Progress bars by provider/model
- Reset window visibility
- Helps diagnose capacity/rate-limit conditions

## Spec Editor

The spec editor lets you edit `PROMPT.md` directly.

Features:

- Manual prompt edits
- AI revision requests
- Rebuild/regenerate flows when task intent changes

## Planning Mode

Planning mode is an AI interview workflow for shaping task scope.

Features:

- Clarification Q&A
- Summary generation
- Two final actions: **Create Task** or **Break into Tasks**
- Multi-task creation uses key deliverables and dependency linking

### Session Lifecycle

- **Send to Background** — Hides the modal but preserves the session server-side. The session continues running and can be resumed from the Background Sessions panel.
- **Close (X button or Escape)** — Explicitly abandons the session on the server. The AI stops processing and the session is terminated. Use this when you want to cancel without saving progress.
- **Session Persistence** — Planning sessions that are actively running (generating, awaiting input, complete, or error) appear in the Background Sessions panel and can be resumed.

## Subtask Breakdown Dialog

The subtask dialog supports structured decomposition before creation.

Features:

- AI-generated subtasks
- Drag-and-drop reordering
- Keyboard reordering controls
- Dependency linking constrained to earlier items

### Session Lifecycle

- **Send to Background** — Hides the modal but preserves the session server-side. The session continues running and can be resumed from the Background Sessions panel.
- **Close (X button or Cancel)** — Explicitly abandons the session on the server. The AI stops processing and the session is terminated. Confirmation is shown if there are unsaved changes.

## Settings Modal

Central place for model/provider config, execution behavior, notifications, backups, and UI preferences.

![Settings modal](./screenshots/settings.png)

## Workflow Step Manager

Create and manage reusable quality gates for tasks.

![Workflow step manager](./screenshots/workflow-steps.png)

## Agents View

Inspect agents, runtime status, run history, and configuration.

![Agents view](./screenshots/agents-view.png)

## Mission Manager

Manage mission hierarchy and progression state.

![Mission manager](./screenshots/mission-manager.png)

## Task Detail Modal

Inspect logs, step progress, workflow outcomes, and model overrides.

![Task detail modal](./screenshots/task-detail.png)

## Node Dashboard

The Node Dashboard provides a mesh view of connected Fusion nodes. Each node can be a local instance or a remote headless node (`fn serve`).

### Local/Remote Node Switching

When remote nodes are available, the dashboard header displays a node status indicator:

- **Local mode** — Shows a green "Local" badge, indicating the dashboard is connected to the local Fusion instance
- **Remote mode** — Shows the remote node name with its connection status (online/offline/connecting)

Click the chevron next to the status indicator to open the node selector dropdown:

- **Local** — Switch back to viewing the local Fusion instance
- **Remote nodes** — Select a remote node to view its tasks, projects, and status

### How Node Switching Works

1. The node selector appears in the header when remote nodes are registered in the mesh
2. Selecting a remote node routes all API calls through the proxy endpoint (`/api/proxy/:nodeId/...`)
3. Task data (projects, tasks) is fetched from the remote node and displayed in the dashboard
4. SSE events from the remote node are streamed via the proxy and update the dashboard in real-time
5. Selecting "Local" returns to the local Fusion instance with full local data

### Benefits of Remote Node Viewing

- Monitor task progress across distributed teams
- View task status on remote headless nodes without direct SSH access
- Compare project health across multiple Fusion instances
- Stay informed about remote agent activity and task completion

### Node Status Indicators

| Status | Color | Meaning |
|--------|-------|---------|
| Online | Green | Node is connected and responsive |
| Offline | Red | Node is unreachable or shut down |
| Connecting | Yellow (pulsing) | Connection attempt in progress |

### Persistence

The selected node persists across browser sessions via localStorage. If the selected remote node is unregistered, the dashboard automatically falls back to local mode.
