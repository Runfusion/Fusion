# Fusion changelog archive

Archived release notes before 0.60.0. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.

## 0.59.0

### Highlights

- Add per-agent Assignment Policy; guard every task-routing path so liaison agents can never receive product tasks.
- Add a one-time banner announcing the upcoming SQLite→embedded-Postgres storage change.
- Artifact-registration mail notifications now show an inline preview and open link.
- Add a Commit and Push button to the Git Manager commit form.
- Let users define custom terminal shortcut buttons (label + injected sequence) from the terminal Preferences panel.

### New

- Add per-agent Assignment Policy; guard every task-routing path so liaison agents can never receive product tasks.
- Add a one-time banner announcing the upcoming SQLite→embedded-Postgres storage change.
- Artifact-registration mail notifications now show an inline preview and open link.
- Add a Commit and Push button to the Git Manager commit form.
- Let users define custom terminal shortcut buttons (label + injected sequence) from the terminal Preferences panel.
- Storage update banner now has a Get help (Discord) button and notes project DBs move to the central Fusion database.
- Show user-defined custom terminal shortcuts in the embedded Task Detail terminal's mobile key bar.
- Deliver a one-time inbox notice about the upcoming Postgres storage migration on first 0.59 startup.
- Change a chat's thinking level mid-conversation from the composer
- Add per-step Thinking Level controls to schedule and routine AI actions.
- Add a persisted Thinking Level selector for manual insight generation.
- Schedule and routine AI steps now apply the chosen thinking level at run time.
- Add a project Chat default (model or agent) with prompt-each-time or always-use-default New Chat behavior.
- Switch an active chat's model or agent mid-conversation from the brain-icon popup.
- Add a Chat Room thinking-effort override for all room responders.
- Add `fn workflow validate` to dry-run a custom workflow IR without creating or mutating it.
- Add `fn plugin publish --dry-run` preflight that validates a plugin before publishing.
- Artifact-registration mail notifications now include a "View task" link to open the producing task.
- Add separate Reviewer and Planning thinking-level selectors on task details.
- Add persisted thinking-level controls to Mission Interview and Planning mode.
- Release notes open with AI Highlights, and the release script prints a ready-to-post engagement tweet.
- Add Command Center System controls (rebuild & restart, engine/agent restarts, backups, live logs) and a Plugins tab.
- Add thinking-level controls to agent and bulk task model selectors.
- Make Chat go-to-top contextual and inline, with the edit pencil compact beside timestamps.

### Fixed

- Deliver plugin skill bodies to agent sessions and the Skills view.
- Honor plugin skillFiles paths so plugin skills can live in category subdirectories.
- Agents now auto-recover from transient OAuth token-rotation 401 errors instead of parking for operator action.
- Center the Chat composer attach and model icons with the message input box.
- Ideas-intake cards no longer auto-process on restart; replan and Retry work from Todo; All-workflows shows every card.
- Update the dashboard TUI splash tagline to "software factory".
- Keep chat history stable while an agent is mid-turn so prior user and agent messages no longer flicker away.
- Agent chat exposes the same tools on desktop and browser; messaging tools no longer silently drop.
- Reloading a path-registered plugin now refreshes its version and settings schema.
- Per-project plugin-skill toggles now apply to agent sessions, not just the Skills view.
- Agent inspection tools now show why agents are in error or paused.
- Unpausing (and pausing) a task now updates the board immediately.
- Make artifact preview popups full-screen sheets on mobile.
- Restore reliable mobile header dragging for movable floating modals.
- Fix cramped spacing on the Command Center System tab (logs and controls).
- Durable agents retry generic heartbeat failures instead of parking as unrecoverable on first error.
- Shorten the Settings "Reset Settings" button to "Reset" on mobile.
- Keep the System tab refresh button inline with its title and far right on mobile.
- Fix "Copy diagnostics" crash on non-secure origins (mobile/HTTP).
- Durable agents in error state are cleared and retried automatically on engine restart.
- Fix copy actions crashing or mis-reporting on non-secure origins (mobile/HTTP).
- Fix chat "Copy response" falsely reporting failure on non-secure origins (mobile/HTTP).
- Restore task deletion from the right-dock Tasks list.
- Fix pinned terminal rendering underneath the status footer.
- Chat thinking-level Default entries now show the real project default.
- Fix the in-chat model selector on tablet and mobile.
- Fix jerky tablet drag for the terminal and other movable modals.
- Keep the task refinement feedback dialog open after selecting Refine.
- Fix the in-chat model/thinking popup being cut off inside a narrow floating Chat window.
- Mailbox artifact "View task" now opens the same movable, resizable task window used elsewhere.
- Task card priority badges now show icon-only so they no longer wrap to a new line.
- Keep project MCP tools available across fresh executors and approval resumes.
- Pausing an in-progress task now sticks — the pause survives session teardown instead of auto-resuming.
- Remove the "Connected" label and shortcut help text from the terminal footer.
- Fix terminal workspace drop-down rendering behind the floating terminal modal.

## 0.58.0

### Highlights

- Add an interactive worktree-rooted Terminal tab to the task detail view.
- The Task Detail Terminal tab is now always available, falling back to the project root when a task has no worktree.
- Agents can now add files to a task's File Scope while working, so out-of-scope edits aren't stranded at merge.
- Agents save screenshots, videos, HTML mockups, and PDFs as artifacts, shown in a new category gallery with doc editing.
- Edit task documents and project files in the Artifacts view; markdown by default; fix the Add comment button.

### New

- Add an interactive worktree-rooted Terminal tab to the task detail view.
- The Task Detail Terminal tab is now always available, falling back to the project root when a task has no worktree.
- Agents can now add files to a task's File Scope while working, so out-of-scope edits aren't stranded at merge.
- Agents save screenshots, videos, HTML mockups, and PDFs as artifacts, shown in a new category gallery with doc editing.
- Edit task documents and project files in the Artifacts view; markdown by default; fix the Add comment button.
- Add a persistent Advanced settings toggle that keeps uncommon Settings sections and controls hidden by default.
- Guide repeatable Compound Engineering cycles from product grounding through reusable learnings.
- Add persisted thinking-level settings for every fallback model lane.
- Add Grok CLI runtime support as a bundled plugin with a grok-cli model provider.
- Mobile Settings search row now collapses by default with a show/hide toggle.
- Add a policy-gated review-lane bypass for cards stranded by a failed pre-merge review step.
- Grok can now run through the Grok CLI's NDJSON stream, so CLI-authenticated setups need no Fusion-visible API key.
- Grok CLI runtime now bridges tool execution events (name/args/result) from the NDJSON stream, not just text.
- Grok work can now be routed through the Grok CLI streaming runtime, not only the direct xAI endpoint.
- Add a dedicated permission for who may bypass a failed review gate, separate from task mutations.
- Add a File Scope agent permission category, allowed by default under the grant-all preset.
- Update the pi SDK and add support for GPT-5.6 codex-tier models.
- GPT-5.6 codenamed models (luna, sol, terra) are now selectable in the model picker.
- Add inline thinking-level selection to task and agent model dropdowns.
- Add per-lane thinking effort overrides to Settings model lane dropdowns.
- Add per-node workflow thinking-level controls for custom model bindings.
- Add per-workflow model lane thinking-level controls for planning, execution, and review.
- Choose a thinking level when starting a new model chat.
- Plugin prompt contributions can now gate content on per-project plugin settings.
- Let task edits toggle optional workflow steps directly.
- Show a Claude "Weekly (Fable)" usage window in the Usage dropdown.
- Image attachments now appear in the Artifacts view as artifacts.
- Apply fallback models' own thinking levels when runtime swaps to them.
- Add inline thinking-level selectors to every fallback model picker in Settings.
- Artifacts view — Task Documents now uses a left-sidebar list with a right-pane content viewer.
- Artifacts view — select text in a Task Document's content pane to comment and send it to a new task.
- Show a Grok (xAI) card in the Usage dropdown for configured Grok API keys.
- Show Cursor subscription usage in the Usage dropdown.
- Add a documented CURSOR_API_KEY credential path for Cursor usage metering.
- Add a Cost tab to task detail and an optional per-card cost badge (default off).
- Add a resizable Settings navigation rail that remembers its width.
- CLI agent cold-start timeouts now default to 2 minutes and are configurable.
- Artifacts view — the Task Documents list now also shows each task's registered artifacts.
- Add cost data for GLM-5.2, MiniMax-M3, and Kimi K2.6 so their token usage shows a dollar cost instead of "—".
- Drive Grok CLI sessions over ACP with Fusion tools, skills, and MCP loaded.
- Add a simplified workflow editor view with a modern vertical canvas, plus Simple/Advanced/List mode toggle.
- Task cards now show a "Reviewing" badge while a task is in Plan Review.
- Usage dropdown now shows the Claude Fable weekly window and Grok CLI subscription credit usage.
- Task Detail terminal now shows its worktree, is shorter on mobile, and sits with Cost after Comments.
- Cursor CLI model-picker rows now surface reasoning/context-window metadata when the Cursor CLI reports it.
- Quick-add composer now shows icon-only priority/Fast controls with GitHub tracking beside attach.
- Move terminal shortcuts into the footer and collapse crowded terminal tabs into a dropdown.
- Show task Artifacts-tab documents expanded with Markdown by default.
- Done task cards group Archive and Revert into one dropdown.
- Priority selection in quick add and task cards is now color-coded by urgency (blue low, amber high, red urgent).

### Fixed

- Cursor CLI models now appear in Fusion's model picker when the Cursor CLI provider is enabled.
- Terminal now auto-reconnects on first launch instead of getting stuck on "Disconnected".
- Task card size badge (S/M/L) no longer drops onto a misaligned second row on cards with extra badges.
- Task card size badge (S/M/L) now sits flush against the card's right edge.
- Stop false "Anthropic OAuth expired" notifications when the token is actually valid.
- Fix the Artifacts preview "Add comment" button doing nothing when clicked, and label the preview as read-only.
- Tidy the board quick-add composer and add a visible task-card actions menu.
- Show partial estimated costs across all Command Center cost views when some model pricing is unavailable.
- Daemon exits non-zero on signal termination so Restart=on-failure restarts it after a memory-pressure kill.
- Prevent stale Planning notifications from pointing to missing sessions.
- Fix the GitHub/GitLab import preview panel being cut off on tablet-width screens.
- Fix misaligned padding on the Cursor CLI authentication card.
- Fix Cursor CLI model discovery and auth to use the real cursor-agent commands.
- The Cursor CLI binary path override now also applies to the model picker, not just sign-in/status.
- Fix the search icon overlapping typed/placeholder text in the Files — Project search input.
- Fix `fn agent stop`/`fn agent start` hanging up to 60s per retry instead of exiting.
- Background memory-index refresh no longer keeps short-lived CLI/Node processes alive.
- qmd-backed project memory search no longer keeps short-lived CLI/Node processes alive.
- Fix background SQLite integrity checks holding short-lived CLI commands open unnecessarily.
- Grok and Cursor CLI models now appear in model pickers immediately after enabling the provider.
- Grok CLI models now run instead of failing with "not found in the pi model registry".
- Fix Grok CLI model picker showing prompt text instead of real model names.
- Grok now uses the key from ~/.grok/user-settings.json when GROK_API_KEY is not set.
- Grok CLI no longer requires a Fusion-visible API key — the CLI's own auth is enough to enable it.
- Archiving a task now releases its active-session lock so the next task can run Plan Review.
- Fix agents needing repeated stop/start because a stopped agent's heartbeat timer was never fully cleared.
- Triage recovers automatically when the planning model hits a provider 404/429 and no fallback is set.
- Bound durable-agent heartbeat worktree-acquisition retries and count exhausted failures.
- The engine now reacts to CLI `fn agent stop`/`start` promptly instead of waiting up to a minute for the audit sweep.
- Preserve prior failed review-step attempts so self-healing re-runs no longer erase the failure history.
- Board mutations from a tool session no longer silently land in the wrong project database.
- `fn task show`/`move` now retry through a momentarily locked board database instead of failing.
- All `fn task` subcommands now retry a momentarily locked board database and exit promptly instead of hanging or leaking.
- Recovery and oversight now wait for approval-blocked tasks instead of resuming them early.
- `fn branch-group`/`fn pr` now retry a locked board database and exit promptly instead of hanging or leaking.
- `fn backup`/`memory-backup`/`mcp`/`db vacuum` now retry a locked board database and exit promptly instead of hanging.
- CLI research/settings-import/agent-export/git/project commands close board stores promptly and retry a locked database.
- The planner overseer now detects and recovers stalled in-progress tasks instead of leaving hung executors stuck.
- Harden the dashboard server so provider API keys keep persisting even if a host forgets to wire auth storage.
- Fix manual merge hold tasks being marked failed when auto-merge is off.
- Manual merge hold now applies to shared-branch-group tasks whose group has dissolved.
- Mobile Settings search icon now sits inline next to the section dropdown.
- Tighten the mobile Settings layout — dropdown-only section picker, single-row footer, and slimmer header/footer.
- Grok CLI models now run via the grok CLI when no Fusion-visible API key is set.
- The latest OpenAI GPT-5.6 models now appear everywhere, not just the Settings model list.
- Fix empty estimated cost on the dashboard so priced runs show a dollar amount.
- Route no-key Grok CLI chat and fallback model selections through the bundled CLI runtime.
- GPT-5.6 codex models (luna, sol, terra) now actually appear in the codex model picker.
- Fix mobile model drop-down lists so they scroll by touch.
- Route Grok CLI models through the logged-in grok CLI in packaged hosts without requiring GROK_API_KEY.
- Fix oversized icons and spacing on the MCP servers settings page.
- Fix Grok CLI chat failing instantly with a "Response failed" error.
- Fix the Artifacts tab count for default-scope dashboards.
- Fix mobile Settings footer spacing so version text no longer overlaps actions.
- Style the Thinking Level dropdown to match the dark model picker across all surfaces.
- Fix Skills view showing "Skill not found" when opening any skill's content.
- Plugin skills now show for the project that enabled them, even when the daemon starts elsewhere.
- Show a No message placeholder for empty assistant chat replies.
- Grok CLI failures now show the actual error instead of an empty chat message.
- Task cards no longer wrap the header when a task was created by an agent — the agent badge moved to a bottom row.
- Surface Grok CLI runtime failures instead of empty chat replies.
- Fix Chat header showing thread controls while the conversation list is displayed after re-entering Chat.
- Tighten margins and padding across all mobile Settings pages for a more compact layout.
- Estimated cost on the dashboard stays populated as runtime model catalogs drift.
- Surface Grok CLI immediate no-message exits with actionable diagnostics.
- Fix the Thinking Level dropdown showing an unstyled white control in model pickers.
- Fix Grok CLI runtime sends to stream responses from xAI's real grok binary.
- Make Grok CLI chat replies reliable by using the stable headless JSON response.
- Usage view now shows meters only for AI providers you have configured.
- Fix a false "Project directory is not a Git repository" error that blocked all task execution in valid repos.
- Show the xAI logo for Grok model IDs across dashboard provider surfaces.
- Recover tasks stranded by missing worktrees during merge/review and allow retry.
- Mobile Settings footer shows the compact "v0.x" version instead of the full word.
- Usage view now hides Gemini when it isn't configured for metering or its login has expired.
- Fix the List view controls and quick-add box being cut off on tablet-width screens.
- Use the real Cursor logo in the usage dropdown, model selection, and other provider surfaces.
- Stop false "OAuth token expired" push notifications for providers that silently refresh (e.g. GitHub Copilot).
- Fix terminal header wrapping and spacing when the panel is narrow.
- Artifacts view — Task Documents sidebar now shows clearer task grouping and more space between tasks.
- Agents now auto-clear error state and retry on their next heartbeat instead of getting stuck.
- Fix the Artifacts Task Documents list rendering as blank rows when documents are loaded.
- Stop recording advisory "merger awaiting-confirmation" planner interventions that never block auto-merge.
- Fix the mobile Todo view so the list panel fills full height on selection.
- Coordinate durable-agent error recovery across heartbeat and self-healing.
- Fix push to remote after merge never running; pick the push remote and target branch from dropdowns in settings.
- Make stranded AI merge recovery bind to the reviewed clean-room commit.
- Honor assigned agent models in execution and warn on default-model fallbacks.
- Fix cramped padding on the Notifications "Failure notification mode" settings card.
- Fix Grok CLI chat returning errors or empty replies in the dashboard.
- Fix header connection pill showing "Desktop Desktop" and mixed font sizes.
- Fix Memory insights parsing and modernize the Memory, Insights, Todos, and agent Memory views.
- Polish the Memory view: centered layout, labeled editor toolbar, aligned toggle rows.
- Reconcile completed and stale generated-fix mission invariants.
- Settings on mobile now keeps showing the GitHub star count.
- Keep task detail per-model cost tables horizontally scrollable on mobile.
- Tasks are no longer stuck "awaiting release authorization" — the over-firing release gate was removed.
- Fix Settings GitLab row overflowing its panel and the footer Save button clipping.
- Polish first-run setup: connected providers first, state-driven GitHub step, fixed radios, deduped node picker.
- Auto-heal wedged SQLite connections in place instead of failing every request until restart.
- Task API operations no longer fail with 500 when a task's PROMPT.md can't be read; server also logs 500 causes.
- "Update now" now explains permission (EACCES) failures and how to fix them instead of showing raw npm errors.

### Performance

- Fix a slow dashboard memory leak where archived tasks were never evicted from the in-memory badge cache.

### Internal

- Removed leftover UI/i18n/docs for the deleted "awaiting release authorization" planning hold.
- Update the bundled pi SDK to 0.80.6.
- Document the planner-overseer eye badge on task cards.

## 0.57.0

### Highlights

- fn_task_attach now refuses to read files outside the task worktree boundary.
- Archived tasks now load newest-first in pages of 100 with a Show more button.
- Planning Mode's "go deeper" prompt now suggests plan-specific topics instead of generic buckets.
- Edit a chat message and resume the conversation from that point.
- Built-in runtime plugins (Hermes, Paperclip, OpenClaw, Droid) can now be disabled and stay disabled across restarts.

### New

- Archived tasks now load newest-first in pages of 100 with a Show more button.
- Planning Mode's "go deeper" prompt now suggests plan-specific topics instead of generic buckets.
- Edit a chat message and resume the conversation from that point.
- Built-in runtime plugins (Hermes, Paperclip, OpenClaw, Droid) can now be disabled and stay disabled across restarts.
- Chat search now matches message content, with a "Search in title only" toggle.
- Hermes-configured models now appear in Fusion's model picker when the Hermes runtime is available.
- Edit and resend a message in task-detail Planner Chat.
- Duplicate tasks are no longer auto-archived on creation by default — they are flagged for review instead.

### Fixed

- fn_task_archive and fn_task_delete now accept removeLineageReferences to clear a lineage-parent block.
- Agents now know they run inside Fusion and won't plan actions across a platform shutdown.
- Custom providers can now enable Anthropic-style prompt caching to stop re-billing the full context each turn.
- Approval cards now show the gated command/arguments and dedupe repeated pending requests.
- Fix Planning Mode Back button showing a generation screen instead of the previous question.
- Auto-approve plan toggle now appears only on the planning column, not Todo.
- Fix Quick Add action-row buttons (Save, Attach, Fast, workflow trigger) rendering at mismatched heights.
- Quick Add action-row controls now resolve one identical box height, not just a min-height floor.
- Warn when changing a workflow's model surfaces tasks still pinned to the old model, including default-workflow tasks.
- Retry transient OAuth token-rotation errors so in-flight agent calls survive rotation without failing the task.
- Executors now block on pending approvals instead of probing for ungated workarounds.
- Fix workspace-mode tasks failing auto-merge under the pull-request merge strategy.
- New tasks now land in the selected workflow's intake column instead of always jumping to Planning/triage.
- Yes/No chat question buttons now show a clear selected state after clicking.
- Planning Mode "needs input" now shows a yellow nav badge instead of a top banner.
- Task-detail Oversight button now matches Priority/Execution-mode height on desktop.
- Fix mobile dashboard terminal sometimes rendering completely blank on open.
- Fix the mobile terminal shortcut bar so it truly scrolls horizontally to reach every key.
- Fix desktop app showing a truncated provider/model list vs. the web build.
- Fix desktop app plugin install and Browse registry (plugin subsystem now wired into the embedded server).
- Fix onboarding GitHub sign-in button erroring instead of starting GitHub auth.
- Authentication settings always lists all supported providers, regardless of connected runtime plugins.
- Add a close button to the Settings screen on mobile.
- Hermes Runtime is now additive — connecting it no longer hides your custom providers, models, or auth options.
- Align Priority and Execution-mode control heights with the Oversight dropdown in task detail.
- Fix the task-detail Planner Chat stop button rendering narrower than its send button.
- Fix cards stranded after workspace/out-of-band merges land; node-override end no longer silently no-ops.
- Code Review/Plan Review/CE gate failures now record a diagnostic instead of "(no feedback captured)".
- Fix agents on long heartbeat intervals silently going stale for hours.
- Fix provider API keys being wiped when the desktop and CLI apps share credentials on one machine.
- Route node settings-sync and mesh credential writes through the coordinated auth store to prevent concurrent clobbers.
- Fix tasks in planning/intake columns starting execution before they were specified.
- Switching projects now lands on the Board instead of Settings when the last-visited view was Settings.
- Removed the chat "Search in title only" toggle; chat search always matches message content and title.
- Automation live output no longer shows "Run failed" for runs that actually succeed.
- Planner chat stop button now shows just the stop icon, not a text label.
- Restore the chat "Working…" indicator immediately when returning to a session with an active generation.
- Retain GitHub issue import state when leaving and returning to Import Tasks.
- Built-in workflow boards and Automations editors now label the intake column "Planning", not "Triage".
- The Command Center SDLC funnel now labels the intake stage "Planning", matching the renamed board column.
- Auto-recover durable agents stuck in transient error state even when their manager is active.
- Task cards no longer show the steps breakdown while in the Planning column.
- Align the quick-add workflow dropdown button height with Save/Fast/Subtask buttons.
- On tablet widths, move terminal shortcuts/zoom controls into the bottom footer so they no longer overlap header icons.
- Keep the mobile top header on a single line after a foldable phone is unfolded and refolded.
- Fix Anthropic-compatible custom providers registering under an unregistered API key.
- Fix merger awaiting-confirmation copy that implied a hard block when auto-merge proceeds automatically.
- Fix the terminal rendering blank on mobile even though the shell prompt already loaded.
- Fix workspace partial-land recovery losing the already-landed sub-repo sha.
- Fix workspace sub-repo worktree creation failing on absent shared branch.
- Prevent redundant polling and a re-render loop in agent-card runtime-fallback badges.
- Clear stale generated mission fix features after their source feature passes validation.
- Stop the false "OAuth token expired" push notification on startup.
- Preserve Hermes chat session state and project runtime routing more reliably.
- Stop the usage telemetry log from growing without bound and bloating the Fusion database.

### Security

- fn_task_attach now refuses to read files outside the task worktree boundary.

### Performance

- Fix dashboard terminal showing a blank screen for seconds before the first prompt appears on open.
- Add a one-time server log hint pointing to shell-profile-hygiene docs when a login shell is slow to prompt.

## 0.56.1

### Highlights

- Fix Anthropic subscription showing "logged in" while all model calls fail.
- Fix "Invalid transition" error when moving cards out of a custom workflow column like Coding (Ideas) → Ideas.
- Fix overlapping Record and Clear buttons in the Keyboard Shortcuts settings rows on desktop and mobile.
- Fix persistent mobile terminal inter-character spacing (5th recurrence root cause).
- Fix manual PR actions hidden when a task auto-merge override was on but global auto-merge was off.

### Fixed

- Fix Anthropic subscription showing "logged in" while all model calls fail.
- Fix "Invalid transition" error when moving cards out of a custom workflow column like Coding (Ideas) → Ideas.
- Fix overlapping Record and Clear buttons in the Keyboard Shortcuts settings rows on desktop and mobile.
- Fix persistent mobile terminal inter-character spacing (5th recurrence root cause).
- Fix manual PR actions hidden when a task auto-merge override was on but global auto-merge was off.

## 0.56.0

### Highlights

- Remove the eye icon markdown/plain toggle from chat; messages always render as Markdown.
- Expand first-run AI provider quick-start choices beyond Anthropic.
- Show Git prerequisite guidance during first-run GitHub onboarding.
- Add GitHub OAuth and CLI setup actions to first-run onboarding.
- Add configurable dashboard keyboard shortcuts for Quick Chat and Terminal.

### New

- Expand first-run AI provider quick-start choices beyond Anthropic.
- Show Git prerequisite guidance during first-run GitHub onboarding.
- Add GitHub OAuth and CLI setup actions to first-run onboarding.
- Add configurable dashboard keyboard shortcuts for Quick Chat and Terminal.
- Add search in Settings so operators can find settings faster.
- Add a pinned below-application layout option for the dashboard terminal.
- Add a Reset Settings button to restore a menu's or all project settings to defaults.
- Add a per-workflow planner oversight level setting (Off, Observe, Steer, Autonomous recovery).
- Tasks can override the workflow planner oversight level (Off, Observe, Steer, Autonomous recovery).
- Planner oversight now defaults to full steering/control for every workflow unless explicitly changed.
- Planner oversight now monitors tasks across executor, reviewer, merger, pull-request, and workflow-gate stages.
- Planner oversight can autonomously inject guidance, retry stuck/failed steps, and request fixes within bounded limits.
- Planner oversight now requires confirmation before merge/PR actions and destructive/external side effects.
- Planner overseer now stays fully hands-off for paused tasks and auto-merge-off / human-review tasks.
- Configure planner oversight level per task and per project in the workflow editor and task create/detail.
- Add a configurable planner-overseer notification verbosity level (Silent/Errors/Important/All).
- Add a task-detail planner-overseer intervention timeline (stage, reason, action, outcome, attempts, links).
- Emit planner-overseer run-audit events for observations, steering, retries, recovery, confirmations, and escalations.
- Add an AI-undo fallback task when reverting a done task via git conflicts or is unsupported.
- Add a Revert action to Done/Archived task cards to undo landed changes.
- Capture a structured performance snapshot when an agent task completes.
- Task cards can now show the planner overseer's active state (idle/watching/steering/recovering/awaiting-confirmation).
- Support reverting multi-repo workspace tasks via git, all-or-nothing across sub-repos.
- Add per-sha revert commit granularity to the task revert API and service.
- Add a dedicated Keyboard Shortcuts settings section with click-to-record capture and more configurable actions.
- Open a revert PR for done/archived tasks when autoMerge is disabled instead of refusing.
- AI-undo tasks now default to a configurable, stricter review workflow.
- Plan auto-approval is now the default; specified tasks skip manual approval unless you opt into workflow/require-all.
- Fusion self-repo issue-close comments now show current and target release versions.
- Open one revert PR per sub-repo for workspace tasks when autoMerge is disabled.
- Add a Settings → General picker to choose the workflow used for AI-undo (revert) tasks.
- Add "Ask user question" and "Exit gate" workflow nodes for mid-flow chat reach-out and early exit.
- Add a built-in "Brainstorming" workflow that talks to you before planning.
- Add a "Coding (Ideas)" workflow with a manual Ideas intake and a merged Todo planner column.
- Add a workflow setting to disable automatic large-task triage splitting.
- Add before-to-after transformation summaries to generated task definitions.
- Show first-token and tool processing durations in task agent logs.
- Settings descriptions now show each setting's default value.
- Add an intelligent git-revert engine service and POST /api/tasks/:id/revert route.
- Original task prompt now renders as Markdown and is collapsed by default in the task Plan tab.
- Move the planner intervention timeline into the task Activity view dropdown.

### Fixed

- Show active Plan Review progress on triage task cards.
- Clarify task-detail oversight Nudge/Explain controls: visible label, disabled reason, always-openable Explain panel.
- Unify border, radius, and height of the task-detail Priority/Execution/Oversight controls.
- Keep the task-detail Activity view menu open during mobile iOS taps.
- Fix Anthropic subscription login when pasted callback URLs contain fragment OAuth parameters.
- Fix Claude/Anthropic subscription re-login showing "Login did not complete" after logging out.
- Stop self-healing from killing actively-running tasks after ~30 minutes.
- Stop Windows Terminal version dialogs from popping up when opening the dashboard or Settings on Windows.
- Select newly created folders automatically during project setup.
- Prevent Desktop update banners from using 0.0.0 as the current version.
- Quit Fusion Desktop on Windows when the window is closed.
- Open desktop Anthropic Subscription OAuth logins in the system browser.
- Delay GitHub setup warnings for one day and add a dashboard connect action.
- Fix a false AI engine not running banner in desktop mode.
- Clarify the desktop Connection Manager add-remote flow.
- Restore Local Server in the desktop Switch server list.
- Make right-dock task list clicks respect the task popup setting.
- Auto-retry retryable Code Review remediation failures.
- Fix no-op task branch recovery after a previously landed task.
- Allow documented source-free task-artifact deliveries to finish without commits.
- Fix direct merges so Push to remote after merge honors the configured remote and branch.
- Keep task popups on the board layer with Activity menus above them.
- Keep accepted chat requests waiting instead of showing false first-event timeout failures.
- Show each task's original prompt in the Plan tab alongside the generated plan.
- Restore terminal Ctrl/Cmd copy and paste shortcuts.
- Fix mobile Chat composer being hidden behind the keyboard accessory bar.
- Auto-approve now reliably sends specified plans to the board without a manual approval stop.
- Fix the in-dashboard Switch server menu not switching desktop local/remote.
- Fix branch group completion checklists to show accurate landed/finished counts.
- Branch groups no longer report complete (or become promotable) when an unlanded member is archived.
- Fix the global GitLab integration setting not persisting when saved.
- Fix task-detail Activity view dropdown not opening reliably on mobile.
- Manual "Run now" for the Database Backup automation now runs in-process like the scheduler, matching cron behavior.
- Task cards no longer show the "Auto-recovery" oversight badge unless oversight is explicitly configured.
- Remove the per-card overseer-state ("Executor") badge from task cards.
- Fix agent-created artifacts not appearing live in the dashboard artifacts view.
- Fix the mobile terminal shortcut bar so it scrolls horizontally to reach every key.
- Planner-oversight intervention timeline now populates from real engine activity.
- Show the "Global" prefix on the Authentication entry in the mobile Settings picker.
- Tasks held for release authorization or Plan Review are now shown distinctly, so auto-approve no longer looks broken.
- Move mobile terminal controls into a bottom footer so they no longer crowd the header, with a scrollable shortcut bar.
- Stop the release-authorization gate from holding tasks that merely disclaim releasing.
- Fix mobile terminal text still rendering with excess inter-character gaps after font-load settle.
- Stop Plan Review from looping tasks forever and fix its "can't find the plan" reviews.
- Planner-overseer task badge now shows a readable label and explains what it is waiting on.
- Plan approve/reject API now blocks release-authorization holds, requiring the authorization marker first.
- Pin the mobile terminal close (X) button to the top-right corner so it is easy to find and tap.
- Fix mobile terminal excess character spacing that survived earlier font-remeasure fixes.
- Manual plan approval no longer re-asks you to approve a plan you already approved when it hasn't changed.
- Expired Claude subscription logins now show disconnected with a re-login prompt; tokens auto-refresh before expiry.
- Anthropic subscription reads now refresh the OAuth token automatically instead of silently failing when expired.
- Stop GitHub tracking-issue creation from linking new tasks to old/closed issues.
- Clarify the oversight "Nudge unavailable" guideline so it no longer reads as an overseer fault.
- New tasks created under the Coding (Ideas) workflow now land in the Ideas column and wait for you to promote them.
- Fix tasks vanishing from the board after being added to a workflow like Coding (Ideas).
- Move the Before → After transformation summary to the top of generated task definitions.
- Task-detail Priority dropdown now matches the Oversight dropdown's size, border, and typography.
- Default workflow boards now label the intake column "Planning" instead of "Triage".
- Fix the task-detail Nudge control staying disabled when the overseer is actively watching.
- Honor mission branchStrategy when triage omits branchAssignment; skip validation for inactive missions.
- Planner overseer no longer marks healthy in-progress tasks as "recovering" or steers them.

### Breaking

- Remove the eye icon markdown/plain toggle from chat; messages always render as Markdown.

### Internal

- Rename downloadable CLI release binaries to the fn-cli-<platform> base name.

## 0.55.0

### Highlights

- Allow configuring permissions for ephemeral and permanent agents.
- Add GitLab instance URL settings for GitLab.com and self-managed servers.
- Add GitLab access-token settings for personal, project, and group tokens.
- Add GitLab project issue, group issue, and merge request imports.
- Add GitLab comment and auto-close lifecycle actions for linked work items.

### New

- Allow configuring permissions for ephemeral and permanent agents.
- Add GitLab instance URL settings for GitLab.com and self-managed servers.
- Add GitLab access-token settings for personal, project, and group tokens.
- Add GitLab project issue, group issue, and merge request imports.
- Add GitLab comment and auto-close lifecycle actions for linked work items.
- Add GitLab as a Command Center Signals connector.
- Add explicit onboarding choices to use, initialize, or clone a git repository.
- Let chat update existing agents without delete/recreate.
- Add a bundled Linear import plugin for creating tasks from Linear issues.
- Add a mandatory Planning Mode deepening checkpoint before final summaries.
- Add visible create buttons and recursive search to Project Files.
- Add a GitLab enable toggle and collapsible Settings controls.
- Add a Settings override for the local Cursor CLI binary path.
- Display linked GitLab tracking metadata and stale badges on tasks.
- Add sidebar rename buttons to direct Chat conversations.
- Collapse mobile Chat thread controls into one compact header row.

### Fixed

- Stop recurring Windows Terminal warning popups during terminal startup.
- Fix dashboard localStorage quota exhaustion from stale SWR caches and add a Clear local data escape hatch.
- Fix `fusion desktop` on Windows and published npm installs (Electron dependency, GPU/sandbox flags, dashboard reuse).
- First-run agent setup no longer errors on a duplicate CEO; desktop Switch-server button now opens the connection menu.
- Allow operators to delete archived tasks.
- Show workflow template block boundary connectors in the graph editor.
- Preserve the selected dashboard project across browser refreshes.
- Detect Cursor CLI installations that expose Windows cmd or bat shims.
- Preserve GitLab tracking metadata for CLI and extension imports.
- Keep Planning Mode Refine Further from getting stuck on duplicate generation.
- Show task status badges on Documents task groups.
- Suppress misleading Anthropic Subscription re-login banners when another Anthropic auth method is active.
- Keep Anthropic authentication cards grouped near the top in Settings.
- Stop planner model fallback loops with a clear terminal triage error.
- Recover stale task branch-group references from Task Detail after server restarts.
- Return GitHub issue import actions to the main issue list.
- Prevent Planning Mode sessions from failing when MCP resolution returns no shaped result.
- Fix Android mobile terminal spacing while the keyboard is open.
- Fix Last 30 days token usage to include every model in Command Center.
- Include supported chat interactions in Command Center token usage totals.
- Preserve workflow setting edits made while a values save is still in flight.
- Preserve migrated workflow settings when project identity is assigned later.
- Show the bundled Linear Import plugin in Plugin Manager and dashboard plugin surfaces.
- Fix the mobile Chat header so back navigation and session selection stay on one row.
- Fix iOS mobile terminal spacing when opening terminals with the keyboard already visible.
- Default fresh startup and theme reset to System mode.
- Remember task popup size and position when switching between tasks.
- Fix iPhone Safari terminal text spacing with the keyboard open.
- Count planning tasks correctly in the dashboard footer queue metric.
- Show conversation titles in the mobile Chat dropdown.
- Merges no longer fail when a task adds a dependency without updating the lockfile.

## 0.54.0

### Highlights

- Add a project setting to allow or block ephemeral agents from creating tasks (default on).
- Allow completed task planner Chat to answer and create refinements.
- Disabling ephemeral agents now also stops the workflow engine from running unassigned tasks.
- Align the task Activity view dropdown under its tab instead of drifting to the left of the modal.
- Fix the Windows CLI binary failing to build in release.

### New

- Add a project setting to allow or block ephemeral agents from creating tasks (default on).
- Allow completed task planner Chat to answer and create refinements.

### Fixed

- Disabling ephemeral agents now also stops the workflow engine from running unassigned tasks.
- Align the task Activity view dropdown under its tab instead of drifting to the left of the modal.
- Fix the Windows CLI binary failing to build in release.
- Fix the desktop app crashing on "Local" mode with missing-module errors.
- Planning mode no longer creates a new draft for every character you type.
- Preserve project scope when saving task-detail model overrides.
- Fix the All workflows dropdown counter so it no longer double-counts tasks.
- Normalize task-detail tab padding across Activity, Chat, and Plan views.
- Prevent task-bound agents from deleting the task they are currently executing.
- Reviews stop failing on formatting: approvals pass, trailing-JSON verdicts parse, retries clear stale gate failures.
- Stop showing "Task Failed" on a task whose code-review remediation is still running.
- Restore the board search button after closing the search panel.

## 0.53.1

### Highlights

- Fix the Windows CLI binary failing to build in release.
- Fix desktop app crashing on "Local" mode startup with a missing-module error.

### Fixed

- Fix the Windows CLI binary failing to build in release.
- Fix desktop app crashing on "Local" mode startup with a missing-module error.

## 0.53.0

### Highlights

- Add exact tool overrides for permanent-agent permission policies.
- Add a project option to link imported GitHub issues to GitHub tracking.
- Add Enable GitHub tracking to Board and List task context menus.
- Let task-detail planner Chat answer current-task token, cost, and timing questions.
- Add a Glass Silver dashboard theme.

### New

- Add exact tool overrides for permanent-agent permission policies.
- Add a project option to link imported GitHub issues to GitHub tracking.
- Add Enable GitHub tracking to Board and List task context menus.
- Let task-detail planner Chat answer current-task token, cost, and timing questions.
- Add a Glass Silver dashboard theme.
- Add a mobile terminal tab dropdown for switching and closing terminal sessions.
- Branching workflows now run on the graph interpreter; the legacy step-compiler and its interpreter-only banner are gone.
- Add All workflows to top-level dashboard workflow selectors.
- Add a Triage column shortcut for plan auto-approval.

### Fixed

- Allow Compound Engineering recovered sessions to answer persisted questions after dashboard restarts.
- Contain planning parse failures as retryable session errors and add `--supervise` dashboard restart mode.
- Fix Anthropic Claude subscription chats failing (404/502/429) by restoring direct OAuth execution.
- Fix tasks looping through triage at the completion-summary node, plus Stats/Routing/Node labels crashing.
- Prevent task branches from inheriting unrelated checked-out task commits.
- Fix arrow-key editing for Settings in the terminal dashboard.
- Make the task Activity tab switch Live, Feed, and Raw views directly.
- Show Refine in completed task card and list context menus.
- Fix mobile task action menus so tapped actions run once and close.
- Reuse the standard Chat surface for task-detail planner chat.
- Make mobile task-detail chat Send buttons submit on the first tap.
- Recover explicit Sonnet 5 chat selections with configured model fallbacks.
- Fix Windows desktop startup failures in packaged builds.
- Fix Board task context menus so they are not clipped by columns.
- Prevent mobile Board task long-press menus from selecting card text.
- Hide task planner chats from the common Chat feed unless enabled in Settings.
- Let the task popup setting open board tasks as popups on desktop too.
- Preserve task-detail planner Chat working state after leaving and returning.
- Keep sent chat messages visible when a provider error interrupts the reply.
- Let Planning Mode Yes/No questions accept a custom Other answer.
- Show thinking effort on task log model rows when it is configured.
- Enforce maxWorktrees as a hard cap on active execution worktrees.
- Stop force-advertising Anthropic Claude Sonnet 5 when account availability is unknown.
- Fix the mobile task Activity view dropdown so it opens above the tab strip without clipping.
- Keep the Planner Chat stop-generation icon visible on mobile while thinking.
- Hide failed-task banners while task planner chat is maximized.
- Make Planner Chat clarification questions answerable in task details.
- Close task details immediately after confirming task deletion.
- Honor project auto plan approval across task finalization paths.
- Make chat-created workflows appear immediately across workflow selectors.
- Recover live worktree conflicts by retrying with a fresh task worktree.
- Fix Activity expand controls so Live and Feed overlay content and Raw has one fullscreen button.
- Move destructive task context-menu actions to the bottom.
- Fix folded Android mobile terminal spacing on initial open.
- Show eligible Claude Sonnet 5 model rows once in model pickers.
- Restore Claude Sonnet 5 and latest Anthropic models in the Claude CLI model picker.
- Fix Anthropic subscription chat failing with 429/502 by routing it through the Claude CLI.
- Keep hidden task-planner Chat replies from lighting the global Chat unread badge.
- Fix desktop launch from npm installs in directories with invalid JSON.
- Keep Anthropic subscription OAuth, Claude CLI, and direct API-key auth separated.
- Ensure task lifecycle plugins receive runtime context during completion hooks.
- Show Claude CLI models when Anthropic subscription OAuth and Claude CLI are connected.
- Fix Compound Engineering Debug stage launches that could fail with a JSON parse error.
- Include graph-owned workflow step execution in Command Center activity analytics.
- Restore Claude Sonnet 5 in the model picker (it had disappeared from every surface).
- Enforce explicit external checkout metadata for review routing.
- Let proven task merges finalize even when old branch history remains.
- Widen Project Models dropdown menus so long provider and model names are easier to read.
- Give workflow review steps a longer default timeout.

### Internal

- Upgrade Fusion's bundled pi SDK dependencies to 0.80.3.

## 0.52.0

### Highlights

- Expose workflow authoring tools through the published agent extension API.
- Allow task image artifacts to be created from agent tools and viewed in task details.
- Add a setting to control whether clicking outside the Quick Chat window closes it.
- Add Anthropic API-key authentication under Authentication.
- Add a Tasks tab to the right sidebar that shows the last-viewed task or a clickable task list.

### New

- Expose workflow authoring tools through the published agent extension API.
- Allow task image artifacts to be created from agent tools and viewed in task details.
- Add a setting to control whether clicking outside the Quick Chat window closes it.
- Add Anthropic API-key authentication under Authentication.
- Add a Tasks tab to the right sidebar that shows the last-viewed task or a clickable task list.
- Let operators sort the board Done column by completion date or task ID.
- Add a Board dropdown option that shows tasks across all workflows.
- Show workflow-name badges on Board cards in the All workflows view.
- Add a terminal worktree picker for opening shells in task worktrees.
- Let Git Manager jump from worktrees to their read-only commit history.
- Let Git Manager inspect commit history from known git worktrees.
- Add task context menus on board and list cards.
- Add a mobile setting to open board tasks in the existing popup.
- Add a global setting to control modal backdrop dismissal.
- Add a project setting for absolute workspace file-browser paths.
- Add a quick-add workflow selector for Board and List task creation.
- Show workflow identity with icons instead of built-in text suffixes.
- Add Command Center task-duration trend lines for average and median completed active time.
- Add Claude Sonnet 5 across Anthropic model selection and execution paths.
- Add Activity segments for current task activity, Feed, and Raw Logs.
- Add a task-detail Chat tab for planner-model conversations.
- Add starter prompts to the task-detail Chat empty state.
- Convert clear task chat change requests into steering comments.
- Make task details open with a focused planner Chat experience.
- Let workflow review nodes fix issues in the same reviewer session by default.
- Make Coding use stepwise execution with default-on Plan Review and final Code Review gates.
- Rename the task Definition tab to Plan and add a PROMPT.md editor action.
- Make task details open Activity first by default with an opt-in Chat-first setting.
- Show timestamps on each task-detail chat block.
- Show workflow names on aggregate board cards and task detail headers when available.
- Let Git Manager inspect commit history from known worktrees.
- Refresh custom provider model lists at startup and from Settings.
- Make Shadcn Ember the default dashboard theme.
- Show workflow icons in the full New Task workflow picker.
- Add icon-only Quick Add image attachments with drag-and-drop support.
- Rename the task-detail Chat tab to Activity and make it first.
- Add a steering entry affordance to task Activity.
- Make task-detail Chat answer status and progress questions from bounded task context.
- Rename task Activity Current to Live and allow expanding all Activity segments.

### Fixed

- Plugin sidebar icons now refresh after a plugin rebuild instead of showing stale glyphs.
- Restore required safety guidance in fast-mode task planning prompts.
- Fast-mode tasks now clear optional steps by default while honoring manual selections.
- Review gates now include user comments and steering context consistently.
- Show focused auth-token recovery when daemon authorization expires.
- Prevent workflow task cards from showing later sequential steps active too early.
- Prevent fast Coding tasks from merging before implementation runs.
- Keep workflow completion summaries running for fast-mode tasks.
- Prevent Compound Engineering artifacts from showing stale project files after project switches.
- Keep the Goals dashboard view scoped to the selected project.
- Fix mobile Planning Mode description editing so spaces can be entered.
- Show Compound Engineering workflow stage progress on task cards and details.
- Chat messages now use the full width in narrow popup and sidebar chats.
- Concurrency panels now prefer live engine counts so running-agent totals stay accurate.
- Task-detail chat messages now use the full width in the right sidebar and narrow detail views.
- Import Tasks view now fills the full height of the screen for Issues and Pull Requests.
- Fix review tasks stuck when merge retries starve the executor's code-review revision pass.
- Fix planning/chat failures when image attachment bytes do not match the file extension.
- Apply task reviewer model overrides consistently to reviewer and code-review lanes.
- Workflow graph nodes now resume cleanly after engine pause-aborts.
- Compact collapsed tool-call summaries in task-detail chat.
- Show Z.ai icons for GLM model rows in Command Center token analytics.
- Show active tasks by default in the right sidebar and fix its task-detail back button.
- Keep Compound Engineering tasks running through checkout recovery, PR review policy, and merge handoff.
- Harden workflow graph recovery against stale plan replays and foreign landed tips.
- Prevent rebuilt stepwise workflow tasks from failing at parse on stale step pins.
- Add consistent Plan Review, Code Review, and Browser Verification toggles to engineering workflows.
- Make dashboard retry clear stale workflow step pins before re-execution.
- Separate Anthropic API-key auth from Claude subscription login cards.
- Let workflow graphs prepare task worktrees before coding-mode nodes run.
- Send ntfy notifications from workflow graph lifecycle and notify-node flows.
- Auto-retry stale parse pause-resume workflow failures instead of requiring operator action.
- Prevent Plan Review approvals from looping back into triage as failures.
- Route failed Plan Review workflow steps back through triage for automatic replanning.
- Prevent stale pause state from mislabeling workflow retries as engine pauses.
- Let workflow-owned steps finish out of order without false step-progress failures.
- Preserve files changed by workflow-owned parallel step sessions on task branches.
- Make built-in Code Review block merge when it requests revisions.
- Recover workflow retries that restart after step execution has already begun.
- Retry unavailable Plan Review without rewriting an accepted task plan.
- Keep Plan Review status visible while tasks execute after restart.
- Keep verification steps from starting before earlier workflow steps finish.
- Keep Plan Review status visible when execution resumes after stale merge cleanup.
- Stop routing failed workflow execution into the review column.
- Prevent workflow tasks from reaching Done without durable merge confirmation.
- Add inner padding to Task Detail chat message blocks.
- Prevent workflow tasks from completing with stale or partial merge proof.
- Swiping back on mobile now dismisses the open task detail view.
- Keep workflow merge nodes moving even when a workflow skips a review handoff.
- Show post-merge verification as a post-merge optional workflow step.
- Preserve dashboard workflow selections per project across Board, List, Header, and Graph.
- Prevent scoped workflow tasks from getting stranded by unrelated branch residue.
- Footer concurrency markers now line up with the running-agent counts.
- Keep Workflow simple-editor tabs reachable on mobile.
- Prevent executor prompt setup from failing when a recovered task has no saved prompt.
- Make task-detail Chat tool-call text easier to read without expanding collapsed rows.
- Keep built-in Code Review remediation recovering until review passes.
- Hide engine remediation banners while daemon auth token recovery is open.
- Retry unavailable Plan Review without rewriting existing task specs.
- Preserve explicit empty workflow step dependencies for parallel roots.
- Footer concurrency controls now ask before saving capacity changes.
- Show optional workflow block children as connected in the workflow editor.
- Remove deleted tasks from the board and right sidebar immediately after deletion.
- Stop logging non-actionable missing configured skill-pattern info messages.
- Reload the selected file when switching Files modal worktrees.
- Reuse fresh task data when returning to Board or List views.
- Dismiss mobile task details when Android Back is pressed before falling back to app exit.
- Preserve mobile board scroll after returning from task detail.
- Group Done column sort and archive actions in one accessible actions menu.
- Prevent fast workflow merges from completing before implementation steps run.
- Restore reliable terminal keyboard shortcuts in embedded CLI session terminals.
- Open Workflow simple-editor step details when rows are clicked.
- Make configured MCP tools available in planning and mission interviews.
- Preserve workflow setting values and prompt overrides during workflow export/import.
- Move the mobile task-detail workflow badge beside the updated timestamp.
- Fix the mobile Engine Controls menu placement.
- Document workflow-authoring tools in the packaged Fusion skill.
- Mobile back now reliably dismisses the open task detail, including right after closing and reopening it.
- Move All workflows Board task-card workflow badges to the bottom-left.
- Move task-detail workflow badges into the Updated timestamp metadata row.
- Restore the Board All workflows view after refresh.
- Fix mobile terminal spacing after folded viewport changes.
- Fix the mobile terminal workspace picker so its menu stays visible and reachable.
- Collapse custom shadcn color controls by default in dashboard theme surfaces.
- Remove the board quick-add Plan button while keeping New Task planning available.
- Fix mobile terminal spacing when folded phones open with the keyboard already visible.
- Let Anthropic subscription login power Anthropic model requests without a raw API key.
- Make built-in Plan Review and Code Review revisions unbounded unless workflows set a cap.
- Refresh dashboard task state immediately after Retry succeeds.
- Show workflow icons and wider names in the Quick Add workflow selector.
- Count ephemeral task-worker runs in Command Center activity stats.
- Fix mobile terminal character spacing after small font-size changes.
- Hide Quick Add node pickers when only local execution is available.
- Make the Quick Add workflow selector compact while keeping long menu names readable.
- Preserve legacy task feed and raw log access under Activity.
- Reuse the shared question UI for task-detail planner Chat clarification prompts.
- Fix mobile Planning Mode summary description Expand and Collapse controls.
- Collapse task-detail branch groups by default with a more compact summary.
- Hide branch group chrome while the task Activity chat is maximized.
- Move the Quick Add attachment button next to Save in the expanded action row.
- Keep Planner Chat compact while preserving expanded task controls.
- Rename the task-detail title summarization button to Summarize.
- Remove the AI Refine action from Quick Add task creation.
- Make task planner chats appear only after user interaction and expire on archive.
- Make Shadcn Ember color tokens match Ember exactly.
- Align footer concurrency current-use dots with Command Center sliders.
- Replan active tasks after confirming execution-mode changes.
- Preserve board column scroll during dashboard refresh and viewport stabilization.
- Remove the extra steering guidance copy from task Activity chat.
- Replace task Activity subtabs with a compact Live, Feed, Raw dropdown.
- Persist Remote Access settings when saving from the dashboard on Windows.
- Keep the mobile Planning Mode New session button pinned at the bottom.
- Use workflow Plan Review as the single pre-execution plan gate.
- Keep Plan Review in triage and prevent duplicate execution-time plan reviews.
- Preserve Quick Add tasks with all workflow optional steps unchecked.
- Record completion summaries for workflow-driven tasks.
- Block workflow tasks from bypassing merge proof when finalizing to done.
- Show workflow review failures as explicit replan and remediation nodes.
- Stop showing stale in-review stall badges while agents are actively streaming logs.
- Keep dashboard workflow selection stable after creating refinement tasks.
- Prevent workflow tasks from duplicating plan review during implementation.
- Retry workflow merge-node pause aborts while merge review is active.
- Keep Planner Chat compact on mobile with an inline composer and provider-icon model badge.
- Add task activity breadcrumbs for workflow pause-abort recovery.
- Align per-step review coding with default coding gates and session settings.
- Stop repeat no-op phantom-reservation audit writes and preserve the worktree across phantom binding reclaim.
- Make the task Plan prompt editor span the full task-detail card width.
- Scope external-integration plan evidence checks to Coding (per-step review).
- Keep Planner Chat expanded context visible while removing repeated header guidance.
- Compact Planner Chat chrome and align Activity Live with the same plain composer row.
- Keep Planner Chat spacing stable when expanding task details.
- Keep refinement tasks on the source task workflow board.
- Refresh branch group task-detail completion live as member tasks change.
- Remove the icon from the Quick Add Plan action while preserving the text button behavior.
- Remove redundant workflow labels from expanded task-card step lists.
- Allow review steps to target a validated external checkout.
- Keep task-detail Activity segment tabs equal-height with smaller labels.
- Retry configured fallback models when a selected provider model returns a not-found error.
- Wait for task store secret database handles to close before cleanup.
- Add clearer spacing between workflow badge icons and labels.
- Keep Board and List workflow choices selected across refreshes and route returns.
- Prevent stale workflow recovery log entries from sending incorrect notifications.
- Harden workflow lifecycle recovery, post-merge gates, warnings, and notifications.

### Performance

- Skip unchanged plugin builds during workspace builds.

## 0.51.0

### Highlights

- Add a Chat tab to the right sidebar so you can chat inline and pop it out.
- Tasks with a manually-created open Pull Request are no longer auto-merged.
- Fast-mode tasks now plan with a lean, speed-first prompt routed through the workflow.
- CE HTML plans and brainstorm docs now get report-only ce-doc-review instead of being skipped.
- CE HTML docs now support DOM-validated in-place ce-doc-review fixes with report-only fallback.

### New

- Add a Chat tab to the right sidebar so you can chat inline and pop it out.
- Tasks with a manually-created open Pull Request are no longer auto-merged.
- Fast-mode tasks now plan with a lean, speed-first prompt routed through the workflow.
- CE HTML plans and brainstorm docs now get report-only ce-doc-review instead of being skipped.
- CE HTML docs now support DOM-validated in-place ce-doc-review fixes with report-only fallback.
- Close the Quick Chat window by clicking outside it.
- Emit run-audit telemetry for agent performance reflections.
- CE HTML docs can define and safely repair malformed checklists in ce-doc-review.
- Add a project setting to show or hide worktree names and grouping on the board.
- Refinement tasks are now titled with the source task ID followed by the entered comment.
- Add a project setting to open task details in the right sidebar instead of the full panel.
- The Create PR dialog is now movable and resizable like other Fusion pop-outs.
- Add a pin toggle to the right sidebar to push content aside instead of overlaying it.
- Task detail Review tab now hides HTML comments and shows comment avatars, human/bot badges, and author-type filtering.
- Add project settings to customize the AI prompts for PR title and description generation.
- Improve AI-generated PR titles and descriptions, and show a clear loading state while the description generates.
- Add an "Address PR feedback" button that starts an AI session to resolve PR review comments.
- Re-engage an executor when users chat on in-review tasks.
- Project Dashboard cards now say "Stop engine"/"Start engine" instead of "Pause"/"Resume".
- The PR number in a task's Pull Request tab now links to the pull request on GitHub.

### Fixed

- Artifact lists now refresh live when new artifacts are registered.
- Agents no longer pause tasks on failure — pausing is reserved for explicit user requests.
- Permanent agents can ask the user a question directly without an approval gate.
- Compound Engineering now uses a distinct sidebar icon instead of duplicating Insights.
- Compound Engineering sidebar navigation now matches its Boxes header icon.
- Ephemeral/task-worker agents now show their token usage on the dashboard.
- Stopping the engine or pausing a project now frees its global agent slots for other projects.
- Missions tab now always opens the mission overview instead of a specific mission.
- Theme the quick-entry steps drop-down with canonical dashboard menu tokens.
- Running-agent counts include active in-review agents, and the concurrency use-marker is no longer off by one.
- Tasks sent back by Code Review or Browser Verification verdicts now re-run and complete their steps before re-checking.
- Footer no longer blinks and the concurrency panel stays open across status refreshes.
- Keep Create PR preview commit SHAs readable on one line.
- Stuck triage re-queues now resume from the drafted plan instead of restarting planning from scratch.
- Stuck re-queue no longer loses uncommitted work while keeping steps marked complete.
- Fix the Create PR dialog spinner, diff preview default, and stray-click dismissal behavior.
- PR badge color now follows GitHub status: green/gray/purple/red plus a conflict color.
- Show active project pull requests in the Pull Requests sidebar and main view.
- Fix "Request revision" error on reviewer-agent task reviews.
- Fix Compound Engineering, Quick fix, and Review-heavy workflow tasks getting stuck in Todo.
- Theme quick-add optional-step checkboxes and phase badges consistently.
- Keep Summary token table model names readable in narrow task detail panels.
- Pressing q (or Ctrl+C) in the TUI now quits cleanly without engine logs bleeding onto your shell.

## 0.50.0

### Highlights

- Mutating agent tools now obey each agent's permission policy instead of always being allowed.
- Add confirmation prompts before Command Center concurrency sliders save live capacity changes.
- Agents now receive more tools, with dangerous actions governed by each agent's permission policy.
- Reject malformed workflow graphs before they can be saved or launched.
- Permanent/custom agents can use governed workflow and task-promotion tools.

### New

- Add confirmation prompts before Command Center concurrency sliders save live capacity changes.
- Agents now receive more tools, with dangerous actions governed by each agent's permission policy.
- Reject malformed workflow graphs before they can be saved or launched.
- Permanent/custom agents can use governed workflow and task-promotion tools.
- Permanent and custom agents can list, show, and search tasks during heartbeat runs.
- Failed optional workflow steps now send tasks back for a bounded executor fix pass.
- Footer concurrency panel shows running-agent counts and current-use markers on global and project sliders.
- Command Center Concurrency now shows running agents and current-use markers on global/project sliders.
- Configured MCP servers now reach every agent surface, including heartbeat runs.
- Configured MCP servers now reach dashboard planning helpers like subtask breakdown, text refine, and insights.
- New projects now default AI merge to sync a dirty checked-out integration branch.
- Add an "Other" free-text answer to planning and mission interview questions.
- Imported GitHub issues are now linked as tracked tasks when GitHub tracking is on.
- Add a per-project plan-approval mode to auto-approve or require approval for all tasks.
- Add external notifications for CLI agent tool-permission prompts.
- Add a New Chat button to the mobile chat quick-switch dropdown.
- Configured MCP servers now connect to chat and agent sessions and expose their tools.
- Code Review and Browser Verification now cycle fixes until they pass, defaulting to up to 3 fix passes.
- Workflow steps like Code Review and Browser Verification can set their own max fix revisions.
- The Browser Verification workflow step now uses the agent-browser tool, checks availability, and logs its actions.
- Done tasks now open on a new Summary tab showing what changed and what the agents did.
- Stack multiple queued chat messages above the composer and send them in order.
- Show an estimated token count against the model's context window in the chat thread header.
- Done-task Summary tab now shows token usage by model with estimated cost per model and a task total.
- Add optional Compound Engineering document review to the built-in CE workflow.
- Add a per-workflow analytics tab to the Command Center dashboard.
- Settings → Prompts now links to Workflow Editor prompts and clarifies prompt ownership.

### Fixed

- Fix PR-mode auto-merge failing with "error connecting to <branch>".
- Fix tasks getting stuck in review forever after a pre-merge code-review revision.
- Fix legacy databases missing newer task columns (e.g. checkout-lease, column dwell) after upgrade.
- Fusion co-author attribution now lands reliably on every commit it makes.
- Phantom duplicate tasks no longer break archive with an ENOENT error.
- Make skill detail metadata render more compactly in the right Skills panel.
- Fix Files viewer previews for images, video, audio, and PDFs.
- Task creation no longer leaves orphaned reserved-ID records when a create fails partway.
- Concurrency panels now show the real number of running agents instead of 0 when tasks are in progress.
- fn project list/info now show live running-agent counts from in-progress tasks.
- Recover corrupt messaging indexes during send or report the exact repair command.
- Database backup automation failures now report which database and the underlying cause.
- Stop plan-approval tasks from showing an empty-mailbox approval banner.
- The running-agents count now includes agents actively triaging tasks, not just executors.
- Project health In-Flight Agents now counts agents actively triaging tasks.
- Suppress brief footer Connecting flashes after one transient executor stats poll failure.
- Show every used model in Command Center token-by-model detail charts.
- Preserve override column-agent models during task execution.
- Show queued Chat messages above the input box with a divider.
- The task Workflow tab now shows the configured project Executor/Reviewer/Planning model instead of "Default".
- Add a visible close button to the footer engine-controls popover.
- Govern task creation and delegation with the task_agent_mutation permission policy.
- Permanent agents now obey approval/block policy when creating tasks.
- Include triage/planning model usage in Command Center Tokens by model.
- Fix workflow view so the Code Review and Browser Verification blocks show connected edges.
- Show linked task columns in agent Current Task output.
- Show linked task columns on dashboard agent task badges.
- Show every token-consuming model in Command Center token breakdowns.
- Pressing q (or Ctrl+C) in the TUI now always quits, even if a teardown step stalls.

### Security

- Mutating agent tools now obey each agent's permission policy instead of always being allowed.

### Internal

- The task detail tool is now named fn_task_show consistently across triage, planning, chat, and CLI surfaces.
- Concurrency panels now read running-agent counts from a single live source shared across the app.
- Align Compound Engineering brainstorm artifacts with unified plan discovery.

## 0.49.0

### Highlights

- Add a default-on, toggleable pre-merge Code Review step to the built-in coding workflows.
- Verification now runs only the tests affected by a task's changed files, so merge/step checks finish in seconds.
- Record signed signal connectors in Command Center incident metrics.
- Add an engine-disconnected dashboard banner with one-click Start engine.
- Show provider icons next to Command Center model names.

### New

- Add a default-on, toggleable pre-merge Code Review step to the built-in coding workflows.
- Verification now runs only the tests affected by a task's changed files, so merge/step checks finish in seconds.
- Record signed signal connectors in Command Center incident metrics.
- Add an engine-disconnected dashboard banner with one-click Start engine.
- Show provider icons next to Command Center model names.
- Preview images, videos, audio, and PDFs directly in the Files modal.
- Add optional workflow-step quick dropdowns to task creation surfaces.
- Add core MCP server settings model with project/global precedence and secret references.
- Forward configured MCP servers to all AI lanes and add reachability validation.
- Add `fn mcp` CLI to manage MCP servers, import Claude Desktop config, and export Fusion MCP JSON.
- Add MCP server management UI in Settings with global/project scopes, validation, and import/export.
- Automations popup is now movable and resizable like other Fusion pop-outs.
- Automation AI steps now run with all tools by default, with a per-step tool selector and live run output.
- Enabled optional workflow steps now run and show in task progress reliably.
- Make Remote Access settings visible without enabling an experimental flag.
- Auto-discover MCP servers from Claude/Cursor/Windsurf/VS Code and opt-in to enable them in Settings.
- Adjust the global concurrency cap from the footer and dashboard; settings grouped by global vs project scope.
- Add a Worktrees setting for copying repository files into new task worktrees.

### Fixed

- Keep task-detail Chat and Workflow tabs aligned on displayed model names.
- Fix random fusion crashes when multiple dashboards/CLIs run on one host.
- Fix unreadable info-toast contrast and dashboard CSS token regressions.
- Fix global settings (including the global concurrency cap) intermittently resetting to defaults.
- Restore dashboard Settings helper copy and TaskChat tool-call labels.
- Preserve the selected workflow when Missions creates tasks.
- Restore animated loading spinners across the Fusion dashboard.
- Ignore hidden dot paths in overlap scheduling by default with a Settings toggle.
- Make browser and Android Back close dashboard task detail before leaving the current view.
- Fix Command Center token usage updating live without manual refresh.
- Prevent Planning Mode summary buttons from overlapping on tablet screens.
- Make Plan Mission with AI desktop modal movable and recover cleanly from stream failures.
- Prevent Planning Mode from crashing on malformed AI summary arrays.
- Allow Planning Mode generations to continue while meaningful AI output is progressing.
- Recover mission AI planning from transient stream interruptions.
- Stop showing branch reattachment warnings in Task Detail.
- Fix discarding mission interview drafts from the Missions view.
- Fix excessive spacing in the embedded Automations pane.
- Fix mobile Missions back navigation from mission detail tabs.
- Keep New Task mobile dialog controls tappable while the keyboard is open.
- Exclude engine-down time from task duration badge and stats.
- Restore horizontal scrolling for mobile task detail tabs.
- Fix workflow editor so the Browser Verification block shows connected edges.
- Retry transient ntfy publish failures so one-shot task notifications are less likely to be lost.
- Command Center date-range presets now correctly filter charts.
- Make the AI session needs-input banner compact and hide it on Missions or Planning.
- Prevent long Skills list rows from overflowing the left pane.
- Open dependency Graph tasks in the shared movable task pop-out.
- Preview image, video, audio, and PDF files natively in the right-dock Files viewer.
- Match the optional steps dropdown trigger to shared task creation buttons.
- Workflow and automation steps now use the configured project Execution model instead of the default.
- Fix task Workflow tab showing "Step definition not found." for Code Review and other optional steps.
- Quick task input no longer refocuses itself after you add a task.
- Capitalize the built-in Code Review step name consistently.
- Restore mobile swipe scrolling when touching task-detail tab buttons.
- Restore horizontal swiping on Agent Detail tabs on mobile touch devices.
- Fix slash/namespaced skill commands not loading in chat and agent sessions.
- Fix task-detail Workflow tabs so inherited workflow graphs and step details populate.
- Keep Graph tasks visible when cached workflow assignments reference deleted workflows.
- Fix npm install failure caused by bundled plugins referencing private @fusion packages.
- Rename the Remote Access settings section (drops the stale "& Node Sync" suffix).
- Mobile: hide the executor footer and remove the empty gap above the keyboard while typing.
- Fix Planning Mode not scrolling on mobile so action buttons stay reachable.
- Verification (merge/step gate) timeout now scales with command scope instead of a flat 10 minutes.
- Fix stale overlap-blocker repair edge cases and dashboard display synchronization.

### Internal

- Remove the quick-entry keyboard hint from the task creation surface.
- Post-merge workflow steps now run once via the workflow graph instead of the merger.
- Retire the legacy workflow-steps store; workflow steps now run entirely graph-native.

## 0.48.0

### Highlights

- Add a workflow dropdown to filter tasks in the dependency Graph view.
- Add a New Task dialog picker that seeds prompts from current-remote GitHub issues and PRs.
- Fix release pipeline so binaries and desktop installers publish again.
- Let quick-entry text use the full entry box width instead of wrapping early.
- Match Quick Chat and Terminal typography in the dashboard footer.

### New

- Add a workflow dropdown to filter tasks in the dependency Graph view.
- Add a New Task dialog picker that seeds prompts from current-remote GitHub issues and PRs.

### Fixed

- Fix release pipeline so binaries and desktop installers publish again.
- Let quick-entry text use the full entry box width instead of wrapping early.
- Match Quick Chat and Terminal typography in the dashboard footer.
- Prevent Create PR metadata generation from hanging and provide editable fallback content.
- Widen tablet Chat View agent response bubbles for easier reading.
- Retire dual-observe as a workflow-authoritative cutover prerequisite.
- Keep Planning Mode malformed AI responses retryable instead of stranding sessions.
- Keep Git Manager tabs reachable in mobile and docked layouts.
- Remove helper guidance above the task chat composer.
- Open Mission Manager mission-delete confirmations in the standard modal dialog.
- Make the task Changes tab inline diff panel wider on narrow screens.
- Equalize mobile bottom navigation side spacing.

## 0.47.0

### Highlights

- Breaking: the WorkflowOptionalStep type, previously exported from @runfusion/fusion, is removed — any consumer importing it must migrate to optional-group nodes / ResolvedWorkflowOptionalStep.
- Merger unification (master-plan U0): runAiMerge (the FN-5633 clean-room AI merge path) is now the sole merge path. The engine dispatch, the fn task merge CLI command,
- Add X-Session-Id and X-Session-Affinity request headers to all LLM chat completion requests. These let LLM gateways sticky-route consecutive requests from the same conversation to the same backend,
- Structured changeset format with AI-distilled release notes for cleaner, user-facing changelogs.
- Workflow editor: add a Help section to the node detail pane. Every node now documents what it does, how to configure it,

### New

- Merger unification (master-plan U0): runAiMerge (the FN-5633 clean-room AI merge path) is now the sole merge path. The engine dispatch, the fn task merge CLI command,
- Add X-Session-Id and X-Session-Affinity request headers to all LLM chat completion requests. These let LLM gateways sticky-route consecutive requests from the same conversation to the same backend,
- Structured changeset format with AI-distilled release notes for cleaner, user-facing changelogs.
- Workflow editor: add a Help section to the node detail pane. Every node now documents what it does, how to configure it,
- Workflow editor: optional steps are now graph-native. A new optional-group container node (foreach/loop-style) holds a subgraph the executor runs once when the group is enabled for a task (per-task enabledWorkflowSteps +…
- Workspace tasks no longer render blank in the dashboard. Task cards and the task detail view now surface a workspace task's acquired per-sub-repo worktrees as a read-only "N repos acquired" placeholder and flat repo → wo…
- Add workspace mode: open a folder of git repositories as a single Fusion project. The agent acquires per-repo worktrees on demand via fn_acquire_repo_worktree as it discovers it needs to work in each sub-repo.
- Workspace mode (Phase A / U2): harden per-repo worktree acquisition. Each sub-repo worktree now gets the task identity guard installed (single-repo parity),
- Workspace mode (Phase C U3): serialize concurrent same-sub-repo lands with a per-repo file-scope lease. When two workspace tasks try to land onto the SAME sub-repo's local integration ref at the same time,
- Workspace mode Phase A (U1): executor session scoping. In workspace mode the executor now skips the root worktree acquisition and every rootDir git preflight (base-commit capture, contamination, worktree-liveness),
- Workspace mode (Phase B, U1): per-repo post-session change capture, contamination detection, and worktree-invariant verification. In workspace mode the executor now loops task.workspaceWorktrees,
- Workspace mode (Phase B, U2): per-repo review at both review entry points plus per-repo fn_task_done completion + scope-leak verification.
- Workspace mode Phase C (U1): per-repo merge loop. Extract landOneRepo from the runAiMerge clean-room land closure (single-repo behavior unchanged) and add landWorkspaceTask,
- Workspace mode Phase C (U2): per-repo landed predicate, finalize-once, and idempotent auto-retry-then-park.
- Workspace mode Phase D (U1): workspace-aware self-healing. The existing merging-status reconcilers no longer mis-finalize a partial-landed workspace task (recoverInterruptedMergingTasks now clears the transient merging s…
- Saved agent tool-output details now default off to reduce persisted log payloads, while timeline rows remain logged and detailed tool arguments/results stay available via the global persistAgentToolOutput: true opt-in.
- Harden the workspace per-repo land loop against partial-failure races. A lost landedSha DB write after a sub-repo's integration ref already advanced no longer silently continues — it escalates to a retryable partial-land…
- Address Phase C workspace merge-loop review feedback. A sub-repo recognized as already-landed via the Fusion-Task-Id trailer fallback (when its landedSha persist was lost) now resolves and re-records a concrete landedSha…
- Close task detail dialogs and embedded task-detail hosts immediately after delete confirmations complete, while delete requests continue reporting success or error toasts asynchronously.
- Stack task-detail Chat agent headers above output blocks in the List View split-pane detail pane while preserving full-width desktop chat layout.

### Fixed

- Fix narrow right-sidebar Dev Server preview overlap by replacing the inline preview with an accessible modal launcher when the dock is very narrow, while keeping inline preview for full-page, mobile viewport,
- Fix ntfy test notifications to honor unsaved Settings form config so users can enable ntfy, enter a valid topic/server/token, and send a test notification before saving.
- Fix multiworkspace tasks failing to complete. task.workspaceWorktrees is now durably persisted (it previously had no SQLite column,

### Breaking

- Breaking: the WorkflowOptionalStep type, previously exported from @runfusion/fusion, is removed — any consumer importing it must migrate to optional-group nodes / ResolvedWorkflowOptionalStep.

## 0.46.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.46.0
- @fusion/engine@0.46.0
- @fusion/i18n@0.39.9
- @fusion-plugin-examples/cli-printing-press@0.1.26
- @fusion-plugin-examples/compound-engineering@0.1.9
- @fusion-plugin-examples/dependency-graph@0.1.40
- @fusion-plugin-examples/roadmap@0.1.28
- @fusion-plugin-examples/cursor-runtime@0.1.28
- @fusion-plugin-examples/droid-runtime@0.1.35
- @fusion-plugin-examples/hermes-runtime@0.2.59
- @fusion-plugin-examples/openclaw-runtime@0.2.59
- @fusion-plugin-examples/paperclip-runtime@0.2.59

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.46.0
- @fusion/dashboard@0.46.0
- @fusion/engine@0.46.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.46.0
- @fusion/pi-claude-cli@0.46.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.46.0

### @runfusion/fusion

#### Minor Changes

- 41f3b04: Add a Command Center Productivity control for previewing and applying historical LOC backfills from the dashboard.
- efb94c8: Add editable global model pricing overrides, a one-click LiteLLM pricing refresh, and override-aware Command Center cost estimates.

#### Patch Changes

- f6e9deb: Stop Planning Mode from automatically focusing the initial text entry when it opens, preventing mobile keyboards from appearing until the user explicitly focuses the textarea.
- 466cf9c: Dispose completed spawned child agent sessions so execution memory is released promptly after `fn_spawn_agent` children finish, keep artifact registry listing metadata-only so large inline artifacts are not loaded during agent execution, bound structured tool-result log previews before serialization, reduce dashboard SSE keepalive churn, and keep the dashboard TUI performance timeline drained during long-running execution.
- d06e316: Fix Command Center Recharts line and pie graphs rendering blank when their cards initially report unusable responsive dimensions.
- a670f5c: Restore core task lifecycle compatibility for workflow-column transitions, deferred title summarization fixtures, workflow IR rollback persistence, and capacity-aware task movement.
- fe536b2: Fix stale durable agent task assignments for tasks parked behind file-scope lease queues, including Reports Health Check rendering and self-healing reconciliation.
- 736ec6d: Fix mobile mailbox message selection so stale deep links no longer override the user's selected message.
- 945f0f1: Pass project fallback model settings into triage spec reviewer sessions so global default overrides are honored during review.

### runfusion.ai

#### Patch Changes

- Updated dependencies [f6e9deb]
- Updated dependencies [466cf9c]
- Updated dependencies [d06e316]
- Updated dependencies [a670f5c]
- Updated dependencies [fe536b2]
- Updated dependencies [736ec6d]
- Updated dependencies [945f0f1]
- Updated dependencies [41f3b04]
- Updated dependencies [efb94c8]
  - @runfusion/fusion@0.46.0

## 0.45.0

### @fusion/core

#### Patch Changes

- 26ebb92: Fix `reconcileOrphanedTaskDirs` silently resurrecting long-deleted tasks onto the live board after a restart ("all task IDs reset / starting over").

  The sweep re-imports `.fusion/tasks/<id>/` directories that have no DB row, to recover heartbeat-created dirs that race store init or rows lost to a recent DB corruption. But it didn't distinguish a genuinely-recent orphan from an ancient deleted-task dir that merely lingered on disk. Modern deletes leave a soft-delete tombstone (caught by `taskIdExistsAnywhere`), but legacy hard-deletes left no tombstone — so a months-old `task.json` with no DB row was re-imported as a live task, surfacing old low-numbered IDs (FN-001, FN-002, …) at the top of the board.

  Reconcile now gates recovery on a recency window (`task.json` modified within the last 7 days). Older orphan dirs are skipped with reason `stale-orphan-dir-beyond-recency-window` and left for explicit recovery (unarchive/restore) or directory cleanup, while heartbeat-race and recent-corruption recovery still work.

- 7e7eb62: Harden the orphan-worktree and stale-task-dir cleanup fixes (code-review follow-up).

  - **executor.ts (P0):** the stale-conflict recovery's `rm(worktreePath, { recursive, force })` had no bounds check. `worktreePath` can originate from a git worktree admin entry that resolves outside `.worktrees/`, so an out-of-bounds or symlinked path could be force-removed. The recovery now refuses unless the path is inside the configured worktrees dir, is not a symlink (checked via `realpathSync`), is not a registered git worktree, and is not actively owned — and it re-verifies liveness inside the catch rather than trusting the error string. It also excludes `spawn` failures (e.g. `spawn git ENOENT` when git is missing) so a missing-binary error is no longer misread as a successful stale-path cleanup.
  - **worktree-pool.ts:** `resolveGitdirPointer` is replaced by `dotGitPointerIsDangling`, which reaps **only** when a `.git` link's gitdir target is confirmed missing. A real `.git` directory, an unparseable pointer, or any read/stat failure now returns "not dangling" (conservative) so a transient read error on a live worktree's `.git` can't cause a force-remove. Removes the `string | "directory" | null` sentinel union.
  - **core store.ts:** the `reconcileOrphanedTaskDirs` recency window is now bypassed when the live task table is empty (the corruption/restore case — surviving `task.json` files keep old mtimes), and when a corrupt `fusion.db` was auto-recovered on startup, so `.recover` row loss is not stranded by the gate. Adds an `ignoreRecencyWindow` option for explicit callers.
  - Tests for all of the above: executor recovery + out-of-bounds refusal, unparseable `.git` skip, recency boundary, empty-DB/forced bypass.

### @fusion/dashboard

#### Patch Changes

- Updated dependencies [26ebb92]
- Updated dependencies [7e7eb62]
  - @fusion/core@0.45.0
  - @fusion/engine@0.45.0
  - @fusion/i18n@0.39.8
  - @fusion-plugin-examples/cli-printing-press@0.1.25
  - @fusion-plugin-examples/compound-engineering@0.1.8
  - @fusion-plugin-examples/dependency-graph@0.1.39
  - @fusion-plugin-examples/roadmap@0.1.27
  - @fusion-plugin-examples/cursor-runtime@0.1.27
  - @fusion-plugin-examples/droid-runtime@0.1.34
  - @fusion-plugin-examples/hermes-runtime@0.2.58
  - @fusion-plugin-examples/openclaw-runtime@0.2.58
  - @fusion-plugin-examples/paperclip-runtime@0.2.58

### @fusion/desktop

#### Patch Changes

- Updated dependencies [26ebb92]
- Updated dependencies [7e7eb62]
  - @fusion/core@0.45.0
  - @fusion/dashboard@0.45.0
  - @fusion/engine@0.45.0

### @fusion/engine

#### Patch Changes

- Updated dependencies [26ebb92]
- Updated dependencies [7e7eb62]
  - @fusion/core@0.45.0
  - @fusion/pi-claude-cli@0.45.0

### @fusion/plugin-sdk

#### Patch Changes

- Updated dependencies [26ebb92]
- Updated dependencies [7e7eb62]
  - @fusion/core@0.45.0

### @runfusion/fusion

#### Minor Changes

- 26e5514: Add the `factory-mono` dashboard color theme, a monochrome Factory variant with red accents and neutralized glow effects.
- 130fea2: Ask first-run users whether to create an optional first persistent agent after project registration, with CEO as the default template, skip support, and no duplicate GitHub star prompt.
- 70cce18: Add the `fn_agent_set_instructions` extension tool so managing agents can update direct or indirect reports' inline or file-backed instructions with org-hierarchy authorization.
- 8dd9697: Add an operator-triggered Command Center Productivity LOC backfill API and client for historical commit-association diff stats.
- f13aaa1: Add a Command Center GitHub resolved-issues detail list and expose the resolved issue rows in the GitHub analytics endpoint payload and CSV export.
- c158dda: Add the `xhigh` reasoning effort level to model settings and task/agent selectors. Claude CLI adapters pass the value through to runtime mapping, where non-Opus models use `high` effort and Opus models use `max` effort.
- 52924ba: Add a built-in lead-generation workflow with custom lead columns, fields, and stage prompts.
- 7f3e942: Add a built-in Design workflow that gates UI-heavy work with a design/UX review before standard review and merge.
- 281ce35: Add a built-in Marketing workflow with content-specific columns and prompts for brief, drafting, editorial review, and publishing.
- fbce59b: Add a core artifact registry data model and store APIs for persisted artifact metadata with on-disk binary storage.
- af06170: Add `fn_artifact_register`, `fn_artifact_list`, and `fn_artifact_view` agent tools for publishing and discovering multi-type artifacts, with best-effort dashboard user inbox notifications on registration.
- ef48895: Add dashboard artifact registry read APIs, client helpers, and a Documents-view Artifacts media gallery for images, videos, audio, documents, and generic artifacts.
- 58f7588: Add a Shadcn Custom dashboard theme with persisted, sanitized design-token color picker overrides across Settings and Command Center theme selectors.
- f80a785: Add pricing entries for OpenAI Codex models used through the `openai-codex` provider, so Command Center token analytics can estimate costs for Codex runs instead of showing them as unavailable.

  This is marked minor because it expands the set of priced models surfaced by the published CLI/dashboard without changing existing pricing behavior.

- 09acfbb: Allow users to manually pause and unpause agent-assigned tasks from the dashboard task detail view and API.
- 4fec139: Move Stash Recovery into the Git Manager Recovery tab and remove the standalone top-level Stash Recovery view from dashboard navigation.
- 5b33da9: Move desktop toolbar tools into the right sidebar tools rail. The right dock now hosts Activity, Activity Log, Import from GitHub, Git Manager, Files, and Automation, and no longer duplicates left-sidebar content views.
- 7034b55: Move the dashboard terminal launcher to the footer executor status bar and add docked plus floating resizable terminal modes on desktop/tablet while preserving mobile fullscreen terminal behavior.
- a913881: Make the dashboard right dock persistent by default with an in-dock collapse toggle, and remove duplicate Header right-dock toggle behavior.
- 7fd14eb: Rename the task detail Documents tab to Artifacts and add a task-scoped media artifact gallery alongside existing task documents.
- 496167c: Polish dashboard navigation, floating modal, file browser, chat footer, agent role, insights, and list-view action surfaces for a more consistent responsive UI.
- eb3477a: Add a Command Center System node selector so local and registered remote node telemetry can be inspected from the dashboard.
- 59d3eee: Add estimated human hours saved to Command Center Productivity analytics, UI stats, and CSV exports.
- 2dc36d9: Import Tasks PR preview now shows the full comment thread and per-check status (with success/failure/pending indicators) for the selected pull request, fetched on selection and cached per PR. The body still renders immediately while checks and comments stream in.
- 7ef3817: Start the AI engine by default in `pnpm local`, keep dashboard `--dev` engine-on unless `--no-engine` is passed, start desktop local runtimes with engines, and show dashboard instructions when Fusion is launched without an engine.
- 7ddf58d: Sync workflow setting values across nodes in settings push, pull, receive, and status flows.
- 8640a74: The shared markdown renderer (GitHub PR/issue bodies + comments, mailbox, chat) now renders embedded raw HTML and mermaid diagrams. Raw HTML (`<details>`/`<summary>`, `<kbd>`, `<sub>`, tables) renders as real elements via `rehype-raw`, with `rehype-sanitize` stripping XSS (script/style/iframe, event handlers, `javascript:` URLs) since these bodies come from GitHub; HTML comments (`<!-- -->`) are dropped. Fenced ```mermaid blocks render as actual diagrams via a lazy-loaded `mermaid` import (kept out of the main bundle, loaded only when a diagram is present), falling back to the raw code block on parse error and following the dashboard theme.
- 4fd8d44: Polish dashboard navigation and app chrome, add responsive chat/file/modal behavior, refine roadmaps, missions, task details, workflow defaults, theme defaults, and sidebar/header styling.
- 91180fb: Close the validator reaper→slice deadlock and harden every validation re-drive site for the new behavioral-verification posture. A reaped, task-less "done" feature (left in `loopState="validating"`/`needs_fix`+`error`) is now re-driven by recovery to a terminal pass/fail/inconclusive verdict instead of livelocking the slice, milestone, and mission. Adds an adversarial reliability suite enumerating every re-drive entry point (normal `processTaskOutcome`, each `recoverActiveMissions` branch, and the stale-run reaper) and asserting source-tree git-cleanliness, zero duplicate Fix Features, a terminal verdict, and no `error`-state deadlock. Documents the non-mutating verification run, the first-class `inconclusive` verdict, and the adversarial default-to-fail posture across `docs/missions.md`, `docs/missions-completion-contract.md`, and `CONCEPTS.md`.
- da5fea6: Add Shadcn color-variant dashboard themes for blue, green, red, purple, pink, orange, yellow, mono, and black variants.
- e19f7c2: Add a Shadcn dashboard color theme with zinc neutral tokens, sans-serif typography, 1px borders, subtle flat shadows, and solid primary buttons.
- b20a25c: Add the `shadcn-gray-blue` dashboard color theme with slate blue-gray surfaces and a muted slate-blue accent.
- 4672203: Add a Shadcn Gray dashboard color theme with a fully neutral zinc-gray accent.
- 12aae94: Add Shadcn Mono Red/Blue/Green/Purple/Pink/Orange/Yellow dashboard color themes and migrate legacy `shadcn-mono` selections to `shadcn-mono-red`.
- dc0064b: Dashboard navigation and panel redesign (desktop/tablet; mobile unchanged):

  - **Right sidebar**: a single show/hide toggle now lives in the top header (replacing the tablet overflow menu); the dock is hidden when closed and no longer keeps a persistent icon rail or in-dock collapse button. Its tools (Files — now the default/first tab, Activity, Activity Log, Git Manager) render inline inside the dock instead of opening popup modals. Files opens inline with a pop-out to the resizable file modal. The embedded Git Manager adapts to its width (compact horizontal tab strip in the dock, full two-pane in the wide pop-out). The dependency graph no longer appears in the dock.
  - **Left sidebar**: New Task button matches the item-highlight box; footer spacing between Collapse and Settings; divider before the secondary section removed with uniform row spacing. New main-content destinations — Workflows, Import Tasks (GitHub import, with the GitHub mark), and Automations (two-pane, Command Center styling) — render in the main panel instead of as modals.
  - **Embedded views**: Planning Mode embeds without modal chrome (no header/close/shadow), fills the full content area, and renders correctly on mobile; the board WorkflowSwitcher is available in Planning. Dev Server header matches Command Center. Insights header wraps so actions don't overlap. List view's left pane can be dragged much narrower with two-line title wrapping.
  - **Other**: the docked terminal no longer blurs or blocks the page behind it; the footer Terminal button renders as plain text like the running-state trigger; the workflow selector matches the project selector's styling, height, and font size; the Automations screen uses theme color tokens.

- 5697d2c: Skills view detail pane: render SKILL.md as Markdown (GFM + sanitized HTML + mermaid), compact the referenced-files area while showing all files, and make each file clickable to view its content with a "Back to SKILL.md" affordance. Adds a `GET /api/skills/:id/file` endpoint for per-file content.
- 5117944: Add Command Center Productivity task-duration analytics, dashboard stat cards, and CSV export rows for completed-task active execution time.
- d4e91d4: Add workflow optional steps: workflows can declare optional step templates that tasks toggle on/off per task, with a workflow-level default. The built-in coding and stepwise-coding workflows expose agent browser verification as an optional step (the stepwise workflow gains a pre-merge workflow-step seam so enabled steps actually run). Optional steps are authorable in the node editor, preserved across node-editor saves, and selectable from a steps dropdown in both the quick-add card and the full New Task modal.

#### Patch Changes

- c8a82e7: Auto-continue the agent session after an engine-internal pause/resume abort instead of re-queueing the task to todo. When the engine tears down in-flight work (hard-cancel) and the workflow graph run ends with the task back in `todo`, the executor now retries the agent session in place — bounded by the existing graph-resume retry budget with backoff, falling back to a benign re-queue only after retries are exhausted. Before re-dispatching, it re-checks the task at fire time and aborts the auto-continue if the task was paused, moved, or deleted during the backoff window, so genuine user/global/task pauses are never resumed against the operator's intent. The transient reclassification clears any stale `failed` status and emits an `Auto-recovered:` log so no spurious failure notification fires.
- ee9c8ab: Align dashboard view chrome and inner-pane spacing across Chat, Mailbox, Workflows, Artifacts-adjacent controls, Goals, and Compound Engineering.
- ce6c0fb: Polish dashboard view chrome: align Dashboard, Import Tasks, Automations, Chat, and docked Files editor controls with the shared view header and toolbar styling.
- 7635ba8: Fix a false "engine not running" banner when another fusion process on the same machine already owns the engine. The dashboard's health check only counted engines this process started, so a second launch (e.g. `pnpm dev dashboard` alongside an already-running `fusion`) that was correctly refused the per-machine engine singleton lock reported the engine as unavailable — even though one was running. The `ProjectEngineManager` now tracks engines owned by another process (detected via `EngineAlreadyRunningError` from the singleton lock) and exposes `hasRunningEngine()`, which the dashboard health endpoint uses so the banner reflects machine-level truth. Reconciliation still retries so this process takes over if the other exits, and the "refusing to start" log is emitted once per project instead of on every reconciliation tick.
- ce90cc9: Keep Fusion verification progress moving by making targeted script tests honor file arguments, reaping verification subprocess groups after clean exits, and preventing the line-count audit from blocking `pnpm test`. The changed-test runner now caps reverse-dependent fan-out so a foundational-package edit no longer expands into a whole-workspace run, and the executor/verification guidance now directs agents to scope verification to changed files rather than running the full workspace test suite.
- 5a422b0: Fix anthropic-compatible custom providers failing with "No API provider registered for api: anthropic".

  `resolveCustomProviderApiType` mapped the `anthropic-compatible` provider type to the api key `"anthropic"`, but pi-ai registers the Anthropic Messages API under `"anthropic-messages"`. Any custom provider configured as `anthropic-compatible` (self-hosted Claude proxy, gateway, etc.) therefore selected a model whose `api` did not match a registered provider and threw at stream time. Mapped it to `"anthropic-messages"` and added a regression assertion alongside the existing openai-compatible / openai-responses coverage.

- 2d32760: Clear the stale `failed` status when a pause/resume abort is reclassified as a benign todo re-queue, so the task no longer surfaces as failed on the board and the deferred failure notification is suppressed. Previously a pause-abort parked `status:"failed"` on an earlier non-todo observation stayed dispatchable (the scheduler filters on column+paused, not status), re-entered the benign-todo branch, and was logged benign while the row stayed failed — firing a contradictory failure alert during global pause when self-healing recovery was suppressed. The clear path also emits an `Auto-recovered:`-prefixed log so the notification service proactively cancels the pending failure timer instead of relying only on the fire-time re-check.
- b564ee0: Make the compound-engineering built-in workflow actually load skills and run the full CE flow. Previously the workflow named CE skills at each node but the graph-node execution path (`runGraphCustomNode`) never loaded them: the named skill was only injected as prompt text, the plugin-injected `FUSION_CE_*` runtime env never reached the step session, and `fn_spawn_agent` was never registered for workflow steps, so persona fan-out and skill loading silently no-op'd. Now skill-executor graph steps thread the injected env, load the named skill (discovery + selection via `additionalSkillPaths`), register the spawn tool in coding mode, and receive an engine-injected Fusion workflow-step conventions preamble (await-input for questions, `FUSION_HEADLESS` degrade path, persona fan-out via `systemPromptOverride`). Adds an explicit `unattended` opt-in for `FUSION_HEADLESS`, reconciles the preamble with the gate verdict-JSON contract, and carries `skillName` through the `WorkflowStep` round-trip.
- 8b5b9a7: Fix the persistent non-blocking Full Suite failure caused by the Compound Engineering plugin's `dist-freshness.test.ts`. The test reads the plugin's compiled `dist/settings.js` and `dist/session/orchestrator.js`, but the plugin had no `pretest` build and was absent from `ensure-test-artifacts.mjs`, so on a fresh checkout `dist/` did not exist and the freshness guard threw "dist/ is missing — run pnpm build first". Register the plugin's required artifacts in `ensure-test-artifacts.mjs` and add a `pretest` hook that builds them, matching the other bundled plugins.
- 68c4053: Fix the Droid runtime model discovery spawning a runaway storm of leaked `droid` processes.

  `discoverDroidModels` invoked `droid models --json` / `droid model list --json`, but the droid CLI has no such commands — an unknown subcommand is parsed as a _prompt_, so each call launched a full agent session (a persistent `droid exec --stream-jsonrpc` backend) that never exited. The promise never settled and the process leaked; because the dashboard re-loads the droid extension on every chat-send, these piled up into dozens of orphaned `droid` processes.

  Discovery now reads the catalog from `droid exec --help` (which lists `Available Models:` + `Custom Models:` and exits cleanly), parsed via the new `parseDroidModelsFromHelp` helper. A SIGKILL-on-timeout guard (`DROID_MODEL_DISCOVERY_TIMEOUT_MS`) ensures any wedged spawn is killed and the promise always settles, so a single discovery call can never leak a process again. Verified end-to-end against the real binary (46 models incl. custom, 0 leaked processes).

- 9101705: Show plugin-contributed skills (e.g. compound-engineering `ce-*`) in the workflow editor. The dashboard's discovered-skills catalog was built only from the disk-scanning package manager, so plugin skills — which the engine materializes for executor sessions separately — never appeared, and built-in workflow nodes that reference them (like `builtin:compound-engineering`) showed "— select skill —" / unresolved. The skills adapter now merges plugin skill contributions into the discovered list (deduped by bare name), and the editor's node summary + skill dropdown match namespaced skillNames (`compound-engineering:ce-work`) against the catalog's two-segment names (`ce-work/SKILL.md`) via a shared bare-name normalizer.
- 3b61ac3: Fix loading spinners that didn't spin across the dashboard. Many loading states (Settings, task tabs, agents, documents, plugins, model pickers, command center, and more) rendered bare "Loading…" text with no spinner — and a couple rendered an unstyled `loading-spinner` div that never showed anything. Added a shared `<LoadingSpinner>` component (self-contained animated SVG, no `lucide-react` dependency so it survives partial test mocks) and adopted it across ~45 loading placeholders so every loading state now shows a consistent animated spinner.
- d99246c: Fix macOS system memory usage reporting by deriving host memory used from OS-available memory instead of raw `os.freemem()` pages.
- 438cd75: Fix worktree-creation failures (and the `Workflow graph terminated with failure at node 'execute'` they surface as) caused by leaked orphan worktree directories.

  A directory under `.worktrees/` that survives with a _dangling_ `.git` pointer — present on disk, but the `.git/worktrees/<name>` admin entry it references is gone — is invisible to `git worktree list` and untouched by `git worktree prune`, yet collides with a freshly generated worktree name. When the executor then tries to clean up the "conflict", `git worktree remove --force` fails with `is not a working tree` and the whole `execute` node fails after 3 attempts.

  - **On-demand recovery (`executor.ts`):** the FN-4813 stale-conflict recovery now also treats `is not a working tree` and `ENOENT` (not just `validation failed, cannot remove working tree`) as "no live worktree at this path" — it prunes any admin entry, force-removes the leftover directory, and proceeds with fresh worktree creation instead of failing.
  - **Leak prevention (`worktree-pool.ts`):** `reapOrphanWorktrees` previously skipped any dir on the mere _presence_ of a `.git` file ("may be partially registered"), contradicting its own documented invariant. It now resolves the `.git` pointer and only skips when the gitdir target actually exists; a dangling pointer is reaped like any other half-initialized orphan, so these directories no longer accumulate across runs.

- 9643563: Fix the global pause/resume failure mode that stalled the board: a pause-abort that left a task back in `todo` was parked `status:"failed"` ("operator action required") and leaked its in-memory worktree slot, producing an instant re-fail retry storm and concurrency-starving the whole queue.

  - Root cause: `handleGraphFailure` now treats a pause-abort that has re-queued a task to `todo` as benign (FN-6782) — it no longer parks it failed, clears the `pausedAborted` marker so the next dispatch starts clean, and releases the leaked worktree slot.
  - Auto-recovery: a new `recoverPausedAbortFailures` self-healing sweep clears any pause-abort park (`status:"failed"` with "operator action required") still on the board and requeues it for normal scheduling, so the board self-heals without operator intervention.
  - Defense-in-depth: a new `reapLeakedConcurrencySlots` self-healing sweep reclaims any in-memory worktree slot whose holder is no longer in-progress (the "in todo yet still a `maxWorktrees` holder" leak), gated by the executor's live-session refusal so it can never pull a worktree out from under a running agent. This recovers a leaked slot from any future/unknown path without an engine restart.

- 24ff124: Stop edits to `scripts/lib/test-quarantine.json` from forcing `pnpm test` into gate mode. The quarantine list is runtime data, not executable test infra; tripping the shared-infra catch-all dropped affected-package coverage, so a dev's real changes went untested whenever they also touched the quarantine list. Quarantine edits now stay in changed mode and run the affected packages.
- a2342ca: Fix the task detail chat always showing "No agent is working on this task" for in-progress tasks. The active-session check required a persistent `assignedAgentId`/`checkedOutBy`, but in the default ephemeral-agents mode the scheduler never sets those fields, so an actively-executing task always read as idle. An assignment is now sufficient-but-not-necessary: a non-blocked, non-`queued` in-progress task counts as a live agent session on its own (`queued` stays assignment-gated, in-review is unchanged).
- 7e7eb62: Harden the orphan-worktree and stale-task-dir cleanup fixes (code-review follow-up).

  - **executor.ts (P0):** the stale-conflict recovery's `rm(worktreePath, { recursive, force })` had no bounds check. `worktreePath` can originate from a git worktree admin entry that resolves outside `.worktrees/`, so an out-of-bounds or symlinked path could be force-removed. The recovery now refuses unless the path is inside the configured worktrees dir, is not a symlink (checked via `realpathSync`), is not a registered git worktree, and is not actively owned — and it re-verifies liveness inside the catch rather than trusting the error string. It also excludes `spawn` failures (e.g. `spawn git ENOENT` when git is missing) so a missing-binary error is no longer misread as a successful stale-path cleanup.
  - **worktree-pool.ts:** `resolveGitdirPointer` is replaced by `dotGitPointerIsDangling`, which reaps **only** when a `.git` link's gitdir target is confirmed missing. A real `.git` directory, an unparseable pointer, or any read/stat failure now returns "not dangling" (conservative) so a transient read error on a live worktree's `.git` can't cause a force-remove. Removes the `string | "directory" | null` sentinel union.
  - **core store.ts:** the `reconcileOrphanedTaskDirs` recency window is now bypassed when the live task table is empty (the corruption/restore case — surviving `task.json` files keep old mtimes), and when a corrupt `fusion.db` was auto-recovered on startup, so `.recover` row loss is not stranded by the gate. Adds an `ignoreRecencyWindow` option for explicit callers.
  - Tests for all of the above: executor recovery + out-of-bounds refusal, unparseable `.git` skip, recency boundary, empty-DB/forced bypass.

- 87f18f8: Track real plugin activation events and surface project-scoped Command Center plugin activation analytics instead of placeholder ecosystem counts.
- ee72c94: Move the Command Center Overview SDLC throughput funnel to the bottom of the tab and broaden hand-rolled chart primitive colors to cycle through existing semantic theme tokens.
- 8f052c6: Fix Command Center Activity trend charts so mixed-unit agent/activity series stay visually legible instead of being flattened by high-volume message counts.
- df139ec: Recover in-progress tasks wedged behind stale in-memory executor bindings by clearing the phantom binding and requeueing with progress and worktree preserved.
- e6f6111: Fix terminal shortcut focus preservation so on-screen Ctrl combinations emit control bytes reliably on touch and pointer devices while keeping physical Ctrl behavior intact.
- d4d7623: Rebaseline the dashboard i18n lint guardrail by excluding non-shipping tests and stories, suppressing technical token categories, localizing plugin missing-view copy, and tracking remaining source-copy deferrals with narrow follow-up tasks.
- 98720f3: Fix mobile bottom tab navigation icon spacing so every tab uses an equal-width column across optional tabs, badges, and status dots.
- c4f34ce: Make the Agents view sidebar wider by default on tablet and resizable with per-project persistence on non-mobile layouts.
- b760fa0: Localize remaining plugin, agent, mission, node, research, document, activity, and miscellaneous dashboard strings and remove their i18n lint deferrals.
- bdf95f8: Localized the dashboard workflow/task/setup/PR component cluster and removed the obsolete i18n lint deferrals for those files so the hardcoded-string guardrail scans them again.
- eca96fb: Keep settings section dashboard copy covered by i18n lint by removing the settings/sections deferral and regenerating i18n resource types.
- c808177: Eliminate the legacy board flash before workflow lanes load by caching per-project board workflow metadata and showing a neutral skeleton while metadata resolves.
- 0c0fda1: Keep Command Center inline next to Agents across desktop and tablet header widths instead of moving it into the More views overflow menu.
- c32c925: Repair task-store startup and self-healing consistency by non-destructively re-importing orphaned live `.fusion/tasks/{ID}/task.json` records into the SQLite task index while preserving soft-deleted, archived, and tombstoned IDs.
- d2fc70a: Fix dependency gating so workflow-graph and workflow-authoritative executor dispatches re-check unmet task dependencies before running, requeueing blocked work with `blockedBy` instead of allowing it to advance to review.

  Add self-healing reconciliation for already-advanced `in-review` tasks with unmet dependencies, including the `task:reconcile-in-review-unmet-dependencies` run-audit event and guarded no-action companion.

- 08d1f09: Recover benign in-review pause/resume abort parks without requiring operator intervention while preserving hard-cancel, pause, and terminal merge safeguards.
- 61ff17a: Harden in-review dependency drift reconciliation so guard-held or failed rebounds emit no-action audit evidence instead of silently wedging dependent tasks.
- 26bd85d: Fix mobile bottom navigation icon alignment so unread indicators use a centered token-sized icon slot without visually skewing tab spacing.
- 37c4cfa: Prevent bundled Droid and Claude CLI auth/presence probes from surfacing unhandled promise rejections when `spawn` throws synchronously, such as when test guards block real AI CLI auth commands. These probes now resolve as unavailable/unauthenticated instead of rejecting from fire-and-forget validation paths.
- 185ff70: Fix the experimental left sidebar Settings button so it remains clear of the fixed executor status footer, and keep project-selector fallback labels readable when translations are incomplete.
- c7b56a5: Stop triage and planning prompts from auto-selecting alternate workflows based on task type; agents now preserve the project default workflow unless the user explicitly requests a specific workflow.
- c18e827: Await CLI extension cached TaskStore shutdown so deferred filesystem writes and SQLite handles drain before fixture or process cleanup.
- 8c478ad: Fix stale board entries after dependency-driven task re-specification moves by syncing the watched task cache after `updateTaskDependencies` writes and defensively deduplicating `listTasks` rows so active task rows win over archived snapshots.
- 47ba99a: Bump the internal @earendil-works pi SDK family from ^0.79.1 to ^0.79.9 for the CLI, dashboard, and engine packages.
- 24c1c02: Fix dashboard toast text colors so Shadcn dark-mode success, info, and error notifications remain readable against their themed backgrounds.
- 1f23a2e: Ensure bundled Droid CLI provider startup registers without waiting for local `droid` probes and harden binary probes so missing, guarded, or hanging spawns resolve to unavailable sentinels instead of delaying engine boot.
- 15d427b: Move Planning Mode into the dashboard sidebar as a first-class embedded view while removing the desktop toolbar affordance.
- 91971b6: Update the built-in compound-engineering workflow so its Review stage runs the `compound-engineering:ce-code-review` skill directly. The redundant generic reviewer seam node was removed, leaving the CE code-review gate as the sole review stage.
- c4c8961: Tasks created from a selected non-default workflow lane now appear on that lane immediately instead of vanishing until the board-workflows metadata refetch catches up.
- 4342172: Built-in compound-engineering workflow prompts now explicitly call out the `/ce-` skill slash command at each stage.
- bb663a4: Improve bundled non-coding workflow prompts so marketing, lead-generation, and design runs produce structured deliverables, with content and design preview artifacts persisted for review.
- f4d2fa2: Hide the dashboard AI subtask-breakdown quick-add button behind the default-off `subtaskBreakdown` experimental feature flag.
- 5191e1f: Prevent the bundled Droid CLI extension from starting local `droid` probes during server boot; validation now runs only when a Droid stream is actually used while existing probe paths remain non-interactive and timeout-bounded.
- 4879996: Restyle the workflow switcher trigger and dropdown to visually match the project selector.
- ec1d29e: Prevent task worktree acquisition from returning the project repository root by enforcing a non-root postcondition across resume, pooled, and fresh checkout paths.
- c229a15: Tighten agent workflow-routing prompt policy so triage and executor agents must not move a task's workflow unless the user explicitly requested it or the agent created that task. Executor prompts now include an explicit `fn_workflow_select` guardrail while preserving workflow selection for tasks agents create.
- 849b40d: Keep workflow IR and effective-settings resolution usable when project identity lookup fails, falling back to declaration defaults instead of propagating the identity error.
- 9218613: Fix auto-merge lifecycle finalization so successful squash commits reliably leave tasks done, clear transient auto-merge state, and preserve actionable failure state when lifecycle updates fail.
- 6e563b9: Revalidate dashboard service-worker assets before falling back to cache so rebuilt tabs cannot stay on stale bundles and render a blank page.
- a1cac3a: Replace the compact Quick Chat implementation with the full Chat modal launcher and configurable footer/FAB/off setting, move the file browser into the shared floating-window shell with a compact New menu and consistent narrow editor toolbar, fit the dependency graph after layout settles, and align chat/mailbox/task-detail expansion plus header/theme polish.
- 67281fe: Fix Import from GitHub remote detection in multi-project dashboards by passing the active `projectId` to the `/api/git/remotes` lookup. The dialog now lists configured GitHub remotes instead of showing "No GitHub remotes detected" when the backend requires project scope.
- a147a98: Prevent global settings updates from overwriting an existing unreadable settings file with defaults, and use provider/CPU icons in task chat agent headers.
- e788537: Raise the minimum agent heartbeat staleness floor from 5 to 10 minutes. Agents go silent during long-running but legitimate work (notably a verification step running a multi-minute test command, where the agent is blocked awaiting the command and cannot tick/heartbeat). The 5-minute floor could misread such a busy agent as dead and reclaim its in-progress task mid-run; 10 minutes gives long operations room before the liveness gate acts.
- 4ed84be: Polish mobile workflow header alignment, task chat provider icons, modal overlay chrome, and shadcn font consistency.
- a6685b7: Check for duplicate tasks from the New Task dialog and show duplicate descriptions in the warning modal.
- f0fbc59: Update first-run onboarding to include an optional first-agent step and clearer temporary-agent task guidance.
- 36b8950: Carry the selected workflow lane through Planning Mode and Subtask Breakdown task creation so saved tasks appear on the active workflow instead of falling back to the main board.
- 93017a3: Preserve task progress when a single-session run is hard-cancelled mid-execution. When the engine aborted in-flight work and bounced the task back to `todo`, the single-session teardown cleared the task `branch` and re-queued without `preserveResumeState` — resetting every step to `pending` and dropping the pointer to commits already on the task branch, so the next dispatch re-planned from Step 0 and the committed work was stranded (observed as a task that "lost all progress" and got stuck). The teardown now keeps the branch and moves with `preserveResumeState` whenever the task has resumable step progress, matching the step-session and pause-park paths, so execution resumes onto the existing branch from the first incomplete step. The worktree is still removed to free its concurrency slot — only the durable pointers (branch + step state) are kept.
- 192a2f2: Preserve unrelated global settings when saving Settings sections, and graduate Chat Rooms, Goals, Memory, Insights, Skills, and Todo to default-on dashboard surfaces.
- 2e3b965: Smooth the mobile Quick Chat fullscreen sheet during Android soft-keyboard viewport resizing while preserving synchronous iOS visualViewport alignment.
- b9b9447: Reset a task's stuck-kill streak on genuine forward progress. `stuckKillCount` was a lifetime counter — incremented by self-healing on each stuck-kill and cleared only by a manual retry — so a long, genuinely-progressing task could be terminalized by accumulation toward the stuck-kill budget. It now resets when a step reaches a terminal forward status (done/skipped), so only consecutive no-progress stalls count toward the budget.
- 192a2f2: Open task-card files changed actions in the inline task detail Changes tab instead of the task modal.
- 5e55d9c: Show provider icons in task detail chat for default-backed executor, reviewer, planner, and merger models.
- 19be91c: Floating modals (the reusable FloatingWindow, the right-dock pop-out, the floating terminal, and the floating New Task dialog) now share a single z-index stack, so tapping any of them brings it to the front above all the others regardless of type.
- 65c4dc5: Graduate workflow columns and the workflow graph executor to the default runtime path.

  Upgrade notes: stale persisted `experimentalFeatures.workflowColumns` and `experimentalFeatures.workflowGraphExecutor` values are ignored by the engine, so prior installs keep dispatching tasks through the workflow runtime after upgrade. `workflowInterpreterDualObserve` remains an internal diagnostic and defaults off.

  If an upgraded project appears stalled, treat `todo` tasks with unmet dependencies, `paused`/`userPaused`, active checkout leases, unavailable assigned nodes, or file-scope overlap as intentionally parked. Eligible `todo` tasks without those blockers should be picked up by the workflow scheduler; eligible `in-progress` rows without a live executor are recovered through the normal orphan-resume/self-healing path. The old Experimental toggles are no longer a rollback switch; use a source rollback/downgrade to the previous release if the workflow runtime itself must be reverted.

### runfusion.ai

#### Patch Changes

- Updated dependencies [c8a82e7]
- Updated dependencies [ee9c8ab]
- Updated dependencies [ce6c0fb]
- Updated dependencies [7635ba8]
- Updated dependencies [26e5514]
- Updated dependencies [ce90cc9]
- Updated dependencies [130fea2]
- Updated dependencies [5a422b0]
- Updated dependencies [2d32760]
- Updated dependencies [b564ee0]
- Updated dependencies [8b5b9a7]
- Updated dependencies [68c4053]
- Updated dependencies [9101705]
- Updated dependencies [3b61ac3]
- Updated dependencies [d99246c]
- Updated dependencies [438cd75]
- Updated dependencies [9643563]
- Updated dependencies [24ff124]
- Updated dependencies [a2342ca]
- Updated dependencies [7e7eb62]
- Updated dependencies [87f18f8]
- Updated dependencies [70cce18]
- Updated dependencies [8dd9697]
- Updated dependencies [ee72c94]
- Updated dependencies [f13aaa1]
- Updated dependencies [8f052c6]
- Updated dependencies [df139ec]
- Updated dependencies [e6f6111]
- Updated dependencies [c158dda]
- Updated dependencies [d4d7623]
- Updated dependencies [52924ba]
- Updated dependencies [7f3e942]
- Updated dependencies [281ce35]
- Updated dependencies [98720f3]
- Updated dependencies [c4f34ce]
- Updated dependencies [b760fa0]
- Updated dependencies [bdf95f8]
- Updated dependencies [eca96fb]
- Updated dependencies [c808177]
- Updated dependencies [fbce59b]
- Updated dependencies [af06170]
- Updated dependencies [ef48895]
- Updated dependencies [0c0fda1]
- Updated dependencies [c32c925]
- Updated dependencies [d2fc70a]
- Updated dependencies [08d1f09]
- Updated dependencies [61ff17a]
- Updated dependencies [26bd85d]
- Updated dependencies [37c4cfa]
- Updated dependencies [58f7588]
- Updated dependencies [185ff70]
- Updated dependencies [c7b56a5]
- Updated dependencies [c18e827]
- Updated dependencies [8c478ad]
- Updated dependencies [47ba99a]
- Updated dependencies [24c1c02]
- Updated dependencies [f80a785]
- Updated dependencies [09acfbb]
- Updated dependencies [1f23a2e]
- Updated dependencies [4fec139]
- Updated dependencies [5b33da9]
- Updated dependencies [15d427b]
- Updated dependencies [7034b55]
- Updated dependencies [91971b6]
- Updated dependencies [a913881]
- Updated dependencies [c4c8961]
- Updated dependencies [4342172]
- Updated dependencies [bb663a4]
- Updated dependencies [7fd14eb]
- Updated dependencies [f4d2fa2]
- Updated dependencies [5191e1f]
- Updated dependencies [4879996]
- Updated dependencies [ec1d29e]
- Updated dependencies [c229a15]
- Updated dependencies [849b40d]
- Updated dependencies [9218613]
- Updated dependencies [6e563b9]
- Updated dependencies [496167c]
- Updated dependencies [a1cac3a]
- Updated dependencies [eb3477a]
- Updated dependencies [59d3eee]
- Updated dependencies [2dc36d9]
- Updated dependencies [67281fe]
- Updated dependencies [a147a98]
- Updated dependencies [e788537]
- Updated dependencies [7ef3817]
- Updated dependencies [7ddf58d]
- Updated dependencies [8640a74]
- Updated dependencies [4ed84be]
- Updated dependencies [a6685b7]
- Updated dependencies [f0fbc59]
- Updated dependencies [36b8950]
- Updated dependencies [4fd8d44]
- Updated dependencies [93017a3]
- Updated dependencies [91180fb]
- Updated dependencies [192a2f2]
- Updated dependencies [da5fea6]
- Updated dependencies [e19f7c2]
- Updated dependencies [b20a25c]
- Updated dependencies [4672203]
- Updated dependencies [12aae94]
- Updated dependencies [dc0064b]
- Updated dependencies [5697d2c]
- Updated dependencies [2e3b965]
- Updated dependencies [5117944]
- Updated dependencies [b9b9447]
- Updated dependencies [192a2f2]
- Updated dependencies [5e55d9c]
- Updated dependencies [19be91c]
- Updated dependencies [d4e91d4]
- Updated dependencies [65c4dc5]
  - @runfusion/fusion@0.45.0

## 0.44.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.44.0
- @fusion/engine@0.44.0
- @fusion/i18n@0.39.7
- @fusion-plugin-examples/cli-printing-press@0.1.24
- @fusion-plugin-examples/compound-engineering@0.1.7
- @fusion-plugin-examples/dependency-graph@0.1.38
- @fusion-plugin-examples/roadmap@0.1.26
- @fusion-plugin-examples/cursor-runtime@0.1.26
- @fusion-plugin-examples/droid-runtime@0.1.33
- @fusion-plugin-examples/hermes-runtime@0.2.57
- @fusion-plugin-examples/openclaw-runtime@0.2.57
- @fusion-plugin-examples/paperclip-runtime@0.2.57

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.44.0
- @fusion/dashboard@0.44.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.44.0
- @fusion/pi-claude-cli@0.44.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.44.0

### @runfusion/fusion

#### Minor Changes

- 6427802: Route Fusion's Claude CLI path through the ACP bridge (`claude-code-cli-acp`) instead of `claude -p` (Route A, dormant behind an OFF-by-default kill-switch).

  - **U10** — forward `mcpServers` on ACP `session/new` through the runtime contract (`AgentRuntimeOptions.mcpServers` + the plugin's `newAcpSession`); defaults to `[]` so existing read-only ACP "ask" turns are unchanged.
  - **U11** — `streamViaAcp`: the `pi-claude-cli` provider can drive Claude through the bundled ACP bridge, returning the same `AssistantMessageEventStream` as the `-p` path. Dispatched only when `FUSION_CLAUDE_ACP=1` and a bridge path are present, so the live `-p` path is byte-for-byte untouched by default. Full-history prompting, schema-only MCP forwarding with break-early on pi-known tools, control-char/size sanitization, env allow-list, process-registry registration, and inactivity timeout.
  - **KTD10** — the ACP runtime plugin publishes its identity-pinned bundled bridge path on load so the kill-switch needs no manual path; it does not enable the transport.
  - **OQ2** — opt-in connection reuse (`FUSION_CLAUDE_ACP_REUSE=1`, default OFF): a warm bridge connection + ACP session is kept across turns of one conversation (keyed by `sessionId`), so multi-turn lanes skip the cold bridge/`claude` spawn and `session/new` round-trip and send only the latest-turn delta (`buildResumePrompt`). A stable `router` indirection serves each turn's handlers; a warm-child death routes failure to the current owner turn (no 30-min inactivity hang), eviction is cache-identity-aware (a concurrent cold turn can't kill a newer entry's child), an empty resume cold-starts instead of issuing an empty prompt, and a per-turn token drops cross-turn stray updates. The idle reaper is `unref`'d. Default OFF → the cold path is functionally unchanged.

  The Claude-via-pi OAuth path is unchanged. Live verification confirmed the bridge gates tool execution behind `session/request_permission` (forwarded MCP tools and native tools do not execute when cancelled). Remaining for a follow-up: picker/auth/status surface (U12), workflow `model`-node verification (U13), and production rollout.

- c1b581e: Add the **Command Center** dashboard — a combined analytics/observability and live Mission-Control view (`?view=command-center`).

  - **Telemetry** — a queryable `usage_events` SQLite table populated via a dedicated `emitUsageEvent` capture seam (tool calls, messages, session lifecycle), feeding date-range aggregators for tokens, tool usage + autonomy ratio, activity (sessions/messages/active-nodes/stickiness), productivity (files/commits/PRs/LOC), and ecosystem breadth — all in `packages/core` and reusable by CLI/engine.
  - **Cost** — derived from token counts via a hand-maintained `model-pricing` map carrying `pricingAsOf` + a staleness flag; unknown models report unavailable rather than guessing.
  - **View** — a new lazy-loaded, ARIA-tabbed Command Center with hand-rolled CSS-bar chart primitives, a date-range picker, per-area panels, a live Mission-Control panel (SSE push + idle-aware polling), and an SDLC funnel.
  - **API** — `GET /api/command-center/{tokens,tools,activity,productivity,live}` (agent-usable), each under session auth and project scoping, with `?format=csv` export and an opt-in OpenTelemetry (OTLP) metrics exporter.

- 898ac1e: Add the Command Center signals analytics endpoint backed by local incidents data and document honest empty-state sentinels for signal metrics.
- 863ebfa: Add a CLI session relaunch route and enable the dashboard's resume-exhausted "Relaunch fresh" action to re-enqueue the owning task for a fresh CLI-agent run.
- 21c4d3e: Dashboard agent chat sessions now load the same agent-declared and enabled plugin-contributed skills as task execution sessions, so plugin skills such as `ce-debug` are available in chat.
- a453716: Render assistant question tool calls as shared in-chat response cards in full Chat and Quick Chat.
- a998f63: Enable creating workflow node connections from the mobile workflow editor.
- e2a3a37: Add a project setting for configuring the auto-merge conflict retry cap before Fusion parks or bounces tasks for recovery.
- 05fe6e5: Compound Engineering now treats stage launch settings as an explicit `disabledStages` opt-out list so newly bundled stages, including `ce-debug`, remain launchable on existing installs with stale settings snapshots.
- b6ac5f2: Add bounded-by-default verification guardrails: project `verificationCommandTimeoutMs`, marathon command detection, and an explicit `allowFullSuite` escape hatch for full verification runs.
- 0453a65: Request agent and enabled plugin skills across planning, mission interview, workflow design, memory insight, and scheduled automation agent sessions.
- cdadac1: Load selected Fusion and enabled plugin skills in milestone/slice interview and agent-onboarding dashboard sessions.
- f41732d: Add a live-updating, animated Command Center token-usage-over-time view with hour/day/week granularity and bounded polling for token totals.
- 504305e: Add a Command Center GitHub issue analytics endpoint and dashboard area showing issues filed by Fusion, issues fixed by Fusion, net flow, daily trends, and by-repository breakdowns from the local project task store.
- 64092ca: Add Command Center agent-run sheets that show total, active, completed, and failed heartbeat runs in the Activity area and Overview, plus agent-run daily activity and CSV export rows.
- 36f1fee: Add the Command Center Team tab and `/api/command-center/team` endpoint for project-scoped per-agent token, cost, files-changed, task-completion, and live-status analytics.
- af31f7d: Move System Stats into the Command Center as a redesigned graph-rich System area with gauges, trend sparklines, task/agent bars, and relocated Vitest controls; remove the standalone System Stats modal plus its Header and mobile More affordances.
- 94a081f: Persist GitHub source issue closure timestamps and use them for exact Command Center "Fixed by Fusion" date bucketing, falling back to task `updatedAt` only when the real close time has not been observed.
- 9b396b6: Add an optional project-scoped GitHub source-issue closed-at backfill endpoint that fills historical imported tasks with real GitHub `closed_at` values for more accurate Fixed by Fusion analytics.
- 2059790: Add a Command Center GitHub affordance for operators to run the historical source-issue closed-at backfill and review accumulated scanned, filled, skipped, and error counts.
- d6e2f92: Add `recharts` and shared Command Center PieChart/LineChart wrappers for downstream graphical chart migrations. The wrappers are token-themed, responsive, reduced-motion aware, and safe for empty, zero, negative, NaN, and Infinity inputs; the current production build shows no observable Command Center chunk-size increase yet because no Command Center surface imports the new wrappers until the dependent migration tasks land (CommandCenter chunk remains 74.68 kB / 16.46 kB gzip in this task's build output).
- 99d799c: Add Command Center pie and line chart affordances to the Overview, Tokens, Tools, Activity, and Productivity analytics surfaces using existing analytics data.
- 5e1a4ff: Add Command Center pie and line charts to Team, Ecosystem, GitHub, Signals, and System surfaces using existing analytics data.
- 47e7b4a: Populate Command Center Productivity Lines changed from merge-time commit association diff stats when available.
- c1b581e: Add the **Monitor stage** (U13) — deployment and incident tracking that closes the SDLC loop.

  - **Schema** — new `deployments` and `incidents` SQLite tables (`packages/core/src/db.ts`, `SCHEMA_VERSION` 119 → 120, migration added in the same change; fingerprint auto-covers SCHEMA_SQL tables).
  - **Metrics** — real MTTR (incident-open → resolved) plus deploy/incident counts in `activity-analytics`, replacing the prior unavailable seam.
  - **Ingestion** — `POST /api/monitor/{deployments,incidents}` self-authenticate via a shared ingest secret (constant-time bearer check, fail-closed) with SSRF-untrusted payload links; `GET /api/monitor/metrics` exposes the aggregates.
  - **Loop closure** — a `monitor` workflow trait can auto-open a single fix task on a regression signal, guarded by `groupingKey` grouping, a threshold/sustained gate, cooldown absorption, a per-window circuit breaker, and a self-loop guard.

- 168dc2f: Export Command Center analytics over OpenTelemetry (OTLP) so teams can ship token / cost / activity metrics to Datadog / Grafana / etc. **Disabled by default** (U10, R4).

  - New pure mapping `mapAnalyticsToOtlp` in `@fusion/core` (`otel-metrics.ts`) turns the token/cost/activity aggregator outputs into the OTLP/HTTP JSON wire shape (`resourceMetrics`) — counters for token/cost, gauges for activity — with `model` / `provider` / `node.id` / `agent.id` attributes per data point. Fully testable without a live collector; no SDK dependency in core.
  - Dashboard exporter (`otel-exporter.ts`) periodically maps current analytics and POSTs them to a configured collector, wired into `server.ts` startup/shutdown.

  **SDK choice:** ships a **minimal OTLP/HTTP JSON exporter rather than the official `@opentelemetry/*` SDK** — and therefore adds **no new runtime dependency**. The OTLP/HTTP JSON protocol is a single, stable `POST /v1/metrics` of a well-defined JSON envelope (built in core), so for a default-disabled feature we avoid pulling the multi-package SDK (sdk-metrics + exporter-metrics-otlp-http + resources + api). The wire shape is collector-compatible; swapping in the official SDK later is mechanical. (If maintainers prefer the real SDK, that is a follow-up changeset + dependency add.)

  **Enabled only via env** (none set ⇒ nothing starts): `FUSION_OTEL_METRICS_ENDPOINT` (full `/v1/metrics` URL, required to enable), `FUSION_OTEL_METRICS_HEADERS` (`k=v,k2=v2` auth headers), `FUSION_OTEL_METRICS_INTERVAL_MS`, `FUSION_OTEL_METRICS_TIMEOUT_MS`, `FUSION_OTEL_RESOURCE_ATTRIBUTES`.

  **Security:** endpoint validated on write — `http://` is rejected in production (exporter does not start) and warns loudly otherwise; auth header (Datadog/Grafana token) VALUES are never logged and are masked in diagnostics; a collector-unreachable failure logs (redacted) and backs off exponentially without crashing the server or blocking requests.

- 951c6ef: Ingest external signals (Sentry / Datadog / PagerDuty / generic webhook) into triage tasks via a common `SignalSource` adapter seam (U11, KTD8).

  - New `POST /api/signals/:provider` endpoints, mirroring the GitHub ingestion path. Verified, normalized signals create a task in the `triage` column via the existing task store.
  - Generic webhook is the must-work path; Sentry/Datadog/PagerDuty are thin adapters with provider-specific HMAC verification + payload normalization. Each normalized `Signal` carries a `groupingKey` (Sentry `issue.id`, PagerDuty `incident.id`, Datadog monitor key; the generic webhook requires a caller-supplied key or falls back to `source + normalized-title`) for the downstream storm guard.
  - Security (mandatory): per-provider HMAC against an env-sourced secret (never source-controlled) with 401 on missing/invalid secret or signature — the generic webhook is never an unauthenticated task-creation endpoint; ±5 min replay window + delivery-id nonce dedup; persistent external-id dedup; ~1 MB body cap; per-source rate limit; field-length + meta-byte caps; SSRF-untrusted handling of payload URLs; `meta` stored as data, never rendered as raw HTML.

- 0a87890: Add a persistent, incrementally-refreshed knowledge index (U14) downstream agents can query.

  - **Schema** — new `knowledge_pages` SQLite table (`packages/core/src/db.ts`) with `SCHEMA_VERSION` bumped 118 → 119 (added in the same change as the migration; the fingerprint auto-covers SCHEMA_SQL tables). Keyword search uses a denormalized lowercased `searchText` column with AND-of-terms `LIKE` matching, deliberately avoiding SQLite FTS5 (not available on every build) and any external embedding API.
  - **Index module** (`packages/dashboard/src/knowledge-index.ts`) — upsert-by-source-key pages, a model-free keyword query API, and `refreshKnowledgeForTask` that re-indexes a single completed task (one upsert, never a full re-index, so unaffected pages keep their timestamps). This is the delta over the existing `insights`/`memoryView` surfaces, which are LLM-extracted learnings, not a deterministic searchable index of concrete task/PR history.
  - **Refresh hook** — `KnowledgeIndexRefreshService` listens for `task:moved → done` (mirroring `GitHubSourceIssueCloseService`) and is wired alongside the other completion listeners; fail-soft so it can never disrupt task completion.
  - **Query API** (`register-knowledge-routes.ts`) — `GET /api/knowledge/query` and `POST /api/knowledge/refresh`, registered as an `ApiRouteRegistrar` so they inherit the dashboard's standard session/auth middleware (401 when unauthenticated) and apply `getScopedStore(req)` (no cross-project reads), exactly like U9.

#### Patch Changes

- c8788d8: Align the workflow editor's client-side column trait validation details with the server validator so conflicting trait compositions identify the same source traits before save.
- 265d9ec: Fix task workflow selection so successful workflow changes and clears notify dashboard clients to refresh board workflow lanes.
- def4bd9: Add dashboard controls for renaming regular Chat and Quick Chat sessions.
- 62335f8: Fix two post-merge Full Suite test failures. Sync the roadmap store's schema-version assertion to core's `SCHEMA_VERSION` (116 → 117). Stop `useCeSessions` background refreshes (poll fallback and push events) from clearing an error a `cancel`/`remove` just surfaced — an in-flight session kept the poll running, which silently erased the action error before the user could see it.
- cd2da10: Wire dashboard CLI session banner actions so needs-attention sessions surface, supported actions call existing routes/settings flows, and unsupported actions render disabled instead of silently doing nothing.
- fee0178: Guard no-commits-expected tasks from being finalized as done by no-op merge/self-healing lanes when skipped or incomplete steps outweigh completed work.
- bc6dfd3: Surface paused workflow graph exits that occur outside `in-progress` as operator-actionable failures instead of leaving tasks stranded.
- 0093678: Block release and publish-class tasks during triage unless they were explicitly authorized by a user-authored source.
- 3158e9c: Fix the dashboard TUI Agents view so pressing `s` starts the selected agent without also switching back to Main.
- 0db8134: Bound `fn_task_list` text output across CLI, dashboard, and engine tool surfaces so oversized board listings remain plain text with an explicit truncation marker instead of overflowing host response budgets.
- a15b4ca: Keep the chat sidebar visible at a compact bounded width when a tablet software keyboard opens, then restore the previous width when the keyboard closes.
- 198fb17: Keep prior chat thread messages visible while reconnecting to an in-flight streamed assistant response.
- 98cb80d: Fix the tablet task detail modal sizing so the action footer remains on-screen and the modal uses more viewport width.
- 4a9fe99: Allow chat attachments to be sent without accompanying text in Quick Chat and Main Chat while still rejecting fully empty sends.
- d35f93e: Refresh dashboard mobile and PWA home-screen icons from the canonical Fusion logo and bump the service-worker cache for installed app updates.
- 550715d: Bringing up Quick Chat now focuses the composer input on desktop (matching existing mobile behavior).
- 89171e0: Polish the bundled Compound Engineering dashboard view so its spacing, radii, and controls align with Fusion dashboard design tokens and shared component classes.
- 914842f: Make Chat the first tab and default active view in the task detail modal while preserving explicit initial tab requests.
- 6ced5d7: Fix workflow graph merge-node failures so merge-seam aborts are not misclassified as pause/resume aborts. Non-paused merge failures now route to the bounded auto-merge retry path instead of being parked failed with no merge retry count.
- a84a8e1: Fix `fn_task_list` crashes when the runtime `@fusion/core` formatter export is unavailable by resolving defensively and returning bounded fallback text.
- 593ebac: Resolve task-list text formatting defensively when an installed core package is missing the `formatTaskListText` runtime export, preserving `fn_task_list` output with a bounded inline fallback.
- 403bd9d: Prevent custom workflows from reaching terminal success when declared task-document artifacts are missing, and keep malformed blocking gate verdicts from being treated as successful workflow-step passes.
- 01b80db: Add a Fusion-native `fn_ask_question` tool for dashboard chat agents so structured questions render in the existing chat response card and answers return through the next chat message.
- 5b9ff04: Keep previously persisted main-chat conversation messages visible while reconnecting to an in-flight assistant response.
- 1bd8f6d: Fix mobile terminal cell measurement by making xterm font stacks use real monospace text faces before the Nerd Font symbols fallback.
- 19aac38: Load dashboard chat skills requested with `/skill:{name}` and strip the command token from model prompts.
- a013bc0: Fix the perpetual step off-by-one: `fn_task_update` and `fn_review_step` now treat `step` as 0-based, matching the `### Step N:` numbering in PROMPT.md (Step 0 = Preflight) and `TaskStore.updateStep`. Previously the tools were 1-indexed while everything agent-facing was 0-based, so agents could not mark Step 0 done and reviews/progress landed one step early.
- 4c3186d: Prefer fresher TypeScript plugin source over stale gitignored dist output in dev/worktree plugin resolution when no `bundled.js` exists. Production bundled installs remain unaffected because `bundled.js` still always wins.
- 0767d1b: Generalize bundled plugin freshness checks across staged CLI plugin artifacts.
- 29b27a7: Improve Command Center tool analytics by categorizing Fusion tool families and re-bucketing historical `other` rows.
- 98ccf8a: Completed no-commit executions that finalize to in-review are no longer re-parked as failed "engine abort during pause/resume" operator-action graph failures; genuine pause and hard-cancel semantics are preserved.
- 4dd5337: Close cached CLI extension TaskStore instances on session shutdown so task-tool runs do not leave SQLite handles behind.
- 4929198: Lower the shared `fn_task_list` plain-text budget and cover filtered column listings with realistic regression cases so large todo, planning, and done outputs stay host-safe.
- 673a8a6: Fix `fn_task_list` column filters so empty target columns return explicit text instead of an empty content block.
- 58a34e9: Clamp Command Center SDLC completion analytics to cohort-based conversion rates and add the radial completion gauge plus animated live activity signals.
- 3d28b3b: Preserve already-streamed chat text, thinking, and tool-call state when the dashboard reattaches to an in-flight assistant response.
- dae0bde: Encourage dashboard chat agents to use structured `fn_ask_question` cards when offering choices or alternatives.
- ab8ecb2: Stop the engine from registering merge-trait hooks that collided with core's in-review field-effects adapter and could crash workflow-column moves.
- b1a2aee: Expose task document read/write tools to dashboard chat agents with explicit `task_id` targeting.
- 16b6e5d: Fix mobile iOS terminal cell measurement by making xterm font remeasure resilient to strict FontFaceSet shorthand rejection and pinning text-size adjustment on terminal viewports.
- 0ed46d9: Expose task document read/write tools to planning agents with explicit task IDs, matching chat session behavior.
- 3b32b53: Completed/no-commit executions that finalize to review no longer get re-parked failed when later teardown overwrites completion-finalize abort provenance with a hard-cancel marker. Genuine user/global pauses, merge-seam retry routing, and active-execution hard-cancel behavior are preserved.
- b6823af: Fix completed tasks being parked failed in in-review with a spurious "engine abort during pause/resume — operator action required" error (FN-6648; recurrence of FN-6478/FN-6568/FN-6625/FN-6644/FN-6647). The paused-after-completion graceful-exit path finalizes a fully completed task to in-review while leaving a non-user `paused` flag set; `handleGraphFailure`'s completion-finalized guards required `paused !== true`, so the trailing graph failure was misclassified as an operator-action pause abort once the volatile completion markers were lost. The classifier now recognizes finalized completions regardless of a lingering non-user pause flag, while genuine user/global pauses and in-progress tasks are unaffected.
- 2367918: Add attractive Command Center Overview charts for tokens by model, tool categories, and daily activity using existing analytics data.
- 662a09b: Add live animated Command Center Activity line charts for messages, active agents, active nodes, and combined throughput, backed by a reusable zero/NaN-safe LineChart primitive.
- 11c4120: Fix mobile terminal font measurement by keeping the symbols-only Nerd Font out of xterm's measured ASCII font stack while retaining a scoped DOM glyph fallback.
- 21d8076: Fix Command Center mobile chart rendering so chart primitives shrink inside the tabpanel without scroll-stealing overflow, zero-height collapse, or stretch artifacts, and normalize chart/card border and spacing rhythm across the combined analytics surfaces.
- ef54459: Fix Command Center token analytics so Tokens by model and the per-model table group tasks by the actually-used runtime model instead of collapsing resolved-via-settings usage into `(unknown)`.
- 317b08b: Command Center token-cost analytics now price resolved-via-settings task usage from the actually-used model snapshot, with legacy own-model fallback, instead of showing those costs as unavailable.
- fe207ca: Fix Command Center mobile chart rendering by bounding chart label/track layouts in real mobile engines and normalizing chart/card/table border spacing across the dashboard bundle.
- 0f021ae: Fix Command Center charts and shell styling to use the canonical `--accent` and `--text` dashboard tokens instead of undefined `--color-accent` and `--text-primary` aliases, so chart accents and primary text render with the intended colors.
- 282b069: Replace non-Command-Center dashboard CSS references to the undefined `--text-primary` alias with the canonical `--text` token so primary text uses the intended theme-aware color.
- 9d07e85: Fix served dashboard lazy-view preloads so persisted Command Center and other lazy views include their extracted CSS chunks.
- cfddde5: Fix Command Center activity chart rendering so plotted extrema stay visible and chart wrappers keep a measurable default height.
- cc02286: Inline direct and room chat attachments into agent prompts so agents can read text files and receive supported image attachments.
- 84cf3ff: Guard task detail activity-log rendering against legacy/operator log entries that use text/detail instead of action/outcome.
- 283f689: Repair mission autopilot reconciliation so stale triaged/in-progress features without live task cards are retriaged, while generated fix-loop debris is blocked instead of recreating duplicate tasks.

### runfusion.ai

#### Patch Changes

- Updated dependencies [c8788d8]
- Updated dependencies [265d9ec]
- Updated dependencies [6427802]
- Updated dependencies [def4bd9]
- Updated dependencies [c1b581e]
- Updated dependencies [898ac1e]
- Updated dependencies [62335f8]
- Updated dependencies [cd2da10]
- Updated dependencies [fee0178]
- Updated dependencies [863ebfa]
- Updated dependencies [bc6dfd3]
- Updated dependencies [0093678]
- Updated dependencies [3158e9c]
- Updated dependencies [0db8134]
- Updated dependencies [a15b4ca]
- Updated dependencies [21c4d3e]
- Updated dependencies [198fb17]
- Updated dependencies [98cb80d]
- Updated dependencies [a453716]
- Updated dependencies [4a9fe99]
- Updated dependencies [d35f93e]
- Updated dependencies [550715d]
- Updated dependencies [a998f63]
- Updated dependencies [89171e0]
- Updated dependencies [914842f]
- Updated dependencies [6ced5d7]
- Updated dependencies [e2a3a37]
- Updated dependencies [a84a8e1]
- Updated dependencies [593ebac]
- Updated dependencies [05fe6e5]
- Updated dependencies [403bd9d]
- Updated dependencies [01b80db]
- Updated dependencies [5b9ff04]
- Updated dependencies [1bd8f6d]
- Updated dependencies [19aac38]
- Updated dependencies [a013bc0]
- Updated dependencies [b6ac5f2]
- Updated dependencies [0453a65]
- Updated dependencies [4c3186d]
- Updated dependencies [0767d1b]
- Updated dependencies [29b27a7]
- Updated dependencies [cdadac1]
- Updated dependencies [98ccf8a]
- Updated dependencies [4dd5337]
- Updated dependencies [4929198]
- Updated dependencies [673a8a6]
- Updated dependencies [58a34e9]
- Updated dependencies [3d28b3b]
- Updated dependencies [dae0bde]
- Updated dependencies [ab8ecb2]
- Updated dependencies [b1a2aee]
- Updated dependencies [16b6e5d]
- Updated dependencies [0ed46d9]
- Updated dependencies [3b32b53]
- Updated dependencies [b6823af]
- Updated dependencies [2367918]
- Updated dependencies [f41732d]
- Updated dependencies [504305e]
- Updated dependencies [64092ca]
- Updated dependencies [36f1fee]
- Updated dependencies [662a09b]
- Updated dependencies [af31f7d]
- Updated dependencies [11c4120]
- Updated dependencies [21d8076]
- Updated dependencies [ef54459]
- Updated dependencies [94a081f]
- Updated dependencies [317b08b]
- Updated dependencies [9b396b6]
- Updated dependencies [2059790]
- Updated dependencies [fe207ca]
- Updated dependencies [d6e2f92]
- Updated dependencies [99d799c]
- Updated dependencies [5e1a4ff]
- Updated dependencies [0f021ae]
- Updated dependencies [282b069]
- Updated dependencies [9d07e85]
- Updated dependencies [cfddde5]
- Updated dependencies [47e7b4a]
- Updated dependencies [cc02286]
- Updated dependencies [84cf3ff]
- Updated dependencies [c1b581e]
- Updated dependencies [283f689]
- Updated dependencies [168dc2f]
- Updated dependencies [951c6ef]
- Updated dependencies [0a87890]
  - @runfusion/fusion@0.44.0

## 0.43.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.43.1
- @fusion/engine@0.43.1
- @fusion/i18n@0.39.6
- @fusion-plugin-examples/cli-printing-press@0.1.23
- @fusion-plugin-examples/compound-engineering@0.1.6
- @fusion-plugin-examples/dependency-graph@0.1.37
- @fusion-plugin-examples/roadmap@0.1.25
- @fusion-plugin-examples/cursor-runtime@0.1.25
- @fusion-plugin-examples/droid-runtime@0.1.32
- @fusion-plugin-examples/hermes-runtime@0.2.56
- @fusion-plugin-examples/openclaw-runtime@0.2.56
- @fusion-plugin-examples/paperclip-runtime@0.2.56

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.43.1
- @fusion/dashboard@0.43.1

### @fusion/engine

#### Patch Changes

- @fusion/core@0.43.1
- @fusion/pi-claude-cli@0.43.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.43.1

### @runfusion/fusion

#### Patch Changes

- 59f2596: Fix the standalone `fn plugin new` scaffold so generated plugins include the required `state: "installed"` field and build unedited with `pnpm build`. This also lets the documented `fn plugin dev . --once` path complete its pre-load build step instead of failing TypeScript validation for a missing `FusionPlugin.state`.

  Manual end-to-end spot-check for release validation: `npx @runfusion/fusion@<ver> plugin new proof-point-plugin && cd proof-point-plugin && pnpm install && pnpm build && npx @runfusion/fusion@<ver> plugin dev . --once`.

  Registry evidence captured for the original failing release: `npm view @runfusion/fusion@0.43.0 dist.integrity` returned `sha512-kvxicT+e8ulc7FDhBVP9NsgaioZv6NDW81N8cXNS/X8M32Eo3Y33xT6JFW2DrSiFXsJmAaib/GnpQE0nYQYApQ==`.

- 1f540b2: Persist planning-session response history before agent continuation so retry/replay and SQLite session recovery retain answered turns when generation errors or transitions complete.
- 19eca3d: Park incomplete tasks that exhaust stuck-loop recovery instead of making them scheduler-runnable again.

### runfusion.ai

#### Patch Changes

- Updated dependencies [59f2596]
- Updated dependencies [1f540b2]
- Updated dependencies [19eca3d]
  - @runfusion/fusion@0.43.1

## 0.43.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.43.0
- @fusion/engine@0.43.0
- @fusion/i18n@0.39.5
- @fusion-plugin-examples/cli-printing-press@0.1.22
- @fusion-plugin-examples/compound-engineering@0.1.5
- @fusion-plugin-examples/dependency-graph@0.1.36
- @fusion-plugin-examples/roadmap@0.1.24
- @fusion-plugin-examples/cursor-runtime@0.1.24
- @fusion-plugin-examples/droid-runtime@0.1.31
- @fusion-plugin-examples/hermes-runtime@0.2.55
- @fusion-plugin-examples/openclaw-runtime@0.2.55
- @fusion-plugin-examples/paperclip-runtime@0.2.55

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.43.0
- @fusion/dashboard@0.43.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.43.0
- @fusion/pi-claude-cli@0.43.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.43.0

### @runfusion/fusion

#### Minor Changes

- 9149121: Enable Z.ai GLM-5.2 model selection.
- 64de883: Make the built-in compound-engineering workflow run the CE way end-to-end:

  - **Execute** stage invokes the `compound-engineering:ce-work` skill in coding mode instead of the generic executor prompt.
  - **Merge** stage adds `ce-commit-push-pr` and `ce-resolve-pr-feedback` skill steps (CE owns commit/push/PR + feedback; Fusion's merge seam still owns the board-state merge). The plugin now bundles `ce-commit`, `ce-commit-push-pr`, and `ce-resolve-pr-feedback`.
  - **Planning questions reach a human:** workflow-step sessions carry a `FUSION_WORKFLOW_STEP` signal; in that mode the CE skills emit an await-input sentinel instead of calling a blocking tool with no listener. The executor parks the task `awaiting-user-input` with the question, and a new task-card **"Answer questions"** button opens the workflow tab where the existing input banner captures the answer and resumes the step.
  - **Subagents work in workflow steps:** `fn_spawn_agent` gains an optional `systemPromptOverride`; the plugin installs the 43 `ce-*` persona definitions plugin-locally and exposes their directory via `FUSION_CE_AGENTS_DIR`, so the CE skills read a persona def and spawn it as a real subagent (falling back to inline single-agent work when unavailable).

- e8c2d51: Add a one-click dashboard Update now action for installing available Fusion updates.

#### Patch Changes

- 740c712: Inline the private `@fusion/core` types into the published `@runfusion/fusion/plugin-sdk` declaration entry so standalone external plugins created with `fn plugin new` can typecheck and `pnpm build` cleanly against released Fusion. Human spot-check: `npx @runfusion/fusion@0.42.0 plugin new proof-point-plugin && cd proof-point-plugin && pnpm install && pnpm build`.
- b1ba87e: Ensure `zai/glm-5.2` reliably appears in the model list after user Z.ai provider extensions load.
- 65a4c51: Recover stale Compound Engineering sessions on plugin load and session reads so persisted active rows without live agent handles no longer leave the dashboard stuck waiting for work that is not running.
- 20aad56: Fix "Couldn't start local Fusion" on the Linux AppImage (and any packaged build launched from a desktop launcher). The embedded local runtime now roots its data at the user's home directory (`~/.fusion`) instead of `process.cwd()`, which was `/` or the read-only AppImage mount point and caused database creation to fail with EACCES/EROFS. Set `FUSION_HOME` to override the location.
- 066c919: Preserve the original corrupt project database at `fusion.db` when startup recovery fails after moving it aside.
- 0d75725: Fixed unreliable horizontal scrolling when swiping across task cards on the mobile board. Native HTML5 drag is now disabled on touch-primary devices (where it never worked anyway), so the browser no longer hijacks swipe-to-scroll gestures that start on a card.
- 67ae2be: Fix two mobile chat send failures. The regular chat send button was dead to touch because the action only ran on `onClick`, which iOS suppresses after `preventDefault()` in the touch sequence — it now fires from pointerdown/touchstart with a dedupe latch. Quick chat messages could strand in the composer (shown locally but never sent to the agent or persisted) when a queued message's delivery trigger bailed — a dropped stream leaving the streaming flag stuck `true`, or a stream that looked healthy when queued but then stalled. A queued send now detects a stale flag at send time via the stream's connection state and the server's generation status, and a delivery watchdog re-confirms any message that stays pending and force-delivers it once no generation is actually in flight.
- fd6caaa: Fix sporadic quick chat send failures on mobile (notably the first message after a response). A real touch tap dispatches both `pointerdown` and `touchstart`, and the quick chat send button ran its action on each — firing `handleSendMessage` twice per tap. Because React had not yet flushed the composer clear between the two events, both reads saw the same text and sent, and the hook's second send closed the first's freshly-opened stream and re-POSTed, which could drop the response. The send and stop buttons now claim a single action per tap so only the first of the paired events fires.
- 9eeaaa7: Fix the quick chat stop button rendering too narrow. It borrowed ChatView's `.chat-input-stop` styling, which sizes itself with `--chat-input-control-size` — a variable scoped to ChatView's composer and undefined in the quick chat DOM — collapsing the button toward its icon width. It is now pinned to the send button's square dimensions.
- ee6d7ac: Workflow step execution now surfaces task attachment locations in the context-recovery prompt path and no longer tells autonomous agents to ask for context.
- 14ed177: Restored horizontal swiping on mobile kanban board columns while preserving page-level horizontal pan containment.
- df01ab7: Fix Create Pull Request conflict preflight to derive `conflictsWithBase` from `git merge-tree --write-tree` exit codes instead of non-empty output, and treat no-op PR conflict resolution merges as successful without attempting an empty commit.
- 96773dd: Fix standalone installs of the published CLI crashing with `ERR_MODULE_NOT_FOUND` for `@earendil-works/pi-coding-agent`. `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are now plain required dependencies instead of also being optional peers, so clean npm and pnpm installs resolve the pi runtime packages.
- 67d4d51: Move task-card timing badges from the top metadata cluster into the bottom-right footer chip cluster so timers align with retry and GitHub footer badges.
- 7b83906: Run the configured or inferred dependency install inside temporary standalone AI-merge clean-room worktrees before merge/review verification.
- be2773b: Fix scheduler concurrency diagnostics and semaphore slot accounting so queued tasks are not held behind contradictory or negative capacity readings.
- 3cc82bd: Fix mobile board horizontal overflow that caused iOS Safari to zoom-out/cut-off the board and let the whole page pan off-screen. Screen-reader-only `.visually-hidden` spans were `position: absolute` with no offsets, so inside the horizontally-scrolled kanban columns they rendered off-screen-right and ballooned the document's scroll width. Pinning the utility to its containing block's origin keeps the document locked to the viewport on mobile.
- aa71ace: Refresh expired Claude OAuth access tokens from Fusion auth storage instead of requiring repeated manual re-login.
- 417183d: Send task-detail Chat composer messages on plain Enter while preserving Shift+Enter newlines and Cmd/Ctrl+Enter sending.

### runfusion.ai

#### Patch Changes

- Updated dependencies [9149121]
- Updated dependencies [740c712]
- Updated dependencies [b1ba87e]
- Updated dependencies [65a4c51]
- Updated dependencies [64de883]
- Updated dependencies [20aad56]
- Updated dependencies [066c919]
- Updated dependencies [0d75725]
- Updated dependencies [67ae2be]
- Updated dependencies [fd6caaa]
- Updated dependencies [9eeaaa7]
- Updated dependencies [ee6d7ac]
- Updated dependencies [e8c2d51]
- Updated dependencies [14ed177]
- Updated dependencies [df01ab7]
- Updated dependencies [96773dd]
- Updated dependencies [67d4d51]
- Updated dependencies [7b83906]
- Updated dependencies [be2773b]
- Updated dependencies [3cc82bd]
- Updated dependencies [aa71ace]
- Updated dependencies [417183d]
  - @runfusion/fusion@0.43.0

## 0.42.0

### @fusion/dashboard

#### Patch Changes

- Updated dependencies [630b2a8]
  - @fusion/engine@0.42.0
  - @fusion/core@0.42.0
  - @fusion/i18n@0.39.4
  - @fusion-plugin-examples/cli-printing-press@0.1.21
  - @fusion-plugin-examples/compound-engineering@0.1.4
  - @fusion-plugin-examples/dependency-graph@0.1.35
  - @fusion-plugin-examples/roadmap@0.1.23
  - @fusion-plugin-examples/cursor-runtime@0.1.23
  - @fusion-plugin-examples/droid-runtime@0.1.30
  - @fusion-plugin-examples/hermes-runtime@0.2.54
  - @fusion-plugin-examples/openclaw-runtime@0.2.54
  - @fusion-plugin-examples/paperclip-runtime@0.2.54

### @fusion/desktop

#### Patch Changes

- @fusion/dashboard@0.42.0
- @fusion/core@0.42.0

### @fusion/engine

#### Patch Changes

- 630b2a8: Allow narrowly scoped plan-only operational tasks to complete without source commits when their prompt or metadata explicitly declares no-source/no-code intent and their recorded evidence satisfies the task. The commit guard still rejects missing commits for normal implementation tasks and still enforces worktree and branch invariants before applying the no-commit exemption.
  - @fusion/core@0.42.0
  - @fusion/pi-claude-cli@0.42.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.42.0

### @runfusion/fusion

#### Minor Changes

- e22afec: Add workflow-native typed settings for triage/spec policy thresholds and routing defaults. The built-in defaults preserve current behavior: size bands remain S <2h, M 2-4h, L 4-8h; subtask signals use the canonical planning-prompt values of step threshold 7 and packages/modules threshold 3; file-scope/remediation thresholds remain 20 and 30.

  These triage policy settings are new workflow settings, not moved project settings, so they are excluded from the U4 `MOVED_SETTINGS_KEYS` tombstone while still resolving through workflow effective settings.

- 039d3ce: Fast-mode triage is now expressed as workflow-declared policy: the lean prompt lives in the built-in `default-triage-fast` agent prompt and `planning-fast` seam, while `leanPlanning` and `autoApproveSpec` are workflow-native settings for prompt selection and spec-review auto-approval.

  The internal `FAST_TRIAGE_SYSTEM_PROMPT` engine constant was removed. Existing `executionMode: "fast"` tasks remain byte-equivalent through a single legacy execution-mode-to-resolved-policy bridge.

- 167f9b0: Allow engineer-role agents to opt into no-task backlog auto-claim for implementation tasks while preserving executor-only default pickup behavior.
- 1c4ec5f: Add dashboard controls for the engineer backlog auto-claim opt-in at project scope and per-agent heartbeat settings.
- eb607c6: Make dashboard modals touch-resizable on tablet and widen the task-detail modal default tablet width.
- f7f2cae: Move Frontend UX criteria injection from AI self-instructions into deterministic engine-applied workflow policy, preserving the byte-equivalent checklist and idempotent insertion behavior.
- 4e6df03: Add a verified no-op/duplicate task completion path so executors can close already-satisfied tasks without fabricating commits by using an audited `fn_task_done` sentinel summary.
- 7ffea9f: Expose Google Generative AI as a selectable custom-provider API type in the dashboard settings UI and documentation.
- 508551c: Allow tasks to be archived from any live board column and restored to their pre-archive column.
- bd87ce7: Add workflow-declared optional steps and expose Browser Verification as the built-in coding workflow's opt-in optional step for task creation and editing.
- 72661fa: Title summarization now accepts descriptions of any length by truncating the model input to a bounded prompt instead of rejecting descriptions over 2000 characters.
- 07d5262: Sync workflow setting values across nodes in settings push, pull, receive, and status flows.

#### Patch Changes

- 8eb99ed: Quick Entry no longer auto-focuses when the board or dashboard becomes visible.
- 36f5ecd: Skip custom workflow pre-merge prompt, script, and gate nodes when a task runs in fast execution mode.
- 1a716f2: Resolve the standard triage planning prompt from the selected workflow IR planning node instead of the removed engine-side `TRIAGE_SYSTEM_PROMPT` duplicate. The built-in `default-triage` prompt is now the canonical policy source for `builtin:coding`; where the old copies disagreed, the surviving canonical subtask-split threshold is `MORE THAN 7 implementation steps` (with the matching `MORE THAN 3 different packages/modules` guidance). Fast-mode triage continues to use `FAST_TRIAGE_SYSTEM_PROMPT` unchanged.
- fb2c6e5: Resolve the built-in reviewer base prompt from the workflow IR `review` node instead of an engine-local `REVIEWER_SYSTEM_PROMPT` duplicate. The canonical reviewer policy now lives in the `default-reviewer` agent prompt / built-in workflow seam, with reconciled superset content that preserves the FN-5928/FN-6229 surface-enumeration and symptom-verification gates, undersplit-task guidance, test-quality rules, worktree-boundary review, and the embedded port-4040 safety rule.
- c0ff360: Fix mobile dashboard blanking after toggling the in-review auto-merge switch by keeping the board visible when real browsers horizontally pan the document to the offscreen column control.
- 12621aa: Record explicit `builtin:coding` project-default workflow selections even when the compiled built-in has zero materialized steps, while preserving interpreter-deferred `builtin:stepwise-coding` fallback behavior.
- 30e747b: Standalone plugin scaffolds now declare the dev toolchain they generate scripts and config for: `@types/node`, `vitest`, and `typescript`. This lets projects created with `fn plugin new` install, build, test, and load through `fn plugin dev . --once` via the documented external-author path without relying on transitive or hoisted dependencies.

  Manual spot-check for release validation:

  ```sh
  npx @runfusion/fusion@latest plugin new proof-point-plugin
  cd proof-point-plugin
  pnpm install
  pnpm build
  pnpm test
  fn plugin dev . --once
  ```

- 8c16395: Stop self-healing from removing worktrees that are still in use. The idle-worktree and cap-enforcement sweeps now skip any worktree bound to a live executor/merger/step/workflow session, so a checkout is no longer reaped while its task transiently sits in `done` or loses its worktree linkage mid-run.
- d5b45c8: Fix "Couldn't start local Fusion" on the Linux AppImage (and any packaged build launched from a desktop launcher). The embedded local runtime now roots its data at the user's home directory (`~/.fusion`) instead of `process.cwd()`, which was `/` or the read-only AppImage mount point and caused database creation to fail with EACCES/EROFS. Set `FUSION_HOME` to override the location.
- f0d2415: Fix custom provider message sends failing with a `ByteString` error (`character ... value 8226`). The settings UI displays the saved API key masked with `•` characters; saving the provider without retyping the key persisted that mask as the real credential, which then broke HTTP header encoding. Masked values echoed back on update are now treated as "unchanged" and the stored key is preserved; masked values on create/probe are rejected.

  The edit form no longer seeds the API key field with the masked value at all — it starts blank (with a "Leave blank to keep current key" hint) so the mask can never be echoed back to save or "Detect Models". Existing keys are preserved when the field is left empty.

- a83c2d8: Fix custom provider models not appearing in model dropdowns. The `/models` endpoint filtered results to providers configured in Fusion's auth stores, which excluded custom providers (stored in global settings). Their registry keys are now added to the allowlist so their models surface in pickers.
- cbc3157: Fix the mobile chat keyboard collapsing on iOS Safari. Several ancestor/scroll mutations were blurring the focused composer textarea:

  1. `.chat-thread--keyboard-active` declared `transform: translateY(...)` + `will-change: transform` in CSS, keeping a non-`none` transform on `.chat-thread` (an ancestor of the composer) for the whole keyboard-active window. The drift compensation is now applied imperatively in JS only when iOS actually shifts the visual viewport (`offsetTop > 0`), so the ancestor stays `transform: none` on focus.

  2. The mobile keyboard scroll-lock pinned `body { position: fixed }` a beat after the composer was focused — the textbook iOS keyboard-dismiss trigger. App-level and ChatView keyboard pins now use a new `useMobileKeyboardViewportLock` that locks `overflow: hidden` + `scrollTo(0, 0)` WITHOUT changing `position` (the same approach the Quick Chat panel uses), so iOS keeps the input focused. Modals are unchanged and keep the `position: fixed` lock.

  3. The direct-chat composer's `handleInputFocus` ran `window.scrollTo(0, 0)` on every focus to undo iOS layout drift. That scroll fires while iOS is still raising the keyboard, which aborts the raise — the keyboard opened then immediately dismissed on re-focus (first tap fine, every tap after a dismiss broken). The drift reset now happens on **blur** instead — when the keyboard is already closing, so there is nothing to dismiss — immediately plus a short follow-up that is cancelled on the next focus, so a fast re-tap can't scroll mid-raise. Each focus therefore starts at `scrollY 0` and the keyboard lock's `scrollTo(0, 0)` is a harmless no-op.

  4. The mobile bottom nav stayed on screen while the keyboard was up: `.mobile-nav-bar--keyboard-open` only pinned it to `bottom: 0` and relied on the keyboard to cover it, but on iOS the layout viewport doesn't shrink, so the bar overlapped the composer. It now slides fully off-screen (`translateY(100%)` + `pointer-events: none`) while typing. Safe for the keyboard because the nav is a sibling of the input, not an ancestor.

- cbc3157: Fix the Quick Chat FAB not opening on iOS Safari. The drag hook calls `setPointerCapture()` in `pointerdown`, which makes WebKit swallow the synthetic `click`, so the FAB never toggled on iPhone. The open/close toggle now fires from the drag hook's `pointerup` (a real user gesture, so the stealth-input focus still raises the keyboard), with the trailing synthetic click de-duped so mouse and test click paths are unaffected.
- e5036b1: Fix the Quick Chat send button going dead after switching chats on mobile. The send and stop buttons run their action on `pointerdown`/`touchstart` (iOS needs that) and set a shared `handledMobileActionRef` latch so the trailing synthetic `onClick` doesn't double-fire — but the latch was only ever cleared inside `onClick`. On iOS, `preventDefault()` in `touchstart` routinely suppresses that click, leaving the latch stuck `true`, so the next real click (e.g. after opening a different chat) was swallowed and the button appeared unresponsive. The latch is now self-clearing: it auto-resets on a short timer after each gesture and is consumed-and-cancelled when a click does fire, so it can never persist across taps. Because the ref is shared by both buttons, this also stops a stuck stop-button latch from killing the next send tap.
- 535c40d: Fix task creation failing with "node 'merge-gate' branches into 2 edges — graphs with branches require the workflow interpreter (deferred)". The built-in coding workflow now models the merge lifecycle as a branching region of merge/retry/branch-group primitives (FN-6035), but the linear workflow compiler still tried to lower those nodes and rejected their fan-out. The compiler now treats the merge-region primitive kinds (merge-gate, merge-attempt, manual-merge-hold, retry-backoff, recovery-router, branch-group-member-integration, branch-group-promotion) as an engine-owned terminal boundary — exempt from the single-edge linearity rule and never lowered to a step — so linear-prefix workflows compile to their pre-merge step list again.
- e35f3dd: Classify harmless temporary merge worktree cleanup failures after `git worktree prune`/porcelain inspection while keeping still-registered worktree leaks visible in merger diagnostics.
- 3a729f5: Allow narrowly-scoped Review Level 1 coordination tasks with board-only file scope and explicit no-source intent to complete without commits while preserving the missing-commit guard for implementation tasks.
- c285f3f: Fix pi 0.79 extension discovery compatibility and retry stale title-summarizer model ids with automatic model resolution.
- 9a78814: Stop review entry from freezing the global auto-merge setting onto tasks. Tasks without an explicit per-task auto-merge override now continue to follow the live global setting, so toggling global auto-merge off stops newly-entered non-override in-review tasks from being auto-merge processed.
- 2085610: Move AI-merge clean-room worktrees into a repo-local cleanup-exempt root, guard cleanup sweeps by active merge ownership, and classify missing clean-room worktree failures as transient so merges can retry cleanly.
- d23c5d9: Fix task detail Pull Request and Review surfaces so they use the live project auto-merge setting instead of a stale modal-open snapshot. Create PR / manual merge affordances now appear immediately when auto-merge is toggled off, and the automatic auto-merge hint returns when it is toggled back on.
- 4fc00b6: Self-heal compound-engineering answer submission for restarted awaiting-input sessions by rehydrating the interactive session before sending the answer.
- 65251d2: Pausing or sleeping an agent no longer pauses its assigned tasks. Assigned tasks now keep their existing pause state so only explicit user actions pause ordinary task work.
- bffae81: Add `autoMergeProvenance` so Fusion can distinguish explicit per-task auto-merge overrides from legacy review-entry stamps. Startup now marks ambiguous legacy in-review `autoMerge: true` rows as `legacy-stamp` without changing behavior, and the operator-visible `reconcileLegacyAutoMergeStamps` action (dry-run by default) can clear those legacy stamps so global auto-merge OFF is respected while genuine user overrides are preserved.
- 0897b2a: Add a bounded persisted auto-retry for transient workflow-graph resume failures after engine restart or unpause, while preserving terminal failures for genuine graph errors.
- ec4b247: Re-fire durable-agent assignment wakes that were skipped because the agent was mid-heartbeat, so newly assigned tasks are worked when the active run completes instead of waiting for the next timer tick.
- 751d942: Fix workflow graph execution for the built-in coding workflow's merge-policy primitive region by collapsing any merge-region entry back to the legacy `merge` seam until the workflow interpreter owns merge policy execution.
- 93237c3: Fix mobile chat composer first taps so iOS and Android preserve native keyboard focus across direct chat, room chat, and Quick Chat.
- 480e55f: Fix non-English Active Agents next-heartbeat translations so localized strings interpolate the provided elapsed heartbeat value instead of showing a raw placeholder.
- 0a135c9: Fix the task details Chat tab so it opens and reactivates at the latest agent output while preserving scroll-away behavior for live updates.
- 66591ec: Add dashboard and CLI operator surfaces to inspect and apply legacy auto-merge stamp cleanup.
- a9b1139: Self-healing now automatically re-dispatches an assigned in-progress task when its durable agent loses both the heartbeat run and active execution session, preventing the task from stranding until the next engine restart.
- f2054d0: Reliably settle the task detail Chat transcript to the latest output on load and tab reactivation, including after collapsible thinking/tool groups reflow.
- 34ada00: Show user-sent task-detail Chat steering messages as You bubbles and keep them visible after steering requests persist.
- 35554e6: Keep the task-detail Chat composer pinned and visible while the transcript scrolls internally on mobile and desktop.
- e0ec3d1: Steering messages sent from task chat now reach active step-session and workflow runs, including parallel step sessions, and the misleading inactive-session "next session" composer copy was removed.
- f68775a: Ensure only explicit user actions unpause user-paused tasks. Engine self-healing, agent resume cascades, dashboard agent-state resume fallback, heartbeat recovery, and approval-decision resume no longer clear `userPaused` or auto-unpause tasks the user paused.
- 4ea9d66: Fix automatic agent runs to resolve executor, planning, heartbeat, merger, and validator models from fresh task/settings configuration before falling back to durable agent runtime defaults.
- 44b756d: Fix built-in branching workflow selection so interpreter-deferred coding workflows can be selected or used as project defaults without throwing during legacy step materialization.
- e6eef1a: Handle insight extraction agent responses deterministically by accepting prompt return text, falling back to session state, and surfacing a 503 error when no assistant text is produced.
- e305b1a: Respect per-task pause state during triage planning so paused tasks do not auto-advance after specification approval.
- 40cb0d3: Keep the dashboard usage dialog near the top of the viewport across desktop popover, modal, and mobile presentations.
- f16b038: Add workflow work-item storage primitives for workflow-owned merge migration.

### runfusion.ai

#### Patch Changes

- Updated dependencies [8eb99ed]
- Updated dependencies [36f5ecd]
- Updated dependencies [1a716f2]
- Updated dependencies [e22afec]
- Updated dependencies [fb2c6e5]
- Updated dependencies [039d3ce]
- Updated dependencies [c0ff360]
- Updated dependencies [167f9b0]
- Updated dependencies [1c4ec5f]
- Updated dependencies [12621aa]
- Updated dependencies [30e747b]
- Updated dependencies [eb607c6]
- Updated dependencies [8c16395]
- Updated dependencies [d5b45c8]
- Updated dependencies [f0d2415]
- Updated dependencies [a83c2d8]
- Updated dependencies [cbc3157]
- Updated dependencies [cbc3157]
- Updated dependencies [e5036b1]
- Updated dependencies [535c40d]
- Updated dependencies [e35f3dd]
- Updated dependencies [3a729f5]
- Updated dependencies [c285f3f]
- Updated dependencies [f7f2cae]
- Updated dependencies [9a78814]
- Updated dependencies [2085610]
- Updated dependencies [d23c5d9]
- Updated dependencies [4fc00b6]
- Updated dependencies [65251d2]
- Updated dependencies [4e6df03]
- Updated dependencies [bffae81]
- Updated dependencies [0897b2a]
- Updated dependencies [ec4b247]
- Updated dependencies [7ffea9f]
- Updated dependencies [751d942]
- Updated dependencies [508551c]
- Updated dependencies [93237c3]
- Updated dependencies [bd87ce7]
- Updated dependencies [72661fa]
- Updated dependencies [480e55f]
- Updated dependencies [0a135c9]
- Updated dependencies [66591ec]
- Updated dependencies [a9b1139]
- Updated dependencies [f2054d0]
- Updated dependencies [34ada00]
- Updated dependencies [35554e6]
- Updated dependencies [e0ec3d1]
- Updated dependencies [f68775a]
- Updated dependencies [4ea9d66]
- Updated dependencies [44b756d]
- Updated dependencies [e6eef1a]
- Updated dependencies [07d5262]
- Updated dependencies [e305b1a]
- Updated dependencies [40cb0d3]
- Updated dependencies [f16b038]
  - @runfusion/fusion@0.42.0

## 0.41.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.41.0
- @fusion/engine@0.41.0
- @fusion/i18n@0.39.3
- @fusion-plugin-examples/cli-printing-press@0.1.20
- @fusion-plugin-examples/compound-engineering@0.1.3
- @fusion-plugin-examples/dependency-graph@0.1.34
- @fusion-plugin-examples/roadmap@0.1.22
- @fusion-plugin-examples/cursor-runtime@0.1.22
- @fusion-plugin-examples/droid-runtime@0.1.29
- @fusion-plugin-examples/hermes-runtime@0.2.53
- @fusion-plugin-examples/openclaw-runtime@0.2.53
- @fusion-plugin-examples/paperclip-runtime@0.2.53

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.41.0
- @fusion/dashboard@0.41.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.41.0
- @fusion/pi-claude-cli@0.41.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.41.0

### @runfusion/fusion

#### Minor Changes

- 4151a19: Bump `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` from `^0.78.0` to `^0.79.1`. This adds **Claude Fable 5** (`claude-fable-5`) model support on the Anthropic and Amazon Bedrock providers, with adaptive thinking and `xhigh` effort. Fable now appears automatically in the registry-driven model picker for users with Anthropic (or Claude CLI) auth configured. See the upstream pi coding agent changelog for [`0.79.1` (2026-06-09)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md).

### runfusion.ai

#### Patch Changes

- Updated dependencies [4151a19]
  - @runfusion/fusion@0.41.0

## 0.40.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.40.1
- @fusion/engine@0.40.1
- @fusion/i18n@0.39.2
- @fusion-plugin-examples/cli-printing-press@0.1.19
- @fusion-plugin-examples/compound-engineering@0.1.2
- @fusion-plugin-examples/dependency-graph@0.1.33
- @fusion-plugin-examples/roadmap@0.1.21
- @fusion-plugin-examples/cursor-runtime@0.1.21
- @fusion-plugin-examples/droid-runtime@0.1.28
- @fusion-plugin-examples/hermes-runtime@0.2.52
- @fusion-plugin-examples/openclaw-runtime@0.2.52
- @fusion-plugin-examples/paperclip-runtime@0.2.52

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.40.1
- @fusion/dashboard@0.40.1

### @fusion/engine

#### Patch Changes

- @fusion/core@0.40.1
- @fusion/pi-claude-cli@0.40.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.40.1

### @runfusion/fusion

#### Patch Changes

- e62847b: fix: keep `./dist/*` subpaths resolvable in the packed manifest

  The prepack transform injects an `exports` field for the plugin-sdk subpath,
  which flips Node into strict subpath mode and hid every other `./dist/*` file.
  That broke the runfusion.ai alias (which imports
  `@runfusion/fusion/dist/bin.js`) with `ERR_PACKAGE_PATH_NOT_EXPORTED`, failing
  the pre-publish smoke test. Add a `./dist/*` passthrough so the alias bin and
  the pi `./dist/extension.js` loader keep resolving after pack.

### runfusion.ai

#### Patch Changes

- Updated dependencies [e62847b]
  - @runfusion/fusion@0.40.1

## 0.40.0

### @fusion/dashboard

#### Patch Changes

- 2d2024f: Unfreeze dashboard spinners and pulse/enter animations. Transition tokens
  (`--transition-slow: 0.3s ease`) bundle a duration and an easing; 15 animation
  declarations reused them as bare durations, which made the whole `animation`
  declaration invalid at computed-value time and silently resolved it to
  `animation: none`. Animation rules now use new duration-only tokens
  (`--duration-instant/fast/normal/slow`), with the transition tokens derived
  from them, and a repo-wide CSS regression test forbids the pattern.
- 784f308: Fix first tap of GitHub tracking icon in quick task entry on mobile (FN-6148).

  The delegated touch handler on `.quick-entry-actions` now uses `closest("button")` to resolve taps that land on child SVG elements, so the GitHub tracking toggle responds correctly on the first touch — identical root-cause fix as FN-6145.

  - @fusion/core@0.40.0
  - @fusion/engine@0.40.0
  - @fusion/i18n@0.39.1
  - @fusion-plugin-examples/cli-printing-press@0.1.18
  - @fusion-plugin-examples/compound-engineering@0.1.1
  - @fusion-plugin-examples/dependency-graph@0.1.32
  - @fusion-plugin-examples/roadmap@0.1.20
  - @fusion-plugin-examples/cursor-runtime@0.1.20
  - @fusion-plugin-examples/droid-runtime@0.1.27
  - @fusion-plugin-examples/hermes-runtime@0.2.51
  - @fusion-plugin-examples/openclaw-runtime@0.2.51
  - @fusion-plugin-examples/paperclip-runtime@0.2.51

### @fusion/desktop

#### Patch Changes

- Updated dependencies [2d2024f]
- Updated dependencies [784f308]
  - @fusion/dashboard@0.40.0
  - @fusion/core@0.40.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.40.0
- @fusion/pi-claude-cli@0.40.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.40.0

### @runfusion/fusion

#### Minor Changes

- 61d6874: Add a guarded interpreter-authoritative workflow cutover for coding-task lifecycle execution. The new capability stays default-off behind `experimentalFeatures.workflowInterpreterAuthoritative` and only activates when rollout-readiness checks pass, preserving legacy execution as the fallback path.
- 93e8bd9: Add mission↔goal linkage tooling across Fusion surfaces: REST mission goal endpoints, `fn mission goals|link-goal|unlink-goal` CLI commands, and `fn_mission_list_goals|fn_mission_link_goal|fn_mission_unlink_goal` pi-extension tools.
- 26bc80a: Add mission↔goal batch linking support across REST, CLI, and pi-extension surfaces.

  - `POST /api/missions` and `PATCH /api/missions/:missionId` now accept optional `goalIds: string[]` for mission goal linking on create and update.
  - `fn mission create --goal <id>` supports repeatable goal flags to link goals during mission creation.
  - Mission goal link surfaces now reject archived goals with `GOAL_ARCHIVED` while preserving `404` for missing goals.
  - Unlink paths remain permissive so archived goals can still be removed from missions.

- 489a287: Add an ACP (Agent Client Protocol) client runtime plugin (`runtimeId: "acp"`)
  that drives any external ACP-compatible agent over JSON-RPC/stdio, built on the
  official `@agentclientprotocol/sdk`. Installed on demand (experimental).

  The agent runs as an untrusted subprocess that calls back into Fusion, so the
  integration ships a defense-in-depth security floor: per-category permission
  gating against the live policy (never a preset shortcut; `allow_once` only;
  unmappable kinds and missing policy default-deny), an unrestricted-risk
  acknowledgement that escalates blanket allows to approval under the allow-all
  default, an opt-in filesystem capability behind a real symlink-resolving cwd jail
  (realpath + `O_NOFOLLOW`, secret/`.git` deny-list, writes gated through the
  permission policy), untrusted-output sanitization and bounds, and an env
  allow-list for the subprocess.

- c1c99a9: Wire the CLI Agent Executor as a selectable executor kind for the task execute
  path (U7). A workflow node with `config.executor === "cli-agent"` (plus
  `cliAdapterId` and optional `cliAutonomy`/`cliNotify`) now drives an engine-owned
  CLI coding agent (Claude Code / Codex / Droid / Pi / generic) through the execute
  step inside the task worktree.

  The new `cli-agent/task-session.ts` orchestrates the task↔session lifecycle:
  spawn in the worktree, mint the per-session hook token and write the hook scripts,
  inject the task prompt after readiness, subscribe to the authoritative state
  machine, and resolve on a positive completion signal (origin R20 gating — a
  native `done` advances the pipeline; the generic tier never auto-advances on idle
  and exposes a `confirmAdvance()` affordance instead). The resolved executor config
  is snapshotted at launch, so a mid-run node-config edit applies to the next run
  only. The PTY is reaped (recorded `completed`) at the execute→in-review handoff.

  Lifecycle semantics honor the existing contracts: a hard cancel
  (`moveTask(in-progress→todo)` / column-exit abort) SIGKILLs the CLI session via
  the same dispose/abort path API sessions use and marks it `killed` (never
  resume-eligible); a re-plan/RETHINK re-entry kills any prior live session and
  launches fresh; a follow-up to a done task resumes the recorded native session id
  when the adapter supports resume, else launches fresh. A PTY-pool ceiling
  (`CliConcurrencyLimitError`) surfaces as a clear queued/rejected task state rather
  than a silent stall.

- d8248b4: Add the CLI Agent Executor hook ingestion route and per-session hook scripts
  (U17). The dashboard now serves a localhost-only `POST /api/cli-agent/hooks`
  endpoint that authenticates per-session hook POSTs from a spawned CLI agent and
  forwards the validated payload in-process to the engine telemetry hub (the engine
  has no HTTP server — only the dashboard serves HTTP).

  The route is hardened because localhost is not a trust boundary: it validates the
  high-entropy per-session token against the engine-held registry (a session id
  alone is never sufficient, and a token for one session never validates for
  another), rejects browser-context requests via Origin/Host CSRF checks, caps the
  payload size, and treats an unknown/non-live session as a 200 no-op rather than a
  crash. It is exempt from the daemon bearer-token middleware (hook scripts only
  hold the per-session token) but authenticates with that token instead.

  The engine gains `hook-scripts.ts`: it generates the per-session hook script and
  notify shim (Orca `agent-hooks` shape — `curl` POST of the stdin JSON with the
  session token header, short timeouts, always exit 0), writes them into a
  session-scoped config dir (owner-only, executable), and deletes that dir on
  session end (the token is registry-invalidated at the same moment, bounding its
  at-rest exposure to the session lifetime).

- ace7106: CLI-agent hybrid chat (U12): a chat session can select a cli-agent executor and
  be driven by a long-lived CLI agent process. Adapter transcript telemetry maps
  to durable chat_messages rows at user/assistant/tool-summary granularity (raw
  tool noise stays in the terminal), with the shared `redactSecrets` pass applied
  before persistence so transcripts never become a secret store. Composer sends
  route through the inject path with FIFO queueing; the flush decision re-fetches
  authoritative session state rather than trusting a cached busy flag. The chat
  surface gains a transcript ↔ raw-terminal toggle (terminal owns input, composer
  hidden in terminal mode); generic-tier sessions render terminal-only with no
  toggle. New per-session `cliExecutorAdapterId` linkage on chat_sessions.

  ChatView now mounts `CliChatSurface` for cli-backed sessions (the message-pane +
  composer region is delegated to it; regular sessions keep the standard composer),
  and the engine `TelemetryHub` gains a narrow optional `onEvent` tap (settable via
  `setEventListener`) so the chat transcript runner can observe the same sanitized
  events the hook route already feeds, without the hub becoming a subscriber bus.

- 7a80d29: Mobile terminal interaction for cli-agent sessions (U13). `SessionTerminal` now
  detects mobile viewports via the canonical breakpoint
  (`(max-width: 768px), (max-height: 480px)`) and renders a bottom input model in
  place of relying on xterm's hidden-textarea (unreliable on mobile): a visible
  text input that forwards typed text + `\r` as input frames on submit, plus an
  accessory key bar emitting exact control sequences — Esc (`0x1B`), Tab (`0x09`),
  a dedicated Ctrl-C (`0x03`), ANSI CSI cursor arrows (`CSI A/B/C/D`), and a sticky
  Ctrl modifier whose next key combines into a control byte (Ctrl-C `0x03`,
  Ctrl-D `0x04`, Ctrl-Z `0x1A`) with a visible active state.

  Bar keys apply the iOS composer survival pattern (pointerdown/mousedown
  preventDefault, action on click) so the input keeps focus, and the bar behaves as
  a fixed footer that lifts above the virtual keyboard via `useMobileKeyboard`
  (including its pinch-zoom `vv.scale > 1` guard, which is not treated as
  keyboard-open). xterm `onData` input stays attached (the bar is primary, not
  exclusive). Bar keys and the input are deliberate user keystrokes routed straight
  to the session input path. All new strings are localized in the `app` i18n
  catalog.

- 8bac390: Add CLI-agent one-shot sessions for the validator, planning, and CE plugin
  surfaces (U9). A one-shot session runs an adapter's non-interactive invocation
  (`claude -p`, `codex exec --json`, `droid exec --output-format json`,
  `pi --print`) to completion in a working directory, streams output to a
  read-only terminal (input disabled server-side via the durable
  `autonomyPosture.readOnly` flag the transport's `isReadOnlySession` honors),
  parses the adapter's structured JSON result, and reaps the PTY on exit.

  The new `cli-agent/one-shot-session.ts` returns a typed result: a success with
  the parsed payload, or a typed failure (`nonzero-exit` / `unparseable` /
  `spawn-failed`) carrying a bounded output tail. The validator integration
  (`cli-agent-validator.ts`) maps results into the existing
  pass/fail/blocked/error verdict contract — a malformed or unparseable result
  maps to `error`, NEVER a silent pass. A planning seam (`runCliAgentPlanning`)
  maps one-shot output into the same `PlanningResponse` shape a model run
  produces, and the CE plugin's orchestrator threads an `executor` option
  (`model` | `cli-agent`) end-to-end to its resolver.

- 10acf17: Add the CLI agent resume coordinator and self-healing integration (U8). On
  engine start, sessions persisted as live (starting / ready / busy /
  waitingOnInput) are classified `engineDeath` and queued for resume respecting
  the session-manager concurrency ceiling. Resume verifies the recorded worktree
  still exists (missing → needsAttention, never a CLI spawned into a vanished
  directory), detects a dirty worktree (logged + flagged on the session record,
  resume proceeds), relaunches via the adapter's `buildResume` with the recorded
  native session id in the recorded worktree, re-attaches telemetry, and
  re-injects no prompt. Only `crashed`/`engineDeath` are resume-eligible
  (`killed`/`userExited`/`authFailed`/`completed` never); attempts are capped at 2
  with backoff; exhaustion, an unsupported adapter, a missing vendor session
  store, or an immediate spawn error route to needsAttention (a permanent-failure
  path, not a retry loop).

  Self-healing idle-worktree sweeps (`enforceWorktreeCap`, `cleanupOrphans`,
  unregistered-orphan reap) now skip a worktree backing a resume-eligible
  `cli_sessions` record via a narrow `isWorktreeResumeReserved` seam, and the
  stuck-task detector suppresses stuck/inactivity flagging while a task's CLI
  session is `waitingOnInput` via a narrow `isCliSessionWaitingOnInput` seam — the
  U3 stall backstop remains the only escalation while genuinely waiting.

- 5872331: Bootstrap the CLI Agent Executor runtime and wire it end-to-end.

  A new `createCliAgentRuntime` factory (engine) constructs the per-project bundle — a `CliSessionStore` over the project's existing core Database, a per-runtime adapter registry with all five bundled adapters, the `CliSessionManager` (PTY lifecycle), the `TelemetryHub` (per-session token registry rebuilt from live records), and the `CliResumeCoordinator` (relaunch re-mints a hook token + rewrites hook scripts) — returning the executor bundle, the `isWorktreeResumeReserved` / `isCliSessionWaitingOnInput` predicates, and a scoped `dispose`.

  The runtime is instantiated per project in `InProcessRuntime` behind the `experimentalFeatures.cliAgentExecutor` flag (opt-in, matching the `workflowGraphExecutor` precedent): the bundle threads into `TaskExecutorOptions.cliAgentRuntime`, the predicates feed the self-healing idle-worktree sweep and the stuck-task detector, and `resumeCoordinator.recoverOnStart()` runs non-blocking after engine start (errors logged, never thrown). The dashboard hook endpoint URL is derived from a server-threaded option, falling back to a localhost URL from `FUSION_DASHBOARD_PORT` (default 4040).

  The dashboard now resolves the project's `TelemetryHub` via `cliAgentHubResolver`, mounts the cli-sessions transport from the runtime's manager + store, and brokers cli-backed chat sends: a chat session with a `cliExecutorAdapterId` routes composer sends to a `CliChatSessionRunner` (instead of the model agent loop), and the hub's sanitized telemetry is routed per-session into the runner's transcript handler.

- 17c9303: CLI agent session transport (U10): authenticated cli-sessions REST routes
  (list, single-use session-scoped attach tickets, inject, confirm-advance), a
  distinct `/api/cli-sessions/ws` WebSocket attach handler (daemon-token + Origin
  allowlist + single-use ticket gate, scrollback replay then live byte frames,
  ACK-credit flow control driving engine pause/resume, latest-active-client
  resize, server-side read-only enforcement, input-source attribution), a
  streaming-safe outbound output filter (`neutralizeTerminalOutput`) that strips
  OSC 52 clipboard writes, non-http(s) OSC 8 hyperlink URIs, and device-status /
  query sequences, and a throttled `cli:session:state` SSE event with
  Last-Event-ID replay.
- 243113a: Add CLI-agent adapter launch settings, an autonomy approval gate, and workflow
  node-editor configuration for the CLI Agent Executor (U15).

  A new `cliAgents` slice of global settings holds per-adapter operator launch
  config — command override, extra args, autonomy mode, and env allowlist
  additions — validated and sanitized at the write boundary (unknown adapter ids
  and invalid fields are dropped). Shipped defaults are owned by the adapters.

  The autonomy gate closes the "adjacent settings" bypass: elevation requested
  through ANY channel (the autonomy field, extra args such as
  `--dangerously-skip-permissions`, an autonomy-toggling env var, or a non-default
  command override) is detected over the FULLY RESOLVED argv + env via per-adapter
  elevation markers plus a shared generic env-pattern set. `resolveEffectivePosture`
  derives the posture chip from the resolved invocation — never the autonomy field
  alone — and the effective posture is denormalized onto the session record at
  spawn. An elevated launch without a stored per-project approval fails with a
  typed `CliAutonomyNotApprovedError` instead of stalling. Approvals are per-project

  - per-adapter (mirroring the raw workflow-CLI-command approval precedent) and the
    approving principal in v1 is the daemon-token holder.

  The dashboard adds daemon-token-authed routes
  (`/api/cli-agents`, `/api/cli-agents/settings`,
  `/api/cli-agents/:adapterId/approve-autonomy` + revoke), a Settings section for
  per-adapter launch config with an explicit confirmation flow before elevated
  autonomy is approved, and a workflow node-editor block that surfaces an adapter
  picker (with native/hybrid/generic tier labels), an autonomy toggle, and the
  waiting-on-input notification mode (banner / banner+notify) when a node's executor
  is `cli-agent`. All new strings are localized in the `app` i18n catalog.

- e10db81: CLI agent terminal UI (U11): a shared `SessionTerminal` component (lazy-loaded
  xterm + fit/webgl/unicode11) that attaches to the U10 cli-sessions WebSocket
  with ACK flow control, a posture chip (baseline vs elevated), a read-only
  badge, session-idle/ended replay states, and a generic-tier confirm-advance
  strip. Adds a `terminal` tab to the task detail view driven by the lifecycle
  visibility matrix (live / read-only live / replay-idle / replay-ended / hidden)
  with live `cli:session:state` SSE merging, waiting-on-input and needs-attention
  task-card badges (distinct from staleness/stall badges), and extends
  `SessionNotificationBanner` with a `cli-agent` session type plus the pinned
  needs-attention variants (userExited / authFailed / resume-exhausted) and their
  actions. All new strings flow through the i18n catalogs.
- 57631c7: Add full-screen TUI attach to cli-agent sessions (U14). The Ink dashboard TUI
  can hand the terminal to a CLI agent session as a raw passthrough: it enters the
  alternate screen, streams WebSocket terminal bytes to stdout and stdin keystrokes
  back as input frames, propagates resizes, and ACKs consumed bytes for flow
  control. The detach chord (Ctrl-]) restores the TUI cleanly, and a dropped
  connection surfaces an error and restores the terminal. Untrusted terminal output
  is neutralized through the same hardening filter the dashboard WS bridge uses
  (OSC 52 clipboard writes, non-http(s) OSC 8 links, and device-status queries are
  stripped before reaching the host TTY).
- 3cf13dd: Add the Compound Engineering bundled plugin: a dedicated dashboard surface for compound-engineering artifacts and interactive `ce-*` sessions, a work→board bridge, and bidirectional board↔pipeline sync. Sessions are fully multi-session: a Sessions panel lists every run with stage/status/last-activity, lets you open and switch between concurrent sessions (each keeps running server-side), resume interrupted ones, and discard settled ones (`DELETE /sessions/:id` disposes the live handle before deleting the row).

  Sessions show the agent's full working output live (streamed thinking/tool activity with an inactivity-based stall timeout instead of a fixed turn timeout), the user can steer mid-stage with free-text guidance (attached to an answer or sent on its own), and the transcript renders past questions/answers/working traces as a proper chat surface.

  This also adds two reusable host capabilities that any plugin benefits from:

  - **Interactive agent sessions for plugin routes** (`ctx.createInteractiveAiSession`), with skill-discovery forwarding (`requestedSkillNames` / `additionalSkillPaths`) and live mid-turn progress streaming (`onProgress`: thinking/text deltas + tool markers) so a plugin can load a bundled skill into a live session and surface its work in real time.
  - **Real plugin event push over SSE**: a plugin's `ctx.emitEvent` calls are forwarded to connected `/api/events` clients as project-scoped `plugin:custom` events, and dashboard views can consume them via the new `subscribePluginEvents` view-context capability.

- ee5f5e8: Add "New folder" button to DirectoryPicker for project setup

  The directory picker in the project setup flow now includes a "New folder"
  button that lets users create folders directly when selecting a project path.
  This includes:

  - New `POST /api/create-directory` endpoint for creating directories
  - Create folder UI in DirectoryPicker with inline error handling
  - Keyboard support (Enter to create, Escape to cancel)
  - Client-side validation for folder names (no path separators or traversal)

  Also fixes a bug where navigating into an empty folder would revert to the
  previous directory.

- e854d33: Add `fn onboard` command: a sequential, prompt-based onboarding wizard covering central DB creation, AI provider setup (API key), first project init, core settings defaults, and a next-steps tour. Persists a `cliOnboardingCompletedAt` completion marker in global settings (distinct from the dashboard `setupComplete` first-run flag).
- 641b932: Add a safe onboarding auto-launch hook in the CLI bootstrap path. When the central DB is missing, interactive TTY commands now trigger `fn onboard` automatically before command dispatch, while non-interactive contexts (non-TTY, `serve`, `daemon`, explicit skip signals) remain unchanged and never block execution.
- 2053f3f: Add `fn onboard`: an explicit, user-invoked onboarding command that runs a sequential, prompt-based wizard for central DB creation, AI provider setup (API key), first project init (`fn init`), core settings defaults (global `testMode` and project `maxConcurrent`), and a next-steps tour. It persists a `cliOnboardingCompletedAt` completion marker in global settings so later runs are skipped unless `--force` is passed.
- e9de195: Add dashboard shared branch-group visibility and controls: branch-group list/show/assign/promote API routes, grouped task surfacing, and a completion-gated branch-group card that only reveals PR/merge actions once all members are landed.
- eb425d1: Add a dedicated dashboard Group Task Modal for shared branch groups. Grouped badges in task cards and subtask planning now open a modal showing shared branch status, member landed progress, tracked PR state, member-task quick links, and completion-gated promote actions.
- 9c29e2e: Add a new New Task branch strategy option, **Merge into a shared feature branch** (`shared-group`).

  When selected, task creation now joins an existing open branch group by shared branch name (or creates a `new-task` sourced group when missing), links `branchContext` with `assignmentMode: "shared"`, and derives a per-task working branch from the shared branch instead of running directly on the shared integration branch.

- 3373c0b: Add shared branch-group completion-gate promotion machinery so grouped shared branches promote to the default branch exactly once after all members land. This includes idempotent promotion re-evaluation, finalized branch-group status/PR tracking persistence, and lifecycle wiring that keeps member integration and shared→default promotion as separate phases.
- 130f6f1: Custom OpenAI-compatible providers now register with explicit conservative role compatibility: Fusion defaults `compat.supportsDeveloperRole` to `false` so reasoning-capable models emit the legacy `system` role instead of relying on provider URL auto-detection. Advanced users can opt in per provider with `supportsDeveloperRole: true` when their endpoint explicitly supports the `developer` role.
- 0a418e6: Add the external plugin authoring loop for published Fusion installs: `@runfusion/fusion/plugin-sdk` is available as the public SDK subpath, `fn plugin new <name>` scaffolds standalone publishable plugin packages, and `fn plugin dev <path>` builds, installs, watches, and hot-reloads local plugins during development.
- 30a09e3: Persist mission↔goal many-to-many links with a new `mission_goals` join table, MissionStore link/unlink/list helpers, and a project schema version bump from 100 to 101.
- abbeaec: Surface mission-linked goals across mission read paths, including `fn_mission_show`, mission detail API payloads, and dashboard mission detail navigation into anchored goal cards.
- 577ce12: Document mission-to-goal linkage behavior, including the explicit no-backfill decision for existing missions, and surface an Unlinked badge for active missions without linked goals in Mission Manager.
- 3b9ff42: Add self-healing recovery for stale mission validator runs that are left in `running` after their owning execution disappears.

  Stale validator runs are now reaped to the existing terminal `error` status (rather than introducing a new `cancelled` status), the reap reason is stored in the run summary, active mission features are moved back to `needs_fix` so validation can re-trigger, and startup/maintenance sweeps emit `mission:validator-run-reaped` audit events for recovered rows.

- cc18206: Mission validation now AI-validates all mission criteria by lazily ensuring a per-feature managed assertion at runtime and removing the zero-assertion auto-pass path. Milestone acceptance criteria are threaded into validator prompts, and the dashboard now presents mission criteria as AI-validated instead of informational-only.
- d72cb2a: Move agent logs out of the SQLite `agentLogEntries` table into per-task `.fusion/tasks/{ID}/agent-log.jsonl` files, add one-time migration + source-ref rewrite support, preserve soft-deleted log files for forensics while hiding them from live reads, and switch goal-citation source refs to `agentLog:{taskId}:{lineNo}`.
- 8aed4da: Add AI-assisted conflict resolution to the dashboard Create PR flow so users can resolve task-branch merge conflicts against the selected base branch, push the updated branch, and continue PR creation without leaving Fusion.
- 8891d4b: Add an in-app Create PR remediation that pushes the task branch to `origin`, refreshes preflight status, and unblocks PR creation without leaving Fusion.
- 13c6d96: Add workflow `notify` nodes so custom workflows can dispatch templated notifications through configured providers.
- 6271778: Add `workflow_id` support to agent task creation, delegation, and update tools so agents can select or clear task workflows directly.
- 0b7549a: Enable workflow columns, graph executor, dual-observe, and authoritative interpreter experimental flags by default.
- 1b7e52e: Expose workflow discovery and selection during triage planning, including workflow routing metadata for child task creation.
- b1454c1: Branch-group promotion now creates a single real GitHub PR for the group integration branch when promoting a completed PR-mode group. The PR number/url/state are persisted on the branch group and promotion is idempotent — re-running never opens a second PR (an existing persisted or open PR is reused). The GitHub client is injected into the engine via the same option-callback seam as `processPullRequestMerge`, wired at the `fn daemon`, `fn dashboard`, and `fn serve` construction sites. PR creation only happens for eligible (completion-gated, auto-merge-allowed) groups, and a GitHub failure leaves the group recoverable rather than persisting a false PR state.

  The single managed group PR is now kept in sync through its terminal lifecycle: as additional members land, the PR body is rewritten with the latest member checklist and x/N completion (idempotent body rewrite — sync failures are non-fatal and retry on the next landing). When the persisted PR is closed or merged out-of-band on GitHub, the stored `prState` is reconciled rather than re-opened. Abandoning a group best-effort closes its GitHub PR and marks `prState` `closed` (or preserves `merged`). New injected `syncGroupPr` callback and dashboard `updatePr`/`closePr` GitHub-client helpers back this flow.

  The branch-group surface is completion-gated end-to-end: the dashboard branch-group card and Group Task modal show member progress before completion, reveal the promote/Open-PR control only when the group is complete, render the persisted PR link once promoted, expose an Abandon action while the PR is open, and display a terminal merged/closed state. A new agent-native CLI command (`fn branch-group list | show <id> | promote <id>`) reaches the same promotion coordinator path the dashboard uses — promoting a complete group opens/links the same single managed PR, and an incomplete group is rejected with the same completion-gate message.

- f9e5513: Harden the project database against the recurring "database disk image is malformed" corruption.

  - **Integrity-checked backups**: every backup copy is now verified with `PRAGMA quick_check` before it is kept, a verifiably-corrupt copy is quarantined as `*.corrupt` instead of masquerading as good, and `cleanupOldBackups` will never rotate out the last verified-good backup.
  - **Startup auto-recovery**: on open, a malformed `fusion.db` is detected and rebuilt offline via `sqlite3 .recover` (corrupt original preserved as `fusion.db.corrupt-<ts>`, stale `-wal`/`-shm` dropped) before any connection is established. Opt out with `FUSION_DISABLE_DB_AUTORECOVER=1`. This also fixes a latent bug where the recovery path invoked the non-existent `.recover main` option and always failed.
  - **Database shrink + retention**: scratch `lost_and_found*` tables left by prior recoveries are dropped on init, and a new `operationalLogRetentionDays` setting (default 30 days, configurable in Settings → Backups → Database Maintenance, 0 to disable) prunes unbounded append-only log tables (`activityLog`, `agentLogEntries`, `runAuditEvents`, `agentHeartbeats`) during periodic maintenance to curb the file growth that widens the corruption window.

- 34c8ac9: Add the unified `fn pr` command namespace for CLI parity with the dashboard's
  PR-entity review surface (U8, R13): `fn pr create | list | show | approve |
respond | retry | merge | close | automerge`.

  Each subcommand routes to the SAME store/engine/release path the dashboard PR
  routes use, so the two surfaces can't diverge: `create` mints the GitHub PR;
  `list`/`show` read PR entities; `approve`/`respond`/`retry`/`merge`/`close` fire
  the workflow's user-controlled release edges via `releaseHeldTaskByEvent`
  (`pr-approve`/`pr-respond`/`pr-retry`/`pr-merge`/`pr-close`); `automerge` toggles
  the entity's `autoMerge` flag.

  BREAKING: the per-task `fn task pr-create` command is retired. Use `fn pr create
<task-id>` instead (same flags: `--title`, `--base`, `--body`, `--draft`,
  `--no-ai`, `--reviewer`).

- 5c4c765: Add a dashboard browse-and-install flow for skills.sh catalog entries, including the new `POST /api/skills/install` API route and Skills view install actions that refresh discovered skills after a successful install.
- d071aec: Add executable custom workflows with a visual graph node editor. Author a workflow as a graph (start → prompt/script/gate steps → end) in a new React Flow–based editor, then select it per task or set a project default. Selected workflows compile to the existing WorkflowStep engine and run at the pre/post-merge boundaries — no changes to the scheduler/executor/merger. Non-linear graphs are rejected with a clear message and reserved for the (deferred) graph interpreter.

  Prompt nodes carry an execution profile: run on a chosen model, as a named agent, as a skill invocation, or as a named project script (CLI) with the prompt passed via FUSION_NODE_PROMPT — plus per-node retries and an auto-approve toggle. "User input" nodes pause the run with a needs-input badge on the task card and a banner in the task modal; replying in comments and unpausing resumes the workflow with the answer.

  CLI nodes can run arbitrary commands (not just named scripts); the first run of an exact command pauses the task for explicit user approval. The task modal's input/approval banner is interactive — reply-and-resume for user-input nodes, approve-and-run for CLI commands.

  Agents reach workflows too: the `fn_workflow_list`, `fn_workflow_get`, `fn_workflow_select`, `fn_workflow_create`, `fn_workflow_update`, and `fn_workflow_delete` tools (plus `fn_trait_list` for the column vocabulary) give agents the same author/list/select capability as the dashboard. These are exposed not only to the task executor but also to the chat and planning agents, so you can author and edit workflows directly in a chat or planning conversation; a guard test locks all six tool names to each lane to prevent silent exposure drift. Built-in workflows are now read-only in the editor (palette/inspector disabled, with a "Duplicate to edit" action), and a node's "Auto-approve requests" toggle now actually bypasses the CLI first-run approval pause.

  Also fixes a latent persistence bug where `pausedReason` was written to the in-memory task and read by queries but never stored by the task upsert or mapped back on read — so it was lost on every reload. This silently broke any pause/resume that depends on the reason (workflow CLI-approval and await-input nodes, token-budget pauses, worktrunk failures). The approve-CLI endpoint now derives the approved command solely from the task's pausedReason (ignoring any caller-supplied command), await-input nodes only resume when this node actually paused the task (not on a pre-existing steering comment), and write-capable custom nodes are refused until a task worktree exists so they never mutate the shared repo root.

  The editor itself got a major usability upgrade: card-style nodes with kind accents and live config summaries (model/agent/skill/command, gate mode, hold release, join mode); success/failure edge authoring on regular edges with distinct styling, parallel conditioned edges, and an author-time cycle guard; one-click auto-layout that respects column swimlanes; safe node/edge deletion with cascade semantics; proper dialogs (create/delete/discard) with inline rename, descriptions, and a dirty-state guard on every dismissal path; onboarding/empty states; and the Columns and Fields panels now live in the editor's left sidebar under the workflow list.

  The node editor is now the primary workflow surface: the header and mobile nav open it directly and the legacy Workflow Steps screen is retired. Existing flat steps migrate automatically (and idempotently) on first editor open — every step becomes an insertable template fragment in the new palette Templates section (alongside built-in and plugin step templates), and your default-on steps become a "Migrated steps" workflow that's set as the project default. Task creation now picks a workflow (applied atomically at create) instead of individual step checkboxes.

  Workflows and template fragments import/export as JSON files — with server-side validation, name-collision handling, and automatic stripping of approval-bypass flags from untrusted files. And you can ask AI to design a workflow: describe what you want in the create dialog (or redesign the active workflow from the toolbar) and a planning-lane model emits a validated graph, with interpreter-only branching flagged honestly.

- 9072d71: Add a localization (i18n) foundation across the UI. Introduces react-i18next-backed translation for both the dashboard and the terminal UI, with English as the source language and Simplified Chinese, Traditional Chinese, French, and Spanish as target locales.

  - New `@fusion/i18n` package holding the authored catalogs and shared i18next configuration (namespace split, script-aware zh-CN/zh-TW fallback, plural setup).
  - A `language` preference (`fusion settings`) and a Settings language switcher; the CLI resolves locale from `--lang`, settings, then environment.
  - An `i18next-cli` workflow (`extract`/`sync`/`types`/`status`/`lint`) so adding a future language is a translate-only, near-zero-code operation.

- c1a7231: Redesign the workflow editor mobile surface with a graph outline, mobile add flow, and first-class workflow settings destinations.
- fbc2c37: Convert the built-in PR lifecycle from a selectable task workflow into a reusable workflow-editor fragment template.
- bd5315f: Allow projects to enable or disable built-in workflows from settings, and show built-in workflow seam prompt text in workflow nodes.
- d8a015e: Allow built-in workflow review columns to surface the auto-merge toggle.
- 7076dd4: Make task steps workflow-modelable, behind the `experimentalFeatures.workflowGraphExecutor` flag (off by default).

  Step policy — how a task breaks into steps, how each step is reviewed, and what happens on revision/rethink — was previously fixed engine law. Workflows can now model it as graph structure: a `foreach` node instantiates a per-step template subgraph once per planned step; a `step-review` node surfaces APPROVE/REVISE/RETHINK/UNAVAILABLE verdicts as outcome edges; `rework` edges (the only legal graph cycles, bounded per instance) route revisions back to a `step-execute` seam, with RETHINK triggering a substrate reset-to-baseline (git reset + session rewind). Steps additionally gain parallel execution: with `mode: parallel` + per-instance worktrees, dependency-satisfied steps (declared via `### Step N (depends: 1,2):` annotations) run concurrently off a common base, with an ordered integration stage that lands branches in step order and routes rebase conflicts to a budget-counted rework outcome.

  Step parsing itself becomes a graph node: `parse-steps(artifact, parser)` reads a workflow-declared task artifact and runs a registry parser (built-in `step-headings`/`json-steps`, or plugin-contributed parsers under `plugin:<id>:<parser>`) to write the step list, with routable `no-steps`/`parse-error` outcomes. A `code` node runs sandboxed TypeScript (esbuild + child process, clamped timeout, no store handle) for arbitrary computed routing/field logic. Workflows also declare typed custom task fields (string/text/number/boolean/enum/multi-enum/date/url, with enum options and render hints); values are validated through a single store authority and the task UI renders the field schema dynamically (detail form widgets, card badges, and a workflow-editor Fields panel). `fn_task_update` accepts a `custom_fields` patch; `fn_workflow_create/update` accept the new IR constructs.

  The default coding workflow is untouched and byte-identical (the parity oracle); a new built-in stepwise coding workflow demonstrates the full modeling. With the flag off, step execution, review, and the board are exactly as before.

  **ROLLBACK:** This is flag-gated by `experimentalFeatures.workflowGraphExecutor` and additive on disk. Schema migration v108 only ADDS the `workflow_run_step_instances` table and the `tasks.customFields` column (default `'{}'`) — it rewrites no existing rows. The flag is read once and pinned per run, so a mid-flight toggle never switches a task between the legacy and graph step paths; flag-off rollback mid-task converges via the existing fell-back + git-reconcile recovery, because `Task.steps[]` remains the always-git-reconcilable projection sink. Instance rows are per-run prunable and are never the authority over git history. IR using the new node kinds (`foreach`/`step-review`/`parse-steps`/`code`) is v2-only, and `downgradeIrToV1IfPure` already refuses non-v1 node kinds, so the v2 rollback contract from the columns track is preserved automatically. To downgrade to a pre-v108 binary, turn the flag off and let in-flight stepwise tasks settle (or reconcile from git) first; custom-field values on the dropped column are lost on downgrade, so export any needed field values beforehand.

- 4fa5407: Add per-column agent assignment for workflow columns, behind the combined `experimentalFeatures.workflowColumns` + `experimentalFeatures.workflowGraphExecutor` flags.

  A workflow column can now name a permanent agent from the registry plus a mode — `defer` (the column agent is the default for work in that column that carries no agent/model settings of its own) or `override` (the column agent supersedes node- and task-level agent/model settings). The binding applies to all session-running work attributable to the column's nodes: custom prompt/gate/script nodes, the execute seam's coding session, and step-execute sessions. Precedence is resolved by one shared `@fusion/core` resolver (`resolveColumnAgentBinding` + `resolveEffectiveAgent`) consumed by every reader, with defer/override expressed as explicit named rules and defer granularity all-or-nothing (an own agent identity OR a complete `modelProvider`+`modelId` pair suppresses the column agent). The binding keys off the node's declared IR column; foreach template nodes inherit the enclosing foreach node's column. A missing/deleted agent at resolution time logs and falls back to normal resolution — a live session is never aborted. The built-in default workflow carries no column agents and stays byte-identical (parity oracle); with either flag off, column agents are inert.

  The effective column agent is also the principal for the subsystems that previously assumed the running agent is always `task.assignedAgentId`: action gating (`buildActionGateContext` / `buildPermanentAgentGatingContext`) is computed for the agent actually running; heartbeat serialization honors it in both directions (the execute deferral gate, a second `resumeTaskForAgent` pass that re-dispatches tasks whose effective column agent matches, and a reverse-direction heartbeat-scheduler guard so an `allowParallelExecution=false` column agent never heartbeats concurrently with its own session); and a workflow-definition edit or agent runtimeConfig change that re-keys the column-effective agent/model hot-swaps the running graph session, while an agent deleted mid-session falls back without a restart.

  Authoring lands in the workflow editor: the column panel gains a registry-backed per-column agent picker plus a defer/override mode toggle, bound columns are badged on their headers, and a node inside an override column shows that its own executor settings are superseded (so override never reads as a bug). Picker interaction states are explicit — flags off disables the picker with a tooltip naming both required flags, an in-flight fetch disables it, a failed fetch shows an inline error, and a stored `agentId` missing from the registry renders an "Agent not found" warning that preserves the IR until the author clears or replaces it. Agent references are validated at save time: the `POST`/`PATCH` workflow routes reject an unknown `agentId` with a typed 4xx naming the offending column, and binding an agent whose permission policy is broader than the project default requires an explicit `confirmPolicyEscalation` flag so override cannot silently re-key action gates to a more-privileged agent.

- 60605fa: Add workflow-defined custom columns with composable traits, behind the `experimentalFeatures.workflowColumns` flag (off by default).

  Workflows can now define their own columns, each carrying composable traits (declarative flags plus lifecycle hooks) instead of the fixed `triage → todo → in-progress → in-review → done → archived` pipeline. The dashboard board renders one lane per workflow in use, and graphs gain `hold`, `split`, and `join` nodes for passive dwell and parallel fan-out/join branches. The built-in default workflow reproduces today's pipeline verbatim, and migration rewrites zero task rows — a null workflow selection resolves to the default workflow at read time. With the flag off, the legacy board, transitions, and engine behavior are unchanged.

  **ROLLBACK:** Workflow IR now has a `v2` on-disk shape (custom columns + `hold`/`split`/`join` nodes). Pre-v2 binaries hard-reject any IR whose `version !== 'v1'`, so a naive downgrade would brick rows that had been re-serialized as v2. To keep rollback safe, the store downgrades a workflow back to the `v1` shape on save whenever (a) the `experimentalFeatures.workflowColumns` flag is OFF, and (b) the graph is "pure v1" — only `start`/`prompt`/`script`/`gate`/`end` nodes, no `hold`/`split`/`join`, and exactly the synthesized default columns at their default seam-derived placement. v2 is persisted only when the flag is ON or a genuine v2 feature (custom column, applied trait, custom placement, or a v2-only node) is in use. Reading a downgraded `v1` row on a v2 binary re-upgrades it to the identical v2 graph, so this is lossless. Rollback is therefore only unsafe for workflows that actually use v2 features with the flag ON; turn the flag OFF and re-save such workflows (or delete them) before downgrading to a pre-v2 binary.

- 71822f2: Add workflow extension plugin contracts for move policies, work engines, node handlers, task verdict providers, auto-merge facts, and shared board action services.
- a504238: Add first-class workflow loop nodes with bounded template repetition, exit conditions, editor support, and plugin SDK type exports.
- 61ae1bf: Expose default-workflow Plan/Triage, Executor, and Reviewer model lanes from Project Models settings while keeping workflow setting values as the source of truth.
- e2707af: Add a first-class workflow settings mechanism and hard-move execution policy onto it.

  - **Workflow settings.** Workflows now declare typed settings in their IR (id, type, default, options) — the same authoring pattern as custom task fields. Setting _values_ persist per `(workflow, project)` behind a single validating store authority, and the engine resolves _effective settings_ per task (`stored value ?? declaration default`, dropping values that no longer validate). Built-in `builtin:coding` declares every moved key with its former default, so an untuned project behaves identically.
  - **Hard-move migration.** A one-time, idempotent, per-project migration relocates the step-execution, review/approval, and per-phase model-lane keys out of project/global settings into workflow setting values, removing them from the settings schema entirely. A `MOVED_SETTINGS_KEYS` tombstone list shields cross-node sync, v1 imports, and stale writers from resurrecting a moved key; a consistency test enforces one home per key.
  - **Settings UI redesign.** The Settings modal is rebuilt from shared schema-driven field primitives and per-section components; moved settings show a redirect stub linking to the workflow editor (one release). The new **Workflow editor → Settings** panel (Definitions/Values tabs) and the `fn_workflow_settings` agent tool edit values with typed validation.
  - **Export v2.** Settings export bumps to version 2 with a `workflowSettings` value section; importing a v1 export upgrades any moved key it carries into the appropriate workflow's values. Workflow settings are not synced across nodes yet (surfaced in the sync UI).

#### Patch Changes

- f76716e: Fix custom-provider model resolution in the bundled engine for OpenAI Responses API providers.

  - Align custom-provider reads with global settings directory resolution (including legacy `~/.pi/fusion` and `~/.pi/kb` migration paths), so providers persist across restart and remain visible during agent session creation.
  - Ensure custom provider registration diagnostics include enough detail for troubleshooting registration failures.
  - Improve configured-model resolution errors to clearly identify the failing `provider/model` selection while retaining the existing `"was not found in the pi model registry"` matcher substring and pointing users to Settings → Custom Providers.
  - Add regression tests covering legacy settings-path custom-provider loading and openai-responses provider model resolution.

- fab8a62: Make `fn_goal_list` and `fn_goal_show` available in engine agent sessions, including executor, heartbeat, and triage runs.

  Also make `fn_goal_list` output concise by truncating descriptions to short single-line snippets while keeping full goal descriptions available through `fn_goal_show`.

- 2d81a95: Fix mission→goal link write paths to return `400 { code: "GOAL_NOT_FOUND" }` instead of 404 for unknown goals, aligning the API, CLI, and pi tool contract.
- 40c0048: Fix built-in workflow editor graph edge visibility so read-only built-in workflows render connected, clickable React Flow edges for success, failure, and rework paths.
- 9c84ba2: Built-in coding workflow catalog (`builtin:coding`) now exposes the canonical `BUILTIN_CODING_WORKFLOW_IR` used by resolver/runtime fallback paths, removing drift between workflow surfaces.
- 934071c: Agent-created tasks without explicit titles now request AI title summarization regardless of the project auto-summarize setting.
- d75f861: Harden AI merge temporary worktree cleanup with same-task pre-merge pruning and task-aware stale tempdir sweeping for completed or deleted tasks.
- db971a9: Initialize missing Git repositories automatically when registering Fusion projects.
- 30ba1f0: Expose the dashboard file viewer to plugin views and use it for Compound Engineering artifact documents.
- 07dcb16: Add the Codex, Droid, and Pi CLI agent adapters (U5).

  Three new launch adapters join the engine's CLI agent executor, each declaring honest, verified capability flags so surfaces can render tier differences:

  - **Codex** (hybrid tier): native turn-complete via the session-scoped `notify` config program (`-c notify=[…]`), capturing `thread-id` as the native session id; waiting-on-input is inferred from ANSI-stripped PTY prompt-pattern heuristics (approval menus, idle composer markers, with a spinner/working override) because Codex has no native waiting signal; resume via `codex resume <thread-id>`; rollout JSONL transcript tailed by probing (not hardcoding) the sessions directory for the file matching the thread-id.
  - **Droid** (native tier): Claude-style hooks (`SessionStart`, `Stop`, `Notification`, tool-activity) delivering `session_id`/`transcript_path`/`permission_mode`; a message classifier splits the conflated `Notification` event into permission-request vs idle sub-reasons (both treated as waiting-on-input); resume via interactive `droid --resume <id>` or headless `droid exec -s <id>` — never the bare `-r` that means `--reasoning-effort` in exec mode.
  - **Pi** (native tier): telemetry and transcript from session-JSONL tailing under a session-scoped `--session-dir`; lifecycle events (turn/agent start→busy, end→done, input-request→waiting) plus message rows→transcript; resume via `pi --session <path|partial-uuid>`.

  A new `session-jsonl` transcript source is added to the adapter capability union for Pi.

- f3b700a: Add the generic heuristic-tier CLI agent adapter (U6).

  Arbitrary user-configured CLI commands can now run as engine-owned PTY sessions. The generic adapter declares every native capability disabled (no native done/waiting signal, no transcript) and infers state purely from the terminal byte stream: busy while output progresses or a spinner animates, and a synthetic idle after a configurable quiet window when a prompt-like glyph is showing and no spinner overrides it. Per the completion-gating decision (origin R20) the generic tier NEVER reports done — idle surfaces a "looks idle — confirm to advance" affordance via a new busy-equivalent idle sub-state and never advances the pipeline.

- b9afce3: Fix a batch of CLI Agent Executor review defects:

  - **Schema-version gate**: bump `SCHEMA_VERSION` to 110 so a DB already at 109
    runs migration 110 and gains the `chat_sessions.cliExecutorAdapterId` column
    (it was previously short-circuited). Add the column to the compat-fingerprint
    `MIGRATION_ONLY_TABLE_SCHEMAS.chat_sessions` entry so the fingerprint matches.
  - **Generic adapter double-wrap**: `formatInjection` no longer re-wraps injected
    text in bracketed-paste markers when `bracketedPasteActive`; the session
    manager's security path is the sole wrapper, so the generic adapter (like every
    native one) only appends a carriage return.
  - **Output-filter cross-boundary bypass**: thread one carry buffer across the
    scrollback→live seam in the CLI session WS bridge so a dangerous escape (e.g.
    OSC 52) split across the seam is fully neutralized instead of the held
    introducer being flushed verbatim into the scrollback frame.
  - **Output-filter overflow leak**: when an over-length carry begins with a
    recognized dangerous introducer (OSC `ESC ]` / DCS `ESC P`), drop the
    introducer instead of flushing it as literal, so it cannot recombine with a
    later terminator at the client.
  - **Follow-up never resolves**: `followUp()` now drives the authoritative state
    machine `done→busy` before injecting, so the re-armed result promise resolves
    on the next positive `done` instead of hanging on an idempotent done.

- 38b84a3: Recover failed Planning Mode session loads into the existing retryable error view instead of dropping back to the empty planner. Failed or malformed persisted planning sessions now keep their session id so Retry/Dismiss recovery remains available, while deleted sessions still quietly fall back to a new session.
- 68e52e3: Fix in-review tasks showing other tasks' files in the "files changed" list. `baseCommitSha` was captured as `merge-base(HEAD, origin/main)` at task start, but task branches fork from local main — when local main was ahead by merged-but-unpushed task commits, the recorded base rewound past them, and after the post-merge rebase-and-push rewrote their SHAs the diff range permanently swept the predecessors' files into the new task's diff. The capture now measures against local main first (origin/main as fallback), matching the contamination-base sites.
- 314411c: Fix mission triage silently stranding features when two missions share a base branch.

  `branch_groups.branchName` is globally unique, but `ensureBranchGroupForSource` only checked for an existing group by `(sourceType, sourceId)`. When a second mission's shared-branch triage resolved to a base branch (e.g. `main`) that another mission already owned a branch group for, `createBranchGroup` threw `UNIQUE constraint failed: branch_groups.branchName`. That error escaped `triageFeature` and was swallowed by both of its callers (the validation-failure auto-triage and the startup/maintenance reconcile sweep), leaving the mission's `defined` features — including auto-generated fix features — permanently un-triaged and the mission unable to progress.

  `ensureBranchGroupForSource` now reuses an existing open group for the same branch name (matching the established `getBranchGroupByBranchName(...) ?? ensureBranchGroupForSource(...)` idiom) instead of colliding on the unique constraint.

- 7d417a1: Fix the bundled Compound Engineering dashboard plugin build so its CSS is included in `dist`.
- 978d07c: Fix opencode-go model sync: pass API key to CLI and strip provider prefix from model IDs

  Two bugs when using OpenCode Go as a provider:

  1. **Model discovery only returned free models** — the saved Go API key was never passed as `OPENCODE_API_KEY` to the spawned `opencode models opencode --refresh` process. The CLI's internal plugin checks this env var and, when absent, disables all paid models (those with `cost.input > 0`). Only 20 free models appeared instead of all 67.

  2. **API requests failed with 401** — `normalizeOpencodeGoModel` was registering models with prefixed IDs like `opencode-go/deepseek-v4-flash`. The Pi SDK sends `model.id` verbatim in API requests; the OpenCode API expects bare model names (e.g. `deepseek-v4-flash`). The prefix is now stripped during normalization.

  Also deduplicates models when the CLI emits both `opencode/foo` and `opencode-go/foo` for the same model, guards against empty model IDs, and refactors the duplicated `onApiKeySaved` handler into a shared `handleOpencodeGoApiKeySaved` helper.

  After this change, users must re-select their opencode-go model in Settings because model IDs have changed from prefixed to bare names.

- c2604d5: Fix missions stalling when a feature is marked `done` but stranded mid-loop.

  A mission feature could be left `status: "done"` while its `loopState` never advanced past `"implementing"` and it had no linked board task (so it was never validated). The slice-completion gate (`MissionStore.computeSliceStatus`) correctly refuses to count an assertion-linked `done` feature until its validator passes, but nothing re-drove a task-less feature, so the slice — and the whole mission — could never auto-progress.

  Active-mission recovery now detects these stranded `done` features and re-runs assertion validation directly (no board task), so the gate can resolve: on pass the feature becomes legitimately complete, on fail the normal fix-feature flow takes over. The feature-validation path was extracted into a shared `runFeatureValidation` helper used by both task-completion and recovery.

- a27921a: Fix project selector review regressions around optional selection handlers and bookmarked search matches, and tighten retry/backoff timeout and rate-limit handling.
- 77a1099: Fix a spurious Settings → Plugins error for the bundled Dependency Graph plugin where plugin startup could fail with `Invalid state transition from "started" to "started"`.

  Plugin state transitions now treat same-state updates as idempotent no-ops, while still allowing same-state calls with an explicit error payload to update the persisted error field without emitting a state-changed transition.

- 944c03d: Fixes the UsageIndicator popup hidden-window recovery flow by preventing hide/show controls from acting as implicit form-submit buttons.

  - Sets the per-window hide control and provider-level **Show hidden (N)** control to `type="button"` so they do not trigger parent form submits.
  - Adds a regression test that verifies clicking **Show hidden** reveals hidden windows, persists the unhidden state, and remains correct after rerender/state re-sync.

- feceedb: Repair dropped spaces after sentence-ending punctuation when streamed agent text is split across separate assistant messages by tool-call round-trips (chat and agent logs), by tracking a per-session running tail at the shared engine streaming-delta chokepoints. Completes FN-5789, which only covered within-message boundaries.
- 40b4919: `fn onboard` now allows each onboarding step to be skipped individually without aborting the overall wizard. Skipping steps still marks onboarding as completed, while interactive cancellation behavior remains unchanged.
- e1a35a3: Harden CLI onboarding auto-launch backward compatibility by adding an explicit skip when both the central DB and local project DB already exist. This preserves established agent/headless behavior by ensuring non-TTY, `serve`, and `daemon` invocations continue without onboarding prompts or blocking.
- 38e0422: Refine onboarding auto-launch bypass behavior by treating `--skip-onboarding` and `FUSION_SKIP_ONBOARDING` as first-class skip paths.

  - Parse `FUSION_SKIP_ONBOARDING` with strict truthiness (`1`, `true`, `yes`, `on` only).
  - Return distinct auto-launch skip reasons for flag (`skip-flag`) and env (`skip-env`).
  - Strip `--skip-onboarding` as a global CLI flag so it never leaks into downstream command parsers while still informing onboarding gate decisions.

- 245129e: Add orchestrator-level regression coverage and CLI docs that guarantee onboarding auto-launch never blocks existing projects, non-TTY/headless workflows, or agent-run `fn` commands.
- c676cbe: Update `fn onboard` CLI HELP text and CLI reference docs to match shipped onboarding behavior, including auto-launch conditions, skip paths, and onboarding escape hatches (`--skip-onboarding`, `FUSION_SKIP_ONBOARDING`).
- 1aef3c9: Fixes a mobile dashboard crash path where toggling the in-review auto-merge switch could blank the UI until refresh on some Android/legacy WebView environments.
- 327f0a9: Fix shared branch-group execution to always derive per-task working branches (`fusion/<task-id>`) for checkout/worktree operations while keeping the branch-group branch as the merge target.
- e16893a: Classify provider 400 errors for unsupported `messages.[n].role` values as operator-actionable agent errors, and annotate prompt-boundary failures with a clear model/provider compatibility hint. This stops invisible retry loops and makes misconfigured imported agent model/provider combinations fail fast with actionable diagnostics.
- b4230c0: Reuse imported GitHub source issues as task tracking links when GitHub tracking is enabled, instead of creating a duplicate issue. Tasks imported from GitHub now link their existing `sourceIssue` (when valid) as `githubTracking.issue` with no GitHub auth or issue creation call required.
- 8376781: Fix mobile Task Detail Logs scrolling for branch-group tasks by making the branch-group card collapsible and re-pinning the agent log viewer when its container height changes.
- e561290: Fix shared-branch-group member finalization so routed members land on the group's shared branch instead of being auto-finalized against the project default branch. Also harden already-landed commit attribution so the recovery detector never claims a commit that merely mentions a task ID in prose (2026-05-23 lost-work regression): the `git log --grep` ancestry fallback is now ownership-anchored on a Fusion trailer or a task-scoped conventional-commit subject.
- d4db0b0: CLI auto-launch now honors the persisted `cliOnboardingCompletedAt` marker so onboarding fires only once, even when the Central DB step was skipped during `fn onboard`.
- 7d1708f: Fix `fn_goal_list` and `fn_goal_show` so tool calls made from Fusion worktree directories resolve the canonical project database and return goals created through the dashboard UI.
- 684baa0: Stop queued chat messages from disappearing after back-navigation while the assistant is still responding (GitHub #1279).

  Re-entering a chat restored the queued follow-up and immediately flushed it based on the client's local `isGenerating` flag — which is stale mid-generation (it is a route-level enrichment the `chat:session:updated` SSE payload lacks). The premature send aborted the live generation server-side and could lose the queued message entirely, since its persisted copy was deleted before the send.

  The restore path in both Chat and Quick Chat now confirms with the server before flushing: if a generation is still in flight it re-attaches to the stream and lets completion deliver the queued message; the message is sent immediately only when the server reports no active generation. On a failed check the queued bubble is kept for a later flush trigger.

- e6ce500: Fix the dashboard skills interface so enabled and disabled skill toggles persist across refreshes for both top-level and package-scoped skills. The adapter now normalizes stored skill paths consistently when writing settings and when rediscovering installed skills.
- c60dae1: Fix the desktop quick chat panel so moving the FAB while the panel is closed no longer shrinks or overwrites the saved panel size before the next reopen.
- f3732af: Fix chat message sends with file attachments by parsing multipart form bodies on the chat messages SSE endpoint.

  Uploaded message attachments are now validated, persisted to the session attachment directory, converted into chat attachment metadata, and forwarded to the chat manager while JSON-only message sends continue to work unchanged.

- de23db3: Bump `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` from `^0.77.0` to `^0.78.0`. See the upstream pi coding agent changelog for [`0.78.0` (2026-05-29)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md#0780---2026-05-29).
- 7d20a99: Clear stale active-session registry entries when PR-mode merge cleanup removes a task worktree.
- 48e08c0: Recover mission interview drafts that were sent to the background from the final summary step. Plan-ready `complete` mission interview sessions now remain resumable across the dashboard, `fn mission list`, and `fn_mission_list` until they are approved into a mission or discarded.
- a66b128: Fix Planning Mode single-task session history so completed sessions remain restorable from the summary view after task creation.
- d9e1cdb: Fix agent-created ntfy task notifications so they include the task description when a title has not been assigned yet.
- dab1569: Fix Planning Mode session history so duplicate AI-session rows are collapsed by session id and deleting a history entry only succeeds when the server-side delete persists.
- ac92174: Fix a Planning Mode reliability bug where creating a single task could fail with a browser-level `Failed to fetch` error when post-create side effects threw or rejected before the dashboard finished responding.
- cf23c6f: Run the configured `worktreeInitCommand` on merge worktrees before AI merge verification across warm and cold integration modes, so merge verification uses the same project-specific bootstrap as executor worktrees.
- e33dadd: Fix fresh-install `pnpm install` bin-link warnings by pointing the published `fn`/`fusion` bins at a committed `bin.mjs` launcher that forwards to the built CLI output.
- 3d18872: Fix the dashboard OAuth login flow for ChatGPT Plus/Pro (Codex Subscription) so multi-option provider selection prompts no longer cancel the login before browser auth starts.
- a1b7556: persist the OAuth expiry alert/notification throttle so users are alerted at most once per provider every 12 hours, even across server restarts.
- 419f688: Fix the dashboard auto-merge toggle blanking on mobile by keeping board stabilization tied to viewport events instead of a one-shot resize listener.

  The in-review board now stays visible when auto-merge is toggled across Android mobile, iOS mobile, tablet, and desktop layouts, with regression coverage for populated and empty columns plus rollback and error-boundary paths.

- de3273e: Clear the in-review stall deadlock auto-pause on user-initiated retry so dashboard, CLI, and extension retries can actually resume merge/execution work without overriding manual pauses.
- 6a00dd2: Stop missions from silently looping or stalling when agents can't run their tasks (GitHub #1261).

  Importing a catalog ("company") agent assigns it the role `custom`, which the scheduler never auto-assigns mission/queue work to. Combined with a model/provider that rejects the `developer` system role, this surfaced to users as an invisible, repeating failure loop.

  - **Auto-recover from incompatible roles:** an "unsupported message role" provider rejection (e.g. a reasoning model sending the `developer` role to a provider that only accepts `system`/`user`/`assistant`/`tool`) is now treated as a model-selection error, so a configured fallback model is tried once before the task is marked failed. The single-swap guard keeps an incompatible fallback from looping.
  - **Stop the retry loop:** operator-actionable failures (unsupported role, auth, quota) now block the mission feature immediately with a clear event instead of burning the full retry budget re-running the same cryptic error.
  - **Preflight mission start:** when ephemeral agents are disabled and no eligible executor agent exists, starting a mission now fails fast with an actionable message instead of queueing tasks forever.
  - **Warn on import:** importing only `custom`-role agents now surfaces a warning that they won't be auto-assigned mission work unless one is given the `executor` role.

- 08d25f0: Streamline the Task Changes tab header controls on mobile so diff navigation and actions use a more compact layout.
- fa23782: Fix the dashboard mobile auto-merge toggle blank-screen regression by restoring shared mobile breakpoint coverage and strengthening the regression suite across mobile, tablet, desktop, rollback, and task-review detail surfaces.
- e84410e: Fix duplicate GitHub tracking issues and harden GitHub issue import deduping.
- 60eb2ec: Allow failed agents to be stopped and deleted consistently across the dashboard and CLI guidance.

  Agents in the error state can now transition to paused, the dashboard exposes delete actions for failed agents in list/detail views, and regression coverage protects the updated behavior.

- f77aa07: Fix auto-merge toggle not appearing on the built-in coding workflow's in-review column. The builtin:coding IR now carries the correct column traits (merge-blocker, human-review) so the dashboard resolves and passes the auto-merge toggle to the in-review column.
- 4ffd0a2: Restore terminal task notifications for workflow/PR-backed completions that move tasks to done before emitting the canonical merged lifecycle event.
- 8bc3d7b: Harden dependency security floors by forcing protobufjs resolutions to patched versions and upgrading Vitest tooling to the patched 4.1 line.
- a2f4bb1: Removed the `collapsible`, `collapseStorageKey`, and `collapsedLabel` props from `WorkflowSelector`. Callers should stop passing these props; workflow selectors now always render expanded.
- fc33a42: Open the workflow editor on the selected board workflow when using the workflow-mode edit action.
- be7645f: Right-align the task-card promote action at the end of the card action row.
- 07a5365: Fix workflow/AI merge ntfy notification delivery by preserving merge-backed task metadata, treating an empty ntfy event allowlist as the documented default events, and allowing failed/no-provider notification attempts to retry after settings refresh.
- 6ec0e2b: Fix task changed-file counts for stacked or cherry-equivalent task branches by filtering active review diffs to commits attributed to the current task.
- 7c4e44d: Prevent QuickEntry quick-action buttons from stealing or restoring textarea focus on mouse down, preserving existing click behavior while avoiding unwanted mobile keyboard refocus.
- 576ff77: Stop failing task worktree acquisition and branch authority checks when a task branch contains foreign task-attributed commits.
- b7a56cc: Stop classifying benign workflow-graph exits after a task already advanced or paused as failures. These exits now use info-level benign wording while genuine in-progress graph failures keep the existing failure handling.
- 99661c1: Add an expand/collapse control for the workflow prompt editor so long prompts can be edited in a fullscreen overlay.
- 477c8f1: Tokenize bare hex colors in ScriptsModal and SettingsSyncLog CSS to use semantic custom properties.
- 4435ca2: Detect Codex model-auth-tier incompatibility as a model-selection error, trigger configured fallback models, and surface an actionable diagnostic when no fallback is available.
- d7e1454: Make the Nodes screen open as a full-screen mobile overlay so it covers the header while staying above the mobile nav.
- 1c69ea7: Fix CLI task retry behavior and plugin SDK runtime shims, and harden CLI tests against stale constructor mocks.
- de7b110: Fix the Nodes view tablet overlay so node cards and topology content no longer bleed through node detail modals.
- bbf3de9: Fix merger AI commit finalization so deleted tasks no longer crash settings resolution while the merge is completing.
- d9d67fb: Hide the compound engineering built-in workflow unless the `fusion-plugin-compound-engineering` plugin is installed.
- c9d48fb: Revalidate dashboard service-worker assets before falling back to cache so rebuilt tabs cannot stay on stale bundles and render a blank page.
- fa68edf: Fix the integrated dashboard terminal so Ctrl/Cmd+C copies selected terminal text without swallowing plain SIGINT behavior, and Ctrl/Cmd+V pastes clipboard text into the active session.
- e883a8d: Fix retry handling for stranded in-review tasks whose status is unset by allowing retry when execution is incomplete or a merge retry has already been attempted.
- 7a9d2b0: Suppress in-review stall and merge-stalled signals for tasks already owned by the merge queue.
- 0b0186a: Suppress legacy stalled-review badges and re-enqueue churn for tasks already owned by the merge queue.
- 5f5852d: Fix coding-agent startup and tool boundary checks from AI merge temp worktrees on macOS by comparing Git worktree paths with filesystem-canonical paths.
- 85c3420: Fix Fusion task tools from AI merge temp worktrees so merger agents can fetch task details without trying to bootstrap a nested project.
- 6f37806: Fix missing model rows in the Minimax provider usage panel. The primary `general` model meters quota purely via `current_interval_remaining_percent` (its count fields are `0`), so the previous count-based visibility filter dropped it entirely.

  Minimax usage now prefers the authoritative `*_remaining_percent` field (with a count-based fallback) and renders a window only when a model exposes any quota signal. Each model's separate weekly quota window (`current_weekly_remaining_percent`, `weekly_*` timing) is now surfaced as its own indicator alongside the interval window.

- ad46881: Respect per-task auto-merge overrides when the global auto-merge setting is off. Tasks with auto-merge explicitly enabled now get enqueued for merge and covered by the in-review self-healing sweeps (stall surfacing, merged-task finalization, retry recovery) even when the project-level setting is disabled; tasks without an explicit override keep the PR-based/manual review flow untouched.
- 1c49ae6: Fix mobile quick-entry action buttons so nested icons and labels do not trigger browser touch gestures instead of toggling their controls.
- be0140c: Fix the bundled dependency graph plugin so the graph view fills the available dashboard width.
- aa8bd3d: Fix stuck task recovery by preserving retryable requeues, supervising verification subprocesses, and narrowing executor verification guidance to impacted work.
- b6243d6: Suppress transient dashboard fetch errors after tab resume so cached data remains visible and executor status shows a reconnecting state instead of raw network errors.
- c27c321: Fix mobile Quick Entry action buttons so taps rely on native browser click synthesis instead of a manual touchend click.
- 614bec2: Fix the vitest memory-pressure auto-kill firing on a garbage metric and killing innocent processes. The guard probed `os.availableMemory` (which does not exist) and silently fell back to `os.freemem()`, which on macOS reads ~99% used on an idle machine — so with the toggle on, every vitest process was SIGKILLed every 30 seconds regardless of real memory pressure. It now reads `process.availableMemory()` (Node 22+) and refuses to auto-kill when only the unreliable freemem fallback is available. Kill targeting is also fixed: `pgrep -f vitest` matches full command lines (wrapper shells, monitors, editors that merely mention vitest); the TUI auto-kill/manual kill and the dashboard `POST /api/kill-vitest` + system-stats count now filter matches to actual node processes via a shared `findVitestProcessIds` helper.
- e138971: Fix workflow board/list workflow selection, custom workflow task creation controls, workflow editor defaults, built-in workflow node prompt display, and executor handling for built-in workflow runs.
- 4b4c32d: Fix workflow scheduling so in-progress column limits are enforced from fresh task state after hold-advancing sweep dispatches.
- ff0750c: Fix the workflow graph editor opening invisibly and bundle the Compound Engineering and Roadmaps plugins.

  - The "Graph editor" button now actually shows the editor: its overlay was rendered without the `open` class, leaving it `display: none`, so opening it looked like the workflow steps view was just dismissed.
  - `fusion-plugin-compound-engineering` and `fusion-plugin-roadmap` are now listed in the dashboard's built-in plugins, so they appear under Settings → Built-in Plugins (they were implemented and registered but missing from the list).
  - Installing Compound Engineering (and CLI Printing Press) from Settings → Built-in Plugins no longer fails with "Plugin manifest not found": both ids are now in the dashboard's bundled-plugin fallback set, and the Compound Engineering plugin is staged into `dist/plugins/` so packaged installs can resolve it.
  - Plugins installed from Settings now load instead of erroring with "Plugin entry must be a file, got directory": the dashboard install routes register the plugin's loadable entry file (`bundled.js`/`dist/index.js`/`src/index.ts`) rather than the package directory, and enabling a plugin heals legacy directory-path registrations in place.

- 8f42098: Route task execution through workflow-native runtime primitives and make the built-in coding workflow explicitly own planning before execute/review/merge.
- a533307: Restore file-overlap blocking for workflow-column task releases so cards stay queued with overlap badges until active file-scope leases clear.
- 83565a5: Fix workflow-native dispatch capacity accounting and publish workflow node task metadata to the existing task fields used by scheduler and dashboard surfaces.
- cd8126d: Honor the worktree execution limit when workflow-column hold releases dispatch tasks.

### runfusion.ai

#### Patch Changes

- Updated dependencies [61d6874]
- Updated dependencies [f76716e]
- Updated dependencies [93e8bd9]
- Updated dependencies [26bc80a]
- Updated dependencies [fab8a62]
- Updated dependencies [2d81a95]
- Updated dependencies [40c0048]
- Updated dependencies [9c84ba2]
- Updated dependencies [489a287]
- Updated dependencies [934071c]
- Updated dependencies [d75f861]
- Updated dependencies [db971a9]
- Updated dependencies [30ba1f0]
- Updated dependencies [07dcb16]
- Updated dependencies [c1c99a9]
- Updated dependencies [f3b700a]
- Updated dependencies [d8248b4]
- Updated dependencies [ace7106]
- Updated dependencies [7a80d29]
- Updated dependencies [8bac390]
- Updated dependencies [10acf17]
- Updated dependencies [b9afce3]
- Updated dependencies [5872331]
- Updated dependencies [17c9303]
- Updated dependencies [243113a]
- Updated dependencies [e10db81]
- Updated dependencies [57631c7]
- Updated dependencies [3cf13dd]
- Updated dependencies [ee5f5e8]
- Updated dependencies [38b84a3]
- Updated dependencies [68e52e3]
- Updated dependencies [314411c]
- Updated dependencies [7d417a1]
- Updated dependencies [978d07c]
- Updated dependencies [c2604d5]
- Updated dependencies [a27921a]
- Updated dependencies [77a1099]
- Updated dependencies [944c03d]
- Updated dependencies [feceedb]
- Updated dependencies [e854d33]
- Updated dependencies [40b4919]
- Updated dependencies [641b932]
- Updated dependencies [e1a35a3]
- Updated dependencies [38e0422]
- Updated dependencies [245129e]
- Updated dependencies [c676cbe]
- Updated dependencies [2053f3f]
- Updated dependencies [1aef3c9]
- Updated dependencies [327f0a9]
- Updated dependencies [e9de195]
- Updated dependencies [eb425d1]
- Updated dependencies [9c29e2e]
- Updated dependencies [3373c0b]
- Updated dependencies [e16893a]
- Updated dependencies [130f6f1]
- Updated dependencies [b4230c0]
- Updated dependencies [0a418e6]
- Updated dependencies [8376781]
- Updated dependencies [e561290]
- Updated dependencies [d4db0b0]
- Updated dependencies [7d1708f]
- Updated dependencies [684baa0]
- Updated dependencies [e6ce500]
- Updated dependencies [c60dae1]
- Updated dependencies [f3732af]
- Updated dependencies [de23db3]
- Updated dependencies [7d20a99]
- Updated dependencies [48e08c0]
- Updated dependencies [a66b128]
- Updated dependencies [d9e1cdb]
- Updated dependencies [dab1569]
- Updated dependencies [30a09e3]
- Updated dependencies [abbeaec]
- Updated dependencies [577ce12]
- Updated dependencies [3b9ff42]
- Updated dependencies [cc18206]
- Updated dependencies [ac92174]
- Updated dependencies [cf23c6f]
- Updated dependencies [d72cb2a]
- Updated dependencies [e33dadd]
- Updated dependencies [3d18872]
- Updated dependencies [a1b7556]
- Updated dependencies [419f688]
- Updated dependencies [de3273e]
- Updated dependencies [6a00dd2]
- Updated dependencies [8aed4da]
- Updated dependencies [8891d4b]
- Updated dependencies [08d25f0]
- Updated dependencies [fa23782]
- Updated dependencies [e84410e]
- Updated dependencies [60eb2ec]
- Updated dependencies [f77aa07]
- Updated dependencies [4ffd0a2]
- Updated dependencies [13c6d96]
- Updated dependencies [8bc3d7b]
- Updated dependencies [a2f4bb1]
- Updated dependencies [fc33a42]
- Updated dependencies [6271778]
- Updated dependencies [be7645f]
- Updated dependencies [07a5365]
- Updated dependencies [6ec0e2b]
- Updated dependencies [7c4e44d]
- Updated dependencies [0b7549a]
- Updated dependencies [576ff77]
- Updated dependencies [b7a56cc]
- Updated dependencies [99661c1]
- Updated dependencies [477c8f1]
- Updated dependencies [4435ca2]
- Updated dependencies [1b7e52e]
- Updated dependencies [d7e1454]
- Updated dependencies [1c69ea7]
- Updated dependencies [de7b110]
- Updated dependencies [bbf3de9]
- Updated dependencies [d9d67fb]
- Updated dependencies [c9d48fb]
- Updated dependencies [b1454c1]
- Updated dependencies [f9e5513]
- Updated dependencies [34c8ac9]
- Updated dependencies [5c4c765]
- Updated dependencies [fa68edf]
- Updated dependencies [e883a8d]
- Updated dependencies [d071aec]
- Updated dependencies [9072d71]
- Updated dependencies [7a9d2b0]
- Updated dependencies [0b0186a]
- Updated dependencies [5f5852d]
- Updated dependencies [85c3420]
- Updated dependencies [6f37806]
- Updated dependencies [c1a7231]
- Updated dependencies [ad46881]
- Updated dependencies [fbc2c37]
- Updated dependencies [1c49ae6]
- Updated dependencies [bd5315f]
- Updated dependencies [d8a015e]
- Updated dependencies [be0140c]
- Updated dependencies [7076dd4]
- Updated dependencies [aa8bd3d]
- Updated dependencies [b6243d6]
- Updated dependencies [c27c321]
- Updated dependencies [614bec2]
- Updated dependencies [e138971]
- Updated dependencies [4b4c32d]
- Updated dependencies [4fa5407]
- Updated dependencies [60605fa]
- Updated dependencies [71822f2]
- Updated dependencies [ff0750c]
- Updated dependencies [a504238]
- Updated dependencies [61ae1bf]
- Updated dependencies [8f42098]
- Updated dependencies [a533307]
- Updated dependencies [83565a5]
- Updated dependencies [e2707af]
- Updated dependencies [cd8126d]
  - @runfusion/fusion@0.40.0

## 0.39.0

### @fusion/dashboard

#### Patch Changes

- @fusion-plugin-examples/cli-printing-press@0.1.17
- @fusion-plugin-examples/cursor-runtime@0.1.19
- @fusion-plugin-examples/dependency-graph@0.1.31
- @fusion-plugin-examples/droid-runtime@0.1.26
- @fusion-plugin-examples/hermes-runtime@0.2.50
- @fusion-plugin-examples/openclaw-runtime@0.2.50
- @fusion-plugin-examples/paperclip-runtime@0.2.50
- @fusion-plugin-examples/roadmap@0.1.19
- @fusion/core@0.39.0
- @fusion/engine@0.39.0

### @fusion/desktop

#### Patch Changes

- @fusion/dashboard@0.39.0
- @fusion/core@0.39.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.39.0
- @fusion/pi-claude-cli@0.39.0

### @fusion/plugin-sdk

#### Patch Changes

- 3d22a98: Fix Windows binary-release build failure: add the DOM lib to `@fusion/plugin-sdk`'s tsconfig. Because `@fusion/core` exports its types as raw `src/*.ts`, plugin-sdk recompiles core's source under its own compiler options; without the DOM lib the global fetch `Response` type (`.ok`/`.status`/`.json`) resolved inconsistently across platforms and broke the Windows CLI and desktop release jobs (TS2339).
  - @fusion/core@0.39.0

### @runfusion/fusion

#### Minor Changes

- 3b59487: Add a new `fn_mission_update` extension tool to patch mission `title`/`description` without recreating missions, and classify it as a mission mutation tool in readonly/permanent gating policy.
- 194dfa9: Add a run-audit cited-goal trail for goal anchoring flows.

  - Enrich `goal:injection-applied`, `goal:injection-skipped`, and `goal:retrieval-invoked` events with `metadata.goalIds` (IDs/counts only).
  - Add core aggregation helper `collectCitedGoalIdsFromAudit(...)` to derive injected/retrieved/combined cited goal IDs from run-audit events.
  - Add dashboard API endpoint `GET /api/agents/:id/runs/:runId/cited-goals` to query cited goal IDs for a run.

- 3d22a98: Add the Workflow IR v1 contract surface via `@fusion/core`, including versioned graph types (`WorkflowIr`), runtime parsing/validation (`parseWorkflowIr`), serialization (`serializeWorkflowIr`), and a canonical built-in fixture (`BUILTIN_WORKFLOW_IR_FIXTURE`) for interpreter parity testing.
- 0ffe7f0: Add mission delete tooling for agents: `fn_feature_delete`, `fn_slice_delete`, and `fn_milestone_delete`.

  Mission feature/slice/milestone deletes now enforce a linked live-task guard by default and return clear conflict errors. Callers can pass `force: true` to clear mission linkage and proceed with hard deletion.

- acad46c: Expose mission assertion backfill through operator-facing surfaces.

  - Added dashboard API route `POST /api/missions/:missionId/backfill-assertions` with dry-run default and `MissionAssertionBackfillReport` response.
  - Added agent/CLI tool `fn_mission_backfill_assertions` for dry-run/apply remediation of FN-5696 legacy zero-assertion features.
  - Updated mission operator docs and synced fusion skill/tool reference docs.

- 1edbb54: Add a flagged-off Workflow Graph Executor scaffold and built-in coding lifecycle Workflow IR exports.

  - Adds `BUILTIN_CODING_WORKFLOW_IR` and `buildBuiltinCodingWorkflowIr` to `@fusion/core`.
  - Adds `WorkflowGraphExecutor` and `WORKFLOW_GRAPH_EXECUTOR_FLAG` to `@fusion/engine`.
  - Adds parity-harness skeleton tests and IR documentation updates.

  The new executor path is gated by `experimentalFeatures.workflowGraphExecutor` and remains strict no-op while disabled (default).

- ba81d1f: Add workflow graph interpreter node handlers and traversal semantics behind the default-off `workflowGraphExecutor` experimental flag. The interpreter now supports prompt/script/gate dispatch through legacy seam DI, edge-condition routing (`success`/`failure`/`outcome:<value>`), bounded retries, and parity-oriented tests for no-op flag behavior and lifecycle routing.
- 5b4eecb: Add workflow interpreter dual-observe parity instrumentation surfaces for phased rollout.

  - Export pure workflow parity comparison helpers from `@fusion/core` (`compareWorkflowRunObservations`, `compareWorkflowRunAudits`) with structured drift reports.
  - Add `observeWorkflowParity` in the engine as a default-OFF, fail-soft observer gated by `experimentalFeatures.workflowInterpreterDualObserve`.
  - Emit run-audit parity events (`workflow:parity-observed`, `workflow:parity-drift`) for shadow agreement/drift visibility without changing authoritative legacy execution.

- 0c42578: Wire branch-group-aware merge routing into the merge path. Tasks marked with `branchContext.assignmentMode = "shared"` now merge onto their group's integration branch (`branch_groups.branchName`) in both direct merge and PR-mode base-branch resolution, while ungrouped and `per-task-derived` tasks keep existing default-branch behavior.

  This release also adds reliability backstop coverage for grouped vs ungrouped routing and branch-group merge audit telemetry (`merge:branch-group-routed`).

- 06d8490: feat(FN-5783): enforce branch-group autoMerge precedence for grouped promotion gating and audit visibility
- e2101ea: Add single group-level pull request behavior for shared `branch_groups` in PR merge mode.

  When tasks share a `branchContext.groupId`, Fusion now opens and tracks one PR for the group's integration branch instead of creating one PR per task. The group PR metadata is written back to `branch_groups` and refreshed from merge-status polling.

- 7b70e7f: Add a branch-group promotion eligibility hook to the engine merge lifecycle via `evaluateBranchGroupPromotion`, and emit `merge:branch-group-promotion-gated` audit telemetry whenever shared-group member landings are evaluated for downstream group→default promotion readiness.
- 5930c18: Add a new opt-in `task-created` notification event for ntfy/webhook providers.

  - `task-created` fires when a task is created by an agent (`sourceAgentId` present), including agent-issued `fn_task_create` calls.
  - Event is off by default and must be explicitly enabled in Settings → Notifications (`ntfyEvents` / provider `events`).
  - ntfy formatting includes agent attribution and task deep-linking to the created task.

- b1c1a33: Add safe `fn task deps` commands for audited task dependency mutations.

#### Patch Changes

- 62bc1e4: Removed the `showGitHubStarButton` setting and its Project General toggle from Settings.

  The Settings header "Star on GitHub" button remains available (always shown) while the dedicated visibility setting is no longer configurable.

- a7347ad: Skip self-owned branch reclaim for dependency-blocked todo tasks so repaired queued work is not repeatedly resumed before its blocker clears.
- 6ba3cbf: Respect dashboard task-list column filters so API callers receive only tasks in the requested persisted column.
- 3dee395: Block AI merge finalization when the checked-out integration worktree is dirty instead of stashing local changes into the merge landing path by default, with an explicit Merge settings UI escape hatch for the legacy dirty-checkout sync behavior.
- 716f396: Fix room chat send reliability by preventing concurrent in-flight room dispatches, classifying ambiguous delivered sends as delivered (so composer text is not restored), and hardening optimistic/SSE reconciliation to avoid duplicate user message rendering.
- 4148f43: Fix the Binary Release workflow so platform binaries publish to GitHub Releases again:

  - The release job now tolerates a single failing build leg instead of being skipped, which previously suppressed all assets.
  - The node_modules cache key includes CPU arch (so arm64 runners no longer restore x64 native deps, fixing the `@rollup/rollup-linux-arm64-gnu` build crash) and the job id (so same-OS/arch jobs don't race on one key and fail the post-job cache save).
  - The macOS and Windows CLI signing steps are skipped gracefully when their certificate secrets are absent, so unsigned binaries still publish.
  - Desktop packaging now invokes `electron-builder` directly via `pnpm exec` instead of the `dist:*` scripts: pnpm leaked the `--` separator into script args, which made electron-builder ignore `--publish never` (auto-publishing to the wrong repo and 404ing) and drop the Linux `--x64 --arm64` flags.
  - The desktop build spawns workspace `.cmd` bins with a shell on Windows, fixing the `spawn EINVAL` failure.
  - The desktop package declares an `author` with email so the Linux `.deb` target (fpm) can build.
  - The Linux AppImage verify step matches electron-builder's actual x64 output name (`-linux-x86_64.AppImage`).
  - `@types/node` is pinned workspace-wide via a pnpm override so the desktop/plugin-sdk build is deterministic (a stale transitive `@types/node` lacking global `fetch`/`Response` types intermittently broke the Windows desktop build).
  - The `build-exe-cross` tests that cross-compile platform binaries are now opt-in (`FUSION_TEST_BUILD_EXE=1`) instead of auto-running on every CI run; native per-platform binary builds remain covered by `test-release.yml`.
  - A workflow_dispatch run now builds and uploads binaries as artifacts for validation without creating a release (release creation is gated to tag pushes).
  - The dependency-graph plugin build uses a cross-platform copy step that no longer breaks the Windows desktop build.
  - The macOS Intel (`bun-darwin-x64`) CLI binary is no longer built/shipped — `macos-13` runners are too scarce to build reliably and were blocking releases. The macOS CLI is now Apple-Silicon-only; the desktop macOS DMG/ZIP remains universal.

- f8bda56: Fix scheduler overlap starvation for coordination-only tasks by allowing no-commit/coordination scopes to bypass active file-scope leases when overlaps are limited to safe read-only paths. Implementation tasks with real write-scope overlaps remain serialized behind active leases.
- 033f74c: Improve `fn_feature_link_task` error handling when linking to tasks that are not on the active board. Instead of surfacing a raw SQLite foreign key failure, the tool now returns a clear validation error explaining that only active (non-archived, non-deleted) tasks can be linked to mission features.
- 3255965: Fix mission assertion-validation trigger gaps so mission-linked tasks reaching done no longer bypass validator execution.

  Assertion-linked features now stay completion-gated until validator pass, and startup recovery replays implementing features whose linked tasks are already done/archived but still lack a passing validator status.

- 1594470: Fix mission loop no-assertions auto-pass handling so completion deterministically advances feature `loopState` to `passed`, sets `lastValidatorStatus` to `passed`, and emits the structured `validation_auto_passed_no_assertions` audit event exactly once.
- 9c4e8ed: Realize the mission completion-gate contract for live Goals mission workflows.

  - Fix mission execution auto-pass behavior so zero-assertion features move to `loopState: "passed"` (not stuck in `implementing`) and emit `feature_auto_passed_no_assertions` telemetry while preserving `validation:passed` emission.
  - Add milestone guard signaling for prose acceptance criteria with zero structured assertions via `hasProseButNoAssertions` rollup and warning event `milestone_missing_structured_assertions`.
  - Add an idempotent `seedContractAssertionsForFeatures(...)` helper for operator-run assertion persistence and coverage tests.
  - Reconcile MissionManager labels/copy to clearly separate enforced contract assertions from informational feature acceptance criteria, including warning badge and indicators.

- 20c1c32: Persist merge-request handoff shadow contract and accepted marker for Phase 1 reliability scaffolding.
- bb0f693: Fixes a dashboard regression where toggling the in-review Auto-merge switch could leave the UI in a broken/blank state until refresh. Auto-merge toggle state updates now remain consistent during rapid toggles, and regression coverage was added for the settings hook path.
- 292bf07: Fix merger agent-log visibility by flushing buffered `AgentLogger` output before disposing AI sessions used for autostash conflict resolution, autostash hard-fail recovery, and rebase conflict resolution. This ensures trailing text/thinking deltas are persisted so merger activity reliably appears in the task agent log panel.
- 5396730: Harden mission validation end-to-end by locking the canonical zero-assertion auto-pass path, strengthening assertion pass/fail regression coverage, and wiring bounded periodic mission recovery into existing self-healing maintenance so stranded implementing features recover without engine restart.
- b154844: Fixes an executor worktree self-heal gap where `task.worktree` could be recorded as a nested subdirectory of a valid git worktree root.

  When a nested path is detected under a registered worktree inside the configured worktrees directory, Fusion now re-anchors `task.worktree` to the actual git top-level and continues execution. Genuine mismatches (repo root, outside configured worktrees dir, or unregistered top-level) still fail with existing `wrong_toplevel` and liveness guard behavior.

- 93e8a5f: Persist AI merge agent text, thinking, and tool output to task agent logs in AI merger mode.
- 9f29935: Throttle `oauth-token-expired` notifications to at most once per provider every 12 hours, even when the credential `expires` timestamp changes across refreshes/replacements.
- 793da2c: Refinement tasks now inherit the source task’s GitHub tracking state, preventing auto-created tracking issues when the source task was not GitHub-linked.
- 2140ab2: Repair dropped spaces after sentence-ending punctuation in streamed agent responses (chat and agent logs) across all providers by applying the streaming-delta sentence-boundary fix at the shared engine delta chokepoints, not just the per-provider CLI bridges.
- ffadb0c: Fix GitHub tracking reconciliation for soft-deleted and archived tasks by adding a periodic 15-minute sweep, paginating archive/deleted candidate scans, and correcting done-task filtering to use the task column.
- fa428a4: Run the configured `worktreeInitCommand` when the merger has to create a fresh merge worktree during reuse-worktree reacquisition. This bootstraps newly created merge workspaces before merge verification/workflow steps run, while leaving pooled/reused existing worktrees unchanged.
- ab38ee0: Requeue incomplete stuck-loop exhausted tasks in todo with progress preserved instead of routing them through review/merge or requiring manual unpause.
- c6b3b77: Treat foreign-attributed commits reachable from origin/main as already integrated during branch contamination checks to avoid false-positive recovery loops when local main is stale.

### runfusion.ai

#### Patch Changes

- Updated dependencies [62bc1e4]
- Updated dependencies [a7347ad]
- Updated dependencies [6ba3cbf]
- Updated dependencies [3dee395]
- Updated dependencies [716f396]
- Updated dependencies [4148f43]
- Updated dependencies [f8bda56]
- Updated dependencies [3b59487]
- Updated dependencies [033f74c]
- Updated dependencies [3255965]
- Updated dependencies [1594470]
- Updated dependencies [9c4e8ed]
- Updated dependencies [20c1c32]
- Updated dependencies [bb0f693]
- Updated dependencies [292bf07]
- Updated dependencies [5396730]
- Updated dependencies [194dfa9]
- Updated dependencies [3d22a98]
- Updated dependencies [0ffe7f0]
- Updated dependencies [acad46c]
- Updated dependencies [1edbb54]
- Updated dependencies [ba81d1f]
- Updated dependencies [5b4eecb]
- Updated dependencies [b154844]
- Updated dependencies [93e8a5f]
- Updated dependencies [9f29935]
- Updated dependencies [793da2c]
- Updated dependencies [0c42578]
- Updated dependencies [06d8490]
- Updated dependencies [e2101ea]
- Updated dependencies [7b70e7f]
- Updated dependencies [2140ab2]
- Updated dependencies [ffadb0c]
- Updated dependencies [fa428a4]
- Updated dependencies [5930c18]
- Updated dependencies [ab38ee0]
- Updated dependencies [c6b3b77]
- Updated dependencies [b1c1a33]
  - @runfusion/fusion@0.39.0

## 0.38.1

### @fusion/dashboard

#### Patch Changes

- bad8f52: Improve the mission manager mobile stacked layout so mission rows reflow cleanly: stacked mission list items switch to a column layout with stretched content, item actions become full-width and wrap instead of cramped inline controls, and run controls span the full width.
  - @fusion-plugin-examples/cli-printing-press@0.1.16
  - @fusion-plugin-examples/dependency-graph@0.1.30
  - @fusion-plugin-examples/roadmap@0.1.18
  - @fusion/core@0.38.1
  - @fusion/engine@0.38.1
  - @fusion-plugin-examples/cursor-runtime@0.1.18
  - @fusion-plugin-examples/droid-runtime@0.1.25
  - @fusion-plugin-examples/hermes-runtime@0.2.49
  - @fusion-plugin-examples/openclaw-runtime@0.2.49
  - @fusion-plugin-examples/paperclip-runtime@0.2.49

### @fusion/desktop

#### Patch Changes

- Updated dependencies [bad8f52]
  - @fusion/dashboard@0.38.1
  - @fusion/core@0.38.1

### @fusion/engine

#### Patch Changes

- @fusion/core@0.38.1
- @fusion/pi-claude-cli@0.38.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.38.1

### @runfusion/fusion

#### Patch Changes

- bad8f52: Fix the Binary Release workflow so platform binaries publish to GitHub Releases again. The release job now tolerates a single failing build leg instead of being skipped (which previously suppressed all assets), the node_modules cache key includes CPU arch to stop arm64 runners restoring x64 native deps, the macOS CLI signing step is skipped gracefully when Apple certs are absent, and the dependency-graph plugin build uses a cross-platform copy step that no longer breaks the Windows desktop build.

### runfusion.ai

#### Patch Changes

- Updated dependencies [bad8f52]
  - @runfusion/fusion@0.38.1

## 0.38.0

### @fusion/dashboard

#### Patch Changes

- Updated dependencies [9112b7d]
  - @fusion/engine@0.38.0
  - @fusion-plugin-examples/cli-printing-press@0.1.15
  - @fusion-plugin-examples/dependency-graph@0.1.29
  - @fusion-plugin-examples/roadmap@0.1.17
  - @fusion/core@0.38.0
  - @fusion-plugin-examples/cursor-runtime@0.1.17
  - @fusion-plugin-examples/droid-runtime@0.1.24
  - @fusion-plugin-examples/hermes-runtime@0.2.48
  - @fusion-plugin-examples/openclaw-runtime@0.2.48
  - @fusion-plugin-examples/paperclip-runtime@0.2.48

### @fusion/desktop

#### Patch Changes

- @fusion/dashboard@0.38.0
- @fusion/core@0.38.0

### @fusion/engine

#### Patch Changes

- 9112b7d: Fix scheduler overlap deferral starvation by considering only runnable queued todo tasks as higher-priority overlap competitors. Dependency-blocked queued tasks now keep their unmet-dependency queue state without reserving overlapping files from ready work, while active in-progress and eligible in-review tasks continue to hold explicit file-scope leases. Dispatch logs now distinguish unmet dependencies, active file-scope lease blocking, and higher-priority runnable queued-task deferral.
  - @fusion/core@0.38.0
  - @fusion/pi-claude-cli@0.38.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.38.0

### @runfusion/fusion

#### Minor Changes

- afc3b47: Adds goal-anchoring run-audit observability for Slice 2 hybrid anchoring with three `database` mutation types: `goal:injection-applied`, `goal:injection-skipped`, and `goal:retrieval-invoked`.

  Events carry count-only metadata contracts (`count`, plus `lane` for injection and `toolName` for retrieval, with optional `truncated`/`reason`/`notFound`) and avoid prompt bodies or goal title/description payloads. These events are available through the existing `GET /api/agents/:id/runs/:runId/audit` timeline route with standard date-range filtering via `startTime`/`endTime`.

- 71e2aec: Add a goal-citation audit trail to support Slice 2 anchoring success-signal measurement.

  - Introduce a persisted `goal_citations` table (schema v93) with deduplication on `(goalId, surface, sourceRef)`.
  - Record citations from `agent_log` and `task_document` write seams.
  - Extract goal IDs using `GOAL_ID_PATTERN` (`/\bG-[0-9A-Z]+(?:-[0-9A-Z]+)*\b/g`) and store bounded snippets (max 200 chars).
  - Add `fn goals citations` with filters: `--goal`, `--agent`, `--surface`, `--since`, `--until`, `--limit`, and `--json`.

- 4fee2c1: Add a branch-strategy dropdown to the New Task dialog with project-default, auto-new, existing, and custom-new modes.

  New tasks now submit `branchSelection`, and `auto-new` derives a persisted branch name using `fusion/{task-id}-{short-name}`.

- 0605d13: Add mission-level branch strategy defaults so missions can persist whether triaged tasks should use project default branching, a shared existing/custom branch, or per-task derived branches.

  Mission create/edit flows now save both `baseBranch` and `branchStrategy`, and mission triage handlers apply that stored strategy by default (including autopilot triage when no explicit branch options are supplied).

  Also fix planning breakdown task creation to forward the selected branch options so multi-task planning respects the same branch selection used by single-task planning.

- 7221413: Add per-mission/planning branch-group data-model foundations in `@fusion/core`.

  - Introduce durable `branch_groups` storage with source linkage (`mission`/`planning`), branch metadata, PR state, status, and auto-merge override.
  - Add `TaskStore` branch-group APIs: create/get/getBySource/list/update/setTaskBranchGroup.
  - Persist `Task.autoMerge` and `Mission.autoMerge` as optional overrides.
  - Reuse `Task.branchContext.groupId` for task↔group linkage (no separate `branchGroupId` column).
  - Bump project schema version to `94` with migration coverage and schema assertions.

#### Patch Changes

- 53d97e2: Clarify no-task heartbeat prompts when eligible Todo tasks exist but role policy filters them out of auto-claim candidates.
- dbb0804: Fix per-task diff view incorrectly including a task's base commit when a done task lands as a no-op or its resolved merge SHA equals `baseCommitSha`.
- 668e3a5: Mission creation now always returns a stopped mission. `POST /api/missions` and the mission store ignore create-time `autopilotEnabled` input, forcing new missions to `status: "planning"` with autopilot disabled and inactive.

  Autopilot remains a post-creation action via explicit mission start/update flows.

- a014c6d: Auto-merge now treats transient provider/network failures during merge (for example "This operation was aborted", "socket hang up", and provider `server_error` payloads) as bounded retryable errors instead of immediate terminal failures. The engine re-enqueues affected in-review merges with exponential backoff for both direct and pull-request merge strategies, then parks the task as failed with explicit transient-retry exhaustion logs once the retry cap is reached.
- d5b3336: Dashboard: OAuth re-login banner now clears a provider immediately after successful OAuth re-authentication, instead of waiting for the next auth-status polling interval.
- 0044c23: Fix dashboard OAuth login for `github-copilot` when upstream auth storage invokes device-code callbacks. The `/api/auth/login` route now provides the expected callback wiring and preserves `deviceCode: { userCode, verificationUri }` in responses so Copilot login no longer crashes with `options.onDeviceCode is not a function`.
- 4a60c2a: Backfill done-task "N files changed" chips when mergeDetails enrichment arrives after the initial done websocket snapshot. Task cards now pass a done-mode merge enrichment signature into diff-stats invalidation so `/api/tasks/:id/diff` is re-fetched and authoritative lineage stats render without requiring a manual refresh.

### runfusion.ai

#### Patch Changes

- Updated dependencies [53d97e2]
- Updated dependencies [afc3b47]
- Updated dependencies [71e2aec]
- Updated dependencies [dbb0804]
- Updated dependencies [4fee2c1]
- Updated dependencies [0605d13]
- Updated dependencies [668e3a5]
- Updated dependencies [a014c6d]
- Updated dependencies [d5b3336]
- Updated dependencies [0044c23]
- Updated dependencies [4a60c2a]
- Updated dependencies [7221413]
  - @runfusion/fusion@0.38.0

## 0.37.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.37.0
- @fusion/engine@0.37.0
- @fusion-plugin-examples/cli-printing-press@0.1.14
- @fusion-plugin-examples/dependency-graph@0.1.28
- @fusion-plugin-examples/roadmap@0.1.16
- @fusion-plugin-examples/cursor-runtime@0.1.16
- @fusion-plugin-examples/droid-runtime@0.1.23
- @fusion-plugin-examples/hermes-runtime@0.2.47
- @fusion-plugin-examples/openclaw-runtime@0.2.47
- @fusion-plugin-examples/paperclip-runtime@0.2.47

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.37.0
- @fusion/dashboard@0.37.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.37.0
- @fusion/pi-claude-cli@0.37.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.37.0

### @runfusion/fusion

#### Minor Changes

- b335f3d: Add a new `fn_goal_show` tool for goal retrieval by ID, including structured JSON output via `details.goal` and a stable not-found contract (`GOAL_NOT_FOUND`).

  Also register `fn_goal_list` and `fn_goal_show` in the engine readonly tool allowlist so agent runtime sessions can use goal retrieval on the readonly path.

#### Patch Changes

- 230efa1: Update `useAiMergeCommitSummary` docs/JSDoc to match the intended default of `true`, including that merge commit summaries include a subject plus body summary (narrative + bullets + diff-stat).

  Also fixes AI merge-mode prompt guidance so AI-authored squash commits include a summarized body instead of subject-only commit messages.

- b5f2f91: Do not mark executor sessions as failed when they are parked for pending code review.

### runfusion.ai

#### Patch Changes

- Updated dependencies [230efa1]
- Updated dependencies [b335f3d]
- Updated dependencies [b5f2f91]
  - @runfusion/fusion@0.37.0

## 0.36.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.36.0
- @fusion/engine@0.36.0
- @fusion-plugin-examples/cli-printing-press@0.1.13
- @fusion-plugin-examples/dependency-graph@0.1.27
- @fusion-plugin-examples/roadmap@0.1.15
- @fusion-plugin-examples/cursor-runtime@0.1.15
- @fusion-plugin-examples/droid-runtime@0.1.22
- @fusion-plugin-examples/hermes-runtime@0.2.46
- @fusion-plugin-examples/openclaw-runtime@0.2.46
- @fusion-plugin-examples/paperclip-runtime@0.2.46

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.36.0
- @fusion/dashboard@0.36.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.36.0
- @fusion/pi-claude-cli@0.36.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.36.0

### @runfusion/fusion

#### Minor Changes

- 2a35358: Add Goals REST API (`/api/goals`) with list/create/update/archive/unarchive endpoints.
  Creating a 6th active goal or unarchiving when already at 5 active now returns HTTP 409 with `ACTIVE_GOAL_LIMIT_EXCEEDED` details.
- 009d569: Add `fn goals` CLI subcommand (`list` / `create` / `archive`) and pi extension tools (`fn_goal_list`, `fn_goal_create`, `fn_goal_archive`) for Slice 1 of the Goals primitive. Author-facing only — no agent anchoring yet.

#### Patch Changes

- f258a75: Fix ntfy JSON publish notifications to encode `priority` as the integer scale expected by ntfy so unicode mailbox/room notifications deliver successfully.
- 2c4683a: Widen task detail modal on tablet viewports to use more of the 769px–1024px viewport.
- e84673c: Close source-imported GitHub issues when their linked Fusion task is deleted, with parity to tracking-issue delete handling. Dashboard delete confirmation now prompts for `close`, `delete`, or `leave` on source-imported issues and forwards `githubIssueAction` through task deletion flows. For API callers that omit `githubIssueAction` (or send `auto`) on source-imported issue deletes, Fusion now defaults to `close`.
- 200dda9: Suppress a misleading transient failure state when a worktree-local `.fusion/tasks/<id>/task.json` read briefly returns ENOENT during executor session startup. Fusion now treats this as recoverable, routes through existing auto-recovery, and avoids persisting `status: "failed"`/`error` so the red task-card error banner and failed notification are not shown for self-healed runs.
- 6b27ab5: fix(FN-5627): default auto-prerebase to fire when branch is >=1 commit behind integration

  `decideAutoPrerebase()` previously defaulted `prerebaseDivergenceThreshold` to `0`, which meant the threshold path **never fired** unless the user explicitly set a positive value. Only hot-file matches could trigger prerebase.

  The result: tasks whose branch was started against an older main tip (because other tasks landed concurrently) would skip prerebase, build their squash commit against the stale base, and then fail at the `git update-ref` step because the squash commit didn't descend from current main. The merger correctly detected this as a non-fast-forward advance and threw `IntegrationBranchConcurrentAdvanceError` — with both "expected" and "observed" SHAs set to the current main tip (because `observedCurrentSha` was captured from the pre-update rev-parse). This produced the misleading "expected X, observed X" same-SHA error signature that stranded FN-5632 stuck at `mergeRetries=3`.

  New default: `prerebaseDivergenceThreshold = 1`. Any branch behind by at least 1 commit auto-rebases before squash. Users who want the legacy never-fire behavior can explicitly set `prerebaseDivergenceThreshold = 0`. Threshold comparison also changed from `>` to `>=` so an explicit threshold of N rebases at N+ commits behind instead of N+1+.

  The self-healing classifier comment for `spurious-concurrent-advance-same-sha` is updated to reflect that the signature can come from either the pre-FN-5627 misclassification OR the legitimate post-FN-5627 non-fast-forward path; the auto-recovery sweep is unchanged because both cases self-heal cleanly once prerebase fires on the retry.

  Tests:

  - Default threshold (undefined) fires at 1 commit behind
  - Explicit threshold = 0 stays as opt-out (never fire on commit-count)
  - Default threshold doesn't fire when branch is up-to-date (commitsBehind=0)

- b2d547e: fix(FN-5627): close TOCTOU window between merger optimistic `mergeConfirmed: true` write and integration ref advance, add reachability gate on auto-merge fast-path

  The merger previously persisted `mergeConfirmed: true` + `commitSha` to the task row as soon as the local squash commit was built, **before** running `git update-ref refs/heads/<integration>` to actually advance the integration branch. If the ref-advance then failed for any reason (lock contention, hook rejection, packed-refs race, or a misclassified non-CAS error via the `merger-ref-update-advance.ts` string heuristic), the task row was poisoned: the auto-merge scheduler's `mergeConfirmed` fast-path would silently promote the never-landed work to `done` on the next tick, including emitting `task:merged` and closing the GitHub tracking issue.

  This affected at least 9 tasks across 2026-05-27/28 (FN-5596, FN-5597, FN-5599, FN-5612, FN-5613, FN-5614, FN-5616, FN-5623, FN-5625) — the merger silently dropped real work and marked the tasks complete.

  The fix has three layers:

  1. **merger.ts** — In `reuseTaskWorktreeMerge` mode, persist `mergeConfirmed: false` initially. Promote to `true` only after `advanceIntegrationBranchRef` returns `advanced: true`. Other merge paths (legacy in-place merge, verified no-op fast-paths, owned-commit recovery) are unchanged because they advance the ref before this point.

  2. **project-engine.ts** — Defense-in-depth reachability gate on the auto-merge "merge already confirmed" fast-path. Before `moveTask(taskId, "done")`, verify `git merge-base --is-ancestor <commitSha> <integrationBranch>` succeeds. On failure, clear `mergeConfirmed`, mark task `status: "failed"`, leave in `in-review`, and emit `merger:fast-path-blocked-foreign-commit` run-audit event. Legitimate no-op merges (no `commitSha`) bypass the gate.

  3. **merger-ref-update-advance.ts** — Replace the fragile string heuristic that classified update-ref failures as `concurrent-advance` (matching `"is at"` / `"expected"` / `"cannot lock ref"` in error text) with structured detection. After update-ref fails, re-read the ref: if observed equals expected, classify as `ref-update-refused` (no actual race occurred). Eliminates the misleading "expected X observed X" same-SHA log signature seen on FN-5625.

- 694970b: fix(FN-5627): always rebase behind branches before squash regardless of user-configured prerebase threshold

  After the FN-5627 default-threshold fix landed (threshold=1 default), tasks were still getting stuck at `mergeRetries=3` with `Integration branch main advanced concurrently (expected X, observed X)` errors because user projects with explicit `prerebaseDivergenceThreshold` values higher than the branch's commits-behind count still skipped prerebase entirely.

  Example: a project with `prerebaseDivergenceThreshold: 50` for low-noise PR experience would skip prerebase on a task branched 4 commits behind main. The squash commit then doesn't descend from current main, and `git update-ref` correctly refuses the non-fast-forward advance — producing the misleading same-SHA error signature that stranded FN-5626, FN-5628, FN-5633.

  Root distinction missed in the earlier fix: the user-configurable `prerebaseDivergenceThreshold` controls the _user-visible severity reporting_ ("this branch is N commits behind"), while engine correctness requires a _safety invariant_ ("any branch behind main MUST be rebased before squash, or update-ref will fail"). These are independent concerns.

  New behavior:

  - After the hot-file and threshold checks, `decideAutoPrerebase()` now returns `fire: true` with `reason: "safety-fallback-any-divergence"` whenever `commitsBehind > 0`.
  - The threshold-based path still wins when tripped (so user-visible audit `reason` reflects the configured policy when applicable).
  - Full opt-out remains `prerebaseAutoEnabled: false` — that case skips the safety fallback too, and the user accepts that behind-branch merges will fail.
  - `prerebaseDivergenceThreshold: 0` is no longer a complete opt-out from the commit-count gate — it only suppresses the threshold-based reason label. Safety fallback still fires.

  Tests:

  - New `safety-fallback-any-divergence` reason added to `AutoPrerebaseDecision.reason` union.
  - 4 commits behind with threshold=50 → fires via safety fallback (was: skipped).
  - `prerebaseAutoEnabled=false` → no fire (full opt-out preserved).
  - Configured threshold tripping still wins the `reason` label.
  - Branch fully up-to-date (commitsBehind=0) → no-divergence (unchanged).

- 5768d5e: feat(FN-5627): self-heal transient merge failures stuck at mergeRetries=3

  After the FN-5627 merger fix landed, two in-review tasks (FN-5628, FN-5632) remained stuck at `mergeRetries=3` with `status='failed'` due to transient merge errors that the merger correctly identified but had no auto-recovery for:

  - `lease-handoff-failed: target-not-queued` — FN-5353 class race where the merge queue lease acquisition saw the task drop out of the queue between enqueue and handoff (typically due to a self-healing sweep cleaning stale `mergeQueue` rows mid-flight).
  - Legacy same-SHA spurious concurrent-advance errors persisted before FN-5627's `merger-ref-update-advance.ts` classifier fix landed.

  These tasks had no path forward except manual intervention. The `AUTO_MERGE_COOLDOWN_MS` cooldown reset takes hours and gives up too easily.

  This change adds `SelfHealingManager.recoverTransientMergeFailures()`, wired into both startup recovery and the periodic Batch 2 maintenance loop. For each in-review task with `mergeRetries >= MAX_AUTO_MERGE_RETRIES`, `status='failed'`, and an `error` matching `classifyTransientMergeError()`:

  1. Reset `mergeRetries=0`, clear `status`/`error`.
  2. Increment `mergeDetails.transientRecoveryCount` (new field on `MergeDetails`).
  3. Re-enqueue via `requeueForAutoMerge`.
  4. Emit `merger:transient-failure-auto-recovered` run-audit event.

  Bounded by `MAX_TRANSIENT_MERGE_RECOVERIES = 2` to avoid infinite loops on genuinely stuck tasks. Once exhausted, the task stays parked as failed and emits `merger:transient-failure-budget-exhausted` once with a `[transient-recovery-budget-exhausted]` marker on `error` for repeat-suppression.

  Non-transient failure classes (verification, build, real conflicts, etc.) are not eligible — only the pattern-matched transient classes auto-recover. No-op when `autoMerge=false`, no `requeueForAutoMerge` callback wired, or pause is active.

  Tests:

  - Lease-handoff transient recovery path
  - Same-SHA spurious-advance recovery (legacy pre-FN-5627)
  - Genuine concurrent-advance (different SHAs) NOT recovered
  - Non-transient failures (verification errors) NOT recovered
  - Budget exhaustion behavior
  - autoMerge=false no-op

- e75c4da: fix(FN-5627): suppress ntfy notifications for transient merge failures the engine auto-recovers

  Even with the FN-5627 merger TOCTOU fix + transient-failure self-healing sweep + safety-fallback auto-prerebase landed, the merger can still hit transient failure classes (lease handoff races, brief same-SHA non-FF advances) for tasks whose branches are particularly out-of-sync. The self-healing sweep auto-recovers them within bounded budget — but each individual failure cycle was firing a ntfy alarm before the recovery cleared the failed state, producing user-facing alarm spam for tasks that were never actually stuck.

  Two layers of fix:

  1. `NotificationService.handleTaskUpdated` now classifies `task.error` via the new shared `classifyTransientMergeError` helper before scheduling the deferred failure notification. Transient classes (`lease-handoff-target-not-queued`, `spurious-concurrent-advance-same-sha`) get logged as suppressed and never schedule a ntfy timer.

  2. Defense-in-depth: `fireDeferredFailureNotification` re-classifies the error at dispatch time, so a failure scheduled before the suppression landed on a newer cycle still suppresses if the error matches a transient class.

  The classifier itself moved from `self-healing.ts` to a new logger-free `transient-merge-error-classifier.ts` module so consumers in `NotificationService` don't pull `createLogger` through the import chain and break test mocks of `../logger.js`. `self-healing.ts` re-exports the symbol for backward compatibility.

  Log prefix for the recovery actions also changed from `[FN-5627] Auto-recovering...` to `Auto-recovered:` so that `NotificationService.maybeSuppressTransientFailedNotification`'s existing `/^Auto-recovered:/` log-prefix check cancels any already-scheduled failure notification when the sweep runs mid-grace-window.

  Tests:

  - 3 new notification-service tests covering transient suppression for both error classes plus a control case ensuring genuine non-transient failures still notify.
  - Existing transient-recovery tests in self-healing.test.ts continue to pass against the relocated classifier.

- b2dce7d: FN-5631 re-lands FN-5616 to add an opt-in `githubCloseSourceIssueOnDone` setting that closes source-imported GitHub issues when linked tasks are completed, including startup reconciliation for previously missed closes.
- 1153b09: feat(FN-5637): update `fn init` to add `fusion.db`, `fusion.db-wal`, and `fusion.db-shm` to project `.gitignore` alongside `.fusion` and `.pi` so stray runtime SQLite files are not committed.
- 5b5da2c: Fix bundled runtime plugin auto-install in globally installed CLI builds. Save/Save & Test for Paperclip, Hermes, OpenClaw, Cursor, and Droid runtime providers no longer fails with `unavailable in this build` when bundled plugins are present under `dist/plugins/<id>`.
- b96b0bc: Fix `fn update` npm EEXIST bin-link collisions by retrying once with `--force` and showing manual recovery guidance when the retry fails.
- 2a35358: Add a new project-level `goals` table to the core schema and fresh database DDL.
  Bump `SCHEMA_VERSION` from 91 to 92 with an idempotent migration that creates `goals` and `idxGoalsStatus`.
- 29ac58f: feat(FN-5633): standalone AI merge path (clean-room merge + AI reviewer)

  Adds a self-contained AI merge path (`merger.mode: "ai"`, the new default) that the engine dispatches to instead of the legacy `aiMergeTask` pipeline. It does not share the legacy scaffolding (prerebase / conflict-strategy ladder / post-merge audit / transient self-heal), which was buggy and error-prone.

  How it works:

  - **Clean room**: a throwaway detached worktree is created at the target branch's current tip, so the user's real checkout is never the merge surface — dirty files cannot be clobbered and the landing is a fast-forward by construction.
  - **AI merge**: an AI agent merges the task branch into the clean room and produces one squash commit, resolving conflicts in favor of the task's intent.
  - **AI reviewer with retries**: a fresh read-only reviewer audits the squash (completeness / collateral / conflict-soundness) and classifies any veto blocking vs advisory. It drives up to `merger.maxReviewPasses` corrective re-merges. After the budget, advisory concerns land with a logged warning; an unfixable BLOCKING (correctness) concern hard-fails (`AiMergeBlockedError`) rather than ship wrong code. Verdict parsing fails safe to blocking.
  - **Per-task target branch**: each task merges into its own target branch (or the default integration branch). The local checkout is only synced when it is on that target.
  - **Local checkout sync**: when the checkout is on the target branch, the ref + working tree advance together via `git merge --ff-only` (dirty state read accurately before the move); dirty edits are stashed, fast-forwarded, and restored — and if the restore conflicts the AI merger reconciles them (the original edits are also kept in a stash as a backup). A checkout on a different branch is advanced via `update-ref` and left untouched. Un-stashable dirty state advances the ref and leaves the working tree with a warning. Concurrent advances trigger a bounded rebuild on the new tip.
  - **Status + logs**: progress (merging / reviewing / corrective passes / landing / blocked / landed) is written to the task status pill and the task log stream.

  Settings: `merger.mode` (`ai` default / `deterministic` legacy), `merger.reviewerModel`, `merger.maxReviewPasses` (default 3), surfaced in Settings → Merge. When AI merge is on, the legacy merge-mechanics settings (integration worktree, conflict strategy, overlap guard, post-merge audit, direct-commit routing) are hidden since they do not apply.

  Commit message: the AI agent writes the squash commit subject as a concise summary of the actual changes (not just the task title), and every landed squash carries the board-association trailers — `Fusion-Task-Id: <taskId>` plus the canonical lineage trailer when the task has a `lineageId` — guaranteed via an idempotent amend even if the agent omits them, so the board associates the commit with the task.

  Verification: the merge agent is instructed to run the project's tests, type-check, and lint after resolving the merge and to fix any NEW failure the merge introduced (without being on the hook for pre-existing breakage) before committing.

  Editable prompt: the AI merge agent's base persona is the editable "merger" role prompt (Settings → Prompts); the non-negotiable clean-room / verification / commit-trailer rules are always appended so a custom prompt can't drop them.

  Reviewer model: the reviewer agent uses the project's reviewer/validator model lane (`resolveValidatorSettingsModel`: project validator → global validator → project default), not a merge-specific setting.

  No-branch guard: a missing task branch is a benign no-op only when the task was never executed or was already merged (branch cleaned up on re-process); if the task was executed (`baseCommitSha` recorded) and was never merged, the merge fails loudly rather than silently marking the task done.

  The legacy `aiMergeTask` pipeline is retained unchanged and used when `merger.mode: "deterministic"`.

  Tests: `merger-ai.test.ts` covers the verdict parser, clean merge, blocking hard-fail (no advance), advisory land, empty no-op, per-task target branch isolation, missing-target-branch error, and `landSquash` (clean ff, other-branch update-ref, dirty stash-restore, AI-resolved restore conflict). Engine merge-orchestration tests that assert the legacy path are pinned to `merger.mode: "deterministic"`.

- cec191e: Migrate Fusion's pi dependencies from `@mariozechner/pi-coding-agent` / `@mariozechner/pi-ai` to the new `@earendil-works/*` scope and bump to `^0.77.0`.

  This follows the upstream project move to `https://github.com/earendil-works/pi` and updates transitive dependency resolution to the maintained package namespace.

- aa7eccb: When `useAiMergeCommitSummary` is enabled, AI-authored merge commits now include a richer body: the short narrative headline plus an AI-generated bullet summary of changed modules/files, followed by a `Files changed` diff stat block.

  `mergeDetails.mergeCommitMessage` remains the short headline summary so dashboard UI consumers keep their existing concise display behavior.

- d78fbcc: Fix GitHub PR modal/review fetches that call `gh api` through `runGhJsonAsync`.

  `runGhJson` and `runGhJsonAsync` now skip auto-appending `--json` for the `gh api` subcommand (which already returns JSON and rejects that flag), preventing runtime `unknown flag: --json` errors when loading PR comments/reviews.

- 2df891f: ci: re-enable auto-trigger of binary release workflow on `v*` tags so GitHub Releases include CLI and desktop binaries

### runfusion.ai

#### Patch Changes

- Updated dependencies [f258a75]
- Updated dependencies [2c4683a]
- Updated dependencies [e84673c]
- Updated dependencies [2a35358]
- Updated dependencies [009d569]
- Updated dependencies [200dda9]
- Updated dependencies [6b27ab5]
- Updated dependencies [b2d547e]
- Updated dependencies [694970b]
- Updated dependencies [5768d5e]
- Updated dependencies [e75c4da]
- Updated dependencies [b2dce7d]
- Updated dependencies [1153b09]
- Updated dependencies [5b5da2c]
- Updated dependencies [b96b0bc]
- Updated dependencies [2a35358]
- Updated dependencies [29ac58f]
- Updated dependencies [cec191e]
- Updated dependencies [aa7eccb]
- Updated dependencies [d78fbcc]
- Updated dependencies [2df891f]
  - @runfusion/fusion@0.36.0

## 0.35.0

### @fusion/dashboard

#### Patch Changes

- Updated dependencies [1992049]
  - @fusion/engine@0.35.0
  - @fusion-plugin-examples/cli-printing-press@0.1.12
  - @fusion-plugin-examples/dependency-graph@0.1.26
  - @fusion-plugin-examples/roadmap@0.1.14
  - @fusion/core@0.35.0
  - @fusion-plugin-examples/cursor-runtime@0.1.14
  - @fusion-plugin-examples/droid-runtime@0.1.21
  - @fusion-plugin-examples/hermes-runtime@0.2.45
  - @fusion-plugin-examples/openclaw-runtime@0.2.45
  - @fusion-plugin-examples/paperclip-runtime@0.2.45

### @fusion/desktop

#### Patch Changes

- @fusion/dashboard@0.35.0
- @fusion/core@0.35.0

### @fusion/engine

#### Minor Changes

- 1992049: Add opt-in RTK command rewriting for Pi bash tools via `FUSION_RTK_REWRITE`.

#### Patch Changes

- @fusion/core@0.35.0
- @fusion/pi-claude-cli@0.35.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.35.0

### @runfusion/fusion

#### Minor Changes

- d767e2e: Add `openai-responses` as a supported custom provider `apiType` across CLI, engine, dashboard API validation, and dashboard forms.

  Custom providers configured with this apiType now route through pi-ai's built-in `openai-responses` transport while probe-model discovery continues to use the OpenAI-compatible `/v1/models` path.

#### Patch Changes

- da34bd0: Dashboard now shows a top-level "Re-login required" banner when a stored OAuth provider credential (Codex, Claude, etc.) has expired, and the engine logs the expired set on startup and once every 24 hours.
- d76b6f9: TUI System panel now reliably shows the full auth token at all terminal widths so it can be selected and copied manually when the `[c]` shortcut is unavailable.
- d767e2e: Fixed custom provider registration so provider keys are derived from the configured provider name (with deterministic collision suffixing) instead of internal UUID ids, ensuring model selector and logs show stable human-readable keys. Also fixed the OpenAI-compatible custom-provider registration path by validating end-to-end openai-completions round-trip behavior with a regression test.
- 8a0fbf0: Fix the Bun-compiled `fn` executable so `--help` no longer crashes with a missing `react-devtools-core` module. The build now defines `process.env.DEV` as `false` during compile, allowing Ink's DEV-only devtools import path to be removed from the bundled binary.

### runfusion.ai

#### Patch Changes

- Updated dependencies [da34bd0]
- Updated dependencies [d76b6f9]
- Updated dependencies [d767e2e]
- Updated dependencies [d767e2e]
- Updated dependencies [8a0fbf0]
  - @runfusion/fusion@0.35.0

## 0.34.0

### @fusion/core

#### Patch Changes

- 6a6c6fd: Dashboard startup and request-storm fixes:

  - **Faster startup**: parallelized independent store inits, started CentralCore init early in background, and ran plugin loading concurrently with extension resolution. The duplicate-runtime root cause is also fixed — `shouldUseHybridExecutor` no longer auto-enables for local-only multi-project setups, where `ProjectEngineManager` already handles project lifecycle (set `FUSION_HYBRID_EXECUTOR=1` to force-enable). Eliminates ~7s of redundant self-healing pipeline work per cold start.
  - **Per-page request reduction**: added in-flight request dedupe (`packages/dashboard/app/api/dedupe.ts`) wrapped around the top API offenders. A single page load went from ~177 requests to ~101, with `/api/plugins/ui-slots` dropping from 17× to 1×.
  - **Stale-data-after-mutation hazard**: `forceFresh` option on the deduped fetchers now redirects ALL in-flight waiters to receive the fresh post-mutation response, not just the forcing caller. Generation counters in `useAgents` and `AgentListModal` provide a second layer of protection against slow polls overwriting fresh state.
  - **SSE refresh storm**: agent SSE event handler now debounces (250ms) with a trailing-edge guard, so multi-agent activity bursts coalesce to at most 2 refetches per burst instead of one per event.
  - **Live isolation-mode transition**: PATCH `/api/projects/:id` with an `isolationMode` change now returns a 503 with actionable guidance when HybridExecutor is unavailable (local-only single-node), instead of silently persisting a config that the live runtime won't honor.
  - **Error handling regression**: restored try/catch around `HybridExecutor.initialize` and `engineManager.ensureEngine` in the parallel engine setup so a paused or broken cwd project no longer aborts dashboard startup.
  - **TaskStore migration race**: sequenced the SQLite store inits (TaskStore → AutomationStore → PluginStore → AgentStore) since they all open the same `.fusion/fusion.db` and run `addColumnIfMissing` migrations with a TOCTOU `hasColumn` → `ALTER` pattern.
  - **`gh` CLI invocation storm**: `isGhAvailable()` and `isGhAuthenticated()` now memoize their results with a 60s TTL. `GitHubTrackingReconciler` was scanning up to 200 done tasks at startup and calling `hasGhAuth()` per task — each call shelled out to `gh --version` and `gh auth status` (which makes a network roundtrip), pinning the event loop for ~60s of synchronous `spawnSync` work. CPU-profile-confirmed: dropped from 71s (69% of cold-start CPU) to 2s. The cache benefits all 28+ call sites in `dashboard/src/github.ts`, the engine PR monitor, the research provider, and the API routes automatically. `resetGhAvailabilityCache()` is exported for login/logout flows that need to invalidate immediately.
  - **SQLite integrity check delay**: `PRAGMA integrity_check(100)` walks every page of the database file and was scheduled 3 seconds after init — landing right in the responsiveness-critical window for ~7s per database. Pushed the deferred-check timer to 60 seconds so the user is already interacting with the dashboard by the time it runs. The check itself is unchanged; corruption detection still works.
  - **Engine init event-loop yields**: `InProcessRuntime.start()` now awaits a `setImmediate`-based yield between major init phases (TaskStore → Plugins → WorktreePool → AgentStore → Scheduler → Executor → HeartbeatMonitor → SelfHealing) so HTTP requests can be processed between them instead of waiting on the entire stack. Same yield is now interleaved between each step of `SelfHealingManager.runStartupRecovery()` (34 steps per project) and its periodic maintenance batches.
  - **Deferred startup recovery**: `InProcessRuntime.start()` no longer awaits `resumeStartupRecoverySequence()` or `workerManager.reconcileOrphaned()` — both are correctness-preserving background operations and their git/SQLite work was blocking server-listen for several seconds.
  - **Deferred orphan-task AI agent resumption**: orphaned in-progress tasks resumed at engine restart now wait 30 seconds before spawning their AI agent session (worktree setup + pi-coding-agent session creation is heavy and saturates the event loop). Override via `FUSION_RESUME_ORPHAN_DELAY_MS=<ms>`; auto-zeroes under Vitest.
  - **Event-loop lag tracer**: opt-in debug aid for diagnosing cold-start regressions. Set `FUSION_TRACE_EL_LAG=/path/to/file.txt` to capture every block >150ms with a timestamp relative to process start.

### @fusion/dashboard

#### Patch Changes

- 6a6c6fd: Dashboard startup and request-storm fixes:

  - **Faster startup**: parallelized independent store inits, started CentralCore init early in background, and ran plugin loading concurrently with extension resolution. The duplicate-runtime root cause is also fixed — `shouldUseHybridExecutor` no longer auto-enables for local-only multi-project setups, where `ProjectEngineManager` already handles project lifecycle (set `FUSION_HYBRID_EXECUTOR=1` to force-enable). Eliminates ~7s of redundant self-healing pipeline work per cold start.
  - **Per-page request reduction**: added in-flight request dedupe (`packages/dashboard/app/api/dedupe.ts`) wrapped around the top API offenders. A single page load went from ~177 requests to ~101, with `/api/plugins/ui-slots` dropping from 17× to 1×.
  - **Stale-data-after-mutation hazard**: `forceFresh` option on the deduped fetchers now redirects ALL in-flight waiters to receive the fresh post-mutation response, not just the forcing caller. Generation counters in `useAgents` and `AgentListModal` provide a second layer of protection against slow polls overwriting fresh state.
  - **SSE refresh storm**: agent SSE event handler now debounces (250ms) with a trailing-edge guard, so multi-agent activity bursts coalesce to at most 2 refetches per burst instead of one per event.
  - **Live isolation-mode transition**: PATCH `/api/projects/:id` with an `isolationMode` change now returns a 503 with actionable guidance when HybridExecutor is unavailable (local-only single-node), instead of silently persisting a config that the live runtime won't honor.
  - **Error handling regression**: restored try/catch around `HybridExecutor.initialize` and `engineManager.ensureEngine` in the parallel engine setup so a paused or broken cwd project no longer aborts dashboard startup.
  - **TaskStore migration race**: sequenced the SQLite store inits (TaskStore → AutomationStore → PluginStore → AgentStore) since they all open the same `.fusion/fusion.db` and run `addColumnIfMissing` migrations with a TOCTOU `hasColumn` → `ALTER` pattern.
  - **`gh` CLI invocation storm**: `isGhAvailable()` and `isGhAuthenticated()` now memoize their results with a 60s TTL. `GitHubTrackingReconciler` was scanning up to 200 done tasks at startup and calling `hasGhAuth()` per task — each call shelled out to `gh --version` and `gh auth status` (which makes a network roundtrip), pinning the event loop for ~60s of synchronous `spawnSync` work. CPU-profile-confirmed: dropped from 71s (69% of cold-start CPU) to 2s. The cache benefits all 28+ call sites in `dashboard/src/github.ts`, the engine PR monitor, the research provider, and the API routes automatically. `resetGhAvailabilityCache()` is exported for login/logout flows that need to invalidate immediately.
  - **SQLite integrity check delay**: `PRAGMA integrity_check(100)` walks every page of the database file and was scheduled 3 seconds after init — landing right in the responsiveness-critical window for ~7s per database. Pushed the deferred-check timer to 60 seconds so the user is already interacting with the dashboard by the time it runs. The check itself is unchanged; corruption detection still works.
  - **Engine init event-loop yields**: `InProcessRuntime.start()` now awaits a `setImmediate`-based yield between major init phases (TaskStore → Plugins → WorktreePool → AgentStore → Scheduler → Executor → HeartbeatMonitor → SelfHealing) so HTTP requests can be processed between them instead of waiting on the entire stack. Same yield is now interleaved between each step of `SelfHealingManager.runStartupRecovery()` (34 steps per project) and its periodic maintenance batches.
  - **Deferred startup recovery**: `InProcessRuntime.start()` no longer awaits `resumeStartupRecoverySequence()` or `workerManager.reconcileOrphaned()` — both are correctness-preserving background operations and their git/SQLite work was blocking server-listen for several seconds.
  - **Deferred orphan-task AI agent resumption**: orphaned in-progress tasks resumed at engine restart now wait 30 seconds before spawning their AI agent session (worktree setup + pi-coding-agent session creation is heavy and saturates the event loop). Override via `FUSION_RESUME_ORPHAN_DELAY_MS=<ms>`; auto-zeroes under Vitest.
  - **Event-loop lag tracer**: opt-in debug aid for diagnosing cold-start regressions. Set `FUSION_TRACE_EL_LAG=/path/to/file.txt` to capture every block >150ms with a timestamp relative to process start.

- Updated dependencies [6a6c6fd]
- Updated dependencies [97f1143]
- Updated dependencies [4e4830f]
  - @fusion/engine@0.34.0
  - @fusion/core@0.34.0
  - @fusion-plugin-examples/cli-printing-press@0.1.11
  - @fusion-plugin-examples/dependency-graph@0.1.25
  - @fusion-plugin-examples/roadmap@0.1.13
  - @fusion-plugin-examples/cursor-runtime@0.1.13
  - @fusion-plugin-examples/droid-runtime@0.1.20
  - @fusion-plugin-examples/hermes-runtime@0.2.44
  - @fusion-plugin-examples/openclaw-runtime@0.2.44
  - @fusion-plugin-examples/paperclip-runtime@0.2.44

### @fusion/desktop

#### Patch Changes

- Updated dependencies [6a6c6fd]
  - @fusion/dashboard@0.34.0
  - @fusion/core@0.34.0

### @fusion/engine

#### Minor Changes

- 97f1143: Add optional dependencies parameter to fn_task_update tool. Executors can now programmatically modify task dependency arrays during execution with `fn_task_update({ id: "FN-XXX", dependencies: ["FN-001", "FN-002"] })`. The parameter is optional and backward-compatible; omitting it preserves existing dependencies. Includes validation for self-dependency and non-existent task IDs. Eliminates the need for direct task.json editing workarounds.

#### Patch Changes

- 6a6c6fd: Dashboard startup and request-storm fixes:

  - **Faster startup**: parallelized independent store inits, started CentralCore init early in background, and ran plugin loading concurrently with extension resolution. The duplicate-runtime root cause is also fixed — `shouldUseHybridExecutor` no longer auto-enables for local-only multi-project setups, where `ProjectEngineManager` already handles project lifecycle (set `FUSION_HYBRID_EXECUTOR=1` to force-enable). Eliminates ~7s of redundant self-healing pipeline work per cold start.
  - **Per-page request reduction**: added in-flight request dedupe (`packages/dashboard/app/api/dedupe.ts`) wrapped around the top API offenders. A single page load went from ~177 requests to ~101, with `/api/plugins/ui-slots` dropping from 17× to 1×.
  - **Stale-data-after-mutation hazard**: `forceFresh` option on the deduped fetchers now redirects ALL in-flight waiters to receive the fresh post-mutation response, not just the forcing caller. Generation counters in `useAgents` and `AgentListModal` provide a second layer of protection against slow polls overwriting fresh state.
  - **SSE refresh storm**: agent SSE event handler now debounces (250ms) with a trailing-edge guard, so multi-agent activity bursts coalesce to at most 2 refetches per burst instead of one per event.
  - **Live isolation-mode transition**: PATCH `/api/projects/:id` with an `isolationMode` change now returns a 503 with actionable guidance when HybridExecutor is unavailable (local-only single-node), instead of silently persisting a config that the live runtime won't honor.
  - **Error handling regression**: restored try/catch around `HybridExecutor.initialize` and `engineManager.ensureEngine` in the parallel engine setup so a paused or broken cwd project no longer aborts dashboard startup.
  - **TaskStore migration race**: sequenced the SQLite store inits (TaskStore → AutomationStore → PluginStore → AgentStore) since they all open the same `.fusion/fusion.db` and run `addColumnIfMissing` migrations with a TOCTOU `hasColumn` → `ALTER` pattern.
  - **`gh` CLI invocation storm**: `isGhAvailable()` and `isGhAuthenticated()` now memoize their results with a 60s TTL. `GitHubTrackingReconciler` was scanning up to 200 done tasks at startup and calling `hasGhAuth()` per task — each call shelled out to `gh --version` and `gh auth status` (which makes a network roundtrip), pinning the event loop for ~60s of synchronous `spawnSync` work. CPU-profile-confirmed: dropped from 71s (69% of cold-start CPU) to 2s. The cache benefits all 28+ call sites in `dashboard/src/github.ts`, the engine PR monitor, the research provider, and the API routes automatically. `resetGhAvailabilityCache()` is exported for login/logout flows that need to invalidate immediately.
  - **SQLite integrity check delay**: `PRAGMA integrity_check(100)` walks every page of the database file and was scheduled 3 seconds after init — landing right in the responsiveness-critical window for ~7s per database. Pushed the deferred-check timer to 60 seconds so the user is already interacting with the dashboard by the time it runs. The check itself is unchanged; corruption detection still works.
  - **Engine init event-loop yields**: `InProcessRuntime.start()` now awaits a `setImmediate`-based yield between major init phases (TaskStore → Plugins → WorktreePool → AgentStore → Scheduler → Executor → HeartbeatMonitor → SelfHealing) so HTTP requests can be processed between them instead of waiting on the entire stack. Same yield is now interleaved between each step of `SelfHealingManager.runStartupRecovery()` (34 steps per project) and its periodic maintenance batches.
  - **Deferred startup recovery**: `InProcessRuntime.start()` no longer awaits `resumeStartupRecoverySequence()` or `workerManager.reconcileOrphaned()` — both are correctness-preserving background operations and their git/SQLite work was blocking server-listen for several seconds.
  - **Deferred orphan-task AI agent resumption**: orphaned in-progress tasks resumed at engine restart now wait 30 seconds before spawning their AI agent session (worktree setup + pi-coding-agent session creation is heavy and saturates the event loop). Override via `FUSION_RESUME_ORPHAN_DELAY_MS=<ms>`; auto-zeroes under Vitest.
  - **Event-loop lag tracer**: opt-in debug aid for diagnosing cold-start regressions. Set `FUSION_TRACE_EL_LAG=/path/to/file.txt` to capture every block >150ms with a timestamp relative to process start.

- 4e4830f: Fix two bugs that compounded to produce bare `feat(FN-XXXX): merge fusion/fn-XXXX` merge commits in the dashboard:

  - **`Provided value cannot be bound to SQLite parameter 4` (TypeError) mid-merge**: the verification-fix finalize path called `upsertTaskCommitAssociation` with `commitSha` derived from a `git rev-parse HEAD` whose surrounding exec could reject under the parallel-attempt race, leaving `commitSha` undefined when bound to positional parameter 4. Extracted both duplicated callsites into a `recordCommitAssociationFromHead` helper that catches exec failures and validates each git output is non-empty before binding. The merge no longer fails over a denormalized lookup write when the commit itself landed cleanly.
  - **Bare-fallback subjects persisted into `mergeDetails.mergeCommitMessage`**: when `buildDeterministicMergeMessage`'s tier-3 fallback (`merge ${branch}`) made it onto a landed commit, the four `classification.commit.subject` / `landedCommit.subject` recovery sites in `self-healing.ts` and `aiMergeTask` copied that bare subject verbatim into `mergeDetails`. Added `regenerateBareMergeSubject` (in a new `merger-bare-subject.ts` module to keep self-healing's import graph narrow) which detects the bare pattern via `BARE_MERGE_SUBJECT_RE` and regenerates a descriptive subject from the landed commit's diff stat via the existing AI commit-subject summarizer. Cosmetic only — the git commit is never amended; the regenerated subject only populates the persisted `mergeDetails` and the in-process `MergeResult`. Gated by `settings.useAiMergeCommitSummary`.

- Updated dependencies [6a6c6fd]
  - @fusion/core@0.34.0
  - @fusion/pi-claude-cli@0.34.0

### @fusion/plugin-sdk

#### Patch Changes

- Updated dependencies [6a6c6fd]
  - @fusion/core@0.34.0

### @runfusion/fusion

#### Minor Changes

- 5eacd79: Add optional `baseBranch` support to mission creation and task planning flows.

  - `fn_mission_create` now accepts `baseBranch` to persist a mission-level default integration branch.
  - Mission feature/slice triage inherits mission `baseBranch` when no explicit triage base branch is supplied.
  - `fn_task_plan`/CLI planning paths now accept and forward `baseBranch` to created tasks.

- 1fb905a: Planning Mode now lets you pick a branch strategy (project default, auto-named, existing, or custom new) and an optional base/merge-target branch when creating a task from a completed planning session.

#### Patch Changes

- 0a6da9f: Fix ntfy notification deep links: project-only links now switch projects, and task links to non-current projects resolve against the correct project before opening the modal.
- 06a107d: Fix triage/executor not swapping to the configured planning fallback model when the primary provider's API key is missing (or returns 401/403/rate-limit). The top-level `promptWithFallback` now delegates to the rich session-attached path (which runs `isRetryableModelSelectionError` and `swapPromptSession`), with a WeakSet re-entry guard preserving the FN-4900 recursion fix.
- 88c465c: Fix two engine reliability bugs surfaced by CI sharding repair:

  - Self-healing in-review branch rebind now dedups case-variant candidate refs by resolved SHA rather than lowercase name, so two distinct branches sharing a case-insensitive name on case-sensitive filesystems (Linux) are correctly flagged as ambiguous instead of one being silently picked.
  - CI test sharding: removed the `--` separator between `pnpm test` and `--shard`, which vitest's CLI parser was treating as end-of-flags and turning the shard selector into a positional file filter — silently disabling sharding so every shard ran the full suite. Test shards now run their actual slice.
  - CI test-shards jobs now check out with `fetch-depth: 0` so engine tests that depend on real git history (merge-base, ref resolution) behave the same on CI as locally.
  - PR Checks workflow now also runs on push to `main`, so post-merge regressions surface immediately instead of waiting for the next PR.

- 6a6c6fd: Dashboard startup and request-storm fixes:

  - **Faster startup**: parallelized independent store inits, started CentralCore init early in background, and ran plugin loading concurrently with extension resolution. The duplicate-runtime root cause is also fixed — `shouldUseHybridExecutor` no longer auto-enables for local-only multi-project setups, where `ProjectEngineManager` already handles project lifecycle (set `FUSION_HYBRID_EXECUTOR=1` to force-enable). Eliminates ~7s of redundant self-healing pipeline work per cold start.
  - **Per-page request reduction**: added in-flight request dedupe (`packages/dashboard/app/api/dedupe.ts`) wrapped around the top API offenders. A single page load went from ~177 requests to ~101, with `/api/plugins/ui-slots` dropping from 17× to 1×.
  - **Stale-data-after-mutation hazard**: `forceFresh` option on the deduped fetchers now redirects ALL in-flight waiters to receive the fresh post-mutation response, not just the forcing caller. Generation counters in `useAgents` and `AgentListModal` provide a second layer of protection against slow polls overwriting fresh state.
  - **SSE refresh storm**: agent SSE event handler now debounces (250ms) with a trailing-edge guard, so multi-agent activity bursts coalesce to at most 2 refetches per burst instead of one per event.
  - **Live isolation-mode transition**: PATCH `/api/projects/:id` with an `isolationMode` change now returns a 503 with actionable guidance when HybridExecutor is unavailable (local-only single-node), instead of silently persisting a config that the live runtime won't honor.
  - **Error handling regression**: restored try/catch around `HybridExecutor.initialize` and `engineManager.ensureEngine` in the parallel engine setup so a paused or broken cwd project no longer aborts dashboard startup.
  - **TaskStore migration race**: sequenced the SQLite store inits (TaskStore → AutomationStore → PluginStore → AgentStore) since they all open the same `.fusion/fusion.db` and run `addColumnIfMissing` migrations with a TOCTOU `hasColumn` → `ALTER` pattern.
  - **`gh` CLI invocation storm**: `isGhAvailable()` and `isGhAuthenticated()` now memoize their results with a 60s TTL. `GitHubTrackingReconciler` was scanning up to 200 done tasks at startup and calling `hasGhAuth()` per task — each call shelled out to `gh --version` and `gh auth status` (which makes a network roundtrip), pinning the event loop for ~60s of synchronous `spawnSync` work. CPU-profile-confirmed: dropped from 71s (69% of cold-start CPU) to 2s. The cache benefits all 28+ call sites in `dashboard/src/github.ts`, the engine PR monitor, the research provider, and the API routes automatically. `resetGhAvailabilityCache()` is exported for login/logout flows that need to invalidate immediately.
  - **SQLite integrity check delay**: `PRAGMA integrity_check(100)` walks every page of the database file and was scheduled 3 seconds after init — landing right in the responsiveness-critical window for ~7s per database. Pushed the deferred-check timer to 60 seconds so the user is already interacting with the dashboard by the time it runs. The check itself is unchanged; corruption detection still works.
  - **Engine init event-loop yields**: `InProcessRuntime.start()` now awaits a `setImmediate`-based yield between major init phases (TaskStore → Plugins → WorktreePool → AgentStore → Scheduler → Executor → HeartbeatMonitor → SelfHealing) so HTTP requests can be processed between them instead of waiting on the entire stack. Same yield is now interleaved between each step of `SelfHealingManager.runStartupRecovery()` (34 steps per project) and its periodic maintenance batches.
  - **Deferred startup recovery**: `InProcessRuntime.start()` no longer awaits `resumeStartupRecoverySequence()` or `workerManager.reconcileOrphaned()` — both are correctness-preserving background operations and their git/SQLite work was blocking server-listen for several seconds.
  - **Deferred orphan-task AI agent resumption**: orphaned in-progress tasks resumed at engine restart now wait 30 seconds before spawning their AI agent session (worktree setup + pi-coding-agent session creation is heavy and saturates the event loop). Override via `FUSION_RESUME_ORPHAN_DELAY_MS=<ms>`; auto-zeroes under Vitest.
  - **Event-loop lag tracer**: opt-in debug aid for diagnosing cold-start regressions. Set `FUSION_TRACE_EL_LAG=/path/to/file.txt` to capture every block >150ms with a timestamp relative to process start.

- bad6759: Enable editing the agent name during the review step of the New Agent dialog.
- 7f01b53: Fix chat session API endpoints ignoring `projectId` in multi-project mode.

  `GET /chat/sessions`, `GET /chat/sessions/:id`, `GET /chat/sessions/:id/messages`
  and related mutation endpoints all used `options.chatStore` (the home-directory
  project's store) regardless of the `projectId` query parameter. In a multi-project
  daemon (e.g. running from `~/`) sessions belonging to secondary projects were
  invisible — list returned empty, fetching by ID returned 404.

  Root cause: `registerChatRoutes` accessed `options.chatStore` directly instead of
  routing through the per-project `resolveProjectChatContext` helper (already used
  correctly by `registerChatRoomRoutes` for the rooms API).

  Fix: introduce a `resolveScopedChatStore(projectId)` helper inside
  `registerChatRoutes` that delegates to `resolveProjectChatContext`, and replace
  all ten `options.chatStore` usages with calls to this helper. When `engineManager`
  is present and has an engine for the given `projectId`, the engine's own
  `ChatStore` is used; otherwise falls back to the default store (backward compatible).

- 64056b3: Fix `useChat` truncating sessions longer than 50 messages on initial open.

  `loadMessages()` fetched `{ limit: 50 }` for the initial load. The
  `loadMoreMessages` callback was never called from `ChatView` (no scroll
  sentinel exists), so sessions beyond 50 messages were permanently cut off.

  Fix: introduce `fetchAllMessagesInChat()` that paginates through the API's
  200-message cap and replace the initial load path. A stale-session guard
  (via `activeSessionRef`) prevents overwriting a switched session's messages.
  The forward-pagination path (`isPaginationRequest = true`) is preserved
  unchanged for backward compatibility.

- 629aa29: Fix Windows compatibility in cloudflared install fallback by replacing `execFileAsync("mkdir", ["-p", ...])` with `fs.mkdir({ recursive: true })`. The shell-level `-p` flag is Unix-only and breaks installation on Windows cmd.exe with "A subdirectory or file -p already exists". The worktree-hooks fix from the original report was already landed independently.

### runfusion.ai

#### Patch Changes

- Updated dependencies [0a6da9f]
- Updated dependencies [06a107d]
- Updated dependencies [88c465c]
- Updated dependencies [6a6c6fd]
- Updated dependencies [bad6759]
- Updated dependencies [7f01b53]
- Updated dependencies [64056b3]
- Updated dependencies [5eacd79]
- Updated dependencies [1fb905a]
- Updated dependencies [629aa29]
  - @runfusion/fusion@0.34.0

## 0.33.0

### @fusion/core

#### Minor Changes

- a201f56: feat(core): add `mergeAdvanceAutoSync` project setting (`"off" | "ff-only" | "stash-and-ff"`)

  Adds the schema for a new project setting that controls what happens in **other** worktrees still checked out on the integration branch when the merger advances the branch ref. Previously the merger only updated `refs/heads/<branch>` and left every other checkout's index and working tree pinned at the old tip, so `git status` in the user's project-root checkout reported the new commits as inverted "staged changes to be committed."

  Modes (default `"stash-and-ff"`):

  - `"off"` — preserve the legacy behavior; user must `git pull` or click the Merge Advance Notice banner Pull button.
  - `"ff-only"` — auto-fast-forward only clean worktrees; dirty worktrees stay untouched and the banner still surfaces.
  - `"stash-and-ff"` — run the Smart Pull pipeline (stash → fast-forward → pop). Pop conflicts emit `merge:auto-sync` audit events with `outcome: "stash-pop-conflict"` and surface through the existing dashboard stash-conflict modal.

  Schema-only in this changeset; the merger hook that consumes the setting lands in the follow-up engine change.

- 51fc826: fix(engine,core): dedup heartbeat-spawned follow-ups by parent task

  Heartbeat agents create follow-up tasks via `fn_task_create`. Until
  now, the intake similarity guard scoped candidates by `sourceAgentId`
  only, so the same parent task could spawn many sibling tasks across
  heartbeats whenever triage rewrote their titles enough to dodge the
  title-fingerprint guard.

  The task-scoped heartbeat now stamps `sourceParentTaskId` (and
  `sourceRunId`) on every `fn_task_create`, and the intake duplicate
  matcher treats a candidate as a sibling when it shares either the
  caller's agent ID or the caller's parent task ID. Same-parent
  siblings with similar descriptions are auto-archived as before.

  Tool description and heartbeat prompts also now instruct agents to
  scan existing open tasks before creating, as a belt-and-suspenders
  layer above the deterministic dedup.

#### Patch Changes

- 408e20b: fix(merger): two root-cause fixes for tasks landing in Done with no commit on main

  **Bug 1: sibling fusion/fn-\* branch as merge target** — `resolveTaskMergeTarget`
  previously returned `task.baseBranch` unconditionally before falling back to the
  project default. When a task was dispatched as a sibling/dependent off another
  in-flight task's worktree, `baseBranch` ended up as the upstream's
  `fusion/fn-<id>` branch. The merger then detached onto that sibling, squashed
  on top of it, and advanced `refs/heads/fusion/fn-<id>` — never main. FN-5233's
  squash (`84563e549`) stranded on `fusion/fn-5339`; FN-5530's
  (`4140a3e0a`) stranded on `fusion/fn-5543`. The resolver now refuses any
  `fusion/fn-\*` candidate as a merge destination and falls through to the
  project default. The merger emits a new `merge:merge-target-rejected-fusion-sibling`
  audit event so the upstream `baseBranch`-propagation bug stays observable.

  **Bug 2: deadlock-recovery mis-attributed tasks to unrelated commits** —
  `findLandedTaskCommit` step (4) used `git log --grep=FN-XXXX` which matches the
  entire commit message (not just the subject) and blindly accepted the first
  hit. FN-5441 and FN-5446 were both marked done against `e3dbfaae` — an
  FN-5483 commit whose body merely _mentioned_ them by name in a paragraph about
  a refusal. The grep fallback now fetches each candidate's body and re-verifies
  ownership via a tightened `commitOwnedByTask`: trailers must be line-anchored
  (`(?:^|\n)Fusion-Task-Id: <id>(?:\n|$)`), and the subject fallback must match
  a conventional-commit form (`<type>(<id>):` or `<id>:`), not a substring.
  Prose mentions can no longer claim a task.

  The historical recovery for FN-5233 has been cherry-picked to main as
  `2d2e5b809`. The other 11 affected tasks (FN-5441, FN-5446, FN-5472, FN-5484,
  FN-5487, FN-5490, FN-5515, FN-5517, FN-5526, FN-5539, FN-5540, FN-5542)
  remain in Done but need separate triage — 3 look like legitimate
  verification-only no-ops, the remaining 9 likely lost real work.

- ec6643e: fix(test-utils): cancel subprocess tracking timer for every proc in afterEach

  The vitest subprocess guard registered a 60 s "command timed out" timer for
  each tracked child process and relied on `afterEach` to cancel it. Under
  concurrent load (`pnpm` recursive test runs) the timer could outlive the
  originating test and fire during a later test's `afterEach`, surfacing as
  spurious "Test subprocess guard detected unsafe child-process usage:
  Timed out after 60000ms" failures attributed to a different test name.

  The cleanup loop now scopes "Left running" failure reporting + SIGKILL to
  processes spawned by the current test, but unconditionally clears each
  tracked subprocess's timer so the 60 s timeout cannot fire after the
  afterEach completes. The grace period before declaring a process leaked
  is also raised from 200 ms to 1 s to absorb event-loop contention from
  slow git shells under recursive test load.

- 4c31e88: feat(engine): merger auto-syncs project-root checkout after advancing integration-branch ref

  Wires `mergeAdvanceAutoSync` into the merger's post-ref-advance code path. After `advanceIntegrationBranchRef` ff-updates `refs/heads/<integrationBranch>`, the merger now enumerates other worktrees still on that branch (typically the user's project-root checkout) and reconciles each one's index + working tree to the new tip via `syncWorktreeToHead`.

  The reconciliation primitive is **not** a `git pull` — origin may still be at the previous tip (no `pushAfterMerge`), in which case `git pull --ff-only` is a no-op and a naive `stash → pull → pop` ends with the worktree restored to the old state. Instead `syncWorktreeToHead`:

  1. Diffs the worktree against the _previous_ tip to isolate real user edits from the stale-index "phantom diff" that looks like inverted commits.
  2. When the worktree is clean against the previous tip, runs `git reset --hard HEAD` to snap index + files forward.
  3. In `stash-and-ff` mode with real edits, captures them as a binary patch against the previous tip, snaps to HEAD, then `git apply --3way` to restore. Untracked files are copied to a temp dir and restored after the snap. Patch conflicts surface as `synced-with-pop-conflict` with the patch left on disk for manual recovery.

  Each per-worktree attempt emits a `merge:auto-sync` audit event (new `GitMutationType`) with the outcome; the per-step `pull:fast-forward`, `stash:push`, `stash:pop`, and `stash:pop-conflict` events that pass through the auditor are tagged `metadata.autoSync = true` so downstream consumers can attribute them.

  The user-facing effect: with the default `mergeAdvanceAutoSync: "stash-and-ff"`, after a Fusion task merges the user's `git status` in the project-root checkout becomes clean and the working tree shows the new commits' content — no manual `git reset` or Pull-button click required. Set `mergeAdvanceAutoSync: "off"` to restore the legacy behavior (the Merge Advance Notice banner still surfaces and the user pulls by hand).

  Backstopped by `merger-auto-sync.slow.test.ts` covering: clean-sync snaps both index and files forward, ff-only with real edits is a no-op, stash-and-ff preserves untracked local files across the snap, task worktrees on `fusion/fn-*` branches are correctly skipped, and an empty branch map emits nothing.

### @fusion/dashboard

#### Minor Changes

- 6e7f1e5: feat(dashboard): explain "Recent integration-branch advances" and add a one-click "Sync working tree" fix

  Two additions to Git Manager → Status:

  **Info disclosure** — an `[i]` button next to the "Recent integration-branch advances (N need action)" header toggles an inline explainer. Covers what an "advance" is, what each `autoSyncOutcome` value means (`clean-sync`, `synced-with-edits-restored`, `off / not run`, `stash-failed`, `would-conflict`, …), and where to enable `mergeAdvanceAutoSync` for the permanent fix.

  **Sync working tree button** — when ≥1 advance shows `needsAction`, a button surfaces in the same header that calls the existing `POST /api/git/pull` (FN-5358 Smart Pull machinery: auto-stash dirty edits, fast-forward pull, restore stash, surface conflicts). On success the extended git status auto-refetches and the "need action" count drops; on conflict, the existing error toast fires.

  No new state machine — `handlePull`/`remoteLoading === "pull"` is the same plumbing the existing Pull button uses.

- 85786e7: feat(dashboard): show extended integration-branch + working-tree state in Git Manager

  Repository Status panel now answers "what is the actual state of my project root vs the integration branch?" so operators can be sure of the picture even when the Merge Advance Notice banner has been dismissed.

  `GET /api/git/status` accepts a new `?extended=1` query and returns additional optional fields:

  - **integrationBranch** + **integrationBranchSource** — the canonical branch (resolved via `settings.integrationBranch` → legacy `baseBranch` → `origin/HEAD` → `main`) and where the value came from.
  - **integrationTipSha / originIntegrationTipSha** — SHAs at both ends, so operators can spot when local main has been advanced by the merger but origin/main hasn't caught up.
  - **aheadOfIntegration / behindIntegration** — HEAD vs local integration tip (useful when on a non-integration branch).
  - **aheadOfOriginIntegration / behindOriginIntegration** — local integration tip vs `origin/<branch>`.
  - **dirtyDetails** — staged/modified/untracked/conflicted counts + a 12-line porcelain sample.
  - **indexStaleVsHead** — true when the index reflects a previous tip and the worktree is clean against the index but not against HEAD. Surfaces the exact "phantom staged changes" scenario that `mergeAdvanceAutoSync` exists to fix.
  - **stashCount** — for at-a-glance recovery awareness.
  - **recentMergeAdvances** — up to 5 recent `merge:integration-ref-advance` audit events for the project root, joined with their `merge:auto-sync` outcomes; entries whose auto-sync didn't successfully bring this worktree forward are flagged `needsAction: true`.

  `GitManagerModal` now renders all of this:

  - The existing Branch / Commit / Working Tree / Remote Sync cards gain sub-text — Working Tree shows staged/modified/untracked/conflicted breakdown; Branch shows whether you're on the integration branch.
  - A second row of cards adds Integration branch (with resolution source + tip SHA), HEAD-vs-integration ahead/behind, local-integration-vs-origin ahead/behind, and stash count.
  - A yellow warning panel appears when `indexStaleVsHead` is true, telling the operator to enable `mergeAdvanceAutoSync` or run `git reset --hard HEAD`.
  - A "Recent integration-branch advances" list shows the last few merger advances with their per-advance auto-sync outcome, color-coded by whether they still need action.

  All `fetchGitStatus(projectId)` calls inside `GitManagerModal` now pass `{ extended: true }`. Other callers in the app are unaffected — the extra fields are optional and the un-extended response shape is unchanged.

#### Patch Changes

- 60a0012: fix(dashboard): stop main-chat and quick-chat composers from instantly dismissing the Android soft keyboard

  Two layered Android-specific fixes for the chat composers:

  1. The body scroll-lock applied while the keyboard is open in main chat was an iOS-specific workaround for visualViewport drift. On Android Chrome it does the opposite of what we want — mutating `body { position: fixed; ... }` while the keyboard is opening causes Chrome to treat it as a focus-target relayout and immediately dismisses the keyboard. `useMobileScrollLock` is now gated to iOS UAs.

  2. ChatView and QuickChatFAB both had an iOS-specific `onTouchStart` on the textarea that called `event.preventDefault()` and then programmatically refocused the input (to suppress iOS's visualViewport auto-scroll on re-focus). On Android, `preventDefault` on a textarea touchstart prevents the soft keyboard from opening — programmatic `focus()` alone does not raise the Android keyboard. Result: tapping the composer focused the input but the keyboard never appeared, looking like an instant dismiss. The touchstart workaround is now gated to iOS UAs via `isIOS()`.

- a10fc56: fix(dashboard): keep Android keyboard open in main chat; disable kanban pinch-zoom

  Two Android-specific fixes:

  1. **Keyboard dismissing in main chat.** `mobileKeyboardOpen` in `App.tsx` (derived from `useMobileKeyboard`) gates `project-content--with-mobile-nav` / `--with-footer` className assignment and MobileNavBar rendering. When the soft keyboard opened, those classes were removed and the nav unmounted, shrinking padding-bottom by ~80px in a single render. Android Chrome treats the resulting jump of the focused chat input as the focus target moving and instantly dismisses the keyboard. With `interactive-widget=resizes-content` set on Android, the layout viewport itself shrinks with the keyboard, so the hide-nav-on-keyboard behavior was redundant on Android (and harmful). The whole pattern is now gated to iOS via `isIOS()`. iOS path is unchanged.

  2. **Pinch-zoom on kanban.** Android Chrome ignores `user-scalable=no` for accessibility, and the kanban board's `overflow-x: auto` columns combined with the inflated ICB produce a broken visual when the user zooms out. Adds `touch-action: pan-x pan-y` to `html, body` inside the mobile media query, which keeps scroll panning but disables pinch-zoom (Chat and MissionManager were unaffected because they don't expose a wide horizontal scrollable region).

- de67c51: fix(dashboard): pull syncs the worktree to local integration tip, not just to origin

  The integration-mode `POST /api/git/pull` (used by the merge-advance-notice banner) only ran `git merge --ff-only origin/<branch>` after fetching. When the merger had advanced local `refs/heads/<integrationBranch>` via `update-ref` but the user hadn't pushed yet, the worktree's HEAD already resolved to the new sha (symbolic ref follow) but the working tree and index were still at the old state. The fast-forward step short-circuited (`already up to date with origin`) and the user saw "Pull completed" with `fromSha === toSha` while their files visibly stayed behind.

  Pull now explicitly resets the worktree to `refs/heads/<integrationBranch>` after the origin fast-forward step. The autostash above protects user edits, so the reset is safe regardless of whether the origin FF ran.

- 5d35b64: fix(dashboard): remove duplicate integration-advances UI; Sync working tree is now pure-local (no origin fetch)

  **Removed duplicate UI** — Git Manager → Status had two overlapping sections rendering the same data: a `Sync local tip` button + a `Recent integration advances` list, sitting above the highlighted `Recent integration-branch advances` block (the one with the lost-work warnings). Deleted the duplicate (`gm-integration-actions` + `gm-recent-advances`) along with the dead `mergeAdvanceEvents` state, fetcher, and SSE subscription that only fed it.

  **Sync working tree is now pure-local** — for the "N need action" case the merger has already advanced `refs/heads/<integration>` locally and the worktree just needs to follow. Previously the button called the integration-mode pull which ran `tryFastForwardFromOrigin` first, silently pulling in unrelated remote commits. New `skipOriginFetch` option on `PullGitBranchOptions.integration` (and the matching `POST /api/git/pull` body field) skips the origin step entirely. The Sync button passes `skipOriginFetch: true`, so the sequence is: auto-stash → `git reset --hard refs/heads/<integration>` → restore stash. Origin is not touched.

  Help disclosure updated to match the new behavior.

- 4f38ed1: fix(dashboard): clear `needs action` on recent integration-branch advances after manual sync

  The Git Manager's "Recent integration-branch advances" list derived `needsAction` purely from the original `merge:auto-sync` audit-event outcome. When the operator clicked "Sync working tree" — or fixed up the worktree by hand — the worktree caught up to the integration tip, but the list kept showing "(N need action)" because the historical audit events still recorded the original failure/disabled state.

  `collectRecentMergeAdvances` now also checks whether each advance's `toSha` is reachable from the current HEAD. If it is, the worktree already contains that advance and `needsAction` is false regardless of what the audit trail recorded.

- ef12df4: fix(dashboard): close 8 review findings on extended Git Manager status + Integration branch setting

  **Settings persistence (data-loss)** — the project-settings patch builder now applies null-as-delete to all non-model keys, matching the global-settings branch. Previously, clearing the Integration branch field (picking `(auto-detect)` or clicking `Use dropdown`) set `integrationBranch: undefined`, which `JSON.stringify` silently dropped — the server retained the stale explicit value and the operator could not un-pin the branch from the UI.

  **`isIndexStale` was wrong both directions** — the heuristic (`diff --cached --name-only` non-empty AND `diff --name-only` empty) fired false-positive on benign `git add` and false-negative whenever the worktree had any unrelated edit. Replaced with a reflog-anchored check: stale iff `refs/heads/<integrationBranch>@{1}` exists, HEAD is a descendant of it, and `git diff-index --cached <prevTip>` is empty (i.e. the index exactly matches the pre-advance state).

  **Auto-sync attribution** — two fixes to `collectRecentMergeAdvances` in `register-git-github.ts`:

  - Auto-sync events are now matched by `(taskId, newSha)` instead of `taskId`-only. A task that produced multiple advances over time no longer has all its older entries mislabeled with the most-recent outcome.
  - `worktreePath` comparison now runs both sides through `fs.realpathSync` first. On macOS the merger emits canonicalized paths (via `canonicalizePath` in `worktree-pool.ts`) while the route was called with the store's raw `rootDir`; symlinked project paths caused every advance to be marked `needsAction: true` indefinitely.

  **Extended path no longer 500s on git failure** — the `?extended=1` branch wraps `computeExtendedGitStatus` in its own try/catch and falls back to the basic status shape on any unhandled failure. Previously an unguarded `git branch --show-current` throw escaped to the route's outer catch and returned HTTP 500, while the basic path returned 200 with the swallowed-failure shape — surface parity matters because the dashboard always passes `extended=1` and would otherwise render an error toast where it should render the degraded panel. Also wrapped the same call inside `computeExtendedGitStatus` so detached-HEAD / non-git states return an empty `currentBranch` instead of throwing.

  **Integration branch falls back to `refs/remotes/origin/<branch>`** — when the configured branch exists only as a remote-tracking ref (e.g. operator set `integrationBranch: "release/v2"` without ever `git switch`-ing it locally), `integrationTipSha` now resolves to the origin tip instead of being null. A new `integrationTipSource: "local" | "remote-only" | "missing"` field tells the UI which side won; the Git Manager surfaces this with a `(remote-only — run git switch <branch> to track locally)` sub-text and a `no ref found` error state when both refs are missing.

  **Copy commit hash shows two buttons** — the Copy button now copies `status.commit` (the short SHA actually displayed in the `<code>` element). A second Copy-full button surfaces `status.headSha` for git operations that need the 40-char SHA. Previously the single button silently copied the full SHA when extended was on, so what the user saw on screen was no longer what they pasted.

  **Detached HEAD no longer shows misleading "(not on main)"** — `git branch --show-current` returns empty on detached HEAD; the route now leaves `isOnIntegrationBranch` as `undefined` (not `false`) in that case, and the UI's "(not on <branch>)" sub-text only renders when we know we're on a different branch — not when we're on no branch at all.

- d5cfa92: fix(dashboard): close 7 review findings on the extended-status hardening pass

  Follow-up to the prior fix commit; closes 7 more issues that an independent code review surfaced.

  **Settings inheritance regression (high)** — `SettingsModal.handleSave`'s non-model project branch lost the "only write if changed" gate when the prior commit added null-as-delete support. Result: every effective/inherited project key was being persisted as an explicit project override on every save, silently breaking inheritance across ~30+ keys. Restored the `value !== initialProjectValue` gate, matched against the model-lane branch's existing pattern.

  **Git Manager `Local <branch> vs origin` card showed misleading "Synced" in remote-only mode** — when `integrationTipSource === "remote-only"`, both `aheadOfOriginIntegration` / `behindOriginIntegration` are deliberately undefined (there's no local branch to compare), but the card's render fell through to `(ahead ?? 0) === 0 && (behind ?? 0) === 0 → "Synced"`. Now renders an explicit "no local tracking" sub-text in that case, with a separate `HEAD vs origin/<branch>` card surfacing a meaningful distance.

  **`isIndexStale` extended to multi-hop and gated to integration-branch worktrees** —

  - Walks up to 16 `refs/heads/<integration>` reflog entries so an A→B→C burst whose middle sync also missed is detected (the prior check only consulted `@{1}`).
  - Only fires when `isOnIntegrationBranch === true`. Previously, a feature-branch worktree whose HEAD happened to descend from `<integration>@{1}` (e.g. `git switch -c hotfix main@{N}`) would trip the stale-index warning despite being perfectly healthy.

  **`enumeration-failed` auto-sync events no longer dropped** — the new `(taskId, newSha)` join filter required both `worktreePath` and `newSha` on every auto-sync event, which discarded the merger's early-failure events that emit neither. Now: events with both fields use the per-advance pair-key (with macOS realpath canonicalization on both sides); events with neither use a task-id fallback so the diagnostic outcome still surfaces on the matching advance.

  **`aheadOfIntegration` no longer silently shifts semantics** — split into three distinct distance fields so consumers don't have to read `integrationTipSource` to know which comparison they got:

  - `aheadOfIntegration` / `behindIntegration` — HEAD vs **local** integration tip; undefined when only the remote tip exists.
  - `aheadOfIntegrationRemote` / `behindIntegrationRemote` — HEAD vs `origin/<integrationBranch>`; defined whenever the remote tracking ref exists.
  - `aheadOfOriginIntegration` / `behindOriginIntegration` — local integration tip vs `origin/<integrationBranch>`; defined only when both refs exist.

  **`currentBranch` failure no longer masks wrong-branch state** — `git branch --show-current` returns empty on detached HEAD (success) and throws on transient git errors (lock contention, timeout). The prior catch collapsed both into `currentBranch = ""` so the UI couldn't distinguish them. New `currentBranchDetectionFailed?: boolean` field on `GitStatus` lets the UI surface "branch detection unavailable" on a real failure rather than silently hiding the wrong-branch warning.

- 916047c: feat(dashboard): Integration branch setting is now a dropdown of local branches with Custom… fallback

  Replaces the plain text input with a `<select>` that lists the project's local branches (loaded via `fetchGitBranches` when the Merge section becomes visible) plus an `(auto-detect — origin/HEAD → main)` default and a `Custom…` option for branches that don't exist locally yet.

  Branch list is deduplicated and sorted with common integration names (`main`, `master`, `trunk`, `develop`) pinned to the top so the typical case is one click. Choosing `Custom…` swaps in a text input with a `Use dropdown` link to revert.

  A previously-saved value that isn't in the loaded list (e.g. branch deleted locally, or initial load before branches fetch resolved) falls through to the custom text input automatically so the operator can still see and edit it.

- 084bdc6: feat(dashboard): expose `integrationBranch` setting in the project settings modal

  Adds a text input for the canonical integration branch (the branch Fusion merges tasks into, and the reference for all ahead/behind / overlap / pre-rebase computations). Lives directly under the Auto-completion mode select inside the merge-strategy panel — visible regardless of direct vs PR mode, since the setting applies to both.

  Blank value (the default) preserves the existing auto-resolution cascade: `integrationBranch` → legacy `baseBranch` → `origin/HEAD` symbolic ref → fallback `main`. Setting it to `master` / `trunk` / `develop` / etc. pins the resolution explicitly without changing other settings.

  Field trims whitespace and stores `undefined` (not empty string) when cleared so the auto-resolution remains active.

- d8493f9: feat(dashboard): expose `mergeAdvanceAutoSync` in the project settings modal

  Adds the missing form control for the auto-sync mode introduced by the merger hook. Lives next to the existing Direct merge commit routing / Integration worktree controls inside the merge-strategy panel and only renders when `mergeStrategy === "direct"`. Three options with the same labels and descriptions as `docs/settings-reference.md`:

  - **Stash + fast-forward (default)** — preserve local edits across the auto-snap
  - **Fast-forward only** — skip dirty worktrees, surface the banner instead
  - **Off** — legacy behavior, project root stays stale until manual pull

  Value is normalized through `normalizeMergeAdvanceAutoSyncMode` on both the merged-settings and scoped-settings load paths so a missing/invalid stored value cleanly falls back to the default without spamming validation errors.

- 99359b6: fix(dashboard): unbreak Merge Advance Notice banner dismiss and suppress when auto-sync already handled it

  Two bugs were keeping the banner stuck on screen even when there was nothing for the user to do:

  - **Dismiss was dead.** The `notice` memo never applied `dismissedShas`, so clicking the close button (or a successful Pull, which calls `dismiss()` after the API returns) updated localStorage but the same advance event kept matching the filter and the banner re-rendered immediately.
  - **Auto-sync success was ignored.** With the new `mergeAdvanceAutoSync` setting at its `stash-and-ff` default, the merger snaps the project-root checkout forward as part of the merge — there is nothing left to pull. The banner kept appearing anyway because the route's `autoSync` payload wasn't consulted. Clicking Pull then hit `/api/git/pull`, which fetched origin (no change, since the merger only advanced the local ref) and returned `pull-clean` with no actual work done.

  The `notice` memo now (a) filters out `dismissedShas`, and (b) suppresses any advance event whose `autoSync` entry for the _current user's_ `worktreePath` reports `clean-sync` or `synced-with-edits-restored`. Conflict and skipped outcomes (`synced-with-pop-conflict`, `skipped-dirty`, `skipped-*`, `failed`) still surface the banner so the user can recover.

  Banner suppression checks the per-worktree path, so a multi-checkout project where auto-sync handled one root and a sibling root is still stale will keep showing the banner on the stale one.

- 6083de2: fix(dashboard): unbreak Merge Advance Notice banner by preserving store `this` binding in events endpoint

  `GET /api/tasks/merge-advance-events` was extracting `getRunAuditEvents` off the scoped store as a bare function reference and calling it without `this`, which made `this.db.prepare(...)` throw "Cannot read properties of undefined (reading 'db')" on every request. The `useMergeAdvanceNotice` hook caught the failure silently (`catch { setEvents([]) }`), so the banner never appeared even after the merger advanced the integration branch ref.

  Fix: keep the store reference and call `storeWithRunAudit.getRunAuditEvents(...)` as a method so `this` is preserved, matching the pattern used by other routes that read run-audit events.

- dc94494: fix(engine,dashboard): close 7 code-review findings on the mergeAdvanceAutoSync hook

  Tightens the freshly-landed merger auto-sync feature based on a structured code review.

  **Data-loss fixes in `syncWorktreeToHead`:**

  - Untracked-file restore now compares against `git ls-tree -r --name-only HEAD` to detect when the new tip introduced a tracked file at the same path; collisions are reported in `untrackedSkippedAsTracked` and the user's bytes stay in the stage dir instead of clobbering the merged content.
  - When `git apply --3way` fails because a patched file was deleted/renamed at the new tip (`--diff-filter=U` returns nothing because nothing got staged), `conflictedFiles` falls back to parsing `diff --git a/<p> b/<p>` headers out of the captured patch — so the conflict surfaces with the right file names instead of `[]`.
  - `git ls-files` / `diff` calls now pass `-c core.quotePath=false` so paths with non-ASCII or special characters round-trip through `copyFileSync` instead of failing on backslash-escaped octal tokens.
  - The stash-and-ff path re-verifies `rev-parse HEAD === newSha` immediately before each destructive `reset --hard HEAD`; a concurrent merger advance now bails with `skipped-head-not-at-new-sha` (with the captured patch preserved on disk) instead of applying the patch against the wrong tree.
  - The stage dir is now tracked with a `preserveStageDir` flag in a `try/finally`: it is rm'd on all clean paths and on `skipped-head-not-at-new-sha` exits, but preserved whenever the user's edits live only in `patchPath` (pop-conflict, untracked-collides-with-tracked, reset failure, outer exception).
  - Patch is written to disk before the apply attempt, not only on failure, so a crash between snapshot and apply doesn't lose the user's edits.

  **Multi-worktree-same-branch fix:**

  - New `getRegisteredWorktreeBranches` helper in `worktree-pool.ts` returns ALL `(branch, worktreePath)` entries rather than collapsing duplicates into a `Map<branch, path>`. Multiple worktrees can legitimately share a branch when the user created secondary checkouts via `git worktree add --force -b`; the merger now syncs every one of them instead of silently skipping all but the last.

  **Contract + surfacing fixes:**

  - JSDoc on `merge:auto-sync` GitMutationType now documents the actually-emitted outcome strings (`clean-sync`, `synced-with-edits-restored`, `synced-with-pop-conflict`, `skipped-*`, `failed`, `enumeration-failed`, `exception`) and the actual `stage` enum, replacing the obsolete `smartPull`-shaped strings.
  - `GET /api/tasks/merge-advance-events` now joins `merge:auto-sync` events within a ±5min window of each advance and returns them in a new `autoSync: AutoSyncOutcome[]` field; `useMergeAdvanceNotice` exposes the same shape so the banner can surface pop-conflicts (including `patchPath` pointing at the user's saved edits) instead of leaving them in a black hole.

  **Hygiene:**

  - Merger's setting read now uses `normalizeMergeAdvanceAutoSyncMode(settings.mergeAdvanceAutoSync)` (the exported normalizer) instead of an inline equality check + `as unknown` cast that bypassed type-checking.

  **New backstop tests** in `merger-auto-sync.slow.test.ts`:

  - Untracked file colliding with a newly-tracked path is NOT overwritten and the merged content survives.
  - `git apply --3way` failure on a file deleted at the new tip populates `conflictedFiles` from the patch header.

  **Route test** asserts `autoSync` outcomes are joined onto the matching advance event within the time window.

- e138289: fix(dashboard): compensate Android Chrome inflated ICB for fixed-position UI

  Android Chrome (multi-window / split-screen / certain WebView configs) can leave the initial containing block (window.innerWidth/Height) stuck larger than the actual rendered canvas — DOM, body, and visualViewport report the true dimensions, but `position: fixed` uses the ICB, pinning fixed-bottom elements off the bottom of the visible viewport. JS-side meta override (both setAttribute and full element replacement) does not force Chrome to recompute the ICB on these builds.

  Instead, publish the ICB→visualViewport delta as CSS variables (`--icb-bottom-offset`, `--icb-right-offset`) on `<html>` and consume them in `MobileNavBar` and `ExecutorStatusBar` so they pin to the visible viewport edge regardless of ICB drift. The math also handles pinch-zoom in (offsets compensate) and pinch-zoom out (offsets clamp at 0). Healthy browsers see 0px and behave unchanged.

- 76429a8: fix(dashboard): keep mobile nav bar pinned to page bottom when keyboard opens

  The mobile nav bar's `bottom` defaults to `var(--icb-bottom-offset)`, which on iOS equals the soft-keyboard height once it opens — floating the bar above the keyboard. The existing `.mobile-nav-bar--keyboard-open` override (which pins `bottom: 0`) was only applied when `!modalManager.anyModalOpen && isIOS()`, so the bar still tracked the keyboard with a modal open. Introduces `mobileNavKeyboardOpen = isMobile && keyboardOpen` as a nav-bar-only flag so the bar stays pinned in all keyboard cases. Content padding and ExecutorStatusBar remain on the gated `mobileKeyboardOpen` to preserve their existing behavior.

- ed4d021: fix(dashboard): keep mobile nav visible on Android in landscape and when keyboard opens

  - Broaden mobile media query to `(max-width: 768px), (max-height: 480px)` so phones held in landscape (which exceed 768 CSS px wide) still render the bottom nav and mobile board layout instead of the desktop horizontally-scrollable columns.
  - Distinguish pinch-zoom from keyboard-open in `useMobileKeyboard` by checking `visualViewport.scale > 1` — Android Chrome ignores `user-scalable=no` for a11y, and a zoomed-in textarea was false-positiving keyboard-open and hiding `MobileNavBar`.
  - Use `documentElement.clientHeight` instead of stale `window.innerHeight` when computing keyboard overlap (Android multi-window can leave `innerHeight` cached at a wildly different value than the actual layout viewport).
  - Add `interactive-widget=resizes-content` to the viewport meta so Android Chrome shrinks the layout viewport with the soft keyboard, matching iOS behavior.

- Updated dependencies [98033bc]
- Updated dependencies [db9928a]
- Updated dependencies [02971ef]
- Updated dependencies [9ce26ee]
- Updated dependencies [e708870]
- Updated dependencies [a3ec2e5]
- Updated dependencies [408e20b]
- Updated dependencies [acf3502]
- Updated dependencies [ec6643e]
- Updated dependencies [a201f56]
- Updated dependencies [4c31e88]
- Updated dependencies [dc94494]
- Updated dependencies [bf4428c]
- Updated dependencies [0c0839e]
- Updated dependencies [ec1269f]
- Updated dependencies [51fc826]
- Updated dependencies [d02cd38]
  - @fusion/engine@0.33.0
  - @fusion/core@0.33.0
  - @fusion-plugin-examples/cli-printing-press@0.1.10
  - @fusion-plugin-examples/dependency-graph@0.1.24
  - @fusion-plugin-examples/roadmap@0.1.12
  - @fusion-plugin-examples/cursor-runtime@0.1.12
  - @fusion-plugin-examples/droid-runtime@0.1.19
  - @fusion-plugin-examples/hermes-runtime@0.2.43
  - @fusion-plugin-examples/openclaw-runtime@0.2.43
  - @fusion-plugin-examples/paperclip-runtime@0.2.43

### @fusion/desktop

#### Patch Changes

- Updated dependencies [60a0012]
- Updated dependencies [a10fc56]
- Updated dependencies [de67c51]
- Updated dependencies [6e7f1e5]
- Updated dependencies [5d35b64]
- Updated dependencies [408e20b]
- Updated dependencies [4f38ed1]
- Updated dependencies [ec6643e]
- Updated dependencies [85786e7]
- Updated dependencies [ef12df4]
- Updated dependencies [d5cfa92]
- Updated dependencies [916047c]
- Updated dependencies [084bdc6]
- Updated dependencies [a201f56]
- Updated dependencies [d8493f9]
- Updated dependencies [99359b6]
- Updated dependencies [6083de2]
- Updated dependencies [4c31e88]
- Updated dependencies [dc94494]
- Updated dependencies [e138289]
- Updated dependencies [76429a8]
- Updated dependencies [ed4d021]
- Updated dependencies [51fc826]
  - @fusion/dashboard@0.33.0
  - @fusion/core@0.33.0

### @fusion/engine

#### Minor Changes

- 98033bc: feat(engine): guard one engine per project per machine

  Adds a per-machine singleton lock that engages before each engine
  starts, preventing two `fn` dashboard processes from running engines
  for the same project on the same host (a scenario that previously
  caused worktree corruption and task-state races for in-process
  projects).

  The guard combines two independent checks:

  - A `proper-lockfile`-backed file at `<project>/.fusion/engine.lock`
    with stale-lock recovery.
  - A loopback listener (UDS on POSIX, named pipe on Windows) on a
    hashed per-project address.

  Failures throw `EngineAlreadyRunningError`; both guards are released
  on `stopAll()` / `pauseProject()`.

- db9928a: feat(engine): export `smartPull()` library for stash-aware fast-forward of a worktree

  Standalone stash → fast-forward → pop implementation that the merger's upcoming `mergeAdvanceAutoSync` hook calls after advancing the integration-branch ref to auto-sync other worktrees still pinned at the previous tip. Returns a discriminated union (`clean-pull | stash-pull-pop | stash-pop-conflict | skipped-dirty | skipped-not-on-branch | failed`) and accepts an optional audit emitter so callers can record `pull:fast-forward`, `stash:push`, `stash:pop`, and `stash:pop-conflict` run-audit events.

  The dashboard's user-triggered Pull continues to use the existing `POST /api/git/pull` integration path (which runs the AI-aware autostash through `restoreUnrelatedRootDirChanges`) and is unchanged by this changeset — `smartPull()` is intentionally simpler so the merger's post-advance auto-sync stays free of mid-merge AI conflict resolution.

- 4c31e88: feat(engine): merger auto-syncs project-root checkout after advancing integration-branch ref

  Wires `mergeAdvanceAutoSync` into the merger's post-ref-advance code path. After `advanceIntegrationBranchRef` ff-updates `refs/heads/<integrationBranch>`, the merger now enumerates other worktrees still on that branch (typically the user's project-root checkout) and reconciles each one's index + working tree to the new tip via `syncWorktreeToHead`.

  The reconciliation primitive is **not** a `git pull` — origin may still be at the previous tip (no `pushAfterMerge`), in which case `git pull --ff-only` is a no-op and a naive `stash → pull → pop` ends with the worktree restored to the old state. Instead `syncWorktreeToHead`:

  1. Diffs the worktree against the _previous_ tip to isolate real user edits from the stale-index "phantom diff" that looks like inverted commits.
  2. When the worktree is clean against the previous tip, runs `git reset --hard HEAD` to snap index + files forward.
  3. In `stash-and-ff` mode with real edits, captures them as a binary patch against the previous tip, snaps to HEAD, then `git apply --3way` to restore. Untracked files are copied to a temp dir and restored after the snap. Patch conflicts surface as `synced-with-pop-conflict` with the patch left on disk for manual recovery.

  Each per-worktree attempt emits a `merge:auto-sync` audit event (new `GitMutationType`) with the outcome; the per-step `pull:fast-forward`, `stash:push`, `stash:pop`, and `stash:pop-conflict` events that pass through the auditor are tagged `metadata.autoSync = true` so downstream consumers can attribute them.

  The user-facing effect: with the default `mergeAdvanceAutoSync: "stash-and-ff"`, after a Fusion task merges the user's `git status` in the project-root checkout becomes clean and the working tree shows the new commits' content — no manual `git reset` or Pull-button click required. Set `mergeAdvanceAutoSync: "off"` to restore the legacy behavior (the Merge Advance Notice banner still surfaces and the user pulls by hand).

  Backstopped by `merger-auto-sync.slow.test.ts` covering: clean-sync snaps both index and files forward, ff-only with real edits is a no-op, stash-and-ff preserves untracked local files across the snap, task worktrees on `fusion/fn-*` branches are correctly skipped, and an empty branch map emits nothing.

- 51fc826: fix(engine,core): dedup heartbeat-spawned follow-ups by parent task

  Heartbeat agents create follow-up tasks via `fn_task_create`. Until
  now, the intake similarity guard scoped candidates by `sourceAgentId`
  only, so the same parent task could spawn many sibling tasks across
  heartbeats whenever triage rewrote their titles enough to dodge the
  title-fingerprint guard.

  The task-scoped heartbeat now stamps `sourceParentTaskId` (and
  `sourceRunId`) on every `fn_task_create`, and the intake duplicate
  matcher treats a candidate as a sibling when it shares either the
  caller's agent ID or the caller's parent task ID. Same-parent
  siblings with similar descriptions are auto-archived as before.

  Tool description and heartbeat prompts also now instruct agents to
  scan existing open tasks before creating, as a belt-and-suspenders
  layer above the deterministic dedup.

- d02cd38: feat(merger): scope pnpm verification to changed packages and short-circuit out-of-scope fix loop

  In a pnpm workspace, inferDefaultTestCommand now derives the set of packages touched by the branch diff and emits `pnpm --filter "<pkg>...^" test` instead of `pnpm test`. This prevents flakes in unrelated packages from blocking merges. When git context is unavailable or changes are root-only, the command falls back to the unscoped `pnpm test`.

  When the in-merge fix agent makes no changes and all failing test files are outside the branch's diff, the merger now marks the task `status: "failed"` immediately with a clear "out-of-scope flake" message rather than retrying into the limbo-recovery cycle.

#### Patch Changes

- 02971ef: fix(engine): treat foreign-attributed commits already on main as promoted

  `assertCleanBranchAtBase` flagged any commit in `baseSha..branchName`
  whose `Fusion-Task-Id` trailer pointed at a different task as
  contamination. That misclassified the FN-5475 cascade: the engine
  fast-forwards local `main` with single-parent task commits, and any
  worktree created during the brief window where local `main` carried a
  sibling task's tip inherited that commit. The audit later (correctly)
  saw the commit as not-yet-on-main from its merge-base perspective and
  threw `BranchCrossContaminationError`.

  The audit now skips foreign-attributed commits that are reachable from
  local `main` (`git merge-base --is-ancestor <sha> main`). Commits on
  main were promoted through integration regardless of whose trailer
  they carry, and downstream branches that inherited them via main are
  not contaminated.

  Resume verifier (FN-5475 fix #2) and the auto-recovery handler
  fallback (FN-5475 fix #3) remain in place as defense-in-depth for
  the rarer variants (local main rewound, foreign commit not yet on
  main when the audit fires).

- 9ce26ee: fix(engine): un-deadcode the bootstrap-misbinding auto-recovery fallback

  The auto-recovery handler in `auto-recovery-handlers/branch-worktree.ts`
  called `classifyBootstrapMisbinding` with `foreignCommits: []` because it
  had no `BranchCrossContaminationError` in hand (it discovers the conflict
  via `inspectBranchConflict`). The classifier's predicate gated on
  `foreignCommits.length > 0`, so the input always resolved to
  `isBootstrapMisbinding: false` and the re-anchor block was effectively
  dead code.

  The handler also used `ctx.task.baseCommitSha` as the contamination base,
  which is deliberately preserved across sessions for diff math (FN-4417)
  and can lag local `main` by many commits — causing legitimately-merged
  landings to be classified as foreign at this layer.

  Changes:

  - `classifyBootstrapMisbinding` now derives the foreign-commit count from
    its own `git log baseSha..branchName` walk; `input.foreignCommits` is
    optional and advisory only. The result type gains `foreignCommitCount`.
  - The `branch-worktree` recovery handler stops passing an empty array and
    computes a fresh merge-base against local `main` (falling back to
    `origin/main`), mirroring the executor's primary contamination path.
  - Regression tests cover both the no-`foreignCommits` call shape and the
    `foreignCommitCount` field.

- e708870: fix(engine): verify resumed worktree branches aren't bootstrap-misbound

  `acquireTaskWorktree` short-circuited the resume path when
  `task.worktree` existed on disk and classified `ok`, handing the
  worktree back to the executor without inspecting its branch history.
  If the branch had been created from a poisoned local-main tip (a
  sibling task's commit), the executor preflight would later flag every
  intermediate landing as foreign and the task would loop through
  contamination recovery until pausing for human adjudication
  (observed in the FN-5475 cascade).

  The resume path now computes a fresh merge-base against local `main`
  (falling back to `origin/main`) and runs `classifyBootstrapMisbinding`
  on the branch. When the range is purely foreign with zero own commits,
  it re-anchors the branch inline via `reanchorBranchToBase` and emits a
  `branch:reanchor` audit event with `trigger: "resume-misbinding"`.

  Mixed contamination (own + foreign, or non-attributed commits) is
  deliberately left to the executor's existing primary path so the
  richer adjudication flow still applies.

- a3ec2e5: fix(engine): never create task branches from arbitrary HEAD in autocorrect

  `attemptBranchAutocorrect` previously fell back to `git checkout -B
<expected>` with no start point when rename was not applicable. If the
  worktree's HEAD happened to be at a previous occupant's commit (e.g. an
  orphaned tip from a different task), the new branch label silently
  captured that commit — the "branch: Created from HEAD" contamination
  pattern that the cross-contamination guard then refuses to auto-resolve.

  This is the only branch-creation site in the engine that did not thread
  a resolved base SHA; every other path (`prepareForTask`,
  `reanchorBranchToBase`) already passes the base explicitly.

  Autocorrect now verifies the expected ref exists and uses a plain
  `git checkout`, so it can only _switch to_ an already-existing branch.
  When the ref is missing it returns `failed`, letting upstream recovery
  (which knows the proper base) re-anchor with `prepareForTask` /
  `reanchorBranchToBase`.

- 408e20b: fix(merger): two root-cause fixes for tasks landing in Done with no commit on main

  **Bug 1: sibling fusion/fn-\* branch as merge target** — `resolveTaskMergeTarget`
  previously returned `task.baseBranch` unconditionally before falling back to the
  project default. When a task was dispatched as a sibling/dependent off another
  in-flight task's worktree, `baseBranch` ended up as the upstream's
  `fusion/fn-<id>` branch. The merger then detached onto that sibling, squashed
  on top of it, and advanced `refs/heads/fusion/fn-<id>` — never main. FN-5233's
  squash (`84563e549`) stranded on `fusion/fn-5339`; FN-5530's
  (`4140a3e0a`) stranded on `fusion/fn-5543`. The resolver now refuses any
  `fusion/fn-\*` candidate as a merge destination and falls through to the
  project default. The merger emits a new `merge:merge-target-rejected-fusion-sibling`
  audit event so the upstream `baseBranch`-propagation bug stays observable.

  **Bug 2: deadlock-recovery mis-attributed tasks to unrelated commits** —
  `findLandedTaskCommit` step (4) used `git log --grep=FN-XXXX` which matches the
  entire commit message (not just the subject) and blindly accepted the first
  hit. FN-5441 and FN-5446 were both marked done against `e3dbfaae` — an
  FN-5483 commit whose body merely _mentioned_ them by name in a paragraph about
  a refusal. The grep fallback now fetches each candidate's body and re-verifies
  ownership via a tightened `commitOwnedByTask`: trailers must be line-anchored
  (`(?:^|\n)Fusion-Task-Id: <id>(?:\n|$)`), and the subject fallback must match
  a conventional-commit form (`<type>(<id>):` or `<id>:`), not a substring.
  Prose mentions can no longer claim a task.

  The historical recovery for FN-5233 has been cherry-picked to main as
  `2d2e5b809`. The other 11 affected tasks (FN-5441, FN-5446, FN-5472, FN-5484,
  FN-5487, FN-5490, FN-5515, FN-5517, FN-5526, FN-5539, FN-5540, FN-5542)
  remain in Done but need separate triage — 3 look like legitimate
  verification-only no-ops, the remaining 9 likely lost real work.

- acf3502: fix(merger): refuse to finalize a task as no-op when modifiedFiles is non-empty

  Third root-cause fix for tasks marked Done with no commit on main (the first
  two — sibling-branch merge target + grep mis-attribution — landed in the
  previous commit). When the executor produced edits but the squash didn't
  land them as a commit (uncommitted in the worktree, squashed against the
  wrong branch, branch dropped by reuse-handoff churn, etc.), the merger's
  `classifyOwnedLandedEvidence` would return `proven-no-op` or
  `no-changes-finalized` and both `aiMergeTask` and `recoverNoOpReviewTasks`
  would happily move the task to Done while clearing `modifiedFiles` to `[]`
  — silently destroying the audit trail of what was lost.

  Both call sites now gate the no-op finalize on `task.modifiedFiles.length`:
  if the task claims work was done but no commit landed, move the task back
  to `todo` with progress preserved and emit a new
  `task:finalize-lost-work-blocked` audit event. The next executor run
  re-attempts the work; the operator sees the audit event in the run-audit
  timeline.

  The post-hoc `reconcileDoneTaskIntegrity` path is intentionally NOT gated —
  it cleans up tasks that are already in Done (legacy state), which is
  out-of-scope for the lost-work prevention. This matters: 9 lost-work tasks
  were already in this state at sweep time (FN-5441, FN-5446, FN-5487,
  FN-5490, FN-5517, FN-5526, FN-5539, FN-5540, FN-5542) and need to be
  re-spec'd as fresh tasks rather than auto-reconciled. See
  `docs/incidents/2026-05-23-lost-work-tasks.md` for the per-task catalog.

- dc94494: fix(engine,dashboard): close 7 code-review findings on the mergeAdvanceAutoSync hook

  Tightens the freshly-landed merger auto-sync feature based on a structured code review.

  **Data-loss fixes in `syncWorktreeToHead`:**

  - Untracked-file restore now compares against `git ls-tree -r --name-only HEAD` to detect when the new tip introduced a tracked file at the same path; collisions are reported in `untrackedSkippedAsTracked` and the user's bytes stay in the stage dir instead of clobbering the merged content.
  - When `git apply --3way` fails because a patched file was deleted/renamed at the new tip (`--diff-filter=U` returns nothing because nothing got staged), `conflictedFiles` falls back to parsing `diff --git a/<p> b/<p>` headers out of the captured patch — so the conflict surfaces with the right file names instead of `[]`.
  - `git ls-files` / `diff` calls now pass `-c core.quotePath=false` so paths with non-ASCII or special characters round-trip through `copyFileSync` instead of failing on backslash-escaped octal tokens.
  - The stash-and-ff path re-verifies `rev-parse HEAD === newSha` immediately before each destructive `reset --hard HEAD`; a concurrent merger advance now bails with `skipped-head-not-at-new-sha` (with the captured patch preserved on disk) instead of applying the patch against the wrong tree.
  - The stage dir is now tracked with a `preserveStageDir` flag in a `try/finally`: it is rm'd on all clean paths and on `skipped-head-not-at-new-sha` exits, but preserved whenever the user's edits live only in `patchPath` (pop-conflict, untracked-collides-with-tracked, reset failure, outer exception).
  - Patch is written to disk before the apply attempt, not only on failure, so a crash between snapshot and apply doesn't lose the user's edits.

  **Multi-worktree-same-branch fix:**

  - New `getRegisteredWorktreeBranches` helper in `worktree-pool.ts` returns ALL `(branch, worktreePath)` entries rather than collapsing duplicates into a `Map<branch, path>`. Multiple worktrees can legitimately share a branch when the user created secondary checkouts via `git worktree add --force -b`; the merger now syncs every one of them instead of silently skipping all but the last.

  **Contract + surfacing fixes:**

  - JSDoc on `merge:auto-sync` GitMutationType now documents the actually-emitted outcome strings (`clean-sync`, `synced-with-edits-restored`, `synced-with-pop-conflict`, `skipped-*`, `failed`, `enumeration-failed`, `exception`) and the actual `stage` enum, replacing the obsolete `smartPull`-shaped strings.
  - `GET /api/tasks/merge-advance-events` now joins `merge:auto-sync` events within a ±5min window of each advance and returns them in a new `autoSync: AutoSyncOutcome[]` field; `useMergeAdvanceNotice` exposes the same shape so the banner can surface pop-conflicts (including `patchPath` pointing at the user's saved edits) instead of leaving them in a black hole.

  **Hygiene:**

  - Merger's setting read now uses `normalizeMergeAdvanceAutoSyncMode(settings.mergeAdvanceAutoSync)` (the exported normalizer) instead of an inline equality check + `as unknown` cast that bypassed type-checking.

  **New backstop tests** in `merger-auto-sync.slow.test.ts`:

  - Untracked file colliding with a newly-tracked path is NOT overwritten and the merged content survives.
  - `git apply --3way` failure on a file deleted at the new tip populates `conflictedFiles` from the patch header.

  **Route test** asserts `autoSync` outcomes are joined onto the matching advance event within the time window.

- bf4428c: fix(merger): require fast-forward ref advances and read integration tip from refs/heads/&lt;branch&gt;

  Closes a class of "orphaned merge" bug where a subsequent merger could overwrite the integration branch tip with a sibling commit, leaving the previous squash reachable only from a feature branch.

  Two coupled fixes:

  1. `advanceIntegrationBranchRef` now refuses non-fast-forward advances. The CAS check still guards against concurrent ref movement, but the new `merge-base --is-ancestor` check additionally requires the new sha to descend from the expected current sha. Non-FF attempts return `reason: "non-fast-forward-advance"` instead of silently orphaning the prior tip.

  2. `runMerge` resolves the integration-branch tip via `git rev-parse --verify refs/heads/<integrationBranch>` instead of `git rev-parse HEAD` in `rootDir`. In reuse-task-worktree mode, `rootDir`'s HEAD can lag behind the shared ref after a sibling merger advanced it via `update-ref` without re-checking-out — using HEAD there caused the eventual squash commit to parent off an earlier sha and orphan the previously-merged tip.

  Together these uphold the invariant: local `<integrationBranch>` only advances via fast-forward, and the merger never builds a squash off a stale base sha.

- 0c0839e: fix(merger): treat non-FF ref-advance as concurrent-advance so it triggers retry

  When the merger's squash commit was built off a stale integration tip (integration moved between squash prep and `update-ref`), the FF guard in `advanceIntegrationBranchRef` correctly refused the swap with reason `non-fast-forward-advance` — but the caller in `merger.ts` only mapped `concurrent-advance` to `IntegrationBranchConcurrentAdvanceError`. The non-FF case fell through as a plain `Error`, failing the task instead of routing to the FN-4500/FN-5083 rebind/retry path. Both reasons share a root cause (integration tip moved during the merge window), so they now share the retry path. Observed on FN-5576.

- ec1269f: feat(merger): auto-rehome FF-recoverable orphan commits during contamination recovery

  Follow-up to the FF-only ref advance fix: contamination recovery now classifies a fourth bucket — `orphan-our-advance` — and fast-forwards the integration branch onto pre-fix orphan commits when safe.

  When the executor's contamination handler sees a "unique" foreign commit, it now also asks:

  - Does the commit's `Fusion-Task-Id` trailer point at a `done` task?
  - Is the commit unreachable from `refs/heads/<integrationBranch>`?

  If both, the commit is an orphan from the pre-fix non-FF ref-advance bug. Recovery attempts to fast-forward the integration branch onto the orphan:

  - **FF possible** (integration tip is an ancestor of the orphan): advance via `advanceIntegrationBranchRef`, then drop the orphan from the task branch alongside `already-upstream` commits. Emits `merger:orphan-rehome-ff`.
  - **Non-FF** (orphan diverges from integration tip — would require cherry-pick): refuse to auto-rehome. The commit stays in `genuinelyUnique` for human adjudication, but the recovery log line now includes the exact `git cherry-pick <sha>` command an operator can run to unstick it. Emits `merger:orphan-rehome-refused`.

  The non-FF refusal is intentional: cherry-pick into the integration branch from inside automated recovery introduces conflict-resolution surface that's too high blast radius for a never-event recovery path.

- Updated dependencies [408e20b]
- Updated dependencies [ec6643e]
- Updated dependencies [a201f56]
- Updated dependencies [4c31e88]
- Updated dependencies [51fc826]
  - @fusion/core@0.33.0
  - @fusion/pi-claude-cli@0.33.0

### @fusion/plugin-sdk

#### Patch Changes

- Updated dependencies [408e20b]
- Updated dependencies [ec6643e]
- Updated dependencies [a201f56]
- Updated dependencies [4c31e88]
- Updated dependencies [51fc826]
  - @fusion/core@0.33.0

### @runfusion/fusion

#### Minor Changes

- 1b49cbc: Surface SQLite corruption in notifications, the dashboard health API, and a persistent dashboard banner.
- 2baaad7: `fn backup` now also snapshots the central database (`~/.fusion/fusion-central.db`)
  alongside the per-project database. Scheduled and manual backups produce a paired
  `fusion-central-<timestamp>.db` file in `.fusion/backups/`; `fn backup --list`,
  `--cleanup`, and `--restore` operate on the pair. Restoring a `fusion-central-*`
  file restores only the central DB. A missing central DB is skipped silently and
  does not fail the project backup.
- b12ff26: Saving an opencode or opencode-go API key from the dashboard now immediately refreshes the opencode-go model catalog (no restart required), reports how many models were registered, and surfaces actionable errors when the local `opencode` CLI is missing or returns no models. `opencode-go` is now always listed as an API-key target in Settings, even before models are registered.
- 8a3afcf: feat(executor+engine-tests): preflight premise-stale exit and serialize reliability-interactions

  - Executor: teach the system prompt a Preflight escape hatch. When Step 0 reproduces the issue described in PROMPT.md and finds the work is already done (HEAD matches the desired state), the agent now marks Step 0 done, marks remaining steps `skipped`, and calls `fn_task_done` with a `PREMISE STALE: …` summary. Skipped steps already pass `evaluateTaskDoneRefusal`, and the merger's empty-own-diff fast-path auto-finalizes the zero-diff branch — no new tool or refusal class is needed. This stops the executor from looping through plan/review/test/doc when PROMPT.md is out of sync with HEAD (the failure mode that exhausted FN-5521 across four worktrees).

  - Engine vitest: split `packages/engine/vitest.config.ts` into two projects. `engine-default` keeps the full-parallelism layout for the bulk of the suite; `engine-reliability` scopes `src/__tests__/reliability-interactions/**` to `poolOptions.threads.singleThread: true` so the contention-sensitive event-ordering assertions (e.g. `merge-reuse-task-worktree`'s newest-first audit ordering check) no longer flake under workspace-concurrent merge-gate runs. Within-file order was already linear; this only removes inter-file parallelism for ~99 files that always shared a single git/SQLite contention surface.

- e291d86: Attribute Fusion as a `Co-authored-by` trailer on managed commits instead of overriding the primary author. The user's configured git identity now remains the author/committer of every commit Fusion produces, and the configured commit author (default `Fusion <noreply@runfusion.ai>`) is appended as a `Co-authored-by:` trailer that GitHub recognizes for shared attribution. The `commitAuthorEnabled` toggle and `commitAuthorName`/`commitAuthorEmail` settings keep their existing keys; the dashboard settings UI relabels them from "Author" to "Co-author" to match the new behavior.
- 22d59b5: Add mergeIntegrationWorktree setting (default reuse-task-worktree) to decouple auto-merge from project-root mutation. Legacy cwd-main behavior preserved as an opt-in escape hatch.
- 5f9f777: Increase default group chat context retention (`chatRoomRecentVerbatimMessages` 12 → 25, `chatRoomCompactionFetchLimit` 80 → 200, `chatRoomSummaryMaxChars` 1500 → 3000) and raise the room transcript cap from 8KB to 20KB.
- 687237b: Per-project `fusion.db` now persists the canonical `projectId` in `__meta.projectIdentity`. If the central registry loses a project row, the next startup reattaches the same id from the stored identity instead of silently minting a new one (which would hide all project-scoped data keyed to the old id). Interactive flows prompt before destructive overwrites.

#### Patch Changes

- f403926: Make `fn agent import` extract `.tar.gz`/`.tgz` Agent Companies archives in-process instead of relying on a host `tar` binary.
- b7ddfc9: Layer FN-5152's near-duplicate intent guard onto the CLI `fn task create`
  direct-store path. Aligned thresholds (≥2 shared high-signal tokens AND
  title-token Jaccard ≥ 0.30 within a 7-day window), `--no-dedup` bypass,
  `source.sourceMetadata.intentSignature` stamping, and fail-open semantics
  match the dashboard `POST /api/tasks` gate. Non-TTY runs refuse with exit
  1; TTY runs prompt before creating. GitHub-import and AI-planning paths
  intentionally skip the gate (FN-5060 contract).
- 35b2971: Duplicating or restoring a task no longer fails when the source PROMPT.md
  contains legacy/invalid File Scope tokens. Invalid tokens are dropped from
  the rewritten PROMPT.md with a `[file-scope-sanitize]` log entry. Authoring
  paths (createTask, updateTask) continue to reject invalid tokens strictly.
- 8f2d5e7: Block explicit `DUPLICATE: FN-NNNN` redirect tasks from consuming planning
  cycles. The triage planning loop now short-circuits when the generated
  PROMPT.md is a one-line duplicate marker (bypassing the `fn_review_spec`
  APPROVE gate), a self-healing sweep resolves already-stuck duplicate-marker
  tasks in `triage`/`todo`, and the dashboard `POST /api/tasks` route
  surfaces a `409 duplicate_candidates` with `reason: "explicit-marker"` when
  the description is exactly a duplicate redirect. Layered on top of
  FN-4829 / FN-4918 / FN-5152; fails open.
- f6f3867: Merger Layer 2.5: auto-widen `## File Scope` for files whose branch-side commits
  are exclusively attributed to the current task before the FN-4956 scope
  partition strips them. Emits `merge:scope:auto-widen` run-audit events.
  Fail-closed against foreign commits, cross-task scope claims, and ignored paths.
- 8f5c1f9: New projects now default `directMergeCommitStrategy` to `"always-squash"` for direct merges.
  Existing projects keep their persisted setting value.
  Per-project Settings UI controls and per-task `**Direct Merge Commit Strategy:** ...` PROMPT overrides are unchanged.
- b936ab9: Apply `heartbeatMultiplier` to heartbeat unresponsive timeout calculations in `HeartbeatMonitor`.

  When heartbeat speed is slowed (for example `heartbeatMultiplier=2`), unresponsive detection/recovery and orphaned-running reconciliation now use the correspondingly scaled timeout base, preventing false unresponsive recovery for expected slower cadence. Dashboard health classifier behavior is unchanged.

- 6fdfb1a: Add a Room Coordination Notices prompt-injected advisory that fires when a
  user posts an explicit "file a task" / "create a task" request into a chat
  room with multiple agent members. Each agent is instructed to either post a
  one-line claim before calling fn_task_create (claim branch) or to defer and
  acknowledge a peer's prior claim/announcement (defer-suggested branch),
  reducing the upstream duplicate pressure on the existing FN-4918 / FN-4829
  / FN-5152 / FN-5220 dedup backstop. Emits a structured
  room:coordination:branch run-audit event per decision. Single-agent rooms
  and non-task-filing messages are unaffected.
- 025683c: Manual merge ("Merge now") no longer rejects in-review tasks that the scheduler has stamped with status: "queued". Auto-merge still honors all existing blockers.
- 4a99e3f: PR-mode merge cleanup (`cleanupMergedTaskArtifacts`) now releases the `WorktreePool` lease for the merged task worktree before removing it, preventing stranded lease bookkeeping after pull-request merges (FN-5420 / FN-4954 follow-up).
- 7a20b95: Add `session:runtime-resolved` run-audit event (FN-5544) emitted from `createResolvedAgentSession` for per-lane provider/runtime/model attribution. Additive surface; existing events unchanged. Replaces the diagnostic-log workaround introduced by FN-5206.
- 8380024: fix(executor): exempt `PREMISE STALE:` summaries from `summary-claims-incomplete` refusals

  The preflight escape hatch added in the prior commit instructs the agent to call `fn_task_done` with a summary that begins `PREMISE STALE:` when reproduction shows HEAD already matches the desired state. Natural premise-stale wording such as _"PREMISE STALE: the task has no remaining work — implementation is already done on HEAD"_ tripped `evaluateTaskDoneRefusal`'s scoped-incomplete regex (`/\b(incomplete|not implemented|not done|not finished)\b/i`) when the 40-char window contained `the task`/`this task`/first-person pronouns, refusing `fn_task_done` and deadlocking the executor — the exact failure the escape hatch was meant to prevent.

  Add a sentinel bypass: when `summary` starts (case-insensitive) with `PREMISE STALE:`, skip the dissent-pattern and scoped-incomplete summary checks. The `pending-code-review-revise` and `bulk-step-completion-without-review` guards still run unchanged, so the bypass cannot dodge real review obligations or unfinished work — only the summary-phrasing checks are relaxed.

- 1be0702: Mobile (Android Chrome edge-to-edge): the top brand header no longer sits underneath the system status bar — its mobile `padding-top` is now additive (`var(--space-md) + env(safe-area-inset-top)`) instead of `max(...)`, so the row keeps its normal breathing room _below_ the system inset. The executor status footer also no longer bleeds into the bottom-nav padding band: its `bottom` offset now uses the same `max(env(safe-area-inset-bottom), 12px)` floor that `MobileNavBar` already applies, so the two surfaces meet flush even when Chrome under-reports the bottom inset. Bare `TypeError: Failed to fetch` toasts (raised by in-flight requests aborted on tab background/resume) are now swallowed at the toast layer; toasts with additional context still surface.
- ba9d632: Mobile bottom nav no longer occasionally hides behind Android Chrome's gesture pill. Chrome under `viewport-fit=cover` intermittently reports `env(safe-area-inset-bottom)` as `0` while the address bar is visible or during URL-bar collapse; the nav now floors that inset to 12px so it always clears the gesture area. Devices that report a larger inset are unaffected.
- fbf7e2c: Dashboard no longer renders into a small upper-left rectangle on Android Chrome in multi-window/freeform/split-screen mode. The page now re-asserts its viewport meta with the live `innerWidth` on every resize and orientation change, defeating Chrome's habit of caching `device-width` at the original screen size (which left the layout viewport wider than the actual window, so normal-flow elements clipped while position-fixed elements pinned to the full window). Also drops `maximum-scale=1.0, user-scalable=no` from the viewport meta, and broadens the existing board scroll-snap stabilization from phones to all touch-primary devices so Android tablets get the same first-cards-loaded reflow that iOS Safari mobile already had.
- 5548dc5: Dashboard git pull now autostashes dirty local changes (including untracked files) before pulling and reapplies them on success. If reapplying conflicts, the stash is preserved and the operation reports `stashConflict` with the stash label so the user can resolve later from the Stashes view. Previously a dirty working tree caused the pull to fail outright with no recovery path.
- f58fb89: fix(engine-tests): eliminate full-suite temp-dir leak and harden subprocess guard against concurrent-workspace contention.

  - Two engine merger tests (`merger-no-op-fix-finalize.test.ts`, `merger-verification-fix-already-on-main.test.ts`) created `mkdtempSync` workspaces directly under `tmpdir()` with the tracked `fusion-test-` prefix. Under `pnpm -r --workspace-concurrency=2` load, transient cleanup races left orphans flagged by `check-test-isolation`. Route both through `FUSION_TEST_WORKER_ROOT` like sibling merger tests so the dirs nest inside the already-tracked worker root and never appear as top-level leaks.

  - Bump the engine vitest subprocess guard from 60 s to 120 s and the per-test timeout to 30 s. Under concurrent workspace runs, plain git commands (`git branch -d`, `git worktree remove --force`) queued behind system contention were timing out and failing reliability-interactions tests. The guard fires only on hangs, so healthy tests pay nothing for the higher ceiling.

- 97e6a0c: Skip the dependency-cycle preflight in `TaskStore.assertNoDependencyCycle` when the new task or update has no dependencies. The FN-5256 cycle-check rollout (e12adeb3f) added an unconditional `listTasks()` call on every write to build the dependency lookup, but an empty dependency list can never form a cycle so the query was wasted work. It also broke fail-open semantics in the same-agent duplicate intake path: tests that stubbed `listTasks` to throw saw the cycle check consume the rejection and propagate "boom" out of `createTask` before the duplicate-intake try/catch could swallow it.
- cf0101b: fix(FN-5256): harden three independent code paths that were losing live task worktrees mid-execution and producing `wrong_toplevel` errors.

  - Executor stale-self-owned classifier (`reconcileSelfOwnedActiveSessionForRemoval`) now requires two additional signals before dropping a same-task registry entry: a process-active probe (`executingTaskLock.has`) and a minimum-idle window (default 5s) since the entry was registered. This closes the pause/resume race where the new executor cycle hadn't repopulated `activeWorktrees` yet and the old session's registry entry was reaped under a still-live shell. The post-throw reconcile in `removeOwnWorktreeWithReconcile` and the `removeWorktree` defensive reconcile in `worktree-backend.ts` route through the same hardened path.

  - Pause-before-park now synchronously awaits agent/step/workflow session disposal via a new `awaitAbortInFlightTaskWork` method, so by the time `parkTaskAfterWorkflowStepPause` calls `moveTask("todo")` the spawned shells are already reaped and any fast re-dispatch sees a clean slate. The user-initiated pause handler on `task:updated` was collapsed onto the same await path for the same reason.

  - Self-healing `reconcileTaskWorktreeMetadata` now normalizes both sides via `realpathSync` (with ENOENT fallback) before comparing the task worktree against the registered set, fixing the macOS `/private/var/...` false-stale flag. It additionally refuses to clear `worktree`/`branch` metadata for in-progress or in-review tasks — those go through `task:auto-recover-worktree-metadata-skipped-active` audit events and leave executor-level recovery in charge.

  - The `task:moved`-away and `task:deleted` listeners now track an awaited disposal promise per task. A re-dispatch (`task:moved` → in-progress) awaits any in-flight disposal for the same task before calling `execute()`, so a fast bounce (in-progress → todo → in-progress) can no longer race the conflict-cleanup path against a still-live shell. `awaitAbortInFlightTaskWork` claims each session surface synchronously before awaiting its abort, so concurrent disposal calls dedupe naturally and the legacy fire-and-forget `abortInFlightTaskWork` has been removed.

- c824810: Fix reuse-task-worktree merge mode (FN-5279) never applying the squash commit to the project root's local integration branch. The merger detaches HEAD in the task worktree and lands the squash on the detached HEAD; previously nothing advanced the project root's local `main`, so changes never appeared on the user's `main` (and any subsequent `pushAfterMerge` would push the stale ref or fail outright because `parsePushRemoteTarget` can't resolve a branch from a detached HEAD). A new step 5c now applies the squash to the project root's integration branch via `git merge --ff-only`, falling back to a regular merge with AI conflict resolution if `main` has diverged. Push-after-merge (when enabled) now runs from the project root where the integration branch was just advanced.
- 1983dac: Engine reliability: prevent the FN-5345 in-review wedge class.

  - Fusion task worktrees now install a `prepare-commit-msg` empty-commit guard that refuses `git commit --allow-empty` and other zero-staged-diff commits, while still allowing legitimate amend / merge / squash / cherry-pick / revert / rebase paths. Amend detection scans `ps -o args=` (with `/proc/$PPID/cmdline` fallback for Alpine/busybox) tokenized, stopping at the first message-supplying flag (`-m`, `-F`, `--message`, `--file`) so a commit message containing the substring `--amend` cannot bypass the guard.
  - Merger gains an early empty-own-diff fast-path in `reuse-task-worktree` integration mode: branches with own commits but zero net tree change vs merge-base now auto-finalize as no-op BEFORE any reuse-handoff acquisition runs, preventing `registered-branch-mismatch` + `merge-deadlock-detected: verified content not on main` wedges. The fast-path best-effort cleans up the stranded worktree and `fusion/<id>` branch so empty-own-diff residuals do not accumulate.
  - `classifyOwnedLandedEvidence` also detects the empty-own-diff case and returns `proven-no-op` so downstream self-healing and post-handoff finalize paths benefit too.
  - Merger's reuse-fallback path now consults `git worktree list --porcelain` before creating a new worktree, reusing extant usable registrations of `fusion/<id>` and pruning stale ones, eliminating FN-5083-class branch-registration double-registration. The direct-reuse shortcut is guarded by FN-4811 (refuses paths owned by a different task in `activeSessionRegistry`) and FN-4954 (skipped when `recycleWorktrees=true` with a pool attached, so `WorktreePool.acquire` lease bookkeeping stays consistent). Two new audit subtypes (`merge:reuse-fallback-pruned-stale-registration`, `merge:reuse-fallback-reused-existing-registration`) replace the prior overloading of `merge:reuse-fallback-new-worktree` for these cases.

- 57dbff4: Fix `fn backup` corrupting the live database. The paired-central-backup feature opened a second `node:sqlite` connection against the live `fusion.db` and ran `PRAGMA wal_checkpoint(TRUNCATE)` before the file copy. A `node:sqlite` SIGSEGV mid-checkpoint (a known recurring crash mode for this codebase) could leave the main DB file extended-but-zeroed. Backups now copy the main DB plus any sibling `-wal`/`-shm` files via plain `cp`; SQLite replays the WAL on first open, so uncheckpointed pages are preserved without us ever opening a second connection against the live database.
- 1bffa22: fix(FN-5483): allow merger-driven commits past the identity-guard pre-commit hook (detached HEAD false-positive).

  The reuse-task-worktree merge path intentionally detaches HEAD at the integration target before running squash and verification-fix ceremonies. The identity-guard hook (`buildIdentityGuardHook`) refused every such commit because `HEAD_BRANCH=detached` never matches the owning task branch, surfacing as `merge-deadlock-detected: requires manual intervention — verified content not on main` on FN-5441 and FN-5446.

  The hook now honors a `FUSION_MERGER_BYPASS_IDENTITY_GUARD=1` env-var bypass (gated to the exact value `"1"`), set only on merger-driven `git commit` calls. The marker is placed after the `TASK_FILE` check so non-fusion worktrees stay no-op, and before `EXPECTED_BRANCH` so detached HEAD never reaches the refusal printf. Agent commits never set this env, so the guard still catches executor/reviewer misuse. `buildCommitMsgTrailerHook` and `buildPrepareCommitMsgEmptyGuardHook` are unchanged and continue to run on every merger commit, preserving FN-5089 trailer attribution and FN-5345/FN-5377 empty-commit refusal.

- 2d425b1: fix: clear scheduler-side `status='queued'`, `blockedBy`, and `overlapBlockedBy` when a task transitions into `in-review` so the merge gate is no longer permanently blocked by stale todo-dispatch markers.

  Repro: a task that picked up `status='queued'` while waiting in `todo` (e.g. file-scope overlap with a higher-priority queued peer) and then completed and was handed off to `in-review` — directly via `handoffToReview` or indirectly via stranded-completed-todo recovery — would carry the queued flag into review. Every subsequent merge attempt failed with `Cannot merge <id>: task is marked 'queued'`, and the in-review stall surface kept re-firing `[no-worktree-no-merge-confirmed]` without progress. Ghost-review → todo → scheduler re-queue → stranded → in-review formed a steady-state loop.

  Fix: `TaskStore.moveTaskInternal` now treats `queued`/`blockedBy`/`overlapBlockedBy` as todo-only dispatch state and scrubs them on every transition into `in-review`. Failed/awaiting-\* statuses are unaffected.

- d947197: Engine reliability: auto-recover merge handoff from HEAD drift when the branch ref is authoritative.

  - `acquireReuseHandoff` previously refused outright with `head-branch-mismatch / unexpected-branch` whenever the worktree's HEAD pointed at anything other than `fusion/<id>` (detached, recycled to `main`, on a sibling branch). The existing case-mismatch autocorrect did not cover these states, leaving FN-5339-class tasks wedged in review even though their branch ref still held a clean, task-attributed lineage.
  - New `isBranchAuthoritativeForTask` helper (in `branch-conflicts.ts`) confirms the expected branch ref exists, its tip carries the `Fusion-Task-Id: <id>` trailer, and the `base..branch` range has no foreign FN-attributed commits.
  - When that probe passes, the handoff now performs a plain `git checkout <branch>` (not `-B`, which would clobber the ref) inside the already-asserted-clean worktree, re-reads HEAD, and emits a `branch:auto-reattach-authoritative` audit. Refusal still fires unchanged when the branch ref itself is missing, missing a trailer, or contaminated — so the FN-5363 strict-lease and foreign-commit protections remain authoritative.

- 5c15031: Make the dashboard's "Refresh health" button actually re-run the SQLite integrity check. The background scheduler in `Database.scheduleBackgroundIntegrityCheck` only ran the check once at engine boot, so once `corruptionDetected` flipped to `true` it was sticky for the life of the process — the refresh action just re-read the same cached flag and the corruption banner could not be cleared even after the user repaired the DB (e.g. via `REINDEX`). `POST /api/health/refresh` now calls a new `TaskStore.refreshDatabaseHealth` which synchronously re-runs the integrity check and updates the cached state before responding.
- 24686ca: Stop losing uncommitted dev edits during task merges. Two fixes to the merger:

  1. The pre-merge autostash in `stashUnrelatedRootDirChanges` no longer silently proceeds when stash creation fails over a dirty working tree. It now throws `AutostashCreationFailedError`, which the merger catches and surfaces to the task feed before any destructive `git reset --hard` / `git clean -fd` runs — your edits stay in the working tree.

  2. `acquireReuseHandoff` no longer refuses the handoff on a dirty reused task worktree (the FN-5138 "Merge handoff refused (working-tree-dirty)" failure). It now autostashes the dirty content (`git add -A` → `git stash create` → `git stash store -m fusion-reuse-handoff-autostash:<taskId>:<ts>`), emits a `merge:reuse-handoff-autostash` audit event with the stash SHA and a recover command, and lets the merge proceed.

  The new failure mode `dirty-worktree-autostash-failed` is reserved for the (rare) case where stash creation itself fails — so the operator can distinguish "we tried and failed" from the old "we refused to try."

- a7ad30f: Mobile (iOS): the bottom navigation bar no longer slides up when the on-screen keyboard appears. The viewport-compensation offset that pulls fixed elements back into the visible area (intended for Android ICB quirks / pinch-zoom) was also being driven by the keyboard's shrunken `visualViewport.height` on iOS, pushing the nav bar above the keyboard. The nav now ignores that offset while `keyboardOpen` is true and stays pinned at the page bottom — the keyboard simply covers it.
- a2a5db8: Engine reliability: better diagnostics + clean-baseline reset on phantom finalize.

  - `commitOrAmendMergeWithFixes` previously swallowed all unexpected errors as `reason: "unknown-phantom"` and the two callers re-threw a `verification fix finalize failed (unknown phantom)` error with no surface area beyond the SHAs. FN-5422-class tasks wedged in review with no actionable signal in the failure message.
  - The catch now captures the original error message and runs an `isBranchAuthoritativeForTask` probe (existing branch ref carries this task's `Fusion-Task-Id` trailer + foreign-contamination check against base). When the branch ref is authoritative — meaning the AI's work is safely stored on `fusion/<id>` and only the in-merge attempt's integration worktree drifted — the catch resets rootDir to `preAttemptHeadSha` and returns `reason: "branch-ref-ahead-reset"`. The next merge attempt then starts from a known-good baseline instead of inheriting half-built squash state.
  - Verification-fix and build-verification-fix callers now include the original error and the branch-authority probe outcome in the thrown error, so operators see the actual failure cause (e.g. diff-volume regression, file-scope violation, transient git error) rather than `unknown phantom`.

- 5848606: Engine reliability: post-session branch-attribution audit catches contamination within minutes instead of days.

  - The executor already checks branch contamination at _acquisition_ time (`assertCleanBranchAtBase`) and at _reclaim_ time. The gap was the _active session window_ itself: commits added to `fusion/<id>` between acquisition and merge handoff went undetected until merge-time refusal, which is how FN-5233 ended up with two untrailered `feat(FN-5353):` commits sitting on `fusion/fn-5233`.
  - New `reportBranchAttribution(repoDir, branch, baseSha, taskId)` walks `base..branch` and classifies every commit into four buckets: `ownTrailed` (subject tag + `Fusion-Task-Id` trailer — healthy), `ownUntrailed` (subject tag but missing trailer — signals the commit-msg hook didn't fire), `foreign` (different FN-id via subject or trailer — contamination), and `unattributed` (neither — typically a hand-merge or plumbing commit).
  - Wired into the executor's post-session path (right after `captureModifiedFiles`): if any anomaly bucket is non-empty, the executor logs a structured `branch:attribution-anomaly` audit event and a task log entry. Failures in the audit itself are caught and warn-only — the audit must never destabilize a completing session. New `branch:attribution-anomaly` and `branch:auto-reattach-authoritative` git-mutation types accept the structured metadata.
  - Five new vitest cases cover the four anomaly buckets and the empty-range no-op.

- fbf7e2c: Dashboard board no longer squeezes all 6 columns into the visible width on tablet-sized viewports (769–1024px). Columns now keep a 260px minimum and the board scrolls horizontally, matching desktop behavior. Previously the tablet rule used `minmax(0, 1fr)` with `overflow-x: hidden`, collapsing columns to ~130–170px wide on Android tablets and forcing task card titles to stack one word per line.
- d90da81: Coerce `task.description` to an empty string when persisting in `TaskStore.getTaskPersistValues`. The `description` column is `NOT NULL`, so a task with a missing description previously failed insertion with a constraint error. Defaulting to `""` mirrors the existing `?? null` / `?? 0` treatment of other optional fields.
- 2d661df: fix(engine): prevent worktree-pool branch creation from inheriting a previous occupant's tip, and auto-reanchor branches that already inherited foreign commits.

  - `WorktreePool.prepareForTask` now rejects empty/`HEAD` base values and verifies post-detach HEAD matches the resolved base SHA before creating the branch. This closes the FN-5432 / FN-5255 contamination pattern where recycled worktrees branched from a stale HEAD (reflog: `branch: Created from HEAD`) and pinned the new task's tip to the previous task's commit.

  - `SelfHealingManager` now attempts a foreign-only contamination reanchor before pausing a task with `branch-conflict-unrecoverable`. When the task's branch carries only foreign commits (no own work), the branch is reset back to its base via the existing `recoverForeignOnlyContamination` path instead of stranding the task for human adjudication.

- 93b11c6: Atomic in-review handoff: introduce `TaskStore.handoffToReview` that performs the column move and `mergeQueue` enqueue inside a single transaction, and migrate every executor + self-healing site that promotes a completed task into `in-review` to use it. Direct `moveTask(taskId, "in-review")` writes now emit a `task:handoff-invariant-violation` run-audit event for forensics. Pairs with FN-5242 (queue schema) and FN-5243 (merger lease consumption).
- 9efcf93: Fix Fusion worktree pre-commit identity-guard hook to accept canonical lowercase `fusion/<id>` branches when the on-disk `fusion-task-id` metadata stores an uppercase id, eliminating spurious "refusing commit" rejections that previously required `--no-verify`.
- e908cbc: Downgrade merge-time file-scope invariant violations from task-failing errors to warning-only logs so merges can continue while still recording audit telemetry.
- 9011c21: Fix the Worktrunk integration to probe the canonical `wt` binary, point release metadata at the real `max-sixty/worktrunk` upstream, and fail closed when install metadata is still unverified. This preserves default-off behavior when `worktrunk.enabled=false` and hardens enabled setups that rely on an explicit `worktrunk.binaryPath`.
- b06cf64: Add deterministic external-integration safeguards by introducing a shared integration manifest validator, a triage-time spec evidence gate, and registry contract tests that prevent hallucinated third-party repo/binary/checksum metadata from landing.
- 232a9fe: Fix main chat composer (direct chat and rooms) so it visually grows on
  multi-paragraph paste up to the 640px cap, matching QuickChat behavior.
  The 640px cap from FN-5146 was already in place but an ancestor layout
  constraint was clipping the rendered height.
- fd202e9: Remove the `fn task branch-recovery` surface and retire orphan-branch auto-rescue wiring.

  Fusion now treats orphan `fusion/*` branches as operator-managed git state: branch conflicts still fail loudly with diagnostics, and operators resolve/reclaim/discard branches manually with standard git tooling before retrying.

- a8715ed: Self-healing: gate every backward-moving recovery stage on triple proof (dead session + unusable worktree + no recent executor activity). Stages that cannot satisfy the predicate are downgraded to observation-only, emitting task:<stage>-no-action audit events instead of lifecycle moves. Authoritative per-stage disposition lives in docs/self-healing-backward-move-audit.md. Companion to FN-5337.
- 1a5aff9: Self-healing: remove speculative auto-requeue from `recoverOrphanedExecutions`. The sweep no longer calls lease-manager recovery/reconcile, no longer writes `status: "stuck-killed"` or clears `worktree`/`branch`, no longer writes the `Auto-recovered orphaned executor task` log entry, and no longer moves tasks back to `todo`.

  `recoverOrphanedExecutions` is now observation-only and emits `task:orphan-detected-no-action` run-audit events plus `[orphan-detected]` diagnostics when stale in-progress candidates are detected. Proof-based lifecycle recovery remains owned by `recoverInProgressLimbo`, `RestartRecoveryCoordinator`, and explicit executor/merger failure paths (fixes FN-5279 false-positive class).

- 216c32b: Manual task retry now resets the full persisted retry-budget counter set (and `nextRecoveryAt`) across CLI, pi extension, and dashboard retry surfaces, so retry badges/details no longer stay inflated after a user-triggered fresh attempt.
- 8df21a6: Fix in-review merge stall under the new mergeIntegrationWorktree=reuse-task-worktree default: strict targetTaskId leasing prevents cross-task lease bleed, and missing task.worktree always triggers the reacquire fallback instead of misrouting handoff gates against the project root.
- dbccdb1: Harden cloudflared auto-install (dashboard remote-access opt-in flow): add a pinned release manifest and SHA-256 verification, mirroring the FN-5320 Worktrunk pattern. Auto-download fails closed in `upstream-pending-verification` mode; package-manager paths (`brew`, `winget`) are unchanged. Replaces the previous unverified `releases/latest/download` direct-curl install path.
- a04ba3c: Coerce null or undefined `task.description` values to an empty string when persisting TaskStore rows.
- c3890a9: Improve soft-deleted blocker recovery so blocked tasks become schedulable without manual intervention. `SelfHealingManager.clearStaleBlockedBy` now emits an explicit `soft-deleted at ...` reason when a stale blocker is a soft-deleted row, and the scheduler now reconciles downstream `blockedBy`/dependency state immediately on `task:deleted` events to reblock on remaining live deps or unblock tasks in the same tick.
- 31c71a3: Surface exhausted soft-deleted in-review blockers through opt-in visibility paths so operators can diagnose stalled dependent chains without direct DB access. `fn_task_show` now falls back to include soft-deleted task reads and prints a `[SOFT-DELETED at ...]` marker, while `fn_task_list` adds an `includeDeleted` flag for listing hidden blockers.

  Also adds dashboard/API visibility with `GET /api/tasks/exhausted-in-review` (including `?includeDeleted=true`), `GET /api/tasks/:id?includeDeleted=true`, and a ReliabilityView panel for exhausted hidden blockers plus blocked dependents.

- 3ccb132: Fix Windows worktree creation and cleanup by replacing POSIX shell `mkdir -p` / `rm -rf` calls in worktree setup paths with cross-platform Node.js filesystem APIs.

### runfusion.ai

#### Patch Changes

- Updated dependencies [f403926]
- Updated dependencies [b7ddfc9]
- Updated dependencies [35b2971]
- Updated dependencies [8f2d5e7]
- Updated dependencies [f6f3867]
- Updated dependencies [8f5c1f9]
- Updated dependencies [1b49cbc]
- Updated dependencies [2baaad7]
- Updated dependencies [b936ab9]
- Updated dependencies [b12ff26]
- Updated dependencies [6fdfb1a]
- Updated dependencies [025683c]
- Updated dependencies [4a99e3f]
- Updated dependencies [7a20b95]
- Updated dependencies [8a3afcf]
- Updated dependencies [8380024]
- Updated dependencies [e291d86]
- Updated dependencies [1be0702]
- Updated dependencies [ba9d632]
- Updated dependencies [fbf7e2c]
- Updated dependencies [5548dc5]
- Updated dependencies [f58fb89]
- Updated dependencies [97e6a0c]
- Updated dependencies [cf0101b]
- Updated dependencies [c824810]
- Updated dependencies [1983dac]
- Updated dependencies [57dbff4]
- Updated dependencies [1bffa22]
- Updated dependencies [2d425b1]
- Updated dependencies [d947197]
- Updated dependencies [5c15031]
- Updated dependencies [24686ca]
- Updated dependencies [a7ad30f]
- Updated dependencies [a2a5db8]
- Updated dependencies [5848606]
- Updated dependencies [fbf7e2c]
- Updated dependencies [d90da81]
- Updated dependencies [2d661df]
- Updated dependencies [93b11c6]
- Updated dependencies [9efcf93]
- Updated dependencies [22d59b5]
- Updated dependencies [e908cbc]
- Updated dependencies [9011c21]
- Updated dependencies [b06cf64]
- Updated dependencies [232a9fe]
- Updated dependencies [fd202e9]
- Updated dependencies [a8715ed]
- Updated dependencies [1a5aff9]
- Updated dependencies [216c32b]
- Updated dependencies [8df21a6]
- Updated dependencies [5f9f777]
- Updated dependencies [dbccdb1]
- Updated dependencies [687237b]
- Updated dependencies [a04ba3c]
- Updated dependencies [c3890a9]
- Updated dependencies [31c71a3]
- Updated dependencies [3ccb132]
  - @runfusion/fusion@0.33.0

## 0.32.0

### @fusion/core

#### Patch Changes

- 1f0bb7e: Stop `MasterKeyManager` from probing the real macOS/Linux keychain during tests. A new `FUSION_MASTER_KEY_DISABLE_KEYCHAIN=1` env var forces the file backend, and the core vitest setup sets it so tests no longer hang for 15s in `keytar.getPassword(...)` on machines without a usable keychain.

### @fusion/dashboard

#### Patch Changes

- 67aff5d: Fix dashboard occasionally serving a blank/broken page until the server is restarted. The server cached `index.html` and the Vite view-chunk manifest forever with no invalidation, so any on-disk change (release upgrade, rebuild) left the server handing out stale HTML referencing chunk hashes that no longer existed. Both caches now invalidate automatically when the underlying file's mtime changes. The `serveIndexHtml` catch path also now logs the failure and clears the templated cache so a subsequent request can recover, instead of silently returning 404 forever.
- Updated dependencies [1f0bb7e]
  - @fusion/core@0.32.0
  - @fusion/engine@0.32.0
  - @fusion-plugin-examples/cli-printing-press@0.1.9
  - @fusion-plugin-examples/dependency-graph@0.1.23
  - @fusion-plugin-examples/roadmap@0.1.11
  - @fusion-plugin-examples/cursor-runtime@0.1.11
  - @fusion-plugin-examples/droid-runtime@0.1.18
  - @fusion-plugin-examples/hermes-runtime@0.2.42
  - @fusion-plugin-examples/openclaw-runtime@0.2.42
  - @fusion-plugin-examples/paperclip-runtime@0.2.42

### @fusion/desktop

#### Patch Changes

- Updated dependencies [1f0bb7e]
- Updated dependencies [67aff5d]
  - @fusion/core@0.32.0
  - @fusion/dashboard@0.32.0

### @fusion/engine

#### Patch Changes

- Fixed `fn_task_done` to gracefully handle missing worktree directories. When a task's worktree has been deleted (common for documentation/coordination tasks with no code changes), `fn_task_done` previously failed with ENOENT attempting to spawn git commands in non-existent directories. The fix adds an `existsSync` check in `verifyWorktreeInvariants` before executing git commands, allowing legitimate task completions to proceed. This is safe because task completion is read-only, deliverables are stored in fusion.db (not the worktree), and if code changes were made, the worktree would exist. Resolves infinite loops where agents couldn't complete tasks without shell access to missing directories.
- Updated dependencies [1f0bb7e]
  - @fusion/core@0.32.0
  - @fusion/pi-claude-cli@0.32.0

### @fusion/plugin-sdk

#### Patch Changes

- Updated dependencies [1f0bb7e]
  - @fusion/core@0.32.0

### @runfusion/fusion

#### Minor Changes

- b772881: Add a new project setting, `chatAutoCleanupDays` (default off), to automatically remove idle chat sessions and chat rooms during periodic self-healing maintenance.
- ff71746: Add a new project setting, `mailAutoCleanupDays`, to auto-prune old inbox/outbox messages during self-healing maintenance. The setting defaults to `0` (off) and supports retention windows of 7, 14, 30, 60, or 90 days.
- a34e77a: Documented Fusion secrets management across architecture, storage, settings, and agent guidance, including encrypted project/global secret stores and access-policy behavior. Added secrets subsystem reference docs plus planned integration notes for agent secret reads, worktree env materialization, and cross-node sync endpoints.
- dde2d06: Implement `.env` secrets materialization pipeline: honor `secretsEnv` project settings (enabled/filename/overwritePolicy/keyPrefix/requireGitignored), gate writes behind `git check-ignore`, emit `secret:env-write` / `secret:env-write-skipped` / `secret:env-cleanup` / `secret:env-cleanup-skipped` run-audit events, and clean up fingerprint-matching `.env` files on worktree teardown.
- e9ef40f: Add cross-node secrets sync endpoints (`POST /api/nodes/:id/secrets/push`, `POST /api/nodes/:id/secrets/pull`, `POST /api/secrets/sync-receive`, `GET /api/secrets/sync-export`) with shared-passphrase envelope (scrypt → AES-256-GCM) and Bearer-apiKey auth on inbound routes. Passphrase is stored locally encrypted under the master key (reserved `__sync_passphrase__` row, `access_policy="deny"`) and is never transmitted or echoed.
- 56a7178: Add `priority` field to `fn_task_update` MCP tool so agents can rebalance task urgency after triage.
- b078a81: Add deterministic automated follow-up dedup for verification failures and related engine-created recovery tasks.
- 75a7127: Add a "Connection → Change Launch Mode…" menu item to the Fusion desktop app so users can switch between Run Locally and Connect to Remote after the initial chooser. It resets the persisted desktop mode, stops the embedded runtime, and reloads the dashboard so the launch gate re-prompts.
- b143f6c: Add a desktop launch gate so the packaged Fusion app prompts the user to either run Fusion locally (starts the embedded runtime and points the dashboard at it via `?serverBaseUrl=…`) or connect to a remote Fusion server, instead of immediately showing a "can't reach backend" error.
- edfd6e4: Add `worktreesDir` project setting to place task worktrees outside the project root. Supports absolute paths, paths relative to the project root, `~` expansion, and the `{repo}` token. Defaults to the existing `<projectRoot>/.worktrees` behavior when unset.
- 9e87de0: Make OpenRouter a first-class provider: send HTTP-Referer/X-Title attribution headers, prefer /api/v1/models/user when an API key is configured, expose openrouterModelFilters and openrouterProviderPreferences in settings, and forward provider routing prefs into chat completion requests.
- 9574ba4: Add `worktrunk` settings group (`worktrunk.enabled`, `worktrunk.binaryPath`, `worktrunk.onFailure`) to both global (`~/.fusion/settings.json`) and project (`.fusion/config.json`) tiers, with field-level project-overrides-global precedence. CLI `fn settings set worktrunk.<field>` is supported in both scopes. This is settings plumbing only; the worktree backend that consumes these keys ships in a follow-up.
- 9ac503f: Add a settings-driven WorktreeBackend abstraction with native git as default and opt-in worktrunk create fallback behavior.
- 3d9260e: Complete worktrunk backend delegation for create/sync/prune/remove plus worktrunk-aware worktree layout resolution when `worktrunk.enabled` is on.
- 06810e4: Auto-install flow for the optional worktrunk worktree backend: when `worktrunk.enabled` is on and the binary is missing, Fusion downloads a SHA-256-verified pinned release (v0.4.2) into `~/.fusion/bin/` with a `cargo install` fallback under `network_api` approval policy. Pinned release supports `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`; Windows falls back to cargo-only. Install attempts emit run-audit `binary:install-*` events.
- 8b371ba: Fail-hard by default when a delegated worktrunk operation fails: the task is paused with `pausedReason: "worktrunk_operation_failed"` and the underlying stderr is surfaced in the dashboard. Set `worktrunk.onFailure: "fallback-native"` to instead fall back transparently to Fusion's built-in worktree-pool and receive a one-shot dashboard alert per task.
- 196b7e4: Fusion now supports an optional integration with the [worktrunk](https://github.com/max-sixty/worktrunk) CLI for per-task worktree management. It is off by default and can be enabled with `worktrunk.enabled` (global with project overrides).

  When enabled, Fusion delegates worktree create/sync/prune/remove operations to worktrunk and adopts worktrunk’s directory layout. You can set `worktrunk.binaryPath` to use a specific binary, or rely on auto-install on first use (gated by the `network_api` action gate).

  `worktrunk.onFailure` defaults to `"fail"` (pause the task on a worktrunk error), with opt-in `"fallback-native"` if you want Fusion to fall back to native worktree handling. When `worktrunk.enabled = true`, worktrunk layout takes precedence and `worktreesDir` is ignored.

- 4ce58f2: Add `sandbox.*` project settings schema, validators, and per-task PROMPT override parser (no behavior change; foundation for the SandboxBackend rollout).
- c0f9dde: Add WorktreeBackend abstraction (native default + worktrunk scaffold) selected by `worktrunk.enabled`. CLI subcommand mapping arrives in FN-4623.
- 43ae0ee: Add WorktreeBackend abstraction (native default + worktrunk scaffold) selected by `worktrunk.enabled`. Real worktrunk CLI subcommand mapping arrives in FN-4623.
- 3defcbe: Disable the worktrunk auto-install path. The pinned cognitive-engineering-lab/worktrunk v0.4.2 release is no longer reachable (see FN-4704/FN-4705), so `installWorktrunk()` now throws `WorktrunkInstallFailedError` immediately. Users who opt into `worktrunk.enabled` must set `worktrunk.binaryPath` or place `worktrunk` on `$PATH`. Auto-install will return once an authoritative upstream release source is re-established. `WORKTRUNK_PINNED_RELEASE` and the release-download helpers are removed from `@fusion/engine` exports.
- b94eae4: Add minimal Goals dashboard view (Slice 1 of Goals-as-strategic-layer mission). Lazy-loaded component renders active-goal list with soft-warning at 3 active goals and hard-error when attempting to exceed the 5-active cap. Uses mock data adapter pending the GoalStore backend slice.
- 6afd273: Goals dashboard view is now wired into the Header overflow menu and Mobile More sheet, gated by the `goalsView` experimental feature flag.
- 293441a: Chat rooms now support `/clear` and `/new` in the composer by clearing the active room transcript instead of sending those commands as normal messages. Added a new API route, `DELETE /api/chat/rooms/:id/messages`, to bulk-clear all messages in a room while preserving room identity and membership.
- 7b48387: Add Create-PR entry points across the dashboard (task detail header, task card quick action,
  in-review auto-prompt, review tab) and a new `fn pr create <task-id>` CLI command. The legacy
  `fn task pr-create` remains as an alias.
- 0338b37: Add live PR check streaming in the dashboard PR panel, including failing-check surfacing with direct GitHub details links, and introduce `GET /api/tasks/:id/pr/checks` for all check runs with required-check rollup status.
- 3e944ed: Fusion now includes a redesigned pull request creation flow with AI-generated title/description suggestions and support for repository PR templates. You can open PR creation from new dashboard entry points (task detail header, task card quick action, in-review prompt, and merge/review modal) or from the CLI with `fn pr create`. A new PR status panel shows live checks and review comments, supports merging from the dashboard, and can optionally enable auto-merge when checks are green. When a PR merges, the task auto-transitions to done; if reviewers request changes, the task is routed back to todo with that feedback visible in Fusion.
- 937bed9: Add hybrid master-key resolver (`MasterKeyManager`) backing the upcoming secrets subsystem. Tries the OS keychain via optional `keytar` dependency, falls back to a `0600` `~/.fusion/master.key` file.
- 01276d6: Quick Chat and ChatView now support sending file attachments when a chat room is active. Added room attachment upload and fetch endpoints (`POST /api/chat/rooms/:id/attachments`, `GET /api/chat/rooms/:id/attachments/:filename`) and wired room message sends to upload pending files before persisting room messages.
- 5233bc9: Add board-health self-healing levers in the engine: paused-scope decay rebound for blocked paused holders, meta-task chain auto-close for resolved/stalled recursion, and a board-stall sweep with verification-gated ntfy escalation. This adds new project settings (`pausedScopeDecayMs`, `metaTaskStallAutoCloseMs`, `boardStallSweepWindowMs`, `boardStallBlockedGrowthThreshold`) plus run-audit events for rebound/archive/stall outcomes.
- 040a909: Add dashboard UI panel and `/api/secrets/sync-passphrase` routes to configure the cross-node secrets-sync passphrase. Reserved `__sync_passphrase__` row is filtered out of the standard secrets list. Plaintext is never returned over HTTP.
- f9c0b93: Add `failureNotificationMode: "terminal-only"` to suppress ntfy/webhook
  failure notifications while the engine is still auto-retrying a task.
  Notifications fire only once the task is paused or escalated to in-review.
  Default behavior (`sticky-only`) is unchanged.
- aad1219: Dashboard PR panel now supports tasks linked to multiple GitHub PRs. `Task.prInfos` is the new canonical list; `Task.prInfo` is preserved as the primary-PR mirror for back-compat. PR refresh, unlink, and self-healing conflict reclaim all operate per-PR.

#### Patch Changes

- 3ea9bbb: Add reliability stats reset support with a new `/api/health/reliability/reset` endpoint and enhance the Reliability dashboard view with drill-down details, empty-day filtering, and reset baseline visibility.
- e1bda2a: Chat rooms now show the same Latest jump-to-bottom button as direct chats.
- 73b4717: Fix Mission Manager mission detail refresh behavior so expanded milestones/slices are preserved and selected milestone acceptance criteria remain visible across live updates.
- fa9648b: Planning mode, mission interview, and milestone/slice interview AI sessions now have read-only access to `fn_task_list` and `fn_task_get` so they can reference existing backlog tasks while interviewing the user.
- 3ff683a: Add internal `SandboxBackend` abstraction to the engine command-execution path (native passthrough only; no behavior change). Foundation for FN-4637 (bubblewrap), FN-4638 (sandbox-exec), FN-4639 (settings), FN-4640 (audit), FN-4641 (action-gate), FN-4642 (container) follow-ups.
- 41ceae0: Add an opt-in Linux `bubblewrap` sandbox backend with policy-to-`bwrap` argument translation, backend availability detection, and native fallback support.
- aeada25: Add opt-in macOS `sandbox-exec` backend for the engine `SandboxBackend` abstraction. Default backend remains `native`; enable via `sandbox.backend = "sandbox-exec"`. Honors `failureMode: "fail-hard" | "fallback-native"`. Port 4040 and `.fusion/` are denied unconditionally.
- 7c15be8: Add `sandbox` run-audit domain with `sandbox:prepare`/`sandbox:run`/`sandbox:failure`/`sandbox:fallback` lifecycle events emitted from the engine's `SandboxBackend` wiring sites, and surface them through the dashboard's run-audit API (filter parser, normalized event domain, timeline `auditByDomain.sandbox` bucket).
- 7805645: Add `sandbox_provisioning` action-gate category, `sandboxProvisioning` project setting,
  `resolveSandboxProvisioningPolicy` in @fusion/core, and a
  `requireSandboxProvisioningApproval` engine helper. Lays the approval seam that future
  bubblewrap (FN-4637), sandbox-exec (FN-4638), and container (FN-4642) backends use to
  gate first-time host bootstrap.
- 5253cc1: Prototype optional rootless container `SandboxBackend` (Podman-first, Docker-compatible) behind the FN-4636 seam. Off by default; reachable only via explicit `resolveSandboxBackend({ backendId: "podman" | "docker" })`. No settings, audit, or action-gate wiring yet (FN-4639/FN-4640/FN-4641).
- cc7b9f3: Extend internal `SandboxBackend` abstraction to cover the spawn-based verification runner (`runVerificationCommand` / `execWithProcessGroup`) via a new `runStreaming` method on the backend. Native passthrough only — no behavior change. Foundation for FN-4637/FN-4638 to wrap the verification path the same way they wrap `runConfiguredCommand`.
- 939b68e: Auto-finalize in-review tasks when self-healing or merge fast-path logic can prove task content already landed on the base branch, clearing soft blockers (`paused`, stale `failed` status, and residual error) while still preserving hard-blocker guardrails for incomplete steps, awaiting-user-review states, and pre-merge workflow failures.
- 5975931: GitHub tracking issues are now created for every task-creation path (pi extension tools, CLI commands, agent delegation, and mission/feature triage), not only dashboard HTTP routes.
- 7942fb0: Gate sandbox backend settings behind `experimentalFeatures.sandbox` until the rollout completes.
- c7ba63c: Missions UI: surface per-feature acceptance criteria in the milestone Assertions panel even when the milestone itself has acceptance text. Fixes FN-4652 (refinement of FN-4613).
- df28dcf: GitHub Copilot login (Settings and Onboarding) now shows the device code and auto-copies it to the clipboard before opening the GitHub verification page — users click "Open GitHub" when ready instead of having the new tab steal focus immediately. The device-code panel now spans the full width of the provider card.
- a88857a: Persist `mergeDetails.rebaseBaseSha` whenever a rebase merge base is captured, and update self-healing landed-commit stats lookup to use rebase range shortstat (`base..sha`) when available so stale tip-only merge stats are automatically repaired.
- a27614f: Routine-runner now threads a `RunAuditor` through `resolveSandboxBackend()` so user-configured routine commands emit `sandbox:prepare`/`sandbox:run`/`sandbox:failure` lifecycle events alongside executor and merger commands, closing the FN-4640 observability gap.
- f7a7038: Ensure duplicate/refine API task creation paths also attempt GitHub tracking issue creation as best-effort behavior.
- 2739259: Suppress false `missing-evidence` warnings on verification-only / no-code follow-up tasks by classifying branch-absent no-owned-commit finalizes as benign `no-changes-finalized` and clearing stale `modifiedFiles` snapshots.
- 401094c: Right-align the linked GitHub issue chip on in-review TaskCards, matching the in-progress placement.
- 9a1c904: Add a new project setting `doneAutoArchiveDays` (default `0`) to control done-task auto-archive retention in days. When set to a value greater than `0`, it takes precedence over `autoArchiveDoneAfterMs` for periodic self-healing auto-archive sweeps.
- e5c9c7a: Annotate wake-on-message heartbeat runs whose inbox snapshot is already empty with consumed-message wake reasons, plus wake-delta inbox snapshot context.
- 7c0624c: Fix settings sync push/receive payload contract: the push endpoint now includes `sourceNodeId` so the inbound `/api/settings/sync-receive` validator no longer rejects round-trips with a 400.
- 6721005: Add a new dashboard `PrCreateModal` component with AI metadata generation, preflight checks, base-branch selection, draft mode, reviewer/assignee/label pickers, commit/file preview, and retryable PR creation errors. Also add dashboard client API wrappers for PR metadata, preflight, and options endpoints.
- 3d7e737: Sync GitHub PR reviews and review comments into Fusion task comments, expose a PR reviews API for dashboard threading, and auto-move in-review tasks back to todo when GitHub review decision changes to CHANGES_REQUESTED while preserving progress/worktree and saving reviewer feedback context.
- ae740bd: Structured surfacing of GitHub CLI / API errors with retry affordances in the dashboard PR UI and `fn pr create` CLI flow.
- db7b196: GitHub tracking-issue creation no longer blocks `POST /api/planning/create-task` and `POST /api/planning/create-tasks` responses; it now runs in the background.
- b594160: Wire `HybridExecutor` into serve/dashboard/daemon startup behind `shouldUseHybridExecutor` gating. This adds optional multi-project runtime orchestration (project runtimes + node health monitoring) while preserving default single-project local behavior unless the gate enables it.
- 11012b4: Add a triage `fn_task_search` tool that searches across task history (including done and archived tasks) and strengthen duplicate-check guidance to require keyword search before filing new tasks.
- 023a0cc: GitHub tracking-issue creation now searches the target repo (open and closed
  issues) for likely duplicates before opening a new issue, keyed on the task's
  File Scope paths and symptom keywords. Matches link the existing issue to the
  Fusion task. Opt out with project setting `githubTrackingDedupEnabled: false`.
- c6e9782: Dashboard reload no longer briefly hides the UI behind a full-screen loader when project data is already cached.
- fea0b51: Add `oauth-token-expired` notification event so users are notified when a provider OAuth token (Codex, Claude, etc.) expires and needs re-authentication.
- 7ab3f7a: Internal: add AES-256-GCM secret cipher primitive in @fusion/core (foundation for upcoming secrets subsystem; no user-visible behavior yet).
- f0df7cb: Internal: introduce `SecretAccessPolicy` vocabulary (`auto`/`prompt`/`deny`) and `resolveSecretAccessPolicy()` resolver plus a global `secretsAccessPolicy` default setting. Foundation for the upcoming secrets subsystem; no user-visible behavior yet.
- 4d5e296: Dashboard top progress bar now also reflects task list revalidation, not just project loading.
- 246609a: Dashboard Settings → Project → General → GitHub Tracking now exposes a
  toggle for `githubTrackingDedupEnabled`, so users can opt out of the
  pre-creation duplicate search without editing `.fusion/config.json`.
- 3f8a5e6: fix(FN-4806): silently recover when worktree/branch reclaimed mid-retry

  When the executor's no-`fn_task_done` retry loop detects that a task's worktree or branch was reclaimed by an engine-side housekeeping path (FN-4546 stale-active-branch reclaim, FN-4742 self-healing removals, session-start unusable-worktree), it now requeues the task to `todo` silently with preserved progress. The task is no longer marked `failed`, `taskDoneRetryCount` is no longer burned, and `onError` is no longer surfaced — this is engine self-heal, not an agent failure. The genuine "agent finished without calling fn_task_done after N retries" exhaustion path is unchanged.

- 4c26aa6: fix(FN-4811): refuse to force-remove worktrees actively bound to live sessions

  Adds a hard liveness gate to the executor's conflict-recovery paths so that
  `cleanupConflictingWorktree` and `handleBranchConflict` refuse to remove a
  worktree that is currently bound to an active executor session — either via
  the in-memory `activeWorktrees` map or via a non-done, non-paused
  `in-progress` task in the store. When the requesting task has
  `executorAllowSiblingBranchRename`, the recovery flow now falls through to
  the suffix-rename path instead of force-removing the live owner's worktree.

  This is the canonical fix for the FN-4781/FN-4804 cascade:
  "assigned worktree path disappeared mid-task", two parallel runs for the
  same task alive simultaneously, cross-task contamination, and post-merge
  "branch tip misbound but content found on main" rescues firing on every
  successful merge. The new `findActiveWorktreeOwner()` helper centralizes
  the liveness check across both gating points.

- 8bef306: fix(FN-4811): close concurrent-execute race that produced parallel runs for the same task

  `TaskExecutor.execute()` had an async race: after the synchronous `this.executing.has(task.id)` check, the code awaited `shouldDeferForHeartbeat(...)` BEFORE adding to the `executing` Set. Two concurrent `execute()` calls (scheduler dispatch + `task:moved` listener + restart-recovery) could both pass the check, both yield on the await, then both add to the Set and both proceed to create the same worktree.

  Production signature (FN-4814, FN-4811):

  ```
  01:30:56  [runA-caoe]  Worktree created at /Users/eclipxe/Projects/kb/.worktrees/bright-mesa
  01:30:56  [runB-w23q]  Worktree created at /Users/eclipxe/Projects/kb/.worktrees/bright-mesa
  01:30:58              worktree liveness assertion failed: not_usable_task_worktree
  ```

  This is the canonical source of FN-4781/FN-4804/FN-4814/FN-4811 mid-task worktree disappearance and cross-task contamination — every other guard in the stack (FN-4811 active-session gate, self-healing reclaim defer, etc.) was patching the _symptoms_ of the duplicate-run race.

  Fix: claim the executing slot synchronously immediately after the `has()` check, release it on the heartbeat-defer early return. Closes the race window entirely.

- 86237c9: fix(FN-4811): unblock `@fusion/engine` typecheck so verification bootstrap can run

  Restores `pnpm --filter @fusion/engine build` after a stack of TypeScript regressions blocked every merge. Symptoms: every task hitting pre-merge verification failed with "Verification bootstrap preamble failed — workspace dist artifact rebuild did not complete" because the bootstrap shells `pnpm --filter @fusion/engine build` and that compile was erroring on 17 type issues.

  Fixes:

  - Remove duplicate `RemovalReason` re-export in `worktree-pool.ts` (`export type` + `export` for the same identifier produced TS2300 "Duplicate identifier").
  - Add `worktree:removal-refused-active-session` and `worktree:removal-forced-over-active-session` to the `GitMutationType` union in `run-audit.ts` so the new FN-4811 audit events are accepted.
  - Update `self-healing.test.ts` `vi.mock("../worktree-pool.js")` to mirror the production `RemovalReason` const exactly (was missing keys, causing `reason: undefined` to flow into mock calls and confusing error messages).
  - Add `reason: RemovalReason.MergerCleanup` to existing `worktree-backend.test.ts` `removeWorktree` calls now that `reason` is a required parameter.

- f4aa6d7: fix(FN-4811): persist done-task integrity warnings across engine restarts

  `SelfHealingManager.reconcileDoneTaskIntegrity()` previously deduped its
  "Integrity warning: done-task finalize evidence is unproven" emissions via an
  in-memory `Set<string>` per manager instance. Every engine restart created a
  fresh manager, so the periodic sweep re-emitted the same warning for the same
  task on every cycle — producing significant log noise on done tasks legitimately
  lacking on-main evidence (often FN-4811 contamination residue).

  Adds an optional `integrityWarning: { warnedAt, reason }` field on
  `MergeDetails` and persists it on the first warning. Subsequent sweeps (within
  the same process or after restart) check the persisted reason and skip
  re-emitting an identical warning. A different classification reason still
  re-warns and updates the persisted record.

- b6df11a: fix(FN-4811): use process-wide executingTaskLock to block parallel execute() across instances

  After commit 82f80e72f added a per-instance `this.executing.add()` synchronous claim, production STILL produced two `execute()` invocations for the same task ID that both reached "Executor detected stale merge state" and both generated runIds within 1 second of each other (FN-4809: y2nb + 9gde at 02:48:17–18 UTC; FN-4814 / FN-4811 cascade). The only viable explanation is that there is more than one `TaskExecutor` instance in the process (engine restart race, multi-project hybrid runtime, etc.).

  Adds a module-level singleton `executingTaskLock` in `active-session-registry.ts` shared across all `TaskExecutor` instances. `TaskExecutor.execute()` synchronously claims the lock immediately after the `executorLog.log` entry; if `tryClaim()` returns false (someone else owns the lock), the call bails. Every existing `this.executing.delete()` site also releases the lock. Per-instance `this.executing` is kept for back-compat with the many `this.executing.has()` checks throughout `executor.ts`.

  Test setup in `executor-test-helpers.ts` clears the process-wide lock in `resetExecutorMocks()` so it doesn't leak across tests.

- a1b1f9a: fix(FN-4811): defer self-healing reclaim when worktree has an active session

  The `reclaimSelfOwnedBranchConflicts` sweep was force-pausing actively-running tasks. When a task's branch tip was already on `main` (the `tip-already-merged` inspection), the sweep tried `removeWorktree({ reason: SelfHealingBranchConflict })`. The FN-4811 active-session gate correctly refused (the worktree was still bound to a live executor session), but the outer catch escalated the thrown error to `AutoRecoveryDispatcher` with class `branch-conflict-unrecoverable`. The dispatcher's `pause` decision then marked the task `failed + paused + pausedReason="branch-conflict-unrecoverable"` — even though the executor was making real progress (FN-4819 reproduction).

  Fix: at the top of the per-task reclaim loop, check `activeSessionRegistry.isPathActive(task.worktree)` and `continue` for any task whose worktree is currently bound to a live executor/merger/step session. The reclaim retries on the next sweep when the session has finished and the worktree is genuinely free.

- 5c36c0f: fix(FN-4811): scope-leak guard always allows `.changeset/` paths

  The `[scope-leak]` warning was firing on many in-progress tasks for off-scope `.changeset/FN-XXXX-*.md` files (the reproducible signature on FN-4789, FN-4801, FN-4818). By convention every task may add its own changeset entry under `.changeset/` per AGENTS.md's "Finalizing Changes" section, so changeset files are now treated as always-allowed by the scope-leak guard regardless of the task's declared file scope. Cross-task changeset leakage is still caught by stronger downstream guards (file-scope invariant at squash, post-merge audit) at a much higher signal-to-noise ratio.

- dcd6bf6: fix(FN-4811): recover from "validation failed, cannot remove working tree" + collapse broken FN-4806 nested branches

  Two follow-ups stacked on the FN-4811 active-worktree liveness gate:

  1. **Stale conflict-path recovery (was breaking real tasks).** When `git worktree remove --force` fails with `fatal: validation failed, cannot remove working tree`, the worktree directory is missing on disk and the git admin entry is stale. `cleanupConflictingWorktree` now catches that specific error, runs `git worktree prune`, best-effort deletes the branch, and returns success — so the caller can proceed with worktree creation instead of failing 3× with "automatic cleanup failed" (FN-4813 production failure).

  2. **Collapsed broken FN-4806 nested branches.** The previous FN-4806 refactor accidentally nested the genuine "agent finished without calling fn_task_done" failure path inside the silent-recovery branch, so ordinary failures were being silently requeued instead of marked failed. Restored the clean two-branch structure: `else if (retryAbortedDueToReclaim)` silent-recovers, `else` marks failed/onError/burns budget. Also clears `baseCommitSha` on silent recovery (matches the parallel session-start-failure path).

- b2ca02f: Add multi-node coordination hardening for task execution: distributed checkout claim mutex (`tryClaimCheckout`) with node/epoch preconditions, configurable `owningNodeHandoffPolicy` behavior for unavailable owners, and a supported `transitionProjectIsolation` path that can restart project runtimes (with rollback when active-task restart is blocked). Reaffirm scheduler failover and live process migration as explicit non-goals in mesh/multi-project docs.
- 199f317: Add central `taskClaims` table (central DB schema v13) and route `AgentStore.checkoutTask` through it when a `CentralClaimStore` is configured, providing the authoritative cross-node task-claim mutex required by FN-4819 §2. Single-node behavior is unchanged when no claim store is wired.
- 8e3a635: Add a new `task:auto-recover-node-unreachable` run-audit mutation type and emit it across unreachable-owner recovery flows, including mesh lease recovery outcomes and scheduler owning-node handoff decisions.
- df998cb: Add create-time duplicate detection to dashboard task creation. The dashboard now exposes `POST /api/tasks/duplicate-check`, returns `409 duplicate_candidates` for conflicting `POST /api/tasks` requests unless callers acknowledge matches, and supports `bypassDuplicateCheck` for opt-out callers.
- 2adc9fa: GitHub Copilot now appears as logged-in in the dashboard usage dropdown when authenticated via Fusion's Settings → Authentication OAuth flow, in addition to the existing `gh` CLI detection.
- aa6d1c9: fix(FN-4847): discard foreign branch and recreate on `branch-conflict-unrecoverable`

  Branch conflicts where the existing `fusion/<task-id>` branch has stranded commits NOT attributed to the task (cross-task contamination residue from the FN-4781/FN-4804/FN-4814 worktree-race era) previously paused the task with `pausedReason: "branch-conflict-unrecoverable"` and the error message `Auto-recovery failed: branch conflict unrecoverable — Branch fusion/fn-XXX is already checked out at /.../ (tip ..., N stranded commits since ...)`. The task got stuck forever waiting for human adjudication.

  The user has explicitly opted into discard-and-recreate for this case: those stranded commits aren't this task's work, just delete them and move on.

  Changes:

  - `auto-recovery.ts:actionForMode` — in `deterministic-only` mode, `branch-conflict-unrecoverable` now returns `"retry"` (was `"pause"`), routing the failure to the handler instead of the pause path.
  - `auto-recovery-handlers/branch-worktree.ts` — `live-foreign` inspection no longer emits `irreducible-pause`. Instead: force-delete the foreign branch + worktree (safely respecting the FN-4811 active-session gate to avoid yanking live sessions), then requeue the task. The executor's next pickup creates a fresh `fusion/<task-id>` worktree with no conflict.
  - New audit event `branch-worktree:foreign-branch-discarded` records the discard with stranded-commit count and live-ownership status.

- 87bd369: Dashboard's Agents, Documents, Todos, and Chat views now hydrate from a local cache on reload, eliminating the brief empty-state flash before data arrives.
- fe2ebfb: Dashboard's Missions, Insights, Research, Evals, and Mailbox views now hydrate from a local cache on reload, eliminating the empty-state flash before data arrives.
- a3e8c8f: Reconcile docs/secrets.md and docs/architecture.md with the FN-4867 secrets sync surfaces that now ship (push/pull/receive/sync-export + fn_secret_get + secrets-env materialization), and add a reliability-interaction backstop for cross-node secrets sync route contracts.
- 2242d5b: Add intake-side auto-archive safeguards: ghost-bug preflight on triage finalize and same-agent duplicate detection at task creation. Both paths are fail-open on errors/timeouts and emit structured activity/audit events when auto-archive triggers.
- 10455b7: Normalize task titles to strip foreign embedded `FN-<id>` tokens during create/update/duplicate/refine flows while preserving duplicate/refine provenance metadata. Also adds schema version 84 migration coverage to clean existing active/archived title-ID drift rows idempotently.
- bfbdacd: Improve duplicate source traceability by preserving and surfacing canonical duplicate lineage fields (`sourceType`, `sourceParentTaskId`, and `sourceMetadata.duplicateOfTaskIds`) in task provenance flows used by CLI and dashboard task detail surfaces.
- 97d92da: Fix: ntfy notifications for `in-review` and merged task events now fire even when notification settings were enabled after the engine started.
- 307cf0c: Fix `/api/health/reliability` per-day rows silently truncating older days on busy projects. Per-day in-review entered/bounced counts and duration samples are now aggregated at the SQL layer instead of pulling up to 50,000 activity-log rows in memory, so the Reliability view shows accurate data for every day in the rolling window.
- 0046fc9: Add deterministic duplicate guard at task intake: identical-content POSTs within a 60s window are rejected with `409 duplicate_candidates` or auto-archived with a `source.sourceMetadata.deterministicDuplicateOf` lineage marker. Complements the existing FN-4829 similarity warning.
- f183186: Dashboard reload no longer shows multi-day-old cached boards. The local stale-while-revalidate cache now respects a 10-minute freshness window for list payloads (tasks, projects, agents, documents, etc.); older entries are skipped and the normal fetch path runs, surfacing the existing top progress indicator. Failed background refreshes keep the indicator visible so the user knows the data hasn't been confirmed fresh.
- 8845964: Fix "Copy code" button on the GitHub Copilot device-code panel (Settings and Onboarding) when the dashboard is served from a non-secure origin (e.g. LAN/HTTP `fn serve`). The button now falls back to a `document.execCommand("copy")` path when `navigator.clipboard` is unavailable and surfaces success/failure via a toast instead of silently no-opping. The auto-copy-on-first-show effect uses the same fallback silently.
- c87e0fc: Harden merge conflict arbitration so Layer 3 AI resolution respects task File Scope by resolving out-of-scope conflicted files to main before AI handling and emitting scope-partition audit events.
- 40ef729: Add a merger auto-prerebase policy that can rebase task branches onto local main before the existing Stage 1/2 rebase cascade when divergence from `task.baseCommitSha` crosses a threshold or touches configured shared-infra hot files. This introduces project settings `prerebaseAutoEnabled`, `prerebaseHotFiles`, and `prerebaseDivergenceThreshold`, and emits run-audit events `merge:auto-prerebase:applied`, `merge:auto-prerebase:skipped`, and `merge:auto-prerebase:failed`.
- d5ed2cd: Reconcile stale task worktree/branch metadata after orphan recovery so the dashboard Changes view shows the correct diffs.
- e0b1e6a: `fn pr create` (and the `fn task pr-create` alias) now support `--draft`, `--no-ai`, and repeatable `--reviewer <login>` flags. Adds a top-level `fn pr` subcommand router. When `--no-ai` is not set, the CLI now reuses the dashboard's AI metadata pipeline to generate the PR title/body — parity with the dashboard `PrCreateModal`. `GitHubClient.createPr` accepts `draft` and `reviewers`.
- be6279f: Fix: ntfy 'merged' notifications now fire for every merge-success path (auto-finalize no-op merges, mergeConfirmed fast-path, PR-strategy merges, and self-healing finalize).
- b9d4bd8: Aligned the no-task heartbeat system prompt and procedures with the ambient tool set injected for no-task runs, and added regression tests to prevent forbidden task-scoped tool references from reappearing.
- 68b5694: Extend the FN-4918 deterministic duplicate guard to the remaining task-creation surfaces: CLI `fn task add` (direct-store, with a new `--no-dedup` flag), engine `createAgentTask` (powers `fn_task_create` and triage subtask splits — duplicate detections now report `Linked existing ...`), and mission feature triage (links to the canonical task on duplicate). Dashboard `POST /api/tasks` now consumes the same shared helper so behavior is identical across surfaces. `InlineCreateCard` gains the duplicate-warning modal already shipped on `QuickEntryBox`.
- 6c1732d: Auto-recover stale pending/running insight runs at dashboard startup and on a periodic sweep so manual runs never hang indefinitely.
- f46629e: Make the FN-4918 deterministic duplicate pre-check fail open: transient store query errors, mutex bookkeeping failures, and leader-lock rejections no longer 500 the `POST /tasks` endpoint. Legitimate 409 `duplicate_candidates` responses are unchanged.
- cc6bd1e: Agent-filed tasks now persist `githubTracking.enabled` when tracking defaults are enabled, so pi/engine-created tasks consistently appear as tracked and trigger GitHub tracking hooks like UI-created tasks.
- 7652bbf: Add an optimistic submit lock to QuickEntryBox so Save/Enter cannot trigger duplicate task creation while duplicate checks or create requests are in flight.
- 012fb17: Soft-delete terminology cleanup: `fn_task_delete` and Fusion skill docs now describe `deleteTask` as a soft delete (row + artifacts preserved, ID reserved) and point users to archive cleanup for the actual hard-removal path.
- 2be6cf2: Add near-duplicate intent guard at task intake: dashboard `POST /api/tasks`
  now rejects new tasks whose route paths, file paths, or identifier tokens
  substantially overlap with an existing active task created in the last 7
  days, returning `409 duplicate_candidates` with `reason: "near-duplicate-intent"`.
  Triage `finalizeApprovedTask` backstops with a File-Scope-aware re-check
  after PROMPT.md is written, auto-archiving the loser with a
  `sourceMetadata.nearDuplicateOf` lineage marker. Layered on top of the
  FN-4918 deterministic and FN-4829 similarity gates; fails open on any error.
- 17eb85e: Fix Fusion pre-commit identity-guard hook leaking install-time task ID across shared git hooks dir; hook is now driven entirely by per-worktree fusion-task-id metadata (lowercased to match canonicalFusionBranchName), so a stale install no longer refuses valid sibling-worktree commits.
- f40accd: Make CLI test suite ~3× faster: add a `replyTimeoutMs` option to `runChatInteractive` so the `--once` timeout test no longer waits a real 30s for "No reply within 30s", and gate the heavyweight esbuild-bundled-plugin integration test behind `FUSION_RUN_SLOW_TESTS=1` (the same install/upgrade logic is covered by mocked unit tests in the same file).
- d467725: Fix slow `fusion` startup that hung on "Starting engine…" while every registered project's engine initialized serially in `Promise.allSettled`. Engine startup now runs in the background — the TUI proceeds immediately, and the existing reconciliation loop plus the server's on-access fast path bring each project's engine up before it's actually needed.
- e5af9c9: Fix Fusion desktop (Electron) packaged builds opening a blank window — or no window at all — on macOS. `run()` is now invoked in packaged builds (where `process.argv[1]` is unset by Electron), and the dashboard client is built with a relative `--base ./` so its `file://`-loaded `index.html` can resolve `./assets/*` from inside the asar.
- 19e2ff0: Fix activity-log triple-write caused by multiple TaskStore instances polling the same SQLite DB. When the dashboard, engine runtime, and per-project stores each `watch()` the same database, every column move was previously recorded once per instance — inflating `task:moved` rows ~3x (146k+/day) and amplifying failure noise. TaskStore now suppresses activity-log writes for events re-emitted from its polling loop, leaving the originating instance as the sole audit writer.
- c4745ca: Fix the main chat composer (ChatView) so the textarea grows in height as the message gets longer, matching QuickChat's behavior. The autosize now runs before the controlled `setMessageInput` (so the height assignment lands in the same frame as the user's keystroke), and the height clamp now has a 40px floor so a 0-scrollHeight measurement never collapses the composer to zero.
- 2d42476: Fire GitHub tracking-issue creation for duplicated and refined tasks. Previously the duplicate/refine routes returned without calling `createTrackingIssueForTask`, relying on TaskStore's hook — but mocked stores in tests (and certain race conditions) could bypass the hook, leaving the new task with no linked tracking issue. The routes now invoke tracking explicitly as a best-effort step after creation, matching the PATCH-with-githubTracking path's behavior.
- ea9ec50: QuickChat session picker now uses the themed dropdown style and includes chat rooms in the switch list.
- 0c139a4: Inline the in-review TaskCard Move dropdown into the meta row when badges are present, while preserving the existing bottom-row fallback when no meta row is rendered.
- 4d99a72: Fix Planning Mode so the loading view can show streamed thinking output during the initial question turn, including buffered SSE thinking events that arrive before the first question event.
- 018bbe4: Add run-audit events `worktree:worktrunk-{install,create,sync,prune,remove}` tied to run/task IDs, completing the worktrunk audit taxonomy alongside the existing `failure` / `fallback-native` events.
- dea319f: Add a Worktrunk integration subsection to Dashboard Settings → Worktrees, including enable/binary path/failure-mode controls and automatic disabling of custom worktrees directory overrides while worktrunk is enabled.
- 7f2412b: Make self-healing maintenance respect worktrunk-managed layouts by deferring native prune/orphan cleanup/worktree-cap sweeps to the active worktrunk backend when enabled, while keeping branch-level reclaim logic unchanged.
- 2fe5166: Add `fn settings set` support for `worktrunk.enabled`, `worktrunk.binaryPath`, and `worktrunk.onFailure`, including parsing, validation, and settings display/help updates.
- 2101740: Fix post-merge metadata consistency by capturing and reconciling landed file lists. Done-task metadata and UI now prefer the final landed diff file set, with executor `modifiedFiles` retained as the in-flight fallback.
- 22dd33c: Done-task "files changed" surfaces now use the lineage-backed `/api/tasks/:id/diff` count and clearly label execution-time/merge-commit fallbacks.
- ef1ce10: Self-healing now auto-requeues `in-review` tasks that failed at session start
  with an unusable-worktree error even when zero step progress was recorded.
  Bounded by a 3-attempt cap; persistent failures stay in `in-review` for
  human inspection.
- 6bb2431: Fix Dockerfile workspace manifest copying to match the current monorepo layout by removing the stale `packages/tui` reference and including plugin/package manifests required for `pnpm install --frozen-lockfile` during image builds. This restores successful `docker build .` behavior without changing runtime features.
- bd3809e: Finalize-to-done now requires ownership evidence: tasks only complete when a task-owned landed commit is proven or when no-op completion is proven against the merge target. Legitimate no-op finalize paths now reconcile stale metadata by clearing inherited `modifiedFiles` and stamping empty `landedFiles` markers. Unproven finalize cases are audit-logged and auto-retried by requeuing to `todo` for fresh execution instead of silently landing as done.
- 73d8cb9: Refinement tasks created via `fn_task_refine` are now prioritized in triage dispatch so they are promoted out of Planning reliably when capacity opens.
- e50a4b5: Dashboard: clicking the room title in a chat room conversation now opens a dropdown to switch to another room.
- 94a3c4f: Self-healing now detects refinement tasks stranded in Planning while the rest of the board progresses, and escalates them into the normal triage path without bypassing manual plan approval.
- 047ad6c: Adds API endpoints to surface and expedite refinement tasks stuck in Planning without bypassing plan-spec or approval gates.
- 7ff4279: Fix: chat and chat-rooms composer now grows to always show entered text.
- caf32fc: Dashboard TUI now yields after startup so the splash paints before blocking init runs, and shows a "Ready in Xs" startup-duration indicator once initialization completes.
- 08bfabd: Fix self-healing stale merge metadata repair so rebase/cherry-pick merges compute shortstat from `rebaseBaseSha..commitSha` instead of tip-only `git show`, preventing correct aggregate stats from being overwritten.
- c7a6d68: Make task worktree liveness checks language-agnostic by removing the root `package.json` requirement. Worktrees are now considered usable based on git integrity (`.git` presence, registration, and `git rev-parse --is-inside-work-tree`), fixing false `not_usable_task_worktree` failures in Python, polyglot, nested-manifest, and empty repositories.
- e1e21f6: Reconcile worktrunk backend path contract: resolve the actual worktree
  path via `git worktree list --porcelain` after `wt switch --create`
  instead of assuming worktrunk uses Fusion's `.worktrees/<task-id>`
  layout. Fixes silent `task.worktree` drift on worktrunk-enabled
  projects.
- 98c88c7: Dashboard UI for the worktrunk install approval: when worktrunk auto-install (FN-4624) is triggered from the dashboard, Fusion now creates a `network_api` approval request visible in the Approvals view. Approving the request runs the install with the gate pre-satisfied; denying it leaves the binary uninstalled.
- 8137920: Quick Chat now reflects the active room context by showing a room badge in the panel header, using a room icon in the session trigger, and updating the composer placeholder to `Message #{roomName}` when chat rooms are enabled with an active room.
- bdda0e2: Codex usage panel now falls back to the Fusion-stored `openai-codex` OAuth credential (`~/.fusion/agent/auth.json`) when the Codex CLI `auth.json` is missing, so Fusion OAuth users no longer see a spurious "run codex to login" error.
- 769afd4: Emit `worktree:worktrunk-install` run-audit events on successful worktrunk auto-install (release-binary or cargo paths), completing the worktrunk audit taxonomy started in FN-4626. Cache hits, `$PATH` resolutions, and `worktrunk.binaryPath` overrides remain silent.
- 7cb81b0: Auto-grow chat-style entry textareas in mailbox compose, planning mode, and agent onboarding so inputs expand while typing up to a max height, matching existing chat composer behavior.
- 8e8c1a2: Lock in defaults: worktrunk integration is off by default (opt-in), and the per-project worktree directory defaults to `<projectRoot>/.worktrees` when `worktreesDir` is unset. Regression tests now guard both invariants.
- 414e62d: Reliability view: headline now shows in-review success rate (e.g. 100.0% when no bounces) instead of the raw failure rate. API field `inReviewFailureRate7d` is unchanged.
- f40f2ba: Widen `resolveWorktreeBackend` to accept an optional `binaryPathResolver`, allow `WorktrunkWorktreeBackend` to be constructed with a lazy resolver in place of a literal path, and finalize the `resolveWorktrunkBinary` return contract (adds `installed-release` / `installed-cargo` source variants and an optional `actionGateContext`). Internal surface widening that unblocks FN-4681's binary-resolver wiring; no runtime behavior change for existing callers.
- dc959a7: Gate `worktrunk.enabled` behind verified binary availability. The dashboard settings API, Settings modal, and CLI now reject or prevent enabling worktrunk until the pinned/selected binary resolves and probe-verifies, while still allowing unconditional disable for recovery.
- a92f9aa: Fix duplicate GitHub tracking issues being filed when a new task is created from the dashboard with linked-issues enabled.
- cc701b2: Fix done-task Files Changed reporting for history-preserving rebase/cherry-pick merges by preferring the `rebaseBaseSha..commitSha` range when lineage aggregation is partial.
- e9403df: Add GitHub tracking indicator/toggle to the quick task entry dropdown — shows project default and overrides for the next task.
- 56f38cf: Consolidate duplicate GitHub tracking wrappers and remove redundant post-create invocations; auth-token behavior preserved via shared helper.
- c6daa5e: Defer the post-create hook (and GitHub tracking issue creation) until the title summarizer settles so linked issues use the AI-summarized title.
- 51c60fe: Settings now provide a tracking-repo picker for both project and global defaults, populated from detected GitHub remotes with a Custom fallback for manual `owner/repo` entry.
- c3651da: Fix dashboard project switching so the selected project no longer reverts to a previously saved project after background project-list polling refreshes.
- f761f77: Make file path mentions clickable in mailbox and quick chat message surfaces so path references open in the dashboard file browser.
- b1209b1: Persist GitHub tracking `enabled: true` on task records as soon as project/task settings resolve tracking to enabled, even when issue creation is deferred. This keeps API-created tasks aligned with default tracking state in dashboard UI and prevents redundant enabled-state rewrites.
- befbc51: Linked GitHub issues are now reliably closed when the corresponding Fusion task completes, including a startup reconciliation pass that catches up on previously missed completions.
- 1e02028: Settings sync diff (manual pull + sync-status) now includes keys present only locally, surfacing local-only drift in the diff output.
- dda600c: Replace dashboard `PrSection` with `PrPanel`, removing the inline PR title/description creation textbox in task details. The new panel focuses on read-only PR visibility (state, checks rollup, review decision, and comments) and keeps creation delegated to the upcoming modal flow (FN-4756/FN-4758) without changing CLI or API surfaces.
- da6598a: PR status badge on task cards now distinguishes draft PRs and surfaces a CI check rollup
  indicator (success / failure / pending) using design-token-only styling that adapts to
  all dark and light themes.
- bba945c: Detect PR merge conflicts via gh PR refresh and route affected tasks through the existing self-healing branch-reclaim path. Adds an optional `mergeable` field on `PrInfo`, a "Retry conflict reclaim" affordance in the PR section, and a new `POST /api/tasks/:id/pr/reclaim-conflict` endpoint.
- 93c3975: Fix missing spinner when creating tasks from Planning Mode. The "Create Single Task", "Break into Tasks", and "Create Tasks" buttons now show an inline loading spinner while the async create/breakdown call is in flight, instead of leaving the user staring at an unchanged button or AI-question copy.
- 424c61f: Dashboard reload now hydrates projects/current-project/tasks from a local stale-while-revalidate cache for instant first paint.
- 2f2f7de: Dashboard now preloads the last-used view's JS chunk during HTML parse for faster reloads.
- fc86c4f: Codex usage stats now prefer the Fusion-stored `openai-codex` OAuth credential and only fall back to `~/.codex/auth.json` when no usable Fusion OAuth credential is available.
- 416bd8b: Speed up Agents API startup paths by batching task-column sanitization and agent run-status aggregation. This removes per-agent task hydration and per-agent recent-run scans from initial Agents view loading.
- 4863e3b: Fix Planning Mode first-question loading so the spinner animates immediately and streamed thinking appears during the initial loading turn, even when the stream connects after early thinking events were buffered.
- 2f2198a: Add worktree teardown cleanup for Fusion-managed secrets env files by deleting only files whose fingerprint still matches the recorded write, and emit cleanup/skip audit events.
- a2710fb: Fix dashboard CLI type compatibility by aligning `hybridExecutor` initialization with `createServer`'s `HybridExecutor | undefined` expectation, and stabilize desktop auto-updater tests that run during workspace verification.
- 0b28388: Fix Quick Chat session dropdown not switching to the picked chat.
- 4691cbe: Fix Quick Chat session dropdown so picking a session option actually switches the visible chat (header label, composer placeholder, message list) and mutually excludes active chat-room selection.
- 7310642: Engine: worktree/branch reclaim during the no-fn_task_done retry loop now silently requeues to `todo` instead of surfacing a `failed` task. Genuine retry exhaustion still fails and counts against the retry cap.
- 42b8eeb: Emit per-attempt run-audit events during merge so the Reliability view's Merge Attempts panel populates.
- 7cd5554: Truncate Plan-Only scope-leak activity-log entries and `fn_task_done` blocking refusal messages to the first 10 off-scope and declared-scope entries with a `… (+N more)` suffix and explicit `total off-scope=` / `total scope=` counters, so large tasks no longer flood the activity log.
- 6fa9aef: Lease recovery is now central-claim-aware: `MeshLeaseManager.recoverAbandonedLease`
  releases the central claim before clearing local task-row lease fields, and
  reconciles split-brain state via `reconcileLeaseRow` on the next scheduler /
  self-healing tick. Owner-offline handoff policy and progress-preserving handoff
  semantics are unchanged. Single-node deployments (no central claim store) keep
  the existing local-only behavior. (FN-4823, FN-4819 §2.5 / §3.3 / §3.6)
- d4c4d6d: Define and test cross-node assignment-wake propagation contract (push / poll fallback / missed-wake reconciliation).
- 9e5a516: Structured `node:handoff:*` and `node:lease:*` run-audit events now accompany existing human-readable task logs for owning-node handoff decisions and abandoned-lease recovery paths. Scheduler dispatch and mesh-lease recovery emit machine-readable metadata for parked, reassign-local, reassign-any, and recovered outcomes so multi-node reliability analysis can query durable telemetry directly.
- 27dd927: Auto-recover native worktree-create failures caused by stale git `index.lock` files. Fusion now classifies stale vs active lock contention, retries creation once after safe stale-lock removal, and emits dedicated `worktree:stale-lock-*` run-audit events for detection and outcome visibility.
- 1e1e6f9: Preserve whitespace between streamed chat chunks so multi-sentence assistant replies render `. ` correctly between sentences in ChatView and QuickChatFAB (recurrence after FN-3817; fix at a different layer in the streaming pipeline).
- 49bc9dd: GET /api/nodes/:id/settings/sync-status now includes an `actionableDenialReason` field
  ("missing-remote-api-key" | "auth-failed" | "unreachable" | "unknown" | null) so
  dashboards can surface why a remote probe failed instead of silently reporting
  `remoteReachable: false` with no diagnosis.
- 5ca8761: Fix Quick Chat room switching so selecting a room renders that room's messages and routes sends, /clear, and /new to the room instead of the previous direct session.
- c1cbb66: Fix active-task diff endpoints to report destination paths for renamed/copied
  files. The in-progress/in-review `/tasks/:id/diff` and `/tasks/:id/file-diffs`
  handlers now pass `-M` to `git diff --name-status` so rename detection no
  longer depends on the consumer's `diff.renames` git config.
- 3ca3b5e: Guard `fn_task_done` against agent-dissent summaries, bulk auto-marking of unreviewed pending steps, and pending REVISE verdicts. These refusals share the existing requeue budget and escalate tasks to in-review when retries are exhausted.
- 248c770: Speed up Agents API boot-path loading by replacing per-request pending approval row scans with an aggregated pending-count query per requester agent. This keeps `/api/agents` responsive on large approval histories and reduces time spent on the initial "Loading agents..." state.
- e0df753: Disabling GitHub tracking on an individual task now durably turns tracking off, unlinks the local tracking issue reference, and prevents immediate re-creation in the same update request.
- 7a6a3d0: Fix Quick Entry GitHub link button: correctly reflects enabled/disabled state from project settings, reliably toggles on click, and shows an unambiguous active visual state.
- ee4652a: Heartbeat agents now detect deictic follow-ups ("create it", "yeah do that") in room threads and either echo the resolved referent before acting or post a single structured clarification reply with inferred options. A new `room:ambiguity:branch` run-audit event records which branch was taken for future tuning.
- a08e944: Inbound node settings sync (`/api/settings/sync-receive`, `/auth-receive`, `/auth-export`) now rejects requests when the local node `apiKey` is empty/missing or the Bearer token is empty, closing an `Authorization: Bearer ` bypass against unconfigured nodes. FN-4868 gap G-01.
- 96a1930: Fix bootstrap-misbinding recovery when a Fusion worktree is already bound to its task branch at the target base SHA (no more `fatal: '<branch>' is already used by worktree` errors during re-anchor).
- 3d0cce7: Self-healing now auto-disposes in-review tasks whose identical stall (same code + reason) repeats past `inReviewStallDeadlockThreshold` (default 3) by pausing the task with `pausedReason="in-review-stall-deadlock"` and emitting a `task:in-review-stall-deadlock-disposed` run-audit event, preventing infinite stall-log churn (e.g., repeated `merge-blocker: Failed to create worktree after 3 attempts` loops).
- a2caac3: Auto-recover in-review and verification-fix tasks whose branch carries only foreign-attributed commits and zero own work (the FN-4860/FN-4875 signature). The engine now classifies foreign-only contamination, re-anchors the branch via `reanchorBranchToBase`, or non-destructively discards the orphan branch/worktree, instead of requiring manual `git worktree remove`/`git branch -D`/sqlite metadata recovery.
- 72834eb: Fix `pi.promptWithFallback` recursion by removing standalone re-dispatch through `session.promptWithFallback`.
- 0dc4c9c: Fix `fn_task_show`, `fn_task_list`, and other pi-extension task tools so they resolve the canonical project root when invoked from inside a Fusion task worktree, instead of binding to a stray worktree-local `.fusion` database.
- f00d732: Expand secret audit taxonomy and harden secret audit payload handling. This adds typed secret mutation coverage (`secret:create`, `secret:update`, `secret:delete`, `secret:read`, approval events, sync events, and env lifecycle events), introduces plaintext-forbidden metadata enforcement via `assertNoSecretPlaintext`, adds non-blocking `SecretsStore` audit emitter hooks for CRUD/read operations, and ensures secret audit emission paths avoid leaking plaintext/ciphertext/nonce fields.
- 5aeb764: Prevent and auto-recover "Refusing to start coding agent in incomplete
  worktree" session-start failures. The worktree-acquisition layer now
  classifies pool-returned and resume worktrees before handing them to the
  executor, and the executor's two `createResolvedAgentSession` call sites
  catch the three `assertValidWorktreeSession` variants in `in-progress`,
  emit `worktree:incomplete-detected` + `worktree:auto-recovered` run-audit
  telemetry, and requeue the task to `todo` via the shared
  `autoRecoverWorktreeSessionStartFailure` helper instead of surfacing the
  error to the user. Bounded by `MAX_WORKTREE_SESSION_RETRIES = 3`.
- e33159e: Ensure GitHub tracking post-create hooks are registered across engine startup entrypoints so agent-created tasks (including `fn_task_create` and `fn_delegate_task`) consistently evaluate default tracking settings and link issues when configured, with improved diagnostics for skipped tracking outcomes.
- 1f8d995: Fixes a runtime crash where `fn_task_list` and `fn_task_show` could throw in heartbeat/no-task contexts when `getProjectRootFromWorktree` drifted at runtime, by adding a safe fallback project-root resolver path in the CLI extension.
- 8d9b893: Fix a daemon startup ordering regression by deferring the peer-exchange global-settings read until after the primary task store is created, resolving `TS2448`/`TS2454` typecheck failures in `packages/cli/src/commands/daemon.ts`.
- 24f5c23: Make `promptSessionAndCheck` transcript diagnostics circular-safe to prevent stack overflows on malformed message metadata.
- 3bbc507: Fix the executor's pre-session worktree liveness assertion firing on
  freshly-created worktrees (Runfusion/Fusion#601). The gate now skips when
  `acquireTaskWorktree` returns `source: "fresh"`, and legitimate failures
  are classified into `missing` / `incomplete` / `unregistered` /
  `outside-work-tree` with a canonicalized registered-paths snapshot in the
  log plus a `worktree:incomplete-detected` run-audit event. The existing
  `taskDoneRetryCount` requeue-to-`todo` contract on this gate is preserved
  unchanged.
- a651e8c: Task cards now prefer showing the clickable linked GitHub issue chip over the plain GitHub import provenance badge when both refer to the same issue.
- d41dc24: Worktree setup now removes `packages/desktop/dist` and `packages/desktop/dist-electron` from acquired task worktrees to avoid carrying stale ~900MB Electron build artifacts across recycled worktrees.
- 14c5a17: Fix contamination auto-recovery nulling `task.worktree` while leaving a live worktree mapped on disk, which triggered transient `no-worktree-no-merge-confirmed` stall signals in the dashboard. The in-line recovery in `executor.ts` now:

  - Runs `autoRecoverCrossContamination` inside the task's worktree (when one exists) so the final `git checkout <branch>` doesn't collide with the branch already being checked out elsewhere — the previous `repoDir: this.rootDir` call would silently fail for any task that had a real worktree.
  - Passes `preserveWorktree: true` when requeueing to `todo`, matching the sibling recovery paths in `auto-recovery-handlers/contamination.ts`, `tryBootstrapMisbindingRecovery`, and self-healing reclaim.

- 93e49b0: Fix desktop app launches on macOS where the process starts but no visible window appears. Window position restore now validates saved coordinates against connected display work areas and drops off-screen positions, and startup explicitly show/focuses the window with a ready-to-show path plus fallback timer.
- 9dfefc5: Closing/deleting the linked GitHub issue when deleting a tracked Fusion task now completes reliably even after the task is removed from the store, including observable success/failure signals and safe post-delete logging behavior.
- 17fafa1: GitHub tracking issues now wait for AI title summarization to settle before filing, ensuring summarized task titles are used consistently.
- 28595f5: Extend FN-4851 fn_task_done refusal guards (pending-code-review-revise, bulk-step-completion-without-review) to the implicit-completion path so agents cannot bypass them by drip-marking every step done via fn_task_update and exiting without calling fn_task_done. Implicit refusals share the existing requeue budget and escalate to in-review on exhaustion.
- c161e62: Prevent cross-branch commit contamination at the source: every task worktree now installs a pre-commit hook that refuses commits when HEAD does not match the worktree's owning task branch (with an allowlist for parallel-step branches). As defense-in-depth, contamination auto-recovery now drops `obviously-misrouted` foreign commits whose task-id attribution and changed-path namespace unambiguously belong to another task (initial heuristic: `.changeset/fn-<that-id>-*`), instead of escalating them to human adjudication.
- 287673c: Engine: `reclaim-stale-active-branches` now defers reclaim when the task has a registered active session, a recent `executionStartedAt`, or a worktree with uncommitted changes. Emits a new `branch:stale-active-reclaim-deferred` run-audit event per deferral. Fixes FN-4924-class loops where executor work was wiped because per-step commits were absent.
- f9f8ca0: Lock in default: `recycleWorktrees` is off by default (opt-in). Regression tests now guard the invariant, and dashboard/docs copy explicitly states the default.
- d856788: Hardened worktree pool leasing with explicit lease ownership tracking, double-lease invariant detection, and `worktree:pool-double-lease-detected` audit emission, plus merger cleanup ordering that detaches and clears task worktree metadata before pooled release.
- 02ba659: Scheduler now prefers runnable todo tasks that unblock the most downstream dependents within the same priority class, so root blockers like FN-4766/FN-4867 stop sitting behind unrelated same-priority work. Urgent tasks still outrank everything.
- 3a3f4ed: Normalize task titles by stripping empty placeholder bracket groups (`()`, `[]`, `{}`) left by FN-token removal and AI-generated blank template slots.
- cfe3532: Fix executor step-order corruption: `fn_review_step` off-by-one when auto-updating step status, `resetStepsIfWorkLost` now recomputes `currentStep` so execution does not resume past wiped work, and `TaskStore.updateStep` refuses out-of-order `done` writes.
- 5a1794f: Wire the redesigned Create-PR modal into the task detail modal and the merge/review tab so
  PrPanel's Create button and a new review-tab Create-PR action open the same flow. Fixes the
  FN-4758 follow-up where PrPanel was mounted with `onRequestCreatePr={undefined}`.
- e5af1f1: Suppress in-review stall surfacing and deadlock auto-disposition when autoMerge is disabled. Tasks on the PR-based review flow no longer get flagged as stalled.
- 6fc0f5c: Engine: self-heal `git worktree add` failures classified as "missing but already registered worktree" by pruning the stale registration and retrying once. Recovery is observable via new run-audit events `worktree:stale-registration-detected`, `worktree:stale-registration-recovered`, `worktree:stale-registration-recovery-failed`.
- 46d0928: Pair raw worktree directory deletions in the engine with best-effort `git worktree prune` to prevent stale admin-entry leaks.
- bed14fd: SelfHealingManager.reapUnregisteredOrphans now defers reaping paths that are bound to a live active session, restoring the FN-4811 guard lost during the auto-archive incident.
- 896ae7a: Fix malformed task titles when foreign FN-XXX tokens are stripped: dangling trailing connective words (e.g. "of", "to", "for") that would otherwise produce fragments like "Close as duplicate of" are now rejected, so token-stripped residuals never persist as task titles.
- f116953: TaskCard in-review Move dropdown is now rendered inline with the file-overlap and queued badges in the meta row, falling back to the bottom action row only when the meta row is not rendered.
- dd78e42: Add `in-review-stalled` backlog-health detector for unpaused in-review tasks quiet past the configurable `inReviewStalledThresholdMs` (default 24h).
- c51d0d9: Restrict rebase-strategy landed-files capture to task-attributable commits and annotate short-circuit/fallback metadata for downstream reconciliation and reporting.
- 6608f21: Fix chat UI losing streamed assistant text when the user leaves and returns to a session mid-generation.
- a6747c1: Tasks moved to done no longer retain stale paused metadata, and `fn task list`
  output suppresses the `(paused)` suffix for terminal (done/archived) tasks. A
  one-shot startup backfill repairs already-drifted rows.
- ba16048: Dashboard: implement missing /api/tasks/:id/pr/generate-metadata, /pr/preflight, and /pr/options routes so the Create PR dialog populates AI title/body, preflight checks, and base-branch/reviewer/label dropdowns.
- 041eb4b: Chat and QuickChat composers now grow up to 640px so pasted multi-paragraph
  text stays visible without forcing the user to scroll inside the textarea.
- bb34033: Treat in-review as terminal-until-merged when autoMerge is disabled. All lifecycle-mutating self-healing sweeps now short-circuit on autoMerge=false so PR-based review tasks are no longer kicked back to todo, marked failed, or re-finalized by recovery loops.
- 6d68c2d: Align MessageComposer, PlanningModeModal, and AgentOnboardingModal autosize
  caps to 640px (and SummaryView expanded mode to 800px) so pasted multi-paragraph
  content stays visible without internal scroll, matching the FN-5146 chat
  composer convention.
- 7dafde4: Refuse bootstrapping a nested Fusion project from a linked git worktree when the parent repository already has `.fusion/fusion.db`, and allow an explicit override with `FUSION_ALLOW_NESTED_PROJECT=1`.
- 6b24b56: Add durable mergeQueue table (schema v89) and TaskStore lease API (enqueue / acquireLease / releaseLease / recoverExpiredLeases) as the foundation for FN-5240 in-review handoff durability. No engine behavior change yet; merger/executor wiring lands in FN-5241/FN-5243.
- a164e84: Harden `fusion.db` against process crashes: switch `PRAGMA synchronous` from `NORMAL` to `FULL` and restore the default `wal_autocheckpoint = 1000` (was 100). Repeated node:sqlite SIGSEGVs inside `pager_write` had been corrupting the db; the previous settings left a wide window for torn pages whenever a writer crashed mid-checkpoint. The small fsync cost is worth the durability win.
- d9214b6: PR conflict diagnostics: capture the conflicting file list and a project-strategy-aware suggested command sequence on `PrInfo.conflictDiagnostics` at PR refresh time, and surface them in the dashboard PR panel with a copy-to-clipboard affordance and re-check button.

### runfusion.ai

#### Patch Changes

- Updated dependencies [3ea9bbb]
- Updated dependencies [e1bda2a]
- Updated dependencies [73b4717]
- Updated dependencies [fa9648b]
- Updated dependencies [3ff683a]
- Updated dependencies [41ceae0]
- Updated dependencies [aeada25]
- Updated dependencies [7c15be8]
- Updated dependencies [7805645]
- Updated dependencies [5253cc1]
- Updated dependencies [cc7b9f3]
- Updated dependencies [939b68e]
- Updated dependencies [5975931]
- Updated dependencies [7942fb0]
- Updated dependencies [c7ba63c]
- Updated dependencies [df28dcf]
- Updated dependencies [a88857a]
- Updated dependencies [a27614f]
- Updated dependencies [f7a7038]
- Updated dependencies [2739259]
- Updated dependencies [401094c]
- Updated dependencies [9a1c904]
- Updated dependencies [b772881]
- Updated dependencies [ff71746]
- Updated dependencies [e5c9c7a]
- Updated dependencies [7c0624c]
- Updated dependencies [6721005]
- Updated dependencies [3d7e737]
- Updated dependencies [ae740bd]
- Updated dependencies [db7b196]
- Updated dependencies [b594160]
- Updated dependencies [11012b4]
- Updated dependencies [023a0cc]
- Updated dependencies [c6e9782]
- Updated dependencies [fea0b51]
- Updated dependencies [7ab3f7a]
- Updated dependencies [f0df7cb]
- Updated dependencies [a34e77a]
- Updated dependencies [4d5e296]
- Updated dependencies [246609a]
- Updated dependencies [3f8a5e6]
- Updated dependencies [4c26aa6]
- Updated dependencies [8bef306]
- Updated dependencies [86237c9]
- Updated dependencies [f4aa6d7]
- Updated dependencies [b6df11a]
- Updated dependencies [a1b1f9a]
- Updated dependencies [5c36c0f]
- Updated dependencies [dcd6bf6]
- Updated dependencies [b2ca02f]
- Updated dependencies [199f317]
- Updated dependencies [8e3a635]
- Updated dependencies [df998cb]
- Updated dependencies [2adc9fa]
- Updated dependencies [aa6d1c9]
- Updated dependencies [87bd369]
- Updated dependencies [fe2ebfb]
- Updated dependencies [a3e8c8f]
- Updated dependencies [2242d5b]
- Updated dependencies [10455b7]
- Updated dependencies [bfbdacd]
- Updated dependencies [97d92da]
- Updated dependencies [307cf0c]
- Updated dependencies [dde2d06]
- Updated dependencies [e9ef40f]
- Updated dependencies [0046fc9]
- Updated dependencies [f183186]
- Updated dependencies [8845964]
- Updated dependencies [c87e0fc]
- Updated dependencies [40ef729]
- Updated dependencies [56a7178]
- Updated dependencies [d5ed2cd]
- Updated dependencies [e0b1e6a]
- Updated dependencies [be6279f]
- Updated dependencies [b9d4bd8]
- Updated dependencies [68b5694]
- Updated dependencies [6c1732d]
- Updated dependencies [f46629e]
- Updated dependencies [cc6bd1e]
- Updated dependencies [7652bbf]
- Updated dependencies [012fb17]
- Updated dependencies [2be6cf2]
- Updated dependencies [b078a81]
- Updated dependencies [17eb85e]
- Updated dependencies [f40accd]
- Updated dependencies [d467725]
- Updated dependencies [75a7127]
- Updated dependencies [b143f6c]
- Updated dependencies [e5af9c9]
- Updated dependencies [19e2ff0]
- Updated dependencies [c4745ca]
- Updated dependencies [2d42476]
- Updated dependencies [edfd6e4]
- Updated dependencies [ea9ec50]
- Updated dependencies [9e87de0]
- Updated dependencies [0c139a4]
- Updated dependencies [4d99a72]
- Updated dependencies [9574ba4]
- Updated dependencies [9ac503f]
- Updated dependencies [3d9260e]
- Updated dependencies [06810e4]
- Updated dependencies [8b371ba]
- Updated dependencies [018bbe4]
- Updated dependencies [dea319f]
- Updated dependencies [7f2412b]
- Updated dependencies [2fe5166]
- Updated dependencies [196b7e4]
- Updated dependencies [4ce58f2]
- Updated dependencies [2101740]
- Updated dependencies [22dd33c]
- Updated dependencies [ef1ce10]
- Updated dependencies [6bb2431]
- Updated dependencies [bd3809e]
- Updated dependencies [73d8cb9]
- Updated dependencies [e50a4b5]
- Updated dependencies [94a3c4f]
- Updated dependencies [047ad6c]
- Updated dependencies [7ff4279]
- Updated dependencies [caf32fc]
- Updated dependencies [08bfabd]
- Updated dependencies [c7a6d68]
- Updated dependencies [c0f9dde]
- Updated dependencies [43ae0ee]
- Updated dependencies [e1e21f6]
- Updated dependencies [98c88c7]
- Updated dependencies [3defcbe]
- Updated dependencies [8137920]
- Updated dependencies [bdda0e2]
- Updated dependencies [769afd4]
- Updated dependencies [7cb81b0]
- Updated dependencies [8e8c1a2]
- Updated dependencies [414e62d]
- Updated dependencies [f40f2ba]
- Updated dependencies [b94eae4]
- Updated dependencies [6afd273]
- Updated dependencies [dc959a7]
- Updated dependencies [a92f9aa]
- Updated dependencies [cc701b2]
- Updated dependencies [e9403df]
- Updated dependencies [56f38cf]
- Updated dependencies [c6daa5e]
- Updated dependencies [51c60fe]
- Updated dependencies [c3651da]
- Updated dependencies [f761f77]
- Updated dependencies [293441a]
- Updated dependencies [b1209b1]
- Updated dependencies [befbc51]
- Updated dependencies [1e02028]
- Updated dependencies [dda600c]
- Updated dependencies [7b48387]
- Updated dependencies [da6598a]
- Updated dependencies [0338b37]
- Updated dependencies [bba945c]
- Updated dependencies [3e944ed]
- Updated dependencies [93c3975]
- Updated dependencies [424c61f]
- Updated dependencies [2f2f7de]
- Updated dependencies [fc86c4f]
- Updated dependencies [416bd8b]
- Updated dependencies [4863e3b]
- Updated dependencies [937bed9]
- Updated dependencies [2f2198a]
- Updated dependencies [a2710fb]
- Updated dependencies [0b28388]
- Updated dependencies [4691cbe]
- Updated dependencies [7310642]
- Updated dependencies [42b8eeb]
- Updated dependencies [7cd5554]
- Updated dependencies [6fa9aef]
- Updated dependencies [d4c4d6d]
- Updated dependencies [9e5a516]
- Updated dependencies [27dd927]
- Updated dependencies [1e1e6f9]
- Updated dependencies [49bc9dd]
- Updated dependencies [5ca8761]
- Updated dependencies [c1cbb66]
- Updated dependencies [3ca3b5e]
- Updated dependencies [248c770]
- Updated dependencies [e0df753]
- Updated dependencies [7a6a3d0]
- Updated dependencies [01276d6]
- Updated dependencies [ee4652a]
- Updated dependencies [a08e944]
- Updated dependencies [96a1930]
- Updated dependencies [3d0cce7]
- Updated dependencies [a2caac3]
- Updated dependencies [5233bc9]
- Updated dependencies [72834eb]
- Updated dependencies [0dc4c9c]
- Updated dependencies [f00d732]
- Updated dependencies [5aeb764]
- Updated dependencies [e33159e]
- Updated dependencies [1f8d995]
- Updated dependencies [8d9b893]
- Updated dependencies [24f5c23]
- Updated dependencies [3bbc507]
- Updated dependencies [a651e8c]
- Updated dependencies [d41dc24]
- Updated dependencies [14c5a17]
- Updated dependencies [93e49b0]
- Updated dependencies [9dfefc5]
- Updated dependencies [17fafa1]
- Updated dependencies [28595f5]
- Updated dependencies [c161e62]
- Updated dependencies [287673c]
- Updated dependencies [f9f8ca0]
- Updated dependencies [d856788]
- Updated dependencies [02ba659]
- Updated dependencies [3a3f4ed]
- Updated dependencies [040a909]
- Updated dependencies [cfe3532]
- Updated dependencies [5a1794f]
- Updated dependencies [f9c0b93]
- Updated dependencies [e5af1f1]
- Updated dependencies [6fc0f5c]
- Updated dependencies [46d0928]
- Updated dependencies [bed14fd]
- Updated dependencies [896ae7a]
- Updated dependencies [f116953]
- Updated dependencies [dd78e42]
- Updated dependencies [c51d0d9]
- Updated dependencies [6608f21]
- Updated dependencies [a6747c1]
- Updated dependencies [ba16048]
- Updated dependencies [041eb4b]
- Updated dependencies [bb34033]
- Updated dependencies [6d68c2d]
- Updated dependencies [7dafde4]
- Updated dependencies [6b24b56]
- Updated dependencies [a164e84]
- Updated dependencies [aad1219]
- Updated dependencies [d9214b6]
  - @runfusion/fusion@0.32.0

## 0.31.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.31.0
- @fusion/engine@0.31.0
- @fusion-plugin-examples/cli-printing-press@0.1.8
- @fusion-plugin-examples/dependency-graph@0.1.22
- @fusion-plugin-examples/roadmap@0.1.10
- @fusion-plugin-examples/cursor-runtime@0.1.10
- @fusion-plugin-examples/droid-runtime@0.1.17
- @fusion-plugin-examples/hermes-runtime@0.2.41
- @fusion-plugin-examples/openclaw-runtime@0.2.41
- @fusion-plugin-examples/paperclip-runtime@0.2.41

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.31.0
- @fusion/dashboard@0.31.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.31.0
- @fusion/pi-claude-cli@0.31.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.31.0

### @runfusion/fusion

#### Minor Changes

- 3d94b54: Persist cumulative active runtime and first-execution wall-clock anchor so
  board cards and Task Detail stats no longer "forget" earlier work when a task
  is moved back to todo and resumed (FN-4595).
- 4f3f153: Add first-class milestone acceptance criteria support across missions: persist `Milestone.acceptanceCriteria`, expose milestone create/update route handling, and add the `fn_milestone_update` tool for partial milestone patches. The dashboard now renders and edits milestone acceptance criteria separately from description/verification semantics.

#### Patch Changes

- f2bd31a: Fix chat room thread freshness by loading the newest message window (`order=desc` tail fetch) while preserving ascending message order in responses, and unify dashboard scoped chat event wiring with the engine's live `ChatStore` instance so agent-posted room messages stream to SSE listeners immediately.
- 60982e6: Fix the executor no-`fn_task_done` retry race with self-healing branch/worktree reclaim by re-validating live worktree/branch bindings before retry sessions and converting missing/incomplete/unregistered worktree session-start failures into clean `todo` requeues with preserved progress.
- 5356cff: Fix GitHub Copilot OAuth login failing with "OAuth provider did not return state in auth URL" on remote (non-localhost) dashboard hosts. Copilot's device-code flow has no redirect callback, so the dashboard now passes its verification URL through unchanged like it already did for Anthropic and OpenAI Codex. The verification page now opens in a new tab and the device-code panel renders as designed.
- a3ff9d0: Add `fn_milestone_update` tool and `acceptanceCriteria` field on milestones.
- f150850: Fix Missions UI false "No assertions defined" signal on milestones whose child features already have populated acceptance criteria. The milestone view now rolls up feature-level `acceptanceCriteria` as read-only "Completion criteria (from features)" when no structured `MissionContractAssertion` rows exist; the empty-state nudge is preserved only for milestones with no completion criteria at any level.
- e0f7bb3: Dashboard: add Reliability view entry to the mobile More sheet so it is reachable on mobile, matching the desktop Header overflow menu.
- 3e9ad89: Tasks manually parked back to Todo now consistently render as paused in TaskCard and TaskDetailModal, and using Unpause clears the `userPaused` latch so scheduler dispatch can resume.
- cb0a606: Dashboard board and list views now refetch tasks once when the user navigates back from another dashboard view, so internal view switches no longer leave task data stale while task SSE was temporarily disabled.
- 268afdd: Fix agent org chart not rendering connector lines between parent and child agents.
- 065674f: Dashboard: agent and project permission editors now list the concrete tools each approval category covers (including web search and task creation) and show which coordination/messaging tools are exempt from approval by design. Project settings now expose the agent provisioning approval policy (`approvalMode`, trusted roles/agents, `alwaysApproveDelete`).
- 8da30b3: Action-gate: `fn_web_fetch` is now classified under the `network_api` approval category, matching `fn_research_run`. Projects with `network_api: require-approval` will now prompt for approval before agents fetch external URLs. Previously fell through to exempt and bypassed the policy (FN-4603).
- 236ce62: Test bootstrap (scripts/ensure-test-artifacts.mjs) now covers @fusion/engine and additional `@fusion-plugin-examples/*` packages so fresh-worktree test runs no longer fail with opaque `Failed to resolve import` errors. Adds package-level `pretest` hooks for the dashboard and dependency-graph plugin, and improves remediation output to name exact missing/stale artifact paths.

### runfusion.ai

#### Patch Changes

- Updated dependencies [f2bd31a]
- Updated dependencies [3d94b54]
- Updated dependencies [60982e6]
- Updated dependencies [5356cff]
- Updated dependencies [a3ff9d0]
- Updated dependencies [4f3f153]
- Updated dependencies [f150850]
- Updated dependencies [e0f7bb3]
- Updated dependencies [3e9ad89]
- Updated dependencies [cb0a606]
- Updated dependencies [268afdd]
- Updated dependencies [065674f]
- Updated dependencies [8da30b3]
- Updated dependencies [236ce62]
  - @runfusion/fusion@0.31.0

## 0.30.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.30.0
- @fusion/engine@0.30.0
- @fusion-plugin-examples/cli-printing-press@0.1.7
- @fusion-plugin-examples/dependency-graph@0.1.21
- @fusion-plugin-examples/roadmap@0.1.9
- @fusion-plugin-examples/cursor-runtime@0.1.9
- @fusion-plugin-examples/droid-runtime@0.1.16
- @fusion-plugin-examples/hermes-runtime@0.2.40
- @fusion-plugin-examples/openclaw-runtime@0.2.40
- @fusion-plugin-examples/paperclip-runtime@0.2.40

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.30.0
- @fusion/dashboard@0.30.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.30.0
- @fusion/pi-claude-cli@0.30.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.30.0

### @runfusion/fusion

#### Minor Changes

- 9db9cfe: Add `--project <id|name>` support to `fn serve` and `fn daemon` for explicit primary project binding.

  Headless startup now resolves its primary engine in this order: CLI `--project`, central `defaultProjectId`, cwd project, then first started engine from the central registry. `serve`/`daemon` no longer require cwd to be a registered project and now only exit when no engines start across the registry.

  Add central `defaultProjectId` persistence so headless nodes can select a default project across restarts.

- e1bc0c2: Add bulk Pause / Unpause / Archive actions to List View bulk edit.
- a9ed315: Add a diagnostic-only stale paused review signal (`task.stalePausedReview`) for paused in-review tasks, including a configurable `stalePausedReviewThresholdMs` setting, self-healing surfacing logs, and dashboard badge/filter/detail visibility for faster operator triage.
- 11d521b: Add a diagnostic task-age staleness signal for `in-progress` and `in-review` tasks, with configurable warning/critical thresholds. Surface stale state in the dashboard with task-card badges, task-detail diagnostics, and a new ListView "Stale only" filter. Add scheduler-side structured stale-threshold log emission and settings for per-column warning/critical thresholds.
- 7a1d39c: Add workflow-step `gateMode` support so steps can run as blocking gates or advisory polish checks.
- bbb6d9c: Fix Google Generative AI custom provider not saving after model detection. The probe endpoint accepted `google-generative-ai` but create/update routes rejected it. Also adds SSRF protection, body validation, and fixes stale type mappings.
- cfeb1f2: Chat-room transcript compaction limits (recent verbatim window, fetch limit,
  summary cap) are now configurable in project settings instead of hardcoded.
  Defaults match prior behavior.
- e1bc0c2: Auto-recover from post-merge audit blocks: programmatic per-file survival check, optional AI-driven restoration pass, and an audit-bounce loop (parallel to conflict bounces) before parking a task as failed. Governed by the new `mergeAuditAutoRecovery` setting (default: `ai-assisted`).
- 1b0f7b1: Add configurable heartbeat scope-discipline modes (`strict`, `lite`, `off`) with a project-level default setting and per-agent runtime override.

  The default remains `strict` so existing installations keep current behavior until explicitly changed.

- 9f24f1b: Add per-task token-budget alerts. Soft cap emits a single notification; hard cap pauses the task with `pausedReason: token_budget_exceeded`. New project/global setting `taskTokenBudget` with optional per-size (S/M/L) overrides; new per-task `tokenBudgetOverride` set on resume. New optional `token-budget` ntfy event.
- 940f701: Trim heartbeat execution prompt sections by template-aware caps, add per-project and per-agent `heartbeatPromptTemplate` controls, emit `prompt-size` heartbeat audit logs, and expose per-agent prompt-size history via `/api/agents/:id/prompt-sizes` with dashboard sparkline visualization.
- b63b721: Add CodeMirror-powered syntax highlighting to the dashboard file browser editor (JS/TS, CSS, JSON, Markdown).
- 216d76d: Add `fn_feature_update` extension tool to edit existing mission feature title/description/acceptance criteria without delete+re-add.
- 7730860: Add `noCommitsExpected` task-level flag so decision-only / evaluation tasks can complete cleanly without tripping the executor's `no_commits` invariant. Triage auto-detects decision-shaped tasks; the flag can also be set manually from the task detail modal and is surfaced as a badge on TaskCard. The existing merger no-op finalization path handles completion.

#### Patch Changes

- ed648b2: Add experiment-session domain model (types, store, SQLite schema) for upstream pi-autoresearch parity. Additive only; no behavior change to the existing research subsystem.
- 79ea9e9: Add experiment executor runtime (init/run/log lifecycle, METRIC parser, async benchmark runner, keep/revert git policy) for upstream pi-autoresearch parity. Additive only; existing research subsystem unchanged.
- 034528c: Add experiment session finalize workflow across engine, CLI, extension, and dashboard API. The workflow previews and finalizes kept experiment runs into reviewable branches from merge-base, with typed error mapping for CLI/API consumers and rollback on partial branch creation failures.
- e5189e3: Test bootstrap (`scripts/ensure-test-artifacts.mjs`) now detects STALE example-plugin
  dist artifacts (`@fusion-plugin-examples/{hermes-runtime,openclaw-runtime,paperclip-runtime}`)
  in addition to missing ones by comparing `src/` mtimes against the oldest `dist/`
  entry artifact. When a rebuild fails, the script emits an actionable remediation
  block (FN-4232) before exiting non-zero so worktree and merger-verification flows
  no longer fail first with opaque Vite "Failed to resolve entry for package" errors.
- 7dc0276: Add a reliability metrics surface with `GET /api/health/reliability` and a new dashboard Reliability view showing in-review failure rate, duration percentiles, and merge-attempt distribution.
- e663a1d: Emit a new run_audit git-domain mutation type, `merge:audit-failure`, for dirty post-merge audit outcomes in the merger path.

  The event metadata now records the audit decision contract: `mode`, `strategy`, `action`, `reason`, `issueCount`, `duplicateSubjectCount`, `touchedFileOverlapCount`, `verificationPassed`, and `auditTargetLabel`. This covers both blocking failures and warn/verified-short-circuit pass-through outcomes so downstream reliability metrics (FN-4360) can source post-merge audit failures from `run_audit` instead of agent-log scraping.

- e964bda: Emit `git` / `merge:file-scope-violation` run_audit event when the merger's file-scope invariant aborts a squash, enabling the `fileScopeInvariantFailuresPerDay` reliability metric.
- 12bdec8: Remove `agentMemoryInclusionMode` from `ProjectSettings` and make memory inclusion mode global-only by default resolution (`agent.runtimeConfig.agentMemoryInclusionMode` → `GlobalSettings.agentMemoryInclusionMode` → default).

  Per-agent `runtimeConfig.agentMemoryInclusionMode` override behavior is unchanged, and `GlobalSettings.agentMemoryInclusionMode` remains the default source when no agent override is set.

  If you previously set `agentMemoryInclusionMode` in project `.fusion/config.json`, move that setting to global `~/.fusion/settings.json`; project-level values are now ignored.

  Also tighten heartbeat memory-mode transition log fallback to use `taskId ?? "heartbeat"`.

- 3ea3da6: Add TaskStore.getExperimentSessionStore() accessor so engine, CLI, and
  dashboard surfaces resolve the ExperimentSessionStore through a single
  canonical entry point (parallels getResearchStore()). Additive; no
  behavior change to existing research or experiment-session code paths.
- 7d67cbb: Consolidate ExperimentSessionStore resolution onto
  TaskStore.getExperimentSessionStore() across the dashboard experiment
  routes, CLI experiment finalize command, and pi-extension tool. Removes
  the temporary FN-4218 fallback shim introduced in FN-4222. Behavior
  unchanged; single canonical store-resolution path.
- b7659f9: Add executor-side scope-leak guard at fn_task_done for Plan-Only (Review Level 1) tasks. Off-scope uncommitted edits now produce a [scope-leak] activity-log entry (default warn) or refuse fn_task_done when planOnlyScopeLeakEnforcement="block". Respects task.scopeOverride and never blocks on git infrastructure failures.
- 3d19aab: Engine: when an in-review task moves to done (auto-merger, self-healing, or manual move), the engine now fans out blockedBy reconciliation and residual branch/worktree cleanup in the same pass instead of waiting for the next periodic self-healing sweep. Prevents FN-4008-class stranded-task incidents.
- c3209aa: Dependency graph view now switches to a vertical orientation on tall or narrow viewports so graph nodes stay reachable on mobile screens.
- 79dac9b: Dashboard: Agents → Org Chart now supports drag-to-pan, wheel/pinch zoom, and a unified zoom toolbar on desktop and mobile. Parent→child connectors are drawn via a measurement-based SVG overlay so they always stay attached, including asymmetric subtrees and single-child chains.
- d4f4733: Fix file browser crash (React error #31) when opening from the desktop Header Files button.
- 4adc182: Suppress false `verification fix finalize failed (fix produced no content)` failures when task content is already on main by adding a last-chance already-landed classification in merger finalize and a new self-healing sweep that recovers misbound in-review branch tips. This also avoids noisy Task Failed notifications for this recovered path and records dedicated audit events for both finalize and self-healing recovery flows.
- 458c234: Enforce `workflow_steps.toolMode="readonly"` as a hard tool allowlist at the engine's agent-session layer. Readonly workflow steps can no longer hold Edit, Write, Bash, or task/agent mutation tools. Steps that attempted to write under `toolMode="readonly"` now fail closed with a `READONLY_VIOLATION` outcome instead of silently staging files.
- 4bafbaf: Fix file browser editor toolbar collapse button so the line-number / word-wrap controls actually hide when collapsed (FN-4480).
- e1bc0c2: Fix false-positive `BranchCrossContaminationError` that paused tasks at start when their stored `baseCommitSha` was stale relative to `main`. The contamination check now computes a fresh merge-base against the integration branch instead of reusing the diff-stable `task.baseCommitSha`, and `captureBaseCommitSha` only preserves a prior stored value when resuming an existing worktree. Diff-base stability across resumed sessions is preserved (FN-4309/FN-4383 behavior unchanged).
- f9af9fc: Add explicit overlap/`blockedBy` bottleneck visibility across scheduler logs and dashboard fan-out surfaces, including de-duplicated scheduler warnings and overlap-specific footer/card/detail summaries.
- 00e2679: Self-healing now auto-promotes tasks with all steps completed out of the `todo`
  column to `in-review` (or `done` for Review Level 0 tasks), preventing finished
  work from being stranded after stuck-task timeouts, ghost-review bounces, or
  merge-failure re-queues.
- d83e4de: Add `fn chat <agent-id>` for interactive REPL conversations with an agent from the CLI. Sends messages via the project's MessageStore (so a running `fn` / `fn serve` engine wakes the agent) and polls for replies.
- ecaeaf0: Engine reliability: durable agents no longer retain a stale Current Task pointer after the task moves to done/archived/todo/triage. A new task-move listener clears agent.taskId in real time, and the self-healing sweep recovers already-drifted records on startup and periodically.
- e1bc0c2: Removed the Plan and Subtask AI-assist buttons from the New Task dialog. The same Plan/Subtask actions remain available in the board quick-entry box and other inline create surfaces.
- e4ea9bf: Harden post-merge audit deterministic short-circuit against HEAD drift by checking both the audited commit tree and task-branch tip tree against verification cache entries.
- 2838df2: Add cache-hit observability surfaces across Fusion: structured `token-cache-metrics` logs during token persistence, a new `GET /api/agents/:id/token-usage` endpoint with windowed summaries, dashboard cache-hit ratio displays, and a new `pnpm fn:cache-stats` CLI report.
- 1696c31: Canonicalize task token usage semantics across heartbeat and executor paths by treating `cachedTokens` as cache-read only, storing cache writes in new `cacheWriteTokens`, and preserving raw `inputTokens`.

  Dashboard token stats now render separate `Cache read` and `Cache write` values.

  Historical rows created before this fix may still contain mixed cache-read+cache-write values inside `cachedTokens`; existing data is not backfilled.

- e1bc0c2: Fix FN-4068 branch-conflict recovery hot loop: prevent repeated "Branch conflict recovery required" emissions and add a per-task tripwire that hard-pauses after 5 repeats.
- 85c6869: Add per-task retry observability and guardrails across core, engine, and dashboard surfaces. Tasks now expose a derived `retrySummary` breakdown (including new branch-conflict recovery, reviewer context retry, and reviewer fallback retry counters), the engine emits structured `retry-burned` logs, and retry caps can hard-fail with `RetryStormError` when `maxTotalRetriesBeforeFail` is exceeded. The dashboard now surfaces retry totals on cards, list view, and task detail breakdowns, and existing databases auto-migrate schema version `72 -> 73` on startup.
- 3869db3: Cache no-task auto-claim candidates project-wide with scheduler-driven invalidation and a 30s TTL snapshot to reduce duplicate board scans. Add `autoClaimCandidatesInPrompt` (project setting + per-agent runtime override) to cap/suppress injected candidate lines in heartbeat prompts, and add a Coordination-only preset in Agent Detail to disable auto-claim for routing-style agents.
- aa2fd6a: Fix self-owned task branch conflicts so dispatch can reclaim an existing task worktree/branch instead of hard-failing with a branch conflict. Add a self-healing sweep that reclaims stranded self-owned branch conflicts for idle todo/in-progress tasks and emits `branch:auto-reclaim` run-audit telemetry including task/branch/worktree/tip/stranded commit metadata. Cross-task (`live-foreign`) branch collisions remain blocked and still require `fn task branch-recovery`.
- 07b16d9: Fix mobile File Browser workspace selector dropdown clipping by removing header overflow clipping in the mobile modal header layout, so the menu can render fully while title/path truncation remains intact.
- e1bc0c2: Revert the Todo aging indicator added in FN-4316. The Todo column header
  no longer shows age-bucket counts or supports click-to-filter by bucket;
  Column rendering and pagination behave exactly as they did before
  FN-4316.
- 65bf8f3: Auto-recover branch cross-contamination when all foreign commits are already upstream, with per-commit classification and a single-shot guard that escalates repeat contamination to paused human adjudication.
- c003f4b: User-initiated drag/move of an in-progress task back to todo now hard-cancels the active executor session, aborts running task work before disposal, and parks the task with `userPaused: true` so scheduler dispatch does not immediately restart it.
- b9fe0f4: Self-healing now emits a `task:auto-recover-already-merged` run-audit event when `SelfHealingManager.recoverAlreadyMergedReviewTasks` finalizes a phantom-merge-guard false positive. Enables the `recoverAlreadyMergedReviewTasksRecoveriesPerDay` reliability metric to be derived from `run_audit_events`.
- 52615b6: Slim task listings now include `githubTracking`, keeping GitHub tracking badges stable on board/list cards across refreshes and updates.
- 2a2c0c9: Fix merger history-preserving cherry-pick fallback handling so empty `-X ours` / `-X theirs` picks are treated as already-on-main no-ops instead of merge conflicts that park tasks.
- 4c4f11b: Fix branch-conflict recovery to treat fully-subsumed branches (no patch-id-unique commits vs main) as safe auto-reclaim cases, and report stranded commit counts using patch-id-aware `git cherry` results instead of stale base ranges. Also preserve dirty worktree changes to `.fusion/recovery/<task>-<timestamp>.patch` before unrecoverable branch-conflict escalation.
- b565fde: Quick Chat now restores the most-recently-active non-archived chat on every open, not just the first open after page load.
- e2e2ca5: Fix dashboard file browser editor rendering both a plain textarea and the
  CodeMirror editor pane simultaneously — only the syntax-highlighted CodeMirror
  pane now renders.
- 4615c48: Self-healing now auto-reclaims paused `branch-conflict-unrecoverable` tasks when the branch/worktree is self-owned, and orphaned `fusion/*` branches with unique commits are rescued as new triage tasks instead of force-deleted.
- 2faf28e: Add editable agent permission policies with project defaults and per-agent overrides, including per-category action-gate dispositions across git writes, file writes/deletes, command execution, network/API, and task/agent mutation.
- cf4723a: Add bootstrap-time branch misbinding recovery for contamination checks. The engine now classifies foreign-only contamination ranges with zero own/non-attributed commits, re-anchors the task branch to its intended base, audits the re-anchor event, and retries safely without pausing. Acquisition now also logs a warning when a `fusion/fn-*` start point resolves to a foreign task-attributed tip so future misbinding incidents are diagnosable.
- ab0dd0e: Self-healing now auto-reclaims `fusion/<task-id>` branches that are still live-mapped to a worktree but have zero unique commits vs `main` by force-removing the stale worktree and deleting the branch, so retry can recreate a clean checkout without manual branch-recovery intervention.
- 9fe8142: Branch-conflict detection now clears stale cached task metadata (`worktree`, `branch`, `baseCommitSha`) when live branch/worktree mappings are missing, and classifies branch tips already reachable from `main` as `tip-already-merged` instead of reporting main's forward progress as stranded commits. This fixes FN-4471-class false-positive `branch-conflict-unrecoverable` parking.
- 8835c68: Auto-grow the QuickChat composer (FAB and room chat) when typed text wraps past one line, matching the full ChatView composer behavior.
- 9214052: Fix permanent-agent and action-gate classification for `fn_post_room_message` so restricted agents can post room replies without spurious approval gating.
- 779e31f: Fix done-task diff display for rebase-merged tasks: persist the rebase base SHA in `MergeDetails` and use `rebaseBaseSha..commitSha` as the diff range so the dashboard Changes tab and task-card file counts match the stored aggregate stats. Squash merges are unaffected.
- 1beb633: Show pending-approval indicator on the Mailbox Approvals tab immediately, not only after opening it.
- decfeba: Fix inconsistent "files changed" counts between TaskCard and the Task Changes tab. (1) Active tasks without a worktree now fetch the same branch-fallback diff for both surfaces. (2) Done-task lineage aggregation now unions per-lineage-commit file sets instead of sweeping the parent..HEAD range, so interleaved non-task commits no longer inflate the count. (3) Additions/deletions counting no longer drops lines that start with `++` or `--`.
- 97f6558: Fix inaccurate "files changed" counts on done tasks. Done-task lineage aggregation now unions per-lineage-commit file sets (instead of sweeping `earliestParent..latestSha`), so interleaved non-task commits no longer inflate the count, and rename/copy entries are deduplicated. Additions/deletions counting no longer drops lines that start with `++` or `--`. Add regression tests in `packages/dashboard/src/__tests__/routes-diff-done-tasks.test.ts` that compare done-task diff stats against real git shortstat outputs for lineage, rename/copy, squash-merge, and `++`/`--` patch content scenarios.
- 1a6e89c: Fix stale "files changed / insertions / deletions" on done tasks when `pushAfterMerge` is enabled. After `pushToRemoteAfterMerge` rebases HEAD, the merger now re-reads `git show --shortstat <postPushSha>` and rewrites `mergeDetails.filesChanged/insertions/deletions` alongside the refreshed `commitSha` (previously only the SHA was updated, leaving pre-rebase squash stats attached to the post-rebase commit). The `recoverDoneTaskMergeMetadata` self-healing pass also now detects and repairs stored stats that disagree with the live commit at the stored SHA, both at startup and during periodic maintenance.
- 816575c: Fix stale "files changed" counts on done task cards. The `/api/tasks/:id/diff`
  endpoint and the TaskCard done-task badge no longer fall back to the stored
  `task.mergeDetails.filesChanged` value, which can be stale after a rebase-and-
  push (see FN-4526). The endpoint now always derives stats from a live
  `git show --shortstat <commitSha>` when a merge SHA is resolvable, and the
  TaskCard treats the endpoint's response — including `0` — as authoritative.
  The stored `mergeDetails.filesChanged` is shown only as a transient placeholder
  while the live fetch is in flight.
- 581b3e7: Dashboard task diff APIs now return destination paths for renamed/copied files and count them once (instead of add+delete pairs) when serving in-progress/in-review tasks via branch-ref fallback.
- 44d9d03: Introduce AutoRecoveryDispatcher and `ProjectSettings.autoRecovery` (mode/perClass/maxRetries) for classifier-driven recovery of reliability-layer failures. Adds new run-audit event types `auto-recovery:classify-decision`, `auto-recovery:retry-issued`, `auto-recovery:ai-session-spawned`, and `auto-recovery:pause-because-destructive-ambiguity`. Default mode preserves prior behavior; `mode: "off"` is byte-identical to legacy parking.
- 71bd971: Add branch/worktree auto-recovery handler that resolves FN-4519-class incidents (ghost worktrees, branch misbinding, stale branch-conflict-unrecoverable parking) by re-running deterministic classification (FN-4499 bootstrap re-anchor, FN-4500 zero-unique-commit reclaim via inspectBranchConflict kinds `stale-resolved` / `fully-subsumed`, FN-4499 `reclaimable`-with-zero-own-commits re-anchor) against live evidence and requeueing through the FN-4534 dispatcher. Adds run-audit events branch-worktree:auto-requeue, branch-worktree:ai-session-spawned, branch-worktree:irreducible-pause. Genuine live-foreign (FN-3936-class) cases continue to pause; userPaused (FN-4429) is preserved; autoRecovery.mode === "off" behavior is byte-identical to legacy parking.
- 38341e9: Auto-recovery: contamination + message-delivery handlers. Adds ContaminationAutoRecoveryHandler (issueRetry for branch-cross-contamination, composes with FN-4499 bootstrap re-anchor and FN-4428 contamination classifier) and MessageDeliveryAutoRecoveryHandler (bounded retry-or-park for fn_send_message / fn_post_room_message inside agent-tools.ts). New ProjectSettings.autoRecovery failure class "message-delivery-failure". New run-audit event types contamination:retry-issued, contamination:irreducible-pause, message-delivery:retry-issued, message-delivery:park. Genuine destructive-ambiguity contamination still pauses; userPaused (FN-4429) is preserved; autoRecovery.mode === "off" is byte-identical to legacy behavior at every wired site.
- cfedb27: Reclaim zero-unique-commit `fusion/<task-id>` branches owned by active tasks with no live worktree (FN-4546).
- 3302612: Dependency graph: fix card overlaps in vertical orientation by laying out rows using measured node heights and anchoring edges to actual card bottoms.
- b08b8c5: Fix syntax highlighting in the dashboard file editor when running in light mode or any non-dark color theme; the editor now also reacts to live theme switches without losing cursor position or unsaved edits.
- 73c17f3: Fix GitHub Copilot OAuth login hanging in Settings and Onboarding. The dashboard now auto-answers the enterprise-domain prompt (defaulting to github.com) and surfaces the device user code + verification URL so users can complete the device-code flow end to end.
- 327c0de: Show the chat-icon unread dot when a new reply arrives in any individual chat session or any chat room (previously only the active individual chat session triggered it).
- f8520fb: Broaden unusable-worktree session-start failure recovery to auto-requeue in-review tasks when coding sessions fail with missing, incomplete, or unregistered git worktree errors.
- b86248e: Widen restart-recovery missing-worktree classification so self-healing also recovers `incomplete worktree` and `unregistered git worktree` session-start failures, matching existing handling for `missing worktree` failures.
- 54ed639: Task cards now show linked GitHub issue, retry count, and execution timing chips on one row with consistent chip sizing and a smaller GitHub icon for visual parity.
- 507a0be: TaskCard in-review Move dropdown now sits in the bottom-right corner of the card.
- 5528113: Fix Task Detail Changes tab to match Task Card file counts for done tasks that lack a merge commit SHA but still have a server-computable lineage diff, while preserving safe summary fallback when no detailed diff is available.
- 716b9ab: Migrate the six remaining built-in prompt-mode workflow step templates (documentation-review, qa-check, security-audit, performance-review, accessibility-check, browser-verification) to emit the structured {verdict, notes} JSON contract introduced in FN-4367. Fix the frontend-ux-design template's verdict enum to match the parser's accepted set (APPROVE | APPROVE_WITH_NOTES | REVISE). Ships scripts/replace-seeded-workflow-prompts.mjs as a one-off operator tool to bring already-materialized project DB rows (e.g. WS-004) onto the new prompts; the prose-fallback path remains intact for backward compatibility.
- e7348ea: Add structured verdict/notes contract for prompt-mode workflow step output, with backward-compatible prose fallback. Updates WS-006 prompt template (manual operator step to apply via scripts/replace-ws006-prompt.mjs).

### runfusion.ai

#### Patch Changes

- Updated dependencies [ed648b2]
- Updated dependencies [79ea9e9]
- Updated dependencies [034528c]
- Updated dependencies [e5189e3]
- Updated dependencies [9db9cfe]
- Updated dependencies [7dc0276]
- Updated dependencies [e1bc0c2]
- Updated dependencies [e663a1d]
- Updated dependencies [e964bda]
- Updated dependencies [a9ed315]
- Updated dependencies [12bdec8]
- Updated dependencies [3ea3da6]
- Updated dependencies [7d67cbb]
- Updated dependencies [11d521b]
- Updated dependencies [b7659f9]
- Updated dependencies [3d19aab]
- Updated dependencies [c3209aa]
- Updated dependencies [79dac9b]
- Updated dependencies [d4f4733]
- Updated dependencies [4adc182]
- Updated dependencies [7a1d39c]
- Updated dependencies [458c234]
- Updated dependencies [4bafbaf]
- Updated dependencies [e1bc0c2]
- Updated dependencies [bbb6d9c]
- Updated dependencies [f9af9fc]
- Updated dependencies [00e2679]
- Updated dependencies [d83e4de]
- Updated dependencies [cfeb1f2]
- Updated dependencies [ecaeaf0]
- Updated dependencies [e1bc0c2]
- Updated dependencies [e1bc0c2]
- Updated dependencies [e4ea9bf]
- Updated dependencies [2838df2]
- Updated dependencies [1696c31]
- Updated dependencies [1b0f7b1]
- Updated dependencies [9f24f1b]
- Updated dependencies [e1bc0c2]
- Updated dependencies [85c6869]
- Updated dependencies [940f701]
- Updated dependencies [3869db3]
- Updated dependencies [aa2fd6a]
- Updated dependencies [b63b721]
- Updated dependencies [07b16d9]
- Updated dependencies [e1bc0c2]
- Updated dependencies [65bf8f3]
- Updated dependencies [c003f4b]
- Updated dependencies [b9fe0f4]
- Updated dependencies [52615b6]
- Updated dependencies [2a2c0c9]
- Updated dependencies [4c4f11b]
- Updated dependencies [b565fde]
- Updated dependencies [e2e2ca5]
- Updated dependencies [4615c48]
- Updated dependencies [2faf28e]
- Updated dependencies [cf4723a]
- Updated dependencies [ab0dd0e]
- Updated dependencies [9fe8142]
- Updated dependencies [8835c68]
- Updated dependencies [9214052]
- Updated dependencies [779e31f]
- Updated dependencies [1beb633]
- Updated dependencies [decfeba]
- Updated dependencies [97f6558]
- Updated dependencies [1a6e89c]
- Updated dependencies [816575c]
- Updated dependencies [581b3e7]
- Updated dependencies [44d9d03]
- Updated dependencies [71bd971]
- Updated dependencies [38341e9]
- Updated dependencies [cfedb27]
- Updated dependencies [3302612]
- Updated dependencies [b08b8c5]
- Updated dependencies [73c17f3]
- Updated dependencies [327c0de]
- Updated dependencies [f8520fb]
- Updated dependencies [b86248e]
- Updated dependencies [54ed639]
- Updated dependencies [216d76d]
- Updated dependencies [507a0be]
- Updated dependencies [5528113]
- Updated dependencies [716b9ab]
- Updated dependencies [7730860]
- Updated dependencies [e7348ea]
  - @runfusion/fusion@0.30.0

## 0.29.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.29.0
- @fusion/engine@0.29.0
- @fusion-plugin-examples/cli-printing-press@0.1.6
- @fusion-plugin-examples/dependency-graph@0.1.20
- @fusion-plugin-examples/roadmap@0.1.8
- @fusion-plugin-examples/cursor-runtime@0.1.8
- @fusion-plugin-examples/droid-runtime@0.1.15
- @fusion-plugin-examples/hermes-runtime@0.2.39
- @fusion-plugin-examples/openclaw-runtime@0.2.39
- @fusion-plugin-examples/paperclip-runtime@0.2.39

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.29.0
- @fusion/dashboard@0.29.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.29.0
- @fusion/pi-claude-cli@0.29.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.29.0

### @runfusion/fusion

#### Minor Changes

- 00416c2: Add two global settings for AI thinking-log persistence: `persistAgentThinkingLogPermanent` and `persistAgentThinkingLogEphemeral`. Defaults remain unchanged (thinking persistence is still off unless enabled), and legacy `persistAgentThinkingLog` is retained as a backward-compatible fallback when granular keys are unset.
- 8201157: Add a General setting (`ephemeralAgentsEnabled`, default true) to toggle ephemeral task-worker agent usage. When disabled, the scheduler auto-assigns every dispatchable task to a permanent executor based on the agent reporting chain and refuses to spawn `executor-FN-XXXX` workers.
- 5b3c8d3: Add per-agent runtime setting `skipHeartbeatWhenIdle` that pauses scheduled (timer) heartbeats when an agent has no assigned task. Assignment-trigger and on-demand wakeups still fire. Default: off.
- 1b925f1: Add bulk Pause / Unpause / Archive actions to List View bulk edit.
- bbfb2b7: cli-printing-press: contribute script-mode workflow step templates and fix the core
  resolver so plugin-contributed workflow steps honor their declared mode, phase,
  and scriptName instead of being collapsed to prompt-mode.
- 72ccff0: Add `fn chat [agent-id]` for interactive multi-turn chat with an agent from the CLI. Connects to a running `fn dashboard` / `fn serve` over its existing chat HTTP+SSE API and streams responses incrementally. Supports `--session <id>` to resume, `--url` / `--token` / `--no-auth` to target alternate servers, and stdin piping for scripted single-turn messages.
- d4cac08: Add stalled-review detection: in-review tasks repeatedly re-enqueued for merge or hitting invalid-transition recovery loops now surface a "Stalled" badge on the board with the heuristic reason.
- 7d12b9e: Add capacity-risk warning when the Todo queue exceeds the configured threshold and no idle non-ephemeral agents are available. New project setting `capacityRiskTodoThreshold` (default 20). `GET /api/agents/stats` now also returns `idleNonEphemeralCount` and `todoTaskCount`.
- 0e7bd5c: Surface explicit in-review stall reasons. Completed-looking tasks parked in In Review without a matching recovery path now expose a machine-readable `task.inReviewStall` signal (e.g. `transient-merge-status-no-owner`, `merge-retries-exhausted`, `no-worktree-no-merge-confirmed`, `merge-blocker`) and self-healing logs the reason to the task once per stuck-timeout window.
- 076f132: Surface `task.inReviewStall` in the dashboard. In-review tasks whose state matches a known stall code (merge-blocker, transient-merge-status-no-owner, merge-retries-exhausted, no-worktree-no-merge-confirmed) now show a "Stall" badge on the task card and a code-specific diagnostic row in the task detail modal, with a deep-link to the most recent self-healing "In-review stall surfaced" log entry.
- 085c44b: Auto-recover from post-merge audit blocks: programmatic per-file survival check, optional AI-driven restoration pass, and an audit-bounce loop (parallel to conflict bounces) before parking a task as failed. Governed by the new `mergeAuditAutoRecovery` setting (default: `ai-assisted`).
- 7bc58d2: Defer "task failed" push notifications so they only fire when a failure persists. New global settings `failureNotificationDelayMs` (default 30000) and `failureNotificationMode` (default `sticky-only`) gate the behavior; set mode to `all` or delay to `0` to restore legacy immediate dispatch.
- aaed8b9: Stop the post-merge audit from parking tasks as `failed` when deterministic merge verification already proved the resulting tree. Adds `postMergeAuditMode` project setting (`"block"` | `"warn"` | `"off"`, default `"block"`):

  - A `rebase`-strategy audit that flags only touched-file overlap risks now passes through when the merged tree has a verification cache hit — silent drops are impossible by construction in that case.
  - `warn` mode logs audit findings on the agent log but auto-completes the merge.
  - `off` skips the audit entirely.

  Duplicate-subject findings still block in `block` mode and squash-strategy audits still block (no equivalent deterministic guarantee). The FN-3936 silent-drop guard is preserved.

#### Patch Changes

- a35d4dc: Add an Agents Org Chart layout toggle (Horizontal, Vertical, Auto) and persist the selected layout preference per project so users can override automatic layout selection.
- 2ff2c1f: Tighten dashboard chat prompt guidance so agent replies stay short by default, and route genuinely long-form follow-ups to mailbox via `fn_send_message` (`type: "agent-to-user"`, `to_id: "dashboard"`) without duplicating chat content.
- 5225300: Clarify Fusion Research subsystem positioning vs upstream pi-autoresearch.
  Tightens user-facing copy on fn*research*\* tool descriptions, the fn
  research CLI help, and the dashboard Research view to remove false-friend
  expectations with the autonomous experiment loop. No tool, type, table,
  route, or schema renames. No behavior changes. Adds a naming decision
  record at docs/research/naming-decision-2026-05.md.
- b514ed0: Task Review tab: clicking links or code inside a review item's markdown body no longer toggles the item's selection checkbox, and the mobile header actions row now wraps instead of forcing equal-width buttons.
- 53c08b5: Fix clickable file paths reliability by ensuring `FileBrowserProvider` wraps every render branch in `AppInner`, including the loader branch.
- a51d14e: Add a deterministic terminal contract for stuck-loop retry exhaustion. Exhausted tasks are marked failed with a `STUCK_LOOP_EXHAUSTED:` error prefix, receive a final operator guidance log entry, and are untracked by the stuck detector so automatic kill/requeue churn does not continue until the task is manually recovered.
- 6f976d3: `fn serve` and `fn daemon` now auto-register the current directory as a Fusion project on first run, fixing the `No engine started for the current project — exiting` failure in CI/Docker/cron/headless environments. Pass `--no-auto-register` to preserve the previous strict behavior.
- 8e0f3d4: Clickable file path links in dashboard chat, logs, activity log, settings sync log, and task detail now inherit the color and alignment of surrounding text instead of forcing centered info-blue text. The dotted underline and hover/focus affordances are preserved.
- cd7779c: Suppress transient auto-merge failure surfacing: `failed` notifications now wait through a grace window and are dropped when self-healing confirms recovery, while persistent failures still notify. Non-conflict auto-merge failures are now logged to task history instead of persisting a hard-failure user comment.
- 09f4236: Dashboard: GitHub-import provenance in the task detail modal now renders as a compact `owner/repo#NN` link instead of dumping the full issue URL inline. Long research/finding context strings truncate with a tooltip so the header metadata stays scannable on narrow widths.
- b799a4e: Improve workflow-step scope gating for pre-merge checks. The built-in Frontend UX Design workflow step now auto-skips using both diff scope and declared `## File Scope` signals, reducing off-domain runs. Prompt-mode pre-merge workflow steps now perform end-of-step file-scope enforcement with a new `workflowStepScopeEnforcement` project setting (`block` default, `warn`, `off`) and honor task `scopeOverride` bypasses.
- 9e89c3b: Clarify that `ephemeralAgentsEnabled` defaults to `true` for both new projects and upgrades where legacy persisted settings omit the key, while preserving explicit `false` opt-outs.
- c50e152: Fix chat queued follow-up delivery so pending messages auto-send when streaming completes through recovery paths (SSE message-added recovery, polling finalization, and visibility-resume), not only fresh-send onDone/onError handlers.
- 7a9713d: Increase the Settings → Memory editor minimum height on mobile so it stays taller than desktop for easier editing.
- b71371e: Merger now treats history-preserving cherry-picks that are fully duplicated on `main` as a clean no-op: tasks auto-complete to `done` with a clear log message instead of failing as `Auto-merge failed`. Partial duplicate branches also skip only empty cherry-picks and continue landing non-empty commits.
- 95c5340: Fix executor baseCommitSha capture to use the merge-base with main instead of HEAD,
  and preserve an existing valid baseCommitSha across multi-session task work.
  Resolves false `fn_task_done` "no_commits — observed=0" failures on multi-session
  branches (FN-4309).
- 35854e0: Fix false-positive `BranchCrossContaminationError` that paused tasks at start when their stored `baseCommitSha` was stale relative to `main`. The contamination check now computes a fresh merge-base against the integration branch instead of reusing the diff-stable `task.baseCommitSha`, and `captureBaseCommitSha` only preserves a prior stored value when resuming an existing worktree. Diff-base stability across resumed sessions is preserved (FN-4309/FN-4383 behavior unchanged).
- fb50956: Fix executor worktree invariant handling so restart and stale-session recovery paths create fresh sessions correctly without tripping false liveness failures.
- 79cef01: Fix plan-review UNAVAILABLE silently stalling tasks in-progress by retrying reviewer verdict extraction once (preferring validator fallback model) and degrading plan/spec UNAVAILABLE outcomes to advisory when retries are exhausted.
- 7f86215: Add an executor durability guard that prevents silent requeue when a task worktree still has uncommitted attributable changes. Affected recovery/requeue paths now park the task as failed with stranded-worktree diagnostics (including worktree path and recovery hints) instead of dropping back to todo without operator visibility.
- e43cdd2: Engine reliability: fn_task_done now rejects completion when the executor session is not running in the task worktree/branch or has zero commits beyond base, and worktree liveness is asserted before session start. Both failure modes route through the existing auto-retry path so the task returns to todo instead of producing a ghost completion.
- b4b80ac: Keep the GitHub tracking Enable button mounted (and disabled) while a save is in flight so the header layout stays stable.
- bcc0331: Restore the mobile touch-target size on the compact GitHub tracking "Enable" button in the task detail header.
- 459ce24: Fix PluginManager detail header so long plugin error messages wrap instead of truncating to a single line.
- 539c730: Show Web Search as a locked “Always on” row in Project Research settings so the settings surface matches Research view behavior.
- 8e08891: Improve dashboard GitHub tracking UX by disabling the "Create tracking issue" action when a task has no usable title/description and showing clear helper text about when creation will occur. Also make the title summarization model more discoverable by surfacing it when GitHub tracking defaults are enabled and clarifying that the model is used for GitHub tracking issue title summarization.
- fcd70d4: Reset ChatView composer autosize when `messageInput` changes programmatically so send/clear and draft restore paths collapse or clamp textarea height correctly.
- fb50956: Fix workflow live-log pending-state rendering so "Waiting for agent output…" appears when only stale agent log entries exist from earlier runs.
- fb5bf9b: Show a spinner in place of the GitHub tracking Enable button while the linked-status request is in flight, so the row layout stays stable and the pending state is clearly indicated.
- eb1e4e6: Self-healing now clears downstream `blockedBy` fan-out when an `in-review` blocker has been stuck in `status=merging` past a configurable threshold, preventing a single hung merge-verification from freezing the todo lane.
- 86a40dd: Promote the Missions view Drafts section above persisted and standard mission rows so in-progress mission interview drafts are surfaced sooner.
- ca6fe91: Polish Mission Drafts UX by hiding the mission empty state when draft or in-progress interview items are present, and by using labeled draft-row actions (`Resume`/`Generating…`/`Retry` and `Discard`) for clearer interaction.
- e03146f: Fix overlap requeue state reconciliation so durable assigned agents are no longer left in `running` state with stale `executionTaskId` links when their task is requeued in Todo. Adds scheduler rollback plus self-healing backstops for stale running/task-column mismatches.
- 8240a29: Fixes direct-report health classification in heartbeat report summaries to use each report's configured heartbeat interval instead of heartbeat timeout budget. Reports are now marked stale only when heartbeat age exceeds `max(heartbeatIntervalMs × 4, 5 minutes)`, matching the dashboard health semantics and preventing false stale flags for agents still within their scheduled cadence.
- c8a00ad: Run task-scoped heartbeat sessions for permanent (durable) agents inside the task's git worktree, matching ephemeral-agent task execution. No-task heartbeats continue to use the project root.
- 6c0a0f4: Keep the Task Detail modal source issue chevron on the same header row as the source metadata on mobile and narrow layouts.
- b3f9a8a: Fix: enabling GitHub tracking on a task imported from GitHub now creates a tracking issue instead of silently skipping. The board task card shows the tracking-issue link unless it points at the exact same `owner/repo#number` as the imported source issue.
- b5905dc: Polish the SettingsModal research panels by grouping provider controls, clarifying advanced-provider nesting, and aligning project research limits into a responsive grid with regression coverage.
- bd7544f: Fix SettingsModal header layout on narrow phones — header now reflows so the close button stays visible and tappable.
- bb03977: Add a tree-equality fallback to already-merged review-task recovery so retry-exhausted in-review tasks can auto-finalize when task and base branches resolve to identical trees.
- ebc5f70: Reports Health Check now flags a direct report as stale only when its last heartbeat is older than `1.5 × heartbeatIntervalMs`, with a 5-minute minimum threshold floor for agents without a configured interval. This eliminates recurring false positives for long-cadence direct reports while preserving the existing fallback behavior.
- eb015bc: Add an opt-in `capacityRiskBannerEnabled` project setting for the board capacity-risk warning and make the banner dismissible per project, with dismissal reset when the setting is re-enabled or the todo threshold changes.
- 5e564cd: Fix done-task Files changed count and task-detail file list to aggregate across the full landed commit range (via task_commit_associations) instead of only the final merge commit. Restores accurate counts for tasks that land through multiple commits (e.g. rebase-merged tasks with revision commits).
- 039e9a2: Prevented merger squash commits from carrying gitignored files by unstaging ignored paths (including `.fusion/` task artifacts) before writing merge commits.
- f6744e0: Direct chat now always anchors to the latest message when the chat view becomes visible (tab refocus, pageshow, scope switch back from Rooms). Rooms and QuickChat behavior unchanged.
- 6287c14: Removed the Plan and Subtask AI-assist buttons from the New Task dialog. The same Plan/Subtask actions remain available in the board quick-entry box and other inline create surfaces.
- 954ccba: Direct chat ("main chat") now stays pinned to the latest message on mobile when content lays out asynchronously (markdown, code highlighting, attachments, iOS keyboard offset) or when returning to the tab. Rooms and QuickChat behavior unchanged.
- bb0d611: Chat now auto-reconnects when you return to the browser after the tab was suspended mid-generation, instead of showing a Load failed banner.
- 187a029: Normalize task card badge heights so planning, merging, urgent, high, and low pills render at the same height.
- c4e0e25: Fix sporadic disappearance of the GitHub linked-task badge on task cards caused by transient WebSocket null merges, render gating that ignored live/batch badge sources, and badge snapshot loss during viewport unsubscribe/resubscribe cycles.
- 1e4d146: SettingsModal mobile header: keep the GitHub Star, Help, "Settings" title, and close (×) controls on a single row at ≤768px instead of wrapping the action buttons to their own row.
- 48c6343: Prompt users for GitHub tracking issue handling when deleting a task, with explicit options to close, delete, or leave the linked issue unchanged. Also adds `githubIssueAction` plumbing through the API/store and gh-CLI-backed issue deletion support.
- 1291059: Dashboard no longer calls the GitHub API on every board load to refresh PR/issue/tracking-issue status. Cards now render from persisted task state (`prInfo`, `issueInfo`, `githubTracking.issue`) and live WebSocket badge updates, while explicit refresh via `POST /api/github/batch-status` remains available.
- bb65002: Fix FN-4068 branch-conflict recovery hot loop: prevent repeated "Branch conflict recovery required" emissions and add a per-task tripwire that hard-pauses after 5 repeats.
- 1fbfe9f: Validate File Scope entries in PROMPT.md at task-create/update time. Reject git refs (`origin/fusion/fn-4280`), URLs, SHAs, and other non-path tokens with a clear `InvalidFileScopeError`. `parseFileScopeFromPrompt` also silently drops invalid tokens at read time as defense-in-depth, so the file-scope invariant on squash merges is no longer weakened by malformed scope declarations.
- f790436: Revert the Todo aging indicator added in FN-4316. The Todo column header
  no longer shows age-bucket counts or supports click-to-filter by bucket;
  Column rendering and pagination behave exactly as they did before
  FN-4316.
- 3afc086: Quick Chat now reliably restores the most recently active non-archived conversation by session ID when reopened, instead of occasionally landing on an older thread that shares the same target.
- 9ba4ef5: Add targeted self-healing for orphan-only `FileScopeViolationError` failures: when an in-review failed task only staged out-of-scope orphan files and the task's work is positively verified as already landed on the base branch (Fusion-Task-Id lineage checks), Fusion now auto-finalizes the task as a no-op (`orphan-discard-no-op`) and discards orphan staging via worktree cleanup instead of requiring a manual retry click (FN-4350), while preserving FN-4280 guardrails by skipping recovery when landed-work evidence is absent.
- 4334900: Change default `postMergeAuditMode` from `"block"` to `"warn"`. The post-merge audit still runs and findings are still logged on every merge — only the auto-completion gate is relaxed. This avoids FN-4277-class auto-merge failure storms on verified-rebase merges with overlap-only false positives. The file-scope invariant remains a stricter floor. Users who want the previous stricter behavior can set `postMergeAuditMode: "block"` explicitly in `.fusion/config.json`.

### runfusion.ai

#### Patch Changes

- Updated dependencies [00416c2]
- Updated dependencies [a35d4dc]
- Updated dependencies [8201157]
- Updated dependencies [2ff2c1f]
- Updated dependencies [5225300]
- Updated dependencies [b514ed0]
- Updated dependencies [53c08b5]
- Updated dependencies [a51d14e]
- Updated dependencies [6f976d3]
- Updated dependencies [8e0f3d4]
- Updated dependencies [cd7779c]
- Updated dependencies [09f4236]
- Updated dependencies [b799a4e]
- Updated dependencies [9e89c3b]
- Updated dependencies [c50e152]
- Updated dependencies [5b3c8d3]
- Updated dependencies [1b925f1]
- Updated dependencies [7a9713d]
- Updated dependencies [b71371e]
- Updated dependencies [95c5340]
- Updated dependencies [35854e0]
- Updated dependencies [fb50956]
- Updated dependencies [79cef01]
- Updated dependencies [7f86215]
- Updated dependencies [e43cdd2]
- Updated dependencies [bbfb2b7]
- Updated dependencies [72ccff0]
- Updated dependencies [b4b80ac]
- Updated dependencies [bcc0331]
- Updated dependencies [d4cac08]
- Updated dependencies [459ce24]
- Updated dependencies [539c730]
- Updated dependencies [8e08891]
- Updated dependencies [7d12b9e]
- Updated dependencies [fcd70d4]
- Updated dependencies [fb50956]
- Updated dependencies [0e7bd5c]
- Updated dependencies [fb5bf9b]
- Updated dependencies [eb1e4e6]
- Updated dependencies [86a40dd]
- Updated dependencies [ca6fe91]
- Updated dependencies [e03146f]
- Updated dependencies [8240a29]
- Updated dependencies [c8a00ad]
- Updated dependencies [6c0a0f4]
- Updated dependencies [b3f9a8a]
- Updated dependencies [b5905dc]
- Updated dependencies [bd7544f]
- Updated dependencies [076f132]
- Updated dependencies [bb03977]
- Updated dependencies [ebc5f70]
- Updated dependencies [eb015bc]
- Updated dependencies [5e564cd]
- Updated dependencies [039e9a2]
- Updated dependencies [085c44b]
- Updated dependencies [f6744e0]
- Updated dependencies [6287c14]
- Updated dependencies [7bc58d2]
- Updated dependencies [aaed8b9]
- Updated dependencies [954ccba]
- Updated dependencies [bb0d611]
- Updated dependencies [187a029]
- Updated dependencies [c4e0e25]
- Updated dependencies [1e4d146]
- Updated dependencies [48c6343]
- Updated dependencies [1291059]
- Updated dependencies [bb65002]
- Updated dependencies [1fbfe9f]
- Updated dependencies [f790436]
- Updated dependencies [3afc086]
- Updated dependencies [9ba4ef5]
- Updated dependencies [4334900]
  - @runfusion/fusion@0.29.0

## 0.28.1

### @fusion/core

#### Patch Changes

- 681770f: Remove false-positive `committed_reservation_for_existing_id` task-ID-integrity check. The rule flagged every committed reservation that pointed at an existing task, but that's the happy-path steady state — a reservation transitions to `committed` immediately after the task row is inserted, so it's always expected to map to an existing ID. The banner was firing on every healthy node with task history.

### @fusion/dashboard

#### Patch Changes

- 681770f: Remove false-positive `committed_reservation_for_existing_id` task-ID-integrity check. The rule flagged every committed reservation that pointed at an existing task, but that's the happy-path steady state — a reservation transitions to `committed` immediately after the task row is inserted, so it's always expected to map to an existing ID. The banner was firing on every healthy node with task history.
- Updated dependencies [681770f]
  - @fusion/core@0.28.1
  - @fusion/engine@0.28.1
  - @fusion-plugin-examples/cli-printing-press@0.1.5
  - @fusion-plugin-examples/dependency-graph@0.1.19
  - @fusion-plugin-examples/roadmap@0.1.7
  - @fusion-plugin-examples/cursor-runtime@0.1.7
  - @fusion-plugin-examples/droid-runtime@0.1.14
  - @fusion-plugin-examples/hermes-runtime@0.2.38
  - @fusion-plugin-examples/openclaw-runtime@0.2.38
  - @fusion-plugin-examples/paperclip-runtime@0.2.38

### @fusion/desktop

#### Patch Changes

- Updated dependencies [681770f]
  - @fusion/core@0.28.1
  - @fusion/dashboard@0.28.1

### @fusion/engine

#### Patch Changes

- Prevented squash finalization from committing gitignored artifacts by stripping staged ignored paths (for example `.fusion/`, `node_modules/`, and other `git check-ignore` matches) before merge commit creation, including the verification-fix squash-restore path.
- Updated dependencies [681770f]
  - @fusion/core@0.28.1
  - @fusion/pi-claude-cli@0.28.1

### @fusion/plugin-sdk

#### Patch Changes

- Updated dependencies [681770f]
  - @fusion/core@0.28.1

### runfusion.ai

#### Patch Changes

- @runfusion/fusion@0.28.1

## 0.28.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.28.0
- @fusion/engine@0.28.0
- @fusion-plugin-examples/cli-printing-press@0.1.4
- @fusion-plugin-examples/dependency-graph@0.1.18
- @fusion-plugin-examples/roadmap@0.1.6
- @fusion-plugin-examples/cursor-runtime@0.1.6
- @fusion-plugin-examples/droid-runtime@0.1.13
- @fusion-plugin-examples/hermes-runtime@0.2.37
- @fusion-plugin-examples/openclaw-runtime@0.2.37
- @fusion-plugin-examples/paperclip-runtime@0.2.37

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.28.0
- @fusion/dashboard@0.28.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.28.0
- @fusion/pi-claude-cli@0.28.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.28.0

### @runfusion/fusion

#### Minor Changes

- af39d47: Surface in-flight mission interview drafts in the dashboard Missions view, `fn mission list`, and the `fn_mission_list` pi tool. Adds Resume and Discard actions for drafts, plus `GET /api/missions/interview/drafts` and `POST /api/missions/interview/drafts/:sessionId/discard` endpoints.
- db919df: Close the linked GitHub tracking issue (with state_reason "not_planned") when a tracked Fusion task is deleted.
- be5e1fb: Route multi-substantive direct-merge task branches through a history-preserving merge path by default, with new project and per-task controls for forcing squash vs rebase-style commit preservation.
- 044b1cb: Add a new `message:room` notification event for agent assistant replies posted in chat rooms. The event is enabled by default for ntfy notifications and can be tested or toggled from Settings → Notifications alongside the existing direct-message events.
- 7e057a6: Export `DiffVolumeRegressionError`, `MergeAbortedError`, and `SquashAuditError` from `@fusion/engine` so consumers can use `instanceof` checks without deep-importing.

#### Patch Changes

- ad45a23: Merger now refuses to land a squash whose staged diff has zero overlap with the
  task's declared `## File Scope`. Tasks can opt out by setting
  `task.scopeOverride = true` (with optional `task.scopeOverrideReason`).
  Violating squashes leave the task in `in-review` with a structured agent-log
  entry instead of silently shipping out-of-scope changes.
- 37063a0: fn_task_done now appends to the existing task summary when a workflow step
  forces a rerun, instead of overwriting the original completion summary.
- 239f7bf: Chat composer text is now persisted per conversation and recovered across page refreshes.
- a9e2b07: Heartbeat scheduling now auto-reaps stale active heartbeat runs so durable agents recover regular timer ticks without requiring a manual stop/start.
- 4a60568: Restore Quick Chat so reopening the dashboard resumes the most recently updated session instead of always defaulting to the first agent or default model.
- 7a982a2: Fix ntfy notifications so unicode mailbox titles deliver correctly and oversized titles/messages are truncated before publish.
- 917ffa5: Dependency graph: support trackpad/two-finger scroll and mouse wheel to pan when zoomed in. Hold Ctrl/Cmd (or use a trackpad pinch) to zoom.
- 2822781: Task detail Review tab now renders review item bodies as markdown by default, with a Markdown/Plain toggle that persists per user.
- 84ccc47: GitHub tracking 'done' comments now include the merge commit SHA, subject, branch, PR link, file-change stats, and merge timestamp when available.
- f7b12b5: Dashboard now warns before starting OAuth login for providers whose redirect can't reach the dashboard host (Anthropic / OpenAI Codex), reminding users to copy the browser address bar URL before the redirect tab navigates away.
- 056b1a9: Chat room composer now clears immediately when a message is sent and restores the typed text only if the send fails, matching standard chat UX.
- 8653a36: Fix chat room send button on mobile: first touch now sends the message instead of dismissing the keyboard.
- 4a6b561: Auto-open newly created chat rooms in the dashboard so successful room creation immediately reveals the new thread, including collapsing the mobile sidebar.
- bbd92a1: File paths in dashboard chat messages, logs, and task detail markdown are now clickable and open in the integrated file browser.
- 75fe39d: Fix `fn_task_done` failing to clear `paused`/`pausedByAgentId` when called on a paused task (FN-3964). Before this fix, a task with `task.paused=true` in `in-progress` or `todo` would land in a contradictory `todo + paused` state after completion, blocking future scheduler picks. Now the executor always clears task-level pause flags on explicit agent completion.
- acc2db9: Fix GitHub tracking issue creation under gh-cli auth mode (`gh issue create` does not support `--json`); surface tracking creation failures in the task activity log.
- 2881d86: Fix dashboard crash `undefined is not an object (evaluating 'taskIdIntegrity.status')` when the health response lacks `taskIdIntegrity` (e.g. older dashboard server). The banner gate in `App.tsx` now optional-chains `taskIdIntegrity` so the page renders cleanly when the field is missing.
- 6124535: Fix `ENOENT: ... rename 'task.json.tmp' -> 'task.json'` failures when two TaskStore instances (e.g. engine + dashboard server) write to the same task concurrently. The shared `task.json.tmp` filename caused one writer's `rename` to consume the tmp file and the other's to ENOENT. Each write now uses a unique tmp filename (`task.json.<pid>.<uuid>.tmp`) and cleans up its own tmp on rename failure.
- a79dbfc: Fix mobile Safari layout glitch where switching to the Kanban board view could render the dashboard compressed in a corner.
- 75fe39d: Make executor branch-name collisions fail loudly by default, add a legacy opt-in escape hatch, and introduce CLI branch recovery commands for reclaiming or discarding stranded task branches.
- 429bdc2: Merger now detects when the Attempt 3 `-X ours` fallback under
  `mergeConflictStrategy="smart-prefer-main"` would resolve files that main has
  recently modified, and by default prefers the branch side on those overlapping
  files to avoid silently discarding branch work (FN-3936). Configurable via the
  new `mergeStrategyOverlapBehavior` setting (`flip-to-prefer-branch` default,
  `warn-only`, or `ignore`).
- 8b037e4: Add a pre-commit diff-volume gate for auto-resolved squash merges. Fusion now compares each file's staged squash delta against the branch's net delta and blocks the merge in `in-review` when a non-allowlisted file silently loses too much branch content.

  Add three new project settings for tuning the gate: `mergeDiffVolumeMinLines` (default `20`), `mergeDiffVolumeThreshold` (default `0.2`), and `mergeDiffVolumeAllowlist` (default `[]`).

- a136dd3: Stale `blockedBy` markers no longer prevent `fn_task_done`, and self-healing now repairs stale blockers on active `in-progress` and `in-review` tasks as well as `todo` rows.
- 162f4da: Documented the `fn task branch-recovery` CLI flow and the `executorAllowSiblingBranchRename` project setting.
- 759f8f5: Mobile chat composer now renders the agent mention popup above the input.
- 24b839b: Keep chat room threads anchored to the latest message when returning to a room, switching rooms, or resuming the mobile view.
- 8737779: Show the chat sidebar search input on mobile instead of leaving an orphan search icon.
- 203cb16: Simplify the task-card fan-out badge label by dropping the trailing "(N todo)" parenthetical from the visible text while keeping the hover tooltip context intact. The badge count now inherits the same fan-out meta text color as the surrounding label.
- bc5fdd2: Fix the bundled dependency-graph plugin so it no longer lands in a phantom error state in Settings when the Graph view still works, and show the underlying plugin error message in Plugin Manager whenever a plugin is in the error state.
- b387df8: Fix zero-step in-review retry classification to route execution-side failures correctly, closing the remaining gap from PR #59 and crediting HarryCordewener's original workstream.
- 7e089e1: Recover agent/task reassignment sync from upstream PR #58 (author: HarryCordewener). TaskStore.updateTask now keeps agents.taskId aligned with task.assignedAgentId, clears stale checkout leases held by the outgoing agent, and protects against races where the outgoing agent has already moved on.
- 0f5a5b5: Lazy-load `dockerode` for Docker support, with actionable missing-package errors instead of import-time failures. Based on HarryCordewener's work in PR #58 and PR #59.
- 75fe39d: Fix the dashboard Research view layout so the sidebar, reader pane, actions, findings, and stats render cleanly without overlap on desktop and mobile.
- 2d250e6: Keep web search always enabled in the Research view and remove the `none` web-search provider option plus the per-project Web Search source toggle from settings.
- 062b5a9: Mobile swipe-back from chat conversation, mission detail, and planning session detail now returns to the corresponding list instead of escaping the view.
- f8066c4: Default the Settings modal to the General section instead of Authentication when no initial section is specified.
- 0a03ad8: Board task cards now show a GitHub icon when linked to a tracked GitHub issue.
- d899443: Fix: clear task-level pause on `fn_task_done` so explicit agent completions cannot strand tasks in a `paused` state. Hard-pause gating for deferred completion handoff now keys off `globalPause` only.
- c55494e: Add a one-click inline "Enable GitHub tracking" button to the task detail GitHub tracking header when tracking is disabled.
- 08b4af3: GitHub tracking now derives an issue title and transition-comment title from the task description (and, when configured, the AI title summarizer) instead of emitting "Untitled task" when the Fusion task has no title.
- dfb613e: Fix mobile layout of the GitHub tracking enable button on the task detail modal so it stays before the disclosure toggle and no longer overflows narrow screens.
- fd2744a: Shorten the GitHub tracking enable button text to "Enable" and reduce its size in the task detail header.
- e75274e: Fix GitHub tracking state appearing stale/inaccurate on tasks after engine restart.
- 1802fde: Make the GitHub tracking "Enable" button render as a compact header action on desktop while preserving the mobile touch target.
- cec9bcb: Align the Research view provider checklist with the always-on web search behavior from FN-4135 by keeping **Web Search** visible as a locked checked option with an **Always on** affordance.
- 12a08cb: Surface GitHub tracking project options (default on/off for new tasks, default repo) in the project General settings section.
- fbd441e: Surface pending chat-room messages during agent heartbeats and let permanent agents reply with a new `fn_post_room_message` tool.
- 8d48359: Chat rooms now intelligently compact older messages into a summary header
  when transcripts exceed the verbatim window, preserving long-running
  context for agent replies instead of silently dropping earlier turns.
- 8775267: Fix GitHub tracking disclosure icon alignment in task detail — chevron now stays on the first row when summary wraps.
- f397e71: GitHub tracking now waits until a task has a usable title before creating a tracking issue instead of publishing `[FN-XXX] Untitled task` placeholder issues.
- d084ff4: Fix mobile swipe-back from the Planning modal's "New Session" path: opening a new planning session on mobile now registers a back-stack entry so swipe-back returns to the planning sessions list instead of closing the modal.
- bbfd6a9: Raise the dashboard chat composer autosize cap so longer drafts stay readable before scrolling.
- a347871: Detect task-ID allocator integrity anomalies at startup and on demand, log them as structured errors, surface them through /api/health, and render an operator-visible dashboard banner with the affected IDs and recommended next action.
- 72453bb: Permanently-failed `in-review` tasks no longer block overlapping superseding tasks from being dispatched by the scheduler's file-scope overlap guard.
- d301f0b: Keep the GitHub tracking header actions on the same row as the label in the task detail modal.
- 4a6b561: Tighten the Task Detail modal GitHub tracking header into a compact single-row summary with the inline Enable action and disclosure toggle staying aligned across desktop and mobile layouts.
- 55eeb81: Dependency graph: double-tap a task node on mobile to open task detail.
- ac59d5c: Override task-scoped heartbeat procedure files during no-task heartbeats so ambient runs only receive tool-safe prompt guidance.
- 1d87d77: Anchor the GitHub linked/imported indicator icon to the bottom-right corner of dashboard task cards while preserving existing link behavior and accessibility metadata.

### runfusion.ai

#### Patch Changes

- Updated dependencies [ad45a23]
- Updated dependencies [37063a0]
- Updated dependencies [239f7bf]
- Updated dependencies [a9e2b07]
- Updated dependencies [4a60568]
- Updated dependencies [af39d47]
- Updated dependencies [7a982a2]
- Updated dependencies [917ffa5]
- Updated dependencies [2822781]
- Updated dependencies [84ccc47]
- Updated dependencies [f7b12b5]
- Updated dependencies [056b1a9]
- Updated dependencies [8653a36]
- Updated dependencies [4a6b561]
- Updated dependencies [bbd92a1]
- Updated dependencies [db919df]
- Updated dependencies [75fe39d]
- Updated dependencies [acc2db9]
- Updated dependencies [2881d86]
- Updated dependencies [6124535]
- Updated dependencies [a79dbfc]
- Updated dependencies [75fe39d]
- Updated dependencies [be5e1fb]
- Updated dependencies [429bdc2]
- Updated dependencies [8b037e4]
- Updated dependencies [a136dd3]
- Updated dependencies [162f4da]
- Updated dependencies [759f8f5]
- Updated dependencies [24b839b]
- Updated dependencies [8737779]
- Updated dependencies [203cb16]
- Updated dependencies [bc5fdd2]
- Updated dependencies [b387df8]
- Updated dependencies [7e089e1]
- Updated dependencies [0f5a5b5]
- Updated dependencies [75fe39d]
- Updated dependencies [2d250e6]
- Updated dependencies [062b5a9]
- Updated dependencies [f8066c4]
- Updated dependencies [0a03ad8]
- Updated dependencies [d899443]
- Updated dependencies [c55494e]
- Updated dependencies [08b4af3]
- Updated dependencies [dfb613e]
- Updated dependencies [fd2744a]
- Updated dependencies [e75274e]
- Updated dependencies [1802fde]
- Updated dependencies [cec9bcb]
- Updated dependencies [12a08cb]
- Updated dependencies [fbd441e]
- Updated dependencies [044b1cb]
- Updated dependencies [8d48359]
- Updated dependencies [8775267]
- Updated dependencies [f397e71]
- Updated dependencies [d084ff4]
- Updated dependencies [bbfd6a9]
- Updated dependencies [a347871]
- Updated dependencies [72453bb]
- Updated dependencies [d301f0b]
- Updated dependencies [4a6b561]
- Updated dependencies [55eeb81]
- Updated dependencies [7e057a6]
- Updated dependencies [ac59d5c]
- Updated dependencies [1d87d77]
  - @runfusion/fusion@0.28.0

## 0.27.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.27.1
- @fusion/engine@0.27.1
- @fusion-plugin-examples/cli-printing-press@0.1.3
- @fusion-plugin-examples/dependency-graph@0.1.17
- @fusion-plugin-examples/roadmap@0.1.5
- @fusion-plugin-examples/cursor-runtime@0.1.5
- @fusion-plugin-examples/droid-runtime@0.1.12
- @fusion-plugin-examples/hermes-runtime@0.2.36
- @fusion-plugin-examples/openclaw-runtime@0.2.36
- @fusion-plugin-examples/paperclip-runtime@0.2.36

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.27.1
- @fusion/dashboard@0.27.1

### @fusion/engine

#### Patch Changes

- @fusion/core@0.27.1
- @fusion/pi-claude-cli@0.27.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.27.1

### @runfusion/fusion

#### Patch Changes

- c1035d8: Include database integrity health details on `/api/health` with `database.healthy`, `database.lastCheckedAt`, and `database.isRunning`.
- ee46b5a: Fix stale in-review session/worktree recovery so retries discard mismatched persisted session metadata, recover missing-worktree review failures into runnable state, and unblock downstream todo tasks stalled by stale review blockers.
- 4d47cb4: Improve SQLite write reliability under transient multi-connection lock contention by adding bounded recovery for outer write transactions, keeping task mutations and run-audit inserts atomic during executor-driven writes.
- 7b5ec3d: Surface task ID collision errors for task creation and delegation tools.
- fc863f6: Block auto-resolved squash merge completion when the post-squash audit flags duplicate-subject or touched-file overlap risks, while keeping the audit script available for manual follow-up.
- 1a1f60c: Fork workflow revision feedback that escapes a task's declared File Scope into dependent follow-up tasks instead of always appending it to the original task prompt.
- e390478: Add `priority` support to `fn_task_create` across runtime and published extension tool surfaces, with updated Fusion skill docs and references.
- 7ca8d5a: Add optional ntfy access-token settings support so authenticated ntfy topics receive `Authorization: Bearer <token>` on runtime and test notification publishes.
- 9c80988: Task Detail: keep Created/Updated timestamps on a single row on mobile too.
- f3a3975: FN-4082: retry oversized code reviews with a compacted request after provider context-limit errors like Kimi's `exceeded model token limit` failure.
- 06feb61: Improve SQLite write reliability under concurrent executor activity by enforcing WAL/busy-timeout setup on every disk-backed connection, using explicit immediate transactions for task+audit writes, and adding disk-backed concurrent-write regression coverage.
- 5804b86: Fix merger starvation where eligible in-review tasks looped in auto-recovery
  without ever merging. Leaked in-memory merge-queue entries are now reconciled
  automatically, and tasks whose re-enqueue is repeatedly dropped escalate to a
  clear `status=failed` with an `Auto-merge starvation:` error instead of
  looping indefinitely.
- 5bdf92b: Optimize Database.init() schema-compatibility passes: cache per-table PRAGMA results within init and short-circuit unchanged-schema opens via a `schemaCompatFingerprint` in `__meta`. Reduces repeated `db.init()` wall time substantially without weakening the FN-3879/FN-3887/FN-3898 invariant that every declared column exists after init.
- 3ac619d: Fix blank space at the bottom of the New Agent dialog on mobile by removing the inner preset-grid scroll cap so the dialog body scrolls naturally.
- bec0b34: Harden task creation so stale allocator state or colliding reservations fail safely instead of overwriting an existing task row or task directory.

### runfusion.ai

#### Patch Changes

- Updated dependencies [c1035d8]
- Updated dependencies [ee46b5a]
- Updated dependencies [4d47cb4]
- Updated dependencies [7b5ec3d]
- Updated dependencies [fc863f6]
- Updated dependencies [1a1f60c]
- Updated dependencies [e390478]
- Updated dependencies [7ca8d5a]
- Updated dependencies [9c80988]
- Updated dependencies [f3a3975]
- Updated dependencies [06feb61]
- Updated dependencies [5804b86]
- Updated dependencies [5bdf92b]
- Updated dependencies [3ac619d]
- Updated dependencies [bec0b34]
  - @runfusion/fusion@0.27.1

## 0.27.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.27.0
- @fusion/engine@0.27.0
- @fusion-plugin-examples/cli-printing-press@0.1.2
- @fusion-plugin-examples/dependency-graph@0.1.16
- @fusion-plugin-examples/roadmap@0.1.4
- @fusion-plugin-examples/cursor-runtime@0.1.4
- @fusion-plugin-examples/droid-runtime@0.1.11
- @fusion-plugin-examples/hermes-runtime@0.2.35
- @fusion-plugin-examples/openclaw-runtime@0.2.35
- @fusion-plugin-examples/paperclip-runtime@0.2.35

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.27.0
- @fusion/dashboard@0.27.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.27.0
- @fusion/pi-claude-cli@0.27.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.27.0

### @runfusion/fusion

#### Minor Changes

- 2fa4ba9: Add plugin signature verification and publisher trust policy controls across plugin install/load workflows. Plugin status now exposes publisher identity, key fingerprint, and verification state, with new trust-management and verification commands plus project-level `pluginTrustPolicy` enforcement modes (`off`, `warn`, `enforce`).
- 7fd3ccc: Add bundled fusion-plugin-cli-printing-press plugin: a guided wizard for defining external services and generating CLIs from those definitions, plugin-owned dashboard views for managing and manually running generated CLIs, and availability of generated CLIs as pre-merge workflow steps and inside the executor runtime environment.
- bd26b24: Add room-based chat to the dashboard. Users can switch between Direct and Rooms modes in ChatView, create Slack-style rooms (for example `#engineering`) with selected agent members, and chat with multiple agents in shared persisted history. `@mentions` route directly to the named agent, while other room members can respond when relevant.
- 840cd1d: Add a global setting, `persistAgentThinkingLog` (default `false`), to control whether agent thinking/reasoning log rows are persisted. Tool output persistence remains separately controlled by `persistAgentToolOutput`.

#### Patch Changes

- aa031ab: Add a bundled `fusion-plugin-cli-printing-press` plugin with a plugin-owned Create Service wizard view and draft-save API scaffold.
- 0fb9bb5: Add a plugin-owned CLI Printing Press manage view with list/inspect/edit/regenerate/delete draft actions, plus draft update and regenerate API routes backed by the interim JSON draft store.
- 36b6643: Add CLI Printing Press plugin run/test generation and execution actions, including regenerate/run/artifact endpoints, dashboard test-runner UI, and credential redaction for run output.
- 1e76f24: Define and use a canonical SQLite-backed storage/config model for the bundled CLI Printing Press plugin, including service/spec/artifact/credential/settings tables and non-OAuth credential materialization helpers.
- a04b320: Add a new `executorRuntimeEnv` plugin contribution surface so plugins can inject task-scoped runtime environment variables and PATH prepends for executor-spawned commands.

  The bundled `fusion-plugin-cli-printing-press` now contributes generated CLI artifact directories to task PATH and exports `env_var` credentials into the task environment for executor command execution.

- a39985c: Add approval-policy guards for `fn_agent_create` and `fn_agent_delete` with
  `agentProvisioning` project settings, pending-approval outcomes, and approval-route
  execution/audit handling for approved and denied provisioning requests.
- 6b55b26: Update room chat mention UX so the mention popup prioritizes room members (with a member indicator) and rendered room-message mention chips visibly flag non-members, while preserving direct-chat behavior.
- a4617be: Merger verification now runs `scripts/ensure-test-artifacts.mjs` as a preamble
  and self-heals "Failed to resolve entry for package <pkg>" failures by
  rebuilding the missing workspace package once before retrying. Unrecoverable
  environment faults no longer increment `verificationFailureCount` or bounce
  the task to `in-progress` — they remain in-review for the next sweep.
- d6da4eb: Fixes a merger/self-healing recovery loop where in-review tasks with zero commits ahead of base were repeatedly re-enqueued forever. Fusion now detects deterministic no-op merge branches, marks them as no-op merge confirmed, and finalizes them to done instead of requeueing.
- 1257155: Fix phantom-merge guard stranding tasks whose branch content is already on
  main under a different SHA (sibling-task duplication, cherry-pick, prior
  in-merge fix). The merger finalize path now recognizes ancestor and
  equivalent-patch-id branches as a no-op success instead of refusing the
  merge. The FN-1858 phantom-merge guard remains intact for the real-phantom
  case (no recoverable content anywhere).
- 6f2e8c4: Update the default heartbeat procedure to enforce bound-task scope discipline by classifying work as `executor-class`, `blocked`, or `coordination-class`, and steering executor/blocked ticks toward coordination actions instead of implementation advancement. Existing agents that already have seeded per-agent heartbeat files keep their current content until operators explicitly run the heartbeat-procedure upgrade endpoint, which re-seeds from the latest built-in default.
- d1f4d5f: Expose verificationFixRetries (0-3) in Settings → Merge so users can tune in-merge auto-fix attempts without editing JSON.
- 867c684: Fix scheduler overwriting `blockedBy` on queued todo tasks every tick, which caused unrelated work to converge on a single broad-scope in-progress task. Stamping is now sticky-when-still-valid with deterministic tiebreak.
- 3c2f1bd: Post-merge prompt workflow-step agent sessions now honor the assigned agent runtime model (`runtimeConfig.model`) when the workflow step does not provide its own model override, matching the rest of the merger session model resolution path.
- c41d49f: fix(FN-3906): auto-skip the built-in Frontend UX Design pre-merge workflow step when the task diff scope has no frontend/UI files, so non-frontend tasks no longer get stuck behind paused completion handoff deferrals for an irrelevant review gate.
- 7d67dc3: Wire dashboard approval decisions for `agent_provisioning` requests to execute deferred agent create/delete actions.

  Add focused test coverage for provisioning decision routing, policy/gating contracts, and approval request category round-trips.

- 86df0a0: Executor task runtime environment now flows through `createResolvedAgentSession()` and `createFnAgent()` into task-scoped agent subprocesses (including executor-session bash commands). Plugin-provided `executorRuntimeEnv` PATH/env contributions are available inside agent-issued subprocesses while remaining isolated per task/session with no global `process.env` mutation.
- 9b4cf90: Expose `verificationFixRetries` in Dashboard Settings → Merge so users can configure merge verification auto-fix retry attempts.
- e6e596e: Move full SQLite integrity checks off the startup critical path by running `PRAGMA integrity_check(100)` asynchronously after boot. Expose database integrity state on `/api/health` via `database.corruptionDetected`, `database.integrityCheckPending`, and `database.integrityCheckLastRunAt` while preserving existing top-level health fields.
- 0f5c086: Restore the CLI db vacuum command module wiring so tests and runtime command loading succeed.
- e4ec922: Fix `fn db --vacuum` exit handling so successful exits are not caught as VACUUM failures, and await async vacuum errors correctly.
- 6c0cf78: Skip PluginLoader loadability test when dist/index.js is absent (CI shard fix).
- 81f143d: Fix fusion startup crash caused by the roadmap plugin's main entry re-exporting `RoadmapDashboardView`, which transitively imported a `.css` file under Node's tsx ESM loader. The dashboard view is still reachable through the dedicated `./dashboard-view` subpath used by the bundled-view registry.
- 32e76c8: Expose `/api/mesh/state` as a real cluster snapshot API that aggregates peer-local mesh state and powers Nodes topology from actual `knownPeers` relationships instead of fabricated node-list links.
- 3a67c1b: Align the bundled roadmap plugin to the canonical `fusion-plugin-roadmap` runtime id, expose roadmap APIs under `/api/plugins/fusion-plugin-roadmap/...`, and restore `/api/roadmaps` compatibility routing through plugin-owned handlers during migration.
- d0a2d90: Add reports plugin HTML rendering templates, standalone offline export output, and HTML plugin route response support (`headers` + `contentType`) for attachment/preview endpoints.
- 4535db5: Add Reports plugin dashboard view with list/history, filters, detail viewer, and period comparison.
- 63fe25e: Reports plugin: add human approval/publish workflow and share-ready summary blocks (plain text, Markdown, Slack, email HTML) to the dashboard report detail viewer.
- d6d3a29: Quiet benign Claude Code CLI stderr on clean shutdown by routing it to debug-only logs in `pi-claude-cli`.

  This prevents MCP loading/initialization lines from surfacing as warning/error-level entries in the TUI Logs tab when Claude exits cleanly, while preserving warning/error surfacing for non-zero Claude CLI exits and authentication-related failures.

- ef3281b: Preserve whitespace at SSE delta boundaries in dashboard chat streaming so streamed multi-sentence assistant responses render `. ` correctly between sentences in ChatView and QuickChatFAB.
- 9b4cf90: Engine now auto-hydrates each task worktree's `.fusion/fusion.db` with the current task plus transitive dependency rows and their `task_documents` on worktree creation, pool acquire, and resume. Cross-task `sqlite3 .fusion/fusion.db` lookups in PROMPT.md no longer fail silently. Falls through with a warning on any failure; worktree creation is never blocked.
- eb14812: Add automatic recovery for board-level merge deadlocks by promoting retry-exhausted already-landed review tasks to done, clearing stale `blockedBy` references on todo tasks when blockers are terminal or deadlocked, and excluding paused in-review worktrees from scheduler overlap `activeScopes` so paused blockers cannot repeatedly re-stamp downstream tasks.
- 76c113c: Reports plugin: add interim cadence/aggregation/pipeline/runs-store seam exports so downstream tasks (FN-3780+) can plug in real implementations without scaffold churn.
- ef4aeb2: Move agent Run Now control into the agent detail header next to lifecycle buttons.
- d695201: Scheduler now auto-unblocks multi-dependency tasks when any blocker reaches done/archived; self-healing recovers stale queued status.
- d6da4eb: Restore icon on the agent card "Details" button and only hide action labels in the split sidebar when buttons would not fit.
- e4ec922: Allow durable `role: "engineer"` agents to receive explicitly routed implementation tasks via assignment and delegation flows without requiring `override=true`.
- 17ef50f: Align `fn_task_retry` retry classification for `in-review` failures across dashboard and CLI surfaces. Execution-failed review tasks (incomplete steps) now retry back to `todo` with preserved progress, while merge-only failures (all steps done) stay in `in-review` with merge retry state reset. Also removes visible mission validation board-task creation in favor of internal validator runs.
- d7980d5: Surface high fan-out blockers in the dashboard by escalating blocker badges and footer status summaries when a blocker has at least 5 active todo dependents.
- 48aea50: Prevent auto-merge loops on terminal invalid done-transition failures during merge recovery.

  When merge finalization encounters a non-recoverable state-machine error like
  `Invalid transition: 'todo' → 'done'`, auto-recovery now keeps that task parked
  in a stable failed review state instead of repeatedly re-enqueuing it for merge.

  The merge-confirmed fast path also now re-checks task ownership and skips
  finalization if the task has already left `in-review`.

- f6a1862: Add agent provisioning policy plumbing for `fn_agent_create`/`fn_agent_delete`, including
  `agent_provisioning` approval categorization and action-gate classification updates to avoid
  double-approval collisions.
- 4d2f029: Add age-based escalation for high fan-out blockers in the dashboard. High fan-out visibility still appears immediately, and blockers are now explicitly escalated only after they stay in blocking columns past the configurable stale threshold.
- a0c7c33: Expose and honor `override` on `fn_delegate_task` so intentional non-executor delegations work end-to-end for durable agents while preserving default executor-role safeguards.
- be404e5: Harden durable-agent heartbeat timer self-healing by adding scheduler-owned timer registration reconciliation and aligning dashboard dev-mode startup timer eligibility with runtime behavior.
- 858bab2: Consolidate Even Realities plugin support into `fusion-plugin-even-realities-glasses` and remove `fusion-plugin-even-cards` from the active workspace package list to avoid duplicate user-facing integrations.
- c02aade: Reclassify `fn_task_import_github` and `fn_task_import_github_issue` into action-gate task mutation tooling, while keeping permanent-agent classification aligned with task-creation coordination behavior.
- 5640316: Add dashboard support for task lineage commit associations by introducing `GET /api/tasks/:id/commit-associations`, wiring a dedicated client helper, and surfacing confidence-labeled lineage rows in the Task Changes tab.
- 5c3a1df: Memoize startup slim `listTasks` reads across dashboard/engine boot paths to reduce duplicate task-list SQL and JSON parsing work without introducing long-lived stale cache behavior.
- c501e00: Deduplicate background SQLite integrity checks per database path so multi-project dashboard startup no longer stacks repeated `PRAGMA integrity_check(100)` runs against the same `fusion.db`. Health state fanout is preserved for all participating database instances (`integrityCheckPending`, `integrityCheckLastRunAt`, `corruptionDetected`).
- a8b904c: Harden per-worktree DB hydration so missing `.fusion/` scratch state is bootstrapped and retried before degrading with `unable to open database file`.
- 03b8bdb: Add CLI Printing Press to the built-in plugin catalog in Settings so users can discover and install the bundled plugin directly from Plugin Manager.
- 12ae8f7: Improve local dashboard startup by replacing the default full workspace prebuild with a dashboard-client prebuild, adding explicit prebuild modes, and making update notices clearer for source checkouts.
- c303187: Reconcile pull-request merge tasks when GitHub reports the PR merged after a merge command failure.
- 2963923: Add one-click bundled plugin install support for Reports in Settings → Plugins.
- 4205309: Keep stuck task detection active by default with an explicit task-stuck timeout default, without coupling it to workflow step timeout settings.
- 4404c61: Unify local task creation on the distributed task-ID allocator lifecycle and remove runtime reliance on `config.nextId` as an allocation counter. Local allocator state now self-heals on startup by reconciling to existing task IDs for each prefix.

### runfusion.ai

#### Patch Changes

- Updated dependencies [aa031ab]
- Updated dependencies [0fb9bb5]
- Updated dependencies [36b6643]
- Updated dependencies [1e76f24]
- Updated dependencies [a04b320]
- Updated dependencies [a39985c]
- Updated dependencies [6b55b26]
- Updated dependencies [a4617be]
- Updated dependencies [d6da4eb]
- Updated dependencies [1257155]
- Updated dependencies [6f2e8c4]
- Updated dependencies [d1f4d5f]
- Updated dependencies [867c684]
- Updated dependencies [3c2f1bd]
- Updated dependencies [c41d49f]
- Updated dependencies [7d67dc3]
- Updated dependencies [86df0a0]
- Updated dependencies [9b4cf90]
- Updated dependencies [e6e596e]
- Updated dependencies [0f5c086]
- Updated dependencies [e4ec922]
- Updated dependencies [6c0cf78]
- Updated dependencies [81f143d]
- Updated dependencies [32e76c8]
- Updated dependencies [2fa4ba9]
- Updated dependencies [3a67c1b]
- Updated dependencies [7fd3ccc]
- Updated dependencies [d0a2d90]
- Updated dependencies [4535db5]
- Updated dependencies [63fe25e]
- Updated dependencies [bd26b24]
- Updated dependencies [d6d3a29]
- Updated dependencies [ef3281b]
- Updated dependencies [9b4cf90]
- Updated dependencies [eb14812]
- Updated dependencies [76c113c]
- Updated dependencies [ef4aeb2]
- Updated dependencies [d695201]
- Updated dependencies [d6da4eb]
- Updated dependencies [e4ec922]
- Updated dependencies [17ef50f]
- Updated dependencies [d7980d5]
- Updated dependencies [48aea50]
- Updated dependencies [f6a1862]
- Updated dependencies [4d2f029]
- Updated dependencies [a0c7c33]
- Updated dependencies [be404e5]
- Updated dependencies [858bab2]
- Updated dependencies [c02aade]
- Updated dependencies [5640316]
- Updated dependencies [5c3a1df]
- Updated dependencies [c501e00]
- Updated dependencies [a8b904c]
- Updated dependencies [03b8bdb]
- Updated dependencies [840cd1d]
- Updated dependencies [12ae8f7]
- Updated dependencies [c303187]
- Updated dependencies [2963923]
- Updated dependencies [4205309]
- Updated dependencies [4404c61]
  - @runfusion/fusion@0.27.0

## 0.26.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.26.0
- @fusion/engine@0.26.0
- @fusion-plugin-examples/dependency-graph@0.1.15
- @fusion-plugin-examples/roadmap@0.1.3
- @fusion-plugin-examples/cursor-runtime@0.1.3
- @fusion-plugin-examples/droid-runtime@0.1.10
- @fusion-plugin-examples/hermes-runtime@0.2.34
- @fusion-plugin-examples/openclaw-runtime@0.2.34
- @fusion-plugin-examples/paperclip-runtime@0.2.34

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.26.0
- @fusion/dashboard@0.26.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.26.0
- @fusion/pi-claude-cli@0.26.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.26.0

### @runfusion/fusion

#### Minor Changes

- 8c71516: Show downstream blocker fan-out count on the board so high-impact blockers are visible at a glance.

#### Patch Changes

- 6240afe: Fix merger autostash lifecycle cleanup to drop primary and race-rescue stashes on terminal paths, and add startup/periodic stale autostash sweeping with a configurable max-age threshold.
- 7e8541b: Add stash recovery APIs and dashboard surface for listing, diffing, applying, and safely dropping orphaned merger autostashes.
- 6cab8f9: Create a tracking GitHub issue when a Fusion task is created with GitHub tracking enabled. Default is OFF; no GitHub calls are made when tracking is disabled.
- 56c232a: GitHub tracking issues now use the format `[FN-XXXX] Title` for the title and a short plaintext summary prefixed with `Fusion task: FN-XXXX` for the body. The full task prompt is never included and no hyperlink back to Fusion is added.
- ebab75e: Fusion now posts a short comment on the linked GitHub tracking issue when a tracked task moves to in-progress or done. Comments include the Fusion task ID as plain text and never link back to the Fusion app.
- 4450257: Fusion now closes the linked GitHub tracking issue when a tracked task moves to done, and reopens it when the task moves back to an active column. Done → archived leaves the issue closed. Failures are recorded in the task activity log and never block the move.
- 8e9cd1a: Expose per-task GitHub tracking controls in task creation/editing and task detail, including repo override handling, linked-issue display, and manual unlink flow.
- 860d183: GitHub tracking lifecycle now strictly honors the project-level `githubAuthMode`. Token mode requires `githubAuthToken` (or `GITHUB_TOKEN`); gh-cli mode requires an authenticated `gh` CLI. The previous opportunistic fallback no longer applies to tracking issue creation/comments/state sync flows (legacy PR/import flows are unchanged).
- d74197e: Generalize the SQLite schema self-heal pass to reconcile missing columns for every critical table on `Database.init()`, not just `tasks`.

  This prevents legacy or drifted databases from hitting `no such column: <X>` regressions after new column additions, and adds architecture lint coverage to ensure new `CREATE TABLE` definitions are always included in schema-compatibility coverage.

- 4051dab: Merger sessions now honor the assigned agent's `runtimeConfig.model` before falling back to project/global defaults, matching executor and planning lanes.
- d25e8cb: Research now works out of the box using the agent's built-in `WebSearch`/`WebFetch` tools. External search providers (SearXNG, Brave, Google, Tavily) are now optional advanced configuration.
- bcb79d8: Honor task-configured merge targets across CLI and merge completion paths, including PR creation base branch selection and merge metadata resolution.
- 50fdea6: Fix `fn_task_update` (and `fn_task_create`) silently failing with "Agent not found" when callers pass an empty string or the literal string `"null"` to clear a task's agent assignment. Empty/whitespace strings and `"null"` are now normalized to a clear-assignment signal, matching the dashboard `PATCH /api/tasks/:id` contract. JSON `null` continues to work as before.
- 46efd00: Add per-task GitHub tracking fields (enabled flag, optional repo override,
  linked issue metadata) to the Task contract and SQLite store. No user-visible
  behavior yet; surfaced by FN-3870+.
- 00b35b8: Restore ListView bulk-delete: select multiple tasks and delete them together, with archived selections skipped automatically and a per-task force-delete prompt for dependency conflicts.
- ff9fb55: Improve stale dependency unblocking so todo tasks are released promptly when their blocker reaches done or archived, and ensure startup recovery runs the stale `blockedBy` sweep once on boot to repair previously stuck rows. This complements the existing periodic self-heal pass, reducing unblock latency and automatically repairing incidents like dependents remaining blocked after a completed task.
- eea4def: Fix agent sidebar action buttons (Run Now, Pause, Details) overflowing on narrow agent cards by collapsing them to icon-only controls in the sidebar context.
- da101ef: Fix bundled Dependency Graph plugin reliability in the dashboard. Built-in plugin view registration now uses literal-specifier lazy imports so production bundles can resolve and load the bundled graph/roadmap dashboard views instead of falling back to an unavailable placeholder. Plugin install mode now resolves bundled plugin paths server-side when relative `./plugins/...` inputs do not exist under the current working directory, so installing built-in plugins from Settings works reliably across runtime locations.
- 4ccef83: Fix triage planning model selection so project/task planning settings are passed to runtime using the correct default model keys.
- 772c9f6: Hide Chat Rooms behind the `chatRooms` experimental flag. By default, Chat now shows direct-chat-only UI; re-enable rooms via **Settings → Experimental Features → Chat Rooms**.
- f1ece4b: Bundle and auto-install the cli-printing-press plugin with the published CLI.
- 5b15f45: Fix scheduler `blockedBy` propagation so dependency-unblocked todo tasks are not re-pointed to unrelated overlap blockers, and extend stale-blocker recovery to clear corrupted `blockedBy` rows that no longer match unresolved dependencies.

### runfusion.ai

#### Patch Changes

- Updated dependencies [6240afe]
- Updated dependencies [7e8541b]
- Updated dependencies [6cab8f9]
- Updated dependencies [56c232a]
- Updated dependencies [ebab75e]
- Updated dependencies [4450257]
- Updated dependencies [8e9cd1a]
- Updated dependencies [860d183]
- Updated dependencies [d74197e]
- Updated dependencies [4051dab]
- Updated dependencies [d25e8cb]
- Updated dependencies [bcb79d8]
- Updated dependencies [50fdea6]
- Updated dependencies [46efd00]
- Updated dependencies [00b35b8]
- Updated dependencies [ff9fb55]
- Updated dependencies [8c71516]
- Updated dependencies [eea4def]
- Updated dependencies [da101ef]
- Updated dependencies [4ccef83]
- Updated dependencies [772c9f6]
- Updated dependencies [f1ece4b]
- Updated dependencies [5b15f45]
  - @runfusion/fusion@0.26.0

## 0.25.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.25.0
- @fusion/engine@0.25.0
- @fusion-plugin-examples/dependency-graph@0.1.14
- @fusion-plugin-examples/roadmap@0.1.2
- @fusion-plugin-examples/cursor-runtime@0.1.2
- @fusion-plugin-examples/droid-runtime@0.1.9
- @fusion-plugin-examples/hermes-runtime@0.2.33
- @fusion-plugin-examples/openclaw-runtime@0.2.33
- @fusion-plugin-examples/paperclip-runtime@0.2.33

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.25.0
- @fusion/dashboard@0.25.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.25.0
- @fusion/pi-claude-cli@0.25.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.25.0

### @runfusion/fusion

#### Minor Changes

- 15e4336: Add scheduled memory backup feature: project memory (.fusion/memory) and per-agent memory (.fusion/agent-memory) are now snapshotted on a configurable cron schedule with retention pruning. New `fn memory-backup` CLI command and Settings → Backups UI controls.

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [3e64668]
- Updated dependencies [76e6eed]
- Updated dependencies [76e6eed]
- Updated dependencies [76e6eed]
- Updated dependencies [76e6eed]
- Updated dependencies [0b69b99]
- Updated dependencies [f9cba25]
- Updated dependencies [47504ea]
- Updated dependencies [15e4336]
- Updated dependencies [89acfd0]
- Updated dependencies [71bf70f]
- Updated dependencies [d942c0c]
- Updated dependencies [271166a]
- Updated dependencies [76e6eed]
- Updated dependencies [235ba11]
- Updated dependencies [76e6eed]
- Updated dependencies [76e6eed]
- Updated dependencies [76e6eed]
- Updated dependencies [76e6eed]
- Updated dependencies [f182aa3]
- Updated dependencies [2864f70]
- Updated dependencies [e0d9671]
- Updated dependencies [271166a]
- Updated dependencies [985d51c]
- Updated dependencies [00c580d]
  - @runfusion/fusion@0.25.0

## 0.24.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.24.0
- @fusion/engine@0.24.0
- @fusion-plugin-examples/dependency-graph@0.1.13
- @fusion-plugin-examples/roadmap@0.1.1
- @fusion-plugin-examples/cursor-runtime@0.1.1
- @fusion-plugin-examples/droid-runtime@0.1.8
- @fusion-plugin-examples/hermes-runtime@0.2.32
- @fusion-plugin-examples/openclaw-runtime@0.2.32
- @fusion-plugin-examples/paperclip-runtime@0.2.32

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.24.0
- @fusion/dashboard@0.24.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.24.0
- @fusion/pi-claude-cli@0.24.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.24.0

### @runfusion/fusion

#### Minor Changes

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

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [b41cb84]
- Updated dependencies [f8a0903]
- Updated dependencies [a732ebb]
- Updated dependencies [c1ba48f]
- Updated dependencies [9743dab]
- Updated dependencies [c93f61b]
- Updated dependencies [83be577]
- Updated dependencies [d90d665]
- Updated dependencies [955902d]
- Updated dependencies [ceb113c]
- Updated dependencies [fc34a84]
- Updated dependencies [d633981]
- Updated dependencies [d487eea]
- Updated dependencies [9c86771]
- Updated dependencies [0da7aa8]
- Updated dependencies [111ad7a]
- Updated dependencies [18413a1]
- Updated dependencies [12bad74]
- Updated dependencies [de17449]
- Updated dependencies [1abbb10]
- Updated dependencies [36b21af]
- Updated dependencies [ac0606d]
- Updated dependencies [4b6a149]
- Updated dependencies [37913bc]
- Updated dependencies [e7acd27]
- Updated dependencies [a76f06b]
- Updated dependencies [9cc98fd]
- Updated dependencies [82fe24e]
- Updated dependencies [d90d665]
- Updated dependencies [97e039b]
- Updated dependencies [d0b7506]
- Updated dependencies [68eff44]
- Updated dependencies [a9edca6]
- Updated dependencies [7a11a32]
- Updated dependencies [1a0124c]
- Updated dependencies [a466416]
- Updated dependencies [21b7d41]
- Updated dependencies [514e5f3]
- Updated dependencies [d20d45e]
- Updated dependencies [9d1c05a]
- Updated dependencies [b7f68d7]
- Updated dependencies [9e6574c]
- Updated dependencies [dca0789]
- Updated dependencies [12d3f0d]
- Updated dependencies [ea34afa]
- Updated dependencies [92ca3a2]
- Updated dependencies [66c66ec]
- Updated dependencies [f894bdc]
- Updated dependencies [66fa56b]
- Updated dependencies [c38b7cd]
- Updated dependencies [a087aa4]
- Updated dependencies [bbfa5f7]
- Updated dependencies [9b19199]
- Updated dependencies [81da75f]
- Updated dependencies [dcea611]
- Updated dependencies [8bbb734]
- Updated dependencies [4c204c9]
- Updated dependencies [5514d3e]
- Updated dependencies [2b8cbd1]
- Updated dependencies [45fe41c]
- Updated dependencies [966368c]
- Updated dependencies [9f57207]
- Updated dependencies [ae7a607]
- Updated dependencies [5e94151]
- Updated dependencies [f3164b7]
- Updated dependencies [ad34cb6]
- Updated dependencies [a6ec5b9]
- Updated dependencies [1546eaf]
- Updated dependencies [e04af96]
- Updated dependencies [6f0e167]
- Updated dependencies [1148d29]
- Updated dependencies [003e51a]
- Updated dependencies [7d20a34]
- Updated dependencies [de070db]
- Updated dependencies [12bad74]
- Updated dependencies [5bfe126]
- Updated dependencies [8051bea]
- Updated dependencies [8051bea]
- Updated dependencies [b326385]
- Updated dependencies [94a6fe4]
- Updated dependencies [a2258b8]
- Updated dependencies [df6956c]
- Updated dependencies [374d7f7]
- Updated dependencies [0a2f3d6]
- Updated dependencies [2a7a0b0]
- Updated dependencies [c4e0c1d]
- Updated dependencies [90e9dde]
- Updated dependencies [d2d1aad]
- Updated dependencies [f75488d]
- Updated dependencies [6a92d62]
- Updated dependencies [b47f6ff]
- Updated dependencies [e7acd27]
- Updated dependencies [1e80059]
- Updated dependencies [f496716]
- Updated dependencies [3a91534]
- Updated dependencies [6c77915]
- Updated dependencies [5299745]
  - @runfusion/fusion@0.24.0

## 0.23.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.23.0
- @fusion/engine@0.23.0
- @fusion-plugin-examples/dependency-graph@0.1.12
- @fusion-plugin-examples/droid-runtime@0.1.7
- @fusion-plugin-examples/hermes-runtime@0.2.31
- @fusion-plugin-examples/openclaw-runtime@0.2.31
- @fusion-plugin-examples/paperclip-runtime@0.2.31

### @fusion/engine

#### Patch Changes

- @fusion/core@0.23.0
- @fusion/pi-claude-cli@0.23.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.23.0

### @runfusion/fusion

#### Minor Changes

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

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [9be551b]
- Updated dependencies [6f46ab0]
- Updated dependencies [3e68271]
- Updated dependencies [92d40bc]
- Updated dependencies [d791fa9]
- Updated dependencies [74378dc]
- Updated dependencies [c9bbd7d]
- Updated dependencies [35d5590]
- Updated dependencies [2b7b922]
- Updated dependencies [a31c432]
- Updated dependencies [270823d]
- Updated dependencies [a8bfb32]
- Updated dependencies [2fce7b3]
- Updated dependencies [85381df]
- Updated dependencies [8df5d26]
- Updated dependencies [6e38dad]
- Updated dependencies [cabd6be]
- Updated dependencies [fca8d27]
- Updated dependencies [3f5d01f]
- Updated dependencies [4dc91ed]
- Updated dependencies [22250eb]
- Updated dependencies [a143bcc]
- Updated dependencies [923411a]
- Updated dependencies [fd7c88c]
- Updated dependencies [e6dc3c7]
- Updated dependencies [cd845d3]
- Updated dependencies [8f812e2]
- Updated dependencies [9087239]
- Updated dependencies [0d15916]
- Updated dependencies [7f90308]
- Updated dependencies [593b42e]
- Updated dependencies [a14ef9e]
- Updated dependencies [6e8689a]
- Updated dependencies [8c18b45]
- Updated dependencies [1100b39]
  - @runfusion/fusion@0.23.0

## 0.22.0

### @fusion/core

#### Minor Changes

- e658e8e: Decouple permanent agent heartbeats from task state, and add per-agent `allowParallelExecution` setting.

  Heartbeats now run for permanent agents regardless of bound-task block state — the prior early-exit on `queued + blockedBy` is removed along with its dead state-tracking machinery. `HEARTBEAT_SYSTEM_PROMPT` is rewritten to scope heartbeats to ambient coordination (messaging, memory, finding work, delegation, surfacing/chasing blockers, status); task body work continues to run via the executor path. Ephemeral agents are unchanged — they don't run heartbeats and their blocked-task gating in the scheduler is untouched.

  New `allowParallelExecution` flag (default `true`, permanent agents only) on `AgentHeartbeatConfig`. When `false`, the heartbeat and task executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run. Either side re-dispatches the other's deferred work on completion via `resumeTaskForAgent` and the in-process runtime's `onRunCompleted` hook.

  UI toggle surfaces in the agent's Heartbeat Settings tab alongside `runMissedHeartbeatOnStartup`.

#### Patch Changes

- aecc050: Make the merger's autostash recovery robust against silent data loss. When `rootDir` is the developer's primary checkout, the merger stashes uncommitted edits before running its hard resets and applies them back at the end. Previously a pop conflict logged a single warning and silently left the stash in place — and a subsequent merge would push another autostash on top, burying the first.

  Three changes:

  1. **AI auto-resolve on apply conflict.** When the autostash apply hits a conflict, the merger now spawns a focused fix-agent (same `createResolvedAgentSession` path used for the in-merge verification fix-agent) to resolve conflict markers in the working tree. On success the stash is dropped and the resolution is recorded in `MergeResult.autostash`. On failure the stash is left intact for manual recovery.
  2. **Outcome surfaced on `MergeResult.autostash`** (new field of type `AutostashOutcome`). Consumers (dashboard, CLI, daemon) can now show the developer whether their work was reapplied cleanly, AI-resolved, or needs manual recovery — instead of relying on a buried log warning.
  3. **Deterministic stash identity via `git stash create` + `git stash store`.** Replaces the previous `git stash push` + label-grep flow that raced against any other tool stashing concurrently. The stash SHA is captured atomically with snapshot creation and used for apply/drop, so the operation is robust to stash list reordering.

  Also: orphaned `fusion-merger-autostash:*` entries from prior failed runs are now detected at merge entry and surfaced as a warning so they cannot be silently buried again.

### @fusion/dashboard

#### Minor Changes

- e658e8e: Decouple permanent agent heartbeats from task state, and add per-agent `allowParallelExecution` setting.

  Heartbeats now run for permanent agents regardless of bound-task block state — the prior early-exit on `queued + blockedBy` is removed along with its dead state-tracking machinery. `HEARTBEAT_SYSTEM_PROMPT` is rewritten to scope heartbeats to ambient coordination (messaging, memory, finding work, delegation, surfacing/chasing blockers, status); task body work continues to run via the executor path. Ephemeral agents are unchanged — they don't run heartbeats and their blocked-task gating in the scheduler is untouched.

  New `allowParallelExecution` flag (default `true`, permanent agents only) on `AgentHeartbeatConfig`. When `false`, the heartbeat and task executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run. Either side re-dispatches the other's deferred work on completion via `resumeTaskForAgent` and the in-process runtime's `onRunCompleted` hook.

  UI toggle surfaces in the agent's Heartbeat Settings tab alongside `runMissedHeartbeatOnStartup`.

- bb32765: Add a "Tools: On/Off" toggle next to the existing "Markdown/Plain" toggle in the agent log viewer (used by both agent logs and task agent logs). When tool output is off, entries of type `tool` / `tool_result` / `tool_error` are hidden — only agent text and thinking are shown. Both toggles now persist globally across sessions via `localStorage` (`fn-agent-log-markdown`, `fn-agent-log-tool-output`).

#### Patch Changes

- 9d13295: Move the agent Import button to the global agents header, next to "New Agent", and remove it from individual agent detail pages and the controls panel.
- 11e5f69: Show provider icons in chat: small icon next to the model name in the sidebar session list, and replace the generic robot icon in the chat thread header and assistant message avatars with the active provider icon.
- 24017b8: Drop residual `terminated` AgentState references that the merger autostash dropped during FN-3530 cleanup: `[data-state="terminated"]` selectors in `AgentListModal.css`, `--terminated` CSS-class assertions in `agent-css-classes.test.ts`, and a `state: "terminated"` test fixture in `routes-agents.test.ts` (now `paused`, which is correctly rejected as paused→paused is not a valid transition).
- Updated dependencies [e658e8e]
- Updated dependencies [aecc050]
- Updated dependencies [6ee3225]
- Updated dependencies [81bf882]
  - @fusion/core@0.22.0
  - @fusion/engine@0.22.0
  - @fusion-plugin-examples/dependency-graph@0.1.11
  - @fusion-plugin-examples/droid-runtime@0.1.6
  - @fusion-plugin-examples/hermes-runtime@0.2.30
  - @fusion-plugin-examples/openclaw-runtime@0.2.30
  - @fusion-plugin-examples/paperclip-runtime@0.2.30

### @fusion/engine

#### Minor Changes

- e658e8e: Decouple permanent agent heartbeats from task state, and add per-agent `allowParallelExecution` setting.

  Heartbeats now run for permanent agents regardless of bound-task block state — the prior early-exit on `queued + blockedBy` is removed along with its dead state-tracking machinery. `HEARTBEAT_SYSTEM_PROMPT` is rewritten to scope heartbeats to ambient coordination (messaging, memory, finding work, delegation, surfacing/chasing blockers, status); task body work continues to run via the executor path. Ephemeral agents are unchanged — they don't run heartbeats and their blocked-task gating in the scheduler is untouched.

  New `allowParallelExecution` flag (default `true`, permanent agents only) on `AgentHeartbeatConfig`. When `false`, the heartbeat and task executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run. Either side re-dispatches the other's deferred work on completion via `resumeTaskForAgent` and the in-process runtime's `onRunCompleted` hook.

  UI toggle surfaces in the agent's Heartbeat Settings tab alongside `runMissedHeartbeatOnStartup`.

#### Patch Changes

- aecc050: Make the merger's autostash recovery robust against silent data loss. When `rootDir` is the developer's primary checkout, the merger stashes uncommitted edits before running its hard resets and applies them back at the end. Previously a pop conflict logged a single warning and silently left the stash in place — and a subsequent merge would push another autostash on top, burying the first.

  Three changes:

  1. **AI auto-resolve on apply conflict.** When the autostash apply hits a conflict, the merger now spawns a focused fix-agent (same `createResolvedAgentSession` path used for the in-merge verification fix-agent) to resolve conflict markers in the working tree. On success the stash is dropped and the resolution is recorded in `MergeResult.autostash`. On failure the stash is left intact for manual recovery.
  2. **Outcome surfaced on `MergeResult.autostash`** (new field of type `AutostashOutcome`). Consumers (dashboard, CLI, daemon) can now show the developer whether their work was reapplied cleanly, AI-resolved, or needs manual recovery — instead of relying on a buried log warning.
  3. **Deterministic stash identity via `git stash create` + `git stash store`.** Replaces the previous `git stash push` + label-grep flow that raced against any other tool stashing concurrently. The stash SHA is captured atomically with snapshot creation and used for apply/drop, so the operation is robust to stash list reordering.

  Also: orphaned `fusion-merger-autostash:*` entries from prior failed runs are now detected at merge entry and surfaced as a warning so they cannot be silently buried again.

- 6ee3225: Fix agents stuck in `state="running"` after a missed-heartbeat termination.

  The unresponsive-agent recovery path disposed the session and called `pauseAgent`, but never explicitly ended the run via `completeRun` — relying on the in-flight execution to self-complete via its catch handler, which doesn't happen when the run is genuinely hung. The run record could still be terminated through other paths (safety-net or supersede-on-startRun), but those bypass the agent-state transition, leaving the agent permanently displayed as "running" with no active run.

  Two fixes:

  - `recoverUnresponsiveAgent` now calls `completeRun(..., status: "terminated")` so the canonical state transition runs alongside the existing `pauseAgent`/`resumeAgent` sequence.
  - `reconcileOrphanedRunningAgents` is broadened to also catch agents with stale `lastHeartbeatAt` (> 3× timeout) that aren't in the in-memory tracked set, terminating their stale run record. It now runs every poll instead of only at monitor start, so any pre-existing stuck rows from older versions self-heal within one poll interval after upgrade.

- 81bf882: Route skill-selection diagnostics by their declared severity instead of always logging at warn. Info-level messages like "Requested skill: <name>" now log at info level.
- Updated dependencies [e658e8e]
- Updated dependencies [aecc050]
  - @fusion/core@0.22.0
  - @fusion/pi-claude-cli@0.22.0

### @fusion/plugin-sdk

#### Patch Changes

- Updated dependencies [e658e8e]
- Updated dependencies [aecc050]
  - @fusion/core@0.22.0

### @runfusion/fusion

#### Minor Changes

- e658e8e: Decouple permanent agent heartbeats from task state, and add per-agent `allowParallelExecution` setting.

  Heartbeats now run for permanent agents regardless of bound-task block state — the prior early-exit on `queued + blockedBy` is removed along with its dead state-tracking machinery. `HEARTBEAT_SYSTEM_PROMPT` is rewritten to scope heartbeats to ambient coordination (messaging, memory, finding work, delegation, surfacing/chasing blockers, status); task body work continues to run via the executor path. Ephemeral agents are unchanged — they don't run heartbeats and their blocked-task gating in the scheduler is untouched.

  New `allowParallelExecution` flag (default `true`, permanent agents only) on `AgentHeartbeatConfig`. When `false`, the heartbeat and task executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run. Either side re-dispatches the other's deferred work on completion via `resumeTaskForAgent` and the in-process runtime's `onRunCompleted` hook.

  UI toggle surfaces in the agent's Heartbeat Settings tab alongside `runMissedHeartbeatOnStartup`.

- 041eb89: Per-agent setting `runMissedHeartbeatOnStartup` (default off): when enabled, the engine fires a single catch-up heartbeat at server startup if the agent's `lastHeartbeatAt` is older than its configured interval — i.e. a scheduled tick was missed because the server was down.

  The check runs in the same startup pass that arms heartbeat timers (`packages/cli/src/commands/dashboard.ts`), so agents whose state isn't `active`/`running` or who have heartbeats disabled never trigger. Catch-up runs use the existing `executeHeartbeat` path with `source="timer"` and `triggerDetail="startup-missed-heartbeat-catchup"` so per-agent serialization, budget enforcement, and missed/recovered tracking continue to apply. UI toggle lives in the agent's Heartbeat Settings tab.

- 8eb5c3d: Remove the `terminated` AgentState. The agent lifecycle now runs through `idle | active | running | paused | error`, with `paused` (carrying a `pauseReason`) absorbing every former `terminated` use case (manual stop, heartbeat run termination, spawned-child cleanup). Run status is unchanged — heartbeat runs still report `terminated` independently of the agent state.

  Migration: existing `agents` rows where `state = 'terminated'` are rewritten to `state = 'paused'` with `pauseReason: 'migrated-from-terminated'` on first store init (`__meta` key `removeTerminatedAgentState`). The dashboard "Terminated" filter option, badge, and CSS rules are gone; "Stop" buttons now transition the agent to `paused`. The `dashboard.READMEs` "Terminated agent filtering" behavior in the agents list is also dropped — paused/error agents are visible by default, and AgentListModal/AgentsView no longer hide them in "All States."

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [e658e8e]
- Updated dependencies [7d41271]
- Updated dependencies [041eb89]
- Updated dependencies [c76db06]
- Updated dependencies [b2aed0f]
- Updated dependencies [d47501f]
- Updated dependencies [12193d2]
- Updated dependencies [ff66c20]
- Updated dependencies [bb6169a]
- Updated dependencies [12b4a4a]
- Updated dependencies [89fd7a9]
- Updated dependencies [f04ade0]
- Updated dependencies [8eb5c3d]
- Updated dependencies [b312ca4]
  - @runfusion/fusion@0.22.0

## 0.21.0

### @fusion/dashboard

#### Patch Changes

- e6fd593: Differentiate the CLI banner between missing-install and version-mismatch states: when the installed `fn`/`fusion` CLI is out of date, show "Update the Fusion CLI" with current vs target versions and an "Update with npm" button instead of the generic install copy.
- dc8863d: Add `blocked` to `FeatureStatus` so blocked features render with mission-blocked colors in the mission manager.
  - @fusion/core@0.21.0
  - @fusion/engine@0.21.0
  - @fusion-plugin-examples/dependency-graph@0.1.10
  - @fusion-plugin-examples/droid-runtime@0.1.5
  - @fusion-plugin-examples/hermes-runtime@0.2.29
  - @fusion-plugin-examples/openclaw-runtime@0.2.29
  - @fusion-plugin-examples/paperclip-runtime@0.2.29

### @fusion/engine

#### Patch Changes

- @fusion/core@0.21.0
- @fusion/pi-claude-cli@0.21.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.21.0

### @runfusion/fusion

#### Minor Changes

- ac74cb0: Enable browser back-button navigation within the SPA dashboard. Previously, the back button would leave the dashboard entirely. Now it dismisses the top modal or reverts to the previous view, matching standard SPA behavior on both desktop and mobile.

#### Patch Changes

- 61dac28: fix: declare node-pty as a runtime dependency so `npx runfusion.ai` can start the embedded terminal on a clean install. Previously node-pty was only present transitively via the workspace `@fusion/dashboard` devDependency, which is stripped at publish time — fresh users hit a 503 "PTY module could not be loaded" when opening the dashboard terminal. The package-config test guard has been tightened to catch this regression.
- 8a57d3f: feat(tui): up/down arrows now cycle sections on the Main page (matching ←/→), except on the Logs panel where they continue to navigate log entries. Pressing Enter on a Logs entry now also releases xterm mouse reporting while the entry is expanded, so users can click-drag to select log text for copying; closing the expanded view restores wheel scrolling automatically.

### runfusion.ai

#### Patch Changes

- Updated dependencies [ac74cb0]
- Updated dependencies [61dac28]
- Updated dependencies [8a57d3f]
  - @runfusion/fusion@0.21.0

## 0.20.0

### @fusion/dashboard

#### Patch Changes

- ba6666f: Fix Planning Mode modal getting stuck at partial height on mobile. Two issues: (1) `useModalResizePersist` was replaying a desktop-saved pixel height into the inline `style` attribute, overriding the mobile `height: 100dvh` rule and leaving the modal at half-screen even before the keyboard appeared — now skipped on touch devices ≤768px wide. (2) When the iOS keyboard was dismissed, React reconciled the removed CSS custom properties (`--vv-height`, `--keyboard-overlap`, `--vv-offset-top`) by setting them to empty string instead of calling `removeProperty()`. On Safari that left `var(--vv-height, 100dvh)` resolving to empty (the fallback only kicks in when the variable is undefined), collapsing the modal to content height — now driven imperatively via `setProperty`/`removeProperty` on the modal ref.
  - @fusion/core@0.20.0
  - @fusion/engine@0.20.0
  - @fusion-plugin-examples/dependency-graph@0.1.9
  - @fusion-plugin-examples/droid-runtime@0.1.4
  - @fusion-plugin-examples/hermes-runtime@0.2.28
  - @fusion-plugin-examples/openclaw-runtime@0.2.28
  - @fusion-plugin-examples/paperclip-runtime@0.2.28

### @fusion/engine

#### Patch Changes

- @fusion/core@0.20.0
- @fusion/pi-claude-cli@0.20.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.20.0

### @runfusion/fusion

#### Minor Changes

- f711019: Add agent self-improvement tools (fn_read_evaluations, fn_update_identity) and periodic self-improvement scheduling based on evaluation feedback.
- d7880c6: Add plugin dashboard view discovery and navigation integration via `GET /api/plugins/dashboard-views`, plugin view ID persistence (`plugin:${pluginId}:${viewId}`), and static host-side plugin view registry rendering.
- 995faf2: Add per-agent heartbeat auto-claim controls so identity-bearing agents can opportunistically claim relevant unowned tasks during no-task heartbeat runs.
- aab28e1: Add first-class Anthropic (Claude) OAuth login support in Settings and onboarding, including fallback detection of existing Claude credentials from local Claude installs while keeping the separate Claude CLI provider option.

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [f711019]
- Updated dependencies [df20edb]
- Updated dependencies
- Updated dependencies [9b01c0a]
- Updated dependencies [b4a2e7a]
- Updated dependencies [e5fc71b]
- Updated dependencies [fdc37a3]
- Updated dependencies [1187ea4]
- Updated dependencies [4137573]
- Updated dependencies [b85743d]
- Updated dependencies [b061e2b]
- Updated dependencies [2f40843]
- Updated dependencies [69c75fe]
- Updated dependencies [d7880c6]
- Updated dependencies [f2accb7]
- Updated dependencies [576238a]
- Updated dependencies [995faf2]
- Updated dependencies [d790854]
- Updated dependencies [5fb7c77]
- Updated dependencies [aab28e1]
- Updated dependencies [a0c1e5b]
- Updated dependencies [43dd048]
- Updated dependencies [af0bc4b]
- Updated dependencies [8a30b6f]
- Updated dependencies [59f6c84]
- Updated dependencies [30f6381]
- Updated dependencies [2b809fc]
- Updated dependencies [d253e01]
- Updated dependencies [9115130]
  - @runfusion/fusion@0.20.0

## 0.19.0

### @fusion/dashboard

#### Patch Changes

- 082c62a: Fix a cross-agent overwrite bug in the Agents split view. The Config tab's form state was initialized once at mount and never resynced on `agent` change, while the master-detail layout reused the same `<AgentDetailView>` / `<ConfigTab>` instance across selections (no `key`). Switching agents while sitting on the Config tab made `hasChanges` evaluate true (stale form values vs. the newly loaded agent), and the 700ms autosave then wrote the previously-viewed agent's name/role/title/icon/model/skills onto the newly-selected agent's row. Adds `key={selectedAgentId}` to `<AgentDetailView>` and `key={agent.id}` to `<ConfigTab>` so both remount with fresh state on every agent transition.
- Updated dependencies [54f2832]
  - @fusion/engine@0.19.0
  - @fusion/core@0.19.0
  - @fusion-plugin-examples/dependency-graph@0.1.8
  - @fusion-plugin-examples/droid-runtime@0.1.3
  - @fusion-plugin-examples/hermes-runtime@0.2.27
  - @fusion-plugin-examples/openclaw-runtime@0.2.27
  - @fusion-plugin-examples/paperclip-runtime@0.2.27

### @fusion/engine

#### Patch Changes

- 54f2832: Restrict merger staging to squash + fix-agent files; refuse to commit unrelated working-tree changes

  Replaces the blanket `git add -A` in `commitOrAmendMergeWithFixes` with an explicit allowlist: only files that were squash-staged or explicitly modified by the in-merge verification fix agent are staged. Any other dirty files in the working tree are left untouched and a warning is logged naming each excluded path. Fixes a production bug where ~13 unrelated user-edited files were bundled into a task's squash commit.

  Hardened by code review: replaced all shell-interpolated `git add` calls in `commitOrAmendMergeWithFixes` and the conflict-resolution helpers (`resolveWithOurs`, `resolveWithTheirs`, `resolveTrivialWhitespace`) with `execFile` array form to eliminate path-injection surface; adopted `git -z` NUL-delimited output for all dirty-file path queries in both `snapshotDirtyFiles` and `commitOrAmendMergeWithFixes` so paths with embedded spaces round-trip correctly; truncated long allowlist debug log lines to at most 20 entries.

  - @fusion/core@0.19.0
  - @fusion/pi-claude-cli@0.19.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.19.0

### @runfusion/fusion

#### Minor Changes

- 1e73863: Add first-class llama.cpp provider support with bundled extension wiring, dashboard status/auth routes, model filtering, and onboarding/settings UI for enabling llama-server models without manual `pi install` steps.
- 496c000: Add `fn update` command to check for and install the latest version of Fusion.
- df253a8: Cache merge verification by tree hash and boost test concurrency for in-review verification.

#### Patch Changes

- d06475b: Harden the publish path against dockerode-class missing-dependency regressions (#33). Adds a generalized invariant test that walks `tsup.config.ts` and asserts every non-builtin `external` is either a runtime dep or in an explicit transitive-allowlist, plus a pre-publish smoke step in `pnpm release` that packs the public tarballs, installs them with plain `npm` into a clean temp dir, and invokes the bin — catching the dockerode-class bug (and others like missing `files` globs) before publish, since pnpm hoisting masks it in the workspace.
- eeab870: Store generated memory insight artifacts under `.fusion/memory/` (`memory-insights.md`, `memory-audit.md`, and `memory-audit-state.json`) instead of top-level `.fusion/` files, with compatibility migration for existing legacy files.
- d30f8a7: Allow the dashboard task-detail footer action to manually drive PR-first completion when `mergeStrategy` is `pull-request` and `autoMerge` is disabled.
- 8483a5f: Make the settings modal fill the viewport on mobile and align section headings with form-group gutters for consistent spacing across each settings page.
- df253a8: Cache per-package test results by content hash to skip unchanged packages across sequential merges.

  `scripts/test-changed.mjs` now maintains a per-project cache at `.fusion/test-cache.json`. For each package in a changed-mode run, a SHA-256 is computed from the git blob SHAs of every tracked file in the package directory plus `pnpm-lock.yaml` and `tsconfig.base.json`. If the hash matches a cache entry younger than 7 days the package is excluded from the `pnpm --filter` invocation and tests are skipped. After a successful run the passing hashes are written atomically. Cache lookups are bypassed when `FUSION_TEST_NO_CACHE=1` or `--no-cache` is passed, and never applied to full-suite runs. A new `FUSION_TEST_WORKSPACE_CONCURRENCY` env var controls `--workspace-concurrency` (default `2`).

### runfusion.ai

#### Patch Changes

- d06475b: Surface "new version available" notices to users who run `npx runfusion.ai` without ever opening the dashboard. The launcher now reads the existing `~/.fusion/update-check.json` cache (written by the dashboard's update-check service) and prints a one-line stderr notice when a newer Fusion is published. When the cache is missing or older than 24h, a fire-and-forget fetch against the npm registry refreshes it (1.5s timeout) so non-dashboard users still pick up updates on their next run. Disable with `FUSION_NO_UPDATE_CHECK=1`; auto-skipped in CI and non-TTY contexts.
- Updated dependencies [1e73863]
- Updated dependencies [d06475b]
- Updated dependencies [eeab870]
- Updated dependencies [d30f8a7]
- Updated dependencies [496c000]
- Updated dependencies [8483a5f]
- Updated dependencies [df253a8]
- Updated dependencies [df253a8]
  - @runfusion/fusion@0.19.0

## 0.18.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.18.1
- @fusion/engine@0.18.1
- @fusion-plugin-examples/dependency-graph@0.1.7
- @fusion-plugin-examples/droid-runtime@0.1.2
- @fusion-plugin-examples/hermes-runtime@0.2.26
- @fusion-plugin-examples/openclaw-runtime@0.2.26
- @fusion-plugin-examples/paperclip-runtime@0.2.26

### @fusion/engine

#### Patch Changes

- @fusion/core@0.18.1
- @fusion/pi-claude-cli@0.18.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.18.1

### @runfusion/fusion

#### Patch Changes

- 89401cd: Fix `npx runfusion.ai` failing with `ERR_MODULE_NOT_FOUND: Cannot find package 'dockerode'` by declaring `dockerode` as a runtime dependency of the published CLI package (#33).
- 89401cd: Allow the dashboard task-detail footer action to manually drive PR-first completion when `mergeStrategy` is `pull-request` and `autoMerge` is disabled.

### runfusion.ai

#### Patch Changes

- Updated dependencies [89401cd]
- Updated dependencies [89401cd]
  - @runfusion/fusion@0.18.1

## 0.18.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.18.0
- @fusion/engine@0.18.0
- @fusion-plugin-examples/dependency-graph@0.1.6
- @fusion-plugin-examples/droid-runtime@0.1.1
- @fusion-plugin-examples/hermes-runtime@0.2.25
- @fusion-plugin-examples/openclaw-runtime@0.2.25
- @fusion-plugin-examples/paperclip-runtime@0.2.25

### @fusion/engine

#### Patch Changes

- @fusion/core@0.18.0
- @fusion/pi-claude-cli@0.18.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.18.0

### @runfusion/fusion

#### Minor Changes

- cc5c8c6: Extend dashboard node management with managed Docker node status UI, Docker-specific detail sections, and Docker node status/logs API routes.

#### Patch Changes

- 986a928: Fix dashboard task deletion failing with "still referenced as a dependency" even after the user confirms removing dependency references. The `useTasks` hook's `deleteTask` was dropping its `options` argument, so the `removeDependencyReferences` flag from the confirmation flow never reached the API.
- c00b018: Fix mobile bottom nav bar overlapping the iOS home indicator in installed PWAs and the visible gap between the nav bar and the executor status bar. The nav bar now extends its surface into the safe-area inset so icons sit above the home indicator and the bar meets the status bar flush.
- 66f85da: Treat OpenAI-compatible `finish_reason: repeat` (raised by Moonshot/Kimi when its server-side repetition detector trips) as a soft stop in the engine heartbeat instead of a fatal error, so agent runs survive the truncation and can continue on the next tick.
- 3afb62b: Fix skill name matching between Fusion's two-segment names (e.g. `web-research/SKILL.md`) and pi-coding-agent's bare directory names (e.g. `web-research`). Patterns and requested skill names now strip the `/SKILL.md` suffix before comparison, eliminating spurious "not found in discovered skills" warnings.
- 08d655a: Fix a mobile dashboard regression where closing Planning Mode after keyboard/visualViewport changes could leave board/list content shifted or clipped. Planning Mode now performs mobile viewport teardown (blur + top snap) on close so control returns cleanly to the dashboard.
- d761ea8: Hardened CLI packaging against native module build regressions by asserting `dockerode`/`ssh2`/`cpu-features` remain externalized in tsup bundle config, preventing native `.node` artifact strings from being inlined into the bundle, and declaring `dockerode` as a runtime dependency for published installs.
- 2b102af: Retrying failed `in-review` tasks now keeps them in `in-review` and only clears retry/error state so auto-merge can re-attempt without resetting task worktree state.
- 8cb8055: Agent pause now automatically pauses all assigned tasks; manual pause controls are blocked/hidden for agent-assigned tasks; tasks now show a "paused by agent" indicator.

### runfusion.ai

#### Patch Changes

- Updated dependencies [986a928]
- Updated dependencies [c00b018]
- Updated dependencies [66f85da]
- Updated dependencies [3afb62b]
- Updated dependencies [cc5c8c6]
- Updated dependencies [08d655a]
- Updated dependencies [d761ea8]
- Updated dependencies [2b102af]
- Updated dependencies [8cb8055]
  - @runfusion/fusion@0.18.0

## 0.17.2

### @fusion/core

#### Patch Changes

- 17a6634: Fix pre-merge workflow steps stalling on tasks with no relevant changes (FN-3327 post-mortem).

  - **`@fusion/engine`**: `executeWorkflowStep` now computes the diff scope (`git diff --name-only` plus `--shortstat` against `task.baseCommitSha`) before spawning the reviewer agent and injects a "Diff Scope" block into the system prompt. The block lists every file the task actually changed and adds explicit scoping rules: review only those files, and if none match the step's category respond immediately with a short approval line and stop. Without this, an open-ended review prompt (e.g. WS-005 "Frontend UX Design") would drift into pre-existing files matching the task description's keywords, exhaust the 360 s timeout, and trigger the auto-revive → re-finalize → re-fail loop that had FN-3327 wedged in `in-review`. Both git calls are best-effort; failures degrade to a "no modified files detected" notice rather than blocking the step.
  - **`@fusion/core`**: The built-in `frontend-ux-design` workflow step template (WS-005) now opens with a FAST-BAIL rule telling the reviewer to inspect the Diff Scope first and return an immediate one-line approval when no UI/CSS/component files are present. New installs and freshly-materialized templates pick this up automatically; existing DB rows are unaffected but are still rescued by the executor-side scope injection above.

### @fusion/dashboard

#### Patch Changes

- Updated dependencies [17a6634]
  - @fusion/engine@0.17.2
  - @fusion/core@0.17.2
  - @fusion-plugin-examples/dependency-graph@0.1.5
  - @fusion-plugin-examples/hermes-runtime@0.2.24
  - @fusion-plugin-examples/openclaw-runtime@0.2.24
  - @fusion-plugin-examples/paperclip-runtime@0.2.24

### @fusion/engine

#### Patch Changes

- 17a6634: Fix pre-merge workflow steps stalling on tasks with no relevant changes (FN-3327 post-mortem).

  - **`@fusion/engine`**: `executeWorkflowStep` now computes the diff scope (`git diff --name-only` plus `--shortstat` against `task.baseCommitSha`) before spawning the reviewer agent and injects a "Diff Scope" block into the system prompt. The block lists every file the task actually changed and adds explicit scoping rules: review only those files, and if none match the step's category respond immediately with a short approval line and stop. Without this, an open-ended review prompt (e.g. WS-005 "Frontend UX Design") would drift into pre-existing files matching the task description's keywords, exhaust the 360 s timeout, and trigger the auto-revive → re-finalize → re-fail loop that had FN-3327 wedged in `in-review`. Both git calls are best-effort; failures degrade to a "no modified files detected" notice rather than blocking the step.
  - **`@fusion/core`**: The built-in `frontend-ux-design` workflow step template (WS-005) now opens with a FAST-BAIL rule telling the reviewer to inspect the Diff Scope first and return an immediate one-line approval when no UI/CSS/component files are present. New installs and freshly-materialized templates pick this up automatically; existing DB rows are unaffected but are still rescued by the executor-side scope injection above.

- Updated dependencies [17a6634]
  - @fusion/core@0.17.2
  - @fusion/pi-claude-cli@0.17.2

### @fusion/plugin-sdk

#### Patch Changes

- Updated dependencies [17a6634]
  - @fusion/core@0.17.2

### @runfusion/fusion

#### Patch Changes

- bacc103: Fix Codex auth interoperability, remote OAuth manual-code login flow, and chat fallback/error handling.

### runfusion.ai

#### Patch Changes

- Updated dependencies [bacc103]
  - @runfusion/fusion@0.17.2

## 0.17.1

### @fusion/dashboard

#### Patch Changes

- 08aa64e: Fix mobile keyboard regressions in the dashboard.

  - **Dashboard pushed up after closing a modal on mobile.** Adds a shared `useMobileScrollLock` hook that pins `body` with `position: fixed; top: -scrollY; width: 100%` while a fullscreen mobile overlay is open and restores scroll on cleanup — the same pattern Bootstrap, Headless UI, and Stripe Elements use to prevent iOS Safari from scrolling the document (and shifting `visualViewport.offsetTop`) when an input inside a `position: fixed` overlay is focused. Reference-counted so nested overlays don't release each other's locks. Wired into TodoModal, PlanningModeModal, TaskDetailModal, NewTaskModal, SettingsModal, MailboxModal, AddNodeModal, MissionInterviewModal, MilestoneSliceInterviewModal, SubtaskBreakdownModal, GitHubImportModal, AgentGenerationModal, AgentImportModal, ScriptsModal, ResearchTaskActionModal, and ChatView (replacing its inline body-overflow effect).
  - **Auto-reload prompt missed rebuilds.** Widens `computeBuildVersion` in `vite.config.ts` to hash the entire `app/` source tree (FN-3333 follow-up). The previous version only hashed `app/main.tsx` and `package.json`, so edits to any other component or stylesheet produced an identical build version and the version-check poll never noticed the rebuild.
  - **ChatView composer crawled down with iOS's keyboard-dismiss animation.** `useMobileKeyboard` now requires a focused input for `keyboardOpen=true`. The moment any input blurs, `keyboardOpen` flips to `false` instead of waiting for iOS's slow visualViewport animation to settle (hundreds of ms). This propagates to App-level `mobileKeyboardOpen` so the MobileNavBar reappears and `project-content` regains its nav-bar padding immediately — chat-thread, modals, and any other consumer all snap to their post-keyboard layout in one frame.

- Updated dependencies [c2f6dd3]
  - @fusion/engine@0.17.1
  - @fusion/core@0.17.1
  - @fusion-plugin-examples/dependency-graph@0.1.4
  - @fusion-plugin-examples/hermes-runtime@0.2.23
  - @fusion-plugin-examples/openclaw-runtime@0.2.23
  - @fusion-plugin-examples/paperclip-runtime@0.2.23

### @fusion/engine

#### Patch Changes

- c2f6dd3: Fix heartbeat and manual agent runs ignoring the agent's configured model. The dashboard saves `runtimeConfig.model` as a combined `"provider/modelId"` string, but heartbeat was reading non-existent split `modelProvider`/`modelId` fields, causing sessions to fall through to pi's default model (often `openai-codex`) and fail with "No API key for provider: openai-codex".
  - @fusion/core@0.17.1
  - @fusion/pi-claude-cli@0.17.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.17.1

### runfusion.ai

#### Patch Changes

- @runfusion/fusion@0.17.1

## 0.17.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.17.0
- @fusion/engine@0.17.0
- @fusion-plugin-examples/dependency-graph@0.1.3
- @fusion-plugin-examples/hermes-runtime@0.2.22
- @fusion-plugin-examples/openclaw-runtime@0.2.22
- @fusion-plugin-examples/paperclip-runtime@0.2.22

### @fusion/engine

#### Patch Changes

- @fusion/core@0.17.0
- @fusion/pi-claude-cli@0.17.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.17.0

### @runfusion/fusion

#### Minor Changes

- 6724cf5: Add `autoReloadOnVersionChange` global setting to make the dashboard's automatic reload on version changes optional. Users can disable auto-reload in Settings → General → Updates.
- 7f3fb77: Harden research subsystem with bounded rate/concurrency limits, cancellation safety, timeout handling, bounded retries, and graceful disabled/setup/error states across dashboard, API, CLI, and agent tooling.
- fca870f: Add Docker target connectivity support for local daemon, Docker contexts, and direct host/TLS configuration with dashboard API and UI selectors.
- d812427: Add mesh configuration generation service and API routes for Docker node provisioning (FN-3111). New exports from `@fusion/core`: `MeshConfigGenerator`, `MeshConfigGeneratorInput`, `FullProvisioningInput`, `MeshConnectionConfig`, `MeshConfigResult`.

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [6724cf5]
- Updated dependencies [ba893b8]
- Updated dependencies [5291a6f]
- Updated dependencies [3db1752]
- Updated dependencies [85d02c8]
- Updated dependencies [ea5b7af]
- Updated dependencies [7f3fb77]
- Updated dependencies [fca870f]
- Updated dependencies [d812427]
- Updated dependencies [a82c3dc]
- Updated dependencies [a47f319]
- Updated dependencies [9309c8c]
- Updated dependencies [b9b5c08]
- Updated dependencies [c76d138]
- Updated dependencies [21504f6]
- Updated dependencies [a1a8d03]
- Updated dependencies [63bb62f]
- Updated dependencies [de02fed]
  - @runfusion/fusion@0.17.0

## 0.16.0

### @fusion/dashboard

#### Patch Changes

- c769444: Fix `git diff --no-index` calls treating exit code 1 as an error in the dashboard git-routes. `--no-index` exits 1 when files differ — that's the success case for synthetic untracked-file diffs. Switched to `spawn` so we accept exit 0 and 1 with stdout, independent of how callers wrap `execFile`/`promisify`.
  - @fusion/core@0.16.0
  - @fusion/engine@0.16.0
  - @fusion-plugin-examples/dependency-graph@0.1.2
  - @fusion-plugin-examples/hermes-runtime@0.2.21
  - @fusion-plugin-examples/openclaw-runtime@0.2.21
  - @fusion-plugin-examples/paperclip-runtime@0.2.21

### @fusion/engine

#### Patch Changes

- @fusion/core@0.16.0
- @fusion/pi-claude-cli@0.16.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.16.0

### @runfusion/fusion

#### Minor Changes

- 6ae7aef: Add a project-level `completionDocumentationMode` setting (`off`, `changeset`, `changelog`) and use it during triage prompt generation so new task specs automatically require the appropriate completion release-note artifact.

  Also expose the setting in Dashboard → Settings → Project → General and document it in the settings reference.

- 5ebccc4: Add `createAiSession` to `PluginContext` so plugins can create AI sessions through an engine-injected factory without importing `@fusion/engine` directly.
- 17f5d4a: Execute plugin `onSchemaInit` hooks during startup after plugins are loaded, so plugins can register idempotent tables and indexes with the runtime database.

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [41bb6be]
- Updated dependencies [9c45d24]
- Updated dependencies [3bafc48]
- Updated dependencies [1744534]
- Updated dependencies [9619cd1]
- Updated dependencies [222e11c]
- Updated dependencies [8ba8f63]
- Updated dependencies [df04acd]
- Updated dependencies [2affc14]
- Updated dependencies [bf7caf5]
- Updated dependencies [2769e4a]
- Updated dependencies [e1c1072]
- Updated dependencies [6b4f28a]
- Updated dependencies [6ae7aef]
- Updated dependencies [5ebccc4]
- Updated dependencies [17f5d4a]
- Updated dependencies [44cc899]
- Updated dependencies [6bc2de9]
- Updated dependencies [6c5146b]
- Updated dependencies [922782f]
- Updated dependencies [adbc613]
- Updated dependencies [8f72eee]
- Updated dependencies [d73070c]
  - @runfusion/fusion@0.16.0

## 0.15.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.15.0
- @fusion/engine@0.15.0
- @fusion-plugin-examples/dependency-graph@0.1.1
- @fusion-plugin-examples/hermes-runtime@0.2.20
- @fusion-plugin-examples/openclaw-runtime@0.2.20
- @fusion-plugin-examples/paperclip-runtime@0.2.20

### @fusion/engine

#### Patch Changes

- @fusion/core@0.15.0
- @fusion/pi-claude-cli@0.15.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.15.0

### @runfusion/fusion

#### Minor Changes

- 9e52028: Add host support for plugin-registered top-level dashboard views and ship the first plugin-first Graph view surface for dependency visualization.

#### Patch Changes

- ed477f8: Fix recurring SQLite instability under heavy agent logging by tuning WAL pragmas, adding startup integrity detection with non-blocking corruption signaling, batching agent log writes in transactions, and reducing default maintenance cadence to checkpoint WAL more frequently.
- 9fc5fd9: Limit unregistered project detection to the exact current working directory.

### runfusion.ai

#### Patch Changes

- Updated dependencies [ed477f8]
- Updated dependencies [9fc5fd9]
- Updated dependencies [9e52028]
  - @runfusion/fusion@0.15.0

## 0.14.3

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.14.3
- @fusion/engine@0.14.3
- @fusion-plugin-examples/hermes-runtime@0.2.19
- @fusion-plugin-examples/openclaw-runtime@0.2.19
- @fusion-plugin-examples/paperclip-runtime@0.2.19

### @fusion/engine

#### Patch Changes

- @fusion/core@0.14.3
- @fusion/pi-claude-cli@0.14.3

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.14.3

### @runfusion/fusion

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [dd291db]
- Updated dependencies [3119537]
- Updated dependencies [03d0fac]
- Updated dependencies [7fec762]
- Updated dependencies [24b3ded]
- Updated dependencies [36d623a]
- Updated dependencies [5a41ce4]
- Updated dependencies [3119537]
- Updated dependencies [8592472]
- Updated dependencies [66a19b5]
  - @runfusion/fusion@0.14.3

## 0.14.2

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.14.2
- @fusion/engine@0.14.2
- @fusion-plugin-examples/hermes-runtime@0.2.18
- @fusion-plugin-examples/openclaw-runtime@0.2.18
- @fusion-plugin-examples/paperclip-runtime@0.2.18

### @fusion/engine

#### Patch Changes

- @fusion/core@0.14.2
- @fusion/pi-claude-cli@0.14.2

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.14.2

### @runfusion/fusion

#### Patch Changes

- 7ec394a: Keep chat and quick chat visibly in a connecting or thinking state during long Claude CLI responses, and repair missing spaces in some streamed sentence boundaries.
- b3e2b61: Hide deprecated Google Gemini CLI/Antigravity auth providers from dashboard onboarding and Settings while keeping supported Google/Gemini API-key, Google Generative AI, Vertex, and Cloud Code paths intact. Also documents the internal pi-coding-agent v0.71.x upgrade plan for follow-up dependency bump work.
- b3e2b61: Remove redundant `fn_identity` heartbeat tool and trim the inline Identity Snapshot to presence flags + content hashes. Full soul/instructions/memory content is already loaded in the system prompt's Custom Instructions section, so per-tick previews were duplicating multi-KB of context for no verification benefit. Saves prompt tokens on every heartbeat run.

### runfusion.ai

#### Patch Changes

- Updated dependencies [7ec394a]
- Updated dependencies [b3e2b61]
- Updated dependencies [b3e2b61]
  - @runfusion/fusion@0.14.2

## 0.14.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.14.1
- @fusion/engine@0.14.1
- @fusion-plugin-examples/hermes-runtime@0.2.17
- @fusion-plugin-examples/openclaw-runtime@0.2.17
- @fusion-plugin-examples/paperclip-runtime@0.2.17

### @fusion/engine

#### Patch Changes

- @fusion/core@0.14.1
- @fusion/pi-claude-cli@0.14.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.14.1

### @runfusion/fusion

#### Patch Changes

- cafe986: Fix readonly `createFnAgent` sessions to preserve caller-supplied engine custom tools while still excluding host extensions. This restores delegation and memory tools for no-task heartbeat/reviewer readonly sessions without reopening host extension tool injection in summarizer flows.

### runfusion.ai

#### Patch Changes

- Updated dependencies [cafe986]
  - @runfusion/fusion@0.14.1

## 0.14.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.14.0
- @fusion/engine@0.14.0
- @fusion-plugin-examples/hermes-runtime@0.2.16
- @fusion-plugin-examples/openclaw-runtime@0.2.16
- @fusion-plugin-examples/paperclip-runtime@0.2.16

### @fusion/engine

#### Patch Changes

- @fusion/core@0.14.0
- @fusion/pi-claude-cli@0.14.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.14.0

### @runfusion/fusion

#### Minor Changes

- e505bad: Make the `fn` / `fusion` global CLI install discoverable and self-serve from the dashboard.

  - Settings → General now has a **CLI Binary** panel showing whether `fn` (or `fusion`) is on PATH, the resolved version, and a one-click **Install with npm** button that runs `npm install -g runfusion.ai` server-side. The panel also surfaces copy-to-clipboard install commands (`npm install -g runfusion.ai` and `curl -fsSL https://runfusion.ai/install.sh | sh`) for users with non-default npm setups, and reports a permissions hint when `npm install -g` fails with `EACCES`.
  - A first-launch banner nudges users to install when the binary is missing; dismissal is permanent (per-browser localStorage).
  - Fixed scheduled **Database Backup** automations whose persisted command was `fn backup --create` — those failed every run on hosts where the global bin was never linked. A new schema migration (v58) rewrites legacy `fn`/`kb`/`fusion` backup commands to `npx runfusion.ai backup --create`, matching the canonical seed in `syncBackupAutomation`.
  - Added `detectFnBinary()` to `@fusion/core` so server-side code can resolve the right invocation prefix (`fn` > `fusion` > `npx -y runfusion.ai`) without baking a binary name into automations or generated commands.

- 1634ea3: Ship Droid CLI provider integration in the published Fusion CLI bundle by vendoring `@fusion/droid-cli` runtime extension files, so users can enable **Factory AI — via Droid CLI** from dashboard authentication once the `droid` binary is installed and authenticated locally.
- 4231c4a: Split the Star-on-GitHub toggle, CLI Binary panel, and update-check controls into a new **Global → General** settings pane (with an inline **Updates** subsection), separate from the project-scoped Project → General pane. All three are global by nature, and grouping them under Global avoids the impression that they apply only to the active project. The standalone Global → Updates entry has been folded into this pane.

  The CLI Binary panel also drops its own outlined card background and adopts the standard `padding: 0 var(--space-xl)` indent every other top-level child of `.settings-content` uses, so it sits flush with adjacent form groups instead of bleeding to the pane edges.

  Wire `--version` / `-v` in the `fn` / `fusion` bin so it prints the package version and exits before falling through to the default `dashboard` command. Without this, the dashboard's CLI Binary panel reported the installed version as "unknown" because its `<bin> --version` probe was booting the full server instead of getting a version string.

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [e505bad]
- Updated dependencies [f0d0f8c]
- Updated dependencies [5398bc7]
- Updated dependencies [80b45d0]
- Updated dependencies [fd36fbd]
- Updated dependencies [8b7f20f]
- Updated dependencies [1634ea3]
- Updated dependencies [4231c4a]
- Updated dependencies [c08a872]
- Updated dependencies [0188da7]
- Updated dependencies [4d70a9e]
- Updated dependencies [e72eff4]
- Updated dependencies [72ed143]
  - @runfusion/fusion@0.14.0

## 0.13.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.13.0
- @fusion/engine@0.13.0
- @fusion-plugin-examples/hermes-runtime@0.2.15
- @fusion-plugin-examples/openclaw-runtime@0.2.15
- @fusion-plugin-examples/paperclip-runtime@0.2.15

### @fusion/engine

#### Patch Changes

- @fusion/core@0.13.0
- @fusion/pi-claude-cli@0.13.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.13.0

### @runfusion/fusion

#### Minor Changes

- d18e411: Add Droid CLI provider integration: new auth and status routes (`GET /api/providers/droid-cli/status`, `POST /api/auth/droid-cli`) plus a Settings toggle hook for enabling Droid CLI–based authentication. Wired into the onboarding provider card so users can connect Droid CLI from the same flow as the other providers.
- d18e411: Add an experimental agent onboarding modal that streamlines the handoff from first-run onboarding into the create-agent form, so new users land on a configured agent draft instead of an empty Settings page. Backed by lifecycle tests and gated behind the experimental flag documented in the onboarding docs.
- 56210e0: Planning sidebar now lists every saved planning session, not just active ones, so a session that finishes while the modal is closed remains selectable on refresh — previously the `/api/ai-sessions` listing filtered out `complete` rows and they vanished from the UI even though the result was still in SQLite. Adds the ability to archive and unarchive completed (or errored) planning sessions: a per-row archive button hides terminal sessions from the sidebar, and a "Show archived" toggle reveals them for unarchive. Backed by a new `ai_sessions.archived` column (migration 57), `POST /api/ai-sessions/:id/archive` and `/unarchive` endpoints (only terminal sessions are archivable so live agents can't be orphaned), and `?includeCompleted` / `?includeArchived` query flags on `GET /api/ai-sessions`. Existing consumers (`useBackgroundSessions`, `MissionManager`) are unchanged — they continue to see only active/retryable sessions.

#### Patch Changes

- d18e411: Fix two related CLI-session issues that caused resumed sessions to balloon in size and quick chat to lose continuity:

  - Resumed pi-claude-cli and droid-cli sessions were re-sending the entire conversation transcript over stdin every iteration. `buildResumePrompt` anchored on the last user message and walked forward through preceding tool results, but the only user message stayed at index 0, so each turn duplicated the original query plus a growing stack of tool results into the on-disk session. Anchor on the last assistant message and slice forward instead, so only the genuine delta since the previous turn is sent.
  - Quick chat created a fresh CLI session per user message and faked continuity by stuffing the last 50 messages into the prompt as a "## Previous Conversation" block. Replace that with real session continuity: `chat_sessions` gains a `cliSessionFile` column (migration 56) and ChatManager now reuses the existing pi SessionManager file when present, creating a fresh one on the first turn and persisting its path. The prompt now carries only the new user content.

- 7011831: Replace dashboard runtime dynamic `@fusion/engine` imports with bundler-safe static imports and add regression coverage to prevent reintroduction. This avoids npm-installed runtime failures caused by non-static engine imports that cannot be safely inlined during bundling.

### runfusion.ai

#### Patch Changes

- Updated dependencies [d18e411]
- Updated dependencies [d18e411]
- Updated dependencies [d18e411]
- Updated dependencies [7011831]
- Updated dependencies [56210e0]
  - @runfusion/fusion@0.13.0

## 0.12.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.12.0
- @fusion/engine@0.12.0
- @fusion-plugin-examples/hermes-runtime@0.2.14
- @fusion-plugin-examples/openclaw-runtime@0.2.14
- @fusion-plugin-examples/paperclip-runtime@0.2.14

### @fusion/engine

#### Patch Changes

- @fusion/core@0.12.0
- @fusion/pi-claude-cli@0.12.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.12.0

### @runfusion/fusion

#### Minor Changes

- cf0ea34: Add a new `fn research` command group for managing research runs from the CLI, including create, list, show, export, cancel, and retry flows with JSON-friendly output options.

#### Patch Changes

- bdf91f8: Fix mobile chat view layout when the iOS keyboard is up so the message input stays anchored above the keyboard instead of being pushed to the top of the screen.
- 23134cf: Keep mobile chat composer focused when tapping Send so the keyboard stays open and messages send on the first tap.
- 72dffe4: Fix Quick Chat mobile send button so the first tap while keyboard is open sends the message instead of only dismissing the keyboard.
- 41e5458: Keep the mobile keyboard open in Quick Chat after tapping send so users can continue typing without an extra tap.
- 7f55dde: Preserve Quick Chat input focus on mobile send taps so the keyboard stays open.
- a16ca0a: Seal readonly AI agent sessions so summarizers (title, merge subject, merge body, merge summary) cannot reach host-injected `fn_*` mutation tools or caller-supplied custom tools. Harden all four summarizer system prompts with explicit "do not call tools / treat input as content" framing, wrap the title prompt in a `<description>` delimiter, and sanitize the AI response (strip chatty preambles, markdown emphasis, surrounding quotes, trailing punctuation) before returning. Prevents a class of incidents where the title summarizer would call `fn_task_create` mid-summary and store its chat-style reply as the title.
- ecabab8: Show task provenance as "Created by <agent name>" for agent-created tasks and make the agent name clickable to open the agent detail modal.

### runfusion.ai

#### Patch Changes

- Updated dependencies [cf0ea34]
- Updated dependencies [bdf91f8]
- Updated dependencies [23134cf]
- Updated dependencies [72dffe4]
- Updated dependencies [41e5458]
- Updated dependencies [7f55dde]
- Updated dependencies [a16ca0a]
- Updated dependencies [ecabab8]
  - @runfusion/fusion@0.12.0

## 0.11.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.11.0
- @fusion/engine@0.11.0
- @fusion-plugin-examples/hermes-runtime@0.2.13
- @fusion-plugin-examples/openclaw-runtime@0.2.13
- @fusion-plugin-examples/paperclip-runtime@0.2.13

### @fusion/engine

#### Patch Changes

- @fusion/core@0.11.0
- @fusion/pi-claude-cli@0.11.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.11.0

### @runfusion/fusion

#### Minor Changes

- 28e6819: Add first-class Research configuration and readiness workflows across settings and dashboard surfaces. This introduces scoped Research defaults/overrides, exposes Research in experimental feature toggles, and routes missing-provider/missing-credentials setup through existing Settings and Authentication flows while keeping API keys in auth storage.

#### Patch Changes

- 97bb80e: Fix backup routine sync failures on legacy SQLite databases by backfilling missing `routines` columns (including `agentId`) during database initialization. Auto-backup settings now create/update the `Database Backup` routine without logging `table routines has no column named agentId` on upgraded installs.
- 451c6d8: Add read-only `fn_insight_*` pi extension tools so agents can list and inspect persisted insights and recent insight-generation runs directly from the project `InsightStore`.
- 3443aed: Ship a bundled Nerd Font symbols fallback for the dashboard terminal so patched glyphs render even when users do not have a local Nerd Font installed. The dashboard now preloads `/fonts/SymbolsNerdFontMono-Regular.ttf`, applies it first in the xterm font stack, and includes build-output regression checks for the bundled font artifact and preload reference.
- d7fdff4: Move `experimentalFeatures` and `remoteAccess` from project-scoped settings to global-scoped settings, including settings schema/type updates, save-path migration, dashboard routes/UI, and regression coverage updates.
- 13ed470: Fix the mobile QuickChat panel layout when the iOS keyboard opens. The panel now stays anchored to the visible viewport (no off-screen drift on a refocus after the keyboard was dismissed), the soft keyboard reliably comes up the moment the FAB is tapped (a stealth input claims focus inside the user gesture so iOS opens the keyboard even before the real composer is enabled), the panel snaps back to full height immediately on blur instead of trailing the keyboard slide-down, and the model name in the header pill collapses to a provider icon when it would otherwise overflow.
- 40620a9: Keep the terminal modal header on a single row on mobile. The tab bar now flexes to fill remaining width and stays scrollable, while the action cluster pins to the right edge of the same row instead of stacking onto a second row.

### runfusion.ai

#### Patch Changes

- Updated dependencies [97bb80e]
- Updated dependencies [28e6819]
- Updated dependencies [451c6d8]
- Updated dependencies [3443aed]
- Updated dependencies [d7fdff4]
- Updated dependencies [13ed470]
- Updated dependencies [40620a9]
  - @runfusion/fusion@0.11.0

## 0.10.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.10.0
- @fusion/engine@0.10.0
- @fusion-plugin-examples/hermes-runtime@0.2.12
- @fusion-plugin-examples/openclaw-runtime@0.2.12
- @fusion-plugin-examples/paperclip-runtime@0.2.12

### @fusion/engine

#### Patch Changes

- @fusion/core@0.10.0
- @fusion/pi-claude-cli@0.10.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.10.0

### @runfusion/fusion

#### Minor Changes

- 3218c05: Add support for custom OpenAI-compatible and Anthropic-compatible API providers. Users can add, edit, and remove custom providers from Settings → Authentication or during model onboarding, with automatic ModelRegistry registration and live updates without restart.
- 3fcf5f4: Detect pre-existing Tailscale funnel sessions in Remote Access settings, surface external tunnel status in `/api/remote/status`, and add a kill-external tunnel endpoint plus Settings UI actions to adopt or restart cleanly.

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [3218c05]
- Updated dependencies [f7df0d4]
- Updated dependencies [21402a3]
- Updated dependencies [3fcf5f4]
- Updated dependencies [98c3c22]
- Updated dependencies [491097c]
- Updated dependencies [f118606]
  - @runfusion/fusion@0.10.0

## 0.9.4

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.9.4
- @fusion/engine@0.9.4
- @fusion-plugin-examples/hermes-runtime@0.2.11
- @fusion-plugin-examples/openclaw-runtime@0.2.11
- @fusion-plugin-examples/paperclip-runtime@0.2.11

### @fusion/engine

#### Patch Changes

- @fusion/core@0.9.4
- @fusion/pi-claude-cli@0.9.4

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.9.4

### @runfusion/fusion

#### Patch Changes

- 299b66e: Fix InProcessRuntime creating a nested `.fusion/.fusion/fusion.db`. RoutineStore was being constructed with the project's `.fusion` directory, but its constructor appends `.fusion` internally. Pass the project root instead, matching AutomationStore.
- c3c8007: Add ghost-review fallback recovery to the self-healing maintenance loop. Catches any `in-review` task that fell through every more-specific recovery scan and has been idle past `taskStuckTimeoutMs`, kicks it back to `todo` with transient status cleared. Preserves human-handoff (`awaiting-user-review`, `awaiting-approval`) and active-merge (`merging`, `merging-pr`) statuses; rate-limited naturally by `updatedAt` refresh so a re-stuck task can only be kicked once per timeout window.
- 24e142d: Merge commits now get an AI-generated summary subject describing what changed (e.g. `feat(FN-XXXX): add user-invited webhook handler`) instead of the bare `feat(FN-XXXX): merge fusion/fn-XXXX`. The merger calls the existing `summarizeCommitSubject` lane alongside the body summarizer; on failure or when disabled, falls back to the legacy `merge <branch>` form.

  Default for `useAiMergeCommitSummary` is now `true` (was `false`). Existing projects that haven't explicitly set the flag will pick up the new behavior on next start. The Settings UI already exposes the toggle.

### runfusion.ai

#### Patch Changes

- Updated dependencies [299b66e]
- Updated dependencies [c3c8007]
- Updated dependencies [24e142d]
  - @runfusion/fusion@0.9.4

## 0.9.3

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.9.3
- @fusion/engine@0.9.3
- @fusion-plugin-examples/hermes-runtime@0.2.10
- @fusion-plugin-examples/openclaw-runtime@0.2.10
- @fusion-plugin-examples/paperclip-runtime@0.2.10

### @fusion/engine

#### Patch Changes

- @fusion/core@0.9.3
- @fusion/pi-claude-cli@0.9.3

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.9.3

### @runfusion/fusion

#### Patch Changes

- bb9b0f1: Preserve in-progress card timers and stats across internal workflow rerun bounces.

### runfusion.ai

#### Patch Changes

- Updated dependencies [bb9b0f1]
  - @runfusion/fusion@0.9.3

## 0.9.2

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.10.0
- @fusion/engine@0.10.0
- @fusion-plugin-examples/hermes-runtime@0.2.9
- @fusion-plugin-examples/openclaw-runtime@0.2.9
- @fusion-plugin-examples/paperclip-runtime@0.2.9

### @fusion/engine

#### Patch Changes

- @fusion/core@0.10.0
- @fusion/pi-claude-cli@0.10.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.10.0

### @runfusion/fusion

#### Minor Changes

- 9e5ac3c: Add an optional `useAiMergeCommitSummary` project setting that enables AI-generated merge commit summaries using the title summarizer model lane, with deterministic fallback when disabled or unavailable.
- 19cdf7f: Add dashboard support for managing custom OpenAI/Anthropic/Google-compatible providers via Settings and onboarding advanced sections, backed by new custom-provider API routes and models.json persistence.
- 7eec105: Heartbeat prompts now re-anchor every tick on a Wake Delta + Heartbeat Procedure (paperclip-parity) so permanent agents stop silently grinding on prior tasks. Each tick the agent receives a structured wake delta (source, wake reason, assigned task, pending messages, triggering comments) and re-runs a 7-step procedure (identity → inbox → wake delta → assignment review → pick action → persist → exit) before continuing prior work.

  The procedure is overridable per agent via a new `heartbeatProcedurePath` field pointing at a project-relative markdown file; the file is reloaded fresh each tick so operators can edit it live without restarting agents. New non-ephemeral agents default to `.fusion/HEARTBEAT.md`, and existing agents can be backfilled onto that path via `POST /api/agents/:id/upgrade-heartbeat-procedure` (also surfaced as an "Upgrade to Default Heartbeat Procedure" button in the agent detail Config tab). The default file is seeded from the built-in template on first use; subsequent edits are preserved.

#### Patch Changes

- 6c051b1: Fix the update notification release notes link so it points to the repo changelog.
- 64b5f67: Register custom providers from global settings with the pi ModelRegistry at startup, so they appear as available models without restart.
- cfc8aa3: Fix TUI header overflow when a remote tunnel is configured. Between 100 and 175 columns the remote URL was pushing the left edge (logo + tabs) offscreen; the remote info now lives in a flex-shrinkable, right-justified slot that truncates instead of overflowing. Also gives the QR overlay a solid background so it no longer renders transparent over the underlying TUI.

### runfusion.ai

#### Patch Changes

- Updated dependencies [9e5ac3c]
- Updated dependencies [19cdf7f]
- Updated dependencies [6c051b1]
- Updated dependencies [7eec105]
- Updated dependencies [64b5f67]
- Updated dependencies [cfc8aa3]
  - @runfusion/fusion@0.10.0

## 0.9.1

### @fusion/core

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.

### @fusion/dashboard

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
  - @fusion/core@0.9.1
  - @fusion/engine@0.9.1
  - @fusion-plugin-examples/hermes-runtime@0.2.8
  - @fusion-plugin-examples/openclaw-runtime@0.2.8
  - @fusion-plugin-examples/paperclip-runtime@0.2.8

### @fusion/desktop

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.

### @fusion/engine

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
  - @fusion/core@0.9.1
  - @fusion/pi-claude-cli@0.9.1

### @fusion/mobile

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.

### @fusion/pi-claude-cli

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.

### @fusion/plugin-sdk

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
  - @fusion/core@0.9.1

### @runfusion/fusion

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- 7e832bb: Clear stale agent task links when tasks become terminal or are deleted, fall back to no-task heartbeat instruction runs for archived assignments, and expand built-in agent prompts with explicit heartbeat guidance.
- 118a03a: Keep experimental dashboard views off by default until project settings enable them.
- 291e156: Improve the Git Manager diff layout and file path truncation in dashboard modals.
- c6d67b9: Insights view: two-pane layout (categories sidebar + scrollable detail), full insight content (no line-clamp), larger action icons, fixed scrolling, and mobile single-row header.
- d8baa7a: Show tasks created from planning sessions on the board immediately without requiring a refresh.

### runfusion.ai

#### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
- Updated dependencies [7e832bb]
- Updated dependencies [118a03a]
- Updated dependencies [291e156]
- Updated dependencies [c6d67b9]
- Updated dependencies [d8baa7a]
  - @runfusion/fusion@0.9.1

## 0.9.0

### @fusion/core

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

### @fusion/dashboard

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
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
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [9ce811a]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @fusion/core@0.9.0
  - @fusion/engine@0.9.0
  - @fusion-plugin-examples/hermes-runtime@0.2.7
  - @fusion-plugin-examples/openclaw-runtime@0.2.7
  - @fusion-plugin-examples/paperclip-runtime@0.2.7

### @fusion/desktop

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

### @fusion/engine

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
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
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @fusion/core@0.9.0
  - @fusion/pi-claude-cli@0.9.0

### @fusion/mobile

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

### @fusion/pi-claude-cli

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

### @fusion/plugin-sdk

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @fusion/core@0.9.0

### @runfusion/fusion

#### Minor Changes

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

#### Patch Changes

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

### runfusion.ai

#### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

#### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [17a072c]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [e46f2d4]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [9ce811a]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @runfusion/fusion@0.9.0

## 0.8.4

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.8.4
- @fusion/engine@0.8.4
- @fusion-plugin-examples/hermes-runtime@0.2.6
- @fusion-plugin-examples/openclaw-runtime@0.2.6
- @fusion-plugin-examples/paperclip-runtime@0.2.6

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.4
- @fusion/pi-claude-cli@0.8.4

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.4

### @runfusion/fusion

#### Patch Changes

- 1c4c08b: Verify and tighten npm bundle fixes from FN-2897: keep the vendored pi-claude-cli runtime on Node built-in child_process APIs (no cross-spawn dependency), confirm Claude CLI extension resolution works from the published dist/pi-claude-cli layout, and ensure prepack strips private @fusion/\* workspace devDependencies from the published package manifest.
- 3202e57: Fix SQLite project and central database validation so dashboard and desktop startup handle corrupt database files more predictably.
- 858e244: Fix the TUI startup update notice to use the same version source and cached update gating as the rest of the CLI.
- 995165e: Fix the dashboard version label so it matches the version used by update notifications.
- bd14cf8: Fix Windows path handling for worktree detection and home-directory lookups.
- 995165e: Fix worktree creation failure when git reports "already checked out at" instead of "already used by worktree at"
- 10d565e: Fix OAuth login redirect for non-localhost dashboard access (Tailscale, Cloudflare, LAN).

### runfusion.ai

#### Patch Changes

- Updated dependencies [1c4c08b]
- Updated dependencies [3202e57]
- Updated dependencies [858e244]
- Updated dependencies [995165e]
- Updated dependencies [bd14cf8]
- Updated dependencies [995165e]
- Updated dependencies [10d565e]
  - @runfusion/fusion@0.8.4

## 0.8.3

### @fusion/dashboard

#### Patch Changes

- 9850bfa: Fix TUI token rendering, memory tracking fix, and other minor improvements
  - @fusion/core@0.8.3
  - @fusion/engine@0.8.3
  - @fusion-plugin-examples/hermes-runtime@0.2.5
  - @fusion-plugin-examples/openclaw-runtime@0.2.5
  - @fusion-plugin-examples/paperclip-runtime@0.2.5

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.3
- @fusion/pi-claude-cli@0.8.3

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.3

### runfusion.ai

#### Patch Changes

- @runfusion/fusion@0.8.3

## 0.8.2

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.8.2
- @fusion/engine@0.8.2
- @fusion-plugin-examples/hermes-runtime@0.2.4
- @fusion-plugin-examples/openclaw-runtime@0.2.4
- @fusion-plugin-examples/paperclip-runtime@0.2.4

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.2
- @fusion/pi-claude-cli@0.8.2

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.2

### @runfusion/fusion

#### Patch Changes

- 531b13e: Recover automatically from SQLite FTS5 corruption errors during task upserts by rebuilding the `tasks_fts` index and retrying once. Also adds FTS5 index rebuild/integrity helpers in core database code and extends task store health checks to validate FTS5 integrity.
- 531b13e: Add executor watchdogs to recover stuck `fn_task_done` and workflow rerun handoffs faster.

### runfusion.ai

#### Patch Changes

- Updated dependencies [531b13e]
- Updated dependencies [531b13e]
  - @runfusion/fusion@0.8.2

## 0.8.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.8.1
- @fusion/engine@0.8.1
- @fusion-plugin-examples/hermes-runtime@0.2.3
- @fusion-plugin-examples/openclaw-runtime@0.2.3
- @fusion-plugin-examples/paperclip-runtime@0.2.3

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.1
- @fusion/pi-claude-cli@0.8.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.1

### @runfusion/fusion

#### Patch Changes

- a8dbdbc: Include linked GitHub issue references (`Ref: owner/repo#N`) in executor and merger commit message instructions and merger fallback commits when tasks are sourced from GitHub issues.

### runfusion.ai

#### Patch Changes

- Updated dependencies [a8dbdbc]
  - @runfusion/fusion@0.8.1

## 0.8.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.8.0
- @fusion/engine@0.8.0
- @fusion-plugin-examples/hermes-runtime@0.2.2
- @fusion-plugin-examples/openclaw-runtime@0.2.2
- @fusion-plugin-examples/paperclip-runtime@0.2.2

### @fusion/engine

#### Patch Changes

- @fusion/core@0.8.0
- @fusion/pi-claude-cli@0.8.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.8.0

### @runfusion/fusion

#### Minor Changes

- 58510e1: Add CLI support for multi-node routing: configure project default node (`fn settings set defaultNodeId`), unavailable-node policy (`fn settings set unavailableNodePolicy`), per-task node overrides (`fn task set-node`, `fn task clear-node`), and `--node` flag for `fn task create`.
- 81c6f01: Add node routing policy enforcement: when a task is routed to a node that is offline or unhealthy, the project's `unavailableNodePolicy` setting controls whether execution is blocked (task stays in todo) or falls back to local execution. Supports `defaultNodeId` project setting for pinned default nodes and per-task `nodeId` overrides. Routing decisions are logged to task activity for visibility.
- c9241d8: Add pluggable notification provider system with built-in ntfy and webhook support.
- 22bac2d: Refactor merge conflict strategies into two `smart-*` flavors and change the default to "prefer main".

  Both smart strategies now run a best-effort `git fetch` + fast-forward of local main from `origin` before the merge cascade — a freshly-pushed sibling commit no longer gets clobbered when the fallback resolves a conflict against a stale base. They differ only in the per-file final fallback:

  - **`smart-prefer-main`** (new default): `-X ours` — main wins. Best when concurrent agents could regress just-merged sibling work.
  - **`smart-prefer-branch`**: `-X theirs` — task branch wins. Equivalent to the previous `"smart"` behavior.

  Legacy enum values are accepted for backwards compatibility and normalized at load time: `"smart"` → `"smart-prefer-branch"`, `"prefer-main"` → `"smart-prefer-main"`. Settings on disk continue to work without changes.

#### Patch Changes

- f19ecac: Add dedicated POST /api/memory/dream endpoint and triggerMemoryDreams() client helper for manual dream processing.
- cc9181d: Recover automatically from SQLite FTS5 corruption during task upserts by rebuilding the `tasks_fts` index and retrying once, and add FTS5 integrity checks to database health monitoring.
- 5cc7597: Fix npm bundle reliability for the published CLI package by removing the vendored pi-claude-cli `cross-spawn` runtime dependency, validating bundled pi-claude-cli resolution from `dist/`, and preventing private `@fusion/*` workspace dev dependencies from leaking into the packed manifest.
- 2029968: Fix project-level model overrides so they take precedence over the default model fallback consistently across dashboard and engine AI flows.
- cd03c6a: Add runfusion.ai links to dashboard update-available notices in the banner and settings modal.
- 7227b87: Add a retry button to failed task error boxes on dashboard task cards so users can retry directly from the card without opening task details.
- 198f85c: Fix dashboard onboarding: the "Welcome to Fusion" setup wizard is now scrollable on short viewports (older laptops / browsers without `dvh` support), and the model-onboarding modal reliably opens after the wizard closes on a fresh install instead of racing it or being suppressed.

### runfusion.ai

#### Patch Changes

- Updated dependencies [f19ecac]
- Updated dependencies [58510e1]
- Updated dependencies [cc9181d]
- Updated dependencies [5cc7597]
- Updated dependencies [2029968]
- Updated dependencies [cd03c6a]
- Updated dependencies [7227b87]
- Updated dependencies [81c6f01]
- Updated dependencies [c9241d8]
- Updated dependencies [198f85c]
- Updated dependencies [22bac2d]
  - @runfusion/fusion@0.8.0

## 0.7.1

### @fusion/core

#### Patch Changes

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

### @fusion/dashboard

#### Patch Changes

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

- Updated dependencies [ce6dcef]
  - @fusion/core@0.7.1
  - @fusion/engine@0.7.1
  - @fusion-plugin-examples/hermes-runtime@0.2.1
  - @fusion-plugin-examples/openclaw-runtime@0.2.1
  - @fusion-plugin-examples/paperclip-runtime@0.2.1

### @fusion/desktop

#### Patch Changes

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

### @fusion/engine

#### Patch Changes

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

- Updated dependencies [ce6dcef]
  - @fusion/core@0.7.1
  - @fusion/pi-claude-cli@0.7.1

### @fusion/mobile

#### Patch Changes

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

### @fusion/pi-claude-cli

#### Patch Changes

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

### @fusion/plugin-sdk

#### Patch Changes

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

- Updated dependencies [ce6dcef]
  - @fusion/core@0.7.1

### @runfusion/fusion

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

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

- Updated dependencies [ce6dcef]
  - @runfusion/fusion@0.7.1

## 0.7.0

### @fusion/core

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### @fusion/dashboard

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0
  - @fusion/engine@0.7.0
  - @fusion-plugin-examples/hermes-runtime@0.2.0
  - @fusion-plugin-examples/openclaw-runtime@0.2.0
  - @fusion-plugin-examples/paperclip-runtime@0.2.0

### @fusion/desktop

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### @fusion/engine

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0
  - @fusion/pi-claude-cli@0.7.0

### @fusion/mobile

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### @fusion/pi-claude-cli

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### @fusion/plugin-sdk

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0

### @runfusion/fusion

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- ec09282: Add dashboard vitest process controls with a new `POST /api/kill-vitest` endpoint and System Stats modal UI for manual kills plus auto-kill settings management.
- 92b8631: Fix automation execution pipeline reliability by improving ProjectEngine automation startup diagnostics and health visibility, adding due-schedule regression coverage, and fixing manual automation runs to execute ai-prompt and create-task steps (including continueOnFailure handling) instead of command-only behavior.
- 8fbd3bd: Fix plugin-install loader taskStore compatibility by ensuring CLI plugin install paths are covered with regression tests for `getRootDir` expectations.
- 347cae8: Load enabled plugins during dashboard, serve, and daemon startup so plugin runtimes are available to agent runtime selection immediately after boot.
- 0a5dcf1: Fix `/api/system-stats` so process/system metrics still return when project resolution fails, with task and agent aggregates gracefully falling back to zero counts.
- 3c8a490: Fix `fn plugin install` failing in CLI plugin commands by adding `getRootDir()` to the mock TaskStore used by `createPluginLoader`.
- 637f435: Fix pi-claude-cli planning hangs by simplifying custom MCP tool guidance to direct `mcp__custom-tools__*` calls (no `ToolSearch` prerequisite), aligning custom-tool handling diagnostics, and adding regression coverage for `ls`/triage MCP tool mapping behavior.
- 7691bab: Respect globalPause/enginePaused in heartbeat trigger scheduler and monitor to prevent agents from running when the engine is paused at startup.

### runfusion.ai

#### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

#### Patch Changes

- Updated dependencies [ec09282]
- Updated dependencies [92b8631]
- Updated dependencies [8fbd3bd]
- Updated dependencies [347cae8]
- Updated dependencies [0a5dcf1]
- Updated dependencies [3c8a490]
- Updated dependencies [637f435]
- Updated dependencies [7691bab]
- Updated dependencies [b30e017]
  - @runfusion/fusion@0.7.0

## 0.6.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.6.0
- @fusion/engine@0.6.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.6.0
- @fusion/pi-claude-cli@0.6.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.6.0

### @runfusion/fusion

#### Minor Changes

- f4d98ed: Add a `--git` flag to `fn init` to auto-initialize a git repository (including an initial commit) when the target directory is not already a git repo.
- 6caab17: Add project settings to auto-comment on imported GitHub issues when tasks move to done, plus dashboard GitHub integration support for posting issue comments.
- fdf8ca9: Reframe the CLI splash to "multi node agent orchestrator" with `runfusion.ai` and the current version, and surface the version alongside URL/host/auth/uptime in the dashboard System panel and status bar.

### runfusion.ai

#### Patch Changes

- Updated dependencies [f4d98ed]
- Updated dependencies [6caab17]
- Updated dependencies [fdf8ca9]
  - @runfusion/fusion@0.6.0

## 0.5.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.5.0
- @fusion/engine@0.5.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.5.0
- @fusion/pi-claude-cli@0.5.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.5.0

### @runfusion/fusion

#### Minor Changes

- b969635: v0.5.0: status terminology refresh (planning/replan), Reviewer rename, in-review pause behavior, dashboard-tui resize hardening, dev-server experimental toggle fix, and version reporting fix.

#### Patch Changes

- 112ad67: Fix experimental feature save normalization so disabling Dev Server clears the legacy `devServer` alias (`null` delete) alongside canonical `devServerView`, preventing stale nav visibility after save.
- 16ec204: Fix dashboard health/version reporting to read the version from package.json instead of relying on npm_package_version with a stale hardcoded fallback.
- 79ce48c: Fix pausing behavior for in-review tasks so stop fully halts merge activity. Paused in-review tasks are now marked with paused status, removed from merge queues, active merge sessions are aborted/disposed, self-healing recovery skips paused tasks, and unpausing re-enqueues eligible review tasks for auto-merge.
- c85ffa9: Rename status values: specifying→planning, needs-respecify→needs-replan. Display label "Triage"→"Planning". Includes DB migration for existing records.
- 03a48ae: Update dashboard and CLI status strings: specifying→planning, needs-respecify→needs-replan. Update user-facing text from "triage/specify" terminology to "planning/replan" terminology.
- c1b0121: Rename "Validator" to "Reviewer" across all dashboard UI labels and descriptions.

### runfusion.ai

#### Patch Changes

- Updated dependencies [112ad67]
- Updated dependencies [16ec204]
- Updated dependencies [79ce48c]
- Updated dependencies [c85ffa9]
- Updated dependencies [03a48ae]
- Updated dependencies [c1b0121]
- Updated dependencies [b969635]
  - @runfusion/fusion@0.5.0

## 0.4.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.4.1
- @fusion/engine@0.4.1

### @fusion/engine

#### Patch Changes

- @fusion/core@0.4.1
- @fusion/pi-claude-cli@0.4.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.4.1

### @runfusion/fusion

#### Patch Changes

- b5200ba: Add Cloudflare Quick Tunnel mode for Remote Access so Fusion can auto-provision an ephemeral `trycloudflare.com` URL via `cloudflared tunnel --url` without requiring a pre-created named tunnel or tunnel token.
- 8097db2: Rename status values: specifying→planning, needs-respecify→needs-replan. Display label "Triage"→"Planning". Includes DB migration for existing records.

### runfusion.ai

#### Patch Changes

- Updated dependencies [b5200ba]
- Updated dependencies [8097db2]
  - @runfusion/fusion@0.4.1

## 0.4.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.4.0
- @fusion/engine@0.4.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.4.0
- @fusion/pi-claude-cli@0.4.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.4.0

### @runfusion/fusion

#### Minor Changes

- 9d8852e: Add project-level overlap ignore paths so teams can exempt safe shared files/directories from overlap-based task serialization while keeping overlap protection enabled for the rest of the repo.

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [f560af5]
- Updated dependencies [cd4cef3]
- Updated dependencies [7e05a20]
- Updated dependencies [c818d71]
- Updated dependencies [c818d71]
- Updated dependencies [ff6a68b]
- Updated dependencies [1b3994f]
- Updated dependencies [1a8058f]
- Updated dependencies [39622f0]
- Updated dependencies [26f9c74]
- Updated dependencies [9d8852e]
  - @runfusion/fusion@0.4.0

## Unreleased

### @fusion/pi-claude-cli

#### Patch Changes

- Add missing Anthropic model metadata entries to provider registration: `claude-sonnet-4-6`, `claude-sonnet-4-5`, and `claude-haiku-4-5` (alongside existing `claude-opus-4-7`) so they appear in the model picker even before upstream catalog updates.
- Improve subprocess diagnostics in `streamViaCli` by:
  - logging Claude stderr on close at warn level even when exit code is 0,
  - logging debug spawn correlation details (PID + effective args) when `PI_CLAUDE_CLI_DEBUG=1`,
  - warning when a subprocess closes without producing any content events.

### @runfusion/fusion

#### Patch Changes

- FN-2501: Agent pause/resume controls now act immediately. Pausing stops an active heartbeat run right away, and resuming to `active` triggers an immediate on-demand heartbeat instead of waiting for the next timer tick.

## 0.2.7

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.2.7
- @fusion/engine@0.2.7

### @fusion/engine

#### Patch Changes

- @fusion/core@0.2.7

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.2.7

### @runfusion/fusion

#### Patch Changes

- adbad8a: Add `fn plugin add` as a backward-compatible alias for `fn plugin install`, and update plugin command help text to advertise the alias while keeping `install` as the canonical command.

### runfusion.ai

#### Patch Changes

- Updated dependencies [adbad8a]
  - @runfusion/fusion@0.2.7

## 0.2.6

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.2.6
- @fusion/engine@0.2.6

### @fusion/engine

#### Patch Changes

- @fusion/core@0.2.6

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.2.6

### @runfusion/fusion

#### Patch Changes

- dbc9446: Add a blocking dashboard token-recovery dialog that appears only for daemon bearer-token 401 responses, with set-token or clear-token recovery actions that reload the app.

### runfusion.ai

#### Patch Changes

- Updated dependencies [dbc9446]
  - @runfusion/fusion@0.2.6

## 0.2.5

### @runfusion/fusion

#### Patch Changes

- 69f789f: TUI: layered defenses for the resize / wrong-height-layout bug

  Materially reduces (but doesn't fully eliminate) the symptom of the header rendering off-screen or the layout taking 1-2 too many rows, especially under tmux/ssh.

  - Enter alternate-screen buffer on start; leave on stop. The TUI gets a dedicated fullscreen surface that doesn't share scrollback.
  - StatusBar Text children no longer wrap (default `wrap="wrap"` was letting long hotkey + URL strings wrap to 2 rows, throwing the row budget off by 1).
  - Controller subscribes to `process.stdout` "resize" and calls `inkInstance.clear()` to reset log-update's frame tracking.
  - App-level resize listener + key-based remount on dimension change so React rebuilds the tree from scratch with fresh bounds.
  - Root Box gets explicit width + overflow="hidden"; MainHeader outer Box too.
  - Settings + Utilities side-by-side now stretch to equal heights (UtilitiesPanel switched from `flexShrink={0}` to `flexGrow={1}`).

### runfusion.ai

#### Patch Changes

- 69f789f: TUI: layered defenses for the resize / wrong-height-layout bug

  Materially reduces (but doesn't fully eliminate) the symptom of the header rendering off-screen or the layout taking 1-2 too many rows, especially under tmux/ssh.

  - Enter alternate-screen buffer on start; leave on stop. The TUI gets a dedicated fullscreen surface that doesn't share scrollback.
  - StatusBar Text children no longer wrap (default `wrap="wrap"` was letting long hotkey + URL strings wrap to 2 rows, throwing the row budget off by 1).
  - Controller subscribes to `process.stdout` "resize" and calls `inkInstance.clear()` to reset log-update's frame tracking.
  - App-level resize listener + key-based remount on dimension change so React rebuilds the tree from scratch with fresh bounds.
  - Root Box gets explicit width + overflow="hidden"; MainHeader outer Box too.
  - Settings + Utilities side-by-side now stretch to equal heights (UtilitiesPanel switched from `flexShrink={0}` to `flexGrow={1}`).

- Updated dependencies [69f789f]
  - @runfusion/fusion@0.2.5

## 0.2.4

### @runfusion/fusion

#### Patch Changes

- 88b4ecb: TUI fixes: help overlay no longer crashes, header stays rendered

  - Help overlay (`?` / `h`) crashed with "Encountered two children with the same key" because several shortcut entries share the same display key (`[t]` for Git view AND for Toggle engine pause; `[r]` for Refresh stats AND Refresh agent detail). Switch to index-based keys — each row is unique by position, not by character.
  - Refresh the help text to reflect the unified header (`[m]` Main, `[b/a/g/t/e]` views), the Settings/Files/Agents `←/→` pane swap, the Git push/fetch shortcuts, the Files hidden-files toggle, and the Logs `G` jump-to-end.
  - Main view (status mode) header sometimes vanished after a tmux pane switch and stayed missing until a terminal resize. Two fixes: (a) drop the `rows < 10` auto-hide in `MainHeader` — tmux pane switches can briefly report stale or zero dimensions, and a transient `return null` was orphaning the header. (b) Wrap `MainHeader` and `StatusBar` in `flexShrink={0}` boxes inside `StatusModeGrid` and `StatusModeSingle` (matching the prior fix in `InteractiveMode`), so Yoga can't squeeze them to 0 rows when content pressures the row budget.

### runfusion.ai

#### Patch Changes

- 88b4ecb: TUI fixes: help overlay no longer crashes, header stays rendered

  - Help overlay (`?` / `h`) crashed with "Encountered two children with the same key" because several shortcut entries share the same display key (`[t]` for Git view AND for Toggle engine pause; `[r]` for Refresh stats AND Refresh agent detail). Switch to index-based keys — each row is unique by position, not by character.
  - Refresh the help text to reflect the unified header (`[m]` Main, `[b/a/g/t/e]` views), the Settings/Files/Agents `←/→` pane swap, the Git push/fetch shortcuts, the Files hidden-files toggle, and the Logs `G` jump-to-end.
  - Main view (status mode) header sometimes vanished after a tmux pane switch and stayed missing until a terminal resize. Two fixes: (a) drop the `rows < 10` auto-hide in `MainHeader` — tmux pane switches can briefly report stale or zero dimensions, and a transient `return null` was orphaning the header. (b) Wrap `MainHeader` and `StatusBar` in `flexShrink={0}` boxes inside `StatusModeGrid` and `StatusModeSingle` (matching the prior fix in `InteractiveMode`), so Yoga can't squeeze them to 0 rows when content pressures the row budget.

- Updated dependencies [88b4ecb]
  - @runfusion/fusion@0.2.4

## 0.2.3

### @runfusion/fusion

#### Patch Changes

- 0f070d8: TUI header redesign and Settings ←/→ pane navigation

  - Replace the dual section + interactive tab strips with a single unified strip: `[m] Main  [b] Board  [a] Agents  [g] Settings  [t] Git  [e] Explorer`. Status mode highlights the Main pill; interactive views highlight their own. Number-key shortcuts (1–5) for status sections still work but are no longer rendered in the header chrome.
  - Width tiers now fit comfortably at every terminal size: full labels at cols ≥ 90, glyph-only at 50–89 (every shortcut still visible), FUSION + active pill only below 50. Help/quit shows at cols ≥ 110.
  - New `m` shortcut switches to status mode (Main); `s` kept as alias.
  - Settings interactive view: `←` focuses the list pane, `→` focuses the detail pane. `Tab` still cycles either way (consistent with Agents view).

### runfusion.ai

#### Patch Changes

- 0f070d8: TUI header redesign and Settings ←/→ pane navigation

  - Replace the dual section + interactive tab strips with a single unified strip: `[m] Main  [b] Board  [a] Agents  [g] Settings  [t] Git  [e] Explorer`. Status mode highlights the Main pill; interactive views highlight their own. Number-key shortcuts (1–5) for status sections still work but are no longer rendered in the header chrome.
  - Width tiers now fit comfortably at every terminal size: full labels at cols ≥ 90, glyph-only at 50–89 (every shortcut still visible), FUSION + active pill only below 50. Help/quit shows at cols ≥ 110.
  - New `m` shortcut switches to status mode (Main); `s` kept as alias.
  - Settings interactive view: `←` focuses the list pane, `→` focuses the detail pane. `Tab` still cycles either way (consistent with Agents view).

- Updated dependencies [0f070d8]
  - @runfusion/fusion@0.2.3

## 0.2.2

### @runfusion/fusion

#### Patch Changes

- 58688fa: Keep the FUSION header from wrapping when the terminal is narrow. The `MiniLogo` and tab pills had Yoga's default `flexShrink: 1`, so the row's collective content overrunning the width was being absorbed by shrinking every child — including FUSION, which then wrapped to two lines. Pin all fixed-content header children to `flexShrink={0}`; the trailing flexGrow filler absorbs slack instead.

### runfusion.ai

#### Patch Changes

- 58688fa: Keep the FUSION header from wrapping when the terminal is narrow. The `MiniLogo` and tab pills had Yoga's default `flexShrink: 1`, so the row's collective content overrunning the width was being absorbed by shrinking every child — including FUSION, which then wrapped to two lines. Pin all fixed-content header children to `flexShrink={0}`; the trailing flexGrow filler absorbs slack instead.
- Updated dependencies [58688fa]
  - @runfusion/fusion@0.2.2

## 0.2.1

### @runfusion/fusion

#### Patch Changes

- 07d7bac: Add a blocking dashboard token-recovery dialog that appears only for daemon bearer-token 401 responses, with set-token or clear-token recovery actions that reload the app.

### runfusion.ai

#### Patch Changes

- Updated dependencies [07d7bac]
  - @runfusion/fusion@0.2.1

## 0.2.0

### @runfusion/fusion

#### Minor Changes

- a8f5591: Add support for an optional custom ntfy server URL in notification settings, with default fallback to `https://ntfy.sh` when unset.

### runfusion.ai

#### Patch Changes

- Updated dependencies [a8f5591]
  - @runfusion/fusion@0.2.0

## 0.1.3

### @runfusion/fusion

#### Patch Changes

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

### runfusion.ai

#### Patch Changes

- Updated dependencies [c105cfa]
- Updated dependencies [86521e2]
- Updated dependencies [76961d4]
- Updated dependencies [f77dd9d]
- Updated dependencies [f4d2a4b]
- Updated dependencies [f77dd9d]
- Updated dependencies [31f021a]
- Updated dependencies [eef56af]
- Updated dependencies [832c32c]
- Updated dependencies [dce70bf]
- Updated dependencies [f078a4e]
  - @runfusion/fusion@0.1.3

## 0.1.2

### @runfusion/fusion

#### Patch Changes

- 9bf2981: Add a `planning-awaiting-input` ntfy notification event so users can opt in to alerts when planning sessions pause for user input.
- Fix the CLI init command import path for the Claude skills runner so tsup can resolve it during build.
- 94473c8: Improve dashboard shutdown observability by logging non-fatal diagnostics when `CentralCore.close()` fails during dispose, normal signal shutdown, or dev-mode shutdown cleanup.
- Fix dashboard and serve command plugin store initialization to support task store implementations that expose `getFusionDir()` without `getRootDir()`.
- c01892d: Route dashboard runtime diagnostics through the shared injected runtime logger so TTY sessions can capture server/package logs in the TUI while preserving readable non-TTY startup banner output.

### runfusion.ai

#### Patch Changes

- Updated dependencies [9bf2981]
- Updated dependencies
- Updated dependencies [94473c8]
- Updated dependencies
- Updated dependencies [c01892d]
  - @runfusion/fusion@0.1.2

## 0.1.1

### @runfusion/fusion

#### Patch Changes

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

### runfusion.ai

Catch-up version bump so `runfusion.ai` stays in sync with `@runfusion/fusion`. The two packages are now grouped under changesets `fixed` in `.changeset/config.json` and will always share a version number from here on.

## 0.1.0

### @runfusion/fusion

#### Minor Changes

- 25d44e1: Add interactive TUI to `fn dashboard` with five navigable sections: logs, system, utilities, stats, and settings. Keyboard shortcuts enable quick in-terminal navigation (1-5, arrows, q, Ctrl+C, ? for help). The TUI activates automatically in interactive terminal sessions; non-TTY mode (CI, piped output) retains the existing plain-text banner/log behavior.

#### Patch Changes

- a2ed6d0: Fixes for stuck merges and agent lifecycle controls.

  - `findLandedTaskCommit` now falls back to scanning all of `HEAD` when the bounded `baseCommitSha..HEAD` range returns no commits (e.g. baseCommitSha was advanced past the landed merge by a fast-forward rebase). Previously the recovery silently returned null and re-queued the merge even though the commit had already landed.
  - Agent heartbeat triggers and registration are gated by `runtimeConfig.enabled` rather than transient agent state, so paused/idle/error agents stay registered for triggers and re-arm immediately on resume without waiting for a state transition.
  - `AgentDetailView` exposes a Stop control alongside Pause/Retry for `running` and `error` states so operators can terminate stuck agents without going through the agents list.

## 0.0.6

### @runfusion/fusion

#### Patch Changes

- Re-ship three previously reverted fixes and add pre-merge remote rebase.

  - `--no-auth` flag now correctly suppresses bearer-token auth instead of being silently overridden by a stale `FUSION_DAEMON_TOKEN` in the project's `.env`.
  - Workflow-review revisions reopen only the last step rather than resetting every previously-completed step. The agent applies the feedback as an in-place fix and earlier approved work stays done. New `reopenLastStepForRevision` helper is used by `handleWorkflowRevisionRequest`, `handleWorkflowStepFailure`, and `sendTaskBackForFix`. `determineRevisionResetStart` is marked `@deprecated` and kept exported for tests.
  - Heartbeat scheduling is now driven by `agent.state` (`active`/`running` = timer armed; everything else = timer cleared), not `runtimeConfig.enabled`. Resuming a paused agent through the dashboard now re-arms the timer immediately.
  - New setting `worktreeRebaseBeforeMerge` (default `true`) and companion `worktreeRebaseRemote` (default: git's configured default). The merger fetches the remote and rebases the task branch onto the latest default-branch tip before merging; conflicts flow into the existing smart/AI resolve cascade. Dashboard Settings → Worktrees exposes a checkbox and a remote dropdown populated from `/api/git/remotes/detailed`.
  - Last/Next heartbeat labels on the agent list card now share font-size and inline-flex alignment so they line up cleanly.

### runfusion.ai

#### Patch Changes

- Updated dependencies
  - @runfusion/fusion@0.0.6

## 0.0.5

### @runfusion/fusion

#### Patch Changes

- 41553a5: Harden agent lifecycle around closed tasks and heartbeat defaults.

  - `HeartbeatMonitor.executeHeartbeat()` now exits before session creation when the resolved task is done/archived (reason `task_closed`) and clears the stale `agent.taskId` linkage so the guard isn't re-tripped on every tick.
  - `HeartbeatTriggerScheduler.watchAssignments()` skips callback dispatch when the assigned task is already closed (when a `taskStore` is wired in).
  - `POST /api/agents/:id/runs` performs the same preflight check and returns 409 with a structured error naming the task id + column, keeping the existing active-run 409 precedence.
  - `AgentStore.createAgent()` now persists `runtimeConfig.heartbeatIntervalMs` (default 1h) on non-ephemeral agents so the dashboard's freshness signal matches the scheduler's effective cadence instead of depending on whether the user ever opened the heartbeat dropdown. Exports a new `DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS` constant.

### runfusion.ai

#### Patch Changes

- Updated dependencies [41553a5]
  - @runfusion/fusion@0.0.5

## 0.0.4

### @runfusion/fusion

#### Patch Changes

- 0da498a: Fix dashboard onboarding auth token controls, keep the AI planning modal footer visible on desktop, and add better terminal PTY spawn diagnostics.

### runfusion.ai

#### Patch Changes

- Bump the alias package to stay in sync with the current Fusion release.

## 0.0.3

### @runfusion/fusion

#### Patch Changes

- 1fc72d1: Improve the dashboard agents list views with shared empty-state actions, token-based state styling, and clearer board/tree/org-chart presentation.
- 46b8032: Make `fn agent import` import package skills alongside agents when importing from directory or archive sources. Skills are written to `{project}/skills/imported/{company-slug}/{skill-slug}/SKILL.md` with proper frontmatter formatting. Existing skill files are skipped rather than overwritten. Single AGENTS.md file imports do not include package skills.
- c1bc5b9: Fix CLI merge regressions in test/build verification: restore gh-cli test alias resolution, ensure daemon ignores invalid env tokens, and restore required changeset config.
- 06704cf: Fix the setup wizard directory browser and make terminal session startup more resilient.

### runfusion.ai

#### Patch Changes

- Updated dependencies [0da498a]
  - @runfusion/fusion@0.0.4

## 0.0.2

### @runfusion/fusion

#### Patch Changes

- Add `fusion` bin alias so `npx @runfusion/fusion` resolves to the CLI
  (the `fn` command is still available and unchanged).

### runfusion.ai

#### Patch Changes

- Updated dependencies [1fc72d1]
- Updated dependencies [46b8032]
- Updated dependencies [c1bc5b9]
- Updated dependencies [06704cf]
  - @runfusion/fusion@0.0.3

## 0.0.1

### @runfusion/fusion

#### Initial release

First public release under the `@runfusion` scope. Package was previously
developed under the `@gsxdsm/fusion` name; it was never published to npm,
so version history resets with `0.0.1`. Pre-release notes preserved below
for reference.

## 0.4.0 (pre-release, unpublished)

### @runfusion/fusion

#### Minor Changes

- 2d13b82: Add pi extension. Installing `@runfusion/fusion` via `pi install` now provides native tools (`fn_task_create`, `fn_task_list`, `fn_task_show`, `fn_task_attach`, `fn_task_pause`, `fn_task_unpause`) and a `/fn` command to start the dashboard and AI engine from within a pi session.
- 494de14: Changed `autoMerge` to default to `true` for new boards.
- 50821fc: Add global pause button to stop all automated agents and scheduling
- cac10af: Split engine control into Pause (soft) and Stop (hard). The dashboard Header now shows two buttons: "Pause AI engine" stops new work from being dispatched while letting in-flight agents finish gracefully, and "Stop AI engine" (previously the only Pause button) immediately kills all active agent sessions. A new `enginePaused` setting field controls the soft-pause state alongside the existing `globalPause` hard-stop.

#### Patch Changes

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

### @runfusion/fusion

#### Patch Changes

- ae90be0: Bundle workspace packages into CLI for npm publish. The published package previously declared dependencies on private `@kb/core`, `@kb/dashboard`, and `@kb/engine` workspace packages, causing `npm install` to fail. Switched the CLI build from `tsc` to `tsup` (esbuild) to inline all `@kb/*` workspace code into a single bundled `dist/bin.js`, while keeping third-party packages (`express`, `multer`, `@mariozechner/pi-ai`) as external dependencies. Dashboard client assets are now copied into `dist/client/` so the published tarball is fully self-contained.
- 28bbcb9: Exclude Bun-compiled platform binaries from npm publish tarball, reducing package size significantly.

## 0.3.0

### @runfusion/fusion

#### Minor Changes

- fc7582d: Expand agent.log logging to all agent types, additionally capturing thinking, and agent roles
- cc999ef: RETHINK verdicts trigger git reset and conversation rewind, re-prompting the agent with feedback

#### Patch Changes

- f3c7f7d: CLI `task create` now supports a `--depends <id>` flag (repeatable) to declare task dependencies at creation time.
- fc7582d: Code review REVISE verdicts are now enforced such that agents can no longer advance steps without APPROVE
- cc999ef: Plan RETHINK triggers conversation rewind with REVISE enforcement on code reviews
- cc999ef: Dependent tasks can start from in-review dependency branches instead of waiting for merge

## 0.0.8

### runfusion.ai

#### Patch Changes

- Updated dependencies [39f7709]
- Updated dependencies [585e480]
- Updated dependencies [86fd24e]
- Updated dependencies [585e480]
- Updated dependencies [7d31b21]
- Updated dependencies
- Updated dependencies [ff5df16]
- Updated dependencies [df2836c]
- Updated dependencies [bbdd11a]
- Updated dependencies [0bb0100]
  - @runfusion/fusion@0.1.1

## 0.0.7

### runfusion.ai

#### Patch Changes

- Updated dependencies [25d44e1]
- Updated dependencies [a2ed6d0]
  - @runfusion/fusion@0.1.0

## 0.39.25

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.60.0

## 0.39.24

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.59.0

## 0.39.23

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.58.0

## 0.39.22

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.57.0

## 0.39.21

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.56.1

## 0.39.20

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.56.0

## 0.39.19

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.55.0

## 0.39.18

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.54.0

## 0.39.17

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.53.1

## 0.39.16

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.53.0

## 0.39.15

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.52.0

## 0.39.14

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.51.0

## 0.39.13

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.50.0

## 0.39.12

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.49.0

## 0.39.11

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.48.0

## 0.39.10

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.47.0

## 0.39.9

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.46.0

## 0.39.8

### @fusion/i18n

#### Patch Changes

- Updated dependencies [26ebb92]
- Updated dependencies [7e7eb62]
  - @fusion/core@0.45.0

## 0.39.7

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.44.0

## 0.39.6

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.43.1

## 0.39.5

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.43.0

## 0.39.4

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.42.0

## 0.39.3

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.41.0

## 0.39.2

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.40.1

## 0.39.1

### @fusion/i18n

#### Patch Changes

- @fusion/core@0.40.0

## 0.11.51

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.51

## 0.11.50

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.50

## 0.11.49

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.49

## 0.11.48

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.48

## 0.11.47

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.47

## 0.11.46

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.46

## 0.11.45

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.45

## 0.11.44

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.44

## 0.11.43

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.43

## 0.11.42

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.42

## 0.11.41

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.41

## 0.11.40

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.40

## 0.11.39

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.39

## 0.11.38

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.38

## 0.11.37

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.37

## 0.11.36

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.36

## 0.11.35

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.35

## 0.11.34

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.34

## 0.11.33

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.33

## 0.11.32

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.32

## 0.11.31

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.31

## 0.11.30

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.30

## 0.11.29

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.29

## 0.11.28

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.28

## 0.11.27

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.27

## 0.11.26

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.26

## 0.11.25

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.25

## 0.11.24

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.24

## 0.11.23

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.23

## 0.11.22

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.22

## 0.11.21

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.21

## 0.11.20

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.20

## 0.11.19

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.19

## 0.11.18

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.18

## 0.11.17

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.17

## 0.11.16

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.16

## 0.11.15

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.15

## 0.11.14

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.14

## 0.11.13

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.13

## 0.11.12

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.12

## 0.11.11

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.11

## 0.11.10

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.10

## 0.11.9

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.9

## 0.11.8

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.8

## 0.11.7

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.7

## 0.11.6

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.6

## 0.11.5

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.5

## 0.11.4

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.4

## 0.11.3

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.3

## 0.11.2

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.2

## 0.11.1

### @fusion/droid-cli

#### Patch Changes

- @fusion-plugin-examples/droid-runtime@0.1.1
