/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Workspace file browser and file operations client API peeled from legacy.ts.
 */
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

// --- File Browser API ---

/** File node in directory listing */
export interface FileNode {
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
}

/** File listing response */
export interface FileListResponse {
  path: string;
  entries: FileNode[];
}

/** File content response */
export interface FileContentResponse {
  content: string;
  mtime: string;
  size: number;
}

/** Save file response */
export interface SaveFileResponse {
  success: true;
  mtime: string;
  size: number;
}

/** List files in task directory */
export function fetchFileList(taskId: string, path?: string, projectId?: string): Promise<FileListResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return api<FileListResponse>(withProjectId(`/tasks/${taskId}/files${query}`, projectId));
}

/** Fetch file content */
export function fetchFileContent(taskId: string, filePath: string, projectId?: string): Promise<FileContentResponse> {
  return api<FileContentResponse>(withProjectId(`/tasks/${taskId}/files/${encodeURIComponent(filePath)}`, projectId));
}

/** Save file content */
export function saveFileContent(taskId: string, filePath: string, content: string, projectId?: string): Promise<SaveFileResponse> {
  return api<SaveFileResponse>(withProjectId(`/tasks/${taskId}/files/${encodeURIComponent(filePath)}`, projectId), {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

// --- Workspace File Browser API ---

export interface WorkspaceTaskInfo {
  id: string;
  title?: string;
  worktree: string;
}

export interface WorkspaceListResponse {
  project: string;
  tasks: WorkspaceTaskInfo[];
}

/** Fetch available file browser workspaces. */
export function fetchWorkspaces(projectId?: string): Promise<WorkspaceListResponse> {
  return api<WorkspaceListResponse>(withProjectId("/workspaces", projectId));
}

/** List files in a workspace (project root or task worktree). */
export function fetchWorkspaceFileList(workspace: string, path?: string, projectId?: string): Promise<FileListResponse> {
  const query = new URLSearchParams({ workspace });
  if (path) {
    query.set("path", path);
  }
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileListResponse>(`/files?${query.toString()}`);
}

/** Fetch file content from a workspace. */
export function fetchWorkspaceFileContent(workspace: string, filePath: string, projectId?: string): Promise<FileContentResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileContentResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`);
}

/** Save file content to a workspace. */
export function saveWorkspaceFileContent(workspace: string, filePath: string, content: string, projectId?: string): Promise<SaveFileResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<SaveFileResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

/** File search result. */
export interface FileSearchResult {
  files: Array<{ path: string; name: string }>;
}

export interface IssueMentionItem {
  number: number;
  title: string;
  state: "open" | "closed";
  htmlUrl: string;
  repository: string;
  updatedAt?: string;
}

export function fetchRecentIssues(projectId?: string, query?: string): Promise<IssueMentionItem[]> {
  const params = new URLSearchParams();
  if (query && query.trim()) {
    params.set("q", query.trim());
  }
  if (projectId) {
    params.set("projectId", projectId);
  }
  const search = params.toString();
  return api<IssueMentionItem[]>(`/github/issues/recent${search ? `?${search}` : ""}`);
}

/** Search for files matching a query in a workspace. */
export function searchFiles(query: string, workspace?: string, projectId?: string): Promise<FileSearchResult> {
  const params = new URLSearchParams({ q: query });
  if (workspace) {
    params.set("workspace", workspace);
  }
  if (projectId) {
    params.set("projectId", projectId);
  }
  return api<FileSearchResult>(`/files/search?${params.toString()}`);
}

// --- Workspace File Operations API (Create, Copy, Move, Delete, Rename, Download) ---

/** File operation response for create/copy/move/delete/rename operations */
export interface FileOperationResponse {
  success: true;
  message?: string;
  path?: string;
}

/** Create a directory within a workspace. */
export function createWorkspaceDirectory(workspace: string, dirPath: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/mkdir?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ path: dirPath }),
  });
}

/** Create an empty file within a workspace. */
export function createWorkspaceFile(workspace: string, filePath: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ content: "" }),
  });
}

/** Copy a file or directory to a new location within a workspace. */
export function copyFile(workspace: string, filePath: string, destination: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/copy?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ destination }),
  });
}

/** Move a file or directory to a new location within a workspace. */
export function moveFile(workspace: string, filePath: string, destination: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/move?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ destination }),
  });
}

/** Delete a file or directory within a workspace. */
export function deleteFile(workspace: string, filePath: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/delete?${query.toString()}`, {
    method: "POST",
  });
}

/** Rename a file or directory within a workspace. */
export function renameFile(workspace: string, filePath: string, newName: string, projectId?: string): Promise<FileOperationResponse> {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return api<FileOperationResponse>(`/files/${encodeURIComponent(filePath)}/rename?${query.toString()}`, {
    method: "POST",
    body: JSON.stringify({ newName }),
  });
}

/** Get the download URL for a single file in a workspace. */
export function downloadFileUrl(workspace: string, filePath: string, projectId?: string, options?: { inline?: boolean }): string {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  /**
   * FNXC:FileBrowser 2026-06-26-00:00:
   * Browser-native preview consumers request `inline=1` so the shared download route serves renderable MIME types with inline disposition. The explicit Download action intentionally omits this option to preserve attachment downloads.
   */
  if (options?.inline === true) {
    query.set("inline", "1");
  }
  return `/api/files/${encodeURIComponent(filePath)}/download?${query.toString()}`;
}

/** Get the download URL for a folder as ZIP in a workspace. */
export function downloadZipUrl(workspace: string, filePath: string, projectId?: string): string {
  const query = new URLSearchParams({ workspace });
  if (projectId) {
    query.set("projectId", projectId);
  }
  return `/api/files/${encodeURIComponent(filePath)}/download-zip?${query.toString()}`;
}

