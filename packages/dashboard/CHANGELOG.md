# @fusion/dashboard

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

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

### Patch Changes

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

## 0.8.4

### Patch Changes

- @fusion/core@0.8.4
- @fusion/engine@0.8.4
- @fusion-plugin-examples/hermes-runtime@0.2.6
- @fusion-plugin-examples/openclaw-runtime@0.2.6
- @fusion-plugin-examples/paperclip-runtime@0.2.6

## 0.8.3

### Patch Changes

- 9850bfa: Fix TUI token rendering, memory tracking fix, and other minor improvements
  - @fusion/core@0.8.3
  - @fusion/engine@0.8.3
  - @fusion-plugin-examples/hermes-runtime@0.2.5
  - @fusion-plugin-examples/openclaw-runtime@0.2.5
  - @fusion-plugin-examples/paperclip-runtime@0.2.5

## 0.8.2

### Patch Changes

- @fusion/core@0.8.2
- @fusion/engine@0.8.2
- @fusion-plugin-examples/hermes-runtime@0.2.4
- @fusion-plugin-examples/openclaw-runtime@0.2.4
- @fusion-plugin-examples/paperclip-runtime@0.2.4

## 0.8.1

### Patch Changes

- @fusion/core@0.8.1
- @fusion/engine@0.8.1
- @fusion-plugin-examples/hermes-runtime@0.2.3
- @fusion-plugin-examples/openclaw-runtime@0.2.3
- @fusion-plugin-examples/paperclip-runtime@0.2.3

## 0.8.0

### Patch Changes

- @fusion/core@0.8.0
- @fusion/engine@0.8.0
- @fusion-plugin-examples/hermes-runtime@0.2.2
- @fusion-plugin-examples/openclaw-runtime@0.2.2
- @fusion-plugin-examples/paperclip-runtime@0.2.2

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

- Updated dependencies [ce6dcef]
  - @fusion/core@0.7.1
  - @fusion/engine@0.7.1
  - @fusion-plugin-examples/hermes-runtime@0.2.1
  - @fusion-plugin-examples/openclaw-runtime@0.2.1
  - @fusion-plugin-examples/paperclip-runtime@0.2.1

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

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0
  - @fusion/engine@0.7.0
  - @fusion-plugin-examples/hermes-runtime@0.2.0
  - @fusion-plugin-examples/openclaw-runtime@0.2.0
  - @fusion-plugin-examples/paperclip-runtime@0.2.0

## 0.6.0

### Patch Changes

- @fusion/core@0.6.0
- @fusion/engine@0.6.0

## 0.5.0

### Patch Changes

- @fusion/core@0.5.0
- @fusion/engine@0.5.0

## 0.4.1

### Patch Changes

- @fusion/core@0.4.1
- @fusion/engine@0.4.1

## 0.4.0

### Patch Changes

- @fusion/core@0.4.0
- @fusion/engine@0.4.0

## 0.2.7

### Patch Changes

- @fusion/core@0.2.7
- @fusion/engine@0.2.7

## 0.2.6

### Patch Changes

- @fusion/core@0.2.6
- @fusion/engine@0.2.6
