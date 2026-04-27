/**
 * Paperclip REST API client.
 *
 * This module intentionally does not depend on @fusion/engine.
 */

export interface PaperclipConfig {
  apiUrl: string;
  apiKey: string | undefined;
  agentId: string | undefined;
  companyId: string | undefined;
}

export interface ProbeResult {
  ok: true;
  deploymentMode: string | undefined;
}

export interface ProbeFailure {
  ok: false;
  error: string;
}

export type ProbePaperclipResult = ProbeResult | ProbeFailure;

export interface AgentIdentity {
  id: string;
  name?: string;
  companyId: string;
  role?: string;
  status?: string;
}

export type AgentIdentityResult =
  | { ok: true; agent: AgentIdentity }
  | { ok: false; reason: "unauthenticated" | "not_agent" };

export interface ListIssuesFilters {
  status?: string | string[];
  assigneeAgentId?: string;
  projectId?: string;
}

export class ConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

interface ParsedBody {
  value: unknown;
  raw: string;
}

function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function getSettingString(settings: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = settings?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function buildApiUrl(apiUrl: string, path: string): string {
  const base = normalizeApiUrl(apiUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}/api${normalizedPath}`;
}

function toErrorMessage(status: number, statusText: string, body: unknown, rawBody: string): string {
  if (body && typeof body === "object") {
    if (typeof (body as { error?: unknown }).error === "string") {
      return (body as { error: string }).error;
    }
    if (typeof (body as { message?: unknown }).message === "string") {
      return (body as { message: string }).message;
    }
  }

  if (rawBody.trim() !== "") {
    return rawBody.trim();
  }

  return `${status} ${statusText}`.trim();
}

async function parseBody(response: Response): Promise<ParsedBody> {
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

async function request<T>(
  apiUrl: string,
  path: string,
  options?: {
    method?: string;
    apiKey?: string;
    body?: unknown;
    runId?: string;
    query?: URLSearchParams;
  },
): Promise<T> {
  const method = options?.method ?? "GET";
  const url = `${buildApiUrl(apiUrl, path)}${options?.query ? `?${options.query.toString()}` : ""}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (options?.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  if (options?.runId) {
    headers["X-Paperclip-Run-Id"] = options.runId;
  }

  let body: string | undefined;
  if (options && "body" in options && options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Paperclip API network error (${method} ${url}): ${reason}`);
  }

  const parsed = await parseBody(response);

  if (!response.ok) {
    const message = toErrorMessage(response.status, response.statusText, parsed.value, parsed.raw);
    const errorMessage = `Paperclip API ${response.status} (${method} ${path}): ${message}`;
    if (response.status === 409) {
      throw new ConflictError(errorMessage);
    }
    throw new Error(errorMessage);
  }

  return parsed.value as T;
}

export function resolvePaperclipConfig(settings?: Record<string, unknown>): PaperclipConfig {
  const apiUrl =
    getSettingString(settings, "apiUrl") ??
    process.env.PAPERCLIP_API_URL?.trim() ??
    "http://localhost:3100";

  const envApiKey = process.env.PAPERCLIP_API_KEY?.trim() || undefined;
  const envAgentId = process.env.PAPERCLIP_AGENT_ID?.trim() || undefined;
  const envCompanyId = process.env.PAPERCLIP_COMPANY_ID?.trim() || undefined;

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey: getSettingString(settings, "apiKey") ?? envApiKey,
    agentId: getSettingString(settings, "agentId") ?? envAgentId,
    companyId: getSettingString(settings, "companyId") ?? envCompanyId,
  };
}

export async function probePaperclipInstance(
  apiUrl: string,
  apiKey?: string,
): Promise<ProbePaperclipResult> {
  try {
    const result = await request<{ status?: string; deploymentMode?: string }>(apiUrl, "/health", {
      apiKey,
    });

    if (result.status !== "ok") {
      return {
        ok: false,
        error: `Paperclip health check did not return ok status${
          result.status ? ` (status=${result.status})` : ""
        }`,
      };
    }

    return { ok: true, deploymentMode: result.deploymentMode };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getAgentIdentity(apiUrl: string, apiKey?: string): Promise<AgentIdentityResult> {
  const url = buildApiUrl(apiUrl, "/agents/me");
  const headers: Record<string, string> = { Accept: "application/json" };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Paperclip API network error (GET ${url}): ${reason}`);
  }

  if (response.status === 401) {
    return { ok: false, reason: "unauthenticated" };
  }

  if (response.status === 403) {
    return { ok: false, reason: "not_agent" };
  }

  const parsed = await parseBody(response);

  if (!response.ok) {
    const message = toErrorMessage(response.status, response.statusText, parsed.value, parsed.raw);
    throw new Error(`Paperclip API ${response.status} (GET /agents/me): ${message}`);
  }

  const agent = parsed.value as Partial<AgentIdentity>;
  if (!agent.id || !agent.companyId) {
    throw new Error("Paperclip API returned invalid agent identity response");
  }

  return {
    ok: true,
    agent: {
      id: agent.id,
      name: agent.name,
      companyId: agent.companyId,
      role: agent.role,
      status: agent.status,
    },
  };
}

export async function listIssues(
  apiUrl: string,
  apiKey: string | undefined,
  companyId: string,
  filters?: ListIssuesFilters,
): Promise<unknown[]> {
  const query = new URLSearchParams();
  if (filters?.status) {
    query.set("status", Array.isArray(filters.status) ? filters.status.join(",") : filters.status);
  }
  if (filters?.assigneeAgentId) {
    query.set("assigneeAgentId", filters.assigneeAgentId);
  }
  if (filters?.projectId) {
    query.set("projectId", filters.projectId);
  }

  return request<unknown[]>(apiUrl, `/companies/${companyId}/issues`, {
    apiKey,
    query: query.size > 0 ? query : undefined,
  });
}

export async function getIssue(
  apiUrl: string,
  apiKey: string | undefined,
  issueId: string,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(apiUrl, `/issues/${issueId}`, { apiKey });
}

export async function createIssue(
  apiUrl: string,
  apiKey: string | undefined,
  companyId: string,
  issue: {
    title: string;
    description: string;
    status: string;
    assigneeAgentId: string;
  },
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(apiUrl, `/companies/${companyId}/issues`, {
    method: "POST",
    apiKey,
    body: issue,
  });
}

export async function updateIssue(
  apiUrl: string,
  apiKey: string | undefined,
  issueId: string,
  patch: Record<string, unknown>,
  runId?: string,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(apiUrl, `/issues/${issueId}`, {
    method: "PATCH",
    apiKey,
    body: patch,
    runId,
  });
}

export async function checkoutIssue(
  apiUrl: string,
  apiKey: string | undefined,
  issueId: string,
  agentId: string,
  runId?: string,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(apiUrl, `/issues/${issueId}/checkout`, {
    method: "POST",
    apiKey,
    body: {
      agentId,
      expectedStatuses: ["todo", "backlog"],
    },
    runId,
  });
}

export async function getIssueComments(
  apiUrl: string,
  apiKey: string | undefined,
  issueId: string,
): Promise<Array<Record<string, unknown>>> {
  return request<Array<Record<string, unknown>>>(apiUrl, `/issues/${issueId}/comments`, { apiKey });
}

export async function addComment(
  apiUrl: string,
  apiKey: string | undefined,
  issueId: string,
  body: string,
  runId?: string,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(apiUrl, `/issues/${issueId}/comments`, {
    method: "POST",
    apiKey,
    body: { body },
    runId,
  });
}

export async function invokeHeartbeat(
  apiUrl: string,
  apiKey: string | undefined,
  agentId: string,
): Promise<{ ok: true; skipped: true } | { ok: true; run: Record<string, unknown> }> {
  const result = await request<Record<string, unknown>>(apiUrl, `/agents/${agentId}/heartbeat/invoke`, {
    method: "POST",
    apiKey,
  });

  if (result.status === "skipped") {
    return { ok: true, skipped: true };
  }

  return { ok: true, run: result };
}

