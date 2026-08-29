import type { Task, TaskGitLabTracking, TaskSourceIssue } from "@fusion/core";
import type { ResolvedGitlabAuth } from "./gitlab-auth.js";

export type GitLabResourceType = "project_issue" | "group_issue" | "merge_request";

export interface GitLabAuthor {
  id?: number;
  username?: string;
  name?: string;
  avatarUrl?: string;
  webUrl?: string;
}

export interface GitLabProjectIdentity {
  id?: number;
  pathWithNamespace?: string;
  webUrl?: string;
}

export interface GitLabIssue {
  resourceKind: "project_issue" | "group_issue";
  id?: number;
  iid: number;
  projectId?: number;
  projectPath?: string;
  groupId?: number | string;
  groupPath?: string;
  title: string;
  description: string | null;
  webUrl: string;
  state: string;
  author?: GitLabAuthor | null;
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  commentsCount?: number;
}

export interface GitLabMergeRequest {
  resourceKind: "merge_request";
  id?: number;
  iid: number;
  projectId?: number;
  projectPath?: string;
  title: string;
  description: string | null;
  webUrl: string;
  state: string;
  author?: GitLabAuthor | null;
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  mergedAt?: string;
  commentsCount?: number;
  sourceBranch?: string;
  targetBranch?: string;
  draft?: boolean;
}

export interface GitLabListOptions {
  limit?: number;
  labels?: string[];
  state?: string;
}

export class GitLabApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GitLabApiError";
  }
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const PAGE_SIZE = 100;
/*
FNXC:IssueImportAttachments 2026-07-15-14:10:
Issue-note text is auxiliary attachment input. Bound both requests and retained bodies so a hostile or unusually large issue cannot make import pagination unbounded.
*/
const MAX_NOTE_PAGES = 10;
const MAX_NOTE_BODIES = 500;

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

export function encodeGitLabPathId(id: string | number): string {
  return encodeURIComponent(String(id).trim());
}

function appendListParams(params: URLSearchParams, options: GitLabListOptions): void {
  const state = typeof options.state === "string" && options.state.trim() ? options.state.trim() : "opened";
  params.set("state", state);
  if (options.labels && options.labels.length > 0) {
    params.set("labels", options.labels.map((label) => label.trim()).filter(Boolean).join(","));
  }
}

type GitLabRaw = Record<string, unknown>;

function asRecord(value: unknown): GitLabRaw {
  return value && typeof value === "object" ? value as GitLabRaw : {};
}

function normalizeAuthor(author: unknown): GitLabAuthor | null {
  const raw = asRecord(author);
  if (Object.keys(raw).length === 0) return null;
  return {
    ...(typeof raw.id === "number" ? { id: raw.id } : {}),
    ...(typeof raw.username === "string" ? { username: raw.username } : {}),
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    ...(typeof raw.avatar_url === "string" ? { avatarUrl: raw.avatar_url } : {}),
    ...(typeof raw.web_url === "string" ? { webUrl: raw.web_url } : {}),
  };
}

function normalizeLabels(labels: unknown): string[] {
  return Array.isArray(labels) ? labels.filter((label): label is string => typeof label === "string") : [];
}

function readProjectPath(input: unknown): string | undefined {
  const raw = asRecord(input);
  if (typeof raw.project_path_with_namespace === "string") return raw.project_path_with_namespace;
  const references = asRecord(raw.references);
  if (typeof references.full === "string") {
    const full = references.full;
    const webUrl = typeof raw.web_url === "string" ? raw.web_url : "";
    const marker = webUrl.includes("/-/merge_requests/") ? "!" : "#";
    const idx = full.lastIndexOf(marker);
    return idx > 0 ? full.slice(0, idx) : undefined;
  }
  if (typeof raw?.web_url === "string") {
    const marker = raw.web_url.includes("/-/merge_requests/") ? "/-/merge_requests/" : "/-/issues/";
    try {
      const url = new URL(raw.web_url);
      const idx = url.pathname.indexOf(marker);
      return idx > 0 ? decodeURIComponent(url.pathname.slice(1, idx)) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizeIssue(input: unknown, resourceKind: "project_issue" | "group_issue", extras: Partial<GitLabIssue> = {}): GitLabIssue {
  const raw = asRecord(input);
  return {
    resourceKind,
    ...(typeof raw.id === "number" ? { id: raw.id } : {}),
    iid: Number(raw.iid),
    ...(typeof raw.project_id === "number" ? { projectId: raw.project_id } : {}),
    ...(readProjectPath(raw) ? { projectPath: readProjectPath(raw) } : {}),
    title: String(raw.title ?? ""),
    description: typeof raw.description === "string" ? raw.description : null,
    webUrl: String(raw.web_url ?? ""),
    state: String(raw.state ?? "unknown"),
    author: normalizeAuthor(raw.author),
    labels: normalizeLabels(raw.labels),
    ...(typeof raw.created_at === "string" ? { createdAt: raw.created_at } : {}),
    ...(typeof raw.updated_at === "string" ? { updatedAt: raw.updated_at } : {}),
    ...(typeof raw.closed_at === "string" ? { closedAt: raw.closed_at } : {}),
    ...(typeof raw.user_notes_count === "number" ? { commentsCount: raw.user_notes_count } : {}),
    ...extras,
  };
}

function normalizeMergeRequest(input: unknown, extras: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest {
  const raw = asRecord(input);
  return {
    resourceKind: "merge_request",
    ...(typeof raw.id === "number" ? { id: raw.id } : {}),
    iid: Number(raw.iid),
    ...(typeof raw.project_id === "number" ? { projectId: raw.project_id } : {}),
    ...(readProjectPath(raw) ? { projectPath: readProjectPath(raw) } : {}),
    title: String(raw.title ?? ""),
    description: typeof raw.description === "string" ? raw.description : null,
    webUrl: String(raw.web_url ?? ""),
    state: String(raw.state ?? "unknown"),
    author: normalizeAuthor(raw.author),
    labels: normalizeLabels(raw.labels),
    ...(typeof raw.created_at === "string" ? { createdAt: raw.created_at } : {}),
    ...(typeof raw.updated_at === "string" ? { updatedAt: raw.updated_at } : {}),
    ...(typeof raw.closed_at === "string" ? { closedAt: raw.closed_at } : {}),
    ...(typeof raw.merged_at === "string" ? { mergedAt: raw.merged_at } : {}),
    ...(typeof raw.user_notes_count === "number" ? { commentsCount: raw.user_notes_count } : {}),
    ...(typeof raw.source_branch === "string" ? { sourceBranch: raw.source_branch } : {}),
    ...(typeof raw.target_branch === "string" ? { targetBranch: raw.target_branch } : {}),
    ...(typeof raw.draft === "boolean" ? { draft: raw.draft } : {}),
    ...extras,
  };
}

export class GitLabClient {
  constructor(public readonly auth: ResolvedGitlabAuth, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.auth.apiBaseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        Accept: "application/json",
        [this.auth.headerName]: this.auth.token,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new GitLabApiError(response.status, mapGitLabError(response.status));
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private async listPaginated<T>(path: string, options: GitLabListOptions, normalize: (raw: unknown) => T): Promise<T[]> {
    const limit = clampLimit(options.limit);
    const out: T[] = [];
    let page = 1;
    while (out.length < limit && page <= Math.ceil(limit / PAGE_SIZE) + 1) {
      const params = new URLSearchParams();
      params.set("per_page", String(Math.min(PAGE_SIZE, limit - out.length)));
      params.set("page", String(page));
      appendListParams(params, options);
      const rows = await this.request<unknown[]>(`${path}?${params.toString()}`);
      if (!Array.isArray(rows) || rows.length === 0) break;
      out.push(...rows.map(normalize));
      if (rows.length < Number(params.get("per_page"))) break;
      page += 1;
    }
    return out.slice(0, limit);
  }

  listProjectIssues(project: string | number, options: GitLabListOptions = {}): Promise<GitLabIssue[]> {
    return this.listPaginated(`projects/${encodeGitLabPathId(project)}/issues`, options, (raw) => normalizeIssue(raw, "project_issue"));
  }

  listGroupIssues(group: string | number, options: GitLabListOptions = {}): Promise<GitLabIssue[]> {
    return this.listPaginated(`groups/${encodeGitLabPathId(group)}/issues`, options, (raw) => normalizeIssue(raw, "group_issue", {
      groupPath: typeof group === "string" ? group : undefined,
      groupId: typeof group === "number" ? group : undefined,
    }));
  }

  listMergeRequests(project: string | number, options: GitLabListOptions = {}): Promise<GitLabMergeRequest[]> {
    return this.listPaginated(`projects/${encodeGitLabPathId(project)}/merge_requests`, options, normalizeMergeRequest);
  }

  async getProjectIssue(project: string | number, iid: number): Promise<GitLabIssue> {
    return normalizeIssue(await this.request(`projects/${encodeGitLabPathId(project)}/issues/${iid}`), "project_issue");
  }

  async getMergeRequest(project: string | number, iid: number): Promise<GitLabMergeRequest> {
    return normalizeMergeRequest(await this.request(`projects/${encodeGitLabPathId(project)}/merge_requests/${iid}`));
  }

  /*
  FNXC:IssueImportAttachments 2026-07-15-13:40:
  Import reads note bodies so screenshots posted in a comment ("here's the repro") reach the agent as attachments, not just those in the original description. Read-only: this does not post notes, and the "no comment side effects" rule above governs writes, not reads.
  Returns bodies only — the caller needs image references, not authorship — and swallows nothing: the caller decides that a notes failure is non-fatal.
  */
  async listNotes(resource: "issues" | "merge_requests", project: string | number, iid: number): Promise<string[]> {
    const bodies: string[] = [];
    for (let page = 1; page <= MAX_NOTE_PAGES && bodies.length < MAX_NOTE_BODIES; page++) {
      const raw = await this.request<unknown>(`projects/${encodeGitLabPathId(project)}/${resource}/${iid}/notes?per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(raw) || raw.length === 0) break;
      for (const note of raw) {
        const body = (note as { body?: unknown })?.body;
        if (typeof body === "string") bodies.push(body);
        if (bodies.length === MAX_NOTE_BODIES) break;
      }
      if (raw.length < PAGE_SIZE) break;
    }
    return bodies;
  }

  /*
  FNXC:GitLabLifecycle 2026-07-02-00:00:
  GitLab lifecycle side effects must use REST notes and state_event APIs for GitLab.com and self-managed instances. Keep project identifiers URL-encoded, token auth header-based, and never introduce a local GitLab CLI dependency.
  */
  async commentOnProjectIssue(project: string | number, iid: number, body: string): Promise<void> {
    await this.request(`projects/${encodeGitLabPathId(project)}/issues/${iid}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async commentOnMergeRequest(project: string | number, iid: number, body: string): Promise<void> {
    await this.request(`projects/${encodeGitLabPathId(project)}/merge_requests/${iid}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async setProjectIssueState(project: string | number, iid: number, state: "opened" | "closed"): Promise<GitLabIssue> {
    const params = new URLSearchParams({ state_event: state === "closed" ? "close" : "reopen" });
    return normalizeIssue(await this.request(`projects/${encodeGitLabPathId(project)}/issues/${iid}?${params.toString()}`, { method: "PUT" }), "project_issue");
  }

  async setMergeRequestState(project: string | number, iid: number, state: "opened" | "closed"): Promise<GitLabMergeRequest> {
    const params = new URLSearchParams({ state_event: state === "closed" ? "close" : "reopen" });
    return normalizeMergeRequest(await this.request(`projects/${encodeGitLabPathId(project)}/merge_requests/${iid}?${params.toString()}`, { method: "PUT" }));
  }
}

export function mapGitLabError(status: number): string {
  switch (status) {
    case 401:
      return "GitLab authentication failed. Check gitlabAuthToken and required read_api scope.";
    case 403:
      return "GitLab authorization failed. Check token scope and project/group access.";
    case 404:
      return "GitLab project, group, issue, or merge request was not found.";
    case 429:
      return "GitLab rate limit exceeded. Try again later.";
    default:
      return status >= 500 ? "GitLab is unavailable. Try again later." : `GitLab API request failed with status ${status}.`;
  }
}

function projectIdentity(item: GitLabIssue | GitLabMergeRequest): string {
  return item.projectPath ?? (item.projectId !== undefined ? String(item.projectId) : "unknown-project");
}

export function buildGitLabTaskProvenance(args: {
  auth: Pick<ResolvedGitlabAuth, "apiBaseUrl" | "webBaseUrl">;
  resourceType: GitLabResourceType;
  item: GitLabIssue | GitLabMergeRequest;
  projectInput?: string | number;
  groupInput?: string | number;
}): { sourceIssue: TaskSourceIssue; gitlabTracking: TaskGitLabTracking; sourceMetadata: Record<string, unknown> } {
  const { auth, resourceType, item } = args;
  const groupPathFromInput = typeof args.groupInput === "string" ? args.groupInput : undefined;
  const groupIdFromInput = typeof args.groupInput === "number" ? args.groupInput : undefined;
  const repository = projectIdentity(item);
  const externalIssueId = resourceType === "merge_request"
    ? `gitlab:mr:${item.projectId ?? repository}:${item.id ?? item.iid}`
    : String(item.id ?? `${item.projectId ?? repository}:${item.iid}`);
  const url = new URL(item.webUrl);
  return {
    sourceIssue: {
      provider: "gitlab",
      repository,
      externalIssueId,
      issueNumber: item.iid,
      url: item.webUrl,
    },
    gitlabTracking: {
      item: {
        kind: resourceType,
        url: item.webUrl,
        instanceUrl: auth.webBaseUrl,
        host: url.host,
        iid: item.iid,
        ...(typeof item.id === "number" ? { id: item.id } : {}),
        ...(typeof item.projectId === "number" ? { projectId: item.projectId } : {}),
        ...(typeof item.projectPath === "string" ? { projectPath: item.projectPath } : {}),
        ...("groupId" in item && item.groupId !== undefined ? { groupId: item.groupId } : groupIdFromInput !== undefined ? { groupId: groupIdFromInput } : {}),
        ...("groupPath" in item && item.groupPath !== undefined ? { groupPath: item.groupPath } : groupPathFromInput !== undefined ? { groupPath: groupPathFromInput } : {}),
        title: item.title,
        state: item.state,
        createdAt: item.createdAt ?? new Date().toISOString(),
        linkedAt: new Date().toISOString(),
        ...(item.updatedAt ? { lastSyncedAt: item.updatedAt } : {}),
      },
    },
    sourceMetadata: {
      provider: "gitlab",
      resourceType,
      instanceUrl: auth.webBaseUrl,
      apiBaseUrl: auth.apiBaseUrl,
      projectId: item.projectId,
      projectPath: item.projectPath,
      groupId: "groupId" in item && item.groupId !== undefined ? item.groupId : groupIdFromInput,
      groupPath: "groupPath" in item && item.groupPath !== undefined ? item.groupPath : groupPathFromInput,
      projectInput: args.projectInput,
      groupInput: args.groupInput,
      iid: item.iid,
      webUrl: item.webUrl,
      ...(resourceType === "merge_request" ? {
        mergeRequestId: item.id,
        mergeRequestIid: item.iid,
        sourceBranch: (item as GitLabMergeRequest).sourceBranch,
        targetBranch: (item as GitLabMergeRequest).targetBranch,
        draft: (item as GitLabMergeRequest).draft,
      } : {
        issueId: item.id,
        issueIid: item.iid,
      }),
    },
  };
}

export function isGitLabAlreadyImported(task: Pick<Task, "description" | "sourceIssue" | "source">, provenance: { sourceIssue: TaskSourceIssue; sourceMetadata: Record<string, unknown> }): boolean {
  const sourceUrl = provenance.sourceIssue.url;
  if (sourceUrl && task.description?.includes(sourceUrl)) return true;
  if (task.sourceIssue?.provider === "gitlab" && task.sourceIssue.externalIssueId === provenance.sourceIssue.externalIssueId) return true;
  const metadata = task.source?.sourceMetadata;
  if (task.source?.sourceType === "gitlab_import" && metadata && typeof metadata === "object") {
    const meta = metadata as Record<string, unknown>;
    return meta.resourceType === provenance.sourceMetadata.resourceType
      && meta.iid === provenance.sourceMetadata.iid
      && (meta.projectId === provenance.sourceMetadata.projectId || meta.projectPath === provenance.sourceMetadata.projectPath)
      && (meta.webUrl === sourceUrl || sourceUrl === undefined);
  }
  return false;
}

export function buildGitLabTaskDescription(item: GitLabIssue | GitLabMergeRequest): string {
  const body = item.description?.trim() || "(no description)";
  return `${body}\n\nSource: ${item.webUrl}`;
}

/*
FNXC:GitLabImport 2026-07-02-00:00:
FN-7424 adds HTTP API-only GitLab imports for project issues, group issues, and merge requests. Keep this client token-based and provenance-focused: do not invoke `glab`, post comments, auto-close resources, add tracking UI, Command Center signals, research/search providers, or star prompts in this slice.
*/
