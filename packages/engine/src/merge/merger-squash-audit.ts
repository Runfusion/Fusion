import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MERGER_MAIN_OVERLAP_LOOKBACK_COMMITS = 30;
const GIT_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;

export interface SquashAuditRecentMainCommit {
  sha: string;
  subject: string;
}

export interface SquashAuditDuplicateSubjectFinding {
  type: "duplicate-subject";
  subject: string;
}

export interface SquashAuditTouchedFileOverlapFinding {
  type: "touched-file-overlap";
  file: string;
  recentMainCommits: SquashAuditRecentMainCommit[];
}

export type SquashAuditFinding = SquashAuditDuplicateSubjectFinding | SquashAuditTouchedFileOverlapFinding;

export type PostMergeAuditStrategy = "squash" | "rebase";

interface PostMergeAuditBaseInput {
  rootDir: string;
  lookback?: number;
}

export interface PostSquashAuditInput extends PostMergeAuditBaseInput {
  strategy?: "squash";
  squashSha: string;
}

export interface PostRebaseAuditInput extends PostMergeAuditBaseInput {
  strategy: "rebase";
  rangeBaseSha: string;
  rangeHeadSha: string;
}

export type PostMergeAuditInput = PostSquashAuditInput | PostRebaseAuditInput;

export interface SquashAuditFindings {
  strategy: PostMergeAuditStrategy;
  squashSha?: string;
  rangeBaseSha?: string;
  rangeHeadSha?: string;
  parentSha: string;
  squashSubject?: string;
  auditTargetLabel: string;
  lookback: number;
  branchSubjects: string[];
  recentMainSubjects: string[];
  duplicateSubjects: SquashAuditDuplicateSubjectFinding[];
  touchedFiles: string[];
  touchedFileOverlaps: SquashAuditTouchedFileOverlapFinding[];
  findings: SquashAuditFinding[];
  issueCount: number;
  clean: boolean;
}

/**
 * Strategy-aware post-merge audit.
 *
 * - squash: audit the synthetic squash commit and compare its branch-subject list
 *   against recent pre-squash main history.
 * - rebase: audit the landed commit range base..head and compare those preserved
 *   commit subjects/files against recent pre-merge main history.
 */
export async function auditSquashMerge(input: PostMergeAuditInput): Promise<SquashAuditFindings> {
  const normalizedLookback = normalizeMergeOverlapLookback(input.lookback);

  if (input.strategy === "rebase") {
    const parentSha = input.rangeBaseSha;
    const auditTargetLabel = `${input.rangeBaseSha.slice(0, 8)}..${input.rangeHeadSha.slice(0, 8)}`;
    const branchSubjects = normalizeLines(
      await git(input.rootDir, ["log", "--format=%s", `${input.rangeBaseSha}..${input.rangeHeadSha}`]),
    );
    const recentMainCommits = await listRecentMainCommits(input.rootDir, parentSha, normalizedLookback);
    const recentMainSubjects = recentMainCommits.map((entry) => entry.subject);
    const duplicateSubjects = branchSubjects
      .filter((subject) => recentMainSubjects.includes(subject))
      .map((subject) => ({ type: "duplicate-subject", subject }) satisfies SquashAuditDuplicateSubjectFinding);
    const touchedFiles = normalizeLines(await git(input.rootDir, ["diff", "--name-only", input.rangeBaseSha, input.rangeHeadSha]));
    const touchedFileOverlaps = await collectTouchedFileOverlaps(input.rootDir, touchedFiles, recentMainCommits);
    const findings: SquashAuditFinding[] = [...duplicateSubjects, ...touchedFileOverlaps];

    return {
      strategy: "rebase",
      rangeBaseSha: input.rangeBaseSha,
      rangeHeadSha: input.rangeHeadSha,
      parentSha,
      auditTargetLabel,
      lookback: normalizedLookback,
      branchSubjects,
      recentMainSubjects,
      duplicateSubjects,
      touchedFiles,
      touchedFileOverlaps,
      findings,
      issueCount: findings.length,
      clean: findings.length === 0,
    };
  }

  const squashSha = input.squashSha;
  const parentSha = await git(input.rootDir, ["rev-parse", `${squashSha}^`]);
  const squashSubject = await git(input.rootDir, ["log", "-1", "--format=%s", squashSha]);
  const branchSubjects = normalizeLines(await git(input.rootDir, ["log", "-1", "--format=%b", squashSha]))
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);

  const recentMainCommits = await listRecentMainCommits(input.rootDir, parentSha, normalizedLookback);
  const recentMainSubjects = recentMainCommits.map((entry) => entry.subject);

  const duplicateSubjects = branchSubjects
    .filter((subject) => recentMainSubjects.includes(subject))
    .map((subject) => ({ type: "duplicate-subject", subject }) satisfies SquashAuditDuplicateSubjectFinding);

  const touchedFiles = normalizeLines(await git(input.rootDir, ["diff", "--name-only", parentSha, squashSha]));
  const touchedFileOverlaps = await collectTouchedFileOverlaps(input.rootDir, touchedFiles, recentMainCommits);
  const findings: SquashAuditFinding[] = [...duplicateSubjects, ...touchedFileOverlaps];

  return {
    strategy: "squash",
    squashSha,
    parentSha,
    squashSubject,
    auditTargetLabel: squashSha,
    lookback: normalizedLookback,
    branchSubjects,
    recentMainSubjects,
    duplicateSubjects,
    touchedFiles,
    touchedFileOverlaps,
    findings,
    issueCount: findings.length,
    clean: findings.length === 0,
  };
}

export function formatSquashAuditReport(findings: SquashAuditFindings): string {
  const heading = findings.strategy === "rebase"
    ? `Auditing landed range: ${findings.auditTargetLabel}`
    : `Auditing squash: ${findings.squashSha} — ${findings.squashSubject}`;
  const parentLabel = findings.strategy === "rebase"
    ? `Base (main before preserved-commit landing): ${findings.parentSha}`
    : `Parent (main before squash): ${findings.parentSha}`;
  const lines: string[] = [heading, parentLabel, `Lookback window on main: ${findings.lookback} commits`, "", "=== Duplicate-cherry-pick risk ==="];

  if (findings.duplicateSubjects.length === 0) {
    lines.push("(none — no branch commit subjects match recent main commits)", "");
  } else {
    lines.push(
      "WARN: branch contains commits whose subjects match recent main commits.",
      "Auto-resolve may have picked the older side, dropping refinements.",
      "Action: diff each main commit below against HEAD and confirm its",
      "net contribution survived. Restore anything dropped as a follow-up.",
      "",
      ...findings.duplicateSubjects.map((entry) => `  - ${entry.subject}`),
      "",
    );
  }

  lines.push(`=== Touched-file overlap (${findings.touchedFiles.length} files in ${findings.strategy === "rebase" ? "landed range" : "squash"}) ===`);
  if (findings.touchedFileOverlaps.length === 0) {
    lines.push("(none — merged result touches files no recent main commit touched)", "");
  } else {
    lines.push(
      "Files the merged result touched that also have recent main activity.",
      "Action: for each commit below, verify its changes still appear",
      "in HEAD. Reapply any silently dropped changes on the same branch.",
      "",
    );
    for (const overlap of findings.touchedFileOverlaps) {
      lines.push(`  ${overlap.file}`);
      for (const commit of overlap.recentMainCommits) {
        lines.push(`    - ${commit.sha}  ${commit.subject}`);
      }
    }
    lines.push("");
  }

  lines.push(`Audit complete. ${findings.issueCount} item(s) for the calling agent to review.`);
  return lines.join("\n");
}

async function collectTouchedFileOverlaps(
  rootDir: string,
  touchedFiles: string[],
  recentMainCommits: Array<{ sha: string; shortSha: string; subject: string }>,
): Promise<SquashAuditTouchedFileOverlapFinding[]> {
  const touchedFileOverlaps: SquashAuditTouchedFileOverlapFinding[] = [];

  for (const file of touchedFiles) {
    const overlappingCommits: SquashAuditRecentMainCommit[] = [];
    for (const commit of recentMainCommits) {
      const touchedInCommit = await git(rootDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit.sha, "--", file]);
      if (normalizeLines(touchedInCommit).includes(file)) {
        overlappingCommits.push({ sha: commit.shortSha, subject: commit.subject });
      }
    }

    if (overlappingCommits.length > 0) {
      touchedFileOverlaps.push({
        type: "touched-file-overlap",
        file,
        recentMainCommits: overlappingCommits,
      });
    }
  }

  return touchedFileOverlaps;
}

async function git(rootDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: rootDir,
    encoding: "utf-8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  return stdout.trim();
}

function normalizeLines(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function listRecentMainCommits(rootDir: string, parentSha: string, lookback: number): Promise<Array<{ sha: string; shortSha: string; subject: string }>> {
  const entries = normalizeLines(await git(rootDir, ["log", `--format=%H~%h~%s`, `-n`, String(lookback), parentSha]));
  return entries
    .map((entry) => {
      const [sha, shortSha, ...subjectParts] = entry.split("~");
      const subject = subjectParts.join("~").trim();
      if (!sha?.trim() || !shortSha?.trim() || !subject) {
        return null;
      }
      return {
        sha: sha.trim(),
        shortSha: shortSha.trim(),
        subject,
      };
    })
    .filter((entry): entry is { sha: string; shortSha: string; subject: string } => entry !== null);
}

export function normalizeMergeOverlapLookback(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return MERGER_MAIN_OVERLAP_LOOKBACK_COMMITS;
  }
  return Math.trunc(value);
}
