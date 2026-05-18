import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectSettings } from "@fusion/core";

const execAsync = promisify(exec);

export interface AutoPrerebaseDecision {
  fire: boolean;
  reason: "disabled" | "no-base" | "no-divergence" | "worktrunk-deferred" | "hot-file" | "divergence-threshold";
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

  const threshold = input.settings.prerebaseDivergenceThreshold ?? 0;
  if (threshold > 0 && commitsBehind > threshold) {
    return { fire: true, reason: "divergence-threshold", commitsBehind, hotMatches: [] };
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
