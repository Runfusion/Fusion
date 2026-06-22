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

/**
 * Scans `dir` one level deep for sub-directories that are git repositories.
 * Returns relative paths of found repos, sorted alphabetically.
 */
export async function detectWorkspaceRepos(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const { stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const found: string[] = [];
  /*
  FNXC:Workspace 2026-06-22-00:00:
  A bare `.git` marker (e.g. a stray file copied in, or an unrelated tool's artifact) is not
  proof of a git repository. Each candidate child is validated with a real `git rev-parse`
  work-tree probe before it counts, so stray `.git` entries do not yield false-positive repos.
  */
  for (const entry of entries) {
    const childDir = join(dir, entry);
    // Cheap pre-filter: skip children with no `.git` marker at all before spawning git.
    try {
      const s = await stat(join(childDir, ".git"));
      if (!s.isDirectory() && !s.isFile()) continue;
    } catch {
      continue;
    }
    if (await isInsideGitWorkTree(childDir, runGitCommand, DEFAULT_GIT_TIMEOUT_MS)) {
      found.push(entry);
    }
  }
  return found.sort();
}

export interface WorkspaceConfig {
  repos: string[];
}

const WORKSPACE_CONFIG_FILENAME = "workspace.json";

/*
FNXC:Workspace 2026-06-22-00:00:
Workspace repo entries are later joined onto the workspace root to resolve worktrees, so an
attacker-controlled or corrupted workspace.json with an absolute path or a `..` escape
(`../outside-repo`) would resolve outside the workspace root. Each entry must be a normalized,
relative, in-root path; absolute paths, `..` escapes, and non-string entries are rejected.
*/
function isInRootRelativePath(entry: unknown, pathMod: typeof import("node:path")): entry is string {
  if (typeof entry !== "string" || entry.length === 0) return false;
  if (pathMod.isAbsolute(entry)) return false;
  const normalized = pathMod.normalize(entry);
  if (normalized === ".." || normalized.startsWith(`..${pathMod.sep}`) || normalized.startsWith("../")) {
    return false;
  }
  return true;
}

export async function loadWorkspaceConfig(rootDir: string): Promise<WorkspaceConfig | null> {
  const { readFile } = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const { join } = pathMod;
  const configPath = join(rootDir, ".fusion", WORKSPACE_CONFIG_FILENAME);
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "repos" in parsed &&
      Array.isArray((parsed as { repos: unknown }).repos)
    ) {
      const rawRepos = (parsed as { repos: unknown[] }).repos;
      const repos = rawRepos.filter((entry): entry is string => isInRootRelativePath(entry, pathMod));
      return { ...(parsed as object), repos };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveWorkspaceConfig(rootDir: string, config: WorkspaceConfig): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const fusionDir = join(rootDir, ".fusion");
  await mkdir(fusionDir, { recursive: true });
  await writeFile(
    join(fusionDir, WORKSPACE_CONFIG_FILENAME),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}
