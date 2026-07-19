import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { invalidateGitBinaryCache, isSpawnGitEnoent, resolveGitBinary } from "./git-binary.js";

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

  /*
  FNXC:Workspace 2026-06-24-10:00:
  A workspace-mode project root is intentionally NOT a git repository — it is a parent
  directory containing multiple git sub-repos (detected at init time and recorded in
  .fusion/workspace.json). Running `git init` here would create a stray empty repo at the
  workspace root, poisoning every downstream git command: the executor sets the session cwd
  to this root (browse-only), and `git rev-parse --abbrev-ref HEAD` fails on the unborn HEAD
  with "ambiguous argument 'HEAD'". Detect workspace mode via the config file and skip the
  git-init so the root stays non-git, matching the workspace execution contract (KTD1).
  */
  if (await loadWorkspaceConfig(projectPath)) {
    return "existing";
  }

  if (await isInsideGitWorkTree(projectPath, runner, timeout)) {
    return "existing";
  }

  /*
  FNXC:Workspace 2026-06-24-14:30:
  Fallback workspace detection: when workspace.json is missing (e.g. project added via
  dashboard or `fn project add`, which don't run the interactive workspace detection flow),
  probe for git sub-repos. If found, persist workspace.json AND set workspaceMode: true in
  config.json so the dashboard toggle reflects the actual state. This covers all registration
  surfaces: the CLI interactive setup writes workspace.json explicitly, but dashboard POST
  /api/projects and `fn project add` do not — without this fallback they would create a stray
  .git at the workspace root because loadWorkspaceConfig returned null.

  FNXC:Workspace 2026-06-24-17:00:
  If the user has explicitly disabled workspace mode (workspaceMode: false in config.json),
  skip auto-detection and proceed to git init. Without this guard, toggling workspace mode off
  via the dashboard would have no lasting effect — the fallback would re-detect sub-repos and
  re-create workspace.json on the next registration call.
  */
  if (!(await isWorkspaceModeExplicitlyDisabled(projectPath))) {
    const detectedRepos = await detectWorkspaceRepos(projectPath, runner, timeout);
    if (detectedRepos.length > 0) {
      // Write config.json first so a failure here doesn't leave a stale workspace.json
      // that would short-circuit loadWorkspaceConfig on the next call without the
      // workspaceMode setting being persisted.
      await setWorkspaceModeInConfig(projectPath, true);
      await saveWorkspaceConfig(projectPath, { repos: detectedRepos });
      return "existing";
    }
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
  /*
  FNXC:Onboarding 2026-07-18-03:20:
  Route "git" through resolveGitBinary so a git installed AFTER the server
  started (stale PATH snapshot — spawn git ENOENT during first-run project
  setup) is found at its well-known install location; on ENOENT re-resolve
  once so a mid-session install is picked up without restarting Fusion.
  */
  const binary = command === "git" ? await resolveGitBinary() : command;
  try {
    const result = await execFileAsync(binary, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      encoding: "utf-8",
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error) {
    if (command !== "git" || !isSpawnGitEnoent(error)) throw error;
    invalidateGitBinaryCache();
    const retryBinary = await resolveGitBinary();
    if (retryBinary === binary) throw error;
    const result = await execFileAsync(retryBinary, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      encoding: "utf-8",
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
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
 *
 * Excludes `node_modules`, `.fusion`, and other known non-workspace directories so that
 * packages installed from git sources (which leave real `.git` dirs) do not produce
 * false-positive workspace members.
 */
export async function detectWorkspaceRepos(
  dir: string,
  runner: GitRepositoryCommandRunner = runGitCommand,
  timeout: number = DEFAULT_GIT_TIMEOUT_MS,
): Promise<string[]> {
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
  /*
  FNXC:Workspace 2026-06-24-15:00:
  Exclude node_modules and .fusion so that npm packages installed from git sources (which
  leave real .git directories inside node_modules/<package>) and Fusion's own state directory
  do not produce false-positive workspace members. A workspace root is a plain directory whose
  immediate children are the intended sub-repos, not transitive dependency artifacts.
  */
  const EXCLUDED_ENTRIES = new Set(["node_modules", ".fusion", ".git", ".pi"]);
  for (const entry of entries) {
    if (EXCLUDED_ENTRIES.has(entry)) continue;

    const childDir = join(dir, entry);
    // Cheap pre-filter: skip children with no `.git` marker at all before spawning git.
    try {
      const s = await stat(join(childDir, ".git"));
      if (!s.isDirectory() && !s.isFile()) continue;
    } catch {
      continue;
    }
    if (await isInsideGitWorkTree(childDir, runner, timeout)) {
      found.push(entry);
    }
  }
  return found.sort();
}

export interface WorkspaceConfig {
  repos: string[];
}

const WORKSPACE_CONFIG_FILENAME = "workspace.json";

/**
 * Reads .fusion/config.json and returns true when `workspaceMode` is explicitly
 * set to `false`. This guards the auto-detection fallback so a user who has
 * intentionally disabled workspace mode doesn't get it silently re-enabled.
 */
async function isWorkspaceModeExplicitlyDisabled(projectPath: string): Promise<boolean> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const raw = await readFile(join(projectPath, ".fusion", "config.json"), "utf-8");
    const config = JSON.parse(raw) as { settings?: { workspaceMode?: boolean } };
    return config.settings?.workspaceMode === false;
  } catch {
    return false;
  }
}

/**
 * FNXC:Workspace 2026-06-24-17:15:
 * Writes `workspaceMode: true` into .fusion/config.json so the dashboard toggle
 * reflects that workspace mode is active after auto-detection. Reads-merges-writes
 * to avoid clobbering existing config settings.
 */
async function setWorkspaceModeInConfig(projectPath: string, value: boolean): Promise<void> {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const configPath = join(projectPath, ".fusion", "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    // Only treat "file not found" as empty config; re-throw parse/permission errors
    // so a corrupted config.json doesn't get silently clobbered with a fresh object.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  // Validate settings is a plain object before merging
  if (typeof config.settings !== "object" || config.settings === null || Array.isArray(config.settings)) {
    config.settings = {};
  }
  const settings = config.settings as Record<string, unknown>;
  settings.workspaceMode = value;
  await mkdir(join(projectPath, ".fusion"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

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
    // FNXC:Workspace 2026-06-22-09:30 (Phase C review nit): validate that `repos` is an array
    // OF STRINGS, not merely an array. A malformed config (`{ repos: [123, null] }`) would
    // otherwise pass and feed non-string values into path joins downstream.
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "repos" in parsed &&
      Array.isArray((parsed as { repos: unknown }).repos) &&
      (parsed as { repos: unknown[] }).repos.every((r) => typeof r === "string")
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
