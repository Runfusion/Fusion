/**
 * FNXC:CodeOrganization 2026-07-15-12:00:
 * File-scope helpers, squash file-scope invariant, and diff-stat parsing peeled from merger.ts.
 * Re-exported from merger.ts for stable public/test import paths.
 */
import type { Task, TaskStore } from "@fusion/core";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { matchGlob } from "./merger-glob.js";
import { mergerLog } from "../logger.js";
import { resolveMergePolicy, type MergeFileScopeMode } from "./merge-trait.js";
import type { RunAuditor } from "../util/run-audit.js";

const execAsync = promisify(exec);

export interface DiffFileEntry {
  file: string;
  insertions: number;
  deletions: number;
}

export interface DiffScopeResult {
  warnings: string[];
  outOfScopeFiles: string[];
  largeOutOfScopeDeletions: { file: string; deletions: number }[];
}

/**
 * Parse git `--stat` output into per-file insertion/deletion counts.
 *
 * Example line: ` packages/core/src/types.ts | 9 ++--`
 * Binary line:  ` some/image.png            | Bin 0 -> 1234 bytes`
 */
export function parseDiffStat(diffStat: string): DiffFileEntry[] {
  const entries: DiffFileEntry[] = [];
  for (const line of diffStat.split("\n")) {
    // Skip the summary line ("5 files changed, 10 insertions(+), 3 deletions(-)")
    if (line.includes("files changed") || line.includes("file changed")) continue;
    // Match: " path/to/file | 42 +++---" or " path/to/file | Bin ..."
    const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+(\+*)(-*)\s*$/);
    if (!match) continue;
    const file = match[1].trim();
    const plusses = match[3].length;
    const minuses = match[4].length;
    // The number is total changes; +/- chars show the ratio
    const total = parseInt(match[2], 10);
    if (total === 0) continue;
    const ratio = plusses + minuses > 0 ? plusses / (plusses + minuses) : 0.5;
    entries.push({
      file,
      insertions: Math.round(total * ratio),
      deletions: Math.round(total * (1 - ratio)),
    });
  }
  return entries;
}

/**
 * Extract the `## File Scope` section from a PROMPT.md string.
 * Returns an array of file/glob patterns (lines starting with `- \``).
 */
export function extractFileScope(promptContent: string): string[] {
  const lines = promptContent.split("\n");
  const patterns: string[] = [];
  let inScope = false;
  for (const line of lines) {
    if (/^##\s+File Scope/.test(line)) {
      inScope = true;
      continue;
    }
    if (inScope && /^##\s/.test(line)) break; // next section
    if (inScope) {
      // Match "- `path/to/file`" or "- path/to/file"
      const m = line.match(/^-\s+`?([^`\s]+)`?\s*(?:\(.*\))?\s*$/);
      if (m) patterns.push(m[1]);
    }
  }
  return patterns;
}

/**
 * Check whether a file path matches any of the declared scope patterns.
 * Reuses the existing `matchGlob` helper. Also matches if the file is
 * inside a directory that's in scope (e.g., scope has `src/utils/*` and
 * file is `src/utils/helpers.ts`).
 */
export function matchesScope(filePath: string, scopePatterns: string[]): boolean {
  for (const pattern of scopePatterns) {
    if (matchGlob(filePath, pattern)) return true;
    // Directory match: if pattern ends with /* or /**, check prefix
    const dirPattern = pattern.replace(/\/\*+$/, "");
    if (dirPattern !== pattern && filePath.startsWith(dirPattern + "/")) return true;
    // Exact directory match: scope says `src/foo/` and file is inside it
    if (pattern.endsWith("/") && filePath.startsWith(pattern)) return true;
    // Also match if both share the same directory
    const patternDir = pattern.lastIndexOf("/") >= 0 ? pattern.slice(0, pattern.lastIndexOf("/")) : "";
    const fileDir = filePath.lastIndexOf("/") >= 0 ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    if (patternDir && fileDir === patternDir) return true;
  }
  return false;
}

export function partitionConflictsByFileScope(params: {
  conflictFiles: string[];
  declaredScope: string[];
}): { inScope: string[]; outOfScope: string[] } {
  const { conflictFiles, declaredScope } = params;
  if (declaredScope.length === 0) {
    return { inScope: [...conflictFiles], outOfScope: [] };
  }

  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const file of conflictFiles) {
    if (matchesScope(file, declaredScope)) {
      inScope.push(file);
    } else {
      outOfScope.push(file);
    }
  }
  return { inScope, outOfScope };
}

export class FileScopeViolationError extends Error {
  taskId: string;
  stagedFiles: string[];
  declaredScope: string[];

  constructor(taskId: string, stagedFiles: string[], declaredScope: string[]) {
    const stagedList = stagedFiles.length > 0 ? stagedFiles.join(", ") : "<none outside .changeset/>";
    const scopeList = declaredScope.join(", ");
    super(
      `File-scope invariant violation for ${taskId}: staged files [${stagedList}] have zero overlap with declared File Scope [${scopeList}]. Refile genuinely out-of-scope work as a follow-up task via fn_task_create before retrying this merge.`,
    );
    this.name = "FileScopeViolationError";
    this.taskId = taskId;
    this.stagedFiles = stagedFiles;
    this.declaredScope = declaredScope;
  }
}

export type StagedFilesReader = (cwd: string) => Promise<string[]>;

async function readStagedFileNames(cwd: string): Promise<string[]> {
  const { stdout } = await execAsync("git diff --cached --name-only", {
    cwd,
    encoding: "utf-8",
  });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function assertSquashOverlapsFileScope(params: {
  store: TaskStore;
  taskId: string;
  rootDir: string;
  task: Task;
  /** Test seam for deterministic file-scope invariant coverage. Production
   * callers use the default real-git staged-file reader. */
  stagedFilesReader?: StagedFilesReader;
  /** U7 (R10): when the merge trait's `fileScope: "custom"` mode is active,
   *  these glob/path rules replace the task's File Scope section as the
   *  declared scope. `scopeOverride` is a documented no-op only under
   *  `fileScope: "off"` (handled by the caller, which skips this assert). */
  customScopeRules?: string[];
}): Promise<void> {
  const { store, taskId, rootDir, task, customScopeRules, stagedFilesReader = readStagedFileNames } = params;
  const hasCustomRules = Array.isArray(customScopeRules) && customScopeRules.length > 0;

  if (!hasCustomRules && task.scopeOverride === true) {
    const reasonSuffix = task.scopeOverrideReason?.trim()
      ? ` — reason: ${task.scopeOverrideReason.trim()}`
      : "";
    await store.appendAgentLog(
      taskId,
      `file-scope invariant bypassed via scopeOverride${reasonSuffix}`,
      "status",
      undefined,
      "merger",
    );
    return;
  }

  let declaredScope: string[];
  if (hasCustomRules) {
    // Custom rules replace the parsed File Scope section entirely.
    declaredScope = customScopeRules;
  } else {
    if (typeof (store as Partial<TaskStore>).parseFileScopeFromPrompt !== "function") {
      return;
    }
    declaredScope = await store.parseFileScopeFromPrompt(taskId);
  }
  if (declaredScope.length === 0) {
    return;
  }

  const stagedFiles = await stagedFilesReader(rootDir);
  const hasOverlap = stagedFiles.some((file) => matchesScope(file, declaredScope));
  if (!hasOverlap) {
    throw new FileScopeViolationError(taskId, stagedFiles, declaredScope);
  }
}

export function formatFileScopeViolationAgentLog(error: FileScopeViolationError): string {
  const stagedFiles = error.stagedFiles.length > 0 ? error.stagedFiles.join("\n") : "<none>";
  return [
    `taskId: ${error.taskId}`,
    "declaredScope:",
    ...error.declaredScope.map((entry) => `- ${entry}`),
    "stagedFiles:",
    ...stagedFiles.split("\n").map((entry) => `- ${entry}`),
  ].join("\n");
}

export async function enforceSquashFileScopeInvariant(params: {
  store: TaskStore;
  taskId: string;
  rootDir: string;
  task: Task;
  resetLabel: string;
  stagedFilesReader?: StagedFilesReader;
  auditor?: RunAuditor;
}): Promise<void> {
  // U7 (R10): resolve the file-scope enforcement mode from the merge trait
  // (flag ON) or settings (back-compat). The lost-work guard trio is NOT gated
  // by this mode — it lives elsewhere in the mechanics and stays enforced for
  // every mode (KTD-6).
  const policy = await resolveMergePolicy(params.store, params.task);
  const mode: MergeFileScopeMode = policy.fileScope;

  if (mode === "off") {
    // Skip the violation throw, but emit exactly one per-merge audit event
    // recording that scope enforcement was disabled by workflow config. Per-task
    // `scopeOverride` is a documented no-op in this mode (the scope check itself
    // is disabled, so there is nothing to override).
    if (params.auditor) {
      try {
        await params.auditor.git({
          type: "merge:file-scope-enforcement-disabled",
          target: params.taskId,
          metadata: {
            resetLabel: params.resetLabel,
            mode: "off",
            disabledByWorkflowConfig: true,
            scopeOverrideIsNoOp: params.task.scopeOverride === true,
          },
        });
      } catch (auditErr) {
        mergerLog.warn(`${params.taskId}: failed to emit run_audit event for file-scope-enforcement-disabled: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
      }
    }
    return;
  }

  const customScopeRules = mode === "custom" ? policy.fileScopeRules : undefined;

  try {
    await assertSquashOverlapsFileScope({ ...params, customScopeRules });
  } catch (error: unknown) {
    if (!(error instanceof FileScopeViolationError)) {
      throw error;
    }
    // `strict` re-throws the violation (hard guardrail that blocks the merge);
    // `warn`/`custom` log + proceed, with the audit carrying the violating file
    // list (same payload as the error).
    if (mode === "strict") {
      if (params.auditor) {
        try {
          await params.auditor.git({
            type: "merge:file-scope-violation",
            target: params.taskId,
            metadata: {
              resetLabel: params.resetLabel,
              mode: "strict",
              stagedFiles: error.stagedFiles,
              declaredScope: error.declaredScope,
              stagedFileCount: error.stagedFiles.length,
              declaredScopeCount: error.declaredScope.length,
              warningOnly: false,
            },
          });
        } catch (auditErr) {
          mergerLog.warn(`${params.taskId}: failed to emit run_audit event for FileScopeViolationError (strict): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
        }
      }
      throw error;
    }
    const warningMessage = `${error.message} Warning only — continuing merge.`;
    await params.store.appendAgentLog(
      params.taskId,
      warningMessage,
      "status",
      formatFileScopeViolationAgentLog(error),
      "merger",
    );
    mergerLog.warn(`${params.taskId}: ${warningMessage}`);
    if (params.auditor) {
      try {
        await params.auditor.git({
          type: "merge:file-scope-violation",
          target: params.taskId,
          metadata: {
            resetLabel: params.resetLabel,
            stagedFiles: error.stagedFiles,
            declaredScope: error.declaredScope,
            stagedFileCount: error.stagedFiles.length,
            declaredScopeCount: error.declaredScope.length,
            warningOnly: true,
          },
        });
      } catch (auditErr) {
        mergerLog.warn(`${params.taskId}: failed to emit run_audit event for FileScopeViolationError: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
      }
    }
  }
}