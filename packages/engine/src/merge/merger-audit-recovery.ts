import { exec } from "node:child_process";
import { promisify } from "node:util";

import type {
  SquashAuditDuplicateSubjectFinding,
  SquashAuditTouchedFileOverlapFinding,
} from "./merger-squash-audit.js";
import type { Logger } from "../logger.js";

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const NOISE_LINE_RE = /^[\s{}()[\];,]*$/;

export interface ContributionSurvivalResult {
  file: string;
  mainCommitSha: string;
  addedLineCount: number;
  missingLineCount: number;
  survived: boolean;
  sampleMissingLines: string[];
}

export interface SurvivalReport {
  allSurvived: boolean;
  perCommit: ContributionSurvivalResult[];
}

export async function checkContributionSurvival(opts: {
  rootDir: string;
  finding: SquashAuditTouchedFileOverlapFinding | SquashAuditDuplicateSubjectFinding;
  headSha: string;
  mergerLog: Logger;
  timeoutMs?: number;
}): Promise<SurvivalReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checks: Array<{ file: string; mainCommitSha: string }> = [];

  if (opts.finding.type === "touched-file-overlap") {
    for (const commit of opts.finding.recentMainCommits) {
      checks.push({ file: opts.finding.file, mainCommitSha: commit.sha });
    }
  } else {
    const commitShas = await resolveSubjectCommits(opts.rootDir, opts.finding.subject, timeoutMs, opts.mergerLog);
    for (const commitSha of commitShas) {
      const files = await listCommitFiles(opts.rootDir, commitSha, timeoutMs, opts.mergerLog);
      for (const file of files) {
        checks.push({ file, mainCommitSha: commitSha });
      }
    }
  }

  if (checks.length === 0) {
    return { allSurvived: false, perCommit: [] };
  }

  const perCommit: ContributionSurvivalResult[] = [];
  for (const check of checks) {
    perCommit.push(await evaluateFileContribution({ ...opts, ...check, timeoutMs }));
  }

  return {
    allSurvived: perCommit.length > 0 && perCommit.every((item) => item.survived),
    perCommit,
  };
}

async function evaluateFileContribution(opts: {
  rootDir: string;
  file: string;
  mainCommitSha: string;
  headSha: string;
  mergerLog: Logger;
  timeoutMs: number;
}): Promise<ContributionSurvivalResult> {
  try {
    const parentSha = (await runGit(opts.rootDir, `git rev-parse ${quoteArg(`${opts.mainCommitSha}^`)}`, opts.timeoutMs)).trim();
    const postContent = await gitShowFile(opts.rootDir, opts.mainCommitSha, opts.file, opts.timeoutMs, opts.mergerLog);
    const preContent = await gitShowFile(opts.rootDir, parentSha, opts.file, opts.timeoutMs, opts.mergerLog);
    const headContent = await gitShowFile(opts.rootDir, opts.headSha, opts.file, opts.timeoutMs, opts.mergerLog);

    const addedLines = diffAddedNormalized(preContent, postContent);
    const headSet = new Set(normalizeLines(headContent));
    const missing = addedLines.filter((line) => !headSet.has(line));

    const survived = addedLines.length === 0
      ? true
      : missing.length / addedLines.length <= 0.05;

    return {
      file: opts.file,
      mainCommitSha: opts.mainCommitSha,
      addedLineCount: addedLines.length,
      missingLineCount: missing.length,
      survived,
      sampleMissingLines: missing.slice(0, 5),
    };
  } catch (error) {
    opts.mergerLog.warn(
      `audit recovery: failed survival check for ${opts.mainCommitSha}:${opts.file} — ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      file: opts.file,
      mainCommitSha: opts.mainCommitSha,
      addedLineCount: 0,
      missingLineCount: 0,
      survived: false,
      sampleMissingLines: [],
    };
  }
}

async function resolveSubjectCommits(
  rootDir: string,
  subject: string,
  timeoutMs: number,
  mergerLog: Logger,
): Promise<string[]> {
  try {
    const output = await runGit(rootDir, "git log --format=%H%x09%s -n 300", timeoutMs);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, ...parts] = line.split("\t");
        return { sha, subject: parts.join("\t") };
      })
      .filter((entry) => entry.subject === subject)
      .map((entry) => entry.sha);
  } catch (error) {
    mergerLog.warn(`audit recovery: failed resolving commits for subject "${subject}" — ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function listCommitFiles(rootDir: string, commitSha: string, timeoutMs: number, mergerLog: Logger): Promise<string[]> {
  try {
    const output = await runGit(rootDir, `git show --name-only --pretty=format: ${quoteArg(commitSha)}`, timeoutMs);
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    mergerLog.warn(`audit recovery: failed listing files for commit ${commitSha} — ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function gitShowFile(
  rootDir: string,
  commitSha: string,
  file: string,
  timeoutMs: number,
  mergerLog: Logger,
): Promise<string> {
  try {
    return await runGit(rootDir, `git show ${quoteArg(`${commitSha}:${file}`)}`, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("exists on disk") || message.includes("does not exist") || message.includes("Path '") || message.includes("fatal:")) {
      mergerLog.warn(`audit recovery: unable to read ${commitSha}:${file} (${message})`);
      return "";
    }
    throw error;
  }
}

function diffAddedNormalized(before: string, after: string): string[] {
  const beforeSet = new Set(normalizeLines(before));
  const afterLines = normalizeLines(after);
  return [...new Set(afterLines.filter((line) => !beforeSet.has(line)))];
}

function normalizeLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trimEnd().trim())
    .filter((line) => line.length > 0)
    .filter((line) => !NOISE_LINE_RE.test(line));
}

async function runGit(rootDir: string, command: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execAsync(command, {
    cwd: rootDir,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    encoding: "utf-8",
  });
  return stdout;
}

function quoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
