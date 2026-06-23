/**
 * Standalone AI merge path (FN-5633).
 *
 * This is "AI mode" — a self-contained merge implementation that deliberately
 * does NOT share the legacy `aiMergeTask` pipeline (prerebase / conflict-strategy
 * ladder / transient self-heal), which is buggy and error-prone.
 *
 * FNXC:MergerUnification 2026-06-21-19:05: master-plan U0 made this the SOLE
 * merge path. Every merge entry point (engine dispatch, `fn task merge`, the
 * UI-only dashboard merge) routes here; `merger.mode` is inert (a "deterministic"
 * value only logs a one-time deprecation warning). The legacy `aiMergeTask`
 * pipeline is soft-deprecated.
 *
 * Shape:
 *   1. Clean room — create a throwaway detached worktree at the integration
 *      branch's current tip. The user's real checkout is never used as the merge
 *      surface, so dirty files cannot be clobbered and the result is a
 *      fast-forward of the integration ref BY CONSTRUCTION (no stale-base /
 *      non-FF class).
 *   2. AI merges the task branch into that clean checkout and produces one
 *      squash commit, resolving conflicts in favor of the task's intent.
 *   3. A fresh read-only AI reviewer audits the squash. It drives up to
 *      `merger.maxReviewPasses` corrective rounds. Advisory concerns then land
 *      with a warning; a BLOCKING (correctness) concern the AI cannot fix
 *      hard-fails (never ships wrong code). No human is required for the
 *      common path.
 *   4. CAS fast-forward of `refs/heads/<integration>` to the squash (retry on a
 *      concurrent advance by rebuilding on the new tip).
 *   5. Sync the user's local checkout to the new tip only when it is clean by
 *      default. Dirty checked-out integration worktrees fail closed before the
 *      branch ref advances, preventing unrelated local changes from poisoning
 *      subsequent merge runs. An explicit escape hatch can opt into the legacy
 *      stash → ff → restore path.
 *
 * Pure helpers (prompt builders, verdict parser) are exported for unit testing;
 * the orchestrator accepts injectable agent functions for the same reason.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  assertNotWorkspaceTaskMerge,
  buildTaskLineageTrailer,
  evaluateNoCommitsNoOpFinalize,
  getPrimaryPrInfo,
  getTaskMergeBlocker,
  resolveAgentPrompt,
  resolvePersistAgentThinkingLog,
  resolveTaskMergeTarget,
  resolveValidatorSettingsModel,
  type AgentPromptsConfig,
  type MergeDetails,
  type MergeResult,
  type Settings,
  type Task,
  type TaskComment,
  type TaskStore,
} from "@fusion/core";
import { buildUserCommentsPromptSection, selectUserCommentsForAgentContext } from "./agent-user-comments.js";
import { resolveTaskWorkingBranch } from "./worktree-names.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import { advanceIntegrationBranchRef } from "./merger-ref-update-advance.js";
import { createResolvedAgentSession, resolveMergerSessionModel } from "./agent-session-helpers.js";
import { promptWithFallback } from "./pi.js";
import { AgentLogger } from "./agent-logger.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { checkSessionError } from "./usage-limit-detector.js";
import { accumulateSessionTokenUsage } from "./session-token-usage.js";
import { createRunAuditor, generateSyntheticRunId, type RunAuditor } from "./run-audit.js";
import { createLogger } from "./logger.js";
import { captureSingleCommitLandedMetadata, type MergerOptions } from "./merger.js";
import { installWorktreeDependencies } from "./merge-dependency-sync.js";
import { activeSessionRegistry } from "./active-session-registry.js";
import { MIN_TEMP_WORKTREE_REAP_AGE_MS } from "./self-healing.js";
import { resolveAiMergeRootPath, resolveLegacyAiMergeRootPath } from "./worktree-paths.js";
import { finalizeProvenAutoMergeTask } from "./auto-merge-finalization.js";

const execFileAsync = promisify(execFile);
const aiMergeLog = createLogger("merger-ai");

const MAX_CONCURRENT_ADVANCE_RETRIES = 3;

async function git(args: string[], cwd: string, opts: { timeout?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: opts.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitOk(args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getErrorStringProperty(err: unknown, key: "stderr" | "code"): string | undefined {
  if (!err || typeof err !== "object" || !(key in err)) return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function describeCleanupError(err: unknown): string {
  const stderr = getErrorStringProperty(err, "stderr");
  const message = getErrorMessage(err);
  return stderr ? `${message}: ${stderr.trim()}` : message;
}

export function isBenignAbsentWorktreeError(err: unknown): boolean {
  const code = getErrorStringProperty(err, "code");
  if (code === "ENOENT") return true;
  const description = describeCleanupError(err);
  return /is not a working tree|No such file or directory|spawn\s+.*\bENOENT\b/i.test(description);
}

function ensureAiMergeRootIgnored(projectRootDir: string, settings?: Settings): void {
  const excludePath = join(projectRootDir, ".git", "info", "exclude");
  if (!existsSync(excludePath)) return;
  try {
    const current = readFileSync(excludePath, "utf-8");
    const legacyAiMergeRoot = resolveLegacyAiMergeRootPath(projectRootDir);
    const legacyRelativeAiMergeRoot = relative(projectRootDir, legacyAiMergeRoot);
    const entries = [`${legacyRelativeAiMergeRoot.replaceAll("\\", "/")}/`];
    const aiMergeRoot = resolveAiMergeRootPath(projectRootDir, settings);
    const relativeAiMergeRoot = relative(projectRootDir, aiMergeRoot);
    if (relativeAiMergeRoot && !relativeAiMergeRoot.startsWith("..") && !isAbsolute(relativeAiMergeRoot)) {
      entries.push(`${relativeAiMergeRoot.replaceAll("\\", "/")}/`);
    }

    const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry));
    if (missing.length > 0) {
      appendFileSync(excludePath, `${current.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
    }
  } catch {
    // Best effort only: cleanup still removes the root contents, and existing
    // projects generally ignore .fusion already.
  }
}

export function resolveAiMergeRoot(projectRootDir: string, settings?: Settings): string {
  const root = resolveAiMergeRootPath(projectRootDir, settings);
  mkdirSync(root, { recursive: true });
  ensureAiMergeRootIgnored(projectRootDir, settings);
  return root;
}

function getAiMergeTempSearchRoots(projectRootDir: string, settings?: Settings): string[] {
  const roots = [resolveAiMergeRoot(projectRootDir, settings), resolveLegacyAiMergeRootPath(projectRootDir), tmpdir()];
  const testWorkerRoot = process.env.FUSION_TEST_WORKER_ROOT;
  if (testWorkerRoot) {
    try {
      for (const entry of readdirSync(testWorkerRoot)) {
        if (entry.startsWith("redir-")) roots.push(join(testWorkerRoot, entry));
      }
    } catch {
      // Best effort for the test harness' bounded temp-dir redirection root.
    }
  }
  return Array.from(new Set(roots));
}

export async function pruneExistingAiMergeWorktrees(
  taskId: string,
  projectRootDir: string,
  audit: RunAuditor,
  log: (message: string) => Promise<void>,
  settings?: Settings,
): Promise<number> {
  const prefix = `fusion-ai-merge-${taskId.toLowerCase()}-`;
  const tempRoots = getAiMergeTempSearchRoots(projectRootDir, settings);

  let pruned = 0;
  let cleanupAttempted = false;
  for (const tempRoot of tempRoots) {
    let entries: string[];
    try {
      entries = readdirSync(tempRoot).filter((entry) => entry.startsWith(prefix));
    } catch (err: unknown) {
      await log(`AI merge pre-merge prune: failed to read ${tempRoot}: ${getErrorMessage(err)}`);
      if (tempRoot === tmpdir()) throw err;
      continue;
    }

    for (const entry of entries) {
      const candidatePath = join(tempRoot, entry);
      let canonicalPath = candidatePath;
      try {
        canonicalPath = realpathSync(candidatePath);
      } catch {
        canonicalPath = candidatePath;
      }

      if (activeSessionRegistry.isPathActive(canonicalPath) || activeSessionRegistry.isPathActive(candidatePath)) {
        await log(`AI merge pre-merge prune: skipping active worktree ${canonicalPath}`);
        continue;
      }

      try {
        const stat = statSync(canonicalPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < MIN_TEMP_WORKTREE_REAP_AGE_MS) {
          await log(`AI merge pre-merge prune: skipping too-new worktree ${canonicalPath} (age ${Math.max(0, Math.round(ageMs))}ms)`);
          continue;
        }
      } catch (err: unknown) {
        await log(`AI merge pre-merge prune: failed to stat ${canonicalPath}: ${getErrorMessage(err)} — skipping candidate`);
        continue;
      }

      let alreadyAbsent = false;
      try {
        cleanupAttempted = true;
        await execFileAsync("git", ["worktree", "remove", "--force", canonicalPath], {
          cwd: projectRootDir,
          timeout: 30_000,
        });
      } catch (err: unknown) {
        if (isBenignAbsentWorktreeError(err)) {
          alreadyAbsent = true;
          await log(`AI merge pre-merge prune: worktree ${canonicalPath} was already absent/de-registered; treating cleanup as idempotent`);
        } else {
          await log(`AI merge pre-merge prune: git worktree remove failed for ${canonicalPath}: ${describeCleanupError(err)} — falling back to filesystem removal`);
        }
      }

      try {
        cleanupAttempted = true;
        rmSync(canonicalPath, { recursive: true, force: true });
        await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalPath, metadata: { taskId, mergeRoot: canonicalPath, phase: "pre-merge-prune", success: true, ...(alreadyAbsent ? { alreadyAbsent: true, idempotent: true } : {}) } });
        pruned++;
      } catch (err: unknown) {
        if (isBenignAbsentWorktreeError(err)) {
          await log(`AI merge pre-merge prune: worktree ${canonicalPath} was already absent during filesystem cleanup; treating cleanup as idempotent`);
          await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalPath, metadata: { taskId, mergeRoot: canonicalPath, phase: "pre-merge-prune", success: true, alreadyAbsent: true, idempotent: true } });
          pruned++;
          continue;
        }
        const error = getErrorMessage(err);
        const code = getErrorStringProperty(err, "code");
        await log(`AI merge pre-merge prune: filesystem rm failed for ${canonicalPath}${code ? ` (${code})` : ""}: ${error}`);
        await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalPath, metadata: { taskId, mergeRoot: canonicalPath, phase: "pre-merge-prune", success: false, error, ...(code ? { code } : {}) } });
      }
    }
  }

  if (cleanupAttempted) {
    try {
      await execFileAsync("git", ["worktree", "prune"], { cwd: projectRootDir, timeout: 30_000 });
    } catch (err: unknown) {
      await log(`AI merge pre-merge prune: git worktree prune failed: ${describeCleanupError(err)}`);
    }
  }

  return pruned;
}

export async function cleanupAiMergeWorktree(input: {
  taskId: string;
  mergeRoot: string;
  projectRootDir: string;
  worktreeAdded: boolean;
  audit: RunAuditor;
  log: (message: string) => Promise<void>;
  gitRunner?: typeof git;
  rmRunner?: typeof rm;
}): Promise<void> {
  const { taskId, mergeRoot, projectRootDir, worktreeAdded, audit, log, gitRunner = git, rmRunner = rm } = input;
  let canonicalRoot = mergeRoot;
  try {
    canonicalRoot = realpathSync(mergeRoot);
  } catch {
    canonicalRoot = mergeRoot;
  }
  const removalTargets = canonicalRoot === mergeRoot ? [mergeRoot] : [canonicalRoot, mergeRoot];
  const cleanupMetadata = { taskId, mergeRoot: canonicalRoot, requestedMergeRoot: mergeRoot };
  let alreadyAbsent = false;

  if (worktreeAdded) {
    if (!existsSync(canonicalRoot) && !existsSync(mergeRoot)) {
      alreadyAbsent = true;
      await log(`AI merge cleanup: worktree ${canonicalRoot} was already absent before git removal; treating cleanup as idempotent`);
      await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-remove", success: true, alreadyAbsent: true, idempotent: true, code: "ENOENT" } });
    } else {
      try {
        await gitRunner(["worktree", "remove", "--force", canonicalRoot], projectRootDir);
        await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-remove", success: true } });
      } catch (err: unknown) {
        const error = describeCleanupError(err);
        const code = getErrorStringProperty(err, "code");
        if (isBenignAbsentWorktreeError(err)) {
          alreadyAbsent = true;
          await log(`AI merge cleanup: worktree ${canonicalRoot} was already absent/de-registered during git removal; treating cleanup as idempotent`);
          await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-remove", success: true, alreadyAbsent: true, idempotent: true, error, ...(code ? { code } : {}) } });
        } else {
          await log(`AI merge cleanup: git worktree remove failed for ${canonicalRoot}${code ? ` (${code})` : ""}: ${error}`);
          await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-remove", success: false, error, ...(code ? { code } : {}) } });
        }
      }
    }
  }

  let removedFromFilesystem = false;
  for (const target of removalTargets) {
    try {
      await rmRunner(target, { recursive: true, force: true });
      await audit.git({ type: "merge:ai-worktree-cleanup", target, metadata: { ...cleanupMetadata, phase: "fs-rm", path: target, success: true, ...(alreadyAbsent ? { alreadyAbsent: true, idempotent: true } : {}) } });
      removedFromFilesystem = true;
      break;
    } catch (err: unknown) {
      const error = getErrorMessage(err);
      const code = getErrorStringProperty(err, "code");
      if (isBenignAbsentWorktreeError(err)) {
        await log(`AI merge cleanup: worktree ${target} was already absent during filesystem cleanup; treating cleanup as idempotent`);
        await audit.git({ type: "merge:ai-worktree-cleanup", target, metadata: { ...cleanupMetadata, phase: "fs-rm", path: target, success: true, alreadyAbsent: true, idempotent: true, error, ...(code ? { code } : {}) } });
        removedFromFilesystem = true;
        break;
      }
      await log(`AI merge cleanup: filesystem rm failed for ${target}${code ? ` (${code})` : ""}: ${error}`);
      await audit.git({ type: "merge:ai-worktree-cleanup", target, metadata: { ...cleanupMetadata, phase: "fs-rm", path: target, success: false, error, ...(code ? { code } : {}) } });
    }
  }

  if (!removedFromFilesystem) {
    await log(`AI merge cleanup: filesystem cleanup did not remove ${canonicalRoot}; continuing to prune worktree metadata`);
  }

  try {
    await gitRunner(["worktree", "prune"], projectRootDir, { timeout: 30_000 });
    await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-prune", success: true } });
  } catch (err: unknown) {
    const error = describeCleanupError(err);
    const code = getErrorStringProperty(err, "code");
    await log(`AI merge cleanup: git worktree prune failed after removing ${canonicalRoot}${code ? ` (${code})` : ""}: ${error}`);
    await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-prune", success: false, error, ...(code ? { code } : {}) } });
  }

}

const FUSION_TASK_ID_TRAILER_KEY = "Fusion-Task-Id";

/** Trailers that associate the squash commit with its board task: the
 *  `Fusion-Task-Id` trailer plus the canonical lineage trailer when available.
 *  These are what the board's commit→task association parses. */
function taskTrailers(taskId: string, lineageId?: string | null): string[] {
  const trailers = [`${FUSION_TASK_ID_TRAILER_KEY}: ${taskId}`];
  if (lineageId) trailers.push(buildTaskLineageTrailer(lineageId));
  return trailers;
}

/** Idempotently guarantee the squash commit's task metadata — a safety net so
 *  board association and the task-id prefix hold even if the AI agent omitted
 *  them: the subject starts with `<taskId>:` (when includeTaskId) and the
 *  association trailers are present. */
async function ensureCommitTaskMetadata(
  mergeRoot: string,
  taskId: string,
  includeTaskId: boolean,
  trailers: string[],
): Promise<void> {
  const fullMessage = await git(["log", "-1", "--pretty=%B"], mergeRoot).catch(() => "");
  if (!fullMessage) return;
  const subject = (fullMessage.split("\n")[0] ?? "").trim();
  const body = await git(["log", "-1", "--pretty=%b"], mergeRoot).catch(() => "");

  const needsPrefix = includeTaskId && !subject.toLowerCase().startsWith(taskId.toLowerCase());
  const missingTrailers = trailers.filter((t) => !fullMessage.includes(t));
  if (!needsPrefix && missingTrailers.length === 0) return;

  const args = ["-c", "trailer.ifExists=addIfDifferent", "commit", "--amend"];
  if (needsPrefix) {
    // Rewrite the message with the task-id-prefixed subject (body, which already
    // carries any existing trailers, is preserved verbatim).
    args.push("-m", `${taskId}: ${subject}`);
    if (body.trim()) args.push("-m", body);
  } else {
    args.push("--no-edit");
  }
  for (const t of missingTrailers) args.push("--trailer", t);
  await git(args, mergeRoot).catch((err: unknown) => {
    aiMergeLog.warn(`failed to amend task metadata onto squash (${err instanceof Error ? err.message : String(err)})`);
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export type AiMergeReviewSeverity = "blocking" | "advisory";

export interface AiMergeReviewVerdict {
  verdict: "approve" | "reject";
  reasons: string[];
  severity?: AiMergeReviewSeverity;
}

export const REVIEW_VERDICT_MARKER = "REVIEW_VERDICT:";
const VERDICT_LINE_RE = /REVIEW_VERDICT:\s*(approve|reject)\b/i;
const SEVERITY_LINE_RE = /SEVERITY:\s*(blocking|advisory)\b/i;

/**
 * Parse the reviewer's free-form output. Fail-safe: no/garbled output, or a
 * rejection with no explicit severity, is treated as a BLOCKING reject — an
 * ambiguous reviewer can never wave wrong code through, nor silently downgrade
 * to advisory.
 */
export function parseReviewVerdict(agentText: string | null | undefined): AiMergeReviewVerdict {
  const text = (agentText ?? "").trim();
  if (!text) return { verdict: "reject", reasons: ["reviewer produced no output"], severity: "blocking" };

  const lines = text.split(/\r?\n/);
  let verdictLineIndex = -1;
  let decision: "approve" | "reject" | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(VERDICT_LINE_RE);
    if (m) {
      decision = m[1].toLowerCase() as "approve" | "reject";
      verdictLineIndex = i;
      break;
    }
  }
  if (!decision) {
    return {
      verdict: "reject",
      reasons: [`reviewer did not emit a "${REVIEW_VERDICT_MARKER} approve|reject" line`],
      severity: "blocking",
    };
  }
  if (decision === "approve") return { verdict: "approve", reasons: [] };

  const severity: AiMergeReviewSeverity = SEVERITY_LINE_RE.test(text)
    ? (text.match(SEVERITY_LINE_RE)![1].toLowerCase() as AiMergeReviewSeverity)
    : "blocking";
  return { verdict: "reject", reasons: extractRejectReasons(lines, verdictLineIndex), severity };
}

function extractRejectReasons(lines: string[], verdictLineIndex: number): string[] {
  const reasons: string[] = [];
  const inline = lines[verdictLineIndex].replace(VERDICT_LINE_RE, "").replace(/^[\s:–—-]+/, "").trim();
  if (inline) reasons.push(inline);
  for (let i = verdictLineIndex + 1; i < lines.length; i++) {
    if (SEVERITY_LINE_RE.test(lines[i])) continue;
    const cleaned = lines[i].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (cleaned) reasons.push(cleaned);
  }
  if (reasons.length === 0) reasons.push("reviewer rejected the merge without a stated reason");
  return reasons;
}

export function buildMergeSystemPrompt(agentPrompts?: AgentPromptsConfig): string {
  // Base persona is the editable "merger" agent prompt (Settings → Prompts);
  // the non-negotiable clean-room / verification / commit-trailer rules below
  // are always appended so a custom prompt can't drop them.
  const base = resolveAgentPrompt("merger", agentPrompts).trim();
  return [
    base,
    base ? "" : undefined,
    "## AI merge — clean room",
    "You are on a CLEAN, detached checkout at the integration branch's current",
    "tip. Land the task branch's work as a single commit.",
    "",
    "Constraints:",
    "  - Resolve every conflict in favor of the task branch's intent; never drop",
    "    the task's changes to make a conflict go away.",
    "  - Do not make edits unrelated to reconciling the two branches.",
    "  - Do NOT push, force-push, or run `git update-ref` / `git reset --hard`",
    "    on any other branch. Only commit on this detached HEAD.",
    "  - Finish with exactly ONE new commit on HEAD containing the task's work.",
    "",
    "Verify before committing:",
    "  - After resolving the merge, run the project's checks — tests, type-check,",
    "    and lint (discover them from the project config / package.json scripts,",
    "    e.g. test / typecheck / lint / build).",
    "  - FIX any NEW failure the merge or conflict resolution introduced (a check",
    "    that passed on the task branch or the integration tip but fails on the",
    "    merged tree). You do not need to fix failures that were already broken on",
    "    the integration branch beforehand, but never commit a merge that adds new",
    "    test, type-check, or lint failures.",
    "",
    "Commit message:",
    "  - The subject line must CONCISELY SUMMARIZE the squashed changes in",
    "    imperative mood (e.g. \"add X\", \"fix Y\") based on the actual diff — do",
    "    not just restate the task title.",
    "  - The commit BODY must include:",
    "      1) one short narrative summary line,",
    "      2) a bullet list of key changes, and",
    "      3) a `Files changed:` section populated from `git diff --stat`.",
    "  - Include the task-id prefix and the trailer lines EXACTLY as given in the",
    "    task instructions (they associate the commit with the board task).",
  ].filter((l) => l !== undefined).join("\n");
}

export function buildMergePrompt(input: {
  taskId: string;
  branch: string;
  integrationBranch: string;
  tipSha: string;
  /** Task title — a HINT for the summary, not the literal subject. */
  taskTitle?: string;
  /** Whether to prefix the subject with the task id. */
  includeTaskId: boolean;
  /** Required trailers to append (board association). */
  trailers: string[];
  correctiveReasons?: string[];
  userComments?: TaskComment[];
}): string {
  const subjectShape = input.includeTaskId
    ? `"${input.taskId}: <concise imperative summary of the squashed changes>"`
    : `"<concise imperative summary of the squashed changes>"`;
  const trailerArgs = input.trailers.map((t) => ` -m ${JSON.stringify(t)}`).join("");
  const lines = [
    `Merge branch "${input.branch}" into "${input.integrationBranch}" (HEAD is detached at ${short(input.tipSha)}).`,
    "",
    "Steps:",
    `  1. Run: git merge --squash ${input.branch}`,
    "  2. If there are conflicts, resolve them (favor the task's intent), then `git add` the resolved files.",
    "  3. Build a merge body from the staged squash diff:",
    "       - one short narrative summary line",
    "       - bullet list of key changes",
    "       - `Files changed:` + the output of `git diff --stat`",
    "  4. Commit the staged result as a SINGLE commit whose subject summarizes the",
    `     actual changes${input.taskTitle ? ` (task title hint: ${JSON.stringify(input.taskTitle)})` : ""}, including the body above and required trailers:`,
    `       git commit -m ${subjectShape} -m "<narrative + bullet list + Files changed: ...>"${trailerArgs}`,
    "     Keep the trailer line(s) verbatim — they link the commit to the board task.",
    "  5. Verify `git log --oneline ${tip}..HEAD` shows exactly one new commit and `git status` is clean.".replace("${tip}", short(input.tipSha)),
    "",
    "If `git merge --squash` reports the branch is already up to date (nothing to",
    "merge), do nothing and leave HEAD unchanged.",
  ];
  const userCommentsSection = buildUserCommentsPromptSection(input.userComments ?? []);
  if (userCommentsSection) {
    lines.push("", userCommentsSection);
  }
  if (input.correctiveReasons && input.correctiveReasons.length > 0) {
    lines.push(
      "",
      "A prior attempt was REJECTED by review. Redo the merge from the clean tip",
      "and address each of these problems:",
      ...input.correctiveReasons.map((r) => `  - ${r}`),
    );
  }
  return lines.join("\n");
}

export function buildReviewSystemPrompt(): string {
  return [
    "You are an adversarial, read-only merge reviewer. Do NOT edit, stage, commit,",
    "or run any mutating git command. Audit the squash commit that is about to be",
    "merged into the integration branch and decide whether it is safe to land.",
    "",
    "Investigate with read-only commands (git show, git diff, git log, cat, grep).",
    "Judge on four axes:",
    "  1. Completeness — does the squash contain ALL of the task branch's intended",
    "     changes? Flag any hunk silently dropped during conflict resolution.",
    "  2. No collateral — does it touch only files within the task's footprint?",
    "  3. Conflict soundness — were conflicts resolved coherently (both sides'",
    "     intent preserved), not by blindly discarding one side?",
    "  4. Commit message — read `git show`'s message: the subject must concisely",
    "     and ACCURATELY summarize the actual changes (not vague, not a mere",
    "     restatement of the task title, not misleading). A poor/inaccurate",
    "     message is an ADVISORY concern (it should be rewritten on retry, but",
    "     must not block the merge).",
    "",
    "Bias toward rejection when uncertain.",
    "",
    `End with a single decision line: "${REVIEW_VERDICT_MARKER} approve" or`,
    `"${REVIEW_VERDICT_MARKER} reject". When rejecting, add a "SEVERITY:" line:`,
    "  - SEVERITY: blocking — a correctness problem (dropped/lost task changes,",
    "    incomplete squash, or a conflict resolution that discards intent). The",
    "    merge must NOT land if this is unfixable.",
    "  - SEVERITY: advisory — a quality/style concern that does not risk",
    "    correctness; acceptable to land if unresolved.",
    "Then list each concrete reason as a bullet.",
  ].join("\n");
}

export function buildReviewPrompt(input: {
  taskId: string;
  branch: string;
  integrationBranch: string;
  tipSha: string;
  squashSha: string;
  diffStat: string;
  priorReasons?: string[];
  userComments?: TaskComment[];
}): string {
  const lines = [
    `Review the squash merge for task ${input.taskId} (branch ${input.branch} → ${input.integrationBranch}).`,
    "",
    `Integration tip: ${short(input.tipSha)}`,
    `Squash commit:   ${short(input.squashSha)}`,
    "",
    "Inspect with:",
    `  git show ${input.squashSha}`,
    `  git diff ${input.tipSha}..${input.squashSha}`,
    "",
    "Files changed (git diff --stat):",
    input.diffStat.trim() || "(none reported)",
  ];
  const userCommentsSection = buildUserCommentsPromptSection(input.userComments ?? []);
  if (userCommentsSection) {
    lines.push("", userCommentsSection);
  }
  if (input.priorReasons && input.priorReasons.length > 0) {
    lines.push(
      "",
      "A prior pass rejected an earlier attempt for these reasons — confirm they",
      "are now resolved:",
      ...input.priorReasons.map((r) => `  - ${r}`),
    );
  }
  return lines.join("\n");
}

export function buildStashResolveSystemPrompt(): string {
  return [
    "You are resolving a conflict between the user's restored local working-tree",
    "edits and the freshly-merged integration branch. The user's uncommitted work",
    "was stashed, the checkout fast-forwarded to the new tip, and re-applying the",
    "stash produced conflicts.",
    "",
    "Resolve every conflict marker so BOTH sides are preserved: keep the user's",
    "local intent AND the upstream changes that just landed. Stage each resolved",
    "file with `git add`.",
    "",
    "Do NOT commit, stash, reset, checkout a different branch, or run update-ref.",
    "Leave the resolved changes in the working tree as the user's uncommitted edits.",
  ].join("\n");
}

export function buildStashResolvePrompt(conflictedFiles: string[]): string {
  return [
    "Re-applying your stashed local changes onto the updated branch conflicted.",
    "",
    "Conflicted files:",
    ...conflictedFiles.map((f) => `  - ${f}`),
    "",
    "Resolve each file's conflict markers (preserve both the local edits and the",
    "upstream changes), then `git add` it. Do not commit.",
  ].join("\n");
}

function short(sha: string): string {
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 8) : sha;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Non-transient hard fail: the AI could not produce a correct merge within the
 *  review budget. The one path that does not land (shipping wrong code is worse). */
export class AiMergeBlockedError extends Error {
  readonly taskId: string;
  readonly reasons: string[];
  constructor(taskId: string, reasons: string[]) {
    super(`AI merge blocked ${taskId} (unresolved correctness concern): ${reasons.join("; ") || "no reason given"}`);
    this.name = "AiMergeBlockedError";
    this.taskId = taskId;
    this.reasons = reasons;
  }
}

// ---------------------------------------------------------------------------
// Agent runners (injectable for tests)
// ---------------------------------------------------------------------------

interface AgentDeps {
  /** Run the mutating merge agent in `cwd`. */
  mergeAgent?: (cwd: string, prompt: string) => Promise<void>;
  /** Run the read-only reviewer agent in `cwd`; returns its raw text. */
  reviewAgent?: (cwd: string, prompt: string) => Promise<string>;
  /** Run the mutating stash-conflict resolver in `cwd` (local checkout sync). */
  stashResolveAgent?: (cwd: string, prompt: string) => Promise<void>;
}

/** Factory for a mutating AI agent bound to a fixed system prompt. */
function makeMutatingAgent(store: TaskStore, settings: Settings, taskId: string, options: MergerOptions, audit: RunAuditor, systemPrompt: string) {
  return async (cwd: string, prompt: string): Promise<void> => {
    const model = resolveMergerSessionModel(settings);
    const logger = new AgentLogger({
      store,
      taskId,
      agent: "merger",
      persistAgentToolOutput: settings.persistAgentToolOutput,
      persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
      onAgentText: options.onAgentText
        ? (_id: string, delta: string) => options.onAgentText?.(delta)
        : undefined,
      onAgentTool: options.onAgentTool
        ? (_id: string, name: string) => options.onAgentTool?.(name)
        : undefined,
    });
    const { session } = await createResolvedAgentSession({
      sessionPurpose: "merger",
      pluginRunner: options.pluginRunner,
      cwd,
      systemPrompt,
      tools: "coding",
      onText: logger.onText,
      onThinking: logger.onThinking,
      onToolStart: logger.onToolStart,
      onToolEnd: logger.onToolEnd,
      defaultProvider: model.provider,
      defaultModelId: model.modelId,
      fallbackProvider: settings.fallbackProvider,
      fallbackModelId: settings.fallbackModelId,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      runAuditor: audit,
      settings,
      taskId,
    });
    options.onSession?.(session);
    try {
      await withRateLimitRetry(async () => {
        await promptWithFallback(session, prompt);
        checkSessionError(session);
      }, { signal: options.signal });
      await accumulateSessionTokenUsage(store, taskId, session);
    } finally {
      await logger.flush();
      session.dispose();
    }
  };
}

function makeReviewAgent(store: TaskStore, settings: Settings, taskId: string, options: MergerOptions, audit: RunAuditor) {
  return async (cwd: string, prompt: string): Promise<string> => {
    // The reviewer uses the project's validator/reviewer model lane (the same
    // one used elsewhere for review), falling back to the merger model only if
    // that lane resolves to nothing.
    const validator = resolveValidatorSettingsModel(settings);
    const model = validator.provider && validator.modelId ? validator : resolveMergerSessionModel(settings);
    let captured = "";
    const logger = new AgentLogger({
      store,
      taskId,
      agent: "merger",
      persistAgentToolOutput: settings.persistAgentToolOutput,
      persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
      onAgentText: options.onAgentText
        ? (_id: string, delta: string) => options.onAgentText?.(delta)
        : undefined,
      onAgentTool: options.onAgentTool
        ? (_id: string, name: string) => options.onAgentTool?.(name)
        : undefined,
    });
    const { session } = await createResolvedAgentSession({
      sessionPurpose: "merger",
      pluginRunner: options.pluginRunner,
      cwd,
      systemPrompt: buildReviewSystemPrompt(),
      tools: "coding",
      onText: (delta: string) => {
        captured += delta;
        logger.onText(delta);
      },
      onThinking: logger.onThinking,
      onToolStart: logger.onToolStart,
      onToolEnd: logger.onToolEnd,
      defaultProvider: model.provider,
      defaultModelId: model.modelId,
      fallbackProvider: settings.fallbackProvider,
      fallbackModelId: settings.fallbackModelId,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      runAuditor: audit,
      settings,
      taskId,
    });
    options.onSession?.(session);
    try {
      await withRateLimitRetry(async () => {
        await promptWithFallback(session, prompt);
        checkSessionError(session);
      }, { signal: options.signal });
      await accumulateSessionTokenUsage(store, taskId, session);
    } finally {
      await logger.flush();
      session.dispose();
    }
    return captured;
  };
}

// ---------------------------------------------------------------------------
// Local checkout sync
// ---------------------------------------------------------------------------

export type LocalSyncOutcome =
  | "ff"
  | "stash-ff-restore"
  | "stash-ff-airesolved"
  | "stash-ff-conflict"
  | "blocked-dirty-checkout"
  | "skipped-dirty-unstashable"
  | "skipped-other-branch";

export interface LandResult {
  /** "advanced" — the integration ref now points at the squash. "concurrent" —
   *  the target moved under us; the caller should rebuild on the new tip. */
  outcome: "advanced" | "concurrent";
  /** How the user's local checkout was reconciled (when on the target branch). */
  localSync: LocalSyncOutcome;
}

async function hasUnresolvedConflicts(cwd: string): Promise<boolean> {
  return (await git(["ls-files", "-u"], cwd)).length > 0;
}

/**
 * Land the squash on the integration branch and bring the user's checkout with
 * it. Two cases:
 *
 *   A. The user's checkout IS on the target branch (HEAD === tipSha). We
 *      advance the ref AND sync the working tree in one safe step from that
 *      checkout — `git merge --ff-only <squash>` (it moves both the branch ref
 *      and the working tree). The user's real dirty state is read accurately
 *      BEFORE the fast-forward (while HEAD === tipSha, so `git status` isn't
 *      polluted by the ref move). By default a dirty checked-out integration
 *      worktree is a hard blocker; callers must explicitly opt into stash/pop
 *      reconciliation. If the checkout HEAD has already moved off tipSha,
 *      that's a concurrent advance → rebuild.
 *
 *   B. The checkout is on a different branch (or the target isn't checked out
 *      here). We advance the ref atomically via `update-ref` (CAS) and leave the
 *      user's checkout alone.
 *
 * Uncommitted work is never destroyed: an unresolvable restore leaves the user's
 * edits in a stash with a warning.
 */
export async function landSquash(input: {
  projectRootDir: string;
  mergeRoot: string;
  integrationBranch: string;
  tipSha: string;
  squashSha: string;
  taskId: string;
  audit: RunAuditor;
  resolveConflicts?: (cwd: string, prompt: string) => Promise<void>;
  /**
   * Explicit escape hatch for callers that truly want Fusion to stash/pop real
   * local edits in the checked-out integration worktree. The default is false:
   * automation must not land a task while also manufacturing uncommitted local
   * state in the project root, because that poisons subsequent merge runs.
   */
  allowDirtyLocalCheckoutSync?: boolean;
}): Promise<LandResult> {
  const { projectRootDir, mergeRoot, integrationBranch, tipSha, squashSha, taskId, audit, resolveConflicts, allowDirtyLocalCheckoutSync = false } = input;
  const emit = (outcome: LocalSyncOutcome, extra: Record<string, unknown> = {}) =>
    audit.git({ type: "merge:ai-local-sync", target: integrationBranch, metadata: { taskId, outcome, squashSha, ...extra } }).catch(() => undefined);

  const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], projectRootDir).catch(() => "");

  // Case B — target not checked out here: bare CAS ref advance.
  if (currentBranch !== integrationBranch) {
    const adv = await advanceIntegrationBranchRef({
      rootDir: mergeRoot, projectRootDir, integrationBranch,
      newSha: squashSha, expectedCurrentSha: tipSha, taskId, audit,
    });
    if (!adv.advanced) {
      if (adv.reason === "concurrent-advance" || adv.reason === "non-fast-forward-advance") {
        return { outcome: "concurrent", localSync: "skipped-other-branch" };
      }
      throw new Error(`AI merge could not advance ${integrationBranch} for ${taskId}: ${adv.reason} (${adv.diagnostic})`);
    }
    await emit("skipped-other-branch", { currentBranch });
    return { outcome: "advanced", localSync: "skipped-other-branch" };
  }

  // Case A — checkout is on the target branch. Read real dirty state NOW, while
  // HEAD === tipSha (accurate; not yet polluted by the ref move).
  const head = await git(["rev-parse", "HEAD"], projectRootDir).catch(() => "");
  if (head !== tipSha) {
    // The checkout already moved off the tip we built on — concurrent advance.
    return { outcome: "concurrent", localSync: "skipped-other-branch" };
  }
  const dirty = (await git(["status", "--porcelain"], projectRootDir)).length > 0;
  if (dirty && !allowDirtyLocalCheckoutSync) {
    await emit("blocked-dirty-checkout", { reason: "dirty-integration-checkout" });
    throw new Error(
      `AI merge for ${taskId}: dirty integration checkout on ${integrationBranch}; refusing to land onto a dirty project root. `
      + `Commit, stash, or clean local changes before retrying.`,
    );
  }
  const stashed = dirty
    ? await gitOk(["stash", "push", "--include-untracked", "-m", `fusion-ai-merge-sync-${taskId}`], projectRootDir)
    : false;

  if (dirty && !stashed) {
    // The dirty state couldn't be stashed (e.g. untracked/tracked collision or a
    // stash hook failure). Don't risk `merge --ff-only` aborting/clobbering:
    // advance the ref atomically and leave the user's working tree as-is.
    const adv = await advanceIntegrationBranchRef({
      rootDir: mergeRoot, projectRootDir, integrationBranch,
      newSha: squashSha, expectedCurrentSha: tipSha, taskId, audit,
    });
    if (!adv.advanced) {
      if (adv.reason === "concurrent-advance" || adv.reason === "non-fast-forward-advance") {
        return { outcome: "concurrent", localSync: "skipped-dirty-unstashable" };
      }
      throw new Error(`AI merge could not advance ${integrationBranch} for ${taskId}: ${adv.reason} (${adv.diagnostic})`);
    }
    aiMergeLog.warn(`${taskId}: local checkout has un-stashable dirty state — advanced ${integrationBranch} without syncing your working tree; pull manually.`);
    await emit("skipped-dirty-unstashable");
    return { outcome: "advanced", localSync: "skipped-dirty-unstashable" };
  }

  // Fast-forward the checkout (and the branch ref) to the squash.
  if (!(await gitOk(["merge", "--ff-only", squashSha], projectRootDir))) {
    if (stashed) await gitOk(["stash", "pop"], projectRootDir); // restore the user's edits
    return { outcome: "concurrent", localSync: "skipped-other-branch" };
  }

  if (!stashed) {
    await emit("ff");
    return { outcome: "advanced", localSync: "ff" };
  }

  // Re-apply the user's stashed edits onto the new tip.
  if (await gitOk(["stash", "pop"], projectRootDir)) {
    await emit("stash-ff-restore");
    return { outcome: "advanced", localSync: "stash-ff-restore" };
  }

  // Restore conflicted — let the AI merger reconcile the user's edits with the
  // upstream changes in the working tree.
  if (resolveConflicts) {
    const conflicted = (await git(["diff", "--name-only", "--diff-filter=U"], projectRootDir)).split("\n").map((l) => l.trim()).filter(Boolean);
    try {
      await resolveConflicts(projectRootDir, buildStashResolvePrompt(conflicted));
    } catch (err: unknown) {
      aiMergeLog.warn(`${taskId}: AI stash-conflict resolver threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!(await hasUnresolvedConflicts(projectRootDir))) {
      await gitOk(["reset"], projectRootDir); // unstage → reads as the user's uncommitted edits
      // Keep the stash as a recovery backup (do NOT drop it): if the AI
      // resolution discarded any of the user's intent, their original pre-merge
      // edits remain recoverable via `git stash`. Honors "never destroy work".
      aiMergeLog.log(`${taskId}: reconciled your local edits with the new tip; original pre-merge edits also kept in a stash as a backup (\`git stash list\`).`);
      await emit("stash-ff-airesolved", { conflicted, stashRetained: true });
      return { outcome: "advanced", localSync: "stash-ff-airesolved" };
    }
  }

  aiMergeLog.warn(`${taskId}: restoring your local changes onto the new tip conflicted and could not be auto-resolved. Your work is preserved in the stash (\`git stash list\`); re-apply with \`git stash pop\` and resolve manually.`);
  await emit("stash-ff-conflict");
  return { outcome: "advanced", localSync: "stash-ff-conflict" };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function noOpResult(task: Task, branch: string, reason: string): MergeResult {
  return {
    task,
    branch,
    merged: false,
    noOp: true,
    ok: true,
    reason,
    worktreeRemoved: false,
    branchDeleted: false,
  };
}

export async function runAiMerge(
  store: TaskStore,
  projectRootDir: string,
  taskId: string,
  options: MergerOptions = {},
  deps: AgentDeps = {},
): Promise<MergeResult> {
  const task = await store.getTask(taskId);
  // FNXC:MergerUnification 2026-06-21-19:05:
  // Chokepoint R7 guard. runAiMerge is the SOLE merge path (master-plan U0), so it
  // self-enforces the workspace merge-boundary here — immediately after the task read
  // and BEFORE any git work — even if a door's pre-read was skipped/swallowed or a
  // direct importer calls runAiMerge without the door-level guard. Throws the named
  // WorkspaceTaskMergeError; the door guards remain as fast-fail defense-in-depth.
  assertNotWorkspaceTaskMerge(task);
  const branch = resolveTaskWorkingBranch(task);

  if (task.column === "done" || task.column === "archived") {
    return noOpResult(task, branch, "already-finalized");
  }
  const blocker = getTaskMergeBlocker(task, { manual: options.manual === true });
  if (blocker) throw new Error(`Cannot merge ${taskId}: ${blocker}`);

  const settings = await store.getSettings();
  // Honor the task's own target branch when set; otherwise the project default
  // integration branch. The local checkout is only synced if it is on this same
  // target branch (see syncLocalCheckout).
  const projectDefaultBranch = await resolveIntegrationBranch(projectRootDir, settings);
  const mergeTarget = resolveTaskMergeTarget(task, { projectDefaultBranch });
  const integrationBranch = mergeTarget.branch;
  const audit = createRunAuditor(store, {
    runId: generateSyntheticRunId("ai-merge", taskId),
    agentId: "merger",
    taskId,
    phase: "merge",
  });

  // Surface progress on the task detail (status pill) + the task log stream.
  const log = async (message: string): Promise<void> => {
    await store.logEntry(taskId, message, "AiMerge").catch(() => undefined);
    await store.appendAgentLog(taskId, message, "text", undefined, "merger").catch(() => undefined);
  };
  const setStatus = (status: string | null): Promise<unknown> =>
    store.updateTask(taskId, { status }).catch(() => undefined);

  // Branch must exist to merge it.
  if (!(await gitOk(["rev-parse", "--verify", `refs/heads/${branch}`], projectRootDir))) {
    // A missing branch is benign in two cases — the task was never executed
    // (nothing to merge), or it already merged and the branch was cleaned up
    // (a re-processed task). But if the task WAS executed (a baseCommitSha was
    // recorded when it got a worktree) and was NEVER merged (no recorded
    // landing), the branch should still exist — its work appears lost. Fail
    // loudly rather than silently marking the task done.
    const wasExecuted = !!task.baseCommitSha;
    const alreadyMerged = task.mergeDetails?.mergeConfirmed === true || !!task.mergeDetails?.commitSha;
    if (wasExecuted && !alreadyMerged) {
      await audit.git({
        type: "merge:ai-no-branch",
        target: branch,
        metadata: { taskId, kind: "executed-branch-missing", baseCommitSha: task.baseCommitSha },
      });
      throw new Error(
        `AI merge for ${taskId}: branch "${branch}" is missing, but the task was executed `
        + `(baseCommitSha ${String(task.baseCommitSha).slice(0, 8)}) and has no recorded merge — its work appears lost. `
        + `Not finalizing; investigate.`,
      );
    }
    await audit.git({
      type: "merge:ai-no-branch",
      target: branch,
      metadata: { taskId, kind: alreadyMerged ? "already-merged" : "never-executed" },
    });
    return await finalizeTask(store, taskId, noOpResult(task, branch, alreadyMerged ? "already-merged" : "no-branch"));
  }

  // The target branch must exist as a LOCAL ref to merge into it — surface a
  // clear error rather than a cryptic `fatal: Needed a single revision` if a
  // task targets a remote-only / mistyped branch.
  if (!(await gitOk(["rev-parse", "--verify", `refs/heads/${integrationBranch}`], projectRootDir))) {
    await audit.git({ type: "merge:ai-no-branch", target: integrationBranch, metadata: { taskId, kind: "integration-branch-missing" } });
    throw new Error(`AI merge for ${taskId}: target branch "${integrationBranch}" has no local ref (refs/heads/${integrationBranch}). Create or check out the branch locally before merging.`);
  }

  const maxPasses = Math.max(0, Math.trunc(settings.merger?.maxReviewPasses ?? 3));
  const mergeAgent = deps.mergeAgent ?? makeMutatingAgent(store, settings, taskId, options, audit, buildMergeSystemPrompt(settings.agentPrompts));
  const reviewAgent = deps.reviewAgent ?? makeReviewAgent(store, settings, taskId, options, audit);
  const stashResolveAgent = deps.stashResolveAgent ?? makeMutatingAgent(store, settings, taskId, options, audit, buildStashResolveSystemPrompt());
  const includeTaskId = settings.includeTaskIdInCommit !== false;
  // Trailers that link the squash commit to the board task (FN-id + lineage).
  const trailers = taskTrailers(taskId, task.lineageId);
  const taskTitle = task.title?.trim() ? task.title.split("\n")[0] : undefined;

  await setStatus("merging");
  try {
    const pruned = await pruneExistingAiMergeWorktrees(taskId, projectRootDir, audit, log, settings);
    if (pruned > 0) await log(`AI merge: pruned ${pruned} pre-existing worktree(s) for ${taskId}`);
  } catch (err: unknown) {
    await log(`AI merge: pre-merge prune failed: ${getErrorMessage(err)}`);
  }
  let advanceRetries = 0;
  while (true) {
    throwIfAborted(options.signal, taskId);
    const tipSha = await git(["rev-parse", "--verify", `refs/heads/${integrationBranch}`], projectRootDir);

    // 1. Clean-room worktree at the integration tip.
    let mergeRoot: string | undefined;
    let worktreeAdded = false;
    const registeredMergePaths = new Set<string>();
    const registerMergeRoot = (pathToRegister: string): void => {
      if (registeredMergePaths.has(pathToRegister)) return;
      activeSessionRegistry.registerPath(pathToRegister, { taskId, kind: "ai-merge", ownerKey: `ai-merge:${taskId}` });
      registeredMergePaths.add(pathToRegister);
    };
    try {
      mergeRoot = await mkdtemp(join(resolveAiMergeRoot(projectRootDir, settings), `fusion-ai-merge-${taskId.toLowerCase()}-`));
      /*
       * FNXC:AIMerge 2026-06-14-16:36:
       * The AI-merge clean-room directory must be created and registered inside the cleanup guard. Any terminal path or interrupt after `mkdtemp`, including active-session registration failure before `git worktree add`, must still unregister known paths and remove the `fusion-ai-merge-*` directory.
       */
      // Register the repo-local clean-room path as soon as it exists, before
      // `git worktree add`, so self-healing/pre-merge sweeps cannot reap a
      // just-created clean room in the small window before canonical registration
      // is available.
      registerMergeRoot(mergeRoot);
      await git(["worktree", "add", "--detach", mergeRoot, tipSha], projectRootDir);
      worktreeAdded = true;
      let canonicalMergeRoot = mergeRoot;
      try {
        canonicalMergeRoot = realpathSync(mergeRoot);
      } catch {
        canonicalMergeRoot = mergeRoot;
      }
      for (const pathToRegister of new Set([canonicalMergeRoot, mergeRoot])) {
        registerMergeRoot(pathToRegister);
      }
      await audit.git({ type: "merge:ai-clean-room", target: integrationBranch, metadata: { taskId, tipSha, mergeRoot } });
      await log(`AI merge: merging ${branch} into ${integrationBranch} (clean room at ${short(tipSha)})${advanceRetries ? ` — retry ${advanceRetries} after concurrent advance` : ""}`);

      /*
       * FNXC:AIMerge 2026-06-13-20:32:
       * The detached AI-merge clean room is rebuilt from the integration tip and starts without workspace dependencies. Hard-fail configured or inferred install failures so verification cannot silently run against an uninstalled checkout; aborts propagate before merge agents run.
       */
      const depsSyncStartedAt = Date.now();
      const depsSyncResult = await installWorktreeDependencies({
        cwd: canonicalMergeRoot,
        settings,
        taskId,
        signal: options.signal,
        context: "for AI merge clean room",
        logger: aiMergeLog,
        log,
      });
      await audit.git({
        type: "merge:ai-deps-sync",
        target: integrationBranch,
        metadata: {
          taskId,
          tipSha,
          mergeRoot: canonicalMergeRoot,
          installCommand: depsSyncResult.installCommand,
          configured: depsSyncResult.configured,
          skipped: depsSyncResult.skipped,
          skipReason: depsSyncResult.skipReason,
          durationMs: depsSyncResult.durationMs,
        },
      });
      await log(`[timing] AI merge dependency sync completed in ${Date.now() - depsSyncStartedAt}ms${depsSyncResult.installCommand ? ` (${depsSyncResult.skipped ? "skipped" : "ran"}: ${depsSyncResult.installCommand})` : " (no command)"}`);

      // 2 + 3. Merge + review loop (corrective passes).
      const squashSha = await mergeAndReview({
        mergeRoot, branch, integrationBranch, tipSha, taskTitle, includeTaskId, trailers, taskId,
        maxPasses, mergeAgent, reviewAgent, audit, log, setStatus, store, signal: options.signal,
      });

      if (!squashSha) {
        // Branch had no net changes vs the tip — nothing to land.
        await audit.git({ type: "merge:ai-empty", target: integrationBranch, metadata: { taskId, tipSha } });
        const noCommitsFinalize = evaluateNoCommitsNoOpFinalize(task);
        if (noCommitsFinalize.blocked) {
          const reason = noCommitsFinalize.reason ?? "no-commits task has incomplete work with no net branch changes";
          /*
           * FNXC:Lifecycle 2026-06-14-20:02:
           * FN-6461/FN-6455 requires the AI empty-merge lane to demote no-commits tasks whose skipped/incomplete steps outweigh done steps instead of finalizing the operational work as done.
           */
          await store.updateTask(taskId, { error: reason });
          await store.logEntry(
            taskId,
            `Finalize blocked (no-commits incomplete-work guard): ${reason} — moving back to todo with progress preserved`,
            JSON.stringify({
              doneCount: noCommitsFinalize.doneCount,
              incompleteCount: noCommitsFinalize.incompleteCount,
              branch,
              integrationBranch,
              lane: "ai-empty-merge",
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
              integrationBranch,
              lane: "ai-empty-merge",
            },
          });
          await store.moveTask(taskId, "todo", { preserveProgress: true, moveSource: "engine" } as Parameters<TaskStore["moveTask"]>[2]);
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
        await log(`AI merge: ${branch} had no net changes vs ${integrationBranch} — finalizing as no-op`);
        return await finalizeMerged(store, projectRootDir, taskId, task, branch, integrationBranch, tipSha, audit, log, { empty: true });
      }

      // 4 + 5. Land the squash on the target branch and sync the user's
      //        checkout (AI reconciles a conflicting restore).
      await setStatus("landing");
      const landed = await landSquash({
        projectRootDir, mergeRoot, integrationBranch, tipSha, squashSha, taskId, audit,
        resolveConflicts: stashResolveAgent,
        allowDirtyLocalCheckoutSync: options.allowDirtyLocalCheckoutSync === true,
      });
      if (landed.outcome === "concurrent") {
        if (advanceRetries < MAX_CONCURRENT_ADVANCE_RETRIES) {
          advanceRetries++;
          await log(`AI merge: ${integrationBranch} moved during merge — rebuilding on new tip (retry ${advanceRetries})`);
          continue; // rebuild the clean room on the new tip
        }
        throw new Error(`AI merge could not advance ${integrationBranch} for ${taskId} after ${advanceRetries} retries (concurrent advances)`);
      }
      await log(`AI merge: advanced ${integrationBranch} → ${short(squashSha)} (local checkout: ${landed.localSync})`);
      return await finalizeMerged(store, projectRootDir, taskId, task, branch, integrationBranch, squashSha, audit, log, { empty: false });
    } finally {
      for (const registeredPath of registeredMergePaths) {
        activeSessionRegistry.unregisterPath(registeredPath);
      }
      if (mergeRoot) {
        await cleanupAiMergeWorktree({ taskId, mergeRoot, projectRootDir, worktreeAdded, audit, log });
      }
    }
  }
}

async function mergeAndReview(input: {
  mergeRoot: string;
  branch: string;
  integrationBranch: string;
  tipSha: string;
  taskTitle?: string;
  includeTaskId: boolean;
  trailers: string[];
  taskId: string;
  maxPasses: number;
  mergeAgent: (cwd: string, prompt: string) => Promise<void>;
  reviewAgent: (cwd: string, prompt: string) => Promise<string>;
  audit: RunAuditor;
  log: (message: string) => Promise<void>;
  setStatus: (status: string | null) => Promise<unknown>;
  store: TaskStore;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { mergeRoot, branch, integrationBranch, tipSha, taskTitle, includeTaskId, trailers, taskId, maxPasses, mergeAgent, reviewAgent, audit, log, setStatus, store, signal } = input;
  let priorReasons: string[] = [];

  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal, taskId);
    // Reset the clean room to the tip before each (re)merge so corrective passes
    // start from a known-good base, not a half-resolved tree.
    await git(["reset", "--hard", tipSha], mergeRoot);
    await git(["clean", "-fd"], mergeRoot);

    if (attempt > 0) {
      await setStatus("merging");
      await log(`AI merge: corrective re-merge (pass ${attempt}/${maxPasses}) addressing: ${priorReasons.join("; ")}`);
    }
    const latestTaskForMergePrompt = await store.getTask(taskId);
    const mergeUserComments = selectUserCommentsForAgentContext(latestTaskForMergePrompt);
    await mergeAgent(mergeRoot, buildMergePrompt({
      taskId, branch, integrationBranch, tipSha, taskTitle, includeTaskId, trailers,
      correctiveReasons: priorReasons.length ? priorReasons : undefined,
      userComments: mergeUserComments,
    }));

    let head = await git(["rev-parse", "HEAD"], mergeRoot);
    if (head === tipSha) return null; // empty merge — nothing landed

    // Guarantee the squash's task metadata (task-id subject prefix + board
    // association trailers) even if the agent omitted it — this amends HEAD, so
    // re-read the sha afterwards.
    await ensureCommitTaskMetadata(mergeRoot, taskId, includeTaskId, trailers);
    head = await git(["rev-parse", "HEAD"], mergeRoot);

    await setStatus("reviewing");
    const diffStat = await git(["diff", "--stat", `${tipSha}..${head}`], mergeRoot);
    const latestTaskForReviewPrompt = await store.getTask(taskId);
    const reviewUserComments = selectUserCommentsForAgentContext(latestTaskForReviewPrompt);
    const verdict = parseReviewVerdict(await reviewAgent(mergeRoot, buildReviewPrompt({
      taskId, branch, integrationBranch, tipSha, squashSha: head, diffStat, priorReasons,
      userComments: reviewUserComments,
    })));
    await audit.git({
      type: "merge:ai-review-verdict",
      target: integrationBranch,
      metadata: { taskId, attempt, verdict: verdict.verdict, severity: verdict.severity, reasons: verdict.reasons, squashSha: head },
    });

    if (verdict.verdict === "approve") {
      await log(`AI merge review (pass ${attempt + 1}): approved`);
      return head;
    }

    const budgetExhausted = attempt >= maxPasses;
    if (budgetExhausted) {
      if (verdict.severity === "blocking") {
        await audit.git({ type: "merge:ai-review-blocked", target: integrationBranch, metadata: { taskId, attempt, reasons: verdict.reasons } });
        await log(`AI merge BLOCKED after ${attempt} corrective pass(es) — unresolved correctness concern: ${verdict.reasons.join("; ")}`);
        throw new AiMergeBlockedError(taskId, verdict.reasons);
      }
      // Advisory: land the squash with the concern logged.
      await audit.git({ type: "merge:ai-review-landed-with-concerns", target: integrationBranch, metadata: { taskId, attempt, reasons: verdict.reasons, squashSha: head } });
      await log(`AI merge: landing with unresolved advisory concern(s): ${verdict.reasons.join("; ")}`);
      return head;
    }

    priorReasons = verdict.reasons;
    await log(`AI merge review (pass ${attempt + 1}): rejected (${verdict.severity}) — ${verdict.reasons.join("; ")}`);
  }
}

async function finalizeMerged(
  store: TaskStore,
  projectRootDir: string,
  taskId: string,
  task: Task,
  branch: string,
  integrationBranch: string,
  landedSha: string,
  audit: RunAuditor,
  log: (message: string) => Promise<void>,
  opts: { empty: boolean },
): Promise<MergeResult> {
  let mergeDetails: MergeDetails | undefined;
  let modifiedFiles: string[] | undefined;
  if (!opts.empty && landedSha) {
    const [{ landedFiles: capturedLandedFiles, filesChanged, insertions, deletions }, mergeCommitMessage] = await Promise.all([
      captureSingleCommitLandedMetadata(projectRootDir, landedSha),
      git(["log", "-1", "--format=%s", landedSha], projectRootDir).catch(() => ""),
    ]);
    const landedFiles = capturedLandedFiles ?? [];
    const mergedAt = new Date().toISOString();
    mergeDetails = {
      commitSha: landedSha,
      landedFiles,
      filesChanged,
      insertions,
      deletions,
      mergeCommitMessage: mergeCommitMessage || undefined,
      mergedAt,
      mergeConfirmed: true,
      prNumber: getPrimaryPrInfo(task)?.number,
    };
    modifiedFiles = landedFiles.length > 0 ? landedFiles : undefined;
    await store.updateTask(taskId, { mergeDetails, modifiedFiles });
    task.mergeDetails = mergeDetails;
    task.modifiedFiles = modifiedFiles;
    if (task.lineageId && typeof (store as Partial<TaskStore>).upsertTaskCommitAssociation === "function") {
      await store.upsertTaskCommitAssociation({
        taskLineageId: task.lineageId,
        taskIdSnapshot: task.id,
        commitSha: landedSha,
        commitSubject: mergeCommitMessage || task.title || task.id,
        authoredAt: mergedAt,
        matchedBy: "canonical-lineage-trailer",
        confidence: "canonical",
        additions: insertions,
        deletions,
      }).catch(() => undefined);
    }
  }
  let branchDeleted = false;
  // NEVER delete the integration branch itself — a task whose branch name
  // coincides with the target (or merges into its own branch) must not have the
  // just-advanced integration ref force-deleted out from under it.
  if (branch !== integrationBranch && await gitOk(["branch", "-D", branch], projectRootDir)) {
    branchDeleted = true;
    await audit.git({ type: "branch:delete", target: branch, metadata: { taskId, force: true } }).catch(() => undefined);
  }
  // Remove the task's own worktree if it still exists.
  let worktreeRemoved = false;
  if (task.worktree) {
    worktreeRemoved = await gitOk(["worktree", "remove", "--force", task.worktree], projectRootDir);
    await store.updateTask(taskId, { worktree: null }).catch(() => undefined);
  }

  const result: MergeResult = {
    task,
    branch,
    merged: !opts.empty,
    noOp: opts.empty,
    ok: true,
    reason: opts.empty ? "no-net-changes" : undefined,
    commitSha: opts.empty ? undefined : mergeDetails?.commitSha ?? landedSha,
    mergeConfirmed: !opts.empty,
    worktreeRemoved,
    branchDeleted,
  };
  await audit.git({ type: "merge:ai-landed", target: integrationBranch, metadata: { taskId, landedSha, empty: opts.empty } }).catch(() => undefined);
  await log(opts.empty ? `AI merge: finalized ${taskId} (no-op), finalizing task row` : `AI merge: landed ${short(landedSha)}, finalizing task row`);
  const finalized = await finalizeTask(store, taskId, result, audit, log);
  await log(opts.empty ? `AI merge: finalized ${taskId} (no-op) → done` : `AI merge: landed ${short(landedSha)}, task → done`);
  return finalized;
}

/** Move the task to done and emit, mirroring the legacy completeTask. */
async function finalizeTask(
  store: TaskStore,
  taskId: string,
  result: MergeResult,
  audit?: RunAuditor,
  log?: (message: string) => Promise<void>,
): Promise<MergeResult> {
  const finalization = await finalizeProvenAutoMergeTask({
    store,
    taskId,
    result,
    audit,
    auditAgentId: "merger",
    auditPhase: "direct-ai-merge-finalize",
    source: "direct-ai-merge",
    log,
  });
  if (finalization.outcome === "blocked") {
    throw new Error(`AI merge finalization blocked for ${taskId}: ${finalization.reason ?? "unknown"}`);
  }
  if (!finalization.task) {
    throw new Error(`AI merge finalization could not find task ${taskId}`);
  }
  result.task = finalization.task;
  store.emit("task:merged", result);
  return result;
}

function throwIfAborted(signal: AbortSignal | undefined, taskId: string): void {
  if (signal?.aborted) {
    const err = new Error(`AI merge aborted for ${taskId}`);
    err.name = "MergeAbortedError";
    throw err;
  }
}
