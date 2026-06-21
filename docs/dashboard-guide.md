# Dashboard Guide

[← Docs index](./README.md)

The Fusion dashboard is the main control plane for tasks, agents, missions, settings, logs, and repository operations.

## Dashboard Updates

When Fusion detects a newer `@runfusion/fusion` release, the Settings modal footer shows the available version with **Learn more** and **Update now** actions. **Update now** installs the latest global package with npm; after it succeeds, restart Fusion to apply the new version because the already-running dashboard server is unchanged until restart.

## Mobile/PWA app icons

The installed mobile/PWA home-screen icons are generated from `packages/dashboard/app/public/logo.svg` by the desktop icon generator. When the Fusion brand mark changes, run `pnpm --filter @fusion/desktop generate:icons` so `packages/dashboard/app/public/icons/icon-192.png` and `packages/dashboard/app/public/icons/icon-512.png` stay aligned with the canonical logo. Also bump `CACHE_NAME` in `packages/dashboard/app/public/sw.js` whenever those icon assets change so installed PWAs refresh the cached launcher images.

## Browser Navigation

The dashboard now handles browser back navigation consistently on desktop and mobile.
Using Back will first dismiss open modals and then step back through in-app view changes (for example, task detail → board) before leaving the app.
This behavior used to be mobile-only, and now applies across all viewports.
Task Detail modal opens from onboarding, activity log, and task-to-task navigation now all register navigation history entries, so Android back swipe/button dismisses them consistently.

## Left Sidebar Navigation (experimental)

Enable **Left Sidebar Navigation** from **Settings → Experimental Features** to move the desktop/tablet project navigation out of the Header and into a persistent left sidebar.

When enabled on desktop or tablet project screens, the sidebar contains the primary destinations (Board, List, Agents, Command Center, Missions, Chat, Documents, Mailbox, and plugin primary views), Header overflow destinations as regular entries (Research, Insights, Skills, Memory, Secrets, Stash Recovery, Evals, Goals, Dev Server, Todos, and plugin overflow views when their flags/plugins are enabled), and a Settings button pinned to the bottom. The Header retains the Fusion brand and project selector, keeps its non-navigation controls, and hides the view-toggle row and **More views** trigger so there is only one canonical navigation surface.

A small right-border toggle collapses or expands the sidebar without consuming a navigation row; collapsed rail mode keeps accessible labels/titles preserved, and the expanded width can be resized from the right-edge separator. Collapsed state and expanded width are saved in browser `localStorage` (`fusion:left-sidebar-collapsed` and `fusion:left-sidebar-width`) and restored on reload.

On mobile viewports (`<=768px`), the sidebar is not rendered even when the experiment is enabled. The existing bottom `MobileNavBar` remains the navigation surface.

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
- Task detail modal content (description markdown, **Review** tab, and **Workflow Results** tab output plus workflow overview/graph/model settings)
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
- The quick-entry GitHub icon is a per-task tracking override: leave it untouched to use the project default, turn it on to opt the next task into tracking when the default is off, or turn it off to opt the next task out when the default is on.
- PR/issue badges with live updates
- GitHub provenance marker on task cards imported from GitHub (`sourceType: github_import`), shown in the footer with other external-source metadata
- Task card header meta badges group priority, fast mode, agent-created provenance, and elapsed/created-time chips into one wrapping row; agent labels prefer `sourceMetadata.agentName` over raw agent IDs
- Column ordering semantics: `todo` mirrors scheduler pickup order (priority descending, then oldest `createdAt`, then task ID); `triage`, `in-progress`, `in-review`, and `archived` remain priority-first with task-ID tie-breaks; `done` is ordered by most recent completion first (`columnMovedAt`, then `updatedAt`, then `createdAt` fallback)
- On mobile, both default and workflow-mode boards fill the project viewport while the column strip remains the internal horizontal scroller with contained edge overscroll.
- Board and List workflow switchers use a themed dropdown instead of a native select. The closed trigger shows the workflow name and chevron only; compact Todo / In Progress / Done counts derived from workflow column flags (excluding archived columns) appear while the dropdown is expanded, including on each workflow option. Those inline count badges intentionally use the same board column color tokens as cards: `--todo`, `--in-progress`, and `--done`.
- When workflow columns are enabled, Board and List hydrate the last successful workflow-lane payload from a per-project session cache; cold loads show a neutral skeleton until settings and workflow metadata are known, avoiding a legacy single-lane flash.

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

## Workflow Selection and Editor

Workflows define how a task moves through planning, execution, review, workflow steps, merge, and any custom graph policy. Most coding tasks can stay on the default Coding workflow, but task and board workflow controls can select a different built-in or custom workflow per task. For the built-in catalog and runtime semantics, see [Workflow Steps → Workflow overview](./workflow-steps.md#workflow-overview).

The workflow editor opens as a full-screen modal editor for inspecting built-ins and authoring custom workflows.

Navigation:
- Open a task or board surface that shows the workflow selector, then choose **Manage…**.
- From the board workflow toolbar, use the edit workflow button beside the selector to open the currently selected workflow directly when one is selected. The board/list workflow dropdown also previews each workflow's Todo / In Progress / Done task counts inline before switching.
- Use the global **Workflow** / **Workflows** entry point from desktop header, compact header overflow, or mobile **More** navigation to browse definitions.
- From Settings moved-setting stubs, choose **Open workflow settings** to jump to the default workflow's settings values.

Behavior:
- Opens a workflow node editor with a workflow list/sidebar, canvas, inspector, and settings/authoring panels
- Read-only built-in workflows are inspectable in the same canvas as custom workflows, including connected success, failure, and rework edges for their graph topology.
- Custom workflows can be created from blank, duplicated from built-ins/custom definitions, imported/exported, AI-designed, validated, and saved from the editor.
- The Settings panel is value-first for built-in workflows and groups workflow settings by Models, Review & Approval, Step Execution, and Advanced. Known workflow model values use the same model dropdown picker as **Settings → Project Models** so provider/model pairs are saved together; custom or non-model string values can still use typed inputs. Definitions remain available for custom workflow schema authoring.
- The main Settings modal also exposes the default workflow's Plan/Triage, Executor, and Reviewer model lanes from **Project Models**; the modal's primary **Save** action writes those dropdown values as workflow setting values for the active default workflow.
- On desktop, the editor uses a multi-panel canvas layout for editing the graph and adjacent workflow metadata. The **Show simple editor** toggle switches that same workflow into the graph-outline editor with dedicated **Graph**, **Add**, **Settings**, **Fields**, **Columns**, and **Actions** tabs.
- On viewports `<=768px`, the editor switches to a full-screen mobile sheet. Global workflow entry points open to the workflow list with no workflow preselected and prompt users to select a workflow to edit; the board workflow toolbar edit button opens directly to the selected workflow editor when that selected workflow is available.
- Simple/mobile editing uses a graph outline instead of making the canvas the primary control. The outline shows nodes, branch/rework edges, column placement, and foreach/loop template children as tappable rows and chips that open the same node and edge detail editors as desktop. The structural **start** node opens an inspector for the workflow entry column when the workflow defines columns; the **Name** field remains unavailable because the start label is structural. For custom workflows, editable outline rows also expose **Move up** and **Move down** controls that reorder steps within their current column or template parent; built-in workflows remain read-only and hide those controls.
- Simple/mobile authoring exposes dedicated destinations for **Graph**, **Add**, **Settings**, **Fields**, **Columns**, and **Actions**. Add includes the node palette plus fragments, built-in step templates, and plugin step templates; Actions includes save, AI edit, auto-layout, export, and delete for custom workflows, plus export and duplicate for built-ins. Settings keeps the Definitions/Values tab split.
- The create-workflow dialog and workflow AI authoring popover follow the same mobile full-screen/sheet pattern so they are not clipped by the editor canvas on narrow screens

## Custom Providers

Custom Providers live in **Settings → Authentication → Custom Providers**, inside the **Advanced: Custom Providers** disclosure. Use this section to add user-defined model providers that speak an OpenAI-compatible API, the OpenAI Responses API, an Anthropic-compatible API, or Google Generative AI. After a provider is saved with models, those models become selectable in model dropdowns, including **Settings → Project Models** lanes and workflow model lanes.

Supported **API type** values match the dropdown in the form:

- **OpenAI-compatible**
- **OpenAI Responses**
- **Anthropic-compatible**
- **Google Generative AI**

The custom-provider form uses these fields:

- **Provider name** — the display name for the provider.
- **API type** — one of the supported API types above.
- **Base URL** — the provider endpoint base URL. It must be a valid `http` or `https` URL, for example `https://api.example.com/v1`.
- **API key** — optional credential for providers that require authentication.
- **Available models** — comma-separated model IDs, for example `gpt-4, gpt-3.5-turbo`.

Use **Detect Models** to auto-fill **Available models** from the provider's `/models` endpoint. Detection requires a **Base URL** and may require an **API key**, depending on the provider.

### Add a custom provider

1. Open **Settings → Authentication → Custom Providers**.
2. Expand **Advanced: Custom Providers** if it is collapsed.
3. Select **Add Custom Provider**.
4. Enter a **Provider name**.
5. Choose the correct **API type**: **OpenAI-compatible**, **OpenAI Responses**, **Anthropic-compatible**, or **Google Generative AI**.
6. Enter the provider **Base URL**. The value must be a valid `http` or `https` URL.
7. If the provider requires authentication, enter its **API key**.
8. Populate **Available models** by either:
   - entering comma-separated model IDs manually, or
   - selecting **Detect Models** to query the provider's `/models` endpoint and prepend detected model IDs to the field.
9. Select **Save Provider**.

Expected outcome: the provider appears in the Custom Providers list with its API type and base URL. Each saved model is then available in model dropdowns as a `{provider}/{modelId}` option, including **Settings → Project Models** default-workflow lanes and workflow model lanes in the workflow editor.

### Edit a custom provider

1. Open **Settings → Authentication → Custom Providers** and expand **Advanced: Custom Providers**.
2. Find the provider in the list and select its pencil **Edit** action.
3. Update **Provider name**, **API type**, **Base URL**, **API key**, or **Available models** as needed.
4. Select **Detect Models** again if you want to refresh or add model IDs from the provider's `/models` endpoint.
5. Select **Save Changes**.

Expected outcome: the provider list refreshes, and model dropdowns use the updated model list. If you rename the provider or change model IDs, update any **Project Models** or workflow model lane selections that should use the new `{provider}/{modelId}` value.

### Delete a custom provider

1. Open **Settings → Authentication → Custom Providers** and expand **Advanced: Custom Providers**.
2. Find the provider in the list and select its trash **Delete** action.
3. Confirm the prompt: `Delete custom provider "<name>"?`.

Expected outcome: the provider is removed from the list, and its models are no longer offered as selectable options in model dropdowns. Review any **Project Models** or workflow model lane values that previously selected that provider.

### Masked API key behavior

Saved API keys are stored in settings but are masked in API responses and UI-loaded provider records. When you edit an existing Custom Provider, the **API key** field starts blank and shows the hint **Leave blank to keep current key** if a key is already saved.

- Leave **API key** blank to preserve the saved key.
- Enter a new **API key** value to replace the saved key.
- The masked value shown in responses is never reused or submitted as a real credential by the edit form.

For the stored settings shape, see [`customProviders` in the Settings Reference](./settings-reference.md#customproviders). For the API behavior, including masked keys in responses, see [Architecture → Custom Provider endpoints](./architecture.md#custom-provider-endpoints).

## Planning Mode

Planning Mode now includes branch controls on the summary screen before you create a task.

- **Branch strategy** options mirror Subtask Breakdown semantics:
  - `Use project/default branch`
  - `Create auto-named branch per task`
  - `Use existing branch`
  - `Create custom new branch`
- **Branch name** is required when using `existing` or `custom new` strategies.
- **Merge target / base branch (optional)** uses a dropdown of existing local branches (with common names like `main`/`master`/`trunk`/`develop` listed first) plus a **Custom…** fallback when you need to type a branch that is not local yet.
- **Description** supports a `Markdown`/`Plain` toggle in the summary header row: `Plain` keeps the editable textarea, while `Markdown` renders formatted preview (`react-markdown` + GFM) in the same footprint for easier review before task creation.

These values are sent with the Planning Mode create-task request as `branchSelection`, so created tasks persist branch/base-branch settings consistently with other branch-aware task creation flows.

When Planning Mode or Subtask Breakdown is opened from a workflow-filtered board lane, the create request also carries that active workflow selection. Single-task planning saves, planning breakdown saves, and subtask-breakdown saves create their tasks directly on the selected workflow lane instead of briefly landing on the default board.

Completed single-task planning sessions remain in the Planning Mode history after you create the task, and selecting one restores the completed summary instead of restarting the composer. History rows are deduplicated by session id even if the initial load and live session updates arrive out of order, and deleting a history entry now waits for the server delete to persist (failures keep the row visible and surface an error instead of silently disappearing until refresh).

## New Task Modal Branch Strategy

The **New Task** dialog uses the same four-option **Branch strategy** selector and `branchSelection` payload as Planning Mode:

- `Use project/default branch`
- `Create auto-named branch per task`
- `Use existing branch`
- `Create custom new branch`

Rules:

- `existing` and `custom-new` require a branch name.
- `project-default` leaves `branch` unset.
- `auto-new` creates a branch after task creation using `fusion/{task-id}-{short-name}` (for example `fusion/fn-5671-branch-strategy-dropdown`).
- `Merge target / base branch` stays optional for all modes and uses the same branch-dropdown + `Custom…` fallback behavior as Planning Mode.
- In **More options → Model Configuration**, **Auto-merge** is a per-task override with three states: **Default** (follow project setting), **Enabled**, or **Disabled**.

## Chat View

Chat view provides project-scoped conversations with agents.

- Entering `/new` or `/clear` (exact match after trimming) in the composer starts a fresh thread for the current chat target instead of sending the literal command to the model
- On mobile, the New Chat and Delete Conversation dialogs use a compact inset treatment (centered, viewport-bounded, internally scrollable) instead of the app's default full-height mobile modal chrome.
- Full Chat and Quick Chat both consume the same streamed `/api/chat/sessions/:id/messages` response contract, and both now prefer the authoritative assistant `message` snapshot on `done` while still accumulating `text` chunks when present (so providers without incremental text streaming still render output immediately)
- In-progress assistant responses now survive refresh/navigation while generation is still active: Chat restores the last durable in-flight text/thinking/tool state immediately, keeps the prior persisted conversation visible, then resumes streaming from the stored replay point; any new text, thinking, or tool-call updates append to that restored bubble instead of replacing it or starting from an empty "Working…" placeholder.
- If a regular Chat stream drops with a hidden-tab/browser-suspension error (for example `Load failed`) while the server is still generating, Chat suppresses the false error banner, re-attaches to the in-progress stream using the durable replay state, and reconciles the final assistant reply when generation completes.
- If you queue a follow-up user message while the assistant is still streaming, Chat now persists that queued text per session so leaving and returning to the view still restores and sends it once the active response finishes.
- Chat message lists now track near-bottom scroll state: while you are reading older messages, live streaming/new replies do not force-scroll; a **Latest** jump control appears until you return to the tail.
- On mobile direct-chat threads, entering a thread and restoring Chat after tab/page visibility returns re-anchors to the newest message (`scrollTop = scrollHeight`) so the view always opens at the live tail.
- On mobile direct-chat threads, tapping the active title/identity in the thread header opens a lightweight conversation dropdown so you can switch to another direct session without backing out to the sidebar list first; long conversation titles now stay readable in the dropdown via wrapped option text and taller touch-friendly rows.
- Direct chat sessions can be renamed from the desktop conversation context menu and from the mobile session switcher; blank rename submissions clear the custom title so the default session label is shown again.
- On mobile (`max-width: 768px`), chat bubbles are slightly wider in full Chat for improved readability while preserving header/composer gutters.
- Full Chat tool-call summaries now use a denser mobile layout: grouped and single-call collapsed rows keep icon + label + status on one line (Quick Chat-style scanability) while expanded details remain unchanged.
<!-- FNXC:ChatAskQuestion 2026-06-17-16:35: Dashboard chat agents have a Fusion-native `fn_ask_question` tool, so the documented question-card behavior must cover both provider-native question tools and Fusion's first-party tool. -->
- Assistant question tool calls now render as a shared in-chat response card instead of a generic tool-call disclosure. The card recognizes provider-native question tools and Fusion's `fn_ask_question`, supports select, multi-select, text, and yes/no prompts, sends the formatted answer back into the same direct or room thread, and renders historical answered questions read-only.
- The desktop Chat view toggle and mobile Chat tab now show an unread-response indicator when a live assistant reply arrives for your active chat thread after you leave Chat; opening Chat clears it immediately.
- Agent-backed chat sessions now expose the same mailbox messaging tools (`fn_send_message`, `fn_read_messages`) used by runtime execution/heartbeat flows whenever the engine `MessageStore` is available; model-only chats continue to run without mailbox tools.
- Chat attachments are included in agent-visible prompts for both direct sessions and rooms: supported text attachments are appended under an `Attachments` prompt section, and supported images (`png`, `jpeg`, `gif`, `webp`) are passed as image inputs to the model.
- Chat attachments can be sent without accompanying text in both Quick Chat and Main Chat; fully empty sends with no text and no attachments are still blocked.

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
- On mobile, the room and direct composer send buttons use a two-latch touch/pointer dedupe: pointer/touch events claim only the current gesture, while a separate click latch consumes any trailing synthetic click. One tap dispatches exactly one send, a second iOS tap within the suppressed-click window still sends, and a send-to-stop button swap does not accidentally press stop.
- The dashboard backend now orchestrates room responders on that POST: mentioned members are routed as direct responders, additional ambient members may reply (up to the room ambient responder cap), and each assistant reply is persisted with `senderAgentId` via `chatStore.addRoomMessage(...)`.
- Room responders can intentionally stay silent by returning the `__SKIP__` sentinel; that sentinel is treated as a no-op and is never persisted, emitted over SSE, or rendered in room transcripts.
- If room replies cannot be generated (for example no resolvable responders or all responders fail), the POST fails with an API error (HTTP 502) instead of silently returning only the user message.
- If room responders cannot be resolved or all room-reply generations fail, the POST now returns an error instead of silently succeeding with only the user message, so failures are surfaced deterministically.
- Room responder prompt construction now keeps the most recent room messages verbatim and, when the room runs long, prepends a compacted summary of older history (span, participants, and key highlights) plus an explicit latest-user-message marker so replies stay thread-aware without unbounded prompt growth.
- Room responder prompts include the latest room message attachments using the same direct-chat behavior: text is inlined into the prompt and supported images are forwarded as model image inputs.
- On send failure, `useChatRooms` rolls back/reconciles optimistic state and rethrows; `ChatView` catches once, restores the exact pre-send composer text for retry/edit, and surfaces a single error toast (no duplicate hook+view notifications).
- After each send attempt, the room transcript still re-fetches authoritative messages so persisted user/assistant replies remain visible even when SSE delivery is delayed, and `chat:room:message:*` SSE updates continue live fan-out.
- Relationship summary: direct Chat runs one target (agent or model) per session; rooms are shared threads with multiple agent members and now use the same message contract as direct Chat; Quick Chat is still a floating panel, but when a room is selected it now reads/writes that room thread directly.
- For backend details, see the [Chat Room REST API reference](./architecture.md#real-time-channels) and the [chat room storage schema (`chat_rooms`, `chat_room_members`, `chat_room_messages`)](./storage.md#chat-rooms-migration-70).

## Quick Chat

Quick Chat is an optional floating panel for fast, project-scoped assistant conversations without leaving your current view.

- Controlled by the project setting `showQuickChatFAB`
- Supports agent mentions (`@agent`) and shared `#` task/file mentions
- Supports `/skill:{name}` in model-loop chat to request a specific enabled skill for that session; the slash token is removed from the model prompt while the original user message remains in chat history
- Uses the same model/provider infrastructure as full Chat view
- On small screens, compact tool-call summaries in the floating panel intentionally stay single-line (count + tool names + status) to preserve message density
- The panel header uses a session-first flow: the main dropdown lists persisted sessions (preferring `session.title`, then falling back to deterministic `Session N` labels)
- Quick Chat sessions can be renamed from the session dropdown, and the active title is shown in the header so custom names remain visible after the dropdown closes.
- Selecting a session from that dropdown resumes the persisted conversation; this keeps `switchSession()` resume-oriented rather than forcing a new thread
- Entering `/new` or `/clear` (exact match after trimming) in the Quick Chat composer clears the active thread target: direct/model targets use `startFreshSession(...)`, while room targets call `rooms.clearRoom(activeRoom.id)`.
- The `+` action opens an inline new-session chooser (inside the panel, not a modal) with `Model` selected by default and optional switch to `Agent`
- Submitting the inline chooser uses explicit fresh-session creation and immediately persists/selects the new thread, then refreshes the session dropdown list
- On first open for a project, Quick Chat restores the last opened non-archived session from per-project local storage; if that saved session is missing, it falls back to the most recently touched non-archived session by latest activity (`max(lastMessageAt, updatedAt)`), and only falls back to the first agent / configured default model when no prior session exists.
- Closing and reopening Quick Chat keeps the active conversation warm in memory, so messages stay visible without a conversation reload or "Loading conversation…" flash.
- Queued follow-up messages entered while a Quick Chat response is still streaming now persist per session, so closing/reopening the panel restores the queued text and flushes it once the active response completes.
- Resume lookups still use targeted session queries instead of loading the full active-session list first
- Tool-call summaries in the floating quick-chat panel are intentionally condensed into a single-line header row (especially on small screens) so tool name + status stay scannable without multi-line wrapping
- Question tool calls use the same shared response card as full Chat, with compact spacing in the floating panel and read-only answered history so Quick Chat can continue agent clarification loops without exposing raw tool JSON.
- Opening Quick Chat auto-focuses the composer as soon as it is ready on desktop and mobile viewports; mobile additionally uses the stealth-input handoff so the soft keyboard opens immediately
- FAB dragging uses pointer events with document-level move/up tracking and a 5px drag threshold so Android touch drags reposition reliably while short taps still open Quick Chat
- Quick Chat now mirrors full Chat tail behavior: if you scroll up, live updates stop auto-following and a **Latest** jump control appears until you jump back down.
- On mobile, Quick Chat re-anchors to the newest message whenever the panel is opened/reopened and when page visibility is restored, while still preserving the near-bottom gate so intentional scroll-away keeps **Latest** jump behavior.
- On mobile, Quick Chat bubbles are slightly wider while keeping compact tool-call summary layout and full-screen/safe-area behavior intact.
- On mobile, the fullscreen Quick Chat sheet follows soft-keyboard `visualViewport` height/offset samples directly, dedupes repeated identical samples, and smooths Android resize-content height-only changes so the sheet does not visibly step while the keyboard animates. iOS-style non-zero `offsetTop` samples still apply synchronously so transform alignment stays exact.
- On mobile, Quick Chat send reliability includes a delivery watchdog: if a queued message would otherwise stay stranded in the composer after a dropped or suspended stream, it is re-confirmed and delivered once no generation is in flight and no live stream is connected, so sends are not silently dropped.
- On mobile, Quick Chat sends exactly once per tap even when the browser emits paired pointer and touch events; a stop tap immediately after send is still honored.
- While a response is streaming, the Quick Chat stop control matches the send button's square dimensions (including on mobile) instead of collapsing toward its icon, so it stays an easy touch target.

## Mailbox View

Mailbox view shows inbox/outbox communication threads and unread state.

- Inbox renders one row per message (no sender-based collapsing)
- clicking a message in the Mail tab opens the task detail pane with full message content and conversation context
- reply rows in the mailbox modal can expand inline to show the replied-to message context for easier thread reading
- mailbox now includes an **Approvals** tab with pending and history filters (`approved` / `denied` / `completed`), approval detail context, and inline approve/deny actions for pending requests
- in the **Agents** tab, the agent selector now includes **All agents**, which shows one combined agent-to-agent stream (with sender + recipient labels); selecting a specific agent still shows Inbox/Outbox subtabs
- mailbox entry points now show unread/pending indicators: the desktop/tablet Header mailbox toggle shows a pending-approval dot first or an unread dot when unread mail exists without pending approvals, the mobile bottom-nav Mailbox tab carries the mobile badges/dots, and the compact Header actions overflow keeps a Mailbox entry only when the mobile bottom nav is disabled
- approval lifecycle SSE events (`approval:requested`, `approval:updated`, `approval:decided`) trigger mailbox approvals refresh without manual reload
- when a task newly enters `awaiting-approval`, the app shows a persistent approval banner above project content with an **Open Mailbox** CTA; dismissals are remembered per approval item until that item advances or a different one arrives
- when a task first transitions into `done`, the dashboard shows a one-time **Enjoying Fusion?** GitHub star prompt in the project view; clicking **Star on GitHub** or dismissing the card marks it shown in browser `localStorage`, so it does not reappear on reload or later task completions
- Visible message history/threading is driven by explicit `message.metadata.replyTo.messageId` links
- Separate top-level messages from the same sender remain independent in the inbox and detail pane

![Mailbox view](./screenshots/mailbox-view.png)

## Interactive Terminal

Fusion embeds a terminal using xterm.js.

Features:

- Multiple terminal tabs
- PTY-backed shell sessions
- Ctrl/Cmd+C copies the current terminal selection, while plain Ctrl+C with no selection still sends SIGINT
- Ctrl/Cmd+V pastes clipboard text into the active terminal session
- The Shortcuts panel includes Ctrl/Alt helpers, ESC/Tab, common shell shortcuts, and Up/Down/Left/Right arrow buttons that send standard ANSI cursor sequences for keyboard-less shell history and line editing
- Shortcuts panel buttons preserve terminal focus on the active terminal session during pointer, mouse, and touch activation, so Ctrl combinations reliably emit control bytes to the shell
- The Preferences panel customizes font family, font size, cursor style, cursor blink, and renderer; changes persist in browser `localStorage` under `kb-terminal-preferences`, with the legacy `kb-terminal-font-size` value migrated automatically
- Font and cursor preferences apply live to the active xterm instance; renderer changes apply the next time the terminal opens, and mobile devices keep the WebGL renderer disabled to avoid glyph artifacts
- Embedded CLI session terminals honor the same saved preferences for live, idle, ended, read-only, and interactive session views. Cursor blink still stays disabled for read-only/replay sessions, renderer changes apply on the next session mount, and WebGL never loads on mobile viewports.
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
- One-click **Sync** action in Remotes (`git pull --rebase` followed by push; it stops and surfaces an error instead of pushing when the pull conflicts or fails)
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
- In Git Manager's "Recent integration-branch advances" panel, entries are classified as `pending`, `reachable`, `subsumed`, `orphaned`, or `superseded`:
  - `pending`: actionable (not reflected in HEAD; Sync can help)
  - `reachable`: commit already reachable from HEAD
  - `subsumed`: equivalent patch content already landed under a different SHA (history rewrite/re-squash)
  - `orphaned`: recorded SHA no longer exists locally after history rewrite
  - `superseded`: recorded SHA still exists but is unreachable, and HEAD is already aligned with the local integration tip after a history rewrite (handled; no sync action applies)
- **Sync working tree** is shown only when there is at least one `pending` entry and HEAD is not already aligned with the integration tip; handled entries (`reachable`/`subsumed`/`orphaned`/`superseded`) can be dismissed from the panel.

Push follow-up (when shown):
- If the integration branch is ahead of `origin`, the banner can show push controls with ahead count
- Use **Push to origin** (or force-with-lease via **Advanced**) to publish the advanced branch tip
- If push is rejected (`rejected-non-ff` / `sha-mismatch`), the banner offers a Smart Pull retry path

Branch names are dynamic from merge/audit payloads; the banner is not hardcoded to `main`.

## OAuth Re-login Banner

The global OAuth re-login banner clears a provider row immediately after that provider successfully re-authenticates (from Settings → Authentication or Model Onboarding), instead of waiting for the next `GET /auth/status` poll interval.

For Claude/Anthropic OAuth credentials, the same `/auth/status` poll also attempts an automatic refresh when the stored OAuth credential has a refresh token and the access token is expired or within the refresh buffer. When that refresh succeeds, the banner clears for Claude without manual re-login and without waiting for a separate model request.

If the OAuth credential has no refresh token, the refresh request fails, or the provider is not Anthropic, the provider stays expired and the banner remains visible. Re-authenticate with manual re-login from **Settings → Authentication** or Model Onboarding.

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
`goal:*` run-audit events (`goal:injection-applied`, `goal:injection-skipped`, `goal:retrieval-invoked`) use the same timeline endpoint and are filterable with `startTime`/`endTime` query params.
Goal run-audit metadata is IDs-only (`goalIds` + counts/tool fields) and never includes goal titles/descriptions/prompt text.
For per-run aggregation, `GET /api/agents/:id/runs/:runId/cited-goals` returns `{ runId, taskId?, injectedGoalIds, retrievedGoalIds, citedGoalIds }`.

## Documents View

Documents view aggregates task documents and project markdown files.

Features:

- Group task documents by task ID (with revision history metadata)
- Search documents across tasks
- Open project markdown files with inline preview
- Jump directly from a document group to the owning task detail modal
- Toggle between raw text and rendered markdown using the **Markdown/Plain** button
- Highlight text in raw or rendered project-file previews, choose **Add comment**, and send the file path, selected snippet, and your comment to the **New Task** dialog

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

Project-file previews also support selection comments in both raw and rendered markdown modes. Select text, click **Add comment**, enter a short note, and Fusion opens **New Task** with a seeded description containing the file path, snippet, and comment.

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

- Use **New File** or **New Folder** in the browser header to create entries in the current folder; new files open in the editor after creation
- Source/text editing supports a **Line #** header toggle to show or hide line numbers in the editor gutter
- The line-number preference is saved per project and restored automatically when you switch projects
- In editable files and markdown preview mode, highlighted text exposes **Add comment** so you can send the file path, selected snippet, best-effort line range, and your note to the **New Task** dialog without copy/paste

## Memory View

Memory view provides a multi-file editor for project and daily memory files. Its file editors share the same highlighted-text **Add comment** affordance as the Files modal, so memory snippets can seed a New Task with file path, snippet, and comment context.

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

Goals view is a strategic-goals surface backed by the Goals REST API.

> No feature flag required.
> Current status: the `GoalsView` chunk is lazy-defined/prefetched in `App.tsx`, but it is not yet wired into the primary dashboard navigation.

What it shows:
- Header with active-goal count (`N active goals`) and an **Add Goal** action
- Goal cards with title, optional description, `Status: active|archived`, and a **Linked Missions** section
- Linked-mission chips navigate to Mission Manager, each chip has an unlink control, and the card picker hides missions already linked to that goal
- Empty state when no goals exist: `No goals yet. Add one to begin tracking strategic outcomes.`

Data behavior:
- Initial load: `GET /api/goals` (returns `{ goals }`)
- Create: inline Add Goal form posts `title` (required) + `description` (optional) to `POST /api/goals`
- Add-form drafting: **Draft with AI** sends the typed goal title to `POST /api/ai/draft-goal-description` and drops the returned `{ description }` into the description textarea for review/editing before save
- Edit: per-card inline form patches title/description via `PATCH /api/goals/:id`
- Archive/unarchive: `POST /api/goals/:id/archive` and `POST /api/goals/:id/unarchive`
- Linked missions: `GET /api/goals/:id/missions` for the reverse lookup, then `POST`/`DELETE /api/missions/:missionId/goals/:goalId` for link/unlink mutations

AI drafting behavior:
- The add-goal form enables **Draft with AI** once the title is non-empty
- Draft requests are readonly and use the same shared AI-text rate limiter as `/api/ai/refine-text` (10 requests per hour per IP)
- The backend drafts a concise plain-text strategic goal description from the title only; users can freely edit the generated description before saving

Active-goal cap behavior:
- Hard cap of 5 active goals (server-enforced)
- Warning banner appears when active goals are in the 3–5 range
- Cap violations (for create or unarchive) return HTTP 409 with `code: ACTIVE_GOAL_LIMIT_EXCEEDED` and are surfaced as inline goal errors

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

## Command Center

Command Center is the combined analytics and live-operations surface for a project: it pairs historical usage, cost, throughput analytics, live system telemetry, and a live Mission Control panel.

Navigation:
- Desktop/tablet: primary header view toggle, immediately after **Agents**
- Mobile: bottom nav tab, immediately after **Mailbox**
- Deep link: `?view=command-center`

Features:
- Global date-range picker in the header scopes the analytics tabs; **Mission Control** remains live rather than historical.
<!-- FNXC:CommandCenter 2026-06-19-23:54: FN-6755 moved team-specific operations out of Overview: org hierarchy and heartbeat pause/resume live in Team, while Overview keeps global AI engine, concurrency, and theme controls. -->
- **Overview controls dashboard** sits at the top of the Overview landing surface on desktop and mobile. It includes AI engine stop/start backed by `globalPause`, live scheduler status from executor stats, range sliders for `maxConcurrent`, `maxTriageConcurrent`, and `maxWorktrees` that persist through `/api/settings`, and a compact theme dropdown with the same color-chip swatches as Settings. These controls reuse existing APIs and App-level theme setters; they do not add a new backend route or second theme owner.
- **Overview** summarizes token usage/cost, autonomy, active nodes, sessions, agent runs, tasks done, model breadth, and real open signals, and includes the SDLC throughput funnel for the selected range at the bottom of the Overview content in loading, error, empty, and populated states. Its token total and Live activity snapshot token metric refresh on a bounded live cadence and animate number changes while preserving reduced-motion preferences. The sessions card uses the selected-range `ActivityAnalytics.sessions` value already loaded for the overview. The Live activity snapshot also shows the current board-state count for tasks in progress, independent of the selected analytics date range. Overview includes a graph-rich software-factory snapshot with the existing tokens-by-model bar, tool-category bar, real recharts token-share pie, and the daily activity multi-series line chart placed before the daily activity sparkline/trend so the richer line graph sits higher in the chart grid. These reuse the already-loaded tokens, tools, activity, and signals analytics; the signals count comes from `/api/command-center/signals` and renders unavailable (`—`) while the incidents-backed response is loading or unavailable. The chart reveal/glow accents are decorative and disabled when reduced-motion preferences are active. The SDLC completion rate is shown as a radial gauge and is calculated as cohort conversion from in-range triage entrants, so the rate is capped at 100% even when older tasks finish during the range.
- **Tokens** breaks down token totals, estimated cost, tasks, and per-model usage. Per-model and per-provider breakdowns use the task's analytics-only actually-used model snapshot when available, so usage from settings-resolved runs appears under the real runtime model instead of `(unknown)` without changing future model resolution; estimated cost uses the same snapshot-first, legacy-fallback model identity so those resolved runs price normally when the model is in the pricing table. It includes the existing token-usage-over-time chart, an additive recharts multi-series line graph, and a token-share pie backed by the same grouped token analytics; use the granularity control to switch the time-series request between hourly, daily, and weekly buckets. The token total and charts poll on a bounded cadence, keep the previous data visible during refresh, animate decorative count/bar transitions, and disable those animations for reduced-motion users.
- **Tools** shows autonomy ratio, tool-call volume, intervention counts, sessions, and tool categories. The area keeps the existing category bar and adds a recharts category-share pie from `ToolAnalytics.byCategory`. There is intentionally no tools line chart yet because `ToolAnalytics` does not expose a per-day tool trend; the dashboard does not fabricate one or call a new endpoint.
- **Activity** tracks sessions, messages, active nodes, active agents, agent heartbeat runs, and stickiness. Agent-run sheets show total, active, completed, and failed runs for the selected range, and the Agent runs/day sparkline trends runs by `agentRuns.startedAt`. The area keeps the existing live animated line charts for messages/day, active agents/day, active nodes/day, and combined throughput/day (`messages + active agents + active nodes`), and adds a recharts multi-series line graph for messages, active agents, and agent runs plus an agent-run outcome pie from the existing `agentRuns` split. These charts reuse the existing activity analytics endpoint, refresh on a bounded 15-second cadence while mounted, keep the previous data visible during refreshes, and disable decorative draw-on motion for reduced-motion users.
- **Productivity** separates outcome counters (commits and pull requests), task-duration stats, and volume proxies such as modified files, lines changed, and files by language. The task-duration block counts done tasks completed in the selected range and shows average, median, p90, and total active execution time from `cumulativeActiveMs`; when no qualifying duration data exists, duration values render the unavailable `—` sentinel rather than `0`. It keeps the files-by-language bar and adds a language-share pie from `ProductivityAnalytics.byLanguage`. There is intentionally no productivity line chart because the current productivity response has no per-day throughput or completion time series; no new endpoint is called.
- **Team** shows the read-only agent org chart, heartbeat pause/resume backed by the existing `enginePaused` setting, a per-agent analytics table, tokens-by-agent and tasks-done-by-agent charts, and a real token-share pie from the same per-agent token totals. The org chart is styled by Command Center's Team CSS, not lazy Agents view CSS, and org nodes show only agent names so role/title description/meta text does not clutter Team operations. Metrics come only from the project-scoped `tasks` and `agents` tables: token totals and estimated cost are summed from the `tokenUsage*` columns by `assignedAgentId`, files changed counts parsed `tasks.modifiedFiles` paths, tasks done counts `column = 'done'` moves in the selected range, and in-progress / in-review values reflect current task columns. Agent name, role, and live state come from the `agents` table; deleted-agent task history falls back to the raw agent id instead of crashing. The tab uses `/api/command-center/team`, adds no schema, never calls GitHub, and intentionally leaves per-agent issues filed/fixed to FN-6653. Team has no per-day analytics series today, so it intentionally does not render a line chart or fabricate a trend. Decorative chart reveal motion uses duration tokens and is disabled for reduced-motion users.
- **Ecosystem** shows active model breadth, per-model task activity, and real plugin activations for the selected range. Plugin activation counts come from project-scoped plugin/extension load events via `/api/command-center/plugin-activations`; if no activation rows exist in range, the metric renders unavailable (`—`) rather than fabricating zero. The tab still reuses the tokens analytics endpoint grouped by model, adds a task-share-by-model pie from `TokenAnalytics.groups`, and renders a tokens/tasks trend line when `TokenAnalytics.series` buckets are present; if series buckets are absent, no synthetic trend is shown.
- **GitHub** shows local GitHub issue flow for the selected range: **Filed by Fusion** counts tasks with a persisted `githubTracking.issue`, **Fixed by Fusion** counts tasks imported from GitHub source issues (`sourceIssueProvider = "github"`) that are currently in `done`, using the persisted `sourceIssueClosedAt` / `TaskSourceIssue.closedAt` close time when the reconciler has observed it. Rows that predate the field or have not been observed closed fall back to task `updatedAt` as the documented completion-time approximation; Fusion never fabricates a close timestamp and this analytics path never calls GitHub, the `gh` CLI, or any external network source. To make historical fixed dates exact, use **Backfill exact close times** in the Fixed by Fusion card; the dashboard calls the project-scoped manual `POST /api/git/github/backfill-source-issue-closed-at` endpoint in `{ offset, limit }` batches until `hasMore` is false, then surfaces the accumulated `scanned`, `filled`, `skipped`, and `errors` counts. The endpoint fetches real GitHub `closed_at` values once, fills only missing `sourceIssueClosedAt` values, and never runs automatically or from analytics-time rendering. The area shows filed/fixed/net stat cards, a filed-vs-fixed pie, a filed/fixed recharts trend line, existing daily sparklines, and a by-repository bar breakdown.
- **Signals** is backed by the project-scoped `/api/command-center/signals` endpoint, which aggregates real rows from the local `incidents` table. It shows total/open/resolved counts, MTTR when resolved incidents have enough timestamps, and source/severity/status breakdowns; an empty incidents table renders honest zero counts with MTTR unavailable rather than fabricated signal volume. It adds an open-vs-resolved status pie from the same response. Signals has no per-day series today, so it intentionally does not render a line chart or fabricate a trend. External connectors that ingest third-party signals into incidents are tracked separately in FN-6706.
- **System** is the canonical system-telemetry destination. It reuses `GET /api/system-stats` with no new endpoint, renders live radial gauges for app CPU, host memory, and heap usage, keeps a small client-side rolling buffer for CPU/memory/heap trend sparklines, adds a recharts CPU/memory/heap line from that same rolling buffer, and adds a task-by-column pie alongside the existing tasks-by-column and agents-by-state bars. The Vitest process count, manual kill confirmation, auto-kill toggle, threshold controls, and last-auto-kill timestamp moved here unchanged; the standalone System Stats modal and its desktop Header/mobile More affordances were removed.
- **Mission Control** shows live active sessions/runs/nodes, current sessions and nodes, an animated live activity snapshot, and a live SDLC funnel; when idle it reports that live updates resume when work starts. No additional pie or line chart is rendered because the live SDLC funnel already visualizes the panel's only quantitative distribution (`snapshot.columns`), while sessions/nodes are live control lists rather than categorical analytics. Motion-heavy accents respect reduced-motion preferences.
- CSV exports are available from the analytics endpoints with `?format=csv`. The Activity CSV includes daily `agentRuns` values plus summary rows for `(agentRuns.total)`, `(agentRuns.active)`, `(agentRuns.completed)`, and `(agentRuns.failed)`.

Rendering invariants:
- On mobile (`max-width: 768px`), `.cc-tabpanel` remains the sole vertical scroll owner for every chart-bearing tab. Shared chart primitives (`Bar`, `StackedBar`, `Sparkline`, `LineChart`, `RadialGauge`, `Funnel`, `TokenSeriesChart`, and the Command Center recharts wrappers) must shrink within the tabpanel, keep non-zero usable height, avoid stretch/clipping artifacts, and never introduce a competing vertical overflow container.
- Mobile chart text must not rely on min-content luck: bar labels, values, token-series axis labels, funnel headers, radial labels, legends, and chart tracks need explicit `min-inline-size: 0`, wrapping, or ellipsis rules so long model/agent/repo labels cannot crush the track or create hidden horizontal overflow in a real browser.
- On tablet (`min-width: 769px` and `max-width: 1024px`), `.project-content`, `.command-center`, and `.cc-tabpanel` keep the same definite flex/min-height scroll-owner chain, while the live strip and chart grids collapse before they can create document-level horizontal overflow.
- Command Center stat cards, overview chart cards, live strips, table wrappers, Team chart panels, token-series plots, system control cards, and gauge/chart cards share the same tokenized rhythm: `--space-md` gaps/padding for card-like surfaces, `1px solid var(--border-subtle)` borders, `--radius-md` radii, and `--surface-1` backgrounds. Area-specific accents may use `color-mix(...)`, but layout, border, radius, text color, and motion must stay on design tokens, with the named 4px spacing scale (`--space-xs`/`sm`/`md`/`lg`/`xl`/`2xl`) as the canonical vocabulary.
- The dashboard browser-layout smoke includes a `[data-smoke="command-center-charts"]` fixture that loads emitted lazy Command Center CSS and verifies representative recharts pie, line, and empty states at mobile (390×844) and desktop breakpoints. The fixture asserts non-zero chart and SVG heights, visible empty-state text, no internal/page horizontal overflow, and no chart-level vertical scroll owner before chart layout changes are considered verified.

Data states:
- Overview shows a loading state while core analytics settle, then shows `No usage data yet. Run some agents to populate the Command Center.` only after the selected range has settled with no core usage data. Overview, Tokens, Tools, Activity, Productivity, Team, Ecosystem, GitHub, Signals, System, and Reliability omit their additive recharts cards in loading/error/empty states, so non-populated data never leaves an empty chart shell.
- GitHub issue analytics is local and additive: empty filed/fixed totals keep the stat cards and historical backfill button available while omitting empty chart shells; malformed historical `githubTracking` JSON is skipped instead of breaking the Command Center.
- Team analytics renders its shared loading/error/empty states for null or zero-agent responses, omits empty chart shells for zero-value datasets, and keeps the Command Center tab panel as the mobile scroll owner.
- System telemetry keeps the previous snapshot visible during refresh failures, renders a first-sample CPU `Sampling…` state without NaN values, shows zero-value task/agent bars for empty collections while omitting the zero-value task-distribution pie, and keeps the Command Center tab panel as the mobile scroll owner.
- Signals is best-effort over local incidents data: if the project has no incidents, the Signals area shows its empty state, omits its status pie, and other Command Center metrics remain valid; endpoint errors surface as the shared analytics error state instead of silently swallowing a missing route.

## Reliability View

Reliability view summarizes in-review pipeline health so operators can spot bounce/merge instability trends without leaving the dashboard.

Navigation:
- Desktop and mobile: **Command Center → Reliability** tab
- Legacy persisted `reliability` view state redirects to Command Center so existing browser sessions land on the new tab container instead of an invalid top-level view.

Features:
- Headline 7-day in-review success rate (derived as `1 - inReviewFailureRate7d`) with color thresholds: success for `≥95%`, warning for `≥90%`, error below `90%`; shows **Insufficient data** when the metric is null
- Per-day in-review flow table showing tasks that entered in-review versus tasks bounced back to in-progress
- **Entered vs bounced trend** line chart in the **In-review flow** card, using the same per-day rows as the table and respecting the **Show/Hide empty days** filter
- In-review duration percentiles (P50 and P95) plus sample count
- Merge-attempt distribution stats including mean, max, and histogram buckets
- **Attempts distribution** pie chart in the **Merge attempts** card, visualizing the merge-attempt histogram buckets and showing `No merge attempt data` when no histogram data exists
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

- Editable tasks with descriptions show **Summarize as title** beside the read-mode title; it asks AI to generate a concise title from the description and saves it without opening the edit form.
- The **Chat** tab includes an expand/collapse control that lets the transcript and composer fill the task-detail modal, then restores the normal header, tabs, and action footer when collapsed.
- The priority chip in task metadata is an inline picker: you can change priority directly without entering full edit mode.
- Execution mode has a read-mode inline lightning-bolt toggle for Fast mode on/off without opening the full edit form.
- These two metadata controls share matched sizing/alignment in read mode (including mobile wrapping) so they behave like a single polished control group.
- Task metadata keeps priority, execution mode, provenance, optional PR context, and compact `Created` / `Updated` timestamps in one wrapping row across desktop and mobile widths; recent timestamps render as relative time (`just now`, `Xm`, `Xh`, `Xd`) and older values switch to short month/day dates.
- Eligible existing tasks (triage, todo, in-progress, in-review) expose a **GitHub tracking** section directly in Task Detail, even when tracking is currently disabled.
- The GitHub tracking section now defaults to a compact summary row; use the disclosure arrow to expand linked-issue details plus tracking edit controls.
- Backstop reconciliation runs every 15 minutes to close tracked GitHub issues for soft-deleted and archived tasks even after restart; the sweep is paginated so large archive backlogs are eventually drained.
- In shared task edit/create forms, GitHub Tracking appears at the bottom of **More options**, after **Workflow Steps**.
- From this section you can explicitly enable/disable tracking and manage a per-task repo override (`owner/repo`). Clearing the override saves `null` and falls back to project/global defaults.
- In `in-review`, pull-request controls/status (including stall badges) are in a dedicated **Pull Request** tab instead of the Definition tab.
- Task Detail and list split-pane PR affordances follow the live project auto-merge setting: when auto-merge is off, manual **Create PR** / merge actions are shown; when it is on, the tab shows the automatic auto-merge hint unless a per-task override changes the effective behavior.
- The **Create Pull Request** modal now offers in-app remediation for every blocking preflight check. If `branchOnRemote` is false, use **Push branch to remote** and Fusion will publish `fusion/<task-id-lower>` to `origin` and refresh preflight. If `conflictsWithBase` is true, use **Resolve conflicts with AI** and Fusion will use an AI coding agent to resolve merge markers on the task branch, commit and push real merge changes, or report success without an empty commit when the selected base is already merged; preflight then refreshes so normal PR creation can continue once all checks pass.
- The modal shell renders immediately: preflight checks and PR options load independently of AI-generated title/body metadata, so slow AI suggestions no longer block base-branch selection, diagnostics, or manual PR authoring.
- AI title/body generation is bounded to 60 seconds and is canceled if the dialog request disconnects; on timeout/cancel, Fusion falls back to deterministic task-based PR title/body content instead of leaving the spinner stuck forever.
- The **Review** tab is separate from **Comments**: Review shows actionable PR/reviewer feedback and same-task revision controls, while Comments remains the general collaboration thread.
- **Request revision** in Review resumes work on the same task ID (no refinement task): `in-progress` tasks get steering injection, while `in-review` tasks are moved back to `in-progress` for the same branch/worktree revision pass.
- Review supports a manual **Refresh** action in-place: PR mode pulls latest GitHub review state/decision, while direct mode rehydrates reviewer-agent feedback from persisted task data (no GitHub call).
- For shared `branch_groups` (tasks with `branchContext.groupId`), PR merge mode opens and tracks one group-level PR from the group integration branch to the project default branch; member tasks share that PR state.
- In direct/non-PR auto-merge mode, Review renders normalized reviewer-agent feedback (verdict/step/timestamp/detail) with dedicated loading/error/empty states; it does not require users to read raw agent logs.

### Legacy auto-merge stamp cleanup

Settings → Merge includes **Legacy auto-merge stamp cleanup** for operators auditing tasks that inherited historical in-review `autoMerge` stamps. The panel loads a dry-run candidate list, shows task IDs and current columns, and only reveals the destructive **Clear legacy stamps** action when candidates exist. Applying the cleanup requires the browser confirmation prompt, calls the maintenance apply endpoint, and then refreshes the dry-run list so cleared tasks disappear.

Use this panel when upgrading a project with pre-FN-6245/FN-6277 in-review rows before relying on per-task auto-merge overrides. It only targets stamps tagged as legacy provenance; explicit user overrides remain intact.

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

The **Chat** tab sits between Definition and Logs and presents a live, chat-styled transcript of task agent output. Consecutive entries are grouped by role and labeled as Planner, Executor, Reviewer, or Merger; legacy log rows without an agent role use the neutral Agent fallback. Agent group headers and user message headers show a small muted relative timestamp (for example, “just now”, “1m ago”, or “2h ago”) based on the transcript timestamp, while agent group metadata still includes the entry count. Consecutive text/message chunks inside a role group render as one continuous markdown bubble, while consecutive tool/tool-result/tool-error rows collapse into one expandable, compact tool-call summary that stays collapsed by default; the summary counts tool invocations, lists deduped tool names with overflow, and shows an error count when failures are present, while the expanded body pairs each call with its result or error in dense entry cards. Thinking entries render in a collapsible block that starts expanded. The transcript opens at the latest output whenever the tab loads or becomes active, then follows new live output when you are already near the bottom while preserving your scroll position when you review older messages. When older task-agent history exists, scrolling to the top or selecting **Load previous messages** prepends earlier transcript entries without moving the message you were reading. When you scroll away from the bottom of a populated transcript, a sticky **Latest** button appears inside the transcript so you can jump back to the newest message and resume live follow. For non-`done` tasks, the composer sends guidance through the same steering path used by comments, including active assigned `in-progress`/`in-review` sessions and messages queued when no session is currently live. When no active or steerable agent session will reply immediately, the composer shows an idle warning hint that no agent is currently working on the task and that the sent message is saved for the next run; the input and Send button remain usable. On a `done` task, sending a Chat message starts a refinement task using the typed text as feedback and shows a success toast with the new task ID; the current task detail modal remains on the completed task. The task-detail Chat tab keeps the composer pinned and visible on mobile and desktop while the transcript scrolls internally; its textarea placeholder reads “Steer the currently executing agent” for steering mode and switches to refinement copy for completed tasks, with the same inline, icon-only send affordance to the right of the input at every breakpoint. In the composer, plain **Enter** sends, **Shift+Enter** inserts a newline, and **Cmd/Ctrl+Enter** remains a supported send shortcut.

The **Logs** tab includes an **Agent Log** subview designed for debugging long-running and tool-heavy sessions:

- Full `thinking`, `tool_result`, and `tool_error` payloads are shown without entry-content truncation.
- Raw tool output is rendered as multiline blocks, preserving line breaks and indentation.
- The Activity and Agent Log subviews show loading indicators while their first async history/detail request is pending, so empty states only appear after the relevant fetch completes.
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

The Skills view now supports the full browse-and-install loop for skills.sh entries: use **Skills Catalog** to search the catalog, click **Install** on any card with a source repository, and the dashboard will run the same installer as the CLI (`npx skills add <owner/repo> -y -a pi`, with `--skill <slug>` when applicable). On success, the view refreshes **Discovered Skills** immediately so the newly installed skill appears without a page reload.

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

### POST /api/skills/install

Install a catalog skill into the current project.

**Request Body:**
```json
{
  "source": "owner/repo",
  "skill": "example-skill"
}
```

**Behavior:**
- Validates `source` in `owner/repo` format before spawning anything
- Runs `npx skills add <source> -y -a pi`
- Appends `--skill <skill>` when `skill` is provided
- Uses the scoped project root as `cwd`, so installed files land in the current project's skill directories

**Response:** `200 OK`
```json
{
  "success": true
}
```

**Error Responses:**
- `400 Bad Request` — missing source
  ```json
  { "error": "source is required", "code": "invalid_body" }
  ```
- `400 Bad Request` — malformed source
  ```json
  { "error": "Invalid source format. Use owner/repo.", "code": "invalid_source" }
  ```
- `404 Not Found` — adapter not configured
  ```json
  { "error": "Skills adapter not configured", "code": "adapter_not_configured" }
  ```
- `502 Bad Gateway` — installer failed/timed out/could not start
  ```json
  { "error": "installer failed", "code": "install_failed" }
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

PR tab note: `PrPanel` cards use tokenized `.pr-card` grid spacing (`padding` + `gap`) and boxed token-based hint callouts for empty/loading states. Manual PR merges now show in-progress feedback (`Merging…` button state + status hint) until the merge call resolves.

The `index.html` shell is templated server-side: the server injects a per-user `<link rel="modulepreload">` for the last-used `taskView` chunk, sourced from Vite's `dist/client/.vite/manifest.json` and `kb:<projectId>:kb-dashboard-task-view` in localStorage.

### Design tokens

`styles.css` is the source of truth for tokens (`--space-*`, `--radius-*`, `--shadow-*`, `--duration-*`, `--transition-*`, `--font-*`, `--header-height`, `--mobile-nav-height`, `--standalone-bottom-gap`, `--overlay-padding-top`) and color variables (`--bg`, `--surface`, `--card`, `--text`, `--text-muted`, status colors `--triage`/`--todo`/`--in-progress`/`--in-review`/`--done`, semantic `--color-success`/`--color-error`/`--color-warning`/`--color-info`, status backgrounds `--status-*-bg`).

**Always reference tokens. Never hardcode pixels, hex, or `rgba()` in component CSS** — global/theme token CSS is also covered by `global-theme-css-no-raw-rgba.test.ts`, so raw `rgba()` belongs only in explicit `var(--token, rgba(...))` fallbacks. For translucent backgrounds use `color-mix(in srgb, var(--color) X%, transparent)`, not `rgba()`.

Command Center chart surfaces are a stricter token-only zone: `CommandCenter.css`, `areas/areas.css`, and `charts/charts.css` should avoid raw color fallbacks and hardcoded dimensions in component rules, keep secondary copy on `--text-muted`, use canonical `--accent` / `--text` for generic accent and primary text styling, use `--duration-*` for animation durations, and encode mobile chart invariants with shared classes rather than one-off area styles. Hand-rolled chart primitives cycle through the existing semantic palette (`--accent`, workflow status tokens, and success/warning/error tokens) rather than adding one-off chart color aliases. The undefined `--color-accent` / `--text-primary` aliases are forbidden under `components/command-center/**` and guarded by `command-center-css-token-canonicalization.test.ts`.

Non-Command-Center dashboard CSS uses `--text` as the canonical primary text token. The undefined `--text-primary` alias is forbidden outside `components/command-center/**` and guarded by `packages/dashboard/app/__tests__/text-token-canonicalization.test.ts`.

### Theme system

Dark/light modes via `data-theme`; 66 color themes via `data-color-theme` (lazy-loaded from `app/public/theme-data.css`), including the Shadcn zinc-neutral theme with an orange default highlight/accent and its color family: Shadcn Blue/Green/Red/Purple/Pink/Orange/Yellow, Shadcn Mono (grayscale with red accent), and Shadcn Black (pure black and white). Air is the minimal, borderless, paper-like preset with near-monochrome tokens and CSS-only chrome flattening.

- **Base tokens** (`--bg`, `--surface`, etc.) — redefine in `:root`, `[data-theme="light"]`, and every theme block.
- **Semantic tokens** (`--autopilot-pulse`, `--event-error-text`, `--badge-mission-*`, `--fab-*`) — `:root` + `[data-theme="light"]` only; no per-color-theme overrides.
- **Status tokens** (`--triage`, `--todo`, etc.) — redefine per theme block.

`status-colors-theme.test.ts` iterates all theme blocks to catch regressions.

### Component classes

Reuse existing primitives from `styles.css`:
- **Buttons**: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-warning`, `.btn-sm`, `.btn-icon`, `.btn-icon--active`, `.btn-badge`. All inherit `:focus-visible` via `--focus-ring-strong` and `:active` via `transform: scale(0.97)`.
- **Modals**: `.modal-overlay[.open]`, `.modal`, `.modal-lg`, `.modal-header`, `.modal-close`, `.modal-actions`, `.modal-actions-left/right`. Overlay pads top with `--overlay-padding-top`. Overlay dialogs should render through `createPortal(..., document.body)` so `position: fixed` overlays escape transformed, contained, or fixed ancestors. Resizable modals using `useModalResizePersist(...)` get a shared bottom-right touch/mouse resize grip on tablet and desktop; mobile sheets stay full-screen and grip-free.
- **Forms**: `.form-group`, `.input`, `.select`, `.checkbox-label`, `.form-error`. Inputs in `.form-group` get focus styles automatically.
- **Cards**: `.card`, `.card-header`, `.card-id`, `.card-title`, `.card-meta`, `.card-status-badge--{triage,todo,in-progress,in-review,done,archived}`.
- **Utility**: `.touch-target` (44px min), `.visually-hidden`.

Don't create parallel button/form variants — add states (`:hover`, `:focus-visible`, `:active`) to the existing primitives.

Small fixed notification cards (for example the first-task GitHub star prompt) should reuse `.card`, `.btn`, and `.btn-icon`, anchor themselves with tokenized `position: fixed` offsets, and include a mobile `@media (max-width: 768px)` override so they clear the mobile nav/FAB region.

### Mobile responsive

Breakpoints: 768px (primary mobile), 1024px (tablet `min-width: 769px and max-width: 1024px`), 640px (compact), 480px (xs). Mobile overrides go in `@media (max-width: 768px)` blocks at the bottom of `styles.css` after base styles.

**Bottom spacing:** `--mobile-nav-height` (44px) + `env(safe-area-inset-bottom, 0px)` + `--standalone-bottom-gap` (0/8px PWA). All bottom-positioned mobile elements compose those. When the soft keyboard opens, the mobile nav bar stays pinned to page bottom cross-platform; the executor footer keyboard-collapse pin is iOS-only. On Android (`interactive-widget=resizes-content`), the footer keeps its stacked position above the nav bar to avoid overlap after keyboard dismiss.

**Footer-safe fill layouts:** View wrappers that reserve footer/mobile-nav space (for example `.project-content`) should be flex containers with `min-height: 0` / `min-width: 0`, and child surfaces like `.board` should use `flex: 1 1 auto` plus the same min-size guards. Workflow-mode board wrappers (`.board-workflow-view` → `.board-workflow-columns`) also keep a definite `height: 100%`/`max-height: 100%` chain so the workflow toolbar and columns split the available space on tablet as well as desktop/mobile. This keeps the board/columns stretched between the header and fixed bottom bars across desktop, tablet, and mobile while allowing internal scroll regions to own overflow.

**Touch targets:** Standing button-freeze directive supersedes per-button touch-target guidance. For non-button elements, primary controls (nav bar, FAB, tab action rows, modal CTAs, list-row tap targets, form controls) must be ≥36px on mobile. Secondary controls inside a card/list-row where the row itself is the tap target stay compact (24–28px or small chips).

**Safe area:** `max(var(--space-md), env(safe-area-inset-left, 0px))` for notch-aware horizontal padding.

### Secrets management in Settings

Manage project and global secrets directly inside **Settings → Project → Secrets**. This section embeds the existing Secrets UI in the settings content panel so you no longer need a footer "Manage secrets" link to leave the modal.

### Lazy-Loaded Heavy Views

These 22 views are lazy-loaded via `React.lazy()` with `<Suspense fallback={null}>`. `prefetchLazyViews()` warms App-level chunks once on mount via `requestIdleCallback`; AppModals lazy modal imports (`SettingsModal`, `WorkflowNodeEditor`, `SetupWizardModal`) are part of the same inventory. **Do not make these eager.**

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
- `CommandCenter`
- `EvalsView`
- `TodoView`
- `GoalsView`
- `StashRecoveryView`
- `PullRequestView`
- `SetupWizardModal`
- `SettingsModal`
- `WorkflowNodeEditor`
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
- For chat-style composer fields use `packages/dashboard/app/hooks/useAutosizeTextarea.ts`. Pattern: `height = "auto"` then clamp `scrollHeight` to min/max in `useLayoutEffect`. Pair with `resize: none`; keep `overflow-y: hidden` while under the max-height cap and switch to `overflow-y: auto` only after content exceeds the cap.

### File-path links

Reuse `packages/dashboard/app/utils/filePathLinkify.tsx` and `FileBrowserContext`. Wrap plain text with `linkifyFilePaths(...)`, mixed JSX with `linkifyReactChildren(...)`. Mount under `FileBrowserProvider` and route clicks through its `openFile(path, { workspace?, line?, col? })`.

### Common pitfalls

- **`--surface-hover` undefined** — reference with a fallback (`var(--surface-hover, rgba(0,0,0,0.03))`) or define explicitly.
- **BEM specificity** — when a container state class and an element modifier target the same node, the container can win. Use `:not(.modifier)` to scope.
- **CSS `@media` detection** — track brace depth to confirm a rule is mobile-scoped; don't scan backwards for the nearest `@media`. Many components are global even if visually mobile-only.
- **Mobile board scroll-snap (FN-001)** — `scroll-snap-type: x mandatory` on mobile `.board` causes iOS Safari to compress the viewport when switching from ListView. Use `x proximity` + `overflow-anchor: none`.
- **`lucide-react` icon adds** — update `vi.mock("lucide-react")` test mocks immediately; missing exports cascade.
- **`.spin` is global** — don't redefine the generic spin keyframes in component CSS.
- **Animation durations use `--duration-*`, never `--transition-*`** — transition tokens carry a `duration easing` pair; substituting one into an `animation` shorthand that names its own easing (or into `calc()`) is invalid at computed-value time and silently resolves the whole declaration to `animation: none`. Enforced by `animation-duration-tokens.css.test.ts`; see `docs/solutions/ui-bugs/css-animation-frozen-by-transition-token-shape-mismatch.md`.

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

## Shared branch groups

The dashboard now exposes branch-group visibility and controls for shared planning/mission branches.

- `GET /api/branch-groups` lists groups with completion (`landed`/`total`) and tracked PR metadata.
- `GET /api/branch-groups/:id` returns group details (shared branch, members, per-member landed state, completion, PR state).
- `POST /api/branch-groups/assign` is the supported online grouping path to attach/detach tasks (`{ taskId, groupId|null, branchName? }`).
- `POST /api/branch-groups/:id/promote` triggers the engine promotion flow (`promoteBranchGroup`) and returns promotion/PR status.

UI surfaces:

- Subtask planning interview shows a grouped indicator when `assignmentMode=shared`.
- Task cards show grouped/shared branch metadata for grouped tasks.
- Clicking either grouped badge opens the dedicated **Group Task Modal** for that branch group.
- Task detail renders a branch-group card with member landed progress.
- In Task Detail Logs on mobile, the branch-group card includes a collapse/expand toggle so logs can reclaim vertical space while keeping group summary progress visible.

The Group Task Modal shows shared branch name/status, member list (`taskId`, title, column, landed state), quick links to open each member task detail, completion progress (`X of Y members finished`), and tracked PR state when present. It live-refreshes from the same dashboard task-update stream and ignores stale cross-project events.

Both the modal and branch-group card are completion-gated: while members are still pending, they show progress only. PR / merge controls are only revealed after all members are landed into the shared branch. When auto-merge is off, promote/open-PR is explicit user action (no automatic push-to-origin behavior).

### CLI-onboarding backfill runbook

Use the assign endpoint to place paused CLI-onboarding tasks into a single shared group rooted on `feature/cli-onboarding`:

```bash
for id in FN-5805 FN-5806 FN-5807 FN-5808 FN-5809 FN-5810 FN-5811 FN-5812 FN-5813 FN-5814 FN-5815 FN-5816; do
  curl -sS -X POST "http://127.0.0.1:4040/api/branch-groups/assign" \
    -H 'content-type: application/json' \
    --data "{\"taskId\":\"$id\",\"branchName\":\"feature/cli-onboarding\"}"
done
```

If the endpoint is unavailable on the running dashboard build, the response will be `{"error":"Not found"}` until a build containing the branch-group router is deployed.
