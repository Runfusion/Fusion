import { access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname } from "node:path";
import type { Request } from "express";
import { ApiError, badRequest } from "../api-error.js";
import {
  copyWorkspaceFile,
  createWorkspaceDirectory,
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


function extractFileParams(req: Request): { filePath: string; workspace: string } {
  const filePath = Array.isArray(req.params.filepath) ? req.params.filepath[0] : req.params.filepath ?? "";
  const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
    ? req.query.workspace
    : "project";
  return { filePath, workspace };
}

/*
FNXC:FileBrowser 2026-06-26-00:00:
The server-side preview MIME map must stay aligned with `packages/dashboard/app/utils/file-preview-kind.ts` so every browser-previewable extension rendered by the file viewer has exactly one safe inline content type, while all unknown extensions keep attachment semantics.
*/
const INLINE_PREVIEW_CONTENT_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
  [".svgz", "image/svg+xml"],
  [".avif", "image/avif"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".ogg", "video/ogg"],
  [".ogv", "video/ogg"],
  [".mov", "video/quicktime"],
  [".m4v", "video/x-m4v"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".oga", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".opus", "audio/opus"],
  [".pdf", "application/pdf"],
]);

function isInlinePreviewRequest(req: Request): boolean {
  return req.query.inline === "1" || req.query.inline === "true";
}

function getInlinePreviewContentType(filePath: string): string | null {
  return INLINE_PREVIEW_CONTENT_TYPES.get(extname(filePath).toLowerCase()) ?? null;
}

/**
 * Registers task-file, workspace-file, and changed-file routes.
 *
 * Ordering is critical: operation routes (copy/move/delete/rename/download)
 * must be registered before the generic wildcard write route
 * (`POST /files/{*filepath}`), otherwise Express will route operation suffixes
 * as a generic filepath.
 */
export function registerFileWorkspaceRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

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
      const inlineContentType = isInlinePreviewRequest(req) ? getInlinePreviewContentType(filePath) : null;

      /*
      FNXC:FileBrowser 2026-06-26-00:00:
      File previews opt into inline rendering and receive a renderable MIME type plus `nosniff` and a sandbox CSP so SVG/markup bytes cannot execute on the dashboard origin. The Download button and unrecognized extensions stay on attachment + octet-stream semantics.
      */
      if (inlineContentType) {
        res.setHeader("Content-Type", inlineContentType);
        res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "sandbox");
      } else {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      }
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

  // MUST stay after operation routes so suffix routes like /download are not captured as file paths.
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
  router.post("/files/mkdir", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const workspace = typeof req.query.workspace === "string" && req.query.workspace.length > 0
        ? req.query.workspace
        : "project";
      const { path } = req.body;

      if (!path || typeof path !== "string") {
        throw badRequest("path is required and must be a string");
      }

      const result = await createWorkspaceDirectory(scopedStore, workspace, path);
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

  // Must remain after copy/move/delete/rename/download/mkdir routes.
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
