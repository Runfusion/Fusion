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
 *   5. Sync the user's local checkout to the new tip. Resolved project settings
 *      now default to the legacy dirty-checkout stash → ff → restore path, while
 *      an explicit project opt-out can still fail closed before the branch ref
 *      advances.
 *
 * Pure helpers (prompt builders, verdict parser) are exported for unit testing;
 * the orchestrator accepts injectable agent functions for the same reason.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNotWorkspaceTaskMerge,
  buildTaskLineageTrailer,
  evaluateNoCommitsNoOpFinalize,
  getPrimaryPrInfo,
  getTaskMergeBlocker,
  normalizeMergeAdvanceAutoSyncMode,
  resolvePersistAgentThinkingLog,
  resolveTaskMergeTarget,
  resolveValidatorSettingsModel,
  resolveMergerFallbackModel,
  type MergeDetails,
  type MergeResult,
  type MergeTargetResolution,
  type Settings,
  type Task,
  type TaskStore,
} from "@fusion/core";
import { selectUserCommentsForAgentContext } from "./agent-user-comments.js";
import { resolveTaskWorkingBranch } from "./worktree-names.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import { advanceIntegrationBranchRef } from "./merger-ref-update-advance.js";
import { createResolvedAgentSession, resolveMergerSessionModel, resolveMergerThinkingLevel, resolveMergerFallbackThinkingLevel, resolveValidatorThinkingLevel } from "./agent-session-helpers.js";
import { promptWithFallback } from "./pi.js";
import { AgentLogger } from "./agent-logger.js";
import { withRateLimitRetry } from "./rate-limit-retry.js";
import { checkSessionError } from "./usage-limit-detector.js";
import { accumulateSessionTokenUsage } from "./session-token-usage.js";
import { createRunAuditor, generateSyntheticRunId, type RunAuditor } from "./run-audit.js";
import { createLogger } from "./logger.js";
import {
  buildAutostashLabel,
  captureSingleCommitLandedMetadata,
  isNonFastForwardPushError,
  parsePushRemoteTarget,
  pushToRemoteAfterMerge,
  runMergeAdvanceAutoSync,
  syncGroupPrOnLanding,
  type MergerOptions,
} from "./merger.js";
import { resolveBranchGroupMergeRouting, type BranchGroupMergeRouting, type SyncGroupPrFn } from "./group-merge-coordinator.js";
import { DEFAULT_COMMIT_AUTHOR_EMAIL, DEFAULT_COMMIT_AUTHOR_NAME } from "./worktree-hooks.js";
import { installWorktreeDependencies } from "./merge-dependency-sync.js";
import { activeSessionRegistry } from "./active-session-registry.js";
import { resolveMcpServersForStore } from "./mcp-resolution.js";
/*
FNXC:Workspace 2026-06-22-14:10 (Phase D review G — cycle dissolved):
`isRepoLanded` + `FUSION_TASK_ID_TRAILER_KEY` moved to the dependency-free `workspace-land-predicate`
module so self-healing can import the predicate without re-entering the self-healing ↔ merger-ai
import cycle (merger-ai-worktree imports `MIN_TEMP_WORKTREE_REAP_AGE_MS` from self-healing).
*/
import { isRepoLanded, findProvenLandedCommit, FUSION_TASK_ID_TRAILER_KEY } from "./workspace-land-predicate.js";
import { finalizeProvenAutoMergeTask } from "./auto-merge-finalization.js";
import { getCommitTaskOwnership } from "./already-merged-detector.js";
import { resolveLegacyAiMergeRootPath } from "./worktree-paths.js";
import {
  cleanupAiMergeWorktree,
  pruneExistingAiMergeWorktrees,
  resolveAiMergeRoot,
} from "./merger-ai-worktree.js";
import {
  buildMergePrompt,
  buildMergeSystemPrompt,
  buildReviewPrompt,
  buildReviewSystemPrompt,
  buildStashResolvePrompt,
  buildStashResolveSystemPrompt,
  parseReviewVerdict,
} from "./merger-ai-prompts.js";

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

function short(sha: string): string {
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 8) : sha;
}

function getApprovedAiMergeReviewShas(task: Task | undefined): Set<string> {
  const shas = new Set<string>();
  for (const entry of task?.log ?? []) {
    if (typeof entry.action !== "string") continue;
    const match = entry.action.match(/AI merge review \(pass \d+\): approved(?:\s+(?:squash|commit)\s+([0-9a-f]{7,40}))?/i);
    if (match?.[1]) shas.add(match[1].toLowerCase());
  }
  return shas;
}

function taskHasApprovedAiMergeReview(task: Task | undefined): boolean {
  return (task?.log ?? []).some((entry) =>
    typeof entry.action === "string"
    && /AI merge review \(pass \d+\): approved/.test(entry.action)
  );
}

function matchesApprovedAiMergeSha(squashSha: string, approvedShas: Set<string>): boolean {
  if (approvedShas.size === 0) return true;
  const normalized = squashSha.toLowerCase();
  return Array.from(approvedShas).some((approved) => normalized === approved || normalized.startsWith(approved) || approved.startsWith(normalized));
}

type PreexistingAiMergeRecoveryCandidate = {
  mergeRoot: string;
  squashSha: string;
  tipSha: string;
  alreadyLanded: boolean;
};

function listAiMergeWorktreeCandidates(taskId: string, projectRootDir: string, settings?: Settings): string[] {
  const prefix = `fusion-ai-merge-${taskId.toLowerCase()}-`;
  const roots = Array.from(new Set([resolveAiMergeRoot(projectRootDir, settings), resolveLegacyAiMergeRootPath(projectRootDir), tmpdir()]));
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
  const candidates: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root).filter((entry) => entry.startsWith(prefix));
    } catch {
      continue;
    }
    for (const entry of entries) candidates.push(join(root, entry));
  }
  return candidates;
}

async function recoverApprovedPreexistingAiMergeWorktree(
  repoRootDir: string,
  integrationBranch: string,
  ctx: LandRepoContext,
): Promise<LandOneRepoResult | null> {
  const { taskId, settings, store, audit, log, allowDirtyLocalCheckoutSync, stashResolveAgent, signal } = ctx;
  throwIfAborted(signal, taskId);
  const task = await store.getTask(taskId).catch(() => undefined);
  if (!taskHasApprovedAiMergeReview(task)) return null;

  const approvedShas = getApprovedAiMergeReviewShas(task);
  const tipSha = await git(["rev-parse", "--verify", `refs/heads/${integrationBranch}`], repoRootDir);
  const recoverableCandidates: PreexistingAiMergeRecoveryCandidate[] = [];
  for (const candidate of listAiMergeWorktreeCandidates(taskId, repoRootDir, settings)) {
    let mergeRoot = candidate;
    try { mergeRoot = realpathSync(candidate); } catch { /* keep original */ }
    if (activeSessionRegistry.isPathActive(candidate) || activeSessionRegistry.isPathActive(mergeRoot)) continue;

    try {
      throwIfAborted(signal, taskId);
      const squashSha = await git(["rev-parse", "--verify", "HEAD"], mergeRoot);
      if (!squashSha || squashSha === tipSha) continue;
      if (!matchesApprovedAiMergeSha(squashSha, approvedShas)) continue;
      const show = await git(["show", "-s", "--format=%s%x1f%b", squashSha], mergeRoot);
      const [subject = "", body = ""] = show.split("\x1f");
      if (!getCommitTaskOwnership(taskId, task?.lineageId, subject, body).owned) continue;

      const alreadyLanded = await gitOk(["merge-base", "--is-ancestor", squashSha, `refs/heads/${integrationBranch}`], repoRootDir);
      const tipIsAncestor = await gitOk(["merge-base", "--is-ancestor", tipSha, squashSha], repoRootDir);
      if (!alreadyLanded && !tipIsAncestor) continue;
      recoverableCandidates.push({ mergeRoot, squashSha, tipSha, alreadyLanded });
    } catch (err: unknown) {
      await log(`AI merge: skipped pre-existing clean-room recovery candidate ${mergeRoot}: ${getErrorMessage(err)}`);
    }
  }

  /*
  FNXC:AIMergeRecovery 2026-07-10-23:06:
  Approved clean-room recovery must bind the candidate commit to the reviewed squash. New review logs carry the squash SHA; legacy logs without a SHA can recover only when exactly one same-task candidate is possible, otherwise recovery defers to the normal merge path rather than finalizing the wrong clean room.
  */
  if (recoverableCandidates.length !== 1) {
    if (recoverableCandidates.length > 1) {
      await log(`AI merge: skipped pre-existing clean-room recovery because ${recoverableCandidates.length} same-task approved candidates were ambiguous`);
    }
    return null;
  }

  const selected = recoverableCandidates[0];
  throwIfAborted(signal, taskId);
  if (!selected.alreadyLanded) {
    const land = await landSquash({
      projectRootDir: repoRootDir,
      mergeRoot: selected.mergeRoot,
      integrationBranch,
      tipSha: selected.tipSha,
      squashSha: selected.squashSha,
      taskId,
      audit,
      resolveConflicts: stashResolveAgent,
      allowDirtyLocalCheckoutSync,
    });
    if (land.outcome !== "advanced") return null;
    await log(`AI merge: recovered approved pre-existing clean-room commit ${short(selected.squashSha)} before pruning`);
    await audit.git({ type: "merge:ai-landed", target: integrationBranch, metadata: { taskId, landedSha: selected.squashSha, source: "pre-prune-clean-room-recovery", mergeRoot: selected.mergeRoot } }).catch(() => undefined);
    return { outcome: "landed", squashSha: selected.squashSha, localSync: land.localSync, tipSha: selected.tipSha, integrationBranch };
  }

  await log(`AI merge: recovered already-landed clean-room commit ${short(selected.squashSha)} before pruning`);
  return { outcome: "landed", squashSha: selected.squashSha, localSync: "skipped-other-branch", tipSha: selected.tipSha, integrationBranch };
}

export {
  cleanupAiMergeWorktree,
  isBenignAbsentWorktreeError,
  pruneExistingAiMergeWorktrees,
  resolveAiMergeRoot,
} from "./merger-ai-worktree.js";

/** Trailers that associate the squash commit with its board task: the
 *  `Fusion-Task-Id` trailer plus the canonical lineage trailer when available.
 *  These are what the board's commit→task association parses. */
function taskTrailers(
  taskId: string,
  lineageId?: string | null,
  settings?: Pick<Settings, "commitAuthorEnabled" | "commitAuthorName" | "commitAuthorEmail">,
): string[] {
  const trailers = [`${FUSION_TASK_ID_TRAILER_KEY}: ${taskId}`];
  if (lineageId) trailers.push(buildTaskLineageTrailer(lineageId));
  if (settings?.commitAuthorEnabled !== false) {
    const name = (settings?.commitAuthorName ?? DEFAULT_COMMIT_AUTHOR_NAME).trim() || DEFAULT_COMMIT_AUTHOR_NAME;
    const email = (settings?.commitAuthorEmail ?? DEFAULT_COMMIT_AUTHOR_EMAIL).trim() || DEFAULT_COMMIT_AUTHOR_EMAIL;
    /*
    FNXC:CommitAttribution 2026-06-26-13:02:
    AI-merge squash commits must receive the same deterministic co-author trailer as executor commits. The backfill amends only missing/different trailers, so an agent-supplied identical Co-authored-by line is not duplicated.
    */
    trailers.push(`Co-authored-by: ${name} <${email}>`);
  }
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

export {
  REVIEW_VERDICT_MARKER,
  buildMergePrompt,
  buildMergeSystemPrompt,
  buildReviewPrompt,
  buildReviewSystemPrompt,
  buildStashResolvePrompt,
  buildStashResolveSystemPrompt,
  parseReviewVerdict,
} from "./merger-ai-prompts.js";
export type { AiMergeReviewSeverity, AiMergeReviewVerdict } from "./merger-ai-prompts.js";

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
    // FNXC:Settings-MergerModel 2026-07-16-00:00: mutating merger retries resolve the project merger fallback lane before the shared global fallback.
    const mergerFallbackModel = resolveMergerFallbackModel(settings);
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
      fallbackProvider: mergerFallbackModel.provider,
      fallbackModelId: mergerFallbackModel.modelId,
      fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings),
      defaultThinkingLevel: resolveMergerThinkingLevel(settings),
      runAuditor: audit,
      settings,
      // FNXC:McpConfig 2026-06-25-22:48: merger-ai is the production merge path, so the mutating agent resolves enabled MCP servers at session creation and relies on the shared runtime guard for unsupported providers.
      mcpServers: (await resolveMcpServersForStore(store)).servers,
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
    // FNXC:Settings-MergerModel 2026-07-16-00:00: review merger retries share the dedicated merger fallback provider/model and thinking lane.
    const mergerFallbackModel = resolveMergerFallbackModel(settings);
    // FNXC:Settings-ThinkingLevel 2026-07-10-00:00: The review agent's model falls back
    // between the validator lane and the merger default lane, so its thinking level
    // must follow the same lane it actually resolved a model from.
    const reviewThinkingLevel = validator.provider && validator.modelId
      ? resolveValidatorThinkingLevel(undefined, settings)
      : resolveMergerThinkingLevel(settings);
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
      fallbackProvider: mergerFallbackModel.provider,
      fallbackModelId: mergerFallbackModel.modelId,
      fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings),
      defaultThinkingLevel: reviewThinkingLevel,
      runAuditor: audit,
      settings,
      // FNXC:McpConfig 2026-06-25-22:48: The production merge reviewer receives the same materialized MCP set as the mutating merge agent, preserving all-lane forwarding without logging server contents.
      mcpServers: (await resolveMcpServersForStore(store)).servers,
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
 *      polluted by the ref move). Project-resolved settings default to stash/pop
 *      reconciliation for dirty integration checkouts, but this lower-level
 *      helper still requires direct callers to opt in; otherwise dirty state is
 *      a hard blocker. If the checkout HEAD has already moved off tipSha, that's
 *      a concurrent advance → rebuild.
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
   * local edits in the checked-out integration worktree.
   *
   * FNXC:Merge 2026-06-26-00:00:
   * Resolved project settings default merger.allowDirtyLocalCheckoutSync to true for legacy operator UX, but this helper's parameter default intentionally remains false so direct/programmatic callers and tests fail closed unless they make the dirty-checkout sync policy explicit.
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
  /*
  FNXC:MergeAutostash 2026-07-15-13:20:
  Label through the canonical `fusion-merger-autostash:` vocabulary so this stash
  reaches merger.ts's reclamation machinery: subsumed-drop once its content is on
  HEAD, age sweep, and the orphan notifications that tell an operator work is
  recoverable. The former `fusion-ai-merge-sync-<taskId>` label matched none of
  it, so the retention below ("keep as a backup") had no counterpart that ever
  reclaimed the backup and entries accumulated for months.
  Retention is still deliberate — only a stash whose content is provably already
  on HEAD is ever dropped.
  */
  const stashed = dirty
    ? await gitOk(
        ["stash", "push", "--include-untracked", "-m", buildAutostashLabel(taskId, "ai-local-sync", Date.now())],
        projectRootDir,
      )
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
// Per-repo land (extracted from runAiMerge's inline clean-room closure)
// ---------------------------------------------------------------------------

/*
FNXC:Workspace 2026-06-21-23:40 (Phase C U1, KTD1):
`landOneRepo` is the per-repo land mechanic extracted byte-for-byte from
`runAiMerge`'s former inline clean-room closure: pre-merge prune (rooted at THIS
repo) → mkdtemp clean room → `git worktree add --detach` → installWorktreeDependencies
→ mergeAndReview → landSquash → the concurrent-advance CAS retry loop → the
activeSessionRegistry register/unregister + cleanup-finally. It advances ONE local
integration ref (no remote push) and returns what landed. It deliberately does NOT
move the task or write task-level mergeDetails — that task-global finalization
(`finalizeMerged`/`finalizeTask`/`evaluateNoCommitsNoOpFinalize`) stays with the
caller, so the same primitive is callable per sub-repo from `landWorkspaceTask`
without finalizing the whole task per repo (KTD3).

`runAiMerge` is the SINGLE-REPO caller: it builds the same context it always built
and calls `landOneRepo` once against the project root, then runs its existing
finalization on the result. Single-repo behavior is unchanged.
*/

/** Per-task context shared by every per-repo land (agents/audit/log are bound to
 *  the task, not the repo). The repo-varying inputs (rootDir/branch/integrationBranch)
 *  are explicit `landOneRepo` args. */
export interface LandRepoContext {
  taskId: string;
  settings: Settings;
  audit: RunAuditor;
  log: (message: string) => Promise<void>;
  setStatus: (status: string | null) => Promise<unknown>;
  maxPasses: number;
  mergeAgent: (cwd: string, prompt: string) => Promise<void>;
  reviewAgent: (cwd: string, prompt: string) => Promise<string>;
  stashResolveAgent: (cwd: string, prompt: string) => Promise<void>;
  includeTaskId: boolean;
  trailers: string[];
  taskTitle?: string;
  signal?: AbortSignal;
  allowDirtyLocalCheckoutSync?: boolean;
  /*
  FNXC:Workspace 2026-06-24-23:50 (resilient workspace land):
  When true, a clean-room dependency-sync FAILURE is non-fatal: the land proceeds (the git squash
  does not need installed deps) and only dep-dependent merge verification degrades for this repo.
  Set on the workspace per-repo land so one sub-repo's broken/corrupt package manifest (e.g. an
  invalid `-@0.0.1` lockfile entry npm rejects) cannot block landing the other sub-repos. Defaults
  off, preserving the documented hard-fail for the single-repo land path.
  */
  nonFatalDependencySync?: boolean;
  store: TaskStore;
}

/** What a single repo's land produced. No task move / mergeDetails — the caller
 *  decides task-global finalization. */
export type LandOneRepoResult =
  | {
      /** The branch had no net changes vs the integration tip — nothing landed. */
      outcome: "empty";
      tipSha: string;
      integrationBranch: string;
    }
  | {
      /** The squash landed; the local integration ref now points at `squashSha`. */
      outcome: "landed";
      squashSha: string;
      localSync: LocalSyncOutcome;
      tipSha: string;
      integrationBranch: string;
    };

/**
 * Land `branch` onto `integrationBranch`'s LOCAL ref in `repoRootDir` via a
 * repo-scoped clean room, retrying on concurrent advance. No remote push. See
 * the FNXC note above for the extraction contract.
 */
// FNXC:Workspace 2026-06-22-09:30 (Phase C review B12): `landOneRepo` takes its store access
// exclusively through the `ctx` callbacks (log/setStatus/audit) and pre-built agents — it never
// touches a TaskStore directly. The former leading `store` param was dead and misleading at the
// call sites (they looked like they forwarded a store the function ignored), so it was dropped.
export async function landOneRepo(
  repoRootDir: string,
  branch: string,
  integrationBranch: string,
  ctx: LandRepoContext,
): Promise<LandOneRepoResult> {
  const {
    taskId, settings, audit, log, setStatus, maxPasses,
    mergeAgent, reviewAgent, stashResolveAgent,
    includeTaskId, trailers, taskTitle, signal, store,
  } = ctx;

  // If a prior merger died after the clean-room squash was approved but before
  // landing/finalization, land that commit before the normal pre-merge prune can
  // delete the only easy reference to it.
  const recovered = await recoverApprovedPreexistingAiMergeWorktree(repoRootDir, integrationBranch, ctx);
  if (recovered) return recovered;

  // Pre-merge prune is rooted at THIS sub-repo (KTD1): N per-repo clean rooms for
  // one task share the `fusion-ai-merge-<taskId>-` prefix, so a prune rooted at a
  // shared root could reap a sibling repo's live clean room. Rooting it at
  // repoRootDir keeps each repo's prune to its own temp roots.
  try {
    const pruned = await pruneExistingAiMergeWorktrees(taskId, repoRootDir, audit, log, settings);
    if (pruned > 0) await log(`AI merge: pruned ${pruned} pre-existing worktree(s) for ${taskId}`);
  } catch (err: unknown) {
    await log(`AI merge: pre-merge prune failed: ${getErrorMessage(err)}`);
  }
  let advanceRetries = 0;
  while (true) {
    throwIfAborted(signal, taskId);
    const tipSha = await git(["rev-parse", "--verify", `refs/heads/${integrationBranch}`], repoRootDir);

    // Short-circuit a branch with zero commits ahead of the integration tip
    // BEFORE building a clean room + installing deps. A truly-empty branch would
    // reach the identical `outcome: "empty"` return below via mergeAndReview →
    // no squashSha, but only after the throw-prone dep-install churn (which a
    // non-workspace land hard-fails), so the merge gets transient-retried to
    // exhaustion and the card is parked failed. Only short-circuit on a CONFIDENT
    // 0: a git failure yields "" → parseInt → NaN (≠ 0) and falls through.
    const aheadRaw = await git(["rev-list", "--count", `${integrationBranch}..${branch}`], repoRootDir).catch(() => "");
    if (Number.parseInt(aheadRaw.trim(), 10) === 0) {
      await audit.git({ type: "merge:ai-empty", target: integrationBranch, metadata: { taskId, tipSha } });
      return { outcome: "empty", tipSha, integrationBranch };
    }

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
      mergeRoot = await mkdtemp(join(resolveAiMergeRoot(repoRootDir, settings), `fusion-ai-merge-${taskId.toLowerCase()}-`));
      /*
       * FNXC:AIMerge 2026-06-14-16:36:
       * The AI-merge clean-room directory must be created and registered inside the cleanup guard. Any terminal path or interrupt after `mkdtemp`, including active-session registration failure before `git worktree add`, must still unregister known paths and remove the `fusion-ai-merge-*` directory.
       */
      // Register the repo-local clean-room path as soon as it exists, before
      // `git worktree add`, so self-healing/pre-merge sweeps cannot reap a
      // just-created clean room in the small window before canonical registration
      // is available.
      registerMergeRoot(mergeRoot);
      await git(["worktree", "add", "--detach", mergeRoot, tipSha], repoRootDir);
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
      let depsSyncResult: Awaited<ReturnType<typeof installWorktreeDependencies>> | null = null;
      try {
        depsSyncResult = await installWorktreeDependencies({
          cwd: canonicalMergeRoot,
          settings,
          taskId,
          signal,
          context: "for AI merge clean room",
          logger: aiMergeLog,
          log,
        });
      } catch (depsErr: unknown) {
        /*
        FNXC:Workspace 2026-06-24-23:50 (resilient workspace land):
        The default contract hard-fails install errors so verification cannot silently run against an
        uninstalled checkout. For a WORKSPACE per-repo land (ctx.nonFatalDependencySync) we instead
        degrade: the git squash does not need installed deps, so one sub-repo whose manifest npm
        refuses to install (e.g. a corrupt `-@0.0.1` lockfile entry) must not block landing the
        others. Log + audit the degradation and proceed; the merge/review agents still run (they just
        cannot run dep-dependent build/test verification for this repo). A genuine abort signal still
        propagates. Non-workspace land keeps the original throw.
        */
        throwIfAborted(signal, taskId);
        if (!ctx.nonFatalDependencySync) throw depsErr;
        const depsErrMessage = getErrorMessage(depsErr);
        await log(`AI merge (workspace): dependency sync FAILED for this sub-repo's clean room — landing without dep-dependent verification (deps unavailable): ${depsErrMessage}`);
        await audit.git({
          type: "merge:ai-deps-sync",
          target: integrationBranch,
          metadata: { taskId, tipSha, mergeRoot: canonicalMergeRoot, failed: true, nonFatal: true, error: depsErrMessage, durationMs: Date.now() - depsSyncStartedAt },
        });
      }
      if (depsSyncResult) {
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
            // FNXC:AIMerge 2026-07-02-14:05 (lockfile auto-heal): record when an outdated frozen lockfile
            // was recovered by a non-frozen retry so operators can see deps drifted without failing merge.
            healed: depsSyncResult.healed,
            healedCommand: depsSyncResult.healedCommand,
            durationMs: depsSyncResult.durationMs,
          },
        });
      }
      await log(`[timing] AI merge dependency sync completed in ${Date.now() - depsSyncStartedAt}ms${depsSyncResult ? (depsSyncResult.installCommand ? ` (${depsSyncResult.skipped ? "skipped" : "ran"}: ${depsSyncResult.installCommand})` : " (no command)") : " (failed — non-fatal, deps unavailable)"}`);

      // 2 + 3. Merge + review loop (corrective passes).
      const squashSha = await mergeAndReview({
        mergeRoot, branch, integrationBranch, tipSha, taskTitle, includeTaskId, trailers, taskId,
        maxPasses, mergeAgent, reviewAgent, audit, log, setStatus, store, signal,
      });

      if (!squashSha) {
        // Branch had no net changes vs the tip — nothing to land. The caller
        // decides how to finalize the (possibly multi-repo) task.
        await audit.git({ type: "merge:ai-empty", target: integrationBranch, metadata: { taskId, tipSha } });
        return { outcome: "empty", tipSha, integrationBranch };
      }

      // 4 + 5. Land the squash on the target branch and sync the user's
      //        checkout (AI reconciles a conflicting restore).
      await setStatus("landing");
      const landed = await landSquash({
        projectRootDir: repoRootDir, mergeRoot, integrationBranch, tipSha, squashSha, taskId, audit,
        resolveConflicts: stashResolveAgent,
        allowDirtyLocalCheckoutSync: ctx.allowDirtyLocalCheckoutSync === true,
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
      return { outcome: "landed", squashSha, localSync: landed.localSync, tipSha, integrationBranch };
    } finally {
      for (const registeredPath of registeredMergePaths) {
        activeSessionRegistry.unregisterPath(registeredPath);
      }
      if (mergeRoot) {
        await cleanupAiMergeWorktree({ taskId, mergeRoot, projectRootDir: repoRootDir, worktreeAdded, audit, log });
      }
    }
  }
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
    /*
     * FNXC:WorkflowMerge 2026-06-29-21:42:
     * No-branch no-op finalization is only reached after runAiMerge proves the task is either already merged or was never executed; executed/unmerged missing branches fail loudly before this helper. Carry confirmed no-op proof so workflow task finalization does not stall on missing-merge-confirmation.
     */
    mergeConfirmed: true,
    worktreeRemoved: false,
    branchDeleted: false,
  };
}

function hasPriorAiNoOpFinalizationProof(task: Task, branch: string, integrationBranch: string): boolean {
  /*
   * FNXC:WorkflowMerge 2026-06-29-21:49:
   * FN-7261 exposed a forward-fix recovery gap: older AI no-op finalizers deleted the task branch, then failed before persisting mergeDetails.mergeConfirmed. Treat the paired durable task-log entries as recovery proof only for this narrow already-finalized no-op shape; executed missing branches without those entries still fail as possible lost work.
   */
  const actions = task.log?.map((entry) => entry.action) ?? [];
  return actions.some((action) =>
    action.includes(`AI merge: ${branch} had no net changes vs ${integrationBranch} — finalizing as no-op`)
  ) && actions.some((action) =>
    action.includes(`AI merge: finalized ${task.id} (no-op), finalizing task row`)
  );
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
  /*
  FNXC:BranchGroupCompletion 2026-07-04-00:00:
  FN-7532: runAiMerge is the SOLE merge path (master-plan U0 FNXC:MergerUnification), but it never
  consulted branch-group routing, so a shared-branch-group member's mergeDetails never got
  mergeTargetBranch/mergeTargetSource stamped. isBranchGroupMemberLanded requires
  mergeTargetSource === "branch-group-integration" AND a matching mergeTargetBranch (merge-target
  safety, see branch-group-completion.ts) — with both fields permanently undefined, every shared
  member landed via the production path was reported as NOT landed forever (the branch-group
  checklist/PR body "x/N landed" never advanced and promotion never became eligible). Route through
  the same resolveBranchGroupMergeRouting used by the legacy merger.ts executeMergeAttempt so a
  shared member's actual merge target is the group's branch (never a sibling/mismatched branch) and
  the persisted mergeDetails correctly attribute the landing.
  */
  const groupRouting = await resolveBranchGroupMergeRouting({
    task,
    store,
    projectDefaultBranch,
    rootDir: projectRootDir,
  });
  const mergeTarget = groupRouting?.mergeTarget ?? resolveTaskMergeTarget(task, { projectDefaultBranch });
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
    await store.appendAgentLog(taskId, message, "status", undefined, "merger").catch(() => undefined);
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
    const alreadyMerged =
      task.mergeDetails?.mergeConfirmed === true ||
      !!task.mergeDetails?.commitSha ||
      hasPriorAiNoOpFinalizationProof(task, branch, integrationBranch);
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
    return await finalizeTask(store, taskId, noOpResult(task, branch, alreadyMerged ? "already-merged" : "no-branch"), undefined, undefined, projectRootDir);
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
  /*
   * FNXC:Merge 2026-06-26-00:00:
   * runAiMerge callers may rely on already-resolved project settings instead of forwarding MergerOptions. Preserve an explicit option false, otherwise inherit merger.allowDirtyLocalCheckoutSync so new-project default true reaches both single-repo and workspace landing paths.
   */
  const allowDirtyLocalCheckoutSync = options.allowDirtyLocalCheckoutSync ?? (settings.merger?.allowDirtyLocalCheckoutSync === true);
  // Trailers that link the squash commit to the board task (FN-id + lineage) and deterministic co-author attribution.
  const trailers = taskTrailers(taskId, task.lineageId, settings);
  const taskTitle = task.title?.trim() ? task.title.split("\n")[0] : undefined;

  await setStatus("merging");
  // FNXC:Workspace 2026-06-21-23:40 (Phase C U1, KTD1):
  // runAiMerge is now the SINGLE-REPO caller of the extracted `landOneRepo`. It
  // builds the same per-task context it always built and lands the project root
  // once; the task-global finalization below (empty no-op / no-commits demote /
  // finalizeMerged) is unchanged byte-for-byte — only the inline clean-room land
  // loop moved into `landOneRepo` so `landWorkspaceTask` can reuse it per sub-repo.
  const landResult = await landOneRepo(projectRootDir, branch, integrationBranch, {
    taskId, settings, audit, log, setStatus, maxPasses,
    mergeAgent, reviewAgent, stashResolveAgent,
    includeTaskId, trailers, taskTitle, signal: options.signal,
    allowDirtyLocalCheckoutSync,
    store,
  });

  if (landResult.outcome === "empty") {
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
    const noOpFinalized = await finalizeMerged(store, projectRootDir, taskId, task, branch, integrationBranch, landResult.tipSha, audit, log, { empty: true }, mergeTarget, groupRouting, options.syncGroupPr);
    await runPushAfterMergeStep({ store, projectRootDir, taskId, settings, integrationBranch, audit, log, options, result: noOpFinalized });
    return noOpFinalized;
  }

  const finalized = await finalizeMerged(store, projectRootDir, taskId, task, branch, integrationBranch, landResult.squashSha, audit, log, { empty: false }, mergeTarget, groupRouting, options.syncGroupPr);
  await runPushAfterMergeStep({ store, projectRootDir, taskId, settings, integrationBranch, audit, log, options, result: finalized });
  return finalized;
}

/*
FNXC:MergePush 2026-07-11-22:25:
Post-finalization push step for the sole production merge path. Runs AFTER the task is
finalized (mirrors the legacy contract: "task marked done anyway; local main may diverge
from origin" on failure) so a push problem can never park or roll back a landed merge.
Also runs after an empty/no-op finalize: the integration ref may still be ahead of the
remote from earlier merges whose pushes failed, and pushing an up-to-date remote is a
free no-op — this makes the setting self-healing. Every attempt emits a `push:origin`
run-audit event; failures additionally get a durable task-log entry.
*/
async function runPushAfterMergeStep(input: {
  store: TaskStore;
  projectRootDir: string;
  taskId: string;
  settings: Settings;
  integrationBranch: string;
  audit: RunAuditor;
  log: (message: string) => Promise<void>;
  options: MergerOptions;
  result: MergeResult;
}): Promise<void> {
  const { store, projectRootDir, taskId, settings, integrationBranch, audit, log, options, result } = input;
  if (settings.pushAfterMerge !== true || settings.mergeStrategy === "pull-request") return;
  try {
    const pushOutcome = await pushAfterMergeToRemote({
      store,
      projectRootDir,
      taskId,
      settings,
      integrationBranch,
      audit,
      log,
      signal: options.signal,
      onAgentText: options.onAgentText,
      onSession: options.onSession,
    });
    result.pushedToRemote = pushOutcome.pushed;
    if (pushOutcome.error) result.pushError = pushOutcome.error;
    await audit.git({
      type: "push:origin",
      target: taskId,
      metadata: {
        integrationBranch,
        remote: pushOutcome.remote ?? settings.pushRemote ?? "origin",
        targetBranch: pushOutcome.targetBranch,
        outcome: pushOutcome.pushed ? "success" : "failed",
        refAdvanced: pushOutcome.refAdvanced,
        ...(pushOutcome.error ? { stderrPreview: pushOutcome.error.slice(0, 500) } : {}),
      },
    }).catch(() => undefined);
    if (pushOutcome.pushed) {
      await log(`Push after merge: pushed ${integrationBranch} to ${pushOutcome.remote}/${pushOutcome.targetBranch}`);
      // A divergence rebase rewrote the landed squash — refresh the recorded
      // commitSha/stats so mergeDetails don't reference an orphaned commit
      // (mirrors the legacy post-push refresh).
      if (pushOutcome.refAdvanced && pushOutcome.rebasedSha) {
        try {
          const latest = await store.getTask(taskId).catch(() => null);
          const details = latest?.mergeDetails;
          if (details?.commitSha && details.commitSha !== pushOutcome.rebasedSha) {
            const { filesChanged, insertions, deletions } = await captureSingleCommitLandedMetadata(projectRootDir, pushOutcome.rebasedSha);
            await store.updateTask(taskId, {
              mergeDetails: { ...details, commitSha: pushOutcome.rebasedSha, filesChanged, insertions, deletions },
            });
          }
        } catch (refreshErr: unknown) {
          aiMergeLog.warn(`${taskId}: post-push mergeDetails refresh failed: ${getErrorMessage(refreshErr)}`);
        }
      }
    } else {
      aiMergeLog.warn(`${taskId}: push to remote failed: ${pushOutcome.error}`);
      await store.logEntry(
        taskId,
        `Push to remote failed after merge — task finalized anyway; local ${integrationBranch} may diverge from ${pushOutcome.remote ?? "origin"}: ${pushOutcome.error}`,
        "PushToRemoteFailed",
      ).catch(() => undefined);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "MergeAbortedError") {
      // The task already finalized — an abort mid-push must not re-surface as a
      // failed/aborted merge. Skip quietly; the next merge's push reconciles.
      aiMergeLog.warn(`${taskId}: push after merge aborted by shutdown signal — skipping (merge already finalized)`);
      return;
    }
    const message = getErrorMessage(err);
    result.pushedToRemote = false;
    result.pushError = message;
    aiMergeLog.error(`${taskId}: push to remote threw: ${message}`);
    await audit.git({
      type: "push:origin",
      target: taskId,
      metadata: { integrationBranch, remote: settings.pushRemote ?? "origin", outcome: "failed", stderrPreview: message.slice(0, 500) },
    }).catch(() => undefined);
    await store.logEntry(
      taskId,
      `Push to remote threw after merge — task finalized anyway; local ${integrationBranch} may diverge from origin: ${message}`,
      "PushToRemoteFailed",
    ).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Workspace-mode per-repo merge loop (Phase C U1)
// ---------------------------------------------------------------------------

/** Per-repo land outcome inside a workspace task, tagged with its sub-repo. */
export interface WorkspaceRepoLandResult {
  /** The sub-repo's relative path (the `workspaceWorktrees` key). */
  repo: string;
  /** Absolute path to the sub-repo's main checkout (where the ref advanced). */
  repoRootDir: string;
  /** The per-repo integration branch this repo landed onto (origin/HEAD-derived). */
  integrationBranch: string;
  /** The `fusion/<id>` branch that was landed. */
  branch: string;
  /** What happened: landed, empty (no net changes), or failed. */
  status: "landed" | "empty" | "failed";
  /** The squash sha when `status === "landed"`. */
  landedSha?: string;
  /** How the sub-repo checkout was reconciled when landed. */
  localSync?: LocalSyncOutcome;
  /** Failure message when `status === "failed"`. */
  error?: string;
  /**
   * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
   * True when this repo was SKIPPED by the landed predicate on a retry (its recorded
   * `landedSha` is already an ancestor of the integration tip) — its ref was NOT
   * re-advanced this run.
   */
  alreadyLanded?: boolean;
}

/** Aggregated result of a workspace task's per-repo merge loop. */
export interface WorkspaceMergeResult {
  taskId: string;
  repos: WorkspaceRepoLandResult[];
  /** True iff every acquired sub-repo landed (or was empty) with no failure. */
  allLanded: boolean;
  /**
   * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
   * True iff the finalize-once move-to-done ran this call (only when `allLanded`).
   * False on a partial land (the task stays put for the engine dispatch's auto-retry).
   */
  finalized: boolean;
}

/*
FNXC:Workspace 2026-06-21-23:40 (Phase C U1, KTD1/KTD2):
`landWorkspaceTask` replaces U0's R7 fail-fast throw with the real per-repo merge
loop. For each acquired sub-repo (iterated by SORTED relative-path key for
determinism) it lands that repo's `fusion/<id>` branch onto THAT repo's own LOCAL
integration ref via the extracted `landOneRepo` — no remote push, land-as-you-go
(settled D2/D5).

Per-repo integration branch (KTD1): `workspaceWorktrees[repo]` does NOT store the
integration branch (acquisition computes then discards it), so we re-resolve it per
repo with the SAME override-stripping acquisition used — integrationBranch/baseBranch
undefined — so each sub-repo falls through to its own origin/HEAD rather than a shared
workspace branch.

U1 scope: on a repo failure we stop the loop and return a PARTIAL result (repo A may
have landed; B reports the failure). Routing the engine + CLI doors to this loop is KTD2.

FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
U2 adds per-repo landed tracking + finalize-once + idempotent retry on top of U1's loop:

  - Landed predicate + skip: before landing a repo, we skip it iff its `landedSha` is
    recorded AND that sha is an ancestor of (or equals) the repo's CURRENT integration
    tip. A skipped repo's ref is NEVER re-advanced, so re-running `landWorkspaceTask`
    after a partial land (A landed, B failed) re-attempts ONLY B — A is idempotent.
  - landedSha persistence: after a repo lands, we record `workspaceWorktrees[repo].landedSha`
    = the advanced integration tip via a FRESH-read-then-merge `store.updateTask` (re-read
    the latest task and merge only this repo's entry, so concurrent sibling-entry writes
    are not clobbered — the Phase A/B per-repo persistence pattern).
  - finalize-once: the task moves to `done` EXACTLY ONCE, only after EVERY acquired repo's
    landed predicate holds (all landed/empty, none failed). We reuse the task-global
    `finalizeTask` move-done path with an AGGREGATE mergeDetails (representative
    `commitSha` = first sorted landed repo + a `workspaceLandedShas` map) so the existing
    `task:merged` consumer is satisfied. On a partial land we do NOT move done — we return
    `allLanded:false` with the landed repos' `landedSha` already persisted.

The partial-land retry/park policy (consume a mergeRetry, auto-retry skipping landed
repos up to MAX, then operator-park) is wired at the engine dispatch (project-engine.ts),
NOT here: this function reports the partial via `allLanded:false` and the dispatch drives
the retry seam.

FNXC:Workspace 2026-06-22-02:10 (Phase C U3, KTD4):
Per-repo LAND lease. Before each `landOneRepo` we register the sub-repo ABSOLUTE
path in the path-keyed activeSessionRegistry under kind "workspace-repo-land" and
release it in a per-repo `finally` (so the lease is freed on land success OR land
failure — no stuck lock). If another task already holds the land lease for that
sub-repo path we FAST-FAIL the whole `landWorkspaceTask` with a retryable
`WorkspaceRepoLandBusyError`, which the U2 partial-land retry/park machinery
(project-engine dispatch) already handles — reusing that path instead of
reimplementing a waiting lock. The lease serializes same-sub-repo lands so two
tasks' clean-room ai-merge worktrees do not collide; it is NOT what makes the
interleaved `update-ref` correct — `advanceIntegrationBranchRef`'s CAS already
guarantees ref correctness (concurrent-advance → rebuild). Disjoint sub-repos lease
DIFFERENT paths, so they never serialize against each other (no false contention).
This lease is a DIFFERENT scope/kind from the execution-phase
"workspace-repo-acquire" lease and from `landOneRepo`'s own inner "ai-merge"
clean-room registration on the temp worktree path — none of the three collide.
*/

/** FNXC:Workspace 2026-06-22-02:10 (Phase C U3, KTD4): ownerKey for the land-time lease. */
const WORKSPACE_REPO_LAND_OWNER_KEY = "workspace-repo-land";

/*
FNXC:Workspace 2026-06-22-02:10 (Phase C U3, KTD4):
Thrown when a second workspace task tries to land a sub-repo already inside another
task's land critical section. Distinct from a generic land failure so the engine
dispatch (and tests) can tell "serialized, retry later" apart from "this land is
broken". Carries `retryable = true` so the existing partial-land auto-retry/park
path treats it as a transient contention, not a terminal failure.
*/
export class WorkspaceRepoLandBusyError extends Error {
  public readonly retryable = true;
  constructor(
    public readonly repoRel: string,
    public readonly holderTaskId: string,
    public readonly requestingTaskId: string,
  ) {
    super(`workspace sub-repo ${repoRel} land is in progress for task ${holderTaskId}`);
    this.name = "WorkspaceRepoLandBusyError";
  }
}

/*
FNXC:Workspace 2026-06-22-04:10 (Phase C review A4 — real WorkspacePartialLandError class):
Previously the partial-land signal was a bare `new Error()` with `.name` patched in
project-engine.ts (a footgun: no instanceof, no typed payload). It is now a real exported
class so the dispatch can switch to `instanceof` (separate pass) and tests can assert
`instanceof`. `retryable = true` because a partial land is recoverable — the landed repos'
`landedSha` is persisted and a re-run skips them (the U2 idempotency contract).

`landWorkspaceTask` throws this from ONE place: the A1 persist-after-advance failure window
(the integration ref ALREADY advanced but `persistRepoLandedSha` could not record the
`landedSha`). The ORDINARY partial land (repo A landed, repo B's land failed) still RETURNS
`allLanded:false` — that return-based contract is what the engine dispatch and the oracle
workspace-merger tests already consume; only the persist-failure window escalates to a throw
so the engine parks/retries and A1's `isRepoLanded` ancestor-fallback skips the actually-landed
repo on retry (no double-squash).
*/
export class WorkspacePartialLandError extends Error {
  public readonly retryable = true;
  constructor(
    public readonly landedCount: number,
    public readonly failedRepos: string[],
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePartialLandError";
  }
}

export async function landWorkspaceTask(
  store: TaskStore,
  task: Task,
  workspaceRootDir: string,
  options: MergerOptions = {},
  deps: AgentDeps = {},
): Promise<WorkspaceMergeResult> {
  const taskId = task.id;
  const settings = await store.getSettings();
  const audit = createRunAuditor(store, {
    runId: generateSyntheticRunId("ai-merge", taskId),
    agentId: "merger",
    taskId,
    phase: "merge",
  });
  const log = async (message: string): Promise<void> => {
    await store.logEntry(taskId, message, "AiMerge").catch(() => undefined);
    await store.appendAgentLog(taskId, message, "status", undefined, "merger").catch(() => undefined);
  };
  const setStatus = (status: string | null): Promise<unknown> =>
    store.updateTask(taskId, { status }).catch(() => undefined);

  const maxPasses = Math.max(0, Math.trunc(settings.merger?.maxReviewPasses ?? 3));
  const mergeAgent = deps.mergeAgent ?? makeMutatingAgent(store, settings, taskId, options, audit, buildMergeSystemPrompt(settings.agentPrompts));
  const reviewAgent = deps.reviewAgent ?? makeReviewAgent(store, settings, taskId, options, audit);
  const stashResolveAgent = deps.stashResolveAgent ?? makeMutatingAgent(store, settings, taskId, options, audit, buildStashResolveSystemPrompt());
  const includeTaskId = settings.includeTaskIdInCommit !== false;
  const allowDirtyLocalCheckoutSync = options.allowDirtyLocalCheckoutSync ?? (settings.merger?.allowDirtyLocalCheckoutSync === true);
  const trailers = taskTrailers(taskId, task.lineageId, settings);
  const taskTitle = task.title?.trim() ? task.title.split("\n")[0] : undefined;

  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  // SORTED keys for deterministic land order (KTD1).
  const repoKeys = Object.keys(workspaceWorktrees).sort();
  const repos: WorkspaceRepoLandResult[] = [];
  let allLanded = true;

  await setStatus("merging");
  /*
  FNXC:Workspace 2026-06-22-04:10 (Phase C review A3 — status 'merging' must never leak):
  The busy-throw (WorkspaceRepoLandBusyError) and the persist-failure throw
  (WorkspacePartialLandError) exit the loop BEFORE the post-loop `setStatus(null)`. If the
  engine catch never runs (process crash between throw and catch) the task stays stuck
  'merging' with no manual door to clear it. Wrap the whole per-repo loop so `setStatus(null)`
  ALWAYS runs (in finally) before ANY throw escapes. The success path still finalizes to done
  AFTER this finally (finalizeWorkspaceTask sets its own column/status), so clearing 'merging'
  first is safe — finalize overwrites it. This finally only clears the transient merge status;
  it does not move the task.
  */
  try {
  for (const repoRel of repoKeys) {
    throwIfAborted(options.signal, taskId);
    const entry = workspaceWorktrees[repoRel];
    const repoRootDir = join(workspaceRootDir, repoRel);

    // Re-resolve THIS sub-repo's integration branch with the shared overrides
    // stripped (KTD1) so each sub-repo lands on its OWN origin/HEAD, not a shared
    // workspace branch.
    let integrationBranch: string;
    try {
      integrationBranch = await resolveIntegrationBranch(
        repoRootDir,
        { ...settings, integrationBranch: undefined, baseBranch: undefined },
      );
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      await log(`AI merge (workspace): failed to resolve integration branch for sub-repo ${repoRel}: ${message}`);
      repos.push({ repo: repoRel, repoRootDir, integrationBranch: "", branch: entry.branch, status: "failed", error: message });
      allLanded = false;
      break;
    }

    // U2 landed predicate + skip (KTD3): a repo whose recorded `landedSha` is an
    // ancestor of (or equals) its CURRENT integration tip is already landed — SKIP
    // it so a retry never re-advances the ref. This makes a re-run after a partial
    // land idempotent for the already-landed repos.
    const provenLandedSha = await findProvenLandedCommit(
      repoRootDir,
      integrationBranch,
      entry.landedSha,
      taskId,
      entry.branch,
    );
    if (provenLandedSha) {
      /*
      FNXC:Workspace 2026-07-07-10:25 (Phase C A1 recovery — record the EXACT proven commit, not the tip):
      isRepoLanded's A1 trailer-fallback can prove a sub-repo is landed even when its landedSha
      was never persisted (the persist-after-advance window in persistRepoLandedSha threw). That
      left the in-memory result with landedSha: undefined, so finalizeWorkspaceTask's
      `status === "landed" && landedSha` filter dropped the recovered repo, `anyLanded` stayed
      false, and the proven repo's retry STRANDED the task in-review with missing-merge-confirmation.
      Recover the EXACT proven commit (the A1 trailer commit, or the recorded landedSha when it is
      still an ancestor) — NOT the current integration tip, which may have advanced past the actual
      landing commit via an intervening sub-repo land. findProvenLandedCommit returns that exact sha
      so finalize builds durable mergeConfirmed proof and the A1 retry completes to done.
      */
      await log(`AI merge (workspace): sub-repo ${repoRel} already landed (${short(provenLandedSha)} ⊑ ${integrationBranch}) — skipping`);
      repos.push({
        repo: repoRel, repoRootDir, integrationBranch, branch: entry.branch,
        status: "landed", landedSha: provenLandedSha, alreadyLanded: true,
      });
      continue;
    }

    /*
    FNXC:Workspace 2026-06-22-02:10 (Phase C U3, KTD4):
    Same-sub-repo LAND lease. Register the sub-repo absolute path BEFORE landing so
    two tasks landing the SAME sub-repo are serialized (their clean-room ai-merge
    worktrees would otherwise collide). The lookupByPath → registerPath pair stays in
    ONE synchronous slice (no `await` between them) so the claim is atomic — an
    interleaved await would let a second task pass the gate before we register. If
    another task holds the land lease we FAST-FAIL with a retryable busy error; the
    U2 dispatch auto-retry/park path handles it (no waiting lock reimplemented here).

    FNXC:Workspace 2026-06-22-04:10 (Phase C review A2 — taskId-aware contention across kinds):
    Previously we only treated a HELD entry of OUR OWN land ownerKey as contention, so a
    MERGING task would registerPath-OVERWRITE an EXECUTING task's "workspace-repo-acquire"
    entry on a shared sub-repo (cross-phase clobber). Now ANY foreign-task holder on this
    path — regardless of kind (acquire OR land OR anything else) — is contention: we throw
    WorkspaceRepoLandBusyError so the engine retries when the other task releases its hold.
    A SAME-task holder is NOT contention (idempotent re-claim of our own path). The
    registerPath guard (A2b) backstops this: it also rejects a foreign-task overwrite, so a
    missed check can never silently clobber.
    */
    const landLeaseHolder = activeSessionRegistry.lookupByPath(repoRootDir);
    if (landLeaseHolder && landLeaseHolder.taskId !== taskId) {
      throw new WorkspaceRepoLandBusyError(repoRel, landLeaseHolder.taskId, taskId);
    }
    activeSessionRegistry.registerPath(repoRootDir, {
      taskId,
      kind: "workspace-repo-land",
      ownerKey: WORKSPACE_REPO_LAND_OWNER_KEY,
    });

    try {
      const landResult = await landOneRepo(repoRootDir, entry.branch, integrationBranch, {
        taskId, settings, audit, log, setStatus, maxPasses,
        mergeAgent, reviewAgent, stashResolveAgent,
        includeTaskId, trailers, taskTitle, signal: options.signal,
        allowDirtyLocalCheckoutSync,
        // FNXC:Workspace 2026-06-24-23:50: one sub-repo's dependency-sync failure must not block
        // landing the others — degrade verification for that repo, still land the git squash.
        nonFatalDependencySync: true,
        store,
      });
      if (landResult.outcome === "landed") {
        /*
        FNXC:Workspace 2026-06-22-04:10 (Phase C review A1 — persist-after-advance is a HARD failure):
        The integration ref has ALREADY advanced (squash landed) by the time we persist
        `landedSha`. If the DB write fails here the ref is advanced but UNRECORDED — we must NOT
        silently continue (a return-based partial would let a retry double-squash). Escalate to a
        retryable WorkspacePartialLandError so the engine parks/retries; on retry, `isRepoLanded`'s
        trailer ancestor-fallback recognises this actually-landed repo and skips it. The repo IS
        recorded as `landed` in the in-memory result first so the error payload is accurate.
        */
        try {
          await persistRepoLandedSha(store, taskId, repoRel, landResult.squashSha);
        } catch (persistErr: unknown) {
          const pmsg = getErrorMessage(persistErr);
          await log(`AI merge (workspace): sub-repo ${repoRel} landed (${short(landResult.squashSha)}) but persisting landedSha FAILED: ${pmsg} — escalating to partial land so a retry can recover (ref already advanced; retry will skip via trailer ancestor-check)`);
          repos.push({
            repo: repoRel, repoRootDir, integrationBranch, branch: entry.branch,
            status: "landed", landedSha: landResult.squashSha, localSync: landResult.localSync,
          });
          allLanded = false;
          const landedCount = repos.filter((r) => r.status === "landed").length;
          throw new WorkspacePartialLandError(
            landedCount,
            [repoRel],
            `Workspace land for ${taskId}: sub-repo ${repoRel} advanced its integration ref but the landedSha persist failed (${pmsg}); retry to record/skip it`,
          );
        }
        repos.push({
          repo: repoRel, repoRootDir, integrationBranch, branch: entry.branch,
          status: "landed", landedSha: landResult.squashSha, localSync: landResult.localSync,
        });
      } else {
        repos.push({ repo: repoRel, repoRootDir, integrationBranch, branch: entry.branch, status: "empty" });
      }
    } catch (err: unknown) {
      // A WorkspacePartialLandError from the persist-failure window above must PROPAGATE
      // (the engine parks/retries). The outer try/finally below resets status first (A3).
      if (err instanceof WorkspacePartialLandError) throw err;
      const message = getErrorMessage(err);
      await log(`AI merge (workspace): sub-repo ${repoRel} land failed: ${message}`);
      await audit.git({ type: "merge:ai-no-branch", target: entry.branch, metadata: { taskId, kind: "workspace-repo-land-failed", repo: repoRel, error: message } }).catch(() => undefined);
      repos.push({ repo: repoRel, repoRootDir, integrationBranch, branch: entry.branch, status: "failed", error: message });
      allLanded = false;
      // Stop on first failure and return a partial result. The already-landed repos'
      // `landedSha` is persisted, so the engine dispatch's auto-retry re-runs this
      // loop and the landed predicate above skips them (only the failed repo retries).
      break;
    } finally {
      /*
      FNXC:Workspace 2026-06-22-02:10 (Phase C U3, KTD4):
      Release the land lease — on land SUCCESS or land FAILURE — but ONLY when WE hold
      it (own taskId + own ownerKey), so a future-acquire path's entry on this path is
      never yanked. The fast-fail busy throw above happens BEFORE registerPath, so a
      serialized loser never unregisters the winner's lease.
      */
      const held = activeSessionRegistry.lookupByPath(repoRootDir);
      if (held && held.taskId === taskId && held.ownerKey === WORKSPACE_REPO_LAND_OWNER_KEY) {
        activeSessionRegistry.unregisterPath(repoRootDir);
      }
    }
  }
  } finally {
    // A3: clear the transient 'merging' status before ANY throw (busy / partial-land /
    // abort) escapes, AND on the normal fall-through. The success path's finalize below
    // re-sets the task's column/status to done, so clearing here first is safe.
    await setStatus(null);
  }

  // U2 finalize-once (KTD3): move the task to `done` EXACTLY ONCE, only after EVERY
  // acquired repo's landed predicate holds (all landed/empty, none failed). Reuse the
  // task-global `finalizeTask` move-done path with an aggregate mergeDetails so the
  // existing `task:merged` consumer is satisfied. On a partial land we do NOT move
  // done (the landed repos' `landedSha` is already persisted for the retry).
  if (allLanded) {
    const finalized = await finalizeWorkspaceTask(store, taskId, task, repos);
    return { taskId, repos, allLanded, finalized };
  }
  return { taskId, repos, allLanded, finalized: false };
}

// FNXC:Workspace 2026-06-22-14:10 (Phase D review G): `isRepoLanded` now lives in
// `workspace-land-predicate.ts` (cycle dissolved). Re-exported here (the imported binding) so
// existing importers of `./merger-ai.js` keep working unchanged.
export { isRepoLanded };

/**
 * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
 * Persist one sub-repo's `landedSha` with a FRESH-read-then-merge so a concurrent
 * sibling-entry write is not clobbered (Phase A/B per-repo `workspaceWorktrees`
 * pattern). Re-read the latest task, merge only this repo's entry, write the whole map.
 *
 * FNXC:Workspace 2026-06-22-04:10 (Phase C review A1 — do NOT swallow the DB write):
 * Previously the `store.updateTask(...)` was `.catch(() => undefined)`. That swallow is the
 * double-land bug: the integration ref has ALREADY advanced by the time we persist, so a
 * silently-lost write means `landedSha` is never recorded → on retry the landedSha check sees
 * NOT-landed and re-runs the squash (a SECOND squash commit). We now PROPAGATE the write
 * failure. The caller (`landWorkspaceTask`) catches it as a partial-land for this repo and
 * escalates to `WorkspacePartialLandError` so the engine parks/retries; on retry, `isRepoLanded`'s
 * trailer ancestor-fallback (A1) recognises the actually-landed repo and skips it (no double
 * squash). We DELIBERATELY do not swallow the `getTask` read either-way: a failed read leaves
 * `landedSha` unrecorded for the same reason, so it must also escalate.
 */
async function persistRepoLandedSha(
  store: TaskStore,
  taskId: string,
  repoRel: string,
  landedSha: string,
): Promise<void> {
  const latest = await store.getTask(taskId);
  const current = latest?.workspaceWorktrees ?? {};
  const entry = current[repoRel];
  if (!entry) return; // entry vanished — nothing to merge into
  const next = { ...current, [repoRel]: { ...entry, landedSha } };
  await store.updateTask(taskId, { workspaceWorktrees: next });
}

/**
 * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
 * Finalize-once: build an aggregate `MergeResult` from the per-repo lands and run the
 * task-global `finalizeTask` move-done path ONCE. The representative `commitSha` is the
 * first sorted landed repo's sha (so `mergeDetails.commitSha` is populated for the
 * `task:merged` consumer); the full per-repo map is carried in `mergeDetails.workspaceLandedShas`.
 * Returns true iff the task was moved to done.
 */
async function finalizeWorkspaceTask(
  store: TaskStore,
  taskId: string,
  task: Task,
  repos: WorkspaceRepoLandResult[],
): Promise<boolean> {
  const landed = repos.filter((r) => r.status === "landed" && r.landedSha);
  const workspaceLandedShas: Record<string, string> = {};
  for (const r of landed) workspaceLandedShas[r.repo] = r.landedSha!;
  const representative = landed.length > 0 ? landed[0].landedSha : undefined;
  const anyLanded = landed.length > 0;

  /*
  FNXC:Workspace 2026-06-22-04:10 (Phase C review A5 — fresh-read + no-swallow finalize):
  Two fixes to the FN-5627 TOCTOU class:
   1. The `task` argument is the SNAPSHOT captured at the START of `landWorkspaceTask`; by
      finalize time the persisted row has gained each repo's `landedSha` (and possibly other
      concurrent edits). Spreading the stale snapshot's mergeDetails could drop/clobber those.
      Re-read the LATEST task and spread ITS mergeDetails (fresh-read-then-merge), falling back
      to the snapshot only if the read fails.
   2. The `store.updateTask(...)` was `.catch(() => undefined)` — a swallowed write left the
      in-memory `mergeConfirmed:true` while the persisted row stayed stale (the finalize would
      then report done with an unpersisted merge). PROPAGATE the failure so finalization aborts
      and self-healing recovers, rather than silently finalizing on a stale row.
  */
  const fresh = await store.getTask(taskId).catch(() => undefined);
  const baseMergeDetails = fresh?.mergeDetails ?? task.mergeDetails;
  const mergeDetails: MergeDetails = {
    ...baseMergeDetails,
    ...(representative ? { commitSha: representative } : {}),
    ...(anyLanded ? { workspaceLandedShas } : {}),
    mergeConfirmed: anyLanded,
  };
  await store.updateTask(taskId, { mergeDetails });
  task.mergeDetails = mergeDetails;

  const result: MergeResult = {
    task,
    branch: task.branch ?? "",
    merged: anyLanded,
    noOp: !anyLanded,
    ok: true,
    reason: anyLanded ? undefined : "no-net-changes",
    commitSha: representative,
    mergeConfirmed: anyLanded,
    worktreeRemoved: false,
    branchDeleted: false,
  };
  await store.logEntry(taskId, `AI merge (workspace): all ${repos.length} sub-repo(s) landed — task → done`, "AiMerge").catch(() => undefined);
  await finalizeTask(store, taskId, result);
  return true;
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
      await log(`AI merge review (pass ${attempt + 1}): approved squash ${head}`);
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

/*
FNXC:MergePush 2026-07-11-22:25:
Push-after-merge for the unified AI merge path. The `pushAfterMerge` setting was only ever
implemented in the soft-deprecated legacy `aiMergeTask` pipeline (merger.ts step 8b), so after
master-plan U0 made `runAiMerge` the sole merge path the setting silently did nothing — merges
landed on the local integration ref and the remote fell permanently behind. This helper restores
the behavior without ever touching the user's working tree:

1. Fast path — a pure ref-to-ref `git push <remote> refs/heads/<ib>:refs/heads/<target>` from the
   project root. Push is working-tree-independent, so a dirty checkout or a checkout on a
   different branch can never break the common case (remote is simply behind or up to date).
2. Divergence path — a rejected non-fast-forward push means the remote gained commits the local
   ref lacks. Mirror the clean-room philosophy of the merge itself: build a throwaway DETACHED
   worktree at the local integration tip and run the legacy `pushToRemoteAfterMerge` pipeline
   inside it (`git pull --rebase` + AI conflict resolution + bounded non-FF retries), pushing
   `HEAD:refs/heads/<target>`. On success, CAS-advance the local integration ref to the rebased
   sha (explicit non-FF opt-in — rebase rewrites by construction) and run the standard
   merge-advance auto-sync so checkouts on that branch catch up.

Failures are ALWAYS non-fatal: the merge already landed locally, so the task finalization must
never be blocked or rolled back by a push problem. Outcome is surfaced via the `push:origin`
run-audit event, a task-log entry, and MergeResult.pushedToRemote/pushError.
*/
export async function pushAfterMergeToRemote(input: {
  store: TaskStore;
  projectRootDir: string;
  taskId: string;
  settings: Settings;
  integrationBranch: string;
  audit: RunAuditor;
  log: (message: string) => Promise<void>;
  signal?: AbortSignal;
  onAgentText?: (delta: string) => void;
  onSession?: (session: { dispose: () => void }) => void;
}): Promise<{ pushed: boolean; remote?: string; targetBranch?: string; refAdvanced?: boolean; rebasedSha?: string; error?: string }> {
  const { store, projectRootDir, taskId, settings, integrationBranch, audit, log, signal } = input;

  let remote: string;
  let targetBranch: string;
  try {
    const target = parsePushRemoteTarget(projectRootDir, settings.pushRemote, integrationBranch);
    remote = target.remote;
    targetBranch = target.branch;
  } catch (err: unknown) {
    return { pushed: false, error: `invalid push remote configuration: ${getErrorMessage(err)}` };
  }

  const localRef = `refs/heads/${integrationBranch}`;
  const localSha = await git(["rev-parse", "--verify", localRef], projectRootDir).catch(() => "");
  if (!localSha) {
    return { pushed: false, remote, targetBranch, error: `local integration ref ${localRef} not found` };
  }

  // 1. Fast path: ref-to-ref push, no working tree involved.
  throwIfAborted(signal, taskId);
  let fastPathError: string;
  try {
    await git(["push", remote, `${localRef}:refs/heads/${targetBranch}`], projectRootDir, { timeout: 120_000 });
    return { pushed: true, remote, targetBranch };
  } catch (err: unknown) {
    fastPathError = getErrorMessage(err);
  }
  if (!isNonFastForwardPushError(fastPathError)) {
    return { pushed: false, remote, targetBranch, error: fastPathError };
  }

  // 2. Divergence path: remote moved ahead — rebase in a detached clean room.
  await log(`Push after merge: ${remote}/${targetBranch} has diverged — rebasing in a clean room before pushing`);
  let pushRoot: string | undefined;
  let worktreeAdded = false;
  const registeredPaths = new Set<string>();
  try {
    pushRoot = await mkdtemp(join(resolveAiMergeRoot(projectRootDir, settings), `fusion-ai-merge-push-${taskId.toLowerCase()}-`));
    for (const p of [pushRoot]) {
      activeSessionRegistry.registerPath(p, { taskId, kind: "ai-merge", ownerKey: `ai-merge-push:${taskId}` });
      registeredPaths.add(p);
    }
    await git(["worktree", "add", "--detach", pushRoot, localSha], projectRootDir);
    worktreeAdded = true;
    let canonicalPushRoot = pushRoot;
    try {
      canonicalPushRoot = realpathSync(pushRoot);
    } catch {
      canonicalPushRoot = pushRoot;
    }
    if (!registeredPaths.has(canonicalPushRoot)) {
      activeSessionRegistry.registerPath(canonicalPushRoot, { taskId, kind: "ai-merge", ownerKey: `ai-merge-push:${taskId}` });
      registeredPaths.add(canonicalPushRoot);
    }

    const pushResult = await pushToRemoteAfterMerge(store, canonicalPushRoot, taskId, settings, {
      integrationBranch: targetBranch,
      pushHeadRefspec: true,
      signal,
      onAgentText: input.onAgentText,
      onSession: input.onSession,
    });
    if (!pushResult.pushed) {
      return { pushed: false, remote, targetBranch, error: pushResult.error };
    }

    // The clean-room HEAD is what the remote now has. Advance the local
    // integration ref to match (CAS against the pre-push tip; a concurrent
    // local advance loses the race and the NEXT merge's push reconciles).
    const rebasedSha = await git(["rev-parse", "HEAD"], canonicalPushRoot).catch(() => "");
    if (!rebasedSha || rebasedSha === localSha) {
      return { pushed: true, remote, targetBranch };
    }
    const adv = await advanceIntegrationBranchRef({
      rootDir: canonicalPushRoot,
      projectRootDir,
      integrationBranch,
      newSha: rebasedSha,
      expectedCurrentSha: localSha,
      taskId,
      audit,
      allowNonFastForward: true,
    });
    if (!adv.advanced) {
      await log(`Push after merge: pushed rebased result to ${remote}/${targetBranch}, but ${integrationBranch} moved concurrently — local ref left as-is (${adv.reason}); the next merge's push will reconcile`);
      return { pushed: true, remote, targetBranch, refAdvanced: false, rebasedSha };
    }
    const autoSyncMode = normalizeMergeAdvanceAutoSyncMode(settings.mergeAdvanceAutoSync);
    if (autoSyncMode !== "off") {
      try {
        await runMergeAdvanceAutoSync({
          store,
          audit,
          taskId,
          projectRootDir,
          integrationBranch,
          previousSha: localSha,
          newSha: rebasedSha,
          mode: autoSyncMode,
        });
      } catch (syncErr: unknown) {
        aiMergeLog.warn(`${taskId}: merge-advance auto-sync after push rebase threw — continuing: ${getErrorMessage(syncErr)}`);
      }
    }
    return { pushed: true, remote, targetBranch, refAdvanced: true, rebasedSha };
  } finally {
    for (const registeredPath of registeredPaths) {
      activeSessionRegistry.unregisterPath(registeredPath);
    }
    if (pushRoot) {
      await cleanupAiMergeWorktree({ taskId, mergeRoot: pushRoot, projectRootDir, worktreeAdded, audit, log });
    }
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
  mergeTarget?: MergeTargetResolution,
  groupRouting?: BranchGroupMergeRouting | null,
  syncGroupPr?: SyncGroupPrFn,
): Promise<MergeResult> {
  /*
  FNXC:BranchGroupCompletion 2026-07-04-00:00:
  FN-7532: stamp mergeTargetBranch/mergeTargetSource on every finalize path (landed AND no-op),
  not only the landed one — isBranchGroupMemberLanded needs both fields regardless of whether the
  landing produced a real commit, otherwise a no-op-finalized shared-group member would also be
  reported as not-landed forever.
  */
  const mergeTargetPatch: Pick<MergeDetails, "mergeTargetBranch" | "mergeTargetSource"> | undefined = mergeTarget
    ? { mergeTargetBranch: mergeTarget.branch, mergeTargetSource: mergeTarget.source }
    : undefined;
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
      ...mergeTargetPatch,
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
  } else if (mergeTargetPatch) {
    mergeDetails = { ...(task.mergeDetails ?? {}), ...mergeTargetPatch };
    await store.updateTask(taskId, { mergeDetails });
    task.mergeDetails = mergeDetails;
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
    /*
     * FNXC:WorkflowMerge 2026-06-29-21:38:
     * AI empty-merge finalization is durable proof, not a bypass: the clean-room merge loop reached this branch only after proving the task branch has no net diff against the integration tip. Persist mergeConfirmed for that no-op proof so workflow tasks do not stall in-review with missing-merge-confirmation, while the shared proof validator still rejects no-op rows that later show branch diff or landed files.
     */
    mergeConfirmed: true,
    worktreeRemoved,
    branchDeleted,
  };
  await audit.git({ type: "merge:ai-landed", target: integrationBranch, metadata: { taskId, landedSha, empty: opts.empty } }).catch(() => undefined);
  await log(opts.empty ? `AI merge: finalized ${taskId} (no-op), finalizing task row` : `AI merge: landed ${short(landedSha)}, finalizing task row`);
  const finalized = await finalizeTask(store, taskId, result, audit, log, projectRootDir);
  await log(opts.empty ? `AI merge: finalized ${taskId} (no-op) → done` : `AI merge: landed ${short(landedSha)}, task → done`);

  /*
  FNXC:BranchGroupCompletion 2026-07-04-00:00:
  FN-7532: mirror the legacy merger.ts executeMergeAttempt's shared-group landing bookkeeping so a
  member merged via the (now sole) runAiMerge path also updates the group row (worktreePath/status)
  and pushes the up-to-date checklist body onto any already-open managed group PR. Both are
  best-effort — a failure here must never fail an otherwise-successful merge.
  */
  if (groupRouting) {
    try {
      await Promise.resolve((store as { recordBranchGroupMemberLanded?: TaskStore["recordBranchGroupMemberLanded"] }).recordBranchGroupMemberLanded?.(groupRouting.branchGroup.id, {
        worktreePath: task.worktree ?? null,
        status: "open",
      }));
    } catch {
      // best-effort persistence
    }
    if (syncGroupPr) {
      try {
        await syncGroupPrOnLanding({
          store,
          groupId: groupRouting.branchGroup.id,
          cwd: projectRootDir,
          syncGroupPr,
        });
      } catch (err) {
        try {
          store.recordRunAuditEvent?.({
            taskId,
            agentId: "merger",
            runId: `merge-${taskId}`,
            domain: "git",
            mutationType: "merge:branch-group-pr-sync-failed",
            target: groupRouting.branchGroup.id,
            metadata: { groupId: groupRouting.branchGroup.id, error: err instanceof Error ? err.message : String(err) },
          });
        } catch {
          // best-effort audit
        }
      }
    }
  }

  return finalized;
}

/** Move the task to done and emit, mirroring the legacy completeTask. */
async function finalizeTask(
  store: TaskStore,
  taskId: string,
  result: MergeResult,
  audit?: RunAuditor,
  log?: (message: string) => Promise<void>,
  rootDir?: string,
): Promise<MergeResult> {
  const finalization = await finalizeProvenAutoMergeTask({
    store,
    taskId,
    result,
    audit,
    auditAgentId: "merger",
    auditPhase: "direct-ai-merge-finalize",
    source: "direct-ai-merge",
    rootDir,
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
