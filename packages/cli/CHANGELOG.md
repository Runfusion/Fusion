# @runfusion/fusion

## 0.25.0

### Minor Changes

- 15e4336: Add scheduled memory backup feature: project memory (.fusion/memory) and per-agent memory (.fusion/agent-memory) are now snapshotted on a configurable cron schedule with retention pruning. New `fn memory-backup` CLI command and Settings → Backups UI controls.

### Patch Changes

- 3e64668: Auto-recover stuck merge deadlocks where task content is already on main.
- 76e6eed: Stop overwriting canonical merge commit SHAs on already-done tasks during self-healing reconciliation. Confirmed `mergeDetails.commitSha` is now preserved as authoritative; rediscovery for unconfirmed done tasks prefers the earliest owned commit so the original merge commit wins over later follow-up commits sharing the same `Fusion-Task-Id` trailer.
- 76e6eed: Add global and project settings for GitHub issue tracking: global default tracking repo, project-level default tracking repo, per-project tracking toggle for new tasks, GitHub auth mode (`gh-cli` | `token`), and optional stored personal access token. This is foundational settings work for FN-3868 → FN-3876; behavior wiring ships in downstream subtasks.
- 76e6eed: Triage: progressively compact large optional sections (subtask guidance, attachments, existing spec, user comments) of the spec prompt when the model's context window overflows, in addition to the existing project-memory compaction. Fixes failures on small-context models such as local vLLM Qwen3-30B (issue Runfusion/Fusion#62, FN-3877).
- 76e6eed: Add a compatibility self-heal for legacy task databases that report `schemaVersion >= 20` but are missing checkout lease columns (`checkedOutBy`, `checkedOutAt`, `checkoutNodeId`, `checkoutRunId`, `checkoutLeaseRenewedAt`, `checkoutLeaseEpoch`).

  On initialization, missing lease columns are now added idempotently before version-guarded migrations, matching the earlier `nodeId` mitigation pattern and preventing `no such column: checkoutNodeId` crashes in task listing paths.

- 0b69b99: Fix Dependency Graph plugin failing to enable from Settings by correcting package exports/build output and ensuring bundled CLI staging includes compiled plugin dist assets. Also surface the loader's actual enable error in Plugin Manager toast messaging when enable returns `state: "error"`.
- f9cba25: Use agent names (with ID fallback) in agent message notifications and mailbox labels across ntfy/webhook outputs and dashboard mailbox views.
- 47504ea: Fix dependency-graph plugin failing to load under real Node ESM resolution by switching to Node16 module resolution semantics and ensuring emitted relative imports include `.js` extensions. Aliased `@fusion-plugin-examples/dependency-graph` (and its `/dashboard-view` subpath) in the dashboard's vite and vitest configs so the dashboard resolves the plugin from `src/` instead of a potentially stale `dist/`, preventing "Bundled plugin view unavailable" regressions when plugin source changes without a rebuild. Added regression tests for built-entrypoint Node-ESM safety and dashboard alias wiring.
- 89acfd0: Fix agent-company imports from companies.sh monorepos by honoring the catalog subdirectory path (for example `paperclipai/companies/gstack`) instead of parsing the alphabetically first sibling package.
- 71bf70f: Wire the checkout-lease column self-heal as an unconditional startup compatibility backfill (`ensureTasksSchemaCompatibility`) so legacy or mesh-synced task databases no longer fail with `no such column: checkoutNodeId` when schemaVersion is already past migration 20.
- d942c0c: Fix in-review tasks getting stranded after pre-merge workflow completes. Two regressions piled up:

  1. The `task:moved → in-review` immediate-handoff path silently no-op'd whenever `internalEnqueueMerge` short-circuited on a leaked `mergeActive` entry — and every skip reason ("paused", "blocker", "autoMerge off", "engine paused") returned without logging, so the silence was opaque. Each branch now logs at info or warn level, the handler clears its own stale `mergeActive` entry before enqueueing, and the catch block's message identifies the task instead of pretending the failure was always a settings read.
  2. The 15s `scheduleMergeRetry` sweep ran `enqueueEligibleInReviewTasks` → `internalEnqueueMerge` blindly, so a leaked `mergeActive` entry from a wedged prior attempt would skip the same task on every poll forever. Tasks were only rescued by the 15-min maintenance recovery loop ("Auto-recovered: eligible in-review task re-enqueued for merge"). Added `reconcileStaleMergeActive()` which drops `mergeActive` entries that aren't queued and aren't the active merge target, and call it before each 15s sweep. `internalEnqueueMerge` also now warns when a leaked entry causes a skip, so the next regression is visible.

- 271166a: Change the default `verificationFixRetries` setting from 3 to 2 for new projects and fallback behavior when unset.
- 76e6eed: Add a multi-agent report review panel flow to the bundled reports plugin, including parallel reviewer orchestration, structured feedback parsing with retry, deterministic aggregation, and documented timeout/failure semantics.
- 235ba11: Add a SQLite-backed reports archive store for the bundled reports plugin, including schema initialization, status lifecycle transitions, review attachment persistence, and typed list/filter APIs with events.
- 76e6eed: Scheduler: exclude paused in-review tasks from `activeScopes`. Paused failed-merge tasks no longer block dispatch of overlapping todo tasks via `blockedBy` re-stamping. (FN-3867)
- 76e6eed: Add `recoverAlreadyMergedReviewTasks()` self-healing sweep to recover phantom-merge-guard false positives. Detects tasks whose content already landed on the integration branch (via Fusion-Task-Id trailer, branch ancestry, or git patch-id walk) and reconciles them to `done` with proper merge metadata.
- 76e6eed: Restore canonical mergeDetails.commitSha for tasks FN-3794, FN-3814, FN-3829 whose attribution had been overwritten by self-healing reconciliation prior to the FN-3862 fix. Adds an idempotent restoration script (`scripts/restore-merge-sha-fn-3878.mjs`) for operators to re-verify or repair similar drift.
- 76e6eed: Wire chat rooms UI to backend. Creating a room now persists via /api/chat/rooms, the sidebar lists real rooms, room threads load history and stream new messages over chat:room:\* SSE events, and the FN-3807 "Coming soon" placeholder is gone.
- f182aa3: Mailbox view now has a draggable resize handle between the list and detail panes (desktop only), with keyboard support and per-project persisted width.
- 2864f70: Backfill global ntfy default events to include `message:agent-to-user` and `message:agent-to-agent` so mailbox notifications are enabled by default for new settings files.
- e0d9671: Move agent Run Now control into the agent detail header next to lifecycle buttons.
- 271166a: Fix chat rooms: pressing Enter in a room now posts to the room (previously routed to a 1-on-1 session), and rooms can now be deleted from the rooms sidebar with confirmation.
- 985d51c: Tighten merger scope-warning diff base for legacy/imported tasks lacking `baseBranch`. `resolveTaskDiffBaseRef` now mirrors the dashboard's display-recovery path: when `baseBranch` is missing, it computes `merge-base(HEAD, main)` and prefers it over a stale `baseCommitSha` only when the merge-base strictly descends the recorded SHA. Previously these tasks compared against the original fork point, so a pre-merge rebase pulled every unrelated commit landed on main into the diff and produced bogus "N files changed outside declared File Scope" warnings (e.g., FN-3898 saw 17 ghost files for a 3-file change). The FN-2855 deleted-feature-branch path is preserved.
- 00c580d: Disable Corepack's interactive download prompt when spawning verification commands so non-TTY children no longer hang until the hard timeout when a repo pins `packageManager` to a version Corepack hasn't cached yet.

## 0.24.0

### Minor Changes

- 0da7aa8: Newly created non-ephemeral agents now start in `state: "active"` so they immediately participate in heartbeat scheduling without requiring a manual Start action. Ephemeral/task-worker agents still start in `state: "idle"` and are activated by the engine when work is assigned. Existing agents are unaffected; operators who want a paused-from-birth durable agent can call `fn_agent_stop` (or click Stop in the dashboard) right after creation.

  Audit note: heartbeat scheduler state handling and dashboard create-response consumption were reviewed and required no downstream code changes.

- a76f06b: Fusion now includes a plugin-first Dependency Graph top-level dashboard view that lets teams explore active task relationships visually, with host support for plugin-registered dashboard destinations and bundled graph rendering for dependency-aware planning.

  - Adds a new Graph destination in dashboard navigation (including desktop overflow/mobile surfaces) via plugin dashboard view registration.
  - Visualizes task dependencies as connected task cards with directed edges, including in-progress and in-review work while excluding done/archived tasks.
  - Adds interactive graph controls including pan, zoom, fit-to-screen, and manual node dragging for layout refinement.
  - Highlights upstream/downstream dependency chains on hover/selection and opens task details from graph cards for quick drill-in.
  - Persists per-project custom node positions using plugin-managed project-scoped storage.
  - Introduces and documents the host contract for plugin-provided top-level `dashboardViews` (`PluginDashboardViewDefinition` + loader aggregation + registry-host rendering).

- 9e6574c: Add a dedicated Task Review tab that surfaces pull-request and direct reviewer feedback with selectable items, manual refresh, and same-task AI revision flow so teams can address review comments without creating a separate refinement task.
- dca0789: Add Cursor CLI runtime plugin as a bundled installable provider, including staged plugin artifacts in the published CLI bundle and install-path resolution support.
- dcea611: WhatsApp Chat plugin now connects via the WhatsApp Web multi-device protocol (Baileys) with QR / pairing-code setup instead of Meta Cloud API webhooks. Removes the verifyToken / appSecret / accessToken / phoneNumberId / graphApiVersion settings and webhook routes; adds /status, /qr, /pair-code, and /logout plugin routes. Existing installs must re-pair after upgrade.
- 4c204c9: Enable Fusion tool-control support for the OpenClaw runtime plugin. OpenClaw sessions now derive custom tools from runtime session options, filter out built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`), configure an MCP server via supported `openclaw mcp set` profile-based CLI flow, and pass that profile into `openclaw agent` calls while preserving default embedded `--local` behavior.
- a6ec5b9: Add a new global experimental feature flag, `experimentalFeatures.evalsView`, and default it to off for Evals surfaces. When disabled, the dashboard Evals view, Settings → Scheduled Evals section, header/mobile Evals navigation entries, and in-process scheduled-eval cron execution are hidden or short-circuited. Projects already using `evalSettings.enabled` must also enable `evalsView` to expose and run scheduled eval workflows.
- 1546eaf: Add support for the standalone Even Realities glasses plugin, including on-device task cards, quick capture, polling notifications, and agent actions for local/self-hosted Fusion deployments. This expands user-facing plugin capabilities in the published CLI/runtime stack.
- e04af96: Add native `fn_web_fetch` tool for lightweight URL fetching from agent/chat sessions, with SSRF guard, timeout, and size caps. Use the `agent-browser` skill for JS-rendered pages.
- 8051bea: Add chat room storage: ChatRoom, ChatRoomMember, ChatRoomMessage entities, migration 70, and ChatStore room CRUD APIs.
- 8051bea: Add room-aware chat HTTP API and SSE events: /api/chat/rooms CRUD, member management, persist-only POST /chat/rooms/:id/messages, and chat:room:\* event fan-out on the dashboard SSE stream. AI responder selection, mention routing, and UI land in subsequent tasks.
- 3a91534: Add `fn_agent_create` and `fn_agent_delete` tools for provisioning and decommissioning non-ephemeral agents, including direct-report authorization checks and task-checkout safety handling on delete.
- 6c77915: Render mailbox message bodies as GitHub-flavored markdown. Headings, lists, bold/italic, links, inline code, fenced code blocks, and tables now display formatted in both the Mailbox view and Mailbox modal. Plain-text messages render unchanged. Raw HTML is not executed.
- 5299745: Add optional plugin AI security scan controls across install/rescan workflows.

  - `fn plugin install <path-or-package> --ai-scan` to opt into scan-on-load
  - `fn plugin rescan <id>` to run a fresh scan/reload and surface verdict details
  - Dashboard/API plugin management now supports toggling `aiScanOnLoad` and explicit rescans with persisted scan results

### Patch Changes

- b41cb84: Remove roadmap ownership from `@fusion/core` by deleting remaining roadmap type exports and keeping roadmap contracts in the roadmap plugin package (`@fusion-plugin-examples/roadmap`).
- f8a0903: Enforce executor-role assignment policy for implementation task delegation paths in the CLI and add an `override` escape hatch for intentional non-executor delegation.
- a732ebb: Stabilize CLI bundle-output test for the fusion-plugin-openclaw-runtime
  `mcp-schema-server.cjs` bridge asset on clean checkouts and fail loudly
  in tsup if the source asset is missing.
- c1ba48f: Fix agent memory lookup: the system prompt's "## Agent Memory" section and the
  heartbeat Identity Snapshot now read from the on-disk agent-memory workspace
  (`.fusion/agent-memory/{agentId}/MEMORY.md`) when the inline `agent.memory`
  field is empty, matching the documented contract.
- 9743dab: Stage `fusion-plugin-droid-runtime` (including its `mcp-schema-server.cjs`
  bridge asset) into the published CLI tarball, mirroring the
  `fusion-plugin-openclaw-runtime` build pipeline. The droid runtime plugin
  is now bundled and asserted by the bundle-output test suite.
- c93f61b: Expand mailbox reply-context rows so users can inline-expand and traverse prior replied-to messages.
- 83be577: Add a split Pull action in the Git Manager Remotes panel with a dropdown option to run `Pull --rebase`.
- d90d665: Fix: dependency graph plugin failed to load because its plugin entry imported React/dashboard modules. Split the plugin into a server-pure metadata entry and a separate `./dashboard-view` subpath so the bundled-install loader can register it without crashing.
- 955902d: Fix mobile mailbox reply: anchor MailboxView/MailboxModal to the visual viewport so the message composer stays visible when the on-screen keyboard appears.
- ceb113c: Fix mailbox composer Send button hanging when "Wake agent immediately" is checked. The /api/messages route now dispatches the wake heartbeat asynchronously so the UI returns immediately after the message is stored.
- fc34a84: Unify engine gating exemption lists into a shared source of truth.
- d633981: Fix merger autostash orphan cleanup to automatically drop closed-task stashes whose content is already fully subsumed by HEAD.
- d487eea: Fix executor step-index reconciliation so `fn_task_update` and `fn_review_step` share 0-indexed in-memory verdict/checkpoint keys. This restores correct REVISE blocking for `status="done"` and allows RETHINK rewinds to find the matching step checkpoint.
- 9c86771: Fix first chat message send hanging on "Connecting…" — the initial SSE stream now completes reliably on cold-start.
- 111ad7a: Tasks no longer strand in In Review when an in-merge verification fix only rebuilds gitignored artifacts. The merger now restores squash state and commits the original branch content when no commit exists yet, while still refusing real phantom merges with no task content.
- 18413a1: Fix /tasks/:id deep links: theme stylesheet now resolves root-absolute on sub-paths and /tasks/:id redirects/rewrites to the canonical ?task= form so the task modal opens.
- 12bad74: Add ntfy and webhook notifications for mailbox messages (agent→user and agent→agent), with deep links into the matching task or mailbox message.
- de17449: Add `TaskStore.listTasksModifiedSince` and wire `createPluginRouter` into the dashboard API so plugin-defined routes mount under `/api/plugins/{id}/...`.
- 1abbb10: Fix merge-queue auto-recovery loops caused by stale `status: "merging"` / `"merging-pr"` task states. Self-healing now clears stale transient merge statuses only when no active merger owns the task and the state is older than a safety threshold, and mergeable-review recovery now skips transient merge statuses to avoid noisy re-enqueue spam while the cross-process active-merge guard is blocked.
- 36b21af: Fix auto-merge failing when task content is already on `main` under a different commit SHA. The phantom-merge guard in `commitOrAmendMergeWithFixes` previously failed any merge where `git merge --squash` produced no diff, even when the work had legitimately landed on `main` (e.g., after an in-merge fix or rebased branch). The finalize logic now treats already-merged branches as success via a defense-in-depth chain: trailer-on-HEAD short-circuit, then merge-base ancestor short-circuit, then a hardened squash-restore fallback that detects `already up to date` reports. High-resolution diagnostics are emitted on the phantom-guard branch for any future regressions.
- ac0606d: Stop overwriting canonical merge commit SHAs on already-done tasks during self-healing reconciliation. Confirmed `mergeDetails.commitSha` is now preserved as authoritative; rediscovery for unconfirmed done tasks prefers the earliest owned commit so the original merge commit wins over later follow-up commits sharing the same `Fusion-Task-Id` trailer.
- 4b6a149: Add global and project settings for GitHub issue tracking: global default tracking repo, project-level default tracking repo, per-project tracking toggle for new tasks, GitHub auth mode (`gh-cli` | `token`), and optional stored personal access token. This is foundational settings work for FN-3868 → FN-3876; behavior wiring ships in downstream subtasks.
- 37913bc: Triage: progressively compact large optional sections (subtask guidance, attachments, existing spec, user comments) of the spec prompt when the model's context window overflows, in addition to the existing project-memory compaction. Fixes failures on small-context models such as local vLLM Qwen3-30B (issue Runfusion/Fusion#62, FN-3877).
- e7acd27: Add a compatibility self-heal for legacy task databases that report `schemaVersion >= 20` but are missing checkout lease columns (`checkedOutBy`, `checkedOutAt`, `checkoutNodeId`, `checkoutRunId`, `checkoutLeaseRenewedAt`, `checkoutLeaseEpoch`).

  On initialization, missing lease columns are now added idempotently before version-guarded migrations, matching the earlier `nodeId` mitigation pattern and preventing `no such column: checkoutNodeId` crashes in task listing paths.

- 9cc98fd: Fix task ID counter resetting to `001` on first mesh-routed task creation.

  When the dashboard's task-create route was migrated to the distributed task ID allocator, projects whose tasks had been allocated through the legacy counter (e.g. `FN-3700`) saw new tasks restart at `FN-001`, colliding with historical IDs. The allocator now seeds its sequence past any existing task for the prefix (live or archived) and past the legacy counter, so new task IDs always continue forward.

  Internal: extracted a slim type-only module for plugin dashboard view contracts so external plugin builds no longer pull in dashboard runtime sources, and dropped unused scaffolding tables (added by a previous schema migration) via an idempotent migration.

- 82fe24e: Bootstrap `@fusion/dashboard` dist before running tests so `@fusion/desktop` (which dynamically imports `@fusion/dashboard`) does not fail with "Failed to resolve entry for package @fusion/dashboard" in clean checkouts and merger verification environments.
- d90d665: Fix: dashboard board silently dropped tasks when an SSE `task:created` event was missed (e.g., during reconnect or sleep/wake). The `task:moved`, `task:updated`, and `task:merged` handlers in `useTasks` used `prev.map(...)` and skipped tasks not already in local state, so subsequent updates were no-ops. Handlers now upsert, matching `task:created`, so out-of-order or post-reconnect events make the task visible instead of dropping it.
- 97e039b: Fix tasks getting stuck in In Review with "verification fix succeeded but no merge commit could be created" even when the merge commit had already landed on main.

  Root cause: when attempt 1 of the merge hit a verification failure (test command failed) under default smart conflict resolution, the catch in `executeMergeAttempt` swallowed the error and returned `false`, triggering a redundant attempt 2. Attempt 2 captured a stale `preAttemptHeadSha` (the AI commit from attempt 1), found the branch already merged, ran the in-merge fix, and the finalizer's phantom-merge guard then saw `!hasStaged && !headMoved` against the wrong baseline — even though the task's content was already on HEAD.

  - `executeMergeAttempt` now propagates `VerificationError` directly so the in-merge fix runs once on attempt 1 with the correct baseline. Auto-conflict-resolution can't fix a verification failure, so retrying with attempt 2 was always wrong for this error.
  - `commitOrAmendMergeWithFixes` adds a defense-in-depth check: if HEAD already carries the task's `Fusion-Task-Id` trailer, treat the no-progress finalize as success rather than tripping the phantom-merge guard. The trailer match is anchored to line boundaries so unrelated task IDs in the body can't false-positive.

- d0b7506: Guard PR creation retries against missing task branches and park no-delta branches with an actionable task error.
- 68eff44: Stop the dashboard's SPA catch-all from serving `index.html` for missing asset URLs. Stale `/assets/*.js` requests after a rebuild now get a real 404, so the browser surfaces a chunk-load error (which versionCheck recovers from) instead of poisoning the page with a `text/html` module script and reloading into a blank shell.
- a9edca6: Fix dashboard step progress not advancing during task execution. Two bugs: (1) `fn_task_update` regressed in commit 491097cd6 (FN-3026) to a 1-indexed `step - 1` even though its parameter description and `fn_review_step` both use 0-indexed step numbers, so updates landed on the wrong step and `codeReviewVerdicts`/`stepCheckpoints` keys mismatched between the two tools. (2) Some agent runtimes (notably permanent-agent CEO sessions on the openai-codex transport) skip the bookkeeping `fn_task_update` call entirely, leaving the board stuck at `currentStep: 0`. `fn_review_step` now flips the step to `in-progress` on entry and to `done` on code-review `APPROVE`, so progress reflects real work without depending on the agent's follow-up call.
- 7a11a32: Fix dashboard rendering blank on first load by skipping the service worker `controllerchange` reload on initial install — the page only reloads now when an existing controller is genuinely being replaced.
- 1a0124c: Normalize dependency graph dashboard navigation so Graph resolves through a canonical `graph` task view destination and appears only in secondary navigation surfaces (desktop Header overflow and mobile More sheet). Also add TaskCard embedding support via `disableDrag` for plugin-hosted graph nodes.
- a466416: Implement dependency graph rendering with layered auto-layout, directed SVG edges, task filtering, and pan/zoom + fit-to-screen controls in the bundled dependency graph plugin.
- 21b7d41: Wire the bundled dependency graph dashboard view to host context so graph cards open the native task detail modal, and document the plugin dashboard view context contract/entrypoint alignment.
- 514e5f3: Fix dependency-graph task card activation so primary non-drag clicks open task details exactly once through the dashboard host callback, while preserving drag suppression and graph highlighting behavior.
- d20d45e: Remove the dashboard-owned `RoadmapsView`, `useRoadmaps` hook, and related CSS/tests from `@fusion/dashboard`. Roadmap planning now routes exclusively through the bundled `roadmap-planner` plugin dashboard view (`plugin:roadmap-planner:roadmaps`).
- 9d1c05a: Remove dashboard-owned roadmap backend routing and legacy `/api/roadmaps` integration so roadmap APIs are plugin-owned under `/api/plugins/roadmap-planner/...`.
- b7f68d7: Plugin management now separates global installation from project activation: installs/uninstalls are global, while enable/disable and runtime state remain project-scoped. Updated dashboard plugin lifecycle SSE payloads and Plugin Manager/CLI copy to make global vs project scope explicit.
- 12d3f0d: Treat task working branch (`branch`) and merge-target base branch (`baseBranch`) as distinct user-controlled fields across task create/edit flows, board display and filtering (including no-branch filters), and merge behavior that defaults the target branch to `main` when `baseBranch` is unset.
- ea34afa: Resolve project runtime working directories from per-node project path mappings for the routed/current node instead of falling back to `RegisteredProject.path`, and fail with clear errors when the exact mapping is missing.
- 92ca3a2: Pause permanent-agent execution when approval is required, add approve/deny API endpoints, and resume task/agent state correctly after decisions with deduped approval request handling.
- 66c66ec: Improve agent messaging responsiveness by ensuring heartbeat mailbox context is consistently processed and adding a one-off `wakeImmediately` send option in dashboard messaging. This also clarifies agent `messageResponseMode` behavior in settings and docs.
- f894bdc: Fix dashboard agent chat sessions so plugin runtimes (including Hermes) receive Fusion mailbox tools when a message store is available, enabling real `fn_send_message`/`fn_read_messages` usage with correct agent-to-dashboard recipient routing semantics.
- 66fa56b: Gate `fn_research_*` tool availability behind `experimentalFeatures.researchView` so CLI and agent sessions consistently return feature-disabled responses when Research is not experimentally enabled.
- c38b7cd: Gate research tool exposure in planning and execution sessions behind `experimentalFeatures.researchView`, including conditional prompt guidance so agents only see `fn_research_*` references when those tools are actually registered.
- a087aa4: Sync mesh auth credentials using explicit checksummed auth snapshots across node sync and mesh shared-state channels, including secure apply/export handling for API-key and OAuth provider credentials.
- bbfa5f7: Fix narrow main-screen TUI mouse behavior so selecting **Logs** enables wheel scrolling and selecting **System** switches back to native text selection mode.
- 9b19199: Align dependency-graph position persistence with the shared dashboard project storage helper and canonical key (`fusion-plugin-dependency-graph:positions`), and remove the plugin-local duplicated scoped storage helper.
- 81da75f: Enable planning-mode and research synthesis agent sessions to opt into runtime builtin `WebSearch` and `WebFetch` tools when supported, while keeping readonly defaults unchanged for other sessions.
- 8bbb734: Add a first-party WhatsApp chat plugin that can be installed from built-in plugin surfaces and staged in CLI bundles.
- 5514d3e: Agent Detail Mail tab: clicking a message now loads its full content and marks unread inbox messages as read.
- 2b8cbd1: Fix `fn plugin install` / `fn plugin add` path registration so local directory installs persist an absolute JavaScript entry file path instead of the source directory. This resolves plugin load failures on restart when loaders require a concrete JS module file.
- 45fe41c: Fix plugin installation persistence so user-installed plugins are always recorded in the shared central `plugin_installs` registry (with per-project state in `project_plugin_states`) instead of project-local legacy plugin rows. This ensures installs are visible across projects and processes as intended.
- 966368c: Fix plugin list enable/disable toggle rendering so the native checkbox is visually hidden and the custom slider reflects checked and focus-visible states.
- 9f57207: Exempt internal Fusion coordination tools (heartbeat-done, task/document/memory writes used for coordination, delegation, identity, reflection) from the permanent-agent action gate so heartbeats cannot deadlock under restrictive permission policies. Mirrors the existing action-gate exemption set onto the sibling permanent-agent gating path.
- ae7a607: Exempt internal Fusion runtime coordination tools from permanent-agent action-gate policy enforcement so heartbeat completion and engine coordination calls cannot deadlock behind approval/block rules.
- 5e94151: Define `--accent-text` across dashboard themes so content rendered on `--accent` has readable contrast. This fixes low-contrast user chat message bubbles and send-button icon color in ChatView, especially on the default and one-dark themes.
- f3164b7: Add a runtime action-gate exempt-tools reload API so operators can refresh exemptions without restarting the engine process.
- ad34cb6: Fix permanent-agent tool gating so `fn_heartbeat_done`, `fn_send_message`, and `fn_read_messages` are treated as readonly/exempt and no longer require approval under permission-policy gating.
- 6f0e167: Fix dashboard chat surfaces so ChatView and Quick Chat snap to the latest message when opened or when switching sessions, while preserving scroll-up reading state during streaming/history loads.
- 1148d29: Add scaffold for new bundled Reports plugin (manifest + settings schema, no runtime behavior yet).
- 003e51a: Add a multi-agent report review panel flow to the bundled reports plugin, including parallel reviewer orchestration, structured feedback parsing with retry, deterministic aggregation, and documented timeout/failure semantics.
- 7d20a34: Fix a multi-project collision in the bundled WhatsApp plugin by keying connections with `getRootDir() + "::" + pluginId`, so concurrent projects no longer share a single connection state.

  Update the plugin SDK hook type so `onUnload` now receives `PluginContext` (matching `onLoad`). This is backward-compatible at runtime, but plugin authors may need to update TypeScript signatures.

- de070db: Add a `dedupeRetentionDays` setting to the WhatsApp chat plugin (default 7 days) and prune old `whatsapp_chat_dedupe` rows on each inbound message to prevent unbounded dedupe-table growth.
- 12bad74: Add a mobile-first chat session switcher in the ChatView thread header so users can open the title menu and switch conversations (or start a new chat) without returning to the sidebar.
- 5bfe126: Make `fn_web_fetch` universally available to all agent roles (reviewer, merger, triage now included).
- b326385: Fix missing ntfy notifications for new mailbox messages and add a "Test message notification" button in Settings → Notifications that exercises the full dispatch pipeline.
- 94a6fe4: Document the Chat view session switcher and the `/tasks/<id>` deep-link in the dashboard guide.
- a2258b8: Main chat no longer surfaces a confusing "Load failed" error banner when the
  browser tab is backgrounded during a streaming reply. Tab-suspension network
  errors are now treated as benign interruptions and the conversation silently
  reconciles with the server on tab return.
- df6956c: Reattach to in-flight chat stream after reload so streaming responses keep rendering instead of disappearing.
- 374d7f7: Dashboard agent chats no longer also send a mailbox message by default; agents only mail the user when explicitly asked.
- 0a2f3d6: Fix low-contrast Markdown/Tools/fullscreen toggle buttons in the agent log header by replacing the undefined `--text-on-accent` CSS variable with the canonical `--accent-text` token. Also fixes the same typo in DocumentsView.
- 2a7a0b0: Remove a useless try/catch wrapper in the engine's `execute-once-then-complete` approval gate. Internal cleanup; no behavior change. Eliminates the workspace's last ESLint `no-useless-catch` warning.
- c4e0c1d: Permanent-agent heartbeats can no longer be deadlocked by an approval policy interposing on `fn_heartbeat_done`. The terminal heartbeat-completion tool now bypasses both the action gate and the permanent-agent gate by reference, so even a misconfigured policy or classification-table regression cannot strand a heartbeat run. No user-visible behavior change for correctly classified deployments.
- 90e9dde: Agent messaging via `fn_send_message` can no longer be deadlocked by an approval policy interposing on it. The messaging primitive now bypasses both the action gate and the permanent-agent gate by reference, so even a misconfigured policy or classification-table regression cannot strand inter-agent coordination, wake-on-message replies, or agent-to-user escalations. No user-visible behavior change for correctly classified deployments.
- d2d1aad: SelfHealingManager now includes a `clearStaleBlockedBy()` recovery sweep that clears `blockedBy` (and transient `status`) on todo tasks when their blocker is missing, done, archived, paused in-review, or failed in-review with merge retries exhausted. This lets the scheduler re-evaluate those tasks cleanly on subsequent ticks instead of leaving them permanently queued behind stale blockers.
- f75488d: Scheduler: exclude paused in-review tasks from `activeScopes`. Paused failed-merge tasks no longer block dispatch of overlapping todo tasks via `blockedBy` re-stamping. (FN-3867)
- 6a92d62: Add `recoverAlreadyMergedReviewTasks()` self-healing sweep to recover phantom-merge-guard false positives. Detects tasks whose content already landed on the integration branch (via Fusion-Task-Id trailer, branch ancestry, or git patch-id walk) and reconciles them to `done` with proper merge metadata.
- b47f6ff: Restore canonical mergeDetails.commitSha for tasks FN-3794, FN-3814, FN-3829 whose attribution had been overwritten by self-healing reconciliation prior to the FN-3862 fix. Adds an idempotent restoration script (`scripts/restore-merge-sha-fn-3878.mjs`) for operators to re-verify or repair similar drift.
- e7acd27: Wire chat rooms UI to backend. Creating a room now persists via /api/chat/rooms, the sidebar lists real rooms, room threads load history and stream new messages over chat:room:\* SSE events, and the FN-3807 "Coming soon" placeholder is gone.
- 1e80059: Fix chat thread bottom anchoring when reopening sessions.

  Quick Chat and Chat now scroll to the latest message every time they are reopened, even when markdown/images/tool details render after the initial paint.

- f496716: Fire pi `session_shutdown` extension events when Fusion-spawned `AgentSession` instances are disposed, so extensions registered with `pi.on("session_shutdown", …)` run cleanup handlers (including Fusion's dashboard child-process cleanup).

## 0.23.0

### Minor Changes

- 35d5590: Add host support for plugin-registered top-level dashboard views and ship a plugin-first dependency graph view with interactive navigation and project-scoped layout persistence.
- 2b7b922: Add native-shell remote connection management across desktop/mobile, including saved server profiles, optional auth token support, and shell-owned connection switching APIs used by dashboard onboarding/connection UI.
- 8f812e2: Add plugin-managed binary installation/setup lifecycle. Plugins can now declare
  setup hooks (check, install, uninstall) for required binaries/runtimes. Dashboard
  API and CLI commands support checking setup status and triggering install/uninstall.
- 6e8689a: Add a horizontal log split to the TUI's narrow single-pane main view. When
  the terminal is too narrow for the multi-pane grid, the bottom of the
  screen now shows a live log strip while the top keeps the active section
  (System, Stats, Utilities, or Settings). The split is dynamic: the top
  pane gets exactly the rows it needs to render its content without
  truncating (computed from the System chip wrap at the current width, or
  each panel's known row count for Stats/Utilities/Settings), and the log
  strip absorbs all remaining rows — maximizing log visibility without
  clipping the active section. The split disables itself if the leftover
  would give the log strip fewer than 6 rows. Down-arrow shifts sub-focus
  into
  the strip with the same key bindings as the dedicated logs section
  (j/k, Home/G, Enter to expand, w to wrap, c to copy, f to filter).
  Up-arrow at the top of the strip returns focus to the main pane; Esc
  also exits the split. Right/Left/Tab continue to cycle sections,
  including the dedicated full-screen logs view.
- 8c18b45: Add a sender-side "wake recipient immediately" override for messages. The
  message composer now offers a checkbox (when sending to an agent) that sets
  `metadata.wakeRecipient: true` on the message. When honored, the recipient
  agent is woken on receipt regardless of their own `messageResponseMode`
  setting. To prevent agents from forcing wakes on each other, only
  human-originated messages (`fromType: "user"`) trigger the override —
  agent-to-agent traffic continues to respect the recipient's configured
  behavior.

### Patch Changes

- 9be551b: Make the agent error details modal taller on mobile so the full error
  message is visible from the top, with the error pre flexing to fill the
  available height instead of capping at a small fixed height.
- 6f46ab0: Stop the dashboard from auto-marking another agent's messages as read when
  the user opens them while browsing that agent's mailbox. Previously, viewing
  a message in an agent's inbox (e.g. the CEO's mailbox) would call
  `POST /messages/:id/read`, which silently consumed the agent's unread state.
  The agent's heartbeat would then never see the message as pending, and the
  agent's `fn_read_messages` tool (which defaults to `unread_only: true`)
  returned nothing. The mark-as-read call now only fires for the dashboard
  user's own inbox tab.
- 3e68271: Fix the misleading "X active · Y running" label in the Agents overview
  dropdown. Both numbers previously counted agents whose state was either
  `active` or `running`, so the "running" tally over-reported by including
  idle-but-enabled agents. The label now counts each state distinctly:
  "active" reflects only `state === "active"` and "running" reflects only
  `state === "running"`.
- 92d40bc: Two mobile chat fixes:

  1. Tapping the ChatView send button no longer dismisses the soft
     keyboard. preventDefault now fires on `pointerdown` for touch
     pointers (before iOS blurs the textarea — the synthesized mousedown
     it previously relied on fires too late). Click still runs the send
     action so quick taps remain reliable.

  2. The bottom executor status bar is now hidden on mobile while the
     keyboard is open, mirroring `MobileNavBar`. The bar is
     `position: fixed` against the layout viewport, which iOS leaves
     anchored below the keyboard — during a swipe/pan it would slide
     over the message list.

- d791fa9: Fix chat sending silently failing on flaky networks (especially mobile).
  The SSE reader in the dashboard client now treats a closed stream without
  a terminal `done`/`error` event as an error so streaming state unwinds
  instead of getting stuck. The `useChat` and `useQuickChat` hooks also now
  show a toast when a message is queued behind an in-flight response, so
  the previous stuck state is observable rather than silent.
- 74378dc: Workaround long-standing bug where ChatView's mobile send button only
  fired on a long press — quick taps silently did nothing. The previous
  implementation used `pointerdown` + `touchstart` with `preventDefault`
  and a focus-preservation dance so the keyboard would stay up while
  sending; on iOS that path made quick taps fall through entirely. The
  button now uses plain `onClick` with `touch-action: manipulation`. The
  soft keyboard may dismiss on send, which is a minor UX regression
  compared to silent failure. QuickChat is unchanged (it already works
  on mobile).
- c9bbd7d: Fix Codex weekly usage pace calculation when the API returns `reset_at` as epoch milliseconds instead of seconds. The dashboard now parses both formats correctly so weekly reset countdowns and pace status reflect reality.
- a31c432: Restore the documented agent lifecycle by removing `terminated` as an agent state again. Agent stop flows now land on `paused`, while heartbeat run history continues to use `terminated` as a run-status value and existing persisted terminated agents migrate to `paused` on startup.
- 270823d: Fix duplicate ntfy merge notifications by ensuring `ProjectEngine` uses a single `NotificationService` listener graph and passes that shared service into the `NtfyNotifier` compatibility shim.
- a8bfb32: Fix bundled runtime plugin settings behavior for fresh installs: bundled Hermes/OpenClaw/Paperclip settings now open without a 404 before install, first save still lazy-installs, missing bundles return explicit server errors, and bundled install entry resolution now prefers workspace source entrypoints over stale build artifacts.
- 2fce7b3: Fix `scripts/check-test-isolation.mjs` false-failing when `--before` and the
  post-run check are invoked from different working directories (e.g. a worktree
  recorded the baseline, then the main repo ran the check). The shared baseline
  file in `tmpdir()` is now namespaced by a hash of the cwd so concurrent
  worktrees don't clobber each other, and protected `.fusion` dirs that were
  absent from the baseline are now skipped with a warning instead of being
  treated as `{exists: false}` (which previously flagged the entire pre-existing
  directory tree as a "test mutation").
- 85381df: Improve full Chat mobile tool-call cards by keeping collapsed summaries on a single row and tightening spacing for denser scanning without changing expand/collapse behavior.
- 8df5d26: Forward engine skill selection into runtime `skills` metadata for all session paths, and improve Hermes runtime behavior so first-turn prompts preserve Fusion system/skill context instead of silently dropping coordination capability hints on non-pi runtime runs.
- 6e38dad: Auto-install the bundled Fusion skill when the Hermes runtime plugin loads, including profile-aware Hermes skill-path resolution and safe idempotent replacement behavior. Hermes runtime startup now continues with warnings if skill mirroring fails.
- cabd6be: Fix Claude dashboard OAuth on remote hosts by using the pasted authorization-code flow instead of callback URL rewriting, while preserving callback proxy behavior for providers that still require it.
- fca8d27: Preserve agent inline memory in Agent Companies import/export flows so AGENTS manifests round-trip memory without loss.
- 3f5d01f: Fix an engine compatibility bug where reviewer/triage/executor runs could fail when a provider extension rejected both `thinking` and `reasoning_effort` together. Fusion now retries without the explicit thinking-level override for that conflict instead of marking the run unavailable.
- 4dc91ed: Wire `TaskStore` into the runtime's `AgentStore` so the heartbeat auto-claim
  path can call `claimTaskForAgent` without warning
  `TaskStore not configured for task-claim operations`. The `InProcessRuntime`
  previously built its `AgentStore` with only `rootDir`, which left task-claim,
  checkout, and release operations unconfigured even though the runtime had a
  `TaskStore` available.
- 22250eb: Manual heartbeat runs (POST /api/agents/:id/runs) now respond as soon
  as the run record is created instead of blocking on the full
  executeHeartbeat call. Long-running heartbeats no longer cause the
  dashboard to surface "Failed to start heartbeat run: load failed" when
  the client socket times out before the run completes.
- a143bcc: Convert the heartbeat executor's dynamic `import("./agent-session-helpers.js")`
  and `import("./session-skill-context.js")` calls to static imports. This makes
  missing or partial engine dist surface at module load time (matching the
  existing static `pi.js` import) instead of failing mid-heartbeat with a
  confusing `ERR_MODULE_NOT_FOUND`.
- 923411a: Fix merger subject derivation and add a race-rescue layer to the autostash.

  The deterministic fallback now prefers the lowest-numbered `complete Step N` headline (or the oldest commit) over the most-recent commit, and the AI subject/body prompts weight by commit theme instead of file size — so a small token-cleanup fixup that touches a large file no longer hijacks the squash-merge subject.

  The pre-merge autostash now re-snapshots the working tree after the primary stash is persisted but before `git reset --hard` runs, capturing any dirty paths that landed between the initial snapshot and the destructive wipe (concurrent dev edits during a long merger run, parallel merger runs interleaving, or late test/build artifacts) into a separate `race-rescue` stash so they're recoverable from `git stash list`.

  Adds an advisory `.git/.fusion-merger-active.json` written for the duration of each merger run (taskId, pid, hostname, startedAt) so dashboards / status lines / pre-Edit hooks can surface that `rootDir` is volatile. Not a lock — dev edits are never blocked. Race-rescue stashes are now also surfaced on the task feed via `store.logEntry` with the recovery command, instead of only appearing as a `mergerLog.warn`. `resetMergeWithWarn` now wraps each `git reset --merge` in a snapshot-before/after observer so any silent wipe of unrelated dirty paths emits an actionable warning instead of going unnoticed. Exports `readActiveMergerStatus(rootDir)` for consumers.

- fd7c88c: Fix race-rescue stash duplicating the primary autostash. `git add -A && git stash create` registers a stash commit but does not clean the working tree, so the rescue loop's subsequent `snapshotDirtyFiles` saw the same files the primary stash already captured and stashed them again on every merger run. Now the rescue diffs current dirty paths against the primary stash's recorded path set and only rescues paths that weren't already captured, plus a tree-SHA equality check that drops any rescue whose tree exactly matches the primary.
- e6dc3c7: Address code-review findings on the merger autostash work:

  - `parsePorcelainZ` now correctly handles rename/copy entries (`R` / `C` status), which emit two NUL-separated entries for one logical change. Previously the old name was treated as an independent dirty path, causing `runObservedDestructiveSyncOp` to emit spurious "cleared N path(s)" warnings whenever a rename was in flight.
  - The race-rescue loop in `stashUnrelatedRootDirChanges` now runs `git reset` between attempts so each `git add -A` starts from a clean index, preventing iteration-2+ stashes from drifting due to stale staging rather than genuine new writes.
  - `writeActiveMergerStatus` now writes the advisory file via temp-path + atomic `renameSync` so dashboard readers can't observe a partial write.
  - `deriveDeterministicSubjectSummary`'s Step regex switched from `[—\-:]` to `(?:—|-|:)` — same matches, but the em-dash intent is obvious to anyone auditing.

- cd845d3: Reduce redundant test/build runs during merge verification:

  - **Skip the verification re-run after a no-op in-merge fix.** When the fix
    agent doesn't actually modify the working tree (compared via a git
    `diff HEAD` + `status --porcelain` content fingerprint), there's nothing
    new to verify. The merger now logs "fix agent made no changes — skipping
    verification re-run" and records the attempt as failed without paying the
    multi-minute test/build cost.
  - **Skip `pnpm install --frozen-lockfile` when the lockfile hash hasn't
    changed since the last successful install.** A `node_modules/.fusion-install-marker`
    file records the lockfile SHA-256 after a successful install; subsequent
    merge attempts in the same worktree skip install when the lockfile content
    is unchanged, even when `package.json` is staged. Existing
    `shouldSyncDependenciesForMerge` filtering still applies as a first gate.

- 9087239: Remove the dead `reportDashboardPerf` client and its five call sites in
  `App.tsx` / `useProjects.ts`. The companion server route `/_perf/dashboard-load`
  no longer exists, so every call was a silently-swallowed 404. Also drops the
  `dashboard-perf.log` runtime ignore-list entry from
  `scripts/check-test-isolation.mjs` since nothing creates that file anymore.
  Console-side perf logging via `console.log("[App] …")` and
  `console.log("[useProjects] …")` is preserved.
- 0d15916: Fix a race in the stuck-task requeue path that could clobber a task back to
  `todo` (with all step progress reset and worktree torn down) immediately
  after `SelfHealingManager.recoverCompletedTasks` had already moved it to
  `in-review`. The executor's stuck-kill cleanup ran in `execute()`'s
  `finally` block and used a stale captured `task.column` snapshot, so it
  would happily overwrite a fresh recovery. The cleanup now re-reads the
  latest column and skips entirely when the task has moved past
  `in-progress`/`todo`.

  Also adds a new setting `preserveProgressOnStuckRequeue` (default: `true`,
  toggle in Settings → Engine, near "Stuck Task Timeout"). When enabled, the
  stuck detector's requeue passes `{ preserveProgress: true }` to `moveTask`
  so completed step statuses survive the bounce and the agent can resume
  from where it left off instead of restarting every step from pending.

- 7f90308: Stop inadvertently pausing user-facing tasks during heartbeat-unresponsive
  recovery. Adds a `cascadeToTasks` option to `pauseAgent`/`resumeAgent`
  (default `true`) and passes `false` from `recoverUnresponsiveAgent` — the
  internal pause/resume cycle there is just to set
  `pauseReason="heartbeat-unresponsive"` on the agent and shouldn't toggle
  the user's task pause state.

  Also auto-clears `paused`/`pausedByAgentId` in `updateTask` when the agent
  that paused a task is unassigned (or replaced). Previously a task could be
  left orphaned-paused with no UI affordance to recover, since the
  `Pause/Unpause` action in `TaskDetailModal` is hidden whenever an agent is
  assigned.

- 593b42e: Extend `scripts/check-test-isolation.mjs` runtime ignore list to cover live
  fusion app paths that previously tripped the merge-time check when a fusion
  instance was running on the same HOME during tests: `tasks/`, `messages/`,
  `memory-insights.md`, `test-cache.json`, `HEARTBEAT.md`, `kb.db.backup-*`,
  and `fusion.db.pre-*` snapshots. Tests still must not write to these paths;
  the filter only suppresses noise from a concurrently-running app.
- a14ef9e: scripts: make `check-test-isolation` resilient to a concurrently-running fusion app on the same HOME. Filter out paths the live app legitimately writes (databases, agent sessions/memory, plugins, automations, logs, config), sample the baseline over a longer window, and re-sample on suspected violations to avoid false positives during local `pnpm test:isolated`.
- 1100b39: Fix worktree collisions when tasks are manually moved into in-progress.

  Two related bugs caused two in-progress tasks to share a single
  `.worktrees/<name>` directory:

  1. The dashboard `POST /tasks/:id/move` route promoted tasks to
     in-progress without allocating a fresh worktree path, so a queued
     task carrying a stale `worktree` field from a prior
     `preserveResumeState` requeue could land in-progress on a directory
     already owned by another active task.

  2. `TaskStore.moveTask({ preserveResumeState: true })` kept the
     worktree pointer on requeue. When the on-disk checkout was later
     removed or reassigned, the next dispatch could collide with a
     worktree the scheduler had since handed to another task.

  Fixes:

  - `moveTask` now releases the worktree pointer on every reopen-to-todo
    hop. The `branch` field is preserved so the next run reattaches via
    `git worktree add <path> <branch>` and resumes any committed
    progress. A new `preserveWorktree: true` option opts internal
    bounces (workflow-rerun) out of the release so listeners never see
    an interim `worktree=null` state.
  - `moveTask` accepts an `allocateWorktree` callback that runs under a
    cross-task allocation lock in `TaskStore`, building `reservedNames`
    from a fresh `listTasks` snapshot so two concurrent moves cannot
    pick the same name.
  - The manual-move route and the scheduler dispatch path both flow
    through the new allocator, sharing the lock.
  - `planTaskWorktreePath` is exported from `@fusion/engine` for
    consumers that need to plan worktree paths the same way the
    scheduler does.

## 0.22.0

### Minor Changes

- e658e8e: Decouple permanent agent heartbeats from task state, and add per-agent `allowParallelExecution` setting.

  Heartbeats now run for permanent agents regardless of bound-task block state — the prior early-exit on `queued + blockedBy` is removed along with its dead state-tracking machinery. `HEARTBEAT_SYSTEM_PROMPT` is rewritten to scope heartbeats to ambient coordination (messaging, memory, finding work, delegation, surfacing/chasing blockers, status); task body work continues to run via the executor path. Ephemeral agents are unchanged — they don't run heartbeats and their blocked-task gating in the scheduler is untouched.

  New `allowParallelExecution` flag (default `true`, permanent agents only) on `AgentHeartbeatConfig`. When `false`, the heartbeat and task executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run. Either side re-dispatches the other's deferred work on completion via `resumeTaskForAgent` and the in-process runtime's `onRunCompleted` hook.

  UI toggle surfaces in the agent's Heartbeat Settings tab alongside `runMissedHeartbeatOnStartup`.

- 041eb89: Per-agent setting `runMissedHeartbeatOnStartup` (default off): when enabled, the engine fires a single catch-up heartbeat at server startup if the agent's `lastHeartbeatAt` is older than its configured interval — i.e. a scheduled tick was missed because the server was down.

  The check runs in the same startup pass that arms heartbeat timers (`packages/cli/src/commands/dashboard.ts`), so agents whose state isn't `active`/`running` or who have heartbeats disabled never trigger. Catch-up runs use the existing `executeHeartbeat` path with `source="timer"` and `triggerDetail="startup-missed-heartbeat-catchup"` so per-agent serialization, budget enforcement, and missed/recovered tracking continue to apply. UI toggle lives in the agent's Heartbeat Settings tab.

- 8eb5c3d: Remove the `terminated` AgentState. The agent lifecycle now runs through `idle | active | running | paused | error`, with `paused` (carrying a `pauseReason`) absorbing every former `terminated` use case (manual stop, heartbeat run termination, spawned-child cleanup). Run status is unchanged — heartbeat runs still report `terminated` independently of the agent state.

  Migration: existing `agents` rows where `state = 'terminated'` are rewritten to `state = 'paused'` with `pauseReason: 'migrated-from-terminated'` on first store init (`__meta` key `removeTerminatedAgentState`). The dashboard "Terminated" filter option, badge, and CSS rules are gone; "Stop" buttons now transition the agent to `paused`. The `dashboard.READMEs` "Terminated agent filtering" behavior in the agents list is also dropped — paused/error agents are visible by default, and AgentListModal/AgentsView no longer hide them in "All States."

### Patch Changes

- 7d41271: Three small UX fixes on the agent list card.

  - **Optimistic Run Now**: clicking the Run Now button now flips the card's state badge to `running` immediately. The `startAgentRun` API call can take several seconds, and the prior code awaited it before any visual feedback, leaving users unsure whether the click registered. Mirrors the existing `handleStateChange` pattern — stamp the override, await the API, refresh on success, roll back on failure.
  - **Whole-card clickable**: the entire `.agent-card` body opens the agent detail view, not just the name/icon area. Clicks on action buttons (Run Now, Pause, Details, Delete), the role-edit select, and the role-icon button keep their dedicated behaviors via a target check that bails on interactive descendants. `role="button"`, `tabIndex`, and Enter/Space handling preserve keyboard access; a `--focus-ring` outline shows the focus state.
  - **Single-row card actions**: renamed "View Details" → "Details" and switched `.agent-card-actions` to `flex-wrap: nowrap` with per-button `flex-shrink: 0; white-space: nowrap` so Run Now / Pause / Details stay on one row regardless of card width.

- c76db06: Agent list color now signals run status only: `running` is green, `error` is red, and `idle` / `active` / `paused` all use the neutral gray. Previously `active` shared green with `running` and `paused` was yellow, which made the list visually busy and obscured which agents were actually executing. Applies to the badge, list card border, board card border, and org-chart node card across all agent views.
- b2aed0f: Engine stop now tears down in-progress merger and triager agent sessions
  that previously kept streaming past shutdown.

  **Triager**: `TriageProcessor.stop()` previously only halted the polling
  loop, leaving any in-flight specify session and its reviewer subagents
  streaming LLM tokens and tool calls past shutdown. It now aborts and
  disposes them via the same path the global-pause handler uses.

  **Merger**: `aiMergeTask` creates up to three distinct agent sessions
  during a merge — autostash conflict resolver, in-merge verification fix
  agent, and pull-rebase conflict resolver — but only the autostash session
  was registered via `onSession` for the engine to track. The fix-agent and
  rebase-resolver sessions are now also registered, so
  `ProjectEngine.stop()` actually disposes whichever merger session is
  running when shutdown lands.

- d47501f: Fix two related agent-lifecycle leaks and extract the coordinator into a reusable class.

  **Stuck-in-running bug.** `executeHeartbeat`'s governance-skip paths (budget exhausted, budget threshold, global pause, engine paused) called `startRun` first — flipping the agent to `running` — then short-circuited with `skipStateTransition: true`, leaving the agent permanently stuck at `running` with no active run. Removed the `skipStateTransition` flag from those four paths so they flow through the normal `running → active` transition. Added `HeartbeatMonitor.reconcileOrphanedRunningAgents()` on startup to recover any agents already trapped in this state from older versions.

  **Ephemeral task-worker pile-up.** Runtime-spawned `executor-FN-XXXX` workers leaked across runtime restarts because the in-memory `taskAgentMap` reset every process and there was no on-disk fallback. A task started in one session and completed in another would orphan its worker; over time hundreds piled up. The startup sweep also only deleted ephemerals in halt states, ignoring the no-`taskId` case that accounted for nearly every zombie. Now: spawn dedup via `findAgentByName` lookup before create, on-disk fallback in completion/error paths, and the startup sweep deletes any ephemeral not bound to an in-progress task.

  **`EphemeralWorkerManager` extraction.** The lifecycle logic is now a single class (`packages/engine/src/ephemeral-worker-manager.ts`) owning `taskAgentMap`, `pendingDeletions`, the halt-state listener, and the startup sweep. `InProcessRuntime` shrinks by ~140 lines and delegates via `workerManager.onTaskStart` / `.onTaskComplete` / `.onTaskError` / `.attachStateChangeListener` / `.reconcileOrphaned`. Future runtimes that drive `TaskExecutor` directly inherit the same lifecycle. Durable assigned agents now return to `active` after task completion (was `terminated` in the old contract).

- 12193d2: Auto-install bundled runtime plugins (Hermes / OpenClaw / Paperclip) on first Save in Settings, and ship them inside the published CLI so npx-installed Fusion can load them. Previously the runtime cards rendered but `Save` / `Save and Test` failed with `Plugin "fusion-plugin-…-runtime" not found`, and the plugins were unavailable when the CLI was installed via npm/npx because their workspace `@fusion/plugin-sdk` dependency wasn't bundled. Each runtime plugin is now bundled at CLI build time into a self-contained `dist/plugins/<id>/bundled.js`, and `PUT /api/plugins/:id/settings` lazily registers a bundled runtime via the new `ServerOptions.ensureBundledPluginInstalled` hook the first time the user saves.
- ff66c20: Clarify runtime memory guidance so agents explicitly distinguish private `scope="agent"` memory from shared `scope="project"` memory in prompts and tool metadata.
- bb6169a: Improve dashboard agent error UX by replacing inline stack-trace dumps with compact error indicators that open a shared details modal, including copy-to-clipboard and a prefilled GitHub issue shortcut.
- 12b4a4a: Expose task creator provenance in agent-facing task tools by adding source summaries to `fn_task_show` and concise `[via: …]` labels in `fn_task_list`, including agent-name preference from `sourceMetadata.agentName` with `sourceAgentId` fallback.
- 89fd7a9: Mission sidebar follow-ups for card density and CTA prominence.

  - **Wider title in the sidebar**: stack mission cards vertically inside the
    sidebar so the title row spans the full card width instead of competing
    with the action buttons. Action buttons now sit on their own row below.
  - **Activity on its own row**: the `Activity X ago` label moved out of the
    cramped stats line into its own row.
  - **Full-width progress bar**: the completion bar moved out of the stats
    row onto its own line and now scales to the full card width instead of
    competing with stat labels for horizontal space.
  - **Centered "Plan New Mission" CTA**: the sidebar header now hosts a
    full-width primary-styled button (matches the chat sidebar's "New Chat"
    affordance) with the Sparkles icon and "Plan New Mission" text — replacing
    the dashed-outline icon-only buttons. Mobile footer uses the same label.
  - **Auto-select first mission (inline desktop)**: the inline mission view
    now opens with the first mission preloaded into the detail pane instead
    of an empty placeholder. Falls back to the existing empty-pane copy when
    no missions exist. Standalone-modal usage is unchanged.
  - **Richer empty state**: when no missions exist, the list now explains
    what missions are and surfaces a primary "Plan New Mission" CTA inline.

- f04ade0: Mission view sidebar and list-card UX fixes.

  - **Resizable mission sidebar**: the desktop split sidebar is now drag-resizable via a vertical handle (also keyboard-accessible with arrow keys). Width persists to `localStorage` (`fusion:mission-sidebar-width`), bounded 220–560px, default 300px. Previously fixed at ~284px with `flex-shrink: 0`.
  - **Mission card title no longer truncates aggressively**: tags (autopilot zap, health badge, status pill) moved to a second row below the title so the title can use the full card width. Removed the redundant overflow-prone `Active: …` line that was sometimes spilling outside the card.
  - **Single AI-driven create flow**: removed the manual `+ New Mission` button from the sidebar header and bottom footer. The Sparkles button (now labeled "Create New Mission") is the only entry point — the dead `handleCreateMission` callback and unused `activeSliceLabel` were removed too.

- b312ca4: Fix terminal input/output doubling triggered by creating a new tab. The connect-effect's `contextChanged` dependency flips true→false in the same render cycle as the new connection, re-running the effect and closing the still-CONNECTING WebSocket. Because `cleanup()` and `connect()`'s pre-close paths weren't nulling `ws.onopen`/`onmessage`/`onclose`/`onerror`, the ghost socket's `onmessage` continued to fire on the shared callback Set, delivering each pty data chunk (including keystroke echo) twice to xterm.

## 0.21.0

### Minor Changes

- ac74cb0: Enable browser back-button navigation within the SPA dashboard. Previously, the back button would leave the dashboard entirely. Now it dismisses the top modal or reverts to the previous view, matching standard SPA behavior on both desktop and mobile.

### Patch Changes

- 61dac28: fix: declare node-pty as a runtime dependency so `npx runfusion.ai` can start the embedded terminal on a clean install. Previously node-pty was only present transitively via the workspace `@fusion/dashboard` devDependency, which is stripped at publish time — fresh users hit a 503 "PTY module could not be loaded" when opening the dashboard terminal. The package-config test guard has been tightened to catch this regression.
- 8a57d3f: feat(tui): up/down arrows now cycle sections on the Main page (matching ←/→), except on the Logs panel where they continue to navigate log entries. Pressing Enter on a Logs entry now also releases xterm mouse reporting while the entry is expanded, so users can click-drag to select log text for copying; closing the expanded view restores wheel scrolling automatically.

## 0.20.0

### Minor Changes

- f711019: Add agent self-improvement tools (fn_read_evaluations, fn_update_identity) and periodic self-improvement scheduling based on evaluation feedback.
- d7880c6: Add plugin dashboard view discovery and navigation integration via `GET /api/plugins/dashboard-views`, plugin view ID persistence (`plugin:${pluginId}:${viewId}`), and static host-side plugin view registry rendering.
- 995faf2: Add per-agent heartbeat auto-claim controls so identity-bearing agents can opportunistically claim relevant unowned tasks during no-task heartbeat runs.
- aab28e1: Add first-class Anthropic (Claude) OAuth login support in Settings and onboarding, including fallback detection of existing Claude credentials from local Claude installs while keeping the separate Claude CLI provider option.

### Patch Changes

- df20edb: Auto-archive sweep now skips done tasks that still have an active dependent (in triage, todo, in-progress, or in-review). Previously a stale done task could be archived while a downstream task was still pending, wiping its `.fusion/tasks/{id}/` directory and breaking the downstream agent's sibling-spec read. The agent prompt also now instructs falling back to `fn_task_show` when those sibling files aren't on disk.
- Fix agent heartbeat execution in multi-project setups. On-demand heartbeat triggers from the dashboard API now correctly route to the engine of the project the agent belongs to, instead of silently creating a zombie run record that never executes. Also auto-provisions default agents (triage, executor, reviewer, merger) when the engine starts with an empty agents table.
- 9b01c0a: Self-heal orphaned `agentRuns` rows left in `status='active'` when the dashboard process crashes mid-heartbeat. The trigger scheduler treats any active run as "still running" and silently skips every subsequent tick, so a single crashed run could leave an agent without heartbeats for hours. SelfHealingManager now reconciles these on startup and during periodic maintenance, terminating runs whose `processPid` does not match the current process or whose age exceeds 6 hours.
- b4a2e7a: Fix Quick Chat backend divergence and consolidate the chat render-mode toggle.

  - Backend: Quick Chat and regular chat now go through a single agent-creation path (`createResolvedAgentSession`), eliminating the `createFnAgent` branch where pi-ai's `cleanupSessionResources(sessionId)` could tear down resources still in use by a newer generation. The `sendMessage` `finally` only disposes the agent if it still owns the `activeGenerations` slot, so a pre-empted generation no longer rips state out from under its successor.
  - Frontend: extracted the SSE streaming-handler factory shared between `useChat` and `useQuickChat` (RAF coalescing, accumulators, tool-call dedup, fallback handling) into `createChatStreamHandlers`. Both hooks now compose it instead of duplicating ~85 LOC each.
  - UX: removed per-message Markdown/plain-text eye toggles. A single thread-level toggle now lives in the chat header and flips every assistant bubble (including the streaming one) between rendered Markdown and plain text. Model-only chats also drop their per-message agent-identity row — the model is shown once in the thread header.

- e5fc71b: Treat pi-ai Codex WebSocket transport drops (`WebSocket error`, `WebSocket closed …`, `WebSocket stream closed before response.completed`) as transient errors so the engine retries them instead of marking the task failed. Tag the model id onto the thrown error and emit a structured warn so future drops can be triaged by which provider/model is unstable.
- fdc37a3: Auto-toggle xterm mouse reporting in the dashboard TUI based on the focused panel. Default is now OFF so click-drag selection works by default (e.g. selecting the auth token straight off the System panel without needing `[c]`). Mouse reporting auto-enables when the user focuses a panel that consumes wheel events:

  - Status mode: on while Logs is focused, off elsewhere
  - Interactive views: on for Files / Git / Board (Board uses the wheel in the task-detail screen), off for Agents / Settings

  `[M]` remains a manual override but the next focus change reapplies the auto policy. The controller's `start()` now honors the initial `mouseEnabled` value rather than unconditionally writing the SGR enable sequence at boot.

- 1187ea4: Improve dashboard TUI System panel discoverability and panel navigation:

  - Default the focused panel to **System** on launch so `Enter` immediately opens the dashboard URL in the browser. Adds an inline hint row (`[Enter] open URL · [c] copy token · [M] mouse on/off`) that is only visible while System is focused.
  - Add `[c]` shortcut (when System is focused) to copy the auth token to the clipboard, with the same flash + log-line feedback used by the Logs `[c]` copy. Mouse mode normally blocks click-drag selection of the token, so this gives users a keyboard path.
  - Add `[M]` global shortcut to toggle xterm mouse reporting at runtime. Off → click-drag does native text selection (the only path that works under tmux's `mouse on`, where `Shift+drag` is intercepted by tmux before reaching the terminal). On → wheel scrolling on Logs/Files/Git list panels works as before.
  - Fix `←`/`→` panel cycling order: `SECTION_ORDER` was `[system, logs, utilities, stats, settings]`, which didn't match the visual layout. Changed to `[system, logs, stats, utilities, settings]` so left/right now matches both the on-screen left-to-right card order and the Tab/Shift+Tab cycle (`PANEL_ORDER`). From Logs going right now lands on Stats; from Settings going left now lands on Utilities.
  - Updated the help overlay with the new shortcuts.

- 4137573: Fix chat: after stopping a streaming reply, the next message would appear sent but show no Stop button or "Connecting…" indicator. The cancellation broadcast from the previous generation was leaking into the new SSE subscription, immediately marking it as errored. Each `chatManager.sendMessage` now allocates a per-generation id; `ChatStreamManager` only delivers tagged broadcasts to subscribers from the matching generation, and `sendMessage`'s cleanup no longer deletes a newer generation's `activeGenerations` slot when an older one finally unwinds.
- b85743d: Fix Quick Chat: messages would silently fail after closing the browser tab mid-response and reopening it. The backend agent kept running with no listener and left a stale `activeGenerations` slot; the next message's freshly-opened CLI session then raced against the lingering agent on the same session file. The `/messages` route now calls `chatManager.cancelGeneration` when the client disconnects before the response ended, and `beginGeneration` only aborts the previous generation's controller instead of pre-emptively disposing its agent (the previous agent's own `finally` handles dispose, so we don't tear down the CLI process under the new agent).
- b061e2b: Fix Plan Mission With AI modal: stale goal text and unable to type in textarea. The persisted-goal restoration effect depended on `handleStartInterview`, which recreates on every keystroke via `missionGoal` — causing the effect to re-fire and overwrite user input with stale localStorage data on each character typed.
- 2f40843: Fix QMD-backed agent memory behavior so search results normalize to readable agent-memory paths and dream-processing writes trigger agent-memory QMD refreshes for discoverability.
- 69c75fe: Fix fn_research_list status enum to include all valid ResearchRunStatus values and add wait_for_completion support to fn_research_run.
- f2accb7: Fix Planning Mode summary refinement so "Refine Further" reliably continues completed/resumed sessions through the backend interview flow instead of showing a blank question screen.
- 576238a: Use durable assigned agents as active task execution owners when `assignedAgentId` targets a non-ephemeral agent, instead of always creating transient `executor-FN-*` task-worker agents.
- d790854: Rename global research flat settings keys from `research*` to `researchGlobal*` to enforce settings-scope parity and avoid global/project key collisions.
- 5fb7c77: Fix Git Manager mobile Changes layout overflow so staged/unstaged file lists no longer force horizontal page scrolling. The changes panel now wraps section actions and file rows at narrow widths while preserving readable file names and usable controls.
- a0c1e5b: Give autonomous heartbeat agent sessions coding-capable workspace tools (read/write/edit/bash within worktree boundaries) while preserving heartbeat-specific custom tools and readonly safety for non-heartbeat readonly flows.
- 43dd048: Fix Droid CLI auth/status probing to resolve the effective binary path from plugin settings (including custom `droidBinaryPath`) so Settings no longer reports false "not installed" states when Droid is configured at a non-default path.
- af0bc4b: Auto-pause unresponsive agents with `pauseReason: "heartbeat-unresponsive"` and immediately auto-resume them through the shared heartbeat monitor lifecycle, including consistent assigned-task pause/unpause behavior and single on-demand restart semantics.
- 8a30b6f: Deduplicate auto-merge recovery follow-up task creation so repeated verification-cap and conflict-bounce-cap failures reuse an existing active recovery task instead of spawning duplicates.
- 59f6c84: Fix dashboard user mailbox routing to use deterministic canonical identity normalization so agent replies sent to `dashboard`, `user:dashboard`, or `User: user:dashboard` all land in the dashboard inbox while preserving reply-link metadata.
- 30f6381: Preserve complete GitHub source metadata for imported issues across CLI and extension import paths, and improve commit reference generation by falling back to `externalIssueId` when `issueNumber` is missing.
- 2b809fc: Stop the merger from wiping concurrent dev edits in `rootDir`.

  `aiMergeTask` issues several `git reset --hard` / `git reset --merge` / forced-checkout calls against `rootDir` during merge attempts. When `rootDir` is the developer's primary checkout (the common case for solo / single-host setups), those resets silently discard any unrelated unstaged or untracked changes in the working tree. We've burned developer work this way (FN-3329 retro: dashboard-tui edits were wiped mid-flight by an unrelated merge run).

  `aiMergeTask` now snapshots dirty paths at entry and, if any are present, stashes them under a labeled autostash (`fusion-merger-autostash:<taskId>:<ts>`, includes untracked files via `git stash push -u`). A try/finally around the merge body restores the stash on every exit path — success, error, or abort. If the pop conflicts (e.g. the merge committed an overlapping change), the stash is left intact and the operator gets a recovery hint in the merger log; we never silently `git stash drop`.

  Best-effort throughout: a stash failure logs and proceeds with the old behavior rather than blocking the merge — strictly worse regressions are off the table.

- d253e01: Reduce log noise: bump `checkForChanges` slow-poll warn threshold from 100ms to 750ms (the 1s poll interval + multiple SQLite queries routinely exceed 100ms without indicating a real problem), and route skill-resolver `info` diagnostics (e.g. "Requested skill: …") through `log()` instead of `warn()` so informational messages no longer surface as warnings.
- 9115130: Upgrade `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` from `^0.72.1` to `^0.73.0` across cli, engine, and dashboard. pi-ai 0.73 also extracts the underlying `ErrorEvent.error` cause for Codex WebSocket failures, complementing our local transient-retry classifier.

## 0.19.0

### Minor Changes

- 1e73863: Add first-class llama.cpp provider support with bundled extension wiring, dashboard status/auth routes, model filtering, and onboarding/settings UI for enabling llama-server models without manual `pi install` steps.
- 496c000: Add `fn update` command to check for and install the latest version of Fusion.
- df253a8: Cache merge verification by tree hash and boost test concurrency for in-review verification.

### Patch Changes

- d06475b: Harden the publish path against dockerode-class missing-dependency regressions (#33). Adds a generalized invariant test that walks `tsup.config.ts` and asserts every non-builtin `external` is either a runtime dep or in an explicit transitive-allowlist, plus a pre-publish smoke step in `pnpm release` that packs the public tarballs, installs them with plain `npm` into a clean temp dir, and invokes the bin — catching the dockerode-class bug (and others like missing `files` globs) before publish, since pnpm hoisting masks it in the workspace.
- eeab870: Store generated memory insight artifacts under `.fusion/memory/` (`memory-insights.md`, `memory-audit.md`, and `memory-audit-state.json`) instead of top-level `.fusion/` files, with compatibility migration for existing legacy files.
- d30f8a7: Allow the dashboard task-detail footer action to manually drive PR-first completion when `mergeStrategy` is `pull-request` and `autoMerge` is disabled.
- 8483a5f: Make the settings modal fill the viewport on mobile and align section headings with form-group gutters for consistent spacing across each settings page.
- df253a8: Cache per-package test results by content hash to skip unchanged packages across sequential merges.

  `scripts/test-changed.mjs` now maintains a per-project cache at `.fusion/test-cache.json`. For each package in a changed-mode run, a SHA-256 is computed from the git blob SHAs of every tracked file in the package directory plus `pnpm-lock.yaml` and `tsconfig.base.json`. If the hash matches a cache entry younger than 7 days the package is excluded from the `pnpm --filter` invocation and tests are skipped. After a successful run the passing hashes are written atomically. Cache lookups are bypassed when `FUSION_TEST_NO_CACHE=1` or `--no-cache` is passed, and never applied to full-suite runs. A new `FUSION_TEST_WORKSPACE_CONCURRENCY` env var controls `--workspace-concurrency` (default `2`).

## 0.18.1

### Patch Changes

- 89401cd: Fix `npx runfusion.ai` failing with `ERR_MODULE_NOT_FOUND: Cannot find package 'dockerode'` by declaring `dockerode` as a runtime dependency of the published CLI package (#33).
- 89401cd: Allow the dashboard task-detail footer action to manually drive PR-first completion when `mergeStrategy` is `pull-request` and `autoMerge` is disabled.

## 0.18.0

### Minor Changes

- cc5c8c6: Extend dashboard node management with managed Docker node status UI, Docker-specific detail sections, and Docker node status/logs API routes.

### Patch Changes

- 986a928: Fix dashboard task deletion failing with "still referenced as a dependency" even after the user confirms removing dependency references. The `useTasks` hook's `deleteTask` was dropping its `options` argument, so the `removeDependencyReferences` flag from the confirmation flow never reached the API.
- c00b018: Fix mobile bottom nav bar overlapping the iOS home indicator in installed PWAs and the visible gap between the nav bar and the executor status bar. The nav bar now extends its surface into the safe-area inset so icons sit above the home indicator and the bar meets the status bar flush.
- 66f85da: Treat OpenAI-compatible `finish_reason: repeat` (raised by Moonshot/Kimi when its server-side repetition detector trips) as a soft stop in the engine heartbeat instead of a fatal error, so agent runs survive the truncation and can continue on the next tick.
- 3afb62b: Fix skill name matching between Fusion's two-segment names (e.g. `web-research/SKILL.md`) and pi-coding-agent's bare directory names (e.g. `web-research`). Patterns and requested skill names now strip the `/SKILL.md` suffix before comparison, eliminating spurious "not found in discovered skills" warnings.
- 08d655a: Fix a mobile dashboard regression where closing Planning Mode after keyboard/visualViewport changes could leave board/list content shifted or clipped. Planning Mode now performs mobile viewport teardown (blur + top snap) on close so control returns cleanly to the dashboard.
- d761ea8: Hardened CLI packaging against native module build regressions by asserting `dockerode`/`ssh2`/`cpu-features` remain externalized in tsup bundle config, preventing native `.node` artifact strings from being inlined into the bundle, and declaring `dockerode` as a runtime dependency for published installs.
- 2b102af: Retrying failed `in-review` tasks now keeps them in `in-review` and only clears retry/error state so auto-merge can re-attempt without resetting task worktree state.
- 8cb8055: Agent pause now automatically pauses all assigned tasks; manual pause controls are blocked/hidden for agent-assigned tasks; tasks now show a "paused by agent" indicator.

## 0.17.2

### Patch Changes

- bacc103: Fix Codex auth interoperability, remote OAuth manual-code login flow, and chat fallback/error handling.

## 0.17.1

## 0.17.0

### Minor Changes

- 6724cf5: Add `autoReloadOnVersionChange` global setting to make the dashboard's automatic reload on version changes optional. Users can disable auto-reload in Settings → General → Updates.
- 7f3fb77: Harden research subsystem with bounded rate/concurrency limits, cancellation safety, timeout handling, bounded retries, and graceful disabled/setup/error states across dashboard, API, CLI, and agent tooling.
- fca870f: Add Docker target connectivity support for local daemon, Docker contexts, and direct host/TLS configuration with dashboard API and UI selectors.
- d812427: Add mesh configuration generation service and API routes for Docker node provisioning (FN-3111). New exports from `@fusion/core`: `MeshConfigGenerator`, `MeshConfigGeneratorInput`, `FullProvisioningInput`, `MeshConnectionConfig`, `MeshConfigResult`.

### Patch Changes

- ba893b8: Fix chat progress indicator on reload: show "Connecting…" indicator when dashboard reloads during active AI generation
- 5291a6f: Fix custom model providers (e.g., Kimi, LM Studio, Ollama) failing with "No API key" error. The auth storage proxy now reads API keys from models.json as a fallback, and a Proxy set trap ensures the ModelRegistry's fallback resolver works correctly through the proxy.
- 3db1752: Fix Planning Mode modal being pushed up when virtual keyboard opens on mobile. The modal now uses `useMobileKeyboard` to track viewport changes and adjusts its height via CSS variables instead of relying on `100dvh`.
- 85d02c8: Fix spurious "new version" reloads in the dashboard by making the build version deterministic based on git commit hash instead of a random token generated per build.
- ea5b7af: Fix mobile dashboard shifted state after closing Todo modal. The TodoModal now uses `useMobileKeyboard` to track visual viewport changes, preventing the underlying dashboard layout from becoming offset when the virtual keyboard opens and closes.
- a82c3dc: Fix project memory tools failing in fresh worktrees and bundled runtime contexts when an internal memory backend artifact is missing. `fn_memory_search` and `fn_memory_get` now resolve the backend through bundled runtime code instead of a fragile side-load import path.
- a47f319: Restore dashboard chat reply rendering for both full Chat and Quick Chat by fixing shared streaming response behavior and follow-up UX styling isolation regressions.
- 9309c8c: Fix planning mode reasoning visibility: AI thinking output is now preserved as expandable conversation history when transitioning from the loading state to the first question or summary, and when resuming persisted sessions.
- b9b5c08: Fix mobile dashboard layout offset after modal keyboard dismissal. Modal inputs no longer leak keyboard-open state into the underlying dashboard layout, preventing stale bottom-padding offsets.
- c76d138: Fix infinite todo↔in-review loop on tasks whose previous run exhausted their merge budget. The scheduler now resets `mergeRetries` to 0 when dispatching a task to in-progress, so each fresh execution gets a fresh merge budget. Without this, a task with `mergeRetries=MAX` and `status=null` would land back in in-review, the merger would refuse it (`canMergeTask` false), and the ghost-review fallback would bounce it to todo every 10 minutes — before the 30-minute merge-cooldown could elapse.
- 21504f6: Remove "install pi" references from user-facing docs and skill files. Fusion no longer requires pi as a prerequisite — all pi installation instructions and "pi extension" framing have been removed from README, docs, and AI skill files.
- a1a8d03: Fix skill and settings discovery when agent cwd is a worktree path. Previously, agents running in worktrees couldn't find skills, load project settings, or discover extensions because path resolution used the worktree directory directly instead of walking up to the project root.
- 63bb62f: Fix extension provider registration using wrong directory when project runs outside engine's working directory.
- de02fed: Improve merger verification-fix agent: detect stale/missing sibling-workspace `dist/` artifacts (e.g. `Failed to resolve import "./X.js"`, `ERR_MODULE_NOT_FOUND` into another package) and rebuild before assuming a code fix is needed. The agent may also modify files unrelated to the task's original change when needed to make pre-existing build/test breakage on the base branch pass.

## 0.16.0

### Minor Changes

- 6ae7aef: Add a project-level `completionDocumentationMode` setting (`off`, `changeset`, `changelog`) and use it during triage prompt generation so new task specs automatically require the appropriate completion release-note artifact.

  Also expose the setting in Dashboard → Settings → Project → General and document it in the settings reference.

- 5ebccc4: Add `createAiSession` to `PluginContext` so plugins can create AI sessions through an engine-injected factory without importing `@fusion/engine` directly.
- 17f5d4a: Execute plugin `onSchemaInit` hooks during startup after plugins are loaded, so plugins can register idempotent tables and indexes with the runtime database.

### Patch Changes

- 41bb6be: Cache the AgentStore SQLite connection per project so the dashboard no longer reopens the database, re-runs migrations, and re-executes `PRAGMA integrity_check` on every `/api/agents` request. On large project databases this turned a sub-100ms call into multi-second latency that bled into every dashboard view fetching the agent list.
- 9c45d24: Cap per-package Vitest worker fan-out to 6 (from `cpus().length - 1`) and lower the root `pnpm test` workspace concurrency from 4 to 2. On high-core developer machines this prevents `pnpm test` from spawning 100+ worker threads, which was saturating CPU and slowing the dashboard while agents ran tests. Override is still available via `VITEST_MAX_WORKERS`.
- 3bafc48: Fix periodic dashboard event-loop stalls caused by synchronous shell-outs and filesystem reads on hot request paths.

  Two distinct sources, both replaced with async equivalents:

  - **`pgrep -f vitest`** ran via `execSync` in `getVitestProcessIds` (`/api/system-stats`, `/api/kill-vitest`) and `killVitestProcesses` (TUI memory-pressure check). On a busy machine `pgrep` walking the process table can take 100ms+; `execSync` blocks the entire Node event loop for that duration, so every concurrent dashboard request hangs while pgrep runs. The TUI variant fired on every memory-pressure tick (every 2s when over threshold), the dashboard variant fired on every system-stats poll (every 5s while the modal is open). Both now use `execFile` with a callback wrapped in a Promise.
  - **`discoverDashboardPiExtensions`** (called from 3 `/api/settings/pi-extensions` routes) did 6+ blocking `existsSync`/`readFileSync` calls per invocation across legacy and fusion settings paths. Converted to `fs.promises.readFile`/`access` and parallelized via `Promise.all`.

- 1744534: Fix dashboard freezing for several seconds while a Fusion agent runs a long verification command (e.g. `pnpm test`).

  Root cause was in `runVerificationCommand`'s output capture (`packages/engine/src/run-verification-tool.ts`). The captured stdout/stderr buffers used a string-concat + re-encode pattern: once total output exceeded 200 KB, every subsequent line did `Buffer.from(buf.tail).subarray(...).toString("utf8")`, allocating and re-decoding the entire ~100 KB tail per line. A vitest run dumping 50k+ lines produced multiple GB of GC churn, which stalled the dashboard event loop in stop-the-world pauses (matching the symptom: occasional multi-second freezes with no CPU spike on the host).

  The buffer is now stored as a chunk array; tail compaction runs only when accumulated size grows past 2× the cap, making per-line append amortized O(1). All 12 existing `run-verification-command` tests pass unchanged.

  Two follow-on changes shipped in the same patch:

  - **Embedded terminal PTY ingestion** (`packages/dashboard/src/terminal-service.ts`) had the same anti-pattern: `outputBuffer.slice(0, 4096)` + `outputBuffer.slice(4096)` on every 4 ms flush tick. Switched to a chunk array with O(1) drain. Throttle bumped from 4 ms to 16 ms (60 fps) and per-flush cap from 4 KB to 64 KB. This was not the cause of the user-reported freeze, but the same O(N²) hazard would surface under any flood from a terminal pane.
  - **Vitest worker fan-out tightened**: per-package cap lowered from `min(6, cpus()-1)` to `min(4, cpus()-1)` in cli/dashboard/desktop/mobile/plugin-sdk/engine (engine had no cap before). Each config now explicitly pins `pool` (`forks` or `threads`) and only sets the matching `poolOptions`, removing the dual-pool declaration. Worst-case `pnpm test` fan-out: ~12 workers → ~8.

- 9619cd1: Speed up dashboard load and interaction for projects with 100+ tasks.

  Two cheap fixes that together cover the dominant hot paths:

  - **DB indexes on `tasks.column` and `tasks.updatedAt`** (migration 59 in `packages/core/src/db.ts`). `listTasks()` filters by `"column"` on every board load, and the SSE/refresh paths sort by `updatedAt`; neither column had an index, so each query did a full table scan plus a temp B-tree sort. With 100+ tasks this becomes the dominant cost on initial load.
  - **Debounce embedded detail-pane fetches** (`packages/dashboard/app/components/ListView.tsx`). `handleEmbeddedOpenDetail` previously fired a full `fetchTaskDetail` (which pulls log + comments) synchronously on every selection change, so rapid keyboard/mouse navigation through a long list would issue a burst of heavy requests. Fetches are now debounced to 200 ms and stale-target requests short-circuit before hitting the server and before applying state.

- 222e11c: Reduce dashboard stalls by clipping oversized agent tool log payloads, bounding the activity API default, and softening live WAL checkpoint behavior.
- 8ba8f63: Avoid nested `.fusion/.fusion` regressions by hardening project-root path handling and stop the CLI binary status probe from executing outdated global `fn` installs just to read their version.
- df04acd: Fix merge commits landing with the bare `feat(FN-XXXX): merge fusion/fn-xxxx` subject. Three fallback commit paths in the merger (auto-resolve-all-conflicts, `-X theirs/ours` side strategy, AI-agent-didn't-commit) now route through the same deterministic message builder as the happy path, so they pick up the AI-generated subject when available. When the AI subject summarizer returns null, the subject is now derived from the branch's first step-commit (with conventional-commit prefix stripped, plus `(+N more)` when multiple commits) instead of falling back to `merge <branch>`. Subject-summarizer timeout raised from 15s to 30s so slow-first-token providers complete instead of silently falling back.
- 2affc14: Fix planning draft sessions losing the user's typed text and model selection between draft create, sidebar reopen, and Start Planning. The agent now receives the freshest persisted `initialPlan` (not the truncated cache from when the draft was first auto-created), drafts that survive a backend restart can still be started, and the model override the user picked at draft time is restored when reopening from the sidebar and threaded through summarize. The sidebar shows the summarized title once available and falls back to a per-draft preview derived from `inputPayload` while the title is still the placeholder — so multiple drafts are distinguishable without leaking raw keystrokes into the persisted title. Titles get re-summarized on textarea blur and modal close so they reflect the final text rather than locking to the first blur snapshot, and the start path skips its own summarize when blur/close already produced a title for the same final text.
- bf7caf5: Fix planning modal final step rendering "Break into Tasks" button offscreen on mobile by stacking the summary action buttons vertically.
- 2769e4a: Fix startup sync errors for step-based automations (auto-summarize, memory dreams) by allowing empty `command` in `updateSchedule` when the schedule has steps.
- e1c1072: Add a dedicated `fallback-used` notification event that fires when Fusion recovers from a retryable model failure by switching to a configured fallback model, and expose it in global notification settings for ntfy/webhook filtering.
- 6b4f28a: Prevent malformed task titles derived from assistant/tool confirmation prose (for example, `Created task **FN-1234** ...`) from being persisted as task titles. The triage finalization/recovery flow now also prefers canonical prompt headings (`# Task: FN-XXXX - Title`) when they match the task ID, so approved specs restore the intended human-readable title in metadata.
- 44cc899: Preserve task step progress when moving tasks back to todo for recovery flows, and add dashboard confirmations that let users choose whether to keep or reset step progress during manual reset-to-todo/triage moves.
- 6bc2de9: Reordered the dashboard TUI Stats panel memory row to show memory usage percentage before absolute used/total values for faster operator scanning.
- 6c5146b: Auto-install the bundled dependency graph plugin on startup and ship its assets in CLI build artifacts so the graph view is available by default.
- 922782f: Bump `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` from 0.70.0 to 0.72.1 across cli, dashboard, and engine. This refreshes the built-in model catalog (`pi-ai/dist/models.generated.js`) that feeds Fusion's `ModelRegistry`, picking up the latest provider/model entries (Anthropic, OpenAI, Codex, Bedrock, etc.) generated from upstream `models.dev`. No Fusion-side API changes.
- adbc613: Group planning model selector and depth controls under a collapsible "Advanced planning settings" disclosure in the Planning Mode modal.
- 8f72eee: Remove the Agents page tree view mode and its associated state, hierarchy hook, and tree-specific styling. The view switcher now supports list, board, and org chart only, reducing maintenance overhead for an unused mode.
- d73070c: Fix triage finalization clobbering its own freshly-written PROMPT.md spec, and fix the older title/description-driven regen path silently dropping `## Review Level` / `## Frontend UX Criteria` and any other sections outside a fixed whitelist. Tasks have been shipping to `todo` (and through to `done`) with empty 70–200 byte specs while the executor agent only saw the original one-line user description; tasks that survived that bug could still come out of triage with their review level reset to 0 and frontend guidance dropped.

  **Root causes.**

  - FN-3056 (May 2) added `taskUpdates.title = promptDeclaredTitle` to `TriageProcessor.finalizeApprovedTask` and called `store.updateTask(task.id, taskUpdates)` while `task.column` was still `'triage'`. A pre-existing block in `TaskStore.updateTask` rewrote PROMPT.md to the bootstrap stub `# {id}: {title}\n\n{description}\n` whenever title/description changed on a triage-column task, overwriting the agent's just-written 6 KB spec with a 150-byte stub before `moveTask` ran.
  - The non-triage branch of the same regen block called `regeneratePrompt`, which rebuilt the file from a fixed section whitelist (`Dependencies`, `Steps`, `File Scope`, `Acceptance Criteria`, `Notifications`). Any section the triage prompt emits outside that whitelist — `## Review Level`, `## Frontend UX Criteria`, custom assessment scoring, anything ad-hoc — was silently dropped on every title or description edit.

  **Fixes.**

  - `packages/core/src/store.ts`: title/description sync is now wrapper-shape-exact, not content-inspecting. The bootstrap stub detector compares the on-disk file against the exact bytes `createTask` would have written for the _pre-update_ title/description (shared `buildBootstrapPrompt` helper), so it never inspects the description body. This is robust to imported issue bodies that contain `## Repro`, `**Created:**`, etc. — earlier heuristic checks (size caps, `##` header presence, `**Created:**` / `**Size:**` markers) misclassified those as real specs. Stub files keep getting fully rewritten so the displayed title/description stay in sync. Real specs get surgical edits only: title changes splice the leading `# ...` heading line and preserve the existing heading style (triage's `# Task: {id} - {title}` vs createTask's `# {id}: {title}`); description changes rewrite only the body of `## Mission`, leaving every other section verbatim. Description-only edits with no `## Mission` section are a no-op rather than a wholesale rebuild. The `regeneratePrompt` whitelist function is removed.
  - `packages/engine/src/triage.ts`: `finalizeApprovedTask` applies the prompt-declared title _after_ `moveTask("todo")` so the column transition happens before any title-driven regen could fire — defense in depth alongside the store-level guard. The `requirePlanApproval` branch folds the title into its existing `awaiting-approval` update.
  - New regression tests in `packages/core/src/__tests__/store.test.ts`: the original bug (real spec on a triage task survives a title change), the false-negative cases (long bootstrap stubs and stubs whose description body contains `##` markdown headings or `**Created:**` / `**Size:**` text are still detected and rewritten), the secondary regression (`## Review Level` and `## Frontend UX Criteria` survive a non-triage title edit), and an end-to-end test that mirrors the exact `TriageProcessor.finalizeApprovedTask` sequence (write spec → updateTask without title → moveTask("todo") → updateTask({title})) on a real `TaskStore` to catch any future regression along the actual finalize path.

## 0.15.0

### Minor Changes

- 9e52028: Add host support for plugin-registered top-level dashboard views and ship the first plugin-first Graph view surface for dependency visualization.

### Patch Changes

- ed477f8: Fix recurring SQLite instability under heavy agent logging by tuning WAL pragmas, adding startup integrity detection with non-blocking corruption signaling, batching agent log writes in transactions, and reducing default maintenance cadence to checkpoint WAL more frequently.
- 9fc5fd9: Limit unregistered project detection to the exact current working directory.

## 0.14.3

### Patch Changes

- dd291db: Tokenize `isInProcessBackupCommand` so it accepts the full canonical zero-install form `npx -y runfusion.ai backup --create` (and other npx flag combinations such as `--yes`, `-p <pkg>`, `--package=<pkg>`) and refuses commands that embed shell continuations or redirections (`&&`, `||`, `|`, `;`, `>`, `<`, backticks, `$()`). The previous regex permitted only a bare `npx` prefix and silently swallowed any tail after `--create`, which meant `npx -y runfusion.ai backup --create` still hit the legacy shell-out and `fn backup --create && notify-send done` lost its trailing side effect when intercepted. The new matcher only intercepts when the entire command is a plain in-process backup invocation; anything else continues through the shell as authored.
- 3119537: Fix pause handling so restarted or paused engines do not resume work or move recovered tasks into review until execution is resumed, including workflow-step and completion handoff paths.
- 03d0fac: Fix agent run log streaming in the dashboard so latest-run logs load lazily and live log streams stay stable while runs refresh.
- 7fec762: Fix engine startup creating a spurious `.fusion/.fusion/fusion.db` under each project root. The in-process runtime was passing the project's `.fusion` directory to PluginStore, which internally appends `.fusion` again, producing a nested empty database alongside the real one. PluginStore now receives the project root, matching every other call site.
- 24b3ded: Add a global `fnBinaryCheckEnabled` setting that lets users opt out of the dashboard's `fn`/`fusion` CLI binary probe. Default remains true (probe runs as before). When set to false, `GET /system/fn-binary/status` returns `state: "skipped"` without spawning a subprocess, the install banner stays hidden, and `POST /system/fn-binary/install` rejects with HTTP 409. Useful when the running dev process is the source of truth and shelling out to whichever globally-installed `runfusion.ai` happens to be on PATH is unwanted.
- 36d623a: Add a defensive guard in `Database` constructor that throws when opening a database at a path whose last two segments are both `.fusion`. This catches caller bugs where a `.fusion` directory is passed in place of a project root (causing `.fusion/.fusion/fusion.db` to be silently created). Future regressions of this class of bug now fail loudly at the originating call site instead of leaving stray nested directories.
- 5a41ce4: Tighten the in-process backup matcher to the `backup --create` form only and run `fn`/`fusion`/`runfusion.ai` `--version` probes from a temp directory. Previously any subcommand starting with `fn backup` (e.g. `--list`, `--cleanup`, `--restore`) was intercepted by the in-process runner that only knows how to create backups, so a scheduled list/cleanup/restore would silently execute a create instead. The interception now also applies to step-based automations, not just the legacy single-command form. The `--version` probe used by the dashboard fn-binary status route now spawns with `cwd=tmpdir()` so an outdated globally-installed CLI cannot drop a stray `.fusion/.fusion/` tree in the parent project's directory while the probe is running.
- 3119537: Demote pi-claude-cli MCP config refresh log from stderr to debug-only so it no longer surfaces as an error.
- 8592472: Run the auto-backup automation in-process instead of shelling out to whatever fusion binary happens to be on `PATH`. The cron and routine runners now intercept commands matching `fn backup`, `fusion backup`, or `npx runfusion.ai backup` and call `runBackupCommand` directly through the engine's already-open `TaskStore`. This stops the auto-backup from launching an outdated globally-installed fusion binary that could re-introduce already-fixed bugs (most recently the `pluginStore` rootDir mistake that created a stray `.fusion/.fusion/` directory each time the schedule fired). New backup automations are also written with the simpler `fn backup --create` command — existing schedules using the old `npx runfusion.ai` form keep working because both forms hit the same in-process interception.
- 66a19b5: Add mouse-wheel scrolling to the dashboard TUI. Wheel scrolls the focused pane in the task detail logs, Git view (commits/branches/worktrees lists), and Files view (tree selection or preview viewport depending on focus). Uses xterm SGR mouse reporting (`?1000h` + `?1006h`) without motion tracking so Shift+drag native text selection still works.

## 0.14.2

### Patch Changes

- 7ec394a: Keep chat and quick chat visibly in a connecting or thinking state during long Claude CLI responses, and repair missing spaces in some streamed sentence boundaries.
- b3e2b61: Hide deprecated Google Gemini CLI/Antigravity auth providers from dashboard onboarding and Settings while keeping supported Google/Gemini API-key, Google Generative AI, Vertex, and Cloud Code paths intact. Also documents the internal pi-coding-agent v0.71.x upgrade plan for follow-up dependency bump work.
- b3e2b61: Remove redundant `fn_identity` heartbeat tool and trim the inline Identity Snapshot to presence flags + content hashes. Full soul/instructions/memory content is already loaded in the system prompt's Custom Instructions section, so per-tick previews were duplicating multi-KB of context for no verification benefit. Saves prompt tokens on every heartbeat run.

## 0.14.1

### Patch Changes

- cafe986: Fix readonly `createFnAgent` sessions to preserve caller-supplied engine custom tools while still excluding host extensions. This restores delegation and memory tools for no-task heartbeat/reviewer readonly sessions without reopening host extension tool injection in summarizer flows.

## 0.14.0

### Minor Changes

- e505bad: Make the `fn` / `fusion` global CLI install discoverable and self-serve from the dashboard.

  - Settings → General now has a **CLI Binary** panel showing whether `fn` (or `fusion`) is on PATH, the resolved version, and a one-click **Install with npm** button that runs `npm install -g runfusion.ai` server-side. The panel also surfaces copy-to-clipboard install commands (`npm install -g runfusion.ai` and `curl -fsSL https://runfusion.ai/install.sh | sh`) for users with non-default npm setups, and reports a permissions hint when `npm install -g` fails with `EACCES`.
  - A first-launch banner nudges users to install when the binary is missing; dismissal is permanent (per-browser localStorage).
  - Fixed scheduled **Database Backup** automations whose persisted command was `fn backup --create` — those failed every run on hosts where the global bin was never linked. A new schema migration (v58) rewrites legacy `fn`/`kb`/`fusion` backup commands to `npx runfusion.ai backup --create`, matching the canonical seed in `syncBackupAutomation`.
  - Added `detectFnBinary()` to `@fusion/core` so server-side code can resolve the right invocation prefix (`fn` > `fusion` > `npx -y runfusion.ai`) without baking a binary name into automations or generated commands.

- 1634ea3: Ship Droid CLI provider integration in the published Fusion CLI bundle by vendoring `@fusion/droid-cli` runtime extension files, so users can enable **Factory AI — via Droid CLI** from dashboard authentication once the `droid` binary is installed and authenticated locally.
- 4231c4a: Split the Star-on-GitHub toggle, CLI Binary panel, and update-check controls into a new **Global → General** settings pane (with an inline **Updates** subsection), separate from the project-scoped Project → General pane. All three are global by nature, and grouping them under Global avoids the impression that they apply only to the active project. The standalone Global → Updates entry has been folded into this pane.

  The CLI Binary panel also drops its own outlined card background and adopts the standard `padding: 0 var(--space-xl)` indent every other top-level child of `.settings-content` uses, so it sits flush with adjacent form groups instead of bleeding to the pane edges.

  Wire `--version` / `-v` in the `fn` / `fusion` bin so it prints the package version and exits before falling through to the default `dashboard` command. Without this, the dashboard's CLI Binary panel reported the installed version as "unknown" because its `<bin> --version` probe was booting the full server instead of getting a version string.

### Patch Changes

- f0d0f8c: Fix two issues with question display in planning mode:

  - Questions sometimes stayed hidden behind the "thinking" view until the panel was closed and reopened. The live SSE `question` event could be missed (e.g. when the tab was throttled), and the only path that promoted the view was the live event. Add an 8s polling fallback that refetches the session while the view is in the `loading` state and transitions to `question`/`summary` if the server has already moved on, so a dropped event self-heals.
  - Clicking "New Session" and then typing into the textarea jumped the panel back to the previous session's questions. The "resume on open" effect listed `loadSession` in its deps; `loadSession` is recreated whenever `connectToPlanningStream` changes, and the latter depends on `initialPlan`, so each keystroke re-ran the resume effect and reloaded the dismissed session. Track dismissed `resumeSessionId`s in a ref and drop `loadSession` from the effect's deps. Also guard the SSE `onThinking`/`onQuestion`/`onSummary` handlers against late events from a stale connection so they can't overwrite the new session's view.

- 5398bc7: Fixes and a new appearance setting for the AI session notification banner and planning mode UI:

  - Planning mode question list no longer has its own inner scrollbar nested inside the right pane's scrollbar. The inner `.planning-options` `max-height: 40vh` constraint was removed so longer question lists expand naturally and the outer pane handles all scrolling.
  - After a page refresh, the "AI sessions need your input" banner briefly displayed the real session title and then flipped to the literal default "Planning session". `PlanningModeModal` was broadcasting the fallback title via the cross-tab sync channel before `initialPlan` had hydrated on a resumed session, overwriting the API title. The broadcast now omits the title field when no real title is known, so the API title is preserved.
  - Banner dismissals are now persisted to `localStorage` keyed by session `updatedAt`. A dismissed entry stays hidden across refreshes until the session advances (a new question/event arrives), at which point the dismissal is auto-pruned and the banner re-appears.
  - Added a Settings → Appearance toggle to hide the AI session notification banner entirely.

- 80b45d0: Fix per-agent filesystem defaults to use display-name-plus-id directories (for example `ceo-agent2736`) for heartbeat procedure files and managed instruction bundles, while preserving compatibility with legacy id-only and previously created display-name-based paths. Existing agent files are reused in place and are not auto-renamed or deleted during upgrades.
- fd36fbd: Fix heartbeat run prompt composition so manual and automatic runs consistently include agent identity/instructions context and autonomous heartbeat framing for both task-scoped and no-task execution.
- 8b7f20f: Clarify and harden cross-node mesh lifecycle ownership in node startup paths. Peer exchange shutdown is now deterministic (idempotent and waits for in-flight sync), and docs/tests now codify that mesh discovery + peer exchange are owned by `fn serve`/`fn dashboard` process lifecycle rather than per-project runtime startup.
- c08a872: Apply task priority across all Fusion scheduling paths so urgent work overtakes older low-priority work — including the merge queue, which previously merged tasks strictly FIFO.

  - The auto-merge queue now picks the highest-priority eligible task each iteration (`urgent → high → normal → low`, then `createdAt` ASC, then id ASC). Manual `onMerge` resolvers still run before auto-merges so awaited callers aren't starved.
  - Startup, periodic, global-unpause, and engine-unpause sweeps now sort their `listTasks` result by priority before enqueueing, so the first task picked up by `drainMergeQueue`'s single-item fast path is the highest-priority eligible one rather than the oldest. All four sweeps share a new `enqueueEligibleInReviewTasks` helper.
  - Hardened the picker against concurrent queue mutation: it now re-locates the chosen task via `indexOf` after awaiting `getTask`, so a `stop()` clear or pause-handler removal that lands during the await can't splice out the wrong sibling. Drain and picker both re-check `shuttingDown` after the awaits to avoid starting a merge whose queue entry was already cleared.
  - Triage and todo→in-progress scheduling already used the shared `sortTasksByPriorityThenAgeAndId` comparator and continue to apply dependency, overlap, and worktree constraints after the priority sort.

- 0188da7: Raise the per-IP planning session rate limit from 5/hour to 1000/hour. The previous cap was tripping for normal interactive usage during a single session.
- 4d70a9e: Always reload the selected planning session into the right pane when the planning screen is shown. Previously the reload was skipped if an SSE stream was still connected, so a stream that survived close (or one re-established before the reload effect ran) could leave the right view divergent from the sidebar selection. `loadSession` already tears down and reconnects the stream, so the guard was unnecessary; dropping it makes close+reopen — and any other show transition — deterministically refresh the detail view from the server.
- e72eff4: Fix `PATCH /tasks/:id` silently dropping task priority updates. The route handler in the dashboard server was destructuring every editable field from the request body except `priority`, so changing a task's priority via the dashboard task-detail modal had no effect on disk. The handler now accepts `priority`, validates it against the allowed values (`urgent`, `high`, `normal`, `low`) — `null` resets to the default — and forwards it to `store.updateTask`. Combined with the priority-aware merge queue and sweep ordering shipped earlier, dashboard priority changes now actually shift triage, scheduling, and merge order.
- 72ed143: Fix the dashboard usage indicator popup so the footer (Last updated timestamp, Refresh, and Close buttons) is always visible, and make the popup resizable with the size persisted across sessions.

  - Changed the modal/popover to a flex column so the scrollable provider list can shrink while the header and action footer stay pinned. Previously the inner content used `max-height: 60vh` while the popover wrapper capped at 70vh with `overflow: hidden`, which pushed the footer below the visible area on shorter viewports or when many providers were configured.
  - Added native `resize: both` to the desktop popover and modal variants, with sensible min sizes. The popover now anchors via `left` (computed from the trigger button's right edge) instead of `right`, so dragging the bottom-right resize handle behaves as expected.
  - Persist the user's chosen width/height per project in `localStorage` under a new `kb-usage-modal-size` scoped key (debounced via `ResizeObserver`). The saved size is reapplied on next open.

## 0.13.0

### Minor Changes

- d18e411: Add Droid CLI provider integration: new auth and status routes (`GET /api/providers/droid-cli/status`, `POST /api/auth/droid-cli`) plus a Settings toggle hook for enabling Droid CLI–based authentication. Wired into the onboarding provider card so users can connect Droid CLI from the same flow as the other providers.
- d18e411: Add an experimental agent onboarding modal that streamlines the handoff from first-run onboarding into the create-agent form, so new users land on a configured agent draft instead of an empty Settings page. Backed by lifecycle tests and gated behind the experimental flag documented in the onboarding docs.
- 56210e0: Planning sidebar now lists every saved planning session, not just active ones, so a session that finishes while the modal is closed remains selectable on refresh — previously the `/api/ai-sessions` listing filtered out `complete` rows and they vanished from the UI even though the result was still in SQLite. Adds the ability to archive and unarchive completed (or errored) planning sessions: a per-row archive button hides terminal sessions from the sidebar, and a "Show archived" toggle reveals them for unarchive. Backed by a new `ai_sessions.archived` column (migration 57), `POST /api/ai-sessions/:id/archive` and `/unarchive` endpoints (only terminal sessions are archivable so live agents can't be orphaned), and `?includeCompleted` / `?includeArchived` query flags on `GET /api/ai-sessions`. Existing consumers (`useBackgroundSessions`, `MissionManager`) are unchanged — they continue to see only active/retryable sessions.

### Patch Changes

- d18e411: Fix two related CLI-session issues that caused resumed sessions to balloon in size and quick chat to lose continuity:

  - Resumed pi-claude-cli and droid-cli sessions were re-sending the entire conversation transcript over stdin every iteration. `buildResumePrompt` anchored on the last user message and walked forward through preceding tool results, but the only user message stayed at index 0, so each turn duplicated the original query plus a growing stack of tool results into the on-disk session. Anchor on the last assistant message and slice forward instead, so only the genuine delta since the previous turn is sent.
  - Quick chat created a fresh CLI session per user message and faked continuity by stuffing the last 50 messages into the prompt as a "## Previous Conversation" block. Replace that with real session continuity: `chat_sessions` gains a `cliSessionFile` column (migration 56) and ChatManager now reuses the existing pi SessionManager file when present, creating a fresh one on the first turn and persisting its path. The prompt now carries only the new user content.

- 7011831: Replace dashboard runtime dynamic `@fusion/engine` imports with bundler-safe static imports and add regression coverage to prevent reintroduction. This avoids npm-installed runtime failures caused by non-static engine imports that cannot be safely inlined during bundling.

## 0.12.0

### Minor Changes

- cf0ea34: Add a new `fn research` command group for managing research runs from the CLI, including create, list, show, export, cancel, and retry flows with JSON-friendly output options.

### Patch Changes

- bdf91f8: Fix mobile chat view layout when the iOS keyboard is up so the message input stays anchored above the keyboard instead of being pushed to the top of the screen.
- 23134cf: Keep mobile chat composer focused when tapping Send so the keyboard stays open and messages send on the first tap.
- 72dffe4: Fix Quick Chat mobile send button so the first tap while keyboard is open sends the message instead of only dismissing the keyboard.
- 41e5458: Keep the mobile keyboard open in Quick Chat after tapping send so users can continue typing without an extra tap.
- 7f55dde: Preserve Quick Chat input focus on mobile send taps so the keyboard stays open.
- a16ca0a: Seal readonly AI agent sessions so summarizers (title, merge subject, merge body, merge summary) cannot reach host-injected `fn_*` mutation tools or caller-supplied custom tools. Harden all four summarizer system prompts with explicit "do not call tools / treat input as content" framing, wrap the title prompt in a `<description>` delimiter, and sanitize the AI response (strip chatty preambles, markdown emphasis, surrounding quotes, trailing punctuation) before returning. Prevents a class of incidents where the title summarizer would call `fn_task_create` mid-summary and store its chat-style reply as the title.
- ecabab8: Show task provenance as "Created by <agent name>" for agent-created tasks and make the agent name clickable to open the agent detail modal.

## 0.11.0

### Minor Changes

- 28e6819: Add first-class Research configuration and readiness workflows across settings and dashboard surfaces. This introduces scoped Research defaults/overrides, exposes Research in experimental feature toggles, and routes missing-provider/missing-credentials setup through existing Settings and Authentication flows while keeping API keys in auth storage.

### Patch Changes

- 97bb80e: Fix backup routine sync failures on legacy SQLite databases by backfilling missing `routines` columns (including `agentId`) during database initialization. Auto-backup settings now create/update the `Database Backup` routine without logging `table routines has no column named agentId` on upgraded installs.
- 451c6d8: Add read-only `fn_insight_*` pi extension tools so agents can list and inspect persisted insights and recent insight-generation runs directly from the project `InsightStore`.
- 3443aed: Ship a bundled Nerd Font symbols fallback for the dashboard terminal so patched glyphs render even when users do not have a local Nerd Font installed. The dashboard now preloads `/fonts/SymbolsNerdFontMono-Regular.ttf`, applies it first in the xterm font stack, and includes build-output regression checks for the bundled font artifact and preload reference.
- d7fdff4: Move `experimentalFeatures` and `remoteAccess` from project-scoped settings to global-scoped settings, including settings schema/type updates, save-path migration, dashboard routes/UI, and regression coverage updates.
- 13ed470: Fix the mobile QuickChat panel layout when the iOS keyboard opens. The panel now stays anchored to the visible viewport (no off-screen drift on a refocus after the keyboard was dismissed), the soft keyboard reliably comes up the moment the FAB is tapped (a stealth input claims focus inside the user gesture so iOS opens the keyboard even before the real composer is enabled), the panel snaps back to full height immediately on blur instead of trailing the keyboard slide-down, and the model name in the header pill collapses to a provider icon when it would otherwise overflow.
- 40620a9: Keep the terminal modal header on a single row on mobile. The tab bar now flexes to fill remaining width and stays scrollable, while the action cluster pins to the right edge of the same row instead of stacking onto a second row.

## 0.10.0

### Minor Changes

- 3218c05: Add support for custom OpenAI-compatible and Anthropic-compatible API providers. Users can add, edit, and remove custom providers from Settings → Authentication or during model onboarding, with automatic ModelRegistry registration and live updates without restart.
- 3fcf5f4: Detect pre-existing Tailscale funnel sessions in Remote Access settings, surface external tunnel status in `/api/remote/status`, and add a kill-external tunnel endpoint plus Settings UI actions to adopt or restart cleanly.

### Patch Changes

- f7df0d4: Improve mobile keyboard overlap detection so chat layout resizes reliably (including smaller iOS viewport shifts) without pushing fixed app chrome.
- 21402a3: Fix vitest test-harness regressions that masked correct production code as failing tests:

  - Restore `util.promisify(exec)`/`util.promisify(execFile)` to resolve with `{stdout, stderr}` inside the test child-process guard. The previous wrapper dropped the `[util.promisify.custom]` symbol, so awaited `execAsync` resolved to a raw stdout string and broke any test or runtime path that destructured the result (cli `init` git commit flow, core git-remote project-name detection, engine cron-runner / restart / worktree-pool clusters, etc.).
  - Allow cheap CLI introspection invocations (`--version`, `--help`, `which …`) through the AI-CLI block so the dashboard's claude availability probe can tell the truth about the local system. Session-launching invocations (e.g. `claude -p …`, `droid chat`) still throw.
  - Give SIGTERM'd subprocesses a short grace period in the per-test guard's `afterEach` before flagging them as "left running", fixing a race where production code that correctly killed the child was reported as leaking it.
  - Add a test-only `__registerMissionInterviewSessionForTest` helper so SSE replay/buffer tests can exercise the stream manager without spinning up a real AI agent.
  - Fix executor mock to simulate real step-transition semantics (forward moves persist; in-progress regressions on done/skipped steps get rejected) so the new `persistedStatus`-aware response text in `fn_task_update` is exercised correctly.
  - Fix the iOS last-resort path test in `useMobileKeyboard` to actually reach the `gap < 16 && viewportShrink ≥ 16` branch by setting `vv.offsetTop > 0`.
  - Convert `await import("../server.js")` in 14 dashboard route tests to static imports so first-test latency in those files drops from ~2–5s to <200ms.

- 98c3c22: Stop wiping accumulated step progress and the worktree pointer on internal task bounces. Workflow-step REVISE retries, pause→todo handoffs, and the context-overflow fresh-session requeue all moved tasks back to `todo` before returning to `in-progress`, and the default reopen-to-todo path was resetting every step to `pending` and rewriting PROMPT.md checkboxes — so each retry restarted the agent from step 0 even though earlier steps were already done. `moveTask` now accepts a `preserveResumeState` flag that the executor sets on those internal hops; user-initiated "move back to todo" still gets the clean-slate behavior. The context-overflow path additionally clears `sessionFile` synchronously so the next dispatch can no longer reopen the saturated session. `fn_task_update` no longer silently regresses a `done`/`skipped` step to `in-progress`, no longer captures a stale rewind checkpoint when it does, and tells the agent honestly when a regression is ignored. Mobile chat keyboard handling now keeps the layout adjusted on iOS even when the visual-viewport overlap reads as zero (focused input + viewport shrink).
- 491097c: Prefer a Nerd Font-capable monospace stack in the dashboard interactive terminal so powerline/private-use glyphs render correctly when patched fonts are installed, while preserving existing fallback monospace behavior.
- f118606: Stop blocking the Node event loop on every chat send. The pi-claude-cli extension factory used to run two `execSync` probes (`claude --version`, `claude auth status`) on every `createFnAgent` call, which Fusion invokes per chat message — so each send froze every other dashboard API for a few seconds while the Claude CLI cold-started. Probes now run async via `spawn` and are memoized to once per process.

## 0.9.4

### Patch Changes

- 299b66e: Fix InProcessRuntime creating a nested `.fusion/.fusion/fusion.db`. RoutineStore was being constructed with the project's `.fusion` directory, but its constructor appends `.fusion` internally. Pass the project root instead, matching AutomationStore.
- c3c8007: Add ghost-review fallback recovery to the self-healing maintenance loop. Catches any `in-review` task that fell through every more-specific recovery scan and has been idle past `taskStuckTimeoutMs`, kicks it back to `todo` with transient status cleared. Preserves human-handoff (`awaiting-user-review`, `awaiting-approval`) and active-merge (`merging`, `merging-pr`) statuses; rate-limited naturally by `updatedAt` refresh so a re-stuck task can only be kicked once per timeout window.
- 24e142d: Merge commits now get an AI-generated summary subject describing what changed (e.g. `feat(FN-XXXX): add user-invited webhook handler`) instead of the bare `feat(FN-XXXX): merge fusion/fn-XXXX`. The merger calls the existing `summarizeCommitSubject` lane alongside the body summarizer; on failure or when disabled, falls back to the legacy `merge <branch>` form.

  Default for `useAiMergeCommitSummary` is now `true` (was `false`). Existing projects that haven't explicitly set the flag will pick up the new behavior on next start. The Settings UI already exposes the toggle.

## 0.9.3

### Patch Changes

- bb9b0f1: Preserve in-progress card timers and stats across internal workflow rerun bounces.

## 0.9.2

### Minor Changes

- 9e5ac3c: Add an optional `useAiMergeCommitSummary` project setting that enables AI-generated merge commit summaries using the title summarizer model lane, with deterministic fallback when disabled or unavailable.
- 19cdf7f: Add dashboard support for managing custom OpenAI/Anthropic/Google-compatible providers via Settings and onboarding advanced sections, backed by new custom-provider API routes and models.json persistence.
- 7eec105: Heartbeat prompts now re-anchor every tick on a Wake Delta + Heartbeat Procedure (paperclip-parity) so permanent agents stop silently grinding on prior tasks. Each tick the agent receives a structured wake delta (source, wake reason, assigned task, pending messages, triggering comments) and re-runs a 7-step procedure (identity → inbox → wake delta → assignment review → pick action → persist → exit) before continuing prior work.

  The procedure is overridable per agent via a new `heartbeatProcedurePath` field pointing at a project-relative markdown file; the file is reloaded fresh each tick so operators can edit it live without restarting agents. New non-ephemeral agents default to `.fusion/HEARTBEAT.md`, and existing agents can be backfilled onto that path via `POST /api/agents/:id/upgrade-heartbeat-procedure` (also surfaced as an "Upgrade to Default Heartbeat Procedure" button in the agent detail Config tab). The default file is seeded from the built-in template on first use; subsequent edits are preserved.

### Patch Changes

- 6c051b1: Fix the update notification release notes link so it points to the repo changelog.
- 64b5f67: Register custom providers from global settings with the pi ModelRegistry at startup, so they appear as available models without restart.
- cfc8aa3: Fix TUI header overflow when a remote tunnel is configured. Between 100 and 175 columns the remote URL was pushing the left edge (logo + tabs) offscreen; the remote info now lives in a flex-shrinkable, right-justified slot that truncates instead of overflowing. Also gives the QR overlay a solid background so it no longer renders transparent over the underlying TUI.

## 0.9.1

### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- 7e832bb: Clear stale agent task links when tasks become terminal or are deleted, fall back to no-task heartbeat instruction runs for archived assignments, and expand built-in agent prompts with explicit heartbeat guidance.
- 118a03a: Keep experimental dashboard views off by default until project settings enable them.
- 291e156: Improve the Git Manager diff layout and file path truncation in dashboard modals.
- c6d67b9: Insights view: two-pane layout (categories sidebar + scrollable detail), full insight content (no line-clamp), larger action icons, fixed scrolling, and mobile single-row header.
- d8baa7a: Show tasks created from planning sessions on the board immediately without requiring a refresh.

## 0.9.0

### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- e46f2d4: Add pluggable notification provider system with built-in ntfy and webhook support.
- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- 17a072c: Fix agent heartbeat scheduling so disabled agents stay disabled and active timers are not reset by unrelated agent updates.
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- 9ce811a: Remote access (Tailscale) overhaul: the auth/scan URL now uses the live `https://<machine>.<tailnet>.ts.net/` URL captured from `tailscale funnel` instead of a constructed `http://<hostname>:<port>` from a configured label, so QR codes lead to a working public endpoint. The hostname label is no longer required (engine validation and the Settings UI both dropped it; `tailscale funnel` never used it). QR codes are now rendered with the `qrcode` library — previously the SVG was just the URL drawn as text — and a new `format=terminal` returns ASCII QR for the TUI. The Tailscale readiness parser now waits for the line containing the URL before flipping to `running`, fixing missing-URL captures. Dashboard polls remote status while `starting`/`stopping` so state updates without reopening the modal. The TUI shows a global `● tunnel` indicator with URL in the header when running, and `Ctrl+Q` opens an ASCII QR overlay anywhere in the app.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

## 0.8.4

### Patch Changes

- 1c4c08b: Verify and tighten npm bundle fixes from FN-2897: keep the vendored pi-claude-cli runtime on Node built-in child_process APIs (no cross-spawn dependency), confirm Claude CLI extension resolution works from the published dist/pi-claude-cli layout, and ensure prepack strips private @fusion/\* workspace devDependencies from the published package manifest.
- 3202e57: Fix SQLite project and central database validation so dashboard and desktop startup handle corrupt database files more predictably.
- 858e244: Fix the TUI startup update notice to use the same version source and cached update gating as the rest of the CLI.
- 995165e: Fix the dashboard version label so it matches the version used by update notifications.
- bd14cf8: Fix Windows path handling for worktree detection and home-directory lookups.
- 995165e: Fix worktree creation failure when git reports "already checked out at" instead of "already used by worktree at"
- 10d565e: Fix OAuth login redirect for non-localhost dashboard access (Tailscale, Cloudflare, LAN).

## 0.8.3

## 0.8.2

### Patch Changes

- 531b13e: Recover automatically from SQLite FTS5 corruption errors during task upserts by rebuilding the `tasks_fts` index and retrying once. Also adds FTS5 index rebuild/integrity helpers in core database code and extends task store health checks to validate FTS5 integrity.
- 531b13e: Add executor watchdogs to recover stuck `fn_task_done` and workflow rerun handoffs faster.

## 0.8.1

### Patch Changes

- a8dbdbc: Include linked GitHub issue references (`Ref: owner/repo#N`) in executor and merger commit message instructions and merger fallback commits when tasks are sourced from GitHub issues.

## 0.8.0

### Minor Changes

- 58510e1: Add CLI support for multi-node routing: configure project default node (`fn settings set defaultNodeId`), unavailable-node policy (`fn settings set unavailableNodePolicy`), per-task node overrides (`fn task set-node`, `fn task clear-node`), and `--node` flag for `fn task create`.
- 81c6f01: Add node routing policy enforcement: when a task is routed to a node that is offline or unhealthy, the project's `unavailableNodePolicy` setting controls whether execution is blocked (task stays in todo) or falls back to local execution. Supports `defaultNodeId` project setting for pinned default nodes and per-task `nodeId` overrides. Routing decisions are logged to task activity for visibility.
- c9241d8: Add pluggable notification provider system with built-in ntfy and webhook support.
- 22bac2d: Refactor merge conflict strategies into two `smart-*` flavors and change the default to "prefer main".

  Both smart strategies now run a best-effort `git fetch` + fast-forward of local main from `origin` before the merge cascade — a freshly-pushed sibling commit no longer gets clobbered when the fallback resolves a conflict against a stale base. They differ only in the per-file final fallback:

  - **`smart-prefer-main`** (new default): `-X ours` — main wins. Best when concurrent agents could regress just-merged sibling work.
  - **`smart-prefer-branch`**: `-X theirs` — task branch wins. Equivalent to the previous `"smart"` behavior.

  Legacy enum values are accepted for backwards compatibility and normalized at load time: `"smart"` → `"smart-prefer-branch"`, `"prefer-main"` → `"smart-prefer-main"`. Settings on disk continue to work without changes.

### Patch Changes

- f19ecac: Add dedicated POST /api/memory/dream endpoint and triggerMemoryDreams() client helper for manual dream processing.
- cc9181d: Recover automatically from SQLite FTS5 corruption during task upserts by rebuilding the `tasks_fts` index and retrying once, and add FTS5 integrity checks to database health monitoring.
- 5cc7597: Fix npm bundle reliability for the published CLI package by removing the vendored pi-claude-cli `cross-spawn` runtime dependency, validating bundled pi-claude-cli resolution from `dist/`, and preventing private `@fusion/*` workspace dev dependencies from leaking into the packed manifest.
- 2029968: Fix project-level model overrides so they take precedence over the default model fallback consistently across dashboard and engine AI flows.
- cd03c6a: Add runfusion.ai links to dashboard update-available notices in the banner and settings modal.
- 7227b87: Add a retry button to failed task error boxes on dashboard task cards so users can retry directly from the card without opening task details.
- 198f85c: Fix dashboard onboarding: the "Welcome to Fusion" setup wizard is now scrollable on short viewports (older laptops / browsers without `dvh` support), and the model-onboarding modal reliably opens after the wizard closes on a fresh install instead of racing it or being suppressed.

## 0.7.1

### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

## 0.7.0

### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### Patch Changes

- ec09282: Add dashboard vitest process controls with a new `POST /api/kill-vitest` endpoint and System Stats modal UI for manual kills plus auto-kill settings management.
- 92b8631: Fix automation execution pipeline reliability by improving ProjectEngine automation startup diagnostics and health visibility, adding due-schedule regression coverage, and fixing manual automation runs to execute ai-prompt and create-task steps (including continueOnFailure handling) instead of command-only behavior.
- 8fbd3bd: Fix plugin-install loader taskStore compatibility by ensuring CLI plugin install paths are covered with regression tests for `getRootDir` expectations.
- 347cae8: Load enabled plugins during dashboard, serve, and daemon startup so plugin runtimes are available to agent runtime selection immediately after boot.
- 0a5dcf1: Fix `/api/system-stats` so process/system metrics still return when project resolution fails, with task and agent aggregates gracefully falling back to zero counts.
- 3c8a490: Fix `fn plugin install` failing in CLI plugin commands by adding `getRootDir()` to the mock TaskStore used by `createPluginLoader`.
- 637f435: Fix pi-claude-cli planning hangs by simplifying custom MCP tool guidance to direct `mcp__custom-tools__*` calls (no `ToolSearch` prerequisite), aligning custom-tool handling diagnostics, and adding regression coverage for `ls`/triage MCP tool mapping behavior.
- 7691bab: Respect globalPause/enginePaused in heartbeat trigger scheduler and monitor to prevent agents from running when the engine is paused at startup.

## 0.6.0

### Minor Changes

- f4d98ed: Add a `--git` flag to `fn init` to auto-initialize a git repository (including an initial commit) when the target directory is not already a git repo.
- 6caab17: Add project settings to auto-comment on imported GitHub issues when tasks move to done, plus dashboard GitHub integration support for posting issue comments.
- fdf8ca9: Reframe the CLI splash to "multi node agent orchestrator" with `runfusion.ai` and the current version, and surface the version alongside URL/host/auth/uptime in the dashboard System panel and status bar.

## 0.5.0

### Minor Changes

- b969635: v0.5.0: status terminology refresh (planning/replan), Reviewer rename, in-review pause behavior, dashboard-tui resize hardening, dev-server experimental toggle fix, and version reporting fix.

### Patch Changes

- 112ad67: Fix experimental feature save normalization so disabling Dev Server clears the legacy `devServer` alias (`null` delete) alongside canonical `devServerView`, preventing stale nav visibility after save.
- 16ec204: Fix dashboard health/version reporting to read the version from package.json instead of relying on npm_package_version with a stale hardcoded fallback.
- 79ce48c: Fix pausing behavior for in-review tasks so stop fully halts merge activity. Paused in-review tasks are now marked with paused status, removed from merge queues, active merge sessions are aborted/disposed, self-healing recovery skips paused tasks, and unpausing re-enqueues eligible review tasks for auto-merge.
- c85ffa9: Rename status values: specifying→planning, needs-respecify→needs-replan. Display label "Triage"→"Planning". Includes DB migration for existing records.
- 03a48ae: Update dashboard and CLI status strings: specifying→planning, needs-respecify→needs-replan. Update user-facing text from "triage/specify" terminology to "planning/replan" terminology.
- c1b0121: Rename "Validator" to "Reviewer" across all dashboard UI labels and descriptions.

## 0.4.1

### Patch Changes

- b5200ba: Add Cloudflare Quick Tunnel mode for Remote Access so Fusion can auto-provision an ephemeral `trycloudflare.com` URL via `cloudflared tunnel --url` without requiring a pre-created named tunnel or tunnel token.
- 8097db2: Rename status values: specifying→planning, needs-respecify→needs-replan. Display label "Triage"→"Planning". Includes DB migration for existing records.

## 0.4.0

### Minor Changes

- 9d8852e: Add project-level overlap ignore paths so teams can exempt safe shared files/directories from overlap-based task serialization while keeping overlap protection enabled for the rest of the repo.

### Patch Changes

- f560af5: Fix dashboard TUI agents view run history rendering to use readable status labels and allow opening selected run logs reliably.
- cd4cef3: Fix dashboard TUI agent run-log opening so Enter key presses sent as carriage-return/newline characters are recognized reliably.
- 7e05a20: Speed up `fn init` project-name detection by skipping git remote lookup when the target directory is not a git repository. This avoids unnecessary subprocess work and reduces timeout risk in test/CI environments.
- c818d71: Inset plugin manager cards from the modal edges on mobile. The plugins subsection panel had no horizontal padding while its heading and toggle were already inset, leaving cards flush with the modal frame on small screens.
- c818d71: Fix triage hangs when using pi-claude-cli with claude-sonnet-4-6. Parameterless custom tools (e.g. `fn_review_spec`) emit zero `input_json_delta` events from the Claude CLI, so the event bridge previously fell through to a raw empty-string fallback and pi's TypeBox validator rejected the call with "root: must be object" — looping the agent indefinitely. Defaults empty `partialJson` to `{}`. Also adds a reminder loop before the planning fallback model engages, propagates the bundled `@runfusion/fusion` extension into engine sessions so `fn_*` tools register without `pi install`, and drops the "historical" qualifier from replayed tool labels that was confusing models into treating their own prior turns as a previous session.
- ff6a68b: Fix Skills Catalog initial-load failures by preventing unauthenticated public search requests for empty or too-short queries. The dashboard now returns a successful empty catalog result for short-query unauthenticated/fallback states instead of surfacing upstream 400 errors.
- 1b3994f: Fix the dashboard terminal modal desktop width contract so large displays use a broad viewport-based layout, and harden terminal input lifecycle handling so xterm keyboard input continues forwarding reliably after rerenders.
- 1a8058f: Make agent pause/resume state transitions act immediately by stopping active heartbeat runs on pause and triggering an on-demand heartbeat on resume.
- 39622f0: Fix scheduled automations so overdue runs catch up reliably after server downtime. Startup/settings sync no longer pushes unchanged overdue schedules into the future, and memory dreams automation is now synchronized during engine startup before cron begins ticking.
- 26f9c74: Synchronize Fusion skill documentation from `extension.ts` across `SKILL.md`, `references/extension-tools.md`, and `references/fusion-capabilities.md`, and document engine session-scoped runtime tools in a new `references/engine-tools.md` reference.

## Unreleased

### Patch Changes

- FN-2501: Agent pause/resume controls now act immediately. Pausing stops an active heartbeat run right away, and resuming to `active` triggers an immediate on-demand heartbeat instead of waiting for the next timer tick.

## 0.2.7

### Patch Changes

- adbad8a: Add `fn plugin add` as a backward-compatible alias for `fn plugin install`, and update plugin command help text to advertise the alias while keeping `install` as the canonical command.

## 0.2.6

### Patch Changes

- dbc9446: Add a blocking dashboard token-recovery dialog that appears only for daemon bearer-token 401 responses, with set-token or clear-token recovery actions that reload the app.

## 0.2.5

### Patch Changes

- 69f789f: TUI: layered defenses for the resize / wrong-height-layout bug

  Materially reduces (but doesn't fully eliminate) the symptom of the header rendering off-screen or the layout taking 1-2 too many rows, especially under tmux/ssh.

  - Enter alternate-screen buffer on start; leave on stop. The TUI gets a dedicated fullscreen surface that doesn't share scrollback.
  - StatusBar Text children no longer wrap (default `wrap="wrap"` was letting long hotkey + URL strings wrap to 2 rows, throwing the row budget off by 1).
  - Controller subscribes to `process.stdout` "resize" and calls `inkInstance.clear()` to reset log-update's frame tracking.
  - App-level resize listener + key-based remount on dimension change so React rebuilds the tree from scratch with fresh bounds.
  - Root Box gets explicit width + overflow="hidden"; MainHeader outer Box too.
  - Settings + Utilities side-by-side now stretch to equal heights (UtilitiesPanel switched from `flexShrink={0}` to `flexGrow={1}`).

## 0.2.4

### Patch Changes

- 88b4ecb: TUI fixes: help overlay no longer crashes, header stays rendered

  - Help overlay (`?` / `h`) crashed with "Encountered two children with the same key" because several shortcut entries share the same display key (`[t]` for Git view AND for Toggle engine pause; `[r]` for Refresh stats AND Refresh agent detail). Switch to index-based keys — each row is unique by position, not by character.
  - Refresh the help text to reflect the unified header (`[m]` Main, `[b/a/g/t/e]` views), the Settings/Files/Agents `←/→` pane swap, the Git push/fetch shortcuts, the Files hidden-files toggle, and the Logs `G` jump-to-end.
  - Main view (status mode) header sometimes vanished after a tmux pane switch and stayed missing until a terminal resize. Two fixes: (a) drop the `rows < 10` auto-hide in `MainHeader` — tmux pane switches can briefly report stale or zero dimensions, and a transient `return null` was orphaning the header. (b) Wrap `MainHeader` and `StatusBar` in `flexShrink={0}` boxes inside `StatusModeGrid` and `StatusModeSingle` (matching the prior fix in `InteractiveMode`), so Yoga can't squeeze them to 0 rows when content pressures the row budget.

## 0.2.3

### Patch Changes

- 0f070d8: TUI header redesign and Settings ←/→ pane navigation

  - Replace the dual section + interactive tab strips with a single unified strip: `[m] Main  [b] Board  [a] Agents  [g] Settings  [t] Git  [e] Explorer`. Status mode highlights the Main pill; interactive views highlight their own. Number-key shortcuts (1–5) for status sections still work but are no longer rendered in the header chrome.
  - Width tiers now fit comfortably at every terminal size: full labels at cols ≥ 90, glyph-only at 50–89 (every shortcut still visible), FUSION + active pill only below 50. Help/quit shows at cols ≥ 110.
  - New `m` shortcut switches to status mode (Main); `s` kept as alias.
  - Settings interactive view: `←` focuses the list pane, `→` focuses the detail pane. `Tab` still cycles either way (consistent with Agents view).

## 0.2.2

### Patch Changes

- 58688fa: Keep the FUSION header from wrapping when the terminal is narrow. The `MiniLogo` and tab pills had Yoga's default `flexShrink: 1`, so the row's collective content overrunning the width was being absorbed by shrinking every child — including FUSION, which then wrapped to two lines. Pin all fixed-content header children to `flexShrink={0}`; the trailing flexGrow filler absorbs slack instead.

## 0.2.1

### Patch Changes

- 07d7bac: Add a blocking dashboard token-recovery dialog that appears only for daemon bearer-token 401 responses, with set-token or clear-token recovery actions that reload the app.

## 0.2.0

### Minor Changes

- a8f5591: Add support for an optional custom ntfy server URL in notification settings, with default fallback to `https://ntfy.sh` when unset.

## 0.1.3

### Patch Changes

- c105cfa: Automatically install the bundled Fusion skill into supported agent home directories during `fn init` (`~/.claude/skills/fusion`, `~/.codex/skills/fusion`, and `~/.gemini/skills/fusion`) when missing. Existing installs are preserved, and per-target filesystem errors now warn without failing project initialization.
- 86521e2: Fix `pnpm install -g @runfusion/fusion` failing with a 404 for `@fusion/pi-claude-cli`. The vendored pi extension is now bundled into the published package's `dist/pi-claude-cli/` and is no longer listed as an external dependency.
- 76961d4: Add a severity filter to the interactive `fn dashboard` TUI Logs tab. Users can now press `f` to cycle `all → info → warn → error` for view-only filtering while preserving the full in-memory ring buffer.
- f77dd9d: Prevent stale dashboard service workers from trapping old client bundles, and compute automation cron schedules against UTC so monthly runs stay on day 1 across timezones.
- f4d2a4b: Fix `fn dashboard` Logs tab row budgeting so log lines stay above the footer hint on short terminals, including wrapped-message cases.
- f77dd9d: Fix dashboard SSE cleanup on browser refresh so stale event streams do not exhaust per-origin browser connections.
- 31f021a: Fix dashboard TUI log severity rendering so structured `logger.log(...)` entries routed via `stderr` display with info severity/icon instead of being misclassified as errors.
- eef56af: Normalize Fusion skill-facing tool naming to the public `fn_*` namespace and clarify the boundary between extension tools and internal engine runtime tools across skill docs.
- 832c32c: Refresh the shipped Fusion skill documentation to match the current `fn_*` extension and CLI surfaces, and replace stale kb-era task/storage examples with Fusion-native `FN-*` and `.fusion` conventions.
- dce70bf: Persist `fn dashboard` bearer tokens in the existing global settings store (`~/.fusion/settings.json`) on first authenticated run, then reuse them on subsequent starts. Explicit overrides (`--token`, `FUSION_DASHBOARD_TOKEN`, `FUSION_DAEMON_TOKEN`) and `--no-auth` precedence remain intact.
- f078a4e: Add a Settings → Pi Extensions action to reinstall Fusion's bundled Pi package (`npm:@runfusion/fusion`) for self-serve recovery when local Pi skill installs are stale or broken.

## 0.1.2

### Patch Changes

- 9bf2981: Add a `planning-awaiting-input` ntfy notification event so users can opt in to alerts when planning sessions pause for user input.
- Fix the CLI init command import path for the Claude skills runner so tsup can resolve it during build.
- 94473c8: Improve dashboard shutdown observability by logging non-fatal diagnostics when `CentralCore.close()` fails during dispose, normal signal shutdown, or dev-mode shutdown cleanup.
- Fix dashboard and serve command plugin store initialization to support task store implementations that expose `getFusionDir()` without `getRootDir()`.
- c01892d: Route dashboard runtime diagnostics through the shared injected runtime logger so TTY sessions can capture server/package logs in the TUI while preserving readable non-TTY startup banner output.

## 0.1.1

### Patch Changes

- 39f7709: Dashboard TUI now surfaces engine log output in the Logs tab. Previously, the engine's `createLogger()` writes (scheduler, executor, triage, merger, PR monitor, heartbeat, etc.) went straight to `console.error` and were rendered beneath the alt-screen TUI — effectively invisible. `DashboardLogSink.captureConsole()` now intercepts `console.log/warn/error` while the TUI is running and routes each line into the ring buffer, parsing a leading `[prefix]` tag so entries carry the subsystem prefix. Originals are restored on TUI shutdown.
- 585e480: Add keyboard navigation and inspection features to the Dashboard TUI Logs tab: arrow keys and j/k to navigate entries, Enter to expand selected entry, Esc to close expanded view, and w to toggle wrap mode for long messages.
- 86fd24e: `fn dashboard` TTY mode now opens on the System tab first so users immediately see host, port, URL, and auth token access details.
- 585e480: Fix dashboard TUI log navigation: add Home/End shortcuts for jumping to first/last log entry, add Space and e keys as alternatives to Enter for expanding logs, improve word wrap to handle long unbroken tokens (URLs, stack traces) by hard-wrapping them at terminal width.
- 7d31b21: Fix iOS terminal typing in the dashboard. On touch-primary devices, tapping the terminal opened the on-screen keyboard but keystrokes were silently dropped because the bubble-phase `handleTerminalGestureFocus` handler re-focused the helper textarea and reset its selection during touchstart/pointerdown, disrupting iOS's input-event attribution. The CSS fix in commit c7266b7f already positions the textarea to receive taps natively, so the JS handler is now a no-op on `(hover: none) and (pointer: coarse)` devices and desktop retains click-to-focus.
- Fix dashboard TUI log viewport row calculation on very small terminals to prevent log lines from overlapping the footer.
- ff5df16: Fix executor model resolution precedence so project `defaultProviderOverride`/`defaultModelIdOverride` is honored before falling back to global `defaultProvider`/`defaultModelId` across execute, hot-swap, and step-session paths.
- df2836c: Fix dashboard TUI log behavior so log navigation can reach all entries still present in the ring buffer and streamed merge output is buffered into log lines instead of writing raw fragments into the interactive terminal UI.
- bbdd11a: Guard SQLite FTS5 usage so Fusion starts cleanly on Node builds whose bundled `node:sqlite` was compiled without FTS5. On affected systems, `fn dashboard` previously crashed on first run with `Error: no such module: fts5` during schema migration. The Database and ArchiveDatabase now probe for FTS5 at startup and skip the virtual table + triggers when unavailable; `TaskStore.searchTasks` and `ArchiveDatabase.search` fall back to LIKE-based scans. Set `FUSION_DISABLE_FTS5=1` to force the fallback on runtimes where FTS5 is present but undesirable.
- 0bb0100: Update dashboard TUI header branding from "fn board" to "fusion" for consistent product naming.

## 0.1.0

### Minor Changes

- 25d44e1: Add interactive TUI to `fn dashboard` with five navigable sections: logs, system, utilities, stats, and settings. Keyboard shortcuts enable quick in-terminal navigation (1-5, arrows, q, Ctrl+C, ? for help). The TUI activates automatically in interactive terminal sessions; non-TTY mode (CI, piped output) retains the existing plain-text banner/log behavior.

### Patch Changes

- a2ed6d0: Fixes for stuck merges and agent lifecycle controls.

  - `findLandedTaskCommit` now falls back to scanning all of `HEAD` when the bounded `baseCommitSha..HEAD` range returns no commits (e.g. baseCommitSha was advanced past the landed merge by a fast-forward rebase). Previously the recovery silently returned null and re-queued the merge even though the commit had already landed.
  - Agent heartbeat triggers and registration are gated by `runtimeConfig.enabled` rather than transient agent state, so paused/idle/error agents stay registered for triggers and re-arm immediately on resume without waiting for a state transition.
  - `AgentDetailView` exposes a Stop control alongside Pause/Retry for `running` and `error` states so operators can terminate stuck agents without going through the agents list.

## 0.0.6

### Patch Changes

- Re-ship three previously reverted fixes and add pre-merge remote rebase.

  - `--no-auth` flag now correctly suppresses bearer-token auth instead of being silently overridden by a stale `FUSION_DAEMON_TOKEN` in the project's `.env`.
  - Workflow-review revisions reopen only the last step rather than resetting every previously-completed step. The agent applies the feedback as an in-place fix and earlier approved work stays done. New `reopenLastStepForRevision` helper is used by `handleWorkflowRevisionRequest`, `handleWorkflowStepFailure`, and `sendTaskBackForFix`. `determineRevisionResetStart` is marked `@deprecated` and kept exported for tests.
  - Heartbeat scheduling is now driven by `agent.state` (`active`/`running` = timer armed; everything else = timer cleared), not `runtimeConfig.enabled`. Resuming a paused agent through the dashboard now re-arms the timer immediately.
  - New setting `worktreeRebaseBeforeMerge` (default `true`) and companion `worktreeRebaseRemote` (default: git's configured default). The merger fetches the remote and rebases the task branch onto the latest default-branch tip before merging; conflicts flow into the existing smart/AI resolve cascade. Dashboard Settings → Worktrees exposes a checkbox and a remote dropdown populated from `/api/git/remotes/detailed`.
  - Last/Next heartbeat labels on the agent list card now share font-size and inline-flex alignment so they line up cleanly.

## 0.0.5

### Patch Changes

- 41553a5: Harden agent lifecycle around closed tasks and heartbeat defaults.

  - `HeartbeatMonitor.executeHeartbeat()` now exits before session creation when the resolved task is done/archived (reason `task_closed`) and clears the stale `agent.taskId` linkage so the guard isn't re-tripped on every tick.
  - `HeartbeatTriggerScheduler.watchAssignments()` skips callback dispatch when the assigned task is already closed (when a `taskStore` is wired in).
  - `POST /api/agents/:id/runs` performs the same preflight check and returns 409 with a structured error naming the task id + column, keeping the existing active-run 409 precedence.
  - `AgentStore.createAgent()` now persists `runtimeConfig.heartbeatIntervalMs` (default 1h) on non-ephemeral agents so the dashboard's freshness signal matches the scheduler's effective cadence instead of depending on whether the user ever opened the heartbeat dropdown. Exports a new `DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS` constant.

## 0.0.4

### Patch Changes

- 0da498a: Fix dashboard onboarding auth token controls, keep the AI planning modal footer visible on desktop, and add better terminal PTY spawn diagnostics.

## 0.0.3

### Patch Changes

- 1fc72d1: Improve the dashboard agents list views with shared empty-state actions, token-based state styling, and clearer board/tree/org-chart presentation.
- 46b8032: Make `fn agent import` import package skills alongside agents when importing from directory or archive sources. Skills are written to `{project}/skills/imported/{company-slug}/{skill-slug}/SKILL.md` with proper frontmatter formatting. Existing skill files are skipped rather than overwritten. Single AGENTS.md file imports do not include package skills.
- c1bc5b9: Fix CLI merge regressions in test/build verification: restore gh-cli test alias resolution, ensure daemon ignores invalid env tokens, and restore required changeset config.
- 06704cf: Fix the setup wizard directory browser and make terminal session startup more resilient.

## 0.0.2

### Patch Changes

- Add `fusion` bin alias so `npx @runfusion/fusion` resolves to the CLI
  (the `fn` command is still available and unchanged).

## 0.0.1

### Initial release

First public release under the `@runfusion` scope. Package was previously
developed under the `@gsxdsm/fusion` name; it was never published to npm,
so version history resets with `0.0.1`. Pre-release notes preserved below
for reference.

---

## 0.4.0 (pre-release, unpublished)

### Minor Changes

- 2d13b82: Add pi extension. Installing `@runfusion/fusion` via `pi install` now provides native tools (`fn_task_create`, `fn_task_list`, `fn_task_show`, `fn_task_attach`, `fn_task_pause`, `fn_task_unpause`) and a `/fn` command to start the dashboard and AI engine from within a pi session.
- 494de14: Changed `autoMerge` to default to `true` for new boards.
- 50821fc: Add global pause button to stop all automated agents and scheduling
- cac10af: Split engine control into Pause (soft) and Stop (hard). The dashboard Header now shows two buttons: "Pause AI engine" stops new work from being dispatched while letting in-flight agents finish gracefully, and "Stop AI engine" (previously the only Pause button) immediately kills all active agent sessions. A new `enginePaused` setting field controls the soft-pause state alongside the existing `globalPause` hard-stop.

### Patch Changes

- d19b51f: Auto-assign random port when dashboard port is already in use instead of crashing with EADDRINUSE.
- ceb379d: Engine pause now terminates active agent sessions (matching global pause behavior) instead of letting them finish gracefully. Tasks are moved back to todo/cleared for clean resume on unpause.
- acb246a: Fix active agent glow disappearing when scheduling is soft-paused
- 43aada5: Fix scheduler to not count in-review worktrees against maxWorktrees limit. In-review tasks are idle (waiting to merge) and no longer block new tasks from starting.
- 9033a79: Fix InlineCreateCard cancelling when clicking dependency dropdown items with empty description.
- 96f1070: Fix double horizontal scrollbar on mobile board view by switching the board from a 5-column grid to a flex layout on narrow viewports (≤768px) with snap-scrolling.
- 3dc741c: Fix auto-pause on rate limit when pi-coding-agent exhausts retries. After `session.prompt()` resolves with exhausted retries, all four agent types (executor, triage, merger, reviewer) now detect the error on `session.state.error` and trigger `UsageLimitPauser` to activate global pause. Previously, rate-limit errors that pi-coding-agent handled internally were silently swallowed, causing tasks to be promoted to wrong columns with incomplete work.
- 2854553: Fix triage allowing tasks to reach executor before spec review approval
- 72a8953: Fix specifying agents not respecting maxConcurrent concurrency limit
- a2a12f9: Persist worktree pool across engine restarts. When `recycleWorktrees` is enabled, idle worktrees are rehydrated from disk on startup instead of being forgotten. When disabled, orphaned worktrees are cleaned up automatically.
- 65b9585: Add priority-based agent scheduling: merge agents are served before execution agents, which are served before specification agents, when competing for concurrency slots.
- 98ed082: Restructure README to lead with pi extension usage; move standalone CLI docs to STANDALONE.md.
- 2d13b82: Agents now declare dependencies when creating multiple related tasks during execution
- 0e0643a: Skip merger agent when squash merge stages nothing (branch already merged via dependency)
- d2e2e50: Make "Pause AI engine" a soft pause: only prevents new agents from starting while allowing currently running agents to finish their work naturally. "Stop AI engine" (global pause) still immediately terminates all active agents.
- 90764b9: Auto-pause engine when API usage limits are detected (rate limits, overloaded, quota exceeded). Prevents wasteful retries across concurrent agents.

## 0.3.1

### Patch Changes

- ae90be0: Bundle workspace packages into CLI for npm publish. The published package previously declared dependencies on private `@kb/core`, `@kb/dashboard`, and `@kb/engine` workspace packages, causing `npm install` to fail. Switched the CLI build from `tsc` to `tsup` (esbuild) to inline all `@kb/*` workspace code into a single bundled `dist/bin.js`, while keeping third-party packages (`express`, `multer`, `@mariozechner/pi-ai`) as external dependencies. Dashboard client assets are now copied into `dist/client/` so the published tarball is fully self-contained.
- 28bbcb9: Exclude Bun-compiled platform binaries from npm publish tarball, reducing package size significantly.

## 0.3.0

### Minor Changes

- fc7582d: Expand agent.log logging to all agent types, additionally capturing thinking, and agent roles
- cc999ef: RETHINK verdicts trigger git reset and conversation rewind, re-prompting the agent with feedback

### Patch Changes

- f3c7f7d: CLI `task create` now supports a `--depends <id>` flag (repeatable) to declare task dependencies at creation time.
- fc7582d: Code review REVISE verdicts are now enforced such that agents can no longer advance steps without APPROVE
- cc999ef: Plan RETHINK triggers conversation rewind with REVISE enforcement on code reviews
- cc999ef: Dependent tasks can start from in-review dependency branches instead of waiting for merge

## 0.2.1

### Patch Changes

- efdb7de: Clean up README: plain ASCII file tree, mermaid workflow diagram with column descriptions, update quick start to use `kb` CLI, add authentication section to CLI README, document cross-model review in executor description.

## 0.2.0

### Minor Changes

- b12d340: Add automated versioning pipeline using changesets. Developers now add changeset files to describe changes, and a CI workflow automatically opens version PRs that bump versions and generate changelogs.
