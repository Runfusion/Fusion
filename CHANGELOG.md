# Fusion changelog

User-facing release notes aggregated across all packages. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.

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

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.73.0-beta.0
- @fusion/engine@0.73.0-beta.0
- @fusion/i18n@0.39.31-beta.0
- @fusion-plugin-examples/claude-runtime@0.1.6-beta.0
- @fusion-plugin-examples/cli-printing-press@0.1.48-beta.0
- @fusion-plugin-examples/compound-engineering@0.1.31-beta.0
- @fusion-plugin-examples/dependency-graph@0.1.62-beta.0
- @fusion-plugin-examples/grok-runtime@0.2.9-beta.0
- @fusion-plugin-examples/omp-runtime@0.1.6-beta.0
- @fusion-plugin-examples/quality@0.1.6-beta.0
- @fusion-plugin-examples/roadmap@0.1.50-beta.0
- @fusion-plugin-examples/cursor-runtime@0.1.50-beta.0
- @fusion-plugin-examples/droid-runtime@0.1.57-beta.0
- @fusion-plugin-examples/hermes-runtime@0.2.81-beta.0
- @fusion-plugin-examples/openclaw-runtime@0.2.81-beta.0
- @fusion-plugin-examples/paperclip-runtime@0.2.81-beta.0

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.73.0-beta.0
- @fusion/dashboard@0.73.0-beta.0
- @fusion/engine@0.73.0-beta.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.73.0-beta.0
- @fusion/pi-claude-cli@0.73.0-beta.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.73.0-beta.0

### @runfusion/fusion

#### Minor Changes

- c8b4e23: summary: Quality hub now shows task verification videos when review artifacts are enabled.
  category: feature
  dev: Quality plugin dashboard view reads type="video" executor feature-video artifacts (authorType==="system" && authorId==="executor") via the host /api/artifacts route, gated on effective reviewArtifacts !== "off"; plays them inline via the bridged artifactMediaUrlWithToken helper and opens source tasks through the plugin context openTaskDetail.
- 2302fb8: summary: Add beta and stable release channels — pick your update track in Settings or with `fn update --channel <stable|beta>`.
  category: feature
  dev: New `updateChannel` global setting (default `stable`). Betas are cut from `main` via `pnpm release --channel beta` (changesets pre-mode) to the npm `beta` dist-tag as GitHub prereleases; stable releases are cut from the `release` branch to `latest`. CLI/dashboard/desktop update surfaces share `compareVersions`/`isVersionNewer`/`resolveUpdateTargetVersion` from `@fusion/core` (full SemVer precedence incl. prerelease); installs pin exact versions instead of `@latest`.
- b2a7425: summary: Review gates now run only as workflow nodes — the in-session step reviewer is gone.
  category: internal
  dev: U10/R9 of the IR-driven lifecycle cutover deletes the `fn_review_step` executor tool, its RETHINK git-reset/session-rewind path, the per-step conversation checkpoint map, the deferred reviewer provider-error re-raise channel, and the review-level prompt scaffolding that told the model to call it. Plan/code/browser review are owned exclusively by workflow graph nodes.
- 2c17fa7: summary: Let operators set the embedded PostgreSQL connection cap in Advanced Settings.
  category: feature
  dev: External PostgreSQL runtime pools now default to 3 connections; embedded PostgreSQL reads the global cap on restart.
- b533b91: summary: Add an optional Task chat progress feed for task steps, failures, reviews, and rollbacks.
  category: feature
  dev: Global setting `proactiveTaskChatEnabled` defaults off and gates centralized lifecycle narration.
- 7c23771: summary: Add mailbox approval for ephemeral agent follow-up tasks.
  category: feature
  dev: Adds ephemeralAgentTaskCreationPolicy, stable proposal claim keys, mailbox proposals, and one-click materialization.
- 69e7a34: summary: Add a mission auto-merge override so a mission's features share one branch and one PR.
  category: feature
  dev: MissionManager create/edit tri-state control persists Mission.autoMerge; mission triage stamps task.autoMerge=false when the mission override is false. POST accepts autoMerge and PATCH null clears to inherited.
- e8c37b0: summary: Add guided in-app Bug, Feedback, Idea, and Help reporting.
  category: feature
  dev: Reports are privacy-scrubbed, deduplicated against open GitHub issues, and can be reviewed or filed automatically.
- bcb1256: summary: Add durable configuration revision history primitives.
  category: feature
  dev: Adds PostgreSQL-backed configuration snapshots, target-scoped history reads, and transaction-aware rollback helpers.
- baa1baf: summary: Add portable secret-scrubbed organization export and import commands.
  category: feature
  dev: Adds `fn org-export` and `fn org-import` for one project plus global settings.
- 13f936e: summary: Add review artifact controls and deliverable galleries.
  category: feature
  dev: Adds reviewArtifacts project policy, PROMPT.md override, task eligibility gate, and review deliverable galleries.
- e2b5532: summary: Add reusable native structure preview payloads and dashboard cards.
  category: feature
  dev: Exposes five-kind NativeStructureRef contracts and a callback-based open target for chat and mail consumers.
- bcdad27: summary: Auto-generate a short feature-video artifact for user-facing task deliverables.
  category: feature
  dev: Gated by the reviewArtifacts mode; best-effort playwright-core WebM capture at executor completion is linked by taskId. Loopback-only scenarios; oversize output is rejected and capture failure never fails the task.
- bc4b679: summary: Preview supported missions, findings, evals, and goals directly in chat.
  category: feature
  dev: Chat recognizes strict fusion://<kind>/<id> tokens and assistant Markdown links.
- cf3f5e9: summary: Attach reviewable native structures to mailbox messages.
  category: feature
  dev: Message metadata now carries validated native structure references with lazy previews.
- e30f6d8: summary: Add drag-to-attach native structures and AI narrative drafting to Mail.
  category: feature
  dev: Uses a shared native structure drag protocol and disposable compose-chat sessions.
- 8d1620e: summary: Expose Mission hierarchy tools to engine agents and dashboard chat.
  category: feature
  dev: Uses the project-scoped MissionStore feature-link contract across tool surfaces.
- d51ce46: summary: Add persisted ideation sessions with atomic Mission handoff.
  category: feature
  dev: Adds fn_ideation tools, dashboard Command Center access, and PostgreSQL-backed linkage.
- 38891bf: summary: Request and observe task E2E verification from chat.
  category: feature
  dev: Adds executor-owned verification request/status tools with allowlisted profiles.
- c95e08e: summary: Promote completed research findings into mission roadmap features.
  category: feature
  dev: Persists stable finding and citation provenance with idempotent slice-level promotion.
- 93437ff: summary: Schedule approved mission work with symbol-level concurrency control.
  category: feature
  dev: Enforces mission lineage admission and releases durable symbol locks on lifecycle exits.
- 1f77935: summary: Require approved mission lineage for autonomous task creation and delegation.
  category: feature
  dev: Heartbeat creation and delegation now preserve source feature links while reconciling non-completion outcomes safely.
- 18f1cb7: summary: Let operators choose GitHub Issues or Discussions for in-app reports.
  category: feature
  dev: Adds project and per-action report target settings with optional Discussion category selection.
- 88b0db0: summary: Add scrubbed activity context and optional local report screenshots.
  category: feature
  dev: Screenshots require preview confirmation and never egress to GitHub.
- da1e445: summary: Deduplicate in-app reports against open public-roadmap issues.
  category: feature
  dev: Adds project/global roadmap label and repository resolution settings.
- 500275a: summary: Add consent-based screenshots and activity context to in-app reports.
  category: feature
  dev: Screenshots stay attached to task context locally and are not uploaded to GitHub.
- 7e7c3c9: summary: Add opt-in reviewed screenshots and scrubbed activity traces to in-app reports.
  category: feature
  dev: Uses native Screen Capture API; unavailable screenshot hosting falls back to text-only filing.
- 1215c76: summary: Let operators prevent duplicate in-app reports with optional roadmap matching.
  category: feature
  dev: Adds the project-scoped `reportRoadmapDedup` setting and local `roadmap-match` result.
- a11f789: summary: File Feedback and Help reports as Issues when GitHub Discussions is disabled.
  category: feature
  dev: Reuses the reportDiscussionCategory setting and exposes the final filing destination.
- 4cc8002: summary: Remove the Planning Mode deepening checkpoint and fixed interview depth caps.
  category: breaking
  dev: User validation replaces AI completion and checkpoint-driven finalization.
- 4cc8002: summary: Make Planning Mode an infinite interview validated explicitly by the user.
  category: feature
  dev: Running plans update on every question with normalized alternatives, pros/cons, and Other steering.
- 12aee01: summary: Ideation is now a top-level experimental sidebar/mobile view instead of a Command Center tab.
  category: feature
  dev: `experimentalFeatures.ideationView` is default-off; mobile keeps Ideation More-only, redirects disabled deep links to Board, and removes the Command Center tab.
- d940bf3: summary: Preview roadmap items and open their hosted Roadmaps destination.
  category: feature
  dev: Adds the roadmap-item native structure contract through the plugin PostgreSQL read adapter.
- d4a87ac: summary: Save Settings edits automatically and safely flush pending changes when closing.
  category: fix
  dev: Removes the main Settings footer Save action in favor of debounced persistence and status feedback.
- 2fe1b99: summary: Rebuild Planning Mode into a three-pane interview with always-visible plan and Validate.
  category: feature
  dev: Depends on FN-8341 validate/edit-and-branch contract; adds PATCH /planning/:sessionId/title for rename.
- f6c788d: summary: Dashboard chat agents can edit files and run bash with coding workspace tools.
  category: feature
  dev: Chat sessions keep tools:"coding"; system prompt + tests document write/edit/bash. Permanent-agent gates still apply when bound.
- 2c1567c: summary: Show WhatsApp pairing QR and setup instructions in plugin settings.
  category: feature
  dev: Plugin Manager mounts WhatsAppChatPairingPanel; /status includes pairing data; logout starts fresh QR/code pairing.
- 625dbc6: summary: Planning Mode plan.md is now distinct from triage PROMPT.md on task create.
  category: feature
  dev: Validate+create-task serializes PlanningSummary as plan.md into task.description and task document key=plan; stores session initialPlan as task document key=original-description; triage expands plan.md into PROMPT.md while Original Description stays the operator request. Running plan stays lean (title/description/size/deps/deliverables); priority remains a task field only.
- 36b3180: summary: Simplify Planning Mode to a sequential Q&A and plan-review flow with focus-steered refine.
  category: feature
  dev: Replaces three-pane interview with question → plan_review → refine/validate; refine accepts optional focus text; Validate creates the task; create-task is idempotent per planning session.
- 64c1193: summary: Embed opted-in report screenshots in filed GitHub reports.
  category: feature
  dev: Uploads one validated local report artifact through the GitHub Contents API; private raw URLs require viewer access.
- b2a7425: summary: Your workflow now drives the board — cards move through the columns you defined, not a fixed six.
  category: feature
  dev: The IR-driven lifecycle cutover makes the workflow IR the single authority over task lifecycle. Node column assignments move cards at runtime through the store's trait-hook `moveTask` path (attributed `workflowMoveSource: "workflow-graph"`, emitting `task:column-transition`), replacing the executor's hardcoded `moveTask(id, "in-review")` merge boundary and its handoff-invariant allowlist. Scheduler, hold/release, self-healing, merger and finalization re-key on column traits (`intake`/`hold`/`wip`/`merge-blocker`/`human-review`/`merge`/`complete`/`archived`/`timing`/`abort-on-exit`/`reset-on-entry`/`stall-detection`) instead of literal column ids, with rebound targets resolved per KTD-10. The graph exclusively owns Plan Review — triage's out-of-graph gate is deleted and `pending` step results are CAS-claimed leases (KTD-4), so duplicate reviewers can no longer race. `reviewLevel` becomes a creation-time preset writing `enabledWorkflowSteps` with zero runtime reads. Graph ownership is unconditional: the legacy execute fallback is deleted, `graphCompletion` is a required parameter, and a store that cannot resolve a workflow fails closed rather than silently running nothing. `builtin:coding` keeps its column ids and observable behavior byte-compatible, pinned by a characterization oracle plus a 6-column benchmark acceptance suite that drives a user-authored workflow Ideas -> Todo -> In-progress -> In-review -> Merging -> Done.
- b2a7425: summary: Tasks left mid-flight by an older Fusion are now adopted on upgrade instead of sitting stuck.
  category: feature
  dev: Migration 0026 adds `workflow_ir_pin`/`workflow_ir_pin_node_id`/`workflow_ir_pin_column_id` (KTD-3 durable per-node-entry IR pin) and `legacy_adopted_at` (KTD-8 one-time adoption stamp); SCHEMA_BASELINE_VERSION 0025 -> 0026. `planLegacyAdoption` is the shared decision run by both new consumers — the `adopt-legacy-task-rows` startup step in self-healing (ordered first, emits `task:reconcile-legacy-adoption` / `-unmappable`) and `adoptLegacyTaskRowsOnOpen` in the backend-mode store open path. Adoption stamps only rows it mutates, never disturbs user pauses or preserve gates, and parks unknown statuses `paused` with the status left visible. `assertBinaryNotOlderThanDatabase` refuses to open a database migrated by a newer binary (numeric comparison, unparseable markers ignored).
- a9c7a6b: summary: Store in-app report screenshots as validated local artifacts.
  category: feature
  dev: Replaces inline screenshot egress with the /report/attachment and screenshotArtifactId contract.
- 4a4f231: summary: Preserve parent lineage and reuse duplicate tasks created from planning breakdowns.
  category: feature
  dev: Scopes deterministic task reuse by `sourceParentTaskId` and links API-created children to their parent in task details.

#### Patch Changes

- e4a032d: summary: Show SQLite→PostgreSQL migration status on the dashboard while cutover is not done.
  category: fix
  dev: Wire migration holding plus progress on fn serve and fixed-port daemon; expose durable running or failed migration state through health and dashboard banners.
- baf8893: summary: Stop showing Reconnecting status text in Planning Mode.
  category: fix
  dev: Remove PlanningModeModal isReconnecting UI state and the planning.reconnecting form-hint; generation progress remains via the loading pane only.
- 358b628: summary: Preserve approved task scope during review and committed work during worktree recovery.
  category: fix
  dev: Injects approved PROMPT.md into review gates and reclaims inactive same-task branches before cleanup.
- 9bc0eb6: summary: Prevent retried agent steps from creating duplicate follow-up tasks.
  category: fix
  dev: Persists parent provenance and serializes parent-scoped intent deduplication across task-create surfaces.
- b2a7425: summary: Boards built on custom workflows now show and move cards in their own columns.
  category: fix
  dev: Operator surfaces closed the column set in four places. The dashboard ran every ingested task through `normalizeColumn`, which keeps only the six legacy ids and rewrote everything else to `triage`, so a card in a user-authored column rendered in Triage (new `normalizeColumnId` sanitizes structurally instead). `POST /tasks/:id/move` validated against the `COLUMNS` enum and answered 400 for any workflow-defined column; it now validates against the task's resolved IR and keys worktree allocation on the `wip` trait. Retry / reset / re-engage / unassign / spec-revise moved cards with hardcoded `"todo"`/`"in-progress"`/`"triage"` targets and gated spec revision on `VALID_TRANSITIONS`, all now derived from the task's workflow by trait. GitHub issue open/closed mapping keys on the `complete`/`archived` traits via an injected classifier whose default reproduces the legacy literal mapping. Status badges prefer the running workflow step's IR-declared name over raw engine status tokens.
- b2a7425: summary: Fix built-in workflows sending cards backward to Todo and stalling the PR workflow.
  category: fix
  dev: Unseamed nodes in linear built-ins (`security` in Review-heavy, `design-review` in Design, `review-handoff`/`document` in Compound Engineering) defaulted to the capacity-hold column, so the graph moved live cards back into Todo mid-run; they now inherit the preceding node's column. Separately, the `hold` node kind had no default handler, so every hold node threw "No handler registered" — Pull Request workflow cards died at `await-review`; holds now park in place like `manual-merge-hold`.
- e741833: summary: Fix a crash where chat messages and mailbox sends containing a raw NUL byte would abort mid-conversation.
  category: fix
  dev: PostgreSQL text/jsonb columns reject U+0000 outright ("unsupported Unicode escape sequence" / "\u0000 cannot be converted to text"). Tool output piped into a chat message or agent mailbox send could carry a literal NUL byte and crash addChatMessage/addChatRoomMessage/sendMessage with an uncaught PostgresError. Extracted the existing stripNulChars/deepStripNulChars sanitizer (previously only used by the one-time SQLite migration) into a shared packages/core/src/postgres/nul-sanitize.ts module and wired it into all three live write paths. Also fixes a related embedded-Postgres startup race (JoinedInstanceUnreachableError) where a joiner could hit ECONNREFUSED before the owning process's listener was ready; now retried once, mirroring the existing NonUtf8EmbeddedClusterError retry pattern.
- b1fa2c7: summary: Show Codex weekly usage when OpenAI reports it as the primary quota window.
  category: fix
  dev: Classifies Codex quota windows by their declared duration while preserving legacy response support.
- 4c0dfbc: summary: Prevent review-contract retry instructions from replacing workflow completion summaries.
  category: fix
  dev: Limits approved PROMPT.md contract injection to review-type workflow nodes.
- 7b1a89d: summary: Prevent fn_task_show timeouts when another Fusion process already owns embedded PostgreSQL.
  category: fix
  dev: Reads the port from PostgreSQL's actual postmaster.pid line 4 field before joining the running instance.
- c1bc95c: summary: Honor forced GitHub transport selection for GraphQL discussion queries and mutations.
  category: fix
  dev: Keep Discussion GraphQL operations on the explicitly selected token or gh CLI transport.
- 68a7f3f: summary: Apply planning actions on the first mobile tap and create tasks without a separate validation step.
  category: fix
  dev: Keeps keyboard-backed mobile actions stable through touch activation and removes the planning create validation gate.
- b2a7425: summary: Workflows without a merge step now finish in their completion column instead of stalling one column short.
  category: fix
  dev: `end` is a graph terminal and never a column destination (KTD-1), so a card only entered the `complete`-trait column when a real node lived there — true for merge-bearing workflows via `post-merge-verification`, false for any no-merge workflow (e.g. Lead Generation stranded in `outreach`, never `converted`, which also blocked its dependents). Adds `advanceNoMergeWorkflowToCompleteColumn` on the executor's completed-disposition branch, keyed on the absence of a merge-orchestration column so merge-bearing workflows are untouched and `done` still requires a confirmed merge.
- b2a7425: summary: Fix tasks with no saved workflow selection being unable to move between columns.
  category: fix
  dev: Two resolvers disagreed on the no-selection default IR (catalog `builtin:coding` vs the legacy `BUILTIN_CODING_WORKFLOW_IR` constant), so the move-policy preflight signature never matched and the move threw "workflow move policy preflight is stale". Both sides plus `resolveTaskWorkflowIrSync` now share `resolveDefaultWorkflowIr()`.
- f4c24ed: summary: Allow dependency-ready workflow steps to finalize when earlier independent steps are still running.
  category: fix
  dev: Makes explicit step dependency metadata authoritative for every step-completion writer.
- 2884bf7: summary: Wait for the AI-authored Planning Mode plan before enabling review actions.
  category: fix
  dev: Suppresses seeded fallback summaries from SSE catch-up while a planning generation purpose remains active.
- e81e3bd: summary: Make plan refinement submit reliably from stopped, active, restored, and mobile planning states.
  category: fix
  dev: Uses the visible session identity, stops conflicting turns, and submits mobile refinement on pointer-down.
- 3c22c13: summary: Keep planning timers session-specific and return cleanly from stopped generations.
  category: fix
  dev: Persists each generation's start time and restores the prior planning step when stopped.
- 36583bc: summary: Resume initial planning cleanly after stopping generation and preserve session timers across refreshes.
  category: fix
  dev: Ignores stale stopped streams and prevents draft updates from overwriting active generation metadata.
- 7b444ed: summary: Finish plan task creation automatically and show links to the task or planning sessions.
  category: fix
  dev: Retries transient planning creation claims and keeps a durable success handoff visible.
- 3b7680c: summary: Prevent stale worktree ownership metadata from blocking commits after a pooled checkout is reassigned.
  category: fix
  dev: Refreshes the task identity guard after pooled worktrees switch branches.
- 048ae90: summary: Restore automatic task lifecycle entries in PostgreSQL activity logs.
  category: fix
  dev: Registers TaskStore activity listeners during PostgreSQL backend initialization.
- a3dda8e: summary: Prevent transient dashboard failures when multiple projects initialize PostgreSQL concurrently.
  category: fix
  dev: Uses one advisory-lock order for schema DDL, SQLite cutover, and project identity promotion.
- 02ee8a4: summary: Hide task-card overseer eyes immediately after workflow oversight is turned off.
  category: fix
  dev: Invalidates TaskCard resolution across remounts and authoritative workflow-setting SSE mutations.
- fc24e66: summary: Accept task completion regardless of wording in the completion summary.
  category: fix
  dev: Keeps structural review and bulk-step completion guards while removing prose-based refusals.
- aa40112: summary: Make Windows updates actionable and restore Compound Engineering agent personas in npm installs.
  category: fix
  dev: Extends npm install timeouts to five minutes, preserves timeout causes, and stages CE persona assets.
- fe9269b: summary: Restore the Simplified and Traditional Chinese labels for duplicate roadmap reports.
  category: fix
  dev: Adds the missing report.roadmapDuplicate.title key to the zh-CN and zh-TW catalogs.
- d88e4f9: summary: Hide the task-card overseer eye when a workflow only uses the default (unconfigured) oversight level.
  category: fix
  dev: TaskCard's showPlannerOverseerStateBadge now reuses showOversightBadge, so the transient eye follows the same FN-7539 inherited-default suppression as the oversight-level badge — an autonomous tier reached purely by workflow inheritance (no explicit per-task/workflow override) renders no eye even with a stale non-idle plannerOverseerState. FN-8221/FN-8239/FN-8251 guards are unchanged.
- 377cb9c: summary: Preserve archived shared-branch landing proof during PostgreSQL promotion checks.
  category: fix
  dev: Completes PostgreSQL quarantine rescues and prevents archived landed members from blocking branch-group promotion.
- 2bd25b0: summary: Planning Mode no longer accepts a truncated final plan with empty deliverables.
  category: fix
  dev: parseAgentResponse now rejects truncation-repaired completions; acceptance paths retry or surface a retryable error instead of showing an incomplete checkpoint summary.
- e18c3b4: summary: Oh My Pi (omp) model selections now run via the OMP ACP runtime instead of failing.
  category: fix
  dev: agent-session-helpers auto-derives runtime hint "omp" for omp-cli primary/fallback selections (mirrors the Grok CLI no-visible-key seam); short-circuits under test mode/mock provider, validates an explicit "omp" hint against runtime availability, and prevents the "not found in the pi model registry" hard-fail. Throws an actionable error when the OMP runtime plugin is unavailable.
- ce3f55f: summary: The task-detail oversight eye icon now reflects the session advisor's on/off state even when planner oversight is off.
  category: fix
  dev: TaskDetailModal surfaces and lights the detail-oversight-menu-trigger Eye whenever effectiveSessionAdvisorEnabled (resolveTaskSessionAdvisorEnabled: task override / project sessionAdvisorEnabledByDefault / workflow plannerOverseerAdvisorEnabled) is true, independent of the lifecycle oversight level, and repaints on toggle at both breakpoints.
- b3904f6: summary: Keep workflow chips and HTML mockup previews visually consistent across themes.
  category: fix
  dev: Replace component-level raw white values with explicit workflow-chip and preview-page semantic tokens, protected by the dashboard CSS hygiene scan.
- 2b45567: summary: Mission auto-merge controls now explain merge behavior and show shared branch PR status.
  category: feature
  dev: Mission detail resolves its group from linked task branchContext data and adds engine cascade coverage.
- 119fced: summary: Mobile Kanban swipes now settle on exactly one column with no stuck-between-columns state.
  category: fix
  dev: useColumnScrollSnap suspends native scroll-snap (inline scroll-snap-type:none) during a user pan and restores the x proximity baseline after its JS scroll-end snap, unifying the two magnetism systems from FN-8235; never uses x mandatory (FN-001).
- a6f1ed0: summary: Task detail action buttons now render at a consistent size across all themes.
  category: fix
  dev: Extends the shared --detail-priority-control-min-height / --detail-control-border-radius sizing (FN-7585/FN-7633) to all five .detail-meta-inline-controls controls (attach, GitHub, priority, oversight, execution-mode), pinning a shared height AND square width/min-width so the cluster resolves one uniform square box regardless of theme --space-_/--icon-size-_ tokens.
- 2f0f7c6: summary: Restore token recovery for installed PWAs after an unauthorized backend response.
  category: fix
  dev: Recovery reads the latched daemon-auth failure when the dashboard hook mounts.
- d5db5fd: summary: Foreign-language GitHub/GitLab issues authored via issue forms now auto-translate and offer the Translate button.
  category: fix
  dev: detectContentLanguage now strips issue-form scaffolding line-by-line (headers, standalone bold field-label lines, checkboxes, `_No response_`, HTML comments) and strips only the leading `>` blockquote marker while retaining quoted content, before script/stopword scoring, so form bodies are no longer scored as English and skipped by both the server auto-translate eligibility (isTranslatable) and the client offer path. Stripping is line-scoped so inline bold/list/quote content in ordinary prose (triage/ai-summary inputs) is preserved.
- 40d125b: summary: Move the task-card cost badge below the Promote button in the bottom-right corner.
  category: fix
  dev: Cost chip (card-cost-indicator) now renders below .card-action-row on Promote-bearing cards; non-Promote card placement unchanged.
- 5510745: summary: Planning Mode now always asks clarifying questions before producing a plan.
  category: fix
  dev: createSession/processAgentTurn reject a first-turn completion and no longer suppress the first clarifying question when clarification is disabled.
- e0d2fd6: summary: Resume saved Planning Mode progress after reload without automatically re-running generation.
  category: fix
  dev: Persisted planning errors now restore the manual Retry/Dismiss panel; automatic retry remains live-turn only.
- 0a581f5: summary: Allow manual scrolling during generation in task chat, agent logs, and chat.
  category: fix
  dev: Preserve pinned-bottom follow state across streamed DOM growth and observer callbacks.
- 13540ee: summary: Allow manual scrolling during generation in task Planner Chat.
  category: fix
  dev: Planner Chat now follows streamed output only while the transcript remains pinned near its tail.
- d31a43d: summary: Allow manual scrolling during generation in the task Workflow tab live log.
  category: fix
  dev: Live workflow output now follows only while pinned near the latest entry.
- ed2ffc4: summary: Preserve manual scrolling in System Controls and Dev Server live logs.
  category: fix
  dev: Applies the shared pinned-bottom follow invariant to streamed output tails.
- 9f44f26: summary: Move configuration version history and rollback controls into Settings.
  category: feature
  dev: Configuration revisions now have a Project Settings navigation section.
- 0cba6fa: summary: Move the org export / import card from Command Center Overview to the Team tab.
  category: feature
  dev: OrgPortabilityControls now mounts in TeamArea instead of CommandCenterControls (FN-8351).
- 0400c02: summary: Fix mobile model dropdown so the list stays scrollable after searching.
  category: fix
  dev: CustomModelDropdown portaled list retains touch-scroll ownership after filter + visualViewport reposition.
- 0dbe67c: summary: Fix tasks stuck on "Needs your decision" when their duplicate is already done.
  category: fix
  dev: Adds the task:reconcile-stale-duplicate-decision self-healing audit event.
- 41f387b: summary: Fix task token counts inflated by reused or resumed agent sessions.
  category: fix
  dev: Task-scoped session baseline snapshots now persist only in-task usage deltas.
- 3e376b9: summary: Fix GitHub issue imports so edited descriptions cannot hide or falsely match prior imports.
  category: fix
  dev: Centralizes provenance-first deduplication for dashboard, CLI, and extension issue imports.
- d768501: summary: Fix dashboard build failure caused by missing html2canvas dependency.
  category: fix
  dev: Add html2canvas@^1.4.1 to @fusion/dashboard deps (bundled types) so app/utils/capture-screenshot.ts resolves.
- e04608d: summary: Task detail inline action icons now render at a consistent size on tablet screens.
  category: fix
  dev: Scoped the .detail-meta-inline-controls SVG sizing so every inline-row icon (including nested ProviderIcon SVGs) resolves to the shared --icon-size-sm token at desktop, tablet (769–1024px), and mobile. No handler/behavior changes; preserves the icon-only row, square-box sizing, size-prop-less oversight Eye/EyeOff, and the mobile wrap fallback.
- e22c65a: summary: Separate pinned chat conversations in the list and fix message edit Save.
  category: fix
  dev: ChatView now renders named Pinned and Recent sections on desktop and mobile; async message Save prevents duplicate rewind-and-resend operations.
- 48ff33e: summary: Show Compound Engineering in navigation when the enabled plugin starts.
  category: fix
  dev: Refresh project-scoped dashboard views after plugin lifecycle events and prevent project view leakage.
- 3b82201: summary: Preserve task work while recovering checkouts created outside the configured worktree directory.
  category: fix
  dev: Relocates reclaimable Git worktrees into the configured root before executor liveness validation.
- 104bf69: summary: Same-agent near-duplicates stay on the board by default on all create paths (no silent auto-archive).
  category: fix
  dev: Aligns PostgreSQL createTaskBackend same-agent intake with FN-7658 flagSameAgentDuplicate; removes divergent delete-on-match backend path; keeps sticky tombstone near-duplicate blocking on both backends.
- 365874f: summary: Fix Report menu stacking and move Command Center reports to System.
  category: fix
  dev: Define --z-dropdown/--z-modal; Overview report card removed; System uses guided ReportActionMenu.
- 76ec2b4: summary: Restore Settings Configuration Versions translations for es/fr/ko/zh-CN/zh-TW after FN-8350 key move.
  category: fix
  dev: Relocate secondary catalogs from commandCenter.portability.versions to settings.configVersions and settings.nav.configVersions.
- ddd1316: summary: Install @agentclientprotocol/sdk with @runfusion/fusion so the Claude CLI pi extension can load.
  category: fix
  dev: FN-8413 / issue #2355 — nested dist/pi-claude-cli/package.json declared the SDK but npm only installs root dependencies; pin remains 0.24.0 (do not bump to 1.x).
- 8d5c3b0: summary: Fix mission interview start crashing when thinking level is left at Default.
  category: fix
  dev: Retire createMissionInterviewSession positional overload; resolve planning thinkingLevel from settings when body omits it; preserve projectId/pluginRunner binding (GitHub #2356 / FN-8414).
- 9e962bb: summary: Scrub top-level report activityTrace before filing so paths and tokens never reach the pipeline.
  category: security
  dev: /api/report/file now runs scrubReportPayload on raw.activityTrace before parseInput/runReportPipeline; route regression in report-routes.test.ts.
- 4f0d89e: summary: Fix startup crash when a project has both fallback and registered partition data.
  category: fix
  dev: Rekey merges catalog-discovered dual partition conflicts fallback-wins with NULL-correct matching and fail-closed FK checks; startup degrades to fallback data and unique failures stop supervised retry loops.
- 8166c80: summary: Keep Planning Mode interviews open until you explicitly validate the running plan.
  category: fix
  dev: Preserves the active three-pane workspace across summary, loading, and recoverable-error events.
- 5763622: summary: Task detail Oversight/Fast and chat send heights match sibling controls on tablet.
  category: fix
  dev: Completes FN-8287 class wiring on attach/github/priority; aliases detail shared square to Quick Add compact height tokens; equalizes Planner Chat input/send block size for tablet/desktop.
- 5af53bc: summary: Fix Grok and Claude Fusion tools MCP bridge packaging and model markers
  category: fix
  dev: Co-locate mcp-schema-server.cjs, report fixed bridge outcomes, and normalize ACP model markers.
- 02f8bff: summary: Show only one agent name badge when a task is assigned to its creator.
  category: fix
  dev: TaskCard suppresses redundant created-by pill when assigned and source agent identity match by ID-first rules (FN-8423).
- 3962222: summary: Return CLI chat replies to the terminal and expose dashboard inbox reads.
  category: fix
  dev: Reply routing now validates parent ownership, polls with deadline-aware sleeps, tracks interactive pending replies, and supports `fn message inbox --user dashboard`.
- 9db0ffc: summary: Make fn chat a named mailbox conversation with a stable conversation id.
  category: fix
  dev: Stamps MessageStore sends with kind=cli-chat + conversationId; honest help/docs; fn_read_messages surfaces conversation id.
- 8993e91: summary: Make Planning Mode usable on mobile and tablet with progressive interview layout.
  category: fix
  dev: Reflows FN-8400/FN-8420 three-pane Planning Mode via viewport progressive disclosure (incl. short landscape); no API contract change.
- 1b8b7f6: summary: Keep workflow tasks paused while an agent question is awaiting an operator response.
  category: fix
  dev: Converts supported runtime question-tool calls into the durable workflow await-input contract.
- bd55846: summary: Restore mobile navigation back to the Planning session list without a stuck Running plan screen.
  category: fix
  dev: Hide RunningPlanPane in list mode; ensure Back/Sessions on non-list mobile Planning surfaces.
- 81abe53: summary: Stop the dashboard TUI Logs tab from showing detailed timestamps on each log line.
  category: fix
  dev: Compact LogsPanel time to HH:MM:SS; strip leading YYYY-MM-DD HH:MM:SS.mmm TZ prefixes from displayed messages (e.g. embedded Postgres logs).
- 8d216e6: summary: Give the Report menu an opaque background so page content no longer shows through.
  category: fix
  dev: Replace undefined --bg-elevated/--text-primary/--bg-hover and numeric space aliases in ReportActionMenu.css with defined --card/--text/--surface-hover/--space-\* tokens (FN-6862 class of bug).
- 76822d8: summary: Planning Mode tablet tabs match mobile; mobile main shows sessions before running plan.
  category: fix
  dev: Assert compact interview tab parity and gate Running plan to intentional session detail navigation.
- e43dffa: summary: Planning Mode running plan shows an evolving plan, not repeated interview questions.
  category: fix
  dev: Fix buildRunningSummary + agent turn merge so summary keyDeliverables/description are plan-quality; preserve model plan fields when coercing complete payloads.
- 8c01cc7: summary: Restore in-progress Planning Mode interviews after leave/return, including mid-generation.
  category: fix
  dev: Persists last-active planning session id project-scoped; remount rehydrates via loadSession without auto-retry.
- f9c1620: summary: Planning Mode now drafts an initial running plan from your idea and refines it after each answer.
  category: fix
  dev: Strengthens first-turn and per-answer runningPlan generation and recovers when a turn omits plan fields.
- 8c34798: summary: Planning Mode now uses the same workflow triage planning prompt template as newly added tasks.
  category: fix
  dev: Resolves Planning Mode from the workflow planning seam plus JSON interview adapter; explicit planning-system overrides still replace it fully.
- 00891c2: summary: Persist operator duplicate decisions so Fusion does not re-ask for the same task.
  category: fix
  dev: Honor nearDuplicateDismissed for the same nearDuplicateOf across triage finalize and explicit-marker self-healing (FN-8440).
- df488f2: summary: Deliver enabled plugin skills in dashboard chat the same way task sessions do (include skill body paths).
  category: fix
  dev: Chat and room-responder sessions now forward buildSessionSkillContextSync.additionalSkillPaths into createResolvedAgentSession so the pi loader can discover plugin SKILL.md bodies (GitHub #2364 / FN-8443; completes chat half of #2017).
- 1d4e8af: summary: Include planning-lane AI time and tokens in task cost and duration totals.
  category: fix
  dev: Adds cumulativePlanningMs and planningStartedAt; Stats now says Total active time.
- 22db40c: summary: Keep Planning Mode compact interview view tabs pinned to the top on Answered questions.
  category: fix
  dev: Compact column order/CSS pin for .planning-compact-pane-switcher under history pane (FN-8445).
- 5dd62fe: summary: Keep dismissed GitHub Copilot re-login banners hidden permanently.
  category: fix
  dev: OAuthReloginBanner preserves the github-copilot dismissal across polling and successful-login events; other providers still re-arm after successful re-login.
- 048a2cd: summary: Android and browser Back from a GitHub import detail returns to the issue list first.
  category: fix
  dev: Nested import detail history entry (FN-8228 seam) fixed so first Back clears selection on modal and embedded Import Tasks surfaces.
- 6d6bfdf: summary: Planning Mode history now collapses AI thinking by default.
  category: fix
  dev: PlanningModeModal history panel omits defaultShowThinking so ConversationHistory keeps blocks collapsed until expanded (FN-8449).
- e4ddfe0: summary: Keep Grok ACP process cleanup armed once per process, without listener growth.
  category: fix
  dev: Move Symbol.for process.exit reaper onto process-manager; lifecycle tests reimport that module instead of the full plugin graph under full-suite load.
- 9ad9731: summary: Prevent unfinished prose-only plans from advancing into implementation and merge.
  category: fix
  dev: Requires explicit no-commits authorization before a parsed workflow may continue with zero implementation steps.
- beae2c6: summary: Improve Planning Mode refinement and replace Validate with Proceed with plan.
  category: fix
  dev: Combines suggested and custom focus areas and restores questions from synchronous refinement responses.
- 34074e9: summary: Add mobile Planning tabs, one-click task creation, and answer/reasoning history.
  category: fix
  dev: Adds history, responsive planning lanes, freeform refinement, compact headers, and stable session restoration.
- b4c1a1a: summary: Keep tasks running when an MCP server is temporarily unavailable.
  category: fix
  dev: Retries MCP bootstrap three times, then continues without servers that remain unavailable or lack resolved secrets.
- 2ab0413: summary: Keep OMP ACP process cleanup armed once per process, without listener growth.
  category: fix
  dev: Mirror grok-runtime — Symbol.for process.exit reaper on process-manager; lifecycle stress test reimports that module under full-suite load.
- 50454d8: summary: Prevent Plan Review tasks from blocking each other after a missing-worktree fallback.
  category: fix
  dev: Releases the exact workflow-step session path after repository-root Plan Review fallback.
- 606c320: summary: Make Planning Mode generate a durable initial plan before asking optional refinement questions.
  category: fix
  dev: Persists generation purpose, adds detailed change/acceptance sections and suggested focuses, and deduplicates Other.
- 02e297a: summary: Keep Planning Mode questions and the running plan in sync after each answer.
  category: fix
  dev: Mid-interview SSE no longer terminalizes on running summary; client ignores stale answered questions and reconciles submit failures against server state.
- 0a01cb1: summary: Improve Planning Mode with scrollable Markdown plans and mobile bottom actions.
  category: fix
  dev: Uses the canonical plan.md formatter for the sanitized review preview and pins actions outside its scroll owner.
- 90b9feb: summary: Report PostgreSQL health failures accurately without false database-corruption guidance.
  category: fix
  dev: Makes migration-marker reads non-mutating and treats marker permission failures as advisory.
- 74de68a: summary: Prevent agents from filing duplicate active diagnostic follow-ups discovered by different tasks.
  category: fix
  dev: Adds narrow code-identifier-based cross-parent deduplication while preserving distinct and completed work.
- c0cce18: summary: Close the Quick Add agent picker when clicking outside it.
  category: fix
  dev: Capture-phase mousedown listener plus open-token so late fetchAgents cannot re-open a dismissed portal.
- cf1a599: summary: Stop active task processing before a user move to Todo becomes visible.
  category: fix
  dev: User-driven in-progress-to-Todo transitions now await every executor cancellation surface before persistence.
- 71c0d0a: summary: Prevent Plan Review replans from stranding completed tasks in Triage and recover affected tasks automatically.
  category: fix
  dev: Preserves graph ownership during executor-authored replan moves and clears stale same-task session claims during recovery.
- ba08d90: summary: Stop PostgreSQL permission errors when the dashboard reads SQLite migration health.
  category: fix
  dev: Grants the project-bound runtime role row-scoped read access to the SQLite migration ledger.
- ecffdbb: summary: Isolate automated tests and global test-mode runs from the normal Fusion database.
  category: fix
  dev: Adds dedicated FUSION_TEST_DATABASE_URL routing with a separate embedded test cluster fallback.
- a8e1393: summary: Prevent concurrent tasks from falling back when an Anthropic OAuth token rotates.
  category: fix
  dev: Serializes Anthropic refresh-token rotation across auth storage instances and Fusion processes.
- b2a7425: summary: A custom Merging column now receives the card at merge instead of being sent to In-review.
  category: fix
  dev: The workflow graph collapses the merge region into one seam recorded as node `merge`, but that synthetic node hardcoded `column: "in-review"`, so a user-authored workflow placing its merge nodes in a different column (e.g. `Merging`) had the card moved to `in-review` — a column such a workflow need not even declare. The column now derives from the merge-region node actually being entered, falling back to `in-review` so `builtin:coding` stays byte-identical. Caught by the new 6-column benchmark acceptance test.
- 237d9be: summary: Hide empty chat verification status and move active results below task metadata.
  category: fix
  dev: Keeps task details focused on actionable verification state.
- d008d66: summary: Show every suggested Planning Mode refinement category instead of limiting choices to three.
  category: fix
  dev: Removes prompt, server-normalization, and client-normalization caps on suggested refinements.

### runfusion.ai

#### Patch Changes

- Updated dependencies [c8b4e23]
- Updated dependencies [e4a032d]
- Updated dependencies [baf8893]
- Updated dependencies [2302fb8]
- Updated dependencies [358b628]
- Updated dependencies [9bc0eb6]
- Updated dependencies [b2a7425]
- Updated dependencies [b2a7425]
- Updated dependencies [2c17fa7]
- Updated dependencies [b2a7425]
- Updated dependencies [e741833]
- Updated dependencies [b1fa2c7]
- Updated dependencies [4c0dfbc]
- Updated dependencies [7b1a89d]
- Updated dependencies [b533b91]
- Updated dependencies [c1bc95c]
- Updated dependencies [68a7f3f]
- Updated dependencies [b2a7425]
- Updated dependencies [b2a7425]
- Updated dependencies [f4c24ed]
- Updated dependencies [2884bf7]
- Updated dependencies [e81e3bd]
- Updated dependencies [3c22c13]
- Updated dependencies [36583bc]
- Updated dependencies [7b444ed]
- Updated dependencies [3b7680c]
- Updated dependencies [048ae90]
- Updated dependencies [a3dda8e]
- Updated dependencies [02ee8a4]
- Updated dependencies [fc24e66]
- Updated dependencies [aa40112]
- Updated dependencies [fe9269b]
- Updated dependencies [d88e4f9]
- Updated dependencies [377cb9c]
- Updated dependencies [2bd25b0]
- Updated dependencies [e18c3b4]
- Updated dependencies [ce3f55f]
- Updated dependencies [7c23771]
- Updated dependencies [b3904f6]
- Updated dependencies [69e7a34]
- Updated dependencies [2b45567]
- Updated dependencies [119fced]
- Updated dependencies [e8c37b0]
- Updated dependencies [bcb1256]
- Updated dependencies [baa1baf]
- Updated dependencies [13f936e]
- Updated dependencies [a6f1ed0]
- Updated dependencies [e2b5532]
- Updated dependencies [bcdad27]
- Updated dependencies [bc4b679]
- Updated dependencies [cf3f5e9]
- Updated dependencies [e30f6d8]
- Updated dependencies [8d1620e]
- Updated dependencies [d51ce46]
- Updated dependencies [38891bf]
- Updated dependencies [c95e08e]
- Updated dependencies [2f0f7c6]
- Updated dependencies [d5db5fd]
- Updated dependencies [93437ff]
- Updated dependencies [1f77935]
- Updated dependencies [18f1cb7]
- Updated dependencies [88b0db0]
- Updated dependencies [da1e445]
- Updated dependencies [500275a]
- Updated dependencies [7e7c3c9]
- Updated dependencies [40d125b]
- Updated dependencies [1215c76]
- Updated dependencies [a11f789]
- Updated dependencies [5510745]
- Updated dependencies [e0d2fd6]
- Updated dependencies [0a581f5]
- Updated dependencies [4cc8002]
- Updated dependencies [4cc8002]
- Updated dependencies [13540ee]
- Updated dependencies [d31a43d]
- Updated dependencies [ed2ffc4]
- Updated dependencies [9f44f26]
- Updated dependencies [0cba6fa]
- Updated dependencies [12aee01]
- Updated dependencies [0400c02]
- Updated dependencies [0dbe67c]
- Updated dependencies [d940bf3]
- Updated dependencies [41f387b]
- Updated dependencies [3e376b9]
- Updated dependencies [d768501]
- Updated dependencies [d4a87ac]
- Updated dependencies [e04608d]
- Updated dependencies [e22c65a]
- Updated dependencies [48ff33e]
- Updated dependencies [2fe1b99]
- Updated dependencies [3b82201]
- Updated dependencies [104bf69]
- Updated dependencies [365874f]
- Updated dependencies [f6c788d]
- Updated dependencies [76ec2b4]
- Updated dependencies [ddd1316]
- Updated dependencies [8d5c3b0]
- Updated dependencies [9e962bb]
- Updated dependencies [2c1567c]
- Updated dependencies [4f0d89e]
- Updated dependencies [8166c80]
- Updated dependencies [5763622]
- Updated dependencies [5af53bc]
- Updated dependencies [02f8bff]
- Updated dependencies [3962222]
- Updated dependencies [9db0ffc]
- Updated dependencies [8993e91]
- Updated dependencies [1b8b7f6]
- Updated dependencies [bd55846]
- Updated dependencies [81abe53]
- Updated dependencies [8d216e6]
- Updated dependencies [76822d8]
- Updated dependencies [e43dffa]
- Updated dependencies [8c01cc7]
- Updated dependencies [f9c1620]
- Updated dependencies [8c34798]
- Updated dependencies [00891c2]
- Updated dependencies [625dbc6]
- Updated dependencies [36b3180]
- Updated dependencies [df488f2]
- Updated dependencies [1d4e8af]
- Updated dependencies [22db40c]
- Updated dependencies [5dd62fe]
- Updated dependencies [048a2cd]
- Updated dependencies [6d6bfdf]
- Updated dependencies [64c1193]
- Updated dependencies [e4ddfe0]
- Updated dependencies [9ad9731]
- Updated dependencies [beae2c6]
- Updated dependencies [34074e9]
- Updated dependencies [b2a7425]
- Updated dependencies [b2a7425]
- Updated dependencies [b4c1a1a]
- Updated dependencies [2ab0413]
- Updated dependencies [50454d8]
- Updated dependencies [606c320]
- Updated dependencies [02e297a]
- Updated dependencies [0a01cb1]
- Updated dependencies [90b9feb]
- Updated dependencies [74de68a]
- Updated dependencies [c0cce18]
- Updated dependencies [cf1a599]
- Updated dependencies [71c0d0a]
- Updated dependencies [ba08d90]
- Updated dependencies [a9c7a6b]
- Updated dependencies [ecffdbb]
- Updated dependencies [a8e1393]
- Updated dependencies [b2a7425]
- Updated dependencies [237d9be]
- Updated dependencies [4a4f231]
- Updated dependencies [d008d66]
  - @runfusion/fusion@0.73.0-beta.0

## 0.72.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.72.0
- @fusion/engine@0.72.0
- @fusion/i18n@0.39.30
- @fusion-plugin-examples/claude-runtime@0.1.5
- @fusion-plugin-examples/cli-printing-press@0.1.47
- @fusion-plugin-examples/compound-engineering@0.1.30
- @fusion-plugin-examples/dependency-graph@0.1.61
- @fusion-plugin-examples/grok-runtime@0.2.8
- @fusion-plugin-examples/omp-runtime@0.1.5
- @fusion-plugin-examples/quality@0.1.5
- @fusion-plugin-examples/roadmap@0.1.49
- @fusion-plugin-examples/cursor-runtime@0.1.49
- @fusion-plugin-examples/droid-runtime@0.1.56
- @fusion-plugin-examples/hermes-runtime@0.2.80
- @fusion-plugin-examples/openclaw-runtime@0.2.80
- @fusion-plugin-examples/paperclip-runtime@0.2.80

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.72.0
- @fusion/dashboard@0.72.0
- @fusion/engine@0.72.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.72.0
- @fusion/pi-claude-cli@0.72.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.72.0

### @runfusion/fusion

#### Minor Changes

- 26054de: summary: The OpenAI Codex subscription sign-in now appears in onboarding quick start, right after the Anthropic subscription.
  category: feature
  dev: "ModelOnboardingModal QUICK_START_PROVIDER_IDS: openai-codex inserted between anthropic-subscription and anthropic-api-key; previously it was only reachable under Advanced."
- c7b1529: summary: Project creation warns when Git is missing, with install or create-anyway options.
  category: feature
  dev: "SetupWizardModal probes gitCli before registering and shows a three-way ConfirmDialog (create anyway / open downloads / cancel; clone mode offers install-only). New skipGitInit passthrough: ProjectCreateInput → POST /api/projects (rejected for clone mode) → EnsureProjectForPathInput → ensureProjectForPath skips ensureGitRepositoryForProjectPath."
- c4a00d7: summary: The Windows desktop close dialog now offers Minimize to tray, keeping Fusion and the embedded PostgreSQL running in the background.
  category: feature
  dev: "win32 close dialog gains a Minimize to tray default alongside Exit-and-stop-PostgreSQL / Exit-leave-it-running (or a two-button variant when no embedded runtime is active); tray click restores the window. OS session end still skips dialogs and performs the full stop."
- 7550637: summary: Closing the Windows desktop app now asks whether to also shut down the embedded PostgreSQL server.
  category: feature
  dev: "User-initiated window close on win32 shows a sync dialog (default: shut down); 'leave it running' skips only the embedded-cluster teardown in stopLocal({keepEmbeddedPostgres}) so pools/runtime still close. Programmatic quits (dashboard restart) never prompt and keep the full stop."

#### Patch Changes

- 7bf83bb: summary: OAuth sign-ins (OpenAI Codex and others) now reliably open the system browser from the desktop app.
  category: fix
  dev: "window.open after the /auth/login await can outlive Chromium's transient user activation (~5s) and get silently popup-blocked on desktop — Codex's slower flow (method select + localhost callback server) hit this while Anthropic's usually didn't. New shell:openExternal IPC (http/https-validated) + preload openExternal + dashboard openExternalUrl helper used by all auth-URL opens, with window.open fallback on web."
- b60833c: summary: Creating a folder in project setup now selects it so Select confirms it.
  category: fix
  dev: "DirectoryPicker: with selectCreatedDirectory, handleCreateFolder now navigates the browse panel into the created directory instead of refreshing the parent; the footer Select button commits browser.currentPath, so staying on the parent let the next click overwrite the auto-selected new folder."
- 95e011f: summary: Fusion now auto-repairs embedded PostgreSQL clusters left in the non-UTF-8 encoding state by earlier versions.
  category: fix
  dev: "Issue #2286 follow-up: on the encoding-conversion schema failure, the startup factory proves the embedded cluster is non-UTF-8 AND empty (no tables in project/central/archive, no recorded migrations — guaranteed for affected installs since the baseline never applied) and that this process owns the postmaster, then deletes the data dir and re-boots once with the UTF-8 initdb defaults. Joined instances and any non-proven state keep the manual re-init hint."
- d4ee80a: summary: Embedded PostgreSQL clusters are now always created UTF-8, fixing dashboard crash-loops on non-UTF-8 Windows locales.
  category: fix
  dev: "GitHub issue #2286: initdb inherited the OS locale encoding (e.g. Turkish WIN1254, English WIN1252), so the UTF-8 schema SQL failed with 'character has no equivalent in encoding'. DEFAULT_EMBEDDED_INITDB_FLAGS now forces --encoding=UTF8 --locale=C on every platform (caller flags appended after, so overridable). Not retroactive: existing non-UTF-8 clusters must delete ~/.fusion/embedded-postgres/default; the schema-apply failure now says exactly that, and boot errors include the full error cause chain instead of dropping it."
- 38c6fdc: summary: Keep floating windows stacked by last-opened and last-interacted order.
  category: fix
  dev: FloatingWindow only reclaims z-index on hidden→visible (not every mount effect), restoring shared-stack cross-type ordering with RightDockExpandModal.
- 924e0df: summary: Git installed while Fusion runs is detected without restart for project setup.
  category: fix
  dev: "New core git-binary resolver: on PATH ENOENT, probes well-known install locations (win32 Program Files/LocalAppData Git\\cmd, macOS homebrew//usr/local//usr/bin, linux /usr/bin//usr/local/bin) with caching + invalidation on later ENOENT. Wired into ensureGitRepositoryForProjectPath's runner, probeGitCliStatus (onboarding git indicator), and the dashboard clone route."
- 6cdebe1: summary: Links on the onboarding GitHub setup step now follow the dashboard theme instead of default browser blue.
  category: fix
  dev: "ModelOnboardingModal.css: GitHub-step anchors (non-.btn) get color var(--color-info) + hover underline; layout rules unchanged."
- 68ce5c3: summary: Hardening pass over the onboarding, git-preflight, and Windows Postgres lifecycle features from this cycle's review.
  category: fix
  dev: "Uninstaller kills only the first (numeric) postmaster.pid line; git-missing dialogs render even with skip-confirmations (new ConfirmOptions.alwaysAsk); quit prompt only for embedded-local runtimes and skipped during OS session end; 'leave it running' now disarms the embedded lifecycle's process shutdown hook (detachKeepingEmbedded); wizard double-submit guard; clone route ENOENT invalidate-and-retry; openExternalUrl drops the always-popup-blocked async window.open fallback; DirectoryPicker closes the panel if listing the created folder fails; git status probe bounded to two spawns."
- d4ee80a: summary: Elevated Windows boots embedded PostgreSQL without a local fusion-pg account; leftovers are cleaned up.
  category: fix
  dev: "Replaces the Start-Process -Credential non-admin-user launcher with pg_ctl's built-in restricted-token re-exec (embedded-windows-elevated.ts). Removes user creation, icacls grants, and the cmd/PowerShell wrapper — also eliminating the 'directory name is invalid' launch failure and the EBUSY on wrapper-held postgres.log. The elevated path now best-effort deletes a legacy fusion-pg account on start."
- fd87c3f: summary: Fix elevated Windows desktop boot failing with "The directory name is invalid" when starting embedded PostgreSQL.
  category: fix
  dev: "Start-Process -Credential (CreateProcessWithLogonW) validates the working directory as the target non-admin user; the launcher inherited the desktop app's cwd (admin profile / install dir) which fusion-pg cannot access. launch.ps1 now pins -WorkingDirectory to the granted .pgrunner run dir, passed as a -File param (buildNonAdminLauncherPs1 in packages/core embedded-windows-admin.ts)."

### runfusion.ai

#### Patch Changes

- Updated dependencies [26054de]
- Updated dependencies [7bf83bb]
- Updated dependencies [b60833c]
- Updated dependencies [95e011f]
- Updated dependencies [d4ee80a]
- Updated dependencies [38c6fdc]
- Updated dependencies [c7b1529]
- Updated dependencies [924e0df]
- Updated dependencies [6cdebe1]
- Updated dependencies [68ce5c3]
- Updated dependencies [c4a00d7]
- Updated dependencies [d4ee80a]
- Updated dependencies [fd87c3f]
- Updated dependencies [7550637]
  - @runfusion/fusion@0.72.0

## 0.71.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.71.0
- @fusion/engine@0.71.0
- @fusion/i18n@0.39.29
- @fusion-plugin-examples/claude-runtime@0.1.4
- @fusion-plugin-examples/cli-printing-press@0.1.46
- @fusion-plugin-examples/compound-engineering@0.1.29
- @fusion-plugin-examples/dependency-graph@0.1.60
- @fusion-plugin-examples/grok-runtime@0.2.7
- @fusion-plugin-examples/omp-runtime@0.1.4
- @fusion-plugin-examples/quality@0.1.4
- @fusion-plugin-examples/roadmap@0.1.48
- @fusion-plugin-examples/cursor-runtime@0.1.48
- @fusion-plugin-examples/droid-runtime@0.1.55
- @fusion-plugin-examples/hermes-runtime@0.2.79
- @fusion-plugin-examples/openclaw-runtime@0.2.79
- @fusion-plugin-examples/paperclip-runtime@0.2.79

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.71.0
- @fusion/dashboard@0.71.0
- @fusion/engine@0.71.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.71.0
- @fusion/pi-claude-cli@0.71.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.71.0

### @runfusion/fusion

#### Minor Changes

- 0b6c4cd: summary: Show live database-migration progress during boot — dashboard holding page/banner and desktop launch screen.
  category: feature
  dev: CLI binds a temporary holding server on the dashboard port during `createTaskStoreForBackend` (new `onMigrationProgress` option) serving an auto-reloading page + `/api/health` `status:"migrating"`; open tabs render `MigrationInProgressBanner` from the health poll. Desktop publishes progress via `DesktopRuntimeStatus.migration` → IPC → `DesktopLaunchGate`, which shows the label and suspends its 30s timeout while progress advances.

#### Patch Changes

- 48b0d04: summary: Fix first-boot SQLite→PostgreSQL migration failing on legacy data containing NUL (\u0000) characters.
  category: fix
  dev: The migrator now strips U+0000 from plain text cells, JSON string values/keys, malformed-JSON scalars, and opaque legacy-preservation cells before insert; content-checksum verification compares sanitized source against sanitized target.

### runfusion.ai

#### Patch Changes

- Updated dependencies [0b6c4cd]
- Updated dependencies [48b0d04]
  - @runfusion/fusion@0.71.0

## 0.70.2

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.70.2
- @fusion/engine@0.70.2
- @fusion/i18n@0.39.28
- @fusion-plugin-examples/claude-runtime@0.1.3
- @fusion-plugin-examples/cli-printing-press@0.1.45
- @fusion-plugin-examples/compound-engineering@0.1.28
- @fusion-plugin-examples/dependency-graph@0.1.59
- @fusion-plugin-examples/grok-runtime@0.2.6
- @fusion-plugin-examples/omp-runtime@0.1.3
- @fusion-plugin-examples/quality@0.1.3
- @fusion-plugin-examples/roadmap@0.1.47
- @fusion-plugin-examples/cursor-runtime@0.1.47
- @fusion-plugin-examples/droid-runtime@0.1.54
- @fusion-plugin-examples/hermes-runtime@0.2.78
- @fusion-plugin-examples/openclaw-runtime@0.2.78
- @fusion-plugin-examples/paperclip-runtime@0.2.78

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.70.2
- @fusion/dashboard@0.70.2
- @fusion/engine@0.70.2

### @fusion/engine

#### Patch Changes

- @fusion/core@0.70.2
- @fusion/pi-claude-cli@0.70.2

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.70.2

### @runfusion/fusion

#### Patch Changes

- 4970465: summary: Fix npm-installed CLI crashing at startup because PostgreSQL migrations were missing from the published package.
  category: fix
  dev: "tsup stages packages/core/src/postgres/migrations into dist/migrations, but the package files globs (dist/**/_.js, _.d.ts, maps, named dirs) matched no .sql file, so npm pack stripped every migration from the tarball. Installed CLIs failed schema init with ENOENT dist/migrations/0000_initial.sql and the dashboard supervisor crash-looped. Added dist/migrations/** to files; npm pack --dry-run now lists all 21 migration files. Sibling of the desktop staging fix 6e5bb5d3d."
- c831ccb: summary: Ship the plugin registry manifest and llama.cpp extension in the published npm package.
  category: fix
  dev: "Tarball-completeness audit follow-ups to the migrations fix: (1) dist/pi-llama-cpp was staged by tsup but matched no files glob, so useLlamaCpp silently reported not-installed in every published build — added dist/pi-llama-cpp/\*\* to files. (2) dashboard plugin-routes resolves ./registry-manifest.json beside the bundled bin.js but it was never staged into the CLI dist, so published installs served an empty plugin registry — tsup now stages it from packages/dashboard/src and files includes dist/registry-manifest.json."
- 90a1a4b: summary: Ship the child-process runtime worker so isolationMode "child-process" works from npm installs.
  category: fix
  dev: New tsup entry emits dist/child-process-worker.js beside bin.js, matching the engine's getWorkerPath() sibling resolution; bundled with bin.js's noExternal/external/banner shape.
- 6b893f7: summary: Fix the standalone `fn` binary failing to boot in both embedded-Postgres and DATABASE_URL modes.
  category: fix
  dev: Migrations now resolve via FUSION_MIGRATIONS_DIR > module-relative > execPath-relative; embedded-postgres ships as a self-contained bundle + native payload under runtime/<platform>/embedded-postgres (override root with FUSION_EMBEDDED_PG_RUNTIME_DIR); releases add self-contained fn-cli-<platform>.tar.gz assets.
- 8517a5d: summary: Fix embedded PostgreSQL failing to start on Windows after the mmap shared-memory default.
  category: fix
  dev: "shared_memory_type=mmap (default added 2026-07-16 for SysV shm exhaustion) is rejected on Windows, where the only valid value is windows — every Windows embedded start died with FATAL invalid value for parameter before the port opened, failing the v0.70.0/v0.70.1 Windows release smoke. Default flags are now platform-aware via defaultEmbeddedPostgresFlagsFor: empty on win32 (Windows needs no override; SysV exhaustion cannot occur there), mmap elsewhere."

### runfusion.ai

#### Patch Changes

- Updated dependencies [4970465]
- Updated dependencies [c831ccb]
- Updated dependencies [90a1a4b]
- Updated dependencies [6b893f7]
- Updated dependencies [8517a5d]
  - @runfusion/fusion@0.70.2

## 0.70.1

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.70.1
- @fusion/engine@0.70.1
- @fusion/i18n@0.39.27
- @fusion-plugin-examples/claude-runtime@0.1.2
- @fusion-plugin-examples/cli-printing-press@0.1.44
- @fusion-plugin-examples/compound-engineering@0.1.27
- @fusion-plugin-examples/dependency-graph@0.1.58
- @fusion-plugin-examples/grok-runtime@0.2.5
- @fusion-plugin-examples/omp-runtime@0.1.2
- @fusion-plugin-examples/quality@0.1.2
- @fusion-plugin-examples/roadmap@0.1.46
- @fusion-plugin-examples/cursor-runtime@0.1.46
- @fusion-plugin-examples/droid-runtime@0.1.53
- @fusion-plugin-examples/hermes-runtime@0.2.77
- @fusion-plugin-examples/openclaw-runtime@0.2.77
- @fusion-plugin-examples/paperclip-runtime@0.2.77

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.70.1
- @fusion/dashboard@0.70.1
- @fusion/engine@0.70.1

### @fusion/engine

#### Patch Changes

- @fusion/core@0.70.1
- @fusion/pi-claude-cli@0.70.1

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.70.1

### @runfusion/fusion

#### Patch Changes

- 09e519e: summary: Fix packaged desktop app crashing on first boot because PostgreSQL migrations were missing from the build.
  category: fix
  dev: "@fusion/core's bare tsc build never copies src/postgres/migrations/\*.sql into dist; the CLI compensates in packages/cli/tsup.config.ts but the desktop staging did not, so packaged Local mode crashed schema init (ENOENT dist/postgres/migrations/0000_initial.sql) after embedded Postgres started. packages/desktop/scripts/workspace-tools.ts now stages the migrations in buildCore(), re-stages them into the pnpm-deploy closure in stageDesktopDeploy(), and fails the build via verifyCoreMigrationsStaged() if the baseline migration is absent. Fixed in 6e5bb5d3d."
- 9cafa04: summary: Fix PR-mode auto-merge failing with "Could not determine repository" in centrally-installed multi-project deployments.
  category: fix
  dev: processPullRequestMergeTask, createGroupPrCallback, and createPrNodeGithubOps now pass explicit owner/repo (resolved from the per-project cwd / task worktree) into findPrForBranch/createPr/mergePr instead of relying on GitHubClient.resolveRepo's process.cwd() fallback; the engine's buildRespondCallback resolves the review-response run cwd from the task's recorded worktree. Fixes Tchori-Labs/Fusion#4; non-workspace sibling of upstream #1924/FN-7610.

### runfusion.ai

#### Patch Changes

- Updated dependencies [09e519e]
- Updated dependencies [9cafa04]
  - @runfusion/fusion@0.70.1

## 0.70.0

### @fusion/core

#### Patch Changes

- be55d0a: summary: Fix dashboard skill discovery lifecycle in PostgreSQL mode.
  category: fix
  dev: Reuse and close backend-aware project stores, keep request-scoped discovery loaders from mutating persistent plugin runtime state, and make cluster-wide PostgreSQL runtime-role creation race-safe.

### @fusion/dashboard

#### Patch Changes

- Updated dependencies [be55d0a]
  - @fusion/core@0.61.0
  - @fusion/engine@0.61.0
  - @fusion/i18n@0.39.26
  - @fusion-plugin-examples/claude-runtime@0.1.1
  - @fusion-plugin-examples/cli-printing-press@0.1.43
  - @fusion-plugin-examples/compound-engineering@0.1.26
  - @fusion-plugin-examples/dependency-graph@0.1.57
  - @fusion-plugin-examples/grok-runtime@0.2.4
  - @fusion-plugin-examples/omp-runtime@0.1.1
  - @fusion-plugin-examples/quality@0.1.1
  - @fusion-plugin-examples/roadmap@0.1.45
  - @fusion-plugin-examples/cursor-runtime@0.1.45
  - @fusion-plugin-examples/droid-runtime@0.1.52
  - @fusion-plugin-examples/hermes-runtime@0.2.76
  - @fusion-plugin-examples/openclaw-runtime@0.2.76
  - @fusion-plugin-examples/paperclip-runtime@0.2.76

### @fusion/desktop

#### Patch Changes

- Updated dependencies [be55d0a]
  - @fusion/core@0.61.0
  - @fusion/dashboard@0.61.0
  - @fusion/engine@0.61.0

### @fusion/engine

#### Patch Changes

- Updated dependencies [be55d0a]
  - @fusion/core@0.61.0
  - @fusion/pi-claude-cli@0.61.0

### @fusion/plugin-sdk

#### Patch Changes

- Updated dependencies [be55d0a]
  - @fusion/core@0.61.0

### @runfusion/fusion

#### Minor Changes

- 945d629: summary: Show migration details once in the dashboard and system inbox after SQLite cutover.
  category: feature
  dev: Persists banner dismissal and inbox-delivery markers with a Discord support link.
- c15c78f: summary: Bundle embedded PostgreSQL for zero-system-install local storage when DATABASE_URL is unset.
  category: feature
  dev: Adds `embedded-postgres` lifecycle manager (initdb/pg_ctl start/stop, graceful SIGTERM/SIGINT shutdown, data persistence across restarts). Platform binaries bundled for macOS/Linux/Windows arm64/x64. Used by `createTaskStoreForBackend` when DATABASE_URL is unset.
- a242f1b: summary: Require PostgreSQL storage and complete runtime parity across projects, archives, missions, plugins, and maintenance.
  category: breaking
  dev: Remove FUSION_NO_EMBEDDED_PG and sync runtime fallbacks; legacy SQLite files remain one-time migration inputs only.
- c15c78f: summary: Default local backend is now embedded PostgreSQL; set FUSION_NO_EMBEDDED_PG=1 for legacy SQLite.
  category: feature
  dev: `createTaskStoreForBackend` now boots embedded PostgreSQL by default when DATABASE_URL is unset (previously required FUSION_EMBEDDED_PG=1). FUSION_EMBEDDED_PG=1 is now a no-op alias; FUSION_NO_EMBEDDED_PG=1 is the opt-out back to legacy SQLite. `embedded-postgres` is now a direct dependency of @runfusion/fusion so the bundled CLI can resolve the platform binary at runtime. Boot smoke exercises the embedded path by default (initdb-aware 180s health timeout). Also hardens three backend-mode gaps the flip exposed: ResearchStore/insights router/watch() now degrade gracefully instead of crashing `fn serve` when the sync SQLite satellite stores are unavailable in PG backend mode.
- c0bef0b: summary: Deprecate the built-in Coding (Ideas) workflow — it no longer appears for new task selection.
  category: internal
  dev: builtin:coding-ideas is excluded from defaultEnabledBuiltinWorkflowIds() and hidden from listWorkflowDefinitions via the shared DEPRECATED_BUILTIN_WORKFLOWS registry / isBuiltinWorkflowDeprecated helper; it remains resolvable by id for existing task selections. Applied only after a preflight verified no active task (including parked ideas in the `ideas` intake column) selects it.
- 1c02e68: summary: Deprecate the built-in Brainstorming workflow — it no longer appears for new task selection.
  category: internal
  dev: builtin:brainstorming is excluded from defaults and listWorkflowDefinitions through the deprecation registry/helper, but remains resolvable by id. Applied after a successful live-store query verified no active task selects it.
- e46ffeb: summary: Show when Plan Review budget exhaustion needs approval and make the replan cap configurable.
  category: feature
  dev: Adds a number-typed workflow setting (unset → falls back to PLAN_REVIEW_GATE_REPLAN_CAP) read in triage blockAfterPlanReviewRevise; adds a distinct TaskCard/ListView badge + TaskDetailModal callout gated on awaitingApprovalReason === "plan-review-replan-cap".
- 667f4c8: summary: Chat agents and Grok CLI sessions now have board, delegation, web, and knowledge retrieval tools.
  category: feature
  dev: Dashboard chat and room responders share a safe coordination toolset; destructive agent lifecycle tools remain excluded.
- 60b6e3e: summary: Auto-retry executor tool-call failures before parking tasks.
  category: feature
  dev: Adds project-scoped bounded retry settings, durable PostgreSQL claim state, and same-model retry auditing.
- d870878: summary: Optionally escalate an executor run to a stronger model or configured node after same-model retries are exhausted.
  category: feature
  dev: New opt-in project settings provide one model/node escalation attempt with durable task state and audit events.
- 96b1f21: summary: Add a diagnostic summary and one-click "Retry with a different model/node" to the Task Failed banner.
  category: feature
  dev: TaskDetailModal now renders the banner for all failed tasks (including errorless), surfaces the latest tool_error detail (FN-7995), and applies model/node overrides via updateTask before re-running the existing retry path.
- adcba0e: summary: Add a Hide imported toggle that filters imported issues, PRs, and GitLab items from Import Tasks.
  category: feature
  dev: GitHubImportModal renders a persisted per-project hideImported toggle in the list-pane header (and the GitLab toolbar/header); when on, imported rows (importedUrls predicate) are excluded from the issues/pulls/GitLab render sets while the "{n} imported" count still reflects the full fetched set, with a dedicated all-imported empty state. Toggle persists via GitHubImportPersistedState.hideImported.
- 72378cb: summary: Quick Add image attachments now show compact previews you can tap to open full-size in a resizable window.
  category: feature
  dev: QuickEntryBox/TaskForm/InlineCreateCard pending-image previews shrink via InlineCreateCard.css and open in the shared FloatingWindow (dedicated floating-window--image-preview class, full-screen on mobile); remove button stays a separate click target.
- 5b4ec4c: summary: Add a dedicated fallback model lane for the AI merger, configurable under Project Models.
  category: feature
  dev: New project settings mergerFallbackProvider/mergerFallbackModelId/mergerFallbackThinkingLevel; resolveMergerFallbackModel resolves project merger-fallback → global fallbackProvider/fallbackModelId. Every merger session builder consumes the resolved merger fallback pair and lane-specific fallback thinking; unset keys preserve existing behavior.
- e87b51b: summary: Pin up to 3 chat conversations to keep important ones at the top.
  category: feature
  dev: Adds nullable chat_sessions.pinned_at (self-heals on boot); PATCH /chat/sessions/:id accepts `pinned`; ChatStore.setSessionPinned enforces the max-3 per-project-scope limit (null projectId scoped as "default" via isNull predicate + non-null advisory-lock key) with a per-scope advisory lock; archiving clears pinnedAt on both archive paths and archived sessions cannot be pinned.
- 274318a: summary: Per-task token budgets now enforce — soft caps alert once and hard caps pause the task.
  category: fix
  dev: Wires persist-time enforcement and token-budget notifications; budgets exclude cache-read tokens.
- 3f133e0: summary: Add a read-only tool to review a task's full agent log from chat.
  category: feature
  dev: New `fn_task_logs_read` tool reads TaskStore logs with type filtering and runtime-normalized pagination across agent lanes and the pi extension.
- c2475b0: summary: Task-detail chat now proactively narrates step progress, failures, and review outcomes in real time.
  category: feature
  dev: Adds bounded, secret-redacted engine status narration across step-session, default execution, graph review, and legacy review paths.
- f3b68c9: summary: Planning Mode now previews the generated plan before you choose whether to refine it.
  category: feature
  dev: The deepening checkpoint PlanningQuestion carries an optional planPreview payload.
- 99b79e4: summary: Show a Reverted badge on completed tasks whose changes were rolled back.
  category: feature
  dev: Persists clean and already-reverted git outcomes in source metadata for task-card rendering.
- 19ab7a9: summary: Add a setting to write generated task definitions in the operator's supported input language.
  category: feature
  dev: `taskDefinitionInInputLanguage` localizes prose only; headings, markers, and code stay English. Supports es/fr/ko/zh-CN, normalizes Chinese to zh-CN, and falls back to English for unsupported or uncertain input.
- 5661582: summary: Dashboard keyboard shortcuts now toggle — re-press a shortcut to close its interface.
  category: feature
  dev: Shortcut handlers in useDashboardKeyboardShortcuts + App.tsx now dispatch toggle callbacks (open on first press, close/revert on re-press). Modal-backed shortcuts use existing nav-aware closers; view-backed shortcuts (Settings/Command Center) retain the exact revert callback pushed by handleTaskViewChange, removeNav it, and restore the captured prior view (not board), so both shortcut-opened and UI-opened views close without leaking a browser-back entry.
- f63818a: summary: Add a global option to skip confirmation dialogs for critical actions.
  category: feature
  dev: New global setting `skipConfirmationDialogs` (default false); when on, `ConfirmDialogProvider` resolves confirm/confirmWithChoice/confirmWithCheckbox to the primary/default choice without rendering the dialog. Toggle in Settings → Global → General. Reset-task guards in TaskCard/TaskDetailModal/ListView migrated to the useConfirm seam.
- 1a337df: summary: Add an executor fallback model and retry the primary model before blocking on fallback exhaustion.
  category: feature
  dev: Adds executionFallbackProvider, executionFallbackModelId, and executionFallbackThinkingLevel workflow settings.
- 5f70447: summary: Triage-detected duplicate tasks are now blocked for a Keep/Delete decision instead of auto-deleted.
  category: feature
  dev: New project setting `triageDuplicateResolution` (`prompt` default | `keep` | `delete`) gates triage explicit-duplicate-marker handling and links the existing decision banner to the duplicate.
- 68583b5: summary: Add a Create fix task button on failed PR checks in the GitHub import preview.
  category: feature
  dev: Reuses createTask with an auto-composed PR and check context prompt (FN-8110).
- fd03666: summary: Add planner clarification controls with ntfy and mailbox alerts.
  category: feature
  dev: Adds the disabled-by-default agentClarificationEnabled setting and session override.
- e72629c: summary: Add a per-task Merger model and thinking selection to the Quick Add model dropdown.
  category: feature
  dev: Per-task merger model and thinking overrides are persisted and honored by merger sessions.
- c6be0b1: summary: Split backup settings into global Database Backups and project Memory Backups.
  category: feature
  dev: Moves autoBackup settings to global scope and routes in-process backup commands through the canonical global backup root.
- 4df5c62: summary: Show a local codebase token estimate and on-disk size on the project Dashboard Overview.
  category: feature
  dev: New GET /api/projects/:id/codebase-metrics; calibrated cl100k_base pre-tokenization estimator with separate bounded source/disk domains, symlink-safe local traversal, two-minute caching, and granular shared B/KB/MB/GB formatting.
- 255e9c1: summary: Add a one-click "Restart Fusion" button to the update banner after an in-app update.
  category: feature
  dev: Reuses POST /api/system/restart via requestSystemRestart and the SystemInfoResponse.restartSupported capability flag; button degrades to a disabled state with a manual-restart note when unsupervised.
- 6f99fdb: summary: Add a Refresh checks button to GitHub import PR previews for fresh CI status.
  category: feature
  dev: Refresh evicts the selected pull-detail cache entry and guards stale cache writes (FN-8137).
- e7c5de0: summary: Add a one-click "Restart Fusion" button to the Settings modal after an in-app update.
  category: feature
  dev: Adds a capability-aware restart affordance to SettingsModal's footer update-success state; reuses POST /api/system/restart via requestSystemRestart and restartSupported, with a disabled manual-restart fallback when unsupervised.
- 07e1ceb: summary: Add three new dashboard color themes: Cobalt, Clay, and Moss.
  category: feature
  dev: Extends ColorTheme with synchronized dark/light token blocks and selector swatches.
- 26cb0cc: summary: Add Kimi K3 model selection and token-cost support.
  category: feature
  dev: Aligns pi SDK consumers to 0.80.10 and verifies native `kimi-coding:k3` catalog availability.
- 3fdc2c1: summary: Model dropdowns keep the provider header pinned while scrolling and let you collapse each provider list.
  category: feature
  dev: CustomModelDropdown gains CSS sticky provider headers and a per-provider collapse chevron persisted to localStorage (key fusion-dashboard-model-dropdown-collapsed-providers).
- 7b54095: summary: Add Todo API read + create-task endpoints so scripts can turn a todo into a running task.
  category: feature
  dev: New `/api/todos/:id`, `/api/todos/:id/items`, `/api/todos/items/:id`, and `POST /api/todos/items/:id/create-task` routes in todo-routes.ts; AsyncTodoStore gains getList/getItem/listItems; create-task validates title/priority/workflowId/assignedAgentId, honors body projectId scoping, and delegates to TaskStore.createTask with source.sourceType="api".
- d6860b5: summary: Choose which quick-action tabs appear in the mobile footer nav.
  category: feature
  dev: Adds project setting `mobileNavPrimaryItems` (ordered list of the seven selectable canonical nav-item ids: command-center, tasks, agents, missions, chat, mailbox, planning); MobileNavBar renders primary tabs from it and routes omitted selectable destinations to the More sheet. Default reproduces the prior order.
- 86c281b: summary: Let operators post GitHub issue comments directly from Import Tasks.
  category: feature
  dev: Adds gh-first and token REST fallback comment posting with optimistic preview updates.
- adb3eb3: summary: Add a first-class Claude runtime that drives Claude Code over ACP.
  category: feature
  dev: New bundled `fusion-plugin-claude-runtime` (provider `claude-cli`, runtime `claude`) composes the pinned `claude-code-cli-acp` bridge and is additive to experimental `pi-claude-cli` Route A.
- 9152d8f: summary: Remove the footer AI session pill; background progress now appears in the session notification banner.
  category: feature
  dev: Deletes BackgroundTasksIndicator and its footer wiring. The banner now shows non-planning generating and retained error sessions; planning remains in its docked view and nav badge, while cli-agent progress is observational to avoid a dead Resume action.
- 44c7842: summary: Reorder and add more mobile footer quick actions, applied in real time.
  category: feature
  dev: Refines mobileNavPrimaryItems with an expanded destination registry, ordered settings controls, and immediate preview state.
- 1d0feb2: summary: GitHub import pages all open issues with Prev/Next; linked issues close when tasks reach Done.
  category: feature
  dev: The import picker (GitHubImportModal) fetches up to 300 open issues in one request and pages the result client-side at 30/page with Prev/Next controls and a page indicator; a truncation notice appears past the cap. NewTaskModal's reference picker limit rose 30→100. GitHubClient.listIssues now pages the REST path (per_page loop until limit/exhaustion, PR-filtering no longer stops paging early) and lifts the gh path's 100 cap (gh --limit paginates internally); gh-CLI label filtering fetches the full cap before client-side OR filtering. Separately, the GitHub-tracking reconcile sweep now isolates its three passes in runSweep so a throw in one pass no longer silently starves the others — previously a failure in the first pass disabled the entire close-on-Done backstop, leaving linked/imported issues open; failures are now logged instead of swallowed.
- 0863c0f: summary: Auto-translate foreign-language GitHub issues in the Import Tasks panel, with a target language and model you choose.
  category: feature
  dev: New project settings `githubImportAutoTranslate` (default false) and `importTranslateTargetLocale`, plus an `import-translate` model lane (project `importTranslateProvider`/`importTranslateModelId`, global `importTranslateGlobalProvider`/`importTranslateGlobalModelId`) resolved by `resolveImportTranslateSettingsModel`. Translations persist in the new `project.import_translation_cache` table (migration 0010) keyed by project+repo+issue+locale+source hash, and are pruned when an issue closes. `POST /api/github/issues/auto-translate` translates the 50 most recent open foreign issues per load on its own rate-limit budget; both single and batch import read the cache so imported tasks carry the translated title/body. Language detection moved from the dashboard app to `@fusion/core` so the panel and server share one heuristic. Auto-translation runs in the background and streams in chunks of 8 (`AUTO_TRANSLATE_CHUNK_SIZE`), so list titles fill in progressively and one failed chunk cannot discard the page; nothing in the panel awaits it. The two controls live in Settings -> Project General using that section's native checkbox/select markup, and Settings search advertises translation terms for General plus the Project/Global Models lane.
- 5ab46a6: summary: The GitHub import screen shows far more issues at once, and Import now sits under the issue you are reading.
  category: feature
  dev: Provider, type tabs, origin, filter and Load collapse into one wrapping control row (chrome 93px -> 70px at 412px; ~9 -> ~13 issues visible). Load is icon-only (label kept as aria-label/title). The labels filter is a popover whose trigger doubles as its readout, so collapsing never hides applied state; dismisses on outside pointerdown or Escape (stopPropagation so the modal survives). Origin stays visible as an inline chip. Import moves out of the preview header into a bottom action bar alongside Close issue, and the list footer's duplicate Import is removed — the footer keeps only Cancel, so an issue can no longer be imported without opening it. Obsolete `flex: 1 1 100%` mobile stacking on the toolbar zones removed.
- 203557e: summary: Imported GitHub and GitLab issues now carry their screenshots as task attachments, so agents can see them.
  category: feature
  dev: `importIssueImageAttachments` (packages/dashboard/src/issue-image-attachments.ts) downloads images embedded in an issue's body and comments and stores them via `addAttachment`, wired into `POST /github/issues/import`, `POST /github/issues/batch-import`, and every GitLab import route via `importItem`. Provider differences sit behind an `ImageImportPolicy`: GitHub images are absolute URLs on a fixed host allowlist; GitLab `/uploads/...` are project-relative and restricted to the configured instance origin. GitLab note bodies come from the new read-only `GitLabClient.listNotes`. Extraction runs on the original (untranslated) body; downloads are capped at 10 images / 5MB each with a 15s timeout, authenticated per provider (gh CLI token / PRIVATE-TOKEN), and best-effort so a failed image or comment fetch never fails the import.
- bc2d22d: summary: Offer AI translation in Import Tasks when issue/PR content is not the dashboard language.
  category: feature
  dev: Adds POST /api/ai/translate-text and opt-in Translate/Show original controls in the GitHub/GitLab import preview; translation is display-only and does not change imported task text.
- 8fe122d: summary: Keep the operator's original task description at the top of generated PROMPT.md specs.
  category: feature
  dev: Deterministic `## Original Description` injection on AI-planned finalize and non-AI generateSpecifiedPrompt; planning templates instruct verbatim copy.
- 4f03767: summary: Optional LLM session advisor for planner overseer (off by default; enable and set model to use).
  category: feature
  dev: OMP-advisor parity — OverseerEmissionGuard, delta runtime, OVERSEER.md/WATCHDOG.md. Gate: plannerOverseerAdvisorEnabled (default false) plus provider/model ids. Lifecycle supervisor unchanged.
- c15c78f: summary: Command Center productivity, team, token, and tool analytics work on the PostgreSQL backend.
  category: feature
  dev: Ports aggregateProductivityAnalytics/aggregateTeamAnalytics/aggregateTokenAnalytics/aggregateToolAnalytics to accept Database | AsyncDataLayer, adding a PG branch ("ping" in dbOrLayer) that runs schema-qualified raw SQL over project.tasks/task_commit_associations/pull_requests/agents/usage_events/approval_request_audit_events with snake_case columns and the same aggregation semantics as the SQLite path. The command-center tokens/tools/productivity/team routes pass getAsyncLayer() ?? getDatabase() and await; the interim 503 guards are removed. GitHub-issue, signal, and live-snapshot analytics remain 503 in PG mode (follow-up). Adds command-center-analytics.pg.test.ts to test:pg-gate.
- c15c78f: summary: Command Center workflow, GitHub-issue, signal, and live-snapshot analytics now work on the PostgreSQL backend.
  category: feature
  dev: Ports aggregateWorkflowAnalytics/aggregateGithubIssueAnalytics/aggregateSignalsAnalytics/composeLiveSnapshot to accept Database | AsyncDataLayer, adding a PG branch ("ping" in dbOrLayer) that runs schema-qualified raw SQL over project.tasks/task_workflow_selection/workflows/incidents/cli_sessions/agent_runs with snake_case columns and the same aggregation semantics as the SQLite path. The command-center workflows/github/signals/live routes pass getAsyncLayer() ?? getDatabase() and await; the interim 503 guards are removed. Every /api/command-center/\* route now functions in backend mode. Adds command-center-remaining-analytics.pg.test.ts to test:pg-gate.
- c15c78f: summary: Goals work on the PostgreSQL backend — the Goals view and mission goal-links load instead of erroring.
  category: feature
  dev: Ports GoalStore to the AsyncDataLayer. Adds AsyncGoalStore (over the existing async-goal-store.ts helpers; ACTIVE_GOAL_LIMIT enforced atomically in the helpers' transactionImmediate, same as sync). getGoalStoreImpl returns it in backend mode; the dashboard /api/goals routes await it and the interim 503 is removed. Reverts the PG-mode goal-resolution degradations added earlier — mission routes and `fn mission` now resolve/validate real linked goals on both backends. CLI goals/mission/extension and engine agent-tools converted to await; goal-injection-diagnostics stays on its instanceof-guarded sync fallback. Adds goal-store.pg.test.ts to test:pg-gate.
- c15c78f: summary: Generating insights works on the PostgreSQL backend — the insight run executor and stale-run sweeper run in PG mode.
  category: feature
  dev: Await-converts the insight run executor (insight-run-executor.ts) and the stale-run sweeper (insight-run-sweeper.ts) and widens their store type to InsightStore | AsyncInsightStore, so POST /api/insights/run and /runs/:id/retry drive the async store instead of throwing 503 (getSyncInsightStore removed). The startup/background/drive-by sweeper is now enabled for both backends. The AI extraction step still needs a configured provider at runtime; a run without one records a clean failed run rather than 503. Adds insight-run-execution.pg.test.ts (create→complete, create→fail, retry-with-lineage against embedded PG) to test:pg-gate.
- c15c78f: summary: Insights work on the PostgreSQL backend — the Insights dashboard loads instead of erroring.
  category: feature
  dev: Ports InsightStore to the AsyncDataLayer. Adds AsyncInsightStore (wrapping async-insight-store.ts helpers, incl. 6 new helpers — updateInsight, updateInsightRun [faithful run-lifecycle state machine: terminal-immutable, transition validation, auto completed/cancelled timestamps], listInsightRunEvents, countInsights, countInsightRuns, listStalePendingRuns); getInsightStoreImpl returns it in backend mode; dashboard insights routes await it and the interim 503 is removed for the read/write/cancel surface. The 3 engine reporters stay on graceful fallback (instanceof-gated). Known partial: AI insight-run generation/retry (POST /run, /runs/:id/retry) and the stale-run sweeper remain sync-only and still 503 in PG mode until the run executor is ported. Adds insight-store.pg.test.ts to test:pg-gate.
- c15c78f: summary: Dashboard banner after SQLite auto-migration to PostgreSQL with backup location and help link.
  category: feature
  dev: startup-factory persists settings.sqliteMigrationNotice (migratedAt/rows/tables/sqliteBackups) after a successful first-boot auto-migration; SqliteMigrationBanner renders it once, dismiss persists dismissed:true via PUT /settings. Auto-migration now also stamps archive.archived_tasks.project_id.
- c15c78f: summary: Mission autopilot runs on the PostgreSQL backend — missions advance automatically instead of autopilot being disabled.
  category: feature
  dev: Await-converts MissionAutopilot to drive MissionStore | AsyncMissionStore (every this.missionStore.\* call awaited; watchMission/unwatchMission/getAutopilotStatus and helpers async) and removes the instanceof MissionStore gates in InProcessRuntime (construction + recover paths) so the autopilot loop watches/recomputes/recovers in both backends. Slice execution + validator-loop methods stay scheduler-gated (degrade gracefully in PG). getAutopilotStatus async ripples through mission-routes/server. Adds mission-autopilot.pg.test.ts to test:pg-gate.
- c15c78f: summary: Missions work on the PostgreSQL backend — the Missions dashboard and goal→mission links load instead of erroring.
  category: feature
  dev: Ports MissionStore (dashboard surface) to the AsyncDataLayer. Adds AsyncMissionStore (63 methods over the 71 existing async helpers + 8 new primitives), assembling the composites (getMissionWithHierarchy, listMissionsWithSummaries, mission/milestone health rollups, computeMissionStatus + the feature→slice→milestone→mission recompute cascade, triageFeature, getFeatureLoopSnapshot) by mirroring the sync store. getMissionStoreImpl returns it in backend mode; mission-routes + goal→mission routes await it and the interim 503 is removed (the GoalStore 503 stays — GoalStore is still deferred). Mission AUTOPILOT, live SSE mission events, mesh hierarchy snapshot apply/collect, and engine validator-loop methods stay degraded in PG mode behind instanceof guards. Also fixes the mission-create path which resolved linked goals via the unported sync GoalStore: goal resolution now degrades to empty in backend mode (links live in MissionStore; full Goal objects return once GoalStore is ported). Adds mission-store.pg.test.ts to test:pg-gate.
- c15c78f: summary: Isolate projects sharing the embedded PostgreSQL cluster — tasks, config, and archived tasks are scoped per project.
  category: feature
  dev: PR #2007 (Approach A) — project_id partition key on project.tasks/project.archived_tasks/archive.archived_tasks with taskProjectScope threaded through every scan/claim/count; per-project config rows; startup factory binds the AsyncDataLayer to options.projectId; drift self-heal generalized to schema-qualified entries; archived-board reads scoped (review P1 fix).
- c15c78f: summary: Remove node settings sync on the PostgreSQL backend — nodes share the database, so settings are already shared.
  category: feature
  dev: In backend mode the mesh sync route ignores inbound settings payloads and returns none; PeerExchangeService force-disables settings gossip; /nodes/:id/settings (fetch/push/pull/sync-status) and /settings/sync-receive answer 409 code settings-sync-disabled-postgres; the NodesView sync hook treats that 409 as a quiet steady state (no chips, no polling). Provider auth sync (/nodes/:id/auth/sync, auth-receive/auth-export) is intentionally kept — auth material is per-machine file state, not database state.
- c15c78f: summary: Remove task mesh replication entirely — nodes replicate through the shared PostgreSQL database.
  category: feature
  dev: POST /mesh/tasks/create is deleted (with applyReplicatedTaskCreate and the replicated-create payload helpers); /mesh/sync shared-state is reduced to projectSettings (legacy sqlite settings sync only) + authMaterial in both directions, and the task-metadata/mission/agent/agent-run/activity-log/run-audit snapshot machinery is removed from the stores; /mesh/task-ids/\* never forwards to a remote coordinator in backend mode (the shared distributed_task_id_state rows are the coordinator). Peer topology exchange unchanged.
- c15c78f: summary: Research runs actually execute on the PostgreSQL backend instead of staying queued forever.
  category: feature
  dev: Await-converts the engine ResearchOrchestrator + ResearchRunDispatcher to drive InsightStore | AsyncResearchStore (every this.store.\* call awaited; addEvent→appendEvent for union compatibility) and removes the instanceof ResearchStore gate in ProjectEngine.start that disabled the orchestrator/dispatcher in PG mode. Exports AsyncResearchStore from @fusion/core. A queued run now advances queued→running→completed/failed in PG; the AI/web step still needs runtime providers (a run with none fails cleanly). Adds research-execution.pg.test.ts to test:pg-gate.
- c15c78f: summary: Research works on the PostgreSQL backend — the Research dashboard loads and runs CRUD instead of erroring.
  category: feature
  dev: Ports ResearchStore to the AsyncDataLayer. Adds AsyncResearchStore (12 new helpers incl. faithful replicas of the run-lifecycle state machine — updateResearchStatus per-status auto-lifecycle fields, terminal-immutability, transition validation — and the retry gate/lineage in createResearchRetryRun); getResearchStoreImpl returns it in backend mode; dashboard research routes await it and the interim 503 is removed. AI research EXECUTION (engine ResearchOrchestrator/dispatcher, agent-tools research tools, CLI research run) stays degraded in PG mode behind instanceof guards — same boundary as the insight run executor. Adds research-store.pg.test.ts (13 tests incl. lifecycle machine + retry gate) to test:pg-gate.
- c15c78f: summary: Live dashboard updates (SSE) work on the PostgreSQL backend for missions, research, and insights.
  category: feature
  dev: The async store wrappers (AsyncMissionStore/AsyncResearchStore/AsyncInsightStore) now extend EventEmitter and emit the same events as their sync counterparts at the same mutation points (after the persistence await), so the SSE handler's subscriptions fire in PG mode instead of no-op'ing. sse.ts/server.ts drop the instanceof-sync narrowing and subscribe to the union store in both backends. Live push for mission/milestone/slice/feature/assertion/validator-start, research run lifecycle, and insight create/update events. Validator-loop-completed and fix-feature emits remain sync-only (those methods aren't in AsyncMissionStore yet).
- c15c78f: summary: Creating, editing, and deleting custom workflows works on the PostgreSQL backend.
  category: feature
  dev: Completes the workflow-definition write path in PG. Adds a next_workflow_definition_id counter to project.config (schema + 0000_initial.sql baseline) with an async counter (nextWorkflowDefinitionIdAsyncImpl) that preserves project settings on bump; createWorkflowDefinitionImpl gains a backend branch that INSERTs into project.workflows via Drizzle (ir/layout as jsonb objects). Complements the update/delete/select backend branches in workflow-ops.ts. Adds workflow-create.pg.test.ts to test:pg-gate.
- 4e4b6be: summary: Plans that need approval now also post a task-linked message to your dashboard mailbox.
  category: feature
  dev: NotificationService.handleTaskUpdated writes a `system`-typed mailbox message via `MessageStore.sendMessageOnce` (idempotency key `plan-approval:<taskId>`) on the awaiting-approval transition, alongside the existing ntfy push. Content links to the task using `buildNtfyClickUrl(ntfyDashboardHost, projectId, taskId)`; `system` type avoids re-triggering the `message:agent-to-user` ntfy pipeline. Covers both the manual plan gate and the plan-review-replan-cap escalation.
- cdf67c1: summary: AI planning, subtask, and mission interviews are now multi-tab — any tab can use the same session.
  category: feature
  dev: Removed the per-tab session lock end to end: the `/ai-sessions/:id/lock{,/force,/beacon}` routes, `checkSessionLock` on every planning/subtask/mission/milestone route, the store's acquire/release/force/holder/stale-release methods and their `@fusion/core` async helpers, the `useSessionLock` hook, the `getSessionTabId` util, the Take Control overlay + "active in another tab" banners, and the `useAiSessionSync` tab-ownership half (activeTabMap, broadcastLock/Unlock/Heartbeat, owningTabId). `tabId` params are gone from the session API client; routes ignore any tabId older clients still send. The persisted session row is the single source of truth, with per-session SSE plus global `ai_session:updated` events keeping tabs current and each producer's generation-in-progress guard resolving concurrent writes. The `ai_sessions.locked_by_tab`/`locked_at` columns are retained as dead, always-NULL columns — dropping them is an irreversible migration that would break older installed binaries whose upsert names those columns.
- e3f9825: summary: Add Quality plugin with Task QA tab for preview servers, test runs, reports, and suggested cases.
  category: feature
  dev: Bundled fusion-plugin-quality; host slot task context; superviseSpawn re-exported from plugin-sdk-core-runtime-shim.
- 4f03767: summary: Control the overseer session advisor from project settings, per task, and Quick Add.
  category: feature
  dev: Adds `sessionAdvisorEnabledByDefault` project setting, `task.sessionAdvisorEnabled` override, Quick Add eye toggle, and `resolveTaskSessionAdvisorEnabled` (task override → project default; workflow `plannerOverseerAdvisorEnabled` is a legacy/master gate that can still enable when the project default is off — not the final inheritance fallback after project).
- 55745af: summary: Settings search now finds and jumps to individual settings, and settings screens share one type scale.
  category: feature
  dev: Sections render through the shared `settings/` row primitives (`SettingsToggleRow`/`SelectRow`/`NumberRow`/`TextRow`/`TextareaRow`) instead of hand-rolled `form-group`/`checkbox-label` markup; global `.form-group` is unchanged for the 35 non-settings files that use it. Search is indexed from per-section `<Name>Section.search.ts` entries aggregated in `settings/search/entries.ts`, replacing the hand-curated `searchableText` keyword arrays as the primary match path (keywords remain a fallback for unmigrated sections). `settings-search-index.test.ts` fails the build when a rendered descriptor `key` is missing from the index. Adds the missing `--font-size-sm`/`--font-size-md` tokens plus `2xs`/`lg`, which were referenced by 12 declarations but never defined.
- edc6413: summary: Pin each task to one derivable worktree directory when worktree naming is "Task ID".
  category: feature
  dev: `worktreeNaming: "task-id"` now enables task-pinned worktrees — a task always lives in `<worktreesDir>/<task-id>` (derive → validate → reuse-or-recreate in `worktree-pinning.ts`/`worktree-acquisition.ts`), and stale/foreign `task.worktree` metadata self-corrects (audit `worktree:pin-rederived`) without consuming session retries. Task pinning and `recycleWorktrees` are mutually exclusive: enabling both is rejected at the settings-write boundary (`assertWorktreeNamingRecycleExclusive`, enforced in `store.updateSettings` + dashboard `PUT /settings`), the Settings → Worktrees UI enforces the exclusivity bidirectionally (disabling whichever control would create the conflict), and pinning applies only when recycling is off. `"random"`/`"task-title"` naming and the recycle pool are unchanged; worktrunk-managed layouts bypass pinning.
- c15c78f: summary: Todo lists now work on the embedded-PostgreSQL backend instead of erroring.
  category: feature
  dev: Ports TodoStore to the AsyncDataLayer. Adds an `AsyncTodoStore` class (in async-todo-store.ts) wrapping the already-tested async CRUD helpers over project.todo_lists/project.todo_items; `getTodoStoreImpl` returns it in backend mode instead of throwing "TodoStore is not available in PG backend mode" (which 500'd every /api/todos route). The dashboard todo routes now await the store methods so the same code path serves both the sync SQLite store and the async PG store. Adds todo-store.pg.test.ts to the blocking test:pg-gate lane. Known gap: the async store does not yet emit list/item events for SSE live-refresh (updates land on next read).

#### Patch Changes

- 80f2028: summary: Keep Planning session history visible while its latest data loads.
  category: performance
  dev: Planning fetches request only planning-type session summaries.
- 7daa16f: summary: Suppress the Planning Mode reconnecting hint on persisted question screens.
  category: fix
  dev: Gate the `planning.reconnecting` indicator in `PlanningModeModal` to `view.type === "loading"` so idle `awaiting_input`/DB-backed views render purely from persisted state.
- db05a77: summary: Hide the interview reconnecting hint on persisted question and review screens.
  category: fix
  dev: Gate the shared reconnecting indicator in MissionInterviewModal/MilestoneSliceInterviewModal to view.type === "loading" and in SubtaskBreakdownModal to view.type === "generating", mirroring FN-8002 so idle awaiting-input screens render purely from persisted state.
- 47f9aa7: summary: Settings now uses the same compact color-theme dropdown as the dashboard.
  category: fix
  dev: AppearanceSection/ThemeSelector reuse ThemeDropdown; the old .theme-grid affordance and orphaned CSS were removed. Shared swatch classes retained.
- 6206af8: summary: Settings theme selector is merged into the current-theme row and lists every color theme.
  category: feature
  dev: ThemeDropdown gains a current-row trigger variant used by ThemeSelector; the static preview markup/CSS was removed. Tests assert the explicit historical theme set on Settings and Command Center, including restored Shadcn Mono.
- 9b9d6a2: summary: Refresh workspace dependencies before a full System panel rebuild.
  category: feature
  dev: Full rebuilds run pnpm install before building and restarting.
- 2d61976: summary: Restore agent models, workflow lanes, Skills, goals, and Reliability after PostgreSQL migration.
  category: fix
  dev: Moves backend workflow, plugin, goal, and audit reads to PostgreSQL and recovers false heartbeat model parks.
- f116d05: summary: A task honestly parked as blocked now stays parked through engine pause/abort and workflow-graph teardown.
  category: fix
  dev: handleGraphFailure honors a live blocked park (status "failed", error "BLOCKED:") before every pause-abort/graph-failure classifier — no requeue-to-todo, no auto-continue, no BLOCKED: error overwrite — and releases its worktree/maxWorktrees slot. FN-8141 follow-up 1.
- 883f38d: summary: Fix agent AI interviews to use the configured planning model and preserve runtime suggestions.
  category: fix
  dev: Resolves onboarding model settings before session creation and aligns the prompt with supported runtime draft fields.
- 678265a: summary: Show live phase, table, row-copy, verification, and failure progress during SQLite migration.
  category: fix
  dev: Adds structured migration progress events to first-boot startup and `fn db migrate` terminal output.
- 514ccd3: summary: Recover agent interviews when models return thinking-only or malformed JSON responses.
  category: fix
  dev: Preserves structured thinking output and retries one JSON-only reformat turn before surfacing an error.
- be55d0a: summary: Fix dashboard skill discovery lifecycle in PostgreSQL mode.
  category: fix
  dev: Reuse and close backend-aware project stores, keep request-scoped discovery loaders from mutating persistent plugin runtime state, and make cluster-wide PostgreSQL runtime-role creation race-safe.
- 0312d2e: summary: Preserve late task, workflow, and mission fields during SQLite-to-PostgreSQL migration.
  category: fix
  dev: Adds PostgreSQL schema migration 0007 and restores runtime persistence for active late-added fields.
- 30a83f2: summary: Recover stale executor sessions with bounded fresh-session retries while preserving task progress.
  category: fix
  dev: Clears the persisted assistant-last transcript, defers requeue until lock release, and exhausts through the shared recovery budget.
- f111a40: summary: Settings now opens on the Appearance section by default.
  category: fix
  dev: Sets SettingsModal DEFAULT_SETTINGS_SECTION to appearance.
- 130c702: summary: Fix startup failures and a leaked server when two Fusion processes start embedded Postgres at the same time.
  category: fix
  dev: A lifecycle joining an already-running instance returned a URL before the owner's `ensureDatabase()` had created the database, so the joiner's first connect failed. Both join paths now verify the database on the joined instance's port (never `getPort()`, which prefers this instance's requested port) and create it if absent. Verification is best-effort so an unreachable/stale-pid join still resolves optimistically as before. `CREATE DATABASE` races tolerate both `42P04` and `23505` on `pg_database_datname_index`. The startup-race join now fires only on a lock-collision error — joining on any failure let a start that took the lock and then failed later join its own postmaster with `ownsProcess=false`, orphaning it — and reaps its own losing wrapper via the new `NonAdminServerHandle.stopWrapperOnly()`, since `stop()`/`pg.stop()` resolve through the shared data dir and would kill the winner.
- c15c78f: summary: Repair macOS embedded PostgreSQL dylib compatibility links before startup.
  category: fix
  dev: Adds an idempotent embedded-postgres macOS preflight that creates missing ABI-name symlinks such as `libpq.5.dylib` and `libzstd.1.dylib` from bundled versioned dylibs before `initdb`/`postgres` spawn, fixing zero-config startup when package symlink hydration is absent or incomplete.
- e33039a: summary: Starting a second Fusion process no longer fails with a Postgres lock-file error.
  category: fix
  dev: `EmbeddedPostgresLifecycle.start()` wraps the start path in a try/catch; on failure it re-reads `postmaster.pid` via `isAlreadyRunning()` and, when a live instance exists, joins it (`ownsProcess=false`) instead of surfacing the expected lock collision. Closes the window between the preflight singleton check and `pg.start()` where a competing process can create the lock. Non-`isAlreadyRunning` failures still rethrow unchanged.
- 19eb179: summary: Block empty-diff task finalizes that skipped verification steps so reverted work can't reach done.
  category: fix
  dev: Generalizes evaluateNoCommitsNoOpFinalize (packages/core) to block any zero-diff finalize when a step is skipped — verification/QA/review-named skips block unconditionally, other skips block unless every non-skipped step is done AND the task is noCommitsExpected. Applies at all finalize lanes (merger-ai empty lane, merger.ts, self-healing stranded-todo promoter + no-op review finalize). Closes the FN-8141 laundering path.
- 1c4fdb7: summary: Reverted-work tasks no longer merge to done as empty no-ops; they park for review.
  category: fix
  dev: merger-ai.ts empty-outcome lane now requires positive already-landed proof (recorded merge, prior no-op proof, branch tip ancestor of main, or a strong already-on-main classifier match) before finalizing a commit-expected task; otherwise it sets task.error, emits `task:empty-merge-finalize-blocked-no-landed-proof`, and moves the task back to todo. Same guard mirrored in the workspace all-empty finalize (blocks the reverted/net-zero shape). noCommitsExpected tasks keep their existing path (FN-8141).
- 9a37415: summary: Executors can end a genuinely-impossible task as "blocked" instead of laundering it into done.
  category: fix
  dev: fn_task_done gains outcome="blocked" (plus reason + optional blockedBy). Blocked parks the task failed (error "BLOCKED: <reason>"), bypasses the completion/bulk-completion gates, keeps steps in their true statuses, records blockedBy as task.dependencies, and emits run-audit task:execution-blocked-parked. Prompt guidance now names the blocked exit as the correct escape hatch, replacing skip-then-complete. Motivating incident: FN-8141.
- 9aa2852: summary: Dashboard API requests now resolve an explicit registered project instead of silently using the launch directory.
  category: fix
  dev: routes/context.ts gains a shared resolveRequestProjectId/getScopedStore/getProjectContext seam (request projectId → options.engine.getProjectId() → raw launch-dir store with a one-time warn, for unregistered dirs only). A resolved id always binds through the engine store or getOrCreateProjectStore; the launch project reuses the injected registry-bound store to avoid a duplicate pool. server.ts resolveScopedStore threads the launch project id, and the todo/goals/mission/insights/research/evals routers route their request middleware through the same seam.
- 46866a5: summary: Failed tasks with pre-fix promotion history can no longer auto-promote past the failure-provenance guard.
  category: fix
  dev: Removed the promoter's own recovery line ("Auto-recovered: task work was complete but stranded") from CLEAN_COMPLETION_MARKERS in completed-promotion-failure-provenance.ts; clean-completion evidence is now execution outcomes only (accepted/implicit fn_task_done). FN-8141 follow-up 2.
- e9f14bf: summary: Make local `pnpm build` skip unchanged packages and use fast CLI packaging by default.
  category: performance
  dev: Content-hash skip cache now covers non-plugin packages; CLI packaging stages desktop/plugins/DTS only with FUSION_CLI_FULL_PACKAGE=1 or CI (`pnpm build:full`). Added maxConcurrentVerifications (default 1) and tsc incremental builds.
- 05151a2: summary: Speed up dashboard and serve startup by sharing the PostgreSQL store and deferring non-route work.
  category: performance
  dev: Dashboard injects externalTaskStore for cwd engine (serve parity); multi-project engines only share when working directories match. ProjectEngine defers notifiers/OAuth (refresh-before-monitor), automation syncs, and merge sweep. Serve no longer awaits startAll before listen. Phase timing logs on both surfaces.
- c15c78f: summary: Fix manual agent-run creation failing on PostgreSQL when a heartbeat executor is attached.
  category: fix
  dev: POST /api/agents/:id/runs built its AgentStore without the scoped store's AsyncDataLayer on the heartbeat-executor branch, hitting the removed SQLite runtime in backend mode; it now borrows the layer like the record-only branch.
- 703488f: summary: Keep Anthropic subscription sessions connected by refreshing OAuth credentials with the correct client identity.
  category: fix
  dev: Corrects the Claude OAuth client ID used by the engine refresh request and adds request-contract coverage.
- 4b150e2: summary: Fix Anthropic subscription logins failing tasks with "Provider is not configured: anthropic".
  category: fix
  dev: pi >=0.80.8 moved session auth from `ModelRegistry.getApiKeyAndHeaders` (fusion's `getApiKey`) to `ModelRuntime.getAuth` -> pi-ai `resolveProviderAuth`, which reads `credentials.read("anthropic")` and refreshes OAuth via `credentials.modify("anthropic")`. Fusion stores the subscription login under `anthropic-subscription` (no raw `anthropic` row), so the refresh saw `current === undefined` and auth resolved to undefined. Fix: `createFusionCredentialStore.read("anthropic")` now resolves through `getApiKey("anthropic")` (handles refresh + raw/legacy/subscription/fallback precedence) and returns a ready `api_key` credential; pi-ai routes it as OAuth by the `sk-ant-oat` token prefix. Also add "not configured" to `isRetryableModelSelectionError` so an unresolved provider triggers the configured fallback model instead of hard-failing.
- 329fc1f: summary: Fix protected image artifacts so previews and links load in authenticated dashboards.
  category: fix
  dev: Artifact media URLs now use the existing same-origin query-token fallback required by browser image and link navigation.
- d1e9b56: summary: Fix a dashboard/app boot crash on databases created before the bulk-completion-refusal change.
  category: fix
  dev: PR #2260 added project.tasks.bulk_completion_refusal_at to the Drizzle model and the 0000 baseline but shipped no forward migration, so any pre-existing PostgreSQL database (already carrying the 0000 marker) never gained the column and crashed on the first TaskStore SELECT. Adds forward migration 0018 (wired via BULK_COMPLETION_REFUSAL_AT_VERSION, SCHEMA_BASELINE_VERSION → "0018"), a per-column upgrade regression test, and a migration-wiring-integrity guard (baseline marker must equal the highest migration file; every .sql must be registered).
- 4f03767: summary: Fix startup failures when several projects migrate against one PostgreSQL cluster at the same time.
  category: fix
  dev: Migration 0006's `fusion_runtime` setup used a check-then-CREATE ROLE that cannot be atomic — roles live in cluster-wide `pg_authid`, but the applier's `pg_advisory_xact_lock('fusion:schema-applier')` is per-database, so concurrent appliers on different databases of one cluster all saw the role as absent and raced, and the losers failed with 23505 on `pg_authid_rolname_index`. The create now tolerates losing the race (`EXCEPTION WHEN duplicate_object OR unique_violation`), catching the index-level violation the race actually raises as well as the plain duplicate.
- e97081f: summary: Stop more agents from running than the global concurrency cap allows.
  category: fix
  dev: Scheduler tryAcquires a shared slot before todo→in-progress and hands it to the executor/graph; triage admits planners against live running-agent claim (planning + in-progress + active in-review), not only semaphore.availableCount.
- 7aeefe2: summary: The task composer's Save button no longer has its label cut off on mobile.
  category: fix
  dev: At narrow widths `.quick-entry-primary-group` needed ~275px in a 260px column. Its five icon controls are floored by `min-width: 36px`, while Save's automatic minimum size was zeroed by the `overflow: hidden` that FN-7680/FN-7683 added for height equalization (per spec, automatic minimum size applies only when overflow is `visible`), making Save the sole shrinkable item — it absorbed the whole deficit and clipped its own label. Save is now pinned with `flex: 0 0 auto; min-width: max-content`, and the group may `flex-wrap: wrap` with `justify-content: flex-end` so a deficit reflows instead of clipping. Not breakpoint-scoped (FN-5751); inert where the row already fits. Verified in-browser at 412px and 1400px.
- 99870ba: summary: Fix first-boot SQLite migration failures while preserving all legacy project data.
  category: fix
  dev: Handles stale partitions, retired tables, derived FTS indexes, seeded singletons, and cross-database checksum collation.
- 5acea6c: summary: Fix data stores that silently failed against PostgreSQL by hitting removed SQLite paths.
  category: fix
  dev: Residual SQLite-stub sites reachable in backend mode are now routed through the AsyncDataLayer: the executor's authoritative assigned-agent fallback (executor.ts) now inherits the TaskStore asyncLayer (was silently returning null → model drift); `pruneAgentLogFilesAsync` replaces the sync self-healing prune call (was throwing every maintenance sweep); `cleanupOrphanedMaterializedSteps` deletes PG workflow_steps rows on failed create (was leaking); PG hard-delete now runs the async mission feature/task-link unlink (deleteTaskBackendImpl); `getWorkflowSettingsProjectId` no longer touches the SQLite stub for unscoped backend stores; the `fn plugin` unregistered-project fallback bootstraps a CentralCore AsyncDataLayer. Formerly-unported paths are now real backend implementations: `cleanupArchivedTasks` and `deleteWorkflowStep` delete via the async layer; `AgentStore.importLegacyFileRuns` cleanly no-ops in backend mode (no legacy SQLite run-files exist there); the dead zero-caller `applyTaskPatch` SQLite primitive was removed.
- bc34834: summary: Plan Review revisions no longer loop forever; tasks escalate to approval after repeated revises.
  category: fix
  dev: The triage pre-execution plan-review gate now seeds replan feedback from the plan-review REVISE output in workflowStepResults and caps consecutive REVISE replans at 3 (new planReviewReplanCount counter — a plan_review_replan_count integer column on the PostgreSQL tasks table, self-healing on existing embedded-PG databases via postgres-health), routing the task to awaiting-approval instead of looping.
- 3fce536: summary: Completed Planning Mode sessions that create multiple tasks now stay in planning history.
  category: fix
  dev: The multi-task create-tasks route now uses releaseSession instead of cleanupSession, retaining the persisted ai_sessions row like the single-task path.
- 78ef307: summary: Prevent startup crashes while recovering plugins from retained SQLite data.
  category: fix
  dev: Runs the plugin bridge before switching PostgreSQL connections to the restricted runtime role.
- daa34fb: summary: Fix task refinement/duplication, merge verification, and workflow checkpoint persistence on PostgreSQL.
  category: fix
  dev: atomicCreateTaskJson now routes to the AsyncDataLayer in backend mode (fixing the refineTask/duplicateTask createTaskWithId paths that bypassed \_createTaskInternal's backend routing), and the merger verification-cache ops (getVerificationCacheHit/recordVerificationCachePass) are now async with a PostgreSQL branch; the upsert targets verification_cache_pkey by constraint name since migration 0006 rebuilds project-schema PKs to lead with project_id. The full sync-SQLite residue sweep also ports workflow run-branch/step-instance persistence, branch progress, plugin column-transition hooks, getTaskColumns, getWorkflowStep/listWorkflowSteps stored-row reads, readRawProjectSettings, and listWorkflowPromptOverridesForProject to the async layer (several store methods became async: saveWorkflowRunBranch, loadWorkflowRunBranches, clearWorkflowRunBranches, saveWorkflowRunStepInstance, loadWorkflowRunStepInstances, clearWorkflowRunStepInstances, getBranchProgressByTask, readRawProjectSettings, listWorkflowPromptOverridesForProject). Also bumps @earendil-works/pi-ai and pi-coding-agent to ^0.80.10 — the FN-8142 pi SDK migration targeted APIs (ModelRuntime et al.) absent from the previously pinned 0.80.6, which broke the engine build.
- f079245: summary: Harden session-routing header wiring so a missing model-auth method can't break agent startup.
  category: fix
  dev: attachSessionRoutingHeaders now no-ops (warns) when ModelRuntime.getAuth is absent instead of throwing on getAuth.bind, restoring the pre-FN-8142 defensive invariant. Also realigns the pi-create-fn-agent and pi-session-routing-headers engine tests to the ModelRuntime.getAuth routing seam (mocks add the ModelRuntime export) so both suites pass against the 0.80.10 SDK landed by FN-8179.
- 1d6a044: summary: Fix tasks getting stuck in Planning forever after a plan review asks for revisions.
  category: fix
  dev: `hasAdvancedPastPlanning` (replan-target.ts) counted `steps.length > 0` as proof a task had advanced past planning. Replan cards legitimately retain the steps their previous planning pass materialized, so the guard at triage's `specifyTask` claim silently skipped its `status:"planning"` write, re-claimed the card every poll, and starved healthy cards out of `maxTriageConcurrent`. Steps are no longer advancement evidence in a planner lane ("triage", or "todo" for plan-in-place workflows carrying a planning status); worktrees and execution/terminal columns still are, preserving FN-7977. The primary claim path now warns instead of skipping silently.
- 03966ec: summary: Fix branch-group controls for tasks in non-default dashboard projects.
  category: fix
  dev: Resolves branch-group route stores from each request's projectId.
- 5185914: summary: Prevent implementation-incomplete workflow merge failures from false-completing as no-op done.
  category: fix
  dev: Merge graph failures with missing implementation proof now fail closed or requeue resumable parsed steps before any no-branch no-op merge requester path can run.
- 1b9c7a7: summary: Stop posting two completion comments on a linked issue when a task is both imported and tracked.
  category: fix
  dev: A task can carry both linkages at once (GitHub adopts a sourceIssue as githubTracking.issue via `source_issue_linked`; GitLab's buildGitLabTaskProvenance always emits both), so with githubCommentOnDone/gitlabCommentOnDone on, the issue-comment and tracking-comment services both commented on the same issue. The issue-comment services now suppress themselves when the tracking service provably posts to the same target — matched on issue identity for GitHub (case-insensitive owner/repo + number) and by construction for GitLab (resolveGitLabTarget prefers the tracked item). The tracking comment wins because it carries commit/branch/PR/files plus the release lines. Tracking pointed at a different issue, tracking disabled/unlinked, and same-column re-emits (where the tracking service no-ops) all still post as before; the custom comment template no longer renders on tracked issues.
- 71275ab: summary: Fusion self-repo issues now actually show the target release version when a task closes.
  category: fix
  dev: FN-7575 added the release lines to `GitHubIssueCommentService`, which is gated on the `githubCommentOnDone` setting (default false, no Settings UI) and so never fired. `GitHubTrackingCommentService` is the surface that posts the "✅ Done —" comments. The version logic moved to a shared `fusion-release-version.ts` and now applies to all four done-comment surfaces (GitHub/GitLab × tracking/issue). Lines join `optionalLines` so they count against `DONE_COMMENT_MAX_LENGTH`; GitLab self-repo matching uses `item.projectPath`, since the resolved target prefers the numeric `projectId`.
- d48537b: summary: Grok CLI failures now show the actual error instead of an empty chat message.
  category: fix
  dev: `GrokRuntimeAdapter` surfaces every silent-failure path as visible `onText` text plus an assistant message and `state.errorMessage`, instead of resolving into a blank bubble. Covers session-create failure (`describeCreateFailure`, which returns a dead session), prompt failure (`describePromptFailure`), a dead/disposed session with no ACP connection on a follow-up turn, and a turn ending with a non-`end_turn` stopReason and no assistant text. A turn with genuinely empty assistant text stays silent. Resolve-never-reject is preserved so chat/executor always receive a well-formed turn. Fixes the root cause behind the FN-7779 "No message" placeholder.
- 6e0fde8: summary: Fix a deleted Planning Mode session silently reappearing after an in-flight generation finishes.
  category: fix
  dev: AiSessionStore now records a bounded-TTL delete tombstone (10 min) in `delete()`/`deleteByIdAndType()`/bulk cleanup paths; `upsert()` drops writes for tombstoned ids without emitting `ai_session:updated`. Fixes the root cause in the shared store rather than in `planning.ts`/`subtask-breakdown.ts`/`mission-interview.ts`/`milestone-slice-interview.ts`, so all AiSessionType producers are protected.
- 49a459a: summary: Fix plugin skill toggles for custom skillFiles paths so sessions honor them.
  category: fix
  dev: resolvePluginSkillEnabled now keys reads by the resolved plugin skillFiles path when available.
- 9bdbdc5: summary: Fix Compound Engineering plugin skills missing from the published package.
  category: fix
  dev: Stages bundled plugin src/skills into dist/plugins/<id>/skills during bundlePluginEntry() for #2094 / FN-7955.
- d956abc: summary: Reports, CLI Printing Press, and WhatsApp Chat plugins now load from global installs.
  category: fix
  dev: Stages the three plugins through bundlePluginEntry with postgresSchema shim coverage and bundle-output regression assertions.
- 16b0109: summary: Pressing "New session" in Planning now always focuses the compose input.
  category: fix
- ddc8e6d: summary: Give terminally failed planning tasks deterministic fallback titles.
  category: fix
  dev: Adds non-LLM title derivation for terminal triage/specification failure paths.
- ec78981: summary: Make idle triage patrol back off during model outages.
  category: fix
  dev: Updates built-in standard and concise triage heartbeat prompt guidance.
- de25e32: summary: Add a workflow setting to disable idle heartbeat task patrol.
  category: feature
  dev: Adds plannerHeartbeatPatrolEnabled for no-task heartbeat and triage prompt gating.
- a8b6387: summary: Fix Project Models workflow model lane saves.
  category: fix
  dev: Keeps pending default-workflow model lane overrides registered for Settings Save after section navigation.
- 6ca7e48: summary: Surface duplicate-decision tasks on cards and in the operator mailbox.
  category: fix
  dev: Triage-marker duplicate decisions now use an idempotent task-linked system message.
- f1b528f: summary: Tasks parked by a refused fn_task_done no longer resurrect and strand at code review.
  category: fix
  dev: FN-7965. `fn_task_done`'s in-session refusal handler parks the row terminally (status=failed, worktree/branch/sessionFile cleared) once `MAX_TASK_DONE_REQUEUE_RETRIES` is exhausted, but the executor's no-fn_task_done retry loop never observed that park and spawned a fresh session. That session completed and marked the task done against a worktree-less row, so the pre-merge graph failed on the first write-capable node (`no-worktree-for-write-node`) and surfaced as a misleading "Workflow graph terminated with failure at node 'code-review-remediation'". The loop now re-reads state and honors the park (`terminallyParked`), stopping without requeue or review handoff — deliberately not routed through the FN-4806 reclaim branch, whose silent todo requeue would clear the park and re-park on next pickup in a todo→execute→park loop. The pre-existing reclaim probes could not catch this: they test `worktree === null`, but the store maps a cleared column to `undefined` (`task-store/serialization.ts` — `row.worktree || undefined`); tightening that probe is left as separate work.
- 0e84731: summary: The planner overseer now notices a failed in-progress task immediately instead of after two hours.
  category: fix
  dev: FN-7965. `deriveSignalAndSources`'s `executor` branch never read `task.status`, so a row parked `status: "failed"` (e.g. the terminal fn_task_done refusal/invariant park) reported `signal: "progressing"` with reason "Task is actively executing in-progress work". `failed` was only ever derived for the merger/pull-request stages, leaving the FN-7743 2h stall proxy (`columnMovedAt ?? updatedAt`) as the sole backstop. The branch now reports `failed`, which routes into the pre-existing failed-signal policy — `retry_step` at executor stage (sources are `agent-log`, never an ERROR_SOURCE_KIND), bounded by `PLANNER_RECOVERY_MAX_ATTEMPTS` and escalated on exhaustion. `paused` keeps precedence (operator/user-paused stays `blocked`), the reason is held constant so the FN-7577 `stage|signal|reason` feed dedup still holds, and `status` was added to `OverseerTaskRef`.
- f9c19f9: summary: Honor custom project workflow defaults in triage guidance.
  category: fix
  dev: `triageDefaultWorkflowId` and `triageDecisionOnlyWorkflowId` now accept custom IDs; unset/default triage routing inherits `config.settings.defaultWorkflowId`.
- 6e3a338: summary: Make task deletion return faster while cleanup continues in the background.
  category: performance
  dev: Defers branch cleanup and dashboard agent-binding release off the user-visible delete path.
- d893a02: summary: Hide the GitLab import tab when GitLab integration is disabled in settings.
  category: fix
  dev: Gates GitHubImportModal.tsx GitLab provider visibility on effective gitlabEnabled and coerces disabled persisted state to GitHub.
- aa0d863: summary: Fix Agents controls panel overlapping surrounding content on narrow viewports.
  category: fix
  dev: Elevated the .agent-controls-panel stacking context in AgentsView.css so the open controls popover sits above agent cards and token usage.
- 2179a61: summary: Fix concurrency sliders being undraggable on mobile touch devices.
  category: fix
  dev: The footer Engine Control menu and Command Center Concurrency card range inputs now use touch-action:none so the mobile pan-y ancestor lock no longer hijacks a horizontal thumb drag into page pan.
- d74018f: summary: Chat "Thinking" reasoning blocks now start collapsed for a cleaner transcript.
  category: fix
  dev: Removed the `open` attribute from TaskChatTab's task-chat-thinking <details>; StandardChatSurface already collapses thinking. Regression tests assert collapsed-by-default + expand-on-click across persisted, streaming, and Task Detail chat surfaces (FN-7974).
- 836e53c: summary: Exclude long engine pauses from in-progress task execution time.
  category: fix
  dev: Reuses FN-7011 active-timing reconciliation on full Global/Engine unpause. Engine-pause time is excluded even if in-flight agents continue, matching restart behavior.
- 5ff7a20: summary: Fix Mailbox artifact messages — "Open artifact" now loads without an auth error and "View task" opens the task.
  category: fix
  dev: artifactMediaUrl now appends the fn_token query fallback for authenticated element/link loads (script-capable HTML artifact iframes stay token-free); isTaskPopupVisibleForView no longer gates non-board/list popup opens and usePoppedOutTasks.popOut upgrades same-id entries.
- 214af98: summary: Transient provider failures of the Plan Review gate no longer bounce tasks back to planning.
  category: fix
  dev: workflow-graph-executor shouldRequestPreMergeFix + executor requestPreMergeOptionalStepFix now classify plan-review hard failures via isTransientError/isOperatorActionableAgentError/model-fallback signatures and skip the needs-replan handoff for non-plan-defect failures; genuine REVISE still replans. Fixes issue #2124 / FN-7977.
- 10b8045: summary: GitHub import skips prior issues after description edits or owner/repo casing changes.
  category: fix
  dev: Consolidated GitHub import dedup into shared isGitHubIssueAlreadyImported/buildGitHubIssueSource (sourceIssue-first, case-insensitive repository, source.sourceMetadata and description-URL fallbacks) used by both CLI import functions (runTaskImportGitHubInteractive and runTaskImportFromGitHub, now listing with slim:false), both extension tools, and dashboard single/batch routes; removed the description Source-URL-regex-only importedUrls dedup.
- b2977d1: summary: Fix task chat showing a stale agent message while generating a new reply.
  category: fix
  dev: TaskPlannerChatTab now clears streamingThinking and the streaming-assistant row on fresh generations while preserving attach-to-in-flight snapshots.
- d9843f7: summary: Move project summarization model controls next to summarization settings.
  category: fix
  dev: Dashboard Project Models layout only; no settings key or persistence changes.
- a167272: summary: Chat agents no longer switch your checked-out branch unless you ask.
  category: fix
  dev: Adds a branch-stickiness clause to CHAT_SYSTEM_PROMPT in packages/dashboard/src/chat.ts.
- 0b33281: summary: Plan Review now allows more automatic replan attempts (default 8) before asking a human.
  category: internal
  dev: Raised triage PLAN_REVIEW_GATE_REPLAN_CAP from 3 to 8 in packages/engine/src/triage.ts; escalation to awaiting-approval (awaitingApprovalReason "plan-review-replan-cap") now fires at 8 consecutive REVISE replans.
- dc7bb40: summary: Prevent inline Code Review steps from failing before they can run.
  category: fix
  dev: Shares workflow write-capability classification between graph preparation and runtime.
- e83116a: summary: The GitHub/GitLab Import Tasks screen now marks an issue, PR, or item as "Imported" immediately after importing it.
  category: fix
  dev: GitHubImportModal unions a local optimistic imported-URL set (populated in handleImport/handleImportGitLab success handlers, cleared on modal reset and on provider/owner/repo/GitLab-resource change) with the tasks-derived importedUrls at every consumer (rows, count labels, top/bottom/GitLab Import buttons), so a just-imported row shows the badge and disables re-import without waiting for the tasks prop round-trip.
- 3639169: summary: Show the underlying error message for failed tool calls in the task Activity feed.
  category: fix
  dev: tool_error agent-log entries now always persist bounded `detail` regardless of `persistAgentToolOutput`; TaskChatTab renders it in an expandable "Error" block.
- cae7847: summary: Auto-merge now retries AI provider blips instead of permanently failing the task.
  category: fix
  dev: ACP provider faults (`promptAcpSession` now preserves the JSON-RPC code as `acp rpc code -32603`) classify as transient via a new `ai-provider-turn-failure` class. `classifyTransientMergeError` also delegates to `isTransientError`, so the self-healing sweep and the inline retry gate share one definition — previously network errors got inline retries but were invisible to the sweep once parked `failed`. Pure predicates moved to the import-free leaf `transient-error-patterns.ts` (re-exported from `transient-error-detector.ts`) to keep the logger chain out of the classifier per FN-5627. Transient budgets raised: `MAX_AUTO_MERGE_TRANSIENT_RETRIES` 3→5, `MAX_TRANSIENT_MERGE_RECOVERIES` 2→5.
- 7b31d54: summary: AI merge rejections now say why, and a stranded merge can be retried without waiting.
  category: fix
  dev: Two FN-8004 follow-ups. (1) The review prompt said both "End with a single decision line" and "Then list each concrete reason as a bullet"; reviewers obeyed the former, so reasons landed above the verdict where `extractRejectReasons` never looked, degrading every rejection to "rejected the merge without a stated reason" — which was then fed to the corrective re-merge as its instruction. The parser now recovers reasons from either side of the verdict (inline → after → before, capped at 8) and the prompt ordering is unambiguous. (2) `isStaleMergeActiveStatus` moves to the leaf `merge-active-status.ts`, shared by `SelfHealingManager.recoverStaleMergingStatus` and the dashboard Retry gate, which previously refused every merge-active status; an orphaned `landing` stamp is now retryable by hand while a live merge (holding the lease or refreshing `updatedAt`) is still protected.
- 402b3a9: summary: Concurrent soft-delete during a heartbeat move no longer strands an agent in error.
  category: fix
  dev: New engine classifier isConcurrentSoftDeleteRaceError short-circuits the agent-heartbeat failed-run handler for TaskDeletedError races (agent stays active, budget untouched) and emits run-audit agent:heartbeat-move-skipped-soft-delete.
- a646ae3: summary: Quick Add overseer, priority, fast, GitHub, and attach icons now render at one uniform size.
  category: fix
  dev: QuickEntryBox primary-group icon-only buttons (Eye/EyeOff, PriorityIcon, Zap, GitHub ProviderIcon, Paperclip) all use the icon-only btn-icon treatment (--icon-size-sm) for a uniform 14px cluster; ProviderIcon sizeMap unchanged.
- 08a10bf: summary: Plan Review now backs off and pauses on provider rate limits instead of retrying every 30s for hours.
  category: fix
  dev: runPlanReviewBeforeExecution fires usageLimitPauser.onUsageLimitHit for usage-limit reviewer failures (the inline reviewStep catch hid them from triage's own handler) and re-parks via computeRecoveryDecision (60s/120s/240s, terminalizing at MAX_RECOVERY_RETRIES) instead of a fixed 30s nextRecoveryAt. The borrowed recoveryRetryCount budget is cleared on any real verdict. RetryStormError gains an optional cause, surfaced as underlyingError in serializeRetryStormError, so the cap no longer masks the real error.
- 71dd191: summary: Plan Review no longer loops forever on reviewer retry storms — it fails the task with a clear error.
  category: fix
  dev: runPlanReviewBeforeExecution now terminalizes RetryStormError (status "failed", serialized error, nextRecoveryAt cleared) instead of re-queuing plan-review-unavailable, which had let reviewerFallbackRetryCount climb unbounded past maxReviewerFallbackRetries.
- 66ae82a: summary: Concurrency slider current-use dots now line up with the running-count value on the dashboard and footer.
  category: fix
  dev: Match the current-use marker's native range coordinate mapping and thumb-size edge inset in CommandCenterControls and EngineControlMenu.
- 3dcb62f: summary: Fix already-approved plans being re-asked for approval after recovery.
  category: fix
  dev: Plan-approval fingerprint now ignores auto-injected ## Original Description / Frontend UX hygiene sections so finalizeApprovedTask idempotency survives on-disk PROMPT.md injection (FN-8008). Keeps approve-plan producer and manual-gate consumer hashing identical normalized content.
- 7cec078: summary: Task-detail popups now open in — and stay scoped to — the view where you opened them.
  category: fix
  dev: isTaskPopupVisibleForView now scopes by origin view for all views (not just Board/List); taskPopupsBoardListOnly defaults on and popups dedupe per (task id, origin view) so the same task can open independently in multiple views. Escape/keyboard close carries (taskId, originView) identity. FN-8016.
- a821bce: summary: Move the room thinking-effort control from the room header into the composer Brain icon next to attach.
  category: fix
  dev: Rooms now reuse ChatThinkingLevelControl in level-only mode (showTargetSection={false}); header <select> and its CSS/shell removed. Persistence via rooms.updateRoomSettings({ thinkingLevel }) unchanged.
- 471835d: summary: Planning summary description now renders formatted markdown by default.
  category: feature
  dev: Initializes the Planning summary renderMarkdown state to true.
- b885aff: summary: Fix dashboard secondary text labels rendering an unintended color from an undefined CSS token.
  category: fix
  dev: Migrate var(--text-secondary) to var(--text-muted) in four dashboard component stylesheets (FN-8043).
- 375368e: summary: Ensure required database schemas always initialize before plugin tables on boot.
  category: fix
  dev: applySchemaBaseline now runs CREATE SCHEMA IF NOT EXISTS project/central/archive unconditionally before plugin schema-init hooks (FN-8051).
- e40f76f: summary: Planning Mode and interview questions now render markdown formatting correctly.
  category: fix
  dev: Reuse MailboxMessageContent for AI-authored question titles and descriptions.
- 39d76fd: summary: Fix chat room messages rendering out of chronological order.
  category: fix
  dev: Normalize newest-first room API snapshots before display and warm-cache hydration.
- 90ce57f: summary: Auto-summarized task titles now match the language of the task description.
  category: fix
  dev: The existing ai-summarize prompt uses a synchronous input-language hint with no extra model calls.
- 297edd9: summary: Keep task deletion confirmations visible until users explicitly choose an action.
  category: fix
  dev: Backdrop dismissal now requires an overlay-originated press, preventing the delete trigger's trailing click from cancelling the portaled confirmation.
- 291fabc: summary: Preserve GitLab import tracking metadata when tasks are read or restored.
  category: fix
  dev: GitLab tracking now has archive/restore parity with the shared TaskStore mapping.
- de1638e: summary: Embedded PostgreSQL now boots on hosts with a 64MB /dev/shm.
  category: fix
  dev: Defaults the embedded lifecycle to mmap-backed primary shared memory while preserving later caller flag overrides.
- 6675cdf: summary: Preserve GitLab import tracking metadata in normal task reads.
  category: fix
  dev: GitLab tracking now uses the shared TaskStore persistence and hydration registry.
- 0e7b86e: summary: Keep the Settings GitHub star counter up to date with a lightweight, in-view refresh.
  category: fix
  dev: Reworked useGitHubStarCount with visibility-gated interval refresh, cache no-store, and a 15-minute TTL.
- f57dfc0: summary: Archiving a task now deletes its git worktree so pinned worktrees no longer leak.
  category: fix
  dev: Archive cleanup uses a store-scoped engine disposer and host-scoped worktree-path reservation; cleanup:false retains the worktree and workspace per-repo cleanup remains deferred.
- 504c702: summary: Mobile "More" navigation drawer now closes with a swipe-down gesture.
  category: fix
  dev: Adds touch drag-to-dismiss to `.mobile-more-sheet` in MobileNavBar; dismiss engages only when the sheet is scrolled to top or dragged by the handle so interior scrolling is preserved.
- 038ec04: summary: GitHub import "Close issue" button is now red and asks for confirmation before closing.
  category: fix
  dev: GitHubImportModal.handleCloseIssue gated behind useConfirm({ danger: true }); button uses btn-danger.
- f58b564: summary: Align mobile Settings provider cards with the section header's left edge.
  category: fix
  dev: Mobile-only CSS in SettingsModal.css — zero the .auth-panel-body padding-inline and reduce the scoped .auth-panel-body .auth-provider-card / .auth-section-hint / .auth-group-label horizontal inset so auth-panel cards, hint, and group-label share the header gutter; the unscoped .auth-provider-card rule (CustomProvidersSection) is left unchanged.
- d4914eb: summary: Fix fn backup and scheduled database backups in the default embedded PostgreSQL setup.
  category: fix
  dev: Tracks embedded runtime URLs with owner/joiner generation leases so stale shutdowns cannot target or clear a newer cluster.
- 3e55492: summary: Show the CLI Binary panel in default Settings instead of behind the Advanced switch.
  category: fix
  dev: Removed `cli-binary` from `ADVANCED_SETTINGS_SECTION_IDS` and relocated its navigation entry.
- 9b7f282: summary: Keep Quality hub actions visible beneath the title on mobile.
  category: fix
  dev: Scope the responsive header-wrap treatment to the bundled Quality plugin.
- 2c3a777: summary: Fix tasks stalling when a leftover git branch collided with a new worktree.
  category: fix
  dev: NativeWorktreeBackend.create now runs a collision-specific classifier that reconciles a bare "branch already exists" collision (reuse reclaimable branches, recreate merged/orphaned branches from the pinned start point) instead of re-throwing; unmerged foreign/unattributed branches are preserved and live-foreign branches still raise BranchConflictError.
- d306ab6: summary: Keep agent reads responsive by reusing the host TaskStore across extension loads.
  category: fix
  dev: Shares extension store cache state across Pi-loaded module instances to avoid dual backend boots.
- ca7a5a7: summary: Archiving a workspace task now removes its per-sub-repo worktrees.
  category: fix
  dev: Workspace archive disposal is store-scoped, awaits backend removal under canonical per-repository reservations, and quarantines paths whose removal is not explicitly reported successful.
- 4d73232: summary: Quick Add action buttons are no longer shrunk in shadcn themes.
  category: fix
  dev: Pins the .quick-entry-actions control height to literal :root tokens (28px desktop / 36px mobile) so shadcn's tighter --space-xl/--space-2xl scale no longer shrinks the composer (desktop + mobile).
- aaa9530: summary: Make Respecify replan tasks across workflow board layouts.
  category: fix
  dev: Resolves workflow planner lanes with recovery rehome and hides the unsupported archived action.
- bd8a6ae: summary: Fix excessive right padding in the task detail Feed on mobile.
  category: fix
  dev: Reduces the mobile .detail-activity inset and localizes overlay-toggle clearance to its first rows.
- 76ec933: summary: Quick Add action buttons read at a proper size on mobile.
  category: fix
  dev: Adds a mobile-only (@media max-width:768px) tokenized glyph-size override and tightened horizontal spacing to .quick-entry-actions in QuickEntryBox.css; preserves the 36px touch-target floor and leaves desktop rendering unchanged. Follow-up to FN-8147.
- c9aa3b4: summary: Fix lopsided right padding in the task detail view on mobile.
  category: fix
  dev: Sets the mobile `.detail-activity` right inset to `0` while retaining first-row overlay-toggle clearance.
- 50179ed: summary: Don't show tasks as failed with Retry while an automatic transient retry is pending.
  category: fix
  dev: Uses the shared dashboard taskRecovery predicate for recovery-state presentation.
- 5006e55: summary: Group each workflow model fallback lane directly under its primary lane in Settings.
  category: fix
  dev: Reorder WORKFLOW_MODEL_PAIRS (ProjectModelsSection) and WORKFLOW_MODEL_LANE_CATALOG (WorkflowSettingsPanel) to planning, planning-fallback, execution, execution-fallback, validator, validator-fallback. No key/persistence/resolution change.
- 25df9bf: summary: Show active task reasoning by default in Activity Live logs.
  category: feature
  dev: TaskChatThinking defaults open for in-progress and in-review Activity Live tasks.
- b687cc9: summary: Stop tasks that are still being planned from being moved to Todo prematurely.
  category: fix
  dev: Stale triage eviction retains live non-aborted sessions while reclaiming stuck-aborted and no-session hangs.
- bc7dfe4: summary: Keep task-card action menus open and usable after they receive keyboard focus.
  category: fix
  dev: Prevents portal menu autofocus from triggering the board-scroll dismissal listener.
- fd43a57: summary: Align the bundled pi coding-agent SDK to the ModelRuntime API so the engine builds.
  category: fix
  dev: Bumps @earendil-works/pi-ai and @earendil-works/pi-coding-agent floors to 0.80.10 across Fusion and reconciles the workspace lockfile.
- ced0e84: summary: Fix heartbeat multiplier so long-cadence agents stop false-flagging as stale or zombie.
  category: fix
  dev: Scheduler repair, reports health, and async heartbeat config now share one effective interval.
- 39887f5: summary: Quick Add action buttons read at a proper size on mobile.
  category: fix
  dev: Refines FN-8164 — enlarges the mobile-only (@media max-width:768px) tokenized glyph-size override across the .quick-entry-actions row and tightens horizontal spacing in QuickEntryBox.css; preserves the 36px touch-target floor and leaves desktop rendering unchanged.
- c3e98d1: summary: Refinement tasks now inherit the default workflow's optional review steps.
  category: fix
  dev: refineTaskImpl seeds enabledWorkflowSteps via materializeDefaultWorkflowSteps() and records the workflow selection, mirroring createTask (FN-8188).
- 0d2dcb3: summary: Fix lopsided right gutter in the task detail view on mobile.
  category: fix
  dev: Hides the mobile `.detail-body` scrollbar while preserving touch scrolling and the desktop scrollbar.
- ac52438: summary: Keep mobile task delete confirmations open through synthesized ghost clicks.
  category: fix
  dev: Confirms now ignore opening-gesture backdrop presses while retaining deliberate outside dismissal.
- 87ffb24: summary: Task detail action row now matches Quick Add — Eye icon for oversight, plus attach and GitHub-tracking buttons.
  category: feature
  dev: TaskDetailModal inline controls reordered to attach → GitHub → oversight(Eye) → priority → Fast; reuses existing upload and GitHub-tracking handlers. New test ids: detail-inline-attach, detail-inline-github-toggle.
- 7f175b0: summary: Task status badge now reads "Replan" instead of the raw "needs-replan" token.
  category: fix
  dev: Maps needs-replan in getTaskStatusBadgeLabel via tasks.statusReplan i18n key.
- 6183621: summary: Add tap-to-reveal names for mobile executor footer stats.
  category: feature
  dev: Portals mobile stat tooltips beyond footer clipping while preserving desktop labels.
- a51cba0: summary: Move task Merge Details from Plan to the done-only Summary tab.
  category: fix
  dev: Keeps completion and merge metadata together without adding a new task-detail tab.
- f27965d: summary: Add spacing below the Settings theme selector before the Font Size section.
  category: fix
- e445b3e: summary: Make global npm installs reliable by pinning the @earendil-works/pi-\* version set.
  category: fix
  dev: Pins pi-ai and pi-coding-agent to exact 0.80.10 and adds check-pi-versions-pinned.mjs.
- 67fac31: summary: Stop fn dashboard from making macOS rename its own local hostname over mDNS.
  category: fix
  dev: node-discovery now advertises a Fusion-owned mDNS host (fusion-<nodeId8>) instead of os.hostname(), avoiding the self-conflict rename; adds global setting `localNetworkDiscoveryEnabled` (default true) to disable LAN auto-discovery in `fn dashboard`/`fn serve`.
- 7fc4b43: summary: Prevent transient credential-file lock contention from terminating provider runs.
  category: fix
  dev: Uses queued async auth writes with a shared proper-lockfile retry budget.
- 28878d8: summary: Mission feature validator now inspects the merged commit and defers instead of false-failing on branch divergence.
  category: fix
  dev: runValidation materializes a disposable detached checkout of mergeDetails.commitSha (never baseCommitSha) and computes the stale-workspace ancestry guard against that inspection root before disposal; startValidatorRun now carries taskId.
- eb7d223: summary: Correct duplicate delegation ownership and add engine task reassignment.
  category: fix
  dev: Engine sessions now expose fn_task_assign; CLI reassignment remains fn_task_update(agentId).
- 7a50232: summary: Reject messages addressed to nonexistent agent recipients.
  category: fix
  dev: fn_send_message now validates agent recipients through the async AgentStore lookup before delivery.
- 611e51d: summary: Task detail toolbar is now icon-only and matches Quick Add — fixes the mis-sized oversight icon on mobile.
  category: fix
  dev: TaskDetailModal inline controls converted to icon-only btn-icon btn-sm (oversight Eye, flag priority trigger with dropdown, Zap fast toggle); removed bespoke svg 1em sizing so icons use the shared --icon-size-sm token. Reuses handleInlinePriorityChange/handleInlineExecutionModeToggle and existing oversight/GitHub/attach handlers.
- 26807c8: summary: Quick Add Deps/Models/Agent icons no longer render oversized on mobile.
  category: fix
  dev: Reverts FN-8186 — scopes the mobile (@media max-width:768px) glyph-size override in QuickEntryBox.css back to the primary-group icon controls so options-group glyphs (Deps/Models/Agent/Node/Workflow) fall back to their intrinsic size; desktop and the 36px touch-target floor unchanged.
- 4293826: summary: Remove the gap above the pinned provider header in model dropdowns so list rows no longer show through while scrolling.
  category: fix
  dev: CustomModelDropdown.css — zero the .model-combobox-list top padding so the sticky .model-combobox-optgroup provider header sits flush against the header stack (FN-8212 refinement of FN-8193).
- 5d2c3be: summary: The overseer eye badge no longer appears on in-progress/in-review tasks when oversight is off.
  category: fix
  dev: pollPlannerOverseer now clears retained PlannerOverseerMonitor observations (plus recovery/advisor runtime) when a task's effective plannerOversightLevel resolves to "off", so getPlannerOverseerRuntimeSnapshot returns null and TaskCard omits the Eye badge; TaskCard also guards on oversightLevel !== "off".
- f3ef60b: summary: Closed GitHub tracked issues now reliably link the landing commit.
  category: fix
  dev: GitHubTrackingCommentService re-reads the authoritative task via store.getTask before building the Done comment, so mergeDetails.commitSha present at closure time is linked even when the task:moved snapshot omitted it (autoMerge:false PR merges, no-op landings, recovery finalization). Falls back to the event snapshot on refetch failure.
- 2f7da57: summary: GitHub-import auto-translate now translates issues on every page, not just the first 50.
  category: fix
  dev: `useGitHubImportAutoTranslate` is now page-scoped, accumulates translations across page navigation, and invalidates per-issue on content change; the per-IP translate budget is raised to fit one full 300-issue fetch-cap traversal per hour.
- cdcdc32: summary: Fix the task-detail attach-file icon when the Definition tab is not open.
  category: fix
  dev: Keeps the shared fileInputRef input mounted outside tab-specific content.
- 595c27c: summary: Mobile Kanban board now magnetically snaps to a single column when you swipe between columns.
  category: fix
  dev: New app/hooks/useColumnScrollSnap.ts scroll-end snap wired to Board #board; keeps CSS scroll-snap-type: x proximity (no mandatory) to preserve the FN-001 corner-rendering fix.
- 7517f2e: summary: The board card overseer eye icon now hides when a task's oversight is off, matching the task detail.
  category: fix
  dev: TaskCard gates the planner-overseer Eye badge AND the card-header-badges wrapper predicate on the freshly-resolved effectiveOversightLevel (not just the transient snapshot's stale oversightLevel) via a shared showPlannerOverseerStateBadge boolean, so a stale non-off snapshot can no longer show an oversight icon or leave an empty header-badge shell while the Task Detail reads off.
- 62f121e: summary: Stop now disables the session advisor, and its on/off state correctly updates the task-detail oversight icon.
  category: fix
  dev: stopOverseerTask persists sessionAdvisorEnabled:false and clears the advisor runtime; TaskDetailModal effective-state derivation now honors the resolver's workflow-legacy tier (plannerOverseerAdvisorEnabled).
- d8735b3: summary: The Import from GitHub screen now shows a status indicator while issues are being translated.
  category: feature
  dev: GitHubImportModal renders the existing auto-translate loading and error state as a polite status indicator; migration 0019 backfills historic blank cache partitions so reopened stores serve durable translations.
- 669cb7c: summary: Mobile "More" menu now pins Settings to the bottom below the divider.
  category: fix
  dev: MobileNavBar renders the omitted `settings` destination after `.mobile-more-separator` instead of inline.
- b065403: summary: Hide the task-card overseer eye when the selected workflow has oversight turned off.
  category: fix
  dev: TaskCard resolves planner oversight from the per-workflow board identity and fails closed when inherited oversight cannot be resolved.
- 8e4514e: summary: fn db migrate now stamps migrated rows so tasks, config, and workflow settings stay visible after a cutover.
  category: fix
  dev: Extracts the first-boot stamping into core `stampMigratedProjectRows` (project.tasks/archived_tasks/archive.archived_tasks NULL→id, project.config ''→id, and the new project.workflow_settings/workflow_prompt_overrides rootDir-key→id re-key, all NOT_EXISTS-guarded). Shared by startup-factory Step 5.5 and `fn db migrate`, which resolves the registered project id via `lookupRegisteredProjectIdByPath(central.projects.path)` after the copy and warns when the project is unregistered.
- c6adac6: summary: Fix the mobile task detail panel being shifted left with a dead gutter on the right.
  category: fix
  dev: The full-screen mobile task-detail sheet hides all resize handles, so FN-8015's `margin-inline-end: var(--space-lg)` scrollbar/resize-hot-zone gutter on the shared `.floating-window__body` only added dead space on the right. Zeroed it for `.floating-window--task-detail` inside the mobile breakpoint; desktop resize-handle clearance is untouched.
- 79d4299: summary: Restore provider usage, workflow routing, and failed-task stability after PostgreSQL migration.
  category: fix
  dev: Refreshes migrated OAuth, surfaces re-auth failures, repairs fallback selection and Grok billing, and parks blocked retries.
- 85f8b1f: summary: Fix clean-CI packaging for bundled Quality and PostgreSQL plugins.
  category: fix
  dev: Use a runtime-only MJS core shim that bundles schema source and preserves Quality process supervision.
- 551a2a3: summary: Fix cramped GitHub/GitLab import detail header and show translated titles in its title bar.
  category: fix
  dev: Detail panel now owns a symmetric inset (right side still supplied by the FN-8015 `.floating-window__body` resize gutter — do not override that margin). Header uses a label + right-aligned action cluster instead of `space-between`, and both actions size from one rule (30px desktop / 40px mobile touch target). `.floating-window__title` switched from `display:flex` to `block` so its already-declared `text-overflow: ellipsis` actually applies — every caller passes a string title. Detail window titles read `importTranslation.display.title`, gated on `activeTab` to match `translateSelection`.
- c449379: summary: GitHub/GitLab import translations now persist across app restarts.
  category: fix
  dev: Aligns import_translation_cache write/read partitioning and adds migration 0016 for existing PostgreSQL databases.
- aa07a78: summary: Auto-recover tasks whose workflow step hits a missing or recycled worktree instead of parking them failed forever.
  category: fix
  dev: FN-7996 root cause set — `handleGraphFailure` routes `assertValidWorktreeSession` refusals from any graph node into the bounded worktree-session recovery (clear stale metadata, requeue todo, budgeted by `worktreeSessionRetryCount`); `graphFailureValue` now resolves optional-group `group::template` materialized ids so group routing values (e.g. the FN-7977 plan-review provider-failure hold) are visible; Plan Review runs from the repo root when its recorded worktree is gone (spec is store-injected).
- 9a43aa1: summary: Stop abandoned AI-session prompts when planning and interview generations are aborted.
  category: fix
  dev: Forwards AbortSignal into guarded prompt calls and disposes in-flight agent sessions on abort.
- a242f1b: summary: Preserve and isolate bundled plugin state during the PostgreSQL cutover.
  category: fix
  dev: Adds project-scoped plugin schemas, legacy ownership recovery, and atomic schema-contract enforcement.
- 5e5fa9a: summary: Stop re-asking approval for plans approved before the Original Description update.
  category: fix
  dev: `approve-plan` fingerprints the on-disk PROMPT.md, so plans approved before the `## Original Description` hygiene injection (`applyOriginalDescription`) shipped carry a hash over pre-injection content. The injection then rewrote the prompt and moved the hash, defeating FN-7569's idempotency short-circuit and re-parking unchanged plans at `awaiting-approval`. `finalizeApprovedTask` now also compares the recorded fingerprint against the as-read (pre-injection) content — safe because `written` diverges from `writtenInput` only via that injection, so both arms hash bytes the operator actually approved — and migrates the stored fingerprint forward on a legacy match so the reconciliation is one-time per task. A genuinely changed plan matches neither arm and still parks.
- 7261083: summary: Keep Global and Project MCP settings bound to their own scopes in the Settings UI.
  category: fix
  dev: SettingsModal now reads and edits MCP server configuration from the raw scoped settings response rather than the merged project-effective form, and save splitting persists changed MCP scopes independently of the currently visible section. This prevents project MCP overrides from appearing as global values, making global saves no-op, or losing edits after navigation.
- 753b1bb: summary: Cancelling a merging task now stops it immediately instead of stalling for 30 minutes.
  category: fix
  dev: The `merge` runtime primitive and legacy merge seam raced the merge only against their own 30-minute `GRAPH_MERGE_TIMEOUT_MS`, never observing the graph's abort — `WorkflowPrimitiveContext` had no `signal`. Threads the graph `AbortSignal` through `primitiveNodeContext`/`primitiveContextForNode` into both merge paths (linked via `AbortSignal.any`, timeout preserved as the wedged-queue bound) and returns a distinct `merge-cancelled` value that does not route into bounded auto-merge retry.
- 85f8b1f: summary: Multi-node fleets on shared Postgres no longer replicate tasks or settings over mesh HTTP.
  category: internal
  dev: Peer exchange queues topology/auth only; task-ID routes always allocate against shared rows; docs describe DATABASE_URL multi-node + claims.
- aa1e250: summary: Block a zero-change task from completing when its executor last failed with work unfinished.
  category: fix
  dev: FN-8141. Adds `evaluateNoOpFinalizeExecutorVeto` + `deriveExecutorSignalMemory` (pure, engine-local) giving the merger cross-stage memory of the most-recent executor overseer signal (derived from the durable `overseer:intervention` timeline). The AI empty-merge lane (`merger-ai.ts`) now vetoes a no-op finalize — moving the task back to `todo` with progress preserved and emitting `overseer:no-op-finalize-vetoed-failed-executor` — when the latest executor signal was failed-with-incomplete-work and no later execution completed green. Non-empty merges are never vetoed; defers to the FN-7514 human-control contract (user-paused / autoMerge:false).
- 2619013: summary: Fix cross-project data mixups by separating a record's owning project from PostgreSQL isolation.
  category: fix
  dev: Migration 0011 adds `owner_project_id` to research_runs, experiment_sessions, todo_lists, eval_runs, chat_sessions, chat_rooms, ai_sessions, chat_token_usage, project_insights, project_insight_runs, and cli_sessions (backfilled from the previously conflated `project_id`, `__legacy_unscoped__` → NULL). Stores now write/read the domain project through `owner_project_id`; `project_id` stays the RLS partition owned by the `fusion_assign_project_id` trigger and the `fusion.project_id` GUC, fixing composite-FK 23503 failures when a caller's domain projectId differed from the session partition.
- c15c78f: summary: Stop logging a false "operator action required" pause-abort failure on tasks that already merged and completed.
  category: fix
  dev: handleGraphFailure's operator-action sink now classifies pause-aborts on done/archived tasks as benign (marker cleared, worktree slot released, no PAUSE_ABORT_PARK log) — the merge boundary's in-progress→in-review hard-cancel fired it on every successful auto-merge.
- c15c78f: summary: Fix Artifacts, Documents, and Evals dashboard views returning 500 in PostgreSQL mode.
  category: fix
  dev: listArtifactsImpl/getAllDocumentsImpl now branch on store.backendMode and delegate to AsyncDataLayer helpers (listArtifacts/getAllDocuments in async-comments-attachments.ts); getEvalStore() returns a new AsyncEvalStore (async-eval-store.ts) in backend mode. evals-routes await the store calls; eval-automation/eval-followups handle the EvalStore | AsyncEvalStore union (instanceof guard / await).
- fbcd002: summary: Stop PostgreSQL-mode boots from opening and checkpointing the legacy SQLite files.
  category: fix
  dev: The first-boot auto-migration guard probed .fusion/fusion.db with a read-write DatabaseSync open on every boot, performing WAL recovery + checkpoint (file writes). The PostgreSQL emptiness count now runs first; the SQLite probe only runs on the empty-PG path where auto-migration is actually considered, so steady-state PG boots leave the legacy files byte-quiet.
- eb5c81c: summary: Fix startup failure where the SQLite → PostgreSQL migration aborted on CE session timestamps.
  category: fix
  dev: project.ce_sessions.last_activity_at was `integer` but stores epoch milliseconds, overflowing PG int4 and failing first-boot auto-migration. Now `bigint` in the Drizzle shape and CE plugin schema-hook DDL, with an idempotent `ALTER COLUMN ... TYPE bigint` for datadirs that already materialized the integer column.
- 8596035: summary: Fix engine failing to connect after the PostgreSQL migration with "Project not found".
  category: fix
  dev: getOrCreateForProjectImpl built its fallback CentralCore without the AsyncDataLayer; post-cutover a layer-less CentralCore has no database (legacy SQLite CentralDatabase is deleted), so projectId-only boots (engine InProcessRuntime, dashboard project-store-resolver) threw ProjectRequiredError despite the row existing in central.projects. The fallback is now bound to the caller's layer.
- 3ccc9f9: summary: Bind dashboard/serve stores to the central project registry instead of relying on cwd identity.
  category: fix
  dev: createTaskStoreForBackend now resolves the central-registry project id for rootDir-only boots (fn dashboard, fn serve, desktop, per-path project stores) and binds the AsyncDataLayer to it — cwd/rootDir is only a lookup key into central.projects; identity/partitioning comes from the registry. Also re-keys the migrated legacy config row ('' → project id) during first-boot auto-migration so bound readers keep the migrated settings, workflowSteps, taskPrefix, and nextId counters. Unregistered paths still boot unbound (legacy single-project behavior).
- c15c78f: summary: CLI agent tools now boot PostgreSQL instead of the removed SQLite runtime.
  category: fix
  dev: The extension's getStore(cwd) path constructed a legacy SQLite TaskStore (runtime removed under VAL-REMOVAL-005), and the fn*agent*\* tools constructed AgentStore without an asyncLayer — both threw "SQLite Database class body has been removed" in PG mode. getStore now routes through createTaskStoreForBackend (mirroring fn serve) and caches the boot result for deterministic shutdown; a new getAgentStore(cwd) helper injects the project store's asyncLayer into AgentStore so agent data lives in PostgreSQL. CLI extension tests were migrated to a shared PG harness (pg-extension-harness.ts) backed by an isolated test database with a test-only store-injection hook (\_\_setCachedStoreForTesting).
- c15c78f: summary: Standalone CLI, GitLab analytics, and plugin stores now run on PostgreSQL.
  category: fix
  dev: Orchestrated audit + fix of remaining un-migrated SQLite surfaces. CLI: project-context/project-resolver + the fn task/agent/git/research/settings/desktop/experiment commands now boot via createTaskStoreForBackend and inject asyncLayer into AgentStore; fn_agent_update/fn_mission_list/mission-list gained backendMode branches. Core: 15 task-store Impls (merge-request record, commit-association upsert/read, stale-branch cleanup, run-audit-events read, task-document delete/revisions, github-tracking reconcile, activity/run-audit snapshots, occupants, stranded-refinements, orphaned-task-dir reconcile) gained backendMode branches (8 real Drizzle, 7 graceful sync-safe-defaults following the getTaskWorkflowSelection precedent); AgentStore gained backendMode branches for 9 snapshot/blocked-state/config-revision methods. Dashboard: GitLab analytics gained an async variant (aggregateGitlabIssueAnalyticsAsync) + the agent-token-totals + OTLP exporter paths now use the async layer. Plugins (compound-engineering pipeline-store, reports, cli-printing-press) gained isBackendMode degrade-guards. Added the missing project.chat_token_usage PG table (schema + migration + registry + created_at index) that the upstream merge referenced but never defined. Merge gate green (engine-core 287 + core pg-gate 94 + ci-shape 63); all packages typecheck clean.
- c15c78f: summary: Root project-scoped PostgreSQL stores and merges at the project directory, and fix backend-mode agent watching.
  category: fix
  dev: createTaskStoreForBackend honors an explicit rootDir over projectId re-resolution (stale bootstrap PROMPT.md pinned cards "unplanned"); drainMergeQueue roots git operations at store.getRootDir() (merges aborted with branch-missing in in-process dashboards); AgentStore.startWatching no longer trips the sqlite getLastModified gate in backend mode.
- c15c78f: summary: Fix post-insert task rollback and add GitLab tracking reconcile.
  category: fix
  dev: Adds a catch/cleanup around `_createTaskInternalBackendImpl` post-insert filesystem work so a writeTaskJsonFile or prompt-validation failure soft-deletes the inserted row (FN-7074 invariant). Adds `listTasksForGitlabTrackingReconcile` TaskStore facade mirroring the GitHub counterpart.
- c15c78f: summary: Mailbox — sending a message to an agent works in PG mode instead of erroring.
  category: fix
  dev: POST /api/messages to an agent 500'd in embedded-PG mode: MessageStore.sendMessage persisted the message via the async layer, then synchronously invoked the agent-delivery hook (agent-heartbeat.handleMessageToAgent), which reads the not-yet-ported sync AgentStore and throws. The persisted send must not fail on a notification side-effect, so the onMessageToAgent hook call is now wrapped — a hook failure logs and degrades (agent wake-on-message stays disabled in PG mode until AgentStore is ported) instead of failing the send. Adds message-store.pg.test.ts to test:pg-gate.
- 0f3a3d3: summary: Fix empty task board after the PostgreSQL migration when booting via fn dashboard.
  category: fix
  dev: The first-boot auto-migration only stamped migrated rows' project_id when the boot passed a bound projectId, but `fn dashboard` boots with rootDir only — so rows stayed NULL and every project-bound reader (engine, project-store-resolver) filtered them out. The stamping id is now resolved from the just-migrated central registry by matching the registered project path to rootDir; unregistered single-project setups still leave rows NULL for their unbound (unfiltered) readers.
- fbcd002: summary: Fix SQLite → PostgreSQL migration silently skipping legacy camelCase tables.
  category: fix
  dev: The migrator snake_cased column names but matched TABLE names verbatim, so all 22 legacy camelCase SQLite tables (activityLog, runAuditEvents, mergeQueue, taskClaims, projectNodePathMappings, …) found no PostgreSQL counterpart and were silently skipped — surfacing as "Project/node path mapping not found" on engine start. TablePlan now carries a snake_cased pgTable used for all PostgreSQL-side operations. Re-run `fn db migrate` (idempotent) to top up databases migrated before this fix. Migration reports also now count inserted rows via RETURNING (previously "inserted 0" even when every row landed).
- b5c76af: summary: Preserve PostgreSQL jsonb defaults when legacy SQLite rows contain NULL.
  category: fix
  dev: The SQLite-to-PostgreSQL migrator now reads target nullability and jsonb defaults, replacing legacy NULL or empty-string values only for NOT NULL jsonb columns with valid defaults. This prevents first-boot migration failures such as research_runs.sources violating its NOT NULL constraint while keeping checksum verification aligned with the migrated values.
- 379d450: summary: Preserve legacy empty JSON text during PostgreSQL cutover.
  category: fix
  dev: Required jsonb columns without defaults now retain empty, whitespace-only, malformed, and scalar SQLite values without weakening nullable/default handling.
- c15c78f: summary: Not-yet-ported features (missions, insights, research, goals) degrade cleanly in PG mode instead of erroring.
  category: fix
  dev: Adds backendMode guards to the dashboard route choke-points that call satellite stores not yet on the AsyncDataLayer (getResearchStore/getInsightStore/getMissionStore/getGoalStore). They now return HTTP 503 "not yet available in PG backend mode" (matching the existing command-center team/productivity/token guards) instead of letting the store getter throw an unhandled 500. The SSE handler also degrades: ResearchStore access is wrapped so the event stream still serves every other event type instead of failing the whole connection when research run-events cannot be subscribed in PG mode. Full PG ports of these stores remain (TodoStore is done); these guards are the correct interim state until each lands.
- c15c78f: summary: Regression storm-guard and agent wake-on-message work on the PostgreSQL backend.
  category: fix
  dev: monitor-trait runMonitorOnRegression drops its backend-mode early return and routes the storm guard (countRecentAutoFixTasksAsync/claimIncidentForFixTaskAsync/attachFixTaskAsync/releaseIncidentFixTaskClaimAsync) through the AsyncDataLayer in PG, preserving the claim→createTask→attach→release semantics. The agent wake hook handleMessageToAgent becomes async and reads via AgentStore.getAgent (async) instead of the sync getCachedAgent that threw in PG; the onMessageToAgent hook type widens to allow a Promise and message-store awaits it inside its existing send-never-fails try/catch.
- c15c78f: summary: Fix PostgreSQL-mode merge recovery, lost task-field writes, first-boot SQLite auto-migration, and backup tool discovery.
  category: fix
  dev: recoverStaleTransitionPending ported to backend mode (async-transition-pending.ts); backend moves now write/clear the crash-safe transitionPending marker; atomicWriteTaskJson/WithAudit write changed columns instead of full-row upserts (lost-update class behind stuck "unplanned" cards); createTaskStoreForBackend auto-migrates legacy fusion.db into an empty PG database on first boot (loud failure, SQLite kept as backup); PgBackupManager resolves pg_dump/pg_restore from common install locations when not on PATH.
- c15c78f: summary: Speed up board listing and agent chat on PostgreSQL with SQL-side pagination and a conversation history cap.
  category: performance
  dev: Closes the two open PR #1793 review findings — readLiveTaskRows now pushes column filters + ORDER BY (created_at, numeric id suffix) + LIMIT/OFFSET into SQL instead of scanning and hydrating the whole task table per listTasks; getConversation is capped to the most recent 200 messages by default (options.limit overrides, oldest-first order preserved) in both the async and sqlite paths.
- c15c78f: summary: Incident-signal ingestion records incidents on the PostgreSQL backend instead of being skipped.
  category: fix
  dev: ingestIncidentSignal now accepts Database | AsyncDataLayer and branches to ingestIncidentSignalAsync (project.incidents upsert by grouping key — absorb-or-create, occurrences/firstFiredAt preserved) in PG mode; the signal route awaits it instead of warn-skipping. monitor-trait's storm-guard helpers remain sync-only (async equivalents exist; follow-up).
- c15c78f: summary: Workflow definitions load in PG mode — /api/workflows no longer errors.
  category: fix
  dev: readAllWorkflowDefinitions/getWorkflowDefinition read custom rows from project.workflows via the AsyncDataLayer in backend mode (the sync store.db SELECT threw, 500'ing /api/workflows). New async-workflow-store.ts helpers re-stringify jsonb ir/layout for the shared toWorkflowDefinition mapper; builtins still come from code constants. Every caller already awaited these reads, so no consumer changes. Adds workflow-definitions.pg.test.ts to test:pg-gate.
- cdf67c1: summary: Fix Planning Mode getting stuck retrying and re-asking a question that was already answered.
  category: fix
  dev: Sessions now clear `currentQuestion` the moment an answer is accepted (Planning Mode and agent onboarding), `retrySession` scrubs stale questions from pre-fix rows, and restored sessions only keep a question when the persisted row is `awaiting_input`. This stops the SSE catch-up path from re-emitting answered questions to the fresh connections opened by FN-7946 auto-retries, which reset the bounded retry budget and looped forever.
- c15c78f: summary: Fix PostgreSQL-mode crashes — agent-log flush no longer kills the server, and Command Center activity loads.
  category: fix
  dev: The agent-log buffer flush/append path (flushAgentLogBufferImpl, appendAgentLogBatchImpl, appendAgentLogImpl) dereferenced the SQLite-only `store.db` getter — which throws in PG backend mode — on an unref'd retry-timer and inside catch handlers, so a handled flush error became an uncaught exception that exited `fn serve` (~35s uptime). Guarded the deleted-task pre-filter and `bumpLastModified` with `!store.backendMode` and replaced every `store.db.path` log interpolation with the mode-safe `store.fusionDir`. Also schema-qualified raw async SQL that referenced project-schema tables unqualified / with camelCase columns: `project.deployments` + `project.incidents` with snake_case `deployed_at`/`opened_at`/`resolved_at` (the deployments read sat outside the try/catch and 500'd `/api/command-center/activity`), `project.experiment_session_records` (+ `::jsonb` cast on the payload update), and `project.agent_runs`. Adds a backend-mode regression test pinning the no-`store.db`-deref invariant across all three agent-log entry points.
- 97172fd: summary: Ensure PostgreSQL-backed CLI commands release project resources before exiting.
  category: fix
  dev: Rebases the CLI cutover onto the merged core/runtime stack and makes factory shutdown ownership explicit.
- c15c78f: summary: Fix task creation dropping the workflow selection when a workflow and step toggles are submitted together.
  category: fix
  dev: PostgreSQL create paths in task-creation.ts predated the SQLite-side FNXC:WorkflowCreation 2026-06-28 fix; they now record task_workflow_selection with explicit stepIds, and serialization.ts hydrates an explicit empty enabledWorkflowSteps as [] (not undefined). Store-integration coverage in builtin-workflows.test.ts ported to the shared PG harness (pgDescribe).
- c15c78f: summary: Fix custom workflow columns on PostgreSQL: tasks land in their workflow's intake column and can move out of it.
  category: fix
  dev: Backend create paths now thread resolvedEntryColumn (workflow manual intake, e.g. Coding (Ideas) "ideas") into task creation and the bootstrap-prompt gate; move validation resolves the task workflow IR via getTaskWorkflowSelectionAsync in backend mode (the sync resolver silently fell back to builtin:coding and rejected every move out of a custom column).
- c15c78f: summary: Fix residual SQLite store constructions so chat, messages, backups, MCP secrets, and project setup work on PostgreSQL.
  category: fix
  dev: Routes remaining `new TaskStore`/`new AgentStore`/`createDatabase` call sites through `createTaskStoreForBackend`/`resolveAgentStoreBase` (chat.ts, message.ts, task.ts, pr.ts, backup.ts, memory-backup.ts, branch-group.ts, mcp.ts, project.ts, dashboard.ts getProjectStore, dashboard register-project-routes). Also fixes cli-printing-press plugin Drizzle row typing.
- c25f8b7: summary: Make PostgreSQL cutover fail safely and preserve project-scoped core data.
  category: fix
  dev: Adds versioned tenant isolation, dedicated migration sessions, and strict SQLite cutover verification.
- d8f0b1a: summary: Restore PostgreSQL persistence across bundled workflows and integrations.
  category: fix
  dev: Adds async engine, research, roadmap, Compound Engineering, and WhatsApp PostgreSQL parity.
- ab22855: summary: Keep multi-node management connected to the active PostgreSQL registry.
  category: fix
  dev: Node CRUD, health, path, version, plugin, and Docker-config routes now reuse the server-injected CentralCore.
- c15c78f: summary: Fix PostgreSQL performance and credential-redaction gaps surfaced by the migration review.
  category: performance
  dev: Adds missing index on tasks.source_parent_task_id (lineage gate was a full scan) and a partial index for the live kanban `WHERE deleted_at IS NULL AND column = ?` read. Batches merge-queue stale-row cleanup to remove an N+1 on lease acquire. Pushes LIMIT into SQL for audit/activity-log queries. Drops the heavy `log` jsonb column from slim board hydration. Fixes the monitor-store backend discriminator (`"ping" in db`, not the ambiguous `"transactionImmediate" in db`), awaits the now-async resolveIncident in signal routes, and redacts `?password=` query-param URLs.
- c15c78f: summary: Restore stalled-review badges, timed-execution totals, and fresh-agent-log stall suppression on board listings.
  category: fix
  dev: Backend listTasks no longer excludes the log column in slim mode (stalledReview and timedExecutionMs derive from it before the log is stripped), and hasFreshAgentLogActivitySinceTaskUpdate is ported into all task-store read hydration paths so streaming merge/review agents suppress Stalled/Merge-stalled badges (mirrors main's FNXC:WorkflowLifecycle 2026-07-01 behavior lost in the PG cutover store split).
- c5aa5ec: summary: Keep the quick-add Save button inline with its icon controls and center the control rows on mobile.
  category: fix
  dev: Mobile-scoped `.quick-entry-primary-group`/`.quick-entry-options-group` gap, icon min-width, and row-centering changes in QuickEntryBox.css; touch-target height unchanged.
- 7c8a84f: summary: Make SQLite cutover converge when multiple registered projects share embedded PostgreSQL.
  category: fix
  dev: Central data migrates once; project metadata and local revision identities are isolated during retries.
- 3e978e1: summary: Quiet repetitive scheduler hold-release and task-routing lines that flooded the engine log pane.
  category: fix
  dev: Adds `Logger.debug()` in `packages/engine/src/logger.ts`, gated per subsystem by `FUSION_DEBUG` (`1`/`true`/`all`/`*`, or a comma-separated prefix list). Demotes `Hold release for <id> deferred — no reservable slot` and local-only `Task <id> routed to node=local` to debug; remote routing stays at info. See `docs/diagnostics.md`.
- f6e43d7: summary: Merge autostashes no longer pile up in `git stash list`, and untracked work in them is never dropped.
  category: fix
  dev: `merger-ai`'s local-checkout sync labelled stashes `fusion-ai-merge-sync-<taskId>`, which no reclamation path in `merger.ts` matched (all key off `fusion-merger-autostash:`) — they were never classified, subsumed-dropped, age-swept, or surfaced as orphans. It now labels via the new exported `buildAutostashLabel(taskId, "ai-local-sync", ts)`; the legacy prefix stays recognized so already-leaked entries are reclaimed rather than stranded. Separately, `--include-untracked` stashes keep untracked files in a third parent (`<sha>^3`) that `git stash show` omits, so an untracked-only stash read as empty and empty meant "subsumed → drop". Liveness now resolves through one authority, `classifyStashContent`, which enumerates both sides, diffs untracked paths against `<sha>^3`, and treats unreadable state as `unknown` (never dropped); it replaces three divergent copies of the check. Age-based sweeping is unchanged deliberate bounded retention.
- 2b8df56: summary: Stop reviewer rate limits and network blips from looping and spamming the task log.
  category: fix
  dev: The reviewer was the only AI lane that never classified provider errors, so a 429 became an `UNAVAILABLE` verdict. With no validator fallback configured the fallback ladder re-ran the SAME model instantly, and `fn_review_step` told the agent "code review remains blocking; retry once" — bounding the loop with prompt text rather than code. The tool's catch-all also swallowed the error into tool output, so `withRateLimitRetry`, `UsageLimitPauser`, and `RetryStormError` never fired. Reviewer provider failures now throw `ReviewerProviderError` (usage-limit → global pause; transient → bounded recovery), transient blips retry in-lane with jittered backoff via `withRetry`, code review gets a real `MAX_CODE_REVIEW_UNAVAILABLE_RETRIES` counter, and the fatal escapes `agentWork` via `throwDeferredReviewerFatal` (pi-agent-core converts tool throws into `tool_error` results, so a tool cannot throw out of `session.prompt()`). Separately, `AgentLogType` gains `status` for complete engine messages: `text` means "streamed delta" and is re-glued with `join("")`, which is why N standalone markers rendered as one run-on string.
- 9a34862: summary: Safely classify and resolve whitespace-only merge conflicts.
  category: fix
  dev: Use argument-array Git calls and resolve the selected index version before staging.
- e3f9825: summary: Prevent bundled plugin commands from delaying or crashing the Fusion CLI on spawn failures.
  category: fix
  dev: Absorbs child spawn errors and unrefs SIGKILL escalation timers in the plugin SDK runtime shim.
- 4b7f0d2: summary: Settings: consistent checkbox theming, inline help moved behind "?" icons, mobile ntfy help bubble fix.
  category: fix
  dev: New `.settings-modal input[type="checkbox"]` rule unifies accent/size; SettingsHelpTip mobile positioned-ancestor list now includes `.notification-provider-header` and `.settings-field-label-row`; all bespoke inline `<small>` help across settings sections migrated to SettingsHelpTip.
- a136535: summary: Block tasks that skip unreviewed steps after a completion refusal from auto-promoting to review.
  category: fix
  dev: New persisted task field `bulkCompletionRefusalAt` is stamped when the executor's `bulk-step-completion-without-review` refusal fires; the pure `evaluateSkipBypassTaint` (in @fusion/core) makes skipped-after-refusal steps not count toward any AUTO-promotion path (executor implicit-completion/finalize, `recoverCompletedTask`, self-healing stuck-in-progress + stranded-todo recovery, graph merge-boundary proof). Cleared on an accepted fn_task_done or operator manual retry; the PREMISE STALE accepted-done flow is unaffected (FN-8141).
- 136958f: summary: Self-healing no longer promotes a failed/refused task into review after its work was reverted.
  category: fix
  dev: FN-8141 — new pure evaluator `evaluateCompletedPromotionFailureProvenance` (@fusion/core) reads the durable task log tail; both stranded-completed promoters (`recoverCompletedTasks` stuck-in-progress and `recoverStrandedCompletedTodoTasks` stranded-todo) and the shared `recoverCompletedTask` chokepoint now withhold promotion when the most recent execution-outcome was a failure/refusal park, emitting a deduped `task:reconcile-stranded-completed-no-action` run-audit event (reason `failure-provenance`). A fresh clean execution (operator retry) supersedes the park.
- 945d629: summary: Preserve legacy migration data and isolate PostgreSQL records, task IDs, and merge queues by project.
  category: fix
  dev: Adds lossless legacy-table migration, strict source-column checks, project RLS, and project-local allocation keys.
- 4e4b6be: summary: Stop triage Plan Review from looping to the replan cap by converging the spec reviewer.
  category: fix
  dev: reviewStep/buildReviewRequest now thread the reviewer's own prior Plan Review feedback plus the replan attempt (spec gate only); at attempt 3+ the reviewer gates on critical issues only. Reviewer and planner prompts add spec-altitude, prior-issue-verification, front-loaded surface enumeration, and Postgres-only storage ground-truth rules.
- 0753476: summary: A task actively re-executing can no longer launder an empty reverted branch into done.
  category: fix
  dev: FN-8141 follow-up 3. `deriveExecutorSignalMemory` (packages/engine/src/overseer-noop-finalize-veto.ts) no longer lets a mid-execution `progressing` overseer observation clear the no-op-finalize veto. A failure park is superseded only by a clean-completion task-log marker (shared `CLEAN_COMPLETION_MARKERS` exported from @fusion/core) strictly newer than it; the executor stage emits no green-completion observation. `merger-ai.ts` threads `task.log` into the derivation.
- c0d610d: summary: Fix WhatsApp Chat plugin failing to connect (405 rejection) and its bundled build failing to load.
  category: fix
  dev: connect() now passes fetchLatestBaileysVersion() to makeWASocket so WhatsApp accepts the handshake; /status exposes lastError; plugin bundled.js builds get the createRequire ESM banner so CJS deps (Baileys) can require node builtins.
- 6c00841: summary: Embedded Postgres now boots on Windows when Fusion runs elevated, fixing the Windows installer build.
  category: fix
  dev: On elevated Windows the postgres server is booted under a dedicated non-admin local user via Start-Process -Credential (packages/core embedded-lifecycle.ts + embedded-windows-admin.ts); initdb and the pg client still run as the launching process.
- 8e4514e: summary: Fix workflow settings and prompt overrides appearing reset after the PostgreSQL migration.
  category: fix
  dev: getWorkflowSettingsProjectId now resolves the central-registry id from the bound AsyncDataLayer first. In PG mode the SQLite stub's getProjectIdentity() throws, so the old code always fell through to the rootDir path string — workflow_settings/workflow_prompt_overrides rows were keyed by an absolute path nothing else could find. Legacy path-keyed rows are re-keyed by migration stamping.

### runfusion.ai

#### Patch Changes

- Updated dependencies [80f2028]
- Updated dependencies [7daa16f]
- Updated dependencies [db05a77]
- Updated dependencies [47f9aa7]
- Updated dependencies [6206af8]
- Updated dependencies [9b9d6a2]
- Updated dependencies [2d61976]
- Updated dependencies [f116d05]
- Updated dependencies [883f38d]
- Updated dependencies [678265a]
- Updated dependencies [514ccd3]
- Updated dependencies [945d629]
- Updated dependencies [be55d0a]
- Updated dependencies [0312d2e]
- Updated dependencies [30a83f2]
- Updated dependencies [f111a40]
- Updated dependencies [130c702]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [e33039a]
- Updated dependencies [19eb179]
- Updated dependencies [1c4fdb7]
- Updated dependencies [9a37415]
- Updated dependencies [9aa2852]
- Updated dependencies [46866a5]
- Updated dependencies [e9f14bf]
- Updated dependencies [05151a2]
- Updated dependencies [a242f1b]
- Updated dependencies [c15c78f]
- Updated dependencies [703488f]
- Updated dependencies [4b150e2]
- Updated dependencies [329fc1f]
- Updated dependencies [d1e9b56]
- Updated dependencies [4f03767]
- Updated dependencies [e97081f]
- Updated dependencies [7aeefe2]
- Updated dependencies [99870ba]
- Updated dependencies [5acea6c]
- Updated dependencies [bc34834]
- Updated dependencies [3fce536]
- Updated dependencies [78ef307]
- Updated dependencies [daa34fb]
- Updated dependencies [f079245]
- Updated dependencies [1d6a044]
- Updated dependencies [c15c78f]
- Updated dependencies [03966ec]
- Updated dependencies [5185914]
- Updated dependencies [1b9c7a7]
- Updated dependencies [71275ab]
- Updated dependencies [d48537b]
- Updated dependencies [6e0fde8]
- Updated dependencies [49a459a]
- Updated dependencies [9bdbdc5]
- Updated dependencies [d956abc]
- Updated dependencies [16b0109]
- Updated dependencies [ddc8e6d]
- Updated dependencies [ec78981]
- Updated dependencies [de25e32]
- Updated dependencies [a8b6387]
- Updated dependencies [6ca7e48]
- Updated dependencies [f1b528f]
- Updated dependencies [0e84731]
- Updated dependencies [f9c19f9]
- Updated dependencies [6e3a338]
- Updated dependencies [c0bef0b]
- Updated dependencies [1c02e68]
- Updated dependencies [d893a02]
- Updated dependencies [aa0d863]
- Updated dependencies [2179a61]
- Updated dependencies [d74018f]
- Updated dependencies [836e53c]
- Updated dependencies [5ff7a20]
- Updated dependencies [214af98]
- Updated dependencies [10b8045]
- Updated dependencies [b2977d1]
- Updated dependencies [d9843f7]
- Updated dependencies [a167272]
- Updated dependencies [e46ffeb]
- Updated dependencies [0b33281]
- Updated dependencies [667f4c8]
- Updated dependencies [dc7bb40]
- Updated dependencies [e83116a]
- Updated dependencies [3639169]
- Updated dependencies [60b6e3e]
- Updated dependencies [d870878]
- Updated dependencies [96b1f21]
- Updated dependencies [cae7847]
- Updated dependencies [7b31d54]
- Updated dependencies [402b3a9]
- Updated dependencies [a646ae3]
- Updated dependencies [08a10bf]
- Updated dependencies [71dd191]
- Updated dependencies [66ae82a]
- Updated dependencies [3dcb62f]
- Updated dependencies [7cec078]
- Updated dependencies [adcba0e]
- Updated dependencies [a821bce]
- Updated dependencies [471835d]
- Updated dependencies [72378cb]
- Updated dependencies [5b4ec4c]
- Updated dependencies [b885aff]
- Updated dependencies [375368e]
- Updated dependencies [e87b51b]
- Updated dependencies [274318a]
- Updated dependencies [e40f76f]
- Updated dependencies [3f133e0]
- Updated dependencies [39d76fd]
- Updated dependencies [c2475b0]
- Updated dependencies [f3b68c9]
- Updated dependencies [99b79e4]
- Updated dependencies [19ab7a9]
- Updated dependencies [5661582]
- Updated dependencies [90ce57f]
- Updated dependencies [f63818a]
- Updated dependencies [297edd9]
- Updated dependencies [291fabc]
- Updated dependencies [de1638e]
- Updated dependencies [6675cdf]
- Updated dependencies [1a337df]
- Updated dependencies [0e7b86e]
- Updated dependencies [f57dfc0]
- Updated dependencies [504c702]
- Updated dependencies [5f70447]
- Updated dependencies [68583b5]
- Updated dependencies [038ec04]
- Updated dependencies [fd03666]
- Updated dependencies [f58b564]
- Updated dependencies [e72629c]
- Updated dependencies [d4914eb]
- Updated dependencies [3e55492]
- Updated dependencies [c6be0b1]
- Updated dependencies [9b7f282]
- Updated dependencies [2c3a777]
- Updated dependencies [4df5c62]
- Updated dependencies [255e9c1]
- Updated dependencies [6f99fdb]
- Updated dependencies [e7c5de0]
- Updated dependencies [d306ab6]
- Updated dependencies [ca7a5a7]
- Updated dependencies [4d73232]
- Updated dependencies [aaa9530]
- Updated dependencies [07e1ceb]
- Updated dependencies [bd8a6ae]
- Updated dependencies [76ec933]
- Updated dependencies [c9aa3b4]
- Updated dependencies [50179ed]
- Updated dependencies [5006e55]
- Updated dependencies [25df9bf]
- Updated dependencies [b687cc9]
- Updated dependencies [bc7dfe4]
- Updated dependencies [fd43a57]
- Updated dependencies [26cb0cc]
- Updated dependencies [ced0e84]
- Updated dependencies [39887f5]
- Updated dependencies [c3e98d1]
- Updated dependencies [0d2dcb3]
- Updated dependencies [ac52438]
- Updated dependencies [3fdc2c1]
- Updated dependencies [87ffb24]
- Updated dependencies [7f175b0]
- Updated dependencies [6183621]
- Updated dependencies [a51cba0]
- Updated dependencies [7b54095]
- Updated dependencies [f27965d]
- Updated dependencies [e445b3e]
- Updated dependencies [67fac31]
- Updated dependencies [d6860b5]
- Updated dependencies [7fc4b43]
- Updated dependencies [28878d8]
- Updated dependencies [eb7d223]
- Updated dependencies [7a50232]
- Updated dependencies [611e51d]
- Updated dependencies [26807c8]
- Updated dependencies [4293826]
- Updated dependencies [86c281b]
- Updated dependencies [5d2c3be]
- Updated dependencies [adb3eb3]
- Updated dependencies [f3ef60b]
- Updated dependencies [9152d8f]
- Updated dependencies [2f7da57]
- Updated dependencies [cdcdc32]
- Updated dependencies [595c27c]
- Updated dependencies [44c7842]
- Updated dependencies [7517f2e]
- Updated dependencies [62f121e]
- Updated dependencies [d8735b3]
- Updated dependencies [669cb7c]
- Updated dependencies [b065403]
- Updated dependencies [8e4514e]
- Updated dependencies [c6adac6]
- Updated dependencies [79d4299]
- Updated dependencies [85f8b1f]
- Updated dependencies [1d0feb2]
- Updated dependencies [0863c0f]
- Updated dependencies [5ab46a6]
- Updated dependencies [551a2a3]
- Updated dependencies [203557e]
- Updated dependencies [bc2d22d]
- Updated dependencies [c449379]
- Updated dependencies [aa07a78]
- Updated dependencies [9a43aa1]
- Updated dependencies [a242f1b]
- Updated dependencies [5e5fa9a]
- Updated dependencies [7261083]
- Updated dependencies [753b1bb]
- Updated dependencies [85f8b1f]
- Updated dependencies [8fe122d]
- Updated dependencies [aa1e250]
- Updated dependencies [4f03767]
- Updated dependencies [2619013]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [fbcd002]
- Updated dependencies [eb5c81c]
- Updated dependencies [8596035]
- Updated dependencies [3ccc9f9]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [0f3a3d3]
- Updated dependencies [fbcd002]
- Updated dependencies [b5c76af]
- Updated dependencies [379d450]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [4e4b6be]
- Updated dependencies [cdf67c1]
- Updated dependencies [cdf67c1]
- Updated dependencies [c15c78f]
- Updated dependencies [97172fd]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [c25f8b7]
- Updated dependencies [d8f0b1a]
- Updated dependencies [ab22855]
- Updated dependencies [c15c78f]
- Updated dependencies [c15c78f]
- Updated dependencies [e3f9825]
- Updated dependencies [c5aa5ec]
- Updated dependencies [7c8a84f]
- Updated dependencies [3e978e1]
- Updated dependencies [f6e43d7]
- Updated dependencies [2b8df56]
- Updated dependencies [9a34862]
- Updated dependencies [e3f9825]
- Updated dependencies [4f03767]
- Updated dependencies [4b7f0d2]
- Updated dependencies [55745af]
- Updated dependencies [a136535]
- Updated dependencies [136958f]
- Updated dependencies [945d629]
- Updated dependencies [edc6413]
- Updated dependencies [c15c78f]
- Updated dependencies [4e4b6be]
- Updated dependencies [0753476]
- Updated dependencies [c0d610d]
- Updated dependencies [6c00841]
- Updated dependencies [8e4514e]
  - @runfusion/fusion@0.61.0

## 0.60.0

### @fusion/dashboard

#### Patch Changes

- @fusion/core@0.60.0
- @fusion/engine@0.60.0
- @fusion/i18n@0.39.25
- @fusion-plugin-examples/cli-printing-press@0.1.42
- @fusion-plugin-examples/compound-engineering@0.1.25
- @fusion-plugin-examples/dependency-graph@0.1.56
- @fusion-plugin-examples/grok-runtime@0.2.3
- @fusion-plugin-examples/roadmap@0.1.44
- @fusion-plugin-examples/cursor-runtime@0.1.44
- @fusion-plugin-examples/droid-runtime@0.1.51
- @fusion-plugin-examples/hermes-runtime@0.2.75
- @fusion-plugin-examples/openclaw-runtime@0.2.75
- @fusion-plugin-examples/paperclip-runtime@0.2.75

### @fusion/desktop

#### Patch Changes

- @fusion/core@0.60.0
- @fusion/dashboard@0.60.0
- @fusion/engine@0.60.0

### @fusion/engine

#### Patch Changes

- @fusion/core@0.60.0
- @fusion/pi-claude-cli@0.60.0

### @fusion/plugin-sdk

#### Patch Changes

- @fusion/core@0.60.0

### @runfusion/fusion

#### Minor Changes

- f0888d4: summary: Open tasks as popups now applies to List clicks with the same movable task window as the Board.
  category: feature
  dev: Threads openMobileTasksInPopup App -> MainContent -> ListView; ListView.handleRowClick routes to onPopOut/popOutTaskDetail (floating-window--task-detail) when enabled, on both desktop split-pane and mobile/tablet single-pane, preserving docked behavior when off.
- 7cc622b: summary: Planning Mode now auto-retries a stuck AI generation up to 3 times before showing an error.
  category: feature
  dev: Bounded client-side auto-retry in PlanningModeModal reusing the existing /planning/:id/retry endpoint; counter resets on successful progress and is single-flighted across SSE onError, reopen, and the stuck poll.
- 4e7e013: summary: Add a Plan action to planning/ideas/hold task cards that opens Planning Mode from the card.
  category: feature
  dev: Board and List task context menus now gate Plan on pre-execution hold/intake columns and wired planning handlers.
- d4001ab: summary: Make the merger AI model configurable under Global and Project Models.
  category: feature
  dev: Adds project `mergerProvider`/`mergerModelId`/`mergerThinkingLevel` and global `mergerGlobalProvider`/`mergerGlobalModelId`/`mergerGlobalThinkingLevel`. Resolution is project merger → global merger → project/global default; does not inherit executor/planner/reviewer lanes.

#### Patch Changes

- 281bb05: summary: Fix bundled example plugins failing to enable with a missing @fusion/core package error.
  category: fix
  dev: Aliases bundlePluginEntry @fusion/core imports to pluginSdkCoreRuntimeShim for self-contained bundled.js outputs.
- e35620c: summary: Fix agents silently going stale for hours even though the heartbeat repair audit was running.
  category: fix
  dev: HeartbeatTriggerScheduler now supervises its own audit setInterval (a stalled/dropped audit driver is re-armed within a bounded window) and bounds/escalates non-advancing zombie-timer re-arms instead of churning silently, closing the ~62,348s silent-heartbeat window that survived the FN-7645/FN-7718 fixes (FN-7939).
- cf1b33b: summary: Settings search now surfaces Project Models Chat default settings when searching for chat.
  category: fix
  dev: Adds chat-default searchableText/searchableKeys to the project-models entry in SETTINGS_SECTIONS (SettingsModal.tsx); fixes FN-7907 search-index drift.

### runfusion.ai

#### Patch Changes

- Updated dependencies [281bb05]
- Updated dependencies [e35620c]
- Updated dependencies [cf1b33b]
- Updated dependencies [f0888d4]
- Updated dependencies [7cc622b]
- Updated dependencies [4e7e013]
- Updated dependencies [d4001ab]
  - @runfusion/fusion@0.60.0

> Older releases (before 0.60.0) are archived in [`CHANGELOG-archive.md`](./CHANGELOG-archive.md).
