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

- Sectioned task table grouped by lifecycle column
- Sortable columns (ID/title/status/column)
- Column visibility toggles and optional hide-done filtering
- Bulk selection + batch model updates

![List view](./screenshots/list-view.png)

## Chat View

Chat view provides project-scoped conversations with agents.

![Chat view](./screenshots/chat-view.png)

## Quick Chat

Quick Chat is an optional floating panel for fast, project-scoped assistant conversations without leaving your current view.

- Controlled by the project setting `showQuickChatFAB`
- Supports agent mentions (`@agent`) and file mentions
- Uses the same model/provider infrastructure as full Chat view
- `switchSession()` resumes the existing thread for the selected target (agent-only or agent+model)
- `startFreshSession()` is the explicit new-thread action and always creates a new persisted session
- Resume lookups use a targeted session query instead of loading the full active session list first
- Tool-call summaries in the floating quick-chat panel are intentionally condensed into a single-line header row (especially on small screens) so tool name + status stay scannable without multi-line wrapping

## Mailbox View

Mailbox view shows inbox/outbox communication threads and unread state.

![Mailbox view](./screenshots/mailbox-view.png)

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

## Documents View

Documents view aggregates task documents and project markdown files.

Features:

- Group task documents by task ID (with revision history metadata)
- Search documents across tasks
- Open project markdown files with inline preview
- Jump directly from a document group to the owning task detail modal
- Toggle between raw text and rendered markdown using the **Markdown/Plain** button

![Documents view](./screenshots/documents-view.png)

### Markdown Rendering

Documents view supports toggling between raw text and formatted markdown when viewing document content:

- **Raw mode** (default): Shows markdown syntax as plain text (e.g., `**bold**`)
- **Markdown mode**: Renders markdown with proper formatting (e.g., **bold**, headings, lists, tables)

The toggle button is accessible with `aria-pressed` for screen readers. Toggle state is scoped per-document, so switching between documents resets the view to raw mode.

## Memory View

Memory view provides a multi-file editor for project and daily memory files.

> Available when the `experimentalFeatures.memoryView` toggle is enabled.

![Memory view](./screenshots/memory-view.png)

## Task Detail Modal

Inspect task definition, logs, comments, documents, workflow outcomes, model overrides, and task routing from a single modal.

The **Routing** tab shows:
- effective node
- routing source (task override vs project default vs local)
- unavailable-node policy value
- per-task node override controls (locked while task is active)

Project-wide routing defaults are configured in **Settings → Node Routing**.

![Task detail modal](./screenshots/task-detail.png)

## Node Dashboard

The Node Dashboard provides a mesh view of connected Fusion nodes. Each node can be a local instance or a remote headless node (`fn serve`).

![Nodes view](./screenshots/nodes-view.png)

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

## Remote Access (Settings)

Dashboard remote controls live in **Settings → Remote Access**.

From this section, operators can:

- Configure Tailscale and Cloudflare provider fields
- Activate the current provider
- Start/stop tunnel lifecycle manually
- Generate login URLs / QR payloads using persistent or short-lived token mode

For setup prerequisites, security caveats for tokenized URLs/QR links, and troubleshooting, use the canonical **[Remote Access runbook](./remote-access.md)**.

## Skills API

The Skills API provides endpoints for managing execution skills. Skills are toggled via project-scoped settings in `.fusion/settings.json`.

![Skills view](./screenshots/skills-view.png)

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

### GET /api/skills/:id/content

Fetch a skill's `SKILL.md` content and supplementary file metadata.

**Response:** `200 OK`
```json
{
  "content": {
    "name": "foo/SKILL.md",
    "skillMd": "# Foo Skill\n...",
    "files": [
      {
        "name": "examples",
        "relativePath": "skills/foo/examples",
        "type": "directory"
      },
      {
        "name": "example.ts",
        "relativePath": "skills/foo/examples/example.ts",
        "type": "file"
      }
    ]
  }
}
```

**Error Responses:**
- `400 Bad Request` — invalid encoded skill ID (`code: "invalid_skill_id"`)
- `404 Not Found` — skill not found (`code: "skill_not_found"`) or adapter missing (`code: "adapter_not_configured"`)

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
2. If authenticated request returns `400/401/403`, retry without authentication (fallback mode)
3. If no token, use unauthenticated request directly

**Unauthenticated Short-Query Behavior:**
- Public `skills.sh /api/search` requests are only sent when `q` has at least 2 characters
- For omitted, empty, or 1-character queries, the API returns `200` with `{ entries: [] }`
- This applies both to direct unauthenticated mode and authenticated-to-unauthenticated fallback mode, preventing upstream `400 Bad Request` responses during initial load

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

## Agent Import

The Agent Import feature allows you to import agents from Agent Companies packages. When importing agents from companies.sh or local directories, Fusion now also persists any skill definitions from the package.

### How It Works

1. **Select Source**: Choose to import from:
   - The companies.sh catalog (browse and search)
   - A local directory containing AGENTS.md files
   - A single manifest file (.md or .txt)
   - Paste manifest content directly

2. **Preview**: Review the agents and skills that will be imported before confirming

3. **Import**: Upon confirmation:
   - Agents are created in Fusion's agent store
   - Skills are persisted to `skills/imported/{companySlug}/{skillSlug}/SKILL.md`
   - Each skill's `SKILL.md` contains YAML frontmatter with skill metadata and the instruction body

### Skill Persistence

Skills from Agent Companies packages are persisted to the project-local skills directory:

```
{projectRoot}/
  skills/
    imported/
      {companySlug}/          # slugified company name or "unknown-company"
        {skillSlug}/          # slugified skill name
          SKILL.md            # skill manifest with frontmatter + instructions
```

**Collision Handling**: If a `SKILL.md` file already exists at the target path, the import skips that skill (does not overwrite). This prevents accidental data loss.

**Path Safety**: All path segments are slugified to prevent directory traversal attacks. Special characters are removed and whitespace is normalized to hyphens.

### Import Result

The import result shows:

**Agents:**
- Number of agents created
- Number of agents skipped (already exist)
- Number of errors (import failures)

**Skills:**
- Number of skills imported (written to disk)
- Number of skills skipped (already exist)
- Number of skill errors (write failures)

### API Response

The `POST /api/agents/import` endpoint returns skill import results:

```json
{
  "companyName": "Example Co",
  "companySlug": "example-co",
  "created": [{ "id": "agent-1", "name": "CEO" }],
  "skipped": [],
  "errors": [],
  "skillsCount": 3,
  "skills": {
    "imported": [
      { "name": "review", "path": "skills/imported/example-co/review/SKILL.md" },
      { "name": "strategy", "path": "skills/imported/example-co/strategy/SKILL.md" }
    ],
    "skipped": [],
    "errors": []
  }
}
```

The `skills` object contains detailed import outcomes for each skill from the package.
