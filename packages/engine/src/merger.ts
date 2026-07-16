/* eslint-disable @typescript-eslint/no-explicit-any */
import { execSync, exec } from "node:child_process";
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import { IDENTITY_GUARD_BYPASS_ENV } from "./worktree-hooks.js";
import { mergeEffectiveSettings } from "./effective-settings.js";
import { buildUserCommentsPromptSection, selectUserCommentsForAgentContext } from "./agent-user-comments.js";

// Internal git plumbing intentionally bypasses sandbox backends.
const execAsync = promisify(exec);
// `execFile` is resolved lazily through the namespace import so test mocks that
// only stub `exec`/`execSync` (the repo's established node:child_process mock
// convention) can still load this module; `execFile` is only required when a
// code path actually shells out.
const execFileAsync: (file: string, args: string[], opts?: import("node:child_process").ExecFileOptions) => Promise<{ stdout: string; stderr: string }> = (file, args, opts) =>
  (promisify(childProcess.execFile) as (f: string, a: string[], o?: object) => Promise<{ stdout: string; stderr: string }>)(file, args, opts);

/**
 * Env for merger-driven `git commit` calls so the identity-guard pre-commit
 * hook accepts commits made on a detached HEAD (intentional in
 * reuse-task-worktree squash/verification-fix ceremonies). Scope is narrow —
 * commit calls only, never plumbing like checkout/reset — and the guard
 * checks for the exact value "1" so a leaked/empty var cannot accidentally
 * bypass agent commits.
 */
function mergerCommitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [IDENTITY_GUARD_BYPASS_ENV]: "1" };
}
import {
  detectMissingWorkspaceEntry,
  runVerificationCommand as runVerificationCommandShared,
  summarizeVerificationOutput,
  truncateWithEllipsis,
  VERIFICATION_COMMAND_MAX_BUFFER,
  VERIFICATION_LOG_MAX_CHARS,
  type VerificationCommandResult,
  type VerificationResult,
} from "./verification-utils.js";
import { resolveSandboxBackend } from "./sandbox/index.js";
import type { SandboxBackend } from "./sandbox/types.js";

// Re-export for backward compatibility (tests import from merger.ts)
export {
  execWithProcessGroup,
  summarizeVerificationOutput,
  truncateWithEllipsis,
  VERIFICATION_COMMAND_MAX_BUFFER,
  VERIFICATION_COMMAND_TIMEOUT_MS,
  VERIFICATION_LOG_MAX_CHARS,
  type VerificationCommandResult,
  type VerificationResult,
} from "./verification-utils.js";

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  computeLockfileHash,
  getConfiguredWorktreeInitCommand,
  getDependencySyncCommand,
  hasInstallState,
  installWorktreeDependencies,
  INSTALL_MARKER_RELPATH,
  readInstallMarker,
  writeInstallMarker,
} from "./merge-dependency-sync.js";
import { resolveTaskWorkingBranch } from "./worktree-names.js";
import {
  collectOwnTaskCommitsForRange,
  filterFilesToOwnTaskCommits,
  SilentNoOpAttributionMismatchError,
} from "./branch-attribution.js";
import { isBranchAuthoritativeForTask } from "./branch-conflicts.js";
import { hostname } from "node:os";
import {
  assertNotWorkspaceTaskMerge,
  buildTaskLineageTrailer,
  evaluateNoCommitsNoOpFinalize,
  getTaskMergeBlocker,
  normalizeMergeConflictStrategy,
  normalizeMergeStrategyOverlapBehavior,
  normalizePostMergeAuditMode,
  resolveTaskMergeTarget,
  normalizeMergeIntegrationWorktreeMode,
  resolveTitleSummarizerSettingsModel,
  resolveAgentPrompt,
  resolvePersistAgentThinkingLog,
  summarizeCommitBody,
  summarizeCommitSubject,
  summarizeMergeCommit,
  type TaskStore,
  type AutostashOutcome,
  type MergeResult,
  type MergeDetails,
  type Settings,
  type AgentPromptsConfig,
  type CanonicalMergeConflictStrategy,
  type DirectMergeCommitStrategy,
  type PostMergeAuditMode,
  type TaskSourceIssue,
  type Task,
  type TaskComment,
  type TaskDetail,
  type AutostashOrphanRecord,
  normalizeMergeAdvanceAutoSyncMode,
  isMergeRequestContractShadowEnabled,
  resolveMergerFallbackModel,
} from "@fusion/core";
import { evaluateAutoMergeFactProviders } from "./auto-merge-fact-providers.js";
import { resolveMergePolicy } from "./merge-trait.js";
import { describeModel, promptWithFallback } from "./pi.js";
import { accumulateSessionTokenUsage } from "./session-token-usage.js";
import { createResolvedAgentSession, extractRuntimeHint, resolveMergerSessionModel, resolveMergerThinkingLevel, resolveMergerFallbackThinkingLevel } from "./agent-session-helpers.js";
import { createFallbackModelObserver } from "./fallback-model-observer.js";
import { buildSessionSkillContext } from "./session-skill-context.js";
import { resolveMcpServersForStore } from "./mcp-resolution.js";
import { classifyTaskWorktree, getRegisteredWorktreeBranches, isRepoRootPath, RemovalReason, removeWorktree, type WorktreePool } from "./worktree-pool.js";
import { activeSessionRegistry } from "./active-session-registry.js";
import { AgentLogger } from "./agent-logger.js";
import { mergerLog } from "./logger.js";

// FNXC:CodeOrganization 2026-07-15-12:00:
// Domain satellites re-exported so existing merger.js import paths stay stable.
export {
  LOCKFILE_PATTERNS,
  GENERATED_PATTERNS,
  matchGlob,
} from "./merger-glob.js";
export type { ConflictType } from "./merger-glob.js";
import { matchGlob, LOCKFILE_PATTERNS, GENERATED_PATTERNS } from "./merger-glob.js";
import type { ConflictType } from "./merger-glob.js";

export {
  parsePnpmWorkspaceGlobs,
  resolveWorkspacePackageRoots,
  mapChangedFilesToPackageNames,
  packageNamesForFiles,
  deriveScopedPnpmTestCommand,
  deriveFileScopedPnpmTestCommand,
  inferDefaultTestCommand,
} from "./merger-workspace-test-commands.js";
export type { InferredTestCommand } from "./merger-workspace-test-commands.js";
import {
  packageNamesForFiles,
  inferDefaultTestCommand,
} from "./merger-workspace-test-commands.js";

export {
  parseDiffStat,
  extractFileScope,
  matchesScope,
  partitionConflictsByFileScope,
  FileScopeViolationError,
  assertSquashOverlapsFileScope,
  formatFileScopeViolationAgentLog,
  enforceSquashFileScopeInvariant,
} from "./merger-file-scope.js";
export type { DiffFileEntry, DiffScopeResult, StagedFilesReader } from "./merger-file-scope.js";
import {
  parseDiffStat,
  extractFileScope,
  matchesScope,
  partitionConflictsByFileScope,
  FileScopeViolationError,
  enforceSquashFileScopeInvariant,
} from "./merger-file-scope.js";
import type { DiffScopeResult } from "./merger-file-scope.js";

export {
  VerificationError,
  MergeAbortedError,
  OutOfScopeVerificationError,
  throwIfAborted,
} from "./merger-errors.js";
import {
  VerificationError,
  OutOfScopeVerificationError,
  throwIfAborted,
} from "./merger-errors.js";

export {
  FUSION_TASK_ID_TRAILER_KEY,
  toTaskToken,
  classifyOwnedLandedEvidence,
} from "./merger-owned-landed.js";
export type { OwnedLandedClassification } from "./merger-owned-landed.js";
import {
  FUSION_TASK_ID_TRAILER_KEY,
  classifyOwnedLandedEvidence,
} from "./merger-owned-landed.js";

export {
  getConflictedFiles,
  isTrivialWhitespaceConflict,
  classifyConflict,
  resolveWithOurs,
  resolveWithTheirs,
  resolveTrivialWhitespace,
  detectResolvableConflicts,
  autoResolveFile,
  resolveConflicts,
} from "./merger-conflict-resolution.js";
export type { ConflictResolution, ConflictCategory } from "./merger-conflict-resolution.js";
import {
  getConflictedFiles,
  classifyConflict,
  resolveWithOurs,
  resolveWithTheirs,
  resolveTrivialWhitespace,
} from "./merger-conflict-resolution.js";

export {
  parseFailingFilesFromOutput,
  parsePorcelainZ,
  parseShortstatSummary,
} from "./merger-git-parse.js";
import {
  parseFailingFilesFromOutput,
  parsePorcelainZ,
  parseShortstatSummary,
} from "./merger-git-parse.js";


import { regenerateBareMergeSubject } from "./merger-bare-subject.js";
export { regenerateBareMergeSubject, BARE_MERGE_SUBJECT_RE } from "./merger-bare-subject.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./usage-limit-detector.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { resolveAgentInstructions, buildSystemPromptWithInstructions } from "./agent-instructions.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "./run-audit.js";
import { createWebFetchTool } from "./agent-tools.js";
import {
  auditSquashMerge,
  MERGER_MAIN_OVERLAP_LOOKBACK_COMMITS,
  type PostMergeAuditInput,
  type PostMergeAuditStrategy,
  type SquashAuditFindings,
} from "./merger-squash-audit.js";
import { detectMergeOverlap, restoreBranchWinsFiles } from "./merger-overlap-guard.js";
import { checkDiffVolume, DiffVolumeRegressionError } from "./merger-diff-volume-gate.js";
import { detectAlreadyLandedOnMain, type AlreadyMergedDetectionStrategy } from "./already-merged-detector.js";
import { decideAutoPrerebase, probeDivergence, runAutoPrerebase } from "./merger-auto-prerebase.js";
import {
  acquireReuseHandoff,
  ensureUsableMergeIntegrationRoot,
  MergeHandoffRefusedError,
  probeIntegrationWorktreeState,
  releaseReuseHandoff,
  resolveIntegrationRemote,
  resolveMergeIntegrationRoot,
  type HandoffResult,
} from "./merger-integration-worktree.js";
import { acquireTaskWorktree } from "./worktree-acquisition.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import { evaluateBranchGroupPromotion, resolveBranchGroupMergeRouting } from "./group-merge-coordinator.js";
import { advanceIntegrationBranchRef, IntegrationBranchConcurrentAdvanceError } from "./merger-ref-update-advance.js";
import { syncWorktreeToHead, type SyncWorktreeResult } from "./worktree-ref-sync.js";
import { appendAutoWidenedScopeToPrompt, evaluateScopeAutoWiden } from "./merger-scope-auto-widen.js";

export { DiffVolumeRegressionError } from "./merger-diff-volume-gate.js";
export { IntegrationBranchConcurrentAdvanceError } from "./merger-ref-update-advance.js";

/*
FNXC:MergeReliability 2026-07-15-14:55:
`smartConflictResolution` was introduced as an alias, not a second enablement gate. Preserve an operator's legacy `autoResolveConflicts: false` choice even when stored defaults include the newer alias.
*/
function isSmartConflictResolutionEnabled(settings: {
  autoResolveConflicts?: boolean;
  smartConflictResolution?: boolean;
}): boolean {
  return settings.autoResolveConflicts !== false && settings.smartConflictResolution !== false;
}

async function resolveMergerMcpServers(store?: TaskStore, agentId?: string | null) {
  // FNXC:McpConfig 2026-06-25-22:27:
  // Merger-owned sessions resolve enabled MCP servers at session creation for conflict resolution, verification fixes, autostash recovery, and post-merge workflow nodes. Secret material stays in memory and is forwarded only through the shared runtime guard.
  return store ? (await resolveMcpServersForStore(store, { agentId: agentId ?? undefined })).servers : undefined;
}

/**
 * After `advanceIntegrationBranchRef` ff-updates `refs/heads/<integrationBranch>`,
 * any other worktree still checked out on that branch keeps its index + working
 * tree pinned at the previous tip. `git status` in such a worktree then shows
 * the new commits inverted as "staged changes to be committed" — the surprise
 * behavior that made many users think the merge had been silently reverted.
 *
 * This helper enumerates other worktrees on the integration branch and calls
 * `syncWorktreeToHead` inside each — snap-forward when the worktree is clean
 * against the previous tip, or capture-patch + reset + reapply when the user
 * has real local edits. Each attempt emits a `merge:auto-sync` audit event
 * with the outcome.
 *
 * Best-effort: any per-worktree failure is recorded as an audit event and the
 * loop continues — the merge has already landed and the auto-sync is convenience.
 */
/*
FNXC:MergePush 2026-07-11-22:10:
Exported for the unified AI merge path: after a push-time divergence rebase CAS-advances
refs/heads/<integrationBranch>, the same other-worktree catch-up (stash-and-ff / ff-only)
must run so the user's checkout doesn't show the rebased commits inverted as staged changes.
*/
export async function runMergeAdvanceAutoSync(input: {
  store: TaskStore;
  audit: RunAuditor;
  taskId: string;
  projectRootDir: string;
  integrationBranch: string;
  previousSha: string;
  newSha: string;
  mode: "ff-only" | "stash-and-ff";
}): Promise<void> {
  const { audit, taskId, projectRootDir, integrationBranch, previousSha, newSha, mode } = input;
  // `getRegisteredWorktreeBranches` returns ALL (branch, path) pairs, not a
  // Map keyed by branch — multiple worktrees can share a branch when the user
  // created secondary checkouts via `git worktree add --force -b`. Collapsing
  // to a Map would silently skip all but the last-iterated of those, which is
  // exactly the surprise-`git status` bug this hook was meant to fix.
  let entries: Array<{ branch: string; worktreePath: string }>;
  try {
    entries = await getRegisteredWorktreeBranches(projectRootDir);
  } catch (err: unknown) {
    await audit.git({
      type: "merge:auto-sync",
      target: projectRootDir,
      metadata: {
        taskId,
        integrationBranch,
        mode,
        outcome: "enumeration-failed",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  const matchingWorktrees: string[] = [];
  for (const entry of entries) {
    if (entry.branch === integrationBranch) {
      matchingWorktrees.push(entry.worktreePath);
    }
  }

  if (matchingWorktrees.length === 0) {
    return;
  }

  for (const worktreePath of matchingWorktrees) {
    let result: SyncWorktreeResult;
    try {
      result = await syncWorktreeToHead({
        worktreePath,
        integrationBranch,
        previousSha,
        newSha,
        mode,
        taskId,
        emit: async (event) => {
          try {
            await audit.git({
              type: event.mutationType,
              target: worktreePath,
              metadata: { ...event.metadata, autoSync: true },
            });
          } catch {
            // best-effort: never let inner audit failure abort the loop
          }
        },
      });
    } catch (err: unknown) {
      await audit.git({
        type: "merge:auto-sync",
        target: worktreePath,
        metadata: {
          taskId,
          integrationBranch,
          mode,
          newSha,
          worktreePath,
          outcome: "exception",
          error: err instanceof Error ? err.message : String(err),
        },
      });
      continue;
    }

    await audit.git({
      type: "merge:auto-sync",
      target: worktreePath,
      metadata: {
        taskId,
        integrationBranch,
        mode,
        newSha,
        previousSha,
        worktreePath,
        outcome: result.kind,
        ...(result.kind === "synced-with-pop-conflict"
          ? { conflictedFiles: result.conflictedFiles, patchPath: result.patchPath, stashedFiles: result.stashedFiles, untrackedSkippedAsTracked: result.untrackedSkippedAsTracked }
          : {}),
        ...(result.kind === "synced-with-edits-restored"
          ? { stashedFiles: result.stashedFiles, untrackedRestored: result.untrackedRestored, untrackedSkippedAsTracked: result.untrackedSkippedAsTracked }
          : {}),
        ...(result.kind === "failed"
          ? { stage: result.stage, error: result.error }
          : {}),
        ...(result.kind === "skipped-dirty"
          ? { dirtyFiles: result.dirtyFiles, untrackedFiles: result.untrackedFiles }
          : {}),
      },
    });
  }
}


const DEPENDENCY_SYNC_TRIGGER_PATTERNS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "packages/*/package.json",
];

const PULL_REBASE_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 60_000;
const PUSH_NON_FF_MAX_RETRIES = 3;
const PUSH_NON_FF_RETRY_BACKOFF_MS = [2_000, 5_000, 10_000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function emitMergeAttemptAuditEvent(params: {
  audit: RunAuditor;
  branch: string;
  attemptNum: 1 | 2 | 3;
  mergeConflictStrategy: CanonicalMergeConflictStrategy;
  attemptLabel: string;
  taskId: string;
}): Promise<void> {
  const { audit, branch, attemptNum, mergeConflictStrategy, attemptLabel, taskId } = params;
  try {
    await audit.git({
      type: "merge:start",
      target: branch,
      metadata: {
        phase: `merge-attempt-${attemptNum}`,
        attemptNum,
        mergeConflictStrategy,
        attemptLabel,
      },
    });
  } catch (auditErr: unknown) {
    mergerLog.warn(
      `${taskId}: failed to emit run_audit event for merge-attempt-${attemptNum}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
    );
  }
}

/** Maximum characters for commit log in merge prompt — prevents context overflow on large branches */
const MERGE_COMMIT_LOG_MAX_CHARS = 5000;

/** Maximum characters for diff stat in merge prompt — prevents context overflow on large diffs */
const MERGE_DIFF_STAT_MAX_CHARS = 3000;

/** Maximum characters for user comments in merge prompt — preserves steering context without crowding merge instructions. */
const MERGE_USER_COMMENTS_MAX_CHARS = 4000;

/**
 * @deprecated Use summarizeVerificationOutput from verification-utils.js instead
 */
export const summarizeVerificationOutputLocal = summarizeVerificationOutput;


interface DiffVolumeGateSettings {
  minLines: number;
  threshold: number;
  allowlistGlobs: string[];
}

function resolveDiffVolumeGateSettings(settings?: Settings): DiffVolumeGateSettings {
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

function formatDiffVolumeFindings(findings: ReadonlyArray<{ file: string; branchNet: number; staged: number; ratio: number }>): string {
  return findings
    .map((finding) => `${finding.file} (branchNet=${finding.branchNet}, staged=${finding.staged}, ratio=${finding.ratio.toFixed(3)})`)
    .join("\n");
}

async function resetToIntegrationTarget(rootDir: string, integrationTargetSha: string): Promise<void> {
  await execAsync(`git reset --hard ${quoteArg(integrationTargetSha)}`, {
    cwd: rootDir,
    encoding: "utf-8",
  });
  await execAsync("git clean -fd", {
    cwd: rootDir,
    encoding: "utf-8",
  });
}

async function runDiffVolumeGate(params: {
  rootDir: string;
  branch: string;
  integrationTargetSha: string;
  taskId: string;
  settings?: Settings;
  store?: TaskStore;
}): Promise<void> {
  try {
    const gateSettings = resolveDiffVolumeGateSettings(params.settings);
    await checkDiffVolume({
      rootDir: params.rootDir,
      branch: params.branch,
      integrationTargetSha: params.integrationTargetSha,
      minLines: gateSettings.minLines,
      threshold: gateSettings.threshold,
      allowlistGlobs: gateSettings.allowlistGlobs,
      taskId: params.taskId,
    });
  } catch (error: unknown) {
    if (!(error instanceof DiffVolumeRegressionError)) throw error;
    await resetToIntegrationTarget(params.rootDir, params.integrationTargetSha);
    const details = formatDiffVolumeFindings(error.findings);
    if (params.store) {
      await params.store.appendAgentLog(
        params.taskId,
        `Diff-volume gate blocked auto-resolved squash before commit`,
        "tool_error",
        details,
        "merger",
      );
    }
    throw error;
  }
}

export async function getStagedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git diff --cached --name-only", {
      cwd,
      encoding: "utf-8",
    });
    const output = stdout.trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

export {
  computeLockfileHash,
  getConfiguredWorktreeInitCommand,
  getDependencySyncCommand,
  hasInstallState,
  INSTALL_MARKER_RELPATH,
  readInstallMarker,
  writeInstallMarker,
};

export function shouldSyncDependenciesForMerge(
  stagedFiles: string[],
  installStatePresent: boolean,
  hasConfiguredInitCommand = false,
): boolean {
  if (hasConfiguredInitCommand) return true;
  if (!installStatePresent) return true;
  return stagedFiles.some((file) =>
    DEPENDENCY_SYNC_TRIGGER_PATTERNS.some((pattern) => matchGlob(file, pattern)),
  );
}


async function syncDependenciesForMerge(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  settings?: Settings | null,
  signal?: AbortSignal,
): Promise<void> {
  await installWorktreeDependencies({
    cwd: rootDir,
    settings,
    taskId,
    signal,
    context: "before merge verification",
    logger: mergerLog,
    log: async (message) => { await store.logEntry(taskId, message); },
  });
}


/**
 * Get the set of files changed in the branch relative to the base branch.
 * Uses `git diff --name-only <baseBranch>...HEAD` (three-dot range so it
 * computes the diff from the merge-base, not the current HEAD of baseBranch).
 *
 * Returns an empty array on git errors (callers treat this as "unknown").
 *
 * @internal Exported for testing only.
 */
export function getBranchChangedFiles(rootDir: string, baseBranch: string, branch: string): string[] {
  try {
    // Quote both refs — branch names can legally contain `/` and other
    // characters that, while harmless to git, would expose us to shell
    // injection if a caller ever passed an unsanitized branch string.
    const baseRef = quoteArg(baseBranch);
    const headRef = branch === "HEAD" ? "HEAD" : quoteArg(branch);
    const output = execSync(
      `git diff --name-only ${baseRef}...${headRef}`,
      { cwd: rootDir, stdio: "pipe", encoding: "utf-8" },
    ).toString();
    return output.split("\n").map((f) => f.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Return the union of all dirty paths in `rootDir`:
 * - tracked files modified vs the index (`git diff --name-only`)
 * - staged but not yet committed (`git diff --cached --name-only`)
 * - untracked files (`git status --porcelain` lines starting with `??`)
 *
 * Errors are swallowed and an empty set is returned so callers are never
 * blocked by a failing porcelain query.
 *
 * All three git queries use NUL-delimited output (`-z`) so paths with
 * embedded spaces or special characters are parsed correctly without quoting.
 */
export async function snapshotDirtyFiles(rootDir: string): Promise<Set<string>> {
  const paths = new Set<string>();
  try {
    const [unstagedOut, stagedOut, porcelainOut] = await Promise.all([
      execFileAsync("git", ["diff", "-z", "--name-only"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
      execFileAsync("git", ["diff", "-z", "--cached", "--name-only"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
      execFileAsync("git", ["status", "-z", "--porcelain"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
    ]);

    for (const entry of unstagedOut.split("\0")) {
      const p = entry.trim();
      if (p) paths.add(p);
    }
    for (const entry of stagedOut.split("\0")) {
      const p = entry.trim();
      if (p) paths.add(p);
    }
    // Untracked files: entries beginning with `?? ` (3-char prefix, no quoting in -z mode)
    for (const entry of porcelainOut.split("\0")) {
      if (!entry.startsWith("?? ")) continue;
      const p = entry.slice(3);
      if (p) paths.add(p);
    }
  } catch {
    // Best-effort — an empty snapshot is safe: the allowlist logic will simply
    // not add any fix-agent files, which is conservative.
  }
  return paths;
}

/**
 * Hash the working tree's dirty content (full diff against HEAD plus porcelain
 * status). Returns "" on failure or when nothing is dirty. Used to detect
 * whether an in-merge fix agent actually changed anything before paying for
 * a verification re-run.
 */
async function gitDirtyFingerprint(rootDir: string): Promise<string> {
  try {
    const [diffOut, statusOut] = await Promise.all([
      execFileAsync("git", ["diff", "HEAD"], {
        cwd: rootDir,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      }).then((r) => r.stdout, () => ""),
      execFileAsync("git", ["status", "-z", "--porcelain"], { cwd: rootDir, encoding: "utf-8" }).then(
        (r) => r.stdout,
        () => "",
      ),
    ]);
    if (!diffOut && !statusOut) return "";
    return createHash("sha256").update(diffOut).update("\0").update(statusOut).digest("hex");
  } catch {
    return "";
  }
}

function rethrowIfMergeAborted(error: unknown): void {
  if (error instanceof Error && error.name === "MergeAbortedError") {
    throw error;
  }
}

/**
 * Run execSync and always return a trimmed UTF-8 string.
 * execSync may return a Buffer, string, or null depending on the encoding option;
 * this helper normalises all three cases.
 */
function execSyncText(command: string, options: Parameters<typeof execSync>[1]): string {
  const output = execSync(command, options);
  if (output == null) return "";
  if (typeof output === "string") return output.trim();
  return (output as Buffer).toString("utf-8").trim();
}

/** Extra environment variables injected into verification child processes to boost concurrency. */
const VERIFICATION_EXTRA_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  (
    [
      ["FUSION_TEST_TOTAL_WORKERS", "8"],
      ["FUSION_TEST_CONCURRENCY", "4"],
      ["FUSION_TEST_WORKSPACE_CONCURRENCY", "4"],
    ] as [string, string][]
  ).filter(([key]) => !(key in process.env)),
);

async function runDeterministicVerification(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  testCommand?: string,
  buildCommand?: string,
  testSource?: "explicit" | "inferred" | "inferred-scoped",
  buildSource?: "explicit" | "inferred",
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const result: VerificationResult = { allPassed: true };
  const settings = await store.getSettings();
  const verificationCommandTimeoutMs = settings.verificationCommandTimeoutMs;

  // Nothing to verify
  if (!testCommand && !buildCommand) {
    mergerLog.log(`${taskId}: no verification commands configured — skipping`);
    return result;
  }

  const normalizedTestCommand = testCommand?.trim();
  const normalizedBuildCommand = buildCommand?.trim();
  const hasTestCommand = !!normalizedTestCommand;
  const hasBuildCommand = !!normalizedBuildCommand;

  // ── Tree-hash verification cache (Layer 1) ─────────────────────────────
  const effectiveTestCommand = normalizedTestCommand ?? "";
  const effectiveBuildCommand = normalizedBuildCommand ?? "";
  let treeSha: string | null = null;
  try {
    treeSha = execSync("git rev-parse HEAD^{tree}", { cwd: rootDir, stdio: "pipe" })
      .toString()
      .trim();
  } catch (err) {
    mergerLog.warn(`${taskId}: could not resolve tree sha — skipping verification cache: ${String(err)}`);
  }

  if (treeSha) {
    const cacheHit = store.getVerificationCacheHit(treeSha, effectiveTestCommand, effectiveBuildCommand);
    if (cacheHit) {
      const sha7 = treeSha.slice(0, 7);
      const msg = `Skipping deterministic verification — cached pass for tree ${sha7} (recorded at ${cacheHit.recordedAt}, by ${cacheHit.taskId ?? "unknown"})`;
      mergerLog.log(`${taskId}: ${msg}`);
      await store.logEntry(taskId, msg);
      await store.appendAgentLog(taskId, msg, "status", undefined, "merger");
      const syntheticResult: VerificationCommandResult = {
        command: "",
        exitCode: 0,
        stdout: "",
        stderr: "",
        success: true,
        cached: true,
      };
      if (hasTestCommand) result.testResult = { ...syntheticResult, command: effectiveTestCommand };
      if (hasBuildCommand) result.buildResult = { ...syntheticResult, command: effectiveBuildCommand };
      return result;
    }
  }
  // ── End cache lookup ───────────────────────────────────────────────────

  // Build source indicator for logging
  const testSourceLabel = (testSource === "inferred" || testSource === "inferred-scoped") ? ` [${testSource}]` : "";
  const buildSourceLabel = buildSource === "inferred" ? " [inferred]" : "";

  mergerLog.log(
    `${taskId}: running deterministic verification` +
    (hasTestCommand ? ` [test:${testSourceLabel} ${normalizedTestCommand}]` : "") +
    (hasBuildCommand ? ` [build:${buildSourceLabel} ${normalizedBuildCommand}]` : ""),
  );
  const testSourceDisplayLabel = (testSource === "inferred" || testSource === "inferred-scoped") ? ` [${testSource}]` : "";
  const deterministicVerificationMessage =
    "Running deterministic merge verification" +
    (hasTestCommand ? ` (test${testSourceDisplayLabel}: ${normalizedTestCommand})` : "") +
    (hasBuildCommand ? ` (build${buildSource === "inferred" ? " [inferred]" : ""}: ${normalizedBuildCommand})` : "");
  await store.logEntry(taskId, deterministicVerificationMessage);
  await store.appendAgentLog(taskId, deterministicVerificationMessage, "status", undefined, "merger");

  const bootstrapScriptPath = join(rootDir, "scripts/ensure-test-artifacts.mjs");
  if (hasTestCommand || hasBuildCommand) {
    if (!existsSync(bootstrapScriptPath)) {
      const bootstrapMissingMessage = `${taskId}: [verification:bootstrap] script missing at scripts/ensure-test-artifacts.mjs — skipping preamble`;
      mergerLog.warn(bootstrapMissingMessage);
      await store.logEntry(taskId, bootstrapMissingMessage);
      await store.appendAgentLog(taskId, bootstrapMissingMessage, "status", undefined, "merger");
    } else {
      const bootstrapCommand = "node scripts/ensure-test-artifacts.mjs";
      await store.logEntry(taskId, `[verification:bootstrap] running: ${bootstrapCommand}`);
      await store.appendAgentLog(taskId, "[verification:bootstrap] running bootstrap preamble", "tool", bootstrapCommand, "merger");
      try {
        throwIfAborted(signal, taskId);
        await execAsync(bootstrapCommand, {
          cwd: rootDir,
          timeout: 300_000,
          maxBuffer: 10 * 1024 * 1024,
          signal,
        });
        throwIfAborted(signal, taskId);
        await store.logEntry(taskId, "[verification:bootstrap] bootstrap preamble succeeded");
        await store.appendAgentLog(taskId, "[verification:bootstrap] bootstrap preamble succeeded", "tool_result", undefined, "merger");
      } catch (error) {
        throwIfAborted(signal, taskId);
        const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number; code?: number | string; message?: string };
        const bootstrapStdout = err?.stdout?.toString?.() || "";
        const bootstrapStderr = err?.stderr?.toString?.() || "";
        const bootstrapOutput = bootstrapStderr || bootstrapStdout || err?.message || "Unknown bootstrap failure";
        const bootstrapExitCode = typeof err?.status === "number"
          ? err.status
          : (typeof err?.code === "number" ? err.code : null);

        result.allPassed = false;
        result.failedCommand = "bootstrap";
        await store.logEntry(
          taskId,
          `[verification:bootstrap] bootstrap preamble failed (exit ${bootstrapExitCode ?? "unknown"}): ${truncateWithEllipsis(bootstrapOutput, VERIFICATION_LOG_MAX_CHARS)}`,
          "VerificationError",
        );
        await store.appendAgentLog(
          taskId,
          "[verification:bootstrap] bootstrap preamble failed",
          "tool_error",
          `exit ${bootstrapExitCode ?? "unknown"}`,
          "merger",
        );
        throw new VerificationError(
          `Verification bootstrap preamble failed for ${taskId}`,
          result,
        );
      }
    }
  }

  let missingEntryRetryAttempted = false;

  const executeVerificationWithRetry = async (
    command: string,
    type: "test" | "build",
    failedCommandLabel: "testCommand" | "buildCommand",
  ): Promise<VerificationCommandResult> => {
    const firstAttempt = await runVerificationCommand(
      store, rootDir, taskId, command, type, signal, verificationCommandTimeoutMs,
    );
    if (firstAttempt.success) {
      return firstAttempt;
    }

    const missingWorkspaceEntry = detectMissingWorkspaceEntry(firstAttempt.stderr, firstAttempt.stdout);
    if (!missingWorkspaceEntry || missingEntryRetryAttempted) {
      return firstAttempt;
    }

    missingEntryRetryAttempted = true;
    const packageName = missingWorkspaceEntry.packageName;
    const rebuildCommand = `pnpm --filter ${packageName} build`;
    await store.logEntry(taskId, `[verification:retry] bootstrap-built: detected missing workspace entry for ${packageName}; running ${rebuildCommand}`);
    await store.appendAgentLog(taskId, "[verification:retry] bootstrap-built", "tool", rebuildCommand, "merger");

    try {
      throwIfAborted(signal, taskId);
      await execAsync(rebuildCommand, {
        cwd: rootDir,
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        signal,
      });
      throwIfAborted(signal, taskId);
    } catch (_error) {
      throwIfAborted(signal, taskId);
      await store.logEntry(taskId, `[verification:retry] retry-different-failure: workspace rebuild failed for ${packageName}`);
      await store.appendAgentLog(taskId, "[verification:retry] retry-different-failure", "tool_error", packageName, "merger");
      return firstAttempt;
    }

    const retryAttempt = await runVerificationCommand(
      store, rootDir, taskId, command, type, signal, verificationCommandTimeoutMs,
    );
    if (retryAttempt.success) {
      result.environmentFault = {
        kind: "missing-workspace-entry",
        packageName,
        recovered: true,
      };
      await store.logEntry(taskId, `[verification:retry] retry-success: rebuilt ${packageName} and ${failedCommandLabel} now passes`);
      await store.appendAgentLog(taskId, "[verification:retry] retry-success", "tool_result", packageName, "merger");
      return retryAttempt;
    }

    const retryMissingWorkspaceEntry = detectMissingWorkspaceEntry(retryAttempt.stderr, retryAttempt.stdout);
    if (retryMissingWorkspaceEntry?.packageName === packageName) {
      result.environmentFault = {
        kind: "missing-workspace-entry",
        packageName,
        recovered: false,
      };
      await store.logEntry(taskId, `[verification:retry] retry-still-missing: ${packageName} still missing after rebuild`);
      await store.appendAgentLog(taskId, "[verification:retry] retry-still-missing", "tool_error", packageName, "merger");
      return retryAttempt;
    }

    await store.logEntry(taskId, `[verification:retry] retry-different-failure: rebuild fixed entry point but ${failedCommandLabel} still failed`);
    await store.appendAgentLog(taskId, "[verification:retry] retry-different-failure", "tool_error", packageName, "merger");
    return retryAttempt;
  };

  // Run test command first if configured
  if (hasTestCommand) {
    const testResult = await executeVerificationWithRetry(
      normalizedTestCommand!, "test", "testCommand",
    );
    result.testResult = testResult;

    if (!testResult.success) {
      result.allPassed = false;
      result.failedCommand = "testCommand";
      await store.logEntry(
        taskId,
        `Deterministic test verification failed (exit ${testResult.exitCode}) — see prior [verification] entry for truncated output`,
        "VerificationError",
      );
      await store.appendAgentLog(
        taskId,
        "Verification failed",
        "tool_error",
        `exit ${testResult.exitCode}`,
        "merger",
      );
      throw new VerificationError(
        `Deterministic test verification failed for ${taskId}`,
        result,
      );
    }
  }

  // Run build command second if configured
  if (hasBuildCommand) {
    const buildResult = await executeVerificationWithRetry(
      normalizedBuildCommand!, "build", "buildCommand",
    );
    result.buildResult = buildResult;

    if (!buildResult.success) {
      result.allPassed = false;
      result.failedCommand = "buildCommand";
      await store.logEntry(
        taskId,
        `Deterministic build verification failed (exit ${buildResult.exitCode}) — see prior [verification] entry for truncated output`,
        "VerificationError",
      );
      await store.appendAgentLog(
        taskId,
        "Verification failed",
        "tool_error",
        `exit ${buildResult.exitCode}`,
        "merger",
      );
      throw new VerificationError(
        `Deterministic build verification failed for ${taskId}`,
        result,
      );
    }
  }

  mergerLog.log(`${taskId}: deterministic verification passed`);
  await store.logEntry(taskId, "Deterministic merge verification passed");
  await store.appendAgentLog(taskId, "Deterministic merge verification passed", "status", undefined, "merger");

  // ── Record cache pass ──────────────────────────────────────────────────
  if (treeSha) {
    try {
      store.recordVerificationCachePass(treeSha, effectiveTestCommand, effectiveBuildCommand, taskId);
      mergerLog.log(`${taskId}: Recorded verification pass for tree ${treeSha.slice(0, 7)}`);
      await store.logEntry(taskId, `Recorded verification pass for tree ${treeSha.slice(0, 7)}`);
    } catch (err) {
      mergerLog.warn(`${taskId}: could not record verification cache pass: ${String(err)}`);
    }
  }

  return result;
}

async function runVerificationCommand(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  command: string,
  type: "test" | "build",
  signal?: AbortSignal,
  timeoutMsOverride?: number,
): Promise<VerificationCommandResult> {
  throwIfAborted(signal, taskId);
  return runVerificationCommandShared(store, rootDir, taskId, command, type, signal, mergerLog, "merger", VERIFICATION_EXTRA_ENV, timeoutMsOverride);
}

/**
 * Attempt an in-merge verification fix by spawning an AI agent on the main branch.
 * Returns true if verification passes after the fix, false otherwise.
 *
 * Throws OutOfScopeVerificationError when the fix agent made no changes AND the
 * failing files are all outside the branch's diff — meaning the failure is
 * pre-existing on the base branch and cannot be fixed by this task's agent.
 *
 * @param fixModifiedFiles - Mutable set that this function populates with every
 *   path that changed during the fix agent's run (post-snapshot minus
 *   pre-snapshot). The caller passes this set across all fix attempts so that
 *   `commitOrAmendMergeWithFixes` can build an allowlist that covers every file
 *   the fix agent touched, regardless of how many retries were needed.
 * @param baseBranch - Integration branch name (e.g. "main"). Used for
 *   out-of-scope detection; pass undefined to skip detection.
 * @param branch - Feature branch name being merged. Used for out-of-scope
 *   detection; pass undefined to skip detection.
 */
async function attemptInMergeVerificationFix(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  failureContext: {
    command: string;
    exitCode: number | null;
    output: string;
    type: "test" | "build";
  },
  settings: Settings,
  options: MergerOptions,
  mergeRunContext?: Pick<EngineRunContext, "runId" | "agentId">,
  fixAttemptNumber?: number,
  testCommand?: string,
  buildCommand?: string,
  testSource?: "explicit" | "inferred" | "inferred-scoped",
  buildSource?: "explicit" | "inferred",
  fixModifiedFiles?: Set<string>,
  baseBranch?: string,
  branch?: string,
): Promise<boolean> {
  // Snapshot the working tree before doing anything so the diff reflects only
  // what the fix agent touched, not pre-existing dirty state.
  const preFixSnapshot = await snapshotDirtyFiles(rootDir);
  const preFixFingerprint = await gitDirtyFingerprint(rootDir);
  try {
    mergerLog.log(`${taskId}: spawning in-merge verification fix agent`);

    const logger = new AgentLogger({
      store,
      taskId,
      agent: "merger",
      persistAgentToolOutput: settings.persistAgentToolOutput,
      // Merger agents are task-scoped ephemeral workers.
    persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
      onAgentText: options.onAgentText,
      onAgentTool: options.onAgentTool,
    });

    // Build skill selection context
    let skillContext = undefined;
    let taskForSkillContext: Awaited<ReturnType<typeof store.getTask>> | null = null;
    if (options.agentStore) {
      try {
        taskForSkillContext = await store.getTask(taskId);
        skillContext = await buildSessionSkillContext({
          agentStore: options.agentStore,
          task: taskForSkillContext,
          sessionPurpose: "merger",
          projectRootDir: rootDir,
          pluginRunner: options.pluginRunner,
        });
      } catch {
        // Graceful fallback - no skill selection
      }
    }

    // Create the fix agent session
    throwIfAborted(options.signal, taskId);
    const assignedAgentId = taskForSkillContext?.assignedAgentId?.trim();
    const agentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
      ? options.agentStore
      : null;
    const assignedAgent = assignedAgentId && agentStoreWithGetAgent
      ? await agentStoreWithGetAgent.getAgent(assignedAgentId).catch(() => null)
      : null;
    const mergerRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);
    const mergerSessionModel = resolveMergerSessionModel(settings, assignedAgent?.runtimeConfig);

    // FNXC:Settings-MergerModel 2026-07-16-00:00: merger retries use the dedicated project fallback lane before the shared global fallback pair.

    const mergerFallbackModel = resolveMergerFallbackModel(settings);
      // FN-5279: verification-fix sessions run in the resolved integration root,
    // which is the reused task worktree in handoff mode.
    const { session } = await createResolvedAgentSession({
      sessionPurpose: "merger",
      runtimeHint: mergerRuntimeHint,
      pluginRunner: options.pluginRunner,
      cwd: rootDir,
      systemPrompt: `You are a verification fix agent running during a merge on the main branch.

A merge has been applied and the verification command failed. Your job is to fix the failing code directly in the working directory.

## Scope
Only fix what is required to make the failing verification pass.
Do not refactor, rename broadly, or make opportunistic improvements.

## Rules
1. Read the error output carefully to understand what is failing before editing anything
2. Before assuming a code fix is needed, check whether the failure is caused by stale/missing build artifacts in a sibling workspace package — typical signatures: \`Failed to resolve import "./X.js"\` pointing into another package's \`dist/\`, \`Cannot find module\`, or \`ERR_MODULE_NOT_FOUND\` referencing a workspace-internal path. In that case, rebuild the affected package(s) (e.g. \`pnpm --filter <pkg> build\`, or \`pnpm --filter "<scope>/*" build\` for a group) and re-run verification before editing source files.
3. Make targeted fixes to the failing code path
4. After fixing, verify your changes keep both deterministic test and build commands passing
5. Do NOT make any git commits — just fix the code
6. You MAY modify any files needed to make the verification pass, including files unrelated to this task's original change. Pre-existing build/test breakage on the base branch is in scope: fix it. Prefer the smallest change that makes verification green.
7. If you cannot fix the issue within scope, explain why and what evidence indicates a deeper/root problem`,
      tools: "coding", // Agent needs read/write file access
      onText: logger.onText,
      onThinking: logger.onThinking,
      onToolStart: logger.onToolStart,
      onToolEnd: logger.onToolEnd,
      defaultProvider: mergerSessionModel.provider,
      defaultModelId: mergerSessionModel.modelId,
      fallbackProvider: mergerFallbackModel.provider,
      fallbackModelId: mergerFallbackModel.modelId,
      fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings),
      defaultThinkingLevel: resolveMergerThinkingLevel(settings),
      runAuditor: createRunAuditor(store, {
        runId: mergeRunContext?.runId ?? generateSyntheticRunId("merge", taskId),
        agentId: mergeRunContext?.agentId ?? "merger",
        taskId,
        phase: "merge",
        source: "merger",
      }),
      settings,
      mcpServers: await resolveMergerMcpServers(store, assignedAgent?.id),
      // FNXC:PluginSkills 2026-07-12-00:00: Merger verification-fix sessions forward plugin skill body dirs with requested names so plugin merge guidance is discoverable in live sessions.
      ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
      ...(skillContext && skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
      taskId,
      taskTitle: taskForSkillContext?.title,
      onFallbackModelUsed: createFallbackModelObserver({
        agent: "merger",
        label: "merge verification fix agent",
        store,
        taskId,
        taskTitle: taskForSkillContext?.title,
      }),
    });
    // Register so engine.stop() can dispose this session — without this the
    // fix agent keeps streaming past shutdown because it's not the autostash
    // session that the engine tracks.
    options.onSession?.(session);

    const runId = mergeRunContext?.runId;
    const agentId = mergeRunContext?.agentId ?? "merger";
    await store.logEntry(
      taskId,
      `In-merge verification fix agent started (model: ${describeModel(session)}, runId: ${runId ?? "unknown"}, agentId: ${agentId})`,
    );
    await store.appendAgentLog(
      taskId,
      `Fix agent started (model: ${describeModel(session)})`,
      "status",
      undefined,
      "merger",
    );

    try {
      // Build the fix prompt
      const fixPrompt = `Fix the failing ${failureContext.type} verification for task ${taskId}.

## Failed command
Command: \`${failureContext.command}\`
Exit code: ${failureContext.exitCode}

## Error output
${failureContext.output.slice(0, VERIFICATION_LOG_MAX_CHARS)}

## Instructions
1. Read the error output and identify the root cause
2. Make targeted fixes to resolve the failure
3. Use \`${failureContext.command}\` while iterating, but ensure your final changes keep both deterministic test and build commands passing
4. If the fix doesn't work, try a different approach
5. Do NOT make any git commits`;

      // Run the agent with rate limit retry
      await withRateLimitRetry(async () => {
        throwIfAborted(options.signal, taskId);
        await promptWithFallback(session, fixPrompt);
      }, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          mergerLog.warn(`⏳ ${taskId} in-merge fix rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
        },
        signal: options.signal,
      });
      await accumulateSessionTokenUsage(store, taskId, session);

      // Compute which paths the fix agent introduced or modified, then
      // accumulate them into the caller's mutable set.
      const postFixSnapshot = await snapshotDirtyFiles(rootDir);
      const newlyTouched: string[] = [];
      for (const p of postFixSnapshot) {
        if (!preFixSnapshot.has(p)) newlyTouched.push(p);
      }
      if (fixModifiedFiles) {
        for (const p of newlyTouched) fixModifiedFiles.add(p);
      }

      // If the fix agent didn't actually edit anything, re-running the same
      // failing verification can only yield the same failure — skip the
      // multi-minute test/build cycle and report the attempt as unsuccessful.
      // Use a git content fingerprint (diff + porcelain status) so we also
      // catch in-place edits to already-dirty files, not just newly added
      // paths. Only skip when we have a non-empty fingerprint to compare
      // against; an empty pre-fingerprint means the snapshot tool failed and
      // we should fall back to actually re-running verification.
      const postFixFingerprint = await gitDirtyFingerprint(rootDir);
      const fingerprintsMatch =
        preFixFingerprint.length > 0 && preFixFingerprint === postFixFingerprint;
      if (newlyTouched.length === 0 && fingerprintsMatch) {
        mergerLog.warn(`${taskId}: in-merge fix agent made no changes — skipping verification re-run`);
        await store.logEntry(
          taskId,
          `In-merge fix agent made no changes — skipping verification re-run (attempt ${fixAttemptNumber ?? "unknown"})`,
        );
        await store.appendAgentLog(
          taskId,
          `Fix agent made no changes — skipping verification re-run`,
          "status",
          undefined,
          "merger",
        );

        // Out-of-scope detection: if we have git context and can parse failing
        // file paths, check whether ALL failing files are outside the branch
        // diff. If so, throw OutOfScopeVerificationError so the caller can mark
        // the task failed immediately rather than retrying into limbo.
        //
        // Heuristic: a failing file is "in-scope" if any branch-changed file
        // shares the same workspace package (preferred), or — when pnpm
        // workspace info is unavailable — if the paths share a common
        // directory prefix. The exact-match clause catches the trivial case
        // (test failure in the same file the branch touched).
        if (baseBranch && branch) {
          const failingFiles = parseFailingFilesFromOutput(failureContext.output);
          if (failingFiles.length > 0) {
            const branchFiles = getBranchChangedFiles(rootDir, baseBranch, branch);
            if (branchFiles.length > 0) {
              const branchPackages = new Set(packageNamesForFiles(rootDir, branchFiles));
              const failingPackages = packageNamesForFiles(rootDir, failingFiles);
              const hasPackageOverlap =
                branchPackages.size > 0 &&
                failingPackages.some((p) => branchPackages.has(p));
              const allOutOfScope = !hasPackageOverlap && failingFiles.every((ff) =>
                !branchFiles.some((bf) => bf === ff || ff.startsWith(`${bf}/`)),
              );
              if (allOutOfScope) {
                const msg =
                  `Merge verification failed in files outside branch scope — likely pre-existing flake on ${baseBranch}. ` +
                  `Failing files: [${failingFiles.join(", ")}]. Branch diff files: [${branchFiles.slice(0, 10).join(", ")}${branchFiles.length > 10 ? ", ..." : ""}].`;
                mergerLog.warn(`${taskId}: ${msg}`);
                await store.logEntry(taskId, msg);
                await store.appendAgentLog(taskId, "Out-of-scope verification failure detected — not retrying", "status", undefined, "merger");
                throw new OutOfScopeVerificationError(msg, failingFiles, branchFiles);
              }
            }
          }
        }

        return false;
      }

      // Re-run deterministic verification command after the fix attempt.
      await store.logEntry(
        taskId,
        `Re-running deterministic merge verification (attempt ${fixAttemptNumber ?? "unknown"})`,
      );
      await store.appendAgentLog(
        taskId,
        `Re-running verification (attempt ${fixAttemptNumber ?? "unknown"})`,
        "status",
        undefined,
        "merger",
      );
      try {
        await runDeterministicVerification(
          store,
          rootDir,
          taskId,
          testCommand,
          buildCommand,
          testSource,
          buildSource,
          options.signal,
        );
        return true;
      } catch (error: unknown) {
        if (error instanceof VerificationError) {
          return false;
        }
        throw error;
      }
    } finally {
      // Flush buffered output before disposal so fix-attempt activity is visible.
      await logger.flush();
      await session.dispose();
    }
  } catch (err: unknown) {
    rethrowIfMergeAborted(err);
    // OutOfScopeVerificationError must propagate so the caller can mark the
    // task failed without entering the limbo-recovery cycle.
    if (err instanceof OutOfScopeVerificationError) {
      throw err;
    }
    // Even on failure, try to surface any paths the agent partially touched.
    if (fixModifiedFiles) {
      try {
        const postFixSnapshot = await snapshotDirtyFiles(rootDir);
        for (const p of postFixSnapshot) {
          if (!preFixSnapshot.has(p)) {
            fixModifiedFiles.add(p);
          }
        }
      } catch {
        // Best-effort only
      }
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: in-merge fix agent error: ${errorMessage}`);
    await store.logEntry(taskId, "In-merge verification fix agent encountered an error", errorMessage);
    await store.appendAgentLog(taskId, "Fix agent encountered an error", "tool_error", errorMessage, "merger");
    return false;
  }
}

/**
 * Best-effort `git reset --merge` with a labeled warning on failure.
 * `label` describes the cleanup site so operators can correlate the warning
 * back to the merge phase that left state behind. The label is included in
 * the warning text so test assertions can match on it.
 */
function resetMergeWithWarn(rootDir: string, taskId: string, label: string): void {
  runObservedDestructiveSyncOp(rootDir, taskId, `reset --merge (${label})`, () => {
    try {
      execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: git reset --merge cleanup failed during ${label}: ${msg}`);
    }
  });
}

/** Identity returned by `stashUnrelatedRootDirChanges`. The SHA is the stable
 *  handle (commit object id, never moves) — used for apply / drop instead of
 *  position-relative `stash@{N}` refs that shift when other stashes are
 *  pushed during or after the merge. The label is purely for human display.
 *  `rescueShas` lists any race-rescue stashes the autostash captured for
 *  late-dirty paths (concurrent dev edits during the merger run). They are
 *  surfaced separately so the caller can log them to the task feed. */
export interface AutostashHandle {
  sha: string;
  label: string;
  rescueShas?: { sha: string; label: string }[];
}

const AUTOSTASH_LABEL_PREFIX = "fusion-merger-autostash:";

/*
FNXC:MergeAutostash 2026-07-15-13:20:
`merger-ai`'s local-checkout sync stashed under its own `fusion-ai-merge-sync-<taskId>`
label, which none of the reclamation machinery here matches — every path keys off
AUTOSTASH_LABEL_PREFIX. The entries were therefore never classified, never
subsumed-dropped, never age-swept, and never surfaced as orphans holding work:
they accumulated indefinitely (six entries dating back a month were found on a
single working tree, and their sheer age made real lost work indistinguishable
from litter).

merger-ai now labels through `buildAutostashLabel` so one vocabulary reaches all
of it. This legacy prefix stays recognized so entries already sitting in
developers' stash lists are reclaimed rather than stranded forever; it carries no
timestamp, so the age sweep skips it and only the subsumed check can drop it.
*/
const LEGACY_AI_SYNC_LABEL_PREFIX = "fusion-ai-merge-sync-";

/** Canonical autostash label. `phase` distinguishes the creating call site
 *  (`pre-merge`, `ai-local-sync`, `finalize-reset`, `race-rescue-<n>`). */
export function buildAutostashLabel(taskId: string, phase: string, at: number): string {
  return `${AUTOSTASH_LABEL_PREFIX}${taskId}:${phase}:${at}`;
}
const AUTOSTASH_TIMESTAMP_RE = /^fusion-merger-autostash:[A-Za-z]+-\d+:(?:(?:[a-z0-9-]+:)?(?:\d+:)?)?(\d+)$/;

/** Return the set of paths a stash commit recorded as changed against its
 *  parent (HEAD-at-stash-time). Used to compare a new dirty snapshot against
 *  the primary autostash and avoid producing duplicate race-rescue stashes
 *  for the same paths the primary already captured. */
/*
FNXC:MergeAutostash 2026-07-15-13:20:
A stash created with `--include-untracked` stores its untracked files in a THIRD
parent commit (`<sha>^3`) whose paths `git stash show` does not list — it reports
the tracked side only. Reading just that side makes an untracked-only stash look
EMPTY, and every "does this stash still hold work?" caller reads empty as
"subsumed → safe to drop". That silently destroys untracked work: new tests, plan
docs, and changesets are exactly what the ai-local-sync stashes carry.
Enumerate both sides, and keep them distinguishable — the two sides must be
diffed against different commits (see `classifyStashContent`).

`null` means "could not read", which is NOT the same as "holds nothing". Callers
must treat null as unknown and refuse to drop; collapsing the two is the bug
above.
*/
async function listStashTrackedPaths(rootDir: string, stashSha: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execAsync(
      `git stash show -z --name-only ${quoteArg(stashSha)}`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const out = new Set<string>();
    for (const entry of String(stdout).split("\0")) {
      const p = entry.trim();
      if (p) out.add(p);
    }
    return out;
  } catch {
    return null;
  }
}

/** Paths held in a stash's untracked third parent. An empty set (not null) is
 *  returned when the stash simply has no `^3` — i.e. it was created without
 *  `--include-untracked`, which is a legitimate "no untracked files" answer. */
async function listStashUntrackedPaths(rootDir: string, stashSha: string): Promise<Set<string> | null> {
  try {
    await execAsync(`git rev-parse -q --verify ${quoteArg(`${stashSha}^3`)}`, { cwd: rootDir, encoding: "utf-8" });
  } catch {
    return new Set<string>();
  }
  try {
    const { stdout } = await execAsync(
      `git ls-tree -r -z --name-only ${quoteArg(`${stashSha}^3`)}`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const out = new Set<string>();
    for (const entry of String(stdout).split("\0")) {
      const p = entry.trim();
      if (p) out.add(p);
    }
    return out;
  } catch {
    return null;
  }
}

/** Every path a stash holds, tracked and untracked. Used for display and for
 *  rescue-scope decisions; `classifyStashContent` is the drop-safety authority. */
async function listStashChangedPaths(rootDir: string, stashSha: string): Promise<Set<string>> {
  const [tracked, untracked] = await Promise.all([
    listStashTrackedPaths(rootDir, stashSha),
    listStashUntrackedPaths(rootDir, stashSha),
  ]);
  // Best-effort union: an empty set means we'll be slightly more aggressive
  // about rescuing (everything dirty gets rescued), which is the safe
  // direction — false positives are noise, false negatives are data loss.
  return new Set<string>([...(tracked ?? []), ...(untracked ?? [])]);
}

/** True iff two stash commits point to the exact same tree object. Cheap
 *  way to detect "stash create produced a duplicate" without diffing files. */
async function stashTreesEqual(rootDir: string, aSha: string, bSha: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      execAsync(`git rev-parse ${quoteArg(aSha)}^{tree}`, { cwd: rootDir, encoding: "utf-8" }),
      execAsync(`git rev-parse ${quoteArg(bSha)}^{tree}`, { cwd: rootDir, encoding: "utf-8" }),
    ]);
    return a.stdout.trim() === b.stdout.trim();
  } catch {
    return false;
  }
}

/** Filename of the advisory "merger active" status file. Lives at
 *  `<rootDir>/.git/<this filename>` so it travels with the repo and is
 *  automatically scoped to the right working tree. Not a lock — purely
 *  informational, intended for dashboards / status lines / pre-Edit hooks
 *  that want to warn devs that rootDir is volatile until the merge finishes. */
const ACTIVE_MERGER_STATUS_FILENAME = ".fusion-merger-active.json";

/** Shape of the advisory status file. PID + hostname let readers detect
 *  stale files left behind by a crashed merger run. */
export interface ActiveMergerStatus {
  taskId: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

/** Write the advisory status file at `<rootDir>/.git/...`. Best-effort:
 *  failures are logged and the merge proceeds without the advisory — losing
 *  the dashboard signal is preferable to blocking the merge. Returns the
 *  path of the file that was written so the caller can pass it back to
 *  `clearActiveMergerStatus` on cleanup. */
function writeActiveMergerStatus(rootDir: string, taskId: string): string | null {
  try {
    const statusPath = join(rootDir, ".git", ACTIVE_MERGER_STATUS_FILENAME);
    const payload: ActiveMergerStatus = {
      taskId,
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    };
    // Atomic write via temp + rename. Without this, a reader that hits
    // existsSync() between `open` and the final flush sees a partial /
    // empty file. JSON.parse rejects partial writes so we'd just return
    // null, but that produces false "no merger active" advisories.
    // POSIX guarantees rename is atomic on the same filesystem.
    const tempPath = `${statusPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tempPath, statusPath);
    return statusPath;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: writeActiveMergerStatus failed (${msg}) — proceeding without advisory file`);
    return null;
  }
}

/** Best-effort delete of the status file. */
function clearActiveMergerStatus(statusPath: string | null, taskId: string): void {
  if (!statusPath) return;
  try {
    unlinkSync(statusPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: clearActiveMergerStatus failed (${msg}) — file may linger as a stale advisory`);
  }
}

/** Public reader for tooling (CLI / dashboard / TUI / Claude Code hook).
 *  Returns null if no merger is active OR if the advisory file is malformed.
 *  Callers can correlate `pid` + `hostname` with their own process list to
 *  distinguish a live merger from a stale post-crash file. */
export function readActiveMergerStatus(rootDir: string): ActiveMergerStatus | null {
  try {
    const statusPath = join(rootDir, ".git", ACTIVE_MERGER_STATUS_FILENAME);
    if (!existsSync(statusPath)) return null;
    const raw = readFileSync(statusPath, "utf-8");
    const parsed = JSON.parse(raw) as ActiveMergerStatus;
    if (!parsed?.taskId || typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Wrap a destructive op in `rootDir` with snapshot-before / snapshot-after
 *  observability. Pure logging — does not rescue. Designed for ops that are
 *  *supposed* to preserve unrelated working-tree edits (e.g. `git reset
 *  --merge`, `git checkout main`). When such an op silently wipes a path
 *  that was dirty before, the warning surfaces it as actionable signal
 *  instead of letting the loss go unnoticed.
 *
 *  Not used for the autostash's own `git reset --hard HEAD` / `git clean
 *  -fd` (those are intentionally destructive and have race-rescue stashes
 *  capturing dirty state up-front).
 *
 *  Synchronous variant — the destructive ops themselves are mostly
 *  `execSync` for "best-effort cleanup" semantics, so the wrapper matches
 *  to avoid scattering Promise-juggling at every call site. */
function runObservedDestructiveSyncOp(
  rootDir: string,
  taskId: string,
  label: string,
  op: () => void,
): void {
  // snapshotDirtyFiles is async by design (uses Promise.all over three git
  // queries); we read it via a quick sync fallback so the observer doesn't
  // change the call shape of resetMergeWithWarn et al.
  let beforeRaw = "";
  try {
    beforeRaw = execSync("git status -z --porcelain", { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8");
  } catch {
    // best-effort — skip observation if we can't read status
    op();
    return;
  }
  const before = parsePorcelainZ(beforeRaw);

  op();

  let afterRaw = "";
  try {
    afterRaw = execSync("git status -z --porcelain", { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8");
  } catch {
    return;
  }
  const after = parsePorcelainZ(afterRaw);

  const lost = [...before].filter((p) => !after.has(p));
  if (lost.length > 0) {
    const sample = lost.slice(0, 10).join(", ");
    const ellipsis = lost.length > 10 ? ` … (+${lost.length - 10} more)` : "";
    mergerLog.warn(
      `${taskId}: destructive op "${label}" cleared ${lost.length} dirty path(s) that were present before — possible silent wipe of unrelated dev edits: ${sample}${ellipsis}`,
    );
  }
}

/** Find autostashes from PRIOR runs that are still sitting in the stash list.
 *  These are leftovers from past merges whose pop/apply conflicted — under the
 *  old code path the warning was logged once and then forgotten, and the
 *  next merge would silently bury them by pushing a new stash on top. We now
 *  surface them at the start of every merge so the developer notices. */
async function listOrphanedAutostashes(
  rootDir: string,
): Promise<Array<{ sha: string; ref: string; label: string }>> {

  try {
    const { stdout } = await execAsync(
      `git stash list --format="%H %gd %s"`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const lines = String(stdout).split("\n").map((l) => l.trim()).filter(Boolean);
    const orphans: Array<{ sha: string; ref: string; label: string }> = [];
    for (const line of lines) {
      // Format: "<sha> stash@{N} <subject including label>"
      // Match the canonical label, or the legacy merger-ai one so already-leaked
      // entries are reclaimed too (see LEGACY_AI_SYNC_LABEL_PREFIX).
      let idx = line.indexOf(AUTOSTASH_LABEL_PREFIX);
      if (idx === -1) idx = line.indexOf(LEGACY_AI_SYNC_LABEL_PREFIX);
      if (idx === -1) continue;
      const parts = line.split(/\s+/);
      const sha = parts[0] ?? "";
      const ref = parts[1] ?? "";
      const label = line.slice(idx);
      if (sha && ref) orphans.push({ sha, ref, label });
    }
    return orphans;
  } catch {
    return [];
  }
}

function parseAutostashTaskId(label: string): string | null {
  const trimmed = label.trim();
  const match = /^fusion-merger-autostash:([A-Za-z]+-\d+):/.exec(trimmed);
  if (match?.[1]) return match[1];
  // Legacy merger-ai label: `fusion-ai-merge-sync-<taskId>` (no trailing fields).
  return /^fusion-ai-merge-sync-([A-Za-z]+-\d+)$/.exec(trimmed)?.[1] ?? null;
}


function parseAutostashCreatedAt(label: string): string | null {
  const match = AUTOSTASH_TIMESTAMP_RE.exec(label.trim());
  if (!match) return null;
  const ts = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function parseAutostashSourcePhase(label: string): string | null {
  const trimmed = label.trim();
  const phaseMatch = /^fusion-merger-autostash:[A-Za-z]+-\d+:([a-z-]+):\d+$/.exec(trimmed);
  if (phaseMatch?.[1]) return phaseMatch[1];
  if (/^fusion-merger-autostash:[A-Za-z]+-\d+:race-rescue-\d+:\d+$/.test(trimmed)) return "race-rescue";
  if (/^fusion-merger-autostash:[A-Za-z]+-\d+:\d+$/.test(trimmed)) return "pre-merge";
  if (/^fusion-ai-merge-sync-[A-Za-z]+-\d+$/.test(trimmed)) return "ai-local-sync";
  return null;
}

/*
FNXC:MergeAutostash 2026-07-15-13:20:
The single drop-safety authority: may this stash be discarded without losing work?

  - `subsumed` — every path it holds is already byte-identical to HEAD. Safe to drop.
  - `live`     — at least one path still differs from HEAD. Real work; never drop.
  - `unknown`  — we could not prove either. Never drop (false positives are noise,
                 false negatives are data loss).

The tracked and untracked sides must be diffed against DIFFERENT commits: the
stash commit's tree holds only tracked content, while untracked files live in
`<sha>^3`. Diffing an untracked path against `<sha>` compares HEAD to a tree that
never contained it, which reports no difference and misreads live work as
subsumed — the data-loss path this replaces.

Previously this logic existed in three near-identical copies (orphan
classification, the per-merge sweep, and the liveness probe), all sharing that
bug. One authority, one behavior.
*/
async function classifyStashContent(rootDir: string, sha: string): Promise<"subsumed" | "live" | "unknown"> {
  const [tracked, untracked] = await Promise.all([
    listStashTrackedPaths(rootDir, sha),
    listStashUntrackedPaths(rootDir, sha),
  ]);
  // Unreadable side → cannot prove the stash is redundant.
  if (tracked === null || untracked === null) return "unknown";
  if (tracked.size === 0 && untracked.size === 0) return "subsumed";

  const differsFromHead = async (paths: Set<string>, against: string): Promise<boolean | null> => {
    if (paths.size === 0) return false;
    try {
      const pathsArg = [...paths].map(quoteArg).join(" ");
      const { stdout } = await execAsync(
        `git diff --name-only HEAD ${quoteArg(against)} -- ${pathsArg}`,
        { cwd: rootDir, encoding: "utf-8" },
      );
      return String(stdout).trim() !== "";
    } catch {
      return null;
    }
  };

  const trackedLive = await differsFromHead(tracked, sha);
  if (trackedLive === null) return "unknown";
  if (trackedLive) return "live";

  const untrackedLive = await differsFromHead(untracked, `${sha}^3`);
  if (untrackedLive === null) return "unknown";
  return untrackedLive ? "live" : "subsumed";
}

async function classifyAutostashOrphan(rootDir: string, sha: string): Promise<"subsumed" | "live" | "unknown"> {
  return classifyStashContent(rootDir, sha);
}

export async function listAutostashOrphans(rootDir: string): Promise<AutostashOrphanRecord[]> {
  const orphans = await listOrphanedAutostashes(rootDir);
  const records: AutostashOrphanRecord[] = [];
  for (const orphan of orphans) {
    const changedPaths = [...(await listStashChangedPaths(rootDir, orphan.sha))];
    records.push({
      sha: orphan.sha,
      ref: orphan.ref,
      label: orphan.label,
      sourceTaskId: parseAutostashTaskId(orphan.label),
      createdAt: parseAutostashCreatedAt(orphan.label),
      changedPaths,
      classification: await classifyAutostashOrphan(rootDir, orphan.sha),
      sourcePhase: parseAutostashSourcePhase(orphan.label),
      detectedByTaskId: null,
      detectedAt: null,
    });
  }
  return records;
}

export async function notifyAutostashOrphans(
  store: TaskStore,
  rootDir: string,
  options?: { detectedByTaskId?: string | null; detectedAt?: string },
): Promise<AutostashOrphanRecord[]> {
  const detectedAt = options?.detectedAt ?? new Date().toISOString();
  const records = (await listAutostashOrphans(rootDir)).map((record) => ({
    ...record,
    detectedByTaskId: options?.detectedByTaskId ?? null,
    detectedAt,
  }));
  store.emit("merger:autostashOrphans", { rootDir, records });
  return records;
}

export async function applyAutostashBySha(
  rootDir: string,
  sha: string,
): Promise<{ ok: true } | { ok: false; reason: string; stderr?: string }> {
  try {
    await execAsync(`git stash apply ${quoteArg(sha)}`, { cwd: rootDir, encoding: "utf-8" });
    return { ok: true };
  } catch (err: unknown) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String((err as { stderr?: string }).stderr ?? "") : "";
    const stdout = err && typeof err === "object" && "stdout" in err ? String((err as { stdout?: string }).stdout ?? "") : "";
    const message = err instanceof Error ? err.message : String(err);
    const details = `${stderr}\n${stdout}\n${message}`;
    if (/CONFLICT|could not apply|would be overwritten/i.test(details)) {
      return { ok: false, reason: "conflict", stderr: stderr || details };
    }
    return { ok: false, reason: "apply_failed", stderr: stderr || details };
  }
}

export async function getAutostashDiff(rootDir: string, sha: string): Promise<string> {
  const maxBytes = 64 * 1024;
  const { stdout } = await execAsync(`git stash show -p ${quoteArg(sha)}`, {
    cwd: rootDir,
    encoding: "utf-8",
    maxBuffer: 5 * 1024 * 1024,
  });
  const diff = String(stdout);
  if (Buffer.byteLength(diff, "utf-8") <= maxBytes) return diff;
  let truncated = diff;
  while (Buffer.byteLength(truncated, "utf-8") > maxBytes) {
    truncated = truncated.slice(0, Math.max(0, Math.floor(truncated.length * 0.9)));
  }
  return `${truncated}\n… (diff truncated)`;
}

/**
 * Stash any unrelated dirty changes in `rootDir` before a merge runs.
 *
 * The merger frequently issues `git reset --hard` / `git reset --merge` /
 * forced checkouts against `rootDir`. When `rootDir` happens to be the
 * developer's primary checkout (the common case for solo / single-host
 * setups), those resets discard any uncommitted dev edits in the working
 * tree — silently and without recourse. We've burned developer work this
 * way (FN-3329 retro): dashboard-tui edits were wiped mid-flight by an
 * unrelated FN-3329 merge.
 *
 * The fix: snapshot dirty state up-front using `git stash create` + `git
 * stash store` to capture a deterministic SHA *before* any working-tree
 * mutation, then apply it back after the merge finishes — success OR
 * failure — via a try/finally in `aiMergeTask`.
 *
 * Why create+store instead of `git stash push`: `push` returns no
 * machine-readable identifier and forces us to grep the stash list for our
 * label, which races against any other tool that stashes concurrently.
 * `create` returns the SHA atomically with snapshot creation, then `store`
 * registers it in the reflog under a recognizable label so it's protected
 * from GC and visible to humans via `git stash list`.
 *
 * Untracked files are captured by first staging them via `git add -A` so
 * `stash create` (which otherwise ignores untracked) sees them as part of
 * the index snapshot. The subsequent `git reset --hard` + `git clean -fd`
 * bring the working tree back to HEAD so the merge can proceed cleanly.
 *
 * Returns the stash handle (SHA + label) when a stash was created, or
 * `null` when the working tree was already clean. Best-effort: any failure
 * to stash logs and returns null — the merge still proceeds, but with the
 * old behavior. We do NOT want a stash failure to block the merge entirely
 * (that would be a strictly worse regression than the current state).
 */
/**
 * Inspect every leftover `fusion-merger-autostash:*` from prior runs. For
 * each, classify:
 *
 *  - **Subsumed** — `git diff HEAD <stashSha> -- <stashFiles>` produces no
 *    output, meaning every path in the stash is already byte-identical to
 *    HEAD. The dev's work either landed in HEAD via the merge itself or
 *    was committed independently; the stash is redundant. Drop it.
 *  - **Live** — at least one path still differs from HEAD. The stash is
 *    real lost work; warn loudly so the dev can recover it manually.
 *
 *  Without this sweep, every silent restore failure (apply hard-fails on
 *  untracked-overwrite, ref already gone, transient git error) leaves a
 *  permanent stash entry. They pile up indefinitely — we observed 50+
 *  orphans on a single working tree — and the warn-only behavior means
 *  developers stop reading the warnings entirely, defeating the safety
 *  net.
 */
async function sweepAutostashOrphans(
  rootDir: string,
  taskId: string,
  store: TaskStore,
): Promise<void> {
  let orphans: Array<{ sha: string; ref: string; label: string }> = [];
  try {
    orphans = await listOrphanedAutostashes(rootDir);
  } catch {
    return;
  }
  if (orphans.length === 0) return;

  const subsumed: Array<{ sha: string; ref: string; label: string }> = [];
  const live: Array<{ sha: string; ref: string; label: string }> = [];

  const droppedClosedTask: Array<{ sha: string; taskId: string; column: Task["column"] }> = [];

  for (const orphan of orphans) {
    try {
      /*
      FNXC:MergeAutostash 2026-07-15-13:20:
      Delegates to the shared drop-safety authority so tracked-only and
      untracked-only stashes are judged identically. `unknown` is treated as
      live: an unprovable stash is warned about, never dropped.
      */
      const classification = await classifyStashContent(rootDir, orphan.sha);
      if (classification === "subsumed") {
        subsumed.push(orphan);
        continue;
      }
      if (classification === "unknown") {
        live.push(orphan);
        continue;
      }

      const sourceTaskId = parseAutostashTaskId(orphan.label);
      if (!sourceTaskId) {
        live.push(orphan);
        continue;
      }

      let sourceTask: Task | null = null;
      try {
        sourceTask = await store.getTask(sourceTaskId);
      } catch {
        live.push(orphan);
        continue;
      }
      if (!sourceTask || (sourceTask.column !== "done" && sourceTask.column !== "archived")) {
        live.push(orphan);
        continue;
      }

      try {
        const { stdout: netDiffOut } = await execAsync(
          `git diff HEAD ${quoteArg(orphan.sha)}`,
          { cwd: rootDir, encoding: "utf-8" },
        );
        if (netDiffOut.trim() === "") {
          subsumed.push(orphan);
          droppedClosedTask.push({ sha: orphan.sha, taskId: sourceTaskId, column: sourceTask.column });
          continue;
        }
      } catch {
        live.push(orphan);
        continue;
      }

      live.push(orphan);
    } catch {
      // If we can't classify, treat as live — better to leave a real stash
      // sitting around than to drop one that still contains lost work.
      live.push(orphan);
    }
  }

  for (const orphan of subsumed) {
    await dropAutostashBySha(rootDir, taskId, orphan.sha);
    const closedTaskDrop = droppedClosedTask.find((entry) => entry.sha === orphan.sha);
    if (closedTaskDrop) {
      mergerLog.log(
        `${taskId}: dropped closed-task autostash ${orphan.sha.slice(0, 7)} (task ${closedTaskDrop.taskId} is ${closedTaskDrop.column})`,
      );
      continue;
    }
    mergerLog.log(
      `${taskId}: dropped subsumed autostash ${orphan.sha.slice(0, 7)} (${orphan.label}) — content already present on HEAD`,
    );
  }

  if (subsumed.length > 0) {
    await store
      .logEntry(
        taskId,
        `Cleaned up ${subsumed.length} subsumed autostash orphan(s) — their content already on HEAD`,
        subsumed.map((o) => `${o.ref}@${o.sha.slice(0, 7)} (${o.label})`).join("\n"),
      )
      .catch(() => undefined);
  }

  if (live.length > 0) {
    const refs = live.map((o) => `${o.ref}@${o.sha.slice(0, 7)}`).join(", ");
    mergerLog.warn(
      `${taskId}: ${live.length} live fusion-merger-autostash entry(ies) in stash list (${refs}) — uncommitted dev changes from prior merges whose restore failed. Recover with: cd ${rootDir} && git stash list && git stash apply <sha>`,
    );
    await store
      .logEntry(
        taskId,
        `${live.length} autostash orphan(s) still hold uncommitted dev work — recover manually`,
        live
          .map(
            (o) =>
              `${o.ref}@${o.sha.slice(0, 7)} (${o.label})\n  recover: git stash apply ${o.sha}`,
          )
          .join("\n\n"),
      )
      .catch(() => undefined);
  }

  await notifyAutostashOrphans(store, rootDir, { detectedByTaskId: taskId }).catch(() => undefined);
}

export async function sweepStaleAutostashes(
  rootDir: string,
  options: { maxAgeMs: number; taskStore?: TaskStore },
): Promise<{ dropped: number }> {
  try {
    void options.taskStore;
    const now = Date.now();
    const threshold = Math.max(0, Math.trunc(options.maxAgeMs));
    const entries = await listOrphanedAutostashes(rootDir);
    let dropped = 0;

    /*
    FNXC:MergeAutostash 2026-07-15-13:20:
    Age-based dropping is deliberate bounded retention, not a safety gap: it is
    the backstop that stops autostashes accumulating forever when a restore
    failed and nobody recovered the work. It intentionally drops by timestamp
    alone, without consulting stash content — do not add a liveness check here.
    Entries carrying a timestamp (every canonical label) age out; the legacy
    `fusion-ai-merge-sync-<id>` labels carry none, so they are reachable only via
    the subsumed check in `sweepAutostashOrphans`.
    */
    for (const entry of entries) {
      const match = AUTOSTASH_TIMESTAMP_RE.exec(entry.label.trim());
      if (!match) continue;
      const ts = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isFinite(ts)) continue;
      if (now - ts <= threshold) continue;
      const sourceTaskId = parseAutostashTaskId(entry.label) ?? "autostash-sweep";
      const result = await dropAutostashBySha(rootDir, sourceTaskId, entry.sha);
      if (result.dropped) dropped += 1;
    }

    const hours = Math.max(1, Math.round(threshold / 3_600_000));
    mergerLog.log(`startup-sweep: dropped ${dropped} stale fusion-merger-autostash entries older than ${hours}h`);
    return { dropped };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`startup-sweep: stale autostash sweep failed (${msg})`);
    return { dropped: 0 };
  }
}

export type { AutostashOrphanRecord };

export const __test__ = {
  sweepAutostashOrphans,
  parseAutostashTaskId,
  dropAutostashHandle,
  isAutostashLive,
  sweepStaleAutostashes,
  listAutostashOrphans,
  applyAutostashBySha,
  getAutostashDiff,
  notifyAutostashOrphans,
  runMergeAdvanceAutoSync,
};

export async function stashUnrelatedRootDirChanges(
  rootDir: string,
  taskId: string,
): Promise<AutostashHandle | null> {
  try {
    const dirty = await snapshotDirtyFiles(rootDir);
    if (dirty.size === 0) return null;

    const label = `${AUTOSTASH_LABEL_PREFIX}${taskId}:${Date.now()}`;

    // Stage everything so `git stash create` captures untracked files too.
    // `stash create` only includes index + tracked working-tree changes by
    // default; `git add -A` stages untracked under .gitignore rules.
    await execAsync("git add -A", { cwd: rootDir });

    // Atomically snapshot working state into a commit object. SHA is
    // deterministic the moment this returns — no list-grep race.
    const { stdout: createOut } = await execAsync("git stash create", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const sha = String(createOut).trim();
    if (!sha) {
      // No-op snapshot (shouldn't happen given the dirty check above, but
      // bail safely and unstage what we just staged).
      await execAsync("git reset", { cwd: rootDir }).catch(() => undefined);
      return null;
    }

    // Persist into the stash reflog so the SHA is reachable and humans see
    // it in `git stash list`. Without store, the SHA would be GC-eligible.
    await execAsync(
      `git stash store -m ${quoteArg(label)} ${sha}`,
      { cwd: rootDir },
    );

    // Race-rescue: re-snapshot AFTER the stash is persisted but BEFORE the
    // destructive `git reset --hard` below. If any new dirty paths showed up
    // between our initial `git add -A` and now — concurrent dev edits, a
    // parallel merger run interleaving its own ops, or test/build artifacts
    // landing late — capture ONLY those new paths in a separate rescue stash
    // so they survive the wipe.
    //
    // Subtlety: `git add -A && git stash create` does NOT clean the working
    // tree. Files stay dirty post-stash. So a naive "snapshot dirty again"
    // sees the SAME files as the primary stash and produces duplicate rescues
    // every run. We instead diff the post-stash dirty set against the SET OF
    // PATHS ALREADY CAPTURED BY THE PRIMARY STASH and only rescue paths that
    // were not in the primary — those are the genuine late-dirty writes.
    const primaryStashPaths = await listStashChangedPaths(rootDir, sha);
    const rescueShas: { sha: string; label: string }[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const currentDirty = await snapshotDirtyFiles(rootDir);
      const newlyDirty = [...currentDirty].filter((p) => !primaryStashPaths.has(p));
      if (newlyDirty.length === 0) break;
      const rescueLabel = `${AUTOSTASH_LABEL_PREFIX}${taskId}:race-rescue-${attempt}:${Date.now()}`;
      // Unstage before re-adding: `git stash create` snapshots the index
      // but does NOT clear it, so a second iteration's `git add -A` would
      // re-stage atop iteration-1 leftovers and produce a tree that
      // differs from current dirt for stale-staging reasons rather than
      // genuine new writes. The upcoming `git reset --hard HEAD` clears
      // it eventually, but inside this loop we want a clean baseline.
      await execAsync("git reset", { cwd: rootDir }).catch(() => undefined);
      await execAsync("git add -A", { cwd: rootDir });
      const { stdout: rescueOut } = await execAsync("git stash create", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const rescueSha = String(rescueOut).trim();
      if (!rescueSha) break;
      // Defensive check: if `git stash create` produced an SHA whose tree
      // exactly matches the primary stash, drop it — same race that motivates
      // the path-set check above can land us with an identical SHA when the
      // working tree didn't change between primary and rescue (e.g. git's own
      // internal index dedup). Don't pollute the stash list.
      const rescueTreeSame = await stashTreesEqual(rootDir, sha, rescueSha);
      if (rescueTreeSame) break;
      await execAsync(
        `git stash store -m ${quoteArg(rescueLabel)} ${rescueSha}`,
        { cwd: rootDir },
      );
      rescueShas.push({ sha: rescueSha, label: rescueLabel });
      mergerLog.warn(
        `${taskId}: race-rescue stash ${rescueSha.slice(0, 7)} captured ${newlyDirty.length} late-dirty path(s) not in primary stash (${rescueLabel}) — recover with: cd ${rootDir} && git stash apply ${rescueSha}`,
      );
      // Track them in primaryStashPaths so subsequent loop iterations don't
      // re-rescue the same set if writes are still landing.
      for (const p of newlyDirty) primaryStashPaths.add(p);
    }

    // Bring working tree back to HEAD so the merge can proceed. Reset
    // un-stages everything we just staged AND drops tracked-file
    // modifications. `git clean -fd` removes any untracked files / dirs
    // that survived (gitignored ones stay because we didn't pass -x).
    await execAsync("git reset --hard HEAD", { cwd: rootDir });
    await execAsync("git clean -fd", { cwd: rootDir });

    const rescueSuffix = rescueShas.length > 0
      ? ` + ${rescueShas.length} race-rescue stash(es): ${rescueShas.map((r) => r.sha.slice(0, 7)).join(", ")}`
      : "";
    mergerLog.log(
      `${taskId}: stashed ${dirty.size} unrelated dirty path(s) in rootDir as ${sha.slice(0, 7)} (${label})${rescueSuffix}`,
    );
    return rescueShas.length > 0 ? { sha, label, rescueShas } : { sha, label };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Best-effort: unstage anything `git add -A` may have staged before the
    // failure, so the working tree is at least back to a sane state.
    try {
      await execAsync("git reset", { cwd: rootDir });
    } catch {
      // Nothing more we can do.
    }
    // Refuse to proceed: the merge flow will issue `git reset --hard` and
    // forced checkouts that would wipe the dirty edits we just failed to
    // stash. Better to fail the merge loudly than to silently destroy work.
    mergerLog.warn(
      `${taskId}: pre-merge autostash failed (${msg}) — refusing to run destructive merge ops over a dirty tree`,
    );
    throw new AutostashCreationFailedError(msg, rootDir);
  }
}

/** Thrown when pre-merge autostash cannot capture a dirty working tree.
 *  The merger catches this and bails before any destructive op runs. */
export class AutostashCreationFailedError extends Error {
  readonly rootDir: string;
  constructor(reason: string, rootDir: string) {
    super(`pre-merge autostash failed: ${reason}`);
    this.name = "AutostashCreationFailedError";
    this.rootDir = rootDir;
  }
}

/** Resolve the autostash SHA back to its current `stash@{N}` ref so we can
 *  drop it. Stash positions shift when other stashes are pushed, so we
 *  can't cache the original ref. Returns null if the stash is no longer
 *  in the reflog (already dropped). */
async function findStashRefBySha(rootDir: string, sha: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `git stash list --format="%H %gd"`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    for (const line of String(stdout).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [entrySha, ref] = trimmed.split(/\s+/);
      if (entrySha === sha && ref) return ref;
    }
    return null;
  } catch {
    return null;
  }
}

/** Drop an autostash by SHA, defending against the TOCTOU race where another
 *  process pushes a stash between our `findStashRefBySha` and the actual
 *  `git stash drop stash@{N}` (drop only takes positional refs, so the index
 *  is what git uses — not our SHA). Without this guard we silently drop
 *  someone else's stash while leaving ours behind, and the task log lies
 *  about a clean restore.
 *
 *  Strategy: re-resolve ref → SHA, verify the ref still points at our SHA
 *  with `git rev-parse`, then drop. If the SHA at the ref drifted (race),
 *  retry up to 5x. Returns whether the drop landed cleanly so callers can
 *  surface failure to the task feed. */
export async function dropAutostashBySha(
  rootDir: string,
  taskId: string,
  sha: string,
): Promise<{ dropped: boolean; reason?: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await findStashRefBySha(rootDir, sha);
    if (!ref) {
      mergerLog.log(`${taskId}: autostash ${sha.slice(0, 7)} no longer in stash list (already dropped)`);
      return { dropped: true };
    }

    // Defend against the index-shift race: confirm the ref still resolves to
    // our SHA before dropping. If another process pushed a stash, ref now
    // points at theirs — back off and re-resolve.
    let refSha = "";
    try {
      const { stdout } = await execAsync(`git rev-parse ${ref}`, { cwd: rootDir, encoding: "utf-8" });
      refSha = String(stdout).trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: rev-parse ${ref} failed (${msg}) on drop attempt ${attempt + 1} — retrying`);
      continue;
    }
    if (refSha !== sha) {
      mergerLog.log(`${taskId}: autostash ${sha.slice(0, 7)} shifted off ${ref} (now ${refSha.slice(0, 7)}); re-resolving`);
      continue;
    }

    try {
      await execAsync(`git stash drop ${ref}`, { cwd: rootDir });
      return { dropped: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Final attempt: surface the failure. Earlier attempts get retried.
      if (attempt === 4) {
        mergerLog.warn(`${taskId}: failed to drop autostash ${ref} after ${attempt + 1} attempts (${msg}) — stash will linger in stash list`);
        return { dropped: false, reason: msg };
      }
      mergerLog.warn(`${taskId}: drop ${ref} attempt ${attempt + 1} failed (${msg}) — retrying`);
    }
  }
  return { dropped: false, reason: "exhausted retry attempts" };
}

/** True when the stash still holds work not present on HEAD. An unprovable
 *  (`unknown`) stash counts as live so callers never discard it. */
async function isAutostashLive(rootDir: string, sha: string): Promise<boolean> {
  try {
    return (await classifyStashContent(rootDir, sha)) !== "subsumed";
  } catch {
    return true;
  }
}

export async function dropAutostashHandle(
  rootDir: string,
  taskId: string,
  handle: AutostashHandle,
  options: {
    keepIfLive: boolean;
    store?: TaskStore;
    context?: string;
  },
): Promise<{ dropped: number; keptLive: number; failed: number }> {
  const entries = [
    { sha: handle.sha, label: handle.label, kind: "primary" as const },
    ...(handle.rescueShas ?? []).map((r) => ({ sha: r.sha, label: r.label, kind: "race-rescue" as const })),
  ];

  let dropped = 0;
  let keptLive = 0;
  let failed = 0;

  for (const entry of entries) {
    if (options.keepIfLive) {
      const live = await isAutostashLive(rootDir, entry.sha);
      if (live) {
        keptLive += 1;
        mergerLog.warn(`${taskId}: preserving live ${entry.kind} autostash ${entry.sha.slice(0, 7)} (${entry.label})`);
        continue;
      }
    }

    const dropResult = await dropAutostashBySha(rootDir, taskId, entry.sha);
    if (dropResult.dropped) {
      dropped += 1;
      mergerLog.log(`${taskId}: dropped ${entry.kind} autostash ${entry.sha.slice(0, 7)} (${entry.label})`);
    } else {
      failed += 1;
      mergerLog.warn(
        `${taskId}: failed to drop ${entry.kind} autostash ${entry.sha.slice(0, 7)} (${entry.label}) — ${dropResult.reason ?? "unknown"}`,
      );
    }
  }

  if (options.store && options.context) {
    await options.store.logEntry(
      taskId,
      `${options.context}: autostash cleanup dropped ${dropped}, preserved ${keptLive} live, failed ${failed}`,
      entries.map((entry) => `${entry.kind} ${entry.sha.slice(0, 7)} (${entry.label})`).join("\n"),
    ).catch(() => undefined);
  }

  return { dropped, keptLive, failed };
}

/**
 * AI fix-agent for autostash apply conflicts. Spawned only when applying
 * the stashed dev work hits a conflict — the merge has already committed
 * cleanly, so this agent's job is narrow: edit the working-tree files in
 * place to remove conflict markers, picking the right combination of the
 * developer's pre-merge edits and the just-committed merge content. It
 * does NOT commit anything; the resolved files stay uncommitted (matching
 * the developer's pre-merge state).
 *
 * Mirrors the in-merge fix-agent pattern at the top of this file
 * (createResolvedAgentSession with sessionPurpose: "merger") so we reuse
 * skill selection, fallback models, rate-limit retry, and audit logging.
 *
 * Returns true on success (conflict markers gone, files staged-or-not as
 * the agent decided). On failure or abort, returns false and the caller
 * leaves the stash in place for manual recovery.
 */
async function runAiAgentForAutostashConflict(params: {
  store: TaskStore;
  rootDir: string;
  taskId: string;
  conflictedFiles: string[];
  options: MergerOptions;
  settings: Settings;
}): Promise<{ success: boolean; error?: string }> {
  const { store, rootDir, taskId, conflictedFiles, options, settings } = params;

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
    persistAgentToolOutput: settings.persistAgentToolOutput,
    // Merger agents are task-scoped ephemeral workers.
    persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
    onAgentText: options.onAgentText
      ? (_id: string, delta: string) => options.onAgentText!(delta)
      : undefined,
    onAgentTool: options.onAgentTool
      ? (_id: string, name: string) => options.onAgentTool!(name)
      : undefined,
  });

  // Skill / runtime resolution mirrors runAiAgentForCommit.
  let taskForSkillContext: Awaited<ReturnType<typeof store.getTask>> | null = null;
  let skillContext = undefined;
  if (options.agentStore) {
    try {
      taskForSkillContext = await store.getTask(taskId);
      skillContext = await buildSessionSkillContext({
        agentStore: options.agentStore,
        task: taskForSkillContext,
        sessionPurpose: "merger",
        projectRootDir: rootDir,
        pluginRunner: options.pluginRunner,
      });
    } catch {
      // Graceful fallback.
    }
  }
  const assignedAgentId = taskForSkillContext?.assignedAgentId?.trim();
  const agentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
    ? options.agentStore
    : null;
  const assignedAgent = assignedAgentId && agentStoreWithGetAgent
    ? await agentStoreWithGetAgent.getAgent(assignedAgentId).catch(() => null)
    : null;
  const mergerRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);
  const mergerSessionModel = resolveMergerSessionModel(settings, assignedAgent?.runtimeConfig);

  // FNXC:Settings-MergerModel 2026-07-16-00:00: merger retries use the dedicated project fallback lane before the shared global fallback pair.

  const mergerFallbackModel = resolveMergerFallbackModel(settings);

  const systemPrompt = `You are an autostash-conflict resolution agent running after a Fusion merge has already committed on the main branch.

Before the merge ran, the developer had uncommitted local changes in their working tree. The merger snapshotted those changes into a git stash, ran the merge cleanly, and is now reapplying the stash on top of the merged HEAD. The reapply hit conflicts because the merge committed changes that overlap the developer's stashed edits.

## Your job
Edit the conflicted files in place to remove every conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) and produce a coherent merged result that:
- Preserves the developer's intended uncommitted changes (the "Updated upstream" / branch-side, depending on which side the stash pop wrote)
- Layers them onto the merged HEAD content (the other side)

## Rules
1. Read each conflicted file carefully before editing
2. Resolve every conflict marker — none may remain after you finish
3. Do NOT make any git commits. Do NOT run \`git add\` or \`git stash drop\`. Just edit the files.
4. Do NOT touch files that are not in the conflicted-files list
5. If you genuinely cannot determine the right resolution for a hunk, prefer the developer's stashed edits (their work is the unsaved context) and add a brief \`// TODO(autostash-conflict)\` comment so they can review

The orchestrator will verify post-run that no conflict markers remain. If any do, this attempt is treated as a failure and the stash is left intact for manual recovery.`;

  const fileList = conflictedFiles.map((f) => `- ${f}`).join("\n");
  const prompt = `Resolve autostash apply conflicts for task ${taskId}.

## Conflicted files
${fileList}

## Steps
1. For each file above, read its current contents (it has conflict markers from the failed \`git stash apply\`)
2. Edit it to a clean state with no conflict markers — preserving the developer's intended changes layered on top of the merged HEAD
3. After all files are clean, you are done. Do NOT commit or run git stash commands.`;

  mergerLog.log(`${taskId}: starting autostash-conflict resolution agent (${conflictedFiles.length} file(s))`);

  const { session } = await createResolvedAgentSession({
    sessionPurpose: "merger",
    runtimeHint: mergerRuntimeHint,
    pluginRunner: options.pluginRunner,
    cwd: rootDir,
    systemPrompt,
    tools: "coding",
    onText: agentLogger.onText,
    onThinking: agentLogger.onThinking,
    onToolStart: agentLogger.onToolStart,
    onToolEnd: agentLogger.onToolEnd,
    defaultProvider: mergerSessionModel.provider,
    defaultModelId: mergerSessionModel.modelId,
    fallbackProvider: mergerFallbackModel.provider,
    fallbackModelId: mergerFallbackModel.modelId,
    fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings),
    defaultThinkingLevel: resolveMergerThinkingLevel(settings),
    runAuditor: createRunAuditor(store, {
      runId: generateSyntheticRunId("merge", taskId),
      agentId: "merger",
      taskId,
      phase: "merge",
      source: "merger",
    }),
    settings,
    mcpServers: await resolveMergerMcpServers(store, assignedAgent?.id),
    // FNXC:PluginSkills 2026-07-12-00:00: Autostash conflict sessions must preserve plugin skill body dirs from the shared skill context.
    ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    ...(skillContext && skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
    taskId,
    taskTitle: taskForSkillContext?.title,
    onFallbackModelUsed: createFallbackModelObserver({
      agent: "merger",
      label: "autostash conflict agent",
      store,
      taskId,
      taskTitle: taskForSkillContext?.title,
    }),
  });
  options.onSession?.(session);

  try {
    await store.appendAgentLog(
      taskId,
      `Autostash conflict agent started (model: ${describeModel(session)}, files: ${conflictedFiles.length})`,
      "status",
      undefined,
      "merger",
    );

    await withRateLimitRetry(async () => {
      throwIfAborted(options.signal, taskId);
      await promptWithFallback(session, prompt);
      checkSessionError(session);
    }, {
      onRetry: (attempt, delayMs, error) => {
        const delaySec = Math.round(delayMs / 1000);
        mergerLog.warn(`⏳ ${taskId} autostash-conflict agent rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
      },
      signal: options.signal,
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: autostash-conflict agent error: ${msg}`);
    await store.logEntry(taskId, "Autostash conflict agent encountered an error", msg);
    return { success: false, error: msg };
  } finally {
    try {
      await agentLogger.flush();
    } catch {
      // ignore
    }
    try {
      session.dispose();
    } catch {
      // ignore
    }
  }
}

/** Verify no conflict markers remain in any of the listed files. Returns
 *  the subset that still has markers (empty = all clean). */
async function findFilesWithConflictMarkers(rootDir: string, files: string[]): Promise<string[]> {
  const stillConflicted: string[] = [];
  for (const file of files) {
    try {
      const fullPath = join(rootDir, file);
      if (!existsSync(fullPath)) continue;
      const { stdout } = await execAsync(
        `git grep -l -e "^<<<<<<< " -e "^=======$" -e "^>>>>>>> " --no-index -- ${quoteArg(fullPath)}`,
        { cwd: rootDir, encoding: "utf-8" },
      ).catch(() => ({ stdout: "" }));
      if (String(stdout).trim()) stillConflicted.push(file);
    } catch {
      // best-effort
    }
  }
  return stillConflicted;
}

/**
 * Recovery path for the hard-fail branch of `git stash apply`: the stash
 * couldn't even start applying (typical causes: untracked-overwrite, the
 * stash mentions a path that no longer exists at HEAD, or an index conflict
 * where git refuses to write any markers). The working tree has no conflict
 * markers because nothing was applied.
 *
 * Layered fallback:
 *   1. Pull the stash patch via `git stash show -p <sha>` and try
 *      `git apply --3way` against the working tree. This is more permissive
 *      than `stash apply` for several common failure shapes (especially
 *      untracked overwrites: --3way can produce conflict markers we can
 *      then resolve, where stash apply just refuses).
 *   2. If --3way left conflict markers: route to the existing AI conflict
 *      resolver.
 *   3. If --3way also hard-failed and smart conflict resolution is enabled:
 *      spawn an AI agent armed with the patch + error context, ask it to
 *      reconstruct the developer's edits on top of HEAD by editing files
 *      directly.
 *
 * Returns the appropriate AutostashOutcome. If recovery succeeds, the stash
 * is dropped (since its content is now applied to the working tree). If
 * recovery fails, the stash is left intact for manual recovery.
 */
async function tryRecoverHardFailApply(params: {
  rootDir: string;
  taskId: string;
  sha: string;
  applyErrorMsg: string;
  applyStderr: string;
  ctx: {
    store: TaskStore;
    options: MergerOptions;
    settings: Settings;
  };
}): Promise<AutostashOutcome> {
  const { rootDir, taskId, sha, applyErrorMsg, applyStderr, ctx } = params;
  const stashFiles = [...await listStashChangedPaths(rootDir, sha)];
  const smartConflictResolution = isSmartConflictResolutionEnabled(ctx.settings);

  // Step 1: try `git apply --3way`. This pulls the diff out of the stash and
  // applies it as a regular patch with three-way merging, which behaves
  // better than `stash apply` in several common hard-fail shapes.
  let threeWayConflicted: string[] = [];
  let threeWayApplied = false;
  try {
    // Get the patch text from the stash.
    const { stdout: patchOut } = await execAsync(
      `git stash show -p --binary ${sha}`,
      { cwd: rootDir, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
    const patchText = String(patchOut);
    if (!patchText.trim()) {
      // Nothing to apply — stash was empty or show failed.
      mergerLog.warn(`${taskId}: autostash ${sha.slice(0, 7)} produced empty patch; cannot 3-way recover`);
    } else {
      // Pipe the patch into `git apply --3way` via stdin.
      const patchPath = join(rootDir, ".git", `fusion-autostash-${sha.slice(0, 7)}.patch`);
      writeFileSync(patchPath, patchText, "utf-8");
      try {
        await execAsync(`git apply --3way --whitespace=nowarn ${quoteArg(patchPath)}`, { cwd: rootDir });
        threeWayApplied = true;
        mergerLog.log(`${taskId}: autostash ${sha.slice(0, 7)} recovered via git apply --3way`);
      } catch (threeWayErr: unknown) {
        const conflicted = await getConflictedFiles(rootDir);
        if (conflicted.length > 0) {
          threeWayConflicted = conflicted;
          mergerLog.log(`${taskId}: 3-way produced ${conflicted.length} conflict file(s) — handing to AI resolver`);
        } else {
          const tweMsg = threeWayErr instanceof Error ? threeWayErr.message : String(threeWayErr);
          mergerLog.warn(`${taskId}: 3-way apply also failed (${tweMsg}); falling through to AI patch recovery`);
        }
      } finally {
        try { unlinkSync(patchPath); } catch { /* ignore */ }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: failed to extract patch from stash ${sha.slice(0, 7)} (${msg})`);
  }

  // 3-way produced a clean working tree → drop stash and report restored.
  if (threeWayApplied) {
    const dropResult = await dropAutostashBySha(rootDir, taskId, sha);
    await ctx.store.logEntry(
      taskId,
      `Autostash apply hit hard failure but recovered via git apply --3way (stash ${sha.slice(0, 7)})`,
      `Original error: ${applyErrorMsg}\n${applyStderr ? `\nGit stderr:\n${applyStderr}\n` : ""}${dropResult.dropped ? "" : `\nStash drop failed (${dropResult.reason ?? "unknown"}); clean up manually.`}`,
    ).catch(() => undefined);
    return { status: "restored", stashSha: sha };
  }

  // 3-way produced conflict markers → existing AI conflict resolver handles it.
  if (threeWayConflicted.length > 0) {
    const task = await ctx.store.getTask(taskId);
    const partitioned = await applyLayer3ConflictScopePartition({
      store: ctx.store,
      task,
      taskId,
      rootDir,
      branch: resolveTaskWorkingBranch(task),
      mergeTargetBranch: task.baseBranch || "main",
      conflictFiles: threeWayConflicted,
      auditor: undefined,
    });
    const aiConflictedFiles = partitioned.inScopeConflicts;

    if (!smartConflictResolution) {
      const message = `Autostash 3-way produced conflict markers in ${aiConflictedFiles.length} file(s) and smartConflictResolution is disabled. Stash ${sha.slice(0, 7)} left intact.`;
      await ctx.store.logEntry(
        taskId,
        `Autostash 3-way left conflict markers — manual resolution required (smart resolution disabled)`,
        message,
      ).catch(() => undefined);
      return { status: "conflict-needs-manual", stashSha: sha, conflictedFiles: aiConflictedFiles, message };
    }

    if (aiConflictedFiles.length === 0) {
      const dropResult = await dropAutostashBySha(rootDir, taskId, sha);
      await ctx.store.logEntry(
        taskId,
        "Autostash hard-fail recovered via 3-way scope partition (no in-scope conflicts remained)",
        `${dropResult.dropped ? "" : `Stash drop failed (${dropResult.reason ?? "unknown"}); clean up manually.`}`,
      ).catch(() => undefined);
      return { status: "ai-resolved", stashSha: sha, conflictedFiles: [] };
    }

    await ctx.store.logEntry(
      taskId,
      `Autostash 3-way left conflicts in ${aiConflictedFiles.length} file(s) — invoking AI to resolve`,
      aiConflictedFiles.join("\n"),
    ).catch(() => undefined);

    const aiResult = await runAiAgentForAutostashConflict({
      store: ctx.store,
      rootDir,
      taskId,
      conflictedFiles: aiConflictedFiles,
      options: ctx.options,
      settings: ctx.settings,
    });

    const stillConflicted = aiResult.success
      ? await findFilesWithConflictMarkers(rootDir, aiConflictedFiles)
      : aiConflictedFiles;

    if (aiResult.success && stillConflicted.length === 0) {
      const dropResult = await dropAutostashBySha(rootDir, taskId, sha);
      await ctx.store.logEntry(
        taskId,
        `Autostash hard-fail recovered via 3-way + AI conflict resolution (${aiConflictedFiles.length} file(s))`,
        `Resolved files:\n${aiConflictedFiles.join("\n")}${dropResult.dropped ? "" : `\n\nStash drop failed (${dropResult.reason ?? "unknown"}); clean up manually.`}`,
      ).catch(() => undefined);
      return { status: "ai-resolved", stashSha: sha, conflictedFiles: aiConflictedFiles };
    }

    const failureMsg = `3-way+AI resolution incomplete; markers remain in ${stillConflicted.join(", ") || "(unknown)"}. Stash ${sha.slice(0, 7)} left intact.`;
    await ctx.store.logEntry(taskId, `Autostash 3-way+AI resolution failed`, failureMsg).catch(() => undefined);
    return { status: "conflict-needs-manual", stashSha: sha, conflictedFiles: stillConflicted, message: failureMsg };
  }

  // Step 3: 3-way also hard-failed. AI patch recovery if enabled.
  if (!smartConflictResolution || stashFiles.length === 0) {
    const message = `Autostash apply hard-failed (${applyErrorMsg})${applyStderr ? `; git stderr: ${applyStderr}` : ""}. Stash ${sha.slice(0, 7)} left intact.`;
    mergerLog.warn(`${taskId}: ${message}`);
    await ctx.store.logEntry(
      taskId,
      `Autostash apply failed — stash ${sha.slice(0, 7)} left intact for manual recovery`,
      `${applyErrorMsg}${applyStderr ? `\n\nGit stderr:\n${applyStderr}` : ""}\n\nRecover with:\n  cd ${rootDir} && git stash apply ${sha}`,
    ).catch(() => undefined);
    return { status: "failed", stashSha: sha, errorMessage: applyErrorMsg };
  }

  await ctx.store.logEntry(
    taskId,
    `Autostash apply hard-failed — invoking AI patch-recovery agent (${stashFiles.length} file(s))`,
    `${applyErrorMsg}${applyStderr ? `\n\nGit stderr:\n${applyStderr}` : ""}\n\nFiles in stash:\n${stashFiles.join("\n")}`,
  ).catch(() => undefined);

  const patchAiResult = await runAiAgentForAutostashHardFail({
    store: ctx.store,
    rootDir,
    taskId,
    stashSha: sha,
    stashFiles,
    applyErrorMsg,
    applyStderr,
    options: ctx.options,
    settings: ctx.settings,
  });

  if (!patchAiResult.success) {
    const failMsg = `AI patch-recovery failed (${patchAiResult.error ?? "unknown"}). Stash ${sha.slice(0, 7)} left intact.`;
    await ctx.store.logEntry(taskId, `Autostash AI patch-recovery failed`, failMsg).catch(() => undefined);
    return { status: "failed", stashSha: sha, errorMessage: failMsg };
  }

  // Verify any remaining conflict markers — agent may have left some.
  const remainingMarkers = await findFilesWithConflictMarkers(rootDir, stashFiles);
  if (remainingMarkers.length > 0) {
    const failMsg = `AI patch-recovery left conflict markers in: ${remainingMarkers.join(", ")}. Stash ${sha.slice(0, 7)} left intact.`;
    await ctx.store.logEntry(taskId, `AI patch-recovery incomplete — manual recovery required`, failMsg).catch(() => undefined);
    return { status: "conflict-needs-manual", stashSha: sha, conflictedFiles: remainingMarkers, message: failMsg };
  }

  const dropResult = await dropAutostashBySha(rootDir, taskId, sha);
  await ctx.store.logEntry(
    taskId,
    `Autostash hard-fail recovered by AI patch-recovery agent (${stashFiles.length} file(s))`,
    `Recovered files:\n${stashFiles.join("\n")}${dropResult.dropped ? "" : `\n\nStash drop failed (${dropResult.reason ?? "unknown"}); clean up manually.`}`,
  ).catch(() => undefined);
  return { status: "ai-resolved", stashSha: sha, conflictedFiles: stashFiles };
}

/**
 * AI agent for autostash apply HARD failures (no conflict markers, nothing
 * applied). Receives the stash patch + git stderr and reconstructs the
 * developer's edits on top of HEAD by editing files directly. Mirrors
 * `runAiAgentForAutostashConflict` but with a different prompt because
 * there are no in-tree conflict markers to resolve — the agent has to
 * re-apply changes from the patch by hand.
 */
async function runAiAgentForAutostashHardFail(params: {
  store: TaskStore;
  rootDir: string;
  taskId: string;
  stashSha: string;
  stashFiles: string[];
  applyErrorMsg: string;
  applyStderr: string;
  options: MergerOptions;
  settings: Settings;
}): Promise<{ success: boolean; error?: string }> {
  const { store, rootDir, taskId, stashSha, stashFiles, applyErrorMsg, applyStderr, options, settings } = params;

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
    persistAgentToolOutput: settings.persistAgentToolOutput,
    // Merger agents are task-scoped ephemeral workers.
    persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
    onAgentText: options.onAgentText
      ? (_id: string, delta: string) => options.onAgentText!(delta)
      : undefined,
    onAgentTool: options.onAgentTool
      ? (_id: string, name: string) => options.onAgentTool!(name)
      : undefined,
  });

  let taskForSkillContext: Awaited<ReturnType<typeof store.getTask>> | null = null;
  let skillContext = undefined;
  if (options.agentStore) {
    try {
      taskForSkillContext = await store.getTask(taskId);
      skillContext = await buildSessionSkillContext({
        agentStore: options.agentStore,
        task: taskForSkillContext,
        sessionPurpose: "merger",
        projectRootDir: rootDir,
        pluginRunner: options.pluginRunner,
      });
    } catch {
      // graceful fallback
    }
  }
  const assignedAgentId = taskForSkillContext?.assignedAgentId?.trim();
  const agentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
    ? options.agentStore
    : null;
  const assignedAgent = assignedAgentId && agentStoreWithGetAgent
    ? await agentStoreWithGetAgent.getAgent(assignedAgentId).catch(() => null)
    : null;
  const mergerRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);
  const mergerSessionModel = resolveMergerSessionModel(settings, assignedAgent?.runtimeConfig);

  // FNXC:Settings-MergerModel 2026-07-16-00:00: merger retries use the dedicated project fallback lane before the shared global fallback pair.

  const mergerFallbackModel = resolveMergerFallbackModel(settings);

  const systemPrompt = `You are an autostash hard-failure recovery agent for the Fusion merger.

Before the merge ran, the developer had uncommitted local changes. We snapshotted them into a git stash, ran the merge cleanly on top, and tried to re-apply the stash. Both \`git stash apply\` and \`git apply --3way\` failed without producing conflict markers — meaning git refused to attempt the apply at all (typical causes: untracked-file overwrite, a path in the stash no longer exists at HEAD, or an index conflict that produced no in-tree markers).

## Your job
Reconstruct the developer's intended uncommitted changes on top of the current HEAD by editing files directly. The stash patch (sourced from \`git stash show -p ${stashSha}\`) is your authoritative source for what changed.

## Rules
1. Run \`git stash show -p ${stashSha}\` (or read it via your shell) to get the patch text. Read it carefully.
2. For each file in the patch, decide how to apply the developer's intent on top of HEAD's current contents:
   - If the file still exists at HEAD: apply the patch hunks, integrating with any merge changes that overlap.
   - If the file was deleted at HEAD: re-create it (the developer presumably wanted it) UNLESS the patch was deleting it too — in which case do nothing.
   - If the file is new (added by the patch): create it with the patch contents.
3. Do NOT make git commits. Do NOT run \`git add\` or \`git stash drop\`. Just edit files in the working tree.
4. Do NOT touch files outside the patch.
5. If a hunk's surrounding context no longer exists at HEAD (e.g., merge changed the function signature), make a reasonable best-effort placement and add a brief \`// TODO(autostash-recovery)\` comment so the developer can review.
6. NO conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) may remain in the working tree when you finish — those would block follow-up tooling.

The orchestrator will scan the working tree for conflict markers post-run; any remaining will be treated as a failed recovery.`;

  const fileList = stashFiles.map((f) => `- ${f}`).join("\n");
  const prompt = `Recover the developer's uncommitted changes for task ${taskId}.

## Original git error
${applyErrorMsg}
${applyStderr ? `\n## Git stderr\n\`\`\`\n${applyStderr}\n\`\`\`` : ""}

## Stash SHA (source of truth for the patch)
${stashSha}

## Files mentioned in the stash
${fileList}

## Steps
1. Run \`git stash show -p ${stashSha}\` to read the developer's intended changes
2. For each file, integrate those changes onto the current HEAD by editing the file directly
3. When done, NO conflict markers may remain in the working tree
4. Do NOT commit, do NOT touch the stash, do NOT modify files outside the list above`;

  mergerLog.log(`${taskId}: starting autostash hard-fail recovery agent (${stashFiles.length} file(s))`);

  const { session } = await createResolvedAgentSession({
    sessionPurpose: "merger",
    runtimeHint: mergerRuntimeHint,
    pluginRunner: options.pluginRunner,
    cwd: rootDir,
    systemPrompt,
    tools: "coding",
    onText: agentLogger.onText,
    onThinking: agentLogger.onThinking,
    onToolStart: agentLogger.onToolStart,
    onToolEnd: agentLogger.onToolEnd,
    defaultProvider: mergerSessionModel.provider,
    defaultModelId: mergerSessionModel.modelId,
    fallbackProvider: mergerFallbackModel.provider,
    fallbackModelId: mergerFallbackModel.modelId,
    fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings),
    defaultThinkingLevel: resolveMergerThinkingLevel(settings),
    runAuditor: createRunAuditor(store, {
      runId: generateSyntheticRunId("merge", taskId),
      agentId: "merger",
      taskId,
      phase: "merge",
      source: "merger",
    }),
    settings,
    mcpServers: await resolveMergerMcpServers(store, assignedAgent?.id),
    // FNXC:PluginSkills 2026-07-12-00:00: Autostash hard-fail recovery sessions keep plugin body discovery paths aligned with requested plugin skills.
    ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    ...(skillContext && skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
    taskId,
    taskTitle: taskForSkillContext?.title,
    onFallbackModelUsed: createFallbackModelObserver({
      agent: "merger",
      label: "autostash hard-fail recovery agent",
      store,
      taskId,
      taskTitle: taskForSkillContext?.title,
    }),
  });
  options.onSession?.(session);

  try {
    await store.appendAgentLog(
      taskId,
      `Autostash hard-fail recovery agent started (model: ${describeModel(session)}, files: ${stashFiles.length})`,
      "status",
      undefined,
      "merger",
    );

    await withRateLimitRetry(async () => {
      throwIfAborted(options.signal, taskId);
      await promptWithFallback(session, prompt);
      checkSessionError(session);
    }, {
      onRetry: (attempt, delayMs, error) => {
        const delaySec = Math.round(delayMs / 1000);
        mergerLog.warn(`⏳ ${taskId} autostash hard-fail agent rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
      },
      signal: options.signal,
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: autostash hard-fail agent error: ${msg}`);
    await store.logEntry(taskId, "Autostash hard-fail recovery agent encountered an error", msg);
    return { success: false, error: msg };
  } finally {
    try {
      await agentLogger.flush();
    } catch {
      // ignore
    }
    try {
      session.dispose();
    } catch {
      // ignore
    }
  }
}

/**
 * Restore the autostash created by `stashUnrelatedRootDirChanges` after a
 * merge completes. Best-effort: any failure logs a warning but does not
 * throw — by the time we reach the finally block the merge result has
 * already been recorded, and a stash failure should never mask or undo a
 * successful merge.
 *
 * Flow:
 *   1. `git stash apply <sha>` — does NOT auto-drop, so on conflict the
 *      stash stays put without us having to rely on pop's keep-on-fail
 *      behavior. SHA is used so the operation is robust to stash list
 *      reordering from concurrent tools.
 *   2. On clean apply: drop the stash by SHA, return `restored`.
 *   3. On apply conflict (working tree has conflict markers): if smart
 *      conflict resolution is enabled, spawn an AI fix-agent to resolve
 *      the markers in place; on success drop the stash and return
 *      `ai-resolved`. Otherwise return `conflict-needs-manual` and leave
 *      the stash for the developer to recover by hand.
 *   4. On apply HARD failure (no markers, nothing applied): try
 *      `git apply --3way` from the patch, fall through to AI patch-recovery
 *      if needed. See `tryRecoverHardFailApply`.
 */
async function restoreRescueAutostashes(
  rootDir: string,
  taskId: string,
  handle: AutostashHandle,
  ctx: {
    store: TaskStore;
  },
): Promise<{ unresolvedCount: number }> {
  const rescueShas = handle.rescueShas ?? [];
  if (rescueShas.length === 0) return { unresolvedCount: 0 };

  let unresolvedCount = 0;
  for (const rescue of rescueShas) {
    try {
      await execAsync(`git stash apply ${rescue.sha}`, { cwd: rootDir });
      const dropResult = await dropAutostashBySha(rootDir, taskId, rescue.sha);
      if (dropResult.dropped) {
        mergerLog.log(`${taskId}: restored and dropped race-rescue autostash ${rescue.sha.slice(0, 7)} (${rescue.label})`);
      } else {
        unresolvedCount += 1;
        mergerLog.warn(`${taskId}: restored race-rescue autostash ${rescue.sha.slice(0, 7)} but drop failed (${dropResult.reason ?? "unknown"})`);
      }
    } catch (err: unknown) {
      unresolvedCount += 1;
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: race-rescue autostash apply failed for ${rescue.sha.slice(0, 7)} (${msg}); preserving stash for manual recovery`);
    }
  }

  await ctx.store.logEntry(
    taskId,
    `Race-rescue autostash restore attempted: ${rescueShas.length - unresolvedCount} restored, ${unresolvedCount} preserved`,
    rescueShas.map((r) => `${r.sha.slice(0, 7)} (${r.label})`).join("\n"),
  ).catch(() => undefined);

  return { unresolvedCount };
}

export async function restoreUnrelatedRootDirChanges(
  rootDir: string,
  taskId: string,
  handle: AutostashHandle,
  ctx: {
    store: TaskStore;
    options: MergerOptions;
    settings: Settings;
  },
): Promise<AutostashOutcome> {
  const { sha } = handle;

  // Use apply (not pop) so a conflict doesn't leave us in an ambiguous
  // half-popped state — apply never auto-drops, so the stash is always
  // recoverable under any failure mode.
  let applyConflicted = false;
  let applyStderr = "";
  let applyErrorMsg = "";
  try {
    await execAsync(`git stash apply ${sha}`, { cwd: rootDir });
  } catch (err: unknown) {
    const errAsRecord = err as { stderr?: string; stdout?: string; message?: string };
    applyErrorMsg = err instanceof Error ? err.message : String(err);
    // execAsync (util.promisify of child_process.exec) attaches stderr/stdout
    // to the error object. Capture them so the operator can distinguish
    // untracked-overwrite ("would be overwritten by merge") from index-conflict
    // from missing-SHA without having to grep runtime logs.
    applyStderr = String(errAsRecord.stderr ?? errAsRecord.stdout ?? "").trim();
    // git stash apply exits non-zero both on hard failure (e.g. SHA gone)
    // and on conflict-with-applied-changes. Distinguish by checking the
    // working tree for conflict markers.
    const conflicted = await getConflictedFiles(rootDir);
    if (conflicted.length === 0) {
      // Hard failure — apply put nothing in the working tree (no conflict
      // markers). Try AI recovery before giving up.
      mergerLog.warn(
        `${taskId}: autostash ${sha.slice(0, 7)} hard-fail apply (${applyErrorMsg}); stderr=${applyStderr || "(empty)"}`,
      );
      const hardFailOutcome = await tryRecoverHardFailApply({
        rootDir,
        taskId,
        sha,
        applyErrorMsg,
        applyStderr,
        ctx,
      });
      return hardFailOutcome;
    }
    applyConflicted = true;
    mergerLog.warn(
      `${taskId}: autostash apply hit conflict in ${conflicted.length} file(s): ${conflicted.join(", ")}`,
    );
  }

  if (!applyConflicted) {
    // Clean apply — drop the stash and we're done.
    mergerLog.log(`${taskId}: restored autostash ${sha.slice(0, 7)} cleanly`);
    const dropResult = await dropAutostashBySha(rootDir, taskId, sha);
    if (dropResult.dropped) {
      await ctx.store
        .logEntry(
          taskId,
          `Restored pre-merge autostash ${sha.slice(0, 7)} cleanly`,
        )
        .catch(() => undefined);
    } else {
      // Apply succeeded but drop failed — the working tree has the dev's
      // changes but the stash is still in the list. Surface honestly so the
      // operator can `git stash drop` it manually.
      await ctx.store
        .logEntry(
          taskId,
          `Restored pre-merge autostash ${sha.slice(0, 7)} (apply clean), but stash entry failed to drop and is still in the list`,
          `Drop failure: ${dropResult.reason ?? "unknown"}\n\nClean up manually with:\n  cd ${rootDir} && git stash list | grep ${sha.slice(0, 7)} && git stash drop <ref>`,
        )
        .catch(() => undefined);
    }
    return { status: "restored", stashSha: sha };
  }

  // Conflict path: try AI resolution if enabled.
  const conflictedFiles = await getConflictedFiles(rootDir);
  const task = await ctx.store.getTask(taskId);
  const partitioned = await applyLayer3ConflictScopePartition({
    store: ctx.store,
    task,
    taskId,
    rootDir,
    branch: resolveTaskWorkingBranch(task),
    mergeTargetBranch: task.baseBranch || "main",
    conflictFiles: conflictedFiles,
    auditor: undefined,
  });
  const aiConflictedFiles = partitioned.inScopeConflicts;

  const smartConflictResolution = isSmartConflictResolutionEnabled(ctx.settings);

  if (!smartConflictResolution) {
    const message = `Autostash apply conflicted in ${aiConflictedFiles.length} file(s) and smartConflictResolution is disabled. Stash ${sha.slice(0, 7)} left intact; resolve manually with: cd ${rootDir} && # edit files, then git stash drop <ref>`;
    mergerLog.warn(`${taskId}: ${message}`);
    await ctx.store
      .logEntry(
        taskId,
        `Autostash apply conflicted in ${aiConflictedFiles.length} file(s) — manual resolution required (smart resolution disabled)`,
        message,
      )
      .catch(() => undefined);
    return {
      status: "conflict-needs-manual",
      stashSha: sha,
      conflictedFiles: aiConflictedFiles,
      message,
    };
  }

  if (aiConflictedFiles.length === 0) {
    const aiDropResult = await dropAutostashBySha(rootDir, taskId, sha);
    if (aiDropResult.dropped) {
      await ctx.store.logEntry(taskId, "Autostash conflict resolved by Layer 3 scope partition (no in-scope conflicts remained)");
    }
    return {
      status: "ai-resolved",
      stashSha: sha,
      conflictedFiles: [],
    };
  }

  await ctx.store.logEntry(
    taskId,
    `Autostash apply conflicted in ${aiConflictedFiles.length} file(s) — invoking AI to resolve`,
    aiConflictedFiles.join("\n"),
  );

  const aiResult = await runAiAgentForAutostashConflict({
    store: ctx.store,
    rootDir,
    taskId,
    conflictedFiles: aiConflictedFiles,
    options: ctx.options,
    settings: ctx.settings,
  });

  if (!aiResult.success) {
    const message = `Autostash apply conflict, AI resolution failed (${aiResult.error ?? "unknown error"}). Stash ${sha.slice(0, 7)} left intact; recover with: cd ${rootDir} && git status (conflicts in working tree) && # resolve, then git stash drop <ref>`;
    mergerLog.warn(`${taskId}: ${message}`);
    await ctx.store
      .logEntry(taskId, `Autostash AI conflict resolution failed — manual recovery required`, message)
      .catch(() => undefined);
    return {
      status: "conflict-needs-manual",
      stashSha: sha,
      conflictedFiles: aiConflictedFiles,
      message,
    };
  }

  // Verify the agent actually removed all conflict markers.
  const stillConflicted = await findFilesWithConflictMarkers(rootDir, aiConflictedFiles);
  if (stillConflicted.length > 0) {
    const message = `AI agent reported success but conflict markers remain in: ${stillConflicted.join(", ")}. Stash ${sha.slice(0, 7)} left intact; recover manually.`;
    mergerLog.warn(`${taskId}: ${message}`);
    await ctx.store
      .logEntry(taskId, `Autostash AI conflict resolution incomplete — manual recovery required`, message)
      .catch(() => undefined);
    return {
      status: "conflict-needs-manual",
      stashSha: sha,
      conflictedFiles: stillConflicted,
      message,
    };
  }

  // Success — AI resolved the conflict. Drop the stash since its content
  // has been applied (with conflict resolution edits on top).
  mergerLog.log(
    `${taskId}: AI-resolved autostash conflict in ${aiConflictedFiles.length} file(s); dropping stash ${sha.slice(0, 7)}`,
  );
  const aiDropResult = await dropAutostashBySha(rootDir, taskId, sha);
  if (aiDropResult.dropped) {
    await ctx.store.logEntry(
      taskId,
      `Autostash conflict resolved by AI in ${aiConflictedFiles.length} file(s)`,
      aiConflictedFiles.join("\n"),
    );
  } else {
    await ctx.store.logEntry(
      taskId,
      `Autostash conflict resolved by AI in ${aiConflictedFiles.length} file(s), but stash entry failed to drop`,
      `Resolved files:\n${aiConflictedFiles.join("\n")}\n\nDrop failure: ${aiDropResult.reason ?? "unknown"}\n\nClean up manually with:\n  cd ${rootDir} && git stash list | grep ${sha.slice(0, 7)} && git stash drop <ref>`,
    );
  }

  return {
    status: "ai-resolved",
    stashSha: sha,
    conflictedFiles: aiConflictedFiles,
  };
}

async function generateAiMergeSummary(
  commitLog: string,
  diffStat: string,
  settings: Settings,
  rootDir: string,
): Promise<string | null> {
  try {
    const resolved = resolveTitleSummarizerSettingsModel(settings);
    return await summarizeMergeCommit(
      commitLog,
      diffStat,
      rootDir,
      resolved.provider,
      resolved.modelId,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`AI merge summary failed; using deterministic fallback (${message})`);
    return null;
  }
}

async function generateAiMergeBody(
  commitLog: string,
  diffStat: string,
  settings: Settings,
  rootDir: string,
  branch: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const cleanStat = diffStat.trim();
  if (!cleanStat) return null;

  try {
    const resolved = resolveTitleSummarizerSettingsModel(settings);
    return await summarizeCommitBody(cleanStat, rootDir, resolved.provider, resolved.modelId, {
      branch,
      taskId,
      commitLog,
      signal,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`AI merge body failed; using deterministic fallback (${message})`);
    return null;
  }
}

async function generateAiMergeSubject(
  commitLog: string,
  diffStat: string,
  settings: Settings,
  rootDir: string,
  branch: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const resolved = resolveTitleSummarizerSettingsModel(settings);
    return await summarizeCommitSubject(
      diffStat,
      rootDir,
      resolved.provider,
      resolved.modelId,
      { branch, taskId, commitLog, signal },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`AI merge subject failed; using deterministic fallback (${message})`);
    return null;
  }
}

/**
 * Capture HEAD's sha, subject, and authored timestamp via git, then persist a
 * canonical lineage-trailer association. Validates each git output is a
 * non-empty string before binding to SQLite — `upsertTaskCommitAssociation`
 * binds `commitSha` to positional parameter 4, and any `undefined` or empty
 * value would otherwise raise `TypeError: Provided value cannot be bound to
 * SQLite parameter 4` mid-merge (observed under parallel finalize-attempt
 * races where one of the three `git` calls aborted before the others).
 *
 * Returns silently and logs a warning when validation fails — the association
 * is a denormalized convenience for lineage lookups, not a correctness
 * invariant, so a missed write must not block the merge.
 */
export async function recordCommitAssociationFromHead(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  lineageId: string,
): Promise<void> {
  let sha = "";
  let subject = "";
  let authoredAt = "";
  try {
    sha = (await execAsync("git rev-parse HEAD", { cwd: rootDir })).stdout.trim();
    subject = (await execAsync("git log -1 --format=%s HEAD", { cwd: rootDir })).stdout.trim();
    authoredAt = (await execAsync("git log -1 --format=%aI HEAD", { cwd: rootDir })).stdout.trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: skipped commit-association write — git inspection failed (${message})`);
    return;
  }
  if (!sha || !subject || !authoredAt) {
    mergerLog.warn(
      `${taskId}: skipped commit-association write — empty git output (sha=${sha.length}, subject=${subject.length}, authoredAt=${authoredAt.length})`,
    );
    return;
  }
  let additions: number | undefined;
  let deletions: number | undefined;
  try {
    const shortstat = (await execAsync("git show --shortstat --format= HEAD", { cwd: rootDir })).stdout;
    const parsed = parseShortstatSummary(shortstat);
    additions = parsed.insertions;
    deletions = parsed.deletions;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: commit-association diff stats unavailable; persisting lineage without LOC stats (${message})`);
  }
  await store.upsertTaskCommitAssociation({
    taskLineageId: lineageId,
    taskIdSnapshot: taskId,
    commitSha: sha,
    commitSubject: subject,
    authoredAt,
    matchedBy: "canonical-lineage-trailer",
    confidence: "canonical",
    additions,
    deletions,
  });
}

/**
 * Derive a non-AI subject summary from the branch's step commit log. The log
 * is `- subj1\n- subj2\n…` (most recent first). The naive "use lines[0]" choice
 * is wrong in practice: when a quality-gate revision lands as the final commit
 * (e.g. a token-cleanup fixup after Step 4), the most-recent subject describes
 * the *fixup*, not the task. So we prefer, in order:
 *   1. The lowest-numbered `complete Step N — …` commit (the headline step)
 *   2. The oldest commit (lines[last]) — typically Step 1 / the first feat
 *      commit on the branch
 *
 * Conventional-commit prefix is stripped to avoid `feat: feat(...): …`, and we
 * tack on `(+N more)` when the branch has multiple step commits.
 */
export function deriveDeterministicSubjectSummary(commitLog: string): string | null {
  const lines = commitLog
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const stripBullet = (l: string) => l.replace(/^[-*]\s+/, "").trim();
  const stripConventional = (l: string) =>
    l.replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "").trim();
  const cleaned = lines.map((l) => stripConventional(stripBullet(l)));

  // Separator is em-dash (U+2014), ASCII hyphen, or colon. Spelled with
  // explicit alternation rather than a character class so the em-dash
  // intent is obvious to anyone auditing this regex.
  const stepRe = /^complete Step (\d+)\s*(?:—|-|:)\s*(.+)$/i;
  let bestStep: { n: number; summary: string } | null = null;
  for (const c of cleaned) {
    const m = c.match(stepRe);
    if (!m) continue;
    const n = Number(m[1]);
    const summary = m[2].trim();
    if (!summary) continue;
    if (!bestStep || n < bestStep.n) bestStep = { n, summary };
  }

  const headline = bestStep?.summary ?? cleaned[cleaned.length - 1];
  if (!headline) return null;

  const extras = lines.length - 1;
  const summary = extras > 0 ? `${headline} (+${extras} more)` : headline;
  return summary;
}

/**
 * Build the canonical merge commit message from the branch's step commits.
 * Subject preference order:
 *   1. AI summarizer (`summarizeCommitSubject`) when it succeeded
 *   2. First step commit subject (with conventional prefix stripped) + `(+N more)`
 *   3. `merge <branch>` (last-resort, only when no step commits exist)
 */
export function composeMergeCommitBody(params: {
  branch: string;
  commitLog: string;
  diffStat?: string;
  aiSummary?: string | null;
  aiBody?: string | null;
}): string {
  const { branch, commitLog, diffStat, aiSummary, aiBody } = params;
  const trimmedSummary = aiSummary?.trim() ?? "";
  const trimmedAiBody = aiBody?.trim() ?? "";
  const trimmedCommitLog = commitLog?.trim() ?? "";
  const trimmedDiffStat = diffStat?.trim() ?? "";

  const commitsSection = trimmedCommitLog.length > 0
    ? trimmedCommitLog
    : `- merge ${branch}`;

  const parts: string[] = [];
  if (trimmedSummary.length > 0) parts.push(trimmedSummary);
  if (trimmedAiBody.length > 0) parts.push(trimmedAiBody);

  const deterministicFallback = [
    `Commits merged:\n${commitsSection}`,
    trimmedDiffStat.length > 0 ? `Files changed:\n${trimmedDiffStat}` : "",
  ].filter(Boolean).join("\n\n");

  if (parts.length === 0) return deterministicFallback;

  if (trimmedDiffStat.length > 0) {
    parts.push(`Files changed:\n${trimmedDiffStat}`);
  }

  return parts.join("\n\n");
}

async function buildDeterministicMergeMessage(params: {
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat?: string;
  includeTaskId: boolean;
  aiSummary?: string | null;
  aiBody?: string | null;
  aiSubject?: string | null;
}): Promise<{ subjectArg: string; bodyArg: string }> {
  const { taskId, branch, commitLog, diffStat, includeTaskId, aiSummary, aiBody, aiSubject } = params;
  const prefix = includeTaskId ? `feat(${taskId})` : "feat";
  const trimmedAiSubject = aiSubject?.trim() ?? "";
  const derived = trimmedAiSubject.length === 0
    ? deriveDeterministicSubjectSummary(commitLog ?? "")
    : null;
  const subjectSummary = trimmedAiSubject.length > 0
    ? trimmedAiSubject
    : (derived ?? `merge ${branch}`);
  const subject = `${prefix}: ${subjectSummary}`;

  const body = composeMergeCommitBody({
    branch,
    commitLog,
    diffStat,
    aiSummary,
    aiBody,
  });

  // -m args are double-quoted in the shell command, so escape backslashes,
  // double quotes, dollar signs, and backticks.
  const escape = (s: string) => s.replace(/(["\\$`])/g, "\\$1");
  return {
    subjectArg: `-m "${escape(subject)}"`,
    bodyArg: `-m "${escape(body)}"`,
  };
}

export { buildDeterministicMergeMessage as __testOnlyBuildDeterministicMergeMessage };
export { resolveSafeCommitBody as __testOnlyResolveSafeCommitBody };
export { resolveComplexRebaseConflictsWithAi as __testOnlyResolveComplexRebaseConflictsWithAi };

/**
 * Stage current changes and either:
 *   (a) create a fresh squash commit when HEAD has not advanced past
 *       `preAttemptHeadSha` — i.e. the AI agent never ran `git commit` (e.g.
 *       fn_report_build_failure path) and the in-merge fix is finalizing the
 *       merge in its place; or
 *   (b) amend the existing merge commit (with a deterministic message) when
 *       HEAD has moved past `preAttemptHeadSha` — i.e. the AI agent already
 *       committed and the fix is folding follow-up changes into it.
 *
 * Always rewrites the commit message to the deterministic form built from the
 * branch's actual step commits, so consumers of mergeDetails never see a
 * hallucinated body that talks about files that aren't in the diff.
 *
 * Only files that are part of the squash or that the fix agent explicitly
 * modified are staged. Any other dirty files in the working tree are left
 * untouched and a warning is emitted for each one.
 *
 * Returns a structured result with `{ ok: true, reason: ... }` on success or
 * `{ ok: false, reason: ... }` on failure. Never throws — errors are logged and
 * callers decide whether to abort the merge based on the returned reason.
 *
 * @internal Exported for integration tests only — not part of the public API.
 */
type MergeFinalizeResult =
  | {
    ok: true;
    reason: "committed" | "head-task-trailer" | "branch-already-merged" | "branch-already-merged-on-main";
    mergeSha?: string;
    strategy?: AlreadyMergedDetectionStrategy;
  }
  | { ok: false; reason: "fix-produced-no-content" | "unknown-phantom" | "branch-ref-ahead-reset"; originalError?: string; branchAuthority?: "ok" | string };

async function persistFinalizeResetLeftovers(rootDir: string, taskId: string, store?: TaskStore): Promise<void> {
  try {
    const dirtyPaths = [...(await snapshotDirtyFiles(rootDir))];
    if (dirtyPaths.length === 0) return;
    await execAsync("git add -A", { cwd: rootDir });
    const { stdout: createOut } = await execAsync("git stash create", { cwd: rootDir, encoding: "utf-8" });
    const sha = String(createOut).trim();
    if (!sha) {
      await execAsync("git reset", { cwd: rootDir }).catch(() => undefined);
      return;
    }
    const label = `${AUTOSTASH_LABEL_PREFIX}${taskId}:finalize-reset:${Date.now()}`;
    await execAsync(`git stash store -m ${quoteArg(label)} ${sha}`, { cwd: rootDir });
    await execAsync("git reset", { cwd: rootDir }).catch(() => undefined);
    mergerLog.warn(
      `${taskId}: persisted ${dirtyPaths.length} dirty rootDir path(s) before finalize reset as ${sha.slice(0, 7)} (${label})`,
    );
    if (store) {
      await store.logEntry(
        taskId,
        `Persisted ${dirtyPaths.length} dirty rootDir path(s) before finalize reset/amend cleanup`,
        `stash: ${sha}\nlabel: ${label}\nphase: finalize-reset\npaths:\n${dirtyPaths.join("\n")}`,
      ).catch(() => undefined);
      await notifyAutostashOrphans(store, rootDir, { detectedByTaskId: taskId }).catch(() => undefined);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: failed to persist dirty rootDir leftovers before finalize reset: ${msg}`);
  }
}

const NUL = "\0";

function splitNulDelimited(output: string | Buffer): string[] {
  const text = typeof output === "string" ? output : output.toString("utf-8");
  return text.split(NUL).filter((entry) => entry.length > 0);
}

async function countStagedPaths(rootDir: string): Promise<number> {
  const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only", "-z"], {
    cwd: rootDir,
    encoding: "buffer",
    maxBuffer: 10 * 1024 * 1024,
  });
  return splitNulDelimited(stdout).length;
}

export async function filterStagedGitignoredPaths(
  rootDir: string,
  taskId: string,
): Promise<{ unstaged: string[]; remainingStaged: number }> {
  try {
    const { stdout: stagedOut } = await execFileAsync("git", ["diff", "--cached", "--name-only", "-z"], {
      cwd: rootDir,
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
    });
    const stagedPaths = splitNulDelimited(stagedOut);
    if (stagedPaths.length === 0) {
      return { unstaged: [], remainingStaged: 0 };
    }

    const ignoredPaths: string[] = [];
    const batchSize = 200;
    for (let i = 0; i < stagedPaths.length; i += batchSize) {
      const batch = stagedPaths.slice(i, i + batchSize);
      try {
        const { stdout } = await execFileAsync("git", ["check-ignore", "--no-index", "--", ...batch], {
          cwd: rootDir,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });
        ignoredPaths.push(
          ...stdout
            .split("\n")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        );
      } catch (err: unknown) {
        const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: number }).code : undefined;
        if (code === 1) {
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: failed to detect gitignored staged paths in batch: ${msg}`);
      }
    }

    const unstaged: string[] = [];
    for (const path of ignoredPaths) {
      mergerLog.warn(
        `${taskId}: refusing to stage gitignored path "${path}" — unstaging (agents must not bypass .gitignore via \`git add -f\`)`,
      );
      try {
        await execFileAsync("git", ["reset", "HEAD", "--", path], {
          cwd: rootDir,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });
        unstaged.push(path);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: failed to unstage gitignored path "${path}": ${msg}`);
      }
    }

    const remainingStaged = await countStagedPaths(rootDir).catch(() => stagedPaths.length - unstaged.length);
    return { unstaged, remainingStaged };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: gitignored-path staging guard failed: ${msg}`);
    const remainingStaged = await countStagedPaths(rootDir).catch(() => 0);
    return { unstaged: [], remainingStaged };
  }
}

export async function commitOrAmendMergeWithFixes(
  rootDir: string,
  taskId: string,
  branch: string,
  commitLog: string,
  includeTaskId: boolean,
  preAttemptHeadSha: string,
  authorArg: string,
  diffStat?: string,
  settings?: Settings,
  signal?: AbortSignal,
  aiSummary?: string | null,
  aiBody?: string | null,
  aiSubject?: string | null,
  fixModifiedFiles: ReadonlySet<string> = new Set(),
  store?: TaskStore,
  auditor?: RunAuditor,
): Promise<MergeFinalizeResult> {
  try {
    // Build an allowlist of paths we are permitted to stage.
    // Allowlist = (already staged by squash) ∪ (unstaged ∩ fixModifiedFiles)
    // We also handle untracked files created by the fix agent.
    //
    // FN-2152 still applies: the submodule-gitlink filter below removes any
    // gitlinks that slip through (nested worktrees, etc.).

    // 1. Read currently-staged files (squash produced these) for diagnostic logging.
    const { stdout: squashStagedOut } = await execAsync("git diff --cached --name-only", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const squashStaged = new Set(squashStagedOut.split("\n").map((l) => l.trim()).filter(Boolean));

    // 2. What is currently unstaged (tracked, modified-but-not-staged).
    const { stdout: unstagedOut } = await execAsync("git diff --name-only", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const unstaged = new Set(unstagedOut.split("\n").map((l) => l.trim()).filter(Boolean));

    // 3. Untracked files created by the fix agent (NUL-delimited, no quoting needed).
    const { stdout: porcelainOut } = await execFileAsync("git", ["status", "-z", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const untracked = new Set<string>();
    for (const entry of porcelainOut.split("\0")) {
      if (!entry.startsWith("?? ")) continue;
      const p = entry.slice(3);
      if (p) untracked.add(p);
    }

    // 4. Stage each unstaged path that the fix agent touched (batched, no shell).
    const unstagedToStage: string[] = [];
    for (const p of unstaged) {
      if (fixModifiedFiles.has(p)) {
        unstagedToStage.push(p);
      } else {
        mergerLog.warn(
          `${taskId}: refusing to stage unrelated working-tree change: ${p} (not part of squash or in-merge fix)`,
        );
      }
    }
    if (unstagedToStage.length > 0) {
      await execFileAsync("git", ["add", "--", ...unstagedToStage], { cwd: rootDir });
    }

    // 5. Stage untracked files created by the fix agent (batched, no shell).
    const untrackedToStage: string[] = [];
    for (const p of untracked) {
      if (fixModifiedFiles.has(p)) {
        untrackedToStage.push(p);
      } else {
        mergerLog.warn(
          `${taskId}: refusing to stage unrelated working-tree change: ${p} (not part of squash or in-merge fix)`,
        );
      }
    }
    if (untrackedToStage.length > 0) {
      await execFileAsync("git", ["add", "--", ...untrackedToStage], { cwd: rootDir });
    }

    // Fix 3: cap long path lists to avoid unreadable single-line logs.
    const cap = (arr: string[], n = 20) =>
      arr.length <= n ? arr.join(", ") : `${arr.slice(0, n).join(", ")} ... (+${arr.length - n} more)`;

    mergerLog.log(
      `${taskId}: staging allowlist — squash: [${cap([...squashStaged])}], fixModified: [${cap([...fixModifiedFiles])}]`,
    );

    const { stdout: staged } = await execAsync("git diff --cached --raw", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    for (const line of staged.split("\n")) {
      const match = line.match(/^:\d{6} 160000 [^\t]+\t(.+)$/);
      if (!match) continue;
      const path = match[1];
      mergerLog.warn(`${taskId}: refusing to stage gitlink "${path}" (project uses no submodules — likely a nested worktree). Unstaging.`);
      try {
        await execAsync(`git reset HEAD -- "${path}"`, { cwd: rootDir });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: failed to unstage gitlink "${path}": ${msg}`);
      }
    }

    await filterStagedGitignoredPaths(rootDir, taskId);

    const { stdout: finalStaged } = await execAsync("git diff --cached --name-only", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const hasStaged = finalStaged.trim().length > 0;

    const { stdout: currentHeadOut } = await execAsync("git rev-parse HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const currentHead = currentHeadOut.trim();
    const headMoved = currentHead !== preAttemptHeadSha;

    if (!hasStaged && !headMoved) {
      // FN-1858 (origin guard) + FN-3773 (squash-restore) + FN-3846 (ancestor/
      // equivalent-content detection): when finalize sees no staged changes and
      // HEAD hasn't moved, distinguish four terminal states:
      // 1) committed-by-AI (HEAD has this task trailer) => success
      // 2) branch already on integration target (ancestor/equivalent patch-id) => success
      // 3) no-op rebuild recoverable via squash-restore => continue to commit
      // 4) real phantom (nothing recoverable) => return false
      const { stdout: branchTipOut } = await execAsync(`git rev-parse ${quoteArg(branch)}`, {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const branchTip = branchTipOut.trim();
      const trailerOnHead = await headCarriesTaskIdTrailer(rootDir, taskId);
      const { stdout: mergeBaseOut } = await execAsync(
        `git merge-base ${quoteArg(branchTip)} ${quoteArg(preAttemptHeadSha)}`,
        {
          cwd: rootDir,
          encoding: "utf-8",
        },
      );
      const mergeBase = mergeBaseOut.trim();
      const { stdout: diffStatOut } = await execAsync(`git diff --stat ${preAttemptHeadSha}..${branch}`, {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const diffStatSummary = diffStatOut.split("\n").slice(0, 20).join("\n");
      const { stdout: stagedCountOut } = await execAsync("git diff --cached --name-only", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const { stdout: unstagedCountOut } = await execAsync("git diff --name-only", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const { stdout: untrackedCountOut } = await execAsync("git ls-files --others --exclude-standard", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const stagedCount = stagedCountOut.split("\n").filter(Boolean).length;
      const unstagedCount = unstagedCountOut.split("\n").filter(Boolean).length;
      const untrackedCount = untrackedCountOut.split("\n").filter(Boolean).length;

      const diagnostics =
        `${taskId}: phantom-guard diagnostics\n` +
        `  taskId=${taskId}\n` +
        `  preAttemptHeadSha=${preAttemptHeadSha}\n` +
        `  currentHead=${currentHead}\n` +
        `  branch=${branch}\n` +
        `  branchTip=${branchTip}\n` +
        `  mergeBase(branchTip, preAttemptHeadSha)=${mergeBase}\n` +
        `  headCarriesTaskIdTrailer=${String(trailerOnHead)}\n` +
        `  stagedCount=${stagedCount} unstagedCount=${unstagedCount} untrackedCount=${untrackedCount}\n` +
        `  fixModifiedFilesCount=${fixModifiedFiles.size}\n` +
        `  diffStat(preAttemptHeadSha..branch)\n${diffStatSummary || "  <empty>"}`;
      mergerLog.warn(diagnostics);

      // FN-3846 ordering: trailer short-circuit first (this task already on
      // HEAD), then ancestor short-circuit (branch already reachable from
      // integration target via a different commit path), then squash-restore.
      if (trailerOnHead) {
        mergerLog.log(
          `${taskId}: HEAD already carries Fusion-Task-Id trailer — treating in-merge fix finalize as no-op success`,
        );
        return { ok: true, reason: "head-task-trailer" };
      }

      const branchTipCarriesTaskTrailer = await commitCarriesTaskIdTrailer(rootDir, taskId, branchTip);

      let branchAlreadyOnIntegrationTarget = false;
      try {
        await execAsync(
          `git merge-base --is-ancestor ${quoteArg(branchTip)} ${quoteArg(preAttemptHeadSha)}`,
          {
            cwd: rootDir,
            encoding: "utf-8",
            timeout: 5_000,
          },
        );
        branchAlreadyOnIntegrationTarget = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: ancestor short-circuit check failed (${msg}); continuing finalize fallback flow`);
        branchAlreadyOnIntegrationTarget = false;
      }
      if (
        // In tests/mocks branchTip can be empty; keep that path permissive so
        // we still exercise the ancestor branch without overfitting to rev-parse.
        branchAlreadyOnIntegrationTarget &&
        (branchTipCarriesTaskTrailer || branchTip.length === 0)
      ) {
        mergerLog.log(`${taskId}: branch already on integration target (ancestor) — no-op success`);
        return { ok: true, reason: "branch-already-merged" };
      }

      try {
        const { stdout: mergeBaseForPatchOut } = await execAsync(
          `git merge-base ${quoteArg(branchTip)} ${quoteArg(preAttemptHeadSha)}`,
          {
            cwd: rootDir,
            encoding: "utf-8",
            timeout: 5_000,
          },
        );
        const mergeBaseForPatch = mergeBaseForPatchOut.trim();
        if (mergeBaseForPatch) {
          const { stdout: branchPatchIdOut } = await execAsync(
            `git diff ${quoteArg(mergeBaseForPatch)}..${quoteArg(branchTip)} | git patch-id --stable`,
            {
              cwd: rootDir,
              encoding: "utf-8",
              timeout: 5_000,
            },
          );
          const branchPatchId = branchPatchIdOut.trim().split(/\s+/)[0] || "";
          if (branchPatchId && branchTipCarriesTaskTrailer) {
            const { stdout: recentShaOut } = await execAsync(
              `git log ${quoteArg(preAttemptHeadSha)} -n 20 --format=%H`,
              {
                cwd: rootDir,
                encoding: "utf-8",
                timeout: 5_000,
              },
            );
            const recentShas = recentShaOut
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            for (const sha of recentShas) {
              const pid = await commitPatchId(rootDir, sha);
              if (pid === branchPatchId) {
                mergerLog.log(
                  `${taskId}: branch content already on integration target (equivalent patch-id with ${sha}) — no-op success`,
                );
                return { ok: true, reason: "branch-already-merged" };
              }
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(
          `${taskId}: failed equivalent-content short-circuit checks (${msg}); falling through to squash-restore`,
        );
      }

      // No commit and no staged content can still be recoverable when the
      // in-merge fix path cleared the previous squash index state. Rebuild the
      // squash from branch -> preAttemptHeadSha and continue normally.
      let squashRestoreReportedUpToDate = false;
      try {
        await persistFinalizeResetLeftovers(rootDir, taskId, store);
        await execAsync(`git reset --hard ${preAttemptHeadSha}`, {
          cwd: rootDir,
          encoding: "utf-8",
        });
        await execAsync("git clean -fd", {
          cwd: rootDir,
          encoding: "utf-8",
        });
        const { stdout: squashRestoreOut, stderr: squashRestoreErr } = await execAsync(`git merge --squash ${branch}`, {
          cwd: rootDir,
          encoding: "utf-8",
        });
        const squashRestoreText = `${squashRestoreOut || ""}\n${squashRestoreErr || ""}`;
        squashRestoreReportedUpToDate = /already up to date/i.test(squashRestoreText);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const stderr = typeof err === "object" && err !== null && "stderr" in err ? String((err as { stderr?: unknown }).stderr ?? "") : "";
        const stdout = typeof err === "object" && err !== null && "stdout" in err ? String((err as { stdout?: unknown }).stdout ?? "") : "";
        const combined = `${stdout}\n${stderr}\n${msg}`;
        if (/conflict|CONFLICT/i.test(combined)) {
          resetMergeWithWarn(rootDir, taskId, "squash-restore conflict");
          throw new Error(`${taskId}: squash-restore fallback hit merge conflicts while finalizing verification-fix merge`);
        }
        mergerLog.warn(`${taskId}: failed to restore squash state before finalize: ${msg}; stderr=${stderr.trim() || "<empty>"}`);
      }

      await filterStagedGitignoredPaths(rootDir, taskId);

      const { stdout: restoredStagedOut } = await execAsync("git diff --cached --name-only", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      if (restoredStagedOut.trim().length === 0) {
        if (squashRestoreReportedUpToDate && (branchTipCarriesTaskTrailer || branchTip.length === 0)) {
          mergerLog.log(`${taskId}: squash-restore reported already up to date; treating as branch-already-merged`);
          return { ok: true, reason: "branch-already-merged" };
        }

        if (currentHead === preAttemptHeadSha) {
          let lineageId: string | undefined;
          if (store) {
            const existingTask = await store.getTask(taskId);
            lineageId = existingTask?.lineageId;
          }
          const landed = await detectAlreadyLandedOnMain({
            rootDir,
            taskId,
            lineageId,
            baseBranch: preAttemptHeadSha,
            taskBranch: branch,
            baseCommitSha: preAttemptHeadSha,
          });
          if (landed) {
            mergerLog.log(
              `${taskId}: recovered finalize no-content as already-landed branch=${branch} tip=${branchTip.slice(0, 8)} integrationTarget=${preAttemptHeadSha.slice(0, 8)} via=${landed.strategy}`,
            );
            await auditor?.database({
              type: "task:auto-recover-finalize-already-on-main",
              target: taskId,
              metadata: {
                mergeSha: landed.sha,
                mergeStrategy: landed.strategy,
                baseBranch: preAttemptHeadSha,
                branch,
                branchTip,
              },
            });
            return { ok: true, reason: "branch-already-merged-on-main", mergeSha: landed.sha, strategy: landed.strategy };
          }
        }

        mergerLog.warn(
          `${taskId}: refusing to record merge — no commit was created and no changes are staged after squash-restore.`,
        );
        return { ok: false, reason: "fix-produced-no-content" };
      }

      mergerLog.log(`${taskId}: restored squash state after no-op verification fix; proceeding to commit`);
    }

    // Build the message from the actual commit content rather than the
    // wide-range branch context that was gathered before merge. The
    // pre-merge commitLog/diffStat use `merge-base(branch, main)` as base,
    // which under squash-merge workflows can predate already-merged sibling
    // tasks — leading to messages that describe files not in the diff.
    // `preAttemptHeadSha` is the integration target (main's tip just before
    // this merge), so diffing against it gives content truth.
    const actualContext = await computeActualMergeCommitContext({
      rootDir,
      integrationTargetSha: preAttemptHeadSha,
      branch,
    });
    const messageCommitLog = actualContext.commitLog || commitLog;
    const messageDiffStat = actualContext.diffStat || diffStat;

    const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
      taskId,
      branch,
      commitLog: messageCommitLog,
      diffStat: messageDiffStat,
      includeTaskId,
      aiSummary,
      aiBody,
      aiSubject,
    });
    let lineageId: string | undefined;
    if (store) {
      const existingTask = await store.getTask(taskId);
      lineageId = existingTask?.lineageId;
    }
    const trailerArg = buildTaskTrailerArgs(taskId, lineageId);

    if (!headMoved) {
      // No merge commit yet — create one fresh on top of preAttemptHeadSha.
      // This is the phantom-merge fix: previously the code blindly amended
      // HEAD (the previous task's commit), silently dropping the current
      // task's branch and inheriting the prior task's stats.
      if (store) {
        await enforceSquashFileScopeInvariant({
          store,
          taskId,
          rootDir,
          task: await store.getTask(taskId),
          resetLabel: "file-scope invariant violation",
          auditor,
        });
      }
      await runDiffVolumeGate({
        rootDir,
        branch,
        integrationTargetSha: preAttemptHeadSha,
        taskId,
        settings,
        store,
      });
      await execAsync(
        `git commit ${subjectArg} ${bodyArg}${trailerArg}${authorArg}`,
        { cwd: rootDir, env: mergerCommitEnv() },
      );
      if (store && lineageId) {
        await recordCommitAssociationFromHead(store, rootDir, taskId, lineageId);
      }
      mergerLog.log(`${taskId}: created fresh merge commit after verification fix (no prior commit to amend)`);
      return { ok: true, reason: "committed" };
    }

    // HEAD moved — AI agent committed already. Amend with deterministic
    // message + any new staged fixes folded in. `--amend -m` replaces both
    // the message and includes any newly-staged content.
    if (store) {
      await enforceSquashFileScopeInvariant({
        store,
        taskId,
        rootDir,
        task: await store.getTask(taskId),
        resetLabel: "file-scope invariant violation",
        auditor,
      });
    }
    await runDiffVolumeGate({
      rootDir,
      branch,
      integrationTargetSha: preAttemptHeadSha,
      taskId,
      settings,
      store,
    });
    await execAsync(
      `git commit --amend ${subjectArg} ${bodyArg}${trailerArg}${authorArg}`,
      { cwd: rootDir, env: mergerCommitEnv() },
    );
    if (store && lineageId) {
      await recordCommitAssociationFromHead(store, rootDir, taskId, lineageId);
    }
    mergerLog.log(`${taskId}: amended merge commit with verification fixes (deterministic message)`);
    return { ok: true, reason: "committed" };
  } catch (err: unknown) {
    if (err instanceof DiffVolumeRegressionError || err instanceof FileScopeViolationError) {
      throw err;
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${taskId}: failed to finalize merge commit: ${errorMessage}`);
    // FN-5422-class diagnostic: when finalize throws but the branch ref still
    // carries this task's authoritative lineage (tip trailer + no foreign
    // FN-attributed commits in base..branch), the work isn't lost — it's just
    // that this attempt's integration worktree never advanced. Reset rootDir
    // to preAttemptHeadSha so the next merge attempt starts clean, and tag
    // the result so the caller's diagnostic includes that context.
    const authority = await isBranchAuthoritativeForTask(rootDir, branch, taskId).catch(
      () => ({ ok: false as const, reason: "authority-probe-failed" }),
    );
    if (authority.ok) {
      try {
        await execAsync(`git reset --hard ${preAttemptHeadSha}`, { cwd: rootDir, encoding: "utf-8" });
        await execAsync("git clean -fd", { cwd: rootDir, encoding: "utf-8" });
        mergerLog.warn(
          `${taskId}: finalize threw but branch ref is authoritative (tip carries Fusion-Task-Id, no foreign commits since base) — reset HEAD to ${preAttemptHeadSha.slice(0, 8)} for clean retry`,
        );
      } catch (resetErr: unknown) {
        mergerLog.warn(
          `${taskId}: branch-authoritative reset failed: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}`,
        );
      }
      return { ok: false, reason: "branch-ref-ahead-reset", originalError: errorMessage, branchAuthority: "ok" };
    }
    return {
      ok: false,
      reason: "unknown-phantom",
      originalError: errorMessage,
      branchAuthority: authority.ok ? "ok" : authority.reason,
    };
  }
}

// ── Pre-merge diffstat scope validation ──────────────────────────────


export async function applyLayer3ConflictScopePartition(params: {
  store: TaskStore;
  task: Task;
  taskId: string;
  rootDir: string;
  branch: string;
  mergeTargetBranch?: string;
  conflictFiles: string[];
  auditor?: RunAuditor;
}): Promise<{ inScopeConflicts: string[]; skippedFiles: string[]; declaredScope: string[]; viaScopeOverride: boolean }> {
  const { store, task, taskId, rootDir, branch, mergeTargetBranch = "main", conflictFiles, auditor } = params;
  if (conflictFiles.length === 0 || typeof (store as Partial<TaskStore>).parseFileScopeFromPrompt !== "function") {
    return { inScopeConflicts: conflictFiles, skippedFiles: [], declaredScope: [], viaScopeOverride: false };
  }

  const declaredScope = await store.parseFileScopeFromPrompt(taskId);
  if (task.scopeOverride === true) {
    const reasonSuffix = task.scopeOverrideReason?.trim() ? ` — reason: ${task.scopeOverrideReason.trim()}` : "";
    await store.appendAgentLog(taskId, `Layer 3 arbiter scope partition bypassed via scopeOverride${reasonSuffix}`, "status", undefined, "merger");
    if (auditor) {
      await auditor.git({
        type: "merge:layer3:scope-override-bypass",
        target: branch,
        metadata: {
          taskId,
          skippedFiles: [],
          declaredScope,
          inScopeCount: conflictFiles.length,
          viaScopeOverride: true,
        },
      }).catch((error: unknown) => {
        mergerLog.warn(`${taskId}: failed to emit merge:layer3:scope-override-bypass run_audit event: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return { inScopeConflicts: conflictFiles, skippedFiles: [], declaredScope, viaScopeOverride: true };
  }

  if (declaredScope.length === 0) {
    return { inScopeConflicts: conflictFiles, skippedFiles: [], declaredScope, viaScopeOverride: false };
  }

  let effectiveDeclaredScope = [...declaredScope];
  let outOfScope = conflictFiles.filter((file) => !matchesScope(file, effectiveDeclaredScope));
  if (outOfScope.length > 0) {
    const scopeAutoWiden = await evaluateScopeAutoWiden({
      store,
      task,
      taskId,
      rootDir,
      branch,
      baseRef: mergeTargetBranch,
      candidateFiles: outOfScope,
    });

    if (scopeAutoWiden.widened.length > 0) {
      try {
        const widenedFiles = await appendAutoWidenedScopeToPrompt({
          store,
          taskId,
          files: scopeAutoWiden.widened.map((entry) => entry.file),
        });
        if (widenedFiles.length > 0) {
          effectiveDeclaredScope = await store.parseFileScopeFromPrompt(taskId);
          const widenedSet = new Set(widenedFiles);
          for (const widened of scopeAutoWiden.widened.filter((entry) => widenedSet.has(entry.file))) {
            if (auditor) {
              await auditor.git({
                type: "merge:scope:auto-widen",
                target: branch,
                metadata: {
                  taskId,
                  file: widened.file,
                  attribution: widened.attribution,
                  commits: widened.commits,
                },
              }).catch((error: unknown) => {
                mergerLog.warn(`${taskId}: failed to emit merge:scope:auto-widen run_audit event: ${error instanceof Error ? error.message : String(error)}`);
              });
            }
          }
          await store.appendAgentLog(
            taskId,
            `Layer 2.5 auto-widened File Scope: ${widenedFiles.join(", ")}`,
            "status",
            undefined,
            "merger",
          );
        }
      } catch (error) {
        mergerLog.warn(`${taskId}: failed to persist Layer 2.5 auto-widened scope, continuing with strip path: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    outOfScope = outOfScope.filter((file) => !matchesScope(file, effectiveDeclaredScope));
  }

  const { inScope } = partitionConflictsByFileScope({ conflictFiles, declaredScope: effectiveDeclaredScope });
  for (const file of outOfScope) {
    // In merge and rebase conflict contexts, `--ours` resolves to the
    // integration-target side (main bytes), which we keep for out-of-scope files.
    await resolveWithOurs(file, rootDir);
    // `resolveWithOurs` stages the file; unstage it so the squash does not
    // carry out-of-scope paths even though working-tree bytes now match main.
    await execAsync(`git reset HEAD -- ${quoteArg(file)}`, { cwd: rootDir });
  }

  const { stdout: stagedOut } = await execAsync("git diff --cached --name-only", { cwd: rootDir, encoding: "utf-8" });
  const stagedAfterPartition = stagedOut.split("\n").map((line) => line.trim()).filter(Boolean);
  const outOfScopeStillStaged = stagedAfterPartition.filter((file) => outOfScope.includes(file));
  if (outOfScopeStillStaged.length > 0) {
    throw new Error(`Layer 3 scope partition failed for ${taskId}: out-of-scope files still staged after prefer-main resolution: ${outOfScopeStillStaged.join(", ")}`);
  }

  if (outOfScope.length > 0) {
    const summary = `Layer 3 arbiter: skipped ${outOfScope.length} foreign file(s) — took main's version for: ${outOfScope.join(", ")}`;
    await store.appendAgentLog(taskId, summary, "status", undefined, "merger");
    await store.logEntry(taskId, summary, "Layer3AIArbiterScopeSkip");
    if (auditor) {
      await auditor.git({
        type: "merge:layer3:foreign-file-skipped",
        target: branch,
        metadata: {
          taskId,
          skippedFiles: outOfScope,
          declaredScope: effectiveDeclaredScope,
          inScopeCount: inScope.length,
          viaScopeOverride: false,
        },
      }).catch((error: unknown) => {
        mergerLog.warn(`${taskId}: failed to emit merge:layer3:foreign-file-skipped run_audit event: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  return { inScopeConflicts: inScope, skippedFiles: outOfScope, declaredScope: effectiveDeclaredScope, viaScopeOverride: false };
}

/**
 * Validate that the diff stays within the task's declared File Scope.
 * Returns warnings for out-of-scope changes, especially large deletions.
 *
 * When `strict` is true, throws an error on scope violations instead of
 * just returning warnings (hard guardrail that blocks merge).
 */


export async function validateDiffScope(
  store: TaskStore,
  taskId: string,
  diffStat: string,
  strict: boolean = false,
): Promise<DiffScopeResult> {
  const result: DiffScopeResult = { warnings: [], outOfScopeFiles: [], largeOutOfScopeDeletions: [] };

  // Parse the diffstat
  const entries = parseDiffStat(diffStat);
  if (entries.length === 0) return result;

  // Read the task's PROMPT.md for file scope
  let promptContent = "";
  try {
    const task = await store.getTask(taskId);
    promptContent = task.prompt || "";
  } catch {
    return result; // can't validate without prompt
  }

  const scopePatterns = extractFileScope(promptContent);
  if (scopePatterns.length === 0) return result; // no scope declared, skip

  // Check each changed file
  for (const entry of entries) {
    // Skip changeset files — always allowed
    if (entry.file.startsWith(".changeset/")) continue;

    if (!matchesScope(entry.file, scopePatterns)) {
      result.outOfScopeFiles.push(entry.file);

      // Flag large deletions outside scope (>50 net deletions or 100% deletions)
      const netDeletions = entry.deletions - entry.insertions;
      if (netDeletions > 50 || (entry.deletions > 0 && entry.insertions === 0)) {
        result.largeOutOfScopeDeletions.push({ file: entry.file, deletions: entry.deletions });
      }
    }
  }

  // Build warnings
  if (result.largeOutOfScopeDeletions.length > 0) {
    const files = result.largeOutOfScopeDeletions
      .map((d) => `${d.file} (${d.deletions} deletions)`)
      .join(", ");
    result.warnings.push(
      `⚠ SCOPE WARNING: Large deletions outside File Scope: ${files}`,
    );
  } else if (result.outOfScopeFiles.length > 3) {
    result.warnings.push(
      `⚠ SCOPE WARNING: ${result.outOfScopeFiles.length} files changed outside declared File Scope`,
    );
  }

  // In strict mode, scope violations block the merge
  if (strict && result.warnings.length > 0) {
    throw new Error(
      `Scope enforcement failed for ${taskId}: ${result.warnings.join("; ")}`,
    );
  }

  return result;
}

interface DiffBaseResolutionInput {
  cwd: string;
  headRef: string;
  baseBranch?: string;
  baseCommitSha?: string;
  integrationBranchFallback?: string;
  integrationRemoteFallback?: string;
}

/**
 * Resolve the commit ref used as diff base for task-scoped changed-file views.
 *
 * IMPORTANT: This ordering must stay in lockstep with dashboard `resolveDiffBase`
 * so merge-time scope warnings evaluate the exact same change set operators see.
 *
 * Strategy (priority order):
 * 1. Live merge-base between `headRef` and `{baseBranch}` (fallback to
 *    `origin/{baseBranch}` when local ref is missing).
 * 2. `baseCommitSha` when merge-base is unavailable or equals `headRef`, and
 *    the SHA is still an ancestor of `headRef`.
 * 3. `headRef~1` as last resort.
 */
export async function resolveTaskDiffBaseRef({
  cwd,
  headRef,
  baseBranch,
  baseCommitSha,
  integrationBranchFallback,
  integrationRemoteFallback,
}: DiffBaseResolutionInput): Promise<string | undefined> {
  // When baseBranch was nulled (e.g., upstream dep merged and its branch was
  // deleted) but a task-scoped baseCommitSha is still recorded, skip the
  // merge-base step so we don't widen the diff range to merge-base(HEAD, integration)
  // and surface unrelated history. Only fall back to the resolved integration
  // branch when neither hint is available.
  const fallbackBranch = integrationBranchFallback?.trim() || undefined;
  const fallbackRemote = integrationRemoteFallback?.trim() || undefined;
  const resolvedBaseBranch = baseBranch?.trim() || (baseCommitSha ? undefined : fallbackBranch);
  const quotedHeadRef = quoteArg(headRef);
  let mergeBase: string | undefined;

  if (resolvedBaseBranch) {
    try {
      try {
        const { stdout } = await execAsync(`git merge-base ${quotedHeadRef} ${quoteArg(resolvedBaseBranch)}`, {
          cwd,
          encoding: "utf-8",
        });
        mergeBase = stdout.trim() || undefined;
      } catch {
        if (!fallbackRemote) {
          throw new Error("missing integration remote fallback");
        }
        const { stdout } = await execAsync(`git merge-base ${quotedHeadRef} ${quoteArg(`${fallbackRemote}/${resolvedBaseBranch}`)}`, {
          cwd,
          encoding: "utf-8",
        });
        mergeBase = stdout.trim() || undefined;
      }
    } catch {
      // Base branch may not exist locally/remotely.
    }
  }

  // Same guard as dashboard routes: when merge-base === headRef, the range
  // would be empty, so prefer a still-valid task-scoped baseCommitSha.
  if (mergeBase) {
    try {
      const { stdout } = await execAsync(`git rev-parse ${quotedHeadRef}`, {
        cwd,
        encoding: "utf-8",
      });
      const headSha = stdout.trim();
      if (headSha && headSha !== mergeBase) return mergeBase;
    } catch {
      return mergeBase;
    }
  }

  // Display recovery (mirrors dashboard `resolveDiffBase` with
  // `enableDisplayRecovery: true`): when baseBranch is missing — common for
  // legacy/imported tasks — compute merge-base(headRef, integration branch) so
  // we can tighten an outdated-but-still-ancestor baseCommitSha after a
  // pre-merge rebase. Without this the scope warning compares against a stale
  // baseCommitSha and surfaces every unrelated commit landed on the integration
  // branch since the task forked.
  let recoveredBase: string | undefined;
  if (!baseBranch?.trim() && fallbackBranch) {
    try {
      const { stdout } = await execAsync(`git merge-base ${quotedHeadRef} ${quoteArg(fallbackBranch)}`, {
        cwd,
        encoding: "utf-8",
      });
      recoveredBase = stdout.trim() || undefined;
    } catch {
      if (fallbackRemote) {
        try {
          const { stdout } = await execAsync(`git merge-base ${quotedHeadRef} ${quoteArg(`${fallbackRemote}/${fallbackBranch}`)}`, {
            cwd,
            encoding: "utf-8",
          });
          recoveredBase = stdout.trim() || undefined;
        } catch {
          // no recovery available
        }
      }
    }
  }

  if (baseCommitSha) {
    try {
      await execAsync(`git merge-base --is-ancestor ${quoteArg(baseCommitSha)} ${quotedHeadRef}`, {
        cwd,
        encoding: "utf-8",
      });
      // Prefer recoveredBase only if it's strictly tighter (a descendant of
      // baseCommitSha). When baseCommitSha lives on a deleted feature branch
      // it won't be an ancestor of merge-base(HEAD, main), so we keep the
      // task-scoped SHA — preserves the FN-2855 nulled-baseBranch path.
      if (recoveredBase && recoveredBase !== baseCommitSha) {
        try {
          await execAsync(`git merge-base --is-ancestor ${quoteArg(baseCommitSha)} ${quoteArg(recoveredBase)}`, {
            cwd,
            encoding: "utf-8",
          });
          return recoveredBase;
        } catch {
          // recoveredBase not a descendant — keep baseCommitSha
        }
      }
      return baseCommitSha;
    } catch {
      // stale or unreachable — fall through
    }
  }

  if (recoveredBase) return recoveredBase;

  try {
    const { stdout } = await execAsync(`git rev-parse ${quoteArg(`${headRef}~1`)}`, {
      cwd,
      encoding: "utf-8",
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get list of conflicted files from git.
 * Runs `git diff --name-only --diff-filter=U` and returns array of file paths.
 */

/** Build the `-m "Fusion-Task-Id: <id>"` arg fragment used in fallback commit
 *  invocations. Returns a leading space + quoted -m arg. */
function buildTaskTrailerArgs(taskId: string, lineageId?: string): string {
  const taskIdTrailer = `${FUSION_TASK_ID_TRAILER_KEY}: ${taskId}`;
  const lineageArg = lineageId ? ` -m "${buildTaskLineageTrailer(lineageId)}"` : "";
  return ` -m "${taskIdTrailer}"${lineageArg}`;
}

/** True iff HEAD's commit message contains the `Fusion-Task-Id: <taskId>`
 *  trailer. Used by the in-merge fix finalizer to recognize that the merge
 *  commit already landed on HEAD (e.g. via the AI commit on a prior attempt)
 *  before tripping the phantom-merge guard. Best-effort: any error returns
 *  false so callers fall back to the conservative "refuse to fabricate" path. */
async function commitCarriesTaskIdTrailer(rootDir: string, taskId: string, commitish: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`git log -1 --pretty=%B ${quoteArg(commitish)}`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    // Anchor to line boundaries so e.g. FN-37 doesn't match a body line
    // mentioning FN-3727. Trailer lines are produced by git itself, so the
    // exact `Key: Value` form is what we look for.
    const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}: ${escapedId}\\s*(?:\\n|$)`);
    return pattern.test(stdout);
  } catch {
    return false;
  }
}

async function headCarriesTaskIdTrailer(rootDir: string, taskId: string): Promise<boolean> {
  return commitCarriesTaskIdTrailer(rootDir, taskId, "HEAD");
}

/** Idempotently add the Fusion-Task-Id trailer to HEAD's commit. Used after
 *  the AI agent commits to guarantee the trailer is present even when the
 *  agent didn't include it (especially under includeTaskIdInCommit=false,
 *  where the subject also lacks the task ID and recovery has nothing to
 *  grep against). No-op if the trailer is already on HEAD. */
async function ensureTaskTrailersOnHead(rootDir: string, task: Pick<Task, "id"> & { lineageId?: string }): Promise<void> {
  try {
    const { stdout: existingMessage } = await execAsync("git log -1 --pretty=%B", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const taskIdTrailer = `${FUSION_TASK_ID_TRAILER_KEY}: ${task.id}`;
    const trailersToAdd: string[] = [];
    if (!existingMessage.includes(taskIdTrailer)) trailersToAdd.push(taskIdTrailer);
    if (task.lineageId) {
      const lineageTrailer = buildTaskLineageTrailer(task.lineageId);
      if (!existingMessage.includes(lineageTrailer)) trailersToAdd.push(lineageTrailer);
    }
    if (trailersToAdd.length === 0) return;
    let amendCommand = "git -c trailer.ifExists=addIfDifferent commit --amend --no-edit";
    for (const trailer of trailersToAdd) {
      amendCommand += ` --trailer "${trailer}"`;
    }
    await execAsync(amendCommand, { cwd: rootDir, env: mergerCommitEnv() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`${task.id}: failed to add merge trailers to HEAD (${msg}) — relying on fallback ownership signals`);
  }
}

type CherryPickCommitResult = { landed: true } | { landed: false; reason: "empty" };

type CherryPickAttemptResult =
  | { kind: "landed" }
  | { kind: "empty"; recovery: "skip" | "abort-reset" };

async function runCherryPickWithEmptySkip(rootDir: string, args: string): Promise<CherryPickAttemptResult> {
  try {
    await execAsync(`git cherry-pick ${args}`, { cwd: rootDir });
    return { kind: "landed" };
  } catch (error) {
    if (!isEmptyCherryPickError(error)) {
      throw error;
    }

    try {
      await execAsync("git cherry-pick --skip", { cwd: rootDir });
      return { kind: "empty", recovery: "skip" };
    } catch {
      try {
        await execAsync("git cherry-pick --abort", { cwd: rootDir });
      } catch {
        // best effort
      }
      await execAsync("git reset --hard HEAD", { cwd: rootDir });
      return { kind: "empty", recovery: "abort-reset" };
    }
  }
}

export function isEmptyCherryPickError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = typeof maybe.stderr === "string" ? maybe.stderr : "";
  const stdout = typeof maybe.stdout === "string" ? maybe.stdout : "";
  const message = typeof maybe.message === "string" ? maybe.message : "";
  const output = `${stderr}\n${stdout}\n${message}`;

  return (
    output.includes("The previous cherry-pick is now empty")
    || output.includes("nothing to commit, working tree clean")
    || output.includes("otherwise, please use 'git cherry-pick --skip'")
    || output.includes("use 'git commit --allow-empty'")
  );
}

export async function isCherryPickInProgress(rootDir: string): Promise<boolean> {
  try {
    const { stdout: cherryPickHeadPathOut } = await execAsync("git rev-parse --git-path CHERRY_PICK_HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const cherryPickHeadPath = join(rootDir, cherryPickHeadPathOut.trim());
    if (existsSync(cherryPickHeadPath)) return true;

    const { stdout: sequencerPathOut } = await execAsync("git rev-parse --git-path sequencer", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const sequencerPath = join(rootDir, sequencerPathOut.trim());
    return existsSync(sequencerPath);
  } catch {
    return false;
  }
}

async function cherryPickCommitPreservingTaskTrailers(
  rootDir: string,
  commitSha: string,
  task: Pick<Task, "id"> & { lineageId?: string },
  mergeConflictStrategy: CanonicalMergeConflictStrategy,
  smartConflictResolution: boolean,
  result: MergeResult,
): Promise<CherryPickCommitResult> {
  try {
    const initialPick = await runCherryPickWithEmptySkip(rootDir, quoteArg(commitSha));
    if (initialPick.kind === "empty") {
      return { landed: false, reason: "empty" };
    }
  } catch (error) {
    const conflictedFiles = await getConflictedFiles(rootDir);
    if (conflictedFiles.length === 0) {
      throw error;
    }

    if (smartConflictResolution) {
      let unresolvedComplex = 0;
      for (const file of conflictedFiles) {
        const type = await classifyConflict(file, rootDir);
        if (type === "lockfile-ours") {
          await resolveWithOurs(file, rootDir);
          result.autoResolvedCount = (result.autoResolvedCount ?? 0) + 1;
        } else if (type === "generated-theirs") {
          await resolveWithTheirs(file, rootDir);
          result.autoResolvedCount = (result.autoResolvedCount ?? 0) + 1;
        } else if (type === "trivial-whitespace") {
          await resolveTrivialWhitespace(file, rootDir);
          result.autoResolvedCount = (result.autoResolvedCount ?? 0) + 1;
        } else {
          unresolvedComplex += 1;
        }
      }

      if (unresolvedComplex === 0) {
        await execAsync("git cherry-pick --continue", { cwd: rootDir });
        await ensureTaskTrailersOnHead(rootDir, task);
        return { landed: true };
      }
    }

    try {
      await execAsync("git cherry-pick --abort", { cwd: rootDir });
    } catch {
      // best effort
    }

    if (mergeConflictStrategy === "smart-prefer-main") {
      const fallbackPick = await runCherryPickWithEmptySkip(rootDir, `-X ours ${quoteArg(commitSha)}`);
      if (fallbackPick.kind === "empty") {
        return { landed: false, reason: "empty" };
      }
    } else if (mergeConflictStrategy === "smart-prefer-branch") {
      const fallbackPick = await runCherryPickWithEmptySkip(rootDir, `-X theirs ${quoteArg(commitSha)}`);
      if (fallbackPick.kind === "empty") {
        return { landed: false, reason: "empty" };
      }
    } else {
      throw error;
    }
  }

  await ensureTaskTrailersOnHead(rootDir, task);
  return { landed: true };
}

async function applyBranchCommitsPreservingHistory(params: {
  rootDir: string;
  baseRef: string;
  branch: string;
  task: Pick<Task, "id"> & { lineageId?: string };
  taskId: string;
  store: TaskStore;
  mergeConflictStrategy: CanonicalMergeConflictStrategy;
  smartConflictResolution: boolean;
  result: MergeResult;
  testCommand?: string;
  buildCommand?: string;
  testSource?: "explicit" | "inferred" | "inferred-scoped";
  buildSource?: "explicit" | "inferred";
  signal?: AbortSignal;
}): Promise<{ landedCommitCount: number; landedCommitShas: string[]; baseSha: string; fullySubsumedByMain: boolean; skippedEmptyCount: number }> {
  const { rootDir, baseRef, branch, task, taskId, store, mergeConflictStrategy, smartConflictResolution, result, testCommand, buildCommand, testSource, buildSource, signal } = params;
  const { stdout: baseShaStdout } = await execAsync(`git rev-parse ${quoteArg(baseRef)}`, { cwd: rootDir, encoding: "utf-8" });
  const baseSha = baseShaStdout.trim();
  const { stdout: originalBranchShaOut } = await execAsync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf-8" });
  const originalBranchSha = originalBranchShaOut.trim();
  const { stdout: commitStdout } = await execAsync(`git rev-list --reverse ${quoteArg(`${baseSha}..${branch}`)}`, {
    cwd: rootDir,
    encoding: "utf-8",
  });
  const commitShas = commitStdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const landedCommitShas: string[] = [];
  let skippedEmptyCount = 0;

  for (const commitSha of commitShas) {
    throwIfAborted(signal, taskId);
    const pickResult = await cherryPickCommitPreservingTaskTrailers(
      rootDir,
      commitSha,
      task,
      mergeConflictStrategy,
      smartConflictResolution,
      result,
    );
    if (!pickResult.landed) {
      skippedEmptyCount += 1;
      continue;
    }
    const { stdout: landedShaOut } = await execAsync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf-8" });
    landedCommitShas.push(landedShaOut.trim());
  }

  const fullySubsumedByMain = landedCommitShas.length === 0 && skippedEmptyCount === commitShas.length && commitShas.length > 0;
  if (fullySubsumedByMain) {
    await store.logEntry(taskId, `Auto-merge skipped: branch fully subsumed by main (${skippedEmptyCount} commit(s) already present)`);
  } else if (skippedEmptyCount > 0 && landedCommitShas.length > 0) {
    await store.logEntry(taskId, `Auto-merge skipped ${skippedEmptyCount} empty cherry-pick(s); proceeded with ${landedCommitShas.length} non-empty commit(s)`);
  }

  try {
    const { stdout: statusOut } = await execAsync("git status --porcelain", { cwd: rootDir, encoding: "utf-8" });
    const statusClean = statusOut.trim().length === 0;
    const cherryPickActive = await isCherryPickInProgress(rootDir);
    if (!statusClean || cherryPickActive) {
      mergerLog.warn(`${taskId}: cherry-pick cleanup invariant violated (statusClean=${statusClean}, cherryPickActive=${cherryPickActive}); attempting defensive recovery`);
      try {
        await execAsync("git cherry-pick --abort", { cwd: rootDir });
      } catch {
        // best effort
      }
      await execAsync(`git reset --hard ${quoteArg(originalBranchSha)}`, { cwd: rootDir });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mergerLog.warn(`${taskId}: failed while validating cherry-pick cleanup invariant (${message}); attempting defensive recovery`);
    try {
      await execAsync("git cherry-pick --abort", { cwd: rootDir });
    } catch {
      // best effort
    }
    try {
      await execAsync(`git reset --hard ${quoteArg(originalBranchSha)}`, { cwd: rootDir });
    } catch {
      // best effort
    }
  }

  if (testCommand || buildCommand) {
    throwIfAborted(signal, taskId);
    await runDeterministicVerification(
      store,
      rootDir,
      taskId,
      testCommand,
      buildCommand,
      testSource,
      buildSource,
      signal,
    );
  }

  return {
    landedCommitCount: landedCommitShas.length,
    landedCommitShas,
    baseSha,
    fullySubsumedByMain,
    skippedEmptyCount,
  };
}

/** Build the `-m "Co-authored-by: ..."` trailer arg for git commits based on
 *  project settings. The user's configured git identity remains the primary
 *  author/committer; Fusion (or whatever name/email is configured) is appended
 *  as a co-author trailer that GitHub recognizes for shared attribution. */
function getCommitAuthorArg(settings: {
  commitAuthorEnabled?: boolean;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
}): string {
  if (settings.commitAuthorEnabled === false) return "";
  const name = settings.commitAuthorName || "Fusion";
  const email = settings.commitAuthorEmail || "noreply@runfusion.ai";
  return ` -m "Co-authored-by: ${name} <${email}>"`;
}

export function buildSourceIssueRef(sourceIssue?: TaskSourceIssue | null): string {
  if (!sourceIssue || sourceIssue.provider !== "github" || !sourceIssue.repository) return "";

  const issueNumber = sourceIssue.issueNumber
    ?? Number.parseInt(sourceIssue.externalIssueId ?? "", 10);

  if (!Number.isInteger(issueNumber) || issueNumber < 1) return "";
  return `${sourceIssue.repository}#${issueNumber}`;
}

/**
 * Build the merge system prompt. When `includeTaskId` is true (default),
 * the commit format uses `<type>(<scope>): <summary>` where scope is the
 * task ID. When false, it uses `<type>: <summary>` with no scope.
 */
function buildMergeSystemPrompt(includeTaskId: boolean, agentPrompts?: AgentPromptsConfig, authorArg?: string): string {
  const commitFormat = includeTaskId
    ? `\`\`\`
git commit -m "<type>(<scope>): <summary>" -m "<body>"${authorArg || ""}
\`\`\`

Message format:
- **Type:** feat, fix, refactor, docs, test, chore
- **Scope:** the task ID (e.g., KB-001)
- **Summary:** one line describing what the squash brings in (imperative mood)
- **Body:** 2-5 bullet points summarizing the key changes, each starting with "- "
- **GitHub reference:** when the prompt includes a source issue reference, add \`Ref: owner/repo#N\` to the commit body
${authorArg ? `- **Co-author:** Always include the \`Co-authored-by\` trailer as shown in the example above so Fusion is credited alongside your git identity.` : ""}

Example:
\`\`\`
git commit -m "feat(KB-003): add user profile page" -m "- Add /profile route with avatar upload
- Create ProfileCard and EditProfileForm components
- Add profile image resizing via sharp
- Update nav bar with profile link
- Add profile e2e tests"${authorArg || ""}
\`\`\``
    : `\`\`\`
git commit -m "<type>: <summary>" -m "<body>"${authorArg || ""}
\`\`\`

Message format:
- **Type:** feat, fix, refactor, docs, test, chore
- **Summary:** one line describing what the squash brings in (imperative mood)
- **Body:** 2-5 bullet points summarizing the key changes, each starting with "- "
- **GitHub reference:** when the prompt includes a source issue reference, add \`Ref: owner/repo#N\` to the commit body
${authorArg ? `- **Co-author:** Always include the \`Co-authored-by\` trailer as shown in the example above so Fusion is credited alongside your git identity.` : ""}
Do NOT include a scope in the commit message type.

Example:
\`\`\`
git commit -m "feat: add user profile page" -m "- Add /profile route with avatar upload
- Create ProfileCard and EditProfileForm components
- Add profile image resizing via sharp
- Update nav bar with profile link
- Add profile e2e tests"${authorArg || ""}
\`\`\``;

  // Resolve the base merger prompt from agent prompts config, falling back to the inline default
  const basePrompt = resolveAgentPrompt("merger", agentPrompts);

  // If a custom merger prompt is configured, use it as the base with commit format appended
  const customAssignment = agentPrompts?.roleAssignments?.merger;
  if (customAssignment && basePrompt) {
    return `${basePrompt}

## Commit message
After all conflicts are resolved (or if there were none), write and execute the squash commit.

Look at the branch commits and diff to understand what was done, then run:
${commitFormat}

Do NOT use generic messages like "merge branch" or "resolve conflicts".
Base the message on the ACTUAL work done in the branch commits.

## Build verification

If a build command is configured for this project, build verification is a hard gate.
You MUST run the exact configured build command in this worktree before committing.
Do not assume the build passes. Do not describe it as passing unless you actually ran it
and the bash tool returned exit code 0.

1. Run the build command (shown in the prompt context below)
2. If the build succeeds (exit code 0), proceed with the commit
3. If the build fails (non-zero exit code), DO NOT commit. Instead:
   - Call the \`fn_report_build_failure\` tool with the real error details
   - Stop immediately and do not run \`git commit\`
   - Do not claim success in plain text

The merge will only be completed if the build passes or no build command is configured.`;
  }

  return `You are a merge agent for "fn", an AI-orchestrated task board.

## Your Role
You are the final integration gate between completed task work and mainline history.
Your responsibility is to preserve intent from both sides, avoid regressions, and produce a clean, auditable squash merge commit.

Your job is to finalize a squash merge: resolve any conflicts and write a good commit message.
All changes from the branch are squashed into a single commit.

## Conflict resolution
If there are merge conflicts:
1. Run \`git diff --name-only --diff-filter=U\` to list conflicted files
2. Read each conflicted file — look for the <<<<<<< / ======= / >>>>>>> markers
3. Understand the intent of BOTH sides, then edit the file to produce the correct merged result
4. Remove ALL conflict markers — the result must be clean, compilable code
5. Run \`git add <file>\` for each resolved file
6. Do NOT change anything beyond what's needed to resolve the conflict

Common conflict guidance:
- Preserve both sides when each contributes non-overlapping behavior.
- Choose one side only when the other is obsolete, duplicated, or clearly incorrect.
- When in doubt, reconcile explicitly and keep tests/build green as source of truth.

## Commit message
After all conflicts are resolved (or if there were none), write and execute the squash commit.

Look at the branch commits and diff to understand what was done, then run:
${commitFormat}

Do NOT use generic messages like "merge branch" or "resolve conflicts".
Base the message on the ACTUAL work done in the branch commits.

## Build verification

If a build command is configured for this project, build verification is a hard gate.
You MUST run the exact configured build command in this worktree before committing.
Do not assume the build passes. Do not describe it as passing unless you actually ran it
and the bash tool returned exit code 0.

1. Run the build command (shown in the prompt context below)
2. If the build succeeds (exit code 0), proceed with the commit
3. If the build fails (non-zero exit code), DO NOT commit. Instead:
   - Call the \`fn_report_build_failure\` tool with the real error details
   - Stop immediately and do not run \`git commit\`
   - Do not claim success in plain text

The merge will only be completed if the build passes or no build command is configured.`;
}

/**
 * Check if any non-done task (other than `excludeTaskId`) references the given
 * worktree path. Returns the first matching task ID, or null if the worktree
 * is safe to remove. Used by both the merger and executor cleanup to avoid
 * deleting worktrees that are shared across dependent tasks.
 */
export async function findWorktreeUser(
  store: TaskStore,
  worktreePath: string,
  excludeTaskId: string,
): Promise<string | null> {
  const tasks = await store.listTasks({ slim: true, includeArchived: false });
  for (const t of tasks) {
    if (t.id === excludeTaskId) continue;
    if (t.worktree === worktreePath && t.column !== "done") {
      return t.id;
    }
  }
  return null;
}

export interface MergerOptions {
  /**
   * When true, skip scheduler-transient status blockers (`queued`).
   * Hard guards (paused, column, incomplete steps, in-flight merge,
   * failed pre-merge workflow steps) still apply. Set by `ProjectEngine.onMerge`.
   */
  manual?: boolean;
  /** Called with agent text output */
  onAgentText?: (delta: string) => void;
  /** Called with agent tool usage */
  onAgentTool?: (toolName: string) => void;
  /** Worktree pool — when provided and `recycleWorktrees` is enabled,
   *  worktrees are released to the pool instead of being removed. */
  pool?: WorktreePool;
  /** Usage limit pauser — triggers global pause when API limits are detected. */
  usageLimitPauser?: UsageLimitPauser;
  /** Called with the agent session immediately after creation. Enables the
   *  caller (e.g. dashboard.ts) to track and externally dispose the session
   *  when a global pause is triggered. */
  onSession?: (session: { dispose: () => void }) => void;
  /** Abort signal used to stop an in-flight merge when the engine is shutting down. */
  signal?: AbortSignal;
  /** AgentStore for resolving per-agent custom instructions. */
  agentStore?: import("@fusion/core").AgentStore;
  /** Allow synchronization when local checkout is dirty during merge reconciliation. */
  allowDirtyLocalCheckoutSync?: boolean;
  /** Plugin runner for runtime selection. When provided, enables plugin runtime lookup. */
  pluginRunner?: import("./plugin-runner.js").PluginRunner;
  /**
   * Injected group-PR sync callback (KTD7, U6). When a shared branch-group
   * member lands and its group has a persisted open PR, the merger uses this to
   * push an updated PR body (member checklist + x/N completion). Failures are
   * non-fatal and retryable on the next landing. Injected from the CLI layer so
   * the engine never imports the dashboard GitHub client.
   */
  syncGroupPr?: import("./group-merge-coordinator.js").SyncGroupPrFn;
  /**
   * Test seam (T14): the group-PR sync is fired-and-forgotten so a hung GitHub
   * call can never stall merge completion. When provided, the merger hands the
   * background sync promise here so deterministic tests can `await` it instead of
   * racing the fire-and-forget. Production callers omit this.
   */
  onGroupPrSyncSettled?: (settled: Promise<void>) => void;
}

function quoteArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export async function captureSingleCommitLandedMetadata(
  rootDir: string,
  sha: string,
): Promise<Pick<MergeDetails, "landedFiles" | "filesChanged" | "insertions" | "deletions">> {
  const [{ stdout: landedFilesOutput }, { stdout: shortstatOutput }] = await Promise.all([
    execAsync(`git show --name-only --format= ${quoteArg(sha)}`, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    }),
    execAsync(`git show --shortstat --format= ${quoteArg(sha)}`, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    }),
  ]);
  const landedFiles = Array.from(new Set(
    landedFilesOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ));
  return {
    landedFiles,
    ...parseShortstatSummary(shortstatOutput),
  };
}

/**
 * Sums per-commit shortstat output for owned commits. This is intentionally
 * per-commit (instead of range-based) so rebased/cherry-picked SHAs do not
 * require contiguous ancestry assumptions.
 */
export async function sumShortstatsForCommits(
  rootDir: string,
  ownCommitShas: string[],
): Promise<{ insertions: number; deletions: number }> {
  let insertions = 0;
  let deletions = 0;
  for (const sha of ownCommitShas) {
    const { stdout } = await execAsync(`git show --shortstat --format= ${quoteArg(sha)}`, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = parseShortstatSummary(stdout);
    insertions += parsed.insertions;
    deletions += parsed.deletions;
  }
  return { insertions, deletions };
}

export async function captureRebaseLandedFilesForTask(params: {
  rootDir: string;
  rebaseMergeBaseSha: string;
  recordedSha: string;
  taskId: string;
  sourceBranchRef?: string;
  onAttributionFailure?: (message: string) => Promise<void> | void;
  onNoOpGuardSkipped?: (reason: "source-ref-unavailable") => Promise<void> | void;
  attributionExecAsyncImpl?: (command: string, options: { cwd?: string; encoding?: BufferEncoding; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>;
}): Promise<{
  landedFiles: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  noOpVerifiedShortCircuit?: boolean;
  landedFilesAttributionRestricted?: boolean;
  landedFilesCaptureFallback?: MergeDetails["landedFilesCaptureFallback"];
}> {
  const {
    rootDir,
    rebaseMergeBaseSha,
    recordedSha,
    taskId,
    sourceBranchRef,
    onAttributionFailure,
    onNoOpGuardSkipped,
    attributionExecAsyncImpl,
  } = params;
  try {
    const attribution = await filterFilesToOwnTaskCommits({
      worktreePath: rootDir,
      baseRef: rebaseMergeBaseSha,
      taskId,
      execAsyncImpl: attributionExecAsyncImpl as any,
    });
    if (attribution.ownCommitCount === 0) {
      if (sourceBranchRef && sourceBranchRef !== recordedSha) {
        const sourceRange = `${rebaseMergeBaseSha}..${sourceBranchRef}`;
        try {
          const sourceAttribution = await collectOwnTaskCommitsForRange({
            worktreePath: rootDir,
            rangeRef: sourceRange,
            taskId,
            execAsyncImpl: attributionExecAsyncImpl as any,
          });
          if (sourceAttribution.ownCommitCount > 0) {
            throw new SilentNoOpAttributionMismatchError({
              taskId,
              recordedSha,
              rebaseMergeBaseSha,
              sourceBranchRef,
              sourceBranchOwnCommitCount: sourceAttribution.ownCommitCount,
              sourceBranchOwnCommitShas: sourceAttribution.ownCommitShas,
            });
          }
        } catch (error) {
          if (error instanceof SilentNoOpAttributionMismatchError) {
            throw error;
          }
          await onNoOpGuardSkipped?.("source-ref-unavailable");
        }
      }

      return {
        landedFiles: [],
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        noOpVerifiedShortCircuit: true,
        landedFilesAttributionRestricted: true,
      };
    }

    const landedFiles = attribution.files;
    const stats = await sumShortstatsForCommits(rootDir, attribution.ownCommitShas ?? []);
    return {
      landedFiles,
      filesChanged: landedFiles.length,
      insertions: stats.insertions,
      deletions: stats.deletions,
      landedFilesAttributionRestricted: true,
    };
  } catch (error) {
    if (error instanceof SilentNoOpAttributionMismatchError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (onAttributionFailure) {
      await onAttributionFailure(message);
    }
    const { stdout: landedFilesOutput } = await execAsync(
      `git diff --name-only ${quoteArg(`${rebaseMergeBaseSha}..${recordedSha}`)}`,
      { cwd: rootDir, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
    );
    const landedFiles = landedFilesOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const { stdout: statsOutput } = await execAsync(`git diff --shortstat ${quoteArg(`${rebaseMergeBaseSha}..HEAD`)}`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const parsed = parseShortstatSummary(statsOutput);
    return {
      landedFiles: landedFiles.length > 0 ? Array.from(new Set(landedFiles)) : [],
      filesChanged: parsed.filesChanged,
      insertions: parsed.insertions,
      deletions: parsed.deletions,
      landedFilesCaptureFallback: "attribution-failed",
    };
  }
}

function parseDirectMergeCommitStrategyOverride(prompt: string | undefined): DirectMergeCommitStrategy | undefined {
  if (!prompt) return undefined;
  const match = prompt.match(/^\*\*Direct Merge Commit Strategy:\*\*\s*(auto|always-squash|always-rebase)\s*$/im);
  return match?.[1] as DirectMergeCommitStrategy | undefined;
}

function resolveDirectMergeCommitStrategy(
  settings: Pick<Settings, "directMergeCommitStrategy">,
  prompt: string | undefined,
): { strategy: DirectMergeCommitStrategy; source: "project" | "prompt" } {
  const promptOverride = parseDirectMergeCommitStrategyOverride(prompt);
  if (promptOverride) {
    return { strategy: promptOverride, source: "prompt" };
  }
  return {
    strategy: settings.directMergeCommitStrategy ?? "always-squash",
    source: "project",
  };
}

interface BranchCommitClassification {
  sha: string;
  subject: string;
  substantive: boolean;
}

function isGeneratedOnlyPath(filePath: string): boolean {
  return GENERATED_PATTERNS.some((pattern) => matchGlob(filePath, pattern))
    || LOCKFILE_PATTERNS.some((pattern) => matchGlob(filePath, pattern));
}

function isNonSubstantiveCommitChange(change: { status: string; filePath: string }): boolean {
  if (change.filePath.startsWith(".changeset/")) {
    return change.status === "A";
  }
  return isGeneratedOnlyPath(change.filePath);
}

async function classifyBranchCommitsForDirectMerge(
  rootDir: string,
  baseRef: string,
  branch: string,
): Promise<{ commits: BranchCommitClassification[]; substantiveCommitCount: number }> {
  const { stdout: commitStdout } = await execAsync(`git rev-list --reverse ${quoteArg(`${baseRef}..${branch}`)}`, {
    cwd: rootDir,
    encoding: "utf-8",
  });
  const commitShas = commitStdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const commits: BranchCommitClassification[] = [];

  for (const sha of commitShas) {
    let subject = sha;
    try {
      const { stdout } = await execAsync(`git log -1 --format=%s ${quoteArg(sha)}`, {
        cwd: rootDir,
        encoding: "utf-8",
      });
      subject = stdout.trim() || sha;
    } catch {
      // best-effort subject lookup
    }

    let substantive = true;
    try {
      const { stdout } = await execAsync(`git diff-tree --root --no-commit-id --name-status -r ${quoteArg(sha)}`, {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const changes = stdout
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [status, ...pathParts] = line.split(/\s+/);
          return { status: status ?? "", filePath: pathParts[pathParts.length - 1] ?? "" };
        })
        .filter((change) => change.filePath);
      substantive = changes.length === 0 || changes.some((change) => !isNonSubstantiveCommitChange(change));
    } catch {
      substantive = true;
    }

    commits.push({ sha, subject, substantive });
  }

  return {
    commits,
    substantiveCommitCount: commits.filter((commit) => commit.substantive).length,
  };
}

function shouldRunPostMergeAudit(
  strategy: PostMergeAuditStrategy,
  result: MergeResult,
  mergeWasEmpty: boolean,
  isEmptyCommit: boolean,
  commitSha?: string,
): boolean {
  if (mergeWasEmpty || isEmptyCommit || !commitSha) {
    return false;
  }
  if (strategy === "rebase") {
    return true;
  }
  return (result.autoResolvedCount ?? 0) > 0 || result.attemptsMade === 3;
}

export interface ResolvePostMergeAuditInvocationInput {
  rootDir: string;
  strategy: PostMergeAuditStrategy;
  auditSha: string;
  rebaseMergeBaseSha?: string;
  diffBaseRef?: string;
  mergeTargetBranch: string;
  taskBaseCommitSha?: string;
  taskId: string;
  store: Pick<TaskStore, "appendAgentLog">;
  mergerLog: { warn: (message: string) => void; log: (message: string) => void; };
}

async function resolveAuditRangeBaseCandidate(opts: {
  rootDir: string;
  auditSha: string;
  candidateRef: string;
}): Promise<string | undefined> {
  const candidateRef = opts.candidateRef.trim();
  if (!candidateRef) return undefined;

  try {
    const { stdout: resolvedOut } = await execAsync(`git rev-parse --verify ${quoteArg(`${candidateRef}^{commit}`)}`, {
      cwd: opts.rootDir,
      encoding: "utf-8",
    });
    const resolvedSha = resolvedOut.trim();
    if (!resolvedSha || resolvedSha === opts.auditSha) {
      return undefined;
    }

    await execAsync(`git merge-base --is-ancestor ${quoteArg(resolvedSha)} ${quoteArg(opts.auditSha)}`, {
      cwd: opts.rootDir,
      encoding: "utf-8",
    });
    return resolvedSha;
  } catch {
    return undefined;
  }
}

export async function resolvePostMergeAuditInvocation(
  opts: ResolvePostMergeAuditInvocationInput,
): Promise<PostMergeAuditInput> {
  if (opts.strategy === "squash") {
    return {
      rootDir: opts.rootDir,
      strategy: "squash",
      squashSha: opts.auditSha,
    };
  }

  if (opts.rebaseMergeBaseSha && opts.rebaseMergeBaseSha !== opts.auditSha) {
    return {
      rootDir: opts.rootDir,
      strategy: "rebase",
      rangeBaseSha: opts.rebaseMergeBaseSha,
      rangeHeadSha: opts.auditSha,
    };
  }

  const rangeCandidates: Array<{ source: "diffBaseRef" | "baseCommitSha"; ref?: string }> = [
    { source: "diffBaseRef", ref: opts.diffBaseRef },
    { source: "baseCommitSha", ref: opts.taskBaseCommitSha },
  ];

  for (const candidate of rangeCandidates) {
    if (!candidate.ref?.trim()) continue;
    const resolved = await resolveAuditRangeBaseCandidate({
      rootDir: opts.rootDir,
      auditSha: opts.auditSha,
      candidateRef: candidate.ref,
    });
    if (!resolved) continue;

    const infoMessage = `${opts.taskId}: post-merge audit using rebase range base from ${candidate.source} (${resolved.slice(0, 8)}..${opts.auditSha.slice(0, 8)})`;
    opts.mergerLog.log(infoMessage);
    await opts.store.appendAgentLog(opts.taskId, infoMessage, "status", undefined, "merger");
    return {
      rootDir: opts.rootDir,
      strategy: "rebase",
      rangeBaseSha: resolved,
      rangeHeadSha: opts.auditSha,
    };
  }

  let mergeBaseSha: string | undefined;
  try {
    const { stdout } = await execAsync(`git merge-base ${quoteArg(opts.auditSha)} ${quoteArg(opts.mergeTargetBranch)}`, {
      cwd: opts.rootDir,
      encoding: "utf-8",
    });
    const mergeBaseRef = stdout.trim();
    if (mergeBaseRef) {
      mergeBaseSha = await resolveAuditRangeBaseCandidate({
        rootDir: opts.rootDir,
        auditSha: opts.auditSha,
        candidateRef: mergeBaseRef,
      });
    }
  } catch {
    mergeBaseSha = undefined;
  }

  if (mergeBaseSha) {
    const infoMessage = `${opts.taskId}: post-merge audit using rebase range base from merge-base (${mergeBaseSha.slice(0, 8)}..${opts.auditSha.slice(0, 8)})`;
    opts.mergerLog.log(infoMessage);
    await opts.store.appendAgentLog(opts.taskId, infoMessage, "status", undefined, "merger");
    return {
      rootDir: opts.rootDir,
      strategy: "rebase",
      rangeBaseSha: mergeBaseSha,
      rangeHeadSha: opts.auditSha,
    };
  }

  const degradedMessage = `${opts.taskId}: post-merge audit degraded to single-commit squash fallback (multi-commit branch, no usable rangeBase)`;
  opts.mergerLog.warn(degradedMessage);
  await opts.store.appendAgentLog(opts.taskId, degradedMessage, "status", undefined, "merger");
  return {
    rootDir: opts.rootDir,
    strategy: "squash",
    squashSha: opts.auditSha,
  };
}

/**
 * Decide what to do with a dirty post-merge audit (FN-4333 hot-fix).
 *
 * Three modes (`postMergeAuditMode` setting):
 *  - `"off"`   — caller should skip auditing entirely (handled before this fn).
 *  - `"warn"`  — log findings on the agent log but proceed; never throws.
 *  - `"block"` — today's behavior: throw `SquashAuditError` and park the task,
 *                EXCEPT for the deterministic-verification short-circuit:
 *                rebase-strategy + overlap-only findings + a verified merged tree
 *                cannot have produced silent drops (the tree is provably the
 *                rebase output by construction), so we pass through clean.
 *
 * Pure / side-effect-free so it is unit-testable without spinning up a real
 * merger flow. The merger call site uses the returned action to decide whether
 * to throw or fall through.
 */
export type PostMergeAuditAction =
  | { action: "pass"; reason: "verified-short-circuit" | "mode-warn" }
  | { action: "block"; reason: "mode-block" };

export function resolvePostMergeAuditAction(opts: {
  mode: PostMergeAuditMode;
  strategy: PostMergeAuditStrategy;
  findings: SquashAuditFindings;
  verificationPassed: boolean;
}): PostMergeAuditAction {
  if (opts.findings.clean) {
    // Caller should never invoke this on a clean audit, but be defensive.
    return { action: "pass", reason: "mode-warn" };
  }

  const overlapOnly =
    opts.findings.duplicateSubjects.length === 0
    && opts.findings.touchedFileOverlaps.length > 0;

  // Stage 1 short-circuit: a verified rebase tree with overlap-only findings
  // cannot have produced silent drops. Pass regardless of mode (warn/block).
  if (
    opts.strategy === "rebase"
    && overlapOnly
    && opts.verificationPassed
  ) {
    return { action: "pass", reason: "verified-short-circuit" };
  }

  if (opts.mode === "warn") {
    return { action: "pass", reason: "mode-warn" };
  }

  return { action: "block", reason: "mode-block" };
}

export async function handleDirtyPostMergeAuditOutcome(opts: {
  taskId: string;
  auditSha: string;
  mode: PostMergeAuditMode;
  strategy: PostMergeAuditStrategy;
  findings: SquashAuditFindings;
  verificationPassed: boolean;
  audit: RunAuditor;
  store: TaskStore;
  mergerLog: { warn: (message: string) => void; log: (message: string) => void; };
}): Promise<PostMergeAuditAction> {
  const decision = resolvePostMergeAuditAction({
    mode: opts.mode,
    strategy: opts.strategy,
    findings: opts.findings,
    verificationPassed: opts.verificationPassed,
  });

  try {
    await opts.audit.git({
      type: "merge:audit-failure",
      target: opts.auditSha,
      metadata: {
        mode: opts.mode,
        strategy: opts.strategy,
        action: decision.action,
        reason: decision.reason,
        issueCount: opts.findings.issueCount,
        duplicateSubjectCount: opts.findings.duplicateSubjects.length,
        touchedFileOverlapCount: opts.findings.touchedFileOverlaps.length,
        verificationPassed: opts.verificationPassed,
        auditTargetLabel: opts.findings.auditTargetLabel,
      },
    });
  } catch (err) {
    opts.mergerLog.warn(`${opts.taskId}: failed to record merge:audit-failure run_audit event: ${String(err)}`);
  }

  if (decision.action === "block") {
    const auditError = new SquashAuditError(opts.taskId, opts.auditSha, opts.findings);
    await opts.store.appendAgentLog(
      opts.taskId,
      auditError.message,
      "tool_error",
      formatSquashAuditAgentLog(opts.findings),
      "merger",
    );
    await opts.store.updateTask(opts.taskId, { status: null });
    throw auditError;
  }

  const passLabel = decision.reason === "verified-short-circuit"
    ? `${opts.strategy === "rebase" ? "post-rebase" : "post-squash"} audit overlap cleared by deterministic verification`
    : `${opts.strategy === "rebase" ? "post-rebase" : "post-squash"} audit found ${opts.findings.issueCount} risk(s) — continuing (mode=warn)`;
  await opts.store.appendAgentLog(
    opts.taskId,
    passLabel,
    "status",
    formatSquashAuditAgentLog(opts.findings),
    "merger",
  );
  opts.mergerLog.log(`${opts.taskId}: ${passLabel}`);
  return decision;
}

function buildPostMergeAuditBlockingMessage(taskId: string, findings: SquashAuditFindings): string {
  const riskParts: string[] = [];
  if (findings.duplicateSubjects.length > 0) {
    riskParts.push(`${findings.duplicateSubjects.length} duplicate-subject risk${findings.duplicateSubjects.length === 1 ? "" : "s"}`);
  }
  if (findings.touchedFileOverlaps.length > 0) {
    riskParts.push(`${findings.touchedFileOverlaps.length} touched-file overlap risk${findings.touchedFileOverlaps.length === 1 ? "" : "s"}`);
  }
  const summary = riskParts.length > 0 ? riskParts.join(", ") : `${findings.issueCount} audit finding(s)`;
  const label = findings.strategy === "rebase" ? "post-rebase range audit" : "post-squash audit";
  return `${taskId}: ${label} blocked auto-completion for ${findings.auditTargetLabel.slice(0, 8)} (${summary})`;
}

export class SquashAuditError extends Error {
  constructor(
    taskId: string,
    public readonly squashSha: string,
    public readonly findings: SquashAuditFindings,
  ) {
    super(buildPostMergeAuditBlockingMessage(taskId, findings));
    this.name = "SquashAuditError";
  }
}

function formatSquashAuditAgentLog(findings: SquashAuditFindings): string {
  const lines: string[] = [];
  if (findings.duplicateSubjects.length > 0) {
    lines.push("Duplicate-subject risks:");
    for (const duplicate of findings.duplicateSubjects) {
      lines.push(`- ${duplicate.subject}`);
    }
  }
  if (findings.touchedFileOverlaps.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Touched-file overlap risks:");
    for (const overlap of findings.touchedFileOverlaps) {
      lines.push(`- ${overlap.file}`);
      for (const commit of overlap.recentMainCommits) {
        lines.push(`  - ${commit.sha} ${commit.subject}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Resolve a non-empty commit body for fallback merge commits. Used by sites
 * that would otherwise emit `-m ""` when the branch's commit log is empty
 * (no unique commits, `git log` failed, etc.).
 *
 * Cascade — most informative first, deterministic fallback at the end so
 * the function NEVER returns an empty string and NEVER throws:
 *   1. The branch's commit log if non-empty.
 *   2. AI-generated body via `summarizeCommitBody` from `@fusion/core`,
 *      using the title-summarizer model lane when configured. Bounded by
 *      a timeout; any failure / timeout / empty response falls through.
 *   3. The diff stat formatted as a "Files changed" listing.
 *   4. A synthetic `- merge <branch>` placeholder.
 */
async function resolveSafeCommitBody(opts: {
  rootDir: string;
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat: string;
  settings: Settings;
  signal?: AbortSignal;
  aiTimeoutMs?: number;
}): Promise<string> {
  const cleanLog = opts.commitLog.trim();
  if (cleanLog.length > 0) return cleanLog;

  const cleanStat = opts.diffStat.trim();
  if (cleanStat.length > 0) {
    if (opts.settings.useAiMergeCommitSummary) {
      // Prefer the dedicated title-summarization lane and its documented
      // fallbacks. The core `summarizeCommitBody` helper handles missing-runtime
      // / timeout / empty response gracefully and returns null.
      const resolved = resolveTitleSummarizerSettingsModel(opts.settings);

      const ai = await summarizeCommitBody(cleanStat, opts.rootDir, resolved.provider, resolved.modelId, {
        branch: opts.branch,
        taskId: opts.taskId,
        signal: opts.signal,
        timeoutMs: opts.aiTimeoutMs,
      }).catch(() => null);
      if (ai && ai.trim().length > 0) return ai.trim();
    }
    return `Files changed:\n\n${cleanStat}`;
  }

  return `- merge ${opts.branch}`;
}

/**
 * Compute `git patch-id` for a single commit. Returns the patch-id string on
 * success or undefined when the commit has no diff (root, empty merge) or the
 * pipeline failed. Patch-ids are stable across squash/cherry-pick operations
 * — two commits with the same logical change produce the same patch-id even
 * if their tree/parent SHAs differ.
 */
async function commitPatchId(rootDir: string, sha: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(
      `git diff-tree -p ${quoteArg(sha)} | git patch-id --stable`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const line = stdout.trim();
    if (!line) return undefined;
    // Output format: "<patch-id> <commit-sha>"; we only need the first token.
    const [pid] = line.split(/\s+/, 1);
    return pid || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collect patch-ids for the last `windowSize` commits reachable from `target`.
 * Bounded so we don't pay for full-repo scans on large histories. The window
 * is large enough to catch typical squash-merge orphans (which match recent
 * main commits) without being expensive.
 */
async function collectPatchIds(
  rootDir: string,
  target: string,
  windowSize: number,
): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const { stdout } = await execAsync(
      `git log -n ${Math.max(1, windowSize)} --format=%H ${quoteArg(target)}`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const shas = stdout.trim().split("\n").filter(Boolean);
    for (const sha of shas) {
      const pid = await commitPatchId(rootDir, sha);
      if (pid) ids.add(pid);
    }
  } catch {
    // Fall through with whatever we collected; caller treats empty as
    // "no duplicates found, proceed without stripping".
  }
  return ids;
}

/**
 * Compute the actual content of the merge commit being finalized, expressed as
 * `{ commitLog, diffStat }` ready to feed into `buildDeterministicMergeMessage`.
 *
 * The wide-range values gathered before merge (`baseCommitSha..branch`) are
 * unreliable as commit-message context in a squash-merge workflow: when an
 * earlier task is squash-merged onto `main`, branches that forked off the
 * pre-squash `main` no longer share ancestry with it, so `merge-base(branch,
 * main)` resolves to a point *before* the earlier task — and the resulting
 * diffstat/commitLog describe work that was already merged via the prior
 * squash. The commit message then talks about files that aren't in the diff.
 *
 * This helper computes truth from content:
 * - `diffStat` = `git diff --cached <integrationTargetSha> --stat` when there
 *   are staged changes (covers both the pre-commit and amend-with-staged
 *   paths), otherwise `git diff <integrationTargetSha> HEAD --stat` (covers
 *   the message-only amend path where the commit already exists).
 * - `commitLog` = subjects of `git log integrationTarget..branch`, with
 *   already-squashed commits filtered out by patch-id (using
 *   `collectPatchIds` / `commitPatchId`, the same primitives the rest of the
 *   merger uses for orphan detection).
 *
 * Best-effort: any git failure returns an empty string for that field, and
 * the caller's downstream fallback (`buildDeterministicMergeMessage`) handles
 * empty inputs gracefully.
 */
async function computeActualMergeCommitContext(params: {
  rootDir: string;
  integrationTargetSha: string;
  branch: string;
}): Promise<{ commitLog: string; diffStat: string }> {
  const { rootDir, integrationTargetSha, branch } = params;
  const targetArg = quoteArg(integrationTargetSha);

  let diffStat = "";
  try {
    const { stdout: stagedStat } = await execAsync(
      `git diff --cached ${targetArg} --stat`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    diffStat = stagedStat.trim();
    if (diffStat.length === 0) {
      const { stdout: headStat } = await execAsync(
        `git diff ${targetArg} HEAD --stat`,
        { cwd: rootDir, encoding: "utf-8" },
      );
      diffStat = headStat.trim();
    }
  } catch {
    // best-effort
  }

  let commitLog = "";
  try {
    const targetPatchIds = await collectPatchIds(rootDir, integrationTargetSha, 200);
    const { stdout: branchShas } = await execAsync(
      `git log ${targetArg}..${quoteArg(branch)} --format=%H`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    const shas = branchShas.trim().split("\n").filter(Boolean);
    const lines: string[] = [];
    for (const sha of shas) {
      const pid = await commitPatchId(rootDir, sha);
      if (pid && targetPatchIds.has(pid)) continue;
      try {
        const { stdout: subj } = await execAsync(
          `git log -1 ${quoteArg(sha)} --format=%s`,
          { cwd: rootDir, encoding: "utf-8" },
        );
        const s = subj.trim();
        if (s) lines.push(`- ${s}`);
      } catch {
        // skip this commit on failure
      }
    }
    commitLog = lines.join("\n");
  } catch {
    // best-effort
  }

  return { commitLog, diffStat };
}

/**
 * List commits unique to `branch` relative to `target`, oldest-first so they
 * can be cherry-picked in order.
 */
async function listBranchCommits(
  rootDir: string,
  target: string,
  branch: string,
): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `git log --reverse --format=%H ${quoteArg(target)}..${quoteArg(branch)}`,
      { cwd: rootDir, encoding: "utf-8" },
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: string | Buffer }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.toString().trim()) return stderr.toString().trim();
    return error.message;
  }
  return String(error);
}

/*
FNXC:MergePush 2026-07-11-22:10:
Exported for the unified AI merge path (merger-ai.ts pushAfterMergeToRemote): the production
runAiMerge pipeline needs the same rejected-push classification the legacy step-8b path used,
so divergence (remote moved) can be distinguished from hard failures (auth, missing remote).
*/
export function isNonFastForwardPushError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("non-fast-forward")
    || normalized.includes("[rejected]")
    || normalized.includes("fetch first")
    || normalized.includes("failed to push some refs");
}

function isRebaseInProgress(rootDir: string): boolean {
  try {
    execSync("git rev-parse --verify REBASE_HEAD", {
      cwd: rootDir,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/*
FNXC:MergePush 2026-07-11-22:10:
Exported for the unified AI merge path (merger-ai.ts pushAfterMergeToRemote) so the
`pushRemote` setting keeps one parser: "origin" (target branch defaults to the integration
branch) or "origin main" (explicit remote + target branch).
*/
export function parsePushRemoteTarget(rootDir: string, pushRemote?: string, fallbackBranch?: string): { remote: string; branch: string } {
  const rawTarget = pushRemote?.trim() || "origin";
  const [remoteToken, ...branchTokens] = rawTarget.split(/\s+/).filter(Boolean);
  const remote = remoteToken || "origin";

  let branch = branchTokens.join(" ").trim();
  if (!branch) {
    /*
    FNXC:MergePush 2026-07-04-09:31:
    Remote-only push targets must resolve to the merge integration branch, not the incidental HEAD of the worktree running post-merge git. Reuse-task-worktree can detach HEAD after advancing refs/heads/<integration>, so the direct merge call site supplies the authoritative integration branch before this helper falls back to symbolic-ref for standalone utility callers.
    */
    branch = fallbackBranch?.trim() || "";
  }
  if (!branch) {
    branch = execSyncText("git symbolic-ref --short HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  }

  if (!branch) {
    throw new Error(`Unable to determine branch for push target "${rawTarget}"`);
  }

  return { remote, branch };
}

async function resolveComplexRebaseConflictsWithAi(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  settings: Settings,
  conflictedFiles: string[],
  options?: {
    onAgentText?: (delta: string) => void;
    pluginRunner?: import("./plugin-runner.js").PluginRunner;
    signal?: AbortSignal;
    runtimeHint?: string;
    assignedAgentRuntimeConfig?: Record<string, unknown>;
    onSession?: (session: { dispose: () => void }) => void;
  },
): Promise<void> {
  mergerLog.log(`${taskId}: resolving ${conflictedFiles.length} complex rebase conflict(s) with AI`);

  const includeTaskId = settings.includeTaskIdInCommit !== false;
  const authorArg = getCommitAuthorArg(settings);
  const basePrompt = buildMergeSystemPrompt(includeTaskId, settings.agentPrompts, authorArg);
  const systemPrompt = `${basePrompt}

## Rebase conflict-only mode
You are assisting with a paused \`git pull --rebase\`.
- Resolve conflicted files and stage them with \`git add\`.
- Do NOT run \`git commit\`, \`git merge\`, or \`git rebase --continue\`.
- Do NOT perform unrelated edits outside conflicted files.
- Finish when all conflicts are resolved and staged.`;

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
    persistAgentToolOutput: settings.persistAgentToolOutput,
    // Merger agents are task-scoped ephemeral workers.
    persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
    onAgentText: options?.onAgentText
      ? (_id, delta) => options.onAgentText?.(delta)
      : undefined,
  });

  throwIfAborted(options?.signal, taskId);
  const mergerSessionModel = resolveMergerSessionModel(settings, options?.assignedAgentRuntimeConfig);

  // FNXC:Settings-MergerModel 2026-07-16-00:00: merger retries use the dedicated project fallback lane before the shared global fallback pair.

  const mergerFallbackModel = resolveMergerFallbackModel(settings);
  const { session } = await createResolvedAgentSession({
    sessionPurpose: "merger",
    runtimeHint: options?.runtimeHint,
    pluginRunner: options?.pluginRunner,
    cwd: rootDir,
    systemPrompt,
    tools: "coding",
    onText: agentLogger.onText,
    onThinking: agentLogger.onThinking,
    onToolStart: agentLogger.onToolStart,
    onToolEnd: agentLogger.onToolEnd,
    defaultProvider: mergerSessionModel.provider,
    defaultModelId: mergerSessionModel.modelId,
    fallbackProvider: mergerFallbackModel.provider,
    fallbackModelId: mergerFallbackModel.modelId,
    fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings),
    defaultThinkingLevel: resolveMergerThinkingLevel(settings),
    runAuditor: createRunAuditor(store, {
      runId: generateSyntheticRunId("merge", taskId),
      agentId: "merger",
      taskId,
      phase: "merge",
      source: "merger",
    }),
    settings,
    mcpServers: await resolveMergerMcpServers(store),
    taskId,
    onFallbackModelUsed: createFallbackModelObserver({
      agent: "merger",
      label: "rebase conflict resolver",
      store,
      taskId,
    }),
  });
  // Register so engine.stop() can dispose this session — without this, an
  // in-progress rebase conflict resolution keeps streaming past shutdown
  // (the engine only tracks the autostash session by default).
  options?.onSession?.(session);

  const prompt = [
    `Resolve rebase conflicts for task ${taskId}.`,
    "",
    "Conflicted files:",
    ...conflictedFiles.map((file) => `- ${file}`),
    "",
    "After resolving each file, stage it with `git add <file>`. Do not create a commit.",
  ].join("\n");

  try {
    await withRateLimitRetry(async () => {
      throwIfAborted(options?.signal, taskId);
      await promptWithFallback(session, prompt);
      checkSessionError(session);
    }, {
      onRetry: (attempt, delayMs, error) => {
        mergerLog.warn(
          `${taskId}: rate limited while resolving rebase conflicts — retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${error.message}`,
        );
      },
      signal: options?.signal,
    });
    await accumulateSessionTokenUsage(store, taskId, session);
  } finally {
    try {
      await agentLogger.flush();
    } catch {
      // ignore
    }
    try {
      session.dispose();
    } catch {
      // ignore
    }
  }
}

async function resolveRebaseConflictSet(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  settings: Settings,
  options?: {
    onAgentText?: (delta: string) => void;
    signal?: AbortSignal;
    runtimeHint?: string;
    assignedAgentRuntimeConfig?: Record<string, unknown>;
    onSession?: (session: { dispose: () => void }) => void;
  },
): Promise<void> {
  const conflictedFiles = await getConflictedFiles(rootDir);
  if (conflictedFiles.length === 0) return;

  mergerLog.log(`${taskId}: found ${conflictedFiles.length} rebase conflict(s)`);

  const complexFiles: string[] = [];

  for (const file of conflictedFiles) {
    const conflictType = await classifyConflict(file, rootDir);
    if (conflictType === "lockfile-ours") {
      await resolveWithOurs(file, rootDir);
      continue;
    }
    if (conflictType === "generated-theirs") {
      await resolveWithTheirs(file, rootDir);
      continue;
    }
    if (conflictType === "trivial-whitespace") {
      await resolveTrivialWhitespace(file, rootDir);
      continue;
    }
    complexFiles.push(file);
  }

  if (complexFiles.length > 0) {
    await resolveComplexRebaseConflictsWithAi(store, rootDir, taskId, settings, complexFiles, options);
  }

  const remaining = await getConflictedFiles(rootDir);
  if (remaining.length > 0) {
    throw new Error(`Unresolved rebase conflicts remain: ${remaining.join(", ")}`);
  }
}

async function pullWithRebaseAndResolveConflicts(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  settings: Settings,
  remote: string,
  branch: string,
  options?: {
    onAgentText?: (delta: string) => void;
    signal?: AbortSignal;
    runtimeHint?: string;
    assignedAgentRuntimeConfig?: Record<string, unknown>;
    onSession?: (session: { dispose: () => void }) => void;
  },
): Promise<void> {
  const pullCommand = `git pull --rebase ${quoteArg(remote)} ${quoteArg(branch)}`;
  try {
    throwIfAborted(options?.signal, taskId);
    await execAsync(pullCommand, {
      cwd: rootDir,
      timeout: PULL_REBASE_TIMEOUT_MS,
      maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
      encoding: "utf-8",
    });
    mergerLog.log(`${taskId}: git pull --rebase succeeded for ${remote}/${branch}`);
    return;
  } catch (pullError: unknown) {
    const conflictedFiles = await getConflictedFiles(rootDir);
    if (conflictedFiles.length === 0) {
      throw new Error(`git pull --rebase failed: ${getCommandErrorMessage(pullError)}`);
    }

    mergerLog.warn(
      `${taskId}: git pull --rebase produced ${conflictedFiles.length} conflict(s); attempting resolution`,
    );

    try {
      await resolveRebaseConflictSet(store, rootDir, taskId, settings, options);

      for (let attempt = 1; attempt <= 10; attempt++) {
        throwIfAborted(options?.signal, taskId);
        if (!isRebaseInProgress(rootDir)) {
          mergerLog.log(`${taskId}: rebase conflicts resolved`);
          return;
        }

        try {
          throwIfAborted(options?.signal, taskId);
          await execAsync("GIT_EDITOR=true git rebase --continue", {
            cwd: rootDir,
            timeout: PULL_REBASE_TIMEOUT_MS,
            maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
            encoding: "utf-8",
          });
          mergerLog.log(`${taskId}: git rebase --continue succeeded (attempt ${attempt})`);
        } catch (continueError: unknown) {
          const currentConflicts = await getConflictedFiles(rootDir);
          if (currentConflicts.length === 0) {
            throw new Error(`git rebase --continue failed: ${getCommandErrorMessage(continueError)}`);
          }
          mergerLog.warn(`${taskId}: rebase continue hit additional conflicts; retrying resolution`);
          await resolveRebaseConflictSet(store, rootDir, taskId, settings, options);
          continue;
        }

        const remainingConflicts = await getConflictedFiles(rootDir);
        if (remainingConflicts.length > 0) {
          mergerLog.warn(`${taskId}: rebase continue left conflicts; retrying resolution`);
          await resolveRebaseConflictSet(store, rootDir, taskId, settings, options);
          continue;
        }
      }

      throw new Error("Exceeded maximum rebase conflict resolution attempts");
    } catch (resolutionError: unknown) {
      if (isRebaseInProgress(rootDir)) {
        try {
          await execAsync("git rebase --abort", {
            cwd: rootDir,
            timeout: PUSH_TIMEOUT_MS,
            maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
            encoding: "utf-8",
          });
          mergerLog.warn(`${taskId}: aborted rebase after unresolved conflicts`);
        } catch (abortError: unknown) {
          mergerLog.warn(`${taskId}: failed to abort rebase: ${getCommandErrorMessage(abortError)}`);
        }
      }

      rethrowIfMergeAborted(resolutionError);
      throw new Error(`unable to resolve rebase conflicts: ${getCommandErrorMessage(resolutionError)}`);
    }
  }
}

/**
 * Push the merged result to the configured remote after a successful direct merge.
 * Failures are non-fatal because the merge commit already exists locally.
 */
export async function pushToRemoteAfterMerge(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  settings: Settings,
  options?: {
    onAgentText?: (delta: string) => void;
    signal?: AbortSignal;
    runtimeHint?: string;
    assignedAgentRuntimeConfig?: Record<string, unknown>;
    onSession?: (session: { dispose: () => void }) => void;
    integrationBranch?: string;
    /*
    FNXC:MergePush 2026-07-11-22:10:
    When true, push `HEAD:refs/heads/<branch>` instead of the local branch ref. The unified
    AI merge path calls this from a DETACHED clean-room worktree (never the user's checkout),
    where `git pull --rebase` rewrites the detached HEAD — the local refs/heads/<branch> is
    only advanced afterwards via compare-and-swap by the caller. Without this, the push would
    resend the stale local ref after a divergence rebase and reject non-fast-forward forever.
    */
    pushHeadRefspec?: boolean;
  },
): Promise<{ pushed: boolean; error?: string }> {
  let target: { remote: string; branch: string };

  try {
    throwIfAborted(options?.signal, taskId);
    target = parsePushRemoteTarget(rootDir, settings.pushRemote, options?.integrationBranch);
  } catch (error: unknown) {
    rethrowIfMergeAborted(error);
    const message = getCommandErrorMessage(error);
    mergerLog.error(`${taskId}: invalid push remote configuration: ${message}`);
    return { pushed: false, error: message };
  }

  const { remote, branch } = target;
  mergerLog.log(`${taskId}: push-after-merge enabled; syncing ${remote}/${branch}`);

  try {
    throwIfAborted(options?.signal, taskId);
    await pullWithRebaseAndResolveConflicts(store, rootDir, taskId, settings, remote, branch, options);
  } catch (error: unknown) {
    rethrowIfMergeAborted(error);
    const message = getCommandErrorMessage(error);
    mergerLog.error(`${taskId}: pull --rebase before push failed: ${message}`);
    return { pushed: false, error: message };
  }

  const pushCommand = options?.pushHeadRefspec
    ? `git push ${quoteArg(remote)} ${quoteArg(`HEAD:refs/heads/${branch}`)}`
    : `git push ${quoteArg(remote)} ${quoteArg(branch)}`;

  try {
    throwIfAborted(options?.signal, taskId);
    await execAsync(pushCommand, {
      cwd: rootDir,
      timeout: PUSH_TIMEOUT_MS,
      maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
      encoding: "utf-8",
    });
    mergerLog.log(`${taskId}: pushed merged result to ${remote}/${branch}`);
    return { pushed: true };
  } catch (firstPushError: unknown) {
    let lastMessage = getCommandErrorMessage(firstPushError);
    mergerLog.warn(`${taskId}: initial push failed: ${lastMessage}`);

    if (!isNonFastForwardPushError(lastMessage)) {
      return { pushed: false, error: lastMessage };
    }

    // Non-fast-forward push failures mean origin moved between our pre-push
    // pull and the push itself. A single retry can still lose the race if
    // origin moves again in that window (busy repos, concurrent mergers), so
    // retry a bounded number of times with backoff, re-fetching+rebasing
    // before each attempt.
    const maxRetries = PUSH_NON_FF_MAX_RETRIES;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      mergerLog.log(
        `${taskId}: push rejected as non-fast-forward; retrying pull --rebase and push (attempt ${attempt}/${maxRetries})`,
      );
      try {
        throwIfAborted(options?.signal, taskId);
        await pullWithRebaseAndResolveConflicts(store, rootDir, taskId, settings, remote, branch, options);
        throwIfAborted(options?.signal, taskId);
        await execAsync(pushCommand, {
          cwd: rootDir,
          timeout: PUSH_TIMEOUT_MS,
          maxBuffer: VERIFICATION_COMMAND_MAX_BUFFER,
          encoding: "utf-8",
        });
        mergerLog.log(`${taskId}: push succeeded after non-fast-forward retry (attempt ${attempt}/${maxRetries})`);
        return { pushed: true };
      } catch (retryError: unknown) {
        rethrowIfMergeAborted(retryError);
        lastMessage = getCommandErrorMessage(retryError);
        mergerLog.error(`${taskId}: push retry ${attempt}/${maxRetries} failed: ${lastMessage}`);
        if (attempt === maxRetries || !isNonFastForwardPushError(lastMessage)) {
          break;
        }
        throwIfAborted(options?.signal, taskId);
        await delay(PUSH_NON_FF_RETRY_BACKOFF_MS[attempt - 1] ?? PUSH_NON_FF_RETRY_BACKOFF_MS.at(-1)!);
      }
    }
    return { pushed: false, error: lastMessage };
  }
}

/*
FNXC:WorkflowPostMerge 2026-06-26-14:00:
U7c removed the merger-side post-merge execution path entirely (worktree creation +
init-command + prompt/script step execution + isolated-worktree cleanup). Post-merge
workflow steps run exclusively as the workflow graph's own post-merge optional-group node.
*/

/**
 * AI-powered merge with 3-attempt retry logic when autoResolveConflicts is enabled.
 *
 * Attempt 1: Standard merge + AI agent with full context
 * Attempt 2 (if enabled and Attempt 1 failed): Auto-resolve lock/generated files, retry AI
 * Attempt 3 (if enabled and Attempt 2 failed): Reset and use git merge -X theirs --squash
 *
 * When `options.pool` is provided and `recycleWorktrees` is enabled in
 * settings, the worktree is detached from its branch and released to the
 * idle pool instead of being removed. The task's branch is always deleted
 * regardless of pooling. On next task execution, the pooled worktree will
 * be acquired and prepared with a fresh branch via {@link WorktreePool.prepareForTask}.
 */

/**
 * FN-5345/FN-5377: early empty-own-diff finalize helper.
 *
 * Detects branches whose own commits introduce zero net tree change vs their
 * merge-base with the integration target and finalizes them as no-op BEFORE
 * any reuse-handoff acquisition runs. This unsticks tasks where a stale empty
 * handoff commit + drifted worktree<->branch mapping would otherwise wedge
 * the handoff gate with `registered-branch-mismatch` and escalate to
 * `merge-deadlock-detected: verified content not on main`.
 *
 * Returns the finalized `MergeResult` when the fast-path fires, or `null`
 * when it does not apply (branch missing, aheadCount === 0, non-empty diff,
 * etc.) and the standard merge path should proceed.
 *
 * Scope:
 *   - Caller restricts to `reuse-task-worktree` integration mode.
 *   - Branch must exist, ahead of target by >= 1 commit, and
 *     `git diff --quiet <mergeBase>..<branchTip>` exits 0.
 *   - aheadCount === 0 (already-landed) is NOT handled here so the existing
 *     post-handoff `classifyOwnedLandedEvidence` path keeps its lease lifecycle.
 *   - On finalize, best-effort cleanup of the stranded `task.worktree` and
 *     `fusion/<id>` branch keeps `.worktrees/` and the branch namespace tidy.
 */
async function tryEarlyEmptyOwnDiffFinalize(input: {
  task: Task;
  taskId: string;
  store: TaskStore;
  audit: Pick<RunAuditor, "database">;
  log: { warn: (m: string) => void; log: (m: string) => void };
  projectRootDir: string;
  mergeTargetBranch: string;
  mergeTargetSource: MergeDetails["mergeTargetSource"];
  completeTask: (result: MergeResult) => Promise<void>;
}): Promise<MergeResult | null> {
  const { task, taskId, store, audit, log, projectRootDir, mergeTargetBranch, mergeTargetSource } = input;
  const branch = resolveTaskWorkingBranch(task);

  // 1. Branch exists?
  try {
    await execAsync(
      `git show-ref --verify --quiet ${quoteArg(`refs/heads/${branch}`)}`,
      { cwd: projectRootDir, timeout: 30_000 },
    );
  } catch {
    return null;
  }

  // 2. aheadCount > 0?
  let aheadCount: number;
  try {
    const { stdout } = await execAsync(
      `git rev-list --count ${quoteArg(`${mergeTargetBranch}..${branch}`)}`,
      { cwd: projectRootDir, encoding: "utf-8", timeout: 30_000 },
    );
    const parsed = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    aheadCount = parsed;
  } catch {
    return null;
  }

  // 3. merge-base resolvable?
  let mergeBase: string;
  try {
    const { stdout } = await execAsync(
      `git merge-base ${quoteArg(mergeTargetBranch)} ${quoteArg(branch)}`,
      { cwd: projectRootDir, encoding: "utf-8", timeout: 30_000 },
    );
    mergeBase = stdout.trim();
    if (!mergeBase) return null;
  } catch {
    return null;
  }

  // 4. zero net diff vs merge-base?
  try {
    await execAsync(
      `git diff --quiet ${quoteArg(`${mergeBase}..${branch}`)}`,
      { cwd: projectRootDir, timeout: 30_000 },
    );
  } catch {
    // exit non-zero — diff exists, NOT empty-own-diff
    return null;
  }

  const noCommitsFinalize = evaluateNoCommitsNoOpFinalize(task);
  if (noCommitsFinalize.blocked) {
    const reason = noCommitsFinalize.reason ?? "no-commits task has incomplete work with no net branch changes";
    /*
     * FNXC:Lifecycle 2026-06-14-20:06:
     * FN-6461/FN-6455 requires the early empty-own-diff fast-path to block before mergeDetails writes or branch/worktree cleanup so incomplete release/ops work remains recoverable.
     */
    await store.updateTask(taskId, { error: reason });
    await store.logEntry(
      taskId,
      `Finalize blocked (no-commits incomplete-work guard): ${reason} — moving back to todo with progress preserved`,
      JSON.stringify({
        doneCount: noCommitsFinalize.doneCount,
        incompleteCount: noCommitsFinalize.incompleteCount,
        branch,
        mergeTargetBranch,
        lane: "early-empty-own-diff",
      }, null, 2),
    );
    await audit.database({
      type: "task:no-commits-finalize-blocked-incomplete-steps" as Parameters<typeof audit.database>[0]["type"],
      target: taskId,
      metadata: {
        reason,
        doneCount: noCommitsFinalize.doneCount,
        incompleteCount: noCommitsFinalize.incompleteCount,
        branch,
        mergeTargetBranch,
        lane: "early-empty-own-diff",
      },
    });
    await store.moveTask(taskId, "todo", { preserveProgress: true, moveSource: "engine" } as any);
    return {
      task,
      branch,
      merged: false,
      noOp: false,
      ok: true,
      reason,
      error: reason,
      worktreeRemoved: false,
      branchDeleted: false,
    };
  }

  const noOpReason = `early fast-path: branch ${branch} has ${aheadCount} own commit(s) but zero net diff vs merge-base of ${mergeTargetBranch}`;
  const mergedAt = new Date().toISOString();
  const mergeDetails: MergeDetails = {
    ...(task.mergeDetails || {}),
    mergeConfirmed: true,
    noOpMerge: true,
    noOpReason,
    landedFiles: [],
    mergedAt,
    prNumber: task.prInfo?.number,
    mergeTargetBranch,
    mergeTargetSource,
  };
  await store.updateTask(taskId, { mergeDetails, modifiedFiles: [] });
  await store.logEntry(
    taskId,
    `Auto-finalized no-op (early fast-path, FN-5345/FN-5377): ${noOpReason}`,
  );
  try {
    await audit.database({
      type: "task:auto-recover-finalize-already-on-main",
      target: taskId,
      metadata: {
        phase: "merge",
        reason: "empty-own-diff-early-fast-path",
        baseRef: mergeTargetBranch,
        branch,
        aheadCount,
        mergeBase,
      },
    });
  } catch (auditErr: unknown) {
    log.warn(
      `${taskId}: failed to emit empty-own-diff-early-fast-path audit: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
    );
  }

  // FN-5345/FN-5377: best-effort cleanup of the stranded worktree + branch
  // so .worktrees/ and the branch namespace do not accumulate empty-own-diff
  // residuals indefinitely. Failures are non-fatal: the task is already done.
  //
  // Safety rules:
  //   - FN-4811: never touch a worktree owned by a different task.
  //   - Dirty worktrees (tracked modifications or staged changes) are left
  //     alone (no --force) so we never silently discard uncommitted work.
  //     Untracked junk (.DS_Store, editor swap files, build artifacts) does
  //     NOT block cleanup — we use `--untracked-files=no` and only respect
  //     tracked dirt as a signal of agent work in progress.
  //   - Branch deletion only fires when task.branch was non-null on entry
  //     (i.e. the task explicitly owned a branch). If task.branch was null,
  //     `cleanupOrphanedBranches` handles any orphan ref later.
  let worktreeRemoved = false;
  let branchDeleted = false;
  const stranded = task.worktree?.trim();
  const ownedBranchOnEntry = task.branch?.trim();
  if (stranded && existsSync(stranded)) {
    const activeRecord = activeSessionRegistry.lookupByPath(stranded);
    if (activeRecord && activeRecord.taskId !== taskId) {
      log.warn(
        `${taskId}: skipping early-fast-path worktree cleanup — path ${stranded} is owned by ${activeRecord.taskId}`,
      );
    } else {
      let dirty = false;
      let dirtyDiagnostic: string | undefined;
      try {
        const { stdout } = await execAsync(
          `git status --porcelain --untracked-files=no`,
          { cwd: stranded, encoding: "utf-8", timeout: 15_000 },
        );
        const trimmed = stdout.trim();
        dirty = trimmed.length > 0;
        if (dirty) {
          // First few dirty paths, for operator diagnosis.
          dirtyDiagnostic = trimmed.split("\n").slice(0, 5).join("; ");
        }
      } catch (statusErr) {
        // Treat status failure as "unknown" — fail safe by skipping removal.
        dirty = true;
        log.warn(
          `${taskId}: git status check failed for ${stranded}; skipping early-fast-path worktree removal: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`,
        );
      }
      if (dirty) {
        log.warn(
          `${taskId}: skipping early-fast-path worktree cleanup — ${stranded} has uncommitted tracked changes${dirtyDiagnostic ? ` (${dirtyDiagnostic})` : ""}; self-healing sweep will reconcile later`,
        );
      } else {
        try {
          // --force here is safe: the tracked-only dirty check above already
          // refused if there were uncommitted tracked changes. --force lets
          // us discard untracked junk (.DS_Store, editor swap files, etc.)
          // that would otherwise block `git worktree remove`.
          await execAsync(
            `git worktree remove --force ${quoteArg(stranded)}`,
            { cwd: projectRootDir, timeout: 30_000 },
          );
          worktreeRemoved = true;
        } catch (removeErr) {
          log.warn(
            `${taskId}: failed to remove stranded worktree ${stranded} (non-fatal): ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
          );
        }
      }
    }
  }
  if (ownedBranchOnEntry) {
    try {
      // Branch must be deleted from the project root, not from inside a
      // worktree that may still be checked out to it.
      await execAsync(
        `git branch -D ${quoteArg(ownedBranchOnEntry)}`,
        { cwd: projectRootDir, timeout: 30_000 },
      );
      branchDeleted = true;
    } catch (delErr) {
      log.warn(
        `${taskId}: failed to delete stranded branch ${ownedBranchOnEntry} (non-fatal): ${delErr instanceof Error ? delErr.message : String(delErr)}`,
      );
    }
  }
  if (worktreeRemoved || branchDeleted) {
    try {
      await store.updateTask(taskId, {
        worktree: worktreeRemoved ? null : task.worktree,
        branch: branchDeleted ? null : task.branch,
      });
      // Keep the in-memory task in sync with the DB so the returned
      // MergeResult.task does not advertise a removed path / deleted branch.
      // (updateTask uses null as the "clear this field" sentinel; the
      // in-memory Task type uses undefined for absent.)
      if (worktreeRemoved) task.worktree = undefined;
      if (branchDeleted) task.branch = undefined;
    } catch (updateErr) {
      log.warn(
        `${taskId}: failed to clear worktree/branch pointers after early-fast-path cleanup (non-fatal): ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
      );
    }
  }

  const result: MergeResult = {
    task,
    branch,
    merged: true,
    noOp: true,
    worktreeRemoved,
    branchDeleted,
    mergeConfirmed: true,
    noOpMerge: true,
    noOpReason,
    mergedAt,
    mergeTargetBranch,
    mergeTargetSource,
  };
  await input.completeTask(result);
  return result;
}

/**
 * U6 (R6) sync-on-landing seam, extracted for narrow unit testing (FN-5048: the
 * stale-snapshot write guard is covered in-memory, not via the slow real-git
 * reliability suite). Pushes the group PR body for a group with a persisted
 * open PR, then persists out-of-band reconciliation — but only when the group
 * still points at the exact PR snapshot that was synced (same prNumber AND
 * prState). A newer landing/promotion that swapped in a different PR mid-sync
 * must not be clobbered by this stale write.
 */
export async function syncGroupPrOnLanding(input: {
  store: Pick<TaskStore, "getBranchGroup" | "listTasksByBranchGroup" | "updateBranchGroup">;
  groupId: string;
  cwd: string;
  syncGroupPr: import("./group-merge-coordinator.js").SyncGroupPrFn;
}): Promise<void> {
  const { store, groupId, cwd, syncGroupPr } = input;
  const latestGroup = await store.getBranchGroup(groupId);
  if (!latestGroup || latestGroup.prNumber == null || latestGroup.prState !== "open") {
    return;
  }
  const members = await store.listTasksByBranchGroup(latestGroup.id);
  const reconciled = await syncGroupPr({
    cwd,
    group: latestGroup,
    members,
  });
  // Guard against stale snapshots: a newer landing/promotion may have stored a
  // different (e.g. newer open) PR for this group while we were awaiting the
  // sync. Re-read and only persist when the snapshot still matches.
  const currentGroup = await store.getBranchGroup(groupId);
  if (
    !currentGroup ||
    currentGroup.prNumber !== latestGroup.prNumber ||
    currentGroup.prState !== latestGroup.prState
  ) {
    return;
  }
  // Out-of-band reconciliation: if GitHub reports the PR is no longer open
  // (closed/merged), persist the corrected prState rather than leaving a stale "open".
  if (reconciled.prState !== currentGroup.prState) {
    void store.updateBranchGroup(currentGroup.id, {
      prState: reconciled.prState,
      prNumber: reconciled.prNumber,
      prUrl: reconciled.prUrl,
    });
  }
}

/**
 * @deprecated Soft-deprecated by master-plan U0 (2026-06-21). `runAiMerge`
 * (`merger-ai.ts`, the FN-5633 clean-room AI merge path) is now the SOLE merge
 * path; no production code calls `aiMergeTask`. The body is RETAINED for a later
 * deletion pass and direct unit tests, but new callers must use `runAiMerge`.
 * The `merger.mode === "deterministic"` setting that once routed here is inert.
 *
 * FNXC:MergerUnification 2026-06-21-19:05: legacy deterministic merge pipeline,
 * superseded by runAiMerge. Helpers it shares with runAiMerge (e.g.
 * captureSingleCommitLandedMetadata) are NOT deprecated.
 */
export async function aiMergeTask(
  store: TaskStore,
  rootDir: string,
  taskId: string,
  options: MergerOptions = {},
): Promise<MergeResult> {
  throwIfAborted(options.signal, taskId);

  // 1. Validate task state
  const task = await store.getTask(taskId);
  // FNXC:MergerUnification 2026-06-21-19:05: defense-in-depth R7 guard on the
  // deprecated path — even though no production code calls aiMergeTask, its body is
  // reachable via direct unit tests/importers, so enforce the workspace merge-boundary
  // here too (throws the named WorkspaceTaskMergeError) before any git work.
  assertNotWorkspaceTaskMerge(task);
  if (task.column === "done" || task.column === "archived") {
    const message = `merger: skipping squash for ${taskId} — task already finalized (column=${task.column})`;
    mergerLog.log(message);
    await (store as any).recordRunAuditEvent?.({
      domain: "database",
      mutationType: "task:auto-merge-skipped-already-done",
      target: taskId,
      metadata: {
        column: task.column,
        mergeConfirmed: task.mergeDetails?.mergeConfirmed ?? false,
      },
    });
    return {
      task,
      branch: resolveTaskWorkingBranch(task),
      merged: false,
      noOp: true,
      ok: true,
      reason: "already-finalized",
      worktreeRemoved: false,
      branchDeleted: false,
    };
  }
  const mergeBlocker = getTaskMergeBlocker(task, { manual: options.manual === true });
  if (mergeBlocker) {
    throw new Error(`Cannot merge ${taskId}: ${mergeBlocker}`);
  }

  const projectRootDir = rootDir;
  // Merge per-task effective workflow settings (U3, KTD-3) over the base so the
  // merger's flat reads (strictScopeEnforcement, verificationFixRetries,
  // buildRetryCount, titleSummarizer lanes — all threaded from here via
  // executeMergeAttempt) pick up workflow values. Behavior-inert by default.
  const settings = await mergeEffectiveSettings(store, task, await store.getSettings());
  // U7 (R10): resolve the merge trait's policy (strategy / fileScope / rules)
  // from the task's workflow when the workflowColumns flag is ON, falling back
  // to the existing settings knobs otherwise. Read-through only — merge
  // mechanics (and the non-configurable lost-work guard trio) are untouched.
  const mergePolicy = await resolveMergePolicy(store, task, settings);
  const resolvedIntegrationBranch = await resolveIntegrationBranch(projectRootDir, settings);
  const groupRouting = await resolveBranchGroupMergeRouting({
    task,
    store,
    projectDefaultBranch: resolvedIntegrationBranch,
    rootDir: projectRootDir,
  });
  const mergeTarget = groupRouting?.mergeTarget ?? resolveTaskMergeTarget(task, {
    projectDefaultBranch: resolvedIntegrationBranch,
  });
  const recordBranchGroupMemberLanding = async () => {
    if (!groupRouting) {
      return;
    }

    try {
      await Promise.resolve((store as any).recordBranchGroupMemberLanded?.(groupRouting.branchGroup.id, {
        worktreePath: task.worktree ?? null,
        status: "open",
      }));
    } catch {
      // best-effort persistence
    }

    const promotionEligibility = evaluateBranchGroupPromotion({
      group: groupRouting.branchGroup,
      settings,
    });
    try {
      await (store as any).recordRunAuditEvent?.({
        taskId,
        agentId: "merger",
        runId: `merge-${taskId}`,
        domain: "git",
        mutationType: "merge:branch-group-promotion-gated",
        target: taskId,
        metadata: {
          groupId: groupRouting.branchGroup.id,
          branchName: groupRouting.branchGroup.branchName,
          groupAutoMerge: promotionEligibility.groupAutoMerge,
          effectiveEligible: promotionEligibility.eligible,
          reason: promotionEligibility.reason,
        },
      });
    } catch {
      // best-effort audit
    }

    // U6 (R6): keep the single managed group PR in sync as members land. Only
    // when the group already has a persisted open PR; the body always reflects
    // the full current member state, so each landing pushes the latest x/N
    // (idempotent body rewrite — coalesces naturally, no queue).
    //
    // T14: this is TRULY best-effort. A hung GitHub call must NOT stall merge
    // completion, so we fire-and-forget the sync and route any failure to the
    // existing non-fatal audit event via `.catch`. `cwd` is the project root so
    // the callback resolves the repo identity per-project (not from process cwd)
    // in multi-project daemons. The optional `onGroupPrSyncSettled` hands the
    // background promise to tests so they can await it deterministically.
    if (options.syncGroupPr) {
      const syncGroupPr = options.syncGroupPr;
      const groupId = groupRouting.branchGroup.id;
      const settled = syncGroupPrOnLanding({
        store,
        groupId,
        cwd: projectRootDir,
        syncGroupPr,
      }).catch((err) => {
        // Non-fatal: never fail the merge/landing because PR sync failed.
        try {
          void store.recordRunAuditEvent({
            taskId,
            agentId: "merger",
            runId: `merge-${taskId}`,
            domain: "git",
            mutationType: "merge:branch-group-pr-sync-failed",
            target: taskId,
            metadata: {
              groupId,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        } catch {
          // best-effort audit
        }
      });
      options.onGroupPrSyncSettled?.(settled);
    }
  };
  if (groupRouting) {
    const auditRunId = `merge-${taskId}`;
    try {
      await (store as any).recordRunAuditEvent?.({
        taskId,
        agentId: "merger",
        runId: auditRunId,
        domain: "git",
        mutationType: "merge:branch-group-routed",
        target: taskId,
        metadata: {
          groupId: groupRouting.branchGroup.id,
          branchName: groupRouting.branchGroup.branchName,
          mergeTargetBranch: mergeTarget.branch,
          mergeTargetSource: mergeTarget.source,
        },
      });
    } catch {
      // best-effort audit
    }
  }

  if (mergeTarget.rejected) {
    // FN-5233/FN-5530 regression: the task's baseBranch/inheritedBaseBranch
    // pointed at a sibling fusion/fn-* branch. The resolver fell through to
    // projectDefault, but we surface the steering miss in the audit timeline
    // so the underlying baseBranch-propagation bug stays observable.
    mergerLog.warn(
      `${taskId}: merge target rejected (${mergeTarget.rejected.reason}): ${mergeTarget.rejected.source}=${mergeTarget.rejected.branch} → using ${mergeTarget.branch}`,
    );
    try {
      await (store as any).recordRunAuditEvent?.({
        domain: "git",
        mutationType: "merge:merge-target-rejected-fusion-sibling",
        target: taskId,
        metadata: {
          rejectedBranch: mergeTarget.rejected.branch,
          rejectedSource: mergeTarget.rejected.source,
          reason: mergeTarget.rejected.reason,
          fallbackBranch: mergeTarget.branch,
          fallbackSource: mergeTarget.source,
        },
      });
    } catch {
      // best-effort audit; never block the merge on telemetry
    }
  }
  const integrationBranch = groupRouting ? mergeTarget.branch : resolvedIntegrationBranch;
  let branch = resolveTaskWorkingBranch(task);

  const mergeRunId = generateSyntheticRunId("merge", taskId);
  const engineRunContext: EngineRunContext = {
    runId: mergeRunId,
    agentId: "merger",
    taskId,
    taskLineageId: task.lineageId,
    phase: "merge",
  };
  const audit = createRunAuditor(store, engineRunContext);
  const emitReuseHandoffAuditEvent = async (
    type:
      | "merge:reuse-handoff-acquired"
      | "merge:reuse-handoff-refused"
      | "merge:reuse-handoff-released"
      | "merge:reuse-handoff-deferred-to-worktrunk"
      | "merge:reuse-handoff-autostash"
      | "merge:reuse-fallback-new-worktree"
      | "merge:reuse-fallback-pruned-stale-registration"
      | "merge:reuse-fallback-reused-existing-registration"
      | "merge:reuse-worktree-fresh-acquire"
      | "merge:reuse-worktree-fresh-acquired"
      | "branch:auto-canonicalize-case",
    metadata: Record<string, unknown>,
    target: string,
  ): Promise<void> => {
    try {
      await audit.git({ type, target, metadata });
    } catch (auditErr: unknown) {
      mergerLog.warn(
        `${taskId}: failed to emit ${type}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
      );
    }
  };

  // FN-5345/FN-5377: early empty-own-diff fast-path.
  //
  // Detect branches whose own commits introduce zero net tree change vs their
  // merge-base with the integration target ("empty-own-diff") BEFORE attempting
  // any reuse-handoff acquisition. This unsticks tasks where a stale empty
  // handoff commit (e.g. a verification-only task that committed --allow-empty)
  // combined with drifted worktree<->branch mapping would otherwise wedge the
  // handoff gate with `registered-branch-mismatch` and ultimately escalate to
  // `merge-deadlock-detected: verified content not on main` after FN-4999
  // completion-handoff-limbo recovery exhausts.
  //
  // Scope is narrow on purpose:
  //   - ONLY in reuse-task-worktree integration mode (where the wedge lives).
  //   - ONLY when the branch exists, is ahead of the integration target by >= 1
  //     commit, and `git diff --quiet <mergeBase>..<branchTip>` reports an
  //     empty net diff.
  //   - aheadCount === 0 (already-landed) and missing-branch (no-changes-finalized)
  //     still go through the standard reuse-handoff path so the existing
  //     handoff lease lifecycle and FN-5083 branch-rebind invariants are
  //     preserved.
  //   - cwd-integration-branch mode (explicit opt-in) is unchanged.
  const requestedIntegrationMode = normalizeMergeIntegrationWorktreeMode(settings.mergeIntegrationWorktree);
  if (requestedIntegrationMode !== "cwd-integration-branch") {
    try {
      const earlyResult = await tryEarlyEmptyOwnDiffFinalize({
        task,
        taskId,
        store,
        audit,
        log: mergerLog,
        projectRootDir,
        mergeTargetBranch: mergeTarget.branch,
        mergeTargetSource: mergeTarget.source,
        completeTask: (result) => completeTask(store, taskId, result),
      });
      if (earlyResult) return earlyResult;
    } catch (earlyErr: unknown) {
      mergerLog.warn(
        `${taskId}: early empty-own-diff fast-path failed; falling through to standard merge path: ${earlyErr instanceof Error ? earlyErr.message : String(earlyErr)}`,
      );
    }
  }

  if (requestedIntegrationMode === "cwd-integration-branch") {
    mergerLog.warn(
      `${taskId}: mergeIntegrationWorktree=cwd-integration-branch is explicit opt-in and runs merge operations in the user's working directory (FN-5348). The engine assumes the integration branch is checked out there.`,
    );
  }

  let integrationRoot = resolveMergeIntegrationRoot({
    task,
    settings,
    projectRoot: projectRootDir,
  });
  let reuseTaskWorktreeMerge = integrationRoot.mode === "reuse-task-worktree";
  let integrationRemote: string | undefined;
  const reacquireReuseIntegrationWorktree = async (
    reason: string,
    diagnostics: Record<string, unknown>,
  ): Promise<void> => {
    const priorWorktreePath = task.worktree ?? null;
    if (priorWorktreePath && isRepoRootPath(projectRootDir, priorWorktreePath)) {
      /*
       * FNXC:WorkflowCutover 2026-06-23-04:45:
       * Merge reuse handoff must reject a task worktree that equals the project root before acquisition fallback can clear the assignment. Executor resume may self-heal stale root assignments, but merge must not hide a handoff contract violation by creating a fresh task worktree.
       */
      throw new MergeHandoffRefusedError("reuse-misconfigured", "worktree-equals-project-root", {
        taskId,
        projectRoot: projectRootDir,
        worktreePath: priorWorktreePath,
        requestedMode: requestedIntegrationMode,
        reason,
        diagnostics,
      });
    }

    // FN-5345/FN-5377: consult existing registration of `fusion/<id>` before
    // creating a fresh worktree. If the branch is already registered at a
    // usable extant path, rebind `task.worktree` to it (avoids FN-5083-class
    // double-registration where two worktrees both claim the same branch and
    // the next handoff gate refuses with `registered-branch-mismatch`).
    //
    // If registered at a stale/missing path, run `git worktree prune` so the
    // subsequent `worktree add -f` does not produce a duplicate admin entry.
    //
    // Safety guards:
    //   - FN-4811 active-session: skip a match whose path is currently owned
    //     by a DIFFERENT task in `activeSessionRegistry`. Same-task or unowned
    //     paths are eligible for direct reuse.
    //   - FN-4954 pool-lease: when `recycleWorktrees=true` AND a pool is
    //     attached, skip the direct-reuse shortcut and fall through to
    //     `acquireTaskWorktree`, which integrates with `WorktreePool.acquire`
    //     so the pool's `leased` map stays consistent. Without that fall-through
    //     the new path would bypass pool bookkeeping and could collide with
    //     `PoolDoubleLeaseError`.
    const expectedBranch = resolveTaskWorkingBranch(task);
    // FN-4954: when a worktree pool is attached and recycling is enabled, pool
    // semantics REQUIRE going through `acquireTaskWorktree` so `WorktreePool`'s
    // lease bookkeeping stays consistent. Skip the direct-reuse shortcut here
    // and fall through to the existing acquisition path.
    const directReuseEligible = !(options.pool && settings.recycleWorktrees);
    if (directReuseEligible) {
      try {
        const { stdout: porcelain } = await execAsync(
          `git worktree list --porcelain`,
          { cwd: projectRootDir, encoding: "utf-8", timeout: 30_000 },
        );
        const entries: { path?: string; branch?: string }[] = [];
        let current: { path?: string; branch?: string } = {};
        for (const line of porcelain.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (current.path) entries.push(current);
            current = { path: line.slice("worktree ".length).trim() };
          } else if (line.startsWith("branch ")) {
            // refs/heads/fusion/fn-5345 -> fusion/fn-5345
            current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
          } else if (line.trim() === "") {
            if (current.path) {
              entries.push(current);
              current = {};
            }
          }
        }
        if (current.path) entries.push(current);
        const expectedLower = expectedBranch.toLowerCase();
        const matches = entries.filter((e) => (e.branch || "").toLowerCase() === expectedLower);
        let prunedAnyStaleRegistration = false;
        let reusableMatch: { path: string; branch: string } | null = null;
        const skippedForeignOwners: { path: string; ownerTaskId: string }[] = [];
        for (const match of matches) {
          if (!match.path) continue;
          const exists = existsSync(match.path);
          if (!exists) {
            prunedAnyStaleRegistration = true;
            continue;
          }
          // FN-4811: refuse to rebind onto a path owned by a different task.
          const activeRecord = activeSessionRegistry.lookupByPath(match.path);
          if (activeRecord && activeRecord.taskId !== taskId) {
            skippedForeignOwners.push({ path: match.path, ownerTaskId: activeRecord.taskId });
            continue;
          }
          const cls = await classifyTaskWorktree(projectRootDir, match.path);
          if (cls.ok) {
            reusableMatch = { path: match.path, branch: match.branch || expectedBranch };
            break;
          }
          prunedAnyStaleRegistration = true;
        }
        if (prunedAnyStaleRegistration) {
          try {
            await execAsync(`git worktree prune`, { cwd: projectRootDir, encoding: "utf-8", timeout: 30_000 });
            await emitReuseHandoffAuditEvent(
              "merge:reuse-fallback-pruned-stale-registration",
              {
                taskId,
                branch: expectedBranch,
                diagnostics: {
                  matches: matches.map((m) => ({ path: m.path, branch: m.branch })),
                  skippedForeignOwners,
                },
              },
              projectRootDir,
            );
          } catch (pruneErr) {
            mergerLog.warn(
              `${taskId}: git worktree prune failed before reacquire: ${pruneErr instanceof Error ? pruneErr.message : String(pruneErr)}`,
            );
          }
        }
        if (reusableMatch) {
          // Reuse the extant registration directly. Skip acquireTaskWorktree's
          // fresh-create path so we don't double-register the branch.
          task.worktree = reusableMatch.path;
          task.branch = reusableMatch.branch;
          branch = reusableMatch.branch;
          integrationRoot = {
            ...integrationRoot,
            mode: "reuse-task-worktree",
            rootDir: reusableMatch.path,
            branchName: reusableMatch.branch,
          };
          reuseTaskWorktreeMerge = true;
          rootDir = reusableMatch.path;
          integrationRemote = await resolveIntegrationRemote({
            settings,
            rootDir,
            integrationBranch: mergeTarget.branch,
          });
          await store.updateTask(taskId, { worktree: reusableMatch.path, branch: reusableMatch.branch });
          await emitReuseHandoffAuditEvent(
            "merge:reuse-fallback-reused-existing-registration",
            {
              taskId,
              reason,
              branch: reusableMatch.branch,
              worktreePath: reusableMatch.path,
              source: "existing",
              diagnostics,
              skippedForeignOwners,
              integrationRemote: integrationRemote ?? null,
              integrationBranch: mergeTarget.branch,
            },
            reusableMatch.path,
          );
          await store.recordActivity({
            type: "task:merge-worktree-reacquired",
            taskId,
            taskTitle: task.title,
            details: `Merge worktree reacquired from existing registration: ${reason}`,
            metadata: { reason, branch: reusableMatch.branch, worktreePath: reusableMatch.path, source: "existing" },
          });
          return;
        }
      } catch (listErr) {
        mergerLog.warn(
          `${taskId}: git worktree list consult failed before reacquire; proceeding with fresh creation: ${listErr instanceof Error ? listErr.message : String(listErr)}`,
        );
      }
    }

    await emitReuseHandoffAuditEvent(
      "merge:reuse-worktree-fresh-acquire",
      {
        taskId,
        reason,
        expectedBranch,
        priorWorktreePath,
        integrationBranch: mergeTarget.branch,
        diagnostics,
      },
      projectRootDir,
    );

    const acquisition = await acquireTaskWorktree({
      task,
      rootDir: projectRootDir,
      store,
      settings,
      pool: options.pool,
      logger: mergerLog,
      audit,
      runContext: engineRunContext,
      runInitCommand: true,
      runConfiguredCommand: async (command, cwd, timeoutMs, env) =>
        runConfiguredMergeWorktreeCommand(command, cwd, timeoutMs, env, audit),
      createWorktree: async (branch, path, _taskId, _startPoint, _allowSiblingBranchRename) => {
        await execAsync(`git worktree add -f ${quoteArg(path)} ${quoteArg(branch)}`, {
          cwd: projectRootDir,
          encoding: "utf-8",
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { path, branch };
      },
    });
    task.worktree = acquisition.worktreePath;
    task.branch = acquisition.branch;
    branch = acquisition.branch;
    integrationRoot = {
      ...integrationRoot,
      mode: "reuse-task-worktree",
      rootDir: acquisition.worktreePath,
      branchName: acquisition.branch,
    };
    reuseTaskWorktreeMerge = true;
    rootDir = acquisition.worktreePath;
    integrationRemote = await resolveIntegrationRemote({
      settings,
      rootDir,
      integrationBranch: mergeTarget.branch,
    });
    await emitReuseHandoffAuditEvent(
      "merge:reuse-worktree-fresh-acquired",
      {
        taskId,
        reason,
        branch: acquisition.branch,
        worktreePath: acquisition.worktreePath,
        source: acquisition.source,
        priorWorktreePath: priorWorktreePath ?? null,
        integrationRemote: integrationRemote ?? null,
        integrationBranch: mergeTarget.branch,
        diagnostics,
      },
      acquisition.worktreePath,
    );
    await emitReuseHandoffAuditEvent(
      "merge:reuse-fallback-new-worktree",
      {
        taskId,
        reason,
        branch: acquisition.branch,
        worktreePath: acquisition.worktreePath,
        source: acquisition.source,
        diagnostics,
        integrationRemote: integrationRemote ?? null,
        integrationBranch: mergeTarget.branch,
      },
      acquisition.worktreePath,
    );
    await store.recordActivity({
      type: "task:merge-worktree-reacquired",
      taskId,
      taskTitle: task.title,
      details: `Merge worktree reacquired: ${reason}`,
      metadata: { reason, branch: acquisition.branch, worktreePath: acquisition.worktreePath, source: acquisition.source },
    });
  };
  if (
    settings.worktrunk?.enabled === true
    && requestedIntegrationMode === "reuse-task-worktree"
  ) {
    await emitReuseHandoffAuditEvent(
      "merge:reuse-handoff-deferred-to-worktrunk",
      {
        taskId,
        worktreePath: task.worktree ?? null,
        integrationRemote: integrationRemote ?? null,
        integrationBranch: mergeTarget.branch,
      },
      projectRootDir,
    );
  }

  let reuseHandoff: HandoffResult | undefined;
  if (integrationRoot.mode === "reuse-task-worktree") {
    const preflight = await ensureUsableMergeIntegrationRoot({
      resolution: integrationRoot,
      projectRoot: projectRootDir,
    });
    if (!preflight.ok) {
      await reacquireReuseIntegrationWorktree(preflight.reason, {
        requestedMode: requestedIntegrationMode,
        classification: preflight.classification ?? null,
      });
    }
  }

  rootDir = integrationRoot.rootDir;
  integrationRemote = await resolveIntegrationRemote({
    settings,
    rootDir,
    integrationBranch: mergeTarget.branch,
  });

  try {
    const integrationWorktreeState = await probeIntegrationWorktreeState({
      rootDir: integrationRoot.rootDir,
      integrationBranch,
      projectRoot: projectRootDir,
    });
    await audit.git({
      type: "merge:integration-worktree-state",
      target: projectRootDir,
      metadata: {
        taskId,
        integrationBranch,
        integrationMode: integrationRoot.mode === "reuse-task-worktree" ? "reuse-task-worktree" : "cwd-integration",
        integrationRootDir: integrationRoot.rootDir,
        taskWorktreePath: task.worktree?.trim() || null,
        userCheckout: integrationWorktreeState.userCheckout,
        dirtyFingerprint: integrationWorktreeState.dirtyFingerprint,
      },
    });
  } catch (auditErr: unknown) {
    mergerLog.warn(
      `${taskId}: failed to emit merge:integration-worktree-state: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
    );
  }

  if (isMergeRequestContractShadowEnabled(settings)) {
    const autoMergeFacts = await evaluateAutoMergeFactProviders(store, task as TaskDetail).catch((error) => ({
      route: "blocked" as const,
      facts: {},
      reasons: [`auto-merge fact provider evaluation failed: ${error instanceof Error ? error.message : String(error)}`],
    }));
    const providerManualRoute =
      autoMergeFacts.route === "manual-required" ||
      autoMergeFacts.route === "blocked";
    const autoMergeManuallyGated =
      task.autoMerge === false ||
      (settings.autoMerge === false && task.autoMerge !== true) ||
      providerManualRoute;
    const initialState = autoMergeManuallyGated ? "manual-required" : "queued";
    const existingRecord = await store.getMergeRequestRecordAsync(task.id);
    const currentState = existingRecord?.state ?? initialState;
    if (!existingRecord) {
      await store.upsertMergeRequestRecord(task.id, { state: initialState });
    }

    if (!autoMergeManuallyGated) {
      if (currentState === "retrying") {
        await store.transitionMergeRequestState(task.id, "queued");
        await store.transitionMergeRequestState(task.id, "running");
      } else if (currentState === "queued") {
        await store.transitionMergeRequestState(task.id, "running");
      }
    }

    await audit.database({
      type: "merge:request-enqueued",
      target: task.id,
      metadata: {
        taskId: task.id,
        state: initialState,
        autoMergeProviderRoute: autoMergeFacts.route ?? null,
        autoMergeProviderReasons: autoMergeFacts.reasons,
        autoMergeProviderFacts: autoMergeFacts.facts,
        integrationMode: integrationRoot.mode === "reuse-task-worktree" ? "reuse-task-worktree" : "cwd-integration",
      },
    });
  }

  if (integrationRoot.mode === "reuse-task-worktree") {
    // FN-5353: ensure the target task is in mergeQueue before attempting strict
    // targetTaskId lease acquisition for reuse handoff.
    await store.enqueueMergeQueue(task.id, { priority: task.priority });
    try {
      reuseHandoff = await acquireReuseHandoff({
        task,
        store,
        projectRoot: projectRootDir,
        settings,
        worktreePath: integrationRoot.rootDir,
        auditEmit: (event) => emitReuseHandoffAuditEvent(event.type as any, event.metadata ?? {}, event.target ?? integrationRoot.rootDir),
      });
      await emitReuseHandoffAuditEvent(
        "merge:reuse-handoff-acquired",
        {
          taskId,
          branch: reuseHandoff.branch,
          worktreePath: reuseHandoff.worktreePath,
          integrationRemote: integrationRemote ?? null,
          integrationBranch: mergeTarget.branch,
        },
        reuseHandoff.worktreePath,
      );
    } catch (error: unknown) {
      // FN-5348 invariant: a reuse-task-worktree handoff refusal MUST NOT fall back to
      // cwd-main / cwd-<integration-branch>. Acceptable outcomes: reacquire a fresh task
      // worktree (below) or rethrow MergeHandoffRefusedError so upstream parks the task
      // in-review with status: "failed". Any new branch added here must NOT assign
      // the legacy cwd-main mode to integrationRoot.
      if (!(error instanceof MergeHandoffRefusedError)) {
        throw error;
      }
      await emitReuseHandoffAuditEvent(
        "merge:reuse-handoff-refused",
        {
          taskId,
          gate: error.gate,
          reason: error.reason,
          diagnostics: error.payload,
        },
        integrationRoot.rootDir,
      );
      const reusableWorktreePath = task.worktree?.trim();
      if (!reusableWorktreePath) {
        await reacquireReuseIntegrationWorktree("missing-task-worktree-after-refusal", {
          requestedMode: requestedIntegrationMode,
          gate: error.gate,
          reason: error.reason,
        });
      } else if (isRepoRootPath(projectRootDir, reusableWorktreePath)) {
        /*
         * FNXC:WorkflowCutover 2026-06-23-04:45:
         * Merge reuse handoff must reject a task worktree that equals the project root. Executor resume may self-heal stale root assignments, but merge must not turn this dangerous state into a fresh-worktree fallback because that hides a handoff contract violation.
         */
        throw error;
      } else {
        const classification = await classifyTaskWorktree(projectRootDir, reusableWorktreePath);
        if (!classification.ok) {
          await reacquireReuseIntegrationWorktree("unusable-task-worktree-after-refusal", {
            requestedMode: requestedIntegrationMode,
            gate: error.gate,
            reason: error.reason,
            classification,
          });
        } else {
          try {
            await audit.git({
              type: "merge:cwd-integration-fallback-refused",
              target: integrationRoot.rootDir,
              metadata: {
                taskId,
                integrationBranch,
                refusedGate: error.gate,
                refusedReason: error.reason,
                requestedMode: requestedIntegrationMode === "reuse-task-worktree" ? "reuse-task-worktree" : "cwd-integration",
                taskWorktreePath: task.worktree?.trim() || null,
                parkOutcome: "in-review-failed",
              },
            });
          } catch (auditErr: unknown) {
            mergerLog.warn(
              `${taskId}: failed to emit merge:cwd-integration-fallback-refused: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            );
          }
          throw error;
        }
      }
    }
  }

  const requestedBaseRef = task.mergeDetails?.mergeTargetBranch?.trim() || mergeTarget.branch;
  const releaseReuseHandoffEarly = async (outcome: string): Promise<void> => {
    if (!reuseHandoff) return;
    const handoff = reuseHandoff;
    reuseHandoff = undefined;
    await releaseReuseHandoff({
      handoff,
      outcome,
      auditEmit: (event) => emitReuseHandoffAuditEvent(event.type as any, event.metadata ?? {}, event.target ?? handoff.worktreePath),
    });
  };

  const resolveAheadCount = async (): Promise<{ aheadCount: number; baseRef: string } | null> => {
    try {
      await execAsync(`git rev-parse --verify ${quoteArg(branch)}`, { cwd: rootDir, timeout: 30_000 });
    } catch {
      return null;
    }

    let baseRef = requestedBaseRef;
    try {
      await execAsync(`git rev-parse --verify ${quoteArg(baseRef)}`, { cwd: rootDir, timeout: 30_000 });
    } catch {
      if (!integrationRemote) {
        return null;
      }
      const remoteRef = `${integrationRemote}/${requestedBaseRef}`;
      try {
        await execAsync(`git rev-parse --verify ${quoteArg(remoteRef)}`, { cwd: rootDir, timeout: 30_000 });
        baseRef = remoteRef;
      } catch {
        return null;
      }
    }

    try {
      const { stdout } = await execAsync(
        `git rev-list --count ${quoteArg(baseRef)}..${quoteArg(branch)}`,
        { cwd: rootDir, timeout: 30_000 },
      );
      const aheadCount = Number.parseInt(stdout.trim(), 10);
      if (!Number.isFinite(aheadCount)) {
        return null;
      }
      return { aheadCount, baseRef };
    } catch {
      return null;
    }
  };

  const aheadInfo = await resolveAheadCount();
  if (aheadInfo?.aheadCount === 0) {
    const classification = await classifyOwnedLandedEvidence(rootDir, task, { mergeTargetBranch: aheadInfo.baseRef });
    if (classification.kind === "owned-commit") {
      const mergeCommitMessage = await regenerateBareMergeSubject({
        subject: classification.commit.subject,
        commitSha: classification.commit.sha,
        branch,
        taskId,
        rootDir,
        settings,
      });
      const mergeDetails: MergeDetails = {
        ...(task.mergeDetails || {}),
        commitSha: classification.commit.sha,
        filesChanged: classification.commit.filesChanged,
        insertions: classification.commit.insertions,
        deletions: classification.commit.deletions,
        mergeCommitMessage,
        mergeConfirmed: true,
        mergedAt: new Date().toISOString(),
        prNumber: task.prInfo?.number,
        mergeTargetBranch: aheadInfo.baseRef,
      };
      await store.updateTask(taskId, { mergeDetails });
      await store.logEntry(taskId, `Auto-finalized: recovered owned landed commit ${classification.commit.sha.slice(0, 8)}`);
      const result: MergeResult = {
        task,
        branch,
        merged: true,
        worktreeRemoved: false,
        branchDeleted: false,
        mergeConfirmed: true,
        mergedAt: mergeDetails.mergedAt,
        mergeTargetBranch: aheadInfo.baseRef,
      };
      await recordBranchGroupMemberLanding();
      await completeTask(store, taskId, result);
      await releaseReuseHandoffEarly("success");
      return result;
    }

    if (classification.kind === "proven-no-op" || classification.kind === "no-changes-finalized") {
      // FN-5490/FN-5517/FN-5526/FN-5540 guard: the classifier only sees git
      // evidence, but the task itself can attest that work happened. When
      // modifiedFiles is non-empty AND no commit landed, that's lost work
      // (uncommitted in the worktree, or the squash committed the wrong tree)
      // — NOT a legitimate no-op. Demote to the unproven-recovery path which
      // moves the task back to todo with progress preserved instead of
      // clearing modifiedFiles to [].
      const noCommitsFinalize = evaluateNoCommitsNoOpFinalize(task);
      if (noCommitsFinalize.blocked) {
        const reason = noCommitsFinalize.reason ?? "no-commits task has incomplete work with no net branch changes";
        /*
         * FNXC:Lifecycle 2026-06-14-20:08:
         * FN-6461/FN-6455 extends the FN-5490 no-op demotion pattern to no-commits tasks whose skipped/incomplete steps outweigh completed work.
         */
        await store.updateTask(taskId, { error: reason });
        await store.logEntry(
          taskId,
          `Finalize blocked (no-commits incomplete-work guard): ${reason} — moving back to todo with progress preserved`,
          JSON.stringify({
            doneCount: noCommitsFinalize.doneCount,
            incompleteCount: noCommitsFinalize.incompleteCount,
            classification: classification.kind,
            baseRef: classification.baseRef,
            lane: "legacy-no-op-classifier",
          }, null, 2),
        );
        await (store as any).recordRunAuditEvent?.({
          domain: "database",
          mutationType: "task:no-commits-finalize-blocked-incomplete-steps",
          target: taskId,
          metadata: {
            reason,
            doneCount: noCommitsFinalize.doneCount,
            incompleteCount: noCommitsFinalize.incompleteCount,
            classification: classification.kind,
            baseRef: classification.baseRef,
            lane: "legacy-no-op-classifier",
          },
        });
        await store.moveTask(taskId, "todo", { preserveProgress: true, moveSource: "engine" } as any);
        await releaseReuseHandoffEarly("no-commits-incomplete-blocked");
        return {
          task,
          branch,
          merged: false,
          noOp: false,
          ok: true,
          reason,
          worktreeRemoved: false,
          branchDeleted: false,
          error: reason,
        };
      }
      if (task.modifiedFiles && task.modifiedFiles.length > 0) {
        const reason = `lost-work-detected: ${task.modifiedFiles.length} modifiedFiles claimed but no commit landed`;
        await store.updateTask(taskId, { error: reason });
        await store.logEntry(
          taskId,
          `Finalize blocked (lost-work guard): task claims ${task.modifiedFiles.length} modifiedFiles but classification would finalize as no-op — moving back to todo with progress preserved`,
          JSON.stringify({
            modifiedFilesSample: task.modifiedFiles.slice(0, 5),
            classification: classification.kind,
          }, null, 2),
        );
        await (store as any).recordRunAuditEvent?.({
          domain: "database",
          mutationType: "task:finalize-lost-work-blocked",
          target: taskId,
          metadata: {
            modifiedFilesCount: task.modifiedFiles.length,
            classification: classification.kind,
          },
        });
        await store.moveTask(taskId, "todo", { preserveProgress: true, moveSource: "engine" } as any);
        await releaseReuseHandoffEarly("lost-work-blocked");
        return {
          task,
          branch,
          merged: false,
          worktreeRemoved: false,
          branchDeleted: false,
          error: reason,
        };
      }
      const noOpReason = classification.kind === "proven-no-op"
        ? `branch has zero commits ahead of ${classification.baseRef}`
        : "verification-only finalize: no branch and no owned commits";
      const mergeDetails: MergeDetails = {
        ...(task.mergeDetails || {}),
        mergeConfirmed: true,
        noOpMerge: true,
        noOpReason,
        landedFiles: [],
        mergedAt: new Date().toISOString(),
        prNumber: task.prInfo?.number,
        mergeTargetBranch: classification.baseRef,
      };
      await store.updateTask(taskId, { mergeDetails, modifiedFiles: [] });
      await store.logEntry(
        taskId,
        classification.kind === "proven-no-op"
          ? `Auto-finalized no-op (proven): start point on ${classification.baseRef}; modifiedFiles cleared`
          : "Auto-finalized verification-only no-change task: branch absent with no owned commits; modifiedFiles cleared",
      );
      const result: MergeResult = {
        task,
        branch,
        merged: true,
        noOp: true,
        worktreeRemoved: false,
        branchDeleted: false,
        mergeConfirmed: true,
        noOpMerge: true,
        noOpReason,
        mergedAt: mergeDetails.mergedAt,
        mergeTargetBranch: classification.baseRef,
      };
      await recordBranchGroupMemberLanding();
      await completeTask(store, taskId, result);
      await releaseReuseHandoffEarly("success");
      return result;
    }

    const unprovenError = `finalize-unproven: ${classification.reason}`;
    await store.updateTask(taskId, { error: unprovenError });
    await store.logEntry(
      taskId,
      `Finalize blocked: unproven ownership evidence (${classification.reason}); no owned landed commit was found — auto-retrying via todo requeue`,
      JSON.stringify(classification.details, null, 2),
    );
    await (store as any).recordRunAuditEvent?.({
      domain: "database",
      mutationType: "task:finalize-unproven-blocked",
      target: taskId,
      metadata: { reason: classification.reason, details: classification.details, autoRetry: true },
    });
    await store.moveTask(taskId, "todo", { preserveProgress: true, moveSource: "engine" } as any);
    await releaseReuseHandoffEarly(unprovenError);
    return {
      task,
      branch,
      merged: false,
      worktreeRemoved: false,
      branchDeleted: false,
      error: unprovenError,
    };
  }

  // Advisory: announce that rootDir is volatile until this merge finishes.
  // Dashboards / status lines / pre-Edit hooks can read this file to warn
  // devs that edits made now may end up in a race-rescue stash. Not a lock —
  // we explicitly do NOT block dev edits, just make the timing risk legible.
  const activeStatusPath = writeActiveMergerStatus(rootDir, taskId);

  // Sweep autostash orphans from prior merges before creating a new one.
  // Subsumed orphans (content fully on HEAD) get dropped; live orphans get
  // surfaced on the task feed so the developer notices them.
  await sweepAutostashOrphans(rootDir, taskId, store);

  // Pre-merge guard against the common single-checkout setup where rootDir
  // is the developer's working tree. The merge flow below issues several
  // `git reset --hard/--merge` calls and forced checkouts that would
  // otherwise wipe any unrelated unstaged/untracked dev edits. Stash them
  // here, restore in the finally below — see stashUnrelatedRootDirChanges
  // for the full rationale.
  let autostashHandle: AutostashHandle | null;
  try {
    autostashHandle = await stashUnrelatedRootDirChanges(rootDir, taskId);
  } catch (err: unknown) {
    if (err instanceof AutostashCreationFailedError) {
      // Surface to the task feed so the developer sees their edits are still
      // in the working tree (not destroyed) — we just refused to proceed.
      const message = `Merge aborted: could not autostash dirty working tree in ${rootDir} (${err.message}). Your uncommitted changes are intact. Commit, stash, or revert them and retry the merge.`;
      await store.logEntry(taskId, "Merge aborted: autostash creation failed (dirty edits preserved)", message).catch(() => undefined);
      await store.updateTask(taskId, { error: "autostash-create-failed" }).catch(() => undefined);
      clearActiveMergerStatus(activeStatusPath, taskId);
      await releaseReuseHandoffEarly("autostash-create-failed");
      return {
        task,
        branch,
        merged: false,
        worktreeRemoved: false,
        branchDeleted: false,
        error: message,
      };
    }
    throw err;
  }
  // Surface any race-rescue stashes (mid-run dev edits caught between
  // initial snapshot and the destructive reset) on the task feed so the
  // operator sees the recovery handle without having to grep `git stash list`.
  if (autostashHandle?.rescueShas?.length) {
    for (const r of autostashHandle.rescueShas) {
      await store.logEntry(
        taskId,
        `Race-rescue stash created during pre-merge autostash: ${r.sha.slice(0, 7)} (${r.label})`,
        `These are working-tree changes that landed AFTER the initial autostash snapshot but BEFORE the destructive reset. Recover with:\n  cd ${rootDir} && git stash apply ${r.sha}`,
      ).catch(() => undefined);
    }
  }
  // Hoisted so the finally block (below) can attach the autostash outcome
  // to the result object the caller will receive.
  let resultForFinally: MergeResult | undefined;
  let reuseHandoffOutcome = "success";
  try {

  const sourceIssueRef = buildSourceIssueRef(task.sourceIssue);
  const worktreePath = task.worktree;
  const result: MergeResult = {
    task,
    branch,
    merged: false,
    worktreeRemoved: false,
    branchDeleted: false,
  };
  resultForFinally = result;


  if (!worktreePath) {
    mergerLog.warn(`${taskId}: no worktree path set — skipping worktree cleanup`);
  }

  // 2. Read settings
  const includeTaskId = settings.includeTaskIdInCommit !== false;
  const smartConflictResolution = isSmartConflictResolutionEnabled(settings);
  const mergeConflictStrategy: CanonicalMergeConflictStrategy = normalizeMergeConflictStrategy(
    settings.mergeConflictStrategy,
  );
  const mergeStrategyOverlapBehavior = normalizeMergeStrategyOverlapBehavior(
    settings.mergeStrategyOverlapBehavior,
  );

  // Pre-merge sync: for the smart strategies, opportunistically fast-forward
  // local main from origin so a freshly-pushed sibling commit isn't clobbered
  // by `-X ours`/`-X theirs` falling back to a stale base. Best-effort: any
  // failure (no remote, network down, divergent local) logs and continues.
  if (mergeConflictStrategy === "smart-prefer-main" || mergeConflictStrategy === "smart-prefer-branch") {
    await tryFastForwardFromOrigin(rootDir, taskId, mergeTarget.branch, integrationRemote);
  }

  // Tracks the "empty squash" success path — when `git merge --squash`
  // staged nothing, mergeAttempt returns true without making a new commit.
  // HEAD then points at pre-merge main, which has nothing to do with this
  // task. We avoid recording that sha as commitSha (which would mislead
  // every consumer of mergeDetails). Set by the squashIsEmpty / staged===0
  // sites in mergeAttempt + attemptWithSideStrategy.
  let mergeWasEmpty = false;
  let recoveredMergeSha: string | undefined;

  // 3. Check branch exists
  try {
    execSync(`git rev-parse --verify "${branch}"`, {
      cwd: rootDir,
      stdio: "pipe",
    });
  } catch {
    const classification = await classifyOwnedLandedEvidence(rootDir, task, { mergeTargetBranch: mergeTarget.branch });
    if (classification.kind === "unproven") {
      result.error = `finalize-unproven: ${classification.reason}`;
      await store.updateTask(taskId, { error: result.error });
      await store.logEntry(
        taskId,
        `Finalize blocked: unproven ownership evidence (${classification.reason}); branch missing and no owned landed commit was found — auto-retrying via todo requeue`,
        JSON.stringify(classification.details, null, 2),
      );
      await (store as any).recordRunAuditEvent?.({
        domain: "database",
        mutationType: "task:finalize-unproven-blocked",
        target: taskId,
        metadata: { reason: classification.reason, details: classification.details, branchMissing: true, autoRetry: true },
      });
      await store.moveTask(taskId, "todo", { preserveProgress: true, moveSource: "engine" } as any);
      return result;
    }

    if (classification.kind === "owned-commit") {
      const mergedAt = new Date().toISOString();
      const mergeCommitMessage = await regenerateBareMergeSubject({
        subject: classification.commit.subject,
        commitSha: classification.commit.sha,
        branch,
        taskId,
        rootDir,
        settings,
      });
      await store.updateTask(taskId, {
        mergeDetails: {
          commitSha: classification.commit.sha,
          filesChanged: classification.commit.filesChanged,
          insertions: classification.commit.insertions,
          deletions: classification.commit.deletions,
          mergeCommitMessage,
          mergedAt,
          mergeConfirmed: true,
          prNumber: task.prInfo?.number,
          mergeTargetBranch: mergeTarget.branch,
          mergeTargetSource: mergeTarget.source,
        },
      });
      result.merged = true;
      result.mergeConfirmed = true;
      result.commitSha = classification.commit.sha;
      result.filesChanged = classification.commit.filesChanged;
      result.insertions = classification.commit.insertions;
      result.deletions = classification.commit.deletions;
      result.mergeCommitMessage = mergeCommitMessage;
      result.mergedAt = mergedAt;
      result.mergeTargetBranch = mergeTarget.branch;
      result.mergeTargetSource = mergeTarget.source;
      mergerLog.log(`${taskId}: branch missing; recovered owned landed commit ${classification.commit.sha.slice(0, 8)}`);
    } else {
      const noCommitsFinalize = evaluateNoCommitsNoOpFinalize(task);
      if (noCommitsFinalize.blocked) {
        const reason = noCommitsFinalize.reason ?? "no-commits task has incomplete work with no net branch changes";
        /*
         * FNXC:Lifecycle 2026-06-14-20:10:
         * FN-6461/FN-6455 applies the same no-commits incomplete-work guard when branch-missing classification would otherwise finalize a zero-change task.
         */
        result.error = reason;
        result.reason = reason;
        result.noOp = false;
        await store.updateTask(taskId, { error: reason });
        await store.logEntry(
          taskId,
          `Finalize blocked (no-commits incomplete-work guard): ${reason} — moving back to todo with progress preserved`,
          JSON.stringify({
            doneCount: noCommitsFinalize.doneCount,
            incompleteCount: noCommitsFinalize.incompleteCount,
            classification: classification.kind,
            baseRef: classification.baseRef,
            lane: "legacy-branch-missing-no-op",
          }, null, 2),
        );
        await (store as any).recordRunAuditEvent?.({
          domain: "database",
          mutationType: "task:no-commits-finalize-blocked-incomplete-steps",
          target: taskId,
          metadata: {
            reason,
            doneCount: noCommitsFinalize.doneCount,
            incompleteCount: noCommitsFinalize.incompleteCount,
            classification: classification.kind,
            baseRef: classification.baseRef,
            lane: "legacy-branch-missing-no-op",
          },
        });
        await store.moveTask(taskId, "todo", { preserveProgress: true, moveSource: "engine" } as any);
        return result;
      }
      const noOpReason = `branch has zero commits ahead of ${classification.baseRef}`;
      const mergedAt = new Date().toISOString();
      await store.updateTask(taskId, {
        modifiedFiles: [],
        mergeDetails: {
          ...(task.mergeDetails || {}),
          mergeConfirmed: true,
          noOpMerge: true,
          noOpReason,
          landedFiles: [],
          mergedAt,
          prNumber: task.prInfo?.number,
          mergeTargetBranch: classification.baseRef,
          mergeTargetSource: mergeTarget.source,
        },
      });
      result.merged = true;
      result.mergeConfirmed = true;
      result.noOp = true;
      result.noOpMerge = true;
      result.noOpReason = noOpReason;
      result.mergedAt = mergedAt;
      result.mergeTargetBranch = classification.baseRef;
      result.mergeTargetSource = mergeTarget.source;
      await store.logEntry(taskId, `Auto-finalized no-op (proven): start point on ${classification.baseRef}; modifiedFiles cleared`);
    }

    // Audit trail: record merge completion (FN-1404)
    await audit.database({ type: "task:move", target: taskId, metadata: { to: "done", merged: true } });
    await recordBranchGroupMemberLanding();
    await completeTask(store, taskId, result);
    return result;
  }

  // 3b. Ensure rootDir is based on the resolved integration target before merging.
  // In reuse-task-worktree mode the task worktree is branch-bound, so we detach
  // to the integration branch tip instead of checking out the integration branch
  // directly; this keeps the project root untouched while preserving the merge
  // cascade's expected `preAttemptHeadSha === integration target` invariant.
  try {
    throwIfAborted(options.signal, taskId);
    const currentBranch = execSyncText("git symbolic-ref --short HEAD", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (reuseTaskWorktreeMerge) {
      mergerLog.log(
        `${taskId}: reusing task worktree — detaching HEAD at '${mergeTarget.branch}' before merge (${mergeTarget.source})`,
      );
      await execAsync(`git checkout --detach "${mergeTarget.branch}"`, {
        cwd: rootDir,
      });
      await audit.git({ type: "branch:checkout", target: mergeTarget.branch });
    } else if (currentBranch !== mergeTarget.branch) {
      mergerLog.log(`${taskId}: rootDir on '${currentBranch}', checking out '${mergeTarget.branch}' before merge (${mergeTarget.source})`);
      await execAsync(`git checkout "${mergeTarget.branch}"`, {
        cwd: rootDir,
      });
      await audit.git({ type: "branch:checkout", target: mergeTarget.branch });
    }
  } catch (error: unknown) {
    rethrowIfMergeAborted(error);
    mergerLog.warn(`${taskId}: unable to verify/checkout merge target '${mergeTarget.branch}' — proceeding on current HEAD`);
  }

  // 3c. Pre-merge remote rebase.
  // `rootDir` is the resolved integration root for this merge attempt: either
  // the project root (`cwd-integration-branch`) or the reused task worktree after the FN-5279
  // handoff gates. All fetch/rebase commands below intentionally stay on that
  // resolved root so the full conflict cascade runs in one place.
  //
  // When another collaborator (or another fusion worker on a different
  // machine) pushes to the remote while our task branch is in flight, the
  // merge would otherwise surface as a conflict. Rebasing the task branch
  // onto the latest remote tip beforehand turns most of those into trivial
  // fast-forwards. When conflicts do appear the existing smart/AI resolve
  // flow (Attempts 1–3 below) picks them up just like normal merge
  // conflicts — the caller doesn't need to distinguish.
  //
  // Controlled by `settings.worktreeRebaseBeforeMerge` (default true) and
  // `settings.worktreeRebaseRemote` (empty → use repo's default remote).
  //
  // For "smart-prefer-main" we treat a rebase abort as a hard error: a stale
  // branch base means the -X ours fallback can silently re-add code that main
  // recently deleted (the merge sees branch additions vs main deletions as
  // non-conflicting). Track here and throw outside the catch wrapper.
  //
  // The block runs as TWO INDEPENDENT STAGES so that prefer-main always gets
  // the strongest available rebase coverage:
  //   Stage 1 (remote): rebase onto remote/main when enabled + remote resolves.
  //                     Picks up upstream pushes from collaborators / other
  //                     workers.
  //   Stage 2 (local-base): rebase onto rootDir's HEAD when enabled. Picks up
  //                         sibling-task merges that landed locally but
  //                         haven't pushed yet, AND covers the no-remote case
  //                         where Stage 1 silently skipped.
  // Either stage failing under prefer-main is a hard error.
  let rebaseHappened = false;
  let preferMainRebaseFailureMessage: string | undefined;

  if (worktreePath && task.baseCommitSha) {
    try {
      throwIfAborted(options.signal, taskId);
      // Read the authoritative integration-branch tip from the shared ref —
      // NOT rootDir's HEAD. In reuse-task-worktree mode rootDir's HEAD can
      // lag behind refs/heads/<integrationBranch> when a sibling merger
      // advanced the ref via update-ref without re-checking-out, and using a
      // stale base sha here causes the eventual squash commit to parent off
      // an earlier sha and orphan the previously-merged tip on a subsequent
      // non-FF ref advance.
      const refName = `refs/heads/${mergeTarget.branch}`;
      const { stdout: mainHeadOut } = await execAsync(
        `git rev-parse --verify ${refName}`,
        { cwd: rootDir, encoding: "utf-8" },
      );
      const mainHead = mainHeadOut.trim();
      if (mainHead) {
        const divergence = await probeDivergence({
          rootDir,
          baseCommitSha: task.baseCommitSha,
          mainRef: mainHead,
        });
        const prerebaseDecision = decideAutoPrerebase({
          settings,
          baseCommitSha: task.baseCommitSha,
          commitsBehind: divergence.commitsBehind,
          changedFiles: divergence.changedFiles,
          worktrunkEnabled: settings.worktrunk?.enabled === true,
        });

        const prerebaseMetadata = {
          reason: prerebaseDecision.reason,
          commitsBehind: prerebaseDecision.commitsBehind,
          hotMatches: prerebaseDecision.hotMatches,
          baseCommitSha: task.baseCommitSha,
          mainHead,
          taskId,
        };

        if (!prerebaseDecision.fire) {
          await audit.git({
            type: "merge:auto-prerebase:skipped",
            target: taskId,
            metadata: prerebaseMetadata,
          });
        } else {
          throwIfAborted(options.signal, taskId);
          const prerebaseResult = await runAutoPrerebase({
            rootDir,
            worktreePath,
            branch,
            taskId,
            mainHead,
            logger: mergerLog,
          });
          if (prerebaseResult.ok) {
            rebaseHappened = true;
            await store.appendAgentLog(
              taskId,
              `Pre-merge auto-prerebase: ${branch} → local HEAD ${mainHead.slice(0, 8)} (${prerebaseDecision.reason})`,
              "status",
              undefined,
              "merger",
            );
            await audit.git({
              type: "merge:auto-prerebase:applied",
              target: taskId,
              metadata: prerebaseMetadata,
            });
          } else {
            mergerLog.warn(`${taskId}: auto-prerebase failed (${prerebaseResult.error ?? "unknown"}) — proceeding to existing rebase cascade`);
            await audit.git({
              type: "merge:auto-prerebase:failed",
              target: taskId,
              metadata: {
                ...prerebaseMetadata,
                error: prerebaseResult.error ?? "unknown",
              },
            });
          }
        }
      }
    } catch (err: unknown) {
      rethrowIfMergeAborted(err);
      mergerLog.warn(`${taskId}: auto-prerebase probe failed (${getCommandErrorMessage(err)}) — proceeding to existing rebase cascade`);
      await audit.git({
        type: "merge:auto-prerebase:failed",
        target: taskId,
        metadata: {
          reason: "no-divergence",
          commitsBehind: 0,
          hotMatches: [],
          baseCommitSha: task.baseCommitSha,
          mainHead: "",
          taskId,
          error: getCommandErrorMessage(err),
        },
      });
    }
  }

  // Semantic guards: prefer-main with no rebase available is incoherent —
  // the strategy depends on rebase to honor main's deletions. Fail fast
  // before we waste work attempting a merge that can't deliver its promise.
  if (
    settings.worktreeRebaseBeforeMerge === false
    && settings.worktreeRebaseLocalBase === false
    && mergeConflictStrategy === "smart-prefer-main"
  ) {
    throw new Error(
      `Incompatible settings for ${taskId}: mergeConflictStrategy="smart-prefer-main" ` +
      `requires at least one of worktreeRebaseBeforeMerge or worktreeRebaseLocalBase ` +
      `to remain enabled. The strategy relies on rebasing the branch onto current main ` +
      `to preserve main's deletions; with both disabled it can silently re-introduce ` +
      `branch-only content. Re-enable a rebase stage or switch to "smart-prefer-branch" ` +
      `/ "ai-only".`,
    );
  }

  // Helper: run the local-base rebase (Stage 2). Centralized so both
  // entry points (after Stage 1, or standalone when Stage 1 is disabled)
  // share the same logic for ancestor check, rebase, and abort handling.
  async function runLocalBaseRebase(label: string): Promise<void> {
    if (!worktreePath) return;
    try {
      const { stdout: localHeadOut } = await execAsync("git rev-parse HEAD", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      const localHead = localHeadOut.trim();
      if (!localHead) return;

      // Skip if worktree branch already contains local HEAD.
      let alreadyContains = false;
      try {
        await execAsync(`git merge-base --is-ancestor "${localHead}" HEAD`, { cwd: worktreePath });
        alreadyContains = true;
      } catch {
        // not an ancestor — rebase needed
      }

      if (alreadyContains) {
        // Branch is already up-to-date with current main; prefer-main is
        // satisfied without re-running git rebase.
        rebaseHappened = true;
        return;
      }

      throwIfAborted(options.signal, taskId);
      await execAsync(`git rebase "${localHead}"`, { cwd: worktreePath });
      rebaseHappened = true;
      mergerLog.log(`${taskId}: rebased ${branch} onto local HEAD ${localHead.slice(0, 8)}${label ? ` (${label})` : ""}`);
      await store.appendAgentLog(
        taskId,
        `Pre-merge rebase: ${branch} → local HEAD ${localHead.slice(0, 8)}${label ? ` (${label})` : ""}`,
        "status",
        undefined,
        "merger",
      );
    } catch (localRebaseErr) {
      rethrowIfMergeAborted(localRebaseErr);
      const lmsg = localRebaseErr instanceof Error ? localRebaseErr.message : String(localRebaseErr);
      mergerLog.warn(`${taskId}: pre-merge rebase onto local HEAD failed (${lmsg}) — aborting and falling through`);
      try {
        await execAsync("git rebase --abort", { cwd: worktreePath });
      } catch (abortError: unknown) {
        mergerLog.warn(`${taskId}: failed to abort local-HEAD rebase: ${getCommandErrorMessage(abortError)}`);
      }
      if (mergeConflictStrategy === "smart-prefer-main" && !preferMainRebaseFailureMessage) {
        preferMainRebaseFailureMessage = `Pre-merge rebase onto local HEAD aborted (${lmsg})`;
      }
    }
  }

  // ── Stage 1: remote rebase ────────────────────────────────────────────
  if (settings.worktreeRebaseBeforeMerge !== false) {
    try {
      if (!integrationRemote) {
        mergerLog.log(`${taskId}: no integration remote resolvable — skipping remote rebase stage (local-base stage may still run)`);
      } else if (!worktreePath) {
        mergerLog.warn(`${taskId}: no worktreePath — skipping remote rebase stage`);
      } else {
        throwIfAborted(options.signal, taskId);
        mergerLog.log(`${taskId}: fetching ${integrationRemote} before merge`);
        await execAsync(`git fetch ${quoteArg(integrationRemote)}`, { cwd: rootDir });

        try {
          const remoteRef = `${integrationRemote}/${mergeTarget.branch}`;
          throwIfAborted(options.signal, taskId);
          await execAsync(`git rebase ${quoteArg(remoteRef)}`, { cwd: worktreePath });
          rebaseHappened = true;
          mergerLog.log(`${taskId}: rebased ${branch} onto ${remoteRef}`);
          await store.appendAgentLog(
            taskId,
            `Pre-merge rebase: ${branch} → ${remoteRef}`,
            "status",
            undefined,
            "merger",
          );
        } catch (rebaseErr) {
          rethrowIfMergeAborted(rebaseErr);
          const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
          mergerLog.warn(`${taskId}: pre-merge rebase failed (${msg}) — aborting rebase and falling through`);
          if (worktreePath) {
            try {
              await execAsync("git rebase --abort", { cwd: worktreePath });
            } catch (abortError: unknown) {
              mergerLog.warn(`${taskId}: failed to abort pre-merge rebase: ${getCommandErrorMessage(abortError)}`);
            }
          }
          if (mergeConflictStrategy === "smart-prefer-main") {
            preferMainRebaseFailureMessage = `Pre-merge rebase onto remote ${mergeTarget.branch} aborted (${msg})`;
          }
        }
      }
    } catch (err) {
      rethrowIfMergeAborted(err);
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: pre-merge remote rebase pipeline failed (${msg}) — proceeding without remote rebase`);
    }
  }

  // ── Stage 2: local-base rebase ─────────────────────────────────────────
  // Runs independently of Stage 1, so the no-remote case still gets coverage.
  // Skipped if Stage 1 already aborted under prefer-main (we'll throw below
  // anyway, and a second attempt just adds noise).
  if (
    settings.worktreeRebaseLocalBase !== false
    && !preferMainRebaseFailureMessage
  ) {
    await runLocalBaseRebase(
      settings.worktreeRebaseBeforeMerge === false ? "remote rebase disabled" : "",
    );
  }

  // ── Recovery cascade for prefer-main rebase failures ──────────────────
  //
  // Previous behavior: throw immediately when prefer-main rebase aborted.
  // This left tasks stuck in in-review forever when the conflict was a known
  // recoverable shape (e.g., a dependency task was squash-merged to main, so
  // the dependent's branch carries orphan raw commits whose content is
  // already in main but in a different commit shape).
  //
  // New behavior: try increasingly broad recovery strategies in order. Each
  // layer is fail-soft — if it can't help, we move on without changing
  // worktree state. After all layers run, if rebase still hasn't succeeded,
  // we log the situation and proceed to AI arbitration (the standard
  // 3-attempt merge cascade), which is gated by post-merge `pnpm test` and
  // `pnpm build` verification — so the safety constraint that prefer-main
  // exists to enforce (no silent re-introduction of main's deletions) is
  // preserved by the deterministic verification gate.
  let preMergeRebaseFallthrough: string | undefined;
  if (preferMainRebaseFailureMessage && worktreePath) {
    // Resolve the rebase target the same way Stage 2 did: rootDir's HEAD.
    // Stage 1 (remote) already ran if enabled; Stage 2 (local) is what
    // would have unified branch+local. We use local HEAD as the target so
    // Layers 1/2 land where Stage 2 wanted to.
    let rebaseTarget = "";
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      rebaseTarget = stdout.trim();
    } catch {
      rebaseTarget = "";
    }

    // Layer 1: surgical drop of declared-dependency commits.
    // When `task.executionStartBranch` is a non-integration branch (a sibling task's branch),
    // the dependent worktree was forked off it and inherited its commits.
    // If the dep was later squash-merged to the integration branch, those raw commits are now
    // orphans whose content already exists in main. Re-rebase the task
    // branch onto the integration branch using `git rebase --onto <target> <dep-tip> <branch>`,
    // which peels off the dep's commits cleanly.
    if (rebaseTarget && task.executionStartBranch && task.executionStartBranch !== mergeTarget.branch) {
      // Resolve the dep's tip — prefer the live branch ref, fall back to
      // the recorded baseCommitSha if the branch was already deleted.
      let depTip: string | undefined;
      try {
        const { stdout } = await execAsync(
          `git rev-parse --verify "${task.executionStartBranch}^{commit}"`,
          { cwd: rootDir, encoding: "utf-8" },
        );
        depTip = stdout.trim() || undefined;
      } catch {
        depTip = undefined;
      }
      if (!depTip && task.baseCommitSha) {
        try {
          const { stdout } = await execAsync(
            `git rev-parse --verify "${task.baseCommitSha}^{commit}"`,
            { cwd: rootDir, encoding: "utf-8" },
          );
          depTip = stdout.trim() || undefined;
        } catch {
          depTip = undefined;
        }
      }

      if (depTip && depTip !== rebaseTarget) {
        try {
          throwIfAborted(options.signal, taskId);
          // Reset rebase state defensively in case a previous attempt left
          // a half-applied rebase in place.
          await execAsync("git rebase --abort", { cwd: worktreePath }).catch(
            () => undefined,
          );
          await execAsync(
            `git rebase --onto "${rebaseTarget}" "${depTip}" "${branch}"`,
            { cwd: worktreePath },
          );
          preferMainRebaseFailureMessage = undefined;
          rebaseHappened = true;
          mergerLog.log(
            `${taskId}: Layer 1 recovery — rebased ${branch} --onto ${rebaseTarget.slice(0, 8)} dropping commits up to dep tip ${depTip.slice(0, 8)} (executionStartBranch=${task.executionStartBranch})`,
          );
          await store.logEntry(
            taskId,
            `Pre-merge recovery (Layer 1): dropped dependency commits from ${task.executionStartBranch} via rebase --onto ${rebaseTarget.slice(0, 8)} ${depTip.slice(0, 8)} ${branch}; the merge will proceed against the cleaned branch`,
          );
        } catch (layer1Err) {
          rethrowIfMergeAborted(layer1Err);
          mergerLog.warn(
            `${taskId}: Layer 1 (dep-drop) recovery failed: ${layer1Err instanceof Error ? layer1Err.message : String(layer1Err)}`,
          );
          await execAsync("git rebase --abort", { cwd: worktreePath }).catch(
            () => undefined,
          );
        }
      }
    }

    // Layer 2: generic patch-id duplicate stripping.
    // Compute patch-ids of recent main commits (last 500). Walk the task
    // branch's commits in target..branch and identify those whose patch-id
    // already exists in main — they're duplicates whose content has landed
    // (via squash, cherry-pick, manual replay, etc.). Cherry-pick the
    // non-duplicate commits onto target to produce a clean branch.
    if (preferMainRebaseFailureMessage && rebaseTarget && worktreePath) {
      try {
        throwIfAborted(options.signal, taskId);
        const mainPatchIds = await collectPatchIds(rootDir, rebaseTarget, 500);
        const branchCommits = await listBranchCommits(rootDir, rebaseTarget, branch);
        if (branchCommits.length === 0) {
          // Nothing to replay — branch is up-to-date with target.
          rebaseHappened = true;
          preferMainRebaseFailureMessage = undefined;
        } else {
          const surviving: string[] = [];
          let dropped = 0;
          for (const sha of branchCommits) {
            const pid = await commitPatchId(rootDir, sha);
            if (pid && mainPatchIds.has(pid)) {
              dropped += 1;
            } else {
              surviving.push(sha);
            }
          }
          if (dropped > 0 && surviving.length === branchCommits.length) {
            // Should be impossible (dropped>0 means some were filtered), but
            // guard against logic errors before mutating worktree state.
            mergerLog.warn(`${taskId}: Layer 2 internal accounting mismatch — skipping`);
          } else if (dropped > 0) {
            // Capture the branch's pre-mutation SHA so we can restore on any
            // partial-failure path. Without this, a failed cherry-pick midway
            // through would leave the branch at a half-replayed state worse
            // than the original conflict.
            let originalBranchSha = "";
            try {
              const { stdout } = await execAsync(
                `git rev-parse --verify "${branch}^{commit}"`,
                { cwd: worktreePath, encoding: "utf-8" },
              );
              originalBranchSha = stdout.trim();
            } catch {
              originalBranchSha = "";
            }
            const restoreOriginalBranch = async () => {
              if (!originalBranchSha) return;
              // Hard-reset clears any in-progress cherry-pick / merge state
              // and resets the index, so the subsequent forced checkout has
              // no conflicting unmerged paths to refuse on.
              await execAsync(`git reset --hard "${originalBranchSha}"`, {
                cwd: worktreePath,
              }).catch(() => undefined);
              await execAsync(`git checkout -f "${branch}"`, { cwd: worktreePath }).catch(
                () => undefined,
              );
              await execAsync(`git reset --hard "${originalBranchSha}"`, {
                cwd: worktreePath,
              }).catch(() => undefined);
            };

            try {
              await execAsync("git rebase --abort", { cwd: worktreePath }).catch(
                () => undefined,
              );
              await execAsync(`git checkout "${branch}"`, { cwd: worktreePath });
              await execAsync(`git reset --hard "${rebaseTarget}"`, {
                cwd: worktreePath,
              });
              for (const sha of surviving) {
                throwIfAborted(options.signal, taskId);
                try {
                  await execAsync(`git cherry-pick --allow-empty "${sha}"`, {
                    cwd: worktreePath,
                  });
                } catch (pickErr) {
                  rethrowIfMergeAborted(pickErr);
                  // A surviving commit conflicts with target despite its
                  // patch-id not matching — abort the cherry-pick, restore
                  // the branch to its original tip, and let Layer 3 take over.
                  await execAsync("git cherry-pick --abort", { cwd: worktreePath }).catch(
                    () => undefined,
                  );
                  await restoreOriginalBranch();
                  throw pickErr;
                }
              }
              preferMainRebaseFailureMessage = undefined;
              rebaseHappened = true;
              mergerLog.log(
                `${taskId}: Layer 2 recovery — patch-id stripped ${dropped} duplicate commit(s); replayed ${surviving.length} survivor(s) onto ${rebaseTarget.slice(0, 8)}`,
              );
              await store.logEntry(
                taskId,
                `Pre-merge recovery (Layer 2): patch-id matched ${dropped} branch commit(s) against the last 500 main commits and dropped them as duplicates; cherry-picked ${surviving.length} unique commit(s) onto ${rebaseTarget.slice(0, 8)}`,
              );
            } catch (replayErr) {
              await restoreOriginalBranch();
              throw replayErr;
            }
          } else {
            mergerLog.log(
              `${taskId}: Layer 2 found no duplicate-content commits to drop (window=500)`,
            );
          }
        }
      } catch (layer2Err) {
        rethrowIfMergeAborted(layer2Err);
        mergerLog.warn(
          `${taskId}: Layer 2 (patch-id strip) recovery failed: ${layer2Err instanceof Error ? layer2Err.message : String(layer2Err)}`,
        );
      }
    }

    // Layer 3: if the rebase still couldn't be unblocked, fall through to
    // the AI merge cascade with a safety preamble logged to the task. The
    // existing post-merge deterministic verification (test + build) gates
    // whatever the AI produces — if the AI silently re-introduces main's
    // deletions and breaks tests/build, the task bounces back to in-progress
    // via the engine's verification-failure path. The AI never gets to
    // commit a regression that wasn't caught by tests.
    if (preferMainRebaseFailureMessage) {
      preMergeRebaseFallthrough = preferMainRebaseFailureMessage;
      preferMainRebaseFailureMessage = undefined;
      mergerLog.warn(
        `${taskId}: Layers 1 & 2 could not unblock the prefer-main rebase — falling through to AI arbitration (Layer 3). Deterministic verification will gate the result.`,
      );
      await store.logEntry(
        taskId,
        `Pre-merge recovery (Layer 3): both surgical and patch-id recovery failed; AI arbiter takes over. SAFETY CONSTRAINT for the AI: do NOT re-introduce content that current main has deleted. If hunks are ambiguous, prefer main's version. Post-merge test/build verification will reject any resolution that breaks main's intent.`,
        "PreMergeRebaseFallthrough",
      );
    }
  }

  if (preferMainRebaseFailureMessage) {
    // Reached only when there's no worktreePath — no recovery is possible
    // without a worktree to operate on.
    throw new Error(
      `${preferMainRebaseFailureMessage} for ${taskId}. ` +
      `Strategy "smart-prefer-main" requires a successful rebase to preserve main's deletions; ` +
      `recovery layers 1–3 require a worktree path which is missing for this task. ` +
      `Resolve the rebase conflict manually, or switch mergeConflictStrategy to ` +
      `"smart-prefer-branch" / "ai-only".`,
    );
  }
  // Surface the fallthrough to anything downstream that wants to vary
  // behavior under it. Currently informational only; the verification gate
  // is what enforces safety.
  void preMergeRebaseFallthrough;
  // Silent-skip observability: when prefer-main couldn't run a rebase at all
  // (no remote resolvable, no worktreePath), warn loudly so the gap is visible
  // in logs. Not a hard fail — environmental skips are common in tests and
  // some setups, and would cause too much breakage to enforce here. Production
  // monitoring can alert on this warning.
  if (mergeConflictStrategy === "smart-prefer-main" && !rebaseHappened) {
    mergerLog.warn(
      `${taskId}: smart-prefer-main ran without a successful pre-merge rebase ` +
      `(${worktreePath ? "no remote resolvable or rebase disabled" : "no worktreePath"}). ` +
      `Main's deletions may not be preserved if the branch re-introduces them.`,
    );
  }

  // 4. Gather context for the agent (used in all attempts)
  // Keep this range strategy aligned with dashboard changed-files endpoints.
  const diffBaseRef = await resolveTaskDiffBaseRef({
    cwd: rootDir,
    headRef: branch,
    baseBranch: task.baseBranch,
    baseCommitSha: task.baseCommitSha,
    integrationBranchFallback: mergeTarget.branch,
    integrationRemoteFallback: integrationRemote,
  });
  const preferBranchOnOverlapFiles = new Set<string>();
  if (
    mergeConflictStrategy === "smart-prefer-main"
    && mergeStrategyOverlapBehavior !== "ignore"
  ) {
    const overlap = await detectMergeOverlap({
      rootDir,
      branch,
      baseRef: diffBaseRef,
      mergeTargetBranch: mergeTarget.branch,
      lookback: MERGER_MAIN_OVERLAP_LOOKBACK_COMMITS,
    });

    if (overlap.overlappingFiles.length > 0) {
      const overlapSummary = formatMergeOverlapSummary(
        overlap.overlappingFiles,
        overlap.recentMainCommitsByFile,
      );
      const overlapMessage =
        `Overlap guard detected ${overlap.overlappingFiles.length} recent-main overlap file(s) ` +
        `for smart-prefer-main (${mergeStrategyOverlapBehavior}): ${overlapSummary}`;
      mergerLog.warn(`${taskId}: ${overlapMessage}`);
      await store.appendAgentLog(taskId, overlapMessage, "status", undefined, "merger");
      await store.logEntry(taskId, overlapMessage);

      if (mergeStrategyOverlapBehavior === "flip-to-prefer-branch") {
        for (const file of overlap.overlappingFiles) {
          preferBranchOnOverlapFiles.add(file);
        }
      }
    }
  }
  const contextDiffRange = diffBaseRef ? `${diffBaseRef}..${branch}` : `HEAD..${branch}`;

  let commitLog = "";
  let diffStat = "";
  try {
    const { stdout: logOutput } = await execAsync(`git log ${contextDiffRange} --format="- %s"`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    commitLog = logOutput.trim();
  } catch {
    commitLog = "(unable to read commit log)";
  }
  try {
    const { stdout: diffOutput } = await execAsync(`git diff ${contextDiffRange} --stat`, {
      cwd: rootDir,
      encoding: "utf-8",
    });
    diffStat = diffOutput.trim();
  } catch {
    diffStat = "(unable to read diff)";
  }

  let selectedPostMergeAuditStrategy: PostMergeAuditStrategy = "squash";
  let classifiedBranchCommits: BranchCommitClassification[] = [];
  // U7 (R10): `pr-only` authored on the merge trait routes through the PR flow
  // exactly like `settings.mergeStrategy === "pull-request"` — no direct-merge
  // commit routing runs.
  const isPullRequestRoute = settings.mergeStrategy === "pull-request" || mergePolicy.pullRequestOnly;
  if (!isPullRequestRoute) {
    // When the workflow's merge trait authored a commit strategy, it takes
    // precedence over the project/prompt setting (read-through, mechanics
    // unchanged); otherwise fall back to the existing resolver.
    const configuredRoute = mergePolicy.source === "workflow"
      ? { strategy: mergePolicy.commitStrategy, source: "workflow" as const }
      : resolveDirectMergeCommitStrategy(settings, task.prompt);
    if (configuredRoute.strategy === "auto") {
      try {
        const classification = await classifyBranchCommitsForDirectMerge(
          rootDir,
          diffBaseRef || mergeTarget.branch,
          branch,
        );
        classifiedBranchCommits = classification.commits;
        selectedPostMergeAuditStrategy = classification.substantiveCommitCount >= 2 ? "rebase" : "squash";
      } catch (error) {
        mergerLog.warn(`${taskId}: failed to classify branch commits for direct-merge routing: ${getCommandErrorMessage(error)}`);
        selectedPostMergeAuditStrategy = "squash";
      }
    } else {
      selectedPostMergeAuditStrategy = configuredRoute.strategy === "always-rebase" ? "rebase" : "squash";
    }

    const classificationSummary = classifiedBranchCommits.length > 0
      ? ` [${classifiedBranchCommits.map((commit) => `${commit.substantive ? "substantive" : "generated-only"}:${commit.subject}`).join("; ")}]`
      : "";
    const routeMessage =
      `Direct merge commit routing: ${selectedPostMergeAuditStrategy} ` +
      `(setting ${configuredRoute.strategy} from ${configuredRoute.source})${classificationSummary}`;
    mergerLog.log(`${taskId}: ${routeMessage}`);
    await store.appendAgentLog(taskId, routeMessage, "status", undefined, "merger");
  }

  const [aiMergeSummary, aiMergeBody, aiMergeSubject] = settings.useAiMergeCommitSummary
    ? await Promise.all([
      generateAiMergeSummary(commitLog, diffStat, settings, rootDir),
      generateAiMergeBody(commitLog, diffStat, settings, rootDir, branch, taskId, options.signal),
      generateAiMergeSubject(commitLog, diffStat, settings, rootDir, branch, taskId, options.signal),
    ])
    : [null, null, null] as const;

  // 4b. Validate diff scope against task's declared File Scope
  try {
    const scopeResult = await validateDiffScope(store, taskId, diffStat, settings.strictScopeEnforcement);
    for (const warning of scopeResult.warnings) {
      mergerLog.warn(`${taskId}: ${warning}`);
      await store.logEntry(taskId, warning);
    }
  } catch (scopeError: any) {
    if (settings.strictScopeEnforcement && scopeError.message?.includes("Scope enforcement failed")) {
      // Strict mode — block the merge
      await store.logEntry(taskId, `Merge blocked: ${scopeError.message}`);
      throw scopeError;
    }
    // Soft mode — scope validation is best-effort
  }

  // 5. Execute merge with retry logic
  // Cross-process safety net: abort if another task is already mid-merge.
  // The engine's drainMergeQueue also checks, but this catches direct callers.
  const activeMerge = await store.getActiveMergingTask(taskId);
  if (activeMerge) {
    throw new Error(
      `Cannot merge ${taskId}: task ${activeMerge} is already merging (cross-process conflict)`,
    );
  }
  await store.updateTask(taskId, { status: "merging" });

  // Normalize explicit verification commands from settings
  const explicitTestCommand = settings.testCommand?.trim() || undefined;
  const explicitBuildCommand = settings.buildCommand?.trim() || undefined;

  // Infer default test command if explicit testCommand is not set
  // This ensures merge verification runs even when settings.testCommand is not configured.
  // Thread baseBranch + branch so pnpm workspaces can be scoped to changed packages.
  const inferredTest = inferDefaultTestCommand(
    rootDir,
    explicitTestCommand,
    explicitBuildCommand,
    mergeTarget.branch,
    branch,
    // FNXC:Verification 2026-06-25-00:00: default-on, file-scope verification to
    // the branch diff so merge verification stays proportional to the change.
    settings.scopeVerificationToChangedFiles !== false,
  );
  const effectiveTestCommand = inferredTest?.command || explicitTestCommand;
  const effectiveTestSource = inferredTest?.testSource;
  const effectiveBuildCommand = explicitBuildCommand;
  const effectiveBuildSource = inferredTest?.buildSource;

  // Log what verification commands will be used
  if (effectiveTestCommand || effectiveBuildCommand) {
    mergerLog.log(
      `${taskId}: merge verification commands` +
      (effectiveTestCommand ? ` [test: ${effectiveTestCommand} (${effectiveTestSource || "explicit"})]` : "") +
      (effectiveBuildCommand ? ` [build: ${effectiveBuildCommand} (${effectiveBuildSource || "explicit"})]` : ""),
    );
  }

  const mergeAttempt = async (attemptNum: 1 | 2 | 3): Promise<boolean> => {
    mergerLog.log(`${taskId}: merge attempt ${attemptNum}/3...`);
    const attemptLabel = attemptNum === 1
      ? "Attempt 1: AI merge"
      : attemptNum === 2
        ? "Attempt 2: auto-resolve known conflicts, then AI"
        : mergeConflictStrategy === "smart-prefer-main" && preferBranchOnOverlapFiles.size > 0
          ? `Attempt 3: overlap-aware -X ours fallback (${preferBranchOnOverlapFiles.size} branch-protected file${preferBranchOnOverlapFiles.size === 1 ? "" : "s"})`
          : `Attempt 3: ${mergeConflictStrategy === "smart-prefer-main" ? "-X ours" : "-X theirs"} fallback`;
    await store.appendAgentLog(
      taskId,
      `Starting merge ${attemptLabel}`,
      "status",
      undefined,
      "merger",
    );

    await emitMergeAttemptAuditEvent({
      audit,
      branch,
      attemptNum,
      mergeConflictStrategy,
      attemptLabel,
      taskId,
    });

    // Capture HEAD before the squash so the verification-fix finalizer can
    // tell whether the AI agent actually created a commit (HEAD moved) or
    // bailed via fn_report_build_failure (HEAD didn't move). Without this,
    // the amend path silently mutated the previous task's merge commit.
    let preAttemptHeadSha = "";
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: rootDir,
        encoding: "utf-8",
      });
      preAttemptHeadSha = stdout.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: failed to capture pre-attempt HEAD (${msg}) — verification-fix finalizer will fall back to amend`);
    }

    try {
      // Try the merge with appropriate strategy for this attempt
      const success = await executeMergeAttempt({
        store,
        rootDir,
        taskId,
        branch,
        commitLog,
        diffStat,
        aiSummary: aiMergeSummary,
        aiBody: aiMergeBody,
        aiSubject: aiMergeSubject,
        includeTaskId,
        sourceIssueRef,
        smartConflictResolution,
        mergeConflictStrategy,
        attemptNum,
        options,
        result,
        settings,
        mergeTargetBranch: mergeTarget.branch,
        testCommand: effectiveTestCommand,
        buildCommand: effectiveBuildCommand,
        testSource: effectiveTestSource,
        buildSource: effectiveBuildSource,
        preMergeRebaseFallthrough,
        attempt3BranchWinsFiles: preferBranchOnOverlapFiles,
        preAttemptHeadSha,
        auditor: audit,
      }, aiTracker);

      if (success) {
        result.attemptsMade = attemptNum;
        result.resolutionStrategy = getResolutionStrategy(attemptNum, smartConflictResolution, mergeConflictStrategy);
        if (attemptNum === 3 && mergeConflictStrategy === "smart-prefer-main" && preferBranchOnOverlapFiles.size > 0) {
          result.resolutionMethod = "mixed";
        } else {
          result.resolutionMethod = getResolutionMethod(result.resolutionStrategy, result.autoResolvedCount, aiTracker.aiWasInvoked);
        }
        result.merged = true;
        return true;
      }

      // If not successful and we have more attempts, clean up and try again
      if (attemptNum < 3) {
        mergerLog.log(`${taskId}: attempt ${attemptNum} failed, cleaning up for retry...`);
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
          // Audit trail: record git reset for merge cleanup (FN-1404)
          await audit.git({ type: "reset:hard", target: branch, metadata: { purpose: "merge-cleanup", attempt: attemptNum } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          mergerLog.warn(`${taskId}: git reset --merge cleanup failed (merge-cleanup, attempt ${attemptNum}): ${msg}`);
        }
      }

      return false;
    } catch (error: any) {
      if (error instanceof Error && error.name === "MergeAbortedError") {
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
        } catch {
          // best-effort abort cleanup
        }
        throw error;
      }

      // Out-of-scope verification failure: the failing tests are in files that
      // this branch never touched. Retrying will not help. Mark the task failed
      // immediately with a clear message so it does not enter limbo recovery.
      if (error instanceof OutOfScopeVerificationError || error?.name === "OutOfScopeVerificationError") {
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
        } catch {
          // best-effort cleanup
        }
        const outOfScopeMsg =
          `Merge verification failed in files outside branch scope — likely pre-existing flake on ${mergeTarget.branch}. ` +
          `Fix the base-branch test breakage separately and retry.`;
        mergerLog.error(`${taskId}: ${outOfScopeMsg}`);
        await store.updateTask(taskId, {
          status: "failed",
          error: outOfScopeMsg,
        });
        await store.logEntry(taskId, outOfScopeMsg, "OutOfScopeVerificationError");
        // Re-throw so the outer merge runner does not attempt further retries.
        throw error;
      }

      if (
        error instanceof DiffVolumeRegressionError
        || error?.name === "DiffVolumeRegressionError"
        || error?.name === "FileScopeViolationError"
      ) {
        throw error;
      }

      // Check if it's a deterministic verification failure (testCommand or buildCommand failed)
      // Try in-merge fix attempts before propagating
      if (error.name === "VerificationError") {
        const verificationErr = error as VerificationError;
        const maxFixRetries = Math.min(settings.verificationFixRetries ?? 3, 3); // U3: aligned to schema default (3); was ?? 2 (dead today, DEFAULT_PROJECT_SETTINGS re-injects 3)

        if (maxFixRetries > 0 && (verificationErr.verificationResult.testResult || verificationErr.verificationResult.buildResult)) {
          mergerLog.log(`${taskId}: deterministic verification failed — attempting in-merge fix (up to ${maxFixRetries} attempts)`);
          await store.logEntry(taskId, `Verification failed during merge — attempting in-merge fix (up to ${maxFixRetries} attempts)`);
          await store.appendAgentLog(
            taskId,
            `Verification failed — attempting in-merge fix (up to ${maxFixRetries} attempts)`,
            "status",
            undefined,
            "merger",
          );

          // Extract failure context from the VerificationError
          const failedResult = verificationErr.verificationResult.testResult?.success === false
            ? verificationErr.verificationResult.testResult
            : verificationErr.verificationResult.buildResult;
          const failedType = verificationErr.verificationResult.testResult?.success === false
            ? "test" as const
            : "build" as const;

          if (failedResult) {
            let fixSuccess = false;
            // Accumulate all paths the fix agent touches across retries so
            // commitOrAmendMergeWithFixes can build a precise allowlist.
            const verificationFixModifiedFiles = new Set<string>();
            for (let fixAttempt = 1; fixAttempt <= maxFixRetries; fixAttempt++) {
              const fixAttemptStartedAt = Date.now();
              mergerLog.log(`${taskId}: in-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
              await store.logEntry(taskId, `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
              await store.appendAgentLog(
                taskId,
                `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`,
                "status",
                undefined,
                "merger",
              );

              throwIfAborted(options.signal, taskId);
              fixSuccess = await attemptInMergeVerificationFix(
                store, rootDir, taskId,
                {
                  command: failedResult.command,
                  exitCode: failedResult.exitCode,
                  output: summarizeVerificationOutput(failedResult.stderr || failedResult.stdout, failedType),
                  type: failedType,
                },
                settings,
                options,
                { runId: mergeRunId, agentId: engineRunContext.agentId },
                fixAttempt,
                effectiveTestCommand,
                effectiveBuildCommand,
                effectiveTestSource,
                effectiveBuildSource,
                verificationFixModifiedFiles,
                mergeTarget.branch,
                branch,
              );

              const fixAttemptDurationMs = Date.now() - fixAttemptStartedAt;
              if (fixSuccess) {
                mergerLog.log(`${taskId}: in-merge verification fix succeeded on attempt ${fixAttempt} in ${fixAttemptDurationMs}ms`);
                await store.logEntry(taskId, `[timing] In-merge verification fix succeeded on attempt ${fixAttempt} in ${fixAttemptDurationMs}ms — verification now passes`);
                await store.appendAgentLog(
                  taskId,
                  `In-merge verification fix succeeded on attempt ${fixAttempt}`,
                  "tool_result",
                  `${fixAttemptDurationMs}ms — verification now passes`,
                  "merger",
                );
                break;
              }

              mergerLog.warn(`${taskId}: in-merge verification fix attempt ${fixAttempt} — verification still fails (${fixAttemptDurationMs}ms)`);
              await store.logEntry(taskId, `[timing] In-merge verification fix attempt ${fixAttempt} — verification still fails (${fixAttemptDurationMs}ms)`);
              await store.appendAgentLog(
                taskId,
                `In-merge verification fix attempt ${fixAttempt} failed`,
                "tool_error",
                `${fixAttemptDurationMs}ms — verification still fails`,
                "merger",
              );
            }

            if (fixSuccess) {
              // Finalize the merge commit (fresh commit if HEAD didn't move,
              // amend if AI agent already committed). Always rewrites the
              // message deterministically from branch step commits.
              const authorArg = getCommitAuthorArg(settings);
              const { stdout: finalizeHeadOut } = await execAsync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf-8" });
              mergerLog.log(`${taskId}: in-merge fix entering with preAttemptHeadSha=${preAttemptHeadSha}, currentHead=${finalizeHeadOut.trim()}`);
              const finalized = await commitOrAmendMergeWithFixes(
                rootDir,
                taskId,
                branch,
                commitLog,
                includeTaskId,
                preAttemptHeadSha,
                authorArg,
                diffStat,
                settings,
                options.signal,
                aiMergeSummary,
                aiMergeBody,
                aiMergeSubject,
                verificationFixModifiedFiles,
                store,
                audit,
              );
              if (finalized.ok && finalized.reason === "branch-already-merged-on-main") {
                mergeWasEmpty = true;
                recoveredMergeSha = finalized.mergeSha;
                mergerLog.log(`${taskId}: verification-fix finalize recovered as already landed on main via=${finalized.strategy} sha=${finalized.mergeSha?.slice(0, 8)}`);
                await store.appendAgentLog(
                  taskId,
                  "Verification fix finalize: task already landed on main — recovered",
                  "tool_result",
                  `via=${finalized.strategy} sha=${finalized.mergeSha?.slice(0, 8)}`,
                  "merger",
                );
                await store.logEntry(taskId, `Auto-recovered: verification fix produced no content but task already landed on main at ${finalized.mergeSha?.slice(0, 8)} via ${finalized.strategy}`);
                return true;
              }
              if (!finalized.ok) {
                if (finalized.reason === "fix-produced-no-content" && recoveredMergeSha) {
                  mergerLog.warn(`${taskId}: finalize returned fix-produced-no-content after recovered merge SHA ${recoveredMergeSha.slice(0, 8)}; treating as recovered`);
                  mergeWasEmpty = true;
                  return true;
                }
                // Phantom-merge guard: refused to fabricate a commit. Reset
                // any leftover squash state and propagate failure.
                const { stdout: currentHeadOut } = await execAsync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf-8" });
                const { stdout: branchTipOut } = await execAsync(`git rev-parse ${branch}`, { cwd: rootDir, encoding: "utf-8" });
                resetMergeWithWarn(rootDir, taskId, "verification-fix finalize");
                const classification = finalized.reason === "fix-produced-no-content"
                  ? "fix produced no content"
                  : finalized.reason === "branch-ref-ahead-reset"
                    ? "branch-ref ahead of integration target (reset for retry)"
                    : "unknown phantom";
                const originalErrorSuffix = finalized.originalError ? ` originalError="${finalized.originalError}";` : "";
                const authoritySuffix = finalized.branchAuthority ? ` branchAuthority=${finalized.branchAuthority};` : "";
                throw new Error(
                  `${taskId}: verification fix finalize failed (${classification}); preAttemptHeadSha=${preAttemptHeadSha}; currentHead=${currentHeadOut.trim()}; branch=${branch}; branchTip=${branchTipOut.trim()};${originalErrorSuffix}${authoritySuffix}`,
                );
              }
              return true; // Merge succeeds
            }
          }
        }

        // Fix attempts exhausted or disabled — fall back to existing behavior
        mergerLog.error(`${taskId}: deterministic verification failed — aborting merge (in-merge fix exhausted or disabled)`);
        resetMergeWithWarn(rootDir, taskId, "deterministic-verification rollback");
        throw error;
      }

      // Check if it's a build verification failure
      if (error.message?.includes("Build verification failed")) {
        const maxFixRetries = Math.min(settings.verificationFixRetries ?? 3, 3); // U3: aligned to schema default (3); was ?? 2 (dead today, DEFAULT_PROJECT_SETTINGS re-injects 3)

        // Try in-merge fix before falling back to build retry
        if (maxFixRetries > 0 && (effectiveTestCommand || effectiveBuildCommand)) {
          mergerLog.log(`${taskId}: build verification failed — attempting in-merge fix`);
          await store.logEntry(taskId, `Build verification failed during merge — attempting in-merge fix`);
          await store.appendAgentLog(
            taskId,
            "Build verification failed — attempting in-merge fix",
            "status",
            undefined,
            "merger",
          );

          const fixCommand = effectiveBuildCommand || effectiveTestCommand!;
          const fixType = effectiveBuildCommand ? "build" as const : "test" as const;

          let fixSuccess = false;
          // Accumulate all paths the fix agent touches across retries so
          // commitOrAmendMergeWithFixes can build a precise allowlist.
          const buildFixModifiedFiles = new Set<string>();
          for (let fixAttempt = 1; fixAttempt <= maxFixRetries; fixAttempt++) {
            const fixAttemptStartedAt = Date.now();
            mergerLog.log(`${taskId}: in-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
            await store.logEntry(taskId, `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`);
            await store.appendAgentLog(
              taskId,
              `In-merge verification fix attempt ${fixAttempt}/${maxFixRetries}`,
              "status",
              undefined,
              "merger",
            );

            throwIfAborted(options.signal, taskId);
            fixSuccess = await attemptInMergeVerificationFix(
              store, rootDir, taskId,
              {
                command: fixCommand,
                exitCode: 1,
                output: error.message || "Build verification failed",
                type: fixType,
              },
              settings,
              options,
              { runId: mergeRunId, agentId: engineRunContext.agentId },
              fixAttempt,
              effectiveTestCommand,
              effectiveBuildCommand,
              effectiveTestSource,
              effectiveBuildSource,
              buildFixModifiedFiles,
              mergeTarget.branch,
              branch,
            );

            const fixAttemptDurationMs = Date.now() - fixAttemptStartedAt;
            if (fixSuccess) {
              mergerLog.log(`${taskId}: in-merge verification fix succeeded on attempt ${fixAttempt} in ${fixAttemptDurationMs}ms`);
              await store.logEntry(taskId, `[timing] In-merge verification fix succeeded on attempt ${fixAttempt} in ${fixAttemptDurationMs}ms`);
              await store.appendAgentLog(
                taskId,
                `In-merge verification fix succeeded on attempt ${fixAttempt}`,
                "tool_result",
                `${fixAttemptDurationMs}ms`,
                "merger",
              );
              break;
            }
            await store.logEntry(taskId, `[timing] In-merge verification fix attempt ${fixAttempt} — verification still fails (${fixAttemptDurationMs}ms)`);
            await store.appendAgentLog(
              taskId,
              `In-merge verification fix attempt ${fixAttempt} failed`,
              "tool_error",
              `${fixAttemptDurationMs}ms — verification still fails`,
              "merger",
            );
          }

          if (fixSuccess) {
            const authorArg = getCommitAuthorArg(settings);
            const { stdout: finalizeHeadOut } = await execAsync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf-8" });
            mergerLog.log(`${taskId}: in-merge fix entering with preAttemptHeadSha=${preAttemptHeadSha}, currentHead=${finalizeHeadOut.trim()}`);
            const finalized = await commitOrAmendMergeWithFixes(
              rootDir,
              taskId,
              branch,
              commitLog,
              includeTaskId,
              preAttemptHeadSha,
              authorArg,
              diffStat,
              settings,
              options.signal,
              aiMergeSummary,
              aiMergeBody,
              aiMergeSubject,
              buildFixModifiedFiles,
              store,
              audit,
            );
            if (finalized.ok && finalized.reason === "branch-already-merged-on-main") {
              mergeWasEmpty = true;
              recoveredMergeSha = finalized.mergeSha;
              mergerLog.log(`${taskId}: build-fix finalize recovered as already landed on main via=${finalized.strategy} sha=${finalized.mergeSha?.slice(0, 8)}`);
              await store.appendAgentLog(
                taskId,
                "Verification fix finalize: task already landed on main — recovered",
                "tool_result",
                `via=${finalized.strategy} sha=${finalized.mergeSha?.slice(0, 8)}`,
                "merger",
              );
              await store.logEntry(taskId, `Auto-recovered: verification fix produced no content but task already landed on main at ${finalized.mergeSha?.slice(0, 8)} via ${finalized.strategy}`);
              return true;
            }
            if (!finalized.ok) {
              if (finalized.reason === "fix-produced-no-content" && recoveredMergeSha) {
                mergerLog.warn(`${taskId}: build finalize returned fix-produced-no-content after recovered merge SHA ${recoveredMergeSha.slice(0, 8)}; treating as recovered`);
                mergeWasEmpty = true;
                return true;
              }
              // Phantom-merge guard: the verification fix passed but no
              // commit could be produced (no staged content + HEAD never
              // moved). Reset and propagate failure rather than silently
              // mutating a previous task's commit.
              const { stdout: currentHeadOut } = await execAsync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf-8" });
              const { stdout: branchTipOut } = await execAsync(`git rev-parse ${branch}`, { cwd: rootDir, encoding: "utf-8" });
              resetMergeWithWarn(rootDir, taskId, "build-verification fix finalize");
              const classification = finalized.reason === "fix-produced-no-content"
                ? "fix produced no content"
                : finalized.reason === "branch-ref-ahead-reset"
                  ? "branch-ref ahead of integration target (reset for retry)"
                  : "unknown phantom";
              const originalErrorSuffix = finalized.originalError ? ` originalError="${finalized.originalError}";` : "";
              const authoritySuffix = finalized.branchAuthority ? ` branchAuthority=${finalized.branchAuthority};` : "";
              throw new Error(
                `${taskId}: build verification fix finalize failed (${classification}); preAttemptHeadSha=${preAttemptHeadSha}; currentHead=${currentHeadOut.trim()}; branch=${branch}; branchTip=${branchTipOut.trim()};${originalErrorSuffix}${authoritySuffix}`,
              );
            }
            return true; // Merge succeeds
          }
        }

        // Fall through to existing buildRetryCount logic
        const buildRetryCount = settings.buildRetryCount ?? 0;
        if (buildRetryCount > 0 && !result._buildRetried) {
          // Allow one build retry — reset merge state and re-attempt same strategy
          mergerLog.log(`${taskId}: build failed, retrying (${buildRetryCount} retry allowed)...`);
          await store.logEntry(taskId, "Build failed — retrying merge attempt");
          result._buildRetried = true;
          try {
            execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
            // Audit trail: record git reset for build retry (FN-1404)
            await audit.git({ type: "reset:hard", target: branch, metadata: { purpose: "build-retry" } });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            mergerLog.warn(`${taskId}: git reset --merge cleanup failed during build-verification rollback (build-retry): ${msg}`);
          }
          return false; // Retry
        }
        // No fix path took effect and no build retry — reset the squash state
        // we deliberately preserved at the build-failure throw site so it
        // doesn't leak into the next attempt or the caller.
        resetMergeWithWarn(rootDir, taskId, "build-verification rollback (no retries left)");
        throw error; // No retries left — fatal
      }

      // Non-conflict squash failure: don't retry — the underlying cause
      // (broken hook, IO error, locked repo) won't fix itself by retrying.
      if (error.name === "MergeNonConflictError") {
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
        } catch { /* best-effort */ }
        throw error;
      }

      // Clean up on error before potentially rethrowing or retrying
      if (attemptNum < 3 && smartConflictResolution) {
        mergerLog.log(`${taskId}: attempt ${attemptNum} error, cleaning up for retry...`);
        try {
          execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
          // Audit trail: record git reset for retry (FN-1404)
          await audit.git({ type: "reset:hard", target: branch, metadata: { purpose: "merge-retry", attempt: attemptNum } });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          mergerLog.warn(`${taskId}: git reset --merge cleanup failed (merge-retry, attempt ${attemptNum}): ${msg}`);
        }
        return false; // Allow retry
      }
      throw error; // Last attempt or auto-resolve disabled - propagate error
    }
  };

  // Track AI agent invocation for resolutionMethod calculation
  const aiTracker: AiInvocationTracker = { aiWasInvoked: false };
  let rebaseMergeBaseSha: string | undefined;
  let verificationPassed = false;

  // Execute attempts with escalation
  let merged = false;

  if (selectedPostMergeAuditStrategy === "rebase") {
    const rebaseResult = await applyBranchCommitsPreservingHistory({
      rootDir,
      baseRef: diffBaseRef || mergeTarget.branch,
      branch,
      task,
      taskId,
      store,
      mergeConflictStrategy,
      smartConflictResolution,
      result,
      testCommand: effectiveTestCommand,
      buildCommand: effectiveBuildCommand,
      testSource: effectiveTestSource,
      buildSource: effectiveBuildSource,
      signal: options.signal,
    });
    rebaseMergeBaseSha = rebaseResult.baseSha;
    if (rebaseResult.fullySubsumedByMain) {
      mergeWasEmpty = true;
    }
    verificationPassed = Boolean(effectiveTestCommand || effectiveBuildCommand);
    merged = true;
  } else {
    // Attempt 1: Standard AI merge
    merged = await mergeAttempt(1);

    // Attempt 2: Auto-resolve lock/generated files, then AI (if enabled).
    // Skipped for "abort" — that strategy gives the user one AI shot, no more.
    if (!merged && smartConflictResolution && mergeConflictStrategy !== "abort") {
      merged = await mergeAttempt(2);
    }

    // Attempt 3: -X theirs (smart-prefer-branch) or -X ours (smart-prefer-main) fallback.
    // Skipped for "ai-only" (no silent side-pick) and "abort" (one shot only).
    //
    // Also skipped when `preMergeRebaseFallthrough` is set: under prefer-main
    // the whole purpose of refusing -X ours after a failed rebase is to
    // prevent silent re-introduction of main's deletions. Layers 1+2 couldn't
    // unblock the rebase, so the worktree is still in a state where -X ours
    // would re-introduce branch-only content. Trust only AI Attempts 1+2 here
    // — their output is gated by deterministic verification (test + build),
    // which is what enforces the prefer-main safety contract.
    if (
      !merged
      && smartConflictResolution
      && mergeConflictStrategy !== "ai-only"
      && mergeConflictStrategy !== "abort"
      && !preMergeRebaseFallthrough
    ) {
      merged = await mergeAttempt(3);
    } else if (!merged && preMergeRebaseFallthrough) {
      await store.logEntry(
        taskId,
        `Attempt 3 (-X ours fallback) suppressed: pre-merge rebase recovery layers 1+2 failed under smart-prefer-main, so the unsafe ours-side fallback is skipped to honor the strategy's safety contract. Verification-gated AI Attempts 1+2 already exhausted; merge cannot complete safely without manual intervention.`,
        "PreMergeRebaseFallthrough",
      );
    }

    // Bubble the empty-merge flag up to the metadata block.
    if (aiTracker.mergeWasEmpty) {
      mergeWasEmpty = true;
    }
  }

  // If all attempts failed
  if (!merged) {
    // Final cleanup
    try {
      execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: git reset --merge cleanup failed: ${errorMessage}`);
    }
    if (mergeConflictStrategy === "abort") {
      result.resolutionStrategy = "abort";
      throw new Error(`Merge conflict for ${taskId}: aborted per mergeConflictStrategy="abort" — manual resolution required`);
    }
    throw new Error(`AI merge failed for ${taskId}: all 3 attempts exhausted`);
  }

  // 5b. Collect merge details and store on task
  try {
    const commitSha = execSyncText("git rev-parse HEAD", {
      cwd: rootDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim() || undefined;

    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;
    let landedFiles: string[] | undefined;

    try {
      if (!rebaseMergeBaseSha) {
        const { stdout: statsOutput } = await execAsync("git show --shortstat --format= HEAD", {
          cwd: rootDir,
          encoding: "utf-8",
        });
        const parsed = parseShortstatSummary(statsOutput);
        filesChanged = parsed.filesChanged;
        insertions = parsed.insertions;
        deletions = parsed.deletions;
      }
    } catch { /* non-fatal */ }

    // Guard 1: if the squash collapsed to an empty commit, recording its SHA
    // misleads every consumer (TaskChangesTab shows "no changes" even though
    // modifiedFiles is non-empty). Real cause: the branch contained commits
    // already on main (duplicate cherry-picks), and conflict resolution
    // dropped them. The actual landing typically happens later via PR merge
    // on a different SHA — let recoverInterruptedMergingTasks /
    // findLandedTaskCommit populate the right SHA when that lands. Until
    // then, store mergeDetails without commitSha so the UI falls back to
    // task.modifiedFiles instead of a broken diff.
    const isEmptyCommit = filesChanged === 0;
    // Guard 2: the empty-squash success paths in mergeAttempt /
    // attemptWithSideStrategy return true without committing when nothing
    // was staged. The recorded HEAD then has nothing to do with this task.
    let recordedSha = (isEmptyCommit || mergeWasEmpty) ? undefined : commitSha;
    if (recoveredMergeSha) {
      recordedSha = recoveredMergeSha;
    }

    const auditSha = recordedSha;
    const postMergeAuditMode = normalizePostMergeAuditMode(settings.postMergeAuditMode);
    if (
      auditSha
      && postMergeAuditMode !== "off"
      && shouldRunPostMergeAudit(selectedPostMergeAuditStrategy, result, mergeWasEmpty, isEmptyCommit, auditSha)
    ) {
      const auditInvocation = await resolvePostMergeAuditInvocation({
        rootDir,
        strategy: selectedPostMergeAuditStrategy,
        auditSha,
        rebaseMergeBaseSha,
        diffBaseRef,
        mergeTargetBranch: mergeTarget.branch,
        taskBaseCommitSha: task.baseCommitSha,
        taskId,
        store,
        mergerLog,
      });
      const auditFindings = await auditSquashMerge(auditInvocation);
      if (!auditFindings.clean) {
        // FN-4333/FN-4344: rebase overlap-only findings can be auto-cleared
        // when deterministic verification already proved the merged tree,
        // even if HEAD drifts between verification and this audit read.
        const verificationCandidateRefs = [auditSha, task.branch].filter((ref): ref is string => Boolean(ref));
        for (const candidateRef of verificationCandidateRefs) {
          try {
            const { stdout: treeOut } = await execAsync(`git rev-parse ${quoteArg(candidateRef)}^{tree}`, {
              cwd: rootDir,
              encoding: "utf-8",
            });
            const treeSha = treeOut.trim();
            if (!treeSha) continue;
            const cacheHit = store.getVerificationCacheHit(treeSha, effectiveTestCommand ?? "", effectiveBuildCommand ?? "");
            if (cacheHit) {
              verificationPassed = true;
              break;
            }
          } catch (err) {
            mergerLog.warn(`${taskId}: could not resolve post-merge audit verification tree for ref ${candidateRef}: ${String(err)}`);
          }
        }

        await handleDirtyPostMergeAuditOutcome({
          taskId,
          auditSha,
          mode: postMergeAuditMode,
          strategy: selectedPostMergeAuditStrategy,
          findings: auditFindings,
          verificationPassed,
          audit,
          store,
          mergerLog,
        });
      } else {
        await store.appendAgentLog(
          taskId,
          selectedPostMergeAuditStrategy === "rebase" ? "post-rebase range audit clean" : "post-squash audit clean",
          "status",
          undefined,
          "merger",
        );
      }
    } else if (auditSha && postMergeAuditMode === "off") {
      await store.appendAgentLog(taskId, "post-merge audit skipped (mode=off)", "status", undefined, "merger");
      mergerLog.log(`${taskId}: post-merge audit skipped (mode=off)`);
    }
    if (isEmptyCommit) {
      mergerLog.warn(
        `${taskId}: local squash produced an empty commit (${commitSha?.slice(0, 8)}) — branch likely contained dupes of main. Skipping commitSha; recovery will backfill when real commit lands.`,
      );
    } else if (mergeWasEmpty && !recoveredMergeSha) {
      mergerLog.warn(
        `${taskId}: merge succeeded without committing (branch already on main). Skipping commitSha; nothing new landed locally.`,
      );
    }

    // When the merge was empty (no commit made), the captured stats describe
    // pre-merge HEAD's commit, not anything this task did. Clear them so
    // consumers don't display unrelated numbers next to "no commit landed".

    let noOpVerifiedShortCircuit: boolean | undefined;
    let landedFilesAttributionRestricted: boolean | undefined;
    let landedFilesCaptureFallback: MergeDetails["landedFilesCaptureFallback"];

    if (!isEmptyCommit && !mergeWasEmpty && recordedSha) {
      try {
        if (rebaseMergeBaseSha) {
          const capture = await captureRebaseLandedFilesForTask({
            rootDir,
            rebaseMergeBaseSha,
            recordedSha,
            taskId,
            sourceBranchRef: branch,
            onAttributionFailure: async (message) => {
              mergerLog.warn(`${taskId}: landed-files attribution failed (Error), falling back to full-range capture (${message})`);
              await store.appendAgentLog(
                taskId,
                `merger: landed-files attribution failed, falling back to full-range capture (${message})`,
                "status",
                undefined,
                "merger",
              );
            },
            onNoOpGuardSkipped: async (reason) => {
              mergerLog.warn(`${taskId}: no-op fast-path guard skipped — source branch ref unavailable`);
              await (audit as any).database({
                type: "merge:no-op-attribution-mismatch-skipped",
                target: taskId,
                metadata: { reason },
              });
            },
          });
          landedFiles = capture.landedFiles;
          filesChanged = capture.filesChanged;
          insertions = capture.insertions;
          deletions = capture.deletions;
          noOpVerifiedShortCircuit = capture.noOpVerifiedShortCircuit;
          landedFilesAttributionRestricted = capture.landedFilesAttributionRestricted;
          landedFilesCaptureFallback = capture.landedFilesCaptureFallback;
          if (capture.noOpVerifiedShortCircuit) {
            mergerLog.log(`${taskId}: rebase-strategy landed-files capture: zero own commits — verified-short-circuit`);
          }
        } else {
          const { stdout: landedFilesOutput } = await execAsync(`git show --name-only --format= ${quoteArg(recordedSha)}`, {
            cwd: rootDir,
            encoding: "utf-8",
            maxBuffer: 2 * 1024 * 1024,
          });
          const parsedLandedFiles = landedFilesOutput
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          if (parsedLandedFiles.length > 0) {
            landedFiles = Array.from(new Set(parsedLandedFiles));
          }
        }
      } catch (captureError) {
        if (captureError instanceof SilentNoOpAttributionMismatchError) {
          mergerLog.error(
            `[merger] ${taskId}: refused no-op fast-path — branch tip carries ${captureError.sourceBranchOwnCommitCount} attributable own commits not present in rebased HEAD`,
          );
          await (audit as any).database({
            type: "merge:no-op-attribution-mismatch",
            target: taskId,
            metadata: {
              recordedSha: captureError.recordedSha,
              rebaseMergeBaseSha: captureError.rebaseMergeBaseSha,
              sourceBranchRef: captureError.sourceBranchRef,
              sourceBranchOwnCommitCount: captureError.sourceBranchOwnCommitCount,
              sourceBranchOwnCommitShas: captureError.sourceBranchOwnCommitShas,
            },
          });
          await store.updateTask(taskId, {
            status: "failed",
            error: captureError.message,
          });
          await store.moveTask(taskId, "in-review", { preserveProgress: true, moveSource: "engine" } as any);
          throw captureError;
        }
        // non-fatal
      }
    }

    const recordedFilesChanged = mergeWasEmpty ? 0 : filesChanged;
    const recordedInsertions = mergeWasEmpty ? 0 : insertions;
    const recordedDeletions = mergeWasEmpty ? 0 : deletions;

    // FN-5627: TOCTOU fix. In reuseTaskWorktreeMerge mode, the integration
    // branch ref is advanced via `git update-ref` LATER in this function
    // (see "5c. Advance integration branch ref after squash" below). If we
    // persist `mergeConfirmed: true` here and the ref-advance then fails for
    // any reason (lock contention, hook rejection, misclassified non-CAS
    // errors via merger-ref-update-advance.ts), the task row becomes
    // poisoned: the project-engine fast-path would silently promote
    // in-review → done on the next tick, classifying never-landed work as
    // complete. Defer `mergeConfirmed` to the post-ref-advance promotion
    // block below for the reuse path. Other paths (legacy in-place merge,
    // verified no-op fast-paths, owned-commit recovery) advance the ref
    // BEFORE this point and can safely set the flag here.
    const mergeConfirmedAtThisPoint = !reuseTaskWorktreeMerge;
    const mergeDetails: MergeDetails = {
      commitSha: recordedSha,
      rebaseBaseSha: !mergeWasEmpty && rebaseMergeBaseSha ? rebaseMergeBaseSha : undefined,
      landedFiles,
      filesChanged: recordedFilesChanged,
      insertions: recordedInsertions,
      deletions: recordedDeletions,
      noOpVerifiedShortCircuit,
      landedFilesAttributionRestricted,
      landedFilesCaptureFallback,
      // Keep mergeDetails headline-only for dashboard cards; rich bullet body
      // is used in the actual git commit message composition path.
      mergeCommitMessage: aiMergeSummary || commitLog,
      mergedAt: new Date().toISOString(),
      mergeConfirmed: mergeConfirmedAtThisPoint,
      mergeTargetBranch: mergeTarget.branch,
      mergeTargetSource: mergeTarget.source,
      resolutionStrategy: result.resolutionStrategy,
      resolutionMethod: result.resolutionMethod,
      attemptsMade: result.attemptsMade,
      autoResolvedCount: result.autoResolvedCount,
    };

    await store.updateTask(taskId, {
      mergeDetails,
      modifiedFiles: noOpVerifiedShortCircuit ? undefined : landedFiles && landedFiles.length > 0 ? landedFiles : undefined,
    });
    if (recordedSha) {
      const currentTask = await store.getTask(taskId);
      if (currentTask?.lineageId) {
        await store.upsertTaskCommitAssociation({
          taskLineageId: currentTask.lineageId,
          taskIdSnapshot: currentTask.id,
          commitSha: recordedSha,
          commitSubject: aiMergeSummary || commitLog,
          authoredAt: mergeDetails.mergedAt ?? new Date().toISOString(),
          matchedBy: "canonical-lineage-trailer",
          confidence: "canonical",
          additions: mergeDetails.insertions,
          deletions: mergeDetails.deletions,
        });
      }
    }
    mergerLog.log(`${taskId}: merge details stored (commitSha: ${recordedSha?.slice(0, 8) ?? "<deferred>"})`);

    // Surface the high-level outcome on the agent-log timeline so users can
    // see the merge's strategy, attempt count, and final commit at a glance.
    const summaryParts: string[] = [
      `Merge completed via ${result.resolutionStrategy ?? "unknown"} (attempt ${result.attemptsMade ?? "?"}/3)`,
    ];
    if (recordedSha) {
      summaryParts.push(`commit ${recordedSha.slice(0, 8)}`);
    } else if (mergeWasEmpty) {
      summaryParts.push(`no commit landed (branch already on ${mergeTarget.branch})`);
    } else if (isEmptyCommit) {
      summaryParts.push("squash collapsed to empty (sha deferred)");
    }
    if (!mergeWasEmpty && filesChanged !== undefined) {
      summaryParts.push(`${filesChanged} file${filesChanged === 1 ? "" : "s"} changed (+${insertions ?? 0}/-${deletions ?? 0})`);
    }
    await store.appendAgentLog(
      taskId,
      summaryParts.join(" · "),
      "status",
      undefined,
      "merger",
    );
  } catch (err: any) {
    if (err instanceof SquashAuditError || err?.name === "SquashAuditError") {
      throw err;
    }
    if (err instanceof SilentNoOpAttributionMismatchError || err?.name === "SilentNoOpAttributionMismatchError") {
      throw err;
    }
    mergerLog.warn(`${taskId}: failed to collect/store merge details: ${err.message}`);
  }

  // 5c. Advance integration branch ref after squash
  // FN-5350 invariant: the integration branch is assumed checked out in
  // projectRootDir with possibly dirty + untracked files. Advance refs/heads/<integration>
  // via `git update-ref` only — NEVER `git checkout` / `git merge` / `git rebase`
  // in projectRootDir. Compare-and-swap (expectedCurrentSha → newSha) preserves
  // the FN concurrent-advance rule: if integration moved, we refuse and let
  // upstream re-rebase machinery (FN-4500 / FN-5083 rebind / standard re-execution) recover.
  if (reuseTaskWorktreeMerge) {
    try {
      const worktreeHeadSha = execSyncText("git rev-parse HEAD", {
        cwd: rootDir,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
      if (worktreeHeadSha) {
        const integrationBranch = mergeTarget.branch || await resolveIntegrationBranch(projectRootDir, settings);
        const expectedCurrentSha = execSyncText(`git rev-parse --verify ${quoteArg(`refs/heads/${integrationBranch}`)}`, {
          cwd: rootDir,
          stdio: "pipe",
          encoding: "utf-8",
        }).trim();
        const advanceResult = await advanceIntegrationBranchRef({
          rootDir,
          projectRootDir,
          integrationBranch,
          newSha: worktreeHeadSha,
          expectedCurrentSha,
          taskId,
          audit,
        });
        if (!advanceResult.advanced) {
          // `non-fast-forward-advance` has the same root cause as
          // `concurrent-advance` — integration moved during the merge window,
          // here detected by ancestry rather than CAS old-value mismatch —
          // so route it through the same rebind/retry path (FN-5576).
          if (
            advanceResult.reason === "concurrent-advance"
            || advanceResult.reason === "non-fast-forward-advance"
          ) {
            throw new IntegrationBranchConcurrentAdvanceError({
              integrationBranch,
              expectedCurrentSha,
              observedCurrentSha: advanceResult.observedCurrentSha,
              newSha: worktreeHeadSha,
              taskId,
            });
          }
          throw new Error(`Failed to advance ${integrationBranch} via update-ref: ${advanceResult.diagnostic}`);
        }
        mergerLog.log(
          `${taskId}: ${integrationBranch} advanced to ${worktreeHeadSha.slice(0, 8)} via update-ref; your checked-out worktree at ${projectRootDir} is now behind`,
        );

        // FN-5627: Promote `mergeConfirmed` to true ONLY after the ref-advance
        // succeeds. This closes the TOCTOU window where the optimistic write
        // above poisoned the task row when the ref-advance subsequently failed.
        try {
          const currentTask = await store.getTask(taskId).catch(() => null);
          const currentMergeDetails = currentTask?.mergeDetails;
          if (currentMergeDetails && !currentMergeDetails.mergeConfirmed) {
            await store.updateTask(taskId, {
              mergeDetails: { ...currentMergeDetails, mergeConfirmed: true },
            });
          }
        } catch (promoteErr: unknown) {
          // Non-fatal: log + continue. The ref already advanced; the worst
          // case is the next merge tick re-attempts and the work is now
          // genuinely landed so the reachability gate in project-engine
          // will succeed.
          mergerLog.warn(
            `${taskId}: failed to promote mergeConfirmed post-ref-advance: ${
              promoteErr instanceof Error ? promoteErr.message : String(promoteErr)
            }`,
          );
        }

        // Auto-sync other worktrees still on the integration branch so their
        // index + working tree catch up to the new tip. When `off`, the legacy
        // surprise behavior is preserved and the user pulls manually via the
        // Merge Advance Notice banner. Isolated in its own try-catch because
        // the merge has already landed at this point: failing the merger run
        // because a downstream worktree sync threw would leave the project in
        // a worse state than just emitting the failure as an audit event.
        const autoSyncMode = normalizeMergeAdvanceAutoSyncMode(settings.mergeAdvanceAutoSync);
        if (autoSyncMode !== "off") {
          try {
            await runMergeAdvanceAutoSync({
              store,
              audit,
              taskId,
              projectRootDir,
              integrationBranch,
              previousSha: expectedCurrentSha,
              newSha: worktreeHeadSha,
              mode: autoSyncMode,
            });
          } catch (syncErr: unknown) {
            mergerLog.warn(
              `${taskId}: mergeAdvanceAutoSync threw — continuing merge: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
            );
          }
        }
      }
    } catch (advErr: unknown) {
      const advMsg = advErr instanceof Error ? advErr.message : String(advErr);
      mergerLog.error(
        `${taskId}: failed to advance ${mergeTarget.branch} via update-ref: ${advMsg}`,
      );
      // Abort: leaving reuseTaskWorktreeMerge=true would cause the subsequent
      // push step to operate on projectRootDir where the target ref was never
      // advanced, shipping the pre-merge ref. Mark the reuse-merge as failed
      // and surface the error so the merge can be retried cleanly.
      reuseTaskWorktreeMerge = false;
      throw advErr;
    }
  }

  // 6. Delete branch
  try {
    await execAsync(`git branch -d "${branch}"`, { cwd: rootDir });
    result.branchDeleted = true;
    // Audit trail: record branch deletion (FN-1404)
    await audit.git({ type: "branch:delete", target: branch });
  } catch {
    try {
      await execAsync(`git branch -D "${branch}"`, { cwd: rootDir });
      result.branchDeleted = true;
      // Audit trail: record branch deletion (force) (FN-1404)
      await audit.git({ type: "branch:delete", target: branch, metadata: { force: true } });
    } catch { /* non-fatal */ }
  }

  if (result.branchDeleted) {
    // FN-2165 regression guard: if any other task had this branch stored as
    // its baseBranch (common when a dependent task was dispatched off a
    // conflict-suffixed branch), null it so the dependent task doesn't
    // hard-fail at worktree creation once this branch is gone.
    try {
      const cleared = await store.clearStaleExecutionStartBranchReferences([branch], taskId);
      if (cleared.length > 0) {
        mergerLog.log(`${taskId}: cleared stale baseBranch on ${cleared.length} dependent task(s): ${cleared.join(", ")}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: failed to clear stale baseBranch references: ${msg}`);
    }
  }

  // 7. Post-merge workflow steps run graph-native.
  // FNXC:WorkflowPostMerge 2026-06-26-14:00: U7c — the legacy merger post-merge execution
  // path (worktree creation + prompt/script step execution) has been REMOVED. Post-merge
  // workflow steps run exclusively as the workflow graph's own post-merge optional-group
  // node, which records into `task.workflowStepResults`. The graph is the single post-merge
  // owner; there is no longer a merger-side path to double-run or gate behind a flag.

  // 8. Clean up worktree
  throwIfAborted(options.signal, taskId);
  if (worktreePath && existsSync(worktreePath)) {
    const otherUser = await findWorktreeUser(store, worktreePath, taskId);
    if (otherUser) {
      mergerLog.log(`Worktree retained — still needed by ${otherUser}`);
      result.worktreeRemoved = false;
    } else if (options.pool && settings.recycleWorktrees) {
      if (activeSessionRegistry.isPathActive(worktreePath)) {
        mergerLog.warn(`${taskId}: skipping pooled release for active session path ${worktreePath}`);
        await audit?.git({
          type: "worktree:removal-refused-active-session",
          target: worktreePath,
          metadata: { taskId, reason: RemovalReason.MergerCleanup, kind: "merger" },
        });
        result.worktreeRemoved = false;
      } else {
        try {
          const onBranch = await execAsync("git symbolic-ref --quiet HEAD", { cwd: worktreePath, timeout: 5_000, encoding: "utf-8" })
            .then(() => true)
            .catch(() => false);
          if (onBranch) {
            await execAsync("git checkout --detach HEAD", { cwd: worktreePath, timeout: 10_000, encoding: "utf-8" });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          mergerLog.warn(`${taskId}: failed to detach pooled worktree before release: ${msg}`);
        }
        try {
          await store.updateTask(taskId, { worktree: null, branch: null });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          mergerLog.warn(`${taskId}: failed to clear worktree pointer before pool release: ${msg}`);
        }
        options.pool.release(worktreePath, taskId);
        result.worktreeRemoved = false;
      }
    } else {
      try {
        if (activeSessionRegistry.isPathActive(worktreePath)) {
          mergerLog.warn(`${taskId}: skipping worktree cleanup for active session path ${worktreePath}`);
          await audit?.git({
            type: "worktree:removal-refused-active-session",
            target: worktreePath,
            metadata: { taskId, reason: RemovalReason.MergerCleanup, kind: "merger" },
          });
        } else {
          const outcome = await removeWorktree({
            rootDir,
            worktreePath,
            settings,
            taskId,
            audit,
            reason: RemovalReason.MergerCleanup,
          });
          if ("harmless" in outcome && outcome.harmless) {
            mergerLog.warn(`${taskId}: merge worktree cleanup classified harmless for ${worktreePath}: ${outcome.message}`);
          }
          result.worktreeRemoved = outcome.removed || ("harmless" in outcome && outcome.harmless);
        }
        if (result.worktreeRemoved) {
          try {
            await store.updateTask(taskId, { worktree: null, branch: null });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            mergerLog.warn(`${taskId}: failed to clear worktree pointer after removal: ${msg}`);
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  // 8b. Push to remote if configured
  if (settings.pushAfterMerge && settings.mergeStrategy !== "pull-request") {
    try {
      throwIfAborted(options.signal, taskId);
      const pushTask = await store.getTask(taskId).catch(() => null);
      const pushAssignedAgentId = pushTask?.assignedAgentId?.trim();
      const pushAgentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
        ? options.agentStore
        : null;
      const pushAssignedAgent = pushAssignedAgentId && pushAgentStoreWithGetAgent
        ? await pushAgentStoreWithGetAgent.getAgent(pushAssignedAgentId).catch(() => null)
        : null;
      const pushRuntimeHint = extractRuntimeHint(pushAssignedAgent?.runtimeConfig);
      // In reuse-task-worktree mode, rootDir is the task worktree with a
      // detached HEAD; step 5c advanced refs/heads/<integration-branch> via
      // `git update-ref` (FN-5350). The shared ref now points at the new squash
      // commit, so pushing from projectRootDir (where the branch is checked out,
      // but the working tree may be dirty and is NOT touched by us) sends the
      // new tip to the remote.
      const pushRootDir = reuseTaskWorktreeMerge ? projectRootDir : rootDir;
      const pushResult = await pushToRemoteAfterMerge(store, pushRootDir, taskId, settings, {
        onAgentText: options.onAgentText,
        signal: options.signal,
        runtimeHint: pushRuntimeHint,
        assignedAgentRuntimeConfig: pushAssignedAgent?.runtimeConfig,
        onSession: options.onSession,
        integrationBranch: mergeTarget.branch,
      });
      if (pushResult.pushed) {
        mergerLog.log(`${taskId}: pushed merged result to remote`);
        // Push may trigger an internal pull --rebase that rewrites HEAD (see
        // pushToRemoteAfterMerge); refresh the recorded commitSha so
        // mergeDetails / recovery don't reference a now-orphaned commit.
        try {
          const postPushSha = execSync("git rev-parse HEAD", {
            cwd: pushRootDir,
            stdio: "pipe",
            encoding: "utf-8",
          }).trim() || undefined;
          if (postPushSha) {
            const existingTask = await store.getTask(taskId).catch(() => null);
            const existingDetails = existingTask?.mergeDetails;
            if (existingDetails?.commitSha && existingDetails.commitSha !== postPushSha) {
              let updatedStats = {
                filesChanged: existingDetails.filesChanged,
                insertions: existingDetails.insertions,
                deletions: existingDetails.deletions,
              };
              try {
                const { stdout: postPushStatsOutput } = await execAsync(
                  `git show --shortstat --format= ${quoteArg(postPushSha)}`,
                  { cwd: pushRootDir, encoding: "utf-8" },
                );
                const normalized = postPushStatsOutput.trim().replace(/\n/g, " ");
                const filesMatch = normalized.match(/(\d+) files? changed/);
                const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
                const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
                updatedStats = {
                  filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
                  insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
                  deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
                };
              } catch (statsErr: unknown) {
                const statsErrMessage = statsErr instanceof Error ? statsErr.message : String(statsErr);
                mergerLog.warn(`${taskId}: post-push SHA refreshed but stat recompute failed: ${statsErrMessage}`);
              }

              await store.updateTask(taskId, {
                mergeDetails: {
                  ...existingDetails,
                  commitSha: postPushSha,
                  filesChanged: updatedStats.filesChanged,
                  insertions: updatedStats.insertions,
                  deletions: updatedStats.deletions,
                },
              });
              mergerLog.log(
                `${taskId}: post-push HEAD changed from ${existingDetails.commitSha.slice(0, 8)} to ${postPushSha.slice(0, 8)} — refreshed mergeDetails.commitSha (stats: ${updatedStats.filesChanged ?? 0}f/${updatedStats.insertions ?? 0}i/${updatedStats.deletions ?? 0}d, was ${existingDetails.filesChanged ?? 0}f/${existingDetails.insertions ?? 0}i/${existingDetails.deletions ?? 0}d)`,
              );
            }
          }
        } catch (refreshErr: any) {
          mergerLog.warn(`${taskId}: failed to refresh mergeDetails after push: ${refreshErr.message}`);
        }
      } else {
        mergerLog.warn(`${taskId}: push to remote failed: ${pushResult.error}`);
        await audit.git({
          type: "push:origin",
          target: taskId,
          metadata: {
            integrationBranch: mergeTarget.branch,
            remote: settings.pushRemote || "origin",
            outcome: "failed",
            stderrPreview: pushResult.error,
          },
        }).catch(() => undefined);
        await store.logEntry(
          taskId,
          `Push to remote failed after merge — task marked done anyway; local main may diverge from origin: ${pushResult.error}`,
          "PushToRemoteFailed",
        ).catch(() => undefined);
      }
      result.pushedToRemote = pushResult.pushed;
      if (pushResult.error) {
        result.pushError = pushResult.error;
      }
    } catch (err: any) {
      mergerLog.error(`${taskId}: push to remote error: ${err.message}`);
      result.pushedToRemote = false;
      result.pushError = err.message;
      await audit.git({
        type: "push:origin",
        target: taskId,
        metadata: {
          integrationBranch: mergeTarget.branch,
          remote: settings.pushRemote || "origin",
          outcome: "failed",
          stderrPreview: err.message,
        },
      }).catch(() => undefined);
      await store.logEntry(
        taskId,
        `Push to remote threw after merge — task marked done anyway; local main may diverge from origin: ${err.message}`,
        "PushToRemoteFailed",
      ).catch(() => undefined);
    }
  }

  // 9. Move task to done
  // Audit trail: record merge completion (FN-1404)
  await audit.database({
    type: "task:move",
    target: taskId,
    metadata: {
      to: "done",
      merged: true,
      resolutionStrategy: result.resolutionStrategy,
      resolutionMethod: result.resolutionMethod,
      attemptsMade: result.attemptsMade,
    },
  });
  await recordBranchGroupMemberLanding();
  await completeTask(store, taskId, result);
  return result;

  } catch (error) {
    reuseHandoffOutcome = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (autostashHandle) {
      try {
        const settings = await store.getSettings();
        const outcome = await restoreUnrelatedRootDirChanges(
          rootDir,
          taskId,
          autostashHandle,
          { store, options, settings },
        );
        // Attach outcome to result so callers (dashboard, daemon, CLI) can
        // surface autostash status to the developer. result is undefined
        // only when the try body threw before constructing it — in that
        // case the merge already failed and the outcome warning logs are
        // the best we can do.
        if (resultForFinally) {
          resultForFinally.autostash = outcome;
        }

        const rescueRestore = outcome.status === "restored" || outcome.status === "ai-resolved"
          ? await restoreRescueAutostashes(rootDir, taskId, autostashHandle, { store })
          : { unresolvedCount: 0 };
        const keepIfLive = outcome.status === "failed"
          || outcome.status === "conflict-needs-manual"
          || rescueRestore.unresolvedCount > 0;
        await dropAutostashHandle(rootDir, taskId, autostashHandle, {
          keepIfLive,
          store,
          context: "Post-restore autostash cleanup",
        });
      } catch (err: unknown) {
        // Any throw from restore should never propagate out of the merger
        // — the merge result has already been recorded. Log and swallow.
        const msg = err instanceof Error ? err.message : String(err);
        mergerLog.warn(`${taskId}: autostash restore threw unexpectedly (${msg}) — running keep-if-live cleanup sweep`);
        await dropAutostashHandle(rootDir, taskId, autostashHandle, {
          keepIfLive: true,
          store,
          context: "Autostash restore exception cleanup",
        });
        if (resultForFinally) {
          resultForFinally.autostash = {
            status: "failed",
            stashSha: autostashHandle.sha,
            errorMessage: msg,
          };
        }
      }
    }
    // Always clear the advisory status file last, even if everything above
    // threw — a stale advisory makes the dashboard show a phantom "merge
    // running" indefinitely, which is worse than a missing one.
    clearActiveMergerStatus(activeStatusPath, taskId);
    if (reuseHandoff) {
      const handoff = reuseHandoff;
      reuseHandoff = undefined;
      const handoffOutcome = reuseHandoffOutcome === "success"
        ? resultForFinally?.error ?? "success"
        : reuseHandoffOutcome;
      await releaseReuseHandoff({
        handoff,
        outcome: handoffOutcome,
        auditEmit: (event) => emitReuseHandoffAuditEvent(event.type as any, event.metadata ?? {}, event.target ?? handoff.worktreePath),
      });
    }
  }
}

/** Best-effort `git fetch origin <currentBranch>` + fast-forward of local
 *  HEAD when origin is strictly ahead. Returns silently on any failure
 *  (no remote configured, network down, divergent local commits, etc.).
 *  Only called for the smart strategies, which want to avoid resolving a
 *  conflict against a stale local base.
 *
 *  NOTE: This is NOT FN-5350's integration-branch ref advance path. FN-5350
 *  advances refs/heads/<integration-branch> via compare-and-swap `git update-ref`.
 */
export async function tryFastForwardFromOrigin(
  rootDir: string,
  taskId: string,
  integrationBranch: string,
  integrationRemote?: string,
): Promise<void> {
  const currentBranch = integrationBranch.trim();
  const remote = integrationRemote?.trim();
  if (!currentBranch || !remote) return;

  try {
    await execAsync(`git fetch ${quoteArg(remote)} ${quoteArg(currentBranch)}`, { cwd: rootDir });
  } catch (err) {
    mergerLog.log(`${taskId}: pre-merge fetch failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Detect divergence: local must be strictly behind remote (no local-only commits).
  let behind = 0;
  let ahead = 0;
  const remoteRef = `${remote}/${currentBranch}`;
  try {
    const counts = execSyncText(`git rev-list --left-right --count ${quoteArg(`${remoteRef}...HEAD`)}`, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const [b, a] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    behind = b;
    ahead = a;
  } catch {
    return;
  }

  if (behind === 0) return; // already up to date
  if (ahead > 0) {
    mergerLog.log(`${taskId}: local ${currentBranch} has ${ahead} unpushed commit(s); skipping fast-forward`);
    return;
  }

  try {
    await execAsync(`git merge --ff-only ${quoteArg(remoteRef)}`, { cwd: rootDir });
    mergerLog.log(`${taskId}: fast-forwarded ${currentBranch} by ${behind} commit(s) from ${remote}`);
  } catch (err) {
    mergerLog.log(`${taskId}: fast-forward failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Get the resolution strategy based on attempt number and settings.
 *  `mergeConflictStrategy` controls the FALLBACK on attempt 3 (and gates the
 *  whole cascade on "abort"); attempts 1–2 always try AI then auto-resolve so
 *  trivial conflicts don't pay an unnecessary price. */
function getResolutionStrategy(
  attemptNum: 1 | 2 | 3,
  smartConflictResolution: boolean,
  mergeConflictStrategy: CanonicalMergeConflictStrategy = "smart-prefer-main",
): MergeResult["resolutionStrategy"] {
  if (!smartConflictResolution || attemptNum === 1) {
    return "ai";
  }
  if (attemptNum === 2) {
    return "auto-resolve";
  }
  // Attempt 3: fallback strategy
  switch (mergeConflictStrategy) {
    case "ai-only":
      return "ai";
    case "smart-prefer-main":
      return "ours";
    case "abort":
      return "abort";
    case "smart-prefer-branch":
    default:
      return "theirs";
  }
}

/** Map resolutionStrategy and autoResolvedCount to resolutionMethod for metrics/debugging */
function getResolutionMethod(
  strategy: MergeResult["resolutionStrategy"],
  autoResolvedCount?: number,
  aiWasUsed?: boolean,
): MergeResult["resolutionMethod"] {
  if (strategy === "ai") return "ai";
  if (strategy === "theirs") return "theirs";
  if (strategy === "ours") return "ours";
  if (strategy === "abort") return "abort";
  if (strategy === "auto-resolve") {
    // auto-resolve strategy: determine if pure auto or mixed with AI
    if (autoResolvedCount && autoResolvedCount > 0) {
      // If AI was actually invoked during auto-resolve attempt, it's mixed
      return aiWasUsed ? "mixed" : "auto";
    }
    return "auto";
  }
  return undefined;
}

interface MergeAttemptParams {
  store: TaskStore;
  rootDir: string;
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat: string;
  aiSummary?: string | null;
  aiBody?: string | null;
  aiSubject?: string | null;
  includeTaskId: boolean;
  sourceIssueRef?: string;
  smartConflictResolution: boolean;
  mergeConflictStrategy: CanonicalMergeConflictStrategy;
  attemptNum: 1 | 2 | 3;
  options: MergerOptions;
  result: MergeResult;
  settings: Settings;
  mergeTargetBranch?: string;
  testCommand?: string;
  buildCommand?: string;
  /** Source of the test command: 'explicit' from settings or 'inferred'/'inferred-scoped' from project files */
  testSource?: "explicit" | "inferred" | "inferred-scoped";
  /** Source of the build command: 'explicit' from settings or 'inferred' (future use) */
  buildSource?: "explicit" | "inferred";
  /** Set when the pre-merge rebase recovery cascade (Layers 1–2) failed and
   *  the merge proceeds under smart-prefer-main fall-through. The AI prompt
   *  uses this to inject the safety preamble; the merge cascade uses it to
   *  suppress the unsafe `-X ours` Attempt 3. Carries the original rebase
   *  failure message for diagnostic context. */
  preMergeRebaseFallthrough?: string;
  auditor?: RunAuditor;
  /** Under smart-prefer-main overlap protection, these files are restored from
   *  the task branch after the default `-X ours` squash so overlapping files
   *  keep the branch's hardening while non-overlapping files still prefer main. */
  attempt3BranchWinsFiles?: Set<string>;
  /** HEAD of the integration target immediately before this squash attempt began. */
  preAttemptHeadSha?: string;
}

/** Mutable flags carried through the merge cascade. */
interface AiInvocationTracker {
  aiWasInvoked: boolean;
  /** True when a "success" was the empty-squash path (no commit made). The
   *  merge metadata block uses this to avoid recording pre-merge HEAD as
   *  this task's commitSha. */
  mergeWasEmpty?: boolean;
}

/**
 * Execute a single merge attempt with the specified strategy.
 * Returns true if merge succeeded, false if should retry (for attempts 1-2).
 * Throws on unrecoverable errors.
 */
export async function executeMergeAttempt(
  params: MergeAttemptParams,
  aiTracker: AiInvocationTracker,
): Promise<boolean> {
  const {
    store,
    rootDir,
    taskId,
    branch,
    commitLog,
    diffStat,
    aiSummary,
    aiBody,
    aiSubject,
    includeTaskId,
    sourceIssueRef,
    smartConflictResolution,
    attemptNum,
    options,
    result,
    settings,
    testCommand,
    buildCommand,
    testSource,
    buildSource,
  } = params;

  // Attempt 3: dispatch on the configured fallback strategy.
  // Note: "ai-only" and "abort" are filtered out by the mergeAttempt cascade
  // before reaching here — only the two smart variants legitimately run attempt 3.
  if (attemptNum === 3) {
    if (params.mergeConflictStrategy === "smart-prefer-main") {
      if (params.attempt3BranchWinsFiles && params.attempt3BranchWinsFiles.size > 0) {
        return attemptWithMixedSideStrategy(
          params,
          { defaultSide: "ours", branchWinsFiles: params.attempt3BranchWinsFiles },
          aiTracker,
        );
      }
      return attemptWithSideStrategy(params, "ours", aiTracker);
    }
    return attemptWithSideStrategy(params, "theirs", aiTracker);
  }

  // Attempt 1 & 2: Standard squash merge
  let hasConflicts = false;
  try {
    // For attempt 2, try with smart auto-resolution first
    if (attemptNum === 2 && smartConflictResolution) {
      // First, do a standard merge to get conflicts
      // Note: git merge --squash exits with code 1 when conflicts exist
      // This is expected - we catch it and proceed with auto-resolution
      let mergeError: unknown;
      try {
        await execAsync(`git merge --squash "${branch}"`, {
          cwd: rootDir,
        });
        throwIfAborted(options.signal, taskId);
      } catch (error: unknown) {
        rethrowIfMergeAborted(error);
        // Capture the error so we can distinguish "exit code 1 with conflicts"
        // (expected, recoverable) from "any other failure" (hooks, IO, locks).
        mergeError = error;
      }

      // Use new API: get conflicted files and classify them
      const conflictedFiles = await getConflictedFiles(rootDir);

      // Don't paper over non-conflict failures: if the merge errored AND no
      // U files exist, the failure was something other than a merge conflict
      // (pre-commit hook, disk error, repo lock, etc.). Returning success
      // here would store merge metadata for a merge that never happened.
      // The outer mergeAttempt catch propagates this sentinel name without
      // retrying (retrying would just re-run the same broken command).
      if (mergeError && conflictedFiles.length === 0) {
        const cause = mergeError instanceof Error ? mergeError.message : String(mergeError);
        const fatal = new Error(
          `${taskId}: git merge --squash failed without producing conflicts ` +
          `(${cause}) — refusing to treat as a no-op merge.`,
        );
        fatal.name = "MergeNonConflictError";
        throw fatal;
      }
      const mergeExitedWithConflicts = mergeError !== undefined;
      if (conflictedFiles.length > 0 || mergeExitedWithConflicts) {
        const task = await store.getTask(taskId);
        const partitioned = await applyLayer3ConflictScopePartition({
          store,
          task,
          taskId,
          rootDir,
          branch,
          mergeTargetBranch: params.mergeTargetBranch ?? "main",
          conflictFiles: conflictedFiles,
          auditor: params.auditor,
        });

        // Classify each conflicted file remaining in scope.
        const classified: { file: string; type: ConflictType }[] = [];
        for (const file of partitioned.inScopeConflicts) {
          const type = await classifyConflict(file, rootDir);
          classified.push({ file, type });
        }

        const autoResolvable = classified.filter(
          (c) => c.type !== "complex",
        );
        const complex = classified.filter(
          (c) => c.type === "complex",
        );

        // Auto-resolve each file based on its classification
        if (autoResolvable.length > 0) {
          mergerLog.log(
            `${taskId}: auto-resolving ${autoResolvable.length} lock/generated/trivial file(s) before AI retry`,
          );
          for (const { file, type } of autoResolvable) {
            try {
              if (type === "lockfile-ours") {
                await resolveWithOurs(file, rootDir);
              } else if (type === "generated-theirs") {
                await resolveWithTheirs(file, rootDir);
              } else if (type === "trivial-whitespace") {
                await resolveTrivialWhitespace(file, rootDir);
              }
              result.autoResolvedCount = (result.autoResolvedCount || 0) + 1;
            } catch (error) {
              // If auto-resolution fails, treat as complex conflict
              mergerLog.warn(`${taskId}: auto-resolution failed for ${file}: ${error}`);
              complex.push({ file, type: "complex" });
            }
          }
        }

        // If only auto-resolvable conflicts (or all were resolved), commit directly
        if (complex.length === 0) {
          // All conflicts auto-resolved, commit with fallback message
          const staged = execSyncText("git diff --cached --quiet 2>&1; echo $?", {
            cwd: rootDir,
            encoding: "utf-8",
          }).trim();

          if (staged !== "0") {
            throwIfAborted(options.signal, taskId);
            // Body cascade: branch's commit log → AI summary of diff stat →
            // diff stat itself → synthetic placeholder. Guarantees the
            // merge commit carries a non-empty body even when the branch
            // has no unique commits to summarize.
            const safeBody = await resolveSafeCommitBody({
              rootDir,
              taskId,
              branch,
              commitLog,
              diffStat,
              settings: settings as Settings,
              signal: options.signal,
            });
            const authorArg = getCommitAuthorArg(settings);
            const trailerArg = buildTaskTrailerArgs(taskId);
            const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
              taskId,
              branch,
              commitLog,
              diffStat,
              includeTaskId,
              aiSummary: safeBody,
              aiBody: aiBody?.trim().length ? aiBody : safeBody,
              aiSubject,
            });
            await enforceSquashFileScopeInvariant({
              store,
              taskId,
              rootDir,
              task: await store.getTask(taskId),
              resetLabel: "file-scope invariant violation",
              auditor: params.auditor,
            });
            await runDiffVolumeGate({
              rootDir,
              branch,
              integrationTargetSha: params.preAttemptHeadSha || "HEAD",
              taskId,
              settings,
              store,
            });
            await execAsync(
              `git commit ${subjectArg} ${bodyArg}${trailerArg}${authorArg}`,
              { cwd: rootDir, env: mergerCommitEnv() },
            );
            mergerLog.log(`${taskId}: committed after auto-resolving all conflicts`);
          } else {
            // Auto-resolution left nothing to commit — branch's changes were
            // either fully duplicated on main or all-resolved-to-ours.
            aiTracker.mergeWasEmpty = true;
          }
          // Run deterministic verification before completing the merge
          if (testCommand || buildCommand) {
            throwIfAborted(options.signal, taskId);
            await runDeterministicVerification(
              store,
              rootDir,
              taskId,
              testCommand,
              buildCommand,
              testSource,
              buildSource,
              options.signal,
            );
          }
          return true;
        }

        // Has complex conflicts - continue to AI agent
        hasConflicts = true;
      } else {
        // No conflicts - check if squash is empty
        const squashIsEmpty = execSync(
          "git diff --cached --quiet 2>&1; echo $?",
          { cwd: rootDir, encoding: "utf-8" },
        ).trim() === "0";

        if (squashIsEmpty) {
          mergerLog.log(`${taskId}: squash merge staged nothing — already merged`);
          aiTracker.mergeWasEmpty = true;
          // Run deterministic verification (nothing staged but still verify)
          if (testCommand || buildCommand) {
            throwIfAborted(options.signal, taskId);
            await runDeterministicVerification(
              store,
              rootDir,
              taskId,
              testCommand,
              buildCommand,
              testSource,
              buildSource,
              options.signal,
            );
          }
          return true;
        }
        // No conflicts but has staged changes - continue to AI for commit message
      }
    } else {
      // Attempt 1: Standard merge
      await execAsync(`git merge --squash "${branch}"`, {
        cwd: rootDir,
      });
      throwIfAborted(options.signal, taskId);

      // Check if squash is empty
      const squashIsEmpty = execSync(
        "git diff --cached --quiet 2>&1; echo $?",
        { cwd: rootDir, encoding: "utf-8" },
      ).trim() === "0";

      if (squashIsEmpty) {
        mergerLog.log(`${taskId}: squash merge staged nothing — already merged`);
        aiTracker.mergeWasEmpty = true;
        // Run deterministic verification (nothing staged but still verify)
        if (testCommand || buildCommand) {
          throwIfAborted(options.signal, taskId);
          await runDeterministicVerification(
            store,
            rootDir,
            taskId,
            testCommand,
            buildCommand,
            testSource,
            buildSource,
            options.signal,
          );
        }
        return true;
      }

      // Check for conflicts
      const conflictedFiles = await getConflictedFiles(rootDir);
      hasConflicts = conflictedFiles.length > 0;
      if (hasConflicts) {
        const task = await store.getTask(taskId);
        const partitioned = await applyLayer3ConflictScopePartition({
          store,
          task,
          taskId,
          rootDir,
          branch,
          mergeTargetBranch: params.mergeTargetBranch ?? "main",
          conflictFiles: conflictedFiles,
          auditor: params.auditor,
        });
        hasConflicts = partitioned.inScopeConflicts.length > 0;
      }

      if (hasConflicts && !smartConflictResolution) {
        // No auto-resolve - AI will handle all conflicts
        mergerLog.log(`${taskId}: conflicts detected, AI will resolve`);
      } else if (hasConflicts && smartConflictResolution) {
        // Has conflicts and auto-resolve enabled - should be handled in attempt 2
        // Reset and return false to trigger attempt 2
        mergerLog.log(`${taskId}: conflicts detected, will retry with auto-resolution`);
        return false;
      }
    }

    if (testCommand || buildCommand) {
      throwIfAborted(options.signal, taskId);
      const stagedFiles = await getStagedFiles(rootDir);
      const configuredMergeInitCommand = getConfiguredWorktreeInitCommand(settings as Settings);
      if (
        shouldSyncDependenciesForMerge(
          stagedFiles,
          hasInstallState(rootDir),
          configuredMergeInitCommand !== null,
        )
      ) {
        await syncDependenciesForMerge(store, rootDir, taskId, settings as Settings, options.signal);
      }
    }

    // At this point, either:
    // - No conflicts (attempt 1) - AI writes commit message
    // - Complex conflicts remain after attempt 2 auto-resolution - AI resolves them
    // Spawn AI agent
    throwIfAborted(options.signal, taskId);
    aiTracker.aiWasInvoked = true; // Track that AI was invoked
    await enforceSquashFileScopeInvariant({
      store,
      taskId,
      rootDir,
      task: await store.getTask(taskId),
      resetLabel: "file-scope invariant violation",
      auditor: params.auditor,
    });
    const agentResult = await runAiAgentForCommit({
      store,
      rootDir,
      taskId,
      branch,
      commitLog,
      diffStat,
      aiSummary,
      aiBody,
      aiSubject,
      includeTaskId,
      hasConflicts,
      simplifiedContext: attemptNum === 2,
      options,
      testCommand,
      buildCommand,
      sourceIssueRef,
      preMergeRebaseFallthrough: params.preMergeRebaseFallthrough,
      preAttemptHeadSha: params.preAttemptHeadSha,
    });

    // Handle build failure
    if (!agentResult.success) {
      // Build verification failed via fn_report_build_failure. DO NOT reset
      // here: the squash state must survive for the in-merge verification
      // fix path (mergeAttempt's catch handler) to either fold its fix into
      // a fresh commit or — if the fix is disabled/exhausted — reset and
      // propagate. Resetting here previously caused the phantom-merge bug:
      // the fix agent ran on a clean main, then commitOrAmendMergeWithFixes
      // amended the *previous* task's commit because HEAD looked unchanged
      // and there was nothing left of the current task's branch to commit.
      const errorMessage = agentResult.error || "Build verification failed";
      await store.logEntry(taskId, "Build verification failed during merge", errorMessage);
      throw new Error(`Build verification failed for ${taskId}: ${errorMessage}`);
    }

    // Run deterministic verification after AI agent commits
    if (testCommand || buildCommand) {
      throwIfAborted(options.signal, taskId);
      await runDeterministicVerification(
        store,
        rootDir,
        taskId,
        testCommand,
        buildCommand,
        testSource,
        buildSource,
        options.signal,
      );
    }

    // Replace the AI-written commit message with a deterministic body built
    // from the branch's actual step-commit subjects. The AI's free-form body
    // routinely hallucinates bullets that describe work from neighbouring
    // tasks (especially on small diffs), and that message is what consumers
    // of mergeDetails surface. Subject keeps the conventional-commit shape.
    try {
      const authorArg = getCommitAuthorArg(params.settings);
      // Recompute context against the AI commit's parent (= integration
      // target) so the message describes only what this commit actually
      // adds — not the wide branch range, which under squash-merge can
      // include work already landed via prior task merges.
      let integrationTargetSha: string | undefined;
      try {
        const { stdout } = await execAsync("git rev-parse HEAD~1", {
          cwd: rootDir,
          encoding: "utf-8",
        });
        integrationTargetSha = stdout.trim() || undefined;
      } catch {
        // Root commit / detached state — fall through to wide-range values.
      }
      const actualContext = integrationTargetSha
        ? await computeActualMergeCommitContext({
            rootDir,
            integrationTargetSha,
            branch,
          })
        : { commitLog: "", diffStat: "" };
      const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
        taskId,
        branch,
        commitLog: actualContext.commitLog || commitLog,
        diffStat: actualContext.diffStat || diffStat,
        includeTaskId,
        aiSummary,
        aiBody,
        aiSubject,
      });
      const trailerArg = buildTaskTrailerArgs(taskId);
      await execAsync(
        `git commit --amend ${subjectArg} ${bodyArg}${trailerArg}${authorArg}`,
        { cwd: rootDir, env: mergerCommitEnv() },
      );
      mergerLog.log(`${taskId}: rewrote AI-authored merge commit message with deterministic body`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      mergerLog.warn(`${taskId}: failed to canonicalize merge commit message (${msg}) — keeping AI-written message`);
    }

    return true;
  } catch (error: any) {
    if (error instanceof Error && error.name === "MergeAbortedError") {
      try {
        execSync("git reset --merge", { cwd: rootDir, stdio: "pipe" });
      } catch {
        // best-effort abort cleanup
      }
      throw error;
    }

    // Check if it's a build verification failure - don't retry, propagate immediately
    if (error.message?.includes("Build verification failed")) {
      throw error; // Fatal - don't retry build failures
    }

    // Check if it's a non-conflict merge failure
    if (error.message?.includes("Merge failed")) {
      throw error; // Fatal
    }

    // VerificationError must propagate so mergeAttempt's catch can run the
    // in-merge fix against THIS attempt's preAttemptHeadSha baseline. Falling
    // through to the attempt-1 retry path here would swallow the error,
    // trigger attempt 2 with a stale baseline (= AI's commit from attempt 1),
    // and then the in-merge fix's finalizer would see !hasStaged && !headMoved
    // and trip the phantom-merge guard even though the task's content is
    // already on HEAD. Retrying with auto-conflict-resolution can't help a
    // verification failure anyway — there are no conflicts to resolve.
    if (
      error?.name === "VerificationError"
      || error?.name === "DiffVolumeRegressionError"
      || error?.name === "FileScopeViolationError"
    ) {
      throw error;
    }

    // For attempt 1, return false to trigger attempt 2 (conflict-only path)
    if (attemptNum === 1 && smartConflictResolution) {
      return false;
    }

    // Otherwise propagate
    throw error;
  }
}

/**
 * Attempt 3: Use git merge -X{theirs,ours} --squash strategy.
 * Side controls which version wins on conflicts:
 *   - "theirs" — the task branch wins (mergeConflictStrategy="smart-prefer-branch")
 *   - "ours" — the main branch wins (mergeConflictStrategy="smart-prefer-main", default)
 */
export async function attemptWithSideStrategy(
  params: MergeAttemptParams,
  side: "theirs" | "ours" = "theirs",
  aiTracker?: AiInvocationTracker,
): Promise<boolean> {
  const { rootDir, branch, taskId } = params;

  mergerLog.log(`${taskId}: attempting merge with -X ${side} strategy`);

  try {
    throwIfAborted(params.options.signal, taskId);
    await execAsync(`git merge -X ${side} --squash "${branch}"`, {
      cwd: rootDir,
    });

    // Check if there are still conflicts (some types can't be auto-resolved)
    const conflictedOutput = execSyncText("git diff --name-only --diff-filter=U", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (conflictedOutput.length > 0) {
      mergerLog.warn(`${taskId}: -X ${side} left unresolved conflicts: ${conflictedOutput}`);
      return false;
    }

    return finalizeSideStrategyAttempt(params, side, aiTracker);
  } catch (error) {
    if (error instanceof Error && (error.name === "MergeAbortedError" || error.name === "DiffVolumeRegressionError" || error.name === "FileScopeViolationError")) {
      throw error;
    }
    mergerLog.error(`${taskId}: -X ${side} merge failed: ${error}`);
    return false;
  }
}

async function attemptWithMixedSideStrategy(
  params: MergeAttemptParams,
  strategy: { defaultSide: "ours" | "theirs"; branchWinsFiles: Set<string> },
  aiTracker?: AiInvocationTracker,
): Promise<boolean> {
  const { rootDir, branch, taskId } = params;
  mergerLog.log(
    `${taskId}: attempting overlap-aware merge with -X ${strategy.defaultSide} and branch restoration for ${strategy.branchWinsFiles.size} file(s)`,
  );

  try {
    throwIfAborted(params.options.signal, taskId);
    await execAsync(`git merge -X ${strategy.defaultSide} --squash "${branch}"`, {
      cwd: rootDir,
    });

    const conflictedOutput = execSyncText("git diff --name-only --diff-filter=U", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
    if (conflictedOutput.length > 0) {
      mergerLog.warn(`${taskId}: overlap-aware merge left unresolved conflicts: ${conflictedOutput}`);
      return false;
    }

    await restoreBranchWinsFiles({
      rootDir,
      branch,
      files: strategy.branchWinsFiles,
    });

    return finalizeSideStrategyAttempt(params, strategy.defaultSide, aiTracker);
  } catch (error) {
    if (error instanceof Error && (error.name === "MergeAbortedError" || error.name === "DiffVolumeRegressionError" || error.name === "FileScopeViolationError")) {
      throw error;
    }
    mergerLog.error(`${taskId}: overlap-aware merge failed: ${error}`);
    return false;
  }
}

async function finalizeSideStrategyAttempt(
  params: MergeAttemptParams,
  side: "theirs" | "ours",
  aiTracker?: AiInvocationTracker,
): Promise<boolean> {
  const { rootDir, branch, commitLog, diffStat, aiSummary, aiBody, aiSubject, includeTaskId, sourceIssueRef, taskId, store, settings, testCommand, buildCommand, testSource, buildSource } = params;

  const staged = execSyncText("git diff --cached --quiet 2>&1; echo $?", {
    cwd: rootDir,
    encoding: "utf-8",
  }).trim();

  if (staged === "0") {
    if (aiTracker) aiTracker.mergeWasEmpty = true;
    if (testCommand || buildCommand) {
      throwIfAborted(params.options.signal, taskId);
      await runDeterministicVerification(
        store,
        rootDir,
        taskId,
        testCommand,
        buildCommand,
        testSource,
        buildSource,
        params.options.signal,
      );
    }
    return true;
  }

  throwIfAborted(params.options.signal, taskId);
  const safeBody = await resolveSafeCommitBody({
    rootDir,
    taskId,
    branch,
    commitLog,
    diffStat,
    settings: settings as Settings,
    signal: params.options.signal,
  });
  const authorArg = getCommitAuthorArg(settings);
  const trailerArg = buildTaskTrailerArgs(taskId);
  const issueRefBodyArg = sourceIssueRef ? ` -m "Ref: ${sourceIssueRef}"` : "";
  const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
    taskId,
    branch,
    commitLog,
    diffStat,
    includeTaskId,
    aiSummary,
    aiBody: aiBody?.trim().length ? aiBody : safeBody,
    aiSubject,
  });
  await enforceSquashFileScopeInvariant({
    store,
    taskId,
    rootDir,
    task: await store.getTask(taskId),
    resetLabel: "file-scope invariant violation",
    auditor: params.auditor,
  });
  await runDiffVolumeGate({
    rootDir,
    branch,
    integrationTargetSha: params.preAttemptHeadSha || "HEAD",
    taskId,
    settings,
    store,
  });
  await execAsync(
    `git commit ${subjectArg} ${bodyArg}${issueRefBodyArg}${trailerArg}${authorArg}`,
    { cwd: rootDir, env: mergerCommitEnv() },
  );
  mergerLog.log(`${taskId}: committed with -X ${side} auto-resolution`);

  if (testCommand || buildCommand) {
    throwIfAborted(params.options.signal, taskId);
    await runDeterministicVerification(
      store,
      rootDir,
      taskId,
      testCommand,
      buildCommand,
      testSource,
      buildSource,
      params.options.signal,
    );
  }

  return true;
}

function formatMergeOverlapSummary(files: string[], recentMainCommitsByFile: Map<string, string[]>): string {
  const displayedFiles = files.slice(0, 8).map((file) => {
    const shas = (recentMainCommitsByFile.get(file) ?? []).slice(0, 3).map((sha) => sha.slice(0, 8));
    const extraCommits = (recentMainCommitsByFile.get(file)?.length ?? 0) - shas.length;
    const commitSummary = shas.join(", ") + (extraCommits > 0 ? `, +${extraCommits} more` : "");
    return `${file} [${commitSummary}]`;
  });
  const extraFiles = files.length - displayedFiles.length;
  return displayedFiles.join("; ") + (extraFiles > 0 ? `; +${extraFiles} more file(s)` : "");
}

interface AiAgentParams {
  store: TaskStore;
  rootDir: string;
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat: string;
  aiSummary?: string | null;
  aiBody?: string | null;
  aiSubject?: string | null;
  includeTaskId: boolean;
  hasConflicts: boolean;
  simplifiedContext: boolean;
  sourceIssueRef?: string;
  options: MergerOptions;
  testCommand?: string;
  buildCommand?: string;
  /** Forwarded from MergeAttemptParams; injects the safety preamble into
   *  the merge prompt when the pre-merge rebase recovery cascade fell
   *  through. See MergePromptParams.preMergeRebaseFallthrough for details. */
  preMergeRebaseFallthrough?: string;
  /** HEAD of the integration target immediately before this squash attempt began. */
  preAttemptHeadSha?: string;
}

/**
 * Run the AI agent to resolve conflicts and/or write commit message.
 *
 * Each invocation creates a **fresh session** via `createFnAgent` to ensure
 * no stale conversation state from previous merge attempts or unrelated sessions
 * pollutes the merge context. The session is disposed in the `finally` block
 * regardless of success or failure.
 *
 * **Context-limit recovery:** If the session's `prompt()` call throws a
 * context-window overflow error (detected via `isContextLimitError`), this
 * function attempts a single **compact-and-retry** cycle:
 * 1. Calls `compactSessionContext()` to compress the conversation history
 * 2. Retries the `prompt()` call with the compacted session
 * 3. If compaction is unavailable or fails, propagates the original error
 *
 * Non-context errors (network, rate limits, build failures) are propagated
 * immediately without compaction recovery.
 *
 * @returns `{ success: true }` on successful commit, `{ success: false, error }`
 *          when build verification fails, or throws on unrecoverable errors.
 */
async function runAiAgentForCommit(params: AiAgentParams): Promise<{ success: boolean; error?: string }> {
  const {
    store,
    rootDir,
    taskId,
    branch,
    commitLog,
    diffStat,
    aiSummary,
    aiBody,
    aiSubject,
    includeTaskId,
    hasConflicts,
    simplifiedContext,
    sourceIssueRef,
    options,
    testCommand,
    buildCommand,
    preMergeRebaseFallthrough,
    preAttemptHeadSha,
  } = params;

  // Merge per-task effective workflow settings (U3, KTD-3) — this worker re-fetches
  // settings independently of aiMergeTask, so apply the same merge here (covers the
  // titleSummarizer lane reads in resolveSafeCommitBody). Behavior-inert by default.
  const taskForSettings = await store.getTask(taskId).catch(() => ({ id: taskId } as const));
  const settings = await mergeEffectiveSettings(
    store,
    taskForSettings,
    await store.getSettings(),
  );

  // Track build failure state
  let buildFailed = false;
  let buildErrorMessage = "";

  // Create custom tool for reporting build failures
  const reportBuildFailureTool: ToolDefinition = {
    name: "fn_report_build_failure",
    label: "Report Build Failure",
    description: "Report that the build verification failed. Use this when the build command returns a non-zero exit code. Provide the error details in the message parameter.",
    parameters: Type.Object({
      message: Type.String({ description: "Error message describing why the build failed" }),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const { message } = params as { message: string };
      buildFailed = true;
      buildErrorMessage = message;
      return { 
        content: [{ type: "text", text: `Build failure reported: ${message}` }],
        details: undefined 
      };
    },
  };

  mergerLog.log(`${taskId}: ${hasConflicts ? "resolving conflicts + " : ""}writing commit message`);

  const agentLogger = new AgentLogger({
    store,
    taskId,
    agent: "merger",
    persistAgentToolOutput: settings.persistAgentToolOutput,
    // Merger agents are task-scoped ephemeral workers.
    persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
    onAgentText: options.onAgentText
      ? (_id, delta) => options.onAgentText!(delta)
      : undefined,
    onAgentTool: options.onAgentTool
      ? (_id, name) => options.onAgentTool!(name)
      : undefined,
  });

  // Resolve per-agent custom instructions for the merger role
  let mergerInstructions = "";
  if (options.agentStore) {
    try {
      const agents = await options.agentStore.listAgents({ role: "merger" });
      for (const agent of agents) {
        if (agent.instructionsText || agent.instructionsPath) {
          mergerInstructions = await resolveAgentInstructions(agent, rootDir);
          break;
        }
      }
    } catch {
      // Graceful fallback
    }
  }
  const authorArg = getCommitAuthorArg(settings);
  const mergerSystemPrompt = buildSystemPromptWithInstructions(
    buildMergeSystemPrompt(includeTaskId, settings.agentPrompts, authorArg),
    mergerInstructions,
  );

  throwIfAborted(options.signal, taskId);

  // Build skill selection context (assigned agent skills take precedence over role fallback)
  let skillContext = undefined;
  let taskForSkillContext: Awaited<ReturnType<typeof store.getTask>> | null = null;
  if (options.agentStore) {
    try {
      taskForSkillContext = await store.getTask(taskId);
      skillContext = await buildSessionSkillContext({
        agentStore: options.agentStore,
        task: taskForSkillContext,
        sessionPurpose: "merger",
        projectRootDir: rootDir,
        pluginRunner: options.pluginRunner,
      });
    } catch {
      // Graceful fallback - no skill selection
    }
  }

  const assignedAgentId = taskForSkillContext?.assignedAgentId?.trim();
  const agentStoreWithGetAgent = options.agentStore && typeof (options.agentStore as { getAgent?: unknown }).getAgent === "function"
    ? options.agentStore
    : null;
  const assignedAgent = assignedAgentId && agentStoreWithGetAgent
    ? await agentStoreWithGetAgent.getAgent(assignedAgentId).catch(() => null)
    : null;
  const mergerRuntimeHint = extractRuntimeHint(assignedAgent?.runtimeConfig);
  const mergerSessionModel = resolveMergerSessionModel(settings, assignedAgent?.runtimeConfig);

  // FNXC:Settings-MergerModel 2026-07-16-00:00: merger retries use the dedicated project fallback lane before the shared global fallback pair.

  const mergerFallbackModel = resolveMergerFallbackModel(settings);

  // FN-5279: Layer 3 / merge-authoring AI runs in the resolved integration
  // root so arbiter edits land in the reused task worktree when handoff mode
  // is active.
  const { session } = await createResolvedAgentSession({
    sessionPurpose: "merger",
    runtimeHint: mergerRuntimeHint,
    pluginRunner: options.pluginRunner,
    cwd: rootDir,
    systemPrompt: mergerSystemPrompt,
    tools: "coding",
    customTools: [reportBuildFailureTool, createWebFetchTool()],
    onText: agentLogger.onText,
    onThinking: agentLogger.onThinking,
    onToolStart: agentLogger.onToolStart,
    onToolEnd: agentLogger.onToolEnd,
    defaultProvider: mergerSessionModel.provider,
    defaultModelId: mergerSessionModel.modelId,
    fallbackProvider: mergerFallbackModel.provider,
    fallbackModelId: mergerFallbackModel.modelId,
    fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings),
    defaultThinkingLevel: resolveMergerThinkingLevel(settings),
    runAuditor: createRunAuditor(store, {
      runId: generateSyntheticRunId("merge", taskId),
      agentId: "merger",
      taskId,
      phase: "merge",
      source: "merger",
    }),
    settings,
    // FNXC:McpConfig 2026-06-25-23:04: The primary merge-authoring agent is part of the merger lane and receives the resolved MCP set under the shared runtime-support guard, matching conflict/verification merge sessions without exposing secret material.
    mcpServers: await resolveMergerMcpServers(store, assignedAgent?.id),
    // FNXC:PluginSkills 2026-07-12-00:00: Merge-authoring sessions forward plugin skill body dirs so plugin-contributed merger skills load their bodies.
    ...(skillContext?.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
    ...(skillContext && skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
    taskId,
    taskTitle: taskForSkillContext?.title,
    onFallbackModelUsed: createFallbackModelObserver({
      agent: "merger",
      label: "merge agent",
      store,
      taskId,
      taskTitle: taskForSkillContext?.title,
    }),
  });

  options.onSession?.(session);

  try {
    // Build appropriate prompt
    const latestTaskForMergePrompt = await store.getTask(taskId);
    const userComments = selectUserCommentsForAgentContext(latestTaskForMergePrompt);
    const prompt = buildMergePrompt({
      taskId,
      branch,
      commitLog: simplifiedContext ? "(see branch commits)" : commitLog,
      diffStat,
      hasConflicts,
      simplifiedContext,
      testCommand,
      buildCommand,
      authorArg,
      sourceIssueRef,
      preMergeRebaseFallthrough,
      userComments,
    });

    // Attempt prompting with fresh session (first attempt).
    // Log message distinguishes fresh-session start from compaction recovery path.
    mergerLog.log(`${taskId}: starting fresh merge agent session`);

    try {
      await withRateLimitRetry(async () => {
        throwIfAborted(options.signal, taskId);
        await promptWithFallback(session, prompt);
        checkSessionError(session);
      }, {
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          mergerLog.warn(`⏳ ${taskId} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
        },
        signal: options.signal,
      });
    } catch (err: unknown) {
      // Context-limit error after promptWithFallback's auto-compaction already attempted recovery.
      // Try truncated prompt retry as second-level fallback.
      // This detects when the LLM rejects the prompt due to context-window overflow.
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (isContextLimitError(errorMessage)) {
        mergerLog.warn(`${taskId}: context limit hit after auto-compaction — retrying with minimal merge prompt`);
        await store.logEntry(taskId, "Context limit reached during merge after auto-compaction — retrying with reduced prompt");

        // Build minimal prompt: omit diff stat, use placeholder for commit log.
        // The fall-through preamble is preserved (it's the safety constraint,
        // not bulk context) so the AI's truncated retry still knows main's
        // deletions are authoritative.
        const latestTaskForTruncatedMergePrompt = await store.getTask(taskId);
        const truncatedUserComments = selectUserCommentsForAgentContext(latestTaskForTruncatedMergePrompt);
        const truncatedPrompt = buildMergePrompt({
          taskId,
          branch,
          commitLog: "(see git log)", // Minimal placeholder instead of full commit log
          diffStat: "", // Omit diff stat entirely
          hasConflicts,
          simplifiedContext: true, // Also skip detailed context
          testCommand,
          buildCommand,
          authorArg,
          sourceIssueRef,
          preMergeRebaseFallthrough,
          userComments: truncatedUserComments,
        });

        try {
          await withRateLimitRetry(async () => {
            throwIfAborted(options.signal, taskId);
            await promptWithFallback(session, truncatedPrompt);
            checkSessionError(session);
          }, {
            onRetry: (attempt, delayMs, error) => {
              const delaySec = Math.round(delayMs / 1000);
              mergerLog.warn(`⏳ ${taskId} rate limited during truncated retry — retry ${attempt} in ${delaySec}s: ${error.message}`);
            },
            signal: options.signal,
          });
        } catch (retryErr: unknown) {
          // Truncated retry also failed: propagate original error
          const retryErrorMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (isContextLimitError(retryErrorMessage)) {
            mergerLog.error(`${taskId}: truncated retry also hit context limit — propagating original error`);
            throw err; // Throw original error with original context
          }
          throw retryErr; // Non-context error or other failure
        }
      } else {
        // Non-context error (network, rate limit, build failure): propagate immediately.
        // Rate limit errors are handled by withRateLimitRetry above; this catches
        // errors that bubble up after retries are exhausted.
        throw err;
      }
    }

    // Check if build failed
    if (buildFailed) {
      mergerLog.error(`Build verification failed for ${taskId}: ${buildErrorMessage}`);
      return { success: false, error: buildErrorMessage };
    }

    // Verify commit happened
    const staged = execSyncText("git diff --cached --quiet 2>&1; echo $?", {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();

    if (staged !== "0") {
      // Only use fallback commit if no build command was configured
      // If build command was configured, agent should have committed or reported failure
      if (!buildCommand) {
        throwIfAborted(options.signal, taskId);
        mergerLog.log("Agent didn't commit — committing with fallback message");
        // Body cascade: branch's commit log → AI summary of diff stat →
        // diff stat itself → synthetic placeholder. Guarantees the merge
        // commit carries a non-empty body even when the AI agent didn't
        // commit and the branch has no unique commits to summarize.
        const safeBody = await resolveSafeCommitBody({
          rootDir,
          taskId,
          branch,
          commitLog,
          diffStat,
          settings: settings as Settings,
          signal: options.signal,
        });
        const authorArg = getCommitAuthorArg(settings);
        const trailerArg = buildTaskTrailerArgs(taskId);
        const issueRefBodyArg = sourceIssueRef ? ` -m "Ref: ${sourceIssueRef}"` : "";
        const { subjectArg, bodyArg } = await buildDeterministicMergeMessage({
          taskId,
          branch,
          commitLog,
          diffStat,
          includeTaskId,
          aiSummary,
          aiBody: aiBody?.trim().length ? aiBody : safeBody,
          aiSubject,
        });
        await runDiffVolumeGate({
          rootDir,
          branch,
          integrationTargetSha: preAttemptHeadSha || "HEAD",
          taskId,
          settings,
          store,
        });
        await execAsync(
          `git commit ${subjectArg} ${bodyArg}${issueRefBodyArg}${trailerArg}${authorArg}`,
          { cwd: rootDir, env: mergerCommitEnv() },
        );
      } else {
        // Build command was configured but agent didn't commit and didn't report failure
        // This is an error condition - agent didn't follow instructions
        throw new Error(`Agent did not commit and did not report build failure for ${taskId}`);
      }
    } else {
      // The agent committed. Idempotently ensure canonical task trailers are
      // present on HEAD for durable lineage attribution and fallback recovery.
      await ensureTaskTrailersOnHead(rootDir, { id: taskId });
    }

    return { success: true };
  } catch (err: any) {
    mergerLog.error(`Agent failed: ${err.message}`);

    if (options.usageLimitPauser && isUsageLimitError(err.message)) {
      await options.usageLimitPauser.onUsageLimitHit("merger", taskId, err.message);
    }

    throw err;
  } finally {
    await accumulateSessionTokenUsage(store, taskId, session);
    await agentLogger.flush();
    session.dispose();
  }
}

interface MergePromptParams {
  taskId: string;
  branch: string;
  commitLog: string;
  diffStat: string;
  hasConflicts: boolean;
  simplifiedContext?: boolean;
  sourceIssueRef?: string;
  testCommand?: string;
  buildCommand?: string;
  authorArg?: string;
  /** When set, the pre-merge rebase aborted under smart-prefer-main and the
   *  surgical/patch-id recovery layers couldn't unblock it. The prompt
   *  injects an explicit safety preamble so the AI knows main's deletions
   *  are authoritative and to prefer main on ambiguous hunks. The
   *  deterministic post-merge verification (test + build) is the safety
   *  gate; this preamble gives the AI a fighting chance to do the right
   *  thing on its first try. */
  preMergeRebaseFallthrough?: string;
  userComments?: TaskComment[];
}

export function buildMergePrompt(params: MergePromptParams): string {
  const { taskId, branch, commitLog, diffStat, hasConflicts, simplifiedContext, sourceIssueRef, testCommand, buildCommand, authorArg, preMergeRebaseFallthrough, userComments } = params;

  // Apply truncation to prevent context overflow for large branches/diffs
  const truncatedCommitLog = truncateWithEllipsis(commitLog, MERGE_COMMIT_LOG_MAX_CHARS);
  const truncatedDiffStat = truncateWithEllipsis(diffStat, MERGE_DIFF_STAT_MAX_CHARS);
  const userCommentsSection = truncateWithEllipsis(
    buildUserCommentsPromptSection(userComments ?? []),
    MERGE_USER_COMMENTS_MAX_CHARS,
  );

  const parts: string[] = [];

  // When pre-merge rebase recovery layers (1+2) couldn't reconcile this
  // branch with main, this AI invocation is the final automated arbiter.
  // Give it the context and the safety constraint up front — verification
  // (test + build) is what enforces the constraint, but the AI should still
  // know what's expected so its first attempt has a real chance.
  if (preMergeRebaseFallthrough) {
    parts.push(
      "## ⚠️ Pre-merge rebase recovery exhausted — you are the final arbiter",
      "",
      "The pre-merge rebase against main aborted, and the surgical (Layer 1) and",
      "patch-id (Layer 2) recovery layers could not reconcile the branch. You are",
      "running under `smart-prefer-main` strategy, which means:",
      "",
      "**SAFETY CONSTRAINT — main's deletions are authoritative.**",
      "- If a hunk shows main has deleted lines that the branch re-adds, prefer",
      "  main's deletion. Branch-only re-additions are likely orphan content from",
      "  a squash-merged dependency and must NOT be re-introduced.",
      "- If a hunk is genuinely ambiguous, prefer main's version.",
      "- The merge result MUST pass `pnpm test` and `pnpm build`. If you can't",
      "  produce a result that does, call `fn_report_build_failure` with concrete",
      "  output rather than committing a regression.",
      "",
      `Original rebase failure for context: ${preMergeRebaseFallthrough.slice(0, 800)}`,
      "",
      "---",
      "",
    );
  }

  parts.push(
    `Finalize the merge of branch \`${branch}\` for task ${taskId}.`,
    "",
    "## Branch commits",
    "```",
    truncatedCommitLog,
    "```",
  );

  if (!simplifiedContext) {
    parts.push(
      "",
      "## Files changed",
      "```",
      truncatedDiffStat,
      "```",
    );
  }

  if (userCommentsSection) {
    parts.push("", userCommentsSection);
  }

  if (hasConflicts) {
    parts.push(
      "",
      "## ⚠️ There are merge conflicts",
      "Run `git diff --name-only --diff-filter=U` to see which files.",
      "Resolve each conflict, then `git add` the resolved files.",
      `After resolving all conflicts, write and run the commit command.${authorArg ? ` Be sure to append \`${authorArg.trim()}\` to the commit command so Fusion is recorded as a co-author.` : ""}`,
    );
  } else {
    parts.push(
      "",
      "## No conflicts",
      "The merge applied cleanly. All changes are staged.",
      `Write and run the \`git commit\` command with a good message summarizing the work.${authorArg ? ` Be sure to append \`${authorArg.trim()}\` to the commit command so Fusion is recorded as a co-author.` : ""}`,
    );
  }

  if (sourceIssueRef) {
    parts.push(
      "",
      "Include this in the commit message body:",
      `- Ref: ${sourceIssueRef}`,
    );
  }

  // Add test command section if provided
  if (testCommand) {
    parts.push(
      "",
      "## Test command",
      `Test command: \`${testCommand}\``,
      "",
      "This command is mandatory before commit.",
      "Run it with the bash tool in the current worktree and inspect the actual exit code.",
      "Only proceed if it exits 0.",
      "If it exits non-zero, call `fn_report_build_failure` with the concrete error output and stop without committing.",
    );
  }

  // Add build command section if provided
  if (buildCommand) {
    parts.push(
      "",
      "## Build command",
      `Build command: \`${buildCommand}\``,
      "",
      "This command is mandatory before commit.",
      "Run it with the bash tool in the current worktree and inspect the actual exit code.",
      "Only commit if it exits 0.",
      "If it exits non-zero, call `fn_report_build_failure` with the concrete error output and stop without committing.",
    );
  }

  return parts.join("\n");
}

function getPostMergeScriptSandboxBackend(auditor?: RunAuditor): SandboxBackend {
  return resolveSandboxBackend({ auditor });
}

async function runConfiguredMergeWorktreeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
  auditor?: RunAuditor,
): Promise<{
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  bufferExceeded?: boolean;
  spawnError?: Error;
}> {
  const backend = getPostMergeScriptSandboxBackend(auditor);
  const result = await backend.run(command, {
    cwd,
    encoding: "utf-8",
    timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    ...(extraEnv !== undefined && { env: extraEnv }),
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    bufferExceeded: result.bufferExceeded,
    spawnError: result.spawnError,
  };
}

async function completeTask(
  store: TaskStore,
  taskId: string,
  result: MergeResult,
): Promise<void> {
  mergerLog.log(`${taskId}: completeTask — clearing status, moving to done`);
  const preMoveTask = await store.getTask(taskId);
  // Clear transient status before moving to done
  await store.updateTask(taskId, { status: null });
  // Use moveTask for proper event emission
  const task = await store.moveTask(taskId, "done");
  const settings = await store.getSettings();
  if (isMergeRequestContractShadowEnabled(settings) && preMoveTask?.autoMerge !== false) {
    const mergeRequestRecord = await store.getMergeRequestRecordAsync(taskId);
    if (mergeRequestRecord) {
      await store.transitionMergeRequestState(taskId, "succeeded");
    }
  }
  result.task = task;
  store.emit("task:merged", result);
}
