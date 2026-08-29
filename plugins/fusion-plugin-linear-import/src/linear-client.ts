export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const PAGE_SIZE = 50;
const MAX_PAGES = 5;

export type LinearIssueStateFilter = "active" | "backlog" | "started" | "unstarted" | "completed" | "canceled" | "all";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  state?: { id?: string; name?: string; type?: string } | null;
  team?: { id?: string; key?: string; name?: string } | null;
  assignee?: { id?: string; name?: string; email?: string } | null;
  creator?: { id?: string; name?: string; email?: string } | null;
  labels: Array<{ id?: string; name: string }>;
  createdAt?: string;
  updatedAt?: string;
}

export interface LinearIssueListOptions {
  query?: string;
  teamKey?: string;
  state?: LinearIssueStateFilter;
  assigneeId?: string;
  limit?: number;
  after?: string;
}

export interface LinearIssueListResult {
  issues: LinearIssue[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

export class LinearApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "linear_api_error") {
    super(message);
    this.name = "LinearApiError";
  }
}

export function clampLinearLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function redactSensitiveText(message: string, secrets: string[] = []): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted.replace(/\b(token|key|secret)[-_:=][A-Za-z0-9._-]+/giu, "$1-[redacted]");
}

function normalizeLinearErrorMessage(status: number, body: unknown, secrets: string[] = []): string {
  if (status === 401) return "Linear API key is missing, invalid, or expired.";
  if (status === 403) return "Linear API key does not have access to the requested Linear workspace or team.";
  if (status === 429) return "Linear rate limit exceeded. Try again later.";
  const raw = asRecord(body);
  const errors = Array.isArray(raw.errors) ? raw.errors : [];
  const first = asRecord(errors[0]);
  const message = asString(first.message) ?? asString(raw.error) ?? asString(raw.message);
  return message ? `Linear GraphQL error: ${redactSensitiveText(message, secrets)}` : `Linear API request failed with status ${status}.`;
}

function mapFetchError(error: unknown): LinearApiError {
  if (error instanceof LinearApiError) return error;
  return new LinearApiError(0, "Unable to reach Linear API. Check network access and plugin configuration.", "network_error");
}

export function buildLinearIssueFilter(options: LinearIssueListOptions): Record<string, unknown> | undefined {
  const and: Record<string, unknown>[] = [];
  if (options.teamKey?.trim()) {
    and.push({ team: { or: [{ key: { eqIgnoreCase: options.teamKey.trim() } }, { id: { eq: options.teamKey.trim() } }] } });
  }
  if (options.assigneeId?.trim()) {
    and.push({ assignee: { id: { eq: options.assigneeId.trim() } } });
  }
  if (options.state && options.state !== "all") {
    and.push({ state: { type: { eq: options.state } } });
  }
  if (options.query?.trim()) {
    const q = options.query.trim();
    and.push({ or: [{ title: { containsIgnoreCase: q } }, { description: { containsIgnoreCase: q } }, { identifier: { containsIgnoreCase: q } }] });
  }
  return and.length > 0 ? { and } : undefined;
}

export const LINEAR_ISSUES_QUERY = `query FusionLinearImportIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      description
      url
      createdAt
      updatedAt
      state { id name type }
      team { id key name }
      assignee { id name email }
      creator { id name email }
      labels { nodes { id name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const LINEAR_ISSUE_QUERY = `query FusionLinearImportIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    createdAt
    updatedAt
    state { id name type }
    team { id key name }
    assignee { id name email }
    creator { id name email }
    labels { nodes { id name } }
  }
}`;

function normalizeIssue(rawIssue: unknown): LinearIssue | null {
  const raw = asRecord(rawIssue);
  const id = asString(raw.id);
  const identifier = asString(raw.identifier);
  const title = asString(raw.title);
  const url = asString(raw.url);
  if (!id || !identifier || !title || !url) return null;
  const labelsRaw = asRecord(raw.labels).nodes;
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw.flatMap((label) => {
      const rawLabel = asRecord(label);
      const name = asString(rawLabel.name);
      return name ? [{ id: asString(rawLabel.id), name }] : [];
    })
    : [];
  const state = asRecord(raw.state);
  const team = asRecord(raw.team);
  const assignee = asRecord(raw.assignee);
  const creator = asRecord(raw.creator);
  return {
    id,
    identifier,
    title,
    description: typeof raw.description === "string" ? raw.description : null,
    url,
    state: Object.keys(state).length ? { id: asString(state.id), name: asString(state.name), type: asString(state.type) } : null,
    team: Object.keys(team).length ? { id: asString(team.id), key: asString(team.key), name: asString(team.name) } : null,
    assignee: Object.keys(assignee).length ? { id: asString(assignee.id), name: asString(assignee.name), email: asString(assignee.email) } : null,
    creator: Object.keys(creator).length ? { id: asString(creator.id), name: asString(creator.name), email: asString(creator.email) } : null,
    labels,
    createdAt: asString(raw.createdAt),
    updatedAt: asString(raw.updatedAt),
  };
}

export class LinearClient {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw mapFetchError(error);
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new LinearApiError(response.status, normalizeLinearErrorMessage(response.status, body, [this.apiKey]));
    }
    const errors = Array.isArray(asRecord(body).errors) ? asRecord(body).errors as unknown[] : [];
    if (errors.length > 0) {
      throw new LinearApiError(400, normalizeLinearErrorMessage(400, body, [this.apiKey]), "graphql_error");
    }
    return asRecord(body).data as T;
  }

  /*
  FNXC:LinearImport 2026-07-02-00:00:
  FN-7443 integrates Linear as a plugin-owned SaaS GraphQL HTTP client. Keep pagination bounded and errors credential-safe so plugin routes/tools can expose actionable failures without ever returning the API key.
  */
  async listIssues(options: LinearIssueListOptions = {}): Promise<LinearIssueListResult> {
    const limit = clampLinearLimit(options.limit);
    const issues: LinearIssue[] = [];
    let after = options.after;
    let pageInfo: LinearIssueListResult["pageInfo"] = { hasNextPage: false, endCursor: null };
    for (let page = 0; issues.length < limit && page < MAX_PAGES; page += 1) {
      const data = await this.request<{ issues?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }>(LINEAR_ISSUES_QUERY, {
        first: Math.min(PAGE_SIZE, limit - issues.length),
        after: after ?? null,
        filter: buildLinearIssueFilter(options) ?? null,
      });
      const connection = data.issues ?? {};
      const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
      issues.push(...nodes.map(normalizeIssue).filter((issue): issue is LinearIssue => Boolean(issue)));
      pageInfo = {
        hasNextPage: connection.pageInfo?.hasNextPage === true,
        endCursor: connection.pageInfo?.endCursor ?? null,
      };
      if (!pageInfo.hasNextPage || !pageInfo.endCursor || nodes.length === 0) break;
      after = pageInfo.endCursor;
    }
    return { issues: issues.slice(0, limit), pageInfo };
  }

  async getIssue(idOrIdentifier: string): Promise<LinearIssue> {
    const id = idOrIdentifier.trim();
    if (!id) throw new LinearApiError(400, "Linear issue id or identifier is required.", "validation_error");
    const data = await this.request<{ issue?: unknown }>(LINEAR_ISSUE_QUERY, { id });
    const issue = normalizeIssue(data.issue);
    if (!issue) throw new LinearApiError(404, "Linear issue was not found or is inaccessible.", "not_found");
    return issue;
  }
}

export function linearErrorToResponse(error: unknown): { status: number; error: string; code: string } {
  if (error instanceof LinearApiError) {
    const status = error.status === 0 ? 502 : error.status;
    return { status, error: error.message, code: error.code };
  }
  return { status: 500, error: "Linear import failed unexpectedly.", code: "unexpected_error" };
}
