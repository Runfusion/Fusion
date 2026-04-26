import { access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Request } from "express";
import type { Task } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import {
  copyWorkspaceFile,
  deleteWorkspaceFile,
  FileServiceError,
  getWorkspaceFileForDownload,
  getWorkspaceFolderForZip,
  listFiles,
  listProjectMarkdownFiles,
  listWorkspaceFiles,
  moveWorkspaceFile,
  readFile,
  readWorkspaceFile,
  renameWorkspaceFile,
  scanMarkdownFiles,
  searchWorkspaceFiles,
  type MarkdownFileListResponse,
  writeFile,
  writeWorkspaceFile,
} from "../file-service.js";
import type { ApiRoutesContext } from "./types.js";

interface FileWorkspaceRouteDeps {
  runGitCommand: (args: string[], cwd: string, timeoutMs: number) => Promise<string>;
  resolveDiffBase: (task: Task, cwd: string) => Promise<string | undefined>;
}

const sessionFilesCache = new Map<string, { files: string[]; expiresAt: number }>();
const fileDiffsCache = new Map<
  string,
  {
    files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; diff: string; oldPath?: string }>;
    expiresAt: number;
  }
>();

function extractFileParams(req: Request): { filePath: string; workspace: string } {
  const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
  const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
    ? req.query.workspace
    : "project";
  return { filePath, workspace };
}

/**
 * Registers task-file, workspace-file, and changed-file routes.
 *
 * Ordering is critical: operation routes (copy/move/delete/rename/download)
 * must be registered before the generic wildcard write route
 * (`POST /files/{*filepath}`), otherwise Express will route operation suffixes
 * as a generic filepath.
 */
export function registerFileWorkspaceRoutes(ctx: ApiRoutesContext, deps: FileWorkspaceRouteDeps): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;
  const { runGitCommand, resolveDiffBase } = deps;

  // ── Task file routes ──────────────────────────────────────────────
  router.get("/tasks/:id/files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { path: subPath } = req.query;
      const result = await listFiles(scopedStore, req.params.id, typeof subPath === "string" ? subPath : undefined);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/tasks/:id/files/{*filepath}", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const result = await readFile(scopedStore, req.params.id, filePath);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const errorWithCode = err as NodeJS.ErrnoException;
        const status = errorWithCode.code === "ENOENT" ? 404
          : err.code === "ENOTASK" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : err.code === "EINVAL" && (err instanceof Error ? err.message : String(err)).includes("Binary file") ? 415
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.post("/tasks/:id/files/{*filepath}", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const { content } = req.body;

      if (typeof content !== "string") {
        throw badRequest("content is required and must be a string");
      }

      const result = await writeFile(scopedStore, req.params.id, filePath, content);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const errorWithCode = err as NodeJS.ErrnoException;
        const status = errorWithCode.code === "ENOENT" ? 404
          : err.code === "ENOTASK" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  // ── Workspace discovery routes ────────────────────────────────────
  router.get("/workspaces", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });

      const worktreeCheckPromises = tasks.map(async (task): Promise<{ id: string; title?: string; worktree: string } | null> => {
        if (typeof task.worktree !== "string" || task.worktree.length === 0) {
          return null;
        }
        try {
          await access(task.worktree);
          return {
            id: task.id,
            title: task.title,
            worktree: task.worktree,
          };
        } catch {
          return null;
        }
      });

      const workspaceTasks = (await Promise.all(worktreeCheckPromises)).filter(
        (task): task is { id: string; title?: string; worktree: string } => task !== null,
      );

      res.json({
        project: scopedStore.getRootDir(),
        tasks: workspaceTasks,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  // ── Workspace file routes ─────────────────────────────────────────
  router.get("/files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { path: subPath, workspace } = req.query;
      const workspaceId = typeof workspace === "string" && workspace.length > 0 ? workspace : "project";
      const result = await listWorkspaceFiles(scopedStore, workspaceId, typeof subPath === "string" ? subPath : undefined);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/files/markdown-list", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const showHiddenQuery = req.query.showHidden;
      const showHidden = showHiddenQuery === "1" || showHiddenQuery === "true";
      const result: MarkdownFileListResponse = await listProjectMarkdownFiles(scopedStore, { showHidden });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/files/search", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const q = req.query.q;

      if (!q || typeof q !== "string" || q.trim().length === 0) {
        throw new ApiError(400, "Query parameter 'q' is required and must be a non-empty string");
      }

      const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
        ? req.query.workspace
        : "project";

      const result = await searchWorkspaceFiles(scopedStore, workspace, q);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/files/{*filepath}", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
        ? req.query.workspace
        : "project";
      const result = await readWorkspaceFile(scopedStore, workspace, filePath);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : err.code === "EINVAL" && (err instanceof Error ? err.message : String(err)).includes("Binary file") ? 415
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  // MUST be before generic wildcard write route.
  router.post("/files/{*filepath}/copy", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { destination } = req.body;

      if (!destination || typeof destination !== "string") {
        throw badRequest("destination is required and must be a string");
      }

      const result = await copyWorkspaceFile(scopedStore, workspace, filePath, destination);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.post("/files/{*filepath}/move", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { destination } = req.body;

      if (!destination || typeof destination !== "string") {
        throw badRequest("destination is required and must be a string");
      }

      const result = await moveWorkspaceFile(scopedStore, workspace, filePath, destination);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.post("/files/{*filepath}/delete", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const result = await deleteWorkspaceFile(scopedStore, workspace, filePath);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.post("/files/{*filepath}/rename", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { newName } = req.body;

      if (!newName || typeof newName !== "string") {
        throw badRequest("newName is required and must be a string");
      }

      const result = await renameWorkspaceFile(scopedStore, workspace, filePath, newName);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EEXIST" ? 409
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/files/{*filepath}/download", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { absolutePath, stats, fileName } = await getWorkspaceFileForDownload(scopedStore, workspace, filePath);

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Last-Modified", stats.mtime.toUTCString());

      const stream = createReadStream(absolutePath);
      stream.pipe(res);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EISDIR" ? 400
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/files/{*filepath}/download-zip", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { filePath, workspace } = extractFileParams(req);
      const { absolutePath, dirName } = await getWorkspaceFolderForZip(scopedStore, workspace, filePath);

      const archiver = await import("archiver");
      const archive = archiver.default("zip", { zlib: { level: 6 } });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${dirName}.zip"`);

      archive.pipe(res);
      archive.directory(absolutePath, dirName);
      await archive.finalize();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "ENOTDIR" ? 400
          : err.code === "EACCES" ? 403
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  // Must remain after copy/move/delete/rename/download routes.
  router.post("/files/{*filepath}", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
      const { content } = req.body;
      const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
        ? req.query.workspace
        : "project";

      if (typeof content !== "string") {
        throw badRequest("content is required and must be a string");
      }

      const result = await writeWorkspaceFile(scopedStore, workspace, filePath, content);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof FileServiceError) {
        const status = err.code === "ENOTASK" ? 404
          : err.code === "ENOENT" ? 404
          : err.code === "EACCES" ? 403
          : err.code === "ETOOLARGE" ? 413
          : 400;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  // ── Session/changed-file routes ────────────────────────────────────
  router.get("/tasks/:id/session-files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      if (!task.worktree) {
        res.json([]);
        return;
      }

      let worktreeExists = false;
      try {
        await access(task.worktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }

      if (!worktreeExists) {
        res.json([]);
        return;
      }

      const worktree = task.worktree;
      const cached = sessionFilesCache.get(task.id);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.files);
        return;
      }

      let files: string[] = [];
      try {
        const fileSet = new Set<string>();
        const baseRef = await resolveDiffBase(task, worktree);

        if (baseRef) {
          const committedOutput = (await runGitCommand(["diff", "--name-only", `${baseRef}..HEAD`], worktree, 5000)).trim();
          for (const file of committedOutput.split("\n").filter(Boolean)) {
            fileSet.add(file);
          }
        }

        const stagedOutput = (await runGitCommand(["diff", "--cached", "--name-only"], worktree, 5000)).trim();
        for (const file of stagedOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        const workingTreeOutput = (await runGitCommand(["diff", "--name-only"], worktree, 5000)).trim();
        for (const file of workingTreeOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        const untrackedOutput = (await runGitCommand(["ls-files", "--others", "--exclude-standard"], worktree, 5000)).trim();
        for (const file of untrackedOutput.split("\n").filter(Boolean)) {
          fileSet.add(file);
        }

        files = Array.from(fileSet);
      } catch {
        files = [];
      }

      sessionFilesCache.set(task.id, {
        files,
        expiresAt: Date.now() + 10000,
      });

      res.json(files);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/tasks/:id/file-diffs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      if (task.column === "done" && task.mergeDetails?.commitSha) {
        const rootDir = scopedStore.getRootDir();
        const sha = task.mergeDetails.commitSha;

        let mergeBase: string | undefined;

        try {
          mergeBase = (await runGitCommand(["rev-parse", `${sha}^`], rootDir, 5000)).trim();
        } catch {
          res.json([]);
          return;
        }

        try {
          const nameStatus = (await runGitCommand(["diff", "--name-status", `${mergeBase}..${sha}`], rootDir, 5000)).trim();
          const doneFiles = [];
          for (const line of nameStatus.split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            const statusCode = parts[0] ?? "M";
            const filePath = parts[1] ?? "";
            let status: "added" | "modified" | "deleted" | "renamed" = "modified";
            if (statusCode.startsWith("A")) status = "added";
            else if (statusCode.startsWith("D")) status = "deleted";
            else if (statusCode.startsWith("R")) status = "renamed";
            let diff = "";
            try {
              diff = await runGitCommand(["diff", `${mergeBase}..${sha}`, "--", filePath], rootDir, 5000);
            } catch {
              // ignore per-file diff failures
            }
            doneFiles.push({ path: filePath, status, diff });
          }
          res.json(doneFiles);
        } catch {
          res.json([]);
        }
        return;
      }

      if (task.column === "done") {
        res.json([]);
        return;
      }

      if (!task.worktree) {
        res.json([]);
        return;
      }

      let worktreeExists = false;
      try {
        await access(task.worktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }

      if (!worktreeExists) {
        res.json([]);
        return;
      }

      const worktree = task.worktree;
      const cached = fileDiffsCache.get(task.id);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.files);
        return;
      }

      const cwd = worktree;
      const diffBase = await resolveDiffBase(task, cwd);
      const fileMap = new Map<string, { statusCode: string; oldPath?: string; isUntracked?: boolean }>();

      if (diffBase) {
        try {
          const committedOutput = (await runGitCommand(["diff", "--name-status", `${diffBase}..HEAD`], cwd, 5000)).trim();
          for (const line of committedOutput.split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            const statusCode = parts[0] ?? "M";
            if (statusCode.startsWith("R")) {
              fileMap.set(parts[2] ?? parts[1] ?? "", { statusCode, oldPath: parts[1] });
            } else {
              fileMap.set(parts[1] ?? "", { statusCode });
            }
          }
        } catch {
          // continue with working-tree-only changes
        }
      }

      try {
        const stagedOutput = (await runGitCommand(["diff", "--cached", "--name-status"], cwd, 5000)).trim();
        for (const line of stagedOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const statusCode = parts[0] ?? "M";
          const filePath = parts[1] ?? "";
          if (filePath && !fileMap.has(filePath)) {
            if (statusCode.startsWith("R")) {
              fileMap.set(filePath, { statusCode, oldPath: parts[2] });
            } else {
              fileMap.set(filePath, { statusCode });
            }
          }
        }
      } catch {
        // ignore staged diff failures
      }

      try {
        const workingTreeOutput = (await runGitCommand(["diff", "--name-status"], cwd, 5000)).trim();
        for (const line of workingTreeOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const statusCode = parts[0] ?? "M";
          const filePath = parts[1] ?? "";
          if (filePath && !fileMap.has(filePath)) {
            if (statusCode.startsWith("R")) {
              fileMap.set(filePath, { statusCode, oldPath: parts[2] });
            } else {
              fileMap.set(filePath, { statusCode });
            }
          }
        }
      } catch {
        // ignore unstaged diff failures
      }

      try {
        const untrackedOutput = (await runGitCommand(["ls-files", "--others", "--exclude-standard"], cwd, 5000)).trim();
        for (const line of untrackedOutput.split("\n").filter(Boolean)) {
          if (line && !fileMap.has(line)) {
            fileMap.set(line, { statusCode: "U", isUntracked: true });
          }
        }
      } catch {
        // ignore untracked listing failures
      }

      const diffRange = diffBase ? `${diffBase}..HEAD` : "HEAD";
      const files = [];

      for (const [filePath, { statusCode, oldPath, isUntracked }] of fileMap.entries()) {
        let status: "added" | "modified" | "deleted" | "renamed" = "modified";

        if (statusCode.startsWith("A") || statusCode === "U") {
          status = "added";
        } else if (statusCode.startsWith("D")) {
          status = "deleted";
        } else if (statusCode.startsWith("R")) {
          status = "renamed";
        }

        let diff = "";
        try {
          if (isUntracked) {
            diff = await runGitCommand(["diff", "--no-index", "/dev/null", filePath], cwd, 5000).catch(() => "");
          } else {
            diff = await runGitCommand(["diff", diffRange, "--", filePath], cwd, 5000);
          }
        } catch {
          diff = "";
        }

        if (!diff && !isUntracked) {
          continue;
        }

        files.push(oldPath ? { path: filePath, status, diff, oldPath } : { path: filePath, status, diff });
      }

      fileDiffsCache.set(task.id, {
        files,
        expiresAt: Date.now() + 10000,
      });

      res.json(files);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });

  router.get("/project-files/md", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const files = await scanMarkdownFiles(scopedStore);
      const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

      const filteredFiles = query.length > 0
        ? files.filter((file) => file.name.toLowerCase().includes(query) || file.contentPreview.toLowerCase().includes(query))
        : files;

      res.json(filteredFiles);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Internal server error");
    }
  });
}
