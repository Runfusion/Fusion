import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Settings, TaskStore } from "@fusion/core";
import { createResolvedAgentSession } from "@fusion/engine";
import { runGitCommand } from "./routes/resolve-diff-base.js";

const GIT_TIMEOUT_MS = 60_000;
const SESSION_PROMPT = [
  "You are resolving merge conflicts for a Fusion task branch before GitHub PR creation.",
  "Edit only the conflicted files in this worktree.",
  "Remove every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) and produce a coherent merged result.",
  "Preserve the task branch intent while integrating the selected base branch changes.",
  "Do NOT run git commands, do NOT create commits, and do NOT push.",
  "When you finish, every conflicted file must be saved without conflict markers.",
].join("\n");

export interface ResolvePrConflictsInput {
  taskId: string;
  baseRef: string;
  rootDir: string;
  store: TaskStore;
  settings: Settings;
}

export interface ResolvePrConflictsResult {
  resolved: boolean;
  pushed: boolean;
  conflictedFiles: string[];
  message: string;
}

function getHeadBranch(taskId: string): string {
  return `fusion/${taskId.toLowerCase()}`;
}

function getDefaultSessionModel(settings: Settings): { provider: string | undefined; modelId: string | undefined } {
  if (settings.defaultProviderOverride && settings.defaultModelIdOverride) {
    return {
      provider: settings.defaultProviderOverride,
      modelId: settings.defaultModelIdOverride,
    };
  }
  return {
    provider: settings.defaultProvider,
    modelId: settings.defaultModelId,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveUsableWorktree(candidatePath: string | undefined, branchName: string): Promise<string | null> {
  if (!candidatePath) {
    return null;
  }

  const absolutePath = resolve(candidatePath);
  if (!await pathExists(absolutePath)) {
    return null;
  }

  try {
    const currentBranch = (await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], absolutePath, GIT_TIMEOUT_MS)).trim();
    if (currentBranch === branchName) {
      return absolutePath;
    }
  } catch {
    return null;
  }

  return null;
}

async function listConflictedFiles(cwd: string): Promise<string[]> {
  const output = await runGitCommand(["diff", "--name-only", "--diff-filter=U"], cwd, GIT_TIMEOUT_MS).catch(() => "");
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function findFilesWithConflictMarkers(rootDir: string, files: string[]): Promise<string[]> {
  const conflicted: string[] = [];
  for (const file of files) {
    try {
      const contents = await readFile(join(rootDir, file), "utf8");
      if (/^<<<<<<< /m.test(contents) || /^=======$/m.test(contents) || /^>>>>>>> /m.test(contents)) {
        conflicted.push(file);
      }
    } catch {
      // Best-effort verification.
    }
  }
  return conflicted;
}

function getGitExitCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await runGitCommand(["diff", "--cached", "--quiet"], cwd, GIT_TIMEOUT_MS);
    return false;
  } catch (error) {
    if (getGitExitCode(error) === 1) {
      return true;
    }
    throw error;
  }
}

async function stageAndCommitIfNeeded(cwd: string, commitArgs: string[]): Promise<boolean> {
  await runGitCommand(["add", "-A"], cwd, GIT_TIMEOUT_MS);
  if (!await hasStagedChanges(cwd)) {
    return false;
  }
  await runGitCommand(["commit", ...commitArgs], cwd, GIT_TIMEOUT_MS);
  return true;
}

async function abortMerge(cwd: string): Promise<void> {
  try {
    await runGitCommand(["merge", "--abort"], cwd, GIT_TIMEOUT_MS);
    return;
  } catch {
    // fall through
  }

  try {
    await runGitCommand(["reset", "--merge"], cwd, GIT_TIMEOUT_MS);
  } catch {
    // best-effort cleanup
  }
}

async function runResolutionAgent(params: {
  cwd: string;
  taskId: string;
  conflictedFiles: string[];
  settings: Settings;
}): Promise<void> {
  const { cwd, taskId, conflictedFiles, settings } = params;
  const sessionModel = getDefaultSessionModel(settings);
  const { session } = await createResolvedAgentSession({
    cwd,
    systemPrompt: SESSION_PROMPT,
    tools: "coding",
    sessionPurpose: "merger",
    defaultProvider: sessionModel.provider,
    defaultModelId: sessionModel.modelId,
    fallbackProvider: settings.fallbackProvider,
    fallbackModelId: settings.fallbackModelId,
    settings,
  });

  try {
    await session.prompt([
      `Resolve Create-PR merge conflicts for task ${taskId}.`,
      "",
      "Conflicted files:",
      ...conflictedFiles.map((file) => `- ${file}`),
      "",
      "Instructions:",
      "1. Read each conflicted file in the current worktree.",
      "2. Edit only the listed files to remove all conflict markers.",
      "3. Keep the branch in a coherent post-merge state.",
      "4. Do not run git commands, do not commit, and do not push.",
    ].join("\n"));
  } finally {
    try {
      session.dispose();
    } catch {
      // ignore dispose failures
    }
  }
}

export async function resolvePrConflicts(input: ResolvePrConflictsInput): Promise<ResolvePrConflictsResult> {
  const { taskId, baseRef, rootDir, store } = input;
  const task = await store.getTask(taskId);
  const branchName = getHeadBranch(taskId);
  const reusableWorktree = await resolveUsableWorktree(task.worktree, branchName);
  const tempWorktreePath = join(rootDir, ".fusion", "worktrees", `conflict-${taskId.toLowerCase()}`);
  const cwd = reusableWorktree ?? tempWorktreePath;
  const createdTemporaryWorktree = !reusableWorktree;

  if (createdTemporaryWorktree) {
    await mkdir(join(rootDir, ".fusion", "worktrees"), { recursive: true });
    await rm(tempWorktreePath, { recursive: true, force: true });
    await runGitCommand(["worktree", "add", "--force", tempWorktreePath, branchName], rootDir, GIT_TIMEOUT_MS);
  }

  try {
    try {
      await runGitCommand(["checkout", branchName], cwd, GIT_TIMEOUT_MS);
      await runGitCommand(["merge", "--no-commit", "--no-ff", baseRef], cwd, GIT_TIMEOUT_MS);
    } catch (error) {
      const conflictedFiles = await listConflictedFiles(cwd);
      if (conflictedFiles.length === 0) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to merge ${baseRef} into ${branchName}: ${message}`);
      }

      await store.logEntry(taskId, "Started AI PR conflict resolution", `${conflictedFiles.length} conflicted file(s)`);
      try {
        await runResolutionAgent({
          cwd,
          taskId,
          conflictedFiles,
          settings: input.settings,
        });

        const unresolvedFiles = await findFilesWithConflictMarkers(cwd, conflictedFiles);
        if (unresolvedFiles.length > 0) {
          await abortMerge(cwd);
          await store.logEntry(
            taskId,
            "AI PR conflict resolution left unresolved markers",
            `Merge aborted. Worktree may still contain partial AI edits for manual review: ${unresolvedFiles.join(", ")}`,
          );
          return {
            resolved: false,
            pushed: false,
            conflictedFiles: unresolvedFiles,
            message: `AI conflict resolution left unresolved markers in ${unresolvedFiles.length} file(s).`,
          };
        }

        await store.logEntry(taskId, "AI PR conflict resolution completed", `${conflictedFiles.length} conflicted file(s) resolved`);
        const committed = await stageAndCommitIfNeeded(cwd, [
          "-m",
          `fix(FN-5949): resolve PR conflicts for ${taskId}`,
          "-m",
          `Fusion-Task-Id: ${taskId}`,
        ]);
        if (!committed) {
          await abortMerge(cwd);
          await store.logEntry(taskId, "Skipped PR conflict resolution commit", "No staged changes after AI conflict resolution");
          return {
            resolved: true,
            pushed: false,
            conflictedFiles,
            message: `Resolved conflicts with ${baseRef}, but no merge commit was needed because there were no staged changes.`,
          };
        }
        await runGitCommand(["push", "-u", "origin", branchName], cwd, GIT_TIMEOUT_MS);
        await store.logEntry(taskId, "Pushed PR branch after AI conflict resolution", branchName);

        return {
          resolved: true,
          pushed: true,
          conflictedFiles,
          message: `Resolved conflicts with ${baseRef} and pushed ${branchName}.`,
        };
      } catch (resolutionError) {
        await abortMerge(cwd);
        throw resolutionError;
      }
    }

    const committed = await stageAndCommitIfNeeded(cwd, [
      "-m",
      `fix(FN-5949): merge ${baseRef} into ${taskId}`,
      "-m",
      `Fusion-Task-Id: ${taskId}`,
    ]);
    if (!committed) {
      await store.logEntry(taskId, "Skipped PR conflict-free merge commit", `${baseRef} already merged into ${branchName}`);
      return {
        resolved: true,
        pushed: false,
        conflictedFiles: [],
        message: `${baseRef} already merged into ${branchName}; no merge commit needed.`,
      };
    }
    await runGitCommand(["push", "-u", "origin", branchName], cwd, GIT_TIMEOUT_MS);
    await store.logEntry(taskId, "Pushed PR branch after conflict-free merge", branchName);

    return {
      resolved: true,
      pushed: true,
      conflictedFiles: [],
      message: `Merged ${baseRef} into ${branchName} and pushed the branch.`,
    };
  } finally {
    if (createdTemporaryWorktree) {
      try {
        await runGitCommand(["worktree", "remove", "--force", tempWorktreePath], rootDir, GIT_TIMEOUT_MS);
      } catch {
        await rm(tempWorktreePath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
