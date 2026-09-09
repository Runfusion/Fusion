import { commitIdentityArgs, resolveCommitIdentity } from "../git-identity.js";
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
  evaluatePreMergeApprovals,
  getPlannerInterventionTimeline,
  getPrimaryPrInfo,
  getTaskMergeBlocker,
  isFusionDeletableBranch,
  isPreMergeStepsNotRunBlocker,
  PreMergeStepsNotRunError,
  normalizeMergeAdvanceAutoSyncMode,
  resolvePersistAgentThinkingLog,
  resolveTaskMergeTarget,
  resolveValidatorSettingsModel,
  resolveMergerFallbackModel,
  resolveContainedBackwardTarget,
  resolveTerminalColumns,
  resolveWorkflowIrForTask,
  resolveRequiredPreMergeStepIds,
  resolvePreMergeGateForTask,
  type MergeDetails,
  type MergeResult,
  type MergeTargetResolution,
  type Settings,
  resolveEngineIncarnationId,
  resolveEngineNodeId,
  type Task,
  type TaskStore,
  type WorkspaceLeaseHandle,
  resolveReviewColumns,
} from "@fusion/core";
import { selectUserCommentsForAgentContext } from "../agents/agent-user-comments.js";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import { captureMergeContentDescriptor } from "./merge-content-capture.js";
import { probeReviewDiffFingerprint } from "../worktree/review-diff-fingerprint.js";
import { isMergeActiveStatus, shouldClearOrphanedMergeStamp } from "./merge-active-status.js";

import { recordWorkspaceBaseBranchDecision, resolveWorkspaceRepoBaseBranch } from "../worktree/workspace-base-branch.js";
import { captureWorkspaceReviewEvidence } from "../worktree/workspace-review-evidence.js";
import { advanceIntegrationBranchRef } from "./merger-ref-update-advance.js";
import { enforceAiMergeSquashGates } from "./merger-ai-squash-gates.js";
import {
  assertMergeGenerationOwned,
  createMergeWriteFence,
  isMergeAbortedError,
  type MergeWriteFence,
} from "./merge-write-fence.js";
import { createResolvedAgentSession, resolveMergerSessionModel, resolveMergerThinkingLevel, resolveMergerFallbackThinkingLevel, resolveValidatorThinkingLevel } from "../agents/agent-session-helpers.js";
import { promptWithFallback } from "../pi.js";
import { AgentLogger } from "../agents/agent-logger.js";
import { attachAgentUsageTelemetry, emitAgentSessionStart } from "../agents/agent-usage-telemetry.js";
import { withRateLimitRetry } from "../errors/rate-limit-retry.js";
import { checkSessionError } from "../errors/usage-limit-detector.js";
import { accumulateSessionTokenUsage } from "../execution/session-token-usage.js";
import { moveTaskToContainedBackwardTarget } from "../execution/lifecycle-move.js";
import { createRunAuditor, generateSyntheticRunId, type RunAuditor } from "../util/run-audit.js";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import { deriveExecutorSignalMemory, evaluateNoOpFinalizeExecutorVeto } from "../overseer/overseer-noop-finalize-veto.js";
import { createLogger } from "../logger.js";
import {
  buildAutostashLabel,
  captureSingleCommitLandedMetadata,
  isNonFastForwardPushError,
  isRebaseInProgress,
  parsePushRemoteTarget,
  pushWithTransientRetries,
  pushToRemoteAfterMerge,
  runMergeAdvanceAutoSync,
  syncGroupPrOnLanding,
  type MergerOptions,
} from "../merger.js";
import { resolveBranchGroupMergeRouting, type BranchGroupMergeRouting, type SyncGroupPrFn } from "./group-merge-coordinator.js";
import { DEFAULT_COMMIT_AUTHOR_EMAIL, DEFAULT_COMMIT_AUTHOR_NAME } from "../worktree/worktree-hooks.js";
import { describeDependencySyncDecision, installWorktreeDependencies, LOCKFILE_CANDIDATES} from "./merge-dependency-sync.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { MergeGateRevokedError } from "./merger-errors.js";
import { cleanupLandedTaskWorktree, cleanupLandedWorkspaceTaskWorktrees } from "./post-landing-worktree-cleanup.js";
import { resolveMcpServersForStore } from "../mcp/mcp-resolution.js";
/*
FNXC:Workspace 2026-06-22-14:10 (Phase D review G — cycle dissolved):
`isRepoLanded` + `FUSION_TASK_ID_TRAILER_KEY` moved to the dependency-free `workspace-land-predicate`
module so self-healing can import the predicate without re-entering the self-healing ↔ merger-ai
import cycle (merger-ai-worktree imports `MIN_TEMP_WORKTREE_REAP_AGE_MS` from self-healing).
*/
import { isRepoLanded, findProvenLandedCommit, FUSION_TASK_ID_TRAILER_KEY } from "./workspace-land-predicate.js";
import { resolveWorkspaceMergeReadiness } from "./workspace-merge-readiness.js";
import { persistWorkspaceRepoLandFailure } from "./workspace-land-failure.js";
import { ensureTenancyFenceRef, mergeDispatchFenceRef, publishWorkspaceIntegrationRef, WorkspaceFenceRefError, workspaceLandFenceRef } from "./workspace-fence-ref.js";
import { isPushAfterMergeEnabled } from "./push-after-merge-policy.js";
import { resolveWorkspaceIntegrationTarget, WorkspaceEnvironmentError, WorkspaceIntegrationTargetError, type WorkspaceIntegrationTarget } from "./workspace-integration-target.js";
import { finalizeProvenAutoMergeTask } from "./auto-merge-finalization.js";
import { getCommitTaskOwnership, detectAlreadyLandedOnMain } from "./already-merged-detector.js";
import { resolveAiMergeSearchRoots } from "../worktree/worktree-paths.js";
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
  isAiMergeProtocolLine,
  parseReviewVerdict,
} from "./merger-ai-prompts.js";

const execFileAsync = promisify(execFile);
const aiMergeLog = createLogger("merger-ai");

/**
 * FNXC:RunAudit 2026-08-20-05:22:
 * FN-9175 requires an aborted merge to retain its original terminal signal before optional PR
 * sync telemetry is considered. This production helper makes that ordering independently
 * executable while retaining the fire-and-forget audit contract for ordinary sync failures.
 */
/*
 * FNXC:ReviewGatedRemediation 2026-08-23-05:23:
 * The AI empty-merge path must carry the selected workflow's required gates into the shared
 * zero-diff guard; otherwise a review-gated card can finalize before deterministic verification.
 */
async function resolveNoOpFinalizeGateIds(store: TaskStore, task: Task): Promise<ReadonlySet<string> | undefined> {
  const selection = store.getTaskWorkflowSelectionAsync
    ? await store.getTaskWorkflowSelectionAsync(task.id)
    : store.getTaskWorkflowSelection?.(task.id);
  if (!selection) return undefined;
  const ir = await resolveWorkflowIrForTask(store, task.id).catch(() => undefined);
  return ir ? resolveRequiredPreMergeStepIds(ir, task.enabledWorkflowSteps) : undefined;
}

export function recordBranchGroupPrSyncFailureAudit(
  store: RunAuditSinkHost,
  taskId: string,
  groupId: string,
  error: unknown,
): void {
  if (isMergeAbortedError(error)) throw error;
  void emitBoundedRunAudit(store, {
    taskId,
    agentId: "merger",
    runId: `merge-${taskId}`,
    domain: "git",
    mutationType: "merge:branch-group-pr-sync-failed",
    target: groupId,
    metadata: { groupId, error: error instanceof Error ? error.message : String(error) },
  }, { log: aiMergeLog });
}

const MAX_CONCURRENT_ADVANCE_RETRIES = 3;

/*
FNXC:MergeReliability 2026-08-09-23:09:
A generation that lost `raceMergeWithAbort` can outlive the settle latch while a successor owns
this task. Its aborted signal is the write-authority fence: suppressing every transient status
write prevents the orphan from re-stamping `merging` or clearing the successor's live stamp.
Diagnostics remain unfenced, and this deliberately resolves rather than throws for finally paths.

FNXC:MergeReliability 2026-08-10-19:27:
FN-8923 records this narrow fence's durable-write frontier in
`merge-orphan-durable-write-inventory.json`. New writes in its pinned merge closure must be
classified by the AST guard, which runs in engine affected/full-suite lanes rather than the
curated merge gate; completeness is only over that pinned closure and writer surface.
*/
export function writeTransientMergeStatus(
  store: Pick<TaskStore, "updateTask">,
  taskId: string,
  signal: AbortSignal | undefined,
  status: string | null,
): Promise<unknown> {
  const fence = createMergeWriteFence({ taskId, signal });
  return fence.write("lifecycle", () => store.updateTask(taskId, { status }).catch(() => undefined));
}

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

const MAX_BLOCKING_REVIEW_REASONS = 8;

function normalizeBlockingReviewReason(reason: string): string {
  return reason.trim().toLocaleLowerCase().replace(/[\s\p{P}]+/gu, " ").trim();
}

function boundBlockingReviewReasons(reasons: readonly string[]): string[] {
  const seen = new Set<string>();
  const bounded: string[] = [];
  for (const reason of reasons) {
    const display = reason.trim().replace(/\s+/g, " ");
    const key = normalizeBlockingReviewReason(display);
    if (!key || isAiMergeProtocolLine(display) || seen.has(key)) continue;
    seen.add(key);
    bounded.push(display);
    if (bounded.length === MAX_BLOCKING_REVIEW_REASONS) break;
  }
  return bounded;
}

type PreexistingAiMergeRecoveryCandidate = {
  mergeRoot: string;
  squashSha: string;
  tipSha: string;
  alreadyLanded: boolean;
};

function listAiMergeWorktreeCandidates(taskId: string, projectRootDir: string, settings?: Settings): string[] {
  const prefix = `fusion-ai-merge-${taskId.toLowerCase()}-`;
  const roots = Array.from(new Set([resolveAiMergeRoot(projectRootDir, settings), ...resolveAiMergeSearchRoots(projectRootDir, settings), tmpdir()]));
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
  branch: string,
  integrationBranch: string,
  ctx: LandRepoContext,
): Promise<LandOneRepoResult | null> {
  const { taskId, settings, store, audit, log, allowDirtyLocalCheckoutSync, stashResolveAgent, signal } = ctx;
  throwIfAborted(signal, taskId);
  const task = await store.getTask(taskId).catch(() => undefined);
  const state = task?.aiMergeReviewReconciliation;
  const sourceSha = await git(["rev-parse", "--verify", branch], repoRootDir);
  const tipSha = await git(["rev-parse", "--verify", `refs/heads/${integrationBranch}`], repoRootDir);
  /*
  FNXC:AIMergeReviewReconciliation 2026-08-20-22:27:
  Recovery may land only the durable, twice-confirmed candidate for the current source and
  integration identities. Task-log prose is audit history, never authority to revive a squash.
  */
  if (!state?.candidateSha || state.consecutiveCleanApprovals < 2 || state.sourceSha !== sourceSha || state.integrationTipSha !== tipSha) return null;
  const recoverableCandidates: PreexistingAiMergeRecoveryCandidate[] = [];
  for (const candidate of listAiMergeWorktreeCandidates(taskId, repoRootDir, settings)) {
    let mergeRoot = candidate;
    try { mergeRoot = realpathSync(candidate); } catch { /* keep original */ }
    if (activeSessionRegistry.isPathActive(candidate) || activeSessionRegistry.isPathActive(mergeRoot)) continue;

    try {
      throwIfAborted(signal, taskId);
      const squashSha = await git(["rev-parse", "--verify", "HEAD"], mergeRoot);
      if (!squashSha || squashSha === tipSha || squashSha !== state.candidateSha) continue;
      if (state.candidateTreeSha && await git(["rev-parse", `${squashSha}^{tree}`], mergeRoot) !== state.candidateTreeSha) continue;
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
  FNXC:AIMergeReviewReconciliation 2026-08-20-22:27:
  A recovered clean room is safe only after structured reconciliation has bound its exact
  candidate SHA/tree and current source/integration identity. Ambiguous candidates defer to a
  fresh merge rather than turning historical review text into landing authority.
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
    if (!task) throw new Error(`AI merge task ${taskId} disappeared before recovery squash gates`);
    await enforceAiMergeSquashGates({ store, task, taskId, mergeRoot: selected.mergeRoot, branch, tipSha: selected.tipSha, squashSha: selected.squashSha, audit, log, repoRel: ctx.repoRel, repoKeys: ctx.repoKeys });
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
      signal,
      assertMergeGateStillOpen: () => assertMergeGateStillOpen(ctx, repoRootDir, ctx.repoRel),
    });
    if (land.outcome !== "advanced") return null;
    await store.updateTask(taskId, { aiMergeReviewReconciliation: null });
    await log(`AI merge: recovered approved pre-existing clean-room commit ${short(selected.squashSha)} before pruning`);
    await audit.git({ type: "merge:ai-landed", target: integrationBranch, metadata: { taskId, landedSha: selected.squashSha, source: "pre-prune-clean-room-recovery", mergeRoot: selected.mergeRoot } }).catch(() => undefined);
    return { outcome: "landed", squashSha: selected.squashSha, localSync: land.localSync, tipSha: selected.tipSha, integrationBranch, dependencySyncDecision: "recovered-no-new-sync" };
  }

  await store.updateTask(taskId, { aiMergeReviewReconciliation: null });
  await log(`AI merge: recovered already-landed clean-room commit ${short(selected.squashSha)} before pruning`);
  return { outcome: "landed", squashSha: selected.squashSha, localSync: "skipped-other-branch", tipSha: selected.tipSha, integrationBranch, dependencySyncDecision: "recovered-no-new-sync" };
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

  /*
  FNXC:GitIdentity 2026-08-18-07:55:
  This amend does not go through merger.ts's mergerCommitEnv, so it needs the identity applied to its
  own argv — otherwise it is the one Fusion commit that still depends on ambient git config and fails
  on a host that has none.
  */
  const args = [...commitIdentityArgs(resolveCommitIdentity()), "-c", "trailer.ifExists=addIfDifferent", "commit", "--amend"];
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
  AI_MERGE_PROTOCOL_MARKERS,
  PRIOR_FINDING_DISPOSITIONS_MARKER,
  REVIEW_VERDICT_MARKER,
  RESOLVED_PRIOR_FINDINGS_MARKER,
  SEVERITY_MARKER,
  buildMergePrompt,
  buildMergeSystemPrompt,
  buildReviewPrompt,
  buildReviewSystemPrompt,
  buildStashResolvePrompt,
  buildStashResolveSystemPrompt,
  isAiMergeProtocolLine,
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

/**
 * FNXC:AIMergeReviewReconciliation 2026-08-20-22:38:
 * A dismissal or source/tip replacement invalidates the entire reconciliation episode. The
 * clean-room caller catches this sentinel and starts a fresh episode rather than allowing a
 * reviewer response captured against stale state to recreate the dismissed candidate.
 */
class AiMergeReviewReconciliationInvalidatedError extends Error {
  constructor() {
    super("AI merge review reconciliation was invalidated during review");
    this.name = "AiMergeReviewReconciliationInvalidatedError";
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
    const task = await store.getTask(taskId).catch(() => undefined);
    const model = resolveMergerSessionModel(settings, undefined, task);
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
    { attachAgentUsageTelemetry(logger, { store, agentId: task?.assignedAgentId ?? null, taskId, nodeId: task?.effectiveNodeId ?? task?.nodeId ?? null, model: model.modelId ?? null, provider: model.provider ?? null, lane: "merger" }); }

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
      ...(model.credentialInstanceId ? { credentialInstanceId: model.credentialInstanceId } : {}),
      fallbackProvider: mergerFallbackModel.provider,
      fallbackModelId: mergerFallbackModel.modelId,
      fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings, task?.mergerThinkingLevel),
      defaultThinkingLevel: resolveMergerThinkingLevel(settings, task?.mergerThinkingLevel),
      runAuditor: audit,
      settings,
      // FNXC:McpConfig 2026-06-25-22:48: merger-ai is the production merge path, so the mutating agent resolves enabled MCP servers at session creation and relies on the shared runtime guard for unsupported providers.
      mcpServers: (await resolveMcpServersForStore(store)).servers,
      taskId,
    });
    emitAgentSessionStart({ store, agentId: task?.assignedAgentId ?? null, taskId, nodeId: task?.effectiveNodeId ?? task?.nodeId ?? null, model: model.modelId ?? null, provider: model.provider ?? null, lane: "merger" });
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
    const task = await store.getTask(taskId).catch(() => undefined);
    const validator = resolveValidatorSettingsModel(settings);
    const model = validator.provider && validator.modelId ? validator : resolveMergerSessionModel(settings, undefined, task);
    // FNXC:Settings-MergerModel 2026-07-16-00:00: review merger retries share the dedicated merger fallback provider/model and thinking lane.
    const mergerFallbackModel = resolveMergerFallbackModel(settings);
    // FNXC:Settings-ThinkingLevel 2026-07-10-00:00: The review agent's model falls back
    // between the validator lane and the merger default lane, so its thinking level
    // must follow the same lane it actually resolved a model from.
    const reviewThinkingLevel = validator.provider && validator.modelId
      ? resolveValidatorThinkingLevel(undefined, settings)
      : resolveMergerThinkingLevel(settings, task?.mergerThinkingLevel);
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
    { attachAgentUsageTelemetry(logger, { store, agentId: task?.assignedAgentId ?? null, taskId, nodeId: task?.effectiveNodeId ?? task?.nodeId ?? null, model: model.modelId ?? null, provider: model.provider ?? null, lane: "merger" }); }

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
      ...(model.credentialInstanceId ? { credentialInstanceId: model.credentialInstanceId } : {}),
      fallbackProvider: mergerFallbackModel.provider,
      fallbackModelId: mergerFallbackModel.modelId,
      fallbackThinkingLevel: resolveMergerFallbackThinkingLevel(settings, task?.mergerThinkingLevel),
      defaultThinkingLevel: reviewThinkingLevel,
      runAuditor: audit,
      settings,
      // FNXC:McpConfig 2026-06-25-22:48: The production merge reviewer receives the same materialized MCP set as the mutating merge agent, preserving all-lane forwarding without logging server contents.
      mcpServers: (await resolveMcpServersForStore(store)).servers,
      taskId,
    });
    emitAgentSessionStart({ store, agentId: task?.assignedAgentId ?? null, taskId, nodeId: task?.effectiveNodeId ?? task?.nodeId ?? null, model: model.modelId ?? null, provider: model.provider ?? null, lane: "merger" });
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
  signal?: AbortSignal;
  /** FNXC:Workspace 2026-08-15-08:36: Workspace lands advance the shared remote under a durable tenant fence before local sync. */
  workspaceFence?: { remote: string; fenceRefName: string; fenceRefSha: string };
  /** A task-scoped dispatch pin supplements the repo pin for a workspace merge body. */
  workspaceDispatchFence?: { fenceRefName: string; fenceRefSha: string };
  /** Re-reads the task's positive review gate immediately before ref mutation. */
  assertMergeGateStillOpen?: () => Promise<void>;
  /** Records a repository-scoped observation when a fenced target CAS is safely re-observed. */
  onWorkspaceRepublish?: (observedTargetSha?: string) => Promise<void> | void;
}): Promise<LandResult> {
  const { projectRootDir, mergeRoot, integrationBranch, tipSha, squashSha, taskId, audit, resolveConflicts, allowDirtyLocalCheckoutSync = false, signal, workspaceFence, workspaceDispatchFence, assertMergeGateStillOpen, onWorkspaceRepublish } = input;
  const emit = (outcome: LocalSyncOutcome, extra: Record<string, unknown> = {}) =>
    audit.git({ type: "merge:ai-local-sync", target: integrationBranch, metadata: { taskId, outcome, squashSha, ...extra } }).catch(() => undefined);

  const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], projectRootDir).catch(() => "");
  let sharedRefAdvanced = false;
  const advanceSharedWorkspaceRef = async (): Promise<void> => {
    if (!workspaceFence || sharedRefAdvanced) return;
    const publication = await publishWorkspaceIntegrationRef({
      cwd: mergeRoot,
      remote: workspaceFence.remote,
      sourceSha: squashSha,
      targetRef: `refs/heads/${integrationBranch}`,
      expectedTargetSha: tipSha,
      fenceRefName: workspaceFence.fenceRefName,
      fenceRefSha: workspaceFence.fenceRefSha,
      ...(workspaceDispatchFence ? { additionalFenceRefs: [workspaceDispatchFence] } : {}),
    });
    if (publication.republishedFromObservedTip) {
      await onWorkspaceRepublish?.(publication.observedTargetSha);
    }
    sharedRefAdvanced = true;
  };

  // Case B — target not checked out here: bare CAS ref advance.
  if (currentBranch !== integrationBranch) {
    assertMergeGenerationOwned(signal, taskId);
    await assertMergeGateStillOpen?.();
    await advanceSharedWorkspaceRef();
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
    assertMergeGenerationOwned(signal, taskId);
    await assertMergeGateStillOpen?.();
    await advanceSharedWorkspaceRef();
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
  assertMergeGenerationOwned(signal, taskId);
  await assertMergeGateStillOpen?.();
  await advanceSharedWorkspaceRef();
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
activeSessionRegistry register/unregister + cleanup-finally. Single-repo callers advance one local
integration ref; workspace callers pin a durable tenancy fence and atomically advance the shared
remote integration ref before reconciling their local ref. It deliberately does NOT
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
  /** Workspace repo-local File Scope context; omitted for single-repo lands. */
  repoRel?: string;
  repoKeys?: readonly string[];
  /*
  FNXC:MergeNoCommits 2026-07-17-12:00:
  When true, the task is expected to produce no code changes (audit, documentation, decision-only).
  The clean-room dependency sync is skipped entirely because there are no source changes to install
  or build. Avoiding the dep-sync prevents "pnpm: command not found" failures when pnpm is not
  resolvable in the engine process environment, and avoids unnecessary work.
  */
  noCommitsExpected?: boolean;
  /** FNXC:Workspace 2026-08-15-08:36: Present only for workspace sub-repos; it fences the durable intent and remote ref advance. */
  workspaceLand?: { getHandle: () => WorkspaceLeaseHandle; repoRelPath: string; remote: string; assertLive: () => void };
  /** FNXC:WorkspaceMergeDispatch 2026-08-15-22:55: Task-level pin that fences every merge-body ref advance. */
  workspaceDispatchFence?: { fenceRefName: string; fenceRefSha: string };
  /** The admission descriptor is refreshed at the ref-advance boundary. */
  mergeContent?: import("@fusion/core").MergeContentDescriptor;
  store: TaskStore;
}

async function assertMergeGateStillOpen(
  ctx: LandRepoContext,
  projectRootDir: string,
  repository?: string,
): Promise<void> {
  /*
  FNXC:MergeGateRecheck 2026-08-23-08:51:
  FN-180 requires a durable read at the ref-advance boundary. A lightweight or dry-run store that
  cannot read the current task must refuse landing rather than bypass a REVISE or review-lane exit.
  */
  if (typeof ctx.store.getTask !== "function") {
    throw new MergeGateRevokedError(`Merge gate revoked for ${ctx.taskId}: current task could not be read`);
  }
  const task = await ctx.store.getTask(ctx.taskId).catch(() => {
    throw new MergeGateRevokedError(`Merge gate revoked for ${ctx.taskId}: current task could not be read`);
  });
  let gate;
  try {
    gate = await resolvePreMergeGateForTask(ctx.store, task.id, task.enabledWorkflowSteps, task);
  } catch {
    throw new MergeGateRevokedError(`Merge gate revoked for ${task.id}: task workflow could not be resolved`);
  }
  if (gate.provenance === "default" && !gate.selectionAbsent) {
    throw new MergeGateRevokedError(`Merge gate revoked for ${task.id}: task workflow could not be resolved`);
  }

  let mergeContent = ctx.mergeContent;
  if (mergeContent?.kind === "workspace" && repository) {
    const entry = task.workspaceWorktrees?.[repository];
    const baseRef = entry?.baseCommitSha ?? (entry
      ? await resolveWorkspaceRepoBaseBranch({
        mode: "recorded", repoRootDir: projectRootDir, repoRelPath: repository,
        task, settings: ctx.settings, recordedBaseBranch: entry.baseBranch,
      }).then((resolved) => git(["merge-base", resolved.branch, entry.branch], projectRootDir)).catch(() => undefined)
      : undefined);
    const probe = await probeReviewDiffFingerprint(projectRootDir, baseRef, entry?.branch);
    mergeContent = probe.state === "fingerprint" && mergeContent.repositories.state === "captured"
      ? { kind: "workspace", repositories: { state: "captured", inScopeModified: mergeContent.repositories.inScopeModified, fingerprints: { ...mergeContent.repositories.fingerprints, [repository]: probe.fingerprint } } }
      : { kind: "workspace", repositories: { state: "unavailable", reason: "workspace-repository-fingerprint-unavailable" } };
  } else if (!mergeContent) {
    mergeContent = await captureMergeContentDescriptor(task, { workspaceRootDir: projectRootDir, settings: ctx.settings });
  }

  /*
  FNXC:MergeGateRecheck 2026-08-24-04:35:
  FN-184: this fence re-reads the task from the store, so by construction it observes the
  `status:"merging"` stamp `runAiMerge` wrote for THIS merge. `merging`/`merging-pr` are in
  HARD_BLOCKING_TASK_STATUSES, so without neutralization the fence revokes the very merge it is
  guarding and no ref ever advances. This is the same defect as the ProjectEngine in-flight watcher
  and must stay fixed in both places: the watcher abort alone still left the merge dying here.
  Only the owned task's own execution bookkeeping is cleared — a real REVISE, a review-lane exit,
  `paused`, `queued`, or any other blocking status still revokes.
  */
  const gateView: Task = isMergeActiveStatus(task.status) ? { ...task, status: undefined } : task;
  const blocker = getTaskMergeBlocker(gateView, {
    reviewColumns: gate.reviewColumns.size ? gate.reviewColumns : new Set(["in-review"]),
    requiredPreMergeStepIds: gate.requiredPreMergeStepIds,
    mergeContent,
  });
  if (blocker) throw new MergeGateRevokedError(`Merge gate revoked for ${task.id}: ${blocker}`);
}

/** What a single repo's land produced. No task move / mergeDetails — the caller
 *  decides task-global finalization. */
export type LandOneRepoResult =
  | {
      /** The branch had no net changes vs the integration tip — nothing landed. */
      outcome: "empty";
      tipSha: string;
      integrationBranch: string;
      dependencySyncDecision: string;
    }
  | {
      /** The squash landed; the local integration ref now points at `squashSha`. */
      outcome: "landed";
      squashSha: string;
      localSync: LocalSyncOutcome;
      tipSha: string;
      integrationBranch: string;
      dependencySyncDecision: string;
    };

/**
 * Land `branch` through a repo-scoped clean room, retrying on concurrent advance.
 * Workspace contexts publish the shared integration ref under their durable fence;
 * standalone contexts retain the local-only land contract. See the FNXC note above.
 */
// FNXC:Workspace 2026-08-15-08:36: `landOneRepo` receives the TaskStore through its context so
// workspace land intents are written immediately before the fenced shared-ref advance. The former
// leading store parameter stays absent; context keeps all task-bound dependencies explicit.
export async function landOneRepo(
  repoRootDir: string,
  branch: string,
  integrationBranch: string,
  ctx: LandRepoContext,
): Promise<LandOneRepoResult> {
  const {
    taskId, settings, audit, log: baseLog, setStatus, maxPasses,
    mergeAgent, reviewAgent, stashResolveAgent,
    includeTaskId, trailers, taskTitle, signal, store,
  } = ctx;
  /*
  FNXC:WorkspaceMergeLogs 2026-08-29-07:28:
  A workspace task lands one clean room per repository. Prefix the existing task-scoped logger
  once at the per-repository body boundary so clean-room, dependency-sync, review, and ref-advance
  lines all identify the repository without adding durable-write call sites or changing single-repo
  wording.
  */
  const repoRelPath = ctx.repoRel;
  const log = repoRelPath
    ? async (message: string) => baseLog(formatRepositoryMergeLog(repoRelPath, message))
    : baseLog;
  const repoContext = repoRelPath ? { ...ctx, log } : ctx;
  let dependencySyncDecision = "not-run";

  // If a prior merger died after the clean-room squash was approved but before
  // landing/finalization, land that commit before the normal pre-merge prune can
  // delete the only easy reference to it.
  const recovered = await recoverApprovedPreexistingAiMergeWorktree(repoRootDir, branch, integrationBranch, repoContext);
  if (recovered) return { ...recovered, dependencySyncDecision: "recovered-no-new-sync" };

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
  // Structured reconciliation state is read by mergeAndReview; task logs are not a fallback authority.
  let outstandingReviewReasons: string[] = [];
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
    /*
    FNXC:MergeReviewBlockers 2026-07-21-21:45:
    Zero commits ahead is only an unconditional no-op when no durable blocker remains. A retry after reset, rebase, or prior integration must still review the complete integration tree before clearing previously rejected correctness concerns.
    */
    if (Number.parseInt(aheadRaw.trim(), 10) === 0 && outstandingReviewReasons.length === 0) {
      await audit.git({ type: "merge:ai-empty", target: integrationBranch, metadata: { taskId, tipSha } });
      return { outcome: "empty", tipSha, integrationBranch, dependencySyncDecision: "not-run-empty" };
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
      /*
      FNXC:MergeNoCommits 2026-07-17-12:00:
      No-commits tasks (audit, documentation, decision-only) have no code changes to install or
      build. Skip the entire dependency-sync step in the clean-room worktree to avoid "pnpm: command
      not found" when pnpm is not resolvable in the engine process environment. The merge/review
      agents still run (they may verify documentation or produce merge metadata); only the
      dependency install is skipped.
      */
      /*
      FNXC:MergeNoCommits 2026-07-30-19:20 (PR #2501 review — greptile P1, and the flag alone is not
      safe to trust here):
      THE BRANCH IS KNOWN TO HAVE COMMITS AT THIS POINT. The `rev-list --count` short-circuit above
      returns `outcome: "empty"` when the branch is zero commits ahead, so control only reaches this
      line when it is AHEAD. `noCommitsExpected` is a task-level EXPECTATION set before execution,
      and nothing revalidates it against what actually landed on the branch — the two empty-lane
      guards below (#2259 already-landed proof, FN-8141 executor veto) both explicitly carve out
      `noCommitsExpected` tasks, so they cannot catch the inverse case either.

      So skipping on the flag alone means: a task marked no-commits whose executor did commit a
      manifest or lockfile change gets its dependency install AND its frozen-lockfile validation
      skipped, and the change lands unvalidated. That is the review finding, and it is reachable
      rather than hypothetical.

      Gate on the DIFF instead. The flag still expresses intent — it is what makes us look — but the
      skip now requires that the branch genuinely touches no dependency-relevant file. A branch that
      does touch one falls through to the normal sync, which is the behaviour that existed before
      this option and the one the lockfile guard depends on.

      Fail-safe on an unreadable diff: `git` errors yield "", which contains no manifest path, so we
      would skip. Treat a FAILED diff as "cannot prove it is safe" and sync, matching the hard-fail
      contract documented directly above.
      */
      let noCommitsDepsSkipAllowed = ctx.noCommitsExpected === true;
      if (noCommitsDepsSkipAllowed) {
        const changedRaw = await git(["diff", "--name-only", `${integrationBranch}...${branch}`], repoRootDir)
          .catch(() => null);
        if (changedRaw === null) {
          noCommitsDepsSkipAllowed = false;
          await log(`AI merge: no-commits task, but the branch diff could not be read — running dependency sync rather than assuming it is safe to skip`);
        } else {
          const changedFiles = changedRaw.split("\n").map((line) => line.trim()).filter(Boolean);
          const dependencyFiles = changedFiles.filter((file) => {
            const name = file.split("/").pop() ?? file;
            return name === "package.json" || LOCKFILE_CANDIDATES.includes(name);
          });
          if (dependencyFiles.length > 0) {
            noCommitsDepsSkipAllowed = false;
            await log(`AI merge: task is marked no-commits but its branch changes ${dependencyFiles.length} dependency file(s) (${dependencyFiles.slice(0, 3).join(", ")}) — running dependency sync so the lockfile is still validated`);
            await audit.git({
              type: "merge:ai-deps-sync",
              target: integrationBranch,
              metadata: { taskId, tipSha, mergeRoot: canonicalMergeRoot, noCommitsExpected: true, dependencyFileCount: dependencyFiles.length, skipOverridden: true },
            });
          }
        }
      }
      if (noCommitsDepsSkipAllowed) {
        dependencySyncDecision = "skipped-no-commits";
        await log(`AI merge: skipping dependency sync — no-commits task (no code changes expected)`);
      } else {
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
        dependencySyncDecision = `failed-nonfatal; deps-unavailable; reason=${depsErrMessage}`;
        await log(`AI merge (workspace): dependency sync FAILED for this sub-repo's clean room — landing without dep-dependent verification (deps unavailable): ${depsErrMessage}`);
        await audit.git({
          type: "merge:ai-deps-sync",
          target: integrationBranch,
          metadata: { taskId, tipSha, mergeRoot: canonicalMergeRoot, failed: true, nonFatal: true, error: depsErrMessage, durationMs: Date.now() - depsSyncStartedAt },
        });
      }
      if (depsSyncResult) {
        dependencySyncDecision = describeDependencySyncDecision(depsSyncResult);
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
      await log(`[timing] AI merge dependency sync completed: ${depsSyncResult
        ? describeDependencySyncDecision(depsSyncResult)
        : `failed-nonfatal; duration=${Date.now() - depsSyncStartedAt}ms; deps-unavailable`}`);
      }

      // 2 + 3. Merge + review loop (corrective passes).
      let reviewResult: Awaited<ReturnType<typeof mergeAndReview>>;
      try {
        reviewResult = await mergeAndReview({
          mergeRoot, branch, integrationBranch, tipSha, taskTitle, includeTaskId, trailers, taskId,
          maxPasses, mergeAgent, reviewAgent, audit, log, setStatus, store, signal,
          initialPriorReasons: outstandingReviewReasons,
        });
      } catch (error) {
        if (error instanceof AiMergeReviewReconciliationInvalidatedError) {
          await log("AI merge: reconciliation episode changed during review — rebuilding from current source and integration identities");
          continue;
        }
        throw error;
      }
      const squashSha = reviewResult.squashSha;
      outstandingReviewReasons = reviewResult.priorReasons;

      if (!squashSha) {
        // Branch had no net changes vs the tip — nothing to land. The caller
        // decides how to finalize the (possibly multi-repo) task.
        await audit.git({ type: "merge:ai-empty", target: integrationBranch, metadata: { taskId, tipSha } });
        return { outcome: "empty", tipSha, integrationBranch, dependencySyncDecision };
      }

      /*
       * FNXC:AIMerge 2026-08-15-22:55:
       * This is the sole production pre-land seam: the reviewer approved the
       * clean-room squash but the integration ref has not advanced, so scope and
       * shrinkage violations can still leave every integration branch untouched.
       */
      const freshTask = await store.getTask(taskId);
      if (!freshTask) throw new Error(`AI merge task ${taskId} disappeared before squash gates`);
      await enforceAiMergeSquashGates({ store, task: freshTask, taskId, mergeRoot, branch, tipSha, squashSha, audit, log, repoRel: ctx.repoRel, repoKeys: ctx.repoKeys });

      // FNXC:Workspace 2026-08-15-08:36: Persist the recovery intent before the shared ref can
      // move. A later reconciler can then settle an interrupted remote advance without re-squashing.
      let workspaceFence: { remote: string; fenceRefName: string; fenceRefSha: string } | undefined;
      if (ctx.workspaceLand) {
        ctx.workspaceLand.assertLive();
        const { repoRelPath, remote } = ctx.workspaceLand;
        const handle = ctx.workspaceLand.getHandle();
        if (!handle.fenceRefName || !handle.fenceRefSha) {
          throw new Error(`Workspace land lease ${handle.leaseKey} is missing its fence pin`);
        }
        await store.recordWorkspaceLandIntent({
          handle,
          taskId,
          repoRelPath,
          remoteUrl: await git(["remote", "get-url", remote], repoRootDir),
          integrationRef: `refs/heads/${integrationBranch}`,
          intendedSha: squashSha,
          expectedTip: tipSha,
        });
        workspaceFence = { remote, fenceRefName: handle.fenceRefName, fenceRefSha: handle.fenceRefSha };
      }

      // 4 + 5. Land the squash on the target branch and sync the user's
      //        checkout (AI reconciles a conflicting restore).
      ctx.workspaceLand?.assertLive();
      await setStatus("landing");
      const landed = await landSquash({
        projectRootDir: repoRootDir, mergeRoot, integrationBranch, tipSha, squashSha, taskId, audit,
        resolveConflicts: stashResolveAgent,
        allowDirtyLocalCheckoutSync: ctx.allowDirtyLocalCheckoutSync === true,
        signal,
        workspaceFence,
        workspaceDispatchFence: ctx.workspaceDispatchFence,
        assertMergeGateStillOpen: () => assertMergeGateStillOpen(ctx, repoRootDir, ctx.repoRel),
        onWorkspaceRepublish: async (observedTargetSha) => {
          await log(`AI merge (workspace): re-observed remote ${workspaceFence?.remote ?? "target"} at ${short(observedTargetSha ?? "absent")} before publishing ${integrationBranch}`);
        },
      });
      if (landed.outcome === "concurrent") {
        if (advanceRetries < MAX_CONCURRENT_ADVANCE_RETRIES) {
          advanceRetries++;
          await log(`AI merge: ${integrationBranch} moved during merge — rebuilding on new tip (retry ${advanceRetries})`);
          continue; // rebuild the clean room on the new tip
        }
        throw new Error(`AI merge could not advance ${integrationBranch} for ${taskId} after ${advanceRetries} retries (concurrent advances)`);
      }
      /* FNXC:AIMergeReviewReconciliation 2026-08-20-22:27: once the exact confirmed candidate lands, clear its findings, confirmation count, and corrective budget together so completed work cannot be revived. */
      await store.updateTask(taskId, { aiMergeReviewReconciliation: null });
      await log(`AI merge: advanced ${integrationBranch} → ${short(squashSha)} (local checkout: ${landed.localSync})`);
      return { outcome: "landed", squashSha, localSync: landed.localSync, tipSha, integrationBranch, dependencySyncDecision };
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

/*
FNXC:WorkflowLifecycleColumns 2026-07-27-23:50 (Phase B / U5):
Legacy ids for the roles this module decides by: the builtin coding workflow's
Complete terminal role and its Hold rebound column. Used only
when the task's workflow resolves to no column vocabulary, where preserving
today's behavior exactly beats guessing.
*/
const LEGACY_COMPLETE_COLUMN = "done";
const LEGACY_TERMINAL_COLUMNS: readonly string[] = [LEGACY_COMPLETE_COLUMN];
const LEGACY_REBOUND_COLUMN = "todo";

/*
FNXC:LifecycleContainment 2026-08-28-03:03:
FN-207 treats finalize blockers as review-owned repair: a review card returns only to the workflow's
WIP lane, never Planning. A declared workflow with no adjacent WIP target remains in review; only an
unreadable task row retains the legacy fallback because no live source column is available to classify.

FNXC:LifecycleContainment 2026-08-28-03:19:
Every AI-merger finalize blocker uses one routing seam so production-family acceptance can prove the
same adjacent target, no-target containment, and capacity deferral used by all five branches.
*/
export async function reboundAiMergeTask(store: TaskStore, taskId: string) {
  return moveTaskToContainedBackwardTarget(store, taskId, "merge-failure-rebound", {
    preserveProgress: true,
    moveSource: "engine",
  });
}

/** Resolve the adjacent implementation destination for a finalize-blocked card. */
export async function resolveFinalizeReboundColumn(store: TaskStore, taskId: string): Promise<string> {
  let live: Task;
  try {
    live = await store.getTask(taskId);
  } catch {
    return LEGACY_REBOUND_COLUMN;
  }
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    return resolveContainedBackwardTarget(ir, live.column) ?? live.column;
  } catch {
    return live.column;
  }
}

/**
 * True when the card already rests in a terminal column (`complete` or
 * `archived`) of its OWN workflow — the already-finalized short circuit.
 *
 * Fail-soft to the legacy pair: losing this guard means an already-finalized
 * card proceeds into the merge path, so an unresolvable workflow must keep the
 * legacy ids rather than answer "not terminal".
 */
async function isAlreadyFinalizedColumn(store: TaskStore, task: Task): Promise<boolean> {
  let terminal: readonly string[] = LEGACY_TERMINAL_COLUMNS;
  try {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-29-13:10:
    Delegated to core's `resolveTerminalColumns`. The per-role fallback below was
    the ONLY copy of that rule, and executor's equivalent guard was still a raw
    literal pair that would have re-made the same P1 on conversion. Same values,
    one owner. Behaviour-preserving: proven by workflow-already-finalized-live-e2e,
    whose per-set mutation still fails.
    */
    terminal = resolveTerminalColumns(await resolveWorkflowIrForTask(store, task.id));
  } catch {
    terminal = LEGACY_TERMINAL_COLUMNS;
  }
  return terminal.includes(task.column);
}

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

/*
FNXC:Lifecycle 2026-07-16-00:00:
FN-8141 incident: a commit-expected task's branch had no net changes vs the integration tip ONLY
because the executor reverted its own work five times. The empty-merge lane assumed "empty means the
work already landed or there was nothing to do" and finalized the task `done` with mergeConfirmed —
laundering reverted/lost work into a completed state with no reviewer or operator sign-off.

Invariant: a commit-expected empty-merge outcome may finalize as no-op ONLY with POSITIVE evidence the
work already landed. Positive evidence is any of:
  1. Durable recorded landing on this task's own mergeDetails (mergeConfirmed / commitSha).
  2. A prior AI no-op finalization proof pair in the task log (FN-7261 forward-fix recovery shape).
  3. The task branch tip is an ANCESTOR of the integration branch — its history is already contained in
     main (fast-forwarded / zero-ahead / already-integrated); nothing was reverted or lost.
  4. The already-on-main classifier finds a DISTINCT landing commit for this task on the integration
     branch via a STRONG strategy (trailer / ancestry / patch-id) — e.g. a squash whose history is not
     an ancestor of the branch. The classifier's WEAK `tree-equal` / `no-diff` strategies are DELIBERATELY
     rejected here: a branch that committed work and then reverted it back to base has a tree equal to
     main (main never advanced), so `tree-equal` would false-positive on exactly the FN-8141 lost-work
     shape this guard exists to catch.
Absent all four, the branch is treated as reverted/lost work and the task is blocked, NOT finalized.
Returns the proof marker when landed; null when unproven.
*/
const STRONG_LANDED_STRATEGIES: ReadonlySet<string> = new Set(["trailer", "ancestry", "patch-id"]);

interface RecordedMergeLandingProof {
  landedSha: string;
  landedBranchTipSha: string;
}

class RecordedMergeBranchTipChangedError extends Error {
  constructor(readonly branch: string, readonly expectedTipSha: string) {
    super(`Task branch ${branch} changed after its recorded landing was proven`);
    this.name = "RecordedMergeBranchTipChangedError";
  }
}

async function proveRecordedMergeAlreadyLanded(
  task: Task,
  branch: string,
  integrationBranch: string,
  projectRootDir: string,
): Promise<RecordedMergeLandingProof | null> {
  const details = task.mergeDetails;
  const landedSha = details?.commitSha?.trim();
  const landedBranchTipSha = details?.landedBranchTipSha?.trim();
  if (
    branch === integrationBranch
    || details?.mergeConfirmed !== true
    || !landedSha
    || !landedBranchTipSha
    || (details.mergeTargetBranch !== undefined && details.mergeTargetBranch !== integrationBranch)
  ) return null;

  const [commitExists, commitReachedTarget, liveBranchTip] = await Promise.all([
    gitOk(["cat-file", "-e", `${landedSha}^{commit}`], projectRootDir),
    gitOk(["merge-base", "--is-ancestor", landedSha, `refs/heads/${integrationBranch}`], projectRootDir),
    git(["rev-parse", "--verify", `refs/heads/${branch}`], projectRootDir).catch(() => ""),
  ]);
  if (!commitExists || !commitReachedTarget || liveBranchTip !== landedBranchTipSha) return null;
  return { landedSha, landedBranchTipSha };
}

async function proveEmptyMergeAlreadyLanded(
  task: Task,
  branch: string,
  integrationBranch: string,
  projectRootDir: string,
): Promise<{ strategy: string; sha?: string } | null> {
  // 1. Durable landing already recorded on this task.
  if (task.mergeDetails?.mergeConfirmed === true || !!task.mergeDetails?.commitSha) {
    return { strategy: "recorded-merge-details", sha: task.mergeDetails?.commitSha };
  }
  // 2. Prior AI no-op finalization proof (older finalizer landed then failed pre-persist).
  if (hasPriorAiNoOpFinalizationProof(task, branch, integrationBranch)) {
    return { strategy: "prior-no-op-finalization" };
  }
  // 3. Branch tip already contained in the integration branch (its work is genuinely integrated,
  //    not reverted). This is what distinguishes a fast-forwarded/zero-ahead no-op from an
  //    ahead-but-net-zero reverted branch whose tip is NOT an ancestor of main.
  const branchTip = await git(["rev-parse", "--verify", `refs/heads/${branch}`], projectRootDir).catch(() => "");
  if (branchTip && (await gitOk(["merge-base", "--is-ancestor", branchTip, integrationBranch], projectRootDir))) {
    return { strategy: "branch-ancestor-of-main", sha: branchTip };
  }
  // 4. A distinct landing commit exists on main via a STRONG classifier strategy (squash-landed).
  const landed = await detectAlreadyLandedOnMain({
    rootDir: projectRootDir,
    taskId: task.id,
    lineageId: task.lineageId,
    baseBranch: integrationBranch,
    taskBranch: branch,
    baseCommitSha: task.baseCommitSha,
  }).catch(() => null);
  if (landed && STRONG_LANDED_STRATEGIES.has(landed.strategy)) {
    return { strategy: landed.strategy, sha: landed.sha };
  }
  return null;
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

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-27-23:50 (Phase B / U5):
  Resolve the terminal roles from the task's own workflow. Under a renamed
  workflow the literal `done`/`archived` pair stopped matching, and the
  already-finalized card fell through to `getTaskMergeBlocker` — which threw
  "task is in 'shipped', must be in 'in-review'" for a task whose real state was
  "already done, nothing to do". The correct outcome is this clean no-op.
  */
  if (await isAlreadyFinalizedColumn(store, task)) {
    return noOpResult(task, branch, "already-finalized");
  }
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-17:10 (MERGING WAS BROKEN ON A RENAMED BOARD):
  `getTaskMergeBlocker`'s identity check RETURNS A BLOCKER when the column is not a review lane, so
  calling it without `reviewColumns` on a board whose review lane is renamed produced
  `Cannot merge FN-x: task is in 'signoff', must be in 'in-review'` — and the merge threw. Not a
  degraded message: no task could be merged at all.

  The helper's own comment records this exact defect being fixed in `moves.ts`; these two merge
  entry points were missed. Resolve the task's own review lanes and pass them.
  */
  const settings = await store.getSettings();
  let mergeGate;
  try {
    mergeGate = await resolvePreMergeGateForTask(store, taskId, task.enabledWorkflowSteps, task);
  } catch {
    throw new Error(`Cannot merge ${taskId}: merge gate could not resolve the task workflow`);
  }
  if (mergeGate.provenance === "default" && !mergeGate.selectionAbsent) {
    throw new Error(`Cannot merge ${taskId}: merge gate could not resolve the task workflow`);
  }
  const mergeContent = await captureMergeContentDescriptor(task, { workspaceRootDir: projectRootDir, settings });
  const blocker = getTaskMergeBlocker(task, {
    manual: options.manual === true,
    reviewColumns: mergeGate.reviewColumns.size > 0 ? mergeGate.reviewColumns : new Set(["in-review"]),
    requiredPreMergeStepIds: mergeGate.requiredPreMergeStepIds,
    mergeContent,
  });
  /* FNXC:RequiredPreMergeSteps 2026-08-22-22:40: an unrun enabled gate is a deferral (typed), not a failure. */
  if (blocker && isPreMergeStepsNotRunBlocker(blocker)) throw new PreMergeStepsNotRunError(taskId);
  if (blocker) throw new Error(`Cannot merge ${taskId}: ${blocker}`);
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

  const fence = createMergeWriteFence({
    taskId,
    signal: options.signal,
    recordAudit: (category, interaction, suppressedCount) => emitBoundedRunAudit(store, {
      taskId, agentId: "merger", runId: `merge-${taskId}`, domain: "git",
      mutationType: "merge:orphan-write-fenced", target: taskId,
      metadata: { taskId, category, interaction, suppressedCount },
    }, { log: aiMergeLog }),
  });
  // Surface progress on the task detail (status pill) + the task log stream.
  const log = async (message: string): Promise<void> => {
    await fence.write("log", () => store.logEntry(taskId, message, "AiMerge").catch(() => undefined));
    await fence.write("log", () => store.appendAgentLog(taskId, message, "status", undefined, "merger").catch(() => undefined));
  };
  /*
  FNXC:MergeReliability 2026-08-09-22:35:
  `raceMergeWithAbort` rejects only the race; a body can outlive the bounded settle latch while a
  successor generation owns this task. Its per-claim signal remains aborted, so suppressing this
  status-only write prevents it from re-stamping `merging` (issue #3395) or clearing a successor's
  live stamp. Diagnostics use the same suppress-and-no-op policy rather than throwing, because
  finally paths must preserve the original failure.
  */
  const setStatus = (status: string | null): Promise<unknown> =>
    writeTransientMergeStatus(store, taskId, options.signal, status);

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
    /*
     * FNXC:NoCommitsBranchMissing 2026-08-08-19:46:
     * No-commits tasks (observational audits, non-code deliverables) never create a git
     * branch with substantive work. If a no-commits task WAS executed (baseCommitSha set)
     * but its branch is missing and not already merged, route through evaluateNoCommitsNoOpFinalize
     * BEFORE the "work appears lost" throw: all-done tasks finalize as a no-op (audit.git kind
     * "no-commits-expected"), incomplete/skipped tasks demote to todo with progress preserved.
     * Commit-expected tasks STILL throw below (invariant unchanged).
     * Restored from RUFU-011 (commit 98dc396ec); the noCommitsExpected clause was dropped in
     * the domain-folder move / dep-sync restructure.
     */
    if (wasExecuted && !alreadyMerged && task.noCommitsExpected === true) {
      const noCommitsFinalize = evaluateNoCommitsNoOpFinalize(task);
      if (noCommitsFinalize.blocked) {
        const reason = noCommitsFinalize.reason ?? "no-commits task has incomplete work with no branch changes";
        /*
         * FNXC:RUFU146MergeFence 2026-08-21-13:35:
         * RUFU-146 review (PRRT_kwDOSA-8Y86a7RaK): this lane's lifecycle
         * writes were UNFENCED — if the merge generation is aborted after the
         * branch lookup (successor generation owns the task), a stale
         * generation's direct updateTask/logEntry/moveTask/finalizeTask could
         * still demote the successor to todo or finalize it as done. Route
         * every write through fence.write(...), stop after an orphaned
         * signal, and hand the fence to finalizeTask — the same contract the
         * ai-empty-merge lane and the missing-branch no-op finalize already
         * follow.
         */
        await fence.write("lifecycle", () => store.updateTask(taskId, { error: reason }));
        if (fence.isOrphaned()) return {
          task, branch, merged: false, noOp: false, ok: true, reason, error: reason,
          worktreeRemoved: false, branchDeleted: false,
        };
        const reboundColumn = await resolveFinalizeReboundColumn(store, taskId);
        await fence.write("log", () => store.logEntry(
          taskId,
          `Finalize blocked (no-commits incomplete-work guard): ${reason} — contained recovery target ${reboundColumn} with progress preserved`,
          JSON.stringify({
            doneCount: noCommitsFinalize.doneCount,
            incompleteCount: noCommitsFinalize.incompleteCount,
            branch,
            integrationBranch,
            lane: "no-commits-branch-missing",
          }, null, 2),
        ));
        await audit.database({
          type: "task:no-commits-finalize-blocked-incomplete-steps" as Parameters<typeof audit.database>[0]["type"],
          target: taskId,
          metadata: {
            reason,
            doneCount: noCommitsFinalize.doneCount,
            incompleteCount: noCommitsFinalize.incompleteCount,
            branch,
            integrationBranch,
            lane: "no-commits-branch-missing",
          },
        });
        await fence.write("lifecycle", () => reboundAiMergeTask(store, taskId));
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
      await audit.git({
        type: "merge:ai-no-branch",
        target: branch,
        metadata: { taskId, kind: "no-commits-expected", noCommitsExpected: true },
      });
      return await finalizeTask(store, taskId, noOpResult(task, branch, "no-commits-expected"), undefined, undefined, projectRootDir, fence);
    }
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
    return await finalizeTask(store, taskId, noOpResult(task, branch, alreadyMerged ? "already-merged" : "no-branch"), undefined, undefined, projectRootDir, fence);
  }

  /*
  FNXC:IntegrationBranchReadiness 2026-08-24-00:49:
  FN-183 treats an origin remote-tracking integration ref as an unambiguous, lossless
  recovery at merge time. Never invent a branch from HEAD here: a target that exists
  nowhere remains a loud failure so Fusion does not create history mid-merge.
  */
  if (!(await gitOk(["rev-parse", "--verify", `refs/heads/${integrationBranch}`], projectRootDir))) {
    const remoteTarget = `refs/remotes/origin/${integrationBranch}`;
    const materialized = (await gitOk(["rev-parse", "--verify", remoteTarget], projectRootDir))
      && await gitOk(["branch", integrationBranch, remoteTarget], projectRootDir);
    if (materialized) {
      await log(`AI merge: materialized integration branch ${integrationBranch} from ${remoteTarget}`);
      await audit.git({
        type: "merge:ai-no-branch",
        target: integrationBranch,
        metadata: { taskId, kind: "integration-branch-materialized-from-remote" },
      });
    } else {
      await audit.git({ type: "merge:ai-no-branch", target: integrationBranch, metadata: { taskId, kind: "integration-branch-missing" } });
      throw new Error(`AI merge for ${taskId}: target branch "${integrationBranch}" has no local ref (refs/heads/${integrationBranch}). Create or check out the branch locally before merging.`);
    }
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
  try {
  /*
  FNXC:AIMerge 2026-08-28-09:29:
  FN-216 durably advanced main at 08:33:51.039Z, then entered a second clean room at
  08:33:52.561Z because its waiting-caller dispatch skipped the queue's merge-confirmed fast path.
  This point-of-use guard belongs in runAiMerge, the sole merge path, so every dispatcher receives
  the same protection. landOneRepo cannot detect this through its zero-ahead check: a squash commit
  is not in the task branch's history, so `<integration>..<branch>` remains non-zero after landing.
  Every proof condition is required. In particular, FN-5627's poisoned merge-confirmed row must
  fall through when its commit is not reachable, and a branch with post-landing commits must fall
  through when its live tip no longer matches the landing pin.

  FNXC:AIMerge 2026-08-28-09:50:
  Proof is admission, not ownership: another writer can advance the task branch after this read.
  Recorded-landing finalization therefore deletes the branch ref with Git's expected-old-value CAS
  after removing its worktree. A mismatch preserves the advanced ref and falls through to the full
  merge, so post-landing commits cannot be silently discarded.
  */
  const alreadyLanded = await proveRecordedMergeAlreadyLanded(task, branch, integrationBranch, projectRootDir);
  if (alreadyLanded) {
    await log(
      `AI merge: ${branch} has a recorded landing on ${integrationBranch} at ${short(alreadyLanded.landedSha)} — verifying its pinned branch tip before skipping a second clean-room merge`,
    );
    try {
      const finalized = await finalizeMerged(store, projectRootDir, taskId, task, branch, integrationBranch, alreadyLanded.landedSha, audit, log, {
        empty: false,
        expectedBranchTipSha: alreadyLanded.landedBranchTipSha,
      }, mergeTarget, groupRouting, options.syncGroupPr, fence);
      await audit.git({
        type: "merge:ai-landed",
        target: integrationBranch,
        metadata: { taskId, landedSha: alreadyLanded.landedSha, source: "already-landed-short-circuit" },
      }).catch(() => undefined);
      await log(
        `AI merge: ${branch} already landed on ${integrationBranch} at ${short(alreadyLanded.landedSha)} — skipped a second clean-room merge`,
      );
      await runPushAfterMergeStep({ store, projectRootDir, taskId, settings, integrationBranch, audit, log, options, result: finalized, fence });
      return finalized;
    } catch (error) {
      if (!(error instanceof RecordedMergeBranchTipChangedError)) throw error;
      await log(
        `AI merge: ${branch} advanced after its recorded landing was proven — preserving the branch and running the full clean-room merge`,
      );
    }
  }

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
    // FNXC:MergeNoCommits 2026-07-17-12:00: no-commits tasks skip dependency sync in the clean room
    noCommitsExpected: task.noCommitsExpected === true,
    mergeContent,
    store,
  });

  if (landResult.outcome === "empty") {
    const noCommitsFinalize = evaluateNoCommitsNoOpFinalize(task, {
      requiredVerificationStepIds: await resolveNoOpFinalizeGateIds(store, task),
    });
    if (noCommitsFinalize.blocked) {
      const reason = noCommitsFinalize.reason ?? "no-commits task has incomplete work with no net branch changes";
      /*
       * FNXC:Lifecycle 2026-06-14-20:02:
       * FN-6461/FN-6455 requires the AI empty-merge lane to demote no-commits tasks whose skipped/incomplete steps outweigh done steps instead of finalizing the operational work as done.
       *
       * FNXC:EmptyMergeFinalize 2026-08-28-13:14:
       * Empty-merge blockers previously wrote only error, while merge-failure-rebound had no
       * backward-move authority and getTaskMergeBlocker ignored error. The card therefore remained
       * merge-eligible and repeated the same refusal forever. Persist a hard blocking failed status
       * beside each guard's unchanged reason so the operator sees one terminal conclusion. Existing
       * in-review Retry clears this park with progress preserved after evidence is corrected.
       */
      await fence.write("lifecycle", () => store.updateTask(taskId, { error: reason, status: "failed" }));
      if (fence.isOrphaned()) return {
        task, branch, merged: false, noOp: false, ok: true, reason, error: reason,
        worktreeRemoved: false, branchDeleted: false,
      };
      const reboundColumn = await resolveFinalizeReboundColumn(store, taskId);
      await fence.write("log", () => store.logEntry(
        taskId,
        `Finalize blocked (no-commits incomplete-work guard): ${reason} — contained recovery target ${reboundColumn} with progress preserved`,
        JSON.stringify({
          doneCount: noCommitsFinalize.doneCount,
          incompleteCount: noCommitsFinalize.incompleteCount,
          branch,
          integrationBranch,
          lane: "ai-empty-merge",
        }, null, 2),
      ));
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
          parkedStatus: "failed",
        },
      });
      await fence.write("lifecycle", () => reboundAiMergeTask(store, taskId));
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
    /*
     * FNXC:Lifecycle 2026-07-16-00:00:
     * FN-8141: for a commit-expected task (noCommitsExpected !== true), an empty branch is only a
     * safe no-op if the work provably already landed. Without positive already-landed proof the
     * branch is assumed reverted/lost (the FN-8141 executor reverted its work five times); block the
     * finalize, record a precise error, emit an audit event, and move back to todo with progress
     * preserved so an operator (or reviewer) sees it instead of it laundering into `done`.
     * task.error keeps recoverStrandedCompletedTodoTasks from re-promoting the unchanged task (it
     * excludes any task with `task.error` set), mirroring the FN-6461 blocked lane above.
     *
     * FNXC:Lifecycle 2026-07-16-09:40:
     * Empty-lane guard ORDER (each blocks BEFORE finalizeMerged; first blocker wins; all coexist):
     *   (1) FN-6461/#2254 step-evidence guard (`evaluateNoCommitsNoOpFinalize`, above)
     *   (2) #2259 already-landed-proof guard (this block, commit-expected only)
     *   (3) FN-8141 executor-signal veto (`evaluateNoOpFinalizeExecutorVeto`, below)
     * They use INDEPENDENT evidence, so any one alone stops the FN-8141 laundering shape.
     */
    if (task.noCommitsExpected !== true) {
      const landedProof = await proveEmptyMergeAlreadyLanded(task, branch, integrationBranch, projectRootDir);
      if (!landedProof) {
        const reason =
          "branch had no net changes vs main — work may have been reverted or lost; operator review required";
        await fence.write("lifecycle", () => store.updateTask(taskId, { error: reason, status: "failed" }));
        if (fence.isOrphaned()) return {
          task, branch, merged: false, noOp: false, ok: true, reason, error: reason,
          worktreeRemoved: false, branchDeleted: false,
        };
        const reboundColumn = await resolveFinalizeReboundColumn(store, taskId);
        await fence.write("log", () => store.logEntry(
          taskId,
          `Finalize blocked (empty-merge no-landed-proof guard): ${reason} — contained recovery target ${reboundColumn} with progress preserved`,
          JSON.stringify({ branch, integrationBranch, lane: "ai-empty-merge", baseCommitSha: task.baseCommitSha }, null, 2),
        ));
        await audit.database({
          type: "task:empty-merge-finalize-blocked-no-landed-proof" as Parameters<typeof audit.database>[0]["type"],
          target: taskId,
          metadata: {
            reason,
            branch,
            integrationBranch,
            lane: "ai-empty-merge",
            baseCommitSha: task.baseCommitSha,
            hadPriorNoOpProof: false,
            parkedStatus: "failed",
          },
        });
        await fence.write("lifecycle", () => reboundAiMergeTask(store, taskId));
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
      await log(
        `AI merge: ${branch} had no net changes vs ${integrationBranch} but work already landed (proof=${landedProof.strategy}${landedProof.sha ? ` sha=${landedProof.sha.slice(0, 8)}` : ""}) — finalizing as no-op`,
      );
    }

    /*
     * FNXC:Lifecycle 2026-07-16-09:40:
     * FN-8141 overseer-layer backstop — guard (3) in the empty-lane order above.
     * Independent of, and composed with, the FN-6461/#2254 step-evidence guard
     * and the #2259 already-landed-proof guard (this one keys on the cross-stage
     * executor overseer signal, derived from the durable `overseer:intervention`
     * timeline). EITHER of the three alone must stop the FN-8141 laundering
     * shape. Only the zero-diff no-op lane is in scope — a real squash landing
     * never reaches here. `evaluateNoOpFinalizeExecutorVeto` is pure and defers
     * to the FN-7514 human-control contract, so it never fights user-paused /
     * autoMerge:false tasks.
     */
    // Derive the most-recent executor signal from the durable
    // `overseer:intervention` timeline (best-effort — a store without the async
    // reader, or a query failure, degrades to `null` = no veto, so other guards
    // remain the safety net).
    let executorMemory = null as Awaited<ReturnType<typeof deriveExecutorSignalMemory>>;
    try {
      const timeline = await getPlannerInterventionTimeline(store, taskId);
      // FNXC:Lifecycle 2026-07-16-12:10 (follow-up 3): thread the durable task log
      // so a mid-execution `progressing` observation cannot clear the veto — only a
      // clean-completion marker newer than the failure park supersedes it.
      executorMemory = deriveExecutorSignalMemory(timeline, task.log);
    } catch (err) {
      aiMergeLog.warn(`${taskId}: executor overseer-memory derivation failed (skipping veto): ${getErrorMessage(err)}`);
    }
    const executorVeto = evaluateNoOpFinalizeExecutorVeto({ mergeIsEmpty: true, task, memory: executorMemory, settings });
    if (executorVeto.veto) {
      const vetoReason = executorVeto.reason ?? "overseer failed-executor no-op-finalize veto";
      await fence.write("lifecycle", () => store.updateTask(taskId, { error: vetoReason, status: "failed" }));
      if (fence.isOrphaned()) return {
        task, branch, merged: false, noOp: false, ok: true, reason: vetoReason, error: vetoReason,
        worktreeRemoved: false, branchDeleted: false,
      };
      const reboundColumn = await resolveFinalizeReboundColumn(store, taskId);
      await fence.write("log", () => store.logEntry(
        taskId,
        `Finalize blocked (overseer failed-executor veto): ${vetoReason} — contained recovery target ${reboundColumn} with progress preserved`,
        JSON.stringify({
          executorSignal: executorMemory?.signal,
          executorSignalObservedAt: executorMemory?.observedAt,
          branch,
          integrationBranch,
          lane: "ai-empty-merge",
        }, null, 2),
      ));
      await audit.database({
        type: "overseer:no-op-finalize-vetoed-failed-executor" as Parameters<typeof audit.database>[0]["type"],
        target: taskId,
        metadata: {
          reason: vetoReason,
          executorSignal: executorMemory?.signal,
          executorSignalObservedAt: executorMemory?.observedAt,
          branch,
          integrationBranch,
          lane: "ai-empty-merge",
          parkedStatus: "failed",
        },
      });
      await fence.write("lifecycle", () => reboundAiMergeTask(store, taskId));
      return {
        task,
        branch,
        merged: false,
        noOp: false,
        ok: true,
        reason: vetoReason,
        error: vetoReason,
        worktreeRemoved: false,
        branchDeleted: false,
      };
    }

    await log(`AI merge: ${branch} had no net changes vs ${integrationBranch} — finalizing as no-op`);
    const noOpFinalized = await finalizeMerged(store, projectRootDir, taskId, task, branch, integrationBranch, landResult.tipSha, audit, log, { empty: true }, mergeTarget, groupRouting, options.syncGroupPr, fence);
    await runPushAfterMergeStep({ store, projectRootDir, taskId, settings, integrationBranch, audit, log, options, result: noOpFinalized, fence });
    return noOpFinalized;
  }

  let finalized: MergeResult;
  try {
    finalized = await finalizeMerged(store, projectRootDir, taskId, task, branch, integrationBranch, landResult.squashSha, audit, log, { empty: false }, mergeTarget, groupRouting, options.syncGroupPr, fence);
  } catch (error: unknown) {
    const failure = getErrorMessage(error);
    const landingMessage = `AI merge: landed ${short(landResult.squashSha)} on ${integrationBranch}, but post-landing finalization failed: ${failure}. The landing is durable; a retry will finalize without re-merging.`;
    /*
    FNXC:AIMerge 2026-08-28-09:29:
    Process logging remains outside the write fence so an orphaned merge body still leaves a
    diagnostic when its durable task writes are correctly suppressed. A live owner also records the
    same landed-but-not-finalized evidence in the task log before the original error propagates.
    */
    aiMergeLog.warn(`${taskId}: ${landingMessage}`);
    await fence.write("log", () => store.logEntry(taskId, landingMessage, "AiMerge")).catch(() => undefined);
    throw error;
  }
  await runPushAfterMergeStep({ store, projectRootDir, taskId, settings, integrationBranch, audit, log, options, result: finalized, fence });
  return finalized;
  } finally {
    /*
    FNXC:MergeReliability 2026-08-20-02:00:
    Authorization A clears the single-repo transient stamp through the aborted generation's write
    fence. The read preserves terminal/confirmed finalization only; the fence, not this predicate,
    prevents a late aborted body from clearing a successor's identical `merging` stamp.
    */
    const live = await store.getTask(taskId).catch(() => null);
    if (live && shouldClearOrphanedMergeStamp(live)) await setStatus(null);
  }
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
  fence: MergeWriteFence;
}): Promise<void> {
  const { store, projectRootDir, taskId, settings, integrationBranch, audit, log, options, result, fence } = input;
  if (!isPushAfterMergeEnabled(settings, { lane: "single-repo" })) return;
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
      fence,
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
            await fence.write("lifecycle", () => store.updateTask(taskId, {
              mergeDetails: { ...details, commitSha: pushOutcome.rebasedSha, filesChanged, insertions, deletions },
            }));
          }
        } catch (refreshErr: unknown) {
          aiMergeLog.warn(`${taskId}: post-push mergeDetails refresh failed: ${getErrorMessage(refreshErr)}`);
        }
      }
    } else {
      aiMergeLog.warn(`${taskId}: push to remote failed: ${pushOutcome.error}`);
      await fence.write("log", () => store.logEntry(
        taskId,
        `Push to remote failed after merge — task finalized anyway; local ${integrationBranch} may diverge from ${pushOutcome.remote ?? "origin"}: ${pushOutcome.error}`,
        "PushToRemoteFailed",
      ).catch(() => undefined));
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "MergeAbortedError") {
      /*
      FNXC:MergePush 2026-07-22-18:48:
      Tchori-Labs/Fusion#5 requires shutdown aborts after finalization to remain non-fatal but never silent. The remote recovery branch preserves the approved squash; MergeResult, task log, and run-audit identify that the target push did not complete.
      */
      const message = "Push after merge aborted by shutdown signal; the local merge remains finalized and its divergence recovery branch is retained";
      result.pushedToRemote = false;
      result.pushError = message;
      aiMergeLog.warn(`${taskId}: ${message}`);
      await audit.git({
        type: "push:origin",
        target: taskId,
        metadata: { integrationBranch, remote: settings.pushRemote ?? "origin", outcome: "aborted" },
      }).catch(() => undefined);
      await fence.write("log", () => store.logEntry(taskId, message, "PushToRemoteFailed").catch(() => undefined));
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
    await fence.write("log", () => store.logEntry(
      taskId,
      `Push to remote threw after merge — task finalized anyway; local ${integrationBranch} may diverge from origin: ${message}`,
      "PushToRemoteFailed",
    ).catch(() => undefined));
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
  /** The clean-room dependency-readiness decision for this repository when a land ran. */
  dependencySyncDecision?: string;
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
   * FNXC:Workspace 2026-08-15-04:22:
   * `allLanded` means no sub-repo failed, but `finalized` is the ONLY proof this call
   * reached `done`. When all repos land but finalization is blocked, expose the
   * operator-facing reason so every merge door reports a blocked outcome honestly.
   */
  finalized: boolean;
  finalizeBlockedReason?: string;
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
/*
FNXC:WorkspaceFinalization 2026-08-21-08:46:
Only an acquired repository lease with a real holder task can be reported as contention. Fence
publication and durable-lease transport failures are technical retryable outcomes; representing
those implementation markers as a repository/task identity sent operators to nonexistent owners.
*/
export class WorkspaceMergeTechnicalError extends Error {
  public readonly retryable = true;
  /* FNXC:WorkspaceIntegration 2026-08-21-21:46: target planning faults are internal-technical, while a user-correctable remote choice is represented by WorkspaceIntegrationTargetError. */
  constructor(public readonly kind: "dispatch-fence-publication" | "repository-fence-publication" | "durable-lease" | "workspace-entry" | "integration-target", message: string) {
    super(message);
    this.name = "WorkspaceMergeTechnicalError";
  }
}

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

/*
FNXC:Workspace 2026-08-15-04:22:
A blocked workspace finalize is non-retryable because the empty-merge guard has already
parked the task with `task.error`. Keep it distinct from retryable partial lands so callers
never consume merge retries or report a merge success for work that did not reach `done`.
*/
export class WorkspaceFinalizeBlockedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly reason: string,
  ) {
    super(`Workspace finalize blocked for ${taskId}: ${reason}`);
    this.name = "WorkspaceFinalizeBlockedError";
  }
}

/** A fenced merge pushed successfully, but a successor owns terminal finalization. */
export type WorkspaceReviewAssessment = {
  kind: "approval-missing" | "content-changed";
  repositories: string[];
  files: string[];
};

/**
 * FNXC:WorkspaceReviewReroute 2026-08-21-19:25:
 * Missing approval and changed reviewed content are recoverable review obligations, not merge
 * transport failures. Keep their repository-qualified diagnostics structured so every merge door
 * can re-enter Code Review without consuming a merge retry budget.
 */
export class WorkspaceReviewRequiredError extends Error {
  constructor(public readonly taskId: string, public readonly assessment: WorkspaceReviewAssessment) {
    const repositories = assessment.repositories.join(", ");
    const files = assessment.files.join(", ");
    super(assessment.kind === "approval-missing"
      ? `Workspace Code Review approval is missing for ${taskId}: ${repositories}${files ? ` (${files})` : ""}`
      : `Workspace Code Review content changed after approval for ${taskId}: ${repositories}${files ? ` (${files})` : ""}`);
    this.name = "WorkspaceReviewRequiredError";
  }
}

export class WorkspaceMergeDispatchSupersededError extends Error {
  constructor(public readonly taskId: string) {
    super(`Workspace merge dispatch lease was superseded before finalization for ${taskId}`);
    this.name = "WorkspaceMergeDispatchSupersededError";
  }
}

export async function landWorkspaceTask(
  store: TaskStore,
  task: Task,
  workspaceRootDir: string,
  options: MergerOptions & { workspaceDispatchFence?: WorkspaceLeaseHandle } = {},
  deps: AgentDeps = {},
): Promise<WorkspaceMergeResult> {
  const taskId = task.id;
  assertMergeGenerationOwned(options.signal, taskId);
  const settings = await store.getSettings();
  const publishToRemote = isPushAfterMergeEnabled(settings, { lane: "workspace" });
  const audit = createRunAuditor(store, {
    runId: generateSyntheticRunId("ai-merge", taskId),
    agentId: "merger",
    taskId,
    phase: "merge",
  });
  const fence = createMergeWriteFence({
    taskId,
    signal: options.signal,
    recordAudit: (category, interaction, suppressedCount) => emitBoundedRunAudit(store, {
      taskId, agentId: "merger", runId: `merge-${taskId}`, domain: "git",
      mutationType: "merge:orphan-write-fenced", target: taskId,
      metadata: { taskId, category, interaction, suppressedCount },
    }, { log: aiMergeLog }),
  });
  const log = async (message: string): Promise<void> => {
    await fence.write("log", () => store.logEntry(taskId, message, "AiMerge").catch(() => undefined));
    await fence.write("log", () => store.appendAgentLog(taskId, message, "status", undefined, "merger").catch(() => undefined));
  };
  /*
  FNXC:MergeReliability 2026-08-09-22:35:
  Workspace landing has the same per-generation abort fence as single-repo merges. An orphan that
  outlives the settle latch must neither re-stamp a cleared status nor let its finally clear a live
  successor's status; logging remains deliberately unfenced for orphan diagnostics.
  */
  const setStatus = (status: string | null): Promise<unknown> =>
    writeTransientMergeStatus(store, taskId, options.signal, status);

  const maxPasses = Math.max(0, Math.trunc(settings.merger?.maxReviewPasses ?? 3));
  const mergeAgent = deps.mergeAgent ?? makeMutatingAgent(store, settings, taskId, options, audit, buildMergeSystemPrompt(settings.agentPrompts));
  const reviewAgent = deps.reviewAgent ?? makeReviewAgent(store, settings, taskId, options, audit);
  const stashResolveAgent = deps.stashResolveAgent ?? makeMutatingAgent(store, settings, taskId, options, audit, buildStashResolveSystemPrompt());
  const includeTaskId = settings.includeTaskIdInCommit !== false;
  const allowDirtyLocalCheckoutSync = options.allowDirtyLocalCheckoutSync ?? (settings.merger?.allowDirtyLocalCheckoutSync === true);
  const trailers = taskTrailers(taskId, task.lineageId, settings);
  const taskTitle = task.title?.trim() ? task.title.split("\n")[0] : undefined;

  /*
  FNXC:RepositoryScope 2026-08-21-00:44:
  Landing captures qualified per-repository diffs at the merge boundary, after all execution and
  review work has finished. Persisting this snapshot prevents a stale executor capture from
  omitting a newly changed scoped repository from leases, review obligations, or land intents.
  */
  /*
  FNXC:MergeGateRecheck 2026-08-23-08:51:
  FN-180 forbids a store shape from bypassing the final merge fence. A durable task read is required
  before workspace landing; an unavailable read refuses the ref advance rather than using a stale
  caller snapshot that may predate a REVISE or review-lane exit.
  */
  const liveMergeBoundaryTask = await store.getTask(taskId).catch(() => undefined);
  if (!liveMergeBoundaryTask) {
    throw new MergeGateRevokedError(`Cannot read current task ${taskId} before workspace ref advance`);
  }
  const mergeBoundaryTask = liveMergeBoundaryTask.workspaceWorktrees ? liveMergeBoundaryTask : task;
  /*
  FNXC:WorkspaceFinalization 2026-08-21-09:09:
  Direct CLI and UI-only callers reach this landing function without ProjectEngine's optional
  admission callback. Apply the canonical pre-merge blocker before boundary evidence, transient
  status, leases, or Git writes so a failed or pending Code Review cannot finalize an all-landed retry.
  */
  const reviewColumns = new Set<string>(["in-review"]);
  const workflowIr = await resolveWorkflowIrForTask(store, taskId).catch(() => undefined);
  if (workflowIr) for (const column of resolveReviewColumns(workflowIr)) reviewColumns.add(column);
  const completeColumns = new Set<string>(["done"]);
  if (workflowIr) for (const column of resolveTerminalColumns(workflowIr)) completeColumns.add(column);
  if (!completeColumns.has(mergeBoundaryTask.column)) {
    const mergeBlocker = getTaskMergeBlocker(mergeBoundaryTask, {
      manual: options.manual === true,
      reviewColumns,
      // Content-bound workspace approval is evaluated after the one fresh
      // boundary capture below; a result-only precheck would reject durable
      // repository evidence before it can be compared.
      requiredPreMergeStepIds: undefined,
    });
    if (mergeBlocker) throw new WorkspaceFinalizeBlockedError(taskId, mergeBlocker);
  }
  let mergeEvidence;
  try {
    mergeEvidence = await captureWorkspaceReviewEvidence({ task: mergeBoundaryTask, workspaceRootDir, settings });
  } catch (error) {
    throw new Error(`Cannot capture fresh merge evidence for workspace task ${taskId}: ${getErrorMessage(error)}`);
  }
  if (mergeEvidence.outOfScopeRepositories.size > 0) {
    throw new Error(`Workspace repositories modified outside confirmed scope for ${taskId}: ${[...mergeEvidence.outOfScopeRepositories].sort().join(", ")}`);
  }
  const mergeBoundaryModifiedRepositories = mergeEvidence.modifiedRepositories;
  const mergeBoundaryFingerprints = Object.fromEntries(mergeEvidence.repositories
    .filter((repository) => repository.fingerprint)
    .map((repository) => [repository.repository, repository.fingerprint!]));
  const netZeroBranchRepositories = new Set(mergeEvidence.repositories
    .filter((repository) => repository.netZero && mergeBoundaryTask.repositoryScope?.repositories.includes(repository.repository))
    .map((repository) => repository.repository));
  const normalizedMergeBoundaryFiles = mergeEvidence.modifiedFiles;
  const persistedReviewFiles = [...new Set(mergeBoundaryTask.modifiedFiles ?? [])].sort();
  /*
  FNXC:RepositoryScope 2026-08-21-00:58:
  Landing must not convert fresh evidence into approved evidence. A changed repository/file set after
  Code Review has no matching reviewer episode, so return it through the normal review path instead
  of silently persisting the new snapshot and landing it. Persist failure is likewise a hard fence:
  a later recovery must never infer an unrecorded merge boundary.
  */
  /*
  FNXC:WorkspacePreMergeApproval 2026-08-23-07:38:
  FN-180 keeps admission and landing on one positive per-repository predicate.
  This durable evidence survives result cleanup; direct legacy tasks stay open
  only when no diff-domain review gate and no evidence record exist.
  */
  const requiresRepositoryReviewEvidence = mergeBoundaryTask.repositoryScope?.reviewEvidence !== undefined
    || (mergeBoundaryTask.enabledWorkflowSteps ?? []).some((step) => /review/i.test(step));
  const workspaceApproval = evaluatePreMergeApprovals(mergeBoundaryTask, {
    requiredPreMergeStepIds: workflowIr && requiresRepositoryReviewEvidence
      ? resolveRequiredPreMergeStepIds(workflowIr, mergeBoundaryTask.enabledWorkflowSteps)
      : undefined,
    mergeContent: {
      kind: "workspace",
      repositories: {
        state: "captured",
        fingerprints: mergeBoundaryFingerprints,
        inScopeModified: [...mergeBoundaryModifiedRepositories].sort(),
      },
    },
  }).find((candidate) => candidate.state !== "approved");
  const approvedReviewEvidence = mergeBoundaryTask.repositoryScope?.reviewEvidence;
  /*
  FNXC:WorkspaceFinalization 2026-08-24-03:34:
  An existing evidence map or enabled review gate always fails closed at the repository boundary,
  including when the selected workflow resolves an explicit empty gate list. Compare repository
  evidence directly while the canonical evaluator additionally enforces enabled workflow verdicts.
  Legacy callers with neither signal retain the merge-agent review path.
  */
  const fallbackMissingRepositories = requiresRepositoryReviewEvidence
    ? [...mergeBoundaryModifiedRepositories].filter((repository) => !approvedReviewEvidence?.[repository]).sort()
    : [];
  const fallbackStaleRepositories = requiresRepositoryReviewEvidence
    ? Object.entries(mergeBoundaryFingerprints)
      .filter(([repository, fingerprint]) => approvedReviewEvidence?.[repository]?.fingerprint !== fingerprint)
      .map(([repository]) => repository)
      .filter((repository) => !fallbackMissingRepositories.includes(repository))
      .sort()
    : [];
  const approvalRepositories = [...new Set([
    ...(workspaceApproval?.repositories ?? []),
    ...fallbackMissingRepositories,
  ])].sort();
  const changedFiles = requiresRepositoryReviewEvidence
    ? normalizedMergeBoundaryFiles.filter((file) => !persistedReviewFiles.includes(file)).sort()
    : [];
  if (workspaceApproval?.state === "missing" || fallbackMissingRepositories.length > 0) {
    throw new WorkspaceReviewRequiredError(taskId, {
      kind: "approval-missing",
      repositories: approvalRepositories,
      files: normalizedMergeBoundaryFiles.filter((file) => approvalRepositories.some((repository) => file.startsWith(`${repository}/`))).sort(),
    });
  }
  if (workspaceApproval?.state === "stale-content" || fallbackStaleRepositories.length > 0 || changedFiles.length > 0) {
    const repositories = [...new Set([
      ...approvalRepositories,
      ...fallbackStaleRepositories,
      ...changedFiles.map((file) => file.split("/")[0]),
    ])].sort();
    throw new WorkspaceReviewRequiredError(taskId, {
      kind: "content-changed",
      repositories,
      files: [...new Set([...changedFiles, ...normalizedMergeBoundaryFiles.filter((file) => repositories.some((repository) => file.startsWith(`${repository}/`)))])].sort(),
    });
  }
  if (workspaceApproval && workspaceApproval.state !== "approved") {
    throw new WorkspaceFinalizeBlockedError(taskId, "task has no provable approval for the content being merged");
  }
  /*
  FNXC:WorkspaceFinalization 2026-08-21-08:46:
  Do not replace the reviewed file snapshot with an empty second-pass capture. An already-landed
  repository has no task-branch diff to capture, yet remains a required finalization obligation.
  The readiness resolver retains that evidence and refuses unexplained empty sets before status,
  dispatch fencing, leases, or Git writes.
  */
  const readiness = resolveWorkspaceMergeReadiness(
    mergeBoundaryTask,
    mergeBoundaryModifiedRepositories,
    netZeroBranchRepositories,
  );
  if (readiness.kind === "blocked") throw new Error(readiness.reason);
  if (readiness.kind === "no-op") {
    throw new Error(`Workspace task ${taskId} has explicit no-commits policy and cannot enter repository landing`);
  }
  const retainedModifiedFiles = [...new Set([...normalizedMergeBoundaryFiles, ...readiness.preservedFiles])].sort();
  await store.updateTask(taskId, { modifiedFiles: retainedModifiedFiles });
  task = { ...mergeBoundaryTask, modifiedFiles: retainedModifiedFiles };
  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  const repoKeys = readiness.repositories;
  /*
  FNXC:WorkspaceIntegration 2026-08-21-21:46:
  Plan every modified confirmed-scope repository before the first status, fence, intent, or ref
  write. The dispatch fence is published only to remote targets; local-only repositories retain
  durable leases and local CAS without running any remote Git command.
  */
  /*
  FNXC:MergePush 2026-08-30-09:14:
  FN-263 sends workspace publication through the same policy as single-repository merges. When it
  is off, every repository uses FN-122's local-only contract: a durable per-repository lease and
  local ref CAS. Target-kind guards already suppress dispatch/repository fence refs, land intents,
  and fenced pushes, so this one planning decision prevents all remote writes.
  */
  const workspaceTargets = new Map<string, { integrationBranch: string; target: WorkspaceIntegrationTarget }>();
  for (const repoRel of repoKeys) {
    const entry = workspaceWorktrees[repoRel];
    if (!entry) throw new WorkspaceMergeTechnicalError("workspace-entry", `Workspace repository entry is missing for ${repoRel}`);
    const repoRootDir = join(workspaceRootDir, repoRel);
    try {
      const baseResolution = await resolveWorkspaceRepoBaseBranch({
        mode: "recorded", repoRootDir, repoRelPath: repoRel, task, settings, recordedBaseBranch: entry.baseBranch,
      });
      await recordWorkspaceBaseBranchDecision({ store, audit, task, repoRelPath: repoRel, repoAbsPath: repoRootDir, resolution: baseResolution, stage: "land" });
      const target = await resolveWorkspaceIntegrationTarget({
        repository: repoRel,
        cwd: repoRootDir,
        integrationBranch: baseResolution.branch,
        worktreeRebaseRemote: settings.worktreeRebaseRemote,
        publishToRemote,
      });
      workspaceTargets.set(repoRel, { integrationBranch: baseResolution.branch, target });
    } catch (error) {
      if (error instanceof WorkspaceIntegrationTargetError) {
        const message = `Workspace repository ${error.repository} needs ${error.resource}: ${error.action}.`;
        await persistWorkspaceRepoLandFailure(store, taskId, repoRel, {
          category: "environment",
          message,
          at: new Date().toISOString(),
          branch: entry.branch,
          repository: error.repository,
          resource: error.resource,
          action: error.action,
          technicalDetail: error.message.slice(0, 2_000),
        }).catch(() => undefined);
        throw error;
      }
      throw new WorkspaceMergeTechnicalError("integration-target", `Cannot plan workspace integration for ${repoRel}: ${getErrorMessage(error)}`);
    }
  }
  if (!publishToRemote && repoKeys.length > 0) {
    await log('AI merge (workspace): "Push to remote after merge" is disabled — landing every repository on its local integration ref only; no remote refs are written.');
  }

  const repos: WorkspaceRepoLandResult[] = [];
  let allLanded = true;

  await setStatus("merging");
  /* FNXC:WorkspaceMergeAbort 2026-08-23-08:32: The status writer can synchronously abort this generation; never let a post-abort setup probe turn cancellation into a Git error. */
  throwIfAborted(options.signal, taskId);
  try {

  let workspaceDispatchFence: { fenceRefName: string; fenceRefSha: string } | undefined;
  const hasRemoteWorkspaceTarget = [...workspaceTargets.values()].some(({ target }) => target.kind === "remote");
  const recordDispatchFence = (store as Partial<TaskStore>).recordWorkspaceLeaseFenceRef;
  if (hasRemoteWorkspaceTarget && options.workspaceDispatchFence && typeof recordDispatchFence === "function") {
    /*
    FNXC:WorkspaceMergeDispatch 2026-08-15-10:18:
    A successor must publish its dispatch pin to EVERY workspace target remote before any land
    sequence begins. Publishing only when each repository reaches its loop leaves a later remote
    writable by a resumed predecessor; renewal callbacks are liveness-only, never correctness.
    */
    try {
      for (const repoRel of repoKeys) {
        const target = workspaceTargets.get(repoRel)?.target;
        if (!target || target.kind === "local") continue;
        const ensuredDispatchFence = await ensureTenancyFenceRef({
          store,
          handle: options.workspaceDispatchFence,
          claimOutcome: "reentrant",
          remote: target.remote,
          cwd: join(workspaceRootDir, repoRel),
          fenceRefName: mergeDispatchFenceRef(taskId),
        });
        options.workspaceDispatchFence = ensuredDispatchFence;
      }
      if (!options.workspaceDispatchFence.fenceRefName || !options.workspaceDispatchFence.fenceRefSha) {
        throw new WorkspaceFenceRefError(`Workspace merge dispatch lease ${options.workspaceDispatchFence.leaseKey} has no fence pin`, "transport");
      }
      workspaceDispatchFence = {
        fenceRefName: options.workspaceDispatchFence.fenceRefName,
        fenceRefSha: options.workspaceDispatchFence.fenceRefSha,
      };
    } catch (error) {
      if (error instanceof WorkspaceFenceRefError) {
        const failedTarget = [...workspaceTargets.entries()].find(([, value]) => value.target.kind === "remote");
        if (error.kind === "transport" && failedTarget?.[1].target.kind === "remote") {
          throw new WorkspaceEnvironmentError(
            failedTarget[0], `remote '${failedTarget[1].target.remote}'`,
            `restore access to remote '${failedTarget[1].target.remote}' and choose Retry`, error.message,
          );
        }
        throw new WorkspaceMergeTechnicalError("dispatch-fence-publication", `Workspace merge dispatch fence publication failed for ${taskId}: ${error.message}`);
      }
      throw error;
    }
  }

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
  for (const repoRel of repoKeys) {
    throwIfAborted(options.signal, taskId);
    const entry = workspaceWorktrees[repoRel];
    const repoRootDir = join(workspaceRootDir, repoRel);

    /*
    FNXC:Workspace 2026-08-20-00:56:
    Recorded acquisition state is the only workspace landing target. A worktree forked from
    release/x lands on release/x, while a legacy or acquisition-fallback entry remains on its
    own integration branch even if task.baseBranch has since changed.
    */
    const workspaceTarget = workspaceTargets.get(repoRel);
    if (!workspaceTarget) throw new WorkspaceMergeTechnicalError("integration-target", `Workspace integration plan is missing for ${repoRel}`);
    const integrationBranch = workspaceTarget.integrationBranch;

    // U2 landed predicate + skip (KTD3): a repo whose recorded `landedSha` is an
    // ancestor of (or equals) its CURRENT integration tip is already landed — SKIP
    // it so a retry never re-advances the ref. This makes a re-run after a partial
    // land idempotent for the already-landed repos.
    /*
    FNXC:Workspace 2026-08-15-07:05:
    Supply task creation time so a missing workspace branch cannot let a recycled historical
    trailer prove this repo landed and skip its current work.
    */
    const provenLandedSha = await findProvenLandedCommit(
      repoRootDir,
      integrationBranch,
      entry.landedSha,
      taskId,
      entry.branch,
      entry.revertBoundarySha,
      task.createdAt,
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
        dependencySyncDecision: "not-run-already-landed",
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

    /*
    FNXC:Workspace 2026-08-15-08:36:
    A process-local registry cannot serialize workspace landers on separate engine nodes. Claim the
    repository's durable lease before registering locally, pin its fence ref once, and retain the
    resulting handle through land-intent resolution. The remote push checks that same pin atomically
    with the integration ref, so a superseded tenant cannot advance shared history after its TTL.
    */
    let durableLandLease: WorkspaceLeaseHandle | undefined;
    try {
      const acquireWorkspaceLease = (store as Partial<TaskStore>).acquireWorkspaceLease;
      /*
      FNXC:Workspace 2026-08-15-08:47:
      The optional branch is solely for legacy structural in-memory stores used
      by single-process tests. A real TaskStore has this API, and any error from
      it remains a fail-closed land contention rather than a registry fallback.
      */
      if (typeof acquireWorkspaceLease === "function") {
        const claim = await acquireWorkspaceLease.call(store, {
          leaseKey: `repo:${repoRel}`,
          kind: "land",
          owner: { taskId, nodeId: resolveEngineNodeId(), incarnationId: resolveEngineIncarnationId() },
          leaseMs: 5 * 60_000,
        });
        if (claim.outcome === "conflict") {
          throw new WorkspaceRepoLandBusyError(repoRel, claim.conflict.taskId, taskId);
        }
        durableLandLease = claim.handle;
        if (workspaceTarget.target.kind === "remote") {
          durableLandLease = await ensureTenancyFenceRef({
            store,
            handle: durableLandLease,
            claimOutcome: claim.outcome,
            remote: workspaceTarget.target.remote,
            cwd: repoRootDir,
            fenceRefName: workspaceLandFenceRef(repoRel),
          });
        }
      }
    } catch (error) {
      if (durableLandLease) await store.releaseWorkspaceLease(durableLandLease).catch(() => undefined);
      if (error instanceof WorkspaceRepoLandBusyError) throw error;
      /*
      FNXC:WorkspaceIntegration 2026-08-21-22:20:
      A repository fence transport failure means the selected remote cannot be reached, not that
      its durable lease is defective. Preserve the environment classification here because this
      catch surrounds fence publication before the normal per-repository land body; ProjectEngine
      can then park it for Retry without consuming the technical retry budget.
      */
      if (error instanceof WorkspaceFenceRefError && error.kind === "transport" && workspaceTarget.target.kind === "remote") {
        const action = `restore access to remote '${workspaceTarget.target.remote}' and choose Retry`;
        const operatorMessage = `Workspace repository ${repoRel} needs remote '${workspaceTarget.target.remote}': ${action}.`;
        await persistWorkspaceRepoLandFailure(store, taskId, repoRel, {
          category: "environment", message: operatorMessage, at: new Date().toISOString(), branch: entry.branch,
          repository: repoRel, resource: `remote '${workspaceTarget.target.remote}'`, action,
          technicalDetail: error.message.slice(0, 2_000),
        }).catch(() => undefined);
        throw new WorkspaceEnvironmentError(repoRel, `remote '${workspaceTarget.target.remote}'`, action, error.message);
      }
      throw new WorkspaceMergeTechnicalError("durable-lease", `Workspace repository lease unavailable for ${repoRel}: ${getErrorMessage(error)}`);
    }
    try {
      activeSessionRegistry.registerPath(repoRootDir, {
        taskId,
        kind: "workspace-repo-land",
        ownerKey: WORKSPACE_REPO_LAND_OWNER_KEY,
      });
    } catch (error) {
      if (durableLandLease) await store.releaseWorkspaceLease(durableLandLease).catch(() => undefined);
      throw error;
    }

    /*
    FNXC:Workspace 2026-08-20-19:45:
    A repository land can legitimately outlive the five-minute durable TTL while dependency sync and
    AI review run. Renew its current owner/fence handle during the complete land body, but keep every
    intent and push fenced by the durable handle: a failed renewal aborts before the next commit point.
    */
    let leaseLost = false;
    const leaseAbort = new AbortController();
    let renewalInFlight: Promise<void> | undefined;
    const renewWorkspaceLease = (store as Partial<TaskStore>).renewWorkspaceLease;
    const renewLease = async (): Promise<void> => {
      if (!durableLandLease || typeof renewWorkspaceLease !== "function" || leaseLost) return;
      try {
        const renewed = await renewWorkspaceLease.call(store, durableLandLease, 5 * 60_000);
        if (!renewed) throw new Error("Workspace lease renewal was refused");
        durableLandLease = renewed;
      } catch {
        leaseLost = true;
        leaseAbort.abort("workspace-repo-land-lease-lost");
      }
    };
    const renewalTimer = durableLandLease && typeof renewWorkspaceLease === "function"
      ? setInterval(() => {
        if (!renewalInFlight) {
          renewalInFlight = renewLease().finally(() => { renewalInFlight = undefined; });
        }
      }, 60_000)
      : undefined;
    renewalTimer?.unref?.();
    const landSignal = options.signal ? AbortSignal.any([options.signal, leaseAbort.signal]) : leaseAbort.signal;
    const assertLeaseLive = () => {
      if (leaseLost || leaseAbort.signal.aborted) throw new WorkspaceMergeTechnicalError("durable-lease", `Workspace repository lease renewal was lost for ${repoRel}`);
    };

    try {
      const landResult = await landOneRepo(repoRootDir, entry.branch, integrationBranch, {
        taskId, settings, audit, log, setStatus, maxPasses,
        mergeAgent, reviewAgent, stashResolveAgent,
        includeTaskId, trailers, taskTitle, signal: landSignal,
        allowDirtyLocalCheckoutSync,
        // FNXC:Workspace 2026-06-24-23:50: one sub-repo's dependency-sync failure must not block
        // landing the others — degrade verification for that repo, still land the git squash.
        nonFatalDependencySync: true,
        // FNXC:MergeNoCommits 2026-07-17-12:00: no-commits tasks skip dependency sync in the clean room
        noCommitsExpected: task.noCommitsExpected === true,
        repoRel,
        repoKeys,
        ...(durableLandLease && workspaceTarget.target.kind === "remote" ? { workspaceLand: { getHandle: () => { assertLeaseLive(); return durableLandLease!; }, repoRelPath: repoRel, remote: workspaceTarget.target.remote, assertLive: assertLeaseLive } } : {}),
        ...(workspaceDispatchFence ? { workspaceDispatchFence } : {}),
        mergeContent: {
          kind: "workspace",
          repositories: {
            state: "captured",
            fingerprints: mergeBoundaryFingerprints,
            inScopeModified: [...mergeBoundaryModifiedRepositories].sort(),
          },
        },
        store,
      });
      assertLeaseLive();
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
          /*
          FNXC:Workspace 2026-08-23-22:15:
          Resolve the write-ahead land intent ONLY when one was written. `landOneRepo` records an
          intent solely for a REMOTE target (it needs the tenancy fence pin and the remote URL), so a
          local-only workspace land — the FN-122 contract: no remote, no fence, no intent — reached
          this resolver with nothing to resolve, got `missing`, and hard-failed a fully landed repo as
          a partial land after its integration ref had already advanced. Gate both sides on the same
          condition so the intent lifecycle cannot be half-applied.
          */
          if (durableLandLease && workspaceTarget.target.kind === "remote") {
            assertLeaseLive();
            const resolved = await store.resolveWorkspaceLandIntent({
              handle: durableLandLease,
              taskId,
              repoRelPath: repoRel,
              expectedIntentFenceToken: durableLandLease.fenceToken,
              resolution: "landed",
              resolvedSha: landResult.squashSha,
              persistLandedSha: () => persistRepoLandedSha(store, taskId, repoRel, landResult.squashSha),
            });
            if (resolved.outcome !== "resolved") {
              throw new Error(`Workspace land intent for ${repoRel} was not resolved (${resolved.outcome})`);
            }
          } else {
            await persistRepoLandedSha(store, taskId, repoRel, landResult.squashSha);
          }
        } catch (persistErr: unknown) {
          const pmsg = getErrorMessage(persistErr);
          await log(`AI merge (workspace): sub-repo ${repoRel} landed (${short(landResult.squashSha)}) but persisting landedSha FAILED: ${pmsg} — escalating to partial land so a retry can recover (ref already advanced; retry will skip via trailer ancestor-check)`);
          repos.push({
            repo: repoRel, repoRootDir, integrationBranch, branch: entry.branch,
            status: "landed", landedSha: landResult.squashSha, localSync: landResult.localSync,
            dependencySyncDecision: landResult.dependencySyncDecision,
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
          dependencySyncDecision: landResult.dependencySyncDecision,
        });
      } else {
        repos.push({
          repo: repoRel, repoRootDir, integrationBranch, branch: entry.branch, status: "empty",
          dependencySyncDecision: landResult.dependencySyncDecision,
        });
      }
    } catch (err: unknown) {
      /*
      FNXC:Workspace 2026-08-20-19:58:
      A lost repository tenancy is not a repository land failure: writing landFailure here would
      let a stale owner mutate workspace state after its durable lease was revoked.
      */
      if (leaseLost) throw new WorkspaceMergeTechnicalError("durable-lease", `Workspace repository lease renewal was lost for ${repoRel}`);
      if (isMergeAbortedError(err)) throw err;
      // A WorkspacePartialLandError from the persist-failure window above must PROPAGATE
      // (the engine parks/retries). The outer try/finally below resets status first (A3).
      if (err instanceof WorkspacePartialLandError) throw err;
      // A dispatch-fence publication failure is contention/transport at the resource boundary,
      // not a sub-repo merge failure. This body never reached its fenced push.
      if (err instanceof WorkspaceFenceRefError) {
        const target = workspaceTargets.get(repoRel)?.target;
        if (err.kind === "target-diverged" && target?.kind === "remote") {
          const resource = `remote '${target.remote}' branch '${integrationBranch}'`;
          const action = "reconcile the diverged remote branch and choose Retry";
          const operatorMessage = `Workspace repository ${repoRel} needs ${resource}: ${action}.`;
          await persistWorkspaceRepoLandFailure(store, taskId, repoRel, {
            category: "environment", message: operatorMessage, at: new Date().toISOString(), branch: entry.branch,
            repository: repoRel, resource, action, technicalDetail: err.message.slice(0, 2_000),
          }).catch(() => undefined);
          throw new WorkspaceEnvironmentError(repoRel, resource, action, err.message);
        }
        if (err.kind === "transport" && target?.kind === "remote") {
          const operatorMessage = `Workspace repository ${repoRel} needs remote '${target.remote}': restore access to remote '${target.remote}' and choose Retry.`;
          await persistWorkspaceRepoLandFailure(store, taskId, repoRel, {
            category: "environment", message: operatorMessage, at: new Date().toISOString(), branch: entry.branch,
            repository: repoRel, resource: `remote '${target.remote}'`,
            action: `restore access to remote '${target.remote}' and choose Retry`, technicalDetail: err.message.slice(0, 2_000),
          }).catch(() => undefined);
          throw new WorkspaceEnvironmentError(repoRel, `remote '${target.remote}'`, `restore access to remote '${target.remote}' and choose Retry`, err.message);
        }
        throw new WorkspaceMergeTechnicalError("repository-fence-publication", `Workspace repository fence publication failed for ${repoRel}: ${err.message}`);
      }
      const message = getErrorMessage(err);
      await log(`AI merge (workspace): sub-repo ${repoRel} land failed: ${message}`);
      await audit.git({ type: "merge:ai-no-branch", target: entry.branch, metadata: { taskId, kind: "workspace-repo-land-failed", repo: repoRel, error: message } }).catch(() => undefined);
      const operatorMessage = `Workspace repository ${repoRel} could not land. Retry after resolving the repository environment or conflict.`;
      await persistWorkspaceRepoLandFailure(store, taskId, repoRel, {
        category: /conflict/i.test(message) ? "content-conflict" : "internal-technical",
        message: operatorMessage,
        at: new Date().toISOString(),
        branch: entry.branch,
        repository: repoRel,
        action: "Retry after resolving the reported repository issue",
        technicalDetail: message.slice(0, 2_000),
      }).catch(() => undefined);
      repos.push({
        repo: repoRel, repoRootDir, integrationBranch, branch: entry.branch, status: "failed",
        dependencySyncDecision: "failed-before-decision", error: operatorMessage,
      });
      allLanded = false;
      // Stop on first failure and return a partial result. The already-landed repos'
      // `landedSha` is persisted, so the engine dispatch's auto-retry re-runs this
      // loop and the landed predicate above skips them (only the failed repo retries).
      break;
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      await renewalInFlight?.catch(() => undefined);
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
      if (durableLandLease) {
        await store.releaseWorkspaceLease(durableLandLease).catch((releaseError: unknown) => {
          aiMergeLog.warn(`${taskId}: durable workspace land lease release refused for ${repoRel}: ${getErrorMessage(releaseError)}`);
        });
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
    /*
     * FNXC:Lifecycle 2026-07-16-00:00 (FN-8141 workspace parity):
     * Mirror the single-repo empty-merge guard. `allLanded` here means "no sub-repo FAILED", but every
     * acquired sub-repo may have come back `empty` (zero landed). Already-landed sub-repos are proven up
     * front by findProvenLandedCommit and pushed as `status:"landed"`. When NO repo landed, distinguish
     * the two empty shapes exactly as the single-repo guard does: a genuinely-integrated / zero-ahead
     * sub-repo (branch tip ⊑ its integration tip) is a safe no-op; an AHEAD-but-net-zero sub-repo (tip
     * NOT an ancestor — the FN-8141 reverted/lost shape) is not. Block only when at least one empty
     * sub-repo shows the reverted shape (or its branch vanished with nothing landed): set task.error
     * (keeps recoverStrandedCompletedTodoTasks from re-promoting), emit the audit event, and move back
     * to todo instead of laundering it into `done`. noCommitsExpected tasks keep their existing path.
     */
    const landedCount = repos.filter((r) => r.status === "landed" && r.landedSha).length;
    let hasRevertedEmptyRepo = false;
    if (task.noCommitsExpected !== true && repos.length > 0 && landedCount === 0) {
      for (const r of repos) {
        const tip = await git(["rev-parse", "--verify", `refs/heads/${r.branch}`], r.repoRootDir).catch(() => "");
        // Branch gone with nothing landed → treat as lost. Ahead-but-empty (tip not an ancestor of the
        // integration branch) → reverted/lost shape. Zero-ahead / already-integrated → safe no-op.
        if (!tip || !(await gitOk(["merge-base", "--is-ancestor", tip, r.integrationBranch], r.repoRootDir))) {
          hasRevertedEmptyRepo = true;
          break;
        }
      }
    }
    if (hasRevertedEmptyRepo) {
      const reason =
        "branch had no net changes vs main — work may have been reverted or lost; operator review required";
      await fence.write("lifecycle", () => store.updateTask(taskId, { error: reason }));
      if (fence.isOrphaned()) return { taskId, repos, allLanded, finalized: false, finalizeBlockedReason: reason };
      const reboundColumn = await resolveFinalizeReboundColumn(store, taskId);
      await fence.write("log", () => store.logEntry(
        taskId,
        `Finalize blocked (empty-merge no-landed-proof guard, workspace): ${reason} — contained recovery target ${reboundColumn} with progress preserved`,
        JSON.stringify({ lane: "ai-empty-merge-workspace", repoCount: repos.length, landedCount, repos: repos.map((r) => r.repo) }, null, 2),
      ).catch(() => undefined));
      await audit.database({
        type: "task:empty-merge-finalize-blocked-no-landed-proof" as Parameters<typeof audit.database>[0]["type"],
        target: taskId,
        metadata: { reason, lane: "ai-empty-merge-workspace", repoCount: repos.length, landedCount, hadPriorNoOpProof: false },
      }).catch(() => undefined);
      await fence.write("lifecycle", () => reboundAiMergeTask(store, taskId));
      return { taskId, repos, allLanded, finalized: false, finalizeBlockedReason: reason };
    }
    /*
    FNXC:WorkspaceMergeDispatch 2026-08-15-09:37:
    Dispatch admission is not a licence to finalize. The sub-repo pushes may have completed while
    this tenancy's renewal callback was stalled, so hold the owner+fence transaction lock over the
    terminal merge-details write and move-to-done sequence. A reclaimed lease never invokes this
    callback: its already-pushed commits remain recoverable through landedSha/intent evidence, but
    this stale generation must not write the task outcome. Renewal only improves liveness.
    */
    const finalize = () => finalizeWorkspaceTask(store, taskId, task, repos, workspaceRootDir, fence);
    const withValidDispatchLease = (store as Partial<TaskStore>).withValidWorkspaceLease;
    if (options.workspaceDispatchFence && typeof withValidDispatchLease === "function") {
      try {
        const finalized = await (withValidDispatchLease.call(
          store,
          options.workspaceDispatchFence,
          async () => finalize(),
        ) as Promise<boolean>);
        return { taskId, repos, allLanded, finalized };
      } catch (error) {
        if (error instanceof Error && error.message === "Workspace lease is no longer valid") {
          await audit.database({
            type: "workspace-lease:merge-completed-unrecorded" as Parameters<typeof audit.database>[0]["type"],
            target: taskId,
            metadata: { taskId, outcome: "superseded-after-push", landedRepoCount: repos.filter((repo) => repo.status === "landed").length },
          }).catch(() => undefined);
          await log("AI merge (workspace): dispatch lease was superseded after landing; left pushed refs intact for durable recovery");
          throw new WorkspaceMergeDispatchSupersededError(taskId);
        }
        throw error;
      }
    }
    const finalized = await finalize();
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
 * Persist one sub-repo's `landedSha` through the store's advisory-locked per-key merge,
 * so a concurrent sibling-entry acquisition or landing cannot be clobbered.
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
 *
 * FNXC:Workspace 2026-08-15-07:51: requireExistingEntry preserves the vanished-entry no-op,
 * while mergeWorkspaceWorktreeEntry owns the cross-process atomic map merge. Do not substitute
 * updateTask with a reconstructed workspaceWorktrees map here.
 */
async function persistRepoLandedSha(
  store: TaskStore,
  taskId: string,
  repoRel: string,
  landedSha: string,
): Promise<void> {
  // FNXC:Workspace 2026-08-15-06:45: a new landing is strictly after its revert boundary,
  // so clear that invalidation marker while retaining the fresh landedSha as normal proof.
  const mergeWorkspaceEntry = (store as Partial<TaskStore>).mergeWorkspaceWorktreeEntry;
  if (typeof mergeWorkspaceEntry === "function") {
    await mergeWorkspaceEntry.call(
      store,
      taskId,
      repoRel,
      { landedSha, landFailure: undefined, revertBoundarySha: undefined },
      { requireExistingEntry: true },
    );
    return;
  }

  /*
  FNXC:Workspace 2026-08-15-09:08:
  Production stores use the advisory-locked per-repository merge above. Retain the
  read/merge/write fallback only for structural single-process test stores that
  intentionally predate that API; routing a real durable store through it would
  reintroduce sibling-map clobbering.
  */
  const task = await store.getTask(taskId);
  const current = task.workspaceWorktrees?.[repoRel];
  if (!current) return;
  await store.updateTask(taskId, {
    workspaceWorktrees: {
      ...task.workspaceWorktrees,
      [repoRel]: { ...current, landedSha, landFailure: undefined, revertBoundarySha: undefined },
    },
  });
}

/**
 * FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
 * Finalize-once: build an aggregate `MergeResult` from the per-repo lands and run the
 * task-global `finalizeTask` move-done path ONCE. The representative `commitSha` is the
 * first sorted landed repo's sha (so `mergeDetails.commitSha` is populated for the
 * `task:merged` consumer); the full per-repo map is carried in `mergeDetails.workspaceLandedShas`.
 * Returns true iff the task was moved to done.
 */
/*
FNXC:WorkspaceMergeLogs 2026-08-29-07:28:
The terminal workspace log is one durable write at the established finalization ordinal. Summarize
all repository outcomes, SHAs, and dependency decisions together so a task card has one unambiguous
landing recap rather than an unlabeled aggregate count.
*/
export function formatRepositoryMergeLog(repoRelPath: string, message: string): string {
  return `[${repoRelPath}] ${message}`;
}

export function formatWorkspaceLandingSummary(repos: WorkspaceRepoLandResult[]): string {
  const aggregate = repos.some((repo) => repo.status === "failed") ? "partial-failed" : "all-landed";
  const repositoryResults = repos
    .map((repo) => `${repo.repo} {status=${repo.status}; sha=${repo.landedSha ?? "none"}; dependency-sync=${repo.dependencySyncDecision ?? "not-recorded"}}`)
    .join("; ");
  return `AI merge (workspace): aggregate=${aggregate}; task → done; ${repositoryResults}`;
}

async function finalizeWorkspaceTask(
  store: TaskStore,
  taskId: string,
  task: Task,
  repos: WorkspaceRepoLandResult[],
  workspaceRootDir: string,
  fence?: MergeWriteFence,
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
  fence?.assertOwned("finalization");
  await store.updateTask(taskId, { mergeDetails });
  task.mergeDetails = mergeDetails;

  let worktreeRemoved = false;
  try {
    fence?.assertOwned("finalization");
    const cleanup = await cleanupLandedWorkspaceTaskWorktrees({
      store,
      task: fresh ?? task,
      workspaceRootDir,
      landedShas: workspaceLandedShas,
      source: "workspace-ai-merge-finalize",
      fence,
      log: async (message) => {
        if (fence) {
          await fence.write("log", () => store.logEntry(taskId, message, "AiMerge").catch(() => undefined));
        } else {
          await store.logEntry(taskId, message, "AiMerge").catch(() => undefined);
        }
      },
    });
    worktreeRemoved = cleanup.removed;
  } catch (error) {
    const message = `Workspace post-landing worktree cleanup failed non-fatally: ${error instanceof Error ? error.message : String(error)}`;
    if (fence) {
      await fence.write("log", () => store.logEntry(taskId, message, "AiMerge").catch(() => undefined));
    } else {
      await store.logEntry(taskId, message, "AiMerge").catch(() => undefined);
    }
  }

  /*
  FNXC:MergeExecutionExclusion 2026-08-30-15:06:
  Workspace finalization now uses the singular lane's proof-gated cleanup before moving done.
  A preserved or unexpectedly failed cleanup is recorded but never converts a proven landing into
  a merge failure, because the durable landed refs remain authoritative for later convergence.
  */
  const result: MergeResult = {
    task,
    branch: task.branch ?? "",
    merged: anyLanded,
    noOp: !anyLanded,
    ok: true,
    reason: anyLanded ? undefined : "no-net-changes",
    commitSha: representative,
    mergeConfirmed: anyLanded,
    worktreeRemoved,
    branchDeleted: false,
  };
  if (fence) {
    await fence.write("log", () => store.logEntry(taskId, formatWorkspaceLandingSummary(repos), "AiMerge").catch(() => undefined));
  } else {
    await store.logEntry(taskId, formatWorkspaceLandingSummary(repos), "AiMerge").catch(() => undefined);
  }
  fence?.assertOwned("finalization");
  await finalizeTask(store, taskId, result, undefined, undefined, undefined, fence);
  return true;
}

async function mergeAndReview(input: {
  mergeRoot: string; branch: string; integrationBranch: string; tipSha: string; taskTitle?: string;
  includeTaskId: boolean; trailers: string[]; taskId: string; maxPasses: number;
  mergeAgent: (cwd: string, prompt: string) => Promise<void>; reviewAgent: (cwd: string, prompt: string) => Promise<string>;
  audit: RunAuditor; log: (message: string) => Promise<void>; setStatus: (status: string | null) => Promise<unknown>; store: TaskStore;
  signal?: AbortSignal; initialPriorReasons?: string[];
}): Promise<{ squashSha: string | null; priorReasons: string[] }> {
  const { mergeRoot, branch, integrationBranch, tipSha, taskTitle, includeTaskId, trailers, taskId, maxPasses, mergeAgent, reviewAgent, audit, log, setStatus, store, signal } = input;
  const current = await store.getTask(taskId);
  const sourceSha = await git(["rev-parse", "--verify", branch], mergeRoot);
  let state: NonNullable<Task["aiMergeReviewReconciliation"]> | undefined = current?.aiMergeReviewReconciliation;
  if (!state || state.sourceSha !== sourceSha || state.integrationTipSha !== tipSha) {
    const legacy = boundBlockingReviewReasons(input.initialPriorReasons ?? []);
    state = { sourceSha, integrationTipSha: tipSha, findings: legacy.map((text, index) => ({ id: `legacy-${index + 1}`, text, disposition: "pending" as const })), consecutiveCleanApprovals: 0, correctivePasses: 0 };
  }
  let needsMerge = !state.candidateSha;
  let persistedState = current?.aiMergeReviewReconciliation;
  const sameState = (left: Task["aiMergeReviewReconciliation"], right: Task["aiMergeReviewReconciliation"]): boolean => JSON.stringify(left) === JSON.stringify(right);
  const persistState = async (expected: Task["aiMergeReviewReconciliation"], next: NonNullable<Task["aiMergeReviewReconciliation"]>): Promise<void> => {
    await store.updateTaskAtomic(taskId, (live) => {
      if (!sameState(live.aiMergeReviewReconciliation, expected)) throw new AiMergeReviewReconciliationInvalidatedError();
      return { aiMergeReviewReconciliation: next };
    });
    persistedState = next;
  };
  const assertCurrentEpisodeIdentity = async (): Promise<void> => {
    const expectedState = state;
    if (!expectedState) throw new AiMergeReviewReconciliationInvalidatedError();
    const liveTask = await store.getTask(taskId);
    const liveBranch = liveTask?.branch ?? branch;
    const liveSourceSha = await git(["rev-parse", "--verify", liveBranch], mergeRoot);
    const liveTipSha = await git(["rev-parse", "--verify", `refs/heads/${integrationBranch}`], mergeRoot);
    if (
      liveBranch !== branch
      || liveSourceSha !== expectedState.sourceSha
      || liveTipSha !== expectedState.integrationTipSha
      || !sameState(liveTask?.aiMergeReviewReconciliation, expectedState)
    ) {
      await store.updateTaskAtomic(taskId, (currentTask) => {
        if (!sameState(currentTask.aiMergeReviewReconciliation, expectedState)) return undefined;
        return { aiMergeReviewReconciliation: null, mergeRetries: undefined };
      });
      throw new AiMergeReviewReconciliationInvalidatedError();
    }
  };
  while (true) {
    throwIfAborted(signal, taskId);
    const actionable = state.findings.filter((finding) => finding.disposition === "still-present");
    if (needsMerge) {
      if (state.correctivePasses > 0 && actionable.length === 0) {
        throw new AiMergeBlockedError(taskId, ["review reconciliation has no actionable finding"]);
      }
      await git(["reset", "--hard", tipSha], mergeRoot); await git(["clean", "-fd"], mergeRoot);
      if (state.correctivePasses > 0) {
        await setStatus("merging");
        await log(`AI merge: corrective re-merge (pass ${state.correctivePasses}/${maxPasses}) addressing findings: ${actionable.map((finding) => finding.text).join("; ")}`);
      }
      const task = await store.getTask(taskId);
      await mergeAgent(mergeRoot, buildMergePrompt({ taskId, branch, integrationBranch, tipSha, taskTitle, includeTaskId, trailers, correctiveReasons: actionable.map((finding) => `[${finding.id}] ${finding.text}`), userComments: selectUserCommentsForAgentContext(task) }));
      let candidateSha = await git(["rev-parse", "HEAD"], mergeRoot);
      if (candidateSha === tipSha && state.findings.length === 0) return { squashSha: null, priorReasons: [] };
      if (candidateSha !== tipSha) { await ensureCommitTaskMetadata(mergeRoot, taskId, includeTaskId, trailers); candidateSha = await git(["rev-parse", "HEAD"], mergeRoot); }
      state = { ...state, candidateSha, candidateTreeSha: await git(["rev-parse", `${candidateSha}^{tree}`], mergeRoot), consecutiveCleanApprovals: 0 };
      await persistState(persistedState, state);
      needsMerge = false;
    }
    const candidateSha: string = state.candidateSha!;
    await assertCurrentEpisodeIdentity();
    await setStatus("reviewing");
    const diffStat = await git(["diff", "--stat", `${tipSha}..${candidateSha}`], mergeRoot);
    const task = await store.getTask(taskId);
    const activePriorFindings = state.findings.filter((finding) => finding.disposition === "pending" || finding.disposition === "still-present");
    const verdict = parseReviewVerdict(await reviewAgent(mergeRoot, buildReviewPrompt({ taskId, branch, integrationBranch, tipSha, squashSha: candidateSha, diffStat, priorReasons: activePriorFindings.map((finding) => finding.text), priorFindings: activePriorFindings.map((finding) => ({ id: finding.id, text: finding.text })), userComments: selectUserCommentsForAgentContext(task) })));
    // A review response can arrive after an operator dismisses its finding or pushes a new source.
    await assertCurrentEpisodeIdentity();
    const ids = new Set(state.findings.map((finding) => finding.id));
    const dispositionCounts = new Map<string, number>();
    for (const { id } of verdict.priorFindingDispositions ?? []) {
      dispositionCounts.set(id, (dispositionCounts.get(id) ?? 0) + 1);
    }
    const invalidAcknowledgement = [...dispositionCounts].some(([id, count]) => !ids.has(id) || count > 1);
    /* FNXC:MergerAiReview 2026-08-22-22:26: Unknown and duplicate acknowledgements are unusable; a contradictory duplicate must never clear a real blocker. */
    const dispositions = new Map((verdict.priorFindingDispositions ?? [])
      .filter((entry) => ids.has(entry.id) && dispositionCounts.get(entry.id) === 1)
      .map((entry) => [entry.id, entry.disposition]));
    let findings: NonNullable<Task["aiMergeReviewReconciliation"]>["findings"] = state.findings.map((finding) => {
      const disposition = dispositions.get(finding.id);
      return disposition === "corrected" || disposition === "absent-from-squash" ? { ...finding, disposition } : disposition === "still-present" ? { ...finding, disposition } : finding;
    });
    /*
    FNXC:MergerAiReview 2026-08-22-22:04:
    FN-159 filters protocol at durable finding construction as defence in depth: R1 recognizes
    today's markers, while this independent boundary prevents a future marker from polluting the
    reconciliation corpus as FN-090 did after FN-062.
    */
    const recoveredReasons = boundBlockingReviewReasons(verdict.reasons);
    const newFindings = verdict.verdict === "reject" && verdict.severity !== "advisory"
      ? (recoveredReasons.length ? recoveredReasons : ["reviewer rejected the merge without a stated reason"])
        .map((text, index) => ({ id: `finding-${state!.correctivePasses + 1}-${index + 1}`, text, disposition: "still-present" as const }))
      : [];
    if (verdict.verdict === "approve") {
      /* FNXC:MergerAiReview 2026-08-22-22:26: A malformed duplicate that says still-present still retains the real blocker. */
      const reConfirmed = new Set((verdict.priorFindingDispositions ?? [])
        .filter((entry) => ids.has(entry.id) && entry.disposition === "still-present")
        .map((entry) => entry.id));
      const released = findings.filter((finding) => finding.disposition === "still-present" && !reConfirmed.has(finding.id));
      if (released.length) {
        const at = new Date().toISOString();
        findings = findings.map((finding) => released.some(({ id }) => id === finding.id)
          ? { ...finding, disposition: "absent-from-squash", audit: [...(finding.audit ?? []), { at, actor: "ai-merge-review", disposition: "absent-from-squash", reason: `not re-confirmed on approved candidate ${candidateSha}` }] }
          : finding);
        await log(`AI merge review: approved; released unreconfirmed finding(s): ${released.map(({ id }) => id).join(", ")}`);
      }
    }
    state = { ...state, findings: [...findings, ...newFindings] };
    const stillPresent: NonNullable<Task["aiMergeReviewReconciliation"]>["findings"] = state.findings.filter((finding) => finding.disposition === "still-present");
    const repeatedInvalidAcknowledgement: boolean = invalidAcknowledgement && state.invalidAcknowledgementCandidateSha === candidateSha;
    const unusableAcknowledgement: boolean = invalidAcknowledgement && !repeatedInvalidAcknowledgement;
    const clean: boolean = verdict.verdict === "approve" && !unusableAcknowledgement && stillPresent.length === 0;
    await audit.git({ type: "merge:ai-review-verdict", target: integrationBranch, metadata: { taskId, verdict: verdict.verdict, severity: verdict.severity, squashSha: candidateSha } });
    if (verdict.verdict === "approve") {
      const unconfirmed = state.findings.filter((finding) => finding.disposition === "pending").length;
      state = {
        ...state,
        consecutiveCleanApprovals: clean ? state.consecutiveCleanApprovals + 1 : 0,
        ...(unusableAcknowledgement ? { invalidAcknowledgementCandidateSha: candidateSha } : {}),
      };
      await persistState(persistedState, state);
      if (clean) {
        /*
        FNXC:MergeReviewConfirmation 2026-08-26-10:11:
        Landing requires TWO consecutive clean approvals of the same candidate (see the
        `consecutiveCleanApprovals >= 2` gate below), so this line is written twice per squash — by
        design, and previously WORD FOR WORD. An operator reading the task journal saw the same
        sentence repeated with the same SHA and had no way to tell a confirmation from a duplicated
        invocation; it was reported as an anomaly precisely because the log made a safety feature
        look like a bug. Number the approval so the second one reads as what it is.
        */
        const approvalNumber = state.consecutiveCleanApprovals;
        /*
        The SHA sits immediately after `approved`, and the pass number inside `(pass N)`, because
        `SelfHealingManager.getApprovedAiMergeReviewShas` PARSES this line with
        `/AI merge review \(pass \d+\): approved(?:\s+(?:squash|commit)\s+([0-9a-f]{7,40}))?/`.
        That parser has never matched anything: no emitter ever wrote the parenthetical, so
        `hasApprovedAiMergeReview` always answered false and the recovery it guards could not run.
        Two sides, each individually reasonable, coupled through a log line nobody compared — the
        same shape as every other defect in this series. Keep the suffixes AFTER the SHA so the
        capture group cannot be pushed out of reach by an optional clause.
        */
        const suffixes = [
          unconfirmed ? `${unconfirmed} prior finding(s) unconfirmed` : "",
          approvalNumber >= 2 ? "confirmation pass" : "",
        ].filter(Boolean);
        await log(repeatedInvalidAcknowledgement
          ? "AI merge review: approved; ignoring repeated unusable prior-finding acknowledgement"
          : `AI merge review (pass ${approvalNumber}): approved squash ${candidateSha}${suffixes.length ? ` — ${suffixes.join("; ")}` : ""}`);
        if (state.consecutiveCleanApprovals >= 2) {
          await assertCurrentEpisodeIdentity();
          return { squashSha: candidateSha === tipSha ? null : candidateSha, priorReasons: [] };
        }
        continue; // Direct confirmation review of exactly the same candidate; no merge agent and no budget spend.
      }
      if (unusableAcknowledgement && stillPresent.length === 0) {
        await log("AI merge review: approved; prior-finding acknowledgement unusable (unknown or duplicated id) — re-asking on the same candidate");
        continue;
      }
      if (repeatedInvalidAcknowledgement && stillPresent.length === 0) {
        await log("AI merge review: approved; ignoring repeated unusable prior-finding acknowledgement");
        continue;
      }
      if (stillPresent.length) await log(`AI merge review: approved but ${stillPresent.length} finding(s) re-confirmed still-present — corrective pass`);
    }
    if (verdict.verdict === "reject" && verdict.severity === "advisory" && stillPresent.length === 0) {
      await log(`AI merge: landing with unresolved advisory concern(s): ${verdict.reasons.join("; ")}`);
      return { squashSha: candidateSha === tipSha ? null : candidateSha, priorReasons: [] };
    }
    if (stillPresent.length === 0) {
      state = { ...state, terminal: true }; await persistState(persistedState, state);
      throw new AiMergeBlockedError(taskId, ["reviewer rejected the merge without a stated reason"]);
    }
    if (state.correctivePasses >= maxPasses) {
      state = { ...state, terminal: true }; await persistState(persistedState, state);
      await log(`AI merge BLOCKED after ${state.correctivePasses} corrective pass(es) — candidate ${candidateSha}: ${stillPresent.map((finding) => finding.text).join("; ")}`);
      throw new AiMergeBlockedError(taskId, stillPresent.map((finding) => finding.text));
    }
    state = { ...state, correctivePasses: state.correctivePasses + 1, consecutiveCleanApprovals: 0 };
    await persistState(persistedState, state);
    needsMerge = true;
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
  fence?: MergeWriteFence;
}): Promise<{ pushed: boolean; remote?: string; targetBranch?: string; refAdvanced?: boolean; rebasedSha?: string; error?: string }> {
  const { store, projectRootDir, taskId, settings, integrationBranch, audit, log, signal } = input;
  // FNXC:MergeReliability 2026-08-11-22:17: Post-push recovery diagnostics can outlive
  // cancellation, so direct callers construct the same per-generation write fence.
  const fence = input.fence ?? createMergeWriteFence({ taskId, signal });

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
    // FNXC:MergePush 2026-08-16-02:55: Retry transient fast-path transport failures with
    // bounded, cancellation-aware backoff; merge aborts must escape to the aborted-push audit path.
    await pushWithTransientRetries(
      () => git(["push", remote, `${localRef}:refs/heads/${targetBranch}`], projectRootDir, { timeout: 120_000 }),
      {
        taskId,
        signal,
        onRetry: async ({ attempt, maxRetries, delayMs, error }) => {
          const message = `Push after merge: temporary Git transport failure; retrying in ${delayMs}ms (${attempt}/${maxRetries}): ${error}`;
          aiMergeLog.warn(`${taskId}: ${message}`);
          await log(message);
        },
      },
    );
    return { pushed: true, remote, targetBranch };
  } catch (err: unknown) {
    if (isMergeAbortedError(err)) throw err;
    fastPathError = getErrorMessage(err);
  }
  if (!isNonFastForwardPushError(fastPathError)) {
    return { pushed: false, remote, targetBranch, error: fastPathError };
  }

  /*
  FNXC:MergePush 2026-07-22-18:42:
  Tchori-Labs/Fusion#5 requires approved content to reach durable remote storage before the divergence clean room starts. Force-updating a task-scoped recovery ref makes retries idempotent and preserves the pre-rebase squash across aborts or process death without changing the non-fatal post-finalization push contract.
  */
  const recoveryBranch = `fusion/${taskId.toLowerCase()}-stranded`;
  const recoveryRef = `refs/heads/${recoveryBranch}`;
  // Both the create and delete recovery-ref paths record the same
  // {audit event + task-log entry} pair, differing only in outcome/message/
  // action — keep them in one place so the paths can't drift apart.
  const recordRecoveryBranch = async (
    outcome: "success" | "failed" | "deleted" | "delete-failed",
    logMessage: string,
    logAction: "PushRecoveryBranch" | "PushRecoveryBranchFailed",
  ): Promise<void> => {
    await audit.git({
      type: "push:recovery-branch",
      target: taskId,
      metadata: { taskId, remote, recoveryBranch, sha: localSha, outcome },
    }).catch(() => undefined);
    await fence.write("log", () => store.logEntry(taskId, logMessage, logAction).catch(() => undefined));
  };
  try {
    await git(["push", "--force", remote, `${localSha}:${recoveryRef}`], projectRootDir, { timeout: 120_000 });
    await recordRecoveryBranch(
      "success",
      `Push after merge: preserved the approved pre-rebase squash on ${remote}/${recoveryBranch} at ${localSha}`,
      "PushRecoveryBranch",
    );
  } catch (recoveryError: unknown) {
    const message = getErrorMessage(recoveryError);
    await recordRecoveryBranch(
      "failed",
      `Push after merge: could not preserve the approved squash on recovery branch ${remote}/${recoveryBranch}; continuing the non-fatal divergence rebase: ${message}`,
      "PushRecoveryBranchFailed",
    );
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

    // The approved content is now on the target branch, so clean up the
    // temporary recovery ref. Deletion remains best-effort: a cleanup problem
    // must not turn a successful target push into a failed merge outcome.
    // The create push above uses --force, so a restarted/concurrent attempt
    // for this taskId can force-update the ref to a newer value; lease the
    // delete to this attempt's localSha so an ownership change fails
    // harmlessly here instead of destroying a newer safety copy.
    try {
      await git(
        ["push", `--force-with-lease=${recoveryRef}:${localSha}`, remote, `:${recoveryRef}`],
        canonicalPushRoot,
        { timeout: 120_000 },
      );
      await recordRecoveryBranch(
        "deleted",
        `Push after merge: deleted recovery branch ${remote}/${recoveryBranch} after the target push succeeded`,
        "PushRecoveryBranch",
      );
    } catch (recoveryDeleteError: unknown) {
      await recordRecoveryBranch(
        "delete-failed",
        `Push after merge: target push succeeded but recovery branch ${remote}/${recoveryBranch} could not be deleted: ${getErrorMessage(recoveryDeleteError)}`,
        "PushRecoveryBranchFailed",
      );
    }

    // The clean-room HEAD is what the remote now has. Advance the local
    // integration ref to match (CAS against the pre-push tip; a concurrent
    // local advance loses the race and the NEXT merge's push reconciles).
    const rebasedSha = await git(["rev-parse", "HEAD"], canonicalPushRoot).catch(() => "");
    if (!rebasedSha || rebasedSha === localSha) {
      return { pushed: true, remote, targetBranch };
    }
    assertMergeGenerationOwned(signal, taskId);
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
    /*
    FNXC:MergePush 2026-07-22-18:48:
    The divergence clean room must never survive an unexpected exit with staged, uncommitted rebase state. This outer guard complements the resolver helper's catch so cleanup is safe even when a future throw bypasses that helper.
    */
    if (pushRoot && worktreeAdded && (await isRebaseInProgress(pushRoot))) {
      try {
        await git(["rebase", "--abort"], pushRoot, { timeout: 120_000 });
        await log("Push after merge: aborted the unfinished clean-room rebase before cleanup");
      } catch (abortError: unknown) {
        aiMergeLog.warn(`${taskId}: failed to abort unfinished push rebase before cleanup: ${getErrorMessage(abortError)}`);
      }
    }
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
  opts: { empty: boolean; expectedBranchTipSha?: string },
  mergeTarget?: MergeTargetResolution,
  groupRouting?: BranchGroupMergeRouting | null,
  syncGroupPr?: SyncGroupPrFn,
  fence?: MergeWriteFence,
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
    const [{ landedFiles: capturedLandedFiles, filesChanged, insertions, deletions }, mergeCommitMessage, landedBranchTipSha] = await Promise.all([
      captureSingleCommitLandedMetadata(projectRootDir, landedSha),
      git(["log", "-1", "--format=%s", landedSha], projectRootDir).catch(() => ""),
      opts.expectedBranchTipSha
        ? Promise.resolve(opts.expectedBranchTipSha)
        : git(["rev-parse", "--verify", `refs/heads/${branch}`], projectRootDir).catch(() => ""),
    ]);
    const landedFiles = capturedLandedFiles ?? [];
    const mergedAt = task.mergeDetails?.mergedAt ?? new Date().toISOString();
    mergeDetails = {
      commitSha: landedSha,
      ...(landedBranchTipSha ? { landedBranchTipSha } : {}),
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
    fence?.assertOwned("finalization");
    await store.updateTask(taskId, { mergeDetails, modifiedFiles });
    task.mergeDetails = mergeDetails;
    task.modifiedFiles = modifiedFiles;
    if (task.lineageId && typeof (store as Partial<TaskStore>).upsertTaskCommitAssociation === "function") {
      fence?.assertOwned("finalization");
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
    fence?.assertOwned("finalization");
    await store.updateTask(taskId, { mergeDetails });
    task.mergeDetails = mergeDetails;
  }
  let branchDeleted = false;
  const deleteBranchNormally = async (): Promise<void> => {
    /*
    FNXC:WorktreeCleanup 2026-08-29-00:59:
    FN-251 fixes deletion ordering for Fusion-managed task branches only. An operator-supplied branch
    remains operator-owned even after its now-safe worktree cleanup, while the integration branch is
    never a deletion target.
    */
    fence?.assertOwned("finalization");
    if (branch !== integrationBranch && isFusionDeletableBranch(task, branch) && await gitOk(["branch", "-D", branch], projectRootDir)) {
      branchDeleted = true;
      await audit.git({ type: "branch:delete", target: branch, metadata: { taskId, force: true } }).catch(() => undefined);
    }
  };
  /*
  FNXC:MergeExecutionExclusion 2026-08-29-00:59:
  FN-251 requires a proven landing to attempt non-fatal worktree cleanup before branch deletion.
  Re-reporting a durable landing as a merge failure caused duplicate merge attempts and graph-backstop
  completion; a preserved checkout therefore records its reason and never stops finalization. Git
  cannot delete a branch checked out by a worktree, so cleanup must resolve before the branch delete.
  */
  const cleanup = await cleanupLandedTaskWorktree({
    store,
    taskId,
    worktreePath: task.worktree,
    rootDir: projectRootDir,
    landedSha,
    source: "ai-merge-finalize",
    audit,
    log,
    fence,
  });
  const worktreeRemoved = cleanup.removed;

  if (!opts.expectedBranchTipSha) await deleteBranchNormally();

  if (opts.expectedBranchTipSha && branch !== integrationBranch && isFusionDeletableBranch(task, branch)) {
    fence?.assertOwned("finalization");
    const deletedAtExpectedTip = await gitOk([
      "update-ref",
      "-d",
      `refs/heads/${branch}`,
      opts.expectedBranchTipSha,
    ], projectRootDir);
    if (!deletedAtExpectedTip) {
      throw new RecordedMergeBranchTipChangedError(branch, opts.expectedBranchTipSha);
    }
    branchDeleted = true;
    await audit.git({
      type: "branch:delete",
      target: branch,
      metadata: { taskId, force: true, source: "recorded-landing-tip-cas" },
    }).catch(() => undefined);
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

  /*
  FNXC:MergeReliability 2026-08-11-21:39:
  Group bookkeeping is a finalization writer, so it must finish before the done-column move and
  `task:merged` announcement. An abort here rejects before external consumers see an announced
  merge whose managed-group state is still incomplete; each adjacent writer keeps its own fence.
  */
  if (groupRouting) {
    try {
      fence?.assertOwned("finalization");
      await Promise.resolve((store as { recordBranchGroupMemberLanded?: TaskStore["recordBranchGroupMemberLanded"] }).recordBranchGroupMemberLanded?.(groupRouting.branchGroup.id, {
        worktreePath: task.worktree ?? null,
        status: "open",
      }));
    } catch (err) {
      if (isMergeAbortedError(err)) throw err;
      // best-effort persistence
    }
    if (syncGroupPr) {
      try {
        fence?.assertOwned("finalization");
        await syncGroupPrOnLanding({
          store,
          groupId: groupRouting.branchGroup.id,
          cwd: projectRootDir,
          syncGroupPr,
        });
      } catch (err) {
        try {
          recordBranchGroupPrSyncFailureAudit(store, taskId, groupRouting.branchGroup.id, err);
        } catch (auditError) {
          if (isMergeAbortedError(auditError)) throw auditError;
          // best-effort audit
        }
      }
    }
  }

  fence?.assertOwned("finalization");
  const finalized = await finalizeTask(store, taskId, result, audit, log, projectRootDir, fence);
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
  rootDir?: string,
  fence?: MergeWriteFence,
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
    fence,
  });
  if (finalization.outcome === "blocked") {
    throw new Error(`AI merge finalization blocked for ${taskId}: ${finalization.reason ?? "unknown"}`);
  }
  if (!finalization.task) {
    throw new Error(`AI merge finalization could not find task ${taskId}`);
  }
  result.task = finalization.task;
  fence?.assertOwned("finalization");
  store.emit("task:merged", result);
  return result;
}

function throwIfAborted(signal: AbortSignal | undefined, taskId: string): void {
  assertMergeGenerationOwned(signal, taskId);
}
