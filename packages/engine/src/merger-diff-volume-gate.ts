import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";
import { GENERATED_PATTERNS, LOCKFILE_PATTERNS, matchGlob } from "./merger.js";

const execFileAsync = promisify(execFile);

export interface DiffVolumeRegressionFinding {
  file: string;
  branchNet: number;
  staged: number;
  ratio: number;
}

export class DiffVolumeRegressionError extends Error {
  override name = "DiffVolumeRegressionError";

  constructor(public readonly findings: DiffVolumeRegressionFinding[]) {
    super(buildMessage(findings));
  }
}

interface CheckDiffVolumeParams {
  rootDir: string;
  branch: string;
  integrationTargetSha: string;
  minLines: number;
  threshold: number;
  allowlistGlobs: readonly string[];
  taskId?: string;
}

function buildMessage(findings: readonly DiffVolumeRegressionFinding[]): string {
  const details = findings
    .map((finding) => `${finding.file} (branch_net=${finding.branchNet}, staged=${finding.staged}, ratio=${finding.ratio.toFixed(3)})`)
    .join(", ");
  return `Per-file diff-volume regression detected: ${details}`;
}

function parseNumstatTotal(output: string): number {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return 0;
  const [addedRaw, deletedRaw] = line.split("\t");
  if (!addedRaw || !deletedRaw) return 0;
  if (addedRaw === "-" || deletedRaw === "-") return 0;
  const added = Number.parseInt(addedRaw, 10);
  const deleted = Number.parseInt(deletedRaw, 10);
  return (Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0);
}

function isAllowlisted(file: string, allowlistGlobs: readonly string[]): boolean {
  return [...LOCKFILE_PATTERNS, ...GENERATED_PATTERNS, ...allowlistGlobs].some((pattern) => matchGlob(file, pattern));
}

async function execGit(rootDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: rootDir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function checkDiffVolume({
  rootDir,
  branch,
  integrationTargetSha,
  minLines,
  threshold,
  allowlistGlobs,
}: CheckDiffVolumeParams): Promise<void> {
  const base = (await execGit(rootDir, ["merge-base", integrationTargetSha, branch])).trim();
  const touchedFilesOutput = await execGit(rootDir, ["diff", "--name-only", `${base}...${branch}`]);
  const touchedFiles = touchedFilesOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const findings: DiffVolumeRegressionFinding[] = [];

  for (const file of touchedFiles) {
    if (isAllowlisted(file, allowlistGlobs)) continue;

    const branchNet = parseNumstatTotal(
      await execGit(rootDir, ["diff", "--numstat", `${base}...${branch}`, "--", file]),
    );
    if (branchNet <= minLines) continue;

    const staged = parseNumstatTotal(
      await execGit(rootDir, ["diff", "--cached", "--numstat", "--", file]),
    );
    const ratio = branchNet === 0 ? 1 : staged / branchNet;
    if (ratio < threshold) {
      findings.push({ file, branchNet, staged, ratio });
    }
  }

  if (findings.length > 0) {
    throw new DiffVolumeRegressionError(findings);
  }
}

export interface DiffVolumeGateSettings {
  minLines: number;
  threshold: number;
  allowlistGlobs: string[];
}

/*
 * FNXC:CodeOrganization 2026-07-17-12:00:
 * Diff-volume settings normalization and finding formatting peeled from merger.ts.
 */
export function resolveDiffVolumeGateSettings(settings?: Settings): DiffVolumeGateSettings {
  const minLinesRaw = settings?.mergeDiffVolumeMinLines ?? 20;
  const thresholdRaw = settings?.mergeDiffVolumeThreshold ?? 0.2;
  return {
    minLines: Math.max(1, Math.trunc(Number.isFinite(minLinesRaw) ? minLinesRaw : 20)),
    threshold: Math.min(1, Math.max(0, Number.isFinite(thresholdRaw) ? thresholdRaw : 0.2)),
    allowlistGlobs: Array.isArray(settings?.mergeDiffVolumeAllowlist)
      ? settings.mergeDiffVolumeAllowlist.filter((glob): glob is string => typeof glob === "string" && glob.trim().length > 0)
      : [],
  };
}

export function formatDiffVolumeFindings(findings: ReadonlyArray<{ file: string; branchNet: number; staged: number; ratio: number }>): string {
  return findings
    .map((finding) => `${finding.file} (branchNet=${finding.branchNet}, staged=${finding.staged}, ratio=${finding.ratio.toFixed(3)})`)
    .join("\n");
}

