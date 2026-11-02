/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-20:20 (RUFU-451):
The tri-state branch-presence read, extracted to a leaf so BOTH lanes that must ask "does this branch
exist in this repository" ask it the same way.

Why a leaf module instead of importing `SelfHealingManager.probeRepoBranch`: the self-healing git substrate
already imports `./merge/already-merged-detector.js`, so a `merge/` → substrate import would hand the merge
lane a new edge into the recovery substrate (the same reason `empty-land-evidence.ts` parses shortstat
locally). The classification is pure and cycle-free, so the correct move is to move the DECISION down into
a leaf both sides import, leaving `probeRepoBranch` as the substrate-side wrapper over its own injectable
`execBranchProbe` seam. Existing importers of `classifyBranchProbeError` keep resolving through
`self-healing-git-evidence.js`, which re-exports this module's function rather than copying it.

The read is `show-ref --verify --quiet`, deliberately not `rev-parse --verify`: `rev-parse` returns 128 for
BOTH "no such ref" and "not a repository", and a lane that cannot read a repository must never be handed
absence as if it were a fact. `unknown` is the answer that keeps every refusal standing.
*/
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { createLogger } from "../logger.js";

const log = createLogger("branch-presence-probe");
const execAsync = promisify(exec);

/** The one `show-ref` invocation that answers branch-presence questions. No second copy may exist. */
export async function execBranchProbeCommand(repoRootDir: string, branch: string): Promise<void> {
  await execAsync(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`, {
    cwd: repoRootDir,
    timeout: 30_000,
  });
}

/**
 * Maps a failed `show-ref` to evidence: a clean exit-1 (no signal, not killed) is ABSENCE PROOF; anything
 * else — 128, a timeout, a spawn failure — is UNKNOWN and may never be read as absence.
 */
export function classifyBranchProbeError(error: unknown): "absent" | "unknown" {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 1 &&
    !(error as { killed?: unknown }).killed &&
    ((error as { signal?: unknown }).signal === null || (error as { signal?: unknown }).signal === undefined)
  ) {
    return "absent";
  }
  return "unknown";
}

/**
 * The three answers every consuming rule is written against: `present` (a ref exists), `absent` (git
 * answered "no such ref"), `unknown` (git could not be asked). `exec` stays injectable because the
 * self-healing subclass seam overrides the COMMAND, not the classification.
 */
export async function probeBranchPresence(
  repoRootDir: string,
  branch: string,
  exec: (repoRootDir: string, branch: string) => Promise<void> = execBranchProbeCommand,
): Promise<"present" | "absent" | "unknown"> {
  try {
    await exec(repoRootDir, branch);
    return "present";
  } catch (error) {
    const outcome = classifyBranchProbeError(error);
    if (outcome === "unknown") {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn(`[self-healing] branch evidence unavailable for ${repoRootDir} (${branch}): ${errorMessage}`);
    }
    return outcome;
  }
}

/** POSIX single-quote escaping, kept local so this module imports nothing from the recovery substrate. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
