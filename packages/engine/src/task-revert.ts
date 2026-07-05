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
 * UI affordance is sibling task FN-7525. Multi-repo workspace-task revert is
 * out of scope here (see `resolveTaskRevertCommits`'s workspace guard).
 *
 * Safety invariant (the core contract of this module): the working tree and
 * index are NEVER left dirty on any failure path. `classifyTaskRevert` always
 * captures `preRevertHead` before touching the tree and guarantees a full
 * `git revert --abort` + `git reset --hard <preRevertHead>` rollback in a
 * `finally` block, regardless of how the dry-run terminates.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Task, TaskCommitAssociation, TaskCreateInput } from "@fusion/core";

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
  task: Pick<Task, "id" | "lineageId" | "column" | "mergeDetails" | "autoMerge" | "userPaused" | "paused">;
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
  const created = await deps.createTask({
    title: `Undo ${sourceTask.id}: ${sourceTask.title ?? sourceTask.description.slice(0, 80)}`,
    description,
    dependencies: [],
    priority: sourceTask.priority,
    source: {
      sourceType: "recovery",
      sourceMetadata: { [REVERT_OF_METADATA_KEY]: sourceTask.id },
    },
  });

  return { mode: "ai", createdTaskId: created.id };
}
