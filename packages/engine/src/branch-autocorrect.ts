import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export type BranchAutocorrectParams = {
  worktreePath: string;
  observedBranch: string;
  expectedBranch: string;
  rootDir: string;
};

export type BranchAutocorrectResult = {
  status: "renamed" | "checked-out" | "failed";
  reason?: string;
};

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runGit(command: string, worktreePath: string): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const { stdout } = await execAsync(command, {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { ok: true, stdout };
  } catch (error) {
    const message =
      (error as { stderr?: string; message?: string }).stderr?.trim() ||
      (error instanceof Error ? error.message : String(error));
    return { ok: false, reason: message };
  }
}

/**
 * FN-4474: Recover wrong-branch invariant failures by renaming/checking out
 * the expected branch without throwing terminal executor errors.
 */
export async function attemptBranchAutocorrect({
  worktreePath,
  observedBranch,
  expectedBranch,
  rootDir: _rootDir,
}: BranchAutocorrectParams): Promise<BranchAutocorrectResult> {
  const observed = observedBranch.trim();
  const expected = expectedBranch.trim();
  if (!observed || !expected || observed === expected) {
    return { status: "failed", reason: "invalid-input" };
  }

  const observedArg = quoteShellArg(observed);
  const expectedArg = quoteShellArg(expected);
  const upstream = await runGit(`git rev-parse --abbrev-ref --symbolic-full-name ${observedArg}@{u}`, worktreePath);
  const observedShaResult = await runGit(`git rev-parse ${observedArg}`, worktreePath);

  let isFreshBranch = false;
  if (!upstream.ok && observedShaResult.ok) {
    const observedSha = observedShaResult.stdout.trim();
    if (/^[0-9a-f]{4,64}$/i.test(observedSha)) {
      const contains = await runGit(`git for-each-ref --format='%(refname:short)' --contains ${observedSha} refs/heads/`, worktreePath);
      if (contains.ok) {
        const refs = contains.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        isFreshBranch = refs.length === 1 && refs[0] === observed;
      }
    }
  }

  if (isFreshBranch) {
    const rename = await runGit(`git branch -m ${observedArg} ${expectedArg}`, worktreePath);
    if (rename.ok) {
      return { status: "renamed" };
    }
  }

  const checkout = await runGit(`git checkout -B ${expectedArg}`, worktreePath);
  if (checkout.ok) {
    return { status: "checked-out" };
  }

  return { status: "failed", reason: checkout.reason };
}
