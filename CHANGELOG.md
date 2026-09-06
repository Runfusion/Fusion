# Fusion changelog

User-facing release notes aggregated across all packages. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.

## 0.78.0-beta.3

### Highlights

- Approve button on board and list cards works again after a page reload
- Review bypass now reaches any blocking gate, and merge blockers name the gate at fault
- Blocked review cards stay recoverable: collateral-archived gates are restored automatically
- Reference another Direct chat by conversation ID with bounded #id context
- Task lists and hold-release scheduling are faster from batched workflow selection reads

### New

- Reference another Direct chat by pasting its conversation ID, and pull in bounded `#id` context.
- The chat delivery-history tool is now named `fn_history_read`. The Patchnode view, navigation, and API stay where they are.

### Fixed

- The Approve button on board and list cards no longer does nothing after a page reload.
- The review bypass now reaches any blocking gate, not just a failed one, and the merge blocker names the gate at fault.
- Review gates archived as collateral by another gate's remediation are restored on startup and during maintenance, so blocked cards stay recoverable. No verdict is ever fabricated, and operator waivers, workspace cards, paused cards, and live sessions are left alone.
- A review remediation now archives only the gate it is remediating instead of every failed gate.
- Restarting an operator review starts the gate's revision budget fresh instead of inheriting what the previous episode spent.
- Archived pre-merge review failures are recoverable again through operator bypass.
- A verdict rescued from a malformed reviewer reply can no longer be downgraded to an approval — an empty finding list reads as unknown, not as nothing blocking.
- Stale review approvals no longer leave merge cards permanently failed; the outdated review lane is routed back to current content.
- A task being planned is no longer read as abandoned work and re-dispatched mid-planning.
- Planning retries preserve annotated plan steps and manual approval.
- Workflow step activity history shows up again for unassigned tasks.
- Automatic dependency repair keeps working without archived-history error noise.
- Bulk archive completes refinement chains reliably and reports which items are still active.
- New agent-log entries survive an interrupted prior write, and corruption warnings are aggregated per read.
- Generated fix features come back, so validated defects can become board tasks again.
- Stale recommendation notices in the mailbox now explain why they have no inline actions, distinguishing a missing parent task from a replaced recommendation.

### Performance

- Task lists and hold-release scheduling batch their workflow selection reads instead of issuing one per task.

## 0.78.0-beta.2

### Highlights

- Reviewers are judge-only by default and must emit a verdict to approve a gate
- Cloud Link pairs and self-tunnels: fn serve starts cloudflared and heartbeats the URL every 20s
- Planning runs on main, so AI concurrency no longer eats worktree capacity
- Dashboard terminal works on macOS with no native compile step
- Tasks stuck waiting on a finished file-scope blocker now clear themselves

### Breaking

- Reviewers are judge-only by default: inline reviewer fixes are off, a machine-readable verdict is required to pass a review gate, and Code Review remediation is bounded by a revision cap.
- The concurrency resolver and API no longer report a single effective limit or binding knob; admission now classifies whether a task consumes a worktree.
- 32-bit Linux terminal payloads are no longer supported.

### New

- Linked Fusion instances start a Cloudflare tunnel automatically. `fn serve` and `fn dashboard` point `cloudflared` at the bound dashboard port and heartbeat candidate URLs — including host rotations — every 20 seconds, so Cloud Link keeps working when the URL changes. `fn cloud heartbeat` with no `--url` does the same until you stop it.
- New `fn cloud` CLI for device pairing: `pair-start`, `pair-complete`, `heartbeat`, `status`, and `unlink`, with device state in `~/.fusion/cloud-link.json`. Remote login redeems a cloud ticket against your configured cloud endpoint and issues a short-lived token. Point it at an endpoint with `FUSION_CLOUD_HTTP_URL` or `--http`.
- Tasks are planned on main before any worktree is created, so planning no longer holds a worktree slot and AI concurrency is capped separately from worktree capacity.
- Quick Chat controls now minimize and restore every open chat window together.
- Reusable chat snippets: save them in Skills & Snippets and insert them with a slash command from any dashboard composer.
- Mobile New Task moved to the header edge, and artifact images gained zoom controls — wheel, pinch, keyboard, double-click, and drag-to-pan.
- PostgreSQL backups now carry migration bookkeeping and restore it with rollback protection.

### Fixed

- Reviewer output without a verdict can no longer approve a review gate; prose approval is gone from both the workflow-step and reviewer parsers.
- File-scope overlap waits clear automatically once the blocking task finishes, reconciled across self-healing, completion fan-out, and scheduler dispatch.
- The dashboard terminal runs on macOS without manually compiling native code, using script-free platform packages verified against the lockfile.
- Misnumbered plan steps no longer rerun completed work, and step dependency annotations now line up with their numbered headings.
- Terminal task failures survive temporary storage outages and restarts instead of being lost.
- Interrupted step sessions recover in place without discarding completed work.
- Multi-repository landing progress now shows in Task Detail's Details tab instead of the header.
- Skills and Chat Snippets are separate responsive tabs with per-tab counts and refresh actions.
- Dismissed update notices stay dismissed per release across dashboard sessions.
- PostgreSQL backup pair listing is fixed, and native restore validates paired dumps, retains rollback evidence, and enforces project-only retention.

### Internal

- Folder ZIP downloads migrated to the archiver 8 ESM API.

## 0.78.0-beta.1

### Highlights

- Claude Fable 5.1 works again when signing in with an Anthropic subscription
- Muse Spark models are selectable in the model picker with pricing attached
- Bundled Pi runtime moves from 0.84.1 to 0.84.4
- Pin the reported Claude Code client version with an environment override

### New

- Muse Spark models are now selectable wherever you pick a model, with pricing configured for the four credentialed-provider keys.
- The bundled Pi runtime advances from 0.84.1 to 0.84.4.

### Fixed

- Claude Fable 5.1 no longer fails on Anthropic subscription login with a too-old-client error. A new client-identity policy sends a current version, and an environment override lets you pin the reported Claude Code version yourself if a future upstream bump gets ahead of the release.

## 0.78.0-beta.0

### Highlights

- Claude Fable 5.1 selectable in Anthropic and Claude CLI model pickers, with pricing
- Review cards with enabled pre-merge checks that never ran now recover automatically
- Skipped pre-merge gates re-enter review in place instead of stalling the card

### New

- Claude Fable 5.1 is available in the Anthropic and Claude CLI model pickers, with pricing wired in so cost tracking stays accurate.

### Fixed

- A review card whose enabled pre-merge checks never ran is now detected and reseeded, so it re-enters the missing gate in place instead of sitting in review unmerged. The reroute is recorded in the run audit.

## 0.77.0

### Highlights

- Breaking: executing agents no longer create tasks — findings become completion recommendations
- Remote login links now mint expiring sessions instead of handing over the dashboard token
- Auto-merge waits for Code Review, and an in-flight merge no longer aborts itself every 15 seconds
- Idle and paused projects drop from ~98% CPU to under 50% by backing off polling and git sweeps
- New Coding (Ideas) V2 workflow runs verification and documentation as visible review gates

### Breaking

- Executing agents no longer create tasks; out-of-scope findings are recorded as completion recommendations instead.
- Complex requests stay as one planned task — task splitting and the subtask/fan-out routes are removed.
- Revision findings are the only thing that can move a task backward; the assorted automatic replan and terminal-failure sweeps are gone.
- Task recovery is simplified to Retry, Reset, and Delete; Reset opens an editable original-description dialog and replaces Respecify.
- Unplanned tasks can no longer be force-started into execution on any surface.
- The per-task manual plan-approval toggle and shield badges are removed; plan approval is resolved from settings.
- Every configured repository is prepared in a task-ID worktree before work starts; `worktreeNaming`, `recycleWorktrees`, and `fn_acquire_repo_worktree` are removed.

### Security

- Remote login links no longer redirect with the dashboard's real non-expiring token. They now mint an opaque, expiring, revocable session delivered as an HttpOnly cookie, so revoking a remote token actually signs the recipient out.
- A remote tunnel that cannot start now reports `stopped` with a reason instead of claiming it is starting.

### New

- Coding (Ideas) V2 workflow: verification and documentation run as review-lane gates rather than hidden checklist entries, with Code Review running lint/test/build itself and quoting output as evidence.
- Update Fusion from source in one click — pull, rebuild, and restart from Command Center; the Docker entrypoint is now a restart supervisor.
- Add OrcaRouter as a named model provider with startup catalog sync, plus Grok 4.6 in the built-in Grok catalog.
- Stash memory backend: complete-chat-session capture, per-task capture, executor transcript upload for finished or failed tasks, a per-chat "Preserve to Stash" backfill action, and opt-in semantic recall.
- New Patchnode/History view with a searchable, permanent daily log of completed and reverted tasks.
- Terminal sessions are now shared across browsers, with close-here vs end-session and a Reopen control.
- Prometheus-format `/metrics` endpoint on the dashboard for runtime and domain metrics.
- Fast lane for quick task changes without planning or pre-merge review.
- Task detail gains a History tab and a consolidated Summary with merge details and per-step timings; reports, changes, and spend each have one home.
- Chat: agent mentions and quoting, a docked resizable conversation sidebar, multiple pop-out Quick Chat windows, contextual Find, and bubble-or-full-width message layout.
- Board and List gain arrival and task-ID sorting, desktop click-drag panning, and preserved view state.
- ACP runtimes can expose Fusion `fn_*` tools to external agents such as Hermes ACP and Prime.
- Cursor CLI runs through Fusion's supervised runtime, with Fusion task tools bridged into its sessions and cross-runtime fallback support.
- New Velvet, Iceberg, Flexoki, Cozy Cartoon, and Medieval color themes.
- `pnpm dev --tunnel` publishes a dev server through a Cloudflare quick tunnel, and `pnpm dev --isolated` runs the dev server against its own database and project directory.
- Workspace tasks can use one custom branch name across every sub-repository, choose a verified base branch per repository, and derive branch names from configured JIRA issues.

### Fixed

- Merges no longer stall forever: an in-flight merge stopped aborting itself every 15 seconds, and a landed merge finalizes even when the task row has no steps.
- Auto-merge no longer merges a task before its workflow's code review has finished; every merge door is now a recovery servicer rather than a merge initiator.
- A rejected code review now reliably produces named fix steps that start on the first try, instead of leaving the card stuck in review with no explanation.
- A blocking review gate no longer records approval when the reviewer never returned a usable verdict.
- Fixed a startup crash where Fusion rejected the database it had just migrated, and a chat failure from a renumbered migration leaving `memory_focus` missing.
- Starting Fusion no longer interrupts a working install with onboarding questions; onboarding always creates the central database.
- First-ever provider logins no longer fail silently on a fresh install; Anthropic Subscription and OpenAI Codex sign-in are fixed, and a persistent sign-in dialog keeps the paste field and status visible.
- Remote access reports "running" for a tunnel that survived a restart, targets the port the dashboard is really on, survives an engine restart, and works in Docker.
- The Docker image now ships ca-certificates, git-lfs, ripgrep, gh, tailscale, cloudflared, and Google Chrome; builds no longer OOM and first-run volume permissions are correct.
- Fusion sets its own git identity for commits, so hosts with no ambient git config no longer stall an auto-merge.
- Workspace/multi-repository work: code review no longer reports delivered files as missing, approvals persist, per-repository landing status is visible, uncommitted edits in a shared checkout no longer stall completion, and concurrent acquisition no longer loses sub-repo worktrees.
- Task worktrees and branches are preserved through recovery, reclaim, and rebind instead of being lost to the idle sweep.
- Task Feed no longer shows "(no activity)" when opened directly on the activity view.
- Chat fixes across mobile and desktop: keyboard-aware composers, five-line caps, preserved streamed prefixes after Stop, focus on open, back-arrow icon, and readable source links.
- Dashboard event streams for an unknown project return 404 instead of logging a 500.
- Board fixes: task detail opens on card click, columns stop scrolling on text selection, controls stay clickable in narrow windows, and mobile column releases settle smoothly.
- Verification gates that reported PASS without running your tests now actually run them; a failing test or build creates named fix steps.
- A failed database query now explains what went wrong instead of printing the whole SQL statement.

### Performance

- Idle and paused projects no longer poll in a tight loop: task-lifecycle outbox consumers back off toward a 60s cadence, targeting ~98% CPU down to under 50%.
- Periodic self-healing no longer runs git churn on paused projects, and repair sweeps are bounded so health and UI stay fast.
- Each task's workflow selection is read once per scheduler tick instead of ~6x, cutting scheduler CPU and health-API latency.
- Creating a task from an Insights recommendation is no longer slow on large boards.

### Internal

- Bundled Pi runtime upgraded from 0.82.1 to 0.84.1 for updated provider and model support.
- Retired the Coding (review-gated) workflow, superseded by Coding (Ideas) V2.
- Added dedicated pipeline coverage proving a rejected code review produces fix steps that run and merge.

## 0.77.0-beta.14

### Highlights

- Auto-generated chat titles stay in your configured output language
- Mixed-language chats no longer get mislabeled titles from ambiguous text

### Fixed

- Chat title summarization now honors the resolved output language target, so English chats keep English titles
- Language detection is stricter on medium-confidence Latin-script text, cutting mislabeled titles

## 0.77.0-beta.13

### Highlights

- Approved tasks no longer get stuck unmergeable when review proof is missing or stale
- A landed merge now finalizes even when the task row carries no steps
- Your selected Claude account beats a leftover legacy Anthropic sign-in
- Codex sign-in works on remote dashboards, with device codes for every OAuth provider
- Command Center gets a compact section dropdown and self-recovering System controls

### New

- Command Center section tabs are now a compact, accessible dropdown — every section is still there, just without the wrapping tab row.
- Readonly workflow steps can now use explicitly named MCP servers.

### Fixed

- Approved tasks no longer become permanently stuck when merge review proof is missing: proof is enforced before dispatch and at the sink, bypass is limited to audited humans, and reconciliation is audited.
- Inline review fixes no longer leave an approved task unable to merge — verified review identity is re-captured and stale singular content is rerouted out of merge admission.
- A merge that already landed now finalizes when the task row has no steps, instead of silently never emitting a merged event.
- Interrupted merges from pre-upgrade worktree layouts now resume without dirty-checkout refusals.
- Finished worktrees holding regenerable build and dependency output are cleaned up; anything not on the allowlist stays behind the landing-proof gate.
- Your selected Claude account now takes precedence over a leftover legacy Anthropic sign-in.
- Adding a credential instance no longer creates a duplicate OAuth account.
- OpenAI Codex sign-in works on remote dashboards (device code by default, explicit browser override), and stalled logins no longer hang in the background.
- Same-numbered tasks from different projects no longer bleed into each other on the board.
- Workflow lists reflect workflow edits immediately, with no daemon restart.
- Reopening a terminal restores the existing session immediately instead of waiting on validation.
- Retargeting an existing Direct chat keeps the selected agent.
- Command Center's System controls come back on their own after a failed capability probe — a tab left open across a dev-server restart no longer loses Rebuild and plugin cards.
- Emphasized text and visible borders are restored across mailbox, chat, settings, and task details.
- Mailbox task cards render with the correct padding, spacing, borders, and text sizes.
- Mobile: the chat footer and composer sit flush above the keyboard on every platform, and the New Task priority button stays compact instead of stretching across the row.
- Settings shows the correct Direct Chat default help text.

## 0.77.0-beta.12

### Highlights

- Update Fusion from source in one click — pull, rebuild, and restart from Command Center
- Remote access survives engine and container restarts instead of silently dying
- Code review revisions now start their fix steps on the first try instead of stalling
- Task dispatch and recovery no longer stall when Fusion re-pins a worktree branch
- Board, List, and Chat keep their state when you return to a visited view

### New

- Command Center can update Fusion from source in one click: git pull, install, workspace build, and a restart that only happens if the build succeeded. The Docker entrypoint now acts as a restart supervisor and supports running from source.
- Task worktrees now live under `.fusion/worktrees` by default, the legacy `.worktrees` root is still cleaned up, and merged workspace checkouts are removed after landing.
- Board, List, and Chat are retained when you navigate away and back, so scroll position and view state survive; hidden views release their header and unread-message side effects.
- Task activity log timestamps now show precise millisecond clock times across Live, Feed, Raw, and Interventions.

### Fixed

- A code review revision now writes its fix steps and reopens implementation on the first try, instead of stalling with the card frozen in review. This covers the step-ledger reopen path, the inline atomic branch Code Review always takes, revisions after a dashboard Retry, cards canceled in the review lane, and the field-separator bug that made every remediation claim write fail against PostgreSQL.
- A blocked or refused review always explains itself on the task now — including when the concurrency marker cannot be written — rather than returning silently with no entry.
- Remote access reports its real state: a tunnel that survived a restart shows as running, a tunnel serving traffic is never reported as stopped, and a funnel on a different port is refused rather than clobbered.
- Stopping or restarting the engine no longer kills remote access, tunnel start/stop/status work with no engine attached, and a stopped engine can be restarted from the UI. A supervised restart releases and re-adopts the live Tailscale funnel instead of spawning a competitor.
- Remote access no longer dies after a `docker restart`: `tailscaled` liveness is now decided by an actual running process, not a stale socket file left behind in the writable layer.
- Task dispatch and recovery no longer fail when Fusion re-pins a worktree branch. Operator-provided branches keep their operator marker (including through numeric sibling renames) and stay protected from engine branch cleanup.
- Workspace projects now honor the push-after-merge setting, refresh repository bases at implementation dispatch, and serialize safely when file scopes overlap.
- Chat focuses the message box when you open or create a conversation, with phone and touch-tablet suppression.
- ACP runtime session failures now name the scoping cwd and the JSON-RPC diagnostic, so you can tell a misconfigured spawn target from an agent-side fault.

## 0.77.0-beta.11

### Highlights

- Task recovery is now just Retry, Reset, and Delete — Respecify and Restart stage are gone
- Reset opens an editable description dialog and deletes the task branch so the next run starts clean
- Every configured repo is prepped in a task-ID worktree; worktreeNaming and recycleWorktrees removed
- New Fast lane runs quick changes with no planning and no pre-merge review
- New History view keeps a permanent, searchable daily log of completed and reverted tasks

### Breaking

- Task recovery is simplified to Retry, Reset, and Delete. The restart-stage route and the Respecify and Restart stage dashboard actions are removed; Retry restarts the current stage and is now visible on intake cards.
- Reset replaces Respecify: it opens an editable original-description dialog, and the client `resetTask` parameter order changed to options-second, projectId-last.
- Every configured repository is prepared in a task-ID worktree before work starts. The `worktreeNaming` and `recycleWorktrees` settings, the `fn_acquire_repo_worktree` tool, and `POST /tasks/:id/repository-scope` are removed, and persisted values for the removed settings are ignored. Adds multi-ecosystem dependency bootstrap and a blocking Plan Review dependency gate.
- Revision findings are now the only authority that can move a task backward. Blocked-exit auto-replan, several recovery and sweep paths, and executor stuck-kill terminalization are removed along with their audit events.
- Unplanned tasks can no longer be force-started. The promote force option, `issueRelease` unplanned waiver, promote force API field, `fn_task_promote` force parameter, and the forced-promote audit event are gone.
- The per-task manual plan-approval toggle and shield badges are removed; plan approval resolves from settings only.

### New

- Fast lane: create quick tasks that run one implementation pass, skipping planning and selected pre-merge review groups while keeping the normal merge path.
- History view: a searchable, permanent daily log of completed and reverted tasks, with a read-only chat tool for reading it. Each re-delivery gets its own dated entry, and entries outlive archive cleanup.
- Task History tab collects the planning, implementation, review, and merge reports for a task in one place.
- Tasks that hit an external infrastructure block now preserve their work and resume exactly where they stopped, with dashboard recovery and audit events.
- Multi-repository tasks can be reset safely back to fresh planning, including workspace coordination cleanup.
- Planning Mode history shows the original prompt that started the session, read-only.
- Duplicating a task lets you choose an enabled workflow, and Planning Mode create requests honor the default.
- Plan-preserving Respecify: revise the spec without discarding the approved plan.
- Reviewers must now supply notes with every verdict, and those notes appear in task activity summaries.
- Task logs show complete, readable tool inputs and outputs; persisting tool output is now on by default, with clamped raw log and CLI blocks.
- Task Detail is consolidated: Cost, Routing, Debug, Attachments, and Recommendations are folded into Stats, Details, Artifacts, and Summary. Summary now carries merge details and per-step timings.
- New Cozy Cartoon theme with a pastel light palette and oversized rounded buttons.

### Fixed

- Reset and manual cancel now stop a running task cleanly, leaving no failed step and no blocked merge.
- Merged review cards can advance to Done, and merged task worktrees are cleaned up before completion.
- The merger no longer re-runs a full AI merge for work that already landed, short-circuiting to finalization when the landing is proven.
- Self-healing reclaim keeps task branches and checkouts attached when it hits a non-conflict failure, and rebinds relocated worktrees from Git.
- Automatic recovery stays in its owning lifecycle stage, with visible move attribution and workspace checkout reuse.
- Workspace Code Review reports one complete verdict across every modified repository, persists approvals so reviewed tasks can merge, and reopens implementation with named fixes when changes are requested.
- Workspace tasks can retry their current stage without losing per-repository landing progress, and workspace Reset no longer deletes a task directory held by an active session.
- Review fix steps keep being created past three rounds while the evidence actually changes, and frozen review cycles no longer repeat the same model without change evidence.
- Completed verification history is preserved, and a fresh verification pass is required after review fixes.
- Checks that could not run are shown as not executed instead of passed.
- No-change tasks conclude once with a visible terminal outcome, and Review shows a single completion summary with the empty Merge section removed.
- Tasks no longer freeze when a required tool is unavailable; host capabilities are injected into planning and Plan Review.
- Waiting planning and implementation work starts as soon as shared capacity frees up, while overlapping tasks stay queued until unfinished work lands.
- Activity Feed entries stay current over SSE, task History moves into Activity Summaries, and duplicated review reports render once.
- The task Plan summary survives transient prompt refresh failures.
- Long steering messages and comments are no longer rejected.
- Per-task human plan approval is visible and actionable from the workflow planning lane.
- Remediation steps use concise review finding titles instead of full finding bodies.
- Reset tasks restart in Planning with their confirmed original request.
- Board controls stay clickable in narrow desktop windows; board tiles show the pointing hand, and panning shows the grabbing hand.
- Optional review selections are restored after turning off Fast task creation mode.
- Task timelines stay consistent across workspace and single-repository runs.

## 0.77.0-beta.10

### Highlights

- Task detail splits into Plan, dependencies, attachments, details and debug tabs
- Plan tab opens with a plain-language summary of what the task delivers
- Manual column-move controls removed from the board and task detail
- Docker image now ships Google Chrome, so container browser automation works
- Skills, automations and routines now list per project instead of coming up empty

### Breaking

- Dashboard controls that manually moved tasks between workflow columns are gone; Replan All now rebuilds the spec instead.
- Task detail tabs are renamed and re-homed: Plan keeps steps and PROMPT.md, while dependencies, attachments, details and debug get their own tabs. The original prompt section and the retries deep link now land on details.

### New

- Plan now leads with a "What This Delivers" summary so you can confirm a task's intent at a glance.
- Task Chat merges model selection and thinking level into a single Brain popover.
- New Flexoki theme: warm inky dark, cream paper light.
- Task detail can explain why a task is blocked by a file-scope overlap with another task.

### Fixed

- The Docker image installs Google Chrome, so the agent-browser plugin and the Chrome DevTools MCP server work in a container instead of failing every call. Chrome's sandbox still needs unprivileged user namespaces, so pass `--no-sandbox` or run with `--security-opt seccomp=unconfined`.
- Skills discovery resolves project-local roots per request, so each project shows its own installed skills and the catalog stops offering duplicate installs.
- Automations and Routines honor project scope instead of returning an empty list.
- Workspace tasks no longer stall on uncommitted edits sitting in a shared repo checkout; only a task-attributed commit blocks completion, and uncommitted entries are recorded as a warning.
- Multi-repository Code Review fixes are routed back to the repository that actually failed.
- Agents can read secret values returned by `fn_secret_get`.
- Popped-out chats open on the thread you asked for, and stacked floating windows stay visibly separated.
- Selecting text on the board no longer scrolls Kanban columns out from under you.
- The New Task Start button appears whenever quick entry would allow a start.
- Reasoning bodies show alongside titles for OpenAI Responses models.

## 0.77.0-beta.9

### Highlights

- Verification gates no longer report a pass without running your tests
- Blocking review gates stop approving merges when the reviewer returned no verdict
- Merges no longer abort themselves mid-flight or after every repo has landed
- New Coding (Ideas) V2 workflow runs verification and docs as visible review gates
- New Stash memory backend captures chats, task completions and executor transcripts

### New

- Coding (Ideas) V2 is selectable as a built-in workflow: Code Review runs lint/test/build itself and must quote command output as evidence, then a readonly Documentation gate writes the card summary and can propose follow-ups in the Recommendations tab. Two fewer model calls per card and one blocking gate instead of four.
- Stash memory backend (`memory.backendType=stash`) with global and per-project URL/API-key settings, per-project session folders, per-conversation memory focus, and per-task completion capture.
- Finished or failed tasks upload their executor transcript to Stash as a task session, capped at 20,000 events by default and never blocking terminalization. New project settings control whether capture runs, the event cap, and status lines.
- Per-chat "Preserve to Stash" action backfills a chat's full history with real per-message timestamps; re-running it inserts nothing new.
- Opt-in semantic (vector) recall for Stash via `stashVectorSearch`, off by default, falling back to keyword search on any failure.
- Direct-chat agent mentions and message quoting; Ctrl/Cmd-click opens a new chat in an offset in-app window, and pop-outs now open in front on the right conversation.
- Press Shift+V in the TUI Logs panel for a chrome-free view you can select and copy with the mouse.
- Chat memory focus is now an opt-in experimental feature, and its button stays icon-only until a topic is set.
- Duplicate tasks show a dismissible tag instead of a Keep button, and reverted tasks stay labelled in their own workflow column.
- Onboarding asks once whether to star Fusion on GitHub, and never again once dismissed.
- The dashboard now always reloads when it detects a new build; the opt-out toggle is gone.
- Dashboard notices share one banner style.

### Fixed

- A Verification gate could report PASS in about 46ms without executing your test or build command, supplying merge evidence for a check that never ran.
- A blocking review gate recorded success when the reviewer returned no usable verdict, merging unreviewed work on a rejection nobody could see. Advisory gates are unchanged.
- An in-flight merge aborted itself every 15 seconds and was re-admitted indefinitely, so merges never completed.
- A successful multi-repository merge aborted itself after both repositories had landed, verified duplicates ended as errors, and merge checks ran without a test runner because an inherited production environment skipped devDependencies.
- Chat failed with `column memory_focus does not exist` after a renumbered migration was skipped; the missing columns are now verified and repaired at startup.
- A failing test, build, or code review now appends named fix steps instead of bouncing a card with nothing to do; per-step failures stay inside their step.
- Documentation can no longer hold a merge or send a card back with nothing to do, and the step now really writes the card summary.
- A task's Feed no longer shows "(no activity)" when opened directly on the activity view.
- A failed merge no longer strands review-column tasks on their verification and delivery gates.
- Multi-repository code review no longer reports delivered files as missing, and local-only workspace merges no longer fail after a repo has landed.
- Task cards and list rows now show Verification, Documentation & Delivery and Code Review progress while a card sits in review; in-review cards show the running gate as a badge.
- Start in the task composer no longer does nothing on a duplicated Ideas workflow.
- A task whose workflow role pool is unroutable is no longer re-dispatched; the hold waits as intended.
- Workspace acquisition waits are recoverable and visible via a Waiting badge.
- A failed database query now reports the actual reason instead of printing the whole SQL statement.
- The task journal no longer announces aborts that never happened or repeats the merge approval twice.
- The built-in Fusion memory MCP server is no longer skipped in agent sessions.
- Chat Stop and Force send now interrupt the active model turn before teardown; thinking traces are readable and have a raw transcript view.
- Chat no longer opens an imported link into a hidden composer or re-anchors a thread on open; memory Focus popovers stay usable on mobile.
- Custom review lanes are honored across merge-readiness checks and merge finalization.
- Project registration now creates or adopts a usable local integration branch, and task branches survive worktree reclamation.
- Automatic worktree cleanup fails closed on dirty or unverifiable content.
- Worktree agents can read skills installed under `~/.agents/skills`.
- Full-size mailbox Inbox icons restored on mobile; JIRA settings available in every dashboard locale.
- CLI plugin packaging succeeds again with sharp 0.35 native binaries.
- Archived task-planner chats soft-delete their Stash sessions, and Stash backfill no longer duplicates or drops messages when timestamps tie or mislabels the first project folder.

### Internal

- Database maintenance now covers 17 previously missed project tables, including plan-evidence and lifecycle tables.
- Workflow gates are classified by what they are rather than by their name or id.
- The Coding (review-gated) workflow is retired in favour of Coding (Ideas) V2; existing tasks that selected it keep working.
- New pipeline drives prove a rejected code review produces named fix steps that run and merge, and the restart-recovery scenario no longer fails under load.

## 0.77.0-beta.8

### Highlights

- Auto-merge no longer merges a task before its workflow code review finishes
- Tasks whose branch already merged no longer stick as failed with unfinished steps
- Full Chat gains a resizable docked conversation sidebar and thread-title switching
- Chat and the mobile nav bar stay usable with the on-screen keyboard open
- New Iceberg theme, plus chat filter, back arrow, and mailbox task ID fixes

### New

- Full Chat has a resizable docked conversation sidebar; its width and open state persist across sessions.
- Switch Direct chats straight from the thread title without going back to the conversation list.
- Added the Iceberg color theme: navy-slate in dark mode, pale blue-gray in light.

### Fixed

- Auto-merge is fenced on satisfied pre-merge gates: the in-review sweep, the column-entry handoff, the unpause re-enqueue, and the pre-dispatch check all service recoveries instead of starting merges. A card merges only when it is merge-confirmed, parked at a merge-region node, recovering an interrupted attempt, or long-quiescent, and a foreign live session always defers. Workspace and shared-branch-group cards follow the same rules.
- A task whose branch already landed can no longer get stuck as failed with unfinished steps; once landing is proven, incomplete steps are logged rather than blocking finalization. A no-op merge that landed no content still blocks.
- Restored title-based duplicate redirects in triage, and planning-stall diagnostics now survive a failed audit write instead of being silently marked as throttled.
- The Chat message box stays visible above the software keyboard on tablets and landscape phones.
- The mobile navigation bar no longer rises with the on-screen keyboard.
- The chat conversation switcher dropdown is now visible on narrow chat surfaces.
- The chat sidebar shows a compact Archived toggle on the tag filter line, and the tag filter has proper inner padding so "All tags" is not cramped.
- Chat's back button uses a real back arrow icon instead of a text character.
- Mailbox task links show the real task ID instead of a raw placeholder.

### Performance

- Merge sweep reads are batched, so admission costs a fixed number of queries per poll rather than scaling with the number of cards on the board.

## 0.77.0-beta.7

### Highlights

- Executing agents can no longer create tasks; out-of-scope findings become recommendations
- Startup crash fixed: Fusion no longer rejects the database it just migrated
- Auto-merge that runs before a Code Review gate now defers instead of failing the task
- Board cards open task detail on click again, and empty card areas pan the board
- OrcaRouter joins the provider list with a startup model-catalog sync

### Breaking

- Agents running a task can no longer create or delegate new tasks. Out-of-scope findings now come back as completion recommendations instead of self-spawned work.

### New

- OrcaRouter is available as a named model provider, with its model catalog synced at startup and surfaced in the auth catalog, onboarding quick start, provider icons, and settings.
- Quick Chat pop-outs let you keep several conversations open in independent windows, each with its own session preferences.
- Chat has contextual Find: Ctrl/Cmd+F searches the active conversation list or transcript.
- Titled AI thinking traces expand and collapse independently across dashboard transcripts.
- Automated review revisions now converge on a verdict while preserving the full review history, including disputed findings and arbitration.
- Managed deployments can suppress in-app updates via FUSION_UPDATES_EXTERNALLY_MANAGED, and the updater explains when an npm install path is unsupported.

### Fixed

- Fusion no longer crashes on startup by rejecting a database it had just migrated itself.
- A task no longer fails permanently when auto-merge runs before its Code Review gate; the merge defers and in-review cards stay out of the merge queue until every enabled pre-merge gate has a result.
- Clicking a Board task card opens task detail again; panning starts only once horizontal intent is clear, and card bodies pan the Board on desktop and tablet while moves stay in the Move to menu.
- Workflow steps run by ACP agents (Hermes, Prime, Grok) no longer crash before producing a verdict; ACP sessions now stream events to subscribers as well as callbacks.
- Planning no longer loops on missed plan-save confirmations; the prompt write is verified with a read-back.
- Renamed board columns are respected: task moves land on their real workflow lanes, and late workspace repository acquisition is refused based on the task's selected workflow.
- Workspace auto-merge works for linked task worktrees, stale workspace changes get re-reviewed before landing, and repositories without a remote can land locally.
- Workspace tasks now run inside one scoped directory with sandbox delegation and clearer merge-door gates.
- AI merge no longer blocks on its own review protocol markers.
- Direct chat headers show provider-reported session context usage.
- Task reset safely fences active planning sessions, releasing held locks while keeping operator input.
- Task concurrency settings and the capacity actually enforced now agree.
- Self-healing stops retrying no-progress tasks forever; retries use a persisted budget with backoff before parking for an operator.
- Impossible auto-archives stop retrying and surface the abandoned archive on the task.
- Tailscale remote access in the Docker image no longer dies with "process exited 1": the daemon starts in userspace mode when opted in with --tailscale or FUSION_TAILSCALE=1, login state persists across container recreates, and an unreachable or logged-out backend reports an actionable reason.

### Internal

- The bundled dependency-graph plugin tracks the current dashboard task card and scoped-storage APIs.

## 0.77.0-beta.6

### Highlights

- Chat logs and supported file-editor saves up to 2 MiB save without payload errors
- Workspace merges stop retry-looping once repositories have already landed
- Single-repository worktree acquisition works again, with no destructive validation retries
- Settings keeps the installed-update restart prompt when you reopen it

### Fixed

- Larger chat logs and supported file-editor saves now go through instead of failing with a payload error; the chat and escaped-file routes accept up to 2 MiB while every other route keeps the default limit.
- Workspace merge retries no longer loop after their repositories have landed. Durable landing obligations are preserved, and workspace merge failures are reported truthfully instead of being retried away.
- Single-repository worktree acquisition is restored, and deterministic acquisition validation failures now stop instead of retrying destructively. Branch-write provenance is enforced across production callers.
- Reopening Settings after an update installs no longer loses the restart prompt; the outgoing dashboard process keeps reporting its pending install until it is replaced.

## 0.77.0-beta.5

### Highlights

- Complex requests stay one planned task — automatic task splitting is removed
- Workspace tasks can share one custom branch across every sub-repo, or derive it from JIRA
- Docker image ships git-lfs, so LFS-tracked files check out as real content, not stubs
- Mobile task creation and Board/List navigation now reachable from every project view
- Approved AI merge reviews land instead of dropping into corrective merge loops

### Breaking

- Complex requests are kept as a single planned task. Task splitting, split-driven parent deletion, and the dashboard subtask and planning fan-out routes are removed.

### New

- Workspace tasks can use one custom branch name across every sub-repository, including reusing an existing branch, with task-aware PR heads and collision attach.
- Workspace branch names can be derived from configured JIRA issues.
- Mobile task creation and Board/List navigation are available from every project view, with Planning quick entry preserved.
- The Activity Log supports exact task-ID search, composable with project and event-type filters.
- Update installation and restart are now independent controls, and dashboard update restarts wait for the installed version before reloading.
- Start a new chat directly from the header of an active conversation.

### Fixed

- The Docker image installs git-lfs, so LFS-tracked files check out as real content instead of ~130-byte pointer stubs on an apparently clean tree.
- Desktop Board dragging works again from safe empty-column surfaces; mobile Board scrolling and column snapping are unchanged.
- Approved AI merge reviews no longer enter corrective merge loops — findings are stored with the task and the same candidate is confirmed before landing.
- Multi-repository merges stay live through long AI land operations by renewing repository land leases.
- Multi-repository tasks no longer review or recover clean unrelated repositories.
- Clearing a Task Detail description deletes the task through your configured confirmation preference.
- Soft-deleting a task can explicitly remove incoming dependency references.
- Dashboard chat textareas autosize through five lines and shrink again when content is removed; no mouse resizing.
- Task Chat's model selector is as wide as Direct Chat's, so model names stay readable.
- Starting a new idle chat no longer raises a false interrupted-response save warning.
- Failing or stalled audit telemetry no longer delays task lifecycle operations, engine recovery, merge work, deleted-task outbox delivery, workflow recovery, reservation cleanup, or detached memory captures.

### Internal

- Remaining engine audit telemetry (hold-release, goals, overseer, mesh lease, runtime rotation, column boundaries) routes through the shared bounded emit seam.

## 0.77.0-beta.4

### Highlights

- Workspace tasks get per-repo verified base branches and can add repositories after setup
- Move tasks from a Move to menu on Board and List; native drag-and-drop is gone
- Stop now keeps the partial chat reply, and message edits rewind and resend atomically
- Two new dashboard themes: Velvet and Medieval, plus bubble or full-width chat layout
- Merge fixes: foreach tasks no longer stall in review, stuck merging cards clear on interrupt

### New

- Move Board and List tasks from a contextual Move to menu that groups every legal destination in one accessible submenu.
- Workspace tasks can pick and display a verified base branch per repository, with a safe fallback and durable pinning for landing and revert.
- Add workspace repositories after a project is registered, and group workspace worktrees beneath configurable workspace roots.
- Two new themes: Velvet (plum and burgundy dark, blush-white light) and Medieval (parchment surfaces, wood-framed modals, bundled pixel font with no CDN request).
- Project Appearance preference for bubble or full-width chat messages, applied across normal, Quick, dock, Activity, and Planner Chat.
- Sort every Board column and the paged Archive by arrival or task ID; Board lanes keep their local sort choice.
- Task-detail Chat now uses the Direct Chat default model with task-aware context, plus model and thinking controls.
- Model selectors expose the thinking levels a model actually supports, including Max; custom-provider models offer Off through Max and send the selected effort.
- Copy the displayed task Activity Feed logs with one localized action.
- Choose English, the input language, or the interface language for AI-authored task text.
- New project setting requires a quality-first recommendation evaluation when a task completes.
- Mission features gain done-credit via reverse lineage, re-point and unlink agent tools, and live unlink updates over SSE.
- Desktop Board background drag panning across workflow columns, safe against text, cards, and controls.
- Project and workflow model overrides are organized into one Settings group.
- `pnpm dev --isolated` runs the dev server against its own database, settings, and project directory, so it no longer adopts a live instance's tasks.
- Merge-boundary proof parks are now recorded in run-audit history with closed reason codes.

### Fixed

- Freshly generated Remote Access links authenticate immediately, and a Cloudflare tunnel URL is labeled correctly instead of as a Tailnet URL.
- Completed foreach workflow tasks no longer stall indefinitely in merge review.
- Interrupted manual merges clear their merging status instead of leaving cards stuck, including on SIGINT, SIGTERM, and SIGHUP.
- Blocked AI merge reviews no longer retry as git conflicts, and unavailable merge diagnostics survive every merge dispatch path.
- Windows-locked AI merge clean-room worktrees are reliably reclaimed, and a blocked bundled PostgreSQL library now recovers automatically when antivirus interferes.
- Multi-repository tasks can no longer use a workspace-root worktree; stale routing metadata is repaired without losing sub-repository progress.
- Files Changed stays scoped to task-owned files after a rebase, omitting unproven remote changes.
- Chat composers cap at five lines and scroll long drafts, resize from the top edge, and restore their height after a draft is cleared.
- Direct and room chat transcripts stay visible during background refresh; Chat navigation is now a conversation list plus a full-pane detail.
- Chat source links stay complete and readable and open in a new tab with `noopener noreferrer`.
- Task Chat context stays bound to the selected project even when its engine is unavailable.
- Saved custom providers are recognized, and built-in model catalogs refresh live.
- New Task keeps workflow choices and adds a guarded Start action for manual-intake workflows; disabled built-in workflows no longer appear in selectors.
- Refinement follow-ups route straight into the workflow's planning lane; short untitled tasks get a deterministic title, and automatic title summarization is project-controlled.
- Project onboarding now produces task-ready Git repositories or fails closed.
- Oversized task drafts can no longer exhaust browser storage: free text is capped at 64,000 bytes and stale entries are reclaimed.
- The duplicate "Move to Planning" entry is gone from review-lane task cards, and duplicate Task Failed activity entries no longer appear.
- Mounted Appearance settings apply immediately from either Settings view, and the conversation layout setting is findable in Settings search.
- Mobile Board column releases settle smoothly into the valid column.
- Audit telemetry failures can no longer stall or abort task execution.

### Internal

- Restored the production i18n catalog lint guardrail and kept all supported app catalogs structurally synchronized.
- Removed retired Board compatibility styling with no change to live scrolling behavior.

## 0.77.0-beta.3

### Highlights

- Remote login links mint an expiring session cookie instead of handing over the dashboard token
- Idle and paused projects drop from ~98% CPU toward under 50% via 60s outbox polling
- Terminal sessions are shared across browsers, with Reopen and close-here vs end-session
- Starting Fusion no longer stalls on onboarding prompts on a working Postgres install
- New Prometheus /metrics endpoint on the dashboard port for runtime and project metrics

### Security

- Remote login links no longer redirect with the dashboard's non-expiring token in the URL. Opening `/remote-login` now sets an opaque, expiring, revocable HttpOnly session cookie, so revoking a remote token actually logs the recipient out. Persistent links get a 30-day in-memory session; short-lived links can never outlive the token that authorised them.
- Starting a remote tunnel with no engine running now reports `stopped` with a clear reason instead of claiming it is starting.

### New

- `pnpm dev --tunnel` publishes a dev server through a Cloudflare quick tunnel and prints the public URL. Accepts `--tunnel=PORT` plus `FUSION_DEV_TUNNEL`/`FUSION_DEV_TUNNEL_PORT`; tunnel failure is non-fatal and watch-mode restarts keep the same shared link alive.
- Terminal sessions are now shared across browsers. A browser with no stored tabs adopts the server's running sessions instead of spawning its own PTY, closing a tab asks whether to close here or end the session, and a footer Reopen control reattaches to detached sessions.
- A `GET /metrics` endpoint on the dashboard exposes runtime metrics (CPU time, heap/RSS, request count and latency, child-process and git spawns) and domain metrics (active/idle projects, board tasks, running agents, Postgres queries per second) in Prometheus text format. The body is unauthenticated on the existing dashboard port — bind to a trusted network if that matters.

### Performance

- Idle task-lifecycle outbox consumers back off from a fixed 5s poll toward a 60s cadence with jitter, so paused and idle projects stop the poll storm that pinned CPU near 98%. A new event mid-backoff snaps the cadence back to 5s, and delivery ordering and at-least-once guarantees are unchanged.

### Fixed

- Starting Fusion on a working install no longer auto-launches onboarding and no longer stops dead on "Run ai provider setup now?" — the initialized-install check now recognises an embedded Postgres data directory, and auto-launched onboarding runs non-interactively. Explicit `fn onboard` keeps every step.
- Onboarding always creates the central database instead of asking, since declining produced an install Fusion cannot run on and blocked non-interactive startups.
- Remote tunnels target the dashboard's actual bound port instead of hardcoding 4040, so a `--port` override or an ephemeral rebind no longer publishes a tunnel to whatever else owns 4040.
- `pnpm dev --tunnel` now tunnels the dev server's real port, prints its real bearer token and a ready-to-open `?token=` link, and waits for the server to come up rather than publishing a URL to another instance.
- The tunnel URL is now readable in the dashboard TUI as its own Tunnel row — including operator-started remote tunnels — instead of being painted over by the TUI, and the row is measured so a long trycloudflare hostname cannot squeeze itself out of the panel.
- Pressing Enter on the TUI System panel no longer kills the TUI when no URL opener is installed.
- Stopping `pnpm dev` with a signal now tears down the dev server and its tunnel instead of orphaning a live public URL.
- A persistent remote link no longer expires after 15 minutes.
- Reconnecting to a terminal no longer duplicates its history, and two browsers sharing a session now size the PTY to the smallest attached viewer instead of last-writer-wins. Attaching a new viewer also no longer eats queued output from everyone already watching.

### Internal

- The agent session terminal clears before replaying scrollback, matching its protocol; unused central-DB path plumbing was dropped from the backup manager.
- Repaired four red workspace-merge tests caused by a stale module mock.

## 0.77.0-beta.2

### Highlights

- Docker images now clone over HTTPS, build without OOM, and ship gh, ripgrep, and cloudflared
- A provider's first-ever login no longer fails silently with "Login did not complete"
- Fusion sets its own git identity, so auto-merge no longer stalls on hosts with no git config
- Paused projects stop the periodic git churn behind 61-70% engine CPU
- ACP agents such as Hermes ACP and Prime can now call Fusion's fn_* custom tools

### New

- ACP runtimes can expose Fusion custom tools (fn_*) to external agents such as Hermes ACP and Prime, over a per-session authenticated bridge.
- The Docker image ships the GitHub CLI, tailscale, and cloudflared alongside git and ripgrep, so gh-cli auth and dashboard remote access work in a container. Running tailscaled still needs `--cap-add NET_ADMIN --device /dev/net/tun`.
- Grok 4.6 is available in the built-in Grok catalog across every model picker.
- Mailbox messages and chat conversations now have archive and restore views.
- Managers can review and coach evaluation results for agents in their reporting tree.

### Fixed

- A provider's first login on a fresh install (new container, new machine, wiped ~/.fusion) completed OAuth but wrote nothing and reported a generic failure. Login failures now surface the server's own reason, so an OAuth state mismatch reads as a stale-tab instruction.
- OpenAI Codex login never opened a browser: its first prompt asks Browser vs Device code, and that choice was answered with the paste-code wait until the 30s timeout.
- Provider sign-in now uses a persistent dialog that keeps the paste field, status, and Submit button visible, in both first-run onboarding and Settings. A second account keeps its own inline field.
- Onboarding offers a default model as soon as a provider connects, instead of staying on "No models available yet", and marks itself complete even if the settings write fails.
- Browser first-run no longer shows the "Connect remote Fusion server" card, which only applies to the native shell.
- HTTPS git clones in Docker failed with "server certificate verification failed" because the image carried no CA certificates, making project setup impossible in a container.
- The Docker image build no longer runs out of memory on a stock 8GB Docker Desktop VM, and a fresh named volume now starts up with correct permissions for embedded Postgres. Bind mounts still need a host-side `chown -R 1000:1000`.
- Merge commits, merger amends, and experiment git operations now carry an explicit identity: your commitAuthor settings, else the acting agent, else Fusion. Set `commitAuthorEnabled: false` to keep ambient git config.
- Typing in the Quick Add model dropdown filter box narrows the model list again, and the collapse/expand toggle in model dropdowns works.
- The Quick Add model menu labels the merger row "Merger" with spacing matching the other roles.
- New Task inherits the workflow selected in Board or List.
- Task detail shows the Recommendations tab only when that completed task actually has recommendations.
- Floating windows have even space on the right and bottom edges, with resize handles on the east, north-east, and south-east edges of every desktop floating window.
- Gridlock alerts no longer repeat when detection briefly clears.
- Mission reconciliation no longer fails every cycle with an internal scheduler error, and one bad slice no longer takes down the pass.
- Approval audit timelines stay in lifecycle order when events share a timestamp.
- Recovery rebounds and in-review branch rebinds keep the task's checkout instead of losing it to the idle sweep.

### Breaking

- Stuck-task tagging is gone from the dashboard: no Stuck badges, no stuck card styling, no footer stuck count. The timeout setting remains and engine recovery sweeps still use it.

### Performance

- Self-healing no longer runs its periodic git sweeps on paused projects, and git-heavy repair steps drop to at most hourly on active ones, with done-task merge recovery capped at 25 candidates per cycle. Database and filesystem housekeeping keeps its normal cadence.
- The scheduler reads each task's workflow selection once per poll tick instead of about six times, cutting CPU and health-API latency.

### Internal

- Bundled Pi runtime upgraded from 0.82.1 to 0.84.1 for updated provider and model support.
- Removed stale taskStuck exports, aliases, and TypeScript path mappings left behind by the dashboard helper deletion.

## 0.77.0-beta.1

### Highlights

- CLI-runtime models like Cursor CLI now work in every AI lane, not just chat
- Mission and milestone interviews no longer fail with "not found in the pi model registry"
- Planning Mode stays on the current session and keeps your typed answers through a refresh
- Create Room member picker shows accurate loading, empty, and failed states
- Plan New Mission sits at the top of the mission list and is easier to hit

### Fixed

- Every AI lane now routes through runtime resolution, so a CLI-runtime model selection (for example Cursor CLI) works anywhere chat does. Mission planning and milestone/slice interviews previously errored out with a model-registry lookup failure.
- Planning Mode stays on the current session after a stale response refresh, instead of jumping away when a duplicate response, accepted stream error, or loading poll arrives late.
- Planning Mode preserves answers you have already typed while a session hydrates late, binding the visible question to the live planning turn.
- The Create Room member picker no longer shows stale or misleading member state while agent data loads; loading, empty, and failed states are now distinct.
- Plan New Mission moved from the footer to the top of the mission list and is slightly taller; the duplicate empty-state button is gone.

## 0.77.0-beta.0

### Highlights

- Anthropic Subscription login works again instead of failing with "Unknown provider"
- Multi-repo workspace tasks land per repo, show per-repo status, and can't double-land
- Cursor CLI models run supervised with Fusion task tools bridged in
- Diff-volume merge gate removed, so approved squashes aren't blocked on per-file shrinkage
- Creating a task from an Insights recommendation is fast on large boards

### Breaking

- The pre-commit diff-volume merge gate is gone, along with the diff-volume threshold, minimum-lines, and allowlist settings and its audit event. File scope is still the pre-land guard, and the post-squash audit policy remains the shrinkage backstop.

### New

- Cursor CLI models selected in the picker now run through Fusion's supervised runtime, with Fusion task tools bridged into Cursor sessions through leased, quarantine-aware config.
- Cursor CLI can act as a retryable fallback when another AI runtime fails mid-session.
- Task detail shows per-repository landing status and failure detail for workspace tasks.
- Task creation accepts per-task GitHub tracking overrides: `github_tracking`/`github_repo` on task create, and `--github`/`--no-github`/`--github-repo` on the CLI. CLI create now honors the project/global default and opens the tracking issue before the process exits.
- Memory adds Knowledge Graph navigation and bounded path search, capped at 10 hops and 20,000 expansions.
- Enabled skills are now available to every agent, and per-agent skills are forced reading, selected from a searchable checkbox list with clearer agent skill badges.
- Mailbox recommendation notices can create a follow-up task directly.
- New global Quick Add preference for Enter-to-save.
- Memory Keeper is provisioned into projects with its heartbeat off by default.
- Computer use requires a fresh snapshot after each action so stale element indexes can't be reused.

### Fixed

- Anthropic Subscription login no longer fails with "Unknown provider: anthropic-subscription", and Claude subscription model resolution resolves the same way; the login error now stays inside the Settings card on phone widths.
- Cursor CLI models no longer fail with "install and enable the Cursor runtime plugin" after the provider is enabled, and CLI picker models route to their installed runtime with actionable failures.
- Workspace tasks complete when changes land in only one repository, and show their sub-repo worktrees on the board instead of Unassigned.
- Workspace repos acquired concurrently no longer lose sub-repo worktree entries, and tasks no longer flash as single-repo mid-acquisition.
- Workspace merges no longer report success when finalization is blocked, and unsafe AI squashes are blocked before reaching integration branches.
- Transient Git evidence failures no longer fail workspace tasks, stale task trailers no longer falsely prove a repo landed, and work re-lands after a clean revert.
- Multi-node workspace operations no longer overlap or double-land shared repositories.
- Workspace tasks are blocked from completing after edits to a sub-repo main checkout, and workspace projects using per-instance foreach worktrees now fail fast with an explicit diagnostic.
- Stale workspace worktrees and safe task branches are reclaimed after terminal tasks; unarchived workspace tasks no longer retain disposed worktree state; live task worktrees are protected from CLI and agent archive cleanup.
- Post-merge pushes retry twice with bounded backoff after temporary Git network failures; config, auth, and ref-rejection errors still fail immediately.
- Merge verification runs tests for packages that depend on a changed package, and Quality file-scoped tests use each package's local Vitest binary.
- Restored agent-activity telemetry, Plan Review convergence and review scoping, restart-retry safety guards, and session usage telemetry that an executor refactor had silently dropped; workflow-principal identity is threaded through prompt and review sessions again.
- Fusion-created GitHub tracking issues close when the task is already done.
- Planning Retry shows a clear retryable message when a gateway returns 502/503/504 instead of dumping content-type diagnostics.
- Event streams for an unknown project return 404 instead of logging a 500, and mission triage with an unknown workflow returns 404.
- Title-only duplicate redirects no longer show as Ready, and newly created workflows are visible to their own project.
- Model pickers stay open while filtering, including on mobile; GitHub pull-request imports wrap readably on phones.
- Insights list newest first.
- Settings shows database backup inventory and automatic schedule status; recommendation settings are searchable; collapsed Command Center spacing and mailbox badge padding are fixed.
- Voice input no longer reports a healthy speech runtime as incompatible.
- Dashboard updates report clear outcomes when they can't install, distinguishing failed checks from no-ops.
- Task runtime chips no longer over-count active time after review or replan round-trips.
- Non-continuable agent sessions recover in step-session runs instead of failing the task, and mission validation resumes when a completed mission task's reconciliation fails.
- Computer-use snapshots stay available across project directories.
- Agent Activity no longer lists agent state-change events.
- Corrupted knowledge-graph caches rebuild without retaining foreign artifact data.

### Performance

- Creating a task from an Insights recommendation no longer slows down on large boards, using indexed proposal and lineage reads.

### Internal

- Staged runtime plugin core helpers are validated against the CLI runtime shim so they package reliably in CLI bundles.
- Operator-installed Hermes Windows CLI shims launch reliably under supervised spawn.

## 0.76.0

### Highlights

- Workflow stages now run on durable role agents; the ephemeral-agent setting is removed
- Fixed the deadlocks that left tasks stuck in progress with no session and no error
- Fixed a boot hang where spec-drift reconciliation exhausted the database connection pool
- Reviews block only on high-priority findings, cutting repeated plan and code review fix rounds
- Durable project memory: recall records, Memory Keeper consolidation, and MCP memory tools

### Breaking

- The retired ephemeral-agent compatibility setting and its Settings control are removed; stale values are discarded on read and update.
- Deprecated v0 mission resume blockers are removed in favor of canonical blocker descriptors.

### New

- Workflow stages route through durable multi-role agents instead of ephemeral workers; existing singular role input stays migration-compatible.
- Reviews gate on finding severity: new per-workflow Plan Review (default high) and Code Review (default critical) blocking thresholds. Set either to `any` to restore the old behavior where every REVISE blocks. Non-blocking findings land in PROMPT.md as Review Advisory Notes.
- Durable project recall for decisions, preferences, and solutions, plus a Memory Keeper agent for knowledge-graph and recall consolidation, provenance-tagged memory semantics, automatic recall capture, and Fusion memory tools through the built-in MCP server. Every agent lane is steered to search memory first, and Agent Detail shows consolidation history.
- Live agent activity: durable org-wide history with a live stream, a live activity and handoff flow in the Agents view, and a Command Center activity timeline with scroll-back.
- Plan Review can now close stale or duplicate work before implementation starts.
- Approved plans are preserved with immutable spec-lock, current-plan evidence, and deterministic execution drift reports.
- Require named GitHub checks before Fusion merges pull requests, plus opt-in GitHub-native pull request auto-merge and signed GitHub CI signal ingestion that updates merge checks without waiting for polling.
- Completed tasks now produce recommendations with guarded one-click task creation, a project-wide Insights surface, and optional mailbox notices.
- macOS: `fn computer` adds desktop-app discovery, snapshots, actions, and permission reporting, with a version-matched computer-use agent skill that runtime sessions discover automatically.
- Mission management: reconcile feature state from delivery task ground truth, a "Reconcile now" control with dry-run preview, agent tools to set mission and feature status with attributed audit events, clear and re-run controls for repairable validation badges, and an operator-only tool to clear a stale mission blocked badge.
- Mailbox gains structural reports, inline approvals, chat-to-report handoff, roadmap-item attachments that open in Roadmaps, archive and restore for messages and conversations, and approvals raised during planning.
- Planning a GitHub issue creates a task linked to that issue, and can import issue and comment screenshots.
- New operator tool `fn_workflow_step_resume` unsticks permanently-pending merge review steps.
- `fn knowledge-graph build` generates a committable code knowledge graph.
- Managers can review and coach evaluation results for agents in their reporting tree.
- Grok 4.6 is available in every model picker, and the bundled Pi runtime moves to 0.84.1.
- Português (Brasil) joins the dashboard and terminal UI languages.

### Fixed

- Tasks no longer stall indefinitely in progress with no session after the workflow role-agent rollout: built-in role agents are routable again, continuation writes are atomic, and principal holds back off from 15s to 5m instead of re-dispatching about 3.5 times a second.
- Queued tasks now start once the board frees up; capacity-parked continuations were owned by no drain and sat runnable forever.
- Planned tasks no longer sit roughly 10 minutes in Todo before Plan Review starts.
- Planning failures retry with 60s/120s/300s backoff and park after 3 attempts instead of looping every poll; provider request timeouts now route into that same bounded policy, and a new planning timeout caps a hung planning turn.
- The Plan Review replan cap setting is now actually read; lowering it takes effect, and `0` parks on the first REVISE.
- Fixed "Failed to create chat session" on model chats, and tasks wrongly failed as branch conflicts when their branch was already merged.
- Fixed CLI commands aborting mid-command on Node 22.4+ so `fn init` completes.
- Fixed Grok ACP startup by making `--no-auto-update` opt-in for Grok CLI v1.0.0.
- Tunnels restart automatically with backoff after crashing instead of staying failed until manually restarted.
- The Todo Lists and Roadmaps plugins now appear in navigation after being enabled.
- Operator-owned external checkouts stay authoritative across recovery, remediation, verification, and cleanup, and Fusion no longer modifies or deletes them; routing without a checkout path fails closed.
- A stale worktree base no longer fails a task: declined refreshes are recorded and execution continues, reacquired worktrees refresh against the current integration branch, and fresh worktrees rebase onto the configured integration branch.
- Retained but inactive worktrees no longer exhaust live task capacity, and workflow principal session caps are removed with a sweep that re-queues continuations stranded in running or held.
- Pull requests: no auto-merge for branch-protected, behind, conflicting, or unknown states; branch-protection blocks are reported as policy blocks rather than false conflicts; retries honor persisted backoff and pause for operator action; PR heads are refreshed before create and merge.
- Alerts are quieter and more honest: no "needs operator action" for tasks running normally or intentionally held, terminal-failure alerts wait for automatic recovery to fail first, and generic terminal failures retry on a durable budget before escalating.
- Reviewer verdicts and findings survive review prose containing stray braces, and resolved findings stay visible without allowing no-op revision requests.
- Board and task detail: stale Planning badges clear, the In progress badge is restored, Promote is hidden while a task is planning or held on plan review and approval, and Promote appears on every card the server would actually release. Task cards distinguish the assigned agent from the creating agent, PR and review updates stay visible, and an empty Activity Feed refetches on open.
- Planning Mode keeps running when browser storage is unavailable, shows four distinct responses plus a write-your-own choice, and offers a context-appropriate 3-5 option set.
- Quick Add: the model dropdown filter box narrows the list as you type, the collapse/expand toggle works, the merger row is labeled "Merger", and action buttons center on desktop with edge-to-edge spacing at tablet widths.
- Every open dashboard stays in sync when a task is paused or unpaused, and the model list no longer hangs when a provider catalog stalls.
- Missions: reconciliation no longer fails every cycle, paused missions stay paused through status roll-up, duplicate manual validation runs are prevented, automatic validation waits for in-flight manual runs, and merge behavior plus read-only shared branch status are clearer.
- Shared PostgreSQL isolation: durable agent data, agent ratings, custom workflows, chat data, approval audit history, verification-cache results, and project records are scoped to the active project.
- Recommendations capture and display are restored, including an empty result state and a tab shown only when the completed task has records.
- Execution retries after the first terminal tool-call failure by default, partially completed tasks resume after restart without a false failure, and canceled AI merge bodies can no longer overwrite successor merge state.
- Settings history now records every change with truthful provenance, engine heartbeat churn no longer floods it, and revision APIs support paging.
- The Agents Overview active-agent list scrolls on mobile, Messages structure selection fits narrow composers, and terminal pin and pop-out toggles moved to the top toolbar.
- Restored missing localized merge, notification, recommendation, settings, and required-check copy across locales.

### Performance

- Scheduler hold-release sweeps and health probes stay responsive under PostgreSQL load via batched workflow-selection reads, a pass-scoped cache, per-project sweep guard, and sweep and probe deadlines.
- The engine log no longer repeats dispatch-blocked and symbol-lock-loss lines every poll for a stuck task.

### Internal

- Eight project-owned storage tables now model their partition identities.
- Plugin hot reload no longer leaves scratch files in plugin folders.
- The published CLI manifest declares TypeScript once as a runtime dependency.

## 0.76.0-beta.3

### Highlights

- Planned tasks no longer stall ~10 minutes in Todo before Plan Review starts
- Insights adds project-wide task recommendations with paginated triage
- Mailbox notices arrive for captured task recommendations, via a new project setting
- Merge, notification, recommendation, and settings copy is localized again in six locales
- Terminal pin and pop-out toggles moved to the top toolbar, left of the close button

### New

- Insights now has a project-wide task recommendations surface, backed by a bounded row-paginated API.
- Captured task recommendations can send mailbox notices, controlled by the new `recommendationMailboxNoticeEnabled` project setting.

### Fixed

- Planned tasks that sat roughly ten minutes in Todo now move into Plan Review promptly: the planning-to-plan-review handoff retires its predecessor and installs the successor in a single transaction, and the follow-up reaction retries instead of dropping failures silently.
- Localized merge, notification, recommendation, and settings copy is restored across six locales, and a stale pt-BR settings key was removed.
- Terminal pin and pop-out toggles now sit in the top toolbar to the left of the close button.
- The Quick Add composer's bottom row of action buttons is centered again, with the ≤768px layout unchanged.
- Quick Add buttons use mobile edge-to-edge spacing on tablet widths (769px–1024px).

## 0.76.0-beta.2

### Highlights

- Verification cache, approval audit, and GitHub check state now stay scoped per project
- Grok 4.6 available in every model picker, on bundled Pi runtime 0.84.1
- Quick Add model dropdown: typing filters, collapse toggle works, merger row labeled Merger
- Mission reconciliation no longer fails every cycle with a scheduler error
- Archive and restore mailbox messages and chat conversations from the dashboard

### New

- Grok 4.6 is registered in the built-in Grok catalog and appears in every model picker.
- Mailbox messages and chat conversations can be archived and restored from dedicated views.
- Managers can review and coach evaluation results for agents in their reporting tree.

### Fixed

- Verification-cache results and project records are isolated per project instead of shared across them.
- Approval audit history is scoped to the active project.
- PostgreSQL GitHub check-state ownership defaults are reconciled during upgrades.
- Typing in the Quick Add model dropdown filter box narrows the model list again.
- The collapse/expand toggle in model selection dropdowns no longer closes the dropdown.
- The Quick Add model menu labels the merger row "Merger" with spacing matching the other roles.
- The task Recommendations tab appears only when a completed task actually has recommendations.
- Mission reconciliation no longer fails every cycle with an internal scheduler error.

### Internal

- The bundled Pi runtime moves from 0.82.1 to 0.84.1 for updated provider and model support.
- Eight project-owned storage tables are modeled with their partition identities.

## 0.76.0-beta.1

### Highlights

- Breaking: the retired ephemeralAgentsEnabled setting and v0 mission resume blockers are gone
- Fixes the deadlock that left every task stuck: built-in workflow agents were unroutable
- Fusion no longer hangs on startup when a project has 1,000+ tasks
- Reviews block only on high-priority findings, cutting repeat plan and code review rounds
- Durable project memory: recall, Memory Keeper consolidation, and MCP memory tools

### Breaking

- Removed the retired ephemeral-agent compatibility setting and its control; stale values are discarded on settings read and update.
- Removed the deprecated v0 mission resume blockers in favor of canonical blocker descriptors, which now deduplicate per root feature, source, and reason.

### New

- Durable project recall for decisions, preferences, and solutions, plus the Memory Keeper agent that consolidates the knowledge graph on a schedule and shows its consolidation history in Agent Detail.
- Fusion memory tools exposed through the built-in MCP server, with provenance-tagged memory semantics and automatic recall capture from task, research, and insight sources.
- Every agent lane is steered to search memory before starting work.
- Live agent activity: a durable org-wide history and stream, a live activity and handoff view in Agents, and a Command Center timeline you can scroll back through.
- Reviews now block only on high-priority findings. New per-workflow settings control the blocking threshold (plan review defaults to high, code review to critical); set either to "any" to restore blocking on every REVISE. Non-blocking findings land in the spec as review advisory notes.
- Plan Review can close stale or duplicate work before implementation starts, and approved plans are locked with deterministic execution drift reporting.
- Opt-in GitHub-native pull request auto-merge, required named GitHub checks before Fusion merges, and signed GitHub CI signal ingestion so verified check results update merge gates without waiting for polling.
- Route task execution and review through one validated external Git checkout that Fusion never modifies or deletes.
- macOS computer use: `fn computer` for desktop app discovery, snapshots, actions, and permission reporting, a version-matched computer-use agent skill, and automatic skill discovery in macOS runtime sessions.
- Mission management gains a "Reconcile now" control with dry-run preview, automatic reconciliation from delivery task ground truth, agent tools to set mission and feature status with attributed audit events, and operator controls to clear stale blocked badges and re-run repairable validations.
- Planning a GitHub issue creates a task linked to that issue as a tracked source, and Planning Mode can import issue and comment screenshots.
- Agent mail gains structural reports, inline approvals, chat-to-report handoff, roadmap items you can drag in and open in Roadmaps, and approvals raised during planning.
- `fn knowledge-graph build` generates a committable code knowledge graph.
- Português (Brasil) is available as a dashboard, terminal UI, and translation target language.

### Fixed

- Tasks no longer spin against unroutable built-in workflow agents; a principal hold now backs off from 15s to 5m instead of re-dispatching about 3.5 times a second and writing roughly 19k audit rows an hour with nothing executing.
- Queued tasks start again after the board fills up: continuations parked by capacity are picked up by the drain instead of sitting runnable with no state change.
- Four other long stalls fixed, covering principal routing, dependency auto-unblock clearing a needs-replan signal, stranded planning holds, and unbounded workflow run ids.
- Stranded workflow continuations left running or held are re-queued automatically, and workflow principal session caps are removed.
- Startup no longer wedges on "starting": spec-drift reconciliation is bounded to 4 concurrent reconciles with backoff, so a 1,082-task project opens 3-10 database connections during boot instead of saturating the cluster.
- Planning failures retry with 60s/120s/300s backoff and park after 3 attempts instead of looping forever, and a new planning turn timeout (default 90 minutes) bounds hung sessions.
- Provider request timeouts are treated as transient and retried with backoff instead of re-admitting the card every poll.
- The Plan Review replan cap setting is now actually read; lowering it takes effect, with a default of 15 and 0 parking on the first REVISE.
- A stale worktree base no longer fails a task: a declined refresh holds the task instead of blocking execution, and reacquired worktrees are refreshed against the current integration branch.
- Reacquired and fresh worktrees rebase onto the configured integration branch, task-pinned worktrees recover when an incomplete directory occupies their path, and worktree conflict cleanup no longer crashes before its active-session safety check.
- Tasks are no longer failed as branch conflicts when their branch was already merged, and "Failed to create chat session" on model chats is fixed.
- Auto-merge no longer attempts branch-protected, behind, conflicting, or unknown pull requests; branch-protection blocks are reported honestly and pause for operator action instead of surfacing as merge conflicts.
- Automated pull request heads are refreshed before creation and merge, timed-out merges recover without stale status blocking retries, and canceled AI merge bodies cannot overwrite successor merge state.
- "Needs operator action" alerts no longer fire for tasks that are running normally or intentionally held; terminal failures retry automatically first and alerts wait out a settle window.
- Promote appears only on cards the server would actually release: hidden while a task is still being planned or blocked on plan review and approval holds.
- Completed tasks always show a Recommendations tab, including an empty state, and executors are prompted to produce those recommendations again after a refactor dropped the request.
- Activity Log records every settings change rather than four keys, with redaction, honest provenance for API and system writes, engine heartbeat noise excluded, and paging on the revision API.
- Durable agent data, agent ratings, custom workflows, and project-bound workflow and chat data stay isolated per project on shared PostgreSQL.
- Grok ACP starts again with released Grok CLI v1.0.0 by making --no-auto-update opt-in.
- CLI commands no longer abort mid-command on Node 22.4+, so `fn init` completes; Node >=22.4.0 is now declared.
- Tunnels restart automatically with backoff after a crash instead of staying failed until manually restarted.
- Reviewer verdicts and findings survive review prose containing stray braces, and resolved findings stay visible without allowing no-op revision requests.
- The engine log stops repeating dispatch-blocked and symbol-lock-loss lines every poll for a stuck task.
- The model list no longer hangs when a provider catalog stalls.
- Chat attachment thumbnails clear as soon as the message is accepted.
- Task cards distinguish the assigned agent from the agent that created the task.
- The Agents Overview active agents list scrolls on mobile instead of clipping.
- Newly created tasks get an eligible executor owner automatically, and explicit engineer and operator-override assignment works again in CLI tools.
- Mission fixes: planned follow-ups resume after their source task completes, paused missions stay paused through status roll-up, duplicate manual validation runs are prevented, and automatic validation waits for an in-flight manual run.
- Pull request and review updates stay visible in open task details.
- Plan writes no longer fail permanently after a plan-evidence version collision, and approved plans stay accurate when parent lineage is removed.
- Duplicate redirects are recognized in task titles and with custom task prefixes, and duplicate conflict responses are restored for ordinary intake.
- Plan-review replan and review fix handoffs work again in projects with auto-merge off, including shared-branch tasks.
- Direct DATABASE_URL connections can finalize planning lifecycle locks.
- Required pull-request check settings labels are available in every dashboard locale.

### Performance

- Scheduler hold-release sweeps and health probes stay responsive under PostgreSQL load through batched workflow-selection reads, a per-project sweep guard, and sweep and probe deadlines.

### Internal

- Plugin hot reload no longer leaves scratch files behind in plugin folders.
- The published CLI manifest declares TypeScript once, as a runtime dependency.

## 0.76.0-beta.0

### Highlights

- Workflow stages now run on durable multi-role agents instead of ephemeral workers
- Dashboard no longer freezes on a startup connection-pool deadlock
- Tasks no longer stall in progress with no session after the role-agent rollout
- Completed tasks can suggest follow-ups with guarded one-click creation
- New fn_workflow_step_resume unsticks merge review steps stuck pending forever

### New

- Workflow stages are routed through durable multi-role agents rather than ephemeral workflow workers. Existing single-role configuration keeps working.
- Completed tasks now produce recommendations you can turn into new tasks in one click. The project setting `maxRecommendationsPerTask` caps how many you can accept.
- `fn_workflow_step_resume` is a new operator-only CLI and pi-extension tool that moves a permanently-pending pre-merge review step to failed, so `fn_task_bypass_review` can clear the merge blocker. Every resume is audit-logged.

### Fixed

- The dashboard could stop answering every request at startup because built-in role-agent provisioning held a lock while waiting on a second connection from a three-connection pool. It now runs on the locking transaction.
- Tasks could sit in progress forever with no session after the role-agent rollout, caused by two silent deadlocks in role routing and durable continuation writes. Suspended runs are now recorded in the run audit instead of vanishing.
- Extension-host task stores are warmed for every registered project at dashboard startup, so `fn_task_*` tools no longer risk a timeout booting a second connection pool.
- Pausing or unpausing a task now propagates to every open dashboard.
- Stale Planning badges clear once refreshed task state shows execution has moved on, without erasing newer planner activity.
- The In progress badge is back on active tasks that have no transient status, across board and list views.
- An empty task Activity Feed now refetches when you open it after execution has already started.
- Partially completed tasks resume after a restart instead of reporting a false failure.
- Verified no-op tasks no longer bounce repeatedly between lifecycle states.
- Execution retries once after the first terminal tool-call failure by default; the project threshold stays configurable and existing overrides are preserved.
- Planning Mode keeps working when browser storage is unavailable, evicting only its own key and retrying once.
- Planning Mode shows four distinct responses plus a write-your-own choice, and prompts now guide 3-5 alternatives without truncating larger valid option sets.
- Messages structure selection stays inside narrow mobile composers in both full-page and modal Messages.
- Inactive retained worktrees no longer eat live task capacity; worktree admission is shared across execution, planning, merge, and workflow continuation lanes.
- Shared branch-group members honor project auto-merge consent, and review advisories appear before promotion.
- Mission autopilot slice progression stays serial and milestone ordered even with duplicate completion or recovery signals.
- Mission detail explains merge behavior and shows read-only shared branch status, validating branch-group ownership before displaying branch, member, and PR data.
- Secrets environment fingerprint records stay out of task worktrees.
- The legacy agent setting no longer influences mission or workflow routing.
- Built-in workflow agents get detailed identities backfilled non-destructively, with duplicate provenance reconciled.
- Settings now states the enabled default for the ephemeral-agent compatibility setting.
- The Todo Lists and Roadmaps plugins appear in dashboard navigation once enabled.

## 0.75.1

### Highlights

- Secrets now bind to the selected project, work in chat approvals, and land in new worktrees
- Approving a task plan resumes Plan Review automatically
- Pick individual structured review findings to send back for same-task revision
- No failure alerts while Fusion is still auto-recovering the task
- Dashboard cards refresh reliably after unpause, tab resume, and SSE reconnect

### New

- Select individual structured workflow review findings and send just those back for a same-task revision, with location and severity preserved.
- Custom workflow review nodes are now classified as plan or code review, so their results accept feedback directly from the Review tab.

### Fixed

- Dashboard secret management is bound to the selected project; requests without an explicit project are rejected rather than resolved from fallback context.
- Chat-agent secret approvals work again, and failed decisions now show an actionable reason.
- Secrets env files are restored in fresh task worktrees.
- Approving a task plan hands off to the engine so Plan Review resumes on its own instead of stalling.
- Workflow review feedback selection works again for same-task revisions.
- Task failure alerts stay quiet while Fusion still owns and is retrying the recovery.
- Task detail refreshes immediately after unpausing instead of showing stale state.
- Dashboard cards revalidate on focus, tab visibility, browser back/forward resume, and SSE reconnect.
- Long task-detail titles stay stable when expanded or collapsed, and no longer flicker during window resize.
- Stale file-overlap blockers are hidden when a task is simply queued behind an unfinished dependency.
- An operator's review hold is honored before a mission task joins its shared branch.
- Stopping a task now cancels its pending workspace merge contention retries.
- Chat checkpoints no longer fail on tool output containing NUL bytes.

## 0.75.1-beta.2

### Highlights

- Dashboard secrets now bind to the selected project instead of a fallback context
- Chat-agent secret approvals work again and failed decisions show an actionable reason
- Fresh task worktrees get their secrets-env files restored
- Task detail unpause refreshes state immediately, and cards revalidate after tab or browser resume
- An operator's review hold is honored before a mission task joins its shared branch

### Security

- Dashboard secret management is bound to the selected project: secrets routes reject requests that arrive without an explicit project before any fallback context resolution.

### Fixed

- Chat-agent secret approvals no longer fail silently; prompt-gated secret reads keep the registered engine session principal, and a failed decision now surfaces an actionable reason.
- Fresh task worktrees again receive their secrets-env files, because the runtime shares the project secrets store with executor and heartbeat worktree acquisition.
- Unpausing from task detail refreshes dashboard state right away through the shared lifecycle reconciliation path.
- Dashboard cards revalidate reliably after browser and tab resume; focus, visibility, page-show, and SSE reconnect now share one fenced revalidation path.
- Long task-detail titles stay stable when expanded or collapsed, and no longer flicker during window resize.
- An operator's explicit review hold is respected before a mission task joins its shared branch; mission policy auto-merge values stay distinct from per-task operator overrides.
- Stopping a workspace merge now cancels its pending contention retries instead of letting a busy re-enqueue timer fire later.

## 0.75.1-beta.1

### Highlights

- Send a single structured review finding back for same-task revision
- Custom workflow review nodes now classify as plan or code in the Review tab
- Task failure alerts stay quiet while Fusion is already recovering the task
- Stale file-overlap blockers no longer show on tasks queued behind a dependency

### New

- Pick individual findings out of a structured workflow review and send just those back for revision on the same task, instead of rejecting the whole result.
- Custom workflow review nodes are classified as plan or code reviews, so their results accept direct feedback from the Review tab.

### Fixed

- Failure alerts are suppressed while Fusion still owns and is attempting automatic recovery of a task; you only get alerted once recovery is exhausted.
- A task queued on an unfinished dependency no longer displays file-overlap blockers left over from a lease that is no longer active.

## 0.75.1-beta.0

### Highlights

- Approving a task plan in the dashboard now resumes Plan Review automatically
- Workflow review feedback applies to the right revision again on same-task reviews
- Chat checkpoints no longer fail when tool output contains NUL bytes

### Fixed

- Approving a plan in the dashboard hands off to the engine so graph-owned Plan Review work is seeded and continues without a manual nudge.
- Review feedback selection is restored for same-task revisions: workflow review items are resolved canonically, so client-supplied feedback can no longer reach snapshots or steering unchecked.
- Chat checkpoints survive tool output containing NUL characters instead of failing to persist; checkpoint failures are now observed as best-effort rather than breaking the chat.

## 0.75.0

### Highlights

- Planning Mode approvals no longer stall — approved and rejected plans release their tasks
- Planning Mode tasks keep every interview decision and get scheduled into their workflow lane
- Todo Lists ships as an optional per-project plugin instead of a hardcoded dashboard view
- Voice Input can be enabled on supported installs, with dictation scoped to the selected project
- pnpm dev:watch rebuilds and restarts the engine after draining active agents

### New

- Todo Lists is now an optional per-project first-party plugin, with its backend route and dashboard view owned by the plugin rather than the host.
- Editable file editors gain undo and redo controls.
- List task details adapt to the available content width, routing to a split detail view when there is room; an explicit popup preference still wins.
- Mobile Planning Mode gains a shortcut to review the evolving plan after five answers, without submitting the current response.
- `pnpm dev:watch` watches development sources and restarts the engine safely: it closes new admission, drains active agents, rebuilds, and respawns.

### Fixed

- Manually approved or rejected plans now release their tasks so work can continue.
- Approved plans resume immediately once Plan Review exhausts its revision budget, recorded as an audited human bypass.
- Planning Mode tasks retain the complete set of interview decisions across single, CLI, and multi-task creation.
- Planning Mode tasks are scheduled promptly in their selected workflow lanes.
- Planning Mode can create another task from the same plan without requiring an edit first.
- Planning finalization no longer crashes after PROMPT.md writes.
- Plans reseeded by dependency changes stay recoverable instead of being silently stranded.
- Stale plan approvals are prevented, with stronger planning and review completeness checks and serialized approvals.
- Planning and review prompts converge faster: planning gathers repository evidence before drafting, Plan Review batches independent blockers, and code review traces changed invariants through consumers and tests.
- Executor credential resolution now self-heals so custom providers and renamed providers match what chat uses.
- Supported installations can enable Voice Input once its model is ready, with stable readiness reporting.
- Voice dictation create, transcription, and cleanup stay scoped to the selected project.
- Duplicate detection ignores completed and archived tasks while still protecting active work.
- Task Detail Activity thinking blocks expand by default and keep per-block collapse state while reasoning streams in.
- The floating Task Detail popup close control lines up with its header edge.
- Dependency and file-scope queue entries no longer repeat for unchanged blockers.
- Default-branch mission group merges go through the normal manual release gate via a dedicated mission integration branch.
- Plugin SDK declarations and Todo Lists CLI packaging are restored.
- Project escalation model and voice input settings strings are back in every supported secondary locale.

## 0.75.0-beta.2

### Highlights

- Dev source watching restarts the engine cleanly, draining active agents before rebuilding
- Queue activity no longer repeats dependency and file-scope blocker entries for unchanged blockers
- Duplicate detection ignores completed and archived tasks while protecting active work

### New

- Development source watching restarts the engine automatically on source changes: new admission is closed, active agents drain, the build is refreshed, and the supervised engine is respawned.

### Fixed

- Dependency and file-scope queue activity entries no longer repeat while the blocker is unchanged, so the task queue log stays readable.
- Duplicate detection now matches against active tasks only, skipping completed and archived ones across intake, planning, and recovery.

## 0.75.0-beta.1

### Highlights

- Approved plans resume immediately when Plan Review exhausts its revision budget
- Dependency-reseeded plans stay recoverable instead of stranding in the board
- Mission group merges to the default branch now go through the manual release gate
- Voice dictation stays scoped to the selected project
- Task Detail Activity shows thinking blocks expanded by default

### Fixed

- Plan Review that runs out of revisions no longer parks approved work: the bypass is recorded as an audited human decision, and the scheduler plus deferred workflow continuations wake up right away.
- Dependency changes keep the durable replan signal, so a reseeded plan stays recoverable rather than silently stranding.
- Mission default merge strategies now integrate through a dedicated mission integration branch, so default-branch landings still pass the normal manual release gate.
- Stale plan approvals are blocked, with bounded lifecycle locks, planning-episode evidence, serialized approvals, and convergent planning and review ledgers.
- Voice dictation session create, transcription, and cleanup all use the selected project's identity instead of leaking across projects.
- Planning finalization no longer crashes after writing the task prompt.
- Task Detail Activity thinking blocks open by default and keep per-block collapse state while streamed reasoning arrives.
- Planning gathers repository evidence before drafting, Plan Review batches independently discoverable blockers into one pass, and code review traces changed invariants through consumers and tests.

## 0.75.0-beta.0

### Highlights

- Approved or rejected plans now release their tasks instead of stalling in Planning Mode
- Planning Mode keeps every interview answer and can create repeat tasks from one plan
- Todo Lists is now an optional per-project plugin, with CLI packaging restored
- Executor sessions resolve custom-provider credentials the same way chat does
- Undo/redo in editable file editors, plus a mobile shortcut to review an evolving plan

### New

- Todo Lists ships as an optional first-party plugin you enable per project, moving the backend route and dashboard view out of the host.
- Editable file editors gain undo and redo controls, backed by the editor's own history and kept in sync with externally loaded content.
- Mobile Planning Mode adds a shortcut to review the evolving plan after five answers; it switches to the workspace tab without submitting your in-progress response.
- List task details now adapt to the available content width, routing to a split view when there's room — an explicit popup preference still wins.

### Fixed

- Plans you manually approve or reject now release their task so it can continue, and approved plan fingerprints survive field merges.
- Tasks created from a Planning Mode interview retain the complete set of decisions, with one shared handoff format across single, CLI, and multi-task creation.
- Planning Mode tasks are scheduled promptly in the workflow lane you selected; replayed proposal claims no longer re-wake triage.
- You can create another task from the same plan without first editing it, while repeat actions stay idempotent.
- Executor credential resolution self-heals: no more synthesized "default" credential instance, unresolved instances soft-fail to the legacy unscoped provider key, and renamed custom-provider slugs match when unambiguous.
- Voice Input can be enabled on supported installations once its model is ready, with stable readiness codes reported.
- The plugin SDK's type declarations and Todo Lists packaging are restored in full releases; the bundled Todo plugin gets its store from the runtime shim.
- The floating Task Detail popup's close control lines up with the header edge; only desktop resize targets moved outboard, preserving scrollbar clearance.
- Project escalation models and voice input states are translated again in every supported secondary locale.

## 0.74.0

### Highlights

- Machine-wide concurrency cap is gone — capacity is now two per-project numbers
- Spawned child agents count against Max Concurrent Tasks, not a hidden spawn budget
- Renamed and custom board columns now work across engine, CLI, self-healing and analytics
- Plan Review runs in the planning lane before a task takes an implementation slot
- Approval and permission hardening: no self-approval, bash containment, fn serve auth by default

### Breaking

- The machine-wide concurrency cap is removed. Capacity is now two numbers per project, and Scheduling · Global and Scheduling · Project merge back into a single Scheduling section. A stored global cap is ignored.
- Spawned child agents now count against Max Concurrent Tasks instead of the hidden per-parent (5) and global (20) spawn budgets, which are deleted. Children each take a git worktree and were previously counted by neither capacity gate.

### Security

- Full approval and permission hardening pass: the dashboard derives the decider server-side and blocks self-approval and forged actors, same-verdict replays and races return 409, pending requests expire after 24h and approved grants after a configurable TTL (default 1h).
- Unclassified tools now fail closed to policy-governed command execution, an unconditional bash containment floor denies daemon-token and credential-store reads and shell calls to the approvals API at every preset, and bash approvals bind to the exact command hash.
- `fn serve` mints and reuses a daemon token by default; `--no-auth` opts out.
- Extension tools resolve the acting principal through a session identity registry: destructive tools are withheld from agent principals, secret-get approvals redeem execute-once, and plugin task stores block destructive methods unless the manifest declares the permission.
- Deny now withholds task-creating tools from agent sessions, and the deterministic duplicate-create window widens from 60s to 10 minutes.

### New

- Plan Review now runs in the planning lane before a task takes an implementation slot, with a "Plan Review" badge on the card. Code Review and Browser Verification run with the card in In review, releasing the work slot during review.
- Multiple named credential accounts per AI provider: configure several, pick one per model, and the board keeps moving on a second account when a provider hits its limit instead of pausing.
- Choose whether Anthropic lanes use your API key or your Claude subscription, with an "In use" marker in Settings → Authentication.
- Opt-in auto-update and restart, and the post-update Restart button now reports why a restart was refused instead of sitting disabled.
- New "Limit concurrent worktrees" toggle — turn it off and Max Concurrent Tasks becomes the only limit.
- Opt-in voice dictation across dashboard composers, with Parakeet v3 model download and lifecycle management in Settings.
- Chat sessions now expose the full permission-mapped task toolset for gated agents, and Direct chat conversations can be organized with reusable tags and sidebar filtering.
- Pick the workflow used for CLI/agent-created and refinement tasks; refinement cards are titled by your own feedback and carry a "Refines" chip.
- Promote on a held card now explains why it was refused and can force execution past a pending replan.
- Task cards show creation and completion dates; Quick Add gets a visible Start button on workflows with a waiting column.
- Core, workflow, Git, agent, onboarding and utility dialogs are draggable and resizable on tablets with saved geometry.
- New Midnight, Sage, Factory Dark and Factory Light dashboard themes.
- A Settings control for the agent tool-output limit, including a no-limit option, and a quiet CLI mode that hides informational stdout.
- Project admission ranks review and execution work ahead of planning when a slot opens.
- Linked GitHub and GitLab issues are closed and explained when triage splits imported work or a task is deleted, and you get a mailbox notice whenever a task is deleted by someone other than you.
- Missions can override the project task prefix for triaged task IDs, and repeated mission validator runs are bounded by content-addressed memoization.

### Fixed

- Boards with renamed or custom columns now work end to end: merges, retries, PR merges, review stalls, replan targets, duplicate archiving, dependency unblocking, mission roadmaps, analytics, CLI task list and dashboard badges all resolve lanes from each task's own workflow instead of the legacy column ids.
- Dozens of self-healing repairs — stuck merges, ghost review cards, missing worktrees, contaminated branches, orphaned executions, stale dependency blocks — now run on renamed boards instead of silently finding nothing.
- Execution starts as soon as planning finishes, and starting a task begins planning immediately, instead of waiting out the 15s engine poll.
- Planning admission no longer freezes for the duration of every merge, the cause of 5–10 minute "Queued to plan" stalls; hung scheduler, merge and continuation passes now recover loudly with a warning instead of dying silently.
- Planning admission respects the worktree cap, so a 4-worktree board no longer runs 8 planners, and planning and review sessions run in the task's own worktree instead of the shared checkout.
- Column WIP limits are actually enforced — a move into a full column is refused instead of silently allowed.
- Worktrees are no longer deleted while a planning agent is still working in them, and leaked verification checkouts are reaped so planning stops queueing behind exhausted slots.
- Duplicate tasks no longer re-plan in a loop; a duplicate verdict is parked for your keep-or-delete decision even if the planner only states it in its reply, and GitHub imports are duplicate-checked before planning rather than after.
- Cards rejected by Plan Review are re-planned instead of stranding in Planning, and replan bounces keep the task worktree instead of re-cutting the branch.
- Tasks awaiting manual plan approval are no longer planned, reviewed or started before you approve them, and plan approval actions appear alongside the approval message.
- Plans written inside a task worktree are saved back to the main project and stored in the database.
- AI helper lanes (milestone interviews, subtask breakdown, agent generation, text refine, goal drafting, reflection, Planning Mode) run on your configured model instead of silently falling back to a default Anthropic model and returning a 401.
- Planning Mode and Settings no longer drop typed text after the first character, and expanded Mailbox reply rows stay open.
- Terminals, planning sessions and popped-out task windows survive view and tab switches; the dashboard survives mobile tab discards, resyncs on reconnect and stops caching API responses offline.
- Test mode tasks complete again — the mock executor was marking 1-based steps against a 0-based step model.
- Approval reuse and wedge resolution work on PostgreSQL projects instead of failing or minting duplicate requests.
- Waiting badges name their wait: "Queued to plan", "Ready" and "Revising" now match what the engine will actually do, and lane counts and card glow never exceed the number of running agents.
- Restore an archived card to the lane it was archived from, and archived-task document rules work on renamed archive lanes.
- Restarting during an AI merge no longer auto-pauses the task, and a paused engine reads "Paused" in the footer instead of "Idle".
- Tasks no longer park blocked on open GitHub PRs touching their files — blockers are board tasks only.
- Auto-archiving of tasks and auto-filing of recovery cards is removed; failures now stay on the task that failed.
- Compound Engineering code review parks after two unsuccessful remediation attempts instead of retrying forever, and reviews stalled by an engine restart recover in one self-healing cycle instead of ~36 minutes.
- Task API endpoints return 404 for an unknown task id instead of a 500, and task deletions record who asked.
- Mobile board swipes page immediately instead of coasting, edge swipes advance one column, and the bottom nav bar returns on large phones.
- Duplicate-warning "Open" buttons work, GitLab and Linear imports land on real board lanes, and switching projects fully resets Planning, Chat, Missions, import and open modals.
- Terminals no longer open blank until a keypress, and Windows direct-chat agent selection switches reliably.

### Performance

- Board scrolling is faster: desktop no longer snaps, phone swipes page immediately, and collapsing Archived or changing Done sort no longer re-renders every column and card.
- Agent tool output is bounded to a 16,000-character budget so large reads preserve context capacity, and verification results are trimmed to high-signal diagnostics.

### Internal

- Workflow-owned lifecycle: the legacy board and list rendering path, the pre-graph cutover machinery, and lossy column coercion helpers are deleted; review-gate leases record the node that holds them so a restarted engine can tell its own dead leases from a peer's.
- The unused cross-project concurrency table is dropped from the central database.

## 0.74.0-beta.9

### Highlights

- Midnight deep-navy dashboard theme lands with both light and dark modes
- Task Detail keeps Plan content current while planning and Plan Review run
- Done-task squash branches stop spamming reclaim logs and get deleted after completion
- Main full-suite is green again after schema, Missions hooks, and re-spec event fixes

### New

- Dashboard: Midnight, a deep-navy theme available in both light and dark modes, persisted across the dashboard and validated on Electron first paint.

### Fixed

- Task detail: the Definition/Plan prompt now refreshes while planning and Plan Review are running, so you are not reading a stale plan.
- Engine: stale-active-branch reclaim no longer floods the log for done-task squash leftovers, and those completion branches are deleted once the task finishes.
- Engine: Missions lifecycle hooks fire correctly, task updates only emit real lane moves instead of phantom dependency re-spec events, and schema/ledger bookkeeping tracks the current migrations and worktree capacity readers.

## 0.74.0-beta.8

### Highlights

- Tasks no longer park blocked on open GitHub PRs touching their files
- Board blockers are now other board tasks only, and legacy PR-blocked cards recover on their own
- Requeued task deleted at the same moment no longer strands without re-dispatch
- Planner retries fallback or unchanged output before handing off to Plan Review
- Terminal close control stays put after New terminal at every screen size

### Fixed

- Tasks are no longer parked as blocked because an open GitHub PR touches the same files. Blocking references are board tasks only, and rows previously parked by a file claim recover through the normal paths.
- Fixed a rare stall where a task requeued and deleted in the same moment never re-dispatched.
- Planning finalization now retries when the planner falls back or returns unchanged output, instead of sending that attempt straight to Plan Review.
- The terminal close control stays in place after New terminal at every screen size.

## 0.74.0-beta.7

### Highlights

- Multiple credential accounts per provider, selectable from every model picker
- Board keeps running on a second account when a provider hits its rate limit
- Review and execution work outranks planning when a project slot opens
- Reverted tasks leave Done and get Delete or Revise recovery actions
- Board lane counts and card glow match the number of actually running agents

### New

- Manage multiple credential accounts per provider from Authentication settings.
- When a provider hits its limit, work rotates to another configured account for that provider instead of pausing the board.
- Pick which configured credential account a model uses; the selector appears only for providers with more than one account.
- AI sessions start on the credential account you selected, and executor steps can switch to a rotated account without interrupting active work.
- Project admission ranks review first, then execution, then planning, with age and task ID breaking ties within a lane.
- When triage splits imported work into subtasks, the linked GitHub or GitLab issue is closed with an explanation of the split.
- Linked GitLab issues close when their Fusion task is deleted.
- Repeated mission validator runs are bounded by content-addressed memoization of validated inputs, with a durable per-project validation budget.
- PostgreSQL projects get durable, transactional task-deletion lifecycle events delivered to cross-process consumers with per-consumer cursors, receipts, leases, retries, and bounded retention.

### Fixed

- Reverted tasks no longer sit in Done; they move out with Delete or Revise actions, and Revise opens a draft prefilled with the original description.
- Lane counts and card glow no longer exceed the number of agents actually running; idle replans now read "Queued to revise".
- Manual merges waiting in renamed workflow review lanes now notify operators, and scheduler and planning reactions keep working on renamed lanes.
- Repeat task-wedge alerts stop flooding inboxes; each reason gets a six-hour cooldown that survives resolve/re-wedge flaps.
- Mission validators no longer reject passing feature assertion results, and valid validator JSON is recovered from ordinary response formatting noise.
- Mission assertion status edits and deletes no longer fail with invalid assertion IDs, and delete failures are surfaced.
- Milestone validation badges stay current after assertion repairs or removals.
- Reused execution worktrees refresh against merged dependency changes while keeping rebased task commits.
- Expanding a chat, Activity entry, or agent log now shows the complete tool-call details.
- Named Authentication actions stay targeted to the selected account, and auth status stays available when credential-instance data is missing.
- Registered projects show immediately while dashboard health metrics load.
- Task links opened from mail land in the active dashboard view.
- Upward Quick Add model and priority menus stay anchored to their trigger.
- Mobile: Summary token and cost tables scroll again, and Git Manager and GitHub Import sheets no longer leave dead space at the right edge on phones and short viewports.
- Translated dashboard catalogs cover the new reverted-task resolution actions.

## 0.74.0-beta.6

### Highlights

- Boards with renamed or custom columns now work end to end — merges, retries, self-healing, analytics
- Breaking: machine-wide concurrency cap removed — capacity is now two numbers per project
- Breaking: spawned child agents count against Max Concurrent Tasks and the worktree cap
- Approval and permission gates enforce: no self-approval, bash containment, fn serve authed
- Plan Review runs before a task takes a slot, and 5–10 min "Queued to plan" stalls are fixed

### Breaking

- The machine-wide concurrency cap is gone. Capacity is now two per-project numbers; Scheduling · Global and Scheduling · Project merge into a single Scheduling section, and the global sliders in the footer and Command Center are removed. A stored global limit is ignored, and the cross-project concurrency table is dropped from the central database.
- Spawned child agents now count against Max Concurrent Tasks and the worktree cap instead of a hidden spawn budget (previously 5 per parent / 20 global). Children each get their own worktree, so a fan-out could previously push a project past its limit while the scheduler believed it was at capacity.

### Security

- Full approval and permission hardening pass: the approvals decision route derives the decider server-side and blocks self-approval and forged actors, same-verdict replays and races return a conflict, pending requests expire after 24h and approved grants after a configurable TTL (default 1h).
- Unclassified tools now fail closed to policy-governed command execution, an unconditional bash containment floor denies daemon-token and credential-store reads and shell calls to the approvals API at every preset, and bash approvals bind to the exact command hash.
- `fn serve` mints or reuses the daemon token by default; opt out with `--no-auth`. Destructive task tools are withheld from agent principals, secret-read approvals are execute-once, and plugin task stores must declare destructive task permissions in their manifest.

### New

- Plan Review now runs in the planning lane before a task takes an implementation slot, with a "Plan Review" card badge; a card crosses into the work lane exactly once.
- New "Limit concurrent worktrees" project setting. Turn it off and Max Concurrent Tasks becomes the only limit — tasks still run in their own git worktree.
- Pick the workflow used for CLI- and agent-created tasks and for refinements; refinement cards are now titled from your feedback and carry a "Refines" provenance chip.
- Multiple named credential instances per AI provider, with the selection persisted across model configuration (inert this release).
- Chat sessions expose the full permission-gated task toolset (archive, delete, retry, pause, merge and more).
- Agent Detail, Import Tasks, Task Detail, New Task, Create Room, right-dock pop-outs and floating terminals are now movable and resizable, including on tablets, with saved geometry.
- Two new dashboard themes: Factory Dark and Factory Light, plus Sage.
- Missions can override the project task prefix for their task IDs.
- Read-only APIs that enumerate dashboard views and settings sections.

### Fixed

- Renamed and custom board columns are honored across the product: merges and merge re-enqueue, PR merges and "changes requested" reviews, retries, escalation and loop protection, replan targets, review-stall surfacing, dependency unblocking, archive and restore, duplicate flags, mission roadmaps, planner oversight, the scheduler, and roughly forty self-healing recoveries that previously matched nothing and left cards stuck.
- New tasks no longer sit queued for minutes: a hung triage poll now recovers loudly past 120s, planning admission no longer freezes for the duration of every merge, and the scheduler, merge queue and continuation drain each force-open a stuck pass with a warning.
- Planning admission respects the worktree cap, so a 4-worktree board no longer starts 8 planners; a planned card's retained worktree transfers on release instead of blocking it.
- Worktrees are no longer deleted while a planning agent is still working in them, and leaked verification checkouts are reaped so planning stops queueing behind exhausted slots.
- Stop AI Engine now actually halts the workflow graph — new Plan Review sessions no longer start while paused.
- Column WIP limits are enforced again: a move into a full column is refused instead of silently allowed. Only actively running tasks count against worktree capacity, and queued tasks can resume in their retained worktrees when capacity is full.
- Terminals, planning sessions and popped-out task windows no longer reset when you switch views or tabs.
- Restoring an archived card returns it to the lane it was archived from instead of Done.
- A restart during an AI merge no longer auto-pauses the task; merge-confirmed work finalizes instead of being parked failed.
- Test-mode tasks complete again — the mock executor was marking the wrong step numbers.
- Tasks awaiting manual plan approval are no longer planned, reviewed or started before you approve, and approval actions now sit next to the approval message. A task queued for plan review no longer waits behind cards parked on approval.
- The board Actions menu no longer appears on bare Planning cards, and the Plan action no longer shows on cards already executing.
- Imports land on real lanes: GitHub-issue imports are checked for near-duplicates before planning, and GitLab and Linear imports no longer write to a deleted column. Routines, scheduled tasks, refinements and duplicates land in the workflow's own intake column.
- Move menus offer exactly the moves a workflow allows; task moves validate against the board's own workflow. Workflow edits, deletes and switches reconcile the cards sitting in the affected columns.
- CLI fixes: `fn task list` no longer omits cards in custom columns, `fn task retry` and `fn project` work on renamed boards, and `fn dashboard` reports a real active count. Node, mesh and project commands no longer mark the host offline on exit.
- Wedge notifications can be resolved again on PostgreSQL projects, and two lock re-entrancy hangs (self-blocking dependencies, interrupted column transitions) are fixed.
- Compound Engineering code review parks after two unsuccessful remediation attempts instead of retrying forever, and graph-native workflows no longer deadlock at review with 0/N steps.
- Grok usage no longer reports a false 100% or a bogus expired login.
- Custom plan sections survive a description refresh from Fusion.
- Upstream pull requests can be created from task branches pushed to a contributor fork.
- UI polish: task-card size badges align with neighboring badges, cost badges hide when unavailable, Task Detail stays centered while scrolling, excess space below progress controls is gone, Command Center concurrency controls are aligned with the Max worktrees slider restored, and the Planning "Add comment to selection" button is no longer below the fold.
- Even Realities glasses plugin: column filters, completion notifications, review actions and the deck cap all respect renamed lanes.

### Performance

- Collapsing Archived or changing Done sort no longer re-renders every board column and card.

### Internal

- Auto-archiving of meta tasks and auto-filed recovery cards is removed; failures now stay visible on the task that failed. The classifier matched ordinary feature work and could archive live tasks.
- The unreachable legacy board and list rendering path, the retired workflow-columns flag reads, and a lossy column-coercion helper are deleted, with ratchets preventing their return.

## 0.74.0-beta.5

### Highlights

- Planning Mode and Settings keep every character you type, not just the first
- Cards no longer stall on "Queued to plan" with free slots after a planner hangs
- "Queued to plan" and "Ready" badges match what the engine will actually do with the card
- Expanded Mailbox reply-context rows stay open when you expand another row

### Fixed

- Planning Mode and Settings no longer drop typed text after the first character — the modal shell was remounting the focused input on every render.
- Cards stuck on "Queued to plan" while concurrency slots sat free are now re-offered for planning after a hung planner is evicted, instead of waiting for an engine restart.
- The "Queued to plan" and "Ready" badges on Todo cards now reflect whether the card is genuinely awaiting planning, rather than guessing from its step count. Todo rows carry this state through live board updates.
- Expanded reply-context rows in the Mailbox modal stay expanded when another row is opened; the recursive reply thread no longer remounts and collapses.

## 0.74.0-beta.4

### Highlights

- Code Review and Browser Verification now run with the card in In review, badged there
- Opt-in auto-update installs the new build and restarts Fusion on your release channel
- Cards no longer strand in Planning after Plan Review sends them back for changes
- Dashboard survives mobile tab discards, resyncs on reconnect, and stops caching API responses offline
- Agent tool output is capped at 16,000 characters, with a Settings control and a no-limit option

### New

- Code Review and Browser Verification run with the card sitting in In review, and the running step shows as a card badge. A changes-requested verdict still sends the card back to implementation.
- New global setting for auto-update and restart (off by default, in Settings → General next to Release channel). The post-update Restart button now always issues the request and shows the server's reason when it is refused, instead of sitting disabled.
- Core, workflow, and Git dialogs — 13 modal surfaces in all — are draggable and resizable on tablets, with geometry remembered between sessions.
- A Settings control for the agent tool-output limit, including 0 for no limit.
- The mobile project drop-down lists favorite projects in their own section at the top.
- You get a mailbox notice whenever a task is deleted by an agent tool or an unattributed API caller; deletions from the dashboard, CLI, and engine stay silent.

### Fixed

- Cards sent back for re-planning by Plan Review now actually get re-planned instead of sitting in Planning, and replan bounces keep the task worktree instead of tearing it down and re-cutting the branch.
- Cards can no longer sit waiting unowned on the planning path, a new watchdog reports any card idle past 30 minutes with no live session, and cards left with a stale "planning" status recover on a sweep instead of waiting for an engine restart.
- Self-healing no longer pauses cards whose planning session is still running, and queued planning admission walks past a declining lane instead of stalling the whole pass.
- Reviews stalled by an engine restart recover in one self-healing cycle rather than roughly 36 minutes, and the post-review fix budget default goes from 3 to 10.
- Review gates are harder to lose: symbol locks are reclaimed on the way back into work, hung gates are stall-detected, a just-started gate is no longer failed by a sweep, and a merge can no longer be enqueued before Code Review has run.
- Duplicate tasks are parked for your keep-or-delete decision instead of re-planning in a loop — including when the planner only reports the duplicate in its reply rather than writing the marker file.
- Deny now withholds task-creating tools from agent sessions, and the duplicate-create window widens from 60 seconds to 10 minutes so a retried create no longer duplicates.
- Approval reuse works on PostgreSQL instead of minting a duplicate request on every retry.
- A review task whose worktree was removed gets a fresh one instead of failing on every retry.
- Verification results stay concise, so a large failure dump no longer exhausts agent context.
- Incomplete foreach workflow steps are blocked from entering merge review.
- Planned hold-column cards whose Plan Review continuation was lost are recovered.
- Mobile board swipes from the first or last column advance one column instead of two.
- Task modals lose their excess tablet padding and dead right-edge space on landscape tablets while keeping usable touch resize grips; floating windows are touch-movable and resizable on tablets.
- Task-card cost badges return for legacy tasks with recorded token usage, and the size badge lines up when a card shows two status badges.
- Manual GitHub and GitLab import translations survive reopening the import panel.
- Cross-project plugin discovery no longer unloads enabled plugin skills.
- Task API endpoints return 404 for an unknown task id instead of a 500.
- Task logs no longer report engine-initiated aborts as operator hard-cancel pauses.
- Mailbox message links use theme colors instead of default browser blue.
- Routine diagnostic noise is reduced in the operator log view.
- Legacy desktop builds stay on one packageable Pi runtime dependency closure (Pi 0.82.0).
- A false handoff-invariant violation is no longer logged every time a task enters a review gate.

### Performance

- Every engine-injected tool result is bounded by a 16,000-character budget, so large reads preserve context capacity.

### Internal

- Task deletions record who asked — operator UI, CLI, agent tool, engine, or unattributed API. Attribution only; no delete gating was added.
- Review-gate leases record the node holding them, so a restarted engine can reclaim its own dead leases immediately instead of waiting out the staleness window.

## 0.74.0-beta.3

### Highlights

- Plans written in a task worktree now save back to the project and database
- Promote on a held card says why it was refused and can force past a pending replan
- Small mobile board swipes no longer jump several columns at once
- Mobile Settings footer buttons scroll sideways by touch when they overflow
- Cards no longer stay stuck with stale worktree metadata after an aborted plan

### New

- Promote on a held card now explains why the promotion was refused instead of showing a raw translation key, and offers a confirmed force option that pushes the card into execution past a pending replan. Force waives only the unplanned-for-execution gate — capacity, hold membership, and slot reservation still decide. Available from the board, the promote API, and the promote tool.

### Fixed

- Plans a planner writes inside a task worktree are now reconciled back to the main project before triage finalizes, and the authoritative plan is also stored as a task document, so plans no longer silently vanish.
- Cards are no longer left with stale worktree metadata when their branch inherited another task's commit. A branch cut from the base that never committed anything — planning aborted, card moved back to todo — was repeatedly rejected as foreign contamination on every self-healing sweep.
- Small horizontal swipes on the mobile board now advance one column instead of flinging several; extra pages require real gesture travel, not just release speed.
- The mobile Settings footer rail scrolls sideways by touch again when its buttons overflow the screen, including on landscape phones.

## 0.74.0-beta.2

### Highlights

- Two tasks can run Plan Review at the same time instead of one failing and parking
- Planning and every review step run in the task's own worktree, never the shared checkout
- Moving a card out of Todo mid-plan stops planning, clears the badge, and frees the worktree
- Session contention now waits and requeues on a 10-attempt ladder instead of parking the task
- Mobile Settings footer no longer clips the update notice and buttons

### Fixed

- Concurrent tasks no longer collide in Plan Review: the second task used to surface a provider failure and burn its retry budget. Sessions are now scoped per task even outside workspace mode.
- Planning and all review steps acquire the task's own worktree instead of degrading to the shared repo root; Plan Review re-acquires a worktree if its recorded one is gone.
- Remaining contention is treated as transient: the engine waits on a 10-attempt ladder from 5s to 60s and ends in a benign requeue rather than parking the task.
- Moving a card backward out of Todo while it is planning now aborts the in-flight planning run, clears the planning badge, and releases the pre-execution worktree.
- A new self-healing sweep reclaims parked pre-execution worktrees only after 30 days of complete inactivity, skipping todo, executing, paused, blocked, and recovery-scheduled tasks.
- On mobile, the Settings update-check result renders on its own row above the action buttons instead of being cut off; desktop and tablet keep it inline next to the version button.

## 0.74.0-beta.1

### Highlights

- Voice dictation in dashboard composers, opt-in with a checksum-pinned Parakeet v3 model
- Execution starts the moment planning finishes instead of waiting out the 15s engine poll
- Quick-add Start no longer strands tasks in Todo that could never be planned
- Open on duplicate-task warnings now actually opens the task
- Restart all agents in the System panel works again instead of erroring

### New

- Voice dictation across dashboard composers, gated behind a project-scoped Voice Input setting and disabled by default; the mic button stays inert until you turn it on.
- Voice Input settings panel for enabling dictation and managing the Parakeet v3 model, with live download and status controls.
- Parakeet v3 model downloads are verified against a pinned upstream SHA-256 checksum before use, and cached in a shared location across projects.
- Voice transcription API with project-bound audio endpoints and a lazily loaded speech runtime, so nothing extra is initialized unless dictation is on.
- Quiet CLI mode that suppresses informational stdout chatter, via the new quiet flag or the FUSION_QUIET environment variable.

### Fixed

- Starting a task now kicks off planning immediately from every surface (board drag, context menu, CLI, tools, API move) instead of waiting up to 15 seconds for the next planning poll. Todo cards still waiting on a planning slot show a "Queued to plan" badge, and the Start toast now honestly says "Queued for planning" rather than claiming planning began.
- Once planning finishes, the scheduler wakes and dispatches right away; plan-in-place workflows such as Coding (Ideas) previously sat idle until the next engine poll.
- Quick-add Start on a manual-intake workflow no longer creates tasks with placeholder steps that planning would skip forever, leaving them stuck in Todo with no log line.
- Coding (Ideas) boards can move cards back from Todo to Ideas again; the move check now respects the workflow's own column adjacency.
- The Open button on possible-duplicate task warnings works from every surface it appears on, and unresolvable task ids now show a toast instead of silently doing nothing.
- Restart all agents in the System panel no longer fails with a storage removal error.
- Planning Mode shows a single "Add comment to selection" button, and only after the selection is finished, so it no longer flickers mid-drag or duplicates on mobile.
- Creating a chat tag from the context menu applies it to the open conversation immediately.
- Reports Health Check now surfaces unrecoverable direct-report failures instead of hiding them behind stale state.
- Task composers no longer fire duplicate project-settings requests when the dictation button is present.

### Internal

- Hold-release sweeps log how long each card was held, a per-sweep summary with prefetch cost broken out, and a warning when a sweep exceeds 2 seconds.

## 0.74.0-beta.0

### Highlights
- Choose Anthropic API key vs. subscription per lane, with a clear "in use" indicator
- Fixed: AI helper lanes (subtasks, milestones, goals, reflections) no longer silently fall back to the wrong Anthropic model
- Fixed: Planning Mode no longer fails mid-interview with an auth error on a model you never picked
- Board scrolling is snappier — no more snap-lock on desktop, instant paging on phone swipes
- Tag and filter Direct chat conversations in the sidebar

### New
- Choose whether Anthropic lanes use your API key or your Claude subscription, with an "in use" marker in Settings → Authentication
- Board scrolling feels faster: desktop no longer snaps mid-drag, and phone swipes page immediately instead of coasting
- Task cards now show creation and completion dates directly
- Organize Direct chat conversations with reusable, project-scoped tags and sidebar filtering
- Quick Add now shows a visible Start button for workflows with a waiting column, instead of a hidden long-press menu

### Fixed
- Windows: direct-chat Agent selection now switches visibly and reliably
- New Task dialogs close without a discard confirmation when nothing was actually touched
- Tablets: Task Detail and New Task regain touch resizing
- AI helper lanes (interviews, subtask breakdown, agent generation, text refine, goal drafting, reflections) now run on your configured model instead of silently falling back to a default Anthropic model and erroring out for custom-provider or subscription users
- Large phones no longer lose the mobile bottom nav bar after being misclassified as tablets
- The footer now reads "Paused" instead of "Idle" when the engine is paused, and pausing from the terminal now takes two presses to avoid accidental toggles
- Planning Mode no longer fails mid-interview with a provider auth error tied to a model you never selected
- Switching projects now fully resets Planning, Chat, Missions, subtask breakdown, GitHub import, and any open modals so nothing leaks across projects
- Tablets: the Quick Chat header is easier to grab and drag
- Terminal windows no longer open blank until a keypress, font-size change, or new tab

### Internal
- Updated bundled Pi runtime dependencies to the matched 0.82.0 pair

## 0.73.0

### Highlights

- Remove the Planning Mode deepening checkpoint and fixed interview depth caps.
- Scrub top-level report activityTrace before filing so paths and tokens never reach the pipeline.
- Quality hub now shows task verification videos when review artifacts are enabled.
- Add beta and stable release channels — pick your update track in Settings or with `fn update --channel <stable|beta>`.
- Agent chat now investigates the live codebase with tools before answering architecture and code questions.

### New

- Quality hub now shows task verification videos when review artifacts are enabled.
- Add beta and stable release channels — pick your update track in Settings or with `fn update --channel <stable|beta>`.
- Agent chat now investigates the live codebase with tools before answering architecture and code questions.
- Let operators set the embedded PostgreSQL connection cap in Advanced Settings.
- Add an optional Task chat progress feed for task steps, failures, reviews, and rollbacks.
- Add mailbox approval for ephemeral agent follow-up tasks.
- Add a mission auto-merge override so a mission's features share one branch and one PR.
- Mission auto-merge controls now explain merge behavior and show shared branch PR status.
- Add guided in-app Bug, Feedback, Idea, and Help reporting.
- Add durable configuration revision history primitives.
- Add portable secret-scrubbed organization export and import commands.
- Add review artifact controls and deliverable galleries.
- Add reusable native structure preview payloads and dashboard cards.
- Auto-generate a short feature-video artifact for user-facing task deliverables.
- Preview supported missions, findings, evals, and goals directly in chat.
- Attach reviewable native structures to mailbox messages.
- Add drag-to-attach native structures and AI narrative drafting to Mail.
- Expose Mission hierarchy tools to engine agents and dashboard chat.
- Add persisted ideation sessions with atomic Mission handoff.
- Request and observe task E2E verification from chat.
- Promote completed research findings into mission roadmap features.
- Schedule approved mission work with symbol-level concurrency control.
- Require approved mission lineage for autonomous task creation and delegation.
- Let operators choose GitHub Issues or Discussions for in-app reports.
- Add scrubbed activity context and optional local report screenshots.
- Deduplicate in-app reports against open public-roadmap issues.
- Add consent-based screenshots and activity context to in-app reports.
- Add opt-in reviewed screenshots and scrubbed activity traces to in-app reports.
- Let operators prevent duplicate in-app reports with optional roadmap matching.
- File Feedback and Help reports as Issues when GitHub Discussions is disabled.
- Make Planning Mode an infinite interview validated explicitly by the user.
- Move configuration version history and rollback controls into Settings.
- Move the org export / import card from Command Center Overview to the Team tab.
- Ideation is now a top-level experimental sidebar/mobile view instead of a Command Center tab.
- Preview roadmap items and open their hosted Roadmaps destination.
- Rebuild Planning Mode into a three-pane interview with always-visible plan and Validate.
- Dashboard chat agents can edit files and run bash with coding workspace tools.
- Show WhatsApp pairing QR and setup instructions in plugin settings.
- Planning Mode plan.md is now distinct from triage PROMPT.md on task create.
- Simplify Planning Mode to a sequential Q&A and plan-review flow with focus-steered refine.
- Unify max concurrency across planning/execution/review and simplify board capacity indicators.
- Let operators select the Aurora dashboard theme.
- Add the Calm dashboard theme with slate, sage, and misty light palettes.
- Add the Dawn indigo-and-amber dashboard color theme.
- Filter dashboard color themes by name in Settings and Command Center.
- Let operators enable or disable GitHub tracking from Coding Ideas task details.
- Honor skill-executor config on foreach step-execute sessions so per-step skills load like top-level nodes.
- Add a gesture-only Quick Add Start action for eligible workflows.
- Show Xiaomi branding for Xiaomi and MiMo provider labels.
- Add photo and file attachments to Quick Add and Main Chat.
- Keep default Code Review remediation retries unlimited and show the active policy.
- Add optional explanatory descriptions to custom workflow board columns.
- Add contextual comments to Planning Mode plan reviews.
- Make Planning Mode refine plans through codebase-grounded direction choices.
- Add guided setup for local OpenAI-compatible model providers.
- Add per-agent and project-wide heartbeat enable controls.
- Let agent-card heartbeat controls disable and re-enable scheduling.
- Add conditional task-document writes that reject stale publishers without changing revision history.
- Add authenticated append-only corrections for documents retained on archived tasks.
- Embed opted-in report screenshots in filed GitHub reports.
- Your workflow now drives the board — cards move through the columns you defined, not a fixed six.
- Tasks left mid-flight by an older Fusion are now adopted on upgrade instead of sitting stuck.
- One plan can now create multiple tasks — in the dashboard, the CLI, and agent tools alike.
- Let enabled plugins declaratively provide project MCP servers.
- Store in-app report screenshots as validated local artifacts.
- Task Stats tab now shows creation provenance — source type, parent task, creating agent, and duplicate flags.
- Add stable dashboard theme tokens and plugin overlay layering with --fusion-max-z.
- Preserve parent lineage and reuse duplicate tasks created from planning breakdowns.
- Add a simple Ideas-to-Done workflow with truthful, resumable column transitions.

### Fixed

- Show SQLite→PostgreSQL migration status on the dashboard while cutover is not done.
- Stop showing Reconnecting status text in Planning Mode.
- Beta release notes now list only that beta's changes; stable notes roll up the whole beta cycle.
- Fix broken beta binary builds — bun executables and the Windows desktop EXE package again.
- Board column headers now count REVISING (replan) cards and other visibly active cards in the processing count.
- Preserve approved task scope during review and committed work during worktree recovery.
- Prevent retried agent steps from creating duplicate follow-up tasks.
- Fix Compound Engineering sessions dying with "AI returned no valid JSON" when turns race; add retry and diagnostics.
- Stop the Chat/Quick Chat "Latest" button from jumping when the cursor moves near or presses it.
- Recover in-review tasks stranded by a restart that killed an in-flight review step, instead of failing them.
- Duplicate follow-up tasks naming the same failing file now converge at creation across parent tasks.
- Boards built on custom workflows now show and move cards in their own columns.
- Plugin API routes now work for plugins enabled after startup or enabled only in a non-launch project.
- Fix embedded PostgreSQL crash-recovery boot on Windows — no self-shutdown race, no 30s .pgrunner log stall.
- Allow planning sessions to persist PROMPT.md without an approval gate.
- Fix built-in workflows sending cards backward to Todo and stalling the PR workflow.
- Allow freeform chat task creation without mission lineage.
- Fix a crash where chat messages and mailbox sends containing a raw NUL byte would abort mid-conversation.
- Report when the server Claude CLI needs login instead of waiting a minute and showing a false usage timeout.
- Show Codex weekly usage when OpenAI reports it as the primary quota window.
- Prevent review-contract retry instructions from replacing workflow completion summaries.
- Prevent fn_task_show timeouts when another Fusion process already owns embedded PostgreSQL.
- Honor forced GitHub transport selection for GraphQL discussion queries and mutations.
- Apply planning actions on the first mobile tap and create tasks without a separate validation step.
- Workflows without a merge step now finish in their completion column instead of stalling one column short.
- Fix tasks with no saved workflow selection being unable to move between columns.
- Allow dependency-ready workflow steps to finalize when earlier independent steps are still running.
- Wait for the AI-authored Planning Mode plan before enabling review actions.
- Fix Planning reopen after a finished session so Retry no longer dead-ends.
- Keep Planning plan-review Add-comment controls on-screen on mobile after text selection.
- Make plan refinement submit reliably from stopped, active, restored, and mobile planning states.
- Keep planning timers session-specific and return cleanly from stopped generations.
- Resume initial planning cleanly after stopping generation and preserve session timers across refreshes.
- Finish plan task creation automatically and show links to the task or planning sessions.
- Prevent stale worktree ownership metadata from blocking commits after a pooled checkout is reassigned.
- Restore automatic task lifecycle entries in PostgreSQL activity logs.
- Prevent transient dashboard failures when multiple projects initialize PostgreSQL concurrently.
- Settings Check for updates now finds newer beta releases when the beta channel is selected.
- Hide task-card overseer eyes immediately after workflow oversight is turned off.
- Accept task completion regardless of wording in the completion summary.
- Let task planning persist complete specifications before Plan Review starts.
- Make Windows updates actionable and restore Compound Engineering agent personas in npm installs.
- Restore the Simplified and Traditional Chinese labels for duplicate roadmap reports.
- Hide the task-card overseer eye when a workflow only uses the default (unconfigured) oversight level.
- Preserve archived shared-branch landing proof during PostgreSQL promotion checks.
- Planning Mode no longer accepts a truncated final plan with empty deliverables.
- Oh My Pi (omp) model selections now run via the OMP ACP runtime instead of failing.
- The task-detail oversight eye icon now reflects the session advisor's on/off state even when planner oversight is off.
- Keep workflow chips and HTML mockup previews visually consistent across themes.
- Mobile Kanban swipes now settle on exactly one column with no stuck-between-columns state.
- Task detail action buttons now render at a consistent size across all themes.
- Restore token recovery for installed PWAs after an unauthorized backend response.
- Foreign-language GitHub/GitLab issues authored via issue forms now auto-translate and offer the Translate button.
- Move the task-card cost badge below the Promote button in the bottom-right corner.
- Planning Mode now always asks clarifying questions before producing a plan.
- Resume saved Planning Mode progress after reload without automatically re-running generation.
- Allow manual scrolling during generation in task chat, agent logs, and chat.
- Allow manual scrolling during generation in task Planner Chat.
- Allow manual scrolling during generation in the task Workflow tab live log.
- Preserve manual scrolling in System Controls and Dev Server live logs.
- Fix mobile model dropdown so the list stays scrollable after searching.
- Fix tasks stuck on "Needs your decision" when their duplicate is already done.
- Fix task token counts inflated by reused or resumed agent sessions.
- Fix GitHub issue imports so edited descriptions cannot hide or falsely match prior imports.
- Fix dashboard build failure caused by missing html2canvas dependency.
- Save Settings edits automatically and safely flush pending changes when closing.
- Task detail inline action icons now render at a consistent size on tablet screens.
- Separate pinned chat conversations in the list and fix message edit Save.
- Show Compound Engineering in navigation when the enabled plugin starts.
- Preserve task work while recovering checkouts created outside the configured worktree directory.
- Same-agent near-duplicates stay on the board by default on all create paths (no silent auto-archive).
- Fix Report menu stacking and move Command Center reports to System.
- Restore Settings Configuration Versions translations for es/fr/ko/zh-CN/zh-TW after FN-8350 key move.
- Install @agentclientprotocol/sdk with @runfusion/fusion so the Claude CLI pi extension can load.
- Fix mission interview start crashing when thinking level is left at Default.
- Fix startup crash when a project has both fallback and registered partition data.
- Keep Planning Mode interviews open until you explicitly validate the running plan.
- Task detail Oversight/Fast and chat send heights match sibling controls on tablet.
- Fix Grok and Claude Fusion tools MCP bridge packaging and model markers
- Show only one agent name badge when a task is assigned to its creator.
- Return CLI chat replies to the terminal and expose dashboard inbox reads.
- Make fn chat a named mailbox conversation with a stable conversation id.
- Make Planning Mode usable on mobile and tablet with progressive interview layout.
- Keep workflow tasks paused while an agent question is awaiting an operator response.
- Restore mobile navigation back to the Planning session list without a stuck Running plan screen.
- Stop the dashboard TUI Logs tab from showing detailed timestamps on each log line.
- Give the Report menu an opaque background so page content no longer shows through.
- Planning Mode tablet tabs match mobile; mobile main shows sessions before running plan.
- Planning Mode running plan shows an evolving plan, not repeated interview questions.
- Restore in-progress Planning Mode interviews after leave/return, including mid-generation.
- Planning Mode now drafts an initial running plan from your idea and refines it after each answer.
- Planning Mode now uses the same workflow triage planning prompt template as newly added tasks.
- Persist operator duplicate decisions so Fusion does not re-ask for the same task.
- Deliver enabled plugin skills in dashboard chat the same way task sessions do (include skill body paths).
- Include planning-lane AI time and tokens in task cost and duration totals.
- Keep Planning Mode compact interview view tabs pinned to the top on Answered questions.
- Keep dismissed GitHub Copilot re-login banners hidden permanently.
- Android and browser Back from a GitHub import detail returns to the issue list first.
- Planning Mode history now collapses AI thinking by default.
- Reject unknown `fn update` flags and document the beta install bootstrap.
- Stop false CE skill-load warnings when plugin skills resolve without FUSION_CE_SKILLS_DIR.
- Stop legacy-adoption drained-marker warn spam on every CLI open under embedded Postgres.
- Accept root-level File Scope files with extensions such as global.json and solution files.
- Stop spurious per-task `spawn /bin/sh ENOENT` noise during step baseline capture.
- Ignore stale flat skill-toggle keys so session skills match the Skills view after category layouts.
- Allow session Read tool to open host-advertised plugin skill body paths under worktree boundary.
- Keep plugin enable state consistent across UI and loaders after toggle.
- Load each enabled plugin once per process startup (no duplicate onLoad).
- Stop workflow-definition creates from failing when a WF-id is already taken.
- Restore the Coding Ideas board header color indicator.
- Remove excess right padding from task popups on tablets.
- Show Planning status badges for active Coding Ideas Todo tasks.
- Restore the Coding Ideas detail action to move parked ideas to Todo.
- Show Planning (not Triage) in task activity model-using logs.
- Remove redundant readiness descriptions from Todo and In Review board headers.
- Remove ellipses from merging status badges on task cards.
- Mobile board swipes always settle on a single centered column, never between columns.
- Keep task detail footer actions on a single row on mobile.
- Show Revising instead of Replan on needs-replan task status badges.
- Keep task-card active glow during replan and revise while agents work.
- Mobile board pan/fling always settles on one centered column, never between.
- Fix macOS embedded PostgreSQL startup when bundled ICU compatibility links are missing.
- Align mobile task-detail Move actions with the footer edge.
- Restore active chat thinking and partial response state when returning to a conversation.
- Notify operators when a task is terminally blocked or exhausts automated recovery.
- Create Coding Ideas Start tasks directly in Todo.
- Hide uninstalled runtime pages from Settings integrations.
- Prevent plugin toggles from reinstalling uninstalled runtimes.
- Prevent Windows embedded PostgreSQL log contention and recover once from DLL initialization crashes.
- Stop completed PostgreSQL migrations from re-scanning retained SQLite backups at startup.
- Make imported task links in Stats follow the active dashboard theme.
- Keep Planning Mode selected-text comments reachable in the mobile action rail.
- Honor selected workflow planning models in Planning Mode.
- Keep Planning Mode recovery retries safely bounded after failed attempts.
- Keep Planning Refine and Proceed actions visible on mobile.
- Give Planning Mode a dedicated collaborative prompt instead of task-triage instructions.
- Show complete mission hierarchies in agent mission lookup results.
- Show failed mission assertions and safe validator evidence in remediation work.
- Scope feature validation to linked assertions instead of unfinished milestone work.
- Bound generated mission fixes to one root feature retry budget.
- Keep supervised mission validation report-only until autonomy is explicitly enabled.
- Fix supervised task creation and defined-feature mission bootstrap admission.
- Make ideation candidate IDs discoverable for direct convergence.
- Keep GitHub issue import actions on one usable mobile row.
- Reconcile completed mission features safely against archived delivery tasks.
- Lower the embedded PostgreSQL default connection cap to 150 on Windows to prevent 0xC0000142 backend crashes.
- Grok CLI fallback models now engage only when the primary model actually fails, instead of replacing it up front.
- Keep Grok ACP process cleanup armed once per process, without listener growth.
- Prevent unfinished prose-only plans from advancing into implementation and merge.
- Improve Planning Mode refinement and replace Validate with Proceed with plan.
- Add mobile Planning tabs, one-click task creation, and answer/reasoning history.
- Install the agent-browser binary with Fusion on Windows, Linux, and macOS.
- Keep healthy AI providers running and resume provider-paused tasks when capacity returns.
- Push-after-merge no longer silently strands approved merges when the remote diverged.
- Stop the legacy-adoption sweep from clearing live task statuses (planning, queued, merging, stuck-killed) on store open.
- Board column and footer running counts now include live Code Review, Plan Review, and other gate sessions.
- Keep tasks running when an MCP server is temporarily unavailable.
- Keep unresolved merge-review blockers active across concurrent-main rebuilds and later retries.
- Fix mobile board snapping after interrupted swipes, flings, and vertical card scrolling.
- Keep OMP ACP process cleanup armed once per process, without listener growth.
- Prevent executors from starting ordered task steps before their required predecessors finish.
- Orphaned in-flight review steps are now marked failed for re-review instead of silently skipped at merge.
- Recover missing workflow plans before review instead of approving or stranding tasks.
- Prevent Plan Review tasks from blocking each other after a missing-worktree fallback.
- Deleting a task created from a plan no longer dead-ends the plan — Proceed creates a fresh task.
- Fix duplicate planning sessions created when navigating away from and back to Planning.
- Make Planning Mode generate a durable initial plan before asking optional refinement questions.
- Planning Mode no longer hangs on "Generating plan" after a provider error; it surfaces a retryable error.
- Planning, mission, milestone, and onboarding interviews regenerate a question instead of "No active question" errors.
- Planning sessions now show Complete instead of Needs input after their task is created.
- Planning mode now shows a neutral session loader while restoring a saved session instead of "Generating…".
- Stopping a plan now also cancels generations that haven't started streaming yet.
- Every Planning Mode generation step now streams AI thinking/output, not just the first turn.
- Fix Planning Mode duplicating generations and "AI returned no valid JSON" errors after leaving and returning mid-run.
- Keep Planning Mode questions and the running plan in sync after each answer.
- A finished plan is never a dead end — read it, keep refining, and create the task at any time.
- Improve Planning Mode with scrollable Markdown plans and mobile bottom actions.
- Report PostgreSQL health failures accurately without false database-corruption guidance.
- Fix engine restarts stranding replan-loop tasks in To Do by clearing their needs-replan signal.
- Prevent agents from filing duplicate active diagnostic follow-ups discovered by different tasks.
- Switching projects now fully resets Planning, Chat, Missions, subtask breakdown, GitHub import, and open modals.
- Apply project workflow model lanes to every workflow ahead of global and workflow values.
- Close the Quick Add agent picker when clicking outside it.
- Stop active task processing before a user move to Todo becomes visible.
- Prevent Plan Review replans from stranding completed tasks in Triage and recover affected tasks automatically.
- Stop PostgreSQL permission errors when the dashboard reads SQLite migration health.
- Keep manually parked tasks out of scheduler and remembered-owner dispatch until explicitly unpaused.
- Resume mission features that were interrupted during validation after an engine restart.
- Automatically retry interrupted Planning sessions when operators return to them.
- Isolate automated tests and global test-mode runs from the normal Fusion database.
- Prevent concurrent tasks from falling back when an Anthropic OAuth token rotates.
- Send only one in-progress update per Fusion task on its linked GitHub tracking issue.
- A custom Merging column now receives the card at merge instead of being sent to In-review.
- Task chat step narration now shows 1-based step numbers matching the task card's step count.
- Keep secondary locale catalogs in sync with heartbeat controls and settings provenance labels.
- Open task card files-changed links in the task popup when Open tasks as popups is enabled.
- /new and /clear in Chat no longer wipe a task-bound planner chat's history.
- Hide empty chat verification status and move active results below task metadata.
- Terminal now auto-starts a session from Windows browsers when the dashboard host is not Windows.
- Terminal no longer sticks on "Starting terminal..." on Windows and Ctrl/Cmd+V paste is delivered exactly once.
- Stop Planning Mode questions from filling Mailbox and tighten desktop planning pane spacing.
- Show every suggested Planning Mode refinement category instead of limiting choices to three.
- Replace the Planning Sessions toggle with a consistent Back-to-sessions control.
- Preserve workflow lifecycle state and start execution steps only after worktree creation.

### Breaking

- Remove the Planning Mode deepening checkpoint and fixed interview depth caps.

### Security

- Scrub top-level report activityTrace before filing so paths and tokens never reach the pipeline.

### Internal

- Bump the bundled pi runtime to 0.81.1 for newer models, providers, and session reliability.
- Review gates now run only as workflow nodes — the in-session step reviewer is gone.

## 0.73.0-beta.6

### Highlights
- Beta binaries fixed — bun executables and the Windows desktop EXE package again
- Switching projects now fully resets Planning, Chat, Missions, subtask breakdown, GitHub import, and open modals
- Planning no longer spawns duplicate sessions when you navigate away and back
- Chat's /new and /clear no longer wipe a task-bound planner chat's history
- Terminal auto-starts from Windows browsers when the dashboard host isn't Windows

### Fixed
- Beta binary builds are working again: bun-compiled executables and the Windows desktop EXE package correctly
- Navigating away from and back to Planning no longer creates a duplicate planning session
- Switching projects fully resets Planning, Chat, Missions, subtask breakdown, and GitHub import state so nothing leaks or mis-files across projects
- Task chat now narrates step numbers starting at 1, matching the task card's step count
- /new and /clear in Chat no longer wipe a task-bound planner chat's history
- Terminal now auto-starts a session from Windows browsers when the dashboard host itself isn't Windows

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
