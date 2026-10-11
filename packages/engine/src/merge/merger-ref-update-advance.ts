import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunAuditor } from "../util/run-audit.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
/** `merge --ff-only` rewrites files across the whole checkout, so it needs more headroom than the metadata-only reads around it. */
const MERGE_TIMEOUT_MS = 120_000;

async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
  });
}

const testHooks = {
  runGit,
};

export class IntegrationBranchConcurrentAdvanceError extends Error {
  readonly integrationBranch: string;
  readonly expectedCurrentSha: string;
  readonly observedCurrentSha?: string;
  readonly newSha: string;
  readonly taskId: string;

  constructor(args: {
    integrationBranch: string;
    expectedCurrentSha: string;
    observedCurrentSha?: string;
    newSha: string;
    taskId: string;
  }) {
    const { integrationBranch, expectedCurrentSha, observedCurrentSha, newSha, taskId } = args;
    super(
      `Integration branch ${integrationBranch} advanced concurrently (expected ${expectedCurrentSha}, observed ${observedCurrentSha ?? "unknown"}) while applying ${newSha} for ${taskId}`,
    );
    this.name = "IntegrationBranchConcurrentAdvanceError";
    this.integrationBranch = integrationBranch;
    this.expectedCurrentSha = expectedCurrentSha;
    this.observedCurrentSha = observedCurrentSha;
    this.newSha = newSha;
    this.taskId = taskId;
  }
}

/*
FNXC:LandingGuard 2026-09-29 (STAS-292):
Every way a landing can be refused is reported as this one error, whose message
always opens with `landing refused:` and names the checkout at fault. A refusal
leaves the integration ref exactly where it was: there is deliberately no path
in this file that moves the ref and leaves a checkout behind, and none that
resets, stashes or cleans anyone's work to escape a refusal.
*/
export class IntegrationLandingRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationLandingRefusedError";
  }
}

export type IntegrationRefAdvanceMode = "merge-ff-only" | "update-ref";

interface WorktreeEntry {
  path: string;
  /** The branch its HEAD is attached to, absent for a detached checkout. */
  branch?: string;
  /** Git's own verdict that the registered checkout is gone; such an entry owns nothing. */
  prunable: boolean;
}

/** Reader for `git worktree list --porcelain`, shared by owner discovery and refusal messages. */
function parseWorktreeEntries(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim(), prunable: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length).trim();
    if (line.startsWith("prunable")) current.prunable = true;
  }
  if (current) entries.push(current);
  return entries;
}

async function readWorktreeEntries(rootDir: string): Promise<WorktreeEntry[]> {
  const { stdout } = await testHooks.runGit(["worktree", "list", "--porcelain"], rootDir);
  return parseWorktreeEntries(stdout);
}

/**
 * Which checkouts have `integrationBranch` attached to HEAD. Empty means the
 * branch is checked out nowhere; more than one means duplicate checkouts
 * (`git worktree add -f` / `checkout --ignore-other-worktrees`). A registration
 * git reports as prunable owns nothing — it is an admin entry whose directory is
 * gone, and treating it as an owner would strand the landing on a path that
 * cannot be read.
 *
 * A failed listing propagates on purpose: reading a broken listing as "checked
 * out nowhere" is exactly how a ref-only write would re-create the stale-checkout
 * phantom this file exists to prevent.
 */
export async function listIntegrationBranchWorktrees(args: {
  rootDir: string;
  integrationBranch: string;
}): Promise<Array<{ path: string }>> {
  const entries = await readWorktreeEntries(args.rootDir);
  return entries
    .filter((entry) => !entry.prunable && entry.branch === args.integrationBranch)
    .map((entry) => ({ path: entry.path }));
}

interface IndexMismatch {
  headTree: string;
  indexTree: string;
  files: string[];
}

/**
 * The guard: does this checkout's index describe the commit its HEAD points at?
 * A landing that moves only the ref leaves the index on the old tip, and
 * `git status` in that checkout then reports the newly landed content as a
 * staged revert of it — the phantom that made users believe shipped work had
 * been rolled back. `write-tree` vs `HEAD^{tree}` is the one read that sees that
 * state; `git status`'s dirty flag alone does not distinguish it from real work.
 */
async function readIndexMismatch(worktreePath: string): Promise<IndexMismatch | null> {
  const { stdout: headTreeOut } = await testHooks.runGit(["rev-parse", "HEAD^{tree}"], worktreePath);
  const headTree = headTreeOut.trim();
  let indexTree: string;
  try {
    const { stdout } = await testHooks.runGit(["write-tree"], worktreePath);
    indexTree = stdout.trim();
  } catch {
    indexTree = "unmergeable-index";
  }
  if (indexTree === headTree) return null;
  const { stdout } = await testHooks.runGit(["diff", "--cached", "--name-only", "HEAD"], worktreePath);
  return { headTree, indexTree, files: stdout.split("\n").filter(Boolean) };
}

function describeIndexMismatch(args: {
  worktreePath: string;
  mismatch: IndexMismatch;
  /** Names the moment the mismatch was read, so a pre-landing refusal and a post-advance one don't read the same. */
  stage: string;
}): string {
  const { worktreePath, mismatch, stage } = args;
  const files = mismatch.files.join(", ");
  return (
    `landing refused: ${worktreePath} index does not match HEAD (${stage}) — `
    + `files: ${files}; `
    + `expected tree (= HEAD): ${mismatch.headTree}; `
    + `actual index tree (write-tree): ${mismatch.indexTree}. `
    + `Repair the checkout, then re-run the landing: `
    + `git restore --source=HEAD --staged --worktree -- ${files}`
  );
}

function describeGitError(error: unknown): string {
  if (error instanceof Error) {
    const withStreams = error as Error & { stderr?: string; stdout?: string };
    const combined = [withStreams.stderr, withStreams.stdout, withStreams.message]
      .filter((part) => !!part?.trim())
      .join("\n")
      .trim();
    return combined || error.message;
  }
  return String(error);
}


/** The guard applied to one checkout: refuses when its index does not describe its HEAD. */
async function assertOwnerIndexMatchesHead(worktreePath: string, stage: string): Promise<void> {
  const mismatch = await readIndexMismatch(worktreePath);
  if (!mismatch) return;
  throw new IntegrationLandingRefusedError(describeIndexMismatch({ worktreePath, mismatch, stage }));
}

/**
 * Which checkout may be advanced, refusing the shapes where "the" checkout is not
 * one well-defined thing: an unreadable listing (never silently read as "checked
 * out nowhere") or two checkouts claiming the branch.
 */
async function resolveLandingOwner(args: {
  rootDir: string;
  integrationBranch: string;
  stage: string;
}): Promise<{ path: string } | undefined> {
  const { rootDir, integrationBranch, stage } = args;
  let owners: Array<{ path: string }>;
  try {
    owners = await listIntegrationBranchWorktrees({ rootDir, integrationBranch });
  } catch (error: unknown) {
    throw new IntegrationLandingRefusedError(
      `landing refused: could not read which worktree checks out ${integrationBranch} (${stage}) — ${describeGitError(error)}. `
      + `A landing that guessed "checked out nowhere" here is what re-creates the stale-checkout phantom.`,
    );
  }
  if (owners.length > 1) {
    throw new IntegrationLandingRefusedError(
      `landing refused: ${integrationBranch} is checked out in ${owners.length} worktrees (${owners.map((owner) => owner.path).join(", ")}) — `
      + `one landing cannot refresh them all, and advancing one would leave the others showing the landing as a staged revert. `
      + `Remove the duplicate checkout: git worktree remove <path>`,
    );
  }
  return owners[0];
}

function describeRefusal(error: unknown): string {
  return error instanceof IntegrationLandingRefusedError ? error.message : describeGitError(error);
}

/**
 * Read-only landing health check: every checkout that owns `integrationBranch`
 * must have an index and working tree that match its HEAD. This is the same
 * assertion the guarded advance runs immediately before it moves a ref — exposed
 * separately so a landing can refuse before it has touched anything, rather than
 * after stashing a user's work or publishing a workspace fence ref.
 *
 * One implementation with the advance, not a second rule: it shares the owner
 * discovery and the index measurement, so the two can never disagree.
 */
export async function assertLandingTargetHealthy(args: {
  rootDir: string;
  integrationBranch: string;
}): Promise<{ worktreePath?: string }> {
  const { rootDir, integrationBranch } = args;
  if (!integrationBranch?.trim()) throw new Error("assertLandingTargetHealthy requires integrationBranch");
  const owner = await resolveLandingOwner({ rootDir, integrationBranch, stage: "before the landing" });
  if (!owner) return {};
  await assertOwnerIndexMatchesHead(owner.path, "before the landing");
  return { worktreePath: owner.path };
}

/**
 * Rewind a checked-out integration branch together with its index and working
 * tree, for the recovery lanes that have to move a branch backwards (a
 * cross-contaminated task branch, a PR-head rollback). This is the same
 * invariant as a landing, pointed the other way: ref, index and files move as
 * one unit, the reflog entry names the reason, and a checkout carrying any
 * uncommitted work — including untracked files — refuses with nothing moved.
 */
export async function rewriteCheckedOutRefBackwards(args: {
  worktreePath: string;
  integrationBranch: string;
  targetSha: string;
  expectedCurrentSha: string;
  reason: string;
}): Promise<{ previousSha: string; newSha: string }> {
  const { worktreePath, integrationBranch, targetSha, expectedCurrentSha, reason } = args;
  if (!integrationBranch?.trim()) throw new Error("rewriteCheckedOutRefBackwards requires integrationBranch");
  if (!targetSha?.trim()) throw new Error("rewriteCheckedOutRefBackwards requires targetSha");
  if (!expectedCurrentSha?.trim()) throw new Error("rewriteCheckedOutRefBackwards requires expectedCurrentSha");
  if (!reason?.trim()) throw new Error("rewriteCheckedOutRefBackwards requires reason");

  const ref = `refs/heads/${integrationBranch}`;
  const { stdout: status } = await testHooks.runGit(["status", "--porcelain"], worktreePath);
  const localWork = status.split("\n").filter(Boolean);
  if (localWork.length > 0) {
    throw new IntegrationLandingRefusedError(
      `landing refused: ${worktreePath} carries uncommitted work that a rewind of ${integrationBranch} to ${targetSha} would discard — `
      + `files: ${localWork.join(", ")}; ${ref} stays at ${expectedCurrentSha}. `
      + `Commit or clean these local changes, then re-run (${reason}).`,
    );
  }

  const { stdout: observedOut } = await testHooks.runGit(["rev-parse", "--verify", ref], worktreePath);
  const observed = observedOut.trim();
  if (observed !== expectedCurrentSha) {
    throw new IntegrationLandingRefusedError(
      `landing refused: ${ref} moved concurrently while rewinding ${worktreePath} — `
      + `expected ${expectedCurrentSha}, observed ${observed}; nothing was moved.`,
    );
  }

  try {
    await testHooks.runGit(
      ["update-ref", "--create-reflog", "-m", reason, ref, targetSha, expectedCurrentSha],
      worktreePath,
    );
  } catch (error: unknown) {
    throw new IntegrationLandingRefusedError(
      `landing refused: ${worktreePath} would not rewind ${ref} to ${targetSha} — ${describeGitError(error)}`,
    );
  }

  // The ref is already at the target and the checkout was proven clean above, so
  // loading the target tree into the index and the working tree is a sync, not a
  // discard: `read-tree --reset -u` is the plumbing half of what `merge
  // --ff-only` does in one step, and it cannot destroy local work we refused.
  try {
    await testHooks.runGit(["read-tree", "--reset", "-u", targetSha], worktreePath);
  } catch (error: unknown) {
    throw new IntegrationLandingRefusedError(
      `landing refused: ${worktreePath} moved ${ref} to ${targetSha} but its index and files would not follow — `
      + `${describeGitError(error)}. Repair the checkout: git restore --source=HEAD --staged --worktree -- .`,
    );
  }

  const mismatch = await readIndexMismatch(worktreePath);
  if (mismatch) {
    throw new IntegrationLandingRefusedError(
      describeIndexMismatch({ worktreePath, mismatch, stage: `after rewinding ${integrationBranch} to ${targetSha}` }),
    );
  }
  return { previousSha: expectedCurrentSha, newSha: targetSha };
}

/**
 * Rewind a branch by name, wherever it happens to be checked out. This is the
 * entry point for recovery callers that only know the repo root and the branch —
 * the CLI's PR-head rollback is the `stas-190` shape: a message-less
 * `update-ref` from a repo root that is not the branch's owning checkout left
 * that checkout's index 148 files behind its ref.
 *
 * Owner discovery is the whole point: the rewind either moves the owning
 * checkout's ref, index and files together, or — when the branch is attached to
 * no checkout — writes a named CAS ref. An unreadable listing or duplicate
 * checkout refuses with nothing moved, because guessing there would re-create
 * the phantom this lane once produced.
 */
export async function rewindBranchRef(args: {
  rootDir: string;
  integrationBranch: string;
  targetSha: string;
  expectedCurrentSha: string;
  reason: string;
}): Promise<{ previousSha: string; newSha: string; worktreePath?: string }> {
  const { rootDir, integrationBranch, targetSha, expectedCurrentSha, reason } = args;
  if (!integrationBranch?.trim()) throw new Error("rewindBranchRef requires integrationBranch");
  if (!targetSha?.trim()) throw new Error("rewindBranchRef requires targetSha");
  if (!expectedCurrentSha?.trim()) throw new Error("rewindBranchRef requires expectedCurrentSha");
  if (!reason?.trim()) throw new Error("rewindBranchRef requires reason");

  const owner = await resolveLandingOwner({ rootDir, integrationBranch, stage: `while rewinding ${reason}` });
  if (owner) {
    const moved = await rewriteCheckedOutRefBackwards({
      worktreePath: owner.path,
      integrationBranch,
      targetSha,
      expectedCurrentSha,
      reason,
    });
    return { ...moved, worktreePath: owner.path };
  }

  const ref = `refs/heads/${integrationBranch}`;
  try {
    await testHooks.runGit(
      ["update-ref", "--create-reflog", "-m", reason, ref, targetSha, expectedCurrentSha],
      rootDir,
    );
  } catch (error: unknown) {
    throw new IntegrationLandingRefusedError(
      `landing refused: ${ref} would not rewind to ${targetSha} — ${describeGitError(error)}`,
    );
  }
  return { previousSha: expectedCurrentSha, newSha: targetSha };
}

/*
FNXC:MergeTrunkRefresh 2026-09-29 (STAS-292, recovering STAS-246's contract):
STAS-233's reflog forensics showed that a landing written from OUTSIDE the
checkout that owns the integration branch (`git update-ref refs/heads/main …`,
message-less) leaves that checkout's index on the old tip, so `git status`
inside it reports the trunk's own just-landed content as a staged revert, and
the message-less write erases the reflog trail that names who moved the branch.

The invariant this file enforces: an advance moves ref, HEAD, index and files
together, or it refuses with the ref unmoved.
  * Branch checked out in exactly one worktree → `merge --ff-only` executed FROM
    INSIDE that worktree. It is the only git operation that moves all four
    together and it is atomic: any local edit it would overwrite makes git itself
    refuse, so the checkout is never rewritten to escape a conflict.
  * Branch checked out nowhere (the engine's clean-room / single-branch-clone
    shapes) → a compare-and-swap `update-ref` carrying a reflog message that
    names the landing.
  * Two worktrees claiming the branch, an index that does not match HEAD, a
    refused merge, an unreadable worktree listing, or a post-condition mismatch →
    `IntegrationLandingRefusedError`, ref unmoved.
*/
export async function advanceIntegrationBranchRef(args: {
  rootDir: string;
  integrationBranch: string;
  newSha: string;
  expectedCurrentSha: string;
  taskId: string;
  audit: RunAuditor;
  /*
  FNXC:MergePush 2026-07-11-22:20:
  Explicit opt-in for the push-after-merge divergence path ONLY. A `git pull --rebase`
  against a diverged remote rewrites the local-only commits on top of the remote tip, so
  the resulting sha can never descend from the old local tip — a non-fast-forward ref move
  is inherent to rebase, not an orphaning bug (the rewritten commits carry the same diffs,
  and the old tip stays reachable via the reflog). The CAS old-value check still guards
  against concurrent movement. Merge landings must NEVER set this. A branch that IS
  checked out somewhere still refuses: only the owning checkout could express that move.
  */
  allowNonFastForward?: boolean;
}): Promise<
  | {
    advanced: true;
    previousSha: string;
    newSha: string;
    advanceMode: IntegrationRefAdvanceMode;
    worktreePath?: string;
  }
  | {
    advanced: false;
    reason: "concurrent-advance" | "ref-update-refused" | "missing-current-sha" | "non-fast-forward-advance";
    diagnostic: string;
    observedCurrentSha?: string;
  }
> {
  const {
    rootDir,
    integrationBranch,
    newSha,
    expectedCurrentSha,
    taskId,
    audit,
  } = args;

  if (!integrationBranch?.trim()) {
    throw new Error("advanceIntegrationBranchRef requires integrationBranch");
  }
  if (!newSha?.trim()) {
    throw new Error("advanceIntegrationBranchRef requires newSha");
  }
  if (!expectedCurrentSha?.trim()) {
    throw new Error("advanceIntegrationBranchRef requires expectedCurrentSha");
  }

  const ref = `refs/heads/${integrationBranch}`;
  const emitRefAdvance = async (input: {
    succeeded: boolean;
    error?: string;
    fromSha: string | null;
    toSha: string;
    advanceMode: IntegrationRefAdvanceMode | "not-attempted";
    worktreePath?: string;
  }): Promise<void> => {
    await audit.git({
      type: "merge:integration-ref-advance",
      target: integrationBranch,
      metadata: {
        taskId,
        integrationBranch,
        refName: ref,
        fromSha: input.fromSha,
        toSha: input.toSha,
        advanceMode: input.advanceMode,
        ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
        succeeded: input.succeeded,
        ...(input.error ? { error: input.error } : {}),
      },
    });
  };

  const refuse = async (message: string, advanceMode: IntegrationRefAdvanceMode | "not-attempted"): Promise<never> => {
    await emitRefAdvance({ succeeded: false, fromSha: expectedCurrentSha, toSha: newSha, advanceMode, error: message });
    throw new IntegrationLandingRefusedError(message);
  };

  let observedCurrentSha = "";
  try {
    const { stdout } = await testHooks.runGit(["rev-parse", "--verify", ref], rootDir);
    observedCurrentSha = stdout.trim();
  } catch (error: unknown) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    await emitRefAdvance({
      succeeded: false,
      fromSha: expectedCurrentSha || null,
      toSha: newSha,
      advanceMode: "not-attempted",
      error: `missing-current-sha: ${diagnostic}`,
    });
    return {
      advanced: false,
      reason: "missing-current-sha",
      diagnostic,
    };
  }

  if (!observedCurrentSha) {
    const diagnostic = `Missing current sha for ${ref}`;
    await emitRefAdvance({
      succeeded: false,
      fromSha: expectedCurrentSha || null,
      toSha: newSha,
      advanceMode: "not-attempted",
      error: `missing-current-sha: ${diagnostic}`,
    });
    return {
      advanced: false,
      reason: "missing-current-sha",
      diagnostic,
    };
  }

  if (observedCurrentSha !== expectedCurrentSha) {
    const diagnostic = `Expected ${expectedCurrentSha} but observed ${observedCurrentSha} for ${ref}`;
    await emitRefAdvance({
      succeeded: false,
      fromSha: expectedCurrentSha,
      toSha: newSha,
      advanceMode: "not-attempted",
      error: `concurrent-advance: ${diagnostic}`,
    });
    return {
      advanced: false,
      reason: "concurrent-advance",
      diagnostic,
      observedCurrentSha,
    };
  }

  // Fast-forward-only invariant: the new sha must descend from the current
  // tip. CAS alone (old-value match) lets a sibling commit overwrite the ref
  // and orphan the prior tip — the exact shape that left an FN-trailered
  // squash reachable only from a feature branch when a subsequent merger
  // built its squash off a stale base. Reject non-FF advances unless the
  // caller explicitly opted in (push-after-merge divergence rebase — see the
  // allowNonFastForward doc above).
  if (newSha !== expectedCurrentSha && args.allowNonFastForward !== true) {
    try {
      await testHooks.runGit(
        ["merge-base", "--is-ancestor", expectedCurrentSha, newSha],
        rootDir,
      );
    } catch (_error: unknown) {
      const diagnostic = `newSha ${newSha} is not a descendant of ${expectedCurrentSha} on ${ref}`;
      await emitRefAdvance({
        succeeded: false,
        fromSha: expectedCurrentSha,
        toSha: newSha,
        advanceMode: "not-attempted",
        error: `non-fast-forward-advance: ${diagnostic}`,
      });
      return {
        advanced: false,
        reason: "non-fast-forward-advance",
        diagnostic,
        observedCurrentSha,
      };
    }
  }

  const owner = await resolveLandingOwner({
    rootDir,
    integrationBranch,
    stage: `while landing ${taskId}`,
  });

  if (owner) {
    const worktreePath = owner.path;
    try {
      await assertOwnerIndexMatchesHead(worktreePath, `before the landing of ${taskId}`);
    } catch (error: unknown) {
      return refuse(
        `${describeRefusal(error)} — ${ref} stays at ${expectedCurrentSha}; this landing neither resets nor stashes that checkout.`,
        "merge-ff-only",
      );
    }

    try {
      await testHooks.runGit(["merge", "--ff-only", newSha], worktreePath, MERGE_TIMEOUT_MS);
    } catch (error: unknown) {
      return refuse(
        `landing refused: ${worktreePath} would not fast-forward ${integrationBranch} to ${newSha} — ${describeGitError(error)}. `
        + `${ref} stays at ${expectedCurrentSha}; nothing was reset, stashed or cleaned. `
        + `Commit or clean the local changes git named, then re-run the landing.`,
        "merge-ff-only",
      );
    }

    const { stdout: landedHead } = await testHooks.runGit(["rev-parse", "HEAD"], worktreePath);
    if (landedHead.trim() !== newSha || (await readIndexMismatch(worktreePath)) !== null) {
      return refuse(
        `landing refused: ${worktreePath} reports ${newSha} as landed but its HEAD, index and working tree did not move as one unit — `
        + `HEAD is ${landedHead.trim()}; the index must describe that commit's tree. `
        + `Investigate this checkout before the next landing; repair it with: git restore --source=HEAD --staged --worktree -- .`,
        "merge-ff-only",
      );
    }

    await emitRefAdvance({
      succeeded: true,
      fromSha: expectedCurrentSha,
      toSha: newSha,
      advanceMode: "merge-ff-only",
      worktreePath,
    });
    return { advanced: true, previousSha: expectedCurrentSha, newSha, advanceMode: "merge-ff-only", worktreePath };
  }

  /*
  FNXC:LandingReflog 2026-09-29 (STAS-292):
  The branch is checked out nowhere, so a CAS `update-ref` moves the whole
  truth. It carries a message naming the landing, because a message-less write
  is what made the trunk's reflog unreadable for forensics (STAS-233), and
  `--create-reflog` so the trail exists even for a branch that never had one.
  */
  const reflogMessage = `fusion landing: ${taskId} ${newSha}`;
  try {
    await testHooks.runGit(["update-ref", "--create-reflog", "-m", reflogMessage, ref, newSha, expectedCurrentSha], rootDir);
    await emitRefAdvance({
      succeeded: true,
      fromSha: expectedCurrentSha,
      toSha: newSha,
      advanceMode: "update-ref",
    });
    return { advanced: true, previousSha: expectedCurrentSha, newSha, advanceMode: "update-ref" };
  } catch (error: unknown) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    // FN-5627: Replace the fragile string heuristic ("is at" / "expected" /
    // "cannot lock ref") with structured detection. After an update-ref
    // failure, re-read the ref:
    //   * If the observed value moved away from expected   → genuine CAS race
    //     (concurrent-advance).
    //   * If the observed value still equals expected      → the ref did NOT
    //     advance and there was no race; update-ref was refused by lock
    //     contention, a pre/post-ref hook, packed-refs write contention, or
    //     a permissions/quota error. Classify as `ref-update-refused` so the
    //     downstream IntegrationBranchConcurrentAdvanceError does NOT fire
    //     with the misleading "expected X observed X" pair that previously
    //     routed legitimate ref-update failures into the unsafe "merge
    //     already confirmed" recovery path (FN-5625 / FN-5623 et al.).
    let postFailureCurrentSha: string | undefined;
    try {
      const { stdout: postStdout } = await testHooks.runGit(
        ["rev-parse", "--verify", ref],
        rootDir,
      );
      postFailureCurrentSha = postStdout.trim() || undefined;
    } catch {
      // Couldn't re-read; preserve original observed value for diagnostics
      postFailureCurrentSha = observedCurrentSha;
    }
    const effectiveObserved = postFailureCurrentSha || observedCurrentSha;
    const refMoved = !!effectiveObserved && effectiveObserved !== expectedCurrentSha;
    const reason = refMoved ? "concurrent-advance" : "ref-update-refused";
    await emitRefAdvance({
      succeeded: false,
      fromSha: effectiveObserved || expectedCurrentSha,
      toSha: newSha,
      advanceMode: "update-ref",
      error: `${reason}: ${diagnostic}`,
    });
    return {
      advanced: false,
      reason,
      diagnostic,
      observedCurrentSha: effectiveObserved,
    };
  }
}

export const __test__ = testHooks;
