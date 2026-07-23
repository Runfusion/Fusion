// Branch-name resolution: callers must pass the resolved integration branch via Step 3 plumbing; never hardcode "main". See FN-5349.
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectSettings } from "@fusion/core";

const execAsync = promisify(exec);

export interface AutoPrerebaseDecision {
  fire: boolean;
  reason: "disabled" | "no-base" | "no-divergence" | "worktrunk-deferred" | "hot-file" | "divergence-threshold" | "safety-fallback-any-divergence";
  commitsBehind: number;
  hotMatches: string[];
}

export async function probeDivergence(opts: {
  rootDir: string;
  baseCommitSha: string;
  mainRef?: string;
}): Promise<{ commitsBehind: number; changedFiles: string[] }> {
  const mainRef = opts.mainRef ?? "HEAD";
  const range = `${opts.baseCommitSha}..${mainRef}`;
  const [{ stdout: countOut }, { stdout: diffOut }] = await Promise.all([
    execAsync(`git rev-list --count ${range}`, {
      cwd: opts.rootDir,
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    }),
    execAsync(`git diff --name-only ${range}`, {
      cwd: opts.rootDir,
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    }),
  ]);

  const commitsBehind = Number.parseInt(countOut.trim() || "0", 10);
  const changedFiles = diffOut
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  return {
    commitsBehind: Number.isFinite(commitsBehind) ? commitsBehind : 0,
    changedFiles,
  };
}

export function decideAutoPrerebase(input: {
  settings: Pick<ProjectSettings, "prerebaseAutoEnabled" | "prerebaseHotFiles" | "prerebaseDivergenceThreshold">;
  baseCommitSha: string | null | undefined;
  commitsBehind: number;
  changedFiles: string[];
  worktrunkEnabled: boolean;
}): AutoPrerebaseDecision {
  const commitsBehind = Math.max(0, input.commitsBehind || 0);
  if (input.worktrunkEnabled) {
    return { fire: false, reason: "worktrunk-deferred", commitsBehind, hotMatches: [] };
  }
  if (input.settings.prerebaseAutoEnabled === false) {
    return { fire: false, reason: "disabled", commitsBehind, hotMatches: [] };
  }
  if (!input.baseCommitSha) {
    return { fire: false, reason: "no-base", commitsBehind, hotMatches: [] };
  }

  const hotFiles = input.settings.prerebaseHotFiles ?? [];
  const hotSet = new Set(hotFiles);
  const hotMatches = input.changedFiles.filter((path) => hotSet.has(path));
  if (hotMatches.length > 0) {
    return { fire: true, reason: "hot-file", commitsBehind, hotMatches };
  }

  // FN-5627 follow-up: default divergence threshold flipped from 0 ("never
  // fire on commit-count") to 1 ("fire when branch is behind by at least 1
  // commit"). Users who want the legacy never-fire behavior can explicitly
  // set `prerebaseDivergenceThreshold = 0`. Threshold remains user-tunable
  // for the user-visible severity label ("divergence-threshold" reason).
  const threshold = input.settings.prerebaseDivergenceThreshold ?? 1;
  if (threshold > 0 && commitsBehind >= threshold) {
    return { fire: true, reason: "divergence-threshold", commitsBehind, hotMatches: [] };
  }

  // FN-5627 safety invariant: even when the user-configurable threshold
  // hasn't tripped (e.g., user explicitly set threshold=50 for low-noise
  // PR experience), ANY branch behind main MUST be rebased before squash.
  // Otherwise the squash commit doesn't descend from current main, and
  // `git update-ref refs/heads/<integration> <new> <old>` will refuse the
  // non-fast-forward advance — the merger surfaces
  // `IntegrationBranchConcurrentAdvanceError` with a misleading same-SHA
  // pair (because `observedCurrentSha` was captured from the pre-update
  // rev-parse, not post-failure), and the task is stranded at
  // `mergeRetries=3`. This safety fallback is the engine-correctness path;
  // the threshold above is for user-visible severity reporting only.
  //
  // The only way to opt out of the safety fallback is
  // `prerebaseAutoEnabled = false`, which already short-circuits much earlier
  // and means the user has accepted that behind-branch merges will fail.
  if (commitsBehind > 0) {
    return { fire: true, reason: "safety-fallback-any-divergence", commitsBehind, hotMatches: [] };
  }

  return { fire: false, reason: "no-divergence", commitsBehind, hotMatches: [] };
}

export async function runAutoPrerebase(deps: {
  rootDir: string;
  worktreePath: string;
  branch: string;
  taskId: string;
  mainHead?: string;
  logger: { log: (m: string) => void; warn: (m: string) => void };
}): Promise<{ ok: boolean; mainHead: string; error?: string }> {
  const mainHead = deps.mainHead?.trim() || (await execAsync("git rev-parse HEAD", {
    cwd: deps.rootDir,
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  })).stdout.trim();

  try {
    await execAsync(`git rebase "${mainHead}"`, {
      cwd: deps.worktreePath,
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    deps.logger.log(`${deps.taskId}: auto-prerebase succeeded (${deps.branch} -> ${mainHead.slice(0, 8)})`);
    return { ok: true, mainHead };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`${deps.taskId}: auto-prerebase failed (${message}) — aborting`);
    try {
      await execAsync("git rebase --abort", {
        cwd: deps.worktreePath,
        encoding: "utf-8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (abortError: unknown) {
      deps.logger.warn(`${deps.taskId}: auto-prerebase abort failed (${abortError instanceof Error ? abortError.message : String(abortError)})`);
    }
    return { ok: false, mainHead, error: message };
  }
}
