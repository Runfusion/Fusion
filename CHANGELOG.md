# Fusion changelog

User-facing release notes aggregated across all packages. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.

## 0.60.0

### Highlights
- Fixed agents silently going stale for hours despite the heartbeat repair audit
- Bundled example plugins no longer fail to enable with a missing package error
- List view popups now match Board's movable task window
- Planning Mode auto-retries a stuck AI generation before erroring
- Merger AI model is now configurable under Global and Project Models

### New
- Open tasks as popups now applies to List clicks with the same movable task window as the Board
- Planning Mode now auto-retries a stuck AI generation up to 3 times before showing an error
- Add a Plan action to planning/ideas/hold task cards that opens Planning Mode from the card
- Make the merger AI model configurable under Global and Project Models

### Fixed
- Fix bundled example plugins failing to enable with a missing @fusion/core package error
- Fix agents silently going stale for hours even though the heartbeat repair audit was running
- Settings search now surfaces Project Models Chat default settings when searching for chat

## 0.59.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.59.0
- @fusion/engine@0.59.0
- @fusion/i18n@0.39.24
- @fusion-plugin-examples/cli-printing-press@0.1.41
- @fusion-plugin-examples/compound-engineering@0.1.24
- @fusion-plugin-examples/dependency-graph@0.1.55
- @fusion-plugin-examples/grok-runtime@0.2.2
- @fusion-plugin-examples/roadmap@0.1.43
- @fusion-plugin-examples/cursor-runtime@0.1.43
- @fusion-plugin-examples/droid-runtime@0.1.50
- @fusion-plugin-examples/hermes-runtime@0.2.74
- @fusion-plugin-examples/openclaw-runtime@0.2.74
- @fusion-plugin-examples/paperclip-runtime@0.2.74

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.59.0
- @fusion/dashboard@0.59.0
- @fusion/engine@0.59.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.59.0
- @fusion/pi-claude-cli@0.59.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.59.0

### @runfusion/fusion

#### Minor Changes

- 8b60181: summary: Add per-agent Assignment Policy; guard every task-routing path so liaison agents can never receive product tasks.
  category: feature
  dev: New `runtimeConfig.assignmentPolicy` ("auto" | "explicit-only" | "none") enforced via shared `evaluateImplementationTaskBind` at `claimTaskForAgent`, the previously unguarded `checkoutTask`/`assignTask` primitives, `selectNextTaskForAgent` (including the in-progress re-selection branch), scheduler auto-assign pool, heartbeat auto-claim, `fn_delegate_task`, CLI agent-id validation, and dashboard assign/checkout routes. "none" is not bypassable by `override=true`/`executorRoleOverride`. Fixes Runfusion/Fusion#2015.
- 9bb7459: summary: Add a one-time banner announcing the upcoming SQLite→embedded-Postgres storage change.
  category: feature
  dev: New self-contained `StorageMigrationNoticeBanner` in the dashboard banner cluster; permanent dismissal via `localStorage` key `fusion:storage-migration-notice-dismissed`.
- bc30ce8: summary: Deliver plugin skill bodies to agent sessions and the Skills view.
  category: fix
  dev: Threads plugin skill discovery paths into sessions and reads plugin SKILL.md files from disk.
- 0c97c16: summary: Honor plugin skillFiles paths so plugin skills can live in category subdirectories.
  category: fix
  dev: Adds traversal-guarded plugin skill body path resolution and carries pluginRoot through skill discovery.
- 95a808a: summary: Artifact-registration mail notifications now show an inline preview and open link.
  category: feature
  dev: MailboxView/MailboxModal render a shared MailboxArtifactAttachment from message.metadata (artifactId/artifactType/mimeType) via artifactMediaUrl; notifyArtifactRegistered now also emits metadata.mimeType.
- 8884f50: summary: Add a Commit and Push button to the Git Manager commit form.
  category: feature
  dev: Adds a GitManagerModal commit-and-push handler that reuses createCommit and pushBranch.
- b77e123: summary: Let users define custom terminal shortcut buttons (label + injected sequence) from the terminal Preferences panel.
  category: feature
  dev: Adds a customShortcuts list to the client-local terminalPreferences (kb-terminal-preferences localStorage), a decodeTerminalShortcutSequence escape decoder (\n/\t/\r/\e/\x1b/\\), custom shortcut buttons in TerminalModal's shortcut panel injecting via the focus-preserving sendLiteralShortcut path, and add/edit/remove management UI in the preferences panel. Client-only; no server schema.
- a4dde88: summary: Storage update banner now has a Get help (Discord) button and notes project DBs move to the central Fusion database.
  category: feature
  dev: Adds `storageMigrationNotice.getHelp`/`getHelpLabel` i18n keys and a hardened Discord link in `StorageMigrationNoticeBanner`; revised body copy in `en/app.json` and component default.
- ee1d978: summary: Show user-defined custom terminal shortcuts in the embedded Task Detail terminal's mobile key bar.
  category: feature
  dev: SessionTerminal now reads the shared terminalPreferences.customShortcuts (FN-7872, kb-terminal-preferences localStorage) and renders each as a mobile accessory-bar button that injects decodeTerminalShortcutSequence(value) via the focus-preserving keepFocus + sendInput path, clearing sticky Ctrl; buttons update live on the storage event and are suppressed in read-only/replay sessions. Mobile-only; no new store; TerminalModal and the preferences helper are unchanged.
- c745990: summary: Deliver a one-time inbox notice about the upcoming Postgres storage migration on first 0.59 startup.
  category: feature
  dev: New best-effort, idempotent `deliverPostgresMigrationNoticeIfNeeded` in `@fusion/engine`, invoked from `ProjectEngine.start()`; gated to version `0.59.x` via injected `cliPackageVersion` (threaded through `EngineManagerOptions`/`ProjectEngineOptions`); idempotency via inbox `metadata.kind = "postgres-migration-notice"` marker. Links to Discord (`https://discord.gg/ksrfuy7WYR`).
- 23cb061: summary: Change a chat's thinking level mid-conversation from the composer
  category: feature
  dev: Extends `PATCH /api/chat/sessions/:id` with an optional `thinkingLevel` field (validated via existing `validateThinkingLevel`); adds `useChat().setSessionThinkingLevel` and the new `ChatThinkingLevelControl` component (Brain-icon trigger + popover) wired into `ChatView`'s direct-session composer, gated to non-CLI model-loop sessions only.
- 635d782: summary: Add per-step Thinking Level controls to schedule and routine AI actions.
  category: feature
  dev: Adds AutomationStep.thinkingLevel persistence and route validation; runtime application is tracked separately.
- 7a51f95: summary: Add a persisted Thinking Level selector for manual insight generation.
  category: feature
  dev: Threads insight run thinkingLevel through dashboard API metadata and retry generation.
- 9f8db7d: summary: Schedule and routine AI steps now apply the chosen thinking level at run time.
  category: feature
  dev: Threads AutomationStep.thinkingLevel into createFnAgent (defaultThinkingLevel) across cron-runner, routine-runner, and the dashboard inline ai-prompt path, and maps it onto create-task steps' task thinkingLevel (FN-7903, follow-up to FN-7900).
- 03bca17: summary: Add a project Chat default (model or agent) with prompt-each-time or always-use-default New Chat behavior.
  category: feature
  dev: Adds project chatNewSessionMode/chatDefaultKind/chatDefaultAgentId/chatDefaultModelProvider/chatDefaultModelId/chatDefaultThinkingLevel settings, a Project Models "Chat" subsection, and a shared ChatView handleNewChat() flow.
- 8835c6c: summary: Switch an active chat's model or agent mid-conversation from the brain-icon popup.
  category: feature
  dev: Extends PATCH /api/chat/sessions/:id with validated modelProvider+modelId and agentId, adds chat-store updateSession agentId clause, useChat.setSessionModel, and a Model/Agent section in the brain popup (ChatThinkingLevelControl).
- daf3f15: summary: Add a Chat Room thinking-effort override for all room responders.
  category: feature
  dev: Adds chat_rooms.thinkingLevel persistence, API/client wiring, and room responder defaultThinkingLevel resolution.
- 1ea185d: summary: Add `fn workflow validate` to dry-run a custom workflow IR without creating or mutating it.
  category: feature
  dev: Adds the `fn_workflow_validate` agent tool, `POST /api/workflows/validate`, and the `fn workflow validate <id> | --file <path>` CLI command. Reuses the same parseWorkflowIr/trait/code-node/column-agent validation as create/update; performs no persistence.
- 3326984: summary: Add `fn plugin publish --dry-run` preflight that validates a plugin before publishing.
  category: feature
  dev: New `runPluginPublish`/`collectPluginPreflight`/`classifyVersionBump` in packages/cli/src/commands/plugin-publish.ts; reuses loadManifestFromPath + resolvePluginEntryFile. Non-mutating; no registry/network calls.
- 2aefaad: summary: Artifact-registration mail notifications now include a "View task" link to open the producing task.
  category: feature
  dev: MailboxArtifactAttachment renders a metadata-driven View-task affordance (message.metadata.taskId + onOpenTask); MainContent wires MailboxView's onOpenTask via fetchTaskDetail -> openDetailTask.
- 9ba8a2e: summary: Add separate Reviewer and Planning thinking-level selectors on task details.
  category: feature
  dev: Adds validatorThinkingLevel and planningThinkingLevel task fields with runtime lane fallback to task.thinkingLevel.
- c110b72: summary: Add persisted thinking-level controls to Mission Interview and Planning mode.
  category: feature
  dev: Threads optional thinkingLevel through mission/planning session inputPayload, routes, clients, and agent defaults.
- edfe57c: summary: Release notes open with AI Highlights, and the release script prints a ready-to-post engagement tweet.
  category: feature
  dev: distillReleaseNotes calls `claude -p --model sonnet` for Highlights + notes + ≤280-char X draft (engagement-oriented, varies per release); soft deterministic fallback if Claude is offline. release.mjs prints the draft after publish and on --dry-run.
- a227b19: summary: Add Command Center System controls (rebuild & restart, engine/agent restarts, backups, live logs) and a Plugins tab.
  category: feature
  dev: New `/api/system/*` routes gated by `ServerOptions.systemControl`/`systemLogs`; `fn dashboard` is now supervised by default (attached foreground child, `--no-supervise` opts out) and restart uses `FUSION_RESTART_EXIT_CODE` (86) honored by the supervisor, `scripts/dev-with-memory.mjs`, and Electron `app.relaunch()` on desktop; rebuild controls only render from a source checkout; new Command Center "Plugins" tab reuses PluginManager.
- b983149: summary: Add thinking-level controls to agent and bulk task model selectors.
  category: feature
  dev: Dashboard agent detail/onboarding model pickers and List bulk model updates now persist thinkingLevel.

#### Patch Changes

- c4fad2d: summary: Agents now auto-recover from transient OAuth token-rotation 401 errors instead of parking for operator action.
  category: fix
  dev: Adds `isTransientAuthCredentialError` to the shared transient-error classifier (401 `authentication_error` / "Invalid authentication credentials" / token-expired shapes are transient and not operator-actionable; OAuth scope-grant and API-key failures still park). Heartbeat prompts now run under `withRateLimitRetry` so mid-run token rotations retry in-run. Heartbeat failure classification uses the error message instead of the stack-bearing detail. Self-healing un-parks agents previously paused with `error-unrecoverable` whose lastError now classifies recoverable.
- 382a4d5: summary: Center the Chat composer attach and model icons with the message input box.
  category: fix
  dev: ChatView.css sizes .chat-attach-btn and .chat-thinking-level-root to --chat-input-control-size so they center with the single-line input across desktop/tablet/mobile while staying bottom-aligned when multi-line (FN-7917).
- d4bbbcc: summary: Ideas-intake cards no longer auto-process on restart; replan and Retry work from Todo; All-workflows shows every card.
  category: fix
  dev: Store init records a `store:open` run-audit provenance stamp (pid/ppid/execPath/entry/cwd/node version) so mystery DB mutations are attributable to their process; init also now always runs the workflow-aware integrity pass instead of the retired flag-off evacuation (`evacuateCustomColumnsToLegacy` remains toggle-only), with a mis-mapping guard so stale selections are never physically rehomed into auto-triaged lanes; engine replan/stale-spec/fs-validation rebounds resolve `resolveReplanTargetColumn` instead of hardcoding `triage`; `needs-replan` counts as unplanned for hold-release dispatch; triage discovers `needs-replan` todo cards and refinement seed prompts via `isUnplannedSeedPrompt`/`buildRefinementSeedPrompt`; Board's aggregate grouping renders column-orphaned tasks (hidden columns stay hidden) and the FN-7591 refetch also fires on present-but-unrepresentable mappings.
- 0a74059: summary: Update the dashboard TUI splash tagline to "software factory".
  category: fix
  dev: FUSION_TAGLINE in packages/cli/src/commands/dashboard-tui/logo.ts changed from "multi node agent orchestrator" to "software factory"; smoke-test assertion updated to match.
- e559b2b: summary: Keep chat history stable while an agent is mid-turn so prior user and agent messages no longer flicker away.
  category: fix
  dev: useChat mid-turn message stability — intermediate chat:session:updated / tool-call / streaming events no longer blank or reflow the rendered `messages` thread (FN-7853, sibling of FN-6496/FN-6599 reattach fixes).
- 139ae7e: summary: Agent chat exposes the same tools on desktop and browser; messaging tools no longer silently drop.
  category: fix
  dev: Project-scoped chat (getOrCreateScopedChatManager/resolveScopedChatManager) now wires and refreshes the engine MessageStore, mirroring setPluginRunner, so fn_send_message/fn_read_messages survive lazy engine boot; a reduced-tool-schema condition now emits a diagnostic/agent-visible signal instead of failing silently per call (FN-7854).
- 729298f: summary: Reloading a path-registered plugin now refreshes its version and settings schema.
  category: fix
  dev: PluginLoader.loadPlugin/reloadPlugin reconcile persisted version/settingsSchema from the freshly-imported manifest (generalizing the bundled-plugin refresh); PluginUpdateInput/updatePlugin now accept settingsSchema. Preserves per-project enablement and setting values. FN-7855.
- c13d2ee: summary: Per-project plugin-skill toggles now apply to agent sessions, not just the Skills view.
  category: fix
  dev: collectPluginSkillNames now resolves effective enablement via the shared @fusion/core resolver (getSkillSettingState), matching discoverSkills; fixes issue #2016 (FN-7858).
- 67cc025: summary: Agent inspection tools now show why agents are in error or paused.
  category: fix
  dev: fn_agent_show and fn_list_agents surface lastError, pauseReason, and recovery counters for error/paused agents. Durable non-recoverable heartbeat errors are parked paused with error-unrecoverable and emit agent:error-parked-unrecoverable instead of sitting indefinitely in bare error.
- 20c6db9: summary: Unpausing (and pausing) a task now updates the board immediately.
  category: fix
  dev: useTasks pauseTask/unpauseTask patch shared task state + SWR cache on API success (FN-7861), mirroring retryTask/bypassReview; no longer waits for SSE/poll.
- b8c18be: summary: Make artifact preview popups full-screen sheets on mobile.
  category: fix
  dev: Adds mobile CSS and a CSS-contract regression test for artifact FloatingWindow viewers.
- ad3d26d: summary: Restore reliable mobile header dragging for movable floating modals.
  category: fix
  dev: Reasserts the FloatingWindow mobile touch-action contract and covers touch pointer dragging.
- 9905832: summary: Fix cramped spacing on the Command Center System tab (logs and controls).
  category: fix
  dev: System tab now wraps SystemControlsArea + SystemStatsArea in a flex container so all sections share the --space-lg rhythm; adds a gap after Server logs.
- 504dc69: summary: Durable agents retry generic heartbeat failures instead of parking as unrecoverable on first error.
  category: fix
  dev: `isHeartbeatErrorRecoverable` now gates on operator-actionable and stale-module errors rather than requiring a transient-pattern match.
- 56c7452: summary: Shorten the Settings "Reset Settings" button to "Reset" on mobile.
  category: fix
  dev: SettingsModal reset button now uses settings.reset.buttonShort at viewportMode==="mobile"; confirmation dialog unchanged.
- b84bd11: summary: Keep the System tab refresh button inline with its title and far right on mobile.
  category: fix
  dev: Scopes a cc-system-controls-header row+space-between override so the shared .cc-area-section-header mobile column collapse no longer pushes the refresh button below the title.
- e92a342: summary: Fix "Copy diagnostics" crash on non-secure origins (mobile/HTTP).
  category: fix
  dev: Command Center System tab now routes diagnostics copy through copyTextToClipboard (secure-context guard + execCommand fallback) instead of navigator.clipboard.writeText, which was undefined outside secure contexts.
- 2e7fce2: summary: Durable agents in error state are cleared and retried automatically on engine restart.
  category: fix
  dev: New SelfHealingManager.resetDurableAgentErrorStateOnStartup() runs first in runStartupRecovery(): it resets the shared heartbeatErrorRecovery/durableErrorRecovery budget+cooldown, clears lastError, flips eligible error and error-retry-exhausted-parked durable agents to active, re-arms the heartbeat, and emits agent:reset-error-state-on-startup — bypassing the steady-state staleness/cooldown/exhaustion gates while preserving operator-actionable / stale-module / user-paused / error-unrecoverable suppression (FN-7884).
- 6ea5396: summary: Fix copy actions crashing or mis-reporting on non-secure origins (mobile/HTTP).
  category: fix
  dev: Migrated remaining dashboard copy handlers (agent id, secrets, git manager, CLI binary, PR conflicts, stash ref, login instructions, agent-error modal) and the reports plugin share-blocks panel from direct navigator.clipboard.writeText to the shared copyTextToClipboard helper (secure-context guard + execCommand fallback, boolean result handling). Added ./app/utils/copyToClipboard subpath export from @fusion/dashboard.
- db9a945: summary: Fix chat "Copy response" falsely reporting failure on non-secure origins (mobile/HTTP).
  category: fix
  dev: Migrated ChatView handleCopyResponse from direct navigator clipboard access to the shared copyTextToClipboard helper (secure-context guard + execCommand fallback, boolean-driven success/error feedback), the last direct clipboard caller found during the FN-7885 preflight.
- ddf2f3d: summary: Restore task deletion from the right-dock Tasks list.
  category: fix
  dev: Threads the shared delete handler through right-dock task-card hosts and adds regression coverage for delete menu activation.
- 02fdb4c: summary: Fix pinned terminal rendering underneath the status footer.
  category: fix
  dev: `.terminal-below-host` now reserves `--executor-footer-height` via a new `footerVisible` prop + `.terminal-below-host--with-footer` CSS modifier (matching `.project-content--with-footer`/`.left-sidebar-nav--with-footer`/`.right-dock--with-footer`), so the pinned/below terminal panel no longer sits underneath the fixed `ExecutorStatusBar`.
- 41168e2: summary: Chat thinking-level Default entries now show the real project default.
  category: fix
  dev: ChatView fetches Settings.defaultThinkingLevel for New Chat and ChatThinkingLevelControl labels.
- 313956d: summary: Fix the in-chat model selector on tablet and mobile.
  category: fix
  dev: The brain popup's pointerdown outside-close now treats the portaled CustomModelDropdown menu (.model-combobox-dropdown--portal) as inside, so a model tap registers instead of closing the popup; ChatView.css re-anchors the mobile popover to fit the viewport. CustomModelDropdown is unchanged.
- e84fda9: summary: Make Chat go-to-top contextual and inline, with the edit pencil compact beside timestamps.
  category: feature
  dev: StandardChatMessageItem gains an isTopClipped prop; ChatView measures clipped message tops on scroll to gate go-to-top visibility. Edit pencil moved from a standalone row into the timestamp footer.
- 87aab43: summary: Fix jerky tablet drag for the terminal and other movable modals.
  category: fix
  dev: Reassert drag-handle `touch-action: none` coverage for headerless floating-window delegates and test the tablet touch-drag contract across movable modal surfaces.
- 30d2e36: summary: Keep the task refinement feedback dialog open after selecting Refine.
  category: fix
  dev: Routes the nested Task Detail refine overlay through useOverlayDismiss and adds regression coverage.
- 2956002: summary: Fix the in-chat model/thinking popup being cut off inside a narrow floating Chat window.
  category: fix
  dev: The popover's viewport-fitting inset is now keyed on ChatView's .chat-view--narrow class (surface width, incl. floating window / compact dock) instead of only @media (max-width: 768px) (browser viewport), so a narrow floating Chat window on a wide viewport no longer clips the popup. CustomModelDropdown is unchanged.
- 1f9dcea: summary: Mailbox artifact "View task" now opens the same movable, resizable task window used elsewhere.
  category: fix
  dev: MainContent mailbox onOpenTask routes fetchTaskDetail -> popOutTaskDetail (floating-window--task-detail) instead of the docked openDetailTask modal, matching DocumentsView's artifact-task path.
- b10f823: summary: Task card priority badges now show icon-only so they no longer wrap to a new line.
  category: fix
  dev: Updates the board TaskCard priority badge to keep labels in title, aria-label, and visually-hidden text.
- 23c732b: summary: Keep project MCP tools available across fresh executors and approval resumes.
  category: fix
  dev: Executor MCP bootstrap now fails with sanitized diagnostics and resumes approved calls exactly once.
- f23619c: summary: Pausing an in-progress task now sticks — the pause survives session teardown instead of auto-resuming.
  category: fix
  dev: New `preservePause` moveTask option; the executor pause teardown passes it so the todo re-queue keeps `paused`/`pausedByAgentId`/`pausedReason`. The graph-failure classifier now labels a preserved task pause as operator intent (never "engine abort during pause/resume" auto-continue), and the benign re-queue log says "parked … awaiting explicit unpause" for paused rows.
- 27110ed: summary: Remove the "Connected" label and shortcut help text from the terminal footer.
  category: fix
  dev: Drops the terminal footer helpText locale key and orphaned shortcut CSS.
- 5f43297: summary: Fix terminal workspace drop-down rendering behind the floating terminal modal.
  category: fix
  dev: Keeps the portaled TerminalModal workspace picker above floatingZ and hidden until positioned.

### runfusion.ai

#### Patch Changes

- Updated dependencies [8b60181]
- Updated dependencies [c4fad2d]
- Updated dependencies [382a4d5]
- Updated dependencies [d4bbbcc]
- Updated dependencies [0a74059]
- Updated dependencies [9bb7459]
- Updated dependencies [e559b2b]
- Updated dependencies [139ae7e]
- Updated dependencies [729298f]
- Updated dependencies [bc30ce8]
- Updated dependencies [c13d2ee]
- Updated dependencies [67cc025]
- Updated dependencies [0c97c16]
- Updated dependencies [20c6db9]
- Updated dependencies [95a808a]
- Updated dependencies [b8c18be]
- Updated dependencies [8884f50]
- Updated dependencies [b77e123]
- Updated dependencies [ad3d26d]
- Updated dependencies [a4dde88]
- Updated dependencies [ee1d978]
- Updated dependencies [9905832]
- Updated dependencies [504dc69]
- Updated dependencies [c745990]
- Updated dependencies [56c7452]
- Updated dependencies [b84bd11]
- Updated dependencies [e92a342]
- Updated dependencies [2e7fce2]
- Updated dependencies [6ea5396]
- Updated dependencies [db9a945]
- Updated dependencies [ddf2f3d]
- Updated dependencies [02fdb4c]
- Updated dependencies [23cb061]
- Updated dependencies [635d782]
- Updated dependencies [7a51f95]
- Updated dependencies [9f8db7d]
- Updated dependencies [41168e2]
- Updated dependencies [03bca17]
- Updated dependencies [8835c6c]
- Updated dependencies [daf3f15]
- Updated dependencies [1ea185d]
- Updated dependencies [3326984]
- Updated dependencies [313956d]
- Updated dependencies [e84fda9]
- Updated dependencies [87aab43]
- Updated dependencies [2aefaad]
- Updated dependencies [30d2e36]
- Updated dependencies [2956002]
- Updated dependencies [1f9dcea]
- Updated dependencies [b10f823]
- Updated dependencies [23c732b]
- Updated dependencies [f23619c]
- Updated dependencies [9ba8a2e]
- Updated dependencies [c110b72]
- Updated dependencies [edfe57c]
- Updated dependencies [27110ed]
- Updated dependencies [a227b19]
- Updated dependencies [5f43297]
- Updated dependencies [b983149]
  - @runfusion/fusion@0.59.0

## 0.58.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.58.0
- @fusion/engine@0.58.0
- @fusion/i18n@0.39.23
- @fusion-plugin-examples/cli-printing-press@0.1.40
- @fusion-plugin-examples/compound-engineering@0.1.23
- @fusion-plugin-examples/dependency-graph@0.1.54
- @fusion-plugin-examples/grok-runtime@0.2.1
- @fusion-plugin-examples/roadmap@0.1.42
- @fusion-plugin-examples/cursor-runtime@0.1.42
- @fusion-plugin-examples/droid-runtime@0.1.49
- @fusion-plugin-examples/hermes-runtime@0.2.73
- @fusion-plugin-examples/openclaw-runtime@0.2.73
- @fusion-plugin-examples/paperclip-runtime@0.2.73

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.58.0
- @fusion/dashboard@0.58.0
- @fusion/engine@0.58.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.58.0
- @fusion/pi-claude-cli@0.58.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.58.0

### @runfusion/fusion

#### Minor Changes

- 6317fcd: summary: Add an interactive worktree-rooted Terminal tab to the task detail view.
  category: feature
  dev: TaskDetailModal embeds TerminalModal in a new `embedded` mode; useTerminalSessions gains task-scoped storage + defaultCwd. The pre-existing agent-session tab is relabeled "Session".
- 17d7bd1: summary: The Task Detail Terminal tab is now always available, falling back to the project root when a task has no worktree.
  category: feature
  dev: Relaxes the TaskDetailModal `showWorktreeTerminalTab` gate to always render and passes `defaultCwd` = worktree when present else undefined (project-root auto-create via useTerminalSessions). Covers no-worktree and multi-repo workspace tasks. Sessions stay task-scoped via `scopeId`.
- f10c39f: summary: Agents can now add files to a task's File Scope while working, so out-of-scope edits aren't stranded at merge.
  category: feature
  dev: New `fn_task_file_scope_add` executor tool (packages/engine/src/agent-tools.ts, wired in executor.ts) appends validated repo-relative paths/globs to the `## File Scope` section of PROMPT.md and persists via `store.updateTask({ prompt })` (same validation + task.json/PROMPT.md sync as `fn_task_prompt_write`). Entries are validated with `isValidFileScopeEntry` and de-duplicated; the base executor prompt now instructs the agent to call it when editing beyond the declared scope. Does not re-run the merge-time peer-claim refusal — the squash file-scope invariant remains the cross-task backstop.
- 9024f3a: summary: Agents save screenshots, videos, HTML mockups, and PDFs as artifacts, shown in a new category gallery with doc editing.
  category: feature
  dev: fn_artifact_register gains a `path` payload source (file copied into managed storage, MIME inference, image/video/PDF signature validation) and is now always exposed to executor sessions (previously missing in ephemeral mode) with worktree-relative path resolution and executing-task default taskId; executor/planning prompts instruct agents to register visual/media deliverables (images, videos, HTML mockups, PDFs); the media route serves HTTP byte ranges for video/audio seeking; video attachments (100MB cap) bridge into the registry like images; HTML docs render as live sandboxed previews; new `GET`/`PATCH /api/artifacts/:id` routes plus `TaskStore.updateArtifact` and the `artifact:updated` SSE event power in-place doc editing in the new ArtifactsGallery (Images/Docs/PDFs/Videos/Audio/Other sections with per-category viewers, mobile-responsive); viewers open in draggable/resizable FloatingWindows, Artifacts is the first/landing tab of the view, and mobile tab buttons render at the uniform 44px control height.
- 05d30ff: summary: Edit task documents and project files in the Artifacts view; markdown by default; fix the Add comment button.
  category: feature
  dev: DocumentsView embeds the shared CodeMirror FileEditor for task-document (PUT /tasks/:id/documents/:key) and project-file (project workspace file API) edits. The Add comment no-op was a CSS bundle-order regression — `.btn:active` out-ordered the equal-specificity trigger rule; the `:active` rules now use `.btn.selection-comment-trigger` (0,3,0) with a test asserting the prefix.
- 19055c6: summary: Add a persistent Advanced settings toggle that keeps uncommon Settings sections and controls hidden by default.
  category: feature
  dev: The browser-local disclosure applies to navigation, search, and field-level controls without changing saved settings.
- f66bfae: summary: Guide repeatable Compound Engineering cycles from product grounding through reusable learnings.
  category: feature
  dev: Adds project-scoped sessions, collection-aware stages, Work quality gates, and terminal Compound progression.
- 84fb513: summary: Add persisted thinking-level settings for every fallback model lane.
  category: feature
  dev: New optional ThinkingLevel keys — global `fallbackThinkingLevel`, workflow `planningFallbackThinkingLevel`/`validatorFallbackThinkingLevel`, project `titleSummarizerFallbackThinkingLevel`. Schema foundation only; no runtime/UI consumption yet.
- 7fe18df: summary: Cursor CLI models now appear in Fusion's model picker when the Cursor CLI provider is enabled.
  category: fix
  dev: /api/models additively merges `cursor-agent` model discovery under the `cursor-cli` provider via a short-TTL, single-flight cache (no per-request CLI spawn), and adds `cursor-cli` to configuredProviders when useCursorCli is on so the rows survive the final provider filter. Rows are deduped by provider/id and never displace existing entries. Pattern mirrors FN-7636 (Hermes).
- 081dae0: summary: Add Grok CLI runtime support as a bundled plugin with a grok-cli model provider.
  category: feature
  dev: New plugin fusion-plugin-grok-runtime (auto-installed); settings useGrokCli/grokCliBinaryPath; routes /auth/grok-cli + /providers/grok-cli/status; grok-cli merged into /api/models.
- 21d1201: summary: Mobile Settings search row now collapses by default with a show/hide toggle.
  category: feature
  dev: SettingsModal mobile-only searchRowExpanded state + toggle icon; desktop unchanged.
- 626e002: summary: Add a policy-gated review-lane bypass for cards stranded by a failed pre-merge review step.
  category: feature
  dev: Adds the operator-only `fn_task_bypass_review` CLI/pi-extension tool, `POST /tasks/:id/bypass-review` dashboard API route, `store.bypassFailedPreMergeReviewStep(id, { reason, actor })`, `task-merge.ts` `getLatestFailedPreMergeReviewStep`, and `bypassedBy`/`bypassedAt`/`bypassReason`/`bypassedFromStatus`/`bypassedFromVerdict` `WorkflowStepResult` fields. Not exposed to executor/reviewer/triage agent tool lists.
- 171aaa2: summary: Grok can now run through the Grok CLI's NDJSON stream, so CLI-authenticated setups need no Fusion-visible API key.
  category: feature
  dev: GrokRuntimeAdapter.promptWithFallback now spawns `grok --prompt --format json`, parses the NDJSON event stream (new src/stream-parser.ts, fixture-tested), and drives onText/onThinking — replacing the FN-7715 no-op. Direct xAI OpenAI-compatible path (FN-7711/FN-7714) is unchanged and remains the default; end-to-end runtimeHint="grok" routing is a follow-up. Contract captured in docs/grok-cli-contract.md.
- 1fc615d: summary: Grok CLI runtime now bridges tool execution events (name/args/result) from the NDJSON stream, not just text.
  category: feature
  dev: GrokRuntimeAdapter.promptWithFallback now bridges tool_use NDJSON events into onToolStart/onToolEnd; tool name/args/result pass through unchanged (no Grok→pi name mapping — the verified docs/grok-cli-contract.md schema does not pin a tool-name vocabulary). step_finish/error remain non-terminal per-step events and are not bridged to a callback; only subprocess close/error finalizes, unchanged from FN-7722. Fixture-tested (no live binary). End-to-end runtimeHint="grok" routing remains FN-7725's scope; the direct xAI path (FN-7711/7714) is unchanged.
- e5c3ffb: summary: Grok work can now be routed through the Grok CLI streaming runtime, not only the direct xAI endpoint.
  category: feature
  dev: FN-7725 formalizes, tests, and documents the existing agent Runtime-mode picker path (option (a)) as the decided Grok CLI routing wiring — setting an agent's Runtime Source to "Runtime" -> "Grok Runtime" sets runtimeConfig.runtimeHint="grok", which the existing generic extractRuntimeHint -> resolveRuntime -> resolvePluginRuntime -> plugin factory chain (packages/engine/src/agent-session-helpers.ts, runtime-resolution.ts) already resolved to GrokRuntimeAdapter (FN-7722) for other plugin runtimes; no new engine/dashboard code was required, only a routing test (packages/engine/src/**tests**/grok-runtime-routing.test.ts), an FNXC decision note at the extractRuntimeHint seam, and documentation. Direct xAI OpenAI-compatible path (FN-7711/FN-7714) remains the default and is unchanged; the new path is additive/opt-in and does not preserve a specific grok-cli/\* model selection (documented limitation). Contract decision recorded in docs/grok-cli-contract.md.
- d44dbaa: summary: Add a dedicated permission for who may bypass a failed review gate, separate from task mutations.
  category: feature
  dev: Adds a new `review_gate_bypass` permission-policy category (packages/core/src/types.ts, agent-permission-policy.ts) governing `fn_task_bypass_review` (FN-7720). `fn_task_bypass_review` is classified into it in the shared `gating-classifications.ts` source and resolves identically in both `evaluateAgentActionGate` and the permanent-agent gate. Defaults to `require-approval` even under the `unrestricted` preset (stricter than the uniform preset default), while `approval-required`/`locked-down` presets already cover it uniformly. `toolRules.fn_task_bypass_review` exact overrides continue to apply on top. The dashboard permission-policy editor (project-default + per-agent override) renders the category as its own row. No DB migration required; a stored policy missing the key resolves to the preset default. The tool's CLI/pi-extension-only registration surface is unchanged.
- 0e90578: summary: Add a File Scope agent permission category, allowed by default under the grant-all preset.
  category: feature
  dev: Adds `file_scope` to AGENT_PERMISSION_POLICY_ACTION_CATEGORIES; uniform preset disposition (no review_gate_bypass-style override), classified via FILE_SCOPE_FN_TOOLS in both agent-action-gate and permanent-agent-gating.
- 9d7b087: summary: Update the pi SDK and add support for GPT-5.6 codex-tier models.
  category: feature
  dev: Bumps @earendil-works/pi-ai and @earendil-works/pi-coding-agent from ^0.80.3 to ^0.80.5 across packages/cli, packages/dashboard, packages/engine, and packages/pi-claude-cli (packages/droid-cli and packages/pi-llama-cpp's pi-coding-agent stay unpinned at `*` per existing convention). Inspected the installed SDK's generated model catalogs directly and found no `gpt-5.6-codex` id — OpenAI dropped the separate `-codex`-suffixed tier naming starting at the 5.4 generation. Added `openai-codex:gpt-5.6-luna`, `openai-codex:gpt-5.6-sol`, and `openai-codex:gpt-5.6-terra` pricing (the actual GPT-5.6 codenamed variants exposed by the SDK under the `openai-codex` provider) to `model-pricing.ts`, mirroring the existing `gpt-5.3-codex` rate, and bumped `pricingAsOf` to 2026-07-09 so Command Center token cost reports real cost instead of `unavailable` for these models.
- f930790: summary: GPT-5.6 codenamed models (luna, sol, terra) are now selectable in the model picker.
  category: feature
  dev: Adds mergeSupplementalOpenAiCodexModels in @fusion/core, invoked from GET /api/models alongside the Anthropic supplemental merge; additive and deduped against the pinned pi-ai catalog, gated by the configured openai-codex provider.
- 3cda9d8: summary: Add inline thinking-level selection to task and agent model dropdowns.
  category: feature
  dev: CustomModelDropdown now supports optional thinking-level props; migrated task and agent surfaces off standalone selects.
- 5f14a58: summary: Add per-lane thinking effort overrides to Settings model lane dropdowns.
  category: feature
  dev: Adds optional lane thinking settings and runtime precedence task > lane > global default.
- 235ff4c: summary: Add per-node workflow thinking-level controls for custom model bindings.
  category: feature
  dev: Workflow IR now round-trips config.thinkingLevel and runtime precedence is node/step > task > settings.
- df8ad46: summary: Add per-workflow model lane thinking-level controls for planning, execution, and review.
  category: feature
  dev: Adds execution/planning/validator workflow thinking settings and phase precedence threading.
- 035caca: summary: Choose a thinking level when starting a new model chat.
  category: feature
  dev: Adds chat_sessions.thinkingLevel and passes it as the engine defaultThinkingLevel session option.
- 57c3d7c: summary: Plugin prompt contributions can now gate content on per-project plugin settings.
  category: feature
  dev: PluginPromptContribution.condition is evaluated against effective plugin settings via a minimal `settings["key"] === "value"` / `!==` grammar (no eval); see docs/PLUGIN_AUTHORING.md.
- 5729fe2: summary: Let task edits toggle optional workflow steps directly.
  category: feature
  dev: TaskForm edit mode now loads optional-step catalogs from the resolved task workflow without defaultOn re-seeding.
- 03073af: summary: Show a Claude "Weekly (Fable)" usage window in the Usage dropdown.
  category: feature
  dev: usage.ts fetchClaudeUsage parses seven_day_fable (with tolerant fallback keys) and fetchClaudeUsageViaCli adds a "Current week (Fable" section; frontend renders it generically. API field name assumed seven_day_fable.
- de67b57: summary: Image attachments now appear in the Artifacts view as artifacts.
  category: feature
  dev: Bridges TaskStore.addAttachment image files into artifact rows with attachment-backed media URIs.
- fc4acd4: summary: Apply fallback models' own thinking levels when runtime swaps to them.
  category: feature
  dev: Adds fallbackThinkingLevel session plumbing, resolver precedence, and Grok CLI fallback remap handling.
- 3d5cc0a: summary: Add inline thinking-level selectors to every fallback model picker in Settings.
  category: feature
  dev: Binds fallback pickers (global Fallback Model, workflow planning/validator fallback lanes, project title-summarizer fallback) to the FN-7793 keys via CustomModelDropdown showThinkingLevel; save-split routes fallbackThinkingLevel (global) and titleSummarizerFallbackThinkingLevel (project) with null-as-delete parity.
- 595d323: summary: Artifacts view — Task Documents now uses a left-sidebar list with a right-pane content viewer.
  category: feature
  dev: DocumentsView Task Documents tab reuses the Project Files `documents-project-layout` sidebar/right-pane pattern with a separate selection state and desktop/mobile gating; the markdown/plain toggle is preserved. Select-to-comment stays Project-Files-only (tracked as a follow-up).
- 56b20a7: summary: Artifacts view — select text in a Task Document's content pane to comment and send it to a new task.
  category: feature
  dev: DocumentsView Task Documents right pane reuses the Project Files `useSelectionComment`/`SelectionCommentPopover` pattern (markdown + plain refs following the render toggle, composer-open lock, popover gated on the task-document selection + `onSendSelectionToTask`). Project Files behavior and the markdown/plain toggle are unchanged. Depends on FN-7811.
- bd0e99b: summary: Show a Grok (xAI) card in the Usage dropdown for configured Grok API keys.
  category: feature
  dev: usage.ts adds fetchGrokUsage (env GROK_API_KEY -> ~/.grok/user-settings.json -> grok-cli auth key) validating GET https://api.x.ai/v1/api-key and registered in fetchAllProviderUsage. xAI exposes no subscription usage meter to the inference key, so the card is auth-validity (ok/no-auth/error) with a real usage window only when confirmed data exists; no fabricated windows. Real usage field found: no — validity-only.
- d40f24d: summary: Show Cursor subscription usage in the Usage dropdown.
  category: feature
  dev: usage.ts adds fetchCursorUsage via Cursor Admin API POST https://api.cursor.com/teams/spend with Basic auth API_KEY:, resolving the Admin API key from documented env `CURSOR_ADMIN_API_KEY` (or `CURSOR_API_KEY` alias) before internal test/auth-storage fallbacks. It maps teamMemberSpend overallSpendCents/spendCents plus hardLimitOverrideDollars/monthlyLimitDollars and subscriptionCycleStart; fetchAllProviderUsage wraps it with withTimeout and no-auth demotion, while UsageIndicator maps "Cursor" to cursor-cli. No personal Cursor CLI usage endpoint confirmed; CLI session only supplies userEmail/subscriptionTier metadata.
- a2c9b0f: summary: Add a documented CURSOR_API_KEY credential path for Cursor usage metering.
  category: feature
  dev: usage.ts adds readCursorApiKey (CURSOR_API_KEY env var → cursor authStorage entry, mirroring readGrokApiKey); settings-reference.md documents it and clarifies cursor-cli runtime OAuth vs the usage/admin API key. Unblocks FN-7816. Cursor usage-API specifics confirmed via Cursor Admin API docs: POST /teams/spend with Basic auth using an admin:\* API key as the username.
- 9376504: summary: Add a Cost tab to task detail and an optional per-card cost badge (default off).
  category: feature
  dev: New shared taskTokenCost helper (read-time costFor derivation) powers the Summary tab, the new Cost tab, and a card badge gated by the default-off project setting showCostBadgeOnCards.
- 26f0c5a: summary: Add a resizable Settings navigation rail that remembers its width.
  category: feature
  dev: Removes the Settings rail divider and keeps nav labels single-line across modal and embedded Settings.
- cc743ee: summary: CLI agent cold-start timeouts now default to 2 minutes and are configurable.
  category: feature
  dev: Grok honors GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS; Droid honors PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS. Defaults raised 60000 → 120000. Inactivity ceilings unchanged.
- dd95634: summary: Artifacts view — the Task Documents list now also shows each task's registered artifacts.
  category: feature
  dev: DocumentsView Task Documents tab unions task documents with task-scoped artifacts per task group and adds an inline right-pane artifact viewer (image/video/audio/pdf/inline-doc/other) reusing getArtifactCategory + artifactMediaUrl/fetchArtifact. Selection is a discriminated document|artifact type kept separate from Project Files selection; the standalone Artifacts gallery tab is unchanged.
- d99c04c: summary: Add cost data for GLM-5.2, MiniMax-M3, and Kimi K2.6 so their token usage shows a dollar cost instead of "—".
  category: feature
  dev: Adds static MODEL_PRICING rows for zai:glm-5.2, minimax:MiniMax-M3, and kimi-coding:kimi-k2.6-preview (not covered by the LiteLLM refresh) and bumps pricingAsOf to 2026-07-11.
- 6267a76: summary: Drive Grok CLI sessions over ACP with Fusion tools, skills, and MCP loaded.
  category: feature
  dev: GrokRuntimeAdapter uses vendored ACP client under src/acp/ (not fusion-plugin-acp-runtime import), `grok agent stdio`, MCP/fn\_\* bridge, and Fusion skills via --plugin-dir / \_meta.pluginDirs.
- bcbd97c: summary: Add a simplified workflow editor view with a modern vertical canvas, plus Simple/Advanced/List mode toggle.
  category: feature
  dev: New WorkflowSimpleCanvas + WorkflowAddStepModal components; view mode persists in localStorage (`fusion:wf-editor-view-mode`, mobile `fusion:wf-mobile-graph-style`); insert-on-edge helpers live in workflow-simple-layout.ts. The old "Show simple editor" compact layout is now the List mode; the advanced canvas is unchanged.
- fc07bdf: summary: Task cards now show a "Reviewing" badge while a task is in Plan Review.
  category: feature
  dev: Adds isPlanReviewRunning(task) in taskProgress.ts; consumed by TaskCard + ListView status badges.
- 4edd8cc: summary: Usage dropdown now shows the Claude Fable weekly window and Grok CLI subscription credit usage.
  category: feature
  dev: Claude per-model weekly usage is parsed generically from the OAuth payload's `limits[]` scoped entries (the `seven_day_fable` key guess was disproven by a live probe); Grok prefers `~/.grok/auth.json` OIDC credentials against `cli-chat-proxy.grok.com/v1/billing?format=credits`, falling back to the xAI API-key validity card.

#### Patch Changes

- 79264d4: summary: Terminal now auto-reconnects on first launch instead of getting stuck on "Disconnected".
  category: fix
  dev: useTerminal tracks whether the socket has ever opened; a never-connected initial connect keeps retrying at capped backoff (staying "reconnecting") until it opens, while mid-session drops and 4000/4004 permanent closes are unchanged.
- 49faf0a: summary: Task Detail terminal now shows its worktree, is shorter on mobile, and sits with Cost after Comments.
  category: feature
  dev: TerminalModal defaults its workspace picker to the useWorkspaces entry matching `defaultCwd` (embedded task terminal only; footer terminal stays on Project Root). TaskDetailModal reorders the tab strip to Comments → Terminal → Cost and reduces the mobile min-height of `.detail-section--worktree-terminal`.
- 66e91f9: summary: Task card size badge (S/M/L) no longer drops onto a misaligned second row on cards with extra badges.
  category: fix
  dev: Groups the wrapping header status/meta badges in TaskCard so `.card-id` and the right-aligned `.card-header-actions` (holding `.card-size-badge`) stay on the top row; fixes the fast-mode (`.card-execution-mode-badge`) orphaned-size-chip case (FN-7832 repro).
- 9ac4da0: summary: Task card size badge (S/M/L) now sits flush against the card's right edge.
  category: fix
  dev: Renders `.card-size-badge` as the last child of `.card-header-actions` in TaskCard so its right margin equals the card's top padding (FN-7846).
- 409de31: summary: Stop false "Anthropic OAuth expired" notifications when the token is actually valid.
  category: fix
  dev: The OAuth expiry monitor and validity logger iterated the un-aliased `getOAuthProviders()` id `anthropic` and evaluated `get("anthropic")`, which can resolve to a stale legacy/supplemental row (e.g. `~/.pi/agent/auth.json`) even when the fresh, actually-used token lives under `anthropic-subscription`. Both now resolve the freshest of the two aliased ids via a shared `resolveEffectiveOAuthCredential` helper (mirroring the refresh scheduler's `getRefreshCandidateIds` alias handling), so a live subscription token suppresses the false alert. Notification cadence/throttle semantics are unchanged.
- f628095: summary: Fix the Artifacts preview "Add comment" button doing nothing when clicked, and label the preview as read-only.
  category: fix
  dev: The global `.btn:active { transform: scale(0.97) }` press feedback replaced the selection-comment trigger's positioning translate while the mouse was held, moving the button out from under the cursor so `click` never fired. `.selection-comment-trigger:active` now restates the translate (desktop and mobile), covering DocumentsView and FileEditor surfaces. The Artifacts project-file preview header also gains a `documents.readOnly` badge.
- 93b0801: summary: Fix a slow dashboard memory leak where archived tasks were never evicted from the in-memory badge cache.
  category: performance
  dev: The badge-snapshot cache (packages/dashboard/src/server.ts) only removed a task on hard-delete, so archiving a task re-cached it via the task:updated listener and it was retained for the daemon's lifetime — unbounded growth over long uptimes with task churn. A new `isBadgeEligibleTask` predicate (column !== "archived") gates both the create and update listeners so archived tasks are evicted, matching the startup prime's `includeArchived:false`. An unarchive re-primes the entry.
- ec1a2ea: summary: Tidy the board quick-add composer and add a visible task-card actions menu.
  category: fix
  dev: QuickEntryBox actions split into options/primary groups (Save right-aligned, single divider); TaskCard gains a hover/mobile-visible kebab that opens the existing TaskContextMenu.
- fbea66d: summary: Show partial estimated costs across all Command Center cost views when some model pricing is unavailable.
  category: fix
  dev: Priced subtotals use a trailing plus sign; entirely unpriced usage remains unavailable.
- 23e36b8: summary: Daemon exits non-zero on signal termination so Restart=on-failure restarts it after a memory-pressure kill.
  category: fix
  dev: `fn daemon` and `fn serve` (packages/cli/src/commands/daemon.ts, serve.ts) now exit with the POSIX 128+signal code (SIGTERM=143, SIGINT=130) on signal-initiated graceful shutdown instead of 0. Previously a memory-pressure SIGTERM produced exit 0, which `Restart=on-failure` treated as a clean stop, leaving the daemon dead. A deliberate `systemctl stop` still won't restart (systemd honors the requested inactive state regardless of exit code); a non-signal shutdown still exits 0. The interactive TUI launcher (`fn dashboard`) is intentionally unchanged — it has its own signal-name-keyed restart supervisor.
- 53427cd: summary: Prevent stale Planning notifications from pointing to missing sessions.
  category: fix
  dev: Background task sync now defers to the authoritative server session list.
- c565ceb: summary: Fix the GitHub/GitLab import preview panel being cut off on tablet-width screens.
  category: fix
  dev: The embedded Import Tasks view is container-query driven; the viewport `@media (max-width: 860px)` pane rules in GitHubImportModal.css were leaking `max-height: 50%` onto the embedded preview pane and are now scoped to `:not(.github-import-modal--embedded)`.
- d585edb: summary: Fix misaligned padding on the Cursor CLI authentication card.
  category: fix
  dev: Wraps `CursorCliProviderCard`'s compact status line + binary-path control in a padded `.cursor-cli-provider-card__body` to match the header inset, mirroring the Claude CLI card's `.auth-provider-cli-details-body`.
- bccb552: summary: Fix Cursor CLI model discovery and auth to use the real cursor-agent commands.
  category: fix
  dev: Switches model discovery to `cursor-agent models` (plain text `id - Label`, no `--json`/`model list` support) with header/tip/empty-state filtering, and derives auth from `cursor-agent status --format json` (`isAuthenticated`) instead of a `--version`-success heuristic.
- 639a706: summary: The Cursor CLI binary path override now also applies to the model picker, not just sign-in/status.
  category: fix
  dev: /api/models reads globalSettings.cursorCliBinaryPath (trim/blank→undefined) and threads it as getCursorPickerModels({ binaryPath }) so model-picker discovery spawns the same machine-local cursor-agent used by auth/probe/status. Blank/undefined preserves PATH auto-detection. Follow-up to FN-7696.
- 3e7e4a8: summary: Cursor CLI model-picker rows now surface reasoning/context-window metadata when the Cursor CLI reports it.
  category: feature
  dev: Threads optional reasoning/contextWindow from cursor-agent model discovery (structured JSON entries only) through discoverCursorProviderModels into cursorDiscoveryToModels, replacing the hardcoded false/0 defaults. Text-only CLI output (today's real behavior) still yields false/0, so the change is behavior-preserving against the current CLI and forward-compatible. Metadata is pass-through only — never fabricated or parsed from free text. Parallels the deferred Hermes enrichment gap (FN-7696/FN-7636).
- 22e7d75: summary: Fix the search icon overlapping typed/placeholder text in the Files — Project search input.
  category: fix
  dev: `.file-browser-search-input` `padding-left` was `calc(var(--space-lg) + var(--space-md))`, which collided exactly with the leading `.file-browser-search-icon`'s occupied width (`var(--space-sm)` offset + 16px icon) under the compact spacing theme. Padding is now anchored to the same `--space-sm` offset the icon uses, plus the icon's box width, plus a real gap, so clearance holds across all spacing scales for both the FileBrowser view and modal.
- 55dae49: summary: Fix `fn agent stop`/`fn agent start` hanging up to 60s per retry instead of exiting.
  category: fix
  dev: Root cause was non-deterministic CLI process exit, not a DB lock — `resolveProject()` cached an unclosed `TaskStore` and `createAgentStore()` never closed the `AgentStore` it opened, leaving SQLite handles alive after the command's real work finished. Added `resolveProjectPathOnly`/`closeProjectStore` in `project-context.ts` so path-only callers never leak a `TaskStore`, explicit `AgentStore.close()` on every exit/return path in `agent.ts` (since `process.exit()` does not run pending `finally` blocks), and a bounded fast-fail timeout around the state-store write (default 10s, override via `FUSION_AGENT_CMD_TIMEOUT_MS`) so a genuinely stuck operation fails fast with a clear error and non-zero exit instead of hanging.
- 4fb2bf5: summary: Background memory-index refresh no longer keeps short-lived CLI/Node processes alive.
  category: fix
  dev: The default qmd exec path in `packages/core/src/memory-backend.ts` now unrefs the spawned child + stdio (replacing `promisify(execFile)`, whose internal stream buffering silently re-refs the pipes on a deferred tick, with a hand-rolled `spawn()`-based executor) so a fire-and-forget `scheduleQmd*` refresh never blocks a caller's event loop from draining; long-lived callers (e.g. the dashboard server) still see the refresh resolve/reject normally.
- dcfbee9: summary: qmd-backed project memory search no longer keeps short-lived CLI/Node processes alive.
  category: fix
  dev: `searchWithQmd` in `packages/core/src/memory-backend.ts` no longer carries its own inline `promisify(execFile)` copy for the awaited `qmd collection add` / `qmd search` calls; it now routes through the FN-7706-hardened `getDefaultExecFileAsync()` spawn-based executor, which unrefs the child + stdio synchronously so a short-lived caller invoking a search is not held open by a slow/hung qmd child beyond its own work, while preserving the same `{stdout, stderr}` resolve / reject-on-nonzero-exit contract the search's JSON parsing depends on.
- 6606902: summary: Fix background SQLite integrity checks holding short-lived CLI commands open unnecessarily.
  category: fix
  dev: `integrityCheckSqliteFileAsync`'s spawned `sqlite3` child (+ stdio) is now unref'd via the shared `unrefQmdChildProcess` helper, and `scheduleBackgroundIntegrityCheck`'s 60s scheduling timer is now `.unref()`'d, so a short-lived process (e.g. a `fn` one-shot CLI command) that opens a disk-backed `Database` exits promptly instead of being pinned by the background integrity check (FN-7706/FN-7707-class leak). Audited every other non-FN-7708 inline spawn site across `@fusion/core`/`@fusion/engine`/`@fusion/dashboard`/cli and found them SAFE (synchronous, awaited-as-own-work, or intentionally-tracked persistent processes) — see FN-7709's audit document.
- 6cff782: summary: Grok and Cursor CLI models now appear in model pickers immediately after enabling the provider.
  category: fix
  dev: useModelsCache exposes a shared single-flight refreshModelsCache() that clears the SWR_CACHE_KEYS.MODELS cache and notifies subscribers; the Authentication CLI provider toggle (cursor-cli/grok-cli/claude-cli/llama-cpp) now calls it. Server-side cursor/grok picker caches use a short negative-TTL so transient cold-start empties self-heal.
- 7dc2710: summary: Grok CLI models now run instead of failing with "not found in the pi model registry".
  category: fix
  dev: Adds a built-in grok-cli provider (packages/core/src/grok-provider.ts) — xAI OpenAI-compatible endpoint https://api.x.ai/v1, api openai-completions, apiKey $GROK_API_KEY — registered into the execution registry (pi.ts registerExtensionProviders), seedDashboardProviders, and CLI serve/daemon/dashboard, mirroring the built-in Z.ai provider. Grok CLI binary remains discovery/probe only; GrokRuntimeAdapter streaming is still a stub (tracked follow-up).
- 2580524: summary: Fix Grok CLI model picker showing prompt text instead of real model names.
  category: fix
  dev: Rewrote parseModelLines in fusion-plugin-grok-runtime/process-manager.ts to strip the login/"Default model:"/"Available models:" preamble and `*`/`-` bullet markers plus the `(default)` annotation from verified `grok models` output; legacy `id - Label`, columnar, and JSON paths preserved.
- b2613b7: summary: Grok now uses the key from ~/.grok/user-settings.json when GROK_API_KEY is not set.
  category: fix
  dev: registerBuiltInGrokProvider (packages/core/src/grok-provider.ts) now hydrates process.env.GROK_API_KEY from ~/.grok/user-settings.json { apiKey } when the env var is unset/empty, so the provider's $GROK_API_KEY reference resolves. Env var always wins; missing/malformed/empty file is fail-soft (no throw, no env mutation). Mirrors the grok-runtime probe's fallback.
- 71e9f48: summary: Grok CLI no longer requires a Fusion-visible API key — the CLI's own auth is enough to enable it.
  category: fix
  dev: probeGrokBinary now derives `authenticated` from `grok` binary availability (readiness) instead of GROK_API_KEY/~/.grok/user-settings.json presence, mirroring the Cursor CLI provider; key detection is exposed as a non-blocking `apiKeyDetected` hint. The /auth/status grok-cli provider is authenticated when enabled + binary available; GrokCliProviderCard drops the blocking "Set GROK_API_KEY" state. The direct xAI streaming path still uses $GROK_API_KEY when present (FN-7711/FN-7714 unchanged).
- c8fcbec: summary: Archiving a task now releases its active-session lock so the next task can run Plan Review.
  category: fix
  dev: task:moved handler in packages/engine/src/executor.ts now disposes active surfaces and sweeps activeSessionRegistry paths for any move to the terminal "archived" column (previously only from==="in-progress"); done/in-review merge leases are deliberately untouched.
- cda9532: summary: Fix agents needing repeated stop/start because a stopped agent's heartbeat timer was never fully cleared.
  category: fix
  dev: HeartbeatTriggerScheduler.auditTimerRegistrations now unregisters lingering timers for non-eligible (stopped/paused/disabled) agents, and syncTimerForAgent force-re-arms a stale present timer on a start transition, so a stop/start durably clears the zombie-timer condition instead of deferring to the FN-7645 watchdog repair (FN-7718).
- a4931a4: summary: Triage recovers automatically when the planning model hits a provider 404/429 and no fallback is set.
  category: fix
  dev: TriageProcessor.specifyTask now derives an implicit fallback from the project/global default (execution) model when no planningFallback*/global fallback* pair is configured, so a retryable primary planner-model failure swaps once instead of failing triage with "no fallback configured". Test mode and self-swap are excluded; the single-swap ModelFallbackExhaustedError terminal path is preserved.
- a24b0fa: summary: Bound durable-agent heartbeat worktree-acquisition retries and count exhausted failures.
  category: fix
  dev: HeartbeatMonitor.executeHeartbeat's task worktree acquisition (agent-heartbeat.ts) previously requeued a task to "todo" on every acquisition failure with no cross-heartbeat retry cap, unlike Executor.createWorktree's bounded MAX_WORKTREE_RETRIES loop. Adds MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES (3), reusing Task.recoveryRetryCount as the counter (no schema migration). On cap exhaustion the task is terminally marked status:"failed" and a new onTaskAcquisitionExhausted callback is invoked; in-process-runtime.ts wires it to CentralCore.recordTaskCompletion(taskId, false) so the failure is counted (previously totalTasksFailed could stay 0 for this path). Investigation (FN-7721) found the other reported worktree-collision sub-gaps (branch-exists idempotent reuse, in-call retry cap, branch↔task-ID naming) already handled or not reproducing on HEAD — see task docs for evidence.
- e657d3b: summary: The engine now reacts to CLI `fn agent stop`/`start` promptly instead of waiting up to a minute for the audit sweep.
  category: fix
  dev: AgentStore gains opt-in cross-process change detection (fs.watch + poll fallback, modeled on TaskStore) that re-emits the existing agent:updated/agent:stateChanged events in the engine process when another process (the fn CLI) mutates an agent row, so HeartbeatTriggerScheduler's listeners fire without waiting for the 60s auditTimerRegistrations sweep. The audit sweep is retained as the durable backstop (FN-7723, follow-up from FN-7718).
- 927741a: summary: Preserve prior failed review-step attempts so self-healing re-runs no longer erase the failure history.
  category: fix
  dev: Adds an optional `priorAttempts?: WorkflowStepResult[]` field (bounded, single-level, capped at `MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS`) plus a shared pure `upsertWorkflowStepResult(existing, incoming, opts?)` helper in `@fusion/core` (`packages/core/src/workflow-step-results.ts`). Both engine recorders — the executor graph adapter's `recordWorkflowStepResult` and triage's `recordPlanReviewWorkflowResult` — now route through this helper instead of a bare replace-in-place upsert, so a self-healing recovery re-run of a failed pre-merge review node (code-review, plan-review, browser-verification) snapshots the prior `failed`/`advisory_failure` attempt into `priorAttempts` rather than overwriting it. Selection (self-healing, merge-blocker, progress/timing) is unchanged and reads only the current entry; `priorAttempts` is read-only history, surfaced in the task-detail Summary tab's Workflow results list as a collapsed "previous failed attempts" disclosure.
- 5a9f354: summary: Board mutations from a tool session no longer silently land in the wrong project database.
  category: fix
  dev: FN-7730. `packages/core/src/pi-extensions.ts`'s `getProjectRootFromGitLinkedWorktree` now resolves a linked worktree's project root from git's own on-disk `.git`/`commondir` metadata (pure filesystem reads) before falling back to the `git rev-parse` CLI. Previously, for a non-standard `settings.worktreesDir` location combined with a failing `git` invocation (missing binary, Docker "dubious ownership" `safe.directory` refusal, etc.), resolution silently fell through to the task's own locally-hydrated `.fusion/fusion.db` instead of the true project root, so `fn_task_update` and other pi-extension write tools wrote to a throwaway, never-synced-back copy with no error surfaced. See docs/storage.md "Silent board-mutation write loss (FN-7730)" for the full root-cause writeup.
- 7420abe: summary: `fn task show`/`move` now retry through a momentarily locked board database instead of failing.
  category: fix
  dev: CLI-level bounded exponential backoff gated on SQLite lock errors (override via FUSION_CLI_LOCK_RETRY_MS); resolved TaskStore now closed for deterministic exit.
- 6a13ad1: summary: Removed leftover UI/i18n/docs for the deleted "awaiting release authorization" planning hold.
  category: internal
  dev: FN-7732 — removes the residual release-authorization planning-block scaffolding left after the triage gate was deleted (b5b0458): the unemitted `task:release-authorization-required` activity type, the dead `isReleaseAuthorizationHold` TaskCard badge/label + CSS, orphaned i18n keys across all locales, and the stale solutions doc. The backward-compat `awaitingApprovalReason` DB column (migration 138) and the operator-only `scripts/lib/release-authorization-gate.mjs` publish guard are intentionally left intact.
- 1e79a23: summary: All `fn task` subcommands now retry a momentarily locked board database and exit promptly instead of hanging or leaking.
  category: fix
  dev: Generalizes the FN-7731 CLI retryOnLock + closeProjectStore pattern across the ~26 runTask\* handlers in packages/cli/src/commands/task.ts; honors FUSION_CLI_LOCK_RETRY_MS; closes both cached and uncached CWD-fallback stores; multi-step flows (create/retry/delete/merge/imports) retry each discrete write independently instead of the whole flow.
- bab42b4: summary: Recovery and oversight now wait for approval-blocked tasks instead of resuming them early.
  category: fix
  dev: Adds canonical `awaiting-approval` pause reason + `isTaskBlockedOnApproval` predicate; excludes the hold from paused-scope-decay rebound and keeps the planner overseer withholding (FN-7736).
- 86bd434: summary: `fn branch-group`/`fn pr` now retry a locked board database and exit promptly instead of hanging or leaking.
  category: fix
  dev: Applies the FN-7731 CLI retryOnLock + closeProjectStore pattern to packages/cli/src/commands/branch-group.ts and pr.ts (agent/node audited and left unchanged); honors FUSION_CLI_LOCK_RETRY_MS; closes both cached and uncached CWD-fallback stores on every exit path.
- 5304af8: summary: `fn backup`/`memory-backup`/`mcp`/`db vacuum` now retry a locked board database and exit promptly instead of hanging.
  category: fix
  dev: Applies the FN-7731/FN-7738 CLI retryOnLock + closeProjectStore/asLocalProjectContext pattern to packages/cli/src/commands/backup.ts, memory-backup.ts, mcp.ts, and db.ts; closes cached, uncached CWD-fallback, and ad-hoc MCP secrets TaskStores on every exit path; retries MCP settings writes and DB VACUUM; honors FUSION_CLI_LOCK_RETRY_MS. GlobalSettingsStore is file-backed and left unchanged.
- 4726af6: summary: CLI research/settings-import/agent-export/git/project commands close board stores promptly and retry a locked database.
  category: fix
  dev: Applies the FN-7731/FN-7738/FN-7704 CLI resolveProjectPathOnly + closeProjectStore/asLocalProjectContext + retryOnLock pattern to packages/cli/src/commands/research.ts, settings-import.ts, agent-export.ts, git.ts, and project.ts; path-only callers stop leaking the cached resolveProject TaskStore, getTaskCounts closes its per-project store, agent export closes its AgentStore, and importSettings/createExport retry FUSION_CLI_LOCK_RETRY_MS. The research non-wait fire-and-forget run path is intentionally exempted so it is not truncated; GlobalSettingsStore is file-backed and left unchanged.
- 2ff8e2e: summary: The planner overseer now detects and recovers stalled in-progress tasks instead of leaving hung executors stuck.
  category: fix
  dev: FN-7743 — the executor-stage overseer observation now emits `signal: "stuck"` once an in-progress task has been inactive past a configurable threshold (`plannerOverseerExecutorStuckAfterMs`), feeding the existing `decidePlannerRecovery` → bounded `inject_guidance` path. Previously a non-paused in-progress task was always reported `progressing`, so a hung executor was never recovered. Human-control withholds (user-paused / approval-blocked / autoMerge-off) still take precedence.
- 1fa4a69: summary: Harden the dashboard server so provider API keys keep persisting even if a host forgets to wire auth storage.
  category: fix
  dev: createServer() now derives a fallback authStorage from engine.getAuthStorage() (new ProjectEngine getter exposing its createFusionAuthStorage() instance) when options.authStorage is absent, mirroring the existing engine-derivation of onMerge/automationStore/etc. Explicit authStorage still overrides. Prevents regression of the desktop "keys don't persist / Authentication is not configured" gap (#1948); the desktop path's wrapped authStorage (FN-7622) is unchanged.
- 786a274: summary: Fix manual merge hold tasks being marked failed when auto-merge is off.
  category: fix
  dev: Adds benign manual-hold pause-abort classification and in-place self-healing recovery for auto-merge-off merge holds.
- eb377ba: summary: Manual merge hold now applies to shared-branch-group tasks whose group has dissolved.
  category: fix
  dev: `isLiveSharedBranchGroupMemberIntegration(task, group)` gates the shared-member auto-merge-off exemption on a live (`status: "open"`) branch group; a missing/finalized/abandoned group degrades to the standalone manual-hold path. Threaded through `project-engine.ts allowInReviewMergeProcessing` and the `executor.ts` merge gates. Fixes issue #1980 (FN-7750).
- 547740b: summary: Mobile Settings search icon now sits inline next to the section dropdown.
  category: fix
  dev: SettingsModal moves .settings-search-toggle into the .settings-mobile-section-picker row; desktop unchanged.
- 9ce0b49: summary: Tighten the mobile Settings layout — dropdown-only section picker, single-row footer, and slimmer header/footer.
  category: fix
  dev: SettingsModal mobile (≤768px) CSS/JSX only; section-picker label removed, aria-label preserves accessible name.
- f7c6f56: summary: Grok CLI models now run via the grok CLI when no Fusion-visible API key is set.
  category: fix
  dev: createResolvedAgentSession (packages/engine/src/agent-session-helpers.ts) auto-derives runtimeHint "grok" when defaultProvider is grok-cli, no GROK_API_KEY is Fusion-visible (new read-only isGrokApiKeyFusionVisible in packages/core/src/grok-provider.ts), and the Grok runtime is registered; the selected model is passed to the CLI via a new --model option on spawnGrokStream. Explicit runtime hints and the key-visible direct-endpoint default are unchanged. Closes the deferred FN-7722/FN-7725 follow-up.
- d2c2a4c: summary: The latest OpenAI GPT-5.6 models now appear everywhere, not just the Settings model list.
  category: fix
  dev: Wires mergeSupplementalOpenAiCodexModels into the engine pi createFnAgent registry-seeding surface (packages/engine/src/pi.ts) alongside the existing mergeSupplementalAnthropicModels call, mirroring register-model-routes.ts. FN-7745 only wired the dashboard /api/models route, so gpt-5.6-luna/sol/terra were absent on the pi surface. Additive, dedupe-safe; adds a pi-create-fn-agent regression test.
- 28c8233: summary: Update the bundled pi SDK to 0.80.6.
  category: internal
  dev: Bumps @earendil-works/pi-ai and @earendil-works/pi-coding-agent from ^0.80.5 to ^0.80.6 across cli/dashboard/engine/pi-claude-cli and regenerates pnpm-lock.yaml. Adds pi-claude-cli compatibility for the new max ThinkingLevel by mapping Opus models to CLI max and non-Opus models to high.
- b4b183f: summary: Fix empty estimated cost on the dashboard so priced runs show a dollar amount.
  category: fix
  dev: Root-caused model-identity → pricing-key resolution; cost stays read-time derived in costFor/token-analytics.
- 2be6040: summary: Route no-key Grok CLI chat and fallback model selections through the bundled CLI runtime.
  category: fix
  dev: Extends grok-cli no-visible-key routing to dashboard chat defaults, room responders, and fallback models.
- fed5d3d: summary: GPT-5.6 codex models (luna, sol, terra) now actually appear in the codex model picker.
  category: fix
  dev: Prior fixes (FN-7742/7745/7754) validated the openai-codex supplemental merge only against a mocked ModelRegistry, so gpt-5.6-luna/sol/terra could fail to reach the picker through the real pi-coding-agent registry (getAvailable() auth filtering + registerProvider full-replacement + OAuth provider validation) and/or the /api/models configuredProviders filter. This closes that gap and adds a real-registry regression test.
- 150227f: summary: Fix mobile model drop-down lists so they scroll by touch.
  category: fix
  dev: Adds the CustomModelDropdown portaled list mobile scroll contract.
- 18841d7: summary: Route Grok CLI models through the logged-in grok CLI in packaged hosts without requiring GROK_API_KEY.
  category: fix
  dev: Eagerly ensures the bundled Grok runtime in serve/daemon/dashboard and blocks silent direct-endpoint fallback when no key is visible.
- f6fd6ac: summary: Fix oversized icons and spacing on the MCP servers settings page.
  category: fix
  dev: McpServersCard inline lucide icons now use --icon-size-sm/md token values; .btn > svg is unsized globally so they previously fell back to lucide's 24px default.
- 059016e: summary: Fix Grok CLI chat failing instantly with a "Response failed" error.
  category: fix
  dev: ChatManager.sendMessage (packages/dashboard/src/chat.ts) now null-safely reads session.state.errorMessage/messages and falls back to the session's top-level messages + accumulated onText stream, so plugin-backed CLI runtime sessions (grok/droid/cursor) that expose no pi-shaped `state` render their reply instead of throwing "Cannot read properties of undefined (reading 'errorMessage')". pi/openclaw/hermes state.errorMessage failure bubbles are unchanged. Same fix applied to the room-responder session.state.messages read.
- 167067c: summary: Fix the Artifacts tab count for default-scope dashboards.
  category: fix
  dev: useArtifacts now fetches and subscribes when no projectId is available, matching the default /api/artifacts scope.
- 1ba588d: summary: Fix mobile Settings footer spacing so version text no longer overlaps actions.
  category: fix
  dev: Tightens the Settings modal mobile footer rail and adds CSS regression coverage.
- f9641ec: summary: Style the Thinking Level dropdown to match the dark model picker across all surfaces.
  category: fix
  dev: Adds a `.thinking-level-select` rule in CustomModelDropdown.css mirroring the canonical dark `select` tokens; fixes the OS-default white control shown in model pickers incl. the quick-add QuickEntryBox/InlineCreateCard popups. No logic/prop changes.
- 2758dde: summary: Fix Skills view showing "Skill not found" when opening any skill's content.
  category: fix
  dev: The /skills/:id/content and /skills/:id/file routes double-decoded the URL param (Express 5 already decodes route params once), corrupting the encoded source segment so the id no longer matched computeSkillId's discovery output. Routes now use the once-decoded canonical id (FN-7777).
- a32307f: summary: Plugin skills now show for the project that enabled them, even when the daemon starts elsewhere.
  category: fix
  dev: getPluginSkills is now project-aware — resolved per requesting rootDir against project_plugin_states instead of the daemon-root PluginLoader scope; plugins skipped as disabled are now logged at load time. Wired in dashboard.ts/serve.ts/daemon.ts. Strategy: B per-project resolution.
- 70330bc: summary: Show a No message placeholder for empty assistant chat replies.
  category: fix
  dev: Adds shared StandardChatSurface rendering and tests for empty assistant message bodies.
- ee796ee: summary: Grok CLI failures now show the actual error instead of an empty chat message.
  category: fix
  dev: GrokRuntimeAdapter.promptWithFallback now captures stderr, bridges NDJSON `error` events, and inspects the subprocess exit code. Any run that ends with no renderable content (missing/invalid GROK_API_KEY, bad flag, non-zero exit, missing `grok` binary, cold-start/inactivity hang, or a dropped `error` event) surfaces a diagnosable reason via `onText` rather than resolving into a blank bubble. A clean content-less exit (code 0, no stderr) stays silent. Fixes the root cause behind the FN-7779 "No message" placeholder.
- f5fd8b8: summary: Task cards no longer wrap the header when a task was created by an agent — the agent badge moved to a bottom row.
  category: fix
  dev: Moved `.card-agent-created-badge` out of `.card-meta-badges` into a new `.card-agent-badge-row` in TaskCard; updated the `hasCardMetaBadges` guard.
- 2e97395: summary: Surface Grok CLI runtime failures instead of empty chat replies.
  category: fix
  dev: Keeps Grok CLI prompt resolution non-throwing while waiting for child close to capture stderr diagnostics.
- 59a798b: summary: Fix Chat header showing thread controls while the conversation list is displayed after re-entering Chat.
  category: fix
  dev: On mobile remount, useChat/useChatRooms restore the active session/room while sidebarVisible resets true; mobile thread controls now key off actual pane visibility.
- 4d4e9ad: summary: Tighten margins and padding across all mobile Settings pages for a more compact layout.
  category: fix
  dev: SettingsModal mobile (≤768px) CSS only — reduced .settings-content and interior section spacing; desktop/tablet unchanged.
- cc8b1b6: summary: Estimated cost on the dashboard stays populated as runtime model catalogs drift.
  category: fix
  dev: Durable token-usage snapshot pricing for Team/Workflow analytics so cost survives empty legacy task model columns; cost stays read-time derived in costFor/token-analytics.
- 30bd779: summary: Surface Grok CLI immediate no-message exits with actionable diagnostics.
  category: fix
  dev: Treat code-0 zero-NDJSON grok headless runs as anomalous and stream diagnostics through runtime sessions.
- dd82a60: summary: Fix the Thinking Level dropdown showing an unstyled white control in model pickers.
  category: fix
  dev: Re-scopes .thinking-level-select from .model-combobox to the portaled .model-combobox-dropdown container.
- db9b9d2: summary: Fix Grok CLI runtime sends to stream responses from xAI's real grok binary.
  category: fix
  dev: Uses `grok -p --output-format streaming-json` and parses `thought`/`text`/`end` events.
- c258fc1: summary: Make Grok CLI chat replies reliable by using the stable headless JSON response.
  category: fix
  dev: Grok runtime now invokes `grok -p <prompt> --output-format json` and diagnoses empty non-EndTurn results.
- 7846c96: summary: Usage view now shows meters only for AI providers you have configured.
  category: fix
  dev: fetchAllProviderUsage() in packages/dashboard/src/usage.ts filters providers with no resolved credentials and no meterable entitlement (e.g. GitHub 404 "No Copilot subscription found" reclassified error→no-auth); configured-but-failing providers (auth expired / HTTP 5xx / timeout) remain visible.
- 725ce45: summary: Fix a false "Project directory is not a Git repository" error that blocked all task execution in valid repos.
  category: fix
  dev: Git detection is now tri-state (repo/not-repo/error) via detectGitRepository(); dubious-ownership/PATH/timeout git failures no longer masquerade as "not a Git repository". FN-7799.
- 915c1e0: summary: Show the xAI logo for Grok model IDs across dashboard provider surfaces.
  category: fix
  dev: ProviderIcon now falls back through inferProviderIconKey before the generic CPU icon.
- 21fb8f6: summary: Recover tasks stranded by missing worktrees during merge/review and allow retry.
  category: fix
  dev: Adds merge-active missing-worktree self-healing with no-action audits and signature-only retry resets across CLI, extension, and dashboard.
- 367f591: summary: Mobile Settings footer shows the compact "v0.x" version instead of the full word.
  category: fix
  dev: SettingsModal picks settings.footer.versionShort ("v{{version}}") when viewportMode === "mobile".
- 60b8b4e: summary: Quick-add composer now shows icon-only priority/Fast controls with GitHub tracking beside attach.
  category: feature
  dev: QuickEntryBox + TaskForm reuse a shared priorityIndicator glyph helper; GitHub + Priority relocated into .quick-entry-primary-group; no test-id/payload changes.
- c1b14c2: summary: Usage view now hides Gemini when it isn't configured for metering or its login has expired.
  category: fix
  dev: fetchGeminiUsage() in packages/dashboard/src/usage.ts reclassifies the unsupported-auth-type (api-key/vertex-ai) and HTTP 401/403 outcomes from error→no-auth so fetchAllProviderUsage omits Gemini; transient failures (HTTP 5xx/network/timeout) of a configured token remain visible as error.
- 281d1a3: summary: Fix the List view controls and quick-add box being cut off on tablet-width screens.
  category: fix
  dev: ListView collapses to a single-pane layout at the `useViewportMode()` "tablet" tier (769–1024px) instead of the desktop two-pane split, which lacked horizontal room and clipped the primary action cluster and expanded QuickEntryBox. Split-vs-single now keys off a shared narrow gate; touch-only long-press stays gated on mobile.
- 3da9da2: summary: Use the real Cursor logo in the usage dropdown, model selection, and other provider surfaces.
  category: fix
  dev: Replaces the placeholder CursorCliIcon SVG with the Cursor brand mark and adds a `cursor` → `cursor-cli` mapping in inferProviderIconKey.
- 0a90dc4: summary: Stop false "OAuth token expired" push notifications for providers that silently refresh (e.g. GitHub Copilot).
  category: fix
  dev: OAuthExpiryMonitor.check() now attempts a best-effort getApiKey refresh and re-checks the credential before dispatching oauth-token-expired, mirroring /api/auth/status's refresh-then-recheck that drives OAuthReloginBanner. The FN-7574 start-refresher-first ordering only covered the startup check; short-lived auto-refreshing tokens still fired on interval ticks with no matching banner.
- ee5c2a8: summary: Fix terminal header wrapping and spacing when the panel is narrow.
  category: fix
  dev: Header shortcut/status text now stays nowrap so terminal actions scroll horizontally instead of wrapping.
- 6b506f2: summary: Move terminal shortcuts into the footer and collapse crowded terminal tabs into a dropdown.
  category: feature
  dev: The shared terminalActionControls fragment now always renders in the .terminal-status-bar footer (never the header .terminal-actions); a ResizeObserver-driven container-overflow check swaps the .terminal-tabs strip for the existing .terminal-mobile-tabs <select> dropdown when tabs don't fit, distinct from the viewport-based isMobileTerminal/isTabletTerminal flags.
- 4fb3606: summary: Show task Artifacts-tab documents expanded with Markdown by default.
  category: feature
  dev: TaskDocumentsTab now uses multi-expand document state and persists the Markdown/Plain preference.
- 06bf0b8: summary: Artifacts view — Task Documents sidebar now shows clearer task grouping and more space between tasks.
  category: fix
  dev: DocumentsView Task Documents sidebar restyles .documents-task-sidebar-group-header vs .documents-task-document-item hierarchy and increases inter-group separation, scoped under .documents-task-documents-sidebar so Project Files and Artifacts tabs are unaffected.
- 391ff0d: summary: Agents now auto-clear error state and retry on their next heartbeat instead of getting stuck.
  category: fix
  dev: Heartbeat scheduler keeps transient, non-operator-actionable error-state durable agents timer-eligible; executeHeartbeat clears error (error→active, clears lastError) at run entry, bounded by MAX_HEARTBEAT_ERROR_RECOVERY_ATTEMPTS (settings-overridable). Operator-actionable errors stay parked; exhaustion pauses the agent with pauseReason "error-retry-exhausted"; a successful run resets the counter. Emits agent:auto-recover-error-state / agent:error-retry-exhausted run-audit events.
- b3ed63d: summary: Fix the Artifacts Task Documents list rendering as blank rows when documents are loaded.
  category: fix
  dev: Root cause was flex-shrinking task cards in DocumentsView.css; cards now opt out of shrink and DocumentsView.test.tsx covers loaded 50+ group rendering.
- 3da3f37: summary: Done task cards group Archive and Revert into one dropdown.
  category: feature
  dev: Reuses the in-progress "Send back" .card-send-back\* dropdown pattern in TaskCard; new i18n key tasks.doneActions.
- 14b7244: summary: Stop recording advisory "merger awaiting-confirmation" planner interventions that never block auto-merge.
  category: fix
  dev: decidePlannerRecovery now returns action "none" for merger/pull-request stages when autoMergeWillProceed === true; the genuine human-approval (false) and neutral (undefined) confirmation paths are unchanged (FN-7840).
- 0b5c551: summary: Fix the mobile Todo view so the list panel fills full height on selection.
  category: fix
  dev: TodoView.css — the single-panel narrow-container stack no longer inherits the @media (max-width:768px) sidebar max-height cap.
- c7c6c5a: summary: Priority selection in quick add and task cards is now color-coded by urgency (blue low, amber high, red urgent).
  category: feature
  dev: priorityIndicator gains a getPriorityColorVar single source consumed by QuickEntryBox, TaskForm inline row, and TaskCard's .card-priority-badge; semantic tokens only, no test-id/payload changes.
- c9d0211: summary: Coordinate durable-agent error recovery across heartbeat and self-healing.
  category: fix
  dev: Reconciles heartbeatErrorRecovery with recoverOrphanedAgents so timer and self-healing paths share one retry budget, use consistent transient/operator-actionable eligibility, and emit a source-discriminated audit surface (FN-7844).
- 4397caf: summary: Fix push to remote after merge never running; pick the push remote and target branch from dropdowns in settings.
  category: fix
  dev: The `pushAfterMerge` setting only existed in the soft-deprecated legacy `aiMergeTask` pipeline; `runAiMerge` (the sole merge path since master-plan U0) now runs a post-finalize push step — ref-to-ref fast path, clean-room detached rebase with AI conflict resolution on remote divergence (non-FF local ref CAS advance + merge-advance auto-sync), `push:origin` run-audit events, non-fatal failures. New `GET /api/git/remotes/:name/branches` endpoint backs the settings dropdowns; the `pushRemote` setting string ("origin" / "origin main") is unchanged.
- d116018: summary: Make stranded AI merge recovery bind to the reviewed clean-room commit.
  category: fix
  dev: Avoids ambiguous same-task clean-room recovery and honors cancellation before pre-prune landing.
- d80cdd2: summary: Honor assigned agent models in execution and warn on default-model fallbacks.
  category: fix
  dev: Executor assigned-agent lookup now falls back to the root AgentStore; session audit adds noModelResolved/runtimeBuiltInFallbackModel when resolution is empty.
- 41998a6: summary: Fix cramped padding on the Notifications "Failure notification mode" settings card.
  category: fix
  dev: Wrap the failure-notification card fields in `.notification-provider-body` in NotificationsSection so it matches sibling provider-card padding on desktop and mobile.
- a9d5c0f: summary: Fix Grok CLI chat returning errors or empty replies in the dashboard.
  category: fix
  dev: Two independent defects. (1) The default (no-project) ChatManager received a bare PluginLoader as its runner; Grok CLI routing (deriveGrokRuntimeHintForNoVisibleKey → resolveRuntime) calls getRuntimeById/createRuntimeContext, which only exist on PluginRunner, so a grok-cli/\* chat with no Fusion-visible GROK_API_KEY threw "getRuntimeById is not a function" and surfaced the misleading "requires the bundled Grok CLI runtime" error. New resolveChatManagerPluginRunner(options) prefers the engine's PluginRunner (the runner the project-scoped chat path already uses), falling back to the loader only in UI-only mode. (2) In a source checkout the running dashboard resolved the staged CLI tsup bundle (packages/cli/dist/plugins/fusion-plugin-grok-runtime/bundled.js), which resolvePluginEntryPath prefers verbatim with no freshness check; that bundle was stale vs the FN-7796 single-JSON adapter source (the FN-7779 dev prebuild rebuilds each plugin's own dist but never the staged bundle), so project-scoped grok chat produced empty replies. Fixed durably: getCandidatePluginDirs now probes the live workspace source dir (<repo>/plugins/<id>) before the staged bundle, so dev loads the freshness-checked live plugin (self-healing even when the prebuild is skipped). Published installs are unaffected (no workspace dir). A one-time `pnpm build` refreshes any already-stale staged bundle.
- 5dc3837: summary: Fix header connection pill showing "Desktop Desktop" and mixed font sizes.
  category: fix
  dev: ShellConnectionStatus now folds the host kind into one summary string; removed the separate \_\_kind span and its CSS.
- 1d2d73b: summary: Fix Memory insights parsing and modernize the Memory, Insights, Todos, and agent Memory views.
  category: fix
  dev: parseInsightsContent filtered bullets after stripping their prefix, collapsing every category into one blob; useMemoryData drops the dead GET /memory and /memory/stats mount fetches and no longer refetches the file list on selection; Engines tab is a 2-column card grid; Todo items are single-row with a quiet inline action cluster; the agent Memory tab uses the shared FileEditor with per-section save actions and fixes the agents.memoryFileMeta {{date}} interpolation.
- c73094e: summary: Polish the Memory view: centered layout, labeled editor toolbar, aligned toggle rows.
  category: fix
  dev: MemoryView tabs get a 960px centered column; FileEditor instances pass forceToolbarActionsVisible; new i18n key memory.dreamsEnabledTooltip.
- c68b053: summary: Reconcile completed and stale generated-fix mission invariants.
  category: fix
  dev: Completed missions now normalize autopilot/auto-advance to inactive during autopilot completion, polling, and restart recovery. Mission reconciliation also supersedes generated fix features whose own validator state is already passed, and the scheduler startup sweep runs stale generated-fix reconciliation before trying to relink or retriage active slice features. This prevents complete missions from remaining watched and prevents stale generated fix rows from keeping otherwise-drained missions administratively active.
- b613a87: summary: Settings on mobile now keeps showing the GitHub star count.
  category: fix
  dev: Removed the ≤768px `display:none` on `.settings-github-star-btn__count` in SettingsModal.css (FN-7848).
- be1950b: summary: Keep task detail per-model cost tables horizontally scrollable on mobile.
  category: fix
  dev: Removes the Task Detail stacked-card mobile override and guards the shared token table scroll contract.
- dbb29d4: summary: Document the planner-overseer eye badge on task cards.
  category: internal
  dev: Clarifies that the eye icon reflects non-idle plannerOverseerState, not a human view marker.
- e4a59f7: summary: Tasks are no longer stuck "awaiting release authorization" — the over-firing release gate was removed.
  category: fix
  dev: Removed the triage release-authorization gate (packages/engine/src/triage-release-authorization.ts + finalizeApprovedTask block) and its dashboard approve/reject-plan guards. It false-flagged specs that merely mentioned release tooling and stranded tasks in awaiting-approval with no in-band exit. Legacy `awaitingApprovalReason: "release-authorization"` rows now render as ordinary manual plan-approval holds. Releases are kept out of Fusion by agent instruction (AGENTS.md → Releasing) instead.
- e4d404e: summary: Fix Settings GitLab row overflowing its panel and the footer Save button clipping.
  category: fix
  dev: settings-gitlab-disclosure now carries the form-group gutter; .settings-modal .modal-actions wraps on desktop instead of clipping (mobile nowrap rail preserved).
- 2cfeb74: summary: Polish first-run setup: connected providers first, state-driven GitHub step, fixed radios, deduped node picker.
  category: fix
  dev: New setupWizardNodes.ts (getSelectableRuntimeNodes/shouldShowRuntimeNodeSelector) shared by SetupWizardModal and SetupProjectForm; GitHub status revalidates on window focus and OAUTH_RELOGIN_SUCCESS_EVENT; 4 new i18n keys.
- e90a9c4: summary: Auto-heal wedged SQLite connections in place instead of failing every request until restart.
  category: fix
  dev: The sqlite adapter now classifies connection-corruption errors (SQLITE_NOTADB "file is not a database" / "database disk image is malformed"), reopens the connection on the same path, replays assignment-style PRAGMAs, verifies with PRAGMA quick_check, and retries the failed operation once when outside an explicit transaction. Statements are generation-tracked so ones prepared before the reopen re-prepare transparently; mid-transaction unwind (ROLLBACK/RELEASE) after a reopen is absorbed as no-ops. Covers fusion.db, fusion-central.db, and archive.db. On-disk corruption (quick_check failure) still defers to the open-time recovery machinery.
- 23e36b8: summary: Task API operations no longer fail with 500 when a task's PROMPT.md can't be read; server also logs 500 causes.
  category: fix
  dev: getTask (the shared load for GET/DELETE/PATCH/retry/reset/archive) and the mutation helpers updateTaskUnlocked, updateStep, readPromptForArchive, and resetPromptCheckboxes (packages/core/src/store.ts) read PROMPT.md unguarded, so an unreadable file (root-owned from a prior `sudo` run → EACCES, PROMPT.md being a directory → EISDIR, transient FS error) 500'd every per-task op while the PROMPT.md-free board list/create kept working. These reads are now best-effort (degrade + log). Diagnosability: rethrowAsApiError preserves the original error as Error `cause` and the /api boundary logs stack + cause for 5xx (packages/dashboard/src/api-error.ts, server.ts); client body stays generic in production.
- 23e36b8: summary: "Update now" now explains permission (EACCES) failures and how to fix them instead of showing raw npm errors.
  category: fix
  dev: `performUpdateInstall` (packages/dashboard/src/update-check.ts) detects EACCES/EPERM install failures (by error code or stderr text) and returns actionable remediation — run `sudo fn update`, reinstall without sudo, or `brew upgrade fusion` for Homebrew installs — rather than the raw `npm error EACCES … rename '/usr/lib/node_modules/@runfusion/fusion'`. Occurs when Fusion was installed via `sudo npm i -g` (root-owned global dir); `--force` is not retried for this class since it cannot grant write permission.

### runfusion.ai

#### Patch Changes

- Updated dependencies [6317fcd]
- Updated dependencies [79264d4]
- Updated dependencies [17d7bd1]
- Updated dependencies [49faf0a]
- Updated dependencies [66e91f9]
- Updated dependencies [9ac4da0]
- Updated dependencies [f10c39f]
- Updated dependencies [409de31]
- Updated dependencies [9024f3a]
- Updated dependencies [f628095]
- Updated dependencies [05d30ff]
- Updated dependencies [93b0801]
- Updated dependencies [ec1a2ea]
- Updated dependencies [fbea66d]
- Updated dependencies [19055c6]
- Updated dependencies [f66bfae]
- Updated dependencies [23e36b8]
- Updated dependencies [84fb513]
- Updated dependencies [53427cd]
- Updated dependencies [c565ceb]
- Updated dependencies [d585edb]
- Updated dependencies [7fe18df]
- Updated dependencies [bccb552]
- Updated dependencies [639a706]
- Updated dependencies [3e7e4a8]
- Updated dependencies [22e7d75]
- Updated dependencies [55dae49]
- Updated dependencies [081dae0]
- Updated dependencies [4fb2bf5]
- Updated dependencies [dcfbee9]
- Updated dependencies [6606902]
- Updated dependencies [6cff782]
- Updated dependencies [7dc2710]
- Updated dependencies [2580524]
- Updated dependencies [21d1201]
- Updated dependencies [b2613b7]
- Updated dependencies [71e9f48]
- Updated dependencies [c8fcbec]
- Updated dependencies [cda9532]
- Updated dependencies [a4931a4]
- Updated dependencies [626e002]
- Updated dependencies [a24b0fa]
- Updated dependencies [171aaa2]
- Updated dependencies [e657d3b]
- Updated dependencies [1fc615d]
- Updated dependencies [e5c3ffb]
- Updated dependencies [927741a]
- Updated dependencies [d44dbaa]
- Updated dependencies [5a9f354]
- Updated dependencies [7420abe]
- Updated dependencies [6a13ad1]
- Updated dependencies [1e79a23]
- Updated dependencies [bab42b4]
- Updated dependencies [0e90578]
- Updated dependencies [86bd434]
- Updated dependencies [5304af8]
- Updated dependencies [4726af6]
- Updated dependencies [9d7b087]
- Updated dependencies [2ff8e2e]
- Updated dependencies [f930790]
- Updated dependencies [1fa4a69]
- Updated dependencies [786a274]
- Updated dependencies [eb377ba]
- Updated dependencies [547740b]
- Updated dependencies [9ce0b49]
- Updated dependencies [f7c6f56]
- Updated dependencies [d2c2a4c]
- Updated dependencies [28c8233]
- Updated dependencies [b4b183f]
- Updated dependencies [2be6040]
- Updated dependencies [fed5d3d]
- Updated dependencies [150227f]
- Updated dependencies [18841d7]
- Updated dependencies [f6fd6ac]
- Updated dependencies [059016e]
- Updated dependencies [167067c]
- Updated dependencies [3cda9d8]
- Updated dependencies [5f14a58]
- Updated dependencies [235ff4c]
- Updated dependencies [df8ad46]
- Updated dependencies [1ba588d]
- Updated dependencies [f9641ec]
- Updated dependencies [035caca]
- Updated dependencies [57c3d7c]
- Updated dependencies [2758dde]
- Updated dependencies [a32307f]
- Updated dependencies [70330bc]
- Updated dependencies [ee796ee]
- Updated dependencies [f5fd8b8]
- Updated dependencies [5729fe2]
- Updated dependencies [2e97395]
- Updated dependencies [03073af]
- Updated dependencies [59a798b]
- Updated dependencies [4d4e9ad]
- Updated dependencies [cc8b1b6]
- Updated dependencies [30bd779]
- Updated dependencies [dd82a60]
- Updated dependencies [db9b9d2]
- Updated dependencies [de67b57]
- Updated dependencies [fc4acd4]
- Updated dependencies [3d5cc0a]
- Updated dependencies [c258fc1]
- Updated dependencies [7846c96]
- Updated dependencies [725ce45]
- Updated dependencies [915c1e0]
- Updated dependencies [21fb8f6]
- Updated dependencies [367f591]
- Updated dependencies [60b8b4e]
- Updated dependencies [c1b14c2]
- Updated dependencies [281d1a3]
- Updated dependencies [595d323]
- Updated dependencies [56b20a7]
- Updated dependencies [bd0e99b]
- Updated dependencies [d40f24d]
- Updated dependencies [a2c9b0f]
- Updated dependencies [3da9da2]
- Updated dependencies [9376504]
- Updated dependencies [0a90dc4]
- Updated dependencies [ee5c2a8]
- Updated dependencies [26f0c5a]
- Updated dependencies [6b506f2]
- Updated dependencies [4fb3606]
- Updated dependencies [06bf0b8]
- Updated dependencies [391ff0d]
- Updated dependencies [b3ed63d]
- Updated dependencies [cc743ee]
- Updated dependencies [3da3f37]
- Updated dependencies [14b7244]
- Updated dependencies [0b5c551]
- Updated dependencies [c7c6c5a]
- Updated dependencies [c9d0211]
- Updated dependencies [dd95634]
- Updated dependencies [d99c04c]
- Updated dependencies [4397caf]
- Updated dependencies [d116018]
- Updated dependencies [d80cdd2]
- Updated dependencies [41998a6]
- Updated dependencies [6267a76]
- Updated dependencies [a9d5c0f]
- Updated dependencies [5dc3837]
- Updated dependencies [1d2d73b]
- Updated dependencies [c73094e]
- Updated dependencies [c68b053]
- Updated dependencies [b613a87]
- Updated dependencies [be1950b]
- Updated dependencies [dbb29d4]
- Updated dependencies [e4a59f7]
- Updated dependencies [e4d404e]
- Updated dependencies [2cfeb74]
- Updated dependencies [bcbd97c]
- Updated dependencies [e90a9c4]
- Updated dependencies [23e36b8]
- Updated dependencies [fc07bdf]
- Updated dependencies [23e36b8]
- Updated dependencies [4edd8cc]
  - @runfusion/fusion@0.58.0

## 0.57.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.57.0
- @fusion/engine@0.57.0
- @fusion/i18n@0.39.22
- @fusion-plugin-examples/cli-printing-press@0.1.39
- @fusion-plugin-examples/compound-engineering@0.1.22
- @fusion-plugin-examples/dependency-graph@0.1.53
- @fusion-plugin-examples/roadmap@0.1.41
- @fusion-plugin-examples/cursor-runtime@0.1.41
- @fusion-plugin-examples/droid-runtime@0.1.48
- @fusion-plugin-examples/hermes-runtime@0.2.72
- @fusion-plugin-examples/openclaw-runtime@0.2.72
- @fusion-plugin-examples/paperclip-runtime@0.2.72

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.57.0
- @fusion/dashboard@0.57.0
- @fusion/engine@0.57.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.57.0
- @fusion/pi-claude-cli@0.57.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.57.0

### @runfusion/fusion

#### Minor Changes

- 03161ad: summary: Archived tasks now load newest-first in pages of 100 with a Show more button.
  category: feature
  dev: Adds ArchiveDatabase.listPage / TaskStore.listArchivedTasks and GET /tasks/archived for a bounded SQL LIMIT/OFFSET read ordered archivedAt DESC. useTasks.loadArchivedTasks fetches page 1 on first Archived-column expand; loadMoreArchivedTasks fetches subsequent pages. No schema change; the legacy merged listTasks({includeArchived}) path is unchanged.
- e444581: summary: Planning Mode's "go deeper" prompt now suggests plan-specific topics instead of generic buckets.
  category: feature
  dev: AI completion payload gains optional `deepeningThemes`; the deepening checkpoint prefers them (via buildDeepeningCheckpointOptions) and falls back to the existing regex-derived themes when absent.
- 42009cf: summary: Edit a chat message and resume the conversation from that point.
  category: feature
  dev: Adds ChatStore.deleteMessagesFrom + PATCH /api/chat/sessions/:id/messages/:messageId; rewinds the pi SessionManager (createBranchedSession) so the model forgets discarded turns. Direct model-loop chats only.
- 0f2bfa5: summary: Built-in runtime plugins (Hermes, Paperclip, OpenClaw, Droid) can now be disabled and stay disabled across restarts.
  category: feature
  dev: renderBuiltinPluginSection now renders a durable enable/disable toggle for runtime built-ins independent of installed status, replacing the dead-end "Built-in metadata only" CTA for the not-installed / activated-without-record case. Chosen persistence path: on disable, a not-yet-installed built-in runtime is first registered via the existing installPlugin path (mirroring the CLI's ensureBundledPluginInstalled lazy-install), then disablePlugin is called immediately so a plugin_installs row + project state exists with enabled=false — no new persistence primitive needed since loadAllPlugins/loadPlugin already skip disabled plugins and recordActivationEvent only fires on actual load, so a disabled runtime is never re-activated on restart. HermesRuntimeCard/OpenClawRuntimeCard/PaperclipRuntimeCard now reflect the Plugin Manager disabled state ("Disabled in Plugin Manager") instead of showing a stale detected/connected status.
- 6777eea: summary: Chat search now matches message content, with a "Search in title only" toggle.
  category: feature
  dev: ChatStore.searchSessionsByMessageContent (parameterized LIKE ... ESCAPE); GET /chat/sessions gains q/titleOnly params; useChat exposes searchInTitleOnly.
- 5b243f1: summary: Hermes-configured models now appear in Fusion's model picker when the Hermes runtime is available.
  category: feature
  dev: /api/models additively merges `hermes profile list` results under the `hermes` provider via a short-TTL, single-flight cache (no per-request CLI spawn); rows are deduped by provider/id and never displace existing entries. Deferred item 1 of FN-7630.
- 1b7bb1f: summary: Edit and resend a message in task-detail Planner Chat.
  category: feature
  dev: Wires FN-7628's edit affordance (editChatMessage + rewindSessionForEdit) into TaskPlannerChatTab for synthetic task-planner:<id> sessions; already-applied steering comments and refinement tasks are not reverted when a turn is discarded.
- f7d9509: summary: Duplicate tasks are no longer auto-archived on creation by default — they are flagged for review instead.
  category: feature
  dev: Adds project setting `autoArchiveDuplicateTasksEnabled` (default false) gating the FN-4892 same-agent duplicate intake path in store `_maybeAutoArchiveSameAgentDuplicate`; disabled path uses new `flagSameAgentDuplicate` and sets `nearDuplicateOf` metadata. Tombstone-resurrection blocking is unchanged.
- dd9fa2d: summary: fn_task_archive and fn_task_delete now accept removeLineageReferences to clear a lineage-parent block.
  category: fix
  dev: Forwards the boolean to store.archiveTask/deleteTask (FN-7661); resolves the tools referencing a parameter their schema never exposed.
- 8ee8f15: summary: Agents now know they run inside Fusion and won't plan actions across a platform shutdown.
  category: fix
  dev: Adds a shared runtime self-awareness + capability-grounding preamble (packages/core/src/agent-prompts.ts, FUSION_RUNTIME_SELF_AWARENESS) prepended to the chat, heartbeat, and executor base prompts' stable layer.
- 461a4a2: summary: Custom providers can now enable Anthropic-style prompt caching to stop re-billing the full context each turn.
  category: fix
  dev: Sets pi-ai `compat.cacheControlFormat="anthropic"` on opted-in custom-provider models across both registration paths (custom-provider-registry `toProviderConfig` and `pi.ts` createFnAgent). Opt-in via new `CustomProvider.anthropicPromptCaching` flag (FN-7689).

#### Patch Changes

- 4444262: summary: Approval cards now show the gated command/arguments and dedupe repeated pending requests.
  category: fix
  dev: Permanent-agent gate persists approvalDedupeKey in targetAction.context and a payload-bearing summary (buildAgentGatedActionSummary); MailboxView renders GatedActionApprovalDetails for source="agent-gating".
- 1b1e1f1: summary: Fix Planning Mode Back button showing a generation screen instead of the previous question.
  category: fix
  dev: handleBack in PlanningModeModal no longer transitions to the loading view during the deterministic rewindPlanningSession; Back returns directly to the previous question form (success and error paths) and never renders .planning-loading.
- ebe9b9f: summary: Auto-approve plan toggle now appears only on the planning column, not Todo.
  category: fix
  dev: Board.tsx gated the plan auto-approve prop pair on intake||hold; the built-in Coding workflow's Todo is a hold column, leaking the control. Gate is now intake-only (legacy triage path unchanged).
- 13570e8: summary: Fix Quick Add action-row buttons (Save, Attach, Fast, workflow trigger) rendering at mismatched heights.
  category: fix
  dev: Adds a scoped `min-height` on `.quick-entry-actions .btn` and `.wf-optional-steps-dropdown-trigger` in `QuickEntryBox.css` (desktop base rule, alongside the existing mobile touch-target block) so every action-row control resolves one uniform box height regardless of icon-only vs text content or `.dep-trigger` padding differences. No shared `.btn`/`.btn-sm`/`.btn-icon`/`.btn-task-create`/`.dep-trigger` rules in `styles.css` were touched.
- 9a5a8d2: summary: Quick Add action-row controls now resolve one identical box height, not just a min-height floor.
  category: fix
  dev: Upgraded `.quick-entry-actions .btn, .quick-entry-actions .wf-optional-steps-dropdown-trigger` in QuickEntryBox.css from a bare min-height floor to a fixed box height (min-height paired with an equal max-height) plus tokenized line-height and centered alignment, at both the desktop base rule and the <=768px touch-target media block. Follow-up: a mobile-only Save-specific override (no vertical padding, line-height:1) further corrects Save's mobile sizing to match siblings without affecting desktop/tablet.
- 1762229: summary: Warn when changing a workflow's model surfaces tasks still pinned to the old model, including default-workflow tasks.
  category: fix
  dev: PATCH /workflows/:id/setting-values now returns `modelDrift` for execution/planning/validator lanes. Drift baseline is captured inside the settings write transaction (no stale-read race), and default-workflow patches pass `includeNullSelection` so no-workflow-selection tasks are counted. New `TaskStore.updateWorkflowSettingValuesWithPrevious` and `getModelLaneDrift(..., { includeNullSelection })`.
- a486e0b: summary: Retry transient OAuth token-rotation errors so in-flight agent calls survive rotation without failing the task.
  category: fix
  dev: withRateLimitRetry now retries transient auth errors (authentication_error, invalid credentials, token_expired) on a separate ~5s flat-delay budget that does not consume rate-limit attempts. OAuth scope/permission failures are explicitly excluded (operator must re-authorize) so they surface immediately instead of retrying pointlessly.
- 9e5c025: summary: Executors now block on pending approvals instead of probing for ungated workarounds.
  category: fix
  dev: wait-for-approval now suspends the in-flight executor session via awaitAbortInFlightTaskWork and dedupes identical pending approvals; executor prompts carve out awaiting-approval as a legitimate turn end.
- 60081fb: summary: Fix workspace-mode tasks failing auto-merge under the pull-request merge strategy.
  category: fix
  dev: Engine merge dispatch now checks isWorkspaceTask before the mergeStrategy branch, routing workspace tasks to landWorkspaceTask instead of processPullRequestMerge (which threw "could not determine repository" against the non-git workspace root). processPullRequestMergeTask/syncGroupPrCallback now throw the named WorkspaceTaskMergeError for workspace tasks as defense-in-depth.
- 203f879: summary: New tasks now land in the selected workflow's intake column instead of always jumping to Planning/triage.
  category: fix
  dev: Removed hardcoded `column: "triage"` overrides in `fn_task_create` (engine `createTaskCreateTool` and pi extension) and in signal/GitHub-import/planning create surfaces that had no `workflowId` or (for planning subtask routes) accepted one but still forced `column`. `TaskStore.createTask` already resolves `input.column || resolvedEntryColumn || "triage"`; callers no longer defeat that resolution. A custom workflow's non-triage `intake`-trait column (e.g. `Inbox`) now correctly captures new cards inert until released, while the default builtin:coding workflow still lands cards in `triage` byte-identically. The pi-extension `fn_task_create` response text now echoes the actual landing column instead of a fixed `"Column: triage"` string.
- 81fbb65: summary: Yes/No chat question buttons now show a clear selected state after clicking.
  category: fix
  dev: Strengthened `.chat-question-response__confirm--selected` CSS specificity (compound selector + dedicated hover/focus-visible rules) so the CTA-token selected fill/border beats the global `.btn`/`.btn:hover` rules; added `aria-pressed` and a regression test asserting the selected class toggles correctly between Yes/No.
- 5631c88: summary: Planning Mode "needs input" now shows a yellow nav badge instead of a top banner.
  category: fix
  dev: Excludes planning `awaiting_input` sessions from SessionNotificationBanner and adds a `status-dot--pending` dot to the Planning nav destination (LeftSidebarNav + MobileNavBar More item/tab), driven by a new `planningNeedsInput` flag.
- 1ea3c86: summary: Task-detail Oversight button now matches Priority/Execution-mode height on desktop.
  category: fix
  dev: `.detail-oversight-menu-dropdown` (the popover-positioning wrapper) is now `inline-flex; align-items: stretch` so it participates in `.detail-meta-inline-controls`'s stretch, and `.detail-oversight-menu-trigger` gets `align-self: stretch` to fill it — matching Priority/Execution-mode's direct-child stretch behavior without any new hardcoded height.
- ca84473: summary: fn_task_attach now refuses to read files outside the task worktree boundary.
  category: security
  dev: Adds a path-containment guard (confine to ctx.cwd) before readFile in the fn_task_attach tool; rejects traversal/absolute/@-prefixed escaping paths. Regression tests in packages/cli/src/**tests**/extension.test.ts. Fixes FN-7619 (flagged out-of-scope during FN-7608).
- 8d73b18: summary: Fix mobile dashboard terminal sometimes rendering completely blank on open.
  category: fix
  dev: TerminalModal now attaches a persistent ResizeObserver directly on the xterm container (mirroring SessionTerminal's existing pattern), so a container that reports a zero/collapsed box at the first post-open fit recovers as soon as its real box settles, instead of staying at FitAddon's degenerate 2x1-cell floor forever.
- ca7c987: summary: Fix the mobile terminal shortcut bar so it truly scrolls horizontally to reach every key.
  category: fix
  dev: FN-7550's leaf `min-width:0`/`overflow-x:auto`/`touch-action:pan-x` on `.terminal-shortcut-panel` were already correct, but styles.css's mobile `@media(max-width:768px)` lockdown resets `touch-action` to `pan-y` on `*` and re-locks it explicitly on `.modal-overlay:not(.confirm-dialog-overlay)`/`#root`/`html`/`body` — the terminal's own overlay/modal ancestors were never carved back into `pan-x`, so the panel's own correct touch-action was defeated by ancestor-chain intersection on real mobile devices. Added `touch-action: pan-x pan-y` to `.modal-overlay.terminal-modal-overlay`, `.modal.terminal-modal(.terminal-modal--mobile)` (both mobile paths), and `.terminal-status-bar` (FN-7560 footer, same gap). Locked in with a real-CSS `getComputedStyle` layout test (`loadAllAppCss()`) that resolves the panel + full ancestor chain, replacing reliance on a leaf-rule string match that stayed green through this recurrence.
- fe5a595: summary: Fix desktop app showing a truncated provider/model list vs. the web build.
  category: fix
  dev: The Electron desktop app's in-process dashboard server (local-runtime.ts, local-server.ts) now routes through a shared `@fusion/engine` `seedDashboardProviders()` helper that mirrors the CLI serve/dashboard/daemon startup sequence (built-in Zai/API-key provider seeding, `wrapAuthStorageWithApiKeyProviders`, `registerCustomProviders`). `provider-auth.ts` and `custom-provider-registry.ts` moved from `@fusion/cli` into `@fusion/engine`; the CLI files are now re-export shims with unchanged observable behavior.
- d54ab80: summary: Fix desktop app plugin install and Browse registry (plugin subsystem now wired into the embedded server).
  category: fix
  dev: local-runtime.ts / local-server.ts now build a PluginStore + PluginLoader and pass pluginStore/pluginLoader/pluginRunner into createServer, mirroring the CLI dashboard command (FN-7623, issue #1937). Plugin subsystem init is fail-soft — a broken plugin (e.g. corrupt manifest) logs/traces via strace(...) but no longer blocks embedded dashboard startup.
- a4f5fbc: summary: Fix onboarding GitHub sign-in button erroring instead of starting GitHub auth.
  category: fix
  dev: The onboarding/settings GitHub step no longer offers dashboard-managed OAuth login when no `github` OAuth provider is registered (pi ships only anthropic/github-copilot/openai-codex); it now presents gh CLI (`gh auth login`) guidance. `/api/auth/login` returns a clear unknown-provider error for `github` instead of a misleading "model not found".
- a6c60e1: summary: Authentication settings always lists all supported providers, regardless of connected runtime plugins.
  category: fix
  dev: GET /api/auth/status now enumerates a static supported-provider catalog (union with storage-reported providers) and uses runtime/auth state only to annotate per-provider status; connecting a runtime plugin (e.g. Hermes Runtime) no longer collapses the provider list.
- ebf8f87: summary: Add a close button to the Settings screen on mobile.
  category: fix
  dev: The embedded Settings header now renders a mobile-only `modal-close` control gated on `isEmbedded && viewportMode === "mobile"`, wired to the existing `onClose` prop (navigates back to the board and refreshes app settings). Desktop/tablet embedded and the standalone modal presentation are unchanged.
- 6bf0090: summary: Hermes Runtime is now additive — connecting it no longer hides your custom providers, models, or auth options.
  category: fix
  dev: Audited the Hermes Runtime plugin (onLoad/onUnload, CLI-spawn/probe seams) and register-model-routes.ts/register-auth-routes.ts against GitHub #1931. Confirmed the reported customProviders suppression was already fixed generically (unrelated to Hermes) and that Hermes's PluginContext has no reference to AuthStorage/ModelRegistry, so it cannot mutate either store. Added FNXC documentation comments locking in the additive-runtime invariant and regression coverage across the model-picker (/api/models), custom-provider CRUD, and auth-status surfaces proving a connected Hermes runtime never narrows them. Item 3 (static auth catalog) remains owned by FN-7625; item 1 (additive Hermes-model surfacing in the picker) is deferred to a follow-up task (FN-7636) pending a non-blocking CLI-spawn caching strategy.
- 413ef1d: summary: Align Priority and Execution-mode control heights with the Oversight dropdown in task detail.
  category: fix
  dev: `.detail-priority-chip`, `.detail-execution-mode-toggle`, and `.detail-oversight-menu-trigger` in TaskDetailModal.css now all pin an explicit `height` (not just `min-height`) from the shared `--detail-priority-control-min-height` token, so none can outgrow or undershoot the others regardless of flex stretch behavior; extends the FN-7585/FN-7618 shared-token pattern.
- 51e3891: summary: Fix the task-detail Planner Chat stop button rendering narrower than its send button.
  category: fix
  dev: `TaskPlannerChatTab.css` now declares a locally-scoped `--chat-input-control-size` on `.task-planner-chat-composer` (same formula as `ChatView.css`'s `.chat-input-row`) and applies it as a `min-inline-size` floor on `.task-planner-chat-send`, so the shared `.chat-input-send`/`.chat-input-stop` classes (which previously read an undefined custom property inside the Planner composer and fell back to `width: auto`) never render the streaming Stop button narrower than the idle Send button on desktop or mobile.
- 4e8c621: summary: Fix cards stranded after workspace/out-of-band merges land; node-override end no longer silently no-ops.
  category: fix
  dev: store.moveTask now allows proven-merge recoveryRehome from legacy columns (e.g. todo→done); nodeId='end' finalizes on durable merge proof or returns an explicit error across the dashboard route, CLI task-update tool, and store.updateTask.
- f1db313: summary: Code Review/Plan Review/CE gate failures now record a diagnostic instead of "(no feedback captured)".
  category: fix
  dev: When an enabled optional-group (`code-review`, `plan-review`, `browser-verification`) or CE `source:"node"` skill-gate template node fails via a dispatch/infra exception rather than a reviewer verdict, `WorkflowGraphExecutor` now synthesizes a non-blank `WorkflowStepResult.output` from the underlying `node:<id>:error` context-patch key (falling back to the failure `value`, then a stable sentinel) instead of leaving `output`/`notes` field-absent. Fixes Runfusion/Fusion#1946. `status`, verdict extraction, edge routing, and self-healing's `latestFailedPreMergeStep` selection are unchanged.
- 923bba7: summary: Fix agents on long heartbeat intervals silently going stale for hours.
  category: fix
  dev: HeartbeatTriggerScheduler timer audit now re-arms non-advancing long-interval registrations (stale lastHeartbeatAt with a live timer entry), not just missing ones (FN-7645).
- 009ce26: summary: Fix provider API keys being wiped when the desktop and CLI apps share credentials on one machine.
  category: fix
  dev: createFusionAuthStorage() now reloads before persisting a refreshed OAuth credential so a concurrent Fusion process's newer login is not overwritten; adds cross-process regression coverage over ~/.fusion/agent/auth.json. Relies on the pi-coding-agent FileAuthStorageBackend locked per-provider merge (floor >=0.80.x).
- 563a8c6: summary: Route node settings-sync and mesh credential writes through the coordinated auth store to prevent concurrent clobbers.
  category: fix
  dev: register-settings-sync-routes.ts, register-settings-sync-inbound-routes.ts, and register-mesh-routes.ts now persist received credentials via @fusion/engine createFusionAuthStorage() instead of raw AuthStorage.create(getFusionAuthPath()), sharing FN-7646's reload-before-persist + per-provider locked-merge path over ~/.fusion/agent/auth.json. Adds route-level regression coverage.
- bec8987: summary: Fix tasks in planning/intake columns starting execution before they were specified.
  category: fix
  dev: The hold-release entry guard (reserveSlot in scheduler.ts, issueRelease in hold-release.ts) is now trait-based (isUnplannedForExecution resolves the `intake` trait plus `status:"planning"`/bootstrap-stub PROMPT.md) instead of keyed on the literal `todo` column id, so renamed custom intake columns (e.g. `ideas`, `Inbox`) are covered too. promoteHeldTask/releaseHeldTaskByEvent also route through the same guard (FN-7648).
- ce4f173: summary: Switching projects now lands on the Board instead of Settings when the last-visited view was Settings.
  category: fix
  dev: Extended resolveLandingTaskView in useViewState.ts to resolve "settings" (in addition to "command-center") to "board" for the auto-restored/hydrated landing view only; deep links (?view=settings) and explicit navigation still open Settings.
- efabdd6: summary: Removed the chat "Search in title only" toggle; chat search always matches message content and title.
  category: fix
  dev: Dropped searchInTitleOnly/setSearchInTitleOnly from useChat and the ChatView toggle button; content-search path (q param, matchedMessagePreview) is now always-on. Server GET /chat/sessions titleOnly param retained but unused by the client.
- 7c7b22e: summary: Automation live output no longer shows "Run failed" for runs that actually succeed.
  category: fix
  dev: Reconciles the live-run panel terminal status (ScheduledTasksModal/RoutineCard) to the authoritative POST/registry result and gates benign SSE teardown (post-terminal close, reconnect exhaustion) from being surfaced as a failure across both `/routines/:id/run/stream` and `/automations/:id/run/stream`.
- dfb084c: summary: Planner chat stop button now shows just the stop icon, not a text label.
  category: fix
  dev: StandardChatActionButton gains showStopText (defaults to showSendText); TaskPlannerChatTab sets showStopText={false}. aria-label "Stop generation" retained.
- e29fea3: summary: Restore the chat "Working…" indicator immediately when returning to a session with an active generation.
  category: fix
  dev: `useChat.ts` `selectSession` now reattaches on the authoritative `fetchChatSession` refresh whenever `isGenerating===true`, instead of requiring a populated `inFlightGeneration` snapshot that is null pre-first-delta. Guards against races (stale active session, already-open stream) and reuses `attachIfGenerating` (FN-7656).
- 511bcaf: summary: Retain GitHub issue import state when leaving and returning to Import Tasks.
  category: fix
  dev: Persists GitHubImportModal provider/tab/label filter/remote/selection per project via projectStorage (`kb-dashboard-github-import-state`) and hydrates on remount; falls back to the existing default-remote auto-detect when nothing is persisted.
- 97e4667: summary: Built-in workflow boards and Automations editors now label the intake column "Planning", not "Triage".
  category: fix
  dev: board-workflows canonical label map BUILTIN_WORKFLOW_COLUMN_LABELS.triage was still "Triage", overriding FN-7599's IR rename; set to "Planning". English schedule.columnTriage/taskColumnTriage/triageColumn set to "Planning" and dashboard locale copy re-synced. Also fixed board.triage (AgentDetailView task-column badge) and docs/dashboard-guide.md references. Column id "triage" unchanged.
- 7cf70b3: summary: The Command Center SDLC funnel now labels the intake stage "Planning", matching the renamed board column.
  category: fix
  dev: commandCenter.funnel.stage.triage, enteredInRange, and completionRateAria English strings (and SdlcFunnel.tsx t() fallbacks) changed to "Planning"/"Entered planning"/"in-range planning entrants"; dashboard locale copy re-synced. Aggregator stage key "triage" and the i18n key names are unchanged.
- aa534c1: summary: Auto-recover durable agents stuck in transient error state even when their manager is active.
  category: fix
  dev: SelfHealingManager durable-error recovery no longer requires a missing manager; manager-present durable non-ephemeral agents with a transient lastError and no active run are recovered under the existing cooldown/backoff/retry-budget guards (FN-7672).
- 297c744: summary: Task cards no longer show the steps breakdown while in the Planning column.
  category: fix
  dev: TaskCard `showProgressSection` now excludes the `triage` column, matching ListView; the breakdown appears once a task leaves Planning.
- a4fce60: summary: Align the quick-add workflow dropdown button height with Save/Fast/Subtask buttons.
  category: fix
  dev: `.quick-entry-workflow-trigger` in QuickEntryBox.css now re-asserts `.btn-sm`'s `padding: 4px 10px` locally so the shared global `.dep-trigger` `padding: 3px 8px` no longer shortens it by ~2px; other `.dep-trigger` surfaces (InlineCreateCard, NewTaskModal, TaskDetailModal, TaskForm) are unaffected (FN-7677).
- 83e7743: summary: On tablet widths, move terminal shortcuts/zoom controls into the bottom footer so they no longer overlap header icons.
  category: fix
  dev: Adds an isTabletTerminal flag (769–1024px, non-mobile) that renders the shared terminalActionControls fragment in the .terminal-status-bar footer (as FN-7560 did for mobile) instead of the header; true desktop (>1024px) keeps the header layout. Tablet footer keeps the desktop pin/pop-out toggles.
- a832b79: summary: Fix dashboard terminal showing a blank screen for seconds before the first prompt appears on open.
  category: performance
  dev: `useTerminalSessions` no longer awaits a discardable `listTerminalSessions()` round trip before auto-creating the first session when there are no persisted `kb-terminal-tabs`; the round trip only produced a no-op filter result in that case. Reload-with-persisted-tabs is unaffected — it still awaits session-list validation.
- fd541bb: summary: Keep the mobile top header on a single line after a foldable phone is unfolded and refolded.
  category: fix
  dev: `.header` now pins `flex-wrap: nowrap` explicitly and `.header-left`/`.header-actions` get an explicit `flex`/`min-width: 0` shrink-and-truncate contract promoted to the base rule (not gated to the `@media (max-width: 768px)` block), so the row cannot wrap even while a foldable's CSS layout viewport lags its `visualViewport` pane mid fold/unfold/refold. `useViewportMode` was audited and already recomputes correctly on that resize sequence (regression test added; no hook change needed).
- 07507f5: summary: Add a one-time server log hint pointing to shell-profile-hygiene docs when a login shell is slow to prompt.
  category: performance
  dev: FN-7688 investigated whether `--login` in `TerminalService.detectShell()`/`createSession()` is a meaningful first-prompt latency contributor. Finding: negligible on lean profiles, additive (~800ms+) when `.zprofile`/`.bash_profile` eagerly sources something slow (e.g. version manager init). `--login` is preserved unconditionally per FN-7686; added `SLOW_LOGIN_PROFILE_HINT_MS` (2000ms) threshold and a one-time, non-blocking `console.info` hint in `createSession()`'s PTY `onData` handler — never alters spawn args, timeouts, or the `retry-without-login` fallback. See `docs/solutions/developer-experience/login-shell-profile-latency.md`.
- 64d4bb7: summary: Fix Anthropic-compatible custom providers registering under an unregistered API key.
  category: fix
  dev: Aligns custom-provider-registry `resolveApiType("anthropic-compatible")` on "anthropic-messages" (the registered pi-ai api key), matching pi.ts `resolveCustomProviderApiType` and removing the latent "No API provider registered for api: anthropic" drift (FN-7690).
- 67cc027: summary: Fix merger awaiting-confirmation copy that implied a hard block when auto-merge proceeds automatically.
  category: fix
  dev: `decidePlannerRecovery` now accepts an additive `autoMergeWillProceed` flag (threaded from `allowsAutoMergeProcessing` in `PlannerRecoveryController.tick`) that only shapes the confirmation `reason` string; no gating/behavior change to `action`/`requiresConfirmation`/`sideEffectClass`.
- 0755fc5: summary: Fix the terminal rendering blank on mobile even though the shell prompt already loaded.
  category: fix
  dev: The global mobile `@media (max-width: 768px) { * { max-width: 100% } }` reset in styles.css also matched xterm's hidden character-measurement subtree (`.xterm-helpers` / `.xterm-char-measure-element`). That subtree's containing block is a 0x0 box, so `max-width: 100%` resolved to 0 and hard-capped xterm's character-cell measurement at 0 — FitAddon.fit() then proposed 0 columns and `.xterm-screen` (plus the WebGL canvas) collapsed to 0x0, so the prompt painted into a zero-size box. Exempt xterm's measurement subtree from that reset (`max-width: none`). Mobile-only; desktop was unaffected. Recurrence of FN-7620/FN-7686.
- 0c1a20b: summary: Fix workspace partial-land recovery losing the already-landed sub-repo sha.
  category: fix
  dev: merger-ai.ts landWorkspaceTask now recovers the EXACT proven landed commit (the task's own Fusion-Task-Id trailer commit, or the recorded landedSha when it is still an ancestor) via findProvenLandedCommit, instead of dropping it when the A1 trailer-fallback proved a sub-repo landed but its sha was never persisted. This avoids attributing a later unrelated integration tip to the repo after an intervening sub-repo land, so finalizeWorkspaceTask builds durable merge proof and the partial-land retry completes to done.
- 0c1a20b: summary: Fix workspace sub-repo worktree creation failing on absent shared branch.
  category: fix
  dev: worktree-acquisition.ts acquireWorkspaceRepoWorktree now strips the shared project integrationBranch/baseBranch overrides before forwarding to acquireTaskWorktree, so FN-7360's freshStartPoint resolution no longer tries to git-worktree-add a branch absent from the sub-repo.
- d8ce3f4: summary: Prevent redundant polling and a re-render loop in agent-card runtime-fallback badges.
  category: fix
  dev: AgentsView now caches one stable ref callback per viewport key (avoids an infinite re-render loop when IntersectionObserver is unavailable) and evicts it on unmount; the test-only toast-dedupe reset is guarded to a no-op in production builds.
- 3744fbc: summary: Clear stale generated mission fix features after their source feature passes validation.
  category: fix
  dev: Reconciles obsolete generated Fix Feature chains during validator pass handling and active mission recovery.
- a8c018f: summary: Stop the false "OAuth token expired" push notification on startup.
  category: fix
  dev: In ProjectEngine.start, OAuthRefreshScheduler.start() now runs before OAuthExpiryMonitor.start() so the proactive refresh renews a stale-but-refreshable access token before the refresh-blind monitor's first awaited check() reads `expires`. Ordering locked by an invocationCallOrder assertion in project-engine.test.ts.
- a734d9f: summary: Preserve Hermes chat session state and project runtime routing more reliably.
  category: fix
  dev: Refreshes cached project chat plugin runners and hardens Hermes CLI session/error handling.
- ac719d1: summary: Stop the usage telemetry log from growing without bound and bloating the Fusion database.
  category: fix
  dev: usage_events was absent from operational-log retention, so it grew unbounded (observed ~187k rows / ~28MB with nothing ever aged out). pruneOperationalLogs now prunes usage_events on the same operationalLogRetentionDays cadence, keyed off its `ts` column (not `timestamp`). Existing rows still require a one-time VACUUM to reclaim on-disk space.

### runfusion.ai

#### Patch Changes

- Updated dependencies [4444262]
- Updated dependencies [1b1e1f1]
- Updated dependencies [ebe9b9f]
- Updated dependencies [03161ad]
- Updated dependencies [13570e8]
- Updated dependencies [9a5a8d2]
- Updated dependencies [1762229]
- Updated dependencies [a486e0b]
- Updated dependencies [9e5c025]
- Updated dependencies [60081fb]
- Updated dependencies [203f879]
- Updated dependencies [81fbb65]
- Updated dependencies [5631c88]
- Updated dependencies [e444581]
- Updated dependencies [1ea3c86]
- Updated dependencies [ca84473]
- Updated dependencies [8d73b18]
- Updated dependencies [ca7c987]
- Updated dependencies [fe5a595]
- Updated dependencies [d54ab80]
- Updated dependencies [a4f5fbc]
- Updated dependencies [a6c60e1]
- Updated dependencies [ebf8f87]
- Updated dependencies [42009cf]
- Updated dependencies [0f2bfa5]
- Updated dependencies [6bf0090]
- Updated dependencies [6777eea]
- Updated dependencies [413ef1d]
- Updated dependencies [51e3891]
- Updated dependencies [5b243f1]
- Updated dependencies [1b7bb1f]
- Updated dependencies [4e8c621]
- Updated dependencies [f1db313]
- Updated dependencies [923bba7]
- Updated dependencies [009ce26]
- Updated dependencies [563a8c6]
- Updated dependencies [bec8987]
- Updated dependencies [ce4f173]
- Updated dependencies [efabdd6]
- Updated dependencies [7c7b22e]
- Updated dependencies [dfb084c]
- Updated dependencies [e29fea3]
- Updated dependencies [511bcaf]
- Updated dependencies [f7d9509]
- Updated dependencies [97e4667]
- Updated dependencies [dd9fa2d]
- Updated dependencies [7cf70b3]
- Updated dependencies [aa534c1]
- Updated dependencies [8ee8f15]
- Updated dependencies [297c744]
- Updated dependencies [a4fce60]
- Updated dependencies [83e7743]
- Updated dependencies [a832b79]
- Updated dependencies [fd541bb]
- Updated dependencies [07507f5]
- Updated dependencies [461a4a2]
- Updated dependencies [64d4bb7]
- Updated dependencies [67cc027]
- Updated dependencies [0755fc5]
- Updated dependencies [0c1a20b]
- Updated dependencies [0c1a20b]
- Updated dependencies [d8ce3f4]
- Updated dependencies [3744fbc]
- Updated dependencies [a8c018f]
- Updated dependencies [a734d9f]
- Updated dependencies [ac719d1]
  - @runfusion/fusion@0.57.0

## 0.56.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.56.1
- @fusion/engine@0.56.1
- @fusion/i18n@0.39.21
- @fusion-plugin-examples/cli-printing-press@0.1.38
- @fusion-plugin-examples/compound-engineering@0.1.21
- @fusion-plugin-examples/dependency-graph@0.1.52
- @fusion-plugin-examples/roadmap@0.1.40
- @fusion-plugin-examples/cursor-runtime@0.1.40
- @fusion-plugin-examples/droid-runtime@0.1.47
- @fusion-plugin-examples/hermes-runtime@0.2.71
- @fusion-plugin-examples/openclaw-runtime@0.2.71
- @fusion-plugin-examples/paperclip-runtime@0.2.71

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.56.1
- @fusion/dashboard@0.56.1
- @fusion/engine@0.56.1

### @fusion/engine

#### Patch Changes

- @fusion/core@0.56.1
- @fusion/pi-claude-cli@0.56.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.56.1

### @runfusion/fusion

#### Patch Changes

- ed823c7: summary: Fix Anthropic subscription showing "logged in" while all model calls fail.
  category: fix
  dev: Two-part fix. (1) OAuth token refresh in `packages/engine/src/auth-storage.ts` sent a `scope` param (defaulting to `user:profile`), which per RFC 6749 §6 re-issued the access token narrowed to that scope and stripped `user:inference` — so refreshed tokens 403'd on every model call. Refresh now omits `scope` (preserving the originally-granted scopes, matching pi-ai's own refresh), and `ANTHROPIC_DEFAULT_SCOPES` mirrors the full Claude Code scope set. (2) `/auth/status` now reports an unexpired Anthropic OAuth token that lacks an inference scope as not-connected (authenticated:false, expired:true so the re-login banner fires) with a scope-specific loginError, instead of falsely claiming a live session. Existing narrowed tokens need one re-login to obtain a fresh broad grant.
- dc44730: summary: Fix "Invalid transition" error when moving cards out of a custom workflow column like Coding (Ideas) → Ideas.
  category: fix
  dev: moveTaskInternal's compat-flag legacy path validated moves against the legacy VALID_TRANSITIONS table, which is keyed only by the built-in column ids; a task in a non-legacy workflow column (e.g. "ideas") had no key and every move was rejected. The legacy branch now resolves a non-legacy source column's targets from the task's own workflow adjacency (resolveAllowedColumns) while preserving the legacy bare-Error contract for legacy columns.
- b9d60b3: summary: Fix overlapping Record and Clear buttons in the Keyboard Shortcuts settings rows on desktop and mobile.
  category: fix
  dev: The shortcut-capture Record/Clear buttons no longer use the icon-only `btn-icon` class (which set `line-height:0` and a mobile 36px square, clipping/overlapping the text labels); they use a text-button class and the `.shortcut-capture` row locks buttons with `flex-shrink:0` so the input and controls never overlap, stacking cleanly on mobile.
- e347062: summary: Fix persistent mobile terminal inter-character spacing (5th recurrence root cause).
  category: fix
  dev: xterm's CharSizeService picks a Canvas-based (OffscreenCanvas) or DOM-based character-measurement strategy at terminal.open() time; DomRenderer's letter-spacing bake always measures via a separate DOM-based WidthCache, so a Canvas-vs-DOM measurement mismatch survived FN-7561/FN-7567's remeasure-ordering fixes. `withDomBasedTerminalCharacterMeasurement` in terminalPreferences.ts forces CharSizeService onto the same DOM strategy for both TerminalModal and SessionTerminal.
- f4f1656: summary: Fix manual PR actions hidden when a task auto-merge override was on but global auto-merge was off.
  category: fix
  dev: TaskDetailModal isManualPrFlow now keys off live global autoMergeEnabled, not the per-task effective override (regression from FN-7255).

### runfusion.ai

#### Patch Changes

- Updated dependencies [ed823c7]
- Updated dependencies [dc44730]
- Updated dependencies [b9d60b3]
- Updated dependencies [e347062]
- Updated dependencies [f4f1656]
  - @runfusion/fusion@0.56.1

## 0.56.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.56.0
- @fusion/engine@0.56.0
- @fusion/i18n@0.39.20
- @fusion-plugin-examples/cli-printing-press@0.1.37
- @fusion-plugin-examples/compound-engineering@0.1.20
- @fusion-plugin-examples/dependency-graph@0.1.51
- @fusion-plugin-examples/roadmap@0.1.39
- @fusion-plugin-examples/cursor-runtime@0.1.39
- @fusion-plugin-examples/droid-runtime@0.1.46
- @fusion-plugin-examples/hermes-runtime@0.2.70
- @fusion-plugin-examples/openclaw-runtime@0.2.70
- @fusion-plugin-examples/paperclip-runtime@0.2.70

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.56.0
- @fusion/dashboard@0.56.0
- @fusion/engine@0.56.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.56.0
- @fusion/pi-claude-cli@0.56.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.56.0

### @runfusion/fusion

#### Minor Changes

- d16c8b4: summary: Expand first-run AI provider quick-start choices beyond Anthropic.
  category: feature
  dev: Moves advanced/all-provider onboarding controls under the quick-start provider section.
- 315f3bc: summary: Show Git prerequisite guidance during first-run GitHub onboarding.
  category: feature
  dev: Adds bounded server-host git availability to auth status and onboarding.
- 50cdab1: summary: Add GitHub OAuth and CLI setup actions to first-run onboarding.
  category: feature
  dev: GitHub onboarding now shows in-flow OAuth connect, gh auth login, and gh install guidance.
- 2f23d22: summary: Add configurable dashboard keyboard shortcuts for Quick Chat and Terminal.
  category: feature
  dev: Global dashboardKeyboardShortcuts settings, guarded document-level key handling, and Escape topmost-popup dismissal.
- efa8105: summary: Add search in Settings so operators can find settings faster.
  category: feature
  dev: Dashboard Settings filters visible sections by setting labels and keywords.
- 7d8a1b8: summary: Add a pinned below-application layout option for the dashboard terminal.
  category: feature
  dev: Terminal display mode now supports persisted docked, floating, and below layouts, with header controls replacing the footer shell.
- 87a700c: summary: Add a Reset Settings button to restore a menu's or all project settings to defaults.
  category: feature
  dev: New tested section→keys (scope-aware) registry (packages/dashboard/app/components/settings/section-keys.ts) drives per-menu reset via updateSettings/updateGlobalSettings with null-as-delete; non-blob sections (secrets, MCP, plugins, memory, auth, prompts, CLI agents, runtimes) are excluded with a documented reason.
- 68f5153: summary: Add a per-workflow planner oversight level setting (Off, Observe, Steer, Autonomous recovery).
  category: feature
  dev: New workflow setting `plannerOversightLevel` declared in BUILTIN_OVERSIGHT_SETTINGS; default `autonomous`. Per-task override and engine behavior land in follow-up tasks.
- aa757bc: summary: Tasks can override the workflow planner oversight level (Off, Observe, Steer, Autonomous recovery).
  category: feature
  dev: New nullable Task.plannerOversightLevel field (migration 137, SCHEMA_VERSION 137) mirroring executionMode; NULL inherits the workflow setting. Adds resolveEffectivePlannerOversightLevel precedence helper. Dashboard UI/API threading and engine behavior land in follow-up tasks.
- 0689250: summary: Planner oversight now defaults to full steering/control for every workflow unless explicitly changed.
  category: feature
  dev: Confirms the `plannerOversightLevel` workflow-setting default is the highest (autonomous) level; unset workflow value and unset per-task override both resolve to full steering via `resolveEffectivePlannerOversightLevel` (task override → workflow effective value → autonomous), adding dedicated regression coverage for the "unless explicitly disabled" precedence.
- 12a6d1b: summary: Planner oversight now monitors tasks across executor, reviewer, merger, pull-request, and workflow-gate stages.
  category: feature
  dev: Adds records-only PlannerOverseerMonitor + resolveWatchedStage + OverseerStageObservation in @fusion/engine, gated by resolveEffectivePlannerOversightLevel (off = no observation) and wired into ProjectEngine via a bounded poll. Steering/recovery and UI land in FN-7512/FN-7515+.
- 81f2053: summary: Planner oversight can autonomously inject guidance, retry stuck/failed steps, and request fixes within bounded limits.
  category: feature
  dev: Adds pure `decidePlannerRecovery` + recovery types (core) and `PlannerRecoveryController` with injected guidance/retry/targeted-fix handlers (engine), consuming the FN-7511 observation. Acts only at effective level `autonomous`, caps attempts per (task, stage) via `PLANNER_RECOVERY_MAX_ATTEMPTS`, skips user-paused tasks, and excludes merge/PR/destructive actions (deferred to FN-7513) and comprehensive human-control safeguards (FN-7514).
- 2cc84b5: summary: Planner oversight now requires confirmation before merge/PR actions and destructive/external side effects.
  category: feature
  dev: Adds `PlannerActionSideEffectClass` + `PlannerConfirmationRequest` and `classifyPlannerActionSideEffect`/`requiresPlannerConfirmation` (core), extends `decidePlannerRecovery` with an `await_confirmation` action, and adds `requestConfirmation`/`resolveConfirmation` gating to `PlannerRecoveryController` (engine). Merge/PR and destructive/external actions never execute without a recorded approval; bounded recovery (guidance/retry/targeted-fix) is unchanged. UX rendering, human-control safeguards, timeline, and run-audit land in follow-up tasks.
- 79ab367: summary: Planner overseer now stays fully hands-off for paused tasks and auto-merge-off / human-review tasks.
  category: feature
  dev: Adds the pure `evaluateOverseerHumanControl` policy (packages/engine/src/overseer-human-control-policy.ts), consulted at the top of `PlannerRecoveryController.tick()` before any action classification, confirmation gating, steering, retry, or dispatch — so a user-paused or `autoMerge:false`/human-review task never even records a pending confirmation. Reuses `allowsAutoMergeProcessing` from `@fusion/core` verbatim (never re-derives the auto-merge/human-review predicate). Distinguishes explicit user pause (`task.userPaused===true`, or `task.paused===true` with no `pausedReason`) from engine/self-healing parks (which always stamp a `pausedReason`). Emits a bounded `overseer:oversight-withheld-human-control` run-audit no-action event (metadata: `{ taskId, reason, stage, oversightLevel }`), deduped per (taskId, reason) so it does not spam every poll.
- c16cc9e: summary: Configure planner oversight level per task and per project in the workflow editor and task create/detail.
  category: feature
  dev: Per-task `plannerOversightLevel` override exposed via TaskForm (Inherit/off/observe/steer/autonomous), threaded through createTask/updateTask; workflow-editor Values tab gets a first-class display entry. Workflow-native setting; not a project setting.
- aae603b: summary: Add a configurable planner-overseer notification verbosity level (Silent/Errors/Important/All).
  category: feature
  dev: New workflow-native enum setting `plannerOversightNotificationLevel` in BUILTIN_OVERSIGHT_SETTINGS; default `important`. Resolves via resolveEffectiveSettings; emission gating that reads it lands in FN-7519/FN-7520.
- d10ea9a: summary: Add a task-detail planner-overseer intervention timeline (stage, reason, action, outcome, attempts, links).
  category: feature
  dev: New core `PlannerInterventionEntry` model + `recordPlannerIntervention`/`getPlannerInterventionTimeline` helpers persisting via the run-audit store under the `overseer:intervention` mutation, plus a `PlannerInterventionTimeline` component rendered in the task-detail Planner Oversight cluster. Emission call-sites land in FN-7520.
- bf68839: summary: Emit planner-overseer run-audit events for observations, steering, retries, recovery, confirmations, and escalations.
  category: feature
  dev: New core emitters (emitOverseerObservation/Steering/RecoveryAttempt/Retry/Confirmation/Escalation) in planner-overseer-events.ts, each mapping its decision-point to the correct intervention action/outcome and delegating to FN-7519's recordPlannerIntervention under the overseer:intervention mutation. Producer call-sites land in FN-7511/FN-7512/FN-7513.
- c4d81fe: summary: Add an AI-undo fallback task when reverting a done task via git conflicts or is unsupported.
  category: feature
  dev: `POST /api/tasks/:id/revert` now accepts `{ mode?: "git" | "ai" | "auto" }` (default `"auto"`). `"auto"` tries the FN-7523 git-revert path first and falls back to creating an AI-undo board task (`{ mode: "ai", createdTaskId, alreadyOpen? }`) on a conflicting or unsupported (e.g. workspace) git result; `needsHuman` (autoMerge-off) never triggers the fallback. `"ai"` always creates the AI-undo task; `"git"` keeps the FN-7523 git-only contract, which is otherwise unchanged. New engine exports: `createAiUndoTask`, `buildAiUndoTaskDescription`, `REVERT_OF_METADATA_KEY`. New core store method `TaskStore.findOpenRevertTaskForSource` backs the idempotency guard (an open undo task suppresses a duplicate; a closed one does not).
- e7cb2f1: summary: Add a Revert action to Done/Archived task cards to undo landed changes.
  category: feature
  dev: Wires onRevertTask through Board/List/Detail surfaces; calls POST /tasks/:id/revert in "auto" mode with a conflict-confirm AI-undo fallback (mode: "ai").
- 5ad8ec8: summary: Capture a structured performance snapshot when an agent task completes.
  category: feature
  dev: New AgentReflectionService.captureTaskPerformance persists a non-LLM post-task ReflectionMetrics record (duration, packages/files touched, verification command + scope, retry/rework count) and emits ids/counts-only `reflection:captured` run-audit telemetry; populates performanceSummary/latestReflection.
- 726cbf8: summary: Task cards can now show the planner overseer's active state (idle/watching/steering/recovering/awaiting-confirmation).
  category: feature
  dev: Adds a serializable `PlannerOverseerRuntimeSnapshot` + pure `derivePlannerOverseerState` (core), a read-only `ProjectEngine.getPlannerOverseerRuntimeSnapshot(taskId)` accessor assembling it from the FN-7511 monitor + FN-7512/7513 recovery controller, and a best-effort additive `plannerOverseerState` enrichment on `GET /api/tasks` (mirrors the `branchProgress` pattern; never persisted, never fails the board load). Consumed by FN-7516's TaskCard.
- 2ed06f9: summary: Support reverting multi-repo workspace tasks via git, all-or-nothing across sub-repos.
  category: feature
  dev: Extends `packages/engine/src/task-revert.ts` with `resolveWorkspaceTaskRevertCommits`/`revertWorkspaceTask` and wires `POST /api/tasks/:id/revert` to dispatch workspace tasks (`isWorkspaceTask`) to the new path; returns `{ mode: "git", clean, workspace: { repos: [...] }, conflicts? }`. Single-repo `performTaskRevert` path is unchanged.
- 8c6f76c: summary: Add per-sha revert commit granularity to the task revert API and service.
  category: feature
  dev: `performTaskRevert` and `POST /api/tasks/:id/revert` accept an optional `granularity: "squash" | "per-sha"` (default `"squash"`, unchanged FN-7523 behavior). `"per-sha"` creates one attributed `revert(FN-xxxx)` commit per original sha (each with its own `Fusion-Task-Id` trailer and audit line), skipping no-op shas without empty commits. A mid-batch conflict in either mode rolls back the whole batch to the pre-call HEAD — no partially-landed per-sha commits. The clean result now reports `revertCommitShas: string[]` (all created commits) alongside the existing `revertCommitSha` (kept for backward compatibility).
- f992e6a: summary: Add a dedicated Keyboard Shortcuts settings section with click-to-record capture and more configurable actions.
  category: feature
  dev: Relocates dashboardKeyboardShortcuts into its own settings section, adds a ShortcutCaptureInput recorder, and extends DashboardShortcutAction with openFiles/openSettings/openCommandCenter/newTask actions wired into existing App nav handlers.
- 2df6c35: summary: Open a revert PR for done/archived tasks when autoMerge is disabled instead of refusing.
  category: feature
  dev: `POST /api/tasks/:id/revert` gains an additive `{ mode: "pr", clean: true, prUrl, prNumber, revertBranch, existingPr? }` result for clean single-repo reverts under `autoMerge:false`, reusing `GitHubClient.createPr`, `findPrForBranch` idempotency, and the `manual:true` PR handoff. New engine export `prepareRevertPrBranch` (packages/engine/src/task-revert.ts) prepares the dedicated `fusion/revert-<id>` branch without ever mutating the base branch. Existing `{ mode: "git" | "ai", ... }` shapes and the `autoMerge:true` path are unchanged.
- 94e9d15: summary: AI-undo tasks now default to a configurable, stricter review workflow.
  category: feature
  dev: New project setting `aiUndoTaskWorkflowId` (default `builtin:review-heavy`) selects the workflow for AI-undo board tasks created by `POST /api/tasks/:id/revert` (`mode: "ai"`, the `auto` conflict fallback, and the workspace conflict fallback all share the `createAiUndoResult()` closure, so all three inherit this default). A blank/unset value means the created task inherits the project default workflow (pre-FN-7556 behavior). The route validates the configured id via `getWorkflowDefinition`/`isBuiltinWorkflowId` and falls back to inherit (with a logged warning) on a blank or unknown value, so a misconfigured id never breaks AI-undo task creation. The engine's `createAiUndoTask` helper stays pure — it only forwards a `workflowId` it is given, never resolves the setting itself. The Settings Modal UI field for this setting is a deliberate follow-up task; the value is settable today only via the settings API.
- 3dd227b: summary: Plan auto-approval is now the default; specified tasks skip manual approval unless you opt into workflow/require-all.
  category: feature
  dev: `DEFAULT_PROJECT_SETTINGS.planApprovalMode` flips `workflow` → `auto-approve-all`; existing projects with an explicit stored value are unchanged; consumed by `resolvePlanApprovalRequired` at the triage gating sites.
- 78d4db9: summary: Fusion self-repo issue-close comments now show current and target release versions.
  category: feature
  dev: GitHubIssueCommentService appends "Current version: v{current}" and "Target release: v{next-minor}" lines when the linked source issue is runfusion/fusion; other repos unchanged. Version resolved via getCliPackageVersion.
- 7435849: summary: Open one revert PR per sub-repo for workspace tasks when autoMerge is disabled.
  category: feature
  dev: `POST /api/tasks/:id/revert` gains an additive workspace `{ mode: "pr", clean: true, workspace: { repos: [{ repo, revertBranch, prUrl, prNumber, existingPr? }] } }` result for clean multi-repo reverts under `autoMerge:false`, extending FN-7554's single-repo `mode:"pr"` path. New engine export `prepareWorkspaceRevertPrBranches` (packages/engine/src/task-revert.ts) classifies every sub-repo first and only prepares a dedicated `fusion/revert-<id>` branch per sub-repo when all are clean/already-reverted (all-or-nothing at the branch-prep phase), never force-writing any sub-repo integration branch. The route resolves owner/repo and checks the rate limiter for every sub-repo before pushing/creating any PR, so GitHub-unconfigured/rate-limited cases degrade the whole task to `needsHuman` rather than opening a partial subset of PRs. Existing `{ mode: "git" | "ai" | "pr", ... }` shapes, the `autoMerge:true` workspace path, and FN-7554's single-repo path are unchanged.
- 73b38ba: summary: Add a Settings → General picker to choose the workflow used for AI-undo (revert) tasks.
  category: feature
  dev: Surfaces `aiUndoTaskWorkflowId` (default `builtin:review-heavy`) in GeneralSection; empty selection means "inherit project default workflow", matching the revert route's blank-is-inherit behavior from FN-7556.
- 42bbe58: summary: Add "Ask user question" and "Exit gate" workflow nodes for mid-flow chat reach-out and early exit.
  category: feature
  dev: New IR node kinds `ask-user` (reuses await-input park/resume; surfaces the question in the task chat) and `exit-gate` (terminates the workflow early, optional condition). Editor palette + summaries + help updated; `prompt`+`awaitInput` remains a back-compat alias.
- 53fe0d7: summary: Add a built-in "Brainstorming" workflow that talks to you before planning.
  category: feature
  dev: Registers `builtin:brainstorming` (non-default, default-enabled) composing FN-7579's `ask-user` → refine → `exit-gate`-on-approval phase ahead of the normal coding plan/execute/review/merge spine. Parity suite (`builtin-workflows.test.ts`) extended for the new entry.
- ecbbb29: summary: Add a "Coding (Ideas)" workflow with a manual Ideas intake and a merged Todo planner column.
  category: feature
  dev: New `builtin:coding-ideas` clones the default stepwise pipeline with an `ideas` intake (autoTriage:false) in front of a merged `todo` planner+capacity column. createTask lands cards in the workflow's intake column; the triage service plans unplanned todo tasks in place; the scheduler skips bootstrap-prompt todo tasks; TaskCard gains a Start button and a Ready badge.

#### Patch Changes

- 8668a05: summary: Add a workflow setting to disable automatic large-task triage splitting.
  category: feature
  dev: Adds triageProactiveSubtaskSplittingEnabled while preserving explicit breakIntoSubtasks requests.
- 978cdda: summary: Show active Plan Review progress on triage task cards.
  category: fix
  dev: TaskCard now renders the existing progress affordance for Triage only when unified progress has active workflow work.
- 635fca2: summary: Remove the eye icon markdown/plain toggle from chat; messages always render as Markdown.
  category: breaking
  dev: Removed ChatView `chat-thread-header-render-toggle` (desktop + mobile), `showAllAsPlain` state, and `chat.showRenderedMarkdown`/`chat.showPlainText` i18n keys (FN-7541).
- 3d55102: summary: Clarify task-detail oversight Nudge/Explain controls: visible label, disabled reason, always-openable Explain panel.
  category: fix
  dev: TaskDetailModal now renders a `detail-oversight-controls-label` group label and `detail-overseer-nudge-disabled-reason` helper text (both gated by the existing oversight-cluster visibility condition); Explain no longer disables on `!canExplainOverseer` since it is read-only. Nudge's `canNudgeOverseer` gate and Stop's confirm dialog are unchanged.
- 0f1cd0a: summary: Unify border, radius, and height of the task-detail Priority/Execution/Oversight controls.
  category: fix
  dev: Adds a shared --detail-control-border-radius token alongside --detail-priority-control-min-height so .detail-priority-chip, .detail-execution-mode-toggle, .detail-oversight-chip, and .detail-oversight-menu-trigger all resolve the same border-width/color/radius/height.
- b42ba9f: summary: Keep the task-detail Activity view menu open during mobile iOS taps.
  category: fix
  dev: Guards the Activity views dropdown against iOS visualViewport resize/scroll echoes during menu opening.
- a7559b0: summary: Fix Anthropic subscription login when pasted callback URLs contain fragment OAuth parameters.
  category: fix
  dev: Normalizes pasted OAuth callback fragments before resolving dashboard manual-code login prompts.
- 4b530a6: summary: Fix Claude/Anthropic subscription re-login showing "Login did not complete" after logging out.
  category: fix
  dev: Anthropic subscription OAuth is aliased across the legacy `anthropic` row (where interactive login persists the credential) and the `anthropic-subscription` id (where the settings card's in-memory logged-out suppression and status read are keyed). Re-login wrote only `anthropic`, so `loggedOutProviders` kept suppressing `anthropic-subscription` and the card reported failure despite a valid stored credential until process restart. auth-storage's proxy now clears the logged-out state on both aliases when either is re-authenticated (new `login` trap + hardened `set` trap via `clearReauthenticatedLogoutState`; raw api_key writes stay scoped to their own card). Also surfaces background OAuth login failures on `GET /auth/status` (`loginError`) + server logs so future paste-callback failures are diagnosable instead of a generic error.
- a5ac3c3: summary: Stop self-healing from killing actively-running tasks after ~30 minutes.
  category: fix
  dev: FN-7566. isPhantomExecutorBinding's liveness gate (heartbeat/checkout/runAudit) was blind to ephemeral executor agents, leaving only the age>graceMs\*3 threshold, so any ephemeral-executor task running longer than ~30 min was reclaimed to `todo` mid-flight. Adds the in-process live-session veto (activeSessionRegistry path / executingTaskLock / isTaskActive), mirroring the isWorkspaceTaskLive/sessionDead predicate, and honors clearPhantomExecutorBinding's live-session refusal in reclaimSelfOwnedBranchConflicts.
- 8912399: summary: Stop Windows Terminal version dialogs from popping up when opening the dashboard or Settings on Windows.
  category: fix
  dev: Root cause was the worktrunk integration, not the embedded terminal: worktrunk's CLI is named `wt`, which collides with Windows Terminal (`wt.exe`) on PATH, so probing it with `wt --version` launched Windows Terminal. Fixed by (1) `useWorktrunkInstallStatus` only auto-fetching `/api/worktrunk/status` when the integration is enabled (user opt-in) instead of on every Settings/dashboard mount, and (2) an engine-level guard in `probeWorktrunk` that refuses to exec a resolved `wt` that is the Windows Terminal alias (under `WindowsApps` / a `WindowsTerminal` package dir), covering all resolution surfaces.
- b800f7d: summary: Select newly created folders automatically during project setup.
  category: fix
  dev: Adds DirectoryPicker opt-in selection for project-registration surfaces while preserving default picker behavior.
- 9dc248e: summary: Prevent Desktop update banners from using 0.0.0 as the current version.
  category: fix
  dev: Dashboard update checks now resolve packaged @fusion/desktop metadata and fail closed for unresolved versions.
- 52dbc0e: summary: Quit Fusion Desktop on Windows when the window is closed.
  category: fix
  dev: Updates Electron close lifecycle so Windows shutdown reaches embedded runtime cleanup.
- ced783e: summary: Open desktop Anthropic Subscription OAuth logins in the system browser.
  category: fix
  dev: Adds Electron window-open policy coverage and preserves Settings auth polling completion paths.
- 50786f2: summary: Delay GitHub setup warnings for one day and add a dashboard connect action.
  category: fix
  dev: Dashboard setup warnings now gate GitHub prompts per project and route the CTA to Settings → Authentication.
- b4b1f6d: summary: Fix a false AI engine not running banner in desktop mode.
  category: fix
  dev: Distinguishes transient embedded desktop engine startup from true dashboard-only mode.
- e8b7362: summary: Clarify the desktop Connection Manager add-remote flow.
  category: fix
  dev: Desktop Connection Manager now separates Local Server context from saved remote profiles and collapses the remote editor until add/edit.
- 0900a38: summary: Restore Local Server in the desktop Switch server list.
  category: fix
  dev: Desktop Connection Manager now lists local and saved remote destinations together.
- a2b09f2: summary: Make right-dock task list clicks respect the task popup setting.
  category: fix
  dev: Threads openMobileTasksInPopup through the right-dock Tasks list route while preserving embedded dock detail when disabled.
- 0f05156: summary: Auto-retry retryable Code Review remediation failures.
  category: fix
  dev: Prevents retryable code-review-remediation graph failures from stranding tasks in in-review.
- 20184ac: summary: Fix no-op task branch recovery after a previously landed task.
  category: fix
  dev: Merge/recovery ownership classification now checks no-diff branches before foreign trailer rejection.
- 82493e0: summary: Allow documented source-free task-artifact deliveries to finish without commits.
  category: fix
  dev: fn_task_done now recognizes explicit gitignored .fusion/tasks artifact contracts while preserving source-change no-commit guards.
- 5689346: summary: Fix direct merges so Push to remote after merge honors the configured remote and branch.
  category: fix
  dev: Resolves remote-only push targets from the merge integration branch and preserves non-fatal push errors on done tasks.
- b42be87: summary: Keep task popups on the board layer with Activity menus above them.
  category: fix
  dev: Task-detail FloatingWindow callers use a lower layer band, and Activity view menus reposition after popup geometry changes.
- 61c8bdc: summary: Keep accepted chat requests waiting instead of showing false first-event timeout failures.
  category: fix
  dev: Dashboard chat POST streams no longer abort accepted-but-silent responses on the client first-event timer.
- e8dc2ae: summary: Show each task's original prompt in the Plan tab alongside the generated plan.
  category: fix
  dev: Adds a read-only Task Detail original-prompt section backed by task.description.
- d2e3134: summary: Add before-to-after transformation summaries to generated task definitions.
  category: feature
  dev: Built-in standard and fast triage prompts now require a `## Before → After Transformation` section.
- b0208c1: summary: Restore terminal Ctrl/Cmd copy and paste shortcuts.
  category: fix
  dev: Integrated and embedded terminals now own physical clipboard paste to avoid swallowed or duplicate input.
- 2797803: summary: Show first-token and tool processing durations in task agent logs.
  category: feature
  dev: Adds optional agent-log timing fields `timeToFirstTokenMs` and `durationMs`.
- a2d6349: summary: Fix mobile Chat composer being hidden behind the keyboard accessory bar.
  category: fix
  dev: Adds keyboard-open bottom clearance in ChatView so the composer clears the iOS input-assistant/autofill bar without a persistent .chat-thread transform or Android reserved-gap.
- 4baa4c4: summary: Settings descriptions now show each setting's default value.
  category: feature
  dev: Appended default-value copy to settings.\* i18n descriptions across Global, Runtimes, and Project Settings sections, sourced from DEFAULT_GLOBAL_SETTINGS/DEFAULT_PROJECT_SETTINGS in settings-schema.ts; added settings-default-descriptions.test.tsx guarding that every surfaced setting states a default (or explicit "inherits"/"no default \u2014 unset") and that every DEFAULT_SETTINGS key is documented or allowlisted as not surfaced.
- 53d7b7e: summary: Add an intelligent git-revert engine service and POST /api/tasks/:id/revert route.
  category: feature
  dev: New `packages/engine/src/task-revert.ts` exports `resolveTaskRevertCommits`, `classifyTaskRevert`, and `performTaskRevert` (squash/rebase/lineage attribution precedence, dry-run classification, guaranteed-clean rollback). Route enforces done/archived-only and autoMerge-off guard rails; conflicting results are returned unresolved for sibling FN-7524 (AI-undo) to act on. Workspace tasks return `unsupported`.
- 4707eb5: summary: Auto-approve now reliably sends specified plans to the board without a manual approval stop.
  category: fix
  dev: FN-7526 — investigated the reported "plans still park at awaiting-approval when auto-approve is on" symptom; resolvePlanApprovalRequired, mergeEffectiveSettings/applyWorkflowSettingsOverlay, and every finalizeApprovedTask call site (specifyTask, recoverApprovedTask, retryUnavailablePlanReview, tryFinalizeExplicitDuplicateMarker) already honored project planApprovalMode: "auto-approve-all" over a stored workflow requirePlanApproval value — no production defect reproduced. Added end-to-end regression coverage across every enumerated surface (Plan Review reviewer-outage retry, refinement routing, self-healing starved-refinement recovery) using the real mergeEffectiveSettings pipeline instead of isolated bare-settings unit calls, plus explicit assertions that the independent release-authorization and Workflow Plan Review gates remain intact under auto-approve-all, so a future bare-settings call site is caught immediately instead of silently reintroducing the reported behavior.
- 3b52a4d: summary: Fix the in-dashboard Switch server menu not switching desktop local/remote.
  category: fix
  dev: The desktop shell's redirect effects in App.tsx read a dead `localServer` field that the preload never populates; extracted `resolveDesktopShellRedirectTarget` in appLifecycle.ts now derives the navigation target from the live `localRuntime`/`activeProfileId` state for both directions, and the unused `localServer` field was removed from `ShellConnectionState`.
- 36bd74e: summary: Fix branch group completion checklists to show accurate landed/finished counts.
  category: fix
  dev: runAiMerge (the sole merge path since master-plan U0) never resolved branch-group routing or stamped mergeDetails.mergeTargetBranch/mergeTargetSource, so isBranchGroupMemberLanded permanently reported shared-group members as not landed. Routes through resolveBranchGroupMergeRouting (matching the legacy merger.ts pattern) and stamps the target fields on both the landed and no-op finalize paths; preserves merge-target-safety in isBranchGroupMemberLanded (a sibling/mismatched-branch member still never counts as landed).
- df0be88: summary: Branch groups no longer report complete (or become promotable) when an unlanded member is archived.
  category: fix
  dev: listTasksByBranchGroup membership now scans with includeArchived:true so an archived-but-unlanded member stays counted in total instead of silently dropping out; mergeDetails is now persisted on ArchivedTaskEntry so an archived member that had already landed keeps counting as landed. evaluateBranchGroupCompletion / promoteBranchGroup gate correctly; merge-target-safety in isBranchGroupMemberLanded is unchanged.
- ec9ac61: summary: Fix the global GitLab integration setting not persisting when saved.
  category: fix
  dev: splitSettingsSave now diffs the five global GitLab keys (gitlabEnabled, gitlabInstanceUrl, gitlabApiBaseUrl, gitlabAuthToken, gitlabAuthTokenType) against scoped global initials only, never the project-effective merged initialValues, so a project override no longer suppresses a real global save.
- 8d36b99: summary: Fix task-detail Activity view dropdown not opening reliably on mobile.
  category: fix
  dev: Guards the Activity menu's window resize/orientationchange/scroll close-listener with the same opening-tap timing guard already used for visualViewport, and exempts scroll events originating in the `.detail-tabs` scroller, so a same-gesture mobile tap echo (Android/iOS, fixed modal or `.floating-window--task-detail` popup) no longer closes the menu the instant it opens.
- ad744aa: summary: Manual "Run now" for the Database Backup automation now runs in-process like the scheduler, matching cron behavior.
  category: fix
  dev: The legacy single-command and command-step manual automation run path (`executeSingleCommand` in packages/dashboard/src/routes.ts) now intercepts `isInProcessBackupCommand`/`isInProcessMemoryBackupCommand` via the scoped TaskStore, mirroring `RoutineRunner.executeCommand`/`CronRunner`, instead of always shelling out via `exec()`. `formatInProcessBackupError`, `isInProcessBackupCommand`, and `isInProcessMemoryBackupCommand` are now exported from `@fusion/engine` for reuse. Existing onStep/onText live-run callbacks already stream incremental output for command/backup runs; added regression coverage confirming this holds for the new interception branch.
- 5c3d58a: summary: Task cards no longer show the "Auto-recovery" oversight badge unless oversight is explicitly configured.
  category: fix
  dev: `TaskCard.tsx`'s `showOversightBadge` gate now also suppresses the badge when the effective level equals `DEFAULT_PLANNER_OVERSIGHT_LEVEL` ("autonomous") and there is no explicit per-task `plannerOversightLevel` override; an explicit per-task override of "autonomous" still renders the badge.
- b4be515: summary: Remove the per-card overseer-state ("Executor") badge from task cards.
  category: fix
  dev: Deleted the FN-7516 `card-overseer-state-badge` render, its card-local `deriveOverseerCardWatchedStage` helper/label maps, and its CSS; the sibling oversight-level badge (`card-oversight-badge`) is unaffected.
- 62ddb19: summary: Original task prompt now renders as Markdown and is collapsed by default in the task Plan tab.
  category: feature
  dev: Task Detail Plan/Definition tab original-prompt section reuses the existing `.detail-source-toggle`/`.detail-source-chevron--expanded` collapse pattern and the shared `ReactMarkdown` pipeline (`remarkGfm`, `sharedRehypePlugins`, `markdownLinkifyComponents`); backed by read-only `task.description`, no change to the generated `PROMPT.md` editor/revision flow.
- 883c73e: summary: Fix agent-created artifacts not appearing live in the dashboard artifacts view.
  category: fix
  dev: Root cause was cross-instance artifact-registration replication, not the route/hook/render path (all already correct). `TaskStore.registerArtifact()` never bumped `lastModified`, and `checkForChanges()` (the polling replicator that lets a second TaskStore instance on the same project — e.g. the dashboard's cached store vs. the engine's own store — mirror events it did not write itself) only ever diffed the `tasks` table, never `artifacts`. A store instance that did not perform the write could therefore never observe or re-emit `artifact:registered`, leaving an already-open Documents/task Artifacts gallery stale until a full reload. Fixed by bumping `lastModified` on artifact writes and adding a strictly-increasing `rowid`-cursor poll over the `artifacts` table in `checkForChanges()`. See `packages/core/src/__tests__/artifacts.test.ts` and `packages/dashboard/src/routes/__tests__/artifacts-route-integration.test.ts` for regression coverage.
- d09b57f: summary: Fix the mobile terminal shortcut bar so it scrolls horizontally to reach every key.
  category: fix
  dev: Added `min-width: 0` to `.terminal-shortcut-panel` to defeat the flex min-width:auto trap that clipped overflow instead of engaging `overflow-x: auto`.
- 3d58260: summary: Planner-oversight intervention timeline now populates from real engine activity.
  category: fix
  dev: Wires PlannerOverseerMonitor/PlannerRecoveryController decision points to the FN-7520 emitOverseer\* façade with the real TaskStore; observation/escalation emission deduped per (task, stage[, signal]).
- 052a277: summary: Show the "Global" prefix on the Authentication entry in the mobile Settings picker.
  category: fix
  dev: resolveSettingsSectionOptionLabel now derives the Global-group prefix for storage-less (scope: undefined) sections in SettingsModal.tsx (FN-7552).
- 6e4c207: summary: Tasks held for release authorization or Plan Review are now shown distinctly, so auto-approve no longer looks broken.
  category: fix
  dev: FN-7559 — auto-approve-all bypasses only the manual plan-approval gate (unchanged, FN-7526). Release-authorization holds are surfaced with a new distinct status reason (`Task.awaitingApprovalReason: "release-authorization"`) and no longer render the generic manual Approve/Reject affordance in TaskCard/TaskDetailModal; Workflow Plan Review already used distinct statuses (`needs-replan`/`plan-review-unavailable`) and is unaffected. Both gates remain independent and intact — this is UI/data disambiguation only.
- 6d364fc: summary: Move mobile terminal controls into a bottom footer so they no longer crowd the header, with a scrollable shortcut bar.
  category: fix
  dev: On the ≤768px terminal, the `.terminal-actions` cluster now renders in a `terminal-footer-actions` bar (with `min-width:0; overflow-x:auto`) instead of the header; desktop/floating/pinned-below keep the FN-7502 header layout. Preserves the FN-7550 shortcut-panel scroll fix.
- b471aec: summary: Stop the release-authorization gate from holding tasks that merely disclaim releasing.
  category: fix
  dev: classifyReleaseTask now strips negated release-disclaimer clauses (e.g. "this task performs no release/publish; releases are owned by scripts/release.mjs") before signal matching in packages/engine/src/triage-release-authorization.ts, so revert/undo/UI specs are no longer false-flagged as release-class. Genuine "run pnpm release"/"publish @runfusion/fusion" intent still trips the gate.
- 9d4a45b: summary: Fix mobile terminal text still rendering with excess inter-character gaps after font-load settle.
  category: fix
  dev: Root cause: xterm's OptionsService setter is a no-op when reassigning an already-current fontFamily/fontSize, so post-settle reapply never forced CharSizeService/DomRenderer to remeasure. Added `forceTerminalFontRemeasure()` in `terminalPreferences.ts`, used by both `TerminalModal.tsx` and `SessionTerminal.tsx` at every post-`waitForTerminalFontMetrics()` settle site.
- 72b77bf: summary: Stop Plan Review from looping tasks forever and fix its "can't find the plan" reviews.
  category: fix
  dev: FN-7561 — Plan Review pre-merge gate hardening in packages/engine/src/executor.ts. (1) The reviewer ran readonly with cwd=worktree but the spec lives at project-root .fusion/tasks/<id>/PROMPT.md, so "Read PROMPT.md" produced "no PROMPT.md found / data is in a DB" non-verdicts; the spec text is now injected into the reviewer prompt via readTaskArtifact. (2) A malformed reviewer response now self-retries once on the primary model when no fallback is configured. (3) A malformed (advisory_failure, no verdict) plan-review result can never trigger a triage replan. (4) The unbounded plan-review replan default is capped at 15 attempts with a loud halting log entry, so a persistently-disagreeing planner/reviewer no longer burns LLM calls indefinitely (FN-7525 ran 13+ attempts overnight).
- c08498e: summary: Planner-overseer task badge now shows a readable label and explains what it is waiting on.
  category: fix
  dev: TaskCard badge renders plannerOverseerStateLabel + plannerOverseerBadgeTooltip built from the existing PlannerOverseerRuntimeSnapshot (reason/watchedStage/signal/pendingConfirmation); presentation-only, no engine changes.
- 24b27e8: summary: Plan approve/reject API now blocks release-authorization holds, requiring the authorization marker first.
  category: fix
  dev: FN-7564 — POST /tasks/:id/approve-plan and /reject-plan now return 400 when task.awaitingApprovalReason === "release-authorization" (FN-7559 discriminator), enforcing the FN-6481 release-authorization gate at the API layer regardless of client. Manual-approval holds are unaffected.
- fb45157: summary: Pin the mobile terminal close (X) button to the top-right corner so it is easy to find and tap.
  category: fix
  dev: On the ≤768px terminal, the `terminal-close` button now carries a `terminal-close--corner` class (order:3 + margin-inline-start:auto) so it renders last in flex order and hugs the right edge next to the tab dropdown, instead of falling back to order:0 (far left). Desktop/floating/pinned-below placement inside `.terminal-actions` is unchanged.
- 7c0be53: summary: Fix mobile terminal excess character spacing that survived earlier font-remeasure fixes.
  category: fix
  dev: `TerminalModal`/`SessionTerminal` re-bake xterm's `DomRenderer` letter-spacing compensation AFTER `fitAddon.fit()` settles the post-fit column count (not just before it), since `handleResize()` never re-bakes spacing itself. See `docs/solutions/ui-bugs/xterm-options-noop-remeasure-after-font-settle.md` recurrence #4.
- 71dfd3a: summary: Rename downloadable CLI release binaries to the fn-cli-<platform> base name.
  category: internal
  dev: `binaryNameForTarget` in `packages/cli/build.ts` and the `release.yml` / `test-release.yml` matrices now emit `fn-cli-<suffix>`; the local dev binary stays `fn`/`fn.exe`.
- 9592e3a: summary: Manual plan approval no longer re-asks you to approve a plan you already approved when it hasn't changed.
  category: fix
  dev: FN-7569 — approving a plan records a fingerprint of the approved PROMPT.md (new nullable Task.approvedPlanFingerprint, migration 139). The manual plan-approval gate skips re-parking at awaiting-approval when a re-specification (replan, plan-review retry, self-healing rebound) produces the same plan; a changed plan or reject-plan still requires fresh approval. Release authorization, Workflow Plan Review, and auto-approve-all are unchanged.
- c31f9ef: summary: Move the planner intervention timeline into the task Activity view dropdown.
  category: feature
  dev: Removes the inline `PlannerInterventionTimeline` mount from the FN-7517 oversight cluster in `TaskDetailModal.tsx` and adds a fourth `interventions` `ActivitySegment`, shown in the Activity dropdown only when planner oversight is active for the task; falls back to Live if oversight turns off while Interventions is selected.
- ce9df29: summary: Expired Claude subscription logins now show disconnected with a re-login prompt; tokens auto-refresh before expiry.
  category: fix
  dev: Unifies OAuth expiry detection between OAuthExpiryMonitor and /api/auth/status, and adds an engine-side proactive OAuth refresh scheduler wired in project-engine (guarded by skipNotifier). No token material logged.
- 196abb5: summary: Anthropic subscription reads now refresh the OAuth token automatically instead of silently failing when expired.
  category: fix
  dev: mergeAuthStorageReads getApiKey("anthropic-subscription") now delegates to the underlying engine authStorage.getApiKey (the only refresh-token HTTP round trip) instead of a local static expiry check; regression tests drive the wrapper directly. No token material logged.
- 45e5a26: summary: Stop GitHub tracking-issue creation from linking new tasks to old/closed issues.
  category: fix
  dev: github-tracking dedup now only reuses OPEN issues and requires a File-Scope path overlap (keyword-only matches no longer link). Prevents mis-linking a fresh task to a stale/resolved tracking issue (FN-7579). Setting `githubTrackingDedupEnabled` unchanged.
- a1a6b09: summary: Clarify the oversight "Nudge unavailable" guideline so it no longer reads as an overseer fault.
  category: fix
  dev: TaskDetailModal oversight controls — reworded taskDetail.oversight.nudgeDisabledTitle and added taskDetail.oversight.nudgeSuppressedTitle to differentiate periodic-observation vs. manual-control states. No enablement/engine logic changed.
- cf3fe8b: summary: New tasks created under the Coding (Ideas) workflow now land in the Ideas column and wait for you to promote them.
  category: fix
  dev: Dashboard create surfaces (InlineCreateCard, QuickEntryBox, NewTaskModal, insight/todo → task) no longer hard-code column:"triage"; the store now resolves the selected/default workflow's intake column. InlineCreateCard forwards workflowId at create time instead of applying it post-create. Also fixed a glue-layer regression in `useTaskHandlers.ts` (`handleBoardQuickCreate`/`handleModalCreate`) that re-forced column:"triage" even after the UI surfaces stopped sending it.
- 8b4e522: summary: Fix tasks vanishing from the board after being added to a workflow like Coding (Ideas).
  category: fix
  dev: Board.tsx forces a board-workflows refetch (deferred one tick, signature-guarded) whenever a rendered task is missing from the taskWorkflowIds map, so its real workflow and intake column resolve regardless of which create surface added it; the single-workflow grouping also re-homes a task whose column its workflow no longer declares into the intake lane instead of dropping it. Fixes the FN-7591 regression where intake-column cards (column "ideas") fell back to the default workflow, which has no such column, and were filtered out until a manual reload.
- f30d55f: summary: Move the Before → After transformation summary to the top of generated task definitions.
  category: fix
  dev: Reorders the standard and fast triage `PROMPT.md` templates in packages/core/src/agent-prompts.ts so `## Before → After Transformation` is the first content section, ahead of `## Review Level` and `## Mission`, matching FN-7499's glance-verification intent.
- 20379e8: summary: Task-detail Priority dropdown now matches the Oversight dropdown's size, border, and typography.
  category: fix
  dev: Removed the Priority-only forced select/option uppercase, added a neutral chip background scoped to `.detail-priority-chip.card-priority-badge--normal` for the untinted `normal` level, and reused the FN-7585 shared `--btn-border-width`/`--border`/`--detail-control-border-radius`/`--detail-priority-control-min-height` tokens so both dropdowns render as one control style across desktop and the mobile oversight-overflow surface.
- e0f3d3d: summary: Default workflow boards now label the intake column "Planning" instead of "Triage".
  category: fix
  dev: Renamed the `name` of the `id: "triage"` intake column to "Planning" in builtin-coding, builtin-stepwise-coding, and builtin-pr workflow IRs (column id unchanged; linear built-ins inherit via canonicalBuiltinWorkflowColumns). COLUMN_LABELS.triage was already "Planning".
- 5b193d2: summary: Fix the task-detail Nudge control staying disabled when the overseer is actively watching.
  category: fix
  dev: GET /api/tasks/:id now attaches the transient plannerOverseerState snapshot (mirrors the list route); TaskDetailModal reads the snapshot from workingTask so detail refetches no longer drop it.
- 546ef16: summary: Honor mission branchStrategy when triage omits branchAssignment; skip validation for inactive missions.
  category: fix
  dev: resolveBranchAssignmentContext returns undefined for absent mode so triage falls back to mission.branchStrategy; processTaskOutcome gates on mission.status === "active" like recoverActiveMissions.
- b173f76: summary: Planner overseer no longer marks healthy in-progress tasks as "recovering" or steers them.
  category: fix
  dev: `decidePlannerRecovery` now returns `none` for healthy (`progressing`/`complete`) and `awaiting-human` executor/workflow-gate signals instead of falling through to `inject_guidance`; only `stuck`/`blocked`/`failed` trigger autonomous steering. Also dedupes the `PlannerOverseerMonitor` activity-feed heartbeat so an unchanged `(stage, signal, reason)` observation is logged once per change, not every poll tick. Fixes the "overseer recovering" badge appearing on every autonomous card and the needless AI-consuming guidance injections (FN-7577).

### runfusion.ai

#### Patch Changes

- Updated dependencies [8668a05]
- Updated dependencies [978cdda]
- Updated dependencies [635fca2]
- Updated dependencies [3d55102]
- Updated dependencies [0f1cd0a]
- Updated dependencies [b42ba9f]
- Updated dependencies [a7559b0]
- Updated dependencies [4b530a6]
- Updated dependencies [a5ac3c3]
- Updated dependencies [8912399]
- Updated dependencies [d16c8b4]
- Updated dependencies [b800f7d]
- Updated dependencies [315f3bc]
- Updated dependencies [9dc248e]
- Updated dependencies [52dbc0e]
- Updated dependencies [ced783e]
- Updated dependencies [50cdab1]
- Updated dependencies [50786f2]
- Updated dependencies [b4b1f6d]
- Updated dependencies [e8b7362]
- Updated dependencies [0900a38]
- Updated dependencies [a2b09f2]
- Updated dependencies [0f05156]
- Updated dependencies [20184ac]
- Updated dependencies [82493e0]
- Updated dependencies [5689346]
- Updated dependencies [b42be87]
- Updated dependencies [2f23d22]
- Updated dependencies [efa8105]
- Updated dependencies [61c8bdc]
- Updated dependencies [e8dc2ae]
- Updated dependencies [d2e3134]
- Updated dependencies [b0208c1]
- Updated dependencies [7d8a1b8]
- Updated dependencies [2797803]
- Updated dependencies [a2d6349]
- Updated dependencies [4baa4c4]
- Updated dependencies [87a700c]
- Updated dependencies [68f5153]
- Updated dependencies [aa757bc]
- Updated dependencies [0689250]
- Updated dependencies [12a6d1b]
- Updated dependencies [81f2053]
- Updated dependencies [2cc84b5]
- Updated dependencies [79ab367]
- Updated dependencies [c16cc9e]
- Updated dependencies [aae603b]
- Updated dependencies [d10ea9a]
- Updated dependencies [bf68839]
- Updated dependencies [53d7b7e]
- Updated dependencies [c4d81fe]
- Updated dependencies [e7cb2f1]
- Updated dependencies [4707eb5]
- Updated dependencies [3b52a4d]
- Updated dependencies [5ad8ec8]
- Updated dependencies [726cbf8]
- Updated dependencies [36bd74e]
- Updated dependencies [df0be88]
- Updated dependencies [ec9ac61]
- Updated dependencies [8d36b99]
- Updated dependencies [ad744aa]
- Updated dependencies [5c3d58a]
- Updated dependencies [b4be515]
- Updated dependencies [62ddb19]
- Updated dependencies [883c73e]
- Updated dependencies [2ed06f9]
- Updated dependencies [8c6f76c]
- Updated dependencies [d09b57f]
- Updated dependencies [3d58260]
- Updated dependencies [052a277]
- Updated dependencies [f992e6a]
- Updated dependencies [2df6c35]
- Updated dependencies [94e9d15]
- Updated dependencies [3dd227b]
- Updated dependencies [6e4c207]
- Updated dependencies [6d364fc]
- Updated dependencies [b471aec]
- Updated dependencies [9d4a45b]
- Updated dependencies [72b77bf]
- Updated dependencies [c08498e]
- Updated dependencies [24b27e8]
- Updated dependencies [fb45157]
- Updated dependencies [7c0be53]
- Updated dependencies [71dfd3a]
- Updated dependencies [9592e3a]
- Updated dependencies [c31f9ef]
- Updated dependencies [ce9df29]
- Updated dependencies [78d4db9]
- Updated dependencies [196abb5]
- Updated dependencies [7435849]
- Updated dependencies [73b38ba]
- Updated dependencies [42bbe58]
- Updated dependencies [45e5a26]
- Updated dependencies [a1a6b09]
- Updated dependencies [53fe0d7]
- Updated dependencies [cf3fe8b]
- Updated dependencies [8b4e522]
- Updated dependencies [f30d55f]
- Updated dependencies [20379e8]
- Updated dependencies [e0f3d3d]
- Updated dependencies [5b193d2]
- Updated dependencies [ecbbb29]
- Updated dependencies [546ef16]
- Updated dependencies [b173f76]
  - @runfusion/fusion@0.56.0

## 0.55.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.55.0
- @fusion/engine@0.55.0
- @fusion/i18n@0.39.19
- @fusion-plugin-examples/cli-printing-press@0.1.36
- @fusion-plugin-examples/compound-engineering@0.1.19
- @fusion-plugin-examples/dependency-graph@0.1.50
- @fusion-plugin-examples/roadmap@0.1.38
- @fusion-plugin-examples/cursor-runtime@0.1.38
- @fusion-plugin-examples/droid-runtime@0.1.45
- @fusion-plugin-examples/hermes-runtime@0.2.69
- @fusion-plugin-examples/openclaw-runtime@0.2.69
- @fusion-plugin-examples/paperclip-runtime@0.2.69

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.55.0
- @fusion/dashboard@0.55.0
- @fusion/engine@0.55.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.55.0
- @fusion/pi-claude-cli@0.55.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.55.0

### @runfusion/fusion

#### Minor Changes

- 8580910: summary: Allow configuring permissions for ephemeral and permanent agents.
  category: feature
  dev: Applies capability grants and runtime permission policies consistently across agent lifetimes.
- 5738766: summary: Add GitLab instance URL settings for GitLab.com and self-managed servers.
  category: feature
  dev: Adds typed GitLab web/API URL configuration and dashboard controls for later GitLab integration subtasks.
- fafe4c9: summary: Add GitLab access-token settings for personal, project, and group tokens.
  category: feature
  dev: Documents required GitLab API scopes and adds token auth resolution for later GitLab integration tasks.
- 865dec2: summary: Add GitLab project issue, group issue, and merge request imports.
  category: feature
  dev: Adds HTTP API GitLab import routes, dashboard affordances, CLI commands, and extension tools.
- 34be333: summary: Add GitLab comment and auto-close lifecycle actions for linked work items.
  category: feature
  dev: Uses GitLab REST notes and state-event APIs with configured self-managed instance URLs.
- 1f6befc: summary: Add GitLab as a Command Center Signals connector.
  category: feature
  dev: Adds GitLab webhook token verification and issue/MR signal normalization for Command Center incidents.
- 91737b1: summary: Add explicit onboarding choices to use, initialize, or clone a git repository.
  category: feature
  dev: Setup wizard now sends gitSetupMode while preserving cloneUrl-only project registration clients.
- 91fb53f: summary: Let chat update existing agents without delete/recreate.
  category: feature
  dev: Adds the fn_agent_update Pi extension tool for scoped AgentStore.updateAgent config edits.
- dfb6e52: summary: Add a bundled Linear import plugin for creating tasks from Linear issues.
  category: feature
  dev: Ships fusion-plugin-linear-import with plugin settings, routes, tools, dashboard view, and bundled-plugin packaging.
- ec0256f: summary: Add a mandatory Planning Mode deepening checkpoint before final summaries.
  category: feature
  dev: Planning sessions now persist pending summaries behind a "Would you like to go deeper?" checkpoint.
- 5984f32: summary: Add visible create buttons and recursive search to Project Files.
  category: feature
  dev: Files — Project uses the existing workspace-safe create and /files/search APIs with settings pickers left compact.
- f973334: summary: Add a GitLab enable toggle and collapsible Settings controls.
  category: feature
  dev: Adds gitlabEnabled gating for GitLab API operations while preserving saved configuration.

#### Patch Changes

- 306e516: summary: Stop recurring Windows Terminal warning popups during terminal startup.
  category: fix
  dev: Keeps embedded terminal bootstrap on supported shells and surfaces actionable inline errors.
- 9df13c7: summary: Fix dashboard localStorage quota exhaustion from stale SWR caches and add a Clear local data escape hatch.
  category: fix
  dev: Stale SWR hydration entries (per-chat-session/per-room message caches) were never garbage-collected; readCache now lazily deletes stale entries, a boot sweep prunes anything older than 24h, and Settings → General exposes a user-facing "Clear local data" button that preserves the auth token.
- c7641f9: summary: Fix `fusion desktop` on Windows and published npm installs (Electron dependency, GPU/sandbox flags, dashboard reuse).
  category: fix
  dev: `packages/cli/package.json` now depends on `electron` at runtime; previously the desktop launcher called `require("electron")`, which is only available inside the source checkout (via `pnpm-workspace.yaml` `onlyBuiltDependencies`) and is missing for npm consumers, causing `fusion desktop` to hang or fail silently. The launcher now applies GPU/sandbox-disabling Electron flags only on Windows (`os.platform() === "win32"`), keeps hardware acceleration and the Chromium sandbox on macOS/Linux, exports `FUSION_SERVER_PORT` so the desktop reuses the CLI-started dashboard instead of double-binding ports, and isolates desktop user-data under `~/.fusion/desktop-user-data`. Relocating the profile performs a one-time copy of the previous default Electron profile (`user-data-migration.ts`) so upgrading operators keep window geometry/session. `packages/desktop/scripts/build.ts` now fails the build if `main.js`/`preload.js`/`client/index.html` are missing from `dist/` or the staged `deploy/dist/`, preventing shipping an incomplete `app.asar`.
- da662c4: summary: First-run agent setup no longer errors on a duplicate CEO; desktop Switch-server button now opens the connection menu.
  category: fix
  dev: Onboarding agent creation (ModelOnboardingModal + SetupWizardModal) treats a 409 "Agent with this name already exists" as success and advances, since the default CEO can be created from more than one first-run surface. The desktop preload now bridges the `shell:open-connection-manager` IPC (sent by main when the header Switch-server button is clicked) into the `window` DOM event ShellContext listens for, so NativeShellConnectionManager (Local/Remote toggle + remote profiles) actually opens.
- 377eee6: summary: Allow operators to delete archived tasks.
  category: fix
  dev: Extends task deletion to archive-db snapshots while preserving soft-delete tombstones and ID reservation.
- 9ee33f9: summary: Show workflow template block boundary connectors in the graph editor.
  category: fix
  dev: Adds visual-only foreach/loop/optional-group template boundary edges that are filtered from persisted IR.
- 3453d16: summary: Preserve the selected dashboard project across browser refreshes.
  category: fix
  dev: Project selection now updates and hydrates from the existing `?project=` dashboard URL contract.
- 777f647: summary: Detect Cursor CLI installations that expose Windows cmd or bat shims.
  category: fix
  dev: Cursor runtime probes and model discovery now shell-spawn only on Windows and preserve spawn diagnostics.
- abb1917: summary: Add a Settings override for the local Cursor CLI binary path.
  category: feature
  dev: Adds global `cursorCliBinaryPath` and threads it through Cursor CLI probes, auth status, enable validation, and model discovery.
- b8e126e: summary: Display linked GitLab tracking metadata and stale badges on tasks.
  category: feature
  dev: Persists GitLab tracking metadata separately from GitHub tracking fields.
- c49a933: summary: Preserve GitLab tracking metadata for CLI and extension imports.
  category: fix
  dev: GitLab project, group, and merge-request imports now carry gitlabTracking metadata alongside sourceIssue provenance.
- 53d5bb1: summary: Keep Planning Mode Refine Further from getting stuck on duplicate generation.
  category: fix
  dev: Guards completed-summary refinement as a single-flight UI turn and preserves the active planning stream on same-refine in-progress responses.
- b493a1e: summary: Show task status badges on Documents task groups.
  category: fix
  dev: DocumentsView now renders taskColumn metadata in task document group headers and covers collapsed done/non-done states.
- e5be924: summary: Suppress misleading Anthropic Subscription re-login banners when another Anthropic auth method is active.
  category: fix
  dev: Keeps subscription OAuth expired in Settings while hiding only the global urgent banner entry when API key or Claude CLI auth is active.
- 326c72b: summary: Keep Anthropic authentication cards grouped near the top in Settings.
  category: fix
  dev: Sorts Claude CLI, Anthropic Subscription, and Anthropic API Key before other auth cards within each auth group.
- 1d6bb08: summary: Stop planner model fallback loops with a clear terminal triage error.
  category: fix
  dev: Bounds prompt-time/session-creation model fallback exhaustion and persists failed triage state.
- aa8f1f3: summary: Recover stale task branch-group references from Task Detail after server restarts.
  category: fix
  dev: Adds branch_group restart regression coverage and non-origin integration-branch diagnostics.
- 72adb52: summary: Add sidebar rename buttons to direct Chat conversations.
  category: feature
  dev: Reuses ChatView's existing rename dialog and useChat renameSession path.
- 25fecd7: summary: Return GitHub issue import actions to the main issue list.
  category: fix
  dev: Updates Import Tasks issue import/close navigation and regression coverage.
- ffcb54b: summary: Prevent Planning Mode sessions from failing when MCP resolution returns no shaped result.
  category: fix
  dev: Dashboard planning lanes now default malformed MCP resolver output to an empty server set while preserving MCP forwarding.
- 8d7abb8: summary: Fix Android mobile terminal spacing while the keyboard is open.
  category: fix
  dev: Terminal mobile sizing now tracks visualViewport width for keyboard-open xterm fits.
- 22fd0da: summary: Fix Last 30 days token usage to include every model in Command Center.
  category: fix
  dev: Corrects Command Center token analytics range attribution for durable multi-model task usage.
- 765218f: summary: Include supported chat interactions in Command Center token usage totals.
  category: fix
  dev: Records chat-session and room-responder token usage separately from task execution tokens and aggregates both sources in token analytics.
- 1d6011c: summary: Collapse mobile Chat thread controls into one compact header row.
  category: feature
  dev: Mobile direct-chat moves back/session controls into ViewHeader and floats the Markdown/plain toggle.
- 2050323: summary: Preserve workflow setting edits made while a values save is still in flight.
  category: fix
  dev: WorkflowSettingsPanel and Project Models workflow lane saves now clear only snapshot-matching pending keys.
- 3fac409: summary: Preserve migrated workflow settings when project identity is assigned later.
  category: fix
  dev: Backfills rootDir-keyed workflow_settings rows into the durable project identity row, keeping identity values on conflicts.
- 78ebeaf: summary: Show the bundled Linear Import plugin in Plugin Manager and dashboard plugin surfaces.
  category: fix
  dev: Keeps fusion-plugin-linear-import registered across the built-in Plugin Manager catalog while reusing existing registry, dashboard view, and bundled packaging paths.
- 1430a42: summary: Fix the mobile Chat header so back navigation and session selection stay on one row.
  category: fix
  dev: Keeps the direct-chat mobile header collapsed while preserving desktop and room-chat layouts.
- 7a4b0bf: summary: Fix iOS mobile terminal spacing when opening terminals with the keyboard already visible.
  category: fix
  dev: Seeds iOS keyboard-open viewport baselines for TerminalModal and SessionTerminal before xterm fit/resize.
- 00afb22: summary: Default fresh startup and theme reset to System mode.
  category: fix
  dev: Fresh global settings, pre-hydration scripts, and Appearance reset now keep Shadcn Ember while following OS light/dark preference.
- 9532520: summary: Remember task popup size and position when switching between tasks.
  category: fix
  dev: Task-detail FloatingWindow instances share the `floating-window:task-detail` geometry key.
- 7300bf5: summary: Fix iPhone Safari terminal text spacing with the keyboard open.
  category: fix
  dev: Disables WebKit text-size adjustment inside dashboard xterm measurement subtrees.
- 30a11ac: summary: Count planning tasks correctly in the dashboard footer queue metric.
  category: fix
  dev: Footer counter tests now cover queued, running, stuck, blocked, review, overlap, background AI, and Done absence.
- d9ef514: summary: Show conversation titles in the mobile Chat dropdown.
  category: fix
  dev: Keeps the provider logo while removing model-name text from the mobile direct-chat trigger.
- e4349ee: summary: Merges no longer fail when a task adds a dependency without updating the lockfile.
  category: fix
  dev: In merge-dependency-sync.ts, an inferred frozen install (pnpm/yarn/bun) that fails with an outdated-lockfile error now retries once non-frozen (pnpm gets explicit --no-frozen-lockfile) to regenerate the lockfile in the clean-room worktree, recomputing the install marker. Configured worktreeInitCommand keeps its authoritative frozen intent and still hard-fails. Surfaced via the merge:ai-deps-sync run-audit event (healed/healedCommand).

### runfusion.ai

#### Patch Changes

- Updated dependencies [306e516]
- Updated dependencies [9df13c7]
- Updated dependencies [c7641f9]
- Updated dependencies [da662c4]
- Updated dependencies [377eee6]
- Updated dependencies [9ee33f9]
- Updated dependencies [8580910]
- Updated dependencies [3453d16]
- Updated dependencies [777f647]
- Updated dependencies [abb1917]
- Updated dependencies [5738766]
- Updated dependencies [fafe4c9]
- Updated dependencies [865dec2]
- Updated dependencies [b8e126e]
- Updated dependencies [34be333]
- Updated dependencies [1f6befc]
- Updated dependencies [c49a933]
- Updated dependencies [53d5bb1]
- Updated dependencies [91737b1]
- Updated dependencies [b493a1e]
- Updated dependencies [e5be924]
- Updated dependencies [326c72b]
- Updated dependencies [1d6bb08]
- Updated dependencies [aa8f1f3]
- Updated dependencies [91fb53f]
- Updated dependencies [72adb52]
- Updated dependencies [25fecd7]
- Updated dependencies [dfb6e52]
- Updated dependencies [ec0256f]
- Updated dependencies [5984f32]
- Updated dependencies [ffcb54b]
- Updated dependencies [8d7abb8]
- Updated dependencies [22fd0da]
- Updated dependencies [765218f]
- Updated dependencies [1d6011c]
- Updated dependencies [2050323]
- Updated dependencies [3fac409]
- Updated dependencies [f973334]
- Updated dependencies [78ebeaf]
- Updated dependencies [1430a42]
- Updated dependencies [7a4b0bf]
- Updated dependencies [00afb22]
- Updated dependencies [9532520]
- Updated dependencies [7300bf5]
- Updated dependencies [30a11ac]
- Updated dependencies [d9ef514]
- Updated dependencies [e4349ee]
  - @runfusion/fusion@0.55.0

## 0.54.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.54.0
- @fusion/engine@0.54.0
- @fusion/i18n@0.39.18
- @fusion-plugin-examples/cli-printing-press@0.1.35
- @fusion-plugin-examples/compound-engineering@0.1.18
- @fusion-plugin-examples/dependency-graph@0.1.49
- @fusion-plugin-examples/roadmap@0.1.37
- @fusion-plugin-examples/cursor-runtime@0.1.37
- @fusion-plugin-examples/droid-runtime@0.1.44
- @fusion-plugin-examples/hermes-runtime@0.2.68
- @fusion-plugin-examples/openclaw-runtime@0.2.68
- @fusion-plugin-examples/paperclip-runtime@0.2.68

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.54.0
- @fusion/dashboard@0.54.0
- @fusion/engine@0.54.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.54.0
- @fusion/pi-claude-cli@0.54.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.54.0

### @runfusion/fusion

#### Minor Changes

- 40b44e4: summary: Add a project setting to allow or block ephemeral agents from creating tasks (default on).
  category: feature
  dev: New project setting `ephemeralAgentsCanCreateTasks` (default true) in DEFAULT_PROJECT_SETTINGS; gated in both fn_task_create surfaces (pi extension caller-agent check and the engine executor's ephemeral task-worker tool via `AgentTaskCreationOptions.callerIsEphemeral`). Toggle lives in Settings → General.

#### Patch Changes

- 40b44e4: summary: Disabling ephemeral agents now also stops the workflow engine from running unassigned tasks.
  category: fix
  dev: Added `TaskExecutor.blockOuterDispatchWhenEphemeralDisabled` gate at the top of `execute()`, ahead of all three workflow dispatch paths (maybeExecuteWorkflowGraph, workflowAuthoritativeDispatch, maybeDispatchWorkflowWorkEngine). Previously `ephemeralAgentsEnabled=false` was enforced only on the legacy scheduler/EphemeralWorkerManager path; the workflow-engine paths ran unassigned tasks anyway because the spawn refusal is a post-execution fire-and-forget callback. Unassigned tasks are now re-queued for permanent-agent assignment; tasks bound to a permanent agent still run.
- 69f754f: summary: Align the task Activity view dropdown under its tab instead of drifting to the left of the modal.
  category: fix
  dev: TaskDetailModal's position:fixed Activity menu now clamps to the layout viewport (document.documentElement.clientWidth/clientHeight) and no longer mixes in window.visualViewport width/offset, which shoved the popup off-anchor under pinch-zoom or an open mobile keyboard.
- abd596b: summary: Fix the Windows CLI binary failing to build in release.
  category: fix
  dev: The bun `--compile --conditions=source` build could not resolve @fusion-plugin-examples/paperclip-runtime (statically imported by dashboard runtime-provider-probes.ts) because it lacked a `source` export condition and fell through to `import`→`dist/index.js`, absent on the Windows runner. Added `"source": "./src/index.ts"` to paperclip and the remaining example plugins that export `import`→dist (agent-browser, even-cards, even-realities-glasses, whatsapp-chat), matching hermes/openclaw. Verified by cross-compiling bun-windows-x64 with all plugin dist removed.
- abd596b: summary: Fix the desktop app crashing on "Local" mode with missing-module errors.
  category: fix
  dev: electron-builder's pnpm support runs `pnpm list --prod` and drops `deduped` subtrees, so the embedded runtime's `import("@fusion/engine")` closure (@modelcontextprotocol/sdk, the pi-ai provider SDKs, etc.) was never packed into app.asar. The desktop build now stages the complete flat production closure with `pnpm deploy --legacy --config.node-linker=hoisted` and points electron-builder at it via `--projectDir deploy`, so packaging no longer depends on the lossy collector. Also fixes cursor/droid/roadmap plugin exports to expose compiled `dist` on the `import` condition (with `source`→src kept for the bun CLI) so the dashboard server loads them under plain Node, and builds those plugins in the desktop build. Validated by importing @fusion/core|engine|dashboard from the staged deploy and packing a complete 705-package asar.
- 074462e: summary: Planning mode no longer creates a new draft for every character you type.
  category: fix
  dev: PlanningModeModal's initial-plan textarea gated duplicate createPlanningDraft calls only on draftSessionIdRef, which is set after the create round-trip resolves; keystrokes during an in-flight create each spawned a fresh draft. A synchronous draftCreateInFlightRef sentinel now suppresses concurrent creates and is cleared on failure so a later keystroke can retry.
- eedf526: summary: Preserve project scope when saving task-detail model overrides.
  category: fix
  dev: Threads task-detail Model tab updates through projectId for executor, reviewer, planning, and thinking lanes.
- 9464f31: summary: Fix the All workflows dropdown counter so it no longer double-counts tasks.
  category: fix
  dev: Board now uses the shared workflow status count aggregate directly, with regression coverage for Board/List and header/graph selector count behavior.
- 1a523e7: summary: Allow completed task planner Chat to answer and create refinements.
  category: feature
  dev: Adds done-task task-planner session creation and `fn_task_planner_create_refinement`.
- b6da7fa: summary: Normalize task-detail tab padding across Activity, Chat, and Plan views.
  category: fix
  dev: Keeps chat-like task-detail tabs on canonical body padding while preserving internal scroll behavior.
- 22261b6: summary: Prevent task-bound agents from deleting the task they are currently executing.
  category: fix
  dev: TaskStore.deleteTask now rejects audit contexts whose caller task matches the delete target.
- 3167dbc: summary: Reviews stop failing on formatting: approvals pass, trailing-JSON verdicts parse, retries clear stale gate failures.
  category: fix
  dev: reviewer.ts adds shared `proseSignalsClearApproval` (approval prose with a revise/negated-approval guard), `extractJsonObjectCandidates` (string-aware balanced-brace scan, last-object preferred for prose→trailing-JSON), and `classifyReviewVerdictToken` (any APPROVE\*/APPROVAL token → APPROVE). `extractVerdict` now prefers an explicit heading/line verdict over an incidental/example JSON object. Gate parser (`parseWorkflowStepVerdict`/`inferWorkflowStepVerdictFromProse`) shares the same logic. `executeWorkflowStep` retries the fallback model on malformed (not just timeout) and malformed gate output is a non-blocking advisory (relaxes FN-6582; genuine parsed REVISE still blocks). Retry paths clear prior terminal step failures (`clearTerminalWorkflowStepFailures`) only after the task leaves the mergeable in-review column (`clearTerminalStepFailuresForRetry` in the rerun bounce / resume path) to avoid an auto-merge race. Fail-closed merge/PR/mission-verification gates are unchanged.
- ca88a6c: summary: Stop showing "Task Failed" on a task whose code-review remediation is still running.
  category: fix
  dev: handleGraphFailure now skips the terminal `status:"failed"` park when the failed graph node is a `pre-merge-remediation`/`plan-replan` node (e.g. `code-review-remediation`) AND a live agent session surface is still registered for the task. These nodes are fire-and-forget async schedulers with no `failure` out-edge, so a failed re-arm (missing rehydrated failureContext after restart, remediation-not-scheduled, or exhausted rework budget) bubbled out as the terminal graph outcome and stamped a spurious failure over live work. Scoped via `isRemediationGraphNode` (IR `workflowAction` with built-in node-id fallback) + `hasLiveTaskSessionSurface`; genuine execute/merge failures and remediation failures with no live session still park failed unchanged.
- 9870428: summary: Restore the board search button after closing the search panel.
  category: fix
  dev: Keeps the desktop/tablet Header search reopen affordance visible after empty-query dismissal and parent clear.

### runfusion.ai

#### Patch Changes

- Updated dependencies [40b44e4]
- Updated dependencies [40b44e4]
- Updated dependencies [69f754f]
- Updated dependencies [abd596b]
- Updated dependencies [abd596b]
- Updated dependencies [074462e]
- Updated dependencies [eedf526]
- Updated dependencies [9464f31]
- Updated dependencies [1a523e7]
- Updated dependencies [b6da7fa]
- Updated dependencies [22261b6]
- Updated dependencies [3167dbc]
- Updated dependencies [ca88a6c]
- Updated dependencies [9870428]
  - @runfusion/fusion@0.54.0

## 0.53.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.53.1
- @fusion/engine@0.53.1
- @fusion/i18n@0.39.17
- @fusion-plugin-examples/cli-printing-press@0.1.34
- @fusion-plugin-examples/compound-engineering@0.1.17
- @fusion-plugin-examples/dependency-graph@0.1.48
- @fusion-plugin-examples/roadmap@0.1.36
- @fusion-plugin-examples/cursor-runtime@0.1.36
- @fusion-plugin-examples/droid-runtime@0.1.43
- @fusion-plugin-examples/hermes-runtime@0.2.67
- @fusion-plugin-examples/openclaw-runtime@0.2.67
- @fusion-plugin-examples/paperclip-runtime@0.2.67

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.53.1
- @fusion/dashboard@0.53.1
- @fusion/engine@0.53.1

### @fusion/engine

#### Patch Changes

- @fusion/core@0.53.1
- @fusion/pi-claude-cli@0.53.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.53.1

### @runfusion/fusion

#### Patch Changes

- bb1de8a: summary: Fix the Windows CLI binary failing to build in release.
  category: fix
  dev: The bun `--conditions=source` compile of the CLI could not resolve @fusion-plugin-examples/hermes-runtime and openclaw-runtime (statically imported by dashboard routes.ts) because those plugin packages lacked a `source` export condition and fell through to `import`→`dist/index.js`, which is absent on the Windows runner. Added `"source": "./src/index.ts"` to both plugins' exports (matching @fusion/core|dashboard|engine|plugin-sdk) so bun bundles their TS source directly, independent of dist. Verified locally by cross-compiling bun-windows-x64 with plugin dist removed; a negative control reproduced the exact "Could not resolve" error.
- 3aef6dd: summary: Fix desktop app crashing on "Local" mode startup with a missing-module error.
  category: fix
  dev: The desktop build now compiles @fusion/core and @fusion/engine tsc dist (both gitignored) so the packaged embedded Local runtime's `import("@fusion/engine")` resolves. Previously only release.yml's root `pnpm build` produced these; desktop-windows.yml packaged an empty engine/dist and crashed with ERR_MODULE_NOT_FOUND for app.asar/node_modules/@fusion/engine. `@fusion/desktop build` is now self-contained (build.ts → ensureEmbeddedRuntimeBuild), and desktop-windows.yml gained the `pnpm build` parity step.

### runfusion.ai

#### Patch Changes

- Updated dependencies [bb1de8a]
- Updated dependencies [3aef6dd]
  - @runfusion/fusion@0.53.1

## 0.53.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.53.0
- @fusion/engine@0.53.0
- @fusion/i18n@0.39.16
- @fusion-plugin-examples/cli-printing-press@0.1.33
- @fusion-plugin-examples/compound-engineering@0.1.16
- @fusion-plugin-examples/dependency-graph@0.1.47
- @fusion-plugin-examples/roadmap@0.1.35
- @fusion-plugin-examples/cursor-runtime@0.1.35
- @fusion-plugin-examples/droid-runtime@0.1.42
- @fusion-plugin-examples/hermes-runtime@0.2.66
- @fusion-plugin-examples/openclaw-runtime@0.2.66
- @fusion-plugin-examples/paperclip-runtime@0.2.66

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.53.0
- @fusion/dashboard@0.53.0
- @fusion/engine@0.53.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.53.0
- @fusion/pi-claude-cli@0.53.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.53.0

### @runfusion/fusion

#### Minor Changes

- 12ee9a9: summary: Add exact tool overrides for permanent-agent permission policies.
  category: feature
  dev: Adds per-tool permission policy overrides on top of category rules.
- a9e2baa: summary: Add a project option to link imported GitHub issues to GitHub tracking.
  category: feature
  dev: GitHub issue import paths honor githubLinkImportedIssuesToTracking while ordinary task creation remains unchanged.
- 1750523: summary: Add Enable GitHub tracking to Board and List task context menus.
  category: feature
  dev: Reuses the existing task PATCH GitHub tracking flow from shared card/list context menu actions.
- 1ccef81: summary: Let task-detail planner Chat answer current-task token, cost, and timing questions.
  category: feature
  dev: Adds read-only task-scoped planner chat tool `fn_task_planner_get_task_metrics` with derived pricing semantics.
- a404997: summary: Add a Glass Silver dashboard theme.
  category: feature
  dev: Registers glass-silver across core theme metadata, dashboard/desktop startup validators, CSS tokens, swatches, and tests.
- 03160eb: summary: Add a mobile terminal tab dropdown for switching and closing terminal sessions.
  category: feature
  dev: Mobile terminal headers now use a native tab selector while desktop keeps the tab strip.
- 14bb7a3: summary: Branching workflows now run on the graph interpreter; the legacy step-compiler and its interpreter-only banner are gone.
  category: feature
  dev: Removed the linear WorkflowStep compiler (compileWorkflowToSteps/validateLinearity/WorkflowCompileError) from @fusion/core; parseWorkflowIr is now the sole workflow validity gate at save/select/refine and in the graph task runner. Deleted the POST /api/workflows/:id/compile preview route and its client wrapper, and dropped the interpreterOnly response field and editor banner. MERGE_REGION_NODE_KINDS moved into workflow-lifecycle-validation.

#### Patch Changes

- ad8db59: summary: Allow Compound Engineering recovered sessions to answer persisted questions after dashboard restarts.
  category: fix
  dev: Keeps strict question-id validation by default while letting CE trust its persisted session row as the recovery anchor.
- 9432339: summary: Contain planning parse failures as retryable session errors and add `--supervise` dashboard restart mode.
  category: fix
  dev: Planning sessions that receive non-JSON AI output now persist as retryable error state instead of unpersisting the session. The `/api/health` endpoint remains available during session errors. A new `--supervise` flag on `fn dashboard` runs the dashboard under foreground process supervision with bounded restart attempts and exponential backoff, preventing Tailscale Serve 502s from unexpected dashboard exits.
- a1af5de: summary: Fix Anthropic Claude subscription chats failing (404/502/429) by restoring direct OAuth execution.
  category: fix
  dev: Reverts the FN-7391/FN-7396 runtime rerouting that sent subscription OAuth to a `/v1`-based `anthropic-subscription` provider (reintroducing issue #1857). `getApiKey("anthropic")` again resolves subscription/legacy OAuth (raw API key still wins), so `anthropic/*` selections run on pi-ai's built-in provider with Claude Code OAuth headers; the model picker advertises `anthropic` for OAuth users; explicit `pi-claude-cli` and raw `ANTHROPIC_API_KEY` remain separate surfaces.
- 3884169: summary: Fix tasks looping through triage at the completion-summary node, plus Stats/Routing/Node labels crashing.
  category: fix
  dev: Issue #1863 (v0.52.0 regression). (1) The best-effort completion-summary graph node is wired with a success-only edge, so a thrown handler exception or a failed summary projection write terminated the graph and the in-review→todo resume router bounced the task forever. The graph executor now degrades a completion-summary node failure to success (ensureWorkflowCompletionSummary still backfills task.summary), with a routeGraphFailureToExecutionResume backstop. (2) Three views called t() with keys that resolve to nested objects (taskDetail.executionMode, routing.source, nodes.dockerHost); added leaf label keys across all locales and a dashboard invariant test that scans t("literal") callers against the real en/app.json.
- 88bcbce: summary: Prevent task branches from inheriting unrelated checked-out task commits.
  category: fix
  dev: Fresh worktree acquisition now pins the integration branch as the default start point, and merge finalization validates task-owned branch diffs from baseCommitSha when available.
- c93f2d4: summary: Fix arrow-key editing for Settings in the terminal dashboard.
  category: fix
  dev: Settings detail-pane arrows now edit enum values instead of switching panes.
- 72eb9af: summary: Make the task Activity tab switch Live, Feed, and Raw views directly.
  category: fix
  dev: Removes the duplicate in-panel Activity view select from TaskDetailModal.
- d448603: summary: Show Refine in completed task card and list context menus.
  category: fix
  dev: Routes done/custom-complete Board and List context-menu Refine actions into the existing Task Detail refinement composer.
- 98ca9ac: summary: Fix mobile task action menus so tapped actions run once and close.
  category: fix
  dev: Shared TaskContextMenu now commits touch/pen selections on pointer release and guards synthesized clicks.
- 7457f04: summary: Reuse the standard Chat surface for task-detail planner chat.
  category: fix
  dev: Extracts StandardChatSurface for shared message, thinking, tool-call, and mobile send rendering without importing the lazy ChatView chunk from task detail.
- d8f3cc6: summary: Make mobile task-detail chat Send buttons submit on the first tap.
  category: fix
  dev: Adds touch-first send handling for Activity steering, done-task refinement, and planner Chat composers.
- b3b01bc: summary: Add All workflows to top-level dashboard workflow selectors.
  category: feature
  dev: Extends the dashboard aggregate workflow sentinel to List, Planning, Missions, and Graph without backend handoff.
- 62c4aae: summary: Recover explicit Sonnet 5 chat selections with configured model fallbacks.
  category: fix
  dev: Routes Anthropic Sonnet 5 provider/model failures through chat/runtime fallback and preserves actionable no-fallback errors.
- 1f3a15e: summary: Fix Windows desktop startup failures in packaged builds.
  category: fix
  dev: Externalizes Electron updater CJS dependencies, loads the dashboard registry manifest through Node-safe file IO, and separates NSIS/portable Windows artifacts.
- f04f01d: summary: Fix Board task context menus so they are not clipped by columns.
  category: fix
  dev: Board TaskCard menus are portaled to document.body and clamped in viewport coordinates.
- e4eb8b6: summary: Prevent mobile Board task long-press menus from selecting card text.
  category: fix
  dev: Suppresses WebKit/native selection for non-editing TaskCard surfaces while preserving edit textareas.
- fed60ec: summary: Hide task planner chats from the common Chat feed unless enabled in Settings.
  category: fix
  dev: Adds project setting `showTaskChatsInCommonFeed` and filters task-planner sessions in chat list APIs/client refresh.
- d93fac0: summary: Let the task popup setting open board tasks as popups on desktop too.
  category: fix
  dev: Keeps the existing `openMobileTasksInPopup` setting key while broadening ordinary board-card routing across viewports.
- c194248: summary: Preserve task-detail planner Chat working state after leaving and returning.
  category: fix
  dev: Rehydrates task-planner chat generation snapshots and reattaches streams across tab switches and modal remounts.
- a65633d: summary: Keep sent chat messages visible when a provider error interrupts the reply.
  category: fix
  dev: Reconciles accepted optimistic chat sends with persisted transcripts across global, planner, and room chats.
- 4805182: summary: Let Planning Mode Yes/No questions accept a custom Other answer.
  category: fix
  dev: Extends confirm-question handling to preserve user-authored alternatives via `_other`.
- 67f93ce: summary: Show thinking effort on task log model rows when it is configured.
  category: fix
  dev: Runtime using-model markers append `(thinking effort: <level>)` while dashboard parsers strip suffix annotations for provider icons and effective-model displays.
- 919420e: summary: Enforce maxWorktrees as a hard cap on active execution worktrees.
  category: fix
  dev: TaskStore rejects allocated in-progress moves once active holders reach maxWorktrees, independent of maxConcurrent.
- 427ce04: summary: Stop force-advertising Anthropic Claude Sonnet 5 when account availability is unknown.
  category: fix
  dev: Removes static Sonnet 5 supplemental catalog/pricing metadata while preserving fallback handling for saved selections.
- 7e5d908: summary: Fix the mobile task Activity view dropdown so it opens above the tab strip without clipping.
  category: fix
  dev: Root-portals and viewport-clamps the task-detail Activity Live/Feed/Raw menu with regression coverage.
- a4ef439: summary: Keep the Planner Chat stop-generation icon visible on mobile while thinking.
  category: fix
  dev: Narrows the mobile Planner Chat text-hiding selector so the shared chat stop icon span remains visible.
- 914c7c1: summary: Hide failed-task banners while task planner chat is maximized.
  category: fix
  dev: TaskDetailModal no longer mounts failed-banner chrome during expanded planner Chat; Activity and collapsed detail still show failures.
- 3702763: summary: Upgrade Fusion's bundled pi SDK dependencies to 0.80.3.
  category: internal
  dev: Upgrades @earendil-works/pi-ai and @earendil-works/pi-coding-agent to ^0.80.3.
- e341c06: summary: Make Planner Chat clarification questions answerable in task details.
  category: fix
  dev: Extracts fn_ask_question cards from grouped tool-call details in shared chat rendering.
- 6d1507a: summary: Close task details immediately after confirming task deletion.
  category: fix
  dev: Updates shared task-detail delete close behavior and split-detail host wiring so detail shells close before delete requests settle.
- d94c359: summary: Honor project auto plan approval across task finalization paths.
  category: fix
  dev: Ensures planApprovalMode=auto-approve-all wins over workflow requirePlanApproval for ordinary plan approval.
- ec0fa96: summary: Add a Triage column shortcut for plan auto-approval.
  category: feature
  dev: Adds a Board column switch that mirrors project planApprovalMode=auto-approve-all.
- 869974c: summary: Make chat-created workflows appear immediately across workflow selectors.
  category: fix
  dev: Chat workflow tools now emit workflow lifecycle SSE and workflow lists force-refresh per project.
- af6e671: summary: Recover live worktree conflicts by retrying with a fresh task worktree.
  category: fix
  dev: Executor worktree acquisition now preserves active-session conflict owners and retries bounded sibling branches instead of surfacing automatic cleanup failure.
- 4378053: summary: Fix Activity expand controls so Live and Feed overlay content and Raw has one fullscreen button.
  category: fix
  dev: Updates task-detail Activity Live/Feed overlay controls and keeps Raw on AgentLogViewer fullscreen.
- 4694b4a: summary: Move destructive task context-menu actions to the bottom.
  category: fix
  dev: Reorders shared TaskContextMenu descriptors so Reset precedes Delete at the end across Board, List, and Detail menus.
- 18b07b5: summary: Fix folded Android mobile terminal spacing on initial open.
  category: fix
  dev: Terminal mobile detection now honors touch visualViewport width for TerminalModal and SessionTerminal.
- bfe5ced: summary: Show eligible Claude Sonnet 5 model rows once in model pickers.
  category: fix
  dev: Dedupes /api/models rows by provider/model while preserving direct Anthropic Sonnet 5 guardrails.
- 3219ced: summary: Restore Claude Sonnet 5 and latest Anthropic models in the Claude CLI model picker.
  category: fix
  dev: pi-claude-cli supplemental extraModels now advertises claude-sonnet-5 for the subscription-authenticated CLI surface; direct-Anthropic supplemental registration and static pricing remain withheld per FN-7374's 404 not_found_error handling. Local evidence used claude 2.1.197 with --model accepting aliases/full names; checksum remains upstream-pending-verification.
- 775ff5f: summary: Fix Anthropic subscription chat failing with 429/502 by routing it through the Claude CLI.
  category: fix
  dev: Anthropic routing now keeps three surfaces distinct: raw API keys authenticate direct api.anthropic.com/v1, subscription/OAuth remains `anthropic-subscription`, and CLI execution uses `pi-claude-cli`; OAuth-only selections never authenticate direct `/v1` and are routed to the CLI provider when available.
- 4beae71: summary: Keep hidden task-planner Chat replies from lighting the global Chat unread badge.
  category: fix
  dev: Enriches direct chat SSE payloads with session agent metadata plus common-feed visibility, then suppresses `task-planner:` unread badges only while hidden.
- e85d25e: summary: Fix desktop launch from npm installs in directories with invalid JSON.
  category: fix
  dev: Keeps installed desktop launch independent of source workspace builds and host JSON files.
- 19e59ec: summary: Keep Anthropic subscription OAuth, Claude CLI, and direct API-key auth separated.
  category: fix
  dev: Restores anthropic-subscription status/usage/banner behavior and direct subscription-backed execution while keeping raw anthropic API-key auth and explicit pi-claude-cli execution separate.
- f998fe3: summary: Ensure task lifecycle plugins receive runtime context during completion hooks.
  category: fix
  dev: PluginLoader now appends PluginContext to task lifecycle hook invocations when callers provide only task event args.
- 9c2a264: summary: Show Claude CLI models when Anthropic subscription OAuth and Claude CLI are connected.
  category: fix
  dev: Keeps subscription OAuth on anthropic-subscription while direct anthropic remains raw API-key-only.
- 20e42c6: summary: Fix Compound Engineering Debug stage launches that could fail with a JSON parse error.
  category: fix
  dev: Strengthens CE stage prompts and debug skill guidance so dashboard sessions emit the interactive JSON protocol.
- dbe637f: summary: Include graph-owned workflow step execution in Command Center activity analytics.
  category: fix
  dev: StepSessionExecutor now publishes best-effort agentRuns lifecycle rows for workflow step sessions.
- b7c6443: summary: Restore Claude Sonnet 5 in the model picker (it had disappeared from every surface).
  category: fix
  dev: Re-adds `claude-sonnet-5` to SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION and its static pricing (removed by FN-7374). Live-verified: Sonnet 5 returns 200 on api.anthropic.com/v1 with a raw ANTHROPIC_API_KEY and runs via the Claude CLI; it 403s (scope) on subscription-OAuth /v1, where the runtime actionable-failure/fallback path applies.
- b58d9b5: summary: Enforce explicit external checkout metadata for review routing.
  category: fix
  dev: Reviews now use sourceMetadata.externalReviewCheckout only when it points at a valid git checkout, otherwise they fail closed to the task worktree and log the selected review target.
- 24279c9: summary: Let proven task merges finalize even when old branch history remains.
  category: fix
  dev: Auto-merge finalization now trusts durable task merge proof instead of blocking on stale branch-only residue.
- 07aa1a0: summary: Widen Project Models dropdown menus so long provider and model names are easier to read.
  category: fix
  dev: Adds an opt-in readable menu width to the shared dashboard model dropdown and applies it only in Project Models.
- 62c5840: summary: Give workflow review steps a longer default timeout.
  category: fix
  dev: Raises the built-in `workflowStepTimeoutMs` default and engine fallback from 6 minutes to 15 minutes.

### runfusion.ai

#### Patch Changes

- Updated dependencies [ad8db59]
- Updated dependencies [9432339]
- Updated dependencies [a1af5de]
- Updated dependencies [3884169]
- Updated dependencies [88bcbce]
- Updated dependencies [c93f2d4]
- Updated dependencies [72eb9af]
- Updated dependencies [d448603]
- Updated dependencies [98ca9ac]
- Updated dependencies [7457f04]
- Updated dependencies [d8f3cc6]
- Updated dependencies [b3b01bc]
- Updated dependencies [62c4aae]
- Updated dependencies [1f3a15e]
- Updated dependencies [12ee9a9]
- Updated dependencies [f04f01d]
- Updated dependencies [e4eb8b6]
- Updated dependencies [fed60ec]
- Updated dependencies [d93fac0]
- Updated dependencies [c194248]
- Updated dependencies [a9e2baa]
- Updated dependencies [a65633d]
- Updated dependencies [4805182]
- Updated dependencies [67f93ce]
- Updated dependencies [1750523]
- Updated dependencies [919420e]
- Updated dependencies [427ce04]
- Updated dependencies [7e5d908]
- Updated dependencies [a4ef439]
- Updated dependencies [914c7c1]
- Updated dependencies [3702763]
- Updated dependencies [e341c06]
- Updated dependencies [6d1507a]
- Updated dependencies [d94c359]
- Updated dependencies [ec0fa96]
- Updated dependencies [869974c]
- Updated dependencies [af6e671]
- Updated dependencies [4378053]
- Updated dependencies [4694b4a]
- Updated dependencies [18b07b5]
- Updated dependencies [bfe5ced]
- Updated dependencies [3219ced]
- Updated dependencies [775ff5f]
- Updated dependencies [4beae71]
- Updated dependencies [1ccef81]
- Updated dependencies [e85d25e]
- Updated dependencies [19e59ec]
- Updated dependencies [f998fe3]
- Updated dependencies [9c2a264]
- Updated dependencies [20e42c6]
- Updated dependencies [a404997]
- Updated dependencies [dbe637f]
- Updated dependencies [03160eb]
- Updated dependencies [14bb7a3]
- Updated dependencies [b7c6443]
- Updated dependencies [b58d9b5]
- Updated dependencies [24279c9]
- Updated dependencies [07aa1a0]
- Updated dependencies [62c5840]
  - @runfusion/fusion@0.53.0

## 0.52.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.52.0
- @fusion/engine@0.52.0
- @fusion/i18n@0.39.15
- @fusion-plugin-examples/cli-printing-press@0.1.32
- @fusion-plugin-examples/compound-engineering@0.1.15
- @fusion-plugin-examples/dependency-graph@0.1.46
- @fusion-plugin-examples/roadmap@0.1.34
- @fusion-plugin-examples/cursor-runtime@0.1.34
- @fusion-plugin-examples/droid-runtime@0.1.41
- @fusion-plugin-examples/hermes-runtime@0.2.65
- @fusion-plugin-examples/openclaw-runtime@0.2.65
- @fusion-plugin-examples/paperclip-runtime@0.2.65

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.52.0
- @fusion/dashboard@0.52.0
- @fusion/engine@0.52.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.52.0
- @fusion/pi-claude-cli@0.52.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.52.0

### @runfusion/fusion

#### Minor Changes

- 42226ed: summary: Expose workflow authoring tools through the published agent extension API.
  category: feature
  dev: Registers fn_workflow_create/update/delete/settings/get/select/list and fn_trait_list in the pi extension.
- 353aaf3: summary: Allow task image artifacts to be created from agent tools and viewed in task details.
  category: feature
  dev: Adds `dataBase64` support to `fn_artifact_register` and task-detail image preview expansion.
- 6cf6ad3: summary: Add a setting to control whether clicking outside the Quick Chat window closes it.
  category: feature
  dev: New project setting `quickChatCloseOnOutsideClick` (default true, preserving FN-7152 behavior). Wired through ProjectSettings/DEFAULT_PROJECT_SETTINGS, useAppSettings, the Settings → General toggle, and the Quick Chat FloatingWindow `closeOnOutsidePointerDown` prop. Project-scoped only.
- 013d50f: summary: Add Anthropic API-key authentication under Authentication.
  category: feature
  dev: Adds Anthropic built-in API-key provider auth and surfaces Anthropic dual OAuth/API-key cards in onboarding and Settings.
- f3d9bfb: summary: Add a Tasks tab to the right sidebar that shows the last-viewed task or a clickable task list.
  category: feature
  dev: New `tasks` overflow-view registry entry + `DockTaskList` empty state. The FN-7169 dock-task overlay is re-anchored to the Tasks tab; the task snapshot now persists across tab switches and clears on back/close or surface teardown. Default dock view stays `files`.
- 5b668d2: summary: Let operators sort the board Done column by completion date or task ID.
  category: feature
  dev: Adds Done-column-only descending sort modes while preserving existing completion-date default ordering.
- 797b30c: summary: Add a Board dropdown option that shows tasks across all workflows.
  category: feature
  dev: Uses a dashboard-only aggregate workflow sentinel that is not sent to workflow APIs or durable selection.
- 797b30c: summary: Show workflow-name badges on Board cards in the All workflows view.
  category: feature
  dev: Adds aggregate Board task-card workflow metadata threading through Column and WorktreeGroup.
- 4623211: summary: Add a terminal worktree picker for opening shells in task worktrees.
  category: feature
  dev: Dashboard terminal sessions now pass an authorized cwd for selected project worktrees.
- 480d4d0: summary: Let Git Manager jump from worktrees to their read-only commit history.
  category: feature
  dev: Adds Git Manager worktree commit-target UI and responsive styling.
- 480d4d0: summary: Let Git Manager inspect commit history from known git worktrees.
  category: feature
  dev: Adds read-only worktreePath targeting for commit list and diff endpoints.
- 924bcb9: summary: Add task context menus on board and list cards.
  category: feature
  dev: Board TaskCard and ListView row/card surfaces now support right-click, keyboard, and touch long-press action menus.
- 17fce43: summary: Add a mobile setting to open board tasks in the existing popup.
  category: feature
  dev: Adds project setting `openMobileTasksInPopup` and mobile-only board-card routing to task FloatingWindow.
- ebb805d: summary: Add a global setting to control modal backdrop dismissal.
  category: feature
  dev: Adds dismissModalsOnOutsideClick as a global-only dashboard preference, defaulting false.
- ea0707c: summary: Add a project setting for absolute workspace file-browser paths.
  category: feature
  dev: Adds allowAbsoluteFileBrowserPaths for workspace file-browser routes while keeping the default confined.
- 6c8884e: summary: Add a quick-add workflow selector for Board and List task creation.
  category: feature
  dev: The selector drives save, planning, subtask handoff, and workflow-step loading without submitting the aggregate workflow sentinel.
- 5f67c85: summary: Show workflow identity with icons instead of built-in text suffixes.
  category: feature
  dev: Adds optional custom workflow icon metadata and renders Fusion icons for built-in workflows.
- f0a15db: summary: Add Command Center task-duration trend lines for average and median completed active time.
  category: feature
  dev: Extends productivity analytics with taskDurationTrend buckets sourced from completed task cumulativeActiveMs.
- 2335a07: summary: Add Claude Sonnet 5 across Anthropic model selection and execution paths.
  category: feature
  dev: Adds supplemental direct Anthropic and pi-claude-cli model metadata plus pricing for `claude-sonnet-5`.
- e6be1f7: summary: Add Activity segments for current task activity, Feed, and Raw Logs.
  category: feature
  dev: Task detail keeps legacy initialTab="logs" compatibility by routing to Activity → Feed.
- db7b46f: summary: Add a task-detail Chat tab for planner-model conversations.
  category: feature
  dev: Adds task-scoped planner chat session routing and a dedicated TaskPlannerChatTab separate from Activity steering.
- 4550970: summary: Add starter prompts to the task-detail Chat empty state.
  category: feature
  dev: Planner Chat now renders guided empty-state prompt buttons that send ordinary chat messages.
- cb0d38a: summary: Convert clear task chat change requests into steering comments.
  category: feature
  dev: Task-detail planner Chat now asks for clarification before ambiguous or risky steering.
- 2f5e15a: summary: Make task details open with a focused planner Chat experience.
  category: feature
  dev: Reorders task-detail Chat before Activity, keeps legacy Activity tab ids, and pins the planner Chat composer.
- e2702ba: summary: Let workflow review nodes fix issues in the same reviewer session by default.
  category: feature
  dev: Adds reviewerInlineFixes workflow setting; off restores REVISE-to-remediation behavior.
- 6ce0b44: summary: Make Coding use stepwise execution with default-on Plan Review and final Code Review gates.
  category: feature
  dev: `builtin:coding` now uses the stepwise graph with `plan-review` before execution and no per-step or mandatory final review; the old graph is `builtin:legacy-coding`.
- da15c1c: summary: Rename the task Definition tab to Plan and add a PROMPT.md editor action.
  category: feature
  dev: Dashboard task details now open the current task's PROMPT.md via FileBrowserProvider.

#### Patch Changes

- b2e1c3e: summary: Plugin sidebar icons now refresh after a plugin rebuild instead of showing stale glyphs.
  category: fix
  dev: Dashboard-view metadata is re-derived from the authoritative on-disk manifest so rebuilt plugins do not serve stale dashboardViews icon, label, or placement values to navigation while the in-view bundle is current.
- 368f18c: summary: Restore required safety guidance in fast-mode task planning prompts.
  category: fix
  dev: Keeps `FAST_TRIAGE_PROMPT_TEXT` lean while restoring FN-5893, workflow-routing, artifact-location, and no-commit guidance asserted by engine prompt tests.
- 7eca99c: summary: Fast-mode tasks now clear optional steps by default while honoring manual selections.
  category: fix
  dev: Fast create surfaces submit explicit optional-step selections, and graph execution runs explicitly enabled optional groups even in fast mode.
- 01e0433: summary: Review gates now include user comments and steering context consistently.
  category: fix
  dev: Mandatory Plan Review, reviewStep callers, and prompt/custom workflow-step agents pass canonical user comment context.
- c54b231: summary: Make task details open Activity first by default with an opt-in Chat-first setting.
  category: feature
  dev: Adds project setting `taskDetailChatFirst` and exposes it in Settings → Appearance.
- 0ff60a7: summary: Show focused auth-token recovery when daemon authorization expires.
  category: fix
  dev: Handles exact daemon 401 recovery, focuses the replacement-token input, and suppresses engine remediation while recovery is open.
- 4441b72: summary: Prevent workflow task cards from showing later sequential steps active too early.
  category: fix
  dev: TaskStore now applies step dependency/order guards to in-progress updates as well as done updates.
- 5ec04ec: summary: Prevent fast Coding tasks from merging before implementation runs.
  category: fix
  dev: Fast mode now requires implementation proof at the workflow merge boundary.
- a3ad0c8: summary: Keep workflow completion summaries running for fast-mode tasks.
  category: fix
  dev: Excludes completion-summary/summaryTarget task nodes from the fast-mode custom review/gate skip path.
- 228554d: summary: Prevent Compound Engineering artifacts from showing stale project files after project switches.
  category: fix
  dev: Clears cached artifact discovery on project changes and opens CE artifacts through the project workspace.
- 7ea9aee: summary: Keep the Goals dashboard view scoped to the selected project.
  category: fix
  dev: Threads projectId through Goals view reads, mutations, mission links, and AI description drafting.
- 151800f: summary: Fix mobile Planning Mode description editing so spaces can be entered.
  category: fix
  dev: Guards Planning Mode summary normalization so editable fields keep normal text input.
- 3886e58: summary: Show Compound Engineering workflow stage progress on task cards and details.
  category: fix
  dev: Skill-backed workflow nodes now record graph-node progress separately from optional workflow toggles.
- befb49b: summary: Chat messages now use the full width in narrow popup and sidebar chats.
  category: fix
  dev: ChatView.css adds a `@container chat-view (max-width: 30rem)` rule setting `.chat-message` to max-width:100%, plus the mobile viewport rule bumped from 90% to 100%.
- 2051516: summary: Concurrency panels now prefer live engine counts so running-agent totals stay accurate.
  category: fix
  dev: Prefer engine-manager task stores over stale registered/default fallback stores in the dashboard live-count source; add regressions for count normalization and scoped semaphore live-limit behavior.
- a583446: summary: Task-detail chat messages now use the full width in the right sidebar and narrow detail views.
  category: fix
  dev: TaskChatTab.css makes .task-chat-tab a `container-type: inline-size` query container and adds `@container task-chat-tab (max-width: 34rem)` collapsing the agent-header grid column and widening `.task-chat-entry--user` to 100%.
- 969d03b: summary: Import Tasks view now fills the full height of the screen for Issues and Pull Requests.
  category: fix
  dev: Embedded GitHubImportModal `.github-import-modal__body` gets `flex: 1` outside the <=640px block so the flex/height chain fills `.project-content`.
- fac7556: summary: Fix review tasks stuck when merge retries starve the executor's code-review revision pass.
  category: fix
  dev: recoverCompletedTask now refuses workflow-graph re-entry when the live task has incomplete steps or a remediation bounce (sendTaskBackForFix → scheduleWorkflowRerun) is already scheduled, so a pre-merge optional/advisory REVISE that reopens plan steps lets the executor finish them instead of re-passing the advisory step (budget exhausted) and looping on the "task has incomplete steps" merge gate. Regression: restart.integration.test.ts.
- 8eed09c: summary: Fix planning/chat failures when image attachment bytes do not match the file extension.
  category: fix
  dev: Adds detectImageMimeFromBytes in core and applies it in triage and dashboard chat attachment read paths.
- 3a83868: summary: Apply task reviewer model overrides consistently to reviewer and code-review lanes.
  category: fix
  dev: Reviewer sessions now resolve primary models through the validator-lane resolver, including test-mode forcing.
- 58a0c1f: summary: Workflow graph nodes now resume cleanly after engine pause-aborts.
  category: fix
  dev: Distinguishes engine-internal in-flight node aborts from genuine workflow node failures, re-enters the node through a bounded graph resume path, and emits a run-audit event for the recovery.
- d87db14: summary: Compact collapsed tool-call summaries in task-detail chat.
  category: fix
  dev: Updates TaskChatTab tool-call summary styling, responsive behavior, tests, and docs.
- 0a8a86c: summary: Show Z.ai icons for GLM model rows in Command Center token analytics.
  category: fix
  dev: Maps standalone glm-\* model labels through the shared provider-icon inference helper.
- d0a369e: summary: Show active tasks by default in the right sidebar and fix its task-detail back button.
  category: fix
  dev: Filters the right-dock Tasks list to active tasks by default, adds a Show Done toggle, keeps archived tasks hidden, and wires the header back arrow to the existing dock task close path.
- d7f26bb: summary: Keep Compound Engineering tasks running through checkout recovery, PR review policy, and merge handoff.
  category: fix
  dev: Graph-native workflow nodes reacquire missing worktrees, gate manual PR review on auto-merge off, link PRs to tasks, and project successful node progress at merge.
- e963be4: summary: Harden workflow graph recovery against stale plan replays and foreign landed tips.
  category: fix
  dev: Classifies stale in-review plan pause/resume replays and verifies task ownership before already-merged recovery finalization.
- c7cbd1d: summary: Prevent rebuilt stepwise workflow tasks from failing at parse on stale step pins.
  category: fix
  dev: Spec rebuild and AI replan handoff now clear persisted workflow foreach instances before reparsing PROMPT.md.
- 6451828: summary: Add consistent Plan Review, Code Review, and Browser Verification toggles to engineering workflows.
  category: fix
  dev: Quick Fix seeds all three optional groups off; other engineering built-ins seed plan/code review on and browser verification off.
- 7cd5552: summary: Make dashboard retry clear stale workflow step pins before re-execution.
  category: fix
  dev: Clears persisted workflow step instances on manual execution retry so parse-steps can repin the current plan.
- 03d4f95: summary: Separate Anthropic API-key auth from Claude subscription login cards.
  category: fix
  dev: Adds anthropic-subscription OAuth and anthropic-api-key UI ids mapped to upstream Anthropic credential storage.
- 57d8065: summary: Let workflow graphs prepare task worktrees before coding-mode nodes run.
  category: fix
  dev: Adds graph-owned node preparation so executor adapters only fulfill declared worktree requirements.
- 4184062: summary: Send ntfy notifications from workflow graph lifecycle and notify-node flows.
  category: fix
  dev: Workflow column transitions now use moveTask events; workflow-notify is enabled in default ntfy events.
- 1d21241: summary: Auto-retry stale parse pause-resume workflow failures instead of requiring operator action.
  category: fix
  dev: Re-enters safe in-review parse pause-abort replays with the shared graph resume retry budget.
- c93217d: summary: Prevent Plan Review approvals from looping back into triage as failures.
  category: fix
  dev: Parses explicit reviewer prose verdicts and applies default-on optional workflow steps when no explicit selection exists.
- b86ddf4: summary: Route failed Plan Review workflow steps back through triage for automatic replanning.
  category: fix
  dev: Orders Plan Review before execution steps and sends failed Plan Review results to needs-replan instead of executor fixes.
- 1f36516: summary: Prevent stale pause state from mislabeling workflow retries as engine pauses.
  category: fix
  dev: Clears executor pause-abort provenance on fresh dispatch, Plan Review replan, and manual retry.
- 399a4a2: summary: Let workflow-owned steps finish out of order without false step-progress failures.
  category: fix
  dev: Graph-owned step sessions now project step status with graph semantics and prompt agents not to call lifecycle update tools.
- 50ccd79: summary: Preserve files changed by workflow-owned parallel step sessions on task branches.
  category: fix
  dev: Step-session cherry-pick now uses merge-base ranges and skips empty cherry-picks instead of dropping real step commits.
- 6239b2a: summary: Make built-in Code Review block merge when it requests revisions.
  category: fix
  dev: Generic built-in code-review optional groups now use gateMode: gate; Browser Verification remains advisory.
- cb94fc8: summary: Recover workflow retries that restart after step execution has already begun.
  category: fix
  dev: Treat persisted foreach step pins as a parse resume signal instead of a graph failure.
- 2b73a0a: summary: Retry unavailable Plan Review without rewriting an accepted task plan.
  category: fix
  dev: Adds a triage retry path for plan-review-unavailable tasks that reuses PROMPT.md.
- c088f8a: summary: Keep Plan Review status visible while tasks execute after restart.
  category: fix
  dev: Preserves and repairs plan-review workflowStepResults when merge-state cleanup or old rows erased them.
- f430f5d: summary: Keep verification steps from starting before earlier workflow steps finish.
  category: fix
  dev: Step-session wave planning now respects graph step dependencies; unannotated steps remain sequential by default.
- 05c54fb: summary: Keep Plan Review status visible when execution resumes after stale merge cleanup.
  category: fix
  dev: Reconstructs passed Plan Review rows from task logs and makes mock test-mode sessions emit workflow-step parser events.
- 984e362: summary: Stop routing failed workflow execution into the review column.
  category: fix
  dev: Graph and execution failures now stay executable or failed in-place instead of handing errored tasks to in-review.
- 875cfad: summary: Prevent workflow tasks from reaching Done without durable merge confirmation.
  category: fix
  dev: Workflow graph merge finalization now requires mergeConfirmed proof before accepting done/no-op states.
- 6ce61af: summary: Add inner padding to Task Detail chat message blocks.
  category: fix
  dev: Keeps text, user, tool, and thinking block padding tokenized and border-boxed with responsive regression coverage.
- 123639c: summary: Prevent workflow tasks from completing with stale or partial merge proof.
  category: fix
  dev: Workflow finalization now validates incomplete steps, no-op proof, and branch file coverage before done.
- d22b8cc: summary: Swiping back on mobile now dismisses the open task detail view.
  category: fix
  dev: Routes mobile task-detail opens through useNavigationHistory pushNav/removeNav so the native back gesture (popstate) reverts to the originating board/list/dock surface across all detail surfaces.
- 6fc50d8: summary: Keep workflow merge nodes moving even when a workflow skips a review handoff.
  category: fix
  dev: Workflow merge primitives now establish the in-review merge boundary before requesting merge; non-gate skill output no longer requires a verdict.
- a84afc1: summary: Show post-merge verification as a post-merge optional workflow step.
  category: fix
  dev: Preserves optional-group `config.phase` when resolving workflow optional steps.
- b363270: summary: Preserve dashboard workflow selections per project across Board, List, Header, and Graph.
  category: fix
  dev: Board/List/Header/Graph workflow selection uses project-scoped localStorage and repairs stale ids.
- 41c0cf3: summary: Prevent scoped workflow tasks from getting stranded by unrelated branch residue.
  category: fix
  dev: Built-in optional workflow gates now default to three remediation attempts and review fixes carry File Scope guardrails.
- 7b43f73: summary: Footer concurrency markers now line up with the running-agent counts.
  category: fix
  dev: Align EngineControlMenu current-use marker math with CommandCenterControls by mapping utilization as current / cap instead of slider min/max coordinates.
- 167d242: summary: Keep Workflow simple-editor tabs reachable on mobile.
  category: fix
  dev: Makes the simple editor tab strip horizontally pannable on narrow touch viewports.
- a766813: summary: Prevent executor prompt setup from failing when a recovered task has no saved prompt.
  category: fix
  dev: Guards worktree prompt scoping against undefined task prompts while quarantining stale post-cutover engine tests.
- e80d85b: summary: Make task-detail Chat tool-call text easier to read without expanding collapsed rows.
  category: fix
  dev: TaskChatTab tool-call summary, kicker, label, and detail typography now use the readable base spacing token.
- c6c4a00: summary: Show timestamps on each task-detail chat block.
  category: feature
  dev: Adds per-block TaskChatTab timestamp rendering and regression coverage for text, tool, thinking, and user blocks.
- 9fd286b: summary: Keep built-in Code Review remediation recovering until review passes.
  category: fix
  dev: Built-in Code Review now defaults maxRevisions to unbounded while preserving workflow-authored numeric caps.
- 797b30c: summary: Show workflow names on aggregate board cards and task detail headers when available.
  category: feature
  dev: Reuses the board-workflows payload for detail custom fields and workflow-name badges.
- 0ff60a7: summary: Hide engine remediation banners while daemon auth token recovery is open.
  category: fix
  dev: Threads authTokenRecoveryOpen through DashboardBanners to suppress EngineStatusBanner and EngineUnavailableBanner.
- 6f2b8ab: summary: Retry unavailable Plan Review without rewriting existing task specs.
  category: fix
  dev: plan-review-unavailable triage tasks now rerun Plan Review/finalization from the existing PROMPT.md under global agent concurrency instead of launching the planner.
- 90b62b7: summary: Preserve explicit empty workflow step dependencies for parallel roots.
  category: fix
  dev: Keeps omitted dependsOn as previous-step fallback while treating [] as no dependencies.
- ffe2092: summary: Footer concurrency controls now ask before saving capacity changes.
  category: fix
  dev: Mirrors Command Center confirmation semantics in EngineControlMenu so global and per-project concurrency edits persist only after explicit confirmation.
- 7427fa3: summary: Show optional workflow block children as connected in the workflow editor.
  category: fix
  dev: Adds non-editable visual-only optional-group boundary connectors that are filtered from workflow IR saves.
- e4a9dc6: summary: Remove deleted tasks from the board and right sidebar immediately after deletion.
  category: fix
  dev: Updates the dashboard `useTasks` delete path to remove successfully deleted task ids from shared state and project task cache without waiting for SSE/refetch.
- ed21597: summary: Stop logging non-actionable missing configured skill-pattern info messages.
  category: fix
  dev: Missing configured skill patterns remain resolver diagnostics but are no longer emitted as runtime info logs.
- 224e8b4: summary: Reload the selected file when switching Files modal worktrees.
  category: fix
  dev: Keeps Files modal selected-path state while changing workspace/worktree.
- 480d4d0: summary: Let Git Manager inspect commit history from known worktrees.
  category: feature
  dev: Adds read-only Commits history targeting for Git-listed worktrees; mutating actions remain scoped to the current repository target.
- 45dd808: summary: Reuse fresh task data when returning to Board or List views.
  category: fix
  dev: Skips the useTasks false-to-true SSE catch-up fetch while the in-memory snapshot is within SWR_TASKS_MAX_AGE_MS.
- 9fb7069: summary: Dismiss mobile task details when Android Back is pressed before falling back to app exit.
  category: fix
  dev: Routes Capacitor Android Back through the dashboard navigation-history stack via a cancelable native event.
- d05ca21: summary: Preserve mobile board scroll after returning from task detail.
  category: fix
  dev: Restores the mobile board/card scroll snapshot after Back to board remounts the board.
- a039c93: summary: Group Done column sort and archive actions in one accessible actions menu.
  category: fix
  dev: Updates dashboard Done/complete column headers to use the shared column actions dropdown.
- 41ff08a: summary: Prevent fast workflow merges from completing before implementation steps run.
  category: fix
  dev: Blocks stale no-op merge proof from trapping unfinished workflow tasks and requeues premature merge-node failures.
- 2735534: summary: Restore reliable terminal keyboard shortcuts in embedded CLI session terminals.
  category: fix
  dev: SessionTerminal now mirrors TerminalModal copy/paste filtering, suppresses prop/read-only-ticket replay input, and keeps mobile composer submit on one path.
- b5da5d3: summary: Refresh custom provider model lists at startup and from Settings.
  category: feature
  dev: Adds persisted custom-provider model refresh routes and startup best-effort refresh for dashboard, serve, and daemon.
- a0b35c1: summary: Open Workflow simple-editor step details when rows are clicked.
  category: fix
  dev: Restores the simple graph row/pencil selection path for compact and mobile workflow editing.
- 3e0391e: summary: Make configured MCP tools available in planning and mission interviews.
  category: fix
  dev: Adds an explicit read-only MCP opt-in for planning and mission session factories with regression coverage.
- 04f06e6: summary: Preserve workflow setting values and prompt overrides during workflow export/import.
  category: fix
  dev: Workflow export envelopes now include settingValues and promptOverrides; imports restore them onto the new workflow id with store validation.
- d04ee5b: summary: Move the mobile task-detail workflow badge beside the updated timestamp.
  category: fix
  dev: Keeps the desktop task-detail header badge while showing a mobile-only timestamp-group badge.
- c848ce1: summary: Fix the mobile Engine Controls menu placement.
  category: fix
  dev: Keeps the footer EngineControlMenu as a viewport-safe mobile/tablet bottom panel while preserving the desktop anchored popover.
- 94ddfe1: summary: Document workflow-authoring tools in the packaged Fusion skill.
  category: fix
  dev: Syncs workflow extension registrations into generated skill references and capability tables.
- 8f0fde8: summary: Mobile back now reliably dismisses the open task detail, including right after closing and reopening it.
  category: fix
  dev: Hardens useNavigationHistory against close-reopen races and history/stack desync so popstate (and the fusion:native-back event) deterministically dismisses every task-detail surface.
- 52e4a26: summary: Move All workflows Board task-card workflow badges to the bottom-left.
  category: fix
  dev: Updates TaskCard workflowBadge placement and dashboard layout coverage.
- 85e925a: summary: Move task-detail workflow badges into the Updated timestamp metadata row.
  category: fix
  dev: Uses one canonical task-detail workflow badge across desktop and mobile detail surfaces.
- 082dd55: summary: Restore the Board All workflows view after refresh.
  category: fix
  dev: Persists the Board-only aggregate workflow sentinel while filtering it out of real-workflow selectors.
- ac87b1e: summary: Fix mobile terminal spacing after folded viewport changes.
  category: fix
  dev: Re-baselines terminal keyboard viewport metrics when foldable devices settle to a narrower posture.
- b450dd4: summary: Fix the mobile terminal workspace picker so its menu stays visible and reachable.
  category: fix
  dev: Portals and viewport-constrains the TerminalModal worktree listbox while preserving tab cwd semantics.
- 6b3eec0: summary: Collapse custom shadcn color controls by default in dashboard theme surfaces.
  category: fix
  dev: Adds an accessible shared show/collapse affordance for the custom shadcn color picker.
- 3cd5695: summary: Remove the board quick-add Plan button while keeping New Task planning available.
  category: fix
  dev: QuickEntryBox and InlineCreateCard no longer render data-testid="plan-button" or Plan click targets.
- 8f65186: summary: Fix mobile terminal spacing when folded phones open with the keyboard already visible.
  category: fix
  dev: TerminalModal now uses layout-viewport height for the initial focused keyboard-open folded posture and tests cover TerminalModal plus SessionTerminal.
- 70d7dca: summary: Skip unchanged plugin builds during workspace builds.
  category: performance
  dev: Root pnpm build now uses a git content-hash plugin build cache that includes local workspace dependency and root build config/tooling inputs.
- 9460497: summary: Let Anthropic subscription login power Anthropic model requests without a raw API key.
  category: fix
  dev: Bridges runtime provider `anthropic` to OAuth credentials stored under `anthropic-subscription` while preserving raw API-key precedence.
- 7e74fe3: summary: Make built-in Plan Review and Code Review revisions unbounded unless workflows set a cap.
  category: fix
  dev: Adds workflow values planReviewMaxRevisions and codeReviewMaxRevisions for per-workflow caps, including read-only built-ins.
- c5dd8c5: summary: Refresh dashboard task state immediately after Retry succeeds.
  category: fix
  dev: useTasks now replaces matching retry rows, updates project SWR task cache, and invalidates older fetches.
- 7beb64e: summary: Show workflow icons and wider names in the Quick Add workflow selector.
  category: fix
  dev: Reuses WorkflowIcon in QuickEntryBox and widens the tokenized selector/menu styles.
- 7f3bd80: summary: Count ephemeral task-worker runs in Command Center activity stats.
  category: fix
  dev: Activity analytics now unions usage_events and agentRuns by agent id for active-agent range/day counts.
- 2132a1c: summary: Fix mobile terminal character spacing after small font-size changes.
  category: fix
  dev: Reapplies settled xterm font metrics for TerminalModal and SessionTerminal at 10px keyboard-open states.
- 211b18b: summary: Make Shadcn Ember the default dashboard theme.
  category: feature
  dev: Adds the shadcn-ember color theme and updates default theme fallbacks.
- 3dd02dd: summary: Hide Quick Add node pickers when only local execution is available.
  category: fix
  dev: QuickEntryBox and InlineCreateCard now clear hidden stale node overrides before create submission.
- ea93f68: summary: Show workflow icons in the full New Task workflow picker.
  category: feature
  dev: Replaces the create-time TaskForm workflow native select with an icon-capable styled dropdown while preserving workflowId payload semantics.
- 7ca6c78: summary: Make the Quick Add workflow selector compact while keeping long menu names readable.
  category: fix
  dev: Narrows only the closed QuickEntryBox workflow trigger; menu width and workflow routing remain unchanged.
- 21fc286: summary: Add icon-only Quick Add image attachments with drag-and-drop support.
  category: feature
  dev: QuickEntryBox now shares image selection, paste, and drop intake with accessible pending-count labels.
- 254e97d: summary: Rename the task-detail Chat tab to Activity and make it first.
  category: feature
  dev: Keeps the internal `chat` tab id compatible for existing deep links and plugin callers.
- bba415f: summary: Preserve legacy task feed and raw log access under Activity.
  category: fix
  dev: Keeps legacy task-detail logs callers routed to Activity → Feed while Raw Logs remains the only raw-log-fetching segment.
- f677ab4: summary: Add a steering entry affordance to task Activity.
  category: feature
  dev: Labels the Activity Current composer as steering/refinement and covers Feed/Raw Logs placement.
- ddfd841: summary: Make task-detail Chat answer status and progress questions from bounded task context.
  category: feature
  dev: Adds server-built task planner chat context and task-scoped send validation.
- 0915377: summary: Reuse the shared question UI for task-detail planner Chat clarification prompts.
  category: fix
  dev: Task planner Chat now renders fn_ask_question prompts through ChatQuestionResponse and marks submitted answers read-only.
- 9f72158: summary: Fix mobile Planning Mode summary description Expand and Collapse controls.
  category: fix
  dev: Splits the summary description label from adjacent Markdown and Expand controls and adds mobile regression coverage.
- 2284d66: summary: Collapse task-detail branch groups by default with a more compact summary.
  category: fix
  dev: Keeps branch-group member and PR actions available after expanding the task-detail card.
- 5e0c567: summary: Hide branch group chrome while the task Activity chat is maximized.
  category: fix
  dev: TaskDetailModal skips mounting BranchGroupCard during expanded Activity chat so branch controls are not focusable.
- 863c5ce: summary: Rename task Activity Current to Live and allow expanding all Activity segments.
  category: feature
  dev: Keeps legacy Activity `current`, `chat`, and `logs` routing compatibility while sharing the expand control across Live, Feed, and Raw Logs.
- d58ba26: summary: Move the Quick Add attachment button next to Save in the expanded action row.
  category: fix
  dev: Preserves FN-7304 icon-only attachment behavior while updating QuickEntryBox action order coverage.
- b52f92c: summary: Keep Planner Chat compact while preserving expanded task controls.
  category: fix
  dev: Aligns Planner Chat composer height with Activity chat and keeps Priority, Execution Mode, and tabs visible in expanded mobile task details.
- 4ae0456: summary: Rename the task-detail title summarization button to Summarize.
  category: fix
  dev: Updates task detail UI copy and focused dashboard tests.
- aa4c2c1: summary: Remove the AI Refine action from Quick Add task creation.
  category: fix
  dev: QuickEntryBox no longer renders or calls the refine-text path; TaskForm refine remains available.
- 7d2bd97: summary: Make task planner chats appear only after user interaction and expire on archive.
  category: fix
  dev: Planner-chat tabs now load history without pre-creating sessions; archive cleanup deletes task-planner sessions.
- ae1ca5c: summary: Make Shadcn Ember color tokens match Ember exactly.
  category: fix
  dev: Aligns Shadcn Ember inherited Ember-owned CSS tokens and adds regression coverage.
- d786e7b: summary: Align footer concurrency current-use dots with Command Center sliders.
  category: fix
  dev: Mirrors Command Center range geometry in the footer Engine Controls popup while preserving current/cap utilization math.
- 45b1ee6: summary: Replan active tasks after confirming execution-mode changes.
  category: fix
  dev: Dashboard inline execution-mode changes on todo/in-progress tasks now confirm and call the spec rebuild path.
- f840cbc: summary: Preserve board column scroll during dashboard refresh and viewport stabilization.
  category: fix
  dev: Narrows mobile board stabilization so task/workflow refresh and resize events pin document drift without resetting #board.scrollLeft.
- 5ff81cb: summary: Remove the extra steering guidance copy from task Activity chat.
  category: fix
  dev: Keeps the Activity composer APIs intact while removing the visible TaskChatTab label/hint shell.
- 4ab4aae: summary: Replace task Activity subtabs with a compact Live, Feed, Raw dropdown.
  category: fix
  dev: Keeps legacy Activity segment ids and initial-tab routing while removing the old segmented-control shell.
- 519f158: summary: Persist Remote Access settings when saving from the dashboard on Windows.
  category: fix
  dev: Main Settings Save now writes the canonical remoteAccess settings payload.
- 058a041: summary: Keep the mobile Planning Mode New session button pinned at the bottom.
  category: fix
  dev: Bounds the mobile Planning sessions list so only saved sessions scroll above the footer CTA.
- 998a7f2: summary: Use workflow Plan Review as the single pre-execution plan gate.
  category: fix
  dev: Triage no longer injects fn_review_spec or requires a separate spec-review approval before workflow execution.
- 36d090c: summary: Keep Plan Review in triage and prevent duplicate execution-time plan reviews.
  category: fix
  dev: Triage now runs enabled Plan Review before releasing tasks to execution; execution graph skips an already-passed Plan Review.
- 998a7f2: summary: Preserve Quick Add tasks with all workflow optional steps unchecked.
  category: fix
  dev: Sends empty enabledWorkflowSteps from Quick Add and honors explicit empty workflow selections in task details.
- 2135bd6: summary: Record completion summaries for workflow-driven tasks.
  category: fix
  dev: Workflow graph completions and resumed workflow merge work items now backfill task.summary when no agent summary exists.
- b169072: summary: Block workflow tasks from bypassing merge proof when finalizing to done.
  category: fix
  dev: Adds a workflow done-bypass guard for selected workflow tasks using skipMergeBlocker.
- 24d7881: summary: Show workflow review failures as explicit replan and remediation nodes.
  category: fix
  dev: Built-in review gate failures now route to graph-owned remediation nodes before executor scheduling fallback.
- 4a1a043: summary: Stop showing stale in-review stall badges while agents are actively streaming logs.
  category: fix
  dev: TaskStore stall hydration now treats fresh buffered or persisted agent-log activity as active ownership.
- 2a5a108: summary: Keep dashboard workflow selection stable after creating refinement tasks.
  category: fix
  dev: Done-task chat refinement now clears its temporary composer bubble after successful creation.
- 9e23d6c: summary: Prevent workflow tasks from duplicating plan review during implementation.
  category: fix
  dev: Graph-owned execution sessions no longer receive or prompt for legacy per-step review tools.
- 234248a: summary: Retry workflow merge-node pause aborts while merge review is active.
  category: fix
  dev: Treats transient in-review statuses such as reviewing/merging as safe for bounded merge retry.
- 6005f89: summary: Keep Planner Chat compact on mobile with an inline composer and provider-icon model badge.
  category: fix
  dev: Adjusts TaskPlannerChatTab mobile CSS and replaces the text model badge with a ProviderIcon tooltip.
- 3327953: summary: Add task activity breadcrumbs for workflow pause-abort recovery.
  category: fix
  dev: Logs pause-abort marker source, aborted surfaces, and graph classification details.
- eb83c81: summary: Align per-step review coding with default coding gates and session settings.
  category: fix
  dev: Removes the extra generic review seam from Coding (per-step review) and makes StepSessionExecutor honor runStepsInNewSessions=false by reusing the primary sequential session while keeping graph step-review boundaries.
- cfd9d5b: summary: Stop repeat no-op phantom-reservation audit writes and preserve the worktree across phantom binding reclaim.
  category: fix
  dev: reconcilePhantomCommittedReservations now emits the task:reconcile-phantom-committed-reservation audit row only when orphaned child rows were actually pruned, instead of every maintenance tick (~19k wasted writes/day); the committed reservation stays committed so the ID is never reused. clearPhantomExecutorBinding gains a preserveWorktrees option the self-healing phantom reclaim uses so moveTask(preserveWorktree:true) re-dispatch reattaches to the same worktree instead of orphaning it and acquiring a new one (FN-7249). Regression: store-phantom-reservation-reconcile.test.ts, executor-workspace.test.ts.
- d96eb3c: summary: Make the task Plan prompt editor span the full task-detail card width.
  category: fix
  dev: Adds scoped TaskDetailModal Plan prompt width guards for modal, embedded, and mobile surfaces.
- 658b351: summary: Scope external-integration plan evidence checks to Coding (per-step review).
  category: fix
  dev: Triage no longer blocks generated plans for missing external evidence; the per-step review Plan Review gate does.
- e37260b: summary: Keep Planner Chat expanded context visible while removing repeated header guidance.
  category: fix
  dev: Planner Chat hides the header subtext, keeps that guidance in the empty state, and preserves title/workflow context when expanded on mobile.
- 7c53c97: summary: Compact Planner Chat chrome and align Activity Live with the same plain composer row.
  category: fix
  dev: Planner Chat removes its redundant header, moves the provider icon to the empty state, and Activity Live drops its card-wrapped composer shell.
- 65822a0: summary: Keep Planner Chat spacing stable when expanding task details.
  category: fix
  dev: Stabilizes task-detail Planner Chat CSS so expanded mode changes height allocation without padding jumps.
- 2a5a108: summary: Keep refinement tasks on the source task workflow board.
  category: fix
  dev: TaskStore.refineTask now inherits explicit workflow selections atomically during creation.
- c1d7da3: summary: Refresh branch group task-detail completion live as member tasks change.
  category: fix
  dev: Refetches branch group summaries on task lifecycle SSE events and reconnect.
- a92f15e: summary: Remove the icon from the Quick Add Plan action while preserving the text button behavior.
  category: fix
  dev: Updates QuickEntryBox and regression coverage for the text-only Plan action.
- 5ee1964: summary: Remove redundant workflow labels from expanded task-card step lists.
  category: fix
  dev: Workflow step rows still show names, status dots, and active badges; the aggregate card workflow badge is unchanged.
- b829821: summary: Allow review steps to target a validated external checkout.
  category: fix
  dev: Resolves explicit review checkout metadata before spawning read-only step reviewers.
- a48ff30: summary: Keep task-detail Activity segment tabs equal-height with smaller labels.
  category: fix
  dev: Normalizes Live/Feed/Raw Logs segmented-control sizing in the dashboard task detail panel.
- 8079722: summary: Retry configured fallback models when a selected provider model returns a not-found error.
  category: fix
  dev: Classifies structured provider model 404 payloads, including Anthropic not_found_error, as model-selection failures.
- 90756f9: summary: Wait for task store secret database handles to close before cleanup.
  category: fix
  dev: Awaits the async secrets store close path during TaskStore shutdown to avoid teardown races.
- 1bf86d1: summary: Add clearer spacing between workflow badge icons and labels.
  category: fix
  dev: Applies token-based column gaps to dashboard task-card and task-detail workflow badges.
- b363270: summary: Keep Board and List workflow choices selected across refreshes and route returns.
  category: fix
  dev: Uses project-scoped localStorage workflow-selection helpers shared with header and graph selectors.
- 50f8807: summary: Prevent stale workflow recovery log entries from sending incorrect notifications.
  category: fix
  dev: Adds workflowTransitionNotification task markers for pause-abort recovery requeues and avoids log-text notification heuristics.
- e09d450: summary: Harden workflow lifecycle recovery, post-merge gates, warnings, and notifications.
  category: fix
  dev: Adds post-merge gate blocking, lifecycle warning analysis, recovery-route audit metadata, and workflow transition notification classification.

### runfusion.ai

#### Patch Changes

- Updated dependencies [b2e1c3e]
- Updated dependencies [368f18c]
- Updated dependencies [42226ed]
- Updated dependencies [7eca99c]
- Updated dependencies [01e0433]
- Updated dependencies [c54b231]
- Updated dependencies [0ff60a7]
- Updated dependencies [4441b72]
- Updated dependencies [5ec04ec]
- Updated dependencies [a3ad0c8]
- Updated dependencies [228554d]
- Updated dependencies [7ea9aee]
- Updated dependencies [151800f]
- Updated dependencies [3886e58]
- Updated dependencies [353aaf3]
- Updated dependencies [6cf6ad3]
- Updated dependencies [befb49b]
- Updated dependencies [2051516]
- Updated dependencies [013d50f]
- Updated dependencies [a583446]
- Updated dependencies [969d03b]
- Updated dependencies [fac7556]
- Updated dependencies [f3d9bfb]
- Updated dependencies [8eed09c]
- Updated dependencies [3a83868]
- Updated dependencies [58a0c1f]
- Updated dependencies [d87db14]
- Updated dependencies [0a8a86c]
- Updated dependencies [d0a369e]
- Updated dependencies [d7f26bb]
- Updated dependencies [e963be4]
- Updated dependencies [c7cbd1d]
- Updated dependencies [6451828]
- Updated dependencies [7cd5552]
- Updated dependencies [03d4f95]
- Updated dependencies [57d8065]
- Updated dependencies [4184062]
- Updated dependencies [1d21241]
- Updated dependencies [c93217d]
- Updated dependencies [b86ddf4]
- Updated dependencies [1f36516]
- Updated dependencies [399a4a2]
- Updated dependencies [50ccd79]
- Updated dependencies [6239b2a]
- Updated dependencies [cb94fc8]
- Updated dependencies [2b73a0a]
- Updated dependencies [c088f8a]
- Updated dependencies [f430f5d]
- Updated dependencies [05c54fb]
- Updated dependencies [984e362]
- Updated dependencies [875cfad]
- Updated dependencies [6ce61af]
- Updated dependencies [123639c]
- Updated dependencies [d22b8cc]
- Updated dependencies [6fc50d8]
- Updated dependencies [a84afc1]
- Updated dependencies [b363270]
- Updated dependencies [41c0cf3]
- Updated dependencies [7b43f73]
- Updated dependencies [167d242]
- Updated dependencies [5b668d2]
- Updated dependencies [a766813]
- Updated dependencies [e80d85b]
- Updated dependencies [c6c4a00]
- Updated dependencies [797b30c]
- Updated dependencies [9fd286b]
- Updated dependencies [797b30c]
- Updated dependencies [797b30c]
- Updated dependencies [0ff60a7]
- Updated dependencies [6f2b8ab]
- Updated dependencies [90b62b7]
- Updated dependencies [ffe2092]
- Updated dependencies [7427fa3]
- Updated dependencies [e4a9dc6]
- Updated dependencies [ed21597]
- Updated dependencies [224e8b4]
- Updated dependencies [4623211]
- Updated dependencies [480d4d0]
- Updated dependencies [480d4d0]
- Updated dependencies [480d4d0]
- Updated dependencies [924bcb9]
- Updated dependencies [45dd808]
- Updated dependencies [9fb7069]
- Updated dependencies [d05ca21]
- Updated dependencies [17fce43]
- Updated dependencies [a039c93]
- Updated dependencies [41ff08a]
- Updated dependencies [ebb805d]
- Updated dependencies [2735534]
- Updated dependencies [b5da5d3]
- Updated dependencies [ea0707c]
- Updated dependencies [a0b35c1]
- Updated dependencies [3e0391e]
- Updated dependencies [04f06e6]
- Updated dependencies [d04ee5b]
- Updated dependencies [c848ce1]
- Updated dependencies [94ddfe1]
- Updated dependencies [8f0fde8]
- Updated dependencies [6c8884e]
- Updated dependencies [52e4a26]
- Updated dependencies [85e925a]
- Updated dependencies [082dd55]
- Updated dependencies [ac87b1e]
- Updated dependencies [b450dd4]
- Updated dependencies [5f67c85]
- Updated dependencies [f0a15db]
- Updated dependencies [6b3eec0]
- Updated dependencies [3cd5695]
- Updated dependencies [8f65186]
- Updated dependencies [70d7dca]
- Updated dependencies [2335a07]
- Updated dependencies [9460497]
- Updated dependencies [7e74fe3]
- Updated dependencies [c5dd8c5]
- Updated dependencies [7beb64e]
- Updated dependencies [7f3bd80]
- Updated dependencies [2132a1c]
- Updated dependencies [211b18b]
- Updated dependencies [3dd02dd]
- Updated dependencies [ea93f68]
- Updated dependencies [7ca6c78]
- Updated dependencies [21fc286]
- Updated dependencies [254e97d]
- Updated dependencies [e6be1f7]
- Updated dependencies [bba415f]
- Updated dependencies [f677ab4]
- Updated dependencies [db7b46f]
- Updated dependencies [4550970]
- Updated dependencies [ddfd841]
- Updated dependencies [cb0d38a]
- Updated dependencies [0915377]
- Updated dependencies [9f72158]
- Updated dependencies [2284d66]
- Updated dependencies [5e0c567]
- Updated dependencies [2f5e15a]
- Updated dependencies [863c5ce]
- Updated dependencies [d58ba26]
- Updated dependencies [b52f92c]
- Updated dependencies [4ae0456]
- Updated dependencies [aa4c2c1]
- Updated dependencies [7d2bd97]
- Updated dependencies [ae1ca5c]
- Updated dependencies [d786e7b]
- Updated dependencies [45b1ee6]
- Updated dependencies [f840cbc]
- Updated dependencies [5ff81cb]
- Updated dependencies [4ab4aae]
- Updated dependencies [519f158]
- Updated dependencies [058a041]
- Updated dependencies [998a7f2]
- Updated dependencies [36d090c]
- Updated dependencies [998a7f2]
- Updated dependencies [2135bd6]
- Updated dependencies [b169072]
- Updated dependencies [24d7881]
- Updated dependencies [4a1a043]
- Updated dependencies [2a5a108]
- Updated dependencies [9e23d6c]
- Updated dependencies [234248a]
- Updated dependencies [6005f89]
- Updated dependencies [3327953]
- Updated dependencies [eb83c81]
- Updated dependencies [cfd9d5b]
- Updated dependencies [d96eb3c]
- Updated dependencies [658b351]
- Updated dependencies [e37260b]
- Updated dependencies [7c53c97]
- Updated dependencies [65822a0]
- Updated dependencies [2a5a108]
- Updated dependencies [c1d7da3]
- Updated dependencies [a92f15e]
- Updated dependencies [5ee1964]
- Updated dependencies [e2702ba]
- Updated dependencies [b829821]
- Updated dependencies [a48ff30]
- Updated dependencies [8079722]
- Updated dependencies [6ce0b44]
- Updated dependencies [90756f9]
- Updated dependencies [da15c1c]
- Updated dependencies [1bf86d1]
- Updated dependencies [b363270]
- Updated dependencies [50f8807]
- Updated dependencies [e09d450]
  - @runfusion/fusion@0.52.0

## 0.51.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.51.0
- @fusion/engine@0.51.0
- @fusion/i18n@0.39.14
- @fusion-plugin-examples/cli-printing-press@0.1.31
- @fusion-plugin-examples/compound-engineering@0.1.14
- @fusion-plugin-examples/dependency-graph@0.1.45
- @fusion-plugin-examples/roadmap@0.1.33
- @fusion-plugin-examples/cursor-runtime@0.1.33
- @fusion-plugin-examples/droid-runtime@0.1.40
- @fusion-plugin-examples/hermes-runtime@0.2.64
- @fusion-plugin-examples/openclaw-runtime@0.2.64
- @fusion-plugin-examples/paperclip-runtime@0.2.64

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.51.0
- @fusion/dashboard@0.51.0
- @fusion/engine@0.51.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.51.0
- @fusion/pi-claude-cli@0.51.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.51.0

### @runfusion/fusion

#### Minor Changes

- f7e20ab: summary: Add a Chat tab to the right sidebar so you can chat inline and pop it out.
  category: feature
  dev: Registers ChatView as the always-visible `chat` overflow-view entry in the right dock.
- dc54b61: summary: Tasks with a manually-created open Pull Request are no longer auto-merged.
  category: feature
  dev: New PrInfo.manual flag set by POST /tasks/:id/pr/create; allowsAutoMergeProcessing now returns false when a task has an open manual PR (status === "open"), excluding it from the engine merge queue and self-healing sweeps until the human merges the PR. Pipeline (PR-merge-strategy) PRs are unaffected. FN-7182.
- d9a518c: summary: Fast-mode tasks now plan with a lean, speed-first prompt routed through the workflow.
  category: feature
  dev: Replaces the verbose built-in `planning-fast` seam prompt (FAST_TRIAGE_PROMPT_TEXT) with a concise variant; resolution still prefers a workflow's `planning-fast` seam and falls back to the built-in.
- 7ebf58e: summary: CE HTML plans and brainstorm docs now get report-only ce-doc-review instead of being skipped.
  category: feature
  dev: Updates bundled Compound Engineering ce-doc-review handoffs so HTML runs review without autofix/write-back.
- fecb27e: summary: CE HTML docs now support DOM-validated in-place ce-doc-review fixes with report-only fallback.
  category: feature
  dev: Adds a direct parse5 CE HTML mutation helper with atomic writes, rollback, and allowlisted operations.
- 6ca5118: summary: Close the Quick Chat window by clicking outside it.
  category: feature
  dev: New opt-in `closeOnOutsidePointerDown` prop on FloatingWindow; enabled only for the Quick Chat (windowKey="chat-modal"). Uses a capture-phase document pointerdown listener that excludes in-flight drag/resize and nested dialog/floating surfaces. Task pop-outs are unaffected.
- 605e4d7: summary: Emit run-audit telemetry for agent performance reflections.
  category: feature
  dev: Adds reflection:generated/skipped/failed DatabaseMutationType events emitted from AgentReflectionService.generateReflection; metadata carries ids/counts/outcomes only.
- 631e8fc: summary: CE HTML docs can define and safely repair malformed checklists in ce-doc-review.
  category: feature
  dev: Adds parse5-backed canonical checklist repair with validation, atomic writes, and report-only fallback.
- 2448447: summary: Add a project setting to show or hide worktree names and grouping on the board.
  category: feature
  dev: New project setting `showWorktreeGrouping` (default false). When true, Column groups WIP tasks by worktree in both legacy and workflow modes; when false, WIP columns render plain task cards.
- 34efa8b: summary: Refinement tasks are now titled with the source task ID followed by the entered comment.
  category: feature
  dev: TaskStore.refineTask now sets title = "{sourceId}: {feedback}"; normalization is skipped to preserve the source-id prefix; FN-7165.
- a0602d0: summary: Add a project setting to open task details in the right sidebar instead of the full panel.
  category: feature
  dev: New project setting `openTasksInRightSidebar` (default false). When true and the right dock is available, board card clicks render the task in the right dock; falls back to the full-panel view on mobile / when the dock is inactive.
- 4118061: summary: The Create PR dialog is now movable and resizable like other Fusion pop-outs.
  category: feature
  dev: PrCreateModal now renders inside the shared FloatingWindow (windowKey "pr-create", persistGeometryKey "floating-window:pr-create") instead of a fixed .modal-overlay; geometry persists, mobile stays full-screen via CSS, and overlay click-to-dismiss was dropped (close via X / Cancel / Escape).
- 5d9184d: summary: Add a pin toggle to the right sidebar to push content aside instead of overlaying it.
  category: feature
  dev: New persisted localStorage flag `fusion:right-dock-pinned` (default false). When pinned, `.right-dock` switches from absolute overlay to in-flow (`right-dock--pinned`, position: relative) so the shell flex layout reflows `.project-content`; unpinned restores overlay. Toggle lives in the right-dock toolbar.
- fc958bc: summary: Task detail Review tab now hides HTML comments and shows comment avatars, human/bot badges, and author-type filtering.
  category: feature
  dev: TaskReviewTab renders bodies via the shared sanitized MailboxMessageContent and a new app/utils/githubCommentAuthor helper for bot/avatar derivation.
- 9c207fd: summary: Add project settings to customize the AI prompts for PR title and description generation.
  category: feature
  dev: New project settings `prTitlePromptInstructions` / `prDescriptionPromptInstructions` (default undefined) are appended to the Create PR dialog's metadata-generation system prompt in generatePrMetadata.
- 65abae2: summary: Improve AI-generated PR titles and descriptions, and show a clear loading state while the description generates.
  category: feature
  dev: Rewrote the pr-metadata-generator system/context prompt (exported as a named default constant) for grounded, conventional-commit-style output while preserving the strict {title,summary,changes,testing,linkedTask} JSON schema; PrCreateModal now renders a skeleton + aria-busy loading affordance with disabled inputs during generation that clears into content or the existing error/manual-fallback path.
- 9050ee1: summary: Add an "Address PR feedback" button that starts an AI session to resolve PR review comments.
  category: feature
  dev: New POST /tasks/:id/pr/address-feedback route seeds a ce-resolve-pr-feedback steering prompt and wakes the assigned agent; button gates on linked-PR actionable feedback (commentCount or CHANGES_REQUESTED).
- 4405dec: summary: Re-engage an executor when users chat on in-review tasks.
  category: feature
  dev: Shares the review-address re-engagement helper for Chat steering and Comments-tab task comments while preserving PR-await guards.

#### Patch Changes

- e5a0273: summary: Artifact lists now refresh live when new artifacts are registered.
  category: fix
  dev: TaskStore emits artifact:registered SSE; useArtifacts also accepts message:sent/message:received and coalesces scoped refreshes.
- 524c15c: summary: Agents no longer pause tasks on failure — pausing is reserved for explicit user requests.
  category: fix
  dev: Adds a no-pause-on-failure standing rule to HEARTBEAT_SYSTEM_PROMPT / HEARTBEAT_NO_TASK_SYSTEM_PROMPT, clarifies the fn_task_pause tool description, and regenerates the fusion skill docs (sync:fusion-skill).
- 7a2137c: summary: Permanent agents can ask the user a question directly without an approval gate.
  category: fix
  dev: Classify fn_ask_question in COORDINATION_EXEMPT_TOOLS and READONLY_FN_TOOLS (gating-classifications.ts) so both the permanent-agent gate and action gate auto-allow it, mirroring fn_send_message.
- c48dcae: summary: Compound Engineering now uses a distinct sidebar icon instead of duplicating Insights.
  category: fix
  dev: Plugin dashboard view icon changed Sparkles → Boxes; registered `boxes` in dashboard PLUGIN_NAV_ICON_MAP so desktop + mobile nav resolve it.
- 581f850: summary: Compound Engineering sidebar navigation now matches its Boxes header icon.
  category: fix
  dev: Pins Compound Engineering plugin nav entries to Boxes by plugin id so stale dashboard view metadata cannot render Sparkles/Grid3X3 in desktop or mobile navigation.
- 100164d: summary: Ephemeral/task-worker agents now show their token usage on the dashboard.
  category: fix
  dev: Derives zero/absent per-agent dashboard totals from task token usage and allows ephemeral Agent Detail token windows.
- d7a02c4: summary: Stopping the engine or pausing a project now frees its global agent slots for other projects.
  category: fix
  dev: InProcessRuntime now returns the project's held slots back to the shared cross-project AgentSemaphore after abort+drain on stop, and ProjectEngineManager.pauseProject/stopAll return residual slots per project without clobbering slots held by other projects.
- bb89e1e: summary: Project Dashboard cards now say "Stop engine"/"Start engine" instead of "Pause"/"Resume".
  category: feature
  dev: Relabels ProjectCard pause/resume controls; pauseProject already stops the engine, so behavior is unchanged. i18n projectCard.\* keys updated (en) with empty-string fallback for other locales.
- b570a83: summary: Missions tab now always opens the mission overview instead of a specific mission.
  category: fix
  dev: Removed MissionManager cache-restore and default-select effects; targetMissionId deep-links and interview resume still open a specific mission.
- 8ef9750: summary: Theme the quick-entry steps drop-down with canonical dashboard menu tokens.
  category: fix
  dev: Aligns WorkflowOptionalStepsDropdown panel CSS with shared dropdown surface, border, radius, shadow, and hover tokens.
- a95cfa7: summary: Running-agent counts include active in-review agents, and the concurrency use-marker is no longer off by one.
  category: fix
  dev: Adds shared isRunningAgentTask/countRunningAgentTasks in @fusion/core; engine concurrency.persistedTopLevelAgentSlots and the dashboard/CLI count surfaces delegate to it. CommandCenterControls use-marker ratio is now 0-based.
- 987abc7: summary: Tasks sent back by Code Review or Browser Verification verdicts now re-run and complete their steps before re-checking.
  category: fix
  dev: Fixes the post-verdict remediation bounce (requestPreMergeOptionalStepFix → sendTaskBackForFix → reopenLastStepForRevision → scheduleWorkflowRerun → graph re-run) so resumed execution re-launches the executor and drives reopened implementation/verification/delivery steps and the verdict-demanded fix to done across both in-progress and in-review bounce sources, bounded by the existing maxRevisions/maxPostReviewFixes budget.
- bee93c3: summary: Footer no longer blinks and the concurrency panel stays open across status refreshes.
  category: fix
  dev: Keeps executor stats loading initial-only and guards the footer loading branch after populated render.
- 7923977: summary: Keep Create PR preview commit SHAs readable on one line.
  category: fix
  dev: Corrects the dashboard Create Pull Request commit-row grid and guards the DOM contract in tests.
- e42679d: summary: Stuck triage re-queues now resume from the drafted plan instead of restarting planning from scratch.
  category: fix
  dev: triage.ts stuck-abort paths seed buildSpecificationPrompt with the on-disk PROMPT.md draft, or a non-empty plan task document when PROMPT.md is absent, and bound consecutive triage stuck-retries by settings.maxStuckKills before escalating to failed/paused.
- 9f45f10: summary: Stuck re-queue no longer loses uncommitted work while keeping steps marked complete.
  category: fix
  dev: Reconciles lost-work steps before worktree removal across all three executor stuck-requeue paths; corrects the preserveProgressOnStuckRequeue docstring.
- 01fe47d: summary: Fix the Create PR dialog spinner, diff preview default, and stray-click dismissal behavior.
  category: fix
  dev: PrCreateModal keeps the FloatingWindow no-backdrop-dismiss path, defaults the diff/commit <details> closed, and time-bounds generatePrMetadata with PR_METADATA_TIMEOUT_MS so hangs use the existing error/manual-body fallback.
- 5b71bdb: summary: PR badge color now follows GitHub status: green/gray/purple/red plus a conflict color.
  category: fix
  dev: Adds getPrBadgeModifierClass and a token-backed --color-merged badge modifier.
- 11e5dde: summary: Show active project pull requests in the Pull Requests sidebar and main view.
  category: fix
  dev: Adds PullRequestView list mode for no-id hosts with selectable detail and back navigation.
- 27b0cbb: summary: The PR number in a task's Pull Request tab now links to the pull request on GitHub.
  category: feature
  dev: PrCard (PrPanel.tsx) wraps the pr-number in an anchor to prInfo.url (new tab, rel=noopener); plain-span fallback when no URL.
- b60a743: summary: Fix "Request revision" error on reviewer-agent task reviews.
  category: fix
  dev: review/address now validates selected items against the same canonical review source the UI renders (buildDirectTaskReviewData / getPrReviewDetails) instead of the persisted reviewState.items.
- fb509b1: summary: Fix Compound Engineering, Quick fix, and Review-heavy workflow tasks getting stuck in Todo.
  category: fix
  dev: linear() built-in workflows now synthesize the canonical default column traits (hold(capacity) on todo, wip on in-progress, merge on in-review) matching BUILTIN_CODING_WORKFLOW_IR, so the hold/release sweep dispatches their todo cards. Fixes FN-7190.
- 8d3c15e: summary: Theme quick-add optional-step checkboxes and phase badges consistently.
  category: fix
  dev: Co-locates workflow phase badge CSS with the shared helper and applies the dashboard checkbox accent token.
- f0b3003: summary: Keep Summary token table model names readable in narrow task detail panels.
  category: fix
  dev: Adds token-table CSS min-width and wrap-contract regression coverage for right-dock layouts.
- b5ed4e0: summary: Pressing q (or Ctrl+C) in the TUI now quits cleanly without engine logs bleeding onto your shell.
  category: fix
  dev: Two-part fix. (1) dashboard.ts shutdown/devShutdown arm an unref'd 3s hard-exit watchdog on the first signal and force an immediate process.exit(0) on a second signal, so a hung stopAllDevServers/engine/central-core teardown can no longer leave the process alive. (2) Root cause of the "TUI keeps rendering after q" symptom: dispose() called logSink.releaseConsole() (re-pointing console._ at the terminal) before tui.stop() restored the shell, so slow engine/mesh/dev-server teardown logs painted over the recovered prompt. dispose() now calls the new logSink.silence() instead, dropping all sink + console._ output from quit to exit. Shutdown step diagnostics (timeShutdownStep + the watchdog stall line) are gated behind FUSION_DEBUG_SHUTDOWN=1 so a normal quit is pristine.

### runfusion.ai

#### Patch Changes

- Updated dependencies [e5a0273]
- Updated dependencies [f7e20ab]
- Updated dependencies [dc54b61]
- Updated dependencies [524c15c]
- Updated dependencies [7a2137c]
- Updated dependencies [c48dcae]
- Updated dependencies [581f850]
- Updated dependencies [d9a518c]
- Updated dependencies [7ebf58e]
- Updated dependencies [fecb27e]
- Updated dependencies [100164d]
- Updated dependencies [d7a02c4]
- Updated dependencies [6ca5118]
- Updated dependencies [bb89e1e]
- Updated dependencies [b570a83]
- Updated dependencies [8ef9750]
- Updated dependencies [605e4d7]
- Updated dependencies [631e8fc]
- Updated dependencies [a95cfa7]
- Updated dependencies [2448447]
- Updated dependencies [987abc7]
- Updated dependencies [bee93c3]
- Updated dependencies [34efa8b]
- Updated dependencies [a0602d0]
- Updated dependencies [4118061]
- Updated dependencies [7923977]
- Updated dependencies [5d9184d]
- Updated dependencies [e42679d]
- Updated dependencies [9f45f10]
- Updated dependencies [01fe47d]
- Updated dependencies [5b71bdb]
- Updated dependencies [fc958bc]
- Updated dependencies [11e5dde]
- Updated dependencies [9c207fd]
- Updated dependencies [65abae2]
- Updated dependencies [27b0cbb]
- Updated dependencies [9050ee1]
- Updated dependencies [b60a743]
- Updated dependencies [4405dec]
- Updated dependencies [fb509b1]
- Updated dependencies [8d3c15e]
- Updated dependencies [f0b3003]
- Updated dependencies [b5ed4e0]
  - @runfusion/fusion@0.51.0

## 0.50.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.50.0
- @fusion/engine@0.50.0
- @fusion/i18n@0.39.13
- @fusion-plugin-examples/cli-printing-press@0.1.30
- @fusion-plugin-examples/compound-engineering@0.1.13
- @fusion-plugin-examples/dependency-graph@0.1.44
- @fusion-plugin-examples/roadmap@0.1.32
- @fusion-plugin-examples/cursor-runtime@0.1.32
- @fusion-plugin-examples/droid-runtime@0.1.39
- @fusion-plugin-examples/hermes-runtime@0.2.63
- @fusion-plugin-examples/openclaw-runtime@0.2.63
- @fusion-plugin-examples/paperclip-runtime@0.2.63

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.50.0
- @fusion/dashboard@0.50.0
- @fusion/engine@0.50.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.50.0
- @fusion/pi-claude-cli@0.50.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.50.0

### @runfusion/fusion

#### Minor Changes

- 0ddfe9a: summary: Add confirmation prompts before Command Center concurrency sliders save live capacity changes.
  category: feature
  dev: Command Center global and project concurrency sliders now confirm changed settled values before persisting.
- 1a30ddd: summary: Agents now receive more tools, with dangerous actions governed by each agent's permission policy.
  category: feature
  dev: Heartbeat agent-work lane (packages/engine/src/agent-heartbeat.ts) assembles the broadened toolset; access remains gated by AgentPermissionPolicy via wrapToolsWithActionGate. Hermetic readonly lanes and automation allowedTools are unchanged.
- e1dba3f: summary: Reject malformed workflow graphs before they can be saved or launched.
  category: feature
  dev: Hardens the central parseWorkflowIr/validateV2 gate (duplicate-node-id and required top-level reachability rejection) and fail-closed re-validation at the WorkflowGraphTaskRunner run boundary before any side effects (FN-7113).
- c15d129: summary: Permanent/custom agents can use governed workflow and task-promotion tools.
  category: feature
  dev: Injects the FN-7111-classified mutating tools (fn_workflow_create/update/delete/settings/select, fn_task_promote) into the heartbeat agent-work lane (packages/engine/src/agent-heartbeat.ts), governed by AgentPermissionPolicy via wrapToolsWithActionGate. Executor-only tools requiring worktree/workspace context (fn_run_verification, fn_acquire_repo_worktree) remain intentionally excluded from the ambient lane. Hermetic readonly lanes and automation allowedTools are unchanged.
- 8f0f020: summary: Permanent and custom agents can list, show, and search tasks during heartbeat runs.
  category: feature
  dev: Adds shared read-only task tool factories (createTaskListTool/createTaskShowTool/createTaskSearchTool/createTaskReadTools), wires them into createSharedHeartbeatWorkTools, classifies fn_task_search and the legacy task-get alias read-only, and adds cross-surface drift tests.
- e89a58f: summary: Failed optional workflow steps now send tasks back for a bounded executor fix pass.
  category: feature
  dev: New `requestPreMergeOptionalStepFix` graph-executor seam wired to `sendTaskBackForFix`; bounded by `maxPostReviewFixes`/`postReviewFixCount`; falls through to prior advisory/gate behavior once the budget is exhausted. Pre-merge phase only; post-merge optional groups stay non-blocking.
- 2db8ead: summary: Footer concurrency panel shows running-agent counts and current-use markers on global and project sliders.
  category: feature
  dev: useGlobalConcurrency now exposes currentlyActive and projectsActive from /api/global-concurrency; EngineControlMenu renders count readouts and a clamped slider-track dot.
- 93b01c8: summary: Command Center Concurrency now shows running agents and current-use markers on global/project sliders.
  category: feature
  dev: CommandCenterControls reuses useGlobalConcurrency's currentlyActive/projectsActive (FN-7071) to render count readouts and clamped slider-track dots; no new backend routes.
- ad31490: summary: Configured MCP servers now reach every agent surface, including heartbeat runs.
  category: feature
  dev: Heartbeat and other un-wired session seams now resolve MCP via resolveMcpServersForStore; see FN-7077 audit.
- 4c48ccf: summary: Configured MCP servers now reach dashboard planning helpers like subtask breakdown, text refine, and insights.
  category: feature
  dev: Thread TaskStore/secrets into dashboard readonly createFnAgent helpers and forward resolveMcpServersForStore; see FN-7078.
- d9b17de: summary: New projects now default AI merge to sync a dirty checked-out integration branch.
  category: feature
  dev: Flips DEFAULT_PROJECT_SETTINGS merger.allowDirtyLocalCheckoutSync from false to true; explicit persisted values still win, with no existing-project migration.
- ae0679b: summary: Add an "Other" free-text answer to planning and mission interview questions.
  category: feature
  dev: single_select/multi_select questions now render a synthetic Other option backed by a reserved `_other` response key, threaded through formatResponseForAgent/history formatters in planning.ts, mission-interview.ts, and milestone-slice-interview.ts.
- 8b22dd2: summary: Imported GitHub issues are now linked as tracked tasks when GitHub tracking is on.
  category: feature
  dev: At import (CLI tools, `fn task import`, dashboard routes) the created task is set `githubTracking.enabled` when `resolveTaskGithubTracking` resolves enabled; the post-create hook adopts the source issue (source_issue_linked) so no duplicate tracking issue is opened.
- 28cdd1c: summary: Add a per-project plan-approval mode to auto-approve or require approval for all tasks.
  category: feature
  dev: New project setting `planApprovalMode` ("workflow" | "auto-approve-all" | "require-all"); overrides the per-workflow `requirePlanApproval` via `resolvePlanApprovalRequired` at the triage gating sites.
- c17d745: summary: Add external notifications for CLI agent tool-permission prompts.
  category: feature
  dev: Adds cli-agent-awaiting-input notification delivery from CLI waiting-on-input telemetry through ntfy/webhook providers.
- 92436d0: summary: Add a New Chat button to the mobile chat quick-switch dropdown.
  category: feature
  dev: New `chat-mobile-session-new` menuitem in ChatView's mobile session switcher reuses the existing setShowNewDialog/NewChatDialog path; Direct-scope only.
- c1613ad: summary: Configured MCP servers now connect to chat and agent sessions and expose their tools.
  category: feature
  dev: Adds the engine mcp-session-tools module and mcp**<server>**<tool> tool namespacing.
- 6828276: summary: Code Review and Browser Verification now cycle fixes until they pass, defaulting to up to 3 fix passes.
  category: feature
  dev: Raises the `maxPostReviewFixes` default from 1 to 3 — the budget governing the FN-7066 pre-merge optional-step fix loop and the self-healing in-review recovery loop. The optional step re-runs each pass and the task only proceeds once it passes (APPROVE/APPROVE_WITH_NOTES) or the budget is exhausted. Per-step configurable/unbounded budgets are tracked separately (FN-7129).
- 39d20be: summary: Workflow steps like Code Review and Browser Verification can set their own max fix revisions.
  category: feature
  dev: Adds optional `maxRevisions` (number | "unbounded") to optional-group workflow nodes, resolved by `resolveOptionalStepRevisionBudget` and threaded through `requestPreMergeOptionalStepFix` plus `recoverReviewTasksWithFailedPreMergeSteps`. Overrides global `maxPostReviewFixes`; absent preserves prior behavior. The Workflow Node Editor authors it with a number input and Unbounded toggle.
- a593cc7: summary: The Browser Verification workflow step now uses the agent-browser tool, checks availability, and logs its actions.
  category: feature
  dev: Adds a `requiresBrowser` flag to `WorkflowStep`, set on the built-in browser-verification inner node and threaded through `runGraphCustomNode` into `executeWorkflowStep`, which merges the `agent-browser-navigation` skill, runs a bounded non-fatal `agent-browser --version` availability preflight (async exec), and emits start/availability agent-log entries. Absent the flag, prompt-step execution is unchanged.
- a19df33: summary: Done tasks now open on a new Summary tab showing what changed and what the agents did.
  category: feature
  dev: Adds the "summary" TabId + TaskSummaryTab to TaskDetailModal; done tasks resolve the implicit Chat default to Summary while explicit tab entrypoints are honored.
- 5066f90: summary: Stack multiple queued chat messages above the composer and send them in order.
  category: feature
  dev: Direct and Quick Chat queued sends now persist as FIFO arrays with legacy single-string restore fallback.
- c468c16: summary: Show an estimated token count against the model's context window in the chat thread header.
  category: feature
  dev: Client-side estimate via app/utils/estimateChatTokens.ts; context window from ModelInfo.contextWindow. Desktop Direct-chat header only; hidden on mobile, in rooms, and when the model context window is unknown.
- 63d1079: summary: Done-task Summary tab now shows token usage by model with estimated cost per model and a task total.
  category: feature
  dev: TaskSummaryTab derives per-model USD cost client-side via costFor + global modelPricingOverrides from task.tokenUsage.perModel; unpriced models render "—" (never $0).
- d4137f1: summary: Add optional Compound Engineering document review to the built-in CE workflow.
  category: feature
  dev: Bundles ce-doc-review and documents autoMerge-off CE PR routing before Fusion's merge seam.
- e8163ab: summary: Add a per-workflow analytics tab to the Command Center dashboard.
  category: feature
  dev: New `aggregateWorkflowAnalytics` core aggregator + `/api/command-center/workflows` route + WorkflowArea tab; reads tasks ⨝ task_workflow_selection, no new schema.

#### Patch Changes

- 2b9e383: summary: Mutating agent tools now obey each agent's permission policy instead of always being allowed.
  category: security
  dev: Classifies fn*workflow*\*, fn_task_update/promote/refine, fn_run_verification, fn_acquire_repo_worktree, and fn_research_cancel in shared gating classifications so both the action gate and permanent-agent gating govern them; closes the unrecognized-tool exempt→allow fall-through. Parity tests lock the decisions.
- 3d26d4e: summary: The task detail tool is now named fn_task_show consistently across triage, planning, chat, and CLI surfaces.
  category: internal
  dev: Renames the legacy fn_task_get registration to canonical fn_task_show in createTriageTools (engine) and createPlanningBoardTools (dashboard), updates all prompt references and the FN-7118 cross-surface drift test, and retains fn_task_get in BOTH READONLY_FN_TOOLS and COORDINATION_EXEMPT_TOOLS as a deprecated recognition alias for backward-compatible action-gate classification and analytics.
- 63b44b8: summary: Fix PR-mode auto-merge failing with "error connecting to <branch>".
  category: fix
  dev: processPullRequestMergeTask now resolves owner/repo via getCurrentRepo(cwd) and passes (owner, repo, number) to getPrMergeStatus at all three call sites (shared-group, per-task, retry); the local GitHubOperations interface param names corrected from base/head to owner/repo. FN-7133.
- b1066c6: summary: Fix tasks getting stuck in review forever after a pre-merge code-review revision.
  category: fix
  dev: performWorkflowRerunBounce now bounces an `in-review` task back to in-progress like `in-progress`/`todo`, instead of throwing "cannot bounce to in-progress". A pre-merge optional-step REVISE reopens the last plan step and schedules the bounce, but a completion race could land the task in-review first, stranding it with a pending step that the merge gate blocks on while self-healing only re-ran the graph. Regression covered in executor-step-session.test.ts (FN-7122).
- 525953b: summary: Fix legacy databases missing newer task columns (e.g. checkout-lease, column dwell) after upgrade.
  category: fix
  dev: parseCreateTableSchemasFromSql now strips `--` comments before the non-greedy CREATE TABLE body regex, so a `);` inside a schema comment can no longer truncate a parsed table body and silently drop columns from ensureSchemaCompatibility()'s backfill set.
- 31d3f21: summary: Fusion co-author attribution now lands reliably on every commit it makes.
  category: fix
  dev: Inject the `Co-authored-by` trailer deterministically via the worktree commit-msg hook and the merger-ai `ensureCommitTaskMetadata` backfill (gated by `commitAuthorEnabled`), instead of relying on the agent appending it from the prompt.
- 74d3778: summary: Phantom duplicate tasks no longer break archive with an ENOENT error.
  category: fix
  dev: readTaskJson reports clean not-found when no DB row and no task.json exist; reconcilePhantomCommittedReservations prunes orphaned activityLog and agents/agentRuns for committed-reservation phantoms while preserving runAuditEvents and the committed reservation.
- 3c09008: summary: Make skill detail metadata render more compactly in the right Skills panel.
  category: fix
  dev: Scoped reduced font-size to `.skills-view-detail-markdown` / `.skills-view-detail-content` in SkillsView.css; shared `.mailbox-markdown` typography unchanged.
- 7137e36: summary: Fix Files viewer previews for images, video, audio, and PDFs.
  category: fix
  dev: Preview URLs request inline file responses with safe MIME, nosniff, and sandbox CSP headers while downloads remain attachments.
- 0440ae4: summary: Task creation no longer leaves orphaned reserved-ID records when a create fails partway.
  category: fix
  dev: createTaskWithDistributedReservation now commits the distributed_task_id_reservations row in the same SQLite transaction as the tasks-row insert, and a rollback guard reverts both the row and the reservation if post-insert task.json/PROMPT.md materialization or create validation fails, preventing committed-reservation-without-task phantoms. Adds transaction-participating allocator helpers for commit and failed-create rollback.
- 42d9c65: summary: Concurrency panels now show the real number of running agents instead of 0 when tasks are in progress.
  category: fix
  dev: global-concurrency running counts (currentlyActive/projectsActive) are now derived live from in-progress task columns, mirroring the /projects/:id/health computation, instead of slot/health bookkeeping that the default in-process runtime never updates.
- 8bcda73: summary: Concurrency panels now read running-agent counts from a single live source shared across the app.
  category: internal
  dev: Adds a side-effect-safe CentralCore.getLiveRunningAgentCounts() seam (DI source via setRunningAgentCountSource) that derives counts from in-progress task columns of already-open project stores without starting engines/watchers or mutating slot/health bookkeeping; GET /api/global-concurrency is rewired onto it, preserving globalMaxConcurrent/queuedCount and acquireGlobalSlot/releaseGlobalSlot semantics.
- 5608bf5: summary: fn project list/info now show live running-agent counts from in-progress tasks.
  category: fix
  dev: CLI In-Flight Agents derives from `column === "in-progress"` task counts, mirroring FN-7080's dashboard route; persisted `projectHealth.inFlightAgentCount` and slot semantics are unchanged.
- c2f8026: summary: Recover corrupt messaging indexes during send or report the exact repair command.
  category: fix
  dev: MessageStore now runs a scoped REINDEX messages retry on SQLite corruption during send.
- ee3a06e: summary: Database backup automation failures now report which database and the underlying cause.
  category: fix
  dev: Hardens runBackupCommand + routine/cron in-process backup branches so AutomationRunResult.error is always actionable.
- f4b25dd: summary: Stop plan-approval tasks from showing an empty-mailbox approval banner.
  category: fix
  dev: Fixes useApprovalBanner so the Open Mailbox banner only follows real ApprovalRequest events.
- f34b62c: summary: The running-agents count now includes agents actively triaging tasks, not just executors.
  category: fix
  dev: countRunningAgentsInStore now adds triage-column tasks with status "planning" (not paused) to the live running-agent count alongside in-progress tasks, matching the maxTriageConcurrent liveness predicate; feeds getLiveRunningAgentCounts and the global-concurrency readouts.
- a8f51e9: summary: Settings → Prompts now links to Workflow Editor prompts and clarifies prompt ownership.
  category: feature
  dev: PromptsSection threads onOpenWorkflowSettings and reuses MovedSettingsStub; AgentPromptsManager tabs stay in Settings.
- 9e2fb5d: summary: Project health In-Flight Agents now counts agents actively triaging tasks.
  category: fix
  dev: The dashboard /projects/:id/health route and the CLI fn project list/info in-flight count now add triage-column tasks with status "planning" (not paused) to the live in-progress count, matching FN-7097's countRunningAgentsInStore predicate; persisted projectHealth.inFlightAgentCount and slot semantics are unchanged.
- b69dd8e: summary: Align Compound Engineering brainstorm artifacts with unified plan discovery.
  category: internal
  dev: Private Compound Engineering plugin keeps separate brainstorm/plan stages while sharing docs/plans artifacts and legacy discovery.
- e909d41: summary: Suppress brief footer Connecting flashes after one transient executor stats poll failure.
  category: fix
  dev: Debounces post-success suspension-like /api/executor/stats failures in useExecutorStats.
- 368f1e0: summary: Show every used model in Command Center token-by-model detail charts.
  category: fix
  dev: Removes the Tokens detail chart cap while keeping Overview explicitly top-N.
- 5ab4a59: summary: Preserve override column-agent models during task execution.
  category: fix
  dev: Engine override column-agent sessions now ignore task-level model fields during initial session creation and mid-flight re-resolution when the column agent governs.
- c61217e: summary: Show queued Chat messages above the input box with a divider.
  category: fix
  dev: Moves the existing single pending-message indicator out of the textarea wrapper and covers placement with ChatView tests.
- 59803c2: summary: The task Workflow tab now shows the configured project Executor/Reviewer/Planning model instead of "Default".
  category: fix
  dev: Task-detail model display now overlays the task's effective workflow setting values (where the moved per-phase model lanes live) onto getSettingsFast() via a shared core applyWorkflowSettingsOverlay helper and a new GET /api/tasks/:id/effective-settings endpoint. Engine mergeEffectiveSettings reuses the same helper unchanged. FN-7123.
- b5378d2: summary: Add a visible close button to the footer engine-controls popover.
  category: fix
- 45e27f8: summary: Govern task creation and delegation with the task_agent_mutation permission policy.
  category: fix
  dev: fn_task_create and fn_delegate_task were action-gate exempt despite being task-board mutations; now classified task_agent_mutation in the action gate (permanent-agent gate none classification preserved).
- c3c4216: summary: Permanent agents now obey approval/block policy when creating tasks.
  category: fix
  dev: Removed fn_task_create from READONLY_FN_TOOLS and classified it as task_agent_mutation in the permanent-agent gate (packages/engine/src/gating-classifications.ts); action-gate classification unchanged. fn_delegate_task and GitHub import tools intentionally left permanent-readonly.
- 6713c99: summary: Include triage/planning model usage in Command Center Tokens by model.
  category: fix
  dev: Records token usage for triage primary, fallback, and spec-review subagent sessions.
- ba599a4: summary: Fix workflow view so the Code Review and Browser Verification blocks show connected edges.
  category: fix
  dev: Auto-layout/fallback spacing now advances by every consecutive container node's rendered width so back-to-back optional-group/foreach/loop nodes no longer overlap adjacent handles; covered by a consecutive-container connectivity regression test.
- 6f46fa1: summary: Show linked task columns in agent Current Task output.
  category: fix
  dev: Adds shared Current Task formatting for agent list/show tools across engine and CLI surfaces.
- 9e7c57d: summary: Show linked task columns on dashboard agent task badges.
  category: fix
  dev: Adds transient agent taskColumn enrichment for dashboard agent list, detail, and live-agent surfaces.
- 4f01c4d: summary: Show every token-consuming model in Command Center token breakdowns.
  category: fix
  dev: Backfills resolved pi session models so per-model token buckets do not fall back to unknown.
- 661b6b8: summary: Pressing q (or Ctrl+C) in the TUI now always quits, even if a teardown step stalls.
  category: fix
  dev: dashboard.ts shutdown/devShutdown arm an unref'd 3s hard-exit watchdog on the first signal and force an immediate process.exit(0) on a second signal, so a hung stopAllDevServers/engine/central-core teardown can no longer leave the process alive repainting the restored shell. Each teardown step now runs through timeShutdownStep, which tracks the in-flight step so the watchdog names the exact stalling step on stderr; set FUSION_DEBUG_SHUTDOWN=1 for per-step timings (slow steps >1s are always surfaced).

### runfusion.ai

#### Patch Changes

- Updated dependencies [0ddfe9a]
- Updated dependencies [1a30ddd]
- Updated dependencies [2b9e383]
- Updated dependencies [e1dba3f]
- Updated dependencies [c15d129]
- Updated dependencies [8f0f020]
- Updated dependencies [3d26d4e]
- Updated dependencies [63b44b8]
- Updated dependencies [b1066c6]
- Updated dependencies [525953b]
- Updated dependencies [31d3f21]
- Updated dependencies [e89a58f]
- Updated dependencies [74d3778]
- Updated dependencies [2db8ead]
- Updated dependencies [3c09008]
- Updated dependencies [7137e36]
- Updated dependencies [0440ae4]
- Updated dependencies [93b01c8]
- Updated dependencies [ad31490]
- Updated dependencies [4c48ccf]
- Updated dependencies [42d9c65]
- Updated dependencies [8bcda73]
- Updated dependencies [5608bf5]
- Updated dependencies [d9b17de]
- Updated dependencies [ae0679b]
- Updated dependencies [8b22dd2]
- Updated dependencies [c2f8026]
- Updated dependencies [ee3a06e]
- Updated dependencies [f4b25dd]
- Updated dependencies [f34b62c]
- Updated dependencies [a8f51e9]
- Updated dependencies [28cdd1c]
- Updated dependencies [9e2fb5d]
- Updated dependencies [b69dd8e]
- Updated dependencies [c17d745]
- Updated dependencies [e909d41]
- Updated dependencies [368f1e0]
- Updated dependencies [5ab4a59]
- Updated dependencies [92436d0]
- Updated dependencies [c61217e]
- Updated dependencies [c1613ad]
- Updated dependencies [59803c2]
- Updated dependencies [b5378d2]
- Updated dependencies [45e27f8]
- Updated dependencies [6828276]
- Updated dependencies [39d20be]
- Updated dependencies [a593cc7]
- Updated dependencies [a19df33]
- Updated dependencies [c3c4216]
- Updated dependencies [6713c99]
- Updated dependencies [ba599a4]
- Updated dependencies [5066f90]
- Updated dependencies [6f46fa1]
- Updated dependencies [9e7c57d]
- Updated dependencies [c468c16]
- Updated dependencies [63d1079]
- Updated dependencies [d4137f1]
- Updated dependencies [e8163ab]
- Updated dependencies [4f01c4d]
- Updated dependencies [661b6b8]
  - @runfusion/fusion@0.50.0

> Older releases (before 0.50.0) are archived in [`CHANGELOG-archive.md`](./CHANGELOG-archive.md).
