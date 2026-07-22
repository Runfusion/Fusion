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
 *
 * FN-5456 invariant: this function MUST NOT create a branch from arbitrary
 * HEAD. It may only rename an existing branch or switch to an already-existing
 * expected ref; if neither applies it returns `failed` so upstream recovery
 * (which knows the proper base SHA) can re-anchor via `prepareForTask` /
 * `reanchorBranchToBase`.
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

  let isFreshBranch = false;
  if (!upstream.ok) {
    const observedShaResult = await runGit(`git rev-parse ${observedArg}`, worktreePath);
    if (observedShaResult.ok) {
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
  }

  if (isFreshBranch) {
    // `-M` (force) lets us recover from case-only renames on case-insensitive
    // filesystems (macOS, default Windows) where `-m` rejects `foo` → `Foo`.
    const rename = await runGit(`git branch -M ${observedArg} ${expectedArg}`, worktreePath);
    if (rename.ok) {
      return { status: "renamed" };
    }
  }

  // FN-5456: must NOT use `git checkout -B` with no start point — that would
  // create (or reset) the expected branch at whatever HEAD currently is,
  // capturing the previous occupant's tip (the "branch: Created from HEAD"
  // contamination pattern). Restrict the verify to refs/heads/ so a stray tag
  // or remote ref with the same name cannot satisfy the check and lead the
  // subsequent `git checkout` to a detached HEAD on the wrong object.
  const expectedRefArg = quoteShellArg(`refs/heads/${expected}`);
  const verifyExpected = await runGit(
    `git show-ref --verify --quiet ${expectedRefArg}`,
    worktreePath,
  );
  if (!verifyExpected.ok) {
    return { status: "failed", reason: `expected branch ${expected} does not exist` };
  }
  // `--` disambiguates against a same-named tracked path; we already proved
  // the ref exists, so this can only resolve as the branch.
  const checkout = await runGit(`git checkout ${expectedArg} --`, worktreePath);
  if (checkout.ok) {
    return { status: "checked-out" };
  }

  return { status: "failed", reason: checkout.reason };
}
