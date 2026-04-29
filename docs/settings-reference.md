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
| `defaultProvider` | `string` | `undefined` | Default AI provider. |
| `defaultModelId` | `string` | `undefined` | Default AI model ID. |
| `fallbackProvider` | `string` | `undefined` | Fallback provider when the primary default model hits transient provider failures. |
| `fallbackModelId` | `string` | `undefined` | Fallback model ID (must pair with `fallbackProvider`). |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high"` | `undefined` | Default reasoning effort for AI sessions. |
| `ntfyEnabled` | `boolean` | `false` | Enable ntfy push notifications. |
| `ntfyTopic` | `string` | `undefined` | ntfy topic name. |
| `ntfyBaseUrl` | `string` | `undefined` | Optional custom ntfy server base URL (must use `http://` or `https://`). If blank/unset, Fusion uses `https://ntfy.sh` for both runtime and test notifications. |
| `ntfyEvents` | `("in-review" \| "merged" \| "failed" \| "awaiting-approval" \| "awaiting-user-review" \| "planning-awaiting-input" \| "gridlock")[]` | `["in-review","merged","failed","awaiting-approval","awaiting-user-review","planning-awaiting-input","gridlock"]` | Event types that trigger ntfy notifications. `planning-awaiting-input` fires when planning mode is waiting on user input. `gridlock` fires when all schedulable todo tasks are blocked. |
| `ntfyDashboardHost` | `string` | `undefined` | Dashboard host used to build deep links in notifications. |
| `notificationProviders` | `NotificationProviderConfig[]` | `[]` | Array of pluggable notification provider configurations. Each entry uses `{ id, name, enabled, config }` and is dispatched by provider ID (for example `ntfy` or `webhook`). |
| `defaultProjectId` | `string` | `undefined` | Default project for multi-project CLI operations when `--project` is omitted. |
| `setupComplete` | `boolean` | `undefined` | Tracks completion of first-run setup. |
| `favoriteProviders` | `string[]` | `undefined` | Pinned providers shown first in model selectors. |
| `favoriteModels` | `string[]` | `undefined` | Pinned models in `{provider}/{modelId}` format. |
| `openrouterModelSync` | `boolean` | `true` | Sync OpenRouter model catalog into model pickers at startup. |
| `updateCheckEnabled` | `boolean` | `true` | When enabled, Fusion performs a daily npm registry check for new `@runfusion/fusion` versions and shows update notices in CLI/dashboard. |
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
| `settingsSyncAuth` | `boolean` | `false` | Include model auth credentials in settings sync operations. |
| `settingsSyncInterval` | `number` | `900000` | Automatic sync interval in ms. Valid values: `300000`, `900000`, `1800000`, `3600000`. |
| `settingsSyncConflictResolution` | `"last-write-wins" \| "always-ask" \| "keep-local" \| "keep-remote"` | `"last-write-wins"` | Conflict strategy for divergent synced settings. |
| `dashboardCurrentNodeId` | `string` | `undefined` | Currently selected dashboard node ID. Restores the last-viewed node on fresh browser/PWA sessions. `undefined` means viewing the local node. |
| `dashboardCurrentProjectIdByNode` | `Record<string, string>` | `undefined` | Map of node ID to last-selected project ID. Use key `"local"` for the local node. Persists project context across browser restarts and PWA sessions. |

### Notification providers (pluggable)

Fusion now supports a provider-list notification model via `notificationProviders` while keeping legacy flat ntfy/webhook settings intact.

- **Recommended for new setups:** configure providers in `notificationProviders`.
- **Backward compatible:** existing `ntfyEnabled`, `ntfyTopic`, `ntfyBaseUrl`, `ntfyEvents`, and `ntfyDashboardHost` still work unchanged.
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
| `events` | `string[]` | `[]` | Event filter list. Empty/omitted means all events are sent. |

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
| `enginePaused` | `boolean` | `false` | Soft pause: stop dispatching new work while letting active sessions finish. |
| `maxConcurrent` | `number` | `2` | Max concurrent task-lane AI agents (planning, executor, merge). |
| `maxTriageConcurrent` | `number` | `2` | Max concurrent planning agents. |
| `globalMaxConcurrent` | `number` | `4` | System-wide max concurrent agents across all projects. |
| `maxWorktrees` | `number` | `4` | Max git worktrees. |
| `pollIntervalMs` | `number` | `15000` | Scheduler poll interval (ms). |
| `heartbeatMultiplier` | `number` | `1` | Global multiplier applied to all agent heartbeat intervals. Configured from the Agents screen (not Settings). |
| `defaultNodeId` | `string` | `undefined` | Optional project default node ID. When set, tasks without a per-task `nodeId` override are routed to this node. |
| `unavailableNodePolicy` | `"block" \| "fallback-local"` | `"block"` | Routing policy when a selected node is unavailable/unhealthy. `"block"` stops execution until the node is healthy; `"fallback-local"` runs the task on the local node instead. Applies to both project-default node routing and per-task node overrides. |

CLI usage:
- `fn settings set defaultNodeId <node-id>`
- `fn settings set unavailableNodePolicy <block|fallback-local>`

| `groupOverlappingFiles` | `boolean` | `true` | Serialize execution when file scopes overlap. |
| `overlapIgnorePaths` | `string[]` | `[]` | Optional project-relative file or directory paths to exclude from overlap blocking (for example `docs` or `generated/openapi.json`). Entries are trimmed, deduplicated, and must not be absolute or contain `..` traversal. |
| `autoMerge` | `boolean` | `true` | Auto-finalize tasks from `in-review`. |
| `mergeStrategy` | `"direct" \| "pull-request"` | `"direct"` | Completion mode (local direct merge vs PR-first). |
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
| `strictScopeEnforcement` | `boolean` | `false` | Block merges on out-of-scope file changes. |
| `buildRetryCount` | `number` | `0` | Build retry attempts during merge. |
| `verificationFixRetries` | `number` | `3` | Auto-fix retry attempts when verification fails during merge. |
| `buildTimeoutMs` | `number` | `300000` | Build timeout in milliseconds (5 minutes). |
| `requirePlanApproval` | `boolean` | `false` | Require manual approval before planning → todo. |
| `specStalenessEnabled` | `boolean` | `false` | Enforce automatic re-planning for stale plans. |
| `specStalenessMaxAgeMs` | `number` | `21600000` | Spec staleness threshold in ms (6 hours). |
| `taskStuckTimeoutMs` | `number` | `undefined` | Inactivity timeout for stuck-task recovery. |
| `aiSessionTtlMs` | `number` | `604800000` | TTL in ms for persisted planning/subtask/mission sessions (7 days). |
| `aiSessionCleanupIntervalMs` | `number` | `3600000` | Interval in ms for AI session cleanup sweeps (1 hour). |
| `autoUnpauseEnabled` | `boolean` | `true` | Auto-unpause after rate-limit-triggered pauses; manual pauses stay paused until explicitly unpaused by the user. |
| `autoUnpauseBaseDelayMs` | `number` | `300000` | Base unpause delay in ms (5 min). |
| `autoUnpauseMaxDelayMs` | `number` | `3600000` | Max auto-unpause delay in ms (1 hour). |
| `maxStuckKills` | `number` | `6` | Max stuck-task terminations before permanent failure. |
| `maxPostReviewFixes` | `number` | `1` | Max auto-revival attempts for in-review tasks failing pre-merge workflow steps. |
| `maxSpawnedAgentsPerParent` | `number` | `5` | Max child agents per parent task. |
| `maxSpawnedAgentsGlobal` | `number` | `20` | Max spawned agents across one executor instance. |
| `maintenanceIntervalMs` | `number` | `900000` | Periodic maintenance interval in ms (15 min). |
| `autoArchiveDoneTasksEnabled` | `boolean` | `true` | Enable periodic auto-archiving of done tasks. |
| `autoArchiveDoneAfterMs` | `number` | `172800000` | Age in ms after entering done before auto-archive (48h). |
| `archiveAgentLogMode` | `"none" \| "compact" \| "full"` | `"compact"` | Agent log retention strategy for cold archive snapshots. |
| `autoUpdatePrStatus` | `boolean` | `false` | Auto-refresh PR status badges. |
| `githubCommentOnDone` | `boolean` | `false` | When enabled, tasks imported from GitHub issues post a completion comment to the source issue when the task moves to `done`. |
| `githubCommentTemplate` | `string` | `undefined` | Optional issue comment template used by `githubCommentOnDone`. Supports `{taskId}` and `{taskTitle}` placeholders. If unset, Fusion uses a default completion message. |
| `autoCreatePr` | `boolean` | `false` | Auto-create PRs for completed tasks. |
| `autoBackupEnabled` | `boolean` | `false` | Enable scheduled DB backups. |
| `autoBackupSchedule` | `string` | `"0 2 * * *"` | Backup cron schedule. |
| `autoBackupRetention` | `number` | `7` | Number of backups to retain. |
| `autoBackupDir` | `string` | `".fusion/backups"` | Relative backup directory path. |
| `autoSummarizeTitles` | `boolean` | `false` | Auto-generate titles for long untitled descriptions. |
| `titleSummarizerProvider` | `string` | `undefined` | Provider for title summarization. |
| `titleSummarizerModelId` | `string` | `undefined` | Model ID for title summarization. |
| `titleSummarizerFallbackProvider` | `string` | `undefined` | Fallback provider for title summarization. |
| `titleSummarizerFallbackModelId` | `string` | `undefined` | Fallback model ID for title summarization. |
| `scripts` | `Record<string, string>` | `undefined` | Named script map used by script-mode workflow steps and setup hooks. |
| `setupScript` | `string` | `undefined` | Script key from `scripts` to run before task execution. |
| `insightExtractionEnabled` | `boolean` | `false` | Enable scheduled memory insight extraction. |
| `insightExtractionSchedule` | `string` | `"0 2 * * *"` | Insight extraction cron schedule. |
| `insightExtractionMinIntervalMs` | `number` | `86400000` | Minimum interval between extractions (24h). |
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
| `experimentalFeatures` | `Record<string, boolean>` | `{}` | Project-scoped experimental feature flags. |

### Remote Access settings (project-scoped)

Remote access settings are project-only (stored in `.fusion/config.json`), not global.
The canonical persisted shape is a nested `remoteAccess` object.

Use **[Remote Access runbook](./remote-access.md)** for setup prerequisites (Tailscale/Cloudflare), tokenized login-link security caveats, and operational troubleshooting. Keep this section as a schema reference.

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

Patch semantics for `PUT /api/settings`:
- `remoteAccess` patches are **deep-merged** so sibling branches are preserved.
- `remoteAccess: null` clears the full project override (falls back to defaults).
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

1. Per-task `modelProvider` + `modelId`
2. Project `executionProvider` + `executionModelId`
3. Global `executionGlobalProvider` + `executionGlobalModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Automatic provider/model resolution

### Reviewer model

1. Per-task `validatorModelProvider` + `validatorModelId`
2. Project `validatorProvider` + `validatorModelId`
3. Global `validatorGlobalProvider` + `validatorGlobalModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Automatic provider/model resolution

### Merger model

1. Project `defaultProviderOverride` + `defaultModelIdOverride`
2. Global `defaultProvider` + `defaultModelId`
3. Automatic provider/model resolution

### Title summarization model

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

1. Install one or more runtime plugins:

```bash
fn plugin install ./plugins/fusion-plugin-paperclip-runtime
fn plugin install ./plugins/fusion-plugin-hermes-runtime
fn plugin install ./plugins/fusion-plugin-openclaw-runtime
```

> 💡 In the dashboard, go to **Settings → Plugins → Fusion Plugins**. The **Bundled Runtime Plugins** section surfaces Hermes, Paperclip, and OpenClaw directly from shipped manifests, shows install status, and provides one-click install actions for runtimes that are not yet installed.

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

### OpenClaw Gateway Configuration

The OpenClaw runtime plugin connects to a running OpenClaw gateway instance through its OpenAI-compatible HTTP API. You can configure the gateway connection using plugin settings or environment variables.

| Setting | Type | Default | Description |
|---|---|---|---|
| `gatewayUrl` | `string` | `http://127.0.0.1:18789` | URL of the OpenClaw gateway instance |
| `gatewayToken` | `string` | (none) | Authentication token for the gateway |
| `agentId` | `string` | `"main"` | OpenClaw agent ID to use for sessions |

| Setting | Environment Variable | Default if Unset |
|---|---|---|
| `gatewayUrl` | `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` |
| `gatewayToken` | `OPENCLAW_GATEWAY_TOKEN` | (none — unauthenticated) |
| `agentId` | `OPENCLAW_AGENT_ID` | `main` |

Resolution priority is: plugin settings (`PluginContext.settings`) → environment variables → built-in defaults.

> ℹ️ These are **plugin-level** settings configured when the OpenClaw runtime plugin is installed/enabled (for example in the dashboard Plugin Manager or plugin config). They are not agent-level `runtimeConfig` fields. Agents only need `runtimeConfig.runtimeHint: "openclaw"`; gateway connection details are handled by the plugin.

> ⚠️ `gatewayToken` is a secret. Never log it or commit it to version control. For production, prefer setting `OPENCLAW_GATEWAY_TOKEN` in the environment.

For additional gateway/runtime details, see the [OpenClaw Runtime Plugin documentation](../plugins/fusion-plugin-openclaw-runtime/README.md).

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

Runtime selection is configured at the agent level via `runtimeConfig`. These examples show agents configured to use Paperclip, Hermes, and OpenClaw runtime hints:

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

The `experimentalFeatures` setting provides a first-class mechanism for managing project-scoped experimental feature toggles. This allows teams to explicitly mark capabilities as experimental and toggle them on/off from a dedicated section in the Settings dashboard.

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
- Project scope indicator (features are project-specific, not global)
- Description explaining the purpose of experimental features

Common built-in dashboard flags include:
- `insights`
- `roadmap`
- `memoryView`
- `skillsView`
- `nodesView`
- `devServerView`
- `todoView`

---

## Background Memory Summarization & Audit

Fusion can automatically extract insights from project memory and prune transient content on a schedule. This feature is disabled by default and can be enabled via settings.

### How It Works

1. **Scheduled Extraction**: When `insightExtractionEnabled` is `true`, a background automation runs on the configured `insightExtractionSchedule` (default: daily at 2 AM).

2. **AI-Powered Analysis**: The automation uses an AI agent to read canonical long-term memory (`.fusion/memory/MEMORY.md`) from the layered `.fusion/memory/` workspace plus `.fusion/memory-insights.md`, extract new insights, and produce a pruned working memory candidate.

3. **Insight Merging**: New insights are automatically merged into `.fusion/memory-insights.md` under the appropriate category (Patterns, Principles, Conventions, Pitfalls, Context). Duplicates are skipped.

4. **Memory Pruning**: The AI agent also produces a pruned version of working memory containing only durable items:
   - **Preserved**: Architecture, Conventions, Pitfalls, Context sections with durable content
   - **Pruned**: Task-specific notes, one-time observations, outdated entries

5. **Audit Report**: After each extraction run, a `.fusion/memory-audit.md` file is generated with:
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
| `.fusion/memory-insights.md` | Long-term insights distilled from working memory |
| `.fusion/memory-audit.md` | Human-readable audit report after each extraction |

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
