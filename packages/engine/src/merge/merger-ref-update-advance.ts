import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunAuditor } from "../util/run-audit.js";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
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

export async function advanceIntegrationBranchRef(args: {
  rootDir: string;
  projectRootDir: string;
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
  against concurrent movement. Merge landings must NEVER set this.
  */
  allowNonFastForward?: boolean;
}): Promise<
  | { advanced: true; previousSha: string; newSha: string }
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
        advanceMode: "update-ref",
        succeeded: input.succeeded,
        ...(input.error ? { error: input.error } : {}),
      },
    });
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

  try {
    await testHooks.runGit(["update-ref", ref, newSha, expectedCurrentSha], rootDir);
    await emitRefAdvance({
      succeeded: true,
      fromSha: expectedCurrentSha,
      toSha: newSha,
    });
    return { advanced: true, previousSha: expectedCurrentSha, newSha };
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
