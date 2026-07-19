/**
 * FNXC:CodeOrganization 2026-07-17-12:00:
 * Task attachments, logs, comments, documents, and artifacts client API peeled from legacy.ts.
 */
import type {
  Task,
  TaskAttachment,
  TaskComment,
  TaskDocument,
  TaskDocumentRevision,
  TaskDocumentWithTask,
  Artifact,
  ArtifactType,
  ArtifactWithTask,
  NativeStructureRef,
  NativeStructurePreviewResult,
  AgentLogEntry,
  TaskVerificationRequest,
} from "@fusion/core";
import { appendTokenQuery, withTokenHeader } from "../auth";
import { api, buildApiUrl } from "./client.js";
import { withProjectId } from "./health.js";

/**
 * FNXC:TaskVerificationStatus 2026-07-30-00:00:
 * Task detail polls this persisted read model because verification state changes do
 * not mutate the task row and therefore do not emit a task-board SSE update.
 */
export function fetchTaskVerificationRequest(taskId: string, projectId?: string): Promise<TaskVerificationRequest | null> {
  return api<TaskVerificationRequest | null>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/verification-request`, projectId));
}

export async function uploadAttachment(id: string, file: File, projectId?: string): Promise<TaskAttachment> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(buildApiUrl(withProjectId(`/tasks/${id}/attachments`, projectId)), {
    method: "POST",
    headers: withTokenHeader(),
    body: formData,
  });
  // Non-JSON error bodies (e.g. gateway 413/502 HTML) must not throw SyntaxError over the HTTP failure.
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Upload failed: HTTP ${res.status}`);
  return data as TaskAttachment;
}

export async function deleteAttachment(id: string, filename: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/attachments/${encodeURIComponent(filename)}`, projectId), { method: "DELETE" });
}

export function fetchAgentLogs(
  taskId: string,
  projectId?: string,
  options?: { limit?: number; offset?: number },
): Promise<AgentLogEntry[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options?.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return api<AgentLogEntry[]>(withProjectId(`/tasks/${taskId}/logs${suffix}`, projectId));
}

/**
 * Fetch agent logs with pagination metadata.
 * Returns entries along with total count and hasMore flag from response headers.
 */
export async function fetchAgentLogsWithMeta(
  taskId: string,
  projectId?: string,
  options?: { limit?: number; offset?: number },
): Promise<{ entries: AgentLogEntry[]; total: number; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options?.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const url = withProjectId(`/tasks/${taskId}/logs${suffix}`, projectId);

  const response = await fetch(buildApiUrl(url), {
    headers: withTokenHeader(),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Failed to fetch agent logs" }));
    throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  }

  const entries = await response.json() as AgentLogEntry[];

  // Read pagination headers
  const total = response.headers.has("X-Total-Count")
    ? parseInt(response.headers.get("X-Total-Count")!, 10)
    : entries.length;
  const hasMore = response.headers.has("X-Has-More")
    ? response.headers.get("X-Has-More") === "true"
    : false;

  return { entries, total, hasMore };
}

export function fetchSessionFiles(taskId: string, projectId?: string): Promise<string[]> {
  return api<string[]>(withProjectId(`/tasks/${taskId}/session-files`, projectId));
}

export function fetchTaskComments(id: string, projectId?: string): Promise<TaskComment[]> {
  return api<TaskComment[]>(withProjectId(`/tasks/${id}/comments`, projectId));
}

export function addTaskComment(id: string, text: string, author?: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/comments`, projectId), {
    method: "POST",
    body: JSON.stringify({ text, author }),
  });
}

export function updateTaskComment(id: string, commentId: string, text: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/comments/${commentId}`, projectId), {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });
}

export function deleteTaskComment(id: string, commentId: string, projectId?: string): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/comments/${commentId}`, projectId), {
    method: "DELETE",
  });
}

// ── Task Document API Functions ──────────────────────────────────────────────

export function fetchTaskDocuments(taskId: string, projectId?: string): Promise<TaskDocument[]> {
  return api<TaskDocument[]>(withProjectId(`/tasks/${taskId}/documents`, projectId));
}

export function fetchTaskDocument(taskId: string, key: string, projectId?: string): Promise<TaskDocument> {
  return api<TaskDocument>(withProjectId(`/tasks/${taskId}/documents/${encodeURIComponent(key)}`, projectId));
}

export function fetchTaskDocumentRevisions(taskId: string, key: string, projectId?: string): Promise<TaskDocumentRevision[]> {
  return api<TaskDocumentRevision[]>(withProjectId(`/tasks/${taskId}/documents/${encodeURIComponent(key)}/revisions`, projectId));
}

export interface FetchAllDocumentsOptions {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MarkdownFileEntry {
  path: string;
  name: string;
  size: number;
  mtime: string;
}

export interface MarkdownFileListResponse {
  files: MarkdownFileEntry[];
}

export type { Artifact, ArtifactType, ArtifactWithTask };

export interface FetchArtifactsOptions {
  type?: ArtifactType;
  authorId?: string;
  taskId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function fetchArtifacts(
  options?: FetchArtifactsOptions,
  projectId?: string,
): Promise<ArtifactWithTask[]> {
  const params = new URLSearchParams();
  if (options?.type) params.set("type", options.type);
  if (options?.authorId) params.set("authorId", options.authorId);
  if (options?.taskId) params.set("taskId", options.taskId);
  if (options?.q) params.set("q", options.q);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const queryString = params.toString();
  const path = `/artifacts${queryString ? `?${queryString}` : ""}`;
  return api<ArtifactWithTask[]>(withProjectId(path, projectId));
}

/*
FNXC:ArtifactRegistry 2026-07-15-12:00:
Keep artifactMediaUrl token-free so fetch callers and script-capable HTML previews can authenticate via Authorization without putting the daemon token into a URL that executable artifact content could read.

FNXC:ArtifactMediaAuth 2026-07-15-14:24:
Main previously always-tokenized this helper for browser-native media loads. FN-7976 supersedes that by splitting tokenized element/link loads into artifactMediaUrlWithToken while this base URL stays clean for header-auth fetch and HTML blob previews.
*/
export function artifactMediaUrl(id: string, projectId?: string): string {
  return buildApiUrl(withProjectId(`/artifacts/${encodeURIComponent(id)}/media`, projectId));
}

/*
FNXC:ArtifactRegistry 2026-07-15-12:00:
Artifact media element loads and link navigations cannot attach an Authorization header, so authenticated daemon media routes require the dashboard-owned fn_token query fallback. Keep artifactMediaUrl token-free for fetch callers and script-capable HTML previews; consumers that hand the URL to an img, video, audio, iframe, or anchor must use this helper unless executable content could read the URL.
*/
export function artifactMediaUrlWithToken(id: string, projectId?: string): string {
  return appendTokenQuery(artifactMediaUrl(id, projectId));
}

/*
FNXC:ArtifactRegistry 2026-07-10-15:20:
The Artifacts view document viewer needs the full artifact INCLUDING inline content (list responses strip content), and edit mode persists title/description/content through PATCH.
*/
export async function fetchArtifact(id: string, projectId?: string): Promise<Artifact> {
  return api<Artifact>(withProjectId(`/artifacts/${encodeURIComponent(id)}`, projectId));
}

/**
 * FNXC:NativeStructureEmbed 2026-07-18-18:15:
 * Fetch the shared compact projection for an in-app native structure reference.
 */
export async function fetchNativeStructurePreview(ref: NativeStructureRef): Promise<NativeStructurePreviewResult> {
  return api<NativeStructurePreviewResult>(
    withProjectId(`/native-structures/${encodeURIComponent(ref.kind)}/${encodeURIComponent(ref.id)}/preview`, ref.projectId),
  );
}

export interface UpdateArtifactInput {
  title?: string;
  description?: string;
  content?: string;
}

export async function updateArtifact(id: string, updates: UpdateArtifactInput, projectId?: string): Promise<Artifact> {
  return api<Artifact>(withProjectId(`/artifacts/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function fetchAllDocuments(
  options?: FetchAllDocumentsOptions,
  projectId?: string,
): Promise<TaskDocumentWithTask[]> {
  const params = new URLSearchParams();
  if (options?.q) params.set("q", options.q);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const queryString = params.toString();
  const path = `/documents${queryString ? `?${queryString}` : ""}`;
  return api<TaskDocumentWithTask[]>(withProjectId(path, projectId));
}

export interface FetchProjectMarkdownFilesOptions {
  showHidden?: boolean;
}

export function fetchProjectMarkdownFiles(
  projectId?: string,
  options?: FetchProjectMarkdownFilesOptions,
): Promise<MarkdownFileListResponse> {
  const params = new URLSearchParams();
  if (options?.showHidden) {
    params.set("showHidden", "1");
  }

  const query = params.toString();
  const path = `/files/markdown-list${query ? `?${query}` : ""}`;

  return api<MarkdownFileListResponse>(withProjectId(path, projectId));
}

export function putTaskDocument(
  taskId: string,
  key: string,
  content: string,
  opts?: { author?: string; metadata?: Record<string, unknown> },
  projectId?: string,
): Promise<TaskDocument> {
  return api<TaskDocument>(withProjectId(`/tasks/${taskId}/documents/${encodeURIComponent(key)}`, projectId), {
    method: "PUT",
    body: JSON.stringify({
      content,
      author: opts?.author,
      metadata: opts?.metadata,
    }),
  });
}

export function deleteTaskDocument(taskId: string, key: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/tasks/${taskId}/documents/${encodeURIComponent(key)}`, projectId), {
    method: "DELETE",
  });
}
