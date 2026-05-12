# Settings Reference

[← Docs index](./README.md)

This guide documents Fusion settings from `packages/core/src/types.ts`.

## Settings Scopes

Fusion uses a two-tier settings system:

- **Global settings** (`~/.fusion/settings.json`): user preferences shared across projects
- **Project settings** (`.fusion/config.json`): execution/runtime behavior for one project

At runtime, settings are merged. **Project settings override global settings** when keys overlap.

## Settings API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/settings` | Get merged settings (global + project). |
| `PUT /api/settings` | Update project settings only. |
| `GET /api/settings/global` | Get global settings only. |
| `PUT /api/settings/global` | Update global settings only. |
| `GET /api/settings/scopes` | Get separated `{ global, project }` view. |

---

## Global Settings

Defaults from `DEFAULT_GLOBAL_SETTINGS`; key scope from `GLOBAL_SETTINGS_KEYS`.

| Setting | Type | Default | Description |
|---|---|---:|---|
| `themeMode` | `"dark" \| "light" \| "system"` | `"dark"` | Dashboard theme mode. |
| `colorTheme` | `ColorTheme` | `"default"` | Dashboard color theme preset. |
| `dashboardFontScalePct` | `number` | `100` | Dashboard font scale percentage used by Appearance settings. Valid range: `85` to `125`; applied pre-hydration via document root font-size so board typography (column headers/counts, task cards, and quick-entry text) scales with the setting from first paint. |
| `defaultProvider` | `string` | `undefined` | Default AI provider. |
| `defaultModelId` | `string` | `undefined` | Default AI model ID. |
| `fallbackProvider` | `string` | `undefined` | Fallback provider when the primary default model hits transient provider failures. |
| `fallbackModelId` | `string` | `undefined` | Fallback model ID (must pair with `fallbackProvider`). |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high"` | `undefined` | Default reasoning effort for AI sessions. If a provider/runtime rejects simultaneous `thinking` and `reasoning_effort` parameters, Fusion retries without the explicit thinking override instead of failing the run. |
| `ntfyEnabled` | `boolean` | `false` | Enable ntfy push notifications. |
| `ntfyTopic` | `string` | `undefined` | ntfy topic name. |
| `ntfyBaseUrl` | `string` | `undefined` | Optional custom ntfy server base URL (must use `http://` or `https://`). If blank/unset, Fusion uses `https://ntfy.sh` for both runtime and test notifications. |
| `ntfyAccessToken` | `string` | `undefined` | Optional ntfy access token. When set, Fusion sends `Authorization: Bearer <token>` with ntfy publish requests, including Settings → Notifications test sends. Leave blank/unset to publish without authentication. |
| `ntfyEvents` | `("in-review" \| "merged" \| "failed" \| "awaiting-approval" \| "awaiting-user-review" \| "planning-awaiting-input" \| "gridlock" \| "fallback-used" \| "memory-dreams-processed" \| "message:agent-to-user" \| "message:agent-to-agent")[]` | `["in-review","merged","failed","awaiting-approval","awaiting-user-review","planning-awaiting-input","gridlock","fallback-used","memory-dreams-processed","message:agent-to-user","message:agent-to-agent"]` | Event types that trigger ntfy notifications. `planning-awaiting-input` fires when planning mode is waiting on user input. `gridlock` fires when all schedulable todo tasks are blocked; delivery is cooldown-throttled (first alert immediately, then suppressed for 15 minutes until gridlock resolves). `fallback-used` fires when Fusion recovers from a retryable model failure by switching to a configured fallback model. `memory-dreams-processed` fires when manual dream processing writes a new `DREAMS.md` entry (project and/or agent); disable it via ntfy/webhook event filters if you want to opt out. `message:agent-to-user` fires when an agent sends a direct message to the user. `message:agent-to-agent` fires when an agent sends a message to another agent (including replies). If you use a custom `ntfyEvents` list, this event must be present (or `ntfyEvents` must be unset so defaults apply) for agent-to-agent inbox notifications to send. |
| `ntfyDashboardHost` | `string` | `undefined` | Dashboard host used to build deep links in notifications. |
| `webhookEnabled` | `boolean` | `false` | Enable webhook notifications for task lifecycle events. Part of the legacy flat settings; prefer `notificationProviders` for new setups. |

In **Settings → Notifications**, use **Test message notification** to exercise the full mailbox-message dispatch pipeline (`NotificationService.dispatch` → provider delivery), not just a raw ntfy POST.

Fusion automatically falls back to ntfy's JSON publish format when a notification title or message contains non-Latin-1 characters, and truncates outgoing titles/messages to ntfy's documented size limits before sending.
| `webhookUrl` | `string` | `undefined` | Webhook endpoint URL. Must be `http://` or `https://`. Part of legacy flat settings. |
| `webhookFormat` | `"slack" \| "discord" \| "generic"` | `"generic"` | Webhook payload format. Part of legacy flat settings. |
| `webhookEvents` | `string[]` | `[]` | Event filter for webhook notifications. Empty/omitted means all events. Part of legacy flat settings. |
| `notificationProviders` | `NotificationProviderConfig[]` | `[]` | Array of pluggable notification provider configurations. Each entry uses `{ id, name, enabled, config }` and is dispatched by provider ID (for example `ntfy` or `webhook`). |
| `customProviders` | `CustomProvider[]` | `[]` | User-defined OpenAI-compatible or Anthropic-compatible providers used by the custom-provider API (`/api/custom-providers`). Each entry uses `{ id, name, apiType, baseUrl, apiKey?, models? }`; API keys are stored raw but masked in API responses. |
| `defaultProjectId` | `string` | `undefined` | Default project for multi-project CLI operations when `--project` is omitted. |
| `setupComplete` | `boolean` | `undefined` | Tracks completion of first-run setup. |
| `favoriteProviders` | `string[]` | `undefined` | Pinned providers shown first in model selectors. |
| `favoriteModels` | `string[]` | `undefined` | Pinned models in `{provider}/{modelId}` format. |
| `openrouterModelSync` | `boolean` | `true` | Sync OpenRouter model catalog into model pickers at startup. |
| `opencodeGoModelSync` | `boolean` | `true` | Sync opencode-go model catalog at startup via `opencode models opencode --refresh`, normalizing discovered `opencode/...` IDs into the `opencode-go` provider surface used by `/api/models`. |
| `updateCheckEnabled` | `boolean` | `true` | When enabled, Fusion performs a daily npm registry check for new `@runfusion/fusion` versions and shows update notices in CLI/dashboard. |
| `githubTrackingDefaultRepo` | `string` | `undefined` | Global fallback issue-tracking repo (`owner/repo`) used when task-level tracking is enabled and no project/task override is set. This key is dual-scope: global saves go through `PUT /api/settings/global` (Settings → Global General). |
| `autoReloadOnVersionChange` | `boolean` | `true` | When enabled (default), the dashboard automatically reloads when a new build version is detected via `/version.json` polling or service worker activation. Set to `false` to suppress automatic reloads — the user must manually refresh to pick up updates. |
| `modelOnboardingComplete` | `boolean` | `undefined` | Whether AI onboarding has been completed or dismissed. |
| `executionGlobalProvider` | `string` | `undefined` | Global baseline provider for task execution. Project `executionProvider` overrides this. |
| `executionGlobalModelId` | `string` | `undefined` | Global baseline model ID for task execution. |
| `planningGlobalProvider` | `string` | `undefined` | Global baseline provider for planning. Project `planningProvider` overrides this. |
| `planningGlobalModelId` | `string` | `undefined` | Global baseline model ID for planning. |
| `validatorGlobalProvider` | `string` | `undefined` | Global baseline provider for validator/reviewer runs. Project `validatorProvider` overrides this. |
| `validatorGlobalModelId` | `string` | `undefined` | Global baseline model ID for validator/reviewer runs. |
| `titleSummarizerGlobalProvider` | `string` | `undefined` | Global baseline provider for title summarization. Project `titleSummarizerProvider` overrides this. |
| `titleSummarizerGlobalModelId` | `string` | `undefined` | Global baseline model ID for title summarization. |
| `daemonToken` | `string` | `undefined` | Daemon authentication token (`fn_<32 hex chars>`) used by CLI clients. |
| `daemonPort` | `number` | `4040` | Port for daemon/serve mode binding. |
| `daemonHost` | `string` | `"127.0.0.1"` | Host for daemon/serve mode binding. Defaults to localhost only; pass `"0.0.0.0"` to expose on all interfaces. |
| `settingsSyncEnabled` | `boolean` | `false` | Enable automatic settings synchronization between nodes. |
| `settingsSyncAuth` | `boolean` | `false` | Include auth-material snapshots (`sharedState.authMaterial` and auth sync endpoints) when settings sync is enabled. Ignored when `settingsSyncEnabled` is `false`. |
| `settingsSyncInterval` | `number` | `900000` | Automatic sync interval in ms. Valid values: `300000`, `900000`, `1800000`, `3600000`. |
| `settingsSyncConflictResolution` | `"last-write-wins" \| "always-ask" \| "keep-local" \| "keep-remote"` | `"last-write-wins"` | Conflict strategy for divergent synced settings. |
| `dashboardCurrentNodeId` | `string` | `undefined` | Currently selected dashboard node ID. Restores the last-viewed node on fresh browser/PWA sessions. `undefined` means viewing the local node. |

> Mesh lifecycle note: settings sync is executed by the process-level `PeerExchangeService` started by `fn serve`/`fn dashboard`. `InProcessRuntime` does not instantiate settings-sync mesh services per project.
| `dashboardCurrentProjectIdByNode` | `Record<string, string>` | `undefined` | Map of node ID to last-selected project ID. Use key `"local"` for the local node. Persists project context across browser restarts and PWA sessions. |
| `persistAgentToolOutput` | `boolean` | `true` | Controls whether detailed `detail` payloads are persisted for `tool`, `tool_result`, and `tool_error` agent log entries. When disabled, tool timeline rows are still recorded, but verbose payloads are omitted. |
| `persistAgentThinkingLog` | `boolean` | `false` | Controls whether `thinking`/reasoning agent log entries are persisted. When disabled (default), only persisted `thinking` rows are suppressed; normal assistant text output and tool rows are unchanged. |
| `researchGlobalDefaults` | `ResearchGlobalDefaults` | `{ searchProvider: "builtin", synthesisProvider: undefined, synthesisModelId: undefined, enabledSources: { webSearch: true, pageFetch: true, github: false, localDocs: true, llmSynthesis: true }, maxSourcesPerRun: 20, defaultExportFormat: "markdown" }` | Global Research defaults shared by all projects. Web search defaults to the built-in WebSearch/WebFetch-backed provider; project overrides come from `researchSettings`. |
| `researchGlobalEnabled` | `boolean` | `true` | Enable or disable the research subsystem globally. When false, dashboard/API/CLI/agent entrypoints reject new runs. |
| `researchGlobalMaxConcurrentRuns` | `number` | `3` | Maximum concurrent research runs across all projects. |
| `researchGlobalDefaultTimeout` | `number` | `300000` | Default timeout for end-to-end research runs in milliseconds (5 minutes). |
| `researchGlobalMaxSourcesPerRun` | `number` | `20` | Maximum number of sources per research run. |
| `researchGlobalMaxSynthesisRounds` | `number` | `2` | Maximum synthesis rounds per research run. |
| `researchGlobalWebSearchProvider` | `"builtin" \| "searxng" \| "brave" \| "google" \| "tavily"` | `"builtin"` | Web search backend for research. Default: `"builtin"` (uses agent-native WebSearch/WebFetch tools with no API key requirement). Web search itself is always enabled. |
| `researchGlobalSearxngUrl` | `string` | `undefined` | SearXNG instance URL (required when provider is `"searxng"`). |
| `researchGlobalBraveApiKey` | `string` | `undefined` | Brave Search API key (required when provider is `"brave"`). |
| `researchGlobalGoogleSearchApiKey` | `string` | `undefined` | Google Custom Search API key (required when provider is `"google"`). |
| `researchGlobalGoogleSearchCx` | `string` | `undefined` | Google Custom Search engine ID (required when provider is `"google"`). |
| `researchGlobalTavilyApiKey` | `string` | `undefined` | Tavily API key (required when provider is `"tavily"`). |
| `researchGlobalGitHubEnabled` | `boolean` | `undefined` | Enable GitHub as a research source. |
| `researchGlobalLocalDocsEnabled` | `boolean` | `undefined` | Enable local docs as a research source. |
| `researchGlobalMaxSearchResults` | `number` | `undefined` | Maximum search results per provider query. |
| `researchGlobalFetchTimeoutMs` | `number` | `30000` | Timeout for individual HTTP fetches in milliseconds. |
| `researchGlobalUserAgent` | `string` | `"FusionResearchBot/1.0"` | User-Agent header for HTTP requests made by research providers. |
| `experimentalFeatures` | `Record<string, boolean>` | `{}` | Global-scoped experimental feature flags. Includes `experimentalFeatures.researchView`, which gates all Research surfaces and tools (dashboard view, engine task-session tools, and CLI `fn_research_*` tools), and `experimentalFeatures.evalsView`, which gates Evals surfaces (dashboard view, Settings → Scheduled Evals, and scheduled-eval cron execution). |
| `remoteAccess` | `RemoteAccessSettings` | `{ activeProvider: null, providers: {...}, tokenStrategy: {...}, lifecycle: {...} }` | Global-scoped remote access provider + token strategy configuration used by Remote Access routes and tunnel lifecycle controls. |

### Notification providers (pluggable)

Fusion now supports a provider-list notification model via `notificationProviders` while keeping legacy flat ntfy/webhook settings intact.

- **Recommended for new setups:** configure providers in `notificationProviders`.
- **Backward compatible:** existing flat settings continue to work unchanged, including `ntfyEnabled`, `ntfyTopic`, `ntfyBaseUrl`, `ntfyEvents`, `ntfyDashboardHost`, `webhookEnabled`, `webhookUrl`, `webhookFormat`, and `webhookEvents`.
- This is additive/non-breaking; no migration is required for existing ntfy users.

`notificationProviders` entry shape (`NotificationProviderConfig`):

```ts
{
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}
```

Built-in provider IDs:
- `ntfy`
- `webhook`

#### Webhook provider config

When `id` is `"webhook"`, the provider `config` supports:

| Field | Type | Default | Notes |
|---|---|---:|---|
| `webhookUrl` | `string` | _required_ | Must be a valid `http://` or `https://` URL. |
| `webhookFormat` | `"slack" \| "discord" \| "generic"` | `"generic"` | Invalid/omitted values fall back to `"generic"`. |
| `events` | `string[]` | `[]` | Event filter list. Empty/omitted means all events are sent. Includes `memory-dreams-processed` for DREAMS.md updates from manual dream processing. |

#### ntfy provider config

When `id` is `"ntfy"` in `notificationProviders`, the provider `config` supports:

| Field | Type | Default | Notes |
|---|---|---:|---|
| `topic` | `string` | _required_ | ntfy topic name (1–64 chars, alphanumeric + `-_`). |
| `ntfyBaseUrl` | `string` | `"https://ntfy.sh"` | Optional custom ntfy server URL. |
| `ntfyAccessToken` | `string` | `undefined` | Optional access token. When set, provider sends `Authorization: Bearer <token>` on ntfy publishes. |
| `events` | `("in-review" \| "merged" \| "failed" \| "awaiting-approval" \| "awaiting-user-review" \| "planning-awaiting-input" \| "gridlock" \| "fallback-used" \| "memory-dreams-processed" \| "message:agent-to-user" \| "message:agent-to-agent")[]` | `DEFAULT_NTFY_EVENTS` | Event filter list used by the provider. For `gridlock`, enabled events are still cooldown-throttled at runtime (15-minute suppression window, reset on full resolution). `memory-dreams-processed` is emitted when manual dream processing appends a new project/agent `DREAMS.md` entry. `message:agent-to-user`/`message:agent-to-agent` are emitted for mailbox messages and deep-link to the specific message when `dashboardHost` is configured. |
| `dashboardHost` | `string` | `undefined` | Dashboard host for deep links in notifications. |

Disable daily update checks globally:

```bash
fn settings set updateCheckEnabled false
```

---

## Project Settings

Defaults from `DEFAULT_PROJECT_SETTINGS`; key scope from `PROJECT_SETTINGS_KEYS`.

| Setting | Type | Default | Description |
|---|---|---:|---|
| `globalPause` | `boolean` | `false` | Hard stop: terminate active engine sessions and pause scheduling immediately. |
| `globalPauseReason` | `string` | `undefined` | Optional reason for `globalPause` (`"rate-limit"` for automatic pauses, `"manual"` for user-triggered pauses). Cleared on unpause. |
| `enginePaused` | `boolean` | `false` | Soft pause: stop dispatching new work while letting active sessions finish. While paused (including shared pause windows with `globalPause`), stuck-task polling/timers are suspended so paused wall-clock time does not count against `taskStuckTimeoutMs`. Clearing pause state resumes runtime scheduling and gives tracked active sessions a fresh stuck-task grace window before normal detection resumes; when `autoMerge` is enabled, eligible `in-review` tasks are re-swept into the auto-merge queue (paused/blocked/failed review tasks remain skipped). |
| `maxConcurrent` | `number` | `2` | Max concurrent task-lane AI agents (planning, executor, merge). |
| `maxTriageConcurrent` | `number` | `2` | Max concurrent planning agents. |
| `globalMaxConcurrent` | `number` | `4` | System-wide max concurrent agents across all projects. |
| `maxWorktrees` | `number` | `4` | Max git worktrees. |
| `pollIntervalMs` | `number` | `15000` | Scheduler poll interval (ms). |
| `heartbeatMultiplier` | `number` | `1` | Global multiplier applied to all agent heartbeat intervals. Configured from the Agents screen (not Settings). |
| `defaultNodeId` | `string` | `undefined` | Optional project default execution node for task dispatch. When set, tasks without a per-task `nodeId` override resolve to this node (`routing source: project-default`). See [Task Management → Node Routing](./task-management.md#node-routing). |
| `unavailableNodePolicy` | `"block" \| "fallback-local"` | `"block"` | Project routing policy used during scheduler dispatch when a task resolves to a remote node and node health is known. `"block"` keeps the task in `todo` if the node is unhealthy; `"fallback-local"` reroutes dispatch to local execution. See [Architecture → Task Routing Architecture](./architecture.md#task-routing-architecture). |

| `groupOverlappingFiles` | `boolean` | `true` | Serialize execution when file scopes overlap. |
| `pluginTrustPolicy` | `"off" | "warn" | "enforce"` | `"warn"` | Plugin provenance enforcement mode: `off` records verification metadata only, `warn` blocks only `invalid` signatures, `enforce` allows only `verified-trusted` or `trusted-local`. |
| `overlapIgnorePaths` | `string[]` | `[]` | Optional project-relative file or directory paths to exclude from overlap blocking (for example `docs` or `generated/openapi.json`). Entries are trimmed, deduplicated, and must not be absolute or contain `..` traversal. |
| `autoMerge` | `boolean` | `true` | Auto-finalize tasks from `in-review`. |
| `mergeStrategy` | `"direct" \| "pull-request"` | `"direct"` | Completion mode (local direct merge vs PR-first). |
| `mergeConflictStrategy` | `"smart-prefer-main" \| "smart-prefer-branch" \| "ai-only" \| "abort"` | `"smart-prefer-main"` | Controls the merger's conflict-resolution cascade. `smart-prefer-main` fast-forwards local main from `origin` when possible, then tries AI resolution, then auto-resolve heuristics, then a final `-X ours` fallback that prefers main unless the overlap guard below says otherwise. `smart-prefer-branch` uses the same cascade but ends with `-X theirs` so the task branch wins. `ai-only` never silently picks a side, and `abort` stops after the first AI attempt. Legacy `smart` / `prefer-main` values are normalized automatically. |
| `mergeStrategyOverlapBehavior` | `"flip-to-prefer-branch" \| "warn-only" \| "ignore"` | `"flip-to-prefer-branch"` | Safety control for `mergeConflictStrategy="smart-prefer-main"`. Before the Attempt 3 `-X ours` fallback, Fusion checks whether the task branch and recent `main` history overlap on the same files (30-commit lookback, matching the squash audit heuristics). `flip-to-prefer-branch` makes overlapping files prefer the task branch so hardening is not silently discarded (the FN-3936 class of regression). `warn-only` logs the overlap but keeps the legacy main-wins fallback. `ignore` disables the overlap guard and preserves legacy behavior exactly. |
| `pushAfterMerge` | `boolean` | `false` | Auto-push to remote after successful direct merge. Includes pulling latest and AI conflict resolution. |
| `pushRemote` | `string` | `"origin"` | Git remote (and optional branch) to push to after merge. |
| `worktreeInitCommand` | `string` | `undefined` | Shell command run after worktree creation. For pnpm repos, prefer `pnpm install --frozen-lockfile` for deterministic bootstrap. |
| `testCommand` | `string` | `undefined` | Merge-time test command (hard gate). When unset, Fusion auto-detects from lockfile. |
| `buildCommand` | `string` | `undefined` | Merge-time build command (hard gate). |
| `recycleWorktrees` | `boolean` | `false` | Reuse worktrees from a pool for faster startup. |
| `worktreeNaming` | `"random" \| "task-id" \| "task-title"` | `"random"` | Naming mode for new worktree directories. |
| `taskPrefix` | `string` | `"FN"` | Prefix used for newly generated task IDs. |
| `includeTaskIdInCommit` | `boolean` | `true` | Include task ID as commit scope in generated commits. |
| `commitAuthorEnabled` | `boolean` | `true` | Apply explicit `--author` attribution on Fusion commits. |
| `commitAuthorName` | `string` | `"Fusion"` | Commit author name when `commitAuthorEnabled` is true. |
| `commitAuthorEmail` | `string` | `"noreply@runfusion.ai"` | Commit author email when `commitAuthorEnabled` is true. |
| `planningProvider` | `string` | `undefined` | Provider for planning agents. |
| `planningModelId` | `string` | `undefined` | Model ID for planning agents. |
| `planningFallbackProvider` | `string` | `undefined` | Fallback provider for planning. |
| `planningFallbackModelId` | `string` | `undefined` | Fallback model ID for planning. |
| `defaultProviderOverride` | `string` | `undefined` | Project-level override for global default provider baseline. |
| `defaultModelIdOverride` | `string` | `undefined` | Project-level override for global default model baseline. |
| `executionProvider` | `string` | `undefined` | Provider for task execution agents. |
| `executionModelId` | `string` | `undefined` | Model ID for task execution agents. |
| `validatorProvider` | `string` | `undefined` | Provider for plan/code reviewers. |
| `validatorModelId` | `string` | `undefined` | Model ID for plan/code reviewers. |
| `validatorFallbackProvider` | `string` | `undefined` | Fallback provider for reviewers. |
| `validatorFallbackModelId` | `string` | `undefined` | Fallback model ID for reviewers. |
| `modelPresets` | `ModelPreset[]` | `[]` | Reusable executor/reviewer model presets. |
| `autoSelectModelPreset` | `boolean` | `false` | Auto-select presets by task size. |
| `defaultPresetBySize` | `{ S?: string; M?: string; L?: string }` | `{}` | Mapping for `S`/`M`/`L` → preset ID. |
| `autoResolveConflicts` | `boolean` | `true` | Enable automatic merge conflict resolution. |
| `smartConflictResolution` | `boolean` | `true` | Alias/preferred flag for smart conflict handling. |
| `mergerAutostashMaxAgeHours` | `number` | `24` | Maximum autostash age in hours before startup/periodic stale-stash sweep drops `fusion-merger-autostash:*` leftovers (minimum `1`). |
| `workflowRevisionForkOnScopeMismatch` | `boolean` | `true` | When enabled, workflow revision feedback that explicitly names files outside the task's declared File Scope is forked into a dependent follow-up triage task instead of being appended to the original task's `PROMPT.md`. Set to `false` to keep the legacy append-and-rerun behavior. |
| `strictScopeEnforcement` | `boolean` | `false` | Block merges on out-of-scope file changes. |
| `buildRetryCount` | `number` | `0` | Build retry attempts during merge. |
| `verificationFixRetries` | `number` | `3` | In-merge auto-fix retry attempts after deterministic test/build verification failures (0-3). |
| `buildTimeoutMs` | `number` | `300000` | Build timeout in milliseconds (5 minutes). |
| `requirePlanApproval` | `boolean` | `false` | Require manual approval before planning → todo. |
| `agentProvisioning` | `{ approvalMode?: "always" \| "trusted-only" \| "never"; trustedRoles?: string[]; trustedAgentIds?: string[]; alwaysApproveDelete?: boolean }` | `{}` | Approval policy for `fn_agent_create`/`fn_agent_delete` (`approvalMode` default `trusted-only`, delete approvals default on via `alwaysApproveDelete: true`). |
| `completionDocumentationMode` | `"off" \| "changeset" \| "changelog"` | `"off"` | Controls triage prompt injection for release-note artifacts in future task specs. `"changeset"` requires `.changeset/*.md` workflow guidance; `"changelog"` requires updating an existing changelog file (without inventing a new one); `"off"` disables this automation. |
| `specStalenessEnabled` | `boolean` | `false` | Enforce automatic re-planning for stale plans. |
| `specStalenessMaxAgeMs` | `number` | `21600000` | Spec staleness threshold in ms (6 hours). |
| `taskStuckTimeoutMs` | `number` | `undefined` | Inactivity timeout for stuck-task recovery. |
| `staleHighFanoutBlockerAgeThresholdMs` | `number` | `7200000` | Age threshold (ms) before high-fan-out blockers escalate in dashboard task cards/footer. Applies only to blockers currently in `in-progress`/`in-review`; age is computed from `columnMovedAt ?? updatedAt`. |
| `aiSessionTtlMs` | `number` | `604800000` | TTL in ms for persisted planning/subtask/mission sessions (7 days). |
| `aiSessionCleanupIntervalMs` | `number` | `3600000` | Interval in ms for AI session cleanup sweeps (1 hour). |
| `autoUnpauseEnabled` | `boolean` | `true` | Auto-unpause after rate-limit-triggered pauses; manual pauses stay paused until explicitly unpaused by the user. |
| `autoUnpauseBaseDelayMs` | `number` | `300000` | Base unpause delay in ms (5 min). |
| `autoUnpauseMaxDelayMs` | `number` | `3600000` | Max auto-unpause delay in ms (1 hour). |
| `maxStuckKills` | `number` | `6` | Max stuck-task terminations before permanent failure. |
| `maxPostReviewFixes` | `number` | `1` | Max auto-revival attempts for in-review tasks failing pre-merge workflow steps. |
| `maxSpawnedAgentsPerParent` | `number` | `5` | Max child agents per parent task. |
| `maxSpawnedAgentsGlobal` | `number` | `20` | Max spawned agents across one executor instance. |
| `maintenanceIntervalMs` | `number` | `300000` | Periodic maintenance interval in ms (5 min). |
| `autoArchiveDoneTasksEnabled` | `boolean` | `true` | Enable periodic auto-archiving of done tasks. |
| `autoArchiveDoneAfterMs` | `number` | `172800000` | Age in ms after entering done before auto-archive (48h). |
| `archiveAgentLogMode` | `"none" \| "compact" \| "full"` | `"compact"` | Agent log retention strategy for cold archive snapshots. |
| `autoUpdatePrStatus` | `boolean` | `false` | Auto-refresh PR status badges. |
| `githubCommentOnDone` | `boolean` | `false` | When enabled, tasks imported from GitHub issues post a completion comment to the source issue when the task moves to `done`. |
| `githubCommentTemplate` | `string` | `undefined` | Optional issue comment template used by `githubCommentOnDone`. Supports `{taskId}` and `{taskTitle}` placeholders. If unset, Fusion uses a default completion message. |
| `githubTrackingEnabledByDefault` | `boolean` | `false` | Project-level default for enabling issue tracking on new tasks. Even when this is false, issue creation can still occur per task if tracking is explicitly enabled. |
| `githubTrackingDefaultRepo` | `string` | `undefined` | Project default issue-tracking repo (`owner/repo`) used before global fallback for tracked task creation (precedence: task override → project default → global default). This key is dual-scope: project saves go through `PUT /api/settings` (Settings → Merge). |
| `githubAuthMode` | `"gh-cli" \| "token"` | `"gh-cli"` | Project GitHub auth strategy used by tracking lifecycle integration. `"gh-cli"` requires an installed/authenticated `gh` CLI. `"token"` requires a non-empty `githubAuthToken` (or `GITHUB_TOKEN` env fallback). Tracking lifecycle auth is strict per selected mode (no cross-fallback). |
| `githubAuthToken` | `string` | `undefined` | Optional project PAT used when `githubAuthMode` is `"token"` (takes precedence over server startup token for tracking flows). |
| `autoCreatePr` | `boolean` | `false` | Auto-create PRs for completed tasks. |
| `autoBackupEnabled` | `boolean` | `false` | Enable scheduled DB backups. |
| `autoBackupSchedule` | `string` | `"0 2 * * *"` | Backup cron schedule. |
| `autoBackupRetention` | `number` | `7` | Number of backups to retain. |
| `autoBackupDir` | `string` | `".fusion/backups"` | Relative backup directory path. |
| `memoryBackupEnabled` | `boolean` | `false` | Enable scheduled memory backups. |
| `memoryBackupSchedule` | `string` | `"0 3 * * *"` | Memory backup cron schedule. |
| `memoryBackupRetention` | `number` | `14` | Number of memory backups to retain. |
| `memoryBackupDir` | `string` | `".fusion/backups/memory"` | Relative memory backup directory path. |
| `memoryBackupScope` | `"project" \| "agents" \| "all"` | `"all"` | Backup scope: project memory, agent memory, or both. |
| `autoSummarizeTitles` | `boolean` | `false` | Auto-generate titles for long untitled descriptions across dashboard/API task creation and agent/tool-created tasks. |
| `useAiMergeCommitSummary` | `boolean` | `false` | Use AI-generated merge commit summaries instead of raw step-commit subject lists. |
| `titleSummarizerProvider` | `string` | `undefined` | Provider for title summarization. |
| `titleSummarizerModelId` | `string` | `undefined` | Model ID for title summarization. |
| `titleSummarizerFallbackProvider` | `string` | `undefined` | Fallback provider for title summarization. |
| `titleSummarizerFallbackModelId` | `string` | `undefined` | Fallback model ID for title summarization. |
| `scripts` | `Record<string, string>` | `undefined` | Named script map used by script-mode workflow steps and setup hooks. |
| `setupScript` | `string` | `undefined` | Script key from `scripts` to run before task execution. |
| `insightExtractionEnabled` | `boolean` | `false` | Enable scheduled memory insight extraction. |
| `insightExtractionSchedule` | `string` | `"0 2 * * *"` | Insight extraction cron schedule. |
| `insightExtractionMinIntervalMs` | `number` | `86400000` | Minimum interval between extractions (24h). |
| `evalSettings` | `EvalProjectSettings` | `{ enabled: false, intervalMs: 86400000, evaluatorProvider: undefined, evaluatorModelId: undefined, followUpPolicy: "suggest-only", retentionDays: 30 }` | Project-scoped scheduled eval configuration (enablement, interval, evaluator model override, follow-up policy, retention). |
| `taskEvaluationEnabled` | `boolean` | `false` | Legacy flat eval key. Prefer `evalSettings.enabled`. |
| `taskEvaluationSchedule` | `string` | `"0 5 * * *"` | Legacy flat eval key for cron-based automation compatibility. |
| `taskEvaluationProvider` | `string` | `undefined` | Legacy flat eval key. Prefer `evalSettings.evaluatorProvider`. |
| `taskEvaluationModelId` | `string` | `undefined` | Legacy flat eval key. Prefer `evalSettings.evaluatorModelId`. |
| `taskEvaluationFollowUpPolicy` | `"off" \| "suggest" \| "create"` | `"off"` | Legacy flat eval key. Prefer `evalSettings.followUpPolicy`. |
| `taskEvaluationRetention` | `number` | `undefined` | Legacy flat eval key. Prefer `evalSettings.retentionDays`. |
| `memoryEnabled` | `boolean` | `true` | Enable project memory integration. |
| `memoryBackendType` | `string` | `"qmd"` | Memory backend type. Built-ins include `qmd` (Quantized Memory Distillation, default), `file`, and `readonly`; custom backends can also be registered. |
| `memoryAutoSummarizeEnabled` | `boolean` | `false` | Enable automatic memory summarization when memory exceeds threshold. |
| `memoryAutoSummarizeThresholdChars` | `number` | `50000` | Character threshold for auto-summarization. |
| `memoryAutoSummarizeSchedule` | `string` | `"0 3 * * *"` | Cron schedule for auto-summarize checks. |
| `memoryDreamsEnabled` | `boolean` | `false` | Enable dream processing that synthesizes daily notes and promotes durable lessons. |
| `memoryDreamsSchedule` | `string` | `"0 4 * * *"` | Cron schedule for dream processing. |
| `tokenCap` | `number` | `undefined` | Proactive token threshold for context compaction. |
| `runStepsInNewSessions` | `boolean` | `false` | Run each task step in a fresh agent session. |
| `maxParallelSteps` | `number` | `2` | Max concurrent step sessions when per-step sessions are enabled. |
| `missionStaleThresholdMs` | `number` | `600000` | Mission stale threshold in ms while `activating` (10 min). |
| `missionMaxTaskRetries` | `number` | `3` | Max automatic retries for failed mission-linked tasks. |
| `missionHealthCheckIntervalMs` | `number` | `300000` | Mission health-check interval in ms (5 min). |
| `agentPrompts` | `AgentPromptsConfig` | `undefined` | Custom role prompt templates and assignments. |
| `promptOverrides` | `Record<string, string \| null>` | `undefined` | Segment-level prompt overrides (set a key to `null` to clear it). |
| `reflectionEnabled` | `boolean` | `false` | Enable/disable agent self-reflection workflows. |
| `reflectionIntervalMs` | `number` | `3600000` | Periodic reflection interval in ms. |
| `reflectionAfterTask` | `boolean` | `true` | Trigger reflection after task completion. |
| `reviewHandoffPolicy` | `"disabled" \| "comment-triggered" \| "always"` | `"disabled"` | Policy for agent-to-user review handoff detection. |
| `showQuickChatFAB` | `boolean` | `false` | Show floating quick-chat button (chat remains available via More menu). |
| `researchSettings` | `ResearchProjectSettings` | `{ enabled: true, searchProvider: undefined, synthesisProvider: undefined, synthesisModelId: undefined, enabledSources: { webSearch: true, pageFetch: true, github: false, localDocs: true, llmSynthesis: true }, limits: { maxConcurrentRuns: 3, maxSourcesPerRun: 20, maxDurationMs: 300000, requestTimeoutMs: 30000 } }` | Project-specific Research enablement/overrides. Resolved together with `researchGlobalDefaults` via `resolveResearchSettings()`. |
| `researchEnabled` | `boolean` | `undefined` | Enable or disable research for this project. **Deprecated:** prefer `researchSettings.enabled`. |
| `researchMaxConcurrentRuns` | `number` | `undefined` | Project-level max concurrent research runs. |
| `researchDefaultTimeout` | `number` | `undefined` | Project-level default run timeout in milliseconds. |
| `researchMaxSourcesPerRun` | `number` | `undefined` | Project-level max sources per run. |
| `researchMaxSynthesisRounds` | `number` | `undefined` | Project-level max synthesis rounds. |

### Research settings hierarchy and credentials

Research configuration resolves through `resolveResearchSettings(settings)` in `@fusion/core` with this precedence:

1. Project override (`researchSettings.*`)
2. Global default (`researchGlobalDefaults.*`)
3. Hardcoded fallback defaults

This applies to:
- `enabled`
- `searchProvider`
- `synthesisProvider` + `synthesisModelId`
- `enabledSources` (`webSearch`, `pageFetch`, `github`, `localDocs`, `llmSynthesis`)
- run limits (`maxConcurrentRuns`, `maxSourcesPerRun`, `maxDurationMs`, `requestTimeoutMs`)
- export default (`defaultExportFormat`)

Research is globally feature-gated via `experimentalFeatures.researchView`.
When that flag is disabled, the Settings modal also hides both Research sections (`Research Defaults` and project `Research`) and falls back to the first visible section if a hidden research section is requested directly.

Research failures are normalized to a shared error-code contract (`FEATURE_DISABLED`, `MISSING_CREDENTIALS`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_TIMEOUT`, `RUN_CANCELLED`, `RETRY_EXHAUSTED`, `INVALID_TRANSITION`, `NON_RETRYABLE_PROVIDER_ERROR`, `INTERNAL_ERROR`) with retryability metadata so dashboard, API, CLI, and agent tooling show consistent recovery guidance.

Recovery entrypoints in the dashboard:
- **Settings → Research Defaults**: choose between builtin web search (default) or optional external provider configuration.
- **Settings → Authentication**: repair missing provider credentials (`MISSING_CREDENTIALS`).
- **Settings → Research (project)**: re-enable project research or source toggles when runs are blocked by project settings.
- **Settings → Experimental Features**: enable `researchView` when Research surfaces or `fn_research_*` tools report feature-disabled.

### Authentication troubleshooting (mobile OAuth fallback)

When an OAuth provider returns a localhost callback that this dashboard host cannot open directly, use the **manual code** fallback in Settings/Onboarding:
- Tap **Login** for the provider, complete sign-in in the browser, then paste either the final redirect URL or the authorization code into the fallback textbox. Fusion now shows a pre-login warning first so you know to copy the browser address bar URL before the redirect tab appears to fail.
- On mobile/coarse-pointer layouts, the fallback textbox now auto-scrolls into view on focus (and after keyboard viewport shifts) so the paste/submit path remains usable.

**Credential storage rule:** API keys for Research providers are not stored in settings JSON. They are managed through the existing auth storage pipeline (`/api/auth/status`, `POST /api/auth/api-key`, `DELETE /api/auth/api-key`) and persisted in auth credential storage with masked hints in API responses.

### Scheduled eval settings (project scope)

`evalSettings` is project-scoped and validated on `PUT /api/settings` with these rules:

- `intervalMs`: integer in `[60000, 604800000]`
- `retentionDays`: integer in `[1, 365]`
- `followUpPolicy`: one of `"disabled" | "suggest-only" | "auto-create"`
- `evaluatorProvider` and `evaluatorModelId` must be provided together or both omitted

Model resolution for scheduled eval execution uses `resolveEvalSettings(settings)`:

1. `evalSettings.evaluatorProvider` + `evalSettings.evaluatorModelId` when both are set
2. Validator lane fallback from `resolveValidatorSettingsModel(settings)` when unset
3. Non-model defaults: `enabled=false`, `intervalMs=86400000`, `followUpPolicy="suggest-only"`, `retentionDays=30`

Follow-up policy meanings:

- `disabled`: do not emit follow-up suggestions/tasks
- `suggest-only`: emit suggestions without automatic task creation
- `auto-create`: permit automatic task creation for qualifying follow-ups

### Plugin trust policy (project scope)

`pluginTrustPolicy` controls loader behavior after signature verification:

- `off`: always continue load decisions based on existing plugin lifecycle checks; signature/trust metadata is still persisted
- `warn`: block only `invalid` signatures (tampered/corrupt). `unsigned` and `verified-untrusted` remain loadable with warnings
- `enforce`: allow only `verified-trusted` and `trusted-local`; block `verified-untrusted`, `unsigned`, and `invalid`

`trusted-local` is reserved for bundled in-repo plugin paths so existing shipped plugins remain usable without retro-signing.

### Node Routing settings (project scope)

Node routing controls in the project settings table are configured from **Settings → Node Routing** in the dashboard or via CLI:

- `fn settings set defaultNodeId <node-id>`
- `fn settings set unavailableNodePolicy <block|fallback-local>`

Routing precedence for task dispatch is:
1. per-task override (`Task.nodeId`)
2. project default (`defaultNodeId`)
3. local execution

### Project Default Node vs central project node assignment

Fusion also stores `projects.nodeId` in the **central registry database** (`~/.fusion/fusion-central.db`). That value is a multi-project runtime placement field used by `ProjectManager` (for selecting remote vs local project runtime), not the same setting as `defaultNodeId` task dispatch routing.

Node-specific project working directories are persisted separately in central DB table `projectNodePathMappings` (`projectId` + `nodeId` + `path`). Do not treat `projects.nodeId` as the path source of truth.

- `defaultNodeId` (project settings): task-level dispatch default
- `projects.nodeId` (central registry): which node hosts the project runtime in multi-project mode
- `projectNodePathMappings.path` (central registry): working-directory path for that project on that specific node

See also:
- [Task Management → Node Routing](./task-management.md#node-routing)
- [Multi-Project → Node Routing](./multi-project.md#node-routing)
- [Architecture → Task Routing Architecture](./architecture.md#task-routing-architecture)

### Remote Access settings (global-scoped)

Remote access settings are global-only (stored in `~/.fusion/settings.json`), not project-scoped.
The canonical persisted shape is a nested `remoteAccess` object.

Use **[Remote Access runbook](./remote-access.md)** for setup prerequisites (Tailscale/Cloudflare), tokenized login-link security caveats, and operational troubleshooting. Keep this section as a schema reference.

When `remoteAccess.activeProvider` is `cloudflare`, the Settings UI fetches `/api/remote/status` and surfaces `cloudflaredAvailable` to show installed/missing state plus a one-click `POST /api/remote/install-cloudflared` action.

When `remoteAccess.activeProvider` is `tailscale` and the Fusion-managed tunnel is stopped, `/api/remote/status` also returns `externalTunnel` when a pre-existing funnel is detected. The UI exposes two actions: **Use Existing** (start Fusion tunnel lifecycle against the existing funnel) and **Start Fresh** (`POST /api/remote/tunnel/kill-external` then start).

| Setting | Type | Default | Description |
|---|---|---:|---|
| `remoteAccess.enabled` | `boolean` | `false` | Master toggle for remote access orchestration. |
| `remoteAccess.activeProvider` | `"tailscale" \| "cloudflare" \| null` | `null` | Currently selected provider. |
| `remoteAccess.providers.tailscale.enabled` | `boolean` | `false` | Enables Tailscale provider configuration. |
| `remoteAccess.providers.tailscale.hostname` | `string` | `""` | Optional serve hostname label for Tailscale. |
| `remoteAccess.providers.tailscale.targetPort` | `number` | `0` | Local port exposed by Tailscale when configured. |
| `remoteAccess.providers.tailscale.acceptRoutes` | `boolean` | `false` | Accept subnet routes when supported by local Tailscale config. |
| `remoteAccess.providers.cloudflare.enabled` | `boolean` | `false` | Enables Cloudflare tunnel configuration. |
| `remoteAccess.providers.cloudflare.quickTunnel` | `boolean` | `true` | Enables Cloudflare Quick Tunnel mode (`cloudflared tunnel --url`) with no account/token requirement; named tunnel fields are ignored while enabled. |
| `remoteAccess.providers.cloudflare.tunnelName` | `string` | `""` | Named tunnel identifier for `cloudflared tunnel run` when `quickTunnel` is `false`. |
| `remoteAccess.providers.cloudflare.tunnelToken` | `string \| null` | `null` | Tunnel token value (treat as secret; do not log raw values) for named tunnel mode. |
| `remoteAccess.providers.cloudflare.ingressUrl` | `string` | `""` | Preferred public ingress URL for named tunnel mode; in quick tunnel mode the live `trycloudflare.com` URL comes from runtime status. |
| `remoteAccess.tokenStrategy.persistent.enabled` | `boolean` | `true` | Enables persistent remote-auth token mode. |
| `remoteAccess.tokenStrategy.persistent.token` | `string \| null` | `null` | Persistent remote-auth token. |
| `remoteAccess.tokenStrategy.shortLived.enabled` | `boolean` | `false` | Enables short-lived token generation. |
| `remoteAccess.tokenStrategy.shortLived.ttlMs` | `number` | `900000` | Default short-lived token TTL in milliseconds (15 minutes). |
| `remoteAccess.tokenStrategy.shortLived.maxTtlMs` | `number` | `86400000` | Maximum allowed short-lived token TTL (24 hours). |
| `remoteAccess.lifecycle.rememberLastRunning` | `boolean` | `false` | Enables safe startup restore attempts when prior-running markers + prerequisites are valid. |
| `remoteAccess.lifecycle.wasRunningOnShutdown` | `boolean` | `false` | Internal marker written by runtime lifecycle management; explicit manual stop clears this to prevent unintended restart restore. |
| `remoteAccess.lifecycle.lastRunningProvider` | `"tailscale" \| "cloudflare" \| null` | `null` | Internal provider marker used for startup restore gating; stale markers are cleared when restore is skipped/failed. |

Patch semantics for global updates (`PUT /api/settings/global` and `PUT /api/remote/settings`):
- `remoteAccess` patches are **deep-merged** so sibling branches are preserved.
- `remoteAccess: null` clears the full global override (falls back to defaults).
- Nested `null` clears only the targeted nested key/branch.

Examples:

```json
{
  "remoteAccess": {
    "providers": {
      "tailscale": {
        "enabled": true,
        "hostname": "team.tail.ts.net",
        "targetPort": 5173,
        "acceptRoutes": true
      }
    }
  }
}
```

The payload above updates only `providers.tailscale` and keeps `providers.cloudflare`, `tokenStrategy`, and `lifecycle` unchanged.

```json
{
  "remoteAccess": {
    "tokenStrategy": {
      "persistent": {
        "token": null
      }
    }
  }
}
```

The payload above clears only `remoteAccess.tokenStrategy.persistent.token`.

Runtime provider config/credential contract (engine remote-access manager):
- The tunnel manager consumes **resolved provider configs** (`TunnelProviderConfig`) from callers; it does not read dashboard form state directly.
- Provider config must include executable + args and may include credential references:
  - `tokenEnvVar` (env var name, value sourced from process/config env)
  - `credentialsPath` (Cloudflare credentials file path)
- Missing/invalid credential references fail fast with `invalid_config` status/error behavior.
- Secret-bearing values are redacted in command previews and emitted tunnel logs before they are published to subscribers.

Runtime lifecycle semantics:
- Provider/settings edits remain manual-only and do not auto-start tunnel processes.
- Startup restore is best-effort and non-fatal; failed/skipped restore attempts surface machine-readable diagnostics through `/api/remote/status` and do not loop indefinitely.
- Tunnel status payloads redact secret values (persistent/short-lived tokens and tokenized URLs are never returned raw from status diagnostics).

Short-lived token bounds are enforced server-side:
- Minimum TTL: `60_000` ms (60s)
- Maximum TTL: `86_400_000` ms (24h)

> **Note:** Agent `metadata.skills` is not a top-level project setting, but it is the primary mechanism for controlling execution-time skill selection. The engine's `buildSessionSkillContext` function reads this metadata from the assigned agent and uses it to resolve which skills are available in the agent session. If `metadata.skills` is absent or empty, the engine falls back to the built-in `fusion` skill.

---

### Server-owned GET `/api/settings` fields

- `trackingAuthAvailable` (`boolean`) is computed server-side from `githubAuthMode` + credential/runtime availability for tracking lifecycle calls.
- `trackingAuthReason` (`"token_missing" | "gh_not_installed" | "gh_not_authenticated" | "invalid_mode" | null`) explains unavailability when `trackingAuthAvailable` is false.
- These fields are response-only and are stripped from `PUT /api/settings` payloads.

## Model Selection Hierarchy

Fusion uses a dual-scope model settings system with five lanes. Global settings provide baseline defaults, and project settings provide per-project overrides.

### Planning model

1. Per-task `planningModelProvider` + `planningModelId`
2. Project `planningProvider` + `planningModelId`
3. Global `planningGlobalProvider` + `planningGlobalModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Automatic provider/model resolution

### Executor model

1. Assigned durable agent runtime model (`runtimeConfig.model` or `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) when both provider and model ID are set
2. Per-task `modelProvider` + `modelId`
3. Project `executionProvider` + `executionModelId`
4. Global `executionGlobalProvider` + `executionGlobalModelId`
5. Project `defaultProviderOverride` + `defaultModelIdOverride`
6. Global `defaultProvider` + `defaultModelId`
7. Automatic provider/model resolution

### Heartbeat model (durable agents)

Heartbeat sessions for durable agents use this order:

1. Assigned durable agent runtime model (`runtimeConfig.model` or `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) when present
2. Project `executionProvider` + `executionModelId`
3. Global `executionGlobalProvider` + `executionGlobalModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Automatic provider/model resolution

When heartbeat has both (1) and (2-5), the runtime model is used as primary and the execution-lane model is passed as fallback. On timer-triggered runs, unrecoverable missing-provider credential/registry failures complete as `heartbeat_model_unavailable` instead of permanently setting the durable agent to `state=error`.

### Reviewer model

1. Per-task `validatorModelProvider` + `validatorModelId`
2. Project `validatorProvider` + `validatorModelId`
3. Global `validatorGlobalProvider` + `validatorGlobalModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Automatic provider/model resolution

### Merger model

1. Assigned durable agent runtime model (`runtimeConfig.model` or `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) when both provider and model ID are set
2. Project `defaultProviderOverride` + `defaultModelIdOverride`
3. Global `defaultProvider` + `defaultModelId`
4. Automatic provider/model resolution

For post-merge prompt workflow steps, explicit step-level `modelProvider` + `modelId` overrides take precedence over the merger lane above.

### Title summarization model

Used for task title auto-summarization and (when enabled) AI merge commit summaries.

1. Project `titleSummarizerProvider` + `titleSummarizerModelId`
2. Global `titleSummarizerGlobalProvider` + `titleSummarizerGlobalModelId`
3. Project `planningProvider` + `planningModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Automatic provider/model resolution

> **Note:** Runtime fallback precedence logic is implemented in engine and dashboard routes. The hierarchies above reflect current runtime behavior.

---

## Runtime Selection

Fusion supports multiple agent runtimes through a plugin-based runtime system. The default runtime is `pi` (the built-in runtime backed by the `pi` agent). Additional runtimes can be provided by plugins.

### Available Runtimes

| Runtime ID | Name | Description |
|------------|------|-------------|
| `pi` | Default PI Runtime | Built-in runtime using the `pi` agent (default) |
| `paperclip` | Paperclip Runtime | Plugin-provided runtime (requires `fusion-plugin-paperclip-runtime`) |
| `hermes` | Hermes Runtime (experimental) | Plugin-provided experimental runtime hint (requires `fusion-plugin-hermes-runtime`) |
| `openclaw` | OpenClaw Runtime (experimental) | Plugin-provided experimental runtime hint (requires `fusion-plugin-openclaw-runtime`) |

### Runtime Resolution Order

When creating an agent session, Fusion resolves the runtime as follows:

1. **No `runtimeHint` configured** → Use default `pi` runtime
2. **`runtimeHint` is `"pi"` or `"default"`** → Use default `pi` runtime
3. **`runtimeHint` is a plugin runtime ID** (e.g., `"paperclip"`, `"hermes"`, or `"openclaw"`) → Look up and instantiate the plugin runtime
4. **Plugin runtime unavailable** → Fall back to default `pi` runtime (with warning log)

### Configuring Runtime Selection

Runtime selection is configured at the **agent level** via `runtimeConfig.runtimeHint`:

```json
{
  "name": "Paperclip Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "paperclip"
  }
}
```

```json
{
  "name": "Hermes Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "hermes"
  }
}
```

```json
{
  "name": "OpenClaw Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "openclaw"
  }
}
```

> ℹ️ `runtimeHint: "hermes"` and `runtimeHint: "openclaw"` are experimental runtime paths. Runtime resolution and execution are supported when the corresponding runtime plugin is installed and enabled.

**Important:** There is no task-level runtime configuration. Tasks inherit the runtime from their assigned agent's `runtimeConfig`.

### Fallback Behavior

If a configured runtime is unavailable (plugin not installed, not enabled, or factory error), Fusion logs a warning and falls back to the default `pi` runtime:

```
[runtime-resolver] [executor] Runtime "hermes" unavailable (not_found), falling back to default pi runtime
```

The fallback ensures tasks continue executing even if the configured runtime plugin is unavailable.

### Installing Plugin Runtimes

To use plugin-provided runtimes like Paperclip, Hermes, or OpenClaw:

> Scope model: plugin installation + plugin settings are global (shared across projects), while plugin enabled/disabled state and runtime status are project-scoped.

1. Install one or more runtime plugins:

```bash
fn plugin install ./plugins/fusion-plugin-paperclip-runtime
fn plugin install ./plugins/fusion-plugin-hermes-runtime
fn plugin install ./plugins/fusion-plugin-openclaw-runtime
```

> 💡 In the dashboard, go to **Settings → Plugins → Fusion Plugins**. The **Bundled Plugins** section surfaces Agent Browser, Hermes, Paperclip, OpenClaw, Droid, Dependency Graph, and Reports directly from shipped manifests, shows install status, and provides one-click install actions for plugins that are not yet installed.
>
> ℹ️ Bundled runtime plugins (`fusion-plugin-paperclip-runtime`, `fusion-plugin-hermes-runtime`, `fusion-plugin-openclaw-runtime`) support lazy install semantics in settings: the card can open before installation (initial `GET /api/plugins/:id/settings` returns empty/default settings instead of 404), and the first save triggers auto-install (`PUT /api/plugins/:id/settings`). They are **not** auto-installed at app boot or npm install time. If a bundled asset is genuinely unavailable in the current build, save returns an explicit server error instead of a late plugin-not-found 404.

2. Create agents with the appropriate `runtimeConfig`:

```json
{
  "name": "Paperclip Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "paperclip"
  }
}
```

```json
{
  "name": "Hermes Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "hermes"
  }
}
```

```json
{
  "name": "OpenClaw Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "openclaw"
  }
}
```

3. Assign the agent to tasks that should use this runtime.

For more details, see the [Paperclip Runtime Plugin documentation](../plugins/fusion-plugin-paperclip-runtime/README.md), [Hermes Runtime Plugin documentation](../plugins/fusion-plugin-hermes-runtime/README.md), and [OpenClaw Runtime Plugin documentation](../plugins/fusion-plugin-openclaw-runtime/README.md).

### OpenClaw Runtime Configuration

The OpenClaw runtime plugin is CLI-first. Fusion invokes `openclaw agent --json` directly and defaults to embedded local mode (`--local`). Gateway mode is optional via `useGateway: true`.

| Setting | Type | Default | Description |
|---|---|---|---|
| `binaryPath` | `string` | `openclaw` | Path to the OpenClaw binary. |
| `agentId` | `string` | `"main"` | OpenClaw agent ID used for `--agent`. |
| `model` | `string` | (OpenClaw default) | Optional model override passed as `--model`. |
| `thinking` | `string` | `"off"` | Thinking level passed as `--thinking`. |
| `cliTimeoutSec` | `number` | `0` | OpenClaw-side timeout (`--timeout`, 0 = no OpenClaw timeout). |
| `cliTimeoutMs` | `number` | `300000` | Fusion-side hard kill timeout for each subprocess turn. |
| `useGateway` | `boolean` | `false` | When true, omit `--local` and allow OpenClaw's gateway path. |

| Setting | Environment Variable | Default if Unset |
|---|---|---|
| `binaryPath` | `OPENCLAW_BIN` | `openclaw` |
| `agentId` | `OPENCLAW_AGENT_ID` | `main` |
| `model` | `OPENCLAW_MODEL` | (OpenClaw default) |
| `thinking` | `OPENCLAW_THINKING` | `off` |
| `cliTimeoutSec` | `OPENCLAW_TIMEOUT_SEC` | `0` |
| `cliTimeoutMs` | `OPENCLAW_CLI_TIMEOUT_MS` | `300000` |
| `useGateway` | `OPENCLAW_USE_GATEWAY` | `false` |

Resolution priority is: plugin settings (`PluginContext.settings`) → environment variables → built-in defaults.

> ℹ️ These are **plugin-level** settings configured when the OpenClaw runtime plugin is installed/enabled. They are not agent-level `runtimeConfig` fields. Agents only need `runtimeConfig.runtimeHint: "openclaw"`.

OpenClaw tool-control uses the supported MCP CLI surface (`openclaw mcp set` + profile-scoped `--profile` runs) when custom Fusion tools are present; built-ins (`read`, `write`, `edit`, `bash`, `grep`, `find`) remain filtered from that MCP bridge.

For runtime details, see the [OpenClaw Runtime Plugin documentation](../plugins/fusion-plugin-openclaw-runtime/README.md).

---

## Prompt Overrides

Fusion supports fine-grained customization of AI agent prompts through the `promptOverrides` setting. This enables surgical customization of specific prompt segments without replacing entire role prompts (which `agentPrompts` does).

### Supported Prompt Keys

| Key | Agent Role | Description |
|-----|-----------|-------------|
| `executor-welcome` | executor | Introductory section for the executor agent |
| `executor-guardrails` | executor | Behavioral guardrails and constraints |
| `executor-spawning` | executor | Instructions for spawning child agents |
| `executor-completion` | executor | Completion criteria and signaling |
| `triage-welcome` | planning | Introductory section for the planning agent |
| `triage-context` | planning | Context-gathering instructions |
| `reviewer-verdict` | reviewer | Verdict criteria and format |
| `merger-conflicts` | merger | Merge conflict resolution instructions |
| `agent-generation-system` | — | System prompt for AI-assisted agent plan generation |
| `workflow-step-refine` | — | System prompt for refining workflow step descriptions into detailed agent prompts |

### How It Works

1. **Override Selection**: When a prompt key is present with a non-empty value, that override replaces the default prompt segment.

2. **Fallback to Defaults**: Missing or empty values fall back to the built-in default content.

3. **Cascade**: `agentPrompts` provides full-role template customization, while `promptOverrides` provides segment-level customization. Both can be used together — `promptOverrides` applies to the segment even within a custom role template.

### Clearing Overrides

To clear a specific override, set it to `null`:

```json
{
  "promptOverrides": {
    "executor-welcome": null
  }
}
```

To clear all overrides, set `promptOverrides` to `null`:

```json
{
  "promptOverrides": null
}
```

### Configuration Example

```json
{
  "settings": {
    "promptOverrides": {
      "executor-welcome": "Custom executor welcome message for this project...",
      "executor-guardrails": "## Custom Guardrails\n- Project-specific rules...",
      "triage-welcome": "Custom planning introduction..."
    }
  }
}
```

---

## JSON Examples

### 1) Team baseline for reliable automation

```json
{
  "settings": {
    "maxConcurrent": 3,
    "maxWorktrees": 6,
    "mergeStrategy": "direct",
    "autoResolveConflicts": true,
    "taskStuckTimeoutMs": 600000,
    "runStepsInNewSessions": true,
    "maxParallelSteps": 2
  }
}
```

### 2) Multi-model routing for plan/execute/review

```json
{
  "settings": {
    "defaultProvider": "anthropic",
    "defaultModelId": "claude-sonnet-4-5",
    "planningProvider": "openai",
    "planningModelId": "gpt-4.1",
    "validatorProvider": "openai",
    "validatorModelId": "gpt-4o"
  }
}
```

### 3) Size-based preset auto-selection

```json
{
  "settings": {
    "modelPresets": [
      {
        "id": "small-fast",
        "name": "Small / Fast",
        "executorProvider": "openai",
        "executorModelId": "gpt-4o-mini"
      },
      {
        "id": "large-deep",
        "name": "Large / Deep",
        "executorProvider": "anthropic",
        "executorModelId": "claude-sonnet-4-5",
        "validatorProvider": "openai",
        "validatorModelId": "gpt-4o"
      }
    ],
    "autoSelectModelPreset": true,
    "defaultPresetBySize": {
      "S": "small-fast",
      "L": "large-deep"
    }
  }
}
```

### 4) Agent runtime configuration (example agent config)

Runtime selection is configured at the agent level via `runtimeConfig`. These examples show agents configured to use Paperclip, Hermes, and OpenClaw runtime hints.

Common heartbeat/runtime keys on `runtimeConfig` include:

| Field | Type | Description |
|---|---|---|
| `heartbeatIntervalMs` | `number` | Per-agent heartbeat interval |
| `heartbeatTimeoutMs` | `number` | Per-agent heartbeat timeout |
| `maxConcurrentRuns` | `number` | Per-agent concurrent heartbeat limit |
| `messageResponseMode` | `"immediate" \| "on-heartbeat"` | Wake on message immediately or process during periodic heartbeat |
| `runMissedHeartbeatOnStartup` | `boolean` | Default `false`. When enabled, startup triggers one catch-up heartbeat if the agent's `lastHeartbeatAt` is older than its resolved heartbeat interval (server was down across a scheduled tick). |
| `allowParallelExecution` | `boolean` | Permanent agents only. Default `true` when unset. Set `false` to serialize heartbeat and executor sessions symmetrically (heartbeat won't start while executor is active, and executor won't start while heartbeat is active); `false` is explicitly persisted while unset/`true` keeps parallel behavior. |
| `selfImproveEnabled` | `boolean` | Enables periodic self-improvement prompts |
| `selfImproveIntervalMs` | `number` | Delay between self-improvement cycles (default 4h, minimum 1h) |
| `lastSelfImproveAt` | `string` | Last self-improvement checkpoint timestamp (managed by heartbeat monitor) |

Configure these per agent in **Agents → Agent Detail → Settings → Heartbeat Settings** (dashboard), or by updating agent `runtimeConfig` via the Agents API/CLI config flows.

These examples show agents configured to use Paperclip, Hermes, and OpenClaw runtime hints:

```json
{
  "name": "Paperclip Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "paperclip"
  }
}
```

```json
{
  "name": "Hermes Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "hermes"
  }
}
```

```json
{
  "name": "OpenClaw Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "openclaw"
  }
}
```

> ℹ️ Hermes and OpenClaw remain experimental runtime options. Runtime hint selection and runtime execution are both available when their plugins are installed.

To create a Hermes-configured agent via the API:

```bash
curl -X POST http://localhost:4040/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Hermes Executor",
    "role": "executor",
    "runtimeConfig": {
      "runtimeHint": "hermes"
    }
  }'
```

See also: [Workflow Steps](./workflow-steps.md) for how `scripts` and workflow model overrides are used.

---

## Experimental Features

The `experimentalFeatures` setting provides a first-class mechanism for managing global-scoped experimental feature toggles. This allows users to explicitly mark capabilities as experimental and toggle them on/off from a dedicated section in the Settings dashboard.

### How It Works

1. **Feature Registry**: Features are stored as key-value pairs where keys are feature names and values indicate enabled/disabled state.

2. **Default Behavior**: Features not present in the map are considered disabled (fallback to `false`).

3. **UI Integration**: The Experimental Features section in Settings provides toggle controls for each configured feature.

4. **Consumption**: Engine code can read `experimentalFeatures[key]` to check if a feature is enabled.

### Example JSON Shape

```json
{
  "settings": {
    "experimentalFeatures": {
      "my-new-feature": true,
      "another-experiment": false
    }
  }
}
```

### Dashboard UI

The Experimental Features section in Settings shows:
- Feature name and enabled/disabled toggle for each configured feature
- Global scope indicator (features are shared across projects)
- Description explaining the purpose of experimental features

Common built-in dashboard flags include:
- `insights`
- `roadmap`
- `memoryView`
- `skillsView`
- `nodesView`
- `devServerView`
- `todoView` (enables dashboard Todo View; see [Todo View](./todo-view.md))
- `researchView`
- `evalsView` (gates Evals dashboard view, Settings → Scheduled Evals section, and scheduled-eval cron execution)
- `remoteAccess`
- `agentOnboarding` (enables the **AI Interview** option inside the New Agent dialog)

---

## Background Memory Summarization & Audit

Fusion can automatically extract insights from project memory and prune transient content on a schedule. This feature is disabled by default and can be enabled via settings.

### How It Works

1. **Scheduled Extraction**: When `insightExtractionEnabled` is `true`, a background automation runs on the configured `insightExtractionSchedule` (default: daily at 2 AM).

2. **AI-Powered Analysis**: The automation uses an AI agent to read canonical long-term memory (`.fusion/memory/MEMORY.md`) from the layered `.fusion/memory/` workspace plus `.fusion/memory/memory-insights.md`, extract new insights, and produce a pruned working memory candidate.

3. **Insight Merging**: New insights are automatically merged into `.fusion/memory/memory-insights.md` under the appropriate category (Patterns, Principles, Conventions, Pitfalls, Context). Duplicates are skipped.

4. **Memory Pruning**: The AI agent also produces a pruned version of working memory containing only durable items:
   - **Preserved**: Architecture, Conventions, Pitfalls, Context sections with durable content
   - **Pruned**: Task-specific notes, one-time observations, outdated entries

5. **Audit Report**: After each extraction run, a `.fusion/memory/memory-audit.md` file is generated with:
   - Working memory status (presence, size, sections)
   - Insights memory status (insight counts by category)
   - Last extraction results (success/failure, insight count, duplicates skipped)
   - **Pruning outcome** (applied/skipped, size delta, reason)
   - Health status (healthy/warning/issues)
   - Individual audit checks

### Output Files

| File | Description |
|------|-------------|
| `.fusion/memory/MEMORY.md` | Long-term memory (updated when pruning is applied and validated) |
| Legacy top-level memory file | Deprecated migration fallback (compatibility only; not canonical storage) |
| `.fusion/memory/memory-insights.md` | Long-term insights distilled from working memory |
| `.fusion/memory/memory-audit.md` | Human-readable audit report after each extraction |

### Settings Interaction

| Setting | Effect |
|---------|--------|
| `insightExtractionEnabled` | Enables/disables the automation |
| `insightExtractionSchedule` | Cron expression for when extraction runs (default: `"0 2 * * *"` = daily at 2 AM) |
| `insightExtractionMinIntervalMs` | Minimum time between extractions (default: 24 hours) |

### Safety Guarantees

- **Pruning validation**: Before pruning is applied, the candidate is validated to ensure it preserves at least 2 of 3 required sections (Architecture, Conventions, Pitfalls). Invalid candidates are safely ignored.
- **Graceful failures**: Malformed AI output does not destroy existing memory. Prior files are preserved.
- **Isolated processing**: Post-run callback errors are logged but do not flip successful runs to failed.
- **Startup sync**: Automation schedule is synchronized before the cron runner starts, preventing stale config races.
- **Non-destructive by default**: If the AI produces no prune candidate or validation fails, working memory remains unchanged.

### Configuration Example

```json
{
  "settings": {
    "insightExtractionEnabled": true,
    "insightExtractionSchedule": "0 2 * * *",
    "insightExtractionMinIntervalMs": 86400000
  }
}
```

### Cron Expression Format

Standard cron format: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|-----------|---------|
| `0 2 * * *` | Daily at 2:00 AM (default) |
| `0 */6 * * *` | Every 6 hours |
| `0 9 * * 1` | Weekly on Monday at 9:00 AM |

### Memory Backups

Memory backups snapshot memory files into timestamped directories under `memoryBackupDir` (default: `.fusion/backups/memory`).

- Project memory source: `.fusion/memory/**`
- Agent memory source: `.fusion/agent-memory/**`
- Snapshot layout:
  - `memory-YYYY-MM-DD-HHMMSS/project/...`
  - `memory-YYYY-MM-DD-HHMMSS/agents/<agentId>/...`

CLI commands:

- `fn memory-backup --create` — Create a memory backup now.
- `fn memory-backup --create --scope <project|agents|all>` — Override scope for this run.
- `fn memory-backup --list` — List memory backup snapshots.
- `fn memory-backup --restore <filename>` — Restore from a snapshot directory.

The default schedule is `0 3 * * *` (daily at 3:00 AM), offset from database backups (`0 2 * * *`).

### Scheduling Scope

Fusion supports scoped automations and routines:

- **Global scope** (`scope: "global"`) — Executes across all projects. Useful for backups, insight extraction, and cross-project maintenance.
- **Project scope** (`scope: "project"`) — Executes within a single project only. Useful for project-specific CI, tests, and deployments.

**Defaults and resolution:**
- When `scope` is omitted, Fusion treats the entry as `project` scope with `projectId: "default"`.
- Global-scope entries ignore `projectId`.
- Project-scope lookups require `projectId`; missing values fall back to `"default"`.

**Settings that interact with scheduling:**
- `autoBackupEnabled` / `autoBackupSchedule` — Backup automation respects scope like any other scheduled task.
- `insightExtractionEnabled` / `insightExtractionSchedule` — Insight extraction can be configured as global or project-scoped.
