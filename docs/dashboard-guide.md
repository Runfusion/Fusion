# Dashboard Guide

## In-app report filing targets

In **Settings → General**, workspace projects also show a **Workspace repositories** card. It lists registered members, offers detected direct-child Git repositories and a free-text entry, and adds a validated member without restarting the engine. Projects without workspace configuration do not show the card.

### Workspace landing progress

Task Detail's **Details** tab lists each acquired workspace repository as pending, landed, or failed. A landed entry shows its recorded landing SHA; a structured environment failure names the affected resource and the recovery action without exposing raw Git stderr. After the operator repairs that environment, use the existing in-review **Retry** action: landed repositories remain intact and only unresolved repositories are considered. Automatic, retry, and human-requested merge attempts share this progress view; repeated observations of the same failure should not require a second workspace-specific control.

In **Settings → General**, operators can choose a default GitHub report target (**Issue** or **Discussion**) and add an optional per-action override for Bug, Feedback, Idea, or Help. Leaving these settings unset preserves the built-in routing: Bug and Idea file Issues; Feedback and Help file Discussions. The `reportDiscussionCategory` setting selects the category for Discussion reports.

Discussion filing uses the same scrub-before-egress report pipeline as Issues. File submissions re-scrub edited report text and activity traces before pipeline processing, so local paths, project labels, and credentials cannot cross that boundary. Duplicate matching considers open Discussions only; a confirmed duplicate receives an upvote reaction and one scrubbed data-point comment rather than a new Discussion. If a repository has Discussions disabled, Fusion detects that during either Discussion search or creation, reruns Issue deduplication, and files an Issue instead; the filed result explicitly identifies that fallback destination.


[← Docs index](./README.md)

The Fusion dashboard is the main control plane for tasks, agents, missions, settings, logs, and repository operations.

## Common view composition

Dashboard destinations use one composition contract. On desktop and tablet, a collection keeps its local sidebar visible beside the selected detail, including while creating or editing an item; the sidebar preference starts at 300 pixels, is bounded from 220 to 560 pixels, and is stored separately for each project. On phones, the same mounted view presents the collection first, then the selected detail, so switching presentation does not discard drafts, streams, focus state, or request ownership.

Each surface is ordered as **Header → optional Tabs → Content → optional Footer**. The header owns the current title and view-level actions. A resource's primary creation action appears once in that header with the shared Plus button; phone headers show its icon only while retaining the localized accessible name. Contextual form submission, interview responses, and confirmations may remain in a footer. Tabs, choices, filters, and list labels keep their informative text.

The window tools follow the same rule. **History**, **Scripts**, and **Git Manager** build their title, filters, and single close control in that shared header, and their list or sections scroll in the bounded content area below it. **Scripts** presents its saved scripts as the collection beside the create/edit form, keeps its single **Add Script** entry in the header, and on phones shows the list first and the form behind the shared return. When one of them is framed by the right dock or a mobile drawer, the framing host supplies the exit and the tool shows no second header or duplicate close control.

Dialogs, confirmations, onboarding flows, and secondary windows use the same header. Agents, Usage, Changes, Model selection, node and connection dialogs, settings pickers, task reset, and the expanded workflow output all show one title row that carries their icon, their view-level actions, and the single canonical close control. A surface that deliberately has no exit — an onboarding choice, a duplicate warning, a stash-conflict recovery, or a destructive confirmation — keeps its explicit decision buttons as its only way out rather than gaining a close cross.

A detail return is a single, touch-sized ChevronLeft button before the owning title or identity, and it exists only where it performs a real internal navigation — returning from a detail to the list that opened it. A control whose only effect would be to dismiss the surface is not a return: in phone drawer presentation the drag handle, the backdrop, and Escape already dismiss the drawer, so no Back arrow is shown there. On a phone that does not use drawer presentation, a surface whose close control is hidden keeps its return so it still has a visible way out. Drawers do not add a second title, Back row, close action, or scroll container when their content already owns it. Global navigation and quick-entry controls keep their existing owners and do not become duplicate local destinations.

The Dashboard is the one deliberate phone exception to the collection-first contract. On a phone, its header always reads **Dashboard**, it shows no detail return, and a full-width drop list of every Dashboard section sits directly under that header. Choosing a section updates the content in place, without moving to a separate menu screen, and opening the Dashboard still lands on Overview. On tablet and desktop the Dashboard is unchanged: its sections stay in the local sidebar beside the selected content.

## Board completed columns

When a newly completed task arrives while a completed column is already at the top, the column stays at the top and shows that task immediately. If you have scrolled farther down, Fusion preserves your reading position instead of pulling you back to the newest task. This arrival behavior is separate from automatic history pagination: reaching the bottom can continue loading older completed tasks without changing which content you were reading.

## History View

History is the permanent daily delivery history. It is a single window surface, like a task or a conversation: the History button in every completed workflow-column header opens one History window over whatever you were already looking at, on phone, tablet, and desktop alike. It never replaces your current view, never switches you to the board, and there is no separate full-page History destination or second pilot window. Close it with its close control, Escape, or the browser/Android back gesture; switching projects closes it too. Its general navigation entry is hidden, and on desktop History is not duplicated in the footer. It groups entries by UTC day and includes a search field that matches task IDs, titles, and captured completion summaries. Each entry shows the task identifier and, underneath it, that task's label — its stored title, or the beginning of its description when no title was given — never the identifier twice; deliveries whose task no longer exists show the identifier alone. Each delivery is a separate record, so reopening and completing the same task later adds another entry on that later day instead of replacing the first. The History header remains fixed while its day list scrolls; managed Chat and detached conversations use the same fixed-header/content-background shell and canonical close control without changing their saved geometry or conversation state.

Fusion writes a completion entry in the same database transaction that moves the task into its completion lane. The recorded title and summary are point-in-time snapshots that remain unchanged through later moves, re-summarisation, or task deletion. A revert adds a distinct **Cancelled** entry paired to the specific delivery it cancels and marks that completion as **Reverted** without changing other deliveries of the same task.

Selecting a delivery opens that task in its own task window on top of History, with no dimming or blurred veil over the screen. History stays visible, clickable, and scrollable behind it, keeps its place in the list, and is never reloaded, so you can open several tasks in a row. Closing the task window leaves History open, and Escape closes the task window first, then History. On phones the task takes over the main panel instead, because a phone shows one task detail at a time.

Chat reads this same history through the read-only `fn_history_read` tool. Ask for a date range or search phrase to review shipped and cancelled work without opening the History window.

### Mobile and desktop interface boundary

<!-- FNXC:MobileShellBoundaryDocs 2026-09-16-19:44: FN-468 moves the mobile/desktop interface boundary to 1024px and makes the floating pill expand with the available width. This supersedes every earlier statement that tablet shares the wide footer, keeps a left navigation column, or keeps a right dock. -->
Fusion switches interfaces at 1024 pixels. Every screen narrower than that — phone **and tablet** — gets the mobile interface: the floating navigation pill at the bottom, with no left navigation column, no wide bottom navigation bar, and no right dock. The desktop interface begins at 1024 pixels and is unchanged.

The pill shows exactly the project's **Navigation quick access** selection — the same five shortcuts, in the same order, as the wide bottom bar on a desktop. One setting drives both interfaces and the rendered row no longer depends on the available width, so a given configuration always produces the same shortcuts on a phone, a tablet, and a desktop. The **Board** slot remains an ordinary destination of that selection, which on mobile shows and opens **List**. Every destination left out of the selection stays reachable from the navigation menu, and no destination is ever offered twice. The menu trigger always remains the last control in the pill, unless the project enables **Open the mobile menu with a swipe** — see below.

<!-- FNXC:HeaderNavigationOwnership 2026-09-17-02:14: FN-481 — the Header takes priority over the bottom navigation on every breakpoint, and the phone-only tools stay in the bottom menu. -->
The Header takes priority over the bottom navigation. Whatever the screen size, a destination the Header already offers on that screen is removed from the pill row **and** from its **More** menu, so the same access is never presented twice. On a phone that removes **Projects** and **Usage** from the bottom navigation, because the header already carries the project switcher (with its **View Projects** action) and the one-tap Usage shortcut; **Notes** and **Activity Log** stay in the bottom menu there, since the phone header renders neither trigger. On a tablet the bottom pill is kept, but the header additionally carries **Notes** and **Activity Log**, so those two disappear from the bottom menu as well. The removal is derived from what the header actually renders: when a header access is unavailable — no project to switch to, a tool with no host — the bottom entry stays, so deduplication never makes a destination unreachable. It also never changes the saved **Navigation quick access** selection.

Chat follows the same boundary. Below 1024 pixels the conversation opens as an ordinary main page, on tablet exactly as on a phone, because neither the right dock nor the navigation column exists there; the phone's full-screen drawer presentation itself stays reserved to phones. From 1024 pixels up, Chat keeps its existing desktop host — the right dock under the footer placement, or the main page under the left-sidebar placement.

Tablet touch behaviour is deliberately untouched: movable and resizable windows, full-screen sheets, and the on-screen keyboard behave exactly as before. Only navigation ownership moved. The project switcher also stays in the tablet header.

<!-- FNXC:WorkflowControls 2026-09-17-02:14: FN-481 — tablet keeps the mobile bottom navigation but arranges its header like desktop; the compact header layout belongs to phones only. -->
A tablet takes the mobile bottom navigation, but its header is still arranged like a desktop one: the project selector comes first, then the workflow selector, then Search, in that reading and keyboard order. The compact header arrangement, where the workflow selector sits beside the logo and the compact project switcher, is reserved for phones.

### Desktop navigation footer and right dock

<!-- FNXC:FileBrowserDocs 2026-09-13-08:37: Files in the right dock remains the canonical browser list. Selecting a specific file opens a dedicated editor or preview window without duplicating that list, its resize separator, or narrow-layout Back navigation. -->
The official desktop design (1024 pixels and wider) uses one full-width navigation footer instead of ExecutorStatusBar. Its far-left running/max capacity counter opens the existing Max concurrent tasks and Max worktrees controls, and an icon-only **Settings** action sits immediately to its right; the direct destinations and **More** form one group centered on the bar itself — not on the space left over between the side controls — so the group stays visually centred whatever the width of the left-hand controls and of the Chat/Terminal actions and window-visibility control on the right. Those direct destinations are exactly the project's **Navigation quick access** selection, in the persisted order. That selection has **five** slots (by default Dashboard, Board, Planning, Missions, Chat): the first four sit in the centred group followed by **More**, and the **fifth** occupies the far-right slot of the bar — the place the Chat button used to hold — followed by **Terminal** as the last action. Chat is an ordinary destination of that selection: put Planning fifth and Planning takes the far-right slot instead, while Chat moves wherever you placed it, or into **More** when you do not pick it at all. Any slot left undefined is filled from the default order, which ends with Chat, so an existing four-destination configuration keeps rendering Chat at the far right without any migration. **Settings** is no longer rendered in that far-right group: it is reachable from the icon-only action next to the capacity counter and as the last entry of the **More** menu. The mobile navigation pill is unchanged. **More** opens centered above its trigger as a compact single vertical column, with one destination per row and vertical scrolling when the list grows beyond the viewport. Hovering or focusing the trigger itself opens it — only the **More** button opens the menu, so passing over the empty strip just above the button leaves it closed; once open, a continuous hover corridor and short close grace let the pointer travel slowly between trigger and menu across that empty gap without closing it, while leaving the combined region still closes it and Escape provides explicit keyboard dismissal. **List** is one of the destinations inside **More**, because the tablet/desktop Header no longer carries a List button. History stays available from completed workflow columns instead of appearing in that footer. The right dock body is labelled by its selected tab without repeating a generic visible header above views that already provide their own title. **Files** remains a browser list: selecting any text, image, audio, video, PDF, or binary file opens the shared file editor/preview window, and no editor or save controls replace the list inside the dock. A window opened for that specific file shows only its editor, preview, loading state, or error; it does not repeat the file list, sidebar resize separator, or narrow-layout **Back to file list** action. Opening Files without selecting a file still opens the complete browser with its list and responsive list-to-editor navigation. On a phone, Files is sized by the panel that hosts it rather than by the screen: the file list is the only area that scrolls, it scrolls all the way to its last entry, and the surface never scrolls a second time behind it. Opening a file from that list always shows **Back to file list**, which returns to the list without closing Files. A window opened directly for one file has no list to return to and therefore shows no such return. On every tablet and desktop dock, **Chat** is an inline conversation list: selecting it keeps the list in the dock body, and the dock is never replaced by an expanded Chat window. The list marks each conversation that already has its own window as **Open**. Clicking a conversation, or creating one, opens its dedicated conversation window; asking for the same conversation again raises that existing window instead of duplicating it, and an action that hands text to Chat seeds only the conversation it opened. The Alpha desktop right dock additionally adds **Notes**. A dedicated chat window keeps only its fixed conversation title, transcript, in-conversation search and composer; it has no conversation list, title selector, Back action, or New Chat action, even at narrow and mobile widths. Notes remains a searchable list in the dock; selecting or creating a note opens or raises one dedicated window per note. Each note window owns its editor, dirty draft, autosave and conflict state independently, without a list or Back action, while the standard Notes page keeps its existing list/detail split.

<!-- FNXC:OfficialDashboardDesignDocs 2026-09-16-18:31: FN-469 supersedes the "Terminal immediately left of Settings" footer contract: Settings moves to the More menu plus an icon-only action beside the capacity counter, and the far-right group keeps only Chat and Terminal. Tablet and desktop still share exactly that one footer, and mobile retains its own navigation pill unchanged. -->
<!-- FNXC:OfficialDashboardDesignDocs 2026-09-16-19:44: FN-468 supersedes every "tablet shares the wide footer / keeps its sidebar and right dock" statement in this section. The wide footer, the navigation column, and the right dock exist only from 1024px up; below that, phone and tablet alike use the floating navigation pill, which expands with the available width. Tablet touch geometry, full-screen sheets, keyboard behaviour, and the header project switcher are unchanged. -->
<!-- FNXC:OfficialDashboardDesignDocs 2026-09-13-02:40: Historical: tablet and desktop shared only the wide Alpha footer while mobile retained its own navigation pill. Superseded by FN-468 above. -->
<!-- FNXC:ToolSurfaces 2026-09-15-20:24: FN-433 anchors the bottom-bar Chat panel above its trigger, because the footer is fixed to the bottom edge and a below-anchored panel rendered entirely off-screen; Header Activity and Notes are unchanged. -->
<!-- FNXC:ToolSurfaces 2026-09-16-23:06: FN-437 gives each of List, Notes, and Activity exactly one owner per breakpoint: the Header on tablet/desktop, the bottom-bar menu on a phone, where the Header no longer renders any of the three. The mobile Notes tool drawer is removed, so the bottom-bar Notes entry opens the full-screen Notes view in the main-content drawer. The same change restores a permanent New Task action in the Header on desktop, because creation previously depended on which view was on screen. -->
Dashboard, Board, List, Planning, Missions, Agents, and Mailbox remain footer pages or actions as applicable. **New Task** is absent from the desktop footer but present in the Header at every breakpoint: tablet and mobile keep the rightmost compact Header action, and on desktop the same action is available from every view, including List, so a task can be created without returning to a particular screen. On desktop the List view additionally keeps its own workflow-aware create button, which preserves the selected-workflow argument; the two live in separate bars and neither replaces the other. Column headers do not duplicate it. The Header workflow selector exists on Board and List only: on Planning, Missions, Graph, and every other destination the top bar shows no workflow dropdown, and those pages keep using the workflow already selected on Board/List. **List** is no longer a Header button on tablet and desktop — it is an ordinary destination in the footer **More** menu (and in the sidebar under the sidebar placement). On Board and List, the desktop Header keeps the workflow selector and one Search icon on one non-wrapping row; long workflow names truncate before the Search icon moves. Selecting Search replaces the icon in place with an inline task field whose results open in a panel below it, without an overlay or backdrop. Choosing a result opens Task Detail without filtering Board or List; the close button, Escape, and selection clear the transient query, close the field, and restore the Search icon. See **Task search** below for what that panel contains. In Quick Entry, the rightmost primary action is an icon-only Save button: a single click or tap saves the task exactly once, while a continuous 500 ms hold fills the button and starts the task. Releasing before the threshold performs the ordinary save; leaving or cancelling the gesture creates nothing, and the associated synthetic click is ignored. On mobile, every visible icon-only action in the primary row uses the same token-sized square; text option controls retain their content-sized width. Graph and enabled plugins, Skills, Memory, Whiteboard, Goals, Automations, Import Tasks, Workflows, Insights, Research, Ideation, Evals, and Settings remain overflow page/actions with their existing gates; in the tablet/desktop footer **Settings** is the last entry of that **More** list. Files, Git Manager (which owns Pull Requests), and Dev Server are ordinary navigation destinations; Secrets lives in Settings, Activity and Notes are Header panels on tablet and desktop only (on a phone the Header renders neither trigger: the bottom-bar menu is their single owner, opening the full-screen Activity Log and the full-screen Notes view respectively), and Chat opens its conversation list from the bottom bar. That bottom-bar conversation list opens directly above its Chat button and stays fully visible on screen, at a usable height, while the Header Activity and Notes panels keep opening below their own triggers. Usage, Scripts, and task-detail surfaces remain owned by their existing Header/modal hosts. Terminal additionally uses the shared tablet/desktop footer action and continues to use More on mobile, with every launcher opening the same modal. Tablet retains its sidebar, compact Header, standard right dock, ordinary page routing, and no Alpha desktop windows or guards; its dock does not add Notes, and its **Chat** entry shows the same inline conversation list used on desktop. No-project navigation retains its existing presentation. Historical alphaUpdates values never select another layout.

<!-- FNXC:ToolSurfaces 2026-09-17-05:48: FN-491 removes the full-screen transparent panes that froze the board behind every non-modal desktop panel; one shared dismissal mechanism now owns outside-click closing for all four of them. -->
**Desktop panels never freeze the board behind them.** The bottom-bar conversation list, the Header **Activity Log** and **Notes** panels, and the Header **Usage** popover are non-modal: while one of them is open the board behind it stays fully scrollable and clickable. Scrolling the board with the wheel or a touch gesture never closes the open panel. The first click outside does both things at once — it closes the panel *and* acts on whatever you clicked, so opening a task no longer takes two clicks. Escape and the panel's own close control still close it, and a menu or selector opened from inside a panel does not close its host. All four panels share a single dismissal mechanism, so the behaviour cannot drift apart between them. One deliberate consequence: the Header Usage icon only ever opens the popover, so clicking that icon again while it is open leaves it open — close it from outside, with Escape, or with its **Close** control. True modal windows and phone sheets are unaffected and stay blocking.

## Dashboard Updates

When Fusion detects a newer `@runfusion/fusion` release, the Settings modal footer shows the available version with **Learn more** and **Update now** actions. Every Update now result remains visible: install success offers **Restart Fusion**, a current version reports no update, failed checks and installs show errors, and unsupported source-checkout, Homebrew, or missing-npm hosts show guidance instead of running a meaningless global install; missing npm advises updating the installation by its original method. The global update banner remembers a dismissal for that specific release across reloads and browser sessions, then reappears when a newer release is available; this dismissal never suppresses the Settings footer or Command Center update surfaces. Deployments with `FUSION_UPDATES_EXTERNALLY_MANAGED=1` show no update offer because their release pipeline owns the artifact. After a successful install, the running server retains the pending target until it restarts: closing and reopening Settings, the global update banner, and Command Center continue to show the installed-success state and **Restart Fusion**, never a second install action. Settings exposes independent **Automatically install updates** and **Automatically restart after an update** choices for the selected stable or beta channel; the watcher checks about one minute after boot and every six hours. The unattended updater skips unsupported hosts without restarting. When Fusion is unsupervised (for example, started with `--no-supervise`), the restart action remains available so the server can explain the refusal; restart Fusion manually when it cannot be scheduled.

### Automatic page reload after a real deployment

The dashboard reloads itself only when it has actually confirmed that the server is serving a different build. The build identifier it compares is always read live from the server: it is deliberately excluded from the offline cache the installed app uses, because a remembered answer about "what is deployed right now" is not a weaker signal but a wrong one. Before this exclusion, a browser that had kept an older answer from a previous session could read it twice and reload a perfectly current page.

A transient event is never treated as evidence of a new interface. Losing the network, a failed or unreadable check, a reconnection, a background service-worker activation, or a component that fails to load all cause Fusion to *look*, never to reload on their own. If the check cannot be completed, or the answer matches the running build, nothing happens: you keep your page, your scroll position, and anything you had typed. When the server really is serving a different build, Fusion confirms it across two separate checks and then reloads once, and will not reload again for the same target.

Manual recovery is always available and unchanged: the error panel keeps its **Retry** and **Reload page** actions and its diagnostics report, and your browser's own reload works as usual.

### Supervised source-checkout rebuilds

For a capability that has just merged, rebuild only after its commit is present in the fixed source checkout reported by `GET /api/system` as `sourceWorkspaceRoot`. Confirm `rebuildSupported` and supervision, then send authenticated `POST /api/system/rebuild` with `{ "scope": "app", "restart": true }`. Poll `GET /api/system/rebuild/current` until the build succeeds and restart is scheduled; expect the connection to drop, reconnect to the supervised process, and verify `GET /api/health` before capability probes.

Never copy worktree files into the reported checkout, rebuild an unmerged branch, kill port 4040, use `nohup`, or replace the daemon with a raw detached process. An implementation task running inside Fusion cannot continue after stopping its own host, so post-merge restart and live verification belong to a separate operator-run/dependent task with the deployed commit, source workspace, health response, and probe evidence recorded.

## Settings discovery

<!-- FNXC:SettingsSearchDocs 2026-07-04-00:00: Settings search is section-discovery, not a global command palette. Document that it filters visible Settings sections by section names and setting keywords while preserving feature-gated hidden sections. -->
Use **Search settings** at the top of Settings to find the section that contains a setting by name or keyword. The same search works in the Settings modal and embedded Settings page, filters both the desktop section list and mobile section picker, and only searches sections currently visible for enabled feature flags.

<!-- FNXC:UiMetadataApi 2026-07-14-00:00: External dashboard integrations need the same view and Settings-section registry that the UI renders, exposed without duplicating labels or search terms. -->
Plugin and command-palette authors can discover the dashboard's registered view ids through `GET /api/views` and selectable Settings sections through `GET /api/settings/sections`. These authenticated, read-only endpoints return static metadata; see the [Plugin Authoring Guide](./PLUGIN_AUTHORING.md#ui-metadata-endpoints) for response fields and examples.

<!-- FNXC:Settings 2026-07-09-12:00: FN-7751 keeps FN-7713's collapsed mobile search row but moves the toggle inline beside the section dropdown so mobile Settings exposes one compact section/search control row; desktop/tablet keep the row always visible with no toggle. -->
On mobile, the search row starts collapsed behind a compact toggle icon beside the **Settings Section** dropdown to save vertical space; tap it to reveal the search input and tap again to hide it. An in-progress search query is preserved across collapse/expand. Desktop and tablet always show the search row with no toggle.

<!-- FNXC:SettingsDocs 2026-07-11-18:58: FN-7825 makes the Settings navigation rail read as one clean surface: no vertical content divider, single-line section rows, and a desktop/tablet resize handle with browser-local width persistence. Mobile remains the stacked section picker. -->
On desktop and tablet, the Settings navigation rail has no hard divider between navigation and content; section rows stay on one line and use ellipsis for unusually long labels. Drag the thin handle between the navigation rail and content pane to widen or narrow the rail. Fusion remembers that width in browser storage and restores it for both the standalone Settings modal and embedded Settings page. Mobile keeps the stacked **Settings Section** picker and does not show the resize handle. Its native menu groups sections by the same topic headers as the desktop rail; paired scoped entries keep **Global** immediately before **Project**.

<!-- FNXC:SettingsDefaults 2026-08-08-06:23: FN-8831 confirms the canonical-default rule also covers visible, routing-inert compatibility inputs; a setting's runtime effect does not exempt its operator help from describing its schema default. -->
Every user-editable setting's help text (including a shared Settings help tip) states its own default value — for example “Default: 3.”, “Default: enabled.”, or “No default — unset (inherits the global setting).” for values that fall back to another scope. This includes visible compatibility inputs even when they no longer control runtime routing. Canonical default values come from `DEFAULT_GLOBAL_SETTINGS` / `DEFAULT_PROJECT_SETTINGS` in `packages/core/src/config/settings-schema.ts`; the dashboard copy never invents a number. A guard test (`settings-default-descriptions.test.tsx`) enforces that every surfaced setting states its default and that every `DEFAULT_SETTINGS` key is either documented or explicitly allowlisted as not surfaced in the Settings UI.

<!-- FNXC:SettingsAutoSaveDocs 2026-08-02-20:55: FN-8395 removes the ambiguous Settings Save affordance. Operators need the persistence timing and close guarantee documented where Settings behavior is introduced. -->
Settings form changes save automatically after a short pause. The footer no longer includes a **Save** button and closing Settings does not ask about unsaved changes: Close, Escape, and clicking outside the modal first flush any pending edit. The footer shows quiet **Saving…**, **Saved**, or save-failure status; correct the value and retry after a failure.

## Voice Input

**Settings → Voice Input** is visible in both Basic and Advanced settings. Voice mode is off by default; enabling it is an explicit project preference. The same section shows the locally managed Parakeet v3 model and lets an operator download or remove it. Its upstream `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` archive is about 465 MB and Fusion verifies its pinned SHA-256 before installing it; an unpinned or mismatched download is refused. Download progress is polled only while the model is downloading. The toggle becomes interactive only when the model is installed and Fusion can load the optional `sherpa-onnx-node` runtime. Fusion unwraps its CommonJS binding automatically, so an incompatible-runtime message indicates a genuinely broken addon. If Settings reports a missing module, platform runtime load failure, or incompatible runtime, repair the Fusion installation and use **Re-check runtime** to retry a previously failed runtime import without restarting. Node caches successfully resolved native modules, so a resolved-but-broken addon still requires a Fusion restart. When sherpa-onnx is unavailable, Settings preserves any saved enabled preference but presents voice mode as backend-enforced disabled with an explanation. If status cannot be determined, the section fails closed: voice mode stays disabled and model actions are not shown until status is available.

<!-- FNXC:VoiceInputDocs 2026-08-04-07:37: Voice dictation is a project-scoped capture session, so the operator guide must describe the selected-project boundary and teardown guarantees verified by the client-to-route regression. -->
When Voice Input is available, every microphone capture remains scoped to the dashboard's selected project: status, session creation, PCM transcription, finalization, and cleanup all use that project identity. The mic is shown only after that project's voice preference is enabled, the Parakeet model is installed, and the browser supports microphone and AudioWorklet capture. Unsupported browsers, denied microphone permission, unavailable runtime/model, and status failures show no microphone control.

Start dictation with the microphone beside any supported composer. Partial speech appears at the current caret or replaces the current selection; the final transcript replaces that preview without disturbing surrounding text or another composer's selection. Stop, a project change, closing a composer, and transcription errors immediately release browser capture resources and close the project's backend session. If transcription cannot finish, already-entered text remains intact and the mic returns to a safe idle/error state.

## Reset Settings

<!-- FNXC:SettingsResetDocs 2026-07-04-00:00: Reset Settings is a DESTRUCTIVE action. Document both choices, the scope-precision guarantee, and which sections are excluded so operators understand exactly what a reset does and does not touch before they click it.

FNXC:SettingsResetDocs 2026-07-12-00:00: FN-7880 shortens the mobile footer affordance to Reset to keep the Settings action row usable on small screens; desktop and tablet keep the full Reset Settings label while the confirmation choices remain identical. -->
The Settings footer includes a **Reset Settings** button, next to Import/Export, in both the Settings modal and the embedded Settings page. On mobile the same button is labeled **Reset** to preserve footer space; desktop and tablet keep **Reset Settings**. Selecting it opens a confirmation dialog with two destructive choices, plus Cancel:

- **Reset this menu ({{section}})** — resets only the settings owned by the currently active section, at that section's own scope (global or project). A global section (for example Appearance) writes the section's keys back to their canonical defaults. A project section (for example Merge) clears the section's keys back to their inherited/default value. No other section's settings are touched.
- **Reset all project settings** — resets every project-scoped setting for the current project back to its default/inherited value. This never touches global (cross-project) settings.

Both actions are irreversible; there is no undo after confirming. The dialog closes and the form refreshes to show the reset values immediately after a successful reset.

**Excluded sections.** Some sections are not a simple settings form and are intentionally excluded from **Reset this menu** (the button is disabled with an explanatory tooltip when one of these is the active section), because each already has its own dedicated management flow: **Secrets**, **MCP Servers** (global and project), **Plugins**, **Memory**, **Authentication**, **Prompts**, **CLI Agents**, and the **Hermes**/**OpenClaw**/**Paperclip** runtime sections. Runtime pages appear only when their runtime plugin is installed; an installed but disabled runtime stays visible so it can be inspected or re-enabled. Settings hides runtime pages while its installed-plugin list is loading or unavailable, then refreshes the navigation after plugin lifecycle changes while Settings remains open. **Reset all project settings** is unaffected by this exclusion list since it resets the underlying project settings values directly, not through any of those sections' own flows.

## Task Reset

<!-- FNXC:TaskResetDocs 2026-08-28-20:50: Task Reset is a destructive fresh-planning boundary. The guide must explain planning-lane resolution, regenerated original-request prompts, per-repository worktree and local-branch cleanup, retained history, fail-closed conflicts, recoverable retries, and atomic publication. -->
<!-- FNXC:TaskResetDocs 2026-08-29-02:30: FN-249 makes cancellation terminal, so this guide also promises that an in-flight result cannot restore failed-step or plan-approval state after Reset publishes the fresh card. -->
<!-- FNXC:TaskResetDocs 2026-09-09-14:48: Reset must show a single immediate pending submission, wait for durable cleanup and publication, then replace every local task surface with the complete confirmed row while retaining only strictly newer server events. -->

**Reset** is destructive and has no undo. It opens an editable dialog pre-filled with the current original description; confirming immediately changes the action to **Resetting…**, disables the dialog, and sends only one request. Fusion does not optimistically clear or move the task: the existing card remains authoritative until server-side cleanup and atomic publication succeed, and a failure leaves the dialog open for a safe retry. After confirmation, Board, desktop and compact List, Task Detail, docked views, and the project cache replace the old run with the complete fresh task; fields omitted from JSON because they were cleared do not survive, while a strictly newer server event still wins. Fusion then fences executor and planner work without waiting for a planner that needs the reset-held planning lock. It removes the task-owned standard worktree, or every task-owned worktree for a workspace task, and replaces the current `.fusion/tasks/<task-id>/PROMPT.md` plan with a bootstrap prompt containing the confirmed original request. A singular task owns its canonical ID-derived worktree path even if a prior reopen cleared the path or branch from the task row: a git-registered worktree at that path is recoverable and removed by Reset. For workspace tasks, Reset also removes the now-empty workspace task directory and clears workspace coordination leases and land intents before atomically returning the same task to the lane where a new idea starts: the workflow's **Planning/hold** lane on manual-intake boards, or its intake lane otherwise. The published task has no steps and no lifecycle status, so it appears as **Queued to plan** rather than as a revision. Reset also stops the current workflow run at its current node: the fresh card has no failed pre-merge step, no failure status, and no resurrected plan approval. A result write that was already in flight waits behind the reset publication transaction, then sees the fresh task and is refused instead of landing on it.

A stale self-owned session registration is reconciled only under the ordinary liveness and idle gates, then removal is retried once. A live planner, executor claim, foreign holder, unsafe path, an unregistered directory at the canonical path, or a non-canonical holder is reported as an actionable conflict for the affected repository or the workspace task directory itself; Reset never forces deletion over live work or publishes partial success. If a holder appears at the workspace task directory during repository cleanup, Fusion retains that directory and the current plan, reports incomplete cleanup, and does not publish fresh Planning state.

Reset deletes every Fusion-owned local branch of the task in each repository it touched, including foreach step branches, and proves each branch is absent before publishing. If another worktree still has one checked out, Reset reports a conflict naming the branch and holder and publishes nothing. Remove the holder and retry Reset; the retry remains valid even when a prior refusal happened after Reset had already removed the recorded worktree. Operator-supplied branches and shared-group merge targets are retained without blocking and named in the task log, so a shared-group member intentionally restarts against the group branch. Reset never deletes remote branches.

Reset retains the task ID, title, confirmed description, dependencies, workflow selection, comments, attachments, attachment-backed artifacts, operator-authored documents and their revisions, spec-lock history, commit associations, logs, and audit history. The discarded plan is replaced by the confirmed original-request prompt rather than left absent. Because local branches are deleted, a retained commit association can point to a commit that is no longer reachable. Reset clears the previous run's steps, size, pull-request information, token spend, step reports, workflow transition markers, agent-only documents, and run-produced planning, verification, merge, and artifact projections; held symbol locks are released as history. If cancellation, cleanup, seed-prompt publication, or task publication fails, Fusion reports incomplete cleanup and does not expose the task to Planning. Once publication commits, task-file and prompt reconciliation problems are repaired separately and do not turn the successful reset into a false failure.

When project or workflow policy requires manual plan approval, the task stops after planning in the workflow's intake or hold planning lane. The Board card is not covered by an overlay: instead of **Queued** or **Ready**, its status badge reads **Needs you** in blinking amber, and the card stays fully readable. Opening the card leads to Task Detail, where the banner carries the decision. Compact and table List layouts show the same **Needs you** badge plus an inline approval notice whose **Approve** works directly from the row without opening the task; when the card requires your personal, messaged approval, that notice offers **Review plan**, which opens the task record. Task Detail also keeps **Reject Plan** available to discard the plan and regenerate it. The blinking stops when the operating system requests reduced motion.

### Requiring your approval for one specific task

Next to the lightning-bolt Fast button, both Quick Entry and the New Task dialog have a person-with-a-check button. Turning it on means: **this card will not start work until you personally approve its plan.** It applies even when the project is set to auto-approve every plan, it applies to the card you are creating, and it changes no project setting.

Fast and this button are alternatives, not companions: turning one on turns the other off. Fast deliberately skips planning and plan review, so there would be no plan for you to validate — choosing your approval keeps the card on the ordinary planned route.

A marked card shows a person-with-a-check badge on the Board card and in both List layouts, so you can see at a glance which work is waiting on you. The badge label tells you where the card is: your approval is *required* while the plan is still being written and reviewed, *awaited* once the plan has passed its review and your decision is the only thing left, and *approved* once you have decided.

The order is fixed: the plan is written, Plan Review checks it, and only then are you asked. You are never asked to validate a plan the reviewer has not examined yet.

Open the task to decide. Under the plan you get one message box and two buttons:

- **Reject** sends the card back for a new plan, and your message goes to the planner. Use it when something is genuinely wrong with the plan. The rejected plan is kept as the starting point for the revision rather than thrown away, and the card stays where it is — it does not move backwards to intake.
- **Approve** starts the work, and your message is passed to the implementer as a note ("just watch out for X"). It is a note only: it does not modify the plan you just approved.

The message is optional for both decisions. You can type it in the banner or in the footer bar — they share one draft, so it does not matter which you use. If a decision fails, your message is kept so you never have to retype it.

A decision always applies to the exact plan you were shown. If the plan was re-reviewed while your tab was open, the decision is refused and you are asked to reload, rather than silently approving something you did not read. After a rejection, the new plan needs a fresh decision — even if it comes back looking identical. On Board and List rows, a marked card's notice opens the task instead of approving directly, because the decision needs your message and the plan you actually saw.

If the workflow you pick has no plan review at all, the combination is refused at creation instead of creating a card that could never be approved.

## Task Recovery

Every live card, including an intake or planning card, offers **Retry**, **Reset**, and **Delete**. **Retry** stays in the current column: in planning it rebuilds the plan from the original request; during work it asks whether to keep the work already produced; during review it discards review verdicts and reviews the produced work again.

<!--
FNXC:ColumnRestart 2026-09-17-09:16:
FN-499 adds the operator choice to Retry during work. The default must stay destructive so nothing
changes for operators who simply confirm, or who globally skipped confirmations.
-->
During work only, the Retry confirmation offers a **Keep the work already produced** checkbox. It is unchecked by default: confirming without ticking it behaves exactly as before, discarding the worktree, branch, and step progress and restarting from the first step. Ticking it keeps the worktree, branch, and finished steps and replays only the step that was running. Planning and review Retry do not offer this choice, and operators who disabled confirmations keep the destructive restart. Workspace retries use the same in-place behavior while preserving every per-repository worktree and landing record, including repositories already delivered. **Reset** opens the task's original description in an editable dialog, then starts the task over from the confirmed text while discarding plan, work, and reviews. **Delete** removes the task.

Retry refuses workflow terminal columns, active merges across the whole merge pipeline (including its review phase), and columns without a workflow entry node of their own. An orphaned stale merge stamp remains retryable after Fusion confirms that no live merger owns it. A retry interrupted during publication leaves the card paused with `restart-stage-publishing`; this durable safety fence is retained for compatibility, and selecting **Retry** again safely resumes publication.

## Error screen technical details

<!--
FNXC:ErrorBoundaryDiagnostics 2026-09-17-19:34:
FN-515: a minified bundle shows only "Minified React Error #185" and the stacks go to the browser
console, which an operator on a phone does not have. The fallback therefore carries its own bounded,
local, copyable report. Document what it contains and what it deliberately does not.
-->
When a view, a window, or the whole dashboard fails, the recovery screen keeps **Retry** and **Reload page** and adds a collapsible **Technical details** section with a **Copy details** action. Everything stays on your device.

The report contains the error name and message, the JavaScript stack, React's component stack, which boundary caught the error (root, page, or section), the time, the build identifier of the running bundle, the browser user agent, and the layout/visual viewport sizes. Fields the browser did not provide are shown as `(unavailable)` rather than omitted silently, and a very long report is shortened with a visible notice so the screen stays usable.

When the error is React's render-loop error (`#185`), the section adds a short plain-language explanation and a link to <https://react.dev/errors/185>. Fusion does not guess which component caused it; the stacks in the report are the evidence.

Limits worth knowing:

- Nothing is uploaded and nothing is reported automatically. Copying is an explicit action.
- The report never includes the page address, page content, cookies, browser storage, your configuration, conversation transcripts, or task titles.
- URLs found inside the message or the stacks keep only their origin and path; credentials, query strings, and fragments are removed, and obvious `token`/`password`/`authorization` values plus `Bearer` credentials are masked. This is a best-effort precaution, not a guarantee that an arbitrary third-party message contains no sensitive text — read the report before sharing it.
- Source maps stay private, so stacks refer to the published bundle. Quote the build identifier when you report a problem.
- If copying is refused by the browser (common in non-secure contexts), the screen says so and the report stays selectable so you can copy it by hand.
- Selecting **Retry** discards the report. A later reply from the clipboard cannot bring an old report back.

## Keyboard shortcuts

<!--
FNXC:DashboardShortcuts 2026-07-04-00:00:
Dashboard keyboard shortcuts are configurable global operator preferences. The docs must state the defaults, editable-field safety guard, duplicate/invalid save behavior, and one-popup Escape semantics so operators know why Space/Terminal/Escape act differently in text fields than on the board.

FNXC:DashboardShortcuts 2026-07-04-12:00:
FN-7553 promotes shortcuts to a dedicated Settings section (Keyboard Shortcuts, moved out of General), adds a press-to-record capture control, and adds four more configurable actions (Open Files, Open Settings, Open Command Center, New Task) grouped into categories. The docs must state the new location, the capture control's record/manual/clear/Escape-cancels behavior, and the full action list with defaults so operators can find and rebind every shortcut, not just the original two.

FNXC:DashboardShortcuts 2026-09-16-02:27:
FN-441 adds Open Chat List. Its host depends on the measured breakpoint and it reuses those existing owners rather than adding a second chat host, so the docs must state which surface opens where and that a second press closes it.

FNXC:DashboardShortcuts 2026-09-16-19:44:
FN-468 moves that host boundary to 1024px: the full-screen chat drawer covers the whole mobile interface (phone AND tablet) because the wide footer — and therefore its conversation popover — no longer exists below 1024px.
-->
Open **Settings → Keyboard Shortcuts** (its own dedicated section, no longer under General) to configure dashboard-wide shortcut bindings. Actions are grouped by category:

- **Communication:** Hide or restore dashboard windows (blank by default), Open Chat List (`Ctrl+Shift+L`)
- **Workspace:** Terminal (<kbd>Ctrl+`</kbd>), Open Files (`Ctrl+E`)
- **Navigation:** Open Command Center (`Ctrl+K`), Open Settings (`Ctrl+,`)
- **Tasks:** New Task (`Ctrl+Shift+N`)

Each row uses a press-to-record capture control: click **Record**, then press the key combination you want — it fills in automatically. Manual typing remains supported as a fallback. **Clear** disables that action (blank = disabled). While recording, pressing `Escape` cancels the recording instead of binding Escape, so Escape stays permanently reserved for the dashboard's topmost-popup-close shortcut; the capture control also never leaks the recorded keystroke to the global shortcut listener while it is focused/recording.

Leave a shortcut field blank to disable that action. The **Hide or restore dashboard windows** (`toggleModalVisibility`) binding is blank by default, so it never intercepts typing until you assign it. Settings validates each shortcut before saving: unsupported key strings are marked invalid, and duplicate populated shortcuts across any two actions (for example binding both window visibility and Open Command Center to `Ctrl+K`) are rejected until one binding changes or is disabled.

Shortcut handling is intentionally guarded. Fusion ignores global shortcuts while focus is inside inputs, textareas, selects, contenteditable editors, chat composers, task fields, Settings fields, search boxes, and terminal input, so typing Space or shortcut letters never opens another surface unexpectedly. Hardware keyboards on desktop, tablet, and mobile use the same bindings when focus is on the page/body. Open Files, Open Settings, Open Command Center, and New Task each reuse the dashboard's existing navigation entry points (the same handlers as their header/sidebar buttons), so no shortcut opens a second/duplicate destination.

<!-- FNXC:DashboardShortcuts 2026-07-16-00:00: FN-8069 requires every configured dashboard shortcut to toggle its interface; a re-press dismisses modal surfaces or restores the active view that preceded Settings or Command Center (Runfusion/Fusion#2118). -->
<!-- FNXC:ModalVisibilityDocs 2026-09-14-10:42: FN-390 replaces the chat-only visibility action with one dashboard-wide, opt-in hide/restore command that preserves each managed window's mounted state. -->
The far-right footer control and the optional `toggleModalVisibility` shortcut hide every currently visible managed dashboard window together. Activating either control again restores exactly that captured set with its prior content, geometry, stacking order, scroll position, and draft state. Windows opened after a hide are not added to the captured set, and windows that were already closed or hidden are not restored. Blocking confirmations, authentication prompts, and other surfaces that require an immediate decision are excluded and remain visible. The footer control is available even when there is nothing to hide; in that state it is a harmless no-op.

Terminal, Files, Settings, Command Center, and New Task retain their ordinary open/close toggle behavior. For Settings and Command Center, the second press returns to the view that was active before the surface opened.

**Open Chat List** (`Ctrl+Shift+L`) opens the conversation list on whichever surface your screen size already uses: the full-screen chat drawer below 1024 pixels, phones and tablets alike, and the footer conversation popover — the same one the bottom bar's chat control opens, anchored to that same control — from 1024 pixels up. Pressing it again closes the list and returns you to what you were looking at. The shortcut does nothing when no project is open, and like every other shortcut it is ignored while you are typing in a field, editor, chat composer, or terminal. Rebind or blank it in **Settings → Keyboard Shortcuts** like any other action.

Press `Escape` to close the current/topmost visible dashboard popup. Popped-out task and chat windows close before fixed app modals such as Terminal, Settings, Files, or Task Detail, and only one surface closes per key press. A window hidden by the dashboard-wide visibility control is never an Escape target. Nested editors and menus that already handle Escape keep first ownership by preventing the global handler.

<!-- FNXC:ChatFindDocs 2026-08-21-16:29: FN-110 gives the active visible Chat host contextual Find ownership without adding a configurable dashboard shortcut. -->
### Thinking traces

Thinking panes split titled reasoning traces with captured bodies into independently expandable sections, with **Collapse all** and **Expand all** controls. Responses-family models now request titled sections with their reasoning bodies. A titles-only trace can still arrive from a provider Fusion cannot configure; those headings stay inline in the flowing trace instead of becoming empty collapsible rows, and the defensive empty-state label appears at most once per section. **Raw trace** shows the original unsectioned capture and switches back with **Sectioned trace**; use it to diagnose a provider-side titles-only payload. The workflow live-log console remains raw and unsectioned by design. The same behavior applies while Planning Mode, Mission Interview, and Milestone/Slice Interview stream a generation.

### Chat scrolling

<!-- FNXC:ChatScrollAnchorDocs 2026-09-06-07:42: FN-302 preserves the reader’s viewport on send and makes manual scrolling the immediate authority over automatic bottom following. -->
<!-- FNXC:ChatScrollAnchorDocs 2026-09-07-21:35: FN-313 opens and restores every conversation at its newest rendered message, including transcripts that arrive after the detail pane mounts. -->
<!-- FNXC:ChatScrollAnchorDocs 2026-09-08-20:49: FN-316 keeps the conversation list’s start alignment and manual position independent from the selected transcript’s latest-message alignment. -->
The conversation list opens at its beginning and keeps its own scroll position while entering or leaving a thread. Opening or restoring a conversation places only that thread’s newest message in view as soon as the transcript renders. When a conversation is already at its latest message, Chat follows new messages and every in-progress response update at the bottom. Sending while reading earlier messages preserves that exact reading position instead. Scrolling upward manually stops automatic following immediately; return to the bottom threshold or choose **Latest** to resume it.

<!-- FNXC:StickyBottomScrollDocs 2026-09-14-20:19: FN-398 makes the user gesture the sole authority over bottom following. The proximity threshold is a REARM condition only, never a reason to keep following through a gesture. -->
#### The gesture always wins

Every surface that follows its latest line — Direct Chat, task Chat, Planner Chat, the agent log, the dev-server log, and live workflow output — uses the same rule: **any scroll gesture you make releases automatic following immediately.** A wheel notch, a finger pan, a scrollbar drag, a keyboard navigation key, and a browser find-in-page all count, however small the movement. You no longer have to travel a minimum distance to be heard.

The proximity threshold now only decides when following comes **back**: it resumes when you scroll back down to the bottom of the list, when you use the jump-to-latest control, or when you open a different conversation. Growing content never resumes it on your behalf.

A gesture that cannot move the viewport — residual momentum at an already-clamped bottom, a wheel consumed by a nested code block, or a list too short to scroll — deliberately does **not** release following, so you are never left visually at the bottom yet silently unfollowed.

### Chat Find

In an active visible Chat list, <kbd>Ctrl+F</kbd> or <kbd>Cmd+F</kbd> focuses the existing conversation search without changing its query. In a selected Direct conversation, Room, or native/hybrid CLI transcript, the same chord opens **Find in conversation**. Type a literal case-insensitive query, use Enter (Shift+Enter for previous) or the previous/next controls to move through matching message rows, and use Escape or Close search to dismiss it. Only the activated full, floating, or docked Chat host owns the chord; raw/generic CLI terminals and nested dialogs keep their own browser or terminal behavior.

### Direct conversation switcher

When a Direct conversation is open, click its thread title or activate it with the keyboard to open the conversation switcher. The menu opens below the thread header in full, mobile, floating, and compact docked Chat surfaces. Pick a listed conversation to switch in place, or choose **All conversations** to return to the full list. The menu shows pinned conversations first and then recent conversations, with up to 12 entries; the current conversation is marked. Room titles remain plain text and do not open this switcher.

<!-- FNXC:ModalGeometryPersistenceDocs 2026-07-16-00:40: Full-screen mobile FloatingWindow sheets must preserve, rather than overwrite, the movable desktop geometry record so a later desktop reopen restores the user's chosen location and size. -->
<!-- FNXC:GitHubImport 2026-08-02-02:51: FN-8722 confirms that standalone GitHub Import also uses the canonical width-or-height sheet contract, so the operator guide must not describe short-sheet preservation as Artifact Gallery-only. -->
<!-- FNXC:ChatWindowsDocs 2026-08-27-09:23: FN-193 keeps simultaneous secondary chat windows visibly separate without allowing cascade presentation geometry to overwrite the remembered desktop base. -->
<!-- FNXC:ModalShellBoundsDocs 2026-09-14-10:42: FN-390 derives floating-window limits from the live dashboard shell instead of reserving decorative viewport padding. -->
<!-- FNXC:WindowSnappingDocs 2026-09-14-21:10: FN-394 replaces remembered window geometry with independent openings plus edge snapping shared by every dashboard window. -->
Dashboard windows move and resize inside the work area: the rectangle between the header and the active footer, minus the side panels that are actually open. Windows may touch those edges without artificial padding but never cover the header, footer, left navigation, or right sidebar. The limits update as soon as a panel opens, closes, or is resized, and a window already open is fitted back into the new area.

<!-- FNXC:ChatWindowsDocs 2026-09-14-23:48: FN-396 makes a detached conversation's window title follow a rename live, because the opening snapshot is the request that opened the window, not the conversation's durable identity. -->
**A conversation window keeps its current name.** Renaming a conversation immediately updates the title and accessible name of every window showing it, including a detached conversation window. You no longer have to close and reopen the window to see the new name, and the rename never moves, raises, or reloads the window or its draft.

<!-- FNXC:ChatWindowsDocs 2026-09-16-05:33: FN-455 extends that live convergence to the name Fusion generates itself after the first message, on the model path and the CLI-agent path alike. -->
<!-- FNXC:ChatWindowsDocs 2026-09-17-11:42: FN-505 makes that naming two-stage so the name exists before the assistant replies, and states the rule that a manual rename is never overwritten. -->
**A new conversation names itself.** Fusion names the conversation in two stages. As soon as you send your first message, the conversation takes a short readable name from that message — before the assistant has written a single word. Fusion then quietly replaces it, in the background, with a shorter name written by the AI; your reply never waits for that. Both names appear on their own in the open window header, its accessible name, and the conversation list — without closing, reopening, or reloading anything. Conversations driven by a command-line agent, and first messages that mention an agent, are named the same way. If the AI name cannot be produced, the conversation simply keeps the name taken from your first message instead of staying untitled. **A name you set yourself is final:** renaming a conversation while the automatic name is still being written is never overwritten. Only the name catches up: the reply being written, its progress, and the message thread are never replayed or rolled back.

<!-- FNXC:WindowSnappingDocs 2026-09-16-05:45: FN-456 normalizes every window's opening shape to one landscape ratio (width = 1.43 x height) so modals stop opening at arbitrary shapes, while full-work-area views and every later resize stay untouched. -->
<!-- FNXC:WindowSnappingDocs 2026-09-16-07:38: FN-460 ("augmente la taille de 20%. même ratio") enlarges that opening rectangle by 20% on both axes, so the shape is unchanged and only the size grows; full views and every post-opening action stay untouched. -->
**Every window opens at the same shape, 20% larger.** A newly opened window always uses the same landscape shape: its width is about 1.43 times its height, centred in the work area. That opening rectangle is now 20% larger than before on both sides at once, so windows open bigger without changing shape. Every dialog and window therefore opens looking like the others instead of each one having its own arbitrary proportions. **Full views are the exception**: a view meant to fill the work area — the Git Manager opened from the "more" menu, and Planning mode — still opens filling the space as before, and is never shrunk or cropped to that shape. Once a window is open you are completely free: resize it, move it, dock it to a half or to the whole work area — none of that is constrained by the opening shape. On a small screen, or for a window with an imposed minimum size, the available space still has the last word.

**Every window opens the same way.** A newly opened window always uses its own standard size, centred in the work area. It is never influenced by another open window, by a window you moved or resized earlier, by an occupied edge, or by a size used in a previous session — sizes and positions are no longer remembered between openings. The only exception is readability: if a window that is still untouched is already sitting in the centre, the next window opens with a small offset so the two remain distinguishable. That offset only ever moves a window; it never shrinks one, and it disappears as soon as you really move, resize, or dock a window. Closing a window and opening it again returns to the usual size.

<!-- FNXC:WindowSnappingDocs 2026-09-15-13:41: FN-418 caps the standard opening height at a proportion of the live work area, because a fixed-pixel opening height was simply clamped to that area and filled it on ordinary laptop viewports. -->
<!-- FNXC:WindowSnappingDocs 2026-09-16-05:45: FN-456 keeps this proportional height cap, but for ordinary windows it now applies through the shared opening shape, reducing both sides together; full views keep the height-only cap. -->
<!-- FNXC:WindowSnappingDocs 2026-09-16-07:38: FN-460 carries the proportional cap by the same 20% factor, because on a real laptop work area the cap was the binding constraint and would otherwise have absorbed the whole enlargement; the live work area remains a hard bound. -->
**A window opens at about three quarters of the work-area height.** The standard opening height stays capped at roughly 74% of the height between the header and the active footer, so a window still looks like a window rather than a full screen and the board stays visible behind it. That cap was about 62% before: it is raised by the same 20% as the opening size, which is what makes the larger opening actually visible on an ordinary laptop. For an ordinary window the cap now applies through the shared opening shape: both sides shrink together, so the window stays the same shape rather than becoming a flattened band. For a full view the cap applies to the height alone, exactly as before, and its width is left intact. A window whose own minimum is taller than that cap still opens at its minimum, and a work area shorter than the window always has the last word. Resizing by hand, docking to a half or to the top (which still fills the whole work area), and mobile full-screen sheets are unaffected: dock a window to the top whenever you want it to fill the area as before.

<!-- FNXC:WindowSnappingDocs 2026-09-15-04:01: FN-401 arms snapping from the dragged window's own edge instead of the cursor and paints the preview above the board and every window. -->
<!-- FNXC:WindowSnappingDocs 2026-09-15-14:07: FN-422 makes undocking omnidirectional: requiring a downward drag made a full-screen or column window look stuck for every other direction, so any drag past the click threshold now releases it. -->
**Snapping to the edges.** It is the **window** that decides, not the cursor: as soon as the window's own left or right edge touches the matching edge of the work area, Fusion offers the corresponding half, full height. When its top edge touches the top, Fusion offers the whole work area (not the browser full screen). Simply keep dragging past the edge — the window stops against it and the proposal appears, wherever your cursor happens to be. A preview shows the target area and the placement is applied when you release; in a corner Fusion offers a quarter (see below). The preview is always visible: it is painted above the board and above every open window. A window as wide as the work area is already equivalent to the filled area, so no half is proposed for it. Halves are always exactly half of the CURRENT work area: opening or closing the sidebar immediately re-splits the docked windows, and the shell is never closed for you. A docked window shows no resize handles.

<!-- FNXC:WindowSnappingDocs 2026-09-16-18:31: FN-469 adds the bottom band to the shared snap contract, so every window — conversations included — can dock along the bottom, and the pinned terminal now leaves its dock under the pointer instead of reopening centred. -->
<!-- FNXC:WindowSnappingDocs 2026-09-17-04:51: FN-487 makes every bottom-docked window reorganize the application like the pinned terminal, instead of covering the lower half of the board. -->
**Docking along the bottom.** Bring a window's **bottom** edge against the bottom of the work area and Fusion offers a full-width band over the lower half. This works for every window, including a detached conversation, and it is released by the same gesture as any other dock. A bottom corner now offers a quarter rather than the band or a half (see below). A window docked there **reorganizes** the application instead of covering it: the rest of the page is compressed upwards, so the board columns stay fully visible and usable above the docked window, exactly as they do with the terminal pinned at the bottom. The space is handed back as soon as you undock, close, or hide that window.

<!-- FNXC:WindowSnappingDocs 2026-09-17-07:21: FN-493 adds the four corner quadrants to the shared snap contract so four windows, one per corner, form a 2x2 grid; it deliberately replaces the former "the top wins in a corner" and "the side wins in a bottom corner" arbitrations, which made a quarter unreachable. -->
**Docking into a corner (2x2 grid).** Bring a window into a **corner** of the work area — one side edge and the top or bottom edge against their walls at the same time — and Fusion offers exactly a **quarter** of that area. Repeat it in the four corners and you obtain a perfectly joined 2x2 grid: no gap, no overlap. It works for every window, on desktop and on a touch tablet, and a quarter is released by exactly the same drag as any other dock.

Everything else is unchanged. The **top** edge alone still fills the whole work area, a **side** edge alone still gives the corresponding half over the full height, and the **bottom** edge alone still gives the full-width band. A window as tall as the work area touches the top *and* the bottom at once, so it is never in a corner: pushed against a side wall it still fills the whole work area, exactly as before. A window as wide as the work area is likewise never in a corner. Nothing is exclusive here either: two windows dropped in the same corner share the same quarter. A quarter covers only half the width, so — unlike the full-width band — it does not reorganize the page: it overlays the board like a half or a filled work area. A detached terminal follows the same rule: dropped in a bottom corner it stays a floating quarter and is not pinned back below the board.

<!-- FNXC:TerminalLayoutDocs 2026-09-16-18:31: FN-469 hands the live drag to the detached terminal window instead of ending the gesture, which is what produced the reported centred window. -->
**Pulling the pinned terminal out.** Drag the title bar of the terminal pinned at the bottom in any direction and it leaves its dock **under your pointer**, keeping the same relative grip along the bar, and it keeps following your cursor until you release — there is no centred window appearing elsewhere and no need to start the movement again. Dropping it back onto the bottom bar pins it again exactly as before.

**Getting out of a docked position.** Start moving a docked window in **any direction** — up, down, left, right, or diagonally — and it immediately returns to the size and shape it had before you docked it, following the cursor; its handles come back. This is also the way out of the filled work area, where no edge can be reached any more — the window does not need to be able to move for the gesture to work. A simple click on the header releases nothing: the movement has to be a real drag. The same drag can then continue towards another edge and dock there straight away. A window that is still docked proposes nothing on its own, since it is pinned and has no free edge to offer. Going from left to right and then to the top never replaces that remembered shape. Nothing is exclusive: several windows can share the same half, several can fill the work area, and a newly opened window always appears in front of them at its usual size.

<!-- FNXC:ChatWindowsDocs 2026-09-15-04:01: FN-401 aligns a detached conversation's opening size with a task window, because the previous 980px chat window dwarfed every window beside it. -->
**A conversation window opens at the same size as a task window.** A detached conversation and a task window share one standard opening size, so a conversation no longer opens noticeably larger than everything around it. A conversation can still be made narrower than a task window by hand, and it remains usable once docked into a half-width column.

On mobile, Chat uses a navigation drawer and other project utilities use their responsive drawer or sheet presentation; these presentations have no snapping, no handles, and no movable geometry, because a half-width column would be unusable there. Returning to a desktop viewport restores the window's floating shape for the session.

<!-- FNXC:DialogStackingDocs 2026-09-14-17:46: FN-392 restores child-dialog dominance, purely visual hide/show, and project-wide task windows. -->
### Window stacking, hiding, and task windows

A dialog opened from inside a window — **Refine**, **Reset**, **New Chat**, the duplicate-task warning — always appears above the window that opened it, on desktop, tablet, and phone. Interacting inside that dialog keeps it in front; closing it dismisses only the dialog and leaves its parent window open and in place.

The hide/show control is purely visual. Hiding makes every open window inert and invisible without closing, unmounting, or moving it, so drafts, scroll positions, running conversations, and open terminals are untouched. Showing them again restores exactly the same windows in exactly the same front-to-back order; nothing is re-created and no window silently jumps to the front. A real click or keyboard focus afterwards raises a window as usual.

A task opens **one** window for the whole project. That window stays available while you move between Board, List, Planning, Agents, Chat, Settings, and plugin views — it is never hidden or duplicated by navigation. Opening the same task again from another view brings its existing window forward with a refreshed snapshot instead of creating a second copy. Switching project closes the previous project's task windows, and phones keep using the task-detail drawer.

<!-- FNXC:TaskModalResizeDocs 2026-07-26-15:55: Known touch tablets at the 768px CSS boundary use the shared physical-screen-aware viewport classification, so documentation must distinguish their resize contract from true phones that share the CSS media query. Tablet target expansion is hit-area-only and must never add a visible panel inset. -->
### Dashboard modal inventory

The grep-backed [dashboard modal inventory](./dashboard-modal-inventory.md) is the canonical migration plan for every dashboard modal surface, including explicit static-dialog opt-outs.

### Task Detail tabs and content

<!-- FNXC:TaskDetailDefinition 2026-09-13-11:59: Task Detail keeps the description as the primary visible definition instead of repeating the editable title in every host header. Shared compact action classes and ModalCloseButton keep edit, pop-out, lifecycle actions, and modal dismissal aligned. -->
Task Detail uses the same four-zone shell in its modal, Board panel, List split view, right dock, mobile drawer, and pop-out: header, tab strip, active content, then an optional footer owned by that tab. The shared header shows the task ID, lifecycle state, and actions without repeating the task title. Edit, pop-out, lifecycle actions, and the canonical modal close control use the same compact icon-button geometry; every modal close cross is rendered by `ModalCloseButton`, while mobile Back remains navigation rather than dismissal chrome. Task Detail has no list-to-detail navigation of its own, so in phone drawer presentation it shows no Back arrow at all and is dismissed by the drawer handle, the backdrop, or Escape; on a phone without drawer presentation it keeps that single Back control as its only visible way out. **Chat** and **Activity → Live** keep the transcript as the scrollable content and pin their composer in the footer; read-only destinations such as Activity Feed and Raw do not reserve an empty footer.

The one-row tab strip presents destinations as a tokenized pill group. When it overflows, drag it horizontally with the left mouse button to scroll without using the wheel. The gesture starts only after a clear horizontal movement, so a stationary click still selects its tab or opens the Activity menu, while a completed pan does neither. Tab order always remains canonical across built-in, conditional, and plugin destinations. Touch and pen input keep the browser's native horizontal pan and tap behavior.

<!-- FNXC:TaskDetailDefinition 2026-09-14-20:55: FN-391 reorders Definition around progress and the product outcome, removes the editable title field and the manual Summarize action, and restricts description editing to manual intake. -->
<!-- FNXC:TaskDetailDefinition 2026-09-15-16:02: FN-424 adds the direct Before → After section, gives each definition block a padded card, turns the step disclosure into a chevron beside the progress bar, and removes Copy / Open PROMPT.md / Edit from the plan sub-view. -->
**Definition** is read top to bottom, each part presented as its own padded card:

1. **Progress** — heading, `N/M completed` counter and summary bar are always visible. The per-step list is **collapsed by default** behind a discreet chevron placed to the right of the progress bar, on the bar's own row (a real button with `aria-expanded`/`aria-controls` and a **Show steps** / **Hide steps** accessible name, so keyboard and screen-reader users get the same affordance). Expanding it reveals the labeled list identifying every implementation and workflow step, including pending, running, completed, skipped, advisory, and failed states. Your choice survives live refreshes of the same task and resets to collapsed only when a different task is opened. A task with no steps shows no control at all.
2. **Description** — the operator's original description, read-only, inside a height-bounded region that scrolls internally so a long description cannot push the rest of the view off screen. That bound is deliberately short (half its former height) so **What this delivers** and **Before → After** stay visible without a long scroll. The region does not trap the scroll: once its content is exhausted, continued wheel or touch scrolling chains to the surrounding task body instead of stopping dead. It is focusable, so it can be reached and scrolled from the keyboard.
3. **What this delivers** — the plan's outcome in plain product language, with **Read plan** on the same row. Fusion selects this from the plan the task already has: the `## What This Delivers` section, falling back to `## Before → After Transformation` for older plans. The technical `## Mission` is deliberately never used here, and no AI call is made to render it. When neither section exists, a short placeholder points to **Read plan**.
4. **Before → After** — the plan's `## Before → After Transformation` section, shown directly rather than only inside the full plan. It is omitted entirely when the plan has no such section, and it is never duplicated when that same body already served as the legacy fallback in **What this delivers**.

The task title is not editable from Task Detail: it is written once at creation by the automatic title policy, or supplied explicitly by an API/import/integration writer. The **Summarize** action has been removed with the title field.

The **description** can be edited only while the task is still waiting in a **manual intake** column (Ideas, or any renamed intake lane that does not auto-triage) — after release, a plan has been written from that exact text. Opening **Edit task** in later pre-implementation lanes still exposes the other settings (dependencies, branches, models, workflow steps); the description shows as read-only, stays selectable and copyable, and offers no dictation, refinement, or auto-save. If a task leaves manual intake while an edit is pending, the unsent auto-save is cancelled and the authoritative description is restored.

**Read plan** opens the complete task `PROMPT.md` inside Task Detail, temporarily replacing the tab strip and Definition content; **Back to definition** restores the prior surface. The plan view is **read-only**: **Back to definition** is its only control, and the former **Copy**, **Open PROMPT.md** and **Edit** actions (together with the inline specification editor and its *Ask AI to Revise* composer) have been removed. Approval/rejection, loading, and empty-plan behavior are unchanged, and the view automatically closes when the host switches to another task.

### Task modal resizing on tablets

Task Detail and New Task remain resizable on known touch tablets, including a 768px-wide tablet viewport. Task Detail exposes its accessible bottom-right resize grip; New Task keeps its draggable header and edge/corner resize controls. On that tablet-touch surface, the painted control remains compact but its explicit resize hit target is at least 44px, sits outside the panel content, and owns touch gestures with pointer capture. The touch target is hit-area-only: task-modal headers and bodies retain desktop density without a visible tablet padding band. Their geometry stays within the viewport and is restored from browser storage on later tablet or desktop opens. True phones, narrow folded panes, and desktop coarse-pointer devices do not receive the enlarged target: phones remain full-screen sheets and desktop preserves cursor-sized resize chrome.

<!-- FNXC:ModalTouchGeometryDocs 2026-07-26-15:55: FloatingWindow is shared by task and utility surfaces. Task-detail density overrides are class-scoped and a classless browser fixture control proves the generic 44px geometry remains unchanged. -->
### Shared floating-window touch contract

Use `FloatingWindow` for a moveable and resizable dashboard surface rather than adding per-modal pointer code. On known tablet touch viewports it uses `isTabletTouchViewport`, applies `data-resize-hit-target="true"` to the drag handle and all eight edge/corner handles, and expands only their hit areas to the shared 44px target without thickening painted borders or covering content/footer controls. Task-detail uses an out-of-flow drag target so its hit area does not add painted header padding; this density adjustment is scoped to task modals, while a classless browser-fixture control verifies that generic FloatingWindow geometry stays unchanged. Never gate these controls on bare `(pointer: coarse)`: desktop hybrids keep desktop geometry. Phone full-screen sheets are strictly **below 768px** (`max-width: 767.98px`); a 768px viewport is tablet-class, so JS geometry and CSS must preserve active targets there.

<!-- FNXC:ModalTouchGeometryDocs 2026-07-26-13:50: Core/workflow modal migrations use stable window keys so one shared primitive owns drag, resize, clamping, stacking, and persisted geometry. -->

<!-- FNXC:WindowSnappingDocs 2026-09-14-21:10: FN-394 deleted durable window geometry; no host may declare a geometry key, and openings are standard-sized, centred, and cascade-separated by the shared window manager. -->
Core/workflow FloatingWindow modals — `automation` (Scheduled Tasks), `settings`, `git-manager`, `planning-mode`, `changes-diff`, `model-onboarding`, `activity-log`, `scripts`, `add-node`, `connect-node`, `node-detail`, `workflow-add-step`, `group-task`, and `create-room` — declare **no** geometry key. Since FN-394 no window reads or writes a stored rectangle: each opening uses the host's own `defaultSize`, centred in the live work area, with separation supplied by the shared pristine-window cascade. Historical `floating-window:*`, `fusion:*-modal-size`, and similar records are simply ignored and left untouched in browser storage. Phone and short (`max-height: 480px`) sheet viewports additionally expose no drag, resize, or snap affordance at all.

<!-- FNXC:ModalTouchGeometryDocs 2026-07-26-16:35: FN-8607 requires every non-trivial modal to share the FloatingWindow contract so tablet touch users receive one consistent move/resize implementation. -->

All non-trivial modals must use `FloatingWindow` with `hideHeader`, a modal-owned `dragHandleSelector`, a class name, sensible `defaultSize`/`minSize`, `suspendGeometryPersistenceOnMobile`, and `suspendGeometryPersistenceOnShortViewport`. They must NOT declare a geometry key: durable window geometry was removed in FN-394. Desktop drag and eight-direction resize remain active; only known tablet touch viewports (768px–1024px) enlarge active targets to at least 44px. Exactly 768px is tablet-class and persists geometry; 767px and below are full-screen sheets. A viewport at `max-height: 480px` is also a full-screen sheet regardless of width and never reads or writes geometry.

`closeOnOutsidePointerDown` defaults to **off**. A modal that previously dismissed on its backdrop must pass it explicitly, while first-run/blocking flows must omit it. The `FloatingWindow` panel is the sole `role="dialog"`/`aria-modal` owner; hosted content must not nest a second dialog. Its backdrop remains a real opt-in outside-pointer dismissal target, while nested dialogs and body-portaled menus are safe surfaces. Preserve the existing focus, Escape, ARIA, close guard, and scroll-container behavior when hosting content. `AgentListModal`, `AgentImportModal`, `AgentGenerationModal`, `AgentOnboardingModal`, `ExperimentalAgentOnboardingModal`, `SetupWizardModal`, `NativeShellOnboardingModal`, `DockerNodeOnboardingModal`, `MailboxModal`, and `MilestoneSliceInterviewModal` use this contract. `modalFloatingWindowContract.test.tsx` and `migratedModalFixtures.tsx` ratchet their host, geometry, and dismissal configuration.

<!-- FNXC:WindowSnappingDocs 2026-09-14-22:36: FN-394 removes the desktop static opt-out for dashboard dialogs: every one of them now opens in the shared window with the same centred standard size, snapping, and restore. -->
Since FN-394 the previously static dashboard dialogs are hosted by `FloatingWindow` too: `ConfirmDialog`, `ProviderLoginDialog`, `AgentErrorDetailsModal`, `ModelSelectionModal`, `ReportModal`, `ResearchTaskActionModal`, `SettingsSyncConflictModal`, `StashConflictModal`, `NewAgentDialog`, `NativeShellConnectionManager`, the Missions manager dialog, the expanded prompt view of `AgentPromptsManager`, the branch-group promotion confirmation, the narrow-dock dev-server preview, the reliability reset confirmation, both `SecretsView` dialogs, the stash-recovery diff, the non-anchored `UsageIndicator` dialog, the expanded workflow output, workflow creation, the expanded workflow prompt editor, and the model pricing table. Hosting is presentational only: a blocking confirmation stays blocking, a sign-in keeps its own focus boundary and close guards, and snapping or moving a window never confirms or abandons anything. Anchored popovers, embedded views, docked panels, and menus remain what they are and are not turned into windows.

<!-- FNXC:ModalTouchGeometryDocs 2026-07-26-19:25: FN-8621 closes the complex-modal batch by making FloatingWindow the canonical non-trivial modal host while publishing the narrow embedded and docked presentations that legitimately retain their owners. -->
### Supported presentation exceptions

Every non-trivial dashboard modal is hosted by `FloatingWindow`. It uses the physical-screen-aware `isTabletTouchViewport` contract: phones are **≤767.98px**, tablet-class touch is **≥768px plus touch**, and delegated drag plus all resize hit areas carry `data-resize-hit-target="true"` with an effective target of at least **44px**. This is hit-area-only and never a bare `(pointer: coarse)` rule. `closeOnOutsidePointerDown` defaults **off**; only a surface whose pre-migration backdrop dismissed the dialog may opt in explicitly, preserving its dismissal contract.

These are supported presentation exceptions, not silently unmigrated dialogs:

- `TerminalModal` has exactly two non-mobile presentations: **pinned** (the default — a fixed-height panel in flow above the bottom bar, which is not a `FloatingWindow`) and **detached** (a `FloatingWindow`, opened at its standard size like every other window). Switching between them is purely a pointer gesture, exactly like moving, resizing, and docking every other dashboard window: drag the pinned terminal's header to pull it out into a window, and drag that window back down until its bottom edge meets the bottom bar to re-pin it. There is no presentation toggle button and no dock-height control — both were removed. Snapping the window to the top or to a screen half never re-pins it. Being pinned does not push the terminal permanently behind the other windows: clicking the pinned panel brings it in front of them, and opening or clicking another window afterwards puts that window back in front, so the display order always follows the last thing you opened or selected whatever the docking.
- `AgentDetailView` stays embedded for inline presentation, while its modal presentation uses `FloatingWindow`; the inline branch owns no floating geometry.
- `GitHubImportModal` stays embedded when `useEmbeddedPresentation` resolves embedded presentation. Its `resizePersistEnabled` modal-only gate keeps container-filling imports free of floating chrome; modal presentation uses `FloatingWindow`.
- `RightDockExpandModal` preserves dock-origin content behavior (`surface: "expand"`) while its expanded shell is a `FloatingWindow`.

A new embedded/docked exception is legitimate only when an owning container must retain its layout, lifecycle, and content origin; it must have an explicit presentation gate and an inventory justification. Brief static opt-outs remain limited to the focused, one-decision dialogs listed above and require the same documented justification.

## Mobile/PWA app icons

The installed mobile/PWA home-screen icons are generated from `packages/dashboard/app/public/logo.svg` by the desktop icon generator. When the Fusion brand mark changes, run `pnpm --filter @fusion/desktop generate:icons` so `packages/dashboard/app/public/icons/icon-192.png` and `packages/dashboard/app/public/icons/icon-512.png` stay aligned with the canonical logo. Also bump `CACHE_NAME` in `packages/dashboard/app/public/sw.js` whenever those icon assets change so installed PWAs refresh the cached launcher images.

## Browser Navigation

The dashboard now handles browser back navigation consistently on desktop and mobile.
Using Back will first dismiss open modals and then step back through in-app view changes before leaving the app.
On mobile, an open navigation-bar **More** sheet, mailbox message detail, or artifact viewer is dismissed by one browser Back action, iOS edge-swipe, or Android Back action before the current dashboard view changes.
<!-- FNXC:MobileNavBackDocs 2026-07-16-14:45: The mobile More sheet registers as a navigation modal, so every Back delivery mechanism dismisses it before navigating away. -->
<!-- FNXC:MailboxMobileBackDocs 2026-07-16-16:15: A mobile mailbox message detail registers as a navigation modal, so Back returns to the message list instead of navigating away. -->
<!-- FNXC:ArtifactViewerMobileBackDocs 2026-07-16-17:15: Mobile artifact viewers register as navigation modals, so every Back delivery mechanism returns the operator to the artifact gallery before changing dashboard views. -->
When task detail is open from a board card, task popup, mobile list row, right-dock/activity/onboarding link, deep link, or another task detail link, one browser, iOS edge-swipe, or Android Back action closes the current detail first and restores the prior dashboard context (for example, nested task detail → previous task detail, or task detail → board/list).
<!-- FNXC:TaskDetailSwipeBackDocs 2026-07-15-10:36: Mobile task popups now register the same navigation entry as modal and full-panel task detail, so every Back delivery mechanism dismisses the popup before it can leave the originating Board or List. -->
On mobile board-card detail, the drawer's canonical **Close** action restores the prior horizontal Board position while every workflow column starts at its top; **Back to board** is intentionally absent.
<!-- FNXC:MainViewKeepAliveDocs 2026-08-30-19:05: Board, List, and Chat remain mounted only within their current project. Hidden views must preserve in-view state without retaining shared header controls or acknowledging unread chat messages. -->
<!-- FNXC:ProjectViewRestoreDocs 2026-09-07-21:35: FN-313 restores each project's last main view and validated open conversation without sharing either preference across projects. -->
<!-- FNXC:BoardNavigationDocs 2026-09-09-22:29: FN-330 treats every Board arrival as a vertical boundary: retain horizontal lane context, but start every column at its first task instead of replaying an old per-column offset. -->
After you have visited **Board**, **List**, or **Chat**, switching to another dashboard destination and returning restores the horizontal Board position, selected conversation, and an unsent chat message; every Board column restarts at the top. The dashboard reconciles task data when you return. Each project separately remembers its last main view and whether Chat was left on the conversation list or in a specific still-active conversation; returning to that project restores both without borrowing state from another project. A fresh browser start keeps the conservative Board landing rules, and a missing or archived saved conversation returns safely to the list. While a retained view is hidden — including on the All Projects overview or the backend-connection error page — it neither shows workflow controls in the Header nor marks chat messages read.

### Board panning and mobile Kanban column snapping

Reverted work remains in its own workflow column and is marked with a **Reverted** label; it is not collected into a separate board, list, or right-dock group. The card itself carries the label and nothing else — no Delete/Revise buttons. Its one resolution action, **Restore revert**, lives in the task context menu (Board and right-dock card right-click or long-press, List row context menu, Task Detail actions).

<!-- FNXC:BoardNavigationDocs 2026-08-21-18:21: FN-115 preserves native task-card activation until horizontal Board pan intent is proven, so stationary clicks continue to reach the configured popup, right-dock, or main-panel detail destination. -->
<!-- FNXC:BoardNavigationDocs 2026-08-27-10:09: FN-194 intentionally makes Board text non-selectable because native selection-autoscroll was a second, involuntary horizontal scroll path before the mouse-pan threshold. Editable Board controls retain native selection. -->
<!-- FNXC:BoardNavigationDocs 2026-08-28-13:29: FN-229 gives every clickable task-tile surface the pointing hand at rest while preserving closed-hand feedback across the entire Board for the full active pan. Disabled controls and inline editing retain their native state and form cursors. -->
On desktop and tablet, an ordinary task-card click opens the configured task-detail destination (popup, right dock, or main panel). Hovering anywhere on a board task tile shows the pointing hand. Drag horizontally from an empty Board surface or a task card's noninteractive body or text to pan the Board viewport only after the gesture crosses horizontal intent; that pan suppresses its compatibility click and does not open detail. During an active pan, the closed grabbing hand remains visible across the whole Board until the drag ends, even when the pointer stops over a tile control. Board text is intentionally not selectable, so mouse drag pan and native wheel, trackpad, scrollbar, and keyboard scrolling are the only horizontal-scroll systems. The board offers no manual relocation path: workflow automation owns task placement. Quick-create, inline card editing, and dependency search keep normal text selection. Fusion does not auto-scroll at Board edges. Phone touch scrolling and column snapping are unchanged.

<!-- FNXC:BoardNavigationDocs 2026-08-18-19:10: Phone releases keep free finger scrolling, then use one smooth controlled normal-motion settle to the already-valid reachable column. Reduced-motion users still receive an immediate landing, while programmatic, refresh, resize, and restored-page scrolls remain unsnapped. -->
<!-- FNXC:BoardNavigationDocs 2026-09-17-09:49: FN-500 keeps mobile paging column-by-column (desktop and tablet stay free-scrolling), removes the speed-derived multi-page quota, softens the single transition, and anchors only on real columns. "Never rests between columns" describes where a gesture ENDS, not the transient positions during the movement. -->
On the mobile Kanban board, free-scroll while your finger is down. At release, Fusion takes the horizontal axis back and moves continuously from wherever your finger left the board to exactly one reachable column, so the movement is smooth instead of an abrupt jump. **A phone moves column by column:** a deliberate swipe from a resting column advances to its immediate neighbour in the direction you swiped, and a faster or longer flick does not advance two or three columns — cross several columns with several swipes. If a long drag carried the board past that neighbour, the release animates back to it rather than snapping hard to where you started. Desktop and tablet are unchanged and keep free horizontal scrolling, including a position you deliberately leave between columns.

Direction is locked at finger-up from the net swipe (not rubber-band ticks), and the result is held briefly by a bounded fence. A tap on an already-anchored column moves nothing. A touch that interrupts a running transition, a release with no clear direction, or a gesture that started off-centre lands on the nearest reachable column of that gesture — it never inherits the cancelled destination. The only resting positions of a mobile snap are the reachable centres of real columns, so a banner, card, or spacer is never a magnetic target. Reduced-motion preferences, negligible-distance corrections, or unavailable animation capability use an immediate safe landing instead, and restoring a saved board position always wins over a pending correction.

<!-- FNXC:BoardNavigationDocs 2026-09-14-20:19: FN-398 bounds the post-settle pin. It exists only to absorb the last late compositor write, so it expires on its own, releases on any user intent, and never rewrites a real scroll. -->
After the board settles on a column, Fusion briefly holds that position to absorb the final late compositor write some mobile browsers emit after the gesture ends. That hold is bounded: it expires on its own after a few frames, it is released immediately by any new input (mouse, keyboard, wheel, or touch), and a scroll that moves further than compositor drift is kept rather than undone. Restoring a saved board position or panning with the mouse right after a snap therefore works normally instead of being pulled back to the snapped column.

During a user pan, the board temporarily suspends native CSS `scroll-snap-type: x proximity`; the JavaScript release handler is the single magnetism authority and restores the proximity baseline after settling. This user-scroll behavior does not run for refreshes, resizes, or restored pages, which preserve the column position you chose. The mobile-only contract intentionally avoids `x mandatory`, because mandatory snapping reintroduced the FN-001 iOS corner-rendering regression during layout changes.

<!-- FNXC:BoardNavigationDocs 2026-07-16-08:35: Issue #2245 / #2303 requires one mobile board magnetism: suspend native proximity during a user pan, let JS resolve exactly one centered column at drag-end, then restore proximity without using prohibited x mandatory so FN-001 corner rendering remains intact. -->
<!-- FNXC:BoardNavigationDocs 2026-07-15-13:30: Mobile Kanban documentation must describe the user-only JS scroll-end snap and its FN-001 proximity-CSS rationale so operators understand why layout changes never force a column. -->
<!-- FNXC:BoardNavigationDocs 2026-09-09-22:29: Mobile full-panel task detail temporarily replaces the Board, so Back preserves horizontal workflow context while every lane deliberately returns to its top. -->
This behavior used to be mobile-only, and now applies across all viewports.
Task Detail modal opens from onboarding, activity log, and task-to-task navigation now all register navigation history entries, so Android back swipe/button dismisses them consistently.

## Navigation menu placement

<!-- FNXC:DashboardDocs 2026-09-15-14:41: FN-419 makes the primary navigation surface an explicit project choice. Exactly one surface is mounted per screen; the old tablet state that showed the bottom bar and the left sidebar at the same time is gone. -->

There is always **exactly one primary navigation menu on screen**. Where it lives is a project setting: open **Settings → Appearance → Navigation menu placement** and choose **Bottom bar** (default) or **Left sidebar**. No screen size ever shows both, and mobile always keeps its bottom navigation bar regardless of the choice.

What changes with the placement:

| | **Bottom bar** (default) | **Left sidebar** |
| --- | --- | --- |
| Primary menu | Fixed bar across the bottom of the project shell | Persistent column on the left |
| Engine control (running / max concurrent) | In the bottom bar | In the sidebar footer, above **Settings** |
| **Terminal** action | In the bottom bar | In the sidebar footer |
| Dashboard window visibility toggle | In the bottom bar | **Not shown** |
| Bottom-bar height reservation | Content, sidebar, and right dock reserve it | No bottom bar exists, so nothing reserves its height |
| **Chat** from the primary menu | Bottom-bar **Chat** opens the conversation list as an anchored panel, then each conversation in its own window | Opens as a **full main page**, like Notes |

The legacy **Settings → Experimental Features → Left Sidebar Navigation** flag no longer decides the placement; the Appearance setting above does. An old `leftSidebarNav: false` value can never leave a project with no navigation at all.

### Left sidebar contents

<!-- FNXC:DashboardDocs 2026-06-22-00:00: The dashboard navigation docs must mirror the post-reshuffle source of truth: the left sidebar owns primary content views plus Workflows, Import Tasks, and Automations, while the right dock owns only inline tool panels. -->
<!-- FNXC:DashboardNavigationDocs 2026-06-22-09:30: FN-6897 synced the user-facing navigation guide after the sidebar/dock reshuffle. Desktop/tablet navigation is split between left-sidebar main-content destinations, a persistent far-right tools dock, and the footer-launched Terminal; stale Header overflow, duplicate dock/sidebar, and standalone Stash Recovery affordances must not be documented as current behavior. -->
<!-- FNXC:InboxCategories 2026-09-09-20:37: Mailbox is the sole navigation destination for ordinary mail, historical artifact/recommendation notices, and task-completion recaps; task documents and non-image artifacts remain available from Task Detail. -->

When the sidebar placement is selected on desktop or tablet project screens, the sidebar starts with a centered **New Task** button that opens the existing New Task dialog from any project screen. Expanded mode shows the plus icon and **New Task** label; collapsed rail mode keeps the centered icon-only button accessible through its label/title. Below that action, the sidebar contains primary destinations (**Board**, **List**, **Agents** when enabled, **Command Center**, **Planning**, **Missions**, **Chat**, **Mailbox**, and plugin primary views) followed by secondary destinations (**Workflows**, **Import Tasks**, **Automations**, **Files**, **Git Manager**, optional **Evals**, **Goals**, **Research**, **Insights**, **Skills & Snippets**, **Memory**, **Dev Server**, and plugin overflow views when their flags/plugins are enabled). The sidebar collapse control sits at the very top of the sidebar, in its own header row above the destination list: it is an icon-only button with no text label, matching the right-sidebar toggle in the Header. The footer contains the engine control and the **Terminal** action, then **Settings** last. Selecting **Chat** here opens the conversation as a full main page rather than as a bottom-bar list panel; that is the one deliberate exception to the shared Chat entry point.

Use the desktop/tablet sidebar this way:

1. Select **New Task** at the top of the sidebar.
   Expected outcome: the existing New Task dialog opens from any project screen, including advanced options such as execution mode, workflow/model routing, and GitHub tracking. There is no priority option: tasks run in arrival order and an operator raises one with Boost on its card.
2. Select a primary destination such as **Board**, **Command Center**, **Planning**, or **Mailbox**.
   Expected outcome: the selected view renders in the main content region and the sidebar item receives the active highlight.
3. Select **Workflows**, **Import Tasks**, or **Automations** from the secondary section.
   Expected outcome: each surface opens as an embedded main-content view. **Import Tasks** is the GitHub import surface.
4. Use the icon-only collapse control in the sidebar header (top of the sidebar) or drag the right-edge resize handle.
   Expected outcome: the sidebar switches between labeled and icon-only rail modes or persists the resized width in browser `localStorage` (`fusion:left-sidebar-collapsed` and `fusion:left-sidebar-width`) for the next reload.

While the sidebar is active on desktop/tablet project screens, Board and List workflow controls move into the Header slot that replaces the hidden view toggle. That slot exists only while Board or List is the current view; Planning, Missions, and Graph show no Header workflow control and continue to use the persisted selection. Board and List share one workflow dropdown, which selects a workflow and nothing else: it carries no per-row edit action and no **New workflow** footer. Workflow editing and creation live in the Workflows view. The standalone workflow row above the board/list content is removed in this mode. When the flag is off or outside project screens, workflow controls remain inline with the same consolidated dropdown.

On a phone inside a project, the Board stays live behind every panel, so it owns that single Header workflow selector for the whole visit: opening or closing a panel — List, Chat, Planning, Command Center, Projects, Usage, a plugin page, or task detail — leaves the selector in the same header row rather than moving it to a line of its own underneath. Panels hosted above that Board add no second selector and no replacement control of their own; List shows the tasks of the workflow already selected, and Planning, Missions, and Graph keep creating and filtering with that same selection. The overview screen and the connection-error screen release that background Board, which returns the selector to the ordinary Board/List rule. Tablet and desktop pages are unchanged.

The active nav-item highlight and the resize-handle hover/focus accent track the active color theme's `--accent` token across all themes, so shadcn, forest, ocean, and other themes no longer show a fixed blue selected state. The Header retains the Fusion brand and project selector, keeps non-navigation controls, and hides duplicate desktop view-toggle entries while the sidebar is active.

On mobile viewports (`<=768px`), the sidebar is not rendered even when the default-on setting is enabled. The Header's **New Task** action is the rightmost header control and opens the existing full form from any active project view. The mobile Header exposes none of **List**, **Notes**, or **Activity**: the bottom bar's navigation menu is their single owner, so the narrow header no longer duplicates what that menu already offers. From that menu, **List** and **Notes** open full-screen over the board in the main-content drawer and **Activity** opens the full-screen activity log. Notes therefore has one mobile presentation rather than two — the separate mobile Notes tool drawer is removed, and the full-screen Notes view provides the same internal list-to-editor navigation. The bottom `MobileNavBar` provides separate **Tasks** (Board) and **List** destinations, while the Planning column keeps its inline quick-entry composer. Mailbox is the single mobile destination for mail, historical notices, and task-completion recaps; persisted footer choices for the retired Artifacts or Recommendations destinations are ignored. Mobile-only More-sheet entries remain available for compact tools such as Git Manager, Terminal, Files, and **Import from GitHub**.

When a soft keyboard opens, fixed mobile bottom bars never rise with it. The navigation bar and executor status bar collapse flush to the bottom of the layout viewport on both iOS and Android as soon as a text field gains focus, including landscape phones, leaving no empty band above the keyboard. The chat composer does not reserve the bottom safe-area inset while the keyboard covers it, so typing sits directly above the keyboard. While a text field is focused at normal scale, viewport compensation clamps `--icb-bottom-offset` to `0px`, including in hosts without the visual viewport API, so stale viewport measurements cannot lift fixed chrome.

<!-- FNXC:MobileKeyboardViewport 2026-09-17-14:23: FN-512 supersedes the earlier claim that the composer keeps a permanent allowance for Safari's input-assistant bar. That allowance was a fixed margin rather than a measurement, and it produced the empty band operators reported between the keyboard and the field. -->
The surface your field lives in decides where the visible area ends, and it decides it once. Whichever panel owns the layout — a mobile drawer, a floating window, or the terminal sheet — measures how much of itself the keyboard actually covers and shortens itself by exactly that much; the content inside it, including Chat, task composers, and form fields, does not adjust a second time. When the browser has already resized the page for the keyboard, as Android does, nothing is reserved at all. The composer keeps its ordinary spacing: Fusion no longer adds a fixed allowance for Safari's input-assistant bar, which showed up as a visible empty band rather than as useful clearance.

Closing the keyboard, moving from one field to another, switching apps and coming back, rotating, folding, or zooming all return the surface to its resting size without a late jump, and your draft, text selection, and scroll position are kept. Revealing a field that sits below the fold scrolls only the list or panel that contains it, never the page behind it. Zooming in is treated as zoom, not as a keyboard, so mobile navigation stays where it is.

<!-- FNXC:DashboardResponsiveDocs 2026-07-25-22:57: Project overview has no task destinations, so the mobile navigation and its published height must be absent rather than leaving dead bottom space. Document the 320px responsive and token conventions alongside the operator-visible behavior. -->
<!-- FNXC:ProjectOverviewHealthHydration 2026-08-01-15:40: Registered projects are the navigation-critical content of the all-projects view, so optional per-project health telemetry hydrates progressively rather than delaying cards and their controls. -->
On the **All Projects** overview, Fusion renders registered project cards, navigation, filters, and controls as soon as the project list is available. Per-project health metrics hydrate progressively as bounded background requests complete; pending or failed telemetry never replaces the grid with a full loading skeleton. Fusion continues refreshing those metrics in the background and suspends polling while the tab is hidden. It suppresses the mobile bottom nav because task tabs are not active there and clears `--mobile-nav-height`, so the overview does not reserve bottom-bar space. The overview reflows through 320px: headers, filters, stats, and card actions stack or wrap, while long project names and paths truncate rather than overflowing. Dashboard component styles use literal pixel values for media-query breakpoints (including `480px` and `380px`); declaration values within those blocks stay token-based.

## Tool destinations without the right sidebar

<!-- FNXC:ToolSurfaces 2026-09-15-16:04: FN-426 gives every former right-dock tool a host that exists whether or not the dock is enabled, so the dock becomes a shortcut panel rather than a requirement. -->
No tool requires the right sidebar. Each one has its own permanent access:

| Tool | Where it lives |
| --- | --- |
| **Files** | A full **Files** page in the primary navigation (bottom bar, left sidebar, or mobile navigation). |
| **Git Manager** | A full **Git Manager** page in the primary navigation, with its existing Status, Changes, Commits, Branches, Worktrees, Stashes, Recovery, and Remotes sections. |
| **Pull Requests** | A **Pull Requests** section inside the Git Manager page. Old `?view=pull-requests` links, favorites, and persisted values open Git with that section selected, keeping any requested pull-request id. |
| **Secrets** | **Settings → project Secrets**. Old `?view=secrets` links and persisted values open Settings at that section for the right project. Secret values are never read before the section is opened and never travel through the settings form. |
| **Activity Log** | A header popover on tablet and desktop, with its type/project filters, refresh, task links, pagination, and an always-visible task-id search field. The field matches a task id exactly (` fn-426 ` resolves to `FN-426`); it is not a full-text search and it filters the source, not only the rows already loaded. On a phone the same header trigger opens the full-screen Activity Log instead, because a popover anchored to the header is unusable at that width. |
| **Notes** | On tablet and desktop, a header popover that hosts the complete Notes surface: the note list on the left and the open note's editor beside it, with no separate note window opened from that popover. On a phone the same trigger opens a bottom drawer with internal list ↔ editor navigation, like Chat. |
| **Chat** | A **Chat** button in the bottom bar opens the conversation list as an anchored panel; a plain click on a conversation closes the list and opens or raises that conversation's own window, while **Ctrl/Cmd + click** and the right-click **Open in new window** action open the window and leave the list open so several conversations can be opened in a row. Creating a conversation closes the list and opens its window. Under the **Left sidebar** navigation placement, **Chat** stays a full main page instead. On mobile the list uses the standard responsive modal presentation. |
| **Board / List** | **Board** is a direct entry in the primary navigation on every breakpoint, because it is part of the default **Navigation quick access** selection; removing it from that selection moves it into the **More** / phone navigation menu like any other destination. On a phone and a narrow tablet, that **Board** quick-access slot shows and opens **List** instead: the Board is already the permanent background surface there, so the shortcut opens the task list in the main drawer above it, and there is no separate **List** entry in the mobile menu. **List** remains an ordinary destination elsewhere: the footer **More** menu on the footer placement and the sidebar under the sidebar placement. The tablet/desktop Header no longer carries a List button, and tablet/desktop **Board** behaviour is unchanged. |
| **Dev Server** and **plugin views** | Ordinary primary-navigation destinations under their existing flags. |

Only one navigation panel — Activity, Notes, or the Chat list — is open at a time. Escape or a click outside closes the open panel and returns focus to its trigger; closing a list never closes the conversation or note windows it opened. Escape and the outside click remain the explicit dismissals of the Chat list, including after a Ctrl/Cmd + click or an **Open in new window** action deliberately kept it open. The AI usage popover stays independent.

## Optional right sidebar

The right sidebar is **off by default**. To bring it back, open **Settings → Appearance** and turn on **Show the right tool sidebar** (a project setting, tablet and desktop only; mobile never renders or reserves space for it). While it is off, no dock, toggle, expand control, resize handle, or reserved width exists anywhere in the shell.

When it is enabled, it offers exactly four shortcuts — **Files**, **Chat**, **List**, and **Notes** — to the same owners described above; every other access above stays available at the same time. A tool selection persisted before those tools moved (Git Manager, Activity Log, Secrets, Pull Requests, Dev Server, or a plugin tab) falls back to **Files**. The panel's open/closed, pinned, width, and selected-tool states remain local browser preferences and can never re-enable a disabled sidebar.

When enabled on desktop or tablet project screens, the right dock is a persistent far-right tools sidebar in the project content row. By default it opens as an overlay so the main content does not reflow. Use the dock toolbar pin action to switch into push mode, where the dock becomes an in-flow pane that shrinks the main content beside it; unpinning returns to overlay mode. The selected tool, open/closed state, pinned push-mode state, width, and expanded modal size persist across reloads.

<!-- FNXC:TaskDetailDefaultTabDocs 2026-09-16-02:53: FN-442 removed the "open tasks in the right sidebar" entry; the dock keeps its own task tools, but board cards no longer route into it. -->
Board task cards no longer route into this dock: opening a task always opens the movable task window (see below). The dock keeps its own tools and its embedded task detail for the flows that open it from inside the dock.

<!-- FNXC:MobileTaskPopups 2026-07-21-00:00 (FN-8478): Board-card and List row/card task opens have a separate default-off popup setting so operators on desktop, tablet, and mobile can opt into the existing FloatingWindow task popup when they want the board or List view visible; board-card deep-tab chips now preserve their requested tab in the popup, while context-menu and non-board/List opens keep their existing paths.
FNXC:TaskPopupGeometry 2026-09-14-21:10: FN-394 replaced the shared task-popup geometry key with independent openings: every task window opens at the standard task size, centred in the work area, and no task window inherits another's size or place. Mobile routes Task Detail into the official bounded drawer.
FNXC:TaskPopupLayer 2026-09-14-21:10: FN-394 merged the task/Chat band into one shared window stack, so the most recently opened or engaged window is in front whatever its type; the plugin layer still sits above every dashboard-managed window.
FNXC:TaskPopupViewGating 2026-07-15-15:20: FN-8016 makes popup view scoping default-on for every dashboard view. Same-task popups remain independently addressable by origin view.
FNXC:TaskPopupViewGating 2026-07-22-13:20: FN remount-churn fix R7 — off-origin-view popups are now render-only hidden (FloatingWindow `hidden`: visibility-based, aria-hidden, effects suspended), never unmounted. The embedded task detail, including an open terminal WebSocket, stays live while hidden; the detail's SSE/EventSource channels close via `active={false}` and reopen on reveal. Returning to the origin view is an instant reveal, not a remount. -->
<!-- FNXC:TaskDetailDefaultTabDocs 2026-09-16-02:53: FN-442 made the task window the unconditional route for board, deep-tab chip, and List opens; there is no setting left to enable. -->
Opening a task from a board card, from a board-card `changes`/`retries`/`workflow` chip, or from a List row/card opens the movable task window — on desktop, tablet, and phone alike, with no setting to turn on. The board or List view stays visible behind it. The phone drawer is the one exception and keeps the full-panel task detail, because a phone hosts exactly one task-detail owner. Overlapping Chat and task popups interleave by the most-recent pointer or focus interaction; other utility windows retain their higher global stacking. On desktop and tablet, every task popup opens at the standard task size, centred, independently of the other windows; on mobile, task popups stay full-screen sheets. Board task-card `changes`/`retries`/`workflow` chips open the popup with the requested tab. List context-menu/refine actions, task-detail links, plugin/graph opens, and explicit pop-out actions keep their existing paths.

**Settings → Appearance → Keep task popups on the view where they were opened** is enabled by default. Every task-detail popup is attached to its exact originating view, including Planning, Agents, Command Center, Mailbox, Missions, and plugin views: navigating elsewhere hides it without closing it, and returning re-shows it in the same saved position. You can open the same task independently in more than one view; closing or pressing Escape on one popup does not affect the other. Disable this setting only to restore legacy globally shared popups. Legacy saved popups without an origin remain visible everywhere for compatibility.

<!-- FNXC:DashboardNavigationDocs 2026-09-14-17:46: FN-392 restores Chat as an inline, non-expandable dock tool whose conversations open dedicated windows; keep this user-facing roster aligned with STATIC_OVERFLOW_VIEW_ENTRIES. -->
<!-- FNXC:RightDockTasks 2026-09-12-01:35: Tasks browsing belongs to Board and List, while the appearance preference may still open a temporary task detail over the selected dock tool. -->
The dock toolbar has built-in inline tool panels for **Files**, **Chat** (whose compact conversation list stays in the dock body while each conversation opens its own window), **List**, and **Notes**. These tools render in embedded mode inside the dock instead of opening fixed popup overlays; **Files** opens by default and is also the fallback for the removed historical Tasks key and for any tool that has since moved to its own page. When a dock flow opens a task, Task Detail temporarily covers the selected tool and either back action restores that tool; no Tasks tab or task-list shell appears. Inline dock views have an expand button that opens the same view in a resizable modal for more room; **Chat**, **List**, and **Notes** are deliberately not expandable because a second owner would duplicate their content. The right-dock **Files** viewer and its expanded pop-out match the Files modal for browser-previewable file types: image, video/movie, audio, and PDF selections render as native browser previews, while editable text files keep the editor and save flow. Plugin views no longer add dock tool tabs: they are ordinary primary-navigation destinations, so they stay reachable when the sidebar is off.

Use the desktop/tablet right dock this way:

1. Open a project screen with **Show the right tool sidebar** enabled.
   Expected outcome: the dock appears on the far right with **Files** selected unless a valid previous dock view is stored.
2. Select **Files**, **List**, or another available inline tool in the dock toolbar.
   Expected outcome: the selected tool renders inline inside the dock body and the toolbar tab becomes active.
3. Select **Chat** in the dock toolbar.
   Expected outcome: the Chat window opens or is raised in front of the page, the dock body keeps the tool it was already showing, and no second Chat appears on the page behind it.
4. Drag the dock's left-edge resize handle, or focus the separator and use the arrow keys.
   Expected outcome: the dock width changes within its min/max bounds and is saved for future reloads.
5. Select the dock expand action.
   Expected outcome: the same inline tool opens in a resizable modal while the dock remains the source navigation surface.
6. Select the dock pin action.
   Expected outcome: pinned mode pushes the main content narrower, unpinned mode overlays the page without reserving space, and the preference is saved for future reloads.
7. Use the Header right-sidebar toggle.
   Expected outcome: the far-right surface opens or closes without creating duplicate left-sidebar destinations; mobile viewports never render or reserve space for the right dock. The toggle exists only while **Show the right tool sidebar** is enabled.

Content views such as Mailbox, Research, Insights, **Skills & Snippets**, Memory, Evals, Goals, **Workflows**, **Import Tasks**, and **Automations** live in the left sidebar (or compact mobile navigation) rather than the right dock. On desktop/tablet, GitHub import lives under **Import Tasks**; mobile keeps compact GitHub import entries in the More surfaces.

On mobile viewports, the Right Dock never renders. The wordmark is reduced to its logo and the hamburger is the rightmost control in the floating pill. It opens the compact, scrollable navigation popover, reusing the destination registry, badges, feature gates, plugin views, and Scripts submenu without introducing another drawer or gesture. Selecting any destination opens it in the shared drawer over the still-mounted Kanban.

<!-- FNXC:AlphaMobileDrawerDocs 2026-09-13-02:05: The official mobile design makes Board the permanent background and presents every other project surface in one bounded drawer anchored to the viewport bottom above its trigger pill.
FNXC:AlphaMobileDrawerDocs 2026-09-11-15:01: Every Alpha drawer has one visible header and no shell-owned close cross. Its handle is always draggable; the rest of the surface may claim a downward dismissal only when every relevant scroller was already at its top edge. Empty, skeleton, and populated Board columns keep at most one extra-small token above the pill through one measured reserve.
FNXC:AlphaMobileDrawerDocs 2026-09-12-20:37: Mobile drawers rise from below instead of entering laterally, with reduced-motion preferences suppressing the transition. Task Detail's drawer omits Back to board because its canonical close action already performs the same complete Board restoration. -->
The Alpha icon-only pill presents up to five destinations as a floating overlay, followed by the hamburger as its rightmost control. Those destinations are the project's **Navigation quick access** selection, in the persisted order and shared with the tablet/desktop footer row — by default Dashboard, Board, Planning, Missions, and Chat. The pill renders that selection and nothing else, so a given configuration produces the same shortcuts on a phone, a tablet, and a desktop; the width of the screen never promotes an unconfigured destination. **Chat** is an ordinary destination of that selection: a direct tab when it is one of the five slots, a menu entry otherwise, never both. An existing four-destination configuration is completed from the default order, which ends with Chat, so Chat stays in the bottom bar after the upgrade; removing it requires defining five destinations explicitly. The **Board** slot is likewise an ordinary destination, but on this mobile shell it shows and opens **List**, because the Board is the permanent project surface behind every drawer; the mobile menu therefore no longer carries a separate **List** entry. Every destination left out of the selection stays reachable from the hamburger menu.

Swiping the pill upwards no longer opens Chat. The project setting **Open the mobile menu with a swipe** (General, disabled by default) hides the pill's menu button and opens the navigation menu with that upward swipe instead, presenting it as a drawer exactly as wide as the bottom bar and starting at its top edge. With the setting disabled the menu button is rendered as before and the swipe does nothing. The gesture remains touch-only, stays inert while the menu is already open, and has no effect on the wide desktop bar, which is not swipeable. Destinations, plugins, Settings, Workflows, Automation, imports, files, Git, Activity, Scripts, Terminal and Task Detail share a bottom drawer with a visible drag handle, accessible title, one visible header, and a canonical height independent of content length. That canonical height is the same for **every** drawer, Terminal included: all drawers open at the identical height, nearly at the top of the screen, so the usable content area never changes between drawers. A constant band stays revealed above the panel — the same on every drawer, whatever the device safe-area inset — carrying the scrim and the close gesture. On opening, every mobile drawer rises vertically from below with no lateral movement; when reduced motion is requested, it appears without that transition. Drag downward from the handle, or from anywhere on the drawer when every scrollable ancestor under the pointer was already at its top edge, to close. A short fast flick also dismisses, while controls, xterm, horizontal/upward movement, a scroller that started above zero, and incomplete or cancelled drags retain their normal interaction and return the panel to rest. A destination's own header keeps ownership of its title and actions; only headerless content receives a visible shell title. Central content scrolls within the fixed drawer while persistent controls such as the Chat composer remain visible and focusable above internal system and keyboard clearance. The bounded top edge leaves part of the Kanban visible. The drawer surface starts at the bottom edge and paints above the pill: the pill remains only its trigger in the background, not a reserved strip below it. Task Detail uses that same drawer whether it was opened from Board, List, a plugin, the former pop-out action, or another mobile task surface, retaining its requested tab and nested-detail history without opening a second copy. The drawer omits the redundant **Back to board** action: its single **Close** control, handle, backdrop, Escape, and browser/Android Back all use the existing navigation owner, consume one history entry, and restore the Kanban, saved Board position, initial tab, and cleared detail selection. Desktop Board panels retain **Back to board**.

<!-- FNXC:TaskDetailAlphaDocs 2026-09-11-17:35: Task Detail uses the same canonical four-zone shell and action ownership in modal, embedded, pop-out, and Alpha drawer hosts; Alpha changes presentation, never layout semantics or lifecycle eligibility. -->
### Task Detail presentation

The complete Task Detail surface—not only its chat content—uses Fusion’s official neutral presentation. Every host follows the same fixed order: **Header → Tabs → Content → optional Footer**. The compact header shows the task number and status, followed by exactly two controls: the icon-only **Actions** overflow and the canonical close (on a phone outside drawer presentation, the Back arrow replaces that close). That overflow is the single header action surface: it retains attachments, GitHub tracking, oversight, Fast mode, refinement, bypass, and Revert operations (FN-509 removed its priority group with the priority system) — or **Restore revert** in place of Revert once the task has been reverted — and also carries **Duplicate**, **Retry**, **Delete**, **Pause/Unpause**, and **Reset** when each is eligible, followed by **Edit task** and **Pop out**. Every control has a localized accessible name and tooltip.

The horizontally scrollable tab strip remains immediately below the header. The central content alone consumes the remaining height and owns ordinary scrolling. Activity Live and task Chat fill that height in empty, loading, populated, and streaming states: the transcript shrinks and scrolls while the composer remains the final in-flow element at the lower edge without covering messages. A footer is rendered only for persistent contextual controls such as edit Save/Cancel, plan Approve/Reject, or review/PR completion; standard tasks render no empty footer.

The modal from `AppModals`, mobile drawer, Board main-panel detail, List split detail, Right Dock detail, and task pop-out all render this same retained surface. Activity and Actions menus and the Refine dialog inherit its light or dark neutral palette even though overlays are portaled. Switching hosts or receiving live task updates does not reset the selected tab, edit draft, focus, close/navigation behavior, or lifecycle guards. Historical `alphaUpdates` values are ignored and cannot select another presentation.

<!-- FNXC:AlphaFooterDocs 2026-09-11-16:14: Alpha removes the executor footer only on phones, where one measured pill reserve lets every Board state fill the safe height with equal top and bottom spacing; tablet and desktop retain footer controls such as Terminal.
FNXC:MobilePillKeyboard 2026-09-16-16:27: FN-463: the official pill stays anchored to the bottom of the screen independently of the software keyboard — it no longer lifts above it — while still sharing the header surface and defining the popover's exclusive lower boundary. -->
The official design does not render the executor status footer on mobile phones. On mobile, the pill clears the safe area, standalone gap, and visual-viewport compensation, while the Board height chain reserves its measured border box and placement exactly once; empty, skeleton, populated, duplicate, and pagination-error columns fill that safe height with the same spacing token above and below, without overlap or another safe-area padding band. The last link, button, field, or card can therefore scroll and receive focus fully above it in portrait or landscape. The pill stays anchored at the bottom, visible and interactive, and does not move when the software keyboard opens or closes; it uses the same `var(--surface)` background as the header, and forms the exclusive lower boundary of the scrollable hamburger popover so the menu never covers it. Open drawers do not subtract the pill height or system offset from their outer geometry; they absorb safe-area, standalone, and visual-viewport clearance inside their own scrollable surface. Tablet and desktop retain the project sidebar, right dock, existing floating/modal presentation, and executor footer with controls such as Terminal. On desktop Board and List, search stays inline in the header; tablet and mobile search retain their existing interaction.

### Task search

The header search field looks through the whole project, not only the tasks the board happens to have loaded. Typing matches a task by its number, by a word in its title, by its description, and by its comments, so typing `collapse` finds a task whose title mentions collapsing a sidebar even if its board page was never opened. Suffixes and punctuation are matched literally, and completed tasks stay findable; deleted tasks and historical archives do not.

<!-- FNXC:TaskSearchPagination 2026-09-17-08:46: FN-497 — the ordinary search lane now presents matches newest-first by creation date, so both lanes of the same field share one order promise. -->
Results are shown newest first: the most recently created match is at the top, and the ones below it keep getting older. Scrolling for more results continues in the same direction — the order never goes back up and no task appears twice — so a task created today is the first thing you see rather than something you reach after paging through the project's history.

Results appear in a panel under the field as full task cards, the same size and with the same information as the cards on the board — not shortened one-line entries. The list of results scrolls on its own: the wheel, a trackpad, a finger, dragging its scrollbar, and the arrow keys all move through it, and the page behind the panel never moves instead of it. There is no fixed limit of eight: the panel keeps loading further results as you scroll toward the bottom, so every match stays reachable. The panel reserves enough height to show one complete card and half of the next before you have to scroll, whenever the screen is tall enough; on a very short screen, or with the on-screen keyboard open, the panel stays inside the screen and scrolls instead of shrinking the cards. It never covers the field, and you can keep typing while results load.

Result cards are for finding and opening a task. They do not offer editing, the card menu, file drop, approval, retry, or any other action — selecting one opens the task, where those actions live.

Pressing **Enter** in the field runs an AI search instead of an ordinary one. It uses the project's effective **Fast & Cheap** model setting (falling back to the global one, then to the inherited execution model), so it costs what that lane costs and nothing else needs configuring. The AI search returns at most five tasks: it picks the five that best match what you meant, and only then shows them newest first by creation date. It never invents a task and never pads the list, so fewer than five results simply means fewer good matches. That is the same newest-first order as the ordinary search above; the only difference is that the AI search first narrows the project down to its five best matches. Enter runs it once per press; ordinary typing never triggers it.

If the AI search fails — quota reached, timeout, no Fast & Cheap model configured, or an unusable answer — the panel says so and keeps whatever ordinary results it already had, still labelled as ordinary search results. Nothing is retried automatically; press Enter again when you want to.

<!-- FNXC:TaskSearch 2026-09-17-07:43: FN-494 remplace le contrat de sélection par hôte par une règle unique : vider le champ, fermer la recherche, ouvrir la fiche. Les champs flottants tablette/mobile écrivaient l'identifiant de la tâche dans le filtre sans jamais ouvrir la tâche. -->
Choosing a result does the same thing everywhere — on a computer, on a tablet, and on a phone: the search field is emptied rather than filled with the task's number, the search closes, and the task's card opens. The Board and List filter is never left holding a task number. When you are viewing a remote node, both the ordinary and the AI search ask that node; results are never quietly answered from your local project.

## Task-detail Chat

Task-detail **Chat** uses the project’s configured Direct Chat default model and thinking level rather than the task’s planning model. It remains task-aware: the server builds the task definition, dependencies, activity, metrics, steering, and refinement context, and the existing `task-planner:<taskId>` session keeps one transcript per task. Task context always comes from the selected project’s authoritative store, including while that project’s engine has not started or is unavailable; another project’s task with the same ID cannot supply its context. Its single **Brain** popover holds the model picker and thinking-level list in the same readable, viewport-clamped control on desktop and mobile. Task Chat remains model-only, so choices do not replace the synthetic task-scoped permission contract with a Direct Chat agent. Selecting a model keeps the popover open for a thinking-level choice; selecting a thinking level, switching conversations, or receiving a target change that was not selected closes it. Changing the project default does not hide history, and the next explicit send applies the current target to the existing idle session. There is no separate planner-model lane for this conversation.

## Chat message editing and rewind

Direct Chat and task-detail Chat let you edit a persisted user message with the inline **Edit message** control. Rooms and CLI-backed chat sessions do not expose this control. Saving sends one replacement-aware SSE request with the trimmed correction and the target message identity; the server validates the project/session/role and rejects edits during an active generation.

The server accepts the replacement only after it has discarded the target and every later persisted turn and repointed reachable pi session history to the retained prefix. The Direct and task Chat transcript keeps the old range visible until that acceptance callback, then shows the trimmed replacement and its new response. A pre-acceptance validation, transport, or fencing failure reloads the authoritative old transcript and leaves the correction editable; it never issues a second send. A provider failure after acceptance remains a normal SSE/fetch reconciliation path: discarded history is not restored and no duplicate response is started.

Task Chat refreshes task detail after an accepted replacement. Steering comments and refinement tasks created by discarded task-chat turns are durable side effects and are not rolled back; when applicable, task Chat shows the existing informational notice. The edit behavior is shared across desktop, popup/dock/host, mobile/touch, and task-detail surfaces.

## Pending messages in Direct and task Chat

Direct Chat and task-detail Chat share one browser-local, text-only pending queue per chat session. While a model reply is active, send additional text to add it to the queue; the queue survives reloads under the session-scoped `fusion:chat-pending:<sessionId>` storage key and does not cross projects, tasks, or sessions.

Both model-loop surfaces expose the same queue controls: edit an entry, move it earlier or later, delete it, or **Force send** a selected entry. Duplicate text is selected by its position in the list, not by its content. A blank edit is rejected without deleting the queued entry, and queue controls remain named and touch-reachable on narrow screens.

Normal completion and **Stop** release only the FIFO front after cancellation and authoritative history reconciliation. **Stop** and **Force send** first ask the running model runtime to interrupt through its own interrupt before the response is torn down; runtimes without an interrupt continue through the existing teardown. A runtime that stalls or fails to answer that request cannot delay or break cancellation, history reconciliation, or the queue's failure behavior. **Force send** then dispatches only the selected entry; failures keep the entry in its original queue position.

During cancellation and history reconciliation, the text composer and voice dictation remain available. Text submitted in that interval joins the visible queue and dispatches automatically after reconciliation, while queue editing and reordering, model selection, and the attachment picker remain disabled. Attachments are never queued: a send attempted with staged files during this interval is refused with the existing warning from either the Send button or Enter, preserving both the draft and its files instead of sending text without them. Activity task chat, Chat Rooms, and CLI-backed chat intentionally keep their separate interaction and transport contracts and do not inherit these model-loop queue controls.

## Automations

<!-- FNXC:AutomationTools 2026-06-26-00:00: Automation AI-prompt steps now default to the full coding tool set and expose per-step restrictions so operators can intentionally narrow tool access without breaking legacy schedules. -->
<!-- FNXC:AutomationLiveOutput 2026-06-26-00:00: Manual automation runs stream step, text, and tool activity into the Automations card while preserving the final run-result history after completion. -->
<!-- FNXC:Automations 2026-07-12-19:14: Schedule and routine AI-capable model selectors persist an optional Thinking Level on each step. Default/inherit stays empty, concrete off..xhigh values are stored with the JSON step configuration. -->
<!-- FNXC:Automations 2026-07-12-20:30: FN-7903 makes the persisted step Thinking Level runtime-active for scheduled, routine, and manual AI Prompt runs, and maps Create Task step choices onto the spawned task. -->

Open **Automations** from the left sidebar (or the mobile More surfaces) to create cron, webhook, API, or manual routines. AI Prompt steps now run with all selectable coding tools by default: **Read**, **Bash**, **Edit**, **Write**, **Grep**, **Find**, and **Ls**. In the routine editor, use **Allowed tools** on a simple AI Prompt action or any multi-step AI Prompt step to clear or re-select tools. Leaving every tool selected stores the legacy default, so existing schedules continue to run with full tool access; clearing every box is an explicit no-tools configuration. AI Prompt and Create Task action model selectors also include **Thinking Level**: leave it on **Default** to inherit the project setting, or choose a concrete reasoning effort. Scheduled, routine, and manual AI Prompt runs apply that saved reasoning effort at session creation; Create Task steps copy it onto the task they create.

When you choose **Run now**, the routine card opens a **Live output** panel while the manual run is active. The panel appends step status, AI text deltas, and tool start/finish activity as the run executes, then the card falls back to the persisted final run output and run history once the server records the result. The same `RoutineCard` surface is used by the floating modal and embedded Automations view, so live output appears in both presentations and collapses into a single-column card layout on mobile.

<!-- FNXC:DatabaseBackup 2026-07-04-00:00: FN-7537 fixed a manual/cron divergence for the built-in "Database Backup" automation/routine: a manual "Run now" now intercepts the in-process backup exactly like the scheduler, instead of shelling out to a possibly-missing global `fn`/`runfusion.ai` binary. -->
Settings splits **Database Backups** (global shared-cluster policy and `~/.fusion/backups` destination) from project-scoped **Memory Backups**. The Database Backups settings section shows the backup inventory (newest first, with filename, creation time, and size) and schedule evidence: enabled state, cron, next and last runs, latest result, and run count. It explicitly reports an empty inventory or listing error and warns when an enabled policy has no registered shared routine. Fusion reconciles that routine at engine startup; unchanged settings saves preserve its next scheduled run.

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

<!-- FNXC:TaskRecoveryVocabulary 2026-08-28-00:38: FN-206 keeps recovery predictable: Retry repeats the current stage in place, Reset restarts the task, and Delete removes it. -->
- Task context menus do not offer a destination picker. Use **Retry** to repeat the current stage in place, **Reset** to restart from the original request, or **Delete** to remove a task. Manual-intake cards may still offer **Start** to admit a new idea into its workflow.
<!-- FNXC:BoardNavigation 2026-08-21-21:17: FN-115 keeps ordinary task-card clicks native until horizontal intent is proven, while preserving FN-109 card-body panning after the threshold. Edge proximity never starts or continues scrolling, and phones retain their separate native touch and column-snap ownership. -->
<!-- FNXC:BoardNavigation 2026-08-28-13:29: FN-229 documents the Board's deterministic pointing-hand-at-rest and closed-hand-during-pan cursor feedback while preserving native disabled and editing cursors. -->
- On desktop and tablet, task tiles show the pointing hand on hover. Click-hold and drag a safe Board surface, including empty-column text or a task card's noninteractive body/text, to pan columns by actual pointer movement after horizontal intent; the closed grabbing hand remains across the whole Board until the drag ends. Board text is intentionally non-selectable, preventing native text-selection autoscroll from competing with the pan; editable quick-create, inline card editing, and dependency search retain normal selection. An ordinary task-card click opens its configured detail destination; a qualifying pan suppresses only its compatibility click. Controls, editable content, and native-draggable targets retain their normal behavior; approaching an edge never auto-scrolls. Native wheel, trackpad, scrollbar, and keyboard scrolling remain available. Phones continue to use unchanged native touch scrolling and mobile-only column snapping.
- Search all live project tasks from Board or List without branch restrictions. Entering only the numeric part of a task ID shows live suggestions across prefixes; choosing a suggestion applies its exact ID to the shared search.
- Column visibility controls
- Done history continues automatically in bounded server pages as you approach the bottom. Fusion keeps only a measured window of cards mounted, stops at the server’s terminal continuation, and preserves visible cards if a page fails; in that error state, **Retry** explicitly resumes loading instead of leaving an endless spinner.
- Task cards project every region already known from their task snapshot on the first paint. File counts, mission and agent identities, explicit oversight, workflow identity, and card fields therefore occupy their final structure before viewport observers or local metadata requests run. A same-snapshot response may refine text inside an existing region, but cannot add or remove that region; only a newer task snapshot or a revisioned/timestamped live workflow, provider, or runtime event may change card structure.
- Inline quick entry creation
- The quick-entry GitHub icon is a per-task tracking override: leave it untouched to use the project default, turn it on to opt the next task into tracking when the default is off, or turn it off to opt the next task out when the default is on.
- PR/issue badges with live updates
- Planning cards and List rows/cards show the same active border and pulsing **Planning** badge when fresh planner activity reaches the live log stream, including the brief status-null transition before the authoritative task row refreshes. The transient indicator clears on that authoritative refresh, so completed planning does not remain active.
- A workspace task waiting for another task's repository acquisition shows a **Waiting** badge with the holder reason on board cards, list rows, and task detail. The badge clears when the bounded scheduling wait yields or completes.
<!-- FNXC:TaskActivity 2026-07-28-12:00: FN-8300 requires visual card activity to agree with fresh planner logs during status-null planning transitions; Board and List reuse their existing active affordances. -->
- GitLab tracking badges on task cards for linked GitLab project issues, group issues, and merge requests; stale GitLab metadata uses a warning-colored badge while GitHub badges remain unchanged.
- GitHub provenance marker on task cards imported from GitHub (`sourceType: github_import`), shown in the footer with other external-source metadata
- Task cards show their creation time for today or local calendar day otherwise; completed cards also show their completion date.
<!-- FNXC:TaskCardRuntimeChip 2026-09-16-06:16: FN-457 makes the card clock chip mean worked time in every lane and explains it in three tooltip lines. -->
- The clock chip in a task card's bottom-right corner shows the time actually **worked** on the task, from planning through the end of its merge — not the wall clock since the card entered its column. Waiting and paused periods are excluded: a card paused overnight no longer shows `14h` for twenty minutes of real work. Hover the chip to see the breakdown in three lines whose sum is exactly the number on the chip:
  - **Planning** — active planning-agent time, including the Plan Review gate.
  - **Execution** — active implementation time, with paused time deducted.
  - **Verification** — the time verification gates actually ran (code review, browser verification and other optional-group gates, custom pre-merge prompt/script gates, post-merge checks), plus the live merge phase while a merge is running. Overlapping gate windows, such as parallel `foreach` instances, count once.

  The Plan Review gate is counted under **Planning**, not Verification, because it runs inside the planning segment the engine already measures; counting it twice would inflate the total. Implementation work performed by skill-bearing workflow nodes is likewise counted only once, under Execution. On mobile the native tooltip does not appear on tap; the same breakdown is available to screen readers through the chip's accessible label and in the task detail panel.

  Legacy cards created before this accounting existed fall back, in order, to their recorded execution window, the server's aggregate execution total, their `[timing]` log entries, and finally to time since column entry — the last of which is wall clock and is used only when a card carries no instrumentation at all.
- Task card header meta badges carry fast mode and the other lifecycle chips. FN-509 removed the priority badge with the priority system; the **Boost** action replaces it and sits in its own row below the card body. Agent-created provenance renders in a dedicated bottom-left row ahead of workflow identity so the ID/status/actions header does not wrap on narrow cards. Agent labels prefer `sourceMetadata.agentName` over raw agent IDs.
- **Settings → Appearance → Show cost badges on task cards** is default off. When enabled, board cards with recorded positive token usage show a compact derived-cost badge with the card's other footer/meta chips; unpriced models display `—`, and cards with no usage render no badge shell.
<!-- FNXC:TaskCardCostBadge 2026-07-11-12:25: The card spend badge is opt-in because card footers are dense. It must remain guess-free (unpriced `—`, no fabricated `$0`) and absent for tasks without positive token usage. -->
<!-- FNXC:TaskCardLayout 2026-07-10-00:00: FN-7780 moved agent-created provenance out of the header meta-badge cluster into a bottom row. Keep dashboard docs aligned so operators do not expect the agent chip to participate in header wrapping. -->
<!-- FNXC:PlannerOversight 2026-07-04-00:00: FN-7516 adds a read-only effective oversight-level badge plus an active-overseer-state indicator to the card-meta-badges cluster. The overseer-state indicator is derived card-locally from already-on-Task fields (mirroring the engine's stage-resolution precedence) rather than a new engine-plumbed field, since @fusion/engine's in-memory monitor state is not persisted onto Task/exposed via API. -->
<!-- FNXC:PlannerOversight 2026-09-09-15:21: A workflow-tier request is an unversioned enrichment of the mounted Task snapshot. Without a synchronous task override it cannot add a badge after first paint; only a later workflow-setting revision may change that structure. The schema default is never rendered as a guess. -->
<!-- FNXC:PlannerOversight 2026-07-04-19:10: FN-7539 fix — the badge was rendering on virtually every card because the schema default `autonomous` tier was treated as "meaningfully configured". Narrowed the gate so an inherited (no per-task-override, no non-default workflow tier) `autonomous` level renders no badge; only an explicit per-task override or a resolved workflow/effective tier that is not the plain inherited default surfaces the badge. -->
- Task cards show a read-only **oversight-level badge** (`Observe`, `Steer`, or `Auto-recovery`) in the meta-badges cluster when active oversight is structurally known: an explicit per-task override renders immediately, while a later revisioned workflow-setting event may add or update inherited `observe`/`steer` (`data-testid="card-oversight-badge"`). The unversioned initial workflow-tier request cannot grow an already-painted card. A card that merely **inherits** the schema default `autonomous` tier renders no badge and no empty `.card-meta-badges` shell; unresolved and explicit `off` states do the same.
<!-- FNXC:PlannerOversight 2026-07-04-HH:MM: FN-7542 removed the FN-7516 active-overseer-state ("Executor") indicator described above as unwanted per-card noise — it fired on nearly every in-progress card. The oversight-level badge documented above is unaffected. -->
<!-- FNXC:PlannerOversight 2026-07-11-00:00: FN-7592 reintroduced a compact active-overseer state indicator as an Eye glyph instead of a wide text badge, using the engine-provided transient plannerOverseerState rather than locally guessing from task fields. -->
<!-- FNXC:PlannerOversight 2026-07-18-01:35: FN-8255 requires the transient card Eye to use the same meaningfully-configured gate as the level badge. A workflow declaration-default autonomous tier reached purely by inheritance (no explicit task override) is suppressed even with a stale non-idle runtime snapshot; the Eye and otherwise-empty card-header-badges shell remain absent. -->
<!-- FNXC:PlannerOversight 2026-07-17-15:50: FN-8251 requires selected-workflow cards to resolve inherited oversight from their trusted board workflow ID when aggregate workflowBadge metadata is absent. Identity-less, pending, failed, and malformed inherited resolution fails closed: the Eye and otherwise-empty card-header-badges wrapper appear only after active effective oversight is positively resolved. -->
<!-- FNXC:TaskRevert 2026-07-16-00:00: FN-8066 adds durable source-task revert provenance to the shared board/List TaskCard footer. -->
- Completed task cards show a compact **Reverted** footer chip after a clean or already-reverted git outcome has persisted the source task's revert marker; conflicts, AI undo tasks, and revert PRs awaiting merge do not show it.
<!-- FNXC:PlannerOversight 2026-07-18-13:35: Successful workflow-setting writes immediately invalidate task-card oversight resolution, and completed effective values are never reused across card remounts, so an earlier active value cannot authorize the Eye after oversight turns off. -->
- Task cards show a compact **planner-overseer eye badge** (`data-testid="planner-overseer-state-badge"`) only when the engine reports a non-idle, non-off transient `plannerOverseerState` **and** the task's effective oversight is positively resolved as active and meaningfully configured. The eye uses the same inherited-default suppression as the oversight-level badge: a workflow declaration-default `autonomous` tier with no explicit per-task override shows neither eye nor an otherwise-empty `.card-header-badges` wrapper, while an explicit per-task `autonomous` override or resolved `observe`/`steer` tier can show it. Aggregate cards resolve inherited oversight through their task workflow badge; selected-workflow board cards resolve it through their trusted board workflow ID. Identity-less cards and pending, failed, or malformed inherited workflow-setting loads fail closed. Successful workflow-setting writes invalidate that resolution immediately, and completed values are not retained across card remounts, so changing a workflow to `off` cannot leave an eye authorized by an earlier active value. When effective oversight is off or cannot be positively resolved, the eye badge and otherwise-empty `.card-header-badges` wrapper are both absent. This matches—but does not alter—the combined on/off state named by the Task Detail **Oversight** heading in the header Actions overflow. The eye badge is an active-overseer state marker, not a human-read/view indicator: `watching` means passive monitoring, `steering`/`recovering` mean active guidance or recovery is underway, and `awaiting-confirmation` means a human decision is required before the overseer can continue. Hover exposes the composed tooltip with the overseer's reason, watched stage/signal, and pending-confirmation note when present.
<!-- FNXC:TaskDetailHeaderActionsDocs 2026-09-16-18:07 (FN-470, supersedes 2026-09-11-17:35): Task Detail keeps the flat Actions list in one icon-only header overflow, now as the ONLY header action surface: the lifecycle icons, Edit task and Pop out were appended to the end of that list so the quick-control head order and its opening autofocus are unchanged. Only the close control (and the phone Back arrow) remain directly visible. -->
- The header overflow ends with the relocated lifecycle actions in the order **Duplicate**, **Retry**, **Delete**, **Pause/Unpause**, **Reset**, then **Edit task** and finally **Pop out**; each keeps its previous eligibility rule, handler, and historical testid (`task-detail-header-action-<id>`, `task-detail-pop-out`). **Pop out** is omitted in phone presentation. In edit mode the header renders only its close control.
- The Task Detail header's icon-only **Actions** overflow starts with labeled quick controls in Quick Add order: **Attach file** (`data-testid="detail-inline-attach"`), the eligible-task **GitHub tracking** toggle (`data-testid="detail-inline-github-toggle"`), **Oversight**, **Priority**, and **Execution mode**. Attach opens the existing attachment picker; GitHub writes the existing tracking setting and is omitted for GitLab-tracked or non-editable tasks. Oversight begins with a non-interactive `Oversight: on/off` heading (`data-testid="detail-actions-oversight-heading"`), followed by flat level choices (`data-testid="detail-oversight-level-<value>"`) that write the per-task `plannerOversightLevel` override or clear it through **Inherit**. The list then retains the Session advisor toggle, manual Nudge (`data-testid="detail-overseer-nudge"`), confirmation-gated Stop (`data-testid="detail-overseer-stop"`), and Explain (`data-testid="detail-overseer-explain"`). Explain opens the same read-only panel (`data-testid="detail-overseer-explain-panel"`) inside the central content region. These controls keep their existing API routes, enablement rules, disabled-reason text, and persistence handlers. The entire Oversight group is withheld for an unresolved task with no session-advisor applicability; an advisor-only unresolved state shows only the heading and advisor toggle until lifecycle oversight resolves.
<!-- FNXC:PlannerOversight 2026-07-04-20:30: FN-7546 clarifies the cluster above — operators reported the buttons were unlabeled and looked inert, with only a hover title explaining why. Adds a visible group label and an always-visible disabled-reason line, and makes Explain always openable since it never mutates anything. -->
- In an editable Task Detail, clearing a previously populated description and saving starts the standard task deletion flow instead of saving a blank description. **Settings → Global → General → Skip confirmation dialogs for critical actions** controls this deletion just as it controls other destructive task actions: disabled shows the centralized confirmation dialog; enabled accepts its primary deletion action without showing a dialog.
- The Oversight entries inside the header Actions overflow carry a visible, non-interactive **`"Overseer controls"` group label** (`data-testid="detail-oversight-controls-label"`) so Nudge, Stop, and Explain remain identifiable. The label uses the same resolved-and-active gate as those actions and leaves no empty shell when oversight is Off or unresolved. When **Nudge** is disabled, an always-visible note (`data-testid="detail-overseer-nudge-disabled-reason"`) states the reason in-DOM. **Explain** remains read-only and opens its panel even when the overseer is inactive; Nudge's human-control suppression and Stop's confirmation remain unchanged.
- The flat header Actions overflow is the single canonical secondary-action surface at every desktop and mobile viewport. It preserves the existing action and option testids while removing the retired `detail-oversight-menu-trigger`, `detail-oversight-level-select`, and priority-trigger popover contracts. Menu-open auto-focus lands on the first enabled action, and every action selection follows the same close behavior.
<!-- FNXC:PlannerOversight 2026-07-04-18:00: FN-7519 adds a read-only Intervention Timeline. FN-7571 (2026-07-04-19:00) relocates it from an inline mount below the FN-7517 controls into the task-detail Activity view dropdown as a fourth "Interventions" segment, alongside Live/Feed/Raw; FN-230 adds Summaries after it as the fifth option. -->
- The task detail modal's **Activity** tab view dropdown lists Live, Feed, Raw, conditional Interventions, and Summaries in that order. The fourth **Interventions** option is shown only when planner oversight is active for the task (same gate as the former inline mount: `(hasTaskOversightOverride || workflowOversightResolved) && !oversightIsOff`). Selecting it renders the **Intervention Timeline** (`data-testid="planner-intervention-timeline"`) inside the Activity panel, listing every recorded planner-overseer intervention for the task, newest-first: watched stage, reason, action taken, outcome (with a `.status-dot` indicator using semantic outcome tokens), an attempt count/limit badge (only when both are present), and source links (agent log / review comment / failed check / merge error / PR state / generic URL). It renders a calm "No planner interventions yet" empty state rather than an empty shell when there are none. When oversight is off or unresolved, the Interventions option is absent from the dropdown entirely (no leftover empty segment), and if it was previously selected the view falls back to Live rather than leaving a blank panel. Entries are read via `GET /tasks/:id/overseer/interventions`, which assembles them from the existing run-audit store under the `overseer:intervention` mutation type (`recordPlannerIntervention`/`getPlannerInterventionTimeline` in `@fusion/core`). This is a pure read surface — FN-7520 wires the actual intervention-producing call-sites.
- Every task-detail **Activity** entry in Live, Feed, Raw, and Interventions shows the exact local clock time to the millisecond next to its relative label where one exists; hovering the precise time shows the full local date and time, and entries from another day include their calendar date. The agent-detail log viewer uses the same treatment on desktop and mobile.
- Task detail surfaces show the selected/effective workflow identity near the task's workflow controls so individual cards remain understandable when Board is in **All workflows** or another aggregate/mixed context.
- Board task cards support a context menu from right-click, keyboard context menu / Shift+F10, the visible ⋯ button, or touch long-press for detail-aligned lifecycle actions without changing normal card clicks. The menu opens as an independent overlay so it stays visible beyond the card or column edge while remaining clamped to the viewport. It stays open until an action is selected, the operator clicks outside, presses Escape, or intentionally scrolls the board. On mobile, long-press opens that menu without selecting card text or showing native copy/paste callouts. Selecting an action applies that exact action once and dismisses the menu. Task context menus offer follow-up and recovery actions only: they never contain **Plan** or **Merge & Close** / **Finish & Close**, because the engine drives planning and delivery automatically. The explicit manual merge command remains the Task Detail review footer button. Completed card context menus include **Refine**, which opens a small standalone refinement composer for the same task — the task record itself is not opened, nothing is dimmed behind the composer, and it stays exactly centred in the viewport until the operator uses an explicit close path, Escape, or an enabled backdrop dismissal. **Reset** uses the same centred, unpainted presentation.

### Follow-up: preparing the next task from one that is still running

**Follow-up** appears on a task that is still going, and asks for a *separate successor task* rather than more work on the current card. It is offered on implementation and review cards, and — only when that task's plan review has actually approved the current plan — on planning cards too. An approval that a later review round replaced, a gate that was skipped, an operator bypass, and a card that is being re-planned all withhold it, because there would be no approved plan to build on. Terminal cards keep **Refine**; a review card shows **Follow-up** in its place rather than both, and a card in an unsupported state shows neither.

It opens the same small centred composer as Refine, from the same places: a board card, a List row or card, and Task Detail's **Actions** menu. What you type becomes the new task's own request.

The new task is created immediately, depends on the task it came from, and appears on the board as a **Follow-up of** that task. When Fusion plans it, the planner is given the source task's plan and its progress at that moment — including which steps are still only planned rather than delivered — so the follow-up is specified as the *next* piece of work instead of a repeat of the first. If the source is re-planned or moves on before the follow-up is planned, the follow-up's planning reads the source again rather than an older copy.

The source task is never interrupted, paused, retried, moved, or edited by any of this. The dependency Fusion records is an ordinary one and follows the ordinary rules: the follow-up does not start while its source is still being implemented, while a source that has reached review can already release it — Follow-up does not promise a wait until the source has merged. If the source finishes between opening the menu and submitting, Fusion refuses the request and keeps what you typed so you can copy or adjust it.
<!-- FNXC:BoardCardActions 2026-06-29-00:00: Board card context menus are documented as alternate entry points only; normal click still opens task detail, and mobile long-press must not trigger detail behind the menu.
FNXC:TaskDetailRefine 2026-07-12-00:00: The Refine feedback modal must not be dismissed by the same mouse/touch interaction that opened it; backdrop dismissal follows the global default-off modal-dismiss preference.
FNXC:TaskRefine 2026-09-14-22:23: FN-400 — Refine and Reset open their own centred dialog with no task modal and no painted backdrop. Cards, list rows, and Task Detail each host the shared composer directly, so the refine deep link that opened a task record purely to reach it is removed.
FNXC:TaskContextMenu 2026-07-01-00:00: Board/List touch context-menu item taps must invoke the selected action exactly once and close the menu, matching desktop right-click and keyboard context-menu activation.
FNXC:TaskContextMenu 2026-07-01-00:00: Board card context menus must behave like independent overlays because Board columns intentionally clip and scroll their bodies for kanban containment.
FNXC:TaskCardMobileSelection 2026-07-01-00:00: Mobile Board long-press is a task-action gesture, not a text-selection gesture; document that the native selection/copy callout is suppressed while normal card clicks and edit textareas keep their behavior.
FNXC:TaskContextMenu 2026-09-15-10:40: FN-417 removed Plan and Merge & Close / Finish & Close from every task context menu on every host and breakpoint, because the engine plans and merges automatically. Merge completion is opt-in in the shared menu model and only Task Detail opts in, keeping its review footer button as the single manual merge command. The other Planning Mode entry points (inline create, quick entry, New Task, GitHub import) are unchanged. -->
<!-- FNXC:WorkflowBadges 2026-06-30-09:10: Task cards and task detail need workflow-name badges wherever mixed-workflow board contexts can hide the selected lane, especially the Board-only All workflows aggregate. -->
<!--
FNXC:TaskColumnSorting 2026-08-18-21:24:
Every Board lane exposes the same actions-menu sort selector. Arrival means newest durable
columnMovedAt, falling back only for legacy rows to updatedAt and then createdAt; the choice is
Board-local and is not persisted as a project setting. Complete lanes are request-backed because
Done history is sliced into bounded server pages while retaining a deterministic global order.
-->
<!-- FNXC:PlanApproval 2026-07-01-08:47: Operators need the Board Planning/intake column action menu documented as a binary shortcut for project plan auto-approval while Settings remains the full workflow/auto-approve/require-all editor.
FNXC:PlanApproval 2026-07-07-00:00 (FN-7653 correction): the switch is intake/planning-column-only — it must not appear on hold (Todo-like) columns, even though hold columns also gate planning-adjacent behavior. The built-in Coding (Auto) workflow's Todo column (hold trait) was wrongly showing this control; docs now match the corrected intake-only gating.
FNXC:TriageRename 2026-07-08-00:00 (FN-7660): the board column formerly labeled "Triage" is canonically "Planning"; docs refer to it as the Planning column throughout. -->
- The Planning column actions dropdown includes **Auto-approve plan**. Turning it on sets the project plan approval mode to auto-approve all planned tasks; turning it off returns to the workflow/default plan approval behavior. In workflow-mode Boards, the same switch appears only on the intake/planning column and on the equivalent **All workflows** aggregate intake column — not on hold (Todo-like) or other lifecycle columns. Use Settings → Merge for the full three-state project control, including **Require approval for all tasks**.
- Column ordering semantics (FN-509): there is no per-column sort choice and no column actions menu. Every lane uses one shared order, resolved from the column's own traits:
  - A **manual-intake** lane (an `intake` column with `autoTriage: false`, such as Coding (Ideas)'s "Ideas") shows the newest card first, with a deterministic descending task-id tie-break.
  - A **Complete** lane shows the most recent ARRIVAL first (`columnMovedAt`, then `updatedAt`, then `createdAt` for legacy rows) and is served in bounded server pages with an exact total. It is deliberately not re-sorted by creation date.
  - Every **processing** lane (planning holds, WIP, review/merge) shows genuinely ACTIVE cards first, then the whole waiting queue in the shared order: an effective **Boost** first, then oldest `createdAt` first, then the task-id tie-break. This is exactly the order the engine tries candidates in. Active cards are ordered among themselves by arrival, and a Boost never moves a waiting card ahead of work already in flight.

  Ordering is applied by the server BEFORE any page limit. Alongside the generic board page, each visible lane requests its own ordered head (`GET /tasks/page?columns=<lane>&order=queue|intake`), so a boosted card — or a newly captured idea — still reaches the top of its column on a project whose live work exceeds one page. Those lane pages only ADD rows to the board's snapshot: an id the board already holds keeps its live value, and a lane that cannot be read simply contributes nothing. Each lane continuation is an opaque server cursor bound to that project, lane and order; replaying it under a different lane or order is rejected rather than interleaved.

  Ordering never mutates a task or refreshes `columnMovedAt`. The retired **Replan All**, **Stop All** and auto-approve shortcuts lived in that removed menu; the individual operations and their endpoints are unchanged, and the **History** button was always an independent header control.

- **Delivery lock (FN-514)** — the review column no longer carries an **Auto-merge** toggle. That was a project-wide switch on a lane header: it could not answer the question an operator actually has about one card, and flipping it silently changed every other card's delivery. Delivery is now decided per task.

  **Arming it.** The lock button (a padlock, next to plan approval) is in the New Task dialog, Quick Add and the inline create card. It can also be added or removed later from the card's own menu — on the board, in List view and in Task Detail — for any live card, including Ideas, Planning, In Progress, review, paused and failed ones. It disappears only once delivery has actually started or the card is complete; sitting in the merge queue is not a started delivery, and the server refuses a change that races a merge owner. A padlock badge shows the state on cards and list rows: approval required, decision recorded, or rejected.

  **Deciding.** A locked card plans, executes, verifies and passes every configured review exactly as before, then stops at the final delivery. When everything else is genuinely satisfied, Task Detail shows one text field and exactly three buttons, in this order:

  1. **Create PR** — opens (or reuses) a pull request for this task's repository, head and base, keeps the card in review, and shows the link. It does not merge, does not run `pr-merge`, and never arms GitHub's native auto-merge. Merging afterwards still needs a fresh **Merge** on the current content.
  2. **Merge** — delivers the reviewed work now, through the same merge path and the same protections as before.
  3. **Reject** — requires instructions and starts a correction cycle on the same task.

  The note is **optional** for the two positive commands and **required** for a rejection. Enter inserts a newline: it never merges. An action the server cannot carry out (no GitHub connection, no remote, a task spanning several repositories) stays visible and disabled with the reason; **Reject** never depends on GitHub.

  **After a rejection.** Your instructions become real work on the same card: either targeted fixes, or — when a requirement was missed or an approach is wrong — a replacement approach recorded as an amendment plus the steps that execute it. Nothing is lost: the branch, the worktree and the finished steps are kept, no second task is created, and the card never goes back to Planning. The checks and reviews then run again and ask you for a new decision.

  **What did not change.** The project **Auto-merge** setting, the PR and branch-group policies, and existing per-task `autoMerge` overrides keep their meaning and are still edited in Settings. A card with no lock behaves exactly as it always did.

- **Boost** (FN-509): a text button on a live, non-active card in a lane whose remaining processing is automatic. It moves that card to the head of its queue and does nothing else — no column move, no start, no retry, no pause release, no gate cleared. A boosted card that is still blocked by capacity, an overlapping file scope, a dependency, an approval, a pause, or a retry cooldown keeps its place while admission moves on to the next admissible candidate. A Boost belongs to the card's current stay in its current column of its current workflow: it survives the phases of that stay (planning, then waiting for capacity) and expires on a column move, a workflow change, or Reset. The rank is durable and shared, so every client and a restarted engine see the same order. The button is absent on manual intake, on Complete lanes, on history, on deleted cards, on work already in flight, in a column with no automatic processing, and on a review lane that is a purely human wait after auto-merge is disabled — unless an automatic review still has to run there. It is always laid out rather than revealed on hover, so it stays reachable on a touch device, and activating it never opens the task detail or starts a drag.
- The choices are independent and Board-local: changing Planning, Todo, In Progress, a review lane, a complete lane, or a renamed/custom workflow lane leaves every other lane's choice unchanged and does not create a persisted project preference.
- Complete lanes use the bounded PostgreSQL Done endpoint. The server orders the full project-scoped history before each 50-row page, so approaching the scroll edge automatically continues the deterministic global order while the column header keeps the exact total count.
- On mobile, both default and workflow-mode boards fill the project viewport while the column strip remains the internal horizontal scroller with contained edge overscroll.
<!-- FNXC:WorkflowSelection 2026-06-29-13:34: Board, List, Header, and Graph workflow selectors now share a durable per-project selection so operators return to the same lane after remounts, task refreshes, or respecification flows; stale saved workflow ids must fall back to a valid default/first workflow instead of hiding all tasks.
FNXC:DisabledBuiltinWorkflows 2026-08-19-00:18: Settings General requires at least one enabled normal built-in. The shared board-workflows payload marks currently selectable definitions separately from disabled definitions retained for explicitly assigned existing tasks, so every responsive picker hides disabled built-ins without losing card metadata. -->
<!-- FNXC:WorkflowSelection 2026-06-29-18:37: The All workflows option renders an aggregate column/task set across workflows while keeping workflow-specific creates and edits scoped to real workflow ids.
FNXC:WorkflowSelection 2026-06-30-00:00: The view preference persists either a real workflow id or the All workflows sentinel so refresh/remount restores the operator's last top-level workflow context without treating the sentinel as a backend workflow id.
FNXC:WorkflowSelection 2026-07-01-00:00: All workflows is available on Board, List, Planning, Missions, and Graph top-level selectors; Planning/Missions task creation receives default/no-specific-workflow behavior instead of the sentinel. -->
<!-- FNXC:WorkflowSelection 2026-06-29-23:58: All workflows quick-create must use a real workflow intake/default column rather than a synthesized lifecycle column, so custom-default boards do not create tasks into invalid or disappearing columns. -->
<!-- FNXC:WorkflowSelection 2026-06-29-23:59: Workflow counts and All workflows grouping resolve each task's effective workflow before evaluating column visibility, so a shared column id hidden in one workflow does not leak that workflow's hidden tasks into another workflow's visible aggregate lane.
FNXC:WorkflowSelection 2026-07-01-23:04: Board/List dropdown counts use computeWorkflowStatusCounts as the single source of truth. The All workflows row reports the helper-owned aggregate exactly once and must not be recomputed by summing the map that already contains the aggregate sentinel. -->
<!-- FNXC:WorkflowSelection 2026-06-29-21:40: Refinement creation from Task Detail and done-task chat must preserve both the source task workflow and the operator's selected Board/List lane, so non-default workflow users do not get bounced back to Coding/default after refinement. -->
- Board and List workflow switchers use a themed dropdown instead of a native select. The closed trigger shows the workflow identity (Fusion icon for built-ins, optional custom icon for custom workflows), name, and chevron only; compact Plan / Progress / Review counts derived from workflow column flags (excluding board-hidden and complete columns) refresh each time the dropdown opens and appear while the dropdown is expanded, including on each workflow option. Review roles take priority over WIP roles. Built-in lanes with synthesized trait-less lifecycle columns fall back to canonical column ids (`todo`, `in-progress`, `in-review`, and `done`), with `done` excluded from those counts. Board and List also show **All workflows** before real workflows as a dashboard-only aggregate view with combined counts that sum only the real visible workflow rows exactly once and a deterministic union of visible workflow columns; shared column ids use the default workflow label/flags when available, otherwise the first workflow definition that declares the column. Hidden columns stay workflow-scoped in the aggregate: a task whose effective workflow hides a shared column is omitted from that aggregate column even if another workflow exposes the same column id. That option persists as top-level workflow view state, and quick-create/Plan/Subtask/Mission handoffs translate it to a real default workflow id or no-specific-workflow behavior so task creation never sends the sentinel. The dropdown is selection-only on every surface: no workflow row exposes an edit action and there is no **New workflow** footer, so the popover contains exactly one list of selectable workflows. The open listbox grows from the longest workflow name plus its count decorations while remaining viewport-bounded; the closed trigger stays narrow and ellipsized. Disabled built-ins are absent from this shared option list, including Header/Planning/Missions and Graph portal variants on desktop or mobile; an existing task explicitly assigned to one remains available in aggregate/card metadata but is not offered as a new-selection row. Those inline count badges intentionally use the same board lifecycle color tokens as cards: `--todo`, `--in-progress`, and `--in-review`.
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
- Bulk Pause / Unpause actions from the selection toolbar (`Pause selected`, `Unpause selected`) for fast batch task state management.
- Bulk delete from the selection toolbar (`Delete selected`); dependency-conflict failures can be force-deleted per task after a danger confirmation that removes dependency references.
- List measures its usable content width before routing an ordinary task open. When that surface has room for both panes, the existing table/detail split opens detail on the right; constrained surfaces use the existing task-detail modal instead. Phones remain single-pane even if a browser reports a large synthetic measurement, and keep handing the task to their single detail owner. On every other viewport an ordinary List open goes to the movable task window instead of either adaptive route, with no setting to enable.
- List rows and tablet/mobile cards support the same task context menu as Board cards from right-click, keyboard context menu / Shift+F10, or touch long-press without changing ordinary row selection or tap-to-open behavior. Selecting an action applies that exact action once and dismisses the menu. Like Board cards, list menus contain neither **Plan** nor **Merge & Close** / **Finish & Close**; they do include **Refine** for completed tasks, and the standalone refinement composer opens centred over the list without opening the task record, and stays open until the operator closes it intentionally.
<!-- FNXC:TaskDetailRefine 2026-07-12-00:00: List-originated Refine uses the same task-detail feedback modal as Board and must preserve the stay-open invariant across desktop and mobile activation.
FNXC:ListView 2026-08-03-05:47: FN-8754 replaces the viewport-only tablet route with measured usable List width. A tablet with room for both existing panes keeps the split detail; constrained List surfaces keep the modal route, while phones remain single-pane and the popup preference takes precedence.
FNXC:ListContextMenu 2026-06-29-00:00: List context menus are alternate action entry points only; desktop left-click still selects the split-pane detail and mobile tap still opens detail while long-press suppresses the follow-up tap.
FNXC:ListContextMenu 2026-06-30-00:20: Keyboard access is part of the Board/List context-menu contract, so docs must include the context-menu key and Shift+F10 alongside pointer and touch entry points.
FNXC:DoneTaskRefine 2026-07-01-00:00: Completed List row/card context menus route Refine to the existing task-detail feedback modal so desktop right-click and mobile long-press share the same refinement flow.
FNXC:TaskContextMenu 2026-07-01-00:00: Mobile List card long-press action taps must select and dismiss through the same shared TaskContextMenu invariant as Board and Task Detail surfaces.
FNXC:TaskContextMenu 2026-09-15-10:40: List row/card menus share the Board removal (FN-417): neither surface offers Plan or merge completion, so List no longer wires a planning route into its row menus at all. -->

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
   Expected outcome: the full-width candidate list stays visible while its title, source link, body, labels or PR metadata, and import controls open in a draggable and resizable detail window. On mobile, that detail uses the shared bounded drawer over the Kanban. When selected title/body content is in another language, the detail offers **Translate**, **Show original** / **Show translation**, and **Dismiss**; translation is display-only. Issue forms are evaluated from their user-provided answers rather than template headings, labels, placeholders, and checkboxes, so foreign-language form content receives the same translation offer. With GitHub import auto-translate enabled, every reachable page of open GitHub issues is translated as you page through the fetched list (up to the 300-issue fetch cap per one-hour translate budget); repeat views use the translation cache. While a page is translating, the issues list shows a **Translating…** status indicator and surfaces any translation failure without blocking import or browsing. Manual **Translate** uses the dedicated translation budget and configured translation model lane, not the refine/draft helper budget. Its result is cached durably by provider, repository, item, locale, and source content: it reappears automatically on reselect, reopen, and reload without another model request, remains available to the import path, and is discarded when content changes or the item closes. Pull request and GitLab lists retain the per-selection translation flow. A pull request preview also shows its checks; use **Refresh checks** to fetch current GitHub check status and comments without reopening the detail. Each failed check has a **Create fix task** action that creates a new task prefilled with the repository, PR, branches, check status, and check-details link.
<!--
FNXC:GitHubImportDocs 2026-07-17-12:00:
Import Tasks documentation distinguishes Add comment (an upstream GitHub mutation) from Import as task
(existing-comment conversion), so operators can respond in place without expecting a new Fusion task.
-->
5. In an issue detail, use **Add comment** to write a new upstream GitHub comment. The composer remains available for open and closed issues; posting adds the comment to the preview thread immediately. This is separate from **Import as task**, which creates a Fusion resolve-feedback task from an existing GitHub comment.
   Expected outcome: Fusion posts the new comment to GitHub, keeps its inline composer available for another response, and shows a success or retryable error message without leaving Import Tasks.
<!--
FNXC:GitHubImportDocs 2026-07-30-00:00:
GitHub issue detail offers direct import and Planning Mode; both preserve source provenance, while Planning retains the richer reviewed specification.

FNXC:GitHubImportDocs 2026-07-30-12:00:
GitHub issues and pull requests also offer Chat so operators can discuss the selected upstream link without creating a Fusion task. The link is prefilled, never auto-sent, and GitLab retains its import-only action bar.
-->
6. In a GitHub **issue** detail, choose **Import as task** to create the board task directly, **Plan** to open Planning Mode with the issue title, body, and source URL, or **Chat** to prefill the selected issue link. A planned task records the same GitHub source provenance as direct import and preserves the original body in its task description and document. GitHub tracking is enabled when `githubLinkImportedIssuesToTracking` or the resolved GitHub tracking default is on. If a live task already represents the issue, Planning still records truthful provenance but suppresses the second tracking stream; exclusive adoption makes concurrent plans converge on one linked issue. Planning captures issue and already-loaded comment image references when **Plan** is pressed and downloads them after task creation without re-fetching GitHub; when comments are not loaded yet, only issue-body images are captured. Breakdown subtasks preserve the source text but do not each link, track, or duplicate issue attachments. Chat does not create a task or send a message. Pull requests continue to use **Resolve feedback** for task creation and also offer **Chat** with their selected PR link prefilled. The Chat action is GitHub-only; GitLab import actions are unchanged. Each GitHub issue and pull-request comment also has **Import as task**, which creates a separate resolve-feedback task quoting that comment and linking its source without closing the detail window.
   Expected outcome: direct import and Plan create source-aware tasks; Plan opens the docked Planning Mode interview with retained issue context, while duplicate source tracking remains singular; Chat opens a focused composer ready for an operator question; comment imports remain available for further feedback.

Leaving and returning to **Import Tasks** (for example switching to Board and back) restores the prior context for the current project — provider (GitHub/GitLab), active Issues/PRs tab, label filter, selected repository/remote, GitLab project/group inputs, the **Hide imported** preference, and the previously selected issue/PR — instead of resetting to defaults. When GitLab integration is disabled in Settings, the GitLab provider tab is hidden and any restored GitLab provider preference opens on GitHub instead; saved GitLab URLs and tokens remain configured. The restored selection re-validates against the freshly reloaded list; a selection that no longer exists (e.g. the issue was closed upstream) clears gracefully rather than showing a stuck or empty preview. First-time opens with no prior state keep the existing default-remote auto-detect behavior. State is scoped per project and does not leak across projects.

Use GitHub import on mobile:

1. Open the compact Header actions or bottom **More** sheet and select **Import from GitHub**.
   Expected outcome: the same import workflow opens in the mobile modal layout.
<!--
FNXC:GitHubImportDocs 2026-07-23-13:20:
The mobile issue detail preserves the complete Close issue, Plan, Chat, and Import as task action set
on one touch-safe row. Labels may wrap inside their own actions rather than being hidden or moved to
an inaccessible second row.
-->
2. Choose the repository, issue/PR tab, candidate row, and detail action. For GitHub issues, choose **Import as task** for direct tracked creation or **Plan** to start Planning Mode with the issue context.
   Expected outcome: direct import creates the board task with GitHub provenance/tracking metadata; Plan creates the same source-aware planned task, subject to the same tracking settings and single-tracker duplicate rule. Plan captures issue and already-loaded comment image references when it is pressed, then downloads them after task creation without re-fetching GitHub; if comments are still loading, only issue-body images are captured. Breakdown children retain text only rather than creating multiple issue links or duplicate attachments. When all GitHub issue actions are available, their full labels remain on one touch-safe action row.
3. While a candidate detail sheet is open, use the platform Back gesture or control.
   Expected outcome: the first Back dismisses only the issue, pull request, or GitLab detail and returns to the import candidate list; a second Back dismisses the import form.

<!--
FNXC:GitHubImportSwipeBack 2026-07-28-12:00:
Mobile import detail sheets are a nested navigation layer, so documentation must distinguish Back-to-list from the subsequent Back-to-dismiss-import-form action.
-->

## Graph View

Graph view visualizes task dependencies as an interactive node/edge map.

Navigation:
- Desktop/tablet: left sidebar or applicable plugin/content navigation entry for **Graph** when the dependency graph surface is enabled
- Mobile: **MobileNavBar → More → Graph**

Behavior:
- Shows only tasks in `triage`, `todo`, `in-progress`, and `in-review`
- Excludes workflow Complete columns
- On desktop/tablet, the header workflow dropdown mirrors Board/List selection behavior, restores the same per-project saved workflow when available, and filters graph nodes to tasks assigned to the selected workflow; **All workflows** restores the full active-task graph.
- Uses Sugiyama-style layered auto-layout to place nodes by dependency depth
- Renders directed bezier dependency edges (dependent → dependency) with arrowheads
- Supports cursor-centered wheel zoom, pinch zoom, keyboard shortcuts (`Ctrl/Cmd+=`, `Ctrl/Cmd+-`, `Ctrl/Cmd+0`, `Ctrl/Cmd+Shift+F`, `Escape`), and fit/reset controls via the floating toolbar with live zoom percentage
- Pan limits are zoom-aware and based on full graph extents (including negative auto-layout origins), so zoomed-in views can still pan to every rendered node instead of getting trapped by fixed viewport-only bounds
- Dependency graph nodes reuse the same `TaskCard` UI as board/list views, so status badges, progress/steps, mission badges, retry/delete/revert controls, and active-task glow stay visually consistent
- Active graph nodes also add a dedicated top status indicator bar and current-step row highlighting so in-progress execution state stays visible even when zoomed out
- Clicking a graph card opens task details in the shared movable/resizable task pop-out via the host detail handler (`onOpenDetail`, with `onOpenTaskDetail` fallback), while clicking the same card again or empty canvas clears selection.
- On touch devices, single-tap is reserved for pan/drag gestures, so double-tapping a node opens the same shared task pop-out; this does not change selection state.
- Hovering or selecting a node highlights its full upstream and downstream dependency chain; highlighted nodes and connecting edges are emphasized while non-chain nodes are dimmed, and highlight clears when hover/selection is removed
- Nodes support manual drag repositioning with a 4px movement threshold to separate click from drag, using pointer capture and zoom-aware delta scaling for reliable tracking
- Custom node positions persist per project in browser localStorage (`kb:${projectId}:fusion-plugin-dependency-graph:positions`) across refresh/project switches, and **Fit to graph** clears saved positions and restores auto-layout

## Workflow Selection and Editor

<!-- FNXC:WorkflowAndModelSettings 2026-09-14-19:11: Project/global model roles belong to the main Settings modal in Default, Planner, Executor, Reviewer, Merger order; the workflow editor owns only workflow-specific settings, and built-in revisions keep a stable public workflow id. -->

Workflows define how a task moves through planning, execution, review, workflow steps, merge, and any custom graph policy. Most coding tasks can stay on the default Coding (Auto) workflow, but task and board workflow controls can choose a different built-in or custom workflow per task. Shipped revisions retain each built-in's stable ID; Coding (Ideas) remains `builtin:coding-ideas` rather than exposing revision-suffixed successor entries. For the built-in catalog and runtime semantics, see [Workflow Steps → Workflow overview](./workflow-steps.md#workflow-overview).

<!-- FNXC:NewTaskWorkflowDropdown 2026-06-30-18:52: The full New Task dialog workflow picker now matches the icon-rich workflow identity used in Board/List selectors while preserving create-time workflowId semantics. -->
When creating a task from the full **New Task** dialog, the **Workflow** advanced control opens a styled dropdown instead of a native select. Built-in workflows show the Fusion mark, custom workflows show their configured compact icon when present, **No workflow** remains the explicit opt-out, and leaving the picker untouched still inherits the project/default workflow. Opening the dialog while viewing a specific Board or List workflow preselects that workflow across lane, sidebar, keyboard-shortcut, and description-seeded entry points; opening from **All workflows** instead leaves the picker unset so the project default applies. The selected workflow is preserved when you choose **Create** or acknowledge a duplicate warning.

Manual-intake workflows also expose **Start** beside **Create** only when the server-provided workflow metadata proves a safe working destination. Coding (Ideas) creates directly in its validated working lane; other manual workflows create in intake and then perform one validated move. Start reports tasks as queued for planning, not as already planning, and a failed follow-up move reports the created-but-not-started partial outcome without deleting the task.

The **Duplicate** action on Task Cards, List rows, and Task Detail shows a workflow picker when at least two enabled workflows are available. It lists only selectable workflows, preselects the task's current workflow, and routes the copy to the chosen workflow. With fewer than two enabled workflows, the dialog remains a plain confirmation and the copy inherits the source task's workflow automatically.

<!-- FNXC:WorkflowOptionalSteps 2026-07-10-08:00: Operators can now toggle optional workflow steps from the task Edit form as well as the Workflow tab. Edit mode must load the task's resolved workflow catalog without re-seeding from defaultOn, preserving the task's persisted enabledWorkflowSteps until the operator explicitly toggles a step. -->
Optional workflow steps can be toggled from the task **Edit** form's **More options → Workflow Steps** control or from the task's **Workflow** tab. The edit form uses the task's resolved workflow and preserves the task's current stored selection when it opens; workflow-authored `defaultOn` values remain a create-time/runtime default, not an edit-form re-seed.

The workflow editor is a single surface: the **Workflows** view. It never opens as a floating window or modal over another screen — every entry point navigates to that same view, and mobile renders it as the shared full-screen sheet.

Navigation (all of these reach the identical Workflows view):
- Use **Workflows** in the desktop/tablet left sidebar or header, compact mobile actions, or mobile **More** navigation.
- Use **Edit workflow** on a task's Workflow tab to open that task's workflow.
- From Settings moved-setting stubs, choose **Open workflow settings** to open workflow-owned settings. Project and global model roles remain in the main Settings modal.
- Create a workflow with **New workflow** in the Workflows view header. The Board/List/Graph/Header workflow dropdown only switches the active workflow; it previews each workflow's Plan / Progress / Review task counts inline before switching.

Behavior:
- Opens a workflow node editor with a workflow list/sidebar, canvas, inspector, and settings/authoring panels
- Built-in workflows are inspectable in the same canvas as custom workflows, including connected success, failure, and rework edges for their graph topology. Their graph structure stays read-only, but prompt/gate node Prompt fields can be edited per project and reset to the shipped default from the node inspector or expanded prompt editor.
- Custom workflows can be created from blank, duplicated from built-ins/custom definitions, imported/exported, AI-designed, validated, and saved from the editor. Custom workflows can carry an optional compact plain-text icon; built-in workflow rows use the Fusion mark instead of a textual built-in suffix.
- Optional-group node inspectors include controls for `defaultOn` and per-step **Max revisions** (`maxRevisions`), including an **Unbounded** toggle for Code Review, Browser Verification, or custom pre-merge gates that should keep cycling until they approve.
<!-- FNXC:WorkflowEditor 2026-06-29-20:09: Optional-group containers are visual boundaries in the workflow editor. Top-level workflow edges attach to the group boundary, while template-child edges remain inside the group so operators can distinguish optional-block connectivity from the inner step implementation.
FNXC:WorkflowEditor 2026-06-29-21:10: Optional-group template entry/exit ownership remains visual-only. Non-editable boundary connector lines must explain how template children attach to the container without persisting fake edges into workflow IR. -->
- Optional-group, foreach, and loop containers show their template nodes inside the block. Canvas connections between the surrounding workflow and the block attach to the container boundary; connections between template nodes stay inside the block. Optional groups also draw non-editable entry/exit connector lines between the boundary and the template entry/exit nodes so single-step blocks such as Plan Review and Code Review do not look disconnected; those visual connectors are not saved into workflow IR.
- The Settings panel is value-first for built-in workflows and groups workflow settings by Models, Review & Approval, Step Execution, and Advanced. Workflow-specific Planner, Executor, Reviewer, and Merger overrides use the shared model dropdown; each role keeps its primary selection, fallback, Thinking Level, and Credential instance together. These values affect only the workflow currently open. Custom or non-model string values still use typed inputs, and Definitions remain available for custom workflow schema authoring.
- The main Settings modal presents **Default**, **Planner**, **Executor**, **Reviewer**, and **Merger**, in that order, under both Global Models and Project Models. Default exists only at global/project scope. Project rows save directly to project settings; they are never written to the active default workflow. Effective role resolution is task → selected workflow → project role → global role → project Default → global Default. **Title Summarization** and its fallback remain under **AI Title and Git Commit Message Summarization** with their enable toggles.
- On desktop, the editor uses a multi-panel canvas layout for editing the graph and adjacent workflow metadata. The **Show simple editor** toggle switches that same workflow into the graph-outline editor with dedicated **Graph**, **Add**, **Settings**, **Fields**, **Columns**, and **Actions** tabs.
- On viewports `<=768px`, the editor switches to a full-screen mobile sheet. Global workflow entry points open to the workflow list with no workflow preselected and prompt users to select a workflow to edit; entry points that name a workflow (such as a task's **Edit workflow**) open directly to that workflow when it is available.
- Simple/mobile editing uses a graph outline instead of making the canvas the primary control. The outline shows nodes, branch/rework edges, column placement, and optional-group/foreach/loop template children as tappable rows and chips that open the same node and edge detail editors as desktop. The structural **start** node opens an inspector for the workflow entry column when the workflow defines columns; the **Name** field remains unavailable because the start label is structural. For custom workflows, editable outline rows also expose **Move up** and **Move down** controls that reorder steps within their current column or template parent; built-in workflows remain read-only and hide those controls.
- Simple/mobile authoring exposes dedicated destinations for **Graph**, **Add**, **Settings**, **Fields**, **Columns**, and **Actions**. Add includes the node palette plus fragments, built-in step templates, and plugin step templates; Actions includes save, AI edit, auto-layout, export, and delete for custom workflows, plus export and duplicate for built-ins. Settings keeps the Definitions/Values tab split.
- The create-workflow dialog and workflow AI authoring popover follow the same mobile full-screen/sheet pattern so they are not clipped by the editor canvas on narrow screens

## Custom Providers

Custom Providers live in **Settings → Authentication → Custom Providers**, inside the **Advanced: Custom Providers** disclosure. Use this section to add user-defined model providers that speak an OpenAI-compatible API, the OpenAI Responses API, an Anthropic-compatible API, or Google Generative AI. After a provider is saved with models, those models become selectable in model dropdowns, including the project/global role rows and workflow-specific role overrides in the workflow editor.

A saved custom-provider configuration counts as AI setup for startup onboarding and the readiness warning, even when no built-in provider is authenticated. This readiness signal contains only whether persisted entries exist; custom providers are not duplicated as built-in authentication cards. An empty or missing custom-provider list does not suppress the normal missing-provider setup prompt.

### Refresh built-in provider models

The Authentication section also includes one **Refresh Models** action for built-in providers. It is available in both the modal and embedded Settings presentations, including narrow layouts, and performs a deliberate bounded refresh rather than background polling. When the refresh completes, Fusion updates the shared model cache so already-open model pickers show the new built-in catalog without a restart. A timeout, failure, or deferred refresh keeps the last available catalog visible and reports that truthful outcome so the operator can try again. This is separate from the saved custom-provider row-level **Refresh Models** action below, which queries that provider's endpoint.

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

Expected outcome: the provider appears in the Custom Providers list with its API type and base URL. Each saved model is then available as a `{provider}/{modelId}` option in project/global role rows and workflow-specific role overrides.

### Edit a custom provider

1. Open **Settings → Authentication → Custom Providers** and expand **Advanced: Custom Providers**.
2. Find the provider in the list and select its pencil **Edit** action.
3. Update **Provider name**, **API type**, **Base URL**, **API key**, or **Available models** as needed.
4. Select **Detect Models** again if you want to refresh or add model IDs from the provider's `/models` endpoint before saving.
5. Select **Save Changes**.

Expected outcome: the provider list refreshes, and model dropdowns use the updated model list. If you only need to refresh a saved provider's models after credentials, endpoints, or upstream availability changed, select the row-level **Refresh Models** action instead; failures keep the previous model list intact. If you rename the provider or change model IDs, update any project/global role or workflow-specific role selections that should use the new `{provider}/{modelId}` value.

### Delete a custom provider

1. Open **Settings → Authentication → Custom Providers** and expand **Advanced: Custom Providers**.
2. Find the provider in the list and select its trash **Delete** action.
3. Confirm the prompt: `Delete custom provider "<name>"?`.

Expected outcome: the provider is removed from the list, and its models are no longer offered as selectable options in model dropdowns. Review any project/global role or workflow-specific role values that previously selected that provider.

### Masked API key behavior

Saved API keys are stored in settings but are masked in API responses and UI-loaded provider records. When you edit an existing Custom Provider, the **API key** field starts blank and shows the hint **Leave blank to keep current key** if a key is already saved.

- Leave **API key** blank to preserve the saved key.
- Enter a new **API key** value to replace the saved key.
- The masked value shown in responses is never reused or submitted as a real credential by the edit form.

For the stored settings shape, see [`customProviders` in the Settings Reference](./settings-reference.md#customproviders). For the API behavior, including masked keys in responses, see [Architecture → Custom Provider endpoints](./architecture.md#custom-provider-endpoints).

## Worktree copy files

Open **Settings → Worktrees** to maintain **Files to copy into new worktrees**. Add editable rows for repository-root-relative files such as `.env`, use **Browse** to select a project file, remove rows you no longer want, then Save. Fusion trims blank rows and de-duplicates paths before persisting. During task startup, configured regular files are copied into fresh or pooled task worktrees before the worktree init command and task execution begin; existing/resumed worktrees are not overwritten. Missing files, directories, absolute paths, traversal entries, and unreadable sources are skipped with non-fatal diagnostics and without logging file contents. See [`worktreeCopyFiles` in the Settings Reference](./settings-reference.md#project-settings) for the stored setting shape.

Use **Show worktree grouping on the board** in **Settings → Worktrees** when you want WIP/processing columns to always show worktree names and group cards by worktree. Workspace-mode tasks appear in their own group labeled with the acquired worktree name and repository count; only tasks with no acquired worktree remain **Unassigned**. With the toggle off, Fusion preserves the legacy default: only the non-workflow `in-progress` column is grouped, and workflow-mode processing columns stay as plain cards.

## Planning Mode

<!-- FNXC:PlanningSidebarDocs 2026-09-12-05:41: Desktop and tablet keep Planning's resizable saved-session sidebar permanently beside detail; only phone uses exclusive list/detail navigation with Back. -->
Planning is a desktop/tablet main-content destination after **Command Center**. Its saved-session sidebar remains visible and resizable beside the active composer, question, loading state, error, or completed plan, including after selecting a session or starting a new one. Phone layouts continue to use compact list/detail navigation: selecting a session hides the list until **Back** returns to it. Planning Mode includes branch controls on the summary screen before you create a task.

<!-- FNXC:PlanningMode 2026-09-16-15:50: FN-465 removed archiving from Planning; the session rail lists active sessions only and each row keeps rename and delete. -->
Archiving is no longer offered in Planning: the saved-session rail has no **Show archived** filter and no per-row archive or unarchive control, and each row offers only rename and delete. Sessions archived before this change stay stored but are no longer listed here.

<!-- FNXC:PlanningSessionRowActions 2026-09-17-03:18: FN-486 moves the session row's rename and delete commands into the shared list-row context menu; the row keeps no permanent secondary buttons. -->
Renommer et supprimer une session s’ouvrent depuis le **menu contextuel de sa ligne** : clic droit, touche **Menu** ou **Shift+F10**, appui long au doigt ou au stylet. La ligne ne porte plus de crayon ni de corbeille permanents. La cible est toujours la session de la LIGNE — une session non ouverte, un brouillon, ou deux sessions portant le même titre restent distinctes par leur identifiant. **Delete** conserve sa confirmation en place ; supprimer une session en cours de génération l’annule d’abord côté serveur. Les commandes de l’en-tête (**New session**, retour, fermeture) sont inchangées.

<!-- FNXC:SessionBanner 2026-07-16-20:55: FN-8229 removes the redundant footer AI pill. The session notification banner preserves non-planning in-progress, needs-input, and error visibility while Planning sessions remain on their dedicated docked surface and navigation badge. -->

When a Planning session needs your input or needs attention, open the docked Planning view from the **Planning** navigation item. Its yellow needs-input dot is visible on the desktop left sidebar and mobile More controls. Non-planning in-progress, needs-input, and error sessions appear in the session notification banner, where available Resume actions reconnect to their matching surface.

<!-- FNXC:PlanningRetry 2026-07-15-00:00: FN-8332 confines automatic Planning Mode retry to failures observed by an active in-session SSE/poll turn. Browser reload or session resume must restore the persisted progress/error verbatim and leave retry as an explicit user choice. -->
When an active Planning AI generation appears stuck, Planning Mode automatically retries the same session up to three times and shows **Retrying… (attempt N of 3)** before falling back to the permanent **Retry**/**Dismiss** error panel. Any successful question or summary progress resets the automatic retry budget. Leaving Planning—including while a plan update or refined question is generating—and returning restores the last active interview for that project. Reopening or reloading a saved Planning session restores its saved question, plan review, thinking, or error without starting another generation; choose **Retry** explicitly from a restored error panel if you want to run it again.

<!-- FNXC:PlanningMode 2026-07-19-15:55: FN-8400 replaces the duplicate prompt-recovery controls with a focused three-pane interview; restarting remains a deliberate New session action. -->
Use **New session** to restart planning with a different idea. To rename a session, open its row's context menu (right-click, **Menu**/**Shift+F10**, or long-press) and choose **Rename session**; any listed session can be renamed without opening it first.

<!-- FNXC:PlanningHistory 2026-08-28-03:34: FN-210 requires every Planning Mode Q&A history surface to preserve the initiating request as visible, read-only session context. -->
The **History** panel, the error panel, and plan review's **Show user Q&A** section show the original request that started the session in a read-only box above the questions and answers. Reading, scrolling, selecting, or copying this text does not edit it or change the session. When an older or incomplete session has no saved starting text, Planning Mode omits the box entirely.

<!-- FNXC:PlanningMode 2026-07-23-11:50: Planning Mode must preserve a collaborative discovery identity instead of inheriting triage/workflow execution specifications. -->
Planning Mode uses a dedicated collaborative system prompt. It investigates relevant repository and board context, explores assumptions and tradeoffs, considers decomposition choices without automatically creating child tasks, and sharpens concrete deliverables with observable acceptance criteria. This is separate from task triage and the executor-ready **PROMPT.md** generated after task creation. An explicitly configured nonblank `planning-system` prompt override replaces the complete dedicated system prompt; blank or absent values retain the default interview.

<!-- FNXC:PlanningMode 2026-07-20-15:45: FN-8442 replaces the simultaneous three-pane interview with a sequential plan-review and question loop. -->
Planning Mode is a single-surface sequence: enter an idea, wait while Fusion generates a concrete initial plan, then review that evolving work product before deciding whether clarification is needed. Plan review shows the title, description, explicit **What to change** and **Acceptance criteria** sections, and deliverables, plus model-suggested **Focus the next question** choices and **Write your own focus**. Choose **Refine** to ask one high-impact question or **Validate** to accept the current plan. Answering a question shows **Updating plan…** and returns to plan review rather than automatically starting another question. The active generation purpose and running plan are persisted, so refreshing or navigating away during generation restores the correct progress state and eventual review.

<!-- FNXC:PlanningMode 2026-08-03-09:21: After five completed question-and-response pairs, mobile interview footers expose Review plan as a non-submitting shortcut to the existing Plan preview tab. The Questions tab remains available, preserving any unsent response so operators can review and continue without losing their draft. -->
After five completed answers, mobile interviews show **Next question** and **Review plan**. **Review plan** selects the existing **Plan preview** tab only: it does not submit the current response or start generation. Select **Questions** at any time to return to the same question and unsent answer. Desktop and earlier mobile turns retain the single **Next** action.

<!-- FNXC:PlanningMode 2026-08-07-03:12: Planning interview questions normally offer 3–5 substantive directions, but an additional useful direction must remain visible instead of being capped. Other remains exactly one canonical free-text choice. -->
Choose **Validate** when the plan is ready. Validation is durable and immediately creates the task using the selected workflow and branch settings. If creation is interrupted after validation, Planning restores a create-only retry state; it never validates again or creates a second task. The permanent desktop/tablet session sidebar, or **Back** on phone, supports browsing, switching, and reviewing session history, with **New session** pinned in the saved-session list. The AI never ends an interview on its own; every selection question normally presents 3–5 materially distinct suggested responses with descriptions, pros, and cons, while retaining any genuinely useful larger set and exactly one **Other** free-text choice.

<!-- FNXC:PlanningMode 2026-07-20-12:00: FN-8441 separates the lean Planning Mode artifact from triage's executor specification. -->
<!-- FNXC:PlanningMode 2026-08-03-10:15: FN-8759 requires Planning Mode task handoff to retain the full ordered interview, including selected answers, custom Other text, and comments, without replacing the verbatim original request. -->
On creation, the validated running plan becomes **plan.md**: its title, description, size, suggested dependencies, and key deliverables are stored as the task description and task document `plan`. FN-509 removed the plan's priority field; tasks run in arrival order. The full ordered Planning Mode interview Q&A, including selected answers, custom **Other** text, and comments, is retained with that plan for triage and executors. The original request that started the session is stored separately as `original-description`. The task planning agent later expands plan.md into the executor-ready **PROMPT.md**; PROMPT.md's **Original Description** preserves that original request verbatim.

- **Branch strategy** options are shared with the New Task dialog:
  - `Use project/default branch`
  - `Create auto-named branch per task`
  - `Use existing branch`
  - `Create custom new branch`
- **Branch name** is required when using `existing` or `custom new` strategies.
- **Merge target / base branch (optional)** uses a dropdown of existing local branches (with common names like `main`/`master`/`trunk`/`develop` listed first) plus a **Custom…** fallback when you need to type a branch that is not local yet.
- **Description** supports a `Markdown`/`Plain` toggle in the summary header row: `Plain` keeps the editable textarea, while `Markdown` renders formatted preview (`react-markdown` + GFM) in the same footprint for easier review before task creation.

These values are sent with the Planning Mode create-task request as `branchSelection`, so created tasks persist branch/base-branch settings consistently with other branch-aware task creation flows.

<!-- FNXC:WorkflowCreateForwarding 2026-06-30-09:12: Dashboard create flows must forward the active real workflow id so planning/quick-create tasks do not briefly land on the default workflow or persist the synthetic All workflows aggregate. -->

When quick-create task creation or Planning Mode runs from a workflow-filtered board/list lane, the create request also carries that active workflow selection. Quick-created tasks appear on the selected workflow lane immediately while board-workflows metadata refreshes, and Planning Mode saves create their task directly on the selected workflow lane instead of briefly landing on the default board. When Board is showing **All workflows**, quick-create uses the real workflow intake/default column that owns the affordance; it never submits the synthetic aggregate as a workflow id.

The **New Task** dialog's workflow selector also defaults to the current or last selected Board/List workflow lane for the current project. If no valid lane has been selected, or the remembered lane was deleted, the selector falls back to the project default workflow and task creation omits an explicit `workflowId`.

<!-- FNXC:CodingIdeasWorkflow 2026-07-05-00:00: Every dashboard create surface (inline quick-create, quick-add box, New Task dialog, insight → task, todo → task) must omit an explicit `column` from the create request so the store resolves the landing column from the (selected or project-default) workflow's intake column instead of always forcing legacy `triage`. -->

Create requests never send an explicit `column`. The task store resolves the landing column from the selected or project-default workflow's intake column, so ordinary tasks land in Planning (`todo`) under the default Coding (Auto) workflow. A workflow with a **manual intake column** parks new cards there instead: they wait for you to promote them into `todo` and are not auto-planned by the triage service until you do. The offered built-in **Coding (Ideas)** workflow keeps this `ideas` composition with `autoTriage: false` under its stable `builtin:coding-ideas` ID. Migration 0079 converts temporary `builtin:coding-ideas-v2` references, archives conflicts, and preserves task history; dashboard and runtime catalogs do not expose a successor alias.

Optional workflow steps declared by the active workflow are available from the quick-add action row and the **New Task** dialog's inline quick buttons. For example, the coding workflow's browser verification option appears as a quick drop-down when that workflow is active; each option is seeded from the workflow step's `defaultOn` setting and is sent with the task's `enabledWorkflowSteps` payload at creation time. Enabling Fast clears enabled optional steps for a speed-first create; disabling Fast restores the selection active before Fast plus any steps enabled while Fast was on, falling back to the current workflow's `defaultOn` seed when the workflow changes or its step list has not loaded yet.

<!-- FNXC:QuickAddAttachments 2026-08-03-00:00: Quick Add's compact paperclip accepts the same task-store-supported photos and files through picker, paste, and drag/drop. Images retain accessible floating previews; non-image files expose a filename and remove action without an empty open control. -->
<!-- FNXC:QuickAddPriorityIndicator 2026-07-10-21:45: Quick Add keeps status controls in the bottom action cluster: GitHub tracking sits beside the paperclip attach button, Priority is icon-only with low/down, normal/flag, high/up, urgent/alert glyphs, and Fast is an icon-only lightning button.
FNXC:PriorityColorCoding 2026-07-11-00:00: Priority glyphs share urgency colors across Quick Add, the New Task inline row, and task-card badges: low=info/blue, normal=muted, high=warning/amber, urgent=error/red. -->
Quick Add and Inline Create model selection include Planner, Executor, Reviewer, and Merger roles. Each role can inherit its default or select a task-specific model; Planner, Reviewer, and Merger also provide independent thinking-level overrides.

Quick Add saves with Enter by default. Operators who prefer multi-line descriptions can disable **Settings → Global → General → Press Enter to save a task in Quick Add**; plain Enter then inserts a newline. Independently of that setting, **Cmd/Ctrl+Enter creates and starts** the task when the selected workflow is Start-eligible, and simply saves it when it is not. Shift+Enter always inserts a newline, including with Cmd/Ctrl held.

<!-- FNXC:QuickAddStart 2026-07-22-17:45: Coding (Ideas) Start is an atomic Todo create, while ordinary Save and Enter remain create-only in Ideas.
FNXC:QuickAddStart 2026-07-24-11:20: Start is now a visible action-row button for eligible workflows instead of a hidden long-press/right-click menu on Save; eligibility, snapshotting, and fail-closed routing are unchanged.
FNXC:WorkflowIdentity 2026-09-14-19:11: The named Start path follows the stable builtin:coding-ideas id. Revision-suffixed migration input is never rendered as a second lane or offered by create controls. -->

Quick Add shows a visible **Start** button in its action row — next to Models/Agent, beside the right-aligned Save — only when the exact selected workflow has complete runtime metadata: a real non-sentinel id, nonempty ordered columns with unique nonblank ids, and an object `flags` value on every column. It is eligible only for validated `builtin:coding-ideas` or a validated workflow whose first visible column is a manual/waiting intake (`manualIntake`); a hold alone is not enough because auto-triaging Planning lanes can also hold cards. Start snapshots that exact definition and id before duplicate confirmation and submits it unchanged; later selection or metadata refreshes cannot alter routing. For Coding (Ideas), Start proves that visible ordered metadata places a non-intake, non-complete **Todo** after **Ideas**, then includes Todo in the original Board/List create request—there is no follow-up move. Missing, hidden, malformed, reordered, or ambiguous metadata renders no Start button at all, so Save stays the only create affordance there. With an empty description Start is visible but disabled. A brief Save click and plain Enter still create in Ideas; the 600 ms Save hold and **Cmd/Ctrl+Enter** both run this same Start path, and Cmd/Ctrl+Enter falls back to an ordinary create whenever Start is not eligible. Other eligible manual-intake workflows retain their matching-returned-task promotion through the host Board/List move path only to the first later visible working column, skipping intake, hold, and complete columns; no forward target also remains create-only.

<!-- FNXC:NewTaskWorkflowStart 2026-08-27-10:50: FN-196 restores the New Task dialog's visible-but-disabled Start affordance whenever the same validated metadata proves an atomic create-time column or a move target. Ineligible or malformed metadata renders no Start shell. -->
The full **New Task** dialog exposes the same **Start** affordance under the same eligibility rules as Quick Add: it is visible but disabled until a description is entered, and absent entirely for ineligible or malformed workflow metadata. Coding (Ideas)-shaped workflows create atomically in their proven working column; other eligible manual-intake workflows promote once through the supplied move path. In the description field, **Cmd/Ctrl+Enter** runs that Start path on both the desktop window and the mobile sheet, and falls back to an ordinary create when Start is absent or disabled; plain Enter and Shift+Enter stay ordinary newlines in this multi-line field.

Quick Add's paperclip accepts supported photos and files: PNG, JPEG, GIF, WebP, MP4, WebM, QuickTime video, plain text, Markdown, JSON, YAML, TOML, CSV, and XML. Select files, paste them into the Quick Add input, or drag them onto the box; pending attachments upload to the newly created task sequentially. Image attachments show compact previews that open in a movable, resizable window (a full-screen sheet on mobile); file attachments show an accessible filename and remove action without an image-open control. Unsupported selections are ignored, and if one upload fails after task creation, the task remains created while Quick Add reports the filenames that need retrying. The same bottom action row places the GitHub tracking override beside the paperclip; Priority is an icon-only control whose glyph changes by selected level (down arrow for low, flag for normal, up arrow for high, alert for urgent) and is color-coded by urgency (low blue/info, normal muted, high amber/warning, urgent red/error), and Fast is an icon-only lightning control. These icon-only controls keep accessible labels and the same create-payload behavior as the previous text chips.

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
- A live mission/shared-branch task uses one operator-consent precedence at every member-integration boundary: explicit task **Enabled** opts in; otherwise project **Auto-merge Off** holds every task value (unset, user Off, mission, legacy, or inherited false) in Review. With project auto-merge On, only explicit user **Disabled** holds; engine-authored false values may use the live intermediate-group integration path. This governs merge/promotion and shared-member integration; standalone pre-merge remediation remains available unless the operator explicitly disables auto-merge for that task. This does not change the separate shared-branch → default-branch promotion policy. In Task Detail edit mode, **Merge target / base branch** uses the existing branch control; clear it to return to the project default.
- In **More options → Model Configuration**, task and agent model pickers expose **Thinking Level** inside the same model dropdown panel instead of as a separate adjacent selector. Task pickers offer **Default (project setting)** plus **Off**, **Minimal**, **Low**, **Medium**, **High**, and **Very High**; agent creation, Agent Onboarding review, and Agent Detail built-in-model settings are concrete-only and start/fall back to **Off**.
- Shared model dropdowns keep the active provider header visible while scrolling. Use the provider chevron to collapse a provider's model rows; this dashboard-local preference persists across sessions, while filtering temporarily shows matching rows from collapsed providers.
- In **More options → Model Configuration**, **Planner oversight** is a per-task override of the workflow-native `plannerOversightLevel` setting (FN-7508): **Inherit from workflow** (default) plus **Off**, **Observe**, **Steer**, and **Autonomous recovery**. This selector appears in both the New Task dialog and the Task Detail edit form (same shared control). Selecting **Inherit from workflow** clears the per-task override (sent as `null` on edit, omitted on create) so the task falls back to the effective `plannerOversightLevel` configured on its workflow — set project/global defaults for this in the **Workflow Editor → Values** tab, not in Project Settings; it is workflow-native, not a project setting.

The dialog exposes a **Plan** handoff that opens Planning Mode with the current description. **Execution mode** and optional workflow-step selection are available in the New Task dialog as well as quick entry, so users can choose Fast or standard execution and opt into workflow-specific creation-time steps before creating a task from either surface.

The full **New Task** dialog includes a compact **GitHub issue or PR** picker near the description. It detects GitHub remotes for the current project, auto-selects a single remote or `origin`, and asks you to choose a remote when multiple non-`origin` remotes are available. Selecting an issue replaces the description with a prompt that tells the executor to fetch/read the issue and includes `Source: <issue-url>`; selecting a pull request creates a PR-focused prompt with `PR: <pr-url>` and explicit instructions to inspect the PR conversation, review comments, checks, and changed files, then resolve or address actionable review comments. If you already typed a description, Fusion asks before replacing it. This picker only seeds the prompt; it does not import, close, or comment on GitHub items. On mobile, the full-screen New Task sheet keeps the GitHub picker, dependency picker, agent picker, quick handoff buttons, and action row tappable and scrollable even when the keyboard reduces the visual viewport.

## Chat View

Chat provides project-scoped conversations with agents. There is one Chat per project: on tablet and desktop it is the window opened from the bottom-bar **Chat** list, the Header Chat action, the optional right sidebar's **Chat** entry, or — under the left-sidebar placement — the full Chat page, and on phones it is the Chat drawer. Every host starts at the conversation list; select a conversation to open its thread. When the software keyboard is open, the composer remains visible on phones in portrait and landscape, tablets/iPad, and narrow Chat windows; wide desktop Chat is unaffected.

**New Chat** immediately creates a Direct conversation from the Settings-configured default agent or model. Use the **Brain** control beside the composer to retarget an existing conversation.

### Enter behavior in conversation composers

Use **Settings → General → Enter key behavior in conversations** to choose `auto` (the default), `always`, or `never` for plain Enter in the Chat, task Chat, and planner Chat composers. In `auto`, plain Enter inserts a newline when the primary pointer is touch-based and an on-screen keyboard is expected, while a fine pointer such as a mouse retains desktop Enter-to-send behavior; a narrow desktop window does not count as touch.

- In Chat, an open files/tasks, agents, or skills autocomplete menu runs before the Shift guard and consumes Enter, Cmd/Ctrl+Enter, and Shift+Enter. Shift+Enter never sends, including with Cmd/Ctrl held, and inserts a newline only when none of these three Chat menus is open.
- In task Chat, an in-progress IME composition runs first and consumes every Enter path, including Cmd/Ctrl+Enter, until candidate confirmation. Shift+Enter then runs before the snippets menu: it never sends, including with Cmd/Ctrl held, and passes through that menu to insert a newline.
- In planner Chat, Shift+Enter likewise runs before the command/snippet menu: it never sends, including with Cmd/Ctrl held, and passes through that menu to insert a newline. Planner Chat has no task-Chat IME guard.
- In all three composers, after those existing guards, Cmd/Ctrl+Enter without Shift sends independently of `chatSubmitOnEnter` and pointer type. Plain Enter without Cmd/Ctrl or Shift then follows the setting; Alt does not alter that choice.
- When an autocomplete menu is open, it takes priority over both Enter and Cmd/Ctrl+Enter without Shift; press Escape to close it and restore the normal rules. The Send button remains available whenever the draft is not empty, including while a menu or IME composition is active, and remains disabled for an empty draft.
- These rules apply only to the three conversation composers. Editing an already-sent message retains its separate keyboard contract.

<!-- FNXC:ChatConversationReferences 2026-09-04-09:58: Conversation IDs are shared through the existing row menu, and Direct chat receives only bounded same-project context plus opt-in read/search tools rather than a copied transcript. -->
In the conversation list, open a row's actions with desktop right-click or the **⋯** button on touch, tablet, and compact layouts, then choose **Copy conversation ID**. In a Direct chat composer, typing `#` searches the already-loaded conversation list alongside tasks and files; selecting a conversation inserts its `#chat-xxxxxxxx` ID. Sending that reference gives the assistant a short card with the conversation's metadata and latest activity, plus read-only tools for bounded reading or searching when more detail is needed—the full transcript is not copied into the prompt. Unknown IDs and conversations outside the current project are both reported as unavailable without revealing metadata. Rooms, explicitly mentioned-agent responders, and CLI-agent-backed chat use their existing execution paths and do not receive this context or these tools.

<!-- FNXC:ChatComposerFocusDocs 2026-09-14-10:42: Opening or creating a conversation on a pointer host must focus its composer, while touch hosts and retained hidden Chat modal instances must not claim the caret. -->
On pointer hosts, opening a conversation from the conversation list or thread title switcher, creating one with **New Chat**, `/new`, or `/clear`, or opening one in its own window puts the caret in the message composer so you can type immediately. Phones and touch tablets deliberately leave the composer unfocused so an unsolicited software keyboard never covers a freshly opened thread. A hidden Chat modal never takes focus; reopening it onto an already open conversation focuses its composer. While the composer holds focus, global keyboard shortcuts remain suppressed exactly as they do for every chat composer; see [Keyboard shortcuts](#keyboard-shortcuts).

### Docked conversation sidebar

In the full, non-floating Chat view on tablet and desktop, the Chat header can show or hide a docked conversation sidebar. When shown, it keeps the conversation list next to the open thread; drag its separator or use its arrow keys to resize it between 220px and 480px. Its width and open state are remembered in the browser across reloads. Conversation rows show the saved name, provider icon, model, and last-message snippet. Mobile, the Chat drawer, narrow Chat windows, and detached conversation windows retain one-pane list/detail navigation with **< BACK**.

The shared Chat header is contextual. In the list state it owns **New Chat**. Once a conversation is open, that button is replaced by a **…** action that opens the same quick actions as right-clicking the conversation in the list — Open in new window, Copy conversation ID, Pin/Unpin, Rename, tag assignment, Preserve to Stash, and Delete — with **New Chat** as its first entry so creation stays reachable. This applies to the Chat window, the mobile Chat drawer, and the floating Chat host. The desktop dock's Chat list stays a list owner and keeps **New Chat** permanently, and a dedicated conversation window still renders neither control. Search and tag filters, and each row's rename, pin, and delete actions remain list-only. Detail intentionally contains the saved conversation title and secondary model metadata when available. The list contains only active sessions. Archiving is no longer offered in Chat: there is no archived list, no restore action, and no archive row or menu action; delete remains the explicit removal action. Conversations archived before this change stay stored but are no longer listed or restorable from Chat.

<!-- FNXC:ChatWindowsDocs 2026-09-14-10:42: FN-193 and FN-390 require a secondary chat window paint its requested thread before the session list has finished loading, and modifier-created chats must leave the origin session and composer untouched. -->
For an active Direct conversation, open the row actions with desktop right-click or the **⋯** control (including touch, keyboard, compact, and dock hosts), then choose **Open in new window**. Fusion opens an independent in-app chat window in front of the chat window it was launched from, on that conversation's thread from its first render even while the conversation list is still loading; it is not a browser or OS window. You can keep several different conversations open, move and close each one independently, and reopening the same conversation raises and reopens its existing window instead of duplicating it, without interrupting an in-flight reply. The dashboard-wide window visibility control hides every currently visible managed chat window together and restores exactly that captured set with its conversation, geometry, scroll position, and typed draft intact. The in-window **< BACK** action returns to that window's conversation list. Rooms do not offer this action. Escape closes one visible secondary chat window at a time after popped-out task windows and before the primary Chat modal, but never closes a window hidden by the visibility control; switching projects or choosing all projects closes every secondary window.

On desktop, Ctrl-click (Windows/Linux) or Cmd-click (macOS) on **New Chat** creates the new conversation in its own offset in-app chat window above the conversation you are reading. The origin conversation, in-flight reply, and composer remain untouched. A plain **New Chat** click keeps the existing in-place behavior. Mobile and short-viewport hosts keep their full-screen sheet and plain creation behavior.

### Conversation layout

Use **Settings → Appearance → Conversation layout** to choose the project-scoped message presentation for every dashboard chat surface. **Bubbles** is the default and keeps the bounded, left/right-aligned message bubbles; **Full width** lets each message use the available transcript width. The choice applies immediately to the main Chat view, Chat modal or drawer, and dock/overflow Chat hosts, as well as task-detail **Activity** and task-aware **Chat**. Missing or invalid values safely use **Bubbles**.

<!-- FNXC:ChatStreamingDocs 2026-08-19-13:52: Ordinary Markdown links in the shared Chat renderer open safely in a new tab and use the assistant-bubble text token so source destinations remain readable on desktop and narrow hosts. -->
Ordinary Markdown links in Direct Chat, Chat Rooms, managed modal/drawer Chat, floating/dock Chat, and task-detail Planner Chat open in a new browser tab and include the safe `noopener noreferrer` relationship. They retain the complete sanitized destination and use the shared readable, always-underlined Chat treatment on desktop and mobile. Native `fusion://` structure references continue to open their preview cards, file-path controls keep their in-app navigation, and terminal-only CLI output plus separate non-Chat Markdown surfaces are outside this link contract.

<!-- FNXC:ChatComposerDocs 2026-08-20-19:25: FN-076 makes every dashboard chat textarea automatic-only so mouse resizing cannot leave a shortened or cleared draft enlarged. -->
Every dashboard chat textarea—Primary Chat, Rooms, Activity, task Planner Chat, message correction, question responses, and Compose Chat—grows automatically through five rendered lines and scrolls additional text inside the input. It shrinks as content is removed and returns to its minimum height when cleared. Mouse resizing is unavailable on desktop, tablet, and mobile.

## Mailbox task completion recap

<!-- FNXC:MailboxTaskCompletionDocs 2026-09-13-03:42: Each completion episode appears as one Mailbox message that keeps the delivered-work summary, suggested follow-ups, optional images, and source-task navigation together; historical standalone recommendation notices remain readable only from archived mail. -->

When a task reaches a completion column, Mailbox shows one completion recap rather than separate completion and recommendation messages. Open it to read the delivered-work summary, review suggested follow-ups (or the explicit empty state), inspect any completion images, and use the single source-task button to open Task Detail. Older standalone recommendation notices remain available under the inbox filter's **Archived** scope, but new completions do not create them.

## Mailbox archive

Mailbox Inbox, Outbox, and agent lists exclude archived correspondence and unread badges ignore it. On the Inbox tab, open the header **Filter** button and choose **Archived** to review archived messages and restore them; Archive is the default removal action and Delete remains available as an explicit destructive action.


- Direct Chat, Chat Room responders, and task-detail Chat have coding workspace tools at the interactive project checkout: `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. They can make user-directed edits and run shell investigation; a bound durable agent remains subject to its permanent-agent file-write and command-execution permission policy. These Chat sessions keep the checkout branch sticky unless you explicitly ask to switch it. Planning/mission interviews and WhatsApp plugin chat remain readonly.

<!-- FNXC:NativeStructureEmbed 2026-07-19-20:00: Roadmap-item references now resolve through the roadmap plugin's PostgreSQL-safe read adapter and open the restored hosted Roadmaps destination. -->
- Chat recognizes native structure references in both assistant and user messages using the explicit `fusion://<kind>/<id>` form. Supported kinds are `mission`, `milestone`, `roadmap-item`, `research-finding`, `eval-result`, and `goal`. Use a bare token such as `fusion://mission/M-001` in either message type, or an assistant Markdown link such as `[Mission](fusion://mission/M-001)`. `roadmap-item` previews the roadmap feature title and description when available; a missing feature or unavailable roadmap data layer renders the shared unavailable card.
- Recognized references render an inline preview card before you leave the conversation. Select **Open** on an available card to navigate to its owning dashboard view; missing, archived, or otherwise unavailable structures show a safe unavailable placeholder instead. Plain-text mode deliberately leaves reference text raw.
- Entering `/new` or `/clear` (exact match after trimming) in the composer starts a fresh thread for the current chat target instead of sending the literal command to the model. On an idle Direct Chat this is a successful no-op cancellation barrier with no interrupted-save warning; an active response still waits for its durable interrupted-response recovery before the new thread is selected.
- On mobile, the Rename conversation, Rename tag, Delete tag, and Delete Conversation dialogs use a compact inset treatment (centered, viewport-bounded, internally scrollable) instead of the app's default full-height mobile modal chrome.
- **Settings → Project Models → Chat** configures the project’s default Direct-chat target: **Model** (a provider/model pair with optional Thinking Level and credential instance) or **Agent** (a durable agent id). **New Chat** always creates the conversation immediately from the resolved default. If the configured target is incomplete or unset, Fusion uses the project/global default model; if no default model is configured, it reports an error and creates no conversation. Reset clears the project chat-default settings.
- The **Chat Default Model** picker in Settings includes a **Thinking Level** selector for new conversations. Choosing **Default** leaves the session unset so Fusion uses the resolved project/global reasoning-effort default; choosing a concrete level stores it on that chat session and applies to model-loop replies. The Default label shows the current resolved default (for example **Default (medium)**) and falls back to **Default (off)** when no default is configured. Use the composer **Brain** popover to change thinking level on an existing conversation.
<!-- FNXC:Chat-ThinkingLevel 2026-09-01-05:14: The retired create-time chat setup dialog no longer controls an existing session; the composer Brain popover changes its reasoning-effort level mid-conversation. -->
<!-- FNXC:Chat-ThinkingLevel 2026-09-01-05:14: Default entries show the resolved project/global reasoning-effort value in Settings and the in-chat Brain popover; choosing Default still clears the per-session override. -->
<!-- FNXC:Chat-ModelSwitch 2026-09-01-05:14: The retired create-time chat setup dialog and retired create-time model prompt mode leave the Brain popover as the sole control for retargeting an active non-CLI Direct chat. -->
<!-- FNXC:Chat-ModelSwitch 2026-09-14-23:48: FN-396 removes the Brain popover's Model/Agent toggle and agent list; the popover retargets the MODEL only, and agents are solicited by `@` mention with the model and thinking level configured on their own record. -->
<!-- FNXC:Chat-ModelSwitch 2026-07-12-22:44: FN-7916 keeps the Brain popup usable on mobile/tablet touch devices: the portaled shared model picker is treated as part of the popup for selection, and the popup is viewport-fitted instead of anchored off-screen. -->
<!-- FNXC:Chat-ModelSwitch 2026-07-13-00:00: FN-7934 applies that fitted Brain-popup layout to narrow chat surfaces, including floating Chat windows and compact docks on wide desktop viewports, because the browser viewport alone does not describe the popover's clipping container. -->
- A small **Brain**-icon button next to the composer's attach button is the only control for retargeting an already-created Direct chat session’s model and thinking level mid-conversation, without starting a new chat. Its **Model** section switches the session to another model via the shared model picker; there is no agent tab and no agent list, because agents are summoned with an `@Agent_Name` mention and answer with the model and thinking level configured on their own record. A conversation already bound to an agent keeps working and shows that binding read-only. Its **Thinking level** section still lists the six thinking levels plus **Default** (clear/inherit, labeled with the current resolved default such as **Default (medium)**). Selecting a model keeps the popover open so you can choose a thinking level in the same interaction. Selecting a thinking level deliberately closes it; switching to another conversation or receiving a target change that did not echo your selection also closes it to avoid stale options. Each selection persists immediately and applies starting with the session's next send, including on mobile/tablet touch viewports and narrow floating Chat windows or compact docks where the popup stays fitted to the chat surface. This control appears only for non-CLI Direct sessions — it is not shown for CLI-agent-backed sessions or in Chat Rooms, neither of which support this per-session retargeting control.
- The full Chat view and managed Chat modal/drawer consume the same streamed `/api/chat/sessions/:id/messages` response contract, and both now prefer the authoritative assistant `message` snapshot on `done` while still accumulating `text` chunks when present (so providers without incremental text streaming still render output immediately).
- Assistant text capture handles `text_start`, `text_delta`, `text_end`, and `message_end` with exactly-once per-block bookkeeping. Sentence repair uses only the current block's own text, including a verbatim flush recorded for that block, so message boundaries never gain a guessed space while within-block repair remains available. Chat separates streamed blocks with paragraph breaks and reconciles persistence against every assistant message in the completed turn.
<!-- FNXC:ChatCancellation 2026-09-14-10:42: Direct Chat and task Planner Chat must make an explicit Stop durable for reload and the next model turn, while Chat Rooms and CLI-agent-backed sessions retain their separate cancellation semantics. -->
- Stopping a Direct Chat or task Chat model-loop response retains any non-empty text already streamed as one interrupted assistant conversation message, including after refresh/remount and in the next turn's file-backed model context. Chat Rooms and CLI-agent-backed chat sessions are excluded from this model-loop continuity contract.
<!-- FNXC:ChatEmptyMessage 2026-07-10-00:00: Empty final assistant responses can be legitimate provider output (for example a Grok CLI run ending without text). Document the shared Chat/Planner Chat behavior so operators see "No message" instead of interpreting a blank bubble as a rendering failure. -->
- Final assistant messages with no text, tool calls, thinking output, attachments, or failure details render a muted **No message** placeholder instead of a blank bubble. In-progress responses still use the existing **Working…** / **Thinking…** streaming state until the run finishes.
- In-progress assistant responses now survive refresh/navigation while generation is still active: Chat restores the last durable in-flight text/thinking/tool state immediately, keeps the prior persisted conversation visible, then resumes streaming from the stored replay point; any new text, thinking, or tool-call updates append to that restored bubble instead of replacing it or starting from an empty "Working…" placeholder.
- While a Chat response is actively streaming, prior user and assistant messages stay visible across session-update snapshots, tool-call churn, and stale message reloads; the thread does not flicker to an empty history mid-turn.
- If a regular Chat stream drops with a hidden-tab/browser-suspension error (for example `Load failed`) while the server is still generating, Chat suppresses the false error banner, re-attaches to the in-progress stream using the durable replay state, and reconciles the final assistant reply when generation completes.
- If you queue follow-up user messages while the assistant is still streaming, Chat persists them per session, stacks each queued preview above the input box with one shared divider, and restores/sends them one at a time in FIFO order once each active response finishes if you leave and return.
- Chat message lists now track near-bottom scroll state: while you are reading older messages, live streaming/new replies do not force-scroll; a **Latest** jump control appears until you return to the tail.
- On mobile direct-chat threads, entering a thread and restoring Chat after tab/page visibility returns re-anchors to the newest message (`scrollTop = scrollHeight`) so the view always opens at the live tail.
- On mobile direct-chat threads, the selected conversation row keeps one compact **< BACK** control beside the truncating saved title. Conversation switching and management remain in the list, so no active-conversation dropdown or duplicate detail action shell competes with the thread.
- On mobile direct-chat threads, the single thread-wide Markdown/plain eye toggle floats above the transcript/composer area instead of occupying a second header row; desktop/tablet keeps the toggle in the thread header.
- Direct chat sessions can be renamed from the conversation list row action menu; blank rename submissions clear the custom title so the default session label is shown again.
<!-- FNXC:ChatPinned 2026-07-16-12:00: Document the Direct-only pin contract across desktop and mobile list surfaces, including the durable server-side scope limit. -->
<!-- FNXC:ChatPinned 2026-08-19-21:10: Pinned and unpinned Direct conversations remain distinct named groups in every ChatView list; selected detail does not duplicate list controls. -->
- You can pin up to **3** active Direct conversations per project scope from its list-row action menu. Pinned conversations show an indicator, sort above recent unpinned conversations, and appear in separately labeled **Pinned** and **Recent** sections on both desktop and mobile lists. The server serializes each scope's pin changes (including null-project/default sessions) so concurrent requests cannot exceed the limit. Chat no longer offers archiving, so a pin is released only by unpinning or deleting the conversation.
<!-- FNXC:ChatViewDocs 2026-07-01-00:00: Task-detail planner chats are intentionally hidden from the common Direct feed by default after issue #1850; Settings keeps an opt-in for operators who want populated task-planner sessions restored without adding a mandatory Tasks tab. -->
<!-- FNXC:TaskDetailPlannerChat 2026-07-01-22:02: Done-task planner Chat remains available for retrospective Q&A and can create a task-scoped refinement through the planner tool, while common Chat feed visibility remains opt-in. -->
- Task-detail planner Chat conversations stay available from each task's **Chat** tab, including after the task is `done`. They are hidden from the common Direct/common Chat feed by default; enable **Settings → Project General → Show task chats in common Chat feed** to include populated task chats again. Empty task chat sessions stay hidden either way. When the setting is enabled, task chats appear immediately when you reopen Chat — they are restored from the browser's local conversation snapshot alongside your direct conversations instead of waiting for the session list request; turning the setting off removes them from the common feed on the next refresh of that list. Planner Chat can answer token-count, estimated-cost, runtime, timing-event, workflow-step duration, and per-model usage questions for the current task through a read-only task-scoped metrics tool; unknown/stale pricing is reported as uncertain instead of `$0`. On completed tasks, clear follow-up implementation or improvement requests can create a normal refinement task from the completed source task.
<!-- FNXC:TaskPlannerChatQueue 2026-08-18-23:13: Planner Chat follow-ups use the existing browser-local, session-keyed queue rather than server-side storage, so operators can manage pending work without changing chat persistence boundaries. -->
- While a Planner Chat response streams, additional text turns remain sendable and appear in a pending-message list above the composer. The list persists FIFO order in browser storage for that planner session and supports editing, moving earlier/later, deleting, and selecting **Force send**. Ordinary completion or Stop sends the next front entry one at a time. **Force send** first closes the active stream, waits for the durable cancellation response and transcript reconciliation, then sends only the selected entry; if cancellation, reconciliation, or dispatch fails, the entry remains queued for retry. Queues are session-scoped and are not shared with Activity/Live steering comments or another task's Planner Chat.
<!-- FNXC:ChatContextWindow 2026-08-23-00:08: Direct-chat docs must describe pi's provider-reported session context, the explicit post-compaction unknown state, and the labelled estimate fallback while preserving the intentional absence from mobile, narrow floating chat, and room headers. -->
- On desktop/tablet Direct chat, the thread header shows pi's provider-reported session context (input, output, and cache tokens) against the model context window. Immediately after pi compacts a session it shows an explicit unknown state until the next reply; CLI-agent-backed chats, plugin CLI runtimes, and pre-existing conversations with no pi usage show a labelled estimate instead. It is hidden on mobile, narrow floating chat, rooms, and when neither pi nor the model catalogue provides a context window.
<!-- FNXC:ChatViewDocs 2026-09-14-10:42: Chat responsive layout keys bubble width off the ChatView container, so managed modal windows and the right dock receive the same readable treatment as phone Chat. -->
- In narrow Chat containers (including phone-width full Chat, narrow Chat windows, and right-dock Chat), message bubbles use the full content width for improved readability. On tablet-width main Chat containers, assistant/agent, streaming, and failure bubbles keep the wider 92% reading measure, while wide desktop Chat keeps the standard 75% bubble cap.
- Full Chat tool-call summaries now use a denser mobile layout: grouped and single-call collapsed rows keep icon + label + status on one line (compact scanability).
- Tool calls in direct, room, Quick, and Planner Chat plus task Activity and Agent Log Viewer keep collapsed previews compact, but opening their disclosure shows the complete arguments and result/output that reached the browser. Multiline output preserves line breaks; ordinary text wraps and exceptionally long paths or tokens scroll inside the detail instead of widening the page, including at the mobile breakpoint. This removes UI-created preview truncation only: intentional engine persistence, context, API, and tool-output budgets still determine what payload is available to display.
<!-- FNXC:ToolCallDisplay 2026-08-01-15:39: FN-8701 makes the compact-preview versus complete-available-expanded-payload contract explicit for every dashboard transcript and log surface, without implying that UI expansion bypasses upstream output budgets. -->
<!-- FNXC:ChatAskQuestion 2026-06-17-16:35: Dashboard chat agents have a Fusion-native `fn_ask_question` tool, so the documented question-card behavior must cover both provider-native question tools and Fusion's first-party tool. -->
<!-- FNXC:ChatAskQuestion 2026-09-09-02:42: Optional question fields must be discoverable and safely represented in submitted chat replies so agents can offer non-blocking additional context without losing intent. -->
- Assistant question tool calls now render as a shared in-chat response card instead of a generic tool-call disclosure. The card recognizes provider-native question tools and Fusion's `fn_ask_question`, supports select, multi-select, text, and yes/no prompts, sends the formatted answer back into the same direct or room thread, and renders historical answered questions read-only. Agents can mark a question optional: it displays an **Optional** marker, may be left blank once required questions are answered, and the submitted reply explicitly records that it had no answer.
- The desktop Chat view toggle and mobile Chat tab now show an unread-response indicator when a live assistant reply arrives for a visible direct or room chat after you leave Chat; opening Chat clears it immediately. Task-detail planner Chat replies stay task-local and do not light up the global Chat unread indicator while those sessions are hidden from the common Chat feed.
- Agent-backed chat sessions now expose the same mailbox messaging tools (`fn_send_message`, `fn_read_messages`) used by runtime execution/heartbeat flows whenever the engine `MessageStore` is available; model-only chats continue to run without mailbox tools.
- Main Chat and Chat Rooms accept the same supported photos and files as Quick Add through the paperclip, clipboard paste, or drag/drop. Pending images retain their preview/open behavior, while non-image files remain removable filename chips; previews dismiss as soon as the server accepts the turn, while failed pre-acceptance sends preserve staged attachments for retry. Exact `/new` and `/clear` refuse when attachments are staged so unsent files are never silently discarded.
- Chat attachments are included in agent-visible prompts for both direct sessions and rooms: supported text attachments are appended under an `Attachments` prompt section, and supported images (`png`, `jpeg`, `gif`, `webp`) are passed as image inputs to the model.
- Chat attachments can be sent without accompanying text in both managed Chat and Main Chat; fully empty sends with no text and no attachments are still blocked.
<!-- FNXC:ChatMessageEdit 2026-07-12-23:20: Document the message-edit affordance and its resume-from-edit ("forget everything after") semantics, including the model-loop-only scope and inline timestamp placement. -->
- Your own messages in a **direct (model-loop) chat** can be edited: hover/tap the compact **Edit message** (pencil) action inline with the message timestamp to swap it for an inline textarea, then **Save** (or Cmd/Ctrl+Enter) or **Cancel** (or Escape). Saving an edit **resumes the conversation from that point** — the edited turn and every turn after it are discarded from both the visible transcript and the model's memory, so the agent responds fresh from the edited content with no bias from what was removed. This is the only way to correct or steer an earlier turn without leaving a stale, misleading message in the thread.
<!-- FNXC:ChatMessageScrollToTop 2026-07-12-23:20: Chat message go-to-top is contextual; document that it appears only after a message top has scrolled above the chat viewport and sits inline with Thinking/copy actions. -->
- Assistant messages expose a **Scroll message to top** up-arrow only after that message's top has moved above the visible chat viewport. When visible, the control sits inline with the message's **Thinking** row (or the same footer action row when no thinking details are present) instead of adding a separate action line.
- Message editing applies to direct/model-loop chat sessions, **including task-detail Planner Chat** (the synthetic `task-planner:<id>` session, a model-loop session under the hood). It is **not** available in **Chat Rooms** (multi-agent, different persistence) or in **CLI-agent-backed sessions** (the transcript is owned by a live terminal, not a rewindable model session). The edit action is also disabled while a response is actively streaming, to avoid racing a live generation, and never renders on optimistic/in-flight rows that have no persisted message id yet.
- Editing is truncate-and-resend, not append: the edited message and everything after it are removed first, then the edited text is sent as a new turn through the normal streaming path — so the resulting transcript looks the same as if you had deleted the old messages and typed the correction from scratch, but in one action. **Save** remains active until this rewind-and-resend request finishes, preventing duplicate sends; if the request fails, the transcript is restored and Chat shows an error instead of silently dropping the correction.
<!-- FNXC:TaskDetailPlannerChat 2026-07-07-10:15: Document Planner Chat edit-and-resend and the steering/refinement side-effect decision on discard. -->
- In task-detail **Planner Chat**, editing an earlier message resumes the conversation from that point exactly as in direct chat. If the discarded turns already triggered task-scoped side effects — a steering comment added via the planner steering tool, or a refinement task created via the planner refinement tool — those **are not reverted**: the steering comment stays on the task and the refinement task stays open, because undoing either is destructive and out of scope for a chat edit. After a successful edit-and-resend, task detail refreshes automatically (so Activity/steering reflects reality), and if the discarded range held one of those confirmations you get an informational toast noting that the earlier change was not undone.
<!-- FNXC:ChatSearch 2026-07-07-12:00: Content search is always on (FN-7651 removed the "Search in title only" toggle per user request); document the always-on behavior instead of a switchable toggle. -->
- The Chat sidebar search box always matches message **content** in addition to conversation title/agent — so you can find a past conversation by remembering something that was said in it, even if the title doesn't contain the query. Content matches run as a debounced server-side lookup and are merged with local title/agent matches into the same results list; there is no toggle to restrict search back to title-only. This applies on both desktop and mobile Chat sidebars and does not appear in the Rooms scope (Rooms already hides search/list). When a session is shown because of a content match, its row shows a subtle "Matched: ..." preview of the matching message so it's clear why the conversation appeared. Task-planner sessions stay excluded from content matches by the same common-feed guard used for the normal session list (see **Settings → Project General → Show task chats in common Chat feed**).

![Chat view](./screenshots/chat-view.png)

### Direct Chat and Agent Mentions

Chat View exposes Direct conversations only. The retained Rooms APIs and storage are not presented as a persistent Chat View scope.

- **New Chat** immediately creates a Direct conversation from the Settings-configured default agent or model. Use the **Brain** control beside the composer to retarget an existing conversation.
- Mention one or more agents with `@Agent_Name` in a message to summon them for that turn. Each mentioned agent answers with its own configured model and thinking level; an unmentioned turn uses the conversation model as usual.
- Every persisted message has a quote control. Quoting an agent reply seeds the composer as `"<excerpt>" - @Agent_Name , `, so the next turn explicitly cites and re-summons that agent.
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
- Relationship summary: direct Chat runs one target (agent or model) per session; rooms are shared threads with multiple agent members and now use the same message contract as direct Chat; the managed Chat modal or drawer reads and writes the selected Direct or Room thread through the same shared contract.
- For backend details, see the [Chat Room REST API reference](./architecture.md#real-time-channels) and the [chat room storage schema (`chat_rooms`, `chat_room_members`, `chat_room_messages`)](./storage.md#chat-rooms-migration-70).

## Chat modal and mobile drawer

<!-- FNXC:UnifiedChatDocs 2026-09-14-10:42: FN-390 removes the separate compact chat product surface; the footer Chat action now opens the shared Chat experience as a managed desktop modal or mobile drawer. -->
The footer **Chat** action opens the same project-scoped Chat experience used by the main view and right dock. On desktop and tablet it opens a movable, resizable managed modal; on mobile it opens a navigation drawer rather than a floating window. Chat has no separate compact launcher, dedicated shortcut, or outside-click preference.

- Every presentation uses the same list-first conversation flow, model/provider resolution, mentions, attachments, commands, streamed response contract, question cards, and per-session queued follow-ups.
- Desktop modal geometry is remembered and constrained to the live usable shell rectangle. The mobile drawer does not read or overwrite that desktop geometry.
- Closing or hiding the modal keeps its active conversation, transcript position, in-flight response, queued messages, and draft warm. Reopening restores them without creating a second Chat instance.
- **Open in new window** creates independent managed desktop chat windows for Direct conversations. They participate in the dashboard-wide hide/restore command; mobile keeps one drawer and one-pane navigation.
- Pointer hosts focus a ready composer when a conversation opens. Touch hosts do not summon the software keyboard until the user enters the composer.
- Narrow Chat containers use full-width message bubbles and compact, single-line tool summaries. The mobile drawer follows the visual viewport so its composer remains above the software keyboard.
- Scrolling away from the newest message stops automatic following and exposes **Latest**. Returning to the bottom resumes following.

## Mailbox View

<!-- FNXC:MailboxRowActions 2026-09-17-03:18: FN-486 gives every mailbox row producer the same context-menu commands; header, tab, filter, compose, bulk and approval controls are unchanged. -->
Les actions d’un **message** de la liste s’ouvrent par le **menu contextuel de sa ligne** : clic droit, touche **Menu** ou **Shift+F10**, appui long au doigt ou au stylet. Les mêmes commandes sont servies par la destination Mailbox, la fenêtre Mailbox et l’onglet **Mail** d’un agent, dans chacune de leurs collections (réception, envoi, archives, tous agents, réception et envoi d’un agent, notifications de fin de tâche).

- **Archive** ou **Restore** selon l’état du message.
- **Delete**, destructif, après confirmation ; il n’est plus nécessaire d’ouvrir le message pour atteindre sa confirmation.
- **Reply** uniquement là où un composeur existe déjà et selon sa condition actuelle. L’onglet Mail d’un agent n’en propose donc pas.
- Il n’existe aucune commande d’édition d’un message.

Ouvrir ce menu ne sélectionne pas le message, ne le marque pas comme lu, ne charge pas sa conversation et ne consomme pas un lien profond. Une action lancée depuis une ligne **non sélectionnée** laisse le détail ouvert en place ; seule une action visant le message affiché le referme. Les demandes d’approbation ne sont pas des messages : elles conservent leurs contrôles de décision et n’exposent aucune commande destructive de message. Les en-têtes, onglets, filtres, composition et actions collectives sont inchangés.

<!-- FNXC:MailboxTwoTabsDocs 2026-09-16-16:53: FN-464 reduced Mailbox to two tabs with a contextual header, moved the retired collections behind one filter button, kept the pending-approvals badge visible on that button, and removed manual refresh in favour of real-time updates. -->
Mailbox has exactly two tabs: **Inbox** and **Outbox**. The header is contextual. On Inbox it offers a **Filter** button, the unread-count badge, and **Mark all read** (disabled when nothing is unread); on Outbox it offers **Compose**. The unread count is inbox information, so it is shown only while the Inbox tab is active — it never appears on Outbox, and it is hidden while the composer owns the header. This holds in both hosts (the full-screen Mailbox destination and the floating mailbox window), and it stays visible across every inbox scope. The filter button opens the inbox scope menu — **All**, **Reports & approvals**, **Archived**, **Approvals**, and **Agents** (the floating mailbox window offers **Completions** instead of Approvals) — so every collection that used to own a tab stays one click away. When approvals are waiting, the pending count is shown as a badge on the filter button itself, visible without opening the menu, and repeated beside the **Approvals** option inside it.

There is no refresh button: every list updates in real time. A message that arrives while you are reading any scope — including Archived, Approvals, Agents, and the Outbox — appears immediately, and the unread and pending-approval counts follow the same live stream.

Mailbox view shows inbox/outbox communication threads, unread state, approvals, historical notices, and task-completion recaps. Every real transition from a nonterminal column into any `complete` column of the task's own workflow creates one best-effort recap after the durable move. The recap contains the task summary, registered image artifacts, actionable recommendations, and **View task**; plans, documents, videos, audio, and other artifacts remain available in Task Detail and are not duplicated in mail. Replayed transitions and moves between terminal columns do not duplicate the recap, while reopening a task and completing it again creates a new completion episode. Mailbox's unread badge and **Mark all read** cover the complete active inbox. Historical artifact and recommendation notices remain available in Inbox or Archived with their existing actions. When an ephemeral worker is configured for follow-up validation, its task proposals include a **Create task** action; created proposals link directly to the resulting task. The controls remain available on desktop and mobile.

<!-- FNXC:MailboxSubject 2026-09-15-04:40: Every mail row must show an author and a subject; a subject is derived for legacy mail and system notices so the promise holds without a migration. -->
- Every mail shows an **author** and a **subject**, never the raw start of the message body. This applies to every Mailbox list (Inbox, Outbox, Archived, Completions, agent mailboxes), to the message detail, and to the **Mail** tab of an agent's detail view. Markdown markers such as `##` or `**` never appear in the subject line.
- The subject is resolved in this order: the subject written by the author; otherwise a translated subject derived from the notice type (a completion notice reads `FN-325 completed`, and there are equivalents for task proposals, recommendations, wedges, duplicate decisions, and planning clarifications); otherwise the title of a structural report; otherwise the first meaningful line of the body with its Markdown markers removed; otherwise `(no subject)`. When a notice type lacks the data its subject needs, nothing is invented and the body-derived subject is used.
- The message composer offers an optional **Subject** field (200 characters maximum) above the body. Leaving it empty is fine: mail without an explicit subject still displays a derived one, so no mail is ever subject-less.
- Mail composers can attach a native mission, milestone, goal, persisted insight, eval result, or roadmap item by dragging it from its owning view, or through the keyboard/mobile **Attach structure** picker. Roadmap feature-row drag is available on fine pointers; touch and keyboard use the picker. The shared `nativeStructureDrag` payload is copied into the same first-class mail embed metadata as picker attachments, while a dropped payload from another project is rejected.
- **Draft with AI** opens a compact compose-chat scratch session that uses attached structures as context. **Use draft** replaces an empty message body; replacing typed text requires confirmation, and attached embeds remain in place.
- Structural mail distinguishes **Reports** (titled markdown sections) and **Approvals** (inline, single-shot approve/deny decisions) from ordinary quick messages. Use **Reports & approvals** in the inbox to filter to those items without changing unread counts or message history.
- The composer defaults to **Quick message**. **Report** mode adds a title and complete headed sections, opens **Draft with AI** for memo help, and keeps native-structure attachments in context. A recipient is still required before sending.
- Assistant chat messages offer **Send as report**. It opens Mail in Report mode with a derived title and a body trimmed to 2000 characters; choose the recipient before sending.

- Inbox renders one row per message (no sender-based collapsing)
- clicking a message in the Mail tab opens the task detail pane with full message content and conversation context
- reply rows in the mailbox modal can expand inline to show the replied-to message context for easier thread reading
- artifact registration itself does not create a new mail. Historical artifact notices remain actionable wherever they already exist: image artifacts show an inline preview plus **Open artifact**, while video/audio/document/other artifacts show an **Open artifact** link to the managed media URL. When `taskId` metadata is present, the same artifact block also shows **View task FN-NNNN** so users can open the producing task detail directly from the mailbox in the shared movable/resizable task-detail window.
- on first engine startup under Fusion `0.59.x`, each project receives one best-effort `system` inbox notice about the upcoming embedded-Postgres storage migration with the Discord help link; `metadata.kind = "postgres-migration-notice"` prevents duplicates across restarts.
- mailbox now includes an **Approvals** inbox scope with pending and history filters (`approved` / `denied` / `completed`), approval detail context, and inline approve/deny actions for pending requests
- for approvals gated by an agent's permission policy (permanent agents and task-worker heartbeats), the Approvals detail pane renders the gated action's real payload — tool name, shell command line or structured arguments, and working directory when present — instead of only a generic "Agent gated action for `<tool>`" summary; a stateless heartbeat retrying the same gated command reuses the existing pending approval instead of creating a duplicate (FN-7609)
- in the **Agents** scope, the agent selector now includes **All agents**, which shows one combined agent-to-agent stream (with sender + recipient labels); selecting a specific agent still shows Inbox/Outbox subtabs
- mailbox entry points now show unread/pending indicators: the desktop/tablet Header mailbox toggle shows a pending-approval dot first or an unread dot when unread mail exists without pending approvals, the mobile bottom-nav Mailbox tab carries the mobile badges/dots, and the compact Header actions overflow keeps a Mailbox entry only when the mobile bottom nav is disabled
- approval lifecycle SSE events (`approval:requested`, `approval:updated`, `approval:decided`) trigger mailbox approvals refresh without manual reload
- when a real pending mailbox approval request is created, the app shows a persistent approval banner above project content with an **Open Mailbox** CTA; task plan-approval states (`awaiting-approval`) remain visible on the triage board and do not create a mailbox banner
- when a task first transitions into `done`, the dashboard shows a one-time **Enjoying Fusion?** GitHub star prompt in the project view after first-run setup is closed; clicking **Star on GitHub** or dismissing the card marks it shown in browser `localStorage`, so it does not reappear on reload or later task completions. The setup wizard does not add a second star prompt.
- Visible message history/threading is driven by explicit `message.metadata.replyTo.messageId` links
- Compose can attach native missions, milestones, goals, research findings, eval results, and roadmap items as structural cards. Recipients can open the live structure from the message detail or conversation thread; a captured label keeps unavailable or soft-deleted attachments identifiable.
- Separate top-level messages from the same sender remain independent in the inbox and detail pane

![Mailbox view](./screenshots/mailbox-view.png)

## Interactive Terminal

Fusion embeds a terminal using xterm.js. Its native PTY binary is delivered by a script-free per-platform package, so normal installs need neither a compiler nor install-script execution. Supported terminal platforms are macOS arm64/x64, Linux x64/arm64, and Windows x64/arm64; 32-bit Linux (`ia32` and armv7) is not supported. If the terminal reports that its module could not be loaded, the message names the missing platform package; this usually means optional dependencies were omitted or `node_modules` was copied between operating systems.

<!-- FNXC:TerminalLayout 2026-09-15-21:04: FN-434 makes the pinned terminal a fixed height, turns its top grip into a detach gesture, and re-pins a floating terminal whose bottom edge is dragged onto the footer. -->
The pinned terminal has a fixed height and is not resizable. Drag the grip along its top edge to pull it out into a floating window; to put it back, drag that window down until its bottom edge touches the bottom bar and release. A click, or a window snapped to an edge of the work area, never re-pins it.

Desktop and tablet use the footer status bar as the terminal launcher; mobile keeps the full-screen terminal path. Known touch tablets, including at the 768px responsive boundary, retain the pinned/detached presentation rather than falling back to the phone sheet. Their touch drag and edge-or-corner resize controls stay available when a software keyboard shortens the visual viewport. In tablet floating mode, use the reserved grip at the left side of the terminal header to move the window; it stays available even when the tab strip overflows. True narrow phones, including folded panes and short phone landscapes, intentionally remain full-screen.

Quick scripts can be created and renamed from **Manage Scripts** with any non-empty name, including spaces, Unicode, and punctuation. Each script may include an optional description; desktop, tablet, and mobile quick menus show that description when present and otherwise show the command. Selecting the item always executes the saved command, never the descriptive text, and existing automation references follow a rename automatically.

<!-- FNXC:Terminal 2026-07-11-18:20: FN-7824 first-launch terminal sockets auto-retry with capped backoff until the first successful open, so the manual Reconnect affordance is reserved for terminal sessions that already connected and then exhaust their mid-session reconnect budget. -->
On first launch or first open, the terminal keeps reconnecting automatically until its initial WebSocket opens; it should show **Reconnecting...** during that cold-start recovery rather than requiring a manual **Reconnect** click. If an already-connected terminal drops and exhausts its bounded reconnect budget, Fusion then parks it as **Disconnected** and surfaces the manual **Reconnect** control.

<!-- FNXC:Terminal 2026-09-01-03:46: Closing releases the browser-side terminal connection while its server shell continues running. Reopening must reattach and replay retained output immediately; reserve the start-up state for a first open or the brief session-less replacement window after a background shell has died. -->
Closing the terminal releases its browser-side connection while the shell keeps running on the Fusion server. Reopening reattaches to that shell and immediately replays its recent output instead of showing a start-up state. **Starting terminal...** appears only when there is genuinely no session to reattach to: on the first open, or briefly while Fusion replaces a session that died in the background.

<!-- FNXC:TaskDetailTerminal 2026-08-28-23:05: FN-244 moves task spend into Stats, leaving Terminal after consolidated Details and Session after Terminal when both are available. The first shell uses task.worktree when present and otherwise falls back to the project base directory, including for multi-repo workspace tasks with no single worktree, while task-scoped terminal tabs remain separate from the footer/global project terminal. -->
Task Detail has two terminal-adjacent tabs when both are applicable: **Session** shows the pre-existing CLI agent session transcript/control surface, while **Terminal** embeds the interactive multi-tab terminal inside the task detail body. The interactive **Terminal** tab follows **Details**, and **Session** follows Terminal when an agent session exists. Its first shell starts in the task worktree when one is recorded, otherwise it starts in the project base directory (project root), including for multi-repo workspace tasks that have no single task worktree. When that task worktree is registered in the workspace picker, the picker shows the task worktree instead of **Project Root**; the footer/global project terminal keeps its separate Project Root default. Task-detail terminal tabs are stored separately from the footer/global project terminal tabs.

<!-- FNXC:TerminalSharing 2026-08-19-04:10: Terminal PTYs are server-side and accept several attached viewers, so sessions are shared across browsers rather than private to one. A browser with no stored tabs adopts the running sessions; closing a tab asks whether to detach here or end the session for everyone; the footer's Reopen control reattaches to sessions this browser is not showing. -->
### Shared terminal sessions

Terminal sessions run on the Fusion server, not in your browser, and several browsers can watch and type into the same session. Open Fusion in a second browser (or hand the URL to someone else on the same instance) and its terminal shows the sessions already running instead of starting a private one.

- **Closing a tab asks what you meant.** **Close in this browser** removes the tab here and leaves the session running for anyone else attached — and for you to reopen later. **End session** kills the shell for everyone. This prompt always appears, even with confirmation dialogs disabled, because guessing either way is destructive: one strands a session, the other destroys someone else's shell.
- **Reopen** in the terminal's bottom action footer lists sessions the server still runs that this browser is not showing — ones you closed here, or ones another browser opened — and reattaches to them. It is hidden when every running session is already open here.
- A browser that already has its own tabs keeps them; it does not adopt. Otherwise reopening Fusion would resurrect tabs you deliberately closed.

On Windows, the embedded terminal starts a supported shell inside Fusion, such as Command Prompt (`cmd.exe`) or Windows PowerShell. Windows Terminal (`wt.exe`) is an external terminal host and is not required or launched for the embedded panel, so Fusion should not show native Windows Terminal help/version popups while starting a terminal. If embedded terminal startup fails, Fusion shows an inline error with **Retry** instead of a blocking native dialog; install or repair Windows Terminal separately with `winget install Microsoft.WindowsTerminal` only if you want to use Windows Terminal outside Fusion.

<!-- FNXC:TerminalFooter 2026-09-15-07:57: FN-409 leaves the non-mobile terminal with exactly two presentations — pinned (default, in flow above the fixed bottom bar) and detached (a shared floating window). The pin/unpin toggle and the old overlay "docked" presentation are gone, so the top toolbar carries one presentation control (detach / re-attach) immediately left of close; action controls stay in the bottom terminal footer at every width. -->
Use the terminal on desktop/tablet:

1. Select the **Terminal** button in the footer executor status bar.
   Expected outcome: the terminal opens **pinned** — an in-flow panel across the bottom of the application, directly above the fixed bottom bar, that pushes the board, chat, and right sidebar up instead of covering them. There is no pin control to click first, and no empty band between the application content and the terminal: only the pinned terminal reserves the bottom bar's height. Font size / Clear / Shortcuts / Preferences and connection status render in the bottom action-control footer, while the single detach control renders in the top toolbar immediately left of the close button at every desktop/tablet width.
2. Drag the top edge of the pinned panel.
   Expected outcome: the panel height changes within its viewport-safe bounds, stays clamped short enough to keep the application usable, and persists per project.
3. Select **Pop out** from the top toolbar immediately left of Close.
   Expected outcome: the terminal becomes a floating window that behaves exactly like a task or conversation window: it opens at the standard window size centred in the work area — capped at about 62% of the work-area height like every other window — comes to the front when you click it, moves by dragging its header, and snaps to the work-area edges (left half, right half, full). Its size and position are not remembered between openings. On touch tablets, drag the reserved header grip rather than the horizontally scrollable tab strip.
4. Select **Dock** from the same top-toolbar control in the detached terminal.
   Expected outcome: the terminal returns to the pinned panel using the saved panel height.
5. Select the scripts chevron beside the footer **Terminal** button.
   Expected outcome: the quick scripts menu opens without toggling the terminal; choosing a script runs it in the terminal, and the menu footer opens script management.

Use the terminal on mobile:

1. Open the bottom navigation **More** sheet and select **Terminal**.
   Expected outcome: the terminal opens as a full-screen, keyboard-aware modal rather than the desktop/tablet pinned or detached surface.
2. Use the **Terminal tab** selector to switch between terminal tabs, or use the adjacent **+** action to open another Project Root terminal.
   Expected outcome: every terminal tab appears in the dropdown, switching preserves the active session, and the desktop horizontal tab strip is not shown on mobile. The same selector also appears on desktop/tablet when a narrow pinned or detached terminal does not have enough room to show the whole tab strip.
3. When multiple tabs are open, use **Close current tab** beside the selector, then close the modal when finished.
   Expected outcome: mobile can close the active terminal tab without exposing a cramped horizontal tab strip, and terminal sessions reconnect/recover normally without the desktop presentation affecting the mobile layout.

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

<!-- FNXC:GitManagerMobileSpacing 2026-08-01-19:31: FN-8702 documents that the standalone phone sheet ends strictly below 768px so its hidden desktop resize chrome cannot leave a right-edge gutter, while embedded and tablet presentations keep host-owned geometry. -->
Git Manager centralizes repo operations in the dashboard. On desktop/tablet (including exactly 768px) it is available as an embedded right-dock panel and can expand into a resizable modal; below 768px it opens as a full-width standalone phone sheet from the compact More surfaces.

Use Git Manager:

1. On desktop/tablet, select **Git Manager** in the primary navigation (bottom bar or left sidebar).
   Expected outcome: Git Manager opens as a full page with its section tabs and repository status, without a floating window or right sidebar.
2. Select the **Pull Requests** section.
   Expected outcome: the project's pull requests list appears inside Git Manager with its existing actions; opening one shows its detail in the same page.
3. On mobile, open the compact Header overflow or bottom **More** sheet and select **Git Manager**.
   Expected outcome: Git Manager opens as a full-width phone sheet with no desktop resize-handle gutter; its section tabs remain a horizontal scrolling strip. Embedded dock panels never take over the viewport.
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

Dismissing the banner suppresses each currently shown provider. GitHub Copilot stays dismissed permanently for that browser profile because its short-lived sessions can repeatedly emit successful-login events; clearing browser storage restores the banner. Other providers re-arm after a successful re-login. A silent refresh or temporary non-expired `/auth/status` response never clears a dismissal.

For OAuth credentials, the same `/auth/status` poll also attempts an automatic refresh through pi's `ModelRuntime` when the stored credential has a refresh token and the access token is expired or within the refresh buffer. Anthropic banner state is keyed to `anthropic-subscription` (including legacy Anthropic OAuth rows), not Claude CLI state. The banner polls every five minutes and also revalidates when its tab becomes visible or focused, so a successful refresh clears the provider without manual re-login or a stale Settings contradiction.

If the OAuth credential has no refresh token or the refresh request fails/leaves the credential expired, the provider stays expired and the banner remains visible. Re-authenticate with manual re-login from **Settings → Authentication** or Model Onboarding. On a remote dashboard, OpenAI Codex sign-in presents a device code and verification-page link instead of a localhost paste-back form. If a login cannot start, Fusion aborts that attempt and exposes the reason through the provider's `loginError` in `GET /api/auth/status`, so Cancel does not target a stale background flow. On Fusion desktop, browser OAuth URLs open in the operating system browser rather than an in-app Electron child window; the Settings/Onboarding UI keeps polling until the provider authenticates or the login truly stops.

<!-- FNXC:ProviderAuth 2026-07-05-00:00: FN-7574 — the status route and the engine's OAuthExpiryMonitor previously diverged: a subscription OAuth credential with a past or missing/non-numeric `expires` could still read authenticated:true from /api/auth/status even though the monitor had already fired an oauth-token-expired notification for it. `/api/auth/status` now treats any OAuth credential lacking a usable numeric `expires` — and any credential whose numeric `expires` is in the past and cannot be refreshed — as expired:true/authenticated:false, for both the legacy anthropic-row and separated anthropic-subscription-row storage permutations. Settings → Authentication and the global re-login banner both read this corrected status, so an expired-and-unrefreshable subscription now consistently shows as not connected everywhere. FNXC:ProviderAuth 2026-07-11-18:00: FN-7821 — OAuthExpiryMonitor now mirrors this refresh-then-recheck before dispatching oauth-token-expired, preventing false provider pushes (notably github-copilot ephemeral tokens) when the banner-driving status route would refresh and report healthy. -->

<!-- FNXC:ClaudeOAuth 2026-07-05-00:00: FN-7574 — beyond the reactive best-effort refresh on the /auth/status poll, the engine now runs an independent background OAuthRefreshScheduler (packages/engine/src/notification/oauth-refresh-scheduler.ts) on a 5-minute interval, guarded by the same `skipNotifier` option as OAuthExpiryMonitor. It proactively calls the existing refresh-if-due logic in auth-storage.ts for every known OAuth provider (plus the anthropic-subscription alias) so a healthy subscription's access token is renewed well ahead of expiry via the stored refresh token, instead of only refreshing reactively when something happens to request a runtime API key. Only providerId/providerName/expiresAt are ever logged — never token material. -->

Anthropic also supports a raw `ANTHROPIC_API_KEY` from a separate **Anthropic API Key** card in **Settings → Authentication** and Model Onboarding. Claude subscription OAuth remains on the **Anthropic Subscription** card for auth status, usage/subscription checks, and banner clearing; it also drives direct agent execution on the `anthropic` provider — a subscription/OAuth token runs `anthropic/*` selections against `https://api.anthropic.com/v1` with Claude Code identity headers, no API key required. If a legacy Anthropic OAuth sign-in is still stored alongside a listed Claude account, the subscription card displays a notice: the legacy sign-in is no longer used while an account is listed. If the listed account fails, re-authenticate it or re-select the intended account from the card. CLI-backed execution remains the distinct, explicit **Claude CLI** provider (`pi-claude-cli`); subscription OAuth does not require it. When Anthropic Subscription is expired but Anthropic API Key or Anthropic — via Claude CLI is already authenticated, the global banner suppresses only the urgent subscription re-login entry so it does not imply agents are blocked; Settings still shows the subscription OAuth card as expired/not connected and re-login remains available. A configured API key takes precedence over OAuth on the direct provider. Saving or clearing an API key does not affect the OAuth sign-in path or turn OAuth tokens into raw API-key material. The dashboard only displays masked key hints after a key is saved.

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

## Artifacts and documents in Task Detail

Artifacts and task documents no longer have a standalone dashboard destination. Open the producing task and use Task Detail instead:

- The **Artifacts** tab combines task documents with task-scoped registered media artifacts.
- Image, video, audio, document, PDF, HTML, and other registered artifact types remain stored and available there.
- Images support the authenticated image viewer; other media retain their existing preview or managed-media actions.
- Task documents retain revision-aware creation and editing, including conflict protection when another writer updates the same document.
- Completion mail embeds only registered image artifacts. Plans, documents, video, audio, and other artifacts remain in Task Detail rather than being duplicated in Mailbox.

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

Task-document and project-file previews support toggling between raw text and formatted markdown:

- **Raw mode** (default): Shows markdown syntax as plain text (e.g., `**bold**`)
- **Markdown mode**: Renders markdown with proper formatting (e.g., **bold**, headings, lists, tables)

The toggle button is accessible with `aria-pressed` for screen readers. Toggle state is scoped per-document, so switching between documents resets the view to raw mode.

Project-file previews and selected Task Documents support selection comments in both raw and rendered markdown modes. Select text, click **Add comment**, enter a short note, and Fusion opens **New Task** with a seeded description containing the file path or task-document key, snippet, and comment.

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

## Ideation View

<!-- FNXC:Navigation 2026-08-01-00:00: FN-8352 promotes Ideation from Command Center into one default-off experimental top-level destination. Desktop uses the sidebar (or Header More fallback when the sidebar is opted out), while mobile always keeps it in More rather than a configurable footer tab. -->
Ideation is a standalone dashboard surface for capturing divergent candidates and converging one into the Mission hierarchy.

> Available only when `experimentalFeatures.ideationView` is enabled. The flag is off by default and is managed in **Settings → Experimental Features**.

Navigation:
- Desktop/tablet: **Left sidebar → Ideation**, or the Header **More views** menu when the desktop sidebar is opted out
- Mobile: **More** sheet → **Ideation**
- Mobile footer customization never promotes Ideation to a primary tab, including when older persisted settings list it

The view replaces the former **Command Center → Ideation** tab. It preserves the same empty, populated, converged, and request-error states, so sessions and Mission handoff evidence remain in one canonical surface.

## Files Modal

The Files modal provides a workspace-aware file browser and editor.

<!-- FNXC:FileBrowser 2026-09-09-21:10: Folder-list sorting is shared by the Files modal, right dock, and Settings pickers. Document directory priority, deterministic missing-metadata handling, and the recursive-search limitation so operators do not mistake server search order for a date or size sort. -->

- Use **Sort by** to order the current folder by **Name**, **Date modified**, or **Size**, then use the adjacent direction button to switch between ascending and descending order. Directories always remain before files. Equal values are ordered by name; missing sizes and missing or invalid dates remain after known values in either direction. Directories have no invented size and stay name-ordered when **Size** is selected.
- Sorting is local to the current folder and starts at name ascending each time the browser mounts. During recursive **Search project files**, the sort controls remain visible but unavailable because search results do not include date or size metadata; clearing the search restores the selected folder sort.
- In **Files — Project**, use the visible **Create new file** and **Create new folder** buttons in the browser header to create entries in the current folder; new files open in the editor after creation
- In **Files — Project**, use **Search project files** to find project files recursively without navigating the tree; matching rows include path context so duplicate filenames can be distinguished
- Source/text editing supports a **Line #** header toggle to show or hide line numbers in the editor gutter
- The line-number preference is saved per project and restored automatically when you switch projects
- Known image, video/movie, audio, and PDF files render browser-native read-only previews inline with their real content type from the selected project or task workspace download URL; the explicit **Download** action still saves files as attachments, text files remain editable, and unknown binary files keep the read-only editor fallback
- In editable files and markdown preview mode, highlighted text exposes **Add comment** so you can send the file path, selected snippet, best-effort line range, and your note to the **New Task** dialog without copy/paste

## Memory View

Memory view provides a multi-file editor for project and daily memory files. Its file editors share the same highlighted-text **Add comment** affordance as the Files modal, so memory snippets can seed a New Task with file path, snippet, and comment context. Editable file editors also provide localized **Undo** and **Redo** toolbar controls and the standard platform shortcuts: <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> to undo, plus <kbd>Ctrl</kbd>+<kbd>Y</kbd> or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> to redo.

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
- The org chart and live-agent cards share one refcounted agent-activity stream: one seed request, SSE subscription, and local expiry clock for all mounted consumers. Events are ordered by `(occurredAt, eventId)` so a replay cannot replace newer activity. Nodes show active, idle, or error activity; no-data deliberately renders no extra activity affordance. Recent manager-to-agent handoffs animate along existing connector edges, while reduced-motion preference retains a static direction indicator. Live-agent cards show pushed “now doing” prose immediately; canonical step numbers and last completed steps remain sourced from the existing task-detail poll.
- Filter by role/state, include/exclude system agents, and inspect health/status
- **Token Usage by Agent** includes task-derived token counts for ephemeral/task-worker system agents when system agents are shown, matching Agent detail and Command Center Team token surfaces.
- Agent list cards show the configured **Model** or plugin **Runtime** for each agent, falling back to **Auto** when no override is set
<!-- FNXC:AgentTaskStateDrift 2026-06-27-16:46: Agent task badges include the linked task column so parked `triage`/`todo` ownership from the FN-7138 invariant is not misread as execution drift. -->
- Agent list, live-agent, and detail task badges show the linked task ID with its current column when the task is non-terminal (for example `FN-6902 · Planning` or `FN-6902 · In Progress`). Terminal linked tasks are omitted, and unresolved column lookups render an explicit `Unresolved task` suffix so missing or deleted task links are not mistaken for healthy parked work.
- First-run setup asks whether to create an optional project agent after project registration. The default template is **CEO**; users can choose another preset, use the AI interview when `experimentalFeatures.agentOnboarding` is enabled, or skip it. Fusion can still build tasks without an agent by starting temporary agents to plan, code, review, and merge task work.
- Start, pause, stop, and trigger agent runs from the view and from detail panels
- **Heartbeat controls** appear on every durable-agent List, Board, and Org chart card and in Agent detail settings. Heartbeats default to enabled unless `runtimeConfig.enabled` is explicitly `false`; changing this setting preserves the agent's other runtime configuration and does not pause, resume, or otherwise alter the agent lifecycle.
- The Agents controls menu also provides **Enable all heartbeats** and **Disable all heartbeats** for every eligible durable agent in the current project, regardless of the active filter or layout. Each action confirms its target count, excludes ephemeral/task-worker agents, refreshes after completion, and reports skipped or failed updates rather than treating the batch as atomic.
- In **Agent detail**, use the kebab **Bulk agent actions** button in the header utility cluster (next to **Refresh** and **Close**) to run project-wide lifecycle transitions for non-ephemeral agents in the current project — **Pause All Agents** targets agents in the `active` or `running` state, while **Resume All Agents** targets agents in the `paused` state only
- In **Agent detail → Settings → Configuration**, the built-in-model picker includes a concrete **Thinking Level** selector; changing it autosaves to the agent's `runtimeConfig.thinkingLevel` alongside the provider/model choice.
- Bulk menu items stay disabled when nothing is eligible and show an inline hint (`Loading eligible agents...`, `No active agents eligible`, `No paused agents eligible`, or the current eligible count such as `Pause 2 active/running agents`)
- Bulk lifecycle flow: open **Bulk agent actions**, review the eligibility hint, confirm the modal, then use the success or partial-failure toast to verify paused/resumed counts plus skipped/failed agents
- Open agent detail tabs for runs, logs, read-only mail (agent inbox/outbox), settings/config, tasks, memory, and chain-of-command relationships. Run history uses the same redacted, per-row bounded tool detail on initial load and live streaming; long values retain the visible preview and reveal interaction used by task logs.
- Error indicator on agent list cards when an agent is in the `error` state and has a captured error (`lastError`); select it to open **Agent Error Details**
- Run-level error indicator in **Agent detail → Runs** when a run has captured stderr; select it to open the same **Agent Error Details** modal
- **Agent Error Details** shows full error text plus **Copy** and **Report on GitHub** actions
- **Report on GitHub** opens a pre-filled issue draft with available context from where you launched it (surface plus agent metadata, and run/task IDs when available on that view)
- Jump from agent activity to related task logs, and (when `experimentalFeatures.agentOnboarding` is enabled) launch **AI Interview** from the New Agent dialog (create mode) or Agent detail → Settings (edit mode)

For full lifecycle behavior, runtime/heartbeat settings, and budgets, see [Agents guide](./agents.md).

## Missions View

<!-- FNXC:MissionRowActions 2026-09-17-03:18: FN-486 moves every secondary mission/draft/hierarchy row command into the shared list-row context menu; header and detail controls are unchanged. -->
Les commandes d’une **ligne** de Missions s’ouvrent par son **menu contextuel** : clic droit, touche **Menu** ou **Shift+F10**, appui long au doigt ou au stylet. Aucune ligne ne porte plus de bouton ni de « … » permanent.

- Mission de la collection principale : **Start**, **Stop**, **Resume**, **Clear blocked status**, l’accès aux échecs, **Edit mission**, **Delete mission**. Les conditions par statut, l’état désactivé d’une réparation déjà en cours et la confirmation de suppression sont inchangés. Le compteur d’échecs et le texte d’aide d’exécution restent lisibles dans la ligne, comme informations.
- Brouillon d’entretien : **Resume**/**Retry**/**Review** selon son statut (l’état « Generating » reste désactivé) et **Discard draft**, avec sa confirmation distincte. Un brouillon ne s’édite pas.
- Jalons, slices, features et assertions : leurs commandes suivent la même règle et les mêmes conditions qu’auparavant (planification, activation, triage groupé, validation et réparation, lien/déliaison de tâche, lien/déliaison d’assertion, modification, suppression). L’expansion, la consultation d’une tâche et les formulaires déjà ouverts gardent leurs propres contrôles.

La commande vise toujours la ligne touchée, jamais la mission sélectionnée ; ouvrir un menu ne charge pas la mission, ne replie pas sa hiérarchie et ne déclenche aucune mutation. Les commandes de l’en-tête et du détail (créer, fermer, retour, réparations du panneau de détail) sont conservées telles quelles.

Missions view manages mission hierarchies and task handoff from milestones, slices, and features.

<!-- FNXC:StandardizedMissionLayout 2026-09-16-15:50: FN-465 removed mission archiving from the UI; the list shows active missions only and the status selector no longer offers an Archived transition. -->
Archiving is no longer offered in Missions: the list has no **Show archived** filter, missions already archived stay stored but are never listed, and the mission status selector no longer offers **Archived** as a transition (it only displays that value, disabled, for a mission that is already archived).

<!-- FNXC:MissionWorkflows 2026-06-25-06:04: Missions creates tasks from feature and slice triage, so the user-facing guide must document that its header workflow selector matches Planning and carries the selected workflow into mission-created tasks. -->

Workflow behavior:
- When workflow columns are enabled and more than one workflow is available, Missions shows the same header workflow selector as Planning.
- Feature triage and slice **Triage all features** create new tasks on the selected workflow.
- If no workflow is selected, or workflow columns are unavailable, mission-created tasks continue to use the project default workflow.

<!-- FNXC:MissionInterviewDocs 2026-09-15-03:29: FN-395 made Plan Mission with AI part of the Missions main content instead of a floating window, and FN-402 places it in the mission DETAIL PANE rather than in place of the mission list, so the list stays visible and the Missions Back control is phone-only. Stream failures still surface one recoverable retry state instead of leaving the interview spinning. -->
<!-- FNXC:PlanningInterview 2026-06-26-00:00: GitHub #1794 requires structured planning, mission, milestone, and slice interview questions to let users reject all provided single-select/multi-select options by choosing Other and writing their own answer. -->

Plan Mission with AI behavior:
- **Plan Mission with AI** is a main-content surface, not a modal. Starting or resuming an interview fills the mission **detail pane** — the right-hand region that otherwise reads *Select a mission to view details* — while the mission list stays visible beside it, exactly like Planning shows session detail beside its session rail.
- Desktop, tablet, and mobile share the same embedded flow. There is no overlay, no title-bar drag, no resize handle, and no remembered window size or position.
- The Missions **Back** control exists only on the phone viewport, where a single pane is visible at a time. Desktop and tablet keep list and detail side by side, so no Back control is shown at all.
- Closing the interview (the header **Close** button or `Escape`) returns the detail pane to *Select a mission to view details* without cancelling the interview session; an un-started goal draft is preserved.
- When an interview is resumed, the header also offers **Send to background** so the session keeps running while you return to the mission list.
- If the mission interview stream reports a terminal failure, the interview closes the failed stream, shows one normalized error, and offers retry without duplicating late error/complete events.
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

### Task concurrency capacity

**Settings → Scheduling**, Command Center controls, and the Engine Control menu edit two independent project limits. **Max Concurrent Tasks** (range 1–50; default 2) caps every AI-active task, including planning, to protect provider load. **Max Worktrees** (default 4) caps tasks holding or entering execution checkouts to protect host CPU, RAM, and disk; it does not limit planning and can be disabled structurally. Team status displays both values separately, and the board's **Up Next** worktree grouping uses Max Worktrees.

Navigation:
- Desktop/tablet: primary header view toggle, immediately after **Agents**
- Mobile: bottom nav tab, immediately after **Mailbox**
- Deep link: `?view=command-center`

Features:
- A single section dropdown in the header selects every Command Center section, including optional **Nodes** when enabled. On desktop and tablet the last selected section is remembered per project; on phones every open lands directly on **Overview** content, and the section list stays one tap away through the header back action. On mobile and tablet, the content panel remains the sole vertical scroll owner.
- Global date-range picker in the header scopes the analytics sections; **Last 24h**, **Last 7 days**, **Last 30 days**, **All time**, and custom/open-ended ranges each request their selected analytics window. **Mission Control** remains live rather than historical.
- **Agent Activity** is an org-wide event surface, separate from the aggregate **Activity** analytics tab. **Live** seeds a running feed from `GET /api/agent-activity` and receives `agent:activity` SSE frames; **Timeline** provides filters for agent, task, and event type plus manual scroll-back paging. Agent state-change events are excluded from both lists and the type filter; use the roster and Live Agent cards for current agent state. Its time picker filters the loaded timeline client-side because the route exposes no time-range parameter. Entries open their originating task or agent detail. The feed does not use `/api/activity-feed`; backward paging echoes the server `nextCursor` into exclusive `before` over unique `seq` values, so changing bound inclusivity or `seq` uniqueness would break lossless timeline paging.
<!-- FNXC:CommandCenter 2026-06-25-19:47: FN-7019 restored the user-facing picker contract: preset and custom date-range selections must change every historical analytics tab, while Mission Control stays live and intentionally ignores historical range filters. -->
<!-- FNXC:CommandCenter 2026-06-19-23:54: FN-6755 moved team-specific operations out of Overview: org hierarchy and heartbeat pause/resume live in Team, while Overview keeps global AI engine, concurrency, and theme controls. -->
<!-- FNXC:GlobalConcurrencyControls 2026-06-26-00:00: The Command Center Concurrency card mirrors the footer concurrency popover by showing read-only running-agent counts and current-use markers for the shared global cap and current-project max-concurrent slider. -->
<!-- FNXC:GlobalConcurrencyControls 2026-07-15-17:30: FN-8007 aligns each current-use marker with its native range thumb: it maps the cap-clamped running count min-relatively across the expanded slider range. One running agent at slider minimum remains visible at the track start, and over-cap use pins to the cap thumb rather than the track end. -->
<!-- FNXC:CommandCenter 2026-06-26-00:00: The four Overview Concurrency sliders change live scheduler capacity, so each settled edit opens a confirmation popup before persisting; cancel, backdrop, or Escape leaves the previous persisted value in place. -->
<!-- FNXC:CommandCenter 2026-06-27-10:03: Tokens detail charts must show every model bucket returned by analytics for accurate spend attribution; Overview remains a compact top-model summary because its copy explicitly frames those cards as top consumers/share. -->
<!-- FNXC:CommandCenterActivity 2026-06-30-00:00: Activity active-agent counts include both durable-agent usage events and ephemeral task-worker execution runs from agentRuns, because task execution can be visible without a matching usage_events row. -->
<!-- FNXC:CommandCenterActivity 2026-07-01-00:00: Graph-owned workflow step sessions publish active-to-terminal agentRuns lifecycle rows with task lineage and step metadata, so daily activity and Activity throughput charts include new workflow execution without dashboard-side recounting. -->
<!-- FNXC:CommandCenterActivity 2026-08-09-10:46: Every durable and ephemeral agent lane writes one agent-session usage event, while CLI sessions remain the sole cli_sessions writer. Human chat and mailbox sends write content-free user_message events; a single-node deployment correctly reports Active nodes 0 when no mesh node id exists. -->
- **Activity telemetry** records one `usage_events` agent session for every durable and ephemeral heartbeat, executor, workflow-step, triage, reviewer, and merger lane. **Sessions** is the sum of CLI `cli_sessions` and `agent-session` `session_start` events; each session class has one writer, so they do not double-count. Human-authored chat and mailbox messages record content-free `user_message` events. **Active nodes** uses only the mesh routing node id, so it correctly remains 0 on a single-node installation with no node id.
- **Overview controls dashboard** includes AI engine stop/start backed by `globalPause` and current-project **Max concurrent tasks** plus **Max worktrees** controls. Both capacity sliders remain visible while settings load or fail, but are disabled until settings are editable; a failed load shows its error and an intentionally disabled worktree limit explains how to enable it in Settings. Max concurrency caps top-level working agents across planning, execution, and review/merge; a free project slot serves review/merge first, ready execution second, then planning, with age and task ID deciding order only within each lane. The footer reports **Waiting**, **Running (N/max)**, and **Blocked**; column headers report only the number of tasks in the lane. Nested helper agents remain parent-internal and may temporarily exceed the displayed top-level count.
<!-- FNXC:TeamArea 2026-07-18-12:30: FN-8351 moves organization export and import to the Team tab so team-level portability controls are not presented as Overview dashboard controls. -->
- **Team tab — Org export / import** lets an operator download a portable organization JSON bundle or paste one for a dry-run preview before confirming the apply step. Exports are secret-scrubbed by default: credentials and tokens are never included, while safe secret references can remain for setup in the destination project.
- **Configuration versions** lives in **Settings → Project → Configuration Versions**. It lists recorded project-setting revisions newest first; select **Roll back** on any revision and confirm once to restore it. The restore is recorded as a new forward revision, so it can itself be undone without manually reconstructing settings.
<!-- FNXC:SettingsNavigation 2026-07-18-12:30: FN-8350 keeps configuration revision history out of Command Center and makes Settings its single operator destination. -->
- **Overview** summarizes token usage/cost, autonomy, active nodes, sessions, agent runs, tasks done, model breadth, and real open signals, and includes the SDLC throughput funnel for the selected range at the bottom of the Overview content in loading, error, empty, and populated states. **Codebase tokens** is a local-only `cl100k_base`-calibrated pre-tokenization estimate; it does not upload source content or add a runtime tokenizer. **Disk size** is local apparent size (regular files and symlink entries only, not allocated blocks or directory bookkeeping). Both project-intrinsic cards render even before agent usage settles and show `Approx. (partial)` when bounded traversal is incomplete. Git projects scan non-ignored tracked files; non-git fallback excludes only directories whose basename starts with `.` or is exactly `node_modules`, `dist`, or `build`. Source candidates are lstat-gated regular files (symlinks and out-of-root candidates are skipped); disk walking does not follow symlinks. Defaults cap source scanning at 50,000 entries, 4 seconds, 64 MiB total, and 2 MiB/file, disk walking at 500,000 entries and 4 seconds, and cache results for two minutes. System telemetry now formats small byte quantities granularly as B/KB rather than displaying sub-MB values as 0 MB. Its token total and Live activity snapshot token metric refresh on a bounded live cadence and animate number changes while preserving reduced-motion preferences. The sessions card uses the selected-range `ActivityAnalytics.sessions` value already loaded for the overview. The Live activity snapshot refetches on relevant task/session/run events and polls while live work is in flight; its tasks-in-progress count is the current, project-scoped board total across `in-progress`, `in progress`, and `doing` columns, independent of the selected analytics date range. Its agents-working count is likewise current live sessions plus active heartbeat runs rather than the historical range aggregate. Overview's active-agent and daily activity values count durable-agent usage events plus ephemeral task-worker execution runs, including graph-owned workflow step sessions that publish `agentRuns` lifecycle rows, with the same agent counted once per day/range if both sources record activity. Overview includes a graph-rich software-factory snapshot with the existing top-model-consumers bar, tool-category bar, top-model token-share pie, and the daily activity multi-series line chart placed before the daily activity sparkline/trend so the richer line graph sits higher in the chart grid. These reuse the already-loaded tokens, tools, activity, and signals analytics; the signals count comes from `/api/command-center/signals` and renders unavailable (`—`) while the incidents-backed response is loading or unavailable. The chart reveal/glow accents are decorative and disabled when reduced-motion preferences are active. The SDLC completion rate is shown as a radial gauge and is calculated as cohort conversion from in-range triage entrants, so the rate is capped at 100% even when older tasks finish during the range.
<!-- FNXC:CommandCenter 2026-06-21-00:00: Command Center cost must read as an estimated, derived value from recorded token counts and the hand-maintained model pricing map; it is never persisted, and the UI must surface prices-as-of, stale low-confidence, and unavailable unknown-model states instead of implying billing truth. -->
<!-- FNXC:CommandCenter 2026-06-22-00:00: FN-6876 requires user-maintained/LiteLLM-fetched pricing overrides to feed Tokens and Team estimates immediately without implying provider billing reconciliation. -->
- **Tokens** breaks down token totals, estimated cost, task count, chat-turn count, and per-model usage. Per-model and per-provider breakdowns include task execution tokens plus supported dashboard chat, task-detail planner chat, and room responder turns when their runtime exposes authoritative session token stats; CLI-backed chat and title generation are excluded until those paths expose reliable stats. Task counts remain task-only while chat turns are counted separately, so task detail token panels stay execution-scoped and planner chat does not double-count the task it discusses. Per-model and per-provider breakdowns use the task/chat analytics-only actually-used model snapshot when available, so usage from settings-resolved runs appears under the real runtime model instead of `(unknown)` without changing future model resolution; estimated cost uses the same snapshot-first, legacy-fallback model identity so those resolved runs price normally when the model is in the pricing table. Estimated cost is derived at read time from recorded token counts multiplied by the effective per-model pricing table: Settings → Global Models pricing overrides win first, then the built-in fallback table is used. It is not persisted, so historical rows stay tied to current maintained prices instead of stale stored billing truth. The Tokens area shows a **prices as of** date/source for the effective table, marks pricing older than the staleness threshold as low-confidence, and shows cost unavailable for models with no pricing entry rather than guessing a price. It includes the existing token-usage-over-time chart, an additive recharts multi-series line graph, a full token-by-model bar, and a token-share pie backed by every grouped model returned by token analytics; use the granularity control to switch the time-series request between hourly, daily, and weekly buckets. The token total and charts poll on a bounded cadence, keep the previous data visible during refresh, animate decorative count/bar transitions, and disable those animations for reduced-motion users.
- **Tools** shows autonomy ratio, tool-call volume, intervention counts, sessions, and tool categories. The area keeps the existing category bar and adds a recharts category-share pie from `ToolAnalytics.byCategory`. There is intentionally no tools line chart yet because `ToolAnalytics` does not expose a per-day tool trend; the dashboard does not fabricate one or call a new endpoint.
- **Activity** tracks sessions, messages, active nodes, active agents, agent heartbeat runs, and stickiness. Sessions are the sum of CLI `cli_sessions` and agent-lane `usage_events` (`session_start`, `category: agent-session`), with one writer per session class so they cannot double count. Heartbeat, executor, workflow-step, triage, reviewer, and merger lanes emit those events for durable and ephemeral agents. Human chat and mailbox sends emit content-free `user_message` events. Active agents include durable-agent `usage_events` and ephemeral task-worker `agentRuns` rows in the selected range; graph-owned/new workflow step sessions publish those `agentRuns` rows as they move from active to completed/failed, duplicate same-day agent ids across both sources count once, and run-only task workers still make the active-agents lines and stat cards non-zero. Active nodes reflects mesh routing node ids only, so it is correctly zero on a single-node install. Agent-run sheets show total, active, completed, and failed runs for the selected range, and the Agent runs/day sparkline trends runs by `agentRuns.startedAt`. The area keeps the existing live animated line charts for messages/day, active agents/day, active nodes/day, and combined throughput/day (`messages + active agents + active nodes`), and adds a recharts multi-series line graph for messages, active agents, and agent runs plus an agent-run outcome pie from the existing `agentRuns` split. These charts reuse the existing activity analytics endpoint, refresh on a bounded 15-second cadence while mounted, keep the previous data visible during refreshes, and disable decorative draw-on motion for reduced-motion users.
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

- **Signals** is backed by the project-scoped `/api/command-center/signals` endpoint, which aggregates real rows from the local `incidents` table. Verified external connectors (`POST /api/signals/github`, `/gitlab`, `/webhook`, `/sentry`, `/datadog`, and `/pagerduty`) create triage tasks and also write/resolve incidents, so Signals shows total/open/resolved counts, MTTR when resolved incidents have enough timestamps, and source/severity/status breakdowns from connector traffic. GitLab supports GitLab.com and self-managed project/group issue and merge-request webhooks through the environment-only `FUSION_SIGNAL_GITLAB_SECRET` and `X-Gitlab-Token` header; no GitLab CLI or server-side link fetch is used. Signals adds an open-vs-resolved status pie from the same response. Signals has no per-day series today, so it intentionally does not render a line chart or fabricate a trend. The companion `/api/command-center/signals/connectors` endpoint returns only per-provider configured booleans, allowing the empty state to distinguish "no connector configured" from "connector configured, awaiting signals" without exposing secrets.
- **System** is the canonical system-telemetry destination and Command Center report home. Its guided **Report** menu files Bug, Feedback, Idea, or Help reports without opening a raw prefilled GitHub issue; **Copy diagnostics** remains a separate local control. System reads local telemetry from `GET /api/system-stats` and, when multiple registered nodes exist, shows a node selector that can proxy the same system-stats payload through `GET /api/nodes/:id/system-stats` for remote nodes. It renders live radial gauges for app CPU, host memory, and heap usage, keeps a small client-side rolling buffer for CPU/memory/heap trend sparklines, adds a recharts CPU/memory/heap line from that same rolling buffer, and adds a task-by-column pie alongside the existing tasks-by-column and agents-by-state bars. Host memory uses OS-available memory (Node `process.availableMemory()` when available, with a flagged `freemem` fallback) so macOS inactive/cache pages are not reported as used. The Vitest process count, manual kill confirmation, auto-kill toggle, threshold controls, and last-auto-kill timestamp moved here unchanged; the standalone System Stats modal and its desktop Header/mobile More affordances were removed.
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

1. On desktop/tablet, select **Git Manager** in the primary navigation, then select **Recovery**.
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
- A built-in runtime without an installed plugin record offers **Install** only. Once installed, it exposes project-scoped Enable/Disable, management, and uninstall controls; toggling never installs or reinstalls a runtime. The Runtimes settings cards mirror the installed runtime state instead of showing a stale detected/connected status.

For full plugin lifecycle workflows (discovery, install, enable/disable, configure, update, uninstall, troubleshooting), see [Plugin Management](./plugin-management.md). For plugin-related settings and experimental toggles, see [Settings reference](./settings-reference.md).

## Pi Extensions Manager

Pi extension management lives in **Settings → Plugins → Pi Extensions**.

Features:
- Add/remove Pi package sources (npm, git, or local)
- Reinstall the Fusion Pi package/skill bundle
- Enable/disable discovered extensions
- Manage extension, skill, prompt, and theme path lists in one place

For related global/project configuration behavior, see [Settings reference](./settings-reference.md).

## Dynamic list performance

<!-- FNXC:DynamicLists 2026-09-07-17:16: FN-311 requires every potentially unbounded dashboard collection to combine bounded server pages with a bounded DOM window. Page sentinels fetch automatically near the relevant scroll edge, while stable item identities preserve live updates, filters, selection, and prepend anchoring without a manual “Load more” action. -->

Task columns, conversation indexes and transcripts, logs, recommendations, history feeds, missions, Git history, and agent activity progressively fetch bounded pages as the viewport approaches their edge. Large loaded collections render only a small overscanned window; spacer geometry retains the native scrollbar and variable-height rows are remeasured without changing logical item identity. A failed continuation remains retryable by revisiting the edge, while collection/project/filter changes invalidate stale responses.

## Task Detail Modal

Inspect task definition, logs, review feedback, comments, artifacts, workflow outcomes, model overrides, and task routing from a single modal.

<!-- FNXC:TaskDetailDefinition 2026-09-14-21:00: FN-391 removed the Summarize-as-title action from Task Detail; a generated title comes only from the create-time automatic policy. -->
- Task Detail has no title field and no Summarize action. A task's title is generated once at creation when **Auto-summarize task titles** is on, or supplied explicitly by an API/import/integration writer; a titleless task renders from the first 220 characters of its description everywhere it is listed.
- The top-level **Chat** tab appears first for active task details and is the default landing tab for non-`done` tasks. It uses the project Direct Chat default model and thinking level, and exposes one Brain popover with model-only targeting and thinking-level selection without impersonating a Direct Chat agent. Opening the tab is lookup-only: Fusion creates the task-scoped Chat session only after you send a composer message, starter prompt, or question answer. Once a user message exists, the resumable planner chat can appear in the global Chat list; interacted chats are kept when the task reaches its workflow's Complete column and removed when the task is deleted. Each send includes bounded server-built task context so the planner can answer current status, progress, recent activity, dependency, and task definition questions. It shows starter prompts for common planning questions, can render structured planner questions, and converts only explicit operator steering intent through the scoped steering tool. The composer stays pinned while the transcript, loading, error, starter, history, and streaming states scroll internally; on mobile/narrow task detail, the default focused Chat layout hides nonessential title/metadata/tab/action rows until you collapse it from the in-view expand control.
- The **Activity** view picker offers **Live**, **Feed**, **Raw Logs**, and conditional **Interventions**. Live and Raw Logs show persisted tool arguments and results directly; long payloads stay visible as a clamped preview with an explicit reveal control, and unavailable historical detail is explained inline. Live, Feed, and Raw Logs share an expand/collapse control that lets the active segment fill the task-detail modal, then restores the normal header, tabs, and action footer when collapsed.
- The **Summary** tab is available for every task and is the default landing tab for completed work. It starts with **Work done by agents**: Plan, Code, and Review report stages appear in chronological order with static headings and counts—there are no collapsed accordions. Every dated, markdown-formatted report is visible immediately; review reports preserve the reviewer's rationale, multi-repository reviews retain each repository's note, and legacy verdicts with no rationale show an explicit no-notes line. The completion summary always appears exactly once at the end of Review, regardless of which summary-projection workflow node produced it, and carries no verdict or status pill because it is a report rather than a decision; a missing report stays explicitly empty rather than being fabricated. There is no Merge stage: Summary owns neither spend nor landed-commit facts, and landed-commit facts appear only in the trailing merge panel for completed work.
- Legacy History links open the **Summary** report view. Summary loads the same live workflow results as Workflow, while the Activity picker remains limited to operational views.
<!-- FNXC:TaskRecommendations 2026-08-19-13:05: Task Detail docs distinguish optional capture from the project opt-in that requires an explicit quality-first evaluation without turning the cap into a quota. -->
- The **Recommendations** section appears at the end of Summary only when a completed task has captured at least one recommendation. At accepted completion, executors evaluate optional, non-blocking out-of-scope findings and submit task-ready recommendations; an explicit `[]` means none qualified, not that filler should be invented. The project cap bounds captured results, and `maxRecommendationsPerTask: 0` disables capture. Enable **Settings → General → Require automatic task recommendations** to make every positive-cap successful completion explicitly submit an array at the accepted completion checkpoint; this is automatic executor capture, not a background generator or a retroactive backfill. The executor aims toward the configured maximum from concrete source-task/worktree evidence, but a shorter list or `[]` is correct when grounded candidates run out. Duplicate, restated, speculative, filler, or scope-drifting suggestions are never valid, and relevance always outranks count. A non-empty set sends one mailbox notice per distinct recommendation-id set only after completion is accepted; interrupted or rolled-back handoffs and linking an already-captured recommendation to a created task send nothing. Delivery is asynchronous and best-effort, so it never delays task completion; **Settings → General → Recommendation mailbox notices** can disable only this notice, not capture. For executing agents, recommendations are the only out-of-scope channel; they implement in-scope needs directly and use the honest blocked exit only for real external blockers. Fusion does not automatically create follow-up tasks from recommendations and does not generate them for already-completed tasks; operators use each row's **Create task** action when appropriate. Each row shows a task-ready title, category, and description. **Create task** uses the normal guarded intake policy (including duplicate checks), so a duplicate conflict creates no child and leaves the recommendation available to retry; successful repeated clicks reuse the same linked triage task. The same recommendations also appear project-wide in **Insights → Task Recommendations**, where bounded pages load automatically as the reader approaches the end; no manual pagination control hides later suggestions.
- The **Stats** tab is available for tasks in every column and owns all token and cost numbers. It combines task-level totals and cache ratios with the read-time derived per-model breakdown (input, output, cached, cache-write, total tokens, derived USD) and a task total; no token usage shows an explicit empty state, while unpriced or zero-usage rows use `—` instead of a guessed `$0`.
<!-- FNXC:Settings-ThinkingLevel 2026-07-13-00:27: The task-detail Models tab now persists validatorThinkingLevel and planningThinkingLevel separately so Reviewer and Planning lanes can choose reasoning effort without changing the Executor lane's task.thinkingLevel. -->
- The **Models** tab exposes inline **Thinking Level** selectors for **Executor Model**, **Reviewer Model**, and **Planning Model**. Executor saves the shared task thinking level, while Reviewer and Planning save independent per-lane overrides; leaving either lane on **Default** inherits the shared task thinking level and then the configured workflow/project defaults.
<!-- FNXC:TaskDetailStats 2026-08-28-23:05: Stats owns read-time token and pricing data without persisting derived USD or showing an unavailable model as a false zero. The per-model table remains horizontally scrollable on narrow detail views. -->
- Task-detail Activity steering comments are persisted as user comments/steering guidance and surfaced to every relevant agent lane: live executor sessions receive steering injection, while planner, reviewer (spec/plan/code), and merger agents (standard and clean-room AI merge/review) receive the latest user comments in their next prompt/pass.
- Priority remains editable without entering full edit mode through its labeled choices in the footer **Actions** menu.
- Execution mode remains a read-mode Fast/standard toggle in the footer **Actions** menu without opening the full edit form.
- Attach file, eligible-task GitHub tracking, Oversight, Priority, and Fast execution mode share the existing flat footer **Actions** list on desktop and mobile; the former square inline icon cluster and its separate popovers no longer consume permanent header space.
<!-- FNXC:TaskDetailWorkflowBadge 2026-06-29-18:45: Task Detail header metadata shows the resolved workflow name when board-workflows metadata is available, but omits the chip entirely for missing or stale workflow payloads so embedded, modal, and mobile headers do not render empty badge shells. -->
- The top of **Details** groups provenance, optional workflow identity, optional PR context, and compact `Created` / `Updated` timestamps in one wrapping metadata section across desktop and mobile widths. Recent timestamps render as relative time (`just now`, `Xm`, `Xh`, `Xd`) and older values switch to short month/day dates; unresolved workflow identity leaves no empty badge shell.
- The **Actions** menu exposes **Pause** / **Unpause** for eligible non-terminal tasks, including tasks assigned to agents. If a task was paused by an agent, the **Paused by agent** note is informational; users can still unpause it manually from the same menu. On mobile task popups, tapping an Actions item applies the selected action once and closes the menu.
- For an `in-review` task stranded solely by a failed pre-merge review step, the **Actions** menu also exposes **Bypass failed review** (FN-7720) — a policy-gated escape hatch for the leading real-world cause being the `(no feedback captured)` no-verdict dispatch defect (Runfusion/Fusion#1946). It appears only when the task is `in-review` and has a failed pre-merge review-lane result. Selecting it prompts for a **mandatory reason**; the bypass is fully audit-logged (actor, timestamp, reason, prior status) and never fabricates a reviewer verdict — see "Review-lane bypass (operator escape hatch, FN-7720)" in `docs/workflow-steps.md` for the full semantics, including which merge-blocker conditions still apply after a bypass.
- After delete confirmations are complete, Task Detail closes immediately while the delete request finishes in the background; success and error outcomes still appear as toasts.
- Eligible existing tasks (triage, todo, in-progress, in-review) expose a **GitHub tracking** section directly in Task Detail, even when tracking is currently disabled.
- The GitHub tracking section now defaults to a compact summary row; use the disclosure arrow to expand linked-issue details plus tracking edit controls.
- Tasks linked to GitLab imports show a separate **GitLab tracking** section for GitLab.com and self-managed project issues, group issues, and merge requests. The section provides **Open in GitLab** and local **Unlink GitLab item** actions; lifecycle side effects run in the background and appear as task-log entries such as `Posted GitLab tracking comment`, `Closed linked GitLab source issue`, or `Skipped closing GitLab merge request`.
- GitLab stale state means Fusion is displaying the last persisted GitLab metadata after a sync/import refresh could not confirm a newer state; no GitLab token or secret is stored on the task.
- GitLab comment and close/reopen actions use the configured GitLab REST API base URL for GitLab.com or self-managed instances. Group-imported issues are updated only when Fusion has the concrete project identity plus IID, and merge requests are closed/reopened only for GitLab-supported states; Fusion never auto-merges a GitLab merge request.
- Backstop reconciliation runs every 15 minutes to close tracked GitHub issues for soft-deleted tasks even after restart; the sweep is paginated so large deleted-task backlogs are eventually drained.
- In shared task edit/create forms, GitHub Tracking appears at the bottom of **More options**, after **Workflow Steps**. In task edit mode, **Workflow Steps** appears only when the task's resolved workflow exposes optional steps, so workflows without optional steps do not leave an empty button shell.
- From this section you can explicitly enable/disable tracking and manage a per-task repo override (`owner/repo`). Clearing the override saves `null` and falls back to project/global defaults.
<!-- FNXC:TaskDetailDefinition 2026-09-14-21:00: FN-391 — the Plan/Definition destination now leads with progress, then a bounded description, then the product outcome beside Read plan. -->
- The **Plan** tab is reserved for task steps and the generated `PROMPT.md`. The **Dependencies** tab contains dependencies and blocked downstream tasks; **Artifacts** contains registered artifacts and the attachment gallery; **Details** starts with task provenance, workflow identity, PR context, and timestamps, then contains the Original prompt, retries, source, agent, tracking, no-commits, plus collapsed **Routing** and **Debug** disclosures. Debug contains task-age and spec-alignment diagnostics. Legacy retries, routing, and debug links open Details and expand their matching disclosure. The read-only Original prompt in Details is collapsed by default behind a chevron and renders Markdown when expanded; the generated `PROMPT.md` in Plan still reproduces the request under `## Original Description`. The Plan tab leads with progress (counter and bar always visible, per-step list collapsed behind a chevron to the right of the bar), then the bounded read-only description, then **What this delivers** beside **Read plan**, then the plan's **Before → After** section when it has one. The internal `PROMPT.md` view is read-only — it renders the whole document, preserves the last known plan when a refresh cannot read it, and offers no copy or edit action; **Back to definition** restores the tab strip and summary without requiring the operator to close and reopen the task.
- The **Plan** tab refreshes its generated `PROMPT.md` immediately whenever it is shown or re-shown. While that visible detail is actively planning, replanning, or running Plan Review, it polls for newer prompt revisions; polling stops when the tab or host is hidden, the lifecycle exits those paths, or the task/project changes. An active inline edit keeps its local draft until the operator saves or cancels it.
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
The global AI engine stop/start control and triage pause/resume control live in the executor footer status bar rather than the header. Select the small engine-controls button beside the executor state badge, or select the state text such as **Running**, to open the footer popover. The popover includes **Stop AI engine** / **Start AI engine**, **Pause triage** / **Resume scheduling**, and live scheduler sliders for **Max concurrency** and max worktrees. Max concurrency is the per-project top-level working-agent cap across planning, execution, and review/merge; nested helpers remain parent-internal and can temporarily exceed the displayed count. On mobile, narrow tablets, and tablet landscape, the same controls open as a full-width bottom panel above the executor footer and mobile navigation so the close button and sliders remain reachable. Use the visible **Close engine controls** X button, Escape, or outside-click to dismiss it. The global and current-project concurrency sliders show the shared live top-level agent count and a dot on the slider track for current use. The dot uses the same min-relative range coordinates and thumb-size edge inset as the native slider: it aligns to the cap-clamped running count, so one running agent at the slider minimum stays visible at the start and over-cap usage pins to the cap thumb instead of the expanded track end. Changed concurrency slider values ask for confirmation after the value settles. Confirming saves the global cap through `/api/global-concurrency` and project caps through `/api/settings`; cancel, backdrop dismissal, Escape, close, outside-click, or unmount reverts unconfirmed slider edits without saving. Multiple changed project sliders within one debounce window are summarized in one confirmation dialog, matching Command Center behavior.

<!-- FNXC:ExecutorStatusBar 2026-06-27-00:00: FN-7163 makes footer stats loading initial-only so routine heartbeat refreshes keep the populated footer and open concurrency popover mounted instead of blinking to the loading branch. -->
Brief, single-poll executor stats fetch blips keep showing the last good footer stats instead of flashing **Connecting…**. Routine executor stats heartbeats also keep the populated footer mounted after initial load, so an open engine/concurrency popover stays open while counts refresh. The footer only switches to **Connecting…** for sustained suspension-like stats failures, or to an explicit error state for non-transient failures.

On mobile, the compact footer hides stat names to preserve space. Tap a colored stat dot and count to show its name; tap it again, tap elsewhere, press Escape, or scroll to dismiss the tooltip. Desktop and tablet continue to show stat names inline.

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
- Completed downstream tasks remain visible for debugging context but do **not** count toward the todo threshold.
- The badge tooltip shows active totals and, when escalated, the computed blocking age context.
- `(stale)` markers mean the dependent is blocked through `blockedBy` and matches stale conditions that `clearStaleBlockedBy` self-healing should clear automatically.
- Stale `dependencies[]` links are shown for awareness but are not auto-cleared by `clearStaleBlockedBy`.
- The executor footer summarizes the top escalated blocker (deterministic rank: highest todo fan-out, then highest active total, then oldest age, then stable task ID).

Recommended workflow: ordinary chains stay as `Blocks N` so noise stays low, high-fan-out blockers stand out immediately, and only long-lived high-impact blockers trigger explicit escalation.

### Activity → Raw Logs view

<!-- FNXC:TaskDetailActivity 2026-06-30-23:55: Activity Live is the explicit operational steering-comment entry surface, preserving the legacy internal `current` segment id. Feed and Raw Logs remain read-only Activity segments, the Activity-wide expand control is available on every segment, and the top-level Chat tab is intentionally separate planner-model conversation rather than steering. -->
<!-- FNXC:TaskDetailDefaultTab 2026-09-16-02:53: FN-442 replaced the Chat-first checkbox with Settings → Appearance → Open task details on, a three-value project choice (Definition / Chat / Activity). The chosen tab is both the landing tab of an open with no explicit tab and the tab that leads the tab bar, with the other two of the trio following in canonical order. Activity remains the default, and explicit Activity, Chat, or Logs links are unchanged. -->
<!-- FNXC:TaskDetailActivityMobile 2026-07-03-21:30: On narrow mobile task-detail layouts, Activity view switching uses a fixed root-portaled Activity views menu so iOS viewport resize/scroll echoes during the tap cannot hide Live, Feed, or Raw Logs choices. -->
<!-- FNXC:TaskDetailActivity 2026-07-04-18:37: The Activity views menu remains root-portaled to avoid tab/body clipping, but it is layered above and repositioned with its owning task-detail modal or task popup so drag/resize never leaves the menu behind or detached. -->
<!-- FNXC:TaskDetailActivity 2026-07-04-19:10: FN-7536: the opening tap that shows the Activity views menu can itself trigger a same-gesture window resize/scroll echo (Android/mobile Chrome URL-bar collapse or tap-into-view auto-scroll, distinct from the iOS visualViewport echo above). That echo, and scrolling the `.detail-tabs` horizontal tab strip itself, now only reposition the open menu instead of closing it; a later, real viewport change still closes it as before. -->
The **Activity** tab is the first task-detail tab by default — **Settings → Appearance → Open task details on** can lead with **Definition** or **Chat** instead, which also changes which tab a task opens on — and presents **Live**, **Feed**, and **Raw Logs** in a fixed, root-portaled **Activity views** menu that lists its options vertically, one per line, at every layout width (an extra **Interventions** option appears when planner oversight is active). The dropdown stays above its owning task-detail modal or task popup and follows the Activity tab while a popup is dragged or resized. Live contains the live, chat-styled transcript of task agent output. Consecutive entries are grouped by role and labeled as Planner, Executor, Reviewer, or Merger; legacy log rows without an agent role use the neutral Agent fallback. Each group's model icon also shows the **thinking level** that lane actually used — taken from the run's own "using model" log marker when one exists, otherwise from the configured task/project/global lane precedence — and announces it in the icon's accessible name. When no source provides a level, no badge is shown and nothing is guessed. Agent group headers and user message headers show a small muted relative timestamp (for example, “just now”, “1m ago”, or “2h ago”) based on the transcript timestamp, while agent group metadata still includes the entry count. Consecutive text/message chunks inside a role group render as one continuous markdown bubble, while consecutive tool/tool-result/tool-error rows collapse into one expandable, compact tool-call summary that stays collapsed by default and mirrors regular Chat's dense treatment; the summary stays single-line/ellipsis-friendly on desktop and mobile, counts tool invocations, lists deduped tool names with overflow, and shows an error count when failures are present, while the expanded body pairs each call with its result or error in dense entry cards. Thinking entries render in a collapsible block that starts expanded for `in-progress` and `in-review` tasks so active reasoning is visible at a glance; blocks start collapsed for other task columns and remain user-toggleable in every state. The transcript opens at the latest output whenever the tab loads or becomes active, then follows new live output when you are already near the bottom while preserving your scroll position when you review older messages. When older task-agent history exists, scrolling to the top or selecting **Load previous messages** prepends earlier transcript entries without moving the message you were reading. When you scroll away from the bottom of a populated transcript, a sticky **Latest** button appears inside the transcript so you can jump back to the newest message and resume live follow. For non-`done` tasks, the Activity Live composer sends typed guidance through the same steering path used by comments, including active planning/triage, `in-progress`, and `in-review` sessions, plus live CLI-agent sessions reported by the session bridge; an `in-review` Activity Live message or Comments-tab task comment re-engages an executor unless an open PR blocks moving the task back, and other messages are still saved as queued guidance when no session is currently live. Feed and Raw Logs do not show the composer. On a `done` task, the same composer starts a refinement task using the typed text as feedback and shows a success toast with the new task ID, while the current task detail modal remains on the completed task. The task-detail Activity Live segment keeps the composer pinned and visible on mobile and desktop while the transcript scrolls internally; its textarea placeholder reads “Steer the currently executing agent” for steering mode and switches to refinement copy for completed tasks, with the same inline, icon-only send affordance to the right of the input at every breakpoint. In this task Chat composer, plain **Enter** follows the global `chatSubmitOnEnter` preference. **Shift+Enter** does not send, including with Cmd/Ctrl held, and passes through the snippets menu to insert a newline after any IME composition has completed. **Cmd/Ctrl+Enter without Shift** sends independently of that preference and pointer type only after the task Chat IME guard and while no snippets menu is open; an open menu consumes both Enter and Cmd/Ctrl+Enter until Escape closes it. The Send button remains active whenever the draft is not empty.

The top-level **Chat** tab opens a task-aware Chat conversation for the same task instead of posting steering comments. It targets the project Direct Chat default model and thinking level through one Brain popover with model-only targeting; it retains the synthetic `task-planner:<taskId>` session so server-built task context and scoped tools remain intact. It appears after Activity by default, or first when **Settings → Appearance → Open task details on** is set to **Chat**. Each send includes server-built, bounded context for the task id, status/column/progress/current step, dependencies, recent activity/comment excerpts, prompt/plan content, and available source/review state; unavailable sections are labeled so the planner states uncertainty rather than inventing execution evidence. Opening the tab with no existing history does not create a database chat row; when no task-Chat history is found, Chat shows a guided empty state with starter prompts for recent activity, current status/blockers, next best action, and plan/definition review. Selecting a starter creates/resumes the task Chat session and sends that prompt as an ordinary chat message through the task-context-aware task-Chat composer/stream path, including for completed tasks. On live tasks, clear bounded implementation-change requests are routed to task steering; on `done` tasks, clear follow-up implementation or improvement requests are routed through a task-scoped planner refinement tool that calls the same refinement creation path as the completed-task Activity composer. The starter prompts disappear while history is loading or after conversation history exists, so Activity Live, Feed, Raw Logs, and the steering/refinement composer remain separate. Task Chat uses the same standard chat bubble, markdown/plain assistant rendering, thinking details, tool-call/question cards, and mobile first-tap send/stop affordance as the main Chat view while keeping task-scoped planner sessions separate. Planner Chat defaults to focused mode, keeps its composer visible at the bottom while only the transcript scrolls, and on narrow/mobile task-detail layouts collapses nonessential rows above the chat until the user selects the Chat collapse control.

The **Feed** is the task's activity journal. It refreshes when it becomes visible, whenever the task changes while you are viewing it, and after its event stream reconnects. It does not poll while hidden; opening or returning to Feed performs the authoritative refresh, so it remains current without background traffic.

The **Raw Logs** segment is designed for debugging long-running and tool-heavy sessions, while legacy links that requested the former top-level Logs tab land on Activity → Feed:

- Full `thinking`, `tool_result`, and `tool_error` payloads are shown without entry-content truncation.
- Raw tool output is rendered as multiline blocks, preserving line breaks and indentation.
- The Feed and Raw Logs segments show loading indicators while their first async history/detail request is pending, so empty states only appear after the relevant fetch completes.
- The initial load fetches a recent page, then **Load More** progressively prepends older history.
- Live streaming appends new entries in chronological order while preserving your scroll position when loading older pages.
- The **Markdown / Plain** toggle lets you switch between formatted markdown and literal/raw text rendering.
- The **Tools: On/Off** toggle shows or hides tool-call rows (`tool`, `tool_result`, `tool_error`) so you can focus on narrative/thinking output when needed.
- Both display preferences persist across sessions via local storage (`fn-agent-log-markdown` and `fn-agent-log-tool-output`).

The collapsed **Routing** disclosure in **Details** shows:
- effective node
- routing source (task override vs project default vs local)
- unavailable-node policy value
- per-task node override controls (locked while task is active)

Project-wide routing defaults are configured in **Settings → Node Routing**. Legacy Routing links open Details with this disclosure expanded.

![Task detail modal](./screenshots/task-detail.png)

## Node Dashboard

The Node Dashboard provides a mesh view of connected Fusion nodes. Each node can be a local instance or a remote headless node (`fn serve`).

Navigation:
- Desktop: Header node controls / overflow entry
- Mobile: `MobileNavBar` → **More** sheet → **Nodes** (shown only when `experimentalFeatures.nodesView` is enabled)

![Nodes view](./screenshots/nodes-view.png)

Nodes follows the shared destination layout: registered nodes are listed in the standard left rail, and selecting one shows its card in the detail pane. Node registration lives only in the header (**Add Node** / **Add Docker Node**), including when no node is registered yet, so an empty collection no longer offers a second call to action. On phones the rail is the first screen and the chevron before the title returns to it.

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
- Provider options such as Tailscale **Accept routes** and **Remember last running state** auto-save after an edit; starting a tunnel is not required for these settings to persist.

### Settings auto-save

Settings form edits auto-save after a short debounce. The Settings footer has no Save button and never shows an unsaved-changes leave warning. Closing Settings, including with Close, Escape, or the backdrop, flushes a pending edit before dismissal so the final change is retained.
- Activate the current provider
- Start/stop tunnel lifecycle manually
- Generate login URLs / QR payloads using persistent or short-lived token mode

For setup prerequisites, security caveats for tokenized URLs/QR links, and troubleshooting, use the canonical **[Remote Access runbook](./remote-access.md)**.

## Skills & Snippets

<!-- FNXC:ChatSnippets 2026-09-03-16:32: Operators manage global reusable prompts beside execution skills, then explicitly insert rather than dispatch them from all three dashboard chat composers. -->
<!-- FNXC:SkillsSnippetsLayout 2026-09-04-00:42: Skills and snippets need separate tabs with active-domain counts and refresh behavior so each workflow stays clear and reachable without changing its underlying data contract. -->

The **Skills & Snippets** view separates execution skills and global **Chat Snippets** into dedicated **Skills** and **Snippets** tabs. Each tab shows its own count, and the header **Refresh** action reloads whichever domain is active. In the **Snippets** tab, add a unique name and prompt, edit either field, or delete an entry; validation reserves built-in slash names (`clear`, `new`, `steer`, `focus`, and `skill`), accepts 1–48 letters, numbers, underscores, or hyphens, limits prompts to 4,000 characters, and caps the list at 50 entries. The authoritative `chatSnippets` array is stored in global settings through `GET/PUT /api/settings/global`, so the same ordered list is available across projects. The dashboard keeps this cache in memory only and serializes overlapping create, update, and delete actions so a stale response cannot overwrite a newer change.

Type `/name` in **Chat**, task **Planning Chat**, or task **Activity Chat** to choose the matching snippet with the pointer or keyboard. Selecting it—or submitting a standalone `/name`—only inserts the saved prompt into the composer at the cursor and returns focus; it never sends, streams, creates a refinement, posts steering, or queues a planner follow-up until you explicitly submit the inserted text. In Chat, existing attachments remain selected and inserted snippet text is not copied into the saved-draft `localStorage` entry. Built-in commands keep priority over snippets, skills remain available after snippets in Chat autocomplete, and unknown, partial, mid-text, or suffixed forms continue through their existing behavior.

### Skills API

The Skills & Snippets view supports the full browse-and-install loop for skills.sh entries: use **Skills Catalog** to search the catalog, click **Install** on any card with a source repository, and the dashboard will run the same installer as the CLI (`npx skills add <owner/repo> -y -a pi`, with `--skill <slug>` when applicable). On success, the view refreshes **Discovered Skills** and the catalog immediately; entries already installed for the selected project show **Installed** rather than an install button.

Discovery is scoped to the requested project root. It merges `<root>/.fusion/skills`, `<root>/.pi/skills`, `<root>/.agents/skills` and its repository ancestors, user/global agent sources, and project-enabled plugin skills. For duplicate project-local skills, Fusion-owned `.fusion/skills` takes precedence over `.pi/skills`, which takes precedence over project `.agents/skills`; plugin skills remain a final bare-name deduplicated merge. Catalog `installation.installed` is computed from this same project inventory.

The Skills API provides endpoints for managing execution skills. Skills are toggled via project-scoped settings in `.fusion/settings.json`. Toggle entries match the skill body’s relative path beneath `skills/` (for example, `api/api-versioning/SKILL.md`), not just its displayed name. Stale flat-layout entries such as `-api-versioning/SKILL.md` are ignored for skills that now use a categorized body path, keeping the Skills view and agent-session manifest aligned.

### Agent skill configuration

Agent cards show **Skills: None** when no forced skills are stored. The agent editor provides a filterable checkbox list: enabled entries are **Auto-available** to every agent, while checked entries are **Forced** so that agent reads them before work starts. Disabled and no-longer-discovered stored skills remain visible and are labeled **Disabled** or **Not discovered** on both the editor and agent badges. See [Agents](agents.md) for the execution semantics.

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
- Auto-discovered project skills, including Fusion-owned `.fusion/skills`, use `source: "auto"`
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

### Official neutral design boundary

Fusion’s former homemade Alpha system is now the unconditional official design inside Board, Chat, and Task Detail boundaries. The removed `experimentalFeatures.alphaUpdates` setting is tolerated only as inert historical data. This includes the kept-alive Board and main Chat, the managed Chat modal or drawer, popped-out and docked Chat, task and planning Chat, and every shared Task Detail host; List, navigation, Settings, and plugin-owned content remain on the stable presentation.

Within those boundaries, the official design has exactly two canonical neutral palettes: light and dark. The resolved document `data-theme` selects the palette, including when the global preference is `system`; `data-color-theme`, custom shadcn colors, and other Fusion theme accents, radii, or shadows never alter an Alpha surface. Body-portaled menus, popovers, and dialogs receive the same palette as their originating surface. Semantic error and warning states remain visible through the fixed light/dark Alpha tokens rather than a Fusion color theme.

Use the shared `alpha-ui` primitives instead of introducing a component dependency. They render native HTML controls with browser form behavior and Fusion-owned keyboard, focus, overlay, and dismissal handling. Board and Chat use quiet secondary actions, restrained borders/elevation, and a clear input-first hierarchy; Quick Entry keeps Save prominent but compact and places advanced options behind its disclosure. Shared adaptive primitives retain the appropriate host presentation in List, Mailbox, Settings, and plugin-owned content.

The dashboard's CSS is split into a global stylesheet (`packages/dashboard/app/styles.css`) and per-component files (`packages/dashboard/app/components/ComponentName.css`). Each `ComponentName.tsx` imports its stylesheet at the top.

**Rule:** New CSS for a component goes in `app/components/ComponentName.css`, NOT `styles.css`. Only design tokens, primitives (`.btn`, `.card`, `.modal`, `.form-input`), and cross-component `@media` overrides belong in the global file.

### Shared search field primitive

Outside the header, a search box is ONE field: the magnifier is drawn INSIDE the bordered field and the
only prompt text is the input's `placeholder`, never a sibling text node. `packages/dashboard/app/styles.css`
owns the shared primitive — `.search-field` (container), `.search-field-icon`, `.search-field-input` — which
extracts the header search's visual contract (background, tokenized border, radius, gap, border-color
transition, `:focus-within` highlight, `--text-dim` placeholder) plus a phone-sized touch height at
`max-width: 768px`. Unlike the header, these hosts (Notes, Whiteboard) show the field PERMANENTLY, with no
magnifier trigger to click first.

A host stylesheet keeps only its ROW geometry (padding, separator) and stretches the field with
`.<host>-search .search-field { flex: 1 }`. Do not redeclare border, background, or icon size there; that
duplication is exactly what pushed the icon and label outside the field. `.header-search*` in `Header.css`
remains header-owned and is deliberately not migrated to this primitive.

**The canonical screen-reader-only utility is `.visually-hidden`, defined in `styles.css`.** The class
`sr-only` has never been defined in any dashboard stylesheet, so any element using it renders its content
VISIBLY. `packages/dashboard/app/__tests__/search-field-and-hidden-label.css.test.ts` censuses component
sources and fails if `sr-only` reappears.

### Tab strips are never selectable

A tab row is a drag-to-scroll surface, so its labels must never be selectable: the browser starts a native
selection (blue highlight plus selection-autoscroll) before the shared horizontal-pan hook crosses its 4px
intent threshold, which is exactly the involuntary second scroll system the Board already removed. One
global primitive in `packages/dashboard/app/styles.css` suppresses selection on `[role="tablist"]` and its
descendants, and on the named inventory of tab rows that carry no role; a more specific carve-out keeps
`input`, `textarea`, `select`, and `[contenteditable="true"]` inside a strip natively selectable. The
suppression is unconditional — it does not depend on a panning state, a breakpoint, or which host renders
the strip.

**A new tab strip must either carry `role="tablist"` or be added to that selector list.** Do not copy the
rule into a component stylesheet. `packages/dashboard/app/__tests__/tab-strip-text-selection.test.ts`
censuses every tab-strip class rendered by a component and fails on an uncovered one.

### Universal view chrome

Every dashboard destination composes the same primitives — `ViewLayout`, `ViewHeader`, `ViewSidebar`, and
`ViewActionButton` — and the chrome they draw is declared **once, in those primitives**. Do not copy a divider,
a header height, or an action size into a view stylesheet.

- **The separation under a title belongs to `ViewHeader`.** `.view-header` draws one
  `var(--btn-border-width) solid var(--border)` bottom border, so Missions, Agents, Goals, Snippets, Mailbox, and
  Planning all read as header-over-content. Planning used to be the only view with that bar because it drew it
  locally; that local rule is gone. The reserved 1px in `--view-header-min-height` is exactly this border, so the
  canonical ~61px header height is unchanged. Do not re-add a per-view `border-bottom`, and do not reach for
  `--chrome-divider-color`, which repaints the right dock and the app shell too.
- **Action geometry is canonical.** Desktop header actions are bounded to `--view-header-content-row` (28px) and a
  non-`btn-sm` button has its block padding trimmed centrally so its content fits without clipping; phones keep the
  36px icon-only geometry from `ViewActionButton`. A view should not restate either size.
- **Collection-scoped navigation belongs to the rail, not the destination header.** `ViewSidebar` accepts an optional
  `header` slot rendered as a fixed band above the list, with the list scrolling underneath it. When the prop is
  absent no wrapper is rendered at all. Mailbox's Inbox/Outbox tabs use this slot; the destination title, Compose,
  filters, and mark-as-read stay in `ViewHeader`, which spans both panes.
- **A destination has no window chrome.** A view reachable from navigation renders no close cross and no manual
  refresh button — it stays current on its own. A genuine floating window keeps its close, an error state keeps its
  Retry, and a list-to-detail `backAction` is navigation, not dismissal.

`packages/dashboard/app/components/__tests__/universal-view-chrome.test.tsx` asserts the rendered structure and the
applicable CSS rules, and the `view-layout-*` families exercise the real hosts.

### Mobile drawer conformance

A surface presented as a phone drawer exposes **exactly one drag handle and no close cross**. The handle is always the
shared `ViewDrawerHandle` primitive (`packages/dashboard/app/components/ViewDrawer.tsx`); never paint a grab bar with a
local `::before`/`::after` rule, because the drawer shell already renders one and a second bar simply stacks on top of
it. Dismissal is the downward drag, the backdrop, or Escape; the detail return (`backAction`) is navigation, not
dismissal chrome, and always survives.

The presentation itself has a single definition. `resolveDrawerPresentation({ viewportMode, excluded })` is the only
place that spells out the rule (phone viewport, the `data-mobile-drawers` opt-in published on `<html>`, no host-local
exclusion). `FloatingWindow` and `MobileDrawer` publish the resolved value on context, so hosted content reads it with
`useDrawerPresentation()` — or wraps chrome it wants suppressed in `HideInDrawer`, which is the correct read for a host
that renders its own `FloatingWindow` and therefore sits above the provider. `ViewHeader` applies the rule centrally:
a close passed through its `onClose` prop disappears in drawer presentation, and its actions row is dropped entirely
when that close was its only child. The context defaults to `false`, so desktop, tablet, phones without
`data-mobile-drawers`, and excluded windows (setup wizard, onboarding, confirmations) are unaffected.

Both halves are ratcheted by `packages/dashboard/app/components/__tests__/drawer-conformance-inventory.test.tsx`: a new
bespoke handle in a phone media block or an unguarded close control fails the suite. Desktop and tablet **resize** grips
are explicitly exempt — they are pointer-resize affordances, not drawer handles.

#### Titres de vue et bouton Retour

<!-- FNXC:ViewBackIconParity 2026-09-17-03:18: FN-486 keeps Planning and Missions top titles on the view name and gives the back chevron the create button's mobile geometry. -->
Le titre du haut d’une destination reste **le nom de la vue**. Ouvrir une session de planification ou une mission ne remplace pas ce titre par le nom de l’élément : ce nom est déjà présenté juste en dessous, dans le contenu. Planning affiche donc toujours **Planning Mode** et Missions toujours **Missions**, en liste comme en détail, pendant un entretien, un chargement ou une erreur.

Sur téléphone, le bouton **Retour** et le bouton de création « + » ont exactement la même géométrie : même carré canonique, même taille de pictogramme, aucun padding résiduel, et aucune compression possible par un titre long. Cette parité appartient aux primitifs partagés `ViewBackButton` et `ViewActionButton` ; aucune vue ne redeclare la géométrie de son retour.

#### Dismissing from a list row

Une **ligne de liste** est un point de départ légitime du geste de fermeture, même lorsqu’elle est un vrai bouton
accessible. Une ligne se qualifie en portant `data-drawer-dismiss-row` (fourni par le contrat partagé
`packages/dashboard/app/utils/listItemGesture.ts`) ; le geste n’est accepté que si le contrôle interactif le plus
proche de la cible touchée est cette ligne. Un champ de renommage, un lien, un bouton imbriqué, un slider ou une
surface de terminal placés sous la ligne restent donc natifs, et les conditions existantes ne changent pas : tous les
conteneurs défilants entre la cible et le panneau doivent être au bord haut au moment du `pointerdown`.

Trois gestes coexistent sans ambiguïté sur une ligne : le défilement reste natif, un glissement descendant depuis le
haut ferme le tiroir, et un appui long immobile ouvre le menu contextuel de la ligne. Le premier des deux derniers qui
aboutit annule l’autre : un mouvement au-delà du seuil annule l’appui long, et l’ouverture d’un menu invalide
immédiatement le candidat de fermeture. Aucun `preventDefault` n’est émis au démarrage du geste, donc le défilement
natif n’est jamais confisqué.

### Banners

Use the shared `Banner` component for dashboard notices. Its `tone` selects semantic info, warning, error, success, or neutral tinting; `layout` selects inline cards or sticky chrome; and `density` selects compact or regular spacing. Banners use a tinted surface and `var(--btn-border-width)` hairline border, never a left accent bar. Declaration values use design tokens: raw px is allowed only in `@media` conditions, zero values, and `var()` fallbacks.

### Dialog anatomy: spacing and stacking

Two rules that a new dialog gets wrong the same way every time. Both were paid for by the Set Up AI
paste-back login dialog (2026-08-18): it shipped with insets that matched nothing else in the app,
and it sank behind the modal that opened it.

**Spacing comes from the primitives, not from your component.** A dialog panel is
`<div class="modal your-dialog">` with a `.modal-header` and a `.modal-actions` row; both already
carry `var(--modal-padding)`. Give the middle region ONE inset from the same token and let its
children sit flush inside it. Do not hand-roll header/action padding for a new dialog, and do not
pad each child (steps, form, error line) separately — that is exactly how the login dialog's rows
drifted out of alignment with each other and with every other dialog. Variant-specific overrides of
the primitives (embedded, tablet, phone sheet) are legitimate and several exist; a brand-new dialog
inventing its own base spacing is not.

**A portaled dialog must be a sibling of any FloatingWindow it opens over, and must stop pointer
propagation.** `createPortal` moves the DOM node to `<body>` but NOT the React tree, so events raised
inside the dialog still bubble to whatever component rendered it. Every FloatingWindow raises itself
to a fresh `nextFloatingZ()` on pointerdown/focus, so a dialog portaled from inside a window's
subtree lifts that window above itself on the first click — after which every click lands on the
window behind. Render such a dialog outside the `<FloatingWindow>` element (a sibling in the same
fragment), claim `nextFloatingZ()` once on open like `ConfirmDialog` does, and `stopPropagation()`
on the overlay's pointer/mouse/focus handlers. The last part is enforced for every portaled
`.modal-overlay` by a ratchet in `packages/dashboard/app/components/__tests__/FloatingWindow.test.tsx`.

### Browser-safe core imports

Dashboard browser code may value-import only browser-safe `@fusion/core` leaf modules. Vite aliases the package root to `packages/core/src/types.ts`; do not bypass that boundary with a relative `core/src` import unless the leaf is listed in [`scripts/lib/dashboard-browser-safe-core-modules.json`](../scripts/lib/dashboard-browser-safe-core-modules.json). In particular, use `near-duplicate-canonical.ts`, not `near-duplicate.ts`, because the latter reaches Node-only duplicate detection dependencies.

The `check-no-node-only-core-imports-in-dashboard.mjs` guard runs before tests and in the gate. Before adding a browser-safe leaf, review its complete transitive dependency graph for Node builtins, database/store modules, filesystem, and child-process imports, then add a dated reason to the allowlist. Type-only imports remain allowed because they are erased from the browser bundle.

### Native structure previews

`NativeStructurePreview` is the shared compact card for mission, milestone, roadmap item, research-finding, eval-result, and goal references. It resolves `GET /api/native-structures/:kind/:id/preview` to a typed available or unavailable payload and uses a required consumer-supplied `onOpen(ref, payload)` callback. Chat is a consumer: it parses strict `fusion://<kind>/<id>` tokens/assistant Markdown links and dispatches the callback into its owning dashboard view. `openTarget` is a view-state descriptor, not a URL, because dashboard navigation is callback based. A `roadmap-item` reads a roadmap feature through the roadmap plugin's PostgreSQL-safe adapter, is unavailable only when missing or that read layer is unavailable, and opens the hosted `roadmaps` destination from both chat and mail. The Roadmaps destination is manifest-advertised, exposed through the plugin dashboard-view export, bundled-registered, and available in desktop and mobile plugin navigation when the roadmap plugin is enabled.

PR tab note: `PrPanel` cards use tokenized `.pr-card` grid spacing (`padding` + `gap`) and boxed token-based hint callouts for empty/loading states. Manual PR merges now show in-progress feedback (`Merging…` button state + status hint) until the merge call resolves.

The `index.html` shell is templated server-side: the server injects a per-user `<link rel="modulepreload">` for the last-used `taskView` chunk, sourced from Vite's `dist/client/.vite/manifest.json` and `kb:<projectId>:kb-dashboard-task-view` in localStorage.

### Appearance is two independent axes: colour theme and interface style

Since FN-399 the dashboard's appearance is governed by **two independent preferences**, both global and both
chosen in **Settings → Appearance** and in the **Command Center** theme card:

| Axis | Attribute | Preference | Owns |
| --- | --- | --- | --- |
| Colour theme | `html[data-color-theme]` | `colorTheme` (+ `themeMode`, `shadcnCustomColors`) | Which colours are used: palette, semantic hues, custom overrides, and a preset's font *family* identity |
| Interface style | `html[data-ui-style]` | `uiStyle` | Non-chromatic grammar: density, radii, border widths, type scale/weight/leading, control and touch heights, icon sizes, hover intensity, motion, shadow and focus-ring **geometry** |

The two never move together. Choosing **Épuré** does not change a single colour; choosing a new palette does
not change a single dimension. The font-size preference keeps multiplying the whole style grammar because
every style value is expressed in `rem`/`em`.

Values are `classic` (**Actuel**, the default and the fallback for any unknown persisted value) and `clean`
(**Épuré**). Both are published before React by the pre-hydration bootstrap in `app/index.html`,
`getThemeInitScript()`, and the Electron renderer shell, so a saved `clean` paints on the first frame.
See [`docs/settings-reference.md`](settings-reference.md#uistyle) for scope, persistence and reset behaviour.

#### The interface-style catalogue

`app/ui-style-tokens.css` is the single catalogue for the second axis. Every token is declared once per
style: `classic` on `:root` (so an absent attribute behaves exactly like the default) and `clean` under
the `html[data-ui-style="clean"]` selector, which overrides only the names whose value actually differs.

| Catalogue family | Tokens | Role | Classic | Clean |
| --- | --- | --- | --- | --- |
| Density | `--ui-density-3xs` … `--ui-density-2xl` | Rhythm rungs a component pads and gaps with | `0.125`–`2rem` | tighter (`0.125`–`1.75rem`) |
| Radii | `--ui-radius-xs/sm/md/lg/xl/pill` | Corner softness | `0.25`–`1rem` | softer small rungs, tighter `lg` |
| Borders | `--ui-border-width`, `--ui-border-width-strong` | Outline weight | `0.0625rem` / `0.125rem` | hairline for both |
| Typography | `--ui-font-family`, `--ui-font-family-mono`, `--ui-font-size-2xs…lg`, `--ui-font-weight-*`, `--ui-line-height-*`, `--ui-letter-spacing-*` | Scale, weight, leading, tracking. The **family is read from the colour preset**, so a theme keeps its typographic identity | base `0.875rem` | smaller headings, roomier leading, wider tracking for discreet headings |
| Controls | `--ui-control-height-sm/…/lg`, `--ui-touch-height`, `--ui-icon-size-sm/…/lg` | Control box and glyph sizing | `2rem` control, `1rem` glyph | `1.875rem` control, `0.9375rem` glyph (the 15–16px equivalent of the reference grammar) |
| State | `--ui-hover-mix`, `--ui-hover-mix-strong`, `--ui-active-mix`, `--ui-disabled-opacity`, `--ui-muted-opacity` | Hover/active intensity as `color-mix` percentages — never a colour | `8/14/18%` | quieter `6/10/14%` |
| Motion | `--ui-duration-instant/fast/normal/slow`, `--ui-easing` | Transition timing | `0.1`–`0.3s` | `0.08`–`0.25s` |
| Elevation geometry | `--ui-shadow-*-geometry`, `--ui-focus-ring-geometry`, `--ui-shadow-opacity*` | Offset/blur/spread only; the colour half stays with the theme | standard | shallower |

Invariants, all asserted by `app/__tests__/ui-style-contract.test.ts`:

* **No colour in the catalogue.** A style never decides which colour is used.
* **No new `px`.** Values are `rem`/`em`/unitless/seconds, so the font-scale preference keeps scaling them.
* **The touch floor is style-independent.** `--ui-touch-height` stays `2.75rem` (44px at the default root
  size) in both styles: a denser grammar may never shrink a real tap target.
* **Classic metrics are untouched.** The bindings that map shared tokens (`--radius-*`, `--btn-padding`,
  `--transition-*`, `--icon-size-*`…) onto the catalogue are scoped to the clean style only, so upgrading
  changes no classic pixel.

#### Colour presets no longer impose shape (intentional difference)

Before FN-399, several colour presets also shipped geometry: their own `--space-*` and `--radius-*` ramps,
`--btn-padding`, `--btn-border-width`, `--card-padding`, motion durations, and descendant rules setting
`font-size`, `font-weight`, `letter-spacing`, `text-transform`, `border-radius` or `border-width`. Cozy
Cartoon additionally enlarged button typography and icon size from `styles.css`.

All of that is **removed**: a preset now declares colour (and its font family identity) only, and shadow /
focus-ring declarations keep the preset's colour while taking their geometry from the catalogue. This is a
deliberate, user-visible difference — presets such as Factory, Brutalist, Terminal and Cozy Cartoon no
longer change dimensions, weights or letter-spacing. In exchange, the two axes compose: any palette can be
worn by either grammar. `app/__tests__/ui-style-contract.test.ts` fails if a preset reintroduces shape.

A second intentional difference: Board, Chat, Task Detail and their body-portaled overlays used to be
pinned to a fixed neutral palette by the old `alpha-ui.css` boundary scope, so a theme change could not
recolour them. That scope is gone, so **themes now really apply** to those surfaces in both styles.

#### Extending the grammar to another view

A view adopts the axis without inventing a local table: consume `--ui-*` directly (or a shared token that
is already bound under the clean style), and use the native primitives in `app/components/ui` for
controls, collections, portals and dialogs. Do not add a per-component style branch in JavaScript and do
not declare a second per-style value table in component CSS — if a rung is missing, add it to the
catalogue once so every view inherits it.

### Design tokens

`styles.css` is the source of truth for tokens (`--space-*`, `--radius-*`, `--shadow-*`, `--duration-*`, `--transition-*`, `--font-*`, `--header-height`, `--mobile-nav-height`, `--standalone-bottom-gap`, `--overlay-padding-top`) and color variables (`--bg`, `--surface`, `--card`, `--text`, `--text-muted`, status colors `--triage`/`--todo`/`--in-progress`/`--in-review`/`--done`, semantic `--color-success`/`--color-error`/`--color-warning`/`--color-info`, status backgrounds `--status-*-bg`).

Typography uses the shared `--font-weight-regular` (400), `--font-weight-medium` (500), `--font-weight-semibold` (600), and `--font-weight-bold` (700) scale. `--border` is a colour token, never a width: the only border-width token is `--btn-border-width`, so border shorthands must begin with `var(--btn-border-width)` unless an intentional thick accent uses a `--space-*` rung.

**Always reference tokens. Never hardcode pixels, hex, or `rgba()` in component CSS** — global/theme token CSS is also covered by `global-theme-css-no-raw-rgba.test.ts`, so raw `rgba()` belongs only in explicit `var(--token, rgba(...))` fallbacks. For translucent backgrounds use `color-mix(in srgb, var(--color) X%, transparent)`, not `rgba()`.

Command Center chart surfaces are a stricter token-only zone: `CommandCenter.css`, `areas/areas.css`, and `charts/charts.css` should avoid raw color fallbacks and hardcoded dimensions in component rules, keep secondary copy on `--text-muted`, use canonical `--accent` / `--text` for generic accent and primary text styling, use `--duration-*` for animation durations, and encode mobile chart invariants with shared classes rather than one-off area styles. Hand-rolled chart primitives cycle through the existing semantic palette (`--accent`, workflow status tokens, and success/warning/error tokens) rather than adding one-off chart color aliases. The undefined `--color-accent` / `--text-primary` aliases are forbidden under `components/command-center/**` and guarded by `command-center-css-token-canonicalization.test.ts`.

Non-Command-Center dashboard CSS uses `--text` as the canonical primary text token. The undefined `--text-primary` alias is forbidden outside `components/command-center/**` and guarded by `packages/dashboard/app/__tests__/text-token-canonicalization.test.ts`.

### Stable theme token contract (integrators & plugins)

The following curated tokens are the supported dashboard theming contract for integrations and plugin-rendered UI. Each token is defined by `styles.css`; use these names rather than depending on internal or theme-data-only variables.

<!-- fusion-theme-token-contract:start -->
| Token | Stable meaning |
|---|---|
| `--space-xs` | Extra-small spacing step |
| `--space-sm` | Small spacing step |
| `--space-md` | Medium spacing step |
| `--space-lg` | Large spacing step |
| `--space-xl` | Extra-large spacing step |
| `--space-2xl` | Largest shared spacing step |
| `--radius-sm` | Small corner radius |
| `--radius-md` | Medium corner radius |
| `--radius-lg` | Large corner radius |
| `--radius-xl` | Extra-large corner radius |
| `--radius-pill` | Pill-shaped corner radius |
| `--font-primary` | Dashboard UI font stack |
| `--font-mono` | Dashboard monospace font stack |
| `--font-weight-regular` | Regular text weight (400) |
| `--font-weight-medium` | Medium emphasis weight (500) |
| `--font-weight-semibold` | Semibold emphasis weight (600) |
| `--font-weight-bold` | Bold text weight (700) |
| `--font-size-xs` | Caption and help text size |
| `--font-size-base` | Default body text size |
| `--shadow-sm` | Subtle elevation shadow |
| `--shadow-md` | Standard elevation shadow |
| `--shadow-lg` | High elevation shadow |
| `--focus-ring` | Subtle focus indicator shadow |
| `--focus-ring-strong` | Emphasized focus indicator shadow |
| `--duration-instant` | Instant motion duration |
| `--duration-fast` | Fast motion duration |
| `--duration-normal` | Standard motion duration |
| `--duration-slow` | Slow motion duration |
| `--transition-instant` | Instant duration and easing shorthand |
| `--transition-fast` | Fast duration and easing shorthand |
| `--transition-normal` | Standard duration and easing shorthand |
| `--transition-slow` | Slow duration and easing shorthand |
| `--bg` | Primary application background |
| `--surface` | Primary raised surface |
| `--card` | Card surface |
| `--card-hover` | Hovered card surface |
| `--surface-hover` | Neutral hovered surface |
| `--bg-secondary` | Secondary application background |
| `--bg-tertiary` | Tertiary application background |
| `--border` | Default border color |
| `--btn-border-width` | Theme-aware standard border width |
| `--border-subtle` | Low-contrast border color |
| `--border-strong` | High-contrast border color |
| `--text` | Primary text color |
| `--text-muted` | Secondary text color |
| `--text-dim` | De-emphasized text color |
| `--triage` | Triage workflow status color |
| `--todo` | To-do workflow status color |
| `--in-progress` | In-progress workflow status color |
| `--in-review` | In-review workflow status color |
| `--done` | Done workflow status color |
| `--color-success` | Semantic success color |
| `--color-error` | Semantic error color |
| `--color-warning` | Semantic warning color |
| `--color-info` | Semantic informational color |
| `--color-muted` | Semantic muted color |
| `--fusion-max-z` | Live dashboard floating-layer ceiling |
<!-- fusion-theme-token-contract:end -->

Color tokens resolve to raw color strings (e.g. `#161b22`), not shadcn-style HSL triples, so a token can be used directly as a `color`, `background`, or `border` value without wrapping it in `hsl(...)`.

#### Overlay layering contract

`--fusion-max-z` is always at least as high as the dashboard-managed floating layers covered by this contract: the page overlay/popover band at 10000–10001, the session-monotonic floating-utility stack starting at 10100, the reserved toast/feedback ceiling at 10500, and the body-portaled model-combobox dropdown at 11000. Its CSS boot value is 11001, one above the tallest static layer. `floatingWindowStack.ts` raises the inline value on `document.documentElement` whenever the utility stack grows beyond that floor, and CSS `var()` references re-resolve automatically. The separate task-detail popup band starting at 220 is intentionally not a source for updates because it remains below the utility band.

For the simplest integration, append overlay content to `#plugin-overlay-root`. This fixed, viewport-sized mount point uses `z-index: calc(var(--fusion-max-z) + 1)` and is click-through by default; interactive children must set `pointer-events: auto`. A plugin that owns another root stacking context can apply the same z-index expression directly.

A static mount-point z-index would eventually be overtaken by the unbounded, session-monotonic utility counter. The live custom property is therefore the layering primitive; the mount point is an inert convenience consumer. When empty, it does not alter layout, scrolling, or pointer behavior.

**Dominant transient surfaces.** A small set of short-lived shell surfaces must stay in front of every dashboard-managed window while they are open — including a window opened *after* them — because they are opened from chrome that remains reachable at all times: the header-anchored **Usage** popover, and the footer **More** menu on desktop, tablet, and phone. They therefore derive their layer from the same live ceiling rather than a static value: the transparent backdrop uses `calc(var(--fusion-max-z) + 2)` and the panel uses `calc(var(--fusion-max-z) + 3)`. One step above them, `calc(var(--fusion-max-z) + 4)` is reserved for the global window-visibility control in the bottom-right corner: the button that hides and restores every dashboard-managed window never disappears behind the **More** menu or any other transient panel, and stays clickable while one is open. The Usage popover is portaled to `document.body` so it is compared in the root stacking context, and the desktop/tablet footer carries its elevation on the bar itself (the bar owns a `--z-sticky` stacking context its absolutely positioned menu could never escape); the footer returns to its resting layer as soon as the menu closes.

Tokens in the table are stable. Renaming or removing one requires a deprecation note and a changeset; `theme-token-contract-docs.test.ts` guards that every documented token still has a CSS definition.

### Theme system

<!-- FNXC:DashboardTheming 2026-06-21-00:00: FN-6840 synced the user-facing theme docs to the shipped expanded Shadcn family, the Shadcn Custom color-picker preset, and the sidebar accent behavior that follows each theme's --accent token. -->
<!-- FNXC:DashboardTheming 2026-07-01-00:00: Glass Silver is the silver/gray frosted sibling of Glass and is selectable anywhere color themes are listed, so keep the inventory count and theme description in this guide aligned with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-07-03-00:00: Fresh installs and reset-to-default use System mode so the dashboard follows the OS light/dark preference before and after hydration while keeping Shadcn Ember as the default color theme. -->
<!-- FNXC:DashboardTheming 2026-07-16-00:00: FN-8151 adds Cobalt, Clay, and Moss; keep this inventory synchronized with the core COLOR_THEMES union and selector surfaces. -->
<!-- FNXC:DashboardTheming 2026-07-16-14:30: FN-8146 restores historical Shadcn Mono as a persistent selector and makes the Settings current-theme row its single all-themes dropdown trigger while Command Center stays compact. -->
<!-- FNXC:DashboardTheming 2026-07-20-00:00: Aurora is a built-in persisted palette with navy/teal/violet dark surfaces and a misty light counterpart; keep this inventory and its count synchronized with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-07-20-00:00: Calm is a built-in persisted palette with slate/sage dark surfaces and a misty blue-white light counterpart; keep this inventory and its count synchronized with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-07-20-00:00: Dawn is a built-in persisted palette with indigo/amber dark surfaces and a dawn-white light counterpart; keep this inventory and its count synchronized with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-07-31-20:39: Factory Dark is a built-in persisted graphite/steel palette with safety-orange accents and a concrete-gray light counterpart; keep this inventory and its count synchronized with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-07-31-23:58: Factory Light is a built-in persisted daylight industrial palette with bright concrete/warm-white surfaces, steel-gray borders, a darkened safety-orange accent, and a warm-graphite dark counterpart; keep this inventory and its count synchronized with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-07-31-21:28: Sage is a built-in persisted muted olive palette with soft green-gray surfaces and readable dark and light counterparts; keep this inventory and its count synchronized with COLOR_THEMES. -->
<!-- FNXC:MidnightTheme 2026-08-03-02:05: Midnight is selectable and persists from the shared Settings and Command Center list across web and Electron startup; its deep-navy/violet dark palette has a cool pale light counterpart. -->
<!-- FNXC:DashboardTheming 2026-08-18-05:45: Velvet is a persisted plum/burgundy palette with rose-gold dark-mode accents and a warm blush-white light counterpart; keep its inventory entry and count synchronized with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-08-23-01:51: Iceberg is a persisted navy-slate palette with a periwinkle-blue accent and pale blue-gray light counterpart; keep its id/order synchronized across core, selector metadata, both first-paint validators, token blocks, swatch CSS, and this inventory. -->
<!-- FNXC:DashboardTheming 2026-08-27-04:23: Flexoki is a persisted warm inky palette with muted ink-blue and violet dark accents and a cream paper light counterpart; keep its inventory entry and count synchronized with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-08-28-07:45: Cozy Cartoon is a persisted cream pastel light palette with coral, mint, sky, and lavender accents, oversized rounded buttons, and a warm cozy-night dark counterpart; keep its inventory entry and count synchronized with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-08-20-00:33: Medieval is a persisted palette with readable local Pixelify Sans for ordinary UI, deliberate mono code/terminal exceptions, CSS paper texture, and a shared wood-framed generic modal; keep this operator inventory synchronized with COLOR_THEMES. -->
<!-- FNXC:DashboardTheming 2026-07-21-12:20: FN-8471 keeps the Settings current-theme row and Command Center compact trigger on one filterable shared list so operators can discover any rendered theme name without changing the persisted selection until they choose an option. -->
<!-- FNXC:LiquidGlassTheme 2026-09-09-15:50: Liquid Glass is a persisted web theme inspired by Apple's public material guidance, not an Apple product or a pixel-identical implementation of the native compositor. It reserves adaptive regular glass for functional chrome, keeps content on readable standard materials, and honors motion, transparency, contrast, and forced-color preferences. -->

Dark/light modes via `data-theme`; fresh installs default to System mode so the resolved theme follows `prefers-color-scheme` until the user explicitly chooses Light, Dark, or System. 94 color themes via `data-color-theme` (lazy-loaded from `app/public/theme-data.css`), including Cobalt (saturated blue), Clay (warm terracotta), Moss (muted forest green), Aurora (navy/teal/violet dark surfaces with a misty blue-white light counterpart), Calm (low-stimulation slate/sage dark surfaces with a misty blue-white light counterpart), Dawn (indigo/plum dark surfaces with muted amber accents and a dawn-white light counterpart), Sage (soft green-gray surfaces with a muted olive accent and readable dark/light ramps), Midnight (deep-navy surfaces with restrained violet/indigo accents and a cool pale light counterpart), Velvet (deep plum/burgundy dark surfaces with rose-gold accents and a warm blush-white light counterpart), Iceberg (navy-slate dark surfaces with a periwinkle-blue accent and a pale blue-gray light counterpart), Flexoki (warm inky near-black dark surfaces with muted ink-blue and violet accents and a cream paper light counterpart), Cozy Cartoon (cream pastel light surfaces with soft coral, mint, sky, and lavender accents, oversized rounded buttons, and a warm cozy-night dark counterpart), Medieval (readable local Pixelify Sans for ordinary UI, deliberate mono code/terminal exceptions, CSS paper texture, and wood-framed generic modals), Factory Dark (graphite/steel dark surfaces, cool gunmetal borders, and restrained safety-orange accents with a concrete-gray light counterpart), and Factory Light (bright concrete/warm-white surfaces, steel-gray borders, a darkened safety-orange accent, and a warm-graphite dark counterpart), the Shadcn zinc-neutral theme with an orange default highlight/accent, Shadcn Custom (the same base with sanitized per-token color-picker overrides), and its color family: Shadcn Blue/Green/Red/Purple/Pink/Orange/Yellow, Shadcn Mono and Shadcn Mono Red/Blue/Green/Purple/Pink/Orange/Yellow (grayscale surfaces with color-specific accents; Shadcn Mono retains its selected id), Shadcn Black (pure black and white), Shadcn Gray (fully neutral zinc-gray accent), and Shadcn Gray Blue (blue-gray slate neutral surfaces with a muted slate-blue accent). Air is the minimal, borderless, paper-like preset with near-monochrome tokens and CSS-only chrome flattening. Glass Silver preserves the Glass theme's frosted translucent surfaces and transparent modal overlay behavior while using silver and graphite accents instead of purple/pink.

Liquid Glass is an independent preset based on Apple’s publicly documented material principles for web-applicable interfaces. In light and dark modes, it applies a restrained regular-glass treatment to the Header, sidebar and mobile navigation, view headers, controls, menus, modals, and floating windows. Board columns and cards deliberately remain more opaque, unblurred standard materials so task content stays readable instead of accumulating nested glass. The theme preserves transparent click-through overlays and mobile safe-area/full-screen behavior; reduced-motion, reduced-transparency, increased-contrast, and forced-color preferences simplify or remove optical effects while retaining visible controls and keyboard focus.

Choose color themes from **Settings → Appearance** or from the Command Center **Overview** theme card. Settings merges its selector into the current-theme row, which opens the full color-theme list; Command Center keeps the compact `ThemeDropdown` trigger. Both use the same filterable list: type a visible theme name to narrow the displayed labels and color-chip swatches, then select an option to change the theme. Filtering alone never changes the chosen theme. The selected color theme, including Liquid Glass, Midnight, Velvet, Iceberg, Flexoki, Cozy Cartoon, and Medieval, persists in browser storage and is validated before React hydrates on both web and Electron startup. The left sidebar active-item highlight and resize accent use the active theme's `--accent`, so they follow the selected Shadcn accent instead of staying fixed blue.

- **Base tokens** (`--bg`, `--surface`, etc.) — redefine in `:root`, `[data-theme="light"]`, and every theme block.
- **Semantic tokens** (`--autopilot-pulse`, `--event-error-text`, `--badge-mission-*`, `--fab-*`) — `:root` + `[data-theme="light"]` only; no per-color-theme overrides.
- **Status tokens** (`--triage`, `--todo`, etc.) — redefine per theme block.

`status-colors-theme.test.ts` iterates all theme blocks to catch regressions.

### Component classes

Reuse existing primitives from `styles.css`:
- **Buttons**: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-warning`, `.btn-sm`, `.btn-icon`, `.btn-icon--active`, `.btn-badge`. All inherit `:focus-visible` via `--focus-ring-strong` and `:active` via `transform: scale(0.97)`.
- **Modals**: `.modal-overlay[.open]`, `.modal`, `.modal-lg`, `.modal-header`, `.modal-close`, `.modal-actions`, `.modal-actions-left/right`. Overlay pads top with `--overlay-padding-top`. Overlay dialogs should render through `createPortal(..., document.body)` so `position: fixed` overlays escape transformed, contained, or fixed ancestors. Resizable modals using `useModalResizePersist(...)` get a shared bottom-right touch/mouse resize grip on tablet and desktop; mobile sheets stay full-screen and grip-free.
- **Forms**: `.form-group`, `.input`, `.select`, `.checkbox-label`, `.form-error`. Inputs in `.form-group` get focus styles automatically.
- **Cards**: `.card`, `.card-header`, `.card-id`, `.card-title`, `.card-meta`, `.card-status-badge--{triage,todo,in-progress,in-review,done}`.
- **Utility**: `.touch-target` (44px min), `.visually-hidden`.

Don't create parallel button/form variants — add states (`:hover`, `:focus-visible`, `:active`) to the existing primitives.

#### Icon-only buttons: exactly two canonical variants

A button that shows only a glyph has **two** legal appearances, and no third:

| Variant | Classes | Paint | Living reference |
| --- | --- | --- | --- |
| Borderless | `btn-icon` alone (no `btn`) | `background: none`, `border: none`, `color: var(--text-muted)`, hover `background: var(--border)` | Header search and header actions |
| Bordered | `btn btn-icon btn-sm` | border and background inherited from `.btn`, glyph at `var(--icon-size-sm)` | Task Detail header actions, shared back chevron |

- **Geometry is tokenized and shared:** `--icon-button-size` (28px) on desktop, `--icon-button-size-mobile` (36px) at `max-width: 768px`. No icon-only control may paint a 40px, 44px, `var(--touch-target-min-size)`, or `var(--ui-touch-height)` box.
- **The glyph scales with the box:** `--icon-button-glyph-scale-mobile` is the unitless multiplier `calc(var(--icon-button-size-mobile) / var(--icon-button-size))`, applied to `--icon-size-md`/`--icon-size-sm` inside the mobile block so the glyph-to-box ratio on a phone is exactly the desktop one. Never replace it with a hardcoded pixel value — that would neutralize the `ui-style-tokens.css` style axis. Any owner that pins its own glyph outside the `.btn-icon > svg` contract (the collapsed create action and the back chevron in `ViewActionButton.css`) must apply the same scale explicitly, in the same media block as its box rule.
- **Specificity contract:** the borderless base stays on the bare `.btn-icon` selector (0,1,0) and must never be rewritten as `.btn-icon:not(.btn)`, given any other composed form, or marked `!important`. `styles.css` is loaded last, so a 0,2,0 base would win the order tiebreak against every existing 0,2,0 component override (Secrets, Agent prompts, Branch groups, Planning mode, New task, themes…) and silently erase them. The bordered variant is expressed as the composed `.btn.btn-icon` (0,2,0), which declares the border only — never a size, background, or colour, because those would collide with `btn-primary`/`btn-task-create` pairings and with component geometry such as Quick Entry's.
- **No CTA fill on a glyph.** A create action reduced to its `+` uses the bordered variant; the CTA emphasis belongs to its labelled presentation.
- **Labelled controls are out of scope.** A button showing visible text keeps its comfortable 44px touch target, as do list rows, tabs, `select`s, and resize handles. `--touch-target-min-size` and `--ui-touch-height` remain the tokens for those.
- **Documented exemptions:** the Task Detail / planner chat send buttons and the Quick Entry primary group keep their operator-decided geometry. `packages/dashboard/app/components/__tests__/icon-only-button-canon.test.tsx` is the inventory guardrail that keeps an oversized icon square from reappearing.

Small fixed notification cards (for example the first-task GitHub star prompt) should reuse `.card`, `.btn`, and `.btn-icon`, anchor themselves with tokenized `position: fixed` offsets, and include a mobile `@media (max-width: 768px)` override so they clear the mobile nav/FAB region.

### Mobile responsive

Breakpoints: 768px (primary mobile), 1024px (tablet `min-width: 769px and max-width: 1024px`), 640px (compact), 480px (xs). Mobile overrides go in `@media (max-width: 768px)` blocks at the bottom of `styles.css` after base styles.

**Bottom spacing:** `--mobile-nav-height` (44px) + `env(safe-area-inset-bottom, 0px)` + `--standalone-bottom-gap` (0/8px PWA). All bottom-positioned mobile elements compose those. Fixed mobile bottom bars never rise with the soft keyboard: on keyboard-focusable text focus at scale ≤ 1.01, `--icb-bottom-offset` is clamped to `0px` so an absent or stale viewport baseline cannot lift them, including landscape phones and hosts without `visualViewport`. The mobile nav slides fully off-screen on that focus transition rather than waiting for a settled viewport sample. The executor footer keyboard-collapse pin is iOS-only. On Android (`interactive-widget=resizes-content`), the footer keeps its stacked position above the nav bar to avoid overlap after keyboard dismiss.

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

These 20 views are lazy-loaded via `React.lazy()` with `<Suspense fallback={null}>`. `prefetchLazyViews()` warms App-level chunks once on mount via `requestIdleCallback`; AppModals lazy modal imports (`SettingsModal`, `WorkflowNodeEditor`, `SetupWizardModal`) are part of the same inventory. **Do not make these eager.**

- `AgentsView`
- `ChatView`
- `MemoryView`
- `DevServerView`
- `SecretsView`
- `InsightsView`
- `NotesView`
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

Embedded Import Tasks (`_ImportTasksView`), Automations (`_AutomationsView`), and Settings (`_SettingsView`) reuse existing lazy chunks and are intentionally excluded from the curated count by the underscore-prefixed App const convention. Workflows is not excluded: it is the workflow editor's only presentation, so its App-level `WorkflowNodeEditor` declaration is the curated entry.

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
- For dashboard chat textareas use `packages/dashboard/app/utils/chatInputAutosize.ts`. Its controller resets the used height before measuring, caps automatic growth at five rendered lines, sets `overflow-y: auto` only beyond that cap, and returns cleared content to the minimum. Pair every chat class with `resize: none`; do not add a manual mouse-resize path.

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
- Every dashboard Smart Push attempt records `mutationType: "push:origin"` run-audit metadata: `integrationBranch`, `remote`, `localSha`, `remoteSha`, `aheadCount`, `behindCount`, `forceWithLease`, `outcome`, optional `stderrPreview`, and `durationMs`.
- Automatic post-merge pushes also emit `push:origin`; failed and shutdown-aborted attempts use `outcome: "failed"` and `outcome: "aborted"`, respectively, while leaving the already-finalized task done.
- When post-merge push detects remote divergence, `push:recovery-branch` records the remote safety-ref lifecycle with IDs/outcomes-only metadata: `taskId`, `remote`, `recoveryBranch`, `sha`, and `outcome` (`success`, `failed`, `deleted`, or `delete-failed`). The `fusion/<task-id>-stranded` ref is deleted after a successful target push and retained after failure or abort.
- Dashboard Push remains explicit user authorization only through dashboard HTTP routes; the separate `pushAfterMerge` project setting controls automatic post-merge pushes.

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

> **FN-7534 / FN-295:** completed members remain live branch-group members and retain their landed evidence. Soft-deleted tasks are not returned by the live branch-group scan and cannot be used as completion evidence.

Both the modal and branch-group card are completion-gated: while members are still pending, they show progress only. PR / merge controls are only revealed after all members are landed into the shared branch. When auto-merge is off, promote/open-PR is explicit user action (no automatic push-to-origin behavior). Before a manual Open PR or Merge group request, Fusion displays persisted non-clean pre-merge advisories from every landed live member; operators can open the member Review surface from the advisory and must confirm (or cancel without sending a request). Clean groups explicitly state that no advisories were recorded.

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

### Planner clarification notifications

<!-- FNXC:PlanningMode 2026-07-20-01:00: Planning interviews are always infinite and user-validated. The former follow-up toggle cannot suppress questions or produce a final summary; the dashboard starts each interview in the full questioning mode. -->

Planning Mode asks another focused question after every answer until you select **Validate plan**. For a vague, subjective, preference-style, or symptom-only opener, it first inspects the relevant repository surface and offers materially distinct, concrete directions plus **Other** instead of an abstract clarification question. Each selected direction, multi-selection, or verbatim Other response rebuilds the evolving plan around that accumulated decision; the next question then narrows the selected direction one consequential level further with concrete options. The provisional plan does not falsely commit to an unselected alternative, and only the operator can validate the finished plan. Each `awaiting_input` question can send the configured `planning-awaiting-input` ntfy event.

### Navigation quick access

The bottom navigation bar shared by tablet and desktop shows up to **four** quick-access destinations followed by the **More** menu. By default those four are Dashboard, Board, Planning, and Missions — Agents and Mailbox are not direct destinations and live in **More**, alongside every other destination you have not promoted.

The fifth slot of the bottom bar belongs to **Chat**, and it is deliberately not configurable. On tablet and desktop it is the Chat button at the bottom right of the footer; on the mobile interface it is the **Chat** entry of the bottom menu. On mobile you can also **swipe the bottom bar upwards** to open Chat directly, without opening the menu first. That gesture is touch-only — a mouse or trackpad drag never triggers it — and it stays inert when the menu is already open, when Chat is already on screen, when the movement goes downwards or sideways, or when it is too short and too slow. A normal tap on a destination is unaffected, and the destination under your finger does not open at the end of a swipe.

In **Settings → General → Navigation quick access**, choose which destinations occupy those four slots and in which order: the selected list uses earlier/later controls, a remove action, and an add dropdown that disables itself once four destinations are selected. If you had previously selected five destinations, the first four are kept and the fifth moves into **More**; nothing is lost. Every change previews in the live navigation bar while Settings remains open, then auto-saves. Unselected destinations stay reachable in **More**, feature-gated views remain hidden until their feature is enabled (a selected but gated destination simply does not appear), and the trailing **More** button is always present. Destinations with no bottom-bar entry — Chat, Notes, Secrets, Settings, Patchnode, Activity, Usage, Projects, Ideation — cannot be promoted and keep their existing owners (sidebar, right dock, mobile **More** sheet, Settings). Agents remains reachable from the **More** sheet.

The setting itself is identical on every device: the entry you select is **Board**. On a phone and a narrow tablet that slot shows and opens **List**, because the Board is the permanent surface behind every drawer and a Board shortcut there would change nothing on screen; as a result the mobile menu has no separate **List** entry. Tablet and desktop are unchanged — **Board** stays **Board**, and **List** keeps its usual places.

## In-app reports

The **Report** menu is available in **Settings → General · Project** and the Command Center **System** tab on desktop and mobile. It offers **Bug**, **Feedback**, **Idea**, and **Help**; each action begins with a short, guided prompt rather than a raw GitHub issue form. The System control is the Command Center report home; **Copy diagnostics** remains a separate local control.

Fusion gathers available task/agent context, structures the prompt into a report, scrubs secrets, local paths, project names, home-directory identities, email addresses, and likely personal names, then checks **open** GitHub issues or Discussions for duplicates. Scrubbing is mandatory for every route and is repeated on the server when a reviewed draft is edited before filing. A strong duplicate receives a visible 👍 reaction and one scrubbed data-point comment instead of a new issue or Discussion. Bug and Idea reports use issues; Feedback and unresolved Help reports use repository Discussions. If preparation or filing cannot reach GitHub, Fusion preserves the draft and shows a retryable error.

The public roadmap is also a deduplication source. With `reportRoadmapDedupeEnabled` (default `true`), Fusion searches open GitHub Issues in `reportRoadmapRepo` (or the normal tracking repository when unset) carrying `reportRoadmapLabel` (default `roadmap`). This pass applies to Bug, Idea, Feedback, and Help reports, before ordinary Issue or Discussion matching. A matching roadmap issue wins deterministically: **Review draft** asks whether to add the scrubbed data point; **File automatically** adds the existing 👍 and scrubbed comment. Closed items and unavailable roadmap searches are ignored, so reports fall back to normal destination dedupe. The server rechecks the open label-qualified match before it endorses an item from an edited browser draft.

In **Settings → General**, choose **Review draft before filing** (the default) or **File automatically**. Both paths show the resulting issue, Discussion, or endorsement link. Help checks Fusion's local knowledge index on every server report path first and only escalates when it cannot find an answer.

Reports can include a short activity trace of recent built-in view names (up to 20 entries). The trace is ordinary text and receives the same mandatory server-side scrub as every other report field on every egress path, including edited drafts and duplicate endorsements.

Choose **Store a screenshot locally** to request browser screen-capture permission. Fusion captures one PNG frame in its local artifact registry, then requires confirmation that the screenshot may be retained before a report can reference it. When filing or endorsing the report, Fusion resolves that single provenance-validated local artifact server-side and makes a best-effort GitHub Contents API upload; a successful upload is embedded inline in the Issue, Discussion, or duplicate data-point comment. Upload failure never blocks the scrubbed text report, and raw pixels are never accepted from the report-file request.

The uploaded image uses the tracking repository's raw URL. It renders inline for public repositories; viewers of private repositories need GitHub authorization for that raw URL, so anonymous viewers will not see the image. The original screenshot remains a local artifact as well.

## Chat-requested task verification

Chat can queue `fn_task_request_verification` for an **in-progress** task that has a live executor worktree. The only profiles are `verify:fast` (default) and the project-configured `test-command`; chat never accepts or executes raw shell text. Command-execution policy applies to the request, including approval and denial outcomes. Use `fn_task_verification_status` to read the persisted request, running state, or bounded terminal output. The executor owns the actual run and shared verification concurrency slot, so results remain visible through task execution state and Command Center observability.


Productivity duration uses total agent-active time: planning (`cumulativePlanningMs`) plus execution (`cumulativeActiveMs`); queued column dwell is not included.

### Custom workflow column descriptions

Custom workflow authors can add optional explanatory copy beneath each column name in the workflow editor. The description appears on selected and aggregate workflow board columns. Clearing it removes the custom metadata; columns then continue to use the standard lifecycle description when one exists.

## Planning Mode contextual comments

In plan review, select text inside the rendered plan and choose **Add comment to selection**. On mobile widths through 768px, the selection action appears in the bottom plan-action rail beside **Refine** and **Proceed with plan**; at 769px and wider it stays beside the selected plan content. Enter a suggestion to capture the selected quote and suggestion as a pending contextual comment. You can remove individual comments before choosing **Submit comments**; Fusion sends the ordered batch through the existing Planning Mode revision generation, so the agent revises the quoted areas while preserving unaffected plan content. A successful revised-plan update clears the batch; a failed submission retains it for retry.

## Voice dictation

When **voiceInput.enabled** is enabled and the installed speech-to-text runtime confirms it is available, dashboard chat, Planning Mode, quick task entry, task forms, and task comments expose a microphone control beside their primary composer. The control is intentionally absent—not disabled—while voice input is off, status is still loading, status fails, or the runtime/model is unavailable.

Dictation inserts a live partial transcript at the current caret (or replaces the current selection). Later partials and the final transcript replace that anchored preview in place, preserving surrounding text and the controlled textarea cursor. The mic button has accessible start/stop/error labels and announces its state for screen readers.

### Conversation tags

Direct conversations can be organized with reusable tags. Open a conversation's **More** menu to create a tag or toggle its assignments; a conversation can have multiple tags. Use the tag selector beside conversation search to filter pinned and recent conversations without affecting text search. Tags are project-scoped, and deleting a tag only removes its assignments—it never deletes conversations or messages. Chat Rooms do not use conversation tags.

### Tablet touch modal resize

Task Detail and New Task retain their desktop resize chrome, but tablet-class touch viewports expose a 44px `data-resize-hit-target` around resize controls. The target is enabled only by the shared tablet-touch viewport classifier; true-phone sheets and desktop coarse-pointer devices do not expose it.

## Floating modal contract

All non-trivial, reflowable dashboard dialogs use `FloatingWindow`; do not create a second drag,
resize, or viewport-classification implementation. A migration uses the dialog's existing header as
its drag handle and supplies `hideHeader`, `dragHandleSelector`, `className`, `defaultSize`,
`minSize`, `persistGeometryKey`, `suspendGeometryPersistenceOnMobile`, and
`suspendGeometryPersistenceOnShortViewport`. Former blocking dialogs also pass `modal`: it enables
the shared backdrop, `aria-modal` dialog semantics, and keyboard focus boundary while preserving
shared touch geometry. The variant class must be included in the shared sheet reset: suspension of
geometry and removal of handles are insufficient unless the host and its content fill the phone or
short-viewport sheet. `closeOnOutsidePointerDown` defaults to **off**; a dialog that previously
closed from its backdrop must opt in explicitly, and blocking first-run flows must omit it.

| Viewport | Drag and resize | Persistence |
| --- | --- | --- |
| Desktop (including coarse-pointer desktop), ≥1025px | Active desktop mouse drag and eight-direction resize; targets are unchanged | Persisted |
| Touch tablet, 768–1024px | Active touch drag and resize with ≥44px `data-resize-hit-target` controls | Persisted |
| True phone, ≤767px | Full-screen sheet; no active geometry affordance | Suspended |
| Any viewport ≤480px tall | Full-screen sheet; this overrides the width row | Suspended |

Exactly **768px** is touch-tablet when the shared `isTabletTouchViewport` classifier identifies a
touch tablet; **767px** starts the true-phone sheet range. Do not use bare `@media (pointer:
coarse)`: desktop coarse-pointer hardware retains normal desktop controls, while only the shared
classifier activates enlarged tablet targets. Preserve focus, Escape, ARIA labels, existing scroll
containers, and each dialog's dismissal/confirmation behavior when moving its content to the host.

`AgentListModal`, `AgentImportModal`, `AgentGenerationModal`, `AgentOnboardingModal`,
`ExperimentalAgentOnboardingModal`, `SetupWizardModal`, `NativeShellOnboardingModal`,
`DockerNodeOnboardingModal`, `MailboxModal`, and `MilestoneSliceInterviewModal` use this contract.
Outside dismissal is explicit for Agent List/Import/Generation, Docker onboarding (guarded while
submitting), Mailbox, and Milestone/Slice Interview; the four onboarding flows remain blocking.

Only transient, single-decision confirm/alert dialogs with no reflowable content or long dwell time
may remain static. The inventory opt-outs are `AgentErrorDetailsModal` (brief acknowledgement),
`ModelSelectionModal` (compact focused choice), `ReportModal` (brief reporting action),
`ResearchTaskActionModal` (bounded confirmation), `SettingsSyncConflictModal` (urgent conflict
choice), and `StashConflictModal` (urgent bounded recovery). The executable inventory is guarded by
`modalFloatingWindowContract.test.tsx`; `migratedModalFixtures.tsx` keeps every hosted surface in
per-modal geometry coverage.

### Reverted task resolution

When a completed task is successfully reverted, it remains in its ordinary workflow column or list group with a **Reverted** label. It is not moved to a separate group, and the card shows only that label — the former Delete/Revise button pair on the card is gone.

To undo the revert, open the task context menu (right-click a Board or right-dock card, long-press it on mobile, use the List row context menu, or open the Task Detail actions) and choose **Restore revert**. An already-reverted task is not offered **Revert** again.

What happens then:

- Fusion reverts the revert commit(s) on the integration branch and shows a success toast. The **Reverted** label disappears on every surface (board, list, dock) once the restore is recorded; the revert history itself is preserved, so the task's Patchnode cancellation record stays readable.
- If the restore conflicts with later work, nothing is force-written. Fusion creates a dedicated AI task that re-applies the reverted behavior while preserving later changes to the same files; that task is delivered by the ordinary AI merge pipeline (the Merger agent), which owns AI-assisted conflict resolution. A second attempt while that task is still open re-uses it instead of creating a duplicate.
- If auto-merge is off for the task or project, Fusion refuses with an explanatory toast rather than writing to a branch the project opted out of.

### Todo Lists plugin enablement

Todo Lists is an optional first-party plugin. Enable `fusion-plugin-todos` for a project in the Plugins settings to make its plugin-discovered Todos destination and `/api/plugins/fusion-plugin-todos/todos/*` API available for that project. Disabled or uninstalled projects expose neither route nor navigation entry; enablement is per project and replaces the former experimental Todo setting.

## Workflow direct-review items

The Review tab shows a custom workflow result only when its selected workflow declares the exact top-level node and result source, the result explicitly snapshots `reviewKind: "plan"` or `"code"`, and it is current, terminal, and not bypassed or superseded. Each persisted open structured finding becomes one independently selectable reviewer-agent item with its server-owned identity, optional location, and severity. Findings marked `resolved-in-review` or `superseded` remain visible as audit-only, badged rows and cannot be selected; the revision route enforces this as well. Selecting a subset sends only those canonical open items for revision; client-supplied text and metadata are ignored. A current result without findings retains one prose/notes fallback item. Pending, skipped, historical prior attempts, blank results, and records without that declared top-level identity (including template instances) are not selectable or addressable. Node-ID punctuation alone does not identify a template instance. Existing historical `plan-review` and `code-review` results retain narrow compatibility; Fusion does not infer or backfill custom review meaning from names, verdicts, prose, or gate settings.

### Workflow agent routing

Agent creation and detail settings support a primary role plus additional role tags. Workflow review prompts expose a node-local reviewer override and retain a missing configured ID visibly rather than clearing it. Task workflow-stage identity is distinct from assigned ownership: a stage badge identifies the currently fenced principal while active, then clears when its work item terminates.


### Pull-request required checks

In **Settings → Merge**, pull-request mode offers **Required pull-request checks**. Enter comma-separated GitHub check names to make Fusion wait for those names independently of repository rulesets. The PR review surfaces show the same missing, pending, failed, or truncated-check-list reasons used by the merge gate. **Reset this menu** clears the setting.

### Durable agent activity telemetry

Activity includes durable and ephemeral agent sessions from heartbeat, executor, workflow-step, triage, reviewer, and merger lanes. **Sessions** is the sum of CLI session rows and `usage_events` session-start rows in the `agent-session` category; each session class has one writer. Human chat and mailbox turns supply `user_message` events. Active nodes remains zero on a single-node installation when no mesh routing node id exists.
## Plan alignment in Task Detail

The collapsed Debug disclosure in shared Task Detail **Details** shows the persisted spec alignment, latest lock/current-plan versions, and deterministic finding categories. `activeLock` is derived from the live approval fingerprint and current-plan hash; an unavailable or inactive lock is not presented as on-plan. A historical report from a prior lock or plan revision stays in retained history and displays as unavailable until a matching current report exists. Findings are structural; `mission-statement` identifies a changed Mission narrative hash without displaying or judging its prose. The same shared content is used by modal and right-dock task detail hosts.

### Promote release-gate enrichment

`GET /api/tasks` may attach a transient `releaseGate` verdict to hold-lane cards. It includes the resolved release target, pre-release Plan Review facts, and capacity-boundary state, so Promote visibility exactly matches the server while the verdict is fresh. SSE does not carry this field: `useTasks` retains it only while its visible-evidence fingerprint and task row clock match, and for at most `RELEASE_GATE_VERDICT_MAX_AGE_MS` (30 seconds). Otherwise the card uses the conservative client fallback because workflow IR, continuations, and prompt content are not browser-visible.

### Model catalog refresh resilience

`GET /api/models` bounds each catalog refresh to 15 seconds and continues serving the registry's retained `getAvailable()` rows when a provider stalls or fails. Refreshes are single-flight per registry instance: a timed-out operation can continue in the provider runtime, but Fusion never starts another concurrently. A successful refresh is fresh for 60 seconds from its successful settlement; a failed refresh uses a separate 60-second retry window measured from its attempt start, so a failure is never reported as fresh. After a failed refresh settles, the next attempt starts only after both settlement and that retry interval.

Saving or removing API keys, completing OAuth login/manual-code flows, logging out, and removing credential instances invalidate that registry's generation and clear both windows. If a credential change happens while an uncancellable refresh is already running, the model list temporarily serves its retained rows rather than overlapping the refresh. Once that old refresh settles, the first following request starts a current-credential refresh with no additional cache-window wait.

The Memory view also includes a fourth **Knowledge Graph** tab. It provides capped search, node detail, edge and neighbor drill-down, bounded shortest-path navigation, and explicit artifact rebuilding for the deterministic project knowledge graph.

### Workspace per-repository land status

Task Detail's **Details** tab shows each acquired workspace repository as **landed**, **pending**, or **failed**. Landed repositories include a short commit SHA; a partial land shows the aggregate landed count and retained task failure detail. The compact TaskCard chip deliberately remains count-only. The engine records a durable per-repository failure for both `landWorkspaceTask` failed-result branches and self-healing's unrecoverable partial-land park; busy leases, aborts, persist-after-advance recovery, and empty merges intentionally do not record one. Older partial-land rows and empty repositories remain pending, with any available failure detail shown only in the aggregate block.

### Workspace task scope status

The workspace repository summary in Task Detail's **Details** tab distinguishes acquired repositories from explicit task scope. Each repository shows whether it is modified, out of scope, or **No changes — not reviewed**, alongside landed, pending, or failed land state. An acquired repository outside the selected scope is informational only; it does not receive a review verdict or block task completion. The same summary remains readable in compact task-card presentation without adding empty controls on mobile.

### Update restart recovery

Settings separates automatic installation from automatic restart. Following an operator-requested dashboard update restart, the page waits for the replacement host to report the installed version through health before it reloads. Transitional, old, and unavailable responses do not complete recovery. If the host does not return before the bounded timeout, the update surface provides manual refresh guidance. This explicit recovery is separate from the always-on automatic reload on version change and does not change native Electron or standalone CLI update behavior.

### Review finding resolutions

The Review tab renders the `dispute-upheld` badge for an adjudicated finding. It is a terminal resolution and cannot be selected for a further revision; it is distinct from the existing Superseded badge.

### Review-gated task progress

Cards using the review-gated workflow show implementation progress while work is in progress. In review, their progress block includes Verification, Code Review, and Documentation & Delivery after the implementation steps, separated visually; the running gate supplies the card badge.

### Docked conversation sidebar

In the full Chat view on tablet and desktop, use the conversation-list button in the Chat header to show or hide a docked conversation sidebar. Drag its separator or use the arrow keys while focused to resize it from 220 to 480; its width and open state are remembered in the browser. Conversation rows show their name, provider, model, and latest-message snippet. Mobile, the compact right dock, the Chat drawer, and popped-out chat windows retain one-pane conversation navigation.

## Blocked task display

An externally blocked task uses a Blocked cover on board cards and the same notice in List and Task Detail. The notice shows the durable raw error code and message. Its robot action opens Chat with an explanation prompt, and Retry resumes the interrupted step. Dependency and file-overlap waits continue to use waiting labels rather than the Blocked identity. The cover and actions use the same responsive component contract on desktop and mobile.

- `File scope overlap blocker: <id> (stale)` means the named task no longer owns the overlapping files. Self-healing clears that obsolete wait automatically across planning, work, and review lanes; a blocker that still holds an overlapping file-scope lease is preserved.

### Desktop local-startup diagnostics

When the desktop shell cannot start its embedded local Fusion runtime, its failure panel shows the startup phase and attempt count, expandable technical details, and a control to copy a support-ready report. It also shows the per-launch log location when available. Fusion writes this log best-effort, off the startup path, to `<runtime root>/.fusion/logs/desktop-startup.log`; the runtime root honors `FUSION_HOME`, and the previous launch is rotated to `desktop-startup.prev.log`. If the host cannot write that location, the panel says so instead of showing a dead path. `FUSION_STARTUP_TRACE` remains available as an operator-selected synchronous trace sink.

### Notes

La destination **Notes** est disponible dans la barre latérale sur ordinateur et tablette, et dans **More** sur mobile (ou directement dans le footer lorsqu’elle y est promue depuis les réglages). Chaque projet possède sa propre liste persistante de notes; la recherche porte sur les titres et le contenu, et les titres identiques restent autorisés.

Sous l’en-tête, Notes occupe tout le panneau disponible. Sur ordinateur et tablette, une séparation unique place la liste compacte à gauche et donne tout l’espace restant à l’éditeur; la note cliquée reçoit immédiatement un fond et un marqueur d’accent, sans attendre la fin de son chargement. Tant que la liste et l’éditeur sont visibles côte à côte, aucune commande de retour n’est rendue. Sur un écran étroit ou peu haut, la liste et le détail deviennent un parcours plein panneau, avec une commande **Back to notes** accessible pour revenir à la liste.

L’en-tête de Notes porte le titre de la note confirmée dès qu’elle est ouverte, y compris quand la liste est masquée (téléphone, fenêtre détachée). Pendant le chargement d’une autre note, le détail affiche un état de chargement au lieu de la note précédente : le texte d’une note déjà ouverte n’est jamais présenté comme celui de la note demandée, et ouvrir une note vide affiche un éditeur vide.

L’en-tête de Notes est contextuel : en état liste il porte **New note**, et dès qu’une note est ouverte ce bouton fait place à un bouton **…** qui ouvre les mêmes actions rapides que le menu de ligne, précédées de **New note** pour que la création reste atteignable : **New note**, **Rename**, **Delete**. Comme le renommage se fait en place dans la ligne de liste, déclencher **Rename** depuis l’en-tête d’un écran étroit revient d’abord à la liste ; si vous refusez d’abandonner un brouillon, rien ne change. La liste compacte du dock reste propriétaire de liste et garde toujours **New note**, et une fenêtre de note détachée ne rend aucune de ces deux affordances.

Le renommage et la suppression d’une note se font depuis la liste, via le **menu contextuel de sa ligne** : clic droit à la souris, touche **Menu** ou **Shift+F10** au clavier, appui long au doigt ou au stylet. La ligne ne porte plus de bouton « … ». **Rename** bascule la ligne en édition en place, **Delete** demande confirmation. Ouvrir ce menu ne sélectionne pas la note, ne charge rien et n’écrase aucun brouillon en cours sur une autre note. La même interaction est disponible dans les quatre hôtes à liste (page, popover d’en-tête, tiroir téléphone, liste compacte du dock) ; une fenêtre de note détachée ne montre que le détail et n’acquiert aucune affordance de liste.

Une fenêtre de note détachée suit le nom courant de sa note : renommer la note ailleurs met immédiatement à jour le titre de la fenêtre, sans la remonter au premier plan ni voler le focus. Tant qu’un brouillon non enregistré est en cours dans cette fenêtre, il n’est jamais remplacé par la version venue d’ailleurs.

Une note accepte du texte libre et du Markdown, notamment des commandes et des journaux. La zone d’édition ne contient que le contenu : il n’y a ni champ titre, ni bouton **Save** ou **Delete**, ni bascule **Edit**/**Preview**. Les changements sont enregistrés automatiquement après une courte inactivité, et toujours avant de changer de note, de revenir à la liste ou de fermer la surface qui les héberge; un indicateur d’en-tête affiche l’état courant. En cas d’erreur réseau ou de conflit de révision, le brouillon local est conservé, l’enregistrement automatique s’arrête, et l’utilisateur choisit explicitement de recharger la version serveur ou de la remplacer — c’est le seul cas où quitter la note demande encore confirmation.

## Whiteboard Alpha

Whiteboard is an optional project workspace for ideas, flowcharts, and UI sketches. Enable **Settings → Experimental → Whiteboard Alpha** (`experimentalFeatures.whiteboardView`) to expose it in desktop, tablet, and mobile navigation. The global setting defaults off; deep links and restored Whiteboard views return to Board while it is disabled.

Each board preserves a structured document containing frames (`screen`, `functional-area`, `process-step`), typed text, and relations that can share one trunk across annotated branches. The palette and inspector edit these objects, while the toolbar provides selection, movement, resize, duplicate, copy/paste, delete, undo/redo, alignment, distribution, explicit layout, zoom, and pan. On mobile, the list and canvas use successive full panels with a Back action.

Saves use optimistic revisions. If another window saves the same revision first, the local draft remains editable and exportable: reload the remote version or create a copy, with no forced overwrite. Restoring an older snapshot creates a new current revision. Versioned JSON is canonical; the on-demand PNG export is only a visual companion.

Alpha limits are 500 frames, 5,000 texts, 5,000 relations, 10,000 branches, and 5 MiB per document. Nested frames, real-time collaboration, AI generation, structured import, and executable UI components are not supported.
