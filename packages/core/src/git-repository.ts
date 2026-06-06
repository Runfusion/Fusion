import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 10_000;

export type GitRepositoryEnsureOutcome = "existing" | "initialized";

export interface GitRepositoryCommandResult {
  stdout: string;
  stderr: string;
}

export type GitRepositoryCommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; timeout: number },
) => Promise<GitRepositoryCommandResult>;

export interface EnsureGitRepositoryOptions {
  runner?: GitRepositoryCommandRunner;
  timeoutMs?: number;
}

export class GitRepositoryInitializationError extends Error {
  readonly path: string;
  readonly causeMessage: string;

  constructor(path: string, causeMessage: string) {
    super(`Could not initialize Git repository at ${path}: ${causeMessage}`);
    this.name = "GitRepositoryInitializationError";
    this.path = path;
    this.causeMessage = causeMessage;
  }
}

export async function ensureGitRepositoryForProjectPath(
  projectPath: string,
  options: EnsureGitRepositoryOptions = {},
): Promise<GitRepositoryEnsureOutcome> {
  const runner = options.runner ?? runGitCommand;
  const timeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  if (await isInsideGitWorkTree(projectPath, runner, timeout)) {
    return "existing";
  }

  try {
    await runner("git", ["-C", projectPath, "init"], { timeout });
    return "initialized";
  } catch (error) {
    throw new GitRepositoryInitializationError(projectPath, extractCommandErrorMessage(error));
  }
}

async function isInsideGitWorkTree(
  projectPath: string,
  runner: GitRepositoryCommandRunner,
  timeout: number,
): Promise<boolean> {
  try {
    const result = await runner("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"], { timeout });
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function runGitCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeout: number },
): Promise<GitRepositoryCommandResult> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: "utf-8",
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function extractCommandErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const maybe = error as { stderr?: unknown; stdout?: unknown; message?: unknown; code?: unknown };
    for (const value of [maybe.stderr, maybe.stdout, maybe.message]) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    if (maybe.code !== undefined) {
      return `git exited with code ${String(maybe.code)}`;
    }
  }

  return String(error);
}
