# Dashboard Guide

[← Docs index](./README.md)

The Fusion dashboard is the main control plane for tasks, agents, missions, settings, logs, and repository operations.

## Browser Navigation

The dashboard now handles browser back navigation consistently on desktop and mobile.
Using Back will first dismiss open modals and then step back through in-app view changes (for example, task detail → board) before leaving the app.
This behavior used to be mobile-only, and now applies across all viewports.

## Deep Links

Use deep links to open a specific task directly from notifications, chat, or external tools.

- `/tasks/<TASK_ID>` (for example, `/tasks/FN-1234`) opens that task, and can include `?project=<project-id>` for multi-project routing.
- `/?task=<TASK_ID>[&project=<project-id>]` is the canonical in-app form and opens the task detail modal on load.
- Legacy path-style links (including trailing-slash forms like `/tasks/<TASK_ID>/` and older hash-style entry points that resolve to that path) are normalized client-side to the canonical query form with `history.replaceState`, so the URL updates without a full reload.
- In non-headless dashboard mode, the server also issues an HTTP 301 redirect from `/tasks/<TASK_ID>` to `/?task=<TASK_ID>` and preserves `?project=` when present.
- Theme assets resolve `theme-data.css` against the current document base (HTTP/HTTPS, `file://`, and Electron fallback paths), so non-default themes still load correctly when you land on deep-linked or sub-path URLs.
- Configure `dashboardHost` and `ntfyDashboardHost` in [settings reference](./settings-reference.md) so generated notification links use the correct base URL.

```text
/tasks/FN-1234
/?task=FN-1234
/?task=FN-1234&project=my-project
```

## Clickable File Paths

File paths in dashboard text are automatically rendered as inline links. Clicking a linked path opens the Files browser modal at that path (including line/column targets when available) so you can inspect the file and use editor actions where supported.

Current surfaces include:
- Task detail modal content (description markdown, **Review** tab, and **Workflow Results** tab output)
- Chat view messages/tool output
- Agent log viewer
- Activity log modal
- Dev Server log viewer
- Settings sync log

Only detected file-path text is linkified; non-path text remains plain. Linked paths must resolve within the current project workspace to open successfully.

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
- Bulk Pause / Unpause / Archive actions from the selection toolbar (`Pause selected`, `Unpause selected`, `Archive selected`) for fast batch task state management.
- Bulk delete from the selection toolbar (`Delete selected`): archived selections are skipped automatically, and dependency-conflict failures can be force-deleted per task after a danger confirmation that removes dependency references.

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
- Pan limits are zoom-aware and based on full graph extents (including negative auto-layout origins), so zoomed-in views can still pan to every rendered node instead of getting trapped by fixed viewport-only bounds
- Dependency graph nodes reuse the same `TaskCard` UI as board/list views, so status badges, progress/steps, mission badges, retry/archive controls, and active-task glow stay visually consistent
- Active graph nodes also add a dedicated top status indicator bar and current-step row highlighting so in-progress execution state stays visible even when zoomed out
- Clicking a graph card opens task details via the host detail handler (`onOpenDetail`, with `onOpenTaskDetail` fallback), while clicking the same card again or empty canvas clears selection
- On touch devices, single-tap is reserved for pan/drag gestures, so double-tapping a node opens its task detail modal; this does not change selection state.
- Hovering or selecting a node highlights its full upstream and downstream dependency chain; highlighted nodes and connecting edges are emphasized while non-chain nodes are dimmed, and highlight clears when hover/selection is removed
- Nodes support manual drag repositioning with a 4px movement threshold to separate click from drag, using pointer capture and zoom-aware delta scaling for reliable tracking
- Custom node positions persist per project in browser localStorage (`kb:${projectId}:fusion-plugin-dependency-graph:positions`) across refresh/project switches, and **Fit to graph** clears saved positions and restores auto-layout

## Chat View

Chat view provides project-scoped conversations with agents.

- Entering `/new` or `/clear` (exact match after trimming) in the composer starts a fresh thread for the current chat target instead of sending the literal command to the model
- On mobile, the New Chat and Delete Conversation dialogs use a compact inset treatment (centered, viewport-bounded, internally scrollable) instead of the app's default full-height mobile modal chrome.
- Full Chat and Quick Chat both consume the same streamed `/api/chat/sessions/:id/messages` response contract, and both now prefer the authoritative assistant `message` snapshot on `done` while still accumulating `text` chunks when present (so providers without incremental text streaming still render output immediately)
- In-progress assistant responses now survive refresh/navigation while generation is still active: Chat restores the last durable in-flight text/thinking/tool state immediately, then resumes streaming from the stored replay point instead of starting from an empty "Connecting…" placeholder.
- If a regular Chat stream drops with a hidden-tab/browser-suspension error (for example `Load failed`) while the server is still generating, Chat suppresses the false error banner, re-attaches to the in-progress stream using the durable replay state, and reconciles the final assistant reply when generation completes.
- Chat message lists now track near-bottom scroll state: while you are reading older messages, live streaming/new replies do not force-scroll; a **Latest** jump control appears until you return to the tail.
- On mobile direct-chat threads, entering a thread and restoring Chat after tab/page visibility returns re-anchors to the newest message (`scrollTop = scrollHeight`) so the view always opens at the live tail.
- On mobile direct-chat threads, tapping the active title/identity in the thread header opens a lightweight conversation dropdown so you can switch to another direct session without backing out to the sidebar list first; long conversation titles now stay readable in the dropdown via wrapped option text and taller touch-friendly rows.
- On mobile (`max-width: 768px`), chat bubbles are slightly wider in full Chat for improved readability while preserving header/composer gutters.
- Full Chat tool-call summaries now use a denser mobile layout: grouped and single-call collapsed rows keep icon + label + status on one line (Quick Chat-style scanability) while expanded details remain unchanged.
- The desktop Chat view toggle and mobile Chat tab now show an unread-response indicator when a live assistant reply arrives for your active chat thread after you leave Chat; opening Chat clears it immediately.
- Agent-backed chat sessions now expose the same mailbox messaging tools (`fn_send_message`, `fn_read_messages`) used by runtime execution/heartbeat flows whenever the engine `MessageStore` is available; model-only chats continue to run without mailbox tools.

![Chat view](./screenshots/chat-view.png)

### Chat Rooms

Chat Rooms are project-scoped group conversations for multiple agents. They are separate from one-on-one direct chat sessions.

- Chat Rooms are currently gated behind the `chatRooms` experimental feature flag. Enable it in **Settings → Experimental Features → Chat Rooms**.
- Use the **Direct / Rooms** toggle in the Chat sidebar to switch scopes. The selected scope is saved and restored the next time you open Chat.
- In **Rooms**, click **Create room** to open the room-creation modal.
- Room names follow strict validation: a leading `#` is removed automatically, names must be lowercase, up to 80 characters, use only `a-z`, `0-9`, `-`, or `_`, cannot start or end with `-`/`_`, and must be unique in the current project.
- The modal includes a member picker with search + multi-select from project agents. You must pick at least one member before creating the room.
- Members are currently chosen during room creation. The shipped UI does not yet provide full post-creation member management in Chat View.
- Each room row includes a trash action (`aria-label="Delete room {name}"`, `data-testid="chat-room-delete-{slug}"`) that opens a **Delete Room?** confirmation dialog with **Cancel** and **Delete** actions.
- Confirming delete calls `rooms.deleteRoom(roomId)` and permanently removes the room and its messages ("This action cannot be undone. This room and all its messages will be permanently deleted."); failures surface a `Failed to delete room` toast.
- Selecting a room opens the room thread pane with loading and empty states, then renders room messages from `rooms.messages` as `ChatMessageInfo` entries in the same thread UI used for direct Chat.
- Submitting the room composer calls `rooms.sendRoomMessage(...)`, which immediately inserts a temporary local user message and then posts to `POST /api/chat/rooms/:id/messages`.
- The room composer clears immediately when send is dispatched so the user gets instant feedback; on success the optimistic message is reconciled with persisted server data and the transcript is refreshed to authoritative history.
- On mobile, room threads use the same keyboard-aware thread anchoring as direct chat, keeping the composer pinned above the soft keyboard while typing.
- The dashboard backend now orchestrates room responders on that POST: mentioned members are routed as direct responders, additional ambient members may reply (up to the room ambient responder cap), and each assistant reply is persisted with `senderAgentId` via `chatStore.addRoomMessage(...)`.
- If room replies cannot be generated (for example no resolvable responders or all responders fail), the POST fails with an API error (HTTP 502) instead of silently returning only the user message.
- If room responders cannot be resolved or all room-reply generations fail, the POST now returns an error instead of silently succeeding with only the user message, so failures are surfaced deterministically.
- Room responder prompt construction now keeps the most recent room messages verbatim and, when the room runs long, prepends a compacted summary of older history (span, participants, and key highlights) plus an explicit latest-user-message marker so replies stay thread-aware without unbounded prompt growth.
- On send failure, `useChatRooms` rolls back/reconciles optimistic state and rethrows; `ChatView` catches once, restores the exact pre-send composer text for retry/edit, and surfaces a single error toast (no duplicate hook+view notifications).
- After each send attempt, the room transcript still re-fetches authoritative messages so persisted user/assistant replies remain visible even when SSE delivery is delayed, and `chat:room:message:*` SSE updates continue live fan-out.
- Relationship summary: direct Chat runs one target (agent or model) per session; rooms are shared threads with multiple agent members and now use the same message contract as direct Chat; Quick Chat is still a floating panel, but when a room is selected it now reads/writes that room thread directly.
- For backend details, see the [Chat Room REST API reference](./architecture.md#real-time-channels) and the [chat room storage schema (`chat_rooms`, `chat_room_members`, `chat_room_messages`)](./storage.md#chat-rooms-migration-70).

## Quick Chat

Quick Chat is an optional floating panel for fast, project-scoped assistant conversations without leaving your current view.

- Controlled by the project setting `showQuickChatFAB`
- Supports agent mentions (`@agent`) and shared `#` task/file mentions
- Uses the same model/provider infrastructure as full Chat view
- On small screens, compact tool-call summaries in the floating panel intentionally stay single-line (count + tool names + status) to preserve message density
- The panel header uses a session-first flow: the main dropdown lists persisted sessions (preferring `session.title`, then falling back to deterministic `Session N` labels)
- Selecting a session from that dropdown resumes the persisted conversation; this keeps `switchSession()` resume-oriented rather than forcing a new thread
- Entering `/new` or `/clear` (exact match after trimming) in the Quick Chat composer clears the active thread target: direct/model targets use `startFreshSession(...)`, while room targets call `rooms.clearRoom(activeRoom.id)`.
- The `+` action opens an inline new-session chooser (inside the panel, not a modal) with `Model` selected by default and optional switch to `Agent`
- Submitting the inline chooser uses explicit fresh-session creation and immediately persists/selects the new thread, then refreshes the session dropdown list
- On every open, Quick Chat restores the most recently used non-archived session by latest activity (`max(lastMessageAt, updatedAt)`); only when no prior session exists does it fall back to the first agent / configured default model.
- Resume lookups still use targeted session queries instead of loading the full active-session list first
- Tool-call summaries in the floating quick-chat panel are intentionally condensed into a single-line header row (especially on small screens) so tool name + status stay scannable without multi-line wrapping
- On mobile viewports, opening Quick Chat auto-focuses the composer as soon as it is ready so the keyboard opens immediately
- FAB dragging uses pointer events with document-level move/up tracking and a 5px drag threshold so Android touch drags reposition reliably while short taps still open Quick Chat
- Quick Chat now mirrors full Chat tail behavior: if you scroll up, live updates stop auto-following and a **Latest** jump control appears until you jump back down.
- On mobile, Quick Chat re-anchors to the newest message whenever the panel is opened/reopened and when page visibility is restored, while still preserving the near-bottom gate so intentional scroll-away keeps **Latest** jump behavior.
- On mobile, Quick Chat bubbles are slightly wider while keeping compact tool-call summary layout and full-screen/safe-area behavior intact.

## Mailbox View

Mailbox view shows inbox/outbox communication threads and unread state.

- Inbox renders one row per message (no sender-based collapsing)
- clicking a message in the Mail tab opens the task detail pane with full message content and conversation context
- reply rows in the mailbox modal can expand inline to show the replied-to message context for easier thread reading
- mailbox now includes an **Approvals** tab with pending and history filters (`approved` / `denied` / `completed`), approval detail context, and inline approve/deny actions for pending requests
- in the **Agents** tab, the agent selector now includes **All agents**, which shows one combined agent-to-agent stream (with sender + recipient labels); selecting a specific agent still shows Inbox/Outbox subtabs
- mailbox entry points now show pending-approval indicators: Header mailbox toggle dot, Header overflow mailbox badge, Mobile mailbox tab dot, and Mobile More → Mailbox badge
- approval lifecycle SSE events (`approval:requested`, `approval:updated`, `approval:decided`) trigger mailbox approvals refresh without manual reload
- when a task newly enters `awaiting-approval`, the app shows a persistent approval banner above project content with an **Open Mailbox** CTA; dismissals are remembered per approval item until that item advances or a different one arrives
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
- Pull with rebase option (split-button chooses between `git pull` and `git pull --rebase`)
- Remote editing controls
- Stash inspection (view stat + patch) before apply/pop/drop actions
- Remotes tab keeps "Recent commits on {remote}" in sync immediately after successful push/pull actions

![Git manager](./screenshots/git-manager.png)

## Merge Advance Notice

Merge Advance Notice is a global banner (`MergeAdvanceNotice`) mounted in the main app chrome that appears when the integration branch advances.

When it appears:
- Reacts to `task:merged` SSE events
- Hydrates from `GET /api/tasks/merge-advance-events`
- Shows the latest merge-advance event for the current project

What it shows:
- Integration branch name and the new tip short SHA
- Advancing task ID and advance metadata from the event payload (`advanceMode`, `refName`, SHA details)
- Checkout-state warnings when your current worktree is dirty or has untracked files

How to react:
- Click **Pull** to run Smart Pull (`POST /api/git/smart-pull`), including the stash-conflict flow in `StashConflictModal` when needed
- Use the dismiss close button to hide the notice
- Treat dirty/untracked warnings as a hint that local changes may be auto-stashed during pull

Push follow-up (when shown):
- If the integration branch is ahead of `origin`, the banner can show push controls with ahead count
- Use **Push to origin** (or force-with-lease via **Advanced**) to publish the advanced branch tip
- If push is rejected (`rejected-non-ff` / `sha-mismatch`), the banner offers a Smart Pull retry path

Branch names are dynamic from merge/audit payloads; the banner is not hardcoded to `main`.

## Smart Pull

Smart Pull is a one-shot pull workflow that keeps local work safe while advancing your checked-out integration branch.

What it does:
- Calls `POST /api/git/smart-pull`
- If your worktree is clean, runs a fast-forward pull and returns `kind: "clean-pull"`
- If local changes exist, auto-stashes (including untracked files), runs `git pull --ff-only`, then restores the stash
- Returns `kind: "stash-pull-pop"` when stash → pull → pop succeeds cleanly
- Returns `kind: "stash-pop-conflict"` when stash restore conflicts, then opens `StashConflictModal`

Where it is triggered:
- From the merge-advance banner pull action (`MergeAdvanceNotice`)
- From any dashboard surface that invokes `POST /api/git/smart-pull`

When `stash-pop-conflict` occurs, `StashConflictModal` shows:
- Stash short SHA + stash label
- Per-file conflict list
- Per-file resolution actions (**Keep mine** / **Keep incoming**, backed by `/api/git/stash-resolve` choices `ours`/`theirs`)
- Stash actions: **Drop stash** (`POST /api/git/stash-drop`) and **Restore from stash ref** (`POST /api/git/stash-restore`)
- A stash-SHA copy button for sharing the conflict list/reference

After resolution:
- As each file is resolved, `remainingConflicts` shrinks; when empty, the modal can be closed and the branch stays at the advanced integration tip with resolved stash content applied
- Dropping the stash discards the saved local edits after conflicts are resolved
- Restoring from stash ref re-applies the stash and may reintroduce conflicts for manual handling

You may also see matching run-audit events in logs, including `pull:fast-forward` and `stash:pop-conflict`.

## Documents View

Documents view aggregates task documents and project markdown files.

Features:

- Group task documents by task ID (with revision history metadata)
- Search documents across tasks
- Open project markdown files with inline preview
- Jump directly from a document group to the owning task detail modal
- Toggle between raw text and rendered markdown using the **Markdown/Plain** button

![Documents view](./screenshots/documents-view.png)

## Reports View

Reports View is available when the **Reports** plugin is installed and enabled.

Navigation:
- Desktop: **Header → More views → Reports**
- Mobile: **More** sheet → **Reports**

Features:

- Reports history list with filters for cadence, status, date range, title text, and agent
- Detail viewer with a sandboxed iframe preview backed by the report HTML preview endpoint
- Section quick-jump sidebar based on stable report section markers
- Compare drawer for side-by-side report comparisons with section-level diff groupings
- Standalone HTML download/export action for sharing a self-contained report file

For plugin internals (registration, API routes, rendering/export pipeline), see [Reports plugin docs](./plugins/reports.md).

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

Agent list and detail surfaces now surface pending approvals per agent:
- Agents list/board cards show a warning-colored pending-approval badge when `pendingApprovalCount > 0`
- Agent detail summary shows a matching pending-approval badge for the selected agent
- Approval SSE events refresh these indicators live (no page reload required)


Agents view is the control surface for runtime agents and team structure.

Navigation:
- Desktop: primary view toggle (**Agents**)
- Mobile: bottom nav tab (**Agents**)

Features:
- Switch between **List**, **Board**, and **Org chart** layouts
- Filter by role/state, include/exclude system agents, and inspect health/status
- Start, pause, stop, and trigger agent runs from the view and from detail panels
- In **Agent detail**, use the kebab **Bulk agent actions** button in the header utility cluster (next to **Refresh** and **Close**) to run project-wide lifecycle transitions for non-ephemeral agents in the current project — **Pause All Agents** targets agents in the `active` or `running` state, while **Resume All Agents** targets agents in the `paused` state only
- Bulk menu items stay disabled when nothing is eligible and show an inline hint (`Loading eligible agents...`, `No active agents eligible`, `No paused agents eligible`, or the current eligible count such as `Pause 2 active/running agents`)
- Bulk lifecycle flow: open **Bulk agent actions**, review the eligibility hint, confirm the modal, then use the success or partial-failure toast to verify paused/resumed counts plus skipped/failed agents
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

## Goals View

Goals view is a minimal strategic-goals surface that shows the current goal list, active-goal count, and quick activation controls.

> No feature flag required.
> Current status: the `GoalsView` chunk is lazy-defined/prefetched in `App.tsx`, but it is not yet wired into the primary dashboard navigation.

What it currently shows:
- Header with active-goal count (`N active goals`) and an **Add Goal** action
- Goal cards with title, `Status: active|inactive`, and a per-goal **Activate** button (disabled for already-active goals)
- Empty state when no goals exist: `No goals yet. Add one to begin tracking strategic outcomes.`

Current data behavior:
- Uses in-component mock data (`defaultMockGoals`)
- UI-only state; no backend persistence or server-side goal storage yet

Active-goal cap behavior:
- Hard cap of 5 active goals
- Warning banner appears when active goals are in the 3–5 range
- Add/activate attempts beyond 5 are blocked and show an error message

Source file: `packages/dashboard/app/components/GoalsView.tsx`

## Evals View

Evals view is a dedicated dashboard surface for reviewing scheduled task-evaluation output.

> Available when `experimentalFeatures.evalsView` is enabled.

Navigation:
- Desktop: **Header → More views → Evals**
- Mobile: **More** sheet → **Evals**

Features:
- Filter eval results by free-text query, run, and score range
- Review list summaries (task, eval/run identity, timestamps, and score)
- Drill into full rationale, category scores, evidence references, and suggested follow-ups
- Open Scheduled Evals settings directly when setup is disabled

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

## Reliability View

Reliability view summarizes in-review pipeline health so operators can spot bounce/merge instability trends without leaving the dashboard.

Navigation:
- Desktop: **Header → More views → Reliability**
- Mobile: **More** sheet → **Reliability**

Features:
- Headline 7-day in-review success rate (derived as `1 - inReviewFailureRate7d`) with color thresholds: success for `≥95%`, warning for `≥90%`, error below `90%`; shows **Insufficient data** when the metric is null
- Per-day in-review flow table showing tasks that entered in-review versus tasks bounced back to in-progress
- In-review duration percentiles (P50 and P95) plus sample count
- Merge-attempt distribution stats including mean, max, and histogram buckets
- Auto-refreshes every 60 seconds

For the backing API and `windowDays` query parameter, see [architecture.md](./architecture.md).

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

## Stash Recovery View

Stash Recovery view helps recover orphaned merger autostashes (`fusion-merger-autostash:*`) left behind when merge restore could not fully complete.

Navigation:
- Desktop: **Header → More views → Stash Recovery**
- Mobile: **More** sheet → **Stash Recovery**

Features:
- Lists orphaned stash entries grouped by source task ID (or **Unknown source** when unavailable)
- Surfaces provenance metadata from recovery events (`sourcePhase`, `detectedByTaskId`, `detectedAt`) to show where/when leftovers were captured and surfaced
- Inspect diff output for any orphaned stash before taking action
- Apply a stash to recover changes, or drop a stash with confirmation to permanently remove it

For API endpoints, see [architecture.md](./architecture.md).

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

Inspect task definition, logs, review feedback, comments, documents, workflow outcomes, model overrides, and task routing from a single modal.

- The priority chip in task metadata is an inline picker: you can change priority directly without entering full edit mode.
- Execution mode has a read-mode inline lightning-bolt toggle for Fast mode on/off without opening the full edit form.
- These two metadata controls share matched sizing/alignment in read mode (including mobile wrapping) so they behave like a single polished control group.
- Task metadata also shows compact `Created` / `Updated` timestamps: recent values render as relative time (`just now`, `Xm`, `Xh`, `Xd`) and older values switch to short month/day dates; these stay grouped on one row across desktop and mobile widths for a compact metadata layout.
- Eligible existing tasks (triage, todo, in-progress, in-review) expose a **GitHub tracking** section directly in Task Detail, even when tracking is currently disabled.
- The GitHub tracking section now defaults to a compact summary row; use the disclosure arrow to expand linked-issue details plus tracking edit controls.
- In shared task edit/create forms, GitHub Tracking appears at the bottom of **More options**, after **Workflow Steps**.
- From this section you can explicitly enable/disable tracking and manage a per-task repo override (`owner/repo`). Clearing the override saves `null` and falls back to project/global defaults.
- The **Review** tab is separate from **Comments**: Review shows actionable PR/reviewer feedback and same-task revision controls, while Comments remains the general collaboration thread.
- **Request revision** in Review resumes work on the same task ID (no refinement task): `in-progress` tasks get steering injection, while `in-review` tasks are moved back to `in-progress` for the same branch/worktree revision pass.
- Review supports a manual **Refresh** action in-place: PR mode pulls latest GitHub review state/decision, while direct mode rehydrates reviewer-agent feedback from persisted task data (no GitHub call).
- In direct/non-PR auto-merge mode, Review renders normalized reviewer-agent feedback (verdict/step/timestamp/detail) with dedicated loading/error/empty states; it does not require users to read raw agent logs.

### Identifying high-impact blockers

Use blocker fan-out signals on task cards and in the footer status bar to spot blockers with high downstream impact:

- `Blocks N` counts active downstream dependents in `triage`, `todo`, `in-progress`, or `in-review`.
- FN-3942 immediate signal: blockers with at least **5 active `todo` dependents** (`activeTodoCount >= 5`) are marked **High fan-out**.
- FN-3954 escalation signal: a high-fan-out blocker is upgraded to **Escalated** only after it remains in `in-progress`/`in-review` past `staleHighFanoutBlockerAgeThresholdMs` (age source: `columnMovedAt ?? updatedAt`).
- Escalation payload surfaced in UI includes blocker ID, active todo downstream count, total active downstream count, and computed blocking age.
- Done and archived downstream tasks remain visible for debugging context but do **not** count toward the todo threshold.
- The badge tooltip shows active totals and, when escalated, the computed blocking age context.
- `(stale)` markers mean the dependent is blocked through `blockedBy` and matches stale conditions that `clearStaleBlockedBy` self-healing should clear automatically.
- Stale `dependencies[]` links are shown for awareness but are not auto-cleared by `clearStaleBlockedBy`.
- The executor footer summarizes the top escalated blocker (deterministic rank: highest todo fan-out, then highest active total, then oldest age, then stable task ID).

Recommended workflow: ordinary chains stay as `Blocks N` so noise stays low, high-fan-out blockers stand out immediately, and only long-lived high-impact blockers trigger explicit escalation.

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

### Remote Node Onboarding Discovery

When adding a **remote** node in the Nodes view, onboarding now discovers projects directly from the target node **before** the node is registered.

1. Enter the remote URL (and API key when required)
2. Click **Discover Remote Projects**
3. Fusion calls the remote node's `/api/projects` endpoint and shows discovered projects (`name`, `path`, `status`)
4. For selected local projects, Fusion only auto-prefills a node path when there is exactly one discovered project with the same name
5. If discovery fails, onboarding shows an inline error and does not prefill remote mappings for that attempt
6. If discovery succeeds with zero projects, onboarding shows an explicit empty state

This keeps remote path mappings anchored to remote-authoritative data instead of local guesses.

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

### Project availability and path visibility

Node and project surfaces now use per-node project mappings (`nodeMappings`) instead of a single `project.nodeId` assumption.

- **Node cards / counts** include only projects with an `available: true` mapping for that node.
- **Node Details modal** lists one row per project available on the selected node and shows:
  - project name
  - project ID
  - configured path for that node
- **Project node filter** in the Projects view is built from available mappings and uses canonical node-name resolution (`Node.name` → mapping name → source node name → node ID).
- **Project cards** show node availability as compact `Node → /path` rows:
  - up to 3 rows inline
  - `+N more` summary when additional mappings exist
  - single-node projects still show the configured path clearly
- Mappings marked `available: false` are excluded from node counts, node filter options, node detail project rows, and project-card availability summaries.

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

## Styling Guide

The dashboard's CSS is split into a global stylesheet (`packages/dashboard/app/styles.css`) and per-component files (`packages/dashboard/app/components/ComponentName.css`). Each `ComponentName.tsx` imports its stylesheet at the top.

**Rule:** New CSS for a component goes in `app/components/ComponentName.css`, NOT `styles.css`. Only design tokens, primitives (`.btn`, `.card`, `.modal`, `.form-input`), and cross-component `@media` overrides belong in the global file.

The `index.html` shell is templated server-side: the server injects a per-user `<link rel="modulepreload">` for the last-used `taskView` chunk, sourced from Vite's `dist/client/.vite/manifest.json` and `kb:<projectId>:kb-dashboard-task-view` in localStorage.

### Design tokens

`styles.css` is the source of truth for tokens (`--space-*`, `--radius-*`, `--shadow-*`, `--transition-*`, `--font-*`, `--header-height`, `--mobile-nav-height`, `--standalone-bottom-gap`, `--overlay-padding-top`) and color variables (`--bg`, `--surface`, `--card`, `--text`, `--text-muted`, status colors `--triage`/`--todo`/`--in-progress`/`--in-review`/`--done`, semantic `--color-success`/`--color-error`/`--color-warning`/`--color-info`, status backgrounds `--status-*-bg`).

**Always reference tokens. Never hardcode pixels, hex, or `rgba()` in component CSS** — the only exception is inside `:root`/theme blocks where tokens are *defined*. For translucent backgrounds use `color-mix(in srgb, var(--color) X%, transparent)`, not `rgba()`.

### Theme system

Dark/light modes via `data-theme`; 54 color themes via `data-color-theme` (lazy-loaded from `app/public/theme-data.css`).

- **Base tokens** (`--bg`, `--surface`, etc.) — redefine in `:root`, `[data-theme="light"]`, and every theme block.
- **Semantic tokens** (`--autopilot-pulse`, `--event-error-text`, `--badge-mission-*`, `--fab-*`) — `:root` + `[data-theme="light"]` only; no per-color-theme overrides.
- **Status tokens** (`--triage`, `--todo`, etc.) — redefine per theme block.

`status-colors-theme.test.ts` iterates all theme blocks to catch regressions.

### Component classes

Reuse existing primitives from `styles.css`:
- **Buttons**: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-warning`, `.btn-sm`, `.btn-icon`, `.btn-icon--active`, `.btn-badge`. All inherit `:focus-visible` via `--focus-ring-strong` and `:active` via `transform: scale(0.97)`.
- **Modals**: `.modal-overlay[.open]`, `.modal`, `.modal-lg`, `.modal-header`, `.modal-close`, `.modal-actions`, `.modal-actions-left/right`. Overlay pads top with `--overlay-padding-top`.
- **Forms**: `.form-group`, `.input`, `.select`, `.checkbox-label`, `.form-error`. Inputs in `.form-group` get focus styles automatically.
- **Cards**: `.card`, `.card-header`, `.card-id`, `.card-title`, `.card-meta`, `.card-status-badge--{triage,todo,in-progress,in-review,done,archived}`.
- **Utility**: `.touch-target` (44px min), `.visually-hidden`.

Don't create parallel button/form variants — add states (`:hover`, `:focus-visible`, `:active`) to the existing primitives.

### Mobile responsive

Breakpoints: 768px (primary mobile), 1024px (tablet `min-width: 769px and max-width: 1024px`), 640px (compact), 480px (xs). Mobile overrides go in `@media (max-width: 768px)` blocks at the bottom of `styles.css` after base styles.

**Bottom spacing:** `--mobile-nav-height` (44px) + `env(safe-area-inset-bottom, 0px)` + `--standalone-bottom-gap` (0/8px PWA). All bottom-positioned mobile elements compose those.

**Touch targets:** Standing button-freeze directive supersedes per-button touch-target guidance. For non-button elements, primary controls (nav bar, FAB, tab action rows, modal CTAs, list-row tap targets, form controls) must be ≥36px on mobile. Secondary controls inside a card/list-row where the row itself is the tap target stay compact (24–28px or small chips).

**Safe area:** `max(var(--space-md), env(safe-area-inset-left, 0px))` for notch-aware horizontal padding.

### Lazy-Loaded Heavy Views

These 19 views are lazy-loaded via `React.lazy()` with `<Suspense fallback={null}>`. `prefetchLazyViews()` warms chunks once on mount via `requestIdleCallback`. **Do not make these eager.**

- `AgentsView`
- `NodesView`
- `ChatView`
- `MemoryView`
- `DevServerView`
- `SecretsView`
- `InsightsView`
- `DocumentsView`
- `SkillsView`
- `ResearchView`
- `ReliabilityView`
- `EvalsView`
- `TodoView`
- `GoalsView`
- `StashRecoveryView`
- `SetupWizardModal`
- `PluginManager`
- `PiExtensionsManager`
- `AgentDetailView`

When adding or removing entries, update `packages/dashboard/app/__tests__/lazy-loaded-views-docs.test.ts` (expected set + count).

### CSS testing

Use `packages/dashboard/app/test/cssFixture.ts`:

```ts
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";
const allCss = await loadAllAppCss();          // styles.css + all component .css
const baseOnly = await loadAllAppCssBaseOnly(); // strips @media/@supports
```

**Never** directly `readFileSync('../styles.css')` — an ESLint rule (`no-restricted-syntax` in `eslint.config.mjs`) bans this and points at `cssFixture.ts`. `vitest.config.ts` has `test.css: { include: [/.+/] }` so component CSS imports inject into jsdom for `getComputedStyle` assertions.

### File browser editor & autosize textarea

- `FileEditor.tsx` is CodeMirror 6-only (no `<textarea>` fallback). Language resolution: `packages/dashboard/app/utils/codemirror-language.ts`.
- For chat-style composer fields use `packages/dashboard/app/hooks/useAutosizeTextarea.ts`. Pattern: `height = "auto"` then clamp `scrollHeight` to min/max in `useLayoutEffect`. Pair with `resize: none` and `overflow-y: auto`.

### File-path links

Reuse `packages/dashboard/app/utils/filePathLinkify.tsx` and `FileBrowserContext`. Wrap plain text with `linkifyFilePaths(...)`, mixed JSX with `linkifyReactChildren(...)`. Mount under `FileBrowserProvider` and route clicks through its `openFile(path, { workspace?, line?, col? })`.

### Common pitfalls

- **`--surface-hover` undefined** — reference with a fallback (`var(--surface-hover, rgba(0,0,0,0.03))`) or define explicitly.
- **BEM specificity** — when a container state class and an element modifier target the same node, the container can win. Use `:not(.modifier)` to scope.
- **CSS `@media` detection** — track brace depth to confirm a rule is mobile-scoped; don't scan backwards for the nearest `@media`. Many components are global even if visually mobile-only.
- **Mobile board scroll-snap (FN-001)** — `scroll-snap-type: x mandatory` on mobile `.board` causes iOS Safari to compress the viewport when switching from ListView. Use `x proximity` + `overflow-anchor: none`.
- **`lucide-react` icon adds** — update `vi.mock("lucide-react")` test mocks immediately; missing exports cascade.
- **`.spin` is global** — don't redefine the generic spin keyframes in component CSS.

## Integration Branch Push to Origin

The merge-advance notice includes an explicit **Push to origin** action for the dynamically resolved integration branch.

- The branch name is resolved from project settings, then `origin/HEAD`, then fallback; UI copy and API behavior must remain dynamic.
- Push status probes compute ahead/behind counts and disable push when there is no `origin`, no upstream tracking ref, the branch is not ahead, or a Fusion merge lock is active.
- The mutating route performs a TOCTOU merge-lock recheck immediately before building push argv.
- Standard push is `git push origin refs/heads/<branch>:refs/heads/<branch>` with no plain `--force` path.
- Advanced mode enables opt-in `--force-with-lease=refs/heads/<branch>:<localSha>` only.
- Non-fast-forward and lease-stale failures surface actionable messaging with Smart Pull.
- Every attempt records `mutationType: "push:origin"` run-audit metadata: `integrationBranch`, `remote`, `localSha`, `remoteSha`, `aheadCount`, `behindCount`, `forceWithLease`, `outcome`, optional `stderrPreview`, and `durationMs`.
- Push remains explicit user authorization only through dashboard HTTP routes (no scheduler/heartbeat auto-push).
