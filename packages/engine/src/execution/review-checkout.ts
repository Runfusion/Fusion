import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

function readMetadataPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  /*
  FNXC:ReviewRouting 2026-07-01-16:36:
  External review routing must be explicit metadata, not inferred from prompt text or task descriptions. The resolver only accepts known metadata fields, treats blank/non-string values as absent, and later validates that the chosen path is an absolute git checkout. Source priority is fixed (customFields > branchContext > sourceMetadata > root); an invalid higher-priority candidate fails closed to the task worktree rather than silently falling through to a lower-priority path.
  */
  for (const direct of [record.reviewCheckoutPath, record.externalReviewCheckoutPath, record.externalReviewCheckout]) {
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }
  const nested = record.reviewCheckout;
  if (nested && typeof nested === "object") {
    const path = (nested as Record<string, unknown>).path;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return undefined;
}

export function getTaskReviewCheckoutPath(task: unknown): string | undefined {
  if (!task || typeof task !== "object") return undefined;
  const record = task as Record<string, unknown>;
  return readMetadataPath(record.customFields) ?? readMetadataPath(record.branchContext) ?? readMetadataPath(record.sourceMetadata) ?? readMetadataPath(record);
}

export function resolveReviewCheckoutCwd(task: unknown, fallbackCwd: string): string {
  const candidate = getTaskReviewCheckoutPath(task);
  if (!candidate || !isAbsolute(candidate)) return fallbackCwd;
  try {
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return fallbackCwd;
    const realCandidate = realpathSync(candidate);
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: realCandidate,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!topLevel) return fallbackCwd;
    return realpathSync(topLevel);
  } catch {
    return fallbackCwd;
  }
}
