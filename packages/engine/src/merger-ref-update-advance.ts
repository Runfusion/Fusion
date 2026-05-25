import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunAuditor } from "./run-audit.js";

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
  // built its squash off a stale base. Reject non-FF advances.
  if (newSha !== expectedCurrentSha) {
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
    const lower = diagnostic.toLowerCase();
    const isConcurrent = lower.includes("cannot lock ref") || lower.includes("is at") || lower.includes("expected");
    const reason = isConcurrent ? "concurrent-advance" : "ref-update-refused";
    await emitRefAdvance({
      succeeded: false,
      fromSha: observedCurrentSha || expectedCurrentSha,
      toSha: newSha,
      error: `${reason}: ${diagnostic}`,
    });
    return {
      advanced: false,
      reason,
      diagnostic,
      observedCurrentSha,
    };
  }
}

export const __test__ = testHooks;
