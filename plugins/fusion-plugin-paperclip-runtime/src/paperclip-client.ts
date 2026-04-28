/**
 * Paperclip REST API client.
 *
 * Low-level HTTP helpers for the Paperclip control-plane API.
 * This module intentionally does not depend on @fusion/engine or any Fusion
 * internals — it is a pure HTTP client.
 */

// ---------------------------------------------------------------------------
// Public error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a Paperclip API call returns HTTP 409 Conflict.
 * Usually means another agent already owns the issue being checked out.
 */
export class ConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Thrown when a wakeup call is rejected with HTTP 202 + `status: "skipped"`.
 * This is a soft error — the agent is already running and the wakeup was
 * coalesced server-side. No polling should follow.
 */
export class WakeupSkippedError extends Error {
  constructor(public readonly runId?: string) {
    super("Paperclip wakeup was coalesced/skipped — agent already active");
    this.name = "WakeupSkippedError";
  }
}

// ---------------------------------------------------------------------------
// Shared data shapes
// ---------------------------------------------------------------------------

export interface AgentsMeResponse {
  agentId: string;
  agentName: string;
  role?: string;
  companyId: string;
  companyName?: string;
}

export interface CreateIssueBody {
  title: string;
  description: string;
  status: string;
  assigneeAgentId: string;
  parentId?: string;
  projectId?: string;
  goalId?: string;
}

export interface WakeAgentBody {
  source: "on_demand" | "timer" | "assignment" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
}

export interface WakeAgentResponse {
  id: string;
  status: string; // "queued" | "running" | "skipped" | ...
}

/**
 * A single event from GET /api/heartbeat-runs/{runId}/events.
 *
 * The exact payload shape is not fully documented; we treat it defensively.
 */
export interface RunEvent {
  id?: string | number;
  seq: number;
  type: string; // e.g. "heartbeat.run.log", "heartbeat.run.status", "adapter.invoke"
  payload?: {
    stream?: "stdout" | "stderr" | "system";
    chunk?: string;
    message?: string;
    status?: string;
    [key: string]: unknown;
  };
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildUrl(apiUrl: string, path: string, query?: URLSearchParams): string {
  const base = normalizeApiUrl(apiUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const qs = query && query.size > 0 ? `?${query.toString()}` : "";
  return `${base}/api${normalizedPath}${qs}`;
}

function buildHeaders(apiKey?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...extra,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function parseJsonBody(response: Response): Promise<{ value: unknown; raw: string }> {
  const raw = await response.text();
  if (raw.trim() === "") {
    return { value: undefined, raw };
  }
  try {
    return { value: JSON.parse(raw), raw };
  } catch {
    throw new Error(
      `Paperclip API ${response.status} ${response.statusText}: invalid JSON response body`,
    );
  }
}

function toErrorMessage(status: number, statusText: string, body: unknown, raw: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "string") return b.error;
    if (typeof b.message === "string") return b.message;
  }
  if (raw.trim() !== "") return raw.slice(0, 200).trim();
  return `${status} ${statusText}`.trim();
}

async function request<T>(
  apiUrl: string,
  path: string,
  options?: {
    method?: string;
    apiKey?: string;
    body?: unknown;
    query?: URLSearchParams;
  },
): Promise<T> {
  const method = options?.method ?? "GET";
  const url = buildUrl(apiUrl, path, options?.query);

  const headers = buildHeaders(options?.apiKey);
  let bodyStr: string | undefined;
  if (options && "body" in options && options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: bodyStr });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Paperclip API network error (${method} ${url}): ${reason}`);
  }

  const { value, raw } = await parseJsonBody(response);

  if (!response.ok) {
    const msg = toErrorMessage(response.status, response.statusText, value, raw);
    const full = `Paperclip API ${response.status} (${method} ${path}): ${msg}`;
    if (response.status === 409) throw new ConflictError(full);
    throw new Error(full);
  }

  return value as T;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function getSettingString(settings: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = settings?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export interface PaperclipClientConfig {
  apiUrl: string;
  apiKey?: string;
  agentId?: string;
  companyId?: string;
  mode?: string;
  transport?: "api" | "cli";
  cliBinaryPath?: string;
  cliConfigPath?: string;
  parentIssueId?: string;
  projectId?: string;
  goalId?: string;
  runTimeoutMs?: number;
  pollIntervalMs?: number;
  pollIntervalMaxMs?: number;
}

/**
 * Resolves the Paperclip client config from plugin settings and environment
 * variables, with the following precedence:
 *   plugin settings > environment variables > built-in defaults
 */
export function resolvePaperclipConfig(settings?: Record<string, unknown>): PaperclipClientConfig {
  const apiUrl = normalizeApiUrl(
    getSettingString(settings, "apiUrl") ??
      process.env.PAPERCLIP_API_URL?.trim() ??
      "http://localhost:3100",
  );

  const apiKey =
    getSettingString(settings, "apiKey") ??
    (process.env.PAPERCLIP_API_KEY?.trim() || undefined);

  const agentId =
    getSettingString(settings, "agentId") ??
    process.env.PAPERCLIP_AGENT_ID?.trim() ??
    undefined;

  const companyId =
    getSettingString(settings, "companyId") ??
    process.env.PAPERCLIP_COMPANY_ID?.trim() ??
    undefined;

  const mode =
    getSettingString(settings, "mode") ??
    process.env.PAPERCLIP_RUNTIME_MODE?.trim() ??
    "rolling-issue";

  const transportRaw =
    getSettingString(settings, "transport") ??
    process.env.PAPERCLIP_TRANSPORT?.trim() ??
    "api";
  const transport: "api" | "cli" = transportRaw === "cli" ? "cli" : "api";

  const cliBinaryPath =
    getSettingString(settings, "cliBinaryPath") ??
    process.env.PAPERCLIPAI_BIN?.trim() ??
    "paperclipai";

  const cliConfigPath =
    getSettingString(settings, "cliConfigPath") ??
    process.env.PAPERCLIP_CLI_CONFIG?.trim() ??
    undefined;

  const parentIssueId =
    getSettingString(settings, "parentIssueId") ??
    process.env.PAPERCLIP_PARENT_ISSUE_ID?.trim() ??
    undefined;

  const projectId =
    getSettingString(settings, "projectId") ??
    process.env.PAPERCLIP_PROJECT_ID?.trim() ??
    undefined;

  const goalId =
    getSettingString(settings, "goalId") ??
    process.env.PAPERCLIP_GOAL_ID?.trim() ??
    undefined;

  const runTimeoutMs = parseInt(
    getSettingString(settings, "runTimeoutMs") ??
      process.env.PAPERCLIP_RUN_TIMEOUT_MS ??
      "600000",
    10,
  );

  const pollIntervalMs = parseInt(
    getSettingString(settings, "pollIntervalMs") ??
      process.env.PAPERCLIP_POLL_INTERVAL_MS ??
      "500",
    10,
  );

  const pollIntervalMaxMs = parseInt(
    getSettingString(settings, "pollIntervalMaxMs") ??
      process.env.PAPERCLIP_POLL_INTERVAL_MAX_MS ??
      "2000",
    10,
  );

  return {
    apiUrl,
    apiKey,
    agentId,
    companyId,
    mode,
    transport,
    cliBinaryPath,
    cliConfigPath,
    parentIssueId,
    projectId,
    goalId,
    runTimeoutMs: isFinite(runTimeoutMs) ? runTimeoutMs : 600_000,
    pollIntervalMs: isFinite(pollIntervalMs) ? pollIntervalMs : 500,
    pollIntervalMaxMs: isFinite(pollIntervalMaxMs) ? pollIntervalMaxMs : 2_000,
  };
}

// ---------------------------------------------------------------------------
// CLI-mode auth discovery
// ---------------------------------------------------------------------------

/**
 * Result of discovering Paperclip auth from a local `paperclipai` install.
 */
export interface PaperclipCliDiscovery {
  /** Resolved API URL, e.g. "http://127.0.0.1:3100". */
  apiUrl: string;
  /** API key, or undefined for local-trusted deployments. */
  apiKey?: string;
  /** Path to the config file the discovery read from. */
  configPath: string;
  /** Deployment mode reported by the config (e.g. "local_trusted", "cloud"). */
  deploymentMode?: string;
}

export interface PaperclipCliDiscoveryError {
  ok: false;
  reason: string;
  /** The path we tried to read, if any. */
  configPath?: string;
}

export type PaperclipCliDiscoveryResult =
  | ({ ok: true } & PaperclipCliDiscovery)
  | PaperclipCliDiscoveryError;

/**
 * Attempt to discover paperclipai's apiUrl + apiKey from its local config file.
 *
 * Reads `~/.paperclip/instances/default/config.json` by default. When
 * `deploymentMode === "local_trusted"`, no apiKey is needed (trusted-localhost
 * mode skips auth). For other modes, an apiKey must still be configured by the
 * user; this function reports `ok: true` with the URL but `apiKey: undefined`,
 * leaving the caller to decide whether to fall back to API-mode auth.
 *
 * Why a separate function: keeps the discovery logic testable and lets callers
 * distinguish "no paperclipai install" from "install present but config absent".
 */
export async function discoverPaperclipCliConfig(
  opts: { configPath?: string } = {},
): Promise<PaperclipCliDiscoveryResult> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");

  const configPath =
    opts.configPath ??
    path.join(os.homedir(), ".paperclip", "instances", "default", "config.json");

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      configPath,
      reason:
        code === "ENOENT"
          ? `Paperclip CLI config not found at ${configPath}. Install paperclipai and run \`paperclipai onboard\`, or use API mode.`
          : `Could not read ${configPath}: ${(error as Error).message}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, configPath, reason: `Invalid JSON in ${configPath}` };
  }

  const server = (parsed.server ?? {}) as Record<string, unknown>;
  const host = typeof server.host === "string" ? server.host : "127.0.0.1";
  const port =
    typeof server.port === "number"
      ? server.port
      : Number(server.port ?? 3100) || 3100;
  const deploymentMode =
    typeof server.deploymentMode === "string" ? server.deploymentMode : undefined;

  return {
    ok: true,
    apiUrl: `http://${host}:${port}`,
    apiKey: undefined,
    configPath,
    deploymentMode,
  };
}

// ---------------------------------------------------------------------------
// Paperclip REST helpers
// ---------------------------------------------------------------------------

/**
 * Returns the identity of the API key owner.
 * Used to auto-derive agentId and companyId when they are not configured.
 *
 * @throws if the server returns an unexpected error (non-401/403/404/ECONNREFUSED).
 */
export async function agentsMe(
  apiUrl: string,
  apiKey?: string,
): Promise<AgentsMeResponse> {
  const raw = await request<Record<string, unknown>>(apiUrl, "/agents/me", { apiKey });
  const id = typeof raw.id === "string" ? raw.id : undefined;
  const name = typeof raw.name === "string" ? raw.name : undefined;
  const role = typeof raw.role === "string" ? raw.role : undefined;
  const cId = typeof raw.companyId === "string" ? raw.companyId : undefined;
  const cName = typeof raw.companyName === "string" ? raw.companyName : undefined;
  if (!id || !cId) {
    throw new Error("Paperclip /api/agents/me returned a response missing `id` or `companyId`");
  }
  return { agentId: id, agentName: name ?? id, role, companyId: cId, companyName: cName };
}

/**
 * Creates a new Paperclip issue and returns its `id`.
 */
export async function createIssue(
  apiUrl: string,
  apiKey: string | undefined,
  companyId: string,
  body: CreateIssueBody,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(apiUrl, `/companies/${companyId}/issues`, {
    method: "POST",
    apiKey,
    body,
  });
}

/**
 * Fetches a single issue by ID.
 */
export async function getIssue(
  apiUrl: string,
  apiKey: string | undefined,
  issueId: string,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(apiUrl, `/issues/${issueId}`, { apiKey });
}

/**
 * Fetches comments on an issue.
 */
export async function getIssueComments(
  apiUrl: string,
  apiKey: string | undefined,
  issueId: string,
): Promise<Array<Record<string, unknown>>> {
  return request<Array<Record<string, unknown>>>(apiUrl, `/issues/${issueId}/comments`, { apiKey });
}

/**
 * Triggers a wakeup for an agent. Returns the created run (or a skipped
 * response).
 *
 * Callers should check `response.status === "skipped"` and handle accordingly;
 * this function does NOT throw for skipped — it returns the raw response.
 */
export async function wakeAgent(
  apiUrl: string,
  apiKey: string | undefined,
  agentId: string,
  body: WakeAgentBody,
): Promise<WakeAgentResponse> {
  return request<WakeAgentResponse>(apiUrl, `/agents/${agentId}/wakeup`, {
    method: "POST",
    apiKey,
    body,
  });
}

/**
 * Fetches lightweight run events, starting after `afterSeq`.
 *
 * The API endpoint is `GET /api/heartbeat-runs/{runId}/events?afterSeq=N&limit=L`.
 */
export async function getRunEvents(
  apiUrl: string,
  apiKey: string | undefined,
  runId: string,
  afterSeq: number,
  limit = 100,
): Promise<RunEvent[]> {
  const query = new URLSearchParams({
    afterSeq: String(afterSeq),
    limit: String(limit),
  });
  const result = await request<unknown>(apiUrl, `/heartbeat-runs/${runId}/events`, {
    apiKey,
    query,
  });
  // Accept both { events: RunEvent[] } and RunEvent[] response shapes
  if (Array.isArray(result)) return result as RunEvent[];
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.events)) return r.events as RunEvent[];
  return [];
}

// ---------------------------------------------------------------------------
// Company discovery
// ---------------------------------------------------------------------------

export interface PaperclipCompanySummary {
  id: string;
  name: string;
  /** Optional URL slug used in deep-links; not always present. */
  urlKey?: string;
}

/**
 * Lists companies visible to the bearer. Backed by `GET /api/companies`.
 *
 * For local-trusted deployments without auth, returns every company on the
 * instance. For agent-key-scoped requests, returns just the agent's company.
 */
export async function listCompanies(
  apiUrl: string,
  apiKey: string | undefined,
): Promise<PaperclipCompanySummary[]> {
  const raw = await request<unknown>(apiUrl, "/companies", { apiKey });
  if (!Array.isArray(raw)) return [];
  const out: PaperclipCompanySummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    if (!id) continue;
    const name = typeof r.name === "string" ? r.name : id;
    const urlKey =
      typeof r.urlKey === "string"
        ? r.urlKey
        : typeof r.slug === "string"
          ? r.slug
          : undefined;
    out.push({ id, name, urlKey });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agent discovery (lets the dashboard show a dropdown of real agents)
// ---------------------------------------------------------------------------

export interface PaperclipAgentSummary {
  id: string;
  name: string;
  role?: string;
  companyId: string;
  status?: string;
  /** True when this is the agent that owns the current API key. */
  isCurrent?: boolean;
}

/**
 * Lists all agents visible to the API key in the given company.
 *
 * Backed by `GET /api/companies/{companyId}/agents`. An agent API key can
 * see siblings in its own company (the server enforces company access via
 * `assertCompanyAccess`). Returned objects are the full agent records;
 * we project them down to the fields the dashboard actually renders.
 */
export async function listCompanyAgents(
  apiUrl: string,
  apiKey: string | undefined,
  companyId: string,
): Promise<PaperclipAgentSummary[]> {
  const raw = await request<unknown>(apiUrl, `/companies/${companyId}/agents`, { apiKey });
  if (!Array.isArray(raw)) return [];
  const out: PaperclipAgentSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    if (!id) continue;
    const name = typeof r.name === "string" ? r.name : id;
    const role = typeof r.role === "string" ? r.role : undefined;
    const cId = typeof r.companyId === "string" ? r.companyId : companyId;
    const status = typeof r.status === "string" ? r.status : undefined;
    out.push({ id, name, role, companyId: cId, status });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Probe function (public introspection)
// ---------------------------------------------------------------------------

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
  /** Human-readable failure reason when `available === false`. */
  reason?: string;
  probeDurationMs: number;
}

/**
 * Probes a Paperclip server at `apiUrl` using `GET /api/agents/me`.
 *
 * - `200` with valid body → `{ available: true, identity: ... }`
 * - `401` / `403`         → `{ available: false, reason: "API key rejected" }`
 * - `404` / network error → `{ available: false, reason: "Paperclip server not reachable at <url>" }`
 * - Anything else         → `{ available: false, reason: "<status> <first 200 chars of body>" }`
 */
export async function probePaperclipConnection(opts: {
  apiUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<PaperclipConnectionStatus> {
  const { apiKey, timeoutMs = 5_000 } = opts;
  const apiUrl = normalizeApiUrl(opts.apiUrl);
  const url = buildUrl(apiUrl, "/agents/me");
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      apiUrl,
      reason: `Paperclip server not reachable at ${apiUrl}: ${reason}`,
      probeDurationMs: Date.now() - started,
    };
  }

  const probeDurationMs = Date.now() - started;

  if (response.status === 401 || response.status === 403) {
    return { available: false, apiUrl, reason: "API key rejected", probeDurationMs };
  }

  if (response.status === 404) {
    return {
      available: false,
      apiUrl,
      reason: `Paperclip server not reachable at ${apiUrl}: 404 Not Found`,
      probeDurationMs,
    };
  }

  if (!response.ok) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 200);
    } catch {
      // ignore
    }
    return {
      available: false,
      apiUrl,
      reason: `${response.status} ${response.statusText}: ${body}`.trim(),
      probeDurationMs,
    };
  }

  let identity: PaperclipConnectionStatus["identity"];
  try {
    const { value: raw } = await parseJsonBody(response);
    const r = raw as Record<string, unknown>;
    const agentId = typeof r.id === "string" ? r.id : "";
    const companyId = typeof r.companyId === "string" ? r.companyId : "";
    identity = {
      agentId,
      agentName: typeof r.name === "string" ? r.name : agentId,
      role: typeof r.role === "string" ? r.role : undefined,
      companyId,
      companyName: typeof r.companyName === "string" ? r.companyName : undefined,
    };
  } catch {
    return {
      available: false,
      apiUrl,
      reason: "Paperclip server responded 200 but returned invalid JSON",
      probeDurationMs,
    };
  }

  return { available: true, apiUrl, identity, probeDurationMs };
}

// ---------------------------------------------------------------------------
// CLI key minting
// ---------------------------------------------------------------------------

export interface MintCliKeyOptions {
  /** Path to paperclipai binary or "paperclipai" on PATH. */
  cliBinaryPath?: string;
  /** Required: the Paperclip agent ID or shortname. */
  agentRef: string;
  /** Required: the Paperclip company ID (paperclipai's local-cli requires -C). */
  companyId: string;
  /** Optional: name for the new key (default "fusion-runtime"). */
  keyName?: string;
  /** Optional: override the paperclipai config path. */
  configPath?: string;
  /** Optional: override the paperclipai data dir. */
  dataDir?: string;
  /** Hard-kill timeout for the spawn (default 30_000 ms). */
  cliTimeoutMs?: number;
}

export interface MintedApiKey {
  apiKey: string;
  apiBase?: string;
  agentId?: string;
  companyId?: string;
  /** Raw JSON the CLI emitted, for diagnostics. */
  raw?: unknown;
}

/** Strip ANSI escape sequences from a string. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKJHFABCDSTsu]/g, "");
}

/**
 * Mints an agent API key by spawning `paperclipai agent local-cli <agentRef> --json --no-install-skills`.
 *
 * Requires the local `paperclipai` CLI to be onboarded (`~/.paperclip/context.json`
 * must have an authenticated profile). If not onboarded, throws with a hint to
 * run `paperclipai onboard`.
 */
export async function mintAgentApiKeyViaCli(opts: MintCliKeyOptions): Promise<MintedApiKey> {
  const { spawn } = await import("node:child_process");

  const bin = opts.cliBinaryPath ?? "paperclipai";
  const args: string[] = [
    "agent",
    "local-cli",
    opts.agentRef,
    "--json",
    "--no-install-skills",
    "--key-name",
    opts.keyName ?? "fusion-runtime",
  ];
  if (opts.companyId) {
    args.push("--company-id", opts.companyId);
  }
  if (opts.configPath) {
    args.push("--config", opts.configPath);
  }
  if (opts.dataDir) {
    args.push("--data-dir", opts.dataDir);
  }

  const timeoutMs = opts.cliTimeoutMs ?? 30_000;

  return new Promise<MintedApiKey>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new Error(
            `paperclipai binary not found at ${bin}; install via \`npm i -g paperclipai\``,
          ),
        );
      } else {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrLines: string[] = [];
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
      reject(new Error(`paperclipai agent local-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n");
      for (const line of lines) {
        const stripped = stripAnsi(line).trim();
        if (stripped) stderrLines.push(stripped);
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `paperclipai binary not found at ${bin}; install via \`npm i -g paperclipai\``,
          ),
        );
      } else {
        reject(err);
      }
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (killed) return;

      const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const cleanedStdout = stripAnsi(rawStdout).trim();

      if (code !== 0) {
        const lastStderrLine = stderrLines.filter(Boolean).pop() ?? "";
        const hint = "run `paperclipai onboard` to authenticate the CLI";
        const msg = lastStderrLine
          ? `paperclipai agent local-cli exited ${code}: ${lastStderrLine} — ${hint}`
          : `paperclipai agent local-cli exited ${code} — ${hint}`;
        reject(new Error(msg));
        return;
      }

      if (!cleanedStdout) {
        const hint = "run `paperclipai onboard` to authenticate the CLI";
        reject(
          new Error(`paperclipai agent local-cli produced no output — ${hint}`),
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleanedStdout);
      } catch {
        reject(
          new Error(
            `paperclipai agent local-cli returned non-JSON output: ${cleanedStdout.slice(0, 200)}`,
          ),
        );
        return;
      }

      const r = parsed as Record<string, unknown>;
      // Be defensive about field casing: try apiKey, api_key, token
      const apiKey =
        (typeof r.apiKey === "string" ? r.apiKey : undefined) ??
        (typeof r.api_key === "string" ? r.api_key : undefined) ??
        (typeof r.token === "string" ? r.token : undefined);

      if (!apiKey) {
        reject(
          new Error(
            `paperclipai agent local-cli JSON missing apiKey/api_key/token field: ${cleanedStdout.slice(0, 200)}`,
          ),
        );
        return;
      }

      const apiBase =
        (typeof r.apiBase === "string" ? r.apiBase : undefined) ??
        (typeof r.api_base === "string" ? r.api_base : undefined);

      const agentId =
        (typeof r.agentId === "string" ? r.agentId : undefined) ??
        (typeof r.id === "string" ? r.id : undefined);

      const companyId =
        typeof r.companyId === "string" ? r.companyId : undefined;

      resolve({ apiKey, apiBase, agentId, companyId, raw: parsed });
    });
  });
}

// ---------------------------------------------------------------------------
// CLI-backed discovery / probing
//
// In "Local CLI" mode the dashboard shouldn't make HTTP calls itself —
// instead it shells out to `paperclipai`, which carries the user's CLI
// context (profile, api-base, agent key) from `paperclipai onboard`.
// ---------------------------------------------------------------------------

interface CliJsonOptions {
  cliBinaryPath?: string;
  cliConfigPath?: string;
  cliTimeoutMs?: number;
}

function remapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    return new Error(
      `paperclipai binary not found at ${bin}; install via \`npm i -g paperclipai\``,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function spawnPaperclipCliJson<T = unknown>(
  args: string[],
  opts: CliJsonOptions,
): Promise<T> {
  const { spawn } = await import("node:child_process");
  const bin = opts.cliBinaryPath ?? "paperclipai";
  const fullArgs = [...args, "--json"];
  if (opts.cliConfigPath) {
    fullArgs.push("--config", opts.cliConfigPath);
  }
  const timeoutMs = opts.cliTimeoutMs ?? 15_000;
  const label = ["paperclipai", ...args].join(" ");

  return new Promise<T>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(remapSpawnError(err, bin));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrLines: string[] = [];
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n");
      for (const line of lines) {
        const stripped = stripAnsi(line).trim();
        if (stripped) stderrLines.push(stripped);
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(remapSpawnError(err, bin));
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (killed) return;

      const cleaned = stripAnsi(
        Buffer.concat(stdoutChunks).toString("utf-8"),
      ).trim();

      if (code !== 0) {
        const lastErr = stderrLines.filter(Boolean).pop() ?? "";
        reject(
          new Error(
            lastErr ? `${label} exited ${code}: ${lastErr}` : `${label} exited ${code}`,
          ),
        );
        return;
      }
      if (!cleaned) {
        reject(new Error(`${label} produced no output`));
        return;
      }
      try {
        resolve(JSON.parse(cleaned) as T);
      } catch {
        reject(
          new Error(`${label} returned non-JSON output: ${cleaned.slice(0, 200)}`),
        );
      }
    });
  });
}

/**
 * Lists companies by spawning `paperclipai company list --json`.
 * The CLI uses its onboarded context (profile / api-base / api-key), so this
 * works without the dashboard knowing the api URL or key.
 */
export async function listCompaniesViaCli(
  opts: CliJsonOptions,
): Promise<PaperclipCompanySummary[]> {
  const raw = await spawnPaperclipCliJson<unknown>(["company", "list"], opts);
  if (!Array.isArray(raw)) return [];
  const out: PaperclipCompanySummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    if (!id) continue;
    const name = typeof r.name === "string" ? r.name : id;
    const urlKey =
      typeof r.urlKey === "string"
        ? r.urlKey
        : typeof r.slug === "string"
          ? r.slug
          : undefined;
    out.push({ id, name, urlKey });
  }
  return out;
}

/**
 * Lists agents in a company via `paperclipai agent list -C <id> --json`.
 */
export async function listCompanyAgentsViaCli(
  opts: CliJsonOptions & { companyId: string },
): Promise<PaperclipAgentSummary[]> {
  const raw = await spawnPaperclipCliJson<unknown>(
    ["agent", "list", "--company-id", opts.companyId],
    opts,
  );
  if (!Array.isArray(raw)) return [];
  const out: PaperclipAgentSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    if (!id) continue;
    const name = typeof r.name === "string" ? r.name : id;
    const role = typeof r.role === "string" ? r.role : undefined;
    const cId = typeof r.companyId === "string" ? r.companyId : opts.companyId;
    const status = typeof r.status === "string" ? r.status : undefined;
    out.push({ id, name, role, companyId: cId, status });
  }
  return out;
}

/**
 * Creates a Paperclip issue via `paperclipai issue create -C <id> --json`.
 * Mirrors the HTTP `createIssue` shape: returns the created issue record.
 */
export async function createIssueViaCli(
  opts: CliJsonOptions & { companyId: string; body: CreateIssueBody },
): Promise<Record<string, unknown>> {
  const args = ["issue", "create", "--company-id", opts.companyId];
  args.push("--title", opts.body.title);
  if (opts.body.description) args.push("--description", opts.body.description);
  if (opts.body.status) args.push("--status", opts.body.status);
  if (opts.body.assigneeAgentId)
    args.push("--assignee-agent-id", opts.body.assigneeAgentId);
  if (opts.body.parentId) args.push("--parent-id", opts.body.parentId);
  if (opts.body.projectId) args.push("--project-id", opts.body.projectId);
  if (opts.body.goalId) args.push("--goal-id", opts.body.goalId);
  const raw = await spawnPaperclipCliJson<Record<string, unknown>>(args, opts);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `paperclipai issue create returned unexpected payload: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return raw;
}

/**
 * Fetches a single issue via `paperclipai issue get <id> --json`.
 */
export async function getIssueViaCli(
  opts: CliJsonOptions & { issueId: string },
): Promise<Record<string, unknown>> {
  const raw = await spawnPaperclipCliJson<Record<string, unknown>>(
    ["issue", "get", opts.issueId],
    opts,
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `paperclipai issue get returned unexpected payload: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return raw;
}

/**
 * Looks up a single agent's identity via `paperclipai agent get <id> --json`.
 *
 * The HTTP `agentsMe` derives the *self* identity of an agent API key; the CLI
 * doesn't have that endpoint, so the caller must already know the agent id
 * (typically picked in the settings card).
 */
export async function agentsMeViaCli(
  opts: CliJsonOptions & { agentId: string },
): Promise<AgentsMeResponse> {
  const raw = await spawnPaperclipCliJson<Record<string, unknown>>(
    ["agent", "get", opts.agentId],
    opts,
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `paperclipai agent get returned unexpected payload: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  const id = typeof raw.id === "string" ? raw.id : undefined;
  const cId = typeof raw.companyId === "string" ? raw.companyId : undefined;
  if (!id || !cId) {
    throw new Error(
      "paperclipai agent get returned a response missing `id` or `companyId`",
    );
  }
  return {
    agentId: id,
    agentName: typeof raw.name === "string" ? raw.name : id,
    role: typeof raw.role === "string" ? raw.role : undefined,
    companyId: cId,
    companyName:
      typeof raw.companyName === "string" ? raw.companyName : undefined,
  };
}

/**
 * "Test" a Paperclip connection through the local CLI. We treat a successful
 * `paperclipai company list --json` as proof that the binary is installed,
 * the CLI context is configured, and the server is reachable.
 *
 * Identity is intentionally not populated: the CLI represents a board user,
 * not a single agent — the agent picker handles per-agent identity later.
 */
export async function probePaperclipViaCli(
  opts: CliJsonOptions,
): Promise<PaperclipConnectionStatus> {
  const started = Date.now();
  let apiUrl = "(via paperclipai CLI)";
  try {
    const disc = await discoverPaperclipCliConfig({ configPath: opts.cliConfigPath });
    if (disc.ok) apiUrl = disc.apiUrl;
  } catch {
    // best-effort
  }
  try {
    await spawnPaperclipCliJson<unknown>(["company", "list"], opts);
    return { available: true, apiUrl, probeDurationMs: Date.now() - started };
  } catch (err) {
    return {
      available: false,
      apiUrl,
      reason: err instanceof Error ? err.message : String(err),
      probeDurationMs: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------------------
// Legacy probe (used by index.ts onLoad)
// ---------------------------------------------------------------------------

export interface ProbeResult {
  ok: true;
  deploymentMode: string | undefined;
}

export interface ProbeFailure {
  ok: false;
  error: string;
}

export type ProbePaperclipResult = ProbeResult | ProbeFailure;

/**
 * Quick health-check for the Paperclip server via `GET /api/health`.
 * Used by the plugin's `onLoad` hook.
 */
export async function probePaperclipInstance(
  apiUrl: string,
  apiKey?: string,
): Promise<ProbePaperclipResult> {
  try {
    const result = await request<{ status?: string; deploymentMode?: string }>(
      apiUrl,
      "/health",
      { apiKey },
    );
    if (result.status !== "ok") {
      return {
        ok: false,
        error: `Paperclip health check did not return ok status${result.status ? ` (status=${result.status})` : ""}`,
      };
    }
    return { ok: true, deploymentMode: result.deploymentMode };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
