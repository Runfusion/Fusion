import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { selectIntegrationBranch, type ProjectSettings } from "@fusion/core";

const execAsync = promisify(exec);

export type IntegrationBranchSettings =
  | ProjectSettings
  | (Pick<ProjectSettings, "integrationBranch"> & { baseBranch?: unknown })
  | undefined
  | null;

export const INTEGRATION_BRANCH_FALLBACK = "main";
const warnedFallbackRootDirs = new Set<string>();

function normalize(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "");
}

/*
FNXC:IntegrationBranchReadiness 2026-08-24-00:47:
FN-183 lets inferred fallback inspect local refs and origin's remote-tracking refs through the
shared selection ladder, but never chooses an arbitrary non-origin remote such as gitlab. When
that ladder has no candidate, preserve the actionable remote diagnostic that directs operators to
add an origin alias or configure integrationBranch explicitly.
*/
function warnFallback(rootDir: string, logger: Pick<Console, "warn">, remotes: string[] = []): void {
  if (warnedFallbackRootDirs.has(rootDir)) {
    return;
  }
  warnedFallbackRootDirs.add(rootDir);
  if (remotes.length > 0) {
    const remoteList = remotes.join(", ");
    const originState = remotes.includes("origin") ? "origin/HEAD is unset" : "origin is absent";
    logger.warn(`[integration-branch] falling back to 'main' — auto-detect checks origin/HEAD, but ${originState}; found remote ${remoteList}. Add an origin alias or set integrationBranch manually.`);
    return;
  }
  logger.warn("[integration-branch] falling back to 'main' — origin/HEAD unset and no project override");
}

function resolveFromSettings(settings: IntegrationBranchSettings): string {
  const fromIntegration = normalize(settings?.integrationBranch);
  if (fromIntegration.length > 0) {
    return fromIntegration;
  }

  return normalize((settings as { baseBranch?: unknown } | null | undefined)?.baseBranch);
}

async function resolveFromOriginHead(rootDir: string): Promise<string> {
  try {
    const { stdout } = await execAsync("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return normalize(stdout);
  } catch {
    return "";
  }
}

function resolveFromOriginHeadSync(rootDir: string): string {
  try {
    const stdout = execSync("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalize(stdout);
  } catch {
    return "";
  }
}

function parseRemotes(stdout: string): string[] {
  return [...new Set(stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))];
}

async function listGitRemotes(rootDir: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git remote", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return parseRemotes(stdout);
  } catch {
    return [];
  }
}

function listGitRemotesSync(rootDir: string): string[] {
  try {
    const stdout = execSync("git remote", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseRemotes(stdout);
  } catch {
    return [];
  }
}

function parseBranchRefs(stdout: string, dropRemoteHead = false): string[] {
  return [...new Set(stdout
    .split(/\r?\n/)
    .map(normalize)
    .filter((branch) => branch.length > 0 && (!dropRemoteHead || branch !== "HEAD")))];
}

async function listBranchRefs(rootDir: string, refPrefix: string, dropRemoteHead = false): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`git for-each-ref --format=%(refname:short) ${refPrefix}`, {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return parseBranchRefs(stdout, dropRemoteHead);
  } catch {
    return [];
  }
}

function listBranchRefsSync(rootDir: string, refPrefix: string, dropRemoteHead = false): string[] {
  try {
    const stdout = execSync(`git for-each-ref --format=%(refname:short) ${refPrefix}`, {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseBranchRefs(stdout, dropRemoteHead);
  } catch {
    return [];
  }
}

/*
FNXC:IntegrationBranchReadiness 2026-08-24-00:46:
FN-183 keeps explicit project settings and origin/HEAD authoritative, then delegates every
inferred fallback to the core selection ladder shared with registration. Worktree acquisition,
merge, recovery, and branch-conflict paths have no branch naming logic beyond this resolver,
so this single boundary is their shared regression coverage rather than separate per-consumer tests.
*/
async function resolveInferredBranch(rootDir: string): Promise<ReturnType<typeof selectIntegrationBranch>> {
  const [localBranches, currentHeadOutput, remoteBranches] = await Promise.all([
    listBranchRefs(rootDir, "refs/heads/"),
    resolveCurrentHead(rootDir),
    listBranchRefs(rootDir, "refs/remotes/origin/", true),
  ]);
  return selectIntegrationBranch({
    localBranches,
    currentBranch: currentHeadOutput,
    remoteBranches,
  });
}

function resolveInferredBranchSync(rootDir: string): ReturnType<typeof selectIntegrationBranch> {
  return selectIntegrationBranch({
    localBranches: listBranchRefsSync(rootDir, "refs/heads/"),
    currentBranch: resolveCurrentHeadSync(rootDir),
    remoteBranches: listBranchRefsSync(rootDir, "refs/remotes/origin/", true),
  });
}

async function resolveCurrentHead(rootDir: string): Promise<string> {
  try {
    const { stdout } = await execAsync("git symbolic-ref --quiet --short HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return normalize(stdout);
  } catch {
    return "";
  }
}

function resolveCurrentHeadSync(rootDir: string): string {
  try {
    const stdout = execSync("git symbolic-ref --quiet --short HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalize(stdout);
  } catch {
    return "";
  }
}

function warnInferredBranch(
  rootDir: string,
  logger: Pick<Console, "warn">,
  branch: string,
  source: string,
): void {
  if (branch === INTEGRATION_BRANCH_FALLBACK || warnedFallbackRootDirs.has(rootDir)) {
    return;
  }
  warnedFallbackRootDirs.add(rootDir);
  logger.warn(`[integration-branch] adopted '${branch}' from ${source} inference instead of falling back to 'main'.`);
}

export async function resolveIntegrationBranch(
  rootDir: string,
  settings: IntegrationBranchSettings,
  opts: { logger?: Pick<Console, "warn"> } = {},
): Promise<string> {
  const logger = opts.logger ?? console;

  const fromSettings = resolveFromSettings(settings);
  if (fromSettings.length > 0) {
    return fromSettings;
  }

  const fromOrigin = await resolveFromOriginHead(rootDir);
  if (fromOrigin.length > 0) {
    return fromOrigin;
  }

  const inferred = await resolveInferredBranch(rootDir);
  if (inferred) {
    warnInferredBranch(rootDir, logger, inferred.branch, inferred.source);
    return inferred.branch;
  }

  const remotes = await listGitRemotes(rootDir);
  warnFallback(rootDir, logger, remotes);
  return INTEGRATION_BRANCH_FALLBACK;
}

export function resolveIntegrationBranchSync(
  rootDir: string,
  settings: IntegrationBranchSettings,
  opts: { logger?: Pick<Console, "warn"> } = {},
): string {
  const logger = opts.logger ?? console;

  const fromSettings = resolveFromSettings(settings);
  if (fromSettings.length > 0) {
    return fromSettings;
  }

  const fromOrigin = resolveFromOriginHeadSync(rootDir);
  if (fromOrigin.length > 0) {
    return fromOrigin;
  }

  const inferred = resolveInferredBranchSync(rootDir);
  if (inferred) {
    warnInferredBranch(rootDir, logger, inferred.branch, inferred.source);
    return inferred.branch;
  }

  const remotes = listGitRemotesSync(rootDir);
  warnFallback(rootDir, logger, remotes);
  return INTEGRATION_BRANCH_FALLBACK;
}

export function __resetIntegrationBranchCacheForTests(): void {
  warnedFallbackRootDirs.clear();
}
