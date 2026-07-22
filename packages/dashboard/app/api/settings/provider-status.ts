/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Auth/CLI and runtime provider status client API peeled from legacy.ts.
 */

import { api } from "../client/client.js";
import type { FetchOptions } from "../client/client.js";
import { dedupe } from "../client/dedupe.js";

// --- Auth API ---

/** OAuth provider with current authentication status */
export interface AuthProvider {
  id: string;
  name: string;
  authenticated: boolean;
  /** True when the server currently has an active OAuth login flow for this provider. */
  loginInProgress?: boolean;
  /** True when an OAuth credential is stored locally but its expires timestamp is in the past — prompt the user to re-login. */
  expired?: boolean;
  /** True when the redirect cannot reach this dashboard host and the user must paste the URL/code back manually. */
  requiresManualCode?: boolean;
  /**
   * Reason the most recent background OAuth login attempt failed, if any.
   * Interactive logins resolve the auth URL immediately and finish in the
   * background; when that background flow rejects (bad/expired code, token
   * exchange rejection, redirect_uri mismatch) this carries the cause so the
   * UI can show why login failed instead of a generic error. Cleared when a
   * fresh login for the provider starts.
   */
  loginError?: string;
  /**
   * How this provider authenticates / is activated.
   * - "oauth": OAuth flow (user clicks Login → redirect)
   * - "api_key": API key stored locally
   * - "cli": a locally-installed CLI binary is the backing transport
   *   (e.g. the synthetic `claude-cli` provider). Cards should render a
   *   one-click Enable/Disable + Test button rather than login/key inputs.
   */
  type?: "oauth" | "api_key" | "cli";
  /** Masked hint of the stored API key (first 3 + bullets + last 4 chars) */
  keyHint?: string;
}

export interface ManualOAuthCodeInfo {
  prompt: string;
  placeholder?: string;
  helpText?: string;
}

export interface OAuthDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
}

/**
 * Snapshot of the Claude-CLI-via-pi health state. Powers the
 * "Anthropic — via Claude CLI" provider card.
 */
export interface ClaudeCliStatus {
  binary: {
    available: boolean;
    version?: string;
    binaryPath?: string;
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  extension: {
    status: "ok" | "not-installed" | "missing-entry" | "error";
    path?: string;
    packageVersion?: string;
    reason?: string;
  } | null;
  ready: boolean;
  /** Route A ACP transport state (Claude CLI via the claude-code-cli-acp bridge). */
  acp?: {
    /** experimentalFeatures.claudeCliAcp (default ON). */
    enabled: boolean;
    /** The acp-runtime plugin published a bundled bridge path. */
    bridgeAvailable: boolean;
    /** Claude CLI is actually routing through the bridge (enabled + flag + bridge). */
    active: boolean;
    /** The bridged `claude` returned "Not logged in" — needs fallback or re-auth (R17). */
    authFailed: boolean;
    authReason?: string;
  };
}

export interface DroidCliStatus {
  binary: {
    available: boolean;
    version?: string;
    binaryPath?: string;
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  extension: {
    status: "ok" | "not-installed" | "missing-entry" | "error";
    path?: string;
    packageVersion?: string;
    reason?: string;
  } | null;
  ready: boolean;
}

export interface CursorCliStatus {
  binary: {
    available: boolean;
    version?: string;
    binaryPath?: string;
    configuredBinaryPath?: string;
    usingConfiguredBinaryPath?: boolean;
    diagnostics?: string[];
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  binaryPath?: string;
  extension: null;
  ready: boolean;
}

export interface GrokCliStatus {
  binary: {
    available: boolean;
    /** FNXC:GrokCli 2026-07-09-00:00: FN-7716 — "ready" (binary available), not "key present"; the grok CLI owns auth. */
    authenticated?: boolean;
    /** FNXC:GrokCli 2026-07-09-00:00: FN-7716 — non-blocking informational hint that Fusion detected a Grok API key. Never gates readiness. */
    apiKeyDetected?: boolean;
    version?: string;
    binaryPath?: string;
    configuredBinaryPath?: string;
    usingConfiguredBinaryPath?: boolean;
    diagnostics?: string[];
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  binaryPath?: string;
  extension: null;
  ready: boolean;
}

/*
FNXC:OmpAcp 2026-07-13-22:50:
Status shape for Settings → Oh My Pi (omp) ACP card. ready = enabled + binary available; auth under ~/.omp.
*/
export interface OmpCliStatus {
  binary: {
    available: boolean;
    authenticated?: boolean;
    version?: string;
    binaryPath?: string;
    configuredBinaryPath?: string;
    usingConfiguredBinaryPath?: boolean;
    diagnostics?: string[];
    reason?: string;
    probeDurationMs: number;
  };
  enabled: boolean;
  binaryPath?: string;
  extension: null;
  ready: boolean;
}

export interface LlamaCppStatus {
  enabled: boolean;
  extension: {
    status: "ok" | "not-installed" | "missing-entry" | "error";
    path?: string;
    packageVersion?: string;
    reason?: string;
  } | null;
  ready: boolean;
  server: {
    available: boolean;
    url: string;
    hasApiKey: boolean;
    reason?: string;
  };
}

/** Probe the local Claude CLI binary + setting + extension state. */
export function fetchClaudeCliStatus(): Promise<ClaudeCliStatus> {
  return api<ClaudeCliStatus>("/providers/claude-cli/status");
}

/**
 * Status snapshot for the Fusion CLI binary (`fn` / `fusion`). Used by
 * Settings → General → CLI Binary and the first-launch banner.
 */
export interface FnBinaryStatus {
  binary: {
    installed: boolean;
    binary?: "fn" | "fusion";
    path?: string;
    version?: string;
    invocation: string;
  };
  expectedVersion: string;
  state: "installed" | "missing" | "version-mismatch" | "skipped";
  install: { npm: string; curl: string; package: string };
}

export interface FnBinaryInstallResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
  permissionsHint?: string;
}

export interface FnBinaryInstallResponse extends FnBinaryStatus {
  installResult: FnBinaryInstallResult;
}

/** Read CLI binary install state. */
export function fetchFnBinaryStatus(): Promise<FnBinaryStatus> {
  return api<FnBinaryStatus>("/system/fn-binary/status");
}

/** Trigger `npm install -g runfusion.ai`. Returns install log + new status. */
export function installFnBinary(): Promise<FnBinaryInstallResponse> {
  return api<FnBinaryInstallResponse>("/system/fn-binary/install", { method: "POST" });
}

/** Probe the local Droid CLI binary + setting + extension state. */
export function fetchDroidCliStatus(): Promise<DroidCliStatus> {
  return api<DroidCliStatus>("/providers/droid-cli/status");
}

export function fetchCursorCliStatus(): Promise<CursorCliStatus> {
  return api<CursorCliStatus>("/providers/cursor-cli/status");
}

export function fetchGrokCliStatus(): Promise<GrokCliStatus> {
  return api<GrokCliStatus>("/providers/grok-cli/status");
}

export function fetchOmpCliStatus(): Promise<OmpCliStatus> {
  return api<OmpCliStatus>("/providers/omp-cli/status");
}

/** Probe llama.cpp server + setting + extension state. */
export function fetchLlamaCppStatus(): Promise<LlamaCppStatus> {
  return api<LlamaCppStatus>("/providers/llama-cpp/status");
}

// --- Runtime Provider Status Types ---

export interface RuntimeBinaryStatus {
  available: boolean;
  binaryPath?: string;
  version?: string;
  reason?: string;
  probeDurationMs: number;
}

export interface PaperclipConnectionStatus {
  available: boolean;
  apiUrl: string;
  identity?: {
    agentId: string;
    agentName: string;
    role?: string;
    companyId: string;
    companyName?: string;
  };
  reason?: string;
  probeDurationMs: number;
}

export interface HermesProviderStatus {
  binary: RuntimeBinaryStatus;
  ready: boolean;
}

export interface OpenClawProviderStatus {
  binary: RuntimeBinaryStatus;
  ready: boolean;
}

export interface PaperclipProviderStatus {
  connection: PaperclipConnectionStatus;
  ready: boolean;
}

/** Probe the local Hermes binary. */
export async function fetchHermesStatus(opts?: {
  binaryPath?: string;
}): Promise<HermesProviderStatus> {
  const qs = opts?.binaryPath
    ? `?binaryPath=${encodeURIComponent(opts.binaryPath)}`
    : "";
  return api<HermesProviderStatus>(`/providers/hermes/status${qs}`);
}

export interface HermesProfileSummary {
  name: string;
  model?: string;
  gateway?: string;
  alias?: string;
  isDefault: boolean;
}

/** List Hermes profiles from `hermes profile list`. Returns empty array on error. */
export async function fetchHermesProfiles(opts?: {
  binaryPath?: string;
}): Promise<HermesProfileSummary[]> {
  const qs = opts?.binaryPath ? `?binaryPath=${encodeURIComponent(opts.binaryPath)}` : "";
  const r = await api<{ profiles: HermesProfileSummary[]; error?: string }>(
    `/providers/hermes/profiles${qs}`,
  );
  return r.profiles ?? [];
}

/** Probe the local OpenClaw binary. */
export async function fetchOpenClawStatus(opts?: {
  binaryPath?: string;
}): Promise<OpenClawProviderStatus> {
  const qs = opts?.binaryPath
    ? `?binaryPath=${encodeURIComponent(opts.binaryPath)}`
    : "";
  return api<OpenClawProviderStatus>(`/providers/openclaw/status${qs}`);
}

/** Probe the Paperclip API connection. */
export async function fetchPaperclipStatus(opts: {
  apiUrl: string;
  apiKey?: string;
}): Promise<PaperclipProviderStatus> {
  const params = new URLSearchParams({ apiUrl: opts.apiUrl });
  if (opts.apiKey) params.set("apiKey", opts.apiKey);
  return api<PaperclipProviderStatus>(
    `/providers/paperclip/status?${params.toString()}`,
  );
}

export interface PaperclipCompanySummary {
  id: string;
  name: string;
  urlKey?: string;
}

export interface PaperclipAgentSummary {
  id: string;
  name: string;
  role?: string;
  companyId: string;
  status?: string;
  isCurrent?: boolean;
}

export interface PaperclipCliDiscoverySuccess {
  ok: true;
  apiUrl: string;
  apiKey?: string;
  configPath: string;
  deploymentMode?: string;
}

export interface PaperclipCliDiscoveryFailure {
  ok: false;
  reason: string;
  configPath?: string;
}

export type PaperclipCliDiscoveryResult =
  | PaperclipCliDiscoverySuccess
  | PaperclipCliDiscoveryFailure;

/** List Paperclip companies visible to the bearer. Empty array on failure. */
export async function fetchPaperclipCompanies(opts: {
  apiUrl: string;
  apiKey?: string;
}): Promise<PaperclipCompanySummary[]> {
  const params = new URLSearchParams({ apiUrl: opts.apiUrl });
  if (opts.apiKey) params.set("apiKey", opts.apiKey);
  const r = await api<{ companies: PaperclipCompanySummary[] }>(
    `/providers/paperclip/companies?${params.toString()}`,
  );
  return r.companies ?? [];
}

/** List agents in a Paperclip company. Empty array on failure. */
export async function fetchPaperclipAgents(opts: {
  apiUrl: string;
  apiKey?: string;
  companyId: string;
}): Promise<PaperclipAgentSummary[]> {
  const params = new URLSearchParams({
    apiUrl: opts.apiUrl,
    companyId: opts.companyId,
  });
  if (opts.apiKey) params.set("apiKey", opts.apiKey);
  const r = await api<{ agents: PaperclipAgentSummary[] }>(
    `/providers/paperclip/agents?${params.toString()}`,
  );
  return r.agents ?? [];
}

export interface PaperclipMintKeyRequest {
  cliBinaryPath?: string;
  agentRef: string;
  /** Required by paperclipai agent local-cli (`-C/--company-id`). */
  companyId: string;
  keyName?: string;
  configPath?: string;
  dataDir?: string;
}
export type PaperclipMintKeyResult =
  | { ok: true; key: { apiKey: string; apiBase?: string; agentId?: string; companyId?: string } }
  | { ok: false; reason: string };

/**
 * Mints a Paperclip agent API key via the local `paperclipai` CLI.
 * Always resolves (never rejects); on failure the result has `ok: false`.
 */
export async function mintPaperclipApiKey(
  body: PaperclipMintKeyRequest,
): Promise<PaperclipMintKeyResult> {
  return api<PaperclipMintKeyResult>(`/providers/paperclip/cli-mint-key`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Probe Paperclip via the local `paperclipai` CLI (Local CLI tab). Carries the
 * user's onboarded CLI context (profile / api-base / api-key) instead of having
 * the dashboard server make the HTTP call directly.
 */
export async function fetchPaperclipCliStatus(opts: {
  cliBinaryPath?: string;
  cliConfigPath?: string;
}): Promise<PaperclipProviderStatus> {
  const params = new URLSearchParams();
  if (opts.cliBinaryPath) params.set("cliBinaryPath", opts.cliBinaryPath);
  if (opts.cliConfigPath) params.set("cliConfigPath", opts.cliConfigPath);
  const qs = params.toString();
  return api<PaperclipProviderStatus>(
    `/providers/paperclip/cli-status${qs ? `?${qs}` : ""}`,
  );
}

/** List companies via `paperclipai company list --json`. Empty array on failure. */
export async function fetchPaperclipCliCompanies(opts: {
  cliBinaryPath?: string;
  cliConfigPath?: string;
}): Promise<PaperclipCompanySummary[]> {
  const params = new URLSearchParams();
  if (opts.cliBinaryPath) params.set("cliBinaryPath", opts.cliBinaryPath);
  if (opts.cliConfigPath) params.set("cliConfigPath", opts.cliConfigPath);
  const qs = params.toString();
  const r = await api<{ companies: PaperclipCompanySummary[] }>(
    `/providers/paperclip/cli-companies${qs ? `?${qs}` : ""}`,
  );
  return r.companies ?? [];
}

/** List agents in a company via `paperclipai agent list -C <id> --json`. */
export async function fetchPaperclipCliAgents(opts: {
  cliBinaryPath?: string;
  cliConfigPath?: string;
  companyId: string;
}): Promise<PaperclipAgentSummary[]> {
  const params = new URLSearchParams({ companyId: opts.companyId });
  if (opts.cliBinaryPath) params.set("cliBinaryPath", opts.cliBinaryPath);
  if (opts.cliConfigPath) params.set("cliConfigPath", opts.cliConfigPath);
  const r = await api<{ agents: PaperclipAgentSummary[] }>(
    `/providers/paperclip/cli-agents?${params.toString()}`,
  );
  return r.agents ?? [];
}

/** Read the local paperclipai config to discover apiUrl + deploymentMode. */
export async function fetchPaperclipCliDiscovery(opts: {
  cliConfigPath?: string;
} = {}): Promise<PaperclipCliDiscoveryResult> {
  const params = new URLSearchParams();
  if (opts.cliConfigPath) params.set("cliConfigPath", opts.cliConfigPath);
  const qs = params.toString();
  return api<PaperclipCliDiscoveryResult>(
    `/providers/paperclip/cli-discovery${qs ? `?${qs}` : ""}`,
  );
}

/** Enable or disable the Claude CLI provider. Refuses enable if binary is missing. */
export function setClaudeCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; restartRequired: boolean }> {
  return api<{ enabled: boolean; restartRequired: boolean }>("/auth/claude-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

/** Enable or disable the Droid CLI provider. Refuses enable if binary is missing. */
export function setDroidCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; restartRequired: boolean }> {
  return api<{ enabled: boolean; restartRequired: boolean }>("/auth/droid-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function setCursorCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/cursor-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function setCursorCliBinaryPath(
  binaryPath: string | null,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/cursor-cli", {
    method: "POST",
    body: JSON.stringify({ binaryPath }),
  });
}

export function setGrokCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/grok-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function setGrokCliBinaryPath(
  binaryPath: string | null,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/grok-cli", {
    method: "POST",
    body: JSON.stringify({ binaryPath }),
  });
}

/*
FNXC:OmpAcp 2026-07-13-22:50:
Client helpers for Oh My Pi ACP enable + binary path (mirror Grok/Cursor).
*/
export function setOmpCliEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/omp-cli", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function setOmpCliBinaryPath(
  binaryPath: string | null,
): Promise<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }> {
  return api<{ enabled: boolean; binaryPath?: string; restartRequired: boolean }>("/auth/omp-cli", {
    method: "POST",
    body: JSON.stringify({ binaryPath }),
  });
}

/** Enable or disable the llama.cpp provider. */
export function setLlamaCppEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; restartRequired: boolean }> {
  return api<{ enabled: boolean; restartRequired: boolean }>("/auth/llama-cpp", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export interface CustomProvider {
  id: string;
  name: string;
  apiType: "openai-compatible" | "anthropic-compatible" | "google-generative-ai" | "openai-responses";
  baseUrl: string;
  apiKey?: string;
  /**
   * FNXC:ProviderAuth 2026-07-08-00:00:
   * FN-7689: dashboard-local mirror of @fusion/core's CustomProvider.anthropicPromptCaching
   * opt-in. Keep in sync with packages/core/src/types.ts.
   */
  anthropicPromptCaching?: boolean;
  models?: { id: string; name: string }[];
}

export async function fetchCustomProviders(): Promise<CustomProviderConfig[] & { providers: CustomProviderConfig[] }> {
  const providers = await api<CustomProvider[]>("/custom-providers");
  const legacyProviders = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.apiType === "anthropic-compatible" ? "anthropic-messages"
      : provider.apiType === "google-generative-ai" ? "google-generative-ai"
      : provider.apiType === "openai-responses" ? "openai-responses"
      : "openai-completions",
    apiKey: provider.apiKey,
    anthropicPromptCaching: provider.anthropicPromptCaching,
    models: (provider.models ?? []).map((model) => ({ id: model.id, name: model.name })),
  } satisfies CustomProviderConfig));
  return Object.assign(legacyProviders, { providers: legacyProviders });
}

export function addCustomProvider(provider: Omit<CustomProvider, "id">): Promise<CustomProvider> {
  return api<CustomProvider>("/custom-providers", {
    method: "POST",
    body: JSON.stringify(provider),
  });
}

export function updateCustomProvider(
  id: string,
  updates: Partial<Omit<CustomProvider, "id">> | CustomProviderConfig,
): Promise<CustomProvider> {
  const legacy = updates as Partial<CustomProviderConfig>;
  const normalized: Partial<Omit<CustomProvider, "id">> = {
    ...(typeof legacy.name === "string" ? { name: legacy.name } : {}),
    ...(typeof legacy.baseUrl === "string" ? { baseUrl: legacy.baseUrl } : {}),
    ...(typeof legacy.apiKey === "string" ? { apiKey: legacy.apiKey } : {}),
    ...("anthropicPromptCaching" in (updates as Record<string, unknown>)
      ? { anthropicPromptCaching: (updates as Partial<Omit<CustomProvider, "id">>).anthropicPromptCaching }
      : {}),
    ...(Array.isArray(legacy.models)
      ? {
          models: legacy.models.map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
          })),
        }
      : {}),
    ...(legacy.api
      ? {
          apiType: legacy.api === "anthropic-messages" ? "anthropic-compatible"
            : legacy.api === "google-generative-ai" ? "google-generative-ai"
            : legacy.api === "openai-responses" ? "openai-responses"
            : "openai-compatible",
        }
      : {}),
    ...("apiType" in (updates as Record<string, unknown>)
      ? { apiType: (updates as Partial<Omit<CustomProvider, "id">>).apiType }
      : {}),
  };

  return api<CustomProvider>(`/custom-providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(normalized),
  });
}

export function deleteCustomProvider(id: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(`/custom-providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export interface RefreshProviderModelsResponse {
  provider: CustomProvider;
  modelsRefreshed: number;
}

export function refreshProviderModels(id: string): Promise<RefreshProviderModelsResponse> {
  return api<RefreshProviderModelsResponse>(`/custom-providers/${encodeURIComponent(id)}/refresh-models`, {
    method: "POST",
  });
}

// Backward-compatibility exports for existing UI callers; will be removed when
// custom-provider UI migrates to the new core CustomProvider contract.
export interface CustomProviderModelInput {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  apiKey?: string;
  /** FNXC:ProviderAuth 2026-07-08-00:00: FN-7689 caching opt-in, carried through the legacy shape. */
  anthropicPromptCaching?: boolean;
  models: CustomProviderModelInput[];
}

export function createCustomProvider(config: CustomProviderConfig): Promise<CustomProvider> {
  const apiType = config.api === "anthropic-messages" ? "anthropic-compatible"
    : config.api === "google-generative-ai" ? "google-generative-ai"
    : config.api === "openai-responses" ? "openai-responses"
    : "openai-compatible";
  return addCustomProvider({
    name: config.name?.trim() || config.id,
    apiType,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: config.models?.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
    })),
  });
}

/**
 * Probe a custom provider's /models endpoint to discover available models.
 * Supports OpenAI-compatible, Anthropic-compatible, and Google Generative AI providers.
 */
export interface ProbeModelResult {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProbeModelsResponse {
  models: ProbeModelResult[];
  count: number;
}

export interface ProbeModelsParams {
  baseUrl: string;
  apiKey?: string;
  apiType: "openai-compatible" | "anthropic-compatible" | "google-generative-ai" | "openai-responses";
}

export async function probeProviderModels(params: ProbeModelsParams): Promise<ProbeModelsResponse> {
  return api<ProbeModelsResponse>("/custom-providers/probe-models", {
    method: "POST",
    body: JSON.stringify({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      apiType: params.apiType,
    }),
  });
}

export interface GitCliStatus {
  available: boolean;
  version?: string;
  installUrl?: string;
}

/** Fetch authentication status for all OAuth providers */
export function fetchAuthStatus(options?: FetchOptions): Promise<{
  providers: AuthProvider[];
  ghCli?: { available: boolean; authenticated: boolean };
  gitCli?: GitCliStatus;
}> {
  return dedupe("/auth/status", () => api<{
    providers: AuthProvider[];
    ghCli?: { available: boolean; authenticated: boolean };
    gitCli?: GitCliStatus;
  }>("/auth/status"), options);
}

/** Initiate OAuth login for a provider. Returns the auth URL to open in a new tab. */
export function loginProvider(provider: string): Promise<{
  url: string;
  instructions?: string;
  manualCode?: ManualOAuthCodeInfo;
  deviceCode?: OAuthDeviceCodeInfo;
}> {
  return api<{
    url: string;
    instructions?: string;
    manualCode?: ManualOAuthCodeInfo;
    deviceCode?: OAuthDeviceCodeInfo;
  }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ provider, origin: window.location.origin }),
  });
}

/** Submit a pasted OAuth callback URL or authorization code for an active login. */
export function submitProviderManualCode(provider: string, code: string): Promise<{ success: boolean; submitted: boolean }> {
  return api<{ success: boolean; submitted: boolean }>("/auth/manual-code", {
    method: "POST",
    body: JSON.stringify({ provider, code }),
  });
}

/** Logout from a provider, removing stored credentials. */
export function logoutProvider(provider: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/auth/logout", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

/** Cancel an in-progress OAuth login attempt for a provider. */
export function cancelProviderLogin(provider: string): Promise<{ success: boolean; cancelled: boolean }> {
  return api<{ success: boolean; cancelled: boolean }>("/auth/cancel", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

/** Save an API key for an API-key-backed provider. */
export function saveApiKey(provider: string, apiKey: string): Promise<{
  success: boolean;
  modelsRefreshed?: number;
  refreshReason?: string;
  refreshError?: string;
}> {
  return api<{
    success: boolean;
    modelsRefreshed?: number;
    refreshReason?: string;
    refreshError?: string;
  }>("/auth/api-key", {
    method: "POST",
    body: JSON.stringify({ provider, apiKey }),
  });
}

/** Remove an API key for an API-key-backed provider. */
export function clearApiKey(provider: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/auth/api-key", {
    method: "DELETE",
    body: JSON.stringify({ provider }),
  });
}

