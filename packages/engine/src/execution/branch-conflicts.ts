import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { listIntegrationBranchWorktrees } from "../merge/merger-ref-update-advance.js";

const execAsync = promisify(exec);
const FUSION_TASK_ID_TRAILER_KEY = "Fusion-Task-Id";
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export interface BranchConflictCommit {
  sha: string;
  subject: string;
}

export interface BranchCrossContaminationCommit extends BranchConflictCommit {
  foreignTaskId: string;
}

export interface BranchConflictDetails {
  branchName: string;
  conflictingWorktreePath: string;
  /**
   * FNXC:BranchCollisionRecovery 2026-09-20-00:56:
   * Bare collisions need a durable typed source because their requested path is absent.
   */
  collisionKind?: "foreign-unmerged";
  existingTipSha: string;
  strandedCommits: BranchConflictCommit[];
  startPoint: string;
  recommendedAction: string;
}

export class BranchConflictError extends Error implements BranchConflictDetails {
  readonly name = "BranchConflictError";
  readonly branchName: string;
  readonly conflictingWorktreePath: string;
  readonly existingTipSha: string;
  readonly strandedCommits: BranchConflictCommit[];
  readonly startPoint: string;
  readonly recommendedAction: string;
  readonly collisionKind?: "foreign-unmerged";

  constructor(details: BranchConflictDetails) {
    const commitSummary = details.strandedCommits.length > 0
      ? `${details.strandedCommits.length} stranded commit${details.strandedCommits.length === 1 ? "" : "s"}`
      : "no stranded commits";
    super(
      `Branch ${details.branchName} is already checked out at ${details.conflictingWorktreePath} ` +
      `(tip ${details.existingTipSha.slice(0, 12)}, ${commitSummary} since ${details.startPoint}). ` +
      details.recommendedAction,
    );
    this.branchName = details.branchName;
    this.conflictingWorktreePath = details.conflictingWorktreePath;
    this.existingTipSha = details.existingTipSha;
    this.strandedCommits = details.strandedCommits;
    this.startPoint = details.startPoint;
    this.recommendedAction = details.recommendedAction;
    this.collisionKind = details.collisionKind;
  }
}

export function isBranchConflictError(error: unknown): error is BranchConflictError {
  return error instanceof BranchConflictError;
}

export interface BranchCrossContaminationDetails {
  branchName: string;
  baseSha: string;
  taskId: string;
  foreignCommits: BranchCrossContaminationCommit[];
}

export class BranchCrossContaminationError extends Error implements BranchCrossContaminationDetails {
  readonly name = "BranchCrossContaminationError";
  readonly branchName: string;
  readonly baseSha: string;
  readonly taskId: string;
  readonly foreignCommits: BranchCrossContaminationCommit[];

  constructor(details: BranchCrossContaminationDetails) {
    super(
      `Branch ${details.branchName} contains ${details.foreignCommits.length} foreign task-attributed commits ` +
      `since base ${details.baseSha.slice(0, 12)} for ${details.taskId}`,
    );
    this.branchName = details.branchName;
    this.baseSha = details.baseSha;
    this.taskId = details.taskId;
    this.foreignCommits = details.foreignCommits;
  }
}

export interface InspectBranchConflictInput {
  repoDir: string;
  branchName: string;
  conflictingWorktreePath: string;
  requestingTaskId: string;
  ownerTaskId?: string;
  startPoint?: string;
  integrationRef?: string;
}

/*
FNXC:BranchBaseIdentity 2026-09-13-02:10:
RUFU-231 Deliverable 1 (zero-own-commit wedge): every landed/foreign proof previously measured
against the LOCAL integration identity only. A card whose branch was rebased onto
`<remote>/<integrationBranch>` sits on a commit that local `<integrationBranch>` does not contain
(local is behind), so its inherited foreign tip proved "not merged" while it was in fact landed
upstream. The wedge re-detected `live-foreign` forever because no proof could ever pass against a
mis-trusted identity. Trusted refs = the local integration branch plus its remote-tracking
counterparts (`<remote>/<branch>`), discovered from `git remote show`.
*/

/**
 * How long a resolved trusted-ref set may be reused. A merge/review sweep spends seconds re-deriving the
 * same answer; a remote topology change is an operator event, so the trade is "at most this stale", which
 * is also the only bound that survives a `git remote` edit with no invalidation hook to hang on.
 */
export const TRUSTED_INTEGRATION_REFS_TTL_MS = 15_000;
const TRUSTED_INTEGRATION_REFS_MAX = 64;

/* Keys are (repoDir, integrationRef) pairs — one entry per repository and base branch in play. */
// retention-allowlist: bounded by TRUSTED_INTEGRATION_REFS_MAX with a TRUSTED_INTEGRATION_REFS_TTL_MS expiry;
// the value is a short ref-name array, never task content.
const trustedIntegrationRefsMemo = new Map<string, { refs: string[]; expiresAt: number }>();
let trustedIntegrationRefsGitCalls = 0;

async function trustedRefsGit(repoDir: string, command: string): Promise<string> {
  trustedIntegrationRefsGitCalls++;
  return runGit(repoDir, command);
}

function trustedRefsKey(repoDir: string, integrationRef: string): string {
  return `${repoDir}\u0000${integrationRef}`;
}

/* Test-only seam: counts the GIT SUBPROCESSES this resolution spent, so both halves of the fix are
assertable — one listing per cold resolution (not one `rev-parse` per remote) and zero on a warm memo. */
export function __trustedIntegrationRefsGitCalls(): number {
  return trustedIntegrationRefsGitCalls;
}

export function __resetTrustedIntegrationRefsForTests(): void {
  trustedIntegrationRefsMemo.clear();
  trustedIntegrationRefsGitCalls = 0;
}

/*
FNXC:BranchBaseIdentity 2026-10-01-23:50 (RUFU-481):
This function was the largest git generator in the running dashboard: 13% of all process CPU in a CPU
profile taken while a single 100-card board page was loading. Each call ran `git remote` and then ONE
`git rev-parse` subprocess per configured remote — six remotes in the production checkout, so ~7
subprocesses per call — and it has six production call sites, one of them inside the CheckoutEmptinessProver
sweep that runs per entry. On a single event loop that also serves the UI, a 0.11 s SQL read was waiting
behind this and took ~11 s.

Two changes, both invisible to the verdicts:
  - ONE `git for-each-ref refs/remotes` subprocess replaces the per-remote `rev-parse` loop. Existence of
    `<remote>/<integrationRef>` IS what a remote-tracking ref's presence means, so the loop was asking git
    N times for one listing. (Batching `rev-parse --verify --quiet refA refB` is NOT that: git prints
    nothing when any argument is invalid, which would silently drop every trusted ref after the first miss.)
  - The result is memoised for TRUSTED_INTEGRATION_REFS_TTL_MS per (repoDir, integrationRef), so the rest of
    a sweep pays zero subprocesses.

The configured-remote intersection is deliberately kept rather than trusting every listing entry:
RUFU-231 was a wedge caused by a MIS-trusted integration identity, so this function may only ever trust an
identity that is both a configured remote and present locally. Local-first ordering is unchanged, so
existing landed verdicts stay byte-identical.
*/
async function probeTrustedIntegrationRefs(repoDir: string, integrationRef: string): Promise<string[]> {
  const refs = [integrationRef];
  let remotes: string[] = [];
  let listing: string[] = [];
  try {
    remotes = (await trustedRefsGit(repoDir, "git remote")).split("\n").map((line) => line.trim()).filter(Boolean);
    listing = (await trustedRefsGit(repoDir, "git for-each-ref --format='%(refname:strip=2)' refs/remotes"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return refs;
  }
  const remoteNames = new Set(remotes);
  for (const name of listing) {
    // `<remote>/<integrationRef>`: the remote is the FIRST path segment, the rest must match exactly.
    // A plain endsWith(`/${integrationRef}`) would also trust `fork/layer/main` as a counterpart of `main`.
    const separator = name.indexOf("/");
    if (separator === -1) continue;
    if (!remoteNames.has(name.slice(0, separator))) continue;
    if (name.slice(separator + 1) !== integrationRef) continue;
    if (!refs.includes(name)) refs.push(name);
  }
  return refs;
}

/**
 * Resolve the ordered set of integration identities a task branch's landed state may be proven
 * against: the local integration branch first, then each `<remote>/<integrationBranch>` that
 * exists locally. Local-first keeps existing verdicts byte-identical; the remote-tracking
 * entries are the additional trusted identity for a branch that was rebased onto it.
 */
export async function resolveTrustedIntegrationRefs(repoDir: string, integrationRef: string): Promise<string[]> {
  const key = trustedRefsKey(repoDir, integrationRef);
  const now = Date.now();
  const cached = trustedIntegrationRefsMemo.get(key);
  if (cached) {
    if (cached.expiresAt > now) return cached.refs;
    trustedIntegrationRefsMemo.delete(key);
  }
  const refs = await probeTrustedIntegrationRefs(repoDir, integrationRef);
  if (trustedIntegrationRefsMemo.size >= TRUSTED_INTEGRATION_REFS_MAX) {
    const oldest = trustedIntegrationRefsMemo.keys().next().value;
    if (oldest !== undefined) trustedIntegrationRefsMemo.delete(oldest);
  }
  trustedIntegrationRefsMemo.set(key, { refs, expiresAt: now + TRUSTED_INTEGRATION_REFS_TTL_MS });
  return refs;
}

export type TipLandedVia = "local" | "remote-tracking";

export interface TipAlreadyLandedFields {
  /**
   * Which trusted integration identity the branch tip is proven landed against. `remote-tracking`
   * marks a landing the LOCAL identity could not prove — the RUFU-231 wedge shape — and is the
   * signal consumers must require an explicit clean-checkout proof before releasing the checkout.
   */
  landedVia: TipLandedVia;
}

export type BranchConflictInspectionResult =
  | { kind: "stale" }
  | { kind: "stale-resolved" }
  | { kind: "tip-already-merged"; livePath: string | null; tipSha: string; integrationRef: string } & TipAlreadyLandedFields
  | { kind: "fully-subsumed"; livePath: string; tipSha: string }
  | { kind: "reclaimable"; livePath: string; tipSha: string; taskAttributedCommitCount: number; strandedCommits: BranchConflictCommit[] }
  | { kind: "live-foreign"; livePath: string; error: BranchConflictError };

/**
 * FNXC:WorktreeAcquisition 2026-07-16-00:00:
 * FN-8132 / #2232 needs a classifier for a bare `git worktree add -b` collision,
 * where the requested path normally does not exist. Unlike inspectBranchConflict,
 * this path must enumerate live worktrees before considering branch recovery:
 * only exclusively task-attributed unique commits are reclaimable; any foreign or
 * unattributed unique commit, including mixed history, remains protected.
 */
export type BareBranchCollisionInspectionResult =
  | { kind: "missing" }
  | { kind: "tip-already-merged"; tipSha: string; integrationRef: string } & TipAlreadyLandedFields
  | { kind: "fully-subsumed"; tipSha: string }
  | { kind: "reclaimable"; tipSha: string; taskAttributedCommitCount: number; uniqueCommitCount: number }
  | { kind: "foreign-unmerged"; tipSha: string; uniqueCommitCount: number; error: BranchConflictError }
  | { kind: "live-foreign"; tipSha: string; error: BranchConflictError };

interface UniqueBranchCommitListResult {
  commits: BranchConflictCommit[];
  mainRef: string;
  degraded: boolean;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runGit(repoDir: string, command: string): Promise<string> {
  const { stdout } = await execAsync(command, {
    cwd: repoDir,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.trim();
}

async function revParse(repoDir: string, ref: string): Promise<string> {
  return runGit(repoDir, `git rev-parse --verify ${quoteShellArg(`${ref}^{commit}`)}`);
}

async function isAncestor(repoDir: string, sha: string, ref: string): Promise<boolean> {
  try {
    await execAsync(`git merge-base --is-ancestor ${quoteShellArg(sha)} ${quoteShellArg(ref)}`, {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

async function listStrandedCommits(repoDir: string, startPoint: string, branchName: string): Promise<BranchConflictCommit[]> {
  try {
    const output = await runGit(
      repoDir,
      `git log --reverse --format=%H%x09%s ${quoteShellArg(`${startPoint}..${branchName}`)}`,
    );
    if (!output) return [];
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subjectParts] = line.split("\t");
        return { sha, subject: subjectParts.join("\t") };
      });
  } catch {
    return [];
  }
}

async function resolveBranchComparisonRef(repoDir: string, startPoint: string, branchName: string): Promise<string> {
  try {
    await revParse(repoDir, startPoint);
    await runGit(repoDir, `git merge-base ${quoteShellArg(startPoint)} ${quoteShellArg(branchName)}`);
    return startPoint;
  } catch {
    const resolved = await resolveIntegrationBranch(repoDir, undefined);
    return resolved;
  }
}

export async function listUniqueBranchCommits(
  repoDir: string,
  startPoint: string,
  branchName: string,
): Promise<UniqueBranchCommitListResult> {
  const mainRef = await resolveBranchComparisonRef(repoDir, startPoint, branchName);
  try {
    const comparisonBase = await runGit(repoDir, `git merge-base ${quoteShellArg(mainRef)} ${quoteShellArg(branchName)}`);
    const cherryOutput = await runGit(
      repoDir,
      `git cherry ${quoteShellArg(mainRef)} ${quoteShellArg(branchName)} ${quoteShellArg(comparisonBase)}`,
    );
    const plusTokens = cherryOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("+ "))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);

    const commits: BranchConflictCommit[] = [];
    for (const token of plusTokens) {
      const [sha, subject] = await Promise.all([
        runGit(repoDir, `git rev-parse --verify ${quoteShellArg(`${token}^{commit}`)}`).catch(() => token),
        runGit(repoDir, `git log -1 --format=%s ${quoteShellArg(token)}`).catch(() => ""),
      ]);
      commits.push({ sha, subject });
    }

    return {
      commits,
      mainRef,
      degraded: false,
    };
  } catch {
    return {
      commits: await listStrandedCommits(repoDir, mainRef, branchName),
      mainRef,
      degraded: true,
    };
  }
}

async function getWorktreeBranchMap(repoDir: string): Promise<Map<string, string>> {
  const output = await runGit(repoDir, "git worktree list --porcelain");
  const map = new Map<string, string>();
  let currentWorktree: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentWorktree = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch refs/heads/") && currentWorktree) {
      map.set(line.slice("branch refs/heads/".length).trim(), currentWorktree);
    }
    if (!line.trim()) {
      currentWorktree = null;
    }
  }

  return map;
}


/*
FNXC:TaskIdAttribution 2026-09-26-21:54:
Commit attribution recognised only `FN-<n>` as a task id. Card ids are minted from the PROJECT's
`settings.taskPrefix` (`resolveTaskPrefix` feeding `async-allocator.ts`), and a mission can override
it again, so any project whose prefix is not `FN` produced commits that every attribution scan below
read as "no card at all". Saneca (prefix `SANE`) is the reproduced case: `SANE-452`'s root-repo
workspace worktree path went missing, its two surviving commits (`Fusion-Task-Id: SANE-452`, subject
`SANE-452: …`) were classified `unattributed`, so `inspectBareBranchCollision` refused `reclaimable`
(`taskAttributedCommitCount === 0 && foreignOrUnattributedCount !== 0`) and answered
`foreign-unmerged` — a card could never re-acquire the checkout that holds its own work, and every
dispatch repeated the same refusal.

The token shape is the canonical id grammar id minting and integrity checks already use
(`^([A-Z][A-Z0-9]*)-(\d+)$` in `packages/core/src/tasks/task-id-integrity.ts`), matched
case-insensitively because subjects and trailers are hand-authored as well as Fusion-authored.
Anything outside that grammar stays unattributed: widening the prefix must never turn arbitrary
trailer text into a claimed owner, because `foreign` drives contamination refusal while
`unattributed` drives preservation.

Attribution lives in these helpers for a second reason: every previous site indexed
`subjectMatch[2]` behind a capture group for the commit type, so dropping that group would silently
read `undefined` and classify real work as unattributed. `extractAttributedTaskId` returns the id
instead of a match object, which removes that footgun from all five call sites.
*/
const TASK_ID_TOKEN_SOURCE = "[A-Z][A-Z0-9]*-\\d+";
const CONVENTIONAL_COMMIT_TYPES = "feat|fix|test|chore|docs|refactor|perf|build";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Conventional-subject scope naming this exact card: `fix(SANE-452): …`. */
function ownCommitSubjectPattern(taskId: string): RegExp {
  return new RegExp(`^(${CONVENTIONAL_COMMIT_TYPES})\\(${escapeRegExp(taskId)}\\):`, "i");
}

/** `Fusion-Task-Id: <taskId>` trailer for this exact card, tolerant of spacing and a missing final newline. */
function ownCommitTrailerPattern(taskId: string): RegExp {
  return new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}:\\s*${escapeRegExp(taskId)}\\s*(?:\\n|$)`, "i");
}

/* The task id is capture group 1 of BOTH generic patterns — `extractAttributedTaskId` reads `[1]`. */
const genericCommitSubjectPattern = new RegExp(`^(?:${CONVENTIONAL_COMMIT_TYPES})\\((${TASK_ID_TOKEN_SOURCE})\\):`, "i");
const genericCommitTrailerPattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}:\\s*(${TASK_ID_TOKEN_SOURCE})\\s*(?:\\n|$)`, "i");

/**
 * The card a commit claims: its `Fusion-Task-Id` trailer (authoritative) or conventional-subject
 * scope. Empty string means the commit names no card, and callers must treat that as unattributed
 * work to preserve — never as belonging to whoever is asking.
 */
export function extractAttributedTaskId(subject: string, body: string): string {
  const trailerMatch = body.match(genericCommitTrailerPattern);
  const subjectMatch = subject.match(genericCommitSubjectPattern);
  return (trailerMatch?.[1] ?? subjectMatch?.[1] ?? "").toUpperCase();
}

interface TaskAttributionSummary {
  ownCount: number;
  foreignCount: number;
}

async function summarizeTaskAttributedCommits(repoDir: string, range: string, taskId: string): Promise<TaskAttributionSummary> {
  const ownSubjectPattern = ownCommitSubjectPattern(taskId);
  const ownTrailerPattern = ownCommitTrailerPattern(taskId);
  let output = "";
  try {
    output = await runGit(repoDir, `git log --format=%H%x00%s%x00%b ${quoteShellArg(range)}`);
  } catch {
    return { ownCount: 0, foreignCount: 0 };
  }
  if (!output) return { ownCount: 0, foreignCount: 0 };

  const normalizedTaskId = taskId.toUpperCase();
  const tokens = output.split("\u0000");
  let ownCount = 0;
  let foreignCount = 0;
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const subject = tokens[i + 1] ?? "";
    const body = tokens[i + 2] ?? "";
    if (ownSubjectPattern.test(subject) || ownTrailerPattern.test(body)) {
      ownCount += 1;
      continue;
    }
    const attributedTaskId = extractAttributedTaskId(subject, body);
    if (attributedTaskId && attributedTaskId !== normalizedTaskId) {
      foreignCount += 1;
    }
  }

  return { ownCount, foreignCount };
}

export interface BranchAttributionReport {
  /** Commits whose subject matches `<type>(<taskId>):` AND carry the trailer. */
  ownTrailed: number;
  /** Commits attributed to taskId via subject but missing the Fusion-Task-Id trailer
   *  (signals: hook didn't fire — worktree was used without identity guards). */
  ownUntrailed: { sha: string; subject: string }[];
  /** Commits attributed to a different FN-id via subject or trailer (contamination). */
  foreign: { sha: string; subject: string; foreignTaskId: string }[];
  /** Commits with neither a conventional subject nor any trailer (orphaned writes). */
  unattributed: { sha: string; subject: string }[];
}

/**
 * FNXC:BranchAttribution 2026-09-29-21:50:
 * Attribution must enumerate the SAME revision set the reclaim decision counts against. That decision
 * counts `listUniqueBranchCommits` (git cherry — non-patch-equivalent commits only) while attribution
 * enumerated `git log base..branch`, which also yields merge commits, and a merge body carries the
 * trailer of the branch it merged. A fully own branch could therefore report ownTrailed=4 against
 * unique=3 and never satisfy `4 === 3`, stranding it in `foreign-unmerged` (RUFU-434). When the caller
 * supplies `commitShas` those shas are attributed instead; foreign work still surfaces because any
 * merged commit that adds content appears in the unique set. Omitting `commitShas` keeps the
 * whole-range post-session audit the executor relies on.
 */
async function collectBranchAttributionOutput(
  repoDir: string,
  branch: string,
  baseSha: string,
  commitShas?: string[],
): Promise<string> {
  const recordFormat = "%H%x1f%s%x1f%b%x1e";
  if (!commitShas || commitShas.length === 0) {
    return await runGit(
      repoDir,
      `git log --format=${recordFormat} ${quoteShellArg(`${baseSha}..${branch}`)}`,
    ).catch(() => "");
  }
  const chunkSep = String.fromCharCode(0x1e);
  const chunks: string[] = [];
  // Chunked so a long branch cannot exceed the shell argument limit; one git call per chunk.
  for (let i = 0; i < commitShas.length; i += 200) {
    const batch = commitShas.slice(i, i + 200).map((sha) => quoteShellArg(sha)).join(" ");
    if (!batch) continue;
    // --no-walk keeps each listed commit's own message and never pulls in ancestors.
    const out = await runGit(repoDir, `git log --no-walk=unsorted --format=${recordFormat} ${batch}`).catch(() => "");
    if (out.trim()) chunks.push(out.trim());
  }
  return chunks.join(chunkSep);
}

/**
 * Post-session audit of every commit in `base..branch`. Used by the executor
 * immediately after a step-session completes to detect three classes of
 * contamination early — long before merge time:
 *
 *   1. ownUntrailed: agent committed legitimately but the commit-msg hook
 *      didn't fire (missing fusion-task-id, --no-verify, plumbing commit).
 *   2. foreign: another task's work landed on this branch (FN-5233 pattern).
 *   3. unattributed: commit lacks both subject prefix and trailer (often a
 *      hand-merged commit or plumbing-driven update).
 *
 * Pass `commitShas` to attribute exactly the revisions the branch adds (the `git cherry` unique set)
 * instead of the whole `base..branch` range — required whenever the caller compares these counts
 * against that set, so both sides count the same commits.
 *
 * Returns counts/details rather than throwing so callers can decide whether
 * to refuse, warn, or just audit.
 */
export async function reportBranchAttribution(
  repoDir: string,
  branch: string,
  baseSha: string,
  taskId: string,
  commitShas?: string[],
): Promise<BranchAttributionReport> {
  const report: BranchAttributionReport = { ownTrailed: 0, ownUntrailed: [], foreign: [], unattributed: [] };
  const output = await collectBranchAttributionOutput(repoDir, branch, baseSha, commitShas);
  if (!output) return report;
  const ownSubjectPattern = ownCommitSubjectPattern(taskId);
  const ownTrailerPattern = ownCommitTrailerPattern(taskId);
  const normalizedTaskId = taskId.toUpperCase();
  for (const record of output.split("").map((entry) => entry.trim()).filter(Boolean)) {
    const [sha = "", subject = "", body = ""] = record.split("");
    const attributedTaskId = extractAttributedTaskId(subject, body);
    if (attributedTaskId && attributedTaskId !== normalizedTaskId) {
      report.foreign.push({ sha, subject, foreignTaskId: attributedTaskId });
      continue;
    }
    if (!attributedTaskId) {
      report.unattributed.push({ sha, subject });
      continue;
    }
    const trailerPresent = ownTrailerPattern.test(body);
    const subjectPresent = ownSubjectPattern.test(subject);
    if (subjectPresent && trailerPresent) {
      report.ownTrailed += 1;
    } else if (subjectPresent && !trailerPresent) {
      report.ownUntrailed.push({ sha, subject });
    } else {
      // trailer present, subject not — counts as trailed-own.
      report.ownTrailed += 1;
    }
  }
  return report;
}

/**
 * True iff `branch`'s tip commit carries a `Fusion-Task-Id: <taskId>` trailer.
 * Used as the cheap "is this branch ref authoritative for this task" probe
 * at merge handoff so that HEAD drift (detached, wrong branch) can recover
 * via a safe re-attach instead of refusing the handoff outright.
 */
export async function branchTipCarriesTaskIdTrailer(
  repoDir: string,
  branch: string,
  taskId: string,
): Promise<boolean> {
  try {
    const body = await runGit(repoDir, `git log -1 --pretty=%B ${quoteShellArg(branch)}`);
    const escaped = escapeRegExp(taskId);
    const pattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}: ${escaped}\\s*(?:\\n|$)`);
    return pattern.test(body);
  } catch {
    return false;
  }
}

/**
 * Whole-branch authority check: the branch ref exists, its tip carries the
 * task's Fusion-Task-Id trailer.
 *
 * Returns `{ ok: true }` when safe to treat the branch ref as authoritative
 * for `taskId`. On failure, returns `{ ok: false, reason }` so callers can
 * log/audit why the gentle recovery was refused.
 */
export async function isBranchAuthoritativeForTask(
  repoDir: string,
  branch: string,
  taskId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await revParse(repoDir, `refs/heads/${branch}`);
  } catch {
    return { ok: false, reason: "branch-ref-missing" };
  }
  const tipCarriesTrailer = await branchTipCarriesTaskIdTrailer(repoDir, branch, taskId);
  if (!tipCarriesTrailer) {
    return { ok: false, reason: "tip-missing-task-trailer" };
  }
  return { ok: true };
}

export async function assertCleanBranchAtBase(
  repoDir: string,
  branchName: string,
  baseSha: string,
  taskId: string,
): Promise<void> {
  // Foreign task attribution in a branch range is informational only. Stacked
  // task branches and cherry-equivalent commits are handled by merge/display
  // attribution, not by failing worktree acquisition or branch authority.
  void repoDir;
  void branchName;
  void baseSha;
  void taskId;
}

export interface ClassifyBootstrapMisbindingInput {
  repoDir: string;
  branchName: string;
  baseSha: string;
  taskId: string;
  /**
   * Optional and advisory only. The classifier derives the foreign-commit
   * count from its own `git log baseSha..branchName` walk because callers
   * such as the auto-recovery fallback in `branch-worktree.ts` only have a
   * `BranchConflictInspectionResult` (no foreign-commit list) and used to
   * pass `[]`, which silently disabled the predicate.
   */
  foreignCommits?: BranchCrossContaminationCommit[];
}

export interface ClassifyBootstrapMisbindingResult {
  isBootstrapMisbinding: boolean;
  ownCommitCount: number;
  foreignCommitCount: number;
  nonAttributedCount: number;
}

export async function classifyBootstrapMisbinding(
  input: ClassifyBootstrapMisbindingInput,
): Promise<ClassifyBootstrapMisbindingResult> {
  const { repoDir, branchName, baseSha, taskId } = input;
  const output = await runGit(repoDir, `git log --format=%H%x1f%s%x1f%b ${quoteShellArg(`${baseSha}..${branchName}`)}`)
    .catch(() => "");
  if (!output) {
    return {
      isBootstrapMisbinding: false,
      ownCommitCount: 0,
      foreignCommitCount: 0,
      nonAttributedCount: 0,
    };
  }

  const ownSubjectPattern = ownCommitSubjectPattern(taskId);
  const ownTrailerPattern = ownCommitTrailerPattern(taskId);

  let ownCommitCount = 0;
  let nonAttributedCount = 0;
  let foreignCommitCount = 0;
  for (const line of output.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const [, subject = "", body = ""] = line.split("\u001f");
    if (ownSubjectPattern.test(subject) || ownTrailerPattern.test(body)) {
      ownCommitCount += 1;
      continue;
    }

    const attributedTaskId = extractAttributedTaskId(subject, body);
    if (!attributedTaskId) {
      nonAttributedCount += 1;
    } else {
      foreignCommitCount += 1;
    }
  }

  return {
    isBootstrapMisbinding: foreignCommitCount > 0 && ownCommitCount === 0 && nonAttributedCount === 0,
    ownCommitCount,
    foreignCommitCount,
    nonAttributedCount,
  };
}

export interface ClassifyForeignCommitsInput {
  repoDir: string;
  branchName: string;
  baseSha: string;
  foreignCommits: BranchCrossContaminationCommit[];
  mainRef?: string;
  /**
   * Trusted integration identities for landedness (local integration branch first, then
   * `<remote>/<integration>` refs). RUFU-231: a foreign commit landed on origin/main must
   * classify `alreadyUpstream` even when local main never received it.
   */
  trustedRefs?: string[];
}

export interface ClassifyForeignCommitsResult {
  /**
   * Commits whose patch-id already exists on main and are safe to drop.
   */
  alreadyUpstream: BranchCrossContaminationCommit[];
  /**
   * Commits whose patch-id is unique and require human adjudication.
   */
  unique: BranchCrossContaminationCommit[];
}

export type ForeignOnlyContaminationKind =
  | "foreign-only-no-own-work"
  | "foreign-only-already-upstream"
  | "ambiguous"
  | "clean";

export interface ClassifyForeignOnlyContaminationInput {
  repoDir: string;
  branchName: string;
  baseSha: string;
  taskId: string;
  mainRef?: string;
  /**
   * Trusted integration identities (local integration branch first, then `<remote>/<integration>`
   * refs). RUFU-231: landedness of foreign commits must consider every trusted identity so a
   * commit landed on origin/main classifies `alreadyUpstream` against a behind local identity.
   */
  trustedRefs?: string[];
}

export interface ClassifyForeignOnlyContaminationResult {
  kind: ForeignOnlyContaminationKind;
  ownCommitCount: number;
  foreignCommitCount: number;
  nonAttributedCount: number;
  alreadyUpstreamShas: string[];
  uniqueShas: string[];
}

async function buildUpstreamPatchIdSet(repoDir: string, ref: string): Promise<Set<string>> {
  const upstreamPatchIdsOutput = await runGit(
    repoDir,
    `git rev-list ${quoteShellArg(ref)} | while read c; do git show "$c" | git patch-id --stable; done`,
  ).catch(() => "");

  return new Set(
    upstreamPatchIdsOutput
      .split("\n")
      .map((line) => line.trim().split(" ")[0])
      .filter(Boolean),
  );
}

/*
FNXC:BranchBaseIdentity 2026-09-13-02:25:
RUFU-231: patch-id landedness is evaluated against EVERY trusted integration identity — a
commit replayed by `rebaseNewWorktreeOntoRemote` (or rebase/merge elsewhere) keeps its patch
against `<remote>/<integration>` even though the local identity never received it. A commit is
landed when any trusted ref carries its patch; sets are built lazily so the common local hit
never pays for the remote scan.
*/
async function commitPatchesLandedOnAnyTrustedRef(
  repoDir: string,
  shas: string[],
  trustedRefs: string[],
): Promise<Set<string>> {
  const landed = new Set<string>();
  if (shas.length === 0) return landed;
  const builtSets: Array<{ ref: string; patchIds: Set<string> }> = [];
  const patchIdsFor = async (ref: string) => {
    const cached = builtSets.find((entry) => entry.ref === ref);
    if (cached) return cached.patchIds;
    const patchIds = await buildUpstreamPatchIdSet(repoDir, ref);
    builtSets.push({ ref, patchIds });
    return patchIds;
  };
  const shaPatchId = new Map<string, string>();
  for (const sha of shas) {
    const patchIdLine = await runGit(repoDir, `git show ${quoteShellArg(sha)} | git patch-id --stable`).catch(() => "");
    shaPatchId.set(sha, patchIdLine.trim().split(" ")[0]);
  }
  for (const sha of shas) {
    const patchId = shaPatchId.get(sha);
    if (!patchId) continue;
    for (const ref of trustedRefs) {
      const patchIds = await patchIdsFor(ref);
      if (patchIds.has(patchId)) {
        landed.add(sha);
        break;
      }
    }
  }
  return landed;
}

async function classifyForeignCommitsViaPatchId(
  repoDir: string,
  mainRef: string,
  commits: BranchCrossContaminationCommit[],
  trustedRefs?: string[],
): Promise<ClassifyForeignCommitsResult> {
  const refs = trustedRefs && trustedRefs.length > 0 ? trustedRefs : [mainRef];
  const landed = await commitPatchesLandedOnAnyTrustedRef(repoDir, commits.map((commit) => commit.sha), refs);
  const alreadyUpstream: BranchCrossContaminationCommit[] = [];
  const unique: BranchCrossContaminationCommit[] = [];
  for (const commit of commits) {
    if (landed.has(commit.sha)) {
      alreadyUpstream.push(commit);
    } else {
      unique.push(commit);
    }
  }

  return { alreadyUpstream, unique };
}

export async function classifyForeignCommits(
  input: ClassifyForeignCommitsInput,
): Promise<ClassifyForeignCommitsResult> {
  const resolvedIntegrationBranch = await resolveIntegrationBranch(input.repoDir, undefined);
  const { repoDir, branchName, baseSha, foreignCommits } = input;
  const mainRef = input.mainRef?.trim() || resolvedIntegrationBranch;
  const trustedRefs = input.trustedRefs && input.trustedRefs.length > 0
    ? input.trustedRefs
    : await resolveTrustedIntegrationRefs(repoDir, mainRef);
  const targetBySha = new Map(foreignCommits.map((commit) => [commit.sha, commit]));
  if (targetBySha.size === 0) {
    return { alreadyUpstream: [], unique: [] };
  }

  try {
    const comparisonBase = baseSha || await runGit(repoDir, `git merge-base ${quoteShellArg(mainRef)} ${quoteShellArg(branchName)}`);
    /*
    FNXC:BranchBaseIdentity 2026-09-13-02:30:
    RUFU-231: landedness proof per trusted ref. Three channels, any one sufficient:
    1. reachability — a foreign commit already ON a trusted ref never appears in that ref's
       `git cherry` output (cherry enumerates `branch ^upstream` only), so prove it directly.
    2. `git cherry` '-' — patch-equivalent copy landed on that ref (rebase replays).
    3. everything else falls to the trusted-ref patch-id fallback below. A '+' from a BEHIND
       ref must not foreclose the other refs' patch sets — that is exactly how the wedge
       classification turned origin/main's landed commit into "unique".
    */
    const landedSha = new Set<string>();
    const resolveFullSha = (token: string): string | null => {
      if (targetBySha.has(token)) return token;
      const match = foreignCommits.find((commit) => commit.sha.startsWith(token));
      return match?.sha ?? null;
    };
    let sawAnyOutput = false;
    for (const trustedRef of trustedRefs) {
      for (const commit of foreignCommits) {
        if (landedSha.has(commit.sha)) continue;
        if (await isAncestor(repoDir, commit.sha, trustedRef)) landedSha.add(commit.sha);
      }
      const output = await runGit(
        repoDir,
        `git cherry ${quoteShellArg(trustedRef)} ${quoteShellArg(branchName)} ${quoteShellArg(comparisonBase)}`,
      ).catch(() => "");
      if (!output.trim()) continue;
      sawAnyOutput = true;
      for (const rawLine of output.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const [marker, token] = line.split(/\s+/, 2);
        if (!token) continue;
        if (marker !== "-") continue;
        const sha = resolveFullSha(token);
        if (sha) landedSha.add(sha);
      }
    }
    if (!sawAnyOutput && landedSha.size === 0) {
      return classifyForeignCommitsViaPatchId(repoDir, mainRef, foreignCommits, trustedRefs);
    }
    const unresolved = foreignCommits.filter((commit) => !landedSha.has(commit.sha));
    const unresolvedClassified = unresolved.length > 0
      ? await classifyForeignCommitsViaPatchId(repoDir, mainRef, unresolved, trustedRefs)
      : { alreadyUpstream: [], unique: [] };
    return {
      alreadyUpstream: [
        ...foreignCommits.filter((commit) => landedSha.has(commit.sha)),
        ...unresolvedClassified.alreadyUpstream,
      ],
      unique: unresolvedClassified.unique,
    };
  } catch {
    return classifyForeignCommitsViaPatchId(repoDir, mainRef, foreignCommits, trustedRefs);
  }
}

export interface ClassifyMisroutedForeignCommitInput {
  repoDir: string;
  sha: string;
  commitSubject: string;
  commitBody: string;
  currentTaskId: string;
}

export interface ClassifyMisroutedForeignCommitResult {
  misrouted: boolean;
  foreignTaskId?: string;
  paths: string[];
}

export async function classifyMisroutedForeignCommit(
  input: ClassifyMisroutedForeignCommitInput,
): Promise<ClassifyMisroutedForeignCommitResult> {
  const { repoDir, sha, commitSubject, commitBody, currentTaskId } = input;
  const foreignTaskId = extractAttributedTaskId(commitSubject, commitBody);
  if (!foreignTaskId || foreignTaskId === currentTaskId.toUpperCase()) {
    return { misrouted: false, paths: [] };
  }

  const pathsOutput = await runGit(
    repoDir,
    `git diff-tree --root --no-commit-id --name-only -r ${quoteShellArg(sha)}`,
  ).catch(() => "");
  const paths = pathsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    misrouted: paths.length > 0 && paths.every((path) => path.startsWith(".changeset/")),
    foreignTaskId,
    paths,
  };
}

export async function classifyForeignOnlyContamination(
  input: ClassifyForeignOnlyContaminationInput,
): Promise<ClassifyForeignOnlyContaminationResult> {
  const resolvedIntegrationBranch = await resolveIntegrationBranch(input.repoDir, undefined);
  const { repoDir, branchName, baseSha, taskId } = input;
  const mainRef = input.mainRef?.trim() || resolvedIntegrationBranch;
  // FN-5090 hotfix: stale baseSha (older than the actual fork point with main) caused
  // classifyForeignOnlyContamination to see commits that have since been merged into main
  // as "foreign", returning kind:"ambiguous" and stranding the task. Prefer the live
  // merge-base when it is a descendant of the persisted baseSha.
  let effectiveBaseSha = baseSha;
  try {
    const mergeBaseRaw = await runGit(repoDir, `git merge-base ${quoteShellArg(branchName)} ${quoteShellArg(mainRef)}`);
    const liveMergeBase = mergeBaseRaw.trim();
    if (liveMergeBase && liveMergeBase !== baseSha) {
      // Use live merge-base if it is a descendant of baseSha (newer)
      const ancestryCheck = await runGit(
        repoDir,
        `git merge-base --is-ancestor ${quoteShellArg(baseSha)} ${quoteShellArg(liveMergeBase)} && echo yes || echo no`,
      ).catch(() => "no");
      if (ancestryCheck.trim() === "yes") {
        effectiveBaseSha = liveMergeBase;
      }
    }
  } catch {
    // fall back to persisted baseSha on any git failure
  }
  const persistedRangeOutput = await runGit(repoDir, `git log --format=%H%x1f%s%x1f%b ${quoteShellArg(`${baseSha}..${branchName}`)}`)
    .catch(() => "");
  const foreignCommits: BranchCrossContaminationCommit[] = [];
  for (const line of persistedRangeOutput.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const [sha, subject, body] = line.split("\u001f");
    const attributedTaskId = extractAttributedTaskId(subject ?? "", body ?? "");
    if (attributedTaskId && attributedTaskId !== taskId.toUpperCase()) {
      foreignCommits.push({ sha, subject: subject ?? "", foreignTaskId: attributedTaskId });
    }
  }

  const bootstrap = await classifyBootstrapMisbinding({
    repoDir,
    branchName,
    baseSha: effectiveBaseSha,
    taskId,
    foreignCommits,
  });

  if (foreignCommits.length === 0) {
    return {
      kind: "clean",
      ownCommitCount: bootstrap.ownCommitCount,
      foreignCommitCount: 0,
      nonAttributedCount: bootstrap.nonAttributedCount,
      alreadyUpstreamShas: [],
      uniqueShas: [],
    };
  }

  const foreignClassification = await classifyForeignCommits({
    repoDir,
    branchName,
    baseSha: effectiveBaseSha,
    foreignCommits,
    mainRef,
    trustedRefs: input.trustedRefs,
  });

  const result: ClassifyForeignOnlyContaminationResult = {
    kind: "ambiguous",
    ownCommitCount: bootstrap.ownCommitCount,
    foreignCommitCount: foreignCommits.length,
    nonAttributedCount: bootstrap.nonAttributedCount,
    alreadyUpstreamShas: foreignClassification.alreadyUpstream.map((entry) => entry.sha),
    uniqueShas: foreignClassification.unique.map((entry) => entry.sha),
  };

  if (result.ownCommitCount === 0 && result.nonAttributedCount === 0 && result.foreignCommitCount > 0) {
    result.kind = result.uniqueShas.length === 0
      ? "foreign-only-already-upstream"
      : "foreign-only-no-own-work";
    return result;
  }

  if (result.ownCommitCount > 0 || result.nonAttributedCount > 0) {
    result.kind = "ambiguous";
    return result;
  }

  result.kind = "clean";
  return result;
}

export interface ReanchorBranchToBaseInput {
  repoDir: string;
  worktreePath: string;
  branchName: string;
  baseSha: string;
  taskId: string;
}

export interface ReanchorBranchToBaseResult {
  previousTipSha: string;
  newTipSha: string;
}

/**
 * Re-anchor a task branch to base while handling already-at-base worktrees.
 *
 * Fast-path: when both worktree HEAD and branch tip already equal baseSha,
 * avoid detach/rebranch churn (`checkout -B` can fail with worktree-binding
 * conflicts) and only attempt lightweight branch re-association.
 */
export async function reanchorBranchToBase(
  input: ReanchorBranchToBaseInput,
): Promise<ReanchorBranchToBaseResult> {
  const { repoDir, worktreePath, branchName, baseSha, taskId } = input;
  const previousTipSha = await revParse(repoDir, branchName);

  try {
    await execAsync("git checkout -- .", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch {
    // best-effort: worktree may already be clean
  }

  await execAsync("git clean -fd", {
    cwd: worktreePath,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });

  const worktreeHeadSha = await revParse(worktreePath, "HEAD");
  const branchTipSha = previousTipSha;
  const worktreeHeadBranch = await runGit(worktreePath, "git symbolic-ref --quiet --short HEAD").catch(() => "");

  if (worktreeHeadSha === baseSha && branchTipSha === baseSha) {
    if (worktreeHeadBranch !== branchName) {
      try {
        await runGit(worktreePath, `git checkout ${quoteShellArg(branchName)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already used by worktree")) {
          throw error;
        }
      }
    }
    await assertCleanBranchAtBase(repoDir, branchName, baseSha, taskId);
    return {
      previousTipSha,
      newTipSha: previousTipSha,
    };
  }

  await runGit(worktreePath, `git checkout --detach ${quoteShellArg(baseSha)}`);
  await runGit(worktreePath, `git checkout -B ${quoteShellArg(branchName)} ${quoteShellArg(baseSha)}`);
  await assertCleanBranchAtBase(repoDir, branchName, baseSha, taskId);

  return {
    previousTipSha,
    newTipSha: await revParse(repoDir, branchName),
  };
}

export interface AutoRecoverCrossContaminationInput {
  repoDir: string;
  branchName: string;
  baseSha: string;
  taskId: string;
  shasToDrop: string[];
  mainRef?: string;
}

export interface AutoRecoverCrossContaminationResult {
  newTipSha: string;
  droppedShas: string[];
}

export async function autoRecoverCrossContamination(
  input: AutoRecoverCrossContaminationInput,
): Promise<AutoRecoverCrossContaminationResult> {
  const { repoDir, branchName, baseSha, taskId, shasToDrop } = input;
  const dropSet = new Set(shasToDrop);
  if (dropSet.size === 0) {
    throw new Error("autoRecoverCrossContamination requires at least one SHA to drop");
  }

  const originalTip = await revParse(repoDir, branchName);
  /*
  FNXC:LandingAdvance 2026-10-11-22:05:
  This recovery detaches HEAD, replays commits, CAS-re-points `refs/heads/<branch>`, and then
  checks the branch back out HERE — so index and working tree follow the rewritten tip only in
  this worktree. If a different worktree owns the branch, the same update-ref would leave that
  checkout's ref ahead of its index and produce the phantom staged-revert diff again (STAS-292,
  the `stas-190` signature). Refuse before mutating anything instead.
  */
  const otherOwners = (await listIntegrationBranchWorktrees({ rootDir: repoDir, integrationBranch: branchName }))
    .map((entry) => entry.path)
    .filter((path) => resolve(path) !== resolve(repoDir));
  if (otherOwners.length > 0) {
    throw new Error(
      `branch rewrite refused: ${branchName} is checked out in ${otherOwners.join(", ")}, `
      + `and this recovery can only re-point a branch from the worktree that owns it`,
    );
  }
  const commitListOutput = await runGit(repoDir, `git rev-list --reverse ${quoteShellArg(`${baseSha}..${branchName}`)}`)
    .catch(() => "");
  const commits = commitListOutput.split("\n").map((line) => line.trim()).filter(Boolean);

  await runGit(repoDir, `git checkout --detach ${quoteShellArg(baseSha)}`);

  try {
    for (const sha of commits) {
      if (dropSet.has(sha)) continue;
      await execAsync(`git cherry-pick ${quoteShellArg(sha)}`, {
        cwd: repoDir,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      });
    }

    const newTip = await revParse(repoDir, "HEAD");
    /*
    FNXC:LandingAdvance 2026-10-12-01:22 (STAS-292):
    The rewrite names itself in the reflog. A message-less `update-ref` is the forensic hole
    this card exists to close — `reflog show refs/heads/main` on a trunk that had been landed
    by the old path carried empty subjects, so an incident could not be dated or attributed
    (STAS-233, re-measured at Step 0). `--create-reflog` so the trail exists even for a branch
    that never had one.
    */
    const rewriteMessage = `branch rewrite: ${taskId} ${newTip} (dropped ${dropSet.size} foreign commit(s))`;
    await runGit(repoDir, `git update-ref --create-reflog -m ${quoteShellArg(rewriteMessage)} ${quoteShellArg(`refs/heads/${branchName}`)} ${quoteShellArg(newTip)} ${quoteShellArg(originalTip)}`);
    await runGit(repoDir, `git checkout ${quoteShellArg(branchName)}`);
  } catch (error) {
    await runGit(repoDir, `git cherry-pick --abort`).catch(() => undefined);
    await runGit(repoDir, `git checkout ${quoteShellArg(branchName)}`).catch(() => undefined);
    throw error;
  }

  await assertCleanBranchAtBase(repoDir, branchName, baseSha, taskId);

  return {
    newTipSha: await revParse(repoDir, branchName),
    droppedShas: Array.from(dropSet),
  };
}

/*
FNXC:TaskIdAttribution 2026-09-26-21:54:
Deliberately still `FN-<n>`-only, unlike the commit-attribution helpers above. Every consumer of this
derivation gates a git DELETION (`self-healing.ts` fully-subsumed auto-reclaim and stale-active-branch
reclaim, plus `inspectBranchConflict`'s self-owned fallback), so widening it would grant reclaim
authority to non-`FN` projects rather than restore information they already had. Commit-level
attribution needs no such authority grant and is what unblocks acquisition for a non-`FN` prefix, so
it is fixed there. Widening this belongs on a card carrying its own destructive-path proof.
*/
export function deriveTaskIdFromFusionBranch(branchName: string): string | null {
  const match = /^fusion\/(fn-\d+)$/i.exec(branchName.trim());
  if (!match) return null;
  return match[1].toUpperCase();
}

async function isZeroUniqueCommitBranchViaPatchIdFallback(
  repoDir: string,
  startPoint: string,
  branchName: string,
  mainRef: string,
  trustedRefs?: string[],
): Promise<boolean> {
  const range = `${startPoint}..${branchName}`;
  const branchCommitsOutput = await runGit(repoDir, `git rev-list ${quoteShellArg(range)}`).catch(() => "");
  const branchCommitShas = branchCommitsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (branchCommitShas.length === 0) {
    return true;
  }

  /*
  FNXC:BranchBaseIdentity 2026-09-13-02:35:
  RUFU-231: landedness against ANY trusted integration identity. A branch rebased onto
  `<remote>/<integration>` keeps every commit's patch there even though the behind local
  identity carries none of it; measuring only the local identity kept such branches out of
  `fully-subsumed` and inside the `live-foreign` wedge.
  */
  const refs = trustedRefs && trustedRefs.length > 0 ? trustedRefs : [mainRef];
  const landed = await commitPatchesLandedOnAnyTrustedRef(repoDir, branchCommitShas, refs);
  return landed.size === branchCommitShas.length;
}

/**
 * Inspect a branch-name collision from `git worktree add -b` without requiring
 * the requested destination path to exist. Existing callers must use
 * inspectBranchConflict, whose missing-path short-circuit is intentionally kept.
 */
export async function inspectBareBranchCollision(
  input: InspectBranchConflictInput,
): Promise<BareBranchCollisionInspectionResult> {
  try {
    await runGit(input.repoDir, "git worktree prune");
  } catch {
    // Best-effort: the mapping check below still protects a registered live worktree.
  }

  try {
    await revParse(input.repoDir, `refs/heads/${input.branchName}`);
  } catch {
    return { kind: "missing" };
  }

  let worktreeMap = await getWorktreeBranchMap(input.repoDir);
  let livePath = worktreeMap.get(input.branchName);
  if (livePath && !existsSync(livePath)) {
    try {
      await runGit(input.repoDir, "git worktree prune");
    } catch {
      // Best-effort: a still-present mapping is not considered live below.
    }
    worktreeMap = await getWorktreeBranchMap(input.repoDir);
    livePath = worktreeMap.get(input.branchName);
  }

  const tipSha = await revParse(input.repoDir, input.branchName);
  const requestedIntegrationRef = input.integrationRef ?? await resolveIntegrationBranch(input.repoDir, undefined);
  const integrationRef = await resolveBranchComparisonRef(input.repoDir, requestedIntegrationRef, input.branchName);
  // FNXC:BranchConflictReachability 2026-10-01-05:33:
  // FN-9434 requires destructive recovery to compare against the live integration
  // branch. A task's recorded start point can predate commits already incorporated
  // upstream and must never make those inherited commits appear stranded.
  const uniqueCommitResult = await listUniqueBranchCommits(input.repoDir, integrationRef, input.branchName);

  if (livePath && existsSync(livePath)) {
    return {
      kind: "live-foreign",
      tipSha,
      error: new BranchConflictError({
        branchName: input.branchName,
        conflictingWorktreePath: livePath,
        existingTipSha: tipSha,
        strandedCommits: uniqueCommitResult.commits,
        startPoint: uniqueCommitResult.mainRef,
        recommendedAction: "Inspect the live conflicting worktree before retrying.",
      }),
    };
  }

  /*
  FNXC:BranchBaseIdentity 2026-09-13-02:20:
  RUFU-231: bare-collision landing proof consults every trusted integration identity
  (local first, then `<remote>/<integration>`). Recreating from the caller's startPoint
  after a remote-landed tip discards only commits that are already upstream — zero loss.
  */
  const trustedRefs = await resolveTrustedIntegrationRefs(input.repoDir, integrationRef);
  for (const trustedRef of trustedRefs) {
    if (await isAncestor(input.repoDir, tipSha, trustedRef)) {
      return {
        kind: "tip-already-merged",
        tipSha,
        integrationRef: trustedRef,
        landedVia: trustedRef === integrationRef ? "local" : "remote-tracking",
      };
    }
  }

  const zeroUnique = uniqueCommitResult.commits.length === 0 && (
    !uniqueCommitResult.degraded || await isZeroUniqueCommitBranchViaPatchIdFallback(
      input.repoDir,
      integrationRef,
      input.branchName,
      uniqueCommitResult.mainRef,
      trustedRefs,
    )
  );
  if (zeroUnique) {
    return { kind: "fully-subsumed", tipSha };
  }

  const attribution = await reportBranchAttribution(
    input.repoDir,
    input.branchName,
    uniqueCommitResult.mainRef,
    input.requestingTaskId,
    // FNXC:BranchAttribution 2026-09-29-21:50: attribute the same unique set the equality below counts,
    // so a branch whose own merge commit carries its own trailer can still be reclaimed.
    uniqueCommitResult.commits.map((commit) => commit.sha),
  );
  const taskAttributedCommitCount = attribution.ownTrailed + attribution.ownUntrailed.length;
  const foreignOrUnattributedCount = attribution.foreign.length + attribution.unattributed.length;
  // Both sides of this equality now come from the same unique revision set, so a merge commit can no
  // longer inflate the attribution side and make an entirely own branch look contaminated.
  if (
    taskAttributedCommitCount === uniqueCommitResult.commits.length
    && foreignOrUnattributedCount === 0
  ) {
    return {
      kind: "reclaimable",
      tipSha,
      taskAttributedCommitCount,
      uniqueCommitCount: uniqueCommitResult.commits.length,
    };
  }

  return {
    kind: "foreign-unmerged",
    tipSha,
    uniqueCommitCount: uniqueCommitResult.commits.length,
    error: new BranchConflictError({
      branchName: input.branchName,
      conflictingWorktreePath: input.conflictingWorktreePath,
      existingTipSha: tipSha,
      strandedCommits: uniqueCommitResult.commits,
      startPoint: uniqueCommitResult.mainRef,
      recommendedAction: "Preserve this unregistered branch and inspect its foreign or unattributed commits before retrying.",
      collisionKind: "foreign-unmerged",
    }),
  };
}

/**
 * Proof that a checkout holds nothing uncommitted: an empty `git status --porcelain`
 * (untracked files included, ignored excluded). Any doubt — a failing read, a dirty tree —
 * returns false, because a checkout release must never destroy work it cannot prove absent.
 * RUFU-231: required before releasing a checkout whose landedness was only proven against
 * the remote-tracking identity (`landedVia: "remote-tracking"`).
 */
export async function taskWorktreeCheckoutIsClean(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout.trim() === "";
  } catch {
    return false;
  }
}

export async function inspectBranchConflict(
  input: InspectBranchConflictInput,
): Promise<BranchConflictInspectionResult> {
  if (!existsSync(input.conflictingWorktreePath)) {
    return { kind: "stale" };
  }

  try {
    await runGit(input.repoDir, "git worktree prune");
  } catch {
    // best-effort
  }

  let worktreeMap = await getWorktreeBranchMap(input.repoDir);
  let livePath = worktreeMap.get(input.branchName);

  try {
    await revParse(input.repoDir, `refs/heads/${input.branchName}`);
  } catch {
    return { kind: "stale-resolved" };
  }

  if (livePath && !existsSync(livePath)) {
    try {
      await runGit(input.repoDir, "git worktree prune");
    } catch {
      // best-effort
    }
    worktreeMap = await getWorktreeBranchMap(input.repoDir);
    const refreshedLivePath = worktreeMap.get(input.branchName);
    livePath = refreshedLivePath && existsSync(refreshedLivePath) ? refreshedLivePath : undefined;
  }

  if (!livePath) {
    return { kind: "stale-resolved" };
  }

  const existingTipSha = await revParse(input.repoDir, input.branchName);
  const requestedIntegrationRef = input.integrationRef ?? await resolveIntegrationBranch(input.repoDir, undefined);
  const integrationRef = await resolveBranchComparisonRef(input.repoDir, requestedIntegrationRef, input.branchName);
  /*
  FNXC:BranchBaseIdentity 2026-09-13-02:20:
  RUFU-231: prove the tip against EVERY trusted integration identity (local first, then
  `<remote>/<integration>`). A zero-own-commit branch rebased onto origin/main is landed
  upstream even though local main never caught up; measuring only against local main
  labelled that landed tip `live-foreign` forever (the RUFU-217 wedge). A landing proven
  only against the remote-tracking identity carries `landedVia: "remote-tracking"` so
  checkout-releasing consumers must first prove the worktree clean.
  */
  const trustedRefs = await resolveTrustedIntegrationRefs(input.repoDir, integrationRef);
  for (const trustedRef of trustedRefs) {
    if (await isAncestor(input.repoDir, existingTipSha, trustedRef)) {
      return {
        kind: "tip-already-merged",
        livePath: livePath ?? null,
        tipSha: existingTipSha,
        integrationRef: trustedRef,
        landedVia: trustedRef === integrationRef ? "local" : "remote-tracking",
      };
    }
  }

  // FNXC:BranchConflictReachability 2026-10-01-05:33:
  // Branch ownership and stranded diagnostics must use the same current-base range.
  // Mixing a persisted task base with live reachability could label inherited work as
  // task-owned and permit the wrong destructive recovery decision.
  const uniqueCommitResult = await listUniqueBranchCommits(input.repoDir, integrationRef, input.branchName);
  const attribution = await summarizeTaskAttributedCommits(
    input.repoDir,
    `${integrationRef}..${input.branchName}`,
    input.requestingTaskId,
  );
  const taskAttributedCommitCount = attribution.ownCount;

  if (!uniqueCommitResult.degraded && uniqueCommitResult.commits.length === 0) {
    return {
      kind: "fully-subsumed",
      livePath,
      tipSha: existingTipSha,
    };
  }

  if (uniqueCommitResult.degraded && uniqueCommitResult.commits.length === 0) {
    const isZeroUnique = await isZeroUniqueCommitBranchViaPatchIdFallback(
      input.repoDir,
      integrationRef,
      input.branchName,
      uniqueCommitResult.mainRef,
      trustedRefs,
    );
    if (isZeroUnique) {
      return {
        kind: "fully-subsumed",
        livePath,
        tipSha: existingTipSha,
      };
    }
  }

  const normalizedOwnerTaskId = (input.ownerTaskId ?? input.requestingTaskId).trim().toUpperCase();
  const branchOwnerTaskId = deriveTaskIdFromFusionBranch(input.branchName);
  const isSelfOwnedWorktree =
    livePath === input.conflictingWorktreePath ||
    (branchOwnerTaskId !== null && branchOwnerTaskId === normalizedOwnerTaskId);

  if (taskAttributedCommitCount > 0 || (isSelfOwnedWorktree && attribution.foreignCount === 0)) {
    return {
      kind: "reclaimable",
      livePath,
      tipSha: existingTipSha,
      taskAttributedCommitCount,
      strandedCommits: uniqueCommitResult.commits,
    };
  }

  return {
    kind: "live-foreign",
    livePath,
    error: new BranchConflictError({
      branchName: input.branchName,
      conflictingWorktreePath: livePath,
      existingTipSha,
      strandedCommits: uniqueCommitResult.commits,
      startPoint: uniqueCommitResult.mainRef,
      recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
    }),
  };
}
