# Dashboard Guide

[← Docs index](./README.md)

The Fusion dashboard is the main control plane for tasks, agents, missions, settings, logs, and repository operations.

## Browser Navigation

The dashboard now handles browser back navigation consistently on desktop and mobile.
Using Back will first dismiss open modals and then step back through in-app view changes (for example, task detail → board) before leaving the app.
This behavior used to be mobile-only, and now applies across all viewports.

## Board View

Board view is the kanban surface for day-to-day operation.

Features:

- Drag-and-drop between lifecycle columns
- Search/filter tasks (including working-branch and base-branch dropdown filters with explicit **No working branch** / **No base branch** options)
- Working-branch and base-branch filter selections are persisted per project and restored across refresh/navigation
- Column visibility controls
- Inline quick entry creation
- PR/issue badges with live updates
- GitHub provenance marker on task cards imported from GitHub (`sourceType: github_import`), shown alongside existing footer metadata like timers
- Agent-created provenance badge in task card headers for agent-originated tasks (`sourceType: agent_heartbeat` or `sourceType: automation`, or legacy tasks with `sourceAgentId`), with labels preferring `sourceMetadata.agentName` over raw agent IDs
- Column ordering semantics: `todo` mirrors scheduler pickup order (priority descending, then oldest `createdAt`, then task ID); `triage`, `in-progress`, `in-review`, and `archived` remain priority-first with task-ID tie-breaks; `done` is ordered by most recent completion first (`columnMovedAt`, then `updatedAt`, then `createdAt` fallback)

![Board view](./screenshots/dashboard-overview.png)

## List View

List view is optimized for dense task management.

Features:

- Sectioned task table grouped by lifecycle column
- Sortable columns (ID/title/status/column)
- Column visibility toggles and optional hide-done filtering
- Bulk selection + batch model updates

![List view](./screenshots/list-view.png)

## Graph View

Graph view visualizes task dependencies as an interactive node/edge map.

Navigation:
- Desktop: **Header → More views → Graph**
- Mobile: **MobileNavBar → More → Graph**

Behavior:
- Shows only tasks in `triage`, `todo`, `in-progress`, and `in-review`
- Excludes `done` and `archived`
- Uses Sugiyama-style layered auto-layout to place nodes by dependency depth
- Renders directed bezier dependency edges (dependent → dependency) with arrowheads
- Supports cursor-centered wheel zoom, pinch zoom, keyboard shortcuts (`Ctrl/Cmd+=`, `Ctrl/Cmd+-`, `Ctrl/Cmd+0`, `Ctrl/Cmd+Shift+F`, `Escape`), and fit/reset controls via the floating toolbar with live zoom percentage
- Dependency graph nodes reuse the same `TaskCard` UI as board/list views, so status badges, progress/steps, mission badges, retry/archive controls, and active-task glow stay visually consistent
- Active graph nodes also add a dedicated top status indicator bar and current-step row highlighting so in-progress execution state stays visible even when zoomed out

## Chat View

Chat view provides project-scoped conversations with agents.

- Entering `/clear` (exact match after trimming) in the composer starts a fresh thread for the current chat target instead of sending the literal command to the model
- On mobile, the New Chat and Delete Conversation dialogs use a compact inset treatment (centered, viewport-bounded, internally scrollable) instead of the app's default full-height mobile modal chrome.
- Full Chat and Quick Chat both consume the same streamed `/api/chat/sessions/:id/messages` response contract, and both now prefer the authoritative assistant `message` snapshot on `done` while still accumulating `text` chunks when present (so providers without incremental text streaming still render output immediately)
- Chat message lists now track near-bottom scroll state: while you are reading older messages, live streaming/new replies do not force-scroll; a **Latest** jump control appears until you return to the tail.
- On mobile (`max-width: 768px`), chat bubbles are slightly wider in full Chat for improved readability while preserving header/composer gutters.
- Full Chat tool-call summaries now use a denser mobile layout: grouped and single-call collapsed rows keep icon + label + status on one line (Quick Chat-style scanability) while expanded details remain unchanged.
- The desktop Chat view toggle and mobile Chat tab now show an unread-response indicator when a live assistant reply arrives for your active chat thread after you leave Chat; opening Chat clears it immediately.
- Agent-backed chat sessions now expose the same mailbox messaging tools (`fn_send_message`, `fn_read_messages`) used by runtime execution/heartbeat flows whenever the engine `MessageStore` is available; model-only chats continue to run without mailbox tools.

![Chat view](./screenshots/chat-view.png)

## Quick Chat

Quick Chat is an optional floating panel for fast, project-scoped assistant conversations without leaving your current view.

- Controlled by the project setting `showQuickChatFAB`
- Supports agent mentions (`@agent`) and file mentions
- Uses the same model/provider infrastructure as full Chat view
- On small screens, compact tool-call summaries in the floating panel intentionally stay single-line (count + tool names + status) to preserve message density
- The panel header uses a session-first flow: the main dropdown lists persisted sessions (preferring `session.title`, then falling back to deterministic `Session N` labels)
- Selecting a session from that dropdown resumes the persisted conversation; this keeps `switchSession()` resume-oriented rather than forcing a new thread
- Entering `/clear` (exact match after trimming) in the Quick Chat composer uses explicit fresh-session creation for the currently selected target (`startFreshSession()`), so the current thread resets without sending `/clear` to the model
- The `+` action opens an inline new-session chooser (inside the panel, not a modal) with `Model` selected by default and optional switch to `Agent`
- Submitting the inline chooser uses explicit fresh-session creation and immediately persists/selects the new thread, then refreshes the session dropdown list
- Resume lookups still use targeted session queries instead of loading the full active-session list first
- Tool-call summaries in the floating quick-chat panel are intentionally condensed into a single-line header row (especially on small screens) so tool name + status stay scannable without multi-line wrapping
- On mobile viewports, opening Quick Chat auto-focuses the composer as soon as it is ready so the keyboard opens immediately
- FAB dragging uses pointer events with document-level move/up tracking and a 5px drag threshold so Android touch drags reposition reliably while short taps still open Quick Chat
- Quick Chat now mirrors full Chat tail behavior: if you scroll up, live updates stop auto-following and a **Latest** jump control appears until you jump back down.
- On mobile, Quick Chat bubbles are slightly wider while keeping compact tool-call summary layout and full-screen/safe-area behavior intact.

## Mailbox View

Mailbox view shows inbox/outbox communication threads and unread state.

- Inbox renders one row per message (no sender-based collapsing)
- Visible message history/threading is driven by explicit `message.metadata.replyTo.messageId` links
- Separate top-level messages from the same sender remain independent in the inbox and detail pane

![Mailbox view](./screenshots/mailbox-view.png)

## Interactive Terminal

Fusion embeds a terminal using xterm.js.

Features:

- Multiple terminal tabs
- PTY-backed shell sessions
- Mobile-aware virtual keyboard handling and auto-refit behavior
- Reopen/reconnect/session-recovery flows preserve single-keystroke input forwarding (no duplicate characters, no page refresh required)

![Interactive terminal](./screenshots/terminal.png)

## Git Manager

Git manager centralizes repo operations in the dashboard.

Features:

- Branch/worktree visibility
- Commit and diff browsing
- Push/pull/fetch actions
- Remote editing controls
- Stash inspection (view stat + patch) before apply/pop/drop actions
- Remotes tab keeps "Recent commits on {remote}" in sync immediately after successful push/pull actions

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

## Todo View

Todo View is an experimental dashboard surface for managing per-project todo lists and turning items into planning or task workflows.

> Available when `experimentalFeatures.todoView` is enabled.

Navigation:
- Desktop: **Header → More views → Todos** (single canonical desktop entry)
- Mobile: **More** sheet → **Todos**

For full behavior, API contracts, and storage details, use the canonical [Todo View guide](./todo-view.md).

## Research View

Research view is a standalone dashboard surface for creating and managing research runs.

> Available when `experimentalFeatures.researchView` is enabled.
> The related Settings sections (`Research Defaults` and project `Research`) are also hidden until this flag is enabled.

Features:

- Create-run form with required query text and selectable provider options
- Searchable run history list with project-scoped state
- Selected-run reader with summary, citations, findings, and run event history
- Run lifecycle controls: cancel, retry, and refresh
- Export actions for supported formats (`markdown`, `json`, `html` as advertised by backend availability)
- Task-facing actions to create a new task from findings or attach findings to an existing task
- Graceful unavailable/setup messaging when research backend capability is disabled or not configured

Navigation:
- Desktop: **Header → More views** overflow menu
- Mobile: **More** sheet in `MobileNavBar`
- Research is intentionally not shown in the primary board/list/agents/missions/chat toggle row

For the full research workflow, provider setup, CLI commands, API reference, and agent integration, see the canonical [Research guide](./research.md).

## Files Modal

The Files modal provides a workspace-aware file browser and editor.

- Source/text editing supports a **Line #** header toggle to show or hide line numbers in the editor gutter
- The line-number preference is saved per project and restored automatically when you switch projects

## Memory View

Memory view provides a multi-file editor for project and daily memory files.

> Available when the `experimentalFeatures.memoryView` toggle is enabled.

![Memory view](./screenshots/memory-view.png)

## Agents View

Agents view is the control surface for runtime agents and team structure.

Navigation:
- Desktop: primary view toggle (**Agents**)
- Mobile: bottom nav tab (**Agents**)

Features:
- Switch between **List**, **Board**, and **Org chart** layouts
- Filter by role/state, include/exclude system agents, and inspect health/status
- Start, pause, stop, and trigger agent runs from the view and from detail panels
- Open agent detail tabs for runs, logs, read-only mail (agent inbox/outbox), settings/config, tasks, memory, and chain-of-command relationships
- Error indicator on agent list cards when an agent is in the `error` state and has a captured error (`lastError`); select it to open **Agent Error Details**
- Run-level error indicator in **Agent detail → Runs** when a run has captured stderr; select it to open the same **Agent Error Details** modal
- **Agent Error Details** shows full error text plus **Copy** and **Report on GitHub** actions
- **Report on GitHub** opens a pre-filled issue draft with available context from where you launched it (surface plus agent metadata, and run/task IDs when available on that view)
- Jump from agent activity to related task logs, and (when `experimentalFeatures.agentOnboarding` is enabled) launch **AI Interview** from the New Agent dialog (create mode) or Agent detail → Settings (edit mode)

For full lifecycle behavior, runtime/heartbeat settings, and budgets, see [Agents guide](./agents.md).

## Roadmaps View

Roadmaps view manages roadmap hierarchies (roadmaps, milestones, features) and planning handoff exports.

> Available when `experimentalFeatures.roadmap` is enabled.
> Hidden when a plugin replaces Roadmaps navigation.

Navigation:
- Desktop: **Header → More views → Roadmaps**
- Mobile: **More** sheet (or promoted to a top tab when eligible based on mobile nav slot rules)

Features:
- Create, edit, archive/delete, and reorder roadmaps, milestones, and features
- Use inline editing plus drag/drop for milestone and feature organization
- Open roadmap export modal and copy mission/feature planning handoff payloads
- Feed roadmap output into mission/task planning workflows

For mission planning context and handoff structure, see [Missions guide](./missions.md).

## Insights View

Insights view surfaces categorized project insights and lets you turn findings into work.

> Available when `experimentalFeatures.insights` is enabled.

Navigation:
- Desktop: **Header → More views → Insights**
- Mobile: **More** sheet → **Insights**

Features:
- Category-based insight browser with run metadata and status indicators
- Manual insight generation plus refresh actions for latest insight runs
- Dismiss/archive/unarchive insight records as they age
- Create triage tasks from selected insights directly from the view

## Dev Server View

Dev Server view manages detected dev server commands, preview URLs, and live logs for local development.

> Available when `experimentalFeatures.devServerView` is enabled (`devServer` is treated as a legacy alias).

Navigation:
- Desktop: **Header → More views → Dev Server**
- Mobile: **More** sheet → **Dev Server**

Features:
- Detect candidate dev server commands and choose which command/session to run
- Start, stop, and restart the current server session
- Manage preview URLs with embedded preview and **Open in new tab** fallback
- Tail live logs, load older history, and refresh session status

For module-level behavior and API surfaces, see [Dev Server modules](./dev-server-modules.md).

## Plugin Manager

Plugin management lives in **Settings → Plugins → Fusion Plugins**.

Features:
- Install bundled plugins or custom path-based plugins
- Enable/disable plugins, reload active plugins, and uninstall plugins
- Inspect plugin runtime state and transition feedback
- Edit and save plugin-defined settings schemas from the same panel

For full plugin lifecycle workflows (discovery, install, enable/disable, configure, update, uninstall, troubleshooting), see [Plugin Management](./plugin-management.md). For plugin-related settings and experimental toggles, see [Settings reference](./settings-reference.md).

## Pi Extensions Manager

Pi extension management lives in **Settings → Plugins → Pi Extensions**.

Features:
- Add/remove Pi package sources (npm, git, or local)
- Reinstall the Fusion Pi package/skill bundle
- Enable/disable discovered extensions
- Manage extension, skill, prompt, and theme path lists in one place

For related global/project configuration behavior, see [Settings reference](./settings-reference.md).

## Task Detail Modal

Inspect task definition, logs, comments, documents, workflow outcomes, model overrides, and task routing from a single modal.

- The priority chip in task metadata is now an inline picker: you can change priority directly from the chip without entering full edit mode.
- Execution mode now also has a read-mode inline control: a lightning-bolt toggle lets you switch Fast mode on/off from task metadata without opening the full edit form.

### Logs → Agent Log view

The **Logs** tab includes an **Agent Log** subview designed for debugging long-running and tool-heavy sessions:

- Full `thinking`, `tool_result`, and `tool_error` payloads are shown without entry-content truncation.
- Raw tool output is rendered as multiline blocks, preserving line breaks and indentation.
- The initial load fetches a recent page, then **Load More** progressively prepends older history.
- Live streaming appends new entries in chronological order while preserving your scroll position when loading older pages.
- The **Markdown / Plain** toggle lets you switch between formatted markdown and literal/raw text rendering.
- The **Tools: On/Off** toggle shows or hides tool-call rows (`tool`, `tool_result`, `tool_error`) so you can focus on narrative/thinking output when needed.
- Both display preferences persist across sessions via local storage (`fn-agent-log-markdown` and `fn-agent-log-tool-output`).

The **Routing** tab shows:
- effective node
- routing source (task override vs project default vs local)
- unavailable-node policy value
- per-task node override controls (locked while task is active)

Project-wide routing defaults are configured in **Settings → Node Routing**.

![Task detail modal](./screenshots/task-detail.png)

## Node Dashboard

The Node Dashboard provides a mesh view of connected Fusion nodes. Each node can be a local instance or a remote headless node (`fn serve`).

Navigation:
- Desktop: Header node controls / overflow entry
- Mobile: `MobileNavBar` → **More** sheet → **Nodes** (shown only when `experimentalFeatures.nodesView` is enabled)

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

## Native shell connection flow

If you use Fusion from a native shell (mobile app or desktop shell in remote mode), dashboard startup is gated by shell onboarding until a connection is selected.

For the canonical workflow (first-run onboarding, QR/manual setup, saved profiles, and desktop local/remote handoff), see [Native Shell Connection Guide](./native-shell.md).

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

### Launch Points

You can open Agent Import from:
- **Agents view → Controls popup → Import**
- **Agent Detail header → Import** (opens directly to the companies.sh browse catalog)

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
