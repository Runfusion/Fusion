import { access } from "node:fs/promises";
import type { Request, Router } from "express";
import { ApiError, notFound, rethrowAsApiError } from "../api-error.js";
import { resolveDiffBase, runGitCommand } from "./resolve-diff-base.js";
import type { ProjectContext } from "./types.js";

export interface SessionDiffRouteDeps {
  getProjectContext: (req: Request) => Promise<ProjectContext>;
}

/**
 * Confirm the worktree's current branch still matches the task's recorded
 * branch. Worktrees from the recycle pool can be reassigned to a different
 * task after a merge; without this check the diff endpoints would happily
 * read another task's branch state and surface its commits as the original
 * task's "files changed" list. Returns true when no validation is possible
 * (e.g. task.branch was never set) so we don't break tests/legacy tasks.
 */
async function worktreeStillBelongsToTask(
  worktree: string,
  expectedBranch: string | undefined | null,
): Promise<boolean> {
  if (!expectedBranch) return true;
  try {
    const actual = (await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], worktree, 5000)).trim();
    if (!actual || actual === "HEAD") return true; // detached HEAD — can't validate
    return actual === expectedBranch;
  } catch {
    return true; // best-effort: never block diff just because rev-parse failed
  }
}

const sessionFilesCache = new Map<string, { files: string[]; expiresAt: number }>();
const fileDiffsCache = new Map<
  string,
  {
    files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; diff: string; oldPath?: string }>;
    expiresAt: number;
  }
>();

/**
 * Registers task session-file and diff routes.
 *
 * Endpoints:
 * - GET /tasks/:id/session-files
 * - GET /tasks/:id/diff
 * - GET /tasks/:id/file-diffs
 */
export function registerSessionDiffRoutes(router: Router, deps: SessionDiffRouteDeps): void {
  const { getProjectContext } = deps;

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
      if (!(await worktreeStillBelongsToTask(worktree, task.branch))) {
        // Pool likely reassigned this path to another task — return empty
        // rather than diffing against a foreign branch's HEAD.
        res.json([]);
        return;
      }
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

  router.get("/tasks/:id/diff", async (req, res) => {
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
          res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
          return;
        }

        const nameStatus = (await runGitCommand(["diff", "--name-status", `${mergeBase}..${sha}`], rootDir, 10000)).trim();

        const doneFiles: Array<{
          path: string;
          status: "added" | "modified" | "deleted";
          additions: number;
          deletions: number;
          patch: string;
        }> = [];

        for (const line of nameStatus.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const statusCode = parts[0] ?? "M";
          const filePath = parts[1] ?? "";
          if (!filePath) continue;

          let status: "added" | "modified" | "deleted" = "modified";
          if (statusCode.startsWith("A")) status = "added";
          else if (statusCode.startsWith("D")) status = "deleted";

          let patch = "";
          try {
            patch = await runGitCommand(["diff", `${mergeBase}..${sha}`, "--", filePath], rootDir, 10000);
          } catch {
            // ignore
          }

          const additions = (patch.match(/^\+[^+]/gm) || []).length;
          const deletions = (patch.match(/^-[^-]/gm) || []).length;
          doneFiles.push({ path: filePath, status, additions, deletions, patch });
        }

        const doneStats = {
          filesChanged: doneFiles.length,
          additions: doneFiles.reduce((s, f) => s + f.additions, 0),
          deletions: doneFiles.reduce((s, f) => s + f.deletions, 0),
        };

        res.json({ files: doneFiles, stats: doneStats });
        return;
      }

      if (task.column === "done") {
        const md = task.mergeDetails;
        res.json({
          files: [],
          stats: {
            filesChanged: md?.filesChanged ?? 0,
            additions: md?.insertions ?? 0,
            deletions: md?.deletions ?? 0,
          },
        });
        return;
      }

      const worktree = typeof req.query.worktree === "string" ? req.query.worktree : undefined;
      const resolvedWorktree = worktree || task.worktree;

      if (!resolvedWorktree) {
        res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
        return;
      }
      let worktreeExists = false;
      try {
        await access(resolvedWorktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }
      if (!worktreeExists) {
        res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
        return;
      }
      if (!(await worktreeStillBelongsToTask(resolvedWorktree, task.branch))) {
        res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
        return;
      }
      const cwd = resolvedWorktree;

      const diffBase = await resolveDiffBase(task, cwd);
      const diffRange = diffBase ? `${diffBase}..HEAD` : "HEAD";

      const fileMap = new Map<string, string>();

      if (diffBase) {
        try {
          const committedOutput = (await runGitCommand(["diff", "--name-status", `${diffBase}..HEAD`], cwd, 10000)).trim();
          for (const line of committedOutput.split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            fileMap.set(parts[1] ?? "", parts[0] ?? "M");
          }
        } catch {
          // committed diff failed
        }
      }

      try {
        const stagedOutput = (await runGitCommand(["diff", "--cached", "--name-status"], cwd, 10000)).trim();
        for (const line of stagedOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const filePath = parts[1] ?? "";
          if (filePath && !fileMap.has(filePath)) {
            fileMap.set(filePath, parts[0] ?? "M");
          }
        }
      } catch {
        // staged diff failed
      }

      try {
        const workingTreeOutput = (await runGitCommand(["diff", "--name-status"], cwd, 10000)).trim();
        for (const line of workingTreeOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const filePath = parts[1] ?? "";
          if (filePath && !fileMap.has(filePath)) {
            fileMap.set(filePath, parts[0] ?? "M");
          }
        }
      } catch {
        // working tree diff failed
      }

      try {
        const untrackedOutput = (await runGitCommand(["ls-files", "--others", "--exclude-standard"], cwd, 10000)).trim();
        for (const line of untrackedOutput.split("\n").filter(Boolean)) {
          fileMap.set(line, "U");
        }
      } catch {
        // untracked listing failed
      }

      const files: Array<{
        path: string;
        status: "added" | "modified" | "deleted";
        additions: number;
        deletions: number;
        patch: string;
      }> = [];

      for (const [filePath, statusCode] of fileMap) {
        if (!filePath) continue;

        let status: "added" | "modified" | "deleted";
        if (statusCode.startsWith("A") || statusCode === "U") status = "added";
        else if (statusCode.startsWith("D")) status = "deleted";
        else status = "modified";

        let patch = "";
        try {
          if (statusCode === "U") {
            patch = await runGitCommand(["diff", "--no-index", "/dev/null", filePath], cwd, 10000).catch(() => "");
          } else {
            patch = await runGitCommand(["diff", diffRange, "--", filePath], cwd, 10000);
          }
        } catch {
          // ignore individual file errors
        }

        const additions = (patch.match(/^\+[^+]/gm) || []).length;
        const deletions = (patch.match(/^-[^-]/gm) || []).length;

        files.push({ path: filePath, status, additions, deletions, patch });
      }

      const stats = {
        filesChanged: files.length,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      };

      res.json({ files, stats });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
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
      if (!(await worktreeStillBelongsToTask(worktree, task.branch))) {
        res.json([]);
        return;
      }
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
}
