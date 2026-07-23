# Fusion changelog

User-facing release notes aggregated across all packages. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.

## 0.73.0-beta.3

### Highlights
- Planning Mode is rebuilt as an ongoing interview you validate explicitly — no more automatic checkpoint finalizing a plan for you
- Report screenshots and activity traces are scrubbed of paths and tokens before anything is filed
- Pick your update track: beta or stable release channels, selectable in Settings or via `fn update --channel`
- Boards now move cards through your own custom workflow's columns instead of a fixed six-column set
- Quality hub can show task verification videos and richer review-deliverable galleries when review artifacts are enabled

### New
- Beta and stable update channels, with per-channel update checks
- Boards driven entirely by your workflow's own columns and traits, not a hardcoded set
- Quality hub verification videos and review artifact controls with deliverable galleries
- Mission auto-merge override so a mission's features share one branch and one PR
- Mailbox approval flow for ephemeral agent follow-up tasks
- Guided in-app Bug, Feedback, Idea, and Help reporting, filed to GitHub Issues or Discussions with optional screenshots and dedup against the roadmap
- Persisted ideation sessions with one-click Mission handoff
- Request and observe task E2E verification directly from chat
- Preview missions, findings, evals, goals, and roadmap items inline in chat and Mail
- Photo and file attachments in Quick Add and Main Chat
- Configuration revision history and rollback, now in Settings
- Portable, secret-scrubbed org export/import commands (`fn org-export` / `fn org-import`)
- New Aurora, Calm, and Dawn dashboard color themes, filterable by name
- Embedded PostgreSQL connection cap is now configurable in Advanced Settings
- Unified max concurrency across planning, execution, and review with simplified capacity indicators
- Gesture-only Quick Add Start action for eligible workflows
- Optional Task Chat progress feed for steps, failures, reviews, and rollbacks
- Plugins can now declare their own project MCP servers

### Fixed
- Mobile board swipes/flings now settle reliably on exactly one column
- Planning Mode: resumes correctly after reload, drafts a plan immediately, keeps questions and plan in sync, and works on mobile/tablet
- Dashboard now shows SQLite→PostgreSQL migration status while cutover is in progress
- Orphaned in-review steps from a restart are recovered instead of silently skipped or stranded
- Duplicate follow-up tasks naming the same failing file now converge instead of piling up
- Fixed a crash where chat/mailbox messages containing a raw NUL byte aborted the conversation
- Workflows without a merge step now finish in their completion column instead of stalling
- Custom Merging columns now correctly receive cards at merge time
- Grok and OMP CLI model fallbacks now engage only when actually needed
- Task-card and task-detail icon sizing made consistent across themes and breakpoints
- Board column counts now include Code Review, Plan Review, and other active gate sessions
- Fixed Windows update reliability and restored Compound Engineering personas in npm installs
- Various Chinese-locale translation fixes restored

### Breaking
- Removed the Planning Mode deepening checkpoint and fixed interview depth caps; plans are now validated explicitly by you rather than auto-finalized

### Security
- Scrubbed top-level report activity traces of paths and tokens before filing

### Internal
- Review gates (plan/code/browser) now run exclusively as workflow graph nodes; the in-session step reviewer tool is removed
- Bumped bundled pi runtime to 0.81.1 for newer models, providers, and session reliability

## 0.73.0-beta.2

### Highlights
- Choose your update track: new beta and stable release channels, selectable in Settings or via `fn update --channel`
- Custom workflows finally own the board — cards move through your own columns, not a fixed six
- Security: report screenshots and activity traces are scrubbed of paths and tokens before filing
- Auto-generated task verification videos now show up in the Quality hub when review artifacts are enabled
- Dozens of Planning Mode fixes: reliable resume, scrollable plans, mobile support, and an end to false completions

### New
- Beta and stable release channels with independent update tracking
- Quality hub shows task verification videos when review artifacts are enabled
- Review artifact controls and deliverable galleries for task reviews
- Auto-generated feature-video artifacts captured at task completion
- Guided in-app Bug, Feedback, Idea, and Help reporting, with GitHub Issues or Discussions destinations and roadmap dedup
- Consent-based screenshots and scrubbed activity context attached to in-app reports
- Mission auto-merge override so a mission's features can share one branch and PR
- Mailbox approval flow for ephemeral agent follow-up tasks
- Unified max concurrency across planning, execution, and review with simplified board capacity indicators
- Configuration version history and rollback moved into Settings
- Portable secret-scrubbed organization export/import via `fn org-export` / `fn org-import`
- Ideation is now a top-level experimental view with atomic Mission handoff
- Mission hierarchy tools exposed to engine agents and dashboard chat
- Task E2E verification requests observable from chat
- Promote completed research findings into mission roadmap features
- Native structure previews (missions, findings, evals, goals, roadmap items) in chat and mail
- WhatsApp pairing QR and setup instructions surfaced in plugin settings
- Embeddable PostgreSQL connection cap now configurable in Advanced Settings
- Aurora, Calm, and Dawn dashboard color themes
- Dashboard chat agents can now edit files and run bash with coding workspace tools

### Fixed
- SQLite→PostgreSQL migration status now shown on the dashboard during cutover
- Reconnecting status text removed from Planning Mode
- Approved task scope preserved during review and worktree recovery
- Retried agent steps no longer create duplicate follow-up tasks
- Boards on custom workflows show and move cards in their own columns
- Built-in workflows no longer send cards backward to Todo or stall the PR workflow
- Chat/mailbox crash from raw NUL bytes fixed
- Server Claude CLI login issues reported immediately instead of a false usage timeout
- Codex weekly usage now shown correctly
- Task chat progress feed added for steps, failures, reviews, and rollbacks
- Numerous Planning Mode reliability fixes: persistent timers, clean resume, mobile taps, refinement submission, clarifying questions, plan drafting, and history behavior
- Workflows without a merge step now finish in their completion column
- Tasks with no saved workflow selection can move between columns again
- Dependency-ready workflow steps finalize correctly alongside slower steps
- Task completion no longer blocked by summary wording
- Windows update reliability and Compound Engineering persona restoration in npm installs
- Chinese translations restored for duplicate roadmap reports
- Overseer eye icon visibility fixes across task cards and detail view
- Archived shared-branch landing proof preserved during PostgreSQL promotion
- Task-card cost badge repositioned below Promote button
- GitHub/GitLab issue form auto-translation fixed
- PWAs recover auth tokens after unauthorized backend responses
- Foreign-language issue forms auto-translate correctly
- Token counts no longer inflated by reused agent sessions
- GitHub issue import dedup hardened against edited descriptions
- Dashboard build failure from missing html2canvas dependency fixed
- Settings now auto-save with safe flush on close
- Task detail inline icons and action buttons sized consistently across themes/breakpoints
- Pinned chat conversations separated in list; message edit Save fixed
- Compound Engineering navigation visibility fixed
- Same-agent near-duplicates stay on the board by default
- Report menu stacking and Command Center report placement fixed
- Settings Configuration Versions translations restored for several locales
- `@agentclientprotocol/sdk` install fix for Claude CLI pi extension
- Mission interview start crash fixed for default thinking level
- Startup crash fixed for projects with fallback and registered partition data
- Grok/Claude Fusion MCP bridge packaging and model marker fixes
- Only one agent badge shown when task is assigned to its creator
- CLI chat replies and dashboard inbox reads restored
- `fn chat` now a stable named mailbox conversation
- Workflow tasks stay paused while awaiting operator answers to agent questions
- Mobile navigation and Planning Mode back-navigation fixes
- Dashboard TUI Logs tab timestamp noise reduced
- Duplicate decisions persisted so Fusion doesn't re-ask
- Skill loading, plugin enable-state consistency, and duplicate onLoad fixes
- Workflow-definition ID collision fix on create
- Provider-scoped task pauses now recover automatically when capacity returns
- Mid-flight tasks from older Fusion versions now adopted cleanly on upgrade
- MCP server unavailability no longer stalls tasks
- Merge-review blockers preserved across concurrent-main rebuilds
- Plan Review recovery for missing workflow plans
- Duplicate in-progress GitHub tracking issue notifications eliminated
- Custom Merging column now receives the card at merge instead of In-review
- Mission features resume correctly after engine restart
- Test-mode database isolation from the normal Fusion database
- Anthropic OAuth token rotation no longer causes concurrent task fallback
- Duplicate diagnostic follow-ups deduplicated across parents
- Quick Add agent picker closes on outside click
- In-progress-to-Todo moves now await executor cancellation before persisting
- Plan Review replans no longer strand completed tasks in Triage
- PostgreSQL migration-health read permission errors fixed
- Report screenshots stored as validated local artifacts

### Breaking
- Removed the Planning Mode deepening checkpoint and fixed interview depth caps; explicit user validation now replaces AI-driven completion

### Security
- Report activityTrace payloads are now scrubbed of paths and tokens before filing

### Internal
- Review gates now run exclusively as workflow graph nodes; the in-session step reviewer (`fn_review_step`) and its RETHINK/checkpoint machinery are removed

## 0.73.0-beta.1

### Highlights
- Your workflow now drives the board — cards move through the columns you defined, not a fixed set of six
- New beta and stable update channels: pick your track in Settings or via `fn update --channel`
- Planning Mode rebuilt as a guided interview with a live plan and an explicit Proceed step
- Mission auto-merge override lets a mission's features share one branch and one PR
- Quality hub now shows task verification videos and review deliverable galleries

### New
- Beta and stable release channels — set `updateChannel` in Settings or `fn update --channel <stable|beta>`
- Task chat progress feed narrates steps, failures, reviews, and rollbacks (opt-in)
- Mailbox approval for ephemeral agent follow-up tasks
- Aurora, Calm, and Dawn dashboard color themes
- Portable org export/import (`fn org-export` / `fn org-import`) with secret scrubbing
- Durable configuration revision history with rollback, now in Settings
- Review artifact controls and deliverable galleries; auto-generated task verification videos
- Guided in-app Bug/Feedback/Idea/Help reporting, with optional scrubbed activity context and reviewed screenshots
- Choose GitHub Issues or Discussions as your report destination; duplicate detection against open roadmap issues
- Mission hierarchy tools exposed to agents and dashboard chat; persisted ideation sessions with Mission handoff
- Promote research findings into mission roadmap features
- Request and observe task E2E verification from chat
- Preview missions, findings, evals, goals, and roadmap items directly in chat and mail
- Unified max concurrency across planning, execution, and review with simplified board capacity indicators
- WhatsApp plugin now shows pairing QR and setup instructions in Settings
- Configurable embedded PostgreSQL connection cap in Advanced Settings

### Fixed
- Custom workflow columns now render and move cards correctly instead of collapsing into Triage or In-review
- Workflows without a merge step finish in their completion column instead of stalling
- Fixed several built-in workflows sending cards backward to Todo or stalling the PR workflow
- Chat messages and mailbox sends with a raw NUL byte no longer crash mid-conversation
- Planning Mode: numerous fixes for scrolling, session restoration, mobile/tablet layout, refinement, timers, and duplicate task creation
- Fixed dropped Claude CLI login detection, Codex weekly usage reporting, and OMP model runtime failures
- Fixed several PostgreSQL migration/health/permission edge cases, including concurrent project init and stale worktree ownership
- Dashboard shows SQLite→PostgreSQL migration status while cutover is in progress
- Fixed duplicate follow-up tasks from retried agent steps and cross-parent diagnostic duplicates
- Restored task lifecycle entries in PostgreSQL activity logs
- Fixed task token counts inflated by reused agent sessions
- Fixed GitHub issue import deduplication and foreign-language issue-form auto-translate detection
- Fixed dashboard build failure from a missing dependency
- Various UI consistency fixes: task detail control sizing, workflow chip theming, Report menu stacking/background, chat pinned sections

### Breaking
- Removed the Planning Mode deepening checkpoint and fixed interview depth caps; user validation now replaces AI-driven completion

### Security
- Report screenshots and activity traces are scrubbed before filing so paths and tokens never leave the machine

### Internal
- Review gates now run only as workflow nodes; the in-session step reviewer (`fn_review_step`) has been removed
- The workflow IR is now the single authority over task lifecycle and column transitions

## 0.73.0-beta.0

### Highlights
- Breaking: Planning Mode is now an open-ended interview you explicitly validate — no more fixed depth caps or checkpoint gating
- Security: in-app reports scrub the full activity trace before filing, so paths and tokens never leave your machine
- Pick your update track — beta or stable release channels in Settings or `fn update --channel <stable|beta>`
- Your custom workflow now fully drives the board — cards move through the columns you actually defined, not a fixed six
- Review artifacts: auto-generated task verification videos and deliverable galleries in a new Quality hub

### New
- Beta and stable release channels — choose your update track in Settings or `fn update --channel <stable|beta>`.
- Your workflow now drives the board — cards move through the columns you define, not a fixed six-column set.
- Review artifact controls: auto-generated task verification videos and deliverable galleries in a new Quality hub.
- Guided in-app Bug/Feedback/Idea/Help reporting with screenshots, GitHub Issues or Discussions filing, and roadmap deduplication.
- Mission auto-merge override — bundle a mission's features onto one branch and one PR.
- Mailbox approval for ephemeral agent follow-up tasks.
- Ideation: persisted sessions with promotion of research findings into mission roadmap features.
- Mission hierarchy tools exposed to agents and dashboard chat; scheduled mission work with symbol-level concurrency control.
- Portable org export/import (`fn org-export` / `fn org-import`), now surfaced in the Team tab.
- Configuration revision history and rollback, now in Settings.
- Native structure previews (missions, findings, evals, goals, roadmap items) in chat and Mail, with drag-to-attach.
- Optional Task chat progress feed narrating steps, failures, reviews, and rollbacks.
- Dashboard chat agents can now edit files and run bash directly with coding workspace tools.
- WhatsApp plugin: pairing QR code and setup instructions surfaced in plugin settings.
- Embedded PostgreSQL connection cap is now configurable in Advanced Settings.
- Planning Mode simplified into a sequential flow: question → plan review → refine/validate.

### Fixed
- Planning Mode: dozens of reliability fixes — stable timers and session restore across refresh/stop/resume, reliable refinement submission on mobile, synced questions and running plan, durable initial plan generation, mobile/tablet layout, collapsed history by default, and rejection of truncated final plans.
- SQLite→PostgreSQL migration status now surfaces on the dashboard while cutover is pending; several PostgreSQL stability fixes (permission errors reading migration health, concurrent project-init races, NUL-byte crashes in chat/mailbox writes, restored activity logs).
- Workflow/board fixes: no-merge workflows now finish in their completion column, custom Merging columns receive cards correctly, hold nodes no longer crash the Pull Request workflow, and tasks without a saved workflow selection can move again.
- Fixed Codex weekly usage reporting, Grok/Claude MCP bridge packaging, OMP (Oh My Pi) model runtime failures, and GitHub Copilot re-login banner persistence.
- Task detail and Kanban UI polish: consistent action-button sizing across themes/breakpoints, mobile swipe settling on one column, cost badge placement, and deduplicated agent name badges.
- Restored translations (zh-CN/zh-TW roadmap duplicate label; Settings Configuration Versions across five locales).
- Duplicate-task guards: prevented duplicate follow-ups from retried steps, cross-parent diagnostic duplicates, and stale "needs your decision" states.
- GitHub/GitLab: fixed foreign-language issue-form auto-translation and forced transport selection for Discussions.
- Fixed a dashboard build failure caused by a missing dependency; Settings now autosaves instead of requiring an explicit Save.
- Windows update timeouts extended; Compound Engineering personas restored in npm installs; Claude CLI pi extension load fixed via SDK dependency pinning.

### Breaking
- Removed the Planning Mode deepening checkpoint and fixed interview depth caps — plans are now validated explicitly by the operator instead of by AI completion.

### Security
- In-app report filing now scrubs the full activity trace before it leaves your machine, so paths and tokens never reach the pipeline.

### Internal
- Review gates (plan/code/browser) now run exclusively as workflow-graph nodes; the legacy in-session step reviewer and its git-reset rewind path are removed.
- Tasks left mid-flight by an older Fusion version are now adopted cleanly on upgrade instead of getting stuck.

## 0.72.0

### Highlights
- OpenAI Codex sign-in now front-and-center in onboarding quick start
- OAuth logins reliably open the system browser on desktop instead of silently failing
- Embedded PostgreSQL always inits UTF-8, and Fusion auto-repairs older broken clusters
- Project setup warns when Git is missing, with install-or-continue options
- Windows close dialog adds Minimize to tray, plus safer elevated Postgres boot

### New
- OpenAI Codex subscription sign-in moved into onboarding quick start, right after Anthropic
- Project creation now warns when Git is missing, offering install or create-anyway options
- Windows desktop close dialog adds a Minimize to tray option that keeps Fusion and embedded PostgreSQL running in the background
- Windows desktop close dialog can prompt to shut down embedded PostgreSQL when the app closes

### Fixed
- OAuth sign-ins (OpenAI Codex and others) now reliably open the system browser from the desktop app instead of getting silently popup-blocked
- Creating a new folder during project setup now selects it correctly so Select confirms the right folder
- Embedded PostgreSQL clusters are now always created UTF-8, fixing dashboard crash-loops on non-UTF-8 Windows locales
- Fusion now auto-repairs embedded PostgreSQL clusters left in a broken non-UTF-8 state by earlier versions
- Floating windows now keep a stable stacking order based on last-opened and last-interacted
- Git installed while Fusion is running is now detected without needing a restart during project setup
- Onboarding GitHub setup links now follow the dashboard's theme instead of default browser blue
- Elevated Windows boots now start embedded PostgreSQL without creating a local system account, and clean up old ones
- Fixed elevated Windows desktop boot failing with a "directory name is invalid" error when starting embedded PostgreSQL
- Hardening pass across onboarding, Git preflight, and Windows PostgreSQL lifecycle based on review feedback

### Breaking
- Existing non-UTF-8 embedded PostgreSQL clusters are not retroactively fixed; affected installs must delete their local embedded-postgres data directory to complete the repair

## 0.71.0

### Highlights
- See live progress instead of a blank screen during database migrations on boot
- Desktop launch screen now shows migration status and won't time out mid-migration
- Fixed a first-boot crash migrating legacy SQLite data containing NUL characters

### New
- Dashboard now shows a holding page and banner with live progress while a database migration runs in the background
- Desktop launch screen displays migration progress and pauses its timeout until migration finishes

### Fixed
- Fixed first-boot SQLite-to-PostgreSQL migration failing on legacy data containing NUL (\u0000) characters

## 0.70.2

### Highlights
- Fixed npm-installed CLI crashing at startup from missing PostgreSQL migrations
- Plugin registry and llama.cpp extension now ship correctly in published npm installs
- Fixed child-process isolation mode failing on npm installs
- Fixed the standalone fn binary failing to boot in embedded-Postgres and DATABASE_URL modes
- Fixed embedded PostgreSQL refusing to start on Windows

### Fixed
- Fixed npm-installed CLI crashing at startup because PostgreSQL migrations were missing from the published package.
- Shipped the plugin registry manifest and llama.cpp extension in the published npm package, fixing silently missing plugins and a broken llama.cpp integration status.
- Shipped the child-process runtime worker so isolationMode "child-process" works correctly from npm installs.
- Fixed the standalone fn binary failing to boot in both embedded-Postgres and DATABASE_URL modes, and added self-contained release binaries.
- Fixed embedded PostgreSQL failing to start on Windows after a recent shared-memory default change.

## 0.70.1

### Highlights
- Fixed packaged desktop app crashing on first launch due to missing PostgreSQL migrations
- Fixed PR-mode auto-merge failures in centrally-installed multi-project setups

### Fixed
- Packaged desktop builds no longer crash on first boot — the PostgreSQL migration files that power Local mode schema setup are now correctly bundled into the app.
- PR-mode auto-merge no longer fails with a "Could not determine repository" error when running centrally-installed, multi-project deployments; repository resolution now uses the correct per-project context instead of falling back to the wrong working directory.

## 0.70.0

### Highlights

- Require PostgreSQL storage and complete runtime parity across projects, archives, missions, plugins, and maintenance.
- Settings theme selector is merged into the current-theme row and lists every color theme.
- Refresh workspace dependencies before a full System panel rebuild.
- Show migration details once in the dashboard and system inbox after SQLite cutover.
- Bundle embedded PostgreSQL for zero-system-install local storage when DATABASE_URL is unset.

### New

- Settings theme selector is merged into the current-theme row and lists every color theme.
- Refresh workspace dependencies before a full System panel rebuild.
- Show migration details once in the dashboard and system inbox after SQLite cutover.
- Bundle embedded PostgreSQL for zero-system-install local storage when DATABASE_URL is unset.
- Default local backend is now embedded PostgreSQL; set FUSION_NO_EMBEDDED_PG=1 for legacy SQLite.
- Add a workflow setting to disable idle heartbeat task patrol.
- Show when Plan Review budget exhaustion needs approval and make the replan cap configurable.
- Chat agents and Grok CLI sessions now have board, delegation, web, and knowledge retrieval tools.
- Auto-retry executor tool-call failures before parking tasks.
- Optionally escalate an executor run to a stronger model or configured node after same-model retries are exhausted.
- Add a diagnostic summary and one-click "Retry with a different model/node" to the Task Failed banner.
- Add a Hide imported toggle that filters imported issues, PRs, and GitLab items from Import Tasks.
- Planning summary description now renders formatted markdown by default.
- Quick Add image attachments now show compact previews you can tap to open full-size in a resizable window.
- Add a dedicated fallback model lane for the AI merger, configurable under Project Models.
- Pin up to 3 chat conversations to keep important ones at the top.
- Add a read-only tool to review a task's full agent log from chat.
- Task-detail chat now proactively narrates step progress, failures, and review outcomes in real time.
- Planning Mode now previews the generated plan before you choose whether to refine it.
- Show a Reverted badge on completed tasks whose changes were rolled back.
- Add a setting to write generated task definitions in the operator's supported input language.
- Dashboard keyboard shortcuts now toggle — re-press a shortcut to close its interface.
- Add a global option to skip confirmation dialogs for critical actions.
- Add an executor fallback model and retry the primary model before blocking on fallback exhaustion.
- Triage-detected duplicate tasks are now blocked for a Keep/Delete decision instead of auto-deleted.
- Add a Create fix task button on failed PR checks in the GitHub import preview.
- Add planner clarification controls with ntfy and mailbox alerts.
- Add a per-task Merger model and thinking selection to the Quick Add model dropdown.
- Split backup settings into global Database Backups and project Memory Backups.
- Show a local codebase token estimate and on-disk size on the project Dashboard Overview.
- Add a one-click "Restart Fusion" button to the update banner after an in-app update.
- Add a Refresh checks button to GitHub import PR previews for fresh CI status.
- Add a one-click "Restart Fusion" button to the Settings modal after an in-app update.
- Add three new dashboard color themes: Cobalt, Clay, and Moss.
- Show active task reasoning by default in Activity Live logs.
- Add Kimi K3 model selection and token-cost support.
- Model dropdowns keep the provider header pinned while scrolling and let you collapse each provider list.
- Task detail action row now matches Quick Add — Eye icon for oversight, plus attach and GitHub-tracking buttons.
- Add tap-to-reveal names for mobile executor footer stats.
- Add Todo API read + create-task endpoints so scripts can turn a todo into a running task.
- Choose which quick-action tabs appear in the mobile footer nav.
- Let operators post GitHub issue comments directly from Import Tasks.
- Add a first-class Claude runtime that drives Claude Code over ACP.
- Remove the footer AI session pill; background progress now appears in the session notification banner.
- Reorder and add more mobile footer quick actions, applied in real time.
- The Import from GitHub screen now shows a status indicator while issues are being translated.
- GitHub import pages all open issues with Prev/Next; linked issues close when tasks reach Done.
- Auto-translate foreign-language GitHub issues in the Import Tasks panel, with a target language and model you choose.
- The GitHub import screen shows far more issues at once, and Import now sits under the issue you are reading.
- Imported GitHub and GitLab issues now carry their screenshots as task attachments, so agents can see them.
- Offer AI translation in Import Tasks when issue/PR content is not the dashboard language.
- Keep the operator's original task description at the top of generated PROMPT.md specs.
- Optional LLM session advisor for planner overseer (off by default; enable and set model to use).
- Command Center productivity, team, token, and tool analytics work on the PostgreSQL backend.
- Command Center workflow, GitHub-issue, signal, and live-snapshot analytics now work on the PostgreSQL backend.
- Goals work on the PostgreSQL backend — the Goals view and mission goal-links load instead of erroring.
- Generating insights works on the PostgreSQL backend — the insight run executor and stale-run sweeper run in PG mode.
- Insights work on the PostgreSQL backend — the Insights dashboard loads instead of erroring.
- Dashboard banner after SQLite auto-migration to PostgreSQL with backup location and help link.
- Mission autopilot runs on the PostgreSQL backend — missions advance automatically instead of autopilot being disabled.
- Missions work on the PostgreSQL backend — the Missions dashboard and goal→mission links load instead of erroring.
- Isolate projects sharing the embedded PostgreSQL cluster — tasks, config, and archived tasks are scoped per project.
- Remove node settings sync on the PostgreSQL backend — nodes share the database, so settings are already shared.
- Remove task mesh replication entirely — nodes replicate through the shared PostgreSQL database.
- Research runs actually execute on the PostgreSQL backend instead of staying queued forever.
- Research works on the PostgreSQL backend — the Research dashboard loads and runs CRUD instead of erroring.
- Live dashboard updates (SSE) work on the PostgreSQL backend for missions, research, and insights.
- Creating, editing, and deleting custom workflows works on the PostgreSQL backend.
- Plans that need approval now also post a task-linked message to your dashboard mailbox.
- AI planning, subtask, and mission interviews are now multi-tab — any tab can use the same session.
- Add Quality plugin with Task QA tab for preview servers, test runs, reports, and suggested cases.
- Control the overseer session advisor from project settings, per task, and Quick Add.
- Settings search now finds and jumps to individual settings, and settings screens share one type scale.
- Pin each task to one derivable worktree directory when worktree naming is "Task ID".
- Todo lists now work on the embedded-PostgreSQL backend instead of erroring.

### Fixed

- Suppress the Planning Mode reconnecting hint on persisted question screens.
- Hide the interview reconnecting hint on persisted question and review screens.
- Settings now uses the same compact color-theme dropdown as the dashboard.
- Restore agent models, workflow lanes, Skills, goals, and Reliability after PostgreSQL migration.
- A task honestly parked as blocked now stays parked through engine pause/abort and workflow-graph teardown.
- Fix agent AI interviews to use the configured planning model and preserve runtime suggestions.
- Show live phase, table, row-copy, verification, and failure progress during SQLite migration.
- Recover agent interviews when models return thinking-only or malformed JSON responses.
- Fix dashboard skill discovery lifecycle in PostgreSQL mode.
- Preserve late task, workflow, and mission fields during SQLite-to-PostgreSQL migration.
- Recover stale executor sessions with bounded fresh-session retries while preserving task progress.
- Settings now opens on the Appearance section by default.
- Fix startup failures and a leaked server when two Fusion processes start embedded Postgres at the same time.
- Repair macOS embedded PostgreSQL dylib compatibility links before startup.
- Starting a second Fusion process no longer fails with a Postgres lock-file error.
- Block empty-diff task finalizes that skipped verification steps so reverted work can't reach done.
- Reverted-work tasks no longer merge to done as empty no-ops; they park for review.
- Executors can end a genuinely-impossible task as "blocked" instead of laundering it into done.
- Dashboard API requests now resolve an explicit registered project instead of silently using the launch directory.
- Failed tasks with pre-fix promotion history can no longer auto-promote past the failure-provenance guard.
- Fix manual agent-run creation failing on PostgreSQL when a heartbeat executor is attached.
- Keep Anthropic subscription sessions connected by refreshing OAuth credentials with the correct client identity.
- Fix Anthropic subscription logins failing tasks with "Provider is not configured: anthropic".
- Fix protected image artifacts so previews and links load in authenticated dashboards.
- Fix a dashboard/app boot crash on databases created before the bulk-completion-refusal change.
- Fix startup failures when several projects migrate against one PostgreSQL cluster at the same time.
- Stop more agents from running than the global concurrency cap allows.
- The task composer's Save button no longer has its label cut off on mobile.
- Fix first-boot SQLite migration failures while preserving all legacy project data.
- Fix data stores that silently failed against PostgreSQL by hitting removed SQLite paths.
- Plan Review revisions no longer loop forever; tasks escalate to approval after repeated revises.
- Completed Planning Mode sessions that create multiple tasks now stay in planning history.
- Prevent startup crashes while recovering plugins from retained SQLite data.
- Fix task refinement/duplication, merge verification, and workflow checkpoint persistence on PostgreSQL.
- Harden session-routing header wiring so a missing model-auth method can't break agent startup.
- Fix tasks getting stuck in Planning forever after a plan review asks for revisions.
- Fix branch-group controls for tasks in non-default dashboard projects.
- Prevent implementation-incomplete workflow merge failures from false-completing as no-op done.
- Stop posting two completion comments on a linked issue when a task is both imported and tracked.
- Fusion self-repo issues now actually show the target release version when a task closes.
- Grok CLI failures now show the actual error instead of an empty chat message.
- Fix a deleted Planning Mode session silently reappearing after an in-flight generation finishes.
- Fix plugin skill toggles for custom skillFiles paths so sessions honor them.
- Fix Compound Engineering plugin skills missing from the published package.
- Reports, CLI Printing Press, and WhatsApp Chat plugins now load from global installs.
- Pressing "New session" in Planning now always focuses the compose input.
- Give terminally failed planning tasks deterministic fallback titles.
- Make idle triage patrol back off during model outages.
- Fix Project Models workflow model lane saves.
- Surface duplicate-decision tasks on cards and in the operator mailbox.
- Tasks parked by a refused fn_task_done no longer resurrect and strand at code review.
- The planner overseer now notices a failed in-progress task immediately instead of after two hours.
- Honor custom project workflow defaults in triage guidance.
- Hide the GitLab import tab when GitLab integration is disabled in settings.
- Fix Agents controls panel overlapping surrounding content on narrow viewports.
- Fix concurrency sliders being undraggable on mobile touch devices.
- Chat "Thinking" reasoning blocks now start collapsed for a cleaner transcript.
- Exclude long engine pauses from in-progress task execution time.
- Fix Mailbox artifact messages — "Open artifact" now loads without an auth error and "View task" opens the task.
- Transient provider failures of the Plan Review gate no longer bounce tasks back to planning.
- GitHub import skips prior issues after description edits or owner/repo casing changes.
- Fix task chat showing a stale agent message while generating a new reply.
- Move project summarization model controls next to summarization settings.
- Chat agents no longer switch your checked-out branch unless you ask.
- Prevent inline Code Review steps from failing before they can run.
- The GitHub/GitLab Import Tasks screen now marks an issue, PR, or item as "Imported" immediately after importing it.
- Show the underlying error message for failed tool calls in the task Activity feed.
- Auto-merge now retries AI provider blips instead of permanently failing the task.
- AI merge rejections now say why, and a stranded merge can be retried without waiting.
- Concurrent soft-delete during a heartbeat move no longer strands an agent in error.
- Quick Add overseer, priority, fast, GitHub, and attach icons now render at one uniform size.
- Plan Review now backs off and pauses on provider rate limits instead of retrying every 30s for hours.
- Plan Review no longer loops forever on reviewer retry storms — it fails the task with a clear error.
- Concurrency slider current-use dots now line up with the running-count value on the dashboard and footer.
- Fix already-approved plans being re-asked for approval after recovery.
- Task-detail popups now open in — and stay scoped to — the view where you opened them.
- Move the room thinking-effort control from the room header into the composer Brain icon next to attach.
- Fix dashboard secondary text labels rendering an unintended color from an undefined CSS token.
- Ensure required database schemas always initialize before plugin tables on boot.
- Per-task token budgets now enforce — soft caps alert once and hard caps pause the task.
- Planning Mode and interview questions now render markdown formatting correctly.
- Fix chat room messages rendering out of chronological order.
- Auto-summarized task titles now match the language of the task description.
- Keep task deletion confirmations visible until users explicitly choose an action.
- Preserve GitLab import tracking metadata when tasks are read or restored.
- Embedded PostgreSQL now boots on hosts with a 64MB /dev/shm.
- Preserve GitLab import tracking metadata in normal task reads.
- Keep the Settings GitHub star counter up to date with a lightweight, in-view refresh.
- Archiving a task now deletes its git worktree so pinned worktrees no longer leak.
- Mobile "More" navigation drawer now closes with a swipe-down gesture.
- GitHub import "Close issue" button is now red and asks for confirmation before closing.
- Align mobile Settings provider cards with the section header's left edge.
- Fix fn backup and scheduled database backups in the default embedded PostgreSQL setup.
- Show the CLI Binary panel in default Settings instead of behind the Advanced switch.
- Keep Quality hub actions visible beneath the title on mobile.
- Fix tasks stalling when a leftover git branch collided with a new worktree.
- Keep agent reads responsive by reusing the host TaskStore across extension loads.
- Archiving a workspace task now removes its per-sub-repo worktrees.
- Quick Add action buttons are no longer shrunk in shadcn themes.
- Make Respecify replan tasks across workflow board layouts.
- Fix excessive right padding in the task detail Feed on mobile.
- Quick Add action buttons read at a proper size on mobile.
- Fix lopsided right padding in the task detail view on mobile.
- Don't show tasks as failed with Retry while an automatic transient retry is pending.
- Group each workflow model fallback lane directly under its primary lane in Settings.
- Stop tasks that are still being planned from being moved to Todo prematurely.
- Keep task-card action menus open and usable after they receive keyboard focus.
- Align the bundled pi coding-agent SDK to the ModelRuntime API so the engine builds.
- Fix heartbeat multiplier so long-cadence agents stop false-flagging as stale or zombie.
- Quick Add action buttons read at a proper size on mobile.
- Refinement tasks now inherit the default workflow's optional review steps.
- Fix lopsided right gutter in the task detail view on mobile.
- Keep mobile task delete confirmations open through synthesized ghost clicks.
- Task status badge now reads "Replan" instead of the raw "needs-replan" token.
- Move task Merge Details from Plan to the done-only Summary tab.
- Add spacing below the Settings theme selector before the Font Size section.
- Make global npm installs reliable by pinning the @earendil-works/pi-* version set.
- Stop fn dashboard from making macOS rename its own local hostname over mDNS.
- Prevent transient credential-file lock contention from terminating provider runs.
- Mission feature validator now inspects the merged commit and defers instead of false-failing on branch divergence.
- Correct duplicate delegation ownership and add engine task reassignment.
- Reject messages addressed to nonexistent agent recipients.
- Task detail toolbar is now icon-only and matches Quick Add — fixes the mis-sized oversight icon on mobile.
- Quick Add Deps/Models/Agent icons no longer render oversized on mobile.
- Remove the gap above the pinned provider header in model dropdowns so list rows no longer show through while scrolling.
- The overseer eye badge no longer appears on in-progress/in-review tasks when oversight is off.
- Closed GitHub tracked issues now reliably link the landing commit.
- GitHub-import auto-translate now translates issues on every page, not just the first 50.
- Fix the task-detail attach-file icon when the Definition tab is not open.
- Mobile Kanban board now magnetically snaps to a single column when you swipe between columns.
- The board card overseer eye icon now hides when a task's oversight is off, matching the task detail.
- Stop now disables the session advisor, and its on/off state correctly updates the task-detail oversight icon.
- Mobile "More" menu now pins Settings to the bottom below the divider.
- Hide the task-card overseer eye when the selected workflow has oversight turned off.
- fn db migrate now stamps migrated rows so tasks, config, and workflow settings stay visible after a cutover.
- Fix the mobile task detail panel being shifted left with a dead gutter on the right.
- Restore provider usage, workflow routing, and failed-task stability after PostgreSQL migration.
- Fix clean-CI packaging for bundled Quality and PostgreSQL plugins.
- Fix cramped GitHub/GitLab import detail header and show translated titles in its title bar.
- GitHub/GitLab import translations now persist across app restarts.
- Auto-recover tasks whose workflow step hits a missing or recycled worktree instead of parking them failed forever.
- Stop abandoned AI-session prompts when planning and interview generations are aborted.
- Preserve and isolate bundled plugin state during the PostgreSQL cutover.
- Stop re-asking approval for plans approved before the Original Description update.
- Keep Global and Project MCP settings bound to their own scopes in the Settings UI.
- Cancelling a merging task now stops it immediately instead of stalling for 30 minutes.
- Block a zero-change task from completing when its executor last failed with work unfinished.
- Fix cross-project data mixups by separating a record's owning project from PostgreSQL isolation.
- Stop logging a false "operator action required" pause-abort failure on tasks that already merged and completed.
- Fix Artifacts, Documents, and Evals dashboard views returning 500 in PostgreSQL mode.
- Stop PostgreSQL-mode boots from opening and checkpointing the legacy SQLite files.
- Fix startup failure where the SQLite → PostgreSQL migration aborted on CE session timestamps.
- Fix engine failing to connect after the PostgreSQL migration with "Project not found".
- Bind dashboard/serve stores to the central project registry instead of relying on cwd identity.
- CLI agent tools now boot PostgreSQL instead of the removed SQLite runtime.
- Standalone CLI, GitLab analytics, and plugin stores now run on PostgreSQL.
- Root project-scoped PostgreSQL stores and merges at the project directory, and fix backend-mode agent watching.
- Fix post-insert task rollback and add GitLab tracking reconcile.
- Mailbox — sending a message to an agent works in PG mode instead of erroring.
- Fix empty task board after the PostgreSQL migration when booting via fn dashboard.
- Fix SQLite → PostgreSQL migration silently skipping legacy camelCase tables.
- Preserve PostgreSQL jsonb defaults when legacy SQLite rows contain NULL.
- Preserve legacy empty JSON text during PostgreSQL cutover.
- Not-yet-ported features (missions, insights, research, goals) degrade cleanly in PG mode instead of erroring.
- Regression storm-guard and agent wake-on-message work on the PostgreSQL backend.
- Fix PostgreSQL-mode merge recovery, lost task-field writes, first-boot SQLite auto-migration, and backup tool discovery.
- Incident-signal ingestion records incidents on the PostgreSQL backend instead of being skipped.
- Workflow definitions load in PG mode — /api/workflows no longer errors.
- Fix Planning Mode getting stuck retrying and re-asking a question that was already answered.
- Fix PostgreSQL-mode crashes — agent-log flush no longer kills the server, and Command Center activity loads.
- Ensure PostgreSQL-backed CLI commands release project resources before exiting.
- Fix task creation dropping the workflow selection when a workflow and step toggles are submitted together.
- Fix custom workflow columns on PostgreSQL: tasks land in their workflow's intake column and can move out of it.
- Fix residual SQLite store constructions so chat, messages, backups, MCP secrets, and project setup work on PostgreSQL.
- Make PostgreSQL cutover fail safely and preserve project-scoped core data.
- Restore PostgreSQL persistence across bundled workflows and integrations.
- Keep multi-node management connected to the active PostgreSQL registry.
- Restore stalled-review badges, timed-execution totals, and fresh-agent-log stall suppression on board listings.
- Keep the quick-add Save button inline with its icon controls and center the control rows on mobile.
- Make SQLite cutover converge when multiple registered projects share embedded PostgreSQL.
- Quiet repetitive scheduler hold-release and task-routing lines that flooded the engine log pane.
- Merge autostashes no longer pile up in `git stash list`, and untracked work in them is never dropped.
- Stop reviewer rate limits and network blips from looping and spamming the task log.
- Safely classify and resolve whitespace-only merge conflicts.
- Prevent bundled plugin commands from delaying or crashing the Fusion CLI on spawn failures.
- Settings: consistent checkbox theming, inline help moved behind "?" icons, mobile ntfy help bubble fix.
- Block tasks that skip unreviewed steps after a completion refusal from auto-promoting to review.
- Self-healing no longer promotes a failed/refused task into review after its work was reverted.
- Preserve legacy migration data and isolate PostgreSQL records, task IDs, and merge queues by project.
- Stop triage Plan Review from looping to the replan cap by converging the spec reviewer.
- A task actively re-executing can no longer launder an empty reverted branch into done.
- Fix WhatsApp Chat plugin failing to connect (405 rejection) and its bundled build failing to load.
- Embedded Postgres now boots on Windows when Fusion runs elevated, fixing the Windows installer build.
- Fix workflow settings and prompt overrides appearing reset after the PostgreSQL migration.

### Breaking

- Require PostgreSQL storage and complete runtime parity across projects, archives, missions, plugins, and maintenance.

### Performance

- Keep Planning session history visible while its latest data loads.
- Make local `pnpm build` skip unchanged packages and use fast CLI packaging by default.
- Speed up dashboard and serve startup by sharing the PostgreSQL store and deferring non-route work.
- Make task deletion return faster while cleanup continues in the background.
- Speed up board listing and agent chat on PostgreSQL with SQL-side pagination and a conversation history cap.
- Fix PostgreSQL performance and credential-redaction gaps surfaced by the migration review.

### Internal

- Deprecate the built-in Coding (Ideas) workflow — it no longer appears for new task selection.
- Deprecate the built-in Brainstorming workflow — it no longer appears for new task selection.
- Plan Review now allows more automatic replan attempts (default 8) before asking a human.
- Multi-node fleets on shared Postgres no longer replicate tasks or settings over mesh HTTP.

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

> Older releases (before 0.60.0) are archived in [`CHANGELOG-archive.md`](./CHANGELOG-archive.md).
