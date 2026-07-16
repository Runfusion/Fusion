# Dashboard Guide

[← Docs index](./README.md)

The Fusion dashboard is the main control plane for tasks, agents, missions, settings, logs, and repository operations.

## Dashboard Updates

When Fusion detects a newer `@runfusion/fusion` release, the Settings modal footer shows the available version with **Learn more** and **Update now** actions. **Update now** installs the latest global package with npm; after it succeeds, the dashboard update banner offers a one-click **Restart Fusion** action because the already-running dashboard server is unchanged until restart. When Fusion is unsupervised (for example, started with `--no-supervise`), that banner action is disabled and explains that Fusion must be restarted manually.

## Settings discovery

<!-- FNXC:SettingsSearchDocs 2026-07-04-00:00: Settings search is section-discovery, not a global command palette. Document that it filters visible Settings sections by section names and setting keywords while preserving feature-gated hidden sections. -->
Use **Search settings** at the top of Settings to find the section that contains a setting by name or keyword. The same search works in the Settings modal and embedded Settings page, filters both the desktop section list and mobile section picker, and only searches sections currently visible for enabled feature flags.

<!-- FNXC:Settings 2026-07-09-12:00: FN-7751 keeps FN-7713's collapsed mobile search row but moves the toggle inline beside the section dropdown so mobile Settings exposes one compact section/search control row; desktop/tablet keep the row always visible with no toggle. -->
On mobile, the search row starts collapsed behind a compact toggle icon beside the **Settings Section** dropdown to save vertical space; tap it to reveal the search input and tap again to hide it. An in-progress search query is preserved across collapse/expand. Desktop and tablet always show the search row with no toggle.

<!-- FNXC:SettingsDocs 2026-07-11-18:58: FN-7825 makes the Settings navigation rail read as one clean surface: no vertical content divider, single-line section rows, and a desktop/tablet resize handle with browser-local width persistence. Mobile remains the stacked section picker. -->
On desktop and tablet, the Settings navigation rail has no hard divider between navigation and content; section rows stay on one line and use ellipsis for unusually long labels. Drag the thin handle between the navigation rail and content pane to widen or narrow the rail. Fusion remembers that width in browser storage and restores it for both the standalone Settings modal and embedded Settings page. Mobile keeps the stacked **Settings Section** picker and does not show the resize handle.

<!-- FNXC:SettingsDefaults 2026-07-04-00:00: FN-7505 requires every user-editable setting's help text to state its own default value, so operators reading a field's description know what it defaults to without checking the reference doc. -->
Every user-editable setting's help text (the `.settings-description`/`<small>` hint under a field) states its own default value — for example “Default: 3.”, “Default: enabled.”, or “No default — unset (inherits the global setting).” for values that fall back to another scope. Canonical default values come from `DEFAULT_GLOBAL_SETTINGS` / `DEFAULT_PROJECT_SETTINGS` in `packages/core/src/settings-schema.ts`; the dashboard copy never invents a number. A guard test (`settings-default-descriptions.test.tsx`) enforces that every surfaced setting states its default and that every `DEFAULT_SETTINGS` key is either documented or explicitly allowlisted as not surfaced in the Settings UI.

## Reset Settings

<!-- FNXC:SettingsResetDocs 2026-07-04-00:00: Reset Settings is a DESTRUCTIVE action. Document both choices, the scope-precision guarantee, and which sections are excluded so operators understand exactly what a reset does and does not touch before they click it.

FNXC:SettingsResetDocs 2026-07-12-00:00: FN-7880 shortens the mobile footer affordance to Reset to keep the Settings action row usable on small screens; desktop and tablet keep the full Reset Settings label while the confirmation choices remain identical. -->
The Settings footer includes a **Reset Settings** button, next to Import/Export, in both the Settings modal and the embedded Settings page. On mobile the same button is labeled **Reset** to preserve footer space; desktop and tablet keep **Reset Settings**. Selecting it opens a confirmation dialog with two destructive choices, plus Cancel:

- **Reset this menu ({{section}})** — resets only the settings owned by the currently active section, at that section's own scope (global or project). A global section (for example Appearance) writes the section's keys back to their canonical defaults. A project section (for example Merge) clears the section's keys back to their inherited/default value. No other section's settings are touched.
- **Reset all project settings** — resets every project-scoped setting for the current project back to its default/inherited value. This never touches global (cross-project) settings.

Both actions are irreversible; there is no undo after confirming. The dialog closes and the form refreshes to show the reset values immediately after a successful reset.

**Excluded sections.** Some sections are not a simple settings form and are intentionally excluded from **Reset this menu** (the button is disabled with an explanatory tooltip when one of these is the active section), because each already has its own dedicated management flow: **Secrets**, **MCP Servers** (global and project), **Plugins**, **Memory**, **Authentication**, **Prompts**, **CLI Agents**, and the **Hermes**/**OpenClaw**/**Paperclip** runtime sections. **Reset all project settings** is unaffected by this exclusion list since it resets the underlying project settings values directly, not through any of those sections' own flows.

## Keyboard shortcuts

<!--
FNXC:DashboardShortcuts 2026-07-04-00:00:
Dashboard keyboard shortcuts are configurable global operator preferences. The docs must state the defaults, editable-field safety guard, duplicate/invalid save behavior, and one-popup Escape semantics so operators know why Space/Terminal/Escape act differently in text fields than on the board.

FNXC:DashboardShortcuts 2026-07-04-12:00:
FN-7553 promotes shortcuts to a dedicated Settings section (Keyboard Shortcuts, moved out of General), adds a press-to-record capture control, and adds four more configurable actions (Open Files, Open Settings, Open Command Center, New Task) grouped into categories. The docs must state the new location, the capture control's record/manual/clear/Escape-cancels behavior, and the full action list with defaults so operators can find and rebind every shortcut, not just the original two.
-->
Open **Settings → Keyboard Shortcuts** (its own dedicated section, no longer under General) to configure dashboard-wide shortcut bindings. Actions are grouped by category:

- **Communication:** Quick Chat (`Space`)
- **Workspace:** Terminal (<kbd>Ctrl+`</kbd>), Open Files (`Ctrl+E`)
- **Navigation:** Open Command Center (`Ctrl+K`), Open Settings (`Ctrl+,`)
- **Tasks:** New Task (`Ctrl+Shift+N`)

Each row uses a press-to-record capture control: click **Record**, then press the key combination you want — it fills in automatically. Manual typing remains supported as a fallback. **Clear** disables that action (blank = disabled). While recording, pressing `Escape` cancels the recording instead of binding Escape, so Escape stays permanently reserved for the dashboard's topmost-popup-close shortcut; the capture control also never leaks the recorded keystroke to the global shortcut listener while it is focused/recording.

Leave a shortcut field blank to disable that action. Settings validates each shortcut before saving: unsupported key strings are marked invalid, and duplicate populated shortcuts across ANY two actions (for example binding both Quick Chat and Open Command Center to `Ctrl+K`) are rejected until one binding changes or is disabled.

Shortcut handling is intentionally guarded. Fusion ignores global shortcuts while focus is inside inputs, textareas, selects, contenteditable editors, chat composers, task fields, Settings fields, search boxes, and terminal input, so typing Space or shortcut letters never opens another surface unexpectedly. Hardware keyboards on desktop, tablet, and mobile use the same bindings when focus is on the page/body. Open Files, Open Settings, Open Command Center, and New Task each reuse the dashboard's existing navigation entry points (the same handlers as their header/sidebar buttons), so no shortcut opens a second/duplicate destination.

<!-- FNXC:DashboardShortcuts 2026-07-16-00:00: FN-8069 requires every configured dashboard shortcut to toggle its interface; a re-press dismisses modal surfaces or restores the active view that preceded Settings or Command Center (Runfusion/Fusion#2118). -->
Every configured action toggles its interface: press once to open Quick Chat, Terminal, Files, Settings, Command Center, or New Task, then press the same binding again to close it. For Settings and Command Center, the second press returns to the view that was active before the surface opened.

Press `Escape` to close the current/topmost dashboard popup. Popped-out task windows and floating Quick Chat close before fixed app modals such as Terminal, Settings, Files, or Task Detail, and only one surface closes per key press. Nested editors and menus that already handle Escape keep first ownership by preventing the global handler.

<!-- FNXC:ModalGeometryPersistenceDocs 2026-07-16-00:40: Full-screen mobile FloatingWindow sheets must preserve, rather than overwrite, the movable desktop geometry record so a later desktop reopen restores the user's chosen location and size. -->
Movable dashboard pop-outs remember their last desktop location and size, while centered resizable dialogs remember their size. When a pop-out becomes a full-screen sheet at mobile widths (or, for Artifact Gallery, its short-height sheet breakpoint), it leaves that desktop record untouched; reopening it on desktop restores the prior floating geometry.

## Mobile/PWA app icons

The installed mobile/PWA home-screen icons are generated from `packages/dashboard/app/public/logo.svg` by the desktop icon generator. When the Fusion brand mark changes, run `pnpm --filter @fusion/desktop generate:icons` so `packages/dashboard/app/public/icons/icon-192.png` and `packages/dashboard/app/public/icons/icon-512.png` stay aligned with the canonical logo. Also bump `CACHE_NAME` in `packages/dashboard/app/public/sw.js` whenever those icon assets change so installed PWAs refresh the cached launcher images.

## Browser Navigation

The dashboard now handles browser back navigation consistently on desktop and mobile.
Using Back will first dismiss open modals and then step back through in-app view changes before leaving the app.
When task detail is open from a board card, task popup, mobile list row, right-dock/activity/onboarding link, deep link, or another task detail link, one browser, iOS edge-swipe, or Android Back action closes the current detail first and restores the prior dashboard context (for example, nested task detail → previous task detail, or task detail → board/list).
<!-- FNXC:TaskDetailSwipeBackDocs 2026-07-15-10:36: Mobile task popups now register the same navigation entry as modal and full-panel task detail, so every Back delivery mechanism dismisses the popup before it can leave the originating Board or List. -->
On mobile board-card detail, **Back to board** also restores the prior board/card scroll position so the same lane context remains visible.
<!-- FNXC:BoardNavigationDocs 2026-06-29-20:45: Mobile full-panel task detail temporarily replaces the board, so the user-facing navigation guide must document that Back to board restores the board/card scroll context instead of returning to the top of the board. -->
This behavior used to be mobile-only, and now applies across all viewports.
Task Detail modal opens from onboarding, activity log, and task-to-task navigation now all register navigation history entries, so Android back swipe/button dismisses them consistently.

## Left Sidebar Navigation (experimental)

**Left Sidebar Navigation** is enabled by default for desktop/tablet project screens, moving project navigation out of the Header and into a persistent left sidebar. To opt out, open **Settings → Experimental Features** and turn **Left Sidebar Navigation** off (`leftSidebarNav: false`).

<!-- FNXC:DashboardDocs 2026-06-22-00:00: The dashboard navigation docs must mirror the post-reshuffle source of truth: the left sidebar owns primary content views plus Workflows, Import Tasks, and Automations, while the right dock owns only inline tool panels. -->
<!-- FNXC:DashboardNavigationDocs 2026-06-22-09:30: FN-6897 synced the user-facing navigation guide after the sidebar/dock reshuffle. Desktop/tablet navigation is split between left-sidebar main-content destinations, a persistent far-right tools dock, and the footer-launched Terminal; stale Header overflow, duplicate dock/sidebar, and standalone Stash Recovery affordances must not be documented as current behavior. -->

When enabled on desktop or tablet project screens, the sidebar starts with a centered **New Task** button that opens the existing New Task dialog from any project screen. Expanded mode shows the plus icon and **New Task** label; collapsed rail mode keeps the centered icon-only button accessible through its label/title. Below that action, the sidebar contains primary destinations (**Board**, **List**, **Agents** when enabled, **Command Center**, **Planning**, **Missions**, **Chat**, **Artifacts**, **Mailbox**, and plugin primary views) followed by secondary destinations (**Workflows**, **Import Tasks**, **Automations**, optional **Evals**, **Goals**, **Research**, **Insights**, **Skills**, **Memory**, **Dev Server**, and plugin overflow views when their flags/plugins are enabled). The footer contains the sidebar collapse toggle directly above **Settings**.

Use the desktop/tablet sidebar this way:

1. Select **New Task** at the top of the sidebar.
   Expected outcome: the existing New Task dialog opens from any project screen, including advanced options such as priority, execution mode, workflow/model routing, and GitHub tracking.
2. Select a primary destination such as **Board**, **Command Center**, **Planning**, or **Artifacts**.
   Expected outcome: the selected view renders in the main content region and the sidebar item receives the active highlight.
3. Select **Workflows**, **Import Tasks**, or **Automations** from the secondary section.
   Expected outcome: each surface opens as an embedded main-content view. **Import Tasks** is the GitHub import surface.
4. Use the footer **Collapse** control or drag the right-edge resize handle.
   Expected outcome: the sidebar switches between labeled and icon-only rail modes or persists the resized width in browser `localStorage` (`fusion:left-sidebar-collapsed` and `fusion:left-sidebar-width`) for the next reload.

While the sidebar is active on desktop/tablet project screens, Board and List workflow controls move into the Header slot that replaces the hidden view toggle. Board and List share one workflow dropdown: each workflow row includes an inline edit action, and a persistent **New workflow** action remains at the bottom of the dropdown while the workflow list scrolls. The standalone workflow row above the board/list content is removed in this mode. When the flag is off, outside project screens, or on mobile, workflow controls remain inline with the same consolidated dropdown.

The active nav-item highlight and the resize-handle hover/focus accent track the active color theme's `--accent` token across all themes, so shadcn, forest, ocean, and other themes no longer show a fixed blue selected state. The Header retains the Fusion brand and project selector, keeps non-navigation controls, and hides duplicate desktop view-toggle entries while the sidebar is active.

On mobile viewports (`<=768px`), the sidebar is not rendered even when the default-on setting is enabled. The existing bottom `MobileNavBar` remains the navigation surface, with mobile-only More-sheet entries for compact tools such as Git Manager, Terminal, Files, and **Import from GitHub**.

## Right Dock (experimental, default on)

The **Right Dock Panel** experiment is enabled by default. To disable it, open **Settings → Experimental Features** and turn off **Right Dock Panel**.

When enabled on desktop or tablet project screens, the right dock is a persistent far-right tools sidebar in the project content row. By default it opens as an overlay so the main content does not reflow. Use the dock toolbar pin action to switch into push mode, where the dock becomes an in-flow pane that shrinks the main content beside it; unpinning returns to overlay mode. The selected tool, open/closed state, pinned push-mode state, width, and expanded modal size persist across reloads.

If **Settings → Appearance → Open tasks in the right sidebar** is enabled, board task-card clicks open task detail inside this right dock and keep the board visible. The setting is default off; mobile or hidden/inactive dock states automatically fall back to the existing full-panel task detail unless the task-popup setting below is enabled, and non-board task-open paths keep their existing behavior.

<!-- FNXC:MobileTaskPopups 2026-07-13-00:00 (FN-7945): Board-card and List row/card task opens have a separate default-off popup setting so operators on desktop, tablet, and mobile can opt into the existing FloatingWindow task popup when they want the board or List view visible; ordinary popup routing takes precedence over the right dock, while deep-tab, context-menu, and non-board/List opens keep their existing paths.
FNXC:TaskPopupGeometry 2026-07-03-00:00: Desktop/tablet task popups share a persisted geometry key across task IDs so operators can size and place the popup once, then open other tasks without repeating that setup. Mobile remains a full-screen sheet regardless of saved desktop geometry.
FNXC:RightDockTaskPopup 2026-07-03-00:00: The same task-popup preference also applies to ordinary clicks in the right-dock Tasks list so that opted-in operators never lose the list to embedded detail by clicking a dock task row.
FNXC:TaskPopupLayer 2026-07-04-18:36: Ordinary task popups sit on the board/task-detail layer instead of the global floating-utility stack so the board/list context remains visually primary while Terminal, Quick Chat, file browser, workflow editor, and other utility windows keep their top utility stacking.
FNXC:TaskPopupViewGating 2026-07-15-15:20: FN-8016 makes popup view scoping default-on for every dashboard view. Hidden popups are render-only hidden, not closed, so snapshots and shared geometry survive navigation; same-task popups remain independently addressable by origin view. -->
**Settings → Appearance → Open tasks as popups** changes ordinary board task-card clicks, List row/card opens, and right-dock Tasks-list clicks across desktop, tablet, and mobile viewports. When enabled, those clicks use the existing task popup/FloatingWindow surface on the board/task-detail layer instead of the full-panel task detail, List split-detail/docked detail, or right-dock task detail, keeping the board, List view, or dock list visible in the background while utility windows keep their higher global stacking. On desktop and tablet, task popups restore the last saved popup size and position between tasks; on mobile, task popups stay full-screen sheets. Deep `changes`/`retries`/`workflow` opens, List context-menu/refine actions, task-detail links, plugin/graph opens, and explicit pop-out actions keep their existing paths.

**Settings → Appearance → Keep task popups on the view where they were opened** is enabled by default. Every task-detail popup is attached to its exact originating view, including Planning, Agents, Command Center, Documents, Missions, and plugin views: navigating elsewhere hides it without closing it, and returning re-shows it in the same saved position. You can open the same task independently in more than one view; closing or pressing Escape on one popup does not affect the other. Disable this setting only to restore legacy globally shared popups. Legacy saved popups without an origin remain visible everywhere for compatibility.

<!-- FNXC:DashboardNavigationDocs 2026-06-27-00:00: The right dock now hosts Chat as an inline tool panel; keep this user-facing roster aligned with STATIC_OVERFLOW_VIEW_ENTRIES so users know Chat can also pop out from the dock. -->
<!-- FNXC:RightDockTasks 2026-06-28-19:55: The dock task-detail overlay is now anchored to the first-class Tasks tool tab. Document that Tasks is a dock-only auxiliary surface with a last-viewed detail/list fallback, not a new primary navigation destination. -->
<!-- FNXC:RightDockTasks 2026-06-28-21:08: The right-dock Tasks list is an active-work queue by default: completed tasks require the local Show Done toggle, archived tasks stay hidden, and both task-detail back affordances return to this list. -->
The dock toolbar has built-in inline tool panels for **Tasks**, **Files**, **Chat**, **Activity Log**, **Git Manager**, **Dev Server** when enabled, **Secrets**, **Todos** when enabled, and **Pull Requests**. These tools render in embedded mode inside the dock instead of opening fixed popup overlays; **Files** opens by default and is the fallback when browser storage points at a removed dock key. The **Tasks** tab shows the last task opened in the dock; when no dock task is active, it shows a compact clickable active-task list. Use **Show Done** to include completed tasks in that compact list; archived tasks stay hidden there. If **Open tasks as popups** is off, clicking a task in this list opens embedded dock detail and either task-detail back button returns to the Tasks list; if the popup setting is on, the click opens the task popup and the list remains visible. Inline dock views have an expand button that opens the same view in a resizable modal for more room. The right-dock **Files** viewer and its expanded pop-out match the Files modal for browser-previewable file types: image, video/movie, audio, and PDF selections render as native browser previews, while editable text files keep the editor and save flow. Plugin overflow views may add additional right-dock tool tabs, except plugin destinations that explicitly belong in the left sidebar.

Use the desktop/tablet right dock this way:

1. Open a project screen with **Right Dock Panel** enabled.
   Expected outcome: the dock appears on the far right with **Files** selected unless a valid previous dock view is stored.
2. Select **Tasks**, **Chat**, **Activity Log**, **Git Manager**, **Files**, or another available tool in the dock toolbar.
   Expected outcome: the selected tool renders inline inside the dock body and the toolbar tab becomes active; **Tasks** either restores the last-viewed dock task or shows the compact active-task list with optional **Show Done** completed-task visibility.
3. Drag the dock's left-edge resize handle, or focus the separator and use the arrow keys.
   Expected outcome: the dock width changes within its min/max bounds and is saved for future reloads.
4. Select the dock expand action.
   Expected outcome: the same inline tool opens in a resizable modal while the dock remains the source navigation surface.
5. Select the dock pin action.
   Expected outcome: pinned mode pushes the main content narrower, unpinned mode overlays the page without reserving space, and the preference is saved for future reloads.
6. Use the Header right-sidebar toggle.
   Expected outcome: the far-right surface opens or closes without creating duplicate left-sidebar destinations; mobile viewports never render or reserve space for the right dock.

Content views such as Artifacts, Research, Insights, Skills, Memory, Evals, Goals, **Workflows**, **Import Tasks**, and **Automations** live in the left sidebar (or compact mobile navigation) rather than the right dock. On desktop/tablet, GitHub import lives under **Import Tasks**; mobile keeps compact GitHub import entries in the More surfaces.

On mobile viewports, the Right Dock never renders. The compact Header actions and bottom `MobileNavBar` keep their existing mobile behavior even when the experiment is enabled.

## Automations

<!-- FNXC:AutomationTools 2026-06-26-00:00: Automation AI-prompt steps now default to the full coding tool set and expose per-step restrictions so operators can intentionally narrow tool access without breaking legacy schedules. -->
<!-- FNXC:AutomationLiveOutput 2026-06-26-00:00: Manual automation runs stream step, text, and tool activity into the Automations card while preserving the final run-result history after completion. -->
<!-- FNXC:Automations 2026-07-12-19:14: Schedule and routine AI-capable model selectors persist an optional Thinking Level on each step. Default/inherit stays empty, concrete off..xhigh values are stored with the JSON step configuration. -->
<!-- FNXC:Automations 2026-07-12-20:30: FN-7903 makes the persisted step Thinking Level runtime-active for scheduled, routine, and manual AI Prompt runs, and maps Create Task step choices onto the spawned task. -->

Open **Automations** from the left sidebar (or the mobile More surfaces) to create cron, webhook, API, or manual routines. AI Prompt steps now run with all selectable coding tools by default: **Read**, **Bash**, **Edit**, **Write**, **Grep**, **Find**, and **Ls**. In the routine editor, use **Allowed tools** on a simple AI Prompt action or any multi-step AI Prompt step to clear or re-select tools. Leaving every tool selected stores the legacy default, so existing schedules continue to run with full tool access; clearing every box is an explicit no-tools configuration. AI Prompt and Create Task action model selectors also include **Thinking Level**: leave it on **Default** to inherit the project setting, or choose a concrete reasoning effort. Scheduled, routine, and manual AI Prompt runs apply that saved reasoning effort at session creation; Create Task steps copy it onto the task they create.

When you choose **Run now**, the routine card opens a **Live output** panel while the manual run is active. The panel appends step status, AI text deltas, and tool start/finish activity as the run executes, then the card falls back to the persisted final run output and run history once the server records the result. The same `RoutineCard` surface is used by the floating modal and embedded Automations view, so live output appears in both presentations and collapses into a single-column card layout on mobile.

<!-- FNXC:DatabaseBackup 2026-07-04-00:00: FN-7537 fixed a manual/cron divergence for the built-in "Database Backup" automation/routine: a manual "Run now" now intercepts the in-process backup exactly like the scheduler, instead of shelling out to a possibly-missing global `fn`/`runfusion.ai` binary. -->
The built-in **Database Backup** automation runs the backup in-process (via the engine's already-open task store) on both its scheduled cron trigger and a manual **Run now**, matching behavior identically between the two triggers — it never shells out to a separately-installed `fn`/`runfusion.ai` binary, which could be missing or out of date on the host.

## Deep Links

Use deep links to open a specific task directly from notifications, chat, or external tools.

- `/tasks/<TASK_ID>` (for example, `/tasks/FN-1234`) opens that task, and can include `?project=<project-id>` for multi-project routing.
- `/?task=<TASK_ID>[&project=<project-id>]` is the canonical in-app form and opens the task detail modal on load.
- Selecting a project from the dashboard project switcher writes `?project=<project-id>` into the URL and preserves unrelated query parameters/hash fragments, so refreshing the browser keeps the same selected project instead of returning to the default project.
<!-- FNXC:ProjectUrlState 2026-07-02-00:00: The project switcher now uses the same `?project=` URL contract as task deep links so non-default project selections survive browser refresh and can be shared/bookmarked. -->
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

<!-- FNXC:FileEditor 2026-07-12-00:00: Workspace file editing now auto-saves by default in the Files modal and right-dock Files view, with a shared persisted toolbar toggle so operators can return to manual Save/Discard behavior when needed. -->
Editable workspace text files auto-save after a short pause by default in both the Files modal and the right-dock Files view. Use the editor toolbar's **Auto-save** toggle to turn that shared preference off or on; when it is off, the existing **Save**, **Discard**, and Cmd/Ctrl+S manual flow applies.

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
- GitLab tracking badges on task cards for linked GitLab project issues, group issues, and merge requests; stale GitLab metadata uses a warning-colored badge while GitHub badges remain unchanged.
- GitHub provenance marker on task cards imported from GitHub (`sourceType: github_import`), shown in the footer with other external-source metadata
- Task card header meta badges group priority and fast mode in the header; priority badges include the shared urgency glyph/color language (low blue/info, high amber/warning, urgent red/error) while agent-created provenance renders in a dedicated bottom-left row ahead of workflow identity so the ID/status/actions header does not wrap on narrow cards. Agent labels prefer `sourceMetadata.agentName` over raw agent IDs.
- **Settings → Appearance → Show cost badges on task cards** is default off. When enabled, board cards with recorded positive token usage show a compact derived-cost badge with the card's other footer/meta chips; unpriced models display `—`, and cards with no usage render no badge shell.
<!-- FNXC:TaskCardCostBadge 2026-07-11-12:25: The card spend badge is opt-in because card footers are dense. It must remain guess-free (unpriced `—`, no fabricated `$0`) and absent for tasks without positive token usage. -->
<!-- FNXC:TaskCardLayout 2026-07-10-00:00: FN-7780 moved agent-created provenance out of the header meta-badge cluster into a bottom row. Keep dashboard docs aligned so operators do not expect the agent chip to participate in header wrapping. -->
<!-- FNXC:PlannerOversight 2026-07-04-00:00: FN-7516 adds a read-only effective oversight-level badge plus an active-overseer-state indicator to the card-meta-badges cluster. The overseer-state indicator is derived card-locally from already-on-Task fields (mirroring the engine's stage-resolution precedence) rather than a new engine-plumbed field, since @fusion/engine's in-memory monitor state is not persisted onto Task/exposed via API. -->
<!-- FNXC:PlannerOversight 2026-07-04-16:00: round-2 code-review fix — when a card must fetch the workflow's effective oversight tier (no synchronous per-task override), neither badge below renders until that fetch resolves; the schema default must never render as a guess while the true workflow tier is unknown. -->
<!-- FNXC:PlannerOversight 2026-07-04-19:10: FN-7539 fix — the badge was rendering on virtually every card because the schema default `autonomous` tier was treated as "meaningfully configured". Narrowed the gate so an inherited (no per-task-override, no non-default workflow tier) `autonomous` level renders no badge; only an explicit per-task override or a resolved workflow/effective tier that is not the plain inherited default surfaces the badge. -->
- Task cards show a read-only **oversight-level badge** (`Observe`, `Steer`, or `Auto-recovery`) in the meta-badges cluster reflecting the effective planner-oversight level, but only when oversight is *meaningfully configured* — an explicit per-task override (including an explicit `autonomous` override), or a resolved workflow/effective tier of `observe`/`steer` (`data-testid="card-oversight-badge"`). A card that merely **inherits** the schema default `autonomous` tier (no per-task override, no non-default workflow tier) renders no badge and no empty `.card-meta-badges` shell. The badge is also absent when the effective level is explicitly "off", **and** while an inherited (no per-task-override) workflow tier is still being resolved (in flight or not yet fetched) — it never shows a guessed default during that window.
<!-- FNXC:PlannerOversight 2026-07-04-HH:MM: FN-7542 removed the FN-7516 active-overseer-state ("Executor") indicator described above as unwanted per-card noise — it fired on nearly every in-progress card. The oversight-level badge documented above is unaffected. -->
<!-- FNXC:PlannerOversight 2026-07-11-00:00: FN-7592 reintroduced a compact active-overseer state indicator as an Eye glyph instead of a wide text badge, using the engine-provided transient plannerOverseerState rather than locally guessing from task fields. -->
<!-- FNXC:TaskRevert 2026-07-16-00:00: FN-8066 adds durable source-task revert provenance to the shared board/List TaskCard footer. -->
- Completed and archived task cards show a compact **Reverted** footer chip after a clean or already-reverted git outcome has persisted the source task's revert marker; conflicts, AI undo tasks, and revert PRs awaiting merge do not show it.
- Task cards show a compact **planner-overseer eye badge** (`data-testid="planner-overseer-state-badge"`) when the engine reports a non-idle transient `plannerOverseerState`. The eye badge is an active-overseer state marker, not a human-read/view indicator: `watching` means passive monitoring, `steering`/`recovering` mean active guidance or recovery is underway, and `awaiting-confirmation` means a human decision is required before the overseer can continue. Hover exposes the composed tooltip with the overseer's reason, watched stage/signal, and pending-confirmation note when present.
<!-- FNXC:PlannerOversight 2026-07-04-17:00: FN-7517 adds interactive task-detail planner-overseer controls (quick level change, manual nudge, stop oversight, explain current action) alongside the FN-7516 read-only card badges above. These controls live ONLY in TaskDetailModal, not TaskCard.

FNXC:PlannerOversight 2026-07-05-00:00: FN-7604 collapses the desktop inline cluster (documented below through FN-7545/FN-7546) into the single universal overflow-menu dropdown that FN-7545 originally built for mobile only — the dropdown is now the ONE canonical surface on every viewport, desktop included. -->
- The task detail modal's inline meta-controls cluster (next to Priority/Execution mode) exposes planner-overseer controls behind a single compact **"Oversight" overflow-menu button** (`data-testid="detail-oversight-menu-trigger"`, `MoreVertical` icon, `aria-haspopup="menu"`) on every viewport, desktop and mobile alike. Clicking the trigger opens a `role="menu"` popover (mirroring the existing move-action dropdown pattern) containing: a **quick oversight-level select** (`data-testid="detail-oversight-level-select"`) that writes the per-task `plannerOversightLevel` override (Off/Observe/Steer/Autonomous recovery) or clears it back to the inherited workflow/project default via an "Inherit" option; a **manual nudge** button (`data-testid="detail-overseer-nudge"`) that asks the overseer to inject one guidance-only steering comment into the currently watched stage right now (never a merge/PR/destructive action), disabled when the overseer is off/inactive or the task is user-paused/done/archived/`autoMerge:false` in-review; a **stop oversight** button (`data-testid="detail-overseer-stop"`) that disables active oversight for the task (confirmation-gated), hidden once oversight is already off; and an **explain current action** button (`data-testid="detail-overseer-explain"`) that toggles a small read-only panel (`data-testid="detail-overseer-explain-panel"`) showing the overseer's watched stage, reason, last action, and attempt count/limit, with a non-empty-shell inactive state when the overseer is not currently watching. All three action controls call the `POST /tasks/:id/overseer/nudge`, `POST /tasks/:id/overseer/stop`, and `GET /tasks/:id/overseer/explain` routes. The trigger itself is withheld entirely when none of the menu's controls would render (no empty-shell overflow button for the unresolved-default case).
<!-- FNXC:PlannerOversight 2026-07-04-20:30: FN-7546 clarifies the cluster above — operators reported the buttons were unlabeled and looked inert, with only a hover title explaining why. Adds a visible group label and an always-visible disabled-reason line, and makes Explain always openable since it never mutates anything. -->
- The controls inside the Oversight menu carry a visible, non-interactive **`"Overseer controls"` group label** (`data-testid="detail-oversight-controls-label"`) so Nudge/Stop/Explain read as an identifiable cluster rather than unlabeled entries; the label is gated by the same `(hasTaskOversightOverride || workflowOversightResolved) && !oversightIsOff` condition as the buttons, so it never renders when oversight is Off/unresolved (opening the menu in that state shows only the level select). When **Nudge** is disabled, an always-visible helper line (`data-testid="detail-overseer-nudge-disabled-reason"`) states the reason in-DOM (mirroring the existing hover `title`) instead of relying on a mouse-hover tooltip alone. **Explain** is read-only and non-mutating, so it is never disabled purely because the overseer is inactive — clicking it always opens/closes the panel, which shows the overseer's live state when watching or an informative "not currently watching this task" message otherwise. Nudge's mutating enablement rule (`canNudgeOverseer`, including the human-control suppression cases) and Stop's confirmation dialog are unchanged.
<!-- FNXC:PlannerOversight 2026-07-04-19:00: FN-7545 originally introduced this overflow menu for mobile only, collapsing the level-select/nudge/stop/explain controls behind the trigger below the 768px breakpoint while desktop kept an inline cluster.

FNXC:PlannerOversight 2026-07-05-00:00: FN-7604 removed that desktop-inline branch. The overflow-menu trigger + popover described above is now the SINGLE canonical surface at EVERY viewport — there is no longer a desktop/mobile split. -->
- The Oversight overflow-menu trigger and its popover render identically at every viewport (desktop and mobile): the same testids, the same enablement/visibility rules, and the same `role="menu"`/`role="menuitem"` popover semantics. Menu-open auto-focus lands on the first actionable button menuitem, never the native level `<select>`, so the OS option picker never auto-opens on top of the custom popover (FN-7562).
<!-- FNXC:PlannerOversight 2026-07-04-18:00: FN-7519 adds a read-only Intervention Timeline. FN-7571 (2026-07-04-19:00) relocates it from an inline mount below the FN-7517 controls into the task-detail Activity view dropdown as a fourth "Interventions" segment, alongside Live/Feed/Raw. -->
- The task detail modal's **Activity** tab view dropdown (Live/Feed/Raw) gains a fourth **Interventions** option, shown only when planner oversight is active for the task (same gate as the former inline mount: `(hasTaskOversightOverride || workflowOversightResolved) && !oversightIsOff`). Selecting it renders the **Intervention Timeline** (`data-testid="planner-intervention-timeline"`) inside the Activity panel, listing every recorded planner-overseer intervention for the task, newest-first: watched stage, reason, action taken, outcome (with a `.status-dot` indicator using semantic outcome tokens), an attempt count/limit badge (only when both are present), and source links (agent log / review comment / failed check / merge error / PR state / generic URL). It renders a calm "No planner interventions yet" empty state rather than an empty shell when there are none. When oversight is off or unresolved, the Interventions option is absent from the dropdown entirely (no leftover empty segment), and if it was previously selected the view falls back to Live rather than leaving a blank panel. Entries are read via `GET /tasks/:id/overseer/interventions`, which assembles them from the existing run-audit store under the `overseer:intervention` mutation type (`recordPlannerIntervention`/`getPlannerInterventionTimeline` in `@fusion/core`). This is a pure read surface — FN-7520 wires the actual intervention-producing call-sites.
- Task detail surfaces show the selected/effective workflow identity near the task's workflow controls so individual cards remain understandable when Board is in **All workflows** or another aggregate/mixed context.
- Board task cards support a context menu from right-click, keyboard context menu / Shift+F10, the visible ⋯ button, or touch long-press for detail-aligned lifecycle actions without changing normal card clicks. The menu opens as an independent overlay so it stays visible beyond the card or column edge while remaining clamped to the viewport. On mobile, long-press opens that menu without selecting card text or showing native copy/paste callouts. Selecting an action applies that exact action once and dismisses the menu. Cards that are still in Planning/ideas/hold columns include **Plan**, which opens Planning Mode seeded from the card and creates a new planned task when completed; completed card context menus include **Refine**, which opens the existing task-detail refinement feedback modal for the same task and keeps it open until the operator uses an explicit close path or an enabled backdrop dismissal.
<!-- FNXC:BoardCardActions 2026-06-29-00:00: Board card context menus are documented as alternate entry points only; normal click still opens task detail, and mobile long-press must not trigger detail behind the menu.
FNXC:TaskDetailRefine 2026-07-12-00:00: The Refine feedback modal must not be dismissed by the same mouse/touch interaction that opened it; backdrop dismissal follows the global default-off modal-dismiss preference.
FNXC:DoneTaskRefine 2026-07-01-00:00: Completed Board card context menus must label Refine only because they now route to the real task-detail refinement feedback modal instead of a dead row or direct API call.
FNXC:TaskContextMenu 2026-07-01-00:00: Board/List touch context-menu item taps must invoke the selected action exactly once and close the menu, matching desktop right-click and keyboard context-menu activation.
FNXC:TaskContextMenu 2026-07-01-00:00: Board card context menus must behave like independent overlays because Board columns intentionally clip and scroll their bodies for kanban containment.
FNXC:TaskCardMobileSelection 2026-07-01-00:00: Mobile Board long-press is a task-action gesture, not a text-selection gesture; document that the native selection/copy callout is suppressed while normal card clicks and edit textareas keep their behavior.
FNXC:TaskContextMenu 2026-07-13-00:00: Pre-execution Planning/ideas/hold cards expose Plan only on Board/List menu hosts that wire Planning Mode, and the handoff creates a new task rather than mutating the source card. -->
<!-- FNXC:WorkflowBadges 2026-06-30-09:10: Task cards and task detail need workflow-name badges wherever mixed-workflow board contexts can hide the selected lane, especially the Board-only All workflows aggregate. -->
<!-- FNXC:BoardDoneSorting 2026-06-29-00:00: The Done board column exposes a local descending sort selector so operators can review either latest completions or highest task IDs without changing other lifecycle columns. -->
<!-- FNXC:BoardDoneSorting 2026-06-29-20:28: Document both Done sort modes as descending-only and Done-column-only so legacy Done and workflow complete-lane operators understand the selector does not change other lifecycle columns. -->
<!-- FNXC:BoardDoneActions 2026-06-30-00:00: Done/complete column sort choices and Archive All Done now live in the column actions dropdown, so docs must point operators to the menu instead of separate header controls. -->
<!-- FNXC:PlanApproval 2026-07-01-08:47: Operators need the Board Planning/intake column action menu documented as a binary shortcut for project plan auto-approval while Settings remains the full workflow/auto-approve/require-all editor.
FNXC:PlanApproval 2026-07-07-00:00 (FN-7653 correction): the switch is intake/planning-column-only — it must not appear on hold (Todo-like) columns, even though hold columns also gate planning-adjacent behavior. The built-in Coding workflow's Todo column (hold trait) was wrongly showing this control; docs now match the corrected intake-only gating.
FNXC:TriageRename 2026-07-08-00:00 (FN-7660): the board column formerly labeled "Triage" is canonically "Planning"; docs refer to it as the Planning column throughout. -->
- The Planning column actions dropdown includes **Auto-approve plan**. Turning it on sets the project plan approval mode to auto-approve all planned tasks; turning it off returns to the workflow/default plan approval behavior. In workflow-mode Boards, the same switch appears only on the intake/planning column and on the equivalent **All workflows** aggregate intake column — not on hold (Todo-like) or other lifecycle columns. Use Settings → Merge for the full three-state project control, including **Require approval for all tasks**.
- Column ordering semantics: `todo` mirrors scheduler pickup order (priority descending, then oldest `createdAt`, then task ID); `triage`, `in-progress`, and `in-review` remain priority-first with task-ID tie-breaks; `done` defaults to most recent completion first (`columnMovedAt`, then `updatedAt`, then `createdAt` fallback) and can be switched from the Done/complete column actions dropdown to descending task ID. In workflow mode, non-archived columns marked with the `complete` flag use the same Done menu items even when their column ID or label is customized.
<!-- FNXC:ArchivePagination 2026-07-08-00:00 (FN-7659): the Archived column is newest-first (`archivedAt DESC`), not priority-first — it is loaded from a dedicated server-backed paged read and is intentionally excluded from every other column's client-side priority/task-ID sort. -->
- The Archived column loads newest-first (most recently archived first) in server-backed pages of 100 tasks. Expanding the collapsed Archived column fetches the first page; a **Show more** button at the bottom fetches the next page on demand. The full archive is never loaded in one request — large archives page incrementally as the operator scrolls and clicks Show more.
- Done-column sorting has two descending modes: **Completion date (newest first)** keeps the default completion-time order, while **Task ID (newest first)** places the highest numeric task IDs first. The sort actions are only shown in Done/complete column action menus, including custom workflow completion lanes; Archive All Done lives in the same menu when available.
- On mobile, both default and workflow-mode boards fill the project viewport while the column strip remains the internal horizontal scroller with contained edge overscroll.
<!-- FNXC:WorkflowSelection 2026-06-29-13:34: Board, List, Header, and Graph workflow selectors now share a durable per-project selection so operators return to the same lane after remounts, task refreshes, or respecification flows; stale saved workflow ids must fall back to a valid default/first workflow instead of hiding all tasks. -->
<!-- FNXC:WorkflowSelection 2026-06-29-18:37: The All workflows option renders an aggregate column/task set across workflows while keeping workflow-specific creates and edits scoped to real workflow ids.
FNXC:WorkflowSelection 2026-06-30-00:00: The view preference persists either a real workflow id or the All workflows sentinel so refresh/remount restores the operator's last top-level workflow context without treating the sentinel as a backend workflow id.
FNXC:WorkflowSelection 2026-07-01-00:00: All workflows is available on Board, List, Planning, Missions, and Graph top-level selectors; Planning/Missions task creation receives default/no-specific-workflow behavior instead of the sentinel. -->
<!-- FNXC:WorkflowSelection 2026-06-29-23:58: All workflows quick-create must use a real workflow intake/default column rather than a synthesized lifecycle column, so custom-default boards do not create tasks into invalid or disappearing columns. -->
<!-- FNXC:WorkflowSelection 2026-06-29-23:59: Workflow counts and All workflows grouping resolve each task's effective workflow before evaluating column visibility, so a shared column id hidden in one workflow does not leak that workflow's hidden tasks into another workflow's visible aggregate lane.
FNXC:WorkflowSelection 2026-07-01-23:04: Board/List dropdown counts use computeWorkflowStatusCounts as the single source of truth. The All workflows row reports the helper-owned aggregate exactly once and must not be recomputed by summing the map that already contains the aggregate sentinel. -->
<!-- FNXC:WorkflowSelection 2026-06-29-21:40: Refinement creation from Task Detail and done-task chat must preserve both the source task workflow and the operator's selected Board/List lane, so non-default workflow users do not get bounced back to Coding/default after refinement. -->
- Board and List workflow switchers use a themed dropdown instead of a native select. The closed trigger shows the workflow identity (Fusion icon for built-ins, optional custom icon for custom workflows), name, and chevron only; compact Todo / In Progress / Done counts derived from workflow column flags (excluding archived and board-hidden columns) refresh each time the dropdown opens and appear while the dropdown is expanded, including on each workflow option. Built-in lanes with synthesized trait-less lifecycle columns fall back to canonical column ids (`todo`, `in-progress`, `done`, and `archived`) for those counts. Board and List also show **All workflows** before real workflows as a dashboard-only aggregate view with combined counts that sum only the real visible workflow rows exactly once and a deterministic union of visible workflow columns; shared column ids use the default workflow label/flags when available, otherwise the first workflow definition that declares the column. Hidden columns stay workflow-scoped in the aggregate: a task whose effective workflow hides a shared column is omitted from that aggregate column even if another workflow exposes the same column id. That option is not editable, persists as top-level workflow view state, and quick-create/Plan/Subtask/Mission handoffs translate it to a real default workflow id or no-specific-workflow behavior so task creation never sends the sentinel. Each real workflow option row also exposes an inline edit action, and a persistent **New workflow** footer stays visible below the scrollable option list. The open listbox grows from the longest workflow name plus its count/edit decorations while remaining viewport-bounded; the closed trigger stays narrow and ellipsized. Those inline count badges intentionally use the same board column color tokens as cards: `--todo`, `--in-progress`, and `--done`.
- When workflow columns are enabled, Board and List hydrate the last successful workflow-lane payload from a per-project session cache; cold loads show a neutral skeleton until settings and workflow metadata are known, avoiding a legacy single-lane flash. The selected workflow is remembered per project in durable browser storage and restored when returning to Board/List after task refreshes, route changes, respecification flows, or refinement creation from Task Detail and done-task chat; Board, List, Planning/Missions header selectors, and Graph also restore the dashboard-only **All workflows** aggregate view when that was the last selected top-level workflow context. If a saved real workflow is later deleted, Fusion falls back to a valid default/first workflow so tasks remain visible.
- Briefly leaving Board/List for a task detail or another non-task-SSE view preserves the current in-memory task snapshot. Returning to Board/List reuses that fresh snapshot immediately and restores live SSE updates without an extra all-task fetch; Fusion still runs one catch-up fetch when task data is missing, stale, or from a failed refresh.
<!-- FNXC:BoardTaskCache 2026-06-29-20:05: Board/List returns from non-task-SSE views should reuse a fresh in-memory task snapshot to avoid redundant all-task fetches and loading flashes, while stale, missing, or errored snapshots still trigger one catch-up fetch and restore SSE updates. -->

![Board view](./screenshots/dashboard-overview.png)

## List View

List view is optimized for dense task management.

Features:

- Sectioned task table grouped by lifecycle column
- Sortable columns (ID/title/status/column)
- Column visibility toggles and optional hide-done filtering
- Bulk selection + batch model, node, and task thinking-level updates
- Bulk Pause / Unpause / Archive actions from the selection toolbar (`Pause selected`, `Unpause selected`, `Archive selected`) for fast batch task state management.
- Bulk delete from the selection toolbar (`Delete selected`): archived selections are skipped automatically, and dependency-conflict failures can be force-deleted per task after a danger confirmation that removes dependency references.
- Desktop List view keeps the two-pane table/detail split. Tablet-width and mobile viewports use the single-pane card layout so list controls and quick-add stay full-width; tapping a task opens detail instead of selecting an embedded split pane.
- List rows and tablet/mobile cards support the same task context menu as Board cards from right-click, keyboard context menu / Shift+F10, or touch long-press without changing ordinary row selection or tap-to-open behavior. Selecting an action applies that exact action once and dismisses the menu, including **Plan** for tasks still in Planning/ideas/hold columns and **Refine** for completed tasks; the opened refinement feedback modal stays open until the operator closes it intentionally.
<!-- FNXC:TaskDetailRefine 2026-07-12-00:00: List-originated Refine uses the same task-detail feedback modal as Board and must preserve the stay-open invariant across desktop and mobile activation.
FNXC:ListView 2026-07-10-00:00: FN-7809 makes tablet List view use the same single-pane card/detail route as mobile because the desktop split sidebar clipped the primary controls and quick-add composer at 769–1024px.
FNXC:ListContextMenu 2026-06-29-00:00: List context menus are alternate action entry points only; desktop left-click still selects the split-pane detail and mobile tap still opens detail while long-press suppresses the follow-up tap.
FNXC:ListContextMenu 2026-06-30-00:20: Keyboard access is part of the Board/List context-menu contract, so docs must include the context-menu key and Shift+F10 alongside pointer and touch entry points.
FNXC:DoneTaskRefine 2026-07-01-00:00: Completed List row/card context menus route Refine to the existing task-detail feedback modal so desktop right-click and mobile long-press share the same refinement flow.
FNXC:TaskContextMenu 2026-07-01-00:00: Mobile List card long-press action taps must select and dismiss through the same shared TaskContextMenu invariant as Board and Task Detail surfaces.
FNXC:TaskContextMenu 2026-07-13-00:00: List row/card menus share the Board Plan gating: Planning/ideas/hold tasks can seed Planning Mode only when the List host has the planning route wired. -->

![List view](./screenshots/list-view.png)

## Import Tasks (GitHub import)

**Import Tasks** is the desktop/tablet sidebar destination for importing GitHub issues and pull requests onto the board. It embeds the GitHub import surface in the main content region; the same component can still appear as a modal from compact mobile paths.

Use Import Tasks on desktop/tablet:

1. Select **Import Tasks** in the left sidebar.
   Expected outcome: the GitHub import surface opens in the main content region with GitHub issue and pull request tabs.
2. Choose or enter a repository (`owner/repo`). If Git remotes are detected, use the remote selector.
   Expected outcome: Fusion loads import candidates for the selected repository and shows repository/load state feedback.
3. Stay on **Issues** or switch to **Pull Requests**, then optionally enter issue label filters before loading results.
   Expected outcome: the list pane shows matching open issues or pull requests and marks entries that already exist on the board. Use **Hide imported** beside the imported count to remove those unavailable rows from the current Issues, Pull Requests, or GitLab list; turning it off restores the greyed **Imported** rows. After a successful GitHub or GitLab import, the source row is marked **Imported** and made unavailable immediately, without waiting for the board list to refresh.
4. Select an issue or pull request row.
   Expected outcome: the full-width candidate list stays visible while its title, source link, body, labels or PR metadata, and import controls open in a draggable and resizable detail window. On mobile, that detail is a full-screen sheet. When selected title/body content is in another language, the detail offers **Translate**, **Show original** / **Show translation**, and **Dismiss**; translation is display-only. A pull request preview also shows its checks; use **Refresh checks** to fetch current GitHub check status and comments without reopening the detail. Each failed check has a **Create fix task** action that creates a new task prefilled with the repository, PR, branches, check status, and check-details link.
5. Select the import action in the detail window. Pull requests use **Resolve feedback**, which creates a task to resolve reviewer feedback and address failed CI checks; issues keep **Import**. Each GitHub issue and pull-request comment also has **Import as task**, which creates a separate resolve-feedback task quoting that comment and linking its source without closing the detail window.
   Expected outcome: Fusion creates the requested task, preserves GitHub provenance/tracking metadata, and returns the completed PR/issue import to the list while leaving comment imports available for further feedback.

Leaving and returning to **Import Tasks** (for example switching to Board and back) restores the prior context for the current project — provider (GitHub/GitLab), active Issues/PRs tab, label filter, selected repository/remote, GitLab project/group inputs, the **Hide imported** preference, and the previously selected issue/PR — instead of resetting to defaults. When GitLab integration is disabled in Settings, the GitLab provider tab is hidden and any restored GitLab provider preference opens on GitHub instead; saved GitLab URLs and tokens remain configured. The restored selection re-validates against the freshly reloaded list; a selection that no longer exists (e.g. the issue was closed upstream) clears gracefully rather than showing a stuck or empty preview. First-time opens with no prior state keep the existing default-remote auto-detect behavior. State is scoped per project and does not leak across projects.

Use GitHub import on mobile:

1. Open the compact Header actions or bottom **More** sheet and select **Import from GitHub**.
   Expected outcome: the same import workflow opens in the mobile modal layout.
2. Choose the repository, issue/PR tab, candidate row, and import action.
   Expected outcome: Fusion creates the board task with the same GitHub provenance/tracking metadata as the desktop/tablet **Import Tasks** view.

## Graph View

Graph view visualizes task dependencies as an interactive node/edge map.

Navigation:
- Desktop/tablet: left sidebar or applicable plugin/content navigation entry for **Graph** when the dependency graph surface is enabled
- Mobile: **MobileNavBar → More → Graph**

Behavior:
- Shows only tasks in `triage`, `todo`, `in-progress`, and `in-review`
- Excludes `done` and `archived`
- On desktop/tablet, the header workflow dropdown mirrors Board/List selection behavior, restores the same per-project saved workflow when available, and filters graph nodes to tasks assigned to the selected workflow; **All workflows** restores the full active-task graph.
- Uses Sugiyama-style layered auto-layout to place nodes by dependency depth
- Renders directed bezier dependency edges (dependent → dependency) with arrowheads
- Supports cursor-centered wheel zoom, pinch zoom, keyboard shortcuts (`Ctrl/Cmd+=`, `Ctrl/Cmd+-`, `Ctrl/Cmd+0`, `Ctrl/Cmd+Shift+F`, `Escape`), and fit/reset controls via the floating toolbar with live zoom percentage
- Pan limits are zoom-aware and based on full graph extents (including negative auto-layout origins), so zoomed-in views can still pan to every rendered node instead of getting trapped by fixed viewport-only bounds
- Dependency graph nodes reuse the same `TaskCard` UI as board/list views, so status badges, progress/steps, mission badges, retry/archive/revert controls, and active-task glow stay visually consistent
- Active graph nodes also add a dedicated top status indicator bar and current-step row highlighting so in-progress execution state stays visible even when zoomed out
- Clicking a graph card opens task details in the shared movable/resizable task pop-out via the host detail handler (`onOpenDetail`, with `onOpenTaskDetail` fallback), while clicking the same card again or empty canvas clears selection.
- On touch devices, single-tap is reserved for pan/drag gestures, so double-tapping a node opens the same shared task pop-out; this does not change selection state.
- Hovering or selecting a node highlights its full upstream and downstream dependency chain; highlighted nodes and connecting edges are emphasized while non-chain nodes are dimmed, and highlight clears when hover/selection is removed
- Nodes support manual drag repositioning with a 4px movement threshold to separate click from drag, using pointer capture and zoom-aware delta scaling for reliable tracking
- Custom node positions persist per project in browser localStorage (`kb:${projectId}:fusion-plugin-dependency-graph:positions`) across refresh/project switches, and **Fit to graph** clears saved positions and restores auto-layout

## Workflow Selection and Editor

Workflows define how a task moves through planning, execution, review, workflow steps, merge, and any custom graph policy. Most coding tasks can stay on the default Coding workflow, but task and board workflow controls can select a different built-in or custom workflow per task. For the built-in catalog and runtime semantics, see [Workflow Steps → Workflow overview](./workflow-steps.md#workflow-overview).

<!-- FNXC:NewTaskWorkflowDropdown 2026-06-30-18:52: The full New Task dialog workflow picker now matches the icon-rich workflow identity used in Board/List selectors while preserving create-time workflowId semantics. -->
When creating a task from the full **New Task** dialog, the **Workflow** advanced control opens a styled dropdown instead of a native select. Built-in workflows show the Fusion mark, custom workflows show their configured compact icon when present, **No workflow** remains the explicit opt-out, and leaving the picker untouched still inherits the project/default workflow.

<!-- FNXC:WorkflowOptionalSteps 2026-07-10-08:00: Operators can now toggle optional workflow steps from the task Edit form as well as the Workflow tab. Edit mode must load the task's resolved workflow catalog without re-seeding from defaultOn, preserving the task's persisted enabledWorkflowSteps until the operator explicitly toggles a step. -->
Optional workflow steps can be toggled from the task **Edit** form's **More options → Workflow Steps** control or from the task's **Workflow** tab. The edit form uses the task's resolved workflow and preserves the task's current stored selection when it opens; workflow-authored `defaultOn` values remain a create-time/runtime default, not an edit-form re-seed.

The workflow editor opens as a full-screen modal editor for inspecting built-ins and authoring custom workflows.

Navigation:
- Open a task or board surface that shows the workflow selector, then choose **Manage…**.
- From the Board or List workflow dropdown, use the inline edit button on a workflow row to open that workflow directly, or use the persistent **New workflow** footer to create a workflow without leaving the dropdown. The same dropdown previews each workflow's Todo / In Progress / Done task counts inline before switching.
- Use **Workflows** in the desktop/tablet left sidebar, compact mobile actions, or mobile **More** navigation to browse definitions.
- From Settings moved-setting stubs, choose **Open workflow settings** to jump to the default workflow's settings values.

Behavior:
- Opens a workflow node editor with a workflow list/sidebar, canvas, inspector, and settings/authoring panels
- Built-in workflows are inspectable in the same canvas as custom workflows, including connected success, failure, and rework edges for their graph topology. Their graph structure stays read-only, but prompt/gate node Prompt fields can be edited per project and reset to the shipped default from the node inspector or expanded prompt editor.
- Custom workflows can be created from blank, duplicated from built-ins/custom definitions, imported/exported, AI-designed, validated, and saved from the editor. Custom workflows can carry an optional compact plain-text icon; built-in workflow rows use the Fusion mark instead of a textual built-in suffix.
- Optional-group node inspectors include controls for `defaultOn` and per-step **Max revisions** (`maxRevisions`), including an **Unbounded** toggle for Code Review, Browser Verification, or custom pre-merge gates that should keep cycling until they approve.
<!-- FNXC:WorkflowEditor 2026-06-29-20:09: Optional-group containers are visual boundaries in the workflow editor. Top-level workflow edges attach to the group boundary, while template-child edges remain inside the group so operators can distinguish optional-block connectivity from the inner step implementation.
FNXC:WorkflowEditor 2026-06-29-21:10: Optional-group template entry/exit ownership remains visual-only. Non-editable boundary connector lines must explain how template children attach to the container without persisting fake edges into workflow IR. -->
- Optional-group, foreach, and loop containers show their template nodes inside the block. Canvas connections between the surrounding workflow and the block attach to the container boundary; connections between template nodes stay inside the block. Optional groups also draw non-editable entry/exit connector lines between the boundary and the template entry/exit nodes so single-step blocks such as Plan Review and Code Review do not look disconnected; those visual connectors are not saved into workflow IR.
- The Settings panel is value-first for built-in workflows and groups workflow settings by Models, Review & Approval, Step Execution, and Advanced. Known workflow model values use the same model dropdown picker as **Settings → Project Models** so provider/model pairs and their inline Thinking Level companions are saved together; custom or non-model string values can still use typed inputs. Definitions remain available for custom workflow schema authoring.
- The main Settings modal also exposes the default workflow's Plan/Triage, Executor, Reviewer, and declared Planning/Reviewer fallback model lanes from **Project Models**; the modal's primary **Save** action writes those dropdown values as workflow setting values for the active default workflow. Project Models also includes project-scoped **Merger** and **Title Summarization** lanes (not workflow-moved). Settings fallback model pickers (Global Fallback Model, workflow fallbacks, and project Title Summarizer Fallback) include the same inline Thinking Level selector when their companion key exists.
- On desktop, the editor uses a multi-panel canvas layout for editing the graph and adjacent workflow metadata. The **Show simple editor** toggle switches that same workflow into the graph-outline editor with dedicated **Graph**, **Add**, **Settings**, **Fields**, **Columns**, and **Actions** tabs.
- On viewports `<=768px`, the editor switches to a full-screen mobile sheet. Global workflow entry points open to the workflow list with no workflow preselected and prompt users to select a workflow to edit; the Board/List workflow dropdown row edit action opens directly to the selected workflow editor when that selected workflow is available.
- Simple/mobile editing uses a graph outline instead of making the canvas the primary control. The outline shows nodes, branch/rework edges, column placement, and optional-group/foreach/loop template children as tappable rows and chips that open the same node and edge detail editors as desktop. The structural **start** node opens an inspector for the workflow entry column when the workflow defines columns; the **Name** field remains unavailable because the start label is structural. For custom workflows, editable outline rows also expose **Move up** and **Move down** controls that reorder steps within their current column or template parent; built-in workflows remain read-only and hide those controls.
- Simple/mobile authoring exposes dedicated destinations for **Graph**, **Add**, **Settings**, **Fields**, **Columns**, and **Actions**. Add includes the node palette plus fragments, built-in step templates, and plugin step templates; Actions includes save, AI edit, auto-layout, export, and delete for custom workflows, plus export and duplicate for built-ins. Settings keeps the Definitions/Values tab split.
- The create-workflow dialog and workflow AI authoring popover follow the same mobile full-screen/sheet pattern so they are not clipped by the editor canvas on narrow screens

## Custom Providers

Custom Providers live in **Settings → Authentication → Custom Providers**, inside the **Advanced: Custom Providers** disclosure. Use this section to add user-defined model providers that speak an OpenAI-compatible API, the OpenAI Responses API, an Anthropic-compatible API, or Google Generative AI. After a provider is saved with models, those models become selectable in model dropdowns, including **Settings → Project Models** lanes and workflow model lanes.

Settings → Global Models also includes **Model pricing overrides** for Command Center estimates. The section shows a compact pricing snapshot/override-count summary; use **View pricing table** to add or edit rows with lowercased `provider:model` keys (or bare `:model` fallback keys), USD-per-1M token prices for input/output/cache read/cache write, and optional source text. **Fetch LiteLLM pricing** remains available from the collapsed summary and performs an explicit one-click refresh from LiteLLM's published model pricing JSON, replaces the override table only after a successful parse, and records the fetched timestamp/source; failed fetches keep the existing overrides.

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
- **Enable Anthropic-style prompt caching** — shown only for **OpenAI-compatible** and **OpenAI Responses** provider entries. Turn this on when the provider gateway proxies an Anthropic-format backend (for example a self-hosted router fronting Claude models) to enable pi-ai's `cache_control` prompt caching, which stops re-billing the full context prefix every turn. Leave it off for gateways that do not support Anthropic-style caching (Together, Fireworks, etc.) to avoid provider errors. See [`anthropicPromptCaching` in the Settings Reference](./settings-reference.md#customproviders) for details.
- **Available models** — comma-separated model IDs, for example `gpt-4, gpt-3.5-turbo`.

Use **Detect Models** to auto-fill **Available models** while adding or editing a provider from the provider's `/models` endpoint. Detection requires a **Base URL** and may require an **API key**, depending on the provider. Saved providers also have a row-level **Refresh Models** action that uses the stored endpoint and credential to replace the persisted model list without exposing the raw key in the browser.

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
4. Select **Detect Models** again if you want to refresh or add model IDs from the provider's `/models` endpoint before saving.
5. Select **Save Changes**.

Expected outcome: the provider list refreshes, and model dropdowns use the updated model list. If you only need to refresh a saved provider's models after credentials, endpoints, or upstream availability changed, select the row-level **Refresh Models** action instead; failures keep the previous model list intact. If you rename the provider or change model IDs, update any **Project Models** or workflow model lane selections that should use the new `{provider}/{modelId}` value.

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

## Worktree copy files

Open **Settings → Worktrees** to maintain **Files to copy into new worktrees**. Add editable rows for repository-root-relative files such as `.env`, use **Browse** to select a project file, remove rows you no longer want, then Save. Fusion trims blank rows and de-duplicates paths before persisting. During task startup, configured regular files are copied into fresh or pooled task worktrees before the worktree init command and task execution begin; existing/resumed worktrees are not overwritten. Missing files, directories, absolute paths, traversal entries, and unreadable sources are skipped with non-fatal diagnostics and without logging file contents. See [`worktreeCopyFiles` in the Settings Reference](./settings-reference.md#project-settings) for the stored setting shape.

Use **Show worktree grouping on the board** in **Settings → Worktrees** when you want WIP/processing columns to always show worktree names and group cards by worktree. With the toggle off, Fusion preserves the legacy default: only the non-workflow `in-progress` column is grouped, and workflow-mode processing columns stay as plain cards.

## Planning Mode

Planning is a desktop/tablet left-sidebar main-content destination after **Command Center**. It opens the planning-session list and composer in the main content region; mobile continues to use the compact planning entry points. Planning Mode now includes branch controls on the summary screen before you create a task.

<!-- FNXC:SessionBanner 2026-07-15-00:00: FN-8001 requires every planning-session resume entry point to navigate to the embedded Planning view before reconnecting the session. The footer Background Tasks row and any needs-input Resume banner share this behavior on desktop and mobile. -->

When a Planning session is awaiting your input, use its **Background Tasks** footer row or **Resume** banner action to open the docked Planning view and reconnect to that session. The Planning navigation item also opens the docked Planning view; its yellow needs-input dot is visible on the desktop left sidebar and mobile More controls.

<!-- FNXC:PlanningRetry 2026-07-13-00:00: If Planning AI generation stalls and the server persists a terminal generation error, Planning Mode should auto-retry the same session up to three times before showing the permanent Retry/Dismiss error panel; any question or summary progress resets that budget. -->
When Planning AI generation appears stuck, Planning Mode automatically retries the same session up to three times and shows **Retrying… (attempt N of 3)** before falling back to the permanent **Retry**/**Dismiss** error panel. Any successful question or summary progress resets the automatic retry budget.

<!-- FNXC:Planning 2026-07-15-00:00: FN-8003 preserves the user’s original planning idea across error and mid-interview recovery surfaces. -->
Use **Copy prompt** in the error panel or an active interview question to copy the original “What do you want to build?” text, then paste it into **New session** to restart cleanly.

<!-- FNXC:PlanningModeDeepeningCheckpoint 2026-07-02-12:18: Planning Mode must pause before every final summary at a mandatory "Would you like to go deeper?" checkpoint so users can request inferred follow-up themes, enter a custom topic, or proceed without deepening. -->
<!-- FNXC:PlanningMode 2026-07-05-00:25: The planning AI now proposes plan-specific deepening themes (deepeningThemes on the completion payload) so this checkpoint surfaces topics tailored to the user's actual plan, including angles they had not anticipated, instead of a fixed generic set. The regex-derived generic themes remain the fallback whenever the AI supplies none (FN-7616 / issue #1912). -->
<!-- FNXC:PlanningMode 2026-07-16-00:00: FN-8065 / GitHub #2150 requires the deepening checkpoint to show the generated plan read-only above its refinement choices, so users can review the title, Markdown description, and deliverables before proceeding. -->

Before Planning Mode shows **Planning Complete!** or the final plan summary, it first asks **Would you like to go deeper?**. A read-only preview of the generated plan appears above the refinement options so you can review its title, formatted description, and key deliverables before deciding. The suggested themes are plan-specific: the planning AI proposes topics tailored to your plan's title, description, and deliverables as part of its completion response, surfacing angles you may not have anticipated. When the AI does not supply any themes, Planning Mode falls back to a generic, regex-derived set (scope, edge cases, UX, dependencies, testing, rollout) inferred from the interview text. Either way, select one or more suggested themes to continue the interview, use **Other** to add a custom topic, or choose **Proceed to final plan** to reveal the pending summary and task-creation actions.

- **Branch strategy** options mirror Subtask Breakdown semantics:
  - `Use project/default branch`
  - `Create auto-named branch per task`
  - `Use existing branch`
  - `Create custom new branch`
- **Branch name** is required when using `existing` or `custom new` strategies.
- **Merge target / base branch (optional)** uses a dropdown of existing local branches (with common names like `main`/`master`/`trunk`/`develop` listed first) plus a **Custom…** fallback when you need to type a branch that is not local yet.
- **Description** supports a `Markdown`/`Plain` toggle in the summary header row: `Plain` keeps the editable textarea, while `Markdown` renders formatted preview (`react-markdown` + GFM) in the same footprint for easier review before task creation.

These values are sent with the Planning Mode create-task request as `branchSelection`, so created tasks persist branch/base-branch settings consistently with other branch-aware task creation flows.

<!-- FNXC:WorkflowCreateForwarding 2026-06-30-09:12: Dashboard create flows must forward the active real workflow id so planning/quick-create tasks do not briefly land on the default workflow or persist the synthetic All workflows aggregate. -->

When quick-create task creation, Planning Mode, or Subtask Breakdown runs from a workflow-filtered board/list lane, the create request also carries that active workflow selection. Quick-created tasks appear on the selected workflow lane immediately while board-workflows metadata refreshes, and planning saves, planning breakdown saves, and subtask-breakdown saves create their tasks directly on the selected workflow lane instead of briefly landing on the default board. When Board is showing **All workflows**, quick-create uses the real workflow intake/default column that owns the affordance; it never submits the synthetic aggregate as a workflow id.

The **New Task** dialog's workflow selector also defaults to the current or last selected Board/List workflow lane for the current project. If no valid lane has been selected, or the remembered lane was deleted, the selector falls back to the project default workflow and task creation omits an explicit `workflowId`.

<!-- FNXC:CodingIdeasWorkflow 2026-07-05-00:00: Every dashboard create surface (inline quick-create, quick-add box, New Task dialog, insight → task, todo → task) must omit an explicit `column` from the create request so the store resolves the landing column from the (selected or project-default) workflow's intake column instead of always forcing legacy `triage`. -->

Create requests never send an explicit `column`. The task store resolves the landing column from the (selected or project-default) workflow's intake column, so most tasks still land in `triage` under the default Coding workflow, byte-identical to before. A workflow with a **manual intake column** parks new cards there instead: they wait for you to promote them into `todo` and are not auto-planned by the triage service until you do. The built-in **Coding (Ideas)** `ideas` composition (`autoTriage: false`) is deprecated and hidden from new selection; copy it into a custom workflow when that manual-intake behavior is needed. Existing Coding (Ideas) selections remain resolvable.

Optional workflow steps declared by the active workflow are available from the quick-add action row and the **New Task** dialog's inline quick buttons. For example, the coding workflow's browser verification option appears as a quick drop-down when that workflow is active; each option is seeded from the workflow step's `defaultOn` setting and is sent with the task's `enabledWorkflowSteps` payload at creation time.

<!-- FNXC:QuickAddAttachments 2026-07-16-00:00: Quick Add attachments use a compact icon-only paperclip while keeping the Attach action and pending image count in accessible labels. The same pending preview/upload path accepts image selection, paste, and direct drag/drop onto the Quick Add box. Compact pending-image thumbnails are accessible open controls that show the full image in a movable/resizable window, which becomes a full-screen sheet on mobile. -->
<!-- FNXC:QuickAddPriorityIndicator 2026-07-10-21:45: Quick Add keeps status controls in the bottom action cluster: GitHub tracking sits beside the paperclip attach button, Priority is icon-only with low/down, normal/flag, high/up, urgent/alert glyphs, and Fast is an icon-only lightning button.
FNXC:PriorityColorCoding 2026-07-11-00:00: Priority glyphs share urgency colors across Quick Add, the New Task inline row, and task-card badges: low=info/blue, normal=muted, high=warning/amber, urgent=error/red. -->
Quick Add image attachments use the paperclip icon button in the action row. Supported image files (`png`, `jpeg`, `gif`, `webp`) can be selected from that control, pasted into the Quick Add input, or dragged onto the Quick Add box; all three paths show compact pending previews before task creation and upload the images to the created task afterward. Select a pending preview to inspect the full image in a movable, resizable window (a full-screen sheet on mobile); close it with Escape or the close control to return to the preview. The same bottom action row places the GitHub tracking override beside the paperclip; Priority is an icon-only control whose glyph changes by selected level (down arrow for low, flag for normal, up arrow for high, alert for urgent) and is color-coded by urgency (low blue/info, normal muted, high amber/warning, urgent red/error), and Fast is an icon-only lightning control. These icon-only controls keep accessible labels and the same create-payload behavior as the previous text chips.

Quick entry, inline quick-create, and the full **New Task** dialog all check for similar active tasks before creating. When possible duplicates exist, the warning lists each match by task description (falling back to title, then “No description”) and lets you open an existing task, cancel, or create anyway with the duplicates acknowledged.

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
- In **More options → Model Configuration**, task and agent model pickers expose **Thinking Level** inside the same model dropdown panel instead of as a separate adjacent selector. Task pickers offer **Default (project setting)** plus **Off**, **Minimal**, **Low**, **Medium**, **High**, and **Very High**; agent creation, Agent Onboarding review, and Agent Detail built-in-model settings are concrete-only and start/fall back to **Off**.
- In **More options → Model Configuration**, **Planner oversight** is a per-task override of the workflow-native `plannerOversightLevel` setting (FN-7508): **Inherit from workflow** (default) plus **Off**, **Observe**, **Steer**, and **Autonomous recovery**. This selector appears in both the New Task dialog and the Task Detail edit form (same shared control). Selecting **Inherit from workflow** clears the per-task override (sent as `null` on edit, omitted on create) so the task falls back to the effective `plannerOversightLevel` configured on its workflow — set project/global defaults for this in the **Workflow Editor → Values** tab, not in Project Settings; it is workflow-native, not a project setting.

The dialog also exposes AI handoffs that quick-add no longer shows: **Plan** opens Planning Mode with the current description, and **Subtask** opens Subtask Breakdown with the current description when **Settings → Experimental Features → Subtask Breakdown** is enabled. The Subtask handoff is hidden by default; visible handoff buttons remain disabled until the description has content, matching the quick-add row behavior for Subtask. **Execution mode** and optional workflow-step selection are available in the New Task dialog as well as quick entry, so users can choose Fast or standard execution and opt into workflow-specific creation-time steps before creating a task from either surface.

The full **New Task** dialog includes a compact **GitHub issue or PR** picker near the description. It detects GitHub remotes for the current project, auto-selects a single remote or `origin`, and asks you to choose a remote when multiple non-`origin` remotes are available. Selecting an issue replaces the description with a prompt that tells the executor to fetch/read the issue and includes `Source: <issue-url>`; selecting a pull request creates a PR-focused prompt with `PR: <pr-url>` and explicit instructions to inspect the PR conversation, review comments, checks, and changed files, then resolve or address actionable review comments. If you already typed a description, Fusion asks before replacing it. This picker only seeds the prompt; it does not import, close, or comment on GitHub items. On mobile, the full-screen New Task sheet keeps the GitHub picker, dependency picker, agent picker, quick handoff buttons, and action row tappable and scrollable even when the keyboard reduces the visual viewport.

## Chat View

Chat view provides project-scoped conversations with agents.

- Entering `/new` or `/clear` (exact match after trimming) in the composer starts a fresh thread for the current chat target instead of sending the literal command to the model
- On mobile, the New Chat and Delete Conversation dialogs use a compact inset treatment (centered, viewport-bounded, internally scrollable) instead of the app's default full-height mobile modal chrome.
- **Settings → Project Models → Chat** controls New Chat defaults per project. Choose a default target kind (**Model** with provider/model and optional Thinking Level, or **Agent** with a durable agent id) and a mode: **Prompt for model each time** opens the New Chat dialog with that default preselected, while **Always use configured default** creates the session immediately from the resolved default. If the configured target is incomplete or missing, New Chat falls back to the dialog instead of creating an unroutable session.
- In the New Chat dialog's **Model** mode, the model picker includes a **Thinking Level** selector. Choosing **Default** leaves the session unset so Fusion uses the project/global reasoning-effort default; choosing a concrete level stores it on that chat session and applies to model-loop replies. The Default label shows the current resolved default (for example **Default (medium)**) and falls back to **Default (off)** when no default is configured.
<!-- FNXC:Chat-ThinkingLevel 2026-07-12-19:30: FN-7898 closes the gap left by the create-time-only picker above: an existing session's reasoning-effort level can now be changed mid-conversation from the composer itself. -->
<!-- FNXC:Chat-ThinkingLevel 2026-07-12-20:13: FN-7905: chat thinking-level Default entries display the resolved project/global default in both the New Chat picker and in-chat Brain popup; choosing Default still clears the per-session override. -->
<!-- FNXC:Chat-ModelSwitch 2026-07-12-00:00: FN-7908 extends that same Brain popup rather than adding another composer button, so active non-CLI Direct chats can retarget to a model pair or real agent mid-conversation and the next send resolves the updated session target. -->
<!-- FNXC:Chat-ModelSwitch 2026-07-12-22:44: FN-7916 keeps the Brain popup usable on mobile/tablet touch devices: the portaled shared model picker is treated as part of the popup for selection, and the popup is viewport-fitted instead of anchored off-screen. -->
<!-- FNXC:Chat-ModelSwitch 2026-07-13-00:00: FN-7934 applies that fitted Brain-popup layout to narrow chat surfaces, including floating Chat windows and compact docks on wide desktop viewports, because the browser viewport alone does not describe the popover's clipping container. -->
- A small **Brain**-icon button next to the composer's attach button lets you change an already-created direct chat session's target and thinking level mid-conversation, without starting a new chat. Its **Model / Agent** section can switch the session to another model via the shared model picker or to a real agent from the agent list; its **Thinking level** section still lists the six thinking levels plus **Default** (clear/inherit, labeled with the current resolved default such as **Default (medium)**). Each selection persists immediately and applies starting with the session's next send, including on mobile/tablet touch viewports and narrow floating Chat windows or compact docks where the popup stays fitted to the chat surface. This control appears only for non-CLI Direct sessions — it is not shown for CLI-agent-backed sessions or in Chat Rooms, neither of which support this per-session retargeting control.
- Full Chat and Quick Chat both consume the same streamed `/api/chat/sessions/:id/messages` response contract, and both now prefer the authoritative assistant `message` snapshot on `done` while still accumulating `text` chunks when present (so providers without incremental text streaming still render output immediately)
<!-- FNXC:ChatEmptyMessage 2026-07-10-00:00: Empty final assistant responses can be legitimate provider output (for example a Grok CLI run ending without text). Document the shared Chat/Planner Chat behavior so operators see "No message" instead of interpreting a blank bubble as a rendering failure. -->
- Final assistant messages with no text, tool calls, thinking output, attachments, or failure details render a muted **No message** placeholder instead of a blank bubble. In-progress responses still use the existing **Working…** / **Thinking…** streaming state until the run finishes.
- In-progress assistant responses now survive refresh/navigation while generation is still active: Chat restores the last durable in-flight text/thinking/tool state immediately, keeps the prior persisted conversation visible, then resumes streaming from the stored replay point; any new text, thinking, or tool-call updates append to that restored bubble instead of replacing it or starting from an empty "Working…" placeholder.
- While a Chat response is actively streaming, prior user and assistant messages stay visible across session-update snapshots, tool-call churn, and stale message reloads; the thread does not flicker to an empty history mid-turn.
- If a regular Chat stream drops with a hidden-tab/browser-suspension error (for example `Load failed`) while the server is still generating, Chat suppresses the false error banner, re-attaches to the in-progress stream using the durable replay state, and reconciles the final assistant reply when generation completes.
- If you queue follow-up user messages while the assistant is still streaming, Chat persists them per session, stacks each queued preview above the input box with one shared divider, and restores/sends them one at a time in FIFO order once each active response finishes if you leave and return.
- Chat message lists now track near-bottom scroll state: while you are reading older messages, live streaming/new replies do not force-scroll; a **Latest** jump control appears until you return to the tail.
- On mobile direct-chat threads, entering a thread and restoring Chat after tab/page visibility returns re-anchors to the newest message (`scrollTop = scrollHeight`) so the view always opens at the live tail.
- On mobile direct-chat threads, the top Chat header collapses into one compact row: the back button is the far-left visible control and the active conversation dropdown stays beside it, while the visible Chat icon/title shell is hidden to preserve transcript space. The dropdown trigger shows the conversation title with the provider/model logo only (no model-name text), and tapping it opens a lightweight dropdown so you can switch to another direct session or start a New Chat without backing out to the sidebar list first; long conversation titles stay readable in the dropdown via wrapped option text and taller touch-friendly rows.
- On mobile direct-chat threads, the single thread-wide Markdown/plain eye toggle floats above the transcript/composer area instead of occupying a second header row; desktop/tablet keeps the toggle in the thread header.
- Direct chat sessions can be renamed from the sidebar row edit button, the desktop conversation context menu, and the mobile session switcher; blank rename submissions clear the custom title so the default session label is shown again.
<!-- FNXC:ChatPinned 2026-07-16-12:00: Document the Direct-only pin contract across desktop and mobile surfaces, including the durable server-side scope limit. -->
- You can pin up to **3** active Direct conversations per project scope from a sidebar row, desktop right-click menu, or the mobile session switcher. Pinned conversations show an indicator, sort above recent unpinned conversations, and appear under **Pinned** on both desktop and mobile. The server serializes each scope's pin changes (including null-project/default sessions) so concurrent requests cannot exceed the limit. Archiving always removes a pin, whether archived through either archive path; archived conversations cannot be pinned.
<!-- FNXC:ChatViewDocs 2026-07-01-00:00: Task-detail planner chats are intentionally hidden from the common Direct feed by default after issue #1850; Settings keeps an opt-in for operators who want populated task-planner sessions restored without adding a mandatory Tasks tab. -->
<!-- FNXC:TaskDetailPlannerChat 2026-07-01-22:02: Done-task planner Chat remains available for retrospective Q&A and can create a task-scoped refinement through the planner tool, while common Chat feed visibility remains opt-in. -->
- Task-detail planner Chat conversations stay available from each task's **Chat** tab, including after the task is `done`. They are hidden from the common Direct/common Chat feed by default; enable **Settings → Project General → Show task chats in common Chat feed** to include populated task chats again. Empty task chat sessions stay hidden either way. Planner Chat can answer token-count, estimated-cost, runtime, timing-event, workflow-step duration, and per-model usage questions for the current task through a read-only task-scoped metrics tool; unknown/stale pricing is reported as uncertain instead of `$0`. On completed tasks, clear follow-up implementation or improvement requests can create a normal refinement task from the completed source task.
<!-- FNXC:ChatContextWindow 2026-06-27-00:00: Direct-chat docs must describe the desktop/tablet-only estimated token budget indicator and its intentional absence from mobile, narrow floating chat, and room headers. -->
- On desktop/tablet Direct chat, the thread header shows an estimated token count against the active model's known context window (for example `~12.3k / 200k`). It is hidden on mobile, narrow floating chat, rooms, and unknown-context-window models.
<!-- FNXC:ChatViewDocs 2026-06-28-14:52: Chat responsive docs must reflect that narrow chat hosts now key bubble width off the ChatView container, not just viewport media, so Quick Chat popups and the right dock on desktop viewports get the same full-width bubbles as phone Chat. -->
- In narrow Chat containers (including phone-width full Chat, narrow Quick Chat popups, and right-dock Chat), message bubbles use the full content width for improved readability. On tablet-width main Chat containers, assistant/agent, streaming, and failure bubbles keep the wider 92% reading measure, while wide desktop Chat keeps the standard 75% bubble cap.
- Full Chat tool-call summaries now use a denser mobile layout: grouped and single-call collapsed rows keep icon + label + status on one line (Quick Chat-style scanability) while expanded details remain unchanged.
<!-- FNXC:ChatAskQuestion 2026-06-17-16:35: Dashboard chat agents have a Fusion-native `fn_ask_question` tool, so the documented question-card behavior must cover both provider-native question tools and Fusion's first-party tool. -->
- Assistant question tool calls now render as a shared in-chat response card instead of a generic tool-call disclosure. The card recognizes provider-native question tools and Fusion's `fn_ask_question`, supports select, multi-select, text, and yes/no prompts, sends the formatted answer back into the same direct or room thread, and renders historical answered questions read-only.
- The desktop Chat view toggle and mobile Chat tab now show an unread-response indicator when a live assistant reply arrives for a visible direct or room chat after you leave Chat; opening Chat clears it immediately. Task-detail planner Chat replies stay task-local and do not light up the global Chat unread indicator while those sessions are hidden from the common Chat feed.
- Agent-backed chat sessions now expose the same mailbox messaging tools (`fn_send_message`, `fn_read_messages`) used by runtime execution/heartbeat flows whenever the engine `MessageStore` is available; model-only chats continue to run without mailbox tools.
- Chat attachments are included in agent-visible prompts for both direct sessions and rooms: supported text attachments are appended under an `Attachments` prompt section, and supported images (`png`, `jpeg`, `gif`, `webp`) are passed as image inputs to the model.
- Chat attachments can be sent without accompanying text in both Quick Chat and Main Chat; fully empty sends with no text and no attachments are still blocked.
<!-- FNXC:ChatMessageEdit 2026-07-12-23:20: Document the message-edit affordance and its resume-from-edit ("forget everything after") semantics, including the model-loop-only scope and inline timestamp placement. -->
- Your own messages in a **direct (model-loop) chat** can be edited: hover/tap the compact **Edit message** (pencil) action inline with the message timestamp to swap it for an inline textarea, then **Save** (or Cmd/Ctrl+Enter) or **Cancel** (or Escape). Saving an edit **resumes the conversation from that point** — the edited turn and every turn after it are discarded from both the visible transcript and the model's memory, so the agent responds fresh from the edited content with no bias from what was removed. This is the only way to correct or steer an earlier turn without leaving a stale, misleading message in the thread.
<!-- FNXC:ChatMessageScrollToTop 2026-07-12-23:20: Chat message go-to-top is contextual; document that it appears only after a message top has scrolled above the chat viewport and sits inline with Thinking/copy actions. -->
- Assistant messages expose a **Scroll message to top** up-arrow only after that message's top has moved above the visible chat viewport. When visible, the control sits inline with the message's **Thinking** row (or the same footer action row when no thinking details are present) instead of adding a separate action line.
- Message editing applies to direct/model-loop chat sessions, **including task-detail Planner Chat** (the synthetic `task-planner:<id>` session, a model-loop session under the hood). It is **not** available in **Chat Rooms** (multi-agent, different persistence) or in **CLI-agent-backed sessions** (the transcript is owned by a live terminal, not a rewindable model session). The edit action is also disabled while a response is actively streaming, to avoid racing a live generation, and never renders on optimistic/in-flight rows that have no persisted message id yet.
- Editing is truncate-and-resend, not append: the edited message and everything after it are removed first, then the edited text is sent as a new turn through the normal streaming path — so the resulting transcript looks the same as if you had deleted the old messages and typed the correction from scratch, but in one action.
<!-- FNXC:TaskDetailPlannerChat 2026-07-07-10:15: Document Planner Chat edit-and-resend and the steering/refinement side-effect decision on discard. -->
- In task-detail **Planner Chat**, editing an earlier message resumes the conversation from that point exactly as in direct chat. If the discarded turns already triggered task-scoped side effects — a steering comment added via the planner steering tool, or a refinement task created via the planner refinement tool — those **are not reverted**: the steering comment stays on the task and the refinement task stays open, because undoing either is destructive and out of scope for a chat edit. After a successful edit-and-resend, task detail refreshes automatically (so Activity/steering reflects reality), and if the discarded range held one of those confirmations you get an informational toast noting that the earlier change was not undone.
<!-- FNXC:ChatSearch 2026-07-07-12:00: Content search is always on (FN-7651 removed the "Search in title only" toggle per user request); document the always-on behavior instead of a switchable toggle. -->
- The Chat sidebar search box always matches message **content** in addition to conversation title/agent — so you can find a past conversation by remembering something that was said in it, even if the title doesn't contain the query. Content matches run as a debounced server-side lookup and are merged with local title/agent matches into the same results list; there is no toggle to restrict search back to title-only. This applies on both desktop and mobile Chat sidebars and does not appear in the Rooms scope (Rooms already hides search/list). When a session is shown because of a content match, its row shows a subtle "Matched: ..." preview of the matching message so it's clear why the conversation appeared. Task-planner sessions stay excluded from content matches by the same common-feed guard used for the normal session list (see **Settings → Project General → Show task chats in common Chat feed**).

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
- The room composer includes a compact **Brain** thinking popover next to the attach button, mirroring direct chat, with **Default**, **off**, **minimal**, **low**, **medium**, **high**, and **Very High**. It stores one room-level default for every responder in that room; **Default** clears the room override so responders inherit the resolved project/global reasoning-effort default. Per-member thinking overrides are not supported.
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

Quick Chat is an optional fast, project-scoped assistant surface for conversations without leaving your current view. Depending on the project launcher setting, desktop and tablet can open it from the footer status bar beside Terminal, while mobile continues to use the compact Quick Chat panel behavior.

- Controlled by the project setting `showQuickChatFAB`
- Supports agent mentions (`@agent`) and shared `#` task/file mentions
- Supports `/skill:{name}` in model-loop chat to request a specific enabled skill for that session; slash/catalog forms such as `/skill:review/pr`, `/skill:review/pr/SKILL.md`, and `source::skills/review/pr/SKILL.md` resolve to the matching discovered bare skill token, and the slash token is removed from the model prompt while the original user message remains in chat history
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
- Clicking outside the desktop Quick Chat floating window closes it by default; disable **Settings → General → Close Quick Chat on outside click** to keep it open until you explicitly close/minimize/maximize it. Model, thinking-level, agent, dependency, node, and priority dropdowns that open from Quick Chat are treated as part of the panel even when they render in a page-level portal, so selecting from them does not close Quick Chat. Task pop-out floating windows remain persistent on page clicks.
- Queued follow-up messages entered while a Quick Chat response is still streaming now persist per session, so closing/reopening the panel restores the queued stack and flushes the messages one at a time in FIFO order as active responses complete.
- Resume lookups still use targeted session queries instead of loading the full active-session list first
- Tool-call summaries in the floating quick-chat panel are intentionally condensed into a single-line header row (especially on small screens) so tool name + status stay scannable without multi-line wrapping
- Question tool calls use the same shared response card as full Chat, with compact spacing in the floating panel and read-only answered history so Quick Chat can continue agent clarification loops without exposing raw tool JSON.
- Opening Quick Chat auto-focuses the composer as soon as it is ready on desktop and mobile viewports; mobile additionally uses the stealth-input handoff so the soft keyboard opens immediately
- FAB dragging uses pointer events with document-level move/up tracking and a 5px drag threshold so Android touch drags reposition reliably while short taps still open Quick Chat
- Quick Chat now mirrors full Chat tail behavior: if you scroll up, live updates stop auto-following and a **Latest** jump control appears until you jump back down.
- On mobile, Quick Chat re-anchors to the newest message whenever the panel is opened/reopened and when page visibility is restored, while still preserving the near-bottom gate so intentional scroll-away keeps **Latest** jump behavior.
- On mobile and other narrow Quick Chat container widths, Quick Chat bubbles use the full content width while keeping compact tool-call summary layout and full-screen/safe-area behavior intact.
- On mobile, the fullscreen Quick Chat sheet follows soft-keyboard `visualViewport` height/offset samples directly, dedupes repeated identical samples, and smooths Android resize-content height-only changes so the sheet does not visibly step while the keyboard animates. iOS-style non-zero `offsetTop` samples still apply synchronously so transform alignment stays exact.
- On mobile, Quick Chat send reliability includes a delivery watchdog: if a queued message would otherwise stay stranded in the composer after a dropped or suspended stream, it is re-confirmed and delivered once no generation is in flight and no live stream is connected, so sends are not silently dropped.
- On mobile, Quick Chat sends exactly once per tap even when the browser emits paired pointer and touch events; a stop tap immediately after send is still honored.
- While a response is streaming, the Quick Chat stop control matches the send button's square dimensions (including on mobile) instead of collapsing toward its icon, so it stays an easy touch target.

## Mailbox View

Mailbox view shows inbox/outbox communication threads and unread state.

- Inbox renders one row per message (no sender-based collapsing)
- clicking a message in the Mail tab opens the task detail pane with full message content and conversation context
- reply rows in the mailbox modal can expand inline to show the replied-to message context for easier thread reading
- when an agent or dashboard chat session registers an artifact with `fn_artifact_register`, Fusion sends a best-effort `system` → user inbox message announcing the new artifact (for example, `New image artifact registered: <title>`) with metadata for `artifactId`, `artifactType`, `title`, optional `mimeType`, `authorId`, and optional `taskId`; notification delivery is informational and never blocks or rolls back the artifact registration. Artifact notifications are actionable in message detail views: image artifacts show an inline preview plus **Open artifact**, while video/audio/document/other artifacts show an **Open artifact** link to the managed media URL. When `taskId` metadata is present, the same artifact block also shows **View task** so users can open the producing task detail directly from the mailbox in the shared movable/resizable task-detail window.
- on first engine startup under Fusion `0.59.x`, each project receives one best-effort `system` inbox notice about the upcoming embedded-Postgres storage migration with the Discord help link; `metadata.kind = "postgres-migration-notice"` prevents duplicates across restarts.
- mailbox now includes an **Approvals** tab with pending and history filters (`approved` / `denied` / `completed`), approval detail context, and inline approve/deny actions for pending requests
- for approvals gated by an agent's permission policy (permanent agents and task-worker heartbeats), the Approvals detail pane renders the gated action's real payload — tool name, shell command line or structured arguments, and working directory when present — instead of only a generic "Agent gated action for `<tool>`" summary; a stateless heartbeat retrying the same gated command reuses the existing pending approval instead of creating a duplicate (FN-7609)
- in the **Agents** tab, the agent selector now includes **All agents**, which shows one combined agent-to-agent stream (with sender + recipient labels); selecting a specific agent still shows Inbox/Outbox subtabs
- mailbox entry points now show unread/pending indicators: the desktop/tablet Header mailbox toggle shows a pending-approval dot first or an unread dot when unread mail exists without pending approvals, the mobile bottom-nav Mailbox tab carries the mobile badges/dots, and the compact Header actions overflow keeps a Mailbox entry only when the mobile bottom nav is disabled
- approval lifecycle SSE events (`approval:requested`, `approval:updated`, `approval:decided`) trigger mailbox approvals refresh without manual reload
- when a real pending mailbox approval request is created, the app shows a persistent approval banner above project content with an **Open Mailbox** CTA; task plan-approval states (`awaiting-approval`) remain visible on the triage board and do not create a mailbox banner
- when a task first transitions into `done`, the dashboard shows a one-time **Enjoying Fusion?** GitHub star prompt in the project view after first-run setup is closed; clicking **Star on GitHub** or dismissing the card marks it shown in browser `localStorage`, so it does not reappear on reload or later task completions. The setup wizard does not add a second star prompt.
- Visible message history/threading is driven by explicit `message.metadata.replyTo.messageId` links
- Separate top-level messages from the same sender remain independent in the inbox and detail pane

![Mailbox view](./screenshots/mailbox-view.png)

## Interactive Terminal

Fusion embeds a terminal using xterm.js. Desktop and tablet use the footer status bar as the terminal launcher; mobile keeps the full-screen terminal path.

<!-- FNXC:Terminal 2026-07-11-18:20: FN-7824 first-launch terminal sockets auto-retry with capped backoff until the first successful open, so the manual Reconnect affordance is reserved for terminal sessions that already connected and then exhaust their mid-session reconnect budget. -->
On first launch or first open, the terminal keeps reconnecting automatically until its initial WebSocket opens; it should show **Reconnecting...** during that cold-start recovery rather than requiring a manual **Reconnect** click. If an already-connected terminal drops and exhausts its bounded reconnect budget, Fusion then parks it as **Disconnected** and surfaces the manual **Reconnect** control.

<!-- FNXC:TaskDetailTerminal 2026-07-11-13:20: FN-7826 makes the Task Detail interactive Terminal tab always available while preserving the existing CLI-agent Session tab label. The first shell uses task.worktree when present and otherwise falls back to the project base directory, including for multi-repo workspace tasks with no single worktree, while task-scoped terminal tabs remain separate from the footer/global project terminal.
FNXC:TaskDetailTerminal 2026-07-11-00:00: Task Detail's collaboration strip groups Comments → Terminal → Cost, and the embedded terminal picker mirrors the task worktree when that worktree is registered so operators can see the cwd context; the global footer terminal still defaults to Project Root. -->
Task Detail has two terminal-adjacent tabs when both are applicable: **Session** shows the pre-existing CLI agent session transcript/control surface, while **Terminal** embeds the interactive multi-tab terminal inside the task detail body. The interactive **Terminal** tab is always available in Task Detail and sits immediately after **Comments**, with **Cost** immediately after **Terminal**. Its first shell starts in the task worktree when one is recorded, otherwise it starts in the project base directory (project root), including for multi-repo workspace tasks that have no single task worktree. When that task worktree is registered in the workspace picker, the picker shows the task worktree instead of **Project Root**; the footer/global project terminal keeps its separate Project Root default. Task-detail terminal tabs are stored separately from the footer/global project terminal tabs.

On Windows, the embedded terminal starts a supported shell inside Fusion, such as Command Prompt (`cmd.exe`) or Windows PowerShell. Windows Terminal (`wt.exe`) is an external terminal host and is not required or launched for the embedded panel, so Fusion should not show native Windows Terminal help/version popups while starting a terminal. If embedded terminal startup fails, Fusion shows an inline error with **Retry** instead of a blocking native dialog; install or repair Windows Terminal separately with `winget install Microsoft.WindowsTerminal` only if you want to use Windows Terminal outside Fusion.

<!-- FNXC:TerminalFooter 2026-07-11-20:45: FN-7829 moved all terminal action controls (font size, Clear, Shortcuts, Preferences, status, pin, and pop-out) into the bottom terminal footer at every width, and desktop/tablet tabs now fall back to the mobile-style selector when the tab strip cannot fit its container. -->
Use the terminal on desktop/tablet:

1. Select the **Terminal** button in the footer executor status bar.
   Expected outcome: the terminal opens as a bottom-docked overlay panel with the active shell session and a draggable top resize handle. The font size / clear / shortcuts / preferences controls, connection status, pin, and pop-out controls render in the terminal's bottom action-control footer at every desktop/tablet width, so the header only has to carry the tab affordance, title/status, workspace picker, and close button.
2. Select **Pin terminal (push content)** from the bottom action-control footer.
   Expected outcome: the terminal moves into a persisted below-application panel that reserves space instead of covering the board, chat, or right sidebar. The pinned panel also reserves space above the fixed status footer (the executor status bar), so the terminal's own bottom action-control footer (font size, Clear, Shortcuts, Preferences, connection status, pin/pop-out) stays fully visible instead of being covered by it. Select **Unpin terminal (overlay content)** to return to the overlay docked panel.
3. Drag the top edge of the docked or pinned panel.
   Expected outcome: the panel height changes within its viewport-safe bounds and persists per project, with pinned mode clamped shorter so the application remains usable.
4. Select **Pop out** from the bottom action-control footer.
   Expected outcome: the terminal switches to a floating window that can be dragged and freely resized; size, position, and display mode are saved per project.
5. Select **Dock** in the floating terminal.
   Expected outcome: the terminal returns to the bottom docked overlay panel using the saved docked height.
6. Select the scripts chevron beside the footer **Terminal** button.
   Expected outcome: the quick scripts menu opens without toggling the terminal; choosing a script runs it in the terminal, and the menu footer opens script management.

Use the terminal on mobile:

1. Open the bottom navigation **More** sheet and select **Terminal**.
   Expected outcome: the terminal opens as a full-screen, keyboard-aware modal rather than the desktop/tablet docked or floating surface.
2. Use the **Terminal tab** selector to switch between terminal tabs, or use the adjacent **+** action to open another Project Root terminal.
   Expected outcome: every terminal tab appears in the dropdown, switching preserves the active session, and the desktop horizontal tab strip is not shown on mobile. The same selector also appears on desktop/tablet when a narrow docked or floating terminal does not have enough room to show the whole tab strip.
3. When multiple tabs are open, use **Close current tab** beside the selector, then close the modal when finished.
   Expected outcome: mobile can close the active terminal tab without exposing a cramped horizontal tab strip, and terminal sessions reconnect/recover normally without desktop dock state affecting the mobile layout.

Open a terminal in a specific workspace:

1. Open the terminal and use the workspace picker in the terminal header.
   Expected outcome: **Project Root** is always available and opens a new tab in the repository root. On narrow mobile screens, the picker menu remains visible, viewport-safe, and scrollable instead of being clipped by the terminal header.
2. Select a task worktree from the **Task Worktrees** list, then choose **Open terminal in selected workspace**.
   Expected outcome: Fusion opens a new terminal tab with the selected task label and starts the shell in that task worktree.
3. If a task is listed without a live worktree, the task remains visible but disabled and marked **No worktree**.
   Expected outcome: no empty action button or arbitrary path field is shown; create or restore the task worktree first, then refresh/open the terminal again.

The picker follows the same workspace metadata as the Files modal. The server accepts terminal working directories only for the project root or registered project worktrees; rejected, missing, or unsafe explicit worktree paths fail the new-tab request rather than opening a mislabeled Project Root shell or an arbitrary location. The existing **+** new-tab action remains a fast Project Root terminal on both desktop and mobile, and reconnect, restart, resize, scrollback, initial-command, and tab-persistence flows continue to use server-confirmed session metadata.

Features:

- Multiple terminal tabs, including Project Root tabs and task-worktree tabs
- PTY-backed shell sessions
- Ctrl/Cmd+C copies the current terminal selection, while plain Ctrl+C with no selection still sends SIGINT
- Ctrl/Cmd+V pastes clipboard text exactly once into the active integrated terminal or live embedded CLI session
- The Shortcuts panel includes Ctrl/Alt helpers, ESC/Tab, common shell shortcuts, Up/Down/Left/Right arrow buttons, and any custom shortcut buttons you define for keyboard-less shell history, line editing, or frequent snippets
- Shortcuts panel buttons preserve terminal focus on the active terminal session during pointer, mouse, and touch activation, so Ctrl combinations and custom snippets reliably emit bytes to the shell
- The Preferences panel customizes font family, font size, cursor style, cursor blink, renderer, and custom shortcut buttons; changes persist in browser `localStorage` under `kb-terminal-preferences`, with the legacy `kb-terminal-font-size` value migrated automatically
- Custom shortcuts have a short label and injected value. Use `\n` for Enter, `\t` for Tab, `\r` for Return, `\e` or `\x1b` for Esc, and `\\` for a literal backslash; unknown escapes are sent literally. Add, edit, or remove them from the terminal Preferences panel, and reset terminal preferences to clear them.
- Font and cursor preferences apply live to the active xterm instance; renderer changes apply the next time the terminal opens, and mobile devices keep the WebGL renderer disabled to avoid glyph artifacts
- Embedded CLI session terminals honor the same saved preferences and physical copy/paste semantics for live interactive session views: selected text copies with the platform copy modifier, no-selection Ctrl+C stays available to the shell, and Ctrl/Cmd+V sends clipboard text exactly once to the attach channel. On mobile, the embedded terminal's accessory key bar also shows the same custom shortcuts defined in the terminal Preferences panel as tappable buttons that inject the decoded value; desktop embedded terminals have no key bar. Idle, ended, and read-only replay views suppress input handlers and mobile accessory controls. Cursor blink still stays disabled for read-only/replay sessions, renderer changes apply on the next session mount, and WebGL never loads on mobile viewports.
- Mobile-aware virtual keyboard handling and auto-refit behavior
- Reopen/reconnect/session-recovery flows preserve single-keystroke input forwarding (no duplicate characters, no page refresh required)

![Interactive terminal](./screenshots/terminal.png)

### Slow first prompt / shell profile hygiene

Fusion's embedded terminal spawns your shell as a **login shell** (`bash --login` / `zsh --login`) so `.bash_profile`/`.zprofile` (and, for interactive zsh, `.zlogin`) are sourced exactly as they would be in a real terminal. This is deliberate: dropping the login flag would silently break PATH entries, secrets, and tool init that many profiles rely on, so Fusion always tries `--login` first (falling back only if that specific spawn attempt fails, never as a latency optimization).

If the terminal view appears almost instantly but stays blank for several seconds before the first prompt/output shows up, this is very rarely `--login` itself — measurements show the flag typically costs only single-digit milliseconds on a lean profile. The far more common cause is your own `.zprofile`/`.bash_profile` (or `.zshrc`/`.bashrc`, which a login shell also sources) eagerly running something slow, most often a version manager init script (`nvm.sh`, `rbenv init`, `pyenv init`, `direnv hook`, etc.). Because a **login** shell sources `.zprofile`/`.zlogin` in addition to `.zshrc` (a non-login shell skips them), anything slow specifically in `.zprofile`/`.bash_profile`/`.zlogin` is fully additive latency that only a login shell pays.

To trim a slow first prompt:

1. Move slow, one-time setup (build tool version managers, background daemons, etc.) out of `.zprofile`/`.bash_profile` and into `.zshrc`/`.bashrc`, or gate it behind an interactive-only check if it should not run for every login shell.
2. Prefer lazy-loading over eager-sourcing for version managers — most (nvm, pyenv, rbenv) document a lazy-init pattern that defers the expensive part until the tool is first invoked.
3. Time your own profile to confirm the source of the delay: `time zsh -i -c exit` (interactive, non-login) vs. `time zsh -li -c exit` (interactive, login) isolates whether `.zprofile`/`.zlogin` specifically is the slow part.
4. If Fusion's server log shows a one-time `login shell took <N>ms to produce first output` hint for a session, it is pointing at this same profile-hygiene question — it is informational only and never blocks or retries the session.

See `docs/solutions/developer-experience/login-shell-profile-latency.md` for the underlying measurement and the decision to keep `--login` unconditionally.

## Git Manager

## Git Manager

Git Manager centralizes repo operations in the dashboard. On desktop/tablet it is available as an embedded right-dock panel and can expand into a resizable modal; on mobile it opens from the compact More surfaces.

Use Git Manager:

1. On desktop/tablet, open the right dock and select **Git Manager**.
   Expected outcome: Git Manager renders inline in the right dock with its section tabs and repository status.
2. Select the dock expand action if you need more room.
   Expected outcome: the same Git Manager surface opens in a resizable modal without changing the selected dock tool.
3. On mobile, open the compact Header overflow or bottom **More** sheet and select **Git Manager**.
   Expected outcome: Git Manager opens in the mobile modal layout with the section tabs restored as a horizontal scrolling strip.
4. Select **Status**, **Changes**, **Commits**, **Branches**, **Worktrees**, **Stashes**, **Recovery**, or **Remotes**.
   Expected outcome: the corresponding section panel replaces the previous section while preserving the same Git Manager session.

<!-- FNXC:GitManagerDocs 2026-06-29-00:00: The Commits panel may read history from Git-listed worktrees, but mutating Git actions must remain scoped to the current repository/section target so history inspection does not imply cross-worktree writes.
FNXC:GitManagerDocs 2026-06-30-03:15: The worktree history target is a security-bounded read surface: only Git-reported worktrees from the current repository target are valid, and arbitrary absolute filesystem paths must stay rejected by the API. -->
Features:

- Branch/worktree visibility
- Commit and diff browsing, including a read-only **History target** selector for Git-reported worktrees in the Commits panel and **View commits** shortcuts from populated Worktrees rows. Changing this target affects only the Commits list and diff viewer, and the API accepts only worktrees already reported by `git worktree list` for the current repository target.
- Push/pull/fetch actions
- Pull with rebase option (split-button chooses between `git pull` and `git pull --rebase`)
- One-click **Sync** action in Remotes (`git pull --rebase` followed by push; it stops and surfaces an error instead of pushing when the pull conflicts or fails)
- Remote editing controls
- Stash inspection (view stat + patch) before apply/pop/drop actions
- **Recovery** tab for orphaned merger-autostashes; orphan counts appear on Git Manager entry points
- Remotes tab keeps "Recent commits on {remote}" in sync immediately after successful push/pull actions

Mutating actions such as staging, committing, checkout, stash, pull, push, fetch, sync, and remote edits still operate on the current repository or the active section's existing target. Use the Commits **History target** selector only for read-only history/diff inspection of another known worktree.

![Git Manager](./screenshots/git-manager.png)

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

For OAuth credentials, the same `/auth/status` poll also attempts an automatic refresh when the stored credential has a refresh token and the access token is expired or within the refresh buffer. Anthropic banner state is keyed to `anthropic-subscription` (including legacy Anthropic OAuth rows), not Claude CLI state. When that refresh succeeds, the banner clears for the provider without manual re-login and without waiting for a separate model request.

If the OAuth credential has no refresh token or the refresh request fails/leaves the credential expired, the provider stays expired and the banner remains visible. Re-authenticate with manual re-login from **Settings → Authentication** or Model Onboarding. On Fusion desktop, OAuth login URLs open in the operating system browser rather than an in-app Electron child window; the Settings/Onboarding UI keeps polling until the provider authenticates or the login truly stops.

<!-- FNXC:ProviderAuth 2026-07-05-00:00: FN-7574 — the status route and the engine's OAuthExpiryMonitor previously diverged: a subscription OAuth credential with a past or missing/non-numeric `expires` could still read authenticated:true from /api/auth/status even though the monitor had already fired an oauth-token-expired notification for it. `/api/auth/status` now treats any OAuth credential lacking a usable numeric `expires` — and any credential whose numeric `expires` is in the past and cannot be refreshed — as expired:true/authenticated:false, for both the legacy anthropic-row and separated anthropic-subscription-row storage permutations. Settings → Authentication and the global re-login banner both read this corrected status, so an expired-and-unrefreshable subscription now consistently shows as not connected everywhere. FNXC:ProviderAuth 2026-07-11-18:00: FN-7821 — OAuthExpiryMonitor now mirrors this refresh-then-recheck before dispatching oauth-token-expired, preventing false provider pushes (notably github-copilot ephemeral tokens) when the banner-driving status route would refresh and report healthy. -->

<!-- FNXC:ClaudeOAuth 2026-07-05-00:00: FN-7574 — beyond the reactive best-effort refresh on the /auth/status poll, the engine now runs an independent background OAuthRefreshScheduler (packages/engine/src/notification/oauth-refresh-scheduler.ts) on a 5-minute interval, guarded by the same `skipNotifier` option as OAuthExpiryMonitor. It proactively calls the existing refresh-if-due logic in auth-storage.ts for every known OAuth provider (plus the anthropic-subscription alias) so a healthy subscription's access token is renewed well ahead of expiry via the stored refresh token, instead of only refreshing reactively when something happens to request a runtime API key. Only providerId/providerName/expiresAt are ever logged — never token material. -->

Anthropic also supports a raw `ANTHROPIC_API_KEY` from a separate **Anthropic API Key** card in **Settings → Authentication** and Model Onboarding. Claude subscription OAuth remains on the **Anthropic Subscription** card for auth status, usage/subscription checks, and banner clearing; it also drives direct agent execution on the `anthropic` provider — a subscription/OAuth token runs `anthropic/*` selections against `https://api.anthropic.com/v1` with Claude Code identity headers, no API key required. CLI-backed execution remains the distinct, explicit **Claude CLI** provider (`pi-claude-cli`); subscription OAuth does not require it. When Anthropic Subscription is expired but Anthropic API Key or Anthropic — via Claude CLI is already authenticated, the global banner suppresses only the urgent subscription re-login entry so it does not imply agents are blocked; Settings still shows the subscription OAuth card as expired/not connected and re-login remains available. A configured API key takes precedence over OAuth on the direct provider. Saving or clearing an API key does not affect the OAuth sign-in path or turn OAuth tokens into raw API-key material. The dashboard only displays masked key hints after a key is saved.

## Setup Warning Banner

The retired pre-cutover SQLite-to-PostgreSQL storage notice is no longer rendered. Current setup banners cover actionable provider and GitHub readiness only.

The dashboard and New Task modal show setup warnings only after readiness checks finish. AI-provider warnings appear immediately because agents cannot work without a provider. GitHub warnings are delayed per project: Fusion records the first time GitHub OAuth and authenticated `gh` CLI are both missing, waits one day, and then shows **GitHub not connected** if GitHub is still unavailable. Reconnecting GitHub clears the timer so a later disconnect starts a fresh one-day grace period.

When the dashboard GitHub warning is visible, its **Connect GitHub** action opens **Settings → Authentication**. The New Task modal keeps immediate AI-provider warnings but suppresses the GitHub warning because that modal does not own the Settings navigation callback required for an actionable GitHub setup control.

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

## Artifacts View

Artifacts view aggregates registered artifacts, project markdown files, and task documents. The dashboard title is **Artifacts**; the internal tab bar leads with **Artifacts** (the landing tab), followed by **Project Files** and **Task Documents**. On mobile the tab buttons render at the uniform 44px control height with non-wrapping labels in a horizontally scrollable row.

Features:

- Browse **Task Documents** in the same left-sidebar/right-pane pattern as **Project Files**: the sidebar groups task documents and task-scoped registered artifacts by task ID in distinct task cards with clear spacing between tasks, revision/artifact metadata, and parent task status badges when available, while the right pane loads the selected document or artifact preview
- Search task documents and task-scoped artifacts across tasks
- Open project markdown files, task documents, and task-scoped artifacts with inline preview
- Browse the **Artifacts** tab for registry media registered by any agent, dashboard chat/user action, or system tool across tasks
- Already-open global and task-detail artifact lists refresh live from the artifact registry event when an agent, dashboard chat session, user action, or system tool registers a new artifact, while preserving active search filters and task scoping
- Use the tab-count badges to see the current counts for Project Files, Task Documents, and Artifacts; the Artifacts badge reflects the loaded `GET /api/artifacts` result set, including active search filters
- Browse the category-driven gallery: artifacts are broken down into **Images**, **Docs**, **PDFs**, **Videos**, **Audio**, and **Other** content categories (PDFs are detected by MIME type/extension regardless of registry type). "All" renders one section per present category; the chip row filters to a single category, and chips only appear for categories that exist
- Each category has a tailored experience: Images/Videos use a visual-first tile grid with hover metadata and a full-size lightbox; Docs open a full document viewer with rendered markdown; PDFs open an embedded viewer with an open-in-new-tab action; Audio renders inline player rows; Other renders compact download rows
- Video artifacts (agent-registered recordings, `path`-ingested MP4/WebM/MOV, and bridged video attachments) play with working seek because the media route serves HTTP byte ranges
- HTML doc artifacts (`mimeType: text/html`) render as **live sandboxed previews** by default in the document viewer (scripts allowed, same-origin denied), with a Preview/Source toggle and the same Edit mode as other docs
- **Edit any inline-content doc in place**: the document viewer's **Edit** button switches to an editor whose **Save** persists through `PATCH /api/artifacts/:id` and live-refreshes open galleries via the `artifact:updated` registry event; binary-backed documents stay read-only with a media link
<!-- FNXC:ArtifactsGalleryDocs 2026-07-12-12:02: Artifact viewer docs distinguish desktop draggable/resizable FloatingWindow behavior from the mobile full-screen sheet so users do not expect to drag a small artifact popup on touch devices. -->
- Every viewer (image/video lightbox, PDF viewer, document viewer) opens in a draggable, resizable floating window on desktop/tablet (drag by the viewer header, resize by any edge/corner; geometry persists per viewer kind); dismiss with the close button or Escape. Windows are non-blocking, so the gallery behind them stays interactive
- Read artifact metadata on cards, rows, and viewer footers: title, optional description, author ID, timestamp, size, and linked task ID when present
- Use the task link on a card/row or viewer footer to jump back to the originating task when the artifact has a `taskId`; inside task detail, the **Artifacts** tab shows that task's documents and registered media artifacts together
- The gallery scales down at the mobile breakpoint (including landscape phones): category chips scroll horizontally, visual grids collapse to two columns, cards and rows go single-column, and viewer windows open as full-screen sheets without desktop resize handles or drag cursors
- Loading state: the Artifacts tab shows `Loading artifacts…` while the first artifact list request is pending and no artifact results are loaded
- Empty states: with no search query it shows `No artifacts yet.` plus the hint that artifacts are created by agents, users, and system tools; with a search query it shows `No artifacts match "<query>".`
- Error state: a failed artifact list request uses the shared `Failed to load artifacts: <error>` panel with a **Retry** action that re-runs the artifact fetch
- Toggle between raw text and rendered markdown using the **Markdown/Plain** button
- Highlight text in raw or rendered project-file previews or the selected Task Document's right pane, choose **Add comment**, and send the source path/key, selected snippet, and your comment to the **New Task** dialog

Agent registrations also surface through the [Mailbox View](#mailbox-view): successful `fn_artifact_register` calls send a best-effort system inbox notification so users can discover new media even before opening the gallery. Artifact list live-refresh does not depend on that best-effort message; it listens to the registry registration event.

![Artifacts gallery](./screenshots/artifacts-gallery.png)

![Artifact document viewer with edit mode](./screenshots/artifacts-doc-edit.png)

## Reports View

Reports View is available when the **Reports** plugin is installed and enabled.

Navigation:
- Desktop/tablet: left sidebar plugin/content entry for **Reports** when the Reports plugin is installed and enabled
- Mobile: **More** sheet → **Reports**

Features:

- Reports history list with filters for cadence, status, date range, title text, and agent
- Detail viewer with a sandboxed iframe preview backed by the report HTML preview endpoint
- Section quick-jump sidebar based on stable report section markers
- Compare drawer for side-by-side report comparisons with section-level diff groupings
- Standalone HTML download/export action for sharing a self-contained report file

For plugin internals (registration, API routes, rendering/export pipeline), see [Reports plugin docs](./plugins/reports.md).

### Markdown Rendering

Artifacts view supports toggling between raw text and formatted markdown when viewing document content:

- **Raw mode** (default): Shows markdown syntax as plain text (e.g., `**bold**`)
- **Markdown mode**: Renders markdown with proper formatting (e.g., **bold**, headings, lists, tables)

The toggle button is accessible with `aria-pressed` for screen readers. Toggle state is scoped per-document, so switching between documents resets the view to raw mode.

Project-file previews and selected Task Documents also support selection comments in both raw and rendered markdown modes. Select text, click **Add comment**, enter a short note, and Fusion opens **New Task** with a seeded description containing the file path or task-document key, snippet, and comment.

## Todo View

Todo View is an experimental full-height dashboard surface for managing per-project todo lists and turning items into planning or task workflows. It renders in the right content area like other project views rather than as a modal overlay.

> Available when `experimentalFeatures.todoView` is enabled.

Navigation:
- Desktop/tablet: **Left sidebar → Todos** when the Todo view is enabled
- Mobile: **More** sheet → **Todos**

<!-- FNXC:Todos 2026-07-12-00:00: Todo operators can declutter long selected lists with a per-project Hide done / Show done toggle while the completion count remains based on all items. -->
Use the items header **Hide done** toggle to hide completed todo items in the selected list; switch it back with **Show done** when you need to review completed work. The completed/total count still reflects all items in the list.

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
- Desktop/tablet: **Left sidebar → Research** when the Research view is enabled
- Mobile: **More** sheet in `MobileNavBar`
- Research is intentionally separate from the primary Board/List workflow controls

For the full research workflow, provider setup, CLI commands, API reference, and agent integration, see the canonical [Research guide](./research.md).

## Files Modal

The Files modal provides a workspace-aware file browser and editor.

- In **Files — Project**, use the visible **Create new file** and **Create new folder** buttons in the browser header to create entries in the current folder; new files open in the editor after creation
- In **Files — Project**, use **Search project files** to find project files recursively without navigating the tree; matching rows include path context so duplicate filenames can be distinguished
- Source/text editing supports a **Line #** header toggle to show or hide line numbers in the editor gutter
- The line-number preference is saved per project and restored automatically when you switch projects
- Known image, video/movie, audio, and PDF files render browser-native read-only previews inline with their real content type from the selected project or task workspace download URL; the explicit **Download** action still saves files as attachments, text files remain editable, and unknown binary files keep the read-only editor fallback
- In editable files and markdown preview mode, highlighted text exposes **Add comment** so you can send the file path, selected snippet, best-effort line range, and your note to the **New Task** dialog without copy/paste

## Memory View

Memory view provides a multi-file editor for project and daily memory files. Its file editors share the same highlighted-text **Add comment** affordance as the Files modal, so memory snippets can seed a New Task with file path, snippet, and comment context.

> Available when the `experimentalFeatures.memoryView` toggle is enabled.

![Memory view](./screenshots/memory-view.png)

## Setup Wizard Project Registration

First-run setup uses the **GitHub (Optional)** step for all GitHub prerequisites and auth choices. When dashboard GitHub OAuth is configured, the step offers an in-flow **Connect GitHub OAuth** action with Cancel/Retry feedback instead of sending users to Settings first. It also checks GitHub CLI (`gh`) on the Fusion server host: installed-but-unauthenticated hosts show `gh auth login` guidance, missing hosts show platform-aware GitHub CLI install guidance and a releases link, and authenticated `gh` still counts as GitHub-ready while OAuth remains optional. The same step checks the `git` executable before users continue into repository setup. If Git is installed, the step shows a low-noise prerequisite-ready note. If Git is missing, it shows platform-aware install guidance for macOS, Windows, and Linux plus a Git downloads link, while still allowing users to skip optional GitHub authentication. These checks reflect the machine or service container running Fusion, not the browser device; users can later manage OAuth from **Settings → Authentication**.

First-run setup and embedded project setup both expose a **Repository setup** section before path entry:

- **Use Existing Directory** registers an existing git repository or workspace root. Workspace detection and the workspace-mode checkbox only appear in this mode.
- **Initialize New Repository** registers the selected local folder and relies on the server-side project registration path to run `git init` if the folder is not already a git repository.
- **Clone Git Repository** requires a non-blank remote URL and an absolute destination path. Fusion runs `git clone` with argument-vector execution, requires the destination to be absent or empty, cleans up a newly-created failed destination best-effort, then registers the cloned folder.

When creating a folder from the project directory picker, Fusion selects the newly created folder immediately so registration targets that folder instead of its parent.

Advanced setup remains limited to runtime node and isolation-mode choices, so repository mode selection is not hidden behind the advanced panel.

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
- **Token Usage by Agent** includes task-derived token counts for ephemeral/task-worker system agents when system agents are shown, matching Agent detail and Command Center Team token surfaces.
- Agent list cards show the configured **Model** or plugin **Runtime** for each agent, falling back to **Auto** when no override is set
<!-- FNXC:AgentTaskStateDrift 2026-06-27-16:46: Agent task badges include the linked task column so parked `triage`/`todo` ownership from the FN-7138 invariant is not misread as execution drift. -->
- Agent list, live-agent, and detail task badges show the linked task ID with its current column when the task is non-terminal (for example `FN-6902 · Planning` or `FN-6902 · In Progress`). Terminal linked tasks are omitted, and unresolved column lookups render an explicit `Unresolved task` suffix so missing or deleted task links are not mistaken for healthy parked work.
- First-run setup asks whether to create an optional project agent after project registration. The default template is **CEO**; users can choose another preset, use the AI interview when `experimentalFeatures.agentOnboarding` is enabled, or skip it. Fusion can still build tasks without an agent by starting temporary agents to plan, code, review, and merge task work.
- Start, pause, stop, and trigger agent runs from the view and from detail panels
- In **Agent detail**, use the kebab **Bulk agent actions** button in the header utility cluster (next to **Refresh** and **Close**) to run project-wide lifecycle transitions for non-ephemeral agents in the current project — **Pause All Agents** targets agents in the `active` or `running` state, while **Resume All Agents** targets agents in the `paused` state only
- In **Agent detail → Settings → Configuration**, the built-in-model picker includes a concrete **Thinking Level** selector; changing it autosaves to the agent's `runtimeConfig.thinkingLevel` alongside the provider/model choice.
- Bulk menu items stay disabled when nothing is eligible and show an inline hint (`Loading eligible agents...`, `No active agents eligible`, `No paused agents eligible`, or the current eligible count such as `Pause 2 active/running agents`)
- Bulk lifecycle flow: open **Bulk agent actions**, review the eligibility hint, confirm the modal, then use the success or partial-failure toast to verify paused/resumed counts plus skipped/failed agents
- Open agent detail tabs for runs, logs, read-only mail (agent inbox/outbox), settings/config, tasks, memory, and chain-of-command relationships
- Error indicator on agent list cards when an agent is in the `error` state and has a captured error (`lastError`); select it to open **Agent Error Details**
- Run-level error indicator in **Agent detail → Runs** when a run has captured stderr; select it to open the same **Agent Error Details** modal
- **Agent Error Details** shows full error text plus **Copy** and **Report on GitHub** actions
- **Report on GitHub** opens a pre-filled issue draft with available context from where you launched it (surface plus agent metadata, and run/task IDs when available on that view)
- Jump from agent activity to related task logs, and (when `experimentalFeatures.agentOnboarding` is enabled) launch **AI Interview** from the New Agent dialog (create mode) or Agent detail → Settings (edit mode)

For full lifecycle behavior, runtime/heartbeat settings, and budgets, see [Agents guide](./agents.md).

## Missions View

Missions view manages mission hierarchies and task handoff from milestones, slices, and features.

<!-- FNXC:MissionWorkflows 2026-06-25-06:04: Missions creates tasks from feature and slice triage, so the user-facing guide must document that its header workflow selector matches Planning and carries the selected workflow into mission-created tasks. -->

Workflow behavior:
- When workflow columns are enabled and more than one workflow is available, Missions shows the same header workflow selector as Planning.
- Feature triage and slice **Triage all features** create new tasks on the selected workflow.
- If no workflow is selected, or workflow columns are unavailable, mission-created tasks continue to use the project default workflow.

<!-- FNXC:MissionInterviewDocs 2026-06-25-15:55: FN-6975 made the Plan Mission with AI workspace movable/resizable on desktop while preserving mobile's fixed full-screen flow, and stream failures now surface one recoverable retry state instead of leaving the modal spinning. -->
<!-- FNXC:PlanningInterview 2026-06-26-00:00: GitHub #1794 requires structured planning, mission, milestone, and slice interview questions to let users reject all provided single-select/multi-select options by choosing Other and writing their own answer. -->

Plan Mission with AI modal behavior:
- On desktop, the modal opens as a floating workspace that can be dragged by its title bar and resized from the window edges/corners.
- On mobile, the mission interview keeps the fixed full-screen/sheet-style layout so touch users retain the original focused flow.
- If the mission interview stream reports a terminal failure, the modal closes the failed stream, shows one normalized error, and offers retry without duplicating late error/complete events.
- Structured single-select and multi-select interview questions include **Other (write your own)** so users can decline all suggested options, submit a free-text answer, or combine that text with selected multi-select options.

## Roadmaps View

Roadmaps view manages roadmap hierarchies (roadmaps, milestones, features) and planning handoff exports.

> Available when `experimentalFeatures.roadmap` is enabled.
> Hidden when a plugin replaces Roadmaps navigation.

Navigation:
- Desktop/tablet: left sidebar plugin/content entry for **Roadmaps** when the Roadmap plugin is enabled
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
- Desktop/tablet: **Left sidebar → Evals** when evaluations are enabled
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
- Desktop/tablet: **Left sidebar → Insights** when insights are enabled
- Mobile: **More** sheet → **Insights**

Features:
- Category-based insight browser with run metadata and status indicators
- Manual insight generation plus refresh actions for latest insight runs
- The model gear beside **Generate Insights** opens a model picker with an inline **Thinking Level** selector. Both the model override and reasoning-effort choice persist in the browser, and each insight run records the selected reasoning effort so retries reuse the same setting.
- Dismiss/archive/unarchive insight records as they age
- Create triage tasks from selected insights directly from the view

## Command Center

Command Center is the combined analytics and live-operations surface for a project: it pairs historical usage, cost, throughput analytics, live system telemetry, and a live Mission Control panel.

Navigation:
- Desktop/tablet: primary header view toggle, immediately after **Agents**
- Mobile: bottom nav tab, immediately after **Mailbox**
- Deep link: `?view=command-center`

Features:
- Global date-range picker in the header scopes the analytics tabs; **Last 24h**, **Last 7 days**, **Last 30 days**, **All time**, and custom/open-ended ranges each request their selected analytics window. **Mission Control** remains live rather than historical.
<!-- FNXC:CommandCenter 2026-06-25-19:47: FN-7019 restored the user-facing picker contract: preset and custom date-range selections must change every historical analytics tab, while Mission Control stays live and intentionally ignores historical range filters. -->
<!-- FNXC:CommandCenter 2026-06-19-23:54: FN-6755 moved team-specific operations out of Overview: org hierarchy and heartbeat pause/resume live in Team, while Overview keeps global AI engine, concurrency, and theme controls. -->
<!-- FNXC:GlobalConcurrencyControls 2026-06-26-00:00: The Command Center Concurrency card mirrors the footer concurrency popover by showing read-only running-agent counts and current-use markers for the shared global cap and current-project max-concurrent slider. -->
<!-- FNXC:GlobalConcurrencyControls 2026-07-15-17:30: FN-8007 aligns each current-use marker with its native range thumb: it maps the cap-clamped running count min-relatively across the expanded slider range. One running agent at slider minimum remains visible at the track start, and over-cap use pins to the cap thumb rather than the track end. -->
<!-- FNXC:CommandCenter 2026-06-26-00:00: The four Overview Concurrency sliders change live scheduler capacity, so each settled edit opens a confirmation popup before persisting; cancel, backdrop, or Escape leaves the previous persisted value in place. -->
<!-- FNXC:CommandCenter 2026-06-27-10:03: Tokens detail charts must show every model bucket returned by analytics for accurate spend attribution; Overview remains a compact top-model summary because its copy explicitly frames those cards as top consumers/share. -->
<!-- FNXC:CommandCenterActivity 2026-06-30-00:00: Activity active-agent counts include both durable-agent usage events and ephemeral task-worker execution runs from agentRuns, because task execution can be visible without a matching usage_events row. -->
<!-- FNXC:CommandCenterActivity 2026-07-01-00:00: Graph-owned workflow step sessions publish active-to-terminal agentRuns lifecycle rows with task lineage and step metadata, so daily activity and Activity throughput charts include new workflow execution without dashboard-side recounting. -->
- **Overview controls dashboard** sits at the top of the Overview landing surface on desktop and mobile. It includes AI engine stop/start backed by `globalPause`, live scheduler status from executor stats, the shared Global Max Concurrent slider backed by `/api/global-concurrency`, range sliders for `maxConcurrent`, `maxTriageConcurrent`, and `maxWorktrees` that persist through `/api/settings`, and a compact theme dropdown with the same color-chip swatches and Shadcn variant list as Settings → Appearance. The four concurrency sliders ask for confirmation after a changed value settles; confirming persists the new cap, while cancel, backdrop, or Escape dismissal reverts to the last persisted value without saving. The global and current-project max-concurrent sliders show running-agent counts plus a current-use dot on the track once utilization data loads; triage and worktree sliders remain cap-only. These controls reuse existing APIs and App-level theme setters; they do not add a new backend route or second theme owner.
- **Overview** summarizes token usage/cost, autonomy, active nodes, sessions, agent runs, tasks done, model breadth, and real open signals, and includes the SDLC throughput funnel for the selected range at the bottom of the Overview content in loading, error, empty, and populated states. **Codebase tokens** is a local-only `cl100k_base`-calibrated pre-tokenization estimate; it does not upload source content or add a runtime tokenizer. **Disk size** is local apparent size (regular files and symlink entries only, not allocated blocks or directory bookkeeping). Both project-intrinsic cards render even before agent usage settles and show `Approx. (partial)` when bounded traversal is incomplete. Git projects scan non-ignored tracked files; non-git fallback excludes only directories whose basename starts with `.` or is exactly `node_modules`, `dist`, or `build`. Source candidates are lstat-gated regular files (symlinks and out-of-root candidates are skipped); disk walking does not follow symlinks. Defaults cap source scanning at 50,000 entries, 4 seconds, 64 MiB total, and 2 MiB/file, disk walking at 500,000 entries and 4 seconds, and cache results for two minutes. System telemetry now formats small byte quantities granularly as B/KB rather than displaying sub-MB values as 0 MB. Its token total and Live activity snapshot token metric refresh on a bounded live cadence and animate number changes while preserving reduced-motion preferences. The sessions card uses the selected-range `ActivityAnalytics.sessions` value already loaded for the overview. The Live activity snapshot also shows the current board-state count for tasks in progress, independent of the selected analytics date range. Overview's active-agent and daily activity values count durable-agent usage events plus ephemeral task-worker execution runs, including graph-owned workflow step sessions that publish `agentRuns` lifecycle rows, with the same agent counted once per day/range if both sources record activity. Overview includes a graph-rich software-factory snapshot with the existing top-model-consumers bar, tool-category bar, top-model token-share pie, and the daily activity multi-series line chart placed before the daily activity sparkline/trend so the richer line graph sits higher in the chart grid. These reuse the already-loaded tokens, tools, activity, and signals analytics; the signals count comes from `/api/command-center/signals` and renders unavailable (`—`) while the incidents-backed response is loading or unavailable. The chart reveal/glow accents are decorative and disabled when reduced-motion preferences are active. The SDLC completion rate is shown as a radial gauge and is calculated as cohort conversion from in-range triage entrants, so the rate is capped at 100% even when older tasks finish during the range.
<!-- FNXC:CommandCenter 2026-06-21-00:00: Command Center cost must read as an estimated, derived value from recorded token counts and the hand-maintained model pricing map; it is never persisted, and the UI must surface prices-as-of, stale low-confidence, and unavailable unknown-model states instead of implying billing truth. -->
<!-- FNXC:CommandCenter 2026-06-22-00:00: FN-6876 requires user-maintained/LiteLLM-fetched pricing overrides to feed Tokens and Team estimates immediately without implying provider billing reconciliation. -->
- **Tokens** breaks down token totals, estimated cost, task count, chat-turn count, and per-model usage. Per-model and per-provider breakdowns include task execution tokens plus supported dashboard chat, task-detail planner chat, and room responder turns when their runtime exposes authoritative session token stats; CLI-backed chat and title generation are excluded until those paths expose reliable stats. Task counts remain task-only while chat turns are counted separately, so task detail token panels stay execution-scoped and planner chat does not double-count the task it discusses. Per-model and per-provider breakdowns use the task/chat analytics-only actually-used model snapshot when available, so usage from settings-resolved runs appears under the real runtime model instead of `(unknown)` without changing future model resolution; estimated cost uses the same snapshot-first, legacy-fallback model identity so those resolved runs price normally when the model is in the pricing table. Estimated cost is derived at read time from recorded token counts multiplied by the effective per-model pricing table: Settings → Global Models pricing overrides win first, then the built-in fallback table is used. It is not persisted, so historical rows stay tied to current maintained prices instead of stale stored billing truth. The Tokens area shows a **prices as of** date/source for the effective table, marks pricing older than the staleness threshold as low-confidence, and shows cost unavailable for models with no pricing entry rather than guessing a price. It includes the existing token-usage-over-time chart, an additive recharts multi-series line graph, a full token-by-model bar, and a token-share pie backed by every grouped model returned by token analytics; use the granularity control to switch the time-series request between hourly, daily, and weekly buckets. The token total and charts poll on a bounded cadence, keep the previous data visible during refresh, animate decorative count/bar transitions, and disable those animations for reduced-motion users.
- **Tools** shows autonomy ratio, tool-call volume, intervention counts, sessions, and tool categories. The area keeps the existing category bar and adds a recharts category-share pie from `ToolAnalytics.byCategory`. There is intentionally no tools line chart yet because `ToolAnalytics` does not expose a per-day tool trend; the dashboard does not fabricate one or call a new endpoint.
- **Activity** tracks sessions, messages, active nodes, active agents, agent heartbeat runs, and stickiness. Active agents include durable-agent `usage_events` and ephemeral task-worker `agentRuns` rows in the selected range; graph-owned/new workflow step sessions publish those `agentRuns` rows as they move from active to completed/failed, duplicate same-day agent ids across both sources count once, and run-only task workers still make the active-agents lines and stat cards non-zero. Agent-run sheets show total, active, completed, and failed runs for the selected range, and the Agent runs/day sparkline trends runs by `agentRuns.startedAt`. The area keeps the existing live animated line charts for messages/day, active agents/day, active nodes/day, and combined throughput/day (`messages + active agents + active nodes`), and adds a recharts multi-series line graph for messages, active agents, and agent runs plus an agent-run outcome pie from the existing `agentRuns` split. These charts reuse the existing activity analytics endpoint, refresh on a bounded 15-second cadence while mounted, keep the previous data visible during refreshes, and disable decorative draw-on motion for reduced-motion users.
- **Productivity** separates outcome counters (commits and pull requests), task-duration stats, and volume proxies such as modified files, lines changed, and files by language. The task-duration block counts done tasks completed in the selected range and shows average, median, p90, and total active execution time from `cumulativeActiveMs`; when no qualifying duration data exists, duration values render the unavailable `—` sentinel rather than `0`. The Lines changed card includes **Preview LOC backfill**, an explicit operator control for historical commit-association diff stats. Preview runs the project-scoped backfill in dry-run mode by default and reports scanned rows, distinct commits, updated rows, skipped unavailable commits, and skipped invalid SHAs without writing; **Apply backfill** appears after a preview and requires danger confirmation before persisting additions/deletions to `task_commit_associations`, then renders the same counts as an applied report. It keeps the files-by-language bar and adds a language-share pie from `ProductivityAnalytics.byLanguage`. There is intentionally no productivity line chart because the current productivity response has no per-day throughput or completion time series; no new endpoint is called.
- **Team** shows the read-only agent org chart, heartbeat pause/resume backed by the existing `enginePaused` setting, a per-agent analytics table, tokens-by-agent and tasks-done-by-agent charts, and a real token-share pie from the same per-agent token totals. The org chart is styled by Command Center's Team CSS, not lazy Agents view CSS, auto-switches to a horizontal top-down tree when the container is wide enough using the same breakpoint resolver as the full Agents view, and otherwise keeps the vertical nested list inside the taller scrollable org-chart container. The org-chart scroll container supports mouse click-and-drag panning while touch devices keep native scrolling. Parent agents draw connector lines to child agents in both horizontal and vertical Team layouts across desktop and mobile breakpoints. Org nodes show only agent names so role/title description/meta text does not clutter Team operations. Metrics come only from the project-scoped `tasks` and `agents` tables: token totals and estimated cost are summed from the `tokenUsage*` columns by `assignedAgentId`, files changed counts parsed `tasks.modifiedFiles` paths, tasks done counts `column = 'done'` moves in the selected range, and in-progress / in-review values reflect current task columns. Agent name, role, and live state come from the `agents` table; deleted-agent task history falls back to the raw agent id instead of crashing. The tab uses `/api/command-center/team`, adds no schema, never calls GitHub, and intentionally leaves per-agent issues filed/fixed to FN-6653. Team has no per-day analytics series today, so it intentionally does not render a line chart or fabricate a trend. Decorative chart reveal motion uses duration tokens and is disabled for reduced-motion users.
<!-- FNXC:CommandCenter 2026-06-27-12:00: Workflows is a read-only Command Center detail tab for custom-workflow observability; it mirrors Team metrics by workflow without adding workflow-editing controls or schema. -->
- **Workflows** breaks down selected-range token totals, estimated cost, tasks done, in-progress and in-review counts, and files changed by workflow. Tasks with an explicit workflow selection appear under that built-in or custom workflow identity; tasks without a selection are attributed to the project default workflow. Unknown model pricing keeps the unavailable `—` cost sentinel rather than displaying `$0`, matching Tokens and Team cost semantics.
- **Ecosystem** shows active model breadth, per-model task activity, and real plugin activations for the selected range. Plugin activation counts come from project-scoped plugin/extension load events via `/api/command-center/plugin-activations`; if no activation rows exist in range, the metric renders unavailable (`—`) rather than fabricating zero. The tab still reuses the tokens analytics endpoint grouped by model, adds a task-share-by-model pie from `TokenAnalytics.groups`, and renders a tokens/tasks trend line when `TokenAnalytics.series` buckets are present; if series buckets are absent, no synthetic trend is shown.
<!-- FNXC:CommandCenter 2026-06-21-07:07: FN-6722 requires the GitHub area to expose a resolved-issue detail list from local task-store analytics only, with exact close timestamps flagged when reconciliation populated `sourceIssueClosedAt` and approximation called out otherwise. -->
- **GitHub** shows local GitHub issue flow for the selected range: **Filed by Fusion** counts tasks with a persisted `githubTracking.issue`, **Fixed by Fusion** counts tasks imported from GitHub source issues (`sourceIssueProvider = "github"`) that are currently in `done`, using the persisted `sourceIssueClosedAt` / `TaskSourceIssue.closedAt` close time when the reconciler has observed it. Rows that predate the field or have not been observed closed fall back to task `updatedAt` as the documented completion-time approximation; Fusion never fabricates a close timestamp and this analytics path never calls GitHub, the `gh` CLI, or any external network source. To make historical fixed dates exact, use **Backfill exact close times** in the Fixed by Fusion card; the dashboard calls the project-scoped manual `POST /api/git/github/backfill-source-issue-closed-at` endpoint in `{ offset, limit }` batches until `hasMore` is false, then surfaces the accumulated `scanned`, `filled`, `skipped`, and `errors` counts. The endpoint fetches real GitHub `closed_at` values once, fills only missing `sourceIssueClosedAt` values, and never runs automatically or from analytics-time rendering. The area shows filed/fixed/net stat cards, a filed-vs-fixed pie, a filed/fixed recharts trend line, existing daily sparklines, a by-repository bar breakdown, and a **Resolved issues** detail list. Resolved rows include the Fusion task, repository, source issue number, optional issue link, resolved timestamp, and whether that timestamp is exact (`sourceIssueClosedAt`) or the documented `updatedAt` approximation; missing issue URLs render as plain text rather than empty anchors or click targets. The same resolved rows are available from the GitHub analytics payload as `resolved` and from the CSV export.

### GitLab Settings disclosure and enable toggle

GitLab settings are collapsed by default to keep Settings less noisy. Use **Settings → Project → General → GitLab Configuration** for project GitLab URL/API overrides, **Settings → Project → Merge → GitLab Authentication** for project token settings, and **Settings → Global General → GitLab Configuration** for global fallbacks. Each disclosure header includes **Enable GitLab integration** so operators can disable GitLab without expanding advanced fields.

When `gitlabEnabled` is off, Fusion keeps saved GitLab URLs and tokens intact but disables outbound GitLab API work: the Import Tasks GitLab provider tab is hidden and restored GitLab import state opens on GitHub instead, API/CLI/pi import paths reject before network calls, and lifecycle comments/close/reconcile/refresh paths skip with diagnostics. Existing imported-task GitLab metadata remains viewable. GitHub imports and GitHub settings are unchanged. GitLab Signals inbound webhooks are configured separately by `FUSION_SIGNAL_GITLAB_SECRET`; they are not governed by the outbound GitLab API enable toggle.

- **Signals** is backed by the project-scoped `/api/command-center/signals` endpoint, which aggregates real rows from the local `incidents` table. Verified external connectors (`POST /api/signals/gitlab`, `/webhook`, `/sentry`, `/datadog`, and `/pagerduty`) create triage tasks and also write/resolve incidents, so Signals shows total/open/resolved counts, MTTR when resolved incidents have enough timestamps, and source/severity/status breakdowns from connector traffic. GitLab supports GitLab.com and self-managed project/group issue and merge-request webhooks through the environment-only `FUSION_SIGNAL_GITLAB_SECRET` and `X-Gitlab-Token` header; no GitLab CLI or server-side link fetch is used. Signals adds an open-vs-resolved status pie from the same response. Signals has no per-day series today, so it intentionally does not render a line chart or fabricate a trend. The companion `/api/command-center/signals/connectors` endpoint returns only per-provider configured booleans, allowing the empty state to distinguish "no connector configured" from "connector configured, awaiting signals" without exposing secrets.
- **System** is the canonical system-telemetry destination. It reads local telemetry from `GET /api/system-stats` and, when multiple registered nodes exist, shows a node selector that can proxy the same system-stats payload through `GET /api/nodes/:id/system-stats` for remote nodes. It renders live radial gauges for app CPU, host memory, and heap usage, keeps a small client-side rolling buffer for CPU/memory/heap trend sparklines, adds a recharts CPU/memory/heap line from that same rolling buffer, and adds a task-by-column pie alongside the existing tasks-by-column and agents-by-state bars. Host memory uses OS-available memory (Node `process.availableMemory()` when available, with a flagged `freemem` fallback) so macOS inactive/cache pages are not reported as used. The Vitest process count, manual kill confirmation, auto-kill toggle, threshold controls, and last-auto-kill timestamp moved here unchanged; the standalone System Stats modal and its desktop Header/mobile More affordances were removed.
- **Mission Control** shows live active sessions/runs/nodes, current sessions and nodes, an animated live activity snapshot, and a live SDLC funnel; when idle it reports that live updates resume when work starts. No additional pie or line chart is rendered because the live SDLC funnel already visualizes the panel's only quantitative distribution (`snapshot.columns`), while sessions/nodes are live control lists rather than categorical analytics. Motion-heavy accents respect reduced-motion preferences.
- CSV exports are available from the analytics endpoints with `?format=csv`. The Tokens CSV includes `nTasks` and `nChatMessages` columns so mixed task/chat totals can be reconciled without relabeling chat turns as tasks. The Workflows CSV includes one row per workflow plus a summary row; the Activity CSV includes daily `agentRuns` values plus summary rows for `(agentRuns.total)`, `(agentRuns.active)`, `(agentRuns.completed)`, and `(agentRuns.failed)`.

Rendering invariants:
- On mobile (`max-width: 768px`), `.cc-tabpanel` remains the sole vertical scroll owner for every chart-bearing tab. Shared chart primitives (`Bar`, `StackedBar`, `Sparkline`, `LineChart`, `RadialGauge`, `Funnel`, `TokenSeriesChart`, and the Command Center recharts wrappers) must shrink within the tabpanel, keep non-zero usable height, avoid stretch/clipping artifacts, and never introduce a competing vertical overflow container.
- The hand-rolled Activity `LineChart` tracks its rendered SVG box for coordinates: populated paths fill the available chart width (no centered square letterboxing), while point markers remain true circles even when the CSS chart box is wide/short on desktop or auto-aspect on mobile.
- Mobile chart text must not rely on min-content luck: bar labels, values, token-series axis labels, funnel headers, radial labels, legends, and chart tracks need explicit `min-inline-size: 0`, wrapping, or ellipsis rules so long model/agent/repo labels cannot crush the track or create hidden horizontal overflow in a real browser.
- On tablet (`min-width: 769px` and `max-width: 1024px`), `.project-content`, `.command-center`, and `.cc-tabpanel` keep the same definite flex/min-height scroll-owner chain, while the live strip and chart grids collapse before they can create document-level horizontal overflow.
- Command Center stat cards, overview chart cards, live strips, table wrappers, Team chart panels, token-series plots, system control cards, and gauge/chart cards share the same tokenized rhythm: `--space-md` gaps/padding for card-like surfaces, `1px solid var(--border-subtle)` borders, `--radius-md` radii, and `--surface-1` backgrounds. Area-specific accents may use `color-mix(...)`, but layout, border, radius, text color, and motion must stay on design tokens, with the named 4px spacing scale (`--space-xs`/`sm`/`md`/`lg`/`xl`/`2xl`) as the canonical vocabulary.
- The dashboard browser-layout smoke includes a `[data-smoke="command-center-charts"]` fixture that loads emitted lazy Command Center CSS and verifies representative recharts pie, line, and empty states at mobile (390×844) and desktop breakpoints. The fixture asserts non-zero chart and SVG heights, visible empty-state text, no internal/page horizontal overflow, and no chart-level vertical scroll owner before chart layout changes are considered verified.

Data states:
- Overview shows a loading state while core analytics settle, then shows `No usage data yet. Run some agents to populate the Command Center.` only after the selected range has settled with no core usage data. Overview, Tokens, Tools, Activity, Productivity, Team, Workflows, Ecosystem, GitHub, Signals, System, and Reliability omit their additive recharts cards in loading/error/empty states, so non-populated data never leaves an empty chart shell.
- GitHub issue analytics is local and additive: empty filed/fixed totals keep the stat cards and historical backfill button available while omitting empty chart shells; malformed historical `githubTracking` JSON is skipped instead of breaking the Command Center.
- Team analytics renders its shared loading/error/empty states for null or zero-agent responses, omits empty chart shells for zero-value datasets, and keeps the Command Center tab panel as the mobile scroll owner.
- Workflow analytics renders the same shared loading/error/empty states for zero-workflow responses, omits empty chart shells for zero-value workflow datasets, and keeps unavailable cost as `—` instead of `$0`.
- System telemetry keeps the previous snapshot visible during refresh failures, preserves the node selector when a selected remote node fails to refresh, renders a first-sample CPU `Sampling…` state without NaN values, shows zero-value task/agent bars for empty collections while omitting the zero-value task-distribution pie, and keeps the Command Center tab panel as the mobile scroll owner.
- Signals is best-effort over local incidents data: if the project has no incidents, the Signals area shows either the setup empty state (no signal connector secret configured) or the quiet empty state (at least one connector configured but no rows in range), omits its status pie, and other Command Center metrics remain valid; endpoint errors surface as the shared analytics error state instead of silently swallowing a missing route.

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
- Desktop/tablet: **Left sidebar → Dev Server** when the Dev Server view is enabled
- Mobile: **More** sheet → **Dev Server**

Features:
- Detect candidate dev server commands and choose which command/session to run
- Pick an executing task to run the dev server against that task's worktree and preview its in-progress work; the selected task's descriptor is shown so you know what you're previewing.
- Start, stop, and restart the current server session
- Manage preview URLs with embedded preview and **Open in new tab** fallback
- Tail live logs, load older history, and refresh session status
- When Dev Server is hosted in a very narrow right sidebar, open the preview from the compact **Open preview** launcher; the modal keeps preview actions available while configuration and logs stay usable in the sidebar.

<!-- FNXC:DevServerDocs 2026-06-23-00:00: The narrow right-sidebar Dev Server host must describe the preview modal launcher so users do not expect the preview iframe to remain inline when the dock is too constrained for logs and preview together. -->

For module-level behavior and API surfaces, see [Dev Server modules](./dev-server-modules.md).

## Stash Recovery in Git Manager

Stash Recovery helps recover orphaned merger autostashes (`fusion-merger-autostash:*`) left behind when merge restore could not fully complete. It now lives as the **Recovery** tab in **Git Manager** and is reached through Git Manager on desktop/tablet and mobile.

Navigation:

1. On desktop/tablet, open the right dock, select **Git Manager**, then select **Recovery**.
   Expected outcome: the Recovery section opens inside the embedded Git Manager panel; expanding Git Manager keeps the same section available in the modal.
2. On mobile, open the **More** sheet, select **Git Manager**, then select **Recovery** from the horizontal section-tab strip.
   Expected outcome: the Recovery section opens in the mobile Git Manager modal with the tab strip still scrollable.

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
- Built-in runtime plugins (Hermes, Paperclip, OpenClaw, Droid) always expose an interactive enable/disable toggle in the Built-in Plugins list, even before install. Disabling one registers it and disables it in the same action, and the decision survives restarts — a disabled runtime is not re-activated on the next startup. The Runtimes settings cards mirror this state instead of showing a stale detected/connected status.

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

Inspect task definition, logs, review feedback, comments, artifacts, workflow outcomes, model overrides, and task routing from a single modal.

- Editable tasks with descriptions show **Summarize as title** beside the read-mode title; it asks AI to generate a concise title from the description and saves it without opening the edit form.
- The top-level **Chat** tab appears first for active task details and is the default landing tab for non-`done` tasks. It uses the task's effective planning model, but opening the tab is lookup-only: Fusion creates the task-scoped planner chat only after you send a composer message, starter prompt, or planner-question answer. Once a user message exists, the resumable planner chat can appear in the global Chat list; interacted chats are kept when the task reaches `done` and removed when the task is archived. Each send includes bounded server-built task context so the planner can answer current status, progress, recent activity, dependency, and task definition questions. It shows starter prompts for common planning questions, can render structured planner questions, and converts only explicit operator steering intent through the scoped steering tool. The composer stays pinned while the transcript, loading, error, starter, history, and streaming states scroll internally; on mobile/narrow task detail, the default focused Chat layout hides nonessential title/metadata/tab/action rows until you collapse it from the in-view expand control.
- The **Activity → Live**, **Feed**, and **Raw Logs** segments remain immediately after **Chat** and share an expand/collapse control that lets the active Activity segment fill the task-detail modal, then restores the normal header, tabs, and action footer when collapsed.
- The **Summary** tab appears for `done` tasks and remains their default landing tab. It shows the recorded completion summary, changed-file/merge stats when available, completed steps, workflow results, retry counts, and a token usage & cost section broken down by model from the already-loaded task detail; unpriced models show cost as unavailable rather than `$0`.
- The **Cost** tab is available for tasks in every column and sits immediately after **Comments → Terminal** in the tab strip. It shows the read-time derived per-model cost breakdown (input, output, cached, cache-write, total tokens, derived USD) and a task total; no token usage shows an explicit empty state, while unpriced or zero-usage rows use `—` instead of a guessed `$0`.
<!-- FNXC:Settings-ThinkingLevel 2026-07-13-00:27: The task-detail Models tab now persists validatorThinkingLevel and planningThinkingLevel separately so Reviewer and Planning lanes can choose reasoning effort without changing the Executor lane's task.thinkingLevel. -->
- The **Models** tab exposes inline **Thinking Level** selectors for **Executor Model**, **Reviewer Model**, and **Planning Model**. Executor saves the shared task thinking level, while Reviewer and Planning save independent per-lane overrides; leaving either lane on **Default** inherits the shared task thinking level and then the configured workflow/project defaults.
<!-- FNXC:TaskDetailCost 2026-07-11-00:00: Cost is read-time derived from task token usage and model pricing overrides, so the always-available Cost tab documents spend without adding persistence or hiding unavailable pricing behind a false zero. Keep it adjacent to Task Detail Terminal so shell context and spend context stay together after Comments. -->
- Task-detail Activity steering comments are persisted as user comments/steering guidance and surfaced to every relevant agent lane: live executor sessions receive steering injection, while planner, reviewer (spec/plan/code), and merger agents (standard and clean-room AI merge/review) receive the latest user comments in their next prompt/pass.
- The priority chip in task metadata is an inline picker: you can change priority directly without entering full edit mode.
- Execution mode has a read-mode inline lightning-bolt toggle for Fast mode on/off without opening the full edit form.
- These two metadata controls share matched sizing/alignment in read mode (including mobile wrapping) so they behave like a single polished control group.
<!-- FNXC:TaskDetailWorkflowBadge 2026-06-29-18:45: Task Detail header metadata shows the resolved workflow name when board-workflows metadata is available, but omits the chip entirely for missing or stale workflow payloads so embedded, modal, and mobile headers do not render empty badge shells. -->
- Task metadata keeps priority, execution mode, provenance, optional workflow identity, optional PR context, and compact `Created` / `Updated` timestamps in one wrapping row across desktop and mobile widths; recent timestamps render as relative time (`just now`, `Xm`, `Xh`, `Xd`) and older values switch to short month/day dates.
- The **Actions** menu exposes **Pause** / **Unpause** for eligible non-terminal tasks, including tasks assigned to agents. If a task was paused by an agent, the **Paused by agent** note is informational; users can still unpause it manually from the same menu. On mobile task popups, tapping an Actions item applies the selected action once and closes the menu.
- For an `in-review` task stranded solely by a failed pre-merge review step, the **Actions** menu also exposes **Bypass failed review** (FN-7720) — a policy-gated escape hatch for the leading real-world cause being the `(no feedback captured)` no-verdict dispatch defect (Runfusion/Fusion#1946). It appears only when the task is `in-review` and has a failed pre-merge review-lane result. Selecting it prompts for a **mandatory reason**; the bypass is fully audit-logged (actor, timestamp, reason, prior status) and never fabricates a reviewer verdict — see "Review-lane bypass (operator escape hatch, FN-7720)" in `docs/workflow-steps.md` for the full semantics, including which merge-blocker conditions still apply after a bypass.
- After delete confirmations are complete, Task Detail closes immediately while the delete request finishes in the background; success and error outcomes still appear as toasts.
- Eligible existing tasks (triage, todo, in-progress, in-review) expose a **GitHub tracking** section directly in Task Detail, even when tracking is currently disabled.
- The GitHub tracking section now defaults to a compact summary row; use the disclosure arrow to expand linked-issue details plus tracking edit controls.
- Tasks linked to GitLab imports show a separate **GitLab tracking** section for GitLab.com and self-managed project issues, group issues, and merge requests. The section provides **Open in GitLab** and local **Unlink GitLab item** actions; lifecycle side effects run in the background and appear as task-log entries such as `Posted GitLab tracking comment`, `Closed linked GitLab source issue`, or `Skipped closing GitLab merge request`.
- GitLab stale state means Fusion is displaying the last persisted GitLab metadata after a sync/import refresh could not confirm a newer state; no GitLab token or secret is stored on the task.
- GitLab comment and close/reopen actions use the configured GitLab REST API base URL for GitLab.com or self-managed instances. Group-imported issues are updated only when Fusion has the concrete project identity plus IID, and merge requests are closed/reopened only for GitLab-supported states; Fusion never auto-merges a GitLab merge request.
- Backstop reconciliation runs every 15 minutes to close tracked GitHub issues for soft-deleted and archived tasks even after restart; the sweep is paginated so large archive backlogs are eventually drained.
- In shared task edit/create forms, GitHub Tracking appears at the bottom of **More options**, after **Workflow Steps**. In task edit mode, **Workflow Steps** appears only when the task's resolved workflow exposes optional steps, so workflows without optional steps do not leave an empty button shell.
- From this section you can explicitly enable/disable tracking and manage a per-task repo override (`owner/repo`). Clearing the override saves `null` and falls back to project/global defaults.
- The **Plan** tab shows the stored **Original prompt** above the generated `PROMPT.md` content, so the exact task prompt remains visible after planning. It is collapsed by default behind a chevron toggle; expanding it renders the prompt as Markdown (the same renderer used for the generated plan body). It stays read-only — editing or requesting AI revision still applies only to the generated plan.
- In `in-review`, pull-request controls/status (including stall badges) are in a dedicated **Pull Request** tab instead of the Definition tab.
- In the task detail **Pull Request** tab, PR numbers open the linked pull request on GitHub when a PR URL is available.
- Task Detail and list split-pane PR affordances follow the live project auto-merge setting: when auto-merge is off, manual **Create PR** / merge actions are shown; when it is on, the tab shows the automatic auto-merge hint unless a per-task override changes the effective behavior.
- A PR created or linked with **Create PR** is treated as a manual handoff: while it remains open, Fusion excludes that task from automatic merge processing so the human can merge via GitHub or **Merge PR**.
- The **Workflow** tab resolves the effective workflow for both explicitly selected and default-inherited tasks. Its overview, expandable graph preview, configured step details, and live step results refresh when switching tasks or projects without showing stale rows from the previous task.
- The **Create Pull Request** modal now offers in-app remediation for every blocking preflight check. If `branchOnRemote` is false, use **Push branch to remote** and Fusion will publish `fusion/<task-id-lower>` to `origin` and refresh preflight. If `conflictsWithBase` is true, use **Resolve conflicts with AI** and Fusion will use an AI coding agent to resolve merge markers on the task branch, commit and push real merge changes, or report success without an empty commit when the selected base is already merged; preflight then refreshes so normal PR creation can continue once all checks pass.
- The **Create Pull Request** modal is a floating pop-out like Plan Mission, New Task, and Automations: drag its header or resize from desktop edges/corners, while mobile keeps the full-screen dialog layout. Close it with **X**, **Cancel**, or **Escape**; stray clicks inside or outside the floating shell do not dismiss it.
- The modal shell renders immediately: preflight checks and PR options load independently of AI-generated title/body metadata, so slow AI suggestions no longer block base-branch selection, diagnostics, or manual PR authoring. The **Diff & commit preview** section starts collapsed and can be expanded on demand.
- The **Body** section includes a **Preview/Edit** toggle so authors can review the rendered markdown description before creating the PR without changing the submitted raw body text.
- AI title/body generation is bounded to 60 seconds on the server and 15 seconds in the dialog, and is canceled if the request disconnects; while it runs, the title and body fields show a skeleton loading state and are temporarily disabled, then resolve into generated content or deterministic task-based fallback content on timeout/cancel.
- Project Settings → Project Models includes optional **PR title prompt guidance** and **PR description prompt guidance** fields. Blank fields preserve the default Create PR metadata prompt; populated fields append guidance for the generated title or body sections.
- The **Artifacts** tab combines task documents written by agents or users with task-scoped registered media artifacts. The gallery uses thumbnail-first image/video cards, image and video previews can expand into a dismissible full-size lightbox, video and audio use native controls, document artifacts show text previews, and generic artifacts open through their media URL.
- The **Review** tab is separate from **Comments**: Review shows actionable PR/reviewer feedback and same-task revision controls, while Comments remains the general collaboration thread.
- When a linked PR has actionable comments or a changes-requested decision, **Address PR feedback** appears in the Review tab and on the task card; it starts a same-task AI session to evaluate open PR threads, fix valid issues, reply, and resolve them.
- Review comments hide GitHub template HTML comments in both Markdown and Plain modes, show author avatars or User/Bot fallbacks, label Human vs Bot/agent authors, and include All/Human/Bot filtering.
- **Request revision** in Review resumes work on the same task ID (no refinement task): `in-progress` tasks get steering injection, while `in-review` tasks are moved back to `in-progress` for the same branch/worktree revision pass. The selected feedback can come from either PR review data or reviewer-agent feedback shown in the tab.
- Review supports a manual **Refresh** action in-place: PR mode pulls latest GitHub review state/decision, while direct mode rehydrates reviewer-agent feedback from task agent logs (no GitHub call).
- For shared `branch_groups` (tasks with `branchContext.groupId`), PR merge mode opens and tracks one group-level PR from the group integration branch to the project default branch; member tasks share that PR state.
- In direct/non-PR auto-merge mode, Review renders normalized reviewer-agent feedback (verdict/step/timestamp/detail) with dedicated loading/error/empty states; it does not require users to read raw agent logs.

### Legacy auto-merge stamp cleanup

Settings → Merge includes **Legacy auto-merge stamp cleanup** for operators auditing tasks that inherited historical in-review `autoMerge` stamps. The panel loads a dry-run candidate list, shows task IDs and current columns, and only reveals the destructive **Clear legacy stamps** action when candidates exist. Applying the cleanup requires the browser confirmation prompt, calls the maintenance apply endpoint, and then refreshes the dry-run list so cleared tasks disappear.

Use this panel when upgrading a project with pre-FN-6245/FN-6277 in-review rows before relying on per-task auto-merge overrides. It only targets stamps tagged as legacy provenance; explicit user overrides remain intact.

### Executor footer engine controls

<!-- FNXC:ExecutorStatusBar 2026-07-15-17:30: FN-8007 documents that footer concurrency current-use dots use the same native range-thumb mapping as Command Center controls, including the slider-min floor and cap-clamped over-cap position. -->
<!-- FNXC:ExecutorStatusBar 2026-06-29-19:09: FN-7248 makes footer concurrency edits confirmation-gated like Command Center. Closing the popover, outside-clicking, pressing Escape, dismissing the backdrop, or unmounting must revert unconfirmed slider edits instead of saving them. -->
<!-- FNXC:ExecutorStatusBar 2026-06-30-16:42: FN-7273 keeps the footer Engine Controls popover usable on mobile, narrow tablets, and tablet landscape by documenting that constrained screens use a full-width bottom panel above both fixed bottom bars instead of the compact desktop anchor. -->
<!-- FNXC:GlobalConcurrencyControls 2026-07-15-17:30: FN-8007 keeps footer and dashboard current-use marker geometry aligned with the native range thumb, including its desktop and mobile thumb-size edge inset. -->
The global AI engine stop/start control and triage pause/resume control live in the executor footer status bar rather than the header. Select the small engine-controls button beside the executor state badge, or select the state text such as **Running**, to open the footer popover. The popover includes **Stop AI engine** / **Start AI engine**, **Pause triage** / **Resume scheduling**, and live scheduler sliders for max concurrent tasks, max triage concurrency, and max worktrees. On mobile, narrow tablets, and tablet landscape, the same controls open as a full-width bottom panel above the executor footer and mobile navigation so the close button and sliders remain reachable. Use the visible **Close engine controls** X button, Escape, or outside-click to dismiss it. The global and current-project concurrency sliders also show how many agents are running, including actively-triaging planners (`triage` + `planning`, not paused), and a dot on the slider track for current use. The dot uses the same min-relative range coordinates and thumb-size edge inset as the native slider: it aligns to the cap-clamped running count, so one running agent at the slider minimum stays visible at the start and over-cap usage pins to the cap thumb instead of the expanded track end. Changed concurrency slider values ask for confirmation after the value settles. Confirming saves the global cap through `/api/global-concurrency` and project caps through `/api/settings`; cancel, backdrop dismissal, Escape, close, outside-click, or unmount reverts unconfirmed slider edits without saving. Multiple changed project sliders within one debounce window are summarized in one confirmation dialog, matching Command Center behavior.

<!-- FNXC:ExecutorStatusBar 2026-06-27-00:00: FN-7163 makes footer stats loading initial-only so routine heartbeat refreshes keep the populated footer and open concurrency popover mounted instead of blinking to the loading branch. -->
Brief, single-poll executor stats fetch blips keep showing the last good footer stats instead of flashing **Connecting…**. Routine executor stats heartbeats also keep the populated footer mounted after initial load, so an open engine/concurrency popover stays open while counts refresh. The footer only switches to **Connecting…** for sustained suspension-like stats failures, or to an explicit error state for non-transient failures.

### Engine status banner

When a project dashboard is open but no project engine is connected, Fusion shows a sticky **Engine disconnected** banner above the project content. This covers paused projects, failed or still-starting project engines, delayed reconciliation, and dashboard-only/dev launches where the UI is available before an engine manager is attached.

If the server can start the current project engine, use **Start engine** in the banner to resume a paused project or call the project engine startup path without reloading the dashboard. While the start request is in flight the button is disabled and shows the starting state so repeated clicks cannot create duplicate startup attempts. The banner disappears as soon as the status endpoint reports the project engine is connected.

If the dashboard is running without engine management, the banner stays informational and disables the start action. Start the full server with `fn serve` to enable one-click engine startup and live task execution.

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

### Activity → Raw Logs view

<!-- FNXC:TaskDetailActivity 2026-06-30-23:55: Activity Live is the explicit operational steering-comment entry surface, preserving the legacy internal `current` segment id. Feed and Raw Logs remain read-only Activity segments, the Activity-wide expand control is available on every segment, and the top-level Chat tab is intentionally separate planner-model conversation rather than steering. -->
<!-- FNXC:TaskDetailActivityFirst 2026-06-30-23:59: Task Detail is Activity-first by default for active tasks: Activity renders before planner Chat and omitted non-done opens land on Activity → Live. Settings → Appearance → Open task details with Chat first restores the previous Chat-first order/default without changing explicit Activity, Chat, or Logs links. -->
<!-- FNXC:TaskDetailActivityMobile 2026-07-03-21:30: On narrow mobile task-detail layouts, Activity view switching uses a fixed root-portaled Activity views menu so iOS viewport resize/scroll echoes during the tap cannot hide Live, Feed, or Raw Logs choices. -->
<!-- FNXC:TaskDetailActivity 2026-07-04-18:37: The Activity views menu remains root-portaled to avoid tab/body clipping, but it is layered above and repositioned with its owning task-detail modal or task popup so drag/resize never leaves the menu behind or detached. -->
<!-- FNXC:TaskDetailActivity 2026-07-04-19:10: FN-7536: the opening tap that shows the Activity views menu can itself trigger a same-gesture window resize/scroll echo (Android/mobile Chrome URL-bar collapse or tap-into-view auto-scroll, distinct from the iOS visualViewport echo above). That echo, and scrolling the `.detail-tabs` horizontal tab strip itself, now only reposition the open menu instead of closing it; a later, real viewport change still closes it as before. -->
The **Activity** tab is the first task-detail tab by default and presents **Live**, **Feed**, and **Raw Logs** as a segmented control on wider layouts and as a fixed, root-portaled **Activity views** dropdown on narrow mobile layouts. The dropdown stays above its owning task-detail modal or task popup and follows the Activity tab while a popup is dragged or resized. Live contains the live, chat-styled transcript of task agent output. Consecutive entries are grouped by role and labeled as Planner, Executor, Reviewer, or Merger; legacy log rows without an agent role use the neutral Agent fallback. Agent group headers and user message headers show a small muted relative timestamp (for example, “just now”, “1m ago”, or “2h ago”) based on the transcript timestamp, while agent group metadata still includes the entry count. Consecutive text/message chunks inside a role group render as one continuous markdown bubble, while consecutive tool/tool-result/tool-error rows collapse into one expandable, compact tool-call summary that stays collapsed by default and mirrors regular Chat's dense treatment; the summary stays single-line/ellipsis-friendly on desktop and mobile, counts tool invocations, lists deduped tool names with overflow, and shows an error count when failures are present, while the expanded body pairs each call with its result or error in dense entry cards. Thinking entries render in a collapsible block that starts expanded. The transcript opens at the latest output whenever the tab loads or becomes active, then follows new live output when you are already near the bottom while preserving your scroll position when you review older messages. When older task-agent history exists, scrolling to the top or selecting **Load previous messages** prepends earlier transcript entries without moving the message you were reading. When you scroll away from the bottom of a populated transcript, a sticky **Latest** button appears inside the transcript so you can jump back to the newest message and resume live follow. For non-`done` tasks, the Activity Live composer sends typed guidance through the same steering path used by comments, including active planning/triage, `in-progress`, and `in-review` sessions, plus live CLI-agent sessions reported by the session bridge; an `in-review` Activity Live message or Comments-tab task comment re-engages an executor unless an open PR blocks moving the task back, and other messages are still saved as queued guidance when no session is currently live. Feed and Raw Logs do not show the composer. On a `done` task, the same composer starts a refinement task using the typed text as feedback and shows a success toast with the new task ID, while the current task detail modal remains on the completed task. The task-detail Activity Live segment keeps the composer pinned and visible on mobile and desktop while the transcript scrolls internally; its textarea placeholder reads “Steer the currently executing agent” for steering mode and switches to refinement copy for completed tasks, with the same inline, icon-only send affordance to the right of the input at every breakpoint. In the composer, plain **Enter** sends, **Shift+Enter** inserts a newline, and **Cmd/Ctrl+Enter** remains a supported send shortcut.

The top-level **Chat** tab opens the planner-model conversation for the same task instead of posting steering comments. It appears after Activity by default, or before Activity when **Settings → Appearance → Open task details with Chat first** is enabled. Each send includes server-built, bounded context for the task id, status/column/progress/current step, dependencies, recent activity/comment excerpts, prompt/plan content, and available source/review state; unavailable sections are labeled so the planner states uncertainty rather than inventing execution evidence. Opening the tab with no existing history does not create a database chat row; when no planner-chat history is found, Chat shows a guided empty state with starter prompts for recent activity, current status/blockers, next best action, and plan/definition review. Selecting a starter creates/resumes the planner chat and sends that prompt as an ordinary chat message through the task-context-aware planner-chat composer/stream path, including for completed tasks. On live tasks, clear bounded implementation-change requests are routed to task steering; on `done` tasks, clear follow-up implementation or improvement requests are routed through a task-scoped planner refinement tool that calls the same refinement creation path as the completed-task Activity composer. The starter prompts disappear while history is loading or after conversation history exists, so Activity Live, Feed, Raw Logs, and the steering/refinement composer remain separate. Planner Chat uses the same standard chat bubble, markdown/plain assistant rendering, thinking details, tool-call/question cards, and mobile first-tap send/stop affordance as the main Chat view while keeping task-scoped planner sessions separate. Planner Chat defaults to focused mode, keeps its composer visible at the bottom while only the transcript scrolls, and on narrow/mobile task-detail layouts collapses nonessential rows above the chat until the user selects the Chat collapse control.

The **Raw Logs** segment is designed for debugging long-running and tool-heavy sessions, while legacy links that requested the former top-level Logs tab land on Activity → Feed:

- Full `thinking`, `tool_result`, and `tool_error` payloads are shown without entry-content truncation.
- Raw tool output is rendered as multiline blocks, preserving line breaks and indentation.
- The Feed and Raw Logs segments show loading indicators while their first async history/detail request is pending, so empty states only appear after the relevant fetch completes.
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
- Save provider options such as Tailscale **Accept routes** and **Remember last running state** with the main Settings **Save** button; starting a tunnel is not required for these settings to persist.
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

<!-- FNXC:DashboardTheming 2026-06-21-00:00: FN-6840 synced the user-facing theme docs to the shipped expanded Shadcn family, the Shadcn Custom color-picker preset, and the sidebar accent behavior that follows each theme's --accent token. -->
<!-- FNXC:DashboardTheming 2026-07-01-00:00: Glass Silver is the silver/gray frosted sibling of Glass and is selectable anywhere color themes are listed, so keep the inventory count and theme description in this guide aligned with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-07-03-00:00: Fresh installs and reset-to-default use System mode so the dashboard follows the OS light/dark preference before and after hydration while keeping Shadcn Ember as the default color theme. -->

Dark/light modes via `data-theme`; fresh installs default to System mode so the resolved theme follows `prefers-color-scheme` until the user explicitly chooses Light, Dark, or System. 76 color themes via `data-color-theme` (lazy-loaded from `app/public/theme-data.css`), including the Shadcn zinc-neutral theme with an orange default highlight/accent, Shadcn Custom (the same base with sanitized per-token color-picker overrides), and its color family: Shadcn Blue/Green/Red/Purple/Pink/Orange/Yellow, Shadcn Mono Red/Blue/Green/Purple/Pink/Orange/Yellow (grayscale surfaces with color-specific accents; legacy `shadcn-mono` selections migrate to Shadcn Mono Red), Shadcn Black (pure black and white), Shadcn Gray (fully neutral zinc-gray accent), and Shadcn Gray Blue (blue-gray slate neutral surfaces with a muted slate-blue accent). Air is the minimal, borderless, paper-like preset with near-monochrome tokens and CSS-only chrome flattening. Glass Silver preserves the Glass theme's frosted translucent surfaces and transparent modal overlay behavior while using silver and graphite accents instead of purple/pink.

Choose Shadcn variants from **Settings → Appearance** or from the Command Center **Overview** theme card; both use the same compact `ThemeDropdown`, labels, and color-chip swatches. The left sidebar active-item highlight and resize accent use the active theme's `--accent`, so they follow the selected Shadcn accent instead of staying fixed blue.

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

### MCP server management in Settings

Manage Model Context Protocol servers from the existing Settings modal; no new top-level dashboard view is introduced. See [MCP](./mcp.md) for the full setup, validation, CLI, import, and export guide.

- **Settings → Global → MCP Servers** stores global MCP defaults shared by projects.
- **Settings → Project → MCP Servers** stores project-level MCP settings. Project entries override global servers by matching `name`, and a same-named disabled project entry suppresses the inherited global server. The project list marks inherited, overridden, project-local, and disabled-global states so operators can see which scope owns the effective entry.
- Supported transports are `stdio`, `sse`, and `streamable-http`. The editor shows the transport-specific command, URL, args, env, and header fields.
- Sensitive MCP values are secret references only. Environment values, HTTP/SSE header values, and tokens must be selected from or created in Fusion secrets; plaintext values are never persisted into the settings blob.
- Each server row has a **Test** control that calls the MCP validation API and renders pending, valid, unreachable, or error status inline using the standard status-dot convention and semantic status colors.
- The **Discovered on this machine** region scans known Claude Desktop, Claude Code, Cursor, Windsurf, and VS Code MCP config paths for the selected scope. Candidates are read-only and inert until the operator clicks **Add**; sensitive discovered values open the secret-reference editor instead of persisting plaintext.
- The import panel accepts Claude Desktop-style `{ "mcpServers": { ... } }` JSON by paste or upload. Imported plaintext sensitive values are converted into Fusion secret references before the settings draft is saved.
- The export panel produces Fusion MCP JSON for the active scope and offers copy/download actions.

The MCP sections reuse Settings form/card primitives and include mobile layouts for `(max-width: 768px)` so validate, discovery, override, disable, import, and export controls remain usable in the Settings sheet.

### Lazy-Loaded Heavy Views

These 20 views are lazy-loaded via `React.lazy()` with `<Suspense fallback={null}>`. `prefetchLazyViews()` warms App-level chunks once on mount via `requestIdleCallback`; AppModals lazy modal imports (`SettingsModal`, `WorkflowNodeEditor`, `SetupWizardModal`) are part of the same inventory. **Do not make these eager.** The user-facing **Artifacts** section is still implemented by the `DocumentsView` component name.

- `AgentsView`
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
- `PullRequestView`
- `SetupWizardModal`
- `SettingsModal`
- `WorkflowNodeEditor`
- `PluginManager`
- `PiExtensionsManager`
- `AgentDetailView`

Embedded Workflows (`_WorkflowEditorView`), Import Tasks (`_ImportTasksView`), Automations (`_AutomationsView`), and Settings (`_SettingsView`) reuse existing lazy chunks and are intentionally excluded from the curated count by the underscore-prefixed App const convention.

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
- `POST /api/branch-groups/assign` is the supported online grouping path to attach/detach tasks (`{ taskId, groupId|null, branchName? }`). Passing `groupId: null` clears only that task's branch-group context and preserves unrelated task source metadata.
- `POST /api/branch-groups/:id/promote` triggers the engine promotion flow (`promoteBranchGroup`) and returns promotion/PR status.
- `POST /api/branch-groups/:id/abandon` marks an open group abandoned and best-effort closes its managed PR.

Every branch-group endpoint is project-scoped per request. Pass `projectId` in the query string for any endpoint or in a POST JSON body; reads, writes, member serialization, promotion, and PR reconciliation all use that selected project's store. Omitting `projectId` preserves compatibility by using the dashboard's mounted default store.

UI surfaces:

- Subtask planning interview shows a grouped indicator when `assignmentMode=shared`.
- Task cards show grouped/shared branch metadata for grouped tasks.
- Clicking either grouped badge opens the dedicated **Group Task Modal** for that branch group.
- Task detail renders a branch-group card with member landed progress.
- If a task references a stale/missing branch group, Task Detail shows a **Stale branch group reference** recovery message with **Reset branch group for this task**. The action uses the supported assign API to clear only the current task's context, then reloads the detail so the card disappears and the task can proceed ungrouped without direct database surgery.
- In Task Detail Logs on mobile, the branch-group card includes a collapse/expand toggle so logs can reclaim vertical space while keeping group summary progress visible.

The Group Task Modal shows shared branch name/status, member list (`taskId`, title, column, landed state), quick links to open each member task detail, completion progress (`X of Y members finished`), and tracked PR state when present. Branch groups are durable PostgreSQL state keyed by real `BG-*` ids, so valid grouped tasks continue to list/show after a server restart. It live-refreshes from the same dashboard task-update stream and ignores stale cross-project events.

> **FN-7532:** a member only counts as "landed" once it merge-confirms onto its OWN group's branch via the branch-group-integration path (`mergeDetails.mergeTargetSource === "branch-group-integration"` and a matching `mergeTargetBranch`) — this is the same predicate the engine's promotion gate uses, so the checklist can never show "complete" when a real promotion would still be refused (or vice versa). The merge engine now stamps this attribution for every merge (previously only the legacy merge path did, so shared-group members merged through the current path were undercounted).

> **FN-7534:** archiving a member does NOT remove it from its branch group's completion count. An archived member that never landed stays in `total` as pending, so the checklist and the engine promotion gate (`promoteBranchGroup`) both keep reporting the group incomplete — archiving a stuck/abandoned member is not a way to force a group to "complete". An archived member that HAD already landed before archival keeps counting as landed (its merge-confirmation is frozen at archive time), so a group that was genuinely done before one of its members got archived does not regress into a permanent stuck state.

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
