# @fusion/dashboard

Web-based dashboard for managing Fusion tasks. Provides a visual kanban board, list view, and git repository management tools.

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
- **Robust AI Response Parsing**: Handles malformed or partial AI output gracefully — extracts JSON from markdown code blocks, prose-surrounded responses, and truncated output. Automatically repairs common issues (missing closing braces, trailing commas) before retrying.
- **Automatic Recovery**: When the AI returns unparseable output, the system makes one retry attempt prompting the AI for clean JSON before surfacing an actionable error to the user
- **Actionable Errors**: If parsing fails after recovery, the error message includes guidance (e.g., "Please try again" or "start a new planning session") rather than raw JSON parse errors
- **Progress Tracking**: Visual progress indicator showing question number
- **Back Navigation**: Revisit previous answers during the session
- **Example Suggestions**: Quick-start chips with common task templates
- **Dependency Selection**: Toggle existing tasks as dependencies
- **Keyboard Navigation**: Tab through options, Enter to submit, Escape to close
- **Mobile-Safe Inputs**: Text inputs (initial plan, question responses, summary description) use 16px font size on mobile viewports to prevent browser zoom-on-focus
- **Background Resume with Catch-up**: Planning sessions can be sent to background and resumed later. When resuming a session that's already awaiting input, the UI immediately displays the current question and connects to the server stream for real-time updates. The server emits a catch-up question event for late subscribers, ensuring the UI never gets stuck in a "loading" state when the backend already has a next question.

**API Endpoints**:
- `POST /api/planning/start` - Begin planning session (`{ initialPlan }`)
- `POST /api/planning/respond` - Submit response (`{ sessionId, responses }`)
- `POST /api/planning/cancel` - Cancel session (`{ sessionId }`)
- `POST /api/planning/create-task` - Create task from summary (`{ sessionId }`)

### Task Management
- **Kanban Board**: Drag-and-drop task management across columns (Triage, Todo, In Progress, In Review, Done). On touch devices, horizontal swipes that start on a card still scroll the board between columns; only quick taps open the task detail modal.
- **Inline Editing**: Quick-edit a task's description directly on the board for Triage and Todo columns. The editor opens as a taller multi-line editing area (4 visible lines) for comfortable editing of longer descriptions, and auto-grows to fit existing content. Double-click a card or use the pencil icon — visible on hover for desktop, always visible on mobile for touch accessibility. Inline editing changes only the description; the title is preserved. To edit both title and description, use the task detail modal.
- **Task Detail Editing**: Edit task title and description directly in the task detail modal. Click the pencil icon in the modal header (available for Triage and Todo tasks) to enter edit mode. Save and Cancel actions appear in the modal footer alongside a keyboard shortcut hint, keeping editing controls consistent with other modal action patterns.
- **List View**: Alternative tabular view for tasks with sorting and filtering. The "Hide Done" toggle hides both Done and Archived tasks for an active-work-only view.
- **Model Selection at Creation**: Choose executor and validator AI models while creating tasks from the board or list view, or leave them unset to use the global defaults. Quick-add model dropdowns in both the board triage column and the list view honor saved favorite providers and pinned models, matching the rest of the dashboard model UI. Saved model presets are available in every new-task model-selection surface — the full New Task form (`TaskForm`/`NewTaskModal`), the board inline create card (`InlineCreateCard`), and the list-view quick entry box (`QuickEntryBox`). Users can choose between default behavior, a saved preset (which applies its executor/validator values in one click), or custom per-model overrides; returning to default clears all overrides, and manual model selection exits preset mode cleanly.
- **AI-Assisted Creation Controls**: Plan, Subtask, and Refine buttons appear directly below the description textarea in all task creation surfaces (quick entry box, inline create card, and task form modal). These description-adjacent controls make AI-assisted creation and refinement feel directly associated with the text being edited. Deps, Models, and Save actions remain in the expanded controls footer.
- **Layered Model Dropdowns**: Shared model combobox menus render in a top-level portal attached to `document.body`, so they stay above board columns and scrollable modal content instead of being clipped behind surrounding dashboard surfaces. The dropdown constrains horizontal overflow — long model IDs and provider labels truncate with ellipsis rather than creating sideways scrolling, keeping the menu usable on smaller viewports. On mobile viewports (≤640px), the quick-entry Models menu widens to fill the viewport (minus side padding) and remains viewport-clamped for comfortable model selection without horizontal crowding.
- **Fuzzy Model Search**: Model dropdown search (`filterModels`) supports fuzzy matching so users can find models despite minor typing imperfections. Three matching strategies are applied in order (first match wins): (1) **separator-insensitive substring** — hyphens, underscores, dots, and slashes are stripped before comparison, so `gpt4o` finds `gpt-4o`; (2) **subsequence matching** (≥ 3 chars) — characters must appear in order within a single token but need not be contiguous, so `cld` finds `claude`; (3) **typo tolerance** (≥ 4 chars) — Damerau-Levenshtein edit distance ≤ 1 supports single-character insertion, deletion, substitution, and adjacent transposition, so `sonet` finds `sonnet`. Multi-term space-separated queries use AND logic. Result ordering is stable (input-array order, no score re-sorting). Exact and substring matches from the original implementation continue to work unchanged.
- **Bulk Model Editing**: Update AI model configuration for multiple tasks at once in the list view. Select tasks via checkboxes (archived tasks excluded), then use the "Bulk Edit Models" toolbar with three explicit states per lane: **No change** (leave that lane untouched in the batch payload), a concrete model selection (apply that provider/model pair to all selected tasks), or **Use default** (send `null` provider/model to clear task-level overrides and fall back to project/global defaults). Apply stays disabled until at least one lane is set to a concrete model or **Use default**. Selection persists in localStorage across page reloads.
- **Task Details**: View full task specifications, agent logs, and attachments. The task detail modal uses a top-level tab bar with the following tabs: **Definition**, **Logs**, **Changes** (for in-progress/in-review/done tasks), **Comments**, **Model**, and **Workflow** (when workflow steps are configured or the task has previous workflow results). **Activity** and **Agent Log** are subviews within the unified **Logs** tab — click Logs, then toggle between Activity (task lifecycle events, default) and Agent Log (live agent output). In the Activity timeline, action and outcome text use high-contrast, theme-aware tokens for easier scanning, while timestamps remain intentionally secondary so chronology stays visible without competing with event content. The Agent Log subview expands to fill the full modal body height above the action bar, providing maximum vertical space for watching live agent output. The Agent Log header shows the effective executor, validator, and planning/triage model names resolved from task-level overrides or project/global settings fallbacks, matching the same resolution order the engine uses at runtime. A **Markdown/Plain toggle** in the Agent Log header switches between formatted markdown rendering (default) and literal plain-text display — useful for debugging raw agent output, checking escaped markdown syntax, or inspecting exactly what the agent emitted without formatting. The toggle applies to `text` and `thinking` entries only; tool entries always render as plain text. React-markdown handles sanitization in markdown mode (no raw HTML is executed); plain-text mode uses React's built-in text escaping for safe literal output. The refinement modal positions the "Create Refinement Task" button adjacent to the feedback textarea alongside the character count, creating a tight input group that connects the submit action directly to the text being edited. The **Changes** tab for done tasks loads the diff from the recorded merge commit (`mergeDetails.commitSha`) via the `/api/tasks/:id/diff` endpoint rather than requiring a live worktree — changes remain visible even after the worktree is cleaned up. Done tasks **without** a recorded `commitSha` do not attempt to fetch a detailed file diff; instead, the tab shows a safe summary fallback displaying the merge summary numbers (`filesChanged`, `insertions`, `deletions`) from `mergeDetails`. This prevents inflated file lists that would result from a repository-wide fallback diff scan. The tab shows commit metadata (short SHA, merge commit message, merged timestamp) alongside the file-level diff when a commit SHA is available. The header displays "Files Changed (N)" as the primary title with additions/deletions totals on a second line below, freeing horizontal space for navigation and action controls. In-progress and in-review tasks continue to use the worktree-based diff path. Changed-file status indicators (added, modified, deleted, unknown) use semantic CSS classes and theme-aware color variables, ensuring readable contrast across all dashboard themes and light/dark modes.
- **Documents view hidden-file toggle**: The Documents panel’s **Project Files** tab now hides dotfiles and markdown files inside hidden directories by default, keeping the list focused on user-facing docs. A `Show Hidden` / `Hide Hidden` toggle reveals those hidden markdown entries on demand. Hard-excluded system/build directories (for example `.git`, `.fusion`, and `node_modules`) remain excluded in both modes.
- **Changed Files Viewer**: Click a task card's "files changed" button to open a dedicated diff viewer showing only files changed in that task worktree, with per-file statuses and sidebar navigation. The sidebar file list uses dedicated `changed-files-entry` styling with explicit button resets (no browser-default background/border/font inheritance) and theme-variable-driven colors for text, icons, hover, active, and focus states — ensuring correct rendering across both dark and light modes and all color themes. On mobile (≤768px), the viewer switches to a single-pane flow: the file list and diff are shown one at a time with a back button for navigation between them. The viewer always opens to the file list on mobile, and only switches to the diff view when the user taps a specific file. Pressing Escape on the diff view returns to the file list first; pressing Escape again closes the modal. Loading, error, and empty states use theme-aware styling (including light mode). Diff syntax highlighting (additions, deletions, hunks) adapts to the active theme for correct contrast. Status badges in the sidebar and diff toolbar use semantic CSS classes (e.g., `changed-files-badge--added`) with theme-aware colors for consistent readability across all themes. The board card file count and the changed-files viewer agree when live diff data is available — both use a shared diff-base resolution strategy. For in-review cards where live worktree diff stats are unavailable, the card falls back to executor-captured `modifiedFiles` metadata so users still see a quick "N files changed" summary. When the task has a `baseCommitSha` (captured at worktree creation time) that is still a valid ancestor of the current HEAD, the diff is scoped to only files introduced by that specific task. If `baseCommitSha` is stale or unavailable, the system falls back to a branch merge-base, then to `HEAD~1`. This ensures accurate file counts in shared or recycled worktree scenarios where a broader merge-base would include files from previous tasks. For in-progress tasks, the changed-files reporting includes all git-change types: committed changes (from `baseRef..HEAD`), staged changes (from `git diff --cached`), unstaged working-tree changes (from `git diff`), and untracked files (from `git ls-files --others --exclude-standard`). Files are deduplicated across all sources, so a file that appears in multiple states (e.g., modified and staged) appears only once. This gives operators a complete picture of work-in-progress, including new files not yet staged for commit.
  - **Task Detail Changes Tab**: The task detail modal's "Changes" tab (TaskChangesTab) uses a compact spacing treatment for file detail rows. The file list container has a `task-changes-file-list--compact` modifier class that tightens padding and gaps on file headers, stat badges, and list item spacing compared to the shared base `.changes-file-*` styles. This compact treatment is scoped to TaskChangesTab only and does not affect other diff surfaces.
- **GitHub Import**: Import issues directly from GitHub repositories
- **PR Management**: Create, monitor, and merge pull requests for in-review tasks
- **Deep Links**: Dashboard task links using `?task=FN-123` (or `?project=proj_456&task=FN-123` for cross-project) open the task detail modal as a one-time launch. Dismissing the modal removes the `task` parameter from the URL so that refreshing the page does not reopen it. Other query parameters (e.g., `?project=...`) are preserved. Task detail modals opened normally from the board, list, or activity log are not affected.

### Responsive Header
The dashboard header adapts across three responsive tiers to remain usable without wrapping or dropping controls:

- **Mobile (≤768px)**: Lower-priority actions (GitHub Import, Planning, Settings, and optionally Usage) move into an accessible overflow menu triggered by a "More actions" button. The menu closes on outside click, Escape key, or after selecting an action. When multiple projects are registered, a dedicated "Switch Project" entry (building icon) appears in the overflow menu, distinct from the folder icon used for file browsing. The Terminal overflow item is a split action: the left/primary tap opens the terminal immediately, while the right-side chevron expands a nested submenu listing runnable scripts fetched from the project's script settings. Tapping a script entry runs it directly via the terminal; a "Manage Scripts…" link at the bottom of the submenu opens the full script editor when available. The board search input collapses to an icon button; tapping it expands a focused search field that stays visible while a query is active. The project selector and back button are hidden to save space. View toggle (Board/List), Pause, and Stop buttons remain inline for immediate access.
- **Tablet (769px–1024px)**: The header uses a compact layout that keeps the view toggle, search input, and both engine controls (Pause/Resume scheduling and Stop/Start AI engine) inline at all times. Lower-priority utility actions (GitHub Import, Planning, Settings, Usage) move into the overflow menu so the engine controls never disappear. The Terminal overflow item uses the same split-action pattern as mobile: primary tap opens terminal, chevron expands the scripts submenu with runnable entries and a "Manage Scripts…" link. The project selector and back button are hidden on tablet, but the overflow menu includes the same "Switch Project" entry when multiple projects are registered.
- **Desktop (>1024px)**: Full header with all controls and the project selector inline. No overflow menu.
- **Keyboard Accessible**: All controls across tiers expose proper ARIA attributes (aria-expanded, aria-haspopup, aria-label) and support keyboard navigation.

### Mobile Bottom Navigation
The dashboard now includes a dedicated bottom tab navigation pattern for mobile viewports (`≤768px`) via `MobileNavBar` (`app/components/MobileNavBar.tsx`). This pattern is designed for narrow screens and Capacitor-wrapped app usage where bottom-tab navigation is the primary interaction model.

**Primary tabs:**
- **Board/List** — switches task views (label reflects the current non-agent task view)
- **Agents** — switches to the Agents view
- **Activity** — opens the Activity Log modal
- **More** — opens a bottom-sheet drawer for secondary navigation actions

**More sheet items include:** Mailbox, Missions, Git Manager, Terminal, Files, Planning, Workflow Steps, Schedules, GitHub Import, Usage, and Settings.

**Behavior details:**
- The tab bar is mobile-only and hidden on tablet/desktop.
- The tab bar automatically hides when full-screen modals are open (`modalOpen`).
- Badge counts on the Activity tab combine unread mailbox count and active planning sessions (capped at `99+`).
- Touch targets in both tabs and sheet items meet a minimum 44px height.
- Safe-area support uses `env(safe-area-inset-bottom, 0px)` for devices with home-indicator insets.

**Header simplification with mobile nav:**
When `Header` receives `mobileNavEnabled={true}` on mobile, top-nav controls are reduced to:
- project/brand area,
- mobile search control,
- engine pause/stop controls.

The inline view toggle and compact overflow menu are intentionally hidden in this mode, since primary navigation is handled by the bottom tab bar.

**Viewport hook export:**
`Header.tsx` now exports both:
- `ViewportMode`
- `useViewportMode()`

so the app layout and mobile nav can share the same breakpoint logic.

**Key CSS classes:**
- `.mobile-nav-bar`
- `.mobile-nav-tab`
- `.mobile-more-sheet`
- `.mobile-more-item`
- `.project-content--with-mobile-nav`

The layout combines footer + mobile-nav spacing using compound selectors:
- `.project-content--with-footer.project-content--with-mobile-nav`
- `.project-content--with-mobile-nav:not(.project-content--with-footer)`

so content never scrolls behind fixed bottom surfaces.

**Testing notes:**
For component tests, mock `window.matchMedia` to return mobile matches for `(max-width: 768px)` and desktop/tablet matches as needed. See `MobileNavBar.test.tsx` for the reference mocking pattern.

### Mobile Task Entry
Task entry inputs (the quick entry box in the Triage column and the New Task modal's description field) are sized to prevent browser zoom-on-focus on iOS Safari. On mobile viewports (≤768px), these inputs use a minimum 16px font size, which keeps the viewport stable when users focus the fields.

### Mobile CSS Foundation
The dashboard stylesheet defines a shared mobile foundation in `app/styles.css` used by all responsive features:

- **Breakpoint tokens (documentation source-of-truth):**
  - `--mobile-breakpoint: 768px`
  - `--tablet-breakpoint: 1024px`
  - `--small-breakpoint: 480px`
  - `--xsmall-breakpoint: 640px`
- **Touch target utility:** `.touch-target` enforces a minimum `44px × 44px` hit area. Apply it to compact interactive controls (icon buttons, compact links, custom menu items) that are otherwise hard to tap on mobile.
- **Mobile interaction conventions:**
  - Interactive controls should meet the **44px minimum touch target** on mobile.
  - Text-entry controls (`input`, `select`, `textarea`) use **16px font-size** on mobile to prevent iOS Safari auto-zoom.
- **Safe-area pattern (notched devices / Capacitor webview):** use `env(safe-area-inset-top|right|bottom|left, 0px)` for root/layout containers (for example `#root`, `.header`, `.modal`, `.board`) so content avoids status bars and home indicators.

### Mobile Board View
At the mobile breakpoint (`@media (max-width: 768px)`), the board and card surfaces switch to a touch-first layout:

- **Horizontal board navigation:** `.board` uses horizontal scroll with `scroll-snap-type: x mandatory`, smooth scrolling, and hidden scrollbars so users can swipe cleanly between columns.
- **Column sizing and centering:** each board column is fixed to `280px` (`width` + `min-width`) with `scroll-snap-align: center`, so one column is centered at a time during horizontal navigation.
- **Compact card layout:** task cards use tighter spacing for badges/progress metadata on narrow columns, and mobile action controls (edit/archive/unarchive) remain visible without hover.
- **Touch interaction model:** quick taps on cards open task details, while horizontal/vertical movement beyond the touch threshold is treated as scroll/gesture input (so swiping between columns does not accidentally open a card).
- **Touch target convention:** interactive card controls (edit button, archive/unarchive actions, steps toggle, session-files button) follow a minimum `44px` touch target on mobile.

### Mobile Dropdown & Touch
Mobile dropdown behavior follows a consistent viewport-aware anchoring pattern so menus stay usable in narrow viewports and virtual-keyboard scenarios.

- **Portal dropdown positioning pattern** (QuickEntry model menu, refine menu, QuickScripts):
  - Compute trigger coordinates with `getBoundingClientRect()`.
  - Resolve viewport dimensions using `window.visualViewport` when available (fallback to `window.innerWidth/innerHeight`).
  - Compare available space above vs. below the trigger and open upward when space below is insufficient.
  - Clamp horizontal placement to viewport padding and clamp menu height to available space.
  - Recalculate while open on `resize`, capture-phase `scroll`, and `visualViewport` `resize`/`scroll`.
- **FileBrowser touch context menu pattern**:
  - Keep desktop/right-click support via `onContextMenu`.
  - Add long-press for touch (`500ms`) with a separate early feedback timer (`200ms`) that applies `.file-node--long-pressing`.
  - Cancel long-press on touch move beyond a 10px threshold or on touch end/cancel.
  - Guard click-through after long-press so context-menu opening does not also trigger file selection/navigation.
  - Clamp context menu placement using visual viewport offsets for virtual-keyboard-safe positioning.
- **Momentum scrolling convention**:
  - For scrollable dropdown lists and modal content containers, apply `-webkit-overflow-scrolling: touch` to preserve iOS momentum scrolling.
  - Use base selectors for reusable scroll lists (for example: `.dep-dropdown`, `.model-combobox-list`, `.quick-scripts-dropdown__list`, `.file-browser-list`) and reinforce modal surfaces in the main mobile media query (`@media (max-width: 768px)`).

### Mobile Component Adaptations
In addition to the global mobile foundation, several power-user surfaces now include component-specific mobile behavior tuned for touch interaction and narrow viewports (`≤768px`).

- **SettingsModal**
  - The settings layout collapses from sidebar/content columns into a stacked flow (`.settings-layout` uses `flex-direction: column`).
  - The sidebar becomes a horizontally scrollable tab strip (`.settings-sidebar` switches to row layout with hidden scrollbars and touch momentum scrolling).
  - Settings content remains independently scrollable (`.settings-content` keeps `flex: 1; min-height: 0; overflow-y: auto`) so tabs stay reachable while content scrolls.
  - Settings form controls inside `.settings-content` enforce `font-size: 16px` on mobile to prevent iOS zoom-on-focus.

- **Core modals (TaskDetail, NewTask, GitManager)**
  - At `@media (max-width: 768px)`, core modals use full-screen-friendly layout rules: header rows wrap, sticky action rows include safe-area bottom padding, and tab/nav strips stay horizontally scrollable.
  - `TaskDetailModal` mobile overrides include wrapping title metadata (`.detail-title-row`), full-screen refine overlay sizing (`.detail-refine-modal`), and edit-form padding cleanup for embedded `TaskForm` fields.
  - `NewTaskModal` / `TaskForm` mobile overrides remove desktop body max-height constraints, stack model selector rows vertically, and clamp dropdown/popover surfaces (`.dep-dropdown`, `.refine-menu--modal`) to modal bounds.
  - `GitManagerModal` now applies sidebar-to-horizontal-nav and single-column status-grid layout at the shared `768px` breakpoint (with the existing `640px` block retained for extra-compact typography/sizing).

- **AgentsView**
  - Board mode collapses to a single column (`.agent-board { grid-template-columns: 1fr; }`).
  - Main agent collection remains the first content block; secondary metrics/live panels remain below it.
  - Import/filter/global heartbeat controls live in a dismissible `Controls` popup (`.agent-controls-panel`) that stays reachable on mobile.
  - Controls inside the popup stack vertically (`.agent-controls` + `.agent-controls-actions`) with full-width touch-friendly sizing.
  - State filter stretches full width on mobile.
  - Tree-view indentation is reduced (`.agent-tree__indent--1..4`) to prevent horizontal overflow at deeper hierarchy levels.

- **Utility components**
  - **BackgroundTasksIndicator** popover switches to fixed viewport anchoring on mobile (`left/right: 8px`, `bottom: 40px`) so it is not clipped by parent containers.
  - **ExecutorStatusBar** mobile layout includes tighter spacing and overflow guards (`min-width: 0`, hidden overflow in segments) for narrow screens.
  - **ActiveAgentsPanel** grid stacks to one column on mobile (`.active-agents-grid { grid-template-columns: 1fr; }`).
  - **ToastContainer** shifts above footer surfaces with safe-area awareness (`bottom: calc(44px + env(safe-area-inset-bottom, 0px))`, full-width toasts).

### Executor Status Bar
A persistent footer status bar at the bottom of the dashboard displays real-time executor statistics in project view. The status bar provides immediate visibility into the engine's state without opening modals or hovering over badges.

**Statistics Displayed**:
- **Running**: Count of tasks currently in "in-progress" column with pulsing animation when > 0
- **Blocked**: Count of tasks with `blockedBy` field set (a single task ID string indicating file-overlap blocking)
- **Stuck**: Count of tasks in "in-progress" with no activity for longer than the project's `taskStuckTimeoutMs` setting (shown only when > 0 and the setting is enabled). Uses the same `isTaskStuck()` predicate as task cards and list rows, so the footer count always matches the visible stuck indicators on the board
- **Queued**: Count of tasks in "todo" column
- **In Review**: Count of tasks in "in-review" column
- **Executor State**: Current state badge (Idle/Running/Paused)
- **Last Activity**: Relative timestamp of most recent task event

**State Mapping**:
- **Idle**: Global pause enabled, OR engine paused with no running tasks
- **Paused**: Engine paused with running tasks
- **Running**: Engine active with running tasks

**Features**:
- **Shared task list**: Task counts are derived from the same task list used by the board and list views, so the footer always matches the board state exactly. Stuck task detection uses a shared `isTaskStuck()` utility (see `utils/taskStuck.ts`) so the footer count and individual card/row indicators are always consistent
- **Footer-safe layout**: Project-view content (board, list view, agents view) automatically reserves space for the fixed footer using a CSS custom property (`--executor-footer-height`). The `project-content--with-footer` wrapper class sets this token to 36px on desktop and 32px on mobile, ensuring all content remains fully visible and scrollable above the status bar
- Real-time updates via 5-second polling for executor state (globalPause, enginePaused, maxConcurrent)
- Responsive design: collapses labels on mobile screens (<768px); footer height reduces from 36px to 32px
- Dark/light theme support via CSS variables
- **Theme-tokenized state accents**: Running and error state backgrounds use semantic CSS custom properties (`--executor-status-running-bg` / `--executor-status-error-bg`) computed via `color-mix()` from `--color-success` and `--color-error` at 8% opacity (dark theme) and 6% (light theme). This ensures the footer adapts to every color theme without manual overrides — no hardcoded RGBA literals in state rules
- Error state shows connection issues
- Only visible in project view, not in overview/project selector

**API Endpoint**:
- `GET /api/executor/stats` - Returns `globalPause`, `enginePaused`, `maxConcurrent`, and `lastActivityAt` for state derivation. Column-based counts (running, blocked, stuck, queued, in-review) are derived client-side from the shared task list.

**Stuck Task Indicators**:
When `taskStuckTimeoutMs` is configured in project settings, stuck tasks are visually labeled on both board cards and list rows using the same `isTaskStuck()` predicate as the footer count:
- **Board cards**: A pulsing amber "Stuck" badge replaces the normal status badge, and the card gets a left border highlight
- **List rows**: A "Stuck" label appears in the status cell, and the row gets a left border highlight
- **Consistency**: The footer stuck count, card stuck badge, and list stuck label all use the identical `isTaskStuck(task, taskStuckTimeoutMs)` check from `utils/taskStuck.ts`, so the footer count is always explainable by counting visible stuck indicators

### Agents View
Manage AI agents with a dedicated control surface accessible from the main dashboard navigation. All agent surfaces (AgentsView, AgentListModal, AgentDetailView) share consistent token-based styling using dashboard design tokens (`--surface`, `--card`, `--border`, `--text`, `--color-success`, `--color-error`, etc.) and locally defined state color tokens (`--state-idle-*`, `--state-active-*`, `--state-paused-*`, `--state-error-*`) for theme-aware rendering.

**Features**:
- **Agent-first layout**: The main agent collection (list/board/tree/org) renders first, with summary sections (metrics + active/live panel) below it.
- **Controls Popup**: Import, state filter, Show system agents toggle, and global Heartbeat Speed are grouped under a compact `Controls` trigger (`aria-haspopup`, `aria-expanded`, Escape/outside-click dismissal).
- **State Filter**: Styled dropdown to filter agents by state (All States, Idle, Active, Paused, Terminated) with Filter icon, aria-label, and consistent dashboard styling using design tokens (`--radius-sm`, `--border`, `--bg`, `--focus-ring`)
- **Terminated Agent Filtering**: By default ("All States" filter), terminated agents are automatically hidden from the agent list to reduce clutter from frequently-terminating runtime task-worker agents. Terminated agents remain accessible by explicitly selecting the "Terminated" filter option, enabling intentional inspection and cleanup when needed. This behavior applies to both the main AgentsView and the AgentListModal.
- **View Modes**: Board (compact grid) and list (detailed card) layouts, persisted to localStorage
- **Agent CRUD**: Create agents with name and role (create form's text input and role/type select both use tokenized styling — `var(--surface)`, `var(--text)`, `var(--border)`, `var(--radius-sm)`, `var(--focus-ring)` — for consistent theme-aware rendering across all color themes and light/dark modes), change state, update roles inline, delete idle and terminated agents (active and paused agents must be stopped/terminated first)
- **Health Monitoring**: Heartbeat-based health status (Healthy, Unresponsive, Starting, Paused, Terminated) using CSS variable references for theme consistency
- **Agent Detail**: Click any agent card to open a detail modal with full agent information. In list view, each agent card also provides an explicit **View Details** action button in the card actions row for clearer discoverability, while the existing clickable identity/header area remains supported. The modal features a compact header with clear visual hierarchy:
  - **Identity area** (left): Agent icon, name, and state/health badges
  - **Lifecycle controls** (center): Compact action buttons for state transitions (Start, Pause, Resume, Retry, Stop, Delete)
  - **Utility actions** (right): Refresh and Close buttons
  - The compact layout reduces vertical footprint while maintaining all agent-state actions
  - The **Settings** tab includes **editable advanced settings** (heartbeat interval, max retries, task timeout, log level) persisted through `agent.metadata`. Empty fields revert to system defaults, invalid values block save with inline error messages

### Interactive Terminal
Access a fully functional PTY (pseudo-terminal) shell directly from the dashboard. Click the terminal icon in the header to open the interactive terminal modal.

**Features**:
- **Real PTY Terminal**: Spawns a real shell (bash/zsh/powershell) using node-pty for authentic terminal behavior
- **Bidirectional Communication**: WebSocket connection for instant input/output
- **xterm.js Integration**: Full terminal emulation with proper ANSI support, colors, and cursor handling
- **Auto-resizing**: Terminal automatically fits to container size
- **Scrollback Buffer**: 5KB of scrollback history with replay on reconnect
- **Reconnection Support**: Automatic reconnect with exponential backoff if connection drops
- **Reliable Prompt Delivery**: Initial shell prompt visible through first keyst press
- **Mobile Keyboard Support**: On mobile devices, the terminal modal automatically adjusts when the on-screen keyboard opens, constraining its height to fit entirely above the keyboard. The xterm.js terminal view re-fits its rows/columns after the modal shrinks (deferred via `requestAnimationFrame` to ensure CSS variable changes are committed before measuring). This ensures the status bar and terminal content remain visible and interactive without bottom overlap. Protected by regression tests for both CSS contract and component behavior.
- **Keyboard Shortcuts**:
  - `Ctrl+C` - Send SIGINT to process (copy if text selected)
  - `Ctrl+V` - Paste from clipboard
  - `Ctrl+L` - Clear terminal screen
  - `Ctrl++` / `Ctrl+-` - Zoom in/out
  - `Ctrl+0` - Reset zoom
  - `Escape` - Close terminal modal

### Saved Scripts
Saved scripts (managed via the Scripts modal or QuickScripts dropdown in the header) launch inside the existing interactive Terminal modal instead of a separate read-only output dialog. This gives users a consistent terminal experience and lets them interact with the shell after the script starts — for example, to inspect output files, run follow-up commands, or debug failures.

**Modal Handoff**: When a script is launched from the Scripts modal, the modal closes immediately so the Terminal modal becomes the topmost surface — the user never sees both overlays stacked. The script command is sent to the terminal as an `initialCommand` once the PTY session connects. Running a different script while the terminal is already open sends the new command without needing to close and reopen the modal.

**Features**:
- **Real PTY Terminal**: Spawns a real shell (bash/zsh/powershell) using node-pty for authentic terminal behavior
- **Bidirectional Communication**: WebSocket connection for instant input/output
- **xterm.js Integration**: Full terminal emulation with proper ANSI support, colors, and cursor handling
- **Auto-resizing**: Terminal automatically fits to container size
- **Scrollback Buffer**: 50KB of scrollback history with replay on reconnect
- **Reconnection Support**: Automatic reconnect with exponential backoff if connection drops
- **Reliable Prompt Delivery**: Initial shell prompt and first keystrokes are always visible — output is preserved across the WebSocket connection, xterm initialization, and resize lifecycle without loss or duplication

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

**Startup Failure Handling**:
- Terminal startup never hangs indefinitely — bounded timeouts ensure the UI always resolves to either a usable terminal or a clear failure state
- **Bootstrap timeout** (15s): If the backend session listing or creation call hangs, the modal transitions from "Starting terminal..." to an actionable error message
- **xterm init timeout** (10s): If xterm.js dynamic imports or `terminal.open()` setup stalls, the modal shows a "Terminal UI failed to initialize" error with a **Reinitialize** button that retries xterm setup without recreating the backend session
- Users see distinct recovery actions based on the failure type:
  - **Bootstrap/session failure** (no backend session): "Retry" button re-attempts session creation
  - **xterm init failure** (session exists but UI didn't load): "Reinitialize" button retries xterm initialization only, preserving the existing session
- Generation-based stale-result guards prevent timed-out prior requests from corrupting state after a successful retry
- On successful recovery, the terminal initializes normally; the error state clears automatically
- Existing sessions (tabs) that are already connected are not affected by bootstrap errors on new tabs

**First-Open Reliability**:
- The terminal is usable on first modal open without requiring a page reload
- Stale sessions from a previous browser session are detected during bootstrap via server-side validation (`listTerminalSessions`) and automatically filtered out; a fresh session is created when all stored sessions are stale
- When the WebSocket reports that the current session is invalid (close code 4004 — session-not-found), the terminal auto-recovers without user intervention:
  1. xterm is disposed and state is cleared
  2. A new server session is created for the active tab via `replaceActiveTabSession`
  3. The WebSocket reconnects to the new session automatically (triggered by `sessionId` change)
- If session creation fails during recovery, the bootstrap error UI is shown with a retry button
- This recovery path also handles server restarts, session garbage collection, and any scenario where the backend no longer recognizes the client's stored session ID

### Git Manager
The Git Manager provides comprehensive repository visualization and management directly from the web UI. Access it via the Git Branch icon button in the header (desktop: inline with other utility buttons, mobile: in the overflow menu).
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

**Remotes Tab**: Perform remote operations with commit visibility:
- Fetch from origin
- Pull latest changes
- Push current branch
- View operation results and error states
- **Commits to Push**: See which local commits are ahead of the upstream tracking branch (pending push) with short hash, message, author, and relative date. The list stays synchronized with the ahead count — it refreshes automatically after fetch, pull, push, and manual refresh operations, and clears when the ahead count drops to zero (e.g., after a successful push).
- **Remote Commit Inspection**: Click any remote to view its recent commit history — useful for checking what's on a remote without switching to the terminal
- **Inline Commit Diffs**: Click any commit in the "Commits to Push" or "Recent commits on {remote}" lists to expand an inline diff viewer showing file changes (stat + patch). Click the same commit again to collapse. Only one diff is expanded per list at a time.
- Auto-selects the first remote and loads its recent commits on mount

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

**Data Source**:
- **Project view** (when a project is selected): Reads from the per-project activity log via `/api/activity`, which is always populated with task lifecycle events for the current project. This ensures reliable activity visibility in normal dashboard use.
- **Overview mode** (no project selected): Reads from the unified central feed via `/api/activity-feed`, which aggregates activity across all registered projects. The project filter dropdown allows narrowing results to a specific project.

**Features**:
- **Event Types**: Track task:created, task:moved, task:merged, task:failed, task:deleted, and settings:updated events
- **Task Links**: Click any task ID in the log to open its detail modal
- **Filter by Type**: Use the dropdown to show only specific event types (e.g., only failures, only merges)
- **Auto-refresh**: Log updates automatically every 30 seconds when the modal is open
- **Pagination**: "Load More" button fetches older entries (100 entries per request, max 1000)
- **Clear Log**: Maintenance function to clear all activity history (with confirmation)
- **Responsive Layout**: The modal uses the shared `modal-lg` width (640px) and standard `modal-header` pattern with a dedicated close button, consistent with other dashboard modals. On narrow screens (≤768px), the modal adapts with a stacked header, full-width filter controls, wrapped active-filters bar, reflowed entry text, and vertically stacked confirmation actions — preserving access to filters, task links, and clear-log on mobile devices
- **Theme-aware Styling**: ActivityFeed colors are fully token-driven using dashboard CSS custom properties (e.g., `var(--todo)`, `var(--color-error)`, `var(--text-muted)`). Event type icon colors, project badge backgrounds, and error states all reference theme tokens, ensuring consistent rendering across dark/light mode and all color themes. No hardcoded `rgba()` or hex values are used in feed-specific styles.

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
- **Authentication**: Provider management for AI model access. OAuth providers (e.g. Anthropic) use a Login/Logout flow; API-key providers (e.g. OpenRouter) show a masked key entry with Save/Clear actions. After saving or clearing a key, the auth status refreshes immediately so the authenticated badge stays in sync. Stored key values are never prefilled or displayed.
- **Onboarding Wizard**: On first dashboard launch, a multi-step onboarding wizard guides users through three steps: (1) AI Setup — authenticate with a provider and select a default model, (2) GitHub (optional) — connect GitHub for issue import and PR management, and (3) First Task — create your first task or import from GitHub. If there is no active project, the First Task step blocks task/import actions and prompts the user to open the existing project setup wizard first. The wizard is dismissible and non-blocking — completion is tracked via the `modelOnboardingComplete` global setting. Users can skip onboarding or re-trigger it by clearing the flag in Settings.
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
- GitHub access for PR-first workflows must be available via `gh auth login`
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
2. Add CSS variables in `packages/dashboard/app/public/theme-data.css` under `[data-color-theme="your-theme"]` (dark variant) and `[data-color-theme="your-theme"][data-theme="light"]` (light variant)
3. Add the swatch class for the theme picker in the CSS
4. Update `ThemeSelector.tsx` with the new theme option

**Note:** Theme variable blocks are stored in a separate `theme-data.css` file for optimized loading. This file is only loaded when a non-default color theme is active, reducing the initial payload for users with the default theme.

### Dynamic Stylesheet Loading

The `theme-data.css` file is loaded dynamically to control stylesheet size and enable lazy loading. This file contains CSS custom properties for all 54 color themes and is only loaded when a non-default color theme is active.

**Path Resolution:**

The stylesheet URL is derived from `document.baseURI` for correct resolution across all runtime contexts:

- **HTTP/HTTPS serving** (development server, production web deployment): Derives the path relative to the HTML file's directory (e.g., `/app/theme-data.css`)
- **Electron file:// context** (desktop production): Same directory-relative resolution for local files

The URL resolution handles two cases:
1. Base URL ends with `/` (directory path): Replaces trailing `/` with `/theme-data.css`
2. Base URL ends with filename: Replaces filename with `/theme-data.css`

**Stale Link Correction:**

When switching color themes or after navigation, the runtime hook (`useTheme.ts`) checks if an existing `theme-data.css` link has a stale `href` and updates it to the correct path. This ensures theme changes apply correctly even if the page was loaded with a different base URL.

Both the pre-hydration inline script in `index.html` and the runtime hook use the same path resolution strategy, preventing behavior drift between startup and runtime.

### Theme-Driven Logo and Task-Creation CTAs

The Fusion logo and all task-creation action buttons (including the "+ New Task" and "Save" buttons in board view, list view, and inline creation surfaces) are fully tokenized and respond to the active color theme. This ensures branding and task-creation affordances stay visually consistent across all 12 color themes and both light/dark modes.

**Theme tokens used:**
| Token | Purpose |
|-------|---------|
| `--logo-accent` | Fusion logo SVG fill color (defaults to `var(--todo)`) |
| `--cta-bg` / `--cta-bg-hover` | Task-creation CTA button background |
| `--cta-border` / `--cta-border-hover` | Task-creation CTA button border |
| `--cta-text` / `--cta-text-hover` | Task-creation CTA button text |
| `--cta-glow` | Box-shadow glow on hover |

**Semantic class:** `.btn-task-create` — used consistently on:
- Board column "+ New Task" button (`Column.tsx`)
- List view "+ New Task" button (`ListView.tsx`)
- Inline create card "Save" button (`InlineCreateCard.tsx`)
- Quick entry box "Save" button (`QuickEntryBox.tsx`)

All color themes automatically provide values for these tokens. Adding a new color theme requires only setting `--todo` (and optionally `--logo-accent` if the logo should differ from the todo column color).

**Header brand lockup:** The logo SVG and "Fusion" wordmark are wrapped in a dedicated `.header-brand` flex container with `gap: var(--space-xs)` (4 px). This isolates logo-to-wordmark spacing from the wider `.header-left` gap (`var(--space-sm)`, 8 px) so the brand mark can be tuned independently of the spacing between the brand group and adjacent header controls (project selector, back button, etc.).

**Favicon and PWA icon alignment:** The public favicon (`app/public/logo.svg`) and PWA install icons (`app/public/icons/icon-192.png`, `app/public/icons/icon-512.png`) intentionally mirror the header logo geometry — the outer ring and swoosh/comet shape from `Header.tsx`. This ensures users see one consistent brand mark across the dashboard UI, browser tab favicon, and installed PWA shortcuts. The logo assets use `currentColor` for theme-driven coloring, matching the header's approach.

## Performance Characteristics

The dashboard includes several runtime safeguards to stay responsive during long sessions and on larger boards:

- **Agent log cap**: The UI keeps only the most recent **500 agent log entries per task** in memory. Historical log fetches and live SSE appends are both capped to this window. **Per-entry content is never truncated** — each entry's `text` and `detail` fields survive in full from persistence (`agent.log` JSONL) through the API (`GET /tasks/:id/logs`), SSE streaming (`/api/tasks/:id/logs/stream`), and rendering in `AgentLogViewer` / `AgentDetailView`. The 500-entry limit is a whole-list in-memory cap only.
- **Memoized task rendering**: `TaskCard`, `Column`, and worktree grouping are memoized so unrelated SSE updates do not force the whole board to repaint. The board also preserves stable per-column task arrays for unchanged columns.
- **Large-column pagination**: Columns with more than **100 tasks** use incremental client-side pagination, rendering **50 tasks initially** and loading **25 more** at a time. This is applied to active non-archived, non-`in-progress` columns to avoid breaking worktree grouping and archived browsing behavior.
- **Badge update isolation**: Live GitHub PR/issue badge websocket updates are rendered through a dedicated child component so badge freshness is preserved even when task cards are memoized.
- **SSE cleanup and reconnects**: Task and log streaming hooks explicitly clean up EventSource listeners/connections, automatically refetch the task snapshot after a stream reconnect, and avoid duplicate stream setup during rerenders.
- **Foreground recovery refresh**: The task board refreshes its task snapshot when the browser tab becomes visible again so long-lived hidden tabs do not keep showing stale board/list data after missed live events.

## Mobile Development (Capacitor)

Mobile builds use the dedicated `@fusion/mobile` package. See [`../../MOBILE.md`](../../MOBILE.md) for the full workflow.

Quick start:

```bash
pnpm mobile:build
pnpm mobile:ios      # or pnpm mobile:android
```

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
- `DELETE /api/tasks/:id` - Delete task. Default mode is safe: if other tasks still reference this ID in `dependencies`, the route returns `409` with `{ error, details: { code: "TASK_HAS_DEPENDENTS", taskId, dependentIds } }`.
  - To explicitly remove those incoming dependency references and then delete, call `DELETE /api/tasks/:id?removeDependencyReferences=true`.
  - This opt-in path rewrites each dependent task's `dependencies` array atomically before deleting the target task, so no live task is left pointing at a missing task ID.

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
- `GET /api/git/commits/ahead` - List local commits ahead of upstream tracking branch (commits pending push)
- `GET /api/git/remotes/:name/commits?ref=&limit=` - Recent commits for a remote tracking ref (default: remote's HEAD branch, limit: 10, max: 50)
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
- `FUSION_GITHUB_APP_ID` - Your GitHub App ID
- `FUSION_GITHUB_APP_PRIVATE_KEY` - PEM private key content (or use `FUSION_GITHUB_APP_PRIVATE_KEY_PATH`)
- `FUSION_GITHUB_APP_PRIVATE_KEY_PATH` - Path to PEM private key file (alternative to direct key)
- `FUSION_GITHUB_WEBHOOK_SECRET` - Webhook secret for signature verification

**GitHub App Configuration:**
- **Permissions Required:**
  - Metadata: Read
  - Pull requests: Read
  - Issues: Read
- **Webhook Events:** Subscribe to `pull_request`, `issues`, and `issue_comment` events
- **Webhook URL:** `https://your-dashboard-url/api/github/webhooks`

**How it Works:**
1. GitHub sends signed webhook events when PR/issue state changes
2. Server verifies `X-Hub-Signature-256` using `FUSION_GITHUB_WEBHOOK_SECRET`
3. Server fetches canonical badge data using GitHub App installation token
4. Matching tasks (by parsed badge URL) are updated via `store.updatePrInfo()` / `store.updateIssueInfo()`
5. `task:updated` event triggers `/api/ws` broadcast to subscribed clients
6. No duplicate broadcasts when only `lastCheckedAt` timestamp changes

**Fallback Behavior:**
When webhook delivery is unavailable, the 5-minute refresh endpoints (`/api/tasks/:id/pr/status`, `/api/tasks/:id/issue/status`) continue to work as the fallback path. Staleness is computed from persisted `lastCheckedAt` timestamps only (no in-memory poller state).

### Multi-Instance Deployments

When running the dashboard on multiple instances behind a load balancer, badge updates can be shared across instances using Redis pub/sub. This ensures that a PR/issue badge change detected on instance A is delivered to subscribed WebSocket clients on instance B.

**Configuration:**
- `FUSION_BADGE_PUBSUB_REDIS_URL` - Redis connection URL (e.g., `redis://localhost:6379`)
- `FUSION_BADGE_PUBSUB_CHANNEL` - Pub/sub channel name (default: `fusion:badge-updates`)

When `FUSION_BADGE_PUBSUB_REDIS_URL` is not set, the dashboard uses an in-memory adapter for single-instance deployments.

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

### Messaging
- `GET /api/messages/inbox` - Fetch inbox messages (query: `limit`, `offset`, `unreadOnly`, `type`)
- `GET /api/messages/outbox` - Fetch sent messages (query: `limit`, `offset`, `type`)
- `GET /api/messages/unread-count` - Get unread count (for header badge)
- `POST /api/messages` - Send a message (body: `{ toId, toType, content, type, metadata? }`)
- `GET /api/messages/:id` - Fetch a single message
- `POST /api/messages/:id/read` - Mark message as read
- `POST /api/messages/read-all` - Mark all inbox as read
- `DELETE /api/messages/:id` - Delete a message
- `GET /api/messages/conversation/:participantType/:participantId` - Get conversation thread
- `GET /api/agents/:id/mailbox` - View agent mailbox (admin read-only)

### Agent Run Audit APIs

The dashboard exposes run-audit retrieval and correlation endpoints for inspecting agent run mutations and timelines:

#### Run Audit Events

- `GET /api/agents/:id/runs/:runId/audit` - Get normalized audit events for a specific run
  - **Query parameters:**
    - `taskId` (optional): Filter by task ID
    - `domain` (optional): Filter by domain (`database`, `git`, `filesystem`)
    - `startTime` (optional): ISO-8601 start of time range (inclusive)
    - `endTime` (optional): ISO-8601 end of time range (inclusive)
    - `limit` (optional): Maximum events to return (1-1000, default 100)
  - **Response:** Array of normalized audit events with stable UI-friendly field names
  - **Error codes:** `400` for invalid filters, `404` for unknown run

#### Run Timeline

- `GET /api/agents/:id/runs/:runId/timeline` - Get correlated timeline combining audit events and agent logs
  - **Query parameters:**
    - `taskId` (optional): Filter by task ID (defaults to run's contextSnapshot.taskId)
    - `domain` (optional): Filter by domain (`database`, `git`, `filesystem`)
    - `startTime` (optional): ISO-8601 start of time range (inclusive)
    - `endTime` (optional): ISO-8601 end of time range (inclusive)
    - `includeLogs` (optional): Include agent logs (default `true`)
  - **Response:**
    - `run`: Run metadata (id, agentId, startedAt, endedAt, status, taskId)
    - `auditByDomain`: Audit events grouped by domain (database, git, filesystem)
    - `counts`: Metadata counts (auditEvents, logEntries)
    - `timeline`: Merged and deterministically sorted timeline entries
  - **Error codes:** `400` for invalid filters, `404` for unknown run

**Timeline Sorting:** Entries are sorted by timestamp with a stable tie-breaker (entry type + domain) to ensure deterministic ordering when timestamps collide.

**Audit Event Domains:**
- `database`: Database mutations (task updates, status changes)
- `git`: Git mutations (commits, branch operations)
- `filesystem`: Filesystem mutations (file reads, writes, deletes)

### Configuration
- `GET /api/config` - Server configuration
- `GET /api/settings` - Merged settings (project overrides global)
- `PUT /api/settings` - Update project-level settings (rejects global-only fields)
- `GET /api/settings/global` - Global user settings (~/.fusion/settings.json)
- `PUT /api/settings/global` - Update global user settings
- `GET /api/settings/scopes` - Settings separated by scope: { global, project }
- `GET /api/models` - Available AI models
- `GET /api/auth/status` - OAuth provider status
- `POST /api/auth/login` - Initiate OAuth login
- `POST /api/auth/logout` - Logout from provider

### Plugins
Plugin management endpoints with multi-project scoping support via `projectId` query/body parameter.

#### Plugin Listing
- `GET /api/plugins` - List all installed plugins
  - Query: `projectId?` (scope to project), `enabled?` (filter by enabled status)
  - Response: `PluginInstallation[]`

- `GET /api/plugins/:id` - Get a single plugin by ID
  - Query: `projectId?` (scope to project)
  - Response: `PluginInstallation`
  - Error: `404` if plugin not found

#### Plugin Registration (mode: register)
- `POST /api/plugins` - Register a new plugin with explicit manifest
  - Body: `{ mode: "register", id, name, version, path, description?, author?, homepage?, dependencies?, settingsSchema?, settings? }`
  - Query/Body: `projectId?` (scope to project)
  - Response: `201` with `PluginInstallation`
  - Errors: `400` validation, `409` conflict (already registered)

#### Plugin Installation (mode: install)
- `POST /api/plugins` - Install plugin from local path (loads manifest automatically)
  - Body: `{ mode: "install", path }`
  - Query/Body: `projectId?` (scope to project)
  - Response: `201` with `PluginInstallation`
  - Errors: `400` install not supported, `404` manifest not found, `400` invalid manifest, `409` conflict

#### Plugin Lifecycle
- `POST /api/plugins/:id/enable` - Enable and start a plugin
  - Body: `{ projectId? }`
  - Response: Updated `PluginInstallation`

- `POST /api/plugins/:id/disable` - Disable and stop a plugin
  - Body: `{ projectId? }`
  - Response: Updated `PluginInstallation`

#### Plugin Settings
- `PATCH /api/plugins/:id/settings` - Update plugin settings
  - Body: `{ settings: Record<string, unknown>, projectId? }`
  - Response: Updated `PluginInstallation`
  - Errors: `400` validation, `404` not found

#### Plugin Uninstall
- `DELETE /api/plugins/:id` - Uninstall a plugin
  - Query: `projectId?` (scope to project)
  - Response: `204` No Content

## Architecture

- **Frontend**: React + Vite, TypeScript, xterm.js for terminal emulation, CSS custom properties for theming
- **Backend**: Express server with REST API, badge WebSocket at `/api/ws`, terminal WebSocket at `/api/terminal/ws`, and Server-Sent Events (SSE) for task/log updates
- **Terminal**: @homebridge/node-pty-prebuilt-multiarch (aliased as node-pty) for PTY spawning, WebSocket for bidirectional I/O
- **Badge Updates**: `useBadgeWebSocket()` shares a single browser socket and subscribes per visible GitHub-linked task card
- **State Management**: Custom hooks with EventSource for real-time task updates plus a dedicated WebSocket store for badge snapshots
- **Git Integration**: Server-side git command execution with validation

## Plugin Managers

The dashboard package includes a mobile plugin foundation under `src/plugins/` for Capacitor environments. These managers are framework-agnostic and degrade gracefully in browser/test contexts where native Capacitor APIs are unavailable.

### Included managers

- **`SplashScreenManager`** (`src/plugins/splash-screen.ts`)
  - Controls splash show/hide behavior
  - Supports optional auto-hide on init with configurable delay
- **`StatusBarManager`** (`src/plugins/status-bar.ts`)
  - Applies light/dark/system status bar styling
  - Exposes `onThemeChange()` subscription callbacks
- **`NetworkManager`** (`src/plugins/network.ts`)
  - Reads initial connectivity state
  - Monitors connectivity changes and exposes `onStatusChange()` callbacks

### Quick setup with `initializePlugins()`

Use `initializePlugins()` to create and initialize all managers in order:

```ts
import { initializePlugins } from "@fusion/dashboard";

const { splashScreen, statusBar, network, result } = await initializePlugins({
  splashAutoHide: true,
  splashHideDelay: 500,
  themeMode: "system",
  startNetworkMonitoring: true,
});

if (result.errors.length > 0) {
  console.warn("Some plugins failed to initialize", result.errors);
}
```

### Custom setup with individual managers

If you need fine-grained lifecycle control, instantiate managers directly:

```ts
import {
  SplashScreenManager,
  StatusBarManager,
  NetworkManager,
} from "@fusion/dashboard";

const splash = new SplashScreenManager({ autoHide: false });
const statusBar = new StatusBarManager({ themeMode: "dark" });
const network = new NetworkManager();

await splash.initialize();
await statusBar.initialize();
await network.initialize();
```

### Error handling model

All managers use defensive async APIs and silent fallback handling for unsupported environments (for example, browser development/test runs without native Capacitor bindings). This keeps startup resilient across web, simulator, and device contexts.

## Run Audit

The dashboard provides run-audit API clients for tracing agent runs across git, database, and filesystem mutations.

### API Client Functions

**`fetchAgentRunAudit(agentId, runId, filters?, projectId?)`** — Fetch audit events for a run

```typescript
import { fetchAgentRunAudit } from "./api";

const response = await fetchAgentRunAudit("agent-001", "run-abc123", {
  domain: "git",           // Optional: filter by domain
  startTime: "2025-01-01T00:00:00Z",  // Optional: time range
  limit: 100,              // Optional: max events
}, "project-xyz");
```

**`fetchAgentRunTimeline(agentId, runId, options?, projectId?)`** — Fetch correlated timeline with logs

```typescript
import { fetchAgentRunTimeline } from "./api";

const response = await fetchAgentRunTimeline("agent-001", "run-abc123", {
  domain: "filesystem",     // Optional: filter by domain
  includeLogs: true,        // Include agent log entries
  limit: 50,               // Max audit events
}, "project-xyz");
```

### Response Shapes

**`RunAuditResponse`** — From `fetchAgentRunAudit`:
```typescript
interface RunAuditResponse {
  runId: string;
  events: NormalizedRunAuditEvent[];
  filters: { taskId?, domain?, startTime?, endTime? };
  totalCount: number;
  hasMore: boolean;
}
```

**`RunTimelineResponse`** — From `fetchAgentRunTimeline`:
```typescript
interface RunTimelineResponse {
  run: { id, agentId, startedAt, endedAt?, status, taskId? };
  auditByDomain: { database: [], git: [], filesystem: [] };
  counts: { auditEvents: number; logEntries: number };
  timeline: TimelineEntry[];
}
```

### Debugging Recipe: Map Run ID to Mutations

**Problem**: An agent run completed but you need to verify what changed.

1. **Get the run ID** from the Runs tab in the agent detail modal

2. **Fetch audit events** to see all mutations:
   ```typescript
   const audit = await fetchAgentRunAudit(agentId, runId);
   console.log(audit.events.map(e => `${e.domain}:${e.mutationType} → ${e.target}`));
   ```

3. **Check git mutations** for code changes:
   ```typescript
   const timeline = await fetchAgentRunTimeline(agentId, runId, { domain: "git" });
   timeline.auditByDomain.git.forEach(e => {
     console.log(`${e.mutationType}: ${e.target}`, e.metadata);
   });
   ```

4. **Verify database changes**:
   ```typescript
   const dbEvents = audit.events.filter(e => e.domain === "database");
   dbEvents.forEach(e => {
     // e.summary contains a human-readable description
     console.log(`[${e.timestamp}] ${e.summary}`);
   });
   ```

5. **Trace filesystem changes**:
   ```typescript
   const fsEvents = timeline.auditByDomain.filesystem;
   fsEvents.forEach(e => {
     if (e.mutationType === "file:write") {
       // File was written at e.target
       console.log(`Wrote: ${e.target} (${e.metadata?.size} bytes)`);
     }
   });
   ```

### TypeScript Types

Import types from `api.ts`:
```typescript
import type {
  RunAuditFilters,
  RunAuditResponse,
  RunTimelineResponse,
  NormalizedRunAuditEvent,
  TimelineEntry,
} from "./api";
```

## Insights View

The Insights View (`InsightsView.tsx`) displays AI-generated insights organized by category, providing actionable recommendations for your project.

### Features

- **Five insight categories**: Features, Architecture, Competitive Analysis, Research, Trends
- **Manual insight generation**: Trigger new insight analysis on demand
- **Per-insight actions**: Dismiss insights you don't need, or convert them to tasks
- **Real-time feedback**: Inline status messages and toast notifications for all actions
- **Loading and error states**: Clear visual feedback during data loading and action execution

### User Flows

#### Manual Run
1. Click "Generate Insights" button in the header
2. Status message shows "Generating insights..."
3. Toast notification confirms "Insight generation started"
4. Latest run info shows progress and completion status

#### Dismiss Insight
1. Click the X button on any insight item
2. The insight is removed from the list
3. Toast notification confirms dismissal

#### Create Task from Insight
1. Click the + button on any insight item
2. The insight data is extracted (title and description)
3. Callback `onCreateTask(title, description)` is invoked
4. Parent component handles task creation

### Loading States

- **Initial load**: Shows "Loading insights..." with spinner
- **Empty state**: Shows "No insights yet" with CTA to generate first insights
- **Error state**: Shows error message with retry button

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/insights` | GET | List all insights |
| `/api/insights/:id` | GET | Get single insight |
| `/api/insights/:id` | PATCH | Update insight |
| `/api/insights/:id` | DELETE | Delete insight |
| `/api/insights/:id/dismiss` | POST | Dismiss insight |
| `/api/insights/run` | POST | Trigger manual run |
| `/api/insights/runs` | GET | List runs |
| `/api/insights/runs/:id` | GET | Get run details |
| `/api/insights/:id/create-task` | POST | Get task creation data |

### Hook API

```typescript
import { useInsights } from "./hooks/useInsights";

const {
  sections,           // Array of InsightSection with category, label, items
  loading,           // Boolean loading state
  error,             // Error message if fetch failed
  latestRun,         // Most recent InsightRun
  isRunInFlight,     // True while generation is running
  runError,          // Error from latest run
  refresh,           // () => Promise<void>
  runInsights,       // () => Promise<void>
  dismiss,           // (id: string) => Promise<void>
  createTask,        // (id: string) => Promise<{ title, description } | null>
  dismissStates,     // Map of id => { running, error }
  createTaskStates,  // Map of id => { running, error }
  totalCount,        // Total non-dismissed insights
} = useInsights(projectId?: string);
```

### Component Usage

```tsx
import { InsightsView } from "./components/InsightsView";

<InsightsView
  projectId="project-123"
  addToast={(message, type) => console.log(message)}
  onClose={() => setShowInsights(false)}
  onCreateTask={(title, description) => {
    // Handle task creation
  }}
/>
```
