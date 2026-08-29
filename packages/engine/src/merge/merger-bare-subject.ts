import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveTitleSummarizerSettingsModel,
  summarizeCommitSubject,
  type Settings,
} from "@fusion/core";
import { mergerLog } from "../logger.js";

const execAsync = promisify(exec);

function quoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Bare-fallback merge subject pattern from `buildDeterministicMergeMessage`'s
 * tier-3 branch (e.g. `feat(FN-5592): merge fusion/fn-5592`). Used to detect
 * commits whose subject is the last-resort `merge ${branch}` form so callers
 * can regenerate a descriptive subject for `mergeDetails.mergeCommitMessage`.
 */
export const BARE_MERGE_SUBJECT_RE = /^[a-z]+(?:\([^)]+\))?!?:\s*merge\s+\S+\s*$/i;

/**
 * If `subject` is the bare tier-3 fallback (`feat(TASK): merge <branch>`),
 * regenerate a descriptive subject from the landed commit's diff stat via
 * the AI commit-subject summarizer. Returns the original subject when the
 * pattern doesn't match, AI summaries are disabled, or regeneration fails.
 *
 * Cosmetic only: never amends the git commit. Callers use the result to
 * populate `mergeDetails.mergeCommitMessage` so dashboards display a
 * meaningful subject even when the on-commit subject is the bare fallback.
 *
 * Lives in its own module (not `merger.ts`) so importers like `self-healing.ts`
 * don't pay the cost of merger's transitive graph — tests that mock
 * `node:child_process` narrowly would otherwise break.
 */
export async function regenerateBareMergeSubject(params: {
  subject: string | undefined;
  commitSha: string;
  branch: string;
  taskId: string;
  rootDir: string;
  settings: Settings;
}): Promise<string | undefined> {
  const { subject, commitSha, branch, taskId, rootDir, settings } = params;
  if (!subject || !BARE_MERGE_SUBJECT_RE.test(subject)) return subject;
  if (!settings.useAiMergeCommitSummary) return subject;
  if (!commitSha) return subject;
  try {
    const { stdout: diffStat } = await execAsync(
      `git show ${quoteArg(commitSha)} --stat --format=`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const trimmedStat = diffStat.trim();
    if (trimmedStat.length === 0) return subject;
    const resolved = resolveTitleSummarizerSettingsModel(settings);
    const regenerated = await summarizeCommitSubject(
      trimmedStat,
      rootDir,
      resolved.provider,
      resolved.modelId,
      { branch, taskId },
    );
    if (!regenerated) return subject;
    const prefixMatch = subject.match(/^([a-z]+(?:\([^)]+\))?!?:)/i);
    const prefix = prefixMatch ? prefixMatch[1] : `feat(${taskId}):`;
    return `${prefix} ${regenerated}`;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: bare-merge-subject regeneration failed (${message})`);
    return subject;
  }
}
