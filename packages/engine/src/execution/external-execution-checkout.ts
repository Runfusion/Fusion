import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExternalGitCheckoutInspection {
  valid: boolean;
  checkoutPath?: string;
  branch?: string;
  reason?: string;
}

export type ExternalExecutionCheckoutResolution =
  | { configured: false }
  | ({ configured: true } & ExternalGitCheckoutInspection);

function readSourceMetadata(task: unknown): Record<string, unknown> | undefined {
  if (!task || typeof task !== "object") return undefined;
  const sourceMetadata = (task as Record<string, unknown>).sourceMetadata;
  return sourceMetadata && typeof sourceMetadata === "object"
    ? sourceMetadata as Record<string, unknown>
    : undefined;
}

export async function inspectExternalGitCheckout(
  candidate: unknown,
  options: { requireClean?: boolean } = {},
): Promise<ExternalGitCheckoutInspection> {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return { valid: false, reason: "checkoutPath must be a non-empty string" };
  }
  const checkoutPath = candidate.trim();
  if (!isAbsolute(checkoutPath)) {
    return { valid: false, reason: "checkoutPath must be absolute" };
  }

  try {
    if (!existsSync(checkoutPath) || !statSync(checkoutPath).isDirectory()) {
      return { valid: false, reason: `checkoutPath is not a directory: ${checkoutPath}` };
    }
    const canonicalCheckout = realpathSync(checkoutPath);
    const { stdout: topLevelOutput } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: canonicalCheckout,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const topLevel = topLevelOutput.trim();
    const canonicalTopLevel = realpathSync(topLevel);
    if (canonicalTopLevel !== canonicalCheckout) {
      return {
        valid: false,
        reason: `checkoutPath must be the Git top-level (observed ${canonicalTopLevel})`,
      };
    }
    const { stdout: branchOutput } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: canonicalCheckout,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const branch = branchOutput.trim();
    if (!branch) {
      return { valid: false, reason: "checkoutPath must have a checked-out branch" };
    }
    if (options.requireClean) {
      const { stdout: statusOutput } = await execFileAsync("git", ["status", "--porcelain=v1"], {
        cwd: canonicalCheckout,
        encoding: "utf-8",
        timeout: 10_000,
      });
      const status = statusOutput.trim();
      if (status.length > 0) {
        return { valid: false, reason: "checkoutPath must be clean before routing" };
      }
    }
    return { valid: true, checkoutPath: canonicalCheckout, branch };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * FNXC:ExternalTaskCheckoutRouting 2026-08-09-22:43:
 * Resolve only a persisted, absolute Git top-level whose checked-out branch still matches the branch captured when the operator configured the route. A missing or null route preserves normal Fusion-managed worktree behavior; malformed or drifted persisted routes fail closed.
 */
export async function resolveExternalExecutionCheckoutRoute(task: unknown): Promise<ExternalExecutionCheckoutResolution> {
  const sourceMetadata = readSourceMetadata(task);
  if (!sourceMetadata || !Object.prototype.hasOwnProperty.call(sourceMetadata, "externalExecutionCheckout")) {
    return { configured: false };
  }
  if (sourceMetadata.externalExecutionCheckout == null) {
    return { configured: false };
  }

  const inspection = await inspectExternalGitCheckout(sourceMetadata.externalExecutionCheckout);
  if (!inspection.valid) {
    return { configured: true, ...inspection };
  }

  const expectedBranch = sourceMetadata.externalExecutionBranch;
  if (typeof expectedBranch !== "string" || expectedBranch.trim().length === 0) {
    return {
      configured: true,
      valid: false,
      reason: "sourceMetadata.externalExecutionBranch must be persisted with the checkout route",
    };
  }
  const normalizedExpectedBranch = expectedBranch.trim();
  if (inspection.branch !== normalizedExpectedBranch) {
    return {
      configured: true,
      valid: false,
      reason: `external execution checkout branch mismatch: observed ${inspection.branch}, expected ${normalizedExpectedBranch}`,
    };
  }

  return { configured: true, ...inspection };
}
