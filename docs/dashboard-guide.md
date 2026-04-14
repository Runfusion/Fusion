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
- **54 color themes** (including Ocean, Forest, Nord, Dracula, Gruvbox, Tokyo Night, and more)

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

### Agent Skill Assignment

Agents can be assigned skills that determine which capabilities are injected into their sessions at execution time. Skills are configured via the agent's `metadata.skills` field—an array of skill names such as `["review", "executor"]`.

You can set `metadata.skills` in two ways:
- **Dashboard**: Edit an agent and add or update the `skills` key in its metadata JSON.
- **Import**: When importing agents from YAML, the `skills` list is mapped to `metadata.skills` automatically.

During task execution, the engine's `buildSessionSkillContext` reads `metadata.skills` from the assigned agent. If valid skills are present, they take **precedence** over the default role fallback skills (e.g., `executor`, `reviewer`, `merger`, `triage`). If no skills are assigned, the engine falls back to the standard role-based skill mapping.

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

## Skills API

The Skills API provides endpoints for managing execution skills. Skills are toggled via project-scoped settings in `.fusion/settings.json`.

### GET /api/skills/discovered

List all discovered skills with their enabled state.

**Response:** `200 OK`
```json
{
  "skills": [
    {
      "id": "npm%3A%40example%2Fskill::skills/foo/SKILL.md",
      "name": "foo/SKILL.md",
      "path": "/path/to/skills/foo/SKILL.md",
      "relativePath": "skills/foo/SKILL.md",
      "enabled": true,
      "metadata": {
        "source": "npm:@example/skill",
        "scope": "project",
        "origin": "package"
      }
    }
  ]
}
```

**Skill ID Format:** `encodeURIComponent(metadata.source) + "::" + relativePath`
- Top-level skills use `source: "*"`
- Package skills use the package source identifier

**Error Response:** `404 Not Found`
```json
{
  "error": "Skills adapter not configured",
  "code": "adapter_not_configured"
}
```

### PATCH /api/skills/execution

Toggle a skill's enabled/disabled state.

**Request Body:**
```json
{
  "skillId": "npm%3A%40example%2Fskill::skills/foo/SKILL.md",
  "enabled": true
}
```

**Response:** `200 OK`
```json
{
  "success": true,
  "skillId": "npm%3A%40example%2Fskill::skills/foo/SKILL.md",
  "enabled": true,
  "persistence": {
    "scope": "project",
    "targetFile": "/path/to/.fusion/settings.json",
    "settingsPath": "packages[].skills",
    "pattern": "+skills/foo/SKILL.md"
  }
}
```

**Toggle Semantics:**
- **Top-level skills** (`origin: "top-level"`): Mutate `settings.skills`
  - Enable: ensures `+<relativePath>` exists, removes `-<relativePath>`
  - Disable: ensures `-<relativePath>` exists, removes `+<relativePath>`
- **Package skills** (`origin: "package"`): Mutate `settings.packages[].skills` for the matching `metadata.source`
  - If the package entry is a string, it's converted to an object `{ source: <same>, skills: [] }`
  - Other package fields (`extensions`, `prompts`, `themes`) are preserved

**Error Responses:**
- `400 Bad Request` — Invalid request body
  ```json
  { "error": "skillId is required", "code": "invalid_body" }
  ```
- `404 Not Found` — Adapter not configured
  ```json
  { "error": "Skills adapter not configured", "code": "adapter_not_configured" }
  ```

### GET /api/skills/catalog

Fetch the skills.sh catalog with optional authentication.

**Query Parameters:**
- `limit` (optional): Number of results (default 20, max 100)
- `q` (optional): Search query string

**Response:** `200 OK`
```json
{
  "entries": [
    {
      "id": "example-skill",
      "slug": "example-skill",
      "name": "Example Skill",
      "description": "An example skill",
      "tags": ["utility"],
      "installs": 100,
      "installation": {
        "installed": true,
        "matchingSkillIds": ["npm%3A%40example%2Fskill::skills/example/SKILL.md"],
        "matchingPaths": ["skills/example/SKILL.md"]
      }
    }
  ],
  "auth": {
    "mode": "unauthenticated",
    "tokenPresent": false,
    "fallbackUsed": false
  }
}
```

**Authentication Flow:**
1. If `SKILLS_SH_TOKEN` env var is present, use authenticated request
2. If authenticated request returns `401/403`, retry without authentication (fallback mode)
3. If no token, use unauthenticated request directly

**Auth Mode Values:**
- `authenticated` — Request made with token
- `unauthenticated` — Request made without token (no token available)
- `fallback-unauthenticated` — Initial authenticated request failed with 401/403, retried without token

**Error Response:** `502 Bad Gateway`
```json
{
  "error": "Upstream request timed out",
  "code": "upstream_timeout"
}
```

Possible error codes:
- `upstream_timeout` — Request timed out
- `upstream_http_error` — Upstream returned an error status
- `upstream_invalid_payload` — Upstream returned invalid response format
