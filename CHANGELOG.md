# Fusion changelog

User-facing release notes aggregated across all packages. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.

## 0.73.0-beta.5

### Highlights
- One plan can now create multiple tasks — from the dashboard, the CLI, or agent tools
- A finished plan is never a dead end anymore: resume it, keep refining, or create a task at any time
- Planning Mode gains contextual comments and codebase-grounded direction choices for sharper plan refinement
- Windows terminals no longer hang on "Starting terminal..." and Ctrl/Cmd+V paste is delivered exactly once
- Per-agent and project-wide heartbeat scheduling controls, plus guided setup for local OpenAI-compatible model providers

### New
- One plan can now create multiple tasks, consistently across the dashboard, CLI, and agent tools
- Add contextual comments to Planning Mode plan reviews by selecting quotes and suggestions
- Planning Mode now refines plans through codebase-grounded direction choices instead of generic prompts
- Add per-agent and project-wide heartbeat enable/disable controls
- Agent-card heartbeat controls can now disable and re-enable scheduling directly
- Add guided setup for local OpenAI-compatible model providers, with optional Qwen thinking compatibility

### Fixed
- A finished plan is never a dead end: reopen, keep refining, or create a task at any time
- Deleting a task created from a plan no longer strands the plan — Proceed creates a fresh task
- Planning Mode no longer hangs on "Generating plan" after a provider error; it now surfaces a retryable error
- Planning, mission, milestone, and onboarding interviews regenerate a question instead of erroring out
- Planning sessions now correctly show Complete instead of Needs input after their task is created
- Planning Mode shows a neutral loader while restoring a saved session instead of a misleading "Generating…" state
- Stopping a plan now cancels generations that haven't started streaming yet
- Every Planning Mode generation step streams AI thinking and output, not just the first turn
- Honor selected workflow planning models in Planning Mode
- Keep Planning Mode recovery retries safely bounded after failed attempts
- Give Planning Mode a dedicated collaborative prompt instead of reused task-triage instructions
- Keep Planning plan-review Add-comment controls, selected-text comments, and Refine/Proceed actions visible and reachable on mobile
- Fix Compound Engineering sessions dying with "AI returned no valid JSON" when turns race; add retry and diagnostics
- Fix embedded PostgreSQL crash-recovery boot on Windows, removing a self-shutdown race and a 30s log stall
- Push-after-merge no longer silently strands approved merges when the remote diverged
- Terminal no longer sticks on "Starting terminal..." on Windows; paste is delivered exactly once
- Show complete mission hierarchies in agent mission lookup results
- Show failed mission assertions and safe validator evidence in remediation work
- Scope feature validation to linked assertions instead of unfinished milestone work
- Bound generated mission fixes to one root feature retry budget
- Keep supervised mission validation report-only until autonomy is explicitly enabled
- Fix supervised task creation and defined-feature mission bootstrap admission
- Make ideation candidate IDs discoverable for direct convergence
- Keep GitHub issue import actions on one usable mobile row
- Keep secondary locale catalogs in sync with heartbeat controls and settings provenance labels
- Beta release notes now list only that beta's changes; stable notes roll up the whole beta cycle

## 0.73.0-beta.4

### Highlights
- Agent chat now digs through your actual codebase before answering architecture questions
- Custom workflow columns can carry their own descriptions
- Get notified the moment a task is truly stuck instead of silently stalling
- Plugin routes and toggles no longer misfire around startup timing and uninstalled runtimes
- Windows embedded Postgres crashes and connection-cap issues fixed

### New
- Agent chat investigates the live codebase with tools before answering architecture and code questions
- Custom workflow board columns support optional explanatory descriptions
- Stable dashboard theme tokens and plugin overlay layering via --fusion-max-z

### Fixed
- Chat View "Latest" button no longer shifts sideways out from under the cursor when clicked
- Plugin API routes now work for plugins enabled after startup or only in a non-launch project
- Operators are notified when a task is terminally blocked or exhausts automated recovery
- Uninstalled runtime pages are hidden from Settings integrations
- Plugin toggles no longer reinstall uninstalled runtimes
- Windows embedded PostgreSQL log contention and DLL initialization crashes are prevented and recovered
- Completed PostgreSQL migrations no longer re-scan retained SQLite backups at startup
- Imported task links in Stats now follow the active dashboard theme
- Embedded PostgreSQL default connection cap lowered to 150 on Windows to prevent 0xC0000142 backend crashes
- Planning Mode no longer duplicates generations or throws "AI returned no valid JSON" after leaving and returning mid-run

## 0.73.0-beta.3

### Highlights
- Attach photos and files directly in Quick Add and Main Chat
- Gesture-only Quick Add Start for eligible workflows
- Filter dashboard color themes by name in Settings and Command Center
- Task Stats now shows creation provenance — source, parent task, creating agent, duplicates
- Major reliability pass: mobile board snapping, review-step recovery, and scheduler fixes

### New
- Photo and file attachments in Quick Add and Main Chat
- Gesture-only Quick Add Start action for eligible workflows
- Filter color themes by name in Settings and Command Center
- Honor skill-executor config on foreach step-execute sessions so per-step skills load like top-level nodes
- Default Code Review remediation retries stay unlimited, with the active policy now shown
- Conditional task-document writes that reject stale publishers without altering revision history
- Authenticated append-only corrections for documents retained on archived tasks
- Plugins can now declaratively provide project MCP servers
- Task Stats tab shows creation provenance — source type, parent task, creating agent, duplicate flags
- Toggle GitHub tracking on or off from Coding Ideas task details
- Xiaomi branding now shown for Xiaomi and MiMo provider labels

### Fixed
- Board column headers now count REVISING (replan) and other actively working cards in the processing total
- Recover in-review tasks stranded by a restart that killed an in-flight review step, instead of failing them
- Duplicate follow-up tasks naming the same failing file now converge at creation
- Freeform chat task creation no longer requires mission lineage
- Restored the Coding Ideas board header color indicator
- Removed excess right padding from task popups on tablets
- Planning status badges now show for active Coding Ideas Todo tasks
- Restored the Coding Ideas action to move parked ideas to Todo
- Task activity logs now show Planning instead of Triage where appropriate
- Removed redundant readiness descriptions from Todo and In Review board headers
- Removed stray ellipses from merging status badges on task cards
- Mobile board swipes and flings always settle on a single centered column
- Task detail footer actions stay on a single row on mobile
- Needs-replan status badges now show Revising instead of Replan
- Task-card active glow now persists during replan and revise
- Fixed macOS embedded PostgreSQL startup when bundled ICU compatibility links are missing
- Aligned mobile task-detail Move actions with the footer edge
- Restored active chat thinking and partial response state when returning to a conversation
- Coding Ideas Start tasks now create directly in Todo
- Completed mission features now reconcile safely against archived delivery tasks
- Grok CLI fallback models now engage only when the primary model actually fails
- agent-browser binary now installs with Fusion on Windows, Linux, and macOS
- Stopped the legacy-adoption sweep from clearing live task statuses on store open
- Board column and footer running counts now include live Code Review, Plan Review, and other gate sessions
- Executors no longer start ordered task steps before required predecessors finish
- Orphaned in-flight review steps are now marked failed for re-review instead of silently skipped at merge
- Fixed engine restarts stranding replan-loop tasks in To Do
- Project workflow model lanes now apply to every workflow ahead of global and workflow values
- Manually parked tasks stay out of scheduler and remembered-owner dispatch until explicitly unpaused
- Task card files-changed links now open in the task popup when popups are enabled

### Internal
- Bumped the bundled pi runtime to 0.81.1 for newer models, providers, and session reliability

## 0.73.0-beta.2

### Highlights
- Fixed: Check for updates now correctly surfaces newer beta releases when you're on the beta channel

### Fixed
- Settings "Check for updates" now finds newer beta releases when the beta channel is selected, instead of missing them

## 0.73.0-beta.1

### Highlights
- Three new dashboard themes: Aurora, Calm, and Dawn
- Unified concurrency controls across planning, execution, and review with simpler board capacity indicators
- New simple Ideas-to-Done workflow with truthful, resumable column transitions
- Faster, more honest failure reporting for stuck sessions and provider/CLI login issues
- Broad reliability fixes for stranded tasks, missing plans, and interrupted planning/mission work

### New
- Unified max concurrency across planning, execution, and review with simplified board capacity indicators
- Aurora dashboard theme
- Calm dashboard theme with slate, sage, and misty light palettes
- Dawn indigo-and-amber dashboard color theme
- Simple Ideas-to-Done workflow with truthful, resumable column transitions

### Fixed
- Planning sessions can now persist PROMPT.md without an approval gate
- Server reports when the Claude CLI needs login instead of showing a false usage timeout after a minute
- Task planning persists complete specifications before Plan Review starts
- `fn update` rejects unknown flags; beta install bootstrap is now documented
- Stopped false CE skill-load warnings when plugin skills resolve without FUSION_CE_SKILLS_DIR
- Stopped legacy-adoption drained-marker warning spam on every CLI open under embedded Postgres
- Root-level File Scope files with extensions like global.json and solution files are now accepted
- Stopped spurious per-task "spawn /bin/sh ENOENT" noise during step baseline capture
- Stale flat skill-toggle keys are ignored so session skills match the Skills view after category layout changes
- Session Read tool can open host-advertised plugin skill body paths within the worktree boundary
- Plugin enable state stays consistent across UI and loaders after toggling
- Each enabled plugin loads once per process startup, no duplicate onLoad
- Workflow-definition creation no longer fails when a WF-id is already taken
- Healthy AI providers keep running, and provider-paused tasks resume automatically when capacity returns
- Unresolved merge-review blockers stay active across concurrent-main rebuilds and later retries
- Missing workflow plans are recovered before review instead of being wrongly approved or stranded
- Mission features interrupted during validation now resume after an engine restart
- Interrupted Planning sessions automatically retry when operators return to them
- GitHub tracking issues now get only one in-progress update per Fusion task
- Planning Mode questions no longer flood Mailbox; desktop planning pane spacing is tighter
- Planning Sessions toggle replaced with a consistent Back-to-sessions control
- Workflow lifecycle state is preserved, and execution steps start only after worktree creation

## 0.73.0-beta.0

### Highlights
- Choose your update track with new beta and stable release channels
- Kanban boards now follow your own workflow columns instead of a fixed six
- Planning Mode rebuilt into a three-pane interview with an always-visible, evolving plan
- File Bug, Feedback, Idea, and Help reports right from the app, with dedup and optional screenshots
- Mission auto-merge now keeps a mission's features on one shared branch and one PR

### New
- Quality hub now shows task verification videos when review artifacts are enabled
- Add beta and stable release channels — pick your track in Settings or with `fn update --channel <stable|beta>`
- Let operators set the embedded PostgreSQL connection cap in Advanced Settings
- Add an optional Task chat progress feed for steps, failures, reviews, and rollbacks
- Add mailbox approval for ephemeral agent follow-up tasks
- Add a mission auto-merge override so a mission's features share one branch and one PR
- Add guided in-app Bug, Feedback, Idea, and Help reporting
- Add durable configuration revision history
- Add portable secret-scrubbed organization export and import commands
- Add review artifact controls and deliverable galleries
- Add reusable native structure preview payloads and dashboard cards
- Auto-generate a short feature-video artifact for user-facing task deliverables
- Preview supported missions, findings, evals, and goals directly in chat
- Attach reviewable native structures to mailbox messages
- Add drag-to-attach native structures and AI narrative drafting to Mail
- Expose Mission hierarchy tools to engine agents and dashboard chat
- Add persisted ideation sessions with atomic Mission handoff
- Request and observe task E2E verification from chat
- Promote completed research findings into mission roadmap features
- Schedule approved mission work with symbol-level concurrency control
- Require approved mission lineage for autonomous task creation and delegation
- Let operators choose GitHub Issues or Discussions for in-app reports
- Add scrubbed activity context and optional local report screenshots
- Deduplicate in-app reports against open public-roadmap issues
- Add consent-based screenshots and activity context to in-app reports
- Add opt-in reviewed screenshots and scrubbed activity traces to in-app reports
- Let operators prevent duplicate in-app reports with optional roadmap matching
- File Feedback and Help reports as Issues when GitHub Discussions is disabled
- Make Planning Mode an infinite interview validated explicitly by the user
- Ideation is now a top-level experimental sidebar/mobile view instead of a Command Center tab
- Preview roadmap items and open their hosted Roadmaps destination
- Rebuild Planning Mode into a three-pane interview with always-visible plan and Validate
- Dashboard chat agents can edit files and run bash with coding workspace tools
- Show WhatsApp pairing QR and setup instructions in plugin settings
- Planning Mode plan.md is now distinct from triage PROMPT.md on task create
- Simplify Planning Mode to a sequential Q&A and plan-review flow with focus-steered refine
- Embed opted-in report screenshots in filed GitHub reports
- Boards now follow the workflow you defined instead of a fixed six columns
- Tasks left mid-flight by an older Fusion are now adopted on upgrade instead of sitting stuck
- Store in-app report screenshots as validated local artifacts
- Preserve parent lineage and reuse duplicate tasks created from planning breakdowns
- Mission auto-merge controls now explain merge behavior and show shared branch PR status
- Move configuration version history and rollback controls into Settings
- Move the org export / import card from Command Center Overview to the Team tab

### Fixed
- Save Settings edits automatically and safely flush pending changes when closing
- Show SQLite→PostgreSQL migration status on the dashboard while cutover is not done
- Stop showing Reconnecting status text in Planning Mode
- Preserve approved task scope during review and committed work during worktree recovery
- Prevent retried agent steps from creating duplicate follow-up tasks
- Boards built on custom workflows now show and move cards in their own columns
- Fix built-in workflows sending cards backward to Todo and stalling the PR workflow
- Fix a crash where chat messages and mailbox sends with a raw NUL byte would abort mid-conversation
- Show Codex weekly usage when OpenAI reports it as the primary quota window
- Prevent review-contract retry instructions from replacing workflow completion summaries
- Prevent fn_task_show timeouts when another Fusion process already owns embedded PostgreSQL
- Honor forced GitHub transport selection for GraphQL discussion queries and mutations
- Apply planning actions on the first mobile tap and create tasks without a separate validation step
- Workflows without a merge step now finish in their completion column instead of stalling short
- Fix tasks with no saved workflow selection being unable to move between columns
- Allow dependency-ready workflow steps to finalize when earlier independent steps are still running
- Wait for the AI-authored Planning Mode plan before enabling review actions
- Make plan refinement submit reliably from stopped, active, restored, and mobile planning states
- Keep planning timers session-specific and return cleanly from stopped generations
- Resume initial planning cleanly after stopping generation and preserve session timers across refreshes
- Finish plan task creation automatically and show links to the task or planning sessions
- Prevent stale worktree ownership metadata from blocking commits after a pooled checkout is reassigned
- Restore automatic task lifecycle entries in PostgreSQL activity logs
- Prevent transient dashboard failures when multiple projects initialize PostgreSQL concurrently
- Hide task-card overseer eyes immediately after workflow oversight is turned off
- Accept task completion regardless of wording in the completion summary
- Make Windows updates actionable and restore Compound Engineering agent personas in npm installs
- Restore the Simplified and Traditional Chinese labels for duplicate roadmap reports
- Hide the task-card overseer eye when a workflow only uses the default oversight level
- Preserve archived shared-branch landing proof during PostgreSQL promotion checks
- Planning Mode no longer accepts a truncated final plan with empty deliverables
- Oh My Pi (omp) model selections now run via the OMP ACP runtime instead of failing
- The task-detail oversight eye icon now reflects the session advisor's on/off state even when planner oversight is off
- Keep workflow chips and HTML mockup previews visually consistent across themes
- Mobile Kanban swipes now settle on exactly one column with no stuck-between-columns state
- Task detail action buttons now render at a consistent size across all themes
- Restore token recovery for installed PWAs after an unauthorized backend response
- Foreign-language GitHub/GitLab issues authored via issue forms now auto-translate and offer the Translate button
- Move the task-card cost badge below the Promote button in the bottom-right corner
- Planning Mode now always asks clarifying questions before producing a plan
- Resume saved Planning Mode progress after reload without automatically re-running generation
- Allow manual scrolling during generation in task chat, agent logs, and chat
- Allow manual scrolling during generation in task Planner Chat
- Allow manual scrolling during generation in the task Workflow tab live log
- Preserve manual scrolling in System Controls and Dev Server live logs
- Fix mobile model dropdown so the list stays scrollable after searching
- Fix tasks stuck on "Needs your decision" when their duplicate is already done
- Fix task token counts inflated by reused or resumed agent sessions
- Fix GitHub issue imports so edited descriptions cannot hide or falsely match prior imports
- Fix dashboard build failure caused by a missing dependency
- Task detail inline action icons now render at a consistent size on tablet screens
- Separate pinned chat conversations in the list and fix message edit Save
- Show Compound Engineering in navigation when the enabled plugin starts
- Preserve task work while recovering checkouts created outside the configured worktree directory
- Same-agent near-duplicates stay on the board by default on all create paths (no silent auto-archive)
- Fix Report menu stacking and move Command Center reports to System
- Restore Settings Configuration Versions translations for es/fr/ko/zh-CN/zh-TW
- Install the Agent Client Protocol SDK so the Claude CLI pi extension can load
- Fix mission interview start crashing when thinking level is left at Default
- Fix startup crash when a project has both fallback and registered partition data
- Keep Planning Mode interviews open until you explicitly validate the running plan
- Task detail Oversight/Fast and chat send heights match sibling controls on tablet
- Fix Grok and Claude Fusion tools MCP bridge packaging and model markers
- Show only one agent name badge when a task is assigned to its creator
- Return CLI chat replies to the terminal and expose dashboard inbox reads
- Make fn chat a named mailbox conversation with a stable conversation id
- Make Planning Mode usable on mobile and tablet with a progressive interview layout
- Keep workflow tasks paused while an agent question is awaiting an operator response
- Restore mobile navigation back to the Planning session list without a stuck Running plan screen
- Stop the dashboard TUI Logs tab from showing detailed timestamps on each log line
- Give the Report menu an opaque background so page content no longer shows through
- Planning Mode tablet tabs match mobile; mobile main shows sessions before running plan
- Planning Mode running plan shows an evolving plan, not repeated interview questions
- Restore in-progress Planning Mode interviews after leave/return, including mid-generation
- Planning Mode now drafts an initial running plan from your idea and refines it after each answer
- Planning Mode now uses the same workflow triage planning prompt template as newly added tasks
- Persist operator duplicate decisions so Fusion does not re-ask for the same task
- Deliver enabled plugin skills in dashboard chat the same way task sessions do
- Include planning-lane AI time and tokens in task cost and duration totals
- Keep Planning Mode compact interview view tabs pinned to the top on Answered questions
- Keep dismissed GitHub Copilot re-login banners hidden permanently
- Android and browser Back from a GitHub import detail returns to the issue list first
- Planning Mode history now collapses AI thinking by default
- Keep Grok ACP process cleanup armed once per process, without listener growth
- Prevent unfinished prose-only plans from advancing into implementation and merge
- Improve Planning Mode refinement and replace Validate with Proceed with plan
- Add mobile Planning tabs, one-click task creation, and answer/reasoning history
- Keep tasks running when an MCP server is temporarily unavailable
- Keep OMP ACP process cleanup armed once per process, without listener growth
- Prevent Plan Review tasks from blocking each other after a missing-worktree fallback
- Make Planning Mode generate a durable initial plan before asking optional refinement questions
- Keep Planning Mode questions and the running plan in sync after each answer
- Improve Planning Mode with scrollable Markdown plans and mobile bottom actions
- Report PostgreSQL health failures accurately without false database-corruption guidance
- Prevent agents from filing duplicate active diagnostic follow-ups discovered by different tasks
- Close the Quick Add agent picker when clicking outside it
- Stop active task processing before a user move to Todo becomes visible
- Prevent Plan Review replans from stranding completed tasks in Triage and recover them automatically
- Stop PostgreSQL permission errors when the dashboard reads SQLite migration health
- Isolate automated tests and global test-mode runs from the normal Fusion database
- Prevent concurrent tasks from falling back when an Anthropic OAuth token rotates
- A custom Merging column now receives the card at merge instead of being sent to In-review
- Hide empty chat verification status and move active results below task metadata
- Show every suggested Planning Mode refinement category instead of limiting choices to three

### Breaking
- Remove the Planning Mode deepening checkpoint and fixed interview depth caps

### Security
- Scrub top-level report activity traces before filing so paths and tokens never reach the pipeline

### Internal
- Review gates now run only as workflow nodes — the in-session step reviewer is gone

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
