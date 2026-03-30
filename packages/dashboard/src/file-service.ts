import { join, resolve, relative, dirname } from "node:path";
import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TaskStore } from "@kb/core";

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

/**
 * Text file extensions set.
 */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".json", ".jsonc",
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm", ".xml", ".svg",
  ".yaml", ".yml",
  ".toml",
  ".ini", ".cfg", ".conf", ".config",
  ".sh", ".bash", ".zsh", ".fish",
  ".py", ".rb", ".php", ".pl", ".perl",
  ".java", ".kt", ".scala", ".groovy",
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh",
  ".cs", ".fs", ".fsx",
  ".go", ".rs", ".swift",
  ".sql",
  ".dockerfile", ".env", ".envrc", ".nvmrc",
  ".gitignore", ".gitattributes", ".editorconfig",
  ".lock", ".log",
]);

/**
 * Binary file extensions set.
 */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svgz",
  ".exe", ".dll", ".so", ".dylib",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".webm", ".mkv", ".flv",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm", ".bin",
]);

/**
 * Check if a file is a binary file based on extension.
 */
function isBinaryFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }
  return false;
}

/**
 * Get the base path for a task's files.
 * Returns the worktree path if it exists, otherwise the task directory.
 */
async function getTaskBasePath(store: TaskStore, taskId: string): Promise<string> {
  try {
    const task = await store.getTask(taskId);
    // Use worktree if available and exists
    if (task.worktree && existsSync(task.worktree)) {
      return resolve(task.worktree);
    }
    // Fall back to task directory
    const rootDir = store.getRootDir();
    return resolve(join(rootDir, ".kb", "tasks", taskId));
  } catch (err: any) {
    if (err.code === "ENOENT" || err.message?.includes("not found")) {
      throw new FileServiceError(`Task ${taskId} not found`, "ENOTASK");
    }
    throw err;
  }
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
  const targetPath = subPath ? validatePath(taskBase, subPath) : taskBase;

  let stats;
  try {
    stats = await stat(targetPath);
  } catch (err: any) {
    if (err.code === "ENOENT") {
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
      // Skip hidden files and directories
      if (entry.name.startsWith(".")) {
        continue;
      }

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

    // Calculate relative path from task base
    const relativeBase = relative(taskBase, targetPath);

    return {
      path: relativeBase || ".",
      entries: fileNodes,
    };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new FileServiceError(`Directory not found: ${subPath || "."}`, "ENOENT");
    }
    if (err.code === "EACCES" || err.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${subPath || "."}`, "EACCES");
    }
    throw err;
  }
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
  if (!filePath) {
    throw new FileServiceError("File path is required", "EINVAL");
  }

  const taskBase = await getTaskBasePath(store, taskId);
  const resolvedPath = validatePath(taskBase, filePath);

  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch (err: any) {
    if (err.code === "ENOENT") {
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

  // Check if it's a binary file
  const basename = filePath.split("/").pop() || filePath;
  if (isBinaryFile(basename)) {
    throw new FileServiceError(`Binary file, cannot edit: ${filePath}`, "EINVAL");
  }

  try {
    const content = await fsReadFile(resolvedPath, "utf-8");

    return {
      content,
      mtime: stats.mtime.toISOString(),
      size: stats.size,
    };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new FileServiceError(`File not found: ${filePath}`, "ENOENT");
    }
    if (err.code === "EACCES" || err.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${filePath}`, "EACCES");
    }
    throw err;
  }
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
  if (!filePath) {
    throw new FileServiceError("File path is required", "EINVAL");
  }

  // Check content size
  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (contentBytes > MAX_FILE_SIZE) {
    throw new FileServiceError(`Content too large: ${contentBytes} bytes (max ${MAX_FILE_SIZE})`, "ETOOLARGE");
  }

  const taskBase = await getTaskBasePath(store, taskId);
  const resolvedPath = validatePath(taskBase, filePath);

  // Check if target is a directory
  try {
    const stats = await stat(resolvedPath);
    if (stats.isDirectory()) {
      throw new FileServiceError(`Cannot write to directory: ${filePath}`, "EISDIR");
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      throw err;
    }
    // File doesn't exist, that's fine for writing
  }

  // Check if parent directory exists
  const parentDir = dirname(resolvedPath);
  try {
    const parentStats = await stat(parentDir);
    if (!parentStats.isDirectory()) {
      throw new FileServiceError(`Parent is not a directory: ${filePath}`, "ENOENT");
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
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
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new FileServiceError(`Parent directory does not exist: ${filePath}`, "ENOENT");
    }
    if (err.code === "EACCES" || err.code === "EPERM") {
      throw new FileServiceError(`Permission denied: ${filePath}`, "EACCES");
    }
    throw err;
  }
}
