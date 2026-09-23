import { exec, execFile, execFileSync, execSync } from "node:child_process";
import { promisify } from "node:util";
import { selectIntegrationBranch, type ProjectSettings } from "@fusion/core";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type IntegrationBranchSettings =
  | ProjectSettings
  | (Pick<ProjectSettings, "integrationBranch"> & { baseBranch?: unknown })
  | undefined
  | null;

// FNXC:IntegrationBranchValidation 2026-09-04-09:12:
// When `integrationBranch` (or fallback `baseBranch`) names a branch that does not exist
// locally nor in refs/remotes/origin/, `git worktree add <branch>` aborts with
// `fatal: invalid reference: <branch>`. The resolver previously trusted settings blindly
// and propagated a ghost ref to every caller (worktree acquisition, merge, recovery,
// branch-conflict paths all route through resolveIntegrationBranch). This guard verifies
// the candidate against the git index and skips the rung when missing, letting the ladder
// fall through to origin/HEAD → inferred → INTEGRATION_BRANCH_FALLBACK instead of aborting.
//
// Only the LOCAL ref form is accepted: `git worktree add <name>` requires refs/heads/<name>
// (an origin-only branch still fatals with "invalid reference"), and the merge-time CAS
// advance reads and updates refs/heads/<name>. A remote-only branch therefore falls through
// like a missing one instead of handing consumers a ref they cannot create a worktree from.
// The probe is argv-based (no shell, no interpolation: the settings value is never
// concatenated into a command string).
//
// The same local-ref requirement applies to every non-settings rung: origin/HEAD and the
// inference ladder can both surface a remote-tracking branch as a bare name, which would
// hand consumers the same unusable ref. Each candidate is verified with branchRefExists
// before being returned, so a remote-only branch falls through to the next rung.
/*
FNXC:IntegrationBranchValidation 2026-09-13-19:40:
`git show-ref --verify --quiet` exits 1 for a MISSING ref; every other failure (spawn ENOENT,
timeout, permissions, fatal) is an operational error, not evidence of absence. Treating those as
"missing" made the resolver silently pick another candidate or the fallback under a broken Git
environment, so only exit 1 is consumed as `false` and real failures propagate to the caller.
*/
function isMissingRefExit(error: unknown): boolean {
  // child_process reports numeric exit statuses via `code`; the ErrnoException typing
  // widens it to string, so compare through an untyped view. Non-numeric codes (signals,
  // ENOENT-style strings) never equal 1 and stay operational errors.
  // Node's async execFile reports the exit code on `error.code`; the sync execFileSync
  // family reports it on `error.status` (a sync missing ref throws with status=1 and no
  // numeric code). Accept both shapes so every probe falls through on a missing ref
  // instead of the sync path rethrowing it as an operational failure.
  const failure = error as { code?: unknown; status?: unknown } | null;
  return failure?.code === 1 || failure?.status === 1;
}

async function branchRefExists(rootDir: string, branch: string): Promise<boolean> {
  // Mirror materializeLocalBranch: a candidate that failed the usability rungs must fall
  // through the ladder even when a plumbing-created local ref for it exists — every
  // bare-name consumer command (worktree, merge) would still fail on that name.
  if (!branch || !isUsableBranchName(branch)) return false;
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: rootDir,
      timeout: 5_000,
    });
    return true;
  } catch (error) {
    if (!isMissingRefExit(error)) {
      throw error;
    }
    return false;
  }
}

function branchRefExistsSync(rootDir: string, branch: string): boolean {
  if (!branch || !isUsableBranchName(branch)) return false;
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: rootDir,
      timeout: 5_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (error) {
    if (!isMissingRefExit(error)) {
      throw error;
    }
    return false;
  }
}

/*
FNXC:IntegrationBranchValidation 2026-09-14-00:55 (fallback materialization):
A no-checkout or detached clone has NO local default branch (origin/HEAD points at
refs/remotes/origin/master, refs/heads/master is absent). Every non-settings rung is now
validated against the local ref, so the ladder would otherwise return the equally-missing
fallback `main` and worktree acquisition still fails with `invalid reference`. The fallback
run therefore materializes the branch from its remote-tracking start point with
`git branch --no-track` (explicitly never tracking, matching ensureIntegrationBranchLocalRef in core FN-183 —
plain `git branch <name> <remote-tracking-start>` would auto-configure upstream tracking via
branch.autoSetupMerge) before
giving up. Materialization probes the remote-tracking ref first (absent -> false, ladder falls
through), then writes; a failed write is rechecked against the local ref to absorb a lost
creation race, and the ORIGINAL write error propagates when the ref is still absent.
*/
export function isUsableBranchName(branch: string): boolean {
  // `git branch <name> <ref>` rejects any name that violates git-check-ref-format(1),
  // even with `--` (it only disambiguates options: `git branch -- -m` still fails with
  // "not a valid branch name"), and reserved names like HEAD fail at creation. Candidates
  // git would reject must fall through the ladder BEFORE probing or materializing: a
  // symbolic ref (refs/remotes/origin/HEAD exists for candidate "HEAD") or a
  // plumbing-created ref (refs/heads/-m) can pass an existence probe while every
  // bare-name consumer command would fail. Pure-JS on purpose: the mocked suites replace
  // node:child_process entirely, and the resolver must never shell out to
  // `git check-ref-format` at runtime. Parity with real git is pinned by the real-git
  // integration test (integration-branch-validate-exists.real-git.test.ts).
  if (branch.length === 0 || branch === "HEAD") {
    return false;
  }
  if (branch.startsWith("-") || branch.startsWith(".") || branch.startsWith("/")) {
    return false;
  }
  // Space and the git-special printable characters are forbidden anywhere.
  if (/[ ~^:?*[\\]/.test(branch)) {
    return false;
  }
  // ASCII control characters (0x00-0x1F, which covers tab) and DEL (0x7F) are
  // forbidden anywhere; checked by code point so the validator never embeds
  // control characters in a regex literal (no-control-regex).
  for (let i = 0; i < branch.length; i++) {
    const code = branch.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  if (branch.includes("..") || branch.includes("@{")) {
    return false;
  }
  // "@" alone is a valid branch name; inside multi-component names a lone "@"
  // component is not.
  if (branch === "@") {
    return true;
  }
  // Per-component rules: no empty component (leading/trailing/double slash), no
  // leading dot, no trailing dot, no .lock suffix. ("@" is valid as a whole name
  // and as a component on git >= 2.30 — verified against git 2.55.)
  for (const part of branch.split("/")) {
    if (part.length === 0) {
      return false;
    }
    if (part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")) {
      return false;
    }
  }
  return true;
}

async function materializeLocalBranch(rootDir: string, branch: string): Promise<boolean> {
  // Inferred and origin/HEAD candidates reach this helper without passing the settings
  // rung's isUsableBranchName check: guard here so a dash-prefixed name can never be
  // parsed by `git branch` as a switch and rename or mutate an unrelated branch.
  if (!isUsableBranchName(branch)) {
    return false;
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", remoteRef], {
      cwd: rootDir,
      timeout: 5_000,
    });
  } catch (error) {
    if (!isMissingRefExit(error)) {
      throw error;
    }
    // Remote-tracking ref absent: there is nothing to materialize from.
    return false;
  }
  try {
    await execFileAsync("git", ["branch", "--no-track", branch, remoteRef], {
      cwd: rootDir,
      timeout: 5_000,
    });
    return true;
  } catch (error) {
    // Lost a concurrent creation race or hit a transient ref-lock failure: recheck the
    // local ref; only surface the ORIGINAL write error when it is still absent.
    try {
      await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: rootDir,
        timeout: 5_000,
      });
      return true;
    } catch (recheck) {
      if (isMissingRefExit(recheck)) {
        throw error;
      }
      throw recheck;
    }
  }
}

function materializeLocalBranchSync(rootDir: string, branch: string): boolean {
  // Mirrors the async guard above: every entry point validates the name before git does.
  if (!isUsableBranchName(branch)) {
    return false;
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", remoteRef], {
      cwd: rootDir,
      timeout: 5_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch (error) {
    if (!isMissingRefExit(error)) {
      throw error;
    }
    return false;
  }
  try {
    execFileSync("git", ["branch", "--no-track", branch, remoteRef], {
      cwd: rootDir,
      timeout: 5_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (error) {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: rootDir,
        timeout: 5_000,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return true;
    } catch (recheck) {
      if (isMissingRefExit(recheck)) {
        throw error;
      }
      throw recheck;
    }
  }
}

function warnMaterializedBranch(rootDir: string, logger: Pick<Console, "warn">, branch: string): void {
  if (warnedFallbackRootDirs.has(rootDir)) {
    return;
  }
  warnedFallbackRootDirs.add(rootDir);
  logger.warn(`[integration-branch] created local branch '${branch}' from refs/remotes/origin/${branch} — the clone had no local default branch.`);
}

export const INTEGRATION_BRANCH_FALLBACK = "main";
const warnedFallbackRootDirs = new Set<string>();
const warnedSkippedCandidates = new Set<string>();

/*
FNXC:IntegrationBranchValidation 2026-09-23-18:01 (skip visibility):
A configured candidate that fails isUsableBranchName or has neither a local ref nor a
refs/remotes/origin start point used to be skipped silently: the operator only saw the
ladder land on another branch with no clue their configured branch was ignored. Each skip
now warns through the module's existing logger seam, deduplicated per rootDir and candidate
so repeated resolutions cannot spam. A materialization write error is not a skip and still
propagates unchanged.
*/
function warnSkippedCandidate(rootDir: string, logger: Pick<Console, "warn">, candidate: string, reason: string): void {
  const key = `${rootDir}\u0000${candidate}`;
  if (warnedSkippedCandidates.has(key)) {
    return;
  }
  warnedSkippedCandidates.add(key);
  logger.warn(`[integration-branch] skipped configured branch '${candidate}' — ${reason}`);
}

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

/*
FNXC:IntegrationBranchValidation 2026-09-14-01:35 (settings ladder):
The documented resolution order is `integrationBranch -> baseBranch -> origin/HEAD -> main`
(settings-scope.ts). A set-but-missing integrationBranch must not consume the settings rung
alone: the ladder yields both candidates in order so the resolver can try baseBranch next.
*/
function resolveFromSettings(settings: IntegrationBranchSettings): string[] {
  const fromIntegration = normalize(settings?.integrationBranch);
  const fromBase = normalize((settings as { baseBranch?: unknown } | null | undefined)?.baseBranch);
  if (fromIntegration.length > 0 && fromIntegration === fromBase) {
    return [fromIntegration];
  }
  return [fromIntegration, fromBase].filter((branch) => branch.length > 0);
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

/*
FNXC:EngineProcessRules 2026-09-09-07:17:
The synchronous branch-inference ladder uses only audited short git plumbing. Its execSync calls
have explicit timeout/maxBuffer bounds, and refPrefix comes only from this module's fixed local and
origin ref literals; retain their call-site allowlist entries when editing this fallback path.
*/
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
  for (const candidate of fromSettings) {
    if (!isUsableBranchName(candidate)) {
      warnSkippedCandidate(rootDir, logger, candidate, "not a usable git branch name; fix integrationBranch or baseBranch.");
      continue;
    }
    if (await branchRefExists(rootDir, candidate)) {
      return candidate;
    }
    // A configured branch is an authoritative target: a normal clone may only carry it
    // under refs/remotes/origin, so materialize it (same contract as the readiness path,
    // FN-183) instead of silently falling through to origin/HEAD or main.
    if (await materializeLocalBranch(rootDir, candidate)) {
      warnMaterializedBranch(rootDir, logger, candidate);
      return candidate;
    }
    warnSkippedCandidate(rootDir, logger, candidate, `no local refs/heads/${candidate} and no refs/remotes/origin/${candidate} to create it from; fetch the branch or fix integrationBranch/baseBranch.`);
  }

  const fromOrigin = await resolveFromOriginHead(rootDir);
  if (
    fromOrigin.length > 0 &&
    isUsableBranchName(fromOrigin) &&
    (await branchRefExists(rootDir, fromOrigin))
  ) {
    return fromOrigin;
  }
  // origin/HEAD names the remote's authoritative default: when only the
  // remote-tracking ref exists, materialize it here instead of letting local
  // inference (which prefers well-known local branches) redirect merges.
  if (fromOrigin.length > 0 && isUsableBranchName(fromOrigin)) {
    if (await materializeLocalBranch(rootDir, fromOrigin)) {
      warnMaterializedBranch(rootDir, logger, fromOrigin);
      return fromOrigin;
    }
  }

  const inferred = await resolveInferredBranch(rootDir);
  if (inferred) {
    if (isUsableBranchName(inferred.branch) && (await branchRefExists(rootDir, inferred.branch))) {
      warnInferredBranch(rootDir, logger, inferred.branch, inferred.source);
      return inferred.branch;
    }
    // The shared selector deliberately returns a remote-only branch (sole/well-known
    // origin branch); materialize it locally so no-checkout clones keep working.
    // materializeLocalBranch re-validates the name (defense in depth).
    if (await materializeLocalBranch(rootDir, inferred.branch)) {
      warnMaterializedBranch(rootDir, logger, inferred.branch);
      return inferred.branch;
    }
  }

  const remotes = await listGitRemotes(rootDir);
  const fallbackCandidate = fromOrigin.length > 0 ? fromOrigin : INTEGRATION_BRANCH_FALLBACK;
  if (await materializeLocalBranch(rootDir, fallbackCandidate)) {
    warnMaterializedBranch(rootDir, logger, fallbackCandidate);
    return fallbackCandidate;
  }
  // Materialization failed (write error, or a concurrent caller won the race). The
  // candidate may exist NOW — verify before naming it; otherwise try the plain
  // fallback, then materialize THAT, and only give up when no local ref exists.
  if (await branchRefExists(rootDir, fallbackCandidate)) {
    warnFallback(rootDir, logger, remotes);
    return fallbackCandidate;
  }
  if (fallbackCandidate !== INTEGRATION_BRANCH_FALLBACK) {
    if (await materializeLocalBranch(rootDir, INTEGRATION_BRANCH_FALLBACK)) {
      warnMaterializedBranch(rootDir, logger, INTEGRATION_BRANCH_FALLBACK);
      return INTEGRATION_BRANCH_FALLBACK;
    }
  }
  if (await branchRefExists(rootDir, INTEGRATION_BRANCH_FALLBACK)) {
    warnFallback(rootDir, logger, remotes);
    return INTEGRATION_BRANCH_FALLBACK;
  }
  throw new Error(
    `[integration-branch] could not establish a local integration branch for ${rootDir}: ` +
      `no configured, origin/HEAD, or inferred candidate has a local ref, and 'main' could not be ` +
      `verified or created from refs/remotes/origin. Set integrationBranch explicitly or fetch the default branch.`,
  );
}

export function resolveIntegrationBranchSync(
  rootDir: string,
  settings: IntegrationBranchSettings,
  opts: { logger?: Pick<Console, "warn"> } = {},
): string {
  const logger = opts.logger ?? console;

  const fromSettings = resolveFromSettings(settings);
  for (const candidate of fromSettings) {
    if (!isUsableBranchName(candidate)) {
      warnSkippedCandidate(rootDir, logger, candidate, "not a usable git branch name; fix integrationBranch or baseBranch.");
      continue;
    }
    if (branchRefExistsSync(rootDir, candidate)) {
      return candidate;
    }
    if (materializeLocalBranchSync(rootDir, candidate)) {
      warnMaterializedBranch(rootDir, logger, candidate);
      return candidate;
    }
    warnSkippedCandidate(rootDir, logger, candidate, `no local refs/heads/${candidate} and no refs/remotes/origin/${candidate} to create it from; fetch the branch or fix integrationBranch/baseBranch.`);
  }

  const fromOrigin = resolveFromOriginHeadSync(rootDir);
  if (fromOrigin.length > 0 && isUsableBranchName(fromOrigin) && branchRefExistsSync(rootDir, fromOrigin)) {
    return fromOrigin;
  }
  // origin/HEAD names the remote's authoritative default: when only the
  // remote-tracking ref exists, materialize it here instead of letting local
  // inference (which prefers well-known local branches) redirect merges.
  if (fromOrigin.length > 0 && isUsableBranchName(fromOrigin)) {
    if (materializeLocalBranchSync(rootDir, fromOrigin)) {
      warnMaterializedBranch(rootDir, logger, fromOrigin);
      return fromOrigin;
    }
  }

  const inferred = resolveInferredBranchSync(rootDir);
  if (inferred) {
    if (isUsableBranchName(inferred.branch) && branchRefExistsSync(rootDir, inferred.branch)) {
      warnInferredBranch(rootDir, logger, inferred.branch, inferred.source);
      return inferred.branch;
    }
    if (materializeLocalBranchSync(rootDir, inferred.branch)) {
      warnMaterializedBranch(rootDir, logger, inferred.branch);
      return inferred.branch;
    }
  }

  const remotes = listGitRemotesSync(rootDir);
  const fallbackCandidate = fromOrigin.length > 0 ? fromOrigin : INTEGRATION_BRANCH_FALLBACK;
  if (materializeLocalBranchSync(rootDir, fallbackCandidate)) {
    warnMaterializedBranch(rootDir, logger, fallbackCandidate);
    return fallbackCandidate;
  }
  if (branchRefExistsSync(rootDir, fallbackCandidate)) {
    warnFallback(rootDir, logger, remotes);
    return fallbackCandidate;
  }
  if (fallbackCandidate !== INTEGRATION_BRANCH_FALLBACK) {
    if (materializeLocalBranchSync(rootDir, INTEGRATION_BRANCH_FALLBACK)) {
      warnMaterializedBranch(rootDir, logger, INTEGRATION_BRANCH_FALLBACK);
      return INTEGRATION_BRANCH_FALLBACK;
    }
  }
  if (branchRefExistsSync(rootDir, INTEGRATION_BRANCH_FALLBACK)) {
    warnFallback(rootDir, logger, remotes);
    return INTEGRATION_BRANCH_FALLBACK;
  }
  throw new Error(
    `[integration-branch] could not establish a local integration branch for ${rootDir}: ` +
      `no configured, origin/HEAD, or inferred candidate has a local ref, and 'main' could not be ` +
      `verified or created from refs/remotes/origin. Set integrationBranch explicitly or fetch the default branch.`,
  );
}

export function __resetIntegrationBranchCacheForTests(): void {
  warnedFallbackRootDirs.clear();
  warnedSkippedCandidates.clear();
}
