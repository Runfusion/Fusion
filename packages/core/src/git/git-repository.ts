import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { invalidateGitBinaryCache, isSpawnGitEnoent, resolveGitBinary } from "../cli/git-binary.js";
import {
  ensureIntegrationBranchLocalRef,
  type IntegrationBranchReconciliation,
} from "./integration-branch-readiness.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const FUSION_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Fusion",
  GIT_AUTHOR_EMAIL: "noreply@runfusion.ai",
  GIT_COMMITTER_NAME: "Fusion",
  GIT_COMMITTER_EMAIL: "noreply@runfusion.ai",
} as const;
const MANAGED_GITIGNORE_ENTRIES = [
  ".fusion/",
  ".pi/",
  ".worktrees/",
  "fusion.db",
  "fusion.db-wal",
  "fusion.db-shm",
] as const;

export type GitRepositoryEnsureOutcome = "existing" | "initialized";

export interface GitRepositoryCommandResult {
  stdout: string;
  stderr: string;
}

export type GitRepositoryCommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; timeout: number; env?: NodeJS.ProcessEnv },
) => Promise<GitRepositoryCommandResult>;

export interface EnsureGitRepositoryOptions {
  runner?: GitRepositoryCommandRunner;
  timeoutMs?: number;
}

export interface ProjectGitReadiness {
  outcome: GitRepositoryEnsureOutcome;
  integrationBranches: IntegrationBranchReconciliation[];
}

export class GitRepositoryInitializationError extends Error {
  readonly path: string;
  readonly causeMessage: string;

  constructor(path: string, causeMessage: string) {
    super(`Could not prepare Git repository at ${path}: ${causeMessage}`);
    this.name = "GitRepositoryInitializationError";
    this.path = path;
    this.causeMessage = causeMessage;
  }
}

/**
 * Ensures that a project has a usable Git baseline and a resolvable integration ref before
 * any registry row is written.
 *
 * FNXC:ProjectSetup 2026-08-19-12:44:
 * Registration must be fail-closed: non-Git directories and unborn repositories receive
 * a real baseline containing only Fusion's managed `.gitignore` file, while committed
 * repositories keep their history, branch, remotes, config, index, and user changes.
 * Workspace roots remain browse-only; their members are prepared inside one canonical-root
 * lock so dashboard, CLI, reattachment, and workspace registration cannot drift.
 */
export async function ensureProjectGitReadiness(
  projectPath: string,
  options: EnsureGitRepositoryOptions = {},
): Promise<ProjectGitReadiness> {
  const runner = options.runner ?? runGitCommand;
  const timeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  return withWorkspaceModeLock(projectPath, async () => {
    try {
      return await ensureProjectGitReadinessLocked(projectPath, runner, timeout);
    } catch (error) {
      if (error instanceof GitRepositoryInitializationError) throw error;
      throw new GitRepositoryInitializationError(projectPath, extractCommandErrorMessage(error));
    }
  });
}

/** Preserves the legacy outcome-only readiness contract for existing injected callers. */
export async function ensureGitRepositoryForProjectPath(
  projectPath: string,
  options: EnsureGitRepositoryOptions = {},
): Promise<GitRepositoryEnsureOutcome> {
  return (await ensureProjectGitReadiness(projectPath, options)).outcome;
}

async function ensureProjectGitReadinessLocked(
  projectPath: string,
  runner: GitRepositoryCommandRunner,
  timeout: number,
): Promise<ProjectGitReadiness> {
  const workspace = await loadWorkspaceConfig(projectPath);
  if (workspace) {
    return prepareWorkspaceRepositories(projectPath, workspace.repos, runner, timeout);
  }

  if (await isInsideGitWorkTree(projectPath, runner, timeout)) {
    const prepared = await prepareSingleRepository(
      projectPath,
      runner,
      timeout,
      false,
      await readConfiguredIntegrationBranch(projectPath),
    );
    return { outcome: prepared.outcome, integrationBranches: [prepared.integrationBranch] };
  }

  /*
  FNXC:Workspace 2026-08-19-12:44:
  Dashboard and `fn project add` can discover workspace members without an existing
  workspace.json. Decide workspace mode before touching the root, prepare every member,
  then persist the decision. No root `.git` is ever created for this path.
  */
  if (!(await isWorkspaceModeExplicitlyDisabled(projectPath))) {
    const detectedRepos = await detectWorkspaceRepos(projectPath, runner, timeout);
    if (detectedRepos.length > 0) {
      const readiness = await prepareWorkspaceRepositories(projectPath, detectedRepos, runner, timeout);
      await setWorkspaceModeInConfig(projectPath, true);
      await saveWorkspaceConfig(projectPath, { repos: detectedRepos });
      return readiness;
    }
  }

  const prepared = await prepareSingleRepository(
    projectPath,
    runner,
    timeout,
    true,
    await readConfiguredIntegrationBranch(projectPath),
  );
  return { outcome: prepared.outcome, integrationBranches: [prepared.integrationBranch] };
}

async function prepareWorkspaceRepositories(
  rootDir: string,
  repos: string[],
  runner: GitRepositoryCommandRunner,
  timeout: number,
): Promise<ProjectGitReadiness> {
  let initialized = false;
  const integrationBranches: IntegrationBranchReconciliation[] = [];
  for (const relativeRepo of repos) {
    const repoPath = join(rootDir, relativeRepo);
    const prepared = await prepareSingleRepository(repoPath, runner, timeout, true, undefined, relativeRepo);
    initialized ||= prepared.outcome === "initialized";
    integrationBranches.push(prepared.integrationBranch);
  }
  return {
    outcome: initialized ? "initialized" : "existing",
    integrationBranches,
  };
}

async function prepareSingleRepository(
  projectPath: string,
  runner: GitRepositoryCommandRunner,
  timeout: number,
  initializeIfMissing: boolean,
  configuredBranch?: string,
  repoRelPath = ".",
): Promise<{ outcome: GitRepositoryEnsureOutcome; integrationBranch: IntegrationBranchReconciliation }> {
  let repositoryExists = await isInsideGitWorkTree(projectPath, runner, timeout);
  if (!repositoryExists && !initializeIfMissing) {
    throw new Error("workspace member is not a usable Git repository");
  }

  let initialized = false;
  let indexWasEmpty = false;
  if (!repositoryExists) {
    await runner("git", ["-C", projectPath, "init"], { timeout });
    repositoryExists = true;
    initialized = true;
    indexWasEmpty = (await runner("git", ["-C", projectPath, "ls-files", "--stage"], { timeout })).stdout.trim() === "";
  } else {
    indexWasEmpty = false;
  }

  const gitignore = await reconcileManagedGitignore(projectPath);
  const hasHead = await hasVerifiableHead(projectPath, runner, timeout);
  if (!hasHead) {
    await createBaselineCommit(projectPath, gitignore.newline, runner, timeout);
    /*
    FNXC:ProjectSetup 2026-08-19-13:25:
    The plumbing commit intentionally leaves Git's live index untouched. For a repository
    Fusion just initialized, populate its previously empty index from the baseline so Git
    does not report a staged deletion. Do not `git add .gitignore`: a pre-existing custom
    ignore file must remain an unstaged operator-visible edit, not become Fusion-staged.
    */
    if (initialized && indexWasEmpty) {
      await runner("git", ["-C", projectPath, "read-tree", "HEAD"], { timeout });
    }
  }

  /*
  FNXC:IntegrationBranchReadiness 2026-08-24-00:41:
  FN-183 reconciles the integration ref only after baseline creation. An unborn repository
  therefore already has its symbolic local branch and reports it as existing; adopting fetched
  upstream history into that new baseline is intentionally outside this narrow readiness seam.
  */
  const integrationBranch = await ensureIntegrationBranchLocalRef(projectPath, {
    runner,
    timeoutMs: timeout,
    configuredBranch,
    repoRelPath,
  });
  return {
    outcome: initialized || !hasHead ? "initialized" : "existing",
    integrationBranch,
  };
}

async function hasVerifiableHead(
  projectPath: string,
  runner: GitRepositoryCommandRunner,
  timeout: number,
): Promise<boolean> {
  try {
    await runner("git", ["-C", projectPath, "rev-parse", "--verify", "HEAD^{commit}"], { timeout });
    return true;
  } catch {
    return false;
  }
}

function managedIgnoreKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return null;
  return trimmed.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function managedGitignoreContent(newline: string): string {
  return `${MANAGED_GITIGNORE_ENTRIES.join(newline)}${newline}`;
}

async function reconcileManagedGitignore(projectPath: string): Promise<{ newline: string }> {
  const gitignorePath = join(projectPath, ".gitignore");
  let content = "";
  let fileExists = false;
  try {
    const stats = await lstat(gitignorePath);
    fileExists = true;
    if (stats.isSymbolicLink()) {
      throw new Error(".gitignore is a symbolic link; refusing to follow an unsafe target");
    }
    if (!stats.isFile()) throw new Error(".gitignore is not a regular file");
    content = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const existing = new Set(content.split(/\r?\n/).map(managedIgnoreKey).filter((entry): entry is string => entry !== null));
  const missing = MANAGED_GITIGNORE_ENTRIES.filter((entry) => {
    const key = managedIgnoreKey(entry);
    return key !== null && !existing.has(key);
  });
  if (missing.length === 0) return { newline };

  const prefix = content.length === 0 || content.endsWith("\n") ? "" : newline;
  const updated = `${content}${prefix}${missing.join(newline)}${newline}`;
  await writeGitignoreSafely(gitignorePath, updated, fileExists);
  return { newline };
}

async function writeGitignoreSafely(path: string, content: string, existing: boolean): Promise<void> {
  const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const flags = existing
    ? fsConstants.O_RDWR | noFollow
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  const handle = await open(path, flags, 0o644);
  try {
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function createBaselineCommit(
  projectPath: string,
  newline: string,
  runner: GitRepositoryCommandRunner,
  timeout: number,
): Promise<void> {
  const branch = (await runner("git", ["-C", projectPath, "symbolic-ref", "HEAD"], { timeout })).stdout.trim();
  if (!branch.startsWith("refs/heads/") || branch.length <= "refs/heads/".length) {
    throw new Error("cannot create a baseline commit without an operator-selected branch");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "fusion-git-baseline-"));
  const tempIndex = join(tempDir, "index");
  const tempGitignore = join(tempDir, "gitignore");
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  const identityEnv = { ...env, ...FUSION_GIT_IDENTITY };
  try {
    await writeFile(tempGitignore, managedGitignoreContent(newline), "utf8");
    const blob = (await runner("git", ["-C", projectPath, "hash-object", "-w", "--", tempGitignore], { timeout })).stdout.trim();
    await runner("git", ["-C", projectPath, "read-tree", "--empty"], { timeout, env });
    await runner("git", ["-C", projectPath, "update-index", "--add", `--cacheinfo`, `100644,${blob},.gitignore`], { timeout, env });
    const tree = (await runner("git", ["-C", projectPath, "write-tree"], { timeout, env })).stdout.trim();
    const commit = (await runner("git", ["-C", projectPath, "commit-tree", tree, "-m", "chore: initialize Fusion project"], { timeout, env: identityEnv })).stdout.trim();
    if (!commit) throw new Error("Git returned an empty baseline commit");
    await runner("git", ["-C", projectPath, "update-ref", branch, commit], { timeout });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
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
  options: { cwd?: string; timeout: number; env?: NodeJS.ProcessEnv },
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
      env: options.env,
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
      env: options.env,
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
  for (const entry of entries) {
    if (EXCLUDED_WORKSPACE_ENTRIES.has(entry)) continue;

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

export type WorkspaceRepoValidationReason =
  | "not-a-workspace"
  | "invalid-path"
  | "not-direct-child"
  | "excluded-name"
  | "missing"
  | "not-a-git-work-tree";

export class WorkspaceRepoValidationError extends Error {
  constructor(readonly reason: WorkspaceRepoValidationReason) {
    super(`Workspace repository validation failed: ${reason}`);
    this.name = "WorkspaceRepoValidationError";
  }
}

const WORKSPACE_CONFIG_FILENAME = "workspace.json";
const EXCLUDED_WORKSPACE_ENTRIES = new Set(["node_modules", ".fusion", ".git", ".pi", ".worktrees"]);

/**
 * FNXC:IntegrationBranchReadiness 2026-08-24-00:41:
 * Registration may consult the project-local config mirror before the database row exists.
 * Keep this read-only and best-effort: an explicit integrationBranch wins, with baseBranch
 * retained only as the legacy fallback, while malformed or unavailable mirrors never block
 * Git readiness.
 */
async function readConfiguredIntegrationBranch(projectPath: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const raw = await readFile(join(projectPath, ".fusion", "config.json"), "utf-8");
    const config = JSON.parse(raw) as {
      settings?: { integrationBranch?: unknown; baseBranch?: unknown };
    };
    for (const value of [config.settings?.integrationBranch, config.settings?.baseBranch]) {
      if (typeof value !== "string") continue;
      const branch = value.trim();
      if (branch) return branch;
    }
  } catch {
    // FNXC:IntegrationBranchReadiness 2026-08-24-00:41: Config-mirror failures are advisory only.
  }
  return undefined;
}

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
export async function setWorkspaceModeInConfig(projectPath: string, value: boolean): Promise<void> {
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

/*
FNXC:Workspace 2026-08-20-02:03:
Issue 3480 item 6 requires workspace membership to be editable after registration. New members are
in-root direct-child Git work trees, additions are idempotent, and the write shares the workspace-mode
lock so a concurrent mode toggle cannot lose a member.
*/
export async function addWorkspaceRepo(
  rootDir: string,
  repoRelPath: string,
  options: { runner?: GitRepositoryCommandRunner; timeout?: number } = {},
): Promise<{ outcome: "added" | "already-member"; repos: string[] }> {
  const pathMod = await import("node:path");
  const { stat } = await import("node:fs/promises");
  const repo = typeof repoRelPath === "string" ? repoRelPath.trim() : "";
  if (!repo || !isInRootRelativePath(repo, pathMod)) {
    throw new WorkspaceRepoValidationError("invalid-path");
  }
  const normalized = pathMod.normalize(repo);
  // A workspace member must name a child, not the workspace root (including child/..).
  if (normalized === ".") {
    throw new WorkspaceRepoValidationError("not-direct-child");
  }
  if (normalized.includes(pathMod.sep) || normalized.includes("/")) {
    throw new WorkspaceRepoValidationError("not-direct-child");
  }
  if (EXCLUDED_WORKSPACE_ENTRIES.has(normalized)) {
    throw new WorkspaceRepoValidationError("excluded-name");
  }
  const childPath = pathMod.join(rootDir, normalized);
  try {
    if (!(await stat(childPath)).isDirectory()) throw new WorkspaceRepoValidationError("missing");
  } catch (error) {
    if (error instanceof WorkspaceRepoValidationError) throw error;
    throw new WorkspaceRepoValidationError("missing");
  }
  const runner = options.runner ?? runGitCommand;
  if (!(await isInsideGitWorkTree(childPath, runner, options.timeout ?? DEFAULT_GIT_TIMEOUT_MS))) {
    throw new WorkspaceRepoValidationError("not-a-git-work-tree");
  }
  return withWorkspaceModeLock(rootDir, async () => {
    const config = await loadWorkspaceConfig(rootDir);
    if (!config) throw new WorkspaceRepoValidationError("not-a-workspace");
    if (config.repos.includes(normalized)) return { outcome: "already-member", repos: config.repos };
    const repos = [...config.repos, normalized].sort();
    await saveWorkspaceConfig(rootDir, { ...config, repos });
    return { outcome: "added", repos };
  });
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

/** Removes the workspace authority file and reports whether it existed. */
export async function removeWorkspaceConfig(rootDir: string): Promise<boolean> {
  const { unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    await unlink(join(rootDir, ".fusion", WORKSPACE_CONFIG_FILENAME));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

/*
FNXC:Workspace 2026-08-15-05:28:
The PostgreSQL setting alone cannot control workspace execution: the executor reads workspace.json,
while registration suppression reads config.json. Toggle both in the documented ordering and reconcile
from workspace.json, the runtime authority. Existing non-empty workspace configs are preserved because
registration and CLI flows may have saved a curated repo subset before publishing their settings update.

The helper receives filesystem operations because sibling calls in this module cannot be intercepted by
module mocks. Its per-root in-process lock keeps the multi-step disk mutation and its observed result from
braiding with another toggle; it does not fence another OS process, whose residual divergence is settled by
the next publish's re-read and reconciliation.
*/
export interface WorkspaceModeToggleOps {
  loadWorkspaceConfig: typeof loadWorkspaceConfig;
  saveWorkspaceConfig: typeof saveWorkspaceConfig;
  setWorkspaceModeInConfig: (rootDir: string, enabled: boolean) => Promise<void>;
  detectWorkspaceRepos: typeof detectWorkspaceRepos;
  removeWorkspaceConfig: (rootDir: string) => Promise<boolean>;
}

export type WorkspaceModeToggleResult = {
  enabled: boolean | undefined;
  repos: string[];
  workspaceConfigWritten: boolean;
  workspaceConfigRemoved: boolean;
  failureReason?: string;
  mirrorDivergent?: boolean;
};

const workspaceModeLockTails = new Map<string, Promise<void>>();

/** Serializes one complete workspace-mode critical section for a project root. */
export async function withWorkspaceModeLock<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(rootDir);
  const previous = workspaceModeLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((done) => { release = done; });
  const chained = previous.then(() => tail);
  workspaceModeLockTails.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (workspaceModeLockTails.get(key) === chained) workspaceModeLockTails.delete(key);
  }
}

function workspaceToggleFailure(prefix: string, error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : error instanceof Error ? error.name : "unknown";
  return `${prefix}: ${code}`;
}

export async function applyWorkspaceModeToggle(
  rootDir: string,
  enabled: boolean,
  options: { ops?: Partial<WorkspaceModeToggleOps>; lockHeld?: boolean } = {},
): Promise<WorkspaceModeToggleResult> {
  const ops: WorkspaceModeToggleOps = {
    loadWorkspaceConfig,
    saveWorkspaceConfig,
    setWorkspaceModeInConfig,
    detectWorkspaceRepos,
    removeWorkspaceConfig,
    ...options.ops,
  };
  const run = async (): Promise<WorkspaceModeToggleResult> => {
    let failureReason: string | undefined;
    let mirrorValue: boolean | undefined;
    let workspaceConfigWritten = false;
    let workspaceConfigRemoved = false;
    let repos: string[] = [];

    try {
      if (enabled) {
        const existing = await ops.loadWorkspaceConfig(rootDir);
        if (existing?.repos.length) {
          repos = existing.repos;
          await ops.setWorkspaceModeInConfig(rootDir, true);
          mirrorValue = true;
        } else {
          repos = await ops.detectWorkspaceRepos(rootDir);
          if (repos.length === 0) {
            failureReason = "no-sub-repositories";
          } else {
            // Mirror first: a failed mirror must not leave workspace.json enabling execution.
            await ops.setWorkspaceModeInConfig(rootDir, true);
            mirrorValue = true;
            await ops.saveWorkspaceConfig(rootDir, { repos });
            workspaceConfigWritten = true;
          }
        }
      } else {
        // Disable mirror first so a partial delete cannot be auto-detected back to enabled.
        await ops.setWorkspaceModeInConfig(rootDir, false);
        mirrorValue = false;
        workspaceConfigRemoved = await ops.removeWorkspaceConfig(rootDir);
      }
    } catch (error) {
      failureReason ??= workspaceToggleFailure(enabled ? "workspace-config-write-failed" : "workspace-config-remove-failed", error);
    }

    let achieved: boolean | undefined;
    try {
      const observed = await ops.loadWorkspaceConfig(rootDir);
      repos = observed?.repos ?? [];
      achieved = repos.length > 0;
    } catch (_error) {
      return { enabled: undefined, repos, workspaceConfigWritten, workspaceConfigRemoved, failureReason: "achieved-state-unknown" };
    }

    let mirrorDivergent = false;
    if (mirrorValue !== undefined && mirrorValue !== achieved) {
      try {
        await ops.setWorkspaceModeInConfig(rootDir, achieved);
      } catch (error) {
        mirrorDivergent = true;
        failureReason ??= workspaceToggleFailure("workspace-config-mirror-compensation-failed", error);
      }
    }
    return { enabled: achieved, repos, workspaceConfigWritten, workspaceConfigRemoved, failureReason, mirrorDivergent: mirrorDivergent || undefined };
  };
  try {
    return options.lockHeld ? await run() : await withWorkspaceModeLock(rootDir, run);
  } catch (error) {
    return { enabled: undefined, repos: [], workspaceConfigWritten: false, workspaceConfigRemoved: false, failureReason: workspaceToggleFailure("workspace-toggle-failed", error) };
  }
}
