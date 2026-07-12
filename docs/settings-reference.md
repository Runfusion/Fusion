# Settings Reference

[← Docs index](./README.md)

This guide documents Fusion settings from `packages/core/src/types.ts`.

## Settings Scopes

Fusion uses a two-tier settings system:

- **Global settings** (`~/.fusion/settings.json`): user preferences shared across projects
- **Project settings** (`.fusion/config.json`): execution/runtime behavior for one project

At runtime, settings are merged. **Project settings override global settings** when keys overlap.

<!-- FNXC:SettingsDefaults 2026-07-04-00:00: FN-7505 mirrors this table's Default column into the dashboard Settings UI's own help text so operators do not need this doc open to see a field's default. -->
The `Default` column below is the same source of truth (`DEFAULT_GLOBAL_SETTINGS` / `DEFAULT_PROJECT_SETTINGS` in `packages/core/src/settings-schema.ts`) that the dashboard Settings UI now surfaces inline in each field's own description/help text (see `docs/dashboard-guide.md` → Settings discovery).

## Settings API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/settings` | Get merged settings (global + project). |
| `PUT /api/settings` | Update project settings only. |
| `GET /api/settings/global` | Get global settings only. |
| `PUT /api/settings/global` | Update global settings only. |
| `GET /api/settings/scopes` | Get separated `{ global, project, workflowSettings }` view. |

---

## Signal connector environment variables

Command Center signal connectors are configured with process environment variables read by the dashboard/API server. These values are secrets and are never returned by the connectors-status endpoint; `GET /api/command-center/signals/connectors` reports only per-provider `configured` booleans.

| Environment variable | Connector | Used by | Notes |
|---|---|---|---|
| `FUSION_SIGNAL_WEBHOOK_SECRET` | Generic webhook | `POST /api/signals/webhook` | Verifies `X-Fusion-Signature` (`sha256=`-prefixed HMAC-SHA256 hex) plus `X-Fusion-Timestamp`. |
| `FUSION_SIGNAL_SENTRY_SECRET` | Sentry | `POST /api/signals/sentry` | Verifies `Sentry-Hook-Signature` against Sentry issue webhook payloads. |
| `FUSION_SIGNAL_DATADOG_SECRET` | Datadog | `POST /api/signals/datadog` | Verifies the custom `X-Datadog-Signature` HMAC header; optional `X-Datadog-Timestamp` bounds replay. |
| `FUSION_SIGNAL_PAGERDUTY_SECRET` | PagerDuty | `POST /api/signals/pagerduty` | Verifies `X-PagerDuty-Signature` (`v1=<hex>`). |
| `FUSION_SIGNAL_GITLAB_SECRET` | GitLab | `POST /api/signals/gitlab` | Verifies GitLab's `X-Gitlab-Token` secret-token header for GitLab.com or self-managed project/group issue and merge-request webhooks. |
| `FUSION_MONITOR_INGEST_SECRET` | Monitor incidents API | `POST /api/monitor/incidents` | Separate bearer-token path for direct monitor ingestion; it is not used by `/api/signals/:provider`. |

See [Signals Connectors](./signals-connectors.md) for setup, signing, payload, and open/resolved mapping details.

---

## Global Settings

Defaults from `DEFAULT_GLOBAL_SETTINGS`; key scope from `GLOBAL_SETTINGS_KEYS`.

| Setting | Type | Default | Description |
|---|---|---:|---|
| `themeMode` | `"dark" \| "light" \| "system"` | `"system"` | Dashboard theme mode. Fresh installs follow the operating system light/dark preference until the user chooses Light, Dark, or System. |
| `colorTheme` | `ColorTheme` | `"shadcn-ember"` | Dashboard color theme preset. Use `"shadcn-custom"` to show the custom shadcn color picker in Settings → Appearance and the Command Center theme card. |
| `shadcnCustomColors` | `Record<string, string>` | `undefined` | Optional shadcn design-token override map for `"shadcn-custom"` only. Keys are CSS token names such as `--accent`, `--bg`, `--surface`, `--card`, `--border`, `--text`, `--text-muted`, workflow status tokens, and `--color-success`/`--color-warning`/`--color-error`; values must be sanitized `#RGB` or `#RRGGBB` hex colors. Missing or invalid entries fall back to the `shadcn-custom` base defaults and are not applied to other themes. |
| `language` | `"en" \| "zh-CN" \| "zh-TW" \| "fr" \| "es" \| "ko"` | `undefined` | UI language for the dashboard and TUI. When unset, the dashboard detects from localStorage → browser language and the CLI from `--lang` flag → environment locale, falling back to `en`. Validated at the store write boundary (`validateLocale`); invalid values are dropped. Reset to auto-detect via the dashboard's "Auto" language option or `fn settings set language auto` (clears the persisted key). |
| `dashboardFontScalePct` | `number` | `100` | Dashboard font scale percentage used by Appearance settings. Valid range: `85` to `125`; applied pre-hydration via document root font-size so board typography (column headers/counts, task cards, and quick-entry text) scales with the setting from first paint. |
| `dismissModalsOnOutsideClick` | `boolean` | `false` | Global dashboard preference for closing fixed modal overlays by clicking/tapping the backdrop. Off by default to prevent accidental modal dismissal; explicit close, cancel, and Escape paths remain available. |
| `defaultProvider` | `string` | `undefined` | Default AI provider. Anthropic has three independent surfaces, all executing on the direct `anthropic` provider except the CLI: (1) **direct OAuth** — a Claude subscription/OAuth login drives `anthropic/*` selections; Fusion sends the OAuth token to `https://api.anthropic.com/v1` with Claude Code identity headers (the same path the Claude Code CLI uses), so a subscription needs no API key. Credentials live under the `anthropic-subscription` auth/status/usage/banner id but are resolved for the direct provider at runtime; they are never stored or resolved as raw `ANTHROPIC_API_KEY` material. (2) **raw API key** — `ANTHROPIC_API_KEY`, a `models.json` `apiKey`, or an `api_key` auth credential uses `x-api-key` on the same direct provider and takes precedence over OAuth. (3) **Claude CLI** — the explicit `pi-claude-cli` model provider runs sessions through the local `claude` CLI. There is no runtime rerouting between these surfaces. |
| `defaultModelId` | `string` | `undefined` | Default AI model ID. |
| `modelPricingOverrides` | `Record<string, ModelPricing>` | `undefined` | Optional global Command Center pricing overrides keyed by lowercased `provider:model` or bare `:model`. Values store USD per 1M input, output, cache-read, and cache-write tokens plus optional `source`; they override the built-in pricing table for cost estimates only and are editable from Settings → Global Models → View pricing table. |
| `modelPricingFetchedAt` | `string` | `undefined` | ISO timestamp for the last successful one-click pricing refresh from the Settings → Global Models pricing summary. |
| `modelPricingSource` | `string` | `undefined` | Source label/URL for the current pricing override set, currently the LiteLLM model pricing JSON when fetched through the dashboard. |
| `fallbackProvider` | `string` | `undefined` | Fallback provider when the selected/default model hits transient provider failures or model-compatibility/auth-tier rejections. Dashboard chat also offers this fallback for explicit user-selected models, but the engine only swaps for retryable provider/model-selection failures. |
| `fallbackModelId` | `string` | `undefined` | Fallback model ID (must pair with `fallbackProvider`). |
| `fallbackThinkingLevel` | `ThinkingLevel` | `undefined` | Optional global fallback-lane thinking override for the `fallbackProvider`/`fallbackModelId` pair. Inherits `defaultThinkingLevel` when unset. |

Fallback thinking-level values are applied at runtime when Fusion swaps from the primary model to the configured fallback model; if unset, the active lane/default thinking level continues to apply.

| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | `undefined` | Default reasoning effort for AI sessions. `xhigh` requests maximum reasoning effort; Claude CLI adapters map it to `high` for non-Opus models and `max` for Opus models. If a provider/runtime rejects simultaneous `thinking` and `reasoning_effort` parameters, Fusion retries without the explicit thinking override instead of failing the run. |
| `ntfyEnabled` | `boolean` | `false` | Enable ntfy push notifications. |
| `failureNotificationMode` | `"sticky-only" \| "terminal-only" \| "all"` | `"sticky-only"` | Failure notification behavior. `sticky-only` defers failed-task notifications by `failureNotificationDelayMs` and suppresses transient self-recoveries. `terminal-only` suppresses while auto-retry is still active and only dispatches when `paused === true` or `column === "in-review"` with `status === "failed"`. `all` restores legacy immediate failure notifications. |
| `failureNotificationDelayMs` | `number` | `30000` | Delay window (ms) before evaluating/sending a `failed` notification in `sticky-only` and `terminal-only` modes. Set `0` for immediate dispatch in legacy `all` mode. |
| `ntfyTopic` | `string` | `undefined` | ntfy topic name. |
| `ntfyBaseUrl` | `string` | `undefined` | Optional custom ntfy server base URL (must use `http://` or `https://`). If blank/unset, Fusion uses `https://ntfy.sh` for both runtime and test notifications. |
| `ntfyAccessToken` | `string` | `undefined` | Optional ntfy access token. When set, Fusion sends `Authorization: Bearer <token>` with ntfy publish requests, including Settings → Notifications test sends. Leave blank/unset to publish without authentication. |
| `ntfyEvents` | `("in-review" \| "merged" \| "failed" \| "awaiting-approval" \| "awaiting-user-review" \| "planning-awaiting-input" \| "cli-agent-awaiting-input" \| "gridlock" \| "board-stall-unrecovered" \| "fallback-used" \| "task-created" \| "memory-dreams-processed" \| "message:agent-to-user" \| "message:agent-to-agent" \| "message:room" \| "oauth-token-expired" \| "token-budget" \| "workflow-notify")[]` | `["in-review","merged","failed","awaiting-approval","awaiting-user-review","planning-awaiting-input","cli-agent-awaiting-input","gridlock","board-stall-unrecovered","fallback-used","memory-dreams-processed","message:agent-to-user","message:agent-to-agent","message:room","oauth-token-expired","token-budget"]` | Event types that trigger ntfy notifications. `planning-awaiting-input` fires when planning mode is waiting on user input. `cli-agent-awaiting-input` fires when a CLI agent session is waiting on terminal input, including tool-permission prompts; these notifications are de-duplicated per CLI session and include task/session metadata for deep links. `gridlock` fires when all schedulable todo tasks are blocked; delivery is cooldown-throttled (first alert immediately, then suppressed for 15 minutes until gridlock resolves). `board-stall-unrecovered` fires only after a board-stall auto-recovery sweep runs and a follow-up verification tick still sees zero progress. `fallback-used` fires when Fusion recovers from a retryable model failure by switching to a configured fallback model. `task-created` fires when an agent creates a new task (requires `sourceAgentId`) and is opt-in/off by default. `memory-dreams-processed` fires when manual dream processing writes a new `DREAMS.md` entry (project and/or agent); disable it via ntfy/webhook event filters if you want to opt out. `message:agent-to-user` fires when an agent sends a direct message to the user. `message:agent-to-agent` fires when an agent sends a message to another agent (including replies). `message:room` fires when an agent posts an assistant reply in a chat room. `oauth-token-expired` fires when a provider OAuth credential reaches its expiry and still needs re-authentication after any automatic refresh path has been tried; Fusion also throttles that notification and the matching startup expiry warning to at most once per provider every 12 hours, and the throttle persists across server restarts. `token-budget` fires when a task crosses token soft/hard caps. `workflow-notify` is emitted by workflow `notify` nodes and is opt-in/off by default; add it to `ntfyEvents` or a provider `events` list to deliver workflow-authored notifications. If you use a custom `ntfyEvents` list, these message and CLI-agent events must be present (or `ntfyEvents` must be unset so defaults apply) for the corresponding notifications to send. |
| `ntfyDashboardHost` | `string` | `undefined` | Dashboard host used to build deep links in notifications. |
| `taskTokenBudget` | `{ soft?: number; hard?: number; perSize?: { S?: { soft?: number; hard?: number }; M?: { soft?: number; hard?: number }; L?: { soft?: number; hard?: number } } }` | `undefined` | Global fallback per-task token budget policy. Project `taskTokenBudget` overrides this. |
| `webhookEnabled` | `boolean` | `false` | Enable webhook notifications for task lifecycle events. Part of the legacy flat settings; prefer `notificationProviders` for new setups. |

In **Settings → Notifications**, use **Test message inbox** or **Test room reply** to exercise the full message-dispatch pipeline (`NotificationService.dispatch` → provider delivery), not just a raw ntfy POST.

Fusion automatically falls back to ntfy's JSON publish format when a notification title or message contains non-Latin-1 characters, converts notification priority to ntfy's required integer scale (`1=min`, `2=low`, `3=default`, `4=high`, `5=urgent`), and truncates outgoing titles/messages to ntfy's documented size limits before sending.
| `webhookUrl` | `string` | `undefined` | Webhook endpoint URL. Must be `http://` or `https://`. Part of legacy flat settings. |
| `webhookFormat` | `"slack" \| "discord" \| "generic"` | `"generic"` | Webhook payload format. Part of legacy flat settings. |
| `webhookEvents` | `string[]` | `[]` | Event filter for webhook notifications. Empty/omitted means all events. Part of legacy flat settings. |
| `notificationProviders` | `NotificationProviderConfig[]` | `[]` | Array of pluggable notification provider configurations. Each entry uses `{ id, name, enabled, config }` and is dispatched by provider ID (for example `ntfy` or `webhook`). |
| `customProviders` | `CustomProvider[]` | `[]` | <a id="customproviders"></a>User-defined OpenAI-compatible, OpenAI Responses API (`apiType: "openai-responses"`), Anthropic-compatible, or Google Generative AI (`apiType: "google-generative-ai"`) providers used by the custom-provider API (`/api/custom-providers`). Each entry uses `{ id, name, apiType, baseUrl, apiKey?, supportsDeveloperRole?, anthropicPromptCaching?, models? }`; `supportsDeveloperRole` is an OpenAI-compatible opt-in that enables `developer` role emission (default/omitted is `false`, forcing safe `system` role). `anthropicPromptCaching` (FN-7689) is an opt-in for `openai-compatible`/`openai-responses` gateways that proxy an Anthropic-format backend (for example a self-hosted router fronting Claude models); when `true`, Fusion registers that provider's `openai-completions` models with pi-ai's `compat.cacheControlFormat = "anthropic"`, so pi-ai attaches Anthropic-style `cache_control` breakpoints to the system prompt, the last conversation message, and the last tool definition, letting the gateway serve cached-prefix reads/writes instead of re-billing the full context every turn. Default/omitted is `false` — leave it off for gateways that do not understand `cache_control` (e.g. Together, Fireworks) to avoid provider 400s. It is inert (a documented no-op) for `anthropic-compatible` providers, which already auto-cache without any flag, and for `google-generative-ai` providers, which have no `cache_control` concept. Enable it from Settings → Authentication → Advanced: Custom Providers via the "Enable Anthropic-style prompt caching" checkbox shown for OpenAI-compatible/OpenAI Responses provider entries. API keys are stored raw but masked in API responses. Fusion resolves these providers from the active global settings directory (`~/.fusion`, with legacy `~/.pi/fusion` and `~/.pi/kb` migration support) so custom-provider models remain available after restart. Dashboard, serve, and daemon startup refresh each configured provider's persisted `models` list from its `/models` endpoint on a best-effort basis; failures leave the previous list intact and do not block startup. In Settings → Authentication → Advanced: Custom Providers, use **Refresh Models** on a provider row to manually refresh that provider after changing credentials, endpoints, or upstream model availability. Saved local/LAN/internal provider URLs are eligible for this stored-provider refresh path, while the add/edit **Detect Models** form keeps stricter SSRF protections for untrusted one-off input. |
| `defaultProjectId` | `string` | `undefined` | Default project for multi-project CLI operations when `--project` is omitted. |
| `setupComplete` | `boolean` | `undefined` | Tracks completion of first-run setup. |
| `favoriteProviders` | `string[]` | `undefined` | Pinned providers shown first in model selectors. |
| `favoriteModels` | `string[]` | `undefined` | Pinned models in `{provider}/{modelId}` format. |
| `openrouterModelSync` | `boolean` | `true` | Sync OpenRouter model catalog into model pickers at startup. When an OpenRouter API key is configured, Fusion prefers `https://openrouter.ai/api/v1/models/user` and falls back once to `https://openrouter.ai/api/v1/models` on non-OK responses. |
| `openrouterAppAttribution` | `{ referer?: string; title?: string }` | `undefined` | Optional OpenRouter app attribution override. Use-time defaults are `referer: "https://runfusion.ai"` and `title: "Fusion"`; empty string suppresses that header. Applied to sync requests and registered OpenRouter provider request headers (`HTTP-Referer`, `X-Title`). |
| `openrouterModelFilters` | `{ supported_parameters?: string[]; output_modalities?: string[] }` | `undefined` | Optional model-catalog filters appended to OpenRouter sync requests as comma-joined query params (`supported_parameters`, `output_modalities`). See OpenRouter models API: <https://openrouter.ai/docs/api-reference/models>. |
| `openrouterProviderPreferences` | `{ order?: string[]; ignore?: string[]; only?: string[]; allow_fallbacks?: boolean; sort?: "price" \| "throughput" \| "latency"; require_parameters?: boolean }` | `undefined` | Optional OpenRouter provider routing preferences forwarded via `compat.openRouterRouting` on chat-completion requests. See OpenRouter provider routing: <https://openrouter.ai/docs/features/provider-routing>. |
| `opencodeGoModelSync` | `boolean` | `true` | Sync opencode-go model catalog at startup via `opencode models opencode --refresh`, and re-run that refresh after saving an `opencode`/`opencode-go` API key in Dashboard Settings, normalizing discovered `opencode/...` IDs into the `opencode-go` provider surface used by `/api/models`. |
| `updateCheckEnabled` | `boolean` | `true` | When enabled, Fusion performs a daily npm registry check for new `@runfusion/fusion` versions and shows update notices in CLI/dashboard. |
| `githubTrackingDefaultRepo` | `string` | `undefined` | Global fallback issue-tracking repo (`owner/repo`) used when task-level tracking is enabled and no project/task override is set. In Settings UI this is a detected-remote dropdown with a Custom fallback for manual entry. This key is dual-scope: global saves go through `PUT /api/settings/global` (Settings → Global General). |
| `gitlabEnabled` | `boolean` | `undefined` (effective `true`) | Global fallback enable switch for outbound GitLab integrations. Undefined preserves existing behavior; explicit `false` disables GitLab API fetch/import/comment/close/reconcile/refresh operations while leaving saved URL/token settings intact. Projects can override this key. Dashboard location: **Settings → Global General → GitLab Configuration** disclosure. |
| `gitlabInstanceUrl` | `string` | `undefined` (effective `https://gitlab.com`) | Global fallback GitLab web instance URL. Blank/unset defaults to GitLab.com. Values are trimmed and must be absolute `http://` or `https://` URLs without username/password userinfo; trailing slashes are normalized by `resolveGitlabConfig`. Projects can override this key. |
| `gitlabApiBaseUrl` | `string` | `undefined` (effective `https://gitlab.com/api/v4`) | Global fallback GitLab REST API base URL. Blank/unset derives `<instance>/api/v4`, preserving self-managed path prefixes such as `https://example.com/gitlab` → `https://example.com/gitlab/api/v4`. Values are trimmed and must be absolute `http://` or `https://` URLs without userinfo. |
| `gitlabAuthToken` | `string` | `undefined` | Global fallback GitLab access token used by later HTTP API integrations when the project does not set its own token. The dashboard renders this as a password input and never displays saved token values in helper text. The resolver trims whitespace and falls back to process `GITLAB_TOKEN` only when both project and global tokens are blank. |
| `gitlabAuthTokenType` | `"personal" \| "project" \| "group"` | `undefined` (effective `"personal"` when a token exists) | Global fallback GitLab token family label for operator clarity. Project tokens and group tokens remain limited to their associated project/group and role membership; this label does not expand authorization. Unsupported values are rejected by the GitLab auth resolver. |
| `autoReloadOnVersionChange` | `boolean` | `true` | When enabled (default), the dashboard automatically reloads when a new build version is detected via `/version.json` polling or service worker activation. Set to `false` to suppress automatic reloads — the user must manually refresh to pick up updates. |
| `modelOnboardingComplete` | `boolean` | `undefined` | Whether AI onboarding has been completed or dismissed. |
| `useCursorCli` | `boolean` | `undefined` | Enables the `cursor-cli` provider in model pickers after Cursor CLI status validation. Toggle from Settings → Authentication. This runtime auth is OAuth/session-based; Cursor usage metering is separate and reads a Cursor Admin API key from the dashboard process `CURSOR_API_KEY` env var. |
| `cursorCliBinaryPath` | `string` | `undefined` | Optional global, machine-local Cursor CLI executable override used by Settings → Authentication, status/enable validation, probes, and model discovery. Leave unset/blank to auto-detect `cursor-agent` then `cursor` on PATH. Use this when PATH points at the wrong Cursor install or Windows exposes a specific `.cmd`/`.bat` shim; invalid non-empty saves are rejected with bounded diagnostics. |
| `useGrokCli` | `boolean` | `undefined` | Enables the `grok-cli` provider in model pickers after Grok CLI status validation. Toggle from Settings → Authentication. Grok's direct xAI endpoint uses API-key auth (`GROK_API_KEY` env var or `~/.grok/user-settings.json` `apiKey`); when a `grok-cli/*` execution model has no Fusion-visible key, Fusion falls back to the `grok` CLI runtime if registered so the CLI can use its own auth store. |
| `grokCliBinaryPath` | `string` | `undefined` | Optional global, machine-local Grok CLI executable override used by Settings → Authentication, status/enable validation, probes, and model discovery. Leave unset/blank to auto-detect `grok` on PATH. Invalid non-empty saves are rejected with bounded diagnostics. |
| `executionGlobalProvider` | `string` | `undefined` | Global baseline provider for task execution. Project `executionProvider` overrides this. |
| `executionGlobalModelId` | `string` | `undefined` | Global baseline model ID for task execution. |
| `executionGlobalThinkingLevel` | `ThinkingLevel` | `undefined` | Optional global execution-lane thinking override. Inherits `defaultThinkingLevel` when unset. |
| `planningGlobalProvider` | `string` | `undefined` | Global baseline provider for planning. Project `planningProvider` overrides this. |
| `planningGlobalModelId` | `string` | `undefined` | Global baseline model ID for planning. |
| `planningGlobalThinkingLevel` | `ThinkingLevel` | `undefined` | Optional global planning-lane thinking override. Inherits `defaultThinkingLevel` when unset. |
| `validatorGlobalProvider` | `string` | `undefined` | Global baseline provider for validator/reviewer runs. Project `validatorProvider` overrides this. |
| `validatorGlobalModelId` | `string` | `undefined` | Global baseline model ID for validator/reviewer runs. |
| `validatorGlobalThinkingLevel` | `ThinkingLevel` | `undefined` | Optional global reviewer-lane thinking override. Inherits `defaultThinkingLevel` when unset. |
| `titleSummarizerGlobalProvider` | `string` | `undefined` | Global baseline provider for title summarization. Project `titleSummarizerProvider` overrides this. |
| `titleSummarizerGlobalModelId` | `string` | `undefined` | Global baseline model ID for title summarization. |
| `titleSummarizerGlobalThinkingLevel` | `ThinkingLevel` | `undefined` | Optional global summarization-lane thinking override. Inherits `defaultThinkingLevel` when unset. |
| `daemonToken` | `string` | `undefined` | Daemon authentication token (`fn_<32 hex chars>`) used by CLI clients. |
| `daemonPort` | `number` | `4040` | Port for daemon/serve mode binding. |
| `daemonHost` | `string` | `"127.0.0.1"` | Host for daemon/serve mode binding. Defaults to localhost only; pass `"0.0.0.0"` to expose on all interfaces. |
| `settingsSyncEnabled` | `boolean` | `false` | Enable automatic settings synchronization between nodes. |
| `settingsSyncAuth` | `boolean` | `false` | Include auth-material snapshots (`sharedState.authMaterial` and auth sync endpoints) when settings sync is enabled. Ignored when `settingsSyncEnabled` is `false`. |
| `settingsSyncInterval` | `number` | `900000` | Automatic sync interval in ms. Valid values: `300000`, `900000`, `1800000`, `3600000`. |
| `settingsSyncConflictResolution` | `"last-write-wins" \| "always-ask" \| "keep-local" \| "keep-remote"` | `"last-write-wins"` | Conflict strategy for divergent synced settings. |
| `secretsAccessPolicy` | `"auto" \| "prompt" \| "deny"` | `undefined` | Global default secret access policy used when a secret row does not set `access_policy`; resolver fallback remains `"prompt"`. |
| `secretsSyncPassphraseConfigured` | `boolean` | `false` | Read-only global probe for cross-node secrets-sync passphrase presence. Derived from `hasSyncPassphraseConfigured(secretsStore)` against the reserved `__sync_passphrase__` row in `secrets_global`. Not writable through settings APIs and never includes plaintext. |
| `owningNodeHandoffPolicy` | `"block" \| "reassign-to-local" \| "reassign-any-healthy"` | `"reassign-to-local"` | Global fallback policy for tasks whose owning checkout node is unavailable. Project-level `owningNodeHandoffPolicy` overrides this. |
| `dashboardCurrentNodeId` | `string` | `undefined` | Currently selected dashboard node ID. Restores the last-viewed node on fresh browser/PWA sessions. `undefined` means viewing the local node. |

> Mesh lifecycle note: settings sync is executed by the process-level `PeerExchangeService` started by `fn serve`/`fn dashboard`. `InProcessRuntime` does not instantiate settings-sync mesh services per project.
| `dashboardCurrentProjectIdByNode` | `Record<string, string>` | `undefined` | Map of node ID to last-selected project ID. Use key `"local"` for the local node. Persists project context across browser restarts and PWA sessions. |
| `persistAgentToolOutput` | `boolean` | `false` | Controls whether detailed `detail` payloads are persisted for `tool`, `tool_result`, and `tool_error` agent log entries. Tool timeline rows are still recorded by default; verbose tool arguments/results require opting in with `persistAgentToolOutput: true`. |
| `persistAgentThinkingLogPermanent` | `boolean` | `false` | Controls whether `thinking`/reasoning rows are persisted for permanent (non-ephemeral) agents. |
| `persistAgentThinkingLogEphemeral` | `boolean` | `false` | Controls whether `thinking`/reasoning rows are persisted for ephemeral/task-worker/spawned agents. |
| `persistAgentThinkingLog` *(deprecated)* | `boolean` | `false` | Legacy fallback alias for thinking-row persistence. When set and a granular key above is still undefined, this legacy value is used for that agent kind. Leaving both granular keys off preserves default-off behavior; assistant text and tool rows are unchanged. |
| `agentMemoryInclusionMode` | `"full" \| "index" \| "off"` | `"full"` | Global default memory prompt mode. Resolution order is `agent.runtimeConfig.agentMemoryInclusionMode` → `GlobalSettings.agentMemoryInclusionMode` → default `"full"`. Project settings no longer include this key. |
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
| `mcpServers` | `McpServersSettings` | `{ enabled: false, servers: [] }` | Global MCP server declarations shared across projects. Project `mcpServers` can enable/disable the effective set, override a same-named global server, or disable a global server with a same-named `enabled:false` entry. Sensitive env/header/token values must be `{ secretRef, scope }` references to Fusion-managed secrets, never plaintext. |
| `worktrunk` | `WorktrunkSettings` | `{ enabled: false, binaryPath: undefined, installedBinaryPath: undefined, onFailure: "fail" }` | Global defaults for worktrunk integration. Merged field-by-field with project `worktrunk` values; project values override global values for matching fields. |

### MCP server settings

`mcpServers` is available in both global and project settings:

```ts
type McpServersSettings = {
  enabled?: boolean;
  servers?: McpServerDefinition[];
};
```

Each server is named and uses one transport:

- `stdio`: `{ name, enabled?, transport: "stdio", command, args?, env? }`
- `sse`: `{ name, enabled?, transport: "sse", url, headers? }`
- `streamable-http`: `{ name, enabled?, transport: "streamable-http", url, headers? }`

Resolution uses project-over-global precedence by server name. The project-level `enabled` flag overrides the global flag when set; if the effective flag is false, no MCP servers are active. When enabled, global servers are loaded first, project servers with the same `name` replace them, and a project server with `enabled:false` removes the inherited server.

Enabled MCP servers are trusted once configured. Fusion materializes the effective server set at AI session creation and forwards it to every MCP-capable AI lane, including chat/planning, executor/tasks, heartbeat, reviewer, validator, merger, PR-response/PR-conflict merger helpers, workflow model nodes, summarization, evaluator, manual AI-prompt workflow steps, cron/automation, mission execution/interviews, milestone and slice interviews, and reflection paths. Readonly helper seams without a TaskStore/secrets reader (for example current research provider helpers, text refinement, and core memory compaction) carry FNXC skip comments until a store seam is threaded. Runtime support is guarded: Claude/pi/ACP-compatible runtimes receive MCP servers, while mock or unsupported runtimes skip forwarding and emit only a structured count/provider/runtime log entry, never server definitions or secret values.

Secret rule: `env` and `headers` maps are sensitive. Values must be Fusion secret references such as `{ "secretRef": "sec_...", "scope": "project" }` or `{ "secretRef": "sec_...", "scope": "global" }`. Write-boundary sanitizers and validators reject plaintext strings in these fields. Claude Desktop-style imports return `secretsToCreate` descriptors for plaintext env/header values and replace those values with secret refs in the imported definitions. At runtime, secret references are revealed through the scoped secrets store immediately before forwarding or validation, kept only in memory, and never echoed in API responses.

`POST /api/mcp/validate` validates an MCP server definition or configured server name against the current project context. The route resolves and materializes the target server with the same secret rules, then performs a bounded reachability probe (`stdio` supervised spawn, `sse`/`streamable-http` bounded fetch) and returns only `{ status, message? }` without resolved env/header contents.

`GET /api/mcp/discovered?scope=global|project` powers the Settings auto-discovery region. It reads only known Claude Desktop, Claude Code, Cursor, Windsurf, and VS Code config paths, returns inert candidates plus configured badges, and strips plaintext secret material from secret descriptors before responding.

See [MCP](./mcp.md) for the full configuration and usage guide, including dashboard, CLI, auto-discovery, Claude Desktop import, Fusion export, and reachability procedures.

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
| `events` | `string[]` | `[]` | Event filter list. Empty/omitted means all events are sent. Includes `memory-dreams-processed` for DREAMS.md updates from manual dream processing and `workflow-notify` for workflow `notify` nodes when explicitly filtered. |

#### ntfy provider config

When `id` is `"ntfy"` in `notificationProviders`, the provider `config` supports:

| Field | Type | Default | Notes |
|---|---|---:|---|
| `topic` | `string` | _required_ | ntfy topic name (1–64 chars, alphanumeric + `-_`). |
| `ntfyBaseUrl` | `string` | `"https://ntfy.sh"` | Optional custom ntfy server URL. |
| `ntfyAccessToken` | `string` | `undefined` | Optional access token. When set, provider sends `Authorization: Bearer <token>` on ntfy publishes. |
| `events` | `("in-review" \| "merged" \| "failed" \| "awaiting-approval" \| "awaiting-user-review" \| "planning-awaiting-input" \| "cli-agent-awaiting-input" \| "gridlock" \| "board-stall-unrecovered" \| "fallback-used" \| "task-created" \| "memory-dreams-processed" \| "message:agent-to-user" \| "message:agent-to-agent" \| "message:room" \| "oauth-token-expired" \| "workflow-notify")[]` | `DEFAULT_NTFY_EVENTS` | Event filter list used by the provider. `cli-agent-awaiting-input` is emitted when a CLI agent session waits on terminal input or a tool-permission prompt. For `gridlock`, enabled events are still cooldown-throttled at runtime (15-minute suppression window, reset on full resolution). `board-stall-unrecovered` is emitted when board-stall verification fails after an attempted auto-recovery sweep. `task-created` is available as an opt-in event and only fires for agent-created tasks (`sourceAgentId` required). `memory-dreams-processed` is emitted when manual dream processing appends a new project/agent `DREAMS.md` entry. `message:agent-to-user`/`message:agent-to-agent` are emitted for mailbox messages and deep-link to the specific message when `dashboardHost` is configured. `message:room` is emitted for assistant replies in chat rooms and deep-links to the room when `dashboardHost` is configured. `oauth-token-expired` is emitted when a provider OAuth credential has expired and cannot be automatically refreshed; Fusion suppresses repeat delivery for the same provider for 12 hours even across server restarts, and applies the same persisted window to the startup expiry warning log. `workflow-notify` is emitted by workflow `notify` nodes and remains opt-in/off by default because it is not included in `DEFAULT_NTFY_EVENTS`. |
| `dashboardHost` | `string` | `undefined` | Dashboard host for deep links in notifications. |

Disable daily update checks globally:

```bash
fn settings set updateCheckEnabled false
```

When the dashboard footer reports that a newer `@runfusion/fusion` version is available, **Update now** runs the same global npm install as `fn update` (`npm install -g @runfusion/fusion@latest`) and retries once with `--force` for the legacy `fn`/`fusion` binary-collision case. A successful install updates the global package on disk, but the currently running Fusion server is not hot-swapped; restart Fusion to run the newly installed version.

---

## Workflow Settings

<!--
FNXC:WorkflowSettings 2026-06-30-09:15:
Settings docs should keep workflow value resolution and prompt ownership separate: settings values are typed per-workflow/project data, while built-in prompt overrides are node text overlays edited through the workflow editor.
-->

Some knobs that used to live in this Settings reference as project settings are now
**workflow settings**: they are declared by a workflow and their values are stored
**per `(workflow, project)`**, not as ambient project settings. A workflow models
*how* tasks execute, so the timeouts, review gates, and per-phase model lanes that
govern that execution belong to the workflow.

**Where to set them.** The common model lanes for a project's default workflow are
available directly in **Settings → Project Models → Default workflow model lanes**:
Plan/Triage, Executor, Reviewer, and the Planning/Reviewer fallback lanes declared
by the default workflow. Primary Plan/Triage, Executor, Reviewer, and declared fallback rows show an inline Thinking Level control when the workflow declares the companion `*ThinkingLevel` setting; unset means inherit. Those dropdown controls use the shared model picker and are persisted by the Settings modal's primary **Save** action, which writes
workflow setting values for the active project's default workflow; they do not
restore the old project settings keys. The global **Fallback Model** remains in
Settings → General Models and includes its own inline Thinking Level selector for `fallbackThinkingLevel`; workflow-specific fallbacks are also editable from
the workflow editor Values tab. Title summarization is separate: set it in
**Settings → Project Models → Title and Git Commit Message Summarization Model**,
with its project fallback selector and global baseline in Settings → General/Global Models.

<!--
FNXC:WorkflowSettings 2026-06-17-09:13:
FN-6584 follows the FN-6580 readiness audit by keeping title summarization project/global-scoped. Do not list it as a workflow-editor lane; the workflow editor owns execution/review policy and workflow-declared model lanes only.
-->

For step execution, review/approval policy, and custom workflow settings, open the
[**workflow editor**](./workflow-editor.md) (the workflow node editor in the
dashboard) and select the **Settings** panel. On mobile, Settings is a
dedicated workflow editor destination beside Graph, Add, Fields, Columns, and
Actions. It has two tabs:

- **Definitions** — the typed declarations and defaults (read-only for the built-in
  `builtin:coding` workflow; editable for custom workflows).
- **Values** — the per-project values for the workflow that is open. Values are
  editable for any workflow, including built-ins. Common provider/model lane pairs
  (Plan/Triage, Executor, Reviewer, and fallbacks declared by the workflow) use the
  same model dropdown picker as Project Models so clearing or selecting a model
  updates both keys together. Declared primary and fallback lane thinking companions render inline
  and clear with the lane reset instead of as separate enum fields. Advanced/custom non-model settings still use typed
  controls. Built-in Plan Review/spec and Code Review revision caps also live here:
  leave `planReviewMaxRevisions` or `codeReviewMaxRevisions` empty for unbounded
  automatic revisions, enter a non-negative integer to cap attempts, or enter `0`
  to disable automatic revision for that path. `plannerOversightLevel` is the
  workflow-native planner oversight mode and accepts `off`, `observe`, `steer`,
  or `autonomous` (default). Edits batch and commit through a single **Save** in
  the Values tab.

**How values resolve.** The engine resolves *effective settings* per task as
`stored value ?? declaration default`. The task-detail Workflow, Chat, and Agent
Log model displays use the same per-task effective workflow values, so configured
Plan/Triage, Executor, Reviewer, and fallback lanes match what task execution
will use instead of falling back to the ambient project settings response. A
built-in workflow with no stored value falls back to the declaration default,
which is byte-equal to the legacy project default — so an untuned project behaves
exactly as before. Switching a project to a **new** custom workflow starts that
workflow from its own declaration defaults, not the project's prior customized
values.

**Built-in prompt overrides.** Built-in workflow prompt/gate node text has a similar project-scoped persistence model, but it is separate from workflow settings: prompt overrides are stored per `(workflowId, nodeId, projectId)` and resolve as `stored prompt ?? shipped prompt`. Resetting a prompt deletes the stored node override and restores the built-in IR text; graph structure and setting declarations remain read-only for built-ins. See [Workflow Steps → Overriding built-in workflow prompts](./workflow-steps.md#overriding-built-in-workflow-prompts).

**Agents.** `fn_workflow_create`/`fn_workflow_update` accept `settings` declarations,
and the `fn_workflow_settings` tool reads and writes values with the same typed
validation as the editor (invalid values are rejected, never persisted). See
[engine tools reference](../packages/cli/skill/fusion/references/engine-tools.md).

**Sync & export.**

- Workflow settings are **not synced across nodes yet** (a node-sync channel for the
  value table is planned). Cross-node settings sync filters these keys out of its
  diff and surfaces a "Workflow settings are not synced across nodes yet" note.
- Workflow setting values **are** included in **settings export v2** under a
  `workflowSettings` section keyed `workflowId → { settingKey: value }`. Importing a
  v1 export upgrades any moved key it carries into the appropriate workflow's values
  instead of writing it back into project settings.

### Where did my setting go?

These groups moved out of project settings and into workflow settings (built-in
`builtin:coding` declares all of them with their former defaults):

| Group | Keys (examples) |
|---|---|
| **Step execution** | `workflowStepTimeoutMs`, `runStepsInNewSessions`, `maxParallelSteps`, `workflowStepScopeEnforcement`, `strictScopeEnforcement`, `verificationFixRetries`, `maxPostReviewFixes`, `buildRetryCount` |
| **Review / approval** | Workflow values: `requirePrApproval`, `requirePlanApproval`, `reviewHandoffPolicy`, `maxReviewerContextRetries`, `maxReviewerFallbackRetries`, `planReviewMaxRevisions`, `codeReviewMaxRevisions`; project override: `planApprovalMode` |
| **Planner oversight** | `plannerOversightLevel` (workflow-native; values: `off`, `observe`, `steer`, `autonomous`); `plannerOversightNotificationLevel` (workflow-native; values: `silent`, `errors`, `important`, `all`); `plannerOverseerExecutorStuckAfterMs` (workflow-native; number, default `7200000` = 2h) |
| **Per-phase model lanes** | `executionProvider`/`executionModelId` + `executionThinkingLevel`, `planningProvider`/`planningModelId` + `planningThinkingLevel` (+ fallbacks), `validatorProvider`/`validatorModelId` + `validatorThinkingLevel` (+ fallbacks). Thinking values accept `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`; unset inherits. |

### Workflow-native triage policy settings

<!--
FNXC:WorkflowRouting 2026-06-22-12:00:
Triage workflow defaults are policy inputs, not permission to reroute tasks autonomously. Prompt guidance allows workflow selection only for explicit user requests or tasks the agent created.

FNXC:TriagePolicy 2026-07-04-00:00:
`triageProactiveSubtaskSplittingEnabled` is workflow/project-scoped so operators can disable automatic oversized-task splitting without disabling explicit per-task `breakIntoSubtasks: true` requests.
-->

The built-in workflows also declare triage/spec policy settings that were **not** moved from project settings. They are workflow-native declarations: they never lived in `DEFAULT_PROJECT_SETTINGS`, are not `MOVED_SETTINGS_KEYS`, and resolve only through the workflow effective-settings path.

| Setting | Default | Purpose |
|---|---:|---|
| `triageProactiveSubtaskSplittingEnabled` | `true` | Enables automatic large-task splitting guidance for oversized M/L tasks. Set to `false` to keep tasks whole unless `breakIntoSubtasks: true` is explicitly requested. |
| `triageSizeSmallMaxHours` | `2` | Size S upper hour boundary (`S (<2h)`). |
| `triageSizeMediumMaxHours` | `4` | Size M upper hour boundary (`M (2-4h)`). |
| `triageSizeLargeMaxHours` | `8` | Size L upper hour boundary; XL starts at `8h+`. |
| `triageSubtaskStepThreshold` | `7` | Canonical “MORE THAN 7 implementation steps” split-consideration threshold. |
| `triageSubtaskLargeStepSignal` | `9` | Broad-scope signal for large tasks whose plan reaches 9+ steps. |
| `triageSubtaskAdditiveStepSignal` | `12` | Additive partitioning signal for 12+ implementation steps. |
| `triageSubtaskPackageThreshold` | `3` | Canonical package/module breadth threshold (“MORE THAN 3 different packages/modules”). |
| `triageSubtaskFileScopeThreshold` | `20` | File Scope entry count that signals broad work. |
| `triageSubtaskRemediationBatchThreshold` | `30` | Large remediation batch threshold. |
| `triageNoCommitsDecisionVerbs` | all seven built-ins | Decision-only verbs: Decide, Evaluate, Verify, Confirm, Audit, Review whether, Investigate and report. |
| `triageDecisionOnlyWorkflowId` | `builtin:quick-fix` | Preferred workflow for decision-only/no-commit tasks when the user explicitly requests that routing or the agent is creating the task. |
| `triageDefaultWorkflowId` | `builtin:coding` | Default workflow for standard coding tasks and for existing tasks without an explicit user-requested or creator-owned workflow selection. |
| `leanPlanning` | `false` | Workflow-native fast-mode policy: select the lean `planning-fast` prompt variant instead of the full triage spec prompt. |
| `autoApproveSpec` | `false` | Legacy compatibility setting. Workflow Plan Review now owns optional pre-execution AI plan approval. |
| `planReviewMaxRevisions` | unset | Workflow-native Plan Review/spec revision cap. Unset/empty means unbounded automatic replans; a non-negative integer caps attempts; `0` disables automatic Plan Review revision. |
| `codeReviewMaxRevisions` | unset | Workflow-native Code Review remediation cap. Unset/empty means unbounded automatic code-fix passes; a non-negative integer caps attempts; `0` disables automatic Code Review remediation. |
| `plannerOversightLevel` | `autonomous` | Workflow-native planner oversight mode. `off` disables oversight; `observe` watches only; `steer` injects guidance or suggests revisions; `autonomous` enables bounded retry and targeted-fix recovery — but merge/PR progression and any destructive or external-service side effect ALWAYS require an explicit, recorded human confirmation before they run, even at `autonomous` (FN-7513's confirmation gate; see `docs/architecture.md` → "Planner overseer confirmation gate"). Tasks may set a nullable `Task.plannerOversightLevel` override (same four values) that wins over this workflow value when present; `null`/unset means "inherit the workflow value". `resolveEffectivePlannerOversightLevel` in `@fusion/core` computes the effective level (task override → workflow effective → `autonomous`). The per-task override is exposed in the dashboard as a "Planner oversight" selector (Inherit from workflow / Off / Observe / Steer / Autonomous recovery) in both the New Task dialog and Task Detail edit form, threaded through `createTask`/`updateTask` (FN-7515); the project/global default is set via the **Workflow Editor → Values** tab on the default workflow's `plannerOversightLevel` value, not in Project Settings. FN-7517 additionally exposes a quick inline oversight-level select in the Task Detail modal's meta-controls cluster (same `updateTask` override plumbing, no parallel path) plus manual nudge/stop-oversight/explain-current-action controls that call the overseer runtime directly — see `docs/dashboard-guide.md`. Engine read-site behavior beyond the FN-7513 confirmation gate remains follow-up work (FN-7510+). |
| `plannerOversightNotificationLevel` | `important` | Workflow-native planner-overseer notification verbosity (FN-7518). `silent` suppresses overseer notifications; `errors` notifies only on failures/escalations; `important` (the default) notifies on interventions/recovery actions and errors; `all` notifies on every observation. Resolves through the generic `resolveEffectiveSettings` default path with no special-casing, alongside `plannerOversightLevel`. This is a declaration-only setting: the notification-emission gating that reads it lands downstream in FN-7519 (intervention timeline) and FN-7520 (run-audit/activity events). |
| `plannerOverseerExecutorStuckAfterMs` | `7200000` (2h) | Workflow-native executor-stage stall threshold (FN-7743). Milliseconds of executor-stage inactivity — no execution activity since the task's last column move/update (`columnMovedAt ?? updatedAt`) — before a non-paused `in-progress` task is reported `signal: "stuck"` instead of `"progressing"`, feeding the existing `decidePlannerRecovery` → bounded `inject_guidance` recovery path at the `autonomous` oversight level (no effect at `off`/`observe`/`steer`). Fixes the class of bug where a genuinely hung/idle executor (dead session, silent agent) was indistinguishable from a healthy one and was never nudged, retried, or escalated. A missing/malformed activity timestamp degrades to `"progressing"` (fail-safe — never fabricates a stall), and a user-paused/approval-blocked/`autoMerge:false` task is still fully withheld from any autonomous action regardless of this threshold. Resolves through the generic `resolveEffectiveSettings` default path alongside `plannerOversightLevel`. See `docs/architecture.md` → "Executor-stage stall detection (FN-7743)". |

When `triageProactiveSubtaskSplittingEnabled` is `true` (the default), triage may proactively replace a large task with 2-5 child tasks when the size, step-count, package breadth, file-scope, or remediation-batch signals justify the coordination overhead. When it is `false`, those automatic oversized-task signals are advisory only for writing a realistic single-task spec; triage must not split solely because the task is large. The per-task `breakIntoSubtasks: true` flag is separate and remains mandatory: if a user explicitly asks for subtask breakdown, triage still evaluates and creates child tasks when the work is meaningfully decomposable.

In the dashboard Settings modal, Project Models exposes Plan/Triage, Executor,
Reviewer, and declared fallback dropdown controls for the default workflow. The
modal's primary **Save** action persists pending default-workflow model lane
overrides; there is no separate workflow-model save button. The workflow editor's
Settings → Values tab uses the same dropdown picker for declared provider/model
pairs, including fallbacks. Former locations for advanced workflow policy still
show a short redirect stub linking to the workflow editor (for one release).

> Note: the global baseline model lanes (`executionGlobalProvider` etc.) and
> integrity guarantees stay where they are — only the per-workflow process policy
> moved.

## Project Settings

Defaults from `DEFAULT_PROJECT_SETTINGS`; key scope from `PROJECT_SETTINGS_KEYS`.

Security-sensitive file-browser escape hatches are project-only. `allowAbsoluteFileBrowserPaths` is intentionally absent from global settings so one project's local-admin browsing policy cannot silently widen another project's workspace boundary.

> **Moved keys retained for reference.** Some rows below — the step-execution,
> review/approval, and per-phase model-lane keys listed under
> [Where did my setting go?](#where-did-my-setting-go) — are no longer project
> settings. They are documented here for type/default reference only; configure them
> in **Settings → Project Models** for default-workflow Plan/Triage, Executor,
> Reviewer, and declared fallback lanes, or in **workflow editor → Settings →
> Values** for advanced workflow policy. They are not writable through
> `PUT /api/settings`.

| Setting | Type | Default | Description |
|---|---|---:|---|
| `globalPause` | `boolean` | `false` | Hard stop: terminate active engine sessions and pause scheduling immediately. |
| `globalPauseReason` | `string` | `undefined` | Optional reason for `globalPause` (`"rate-limit"` for automatic pauses, `"manual"` for user-triggered pauses). Cleared on unpause. |
| `enginePaused` | `boolean` | `false` | Soft pause: stop dispatching new work while letting active sessions finish. While paused (including shared pause windows with `globalPause`), stuck-task polling/timers are suspended so paused wall-clock time does not count against `taskStuckTimeoutMs`. Clearing pause state resumes runtime scheduling and gives tracked active sessions a fresh stuck-task grace window before normal detection resumes; when `autoMerge` is enabled, eligible `in-review` tasks are re-swept into the auto-merge queue (paused/blocked/failed review tasks remain skipped). |
| `maxConcurrent` | `number` | `2` | Max concurrent task-lane AI agents (planning, executor, merge). Editable from Settings and the Command Center Overview controls dashboard. |
| `maxTriageConcurrent` | `number` | `2` | Max concurrent planning agents. Editable from Settings and the Command Center Overview controls dashboard. |
| `globalMaxConcurrent` | `number` | `4` | System-wide max concurrent agents across all projects. |
| `maxWorktrees` | `number` | `4` | Max git worktrees. Editable from Settings and the Command Center Overview controls dashboard. |
| `pollIntervalMs` | `number` | `15000` | Scheduler poll interval (ms). |
| `heartbeatMultiplier` | `number` | `1` | Global multiplier applied to agent heartbeat timing: both heartbeat intervals and unresponsive timeout bases. Configured from the Agents screen (not Settings). |
| `heartbeatScopeDiscipline` | `"strict" \| "lite" \| "off"` | `"strict"` | Heartbeat prompt procedure mode. `strict` keeps coordination-heavy scope discipline, `lite` restores pre-2026-05-11 wording, and `off` uses a minimal procedure. Per-agent `runtimeConfig.heartbeatScopeDiscipline` can override this default. |
| `heartbeatPromptTemplate` | `"default" \| "compact"` | `"default"` | Heartbeat execution-prompt trim template default. Per-agent `runtimeConfig.heartbeatPromptTemplate` overrides this value. Role fallback when unset everywhere is `executor`→`default`, non-executor coordination roles→`compact`. |
| `autoClaimCandidatesInPrompt` | `number` | `5` | Default no-task heartbeat candidate list length. Integer range `0-10`; `0` suppresses candidate prompt injection. |
| `engineerBacklogAutoClaim` | `boolean` | `false` | Opt engineer-role agents into no-task backlog auto-claim for implementation tasks. The default remains executor-only; per-agent `runtimeConfig.engineerBacklogAutoClaim` overrides this project default, and explicit routing/delegation is unchanged. Configure the project default in **Settings → Scheduling & Capacity → "Let engineer agents auto-claim backlog tasks"**; configure the per-agent override in **Agents → Agent Detail → Settings → Heartbeat Settings → "Engineer Backlog Auto-Claim"**. |
| `defaultNodeId` | `string` | `undefined` | Optional project default execution node for task dispatch. When set, tasks without a per-task `nodeId` override resolve to this node (`routing source: project-default`). See [Task Management → Node Routing](./task-management.md#node-routing). |
| `unavailableNodePolicy` | `"block" \| "fallback-local"` | `"block"` | Project routing policy used during scheduler dispatch when a task resolves to a remote node and node health is known. `"block"` keeps the task in `todo` if the node is unhealthy; `"fallback-local"` reroutes dispatch to local execution. See [Architecture → Task Routing Architecture](./architecture.md#task-routing-architecture). |
| `secretsAccessPolicy` | `"auto" \| "prompt" \| "deny"` | `undefined` | Project-level default secret access policy (overrides global default when present). |
| `secretsEnv` | `{ enabled?: boolean; filename?: string; overwritePolicy?: "skip" \| "merge" \| "replace"; keyPrefix?: string; requireGitignored?: boolean }` | `undefined` | Per-project secrets `.env` materialization configuration. When `enabled`, the engine writes `secretsEnv.filename` (default `.env`) into each acquired task worktree from secrets marked `env_exportable=true`. `overwritePolicy` controls merge/skip/replace against an existing file; `requireGitignored` (default `true`) refuses to write a non-gitignored path; `keyPrefix` filters which exported keys are included. See [Secrets](./secrets.md#env-auto-write-into-worktrees). |
| `mcpServers` | `McpServersSettings` | `{ enabled: false, servers: [] }` | Project-scoped MCP server settings. Project entries override global entries by `name`; `enabled:false` on a same-named project entry disables the inherited global server. Sensitive env/header/token material must be Fusion secret references only. See [MCP server settings](#mcp-server-settings). |
| `owningNodeHandoffPolicy` | `"block" \| "reassign-to-local" \| "reassign-any-healthy"` | `"reassign-to-local"` | Policy for tasks already checked out by an unavailable owning node. `"block"` parks, `"reassign-to-local"` takes over on local node, `"reassign-any-healthy"` makes takeover eligible on healthy peers. |
| `aiUndoTaskWorkflowId` | `string` | `"builtin:review-heavy"` | **FN-7556 / FN-7578.** Workflow selected for AI-undo board tasks created by `POST /api/tasks/:id/revert` (`mode: "ai"` and the `auto`/workspace conflict fallbacks) — a stricter review posture since these tasks reverse already-shipped code. Blank/unset means the created task inherits the project default workflow. The route validates the configured id and falls back to inherit on a blank or unknown value, so a misconfigured id never breaks AI-undo task creation. Editable from **Settings → General** ("AI-undo task workflow" picker, next to the workflow-enablement controls); choose "Inherit project default workflow" to store the blank/inherit sentinel. See [Task Management → Reverting Done/Archived tasks](./task-management.md#reverting-donearchived-tasks-git-path--ai-undo-fallback). |

| `groupOverlappingFiles` | `boolean` | `true` | Serialize execution when file scopes overlap. |
| `pluginTrustPolicy` | `"off" | "warn" | "enforce"` | `"warn"` | Plugin provenance enforcement mode: `off` records verification metadata only, `warn` blocks only `invalid` signatures, `enforce` allows only `verified-trusted` or `trusted-local`. |
| `ignoreHiddenOverlapPaths` | `boolean` | `true` | Exclude hidden dot paths from overlap serialization by default. A hidden path is any normalized project-relative path with a segment beginning with `.`, such as `.fusion/tasks/FN-1/PROMPT.md`, `.changeset/fix.md`, `.github/workflows/ci.yml`, `.env`, or `packages/.cache/out.js`. Set to `false` to restore legacy strict counting of dot paths. Explicit `overlapIgnorePaths` entries still apply in addition to this default filter, and still apply when hidden-path filtering is disabled. |
| `overlapIgnorePaths` | `string[]` | `[]` | Optional project-relative file or directory paths to exclude from overlap blocking (for example `docs` or `generated/openapi.json`). Entries are trimmed, deduplicated, and must not be absolute or contain `..` traversal. |
| `allowAbsoluteFileBrowserPaths` | `boolean` | `false` | Project-scoped Settings → General toggle for the workspace file browser. When enabled, slash-prefixed paths such as `/tmp` can be listed/read/written/downloaded through workspace file-browser routes while keeping existing file-size, binary, type, null-byte, traversal, and permission checks. Windows drive-letter paths remain blocked, and task-local file routes, memory APIs, worktree-copy validation, plugin bundle paths, and other validators are unchanged. |
| `autoMerge` | `boolean` | `true` | Auto-finalize tasks from `in-review`. Tasks can override this per-task (including at create time in New Task modal via **Auto-merge** = Default/Enabled/Disabled); explicit overrides are tagged with `autoMergeProvenance: "user"`, while tasks left at **Default** keep following the live global setting and do not snapshot it when entering review. Legacy pre-FN-6245 in-review rows that were stamped `autoMerge: true` are marked `autoMergeProvenance: "legacy-stamp"` on startup and can be inspected/cleared with Settings → Merge → **Legacy auto-merge stamp cleanup**, `fn pr automerge-cleanup [--apply] [--json]`, or `reconcileLegacyAutoMergeStamps({ apply: true })` after operator review. For grouped branch flows, per-task `autoMerge` governs member→group-integration landing while group `autoMerge` governs group→default-branch promotion eligibility. |
| `planApprovalMode` | `"workflow" \| "auto-approve-all" \| "require-all"` | `"auto-approve-all"` | Project-scoped override for the manual planning approval gate. Defaults to auto-approve-all (FN-7557) so new/unset projects skip the manual gate; `"workflow"` instead preserves the workflow-resolved `requirePlanApproval`; `"auto-approve-all"` moves every successfully specified task to `todo` without manual plan approval even when the selected workflow or stored workflow setting has `requirePlanApproval: true`; `"require-all"` parks every specified task at `status: "awaiting-approval"` regardless of workflow settings. Settings → Merge remains the full three-state editor; the Board Triage/intake **Auto-approve plan** switch is a binary shortcut for `"auto-approve-all"` vs `"workflow"`. This does not disable Workflow Plan Review or other non-plan safety gates. (A separate triage release-authorization gate that used to also park tasks at `status: "awaiting-approval"` was removed — see `b5b0458`, FN-7732; releases are now kept out of Fusion by agent instruction, AGENTS.md → "Releasing". The `awaitingApprovalReason: "release-authorization"` field value is retained only so legacy rows deserialize and now renders as an ordinary manual approval hold.) **FN-7569:** approving a plan under `"workflow"`/`"require-all"` manual approval records a fingerprint (hash) of the exact approved `PROMPT.md`. If the task is later re-specified (a replan, a plan-review reviewer-outage retry, or a self-healing rebound back to triage) and produces the identical plan content, the manual gate is idempotent: it skips re-parking at `status: "awaiting-approval"` and proceeds straight to `todo`, so the operator is never asked to re-approve a plan they already approved. A genuinely changed `PROMPT.md` still re-asks, and rejecting a plan (Reject Plan) clears the fingerprint so the regenerated plan is treated as new. This idempotency check lives strictly inside the manual gate, after Workflow Plan Review has already decided, and has no effect under `"auto-approve-all"` (which never reaches the manual gate). |
| `maxAutoMergeRetries` | `number` | `3` | Project-scoped positive-integer cap for auto-merge conflict-resolution retries before Fusion parks or bounces a task for human/recovery handling. Unset, non-finite, zero, or negative values fall back to `3` to preserve historical behavior. |
| `mergeRequestContractShadowEnabled` | `boolean` | `false` | Phase-1 FN-5741 write-only shadow flag (project/global setting). When enabled, executor/self-healing/merger persist merge-request records and `completion_handoff_accepted` markers for observation only; legacy mergeQueue + lifecycle remains authoritative. |
| `mergeStrategy` | `"direct" \| "pull-request"` | `"direct"` | Completion mode (local direct merge vs PR-first). |
| `directMergeCommitStrategy` | `"auto" \| "always-squash" \| "always-rebase"` | `"always-squash"` | Direct-merge commit routing mode. `always-squash` (default) forces the legacy squash path. `auto` keeps the legacy squash path for branches with zero or one substantive commit, but switches multi-substantive direct merges to a history-preserving rebase-and-merge/cherry-pick path so commit boundaries, subjects, and `Fusion-Task-Id` trailers survive on `main`. `always-rebase` always preserves per-commit history. Only applies when `mergeStrategy="direct"`. |
| `mergeIntegrationWorktree` | `"reuse-task-worktree" \| "cwd-integration-branch" \| "cwd-main"` | `"reuse-task-worktree"` | Auto-merge integration-root mode for direct merges only (`mergeStrategy="direct"`). `reuse-task-worktree` (default) runs the rebase/conflict/audit/finalize cascade inside the task worktree after FN-5279 reuse-handoff gates, leaving project-root `HEAD`/dirty state untouched. `cwd-integration-branch` is an explicit operator opt-in escape hatch that runs the cascade from the resolved integration branch in the project-root worktree and surfaces an operator-visible startup warning per FN-5348. `cwd-main` is a deprecated legacy alias: `normalizeMergeIntegrationWorktreeMode(...)` normalizes it to `cwd-integration-branch` at read time and emits a one-shot `[merger] settings.mergeIntegrationWorktree=cwd-main is legacy; normalized to cwd-integration-branch` warning; new configs must not use it. When `worktrunk.enabled=true`, worktrunk-managed merge/worktree handling takes precedence and this setting is advisory until the native path runs. Reuse-handoff refusal must never silently fall back to `cwd-integration-branch`: any future fallback path must emit `merge:cwd-integration-fallback-removed`, and current behavior leaves the task in `in-review` instead. |
| `mergeAdvanceAutoSync` | `"off" \| "ff-only" \| "stash-and-ff"` | `"stash-and-ff"` | After the merger advances the integration-branch ref, what to do in **other** worktrees still on that branch (typically your project-root checkout). `off` leaves them alone; users must `git pull` or click the Merge Advance Notice banner's Pull button to bring their checkout forward — this is the surprise behavior that made `git status` look like the merge had been reverted. `ff-only` auto-fast-forwards only when the other worktree's index and working tree are clean; dirty worktrees stay untouched and the banner still surfaces for manual pull. `stash-and-ff` (default) runs the Smart Pull pipeline (stash → fast-forward → pop) so local edits survive across the auto-sync. Pop conflicts emit `merge:auto-sync` audit events with `outcome: "stash-pop-conflict"` and surface through the dashboard's existing stash-conflict modal. Only applies to direct merges. |
| `integrationBranch` | `string` | `undefined` | Optional canonical project integration branch override. Resolution order for merge/self-healing/branch-conflict defaults is `integrationBranch` → legacy `baseBranch` → `origin/HEAD` symbolic ref → fallback `"main"`. Auto-detect intentionally checks `origin/HEAD` only; if a repository uses another remote (for example `gitlab`) and has no `origin` alias or `origin/HEAD`, Fusion logs a one-time warning naming discovered remotes and still falls back to `main`. Add an `origin` alias / `origin/HEAD` or set `integrationBranch` explicitly for non-`origin` remotes. This resolved value is used as `projectDefaultBranch` for `resolveTaskMergeTarget(...)`; task-level overrides still come from task metadata. |
| `prerebaseAutoEnabled` | `boolean` | `true` | Master switch for pre-merge auto-prerebase policy. When enabled, merger checks divergence from `<task.baseCommitSha>` to local `main` and may rebase before Stage 1/2 rebases. Ignored when `worktrunk.enabled=true` (worktrunk-managed path defers this layer). |
| `prerebaseHotFiles` | `string[]` | `[`"AGENTS.md"`, `"packages/core/src/store.ts"`, `"packages/core/src/db.ts"`, `"packages/engine/src/executor.ts"`, `"packages/engine/src/scheduler.ts"`, `"packages/engine/src/merger.ts"`, `"packages/dashboard/app/styles.css"`]` | Exact-path trigger list for auto-prerebase. If any listed file appears in `<task.baseCommitSha>..localMainHead`, merger runs prerebase first, then continues through the existing Stage 1/2 cascade. Empty array disables hot-file triggering. |
| `prerebaseDivergenceThreshold` | `number` | `50` | Commit-count trigger for auto-prerebase. When `<task.baseCommitSha>..localMainHead` commit count is greater than this value, prerebase fires even without hot-file overlap. Set `0` (or unset) to disable threshold triggering. |
| `mergeConflictStrategy` | `"smart-prefer-main" \| "smart-prefer-branch" \| "ai-only" \| "abort"` | `"smart-prefer-main"` | Controls the merger's conflict-resolution cascade. `smart-prefer-main` fast-forwards local main from `origin` when possible, then tries AI resolution, then auto-resolve heuristics, then a final `-X ours` fallback that prefers main unless the overlap guard below says otherwise. `smart-prefer-branch` uses the same cascade but ends with `-X theirs` so the task branch wins. `ai-only` never silently picks a side, and `abort` stops after the first AI attempt. Legacy `smart` / `prefer-main` values are normalized automatically. |
| `mergeDiffVolumeMinLines` | `number` | `20` | Minimum branch-net line volume before Fusion compares a file's staged squash delta against the branch's net delta. Applied at merge time and clamped to `>= 1`. |
| `mergeDiffVolumeThreshold` | `number` | `0.2` | Minimum staged-to-branch-net ratio allowed for a non-allowlisted file during auto-resolved squash finalization. Applied at merge time and clamped to `0..1`. |
| `mergeDiffVolumeAllowlist` | `string[]` | `[]` | Additional glob patterns skipped by the pre-commit diff-volume gate, beyond the built-in generated-file and lockfile allowlists. |
| `mergeStrategyOverlapBehavior` | `"flip-to-prefer-branch" \| "warn-only" \| "ignore"` | `"flip-to-prefer-branch"` | Safety control for `mergeConflictStrategy="smart-prefer-main"`. Before the Attempt 3 `-X ours` fallback, Fusion checks whether the task branch and recent `main` history overlap on the same files (30-commit lookback, matching the squash audit heuristics). `flip-to-prefer-branch` makes overlapping files prefer the task branch so hardening is not silently discarded (the FN-3936 class of regression). `warn-only` logs the overlap but keeps the legacy main-wins fallback. `ignore` disables the overlap guard and preserves legacy behavior exactly. |
| `postMergeAuditMode` | `"block" \| "warn" \| "off"` | `"warn"` | Controls the post-merge audit gate. **Warn** (default) logs findings and continues to auto-complete merges. **Block** is the stricter opt-in mode: it refuses auto-completion on duplicate-subject or touched-file overlap findings when you want maximum FN-3936-class drop protection. **Off** skips the audit entirely. Regardless of mode, rebase-strategy overlap-only findings are auto-cleared when deterministic merge verification has already proven the tree (FN-4333). |
| `mergeAuditAutoRecovery` | `"deterministic-only" \| "programmatic" \| "ai-assisted" \| "off"` | `"ai-assisted"` | Controls how the engine recovers when the post-merge audit finds risks. **Deterministic only** keeps just the verified-rebase short-circuit. **Programmatic** also diffs each flagged main commit against HEAD and passes when every contribution survives. **AI-assisted** additionally lets the merger write a single restoration commit when programmatic checks find real drops, and bounces the task back to in-progress before parking. **Off** disables all recovery — failed audits park the task immediately. |
| `autoRecovery.mode` | `"off" \| "deterministic-only" \| "programmatic" \| "ai-assisted"` | `"deterministic-only"` | Dispatcher mode for recoverable executor/self-healing failure classes. `"off"` is byte-identical legacy parking behavior (exact legacy `pausedReason` preserved). |
| `autoRecovery.perClass` | `Partial<Record<AutoRecoveryFailureClass, AutoRecoveryMode>>` | `undefined` | Optional per-class mode override map. Overrides `autoRecovery.mode` for listed classes only. Taxonomy strings follow FN-4533 design. |
| `autoRecovery.maxRetries` | `number` | `3` | Retry budget for dispatcher decisions. When `retryCount >= maxRetries`, dispatcher forces `pause` with rationale `retry-budget-exhausted`. |
| `reliabilityStatsResetAt` | `string` (ISO-8601) | `undefined` | Optional reliability baseline cursor used by `/api/health/reliability`; events older than this timestamp are excluded from reliability aggregates but retained in storage. |

### Per-task direct-merge override

When a project uses `mergeStrategy: "direct"`, an individual task can override the project-level `directMergeCommitStrategy` by adding this line anywhere in `PROMPT.md`:

```md
**Direct Merge Commit Strategy:** auto
```

Accepted values:
- `auto` — squash if the branch has 0–1 substantive commits; preserve per-commit history if it has 2+
- `always-squash` — force the legacy squash path for this task
- `always-rebase` — force the history-preserving path for this task

Override precedence for direct merges is:
1. Task `PROMPT.md` line `**Direct Merge Commit Strategy:** ...`
2. Project `directMergeCommitStrategy`
3. Default `"always-squash"`

### Sandbox settings

> **Experimental:** Sandbox settings are inert unless `experimentalFeatures.sandbox: true` is enabled in `~/.fusion/settings.json`.

Sandbox settings are project-scoped under `sandbox.*`. Until the experimental flag is enabled, Fusion always resolves sandbox execution to the default native backend and ignores both project-level sandbox backend settings and per-task PROMPT overrides.

| Setting | Type | Default | Description |
|---|---|---:|---|
| `sandbox.backend` | `"native" \| "sandbox-exec" \| "bubblewrap" \| "docker" \| "podman" \| "custom"` | `"native"` | Selects command-execution backend. `native` preserves current passthrough behavior, `sandbox-exec`/`bubblewrap` are Linux sandbox backends, `docker`/`podman` are containerized backends, and `custom` is reserved for project-specific adapters. |
| `sandbox.policy.allowNetwork` | `boolean` | `true` | Backend policy hint for outbound network access. |
| `sandbox.policy.allowedPaths` | `string[]` | `[]` | Backend policy hint for allowed filesystem paths (repo-relative paths/globs). |
| `sandbox.failureMode` | `"fail-hard" \| "fallback-native"` | `"fail-hard"` | Failure handling mode: `fail-hard` aborts when sandbox setup fails; `fallback-native` allows controlled fallback to native execution. |

Per-task PROMPT override line:

```md
**Sandbox:** <backend>
```

Sandbox backend precedence is:
1. Task `PROMPT.md` line `**Sandbox:** ...`
2. Project `sandbox.backend`
3. Default `"native"`

| `pushAfterMerge` | `boolean` | `false` | Auto-push after successful direct merges only. Pull-request strategy is excluded because PR mode publishes its task branch separately before PR creation. |
| `pushRemote` | `string` | `"origin"` | Git remote target used when `pushAfterMerge` is enabled. Accepts `remote` (for example `origin`) or `remote branch` (for example `upstream main`). Empty/unset values fall back to `origin` plus the resolved merge integration branch. |

When `pushAfterMerge` is enabled, a completed direct merge first runs `git pull --rebase <remote> <branch>` and then `git push <remote> <branch>`. For remote-only targets, Fusion resolves `<branch>` from the merge integration branch rather than the task worktree's incidental checkout, so reuse-task-worktree and detached-HEAD merge modes still push the intended branch. If the post-merge pull or push fails, the local merge remains completed and the done task records `pushedToRemote: false` with a `pushError` for operator follow-up.
| `worktreeInitCommand` | `string` | `undefined` | Shell command run after task worktree creation and in temporary merge worktrees before merge/review verification. In standalone AI merge, this runs inside each fresh `fusion-ai-merge-*` clean-room worktree after `git worktree add`; when unset, Fusion infers a package-manager install from the lockfile and may skip only when the install marker matches. Useful for project-specific setup beyond package install (for example `pnpm install --frozen-lockfile`, `cp .env.local .env`, or codegen/bootstrap scripts). |
| `worktreeCopyFiles` | `string[]` | `[]` | Repository-root-relative regular files to copy into each newly assigned non-resume task worktree. Configure from Settings → Worktrees with editable rows or Browse (useful for `.env`-style files). Fusion copies these files after fresh creation or pooled-worktree preparation and before `worktreeInitCommand`, secrets-env materialization, and task execution. Blank/duplicate entries are ignored; absolute paths, `..` traversal, missing files, directories, and unreadable/non-regular sources are skipped as non-fatal task-log/audit diagnostics without logging file contents. Resume/existing worktrees are not overwritten. |
| `testCommand` | `string` | `undefined` | Merge-time test command (hard gate). When unset, Fusion auto-detects from lockfile. |
| `buildCommand` | `string` | `undefined` | Merge-time build command (hard gate). |
| `recycleWorktrees` | `boolean` | `false` | Default: off (opt-in). Reuse worktrees from a pool for faster startup. |
| `showWorktreeGrouping` | `boolean` | `false` | Default: off. When off, WIP/processing columns render plain task cards without worktree group shells or worktree-name labels in both legacy and workflow-mode boards. When on, every WIP/processing column groups tasks by worktree and shows worktree names, including workflow-mode columns flagged as counting toward WIP. |
| `openTasksInRightSidebar` | `boolean` | `false` | Default: off. When off, board task-card clicks keep the existing full-panel task detail that replaces the board. When on and the right dock is active on desktop/tablet, board task-card clicks open the task detail in the right sidebar so the board stays visible; mobile or hidden/inactive right-dock states automatically fall back to the full-panel behavior. Non-board task-open paths, including list split detail, floating pop-outs, graph/plugin opens, and deep `changes`/`retries`/`workflow` opens, keep their existing behavior; ordinary right-dock Tasks-list cards are governed by `openMobileTasksInPopup` first and otherwise use embedded dock detail. |
| `openMobileTasksInPopup` | `boolean` | `false` | Default: off. When off, ordinary board task-card clicks keep the existing fallback behavior: the full-panel task detail, or the right dock when `openTasksInRightSidebar` is on and the dock is active; ordinary right-dock Tasks-list clicks open embedded dock detail with the normal back-to-list controls. When on, ordinary board task-card clicks and right-dock Tasks-list clicks open the task in the existing task popup/FloatingWindow surface on desktop, tablet, and mobile so the board or dock list remains visible; this popup route takes precedence over right-dock routing for those ordinary clicks. Desktop/tablet task popups restore the last saved popup size and position across task IDs and use the board/task-detail layer rather than the global utility layer, while their Activity dropdown stays above and attached during popup drag/resize; mobile task popups remain full-screen sheets. Deep `changes`/`retries`/`workflow` opens, list/detail opens outside the right-dock Tasks list, graph/plugin opens, nested task-detail opens, and explicit pop-out actions keep their existing behavior. |
| `showCostBadgeOnCards` | `boolean` | `false` | Default: off. When enabled from Settings → Appearance, board cards with positive recorded token usage show a read-time derived model-cost badge beside the execution-time badge. Unpriced models display `—`, and tasks with no token usage render no badge shell. |
| `executorAllowSiblingBranchRename` | `boolean` | `false` | Opt back into the legacy executor behavior that silently allocates sibling branches (`fusion/<task-id>-2`, `-2-2`, …) when the canonical task branch is already checked out elsewhere. When disabled (default), branch conflicts fail loudly and leave the task in `todo` with `status: "failed"` so operators can resolve conflicting branches/worktrees with git tooling before retrying. See [Task Management → Branch conflict handling](./task-management.md#branch-conflict-handling). The dashboard Settings modal exposes the same toggle with warning copy because this legacy mode is discouraged. |
| `worktreeNaming` | `"random" \| "task-id" \| "task-title"` | `"random"` | Naming mode for new worktree directories. |

#### Worktree backend settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `worktreesDir` | `string` | `undefined` | Optional container directory for task worktrees. Supports absolute paths, project-relative paths, `~` expansion, and `{repo}` token substitution (project root basename). Defaults to `<projectRoot>/.worktrees` when unset and applies to newly-created worktrees/pool scans. When `worktrunk.enabled` is `true`, worktrunk-managed layout takes precedence and this directory is ignored until worktrunk is disabled. |
| `worktrunk.enabled` | `boolean` | `false` | Enables the worktrunk backend (`WorktreeBackend`) for worktree operations. When enabled, worktrunk layout supersedes Fusion’s `.worktrees/<task-id>` and `worktreesDir` behavior. This key exists in global and project settings; project values override global values for matching fields. Setting this to `true` is rejected by the settings API and CLI until the pinned `wt` binary resolves and probe-verifies. Install first via Settings → Worktrunk integration (or `GET /api/worktrunk/status` + `POST /api/worktrunk/install-request`). Auto-install remains fail-closed until the upstream manifest is human-verified, so the default placeholder manifest will not fabricate a binary. See [Architecture: WorktreeBackend abstraction](./architecture.md#worktreebackend-abstraction). |
| `worktrunk.binaryPath` | `string \| undefined` | `undefined` | Optional absolute override for the `wt` binary. When unset, Fusion probes `wt` on `$PATH`, then checks the cached install path, and only then considers the gated auto-install flow. Auto-install is currently fail-closed until the upstream manifest is human-verified, so operators who enable `worktrunk.enabled` should set `worktrunk.binaryPath` or install `wt` themselves. When enabling `worktrunk.enabled`, this resolved/overridden path is still probe-verified before the setting is accepted. |
| `worktrunk.onFailure` | `"fail" \| "fallback-native"` | `"fail"` | Failure behavior for delegated worktrunk operations. `"fail"` (default) pauses the task with `pausedReason: "worktrunk_operation_failed"` and surfaces worktrunk stderr via `task.worktrunkFailure`. `"fallback-native"` switches to the native backend and emits a one-shot dashboard fallback alert per task (`task.worktrunkFallbackAlertedAt`). |

Default notes:
- `worktrunk.enabled`: Default: off (opt-in).
- `worktreesDir`: Default: `<projectRoot>/.worktrees`.

| `taskPrefix` | `string` | `"FN"` | Prefix used for newly generated task IDs. |
| `includeTaskIdInCommit` | `boolean` | `true` | Include task ID as commit scope in generated commits. |
| `commitAuthorEnabled` | `boolean` | `true` | Add deterministic `Co-authored-by` attribution on Fusion commits. |
| `commitAuthorName` | `string` | `"Fusion"` | Co-author trailer name when `commitAuthorEnabled` is true. |
| `commitAuthorEmail` | `string` | `"noreply@runfusion.ai"` | Co-author trailer email when `commitAuthorEnabled` is true. |
| `planningProvider` | `string` | `undefined` | Provider for planning agents. |
| `planningModelId` | `string` | `undefined` | Model ID for planning agents. |
| `planningFallbackProvider` | `string` | `undefined` | Fallback provider for planning. |
| `planningFallbackModelId` | `string` | `undefined` | Fallback model ID for planning. |
| `planningFallbackThinkingLevel` | `ThinkingLevel` | `undefined` | Optional workflow planning-fallback thinking override. Inherits the planning/default thinking level when unset. |
| `defaultProviderOverride` | `string` | `undefined` | Project-level override for global default provider baseline. |
| `defaultModelIdOverride` | `string` | `undefined` | Project-level override for global default model baseline. |
| `defaultThinkingLevelOverride` | `ThinkingLevel` | `undefined` | Optional project default-lane thinking override used when a task does not set `thinkingLevel`; inherits `defaultThinkingLevel` when unset. |
| `executionProvider` | `string` | `undefined` | Provider for task execution agents. |
| `executionModelId` | `string` | `undefined` | Model ID for task execution agents. |
| `validatorProvider` | `string` | `undefined` | Provider for plan/code reviewers. |
| `validatorModelId` | `string` | `undefined` | Model ID for plan/code reviewers. |
| `validatorFallbackProvider` | `string` | `undefined` | Fallback provider for reviewers; also used by reviewer UNAVAILABLE/error recovery retry before returning terminal UNAVAILABLE. |
| `validatorFallbackModelId` | `string` | `undefined` | Fallback model ID for reviewers; paired with `validatorFallbackProvider` for reviewer recovery retry. |
| `validatorFallbackThinkingLevel` | `ThinkingLevel` | `undefined` | Optional workflow reviewer-fallback thinking override. Inherits the validator/default thinking level when unset. |
| `workflowStepTimeoutMs` | `number` | `900000` | Maximum time in milliseconds a single workflow step may run before it is timed out. |
| `modelPresets` | `ModelPreset[]` | `[]` | Reusable executor/reviewer model presets. |
| `autoSelectModelPreset` | `boolean` | `false` | Auto-select presets by task size. |
| `defaultPresetBySize` | `{ S?: string; M?: string; L?: string }` | `{}` | Mapping for `S`/`M`/`L` → preset ID. |
| `autoResolveConflicts` | `boolean` | `true` | Enable automatic merge conflict resolution. |
| `smartConflictResolution` | `boolean` | `true` | Alias/preferred flag for smart conflict handling. |
| `mergerAutostashMaxAgeHours` | `number` | `24` | Maximum autostash age in hours before startup/periodic stale-stash sweep drops `fusion-merger-autostash:*` leftovers (minimum `1`). |
| `workflowStepScopeEnforcement` | `"block" \| "warn" \| "off"` | `"block"` | Intended to control pre-merge **prompt-mode** per-step file-scope enforcement (`block` requests revision on off-scope writes, `warn` logs and passes, `off` disables; `scopeOverride` bypasses). **Known follow-up:** the FN-4343 per-step invariant this setting drove ran under the legacy `runWorkflowSteps` loop, which was deleted in the graph-native cutover — the setting is still declared and round-trips, but the optional-group graph path does not yet enforce it per step. Merge-time File Scope enforcement is a separate gate and is unaffected. See [Workflow Steps → FN-4343](./workflow-steps.md#end-of-step-file-scope-invariant-for-prompt-pre-merge-steps-fn-4343). |
| `planOnlyScopeLeakEnforcement` | `"off" \| "warn" \| "block"` | `"warn"` | Controls executor-side `fn_task_done` scope-leak handling for **Plan-Only (Review Level 1)** tasks when touched files fall outside declared File Scope. `warn` logs a `[scope-leak]` activity entry and allows completion, `block` refuses `fn_task_done` with remediation guidance, and `off` disables this guard. `task.scopeOverride=true` bypasses enforcement. Review levels `0` and `>=2` stay warn-only telemetry. |
| `workflowRevisionForkOnScopeMismatch` | `boolean` | `true` | When enabled, workflow revision feedback that explicitly names files outside the task's declared File Scope is forked into a dependent follow-up triage task instead of being appended to the original task's `PROMPT.md`. Set to `false` to keep the legacy append-and-rerun behavior. |
| `strictScopeEnforcement` | `boolean` | `false` | Block merges on out-of-scope file changes. |
| `buildRetryCount` | `number` | `0` | Build retry attempts during merge. |
| `verificationFixRetries` | `number` | `3` | In-merge auto-fix retry attempts after deterministic test/build verification failures (0-3). |
| `buildTimeoutMs` | `number` | `300000` | Build timeout in milliseconds (5 minutes). |
| `verificationCommandTimeoutMs` | `number` | `undefined` | Optional project-scoped default timeout in milliseconds for executor `fn_run_verification` and configured deterministic test/build verification commands. When unset, `fn_run_verification` keeps its scope defaults (300s package, 900s workspace); when set to a positive value, it overrides both scope defaults while all verification still respects the 1800s hard cap. Set `0` or leave unset to use the legacy scope defaults. Marathon command shapes (`pnpm test`, `pnpm test:full`, `pnpm verify:workspace`, whole-package tests without file filters, and repeat loops) are soft-capped unless the agent explicitly passes `allowFullSuite: true`; opt-in full-suite runs still emit progress heartbeats and obey the hard cap. Project settings override global/default settings via the normal project settings precedence. |
| `requirePlanApproval` | `boolean` | `false` | Require manual approval before planning → todo. |
| `ephemeralAgentsEnabled` | `boolean` | `true` | Defaults to `true` for both new projects (seeded into `.fusion/fusion.db` on init) and upgrades from pre-FN-4153 projects (falls back to `true` whenever the persisted `config.settings` row omits the key). Users who explicitly set `false` keep that choice. When enabled, Fusion spawns short-lived `executor-FN-XXXX` workers for task execution. When disabled, only permanent executor agents run tasks; the scheduler auto-assigns dispatchable tasks using reporting-chain-aware load balancing, and tasks stay queued until an eligible permanent executor is available. |
| `agentProvisioning` | `{ approvalMode?: "always" \| "trusted-only" \| "never"; trustedRoles?: string[]; trustedAgentIds?: string[]; alwaysApproveDelete?: boolean }` | `{}` | Approval policy for `fn_agent_create`/`fn_agent_delete` (`approvalMode` default `trusted-only`, delete approvals default on via `alwaysApproveDelete: true`). |
| `sandboxProvisioning` | `{ approvalMode?: "always" \| "trusted-only" \| "never"; trustedRoles?: string[]; trustedAgentIds?: string[]; autoApproveBackendIds?: string[] }` | `{}` | Approval policy for sandbox host-bootstrap operations (backend install/pull/probe during `SandboxBackend.prepare()`). Default posture is strict: `approvalMode` resolves to `always`; `autoApproveBackendIds` defaults to `["native"]`. |
| `completionDocumentationMode` | `"off" \| "changeset" \| "changelog"` | `"off"` | Controls triage prompt injection for release-note artifacts in future task specs. `"changeset"` requires `.changeset/*.md` workflow guidance; `"changelog"` requires updating an existing changelog file (without inventing a new one); `"off"` disables this automation. |
| `specStalenessEnabled` | `boolean` | `false` | Enforce automatic re-planning for stale plans. |
| `specStalenessMaxAgeMs` | `number` | `21600000` | Spec staleness threshold in ms (6 hours). |
| `taskStuckTimeoutMs` | `number` | `undefined` | Inactivity timeout for stuck-task recovery. |
| `dispatchOscillationThreshold` | `number` | `5` | Number of rapid `todo↔in-progress` cycles allowed before scheduler auto-pauses the task with `pausedReason="dispatch-oscillation"`. |
| `dispatchOscillationWindowMs` | `number` | `60000` | Sliding window in ms used to count rapid `todo↔in-progress` cycles for the dispatch-oscillation breaker. |
| `dispatchOscillationSettleMs` | `number` | `5000` | Minimum settle delay after an engine-sourced `in-progress → todo` recovery before scheduler may re-dispatch the task. Prevents immediate same-tick redispatch races. |
| `runtimeStopDrainMs` | `number` | `2000` | Maximum milliseconds `InProcessRuntime.stop()` waits for in-flight tasks to drain after aborting AI sessions. Set `0` to skip drain polling entirely (useful for test/CI). |
| `engineActiveSinceMs` | `number` | `undefined` | Epoch ms when the in-process runtime last became active (startup or unpause). Time-based stuck/stalled/stale surfaces floor their activity anchor at this timestamp so paused/stopped downtime is not counted as quiet age. Runtime-managed; typically not set manually. |
| `engineActivationGraceMs` | `number` | `300000` | Extra grace window (ms) added after `engineActiveSinceMs` before time-based stuck/stalled/stale surfaces can fire. Set `0` to disable warmup. |
| `inReviewStallDeadlockThreshold` | `number` | `3` | Minimum number of identical consecutive in-review stall log entries (same stall code + reason) before self-healing auto-disposes the task by pausing it with `pausedReason="in-review-stall-deadlock"` and marking status `failed`. Set to `0` to disable. |
| `stalePausedReviewThresholdMs` | `number` | `86400000` | Threshold in ms for surfacing paused `in-review` tasks as stale paused review diagnostics (24 hours). `0` or `undefined` disables stale paused review surfacing/logging. |
| `inReviewStalledThresholdMs` | `number` | `86400000` | When `> 0`, enables surfacing of unpaused `in-review` tasks quiet beyond threshold via the `surface-in-review-stalled` self-healing pass; `0` disables. See **Backlog health alerts** below. |
| `stalePausedTodoThresholdMs` | `number` | `86400000` | Threshold in ms for surfacing paused `todo` tasks as stale backlog-health diagnostics (24 hours). When `> 0`, the `surface-stale-paused-todos` self-healing pass emits `Stale paused todo surfaced [stale-paused-todo]: paused <hours>h beyond <threshold>h threshold; ...` log entries. `0` or `undefined` disables stale paused todo surfacing/logging. |
| `staleInProgressWarningMs` | `number` | `14400000` | Task-age staleness warning threshold in ms for `in-progress` tasks (4 hours). `0` or `undefined` disables warning-level surfacing. |
| `staleInProgressCriticalMs` | `number` | `86400000` | Task-age staleness critical threshold in ms for `in-progress` tasks (24 hours). `0` or `undefined` disables critical-level surfacing. |
| `staleInReviewWarningMs` | `number` | `86400000` | Task-age staleness warning threshold in ms for `in-review` tasks (24 hours). `0` or `undefined` disables warning-level surfacing. |
| `staleInReviewCriticalMs` | `number` | `259200000` | Task-age staleness critical threshold in ms for `in-review` tasks (72 hours). `0` or `undefined` disables critical-level surfacing. |
| `pausedScopeDecayMs` | `number` | `1800000` | Minimum pause age in ms before self-healing can rebound a paused `in-progress` scope-holder back to `todo` when it is actively blocking at least one follower via `blockedBy`/`overlapBlockedBy`. Uses `columnMovedAt ?? updatedAt` as the pause-age proxy. Set `0` to disable decay-based rebound. |
| `metaTaskStallAutoCloseMs` | `number` | `7200000` | Maximum age in ms for blocked meta-task chains before self-healing auto-archives them as superseded. Set `0` to disable age-based stalled meta closure. |
| `metaTaskActiveExecutionGraceMs` | `number` | `1800000` | Grace period in ms used by meta-task auto-archive guards to treat recently active/in-progress executor work as in-flight and skip destructive meta auto-archive. Set `0` to disable the activity guard. |
| `boardStallSweepWindowMs` | `number` | `7200000` | Rolling board-health window in ms used by self-healing board-stall detection. Within each window, if blocked depth grows while no task exits `in-progress`, the stall sweep forces a paused-scope rebound and opens a verification tick. |
| `boardStallBlockedGrowthThreshold` | `number` | `3` | Minimum blocked-depth growth (count of tasks with `blockedBy`) within the current board-stall window required to trigger the board-stall recovery sweep. |
| `staleHighFanoutBlockerAgeThresholdMs` | `number` | `7200000` | Age threshold (ms) before high-fan-out blockers escalate in dashboard task cards/footer. Applies only to blockers currently in `in-progress`/`in-review`; age is computed from `columnMovedAt ?? updatedAt`. |
| `capacityRiskBannerEnabled` | `boolean` | `false` | Opt-in gate for the board-level capacity-risk banner. When enabled, the banner is shown once risk conditions are met and can be dismissed per project. |
| `capacityRiskTodoThreshold` | `number` | `20` | Todo threshold for the board-level capacity-risk banner (applies when `capacityRiskBannerEnabled` is true). Warning appears only when `todoCount > capacityRiskTodoThreshold` **and** there are zero idle non-ephemeral agents, auto-clears as soon as an idle agent becomes available or todo falls back to threshold/below, and re-arms after threshold/toggle changes. |
| `backlogPressureAlertEnabled` | `boolean` | `true` | Enables the scheduler backlog-pressure imbalance detector; set `false` to disable insight/log emission. |
| `backlogPressureRatioThreshold` | `number` | `10` | Alert threshold for `todoCount / max(inProgressCount, 1)`; alerts only when ratio is strictly greater than this value. |
| `backlogPressureMinTodoCount` | `number` | `5` | Minimum Todo inventory required before backlog-pressure detection can fire. |
| `backlogPressureAlertCooldownMs` | `number` | `86400000` | Minimum cooldown between backlog-pressure alerts (default 24h). |
| `dependencyBlockedTodoReportEnabled` | `boolean` | `true` | Enables dependency-blocked Todo backlog-health reporting. |
| `dependencyBlockedTodoFreshAgeMs` | `number` | `1800000` | Blocker-age threshold below which dependency-blocked Todo groups are bucketed as `fresh` (30 minutes). |
| `dependencyBlockedTodoStaleAgeMs` | `number` | `14400000` | Blocker-age threshold at/above which dependency-blocked Todo groups are bucketed as `stale` (4 hours). |
| `dependencyBlockedTodoMinCount` | `number` | `1` | Minimum blocked Todo count required for a blocker group to be included in reporting. |
| `dependencyBlockedTodoReportCooldownMs` | `number` | `21600000` | Minimum cooldown between dependency-blocked Todo insight emissions (6 hours). |
| `aiSessionTtlMs` | `number` | `604800000` | TTL in ms for persisted planning/subtask/mission sessions (7 days). |
| `aiSessionCleanupIntervalMs` | `number` | `3600000` | Interval in ms for AI session cleanup sweeps (1 hour). |
| `autoUnpauseEnabled` | `boolean` | `true` | Auto-unpause after rate-limit-triggered pauses; manual pauses stay paused until explicitly unpaused by the user. |
| `autoUnpauseBaseDelayMs` | `number` | `300000` | Base unpause delay in ms (5 min). |
| `autoUnpauseMaxDelayMs` | `number` | `3600000` | Max auto-unpause delay in ms (1 hour). |
| `maxStuckKills` | `number` | `6` | Max stuck-task terminations before permanent failure. |
| `maxBranchConflictRecoveries` | `number` | `5` | Max branch-conflict recovery retries before retry-storm failure handling triggers. |
| `maxReviewerContextRetries` | `number` | `2` | Max reviewer context-compaction retries (FN-4082) per task. |
| `maxReviewerFallbackRetries` | `number` | `2` | Max reviewer fallback-model retries (FN-4092) per task. |
| `maxTotalRetriesBeforeFail` | `number` | `25` | Master retry budget across all tracked retry counters; exceeding this fails the task with `RetryStormError`. |
| `maxPostReviewFixes` | `number` | `3` | Default max automatic fix passes for generic review/pre-merge optional-step feedback, including self-healing auto-revival of in-review tasks failing pre-merge workflow steps. Individual `optional-group` workflow nodes can override this with `config.maxRevisions` (non-negative integer or `"unbounded"`). Built-in Plan Review/spec and Code Review use workflow values `planReviewMaxRevisions` / `codeReviewMaxRevisions` first, and are unbounded when those values are unset. |
| `maxSpawnedAgentsPerParent` | `number` | `5` | Max child agents per parent task. |
| `maxSpawnedAgentsGlobal` | `number` | `20` | Max spawned agents across one executor instance. |
| `maintenanceIntervalMs` | `number` | `300000` | Periodic maintenance interval in ms (5 min). |
| `autoArchiveDoneTasksEnabled` | `boolean` | `true` | Enable periodic auto-archiving of done tasks. |
| `autoArchiveDoneAfterMs` | `number` | `172800000` | Age in ms after entering done before auto-archive (48h). |
| `doneAutoArchiveDays` | `number` | `0` | Integer day-based done-task retention. `0` disables day override; values `> 0` take precedence over `autoArchiveDoneAfterMs`. |
| `autoArchiveDuplicateTasksEnabled` | `boolean` | `false` | FN-7658: gates whether same-agent duplicate intake (FN-4892) auto-archives the later task. Default `false` — the duplicate is flagged in place (`nearDuplicateOf`/`nearDuplicateScore` marker, yellow "Duplicate" chip with Keep/Archive actions) instead of being archived automatically. Set `true` to restore the pre-FN-7658 auto-archive behavior. Does not affect ghost-bug preflight or tombstone-resurrection blocking. |
| `archiveAgentLogMode` | `"none" \| "compact" \| "full"` | `"compact"` | Agent log retention strategy for cold archive snapshots. |
| `autoUpdatePrStatus` | `boolean` | `false` | Auto-refresh PR status badges. |
| `githubCommentOnDone` | `boolean` | `false` | When enabled, tasks imported from GitHub issues post a completion comment to the source issue when the task moves to `done`. |
| `githubCommentTemplate` | `string` | `undefined` | Optional issue comment template used by `githubCommentOnDone`. Supports `{taskId}` and `{taskTitle}` placeholders. If unset, Fusion uses a default completion message. When the linked source issue's repository is the Fusion self-repo (`runfusion/fusion`, case-insensitive), Fusion appends a `Current version: v<current>` line and a `Target release: v<nextMinor>` line (next-minor bump, patch reset to 0, e.g. `0.55.0` → `0.56.0`), resolved via the published `@runfusion/fusion` CLI package version. If that version is unresolved/unparseable, the base comment is posted with no version lines. Comments on every other repository are byte-for-byte unchanged. |
| `githubCloseSourceIssueOnDone` | `boolean` | `false` | When enabled, source-imported GitHub issues are automatically closed with `state_reason: completed` when the Fusion task moves to `done`. A startup reconciliation sweep also closes missed open source issues on boot. |
| `githubTrackingEnabledByDefault` | `boolean` | `false` | Project-level default for enabling issue tracking on ordinary new tasks. When this is false, the Quick Entry GitHub toggle is disabled until tracking is enabled in Settings. Imported GitHub issues still follow this default unless `githubLinkImportedIssuesToTracking` is enabled. |
| `githubLinkImportedIssuesToTracking` | `boolean` | `false` | Project-scoped, import-only option. When enabled, GitHub issue imports from the dashboard, CLI, and extension tools persist `githubTracking: { enabled: true }` so Fusion adopts the imported source issue as the tracking issue without turning tracking on for ordinary new tasks. Duplicate/skipped imports do not create tasks or tracking metadata. |
| `githubTrackingDefaultRepo` | `string` | `undefined` | Project default issue-tracking repo (`owner/repo`) used before global fallback for tracked task creation (precedence: task override → project default → global default). In Settings UI this is a detected-remote dropdown with a Custom fallback for manual entry. This key is dual-scope: project saves go through `PUT /api/settings` (Settings → General → GitHub Tracking) while global saves go through `PUT /api/settings/global` (Settings → Global General). |
| `gitlabEnabled` | `boolean` | `undefined` (effective global fallback, then `true`) | Project GitLab integration enable switch. Explicit `false` disables outbound GitLab API imports, completion comments, close/reopen, source closed-at backfill, and tracking refresh side effects for this project without deleting saved URL/token fields. Dashboard location: **Settings → Project → General → GitLab Configuration** and **Settings → Project → Merge → GitLab Authentication** disclosure headers. |
| `gitlabInstanceUrl` | `string` | `undefined` (effective global fallback, then `https://gitlab.com`) | Project GitLab web instance URL for GitLab.com or self-managed GitLab. Blank/unset inherits global `gitlabInstanceUrl` and then defaults to GitLab.com. Values are trimmed and must be absolute `http://` or `https://` URLs without username/password userinfo; trailing slashes are normalized by `resolveGitlabConfig`. Dashboard location: **Settings → Project → General → GitLab Configuration**. |
| `gitlabApiBaseUrl` | `string` | `undefined` (effective global fallback, then `<instance>/api/v4`) | Optional project GitLab REST API base URL. Blank/unset inherits global `gitlabApiBaseUrl`; if still unset, Fusion derives `<instance>/api/v4`, preserving self-managed path prefixes. Override only for API gateways with a different absolute HTTP(S) base URL. |
| `gitlabAuthToken` | `string` | `undefined` | Project GitLab access token for later GitLab import/tracking/comment/close HTTP API tasks. Project value takes precedence over global `gitlabAuthToken`, then process `GITLAB_TOKEN`. The dashboard renders the field as a password input and trims values on save; blank clears the project override. Dashboard location: **Settings → Project → Merge → GitLab Authentication**. |
| `gitlabAuthTokenType` | `"personal" \| "project" \| "group"` | `undefined` (effective `"personal"` when a token exists) | Project GitLab token family label. Supported values are personal access token, project access token, and group access token. Select the token family that matches the credential; unsupported values fail auth resolution with `invalid_token_type`. |
| `gitlabCommentOnDone` | `boolean` | `false` | When enabled, tasks imported from GitLab project issues, group-backed issues with project identity, or merge requests post a completion note when the task moves to `done`. Requires a GitLab token with write-capable API access (`api`) to the target project. |
| `gitlabCommentTemplate` | `string` | `undefined` | Optional GitLab source note template used by `gitlabCommentOnDone`. Supports `{taskId}` and `{taskTitle}` placeholders. If unset, Fusion uses the same concise completion message shape as GitHub source comments. |
| `gitlabCloseSourceIssueOnDone` | `boolean` | `false` | When enabled, source-imported GitLab project issues and merge requests close when the Fusion task moves to `done` and reopen when moved out of `done`, where GitLab supports `state_event`. Fusion never merges merge requests; merged MRs and group issues without backing `projectId`/`projectPath` plus IID are skipped with task-log diagnostics. |
| `githubTrackingDedupEnabled` | `boolean` | `true` | When enabled, tracking issue creation searches open and closed repo issues for likely duplicates before opening a new issue (gh CLI search first, with REST search fallback). Set `false` to skip dedup and always create a new issue when tracking is enabled. Dashboard location: **Settings → Project → General → GitHub Tracking**. |
| `githubAuthMode` | `"gh-cli" \| "token"` | `"gh-cli"` | Project GitHub auth strategy used by tracking lifecycle integration. `"gh-cli"` requires an installed/authenticated `gh` CLI. `"token"` requires a non-empty `githubAuthToken` (or `GITHUB_TOKEN` env fallback). Tracking lifecycle auth is strict per selected mode (no cross-fallback). |
| `githubAuthToken` | `string` | `undefined` | Optional project PAT used when `githubAuthMode` is `"token"` (takes precedence over server startup token for tracking flows). |

GitLab enablement defaults effectively to on when `gitlabEnabled` is unset, so existing installations keep GitLab behavior until an operator turns the integration off. Project `gitlabEnabled` overrides global `gitlabEnabled`; if both are unset, GitLab API operations are active subject to token/URL validation. Disabling GitLab skips or rejects outbound network-backed operations but does not delete `gitlabInstanceUrl`, `gitlabApiBaseUrl`, `gitlabAuthToken`, or `gitlabAuthTokenType`; re-enabling resumes with the saved configuration. The Settings UI keeps these controls behind GitLab Configuration / GitLab Authentication disclosures, with the enable toggle in each disclosure header.

GitLab configuration examples: leave both URL fields blank for GitLab.com (`https://gitlab.com`, API `https://gitlab.com/api/v4`); set only `gitlabInstanceUrl=https://gitlab.example.com/gitlab` for a self-managed path-prefix install (API derives `https://gitlab.example.com/gitlab/api/v4`); set both URL fields when a self-managed API gateway differs from the web URL. GitLab auth uses access tokens over the GitLab REST API `PRIVATE-TOKEN` header; Fusion does not require or invoke `glab`. Supported token families are [personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/), [project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/), and [group access tokens](https://docs.gitlab.com/user/group/settings/group_access_tokens/). GitLab issue/MR import and tracking reads need `read_api` or `api`; posting notes/comments and closing/reopening issues or MRs need `api`. Project and group access tokens are constrained to their associated resource and role membership, so the configured token must cover the target project or group. Lifecycle actions use the configured API base URL for GitLab.com and self-managed instances, URL-encode project path identifiers, and skip unsupported targets such as terminal merged merge requests or group issues missing concrete project identity. Command Center signals, research/search providers, and star-prompt behavior remain deferred to later GitLab subtasks tracked from [GitLab Parity Inventory](./gitlab-parity-inventory.md).

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
| `autoSummarizeTitles` | `boolean` | `false` | Auto-generate titles for long untitled descriptions across dashboard/API task creation. Agent-created tasks from `fn_task_create` and `fn_delegate_task` always request summarization for untitled tasks, regardless of this setting. |
| `useAiMergeCommitSummary` | `boolean` | `true` | Use AI-generated merge commit summaries (subject + bullet body + diff-stat) instead of raw step-commit subject lists. |
| `titleSummarizerProvider` | `string` | `undefined` | Provider for title summarization. |
| `titleSummarizerModelId` | `string` | `undefined` | Model ID for title summarization. |
| `titleSummarizerThinkingLevel` | `ThinkingLevel` | `undefined` | Optional project summarization-lane thinking override. Inherits `titleSummarizerGlobalThinkingLevel` or `defaultThinkingLevel` when unset. |
| `titleSummarizerFallbackProvider` | `string` | `undefined` | Fallback provider for title summarization. |
| `titleSummarizerFallbackModelId` | `string` | `undefined` | Fallback model ID for title summarization. |
| `titleSummarizerFallbackThinkingLevel` | `ThinkingLevel` | `undefined` | Optional project title-summarizer fallback thinking override. Inherits the title-summarizer/global/default thinking level when unset. |
| `prTitlePromptInstructions` | `string` | `undefined` | Optional project guidance appended to the Create PR dialog's AI metadata system prompt for the generated PR title. Blank or whitespace-only values are treated as unset and keep the default prompt behavior. |
| `prDescriptionPromptInstructions` | `string` | `undefined` | Optional project guidance appended to the Create PR dialog's AI metadata system prompt for generated PR body fields (`summary`, `changes`, `testing`). Blank or whitespace-only values are treated as unset and keep the default prompt behavior. |
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
| `taskTokenBudget` | `{ soft?: number; hard?: number; perSize?: { S?: { soft?: number; hard?: number }; M?: { soft?: number; hard?: number }; L?: { soft?: number; hard?: number } } }` | `undefined` | Per-task token budget policy. Soft cap sends a one-time alert per task; hard cap pauses the task with `pausedReason: "token_budget_exceeded"`. |
| `runStepsInNewSessions` | `boolean` | `false` | Run each task step in a fresh agent session. |
| `maxParallelSteps` | `number` | `2` | Max concurrent step sessions when per-step sessions are enabled. |
| `missionStaleThresholdMs` | `number` | `600000` | Mission stale threshold in ms while `activating` (10 min). |
| `missionMaxTaskRetries` | `number` | `3` | Max automatic retries for failed mission-linked tasks. |
| `missionHealthCheckIntervalMs` | `number` | `300000` | Mission health-check interval in ms (5 min). |
| `agentPrompts` | `AgentPromptsConfig` | `undefined` | Custom role prompt templates and assignments edited in Settings → Prompts. |
| `promptOverrides` | `Record<string, string \| null>` | `undefined` | Global PromptKey segment-level overrides edited in Settings → Prompts (set a key to `null` to clear it). |
| `reflectionEnabled` | `boolean` | `false` | Enable/disable agent self-reflection workflows. |
| `reflectionIntervalMs` | `number` | `3600000` | Periodic reflection interval in ms. |
| `reflectionAfterTask` | `boolean` | `true` | Trigger reflection after task completion. |
| `reviewHandoffPolicy` | `"disabled" \| "comment-triggered" \| "always"` | `"disabled"` | Policy for agent-to-user review handoff detection. |
| `showQuickChatFAB` | `boolean` | `false` | Show floating quick-chat button (chat remains available via More menu). |
| `quickChatCloseOnOutsideClick` | `boolean` | `true` | Close the desktop Quick Chat floating window when clicking outside it; disable to keep it open until explicitly closed. |
| `chatAutoCleanupDays` | `0 \| 7 \| 14 \| 30 \| 60 \| 90` | `0` | Auto-cleanup retention window for idle chat sessions and chat rooms. `0` is off (default). When enabled, periodic self-healing maintenance deletes rows with `updatedAt` older than the configured day window. |
| `mailAutoCleanupDays` | `0 \| 7 \| 14 \| 30 \| 60 \| 90` | `0` | Auto-prune retention window for inbox/outbox mail messages. `0` is off (default). When enabled, periodic self-healing maintenance deletes `messages` rows where `updatedAt < cutoff` for the configured day window. Suggested setting: `7`. |
| `operationalLogRetentionDays` | `0 \| 7 \| 14 \| 30 \| 60 \| 90` | `30` | Retention window for SQLite operational-log tables (`activityLog`, `runAuditEvents`, `agentHeartbeats`), terminal `agentRuns` rows (by `endedAt`), and `agentConfigRevisions` (by `createdAt`). `0` is off. Lower values mean Reliability metrics/charts and the Activity feed will not show history older than the configured window; per-task task detail history is unaffected. Periodic maintenance prunes timestamped operational-log rows older than this many days while always preserving in-flight `agentRuns` (`endedAt IS NULL`) and the most-recent `agentConfigRevisions` row per agent. |
| `agentLogFileRetentionDays` | `number` | `0` | Retention window for per-task `.fusion/tasks/{ID}/agent-log.jsonl` files after a task is soft-deleted or archived. Periodic maintenance removes JSONL entries older than this many days; active tasks are never pruned. Set `0` to disable pruning. |
| `chatRoomRecentVerbatimMessages` | `number` | `25` | Number of newest chat-room messages kept verbatim in responder context before older entries are compacted (about 2× prior default history). |
| `chatRoomCompactionFetchLimit` | `number` | `200` | Upper bound on room messages fetched for transcript compaction per responder turn (raised to support larger retained context windows). |
| `chatRoomSummaryMaxChars` | `number` | `3000` | Hard cap for the synthesized “Earlier room context” summary block (about 2× the prior summary budget). |
| `researchSettings` | `ResearchProjectSettings` | `{ enabled: true, searchProvider: undefined, synthesisProvider: undefined, synthesisModelId: undefined, enabledSources: { webSearch: true, pageFetch: true, github: false, localDocs: true, llmSynthesis: true }, limits: { maxConcurrentRuns: 3, maxSourcesPerRun: 20, maxDurationMs: 300000, requestTimeoutMs: 30000 } }` | Project-specific Research enablement/overrides. Resolved together with `researchGlobalDefaults` via `resolveResearchSettings()`. |
| `researchEnabled` | `boolean` | `undefined` | Enable or disable research for this project. **Deprecated:** prefer `researchSettings.enabled`. |
| `researchMaxConcurrentRuns` | `number` | `undefined` | Project-level max concurrent research runs. |
| `researchDefaultTimeout` | `number` | `undefined` | Project-level default run timeout in milliseconds. |
| `researchMaxSourcesPerRun` | `number` | `undefined` | Project-level max sources per run. |
| `researchMaxSynthesisRounds` | `number` | `undefined` | Project-level max synthesis rounds. |

### Backlog health alerts

> Draft — finalize once FN-5009 / FN-5034 have shipped.

Backlog health is the alert family for scheduler/backlog imbalance, dependency-blocked Todo fanout, stale paused Todo work, and quiet unpaused in-review tasks. It is distinct from `capacityRiskBannerEnabled` / `capacityRiskTodoThreshold` (UI capacity-risk banner), `stalePausedReviewThresholdMs` (paused `in-review` detector), and reason-driven `in-review-stall` surfacing.

| Detector | Trigger condition | Settings | Severity | Surfacing channel | Cooldown / suppression |
| --- | --- | --- | --- | --- | --- |
| Backlog-pressure imbalance | TODO(FN-5009): finalize from `packages/engine/src/backlog-pressure-reporter.ts` trigger predicate implementation. | TODO(FN-5009): finalize from `packages/core/src/settings-schema.ts` backlog-pressure keys/defaults. | TODO(FN-5009): finalize from reporter title/content fields and fallback log-entry payload shape. | TODO(FN-5009): finalize from reporter insight category/fingerprint + fallback log-entry prefix behavior. | TODO(FN-5009): finalize from reporter cooldown and dedupe gates (`backlogPressureAlertCooldownMs`, enable/disable semantics). |
| Dependency-blocked Todo fanout | Groups Todo tasks blocked by the same non-done blocker (`dependencies` + `blockedBy`) using blocker fanout and blocker age buckets (`fresh`/`aging`/`stale`). Suppresses purely-fresh low-signal cases (`totalBlockedTodoCount < 3`). | `dependencyBlockedTodoReportEnabled`, `dependencyBlockedTodoFreshAgeMs`, `dependencyBlockedTodoStaleAgeMs`, `dependencyBlockedTodoMinCount`, `dependencyBlockedTodoReportCooldownMs` | Workflow alert with blocker-group summary (`blockedTodoCount`, `blockingAgeMs`, age bucket, top IDs). | Durable insight title prefix `Backlog health: dependency-blocked todos YYYY-MM-DD`; fallback per-task log prefix `[dependency-blocked-todo]` when insight store is unavailable. | Project cooldown gate via `dependencyBlockedTodoReportCooldownMs`; disabled entirely when `dependencyBlockedTodoReportEnabled` is false. |
| Stale paused Todo | TODO(FN-5034): finalize from `packages/core/src/stale-paused-todo.ts` signal threshold predicate and trigger semantics. | TODO(FN-5034): finalize from `packages/core/src/settings-schema.ts` `stalePausedTodoThresholdMs` row/default. | TODO(FN-5034): finalize from stale-paused-todo signal `code` + surfaced log payload fields. | TODO(FN-5034): finalize from `packages/engine/src/self-healing.ts` `surfaceStalePausedTodos` `logEntry` format and channel. | TODO(FN-5034): finalize from per-task suppression logic (history/code-change checks) in `surfaceStalePausedTodos`. |
| In-review stalled (`in-review-stalled`) | In-review, unpaused task is quiet beyond threshold while `autoMerge` is enabled, not actively merging/executing, not awaiting human review/approval, not merge-confirmed, and not already covered by a fresh reason-driven `In-review stall surfaced [` entry. | `inReviewStalledThresholdMs` | Encoded in per-task log body via `quiet ${hours}h` and `lastActivitySource=...`. | Per-task `logEntry` emitted by `surfaceInReviewStalled`. | Per-task log-history scan suppresses repeat emission within the `inReviewStalledThresholdMs` window for the same code; re-emits when prior entries age out or code changes. |

### Per-task token budget

`taskTokenBudget` can be configured in both global and project settings. Resolution precedence at runtime is:

1. Task override (`task.tokenBudgetOverride`)
2. Project per-size (`project.taskTokenBudget.perSize[task.size]`)
3. Project base (`project.taskTokenBudget.soft/hard`)
4. Global per-size (`global.taskTokenBudget.perSize[task.size]`)
5. Global base (`global.taskTokenBudget.soft/hard`)

Example:

```json
{
  "taskTokenBudget": {
    "soft": 8000000,
    "hard": 12000000,
    "perSize": {
      "S": { "soft": 2000000, "hard": 4000000 },
      "M": { "soft": 6000000, "hard": 9000000 },
      "L": { "soft": 12000000, "hard": 18000000 }
    }
  }
}
```

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

### OAuth credential refresh

Fusion automatically refreshes OAuth credentials before reporting auth status when the stored credential includes a refresh token and the access token is expired or within the refresh buffer. For Anthropic, this status path is the `anthropic-subscription` surface (including legacy `anthropic` OAuth rows), not Claude CLI state. A successful refresh updates auth storage and prevents `oauth-token-expired` notifications or startup warnings for that provider, so users usually do not need manual re-login after the initial OAuth login.

<!-- FNXC:ClaudeOAuth 2026-07-05-00:00: FN-7574 — the proactive-refresh buffer was widened from 60s to 5 minutes (`OAUTH_REFRESH_BUFFER_MS` in packages/engine/src/auth-storage.ts) so a credential nearing expiry is treated as due-for-refresh earlier, without needlessly refreshing well-valid tokens. An engine-side background `OAuthRefreshScheduler` also polls every 5 minutes and reuses this same refresh-if-due logic against every known OAuth provider (plus the anthropic-subscription alias), so healthy subscriptions renew ahead of expiry even if nothing else happens to request a runtime API key in that window. In-flight refresh dedupe and the 30s post-failure cooldown (`OAUTH_REFRESH_FAILURE_COOLDOWN_MS`) still apply. -->

Manual re-login is still required when no refresh token is stored or the refresh request fails/leaves the credential expired. In those cases the credential remains expired, `oauth-token-expired` notifications/startup warnings may fire subject to their 12-hour provider throttle, and users should re-authenticate from **Settings → Authentication** or Model Onboarding. The top-level dashboard re-login banner suppresses only the urgent **Anthropic Subscription** entry when **Anthropic API Key** or **Anthropic — via Claude CLI** is already authenticated, so the banner does not imply all Anthropic agent execution is blocked; Settings still shows the subscription OAuth state as expired/not connected until it is refreshed or re-logged-in.

<!-- FNXC:ProviderAuth 2026-07-05-00:00: FN-7574 — `/api/auth/status` and the engine's OAuthExpiryMonitor previously diverged on what counted as "expired": an oauth-typed credential with a past or missing/non-numeric `expires` could still read authenticated:true from the status route, even after the monitor's oauth-token-expired notification fired. The status route now fails safe: any OAuth credential lacking a usable numeric `expires`, or whose numeric `expires` is in the past and cannot be refreshed, reports expired:true/authenticated:false for both the legacy anthropic-row and separated anthropic-subscription-row storage permutations. FNXC:ProviderAuth 2026-07-11-18:00: FN-7821 — OAuthExpiryMonitor also refreshes-then-rechecks before dispatching oauth-token-expired, so a silently refreshed provider such as github-copilot does not produce a push without a matching in-app re-login banner. -->

### Anthropic API-key authentication

Anthropic has three independent authentication/routing paths:

- **Anthropic Subscription** (`anthropic-subscription`) is Claude subscription OAuth. It powers login/logout, `/api/auth/status`, usage/subscription checks through `https://api.anthropic.com/api/oauth/usage`, and the OAuth re-login banner when no authenticated Anthropic API-key/CLI fallback is present. Legacy `anthropic` OAuth rows are treated as this subscription surface. It is **also an execution surface**: subscription OAuth resolves for the direct `anthropic` provider at runtime, so `anthropic/*` selections run on `https://api.anthropic.com/v1` with Claude Code identity headers (Bearer OAuth, no API key required), and `anthropic/*` rows appear in the model picker when subscription OAuth is connected.
- **Claude CLI** (`pi-claude-cli`) is the CLI-backed execution provider. Use it when you want sessions to run through the local `claude` CLI; CLI availability does not prove the subscription OAuth status is valid. It is a separate, explicit choice — subscription OAuth does not require or reroute to it. When Claude CLI is enabled, model selectors show the registered `pi-claude-cli/*` rows (for example `pi-claude-cli/claude-sonnet-5`) in addition to the direct `anthropic/*` rows.
- **Anthropic API Key** (`anthropic` direct `/v1`) is raw API-key auth. It accepts `ANTHROPIC_API_KEY`, a `models.json` `apiKey`, or an `api_key` auth credential, uses `x-api-key`, and takes precedence over subscription OAuth when both are configured for the direct `https://api.anthropic.com/v1` provider.

Anthropic can be connected with a raw API key from both Model Onboarding and **Settings → Authentication**. Anthropic API-key auth appears as a separate **Anthropic API Key** card, while Claude subscription OAuth appears as **Anthropic Subscription** with Login/Logout controls. On Fusion desktop, Anthropic Subscription OAuth login URLs are delegated to the operating system browser instead of an Electron child window so the existing polling/callback flow can complete. `/api/auth/status` returns only masked key hints for the API-key card.

### Authentication troubleshooting (mobile OAuth fallback)

#### `/api/auth/login` response shape for device-code providers

`POST /api/auth/login` returns:

- `url: string`
- `instructions?: string`
- `manualCode?: { prompt: string; placeholder?: string; helpText?: string }`
- `deviceCode?: { userCode: string; verificationUri: string }`

For `github-copilot`, Fusion auto-resolves the upstream enterprise-domain prompt to blank (`github.com` default), then returns `deviceCode` so Settings/Onboarding can render a dedicated “Enter this code on GitHub” panel. The dashboard now shows this panel (and auto-copies the code once) before opening GitHub; users explicitly click **Open GitHub** when ready.

Request body remains `{ provider: string, origin?: string }`. `enterpriseDomain` is reserved for future UX expansion and is not required for this flow.

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
- `fn settings set owningNodeHandoffPolicy <block|reassign-to-local|reassign-any-healthy>`

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
The Settings → Remote Access section is always visible; starting a tunnel still requires `remoteAccess.enabled`, a selected provider, and provider-specific prerequisites.
The canonical persisted shape is a nested `remoteAccess` object.

Use **[Remote Access runbook](./remote-access.md)** for setup prerequisites (Tailscale/Cloudflare), tokenized login-link security caveats, and operational troubleshooting. Keep this section as a schema reference.

When `remoteAccess.activeProvider` is `cloudflare`, the Settings UI fetches `/api/remote/status` and surfaces `cloudflaredAvailable` to show installed/missing state plus a one-click `POST /api/remote/install-cloudflared` action. That endpoint preserves package-manager installs (`brew`, `winget`) and gates direct binary download behind a pinned manifest: default `upstream-pending-verification` mode fails closed until maintainers populate verified tagged-release URLs and sha256 sidecars.

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

Fusion resolves task models through workflow-backed lane values first, then global lane defaults, then the project/global default model fallback. The common workflow lanes are stored as setting values on the project's default workflow and can be edited with dropdown controls from Settings -> Project Models -> Default workflow model lanes (persisted by the Settings modal's primary Save) or from workflow editor -> Settings -> Values for declared workflow lanes and fallbacks. General-scope fallback selection remains the global Fallback Model picker in Settings -> General Models.

Settings model lanes can also carry optional thinking/reasoning effort overrides in the same model dropdown. Primary workflow lanes declare `executionThinkingLevel`, `planningThinkingLevel`, or `validatorThinkingLevel` per `(workflow, project)`; planning/reviewer fallback lanes declare `planningFallbackThinkingLevel` and `validatorFallbackThinkingLevel`; global fallback uses `fallbackThinkingLevel`; and project title summarization fallback uses `titleSummarizerFallbackThinkingLevel`. Empty thinking values inherit through the lane/global/default chain and explicit values are cleared by the lane reset action. Runtime thinking precedence for task/workflow execution is node/step `config.thinkingLevel` > task `thinkingLevel` > workflow lane thinking override > global lane thinking override > project default thinking override > global `defaultThinkingLevel`. Model-mode Chat sessions use the same executor-lane resolver with session `thinkingLevel` in the task slot, so an empty chat-session value inherits project/global defaults while a concrete New Chat selection wins for that session. The resolved value still flows through pi.ts' existing thinking/reasoning-conflict fallback (Fusion retries without the explicit level when a provider rejects conflicting thinking parameters).

When the planning lane has neither `planningFallback*` nor a global `fallback*` pair configured, triage now derives an **implicit fallback** from the resolved project/global default (execution) model (FN-7719). This lets a retryable primary planner-model failure (e.g. a provider 404/429) recover via one distinct swap instead of permanently failing triage with "no fallback configured" — the operator's chosen primary planner lane is unchanged, and the implicit fallback is skipped when it would equal the primary model or when test mode is active.

Z.ai's built-in provider uses the existing `zai` auth entry / `ZAI_API_KEY` environment variable and includes `zai/glm-5.2` as a selectable model in the same dropdowns and workflow lane controls as the other built-in GLM models. If a pi extension also registers the `zai` provider, Fusion preserves the extension's models and re-adds any missing built-in Z.ai models so built-in GLM choices remain available.

Grok (`grok-cli`) is likewise seeded as a built-in provider — xAI's OpenAI-compatible endpoint (`https://api.x.ai/v1`, api type `openai-completions`), API key `GROK_API_KEY` — into every model registry Fusion seeds (task execution, dashboard `/api/models`, and CLI `serve`/`daemon`/`dashboard`), mirroring the Z.ai pattern above. This makes `grok-cli/<model>` selections (e.g. `grok-cli/grok-4.5`) resolvable for execution even before the `grok` CLI binary is discovered or the picker surfaces additional Grok models (see the CLI-discovery paragraph below). If `GROK_API_KEY` is not set in the environment, provider registration falls back to `~/.grok/user-settings.json`'s `apiKey` field (the same file the `grok` CLI itself writes on login) and hydrates `process.env.GROK_API_KEY` from it, so an operator who authenticated via the `grok` CLI but never exported the env var still resolves a key; an already-set env var always wins, and a missing/malformed/empty settings file is fail-soft (no error, no env mutation). When no Fusion-visible key resolves and the Grok Runtime plugin has registered runtime id `grok`, `createResolvedAgentSession()` derives that runtime automatically for `grok-cli` execution and passes the selected model to the CLI via `--model <id>`; explicit runtime hints and key-visible direct-endpoint routing take precedence.

When the Hermes Runtime plugin (`fusion-plugin-hermes-runtime`) is installed and the local `hermes` CLI has configured profiles (`hermes profile list`), those profiles are surfaced additively in `/api/models` under the `hermes` provider — one row per profile, id/name derived from the profile name and its configured model. This surfacing is read-only (Fusion does not create or edit Hermes profiles) and is fetched through a short-TTL, single-flight cache so the model picker never spawns the `hermes` CLI on every request; a missing/failed `hermes` binary simply yields zero Hermes rows without affecting other providers.

When the Cursor Runtime plugin (`fusion-plugin-cursor-runtime`) is installed and the `useCursorCli` toggle is enabled (Settings → Authentication), Cursor CLI-discovered models (`cursor-agent models --json`, with text/`model list` fallbacks) are surfaced additively in `/api/models` under the `cursor-cli` provider — id/name derived from the discovered model id/label. This surfacing is fetched through a short-TTL, single-flight cache so the model picker never spawns `cursor-agent` on every request; a missing/failed/unavailable Cursor CLI binary simply yields zero `cursor-cli` rows without affecting other providers. Disabling `useCursorCli` hides all `cursor-cli` rows.

<!-- FNXC:UsageProviders 2026-07-11-00:00: FN-7817 — Cursor usage in the dashboard Usage dropdown is intentionally separate from Cursor CLI OAuth/session auth. Metered spend requires a Cursor Admin API key exported to the dashboard process as Fusion's documented `CURSOR_API_KEY` env var; session-only `cursor-agent` login can identify the user/plan but cannot call the Admin API spend endpoint. -->

The Usage dropdown can show a Cursor card when the dashboard process has a Cursor Admin API key in `CURSOR_API_KEY`. Fusion calls Cursor Admin API `POST https://api.cursor.com/teams/spend` with Basic auth (`API_KEY:`) and maps documented team spend fields into the generic usage-window UI. Cursor documents API key creation at `cursor.com/dashboard` → **API Keys** with `admin:*` scope for Admin API access, but does not document a local Admin API key file or an env-var name; `CURSOR_API_KEY` is Fusion's operator-facing convention. If only the `cursor-agent` session/OAuth login is present, Fusion omits the Cursor usage card because Cursor has not documented a personal/session usage endpoint; expired Admin API keys remain visible as an error card so operators can rotate the environment secret.

When the Grok Runtime plugin (`fusion-plugin-grok-runtime`) is installed and the `useGrokCli` toggle is enabled (Settings → Authentication), Grok CLI-discovered models (`grok models`) are surfaced additively in `/api/models` under the `grok-cli` provider — id/name derived from the discovered model id/label. This surfacing is fetched through a short-TTL, single-flight cache so the model picker never spawns `grok` on every request; a missing/failed/unavailable Grok CLI binary simply yields zero `grok-cli` rows without affecting other providers. Disabling `useGrokCli` hides all `grok-cli` rows. Grok direct-endpoint auth is API-key based (`GROK_API_KEY` or the Grok CLI settings-file fallback), while Cursor has two distinct paths: `cursor-cli` model execution uses OAuth/session auth and Cursor usage metering uses Fusion's `CURSOR_API_KEY` Admin API key env var. CLI-routed Grok execution lets the `grok` binary use any auth source it supports; the Settings card still surfaces Fusion-visible key detection only as an informational hint.

The three GPT-5.6 codenamed OpenAI Codex variants (`gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) are additively surfaced under the `openai-codex` provider (FN-7745/FN-7754/FN-7759, mirroring the Anthropic/Z.ai supplemental-merge pattern above) so they appear both in dashboard `/api/models` and the engine/pi `createFnAgent` registry-seeding surface whenever `openai-codex` is configured — deduped against any pinned pi-ai catalog row that already carries one of the ids. FN-7759 specifically keeps the supplemental registration compatible with the real pi-coding-agent `ModelRegistry` by preserving the OpenAI Codex OAuth provider during dynamic full-provider replacement, so legacy catalogs without native 5.6 rows still survive `getAvailable()` auth filtering and remain executable.

### Planning model

1. Per-task `planningModelProvider` + `planningModelId`
2. Default workflow lane value `planningProvider` + `planningModelId`
3. Global `planningGlobalProvider` + `planningGlobalModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Automatic provider/model resolution

### Executor model

1. Per-task `modelProvider` + `modelId`
2. Default workflow lane value `executionProvider` + `executionModelId`
3. Global `executionGlobalProvider` + `executionGlobalModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Assigned durable agent runtime model (`runtimeConfig.model` or `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) when both provider and model ID are set and no task/lane/default pair is configured
7. Automatic provider/model resolution

Workflow prompt steps and scheduled/manual AI-prompt automation steps use the same executor lane before falling back to project/global defaults; explicit step-level `modelProvider` + `modelId` values still take precedence for that individual step. If a non-mock, non-test-mode session still reaches runtime creation without a complete provider/model pair, Fusion logs a warning and records `noModelResolved` plus `runtimeBuiltInFallbackModel` on `session:runtime-resolved` so the runtime's built-in fallback model is observable.

### Heartbeat model (durable agents)

Heartbeat sessions for durable agents use this order:

1. Default workflow lane value `executionProvider` + `executionModelId`
2. Global `executionGlobalProvider` + `executionGlobalModelId`
3. Project `defaultProviderOverride` + `defaultModelIdOverride`
4. Global `defaultProvider` + `defaultModelId`
5. Assigned durable agent runtime model (`runtimeConfig.model` or `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) when both provider and model ID are set and no execution/default pair is configured
6. Automatic provider/model resolution

On timer-triggered runs, unrecoverable missing-provider credential/registry failures complete as `heartbeat_model_unavailable` instead of permanently setting the durable agent to `state=error`.

### Reviewer model

1. Per-task `validatorModelProvider` + `validatorModelId`
2. Default workflow lane value `validatorProvider` + `validatorModelId`
3. Global `validatorGlobalProvider` + `validatorGlobalModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Automatic provider/model resolution

Mission validation sessions use this same validator lane; assigned durable agent runtime models are only used as a fallback when no complete validator/default pair is configured.

### Merger model

1. Project `defaultProviderOverride` + `defaultModelIdOverride`
2. Global `defaultProvider` + `defaultModelId`
3. Assigned durable agent runtime model (`runtimeConfig.model` or `runtimeConfig.modelProvider` + `runtimeConfig.modelId`) when both provider and model ID are set and no default pair is configured
4. Automatic provider/model resolution

For post-merge prompt workflow steps, explicit step-level `modelProvider` + `modelId` overrides take precedence over the merger lane above.

### Title summarization model

Project-scoped model lane used for task title auto-summarization, GitHub tracking issue title summarization when tasks are untitled, PR title/body generation, and (when enabled) AI merge commit summaries.

1. Project `titleSummarizerProvider` + `titleSummarizerModelId`
2. Global `titleSummarizerGlobalProvider` + `titleSummarizerGlobalModelId`
3. Project `planningProvider` + `planningModelId`
4. Project `defaultProviderOverride` + `defaultModelIdOverride`
5. Global `defaultProvider` + `defaultModelId`
6. Automatic provider/model resolution

If the configured title summarizer provider/model is stale and no longer exists in the pi model registry, title generation logs a warning with the stale id and retries once with automatic provider/model resolution. Other AI failures (auth, empty output, unavailable engine) still fail normally.

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

For more details, see the [Paperclip Runtime Plugin documentation](../plugins/fusion-plugin-paperclip-runtime/README.md), [Hermes Runtime Plugin documentation](../plugins/fusion-plugin-hermes-runtime/README.md), [OpenClaw Runtime Plugin documentation](../plugins/fusion-plugin-openclaw-runtime/README.md), [Grok Runtime Plugin documentation](../plugins/fusion-plugin-grok-runtime/README.md), and [Droid Runtime Plugin documentation](../plugins/fusion-plugin-droid-runtime/README.md).

### CLI Runtime Cold-Start Timeout Configuration

Grok and Droid have first-output cold-start guards for subprocesses that never emit initial stdout. These guards are configured by environment variable only and resolve as: environment variable → built-in default. Blank, non-numeric, zero, or negative values are ignored and the default remains active.

| Runtime | Environment Variable | Default if Unset | Description |
|---|---|---|---|
| Grok | `GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS` | `120000` | Fusion-side cold-start / first-stdout-byte kill ceiling for `grok` headless prompts. |
| Droid | `PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS` | `120000` | Fusion-side cold-start / first-stdout-line kill ceiling for `droid` CLI streams. |

These cold-start guards are distinct from OpenClaw/Hermes `cliTimeoutMs` settings (full-turn subprocess hard kills, default `300000`) and from Grok/Droid's separate 30-minute inactivity safety nets after output has begun.

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

<!--
FNXC:Settings 2026-06-26-23:44:
Settings → Prompts and the Workflow Editor are separate prompt-editing surfaces. Settings owns role templates plus global PromptKey segment overrides; workflow prompt/gate node text is edited per workflow and per node in the Workflow Editor, and the settings UI links there to avoid ownership ambiguity.
-->

Fusion supports fine-grained customization of AI agent prompts through the `promptOverrides` setting. This enables surgical customization of specific prompt segments without replacing entire role prompts (which `agentPrompts` does).

Settings → Prompts owns `agentPrompts` role system prompt templates, role assignments, and global PromptKey segment overrides. Per-workflow step prompts for workflow `prompt` and `gate` nodes are edited in the Workflow Editor; the Prompts settings section includes an **Open workflow settings** link to jump to that surface.

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
    "inReviewStallDeadlockThreshold": 3,
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
| `heartbeatScopeDiscipline` | `"strict" \| "lite" \| "off"` | Per-agent override for heartbeat prompt scope-discipline mode; unset inherits project `heartbeatScopeDiscipline` (`strict` default). |
| `heartbeatPromptTemplate` | `"default" \| "compact"` | Per-agent override for heartbeat execution-prompt trim template; unset inherits project `heartbeatPromptTemplate` (`default`). |
| `runMissedHeartbeatOnStartup` | `boolean` | Default `false`. When enabled, startup triggers one catch-up heartbeat if the agent's `lastHeartbeatAt` is older than its resolved heartbeat interval (server was down across a scheduled tick). |
| `allowParallelExecution` | `boolean` | Permanent agents only. Default `true` when unset. Set `false` to serialize heartbeat and executor sessions symmetrically (heartbeat won't start while executor is active, and executor won't start while heartbeat is active); `false` is explicitly persisted while unset/`true` keeps parallel behavior. |
| `selfImproveEnabled` | `boolean` | Enables periodic self-improvement prompts |
| `selfImproveIntervalMs` | `number` | Delay between self-improvement cycles (default 4h, minimum 1h) |
| `lastSelfImproveAt` | `string` | Last self-improvement checkpoint timestamp (managed by heartbeat monitor) |

Configure these per agent in **Agents → Agent Detail → Settings → Heartbeat Settings** (dashboard), or by updating agent `runtimeConfig` via the Agents API/CLI config flows. The **Engineer Backlog Auto-Claim** checkbox in this card controls `runtimeConfig.engineerBacklogAutoClaim` for that agent and only affects no-task backlog pickup; explicit assignment and delegation behavior are unchanged.

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

Common built-in dashboard/runtime flags include:
- `insights`
- `roadmap`
- `memoryView`
- `skillsView`
- `nodesView`
- `devServerView`
- `todoView` (enables dashboard Todo View; see [Todo View](./todo-view.md))
- `researchView`
- `evalsView` (gates Evals dashboard view, Settings → Scheduled Evals section, and scheduled-eval cron execution)
- `workflowGraphExecutor` (enables the workflow-IR interpreter path)
- `graphNativePostMerge` (**default-ON**; the graph is the sole owner of post-merge `optional-group` steps after a successful merge — the legacy merger-owned post-merge path was deleted. Post-merge failures are non-blocking. See [Workflow Steps → Execution Phases](./workflow-steps.md#execution-phases))
- `workflowInterpreterDualObserve` (retired/inert; stale persisted `true` values are forced OFF and must not reactivate hidden shadow observation)
- `workflowInterpreterAuthoritative` (readiness-gated authoritative interpreter lifecycle cutover; requires clean populated parity summary evidence and legacy remains default/fallback when OFF)
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

### `defaultAgentPermissionPolicy`

Project-scoped default permission policy for agent runtime action gates. It applies to permanent agents, stored ephemeral/task-worker agents that do not have an explicit per-agent policy, and fallback `executor-FN-*` task workers that have no stored agent row.

```json
{
  "defaultAgentPermissionPolicy": {
    "rules": {
      "git_write": "require-approval",
      "command_execution": "require-approval",
      "network_api": "block",
      "task_agent_mutation": "allow",
      "review_gate_bypass": "block",
      "file_scope": "allow"
    },
    "toolRules": {
      "fn_task_create": "block"
    }
  }
}
```

- `rules` is a partial map of category → disposition.
- `toolRules` is an optional exact tool-name map (`fn_task_create`, `fn_web_fetch`, `bash`, etc.) → disposition. Exact tool rules apply before category rules, so the example blocks task creation while leaving other `task_agent_mutation` tools allowed.
- Categories: `git_write`, `file_write_delete`, `command_execution`, `network_api`, `task_agent_mutation`, `review_gate_bypass`, `file_scope`.
- `review_gate_bypass` (FN-7728) governs `fn_task_bypass_review` — the operator-only merge-gate override that force-advances a card past a failed pre-merge review step (FN-7720). It is a dedicated, more-restricted category distinct from `task_agent_mutation`: even the `unrestricted` preset defaults it to `require-approval` instead of `allow`, so a review-gate bypass is never silently allowed by default. `approval-required` (`require-approval`) and `locked-down` (`block`) already cover it uniformly. `toolRules.fn_task_bypass_review` still layers an exact override on top of the category rule, same as any other tool. The tool remains registered CLI/pi-extension-only — it is never exposed to executor/reviewer/triage agent tool lists.
- `file_scope` (FN-7737) governs `fn_task_file_scope_add` — the tool an executing agent uses to extend its task's declared `## File Scope` beyond the initial spec at runtime. Unlike `review_gate_bypass`, `file_scope` intentionally keeps the UNIFORM per-preset disposition: the `unrestricted` preset resolves it to `allow` like every other plain category (no override patch), `approval-required` resolves it to `require-approval`, and `locked-down` resolves it to `block`.
- Dispositions: `allow`, `require-approval`, `block`.
- Missing categories default to `allow` via the built-in `unrestricted` seed, EXCEPT `review_gate_bypass` which seeds to `require-approval` even under `unrestricted`/`custom`; missing or empty `toolRules` preserve legacy category-only behavior. A stored policy that predates the `review_gate_bypass` or `file_scope` category (missing the key) resolves to the preset default — no migration is required.
- Runtime precedence is per-agent exact tool rule → per-agent category rule → project default exact tool rule → project default category rule → unrestricted fallback.
- Heartbeat-critical coordination/exempt tools remain non-configurable and allowed to prevent deadlocks.
- Legacy ephemeral agents without `permissionPolicy` are not rewritten on disk; they inherit this setting when a runtime session is built.

### `ephemeralAgentsCanCreateTasks`

Project-scoped backward-compatibility guard for ephemeral/runtime-managed task workers calling `fn_task_create`.

- Default: `true`, preserving the historical behavior that task workers can create follow-up tasks.
- When `false`, ephemeral callers are rejected before task creation even if their unified `permissionPolicy` would otherwise allow `fn_task_create`.
- When `true`, the unified runtime policy still applies: `defaultAgentPermissionPolicy.toolRules.fn_task_create = "block"` blocks ephemeral and permanent agents, and `"require-approval"` creates an approval request before the tool can run.

## Model selection hierarchy

All three lanes (planning / executor / reviewer) follow the same 5-tier precedence:

1. Per-task override (`planningModelProvider`/`Id`, `modelProvider`/`Id`, `validatorModelProvider`/`Id`)
2. Default workflow lane value (`planningProvider`/`Id`, `executionProvider`/`Id`, `validatorProvider`/`Id`)
3. Global lane (`planningGlobalProvider`/`Id`, `executionGlobalProvider`/`Id`, `validatorGlobalProvider`/`Id`)
4. Project `defaultProviderOverride` / `defaultModelIdOverride`
5. Global `defaultProvider` / `defaultModelId` → automatic resolution

## Mock provider (test mode)

Set `defaultProvider: "mock"` at any tier in that hierarchy (or the per-task lane override) to force planning, executor, reviewer/validator, mission validation, merger, and heartbeat sessions onto the deterministic zero-network mock runtime.
Default scripts are scripted by session purpose: executor marks unfinished steps done, triage writes a minimal PROMPT.md and leaves optional plan approval to workflow Plan Review, reviewer/validation emit `Verdict: APPROVE`, and merger/heartbeat no-op safely.
Per-task and global script overrides live in `mockScriptRegistry` (`setMockScript`, `clearMockScript`, `resetMockScripts`) exported from `@fusion/engine`.
The mock runtime never registers with pi's `ModelRegistry` and is guarded by tests that fail on any `fetch`, `http.request`, or `https.request` usage.
Activation UX/settings affordances are handled separately in FN-5204.

`testMode?: boolean` exists at both global and project scopes. Project `testMode: true` takes precedence and forces planning, executor, reviewer/validator, mission validation, merger, and heartbeat to `mock/scripted` regardless of per-task or per-lane overrides. The dashboard surfaces this with the Settings Modal "Enable test mode" toggle and the shell banner: "Test mode — no real AI calls".

## Per-task token budget precedence

1. `task.tokenBudgetOverride`
2. Project `taskTokenBudget.perSize[task.size]`
3. Project `taskTokenBudget.soft/hard`
4. Global `taskTokenBudget.perSize[task.size]`
5. Global `taskTokenBudget.soft/hard`

Hard cap → pause with `pausedReason: "token_budget_exceeded"`. Soft cap → one-shot alert per task.

## Model presets

Standardize executor/validator pairs; auto-selectable by task size (Small → Budget, Medium → Normal, Large → Complex).
