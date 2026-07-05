/**
 * FNXC:TaskRevert 2026-07-04-00:00:
 * Intelligent git-revert service (FN-7523, foundation for FN-7501). Given a
 * done/archived task, this module:
 *   1. Resolves the set of commits attributable to that task (squash / rebase
 *      / lineage-snapshot precedence — see `resolveTaskRevertCommits`).
 *   2. Performs a NON-committing dry-run revert to classify the outcome as
 *      already-reverted / clean / conflicting (see `classifyTaskRevert`).
 *   3. When clean, creates the real revert commit(s) with a `Fusion-Task-Id`
 *      trailer on the resolved base branch (see `performTaskRevert`).
 *
 * This is the git path ONLY. Conflicting reverts are handed back to the
 * caller/UI unresolved — the AI-undo fallback is sibling task FN-7524, and the
 * UI affordance is sibling task FN-7525.
 *
 * FNXC:TaskRevert 2026-07-04-00:00 (FN-7547 — workspace/multi-repo support):
 * Workspace tasks (`task.workspaceWorktrees` populated, see `isWorkspaceTask`)
 * land squash commits across MULTIPLE sub-repo integration branches. This
 * module reasons about the WHOLE task's revert as one ALL-OR-NOTHING unit:
 * `resolveWorkspaceTaskRevertCommits` resolves per-repo attribution,
 * `revertWorkspaceTask` dry-run classifies EVERY sub-repo first and only
 * commits a revert on ANY sub-repo when EVERY acquired sub-repo classifies
 * clean/already-reverted. If any sub-repo conflicts, NO sub-repo is committed
 * and every touched sub-repo worktree is rolled back byte-identical to its
 * pre-call state — see `revertWorkspaceTask`'s doc comment for the full
 * contract. The single-repo path below (`resolveTaskRevertCommits` /
 * `classifyTaskRevert` / `performTaskRevert`) is UNCHANGED and continues to
 * serve non-workspace tasks; `revertWorkspaceTask` reuses its dry-run
 * (`classifyTaskRevert`) and apply/commit (`applyAndCommitRevert`) machinery
 * per sub-repo rather than duplicating it. `granularity` (FN-7548, below)
 * only applies to the single-repo path.
 *
 * Safety invariant (the core contract of this module): the working tree and
 * index are NEVER left dirty on any failure path. `classifyTaskRevert` always
 * captures `preRevertHead` before touching the tree and guarantees a full
 * `git revert --abort` + `git reset --hard <preRevertHead>` rollback in a
 * `finally` block, regardless of how the dry-run terminates.
 *
 * FNXC:TaskRevert 2026-07-05-00:00 (FN-7577 — PR-based revert extended to
 * workspace tasks): `prepareRevertPrBranch` (FN-7554) explicitly refuses
 * workspace tasks (`workspace-task-pr-revert-unsupported`) because a single
 * PR against a single base branch cannot represent a multi-repo revert.
 * `prepareWorkspaceRevertPrBranches` fills that gap: it mirrors
 * `revertWorkspaceTask`'s classify-all-then-commit-all skeleton but, instead
 * of force-committing onto each sub-repo's integration branch, prepares one
 * dedicated `<revertBranch>` per sub-repo (never writing any integration
 * branch) so the caller can open one PR per sub-repo. See its own doc
 * comment below for the full contract.
 */
import { exec } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { isWorkspaceTask, type Task, type TaskCommitAssociation, type TaskCreateInput } from "@fusion/core";
import { collectOwnTaskCommitsForRange } from "./branch-attribution.js";
import { resolveIntegrationBranch, type IntegrationBranchSettings } from "./integration-branch.js";

const defaultExecAsync = promisify(exec);
type ExecAsyncImpl = typeof defaultExecAsync;

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/** Minimal store surface this module depends on — keeps task-revert.ts test-friendly without pulling in the full TaskStore type. */
export interface TaskCommitAssociationSource {
  getTaskCommitAssociationsByLineageId(lineageId: string): Promise<TaskCommitAssociation[]>;
}

export class TaskRevertError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = "TaskRevertError";
    this.code = code;
    this.cause = cause;
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// FNXC:TaskRevert 2026-07-04-00:00:
// Reuse branch-attribution.ts's trailer/subject parsing so revert attribution
// stays consistent with merge-time attribution. Duplicated locally (rather
// than imported) because branch-attribution.ts's helpers are module-private;
// the regex/precedence MUST stay identical to branch-attribution.ts's
// `extractAttributedTaskId` / `extractTaskIdFromSubject` — update both together.
function extractAttributedTaskId(body: string): string | null {
  const trailerPattern = /(?:^|\n)(?:Fusion-Task-Id|Task-Id):\s*(\S+)\s*(?:\n|$)/gim;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while (true) {
    match = trailerPattern.exec(body);
    if (!match) break;
    last = match;
  }
  return last?.[1] ?? null;
}

function extractTaskIdFromSubject(subject: string): string | null {
  if (!subject) return null;
  const conventional =
    /^(?:feat|fix|test|chore|docs|refactor|perf|build|ci|style|revert)\s*\(([A-Z]+-\d+)\)!?:/i.exec(subject);
  if (conventional?.[1]) return conventional[1].toUpperCase();
  const bracketed = /^\s*\[([A-Z]+-\d+)\]/i.exec(subject);
  if (bracketed?.[1]) return bracketed[1].toUpperCase();
  const colon = /^\s*([A-Z]+-\d+):/i.exec(subject);
  if (colon?.[1]) return colon[1].toUpperCase();
  return null;
}

function taskIdsMatch(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.toUpperCase() === b.toUpperCase();
}

async function runGit(
  execImpl: ExecAsyncImpl,
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execImpl(command, {
    cwd,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

export type TaskRevertCommitSource = "squash" | "rebase" | "lineage" | "none";

export interface ResolvedTaskRevertCommits {
  supported: true;
  /** Attributable commit SHAs, newest first — reverting in this order applies the oldest change last, avoiding unnecessary self-conflicts among a task's own commits. */
  shas: string[];
  source: TaskRevertCommitSource;
}

export interface UnsupportedTaskRevert {
  supported: false;
  reason: string;
}

export interface ResolveTaskRevertCommitsOptions {
  worktreePath: string;
  execAsyncImpl?: ExecAsyncImpl;
  /** Lineage-snapshot fallback source (typically the scoped TaskStore). Optional so callers that already know mergeDetails is present can omit it. */
  commitAssociationSource?: TaskCommitAssociationSource;
}

/**
 * FNXC:TaskRevert 2026-07-04-00:00:
 * Attribution precedence (mirrors merge-time attribution capture):
 *   1. Squash strategy — `mergeDetails.commitSha` alone when `rebaseBaseSha`
 *      is unset (single squash commit landed the task).
 *   2. Rebase/cherry-pick strategy — the task-attributable subset of
 *      `rebaseBaseSha..commitSha`, filtered by `Fusion-Task-Id` trailer or
 *      conventional-commit subject. Falls back to the full range endpoint
 *      (`commitSha`) when no per-commit attribution is possible (foreign
 *      commits interleaved with no trailer/subject match — better to revert
 *      the endpoint than nothing).
 *   3. Lineage snapshot fallback — `TaskCommitAssociation` rows keyed by
 *      `taskLineageId`, used when `mergeDetails` is absent/incomplete (e.g.
 *      legacy tasks merged before mergeDetails was captured).
 *
 * FNXC:TaskRevert 2026-07-04-00:00 (workspace limitation):
 * Workspace tasks (`mergeDetails.workspaceLandedShas` present) land commits
 * across MULTIPLE sub-repo integration branches with no single coherent
 * revert target — reverting one sub-repo's commit without reasoning about the
 * others could leave the workspace in a half-reverted, inconsistent state.
 * This is explicitly out of scope for FN-7523; the caller should route
 * workspace tasks to the AI-undo fallback (FN-7524) instead.
 */
export async function resolveTaskRevertCommits(
  task: Pick<Task, "id" | "lineageId" | "mergeDetails">,
  opts: ResolveTaskRevertCommitsOptions,
): Promise<ResolvedTaskRevertCommits | UnsupportedTaskRevert> {
  const execImpl = opts.execAsyncImpl ?? defaultExecAsync;
  const mergeDetails = task.mergeDetails;

  if (mergeDetails?.workspaceLandedShas && Object.keys(mergeDetails.workspaceLandedShas).length > 0) {
    return { supported: false, reason: "workspace-task-revert-unsupported" };
  }

  if (mergeDetails?.commitSha) {
    if (!mergeDetails.rebaseBaseSha) {
      // Squash strategy: the single recorded commit is the entire landed change.
      return { supported: true, shas: [mergeDetails.commitSha], source: "squash" };
    }

    // Rebase/cherry-pick strategy: filter the range to this task's own commits.
    const rangeRef = `${mergeDetails.rebaseBaseSha}..${mergeDetails.commitSha}`;
    let logOutput: string;
    try {
      const { stdout } = await runGit(
        execImpl,
        `git log --format=%H%x00%s%x00%B%x1e ${quoteShellArg(rangeRef)}`,
        opts.worktreePath,
      );
      logOutput = stdout;
    } catch (error) {
      throw new TaskRevertError(`git log failed for range ${rangeRef}`, "git-log-failed", error);
    }

    const ownCommitShas: string[] = [];
    const records = logOutput.split("\x1e").map((record) => record.trim()).filter(Boolean);
    for (const record of records) {
      const [sha = "", subject = "", ...bodyParts] = record.split("\x00");
      if (!sha) continue;
      const body = bodyParts.join("\x00");
      const trailerAttributedTaskId = extractAttributedTaskId(body);
      const attributedTaskId = trailerAttributedTaskId ?? extractTaskIdFromSubject(subject);
      if (taskIdsMatch(attributedTaskId, task.id)) {
        ownCommitShas.push(sha);
      }
    }

    if (ownCommitShas.length > 0) {
      // `git log` without `--reverse` already yields newest-first order.
      return { supported: true, shas: ownCommitShas, source: "rebase" };
    }

    // No per-commit attribution possible (foreign commits interleaved with no
    // trailer/subject match) — fall back to reverting the full range endpoint.
    return { supported: true, shas: [mergeDetails.commitSha], source: "rebase" };
  }

  // mergeDetails absent/incomplete — fall back to the lineage-snapshot association table.
  const lineageId = task.lineageId ?? task.id;
  if (!opts.commitAssociationSource) {
    return { supported: true, shas: [], source: "none" };
  }
  const associations = await opts.commitAssociationSource.getTaskCommitAssociationsByLineageId(lineageId);
  if (associations.length === 0) {
    return { supported: true, shas: [], source: "none" };
  }
  // Rows are already ordered `authoredAt DESC, createdAt DESC` (newest first) by the store query.
  return { supported: true, shas: associations.map((a) => a.commitSha), source: "lineage" };
}

export type TaskRevertClassification = "already-reverted" | "clean" | "conflicting";

export interface TaskRevertConflict {
  file: string;
  /** Raw `git status --porcelain` two-letter status code for the conflicted file (e.g. "UU", "AA"). */
  status?: string;
}

export interface ClassifyTaskRevertResult {
  classification: TaskRevertClassification;
  conflicts?: TaskRevertConflict[];
  alreadyReverted?: boolean;
}

export interface ClassifyTaskRevertOptions {
  worktreePath: string;
  /** Attributable commit SHAs, newest first (see `resolveTaskRevertCommits`). */
  commits: string[];
  execAsyncImpl?: ExecAsyncImpl;
}

async function getUnmergedFiles(
  execImpl: ExecAsyncImpl,
  worktreePath: string,
): Promise<TaskRevertConflict[]> {
  const { stdout } = await runGit(execImpl, "git status --porcelain", worktreePath);
  const conflicts: TaskRevertConflict[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    // Unmerged states per `git status --porcelain`: UU, AA, DD, AU, UA, UD, DU.
    if (/^(UU|AA|DD|AU|UA|UD|DU)$/.test(status)) {
      conflicts.push({ file: line.slice(3).trim(), status });
    }
  }
  return conflicts;
}

/**
 * FNXC:TaskRevert 2026-07-04-00:00:
 * Rollback safety contract (the core invariant of this service): capture
 * `preRevertHead` BEFORE any git mutation. If the working tree is dirty at
 * entry, refuse immediately without touching anything. Otherwise, run the
 * dry-run revert sequence; regardless of outcome (clean, conflicting, or an
 * unexpected error), the `finally` block runs `git revert --abort`
 * (best-effort) THEN `git reset --hard <preRevertHead>` so the tree/index are
 * byte-identical to the pre-call state. This function NEVER commits and NEVER
 * throws without first completing that rollback.
 */
export async function classifyTaskRevert(opts: ClassifyTaskRevertOptions): Promise<ClassifyTaskRevertResult> {
  const execImpl = opts.execAsyncImpl ?? defaultExecAsync;
  const { worktreePath, commits } = opts;

  if (commits.length === 0) {
    return { classification: "already-reverted", alreadyReverted: true };
  }

  let preRevertHead: string;
  try {
    const { stdout } = await runGit(execImpl, "git rev-parse HEAD", worktreePath);
    preRevertHead = stdout.trim();
  } catch (error) {
    throw new TaskRevertError("failed to resolve HEAD before revert dry-run", "head-resolve-failed", error);
  }
  if (!preRevertHead) {
    throw new TaskRevertError("failed to resolve HEAD before revert dry-run", "head-resolve-failed");
  }

  const { stdout: statusOut } = await runGit(execImpl, "git status --porcelain", worktreePath);
  if (statusOut.trim().length > 0) {
    throw new TaskRevertError(
      "working tree is dirty; refusing to attempt a revert dry-run",
      "dirty-working-tree",
    );
  }

  let mutated = false;
  let allAlreadyReverted = true;
  const conflicts: TaskRevertConflict[] = [];

  try {
    for (const sha of commits) {
      mutated = true;
      const statusBefore = (await runGit(execImpl, "git status --porcelain", worktreePath)).stdout;
      try {
        await runGit(execImpl, `git revert --no-commit --no-edit ${quoteShellArg(sha)}`, worktreePath);
        // FNXC:TaskRevert 2026-07-04-00:00: `git revert --no-commit` on an
        // already-reverted commit exits 0 with NO staged/working-tree diff
        // (no error, no "nothing to commit" text — that message only ever
        // appears from a *subsequent* `git commit` attempt). Detect this by
        // diffing `git status --porcelain` before/after the call: if nothing
        // changed, this sha is a no-op; `--quit` clears the sequencer's
        // in-progress marker WITHOUT touching any diff staged by earlier shas
        // in this same batch (unlike `--abort`, which would reset everything).
        const statusAfter = (await runGit(execImpl, "git status --porcelain", worktreePath)).stdout;
        if (statusAfter === statusBefore) {
          await runGit(execImpl, "git revert --quit", worktreePath).catch(() => undefined);
          continue;
        }
        allAlreadyReverted = false;
      } catch (error) {
        const stderr =
          typeof error === "object" && error && "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
            ? (error as { stderr: string }).stderr
            : "";
        const stdout =
          typeof error === "object" && error && "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string"
            ? (error as { stdout: string }).stdout
            : "";
        const combined = `${stdout}\n${stderr}`;
        const unmergedFiles = await getUnmergedFiles(execImpl, worktreePath);
        if (unmergedFiles.length > 0) {
          conflicts.push(...unmergedFiles);
          allAlreadyReverted = false;
          break;
        }
        // "nothing to commit" / empty-revert signal: this commit's change is
        // already reflected as reverted at HEAD — treat as a no-op and continue.
        if (/nothing to commit|no changes|empty commit/i.test(combined)) {
          await runGit(execImpl, "git revert --quit", worktreePath).catch(() => undefined);
          continue;
        }
        throw new TaskRevertError(`git revert --no-commit failed unexpectedly for ${sha}`, "revert-dry-run-failed", error);
      }
    }
  } finally {
    if (mutated) {
      await runGit(execImpl, "git revert --abort", worktreePath).catch(() => undefined);
      await runGit(execImpl, `git reset --hard ${quoteShellArg(preRevertHead)}`, worktreePath).catch(() => undefined);
    }
  }

  if (conflicts.length > 0) {
    return { classification: "conflicting", conflicts };
  }
  if (allAlreadyReverted) {
    return { classification: "already-reverted", alreadyReverted: true };
  }
  return { classification: "clean" };
}

// FNXC:TaskRevert 2026-07-04-12:00 (shared per-sha apply primitive, FN-7548):
// factors the `git revert --no-commit` + status-diff no-op detection +
// unmerged-file conflict detection used by BOTH performTaskRevert apply paths
// (squash and per-sha) into one place. Returns a discriminated outcome
// instead of committing or rolling back itself — callers own the
// commit/rollback decision (squash accumulates across shas before
// committing once; per-sha commits after each staged sha).
type RevertShaApplyOutcome =
  | { kind: "staged" }
  | { kind: "noop" }
  | { kind: "conflict"; conflicts: TaskRevertConflict[] };

async function applyRevertNoCommit(
  execImpl: ExecAsyncImpl,
  worktreePath: string,
  sha: string,
): Promise<RevertShaApplyOutcome> {
  const statusBefore = (await runGit(execImpl, "git status --porcelain", worktreePath)).stdout;
  try {
    await runGit(execImpl, `git revert --no-commit --no-edit ${quoteShellArg(sha)}`, worktreePath);
    // FNXC:TaskRevert 2026-07-04-00:00: `git revert --no-commit` on an
    // already-reverted commit exits 0 with no staged/working-tree diff (no
    // thrown error, no "nothing to commit" text on this call). Detect this by
    // diffing `git status --porcelain` before/after: if unchanged, this sha is
    // a no-op; `--quit` clears the sequencer's in-progress marker WITHOUT
    // touching any diff staged by earlier shas in this same batch.
    const statusAfter = (await runGit(execImpl, "git status --porcelain", worktreePath)).stdout;
    if (statusAfter === statusBefore) {
      await runGit(execImpl, "git revert --quit", worktreePath).catch(() => undefined);
      return { kind: "noop" };
    }
    return { kind: "staged" };
  } catch (error) {
    const stderr =
      typeof error === "object" && error && "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    const stdout =
      typeof error === "object" && error && "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
    if (/nothing to commit|no changes|empty commit/i.test(`${stdout}\n${stderr}`)) {
      await runGit(execImpl, "git revert --quit", worktreePath).catch(() => undefined);
      return { kind: "noop" };
    }
    const unmergedFiles = await getUnmergedFiles(execImpl, worktreePath);
    return { kind: "conflict", conflicts: unmergedFiles };
  }
}

function deriveShortSummary(originalSubject: string): string {
  return (
    originalSubject
      .replace(/^(?:feat|fix|test|chore|docs|refactor|perf|build|ci|style)\([^)]*\):\s*/i, "")
      .slice(0, 72) || "revert landed changes"
  );
}

export type TaskRevertResult =
  | { mode: "git"; clean: true; revertCommitSha: string; revertCommitShas: string[] }
  | { mode: "git"; clean: true; alreadyReverted: true }
  | { mode: "git"; clean: false; conflicts: TaskRevertConflict[] }
  | { mode: "git"; unsupported: true; reason: string }
  | { mode: "git"; needsHuman: true; reason: string };

/**
 * FNXC:TaskRevert 2026-07-04-12:00 (granularity, FN-7548):
 * `"squash"` (default, unchanged FN-7523 behavior) accumulates every
 * attributable sha into ONE final revert commit. `"per-sha"` creates one
 * attributed `revert(FN-xxxx): ...` commit PER non-no-op original sha, each
 * with its own `Fusion-Task-Id` trailer and an audit line referencing that
 * specific sha — giving finer-grained audit trail / rollback (an operator
 * can drop a single per-sha revert without unwinding the whole task). A
 * mid-batch conflict in EITHER mode rolls the whole batch back to
 * `preRevertHead` — partially-landed per-commit reverts are never left on
 * disk (see the shared `mutated`/`preRevertHead` rollback in the outer
 * catch, and the inline abort+reset on conflict below).
 */
export type TaskRevertGranularity = "squash" | "per-sha";

export interface PerformTaskRevertOptions {
  task: Pick<Task, "id" | "lineageId" | "column" | "mergeDetails" | "autoMerge" | "userPaused" | "paused" | "workspaceWorktrees">;
  worktreePath: string;
  baseBranch: string;
  execAsyncImpl?: ExecAsyncImpl;
  commitAssociationSource?: TaskCommitAssociationSource;
  /** Resolved effective project autoMerge setting (task.autoMerge overrides this when set). Defaults to true (autoMerge on) when omitted. */
  effectiveAutoMerge?: boolean;
  /** Commit granularity for the real (committing) revert. Defaults to `"squash"` — omitting this option preserves FN-7523 behavior exactly. */
  granularity?: TaskRevertGranularity;
}

// FNXC:TaskRevert 2026-07-04-00:00 (guard rails, enforced in BOTH the service
// and the route per PROMPT Step 3): only done/archived tasks are revertable.
const REVERTABLE_COLUMNS = new Set(["done", "archived"]);

/**
 * FNXC:TaskRevert 2026-07-04-00:00 (commit message/trailer contract):
 * The revert commit's subject is `revert(FN-xxxx): <short summary>` (the
 * original task's id + a short summary derived from the reverted commit's
 * subject), with a body carrying `Fusion-Task-Id: FN-xxxx` (the ORIGINAL
 * task id, so `extractAttributedTaskId` continues to resolve attribution back
 * to the reverted task) and a `Reverts work landed by task FN-xxxx (<sha>).`
 * line for human audit. This mirrors the commit-message conventions in
 * AGENTS.md (task-id-prefixed subjects, `Fusion-Task-Id` trailer).
 *
 * FNXC:TaskRevert 2026-07-04-00:00 (guard rails):
 * - Only `done`/`archived` tasks may be reverted (checked here AND at the API
 *   route layer — defense in depth).
 * - When `autoMerge` is effectively off for this task, this function refuses
 *   with a `needsHuman` result instead of force-writing a revert commit onto
 *   a branch the project has opted out of automated writes to.
 * - This function NEVER mutates the source task's store row/column — reverting
 *   is a forward-only git operation on the base branch, not a lifecycle move.
 */
export async function performTaskRevert(opts: PerformTaskRevertOptions): Promise<TaskRevertResult> {
  // FNXC:TaskRevert 2026-07-04-00:00: `baseBranch` is part of the stable
  // caller-facing contract (the route resolves it via mergeTargetBranch /
  // the integration-branch resolver) but is not read here directly — the
  // caller is responsible for ensuring `worktreePath` is checked out at that
  // branch's HEAD before invoking this function; kept as a named, documented
  // parameter (not silently dropped) for FN-7524/FN-7525 call-site clarity.
  const { task, worktreePath, baseBranch: _baseBranch } = opts;
  const execImpl = opts.execAsyncImpl ?? defaultExecAsync;

  // FNXC:TaskRevert 2026-07-04-00:00 (FN-7547 dispatch guard): this function
  // is the single-repo entry point ONLY. Workspace tasks (`isWorkspaceTask`)
  // must be routed by the caller to `revertWorkspaceTask` instead — refuse
  // explicitly here (rather than silently reverting one arbitrary sub-repo)
  // so a caller that forgets to check `isWorkspaceTask` first gets a clear
  // signal instead of a half-coherent single-repo revert.
  if (isWorkspaceTask(task)) {
    return { mode: "git", unsupported: true, reason: "workspace-task-revert-unsupported-by-single-repo-path; use revertWorkspaceTask" };
  }

  if (!REVERTABLE_COLUMNS.has(task.column)) {
    return { mode: "git", needsHuman: true, reason: `task is in column "${task.column}"; only done/archived tasks are revertable` };
  }

  const effectiveAutoMerge = task.autoMerge ?? opts.effectiveAutoMerge ?? true;
  if (effectiveAutoMerge === false) {
    return { mode: "git", needsHuman: true, reason: "autoMerge is disabled for this task/project; refusing to force-write a revert commit" };
  }

  const resolved = await resolveTaskRevertCommits(task, {
    worktreePath,
    execAsyncImpl: execImpl,
    commitAssociationSource: opts.commitAssociationSource,
  });
  if (!resolved.supported) {
    return { mode: "git", unsupported: true, reason: resolved.reason };
  }

  const classification = await classifyTaskRevert({
    worktreePath,
    commits: resolved.shas,
    execAsyncImpl: execImpl,
  });

  if (classification.classification === "already-reverted") {
    return { mode: "git", clean: true, alreadyReverted: true };
  }
  if (classification.classification === "conflicting") {
    return { mode: "git", clean: false, conflicts: classification.conflicts ?? [] };
  }

  // classification === "clean" — perform the real (committing) revert.
  let preRevertHead: string;
  try {
    const { stdout } = await runGit(execImpl, "git rev-parse HEAD", worktreePath);
    preRevertHead = stdout.trim();
  } catch (error) {
    throw new TaskRevertError("failed to resolve HEAD before applying revert", "head-resolve-failed", error);
  }

  const granularity: TaskRevertGranularity = opts.granularity ?? "squash";
  let mutated = false;
  try {
    if (granularity === "per-sha") {
      // FNXC:TaskRevert 2026-07-04-12:00 (per-commit apply path, FN-7548):
      // stage-and-commit ONE sha at a time so each attributable original sha
      // gets its own attributed revert commit. No-op shas (already reverted
      // at HEAD) are skipped without creating an empty commit. A conflict on
      // any sha rolls the ENTIRE batch back to preRevertHead — there is no
      // partially-landed per-commit state.
      const createdCommitShas: string[] = [];
      for (const sha of resolved.shas) {
        mutated = true;
        const outcome = await applyRevertNoCommit(execImpl, worktreePath, sha);
        if (outcome.kind === "conflict") {
          await runGit(execImpl, "git revert --abort", worktreePath).catch(() => undefined);
          await runGit(execImpl, `git reset --hard ${quoteShellArg(preRevertHead)}`, worktreePath).catch(() => undefined);
          return { mode: "git", clean: false, conflicts: outcome.conflicts };
        }
        if (outcome.kind === "noop") continue;

        let originalSubject = "";
        try {
          const { stdout } = await runGit(execImpl, `git log -1 --format=%s ${quoteShellArg(sha)}`, worktreePath);
          originalSubject = stdout.trim();
        } catch {
          originalSubject = "";
        }
        const shortSummary = deriveShortSummary(originalSubject);
        const subject = `revert(${task.id}): ${shortSummary}`;
        const body1 = `Fusion-Task-Id: ${task.id}`;
        const body2 = `Reverts ${originalSubject || sha} @ ${sha.slice(0, 8)}.`;

        await runGit(
          execImpl,
          `git commit -m ${quoteShellArg(subject)} -m ${quoteShellArg(body1)} -m ${quoteShellArg(body2)}`,
          worktreePath,
        );
        const { stdout: newHead } = await runGit(execImpl, "git rev-parse HEAD", worktreePath);
        createdCommitShas.push(newHead.trim());
      }

      if (createdCommitShas.length === 0) {
        // Defensive: every sha in this batch turned out to be a no-op during the
        // apply pass even though classify saw at least one real change (branch
        // moved between classify and apply, or a race). Nothing to commit —
        // report already-reverted rather than attempting an empty commit.
        return { mode: "git", clean: true, alreadyReverted: true };
      }
      return {
        mode: "git",
        clean: true,
        revertCommitSha: createdCommitShas[0]!,
        revertCommitShas: createdCommitShas,
      };
    }

    // granularity === "squash" (default, byte-for-byte unchanged FN-7523 behavior):
    // accumulate every attributable sha via `git revert --no-commit`, then create
    // ONE final commit spanning the whole batch.
    let anyStaged = false;
    for (const sha of resolved.shas) {
      mutated = true;
      const outcome = await applyRevertNoCommit(execImpl, worktreePath, sha);
      if (outcome.kind === "conflict") {
        // The dry-run already proved this is clean; a live conflict here means
        // the branch moved between classify and apply. Roll back and report conflicting.
        await runGit(execImpl, "git revert --abort", worktreePath).catch(() => undefined);
        await runGit(execImpl, `git reset --hard ${quoteShellArg(preRevertHead)}`, worktreePath).catch(() => undefined);
        return { mode: "git", clean: false, conflicts: outcome.conflicts };
      }
      if (outcome.kind === "staged") anyStaged = true;
    }

    if (!anyStaged) {
      // Defensive: every sha in this batch turned out to be a no-op during the
      // apply pass even though classify saw at least one real change (branch
      // moved between classify and apply, or a race). Nothing to commit —
      // report already-reverted rather than attempting an empty commit.
      return { mode: "git", clean: true, alreadyReverted: true };
    }

    let originalSubject = "";
    try {
      const { stdout } = await runGit(execImpl, `git log -1 --format=%s ${quoteShellArg(resolved.shas[0] ?? "HEAD")}`, worktreePath);
      originalSubject = stdout.trim();
    } catch {
      originalSubject = "";
    }

    const shortSummary = deriveShortSummary(originalSubject);
    const subject = `revert(${task.id}): ${shortSummary}`;
    const referencedSha = resolved.shas[0] ?? "unknown";
    const body1 = `Fusion-Task-Id: ${task.id}`;
    const body2 = `Reverts work landed by task ${task.id} (${originalSubject || referencedSha} @ ${referencedSha.slice(0, 8)}).`;

    await runGit(
      execImpl,
      `git commit -m ${quoteShellArg(subject)} -m ${quoteShellArg(body1)} -m ${quoteShellArg(body2)}`,
      worktreePath,
    );

    const { stdout: newHead } = await runGit(execImpl, "git rev-parse HEAD", worktreePath);
    const revertCommitSha = newHead.trim();
    return { mode: "git", clean: true, revertCommitSha, revertCommitShas: [revertCommitSha] };
  } catch (error) {
    if (mutated) {
      await runGit(execImpl, "git revert --abort", worktreePath).catch(() => undefined);
      await runGit(execImpl, `git reset --hard ${quoteShellArg(preRevertHead)}`, worktreePath).catch(() => undefined);
    }
    throw error instanceof TaskRevertError ? error : new TaskRevertError("failed to apply revert commit", "revert-apply-failed", error);
  }
}

// ---------------------------------------------------------------------------
// FN-7547: workspace/multi-repo task revert support.
// ---------------------------------------------------------------------------

/**
 * FNXC:TaskRevert 2026-07-04-00:00 (extracted for FN-7547 reuse):
 * The squash-granularity apply+commit phase, factored out so the workspace
 * multi-repo path (`revertWorkspaceTask`) can run the IDENTICAL single-repo
 * apply/commit machinery once per sub-repo, keeping the commit message/trailer
 * contract and the live-conflict-during-apply rollback identical between the
 * single-repo and workspace paths. Built on the same `applyRevertNoCommit`
 * shared primitive `performTaskRevert`'s squash branch uses above — it is NOT
 * a second reimplementation. Callers MUST have already run `classifyTaskRevert`
 * and confirmed "clean" for these `commits` — this function does not
 * re-classify; it assumes the dry-run already proved the revert applies
 * cleanly and only guards against the branch moving between classify and
 * apply (a live conflict here rolls back THIS repo/worktree only — the caller
 * is responsible for any cross-repo rollback in the workspace all-or-nothing
 * contract). `granularity` (FN-7548) does not apply to the workspace path;
 * this always produces one commit per sub-repo.
 */
async function applyAndCommitRevert(opts: {
  worktreePath: string;
  /** Attributable commit SHAs, newest first. */
  commits: string[];
  taskId: string;
  execAsyncImpl?: ExecAsyncImpl;
}): Promise<
  | { applied: true; revertCommitSha: string }
  | { applied: false; alreadyReverted: true }
  | { applied: false; conflicts: TaskRevertConflict[] }
> {
  const { worktreePath, commits, taskId } = opts;
  const execImpl = opts.execAsyncImpl ?? defaultExecAsync;

  let preRevertHead: string;
  try {
    const { stdout } = await runGit(execImpl, "git rev-parse HEAD", worktreePath);
    preRevertHead = stdout.trim();
  } catch (error) {
    throw new TaskRevertError("failed to resolve HEAD before applying revert", "head-resolve-failed", error);
  }

  let mutated = false;
  let anyStaged = false;
  try {
    for (const sha of commits) {
      mutated = true;
      const outcome = await applyRevertNoCommit(execImpl, worktreePath, sha);
      if (outcome.kind === "conflict") {
        await runGit(execImpl, "git revert --abort", worktreePath).catch(() => undefined);
        await runGit(execImpl, `git reset --hard ${quoteShellArg(preRevertHead)}`, worktreePath).catch(() => undefined);
        return { applied: false, conflicts: outcome.conflicts };
      }
      if (outcome.kind === "staged") anyStaged = true;
    }

    if (!anyStaged) {
      // Defensive: every sha in this batch turned out to be a no-op during the
      // apply pass even though classify saw at least one real change (branch
      // moved between classify and apply, or a race). Nothing to commit —
      // report already-reverted rather than attempting an empty commit.
      return { applied: false, alreadyReverted: true };
    }

    let originalSubject = "";
    try {
      const { stdout } = await runGit(execImpl, `git log -1 --format=%s ${quoteShellArg(commits[0] ?? "HEAD")}`, worktreePath);
      originalSubject = stdout.trim();
    } catch {
      originalSubject = "";
    }

    const shortSummary = deriveShortSummary(originalSubject);
    const subject = `revert(${taskId}): ${shortSummary}`;
    const referencedSha = commits[0] ?? "unknown";
    const body1 = `Fusion-Task-Id: ${taskId}`;
    const body2 = `Reverts work landed by task ${taskId} (${originalSubject || referencedSha} @ ${referencedSha.slice(0, 8)}).`;

    await runGit(
      execImpl,
      `git commit -m ${quoteShellArg(subject)} -m ${quoteShellArg(body1)} -m ${quoteShellArg(body2)}`,
      worktreePath,
    );

    const { stdout: newHead } = await runGit(execImpl, "git rev-parse HEAD", worktreePath);
    return { applied: true, revertCommitSha: newHead.trim() };
  } catch (error) {
    if (mutated) {
      await runGit(execImpl, "git revert --abort", worktreePath).catch(() => undefined);
      await runGit(execImpl, `git reset --hard ${quoteShellArg(preRevertHead)}`, worktreePath).catch(() => undefined);
    }
    throw error instanceof TaskRevertError ? error : new TaskRevertError("failed to apply revert commit", "revert-apply-failed", error);
  }
}

// ---------------------------------------------------------------------------
// FN-7554: PR-based revert for autoMerge:false projects.
// ---------------------------------------------------------------------------

export type PrepareRevertPrBranchResult =
  | { eligible: true; revertBranch: string; revertCommitShas: string[] }
  | { eligible: false; classification: "conflicting"; conflicts: TaskRevertConflict[] }
  | { eligible: false; classification: "already-reverted"; alreadyReverted: true }
  | { eligible: false; unsupported: true; reason: string };

export interface PrepareRevertPrBranchOptions {
  task: Pick<Task, "id" | "lineageId" | "column" | "mergeDetails" | "workspaceWorktrees">;
  /** The shared checkout, verified on `baseBranch` by the caller before this is invoked. */
  worktreePath: string;
  /** Resolved mergeTargetBranch / integration branch. NEVER written to — see the doc comment below. */
  baseBranch: string;
  /** e.g. `fusion/revert-<task-id-lowercase>`. */
  revertBranch: string;
  execAsyncImpl?: ExecAsyncImpl;
  commitAssociationSource?: TaskCommitAssociationSource;
}

/**
 * FNXC:TaskRevert 2026-07-05-00:00 (FN-7554 — PR-based revert for
 * autoMerge:false projects):
 *
 * `performTaskRevert` refuses (`needsHuman`) whenever autoMerge is
 * effectively off, because it commits directly onto `worktreePath`'s current
 * HEAD branch (the base branch) and this project has opted that branch out
 * of automated writes. This function gives that dead end an actionable path:
 * it prepares a DEDICATED `revertBranch` off `baseBranch`'s HEAD, applies the
 * revert commit(s) onto THAT branch only, and leaves `baseBranch` itself
 * completely untouched — the caller (the API route) then pushes the branch
 * and opens a real GitHub PR against `baseBranch`, so the change still lands
 * through the project's normal human-review flow instead of a forced write.
 *
 * NEVER-WRITE-TO-BASE INVARIANT: this function only ever mutates
 * `revertBranch`. `baseBranch`'s ref is never advanced, reset, or committed
 * to. The shared checkout (`worktreePath`) is ALWAYS restored to the branch
 * it was on when this function was called (`originalBranch`), in a `finally`
 * — regardless of success, classification pass-through, or thrown failure —
 * so a caller that shares this checkout across requests never observes it
 * left mid-revert on `revertBranch`.
 *
 * REUSE, NOT REIMPLEMENTATION: commit application/message/trailer generation
 * is delegated entirely to the shared `applyAndCommitRevert` helper (the same
 * one `performTaskRevert`'s squash path and `revertWorkspaceTask` use) — this
 * function only adds the branch-prep/checkout-restore choreography around it.
 *
 * WORKSPACE DEFERRAL: workspace (multi-repo) tasks are refused with
 * `{ eligible: false, unsupported: true, reason: "workspace-task-pr-revert-unsupported" }`
 * — a single PR against a single base branch cannot coherently represent a
 * multi-repo, multi-branch revert. PR-based workspace revert is explicitly
 * out of scope here (see the FN-7554 PROMPT's Step 6 follow-up task).
 */
export async function prepareRevertPrBranch(opts: PrepareRevertPrBranchOptions): Promise<PrepareRevertPrBranchResult> {
  const { task, worktreePath, baseBranch, revertBranch } = opts;
  const execImpl = opts.execAsyncImpl ?? defaultExecAsync;

  if (isWorkspaceTask(task)) {
    return { eligible: false, unsupported: true, reason: "workspace-task-pr-revert-unsupported" };
  }

  const resolved = await resolveTaskRevertCommits(task, {
    worktreePath,
    execAsyncImpl: execImpl,
    commitAssociationSource: opts.commitAssociationSource,
  });
  if (!resolved.supported) {
    return { eligible: false, unsupported: true, reason: resolved.reason };
  }

  const classification = await classifyTaskRevert({
    worktreePath,
    commits: resolved.shas,
    execAsyncImpl: execImpl,
  });

  if (classification.classification === "already-reverted") {
    return { eligible: false, classification: "already-reverted", alreadyReverted: true };
  }
  if (classification.classification === "conflicting") {
    return { eligible: false, classification: "conflicting", conflicts: classification.conflicts ?? [] };
  }

  // classification === "clean" — prepare the dedicated revert branch.
  let originalBranch: string;
  try {
    const { stdout } = await runGit(execImpl, "git rev-parse --abbrev-ref HEAD", worktreePath);
    originalBranch = stdout.trim();
  } catch (error) {
    throw new TaskRevertError("failed to resolve current branch before preparing revert PR branch", "head-resolve-failed", error);
  }

  const { stdout: statusOut } = await runGit(execImpl, "git status --porcelain", worktreePath);
  if (statusOut.trim().length > 0) {
    throw new TaskRevertError(
      "working tree is dirty; refusing to prepare a revert PR branch",
      "dirty-working-tree",
    );
  }

  let branchCreated = false;
  try {
    // FNXC:TaskRevert 2026-07-05-00:00: `-B` (create-or-reset) makes re-running
    // this idempotent when a stale local `revertBranch` already exists from a
    // prior failed/aborted attempt — it is reset off `baseBranch` HEAD rather
    // than accumulating on top of whatever it previously pointed at. `baseBranch`
    // itself is only ever read here (`git checkout -B <revertBranch> <baseBranch>`
    // does not move `baseBranch`'s ref).
    await runGit(
      execImpl,
      `git checkout -B ${quoteShellArg(revertBranch)} ${quoteShellArg(baseBranch)}`,
      worktreePath,
    );
    branchCreated = true;

    const applied = await applyAndCommitRevert({
      worktreePath,
      commits: resolved.shas,
      taskId: task.id,
      execAsyncImpl: execImpl,
    });

    if ("alreadyReverted" in applied) {
      // Defensive: the branch moved between classify and apply. Nothing to
      // commit on the fresh revertBranch — treat as already-reverted.
      return { eligible: false, classification: "already-reverted", alreadyReverted: true };
    }
    if ("conflicts" in applied) {
      // Late conflict — applyAndCommitRevert already rolled worktreePath back
      // to the pre-apply HEAD (the tip of revertBranch, i.e. baseBranch's HEAD).
      return { eligible: false, classification: "conflicting", conflicts: applied.conflicts };
    }

    return { eligible: true, revertBranch, revertCommitShas: [applied.revertCommitSha] };
  } catch (error) {
    // On any thrown failure after branch creation, never leave a dangling
    // partial revert branch behind — best-effort restore + delete.
    if (branchCreated) {
      await runGit(execImpl, `git checkout ${quoteShellArg(originalBranch)}`, worktreePath).catch(() => undefined);
      await runGit(execImpl, `git branch -D ${quoteShellArg(revertBranch)}`, worktreePath).catch(() => undefined);
    }
    throw error instanceof TaskRevertError ? error : new TaskRevertError("failed to prepare revert PR branch", "revert-pr-branch-prepare-failed", error);
  } finally {
    // FNXC:TaskRevert 2026-07-05-00:00: ALWAYS restore the shared checkout to
    // the branch it was on when this function was called, so the checkout is
    // left exactly where it started — on `baseBranch` (unmutated) in the
    // documented caller contract — regardless of success/pass-through/failure
    // above. The revert commit(s) live ONLY on `revertBranch`.
    await runGit(execImpl, `git checkout ${quoteShellArg(originalBranch)}`, worktreePath).catch(() => undefined);
  }
}

export interface WorkspaceRepoRevertCommits {
  commits: string[];
  source: TaskRevertCommitSource;
}

export interface ResolveWorkspaceTaskRevertCommitsOptions {
  workspaceRootDir: string;
  execAsyncImpl?: ExecAsyncImpl;
  /** Lineage-snapshot fallback source (typically the scoped TaskStore). */
  commitAssociationSource?: TaskCommitAssociationSource;
}

/**
 * FNXC:TaskRevert 2026-07-04-00:00 (FN-7547 per-repo attribution):
 * Resolves the attributable commit(s) for EACH sub-repo of a workspace task,
 * keyed by repo-relative path, iterating `Object.keys(task.workspaceWorktrees)
 * .sort()` for the SAME deterministic order `landWorkspaceTask`/self-healing
 * use (KTD1) — this determinism matters because Step 2/3's all-or-nothing
 * commit ordering depends on a stable, reproducible repo iteration order.
 *
 * Precedence per sub-repo (mirrors the single-repo precedence in
 * `resolveTaskRevertCommits`, adapted to the workspace land model where each
 * sub-repo has its own representative squash sha rather than one task-wide
 * `mergeDetails.commitSha`):
 *   1. Squash — `mergeDetails.workspaceLandedShas[repoRel]` alone, when the
 *      sub-repo's `workspaceWorktrees[repoRel].baseCommitSha` is unset (the
 *      representative squash sha landed the entire sub-repo's contribution).
 *   2. Rebase/range — when `baseCommitSha` IS set, filter the range
 *      `baseCommitSha..landedSha` to this task's own commits via
 *      `collectOwnTaskCommitsForRange` (shared with branch-attribution.ts),
 *      falling back to the range endpoint (`landedSha`) when no per-commit
 *      attribution is possible.
 *   3. Lineage snapshot fallback — `TaskCommitAssociation` rows keyed by
 *      `taskLineageId`, filtered to commits that are reachable in THIS
 *      sub-repo (`git cat-file -e <sha>`) — a lineage snapshot is task-wide,
 *      not per-repo, so it must be filtered per sub-repo to avoid attributing
 *      another sub-repo's commit here.
 */
export async function resolveWorkspaceTaskRevertCommits(
  task: Pick<Task, "id" | "lineageId" | "mergeDetails" | "workspaceWorktrees">,
  opts: ResolveWorkspaceTaskRevertCommitsOptions,
): Promise<Record<string, WorkspaceRepoRevertCommits>> {
  const execImpl = opts.execAsyncImpl ?? defaultExecAsync;
  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  const repoKeys = Object.keys(workspaceWorktrees).sort();
  const workspaceLandedShas = task.mergeDetails?.workspaceLandedShas ?? {};

  const result: Record<string, WorkspaceRepoRevertCommits> = {};

  for (const repoRel of repoKeys) {
    const entry = workspaceWorktrees[repoRel];
    const repoRootDir = join(opts.workspaceRootDir, repoRel);
    const landedSha = workspaceLandedShas[repoRel] ?? entry?.landedSha;

    if (landedSha && !entry?.baseCommitSha) {
      result[repoRel] = { commits: [landedSha], source: "squash" };
      continue;
    }

    if (landedSha && entry?.baseCommitSha) {
      const rangeRef = `${entry.baseCommitSha}..${landedSha}`;
      let ownCommitShas: string[];
      try {
        const collected = await collectOwnTaskCommitsForRange({
          worktreePath: repoRootDir,
          rangeRef,
          taskId: task.id,
          execAsyncImpl: execImpl,
        });
        ownCommitShas = collected.ownCommitShas;
      } catch (error) {
        throw new TaskRevertError(`git log failed for sub-repo ${repoRel} range ${rangeRef}`, "git-log-failed", error);
      }
      if (ownCommitShas.length > 0) {
        result[repoRel] = { commits: ownCommitShas, source: "rebase" };
      } else {
        result[repoRel] = { commits: [landedSha], source: "rebase" };
      }
      continue;
    }

    // No representative landed sha recorded for this sub-repo — fall back to
    // the lineage-snapshot association table, filtered to commits reachable
    // in THIS sub-repo (a lineage snapshot is task-wide, not per-repo).
    const lineageId = task.lineageId ?? task.id;
    if (!opts.commitAssociationSource) {
      result[repoRel] = { commits: [], source: "none" };
      continue;
    }
    const associations = await opts.commitAssociationSource.getTaskCommitAssociationsByLineageId(lineageId);
    const reachableShas: string[] = [];
    for (const association of associations) {
      try {
        await runGit(execImpl, `git cat-file -e ${quoteShellArg(`${association.commitSha}^{commit}`)}`, repoRootDir);
        reachableShas.push(association.commitSha);
      } catch {
        // Not reachable in this sub-repo — belongs to another sub-repo or is stale.
      }
    }
    result[repoRel] = { commits: reachableShas, source: reachableShas.length > 0 ? "lineage" : "none" };
  }

  return result;
}

export interface WorkspaceRepoRevertResult {
  repo: string;
  classification: TaskRevertClassification;
  revertCommitSha?: string;
  conflicts?: TaskRevertConflict[];
  alreadyReverted?: boolean;
}

export type WorkspaceTaskRevertResult =
  | { mode: "git"; clean: true; workspace: { repos: WorkspaceRepoRevertResult[] } }
  | { mode: "git"; clean: false; workspace: { repos: WorkspaceRepoRevertResult[] }; conflicts: (TaskRevertConflict & { repo: string })[] }
  | { mode: "git"; unsupported: true; reason: string }
  | { mode: "git"; needsHuman: true; reason: string };

export interface RevertWorkspaceTaskOptions {
  task: Pick<Task, "id" | "lineageId" | "column" | "mergeDetails" | "workspaceWorktrees" | "autoMerge" | "userPaused" | "paused">;
  /** Project root dir; each sub-repo lives at `join(workspaceRootDir, repoRel)` (mirrors `landWorkspaceTask`). */
  workspaceRootDir: string;
  /** Project settings, passed through to `resolveIntegrationBranch` per sub-repo with `integrationBranch`/`baseBranch` stripped (KTD1 — each sub-repo resolves its OWN default). */
  settings: IntegrationBranchSettings;
  execAsyncImpl?: ExecAsyncImpl;
  commitAssociationSource?: TaskCommitAssociationSource;
  /** Resolved effective project autoMerge setting (task.autoMerge overrides this when set). Defaults to true (autoMerge on) when omitted. */
  effectiveAutoMerge?: boolean;
}

interface WorkspaceRepoRevertContext {
  repo: string;
  repoRootDir: string;
  preRevertHead: string;
  commits: string[];
  classification: ClassifyTaskRevertResult;
}

/**
 * FNXC:TaskRevert 2026-07-04-00:00 (FN-7547 — the core safety invariant of
 * this module's workspace path):
 *
 * ALL-OR-NOTHING WHOLE-TASK CLASSIFICATION: this function dry-run classifies
 * EVERY sub-repo FIRST (via the shared `classifyTaskRevert`, which already
 * guarantees a byte-identical per-repo rollback in its own `finally`). The
 * whole task is `clean` iff EVERY acquired sub-repo classifies clean or
 * already-reverted; if ANY sub-repo classifies conflicting, the whole task is
 * `conflicting` and the commit phase never runs for ANY sub-repo.
 *
 * TWO-PHASE COMMIT ORDERING: only after every sub-repo classifies
 * clean/already-reverted does this function re-apply and commit per repo
 * (reusing `applyAndCommitRevert`, the same machinery `performTaskRevert`
 * uses for the single-repo squash path). This classify-all-then-commit-all
 * ordering means a late conflict (the sub-repo's branch moved between
 * classify and apply) can only ever occur DURING the commit phase, never
 * invalidating an already-clean classification from an earlier repo in the
 * same pass.
 *
 * MULTI-REPO ROLLBACK GUARANTEE: if a LATER sub-repo conflicts during the
 * commit phase after an EARLIER sub-repo in this same pass already committed,
 * every already-committed sub-repo is rolled back (`git revert --abort` +
 * `git reset --hard <preRevertHead>`) before returning — so a late conflict
 * can never leave some sub-repos reverted while others are not. Every touched
 * sub-repo worktree is guaranteed byte-identical to its pre-call state on any
 * non-success path.
 *
 * GUARD RAILS (mirrors `performTaskRevert`): only done/archived tasks are
 * revertable; `autoMerge:false` refuses with `needsHuman` instead of forcing
 * a write; this function NEVER mutates the source task's store row/column.
 */
export async function revertWorkspaceTask(opts: RevertWorkspaceTaskOptions): Promise<WorkspaceTaskRevertResult> {
  const { task, workspaceRootDir } = opts;
  const execImpl = opts.execAsyncImpl ?? defaultExecAsync;

  if (!REVERTABLE_COLUMNS.has(task.column)) {
    return { mode: "git", needsHuman: true, reason: `task is in column "${task.column}"; only done/archived tasks are revertable` };
  }

  const effectiveAutoMerge = task.autoMerge ?? opts.effectiveAutoMerge ?? true;
  if (effectiveAutoMerge === false) {
    return { mode: "git", needsHuman: true, reason: "autoMerge is disabled for this task/project; refusing to force-write a revert commit" };
  }

  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  const repoKeys = Object.keys(workspaceWorktrees).sort();
  if (repoKeys.length === 0) {
    return { mode: "git", unsupported: true, reason: "task has no workspaceWorktrees entries; not a workspace task" };
  }

  const attribution = await resolveWorkspaceTaskRevertCommits(task, {
    workspaceRootDir,
    execAsyncImpl: execImpl,
    commitAssociationSource: opts.commitAssociationSource,
  });

  // Phase 1: resolve each sub-repo's integration branch, capture its
  // pre-revert HEAD, refuse (without mutating) on a dirty tree, then dry-run
  // classify. classifyTaskRevert already guarantees its OWN byte-identical
  // rollback per repo, so no additional rollback bookkeeping is needed here
  // for the classify phase itself.
  const contexts: WorkspaceRepoRevertContext[] = [];
  for (const repoRel of repoKeys) {
    const repoRootDir = join(workspaceRootDir, repoRel);

    // Re-resolve THIS sub-repo's integration branch with the shared overrides
    // stripped (KTD1), mirroring `landWorkspaceTask`/self-healing, so each
    // sub-repo resolves its own default rather than inheriting a workspace-wide override.
    let integrationBranch: string;
    try {
      integrationBranch = await resolveIntegrationBranch(repoRootDir, { ...opts.settings, integrationBranch: undefined, baseBranch: undefined });
    } catch (error) {
      throw new TaskRevertError(`failed to resolve integration branch for sub-repo ${repoRel}`, "integration-branch-resolve-failed", error);
    }

    // FNXC:TaskRevert 2026-07-04-00:00: each sub-repo checkout under
    // `workspaceRootDir` can legitimately sit on any branch (mirrors the
    // single-repo route's `rootDir` branch-mismatch guard) — refuse rather
    // than silently committing a revert onto the wrong branch.
    const currentBranch = (await runGit(execImpl, "git rev-parse --abbrev-ref HEAD", repoRootDir)).stdout.trim();
    if (currentBranch !== integrationBranch) {
      throw new TaskRevertError(
        `sub-repo ${repoRel} checkout is on "${currentBranch}", not its integration branch "${integrationBranch}"; switch to "${integrationBranch}" before reverting`,
        "branch-mismatch",
      );
    }

    const { stdout: statusOut } = await runGit(execImpl, "git status --porcelain", repoRootDir);
    if (statusOut.trim().length > 0) {
      throw new TaskRevertError(
        `working tree for sub-repo ${repoRel} is dirty; refusing to attempt a revert dry-run`,
        "dirty-working-tree",
      );
    }

    const { stdout: headOut } = await runGit(execImpl, "git rev-parse HEAD", repoRootDir);
    const preRevertHead = headOut.trim();

    const commits = attribution[repoRel]?.commits ?? [];
    const classification = await classifyTaskRevert({ worktreePath: repoRootDir, commits, execAsyncImpl: execImpl });

    contexts.push({ repo: repoRel, repoRootDir, preRevertHead, commits, classification });
  }

  const anyConflicting = contexts.some((ctx) => ctx.classification.classification === "conflicting");
  if (anyConflicting) {
    const repos: WorkspaceRepoRevertResult[] = contexts.map((ctx) => ({
      repo: ctx.repo,
      classification: ctx.classification.classification,
      conflicts: ctx.classification.conflicts,
      alreadyReverted: ctx.classification.alreadyReverted,
    }));
    const conflicts = contexts.flatMap((ctx) =>
      (ctx.classification.conflicts ?? []).map((conflict) => ({ ...conflict, repo: ctx.repo })),
    );
    return { mode: "git", clean: false, workspace: { repos }, conflicts };
  }

  // Phase 2: every sub-repo classified clean/already-reverted — apply+commit
  // per repo. Track committed repos so a LATE conflict (branch moved between
  // classify and apply) can roll back every already-committed sub-repo too.
  const repos: WorkspaceRepoRevertResult[] = [];
  const committedRepos: { repo: string; repoRootDir: string; preRevertHead: string }[] = [];

  try {
    for (const ctx of contexts) {
      if (ctx.classification.classification === "already-reverted" || ctx.commits.length === 0) {
        repos.push({ repo: ctx.repo, classification: "already-reverted", alreadyReverted: true });
        continue;
      }

      const applied = await applyAndCommitRevert({
        worktreePath: ctx.repoRootDir,
        commits: ctx.commits,
        taskId: task.id,
        execAsyncImpl: execImpl,
      });

      if (applied.applied) {
        repos.push({ repo: ctx.repo, classification: "clean", revertCommitSha: applied.revertCommitSha });
        committedRepos.push({ repo: ctx.repo, repoRootDir: ctx.repoRootDir, preRevertHead: ctx.preRevertHead });
        continue;
      }

      if ("alreadyReverted" in applied) {
        repos.push({ repo: ctx.repo, classification: "already-reverted", alreadyReverted: true });
        continue;
      }

      // Late conflict — applyAndCommitRevert already rolled back THIS repo.
      // Roll back every PREVIOUSLY committed sub-repo in this pass so the
      // whole-task revert stays all-or-nothing.
      for (const committed of committedRepos) {
        await runGit(execImpl, "git revert --abort", committed.repoRootDir).catch(() => undefined);
        await runGit(execImpl, `git reset --hard ${quoteShellArg(committed.preRevertHead)}`, committed.repoRootDir).catch(() => undefined);
      }
      const conflictRepos: WorkspaceRepoRevertResult[] = [
        ...repos,
        { repo: ctx.repo, classification: "conflicting", conflicts: applied.conflicts },
      ];
      const conflicts = (applied.conflicts ?? []).map((conflict) => ({ ...conflict, repo: ctx.repo }));
      return { mode: "git", clean: false, workspace: { repos: conflictRepos }, conflicts };
    }
  } catch (error) {
    // Unexpected failure mid-pass — roll back every already-committed sub-repo.
    for (const committed of committedRepos) {
      await runGit(execImpl, "git revert --abort", committed.repoRootDir).catch(() => undefined);
      await runGit(execImpl, `git reset --hard ${quoteShellArg(committed.preRevertHead)}`, committed.repoRootDir).catch(() => undefined);
    }
    throw error instanceof TaskRevertError ? error : new TaskRevertError("failed to apply workspace revert", "workspace-revert-apply-failed", error);
  }

  return { mode: "git", clean: true, workspace: { repos } };
}

// ---------------------------------------------------------------------------
// FN-7577: PR-based revert for WORKSPACE (multi-repo) tasks under autoMerge:false.
// ---------------------------------------------------------------------------

export interface WorkspaceRepoRevertPrBranch {
  repo: string;
  /** Same branch NAME across every sub-repo (`fusion/revert-<task-id-lowercase>`). */
  revertBranch: string;
  /** This sub-repo's resolved integration branch — the PR base. NEVER written to. */
  integrationBranch: string;
  revertCommitShas: string[];
}

export type PrepareWorkspaceRevertPrBranchesResult =
  | { eligible: true; repos: WorkspaceRepoRevertPrBranch[] }
  | {
      eligible: false;
      classification: "conflicting";
      conflicts: (TaskRevertConflict & { repo: string })[];
      repos: WorkspaceRepoRevertResult[];
    }
  | { eligible: false; unsupported: true; reason: string };

export interface PrepareWorkspaceRevertPrBranchesOptions {
  task: Pick<Task, "id" | "lineageId" | "column" | "mergeDetails" | "workspaceWorktrees">;
  /** Project root dir; each sub-repo lives at `join(workspaceRootDir, repoRel)` (mirrors `revertWorkspaceTask`). */
  workspaceRootDir: string;
  /** Project settings, passed through to `resolveIntegrationBranch` per sub-repo with `integrationBranch`/`baseBranch` stripped (KTD1). */
  settings: IntegrationBranchSettings;
  /** e.g. `fusion/revert-<task-id-lowercase>` — the SAME branch name prepared in every sub-repo. */
  revertBranch: string;
  execAsyncImpl?: ExecAsyncImpl;
  commitAssociationSource?: TaskCommitAssociationSource;
}

interface WorkspaceRepoRevertPrContext {
  repo: string;
  repoRootDir: string;
  integrationBranch: string;
  commits: string[];
  classification: ClassifyTaskRevertResult;
}

type PrepareOneWorkspaceRepoBranchOutcome =
  | { kind: "applied"; revertCommitSha: string }
  | { kind: "already-reverted" }
  | { kind: "conflicts"; conflicts: TaskRevertConflict[] };

/**
 * FNXC:TaskRevert 2026-07-05-00:00 (FN-7577 — per-sub-repo branch prep
 * primitive, mirrors FN-7554's single-repo `prepareRevertPrBranch` body):
 * Prepares ONE sub-repo's dedicated `revertBranch` off `integrationBranch`
 * HEAD (`-B`, idempotent re-run), applies+commits via the shared
 * `applyAndCommitRevert` (REUSE, not reimplementation — same helper
 * `performTaskRevert`/`revertWorkspaceTask`/`prepareRevertPrBranch` all use),
 * and ALWAYS restores the sub-repo checkout back to `integrationBranch`
 * before returning — `integrationBranch`'s ref itself is never advanced,
 * reset, or committed to. A redundant/failed local `revertBranch` (nothing
 * to commit, or a late apply-time conflict) is deleted so this sub-repo is
 * left byte-identical to its pre-call state whenever no PR branch results.
 */
async function prepareOneWorkspaceRepoRevertBranch(opts: {
  execImpl: ExecAsyncImpl;
  repoRootDir: string;
  integrationBranch: string;
  revertBranch: string;
  commits: string[];
  taskId: string;
}): Promise<PrepareOneWorkspaceRepoBranchOutcome> {
  const { execImpl, repoRootDir, integrationBranch, revertBranch, commits, taskId } = opts;
  let branchCreated = false;
  try {
    // FNXC:TaskRevert 2026-07-05-00:00: `-B` (create-or-reset) makes
    // re-running this idempotent when a stale local `revertBranch` already
    // exists from a prior failed/aborted attempt — reset off
    // `integrationBranch` HEAD rather than accumulating on top of whatever it
    // previously pointed at. `integrationBranch` is only ever READ here.
    await runGit(execImpl, `git checkout -B ${quoteShellArg(revertBranch)} ${quoteShellArg(integrationBranch)}`, repoRootDir);
    branchCreated = true;

    const applied = await applyAndCommitRevert({ worktreePath: repoRootDir, commits, taskId, execAsyncImpl: execImpl });

    if ("alreadyReverted" in applied) {
      // Defensive: the branch moved between classify and apply — nothing to
      // commit on the fresh revertBranch. Delete the now-redundant branch so
      // this sub-repo contributes no branch to the caller.
      await runGit(execImpl, `git checkout ${quoteShellArg(integrationBranch)}`, repoRootDir).catch(() => undefined);
      await runGit(execImpl, `git branch -D ${quoteShellArg(revertBranch)}`, repoRootDir).catch(() => undefined);
      return { kind: "already-reverted" };
    }
    if ("conflicts" in applied) {
      // Late conflict — applyAndCommitRevert already rolled repoRootDir back to
      // the tip of revertBranch (== integrationBranch HEAD). Delete the
      // now-redundant branch; the caller handles multi-repo rollback.
      await runGit(execImpl, `git checkout ${quoteShellArg(integrationBranch)}`, repoRootDir).catch(() => undefined);
      await runGit(execImpl, `git branch -D ${quoteShellArg(revertBranch)}`, repoRootDir).catch(() => undefined);
      return { kind: "conflicts", conflicts: applied.conflicts };
    }

    // applied.applied === true — leave `revertBranch` in place (it IS the PR
    // branch) but restore the sub-repo checkout back to `integrationBranch`,
    // never leaving it mid-revert on `revertBranch`.
    await runGit(execImpl, `git checkout ${quoteShellArg(integrationBranch)}`, repoRootDir).catch(() => undefined);
    return { kind: "applied", revertCommitSha: applied.revertCommitSha };
  } catch (error) {
    // On any thrown failure after branch creation, never leave a dangling
    // partial revert branch behind — best-effort restore + delete.
    if (branchCreated) {
      await runGit(execImpl, `git checkout ${quoteShellArg(integrationBranch)}`, repoRootDir).catch(() => undefined);
      await runGit(execImpl, `git branch -D ${quoteShellArg(revertBranch)}`, repoRootDir).catch(() => undefined);
    }
    throw error instanceof TaskRevertError
      ? error
      : new TaskRevertError("failed to prepare revert branch for sub-repo", "revert-pr-branch-prepare-failed", error);
  }
}

/**
 * FNXC:TaskRevert 2026-07-05-00:00 (FN-7577 — workspace PR-revert branch prep,
 * the all-or-nothing gate this task adds on top of FN-7554/FN-7547):
 *
 * NEVER-WRITE-TO-INTEGRATION-BRANCH INVARIANT: mirrors `prepareRevertPrBranch`
 * (single-repo) extended to N sub-repos — no sub-repo's integration branch
 * ref is EVER advanced, reset, or committed to. Every revert commit lives
 * ONLY on that sub-repo's `<revertBranch>` (same branch NAME across every
 * sub-repo, distinct branch OBJECT per sub-repo git history).
 *
 * CLASSIFY-ALL-THEN-PREP-ALL (Phase 1 / Phase 2), mirroring
 * `revertWorkspaceTask`'s whole-task all-or-nothing contract: Phase 1
 * dry-run classifies EVERY sub-repo first (reusing the shared
 * `classifyTaskRevert`, itself always rolling each tree back
 * byte-identical). If ANY sub-repo classifies `conflicting`, this function
 * returns immediately with NO branch created anywhere — Phase 2 (branch
 * prep) never runs for ANY sub-repo. Only when every sub-repo classifies
 * clean/already-reverted does Phase 2 run, preparing one dedicated
 * `<revertBranch>` per sub-repo that actually has commits to revert
 * (`prepareOneWorkspaceRepoRevertBranch`, reusing `applyAndCommitRevert` — no
 * commit-message/trailer duplication). A LATE conflict during Phase 2 (a
 * sub-repo's branch moved between classify and apply) rolls back every
 * PREVIOUSLY prepped sub-repo's branch in this pass (checkout back +
 * `git branch -D`) before returning conflicting, so the whole preparation
 * stays all-or-nothing even when the failure surfaces mid-pass rather than
 * during classification.
 *
 * THIS FUNCTION DOES NOT GATE ON `autoMerge` — the caller (the API route)
 * decides when to invoke this primitive; it stays a pure branch-prep
 * building block usable independent of that policy decision.
 */
export async function prepareWorkspaceRevertPrBranches(
  opts: PrepareWorkspaceRevertPrBranchesOptions,
): Promise<PrepareWorkspaceRevertPrBranchesResult> {
  const { task, workspaceRootDir, revertBranch } = opts;
  const execImpl = opts.execAsyncImpl ?? defaultExecAsync;

  if (!isWorkspaceTask(task) || Object.keys(task.workspaceWorktrees ?? {}).length === 0) {
    return { eligible: false, unsupported: true, reason: "not-a-workspace-task" };
  }

  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  const repoKeys = Object.keys(workspaceWorktrees).sort();

  const attribution = await resolveWorkspaceTaskRevertCommits(task, {
    workspaceRootDir,
    execAsyncImpl: execImpl,
    commitAssociationSource: opts.commitAssociationSource,
  });

  // Phase 1: resolve each sub-repo's integration branch, refuse (without
  // mutating) on branch-mismatch/dirty-tree, then dry-run classify EVERY
  // sub-repo — mirrors `revertWorkspaceTask`'s Phase 1 verbatim.
  const contexts: WorkspaceRepoRevertPrContext[] = [];
  for (const repoRel of repoKeys) {
    const repoRootDir = join(workspaceRootDir, repoRel);

    let integrationBranch: string;
    try {
      integrationBranch = await resolveIntegrationBranch(repoRootDir, { ...opts.settings, integrationBranch: undefined, baseBranch: undefined });
    } catch (error) {
      throw new TaskRevertError(`failed to resolve integration branch for sub-repo ${repoRel}`, "integration-branch-resolve-failed", error);
    }

    const currentBranch = (await runGit(execImpl, "git rev-parse --abbrev-ref HEAD", repoRootDir)).stdout.trim();
    if (currentBranch !== integrationBranch) {
      throw new TaskRevertError(
        `sub-repo ${repoRel} checkout is on "${currentBranch}", not its integration branch "${integrationBranch}"; switch to "${integrationBranch}" before preparing a revert PR branch`,
        "branch-mismatch",
      );
    }

    const { stdout: statusOut } = await runGit(execImpl, "git status --porcelain", repoRootDir);
    if (statusOut.trim().length > 0) {
      throw new TaskRevertError(
        `working tree for sub-repo ${repoRel} is dirty; refusing to prepare a revert PR branch`,
        "dirty-working-tree",
      );
    }

    const commits = attribution[repoRel]?.commits ?? [];
    const classification = await classifyTaskRevert({ worktreePath: repoRootDir, commits, execAsyncImpl: execImpl });

    contexts.push({ repo: repoRel, repoRootDir, integrationBranch, commits, classification });
  }

  const anyConflicting = contexts.some((ctx) => ctx.classification.classification === "conflicting");
  if (anyConflicting) {
    const repos: WorkspaceRepoRevertResult[] = contexts.map((ctx) => ({
      repo: ctx.repo,
      classification: ctx.classification.classification,
      conflicts: ctx.classification.conflicts,
      alreadyReverted: ctx.classification.alreadyReverted,
    }));
    const conflicts = contexts.flatMap((ctx) =>
      (ctx.classification.conflicts ?? []).map((conflict) => ({ ...conflict, repo: ctx.repo })),
    );
    return { eligible: false, classification: "conflicting", conflicts, repos };
  }

  // Phase 2: every sub-repo classified clean/already-reverted — prepare a
  // dedicated revert branch per sub-repo that actually has commits to revert.
  const preppedRepos: WorkspaceRepoRevertPrBranch[] = [];
  const preppedForRollback: { repo: string; repoRootDir: string; integrationBranch: string }[] = [];

  try {
    for (const ctx of contexts) {
      if (ctx.classification.classification === "already-reverted" || ctx.commits.length === 0) {
        // Nothing to revert in this sub-repo — contributes no branch.
        continue;
      }

      const outcome = await prepareOneWorkspaceRepoRevertBranch({
        execImpl,
        repoRootDir: ctx.repoRootDir,
        integrationBranch: ctx.integrationBranch,
        revertBranch,
        commits: ctx.commits,
        taskId: task.id,
      });

      if (outcome.kind === "already-reverted") {
        continue;
      }

      if (outcome.kind === "conflicts") {
        // Late conflict — roll back every PREVIOUSLY prepped sub-repo's branch
        // in this pass so the whole preparation stays all-or-nothing.
        for (const prepped of preppedForRollback) {
          await runGit(execImpl, `git checkout ${quoteShellArg(prepped.integrationBranch)}`, prepped.repoRootDir).catch(() => undefined);
          await runGit(execImpl, `git branch -D ${quoteShellArg(revertBranch)}`, prepped.repoRootDir).catch(() => undefined);
        }
        const conflicts = outcome.conflicts.map((conflict) => ({ ...conflict, repo: ctx.repo }));
        const repos: WorkspaceRepoRevertResult[] = contexts.map((c) => ({
          repo: c.repo,
          classification: c.repo === ctx.repo ? "conflicting" : c.classification.classification,
          conflicts: c.repo === ctx.repo ? outcome.conflicts : c.classification.conflicts,
          alreadyReverted: c.classification.alreadyReverted,
        }));
        return { eligible: false, classification: "conflicting", conflicts, repos };
      }

      // outcome.kind === "applied"
      preppedRepos.push({
        repo: ctx.repo,
        revertBranch,
        integrationBranch: ctx.integrationBranch,
        revertCommitShas: [outcome.revertCommitSha],
      });
      preppedForRollback.push({ repo: ctx.repo, repoRootDir: ctx.repoRootDir, integrationBranch: ctx.integrationBranch });
    }
  } catch (error) {
    // Unexpected thrown failure mid-pass — best-effort restore + delete every
    // already-prepped sub-repo branch so a failed prep never leaves dangling
    // half-built revert branches.
    for (const prepped of preppedForRollback) {
      await runGit(execImpl, `git checkout ${quoteShellArg(prepped.integrationBranch)}`, prepped.repoRootDir).catch(() => undefined);
      await runGit(execImpl, `git branch -D ${quoteShellArg(revertBranch)}`, prepped.repoRootDir).catch(() => undefined);
    }
    throw error instanceof TaskRevertError
      ? error
      : new TaskRevertError("failed to prepare workspace revert PR branches", "workspace-revert-pr-branch-prepare-failed", error);
  }

  return { eligible: true, repos: preppedRepos };
}

// ────────────────────────────────────────────────────────────────────────
// FN-7524: AI-undo fallback
// ────────────────────────────────────────────────────────────────────────

/**
 * FNXC:TaskRevert 2026-07-04-00:00 (AI-undo marker contract):
 * `REVERT_OF_METADATA_KEY` is the idempotency key stamped onto an AI-undo
 * board task's `source.sourceMetadata`. The route's dedup guard
 * (`TaskStore.findOpenRevertTaskForSource`, core) scans OPEN (non
 * done/archived) tasks for `sourceMetadata.revertOf === sourceTaskId` before
 * creating a new one — a second `mode:"ai"`/conflict-fallback call for the
 * same source task while an undo task is still open MUST return the existing
 * task's id (`alreadyOpen: true`) instead of creating a duplicate. A prior
 * undo task that has itself reached `done`/`archived` does NOT suppress a
 * fresh one — the work may need undoing again (e.g. redone, then relanded).
 * NEVER repurpose this key for another meaning.
 */
export const REVERT_OF_METADATA_KEY = "revertOf" as const;

export type AiUndoTaskResult = { mode: "ai"; createdTaskId: string; alreadyOpen?: boolean };

function formatLandedFiles(landedFiles: string[] | undefined): string {
  if (!landedFiles || landedFiles.length === 0) {
    return "(no landed-files list recorded on this task; inspect its merge commit(s) directly)";
  }
  return landedFiles.map((file) => `- ${file}`).join("\n");
}

/**
 * FNXC:TaskRevert 2026-07-04-00:00 (AI-undo mission contract):
 * Builds the triage-ready description for the AI-undo board task. References
 * the source task's id, its mission (`task.prompt` when present, else
 * `task.description` — `prompt` carries the fuller generated spec when
 * available), its landed files (`mergeDetails.landedFiles`) plus a pointer to
 * `GET /api/tasks/<id>/diff` for the full landed diff (reused, not
 * recomputed), an explicit instruction to undo the BEHAVIOR/FILES the source
 * task introduced while PRESERVING unrelated changes later tasks made to the
 * same files, and the `revert(FN-xxxx): …` commit convention with a
 * `Fusion-Task-Id: FN-xxxx` trailer referencing the ORIGINAL task (consistent
 * with the git-path commit convention above `performTaskRevert`).
 */
export function buildAiUndoTaskDescription(params: {
  task: Pick<Task, "id" | "title" | "description" | "prompt" | "mergeDetails">;
}): string {
  const { task } = params;
  const mission = task.prompt?.trim() ? task.prompt : task.description;
  const landedFiles = task.mergeDetails?.landedFiles;

  return [
    `Undo the work landed by task ${task.id}${task.title ? ` — "${task.title}"` : ""}.`,
    "",
    "## Why this task exists",
    `A direct \`git revert\` of ${task.id} could not be applied automatically (later commits conflict with it, the task's revert is unsupported, or AI-undo mode was explicitly requested). This task undoes the BEHAVIOR/FILES ${task.id} introduced WHILE PRESERVING unrelated changes made by later tasks that also touched the same files — do not blindly restore the pre-${task.id} version of any shared file.`,
    "",
    `## Original mission (${task.id})`,
    mission,
    "",
    `## Files landed by ${task.id}`,
    formatLandedFiles(landedFiles),
    `See \`GET /api/tasks/${task.id}/diff\` for the full landed diff.`,
    "",
    "## What to do",
    `1. Read ${task.id}'s original mission above and its landed diff.`,
    `2. For each file ${task.id} touched, remove or reverse ONLY the behavior/changes it introduced. If a later task also modified the same file, preserve that later task's unrelated changes.`,
    `3. Commit the undo work using the \`revert(${task.id}): <short summary>\` commit-message convention with a \`Fusion-Task-Id: ${task.id}\` trailer, so the commit stays attributable back to ${task.id} (mirrors the direct git-revert commit convention).`,
    "4. Verify the original behavior is gone (tests/build) and that later, unrelated changes to the same files still work as intended.",
  ].join("\n");
}

/**
 * FNXC:TaskRevert 2026-07-04-00:00 (dependency-free creation rule):
 * The AI-undo task is created via the store's normal `createTask` path
 * (lands in `triage`, gets its own generated PROMPT.md) with `dependencies: []`
 * — it must NEVER depend on the source task. The source task is already
 * done/archived; a dependency on it would be a permanently-satisfied no-op
 * that misrepresents the relationship in dependency UIs.
 */
export interface CreateAiUndoTaskDeps {
  createTask(input: TaskCreateInput): Promise<Task>;
  /** Idempotency lookup — see `REVERT_OF_METADATA_KEY`. Implemented by `TaskStore.findOpenRevertTaskForSource` (core). */
  findOpenRevertTaskForSource(sourceTaskId: string): Promise<Task | null>;
  sourceTask: Pick<Task, "id" | "title" | "description" | "prompt" | "mergeDetails" | "priority">;
  /**
   * FNXC:TaskRevert 2026-07-05-00:00 (FN-7556):
   * Workflow id to select for the created AI-undo task, forwarded verbatim
   * into `createTask({ workflowId })`. The CALLER (the route) resolves and
   * validates this from the `aiUndoTaskWorkflowId` project setting (default
   * `builtin:review-heavy`) — this helper stays pure and never reads
   * settings/the store itself. A blank/undefined value means the created
   * task INHERITS the project default workflow (`createTask`'s `undefined`
   * semantics) — do NOT pass `null` here, which would mean "no workflow".
   */
  workflowId?: string;
}

/**
 * FNXC:TaskRevert 2026-07-04-00:00 (Step 1 entry point):
 * Creates (or, if an open one already exists for this source task, returns
 * the existing) AI-undo board task. This is the fallback the route uses when
 * the git-revert path cannot apply cleanly / is unsupported, or when the
 * caller explicitly requests `mode:"ai"`.
 */
export async function createAiUndoTask(deps: CreateAiUndoTaskDeps): Promise<AiUndoTaskResult> {
  const { sourceTask } = deps;

  // Idempotency FIRST — never create a duplicate while one is still open.
  const existing = await deps.findOpenRevertTaskForSource(sourceTask.id);
  if (existing) {
    return { mode: "ai", createdTaskId: existing.id, alreadyOpen: true };
  }

  const description = buildAiUndoTaskDescription({ task: sourceTask });
  // FNXC:TaskRevert 2026-07-05-00:00 (FN-7556): forward `workflowId` ONLY when
  // a non-empty string is supplied; otherwise omit the key entirely so
  // `createTask` inherits the project default (never pass `null`/"" through).
  const workflowId = deps.workflowId && deps.workflowId.trim() !== "" ? deps.workflowId : undefined;
  const created = await deps.createTask({
    title: `Undo ${sourceTask.id}: ${sourceTask.title ?? sourceTask.description.slice(0, 80)}`,
    description,
    dependencies: [],
    priority: sourceTask.priority,
    source: {
      sourceType: "recovery",
      sourceMetadata: { [REVERT_OF_METADATA_KEY]: sourceTask.id },
    },
    ...(workflowId !== undefined ? { workflowId } : {}),
  });

  return { mode: "ai", createdTaskId: created.id };
}
