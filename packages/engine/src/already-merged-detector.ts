import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type AlreadyMergedDetectionStrategy = "trailer" | "ancestry" | "patch-id" | "tree-equal";

export interface AlreadyMergedLookupInput {
  taskId: string;
  lineageId?: string;
  repoDir: string;
  baseBranch: string;
  taskBranch?: string;
  baseCommitSha?: string;
}

export interface AlreadyMergedLookupResult {
  sha: string;
  strategy: AlreadyMergedDetectionStrategy;
}

interface DetectAlreadyLandedInput {
  rootDir: string;
  taskId: string;
  lineageId?: string;
  baseBranch: string;
  taskBranch?: string;
  baseCommitSha?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function findAlreadyMergedTaskCommit(
  input: AlreadyMergedLookupInput,
): Promise<AlreadyMergedLookupResult | null> {
  const { taskId, lineageId, repoDir, baseBranch, taskBranch, baseCommitSha } = input;

  try {
    if (lineageId) {
      const lineagePattern = `^Fusion-Task-Lineage: ${lineageId}$`;
      const lineageCommand = [
        "git log",
        `--grep=${shellQuote(lineagePattern)}`,
        "-E",
        "--max-count=1",
        "--format=%H",
        shellQuote(baseBranch),
      ].join(" ");
      const lineage = await execAsync(lineageCommand, {
        cwd: repoDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const lineageSha = lineage.stdout.trim();
      if (lineageSha) {
        return { sha: lineageSha, strategy: "trailer" };
      }
    }

    const trailerPattern = `^Fusion-Task-Id: ${taskId}$`;
    const trailerCommand = [
      "git log",
      `--grep=${shellQuote(trailerPattern)}`,
      "-E",
      "--max-count=1",
      "--format=%H",
      shellQuote(baseBranch),
    ].join(" ");
    const { stdout } = await execAsync(trailerCommand, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const sha = stdout.trim();
    if (sha) {
      return { sha, strategy: "trailer" };
    }
  } catch {
    // Fall through to ancestry/patch-id checks.
  }

  let branchTip: string | null = null;
  const branchName = taskBranch || `fusion/${taskId.toLowerCase()}`;
  try {
    branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    execSync(`git merge-base --is-ancestor ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`, {
      cwd: repoDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const ancestryCommand = [
      "git log",
      "--first-parent",
      "--format=%H",
      `--grep=${shellQuote(taskId)}`,
      "--max-count=1",
      shellQuote(baseBranch),
    ].join(" ");
    const { stdout } = await execAsync(ancestryCommand, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const sha = stdout.trim();
    if (sha) {
      return { sha, strategy: "ancestry" };
    }
  } catch {
    // Fall through to patch-id checks.
  }

  try {
    if (!branchTip) {
      branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    }

    let branchBase = baseCommitSha?.trim();
    if (!branchBase) {
      const { stdout: mergeBaseStdout } = await execAsync(
        `git merge-base ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`,
        {
          cwd: repoDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      branchBase = mergeBaseStdout.trim();
    }

    if (!branchBase) {
      return null;
    }

    const branchPatchIdCommand = `git diff ${shellQuote(branchBase)}..${shellQuote(branchTip)} | git patch-id`;
    const { stdout: branchPatchIdOut } = await execAsync(branchPatchIdCommand, {
      cwd: repoDir,
      shell: "/bin/sh",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const branchPatchIdLine = branchPatchIdOut
      .trim()
      .split("\n")
      .find((line) => line.trim().length > 0);
    const branchPatchId = branchPatchIdLine?.trim().split(/\s+/)[0];
    if (!branchPatchId) {
      return null;
    }

    const basePatchMapCommand = `git log -n 200 -p --format='%H' ${shellQuote(baseBranch)} | git patch-id`;
    const { stdout: basePatchIdsOut } = await execAsync(basePatchMapCommand, {
      cwd: repoDir,
      shell: "/bin/sh",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });

    const basePatchMap = new Map<string, string>();
    for (const line of basePatchIdsOut.split("\n")) {
      const [patchId, sha] = line.trim().split(/\s+/);
      if (!patchId || !sha) continue;
      basePatchMap.set(patchId, sha);
    }

    const matchedSha = basePatchMap.get(branchPatchId);
    if (matchedSha) {
      return { sha: matchedSha, strategy: "patch-id" };
    }
  } catch {
    // Fall through to null when patch-id detection fails.
  }

  try {
    const treeBranchName = taskBranch || `fusion/${taskId.toLowerCase()}`;
    execSync(`git rev-parse --verify ${shellQuote(treeBranchName)}`, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const { stdout: baseTreeStdout } = await execAsync(`git rev-parse ${shellQuote(baseBranch)}^{tree}`, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const { stdout: branchTreeStdout } = await execAsync(`git rev-parse ${shellQuote(treeBranchName)}^{tree}`, {
      cwd: repoDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    const baseTree = baseTreeStdout.trim();
    const branchTree = branchTreeStdout.trim();
    if (baseTree && branchTree && baseTree === branchTree) {
      const { stdout: baseHeadStdout } = await execAsync(`git rev-parse ${shellQuote(baseBranch)}`, {
        cwd: repoDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const baseHead = baseHeadStdout.trim();
      if (baseHead) {
        return { sha: baseHead, strategy: "tree-equal" };
      }
    }
  } catch {
    // Fall through to null when tree-equality detection fails.
  }

  return null;
}

export async function detectAlreadyLandedOnMain(
  input: DetectAlreadyLandedInput,
): Promise<AlreadyMergedLookupResult | null> {
  return findAlreadyMergedTaskCommit({
    taskId: input.taskId,
    lineageId: input.lineageId,
    repoDir: input.rootDir,
    baseBranch: input.baseBranch,
    taskBranch: input.taskBranch,
    baseCommitSha: input.baseCommitSha,
  });
}
