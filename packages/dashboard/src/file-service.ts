import { join, resolve, relative, dirname, basename } from "node:path";
import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, stat, copyFile as fsCopyFile, rename as fsRename, rm as fsRm, mkdir, access } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { TaskStore } from "@fusion/core";

/**
 * File node type representing a file or directory entry.
 */
export interface FileNode {
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
}

/**
 * File listing response.
 */
export interface FileListResponse {
  path: string;
  entries: FileNode[];
}

/**
 * File content response.
 */
export interface FileContentResponse {
  content: string;
  mtime: string;
  size: number;
}

/**
 * Save file response.
 */
export interface SaveFileResponse {
  success: true;
  mtime: string;
  size: number;
}

/**
 * File operation response for copy/move/delete/rename operations.
 */
export interface FileOperationResponse {
  success: true;
  message?: string;
}

/**
 * Maximum file size for reading/writing (1MB).
 */
export const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Error class for file service operations.
 */
export class FileServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "FileServiceError";
  }
}

export type WorkspaceId = "project" | string;

/**
 * Get the base path for a task's files.
 * Returns the worktree path if it exists, otherwise the task directory.
 */
async function getTaskBasePath(store: TaskStore, taskId: string): Promise<string> {
  try {
    const task = await store.getTask(taskId);
    // Use worktree if available and exists (check async to avoid blocking event loop)
    if (task.worktree) {
      try {
        await access(task.worktree);
        return resolve(task.worktree);
      } catch {
        // Worktree doesn't exist, fall back to task directory
      }
    }
    // Fall back to task directory
    const rootDir = store.getRootDir();
    return resolve(join(rootDir, ".fusion", "tasks", taskId));
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT" || (error.message && error.message.includes("not found"))) {
      throw new FileServiceError(`Task ${taskId} not found`, "ENOTASK");
    }
    throw err;
  }
}

/**
 * Get the project root path for browsing files.
 * Returns the root directory from the store.
 */
function getProjectBasePath(store: TaskStore): string {
  return resolve(store.getRootDir());
}

/**
 * Resolve a workspace identifier to a filesystem base path.
 *
 * - "project" maps to the dashboard/project root
 * - any other value is treated as a task ID and resolved to that task's worktree/task directory
 */
async function getWorkspaceBasePath(store: TaskStore, workspace: WorkspaceId): Promise<string> {
  if (workspace === "project") {
    return getProjectBasePath(store);
  }

  return getTaskBasePath(store, workspace);
}

/**
 * Validate and resolve a file path to ensure it stays within the allowed directory.
 * Prevents directory traversal attacks.
 */
function validatePath(basePath: string, filePath: string): string {
  // Reject paths with null bytes
  if (filePath.includes("\0")) {
    throw new FileServiceError(`Access denied: Invalid characters in path`, "EINVAL");
  }

  // Decode URL-encoded characters for security check
  const decodedPath = decodeURIComponent(filePath);

  // Reject absolute paths
  if (decodedPath.startsWith("/") || decodedPath.match(/^[a-zA-Z]:/)) {
    throw new FileServiceError(`Access denied: Absolute paths not allowed`, "EINVAL");
  }

  // Resolve the path against base path
  const resolvedBase = resolve(basePath);
  const resolvedPath = resolve(join(resolvedBase, decodedPath));

  // Ensure the resolved path is within the base path
  const relativePath = relative(resolvedBase, resolvedPath);
  
  // Check for traversal - path starts with .. or is outside base
  if (relativePath.startsWith("..") || relativePath.startsWith("../") || relativePath === "..") {
    throw new FileServiceError(`Access denied: Path traversal detected`, "EINVAL");
  }

  // Additional check: ensure resolved path actually starts with base
  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new FileServiceError(`Access denied: Path outside allowed directory`, "EINVAL");
  }

  return resolvedPath;
}

async function listFilesForBasePath(basePath: string, subPath?: string): Promise<FileListResponse> {
  const targetPath = subPath ? validatePath(basePath, subPath) : basePath;

  let stats;
  try {
    stats = await stat(targetPath);
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`Directory not found: ${subPath || "."}`, "ENOENT");
    }
    throw err;
  }

  if (!stats.isDirectory()) {
    throw new FileServiceError(`Not a directory: ${subPath || "."}`, "ENOTDIR");
  }

  try {
    const entries = await readdir(targetPath, { withFileTypes: true });
    const fileNodes: FileNode[] = [];

    for (const entry of entries) {
      const entryPath = join(targetPath, entry.name);
      const entryStats = await stat(entryPath);

      fileNodes.push({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        size: entry.isFile() ? entryStats.size : undefined,
        mtime: entryStats.mtime.toISOString(),
      });
    }

    // Sort: directories first, then files, both alphabetically
    fileNodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    const relativeBase = relative(basePath, targetPath);

    return {
      path: relativeBase || ".",
      entries: fileNodes,
    };
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`Directory not found: ${subPath || "."}`, "ENOENT");
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${subPath || "."}`, "EACCES");
    }
    throw err;
  }
}

async function readFileForBasePath(basePath: string, filePath: string): Promise<FileContentResponse> {
  if (!filePath) {
    throw new FileServiceError("File path is required", "EINVAL");
  }

  const resolvedPath = validatePath(basePath, filePath);

  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`File not found: ${filePath}`, "ENOENT");
    }
    throw err;
  }

  if (!stats.isFile()) {
    throw new FileServiceError(`Not a file: ${filePath}`, "EISDIR");
  }

  if (stats.size > MAX_FILE_SIZE) {
    throw new FileServiceError(`File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`, "ETOOLARGE");
  }

  try {
    const content = await fsReadFile(resolvedPath, "utf-8");

    return {
      content,
      mtime: stats.mtime.toISOString(),
      size: stats.size,
    };
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`File not found: ${filePath}`, "ENOENT");
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${filePath}`, "EACCES");
    }
    throw err;
  }
}

async function writeFileForBasePath(basePath: string, filePath: string, content: string): Promise<SaveFileResponse> {
  if (!filePath) {
    throw new FileServiceError("File path is required", "EINVAL");
  }

  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (contentBytes > MAX_FILE_SIZE) {
    throw new FileServiceError(`Content too large: ${contentBytes} bytes (max ${MAX_FILE_SIZE})`, "ETOOLARGE");
  }

  const resolvedPath = validatePath(basePath, filePath);

  try {
    const stats = await stat(resolvedPath);
    if (stats.isDirectory()) {
      throw new FileServiceError(`Cannot write to directory: ${filePath}`, "EISDIR");
    }
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code !== "ENOENT") {
      throw err;
    }
  }

  const parentDir = dirname(resolvedPath);
  try {
    const parentStats = await stat(parentDir);
    if (!parentStats.isDirectory()) {
      throw new FileServiceError(`Parent is not a directory: ${filePath}`, "ENOENT");
    }
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`Parent directory does not exist: ${filePath}`, "ENOENT");
    }
    throw err;
  }

  try {
    await fsWriteFile(resolvedPath, content, "utf-8");

    const stats = await stat(resolvedPath);
    return {
      success: true,
      mtime: stats.mtime.toISOString(),
      size: stats.size,
    };
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`Parent directory does not exist: ${filePath}`, "ENOENT");
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${filePath}`, "EACCES");
    }
    throw err;
  }
}

/**
 * List files in a task directory or subdirectory.
 *
 * @param store - The TaskStore instance
 * @param taskId - The task ID
 * @param subPath - Optional relative path within the task directory
 * @returns File listing response with entries sorted (dirs first, then files alphabetically)
 * @throws FileServiceError on validation or filesystem errors
 */
export async function listFiles(
  store: TaskStore,
  taskId: string,
  subPath?: string,
): Promise<FileListResponse> {
  const taskBase = await getTaskBasePath(store, taskId);
  return listFilesForBasePath(taskBase, subPath);
}

/**
 * Read file contents from a task directory.
 *
 * @param store - The TaskStore instance
 * @param taskId - The task ID
 * @param filePath - The relative file path
 * @returns File content response with content, mtime, and size
 * @throws FileServiceError on validation or filesystem errors
 */
export async function readFile(
  store: TaskStore,
  taskId: string,
  filePath: string,
): Promise<FileContentResponse> {
  const taskBase = await getTaskBasePath(store, taskId);
  return readFileForBasePath(taskBase, filePath);
}

/**
 * Write file contents to a task directory.
 *
 * @param store - The TaskStore instance
 * @param taskId - The task ID
 * @param filePath - The relative file path
 * @param content - The content to write
 * @returns Save file response with success, mtime, and size
 * @throws FileServiceError on validation or filesystem errors
 */
export async function writeFile(
  store: TaskStore,
  taskId: string,
  filePath: string,
  content: string,
): Promise<SaveFileResponse> {
  const taskBase = await getTaskBasePath(store, taskId);
  return writeFileForBasePath(taskBase, filePath, content);
}

// ── Project File Functions ────────────────────────────────────────

/**
 * List files in the project root directory or subdirectory.
 *
 * @param store - The TaskStore instance
 * @param subPath - Optional relative path within the project directory
 * @returns File listing response with entries sorted (dirs first, then files alphabetically)
 * @throws FileServiceError on validation or filesystem errors
 */
export async function listProjectFiles(
  store: TaskStore,
  subPath?: string,
): Promise<FileListResponse> {
  const projectBase = getProjectBasePath(store);
  return listFilesForBasePath(projectBase, subPath);
}

/**
 * Read file contents from the project directory.
 *
 * @param store - The TaskStore instance
 * @param filePath - The relative file path
 * @returns File content response with content, mtime, and size
 * @throws FileServiceError on validation or filesystem errors
 */
export async function readProjectFile(
  store: TaskStore,
  filePath: string,
): Promise<FileContentResponse> {
  const projectBase = getProjectBasePath(store);
  return readFileForBasePath(projectBase, filePath);
}

/**
 * Write file contents to the project directory.
 *
 * @param store - The TaskStore instance
 * @param filePath - The relative file path
 * @param content - The content to write
 * @returns Save file response with success, mtime, and size
 * @throws FileServiceError on validation or filesystem errors
 */
export async function writeProjectFile(
  store: TaskStore,
  filePath: string,
  content: string,
): Promise<SaveFileResponse> {
  const projectBase = getProjectBasePath(store);
  return writeFileForBasePath(projectBase, filePath, content);
}

/**
 * Workspace-aware file listing used by the top-level dashboard file browser.
 */
export async function listWorkspaceFiles(
  store: TaskStore,
  workspace: WorkspaceId,
  subPath?: string,
): Promise<FileListResponse> {
  const workspaceBase = await getWorkspaceBasePath(store, workspace);
  return listFilesForBasePath(workspaceBase, subPath);
}

/**
 * Workspace-aware file reading used by the top-level dashboard file browser.
 */
export async function readWorkspaceFile(
  store: TaskStore,
  workspace: WorkspaceId,
  filePath: string,
): Promise<FileContentResponse> {
  const workspaceBase = await getWorkspaceBasePath(store, workspace);
  return readFileForBasePath(workspaceBase, filePath);
}

/**
 * Workspace-aware file writing used by the top-level dashboard file browser.
 */
export async function writeWorkspaceFile(
  store: TaskStore,
  workspace: WorkspaceId,
  filePath: string,
  content: string,
): Promise<SaveFileResponse> {
  const workspaceBase = await getWorkspaceBasePath(store, workspace);
  return writeFileForBasePath(workspaceBase, filePath, content);
}

// ── Workspace File Operations (Copy, Move, Delete, Rename) ─────────

/**
 * Validate that both source and destination paths are within the allowed workspace.
 * Prevents copying/moving files outside the workspace boundary.
 */
function validateSourceAndDestination(basePath: string, sourcePath: string, destinationPath: string): { resolvedSource: string; resolvedDest: string } {
  const resolvedSource = validatePath(basePath, sourcePath);
  const resolvedDest = validatePath(basePath, destinationPath);

  // Prevent operating on the workspace root itself
  const sourceRelative = relative(resolve(basePath), resolvedSource);
  if (!sourceRelative || sourceRelative === "." || sourceRelative === "") {
    throw new FileServiceError("Cannot operate on workspace root directory", "EINVAL");
  }

  return { resolvedSource, resolvedDest };
}

/**
 * Copy a file or directory within a workspace.
 *
 * @param store - The TaskStore instance
 * @param workspace - Workspace identifier ("project" or task ID)
 * @param sourcePath - Relative source path within the workspace
 * @param destinationPath - Relative destination path within the workspace
 * @returns FileOperationResponse indicating success
 * @throws FileServiceError on validation or filesystem errors
 */
export async function copyWorkspaceFile(
  store: TaskStore,
  workspace: WorkspaceId,
  sourcePath: string,
  destinationPath: string,
): Promise<FileOperationResponse> {
  if (!sourcePath) {
    throw new FileServiceError("Source path is required", "EINVAL");
  }
  if (!destinationPath) {
    throw new FileServiceError("Destination path is required", "EINVAL");
  }

  const workspaceBase = await getWorkspaceBasePath(store, workspace);
  const { resolvedSource, resolvedDest } = validateSourceAndDestination(workspaceBase, sourcePath, destinationPath);

  // Verify source exists
  let sourceStats;
  try {
    sourceStats = await stat(resolvedSource);
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`Source not found: ${sourcePath}`, "ENOENT");
    }
    throw err;
  }

  // Check destination doesn't already exist
  try {
    await stat(resolvedDest);
    throw new FileServiceError(`Destination already exists: ${destinationPath}`, "EEXIST");
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code !== "ENOENT") {
      if (err instanceof FileServiceError) throw err;
    }
    // ENOENT is expected - destination should not exist
  }

  // Ensure destination parent directory exists
  const destParent = dirname(resolvedDest);
  try {
    const parentStats = await stat(destParent);
    if (!parentStats.isDirectory()) {
      throw new FileServiceError("Destination parent is not a directory", "ENOTDIR");
    }
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError("Destination parent directory does not exist", "ENOENT");
    }
    throw err;
  }

  try {
    if (sourceStats.isFile()) {
      await fsCopyFile(resolvedSource, resolvedDest);
    } else if (sourceStats.isDirectory()) {
      await copyDirectoryRecursive(resolvedSource, resolvedDest);
    }
    return { success: true, message: `Copied "${sourcePath}" to "${destinationPath}"` };
  } catch (err: unknown) {
    const error = err as Error & { code?: string; message?: string };
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${error.message}`, "EACCES");
    }
    throw err;
  }
}

/**
 * Move a file or directory within a workspace.
 *
 * @param store - The TaskStore instance
 * @param workspace - Workspace identifier ("project" or task ID)
 * @param sourcePath - Relative source path within the workspace
 * @param destinationPath - Relative destination path within the workspace
 * @returns FileOperationResponse indicating success
 * @throws FileServiceError on validation or filesystem errors
 */
export async function moveWorkspaceFile(
  store: TaskStore,
  workspace: WorkspaceId,
  sourcePath: string,
  destinationPath: string,
): Promise<FileOperationResponse> {
  if (!sourcePath) {
    throw new FileServiceError("Source path is required", "EINVAL");
  }
  if (!destinationPath) {
    throw new FileServiceError("Destination path is required", "EINVAL");
  }

  const workspaceBase = await getWorkspaceBasePath(store, workspace);
  const { resolvedSource, resolvedDest } = validateSourceAndDestination(workspaceBase, sourcePath, destinationPath);

  // Verify source exists
  try {
    await stat(resolvedSource);
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`Source not found: ${sourcePath}`, "ENOENT");
    }
    throw err;
  }

  // Check destination doesn't already exist
  try {
    await stat(resolvedDest);
    throw new FileServiceError(`Destination already exists: ${destinationPath}`, "EEXIST");
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code !== "ENOENT") {
      if (err instanceof FileServiceError) throw err;
    }
  }

  // Ensure destination parent directory exists
  const destParent = dirname(resolvedDest);
  try {
    const parentStats = await stat(destParent);
    if (!parentStats.isDirectory()) {
      throw new FileServiceError("Destination parent is not a directory", "ENOTDIR");
    }
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError("Destination parent directory does not exist", "ENOENT");
    }
    throw err;
  }

  try {
    await fsRename(resolvedSource, resolvedDest);
    return { success: true, message: `Moved "${sourcePath}" to "${destinationPath}"` };
  } catch (err: unknown) {
    const error = err as Error & { code?: string; message?: string };
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${error.message}`, "EACCES");
    }
    if (error.code === "EXDEV") {
      // Cross-device move: copy then delete
      await copyWorkspaceFile(store, workspace, sourcePath, destinationPath);
      await deleteWorkspaceFile(store, workspace, sourcePath);
      return { success: true, message: `Moved "${sourcePath}" to "${destinationPath}"` };
    }
    throw err;
  }
}

/**
 * Delete a file or directory within a workspace.
 * Directories are deleted recursively.
 *
 * @param store - The TaskStore instance
 * @param workspace - Workspace identifier ("project" or task ID)
 * @param filePath - Relative file/directory path within the workspace
 * @returns FileOperationResponse indicating success
 * @throws FileServiceError on validation or filesystem errors
 */
export async function deleteWorkspaceFile(
  store: TaskStore,
  workspace: WorkspaceId,
  filePath: string,
): Promise<FileOperationResponse> {
  if (!filePath) {
    throw new FileServiceError("File path is required", "EINVAL");
  }

  const workspaceBase = await getWorkspaceBasePath(store, workspace);
  const resolvedPath = validatePath(workspaceBase, filePath);

  // Prevent operating on the workspace root itself
  const relativePath = relative(resolve(workspaceBase), resolvedPath);
  if (!relativePath || relativePath === "." || relativePath === "") {
    throw new FileServiceError("Cannot delete workspace root directory", "EINVAL");
  }

  // Verify the file/directory exists
  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`Not found: ${filePath}`, "ENOENT");
    }
    throw err;
  }

  try {
    if (stats.isDirectory()) {
      await fsRm(resolvedPath, { recursive: true });
    } else {
      await fsRm(resolvedPath);
    }
    return { success: true, message: `Deleted "${filePath}"` };
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${filePath}`, "EACCES");
    }
    throw err;
  }
}

/**
 * Rename a file or directory within a workspace.
 * The new name must not contain path separators.
 *
 * @param store - The TaskStore instance
 * @param workspace - Workspace identifier ("project" or task ID)
 * @param filePath - Relative file/directory path within the workspace
 * @param newName - New name for the file/directory (no path separators)
 * @returns FileOperationResponse indicating success
 * @throws FileServiceError on validation or filesystem errors
 */
export async function renameWorkspaceFile(
  store: TaskStore,
  workspace: WorkspaceId,
  filePath: string,
  newName: string,
): Promise<FileOperationResponse> {
  if (!filePath) {
    throw new FileServiceError("File path is required", "EINVAL");
  }
  if (!newName || !newName.trim()) {
    throw new FileServiceError("New name is required", "EINVAL");
  }

  // Reject new names with path separators
  if (newName.includes("/") || newName.includes("\\") || newName.includes("\0")) {
    throw new FileServiceError("New name must not contain path separators", "EINVAL");
  }

  const workspaceBase = await getWorkspaceBasePath(store, workspace);
  const resolvedPath = validatePath(workspaceBase, filePath);

  // Prevent operating on the workspace root itself
  const relativePath = relative(resolve(workspaceBase), resolvedPath);
  if (!relativePath || relativePath === "." || relativePath === "") {
    throw new FileServiceError("Cannot rename workspace root directory", "EINVAL");
  }

  // Verify source exists
  try {
    await stat(resolvedPath);
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`Not found: ${filePath}`, "ENOENT");
    }
    throw err;
  }

  // Build destination path by replacing the basename
  const destPath = join(dirname(resolvedPath), newName);

  // Validate destination stays within workspace
  const destRelative = relative(resolve(workspaceBase), destPath);
  if (destRelative.startsWith("..") || destRelative.startsWith("../") || destRelative === "..") {
    throw new FileServiceError("Destination would be outside workspace", "EINVAL");
  }

  if (!destPath.startsWith(resolve(workspaceBase))) {
    throw new FileServiceError("Destination would be outside workspace", "EINVAL");
  }

  // Check destination doesn't already exist
  try {
    await stat(destPath);
    throw new FileServiceError(`A file or directory named "${newName}" already exists`, "EEXIST");
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code !== "ENOENT") {
      if (err instanceof FileServiceError) throw err;
    }
  }

  try {
    await fsRename(resolvedPath, destPath);
    return { success: true, message: `Renamed to "${newName}"` };
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${filePath}`, "EACCES");
    }
    throw err;
  }
}

/**
 * Get the absolute path for a file to download, along with file stats.
 * Used by the download endpoint to create a stream response.
 *
 * @param store - The TaskStore instance
 * @param workspace - Workspace identifier ("project" or task ID)
 * @param filePath - Relative file path within the workspace
 * @returns Object with resolved absolute path, stats, and basename
 * @throws FileServiceError on validation or filesystem errors
 */
export async function getWorkspaceFileForDownload(
  store: TaskStore,
  workspace: WorkspaceId,
  filePath: string,
): Promise<{ absolutePath: string; stats: { size: number; mtime: Date; isFile: boolean }; fileName: string }> {
  if (!filePath) {
    throw new FileServiceError("File path is required", "EINVAL");
  }

  const workspaceBase = await getWorkspaceBasePath(store, workspace);
  const resolvedPath = validatePath(workspaceBase, filePath);

  // Prevent downloading the workspace root itself (it's not a file)
  const relativePath = relative(resolve(workspaceBase), resolvedPath);
  if (!relativePath || relativePath === "." || relativePath === "") {
    throw new FileServiceError("Cannot download workspace root", "EINVAL");
  }

  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`File not found: ${filePath}`, "ENOENT");
    }
    throw err;
  }

  if (!stats.isFile()) {
    throw new FileServiceError(`Not a file: ${filePath}`, "EISDIR");
  }

  return {
    absolutePath: resolvedPath,
    stats: {
      size: stats.size,
      mtime: stats.mtime,
      isFile: true,
    },
    fileName: basename(resolvedPath),
  };
}

/**
 * Get the absolute path for a folder to download as ZIP.
 *
 * @param store - The TaskStore instance
 * @param workspace - Workspace identifier ("project" or task ID)
 * @param dirPath - Relative directory path within the workspace
 * @returns Object with resolved absolute path and directory name
 * @throws FileServiceError on validation or filesystem errors
 */
export async function getWorkspaceFolderForZip(
  store: TaskStore,
  workspace: WorkspaceId,
  dirPath: string,
): Promise<{ absolutePath: string; dirName: string }> {
  if (!dirPath) {
    throw new FileServiceError("Directory path is required", "EINVAL");
  }

  const workspaceBase = await getWorkspaceBasePath(store, workspace);
  const resolvedPath = validatePath(workspaceBase, dirPath);

  // Prevent downloading the workspace root as ZIP (too broad)
  const relativePath = relative(resolve(workspaceBase), resolvedPath);
  if (!relativePath || relativePath === "." || relativePath === "") {
    throw new FileServiceError("Cannot download workspace root as ZIP", "EINVAL");
  }

  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new FileServiceError(`Directory not found: ${dirPath}`, "ENOENT");
    }
    throw err;
  }

  if (!stats.isDirectory()) {
    throw new FileServiceError(`Not a directory: ${dirPath}`, "ENOTDIR");
  }

  return {
    absolutePath: resolvedPath,
    dirName: basename(resolvedPath),
  };
}

/**
 * File search result.
 */
export interface FileSearchResult {
  files: Array<{ path: string; name: string }>;
}

/**
 * Markdown file metadata discovered in the project root.
 */
export interface MarkdownFileEntry {
  path: string;
  name: string;
  size: number;
  mtime: string;
}

/**
 * Response payload for project markdown file listing.
 */
export interface MarkdownFileListResponse {
  files: MarkdownFileEntry[];
}

export interface ScannedMarkdownFileEntry extends MarkdownFileEntry {
  contentPreview: string;
}

const MARKDOWN_SCAN_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".fusion",
  "dist",
  "build",
  "__pycache__",
  ".next",
  ".cache",
  "coverage",
  ".turbo",
  ".parcel-cache",
  ".vercel",
]);

interface ListProjectMarkdownFilesOptions {
  showHidden?: boolean;
}

function isHiddenPathSegment(name: string): boolean {
  return name.startsWith(".");
}

async function walkDirForMarkdown(
  basePath: string,
  currentRelative: string,
  results: MarkdownFileEntry[],
  options: ListProjectMarkdownFilesOptions,
): Promise<void> {
  const currentPath = currentRelative ? join(basePath, currentRelative) : basePath;

  let entries: Dirent[];
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryRelativePath = currentRelative
      ? join(currentRelative, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      if (MARKDOWN_SCAN_EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      if (!options.showHidden && isHiddenPathSegment(entry.name)) {
        continue;
      }

      await walkDirForMarkdown(basePath, entryRelativePath, results, options);
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }

    if (!options.showHidden && isHiddenPathSegment(entry.name)) {
      continue;
    }

    const fullPath = join(basePath, entryRelativePath);

    let fileStats;
    try {
      fileStats = await stat(fullPath);
    } catch {
      continue;
    }

    if (!fileStats.isFile()) {
      continue;
    }

    results.push({
      path: entryRelativePath.replace(/\\/g, "/"),
      name: entry.name,
      size: fileStats.size,
      mtime: fileStats.mtime.toISOString(),
    });
  }
}

export async function listProjectMarkdownFiles(
  store: TaskStore,
  options?: ListProjectMarkdownFilesOptions,
): Promise<MarkdownFileListResponse> {
  const projectBasePath = getProjectBasePath(store);
  const files: MarkdownFileEntry[] = [];

  await walkDirForMarkdown(projectBasePath, "", files, {
    showHidden: options?.showHidden ?? false,
  });

  files.sort((a, b) => a.path.localeCompare(b.path));

  return { files };
}

/**
 * Recursively scan the project directory for Markdown files.
 */
export async function scanMarkdownFiles(
  store: TaskStore,
  options?: { maxDepth?: number; maxFileSize?: number },
): Promise<ScannedMarkdownFileEntry[]> {
  const projectBasePath = getProjectBasePath(store);
  const maxDepth = options?.maxDepth ?? 5;
  const maxFileSize = options?.maxFileSize ?? MAX_FILE_SIZE;
  const markdownFiles: ScannedMarkdownFileEntry[] = [];

  async function walkDirectory(relativeDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    const directoryPath = relativeDir
      ? validatePath(projectBasePath, relativeDir)
      : projectBasePath;

    let entries: Dirent[];
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "ENOENT") {
        console.warn(
          `[scanMarkdownFiles] failed to read directory ${directoryPath}: ${error.message ?? String(err)}`,
        );
      }
      return;
    }

    for (const entry of entries) {
      const entryRelativePath = relativeDir
        ? join(relativeDir, entry.name)
        : entry.name;

      let shouldRecurse = entry.isDirectory();

      if (!shouldRecurse && typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) {
        let symlinkPath: string;
        try {
          symlinkPath = validatePath(projectBasePath, entryRelativePath);
        } catch {
          continue;
        }

        try {
          const symlinkStats = await stat(symlinkPath);
          shouldRecurse = symlinkStats.isDirectory();
        } catch {
          continue;
        }
      }

      if (shouldRecurse) {
        if (MARKDOWN_SCAN_EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }

        if (depth < maxDepth) {
          await walkDirectory(entryRelativePath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }

      let resolvedPath: string;
      try {
        resolvedPath = validatePath(projectBasePath, entryRelativePath);
      } catch {
        continue;
      }

      let entryStats;
      try {
        entryStats = await stat(resolvedPath);
      } catch {
        continue;
      }

      if (!entryStats.isFile() || entryStats.size > maxFileSize) {
        continue;
      }

      let contentPreview = "";
      try {
        const content = await fsReadFile(resolvedPath, "utf-8");
        contentPreview = content.slice(0, 200);
      } catch {
        contentPreview = "";
      }

      markdownFiles.push({
        path: entryRelativePath.replace(/\\/g, "/"),
        name: entry.name,
        size: entryStats.size,
        mtime: entryStats.mtime.toISOString(),
        contentPreview,
      });
    }
  }

  await walkDirectory("", 0);

  markdownFiles.sort((a, b) => a.path.localeCompare(b.path));

  return markdownFiles;
}

/**
 * Search for files matching a query in a workspace.
 *
 * @param store - The TaskStore instance
 * @param workspace - The workspace identifier ("project" or task ID)
 * @param query - Case-insensitive substring match on filename
 * @returns File search results with path and name
 * @throws FileServiceError on validation or filesystem errors
 */
export async function searchWorkspaceFiles(
  store: TaskStore,
  workspace: WorkspaceId,
  query: string,
): Promise<FileSearchResult> {
  const workspaceBase = await getWorkspaceBasePath(store, workspace);

  // Excluded directories that should not be traversed
  const EXCLUDED_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    ".fusion",
    "__pycache__",
    ".next",
    ".cache",
  ]);

  const MAX_RESULTS = 50;
  const results: Array<{ path: string; name: string }> = [];
  const lowerQuery = query.toLowerCase();

  async function walkDir(dir: string, relativeDir: string): Promise<void> {
    if (results.length >= MAX_RESULTS) return;

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Skip inaccessible directories
    }

    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;

      // Skip excluded directories
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name as string)) {
        continue;
      }

      const fullPath = join(dir, entry.name);
      const relPath = join(relativeDir, entry.name);

      if (entry.isFile()) {
        // Case-insensitive substring match on filename
        if ((entry.name as string).toLowerCase().includes(lowerQuery)) {
          results.push({
            path: relPath.replace(/\\/g, "/"), // Normalize backslashes for cross-platform
            name: entry.name as string,
          });
        }
      } else if (entry.isDirectory()) {
        await walkDir(fullPath, relPath);
      }
    }
  }

  await walkDir(workspaceBase, "");

  return { files: results };
}

/**
 * Recursively copy a directory and all its contents.
 */
async function copyDirectoryRecursive(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destPath = join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, destPath);
    } else {
      await fsCopyFile(sourcePath, destPath);
    }
  }
}
